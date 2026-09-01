/**
 * ReleaseNotesDialog —— GitHub Releases 版本更新内容弹窗。
 *
 * 特性：
 * - 动态拉取 GitHub Releases 真实数据（过滤草稿）
 * - 支持向下无限滚动加载更多版本（分页 pagination）
 * - 纯安全 Markdown 渲染（不使用 dangerouslySetInnerHTML，杜绝 XSS）
 * - 各版本状态徽章（最新 / 预发布）、发布日期与对应 GitHub Release 快速跳转
 * - 遵循 --dsw-* token 与 dialog 体系样式（dialogMask / dialogCard / dialogWide）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Spinner } from '../common/ui.tsx'
import { ABOUT_META } from './about-view.ts'
import {
  deriveReleasesUrl,
  fetchReleases,
  parseMarkdownBlocks,
  type FormattedRelease,
  type MarkdownBlock,
} from './release-notes-view.ts'
import css from '../config-manager.module.css'

export interface ReleaseNotesDialogProps {
  open: boolean
  onClose: () => void
  onConfirm?: () => void
  onNeverShow?: () => void
  t: TranslateNS<'config-manager'>
  repoUrl?: string
}

const PAGE_SIZE = 5

/**
 * 纯 React 安全渲染 Markdown 文本行中的行内格式（粗体、行内代码、链接）。
 */
function renderInlineMarkdown(text: string) {
  // 简单行内解析：`code`, **bold**, [link](url)
  // 分割正则
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  const parts = text.split(regex)

  return parts.map((part, idx) => {
    if (!part) return null
    // 行内代码 `...`
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code key={idx} className={css.cliName}>
          {part.slice(1, -1)}
        </code>
      )
    }
    // 粗体 **...**
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>
    }
    // 链接 [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className={css.aboutAuthor}
        >
          {linkMatch[1]}
        </a>
      )
    }
    return <span key={idx}>{part}</span>
  })
}

/**
 * 渲染单个结构化 Markdown 块。
 */
function MarkdownBlockView({ block }: { block: MarkdownBlock }) {
  switch (block.type) {
    case 'heading': {
      const headingStyle = {
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        marginTop: block.level === 1 ? '12px' : '8px',
        marginBottom: '4px',
        fontSize: block.level === 1 ? '15px' : block.level === 2 ? '14px' : '13px',
      }
      return <div style={headingStyle}>{block.text}</div>
    }
    case 'list-item': {
      return (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-start', paddingLeft: '4px' }}>
          <span style={{ color: 'var(--dsw-alias-label-tertiary)', userSelect: 'none' }}>
            {block.ordered ? `${block.index ?? 1}.` : '•'}
          </span>
          <div style={{ flex: 1 }}>{renderInlineMarkdown(block.text)}</div>
        </div>
      )
    }
    case 'quote': {
      return (
        <div
          style={{
            borderLeft: '3px solid var(--dsw-alias-border-l1)',
            paddingLeft: '8px',
            color: 'var(--dsw-alias-label-secondary)',
            fontStyle: 'italic',
          }}
        >
          {renderInlineMarkdown(block.text)}
        </div>
      )
    }
    case 'code-block': {
      return (
        <pre
          className={css.cliCommand}
          style={{ margin: '4px 0', padding: '8px', fontSize: '12px' }}
        >
          {block.code}
        </pre>
      )
    }
    case 'hr': {
      return (
        <div
          style={{
            borderBottom: '1px solid var(--dsw-alias-border-l2)',
            margin: '8px 0',
          }}
        />
      )
    }
    case 'paragraph':
    default: {
      return <div>{renderInlineMarkdown(block.text)}</div>
    }
  }
}

/**
 * 单个版本的卡片视图。
 */
function ReleaseCardView({
  release,
  isFirst,
  t,
}: {
  release: FormattedRelease
  isFirst: boolean
  t: TranslateNS<'config-manager'>
}) {
  const blocks = parseMarkdownBlocks(release.body)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
      }}
    >
      {/* 头部：版本号 + 标题 + 徽章 + 日期 + 外链 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--dsw-alias-label-primary)',
            }}
          >
            {release.title}
          </span>
          {isFirst && !release.isPrerelease && (
            <Badge kind="ok">{t('about.releaseNotes.latest')}</Badge>
          )}
          {release.isPrerelease && (
            <Badge kind="warn">{t('about.releaseNotes.prerelease')}</Badge>
          )}
          {release.publishedDateStr && (
            <span
              style={{
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              {release.publishedDateStr}
            </span>
          )}
        </div>

        <Button
          href={release.url}
          title={t('about.releaseNotes.viewSingleOnGithub')}
          className={css.dialogClose}
        >
          {t('about.releaseNotes.viewSingleOnGithub')} ↗
        </Button>
      </div>

      {/* 正文：结构化 Markdown 块渲染 */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          fontSize: '13px',
          lineHeight: '1.6',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {blocks.length > 0 ? (
          blocks.map((block, idx) => <MarkdownBlockView key={idx} block={block} />)
        ) : (
          <div style={{ color: 'var(--dsw-alias-label-tertiary)', fontStyle: 'italic' }}>
            {t('about.releaseNotes.noBody')}
          </div>
        )}
      </div>
    </div>
  )
}

export function ReleaseNotesDialog({
  open,
  onClose,
  onConfirm,
  onNeverShow,
  t,
  repoUrl = ABOUT_META.repoUrl,
}: ReleaseNotesDialogProps) {
  const [releases, setReleases] = useState<FormattedRelease[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const isFetchingRef = useRef(false)

  const handleConfirm = () => {
    if (onConfirm) {
      onConfirm()
    } else {
      onClose()
    }
  }

  const handleNeverShow = () => {
    if (onNeverShow) {
      onNeverShow()
    } else {
      onClose()
    }
  }

  // 初始加载第一页
  const loadFirstPage = useCallback(async () => {
    setLoading(true)
    setError(null)
    setReleases([])
    setPage(1)
    setHasMore(true)
    isFetchingRef.current = true

    try {
      const result = await fetchReleases(repoUrl, 1, PAGE_SIZE)
      setReleases(result.releases)
      setHasMore(result.hasMore)
      setPage(1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      isFetchingRef.current = false
    }
  }, [repoUrl])

  // 加载更多页
  const loadNextPage = useCallback(async () => {
    if (isFetchingRef.current || !hasMore || loading || loadingMore) return
    isFetchingRef.current = true
    setLoadingMore(true)
    const nextPage = page + 1

    try {
      const result = await fetchReleases(repoUrl, nextPage, PAGE_SIZE)
      setReleases((prev) => [...prev, ...result.releases])
      setHasMore(result.hasMore)
      setPage(nextPage)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingMore(false)
      isFetchingRef.current = false
    }
  }, [hasMore, loading, loadingMore, page, repoUrl])

  // 打开时触发初次加载
  useEffect(() => {
    if (open) {
      void loadFirstPage()
    }
  }, [open, loadFirstPage])

  // Esc 按键关闭弹窗
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 滚动到底部触发加载更多
  const handleScroll = () => {
    const el = bodyRef.current
    if (!el) return
    const scrollBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (scrollBottom < 100 && hasMore && !loading && !loadingMore && !error) {
      void loadNextPage()
    }
  }

  if (!open) return null

  const releasesPageUrl = deriveReleasesUrl(repoUrl)

  return (
    <div
      className={css.dialogMask}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`${css.dialogCard} ${css.dialogWide}`}
        style={{ width: 'min(640px, 100%)', maxHeight: '85vh' }}
      >
        {/* 头部：标题与关闭按钮 */}
        <div className={css.dialogHeaderRow}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className={css.dialogHeader}>{t('about.releaseNotes.title')}</span>
          </div>
          <button
            type="button"
            className={css.dialogClose}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>

        {/* 正文可滚动区（支持下拉滚动加载更多） */}
        <div
          ref={bodyRef}
          className={css.dialogBodyScroll}
          onScroll={handleScroll}
          style={{ maxHeight: '65vh', gap: '12px' }}
        >
          {loading && (
            <div style={{ padding: '24px 0', display: 'flex', justifyContent: 'center' }}>
              <Spinner label={t('about.releaseNotes.loading')} />
            </div>
          )}

          {error !== null && (
            <div>
              <Banner kind="error">{error}</Banner>
              <div className={css.actionRow} style={{ marginTop: '8px' }}>
                <Button onClick={() => { void loadFirstPage() }}>
                  {t('about.releaseNotes.retry')}
                </Button>
                <Button href={releasesPageUrl}>
                  {t('about.releaseNotes.viewOnGithub')}
                </Button>
              </div>
            </div>
          )}

          {!loading && error === null && releases.length === 0 && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' }}>
              {t('about.releaseNotes.empty')}
            </div>
          )}

          {!loading &&
            releases.map((release, index) => (
              <ReleaseCardView
                key={release.id}
                release={release}
                isFirst={index === 0}
                t={t}
              />
            ))}

          {loadingMore && (
            <div style={{ padding: '12px 0', display: 'flex', justifyContent: 'center' }}>
              <Spinner label={t('about.releaseNotes.loadingMore')} />
            </div>
          )}

          {!loading && !loadingMore && !hasMore && releases.length > 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: '8px 0',
                fontSize: '12px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              — {t('about.releaseNotes.allLoaded')} —
            </div>
          )}
        </div>

        {/* 底部按钮区 */}
        <div
          className={css.actionRow}
          style={{
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid var(--dsw-alias-border-l1)',
            paddingTop: '10px',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <Button href={releasesPageUrl}>{t('about.releaseNotes.viewOnGithub')}</Button>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Button onClick={handleNeverShow}>
              {t('about.releaseNotes.neverShow')}
            </Button>
            <Button variant="primary" onClick={handleConfirm}>
              {t('about.releaseNotes.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
