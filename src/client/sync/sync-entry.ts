/**
 * 方案 A 的「一键同步」入口编排（宿主调用 + 结果归类）。
 *
 * 分工：**决策**是纯函数（merge-view.ts 的 `decideSyncEntry()`，判据在那里冻结）；
 * 本文件只负责「按需发**一次** /sync/merge-preview + 把结果归成三类」，让 SyncPanel 保持装配层。
 * 单独成文件的第二个理由：fail-safe 回退（无基准 / 请求失败 / ok=false 一律回老导入确认路径）
 * 是最需要单测的地方，而组件层在本仓库没有测试框架（见 AGENTS.md）。
 */
import { decideSyncEntry, hasMergeBaseline } from './merge-view.ts'
import type { MergePreviewResponse, SyncApi, SyncPushPayload } from './sync-api.ts'

export interface SmartSyncDeps {
  api: SyncApi
  /** /sync/status 的 hasBaseline；unknown = 缺省/旧宿主（一律按无基准走老路径） */
  hasBaseline: unknown
  /** 通道请求体（含 transport / 地址 / 凭据引用；与 push/pull 同源） */
  channelPayload: () => SyncPushPayload
  /** 解密密码（可选，仅内存） */
  decryptPassword?: string
}

/**
 * 分派结果：
 *  - 'fallback'：走老路径（`runSync()` 导入确认）。可能带 error（预览请求失败或宿主 ok=false）；
 *  - 'merge'   ：打开裁决视图，**复用本次 preview**（调用方不得再请求一次）；
 *  - 'upToDate'：全部 skip / 无分区 → 提示「已是最新」，零写入。
 */
export type SmartSyncOutcome =
  | { kind: 'merge'; preview: MergePreviewResponse }
  | { kind: 'upToDate' }
  | { kind: 'fallback'; error?: string }

/**
 * 解析本次一键同步该走哪条路。**无基准时不发任何请求**（行为与方案 A 之前逐字一致）。
 * 预览请求失败绝不抛：转成 'fallback' + error 文本，由调用方 toast 后继续走老路径。
 */
export async function resolveSmartSync(deps: SmartSyncDeps): Promise<SmartSyncOutcome> {
  // 判据与 decideSyncEntry 的第一条**同源**（hasMergeBaseline）；这里提前返回只是为了不发请求
  if (!hasMergeBaseline(deps.hasBaseline)) return { kind: 'fallback' }
  const password = deps.decryptPassword !== undefined && deps.decryptPassword !== ''
    ? { decryptPassword: deps.decryptPassword }
    : {}
  try {
    const preview = await deps.api.mergePreview({ ...deps.channelPayload(), ...password })
    const decision = decideSyncEntry(deps.hasBaseline, preview)
    if (decision === 'merge') return { kind: 'merge', preview }
    if (decision === 'upToDate') return { kind: 'upToDate' }
    // ok === false：宿主明确说预览没产出（例如远端没有快照）→ 老路径 + 如实带出原因
    return { kind: 'fallback', ...(preview.message !== undefined ? { error: preview.message } : {}) }
  } catch (err) {
    return { kind: 'fallback', error: err instanceof Error ? err.message : String(err) }
  }
}
