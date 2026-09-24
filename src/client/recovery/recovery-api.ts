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
  RecoveryLockRecoverResult, RecoveryPort, RecoveryPreview, RecoveryStatus, RecoveryVerifyResult,
} from '../../ui/types.ts';
import { ConfigManagerApiError, getJson, LONG_REQUEST_TIMEOUT_MS, postJson, type RequestOptions } from '../common/http.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';
import { RECOVERY_API } from '../common/routes.ts';

/** recovery 端点常量：**唯一来源** = `common/routes.ts`（W4 单点化），此处重导出保持导入面。 */
export { RECOVERY_API };

/** recovery 请求选项（长操作 5 分钟；超时文案沿用 `error.recoveryTimeout`，分钟插值）。 */
const RECOVERY_OPTS: RequestOptions = { timeoutMs: LONG_REQUEST_TIMEOUT_MS, timeoutKey: 'error.recoveryTimeout' };

/* 请求封装（readJson / getJson / postJson：统一超时 + 取消 + 错误映射）见 common/http.ts。 */

/** operationId 严格 UUID 校验（与 Host 侧 isValidOperationId 一致；防路径穿越）。 */
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function operationPath(operationId: string, action: string): string {
  if (!OPERATION_ID_RE.test(operationId)) {
    throw new ConfigManagerApiError('invalid operationId');
  }
  return `${RECOVERY_API.base}/${operationId}/${action}`;
}

/** Recovery 浏览器半数据入口（实现 RecoveryPort 契约）。 */
export class RecoveryApi implements RecoveryPort {
  readonly t: UiT
  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  /** GET /recovery/status：列出未解决 operation + reconcile decision。 */
  async status(): Promise<RecoveryStatus> {
    return getJson<RecoveryStatus>(RECOVERY_API.status, this.t, RECOVERY_OPTS);
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
}
