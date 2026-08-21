/**
 * 敏感字段扫描器（规范 §6 / 设计 §7.2 / core `SecretScanner` 契约的强化实现）。
 *
 * 定位：`ctx.settings.describe({redactSecrets:true})` 已剥离 DSH 已知秘密（设计 §7.2），
 * 本扫描器是**第二道防线**，兜底插件自定义字段、MCP headers、patch config、文件类分区文本。
 *
 * 判定策略（两级，避免误伤/漏报）：
 *  - 字段名：规范化（小写、去 `_-. ` 分隔符）后做「精确命中 / 敏感后缀 / 敏感前缀」三级匹配；
 *    只剥离**字符串叶值**（对象/数组整体递归，不整块剥离——保证 `credentials: [...]` 状态数组存活）。
 *  - 引用豁免：`apiKeyEnv` 等「只存引用名」字段、形如 `DEEPSEEK_API_KEY` 的全大写环境变量名
 *    （`isEnvVarName`）以及 `${VAR}` / `{{VAR}}` / `%VAR%` / `$VAR` 模板引用（`isTemplateReference`）
 *    一律保留——值是名字不是秘密。
 *  - 值形状启发式（规范 §6「不能只根据固定字段判断」）：字段名未命中但值长得像 secret
 *    （sk- / JWT / AKIA / GitHub PAT / PEM 私钥 / Bearer）也剥离；**示例/占位形态**（含
 *    your/example/xxx/test/<...> 等占位词的 `sk-your-*`、`Bearer example-*`、JWT 教学串）放行。
 *  - 两种判定档位（2026-08-21 优化）：
 *    * 保守档（默认，导出/同步脱敏用）：字段名敏感**即**剥离（值形状优先、引用/env 名豁免）；
 *    * 宽松档（`literalValueOnly`，市场发布扫描用）：字段名敏感**且**值像真实字面量凭据
 *      （非占位符 / 非类型词 / 非代码表达式 / 非模板引用 / 非短标识符）才命中——消除
 *      `"token": "your-token"`、`"token": "${OPENAI_API_KEY}"`、`"Authorization": "Bearer <token>"`
 *      等「值不是秘密」的误报。
 *  - 高熵 base64 默认关（误伤率高）。
 *
 * 实现不变量：返回 sanitized 为**全新对象**（不改原数据）；迭代式显式栈（防爆栈）+ 深度上限；
 * 命中记录只含路径与字段名，**值永不外泄**。
 */
import { JsonDepthError } from '../utils/json.ts';
import type { SecretScanner, SensitiveHit } from '../core/types.ts';

/** 剥离占位（与 core defaultSecretScanner 语义一致：空串 = 需补录提示） */
export const REDACTED_PLACEHOLDER = '';

/**
 * 敏感字段名单（规范化名：小写、无分隔符）。
 * 覆盖规范 §6 原始清单 + 设计 §7.2 + core logger 名单，并保持克制以防误伤
 * （不收录 `key`/`session` 等过宽子串——`sessionIds`/`monkey` 不得中招）。
 */
export const DEFAULT_SECRET_FIELD_NAMES: readonly string[] = [
  // 规范 §6 原文
  'password', 'passwd', 'token', 'accesstoken', 'refreshtoken',
  'apikey', 'secret', 'credential', 'authorization', 'cookie',
  'privatekey', 'clientsecret',
  // 设计 §7.2 / core logger 扩充
  'pwd', 'passphrase', 'authtoken', 'sessionkey', 'apisecret',
  'authheader', 'bearer', 'webhooksecret',
];

/** 引用字段（值只是「名字」而非秘密）：规范化精确命中即豁免 */
export const DEFAULT_REFERENCE_FIELDS: readonly string[] = [
  'apikeyenv', 'apikeyname', 'apikeyref',
  'tokenenv', 'accesstokenenv', 'refreshtokenenv',
  'clientsecretenv', 'passwordenv', 'secretref', 'credentialref',
];

/** 敏感后缀（规范化后以这些结尾 → 命中；`key` 故意不收，避免 monkey/whiskey 误伤） */
const SENSITIVE_SUFFIXES = ['token', 'secret', 'password', 'passwd', 'credential'] as const;

/** 敏感前缀（规范化后以这些开头 → 命中；token/secret 等过宽词不收入） */
const SENSITIVE_PREFIXES = [
  'apikey', 'accesstoken', 'refreshtoken', 'authtoken',
  'clientsecret', 'privatekey', 'authorization', 'authheader',
  'webhooksecret', 'apisecret',
] as const;

/** 值形状强模式（默认开）：一眼可辨的密钥/凭据形态（包含式：值内任意位置出现即命中） */
export interface ValuePattern { name: string; re: RegExp }
export const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9_-]{8,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'bearer-token', re: /Bearer [A-Za-z0-9._~+/=-]{8,}/ },
];

/**
 * 值形状命中片段中的「示例/占位」词：匹配到的片段含其中任一 → 视为示例形态放行。
 * 覆盖 `sk-your-*`、`sk-example-*`、`sk-test-*`、`Bearer example-*`、`AKIA...EXAMPLE`（AWS 官方示例）、
 * JWT 教学串（第三段 signature）等；真实随机密钥串几乎不可能包含这些完整单词，安全不回退。
 */
const SECRET_SHAPE_PLACEHOLDER_WORDS = [
  'your', 'their', 'example', 'sample', 'dummy', 'placeholder',
  'test', 'demo', 'signature', 'secret', 'value', 'xxxx',
] as const;

/** 值形状命中是否「示例/占位」形态（含占位词或尖括号包裹）→ 放行 */
function isExampleSecretShape(matched: string): boolean {
  if (/<[^>]+>/.test(matched)) return true;
  const lower = matched.toLowerCase();
  return SECRET_SHAPE_PLACEHOLDER_WORDS.some((w) => lower.includes(w));
}

/** 值形状命中详情（模式名 + 实际匹配片段；示例降噪用） */
interface ValuePatternHit { name: string; matched: string }

function matchSecretValuePatternHit(value: string): ValuePatternHit | null {
  for (const p of SECRET_VALUE_PATTERNS) {
    const m = p.re.exec(value);
    if (m !== null) return { name: p.name, matched: m[0] };
  }
  return null;
}

/** 值是否命中强模式 secret 形状（示例/占位形态 → null；返回命中模式名；未命中返回 null） */
export function matchSecretValuePattern(value: string): string | null {
  const hit = matchSecretValuePatternHit(value);
  if (hit === null) return null;
  if (isExampleSecretShape(hit.matched)) return null;
  return hit.name;
}

export interface SecretScannerOptions {
  /** 附加敏感字段名（任意原始形态，内部会规范化） */
  extraFieldNames?: string[];
  /** 附加引用字段名（规范化后精确命中即豁免） */
  extraReferenceFields?: string[];
  /** 值形状启发式开关（默认 true） */
  valuePatterns?: boolean;
  /** 高熵长串启发式（默认 false：误伤风险高，需显式开启） */
  highEntropy?: boolean;
  /**
   * 宽松档（默认 false = 保守档）。
   * 保守档（导出/同步脱敏）：字段名敏感即命中，值形状优先、引用/env 名豁免；
   * 宽松档（市场发布扫描）：字段名敏感**且**值像真实字面量凭据才命中——占位符 /
   * 模板引用 / 代码表达式 / 类型词 / 短标识符放行，消除「值不是秘密」的误报。
   */
  literalValueOnly?: boolean;
  /** 最大递归深度（默认 64，与 JSON 深度上限一致） */
  maxDepth?: number;
}

/** 规范化字段名：小写 + 去 `_-. ` 分隔符（用于名单匹配） */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 是否为「环境变量名」形态（全大写下划线，如 DEEPSEEK_API_KEY）→ 视为引用名 */
export function isEnvVarName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,}$/.test(value);
}

/** 是否为模板/环境变量引用形态（${VAR} / {{VAR}} / %VAR% / $VAR）→ 值是名字不是秘密。
 *  注意：文本扫描的 `field: value` 正则用 `[^\s,;}]` 取值，`${...}` / `{{...}}` 的右花括号
 *  会被截断，因此除完整闭合形态外，也接受「以 ${ / {{ / % 开头、内容全为变量名字符」的截断形态。 */
export function isTemplateReference(value: string): boolean {
  const v = value.trim();
  // 完整闭合形态
  if (/^\$\{[A-Za-z0-9_.]+\}$/.test(v)) return true;
  if (/^\{\{[A-Za-z0-9_.]+\}\}$/.test(v)) return true;
  if (/^%[A-Za-z0-9_.]+%$/.test(v)) return true;
  if (/^\$[A-Z][A-Z0-9_]{2,}$/.test(v)) return true;
  // 截断形态（右花括号被取值正则排除）：真实凭据不会以 ${ / {{ / % 开头，放行安全
  if (/^\$\{[A-Za-z0-9_.]*$/.test(v)) return true;
  if (/^\{\{[A-Za-z0-9_.]*$/.test(v)) return true;
  if (/^%[A-Za-z0-9_.]*$/.test(v)) return true;
  return false;
}

/** 字段名是否命中敏感名单（规范化后精确 / 敏感后缀 / 敏感前缀） */
export function isSensitiveFieldName(
  field: string,
  extra: readonly string[] = [],
): boolean {
  const norm = normalizeFieldName(field);
  if (norm === '') return false;
  if ([...DEFAULT_SECRET_FIELD_NAMES, ...extra].includes(norm)) return true;
  if (SENSITIVE_SUFFIXES.some((s) => norm.endsWith(s) && norm.length > s.length)) return true;
  return SENSITIVE_PREFIXES.some((p) => norm.startsWith(p));
}

/** 是否为引用字段（值只是名字，不剥离） */
export function isReferenceField(
  field: string,
  extra: readonly string[] = [],
): boolean {
  const norm = normalizeFieldName(field);
  return [...DEFAULT_REFERENCE_FIELDS, ...extra].includes(norm);
}

/** 高熵启发式：长 base64/hex 串且 Shannon 熵高（默认关） */
function isHighEntropySecret(value: string): boolean {
  if (!/^[A-Za-z0-9+/=_-]{32,}$/.test(value)) return false;
  if (/^[A-Za-z0-9_-]+$/.test(value) && !/[0-9]/.test(value)) return false; // 纯单词串（如文件名）
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy > 4.2;
}

/* ---------------- 值形态判定（结构化扫描与文本扫描共用） ---------------- */

/** 占位符 / 示例形态：xxx、your-token、<...>、example、sample、dummy、placeholder、... */
const PLACEHOLDER_RE = /^(x{3,}|your[-_ ]?[\w]+|their[-_ ]?[\w]+|<[^>]+>|example|examples?|sample|dummy|placeholder|som[e]thing|^\u2026)/i;

/** 类型/关键字形态（代码声明，如 `authToken: string`、`token: null`） */
const TYPE_KEYWORD_RE = /^(string|number|boolean|object|array|any|unknown|null|undefined|void|true|false|required|optional)$/i;

/** 代码表达式/引用形态：值里出现调用/成员访问/引号/运算符/空白等 → 是代码而非字面量密钥 */
function isCodeExpressionValue(value: string): boolean {
  // 方法调用 / 成员访问：data.token、process.env.X、wx.getStorageSync(...)、a.b(...)
  if (/[.([\]'"`]/.test(value)) return true;
  // 赋值/比较/模板：a=b、a&&b 等
  if (/[=+*/%<>!&|?]+/.test(value)) return true;
  // 含空白 → 短语/语句而非单个字面量
  if (/\s/.test(value)) return true;
  return false;
}

/** 混合字符长串是否「疑似真实凭据」：含数字、或含字母数字连字符下划线以外的符号、或大小写混合
 *  （纯小写字母+连字符的示例值如 `abc-def-ghi-jkl` → 放行；`s3cretP@ssw0rd` / `abc123-def456` → 拦截） */
function looksLikeCredential(value: string): boolean {
  if (value.length < 8) return false;
  if (/[0-9]/.test(value)) return true;
  if (/[^A-Za-z0-9_-]/.test(value)) return true;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) return true;
  return false;
}

/** 值是否为「字面量密钥」：既不是代码表达式，也不是占位符/类型词/短标识符/环境引用。
 *  只有字段名敏感 **且** 值像真实字面量凭据时才报告 —— 消除技能文档中
 *  `authToken: string`、`password: process.env.X`、`token: data.token` 等代码示例误报。 */
function isLiteralSecretValue(value: string): boolean {
  if (value === '') return false;
  // 值形状强信号（sk- / ghp_ / AKIA / JWT / PEM / Bearer，示例/占位形态已降噪）—— 任何字段都视为真凭据
  if (matchSecretValuePattern(value) !== null) return true;
  if (PLACEHOLDER_RE.test(value)) return false;
  if (TYPE_KEYWORD_RE.test(value)) return false;
  if (isCodeExpressionValue(value)) return false;
  if (isEnvVarName(value)) return false;
  if (isTemplateReference(value)) return false;
  // 纯字母数字短标识符（变量名/普通词，如 authToken、data、key）→ 非密钥
  if (/^[A-Za-z0-9_]+$/.test(value) && value.length < 20) return false;
  // 其余：混合字符串，仅当像真实凭据（含数字/符号/大小写混合）才疑似
  return looksLikeCredential(value);
}

/** 判定单个「字段名 + 字符串值」：strip | keep（含引用豁免与值形状）
 * 顺序：值形状优先（AKIA 等全大写 secret 形状不能被 env 名豁免误放）→ 引用字段 → env 名 → 字段名。
 * 宽松档（literalValueOnly，市场发布）：字段名命中还要求值像真实字面量凭据（非占位/引用/代码）。 */
function judgeFieldValue(field: string, value: string, opts: Required<Pick<SecretScannerOptions, 'extraFieldNames' | 'extraReferenceFields' | 'valuePatterns' | 'highEntropy' | 'literalValueOnly'>>): boolean {
  if (value === '') return false;
  if (opts.literalValueOnly) {
    // 宽松档（市场发布扫描）：值形状强信号字段无关必拦；字段名敏感 + 值像真实字面量凭据才拦
    if (opts.valuePatterns && matchSecretValuePattern(value) !== null) return true;
    if (isSensitiveFieldName(field, opts.extraFieldNames) && isLiteralSecretValue(value)) return true;
    return false;
  }
  // 保守档（导出/同步脱敏）：值形状优先 → 引用字段/env 名豁免 → 字段名敏感即剥
  if (opts.valuePatterns && matchSecretValuePattern(value) !== null) return true;
  if (isReferenceField(field, opts.extraReferenceFields)) return false;
  if (isEnvVarName(value)) return false; // 值是 env 变量名 → 引用
  if (isSensitiveFieldName(field, opts.extraFieldNames)) return true;
  if (opts.highEntropy && isHighEntropySecret(value)) return true;
  return false;
}

/** 递归扫描 + 剥离（纯函数，不改原数据；深度保护；返回清洗后数据与命中清单） */
export function scanAndRedact(data: unknown, opts: SecretScannerOptions = {}): { sanitized: unknown; hits: SensitiveHit[] } {
  const maxDepth = opts.maxDepth ?? 64;
  const cfg: Required<Pick<SecretScannerOptions, 'extraFieldNames' | 'extraReferenceFields' | 'valuePatterns' | 'highEntropy' | 'literalValueOnly'>> = {
    extraFieldNames: opts.extraFieldNames ?? [],
    extraReferenceFields: opts.extraReferenceFields ?? [],
    valuePatterns: opts.valuePatterns ?? true,
    highEntropy: opts.highEntropy ?? false,
    literalValueOnly: opts.literalValueOnly ?? false,
  };
  const hits: SensitiveHit[] = [];

  if (data === null || typeof data !== 'object') return { sanitized: data, hits };
  if (data instanceof Uint8Array) return { sanitized: data, hits };

  const rootOut: unknown = Array.isArray(data) ? [] : {};
  interface Frame { src: unknown; dst: unknown; path: string; depth: number }
  const stack: Frame[] = [{ src: data, dst: rootOut, path: '', depth: 1 }];
  const visited = new WeakSet<object>();
  visited.add(data as object);

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { src, dst, path, depth } = frame;
    if (depth > maxDepth) throw new JsonDepthError(`扫描深度 ${depth} 超过上限 ${maxDepth}`);
    if (src instanceof Uint8Array) continue;

    if (Array.isArray(src)) {
      const outArr = dst as unknown[];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        const childPath = `${path}[${i}]`;
        if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
          if (visited.has(v)) throw new Error(`检测到循环引用，无法扫描（路径 ${childPath}）`);
          visited.add(v);
          const childOut: unknown = Array.isArray(v) ? [] : {};
          outArr.push(childOut);
          stack.push({ src: v, dst: childOut, path: childPath, depth: depth + 1 });
        } else {
          outArr.push(v);
        }
      }
      continue;
    }

    const outObj = dst as Record<string, unknown>;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const childPath = path === '' ? k : `${path}.${k}`;
      if (typeof v === 'string') {
        if (judgeFieldValue(k, v, cfg)) {
          hits.push({ path: childPath, field: k });
          outObj[k] = REDACTED_PLACEHOLDER;
        } else {
          outObj[k] = v;
        }
        continue;
      }
      if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
        if (visited.has(v)) throw new Error(`检测到循环引用，无法扫描（路径 ${childPath}）`);
        visited.add(v);
        const childOut: unknown = Array.isArray(v) ? [] : {};
        outObj[k] = childOut;
        stack.push({ src: v, dst: childOut, path: childPath, depth: depth + 1 });
      } else {
        outObj[k] = v;
      }
    }
  }

  return { sanitized: rootOut, hits };
}

/* ---------------- 文本级扫描（scanText，文件类分区内容用） ---------------- */

const FIELD_VALUE_RE = [
  // "field": "value"（JSON 形态，保留引号）
  { re: /"([A-Za-z0-9_.\-]+)"\s*:\s*"([^"]*)"/g, json: true },
  // field=value
  { re: /([A-Za-z0-9_.\-]+)\s*=\s*([^\s,;]+)/g, json: false },
  // field: value
  { re: /([A-Za-z0-9_.\-]+)\s*:\s*([^\s,;}]+)/g, json: false },
] as const;

/** 文本级扫描：逐行找「敏感字段名 + 疑似真实字面量凭据」与「值形状」命中（只报告，不修改文本）。
 *  2026-08-20 优化：字段名命中不再是充分条件 —— 值必须是「非代码引用 / 非占位符 / 非类型词 /
 *  非短标识符」的字面量，消除技能/代码文档中 `token:`/`password:` 等示例命名的误报；
 *  2026-08-21 优化：值形状（sk-/ghp_/AKIA/JWT/PEM/Bearer）对示例/占位形态（含 your/example/
 *  xxx/test/<...> 等占位词）放行；混合字符串需像真实凭据（含数字/符号/大小写混合）才报告。 */
export function scanText(text: string, opts: SecretScannerOptions = {}): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  const extra = opts.extraFieldNames ?? [];
  const valuePatterns = opts.valuePatterns ?? true;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const linePath = `line:${i + 1}`;
    // 字段名形态
    for (const { re, json } of FIELD_VALUE_RE) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const field = m[1]!;
        const value = m[2]!;
        if (!isSensitiveFieldName(field, extra)) continue;
        // 值必须是「疑似字面量凭据」才报告（消除代码示例/占位符误报）
        if (!isLiteralSecretValue(value)) continue;
        hits.push({ path: linePath, field });
      }
    }
    // 值形状（字段名无关；整行 trim 后匹配 sk-/ghp_/JWT/PEM/Bearer 等强信号，示例形态已降噪）
    if (valuePatterns) {
      const trimmed = line.trim();
      const name = matchSecretValuePattern(trimmed);
      if (name !== null) hits.push({ path: linePath, field: `(${name})` });
    }
  }
  return hits;
}

/** 强化版 SecretScanner（对齐 core SecretScanner 契约，可注入 Exporter.scanner） */
export function createSecretScanner(opts: SecretScannerOptions = {}): SecretScanner {
  return {
    scanAndRedact(data: unknown): { sanitized: unknown; hits: SensitiveHit[] } {
      return scanAndRedact(data, opts);
    },
    scanText(text: string): SensitiveHit[] {
      return scanText(text, opts);
    },
  };
}
