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
      <span className={css.groupLabel}>{t('channel.title')} <InfoHint text={t('channel.openHint')} label={t('common.infoHint')} /></span>
      <div className={css.statRow}>
        <Badge kind="info">{t(SYNC_CHANNEL_LABEL_KEY[channel])}</Badge>
        <Badge kind={remoteReady ? 'ok' : 'warn'}>
          {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
        </Badge>
        {channel === 'git' && statusInfo?.credentialConfigured === true && (
          <Badge kind="ok">{t('config.tokenSaved')}</Badge>
        )}
        {/* 未配置令牌：拉取公开仓库仍可匿名成功，推送必失败（真机 128「Invalid username or token」）——
            在点推送之前就说清楚，别让用户先把错误撞一遍。仅 http(s) 远端提示（本地/ssh 不需要令牌）。 */}
        {channel === 'git' && statusInfo?.credentialConfigured !== true
          && needsGitToken(statusInfo?.repoUrl ?? '') && (
          <Badge kind="warn">{t('config.tokenMissing')}</Badge>
        )}
        {channel === 'webdav' && statusInfo?.webdav?.passwordConfigured === true && (
          <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>
        )}
        {/* 云端点通道：只回 secretStored 布尔（密钥值永不回传），据此显示「已保存」徽章 */}
        {channel === 's3' && statusInfo?.s3?.secretStored === true && (
          <Badge kind="ok">{t('cloud.secretSaved')}</Badge>
        )}
        {channel === 'gist' && statusInfo?.gist?.secretStored === true && (
          <Badge kind="ok">{t('cloud.tokenSaved')}</Badge>
        )}
        {/* issue #79：改仓库地址后工作副本仍指旧地址（下一轮同步会自动重指向）—— 在卡上直接可见 */}
        {showWorkdirBadge && workdirKey !== null && workdirKind !== null && (
          <Badge kind={workdirKind}>{t(workdirKey)}</Badge>
        )}
      </div>
      {/* 状态事实行（Workbench：配置状态/上次同步/可同步分区——未配置时也要给硬事实） */}
      <div className={css.factGrid} style={{ marginTop: 8 }}>
        <div className={css.factCell}>
          <span className={css.factLabel}>{t('syncStatus.state')}</span>
          <span className={css.factValue}>
            {/* 判据必须与徽章同源（本卡自己的 remoteReady）：statusInfo.configured 是**全局**语义
                （任一通道配置过即为 true），照它渲染会让「只配了 git」时另外三张卡同时出现
                「未配置」徽章 +「已配置」事实行。 */}
            {remoteReady ? t('channel.configured') : t('channel.notConfigured')}
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
                {formatSyncUrlPreview(previewRemote)}
              </span>
            </span>
          </div>
        )}
      </div>
      <div className={css.actionRowTop}>
        <Button variant="primary" onClick={onOpen}>
          {t('channel.open')}
        </Button>
        {/* 断开出口：只有**配置过**的通道才渲染（未配置时这个按钮没有意义，也不该存在）。
            危险操作用 danger 变体 + ConfirmDialog 二次确认（DESIGN.md §8.11）。 */}
        {remoteReady && (
          <Button variant="danger" onClick={onClear}>
            {t('channel.clear')}
          </Button>
        )}
        {onToggleExpanded !== undefined && (
          <>
            <span className={css.statusSpacer} />
            {/* 展开/收起该通道的详情（内容区 / 加密 / 解密 / 自动同步）。
                形态与 ContentPicker 的展开控件一致：原生 button + aria-expanded + aria-controls，
                图标走 ExpandChevron 形变（折叠展开是它的合法用途）。 */}
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
          </>
        )}
      </div>
    </Card>
  )
}
