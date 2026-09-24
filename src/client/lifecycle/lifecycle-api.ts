/**
 * 灾备（Phase 1）浏览器半数据入口：/api/dsh-config-manager/{lifecycle,crash,rescue} 的类型化 fetch 封装。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/lifecycle/status  → LifecycleStatus（含快照列表）
 * POST /api/dsh-config-manager/lifecycle/snapshot → { ok, id, kind, totalBytes }
 * POST /api/dsh-config-manager/lifecycle/undo    → LifecycleOutcome
 * POST /api/dsh-config-manager/lifecycle/redo    → LifecycleOutcome
 * POST /api/dsh-config-manager/lifecycle/remove  → { ok, removed }
 * GET  /api/dsh-config-manager/crash             → CrashReport
 * GET  /api/dsh-config-manager/rescue            → RescueStatus
 * POST /api/dsh-config-manager/rescue            → RescueActionResult（body: {action:'on',confirm:true} | {action:'off'}）
 * ```
 *
 * 安全约束：本文件不 import 任何 node 模块（纯浏览器 bundle）；错误文本由 Host 侧
 * 已脱敏，UI 侧再经 ErrorBanner 兜底。`undo` / `redo` / `rescue` 属高风险动作，
 * 请求体绝不自动置 confirm —— 由调用方经显式确认弹窗后传入。
 */
import { zhUiT, type UiT } from '../../ui/i18n.ts'
import { getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts'
import { LIFECYCLE_API } from '../common/routes.ts'

/** 端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持既有导入面。 */
export { LIFECYCLE_API }

/**
 * 请求选项：撤销/重做要回放全部分区（含插件安装），比普通查询慢得多；
 * 与 recovery 的 5 分钟对齐；超时文案沿用 `error.lifecycleTimeout`（分钟插值）。
 */
const LIFECYCLE_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.lifecycleTimeout' }

/** 配置快照种类（与 core/undo.ts 的 ConfigSnapshotKind 同构）。 */
export type LifecycleSnapshotKind = 'manual' | 'auto' | 'undo' | 'pre-restore' | 'baseline'

/** 单个配置状态快照的元信息（列表展示用；不含分区数据）。 */
export interface LifecycleSnapshotMeta {
  id: string
  createdAt: string
  kind: LifecycleSnapshotKind
  reason: string
  trigger: string | null
  sections: string[]
  totalBytes: number
  note: string | null
  tags: string[]
  pinned: boolean
}

/** GET /lifecycle/status 响应。 */
export interface LifecycleStatus {
  canUndo: boolean
  canRedo: boolean
  total: number
  lastAutoAt: string | null
  watching: boolean
  snapshots: LifecycleSnapshotMeta[]
}

/** 撤销/重做的结果。失败时 `reason` 是稳定的枚举码（如 'already-at-state'），供 UI 分流文案。 */
export interface LifecycleOutcome {
  ok: boolean
  targetId: string | null
  reason: string | null
  report: {
    applied?: string[]
    skipped?: string[]
    failed?: { item: string; reason: string }[]
    invalidSections?: { section: string; reason: string }[]
    needsRestart?: boolean
  } | null
}

/** 崩溃归因分类（与 core/crash-report.ts 的 CrashKind 同构）。 */
export type CrashKind = 'session-corrupt' | 'bundle-check' | 'patch-tree' | 'unknown'

/** 建议动作（与 core/crash-report.ts 的 CrashAdvice 同构）。 */
export type CrashAdvice =
  | 'none' | 'restore-last-good' | 'repair-session' | 'check-bundles' | 'check-patch-tree'

/** GET /crash 响应。 */
export interface CrashReport {
  crashed: boolean
  crashReason: CrashKind | null
  lastGoodAt: string | null
  advice: CrashAdvice
  lastGoodSnapshotId: string | null
}

/** GET /rescue 响应。`stale` 为家目录指纹不匹配（换机/重建 home）后的自动降级标记。 */
export interface RescueStatus {
  active: boolean
  stale: boolean
  enteredAt: string | null
}

/** POST /rescue 响应。 */
export interface RescueActionResult {
  ok: boolean
  active: boolean
  enteredAt?: string
  restored?: string[]
  needsRestart?: boolean
  code?: string
  message?: string
}

/* 请求封装（readJson / getJson / postJson：统一超时 + 取消 + 错误映射）见 common/http.ts。 */

/** 新建快照的请求参数（全部可选）。 */
export interface SnapshotRequest {
  reason?: string
  note?: string
  tags?: string[]
}

/** 灾备浏览器半数据入口。 */
export class LifecycleApi {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** GET /lifecycle/status：撤销/重做可用性 + 快照列表 + 自动快照状态。 */
  async status(): Promise<LifecycleStatus> {
    return getJson<LifecycleStatus>(LIFECYCLE_API.status, this.t, LIFECYCLE_OPTS)
  }

  /** POST /lifecycle/snapshot：立即保存一份手动快照。 */
  async snapshot(req: SnapshotRequest = {}): Promise<{ ok: boolean; id: string; kind: string; totalBytes: number }> {
    const body: Record<string, unknown> = {}
    if (req.reason !== undefined && req.reason !== '') body['reason'] = req.reason
    if (req.note !== undefined) body['note'] = req.note
    if (req.tags !== undefined) body['tags'] = req.tags
    return postJson(LIFECYCLE_API.snapshot, body, this.t, LIFECYCLE_OPTS)
  }

  /**
   * POST /lifecycle/undo：回退到内容不同的最近快照。
   * 引擎会在撤销前自动落一份「撤销前存档」，因此该动作可重做。
   */
  async undo(): Promise<LifecycleOutcome> {
    return postJson<LifecycleOutcome>(LIFECYCLE_API.undo, {}, this.t, LIFECYCLE_OPTS)
  }

  /** POST /lifecycle/redo：重做上一次撤销（仅当撤销后没有新变更时可成功）。 */
  async redo(): Promise<LifecycleOutcome> {
    return postJson<LifecycleOutcome>(LIFECYCLE_API.redo, {}, this.t, LIFECYCLE_OPTS)
  }

  /** POST /lifecycle/remove：删除单个配置状态快照。 */
  async remove(id: string): Promise<{ ok: boolean; removed: boolean }> {
    return postJson(LIFECYCLE_API.remove, { id }, this.t, LIFECYCLE_OPTS)
  }

  /** GET /crash：上次启动是否异常 + 归因 + 建议动作 + 最后正常快照 id。 */
  async crash(): Promise<CrashReport> {
    return getJson<CrashReport>(LIFECYCLE_API.crash, this.t, LIFECYCLE_OPTS)
  }

  /** GET /rescue：救援模式状态。 */
  async rescueStatus(): Promise<RescueStatus> {
    return getJson<RescueStatus>(LIFECYCLE_API.rescue, this.t, LIFECYCLE_OPTS)
  }

  /**
   * POST /rescue {action:'on', confirm:true}：进入救援模式。
   * confirm 必须由调用方在显式确认弹窗后传入 —— 本层绝不代填。
   */
  async rescueOn(): Promise<RescueActionResult> {
    return postJson<RescueActionResult>(LIFECYCLE_API.rescue, { action: 'on', confirm: true }, this.t, LIFECYCLE_OPTS)
  }

  /** POST /rescue {action:'off'}：退出救援模式（从备份还原）。 */
  async rescueOff(): Promise<RescueActionResult> {
    return postJson<RescueActionResult>(LIFECYCLE_API.rescue, { action: 'off' }, this.t, LIFECYCLE_OPTS)
  }
}
