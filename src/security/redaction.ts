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
import { DEFAULT_SECRET_FIELD_NAMES, isSensitiveFieldName } from './secret-scanner.ts';

export const REDACTED = '***REDACTED***';

/* ---------------- 结构化字段形态 ---------------- */

const JSON_FIELD_RE = /"([A-Za-z0-9_.\-]+)"\s*:\s*"([^"]*)"/g;
/** kv 值到空白/逗号/分号/&（& 截断：避免吞掉 URL query 的后续参数） */
const KV_FIELD_RE = /([A-Za-z0-9_.\-]+)\s*=\s*([^\s,;&]+)/g;
/** colon 值允许空格（如 `Authorization: Bearer xyz`），到逗号/分号/右大括号截断 */
const COLON_FIELD_RE = /([A-Za-z0-9_.\-]+)\s*:\s*([^,;}]+)/g;

/* ---------------- 值形状模式（包含式，字段名无关） ---------------- */

const VALUE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{8,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'pem-private-key', re: /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----/g },
  { name: 'bearer-token', re: /Bearer [A-Za-z0-9._~+/=-]{8,}/g },
];

/** URL query 中的敏感参数值（保留参数名，只替换值） */
const URL_QUERY_RE = /([?&](?:token|api[_-]?key|key|secret|access[_-]?token|password|auth)=)([^&\s"']+)/gi;

/* ---------------- redact ---------------- */

function replaceSensitiveField(text: string, re: RegExp, blacklist: readonly string[]): string {
  return text.replace(re, (match: string, field: string, value: string) => {
    if (!isSensitiveFieldName(field, blacklist)) return match;
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
    return out;
  };
}

/** 默认名单（文档用；redact 的默认附加名单为空，内置判定已含 DEFAULT_SECRET_FIELD_NAMES） */
export { DEFAULT_SECRET_FIELD_NAMES };
