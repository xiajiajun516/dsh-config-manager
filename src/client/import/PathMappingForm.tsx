/**
 * 路径映射表单（规范 §12，绑 src/ui/types.ts 的 PathMappingDraft 形状）。
 *
 * 注意：src/ui/path-mapping.ts 的 PathMappingEditor 依赖 utils/paths.ts 的
 * applyPrefixMappings（node:path）——浏览器 bundle 不可用，故此处做轻量等价实现：
 * 输入输出形状与 core 的 PathMapping 完全一致（oldPrefix/newPrefix/appliesTo），
 * 实际前缀替换由 Host 侧 core 在 createImportPlan 阶段执行，本组件只负责收集用户输入。
 */
import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { PathIssue, PathMapping } from '../../core/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { Banner } from '../common/ui.tsx'
import css from '../config-manager.module.css'

export interface PathMappingFormProps {
  /** 分析结果中的路径问题（每条生成一行映射输入） */
  issues: PathIssue[]
  /** 预置映射（如复用上次导入的映射） */
  initial?: PathMapping[]
  t: TranslateNS<'config-manager'>
  /** 映射变化时上报（仅已填写 newPrefix 的条目进入 core） */
  onChange: (mappings: PathMapping[]) => void
}

/**
 * 路径映射表单：每条 PathIssue 一行（原路径 → 新路径输入框），
 * 留空 = 该路径不映射（unresolved）；填写 = 输出 core PathMapping[]。
 */
export function PathMappingForm({ issues, initial, t, onChange }: PathMappingFormProps) {
  // draft 状态：issue.value（oldPrefix）→ newPrefix；预置映射合并进 initial 状态
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const m of initial ?? []) out[m.oldPrefix] = m.newPrefix
    return out
  })

  const setNewPrefix = (oldPrefix: string, value: string): void => {
    const next = { ...drafts, [oldPrefix]: value }
    setDrafts(next)
    const mappings: PathMapping[] = Object.entries(next)
      .filter(([, v]) => v !== '')
      .map(([oldPrefix, newPrefix]) => ({ oldPrefix, newPrefix, appliesTo: [] }))
    onChange(mappings)
  }

  const unresolved = useMemo(() => {
    return issues.filter((issue) => (drafts[issue.value] ?? '') === '')
  }, [issues, drafts])

  return (
    <div className={css.pathMappingList}>
      {unresolved.length > 0 && (
        <Banner kind="warn">{t('import.paths.unresolved', { count: String(unresolved.length) })}</Banner>
      )}
      {issues.length === 0 && <div className={css.empty}>No paths to map</div>}
      {issues.map((issue) => (
        <div key={issue.value} className={css.pathRow}>
          <div className={css.pathOld}>
            <span className={css.fieldLabel}>{t('import.paths.old')}</span>
            <pre className={css.pathValue}>{issue.value}</pre>
            <span className={css.pathIssueKind}>{issue.kind}</span>
          </div>
          <div className={css.pathNew}>
            <span className={css.fieldLabel}>{t('import.paths.new')}</span>
            <input
              className={css.input}
              value={drafts[issue.value] ?? ''}
              placeholder={issue.mappedTo ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setNewPrefix(issue.value, e.target.value) }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
