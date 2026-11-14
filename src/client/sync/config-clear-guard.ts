/**
 * 断开通道时的时序守卫（纯函数 + 一个轮询等待；node 可测）。
 *
 * 真机缺陷 P9-5：断开流程 = 确认弹窗 → api.clearChannel(channel) → onChannelCleared 收尾。
 * 清空本身是确定成功的，但**在途的 saveConfig 取消不掉**：它的回执晚回来会把刚清空的
 * 表单值合并回来；宿主侧若 save 晚于 clear 到达，配置也会在宿主上回魂（宿主写配置是无锁读改写）。
 *
 * 两道闸（反方复核后收紧；原先还有一道「断开后没再编辑就补一次 clear」的自愈，实测会把用户
 * 随后保存成功的新配置连同凭据一起删掉，已删）：
 *  ① 断开前 prepareClear：取消防抖 → 丢弃排队载荷 → 等在途保存落定；超时**拒绝断开**（不制造假象）；
 *  ② 发请求前记下「断开世代」，回执回来时世代变了就整体丢弃，且不再碰保存队列（那已属于新保存）。
 */
import { DEFAULT_S3_PROVIDER } from '../../ui/sync-settings-view.ts'
import type { SyncChannel } from './sync-view.ts'

/** 等保存队列静默的上限：超时**拒绝断开**（宁可让用户重试，也不造「已断开」的假象）。 */
export const CLEAR_QUIESCENT_TIMEOUT_MS = 5000
/** 静默等待的轮询间隔。 */
export const CLEAR_QUIESCENT_POLL_MS = 100

/** 回执的发送世代 ≠ 当前世代 ⇒ 这次回执描述的是「已被断开的通道」，一个字段都不许写回。 */
export function shouldDiscardSaveResult(sendEpoch: number, currentEpoch: number): boolean {
  return sendEpoch !== currentEpoch
}

/**
 * 断开前的收尾：丢掉该通道还没发出去的输入（防抖 timer + 排队载荷），再等在途保存落定。
 * 超时抛错 ⇒ 调用方（确认弹窗）提示重试并保持打开，绝不带着在途 save 去 clear。
 */
export async function prepareClear(input: {
  cancelPendingSave: () => void
  /** 必须是 getter：保存队列在等待期间会被整体替换（saveQueueRef.current = ...），快照对象永远读到旧的 inFlight。 */
  isBusy: () => boolean
  busyMessage: string
  timeoutMs?: number
  pollMs?: number
}): Promise<void> {
  input.cancelPendingSave()
  if (!(await waitForQuiescence(input.isBusy, input))) throw new Error(input.busyMessage)
}

/**
 * 等 isBusy() 变 false（轮询，不改状态、不持有资源）。
 * @returns true = 已静默；false = 超时（调用方决定怎么处理；prepareClear 据此拒绝断开）
 */
export function waitForQuiescence(
  isBusy: () => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? CLEAR_QUIESCENT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? CLEAR_QUIESCENT_POLL_MS
  if (!isBusy()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (!isBusy()) { resolve(true); return }
      if (Date.now() >= deadline) { resolve(false); return }
      setTimeout(tick, pollMs)
    }
    setTimeout(tick, pollMs)
  })
}

/** 断开成功后要清掉的本机表单残留（只删该通道的地址 / 凭据输入；其他通道原样）。 */
export interface ClearedFormFields {
  repoUrl?: string
  token?: string
  webdavUrl?: string
  webdavUsername?: string
  webdavPassword?: string
  s3Provider?: string
  s3Endpoint?: string
  s3Region?: string
  s3Bucket?: string
  s3Prefix?: string
  s3AccessKeyId?: string
  s3PathStyle?: boolean
  s3Secret?: string
  gistId?: string
  gistApiBaseUrl?: string
  gistFilePrefix?: string
  gistToken?: string
}

/** 每通道的「清空后表单」映像（返回副本，调用方改了也不污染这张表）。 */
const CLEARED_FIELDS: Record<SyncChannel, ClearedFormFields> = {
  git: { repoUrl: '', token: '' },
  webdav: { webdavUrl: '', webdavUsername: '', webdavPassword: '' },
  s3: {
    s3Provider: DEFAULT_S3_PROVIDER, s3Endpoint: '', s3Region: '', s3Bucket: '', s3Prefix: '',
    s3AccessKeyId: '', s3PathStyle: false, s3Secret: '',
  },
  gist: { gistId: '', gistApiBaseUrl: '', gistFilePrefix: '', gistToken: '' },
}

export function clearedChannelFormFields(channel: SyncChannel): ClearedFormFields {
  return { ...CLEARED_FIELDS[channel] }
}
