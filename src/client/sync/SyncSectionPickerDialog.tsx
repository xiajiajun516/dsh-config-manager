/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncSettingsView 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 *
 * P0-3：新增「逐会话勾选」视图 —— 同一个 Modal 内切换（**不嵌套第二个 Modal**：
 * 双 overlay 会与宿主遮罩互相打架，且关闭语义会变得含糊）。会话单元清单来自
 * /export-preview（与导出页同一份 listUnits 口径），选择模型复用 ContentPicker。
 */
import { useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, Checkbox } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { ContentPicker } from '../common/ContentPicker.tsx'
import type { SelectionSection } from '../../ui/selection-model.ts'
import {
  initialSessionPicks, pickedSessionIds, sessionPickerSelection,
} from '../../ui/sync-settings-view.ts'
import { DEFAULT_SYNC_SESSIONS_LIMIT, syncSectionGroups } from './sync-view.ts'
import type { SyncSectionOption } from './sync-view.ts'
import css from '../config-manager.module.css'

/**
 * 同步分区选择弹窗（Radix Modal，与通道配置弹窗同一体系）：分组勾选 + 「最新 N 个会话」
 * + 逐会话点名。分区一律由用户手动勾选（没有模式分段）。改动**即时生效并持久化**
 * （与导出选择器一致的弹窗语义），因此底部只有「完成」—— 没有「取消」
 * （取消会让用户以为改动被丢弃）。
 */
export function SyncSectionPickerDialog({ open, t, cmT, sectionName, catalog, sections, sessionsLimit, sessionsInclude, sessionNode, sessionPending, sessionFailed, onToggleSection, onSessionsLimit, onSessionsInclude, onClose }: {
  t: TranslateNS<'config-manager-sync'>
  /** config-manager 命名空间的翻译器：ContentPicker 的搜索/全选/合计文案来自它 */
  cmT: TranslateNS<'config-manager'>
  open: boolean
  sectionName: (id: SectionId) => string
  catalog: SyncSectionOption[]
  sections: readonly SectionId[]
  sessionsLimit: number
  /** 显式点名的会话单元 id（非空时优先于 sessionsLimit） */
  sessionsInclude: readonly string[]
  /** 会话单元清单（未取到 / 读取失败 → undefined） */
  sessionNode: SelectionSection | undefined
  sessionPending: boolean
  sessionFailed: boolean
  onToggleSection: (id: SectionId, checked: boolean) => void
  onSessionsLimit: (value: number) => void
  /** 点名结果（空数组 = 回到「最新 N 个」模式） */
  onSessionsInclude: (ids: string[]) => void
  onClose: () => void
}) {
  /** 弹窗内的两个视图：分区目录 / 会话逐项勾选（同一 Modal，不嵌套第二个遮罩） */
  const [view, setView] = useState<'sections' | 'sessions'>('sections')
  // 关闭即复位：下次打开总是回到分区目录（用户的心智入口）
  useEffect(() => { if (!open) setView('sections') }, [open])

  const sessionIds = (sessionNode?.units ?? []).map((u) => u.id)
  const sessionNodes: SelectionSection[] = sessionNode === undefined ? [] : [sessionNode]
  const sessionValue = sessionPickerSelection(
    sessionIds,
    initialSessionPicks(sessionIds, sessionsInclude, sessionsLimit),
  )

  if (view === 'sessions') {
    return (
      <Modal open={open} onClose={onClose} title={t('mode.sessionsPickTitle')} wide>
        <Modal.Header title={t('mode.sessionsPickTitle')} closeLabel={t('common.close')} onClose={onClose} />
        <Modal.Body scroll style={{ maxHeight: '66vh' }}>
          <span className={css.hint}>{t('mode.sessionsPickHint')}</span>
          {/* 会话要在目标机的 DSH 工作区里可见，包内必须有指向它 cwd 的工作区记录。
              同步通道的「工作区」是分区级开关，所以这里只能提示用户一并勾上。 */}
          {sections.includes('sessions') && !sections.includes('workspaces') && (
            <Banner kind="warn">{t('mode.sessionsWorkspaceWarn')}</Banner>
          )}
          {sessionFailed && <span className={css.hint}>{cmT('picker.unitsUnavailable')}</span>}
          {!sessionFailed && sessionNodes.length === 0 && sessionPending && (
            <span className={css.hint}>{t('common.loading')}</span>
          )}
          {!sessionFailed && sessionNodes.length > 0 && (
            <ContentPicker
              nodes={sessionNodes}
              value={sessionValue}
              onChange={(next) => { onSessionsInclude(pickedSessionIds(next, sessionIds)) }}
              t={cmT}
              sectionLabel={sectionName}
              mode="export"
              busy={sessionPending}
            />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => { setView('sections') }}>{t('mode.pickerBack')}</Button>
          <Button variant="primary" onClick={onClose}>{t('mode.pickerDone')}</Button>
        </Modal.Footer>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={t('mode.pickerTitle')} wide>
      <Modal.Header title={t('mode.pickerTitle')} closeLabel={t('common.close')} onClose={onClose} />
      <Modal.Body scroll style={{ maxHeight: '66vh' }}>
        <span className={css.hint}>{t('mode.pickerHint')}</span>
        {catalog.length === 0 ? (
          <span className={css.hint}>{t('common.loading')}</span>
        ) : (
          /* 分组勾选目录：与「导出备份·自定义模式」同构（分组 Card + 名称/描述/徽章），
             分区名走 section-labels 单一映射 —— 与导出选择器显示**同一个中文名**。 */
          <div className={css.groupList}>
            {syncSectionGroups(catalog).map((g) => (
              <Card key={g.group} className={css.groupCard}>
                <div className={css.groupHeader}>
                  <span className={css.groupLabel}>{g.label}</span>
                  {g.note !== undefined && <span className={css.groupNote}>{g.note}</span>}
                </div>
                <div className={css.groupItems}>
                  {g.items.map((s) => (
                    <div key={s.id} className={css.sectionOptionRow}>
                      <Checkbox
                        checked={sections.includes(s.id)}
                        onChange={(checked) => { onToggleSection(s.id, checked) }}
                        label={
                          <span className={css.categoryItem}>
                            {/* 分区显示名只经 sectionLabeler（禁止在本文件另建一套名字） */}
                            <span className={css.categoryName}>{sectionName(s.id)}</span>
                            <span className={css.categoryDesc}>{s.description}</span>
                            {s.portability === 'portable' && <Badge kind="info">{t('mode.sectionPortable')}</Badge>}
                            {s.portability === 'deviceSpecific' && (
                              <Badge kind="warn">{t('mode.sectionDeviceSpecific')}</Badge>
                            )}
                            {s.defaultIncluded && <Badge kind="ok">{t('mode.sectionRecommended')}</Badge>}
                          </span>
                        }
                      />
                      {/* 历史会话专属参数：数量上限 + 逐会话点名。必须放在 Checkbox **之外** ——
                          Checkbox 内部是 label 元素，把输入控件放进去会让点输入框也切换勾选。 */}
                      {s.id === 'sessions' && sections.includes('sessions') && (
                        <div className={css.field}>
                          <label className={css.field}>
                            <span className={css.fieldLabel}>{t('mode.sessionsLimit')}</span>
                            <input
                              type="number"
                              min={0}
                              max={10000}
                              className={css.input}
                              value={String(sessionsLimit)}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                onSessionsLimit(e.target.value === '' ? DEFAULT_SYNC_SESSIONS_LIMIT : Number(e.target.value))
                              }}
                            />
                            <span className={css.hint}>{t('mode.sessionsLimitHint')}</span>
                          </label>
                          <div className={css.actionRowTop}>
                            <Button size="sm" onClick={() => { setView('sessions') }}>{t('mode.sessionsPick')}</Button>
                            {sessionsInclude.length > 0 && (
                              <Badge kind="info">{t('mode.sessionsPickCount', { n: String(sessionsInclude.length) })}</Badge>
                            )}
                            {sessionsInclude.length > 0 && (
                              <Button size="sm" onClick={() => { onSessionsInclude([]) }}>
                                {t('mode.sessionsPickReset')}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
        <span className={css.hint}>{t('mode.sectionsHint')}</span>
        {sections.length === 0 && <Banner kind="warn">{t('mode.atLeastOne')}</Banner>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="primary" onClick={onClose}>{t('mode.pickerDone')}</Button>
      </Modal.Footer>
    </Modal>
  )
}
