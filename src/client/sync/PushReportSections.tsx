/**
 * 推送结果弹窗的「分区」段（设计稿 D-12）：稿上是「分区名 · 条数」。
 *
 * 宿主 `/sync/push` 只回分区名，条数只能取自**这次推送前**的只读预览（见 SyncPanel 的 runPush）：
 * 预览缺失时只显示名称，绝不猜数字。
 *
 * 单独成文件是 t42 物理拆分的延续：SyncPanel 已贴体量棘轮上限
 * （tests/file-size-ratchet.test.ts），新增渲染段一律新开文件。
 */
import css from '../config-manager.module.css'

export interface PushReportSectionsProps {
  /** 分区 id 列表（顺序即宿主返回顺序）。 */
  sections: readonly string[]
  /** 分区 id → 条数；缺该键时只渲染分区名。 */
  counts: Readonly<Record<string, number>>
  /** 分区 id → 显示名（统一走 common/section-labels.ts）。 */
  sectionName: (id: string) => string
  /** 段标题（字典键由调用方给）。 */
  label: string
}

export function PushReportSections({ sections, counts, sectionName, label }: PushReportSectionsProps) {
  return (
    <div>
      <span className={css.fieldLabel}>{label}</span>
      <ul className={css.reportList}>
        {sections.map((id) => {
          const count = counts[id]
          return <li key={id}>{count === undefined ? sectionName(id) : `${sectionName(id)} · ${count}`}</li>
        })}
      </ul>
    </div>
  )
}
