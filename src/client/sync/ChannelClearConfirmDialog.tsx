/**
 * 「断开通道配置」确认弹窗（用户实测要求：同步通道一旦配置过就没有出口）。
 *
 * 为什么单独成文件：SyncPanel.tsx 有行数棘轮（拆分后的量级），而这段是**自包含**的
 * 「确认 → 调宿主 → 回执」流程；塞回装配层只会让它继续膨胀。
 *
 * 与宿主 `POST /sync/config { clear: true }` 一一对应，Host 一处清三项：
 *  ① sync-config 命名空间（活动通道自动回落到剩下的那条）；② 该通道在 DSH credentials 里的
 *  全部凭据（token / WebDAV 口令 / 加密·解密密码，值永不回传）；③ 该通道的自动同步开关。
 * **只解除本机绑定**：远端快照、本机备份、同步分区选择一律不动（删除远端数据是另一个动作）。
 *
 * 失败绝不静默：错误经 redact 后提示，弹窗保持打开（用户可重试或取消）；且**绝不把拒绝抛出去**
 * —— ConfirmDialog 用 `result.finally()` 收尾 onConfirm 的返回值，抛出的拒绝会变成
 * unhandled rejection（Node 下一个事件循环会打警告，浏览器只在控制台可见），用户什么也看不到。
 */
import type { TranslateNS } from '../client-types.ts'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Banner } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import type { SyncApi } from './sync-api.ts'
import { SYNC_CHANNEL_LABEL_KEY, type SyncChannel } from './sync-view.ts'

export function ChannelClearConfirmDialog({ open, channel, api, t, onCancel, onCleared }: {
  open: boolean
  channel: SyncChannel
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  onCancel: () => void
  /** 成功回调：调用方据此清表单残留、撤销在途自动保存并重拉 status（本组件不碰页面状态） */
  onCleared: () => void
}) {
  // 四个通道一律走穷尽映射（SYNC_CHANNEL_LABEL_KEY: Record<SyncChannel, SyncKey>）：
  // 此前写成「webdav ? webdav : git」，在 s3/gist 卡上点「断开配置」时，危险确认框与成功回执
  // 都会把该通道说成「Git 私有仓库」——用户会以为断错了通道而取消（或反之误判已断的通道）。
  const channelLabel = t(SYNC_CHANNEL_LABEL_KEY[channel])
  return (
    <ConfirmDialog
      open={open}
      danger
      title={t('channel.clearConfirmTitle')}
      message={t('channel.clearConfirmMessage', { channel: channelLabel })}
      confirmLabel={t('channel.clearConfirm')}
      cancelLabel={t('common.cancel')}
      onConfirm={async () => {
        try {
          await api.clearChannel(channel)
          toast.ok(t('toast.channelCleared', { channel: channelLabel }))
          onCleared()
        } catch (err) {
          toast.error(t('toast.channelClearFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
        }
      }}
      onCancel={onCancel}
    >
      {/* git 通道的令牌槽位**同时承载 GitHub 登录状态** —— 断开前必须说清楚，
          否则用户只会发现「登录入口不见了」，并误以为要重启 profile（真机用户报告）。 */}
      {channel === 'git' && <Banner kind="warn">{t('channel.clearGitSignOut')}</Banner>}
    </ConfirmDialog>
  )
}
