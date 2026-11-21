/**
 * 落盘前的值级脱敏（从 src/client/run-store.ts 下沉，体量棘轮）。
 *
 * 这里是 sessionStorage 这条「第二出口」的唯一脱敏实现：默认拒绝 + 显式放行 + 值级脱敏 + 按
 * 「引用 + 深度」缓存。规则与判据见 AGENTS.md「sessionStorage 白名单」与
 * src/security/redaction.ts 的 `matchSecretValuePattern` 单一事实源。
 */
import { REDACTED, redact } from '../security/redaction.ts'

/**
 * 深度脱敏时**必须原样保留**的功能字段名（宿主按它们执行 / 快照登记 / 逐项决策）。
 *
 * 为什么需要例外：`redact()` 的结构化模式会把 `secret:K1` 这类**标识符**当成
 * `field: value` 形态脱敏（字段名 `secret` 命中敏感名单）。这类值既是 plan item 的 id、
 * 也是宿主执行时对项的键，改写会让导入对不上项；而它们本身不是配置内容、不含秘密。
 */
const PERSIST_FUNCTIONAL_KEYS: ReadonlySet<string> = new Set([
  'id', 'itemId', 'unitId', 'ref', 'adapter', 'kind',
])

/**
 * 深脱敏的递归深度上限（防御病态/循环结构；宿主载荷来自 JSON.parse，实际远不及此）。
 *
 * t38：到达上限时**整棵子树替换为占位**（不再是「原样返回」），于是
 * ① 深层明文不可能借上限穿透到 sessionStorage；
 * ② 同一节点的脱敏结果与「从哪个深度进入」有关（浅处是脱敏投影、超限处是占位）
 *    —— 缓存键必须带上深度，见下。
 */
const REDACT_MAX_DEPTH = 32

/**
 * 超深子树的占位值（t38）：复用渲染路径同一个脱敏标记（security/redaction.ts 的
 * `REDACTED`）—— **不新增用户可见文案**（AGENTS.md §i18n：文案进字典；这里刻意复用
 * 已有常量，既不改 locales 也不新造中/英文字符串）。
 *
 * 可读性语义：刷新后若真有超深分支被替换，界面与持久化载荷里显示的就是用户已经熟悉的
 * `***REDACTED***`，语义 =「这里原本有内容，按安全策略整棵屏蔽」，而不是「数据丢失」。
 * 真实宿主载荷（plan → items[] → conflict → local/remote …）深度约 4~5 层，远不及上限，
 * 所以这是纯防御路径；一旦命中，宁可牺牲这部分可读性也不让明文落盘。
 */
const REDACT_DEPTH_PLACEHOLDER: string = REDACTED

/**
 * 深脱敏结果缓存（t27：回收 P0-9 引入的重复计算）。
 *
 * **键 = 对象引用（WeakMap）+ 递归深度**，值是节点 → 已脱敏投影：
 * - 用 WeakMap 而不是序列化指纹：序列化本身就是要省掉的开销；引用比较是 O(1)，
 *   且键随载荷一起被 GC（不会拖住配置体量的大对象）；
 * - 深度一起进键：超限子树被替换为占位（t38）、浅处是脱敏投影，跨深度复用会让输出与「直接脱敏」不一致
 *   —— 缓存**只允许省计算，不允许改变结果**。每个节点按其实际出现的每个深度各留一份
 *   （通常 1~2 个），因此共享子对象（如 market.detail.analysis 与 import.analysis 是
 *   同一对象）不会互相覆盖、也不会互相污染；
 * - **不可变前提**：这些宿主载荷在 store 里只被**整体替换**、从不原地修改
 *   （证据：ui/import-wizard.ts 只有 `this.plan = ...` 赋值；ui/conflict-view.ts 的
 *   ConflictCollector 对 plan 只读、决策另存 Map）。所以「同一引用 = 同一内容」成立。
 *   若将来有代码**原地改载荷内容**，必须改成替换新对象，否则缓存会返回陈旧结果。
 *
 * 命中粒度 = 每个载荷节点：热路径（导入/恢复轮询每 500ms 一次 patch）只替换切片里的
 * progress/runId，载荷根引用不变 → 根节点直接命中，整棵子树零重算。
 */
const redactCache = new WeakMap<object, Map<number, unknown>>()

/** 取缓存（按引用 + 深度）。 */
function readRedactCache(value: object, depth: number): { hit: true; value: unknown } | { hit: false } {
  const byDepth = redactCache.get(value)
  if (byDepth === undefined) return { hit: false }
  if (!byDepth.has(depth)) return { hit: false }
  return { hit: true, value: byDepth.get(depth) }
}

/** 写缓存（按引用 + 深度）。 */
function writeRedactCache(value: object, depth: number, out: unknown): void {
  const byDepth = redactCache.get(value)
  if (byDepth === undefined) {
    redactCache.set(value, new Map([[depth, out]]))
    return
  }
  byDepth.set(depth, out)
}

/**
 * 落盘前的**值级脱敏**（P0-9）：递归遍历宿主下发的载荷（plan / analysis / result /
 * confirmSession / snapshots.plan / market.detail 等），把每个字符串过一遍 `redact()`
 * —— 命中「敏感字段名（JSON / kv / colon 形态）」或「密钥值形状（sk- / JWT / AKIA /
 * PEM / Bearer / URL query）」的值替换为 `***REDACTED***`。
 *
 * 为什么落盘也要做：`redact()` 此前只守渲染路径（组件渲染前才调用），而 sessionStorage
 * 是同一份文本的**第二条出口** —— 落盘后刷新又会被 applyPersisted 读回内存。
 *
 * - 只递归普通对象/数组/字符串；深度在上限内时 Date / Uint8Array / 类实例原样返回（不重建）；
 * - 功能字段（PERSIST_FUNCTIONAL_KEYS）整棵子树跳过，保证 id/ref 不被改写；
 * - **超过 REDACT_MAX_DEPTH 的子树整棵替换为 REDACT_DEPTH_PLACEHOLDER**（t38）：既不下钻
 *   也不原样返回 —— 深层明文绝不落盘（代价是该分支不可读，语义见占位常量注释）；
 * - 幂等：`***REDACTED***` 不匹配任何模式（见 security/redaction.ts）；
 * - 结果按「引用 + 深度」缓存（t27），未变化的载荷不重复深脱敏。
 */
export function redactPersistedValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  const cached = readRedactCache(value, depth)
  if (cached.hit) return cached.value as T
  if (depth >= REDACT_MAX_DEPTH) {
    // t38：超深子树**整棵替换为占位** —— 数组与非普通对象一视同仁，此前是「原样返回」。
    // 注：字符串不会走到这里（其父对象在 depth == 上限-1 时才递归下来，字符串按常规规则
    // 脱敏），所以「超限即占位」不会让任何**可达**字符串逃过脱敏。
    writeRedactCache(value, depth, REDACT_DEPTH_PLACEHOLDER)
    return REDACT_DEPTH_PLACEHOLDER as unknown as T
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => redactPersistedValue(item, depth + 1))
    writeRedactCache(value, depth, out)
    return out as unknown as T
  }
  const proto: object | null = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = PERSIST_FUNCTIONAL_KEYS.has(key) ? item : redactPersistedValue(item, depth + 1)
  }
  writeRedactCache(value, depth, out)
  return out as unknown as T
}
