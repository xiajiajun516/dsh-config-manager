/**
 * 远程同步面板（备份与迁移页的第 4 个 tab 内容）。
 *
 * 独立设置页壳（sectionHeader/close/自身 tab）已移除 —— tab 容器由
 * ConfigManagerSection 统一渲染，本组件只输出内容体：
 * - 仓库配置表单：repoUrl（必填）+ 认证 token（可选，写入 DSH credentials 的提示）
 *   + gitBin（可选）；
 * - 私有仓库强制提示横幅（常驻）；
 * - 推送按钮 → SyncPushReport（快照 id / 分区 / 告警）；
 * - 拉取按钮 → SyncPullReport.changes 差异摘要（description/kind/severity）+
 *   「预览不执行导入」提示；needsReview 高亮（v1 不做完整导入接线）；
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
import { SYNC_CREDENTIAL_REF } from './sync-api.ts'
import type { SyncApi, SyncStatusResponse } from './sync-api.ts'
import {
  computeGithubLoginView, computeSyncButtons, computeSyncStatus, githubPollMessage,
  kindLabel, privateRepoHint, pullReportView, pushReportView, severityLabel,
} from './sync-view.ts'
import type { GithubLoginPhase } from './sync-view.ts'
import css from '../config-manager.module.css'

export interface SyncSettingsViewProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
}

interface SyncUiState {
  loading: boolean
  loadError: string | null
  statusInfo: SyncStatusResponse | null
  repoUrl: string
  gitBin: string
  /** 仅内存：成功后清空（已写入 DSH credentials），绝不持久化 */
  token: string
  busy: 'push' | 'pull' | null
  pushReport: SyncPushReport | null
  pullReport: SyncPullReport | null
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

const initial: SyncUiState = {
  loading: true,
  loadError: null,
  statusInfo: null,
  repoUrl: '',
  gitBin: '',
  token: '',
  busy: null,
  pushReport: null,
  pullReport: null,
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

  /** 挂载时读取同步状态（配置回填 + 上次同步时间 + 凭据状态） */
  const loadStatus = async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const info = await api.status()
      patch({ loading: false, statusInfo: info, repoUrl: info.repoUrl ?? '', gitBin: info.gitBin ?? '' })
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
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

  /** 表单快照 → 请求体（token 为空串不携带；gitBin 空串不携带） */
  const payload = (): { repoUrl: string; gitBin?: string; token?: string } => ({
    repoUrl: state.repoUrl.trim(),
    gitBin: state.gitBin.trim() !== '' ? state.gitBin.trim() : undefined,
    token: state.token.trim() !== '' ? state.token : undefined,
  })

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
      // 成功即清空 token（已安全写入 DSH credentials）；失败保留以便重试
      patch({ busy: null, pushReport: report, token: report.ok ? '' : state.token })
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const runPull = async (): Promise<void> => {
    patch({ busy: 'pull', error: null, pullReport: null, pushReport: null })
    try {
      const report = await api.pull(payload())
      patch({ busy: null, pullReport: report, token: '' })
    } catch (err) {
      patch({ busy: null, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const status = computeSyncStatus(state.statusInfo, state.loading, state.loadError, uiT)
  const buttons = computeSyncButtons(state.busy, state.repoUrl, uiT)
  const pushView = pushReportView(state.pushReport, uiT)
  const pullView = pullReportView(state.pullReport, uiT)
  const githubView = computeGithubLoginView(
    state.github.phase, state.github.userCode, state.github.verificationUri, state.github.error, uiT,
  )
  /** GitHub 流程进行中（请求设备码 / 等待授权 / 轮询）：禁用 push/pull，避免无凭据操作 */
  const githubBusy =
    state.github.phase === 'starting' || state.github.phase === 'waiting' || state.github.phase === 'polling'

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('section.label')} subtitle={t('section.description')} />

          {/* 私有仓库强制提示 */}
          <Banner kind="warn">{privateRepoHint(uiT)}</Banner>

          {/* 仓库配置 */}
          <Card>
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
                placeholder="ghp_…（可选）"
                disabled={state.busy !== null}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ token: e.target.value }) }}
              />
              <span className={css.hint}>{t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })}</span>
            </label>

            {/* GitHub OAuth 登录（device flow）：无需手动输入 token */}
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
          </Card>

          {/* 同步状态 */}
          <Card>
            <span className={css.groupLabel}>{t('status.title')}</span>
            <div className={css.statRow}>
              <Badge kind={status.kind === 'ready' ? 'ok' : status.kind === 'error' ? 'error' : 'warn'}>{status.text}</Badge>
            </div>
          </Card>

          {/* 操作 */}
          <div className={css.actionRow}>
            <Button variant="primary" disabled={!buttons.canPush || githubBusy} onClick={() => { void runPush() }}>
              {state.busy === 'push' ? <Spinner label={buttons.pushLabel} /> : buttons.pushLabel}
            </Button>
            <Button disabled={!buttons.canPull || githubBusy} onClick={() => { void runPull() }}>
              {state.busy === 'pull' ? <Spinner label={buttons.pullLabel} /> : buttons.pullLabel}
            </Button>
          </div>

          {state.error !== null && <ErrorBanner error={state.error} />}

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
                </>
              )}
              {pullView.previewHint !== '' && <Banner kind="info">{pullView.previewHint}</Banner>}
            </Card>
          )}
    </div>
  )
}