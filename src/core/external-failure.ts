/**
 * 「不升全局 SAFE MODE」的外部失败判据（零依赖模块，host 侧 phase3 与 sync 侧共用）。
 *
 * 背景（真机 issue）：
 *  1. autosync 的 commit 失败只是因为本机没配 git 身份（exit 128），但 runExternalIntent 的
 *     catch 无条件把插件升进 durable SAFE MODE（全部写入 423，直到手动解除阻断）；
 *  2. 一次断网 / 超时 / DNS / 5xx / 401 token 失效 / 通道熔断等纯传输层失败，同样不改本地盘面，
 *     也不该把插件锁成跨重启只读 —— 交由该笔 journal 落 NEEDS_ATTENTION + 告警，以及自动同步的
 *     连续失败计数与退避处理。
 *
 * 判据（两类且均要求不会使本机磁盘停在半写状态）：
 *  - localOnly：只由本机配置/凭据决定、能在本机直接修好（如 `git-identity`）；
 *  - retryableExternal：纯传输/远端瞬时或鉴权失败（`network`/`timeout`/`server`/`auth`/`config`/`circuit-open`）。
 * 其余一切无法据此证明性质的失败（半写、未知 IO、普通未标记 Error）保持 fail-closed（照旧升 SAFE MODE）。
 *
 * 为什么不用 Error 子类判定：错误要跨模块边界（sync/transport → core/phase3）且可能被包装，
 * 子类在 instanceof 上不可靠；这里用 Symbol.for 做**跨实例**标记，且 non-enumerable，
 * 不会被 JSON/日志序列化污染。
 */
const LOCAL_ONLY = Symbol.for('dsh-config-manager.externalFailure.localOnly')
const RETRYABLE_EXTERNAL = Symbol.for('dsh-config-manager.externalFailure.retryableExternal')

interface FailureMark {
  /** 判据名（进日志/诊断文本，不含敏感值）。 */
  reason: string
}

/** 允许不升全局 SAFE MODE 的可重试/外部传输失败判据集合。 */
export const NON_BLOCKING_EXTERNAL_REASONS: ReadonlySet<string> = new Set([
  'network',
  'timeout',
  'server',
  'auth',
  'config',
  'circuit-open',
])

function writeMark<T extends Error>(err: T, sym: symbol, reason: string): T {
  try {
    Object.defineProperty(err, sym, {
      value: { reason } satisfies FailureMark,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* 冻结对象/宿主级 Error 子类：打不上标记就按「不可证明」处理（保持 fail-closed） */
  }
  return err
}

function readMark(err: unknown, sym: symbol): string | null {
  if (typeof err !== 'object' || err === null) return null
  const mark = (err as { [k: symbol]: unknown })[sym]
  if (typeof mark !== 'object' || mark === null) return null
  const reason = (mark as { reason?: unknown }).reason
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/**
 * 给一个错误打上「本地可修」标记并原样返回（便于 `throw markLocalOnlyExternalFailure(err, 'git-identity')`）。
 * 同一个错误重复标记不报错（后写覆盖先写）。
 */
export function markLocalOnlyExternalFailure<T extends Error>(err: T, reason: string): T {
  return writeMark(err, LOCAL_ONLY, reason)
}

/** 读取「本地可修」标记（无标记/非对象 → null）。 */
export function localOnlyFailureReason(err: unknown): string | null {
  return readMark(err, LOCAL_ONLY)
}

/** 该失败是否只由本机可修的配置/凭据引起。 */
export function isLocalOnlyExternalFailure(err: unknown): boolean {
  return localOnlyFailureReason(err) !== null
}

/**
 * 给一个错误打上「可重试/非阻断外部失败」标记并原样返回（如 network / timeout / server / auth / circuit-open）。
 * 不符合 NON_BLOCKING_EXTERNAL_REASONS 的 reason 即使调用也不放行（默认 fail-closed）。
 */
export function markRetryableExternalFailure<T extends Error>(err: T, reason: string): T {
  if (!NON_BLOCKING_EXTERNAL_REASONS.has(reason)) return err
  return writeMark(err, RETRYABLE_EXTERNAL, reason)
}

/** 读取「可重试/非阻断外部失败」标记（仅允许白名单判据，否则 null）。 */
export function retryableExternalFailureReason(err: unknown): string | null {
  const reason = readMark(err, RETRYABLE_EXTERNAL)
  return reason !== null && NON_BLOCKING_EXTERNAL_REASONS.has(reason) ? reason : null
}

/** 该失败是否为明确标注的可重试/传输层外部失败。 */
export function isRetryableExternalFailure(err: unknown): boolean {
  return retryableExternalFailureReason(err) !== null
}

/**
 * phase3-host 统一判据：该外部失败是否证明不会破坏本机盘面且无需升全局 durable SAFE MODE。
 * 只有显式打过 localOnly 或白名单 retryableExternal 标记时才放行，其余一律 fail-closed。
 */
export function isNonBlockingExternalFailure(err: unknown): boolean {
  return isLocalOnlyExternalFailure(err) || isRetryableExternalFailure(err)
}
