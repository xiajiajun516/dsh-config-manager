/**
 * MutationTransactionCoordinator（Phase 3：Crash Journal 核心正确性边界）。
 *
 * 职责链：acquire global lock → 检查/reconcile active ≤1 → 创建 operationId + journal CREATED
 * → 快照（SNAPSHOT_CREATED）→ 执行 WAL steps → 尾操作 + validate → 决定 terminal
 * → 写 durable terminal → move journal → 请求 release（guard 验证 isTerminal）。
 *
 * **职责分离（Rev 3 P1-NEW-1）**：Coordinator 决定 COMMITTED / ROLLED_BACK /
 * NEEDS_ATTENTION / RECOVERY_REQUIRED。Environment Lock 不决定。
 *
 * **Release Invariant**：durable terminal（COMMITTED/ROLLED_BACK/NEEDS_ATTENTION）BEFORE release。
 * Environment Lock 的 release guard 只验证 isTerminal。
 *
 * **禁止**：往 env-lock.ts 塞 recovery policy。本文件依赖最小 MutationLockPort；
 * SAFE MODE 门禁经注入谓词（isBlocked）由 Coordinator 传入 lock helper（见 env-lock 改造）。
 */
import {
  JournalStore, createJournalEntry, transitionJournalState,
  isTerminalState, generateOperationId, redactJournalText, type OperationJournal,
} from './journal.ts';
import type { MutationLockContext, MutationLockPort } from '../utils/env-lock.ts';

// ---------- 类型 ----------

export interface CoordinatorStepSpec {
  stepId: string;
  adapter: string;
  ref: string;
  kind: string;
  /** 外部副作用（插件/Git/WebDAV/reinstall）——crash 后不可证明，一律保守 */
  external: boolean;
}

export interface CoordinatedStepResult {
  /** ok = side effect 已执行（本地可指纹，afterFp 已重读）；attention = 已执行但不可证明/外部 */
  status: 'ok' | 'attention';
  beforeFp?: string | null;
  afterFp?: string | null;
  warning?: string;
}

export interface CoordinatedOperation {
  operationType: string;
  buildSteps(): CoordinatorStepSpec[];
  /** 可选：pre-operation 快照（回滚点）。返回 snapshotId。 */
  createSnapshot?(): Promise<{ snapshotId: string | null }>;
  /** 执行单个 step 的 side effect，并返回指纹证据。 */
  executeStep(stepId: string): Promise<CoordinatedStepResult>;
  /** 尾操作（markSnapshotStatus、vault 回填等）必须在 COMMITTED 之前完成，不得抛错过去。 */
  tailOperations?(): Promise<void>;
  validate(): Promise<{ ok: boolean; warnings: string[] }>;
  /** 可选：在线回滚（基于快照，带 parentContext 复用锁，走 rollback WAL）。 */
  rollback?(
    snapshotId: string | null,
    ctx: MutationLockContext,
    entryDone: (entryIndex: number) => Promise<void>,
  ): Promise<{ full: boolean; failed: string[] }>;
}

export type CoordinatorResult =
  | { outcome: 'COMMITTED'; operationId: string; snapshotId: string | null }
  | { outcome: 'ROLLED_BACK'; operationId: string; full: boolean; failed: string[]; snapshotId: string | null }
  | { outcome: 'NEEDS_ATTENTION'; operationId: string; reason: string; snapshotId: string | null }
  | { outcome: 'RECOVERY_REQUIRED'; operationId: string | null; reason: string };

export interface CoordinatorDeps {
  store: JournalStore;
  /** 最小锁契约（可为 null = 测试无锁环境，不 acquire/release，仅走 journal）。 */
  lock: MutationLockPort | null;
  /** 锁上下文（已由调用方 acquire 或 coordinator 内部 acquire）。 */
  acquireLock(): Promise<MutationLockContext>;
  /** active≤1 强制：扫描 active/，存在非当前 live owner 的残留 → 返回残留 operationId（须先 reconcile）。 */
  checkActiveClear(context: MutationLockContext): Promise<{ clear: true } | { clear: false; residue: string }>;
  /** reconcile 残留（active≤1 前置）。实现见 reconcile.ts；此处由 Coordinator 委托。 */
  reconcileResidue?(residueOpId: string, context: MutationLockContext): Promise<'recovered' | 'rolled-back' | 'needs-attention'>;
  /** 元数据：Journal→Lock 单向绑定的 lock 侧标识。 */
  lockId: string;
  ownerInstanceId: string;
  packageVersion: string;
  environmentFingerprint: string;
  /** release：terminal guard 验证 isTerminal 后才真正 release lock。 */
  releaseLock(context: MutationLockContext, operationId: string): Promise<void>;
  /** 文本脱敏（journal error/reason）。缺省用 redactJournalText。 */
  redactText?(text: string): string;
}

// ---------- Coordinator ----------

export class MutationTransactionCoordinator {
  private readonly deps: CoordinatorDeps;
  private readonly redact: (s: string) => string;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.redact = deps.redactText ?? redactJournalText;
  }

  /** 运行一个 coordinated operation。返回 terminal CoordinatorResult。 */
  async run(op: CoordinatedOperation): Promise<CoordinatorResult> {
    // 1. acquire lock
    const context = await this.deps.acquireLock();

    // 2. active≤1 前置检查（不创建第二个 journal）
    const activeCheck = await this.deps.checkActiveClear(context);
    if (!activeCheck.clear) {
      // 有残留 active → 不创建新 journal → RECOVERY_REQUIRED
      const recovered = this.deps.reconcileResidue
        ? await this.deps.reconcileResidue(activeCheck.residue, context).catch(() => 'needs-attention' as const)
        : 'needs-attention';
      if (recovered === 'recovered' || recovered === 'rolled-back') {
        // 残留已收敛 → 可继续；但本函数语义：先返回，调用方重试 run
        return { outcome: 'RECOVERY_REQUIRED', operationId: activeCheck.residue, reason: `残留 active transaction ${activeCheck.residue} 待处理，请重试` };
      }
      return { outcome: 'RECOVERY_REQUIRED', operationId: activeCheck.residue, reason: `存在 unresolved active transaction ${activeCheck.residue}` };
    }

    // 3. 创建 journal
    const operationId = generateOperationId();
    const entry = createJournalEntry(op.operationType, {
      operationId,
      ownerInstanceId: this.deps.ownerInstanceId,
      lockId: this.deps.lockId,
      packageVersion: this.deps.packageVersion,
      environmentFingerprint: this.deps.environmentFingerprint,
    }, new Date().toISOString());
    let journal: OperationJournal = await this.deps.store.create(entry);

    let snapshotId: string | null = null;
    try {
      // 4. snapshot
      if (op.createSnapshot !== undefined) {
        const snap = await op.createSnapshot();
        snapshotId = snap.snapshotId;
        journal = await this.deps.store.update(operationId, (j) => {
          const next = { ...j, snapshotId };
          return transitionJournalState(next, 'SNAPSHOT_CREATED');
        });
      }

      // 5. plannedSteps 全量登记 + APPLYING
      const steps = op.buildSteps();
      const stepMap: OperationJournal['steps'] = {};
      const plannedSteps: string[] = [];
      for (const s of steps) {
        plannedSteps.push(s.stepId);
        stepMap[s.stepId] = {
          adapter: s.adapter, ref: s.ref, kind: s.kind, external: s.external,
          beforeFp: null, afterFp: null, status: 'planned', appliedAt: null,
        };
      }
      journal = await this.deps.store.update(operationId, (j) => {
        const withSteps = { ...j, plannedSteps, steps: { ...j.steps, ...stepMap } };
        return transitionJournalState(withSteps, 'APPLYING');
      });

      // 6. 执行 WAL steps（intent → side effect → 重读 afterFp → done）
      let needAttention = false;
      const attentionReasons: string[] = [];
      for (let i = 0; i < plannedSteps.length; i++) {
        const stepId = plannedSteps[i]!;
        try {
          const result = await op.executeStep(stepId);
          await this.deps.store.update(operationId, (j) => {
            const st = j.steps[stepId] ?? stepMap[stepId];
            if (!st) return j;
            st.beforeFp = result.beforeFp ?? null;
            st.afterFp = result.afterFp ?? null;
            st.status = result.status === 'attention' ? 'attention' : 'done';
            st.appliedAt = new Date().toISOString();
            return j;
          });
          if (result.status === 'attention') {
            needAttention = true;
            if (result.warning) attentionReasons.push(result.warning);
          }
        } catch (err) {
          // 单步抛错：记录 + NEEDS_ATTENTION（不自动回滚外部/不可指纹）
          const msg = this.redact(err instanceof Error ? err.message : String(err));
          await this.deps.store.update(operationId, (j) => {
            const st = j.steps[stepId] ?? stepMap[stepId];
            if (st) st.status = 'attention';
            return { ...j, error: msg };
          });
          needAttention = true;
          attentionReasons.push(`step ${stepId}: ${msg}`);
        }
      }

      // 7. 若任一 step attention → 不可自动 commit 也不自动 rollback → NEEDS_ATTENTION
      if (needAttention) {
        return await this.finalizeAttention(operationId, `unprovable step: ${attentionReasons.join('; ')}`, snapshotId, context);
      }

      // 8. tail operations（必须在 COMMITTED 之前；抛错 → 视为未 commit → 走异常路径）
      if (op.tailOperations !== undefined) {
        await op.tailOperations();
      }

      // 9. validate
      const validation = await op.validate();
      await this.deps.store.update(operationId, (j) => {
        let next = transitionJournalState(j, 'VALIDATING');
        next = { ...next, commit: { ...next.commit, validated: validation.ok, validationWarnings: validation.warnings } };
        return next;
      });
      if (!validation.ok) {
        return await this.finalizeAttention(operationId, `validation failed: ${this.redact(validation.warnings.join('; '))}`, snapshotId, context);
      }

      // 10. COMMITTED（durable）
      await this.deps.store.update(operationId, (j) => {
        let next = transitionJournalState(j, 'COMMITTED');
        next = { ...next, commit: { ...next.commit, at: new Date().toISOString() } };
        return next;
      });

      // 11. move terminal journal + release（terminal-before-release）
      await this.deps.store.moveToCompleted(operationId);
      await this.deps.releaseLock(context, operationId);

      return { outcome: 'COMMITTED', operationId, snapshotId };
    } catch (err) {
      // 进程内异常（非 crash）：coordinator 执行策略。
      // Rev 3：**绝不自动 rollback**（破坏性回滚需用户确认，§9/§15）。未知 step 状态 → NEEDS_ATTENTION。
      const msg = this.redact(err instanceof Error ? err.message : String(err));
      const current = await this.deps.store.loadActive(operationId);
      if (current !== null && isTerminalState(current.state)) {
        // 已 terminal（如 COMMITTED 后 move 抛错 → 保持 terminal，不回滚）
        const opId = operationId;
        return { outcome: 'NEEDS_ATTENTION', operationId: opId, reason: `tail/commit 后异常：${msg}`, snapshotId };
      }
      return await this.finalizeAttention(operationId, msg, snapshotId, context);
    }
  }

  /**
   * 显式回滚（用户确认后由宿主/Reconcile 调用；走 rollback WAL）。Coordinator.run 不自动触发。
   * 正常返回 ROLLED_BACK；失败返回 RECOVERY_REQUIRED（不伪造终态）。
   */
  async rollbackForRecovery(
    op: CoordinatedOperation,
    context: MutationLockContext,
    operationId: string,
    snapshotId: string | null,
    cause: string,
  ): Promise<CoordinatorResult> {
    return this.doRollback(op, context, operationId, snapshotId, cause);
  }

  /** 在线回滚（rollback WAL）：ROLLING_BACK durable → 计划补偿 → entryDone → ROLLED_BACK。 */
  private async doRollback(
    op: CoordinatedOperation,
    context: MutationLockContext,
    operationId: string,
    snapshotId: string | null,
    cause: string,
  ): Promise<CoordinatorResult> {
    try {
      await this.deps.store.update(operationId, (j) => {
        let next = transitionJournalState(j, 'ROLLING_BACK');
        next = { ...next, error: next.error || cause, rollback: { ...next.rollback, attemptedAt: new Date().toISOString(), full: false, failed: [], entryDone: {} } };
        return next;
      });
      const report = await op.rollback!(snapshotId, context, async (entryIndex) => {
        await this.deps.store.update(operationId, (j) => {
          if (!(j.state === 'ROLLING_BACK' || j.state === 'NEEDS_ATTENTION')) return j;
          const done = { ...j.rollback.entryDone, [entryIndex]: true };
          return { ...j, rollback: { ...j.rollback, entryDone: done } };
        });
      });
      await this.deps.store.update(operationId, (j) => {
        let next = transitionJournalState(j, 'ROLLED_BACK');
        next = { ...next, rollback: { ...next.rollback, full: report.full, failed: report.failed } };
        return next;
      });
      await this.deps.store.moveToCompleted(operationId);
      await this.deps.releaseLock(context, operationId);
      return { outcome: 'ROLLED_BACK', operationId, full: report.full, failed: report.failed, snapshotId };
    } catch (rollbackErr) {
      const m = this.redact(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
      // rollback 自身失败 → 不伪造终态：留 non-terminal journal + RECOVERY_REQUIRED + SAFE MODE
      await this.deps.store.writeSafeMode(true).catch(() => undefined);
      return { outcome: 'RECOVERY_REQUIRED', operationId, reason: `rollback failed: ${m}` };
    }
  }

  /** terminal NEEDS_ATTENTION + 规整（NEEDS_ATTENTION 是 terminal → 写 SAFE MODE 后 release）。 */
  private async finalizeAttention(operationId: string, reason: string, snapshotId: string | null, context: MutationLockContext): Promise<CoordinatorResult> {
    const state = (await this.deps.store.loadActive(operationId))?.state ?? 'CREATED';
    if (!isTerminalState(state)) {
      await this.deps.store.update(operationId, (j) => {
        let next = transitionJournalState(j, 'NEEDS_ATTENTION');
        next = { ...next, error: next.error || reason, recovery: { ...next.recovery, reason } };
        return next;
      });
    }
    await this.deps.store.moveToCompleted(operationId);
    await this.deps.store.writeSafeMode(true).catch(() => undefined);
    // NEEDS_ATTENTION 是 terminal → terminal-before-release 满足；SAFE MODE 已 durable，未来 mutation 被 isBlocked 拦截。
    await this.deps.releaseLock(context, operationId).catch(() => undefined);
    return { outcome: 'NEEDS_ATTENTION', operationId, reason, snapshotId };
  }
}
