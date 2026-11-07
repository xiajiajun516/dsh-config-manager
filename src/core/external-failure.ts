/**
 * 「本地可修」外部失败的标记（零依赖模块，host 侧 phase3 与 sync 侧共用）。
 *
 * 背景（真机 issue）：autosync 的 commit 失败只是因为**本机没配 git 身份**（exit 128），
 * 但 runExternalIntent 的 catch 无条件把插件升进 durable SAFE MODE —— 一个由本机配置
 * 直接修好的问题，被放大成「全部写入 423，直到手动解除阻断」。用户看到的还是
 * 「环境锁被占用」，而 locks 目录其实是空的：排查方向被彻底带偏。
 *
 * 判据只有一条：失败是否**只由本机配置/凭据决定、且能在本机直接修好**，且它不会
 * 使磁盘进入半写状态。这类失败收窄到该笔交易本身（journal → NEEDS_ATTENTION + 告警），
 * 不升全局阻断。其余一切无法据此证明的失败保持 fail-closed（照旧升 SAFE MODE）。
 *
 * 为什么不用 Error 子类判定：错误要跨模块边界（sync/git → core/phase3）且可能被包装，
 * 子类在 instanceof 上不可靠；这里用 Symbol.for 做**跨实例**标记，且 non-enumerable，
 * 不会被 JSON/日志序列化污染。
 */
const LOCAL_ONLY = Symbol.for('dsh-config-manager.externalFailure.localOnly')

interface LocalOnlyMark {
  /** 判据名（进日志/诊断文本，不含敏感值）。 */
  reason: string
}

/**
 * 给一个错误打上「本地可修」标记并原样返回（便于 `throw markLocalOnlyExternalFailure(err, 'git-identity')`）。
 * 同一个错误重复标记不报错（后写覆盖先写）。
 */
export function markLocalOnlyExternalFailure<T extends Error>(err: T, reason: string): T {
  try {
    Object.defineProperty(err, LOCAL_ONLY, {
      value: { reason } satisfies LocalOnlyMark,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    /* 冻结对象/宿主级 Error 子类：打不上标记就按「不可证明」处理（保持 fail-closed） */
  }
  return err
}

/** 读取标记（无标记/非对象 → null）。 */
export function localOnlyFailureReason(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const mark = (err as { [k: symbol]: unknown })[LOCAL_ONLY]
  if (typeof mark !== 'object' || mark === null) return null
  const reason = (mark as { reason?: unknown }).reason
  return typeof reason === 'string' && reason !== '' ? reason : null
}

/** 该失败是否只由本机可修的配置/凭据引起（true 才允许不升 SAFE MODE）。 */
export function isLocalOnlyExternalFailure(err: unknown): boolean {
  return localOnlyFailureReason(err) !== null
}
