/**
 * 远端依赖清单的**展示判定**（React 无关、可单测）—— 组件只装配，判定全在这里。
 *
 * 两条纪律：
 *  1. **禁止渲染裸枚举**：清单行的 \`status\` 一律经本模块映射成字典键（穷尽 Record
 *     \`Record<InventoryStatus, …>\` → 宿主新增状态而此处漏配 = 编译期错误）。运行期遇到
 *     未知状态（前端新、宿主旧）回落 \`unknown\` 文案，绝不把枚举名直接显示给用户。
 *  2. **诚实三态**：远端不可达 / 半装 / 缺席 各自有独立的视觉与措辞（见 statusView 的 kind）。
 *
 * 与宿主内核的分工：数据形状与判定在 \`src/core/plugin-inventory.ts\`（纯函数、宿主侧执行），
 * 本模块只做「事实 → 徽章语义 + 文案键」。
 */
import type { InventoryEntry, InventoryResult, InventoryStatus } from '../../core/plugin-inventory.ts'
import type { SyncKey } from './sync-locales.ts'

/** 徽章语义（与 common/ui 的 Badge/Banner 四态同值域）。 */
export type InventoryBadgeKind = 'ok' | 'info' | 'warn' | 'error'

export interface InventoryStatusView {
  kind: InventoryBadgeKind
  /** 状态短标签（表格单元格） */
  labelKey: SyncKey
  /** 状态解释（title / ⓘ 用；一句话说明「这意味着什么」） */
  hintKey: SyncKey
}

/**
 * 状态 → 展示（**穷尽映射**）。
 *
 * 语义色口径：只用 warn 表达「需要你处理」（半装 / 缺席），ok 表达「正常挂载」，
 * info 表达「正常、但不是挂载项」（普通依赖 / 宿主自带层 / 仅配置引用）。
 */
export const INVENTORY_STATUS_VIEW: Record<InventoryStatus, InventoryStatusView> = {
  'enabled': { kind: 'ok', labelKey: 'inventory.status.enabled', hintKey: 'inventory.statusHint.enabled' },
  'half-installed': { kind: 'warn', labelKey: 'inventory.status.halfInstalled', hintKey: 'inventory.statusHint.halfInstalled' },
  'dependency-only': { kind: 'info', labelKey: 'inventory.status.dependencyOnly', hintKey: 'inventory.statusHint.dependencyOnly' },
  'host-resolved': { kind: 'info', labelKey: 'inventory.status.hostResolved', hintKey: 'inventory.statusHint.hostResolved' },
  'missing': { kind: 'warn', labelKey: 'inventory.status.missing', hintKey: 'inventory.statusHint.missing' },
  'configuration-only': { kind: 'info', labelKey: 'inventory.status.configurationOnly', hintKey: 'inventory.statusHint.configurationOnly' },
}

/** 未知状态的回落（宿主比前端新时不得显示枚举名）。 */
export const INVENTORY_STATUS_UNKNOWN_VIEW: InventoryStatusView = {
  kind: 'info',
  labelKey: 'inventory.status.unknown',
  hintKey: 'inventory.statusHint.unknown',
}

/** 行状态 → 展示。未知状态一律回落 unknown，绝不抛错（表格不能因一行坏数据整表消失）。 */
export function inventoryStatusView(status: string): InventoryStatusView {
  return (INVENTORY_STATUS_VIEW as Record<string, InventoryStatusView | undefined>)[status] ?? INVENTORY_STATUS_UNKNOWN_VIEW
}

/** 行上的**附加标记**（状态之外的事实，可为 0..n 个）。 */
export function inventoryChips(entry: InventoryEntry): SyncKey[] {
  const chips: SyncKey[] = []
  // 「本地来源已失效」优先单独成标记：它让「重装 / 换机」直接失败，比「本地来源」本身更要紧
  if (entry.sourceArchived) chips.push('inventory.chip.sourceArchived')
  else if (entry.localSource) chips.push('inventory.chip.localSource')
  return chips
}

/** 行的「来源 / 声明」事实行：本机 spec、远端 spec 各一条（都为空 → 纯配置引用）。 */
export interface InventorySourceLine {
  key: 'inventory.src.local' | 'inventory.src.remote'
  spec: string
}

/**
 * 行 → 来源行清单。
 *
 * \`requested\`/\`remoteSpec\` **只在 \`remoteAvailable\` 为真时**才作为「远端声明」展示 ——
 * 远端不可达时它们恒为 false/undefined（宿主不会猜），界面也就不会写出「远端没声明」这种谎话。
 */
export function inventorySourceLines(entry: InventoryEntry, remoteAvailable: boolean): InventorySourceLine[] {
  const lines: InventorySourceLine[] = []
  if (entry.localSpec !== undefined && entry.localSpec !== '') {
    lines.push({ key: 'inventory.src.local', spec: entry.localSpec })
  }
  if (remoteAvailable && entry.requested) {
    lines.push({ key: 'inventory.src.remote', spec: entry.remoteSpec ?? '' })
  }
  return lines
}

/** 汇总统计（徽章行数据源；全部现算，不另存一份）。 */
export interface InventorySummary {
  total: number
  enabled: number
  halfInstalled: number
  missing: number
  configurationOnly: number
}

/** 结果 → 统计。缺 counts（旧宿主）时按行现算，保证徽章不空。 */
export function summarizeInventory(result: InventoryResult): InventorySummary {
  const c = result.counts
  if (c !== undefined && c !== null) {
    return {
      total: c.total,
      enabled: c.enabled,
      halfInstalled: c.halfInstalled,
      missing: c.missing,
      configurationOnly: c.configurationOnly,
    }
  }
  return {
    total: result.entries.length,
    enabled: result.entries.filter((e) => e.status === 'enabled').length,
    halfInstalled: result.entries.filter((e) => e.halfInstalled).length,
    missing: result.entries.filter((e) => e.status === 'missing').length,
    configurationOnly: result.entries.filter((e) => e.configurationOnly).length,
  }
}
