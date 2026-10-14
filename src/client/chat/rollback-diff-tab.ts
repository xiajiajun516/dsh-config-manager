/**
 * 回滚点「查看」→ DSH 右侧栏「回滚差异」标签页：地址契约、标题、打开动作与形态收窄
 * （框架无关纯函数，node 可测；React 壳在 RollbackDiffTab.tsx）。
 *
 * ## 为什么需要自建 tab 类型
 * DSH 右侧栏的正文位 `sidebar.right.pane.tab` 是 **keyed** 位：每个 tab 类型由插件自己注册
 * （type definition + 正文组件），资源地址由 `ctx.sidebarRight.openResource(address)` 打开。
 * 内置类型只有文件/文档预览（`dsh-resource://file/**`）—— 它们显示的是文件**当前内容**，
 * 拿不到回滚点的快照，所以「查看这次回退会给该文件改什么」必须由本插件注册自己的类型。
 *
 * ## 地址契约（本文件是唯一事实源）
 *   `dsh-resource://cm-rollback-diff/<pointId>/<encodeURIComponent(绝对路径)>`
 * · pointId 与路径**都**编码（Windows 盘符与反斜杠不进地址正文，地址不受分隔符歧义影响）；
 * · 解析失败一律返回 null —— 调用方按「地址坏了」如实降级，绝不猜。
 *
 * ## 纪律
 * · **抽出来的方法一律 bind 回服务对象**（`openResource` / `register` 都读 `this`；丢 receiver 会抛，
 *   见 AGENTS.md 与 docs/lessons/recovery-console.md 的 `uiWorkspace.openSession` 事故）；
 * · 服务缺失 / 形态不符 / 调用抛错统统是**降级**（返回结构化结果），绝不打挂插件装配。
 */

/** DSH 右侧栏的 tab 正文位（keyed）。 */
export const ROLLBACK_DIFF_SLOT = 'sidebar.right.pane.tab'
/**
 * DSH 右侧栏的 tab **芯片**位（keyed，key 同正文位）。
 *
 * 为什么需要它：宿主的 tab 类型定义**没有 icon 字段**（芯片只由 title 文字画出来，见 dsh-better-sidebar
 * 的 tab-adapter 注释），所以「文件名前面那颗文件类型图标」只能由这个位子自己画。
 * 不注册 / 宿主没有这个位子：芯片退回宿主自己画的标题文字（只少一颗图标，不打挂任何东西）。
 */
export const ROLLBACK_DIFF_TITLE_SLOT = 'sidebar.right.pane.tab.title'
/** 本插件 tab 类型的实现 id（正文注册的 key，也是 layout 记录里的身份）。 */
export const ROLLBACK_DIFF_TAB_ID = 'config-manager.rollback-diff'
/** 本插件 tab 类型的 kind（地址认领与 openResource 都用它）。 */
export const ROLLBACK_DIFF_TAB_KIND = 'cm-rollback-diff'
/** 资源地址前缀（DSH 只认 dsh-resource:// 方案）。 */
export const ROLLBACK_DIFF_ADDRESS_PREFIX = 'dsh-resource://cm-rollback-diff/'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function safeDecode(part: string): string | null {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

/** 路径末段（兼容 Windows 反斜杠与 POSIX 斜杠；末尾分隔符会被忽略）。 */
export function rollbackDiffBaseName(filePath: string): string {
  const trimmed = filePath.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at < 0 ? trimmed : trimmed.slice(at + 1)
}

/** 一个 tab 的目标（点 id + 该点里**记录在案**的绝对路径）。 */
export interface RollbackDiffTarget {
  pointId: string
  path: string
}

/** 构造资源地址（本文件是唯一事实源）。 */
export function rollbackDiffAddress(pointId: string, filePath: string): string {
  return ROLLBACK_DIFF_ADDRESS_PREFIX + encodeURIComponent(pointId) + '/' + encodeURIComponent(filePath)
}

/** 解析资源地址；不是本类型 / 形状不成 / 解码失败一律 null。 */
export function parseRollbackDiffAddress(address: unknown): RollbackDiffTarget | null {
  if (typeof address !== 'string' || !address.startsWith(ROLLBACK_DIFF_ADDRESS_PREFIX)) return null
  const rest = address.slice(ROLLBACK_DIFF_ADDRESS_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  const pointId = safeDecode(rest.slice(0, slash))
  const path = safeDecode(rest.slice(slash + 1))
  if (pointId === null || path === null || pointId === '' || path === '') return null
  return { pointId, path }
}

/** tab 标题 = 文件名（地址坏掉时回落空串，侧栏自己会用类型名兜底）。 */
export function rollbackDiffTitle(address: unknown): string {
  const target = parseRollbackDiffAddress(address)
  return target === null ? '' : rollbackDiffBaseName(target.path)
}

/** tab 类型定义（DSH `sidebarRightTabs.register` 的入参面；只列我们真的给的字段）。 */
export interface RollbackDiffTabDefinition {
  id: string
  kind: string
  patterns: string[]
  title: (address: string) => string
  canOpen?: (address: string) => boolean
}

/** 本插件注册的类型定义（常量，避免装配点写字面量）。 */
export function rollbackDiffTabDefinition(): RollbackDiffTabDefinition {
  return {
    id: ROLLBACK_DIFF_TAB_ID,
    kind: ROLLBACK_DIFF_TAB_KIND,
    patterns: [ROLLBACK_DIFF_ADDRESS_PREFIX + '**'],
    title: (address) => rollbackDiffTitle(address),
    canOpen: (address) => parseRollbackDiffAddress(address) !== null,
  }
}

/** `ctx.sidebarRightTabs` 的收窄面（注册 tab 类型）。 */
export interface SidebarRightTabsFace {
  register: (definition: RollbackDiffTabDefinition) => unknown
}

/** `ctx.sidebarRight` 的收窄面（打开资源）。 */
export interface SidebarRightFace {
  openResource: (address: string, options?: { kind?: string }) => void
}

/**
 * 收窄 `ctx.sidebarRightTabs`（缺 `register` = 本机没有这个能力 ⇒ undefined，调用方不注册）。
 * bind 回原对象：register 读 `this.ids` / `this.kinds`，丢 receiver 必然抛。
 */
export function asSidebarRightTabsFace(value: unknown): SidebarRightTabsFace | undefined {
  const record = asRecord(value)
  if (record === null) return undefined
  const register = record['register']
  if (typeof register !== 'function') return undefined
  return { register: register.bind(record) as SidebarRightTabsFace['register'] }
}

/** 收窄 `ctx.sidebarRight`（缺 `openResource` = 没有打开能力 ⇒ undefined）。 */
export function asSidebarRightFace(value: unknown): SidebarRightFace | undefined {
  const record = asRecord(value)
  if (record === null) return undefined
  const openResource = record['openResource']
  if (typeof openResource !== 'function') return undefined
  return { openResource: openResource.bind(record) as SidebarRightFace['openResource'] }
}

/** 打开结果：`no-sidebar` = 本机没有侧栏能力（界面据此降级为弹窗内展示）；`failed` = 有入口但调用抛错。 */
export type RollbackDiffOpenResult =
  | { ok: true }
  | { ok: false; reason: 'no-sidebar' | 'failed'; detail?: string }

/** 打开该文件的差异标签页（打开动作本身**不做任何写操作**）。 */
export function openRollbackDiff(sidebar: SidebarRightFace | undefined, address: string): RollbackDiffOpenResult {
  if (sidebar === undefined) return { ok: false, reason: 'no-sidebar' }
  try {
    sidebar.openResource(address, { kind: ROLLBACK_DIFF_TAB_KIND })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 槽位声明形态探测面（`ctx.slots.spec`）。 */
export interface RollbackDiffSlotProbe {
  spec: (name: string) => unknown
}

/**
 * 探测某个位的声明形态：只有 `keyed` 才能按 key 注册（0.1.x 没有这个槽位 ⇒ null）。
 * 形态不符时**不注册**（只丢这一个能力，不拿插件其余槽位与宿主启动去赌）。
 * @param probe - 槽位声明探测面（`ctx.slots.spec` 的收窄）。
 * @param slot - 要探测的位名（缺省 = tab 正文位；芯片位传 `ROLLBACK_DIFF_TITLE_SLOT`）。
 */
export function declaredPaneTabKind(probe: RollbackDiffSlotProbe | null | undefined, slot: string = ROLLBACK_DIFF_SLOT): string | null {
  if (probe === null || probe === undefined || typeof probe.spec !== 'function') return null
  try {
    const spec = probe.spec(slot)
    const record = typeof spec === 'object' && spec !== null ? spec as { kind?: unknown } : null
    return typeof record?.kind === 'string' ? record.kind : null
  } catch {
    return null
  }
}
