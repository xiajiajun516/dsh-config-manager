/**
 * pnpm-workspace.yaml 的 `patchedDependencies` 处理（issue #35）。
 *
 * 背景：plugins 分区会**整段搬运** pnpm-workspace.yaml，但 `patchedDependencies` 引用的
 * `patches/*.patch` 文件不在任何被同步的分区里。目标机因此拿到「声明存在、文件不存在」的
 * 组合，此后**任何** `pnpm add`（含 dsh plugin add）都失败于
 * `Failed to read patch file ... (os error 2)` —— 用户实测 13/13 插件安装全灭。
 *
 * 本模块做三件事，且**不做整文件重写**（保留用户注释与格式）：
 *  1. `parsePnpmPatchedDependencies`：按行解析声明（供导出侧收集 patch 文件）；
 *  2. `sanitizePnpmWorkspacePatches`：把「目标机没有对应文件」的条目整行删掉
 *     （含其上方注释），全部被删时连键一起删 —— 宁可少迁移一条 patch 声明，
 *     也不让目标机的 pnpm 从此拒绝一切安装；
 *  3. `stripPnpmMachinePaths` / `restorePnpmMachinePaths`：机器相关路径键的
 *     可移植性净化（见文末「可移植性净化」一节）。
 */
import { isPathSafe, normalizePath } from '../utils/paths.ts';

export interface PatchedDependency {
  /** 依赖名（patchedDependencies 的键） */
  name: string;
  /** 声明的 patch 路径（相对 profile 目录，已去引号；原始写法保留） */
  path: string;
}

export interface ParsePatchedResult {
  declared: PatchedDependency[];
  /** 无法安全改写的形态（如单行 flow 映射）→ 调用方据此告警，绝不猜着改 */
  unsupported: string | null;
}

const KEY_RE = /^patchedDependencies\s*:(.*)$/;
const ENTRY_RE = /^([ \t]+)([^\s#][^:]*?)\s*:\s*(.*)$/;

/** 去引号 + 去行尾注释（保守：只在引号外找 ` #`） */
function cleanScalar(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("'") || v.startsWith('"')) {
    const quote = v[0] as string;
    const end = v.indexOf(quote, 1);
    if (end > 0) return v.slice(1, end);
  }
  const hash = v.indexOf(' #');
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/** 解析 patchedDependencies 的声明（纯函数；不校验文件是否存在）。 */
export function parsePnpmPatchedDependencies(text: string): ParsePatchedResult {
  const declared: PatchedDependency[] = [];
  if (text === '') return { declared, unsupported: null };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_RE.exec(lines[i] ?? '');
    if (m === null) continue;
    const inline = (m[1] ?? '').trim();
    // 单行 flow 形态（patchedDependencies: {a: b}）无法按行安全删条目 → 不改写，交给调用方告警
    if (inline !== '' && !inline.startsWith('#')) {
      return { declared, unsupported: lines[i] ?? '' };
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '' || /^[ \t]*#/.test(line)) continue;
      const e = ENTRY_RE.exec(line);
      if (e === null) break; // 缩进块结束（回到顶层键）
      declared.push({ name: (e[2] ?? '').trim(), path: cleanScalar(e[3] ?? '') });
    }
    break; // patchedDependencies 只处理第一处（YAML 重复键本就非法）
  }
  return { declared, unsupported: null };
}

export interface SanitizeResult {
  /** 清理后的文本（无需修改时与入参逐字节相同） */
  text: string;
  declared: PatchedDependency[];
  /** 被移除的条目（目标机没有对应 patch 文件） */
  dropped: PatchedDependency[];
  unsupported: string | null;
}

/**
 * 删除 patchedDependencies 中「目标机不存在对应 patch 文件」的条目。
 * @param available 判断某相对路径（相对 profile 目录）在**导入后**是否存在
 */
export function sanitizePnpmWorkspacePatches(
  text: string,
  available: (relPath: string) => boolean,
): SanitizeResult {
  const parsed = parsePnpmPatchedDependencies(text);
  if (parsed.unsupported !== null) {
    return { text, declared: parsed.declared, dropped: [], unsupported: parsed.unsupported };
  }
  if (parsed.declared.length === 0) return { text, declared: [], dropped: [], unsupported: null };

  const droppedNames = new Set<string>();
  for (const d of parsed.declared) {
    const rel = normalizePath(d.path);
    // 越界/绝对路径的声明在目标机同样不可读（pnpm 也会拒绝）→ 一并移除
    if (rel === '' || !isPathSafe(rel) || !available(rel)) droppedNames.add(d.name);
  }
  if (droppedNames.size === 0) return { text, declared: parsed.declared, dropped: [], unsupported: null };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = KEY_RE.exec(line);
    if (m === null) { out.push(line); continue; }
    const inline = (m[1] ?? '').trim();
    if (inline !== '' && !inline.startsWith('#')) { out.push(line); continue; }
    // 收集整块（键 + 缩进条目 + 其上的注释）
    const block: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (l.trim() === '' || /^[ \t]*#/.test(l)) { block.push(l); continue; }
      if (ENTRY_RE.exec(l) === null) break;
      block.push(l);
    }
    // 逐条判定：保留/删除（注释与空行随其**下一条**条目一起处置；尾部孤立注释一律保留）
    const kept: string[] = [];
    let pending: string[] = [];
    let keptEntries = 0;
    for (const bl of block) {
      const e = ENTRY_RE.exec(bl);
      if (e === null) { pending.push(bl); continue; }
      const name = (e[2] ?? '').trim();
      if (droppedNames.has(name)) { removed += 1; pending = []; continue; }
      kept.push(...pending, bl);
      pending = [];
      keptEntries += 1;
    }
    kept.push(...pending);
    if (keptEntries > 0) {
      out.push(line);           // 键保留
      out.push(...kept);
    } else {
      removed += 1;             // 键本身也删（没有任何条目留下）
    }
    i = j - 1;
  }
  // 全部条目都没了 → 键与块一起消失；否则写回（保留原 EOL）
  return {
    text: out.join(eol),
    declared: parsed.declared,
    dropped: parsed.declared.filter((d) => droppedNames.has(d.name)),
    unsupported: null,
  };
}

/* ------------------------------------------------------------------ *
 * 可移植性净化（跨机同步）：机器相关路径键
 *
 * `storeDir` / `cacheDir` … 的值是**本机绝对路径**。它们跟着快照跑到另一台机器后必然指向
 * 不存在的目录（pnpm 会去那里建 store / 缓存）。纪律只有两条：
 *  1. 收集（导出 / push）与写回（导入 / pull）两侧都**整行删除**这些键 —— 其余内容逐字不变，
 *     EOL 原样保留（CRLF 输入绝不引入 LF 漂移）；只删「根层 `key:`」形态，
 *     缩进块里的同名键（如插件的自定义配置）一律不碰；
 *  2. 写回时把**目标机自己原有的**那几行接回去：不搬运来源机的路径，也不清掉本机自己的设置。
 *
 * `.npmrc` 刻意**不进同步面**（见 plugins.ts 的说明）：纳入它会改变 bundle 载荷形态
 * （docs/spec/bundle-format-v1.md + conformance），而本机 .npmrc 从来就不由本插件写 ——
 * 「不碰 = 本机保留」。
 * ------------------------------------------------------------------ */

/**
 * 机器相关 pnpm 设置键（根层）。camelCase 是 pnpm-workspace.yaml 的权威拼写；
 * kebab 变体是同一组设置的另一方言（.npmrc / 部分版本），根层出现同样是本机路径绑定。
 */
export const PNPM_MACHINE_PATH_KEYS: readonly string[] = [
  'storeDir', 'store-dir',
  'globalDir', 'global-dir',
  'globalBinDir', 'global-bin-dir',
  'cacheDir', 'cache-dir',
  'stateDir', 'state-dir',
  'configDir', 'config-dir',
];

const MACHINE_PATH_KEY_SET: ReadonlySet<string> = new Set(PNPM_MACHINE_PATH_KEYS);

/** 根层的 `key: value` 形态；缩进行、注释行、块标量内容都不会命中（它们不从行首开始）。 */
const ROOT_KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;

/** 空值或 YAML 块标量（`|` / `>` 及其修饰符）⇒ 值写在其后的缩进行里 */
function isBlockValue(raw: string): boolean {
  const v = raw.trim();
  return v === '' || /^[|>][+-]?\d*$/.test(v);
}

/** 行首若是机器相关键 → 返回键名与冒号后的原文；否则 null（`\r` 不算值的一部分） */
function rootMachineKey(line: string): { key: string; value: string } | null {
  const m = ROOT_KEY_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (m === null) return null;
  const key = m[1] ?? '';
  if (!MACHINE_PATH_KEY_SET.has(key)) return null;
  return { key, value: m[2] ?? '' };
}

export interface MachinePathStripResult {
  /** 剥离后的文本（无需改动时与入参**逐字节相同**；只做整行删除，EOL 原样保留） */
  text: string;
  /** 被剥离的键（按首次出现顺序去重） */
  stripped: string[];
}

/**
 * 剥掉机器相关路径键（行级过滤）。
 *
 * 值写在同行 → 只删这一行；值写在缩进块里（`storeDir:` / `storeDir: |`）→ 连它的缩进续行
 * 一起删，避免留下孤儿缩进行把文件变成坏 YAML。其余内容（含注释、空行、行尾缺换行）逐字不变。
 */
export function stripPnpmMachinePaths(text: string): MachinePathStripResult {
  if (text === '') return { text, stripped: [] };
  const lines = text.split('\n');
  const out: string[] = [];
  const stripped: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const hit = rootMachineKey(line);
    if (hit === null) { out.push(line); continue; }
    if (!stripped.includes(hit.key)) stripped.push(hit.key);
    if (isBlockValue(hit.value)) {
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? '')) i += 1;
    }
  }
  return { text: out.join('\n'), stripped };
}

export interface MachinePathRestoreResult {
  /** 接回本机路径行后的文本（无需恢复时与入参逐字相同） */
  text: string;
  /** 接回的键（按首次出现顺序去重） */
  restored: string[];
}

/**
 * 把**目标机自己原有的**机器路径行接回将要写入的文本（写回侧）。
 *
 * 来源机的路径已在收集侧剥离（这里对老载荷再剥一次是纵深防御），所以本函数接回的只可能是
 * 目标机原本就有的设置 —— 既不搬运来源机的路径，也不让一次导入清掉本机自己的 store 位置。
 * `local` 为 null（目标机本来就没有该文件）时原样返回。接回行统一用 incoming 的 EOL。
 */
export function restorePnpmMachinePaths(
  incoming: string,
  local: string | null | undefined,
): MachinePathRestoreResult {
  if (incoming === '' || local === null || local === undefined || local === '') {
    return { text: incoming, restored: [] };
  }
  const lines = local.split('\n');
  const kept: string[] = [];
  const restored: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const hit = rootMachineKey(line);
    if (hit === null) continue;
    if (!restored.includes(hit.key)) restored.push(hit.key);
    kept.push(line);
    if (isBlockValue(hit.value)) {
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? '')) {
        i += 1;
        const cont = lines[i] ?? '';
        kept.push(cont.endsWith('\r') ? cont.slice(0, -1) : cont);
      }
    }
  }
  if (kept.length === 0) return { text: incoming, restored: [] };
  const eol = incoming.includes('\r\n') ? '\r\n' : '\n';
  const head = incoming.endsWith('\n') ? incoming : incoming + eol;
  return { text: head + kept.map((l) => l + eol).join(''), restored };
}
