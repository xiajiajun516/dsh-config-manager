/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncSettingsView 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button, Card } from '../common/ui.tsx'
import type { SyncStatusResponse } from './sync-api.ts'
import type { SyncChannel } from './sync-view.ts'
import { formatSyncStatusTimestamp, formatSyncUrlPreview } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/** 同步通道入口卡：通道徽章 + 配置状态 + 状态事实行 + 打开配置弹窗。 */
export function SyncChannelEntryCard({ t, channel, statusInfo, remoteReady, repoUrl, webdavUrl, onOpen }: {
  t: TranslateNS<'config-manager-sync'>
  channel: SyncChannel
  statusInfo: SyncStatusResponse | null
  remoteReady: boolean
  repoUrl: string
  webdavUrl: string
  onOpen: () => void
}) {
  return (
    <Card>
      <span className={css.groupLabel}>{t('channel.title')}</span>
      <span className={css.hint}>{t('channel.openHint')}</span>
      <div className={css.statRow}>
        <Badge kind="info">{channel === 'webdav' ? t('channel.webdav') : t('channel.git')}</Badge>
        <Badge kind={remoteReady ? 'ok' : 'warn'}>
          {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
        </Badge>
        {channel === 'git' && statusInfo?.credentialConfigured === true && (
          <Badge kind="ok">{t('config.tokenSaved')}</Badge>
        )}
        {channel === 'webdav' && statusInfo?.webdav?.passwordConfigured === true && (
          <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>
        )}
      </div>
      {/* 状态事实行（Workbench：配置状态/上次同步/可同步分区——未配置时也要给硬事实） */}
      <div className={css.factGrid} style={{ marginTop: 8 }}>
        <div className={css.factCell}>
          <span className={css.factLabel}>{t('syncStatus.state')}</span>
          <span className={css.factValue}>
            {statusInfo?.configured === true ? t('channel.configured') : t('channel.notConfigured')}
          </span>
        </div>
        <div className={css.factCell}>
          <span className={css.factLabel}>{t('syncStatus.lastSync')}</span>
          <span className={css.factValue}>
            {formatSyncStatusTimestamp(statusInfo?.lastSyncAt)}
          </span>
        </div>
        {statusInfo?.sectionCount !== undefined && (
          <div className={css.factCell}>
            <span className={css.factLabel}>{t('syncStatus.sections')}</span>
            <span className={`${css.factValue} ${css.mono}`}>{String(statusInfo.sectionCount)}</span>
          </div>
        )}
        {remoteReady && (
          <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
            <span className={css.factLabel}>{t('channel.currentUrl')}</span>
            <span className={css.factValue}>
              <span className={css.mono}>
                {formatSyncUrlPreview(channel === 'webdav' ? webdavUrl : repoUrl)}
              </span>
            </span>
          </div>
        )}
      </div>
      <div className={css.actionRowTop}>
        <Button variant="primary" onClick={onOpen}>
          {t('channel.open')}
        </Button>
      </div>
    </Card>
  )
}
