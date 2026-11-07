/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺；v2 第 5 步主文件改名 SyncPanel.tsx）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncPanel 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button, Card } from '../common/ui.tsx'
import { ExpandChevron } from '../common/Icon.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import type { SyncStatusResponse } from './sync-api.ts'
import type { SyncChannel } from './sync-view.ts'
import { formatSyncStatusTimestamp, formatSyncUrlPreview, workdirStateKey, workdirStateBadgeKind } from '../../ui/sync-settings-view.ts'
import { needsGitToken, SYNC_CHANNEL_LABEL_KEY } from './sync-view.ts'
import css from '../config-manager.module.css'

/** 同步通道入口卡：通道徽章 + 配置状态 + 状态事实行 + 打开配置弹窗 + 断开该通道配置。 */
export function SyncChannelEntryCard({ t, channel, statusInfo, remoteReady, repoUrl, webdavUrl, s3Endpoint, gistId, onOpen, onClear, expanded, contentId, onToggleExpanded }: {
  t: TranslateNS<'config-manager-sync'>
  channel: SyncChannel
  statusInfo: SyncStatusResponse | null
  remoteReady: boolean
  repoUrl: string
  webdavUrl: string
  /** s3 通道的端点（预览用；非密字段，可回显） */
  s3Endpoint: string
  /** gist 通道的 gist id（预览用；非密字段，可回显） */
  gistId: string
  onOpen: () => void
  /** 请求断开该通道（未配置时按钮不渲染）；确认与执行由壳层负责（本卡不发请求） */
  onClear: () => void
  /**
   * v3 §2.2-3：通道卡可折叠（4 个通道全展开远超 564×720 画布）。
   * 未配置的通道走矮态、没有可折叠内容 —— 调用方只在 remoteReady 时传这三个 prop。
   */
  expanded?: boolean
  /** 折叠体的 id（与 aria-controls 配对；由调用方给 Collapse 同一个 id） */
  contentId?: string
  onToggleExpanded?: () => void
}) {
  // issue #79：工作副本状态（git 专属）。只在**需要人管**的状态（仍指旧地址 / 读不出）挂徽章 ——
  // 「尚未创建」是首次同步前的正常态，不值得占一个徽章位；完整事实在展开区的「工作副本」卡里。
  const workdirKey = channel === 'git' ? workdirStateKey(statusInfo?.workDir) : null
  const workdirKind = workdirStateBadgeKind(workdirKey)
  const showWorkdirBadge = workdirKind === 'warn'
  /** 事实行里的「当前远端」预览：按通道取那个真正标识远端的字段（gist 用 id，没有 URL） */
  const previewRemote = channel === 'webdav'
    ? webdavUrl
    : channel === 's3'
      ? s3Endpoint
      : channel === 'gist'
        ? gistId
        : repoUrl
  return (
    <Card>
      {/* 单行通道头（2026-11-07，OpenDesign T1）：原先是「标题行 + 徽章行 + 远端事实格 +
          动作行」四段叠在一张卡里，四个通道占掉近半屏；通道头本身只需要回答三件事 ——
          这是哪条通道、配没配、指向哪个远端。三件事排一行，动作收到右端。 */}
      <div className={css.channelRow}>
        {onToggleExpanded !== undefined && (
          <button
            type="button"
            className={css.iconBtn}
            data-size="sm"
            aria-expanded={expanded === true}
            aria-controls={contentId}
            aria-label={expanded === true ? t('channel.collapse') : t('channel.expand')}
            title={expanded === true ? t('channel.collapse') : t('channel.expand')}
            onClick={onToggleExpanded}
          >
            <ExpandChevron open={expanded === true} size={14} />
          </button>
        )}
        <span className={css.channelName}>{t(SYNC_CHANNEL_LABEL_KEY[channel])}</span>
        <InfoHint text={t('channel.openHint')} label={t('common.infoHint')} />
        <Badge kind={remoteReady ? 'ok' : 'warn'}>
          {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
        </Badge>
        {/* 凭据类徽章：只有「已保存」时才挂（未配置令牌那条 ⚠ 保留，因为推送必失败） */}
        {channel === 'git' && statusInfo?.credentialConfigured === true && (
          <Badge kind="ok">{t('config.tokenSaved')}</Badge>
        )}
        {channel === 'git' && statusInfo?.credentialConfigured !== true
          && needsGitToken(statusInfo?.repoUrl ?? '') && (
          <Badge kind="warn">{t('config.tokenMissing')}</Badge>
        )}
        {channel === 'webdav' && statusInfo?.webdav?.passwordConfigured === true && (
          <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>
        )}
        {channel === 's3' && statusInfo?.s3?.secretStored === true && (
          <Badge kind="ok">{t('cloud.secretSaved')}</Badge>
        )}
        {channel === 'gist' && statusInfo?.gist?.secretStored === true && (
          <Badge kind="ok">{t('cloud.tokenSaved')}</Badge>
        )}
        {showWorkdirBadge && workdirKey !== null && workdirKind !== null && (
          <Badge kind={workdirKind}>{t(workdirKey)}</Badge>
        )}
        {/* 远端预览：未配置时留空位（不写「未配置」第二遍），已配置时中段省略。
            title 给全文 —— 行内只够放下 20 来个字符。 */}
        {remoteReady && (
          <span className={`${css.channelRemote} ${css.mono}`} title={previewRemote}>
            {formatSyncUrlPreview(previewRemote)}
          </span>
        )}
        <span className={css.statusSpacer} />
        {remoteReady && (
          <span className={css.channelLastSync}>
            {t('syncStatus.lastSync')} {formatSyncStatusTimestamp(statusInfo?.lastSyncAt)}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {t('channel.open')}
        </Button>
        {/* 断开出口：只有**配置过**的通道才渲染（未配置时这个按钮没有意义，也不该存在）。 */}
        {remoteReady && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('channel.clear')}
          </Button>
        )}
      </div>
    </Card>
  )
}
