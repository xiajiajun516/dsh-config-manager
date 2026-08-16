/**
 * m3: 进度展示的纯逻辑层（框架无关，node 可测）。
 *
 * 背景：m1 的 RunState 携带真实进度（section/sectionTotal = 当前分区 3/12、
 * item/itemTotal = 内部计数如插件 6/18、detail = 当前项名）；m2 的 store 把
 * RunState 映射为 ProgressEvent 并存入 progress 字段。本模块定义客户端的
 * RunProgress（ProgressEvent 超集，额外携带分区/内部计数，JSON 可序列化），
 * 并提供 computeProgressView() 把进度事件转成渲染模型 —— ProgressBar 只做
 * 纯渲染，所有判定逻辑集中在此、可单测。
 *
 * 兼容路径：无 section/item 的普通 ProgressEvent（控制器 onProgress 发出）
 * 走原逻辑 —— 阶段文案 + step/total 百分比，无徽章。
 */
import { stageText } from '../../ui/progress.ts'
import { zhUiT, type UiT } from '../../ui/i18n.ts'
import type { ProgressEvent } from '../../ui/types.ts'

/** m3: 客户端进度事件 = ProgressEvent 超集（RunState 轮询映射产物；可 JSON 序列化）。 */
export interface RunProgress extends ProgressEvent {
  /** 当前分区（adapter id / 阶段名）与分区总数（如 settings · 3/12）；导入无此语义为 null */
  section?: string | null
  sectionTotal?: number | null
  /** 内部计数（如插件 6/18；导出 = 分区序号，导入 = 已处理计划项数） */
  item?: number | null
  itemTotal?: number | null
}

/** 徽章渲染数据（label · current/total）。 */
export interface ProgressBadge {
  label: string
  current: number
  total: number
}

/** ProgressBar 的渲染模型（纯数据，测试断言用）。 */
export interface ProgressView {
  /** 阶段文案（stageText） */
  label: string
  /** 百分比（step/total；无则 null = 不定态动画） */
  percent: number | null
  /** 当前分区徽章（settings · 3/12） */
  sectionBadge: ProgressBadge | null
  /** 内部计数徽章（plugins · 6/18；导出时与分区计数同源则去冗余） */
  countBadge: ProgressBadge | null
  /** 当前项名（detail；与分区名相同时去冗余） */
  detail: string | null
}

/**
 * 把进度事件换算成渲染模型。
 * - percent：优先 ProgressEvent.step/total（控制器阶段进度 / 轮询的内部计数）；
 * - sectionBadge（当前分区，如 settings · 3/12）：label=分区 id、current=item
 *   （1-based 分区序号，见 core exporter onSection）、total=sectionTotal；
 * - countBadge（内部计数，如 plugins · 6/18）：label=分区 id、current=item、
 *   total=itemTotal；导出时 itemTotal 与 sectionTotal 同值（分区序号即内部计数）
 *   → 置 null，避免「3/12 3/12」重复；
 * - detail（当前项名）：非空且不等于分区 id（导出时 detail 恒为分区 id，去冗余）。
 */
export function computeProgressView(event: RunProgress | null, t: UiT = zhUiT): ProgressView {
  if (event === null) {
    return { label: '', percent: null, sectionBadge: null, countBadge: null, detail: null }
  }
  const section = event.section ?? null
  const sectionTotal = event.sectionTotal ?? null
  const item = event.item ?? null
  const itemTotal = event.itemTotal ?? null

  const percent =
    event.step !== undefined && event.total !== undefined && event.total > 0
      ? Math.round((event.step / event.total) * 100)
      : item !== null && itemTotal !== null && itemTotal > 0
        ? Math.round((item / itemTotal) * 100)
        : null

  const sectionBadge: ProgressBadge | null =
    section !== null && item !== null && sectionTotal !== null && sectionTotal > 0
      ? { label: section, current: item, total: sectionTotal }
      : null

  let countBadge: ProgressBadge | null =
    section !== null && item !== null && itemTotal !== null && itemTotal > 0
      ? { label: section, current: item, total: itemTotal }
      : null
  if (countBadge !== null && sectionBadge !== null && itemTotal === sectionTotal) {
    // 导出：item/itemTotal 与 section/sectionTotal 同源（当前分区序号），去冗余
    countBadge = null
  }

  const detail =
    typeof event.detail === 'string' && event.detail !== '' && event.detail !== section
      ? event.detail
      : null

  return { label: stageText(event.stage, t), percent, sectionBadge, countBadge, detail }
}
