/**
 * 「添加通道」入口卡 + 选通道弹窗（2026-11-14 用户要求改同步页结构）。
 *
 * 此前四条通道卡**恒显示**（未配置的走单行矮态），理由是「配置完 Git 回来找不到 WebDAV
 * 会被当成 bug」。用户明确要求反过来：页面只留**已配置**的通道卡，其余通道统统收进这一张
 * 卡，点开弹窗选通道、再进各自的配置弹窗。原来那条担心由这张卡承接 —— 只要还有未配置的
 * 通道，它就常驻在页面上，不是只在首次安装时冒一次。
 *
 * 为什么单独成文件：SyncPanel.tsx 有行数棘轮（≤1600 行），这里是一段自包含的
 * 「入口卡 + 选择弹窗」，与装配逻辑无关。
 */
import { useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Icon } from '../common/Icon.tsx'
import { Modal } from '../common/Modal.tsx'
import type { SyncChannel } from './sync-view.ts'
import { SYNC_CHANNEL_LABEL_KEY } from './sync-view.ts'
import type { SyncKey } from './sync-locales.ts'
import css from '../config-manager.module.css'

/** 每个通道一句话用途：只用通道实际支持的服务名，不写宣传语（names 与 WEBDAV_PRESETS / S3_PROVIDER_LABEL_KEY 一致） */
const PURPOSE_KEY: Record<SyncChannel, SyncKey> = {
  git: 'addChannel.git',
  webdav: 'addChannel.webdav',
  s3: 'addChannel.s3',
  gist: 'addChannel.gist',
}

export function AddChannelCard({ t, channels, onPick }: {
  t: TranslateNS<'config-manager-sync'>
  /** 尚未配置的通道（已配置的通道保留各自的卡片，不在这里出现） */
  channels: readonly SyncChannel[]
  /** 选中某个通道：由主文件切换当前通道并打开它的配置弹窗 */
  onPick: (channel: SyncChannel) => void
}) {
  const [open, setOpen] = useState(false)
  // 全部通道都配好了：没有可添的东西，不留一张点开是空列表的卡
  if (channels.length === 0) return null
  const pick = (channel: SyncChannel) => {
    setOpen(false)
    onPick(channel)
  }
  return (
    <>
      <button type="button" className={css.addChannelCard} onClick={() => { setOpen(true) }}>
        <Icon name="probe" size={14} />
        <span className={css.addChannelLabel}>{t('addChannel.title')}</span>
        <span className={css.addChannelHint}>{channels.map((c) => t(SYNC_CHANNEL_LABEL_KEY[c])).join(' / ')}</span>
      </button>
      <Modal open={open} onClose={() => { setOpen(false) }} title={t('addChannel.title')}>
        <Modal.Header title={t('addChannel.title')} onClose={() => { setOpen(false) }} closeLabel={t('common.close')} />
        <Modal.Body>
          <div className={css.channelPickList}>
            {channels.map((c) => (
              <button key={c} type="button" className={css.channelPickRow} onClick={() => { pick(c) }}>
                <span className={css.channelPickLabel}>{t(SYNC_CHANNEL_LABEL_KEY[c])}</span>
                <span className={css.channelPickDesc}>{t(PURPOSE_KEY[c])}</span>
              </button>
            ))}
          </div>
        </Modal.Body>
      </Modal>
    </>
  )
}
