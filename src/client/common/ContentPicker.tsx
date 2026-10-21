/**
 * 内容选择器（ContentPicker）—— 两级树：分区 → 最小可拆单元。
 *
 * 定位：**唯一**的内容勾选组件。导出页与导入向导预览步（Phase 2）已共用同一个组件，
 * 市场通道接入时同样复用 —— 「同样的勾选框不一样的行为」是本仓库明确要消灭的状态。
 *
 * 与 SectionComposition 的分工：那个是只读的「分区构成」网格（总览页「分区构成」卡 /
 * 导出页「本次将导出」数据块共用），这个是可交互的选择器。两者不是替代关系，禁止合并。
 *
 * 惰性清单（2026-10-12 用户反馈）：条目的清单由调用方**逐分区惰性拉取**（导出页只预取已勾选分区）。
 * 所以「未读」是一个必须被表达出来的状态 —— 未读分区照常渲染展开控件，展开时才经 onRequestUnits
 * 触发读取，并且**不显示「已选 0/0」**（那会被读成「这条分区是空的」）。判定全部在
 * src/ui/selection-model.ts（sectionExpandable / sectionCountState），本组件只装配。
 *
 * 职责边界：本组件**只渲染与转发交互**，全部选择语义（稀疏排除集、原子组联动、
 * 三态判定、请求参数换算）都在 `src/ui/selection-model.ts` 里，node 可测。
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import {
  applySessionParentCoupling,
  applySessionWorkspaceCoupling,
  filterPluginTree, filterSections, groupPickState, groupSelectedCount, groupUnits, isPluginTreeSection,
  pickerSummary,
  pluginEntryPickState, pluginEntrySelectedCount, pluginEntryTotalCount, pluginEntryUnreadSections, pluginTree,
  pluginTreePickState, pluginTreeSelectedCount, pluginTreeTotalCount, pluginTreeUnreadSections,
  applyPluginPendingChecks, sameSelection, sectionCountState, sectionExpandable, sectionPickState,
  selectAll, selectedUnitCount, tailWeightedEllipsis, togglePluginEntry, togglePluginTree, toggleSection,
  toggleUnit, toggleUnitGroup,
  unitChecked, visibleUnits,
  type PluginLeafKind, type Selection, type SelectionSection, type SelectionUnit, type SessionParentChange,
  type SessionWorkspaceCouplingFocus,
} from '../../ui/selection-model.ts'
import type { ExportGroup } from '../../ui/types.ts'
import { formatBytes } from '../../ui/report.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Button, Checkbox, Spinner } from './ui.tsx'
import { InfoHint } from './InfoHint.tsx'
import { Skeleton } from './Skeleton.tsx'
import { Collapse } from './Motion.tsx'
import { ExpandChevron } from './Icon.tsx'
import css from '../config-manager.module.css'

/** 单元名显示长度上限（配合 .pickerUnitName 的 CSS 省略做兜底；UI-16） */
const UNIT_NAME_MAX = 44

/**
 * 「插件」一级区块在展开态表里的键（与插件包名、`bucket:<分区>` 共用 `expandedPlugins` 这张表）。
 * 默认折叠 —— 用户要求「所有插件收在一个叫插件的区块里，展开后才出现」。
 */
const PLUGIN_ROOT_KEY = 'plugin-root'

/**
 * 分组标题的字典键（与 `ui/types.ts` 的 EXPORT_GROUPS 一一对应）。
 *
 * **顺序不在这里**：顺序由调用方给的节点顺序决定（宿主目录已按 EXPORT_GROUPS 排好），
 * 本表只负责「id → 本地化文案」这一件事（否则中英文界面会漂移）。
 */
const GROUP_TITLE_KEY = {
  general: 'group.general',
  ai: 'group.ai',
  extensions: 'group.extensions',
  mcp: 'group.mcp',
  customization: 'group.customization',
  automation: 'group.automation',
  workspace: 'group.workspace',
  ui: 'group.ui',
  optional: 'group.optional',
} as const satisfies Record<ExportGroup, string>

/** 单元列表容器 id（展开按钮的 aria-controls 指向它；UI-22） */
function unitsId(section: SectionId): string {
  return `picker-units-${section}`
}

export interface ContentPickerProps {
  /**
   * 分区 + 可勾选单元（由 /export-preview 的 items 派生）。
   * `units` 为空有两种事实：不可细分（整体开关）与**尚未读取**（`unitsUnread === true`，见 SelectionSection）。
   */
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
   * 请求读取某分区的清单（**惰性**；调用方自行去重与并发保护）。
   *
   * 触发时机 = 用户展开一个「尚未读取」的分区。为什么把入口挂在展开动作上：清单只对**已勾选分区**
   * 预取，于是未勾选的分区此前既没有展开控件、也没有条目可选 —— 用户必须先勾上整个分区才能展开与
   * 逐项挑选（2026-10-12 用户反馈）。改成展开即读之后，sessions 这类大分区依然不会被预读。
   */
  onRequestUnits?: (id: SectionId) => void
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
  busy = false, pendingSections = [], highRisk, unitBadge, onRequestUnits,
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
  /**
   * 「按插件看」的展开态（键 = 插件包名，或 \`bucket:<分区 id>\`）。
   * 默认全部折叠 —— 展开插件节点时才去读它涉及的 pluginData / pluginAssets 清单（惰性，见渲染处）。
   */
  const [expandedPlugins, setExpandedPlugins] = useState<Record<string, boolean>>({})
  /**
   * 待补勾队列（键 = 「插件」一级区块或某个插件名）。
   *
   * 为什么需要它：分区清单是**惰性**读取的 —— 勾一级区块/插件时，它名下还有区域没读到（unread），
   * 那些单元此刻勾不上。若就此结束，用户会以为「全带上了」，实际包里少了数据目录/大文件。
   * 所以：先勾已知的 + 触发读取 + 入队；清单到货后（nodes 变化）自动补齐并出队。
   */
  const [pendingChecks, setPendingChecks] = useState<{ key: string; kind: 'root' | 'entry' }[]>([])
  const visible = useMemo(() => filterSections(nodes, query), [nodes, query])
  /** 「按插件看」的树：同一份 nodes 的第二个投影（纯函数在 src/ui/selection-model.ts） */
  /** 「按插件看」的完整树（无搜索过滤；纯函数在 src/ui/selection-model.ts） */
  const fullTree = useMemo(() => pluginTree(nodes), [nodes])
  const filteredTree = useMemo(() => filterPluginTree(fullTree, query), [fullTree, query])
  /**
   * 搜索把树过滤空时**回落到完整树**：分区名命中（如搜「插件数据目录」）应当仍能看到这一组，
   * 否则用户会在组标题下面看到一句「没有匹配」，而组里的分区明明就在那里。
   */
  const tree = filteredTree.entries.length === 0 && filteredTree.buckets.every((b) => b.units.length === 0)
    ? fullTree
    : filteredTree
  /**
   * 「插件与扩展」组里的四个插件分区（plugins / pluginFiles / pluginData / pluginAssets）合并成
   * **一棵按插件分组的树**，只在其中**第一个出现**的分区处渲染一次 —— 其余成员就地跳过。
   *
   * 为什么用「第一个成员」而不是新造一个假节点：顺序由调用方给的节点顺序决定（宿主目录已按
   * EXPORT_GROUPS 排好），树落在它本来该在的位置，不引入第二个排序来源。
   * `self`（配置管理器设置）**不在**这四项里，仍按普通分区行渲染。
   */
  const treeSectionIds = visible.filter((n) => isPluginTreeSection(n.section)).map((n) => n.section)
  const firstTreeSection = treeSectionIds[0]
  const summary = pickerSummary(value, nodes)
  /**
   * 未读到清单的分区数（在途 + 失败，去重；G-02）：> 0 时 footer 合计必须标注
   * 「含未读取分区，实际不少于该值」—— 与导出页卡片同一口径（同一个字典键）。
   */
  const unreadSections = new Set([...pendingSections, ...failedSections]).size
  const label = (id: SectionId): string => sectionLabel?.(id) ?? id
  /** 是否存在「会话 ↔ 工作区」联动对象（只在这种时候提示联动规则，平时不打扰）。 */
  const hasLinkedPairs = nodes.some((n) => n.section === 'sessions' && n.units.length > 0)
    && nodes.some((n) => n.section === 'workspaces' && n.units.some((u) => (u.sessionIds?.length ?? 0) > 0))
  /**
   * 勾选动作统一出口：先过一次「父对话 ↔ 子代理会话」联动，再过一次会话↔工作区联动。
   *
   * 顺序固定（先把会话集合闭合，再按会话认领工作区），两条语义都在 src/ui/selection-model.ts，node 可测。
   * `parentChange` 只在**单个会话单元**被点击时传：批量动作（分区/分组/全选）没有单一方向，
   * 走正向闭包（补齐父/子，绝不取消任何东西）。
   */
  const commit = (
    next: Selection,
    focus: SessionWorkspaceCouplingFocus = 'both',
    parentChange?: SessionParentChange,
  ): void => {
    const coupled = applySessionParentCoupling(next, nodes, parentChange)
    onChange(applySessionWorkspaceCoupling(coupled, nodes, focus))
  }
  /** 该分区属于哪一侧（决定联动方向）：会话侧 / 工作区侧 / 其它（两条都跑）。 */
  const focusOf = (section: SectionId): SessionWorkspaceCouplingFocus => (
    section === 'sessions' ? 'sessions' : section === 'workspaces' ? 'workspaces' : 'both'
  )

  /**
   * 待补勾：清单到货后把「勾一级区块/插件时还没读到」的单元补齐（见 pendingChecks 的注释）。
   *
   * 收敛判据是「该节点名下已无 unread 叶子」；只要还在读就一直排队，到齐后补一次并出队。
   * 幂等：补齐结果与当前选择等价时不写库（sameSelection），避免自激渲染。
   */
  useEffect(() => {
    if (pendingChecks.length === 0) return
    const { selection, remaining } = applyPluginPendingChecks(value, nodes, tree, pendingChecks)
    setPendingChecks(remaining)
    if (!sameSelection(selection, value)) commit(selection)
    // tree/nodes 变化即代表清单到货；value 变化来自本次补齐本身（此时队列已空，直接返回）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChecks, tree, nodes, value])

  /** 叶子的种类文案（模型不出文案；i18n 铁律）。 */
  const leafKindText = (kind: PluginLeafKind): string => (
    kind === 'plugin' ? t('picker.pluginLeafPlugin')
      : kind === 'config' ? t('picker.pluginLeafConfig') : t('picker.pluginLeafAssets')
  )
  /**
   * 桶的标题文案（无法归属到具体插件的整块分区 —— 不猜归属的结果必须显式说出来）。
   *
   * 只有两个桶：插件分区里的补丁行 / pnpm-workspace.yaml，以及 pluginFiles。两者都**不是插件**，
   * 因此不放进「插件」一级区块里。缺省回落分区显示名（新增桶时不会渲染出裸 key）。
   */
  const bucketLabel = (section: SectionId): string => (
    section === 'plugins' ? t('picker.bucketPlugins')
      : section === 'pluginFiles' ? t('picker.bucketLooseFiles') : label(section)
  )

  /**
   * 单个单元行（**唯一实现**：「按分区看」的单元与「按插件看」的桶共用同一个渲染）。
   *
   * G-01：单元名与 detail 都是**宿主下发的文本**（导入侧来自备份包内的单元名/会话名），
   * 必须同等待遇 —— 显示文本与 title 都先过 redact，且**先脱敏、后省略**（反过来的话，
   * 被截断的密钥不再匹配值形状模式而漏网）。
   */
  const renderUnitRow = (node: SelectionSection, u: SelectionUnit, nested: boolean): ReactNode => {
    const safeLabel = redact(u.label)
    return (
      <div key={u.id} className={nested ? css.pickerUnit + ' ' + css.pickerUnitNested : css.pickerUnit}>
        {/* 占位对齐：让单元行的勾选框与分组行（chevron 之后）的勾选框同一左缘 */}
        {nested && <span className={css.pickerChevronSpacer} aria-hidden="true" />}
        <Checkbox
          checked={unitChecked(value, node.section, u.id)}
          onChange={(checked) => { commit(toggleUnit(value, nodes, u.id, checked), focusOf(node.section), { unitId: u.id, checked }) }}
          label={
            <span className={css.categoryItem}>
              {/* 空白会话（从未提问过）：DSH 自己显示「新会话」—— 这里同样用本地化占位名，
                  目录名仍进 title（悬停可核对）。其余单元照旧中段省略 + title 全文（UI-16，DESIGN.md §9.5）。 */}
              {u.blank === true ? (
                <span className={css.pickerUnitName} title={safeLabel}>{t('picker.blankSession')}</span>
              ) : (
                <span className={css.pickerUnitName} title={safeLabel}>{tailWeightedEllipsis(safeLabel, UNIT_NAME_MAX)}</span>
              )}
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

  /**
   * 「插件与扩展」组里的四个插件分区合并渲染成的**一棵按插件分组的树**（用户要求：
   * 不再用「按分区 / 按插件」视图切换 —— 树就是这一组的渲染方式）。
   *
   * 只显示**能证明**的归属（宿主下发的 relatedAreas = 内置来源表 + 插件自述 dsh.dataDirs）；
   * pluginFiles 没有任何包名信息，因此整块进「未归属」桶 —— 不猜，也不假装它属于某个插件。
   * 「注册表说它应该在哪儿」与「磁盘上确实有」分开渲染：unread 不可勾（展开时才去读），
   * absent 明确标「无内容」—— 否则会出现「勾了却没导出」的幽灵勾选（引擎只带走清单里真实存在的单元）。
   *
   * 纯展示：叶子仍是原来的单元 id，勾选仍走 toggleUnit / toggleSection（语义一字不改）。
   */
  const renderPluginTree = (): ReactNode => {
    /**
     * 「插件」一级区块（用户要求：所有插件先收在一个可折叠的区块里，展开才列出插件）。
     *
     * 默认**折叠**；**搜索时自动展开** —— 否则搜索结果会藏在折叠节点里，看起来像「没有匹配」。
     * 它的勾选框 = 所有插件名下**存在的**单元（逐个走 toggleUnit），与「未归属 / 遗留数据」桶无关：
     * 那两个桶是「无法归属的东西」，不该被「全选所有插件」顺手带上。
     */
    const rootKey = PLUGIN_ROOT_KEY
    const rootOpen = expandedPlugins[rootKey] === true || query.trim() !== ''
    const rootState = pluginTreePickState(value, tree)
    const rootPicked = pluginTreeSelectedCount(value, tree)
    const rootTotal = pluginTreeTotalCount(tree)
    const rootSize = tree.entries.reduce((n, e) => n + e.leaves.reduce((m, l) => m + l.sizeBytes, 0), 0)
    const rootUnread = pluginTreeUnreadSections(tree)
    const body = (
      <>
        {!tree.pluginsLoaded && <span className={css.hint}>{t('picker.pluginViewEmpty')}</span>}
      {tree.pluginsLoaded
        && tree.entries.length === 0
        && tree.buckets.every((b) => b.units.length === 0)
        && <span className={css.hint}>{t('picker.empty')}</span>}
      {tree.entries.map((entry) => {
        const open = expandedPlugins[entry.name] === true
        const state = pluginEntryPickState(value, entry)
        const picked = pluginEntrySelectedCount(value, entry)
        // 分母用「已知」叶子（含未读取的区域）：否则折叠/展开会给出两个数字（2026-10-17 用户实测）
        const total = pluginEntryTotalCount(entry)
        const unread = pluginEntryUnreadSections(entry)
        const entrySize = entry.leaves.reduce((n, l) => n + l.sizeBytes, 0)
        const bodyId = 'picker-plugin-' + entry.name
        return (
          <div key={entry.name} className={css.pickerGroup}>
            <div className={css.pickerTreeRow}>
              <button
                type="button"
                className={css.iconBtn}
                data-size="sm"
                aria-expanded={open}
                aria-controls={bodyId}
                aria-label={open ? t('picker.collapse') : t('picker.expand')}
                title={open ? t('picker.collapse') : t('picker.expand')}
                onClick={() => {
                  // 展开才去读：清单是惰性的，插件树同样不预读 pluginData / pluginAssets
                  if (!open) for (const s of unread) onRequestUnits?.(s)
                  setExpandedPlugins({ ...expandedPlugins, [entry.name]: !open })
                }}
              >
                <ExpandChevron open={open} />
              </button>
              <Checkbox
                checked={state === 'all'}
                onChange={(checked) => {
                  if (!checked) {
                    // 取消：撤掉队列里本插件的补勾请求（否则到货后又把它勾回来）
                    setPendingChecks((prev) => prev.filter((p) => p.key !== entry.name))
                    commit(togglePluginEntry(value, nodes, entry, false))
                    return
                  }
                  for (const s of unread) onRequestUnits?.(s)
                  if (unread.length > 0) {
                    setPendingChecks((prev) => (prev.some((p) => p.key === entry.name) ? prev : [...prev, { key: entry.name, kind: 'entry' }]))
                  }
                  commit(togglePluginEntry(value, nodes, entry, true))
                }}
                label={
                  <span className={css.categoryItem}>
                    {/* 包名是宿主直出文本 → 显示前过 redact（与单元行同一纪律） */}
                    <span className={css.pickerUnitName} title={redact(entry.name)}>
                      {tailWeightedEllipsis(redact(entry.name), UNIT_NAME_MAX)}
                    </span>
                    {state === 'partial' && <Badge kind="info">{t('picker.partial')}</Badge>}
                    <span className={css.pickerCount}>
                      {t('picker.selectedOf', { selected: String(picked), total: String(total) })}
                    </span>
                    {entrySize > 0 && <span className={css.sectionSize + ' ' + css.mono}>{formatBytes(entrySize)}</span>}
                    {unread.length > 0 && <span className={css.pickerCount}>{t('picker.pluginAreaUnread')}</span>}
                  </span>
                }
              />
            </div>
            <Collapse open={open} id={bodyId}>
              <div className={css.pickerChildren}>
              {entry.leaves.map((leaf) => {
                const kindText = leafKindText(leaf.kind)
                const leafName = leaf.kind === 'plugin' ? kindText : kindText + ' · ' + redact(leaf.label)
                if (leaf.state !== 'present') {
                  // 不可勾的两态：还没读 / 读了但没有内容（如实说明，绝不产生幽灵勾选）。
                  // **不给按钮**：展开插件（或一级区块）就是读取入口 —— 与其它分区行的惰性语义一致。
                  return (
                    <div key={leaf.unitId} className={css.pickerUnit + ' ' + css.pickerUnitNested}>
                      <span className={css.pickerChevronSpacer} aria-hidden="true" />
                      <span className={css.categoryItem}>
                        <span className={css.pickerUnitName} title={redact(leaf.label)}>{leafName}</span>
                        <span className={css.pickerCount}>
                          {leaf.state === 'unread' ? t('picker.pluginAreaUnread') : t('picker.pluginAreaAbsent')}
                        </span>

                      </span>
                    </div>
                  )
                }
                return (
                  <div key={leaf.unitId} className={css.pickerUnit + ' ' + css.pickerUnitNested}>
                    <span className={css.pickerChevronSpacer} aria-hidden="true" />
                    <Checkbox
                      checked={unitChecked(value, leaf.section, leaf.unitId)}
                      onChange={(checked) => { commit(toggleUnit(value, nodes, leaf.unitId, checked)) }}
                      label={
                        <span className={css.categoryItem}>
                          <span className={css.pickerUnitName} title={redact(leaf.label)}>{leafName}</span>
                          {leaf.detail !== undefined && <span className={css.pickerUnitDetail}>{redact(leaf.detail)}</span>}
                          {leaf.sizeBytes > 0 && <span className={css.sectionSize + ' ' + css.mono}>{formatBytes(leaf.sizeBytes)}</span>}
                        </span>
                      }
                    />
                  </div>
                )
              })}
              </div>
            </Collapse>
          </div>
        )
      })}
      </>
    )
    const bucketsBody = (
      <>
      {tree.buckets.map((bucket) => {
        const node = nodes.find((n) => n.section === bucket.section)
        if (node === undefined) return null
        const key = 'bucket:' + bucket.section
        const open = expandedPlugins[key] === true
        const units = visibleUnits(bucket.units, showAllUnits[key] === true)
        const bodyId = 'picker-bucket-' + bucket.section
        return (
          <div key={key} className={css.pickerGroup}>
            <div className={css.pickerTreeRow}>
              {bucket.units.length > 0 || !bucket.loaded ? (
                <button
                  type="button"
                  className={css.iconBtn}
                  data-size="sm"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  aria-label={open ? t('picker.collapse') : t('picker.expand')}
                  title={open ? t('picker.collapse') : t('picker.expand')}
                  onClick={() => {
                    // 展开即读（与其他分区行同一套惰性语义）—— 不再给「读取该分区」按钮
                    if (!open && !bucket.loaded) onRequestUnits?.(bucket.section)
                    setExpandedPlugins({ ...expandedPlugins, [key]: !open })
                  }}
                >
                  <ExpandChevron open={open} />
                </button>
              ) : (
                <span className={css.pickerChevronSpacer} aria-hidden="true" />
              )}
              {/* 桶也是**整个分区**：勾选框与普通分区行同一套三态语义（toggleSection），
                  这样「整块带走/整块不带」不需要先展开逐条勾。 */}
              <Checkbox
                checked={sectionPickState(value, node) === 'all'}
                onChange={(checked) => { commit(toggleSection(value, node, checked), focusOf(node.section)) }}
                label={
                  <span className={css.categoryItem}>
                    <span className={css.pickerUnitName}>{bucketLabel(bucket.section)}</span>
                    {sectionPickState(value, node) === 'partial' && <Badge kind="info">{t('picker.partial')}</Badge>}
                    {node.portability === 'deviceSpecific' && <Badge kind="warn">{t('picker.deviceSpecific')}</Badge>}
                    {bucket.loaded && (
                      <span className={css.pickerCount}>
                        {t('picker.selectedOf', {
                          selected: String(selectedUnitCount(value, node)),
                          total: String(node.units.length === 0 ? node.count : node.units.length),
                        })}
                      </span>
                    )}
                    {/* 未读时不给「读取该分区」按钮：展开这一行就是读取入口（与其他分区行同一套惰性语义） */}
                    {bucket.loaded && <InfoHint text={t('picker.bucketHint')} t={t} />}
                  </span>
                }
              />
            </div>
            <Collapse open={open} id={bodyId}>
              <div className={css.pickerChildren}>
              {units.shown.map((u) => renderUnitRow(node, u, true))}
              {units.hidden > 0 && (
                <div className={css.pickerMore}>
                  <button
                    type="button"
                    className={css.ghostButton}
                    data-size="sm"
                    onClick={() => { setShowAllUnits({ ...showAllUnits, [key]: true }) }}
                  >
                    {t('picker.showAll', { count: String(bucket.units.length) })}
                  </button>
                </div>
              )}
              </div>
            </Collapse>
          </div>
        )
      })}
      </>
    )
    return (
      <>
      <div className={css.pickerGroup}>
        <div className={css.pickerTreeRow}>
          <button
            type="button"
            className={css.iconBtn}
            data-size="sm"
            aria-expanded={rootOpen}
            aria-controls="picker-plugin-root"
            aria-label={rootOpen ? t('picker.collapse') : t('picker.expand')}
            title={rootOpen ? t('picker.collapse') : t('picker.expand')}
            onClick={() => {
              // 展开才去读：清单是惰性的，插件树同样不预读 pluginData / pluginAssets
              if (!rootOpen) for (const s of rootUnread) onRequestUnits?.(s)
              setExpandedPlugins({ ...expandedPlugins, [rootKey]: !rootOpen })
            }}
          >
            <ExpandChevron open={rootOpen} />
          </button>
          <Checkbox
            checked={rootState === 'all'}
            onChange={(checked) => {
              if (!checked) {
                // 取消：把队列里属于本节点的请求一并撤掉，免得到货后又把它勾回来
                setPendingChecks((prev) => prev.filter((p) => p.kind !== 'root'))
                commit(togglePluginTree(value, nodes, tree, false))
                return
              }
              for (const s of rootUnread) onRequestUnits?.(s)
              if (!tree.pluginsLoaded || tree.entries.some((e) => pluginEntryUnreadSections(e).length > 0)) {
                setPendingChecks((prev) => (prev.some((p) => p.kind === 'root') ? prev : [...prev, { key: rootKey, kind: 'root' }]))
              }
              commit(togglePluginTree(value, nodes, tree, true))
            }}
            label={
              <span className={css.categoryItem}>
                <span className={css.categoryName}>{t('picker.pluginRoot')}</span>
                {rootState === 'partial' && <Badge kind="info">{t('picker.partial')}</Badge>}
                <span className={css.pickerCount}>
                  {t('picker.selectedOf', { selected: String(rootPicked), total: String(rootTotal) })}
                </span>
                {rootSize > 0 && <span className={css.sectionSize + ' ' + css.mono}>{formatBytes(rootSize)}</span>}
                {rootUnread.length > 0 && <span className={css.pickerCount}>{t('picker.pluginAreaUnread')}</span>}
              </span>
            }
          />
        </div>
        <Collapse open={rootOpen} id="picker-plugin-root">
          <div className={css.pickerChildren}>{body}</div>
        </Collapse>
      </div>
      {bucketsBody}
      </>
    )
  }

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
        <Button size="sm" onClick={() => { commit(selectAll(nodes, true)) }}>{t('picker.selectAll')}</Button>
        <Button size="sm" onClick={() => { commit(selectAll(nodes, false)) }}>{t('picker.selectNone')}</Button>
        {/* 会话 ↔ 工作区联动属「机制怎么工作」（MOVE 类）：只在这种配对确实存在时给出 ⓘ，
            不再用一整行常驻说明占掉选择器首屏。 */}
        {hasLinkedPairs && <InfoHint text={t('picker.sessionWorkspaceLinked')} t={t} />}
      </div>

      {loading && <Skeleton count={3} label={t('picker.loading')} />}
      {failedSections.length > 0 && <span className={css.hint}>{t('picker.unitsUnavailable')}</span>}

      {!loading && visible.length === 0 && <span className={css.hint}>{t('picker.empty')}</span>}

      {visible.length > 0 && (
        <div className={css.pickerList}>
          {visible.map((node, nodeIndex) => {
            /**
             * 分组标题：只在**分组变化处**插一行（顺序 = 调用方给的顺序，UI 不重排）。
             * 没有 group 的调用方（导入向导 / 市场）整段不渲染 —— 行为逐像素不变。
             * 标题不是选项（DESIGN.md：更小更淡、不可选中、非首组起分隔线），
             * 因此这里用 span 而不是 Checkbox —— 免得被读成「灰掉的选项」。
             */
            const groupTitle = node.group !== undefined
              && (nodeIndex === 0 || visible[nodeIndex - 1]?.group !== node.group)
              ? node.group
              : undefined
            /**
             * 「插件与扩展」组里的四个插件分区（plugins / pluginFiles / pluginData / pluginAssets）
             * 合并成一棵按插件分组的树：只在其中**第一个出现**的分区处渲染一次（见 renderPluginTree），
             * 其余成员就地跳过 —— 顺序仍由调用方给的节点顺序决定，不引入第二个排序来源。
             * `self`（配置管理器设置）不在那四项里，照旧按普通分区行渲染。
             */
            if (isPluginTreeSection(node.section) && node.section !== firstTreeSection) return null
            const state = sectionPickState(value, node)
            const open = expanded[node.section] === true
            const picked = selectedUnitCount(value, node)
            const total = node.units.length === 0 ? node.count : node.units.length
            /** 展开控件：有清单可展开；**清单未读**同样可展开（展开即触发读取，见 onRequestUnits） */
            const expandable = sectionExpandable(node)
            /** 计数区状态（未读**不得**显示 0/0；判定在 ui 纯函数里） */
            const countState = sectionCountState(node, {
              pending: pendingSections.includes(node.section),
              failed: failedSections.includes(node.section),
            })
            /** 展开 = 先按需读清单（仅在「未读且即将展开」时触发一次；收起不读） */
            const onToggleExpand = (): void => {
              if (!open && node.unitsUnread === true) onRequestUnits?.(node.section)
              setExpanded({ ...expanded, [node.section]: !open })
            }
            /** 本帧要渲染的单元（默认前 N 条；UI-15） */
            const units = visibleUnits(node.units, showAllUnits[node.section] === true)
            return (
              <Fragment key={node.section}>
                {groupTitle !== undefined && (
                  <div className={css.pickerGroupTitle}>
                    <span className={css.pickerGroupTitleName}>{t(GROUP_TITLE_KEY[groupTitle])}</span>
                    {groupTitle === 'extensions' && <InfoHint text={t('picker.groupHint.extensions')} t={t} />}
                  </div>
                )}
                {node.section === firstTreeSection ? renderPluginTree() : (
                  <div className={css.pickerGroup}>
                  <div className={css.pickerTreeRow}>
                    {/* 级联树：展开控件在选择框**左边**（点它只展开本节点的子树，不展开别人的）。
                        用原生 button（共享 Button 原语不透传 aria-* 属性，UI-22）；图标走**形变层** ——
                         展开态切换本身携带信息，让「变了」可见（common/Icon.tsx 的 ExpandChevron）。 */}
                    {expandable ? (
                      <button
                        type="button"
                        className={css.iconBtn}
                        data-size="sm"
                        aria-expanded={open}
                        aria-controls={unitsId(node.section)}
                        aria-label={open ? t('picker.collapse') : t('picker.expand')}
                        title={open ? t('picker.collapse') : t('picker.expand')}
                        onClick={onToggleExpand}
                      >
                        <ExpandChevron open={open} />
                      </button>
                    ) : (
                      <span className={css.pickerChevronSpacer} aria-hidden="true" />
                    )}
                    <Checkbox
                      checked={state === 'all'}
                      onChange={(checked) => { commit(toggleSection(value, node, checked), focusOf(node.section)) }}
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
                          {countState === 'pending' ? (
                            <span className={css.pickerCount}>{t('picker.loadingSection')}</span>
                          ) : countState === 'failed' ? (
                            /* 失败态用 warn 语义色（DESIGN.md「状态即语义」）：中性的 .pickerCount
                               会让「读取失败」读起来像一条普通说明，而不是需要用户注意的状态 */
                            <span className={`${css.pickerCount} ${css.warnText}`}>{t('picker.sectionLoadFailed')}</span>
                          ) : countState === 'count' ? (
                            <span className={css.pickerCount}>
                              {t('picker.selectedOf', { selected: String(picked), total: String(total) })}
                            </span>
                          ) : (
                            /* 未读（惰性）：**不渲染 0/0** —— 「已选 0/0」会被读成「这条分区没有内容」，
                               而事实是「还没去读」。数字等展开（= 触发读取）之后再给。 */
                            null
                          )}
                          {node.sizeBytes > 0 && (
                            <span className={`${css.sectionSize} ${css.mono}`}>{formatBytes(node.sizeBytes)}</span>
                          )}
                        </span>
                      }
                    />
                    </div>
                  {/* 展开/收起两端都有高度动画（common/Motion.tsx 的 Collapse）；
                      容器**始终存在**，所以 aria-controls 恒有值。 */}
                  <Collapse open={open} id={unitsId(node.section)}>
                      <div className={css.pickerChildren}>
                      {/* 二级分组（sessions 按工作区聚合）：没有 group 的单元仍走平铺，
                          与改造前的渲染完全一致（skills / pluginFiles 等分区零变化）。
                          级联树语义：展开分区只列出分组，点某个分组的 chevron 才展开那一棵子树
                          （默认全部折叠，不会一次铺开全部会话）。 */}
                      {groupUnits(units.shown).map((group, gi) => {
                        // 分组三态与计数都必须带上所属分区 —— 分区整体没勾时，它下面的分组/单元一律显示未勾选
                        const groupState = groupPickState(value, group, node.section)
                        const groupPicked = groupSelectedCount(value, group, node.section)
                        const groupKey = node.section + ':' + (group.label ?? '__flat')
                        const groupOpen = group.label === null || expandedGroups[groupKey] === true
                        const groupBodyId = 'picker-units-' + node.section + '-g' + String(gi)
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
                                  aria-controls={groupBodyId}
                                  aria-label={groupOpen ? t('picker.collapse') : t('picker.expand')}
                                  title={groupOpen ? t('picker.collapse') : t('picker.expand')}
                                  onClick={() => { setExpandedGroups({ ...expandedGroups, [groupKey]: !groupOpen }) }}
                                >
                                  <ExpandChevron open={groupOpen} />
                                </button>
                                <Checkbox
                                  checked={groupState === 'all'}
                                  onChange={(checked) => { commit(toggleUnitGroup(value, node, group, checked), focusOf(node.section)) }}
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
                              ? group.units.map((u) => renderUnitRow(node, u, true))
                              : (
                                <Collapse open={groupOpen} id={groupBodyId}>
                                  <div className={css.pickerChildren}>
                                    {group.units.map((u) => renderUnitRow(node, u, true))}
                                  </div>
                                </Collapse>
                              )}
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
                  </Collapse>
                  </div>
                )}
              </Fragment>
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
