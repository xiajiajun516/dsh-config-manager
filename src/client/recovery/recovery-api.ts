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
 * GET  /api/dsh-config-manager/recovery/rollback-points              → RollbackListResult
 * GET  /api/dsh-config-manager/recovery/rollback-points/storage      → RollbackStorageStatus
 * GET  /api/dsh-config-manager/recovery/rollback-points/<id>         → RollbackDetailResult
 * GET  /api/dsh-config-manager/recovery/rollback-points/<id>/preview → RollbackPreviewResult
 * POST /api/dsh-config-manager/recovery/rollback-points/<id>/rewind  → RollbackRewindResult
 * POST /api/dsh-config-manager/recovery/rollback-points/<id>/delete  → RollbackRemoveResult
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
import type { SessionLayoutResponse } from '../../ui/session-layout-view.ts'
import type {
  RollbackDetailResult,
  RollbackFileDiffResult,
  RollbackListResult,
  RollbackPointPort,
  RollbackPreviewResult,
  RollbackRemoveResult,
  RollbackRewindOptions,
  RollbackRewindResult,
  RollbackPrefsResult,
  RollbackPurgeResult,
  RollbackStorageStatus,
} from '../../ui/rollback-view.ts';
import { ConfigManagerApiError, getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts';
import type { UiT } from '../../ui/i18n.ts';
import { RECOVERY_API } from '../common/routes.ts';

/** recovery 端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持导入面。 */
export { RECOVERY_API };

/** recovery 请求选项（长操作 5 分钟；超时文案沿用 `error.recoveryTimeout`，分钟插值）。 */
const RECOVERY_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.recoveryTimeout' };

/* 请求封装（readJson / getJson / postJson：统一超时 + 取消 + 错误映射）见 common/http.ts。 */

/** operationId 严格 UUID 校验（与 Host 侧 isValidOperationId 一致；防路径穿越）。 */
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * rollback-point 台账 id → 子路径。
 *
 * 只接受 `[A-Za-z0-9._-]{1,128}`：id 是宿主生成的，这里**只做形态收窄**（与 operationId 的
 * UUID 校验同一条理由 —— 防路径穿越）；不合形态的 id 直接抛，**绝不回显原始 id**、绝不拼进 URL
 * 让宿主去兜。路径由 `RECOVERY_API.rollbackPoints` **派生**（路由常量是唯一来源；源码级守卫
 * `http-usage-guard` 也只允许 `common/routes.ts` 出现 `/api/dsh-config-manager…` 字面量）。
 */
const ROLLBACK_POINT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
function rollbackPointUrl(id: string): string {
  if (!ROLLBACK_POINT_ID_RE.test(id)) throw new Error('rollback point id invalid')
  return RECOVERY_API.rollbackPoints + '/' + id
}

function rollbackPointPath(id: string, sub: string): string {
  return rollbackPointUrl(id) + '/' + sub
}

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

/** Recovery 浏览器半数据入口（实现 RecoveryPort 契约 + rollback-points 族）。 */
export class RecoveryApi implements RecoveryPort, RollbackPointPort {
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

  /* ------------------------------------------------- S7 rollback-points（工作区 + 会话回滚，两态） */

  /**
   * GET /recovery/rollback-points：台账列表（按时间倒序）+ 存储栈状态 + 留存上限。
   *
   * 列表本身**只读**：SAFE MODE 下也能看（宿主侧只有 rewind / delete 被 423 拦下），
   * 因此界面必须能「看得见、但按钮说明为什么点不了」。
   * 存储栈不可用时宿主回 **503 + 同体**（`storage.available=false` + guidance）；`getJson` 对非 2xx
   * 抛 `ConfigManagerApiError`（`status`=503，`code` 取响应体 code），调用方按 status 区分「读不出来」
   * 与「本来就没有」。
   */
  async rollbackPoints(): Promise<RollbackListResult> {
    return getJson<RollbackListResult>(RECOVERY_API.rollbackPoints, this.t, RECOVERY_OPTS)
  }

  /** GET /recovery/rollback-points/storage：存储栈探针（不可用 → 503 + guidance，同上）。 */
  async rollbackPointStorage(): Promise<RollbackStorageStatus> {
    return getJson<RollbackStorageStatus>(RECOVERY_API.rollbackPointsStorage, this.t, RECOVERY_OPTS)
  }

  /** GET /recovery/rollback-points/<id>：单条详情（不存在 → 404 `record-not-found`）。 */
  async rollbackPoint(id: string): Promise<RollbackDetailResult> {
    return getJson<RollbackDetailResult>(rollbackPointUrl(id), this.t, RECOVERY_OPTS)
  }

  /**
   * GET /recovery/rollback-points/<id>/preview：**只读预览（零写入）**。
   *
   * 回传两态将覆盖多少项、其中多少项内容不同、多少项当前已不存在、多少项是该点**未记录**的
   * （`removals` = 会被删除的、`createdSkipped` = 按安全判据拒删的；两者都只是**读回来的清单**，
 * 本方法零写入），以及会话边界（from → to）与回合号；`canRestore` / `canRemove`
   * 是宿主给出的权威判定，界面据此决定按钮可用性（展示判定见 `src/ui/rollback-view.ts`）。
   */
  async rollbackPointPreview(id: string): Promise<RollbackPreviewResult> {
    return getJson<RollbackPreviewResult>(rollbackPointPath(id, 'preview'), this.t, RECOVERY_OPTS)
  }

  /**
   * GET /recovery/rollback-points/<id>/file-diff?path=...：**单个记录在案文件**的前后逐行对照。
   *
   * 只读、零写入；路径以 query 传递（宿主内再收窄一次：未命中该点记录一律 `file-not-recorded`，
   * 一个字节都不读）。非 2xx（存储栈 503 / 参数 400）由 getJson 抛 ConfigManagerApiError，
   * 由调用方按 status + code 出文案。
   */
  async rollbackPointFileDiff(id: string, path: string): Promise<RollbackFileDiffResult> {
    const query = '?path=' + encodeURIComponent(path)
    return getJson<RollbackFileDiffResult>(rollbackPointPath(id, 'file-diff') + query, this.t, RECOVERY_OPTS)
  }

  /**
   * POST /recovery/rollback-points/<id>/rewind：回退（工作区文件覆盖 + 会话 fork 子会话）。
   *
   * **确认门是 fail-closed**：`userConfirmed` 必须**恰好** true（宿主缺省 / 假值一律
   * 409 `confirmation-required` + 零写入）。本方法绝不自动置 true —— 由确认弹窗的 onClick 传进来。
   * 409（confirmation-required / protected-point / record-incomplete）与 423（mutation-locked）
   * 都以 `ConfigManagerApiError` 抛出，`status` / `code` 保留，界面按 code 出文案（不靠状态码猜原因）。
   * 会话回退 **不改写原会话日志**：结果里回传 `childSessionId`（新子会话），原会话只读。
   */
  async restoreRollbackPoint(id: string, opts: RollbackRewindOptions): Promise<RollbackRewindResult> {
    const body: Record<string, unknown> = { userConfirmed: opts.userConfirmed === true }
    if (opts.mode !== undefined) body['mode'] = opts.mode
    if (opts.segments !== undefined && opts.segments.length > 0) body['segments'] = [...opts.segments]
    if (opts.allowPartial === true) body['allowPartial'] = true
    if (opts.preRewindGuard !== undefined) body['preRewindGuard'] = opts.preRewindGuard
    return postJson<RollbackRewindResult>(rollbackPointPath(id, 'rewind'), body, this.t, RECOVERY_OPTS)
  }

  /**
   * POST /recovery/rollback-points/<id>/delete：删除一个回滚点（保护点由宿主拒绝）。
   * body 必须 `userConfirmed: true`（未确认 → 409 `confirmation-required`）；本方法不自动置 true。
   */
  async removeRollbackPoint(id: string, userConfirmed: boolean): Promise<RollbackRemoveResult> {
    return postJson<RollbackRemoveResult>(rollbackPointPath(id, 'delete'), { userConfirmed: userConfirmed === true }, this.t, RECOVERY_OPTS)
  }

  /**
   * GET /recovery/rollback-points/prefs（issue #88）：读开关。
   * `rollbackEnabled` = 磁盘偏好（用户意图，随 self 分区进备份）；
   * `rollbackActive` = 本进程此刻是否真的在留点（关闭后订阅已解绑）。两者正常一致。
   */
  async rollbackPrefs(): Promise<RollbackPrefsResult> {
    return getJson<RollbackPrefsResult>(RECOVERY_API.rollbackPointsPrefs, this.t, RECOVERY_OPTS)
  }

  /**
   * POST /recovery/rollback-points/prefs（issue #88）：写开关。
   * 宿主写盘成功后才切进程 gate —— 写失败却把功能打开，等于「界面说开着、实际不留点」。
   */
  async setRollbackEnabled(enabled: boolean): Promise<RollbackPrefsResult> {
    return postJson<RollbackPrefsResult>(RECOVERY_API.rollbackPointsPrefs, { rollbackEnabled: enabled === true }, this.t, RECOVERY_OPTS)
  }

  /**
   * POST /recovery/rollback-points/cleanup（issue #89）：清理台账占用。
   * **只删自动点**；`includeGuards` 为 true 时连救援点也删（protected 永不删）。
   * 返回逐类删除计数与释放字节，界面照实说「删了多少 / 还剩多少」。
   */
  async purgeRollbackPoints(opts: { includeGuards: boolean }): Promise<RollbackPurgeResult> {
    return postJson<RollbackPurgeResult>(RECOVERY_API.rollbackPointsCleanup, { userConfirmed: true, includeGuards: opts.includeGuards === true }, this.t, RECOVERY_OPTS)
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
