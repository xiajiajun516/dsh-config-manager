/**
 * 远程同步面板（备份与迁移页的第 4 个 tab 内容）。
 *
 * 独立设置页壳（sectionHeader/close/自身 tab）已移除 —— tab 容器由
 * ConfigManagerSection 统一渲染，本组件只输出内容体：
 * - 仓库配置表单：repoUrl（必填）+ 认证 token（可选，写入 DSH credentials 的提示）
 *   + gitBin（可选）；
 * - 私有仓库强制提示横幅（常驻）；
 * - 推送按钮 → SyncPushReport（快照 id / 分区 / 告警）；
 * - 拉取按钮 → SyncPullReport.changes 差异摘要（description/kind/severity）；
 * - 【方案 A】一键同步主按钮：拉取 → 差异确认会话（SyncConfirmView 逐项确认）→
 *   确认导入（apply-items）→ 执行结果 + 一键回滚（restoreId）；「选择历史快照」下拉；
 * - 【方案 A】自动同步设置区块：总开关 + 间隔下拉 + 状态（上次运行 / 下次倒计时）；
 * - 状态行：凭据配置 + 上次同步时间 + 通道（来自 GET /sync/status，组件挂载时加载）。
 *
 * 全部渲染模型来自 ./sync-view.ts 纯函数（node 单测覆盖），组件只做装配；
 * 状态组件内自持（低频显式操作，同 SnapshotsPanel 策略，不进 sessionStorage）；
 * token 仅内存（state），成功后清空（已写入 DSH credentials），绝不持久化。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts'
import { Badge, Banner, Button, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF } from './sync-api.ts'
import type {
  AutosyncInterval, AutosyncStatusResponse, SyncApi, SyncPushPayload, SyncSnapshotLite, SyncStartResponse,
  SyncStatusResponse,
} from './sync-api.ts'
import {
  autosyncIntervalMs, autosyncStatusText, computeAutosyncCountdown, computeGithubLoginView,
  computeRemoteReady, computeSyncButtons, computeSyncStatus, formatIntervalDuration, githubPollMessage,
  kindLabel, privateRepoHint, pullReportView, pushReportView, severityLabel,
} from './sync-view.ts'
import type { GithubLoginPhase, SyncChannel } from './sync-view.ts'
import { SyncHistoryView } from './SyncHistoryView.tsx'
import { SyncConfirmView } from './SyncConfirmView.tsx'
import css from '../config-manager.module.css'

export interface SyncSettingsViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

interface SyncUiState {
  loading: boolean
  loadError: string | null
  statusInfo: SyncStatusResponse | null
  /** 当前同步通道（git 默认；webdav 切换显示 WebDAV 表单） */
  channel: SyncChannel
  /** git 通道表单 */
  repoUrl: string
  gitBin: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化 */
  token: string
  /** webdav 通道表单 */
  webdavUrl: string
  webdavUsername: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化/回显 */
  webdavPassword: string
  busy: 'sync' | 'push' | 'pull' | 'rollback' | null
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
  /** 一键同步差异确认会话（POST /sync/sync 结果；非空时渲染 SyncConfirmView） */
  confirmSession: SyncStartResponse | null
  /** 远端历史快照列表（「选择历史快照」下拉数据源） */
  snapshots: SyncSnapshotLite[]
  /** 当前选中的历史快照 id（'' = 最新） */
  selectedSnapshotId: string
  /** 自动同步状态 */
  autosync: AutosyncStatusResponse | null
  /** 自动同步开关（回填自 autosync） */
  autosyncEnabled: boolean
  /** 自动同步间隔（回填自 autosync） */
  autosyncInterval: AutosyncInterval
  /** 最近一次一键同步执行结果（回滚入口） */
  lastRestoreId: string | null
  error: string | null
  /** GitHub OAuth device flow 状态（flowId/userCode 仅内存，token 只存宿主） */
  github: GithubUiState
}

interface GithubUiState {
  phase: GithubLoginPhase
  flowId: string
  userCode: string
  verificationUri: string
  /** GitHub 建议轮询间隔秒数（pending 重排时兜底用） */
  interval: number
  error: string | null
}

const initialGithub: GithubUiState = {
  phase: 'idle', flowId: '', userCode: '', verificationUri: '', interval: 5, error: null,
}

const AUTOSYNC_INTERVAL_OPTIONS: AutosyncInterval[] = ['5m', '15m', '30m', '60m', '6h', '12h', '24h'];

const initial: SyncUiState = {
  loading: true,
  loadError: null,
  statusInfo: null,
  channel: 'git',
  repoUrl: '',
  gitBin: '',
  token: '',
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  busy: null,
  pushReport: null,
  pullReport: null,
  confirmSession: null,
  snapshots: [],
  selectedSnapshotId: '',
  autosync: null,
  autosyncEnabled: false,
  autosyncInterval: '30m',
  lastRestoreId: null,
  error: null,
  github: initialGithub,
}

export function SyncSettingsView({ api, t }: SyncSettingsViewProps) {
  const [state, setState] = useState<SyncUiState>(initial)
  const uiT = api.t // 客户端展示层翻译器（zh/en，见 ui/i18n.ts）
  const patch = (p: Partial<SyncUiState>): void => setState((s) => ({ ...s, ...p }))
  const patchGithub = (p: Partial<GithubUiState>): void => setState((s) => ({ ...s, github: { ...s.github, ...p } }))
  /** GitHub 轮询定时器（卸载/取消时清理，防止泄漏与跨流程串扰） */
  const githubPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 挂载时读取同步状态（配置回填 + 上次同步时间 + 凭据状态 + autosync） */
  const loadStatus = async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      // 通道回填：transport.type=webdav → 显示 webdav；否则 git（Host 以 transport 字段为准）
      const savedChannel: SyncChannel = info.transport?.type === 'webdav' ? 'webdav' : 'git'
      patch({
        loading: false,
        statusInfo: info,
        channel: savedChannel,
        repoUrl: info.repoUrl ?? '',
        gitBin: info.gitBin ?? '',
        webdavUrl: info.webdav?.url ?? '',
        // Host 不回传 username 值（仅 usernameConfigured 布尔）；留空待填，徽章提示已配置过
        webdavUsername: '',
        ...(info.autosync !== undefined
          ? {
              autosync: info.autosync,
              autosyncEnabled: info.autosync.enabled,
              autosyncInterval: info.autosync.interval,
            }
          : {}),
      })
      // 独立拉取 autosync（若 status 未带则补一次）
      if (info.autosync === undefined) {
        void loadAutosync()
      }
      // 通道已配置且远端地址就绪时，自动拉取远端快照填充下拉（无需先点一键同步）；
      // 直接传 info 的地址（state.patch 尚未生效），避免竞态
      const preset = savedChannel === 'webdav' ? (info.webdav?.url ?? '') : (info.repoUrl ?? '')
      if (info.configured && preset.trim() !== '') {
        void loadSnapshots(preset, savedChannel)
      }
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 读取自动同步状态（GET /sync/autosync）。 */
  const loadAutosync = async (): Promise<void> => {
    try {
      const autosync = await api.autosyncStatus()
      patch({ autosync, autosyncEnabled: autosync.enabled, autosyncInterval: autosync.interval })
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 读取远端历史快照列表（「选择历史快照」下拉数据源）。
   * urlOverride / channelOverride：挂载时地址刚从 status 回填、state.patch 尚未生效，
   * 直接传 info 的地址与通道避免竞态读旧值；缺省读当前 state。
   * 无远端地址时静默跳过（不发无效请求，下拉留空）。
   */
  const loadSnapshots = async (urlOverride?: string, channelOverride?: SyncChannel): Promise<void> => {
    const ch = channelOverride ?? state.channel
    if (ch === 'webdav') {
      const url = urlOverride ?? state.webdavUrl
      if (url.trim() === '') return
      try {
        const res = await api.snapshotsList({ transport: 'webdav', webdav: { url: url.trim() } })
        patch({ snapshots: res.snapshots })
      } catch {
        // 拉取失败不阻断主流程（下拉留空，用户可重试）
      }
      return
    }
    const repo = urlOverride ?? state.repoUrl
    if (repo.trim() === '') return
    try {
      const res = await api.snapshotsList({
        transport: 'git',
        repoUrl: repo.trim(),
        gitBin: state.gitBin.trim() !== '' ? state.gitBin.trim() : undefined,
      })
      patch({ snapshots: res.snapshots })
    } catch {
      // 拉取失败不阻断主流程（下拉留空，用户可重试）
    }
  }

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 卸载时清理轮询定时器（组件销毁后不得再 setState/发请求） */
  useEffect(() => () => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
  }, [])

  /** 表单快照 → 请求体（按当前通道构建；空串不携带；password 仅内存不发回显） */
  const payload = (): SyncPushPayload => {
    if (state.channel === 'webdav') {
      return {
        transport: 'webdav',
        webdav: {
          url: state.webdavUrl.trim() !== '' ? state.webdavUrl.trim() : undefined,
          username: state.webdavUsername.trim() !== '' ? state.webdavUsername.trim() : undefined,
          password: state.webdavPassword !== '' ? state.webdavPassword : undefined,
        },
      }
    }
    return {
      transport: 'git',
      repoUrl: state.repoUrl.trim(),
      gitBin: state.gitBin.trim() !== '' ? state.gitBin.trim() : undefined,
      token: state.token.trim() !== '' ? state.token : undefined,
    }
  }

  /* ------------------------------------------------ GitHub OAuth device flow */

  /** 发起 GitHub 登录：取设备码 → 展示一次性用户码 + 授权页 → 开始轮询 */
  const runGithubStart = async (): Promise<void> => {
    patchGithub({ phase: 'starting', error: null })
    try {
      const info = await api.githubStart()
      patchGithub({
        phase: 'waiting',
        flowId: info.flowId,
        userCode: info.userCode,
        verificationUri: info.verificationUri,
        interval: info.interval,
      })
      scheduleGithubPoll(info.flowId, Math.max(info.interval, 1) * 1000)
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 排定一次 GitHub 轮询（先清旧定时器，避免重复轮询） */
  const scheduleGithubPoll = (flowId: string, delayMs: number): void => {
    if (githubPollTimer.current !== null) clearTimeout(githubPollTimer.current)
    githubPollTimer.current = setTimeout(() => { void runGithubPoll(flowId) }, delayMs)
  }

  /** 轮询 GitHub 授权结果：pending 继续等；success 刷新凭据状态；终止态展示结果 */
  const runGithubPoll = async (flowId: string): Promise<void> => {
    patchGithub({ phase: 'polling' })
    try {
      const poll = await api.githubPoll(flowId)
      if (poll.status === 'pending') {
        patchGithub({ phase: 'waiting' })
        scheduleGithubPoll(flowId, poll.pollDelayMs ?? Math.max(state.github.interval, 1) * 1000)
        return
      }
      const message = githubPollMessage(poll, uiT)
      if (poll.status === 'success') {
        patchGithub({ phase: 'success', error: null })
        // token 已由宿主写入 DSH credentials：刷新状态行与凭据徽章
        void loadStatus()
      } else {
        patchGithub({ phase: 'error', error: message })
      }
    } catch (err) {
      patchGithub({ phase: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 取消登录：停轮询 + 通知宿主丢弃设备码登记 + 复位 UI */
  const runGithubCancel = async (): Promise<void> => {
    if (githubPollTimer.current !== null) {
      clearTimeout(githubPollTimer.current)
      githubPollTimer.current = null
    }
    const flowId = state.github.flowId
    patchGithub(initialGithub)
    if (flowId !== '') {
      try { await api.githubCancel(flowId) } catch { /* 取消失败无需打扰用户 */ }
    }
  }

  const runPush = async (): Promise<void> => {
    patch({ busy: 'push', error: null, pushReport: null, pullReport: null })
    try {
      const report = await api.push(payload())
      // 成功即清空 token/webdavPassword（已安全写入 DSH credentials）；失败保留以便重试
      patch({
        busy: null, pushReport: report,
        ...(report.ok ? { token: '', webdavPassword: '' } : {}),
      })
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const runPull = async (): Promise<void> => {
    patch({ busy: 'pull', error: null, pullReport: null, pushReport: null })
    try {
      const report = await api.pull(payload())
      patch({ busy: null, pullReport: report, token: '', webdavPassword: '' })
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /* ------------------------------------------------ 一键同步（方案 A） */

  /** 一键同步：拉取 → 差异确认会话（先取消旧会话，再发起新会话）。 */
  const runSync = async (snapshotId?: string): Promise<void> => {
    // 清理旧的差异确认会话（避免残留临时 ZIP / 同 key 冲突）
    if (state.confirmSession !== null) {
      try { await api.cancel(state.confirmSession.syncSessionId) } catch { /* 尽力清理 */ }
    }
    patch({ busy: 'sync', error: null, confirmSession: null, lastRestoreId: null })
    try {
      const session = await api.sync({ ...payload(), ...(snapshotId !== undefined && snapshotId !== '' ? { snapshotId } : {}) })
      if (!session.ok) {
        patch({ busy: null, error: session.message ?? t('syncflow.syncFailed') })
        return
      }
      patch({ busy: null, confirmSession: session, token: '', webdavPassword: '' })
      void loadSnapshots()
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** 用户取消差异确认：清除会话，复位到空闲。 */
  const cancelConfirm = (): void => {
    patch({ confirmSession: null })
  }

  /** 从 SyncConfirmView 透传的一键回滚完成信号。 */
  const onRollbackApplied = (): void => {
    patch({ lastRestoreId: null })
  }

  /* ------------------------------------------------ 自动同步（方案 A） */

  const toggleAutosync = async (enabled: boolean): Promise<void> => {
    patch({ autosyncEnabled: enabled, error: null })
    try {
      const updated = await api.autosyncUpdate({ enabled, interval: state.autosyncInterval })
      patch({ autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const updateAutosyncInterval = async (interval: AutosyncInterval): Promise<void> => {
    patch({ autosyncInterval: interval, error: null })
    try {
      const updated = await api.autosyncUpdate({ enabled: state.autosyncEnabled, interval })
      patch({ autosync: updated, autosyncEnabled: updated.enabled, autosyncInterval: updated.interval })
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const status = computeSyncStatus(state.statusInfo, state.loading, state.loadError, uiT)
  /** 活动通道的远端地址是否就绪（git=repoUrl 非空；webdav=webdavUrl 非空） */
  const remoteReady = computeRemoteReady(state.channel, state.repoUrl, state.webdavUrl)
  const buttons = computeSyncButtons(state.busy, remoteReady, uiT)
  const pushView = pushReportView(state.pushReport, uiT)
  const pullView = pullReportView(state.pullReport, uiT)
  const githubView = computeGithubLoginView(
    state.github.phase, state.github.userCode, state.github.verificationUri, state.github.error, uiT,
  )
  /** GitHub 流程进行中（请求设备码 / 等待授权 / 轮询）：禁用 push/pull，避免无凭据操作 */
  const githubBusy =
    state.github.phase === 'starting' || state.github.phase === 'waiting' || state.github.phase === 'polling'

  const autosyncText = state.autosync !== null ? autosyncStatusText(state.autosync, uiT) : t('autosync.statusNever')
  /** 距下次自动同步剩余 ms（null = 从未运行；0 = 已到期） */
  const autosyncCountdownMs = state.autosync !== null && state.autosync.elapsedMs >= 0
    ? computeAutosyncCountdown(state.autosync.elapsedMs, autosyncIntervalMs(state.autosync.interval))
    : null

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

          {/* 私有仓库强制提示：仅 git 通道适用 */}
          {state.channel === 'git' && <Banner kind="warn">{privateRepoHint(uiT)}</Banner>}

          {/* 通道配置 */}
          <Card>
            <span className={css.groupLabel}>{t('channel.title')}</span>
            <span className={css.hint}>{t('channel.hint')}</span>
            <select
              className={css.select}
              value={state.channel}
              disabled={state.busy !== null}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                patch({ channel: e.target.value as SyncChannel })
              }}
            >
              <option value="git">{t('channel.git')}</option>
              <option value="webdav">{t('channel.webdav')}</option>
            </select>

            {/* git 通道分支 */}
            {state.channel === 'git' && (
              <>
                <span className={css.groupLabel}>{t('config.title')}</span>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('config.repoUrl')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.repoUrl}
                    placeholder="https://github.com/user/private-repo.git"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ repoUrl: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('config.repoUrlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('config.token')}
                    {' '}
                    {state.statusInfo?.credentialConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.token}
                    autoComplete="off"
                    placeholder={t('config.tokenPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ token: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                </label>

                {/* GitHub OAuth 登录（device flow）：仅 git 通道显示 */}
                <span className={css.groupLabel}>{t('github.title')}</span>
                <span className={css.hint}>{t('github.description')}</span>
                {githubView.showCode && (
                  <div className={css.statRow}>
                    <Badge kind="info">{t('github.userCode')}：<strong>{githubView.userCode}</strong></Badge>
                    <a
                      className={css.ghostButton}
                      href={githubView.verificationUri}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: 'none' }}
                    >
                      {t('github.openAuth')}
                    </a>
                  </div>
                )}
                <div className={css.actionRow}>
                  <Button
                    variant="primary"
                    disabled={!githubView.canStart || state.busy !== null}
                    onClick={() => { void runGithubStart() }}
                  >
                    {githubView.startLabel}
                  </Button>
                  {githubView.canCancel && (
                    <Button disabled={state.busy !== null} onClick={() => { void runGithubCancel() }}>
                      {t('github.cancel')}
                    </Button>
                  )}
                </div>
                <div className={css.statRow}>
                  <Badge kind={githubView.phase === 'success' ? 'ok' : githubView.phase === 'error' ? 'error' : 'warn'}>
                    {githubView.statusText}
                  </Badge>
                </div>
                {githubView.phase === 'error' && (
                  <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
                )}

                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('config.gitBin')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.gitBin}
                    placeholder="git"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ gitBin: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('config.gitBinHint')}</span>
                </label>
              </>
            )}

            {/* webdav 通道分支 */}
            {state.channel === 'webdav' && (
              <>
                <span className={css.groupLabel}>{t('webdav.title')}</span>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('webdav.url')}</span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUrl}
                    placeholder="https://dav.example.com/dav/config"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ webdavUrl: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('webdav.urlHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.username')}
                    {' '}
                    {state.statusInfo?.webdav?.usernameConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
                  </span>
                  <input
                    type="text"
                    className={css.input}
                    value={state.webdavUsername}
                    autoComplete="off"
                    placeholder="alice"
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ webdavUsername: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('webdav.usernameHint')}</span>
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>
                    {t('webdav.password')}
                    {' '}
                    {state.statusInfo?.webdav?.passwordConfigured === true && <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>}
                  </span>
                  <input
                    type="password"
                    className={css.input}
                    value={state.webdavPassword}
                    autoComplete="off"
                    placeholder={t('webdav.passwordPlaceholder')}
                    disabled={state.busy !== null}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ webdavPassword: e.target.value }) }}
                  />
                  <span className={css.hint}>{t('webdav.passwordHint', { ref: SYNC_WEBDAV_CREDENTIAL_REF })}</span>
                </label>
              </>
            )}
          </Card>

          {/* 同步状态 */}
          <Card>
            <span className={css.groupLabel}>{t('status.title')}</span>
            <div className={css.statRow}>
              <Badge kind={status.kind === 'ready' ? 'ok' : status.kind === 'error' ? 'error' : 'warn'}>{status.text}</Badge>
              <Badge kind="info">{state.channel === 'webdav' ? t('channel.webdav') : t('channel.git')}</Badge>
            </div>
          </Card>

          {/* 一键同步 + 手动推送/拉取 */}
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={state.busy !== null || !remoteReady}
              onClick={() => { void runSync() }}
            >
              {state.busy === 'sync' ? <Spinner label={t('syncflow.syncing')} /> : t('syncflow.button')}
            </Button>
            <Button disabled={!buttons.canPush || githubBusy} onClick={() => { void runPush() }}>
              {state.busy === 'push' ? <Spinner label={buttons.pushLabel} /> : buttons.pushLabel}
            </Button>
            <Button disabled={!buttons.canPull || githubBusy} onClick={() => { void runPull() }}>
              {state.busy === 'pull' ? <Spinner label={buttons.pullLabel} /> : buttons.pullLabel}
            </Button>
          </div>

          {/* 选择历史快照下拉 */}
          <div className={css.statRow}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('syncflow.selectSnapshot')}</span>
              <select
                className={css.select}
                value={state.selectedSnapshotId}
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const id = e.target.value
                  patch({ selectedSnapshotId: id })
                  void runSync(id === '' ? undefined : id)
                }}
              >
                <option value="">{t('syncflow.latestSnapshot')}</option>
                {state.snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}{t('syncflow.snapshotOption', { date: s.createdAt.slice(0, 10), count: String(s.sectionCount) })}
                  </option>
                ))}
              </select>
              {state.snapshots.length === 0 && <span className={css.hint}>{t('syncflow.noSnapshots')}</span>}
            </label>
          </div>

          {state.error !== null && <ErrorBanner error={state.error} />}

          {/* 一键同步差异确认（拉取 → 逐项确认 → 导入） */}
          {state.confirmSession !== null && (
            <SyncConfirmView
              api={api}
              syncSessionId={state.confirmSession.syncSessionId}
              snapshotId={state.confirmSession.snapshotId}
              items={state.confirmSession.items}
              needsReview={state.confirmSession.needsReview}
              compatibility={state.confirmSession.compatibility}
              t={t}
              onCancel={cancelConfirm}
              onRollbackDone={onRollbackApplied}
            />
          )}

          {/* 推送结果 */}
          {pushView !== null && (
            <Card>
              <span className={css.groupLabel}>{t('push.title')}</span>
              <Banner kind={pushView.kind === 'ok' ? 'ok' : 'error'}>{pushView.headline}</Banner>
              {pushView.sections.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('sections.title')}</span>
                  <div className={css.statRow}>
                    {pushView.sections.map((s) => <Badge key={s} kind="info">{s}</Badge>)}
                  </div>
                </div>
              )}
              {pushView.warnings.length > 0 && (
                <div>
                  <span className={css.fieldLabel}>{t('warnings.title')}</span>
                  <ul className={css.warnList}>
                    {pushView.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}
            </Card>
          )}

          {/* 拉取差异预览 */}
          {pullView !== null && (
            <Card>
              <span className={css.groupLabel}>{t('pull.title')}</span>
              <Banner kind={pullView.kind === 'ok' ? 'info' : pullView.kind === 'empty' ? 'ok' : 'error'}>{pullView.headline}</Banner>
              {pullView.summary !== null && (
                <>
                  <div className={css.statRow}>
                    <Badge kind="info">{t('change.total', { total: pullView.summary.total })}</Badge>
                    {pullView.summary.error > 0 && <Badge kind="error">{severityLabel('error', uiT)} × {pullView.summary.error}</Badge>}
                    {pullView.summary.warning > 0 && <Badge kind="warn">{severityLabel('warning', uiT)} × {pullView.summary.warning}</Badge>}
                    {pullView.summary.info > 0 && <Badge kind="info">{severityLabel('info', uiT)} × {pullView.summary.info}</Badge>}
                  </div>
                  {pullView.summary.needsReview && <Banner kind="warn">{t('pull.needsReview')}</Banner>}
                  {/* 固定高度 + 内部滚动：变更项再多也不把整页撑长 */}
                  <div className={css.pullScroll}>
                    <div className={css.reportList}>
                      {pullView.summary.items.map((c) => (
                        <div key={c.id} className={css.statRow}>
                          <span className={css.kindTag}>{kindLabel(c.kind, uiT)}</span>
                          <Badge kind={c.severity === 'error' ? 'error' : c.severity === 'warning' ? 'warn' : 'info'}>
                            {severityLabel(c.severity, uiT)}
                          </Badge>
                          <span>{c.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
              {pullView.previewHint !== '' && <Banner kind="info">{pullView.previewHint}</Banner>}
            </Card>
          )}

          {/* 自动同步设置（方案 A） */}
          <Card>
            <span className={css.groupLabel}>{t('autosync.title')}</span>
            <span className={css.hint}>{t('autosync.description')}</span>
            <label className={css.checkboxRow}>
              <input
                type="checkbox"
                checked={state.autosyncEnabled}
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { void toggleAutosync(e.target.checked) }}
              />
              <span>{t('autosync.enable')}</span>
            </label>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('autosync.interval')}</span>
              <select
                className={css.input}
                value={state.autosyncInterval}
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  void updateAutosyncInterval(e.target.value as AutosyncInterval)
                }}
              >
                {AUTOSYNC_INTERVAL_OPTIONS.map((iv) => (
                  <option key={iv} value={iv}>{intervalLabel(iv, t)}</option>
                ))}
              </select>
              <span className={css.hint}>{t('autosync.intervalHint')}</span>
            </label>
            <div className={css.statRow}>
              <Badge kind={state.autosync?.lastRunStatus === 'failed' ? 'error' : state.autosync?.lastRunStatus === 'skipped' ? 'warn' : 'info'}>
                {autosyncText}
              </Badge>
              {autosyncCountdownMs !== null && state.autosyncEnabled && (
                <Badge kind="info">
                  {autosyncCountdownMs <= 0
                    ? t('autosync.due')
                    : t('autosync.nextRun', { time: formatIntervalDuration(autosyncCountdownMs, uiT) })}
                </Badge>
              )}
            </div>
          </Card>

          {/* P2：同步历史视图（Host /sync/history 端点） */}
          <SyncHistoryView api={api} t={t} />
    </div>
  )
}

/** AutosyncInterval → 可读标签（复用 i18n interval 键）。 */
function intervalLabel(iv: AutosyncInterval, t: TranslateNS<'config-manager-sync'>): string {
  switch (iv) {
    case '5m': return t('autosync.interval5m');
    case '15m': return t('autosync.interval15m');
    case '30m': return t('autosync.interval30m');
    case '60m': return t('autosync.interval60m');
    case '6h': return t('autosync.interval6h');
    case '12h': return t('autosync.interval12h');
    case '24h': return t('autosync.interval24h');
    default: return iv;
  }
}
