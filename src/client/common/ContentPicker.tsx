/**
 * 内容选择器（ContentPicker）—— 两级树：分区 → 最小可拆单元。
 *
 * 定位：**唯一**的内容勾选组件。导出页与导入向导预览步（Phase 2）已共用同一个组件，
 * 市场通道接入时同样复用 —— 「同样的勾选框不一样的行为」是本仓库明确要消灭的状态。
 *
 * 与 SectionComposition 的分工：那个是只读的「分区构成」网格（总览页「分区构成」卡 /
 * 导出页「本次将导出」数据块共用），这个是可交互的选择器。两者不是替代关系，禁止合并。
 *
 * 职责边界：本组件**只渲染与转发交互**，全部选择语义（稀疏排除集、原子组联动、
 * 三态判定、请求参数换算）都在 `src/ui/selection-model.ts` 里，node 可测。
 */
import { useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import {
  filterSections, groupPickState, groupUnits, middleEllipsis, pickerSummary, sectionPickState,
  selectAll, selectedUnitCount, toggleSection, toggleUnit, toggleUnitGroup, visibleUnits,
  type Selection, type SelectionSection, type SelectionUnit,
} from '../../ui/selection-model.ts'
import { formatBytes } from '../../ui/report.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Button, Checkbox, Spinner } from './ui.tsx'
import { Icon } from './Icon.tsx'
import css from '../config-manager.module.css'

/** 单元名显示长度上限（配合 .pickerUnitName 的 CSS 省略做兜底；UI-16） */
const UNIT_NAME_MAX = 44

/** 单元列表容器 id（展开按钮的 aria-controls 指向它；UI-22） */
function unitsId(section: SectionId): string {
  return `picker-units-${section}`
}

export interface ContentPickerProps {
  /** 分区 + 可勾选单元（由 /export-preview 的 items 派生；units 为空 = 不可细分） */
  nodes: SelectionSection[]
  value: Selection
  onChange: (next: Selection) => void
  t: TranslateNS<'config-manager'>
  /** 分区显示名（SectionId → 人类可读标签）；缺省原样显示 id */
  sectionLabel?: (id: SectionId) => string
  /** 清单加载中（首次打开 / 分区集合变化时） */
  loading?: boolean
  /**
   * 清单**读取失败**的分区（非致命：仍可按整个分区导出）。
   * 逐分区记账（不是一个数字）：失败分区行内要给出「读取失败 · 将整体导出」，
   * 并**不显示**会误导的「已选 0/0」—— 引擎对清单缺失的分区按整体导出处理（UI-07）。
   */
  failedSections?: SectionId[]
  /**
   * 正在读取清单（任意分区）。true 时在列表上加**遮罩 + 加载动画** ——
   * 勾选大分区（如 sessions）要读很久，没有反馈会被当成卡死。
   * 注意：不隐藏列表（用户要能看见自己刚勾了什么），只做半透明遮罩。
   */
  busy?: boolean
  /** 正在读取中的分区 id（行内显示「读取中」而不是误导性的 0/0） */
  pendingSections?: SectionId[]
  /**
   * 高风险分区判定（市场通道传入）：命中时在该分区行渲染「高风险」徽章。
   *
   * 缺省不传 = 导入页 / 导出页**零变化**（那两个调用点的分区风险由 portability/sensitive
   * 表达，且导入页没有「条目来自公共仓库」这层语义）。勾选语义不受它影响：徽章只是标记，
   * 全选/三态/原子组联动仍全部由 selection-model 决定。
   */
  highRisk?: (id: SectionId) => boolean
  /**
   * 单元行尾部的额外徽章（市场通道传入：将改动 / 已一致 / 不导入）。
   *
   * 为什么要开这个口子：市场审阅要在**树上**表达「这一项会不会写盘」。没有它，调用方只能在
   * 树旁边再铺一份逐项列表 —— 同一批条目渲染两遍正是「61 行挤爆弹窗」的根因。
   * 缺省不传 = 导出页 / 导入页零变化；文案与语义全部由调用方决定（组件不猜）。
   */
  unitBadge?: (section: SectionId, unitId: string) => ReactNode
  /**
   * 用途（只影响文案口径）：export = 「将导出 … 约 X」；import = 「将导入 …」。
   * 导入侧的计划项不带体积，因此不显示大小 —— 不要为了统一而编一个假数字。
   */
  mode?: 'export' | 'import'
}

export function ContentPicker({
  nodes, value, onChange, t, sectionLabel, loading = false, failedSections = [], mode = 'export',
  busy = false, pendingSections = [], highRisk, unitBadge,
}: ContentPickerProps) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /**
   * 「显示全部」的展开态（UI-15，逐分区）。默认只渲染前 UNIT_RENDER_LIMIT 条 ——
   * sessions 实测 631 个单元，一次性铺满 DOM 只会拖慢渲染（见 selection-model 的
   * visibleUnits / UNIT_RENDER_LIMIT）。
   */
  const [showAllUnits, setShowAllUnits] = useState<Record<string, boolean>>({})
  /**
   * 二级分组的展开态（键 = 分区:分组名）。**默认全部折叠** —— 级联树语义（用户明确要求）：
   * 展开分区只列出工作区分组，点某个分组的 chevron 才展开**那一棵子树**，不会一次铺开全部。
   * 折叠只影响渲染，不影响勾选：收起的工作区里的会话仍保持原有勾选状态，
   * 分组行的勾选框也照常可用（不必先展开就能整组选/取消）。
   */
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const visible = useMemo(() => filterSections(nodes, query), [nodes, query])
  const summary = pickerSummary(value, nodes)
  /**
   * 未读到清单的分区数（在途 + 失败，去重；G-02）：> 0 时 footer 合计必须标注
   * 「含未读取分区，实际不少于该值」—— 与导出页卡片同一口径（同一个字典键）。
   */
  const unreadSections = new Set([...pendingSections, ...failedSections]).size
  const label = (id: SectionId): string => sectionLabel?.(id) ?? id

  return (
    <div className={css.pickerRoot}>
      <div className={css.pickerToolbar}>
        <input
          type="search"
          className={css.input}
          value={query}
          placeholder={t('picker.search')}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value) }}
        />
        <Button size="sm" onClick={() => { onChange(selectAll(nodes, true)) }}>{t('picker.selectAll')}</Button>
        <Button size="sm" onClick={() => { onChange(selectAll(nodes, false)) }}>{t('picker.selectNone')}</Button>
      </div>

      {loading && <Spinner label={t('picker.loading')} />}
      {failedSections.length > 0 && <span className={css.hint}>{t('picker.unitsUnavailable')}</span>}

      {!loading && visible.length === 0 && <span className={css.hint}>{t('picker.empty')}</span>}

      {visible.length > 0 && (
        <div className={css.pickerList}>
          {visible.map((node) => {
            const state = sectionPickState(value, node)
            const open = expanded[node.section] === true
            const picked = selectedUnitCount(value, node)
            const total = node.units.length === 0 ? node.count : node.units.length
            /** 本帧要渲染的单元（默认前 N 条；UI-15） */
            const units = visibleUnits(node.units, showAllUnits[node.section] === true)
            return (
              <div key={node.section} className={css.pickerGroup}>
                <div className={css.pickerTreeRow}>
                  {/* 级联树：展开控件在选择框**左边**（点它只展开本节点的子树，不展开别人的）。
                      用原生 button（共享 Button 原语不透传 aria-* 属性，UI-22），图标走统一 Icon 层。 */}
                  {node.units.length > 0 ? (
                    <button
                      type="button"
                      className={css.iconBtn}
                      data-size="sm"
                      aria-expanded={open}
                      aria-controls={open ? unitsId(node.section) : undefined}
                      aria-label={open ? t('picker.collapse') : t('picker.expand')}
                      title={open ? t('picker.collapse') : t('picker.expand')}
                      onClick={() => { setExpanded({ ...expanded, [node.section]: !open }) }}
                    >
                      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
                    </button>
                  ) : (
                    <span className={css.pickerChevronSpacer} aria-hidden="true" />
                  )}
                  <Checkbox
                    checked={state === 'all'}
                    onChange={(checked) => { onChange(toggleSection(value, node, checked)) }}
                    label={
                      <span className={css.categoryItem}>
                        <span className={css.categoryName}>{label(node.section)}</span>
                        {state === 'partial' && <Badge kind="info">{t('picker.partial')}</Badge>}
                        {highRisk?.(node.section) === true && (
                          <span title={t('picker.highRiskHint')}>
                            <Badge kind="warn">{t('picker.highRisk')}</Badge>
                          </span>
                        )}
                        {/* 设备相关 / 敏感分区（UI-09）：数据来自调用方的选择模型，
                            「全选」不再静默把 sessions / credentialsStatus 一起勾上 */}
                        {node.portability === 'deviceSpecific' && (
                          <Badge kind="warn">{t('picker.deviceSpecific')}</Badge>
                        )}
                        {node.sensitive === true && <Badge kind="warn">{t('picker.sensitive')}</Badge>}
                        {/* 三态：读取中 / 读取失败 / 已选 n/m。
                            没读到清单（在途或失败）时**不要**显示 0/0 —— 那会被读成
                            「这一项没有内容」；失败态必须显式说明「将整体导出」（UI-07）。 */}
                        {pendingSections.includes(node.section) ? (
                          <span className={css.pickerCount}>{t('picker.loadingSection')}</span>
                        ) : failedSections.includes(node.section) ? (
                          /* 失败态用 warn 语义色（DESIGN.md「状态即语义」）：中性的 .pickerCount
                             会让「读取失败」读起来像一条普通说明，而不是需要用户注意的状态 */
                          <span className={`${css.pickerCount} ${css.warnText}`}>{t('picker.sectionLoadFailed')}</span>
                        ) : (
                          <span className={css.pickerCount}>
                            {t('picker.selectedOf', { selected: String(picked), total: String(total) })}
                          </span>
                        )}
                        {node.sizeBytes > 0 && (
                          <span className={`${css.sectionSize} ${css.mono}`}>{formatBytes(node.sizeBytes)}</span>
                        )}
                      </span>
                    }
                  />
                </div>
                {open && (
                  <div id={unitsId(node.section)}>
                    {/* 二级分组（sessions 按工作区聚合）：没有 group 的单元仍走平铺，
                        与改造前的渲染完全一致（skills / pluginFiles 等分区零变化）。
                        级联树语义：展开分区只列出分组，点某个分组的 chevron 才展开那一棵子树
                        （默认全部折叠，不会一次铺开全部会话）。 */}
                    {groupUnits(units.shown).map((group, gi) => {
                      const groupState = groupPickState(value, group)
                      const groupPicked = group.units.reduce((n, u) => (value.excluded.includes(u.id) ? n : n + 1), 0)
                      const groupKey = node.section + ':' + (group.label ?? '__flat')
                      const groupOpen = group.label === null || expandedGroups[groupKey] === true
                      const groupBodyId = 'picker-units-' + node.section + '-g' + String(gi)
                      /**
                       * 单个单元行。G-01：单元名与 detail 都是**宿主下发的文本**（导入侧来自备份包内的
                       * 单元名/会话名），必须同等待遇 —— 显示文本与 title 都先过 redact，且
                       * **先脱敏、后省略**（反过来的话，被截断的密钥不再匹配值形状模式而漏网）。
                       */
                      const renderUnit = (u: SelectionUnit) => {
                        const safeLabel = redact(u.label)
                        return (
                          <div key={u.id} className={group.label !== null ? css.pickerUnit + ' ' + css.pickerUnitNested : css.pickerUnit}>
                            {/* 占位对齐：让单元行的勾选框与分组行（chevron 之后）的勾选框同一左缘 */}
                            {group.label !== null && <span className={css.pickerChevronSpacer} aria-hidden="true" />}
                            <Checkbox
                              checked={!value.excluded.includes(u.id)}
                              onChange={(checked) => { onChange(toggleUnit(value, nodes, u.id, checked)) }}
                              label={
                                <span className={css.categoryItem}>
                                  {/* 中段省略（保留尾部时间戳等区分信息）+ title 全文（UI-16，DESIGN.md §9.5） */}
                                  <span className={css.pickerUnitName} title={safeLabel}>{middleEllipsis(safeLabel, UNIT_NAME_MAX)}</span>
                                  {u.lockedWith !== undefined && (
                                    <span title={t('picker.lockedHint')}><Badge kind="warn">{t('picker.locked')}</Badge></span>
                                  )}
                                  {u.fileCount !== undefined && u.fileCount > 1 && (
                                    <span className={css.pickerCount}>{t('picker.fileCount', { count: String(u.fileCount) })}</span>
                                  )}
                                  {/* detail 是宿主下发的原始字符串（版本 / 绝对路径等）→ 渲染前过 redact（安全不变量） */}
                                  {/* 调用方决定的单元级徽章（市场：将改动 / 已一致 / 不导入） */}
                                  {unitBadge?.(node.section, u.id)}
                                  {u.detail !== undefined && <span className={css.pickerUnitDetail}>{redact(u.detail)}</span>}
                                  {u.sizeBytes > 0 && (
                                    <span className={css.sectionSize + ' ' + css.mono}>{formatBytes(u.sizeBytes)}</span>
                                  )}
                                </span>
                              }
                            />
                          </div>
                        )
                      }
                      return (
                        <div key={groupKey}>
                          {group.label !== null && (
                            <div className={css.pickerTreeRow + ' ' + css.pickerSubgroup}>
                              {/* 级联树：只展开这一棵子树（与分区行同一套 chevron 原语与 aria 约定） */}
                              <button
                                type="button"
                                className={css.iconBtn}
                                data-size="sm"
                                aria-expanded={groupOpen}
                                aria-controls={groupOpen ? groupBodyId : undefined}
                                aria-label={groupOpen ? t('picker.collapse') : t('picker.expand')}
                                title={groupOpen ? t('picker.collapse') : t('picker.expand')}
                                onClick={() => { setExpandedGroups({ ...expandedGroups, [groupKey]: !groupOpen }) }}
                              >
                                <Icon name={groupOpen ? 'chevronDown' : 'chevronRight'} size={14} />
                              </button>
                              <Checkbox
                                checked={groupState === 'all'}
                                onChange={(checked) => { onChange(toggleUnitGroup(value, node, group, checked)) }}
                                label={
                                  <span className={css.categoryItem}>
                                    {/* 分组名是宿主直出字符串（工作区标题）→ 渲染前过 redact */}
                                    <span className={css.pickerSubgroupName} title={redact(group.label)}>{redact(group.label)}</span>
                                    {groupState === 'partial' && <Badge kind="info">{t('picker.partial')}</Badge>}
                                    <span className={css.pickerCount}>
                                      {t('picker.selectedOf', { selected: String(groupPicked), total: String(group.units.length) })}
                                    </span>
                                  </span>
                                }
                              />
                            </div>
                          )}
                          {group.label === null
                            ? group.units.map(renderUnit)
                            : groupOpen && <div id={groupBodyId}>{group.units.map(renderUnit)}</div>}
                        </div>
                      )
                    })}
                    {/* 渐进披露（UI-15）：默认前 N 条 + 「显示全部（共 M 条）」，纯前端方案 */}
                    {units.hidden > 0 && (
                      <div className={css.pickerMore}>
                        <button
                          type="button"
                          className={css.ghostButton}
                          data-size="sm"
                          onClick={() => { setShowAllUnits({ ...showAllUnits, [node.section]: true }) }}
                        >
                          {t('picker.showAll', { count: String(node.units.length) })}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 大分区读取中：半透明遮罩 + 加载动画。列表仍可见（用户要能看见自己刚勾了什么），
          但整块不可点 —— 读 sessions 这类大分区要很久，没有任何反馈会被当成卡死。 */}
      {busy && !loading && (
        <div className={css.pickerOverlay} role="status" aria-live="polite">
          <Spinner label={t('picker.loadingItems')} />
        </div>
      )}

      {/* 合计（口径与导出页「本次将导出」卡片**完全一致**，G-02）：存在未读取分区
          （在途 / 读取失败）时用同一句「（含未读取分区，实际不少于该值）」——
          两处共用 `export.compositionPartial` 这一个键，避免同义双键日后漂移。
          import 侧不传 pending/failed（计划项即时可得），因此永远走 picker.summaryImport。 */}
      <div className={css.pickerFooter}>
        {t(
          mode === 'import'
            ? 'picker.summaryImport'
            : unreadSections > 0 ? 'export.compositionPartial' : 'picker.summary',
          {
            sections: String(summary.sections),
            units: String(summary.units),
            size: formatBytes(summary.sizeBytes),
          },
        )}
      </div>
    </div>
  )
}
