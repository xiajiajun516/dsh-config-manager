/**
 * 备份内容查看 + 「与此备份 diff」只读视图（P1-⑦ / P2-⑬，绑 src/ui/backup-inspect.ts 纯函数）。
 *
 * 原住在 SnapshotsPanel 内部，产物库的「查看与对比」也要用同一份，
 * 所以整块搬到这里 —— **不做第二份实现**（渲染模型本来就是共享的纯函数）。
 * 分区清单 + 差异摘要徽章 + 逐项变更列表（限高内滚）。只读，不提供任何执行入口。
 */
import { inspectGroupedChanges, inspectSections, inspectSummary, type InspectGroupKey } from '../../ui/backup-inspect.ts'
// 脱敏：计划项文本由宿主拼装，渲染前必须过 redact（安全自查）
import { redact } from '../../security/redaction.ts'
import type { BackupInspectResult } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge } from '../common/ui.tsx'
import css from '../config-manager.module.css'

export interface BackupInspectViewProps {
  result: BackupInspectResult
  t: TranslateNS<'config-manager'>
}

export function BackupInspectView({ result, t }: BackupInspectViewProps) {
  const sections = inspectSections(result.analysis, result.plan)
  const summary = inspectSummary(result.analysis, result.plan)
  // 分组标题字典键（冲突/变更/路径映射/一致跳过/其他 —— 与 InspectGroupKey 一一对应）
  const groupLabelKey = (key: InspectGroupKey): 'backupFiles.inspectGroup.conflicts' | 'backupFiles.inspectGroup.changes' | 'backupFiles.inspectGroup.paths' | 'backupFiles.inspectGroup.skipped' | 'backupFiles.inspectGroup.others' => {
    switch (key) {
      case 'conflicts': return 'backupFiles.inspectGroup.conflicts'
      case 'changes': return 'backupFiles.inspectGroup.changes'
      case 'paths': return 'backupFiles.inspectGroup.paths'
      case 'skipped': return 'backupFiles.inspectGroup.skipped'
      case 'others': return 'backupFiles.inspectGroup.others'
    }
  }
  const groups = inspectGroupedChanges(summary)
  return (
    <div>
      {/* 分区清单（条目计数徽章） */}
      <div className={css.inspectGroup}>
        <div className={css.groupLabel}>{t('backupFiles.inspectSections')}</div>
        <div className={css.statRow}>
          {sections.map((s) => (
            <Badge key={s.section} kind="info">{s.section}: {s.count}</Badge>
          ))}
        </div>
      </div>

      {/* 差异摘要（导这个备份会动你什么） */}
      <div className={css.inspectGroup}>
        <div className={css.groupLabel}>{t('backupFiles.inspectDiff')}</div>
        <div className={css.statRow}>
          {summary.willChange > 0 && <Badge kind="info">{t('import.preview.willChange', { count: String(summary.willChange) })}</Badge>}
          {summary.unchanged > 0 && <Badge kind="ok">{t('import.preview.unchanged', { count: String(summary.unchanged) })}</Badge>}
          {summary.conflicts > 0 && <Badge kind="error">{t('import.preview.conflicts', { count: String(summary.conflicts) })}</Badge>}
          {summary.secretsNeeded > 0 && <Badge kind="warn">{t('import.preview.secrets', { count: String(summary.secretsNeeded) })}</Badge>}
          {summary.pathMappingsNeeded > 0 && <Badge kind="warn">{t('import.preview.paths', { count: String(summary.pathMappingsNeeded) })}</Badge>}
          {summary.needsRestart && <Badge kind="warn">{t('report.needsRestart')}</Badge>}
        </div>
      </div>

      {/* 变更明细：按优先级分组（冲突 → 变更 → 路径映射 → 一致跳过 → 其他） */}
      {groups.length > 0 && (
        <div className={css.inspectGroup}>
          <div className={css.groupLabel}>{t('backupFiles.inspectItems')}</div>
          {groups.map((group) => (
            <div key={group.key} className={css.inspectGroup}>
              <div className={css.groupHeader}>
                <span className={css.groupLabel}>{t(groupLabelKey(group.key))}</span>
                <Badge kind={group.kind}>{String(group.items.length)}</Badge>
              </div>
              <div className={css.reportScroll}>
                <ul className={css.reportList}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      {/* 逐项不再重复 kind：分组标题已按 kind 命名，裸枚举值（Create/Skip…）没有第二种说法。
                          前导 {' '} 是 plan-text-redaction 逐字锚点的一部分，别删（见该表 snapshot-inspect-description）。
                          差异查看的计划项文本由宿主拼装 → 渲染前过 redact（安全自查） */}
                      {' '}{item.adapter}: {redact(item.description)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
