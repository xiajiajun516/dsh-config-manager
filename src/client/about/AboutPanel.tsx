/**
 * 「关于（About）」面板（设置页第 6 个 tab 内容，docs/design/2026-08-19-about-tab-design.md §4）。
 *
 * 纯静态展示视图 + 外链，无表单 / 无写操作 / 无新增依赖：
 * - 项目信息卡：插件名 + 官方 Badge；版本 / DSH / 平台 Badge（运行时信息，经 api.status() 获取）；
 * - 相关链接卡：Star 主按钮（外链）+ 仓库 / 文档 / Issues 链接行 + 作者行；
 * - 公开元数据（名称 / 仓库 / 作者 / 链接）全部来自 ./about-view.ts 的 ABOUT_META / ABOUT_LINKS
 *   （静态常量，单一来源，node 单测覆盖）；
 * - 状态行格式化委托 ./about-view.ts 的 aboutStatusRows 纯函数（组件不实现可测试业务逻辑）；
 * - 版本号不在此重复维护 —— 展示值一律来自 status()（AGENTS.md §版本号三处同步教训）。
 *
 * 安全：无任何输入表单（无 secret 泄漏面）；外链一律 target="_blank" + rel="noreferrer"
 * （防 tabnabbing）；错误文本渲染前经 redact() 兜底（安全不变量）。
 * 状态组件内自持（低频静态视图，同 Snapshots/Sync/Market 策略，不进 sessionStorage）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi } from '../api.ts'
import { Badge, Banner, Button, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { ABOUT_LINKS, ABOUT_META, aboutStatusRows } from './about-view.ts'
import type { AboutStatusRows } from './about-view.ts'
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
  const patch = (p: Partial<AboutUiState>): void => setState((s) => ({ ...s, ...p }))

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

  useEffect(() => {
    void loadStatus()
    // api 为注入单例（注册时创建），生命周期内稳定；仅挂载时加载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('about.title')} subtitle={t('about.subtitle')} />

      {/* 项目信息卡：插件名 + 官方 Badge；版本 / DSH / 平台（动态，经 status()） */}
      <Card>
        <span className={css.groupLabel}>{ABOUT_META.name}</span>
        <div className={css.statRow}>
          <Badge kind="ok">{t('about.official')}</Badge>
        </div>
        {state.loading && (
          <div className={css.statRow}>
            <Spinner label={t('about.loading')} />
          </div>
        )}
        {state.loadError !== null && (
          <div>
            <Banner kind="error">{redact(state.loadError)}</Banner>
            <div className={css.actionRow}>
              <Button onClick={() => { void loadStatus() }}>{t('about.retryStatus')}</Button>
            </div>
          </div>
        )}
        {state.rows !== null && (
          <div className={css.statRow}>
            <Badge kind="info">{t('about.version', { version: state.rows.version })}</Badge>
            <Badge kind="info">{t('about.dshVersion', { version: state.rows.dsh })}</Badge>
            <Badge kind="info">{state.rows.platform}</Badge>
          </div>
        )}
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
        </div>
        <div className={css.statRow}>
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
    </div>
  )
}