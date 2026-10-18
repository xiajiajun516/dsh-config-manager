/**
 * 「英文界面零中文」静态守卫 —— 扫描内核（零依赖）。
 *
 * 冻结来源：docs/design/2026-10-08-i18n-en-hardcoding.md §3（口径）+ 附录 A（参考实现）。
 * 本文件是附录 A 的等价 TS 移植：**不允许语义偏离**（注释剥离 / 命中单位 / E1–E3 豁免 /
 * 白名单 / 作用域过滤都逐条对齐），落地后按 §3.8 做过逐文件基线比对。
 *
 * 口径要点（改本文件前先读 §3）：
 *  - 扫描集：src/**\/*.{ts,tsx,json} − src/cli/** − **\/*.test.ts(x) − src/**\/fixtures/**
 *             + locale/en.json + locale/zh.json（后者整文件豁免）
 *  - 词法：逐字符状态机分类 code / comment / string；命中单位 = （文件, 行, 该行的字面量序号）
 *  - 豁免：E1 注释、E2 log.* 与 console.* 的实参区间、E3 目录 zh 区（uiZh|zh|syncZh|marketZh|
 *          recoveryZh|historyZh|gistZh|s3Zh 的对象字面量区间）
 *  - 作用域：DCM_I18N_GUARD_SCOPE（逗号分隔的 workspace 相对 POSIX 前缀，目录段边界匹配）
 *
 * t16 加固（守卫产物加固，不改任何 src/** 源码；全量 hits=0 / allowlisted=128 → 2026-10-08 起 132）：
 *  - E3 归属门禁：zh 对象字面量的豁免**不再只按标识符名**——必须可归属到「已注册目录 / 已知字典文件」，
 *    否则该对象里的中文照常计入命中。归属判据见 `isCatalogOwnerFile`：
 *      · 文件自身调用 `registerMessageCatalog(` / `registerBaseMessageCatalog(` / `makeCatalogMsg(`；或
 *      · 文件在显式清单 `KNOWN_CATALOG_FILES` 里（经 ctx.locale.register 的客户端字典、migrations 目录等）。
 *    `scanText` 的 `catalogOwner` 缺省 **false**（fail-closed：未声明归属的样本不享 E3 豁免）；
 *    `scanFile`/`scanAll` 会按文件自动判定归属。新增一本字典必须显式登记（不可静默拓宽）。
 *  - fail-closed：词法区间（字符串 / 块注释 / 模板 / 正则）与 E2/E3 的括号/大括号配对**未闭合**时，
 *    不再静默豁免其后整段，而是 (a) 不施加该豁免、(b) 产出 `ScanAnomaly` 由守卫判「不可判定（扫描区间未闭合）」。
 *
 * t18 收口（t17-F1；F2/F3 防回归）：
 *  - 旁路成因：t16 的 `isCatalogOwnerFile` 直接在**原始文本**上跑 `CATALOG_OWNER_CALL_RE`，于是注释 / 字符串里
 *    出现 `registerMessageCatalog(` 字样也被当成「文件自身调用」⇒ E3 生效、`const zh = {…中文…}` 整段豁免
 *    （t17 的 ★ 反例实测 exit 0）。现树影响面实测 0（comment-only owner 0 个），属潜在旁路而非当前漏。
 *  - 修复方式：先用原始文本快速预筛，命中后用 `codeOnlyText(src)`（复用 `classifyWithAnomalies` 的字符类别，
 *    把 comment / string / tpl / re 位置掩成**空格**）跑同一正则 ⇒ **只有 code 位置的调用才授予归属**。
 *    掩成空格而非删除，避免把被注释隔开的片段拼成新假匹配。回归护栏 = 守卫自检 **S12**。
 *  - 整文件粒度约束：`KNOWN_CATALOG_FILES` 是**整文件豁免**（一条即放过该文件里全部 zh 对象），
 *    新增条目**必须走 captain 审批**（与白名单同级别的显式动作），不得因「新字典方便」自行追加。
 *
 * F4 口径留白（t9 评审记录，t16 只写进注释、不改判定）：
 *  - LOG_CALLEE 末尾判定边界：`LOG_CALLEE_RE` 要求 callee 以 `(` 紧邻结束，故 `log.info ('中文')`
 *    （括号前有空格）**不**享 E2 豁免（实测 1 命中）。方向安全（宁可误红不可漏红）；若要放行需单独决策
 *    并在 `LOG_CALLEE_RE` 末尾加 `\s*`，同时补对应用例。
 *  - A2 的作用域语义：`EN_CATALOG_FILES` 的零 CJK 断言只在**生效作用域**内的目录文件上跑
 *    （见 tests/i18n-hardcoded-guard.test.ts 的 A2）；作用域收窄到不含任何目录文件时 A2 空跑 ——
 *    **全量运行才是 A2 的门禁**（无 scope 的 `node --test tests/i18n-hardcoded-guard.test.ts`）。
 *  - `.css` 不在扫描集（既有事实）：扫描集只有 `src/**\/*.{ts,tsx,json}` + locale/*.json。
 *    实测 `src/client/config-manager.module.css` 的 14917 个 CJK **全部在注释内**（剥离注释后 0 命中），
 *    故当前无漏；但将来的 `content: '中文'` 或中文字体名会静默漏过 —— 纳入 .css 需单独决策。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 词法分类（每个字符一个）。 */
export type CharClass = 'code' | 'comment' | 'string';

/** 命中种类：字面量内 / 代码位置。 */
export type HitKind = 'literal' | 'code';

/** 扫描异常种类（t16：fail-closed；任何一条都让守卫判「不可判定」而不是静默放过）。 */
export type ScanAnomalyKind =
  | 'unclosed-string'
  | 'unclosed-block-comment'
  | 'unclosed-template'
  | 'unclosed-template-expr'
  | 'unclosed-regex'
  | 'unclosed-paren'
  | 'unclosed-brace';

/** 一条扫描异常（区间未闭合 ⇒ 该处结论不可判定）。 */
export interface ScanAnomaly {
  readonly kind: ScanAnomalyKind;
  readonly detail: string;
}

/** 字符类（冻结，§3.3-4）：只算表意字（对照用）。 */
export const CJK_NARROW = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
/** 字符类（冻结，§3.3-4）：broad —— 含 CJK 标点与全角形式（全角加号 U+FF0B 同样算缺陷）。 */
export const CJK_BROAD = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6]/;

const REGEX_PREV = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>']);
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'delete', 'void', 'new']);
const TICK = String.fromCharCode(96);

interface State {
  s: 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're' | 'code';
  depth?: number;
  fromTpl?: boolean;
  inClass?: boolean;
}

/**
 * 逐字符词法状态机（§3.3-1/2）；返回每个字符的类别 + 未闭合区间异常（t16 fail-closed）。
 *
 * `anomalies` 只在**扫描到 EOF 时仍有未闭合状态**（字符串 / 块注释 / 模板 / 正则 / 模板插值）时非空；
 * 行注释在 EOF 结束是合法的，不算异常。
 */
export function classifyWithAnomalies(src: string): { classes: CharClass[]; anomalies: ScanAnomaly[] } {
  const n = src.length;
  const cls: CharClass[] = new Array(n).fill('code');
  const stack: State[] = [];
  let i = 0;
  const cur = (): State | null => (stack.length > 0 ? (stack[stack.length - 1] as State) : null);
  while (i < n) {
    const st = cur();
    const c = src[i] as string;
    if (st && st.s === 'line') { cls[i] = 'comment'; if (c === '\n') stack.pop(); i++; continue; }
    if (st && st.s === 'block') {
      cls[i] = 'comment';
      if (c === '*' && src[i + 1] === '/') { cls[i + 1] = 'comment'; stack.pop(); i += 2; continue; }
      i++; continue;
    }
    if (st && (st.s === 'sq' || st.s === 'dq')) {
      cls[i] = 'string';
      const q = st.s === 'sq' ? "'" : '"';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === q || c === '\n') stack.pop();
      i++; continue;
    }
    if (st && st.s === 'tpl') {
      cls[i] = 'string';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === TICK) { stack.pop(); i++; continue; }
      if (c === '$' && src[i + 1] === '{') { cls[i] = 'string'; cls[i + 1] = 'string'; stack.push({ s: 'code', depth: 0, fromTpl: true }); i += 2; continue; }
      i++; continue;
    }
    if (st && st.s === 're') {
      cls[i] = 'string';
      if (c === '\\') { if (i + 1 < n) cls[i + 1] = 'string'; i += 2; continue; }
      if (c === '[') st.inClass = true;
      else if (c === ']') st.inClass = false;
      else if (c === '\n') { stack.pop(); i++; continue; }
      else if (c === '/' && st.inClass !== true) { stack.pop(); i++; continue; }
      i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { stack.push({ s: 'line' }); i += 2; continue; }
    if (c === '/' && src[i + 1] === '*') { stack.push({ s: 'block' }); i += 2; continue; }
    if (c === "'") { stack.push({ s: 'sq' }); i++; continue; }
    if (c === '"') { stack.push({ s: 'dq' }); i++; continue; }
    if (c === TICK) { stack.push({ s: 'tpl' }); i++; continue; }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j] as string)) j--;
      const prevChar = j >= 0 && cls[j] === 'code' ? (src[j] as string) : '';
      let k = j;
      while (k >= 0 && /[\w$]/.test(src[k] as string)) k--;
      const word = src.slice(k + 1, j + 1);
      if (prevChar === '' || REGEX_PREV.has(prevChar) || KEYWORDS.has(word)) { stack.push({ s: 're', inClass: false }); i++; continue; }
    }
    if (st && st.fromTpl === true) {
      if (c === '{') st.depth = (st.depth ?? 0) + 1;
      else if (c === '}') { if ((st.depth ?? 0) === 0) { stack.pop(); i++; continue; } st.depth = (st.depth ?? 0) - 1; }
    }
    i++;
  }
  const anomalies: ScanAnomaly[] = [];
  const seen = new Set<ScanAnomalyKind>();
  const push = (kind: ScanAnomalyKind, detail: string): void => {
    if (!seen.has(kind)) { seen.add(kind); anomalies.push({ kind, detail }); }
  };
  for (const st of stack) {
    if (st.s === 'block') push('unclosed-block-comment', '块注释 /* 未闭合');
    else if (st.s === 'sq') push('unclosed-string', '单引号字符串未闭合');
    else if (st.s === 'dq') push('unclosed-string', '双引号字符串未闭合');
    else if (st.s === 'tpl') push('unclosed-template', '模板字符串未闭合');
    else if (st.s === 're') push('unclosed-regex', '正则字面量未闭合');
    else if (st.s === 'code' && st.fromTpl === true) push('unclosed-template-expr', '模板插值 ${ 未闭合');
  }
  return { classes: cls, anomalies };
}

/** 兼容包装：只要字符类别（t16 前语义）。 */
export function classify(src: string): CharClass[] {
  return classifyWithAnomalies(src).classes;
}

/** 只看 code 位置的括号配对（E2 用）；未闭合返回 -1（t16 fail-closed，不再回落 src.length）。 */
function matchParen(src: string, cls: CharClass[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (cls[i] !== 'code') continue;
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** log/console callee 判定（§3.3-E2，逐字冻结）。 */
export const LOG_CALLEE_RE = /(?:^|[^\w$])(?:[\w$]+\.)*(?:log\.(?:trace|debug|info|warn|error)|console(?:\.[a-z]+)?)$/;

function logArgRanges(src: string, cls: CharClass[]): { ranges: Array<[number, number]>; anomalies: ScanAnomaly[] } {
  const ranges: Array<[number, number]> = [];
  const anomalies: ScanAnomaly[] = [];
  const re = /\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index;
    if (cls[open] !== 'code') continue;
    const head = src.slice(0, open).match(LOG_CALLEE_RE);
    if (!head) continue;
    const close = matchParen(src, cls, open);
    if (close < 0) {
      // fail-closed：括号未闭合 ⇒ 不施加 E2 豁免（其后中文照常计入）并记异常
      anomalies.push({ kind: 'unclosed-paren', detail: 'E2 log/console 实参括号未闭合（不施加豁免）' });
      continue;
    }
    ranges.push([open, close]);
  }
  return { ranges, anomalies };
}

/** 目录 zh 区标识（§3.3-E3，冻结）。 */
export const ZH_DICT_IDS = ['uiZh', 'zh', 'syncZh', 'marketZh', 'recoveryZh', 'historyZh', 'gistZh', 's3Zh'] as const;

/**
 * 已知字典文件（t16 归属清单）：这些文件里的 zh 对象**不**自带 register* 调用，但确是合法目录
 * （经 ctx.locale.register 注册的客户端字典、被 core/messages-core.ts 注册的 migrations 目录等）。
 *
 * 归属判据见 `isCatalogOwnerFile`；新增一本字典要么让文件自己调用 register*MessageCatalog/makeCatalogMsg，
 * 要么在此显式登记 —— 二者都必须是一次有意识的改动（**不可静默拓宽**）。
 */
export const KNOWN_CATALOG_FILES: readonly string[] = [
  'src/ui/i18n.ts',                          // uiZh/uiEn（makeUiT / makeLiveUiT 的目录）
  'src/client/locales.ts',                   // 主字典 zh/en（ctx.locale.register(NS)）
  'src/client/history/history-locales.ts',   // historyZh/historyEn
  'src/client/market/market-locales.ts',     // marketZh/marketEn
  'src/client/recovery/recovery-locales.ts', // recoveryZh/recoveryEn
  'src/client/sync/sync-locales.ts',         // syncZh/syncEn
  'src/migrations/messages-migrations.ts',   // zh/en 由 src/core/messages-core.ts 的 registerMessageCatalog 注册
  'src/client/chat/chat-locales.ts',         // 聊天内「↺ 回退」入口的独立字典（captain 登记 2026-10-10）
] as const;

/** 目录归属调用点（t16）：文件自身声明目录的三条既有通道。 */
const CATALOG_OWNER_CALL_RE = /register(?:Base)?MessageCatalog\s*\(|makeCatalogMsg\s*\(/;

/**
 * 只保留 **code 位置** 的字符，其余（注释 / 字符串 / 模板 / 正则）掩成空格（t18）。
 *
 * 用途：API 字样只有在代码位置才算「文件自身调用」——注释 / 字符串里出现的
 * `registerMessageCatalog(` 不得授予 E3 豁免（t17-F1 的旁路）。掩成**空格**而非删除，
 * 是为了不把被注释隔开的片段拼接成新的假匹配（被注释隔开的 register … MessageCatalog( 掩码后仍不相邻）。
 */
export function codeOnlyText(src: string): string {
  const { classes } = classifyWithAnomalies(src);
  const chars = src.split('');
  for (let i = 0; i < chars.length; i++) {
    if (classes[i] !== 'code') chars[i] = ' ';
  }
  return chars.join('');
}

/**
 * E3 归属判定（t16；**t18 收紧为只认 code 位置**）：本文件是否有权声明 zh 目录（豁免其中的中文）。
 *
 * 归属 = ① 文件在 `KNOWN_CATALOG_FILES` 显式清单里，或 ② 文件**在代码位置**调用
 * `registerMessageCatalog(` / `registerBaseMessageCatalog(` / `makeCatalogMsg(`。
 * 注释 / 字符串里的同名字样**不**授予归属（t17-F1）；未归属文件里的 `const zh = { a: '中文' }`
 * 一律照常计入命中（t9 F2 的加固）。
 */
export function isCatalogOwnerFile(rel: string, src: string): boolean {
  if (KNOWN_CATALOG_FILES.includes(rel)) return true;
  if (!CATALOG_OWNER_CALL_RE.test(src)) return false; // 快速预筛（原始文本）：无字样直接非属主
  return CATALOG_OWNER_CALL_RE.test(codeOnlyText(src)); // 只认 code 位置（注释/字符串字样不授予）
}

function zhDictRanges(src: string, cls: CharClass[]): { ranges: Array<[number, number]>; anomalies: ScanAnomaly[] } {
  const ranges: Array<[number, number]> = [];
  const anomalies: ScanAnomaly[] = [];
  for (const id of ZH_DICT_IDS) {
    const re = new RegExp('(?:^|[^\\w$.])' + id + '\\s*(?::[^=]*)?=\\s*\\{', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      if (open < 0) continue;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i++) {
        if (cls[i] !== 'code') continue;
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) {
        // fail-closed：对象字面量大括号未闭合 ⇒ 不施加 E3 豁免并记异常
        anomalies.push({ kind: 'unclosed-brace', detail: 'E3 目录 zh 对象大括号未闭合（不施加豁免）' });
        continue;
      }
      ranges.push([open, end]);
    }
  }
  return { ranges, anomalies };
}

const inRanges = (idx: number, ranges: Array<[number, number]>): boolean => ranges.some((r) => idx >= r[0] && idx <= r[1]);

/** 单文件内的一条命中（命中单位 = 字面量片段 × 行，§3.3-3）。 */
export interface ScanHit {
  readonly line: number;
  readonly kind: HitKind;
  readonly chars: number;
  readonly excerpt: string;
}

export interface ScanTextOptions {
  readonly classes?: 'broad' | 'narrow';
  /** false = 关掉 E2（对照用）。 */
  readonly exemptLog?: boolean;
  /** false = 关掉 E3（对照用）。 */
  readonly exemptCatalog?: boolean;
  /**
   * 目录归属（E3 前提，t16）：true = 本文件/样本是「已注册目录 / 已知字典文件」，其 zh 对象享 E3 豁免。
   * 缺省 **false**（fail-closed：未声明归属的 zh 对象里的中文照常计入命中）。
   * `scanFile`/`scanAll` 会用 `isCatalogOwnerFile` 自动判定并传入。
   */
  readonly catalogOwner?: boolean;
}

/**
 * 扫一段文本，返回命中 + 未闭合区间异常（t16；内存样本也可用 —— 内核自检 S1–S10 走这里）。
 *
 * E3 只在 `opts.catalogOwner === true` 时生效（缺省 false，fail-closed）；E2/E3 的区间未闭合时
 * **不施加豁免**并产出异常（见 `ScanAnomaly`）。
 */
export function scanTextFull(src: string, opts?: ScanTextOptions): { hits: ScanHit[]; anomalies: ScanAnomaly[] } {
  const o = opts ?? {};
  const { classes: cls, anomalies: lexAnomalies } = classifyWithAnomalies(src);
  const logRes = o.exemptLog === false ? { ranges: [] as Array<[number, number]>, anomalies: [] as ScanAnomaly[] } : logArgRanges(src, cls);
  const zhRes = (o.exemptCatalog === false || o.catalogOwner !== true)
    ? { ranges: [] as Array<[number, number]>, anomalies: [] as ScanAnomaly[] }
    : zhDictRanges(src, cls);
  const logRanges = logRes.ranges;
  const zhRanges = zhRes.ranges;
  const anomalies = [...lexAnomalies, ...logRes.anomalies, ...zhRes.anomalies];
  const classes = o.classes === 'narrow' ? CJK_NARROW : CJK_BROAD;
  const n = src.length;
  const lineOf = new Int32Array(n + 1);
  { let ln = 1; for (let i = 0; i < n; i++) { lineOf[i] = ln; if (src[i] === '\n') ln++; } lineOf[n] = ln; }
  const litOf = new Int32Array(n + 1);
  { let id = 0; for (let i = 0; i < n; i++) { if (cls[i] === 'string' && (i === 0 || cls[i - 1] !== 'string')) id++; litOf[i] = id; } }
  interface Group { line: number; kind: HitKind; chars: number; first: number; last: number }
  const groups = new Map<string, Group>();
  const re = new RegExp(classes.source, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const idx = m.index;
    if (cls[idx] === 'comment') continue;          // E1
    if (inRanges(idx, logRanges)) continue;        // E2
    if (inRanges(idx, zhRanges)) continue;         // E3
    const key = lineOf[idx] + '#' + litOf[idx];
    let g = groups.get(key);
    if (!g) { g = { line: lineOf[idx] as number, kind: cls[idx] === 'string' ? 'literal' : 'code', chars: 0, first: idx, last: idx }; groups.set(key, g); }
    g.chars++;
    if (idx < g.first) g.first = idx;
    if (idx > g.last) g.last = idx;
  }
  const hits = [...groups.values()].map((g) => ({
    line: g.line,
    kind: g.kind,
    chars: g.chars,
    excerpt: src.slice(g.first, Math.min(src.length, g.last + 1)).replace(/\s+/g, ' ').trim().slice(0, 160),
  }));
  return { hits, anomalies };
}

/** 兼容包装：只要命中（t16 前语义；异常由 scanTextFull / 守卫 A3 处理）。 */
export function scanText(src: string, opts?: ScanTextOptions): ScanHit[] {
  return scanTextFull(src, opts).hits;
}

/** 仓库根（本文件在 tests/helpers/ ⇒ 上溯两级；与 cwd 解耦）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 扫描根（§3.2）。 */
export const SCAN_ROOTS = ['src'] as const;
/** 排除：测试文件。 */
export const EXCLUDE_FILE_RE = /\.(test|spec)\.tsx?$/;
/** 排除：CLI 与离线救急台（§2.2）。 */
export const EXCLUDE_PREFIX = ['src/cli/'] as const;
/** 整文件豁免（§3.2）。 */
export const WHOLE_FILE_ZH_EXEMPT = ['locale/zh.json'] as const;
/** 额外纳入扫描集的两个包级目录文件。 */
export const GUARD_EXTRA_FILES = ['locale/en.json', 'locale/zh.json'] as const;
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'outputs', '.tmp', '.agent-teams', 'fixtures']);

function walkDir(root: string, relRoot: string, out: string[]): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkDir(full, join(relRoot, name).split(sep).join('/'), out);
    else if (/\.(ts|tsx|json)$/.test(name)) out.push(join(relRoot, name).split(sep).join('/'));
  }
}

/** 扫描集（workspace 相对 POSIX 路径，已排序）。 */
export function listScanFiles(extra?: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of SCAN_ROOTS) walkDir(join(REPO_ROOT, r), r, out);
  for (const f of extra ?? []) out.push(f);
  return out
    .filter((p) => !EXCLUDE_FILE_RE.test(p))
    .filter((p) => !EXCLUDE_PREFIX.some((x) => p.startsWith(x)))
    .sort();
}

/** 一条命中（带文件）。 */
export interface FileHit {
  readonly file: string;
  readonly line: number;
  readonly kind: HitKind;
  readonly chars: number;
  readonly excerpt: string;
}

/** 一个文件上的扫描异常（t16：区间未闭合 ⇒ 该文件结论不可判定）。 */
export interface FileAnomalies {
  readonly file: string;
  readonly anomalies: ScanAnomaly[];
}

/** 异常行（守卫报「不可判定（扫描区间未闭合）」用）。 */
export function formatAnomaly(entry: FileAnomalies): string {
  return entry.anomalies.map((a) => entry.file + ' [' + a.kind + '] ' + a.detail).join('\n');
}

/**
 * 扫一个 workspace 相对文件，返回命中 + 未闭合区间异常（t16；整文件豁免文件恒返回空）。
 *
 * `catalogOwner` 未显式给定时按文件自动判定（`isCatalogOwnerFile`）——显式 false 仍生效（对照用）。
 */
export function scanFileFull(rel: string, opts?: ScanTextOptions): { hits: FileHit[]; anomalies: ScanAnomaly[] } {
  if ((WHOLE_FILE_ZH_EXEMPT as readonly string[]).includes(rel)) return { hits: [], anomalies: [] };
  let raw: string;
  try { raw = readFileSync(join(REPO_ROOT, rel), 'utf8'); } catch { return { hits: [], anomalies: [] }; }
  const src = raw.replace(/\r\n/g, '\n');
  const res = scanTextFull(src, { ...opts, catalogOwner: opts?.catalogOwner ?? isCatalogOwnerFile(rel, src) });
  return {
    hits: res.hits.map((h) => ({ file: rel, line: h.line, kind: h.kind, chars: h.chars, excerpt: h.excerpt })),
    anomalies: res.anomalies,
  };
}

/** 兼容包装：只要命中（t16 前语义）。 */
export function scanFile(rel: string, opts?: ScanTextOptions): FileHit[] {
  return scanFileFull(rel, opts).hits;
}

export interface ScanAllOptions extends ScanTextOptions {
  readonly scope?: readonly string[];
  readonly extra?: readonly string[];
}

/** 扫扫描集（可选作用域收窄），返回生效文件列表与全部命中。 */
export function scanAll(opts?: ScanAllOptions): { files: string[]; hits: FileHit[]; anomalies: FileAnomalies[] } {
  const o = opts ?? {};
  const all = listScanFiles(o.extra ?? GUARD_EXTRA_FILES);
  const scope = o.scope ?? [];
  const scoped = scope.length > 0 ? all.filter((f) => scopeMatches(f, scope)) : all;
  const hits: FileHit[] = [];
  const anomalies: FileAnomalies[] = [];
  for (const f of scoped) {
    const res = scanFileFull(f, o);
    hits.push(...res.hits);
    if (res.anomalies.length > 0) anomalies.push({ file: f, anomalies: res.anomalies });
  }
  return { files: scoped, hits, anomalies };
}

/** 目录段边界匹配（§3.6：src/client 不得命中 src/client2）。 */
export function scopeMatches(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((s) => file === s || file.startsWith(s.endsWith('/') ? s : s + '/'));
}

export interface GuardScopeParse {
  /** 生效前缀；空数组 = 全量。 */
  readonly prefixes: string[];
  /** 非法值（非空即必须失败）。 */
  readonly errors: string[];
}

export const GUARD_SCOPE_VAR = 'DCM_I18N_GUARD_SCOPE';
export const GUARD_SCOPE_USAGE = '用法：' + GUARD_SCOPE_VAR + '=<逗号分隔的 workspace 相对 POSIX 前缀>（例：src/client,src/ui）；未设置 = 全量扫描';

/** 解析 DCM_I18N_GUARD_SCOPE（§3.6；非法值绝不静默当空集）。 */
export function parseGuardScope(raw: string | undefined): GuardScopeParse {
  const errors: string[] = [];
  const text = (raw ?? '').trim();
  if (text === '') return { prefixes: [], errors };
  const prefixes: string[] = [];
  for (const piece of text.split(',')) {
    const s = piece.trim();
    if (s === '') continue;
    if (/^[A-Za-z]:/.test(s) || s.startsWith('/') || s.startsWith('//')) {
      errors.push('绝对路径不允许（workspace 相对 POSIX 前缀）: ' + s);
      continue;
    }
    if (s.includes('\\')) { errors.push('反斜杠不允许（用 POSIX 分隔符）: ' + s); continue; }
    if (s.split('/').includes('..')) { errors.push('含 .. 段不允许: ' + s); continue; }
    prefixes.push(s);
  }
  return { prefixes, errors };
}

/** 白名单条目（§3.3-W，形状冻结）。 */
export interface I18nAllowlistEntry {
  /** workspace 相对 POSIX 路径（逐字相等匹配） */
  readonly file: string;
  /** 现测命中数（精确相等：增长=新缺陷，减少=条目过期，两种都必须改条目） */
  readonly expectedHits: number;
  /** 「为什么用户看不到它」的可核验理由（不得写「内部用」这类不可核验的话） */
  readonly reason: string;
}

/**
 * 白名单（4 条，合计 132 命中；2026-10-08 起 commands.ts 49 → 53 —— 新增 checkpoint 命令的 4 个中文匹配词）。
 *
 * t1 §3.5 初始 2 条 73 命中；t12 经 captain 裁决（依据 t3 取证 + 内核复算）增补 2 条 55 命中：
 * 两处都是「匹配模式 / 检索同义词」而非用户可见文案（迁走会让中文匹配能力消失，或把中文搬进
 * E3 豁免区 ⇒ 等价于不可见），故保持原样并以白名单 + 可核验理由登记。
 * 新增条目的唯一通道：作用域所有者 → captain → t2 所有者落进这里（硬约束②；迁移期不再增量）。
 */
export const I18N_ALLOWLIST: readonly I18nAllowlistEntry[] = [
  {
    file: 'src/foreign/truth-table.ts',
    // 2026-10-18：claude-code 条目补 refs 说明（新增 1 处中文取证文本）→ 61 → 62。
    // 该计数只随「该文件里的中文取证文本」变化；不是新增豁免条目（条目数仍为 4）。
    expectedHits: 62,
    reason: 'refs/dynamic 是取证文本数据（FOREIGN_TRUTH_TABLES 字段），供 truth-table.test.ts 与各来源单测逐平台比对，从不渲染：非测试导入方全在 src/foreign/**，src/ui/foreign-view.ts 只消费 source.paths（界面文案走 ui/i18n.ts 的 foreign.paths/foreign.pathsNone）',
  },
  {
    file: 'src/ui/test-helpers.ts',
    expectedHits: 12,
    reason: '文件头自述仅供 src/ui/*.test.ts 使用、不参与生产构建语义；实测除 *.test.ts 外零导入方，且从 client 打包入口 src/client/index.ts 不可达（tsdown 单入口）⇒ 不进 lib/client.js',
  },
  {
    file: 'src/ui/commands.ts',
    expectedHits: 53,
    reason: 'COMMANDS[].keywords 是命令面板的**检索同义词**、不是文案：唯一消费方 filterCommands → matchScore 只对关键词做 toLowerCase / startsWith / includes 并折成分档数值（本文件 :196-207），返回值 CommandMatch 只带 {item, disabled}，关键词从不作为文本离开本模块；面板可见标题由调用方注入 titleOf(titleKey)（:222 / :237），由壳层 src/client/common/CommandPalette.tsx:20+ 用 t(item.titleKey) 渲染客户端字典 src/client/locales.ts；文件头 :7-12 自述「零依赖、与语言无关：文案键只声明字面量联合」。中文词只是让中文用户搜得到命令，删掉只会让检索退化、不改变任何显示文本',
  },
  {
    file: 'src/ui/errors.ts',
    expectedHits: 6,
    reason: 'buildErrorRules() 的 match 是**正则字面量**，只对宿主产出的错误消息（可能含中文原文）做 .test() 子串判定以挑选规则（本文件 :31-76），正则本身从不进入返回值或界面；显示文本来自规则里的 UiT 键 error.*.title / error.*.action（:83-90 写进 ActionableError.title / suggestedAction），由 src/ui/i18n.ts 字典渲染，经 src/client/common/ErrorBanner.tsx 与 src/ui/import-wizard.ts 展示。中文在这里是**匹配能力**（宿主错误消息是中文时才能命中友好标题），迁走会让匹配失效',
  },
] as const;

/** 白名单总命中数（A5 锚定：t1 初始 73 + t12 授权增量 55 + 2026-10-08 checkpoint 命令 4 + 2026-10-18 truth-table 取证文本 1）。 */
export const ALLOWLIST_TOTAL_HITS = 133;
/** 白名单条目数（A5 锚定「迁移期不得新增豁免」：t1 初始 2 + t12 授权的 2）。 */
export const ALLOWLIST_ENTRY_COUNT = 4;

/** 白名单过期/漂移检查（S6 与 A5）：返回人类可读的失败清单（空 = 通过）。 */
export function checkAllowlist(
  entries: readonly I18nAllowlistEntry[],
  measured: ReadonlyMap<string, number>,
  scannedFiles: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];
  for (const e of entries) {
    const got = measured.get(e.file) ?? 0;
    if (!scannedFiles.has(e.file)) {
      issues.push('白名单条目指向不在扫描集内的文件: ' + e.file);
      continue;
    }
    if (got === 0) { issues.push('白名单条目已过期（实测 0 命中，必须删除该条目）: ' + e.file); continue; }
    if (got !== e.expectedHits) {
      issues.push('白名单条目计数漂移（expected=' + e.expectedHits + ' measured=' + got + '，差值 ' + (got - e.expectedHits) + '）: ' + e.file);
    }
  }
  return issues;
}

/** en 目录体检文件（A2；8 本字典 + locale/en.json）。 */
export const EN_CATALOG_FILES: readonly string[] = [
  'src/client/locales.ts',
  'src/ui/i18n.ts',
  'src/core/messages.ts',
  'src/client/history/history-locales.ts',
  'src/client/market/market-locales.ts',
  'src/client/recovery/recovery-locales.ts',
  'src/client/sync/sync-locales.ts',
  'src/client/chat/chat-locales.ts',
  'locale/en.json',
];

/** 按文件统计命中数。 */
export function countByFile(hits: readonly FileHit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of hits) m.set(h.file, (m.get(h.file) ?? 0) + 1);
  return m;
}

/** 机器可读摘要行（§3.1 冻结格式）。 */
export function summaryLine(prefixes: readonly string[], files: number, hits: number, allowlisted: number): string {
  const scope = prefixes.length > 0 ? prefixes.join(',') : 'ALL';
  return 'DCM_I18N_GUARD scope=' + scope + ' files=' + files + ' hits=' + hits + ' allowlisted=' + allowlisted;
}

/** 命中行（§3.1 冻结格式）。 */
export function formatHit(h: FileHit): string {
  return h.file + ':' + h.line + ' [' + h.kind + '] ' + h.excerpt;
}
