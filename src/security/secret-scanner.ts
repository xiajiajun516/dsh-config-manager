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
 * 判环只看**当前路径的祖先链**（`ancestors`）——同一对象被两处引用（DAG）不是环，用全局 visited
 * 会把共享引用误判成循环引用并让整次导出失败；
 * 命中记录只含路径与字段名，**值永不外泄**。
 */
import { JsonDepthError } from '../utils/json.ts';
import type { SecretScanner, SensitiveHit } from '../core/types.ts';
import { securityMsg } from './messages.ts';

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
/** `bearer` 的**逐位**大小写类：等价于给 scheme 加 `i`，又不污染 token 侧的大小写判定
 *  （给整条正则加 `i` 会让 `(?=[…]*[A-Z])` 与 `[a-z]` 两个 lookahead 互相等价 → 判定失效）。 */
const BEARER_SCHEME_ANY_CASE = '[Bb][Ee][Aa][Rr][Ee][Rr]';
/** Bearer token 的字符集（与下面 `bearer-token` 那条**同一集合**，不扩大） */
const BEARER_TOKEN_CHARS = '[A-Za-z0-9._~+/=-]';
/**
 * Bearer 形态的**大小写不敏感**补充（t72 / t58-F1）。RFC 7235 / 6750 规定 auth-scheme 名
 * **大小写不敏感**，所以 `bearer` / `BEARER` / `BeArEr` 都是合法且真实的授权头写法，必须剥离。
 *
 * 判定边界（**防英文散文过剥**，这是本条的取舍核心）：token 需至少满足其一 ——
 *   ① 含非字母字符（数字或 `. _ ~ + / = -`）；② **大小写混排**；③ 长度 ≥ 24。
 * 于是 `bearer credentials are required` / `bearer authentication failed` / `BEARER HEADER NOT SET`
 * 这类纯小写或纯大写的英文词**不命中**；而 `bearer abc12345`、`BEARER AbCdEfGh`、`bearer <24+ 字符>` 命中。
 *
 * 已知残余（登记在 `docs/spec/known-gaps.md` G-36）：scheme 用非规范大小写**且** token 是 8–23 个**纯字母、
 * 单一大小写**时本条不命中；规范 `Bearer …` 形态不受此限（上面那条 `bearer-token` 只要求 8+ 字符，行为不变）。
 */
const BEARER_TOKEN_ANY_CASE = new RegExp(
  BEARER_SCHEME_ANY_CASE +
    '\\s+(?:' +
    '(?=' + BEARER_TOKEN_CHARS + '*[0-9._~+/=-])' + BEARER_TOKEN_CHARS + '{8,}' + // ① 含非字母
    '|(?=' + BEARER_TOKEN_CHARS + '*[A-Z])(?=' + BEARER_TOKEN_CHARS + '*[a-z])' + BEARER_TOKEN_CHARS + '{8,}' + // ② 大小写混排
    '|' + BEARER_TOKEN_CHARS + '{24,}' + // ③ 超长（≥24；散文词几乎不可能）
    ')',
);

/**
 * 前缀型模式的**误剥边界**（t83）：修既有过剥 —— `task-management` / `risk-assessment` / `disk-space-report`
 * 这类**正常内容**里的词会命中 `sk-` 模式（`sk-management` / `sk-assessment` / `sk-space-report`），而
 * `src/utils/logger.ts` 日志脱敏、core 导出导入的字段值扫描、界面 `redact()` **三条通道共用本表** ⇒
 * 误剥 = **静默改写用户内容**（实测 `redact('risk-assessment')` → `ri***REDACTED***`），属数据保真问题。
 * 取证（误剥表 / 过剥侧 / redact 侧三段原始输出）：`outputs/bug-audit/fix-wordboundary/`。
 *
 * **为什么 `sk-` 用「载荷形状守卫」而不是左边界 `(?<![A-Za-z0-9])`**：左边界会连带漏剥 t18/t40-b 实测的
 * **真实**形态 `'p'.repeat(10000) + 'sk-…'`（密钥紧贴长串之后）—— 漏剥 = 明文进包，代价高于词误剥。
 * 载荷守卫两者兼得：`sk-` 后若是「1–24 个纯小写字母/连字符」= 英文词/标识符形态 → 放行；真实 `sk-` 密钥的
 * 载荷必然含数字或大写（OpenAI 形态 `sk-` + 40+ 位 base62），且 ≥25 位纯小写载荷也仍然命中（见下）。
 * 残余（如实登记）：`sk-` + ≤24 个纯小写字母/连字符（无数字、无大写）不再命中 —— 即「载荷形状像词」的边界。
 *
 * **逐个模式判断，不一刀切**（其余三条不加工，各有实测理由）：
 *  - `aws-access-key`（`AKIA…`）/ `github-token`（`gh[pousr]_…`）/ `github-pat`（`github_pat_…`）：**不加边界**。
 *    ① 自然语言/标识符里**不存在**这些字面前缀（词里不会出现 `AKIA`/`ghp_`/`github_pat_`），无词误剥可修；
 *    ② 加左边界会与 `sk-` 同样削弱「长串内嵌」检出（t40-b/t40-c 的 `longPad` 形态对它们是同类风险）；
 *    ③ 实测「前邻字母数字」的命中（`xAKIA0123456789ABCDEF`、`xghp_…`）只能由**人为拼接**造出，不是正常内容。
 *  - `jwt`（`eyJ…`）：**不加**。它需要三段 base64 且以 `.` 分隔，普通词触发不了 ⇒ 加边界换不来收益，
 *    反而会让「紧贴字母的真 JWT」漏检（如两段 JWT 相连）。
 *  - `pem-private-key`：**不加**。形态是 `-----BEGIN … PRIVATE KEY-----`，普通词无法触发。
 *  - `bearer-token` / `bearer-token-anycase`：**不加**。scheme 是自然语言词，过剥已由 t72 的 token 侧三道
 *    guards 处理（`bearer credentials are required` 不命中）；且 t72 的验收要求规范形态 `Bearer …` 行为**逐字不变**。
 *
 * 保守性核对（不得削弱真检测）：`token=sk-…` / `"key":"sk-…"` / `apikey=sk-…` / `MY_sk-…` / `x-sk-…` /
 * `'p'.repeat(10000) + 'sk-…'` / `sk-proj-…` / `sk-ant-api03-…` **全部仍命中**（见 `t83-b` / `t83-f`）。
 */
export const SECRET_VALUE_PATTERNS: readonly ValuePattern[] = [
  { name: 'openai-style-key', re: /sk-(?![a-z-]{1,24}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  // 规范形态 `Bearer …`（大小写敏感；行为与历史逐字一致）。**必须排在下面那条之前**：
  // 命中顺序决定返回的模式名 ⇒ 规范形态恒回 'bearer-token'（既有断言与既有文案依赖它）。
  { name: 'bearer-token', re: /Bearer [A-Za-z0-9._~+/=-]{8,}/ },
  { name: 'bearer-token-anycase', re: BEARER_TOKEN_ANY_CASE },
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

function matchSecretValuePatternHit(
  value: string,
  extraPatterns: readonly ValuePattern[] = [],
): ValuePatternHit | null {
  // 默认内置模式优先，个人化附加模式其次（返回的模式名语义以内置为准，附加模式不抢占）
  for (const p of SECRET_VALUE_PATTERNS) {
    const m = p.re.exec(value);
    if (m !== null) return { name: p.name, matched: m[0] };
  }
  for (const p of extraPatterns) {
    const m = p.re.exec(value);
    if (m !== null) return { name: p.name, matched: m[0] };
  }
  return null;
}

/** 值是否命中强模式 secret 形状（示例/占位形态 → null；返回命中模式名；未命中返回 null）。
 *  extraPatterns 为可选的个人化附加值形状模式（与 SECRET_VALUE_PATTERNS 合并判定，默认内置优先）；
 *  单参调用行为与历史完全一致（向后兼容）。 */
export function matchSecretValuePattern(
  value: string,
  extraPatterns: readonly ValuePattern[] = [],
): string | null {
  const hit = matchSecretValuePatternHit(value, extraPatterns);
  if (hit === null) return null;
  if (isExampleSecretShape(hit.matched)) return null;
  return hit.name;
}

export interface SecretScannerOptions {
  /** 附加敏感字段名（任意原始形态，内部会规范化） */
  extraFieldNames?: string[];
  /** 附加引用字段名（规范化后精确命中即豁免） */
  extraReferenceFields?: string[];
  /**
   * 附加值形状强模式（个人化规则，如昵称/用户名格式；与 SECRET_VALUE_PATTERNS 合并参与值形状判定，
   * 默认内置模式优先；示例/占位形态同样降噪放行）。来自部署配置 personalPatterns，不进开源代码。
   */
  extraValuePatterns?: ValuePattern[];
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
 *  `authToken: string`、`password: process.env.X`、`token: data.token` 等代码示例误报。
 *  extraPatterns 为个人化附加值形状模式，与内置模式一同参与「值形状强信号」判定。 */
function isLiteralSecretValue(value: string, extraPatterns: readonly ValuePattern[] = []): boolean {
  if (value === '') return false;
  // 值形状强信号（sk- / ghp_ / AKIA / JWT / PEM / Bearer / 个人化附加形状，示例/占位形态已降噪）—— 任何字段都视为真凭据
  if (matchSecretValuePattern(value, extraPatterns) !== null) return true;
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
function judgeFieldValue(field: string, value: string, opts: Required<Pick<SecretScannerOptions, 'extraFieldNames' | 'extraReferenceFields' | 'extraValuePatterns' | 'valuePatterns' | 'highEntropy' | 'literalValueOnly'>>): boolean {
  if (value === '') return false;
  if (opts.literalValueOnly) {
    // 宽松档（市场发布扫描）：值形状强信号字段无关必拦；字段名敏感 + 值像真实字面量凭据才拦
    if (opts.valuePatterns && matchSecretValuePattern(value, opts.extraValuePatterns) !== null) return true;
    if (isSensitiveFieldName(field, opts.extraFieldNames) && isLiteralSecretValue(value, opts.extraValuePatterns)) return true;
    return false;
  }
  // 保守档（导出/同步脱敏）：值形状优先 → 引用字段/env 名豁免 → 字段名敏感即剥
  if (opts.valuePatterns && matchSecretValuePattern(value, opts.extraValuePatterns) !== null) return true;
  if (isReferenceField(field, opts.extraReferenceFields)) return false;
  if (isEnvVarName(value)) return false; // 值是 env 变量名 → 引用
  if (isSensitiveFieldName(field, opts.extraFieldNames)) return true;
  if (opts.highEntropy && isHighEntropySecret(value)) return true;
  return false;
}

/** 递归扫描 + 剥离（纯函数，不改原数据；深度保护；返回清洗后数据与命中清单） */
export function scanAndRedact(data: unknown, opts: SecretScannerOptions = {}): { sanitized: unknown; hits: SensitiveHit[] } {
  const maxDepth = opts.maxDepth ?? 64;
  const cfg: Required<Pick<SecretScannerOptions, 'extraFieldNames' | 'extraReferenceFields' | 'extraValuePatterns' | 'valuePatterns' | 'highEntropy' | 'literalValueOnly'>> = {
    extraFieldNames: opts.extraFieldNames ?? [],
    extraReferenceFields: opts.extraReferenceFields ?? [],
    extraValuePatterns: opts.extraValuePatterns ?? [],
    valuePatterns: opts.valuePatterns ?? true,
    highEntropy: opts.highEntropy ?? false,
    literalValueOnly: opts.literalValueOnly ?? false,
  };
  const hits: SensitiveHit[] = [];

  if (data === null || typeof data !== 'object') return { sanitized: data, hits };
  if (data instanceof Uint8Array) return { sanitized: data, hits };

  const rootOut: unknown = Array.isArray(data) ? [] : {};
  // 判环判据 = **当前路径的祖先链**，绝不是「本次扫描见过的对象集合」：settings 的 value/base 共享
  // 未覆盖的嵌套分组、providers 的多 route 共享 raw 等 DAG 形态都是合法数据，全局 visited 会把它们
  // 误判成「检测到循环引用」并让整次导出/同步失败（用户上报 2026-10-09：备份失败 → intent journal
  // 记 NEEDS_ATTENTION + durable SAFE MODE）。祖先链只回答「它是不是它自己的祖先」。
  interface Frame { src: unknown; dst: unknown; path: string; depth: number; ancestors: ReadonlySet<object> }
  const stack: Frame[] = [{ src: data, dst: rootOut, path: '', depth: 1, ancestors: new Set<object>([data as object]) }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { src, dst, path, depth, ancestors } = frame;
    if (depth > maxDepth) throw new JsonDepthError(securityMsg('security.scanDepthExceeded', { depth, max: maxDepth }));
    if (src instanceof Uint8Array) continue;

    if (Array.isArray(src)) {
      const outArr = dst as unknown[];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        const childPath = `${path}[${i}]`;
        if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
          if (ancestors.has(v)) throw new Error(securityMsg('security.circularReference', { path: childPath }));
          const childAncestors = new Set(ancestors);
          childAncestors.add(v);
          const childOut: unknown = Array.isArray(v) ? [] : {};
          outArr.push(childOut);
          stack.push({ src: v, dst: childOut, path: childPath, depth: depth + 1, ancestors: childAncestors });
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
        if (ancestors.has(v)) throw new Error(securityMsg('security.circularReference', { path: childPath }));
        const childAncestors = new Set(ancestors);
        childAncestors.add(v);
        const childOut: unknown = Array.isArray(v) ? [] : {};
        outObj[k] = childOut;
        stack.push({ src: v, dst: childOut, path: childPath, depth: depth + 1, ancestors: childAncestors });
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
  const extraPatterns = opts.extraValuePatterns ?? [];
  const valuePatterns = opts.valuePatterns ?? true;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const linePath = `line:${i + 1}`;
    // 字段名形态
    for (const { re } of FIELD_VALUE_RE) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const field = m[1]!;
        const value = m[2]!;
        if (!isSensitiveFieldName(field, extra)) continue;
        // 值必须是「疑似字面量凭据」才报告（消除代码示例/占位符误报）
        if (!isLiteralSecretValue(value, extraPatterns)) continue;
        hits.push({ path: linePath, field });
      }
    }
    // 值形状（字段名无关；整行 trim 后匹配 sk-/ghp_/JWT/PEM/Bearer 及个人化附加形状等强信号，示例形态已降噪）
    if (valuePatterns) {
      const trimmed = line.trim();
      const name = matchSecretValuePattern(trimmed, extraPatterns);
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

/**
 * 部署配置（F2 个人隐私规则注入，对齐 dsh-packer config.personalPatterns 设计）：
 * 通用隐私规则开源内置（DEFAULT_SECRET_FIELD_NAMES / SECRET_VALUE_PATTERNS 等），
 * 个人化规则（昵称/用户名等）由部署者注入，不进开源代码。
 */
export interface ConfiguredSecretPatterns {
  /** 附加敏感字段名（个人账号/昵称等字段） */
  extraFieldNames?: string[];
  /** 附加引用字段名（值只是名字，如引用环境变量名的个人字段） */
  extraReferenceFields?: string[];
  /** 附加值形状强模式（个人昵称/用户名等一眼可辨格式） */
  extraValuePatterns?: ValuePattern[];
}

/** 从部署配置构造扫描器；未配置（undefined 或全部为空）时返回默认 createSecretScanner()，
 *  行为与默认完全一致。配置了个人化规则时将其作为附加字段名 / 引用字段 / 值形状模式合并进扫描器。 */
export function createConfiguredSecretScanner(
  patterns: ConfiguredSecretPatterns | undefined,
): SecretScanner {
  if (patterns === undefined) return createSecretScanner();
  const isEmpty =
    (patterns.extraFieldNames?.length ?? 0) === 0 &&
    (patterns.extraReferenceFields?.length ?? 0) === 0 &&
    (patterns.extraValuePatterns?.length ?? 0) === 0;
  if (isEmpty) return createSecretScanner();
  return createSecretScanner({
    extraFieldNames: patterns.extraFieldNames,
    extraReferenceFields: patterns.extraReferenceFields,
    extraValuePatterns: patterns.extraValuePatterns,
  });
}
