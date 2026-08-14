/**
 * 结构化日志（规范 §24）：LEVEL / 消息 / 可选元数据，带 redact 钩子。
 * Secret 值永不入日志：sink 前对 msg 做文本级掩码、对 meta 做字段名级掩码。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 敏感字段名黑名单（大小写不敏感；命中即掩码值，规范 §6 清单） */
export const SENSITIVE_FIELD_BLACKLIST = [
  'password', 'passwd', 'token', 'accesstoken', 'refreshtoken', 'apikey',
  'secret', 'credential', 'authorization', 'cookie', 'privatekey', 'clientsecret',
  'sessionkey', 'authtoken', 'bearer',
];

const REDACTED = '***REDACTED***';

/** 字段名是否命中敏感黑名单（大小写不敏感，子串匹配） */
export function isSensitiveField(field: string): boolean {
  const lower = field.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_FIELD_BLACKLIST.some((f) => lower.includes(f));
}

/** 对象级掩码：字段名命中黑名单 → 值替换（返回新对象，不改原对象） */
export function redactValue(value: unknown, blacklist: string[] = SENSITIVE_FIELD_BLACKLIST): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, blacklist));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    const hit = blacklist.some((f) => lower.includes(f));
    out[k] = hit ? REDACTED : redactValue(v, blacklist);
  }
  return out;
}

/** 文本级掩码：JSON 片段 `"field": "value"`、`field=value`、`field: value` 形态 */
export function redact(text: string, blacklist: string[] = SENSITIVE_FIELD_BLACKLIST): string {
  let out = text;
  for (const field of blacklist) {
    // "field": "anything"
    out = out.replace(new RegExp(`("${field}"\\s*:\\s*")[^"]*(")`, 'gi'), `$1${REDACTED}$2`);
    // field=value / field: value（不含 JSON 引号形态）
    out = out.replace(new RegExp(`(\\b${field}\\s*=\\s*)[^\\s,;]+`, 'gi'), `$1${REDACTED}`);
    out = out.replace(new RegExp(`(\\b${field}\\s*:\\s*)[^\\s,;}]+`, 'gi'), `$1${REDACTED}`);
  }
  return out;
}

export interface LogMeta { [key: string]: unknown }

export interface LogSink {
  (level: LogLevel, message: string, meta?: LogMeta): void;
}

export interface Logger {
  level: LogLevel;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 输出目标；缺省写 console（单行 JSON）。测试可注入内存 sink。 */
  sink?: LogSink;
  /** 额外敏感字段黑名单 */
  extraBlacklist?: string[];
  /** 是否带时间戳前缀 */
  timestamp?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 创建结构化日志器（默认 console JSON 行，全部输出过 redact） */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const blacklist = [...SENSITIVE_FIELD_BLACKLIST, ...(opts.extraBlacklist ?? [])];
  const sink: LogSink = opts.sink ?? ((lvl, message, meta) => {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(message, blacklist),
      ...(meta ? { meta: redactValue(meta, blacklist) } : {}),
    });
    // eslint-disable-next-line no-console
    (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
  });
  const emit = (lvl: LogLevel, message: string, meta?: LogMeta): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    try {
      sink(lvl, message, meta);
    } catch {
      // 日志器自身永不抛错
    }
  };
  return {
    level,
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

/** 静默日志器（测试用） */
export function nullLogger(): Logger {
  return {
    level: 'error',
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
