/**
 * 可操作错误展示（规范 §23，绑 src/ui/errors.ts）。
 *
 * 安全约束：**强制 redact 不泄 Secret** —— 展示前对错误消息、关联项文本
 * 统一过 `redact()`（字段名黑名单 + sk-/JWT/PEM/Bearer 等值形状模式），
 * 渲染结果只含 Reason / Suggested action / Item，绝不出现密钥原文。
 */
import { useMemo } from 'react'
import { formatActionableError, toActionableError } from '../../ui/errors.ts'
import { redact } from '../../security/redaction.ts'
import { zhUiT, type UiT } from '../../ui/i18n.ts'
import { Button, Spinner } from './ui.tsx'
import { ArrowRightIcon } from './Icon.tsx'
import css from '../config-manager.module.css'

export interface ErrorBannerProps {
  /** 任意未知错误（Error / 字符串 / API 错误） */
  error: unknown
  /** 可重试时显示的重试按钮（缺省不显示） */
  onRetry?: () => void
  /** 重试中的 loading 态 */
  retrying?: boolean
  /** 展示层翻译器（缺省 zh；ErrorBanner 为通用组件，不绑定 settings 命名空间字典） */
  t?: UiT
}

/**
 * 错误横幅：toActionableError（**带当前语言 t**）解析为标题 + 原因 + 建议动作，
 * 文本在渲染前再经 redact() 兜底（双保险），Reason 以等宽块展示。
 * 重试按钮：进行中（retrying）时显示 Spinner 并禁用（防重复点击）。
 */
export function ErrorBanner({ error, onRetry, retrying, t = zhUiT }: ErrorBannerProps) {
  /**
   * UI-20：解析结果必须由 `error` **派生**（useMemo），不能是只在挂载时求值一次的 useState ——
   * 同一横幅上 error 被替换后（如连续两次失败原因不同），标题/原因/建议动作/可重试判定会
   * 全部停留在第一次解析的结果，展示与输入不一致。
   * F-02：`t` 必须一并传给 toActionableError（src/ui/errors.ts 已支持 { t }；规则表按 t 构造），
   * 否则英文界面下错误标题与建议动作恒为中文。
   */
  const actionable = useMemo(() => toActionableError(error, { t }), [error, t])
  const reason = redact(actionable.reason)
  const item = actionable.item !== undefined ? redact(actionable.item) : undefined

  return (
    <div className={css.errorBanner} role="alert">
      <div className={css.errorTitle}>{redact(actionable.title)}</div>
      <pre className={css.errorReason}>{reason}</pre>
      {actionable.suggestedAction !== undefined && (
        <div className={css.errorAction}>
          <span className={css.errorActionLabel}><ArrowRightIcon size={13} /></span> {redact(actionable.suggestedAction)}
        </div>
      )}
      {item !== undefined && <div className={css.errorItem}>{item}</div>}
      {actionable.retryable && onRetry !== undefined && (
        <div className={css.errorFooter}>
          <Button variant="primary" onClick={onRetry} disabled={retrying === true} loading={retrying === true}>
            {retrying === true ? <Spinner /> : t('commonRetry')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** 多行错误文本展示（Wizard.errors 数组用；同样强制 redact） */
export function ErrorList({ errors }: { errors: readonly string[] }) {
  if (errors.length === 0) return null
  return (
    <div className={css.errorList}>
      {errors.map((line, i) => (
        <pre key={i} className={css.errorLine}>{redact(line)}</pre>
      ))}
    </div>
  )
}

/** formatActionableError 的文本化出口（供非 React 渲染场景复用） */
export function formatErrorText(error: unknown): string {
  return formatActionableError(toActionableError(error))
}
