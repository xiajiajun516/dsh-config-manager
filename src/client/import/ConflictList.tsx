/**
 * 冲突决策列表（规范 §11，绑 src/ui/conflict-view.ts 的 ConflictCollector）。
 *
 * 渲染 plan 中 kind === 'Conflict' 的项，用户逐项选择
 * Keep Current / Use Imported；决策实时写入 collector，
 * 完成时父组件调用 collector.toResolutions() → wizard.setResolutions()。
 *
 * 注意：不提供 "Review（稍后决定）" 选项——Review 会被收集器计为
 * unresolved，导致「下一步」永远禁用（死路）。要么决策，要么不进入本步。
 */
import { useState } from 'react'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import type { ItemResolution } from '../../core/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { Banner, Button } from '../common/ui.tsx'
import css from '../config-manager.module.css'

export interface ConflictListProps {
  collector: ConflictCollector
  t: TranslateNS<'config-manager'>
  /** 任意决策变化后通知父组件刷新（tick） */
  onChanged: () => void
}

const RESOLUTION_OPTIONS: { value: ItemResolution; key: string }[] = [
  { value: 'keepCurrent', key: 'import.conflicts.keepCurrent' },
  { value: 'useImported', key: 'import.conflicts.useImported' },
]

/** 批量决策全部冲突项（keepCurrent / useImported；下沉到 ConflictCollector.resolveAll 纯函数，
 *  组件只做装配 + tick/onChanged 通知；与逐项逻辑一致地更新 UI） */
function resolveAll(
  collector: ConflictCollector,
  resolution: Extract<ItemResolution, 'keepCurrent' | 'useImported'>,
  setTick: (fn: (v: number) => number) => void,
  onChanged: () => void,
): void {
  collector.resolveAll(resolution)
  setTick((v) => v + 1)
  onChanged()
}

/** 冲突项决策列表 */
export function ConflictList({ collector, t, onChanged }: ConflictListProps) {
  const [tick, setTick] = useState(0)
  const items = collector.viewItems()
  const unresolved = collector.unresolved().length
  const hasConflicts = items.length > 0

  return (
    <div className={css.conflictList}>
      {unresolved > 0 && <Banner kind="warn">{t('import.conflicts.unresolved', { count: String(unresolved) })}</Banner>}

      {/* 批量决策按钮（无冲突项时禁用；逐项单选仍可微调） */}
      <div className={css.actionRow}>
        <Button
          variant="ghost"
          disabled={!hasConflicts}
          onClick={() => { resolveAll(collector, 'keepCurrent', setTick, onChanged) }}
        >
          {t('import.conflicts.keepCurrentAll')}
        </Button>
        <Button
          variant="primary"
          disabled={!hasConflicts}
          onClick={() => { resolveAll(collector, 'useImported', setTick, onChanged) }}
        >
          {t('import.conflicts.useImportedAll')}
        </Button>
      </div>

      {items.map((view) => {
        const item = view.item
        return (
          <div key={item.id} className={css.conflictItem}>
            <div className={css.conflictHead}>
              <span className={css.conflictId}>{item.adapter}: {item.description}</span>
              {item.severity === 'error' && <span className={css.severityError}>error</span>}
            </div>
            {item.detail !== undefined && item.detail !== '' && (
              <pre className={css.conflictDetail}>{item.detail}</pre>
            )}
            <div className={css.conflictOptions}>
              {RESOLUTION_OPTIONS.map((opt) => (
                <label key={opt.value} className={css.radioLabel}>
                  <input
                    type="radio"
                    name={`conflict-${item.id}`}
                    checked={view.resolution === opt.value}
                    onChange={() => {
                      collector.resolve(item.id, opt.value)
                      setTick((v) => v + 1)
                      onChanged()
                    }}
                  />
                  {t(opt.key as 'import.conflicts.keepCurrent' | 'import.conflicts.useImported')}
                </label>
              ))}
            </div>
          </div>
        )
      })}
      {items.length === 0 && <div className={css.empty}>No conflicts</div>}
      {void tick}
    </div>
  )
}
