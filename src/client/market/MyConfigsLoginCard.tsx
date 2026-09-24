/**
 * 「我的配置」登录卡 —— t49 物理拆分：从 MyConfigsView.tsx 的 renderLoginCard 段（含
 * renderDeviceCode 片段）原样提取，行为/视觉不变。device flow 状态机在
 * ../../ui/my-configs-view.ts（t44 下沉），请求编排与定时器仍在 MyConfigsView.tsx。
 * 本文件无状态、不发起请求：只按 loginView / github 渲染，并把「开始 / 取消」上抛给容器。
 */
import type { ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { MARKET_UPSTREAM_OWNER, MARKET_UPSTREAM_REPO } from '../../market/upstream.ts'
import { computeGithubLoginView } from '../sync/sync-view.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { MyGithubFlowState } from '../../ui/my-configs-view.ts'
import { Badge, Banner, Button, Card, Spinner } from '../common/ui.tsx'
import type { LoginView } from './my-configs-view.ts'
import css from '../config-manager.module.css'

export interface MyConfigsLoginCardProps {
  /** 登录视图（加载中 / 未登录 / 已登录 / token 失效），由容器 deriveLoginState 装配 */
  loginView: LoginView
  /** device flow 状态（只读 phase / userCode / verificationUri / error） */
  github: MyGithubFlowState
  /** 市场字典（与 MyConfigsView 同一个 t） */
  t: TranslateNS<'config-manager-market'>
  /** 展示层翻译器（computeGithubLoginView 用；= meApi.t） */
  uiT: UiT
  /** 发起 GitHub device flow 登录 */
  onStart: () => void
  /** 取消进行中的 device flow */
  onCancel: () => void
}

export function MyConfigsLoginCard({ loginView, github, t, uiT, onStart, onCancel }: MyConfigsLoginCardProps) {
  /** GitHub 登录卡渲染模型（复用 sync-view 纯函数：状态行 / 按钮态 / 展示设备码） */
  const githubView = computeGithubLoginView(github.phase, github.userCode, github.verificationUri, github.error, uiT)
  /** 固定目标仓库（只读展示） */
  const targetRepo = `${MARKET_UPSTREAM_OWNER}/${MARKET_UPSTREAM_REPO}`

  /** 设备码 + 授权页链接展示（waiting/polling 时） */
  const renderDeviceCode = (): ReactNode => (
    <div className={css.statRow}>
      <Badge kind="info">{t('myconfigs.login.userCode', { code: githubView.userCode })}</Badge>
      <a className={css.ghostButton} href={githubView.verificationUri} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
        {t('myconfigs.login.openAuth')}
      </a>
    </div>
  )

  if (loginView.kind === 'loading') {
    return (
      <Card>
        <div className={css.statRow}>
          <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
          <Spinner label={t('myconfigs.login.checking')} />
        </div>
      </Card>
    )
  }
  if (loginView.kind === 'logged-out' || loginView.kind === 'token-invalid') {
    return (
      <Card>
        <div className={css.actionRow}>
          <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
          <Button variant="primary" disabled={!githubView.canStart} onClick={() => { onStart() }}>
            {githubView.startLabel}
          </Button>
          {githubView.canCancel && (
            <Button disabled={github.phase === 'starting'} onClick={() => { onCancel() }}>
              {t('myconfigs.login.cancel')}
            </Button>
          )}
        </div>
        <span className={css.hint}>{t('myconfigs.login.hint')}</span>
        {loginView.kind === 'token-invalid' && <Banner kind="warn">{t('myconfigs.error.loadStatus')}</Banner>}
        {githubView.showCode && renderDeviceCode()}
        <div className={css.statRow}>
          <Badge kind={githubView.phase === 'error' ? 'error' : 'warn'}>{githubView.statusText}</Badge>
        </div>
        {/* R-18：失败详情已由 failGithub() 走全局 Toast；此处保留状态行 Badge（持续状态展示，非回执） */}
      </Card>
    )
  }
  // logged-in：@login + 固定目标仓库（只读）+ 配置仓库状态
  return (
    <Card>
      <div className={css.actionRow}>
        <span className={css.groupLabel}>{t('myconfigs.login.title')}</span>
        <Badge kind="ok">{t('myconfigs.login.loggedInAs', { login: loginView.login })}</Badge>
      </div>
      <div className={css.statRow}>
        <Badge kind="info">{t('myconfigs.login.targetRepo', { repo: targetRepo })}</Badge>
      </div>
      <div className={css.statRow}>
        {loginView.repoExists
          ? <Badge kind="ok">{t('myconfigs.login.repoReady', { repo: loginView.repoUrl })}</Badge>
          : <Badge kind="warn">{t('myconfigs.login.repoMissing')}</Badge>}
      </div>
    </Card>
  )
}
