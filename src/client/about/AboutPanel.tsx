/**
 * 「关于（About）」面板（设置页第 6 个 tab 内容，docs/design/2026-08-19-about-tab-design.md §4）。
 *
 * 纯静态展示视图 + 外链，无表单 / 无写操作 / 无新增依赖：
 * - 项目信息卡：插件名 + 官方 Badge；版本 / DSH / 平台 Badge（运行时信息，经 api.status() 获取）；
 *   卡片末尾是「复制环境信息」—— 版本 / DSH / 平台（+ 诊断位）经纯函数拼成可粘贴的 Markdown，
 *   提 issue 时不必手抄版本号（prompt：反馈摩擦越小，用户越愿意提）；
 * - 相关链接卡：Star 主按钮（外链）+ 仓库 / 文档 / Issues 链接行 + 作者行；
 * - 公开元数据（名称 / 仓库 / 作者 / 链接）全部来自 ./about-view.ts 的 ABOUT_META / ABOUT_LINKS
 *   （静态常量，单一来源，node 单测覆盖）；
 * - 状态行格式化委托 ./about-view.ts 的 aboutStatusRows 纯函数（组件不实现可测试业务逻辑）；
 * - 版本号不在此重复维护 —— 展示值一律来自 status()（AGENTS.md §版本号三处同步教训）。
 *
 * 安全：无任何输入表单（无 secret 泄漏面）、无配置写操作（仅把环境信息写入剪贴板）；
 * 外链一律 target="_blank" + rel="noreferrer"
 * （防 tabnabbing）；错误文本渲染前经 redact() 兜底（安全不变量）。
 * 状态组件内自持（低频静态视图，同 Snapshots/Sync/Market 策略，不进 sessionStorage）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import { Badge, Banner, Button, Card, SectionTitle } from '../common/ui.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { CopyButton } from '../common/CopyButton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ABOUT_CLI, ABOUT_LINKS, ABOUT_META, aboutStatusRows, aboutUpdateView, buildFeedbackSnippet } from './about-view.ts'
import type { AboutStatusRows, AboutUpdateView } from './about-view.ts'
import { ReleaseNotesDialog } from './ReleaseNotesDialog.tsx'
import { PluginUpdateDialog } from './PluginUpdateDialog.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface AboutPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

interface AboutUiState {
  loading: boolean
  /** 已 redact 的错误文本（status() 失败时） */
  loadError: string | null
  /** 版本 / DSH / 平台展示行（aboutStatusRows 纯函数输出） */
  rows: AboutStatusRows | null
}

const initial: AboutUiState = { loading: true, loadError: null, rows: null }

export function AboutPanel({ api, t }: AboutPanelProps) {
  const [state, setState] = useState<AboutUiState>(initial)
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false)
  const patch = (p: Partial<AboutUiState>): void => setState((s) => ({ ...s, ...p }))
  /** 版本更新检查（只读探测 npm；低频动作，状态自持，与 status 同策略） */
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateView, setUpdateView] = useState<AboutUpdateView | null>(null)
  /** 「立即更新」弹窗开关（检测到新版本时自动打开） */
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)
  /** 本会话已安装完成、等待重启的版本（不重复弹窗，且卡片改显成功态） */
  const [appliedVersion, setAppliedVersion] = useState<string | null>(null)
  const appliedVersionRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  /** 读取运行时版本信息（pluginVersion / dshVersion / platform+arch → 展示行） */
  const loadStatus = useCallback(async (): Promise<void> => {
    patch({ loading: true, loadError: null })
    try {
      const status = await api.status()
      patch({ loading: false, rows: aboutStatusRows(status) })
    } catch (err) {
      patch({ loading: false, loadError: err instanceof Error ? err.message : String(err) })
    }
  }, [api])

  /**
   * 检查更新（`force=true` 走宿主 ?force=1 绕过 10 分钟缓存 —— 用户点「重新检查」的语义）。
   * 失败一律落成 `failed` 视图（带原因、可重试），**绝不显示成「已是最新」**。
   */
  const runUpdateCheck = useCallback((force: boolean): void => {
    setUpdateChecking(true)
    api.checkUpdate(force).then(
      (result) => {
        if (!mountedRef.current) return
        const view = aboutUpdateView(result, { profile: state.rows?.diagnostics?.profile })
        setUpdateView(view)
        // 有新版本 → 自动弹出「更新到 vX」弹窗（GitHub 发布说明 + 一键更新）。
        // 两个前提下不弹：① command 为 null（desktop / 未知档案，注定装不了，走卡片提示）；
        // ② 本会话已经更新过同一版本（等待重启）——避免每次重新检查都打断用户。
        if (view.kind === 'available' && view.command !== null && view.latest !== appliedVersionRef.current) {
          setUpdateDialogOpen(true)
        }
        setUpdateChecking(false)
      },
      (err) => {
        if (!mountedRef.current) return
        setUpdateView({
          kind: 'failed',
          current: state.rows?.version ?? '',
          error: err instanceof Error ? err.message : String(err),
        })
        setUpdateChecking(false)
      },
    )
  }, [api, state.rows?.diagnostics?.profile, state.rows?.version])

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('about.title')} info={<InfoHint text={t('about.subtitle')} label={t('common.infoHint')} />} />

      {/* 项目信息卡：插件名 + 官方 Badge；版本 / DSH / 平台（动态，经 status()） + 查看更新内容 */}
      <Card>
        <span className={css.groupLabel}>{ABOUT_META.name}</span>
        <div className={css.statRow}>
          <Badge kind="ok">{t('about.official')}</Badge>
        </div>
        {state.loading && <Skeleton count={3} label={t('about.loading')} />}
        {state.loadError !== null && (
          <div>
            <Banner kind="error">{redact(state.loadError)}</Banner>
            <div className={css.actionRow}>
              <Button onClick={() => { void loadStatus() }}>{t('about.retryStatus')}</Button>
            </div>
          </div>
        )}
        {state.rows !== null && (
          <div className={css.statRow} style={{ flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <Badge kind="info">{t('about.version', { version: state.rows.version })}</Badge>
            <Badge kind="info">{t('about.dshVersion', { version: state.rows.dsh })}</Badge>
            <Badge kind="info">{state.rows.platform}</Badge>
          </div>
        )}

        {/* issue #28 诊断位：插件清单实际读的目录 / profile / 识别到的插件数。
            用于自查「装了插件却没被备份识别到」——此前用户完全无从查看。 */}
        {state.rows?.diagnostics != null && (
          <div className={css.statRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '4px' }}>
            <span className={css.groupLabel}>{t('about.diag.label')} <InfoHint text={t('about.diag.hint')} label={t('common.infoHint')} /></span>
            <span>{t('about.diag.profileDir', { path: state.rows.diagnostics.profileDir })}</span>
            <span>{t('about.diag.profile', { profile: state.rows.diagnostics.profile })}</span>
            <span>{t('about.diag.pluginCount', { count: String(state.rows.diagnostics.pluginCount) })}</span>
            {state.rows.diagnostics.manifestUnreadable && (
              <Banner kind="warn">{t('about.diag.manifestUnreadable')}</Banner>
            )}
          </div>
        )}

        {/* 反馈摩擦最小化：把版本 / DSH / 平台（+ 诊断位）拼成一段可直接粘贴的文本。
            拼接规则是 ./about-view.ts 的纯函数，组件只装配（AGENTS.md §UI 分层铁律）。 */}
        {state.rows !== null && (
          <div className={css.actionRow}>
            <InfoHint text={t('about.feedbackHint')} label={t('common.infoHint')} />
            <CopyButton
              text={buildFeedbackSnippet(state.rows, t)}
              label={t('about.copyEnv')}
              t={t}
            />
          </div>
        )}
      </Card>


      {/* 插件版本更新检查（2026-09）：只读探测 npm latest + 给一条可复制的升级命令。
          为什么放在「关于」页：这是用户唯一会主动查看「我装的是哪一版」的地方；
          检查失败如实显示原因并允许重试，绝不显示成「已是最新」。 */}
      <Card>
        <span className={css.groupLabel}>{t('about.update.title')} <InfoHint text={t('about.update.offline')} label={t('common.infoHint')} /></span>
        <div className={css.statRow} style={{ flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          {state.rows !== null && (
            <Badge kind="info">{t('about.update.current', { version: state.rows.version })}</Badge>
          )}
          {updateView?.kind === 'upToDate' && <Badge kind="ok">{t('about.update.upToDate')}</Badge>}
          {updateView?.kind === 'available' && updateView.latest === appliedVersion && (
            <Badge kind="ok">{t('about.update.applied', { version: appliedVersion ?? '' })}</Badge>
          )}
          {updateView?.kind === 'available' && updateView.latest !== appliedVersion && (
            <Badge kind="warn">
              {t('about.update.available', { latest: updateView.latest, current: updateView.current })}
            </Badge>
          )}
          {updateView?.kind === 'failed' && (
            <Badge kind="error">{t('about.update.failed', { error: updateView.error })}</Badge>
          )}
        </div>

        {updateView?.kind === 'available' && updateView.command !== null && updateView.latest !== appliedVersion && (
          <div className={css.actionRow}>
            <Button variant="primary" onClick={() => setUpdateDialogOpen(true)}>{t('about.update.apply')}</Button>
          </div>
        )}

        {updateView?.kind === 'available' && (
          updateView.command !== null ? (
            <>
              <div className={css.hint}>{t('about.update.commandHint')}</div>
              <pre className={css.cliCommand}>{updateView.command}</pre>
              <div className={css.actionRow}>
                <CopyButton text={updateView.command} label={t('about.update.copyCommand')} t={t} />
                <span className={css.hint}>{t('about.update.copyCommand')}</span>
              </div>
            </>
          ) : (
            <div className={css.hint}>{t('about.update.noCommand')}</div>
          )
        )}

        <div className={css.actionRow}>
          <Button
            onClick={() => { runUpdateCheck(updateView !== null) }}
            loading={updateChecking}
            disabled={updateChecking}
          >
            {updateView === null ? t('about.update.check') : t('about.update.recheck')}
          </Button>
        </div>
      </Card>

      {/* 相关链接卡：Star 主按钮 + 仓库/文档/Issues 链接行 + 作者行（全部外链） */}
      <Card>
        <span className={css.groupLabel}>{t('about.links')}</span>
        <div className={css.actionRow}>
          <Button variant="primary" href={ABOUT_LINKS.starUrl}>{t('about.star')}</Button>
        </div>
        <div className={css.aboutLinkRow}>
          <Button href={ABOUT_LINKS.repoUrl}>{t('about.repo')}</Button>
          <Button href={ABOUT_LINKS.docsUrl}>{t('about.docs')}</Button>
          <Button href={ABOUT_LINKS.issuesUrl}>{t('about.issues')}</Button>
          <Button onClick={() => setReleaseNotesOpen(true)}>{t('about.releaseNotes')}</Button>
        </div>
        <div className={css.authorRow}>
          <span className={css.groupLabel}>{t('about.authorLabel')}</span>
          <a
            className={css.aboutAuthor}
            href={ABOUT_META.authorUrl}
            target="_blank"
            rel="noreferrer"
          >
            {ABOUT_META.author}
          </a>
        </div>
      </Card>

      {/* P1-⑩：CLI 救援工具引导卡（GUI 里唯一能发现 CLI 的地方；独立安装、DSH 挂了也能用） */}
      <Card>
        <span className={css.groupLabel}>{t('about.cli.title')} <InfoHint text={t('about.cli.hint')} label={t('common.infoHint')} /></span>
        <pre className={css.cliCommand}>{ABOUT_CLI.installCommand}</pre>
        <ul className={css.reportList}>
          {ABOUT_CLI.commands.map((c) => (
            <li key={c.command}>
              <code className={css.cliName}>{c.command}</code>
              {' — '}{t(c.descriptionKey)}
            </li>
          ))}
        </ul>
        <div className={css.actionRow}>
          <Button href={ABOUT_CLI.docsUrl}>{t('about.cli.docs')}</Button>
        </div>
      </Card>

      {/* 版本更新内容弹窗（支持向下无限滚动加载） */}
      <ReleaseNotesDialog
        open={releaseNotesOpen}
        onClose={() => setReleaseNotesOpen(false)}
        onConfirm={() => {
          setReleaseNotesOpen(false)
          if (state.rows?.version) {
            void api.saveReleaseNotesPrompt({ lastSeenVersion: state.rows.version }).catch(() => {})
          }
        }}
        onNeverShow={() => {
          setReleaseNotesOpen(false)
          void api.saveReleaseNotesPrompt({ dismissed: true, lastSeenVersion: state.rows?.version }).catch(() => {})
        }}
        t={t}
      />

      {/* 新版本弹窗：「检查更新 → 有新版本」自动打开；GitHub 发布说明 + 一键更新（装完提示重启）。
          只在 command 可用（非 desktop / 已识别档案）时挂载 —— 否则卡片给「插件页更新」提示。 */}
      {updateView?.kind === 'available' && updateView.command !== null && (
        <PluginUpdateDialog
          open={updateDialogOpen}
          current={updateView.current}
          latest={updateView.latest}
          api={api}
          t={t}
          onClose={() => setUpdateDialogOpen(false)}
          onUpdated={(version) => {
            appliedVersionRef.current = version
            setAppliedVersion(version)
          }}
        />
      )}
    </div>
  )
}