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
import { Banner, IconButton } from '../common/ui.tsx'
import { FolderOpenIcon } from '../common/Icon.tsx'
import { PathPickerDialog } from './PathPickerDialog.tsx'
import type { PathBrowsePort } from './PathPickerDialog.tsx'
import css from '../config-manager.module.css'

/**
 * 路径来源徽章 → 字典键（UI-18 同款做法：core 只给**形态语义**，用户可见文案只在这里解析）。
 * 此前直接渲染 `issue.kind` 字面量（missing / platformMismatch）—— 用户报告「源路径永远是 missing」：
 * core 的 missing 语义是「需为本机指定新位置」（**不做存在性探测**），不是「源路径不存在」。
 */
const PATH_ISSUE_LABEL: Record<PathIssue['kind'], Parameters<TranslateNS<'config-manager'>>[0]> = {
  missing: 'import.paths.kind.missing',
  platformMismatch: 'import.paths.kind.platformMismatch',
  homeMismatch: 'import.paths.kind.homeMismatch',
}

export interface PathMappingFormProps {
  /** 分析结果中的路径问题（每条生成一行映射输入） */
  issues: PathIssue[]
  /** 预置映射（如复用上次导入的映射） */
  initial?: PathMapping[]
  t: TranslateNS<'config-manager'>
  /** 映射变化时上报（仅已填写 newPrefix 的条目进入 core） */
  onChange: (mappings: PathMapping[]) => void
  /** 本机路径来源：原生选择器优先，内置目录浏览器兜底（同一条宿主端点 /path-browse） */
  api: PathBrowsePort
}

/**
 * 路径映射表单：每条 PathIssue 一行（原路径 → 新路径输入框），
 * 留空 = 该路径不映射（unresolved）；填写 = 输出 core PathMapping[]。
 */
export function PathMappingForm({ issues, initial, t, onChange, api }: PathMappingFormProps) {
  // 正在为哪条路径挑目录（oldPrefix 作 key；null = 弹窗关闭）
  const [pickingFor, setPickingFor] = useState<string | null>(null)
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

  /**
   * 文件夹按钮的完整动作：**先请系统原生目录选择器**（Windows = 资源管理器同款「选择文件夹」窗口，
   * macOS = Finder 面板，Linux = zenity/kdialog），拿到绝对路径就直接回填。
   *
   * 只有「平台不支持 / 弹窗自身失败」才回落到内置目录浏览器 —— 两条路都能给出绝对路径，
   * 区别只是用谁家的窗口；用户取消则什么都不做（不是错误，不弹红条）。
   */
  const pickFolder = (oldPrefix: string): void => {
    const startPath = (drafts[oldPrefix] ?? '').trim()
    api.pickNativePath(startPath, t('import.paths.picker.title')).then(
      (result) => {
        if (result.ok) {
          setNewPrefix(oldPrefix, result.path)
          return
        }
        if (result.reason === 'canceled') return
        setPickingFor(oldPrefix) // unsupported / failed → 内置浏览器兜底
      },
      () => { setPickingFor(oldPrefix) }, // 请求本身失败（宿主不可达等）同样回落，不堵住用户
    )
  }

  const unresolved = useMemo(() => {
    return issues.filter((issue) => (drafts[issue.value] ?? '') === '')
  }, [issues, drafts])

  return (
    <div className={css.pathMappingList}>
      {/* UI-18：留空 = 跳过该路径是**合法**操作（文案本身说明如此），且本页「下一步」不拦截 ——
          因此这里用中性 info 语义而不是 warn（DESIGN.md §9 anti-pattern 3：warn/error 语义色
          不得用于建议性内容；黄色横幅在首屏就会被读成「出错了」）。计数随输入实时更新。 */}
      {unresolved.length > 0 && (
        <Banner kind="info">{t('import.paths.unresolved', { count: String(unresolved.length) })}</Banner>
      )}
      {issues.length === 0 && <div className={css.empty}>{t('import.paths.empty')}</div>}
      {issues.map((issue) => (
        <div key={issue.value} className={css.pathRow}>
          <div className={css.pathOld}>
            {/* 块级 label：标题独占一行（原 span 为行内元素，会与 input 挤在同一行） */}
            <div className={css.fieldLabel}>{t('import.paths.old')}</div>
            <pre className={css.pathValue}>{issue.value}</pre>
            <span className={css.pathIssueKind}>{t(PATH_ISSUE_LABEL[issue.kind])}</span>
          </div>
          <div className={css.pathNew}>
            <div className={css.fieldLabel}>{t('import.paths.new')}</div>
            {/* 输入行 = 手打 + 原生选择器（不可用时回落宿主的目录浏览器；浏览器本身拿不到本机路径） */}
            <div className={css.pathInputRow}>
              <input
                className={css.input}
                value={drafts[issue.value] ?? ''}
                placeholder={issue.mappedTo ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => { setNewPrefix(issue.value, e.target.value) }}
              />
              <IconButton
                icon={<FolderOpenIcon size={14} />}
                label={t('import.paths.browse')}
                onClick={() => { pickFolder(issue.value) }}
              />
            </div>
          </div>
        </div>
      ))}
      <PathPickerDialog
        open={pickingFor !== null}
        api={api}
        t={t}
        startPath={pickingFor === null ? '' : (drafts[pickingFor] ?? '')}
        onPick={(path) => {
          if (pickingFor !== null) setNewPrefix(pickingFor, path)
          setPickingFor(null)
        }}
        onClose={() => { setPickingFor(null) }}
      />
    </div>
  )
}
