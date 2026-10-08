/**
 * 日志/文本脱敏（规范 §24 / 设计 §9.8 / core utils/logger.ts 的强化层）。
 *
 * 与 core logger.redact 的分工：core 版按固定字段名单做子串替换（不感知字段边界）；
 * 本模块为强化版，两模式：
 *  1. **结构化字段形态**：JSON `"field": "value"` / `field=value` / `field: value`，
 *     字段名命中敏感名单（复用 secret-scanner 的 `isSensitiveFieldName`，单一来源防漂移）→ 值替换。
 *  2. **值形状模式**：与字段名无关，文本任意位置出现 sk- / JWT / AKIA / GitHub PAT /
 *     PEM 私钥 / Bearer / URL query 的敏感参数值 → 替换。
 *
 * 幂等性：替换产物 `***REDACTED***` 不匹配任何模式，重复 redact 结果不变；
 * JSON 行的引号结构保留（输出仍是合法 JSON）。
 */
import { DEFAULT_SECRET_FIELD_NAMES, isSensitiveFieldName, SECRET_VALUE_PATTERNS } from './secret-scanner.ts';

export const REDACTED = '***REDACTED***';

/* ---------------- 结构化字段形态 ---------------- */

const JSON_FIELD_RE = /"([A-Za-z0-9_.\-]+)"\s*:\s*"([^"]*)"/g;
/** kv 值到空白/逗号/分号/&（& 截断：避免吞掉 URL query 的后续参数） */
const KV_FIELD_RE = /([A-Za-z0-9_.\-]+)\s*=\s*([^\s,;&]+)/g;
/** colon 值允许空格（如 `Authorization: Bearer xyz`），到逗号/分号/右大括号截断 */
const COLON_FIELD_RE = /([A-Za-z0-9_.\-]+)\s*:\s*([^,;}]+)/g;

/* ---------------- 值形状模式（包含式，字段名无关） ---------------- */

/**
 * 显示层**额外**的 PEM 头（**superset**，t78）。
 *
 * 为什么只留这一条本地规则：scanner 的 `pem-private-key` 只认算法标签白名单
 * （`RSA` / `EC` / `OPENSSH` / `DSA` / `ENCRYPTED`），而**显示层掩码**宁可多掩 ——
 * `-----BEGIN FOO PRIVATE KEY-----`（自定义/异体标签，OpenSSL 允许）在日志里同样是私钥头，
 * 放行才是泄漏。它只会**放宽**判定（scanner 命中的它必然命中），因此不构成第二份漂移源。
 */
const GENERIC_PEM_HEADER_RE = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----/g;

/**
 * 值形状模式（**单一来源**，G-36 残余 ③ 于 t78 收口）：
 * 表内容 = `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（**同一份**，含 t72 的
 * `bearer-token-anycase`），本模块只做两件不改语义的事：① 复制成**带 `/g`** 的新实例
 * （replace 需要 `/g`；新实例也避免共享正则的 lastIndex 跨调用泄漏）；
 * ② 追加上面那条**只放宽**的通用 PEM 头。
 *
 * 于是本条修正了「两份独立表会持续漂移」（本队已多次抓到的「同一语义两套实现」）：
 * scanner 侧新增/收窄形状时，redact() 自动跟随（漂移守卫见 `redaction.test.ts` 的 t78 组）。
 */
export const REDACTION_VALUE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  ...SECRET_VALUE_PATTERNS.map((p) => ({ name: p.name, re: new RegExp(p.re.source, 'g') })),
  { name: 'pem-private-key-generic', re: GENERIC_PEM_HEADER_RE },
];
const VALUE_PATTERNS = REDACTION_VALUE_PATTERNS;

/** URL query 中的敏感参数值（保留参数名，只替换值） */
const URL_QUERY_RE = /([?&](?:token|api[_-]?key|key|secret|access[_-]?token|password|auth)=)([^&\s"']+)/gi;

/**
 * URL **内嵌凭据**（\`scheme://user:password@host\`，GitLab/Gitea 常见的 \`https://oauth2:<token>@…\`）。
 *
 * 为什么必须补这一条：URL_QUERY_RE 只认 query 参数，而 userinfo 形态的凭据此前在**三条通道**
 * 都不被掩码 —— 日志、界面渲染、以及 sessionStorage 落盘（run-store 的 \`redactPersistedValue\`）。
 * 宿主侧 sync-config 的 validateRepoUrl/validateWebDavUrl 本来就拒绝带 userinfo 的地址，
 * 所以这里只影响「掩码」：不改任何合法输入的行为，只让非法规格里的凭据不再明文可见。
 * 只替换密码段（用户名保留可读），与 URL_QUERY_RE 的取舍一致。
 */
const URL_USERINFO_RE = /(\/\/[^\/@\s:]+:)([^\/@\s]+)(@)/g;

/* ---------------- 高熵长 token（journal / 迁移历史强脱敏共用） ---------------- */

/** 高熵值形状（长 hex/base64/随机 id）：结构化 redact() 覆盖不了任意 secret，journal / 迁移
 *  历史级强脱敏补挡。
 *
 *  ⚠️ 带 `/g`：当前唯一用法是 `text.replace(re, cb)`（`String.replace` 内部会重置 lastIndex）。
 *  **不得改用 `re.test(run)` 做判定** —— `/g` 正则的 lastIndex 会跨调用泄漏，同一 token 会时而
 *  命中时而漏（漏 = 明文落盘）。确需独立判定时用 `new RegExp(re.source)`（无 `/g`）。 */
const HIGH_ENTROPY_RE = /([A-Za-z0-9+/_=-]{28,})/g;

/** 结构化时间戳/文件名形态：日期段必须由连字符连接（ISO 日期 YYYY-MM-DD 或紧凑时间戳
 *  YYYYMMDD-HHMMSS）。连字符不存在于 hex/base64 token 中，豁免不会误放行随机密钥。 */
const DATE_STAMP_RE = /\d{4}-\d{2}-\d{2}|\d{8}-\d{6}/;

/** 高熵长 token 掩码（日期戳形态豁免；回调逐个 run 判定，避免误伤文件名/时间戳）。 */
export function maskHighEntropy(text: string): string {
  return text.replace(HIGH_ENTROPY_RE, (run) => (DATE_STAMP_RE.test(run) ? run : '[REDACTED]'));
}

/* ---------------- redact ---------------- */

/**
 * 字段名 → 是否敏感（**含「嵌在更长字段名里」的形态**）。
 *
 * 为什么需要（验收 F7）：`leak-apiKey` 这类字段名整体判定不是敏感名，于是值原样出现。
 * 做法是按分隔符与驼峰边界切段（`leak` + `api` + `Key`），再判定「单段」与「相邻两段拼接」
 * （`api`+`Key` = `apiKey` 命中）—— 宁可多掩一个（只是显示损失），也不放行一个真密钥（那是泄漏）。
 */
function fieldLooksSensitive(field: string, blacklist: readonly string[]): boolean {
  if (isSensitiveFieldName(field, blacklist)) return true
  // 驼峰切分：apiKey → ['api', 'Key']，单段都不敏感，所以还要看**相邻段的组合**（api+Key → apiKey 命中）。
  const parts = field.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')
  const segments = parts.flatMap((part) => part.split(/[^A-Za-z0-9]+/)).filter((segment) => segment !== '')
  if (segments.some((segment) => isSensitiveFieldName(segment, blacklist))) return true
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (isSensitiveFieldName(segments[i]! + segments[i + 1]!, blacklist)) return true
  }
  return false
}

function replaceSensitiveField(text: string, re: RegExp, blacklist: readonly string[]): string {
  return text.replace(re, (match: string, field: string, value: string) => {
    if (!fieldLooksSensitive(field, blacklist)) return match;
    if (value === '') return match;
    // 只替换值部分，保留原分隔符与引号形态（JSON `"f": "v"` / kv `f=v` / colon `f: v`）
    const idx = match.lastIndexOf(value);
    return match.slice(0, idx) + REDACTED + match.slice(idx + value.length);
  });
}

/**
 * 文本脱敏（幂等）。blacklist 为**附加**规范化字段名（小写无分隔符，如 'clientsecret'）。
 * 输出仍保留结构化形态（JSON 行合法）。
 */
export function redact(text: string, blacklist: readonly string[] = []): string {
  let out = text;
  // 1. 结构化字段形态（顺序：JSON → kv → colon；JSON 键不会被后续形态二次命中）
  out = replaceSensitiveField(out, JSON_FIELD_RE, blacklist);
  out = replaceSensitiveField(out, KV_FIELD_RE, blacklist);
  out = replaceSensitiveField(out, COLON_FIELD_RE, blacklist);
  // 2. 值形状模式（字段名无关，包含式）
  for (const { re } of VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  out = out.replace(URL_QUERY_RE, `$1${REDACTED}`);
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}$3`);
  return out;
}

/** 对象级掩码：字段名命中敏感名单 → 整值替换（返回新对象，不改原对象；结构与类型保留） */
export function redactValue(value: unknown, blacklist: readonly string[] = []): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, blacklist));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveFieldName(k, blacklist) ? REDACTED : redactValue(v, blacklist);
  }
  return out;
}

/** 预编译脱敏器（多次调用复用；blacklist 为附加规范化字段名） */
export function createRedactor(blacklist: readonly string[] = []): (text: string) => string {
  const compiled = { json: JSON_FIELD_RE, kv: KV_FIELD_RE, colon: COLON_FIELD_RE };
  return (text: string): string => {
    let out = replaceSensitiveField(text, new RegExp(compiled.json.source, 'g'), blacklist);
    out = replaceSensitiveField(out, new RegExp(compiled.kv.source, 'g'), blacklist);
    out = replaceSensitiveField(out, new RegExp(compiled.colon.source, 'g'), blacklist);
    for (const { re } of VALUE_PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
    out = out.replace(URL_QUERY_RE, `$1${REDACTED}`);
    out = out.replace(URL_USERINFO_RE, `$1${REDACTED}$3`);
    return out;
  };
}

/** 默认名单（文档用；redact 的默认附加名单为空，内置判定已含 DEFAULT_SECRET_FIELD_NAMES） */
export { DEFAULT_SECRET_FIELD_NAMES };
