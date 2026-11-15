/**
 * 推送目标选择与「冲突扣下」语义（issue #146）的单一实现。
 *
 * 为什么单独成模块：SyncEngine 已到体量棘轮上限，而这套语义是**纯决策** ——
 * 「这轮推哪些分区 / 哪些被扣下 / 待裁决留哪些」与 IO 无关，放这里能被单测直接钉住。
 *
 * 事故背景（真机）：冲突分区在合并阶段被有意跳过（绝不把冲突内容写进本地），
 * 但推送侧原本没有任何过滤，于是「本机版本」照样被导出并覆盖远端 —— plugins 被 30 → 28 → 26 一路压小。
 *
 * 三条不变量：
 *  1. 过滤只在一处发生（`resolvePushTargets`），push 与 previewPush 共用 ⇒ 预览必等于实际；
 *  2. `force: true` 不扣任何分区（强推 = 用户明确要「用本机覆盖远端」）；
 *  3. 全被扣下 ⇒ 一个分区都不上行，基线与待裁决都不动（引擎返回 `skipped:'all-conflicted'`）。
 */
import type { ConfigAdapter } from '../core/types.ts'
import type { SectionId } from '../schema/types.ts'
import type { PendingMerge } from './sync-state.ts'

/** 本轮推送目标：真正上行的分区 + 被扣下的分区（两者互斥、合起来 = 全部候选）。 */
export interface PushTargets {
  targets: ConfigAdapter[]
  held: SectionId[]
}

/**
 * 本轮要扣下的分区集合 = 调用方点名的分区 ∪ 磁盘上**仍在等裁决**的分区（`force` 时不扣：强推就是明确覆盖远端）。
 * 触发条件是「调用方传了 `skipSections`」而不是「传了非空数组」：自动同步本轮没判出新冲突时也必须
 * 传空数组 —— 磁盘上上一轮留下的待裁决照样要扣下（否则任何一轮别的分区有改动就把它推上去，#146 复发）。
 * 不传（`undefined`）= 手动推送：照旧不受历史待裁决影响。
 * 读不到状态 ⇒ 只扣点名的分区（不猜），但绝不因此放行点名要扣的那些。
 */
export async function resolveSkipSections(
  opts: { force?: boolean; skipSections?: readonly SectionId[] },
  load?: () => Promise<{ pendingMerge?: PendingMerge }>,
): Promise<ReadonlySet<SectionId>> {
  if (opts.force === true || opts.skipSections === undefined) return new Set<SectionId>()
  const held = new Set<SectionId>(opts.skipSections)
  if (load !== undefined) {
    try {
      for (const id of (await load()).pendingMerge?.sections ?? []) held.add(id)
    } catch {
      // 读不到就只扣点名分区
    }
  }
  return held
}

/**
 * 计算本轮推送目标并扣掉 `skip` 里的分区（**唯一过滤点**）。
 * 未指定 sections = portable 全量 + 本次放行的可选分区；未知 id 交给 `onSkipNonPortable` 告警。
 */
export function resolvePushTargets(
  portable: readonly ConfigAdapter[],
  optIn: readonly ConfigAdapter[],
  sections: readonly SectionId[] | undefined,
  skip: ReadonlySet<SectionId> | undefined,
  onSkipNonPortable: (id: SectionId) => void,
): PushTargets {
  const all: ConfigAdapter[] = []
  if (sections === undefined || sections.length === 0) {
    all.push(...portable, ...optIn)
  } else {
    const byId = new Map(portable.map((a) => [a.id, a] as const))
    for (const a of optIn) byId.set(a.id, a)
    for (const id of sections) {
      const adapter = byId.get(id)
      if (adapter === undefined) onSkipNonPortable(id)
      else all.push(adapter)
    }
  }
  if (skip === undefined || skip.size === 0) return { targets: all, held: [] }
  return {
    targets: all.filter((a) => !skip.has(a.id)),
    held: all.filter((a) => skip.has(a.id)).map((a) => a.id),
  }
}

/**
 * 推送成功后的待裁决：只剔除**真正推上去**的分区（其余 sections 与 since 原样保留）。
 * 按 `pushed` 剔除而不是按「被扣下的分区」剔除：本轮不在候选里的分区（如未放行的可选分区）
 * 根本没推上去，它的待裁决必须留下，否则等于静默丢记录。
 * 一条都不剩 → `null`（这次推送已把本机版本推成远端最新，待裁决随之消解）；
 * 读不到状态 → `undefined`（recordBaseline 只在 `null` 时删字段 ⇒ 读失败保留原记录）。
 */
export async function pendingMergeAfterPush(
  load: () => Promise<{ pendingMerge?: PendingMerge }>,
  pushed: readonly SectionId[],
): Promise<PendingMerge | null | undefined> {
  try {
    const prev = (await load()).pendingMerge
    if (prev === undefined) return null
    const kept = prev.sections.filter((s) => !pushed.includes(s))
    return kept.length === 0 ? null : { ...prev, sections: kept }
  } catch {
    return undefined
  }
}
