/**
 * Recovery 浏览器半 —— `/api/dsh-config-manager/recovery/*` 的类型化 fetch 封装。
 *
 * 实现 `src/ui/types.ts` 的 `RecoveryPort` 契约（§10.3）：recovery 无现有 port，
 * 本文件是唯一实现；`recovery-view.ts` 纯渲染模型消费本端口返回的渲染数据。
 *
 * 端点契约（Host 半 src/index.ts 的 makeRoutes 按此实现）：
 * ```
 * GET  /api/dsh-config-manager/recovery/status            → RecoveryStatus
 * GET  /api/dsh-config-manager/recovery/:operationId/preview → RecoveryPreview
 * POST /api/dsh-config-manager/recovery/:operationId/confirm → RecoveryConfirmResult
 * POST /api/dsh-config-manager/recovery/:operationId/execute → RecoveryExecuteResult
 * POST /api/dsh-config-manager/recovery/:operationId/verify  → RecoveryVerifyResult
 * POST /api/dsh-config-manager/recovery/:operationId/retry   → RecoveryExecuteResult
 * POST /api/dsh-config-manager/recovery/:operationId/dismiss → RecoveryDismissResult
 * POST /api/dsh-config-manager/recovery/lock/recover            → RecoveryLockRecoverResult
 * POST /api/dsh-config-manager/recovery/safe-mode/clear         → RecoverySafeModeClearResult
 * POST /api/dsh-config-manager/recovery/sessions/layout         → SessionLayoutPlanView | SessionLayoutApplyView
 * ```
 *
 * 安全约束（§9.4 / §11）：
 *  - 所有 destructive 动作（confirm/execute/retry/dismiss）请求体携带 `userConfirmed: true`，
 *    Host 侧双重校验（请求体 + journal 状态机）；本文件绝不自动置 true；
 *  - 权威 snapshotId 只来自 journal（Host 侧），本文件不传任何 snapshotId 覆盖；
 *  - 错误文本由 Host 侧已脱敏，UI 侧再经 ErrorBanner redact 兜底；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */
import type {
  RecoveryConfirmResult, RecoveryDismissResult, RecoveryExecuteResult,
  RecoveryLockRecoverResult, RecoveryPort, RecoveryPreview, RecoverySafeModeClearResult,
  RecoveryStatus, RecoveryVerifyResult,
} from '../../ui/types.ts';
import type {
  SessionHealthResponse,
  SessionRepairResult,
  SessionRepairRollbackResult,
} from '../../ui/session-inventory-view.ts';
import type { SessionLayoutResponse } from '../../ui/session-layout-view.ts';
import { ConfigManagerApiError, getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts';
import type { UiT } from '../../ui/i18n.ts';
import { RECOVERY_API } from '../common/routes.ts';

/** recovery 端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持导入面。 */
export { RECOVERY_API };

/** recovery 请求选项（长操作 5 分钟；超时文案沿用 `error.recoveryTimeout`，分钟插值）。 */
const RECOVERY_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.recoveryTimeout' };

/* 请求封装（readJson / getJson / postJson：统一超时 + 取消 + 错误映射）见 common/http.ts。 */

/** operationId 严格 UUID 校验（与 Host 侧 isValidOperationId 一致；防路径穿越）。 */
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * E2：`POST /recovery/sessions/layout`（布局归位 / 重复 id 隔离）。
 *
 * 路径由 `RECOVERY_API.sessions` **派生**（路由常量是唯一来源，避免第二处字面量；`common/routes.ts`
 * 不在本次改动范围内）。它与 `/sessions`（GET 只读体检）、`/sessions/repair`（字节级修复）同族，
 * 都由 recovery prefix 路由内部按 path 分发，不新增围栏面。
 */
const SESSIONS_LAYOUT_PATH = RECOVERY_API.sessions + '/layout'

function operationPath(operationId: string, action: string): string {
  if (!OPERATION_ID_RE.test(operationId)) {
    throw new ConfigManagerApiError('invalid operationId');
  }
  return `${RECOVERY_API.base}/${operationId}/${action}`;
}

/** Recovery 浏览器半数据入口（实现 RecoveryPort 契约）。 */
export class RecoveryApi implements RecoveryPort {
  readonly t: UiT
  constructor(t: UiT) {
    this.t = t
  }

  /** GET /recovery/status：列出未解决 operation + reconcile decision。 */
  async status(): Promise<RecoveryStatus> {
    return getJson<RecoveryStatus>(RECOVERY_API.status, this.t, RECOVERY_OPTS);
  }

  /**
   * GET /recovery/sessions：**只读**会话体检（本机存量会话的损坏/可见性分类）。
   *
   * 为什么走 recovery 族：它与「我的对话去哪了」是同一件事，且本族已是 prefix 路由 ——
   * 加一条子路径不新增围栏面（见 tests/route/route-parity.test.ts 的说明）。
   * `limit` 只影响返回给浏览器的行数（宿主仍会扫全量，摘要里的 total 因此是全量口径）。
   */
  async sessions(limit?: number): Promise<SessionHealthResponse> {
    const query = limit !== undefined && Number.isFinite(limit) && limit > 0 ? '?limit=' + String(limit) : '';
    return getJson<SessionHealthResponse>(RECOVERY_API.sessions + query, this.t, RECOVERY_OPTS);
  }

  /**
   * POST /recovery/sessions/repair（T8）：应用内修复一份会话日志。
   *
   * apply=false = 只读预览（宿主会回传 expect 指纹与动作清单）；apply=true 必须带上该指纹 ——
   * 宿主据此拒绝「预览之后文件已被改过」的写入（TOCTOU）。任何拒绝都以 ok:false + reason 表达，
   * 不是 HTTP 错误，界面必须按 reason 显式说明原因。
   */
  async repairSession(unitId: string, apply: boolean, expect?: { size: number; mtimeMs: number }, allowLossy?: boolean): Promise<SessionRepairResult> {
    const body: Record<string, unknown> = { unitId, apply }
    if (expect !== undefined) body['expect'] = expect
    // 有损动作（截断）必须显式放行；宿主也会再判一次（缺省拒绝）
    if (allowLossy === true) body['allowLossy'] = true
    return postJson<SessionRepairResult>(RECOVERY_API.sessionsRepair, body, this.t, RECOVERY_OPTS)
  }

  /** POST /recovery/sessions/rollback（T8）：按台账 repairId 回滚（客户端不传路径）。 */
  async rollbackSessionRepair(repairId: string): Promise<SessionRepairRollbackResult> {
    return postJson<SessionRepairRollbackResult>(RECOVERY_API.sessionsRollback, { repairId }, this.t, RECOVERY_OPTS)
  }

  /**
   * POST /recovery/sessions/layout（E2）：**布局归位 / 重复 id 隔离**（写入口）。
   *
   * apply=false = **只读计划**（宿主不拿锁、不过门、零写入；响应带 needsKeep，界面据此要求用户
   * 选定保留哪一份）；apply=true = 应用（过 SAFE MODE + mutation lock；keep 必须覆盖全部 needsKeep，
   * 否则该 id 被显式拒绝而不是静默跳过）。
   *
   * 安全口径（**必须与界面文案一致**）：本入口在 **DSH 运行时**执行，与离线 CLI
   * `dcm sessions repair --fix` 的「须先停 DSH」不同 —— 靠宿主侧逐目标门前置 + 每次移动后
   * **索引刷新必须成功** + 失败逐条回滚兜底。任何拒绝都以 `ok:false + reason`（或逐条 reason 码）
   * 表达，**不是** HTTP 错误，界面必须逐条如实说明。
   */
  async layoutRepairSessions(apply: boolean, keep?: Record<string, string>): Promise<SessionLayoutResponse> {
    const body: Record<string, unknown> = { apply }
    // 空 keep 与「不带 keep」等价（宿主缺省 = 重复 id 一律拒绝执行并说明）
    if (keep !== undefined && Object.keys(keep).length > 0) body['keep'] = keep
    return postJson<SessionLayoutResponse>(SESSIONS_LAYOUT_PATH, body, this.t, RECOVERY_OPTS)
  }

  /** GET /recovery/:operationId/preview：只读恢复预览（restore plan + verification plan）。 */
  async preview(operationId: string): Promise<RecoveryPreview> {
    return getJson<RecoveryPreview>(operationPath(operationId, 'preview'), this.t, RECOVERY_OPTS);
  }

  /** POST /recovery/:operationId/confirm：确认恢复（journal 保持 NEEDS_ATTENTION）。 */
  async confirm(operationId: string, userConfirmed: boolean): Promise<RecoveryConfirmResult> {
    return postJson<RecoveryConfirmResult>(operationPath(operationId, 'confirm'), { userConfirmed }, this.t, RECOVERY_OPTS);
  }

  /** POST /recovery/:operationId/execute：执行恢复/回滚（NEEDS_ATTENTION → RECOVERING）。 */
  async execute(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult> {
    return postJson<RecoveryExecuteResult>(operationPath(operationId, 'execute'), { userConfirmed }, this.t, RECOVERY_OPTS);
  }

  /** POST /recovery/:operationId/verify：post-recovery verification（原子写 verification + terminal）。 */
  async verify(operationId: string): Promise<RecoveryVerifyResult> {
    return postJson<RecoveryVerifyResult>(operationPath(operationId, 'verify'), {}, this.t, RECOVERY_OPTS);
  }

  /** POST /recovery/:operationId/retry：验证失败后重跑 execute + verify。 */
  async retry(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult> {
    return postJson<RecoveryExecuteResult>(operationPath(operationId, 'retry'), { userConfirmed }, this.t, RECOVERY_OPTS);
  }

  /** POST /recovery/:operationId/dismiss：放弃恢复（quarantine，不销毁证据）。 */
  async dismiss(operationId: string, userConfirmed: boolean): Promise<RecoveryDismissResult> {
    return postJson<RecoveryDismissResult>(operationPath(operationId, 'dismiss'), { userConfirmed }, this.t, RECOVERY_OPTS);
  }

  /**
   * POST /recovery/lock/recover（issue #31）：显式回收 stale 残留配置锁。
   * 无 operationId（残留锁没有 journal）；userConfirmed 与其它危险动作同规，
   * 调用方必须先经过显式确认弹窗。
   */
  async recoverStaleLock(userConfirmed: boolean): Promise<RecoveryLockRecoverResult> {
    return postJson<RecoveryLockRecoverResult>(RECOVERY_API.lockRecover, { userConfirmed }, this.t, RECOVERY_OPTS);
  }

  /**
   * POST /recovery/safe-mode/clear（issue #56）：显式解除仍然生效的 SAFE MODE。
   * 无 operationId（该状态下 active/ 通常已空，没有可操作对象）；userConfirmed 与其它
   * 危险动作同规，调用方必须先经过显式确认弹窗。宿主侧仍有未解决 incident 时拒绝
   * （ok=false + reason='unresolved-incidents'），界面据此如实提示而不是假装成功。
   */
  async clearSafeMode(userConfirmed: boolean): Promise<RecoverySafeModeClearResult> {
    return postJson<RecoverySafeModeClearResult>(RECOVERY_API.safeModeClear, { userConfirmed }, this.t, RECOVERY_OPTS);
  }
}
