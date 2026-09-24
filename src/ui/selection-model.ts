/**
 * 导出内容选择模型（Phase 1 条目级导出选择；框架无关纯函数，node 可测）。
 *
 * 为什么需要这一层：导出页原本有两种状态 ——「快速」与「自定义分区勾选」—— 是两条各自
 * 渲染的代码路径。一旦加入条目级勾选，就会出现「同一套勾选框、两套行为」。本模块把选择
 * 收敛成**唯一**的稀疏表示，快速/自定义变成同一模型上的两个预设：
 *
 *   Selection { sections: SectionId[]; excluded: string[] }
 *
 * - `sections`：勾选的分区（稀疏 —— 初值即推荐分区，与改造前 Custom 的初值一致）；
 * - `excluded`：被**排除的单元 id**（稀疏 —— 默认全选、只记例外），
 *   因此 sessions 上千条也不会把 sessionStorage 里的持久化状态撑大。
 *
 * 分区不可细分（node.units 为空）时自然退化为整体开关 —— 不需要第二套分支。
 * 单元 id 由宿主侧 ConfigAdapter.listUnits() 产出，与导入侧 PlanItem.id 同一命名空间。
 */
import type { SectionId } from '../schema/types.ts'
import type { ImportPlan, PlanItem, PlanItemKind, Portability } from '../core/types.ts'
// 运行时依赖：会话 id 归一化（零依赖纯函数，客户端 bundle 可安全内联）
import { projectKeyOf, sessionIdKey } from '../core/session-select.ts'

/** 一个可单独勾选的最小单元（来自 /export-preview 的 items）。 */
export interface SelectionUnit {
  id: string
  label: string
  /** 副标题（版本 / 绝对路径；宿主的原始数据，非 UI 文案） */
  detail?: string
  /** 成员文件数（文件类单元） */
  fileCount?: number
  sizeBytes: number
  /** 原子组：必须与之同进同出的其它单元 id（如 pnpm-workspace.yaml ↔ patch 文件） */
  lockedWith?: string[]
  /**
   * 二级分组名（宿主直出：sessions 按工作区聚合时为工作区标题）。缺省 = 平铺渲染，
   * 与既有分区（skills / pluginFiles / …）的表现完全一致。纯展示层，不参与勾选契约。
   */
  group?: string
  /**
   * 本单元拥有的会话 id（工作区单元专用；issue #45）。
   *
   * 用途：勾选联动 —— 勾了会话就自动勾上它所属的工作区，取消工作区就取消它的会话。
   * 取值 = 工作区记录 sessionIds **原样**（DSH 一律写 `session-<uuid>`）；与会话单元 id 的末段（目录名，
   * 可能是 `session-<uuid>` 也可能是裸 `<uuid>`）用 `sessionIdKey()` 归一化后配对 —— 两种形态直接做
   * 字符串比较会失配（真机实测 546/570 会话因此联不上工作区）。
   */
  sessionIds?: string[]
  /**
   * 本单元 **path 的 cwd 目录键**（工作区单元专用；issue #45 勾选联动的第二判据）。
   *
   * 为什么需要它：DSH 注册表 `sessionIds` 覆盖率很低（真机实测一次可选择的 570 条会话里只有 23 条在
   * 里面），而 DSH 自己按「会话 cwd 的目录键 == 工作区 path 的目录键」会话显示在工作区下。勾选联动若
   * 只认 sessionIds，就会出现「界面明明把对话挂在某工作区下、勾它却不联动」。
   */
  projectKey?: string
  /**
   * 父对话的会话裸键（**只有子代理会话才有值**；宿主在 /export-preview 里按 DSH 的会话存储关系下发）。
   *
   * 用途：「父 ↔ 子代理会话」勾选联动（勾父自动勾上它的子代理会话、勾子自动带上父）。没有这个字段
   * 时联动整段失效 —— 界面勾了什么与包里装了什么就会不一致（真机事故：勾 2 条、包里 41 条）。
   */
  parentSessionId?: string
}

/** 一个分区及其可勾选单元；units 为空 = 本分区不可细分（UI 只给整体开关）。 */
export interface SelectionSection {
  section: SectionId
  /** 宿主报告的条目总数（不可细分分区用于展示） */
  count: number
  sizeBytes: number
  units: SelectionUnit[]
  /**
   * 可移植性（来自分类目录 ExportCategory.portability）。UI-09：选择器据此给
   * 「设备相关」徽章，并在勾选到这类分区时就地警示 —— 「全选」不得静默把
   * sessions / pluginFiles / credentialsStatus 一起勾上而毫无提示。
   * 未知来源（如导入侧由计划项派生的分区）留空 = 不渲染徽章（不猜）。
   */
  portability?: Portability
  /** 涉及秘密状态（如 credentialsStatus）：安全提示用，绝不显示值。 */
  sensitive?: boolean
}

/** 唯一的导出选择状态。 */
export interface Selection {
  sections: SectionId[]
  excluded: string[]
}

/** 分区级三态。 */
export type SectionPickState = 'all' | 'none' | 'partial'

/* ----------------------------------------------------------------------------------
   选择器列表的分级渲染与显示裁剪（纯展示模型，node 可测）
   ---------------------------------------------------------------------------------- */

/**
 * 单元列表的**默认渲染上限**（UI-15）。
 *
 * 取值理由（2026-09 用户反馈修正）：此前是 100，而真实会话库实测 660 个单元 —— 用户展开
 * 「历史会话」只看到前 100 条 + 一行「显示全部」，读成了「只有这些 / 只选了这些」，
 * 必须再点一次才敢确认，是纯粹的困惑来源。现在放宽到 1000：真实规模的库**展开即全量**，
 * 折叠只在异常大的分区（上万条）上兜底 —— 「显示全部」仍在，但不再挡在常见规模前面。
 * 660 行静态 DOM 的渲染代价可接受；**不引入第三方虚拟列表**（AGENTS.md 默认禁止），
 * 真到上万条再谈虚拟化。
 */
export const UNIT_RENDER_LIMIT = 1000

/** 单元列表渐进披露结果（UI-15）。 */
export interface VisibleUnits {
  /** 本帧要渲染的单元 */
  shown: SelectionUnit[]
  /** 被折叠的单元数（0 = 已全部渲染） */
  hidden: number
}

/** 单元列表渐进披露：默认只给前 limit 条，`showAll` 为 true 时全量。 */
export function visibleUnits(
  units: readonly SelectionUnit[],
  showAll: boolean,
  limit: number = UNIT_RENDER_LIMIT,
): VisibleUnits {
  if (showAll || units.length <= limit) return { shown: [...units], hidden: 0 }
  return { shown: units.slice(0, limit), hidden: units.length - limit }
}

/**
 * 中段省略（UI-16）：用 `…` 收掉字符串**中段**，保留尾部 —— 会话名 / 路径 / 文件名
 * 的区分信息通常在尾部（时间戳、版本、扩展名），尾部截断会让两条记录看起来一模一样
 * （DESIGN.md §9 anti-pattern 5）。
 *
 * 纯函数（node 可测）：只改显示文本，不改数据；完整值由调用方放进 `title`。
 * 与 CSS `text-overflow: ellipsis` 叠加使用（CSS 兜底实际容器宽度）。
 */
export function tailWeightedEllipsis(text: string, max = 44): string {
  if (max <= 1 || text.length <= max) return text
  // 尾部预算 ≈ 40%（不少于 8 字符）：时间戳/版本/扩展名比头部更有区分度。
  // 但必须给「头部 + …」留位置，否则 max 很小时（如 4）截断结果会超过 max。
  const tail = Math.min(text.length - 1, Math.min(Math.max(8, Math.floor(max * 0.4)), max - 2))
  const head = Math.max(1, max - tail - 1)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/** 缺省：全选（excluded 为空 = 没有任何例外）。 */
export function defaultSelection(sections: SectionId[]): Selection {
  return { sections: [...sections], excluded: [] }
}

/** 把 /export-preview 的分区响应映射为选择模型的分区（宿主类型 → UI 模型，显式转换一次）。 */
export function sectionsFromPreview(
  preview: readonly {
    section: SectionId
    count: number
    sizeBytes: number
    items?: readonly SelectionUnit[]
  }[],
): SelectionSection[] {
  return preview.map((s) => ({
    section: s.section,
    count: s.count,
    sizeBytes: s.sizeBytes,
    units: (s.items ?? []).map((u) => ({
      id: u.id,
      label: u.label,
      ...(u.detail !== undefined ? { detail: u.detail } : {}),
      ...(u.fileCount !== undefined ? { fileCount: u.fileCount } : {}),
      sizeBytes: u.sizeBytes,
      ...(u.lockedWith !== undefined ? { lockedWith: u.lockedWith } : {}),
      ...(u.group !== undefined ? { group: u.group } : {}),
      ...(u.sessionIds !== undefined ? { sessionIds: u.sessionIds } : {}),
      ...(u.projectKey !== undefined ? { projectKey: u.projectKey } : {}),
      ...(u.parentSessionId !== undefined ? { parentSessionId: u.parentSessionId } : {}),
    })),
  }))
}

/* ----------------------------------------------------------------------------------
   二级分组（sessions 按工作区分类展示）
   ---------------------------------------------------------------------------------- */

/** 一个二级分组；label = null 表示「没有分组的单元」（非 sessions 分区就是这一种）。 */
export interface UnitGroup {
  label: string | null
  units: SelectionUnit[]
}

/**
 * 按声明的分组名把单元切成二级分组。
 *
 * 语义要点：
 *  - **没有任何单元带 group → 返回单个 label:null 分组**，渲染路径与改造前逐像素一致
 *    （skills / pluginFiles / self 等分区零变化）；
 *  - 组顺序 = 首次出现顺序（宿主已按「工作区 → 最近活跃」排好，UI 不再重排）；
 *  - 无分组的单元单独成一组，排在**最前**（它们通常是该分区的公共条目）。
 */
export function groupUnits(units: readonly SelectionUnit[]): UnitGroup[] {
  const groups = new Map<string, SelectionUnit[]>()
  const ungrouped: SelectionUnit[] = []
  for (const u of units) {
    if (u.group === undefined || u.group === '') {
      ungrouped.push(u)
      continue
    }
    const bucket = groups.get(u.group)
    if (bucket === undefined) groups.set(u.group, [u])
    else bucket.push(u)
  }
  const out: UnitGroup[] = []
  if (ungrouped.length > 0) out.push({ label: null, units: ungrouped })
  for (const [label, list] of groups) out.push({ label, units: list })
  return out
}

/** 二级分组三态（与分区三态同一套口径；分组只是分区内的视图）。 */
export function groupPickState(sel: Selection, group: UnitGroup): SectionPickState {
  const excluded = new Set(sel.excluded)
  const selected = group.units.reduce((n, u) => (excluded.has(u.id) ? n : n + 1), 0)
  if (selected === 0) return 'none'
  return selected === group.units.length ? 'all' : 'partial'
}

/** 分组级勾选：整组一起选/取消（并保证其所属分区处于勾选状态）。 */
export function toggleUnitGroup(sel: Selection, node: SelectionSection, group: UnitGroup, checked: boolean): Selection {
  const wasOff = !sel.sections.includes(node.section)
  const excluded = new Set(sel.excluded)
  const inGroup = new Set(group.units.map((u) => u.id))
  for (const u of group.units) {
    if (checked) excluded.delete(u.id)
    else excluded.add(u.id)
  }
  /**
   * 分区此前完全未选时的关键语义：勾一个分组 = **只勾这一组**。
   *
   * 稀疏表示下「分区在 sections 里 + 没有任何排除」= 全选，所以这里的「加入分区」必须先
   * 把该分区**其余单元显式排除**，否则用户勾一个工作区会静默变成「660 个会话全带上」。
   */
  if (checked && wasOff) {
    for (const u of node.units) {
      if (!inGroup.has(u.id)) excluded.add(u.id)
    }
  }
  const sections = checked && wasOff ? [...sel.sections, node.section] : sel.sections
  return { sections, excluded: [...excluded] }
}

export function isUnitSelected(sel: Selection, unitId: string): boolean {
  return !sel.excluded.includes(unitId)
}

/** 分区三态：不可细分分区退回整体开关。 */
export function sectionPickState(sel: Selection, node: SelectionSection): SectionPickState {
  // **必须先看 sections**：`selectAll(nodes, false)` 产出的是 `{sections:[], excluded:[]}`（稀疏表示 ——
  // 不列 631 个单元 id）。此前本函数对「有清单的分区」只看 excluded，于是全不选之后凡是
  // **清单已加载**的分区都算成「全选」并显示为勾上，而未加载的分区显示未勾 —— 用户实测到
  // 的「点全不选后 UI 仍显示默认分区被选中，但导出按钮说没有选择任何分区」就是这个不一致。
  // 现在不再依赖「未勾选的分区必然把其单元全部列进 excluded」这条脆弱不变量。
  if (!sel.sections.includes(node.section)) return 'none'
  if (node.units.length === 0) return 'all'
  const excluded = new Set(sel.excluded)
  const selected = node.units.reduce((n, u) => (excluded.has(u.id) ? n : n + 1), 0)
  if (selected === 0) return 'none'
  return selected === node.units.length ? 'all' : 'partial'
}

/** 已勾选条目数（不可细分分区用宿主的 count 兜底）。 */
export function selectedUnitCount(sel: Selection, node: SelectionSection): number {
  // 同 sectionPickState：分区未勾选就是 0，不看 excluded（理由见上）
  if (!sel.sections.includes(node.section)) return 0
  if (node.units.length === 0) return node.count
  const excluded = new Set(sel.excluded)
  return node.units.reduce((n, u) => (excluded.has(u.id) ? n : n + 1), 0)
}

/**
 * 勾选/取消一个单元。
 * - **lockedWith 原子组联动**：组内任一成员的状态变化同步到全组（issue #35：
 *   pnpm-workspace.yaml 与 patch 文件拆开会让目标机 pnpm 拒绝一切 add）；
 * - 勾选单元时自动勾选其所属分区（避免出现「勾了条目却没选分区」的空转状态）。
 */
export function toggleUnit(sel: Selection, nodes: SelectionSection[], unitId: string, checked: boolean): Selection {
  const node = nodes.find((n) => n.units.some((u) => u.id === unitId))
  const unit = node?.units.find((u) => u.id === unitId)
  const group = new Set<string>([unitId, ...(unit?.lockedWith ?? [])])
  const excluded = new Set(sel.excluded)
  for (const id of group) {
    if (checked) excluded.delete(id)
    else excluded.add(id)
  }
  const wasOff = node !== undefined && !sel.sections.includes(node.section)
  /**
   * 分区此前完全未选时的关键语义（与 toggleUnitGroup 完全同一套）：勾一个单元 = **只勾这一个单元**。
   *
   * 稀疏表示下「分区在 sections 里 + 没有任何排除」= 全选，所以必须先显式排除该分区的其余单元。
   * 此前这里只把分区塞进 sections 而不排除兄弟单元，实测后果：
   *   {sections:[],excluded:[]} + toggleUnit('plugin:alpha',true)
   *     → {sections:['plugins'],excluded:[]} → 子计划里连带出现 plugin:beta。
   * 本地导入页因「默认全选」很少走到本分支，市场通道（与导入页同一套语义）里则是常路。
   */
  if (checked && wasOff && node !== undefined) {
    for (const u of node.units) {
      if (!group.has(u.id)) excluded.add(u.id)
    }
  }
  let sections = checked && wasOff && node !== undefined ? [...sel.sections, node.section] : sel.sections
  /**
   * 反向收口：取消勾选后本分区已无任何选中单元 → 分区随之移出 sections。
   * 否则 sections 会残留一个「已选 0 个单元」的分区，与 buildExportRequest / buildSelectedPlan
   * 「一个都没勾的分区不导出/不导入」的口径互相矛盾（分区计数与单元计数各说各话）。
   */
  if (!checked && node !== undefined && sel.sections.includes(node.section) && node.units.every((u) => excluded.has(u.id))) {
    sections = sections.filter((s) => s !== node.section)
  }
  return { sections, excluded: [...excluded] }
}

/** 分区级勾选（整体开关；不可细分分区只切 sections，不碰 excluded）。 */
export function toggleSection(sel: Selection, node: SelectionSection, checked: boolean): Selection {
  const sections = checked
    ? (sel.sections.includes(node.section) ? sel.sections : [...sel.sections, node.section])
    : sel.sections.filter((s) => s !== node.section)
  if (node.units.length === 0) return { sections, excluded: sel.excluded }
  const excluded = new Set(sel.excluded)
  for (const u of node.units) {
    if (checked) excluded.delete(u.id)
    else excluded.add(u.id)
  }
  return { sections, excluded: [...excluded] }
}

/** 全选 / 全不选（工具栏批量动作）：作用于当前可见（可能是搜索过滤后的）分区集合。 */
export function selectAll(nodes: SelectionSection[], checked: boolean): Selection {
  if (checked) return { sections: nodes.map((n) => n.section), excluded: [] }
  return { sections: [], excluded: [] }
}

export interface PickerSummary {
  /** 已勾选分区数 */
  sections: number
  /** 已勾选单元数（可细分分区按单元计，不可细分分区按整体计 1） */
  units: number
  /** 可见单元/分区总数（用于「N/M」） */
  totalUnits: number
  /** 估算体积合计（按勾选比例摊到分区，避免为未勾选项额外请求宿主） */
  sizeBytes: number
}

export function pickerSummary(sel: Selection, nodes: SelectionSection[]): PickerSummary {
  let sections = 0
  let units = 0
  let totalUnits = 0
  let sizeBytes = 0
  for (const node of nodes) {
    const checked = sel.sections.includes(node.section)
    if (node.units.length === 0) {
      totalUnits += 1
      if (checked) {
        sections += 1
        units += 1
        sizeBytes += node.sizeBytes
      }
      continue
    }
    totalUnits += node.units.length
    if (!checked) continue
    sections += 1
    const picked = node.units.reduce((n, u) => (sel.excluded.includes(u.id) ? n : n + 1), 0)
    units += picked
    // 体积按勾选比例摊分（分区内还可能有未被拆成单元的条目，如已并入包体积的本地 tarball）——
    // 宁可少报，也不虚报出实际不会导出的体积。
    sizeBytes += Math.round(node.sizeBytes * (picked / Math.max(1, node.units.length)))
  }
  return { sections, units, totalUnits, sizeBytes }
}

export interface ExportRequestPlan {
  only: SectionId[]
  /** 只在「部分勾选」的分区上下发；整分区全选或缺省 = 不下发（少一次误解的机会） */
  includeItems?: Partial<Record<SectionId, string[]>>
}

/**
 * Selection → 导出请求参数。这是本模型与引擎契约的唯一出口。
 *
 * 关键语义：**分区勾选但单元全被排除 = 该分区不导出**（不产出空载荷分区，
 * manifest.sections 如实为 false），与「取消勾选整个分区」等价 —— 用户在 UI 上
 * 看到的「一个都没勾」与引擎行为必须一致。
 */
export function buildExportRequest(sel: Selection, nodes: SelectionSection[]): ExportRequestPlan {
  const only: SectionId[] = []
  const includeItems: Partial<Record<SectionId, string[]>> = {}
  let partial = false
  for (const node of nodes) {
    if (!sel.sections.includes(node.section)) continue
    if (node.units.length === 0) {
      only.push(node.section)
      continue
    }
    const ids = node.units.filter((u) => !sel.excluded.includes(u.id)).map((u) => u.id)
    if (ids.length === 0) continue
    only.push(node.section)
    if (ids.length !== node.units.length) {
      includeItems[node.section] = ids
      partial = true
    }
  }
  return partial ? { only, includeItems } : { only }
}

/** 搜索过滤：按分区名/单元名/副标题匹配；命中的分区保留其全部单元（便于继续勾选同分区其它项）。 */
/** 会话单元 id（sessions:<projectKey>/<sessionId>）→ sessionId；非会话单元 → undefined。 */
/**
 * 会话单元 id（`sessions:<项目键>/<目录名>`）→ **cwd 目录键**（项目键）；非会话单元 / 形状不符 → undefined。
 *
 * 用途：勾选联动的第二判据 —— 与工作区单元的 `projectKey` 比较，口径与 DSH「把会话显示在工作区下」一致。
 */
/**
 * 工作区单元的 cwd 目录键：宿主直出的 `projectKey` 优先，缺省时用 `detail`（= 工作区绝对路径）现算。
 *
 * 为什么要有兜底：`projectKey` 是后加的宿主字段，**旧宿主**（未重启的 DSH 进程）不会回传它，而工作区单元的
 * `detail` 一直就是绝对路径。只在 detail 形如绝对路径时才现算 —— 计划项的 detail 是描述文案
 * （如 `current={...} imported={...}`），绝不会被误当成路径。
 */
export function workspaceProjectKeyOf(unit: { projectKey?: string; detail?: string }): string | undefined {
  if (unit.projectKey !== undefined && unit.projectKey !== '') return unit.projectKey
  const detail = unit.detail
  if (detail === undefined) return undefined
  if (!/^[a-zA-Z]:[\\/]/.test(detail) && !detail.startsWith('/')) return undefined
  return projectKeyOf(detail)
}

export function sessionProjectKeyOfUnit(unitId: string): string | undefined {
  if (!unitId.startsWith('sessions:')) return undefined
  const rest = unitId.slice('sessions:'.length)
  const slash = rest.lastIndexOf('/')
  return slash <= 0 ? undefined : rest.slice(0, slash)
}

export function sessionIdOfUnit(unitId: string): string | undefined {
  if (!unitId.startsWith('sessions:')) return undefined
  const rest = unitId.slice('sessions:'.length)
  const slash = rest.lastIndexOf('/')
  return slash < 0 ? undefined : rest.slice(slash + 1)
}

/* ----------------------------------------------------------------------------------
   会话「父对话 ↔ 子代理会话」联动（用户明确要求：勾父自动勾上它的 subagent 会话）
   ---------------------------------------------------------------------------------- */

/** 本次勾选动作（哪个单元、点完后是勾还是取消）—— 父/子两条规则必须按动作方向定夺。 */
export interface SessionParentChange {
  unitId: string
  checked: boolean
}

/**
 * 父对话 ↔ 子代理会话联动。三件事，全部由**用户勾选的父对话**这一侧驱动：
 *  - **勾父** → 连带勾上它的子代理会话（传递：子会话自己还有子会话也一起带）；
 *  - **勾子** → 连带勾上它的父对话（父链向上传递）—— 与导出的「向上补父对话」同口径，
 *    否则界面勾了子、包里却多出父，勾选与包内容不一致；
 *  - **取消父** → 连带取消它的子代理会话；**取消子** → 只取消这一条（父对话留着）。
 *
 * 为什么必须按动作方向（而不是无脑闭包）：两条规则会互相抵消 —— 取消父之后若还跑
 * 「已勾选的子 ⇒ 勾上父」，父立刻被勾回来（与工作区联动完全同一个坑，见 focus 的注释）。
 *
 * @param change 本次点击的单元与状态；缺省（分区/分组/全选等批量动作、清单到货后补跑）
 *   只做**正向闭包**：已勾选的父把子补齐、已勾选的子把父补齐，绝不取消任何东西。
 */
export function applySessionParentCoupling(
  sel: Selection,
  nodes: SelectionSection[],
  change?: SessionParentChange,
): Selection {
  const sessions = nodes.filter((n) => n.section === 'sessions').flatMap((n) => n.units)
  if (sessions.length === 0) return sel
  const byBare = new Map<string, SelectionUnit>()
  for (const unit of sessions) {
    const bare = sessionIdOfUnit(unit.id)
    if (bare !== undefined) byBare.set(sessionIdKey(bare), unit)
  }
  const children = sessions.filter((u) => u.parentSessionId !== undefined)
  if (children.length === 0) return sel
  const parentOf = (unit: SelectionUnit): SelectionUnit | undefined => {
    const parent = unit.parentSessionId
    return parent === undefined ? undefined : byBare.get(sessionIdKey(parent))
  }
  const childrenOf = (unit: SelectionUnit): SelectionUnit[] => {
    const bare = sessionIdOfUnit(unit.id)
    if (bare === undefined) return []
    const key = sessionIdKey(bare)
    return children.filter((c) => sessionIdKey(c.parentSessionId ?? '') === key)
  }
  /** 单元 id → 分区（取消勾选一个单元时要知道它属于哪个分区）。 */
  const sectionOf = new Map<string, SectionId>()
  for (const node of nodes) for (const unit of node.units) sectionOf.set(unit.id, node.section)
  // 不能用 isUnitSelected（稀疏表示的「未排除即选中」对整个分区没勾会误判，见 sectionPickState）
  const isPicked = (state: Selection, unitId: string): boolean => {
    const section = sectionOf.get(unitId)
    return section !== undefined && state.sections.includes(section) && !state.excluded.includes(unitId)
  }

  /** 正向闭包：从 start 出发把父链与子（传递）都勾上。 */
  const selectClosure = (state: Selection, start: SelectionUnit): Selection => {
    let out = state
    const upSeen = new Set<string>()
    let cur: SelectionUnit | undefined = start
    while (cur !== undefined) {
      const bare = sessionIdOfUnit(cur.id)
      if (bare === undefined || upSeen.has(sessionIdKey(bare))) break
      upSeen.add(sessionIdKey(bare))
      const parent = parentOf(cur)
      if (parent === undefined) break
      if (!isPicked(out, parent.id)) out = toggleUnit(out, nodes, parent.id, true)
      cur = parent
    }
    const queue: SelectionUnit[] = [start]
    const downSeen = new Set<string>()
    while (queue.length > 0) {
      const unit = queue.shift()
      if (unit === undefined) break
      const bare = sessionIdOfUnit(unit.id)
      if (bare === undefined || downSeen.has(sessionIdKey(bare))) continue
      downSeen.add(sessionIdKey(bare))
      for (const child of childrenOf(unit)) {
        if (!isPicked(out, child.id)) out = toggleUnit(out, nodes, child.id, true)
        queue.push(child)
      }
    }
    return out
  }

  /** 反向：取消 start 的整棵子树（start 自己由调用方那次 toggleUnit 处理）。 */
  const unselectSubtree = (state: Selection, start: SelectionUnit): Selection => {
    let out = state
    const queue: SelectionUnit[] = [start]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const unit = queue.shift()
      if (unit === undefined) break
      const bare = sessionIdOfUnit(unit.id)
      if (bare === undefined || seen.has(sessionIdKey(bare))) continue
      seen.add(sessionIdKey(bare))
      for (const child of childrenOf(unit)) {
        if (isPicked(out, child.id)) out = toggleUnit(out, nodes, child.id, false)
        queue.push(child)
      }
    }
    return out
  }

  if (change === undefined) {
    let out = sel
    for (const unit of sessions) {
      if (!isPicked(out, unit.id)) continue
      out = selectClosure(out, unit)
    }
    return out
  }
  const changed = sessions.find((u) => u.id === change.unitId)
  if (changed === undefined) return sel
  return change.checked ? selectClosure(sel, changed) : unselectSubtree(sel, changed)
}

/**
 * 会话 ↔ 工作区联动（issue #45）：① 勾了会话 → 自动勾上「拥有它的工作区」；② 取消工作区 → 它的会话也取消。
 *
 * 为什么写在选择模型层：导出页与导入向导共用同一个 ContentPicker，规则写一次两端行为一致
 * （「同样的勾选框不一样的行为」是本仓库明确要消灭的状态）。只按 sessionIds 匹配、不翻译路径：
 * 跨机时工作区路径与会话 cwd 都是源机形态，按路径匹配不可靠。无 sessionIds 的单元一律不参与联动（不猜）。
 */
/**
 * 本次勾选动作的方向：① 只勾会话 → 带上其工作区；② 只动工作区 → 撤销未勾工作区的会话；both = 两条都跑。
 *
 * 为什么必须有方向：两条规则在「会话勾着、它的工作区却被取消」这种状态下会互相抵消（谁后跑谁翻盘）。
 * 用动作方向定夺，行为才是确定的：取消工作区一定连带取消它的会话，勾上会话一定带上它的工作区。
 */
export type SessionWorkspaceCouplingFocus = 'sessions' | 'workspaces' | 'both'

/**
 * 会话↔工作区联动需要的**伙伴分区**（导出页的清单是逐分区惰性拉的）。
 *
 * 联动的唯一数据源是**工作区单元上的 `sessionIds`**：勾了会话但工作区清单还没读出来 → 没有 sessionIds 可读 →
 * 联动**静默失效**（用户真机复验：取消工作区后再勾一个对话，对应工作区不会回来）。所以只要勾了会话，就
 * 必须把工作区清单一起读出来；工作区记录是纯元数据（每条几十字节），这点代价可以忽略。
 *
 * 反向刻意不加（勾着工作区、会话清单没读）：那种状态下会话单元根本不在选择器里，没有需要联动的会话。
 */
export function couplingInventorySections(sections: readonly SectionId[]): SectionId[] {
  if (!sections.includes('sessions') || sections.includes('workspaces')) return [...sections]
  return [...sections, 'workspaces']
}

/** 两份选择是否等价（按集合；用于「清单到货后补一次联动」避免无谓写库 / 自激渲染）。 */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a.sections.length !== b.sections.length || a.excluded.length !== b.excluded.length) return false
  const sections = new Set(a.sections)
  const excluded = new Set(a.excluded)
  return b.sections.every((s) => sections.has(s)) && b.excluded.every((s) => excluded.has(s))
}

export function applySessionWorkspaceCoupling(
  sel: Selection,
  nodes: SelectionSection[],
  focus: SessionWorkspaceCouplingFocus = 'both',
): Selection {
  const sessionUnits = nodes.filter((n) => n.section === 'sessions').flatMap((n) => n.units)
  const workspaceUnits = nodes
    .filter((n) => n.section === 'workspaces')
    .flatMap((n) => n.units)
    // 参与联动的判据：有 sessionIds（注册表归属）或有 cwd 目录键（宿主给 / 由 detail 现算）。都没有 → 不参与。
    .filter((u) => (u.sessionIds?.length ?? 0) > 0 || workspaceProjectKeyOf(u) !== undefined)
  if (sessionUnits.length === 0 || workspaceUnits.length === 0) return sel
  /**
   * 本工作区单元是否拥有该会话。两套判据缺一不可：
   *  ① 注册表 `sessionIds`（精确归属，目录名两种形态归一化后比较）；
   *  ② **cwd 目录键相同**（`projectKey`）—— DSH 的 sessionIds 覆盖率很低（真机实测：可选择的 570 条会话里
   *     只有 23 条在里面），而 DSH 自己就是按「会话 cwd 的目录键 == 工作区 path 的目录键」把会话显示在
   *     工作区下的；只认 sessionIds 就会出现「界面把对话挂在某工作区下、勾它却不联动」。
   */
  const owns = (ws: SelectionUnit, unit: SelectionUnit): boolean => {
    const sessionId = sessionIdOfUnit(unit.id)
    if (sessionId !== undefined && (ws.sessionIds ?? []).some((id) => sessionIdKey(id) === sessionIdKey(sessionId))) return true
    const projectKey = sessionProjectKeyOfUnit(unit.id)
    if (projectKey === undefined) return false
    return workspaceProjectKeyOf(ws) === projectKey
  }
  // 不能用 isUnitSelected：它是稀疏表示下的「未排除即选中」，对「整个分区没勾」会误判为已选。
  const sectionOf = new Map<string, SectionId>()
  for (const node of nodes) for (const unit of node.units) sectionOf.set(unit.id, node.section)
  const isPicked = (state: Selection, unitId: string): boolean => {
    const section = sectionOf.get(unitId)
    return section !== undefined && state.sections.includes(section) && !state.excluded.includes(unitId)
  }
  let next = sel
  // ② 取消工作区后不能留下「有主、但主人全被取消」的会话（不变量；先跑，冲突时以「取消工作区」为准）。
  //    以**会话**为中心判定：同一 cwd 目录键下若还有别的已勾工作区，会话就名正言顺地留着（重复 path 不误伤）。
  if (focus !== 'sessions') {
    for (const unit of sessionUnits) {
      if (!isPicked(next, unit.id)) continue
      const owners = workspaceUnits.filter((ws) => owns(ws, unit))
      if (owners.length === 0) continue // 无主会话（注册表没登记、目录键也对不上）不参与联动：不猜、不动
      if (owners.some((ws) => isPicked(next, ws.id))) continue
      next = toggleUnit(next, nodes, unit.id, false)
    }
  }
  // ① 勾了会话 → 自动勾上拥有它的工作区
  if (focus !== 'workspaces') {
    for (const ws of workspaceUnits) {
      const ownsSelected = sessionUnits.some((unit) => isPicked(next, unit.id) && owns(ws, unit))
      if (ownsSelected && !isPicked(next, ws.id)) next = toggleUnit(next, nodes, ws.id, true)
    }
  }
  return next
}

export function filterSections(nodes: SelectionSection[], query: string): SelectionSection[] {
  const q = query.trim().toLowerCase()
  if (q === '') return nodes
  const out: SelectionSection[] = []
  for (const node of nodes) {
    if (node.section.toLowerCase().includes(q)) {
      out.push(node)
      continue
    }
    const units = node.units.filter((u) =>
      u.label.toLowerCase().includes(q) || (u.detail ?? '').toLowerCase().includes(q),
    )
    if (units.length > 0) out.push({ ...node, units })
  }
  return out
}

/* ==================================================================================
   导入侧（Phase 2）：计划项 → 选择模型 → 子计划
   ----------------------------------------------------------------------------------
   与导出侧**共用同一套 Selection / 两级树 / 交互语义**，只是「分区 → 单元」的来源不同：
   导出侧的单元来自 adapter.listUnits()（真实文件/插件），导入侧的单元来自 PlanItem
   （已由引擎算出「要做什么」）。因此选择器组件、三态判定、原子组联动全部复用。

   为什么必须有 unitId：skills / sessions 的计划项是**逐文件**的（`skills:bar/SKILL.md`、
   `skills:bar/ref.md`），按计划项勾选等于让用户拆散一个技能 bundle。适配器用与导出侧
   listUnits 同一套 unitIdOf 规则声明 unitId，两端自动对齐，UI 不猜前缀。
   ================================================================================== */

/**
 * 高风险分区（严格分层信任的默认：须用户显式勾选）。
 * 市场通道（配置市场装回）与本地导入共用同一份定义 —— 不再各自维护一套。
 */
export const HIGH_RISK_ADAPTERS: ReadonlySet<SectionId> = new Set<SectionId>([
  'pluginFiles', 'agentInstructions', 'agentPresets', 'sessions', 'mcp', 'plugins',
])

export function isHighRiskAdapter(adapter: SectionId): boolean {
  return HIGH_RISK_ADAPTERS.has(adapter)
}

/** 该项是否需要重启 DSH 才生效（Install 及插件级变更）。 */
export function itemNeedsRestart(adapter: SectionId, kind: PlanItemKind): boolean {
  if (kind === 'Install') return true
  if (adapter === 'plugins' || adapter === 'mcp' || adapter === 'agentPresets' || adapter === 'agentInstructions') return true
  return false
}

/** 计划中出现过的分区（去重）。 */
export function planAdapters(plan: ImportPlan): SectionId[] {
  const set = new Set<SectionId>()
  for (const item of plan.items) set.add(item.adapter)
  return [...set]
}

/**
 * 该计划项是否参与「可勾选」列表。
 * Warning / MissingDependency / Error 是纯诊断项（不写盘），列出来只会让用户以为勾掉能改变什么。
 * Skip 保留 —— 它表达「这台机器上已经一致」，是有信息量的。
 */
function isSelectableItem(item: PlanItem): boolean {
  return item.kind !== 'Warning' && item.kind !== 'MissingDependency' && item.kind !== 'Error'
}

/**
 * 单元展示名：剥掉分区前缀（`skills:bar` → `bar`）与常见实体前缀（`plugin:x` → `x`）。
 * 导出给 `src/ui/market-import.ts`（市场逐项摘要用同一套命名口径，不另写一套剥前缀规则）。
 */
export function unitLabel(unitId: string, adapter: SectionId): string {
  const own = adapter + ':'
  if (unitId.startsWith(own)) return unitId.slice(own.length)
  const m = /^(plugin|workspace|patch|prompt|mcp|secret):(.+)$/.exec(unitId)
  return m !== null ? (m[2] as string) : unitId
}

/**
 * 计划 → 选择模型（分区 → 最小单元）。
 * 单元 id 优先取 PlanItem.unitId（适配器声明），缺省退回项 id；与导出侧同一命名空间。
 */
export function sectionsFromPlan(plan: ImportPlan): SelectionSection[] {
  const byAdapter = new Map<SectionId, Map<string, SelectionUnit>>()
  const order: SectionId[] = []
  for (const item of plan.items) {
    if (!isSelectableItem(item)) continue
    let units = byAdapter.get(item.adapter)
    if (units === undefined) {
      units = new Map<string, SelectionUnit>()
      byAdapter.set(item.adapter, units)
      order.push(item.adapter)
    }
    const unitId = item.unitId ?? item.id
    if (!units.has(unitId)) {
      units.set(unitId, {
        id: unitId,
        // 宿主给的展示名优先（sessions 的会话标题）；缺省退回单元 id 剥前缀（会话目录名）
        label: item.label ?? unitLabel(unitId, item.adapter),
        ...(item.group !== undefined ? { group: item.group } : {}),
        ...(item.sessionIds !== undefined ? { sessionIds: item.sessionIds } : {}),
        ...(item.projectKey !== undefined ? { projectKey: item.projectKey } : {}),
        sizeBytes: 0,
      })
    }
  }
  return order.map((adapter) => {
    const units = [...(byAdapter.get(adapter) ?? new Map()).values()]
    return { section: adapter, count: units.length, sizeBytes: 0, units }
  })
}

/**
 * 计划的默认选择。
 * - `highRiskDefaultOff: false`（本地导入，D2）：全部勾选 —— 本地备份的信任级别高于市场，
 *   且保持改造前的行为（原本就是全量导入），不制造"看起来能导入却没勾"的困惑；
 * - `highRiskDefaultOff: true`（市场装回）：高风险分区默认不勾（严格分层信任）。
 * 差异只由这一个入参表达，**不是两套逻辑**。
 */
export function defaultSelectionFromPlan(plan: ImportPlan, opts: { highRiskDefaultOff?: boolean } = {}): Selection {
  const sections = planAdapters(plan).filter((a) => (opts.highRiskDefaultOff === true ? !isHighRiskAdapter(a) : true))
  return { sections, excluded: [] }
}

/** 该项是否被排除（未勾选其分区，或其自身/所属单元命中排除集）。 */
export function isPlanItemExcluded(item: PlanItem, selection: Selection): boolean {
  if (!selection.sections.includes(item.adapter)) return true
  if (selection.excluded.includes(item.id)) return true
  return item.unitId !== undefined && selection.excluded.includes(item.unitId)
}

/** 被用户排除的计划项（供报告如实展示「N 项未导入」）。 */
export function excludedPlanItems(plan: ImportPlan, selection: Selection): PlanItem[] {
  return plan.items.filter((item) => isSelectableItem(item) && isPlanItemExcluded(item, selection))
}

/**
 * 选择是否**留下了**计划中的任何一项（UI-05「全不选」守卫）。
 *
 * 无 = 用户把所有分区/条目都取消了 → 执行这次导入不会写入任何东西
 * （只会建一个安全快照并报成功），所以向导必须在预览步就地提示并禁用「下一步」，
 * 与导出侧的 `nothingSelected`（`buildExportRequest(...).only.length === 0`）同一套语义。
 * 判据与执行侧完全同源（同一个 isPlanItemExcluded）—— 不写第二套「空」判定。
 */
export function selectionHasItems(plan: ImportPlan, selection: Selection): boolean {
  return plan.items.some((item) => !isPlanItemExcluded(item, selection))
}

/**
 * 按选择裁剪计划 → 子计划。这是本模型与导入引擎的唯一出口。
 *
 * 三处必须**同步重算**，否则会出鬼故事（实测过的坑）：
 *  - `items`：执行依据（引擎只跑 plan.items）；
 *  - `needsRestart`：不能沿用整份计划的值，否则取消安装插件后仍提示「需重启」；
 *  - `estimatedActions`：进度/预估口径（与 analyzer 一致地跳过 Skip/Warning）；
 *  - `missingSecrets`：**必须跟着过滤** —— 否则用户取消了某插件，向导仍会索要它的密钥。
 */
export function buildSelectedPlan(plan: ImportPlan, selection: Selection): ImportPlan {
  const items = plan.items.filter((item) => !isPlanItemExcluded(item, selection))
  let needsRestart = false
  const estimatedActions: Partial<Record<SectionId, number>> = {}
  for (const item of items) {
    if (itemNeedsRestart(item.adapter, item.kind)) needsRestart = true
    if (item.kind === 'Skip' || item.kind === 'Warning') continue
    estimatedActions[item.adapter] = (estimatedActions[item.adapter] ?? 0) + 1
  }
  return {
    items,
    globalStrategy: plan.globalStrategy,
    pathMappings: plan.pathMappings,
    // 与 analyzer 同源：由**存活下来**的 MissingSecret 计划项反推。
    // 只按 excluded 过滤原数组是不够的 —— 用户把 credentialsStatus 整个分区取消时，
    // 原数组里的 ref 没有任何一项被「点名排除」，却也不该再索要密钥。
    missingSecrets: items
      .filter((item) => item.kind === 'MissingSecret')
      .map((item) => ({ ref: item.id.replace(/^secret:/, ''), required: true })),
    needsRestart,
    estimatedActions: estimatedActions as ImportPlan['estimatedActions'],
    ...(plan.skippedTombstoned !== undefined ? { skippedTombstoned: plan.skippedTombstoned } : {}),
  }
}

/**
 * 导入选择 + 它所属的 ZIP 路径。
 *
 * 为什么要绑定 zipPath：换一份备份后，旧选择里的分区 id 可能在新计划里不存在，
 * 直接沿用会让「未勾选该分区」= 全部项被排除 —— 导入会**静默变成什么都没做**。
 * 绑上 zipPath 后，陈旧选择自动失效回落到默认全选，无需在向导的每个 reset 点手动清空
 * （那种散落的清空逻辑正是最容易漏一处的地方）。
 */
export interface ImportSelectionState {
  zipPath: string
  selection: Selection
}

/** 生效的导入选择：陈旧（不同 ZIP）或未设置 → 默认全选。 */
export function effectiveImportSelection(
  plan: ImportPlan | null,
  zipPath: string | null,
  state: ImportSelectionState | null,
): Selection | null {
  if (plan === null) return null
  if (state !== null && zipPath !== null && state.zipPath === zipPath) return state.selection
  return defaultSelectionFromPlan(plan)
}

/** 生效的导入计划（选择裁剪后的子计划）；plan 为空时返回 null。 */
export function effectiveImportPlan(
  plan: ImportPlan | null,
  zipPath: string | null,
  state: ImportSelectionState | null,
): ImportPlan | null {
  const selection = effectiveImportSelection(plan, zipPath, state)
  return plan === null || selection === null ? null : buildSelectedPlan(plan, selection)
}

/* ----------------------------------------------------------------------------------
   市场通道（Phase 3）：与本地导入**完全同一套** Selection 语义
   ----------------------------------------------------------------------------------
   市场装回（浏览条目详情 / 我的配置→装回本地）曾在 market-view.ts 里自带一套「分区级布尔批准表」
   （MarketApprovals / defaultApprovals / buildApprovedPlan / approvalRows），并让高风险分区默认不勾。
   该表已删除：市场通道现在与导入页共用本模块的 Selection（默认全选、「全选」含高风险分区），
   差异只剩「从 market/download 的 plan 派生节点」与「逐项摘要」两个纯展示关切 ——
   它们住在 src/ui/market-import.ts，不在这里再长第二套选择逻辑。
   ---------------------------------------------------------------------------------- */

