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
   * 仅当 recovery 成功且无其他未解决 incident 时调用（见 maybeClearSafeMode）。
   */
  clearSafeMode: () => Promise<void>;
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
}

export function createRecoveryOrchestrator(deps: RecoveryOrchestratorDeps): RecoveryOrchestrator {
  const { store, runs, snapshotsDir, host, msg, snapshotExists, getEnvironmentFingerprint, clearSafeMode } = deps;

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
   * recovery 成功后清除 SAFE MODE（§5.3 / §10.2「SAFE MODE 退出」）。
   * 仅当 **不存在其他未解决 active journal**（active 全部为已解决 terminal：
   * COMMITTED/ROLLED_BACK/RECOVERED，**NEEDS_ATTENTION 视为未解决**——它代表仍需
   * 人工处理的 incident，必须保持 SAFE MODE 阻断）时，才清除 durable 标记与内存标志。
   * fail-closed：扫描失败不强行清除（保守保留 SAFE MODE）。
   */
  const maybeClearSafeMode = async (): Promise<void> => {
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
      if (allResolved) {
        await clearSafeMode();
      }
    } catch {
      // 扫描失败保守：不清除 SAFE MODE（fail-closed）
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
        runs.fail(runId, 'recovery 执行失败');
        return { status: 400, body: { error: 'recovery 执行失败', runId } };
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
      const activeIds = await store.scanActive();
      const incidents: Array<{
        operationId: string; operationType: string; state: string; decision: string;
        snapshotId: string | null; reason: string; createdAt: string;
      }> = [];
      for (const opId of activeIds) {
        const j = await store.loadActive(opId);
        if (j === null) continue;
        if (isTerminalState(j.state) && j.state !== 'NEEDS_ATTENTION') continue; // COMMITTED/ROLLED_BACK/RECOVERED → 非 incident
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
      return { status: 200, body: { incidents, running } };
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
      if (j.state !== 'NEEDS_ATTENTION') return { status: 409, body: { error: `journal state ${j.state} 不允许 confirm` } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: 'journal 无 trusted snapshot，无法恢复' } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: `snapshot 不可信: ${verdict}` } };
      // journal 保持 NEEDS_ATTENTION（confirm 不转 RECOVERING）
      return { status: 200, body: { ok: true, operationId, snapshotId: j.snapshotId, verdict } };
    },

    async execute(operationId, userConfirmed, makeExecutors) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'NEEDS_ATTENTION' && j.state !== 'RECOVERING') return { status: 409, body: { error: `journal state ${j.state} 不允许 execute` } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: 'journal 无 trusted snapshot，无法恢复' } };
      const d = await decision(j);
      if (d === 'needs-attention') return { status: 400, body: { error: 'recovery decision 为 needs-attention，无法自动执行' } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: `snapshot 不可信: ${verdict}` } };
      return runExecution(operationId, j, d, makeExecutors);
    },

    async verify(operationId) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      if (j.state !== 'RECOVERING') return { status: 409, body: { error: `journal state ${j.state} 不允许 verify` } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: 'journal 无 trusted snapshot' } };
      let snap: Snapshot;
      try {
        snap = await new FileSnapshotStore({ dir: snapshotsDir }).load(j.snapshotId);
      } catch {
        return { status: 400, body: { error: 'snapshot 无法加载' } };
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
      if (terminal === 'ROLLED_BACK') await maybeClearSafeMode();
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
      if (j.state !== 'NEEDS_ATTENTION') return { status: 409, body: { error: `journal state ${j.state} 不允许 retry` } };
      if (j.snapshotId === null || j.snapshotId === '') return { status: 400, body: { error: 'journal 无 trusted snapshot' } };
      const d = await decision(j);
      if (d === 'needs-attention') return { status: 400, body: { error: 'recovery decision 为 needs-attention，无法 retry' } };
      const verdict = await validateSnapshotVerdict(j.snapshotId);
      if (verdict !== 'TRUSTED_OPERATION_SNAPSHOT') return { status: 400, body: { error: `snapshot 不可信: ${verdict}` } };
      return runExecution(operationId, j, d, makeExecutors);
    },

    async dismiss(operationId, userConfirmed) {
      if (!isValidOperationId(operationId)) return { status: 400, body: { error: 'invalid operationId' } };
      if (userConfirmed !== true) return { status: 400, body: { error: 'userConfirmed required' } };
      const j = await store.loadActive(operationId);
      if (j === null) return { status: 404, body: { error: 'operation not found' } };
      // dismiss → quarantine（用户放弃；不删除 snapshot/journal evidence，不强行 RECOVERED）
      const result = await executeRecovery(store, { operationId, action: 'dismiss', snapshotId: j.snapshotId }, true);
      if (result === 'failed') return { status: 400, body: { error: 'dismiss 失败' } };
      return { status: 200, body: { ok: true, operationId, dismissed: true } };
    },
  };
}
