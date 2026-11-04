/**
 * ReleaseBody —— GitHub Release 正文的结构化安全渲染（**共享原语**）。
 *
 * 为什么抽出来：「更新内容」浏览弹窗（ReleaseNotesDialog）与新版本弹窗（PluginUpdateDialog）
 * 都要渲染 release 正文 —— 渲染规则必须只有一份：纯文本分块解析 + 行内格式
 * （`code` / **bold** / [link](url)），**零 dangerouslySetInnerHTML**（杜绝 XSS）。
 * 本组件从 ReleaseNotesDialog 原样搬出（含内联样式），视觉与行为逐字不变。
 */
import type { TranslateNS } from '../client-types.ts'
import { parseMarkdownBlocks, type MarkdownBlock } from './release-notes-view.ts'
import css from '../config-manager.module.css'

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
      /**
       * 只有字号还留在内联：15/14/13px 三级要靠同一规则表达，而 DESIGN.md §4 的字号 scale
       * 只有 4 档（11/12/12.5/13）—— 把 15/14 写进 CSS 会让 scale-01 直接变红。
       * 这是 css-token-guard 豁免表里唯一一条 release 相关例外（见 TSX_STYLE_WHITELIST）。
       */
      return (
        <div
          className={css.releaseHeading}
          data-level={String(block.level)}
          style={{ fontSize: block.level === 1 ? '15px' : block.level === 2 ? '14px' : '13px' }}
        >
          {block.text}
        </div>
      )
    }
    case 'list-item': {
      return (
        <div className={css.releaseListItem}>
          <span className={css.releaseBullet}>
            {block.ordered ? (block.index ?? 1) + '.' : '•'}
          </span>
          <div className={css.releaseItemBody}>{renderInlineMarkdown(block.text)}</div>
        </div>
      )
    }
    case 'quote': {
      return <div className={css.releaseQuote}>{renderInlineMarkdown(block.text)}</div>
    }
    case 'code-block': {
      return <pre className={css.cliCommand + ' ' + css.releaseCode}>{block.code}</pre>
    }
    case 'hr': {
      return <div className={css.releaseRule} />
    }
    case 'paragraph':
    default: {
      return <div>{renderInlineMarkdown(block.text)}</div>
    }
  }
}

/** release 正文：结构化块渲染；空正文显示「暂无详细说明」。 */
export function ReleaseBody({ body, t }: { body: string; t: TranslateNS<'config-manager'> }) {
  const blocks = parseMarkdownBlocks(body)
  return (
    <div className={css.releaseBody}>
      {blocks.length > 0 ? (
        blocks.map((block, idx) => <MarkdownBlockView key={idx} block={block} />)
      ) : (
        <div className={css.releaseEmpty}>{t('about.releaseNotes.noBody')}</div>
      )}
    </div>
  )
}
