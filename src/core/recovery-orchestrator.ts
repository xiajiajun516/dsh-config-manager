/**
 * Phase 5 Recovery Orchestration（§9.2「新增 recovery 编排层」）。
 *
 * 职责：把 recovery 路由的编排逻辑（decision / confirmation / authority / snapshot 校验 /
 * journal 状态机 / 原子 verification+terminal / dismiss）提取为可测纯编排层。
 * 路由（index.ts）只负责：loopback fence + withMutationLock + 把结果映射为 HTTP 响应。
 *
 * 安全不变量（§9.4 / §11）：
 *  - **权威 snapshotId 只来自 j.snapshotId**（不接受请求体覆盖）。
 *  - 只消费 `TRUSTED_OPERATION_SNAPSHOT`（requireOperationBound=true）；LEGACY/MANUAL/CORRUPT/
 *    INVALID/UNSAFE_PATH/WRONG_ENVIRONMENT/WRONG_OPERATION 一律拒绝。
 *  - destructive 动作必须 `userConfirmed=true`（双重校验：请求体 + journal 状态机）。
 *  - verify 的 verification 写入 + terminal state 为**单次原子 store.update**（§6.5）。
 *  - 不新建 journal / lock / transaction / snapshot-trust（复用现有 machinery）。
 *
 * 本模块不 import index.ts（避免循环依赖）；restore/rollback 执行器由路由注入
 * （`RecoveryExecutorFns`），测试注入 mock。
 */
import { join } from 'node:path';

import { FileSnapshotStore } from './backup.ts';
import { validateSnapshotForRestore, type RestoreSnapshotVerdict } from './restore.ts';
import { recomputeRecoveryDecision, executeRecovery } from './reconcile.ts';
import { verifyRecovery, recoveryTerminalState } from './verify-recovery.ts';
import {
  redactJournalText, isTerminalState, transitionJournalState, isValidOperationId,
  type JournalStore, type OperationJournal,
} from './journal.ts';
import { RunRegistry, type RunState } from './run-registry.ts';
import type { HostContext, Snapshot } from './types.ts';
import type { MsgFunc } from './messages.ts';
import { engineMsg } from './messages-core.ts';

/** 路由注入的恢复执行器（restore / rollback 引擎；测试注入 mock）。 */
export interface RecoveryExecutorFns {
  /** rollback-recommended：恢复到 trusted snapshot（restore.ts 引擎）。 */
  performRestore: (snapshotId: string) => Promise<{ full: boolean; failed: string[] }>;
  /** rollback-continue：续跑中断回滚（rollback.ts 引擎）。 */
  performRollback: (snapshotId: string) => Promise<{ full: boolean; failed: string[] }>;
}

export interface RecoveryOrchestratorDeps {
  store: JournalStore;
  runs: RunRegistry;
  snapshotsDir: string;
  host: HostContext;
  msg: MsgFunc;
  /** journal↔snapshot 正向校验（phase3Recovery.recoveryHooks.snapshotExists）。 */
  snapshotExists: (snapshotId: string | null, binding?: { operationId?: string; ownerInstanceId?: string; environmentFingerprint?: string }) => Promise<boolean>;
  /**
   * 当前环境指纹（**动态 getter**，非创建时捕获快照）。
   * 原因：宿主启动 recovery 分类在 fire-and-forget 异步块中跑 `initFingerprint()`，
   * 未在 makeRoutes 前 await 完成；若此处捕获创建时的值会拿到 'unknown' 初值，
   * 导致后续所有 recovery API 判 WRONG_ENVIRONMENT（环境指纹不匹配）。动态读取
   * 保证 initFingerprint 完成后，API 调用时取到真实指纹。
   */
  getEnvironmentFingerprint: () => string;
  /**
   * 清除 SAFE MODE（解除阻断）。宿主注入 `phase3Recovery.clearSafeMode()`：
   * 同时重置内存 `safeModeActive` 标志（isBlocked 读它）与 durable 标记。
   * 仅在「无其他未解决 incident」时调用（判据见 resolveSafeMode，issue #56 起为单一实现）。
   */
  clearSafeMode: () => Promise<void>;
  /**
   * SAFE MODE durable 标记当前是否阻断（issue #56）。
   *
   * 必须以**动态探测**提供（读 durable 标记的 fail-closed 三态，与 mutation gate 的
   * `isBlocked` 同源），而不是创建期捕获的快照：RECOVERY_REQUIRED 的 durable 标记在
   * 启动分类阶段才落盘，创建期读取会恒为 false。
   *
   * 未注入 → 恒 false（等价改造前行为：status 不含 safeMode、clearSafeMode 不检查前置态）。
   * 有它之后：「已结案但保护仍开着」（dismiss 后的旧版本遗留态、手工删过 journal 的残留态）
   * 才能在界面上看得见、并有显式出口 —— 这正是 issue #56 里「面板显示无事可做、写操作却 423」的根因。
   */
  safeModeBlocked?: () => boolean;
  /**
   * 只读环境锁状态（issue #31）。**由宿主注入而非本模块 import**：本模块不依赖 env-lock，
   * 无锁环境（测试 mock 端口）可返回保守的 UNKNOWN_STATE。
   * detail / ownerInstanceId 含 owner pid/op/实例标识等内部诊断 → 只用于日志与
   * **本模块内部**的 journal↔锁归属匹配，绝不进响应体。
   */
  inspectLockState: () => Promise<{ state: string; detail?: string; ownerInstanceId?: string }>;
  /**
   * 显式回收 stale 残留锁（EnvironmentLockManager.recoverStaleLock）。
   * **调用方不得先 acquire 锁**：要回收的正是挡住 acquire 的那把锁，先取锁必然失败。
   * 该方法自身保证 inspect → 证明确证死亡 → 原子 rename 捕获 → 二次验证 → unlink，
   * 任一步不确定即拒绝（活锁绝不删）。
   */
  recoverStaleLock: () => Promise<{ ok: boolean; removed: boolean; state: string; detail?: string }>;
}

/** 编排结果（路由映射为 HTTP 响应）。 */
export type RecoveryResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400; body: Record<string, unknown> }
  | { status: 404; body: Record<string, unknown> }
  | { status: 409; body: Record<string, unknown> }
  | { status: 500; body: Record<string, unknown> };

export interface RecoveryOrchestrator {
  status(): Promise<RecoveryResult>;
  preview(operationId: string): Promise<RecoveryResult>;
  confirm(operationId: string, userConfirmed: boolean): Promise<RecoveryResult>;
  execute(operationId: string, userConfirmed: boolean, makeExecutors: (runId: string) => RecoveryExecutorFns): Promise<RecoveryResult>;
  verify(operationId: string): Promise<RecoveryResult>;
  retry(operationId: string, userConfirmed: boolean, makeExecutors: (runId: string) => RecoveryExecutorFns): Promise<RecoveryResult>;
  dismiss(operationId: string, userConfirmed: boolean): Promise<RecoveryResult>;
  /** issue #31：显式回收 stale 残留锁（无 operationId；非 journal 事项）。 */
  recoverStaleLock(userConfirmed: boolean): Promise<RecoveryResult>;
  /**
   * issue #56：显式解除 SAFE MODE（无 operationId；同样不是 journal 事项）。
   * 判据与 verify/dismiss 后的自动解除**同一个** resolveSafeMode：还有未解决 incident
   * 时拒绝清除（ok=false + reason），不让这个入口变成绕过恢复的旁路。
   */
  clearSafeModeBlock(userConfirmed: boolean): Promise<RecoveryResult>;
}

export function createRecoveryOrchestrator(deps: RecoveryOrchestratorDeps): RecoveryOrchestrator {
  const { store, runs, snapshotsDir, host, snapshotExists, getEnvironmentFingerprint, clearSafeMode, inspectLockState, recoverStaleLock } = deps;
  const safeModeBlocked = deps.safeModeBlocked ?? ((): boolean => false);

  /**
   * 该 active journal 是否属于「正在正常执行中的外部操作」（in-flight），而不是
   * 「一次未正常完成的操作」（incident）。
   *
   * 为什么必须区分：autosync push 的 journal 在整个执行期间存在于 `transactions/active/`
   * （state=CREATED→APPLYING，成功后直接 moveToCompleted）。旧 status() 把所有非 terminal
   * 的 active journal 一律当 incident 上报 ⇒ 正在跑的 push 被显示成「需要人工处理」的事故，
   * 顶部冒出「配置修改已被保护」+「已进入安全模式」，而这类 journal 没有 snapshotId、
   * decision 恒为 needs-attention ⇒ 「执行恢复」永久灰；唯一出口 dismiss 又要 GLOBAL 锁，
   * 而锁正被同一个操作持着 ⇒ 点一次 423 一次。用户界面上是个纯粹的死胡同。
   *
   * 判据三合一，任一不成立就保守地仍按 incident 上报：
   *  1. state 非 terminal 且非 NEEDS_ATTENTION（后者是明确的「需人工处理」）；
   *  2. 环境锁 state === 'LOCKED'（另一任务活跃持有；STALE/UNKNOWN 都不可当作「有人在跑」）；
   *  3. journal.ownerInstanceId === 锁持有者的 owner.instanceId —— 证明持锁的实例**就是**
   *     写这条 journal 的实例，即它正在跑，而非上次崩溃的残骸。
   *
   * 不用时间窗启发式：op 执行期间 journal 本来就可能长时间不写（外部步骤无中途落盘），
   * 任何「多久没更新算卡住」的阈值都会误伤慢速 push。
   */
  const isLiveInFlight = (j: OperationJournal, lock: { state: string; ownerInstanceId?: string } | undefined): boolean => {
    if (lock === undefined || lock.state !== 'LOCKED') return false;
    if (isTerminalState(j.state) || j.state === 'NEEDS_ATTENTION') return false;
    const holder = lock.ownerInstanceId;
    if (holder === undefined || holder === '') return false;
    const owner = j.ownerInstanceId;
    return owner !== null && owner !== '' && owner === holder;
  };

  /**
   * 只读 recovery decision（不修改 journal）。**不用 reconcileActive**：其 §6.5 硬门控会把
   * RECOVERING journal 迁移到 NEEDS_ATTENTION，若 status 轮询时触发会破坏 execute→verify 流程。
   */
  const decision = async (j: OperationJournal): Promise<'rollback-continue' | 'rollback-recommended' | 'needs-attention'> => {
    if (j.state === 'NEEDS_ATTENTION') {
      return recomputeRecoveryDecision(j, { snapshotExists });
    }
    if (j.state === 'RECOVERING') {
      if (Object.keys(j.rollback.entryDone ?? {}).length > 0) return 'rollback-continue';
      return 'needs-attention';
    }
    return 'needs-attention'; // CREATED/SNAPSHOT_CREATED/APPLYING/VALIDATING → 保守
  };

  /** 校验 trusted snapshot（requireOperationBound=true）；返回 verdict。 */
  const validateSnapshotVerdict = async (snapshotId: string): Promise<RestoreSnapshotVerdict> => {
    const v = await validateSnapshotForRestore(join(snapshotsDir, snapshotId), snapshotsDir, { environmentFingerprint: getEnvironmentFingerprint() });
    return v.verdict;
  };

  /**
   * **SAFE MODE 的唯一解除判据**（§5.3 / §10.2「SAFE MODE 退出」，issue #56 收敛为单一实现）。
   *
   * 仅当 **不存在其他未解决 active journal**（active 全部为已解决 terminal：
   * COMMITTED/ROLLED_BACK/RECOVERED，**NEEDS_ATTENTION 视为未解决**——它代表仍需
   * 人工处理的 incident，必须保持 SAFE MODE 阻断）时，才清除 durable 标记与内存标志。
   * fail-closed：扫描失败不强行清除（保守保留 SAFE MODE）。
   *
   * 三个调用时机（此前只有第一个，正是 issue #56 的死结）：
   *  - verify 判 ROLLED_BACK 之后（恢复成功）；
   *  - **dismiss 之后**：用户放弃恢复 = 该 incident 结案，若没有别的未解决 incident
   *    就必须一并解除保护，否则「面板空了、写操作仍 423、重启无效」；
   *  - **显式清除路由**（`clearSafeModeBlock(state)`，面板上的解除入口）。
   *
   * @param probeOnly true = 只判定不写盘（供 status 如实回传「结案但保护仍开」）。
   * @returns 判定通过时实际调用 clearSafeMode 后为 true。
   */
  const resolveSafeMode = async (probeOnly = false): Promise<boolean> => {
    try {
      const activeIds = await store.scanActive();
      let allResolved = true;
      for (const opId of activeIds) {
        const j = await store.loadActive(opId);
        if (j === null) continue;
        // NEEDS_ATTENTION 是 terminal 但代表未解决 incident → 不视为 resolved
        if (j.state === 'NEEDS_ATTENTION') { allResolved = false; break; }
        if (!isTerminalState(j.state)) { allResolved = false; break; }
      }
      if (!allResolved) return false;
      if (!probeOnly) await clearSafeMode();
      return true;
    } catch {
      // 扫描失败保守：不清除 SAFE MODE（fail-closed）
      return false;
    }
  };

  /** 执行 recovery（execute/retry 共用）：登记 run → 注入执行器工厂 → executeRecovery。 */
  const runExecution = async (    operationId: string,
    j: OperationJournal,
    decisionKind: 'rollback-recommended' | 'rollback-continue',
    makeExecutors: (runId: string) => RecoveryExecutorFns,
  ): Promise<RecoveryResult> => {
    let run: RunState;
    try {
      run = runs.register('recovery');
    } catch (error) {
      return { status: 409, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    const runId = run.runId;
    try {
      const executors = makeExecutors(runId);
      const result = await executeRecovery(store, {
        operationId, action: 'rollback', snapshotId: j.snapshotId, decision: decisionKind,
        performRestore: executors.performRestore, performRollback: executors.performRollback,
      }, true);
      if (result === 'failed') {
        runs.fail(runId, engineMsg('core.recovery.executeFailed'));
        return { status: 400, body: { error: engineMsg('core.recovery.executeFailed'), runId } };
      }
      runs.finish(runId, { decision: decisionKind, state: 'RECOVERING' });
      return { status: 200, body: { ok: true, operationId, decision: decisionKind, state: 'RECOVERING', runId } };
    } catch (error) {
      runs.fail(runId, error instanceof Error ? error.message : String(error));
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error), runId } };
    }
  };

  return {
    async status() {
      // issue #56：SAFE MODE 阻断态必须如实回传（此前 status 只有 incidents/running/lock）。
      // 「durable 标记还在 + active/ 已空」= 保护开着却没有可操作对象 —— 界面据此渲染
      // 「解除安全模式」入口，而不是显示「暂无需要处理的恢复事项」然后继续 423。
      const blocked = safeModeBlocked();
      const clearable = blocked ? await resolveSafeMode(true) : false;
      // issue #31：附带环境锁分类。**只暴露分类，不暴露 owner pid/op/hostname**（内部诊断）。
      // attention 只对「需用户显式处理」的状态为 true：STALE_LOCK_DETECTED（残留锁，重试不会自愈）
      // 与 UNKNOWN_STATE（无法判定）→ 引导用户回收；LOCKED（另一任务活跃持有）会自行释放，
      // 不该催用户去「回收」，否则又是一个误导。探测失败 → 保守 UNKNOWN_STATE + attention。
      //
      // 探测必须**先于** incident 分类：LOCKED 且持有者 == journal.ownerInstanceId 时该 journal
      // 是「正在跑」，不该进 incidents（解释见 isLiveInFlight）。
      let lock: { state: string; attention: boolean } | undefined;
      let lockInsp: { state: string; ownerInstanceId?: string } | undefined;
      try {
        const insp = await inspectLockState();
        lockInsp = insp.ownerInstanceId !== undefined
          ? { state: insp.state, ownerInstanceId: insp.ownerInstanceId }
          : { state: insp.state };
        lock = {
          state: insp.state,
          attention: insp.state === 'STALE_LOCK_DETECTED' || insp.state === 'UNKNOWN_STATE',
        };
      } catch {
        lock = { state: 'UNKNOWN_STATE', attention: true };
      }
      const activeIds = await store.scanActive();
      const incidents: Array<{
        operationId: string; operationType: string; state: string; decision: string;
        snapshotId: string | null; reason: string; createdAt: string;
      }> = [];
      /** 正在正常执行的操作（不是 incident）：面板据此解释「为什么现在什么都点不动」。 */
      const live: Array<{ operationId: string; operationType: string; state: string; startedAt: string }> = [];
      for (const opId of activeIds) {
        const j = await store.loadActive(opId);
        if (j === null) continue;
        if (isTerminalState(j.state) && j.state !== 'NEEDS_ATTENTION') continue; // COMMITTED/ROLLED_BACK/RECOVERED → 非 incident
        // 正在跑的操作：既不进 incidents（否则伪装成事故 + 假 SAFE MODE 横幅），
        // 也不进 running（那是 recovery run），单列进 live 供界面如实说明。
        if (isLiveInFlight(j, lockInsp)) {
          live.push({ operationId: opId, operationType: j.operationType, state: j.state, startedAt: j.createdAt });
          continue;
        }
        const d = await decision(j);
        incidents.push({
          operationId: opId,
          operationType: j.operationType,
          state: j.state,
          decision: d,
          snapshotId: j.snapshotId,
          reason: redactJournalText(j.error || j.recovery.reason || ''),
          createdAt: j.createdAt,
        });
      }
      const running = runs.listActive().filter((r) => r.kind === 'recovery').map((r) => ({ runId: r.runId, status: r.status }));
      // issue #56：SAFE MODE 阻断态如实回传。`clearable` = 「结案但保护仍开着」
      // （durable 标记在、没有任何未解决 incident）—— 界面据此渲染显式解除入口。
      // live 是**加法字段**：旧客户端读不到就按「无进行中操作」处理，不影响既有渲染。
      return { status: 200, body: { incidents, running, live, lock, safeMode: { blocked, clearable } } };
    },

    async preview(operationId) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      const d = await decision(j);
      let snapshotVerdict: RestoreSnapshotVerdict | null = null;
      let snapshotMeta: { id: string; createdAt: string; operationType?: string } | null = null;
      if (j.snapshotId !== null && j.snapshotId !== '') {
        snapshotVerdict = await validateSnapshotVerdict(j.snapshotId);
        try {
          const snap = await new FileSnapshotStore({ dir: snapshotsDir }).load(j.snapshotId);
          snapshotMeta = { id: snap.id, createdAt: snap.createdAt, operationType: snap.operationType };
        } catch { /* 快照缺失 */ }
      }
      return {
        status: 200,
        body: {
          operationId,
          operationType: j.operationType,
          state: j.state,
          decision: d,
          snapshotId: j.snapshotId,
          snapshotVerdict,
          snapshotMeta,
          environmentFingerprint: j.environmentFingerprint,
          environmentCompatible: j.environmentFingerprint === getEnvironmentFingerprint(),
          reason: redactJournalText(j.error || j.recovery.reason || ''),
          createdAt: j.createdAt,
        },
      };
    },

    async confirm(operationId, userConfirmed) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'NEEDS_ATTENTION') return { status: 409, body: { error: engineMsg('core.recovery.stateNotAllowed', { state: j.state, action: 'confirm' }) } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: engineMsg('core.recovery.noTrustedSnapshot') } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: engineMsg('core.recovery.snapshotUntrusted', { verdict }) } };
      // journal 保持 NEEDS_ATTENTION（confirm 不转 RECOVERING）
      return { status: 200, body: { ok: true, operationId, snapshotId: j.snapshotId, verdict } };
    },

    async execute(operationId, userConfirmed, makeExecutors) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'NEEDS_ATTENTION' && j.state !== 'RECOVERING') return { status: 409, body: { error: engineMsg('core.recovery.stateNotAllowed', { state: j.state, action: 'execute' }) } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: engineMsg('core.recovery.noTrustedSnapshot') } };
      const d = await decision(j);
      if (d === 'needs-attention') return { status: 400, body: { error: engineMsg('core.recovery.needsAttentionNoAuto') } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: engineMsg('core.recovery.snapshotUntrusted', { verdict }) } };
      return runExecution(operationId, j, d, makeExecutors);
    },

    async verify(operationId) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'RECOVERING') return { status: 409, body: { error: engineMsg('core.recovery.stateNotAllowed', { state: j.state, action: 'verify' }) } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: engineMsg('core.recovery.noTrustedSnapshotShort') } };
      let snap: Snapshot;
      try {
        snap = await new FileSnapshotStore({ dir: snapshotsDir }).load(j.snapshotId);
      } catch {
        return { status: 400, body: { error: engineMsg('core.recovery.snapshotLoadFailed') } };
      }
      const verification = await verifyRecovery(snap, host, { snapshotsRoot: snapshotsDir, environmentFingerprint: getEnvironmentFingerprint(), expectedOperationId: j.operationId });
      const terminal = recoveryTerminalState(verification.verdict);
      // 单次原子 journal update：recoveryVerification + terminal state（§6.5）
      await store.update(operationId, (cur) => {
        let next = cur;
        if (!isTerminalState(cur.state)) next = transitionJournalState(cur, terminal);
        next = { ...next, recoveryVerification: { verdict: verification.verdict, details: verification.details.map(redactJournalText), manualHints: verification.manualHints.map(redactJournalText), at: verification.at } };
        return next;
      });
      if (terminal === 'ROLLED_BACK') await store.moveToCompleted(operationId).catch(() => undefined);
      // §5.3 / §10.2：recovery 成功后若无其他未解决 incident → 清除 SAFE MODE（解除阻断）
      if (terminal === 'ROLLED_BACK') await resolveSafeMode();
      return {
        status: 200,
        body: {
          ok: true, operationId, verdict: verification.verdict, terminal,
          details: verification.details.map(redactJournalText),
          manualHints: verification.manualHints.map(redactJournalText),
        },
      };
    },

    async retry(operationId, userConfirmed, makeExecutors) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'NEEDS_ATTENTION') return { status: 409, body: { error: engineMsg('core.recovery.stateNotAllowed', { state: j.state, action: 'retry' }) } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: engineMsg('core.recovery.noTrustedSnapshotShort') } };
      const d = await decision(j);
      if (d === 'needs-attention') return { status: 400, body: { error: engineMsg('core.recovery.needsAttentionNoRetry') } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: engineMsg('core.recovery.snapshotUntrusted', { verdict }) } };
      return runExecution(operationId, j, d, makeExecutors);
    },

    async dismiss(operationId, userConfirmed) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      // 正在执行的操作不能「放弃」：它不是事故，quarantine 会把在跑的那条 journal 从 active/
      // 抽走，让执行方后续 transition 失败。正常情况下这条路径走不到 —— 路由的 GLOBAL 锁
      // 会先以 423 挡下；这里是防御性判据（锁端口未接线/跨进程判定差异时仍能给出准确原因，
      // 而不是笼统的「另一个任务正在运行」）。
      let lockForDismiss: { state: string; ownerInstanceId?: string } | undefined;
      try {
        lockForDismiss = await inspectLockState();
      } catch { /* 探测失败 → 不拦（保持旧行为） */ }
      if (isLiveInFlight(j, lockForDismiss)) {
        return { status: 409, body: { error: engineMsg('core.recovery.opInFlight', { state: j.state }), code: 'operation-in-flight' } };
      }
      // dismiss → quarantine（用户放弃；不删除 snapshot/journal evidence，不强行 RECOVERED）
      const result = await executeRecovery(store, { operationId, action: 'dismiss', snapshotId: j.snapshotId }, true);
      if (result === 'failed') return { status: 400, body: { error: engineMsg('core.recovery.dismissFailed') } };
      // issue #56：放弃恢复 = 该 incident 结案 —— 若没有别的未解决 incident，必须同时解除保护。
      // 此前这里只 quarantine 不清 SAFE MODE，而唯一的清除点挂在 verify(ROLLED_BACK) 上，
      // 事务已被移出 active/ ⇒ 那条分支永远走不到：界面显示「暂无待处理」，写操作却持续 423，
      // 且 durable 标记跨重启生效 ⇒ 用户没有任何自动出路（只能手工删 transactions/safe-mode）。
      // 判定仍是同一份 resolveSafeMode（还有别的 incident 时它会保守保留保护）。
      const cleared = await resolveSafeMode();
      return { status: 200, body: { ok: true, operationId, dismissed: true, safeMode: cleared } };
    },

    /**
     * 显式解除 SAFE MODE（issue #56 的通用出口）。
     *
     * 适用场景（dismiss 修复后仍然存在）：事务已被手工移走/隔离、durable 标记却还在。
     * 语义与 verify/dismiss 完全同源 —— 调用同一份 resolveSafeMode 判定，**绝不无条件清标记**：
     * 只要还有 NEEDS_ATTENTION / 非 terminal 的 active journal 就拒绝（ok=false + 原因），
     * 避免让「解除入口」变成绕过恢复的旁路。
     */
    async clearSafeModeBlock(userConfirmed) {
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      if (!safeModeBlocked()) {
        // 幂等：本来就没在阻断（旧客户端/重复点击）→ 不是错误，如实回报
        return { status: 200, body: { ok: true, cleared: false, reason: 'not-blocked' } };
      }
      const activeIds = await store.scanActive();
      let unresolved = 0;
      for (const opId of activeIds) {
        const j = await store.loadActive(opId);
        if (j === null) continue;
        if (j.state === 'NEEDS_ATTENTION' || !isTerminalState(j.state)) unresolved += 1;
      }
      if (unresolved > 0) {
        return { status: 400, body: { ok: false, cleared: false, reason: 'unresolved-incidents', unresolved } };
      }
      const cleared = await resolveSafeMode();
      if (!cleared) {
        return { status: 500, body: { ok: false, cleared: false, reason: 'clear-failed' } };
      }
      host.log.warn('SAFE MODE cleared explicitly (user confirmed)');
      return { status: 200, body: { ok: true, cleared: true } };
    },

    /**
     * issue #31：显式回收 stale 残留锁。**无 operationId**——残留锁没有 journal（这正是
     * 「事故恢复」面板过去恒空的原因），因此不复用 confirm/execute 那套 journal 状态机。
     *
     * 正确性边界（不放松「绝不自动摘锁」）：
     *  - **不 acquire 锁**：要回收的正是挡住 acquire 的那把锁，先取锁必然失败；
     *  - 是否真的 stale 由 recoverStaleLock 内部重做判定（inspect + 二次验证），
     *    本层拿到的 state/detail 只用于日志，绝不作为删除依据；
     *  - 活锁/判定不确定 → 内部拒绝，ok=false，不做任何改动（不误删别人的锁）。
     */
    async recoverStaleLock(userConfirmed) {
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      try {
        const res = await recoverStaleLock();
        if (res.detail !== undefined) {
          // 内部诊断（op/pid/路径）只进日志
          host.log[res.ok ? 'info' : 'warn'](`stale lock recovery: ok=${res.ok} state=${res.state} detail=${res.detail}`);
        }
        if (!res.ok) {
          // 拒绝是正常结果（活锁/无法证明 stale/二次验证失败），不是 500
          return { status: 200, body: { ok: false, removed: false, state: res.state, reason: res.detail ?? engineMsg('core.recovery.lockNotStale') } };
        }
        // 回收成功后 stale 分类已消失；锁态交由客户端重新拉取 status 刷新
        return { status: 200, body: { ok: true, removed: res.removed, state: res.state } };
      } catch (error) {
        return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}
