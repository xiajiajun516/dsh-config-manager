/**
 * 结构化日志（规范 §24）：LEVEL / 消息 / 可选元数据，带 redact 钩子。
 * Secret 值永不入日志：**在交给 sink 之前**对 msg 与 meta 做**同一口径**的掩码（字段名级 +
 * 值形状级，见 security/redaction.ts）—— 默认 console sink 与注入的自定义 sink 都绕不过去。
 *
 * 敏感字段判定的**唯一口径**在 security 侧：`src/security/secret-scanner.ts` 的
 * `normalizeFieldName` + `isSensitiveFieldName`（规范化后做「精确名 / 敏感后缀 /
 * 敏感前缀」三级匹配）。文本级与对象级掩码统一复用 `src/security/redaction.ts`
 * （它的字段判定同样委托 secret-scanner，并额外覆盖 sk- / JWT / Bearer 等值形状）。
 *
 * 为什么必须委托：原实现自带第二份名单 + `toLowerCase().includes(...)` 子串近似判定，
 * `api_key` / `auth_header` 因不做分隔符归一而漏检，`pwd` / `passphrase` /
 * `authheader` 压根不在名单里 —— 宿主 `this.log.*`（默认 console sink）因此漏掩码，
 * 直接踩「日志全程脱敏」硬不变量。现在本文件**不保留任何名单、不保留近似实现**：
 * 名单或判定口径变更只需改 secret-scanner 一处，宿主日志与导出/同步脱敏自动同口径。
 */
import { isSensitiveFieldName, normalizeFieldName } from '../security/secret-scanner.ts';
import { redact as redactText, redactValue as redactMeta } from '../security/redaction.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 合法日志级别集合（`DSH_CONFIG_MANAGER_LOG_LEVEL` 的取值）。 */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * 解析日志级别字符串（大小写 / 前后空白不敏感）；未提供或不合法 → fallback（缺省 warn）。
 * 宿主入口用它解析 `DSH_CONFIG_MANAGER_LOG_LEVEL`：默认 warn —— 启动 dsh web 后控制台
 * 只保留 warn/error，常规 info（挂载横幅、调度器跳过、导出/备份完成）不再刷屏；
 * 排查时 `DSH_CONFIG_MANAGER_LOG_LEVEL=info`（或 debug）即可恢复逐条输出。
 */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'warn'): LogLevel {
  const value = raw?.trim().toLowerCase();
  return LOG_LEVELS.includes(value as LogLevel) ? (value as LogLevel) : fallback;
}

/** 附加字段名规范化：security 侧的 extra 参与「规范化精确命中」，故先按同一口径归一 */
function normalizeExtra(extra: readonly string[]): string[] {
  return extra.map(normalizeFieldName);
}

/** 字段名是否敏感：委托 security 侧唯一口径（`isSensitiveFieldName`）。
 *  保留导出仅为兼容既有引用；新代码直接用 secret-scanner 的实现。 */
export function isSensitiveField(field: string): boolean {
  return isSensitiveFieldName(field);
}

/**
 * 对象级掩码（**与文本级同口径**）：
 *  1) 字段名级：命中 security 名单的键 → 整值替换（返回新对象；结构与类型保留）；
 *  2) 值形状级：剩下的字符串叶子再过一遍文本掩码（sk- / JWT / AKIA / GitHub PAT / PEM /
 *     Bearer / URL query），覆盖「键名不敏感、值本身是密钥」的 meta（如 { note: 'sk-…' }）。
 * 顺序不能反：先按字段名整值替换，避免漏掉「键名命中但值不含任何形状」的键。
 * 不变式：凡是进 sink 的 meta 必须是本函数的产物（见 createLogger —— 注入的自定义 sink 同样如此）。
 * `extra` 为**附加**字段名（任意形态，内部按 security 口径规范化后精确命中）。
 */
export function redactValue(value: unknown, extra: readonly string[] = []): unknown {
  const extras = normalizeExtra(extra);
  return scanValueShapes(redactMeta(value, extras), extras);
}

/**
 * 值形状扫描（meta 专用）：只处理字符串叶子，二进制与原始类型原样透传（与 security 侧一致）。
 * 复用文本级 redact，因此 meta 与 msg 对同一内容是同一判定 —— 不再出现「msg 扫形状、meta 只扫键名」。
 */
function scanValueShapes(value: unknown, extras: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, extras);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((v) => scanValueShapes(v, extras));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scanValueShapes(v, extras);
  return out;
}

/** 文本级掩码：JSON 片段 `"field": "value"`、`field=value`、`field: value` 形态 +
 *  值形状（sk- / JWT / AKIA / GitHub PAT / PEM / Bearer / URL query），字段名按 security 口径判定。 */
export function redact(text: string, extra: readonly string[] = []): string {
  return redactText(text, normalizeExtra(extra));
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
  /** 额外敏感字段名（任意形态；按 security 口径规范化后精确命中） */
  extraBlacklist?: string[];
  /** 是否带时间戳前缀 */
  timestamp?: boolean;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * 默认 sink：**只做格式化，不做脱敏**（脱敏统一在 createLogger 的核心包装里完成）。
 * 这样「脱敏」只有一个入口，任何 sink 都绕不过去。
 */
const defaultConsoleSink: LogSink = (level, message, meta) => {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta === undefined ? {} : { meta }),
  });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
};

/** 创建结构化日志器（默认 console JSON 行；所有 sink 拿到的 msg/meta 都已脱敏） */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  // 附加名单同样走 security 口径（规范化），基础名单由 security 侧内置，不在本文件重复
  const extra = normalizeExtra(opts.extraBlacklist ?? []);
  const rawSink: LogSink = opts.sink ?? defaultConsoleSink;
  /**
   * **核心包装（脱敏的唯一入口）**：msg 与 meta 在交给任何 sink **之前**完成脱敏 ——
   * 包括注入的自定义 sink（宿主/审计文件 sink、测试内存 sink）。
   * 审计残留（t10/t26）：脱敏原来只写在默认 console sink 的闭包里，注入 sink 就能拿到明文；
   * 且 meta 过去只做字段名级掩码，与 msg 的值形状掩码不同口径。
   */
  const sink: LogSink = (lvl, message, meta) => rawSink(
    lvl,
    redact(message, extra),
    meta === undefined ? undefined : (redactValue(meta, extra) as LogMeta),
  );
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
