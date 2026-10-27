/**
 * 「一键同步启动失败」的展示投影与上报（issue #116）。
 *
 * 为什么单独成模块：宿主的 `ok:false` 混着两类**完全不同**的结果 ——
 *  1. `reason === 'remote-empty'`：远端还没有任何快照。这是**首次同步的正常起点**，正确动作是「先推送」；
 *     旧实现把它渲染成红色「同步失败」，用户只会以为通道坏了（真机 issue #116）。
 *  2. 其它 `ok:false`：真的失败，原样展示宿主文案（经 redact）。
 * 规则与上报分离：`describePreviewFailure` 是纯函数（可逐条单测），`reportPreviewFailure` 只负责弹通知。
 */
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import type { TranslateNS } from '../client-types.ts'
import type { SyncStartResponse } from './sync-api.ts'

/** 本模块会读的响应字段（宿主 reason 目前只有 `'remote-empty'`）。 */
export type PreviewFailureInput = Pick<SyncStartResponse, 'reason' | 'message'>

/** tone = 通知等级：info（不是故障）与 error（真失败）在通道与停留时长上都不同。 */
export interface PreviewFailureView {
  level: 'info' | 'error'
  text: string
}

/**
 * 失败响应 → 展示投影。
 *
 * 不拼「同步失败」前缀到 info 分支：那句话是**引导**，加前缀会把它重新说成故障。
 */
export function describePreviewFailure(
  res: PreviewFailureInput,
  t: TranslateNS<'config-manager-sync'>,
): PreviewFailureView {
  if (res.reason === 'remote-empty') {
    return { level: 'info', text: t('syncflow.remoteEmptyGuide') }
  }
  return {
    level: 'error',
    text: t('toast.syncStartFailed') + t('common.labelSeparator') + redact(res.message ?? t('syncflow.syncFailed')),
  }
}

/** 投影 → 通知（info 3.2 s / error 6.4 s，见 toast-store 的 DEFAULT_DURATION_MS）。 */
export function reportPreviewFailure(res: PreviewFailureInput, t: TranslateNS<'config-manager-sync'>): void {
  const view = describePreviewFailure(res, t)
  if (view.level === 'info') { toast.info(view.text); return }
  toast.error(view.text)
}
