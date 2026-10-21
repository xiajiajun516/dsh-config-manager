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
  RecoveryActiveOperation, RecoveryDecision, RecoveryIncident, RecoveryPreview, RecoveryStatus, RecoveryVerdict,
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

/** 渲染模型：残留锁事项（issue #31，非 journal）。null = 无需展示锁区块。 */
export interface RecoveryLockView {
  /** LockState 分类（用于选择文案；不展示原始值）。 */
  state: string;
}

/** 恢复面板渲染模型（RecoveryPanel 直接绑定）。 */
export interface RecoveryView {
  /** 顶层状态分类。 */
  state: RecoveryUiState;
  /**
   * 是否有未解决事项（SAFE MODE / 残留锁阻断）。
   * issue #31：残留锁同样阻断所有会修改配置的操作（423），因此也算「需要处理」——
   * 否则纯锁残留场景下顶部横幅与总览入口都不出现，用户看不到任何可操作指引。
   */
  recoveryRequired: boolean;
  incidents: RecoveryIncidentView[];
  /** 进行中的 recovery run（runId + status）。 */
  running: { runId: string; status: string }[];
  /**
   * 正在正常执行的操作（不是 incident）。决定两件事：
   *  ① 面板要给出一句「这些在执行中，会自行结束」，而不是让用户对着灰按钮猜；
   *  ② 若某条 incident 恰好也在跑（宿主判定放宽/旧宿主），对应行的「执行恢复/放弃恢复」要解释原因。
   */
  activeOperations: RecoveryActiveOperation[];
  /** 需用户显式处理的残留锁（attention=true 时才非 null）。 */
  lock: RecoveryLockView | null;
  /**
   * SAFE MODE 阻断中但**已无待处理事项**（issue #56）：durable 标记还在、active/ 已空。
   * 正是「面板显示暂无事项、写操作却持续 423」的那一态 —— 界面必须给出可执行的解除入口。
   */
  safeModeStuck: boolean;
  /** SAFE MODE 是否正在阻断（含仍有 incident 的正常情形；用于文案区分）。 */
  safeModeBlocked: boolean;
  /** 中断的档案复制残留（cross-F3 / t54）：只给删除，不给启动/改名。 */
  incompleteCopies: RecoveryIncompleteCopyView[];
  /**
   * t89：残留区形态 —— 界面据它把「枚举失败」与「没有残留」渲染成不同形态
   * （前者必须给可行动提示 + 重试，绝不能显示成「暂无残留」）。
   */
  incompleteCopiesNotice: RecoveryIncompleteCopiesNotice;
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
  // 旧宿主不返回 lock（undefined）→ 视为无锁事项，绝不误报可回收
  const lock: RecoveryLockView | null = status.lock !== undefined && status.lock.attention
    ? { state: status.lock.state }
    : null;
  // issue #56：旧宿主不返回 safeMode → blocked=false（按未阻断处理，绝不误报保护中）
  const safeModeBlocked = status.safeMode?.blocked === true;
  const safeModeStuck = safeModeBlocked && (status.safeMode?.clearable === true);
  // SAFE MODE 同样阻断一切写操作 → 与残留锁并列算「需要处理」。
  // 少了这一条，「结案但保护仍开」的面板会显示「暂无需要处理的恢复事项」（issue #56 的界面症状）。
  const incompleteCopies = incompleteCopyRows(status);
  // t54：中断的档案复制残留同样算「需要处理」—— 它们是删不掉的孤儿目录，
  // 而此前用户在本页看不到任何线索（t33 的原始 finding：面板既无目标目录也无处置按钮）。
  const recoveryRequired =
    incidents.length > 0 || lock !== null || safeModeStuck || incompleteCopies.length > 0;
  let state: RecoveryUiState = 'NORMAL';
  if (recoveryRequired) {
    if (incidents.some((i) => i.state === 'RECOVERING')) state = 'RECOVERING';
    else if (incidents.some((i) => i.decision === 'rollback-continue')) state = 'ROLLBACK_CONTINUE';
    else if (incidents.some((i) => i.decision === 'rollback-recommended')) state = 'ROLLBACK_RECOMMENDED';
    else state = 'NEEDS_ATTENTION';
  }
  return {
    state,
    recoveryRequired,
    incidents,
    running: status.running,
    // 旧宿主不返回 live → 空数组（绝不误报「有操作在跑」）
    activeOperations: status.live ?? [],
    lock,
    safeModeStuck,
    safeModeBlocked,
    incompleteCopies,
    incompleteCopiesNotice: incompleteCopiesNotice(status),
  };
}

/**
 * 「执行恢复」为什么不可用（面板显示原因，而不是丢一个没有任何解释的灰按钮）。
 *
 * 判据与 `actionable` 严格互补（同一条规则两处呈现）：decision=needs-attention 断了
 * 恢复路径，snapshotId 为空断了快照来源。返回 null = 可执行。
 */
export function recoveryBlockReason(
  incident: Pick<RecoveryIncidentView, 'decision' | 'snapshotId'>,
): 'needsAttention' | 'noSnapshot' | null {
  if (incident.decision === 'needs-attention') return 'needsAttention';
  if (incident.snapshotId === null || incident.snapshotId === '') return 'noSnapshot';
  return null;
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

/* ------------------------------------------------ 事故处置（崩溃 + 救援） */

export type CrashReasonKey =
  | 'recovery.crash.reason.session-corrupt'
  | 'recovery.crash.reason.bundle-check'
  | 'recovery.crash.reason.patch-tree'
  | 'recovery.crash.reason.unknown'

/** 崩溃归因 → 文案键（未知一律回落 unknown，界面永不出现空徽章）。 */
export function crashReasonKey(reason: string | null): CrashReasonKey {
  switch (reason) {
    case 'session-corrupt': return 'recovery.crash.reason.session-corrupt'
    case 'bundle-check': return 'recovery.crash.reason.bundle-check'
    case 'patch-tree': return 'recovery.crash.reason.patch-tree'
    default: return 'recovery.crash.reason.unknown'
  }
}

export type CrashAdviceKey =
  | 'recovery.crash.advice.none'
  | 'recovery.crash.advice.restore-last-good'
  | 'recovery.crash.advice.repair-session'
  | 'recovery.crash.advice.check-bundles'
  | 'recovery.crash.advice.check-patch-tree'

/** 建议动作 → 文案键（未知 / none 回落 none）。 */
export function crashAdviceKey(advice: string): CrashAdviceKey {
  switch (advice) {
    case 'restore-last-good': return 'recovery.crash.advice.restore-last-good'
    case 'repair-session': return 'recovery.crash.advice.repair-session'
    case 'check-bundles': return 'recovery.crash.advice.check-bundles'
    case 'check-patch-tree': return 'recovery.crash.advice.check-patch-tree'
    default: return 'recovery.crash.advice.none'
  }
}

export interface RescueBannerInput {
  /** 救援状态激活（状态文件存在且家目录指纹匹配） */
  active: boolean
  /** 已在当前进程生效：进程启动时刻晚于进入救援的时刻（用户已经重启过） */
  applied: boolean
}

export type RescueHintKey = 'recovery.rescue.appliedHint' | 'recovery.rescue.restartHint'

/** 第二行提示：已生效时改说「退出同样要重启」，否则说「需要重启才生效」。 */
export function rescueHintKey(input: RescueBannerInput): RescueHintKey {
  return input.active && input.applied ? 'recovery.rescue.appliedHint' : 'recovery.rescue.restartHint'
}

/**
 * ISO 时间 → 本地短格式（null / 空 / 非法 → em dash）。
 * 刻意手写而非 Intl：与列表其它时间显示同口径，避免 locale 差异让同一时刻看起来变了。
 */
export function formatRecoveryTime(value: string | null): string {
  if (value === null || value === '') return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}


/** 中断的档案复制残留的渲染模型（cross-F3 / t54）。 */
export interface RecoveryIncompleteCopyView {
  /** 目标档案名（= 目录名；删除时用它） */
  name: string;
  /** 目标目录绝对路径（渲染前过 redact()） */
  dir: string;
  /** 来源档案名（读不到 = null，界面不臆造） */
  sourceName: string | null;
  /** 复制开始时刻（ISO；读不到 = null） */
  startedAt: string | null;
  /** 开始时刻的展示文本（null → em dash，与列表其它时间同口径） */
  startedAtText: string;
  /** 恒为 true：残留目录**唯一**允许的动作就是删除 */
  canDelete: true;
  /** 恒为 false：没有 package.json 就起不来，界面绝不给启动入口 */
  canLaunch: false;
}

/**
 * 中断的档案复制残留 → 渲染模型（cross-F3 / t54）。
 *
 * 缺字段（旧宿主不返回）→ `[]`：按「无残留」处理，绝不误报。
 * 与 t50 的档案面板同一语义：独立形态（「未完成的副本」）+ 只给删除。
 */
export function incompleteCopyRows(status: RecoveryStatus): RecoveryIncompleteCopyView[] {
  const copies = status.incompleteCopies ?? [];
  return copies.map((c) => ({
    name: c.name,
    dir: c.dir,
    sourceName: c.sourceName ?? null,
    startedAt: c.startedAt ?? null,
    startedAtText: formatRecoveryTime(c.startedAt ?? null),
    canDelete: true,
    canLaunch: false,
  }));
}

/**
 * t89（S2-3）：残留区的三种形态 —— 「枚举失败」必须与「没有残留」在渲染上可区分。
 *
 * - `'unreadable'`：宿主读 profiles 目录失败（`incompleteCopiesUnreadable === true`）；
 * - `'list'`：确实读到了残留条目；
 * - `'empty'`：确实没有残留（含旧宿主完全不返回该字段的情形）。
 *
 * 失败判定**优先于**行数判定：枚举失败时 `incompleteCopies` 恒为空（服务端口径），
 * 只看行数就会把它渲染成「没有残留」—— 这正是 S2-3 的症状。
 * `recoveryRequired` **不**因失败置真：失败只是「不知道」，不是「有事项」，
 * 不能凭未知声称需要处理（与「旧宿主不返回该字段 → 不声称需要处理」同一口径）。
 */
export type RecoveryIncompleteCopiesNotice = 'list' | 'empty' | 'unreadable';

export function incompleteCopiesNotice(status: RecoveryStatus): RecoveryIncompleteCopiesNotice {
  if (status.incompleteCopiesUnreadable === true) return 'unreadable';
  return incompleteCopyRows(status).length > 0 ? 'list' : 'empty';
}

/**
 * 宿主的机器可读码：优先读结构化 `code`，兼容「只把码写进文本」的错误（t54）。
 *
 * 抽到纯函数层是为了让 423 的语义（SAFE MODE 阻断 → 有原因 + 有出口）能被单测直接钉住，
 * 不依赖真实 http；组件只消费它的结论。
 */
export function incompleteDeleteErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code !== '') return code
  const text = err instanceof Error ? err.message : String(err)
  return text.includes('mutation-locked') ? 'mutation-locked' : ''
}
