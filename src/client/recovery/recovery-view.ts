/**
 * Recovery 纯渲染模型（§10.3）：框架无关，node 可测。
 *
 * 职责：把 `RecoveryPort` 返回的渲染数据（incidents / preview / verify result）映射为
 * UI 展示所需的纯数据（状态分类 / 徽章语义 / 可执行动作 / 文案键）。**非控制器**——
 * 不持有状态、不发起请求；RecoveryPanel 只做装配（渲染 + 交互状态），把本模块的
 * 纯函数输出绑定到 React 组件。
 *
 * UI 状态分类（Step 6 要求，明确区分）：
 *  - NORMAL                无 incident
 *  - RECOVERY_REQUIRED     有 incident（SAFE MODE，destructive 被阻断）
 *  - ROLLBACK_RECOMMENDED  decision=rollback-recommended（可恢复到 trusted snapshot）
 *  - RECOVERING            journal state=RECOVERING（恢复进行中）
 *  - VERIFYING             verify 请求进行中
 *  - MATCH / PARTIAL_MATCH 验证通过（terminal）
 *  - MISMATCH / VERIFICATION_ERROR 验证失败（NEEDS_ATTENTION）
 *  - NEEDS_ATTENTION       decision=needs-attention（需人工处理）
 *
 * 安全（UI HARD RULES）：本模块绝不把 PARTIAL_MATCH 显示为完全成功、绝不把
 * NEEDS_ATTENTION 显示为 recovered、绝不在 snapshot 不可信时显示可恢复。
 */
import type {
  RecoveryDecision, RecoveryIncident, RecoveryPreview, RecoveryStatus, RecoveryVerdict,
} from '../../ui/types.ts';

/** UI 顶层状态分类。 */
export type RecoveryUiState =
  | 'NORMAL'
  | 'RECOVERY_REQUIRED'
  | 'ROLLBACK_RECOMMENDED'
  | 'ROLLBACK_CONTINUE'
  | 'RECOVERING'
  | 'VERIFYING'
  | 'MATCH'
  | 'PARTIAL_MATCH'
  | 'MISMATCH'
  | 'VERIFICATION_ERROR'
  | 'NEEDS_ATTENTION';

/** 单个 incident 的渲染模型。 */
export interface RecoveryIncidentView {
  operationId: string;
  operationType: string;
  state: string;
  decision: RecoveryDecision;
  snapshotId: string | null;
  reason: string;
  createdAt: string;
  /** 是否可执行恢复（decision 非 needs-attention 且 snapshot 可信）。 */
  actionable: boolean;
  /** 是否需续跑（rollback-continue）。 */
  isContinue: boolean;
}

/** 恢复面板渲染模型（RecoveryPanel 直接绑定）。 */
export interface RecoveryView {
  /** 顶层状态分类。 */
  state: RecoveryUiState;
  /** 是否有未解决 incident（SAFE MODE）。 */
  recoveryRequired: boolean;
  incidents: RecoveryIncidentView[];
  /** 进行中的 recovery run（runId + status）。 */
  running: { runId: string; status: string }[];
}

/** 把 GET /recovery/status 映射为渲染模型。 */
export function toRecoveryView(status: RecoveryStatus): RecoveryView {
  const incidents: RecoveryIncidentView[] = status.incidents.map((i) => ({
    operationId: i.operationId,
    operationType: i.operationType,
    state: i.state,
    decision: i.decision,
    snapshotId: i.snapshotId,
    reason: i.reason,
    createdAt: i.createdAt,
    actionable: i.decision !== 'needs-attention' && i.snapshotId !== null && i.snapshotId !== '',
    isContinue: i.decision === 'rollback-continue',
  }));
  const recoveryRequired = incidents.length > 0;
  let state: RecoveryUiState = 'NORMAL';
  if (recoveryRequired) {
    if (incidents.some((i) => i.state === 'RECOVERING')) state = 'RECOVERING';
    else if (incidents.some((i) => i.decision === 'rollback-continue')) state = 'ROLLBACK_CONTINUE';
    else if (incidents.some((i) => i.decision === 'rollback-recommended')) state = 'ROLLBACK_RECOMMENDED';
    else state = 'NEEDS_ATTENTION';
  }
  return { state, recoveryRequired, incidents, running: status.running };
}

/** 单个 preview 的渲染模型。 */
export interface RecoveryPreviewView {
  operationId: string;
  operationType: string;
  state: string;
  decision: RecoveryDecision;
  snapshotId: string | null;
  snapshotVerdict: string | null;
  snapshotMeta: { id: string; createdAt: string; operationType?: string } | null;
  environmentCompatible: boolean;
  reason: string;
  createdAt: string;
  /** 是否可执行（decision 非 needs-attention 且 snapshot 可信）。 */
  actionable: boolean;
}

/** 把 GET /recovery/:operationId/preview 映射为渲染模型。 */
export function toRecoveryPreviewView(p: RecoveryPreview): RecoveryPreviewView {
  return {
    operationId: p.operationId,
    operationType: p.operationType,
    state: p.state,
    decision: p.decision,
    snapshotId: p.snapshotId,
    snapshotVerdict: p.snapshotVerdict,
    snapshotMeta: p.snapshotMeta,
    environmentCompatible: p.environmentCompatible,
    reason: p.reason,
    createdAt: p.createdAt,
    actionable: p.decision !== 'needs-attention' && p.snapshotId !== null && p.snapshotId !== '',
  };
}

/** verdict → UI 状态分类（验证结果）。 */
export function verdictToUiState(verdict: RecoveryVerdict): RecoveryUiState {
  switch (verdict) {
    case 'MATCH': return 'MATCH';
    case 'PARTIAL_MATCH': return 'PARTIAL_MATCH';
    case 'MISMATCH': return 'MISMATCH';
    case 'VERIFICATION_ERROR': return 'VERIFICATION_ERROR';
  }
}

/** verdict → 是否 terminal 成功（MATCH / PARTIAL_MATCH）。 */
export function isVerdictSuccess(verdict: RecoveryVerdict): boolean {
  return verdict === 'MATCH' || verdict === 'PARTIAL_MATCH';
}

/** verdict → 是否需人工处理（MISMATCH / VERIFICATION_ERROR）。 */
export function isVerdictAttention(verdict: RecoveryVerdict): boolean {
  return verdict === 'MISMATCH' || verdict === 'VERIFICATION_ERROR';
}

/** snapshot verdict → 是否可信（可作 recovery 目标）。 */
export function isSnapshotTrusted(verdict: string | null): boolean {
  return verdict === 'TRUSTED_OPERATION_SNAPSHOT';
}

/** 把 incident 列表按 createdAt 倒序排序（最新在前）。 */
export function sortIncidentsByNewest(incidents: RecoveryIncident[]): RecoveryIncident[] {
  return [...incidents].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}
