import type { ConfigAdapter, ExportSection, ExportUnit, HostContext } from './types.ts'

/**
 * 预览富化（G5）：给单元补展示名与跨分区归属（附件挂在「用它的那条会话」下面）。
 *
 * 从 `src/index.ts` 的 `/export-preview` 下沉 —— 那里是体量棘轮盯着的入口文件，而这段
 * 逻辑与路由无关，只是「调用适配器钩子 + 兜住失败」。
 *
 * 失败方向只有一条：**退回原样**。适配器返回 `null`（算不出归属）与抛错都不得让预览失败
 * —— 归属是展示层的补充，缺了它顶多是扁平列表，丢了整个预览就成了功能回退。
 */
export async function enrichExportUnits<TSection>(
  ctx: HostContext,
  adapter: ConfigAdapter<TSection>,
  units: readonly ExportUnit[],
): Promise<ExportUnit[]> {
  const flat = [...units]
  if (flat.length === 0 || adapter.enrichUnits === undefined) return flat
  try {
    const enriched = await adapter.enrichUnits(ctx, units)
    return enriched === null ? flat : [...enriched]
  } catch {
    return flat
  }
}

/**
 * 预览顺带取到的单元活跃时间（会话日志 mtime）——元数据缓存没覆盖的会话靠它排序。
 *
 * 为什么把它从预览端点里搬出来：本趟预览已经 stat 过一遍（`statInfo` 同时给体积与 mtime），
 * 把 `statTimes` 顺下去就省掉第二趟逐文件 stat；这条「顺带」关系写在路由里太容易被误删。
 * 适配器没有该钩子或抛错一律 `undefined`（排序退回缓存口径，绝不让预览失败）。
 */
export async function previewActivityTimes<TSection>(
  ctx: HostContext,
  adapter: ConfigAdapter<TSection>,
  section: ExportSection<TSection>,
  statTimes: ReadonlyMap<string, number> | undefined,
): Promise<Map<string, number> | undefined> {
  if (adapter.unitActivityTimes === undefined) return undefined
  try {
    return await adapter.unitActivityTimes(ctx, section, statTimes)
  } catch {
    return undefined
  }
}
