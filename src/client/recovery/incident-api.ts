/**
 * 事故恢复（Incident）浏览器半 —— API.crash / API.rescue 的类型化 fetch 封装。
 *
 * 为什么单列一个 api 类：这两条路由服务「上次启动没起来 / 插件把 DSH 搞挂」的处置，
 * 与 RecoveryPanel 的 journal 恢复同属事故恢复子 tab。灾备快照线（自动快照 / 撤销重做 /
 * 快照库）已按产品定位收敛下线，其 api 类随之删除 —— 本文件是那批能力里唯一保留的浏览器半入口。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 *   GET  /api/dsh-config-manager/crash   → CrashReport
 *   GET  /api/dsh-config-manager/rescue  → RescueStatus
 *   POST /api/dsh-config-manager/rescue  → RescueActionResult（body: {action:on,confirm:true} | {action:off}）
 *
 * 安全约束：错误文本由 Host 侧脱敏；进入救援模式是高风险写盘动作，confirm 必须由调用方在
 * 显式确认弹窗后传入 —— 本层绝不代填。本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import type { UiT } from '../../ui/i18n.ts'
import { getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts'
import { INCIDENT_API } from '../common/routes.ts'

/** 端点常量：唯一来源 = common/routes.ts，此处重导出保持既有导入面。 */
export { INCIDENT_API }

/** 请求选项（与 recovery 一致的长操作超时；文案沿用 error.recoveryTimeout）。 */
const INCIDENT_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.recoveryTimeout' }

/** 崩溃归因分类（与 core/crash-report.ts 的 CrashKind 同构）。 */
export type CrashKind = 'session-corrupt' | 'bundle-check' | 'patch-tree' | 'unknown'

/** 建议动作（与 core/crash-report.ts 的 CrashAdvice 同构）。 */
export type CrashAdvice = 'none' | 'restore-last-good' | 'repair-session' | 'check-bundles' | 'check-patch-tree'

/** GET /crash 响应。 */
export interface CrashReport {
  crashed: boolean
  crashReason: CrashKind | null
  lastGoodAt: string | null
  advice: CrashAdvice
}

/**
 * GET /rescue 响应。stale 为家目录指纹不匹配（换机 / 重建 home）后的自动降级标记；
 * applied = 救援已在当前进程生效（本进程启动于进入救援之后，即用户已经重启过）。
 */
export interface RescueStatus {
  active: boolean
  stale: boolean
  enteredAt: string | null
  applied: boolean
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

/** 事故恢复（崩溃归因 + 救援模式）浏览器半数据入口。 */
export class IncidentApi {
  readonly t: UiT
  constructor(t: UiT) {
    this.t = t
  }

  /** GET /crash：上次启动是否异常 + 归因 + 建议动作 + 最后正常时刻。 */
  async crash(): Promise<CrashReport> {
    return getJson<CrashReport>(INCIDENT_API.crash, this.t, INCIDENT_OPTS)
  }

  /** GET /rescue：救援模式状态。 */
  async rescueStatus(): Promise<RescueStatus> {
    return getJson<RescueStatus>(INCIDENT_API.rescue, this.t, INCIDENT_OPTS)
  }

  /**
   * POST /rescue {action:on, confirm:true}：进入救援模式。
   * confirm 必须由调用方在显式确认弹窗后传入 —— 本层绝不代填。
   */
  async rescueOn(): Promise<RescueActionResult> {
    return postJson<RescueActionResult>(INCIDENT_API.rescue, { action: 'on', confirm: true }, this.t, INCIDENT_OPTS)
  }

  /** POST /rescue {action:off}：退出救援模式（从备份完整还原）。 */
  async rescueOff(): Promise<RescueActionResult> {
    return postJson<RescueActionResult>(INCIDENT_API.rescue, { action: 'off' }, this.t, INCIDENT_OPTS)
  }
}
