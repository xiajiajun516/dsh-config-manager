/**
 * Phase 3 Host Recovery 集成助手。
 *
 * 职责（最小、保守）：
 *  - 持有 JournalStore + 内存 SAFE MODE 标志（isBlocked 同步谓词，供 env-lock 注入）。
 *  - `startup(lockState)`：启动时**只读**扫描 + 锁状态判定 → 设 SAFE MODE / RECOVERY_REQUIRED（durable）。
 *    **不自动 recover stale lock**（Rev 3 P1-NEW-2）。
 *  - 保守 reconcile hooks：任何无法证明的 step → needs-attention → SAFE MODE（绝不自动恢复/回滚）。
 *
 * 引擎级 WAL / 指纹（import/restore 逐 step 插桩）为 Phase 3 v1 之外（§33 不要临时扩大）——
 * 本助手提供保守的「operation intent + crash 判定」基础，供宿主在各 destructive 入口包 Coordinator。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import {
  JournalStore, environmentFingerprint as computeFingerprint, SAFE_MODE_MARKER,
  generateOperationId, createJournalEntry, transitionJournalState, isTerminalState,
} from './journal.ts';
import type { OperationJournal } from './journal.ts';
import { inspectStartup, type ReconcileProbeHooks, type ReconcileEnv } from './reconcile.ts';
import { OWNERSHIP_FILE, type LockState, type MutationLockContext } from '../utils/env-lock.ts';

/** 存在未收敛的 active transaction → 拒绝创建第二个（active≤1）。 */
export class TransactionRecoveryRequiredError extends Error {
  constructor(opId: string) {
    super(`active transaction ${opId} 未收敛（待 recover / reconcile），拒绝创建新 transaction`)
    this.name = 'TransactionRecoveryRequiredError'
  }
}

/**
 * Phase 4 生产 journal↔snapshot 绑定 API（deferred 模式）：
 *  fn 收到此 ctx，在【首个 destructive side effect 前】：
 *   - 用 plan 创建 op-bound snapshot（operationId/operationType/environmentFingerprint/ownerInstanceId）
 *   - `bindSnapshot(id)`：journal 记录 snapshotId，CREATED→SNAPSHOT_CREATED
 *   - 首个 mutation 前 `markApplying()`：SNAPSHOT_CREATED→APPLYING
 *  保证「快照 durable+verified 且 journal 已知」先于任何写。显式 ctx，无 process-global reentrancy。
 */
export interface JournalRunContext {
  operationId: string;
  operationType: string;
  environmentFingerprint: string;
  ownerInstanceId: string;
  /** 记录 journal.snapshotId 并推进 CREATED/SNAPSHOT_CREATED。 */
  bindSnapshot: (snapshotId: string) => Promise<void>;
  /** 首个 destructive side effect 前调用：SNAPSHOT_CREATED→APPLYING（或 CREATED→APPLYING）。 */
  markApplying: () => Promise<void>;
}

/** 把环境锁分类映射到 startup 判定：ACQUIRED 视同 LOCKED（有活跃 owner），IO/PERMISSION 保守 LOCKED。 */
export function mapLockStateForStartup(state: LockState): 'LOCKED' | 'STALE_LOCK_DETECTED' | 'UNKNOWN_STATE' | 'FREE' {
  if (state === 'STALE_LOCK_DETECTED') return 'STALE_LOCK_DETECTED';
  if (state === 'UNKNOWN_STATE') return 'UNKNOWN_STATE';
  return 'LOCKED'; // ACQUIRED / LOCKED / LOCK_IO_ERROR / PERMISSION_ERROR → 保守 LOCKED
}

export interface Phase3RecoveryOptions {
  dataDir: string;
  packageVersion: string;
  /** 覆盖环境指纹（测试） */
  environmentFingerprint?: string;
  /** 环境指纹持久化 token 目录（缺省 dataDir） */
  fingerprintDataDir?: string;
  /**
   * Phase 4 F21/F11 生产正向校验：校验 journal 引用的 snapshot 是否「存在 + READY + verified +
   * op/env/owner binding 匹配」。缺省 = 保守 false（无法证明存在 → 不强推回滚）。
   * 宿主注入 FileSnapshotStore + verifySnapshot + manifest binding 校验实现。
   */
  snapshotExists?: (snapshotId: string | null, binding?: SnapshotBindingRef) => Promise<boolean>;
}

/** journal↔snapshot binding 引用（与 reconcile ReconcileProbeHooks.snapshotExists 的 binding 一致）。 */
export interface SnapshotBindingRef {
  operationId?: string;
  ownerInstanceId?: string;
  environmentFingerprint?: string;
}

export class Phase3Recovery {
  readonly store: JournalStore;
  readonly packageVersion: string;
  private readonly dataDir: string;
  private readonly fingerprintDataDir: string;
  private environmentFingerprint: string;
  private readonly snapshotExistsFn: Phase3RecoveryOptions['snapshotExists'];

  /** 内存 SAFE MODE 标志（isBlocked 同步谓词用） */
  safeModeActive = false;

  constructor(opts: Phase3RecoveryOptions) {
    this.dataDir = opts.dataDir;
    this.fingerprintDataDir = opts.fingerprintDataDir ?? opts.dataDir;
    this.store = new JournalStore({ transactionsDir: path.join(opts.dataDir, 'transactions') });
    this.packageVersion = opts.packageVersion;
    this.environmentFingerprint = opts.environmentFingerprint ?? 'unknown';
    this.snapshotExistsFn = opts.snapshotExists;
  }

  /** 计算环境指纹（持久化 token；跨启动稳定）。在 startup 前调用一次。 */
  async initFingerprint(): Promise<string> {
    try {
      await fs.mkdir(this.fingerprintDataDir, { recursive: true });
      this.environmentFingerprint = await computeFingerprint(this.fingerprintDataDir);
    } catch {
      this.environmentFingerprint = 'unknown';
    }
    return this.environmentFingerprint;
  }

  /** isBlocked 同步谓词（供 withMutationLock / runWithMutationLock 注入；env-lock 只问 blocked?） */
  isBlocked(): boolean {
    return this.safeModeActive;
  }

  /** 刷新 SAFE MODE 标志（读 durable 标记） */
  async refreshSafeMode(): Promise<void> {
    this.safeModeActive = await this.store.readSafeMode().catch(() => false);
  }

  /** 同步探测 durable SAFE MODE 标记（宿主 apply() 同步阶段、scheduler.start() 前调用，保证先阻断）。 */
  probeSafeModeSync(): boolean {
    const p = path.join(this.dataDir, 'transactions', SAFE_MODE_MARKER);
    try {
      const text = fssync.existsSync(p) ? fssync.readFileSync(p, 'utf8') : '';
      const blocked = /blocked|true/i.test(text);
      this.safeModeActive = blocked;
      return blocked;
    } catch {
      return false;
    }
  }

  /** 保守 hooks：无法证明默认 needs-attention（绝不自动恢复/回滚）。snapshotExists 用宿主注入的正向校验（若提供）。 */
  private conservativeHooks(): ReconcileProbeHooks {
    const snapshotExists = this.snapshotExistsFn;
    return {
      verifyStepFingerprint: async () => 'unable',
      probeExternal: async () => 'unknown',
      snapshotExists: async (snapshotId, binding) => {
        if (snapshotExists === undefined) return false; // 未注入 → 保守 false
        return snapshotExists(snapshotId, binding);
      },
    };
  }

  /**
   * 启动只读 reconcile：返回是否需 SAFE MODE / RECOVERY_REQUIRED，并写 durable 标记。
   * @param lockState 宿主 EnvironmentLockManager 的 inspectLockState 结果（只分类，不自动 recover）
   * @param expectedOwnershipInstanceId 若在显式 recovery 前已捕获 stale ownership 的 owner.instanceId，传入以做 P1-A binding 校验
   */
  async startup(lockState: LockState, expectedOwnershipInstanceId?: string | null): Promise<{ safeModeRequired: boolean; recoveryRequired: boolean }> {
    const env: ReconcileEnv = {
      environmentFingerprint: this.environmentFingerprint || 'unknown',
      isLiveOwner: async () => false,
      ...(expectedOwnershipInstanceId ? { expectedOwnershipInstanceId } : {}),
    };
    const insp = await inspectStartup(this.store, this.conservativeHooks(), env, {}, mapLockStateForStartup(lockState));
    if (insp.safeModeRequired) this.safeModeActive = true;
    return { safeModeRequired: insp.safeModeRequired, recoveryRequired: insp.recoveryRequired };
  }

  /** P1-A：读取 crashed stale ownership 的 owner.instanceId（environment.lock 的 owner 证据；不可用返回 null）。 */
  async captureStaleOwnershipInstanceId(): Promise<string | null> {
    try {
      const p = path.join(this.dataDir, 'locks', OWNERSHIP_FILE);
      const text = await fs.readFile(p, 'utf8');
      const rec = JSON.parse(text) as { owner?: { instanceId?: unknown } };
      return typeof rec?.owner?.instanceId === 'string' && rec.owner.instanceId !== ''
        ? rec.owner.instanceId
        : null;
    } catch {
      return null;
    }
  }

  /** 用户确认恢复后清除 SAFE MODE（清空 durable 标记 + 内存标志） */
  async clearSafeMode(): Promise<void> {
    this.safeModeActive = false;
    await this.store.writeSafeMode(false);
  }

  /** 保守 reconcile hooks（供启动 barrier / inspect 用） */
  get recoveryHooks(): ReconcileProbeHooks { return this.conservativeHooks(); }
  /** 环境指纹（供启动 barrier 用） */
  get recoveryEnvFingerprint(): string { return this.environmentFingerprint || 'unknown'; }

  /**
   * 生产 journal 包装（关闭 P0-A）：在【已持 GLOBAL 锁】下，为该 destructive operation
   * 创建 durable journal（CREATED → snapshot → APPLYING → 执行真实引擎 → COMMITTED → 规整）。
   *
   *  - active≤1（§14）：创建前扫描 active/；存在非 terminal 残留（非当前 live owner）→ 抛错阻断，不建第二个 journal。
   *  - Journal→Lock 绑定（§15/P1-A）：ownerInstanceId = lockCtx.token.instanceId（= Phase 2 activeInstanceId，
   *      acquisition-specific）；lockId = 同一 ownership epoch identity（ownerInstanceId）。recovery 时强制校验。
   *  - 不 double-acquire（§6）：调用方（host gate）已持锁，本方法只负责 journal 生命周期，不 re-acquire、不 release（release 由 gate 负责）。
   *  - 异常 → NEEDS_ATTENTION + durable SAFE MODE + rethrow（不破坏既有错误/响应流）。
   *  - 返回 { operationId, result }。
   *
   *  Phase 4 snapshot 两种模式：
   *   - `snapshotProvider`（pre-fn）：journal CREATED → 调用 provider 创建并 verify snapshot → 绑定 snapshotId
   *     → SNAPSHOT_CREATED → APPLYING → fn（适合 provider 不依赖请求体 plan 的场景）。
   *   - `deferredSnapshot`（推荐，F20 生产接线）：plan 只在 handler 解析请求体后可用，因此 journal 停留在 CREATED，
   *     fn 收到 `ctx`（含 `bindSnapshot` / `markApplying`）。引擎在【首个 destructive side effect 前】用 plan 创建
   *     op-bound snapshot → ctx.bindSnapshot(id)（CREATED→SNAPSHOT_CREATED，记录 snapshotId）→ 首个 mutation 前
   *     ctx.markApplying()（SNAPSHOT_CREATED→APPLYING）。保证「快照 durable+verified 且 journal 已知」先于任何写。
   */
  async runJournaled<T>(opts: {
    operationType: string;
    lockCtx: MutationLockContext;
    /** 可选：真实 pre-operation snapshot（回滚点），返回 snapshotId（pre-fn 模式）。 */
    snapshotProvider?(): Promise<string | null>;
    /** 可选：deferred 绑定模式——journal 停留 CREATED，fn 收到 ctx 自行 bindSnapshot/markApplying。 */
    deferredSnapshot?: boolean;
    fn: (ctx?: JournalRunContext) => Promise<T>;
  }): Promise<{ operationId: string; result: T }> {
    const { operationType, lockCtx, snapshotProvider, deferredSnapshot, fn } = opts;
    const ownerInstanceId = (lockCtx?.token?.instanceId ?? 'unknown').toString();
    // P1-A：ownership epoch identity = 真实 acquisition-specific ownerInstanceId（来自 lockCtx，
    // 即 Phase 2 activeInstanceId；跨进程/跨持有不同）。不再用环境稳定合成串。
    const ownershipIdentity = ownerInstanceId;

    // active≤1：存在非 terminal 残留 → 阻断（不创建第二个 journal）
    const activeIds = await this.store.scanActive();
    for (const opId of activeIds) {
      const j = await this.store.loadActive(opId);
      if (j === null) continue;
      const ts = ['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION'] as const;
      if (!(ts as readonly string[]).includes(j.state)) {
        throw new TransactionRecoveryRequiredError(opId);
      }
    }

    const opId = generateOperationId();
    const base = {
      operationId: opId, ownerInstanceId, lockId: ownershipIdentity,
      packageVersion: this.packageVersion, environmentFingerprint: this.environmentFingerprint || 'unknown',
    };
    await this.store.create(createJournalEntry(operationType, base, new Date().toISOString()));
    let fnCompleted = false;
    let terminalPersistAttempted = false;

    // Phase 4 deferred 模式：把 journal 绑定 API 暴露给 fn（引擎在第一个 destructive side effect 前调用）。
    // bindSnapshot：记录 snapshotId 并 CREATED→SNAPSHOT_CREATED；markApplying：SNAPSHOT_CREATED→APPLYING。
    // 这些只在该 op 的同一 journal 上生效，杜绝 process-global reentrancy。
    const journalCtx: JournalRunContext = {
      operationId: opId,
      operationType,
      environmentFingerprint: this.environmentFingerprint || 'unknown',
      ownerInstanceId,
      bindSnapshot: async (snapshotId: string) => {
        if (snapshotId === null || snapshotId === '') throw new Error('bindSnapshot: snapshotId 为空');
        // Reviewer A P2①：持久化失败必须传播（fail-closed）——若 journal 无法 durable 绑定 SNAPSHOT_CREATED，
        // 引擎的 await bindSnapshot 抛错 → fn 抛错 → runJournaled catch（NEEDS_ATTENTION），mutation 绝不在无绑定下继续。
        await this.store.update(opId, (j) => {
          let next = { ...j, snapshotId } as OperationJournal;
          if (next.state === 'CREATED') next = transitionJournalState(next, 'SNAPSHOT_CREATED');
          else if (next.state === 'SNAPSHOT_CREATED') { /* 幂等：已绑定 */ }
          else if (next.state === 'APPLYING') { /* 允许：绑定已晚但幂等记录 */ }
          else throw new Error(`bindSnapshot 非法 state: ${next.state}`);
          return next;
        });
      },
      markApplying: async () => {
        // Reviewer A P2①：同 fail-closed——SNAPSHOT_CREATED→APPLYING 持久化失败须传播，不得在未 APPLYING durable 下 mutation。
        await this.store.update(opId, (j) => {
          let next = j;
          if (next.state === 'SNAPSHOT_CREATED') next = transitionJournalState(next, 'APPLYING');
          else if (next.state === 'CREATED') next = transitionJournalState(next, 'APPLYING');
          return next;
        });
      },
    };

    try {
      if (deferredSnapshot !== true && snapshotProvider !== undefined) {
        const snapId = await snapshotProvider();
        // P1-2 修复：snapshotProvider 返回 null 表示快照创建失败 → 显式 abort（不得在无快照下继续 mutation）
        if (snapId === null) {
          throw new Error(`snapshotProvider 返回 null（快照创建失败），abort operation ${operationType}`);
        }
        await journalCtx.bindSnapshot(snapId);
      } else if (deferredSnapshot !== true) {
        await this.store.update(opId, (j) => transitionJournalState(j, 'APPLYING'));
      }
      // deferred 模式：保持 CREATED，fn 自行 bindSnapshot + markApplying（首个 destructive side effect 前）
      const result = await fn(journalCtx);
      fnCompleted = true;
      // 尾操作：从任意 pre-commit 状态推进到 COMMITTED（合法链 CREATED/SNAPSHOT_CREATED→APPLYING→VALIDATING→COMMITTED）
      await this.store.update(opId, (j) => {
        let next = j;
        if (next.state === 'CREATED') next = transitionJournalState(next, 'APPLYING');
        if (next.state === 'SNAPSHOT_CREATED') next = transitionJournalState(next, 'APPLYING');
        if (next.state === 'APPLYING') next = transitionJournalState(next, 'VALIDATING');
        next = transitionJournalState(next, 'COMMITTED');
        return { ...next, commit: { at: new Date().toISOString(), validated: true, validationWarnings: [] } };
      });
      terminalPersistAttempted = true;
      await this.store.moveToCompleted(opId).catch(() => undefined);
      return { operationId: opId, result };
    } catch (err) {
      this.safeModeActive = true;
      await this.store.writeSafeMode(true).catch(() => undefined);
      if (fnCompleted && !terminalPersistAttempted) {
        // 真实事务副作用已完成，但 terminal 持久化失败 → RECOVERY_REQUIRED（不伪造终态，保持非终态 journal）
        // （此处保持 journal 非终态：apply 已成功、COMMITTED 未 durable —— 由下一轮显式 recovery 决定。
        //   SAFE MODE 已设；不额外写 NEEDS_ATTENTION，避免把「无法 durable 记录 outcome」误报成「已分类 NEEDS_ATTENTION」。）
      } else if (!fnCompleted) {
        // fn / side effect 阶段失败：op 已开始但 outcome 不确定 → NEEDS_ATTENTION（durable 分类）
        const j = await this.store.loadActive(opId);
        if (j !== null && !isTerminalState(j.state)) {
          await this.store.update(opId, (cur) => transitionJournalState(cur, 'NEEDS_ATTENTION')).catch(() => undefined);
        }
      }
      throw err;
    }
  }

  /**
   * 轻量 operation 包装（意图 journal，供外部/不可证明操作如 sync-push / reinstall 用）：
   *   创建 CREATED → APPLYING（含 external intent step）→ 执行 → COMMITTED；异常 → NEEDS_ATTENTION + SAFE MODE。
   */
  async runExternalIntent<T>(opts: {
    operationType: string;
    lockCtx: MutationLockContext;
    intent: { adapter: string; ref: string; kind: string };
    fn: (ctx?: { operationId: string }) => Promise<T>;
  }): Promise<{ operationId: string; result: T }> {
    const { operationType, lockCtx, intent, fn } = opts;
    const ownerInstanceId = (lockCtx?.token?.instanceId ?? 'unknown').toString();
    // P1-A：ownership epoch identity = 真实 acquisition-specific ownerInstanceId（非环境稳定串）
    const ownershipIdentity = ownerInstanceId;
    const opId = generateOperationId();
    const base = {
      operationId: opId, ownerInstanceId, lockId: ownershipIdentity,
      packageVersion: this.packageVersion, environmentFingerprint: this.environmentFingerprint || 'unknown',
    };
    await this.store.create(createJournalEntry(operationType, base, new Date().toISOString()));
    try {
      await this.store.update(opId, (j) => {
        const extStep: import('./journal.ts').JournalStep = { adapter: intent.adapter, ref: intent.ref, kind: intent.kind, external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null };
        const withStep = {
          ...j, plannedSteps: ['ext'], steps: { ext: extStep },
        };
        return transitionJournalState(withStep, 'APPLYING');
      });
      // Phase 4 F29/F30：把 operationId 暴露给 fn，使调用方（如 CLI reinstall）能在首个 destructive
      // side effect 前写 durably-bound recovery point（operationId + 环境/版本元数据）。
      const result = await fn({ operationId: opId });
      await this.store.update(opId, (j) => {
        let next = j;
        if (next.state === 'SNAPSHOT_CREATED') next = transitionJournalState(next, 'APPLYING');
        if (next.state === 'APPLYING') next = transitionJournalState(next, 'VALIDATING');
        next = transitionJournalState(next, 'COMMITTED');
        return { ...next, commit: { at: new Date().toISOString(), validated: true, validationWarnings: [] } };
      });
      await this.store.moveToCompleted(opId).catch(() => undefined);
      return { operationId: opId, result };
    } catch (err) {
      const j = await this.store.loadActive(opId);
      if (j !== null && !isTerminalState(j.state)) {
        await this.store.update(opId, (cur) => transitionJournalState(cur, 'NEEDS_ATTENTION')).catch(() => undefined);
      }
      this.safeModeActive = true;
      await this.store.writeSafeMode(true).catch(() => undefined);
      throw err;
    }
  }
}
