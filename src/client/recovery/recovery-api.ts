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
  RecoveryPort, RecoveryPreview, RecoveryStatus, RecoveryVerifyResult,
} from '../../ui/types.ts';
import { ConfigManagerApiError } from '../api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/** recovery 端点常量（与 Host 半 src/index.ts API.recovery 前缀保持一致）。 */
export const RECOVERY_API = {
  base: '/api/dsh-config-manager/recovery',
  status: '/api/dsh-config-manager/recovery/status',
} as const;

/** recovery 请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐（restore/rollback 可能较慢）。 */
const RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError（与 api.ts 同款）。 */
async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }));
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.status === 404
          ? notMountedMessage
          : `HTTP ${response.status}`;
    throw new ConfigManagerApiError(message);
  }
  return body as T;
}

/** POST JSON 请求（带超时：宿主卡死时 UI 拿到明确错误而不是永远转圈）。 */
async function postJson<T>(path: string, body: unknown, t: UiT): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECOVERY_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await readJson<T>(response, t);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ConfigManagerApiError(
        t('error.recoveryTimeout', { minutes: String(Math.round(RECOVERY_TIMEOUT_MS / 60000)) }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
    const response = await fetch(RECOVERY_API.status);
    return readJson<RecoveryStatus>(response, this.t);
  }

  /** GET /recovery/:operationId/preview：只读恢复预览（restore plan + verification plan）。 */
  async preview(operationId: string): Promise<RecoveryPreview> {
    const response = await fetch(operationPath(operationId, 'preview'));
    return readJson<RecoveryPreview>(response, this.t);
  }

  /** POST /recovery/:operationId/confirm：确认恢复（journal 保持 NEEDS_ATTENTION）。 */
  async confirm(operationId: string, userConfirmed: boolean): Promise<RecoveryConfirmResult> {
    return postJson<RecoveryConfirmResult>(operationPath(operationId, 'confirm'), { userConfirmed }, this.t);
  }

  /** POST /recovery/:operationId/execute：执行恢复/回滚（NEEDS_ATTENTION → RECOVERING）。 */
  async execute(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult> {
    return postJson<RecoveryExecuteResult>(operationPath(operationId, 'execute'), { userConfirmed }, this.t);
  }

  /** POST /recovery/:operationId/verify：post-recovery verification（原子写 verification + terminal）。 */
  async verify(operationId: string): Promise<RecoveryVerifyResult> {
    return postJson<RecoveryVerifyResult>(operationPath(operationId, 'verify'), {}, this.t);
  }

  /** POST /recovery/:operationId/retry：验证失败后重跑 execute + verify。 */
  async retry(operationId: string, userConfirmed: boolean): Promise<RecoveryExecuteResult> {
    return postJson<RecoveryExecuteResult>(operationPath(operationId, 'retry'), { userConfirmed }, this.t);
  }

  /** POST /recovery/:operationId/dismiss：放弃恢复（quarantine，不销毁证据）。 */
  async dismiss(operationId: string, userConfirmed: boolean): Promise<RecoveryDismissResult> {
    return postJson<RecoveryDismissResult>(operationPath(operationId, 'dismiss'), { userConfirmed }, this.t);
  }
}
