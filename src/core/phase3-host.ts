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
import {
  JournalStore, environmentFingerprint as computeFingerprint, TRANSACTIONS_DIR,
  generateOperationId, createJournalEntry, transitionJournalState, isTerminalState, isValidTransition,
  readSafeModeMarkerSync,
} from './journal.ts';
import type { JournalState, OperationJournal, SafeModeMarkerState } from './journal.ts';
import { inspectStartup, type ReconcileProbeHooks, type ReconcileEnv } from './reconcile.ts';
import { OWNERSHIP_FILE, type LockState, type MutationLockContext } from '../utils/env-lock.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { JournalStepRecord } from './types.ts';

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
/** 引擎上报的「已就地回滚」结论（见 JournalRunContext.recordRollback）。 */
export interface JournalRollbackOutcome {
  /** true = 全部补偿成功（盘面已回到导入前状态）；false = 仍有补偿失败项（半回滚态） */
  full: boolean;
  /** 补偿失败项（非敏感描述；进 journal.rollback 供事后审计） */
  failed: readonly string[];
}

export interface JournalRunContext {
  operationId: string;
  operationType: string;
  environmentFingerprint: string;
  ownerInstanceId: string;
  /** 记录 journal.snapshotId 并推进 CREATED→SNAPSHOT_CREATED（或幂等）。 */
  bindSnapshot: (snapshotId: string) => Promise<void>;
  /** 首个 destructive side effect 前调用：SNAPSHOT_CREATED/CREATED→APPLYING。 */
  markApplying: () => Promise<void>;
  /** 逐计划项 WAL step 记录（P2-B，Phase 8）：文件类带 fp，非文件类 external=true。 */
  recordStep: (step: JournalStepRecord) => Promise<void>;
  /**
   * 引擎在 fn 内部**已完成回滚**后上报（审计 P0-3）。没有这条上报，runJournaled 只能凭
   * 「fn 是否返回」推断成功 —— 而导入失败的整体回滚正是「回滚完成 + 正常返回 ok:false」，
   * 于是整笔 operation 被误记成 COMMITTED 终态（回滚点随之失去 prune 豁免，事后审计读到与
   * 盘面相反的结论；测试专用那套编排对同一事件写的正是 ROLLED_BACK）。
   *
   * 上报后终态为 ROLLED_BACK；full === false（半回滚态）额外置 durable SAFE MODE，使下次启动
   * 不判 NORMAL。实现**不得抛错**：引擎此时正走「已回滚、正常 return」路径，抛错会把诚实的
   * 回滚报告换成异常。
   */
  recordRollback: (report: JournalRollbackOutcome) => Promise<void>;
}

/** 把环境锁分类映射到 startup 判定：ACQUIRED 视同 LOCKED（有活跃 owner），IO/PERMISSION 保守 LOCKED。 */
export function mapLockStateForStartup(state: LockState): 'LOCKED' | 'STALE_LOCK_DETECTED' | 'UNKNOWN_STATE' | 'FREE' {
  if (state === 'STALE_LOCK_DETECTED') return 'STALE_LOCK_DETECTED';
  if (state === 'UNKNOWN_STATE') return 'UNKNOWN_STATE';
  return 'LOCKED'; // ACQUIRED / LOCKED / LOCK_IO_ERROR / PERMISSION_ERROR → 保守 LOCKED
}

/* ------------------------------------------------------- SAFE MODE 标记 */

/**
 * 标记的**路径 / 内容判据 / 三态读取**唯一实现都在 `core/journal.ts`（标记的归属方）。
 * 本文件只 re-export，供宿主（src/index.ts）与 CLI 离线安全门沿用既有 import 路径。
 *
 * 审计 t26 收敛：此前这里自带一份 `/blocked|true/i` 判据 + 一份同步读取实现，与
 * `JournalStore.readSafeMode` 的第二份判据并存 —— 同一 marker 在「无法判定」场景下
 * 得出相反结论（一侧放行、一侧 fail-closed）。现在判定只有一处，谁改都不会漂移。
 */
export { isSafeModeMarkerBlocking, readSafeModeMarkerSync, safeModeMarkerPath } from './journal.ts';
export type { SafeModeMarkerState } from './journal.ts';

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

  /**
   * 最近一次 durable 标记判定的**三态**（t37）：'blocked' | 'clear' | 'unknown'。
   * 'unknown'（标记存在但无法判定 / 布局不可信 / 读不出）在 refreshSafeMode 与 startup 里按 fail-closed
   * 计入阻断，绝不再被压成「没有标记」；本字段供诊断与测试区分 unknown / clear。
   */
  private safeModeState: SafeModeMarkerState = 'clear';

  constructor(opts: Phase3RecoveryOptions) {
    this.dataDir = opts.dataDir;
    this.fingerprintDataDir = opts.fingerprintDataDir ?? opts.dataDir;
    this.store = new JournalStore({ transactionsDir: path.join(opts.dataDir, TRANSACTIONS_DIR) });
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

  /**
   * 刷新 SAFE MODE 标志（读 durable 标记）。
   *
   * t37：消费**三态**而不是 boolean 兼容面 —— 'blocked' 与 **'unknown'（标记存在但无法判定 / 布局
   * 不可信 / 读不出）** 一律置为阻断（fail-closed），只有 'clear'（确实没有标记）才解除。旧实现
   * `readSafeMode().catch(() => false)` 把「无法判定」读成「没有标记」，是 fail-open 外观。
   * 清理通道不变：用户显式 recovery → clearSafeMode() 写标记后本方法才回到 'clear'。
   */
  async refreshSafeMode(): Promise<void> {
    this.safeModeState = await this.store.readSafeModeState();
    this.safeModeActive = this.safeModeState !== 'clear';
  }

  /** 最近一次 durable 标记判定的三态（诊断/测试用；阻断判定只用 'blocked' 与 'unknown' 的 fail-closed 语义）。 */
  get lastSafeModeState(): SafeModeMarkerState {
    return this.safeModeState;
  }

  /** 同步探测 durable SAFE MODE 标记（宿主 apply() 同步阶段、scheduler.start() 前调用，保证先阻断）。 */
  probeSafeModeSync(): boolean {
    // 'unknown'（IO 失败 / 布局不可信）沿用既有宿主语义：不在此处提升为阻断（破坏性调度器另由 startup 分类
    // fail-closed）；CLI 离线门对 'unknown' 走 fail-closed，见 src/cli/index.ts checkSafeModeBlocked。
    // 与本文件 refreshSafeMode 的差异是**刻意的**：本方法是 apply() 同步阶段的 best-effort 早门，
    // 其后紧随 startup 分类（FAIL_CLOSED_STARTUP）兜住 unknown；refreshSafeMode 没有这道后续门，故 fail-closed。
    // 三态如实记入 lastSafeModeState，绝不在这里把 unknown 说成 clear。
    this.safeModeState = readSafeModeMarkerSync(this.dataDir);
    this.safeModeActive = this.safeModeState === 'blocked';
    return this.safeModeActive;
  }

  /** 保守 hooks：无法证明默认 needs-attention（绝不自动恢复/回滚）。snapshotExists 用宿主注入的正向校验（若提供）。 */
  private conservativeHooks(): ReconcileProbeHooks {
    const snapshotExists = this.snapshotExistsFn;
    return {
      // P2-B（Phase 8）：对带 afterFp/beforeFp 的本地文件 step 做真实磁盘指纹判定。
      // 这使「可安全判定已应用」的整文件项在 crash 后判 recovered；无指纹项（external /
      // before/after 均 null）→ unable（保守）。**不放松**「不可信/不可指纹 → needs-attention」边界。
      verifyStepFingerprint: async (step) => {
        if (step.external === true) return 'unable';
        if (step.beforeFp === null && step.afterFp === null) return 'unable';
        if (step.ref === '') return 'unable';
        let data: Buffer;
        try {
          data = await fs.readFile(step.ref);
        } catch {
          // 目标不存在：若已记录 afterFp（期望存在）→ 未应用；否则无法判定。
          return step.afterFp !== null && step.beforeFp === null ? 'before-match' : 'none';
        }
        const fp = sha256Hex(data);
        if (step.afterFp !== null && fp === step.afterFp) return 'after-match';
        if (step.beforeFp !== null && fp === step.beforeFp) return 'before-match';
        return 'none';
      },
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
   *
   * 审计 P0-10：本方法是 `classifyStartup`（core/startup-barrier.ts）的**等价薄包装**，当前**无任何**
   * 生产/测试调用点 —— 宿主 apply() 直接消费 `classifyStartup` 并按 `FAIL_CLOSED_STARTUP` 处置异常。
   * 保留仅为历史 API 兼容；新增启动路径必须走 core/startup-barrier.ts，不要在宿主/本类里再写第三份分类
   * 或第四份「只关调度器」的半套 fail-open。
   */
  async startup(lockState: LockState, expectedOwnershipInstanceId?: string | null): Promise<{ safeModeRequired: boolean; recoveryRequired: boolean }> {
    const env: ReconcileEnv = {
      environmentFingerprint: this.environmentFingerprint || 'unknown',
      isLiveOwner: async () => false,
      ...(expectedOwnershipInstanceId ? { expectedOwnershipInstanceId } : {}),
    };
    const insp = await inspectStartup(this.store, this.conservativeHooks(), env, {}, mapLockStateForStartup(lockState));
    // durable 标记三态如实记录（diagnostics）；阻断结论仍取聚合后的 safeModeRequired（含 unknown 的 fail-closed）
    this.safeModeState = insp.durableSafeState;
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

  /** 用户确认恢复后清除 SAFE MODE（清空 durable 标记 + 内存标志）。清理通道语义不变（t37）。 */
  async clearSafeMode(): Promise<void> {
    this.safeModeActive = false;
    this.safeModeState = 'clear';
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
    // 引擎上报的「已就地回滚」结论（见 buildJournalCtx 的 rollbackOutcome）：非 null 时终态是
    // ROLLED_BACK，绝不写 COMMITTED。绑定面（bindSnapshot / markApplying / recordStep /
    // recordRollback）统一由 buildJournalCtx 提供 —— runExternalIntent 共用同一份实现，
    // 两条通道的上报语义必须逐字一致（审计 P0-23）。
    const { ctx: journalCtx, rollbackOutcome } = this.buildJournalCtx(opId, operationType, ownerInstanceId);

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
      const rolledBack = rollbackOutcome.value;
      if (rolledBack !== null) {
        // 审计 P0-3：引擎在 fn 内部已就地回滚（导入失败整体回滚，返回 ok:false）——
        // 终态必须是 ROLLED_BACK，绝不是「fn 正常返回 ⇒ COMMITTED」。
        await this.recordRolledBackOutcome(opId, rolledBack);
        terminalPersistAttempted = true;
        if (!rolledBack.full) {
          // 半回滚态（有补偿失败项：凭据值不可回读、导入新建的 namespace 无删除语义…）→
          // 必须留下 durable 的可判定痕迹，使下次启动不判 NORMAL（审计 P0-3 验收②）。
          this.safeModeActive = true;
          await this.store.writeSafeMode(true).catch(() => undefined);
        }
        await this.store.moveToCompleted(opId).catch(() => undefined);
        return { operationId: opId, result };
      }
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
      const rolledBack = rollbackOutcome.value;
      if (rolledBack !== null) {
        // 引擎已就地回滚但随后抛错：终态仍是 ROLLED_BACK（既不伪造 COMMITTED，也不再叠加
        // NEEDS_ATTENTION —— 那会把「已知结论：已回滚」误报成「不可证明」）。
        await this.recordRolledBackOutcome(opId, rolledBack).catch(() => undefined);
        await this.store.moveToCompleted(opId).catch(() => undefined);
      } else if (fnCompleted && !terminalPersistAttempted) {
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
   * 把「引擎已就地回滚」写成 durable 终态 ROLLED_BACK（审计 P0-3）。
   *
   * 允许从任何 pre-terminal 状态收敛：CREATED/SNAPSHOT_CREATED → APPLYING → ROLLING_BACK →
   * ROLLED_BACK；已在 ROLLING_BACK / RECOVERING / NEEDS_ATTENTION 时直接收敛。每一步只在
   * **合法迁移**时执行，因此读到意外的中间态也不会抛错（抛错会把已知的回滚结论丢掉，并把
   * journal 留在非终态）。COMMITTED 在此不可达：它只由 fn 返回后的尾操作写入，而本方法
   * 只在该尾操作之前被调用。
   */
  private async recordRolledBackOutcome(opId: string, outcome: JournalRollbackOutcome): Promise<void> {
    await this.store.update(opId, (j) => {
      let next = j;
      const step = (to: JournalState): void => {
        if (isValidTransition(next.state, to)) next = transitionJournalState(next, to);
      };
      step('APPLYING');
      step('ROLLING_BACK');
      step('ROLLED_BACK');
      return {
        ...next,
        rollback: {
          ...next.rollback,
          attemptedAt: next.rollback.attemptedAt ?? new Date().toISOString(),
          full: outcome.full,
          failed: [...outcome.failed],
        },
      };
    });
  }

  /**
   * 构造一次 operation 的 journal 绑定面（runJournaled / runExternalIntent 共用）。
   *
   * 为什么必须共用：两条通道的上报语义要**逐字一致** —— 尤其是 `recordRollback`（审计 P0-3）：
   * 引擎在 fn 内部完成整体回滚后必须能被 journal 感知，否则「fn 正常返回 ⇒ COMMITTED」的尾操作
   * 会把一笔**已回滚**的 operation 记成成功。此前 runExternalIntent 只投递 `{ operationId }`，
   * 自动同步路径因此拿不到上报面，它的内部整体回滚被误记 COMMITTED（审计 P0-23）。
   *
   * 返回的 rollbackOutcome 用对象持有而非裸 let：赋值发生在 fn 内部的闭包里，TS 的控制流分析
   * 看不到那次写入，裸 let 会被窄化成 null → 读取处得到 never（编译报错）。
   */
  private buildJournalCtx(
    opId: string,
    operationType: string,
    ownerInstanceId: string,
  ): { ctx: JournalRunContext; rollbackOutcome: { value: JournalRollbackOutcome | null } } {
    const rollbackOutcome: { value: JournalRollbackOutcome | null } = { value: null };
    // Phase 4 deferred 模式：把 journal 绑定 API 暴露给 fn（引擎在第一个 destructive side effect 前调用）。
    // bindSnapshot：记录 snapshotId 并 CREATED→SNAPSHOT_CREATED；markApplying：SNAPSHOT_CREATED→APPLYING。
    // 这些只在该 op 的同一 journal 上生效，杜绝 process-global reentrancy。
    const ctx: JournalRunContext = {
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
      // P2-B（Phase 8）：逐计划项 WAL step 记录（文件类带 fp；非文件类 external=true）。
      // 与 bindSnapshot/markApplying 同一 fail-closed：持久化失败传播 → fn 抛错 → NEEDS_ATTENTION。
      recordStep: async (rec) => {
        const step: import('./journal.ts').JournalStep = {
          adapter: rec.adapter,
          ref: rec.ref,
          kind: rec.kind,
          external: rec.external === true,
          beforeFp: rec.beforeFp ?? null,
          afterFp: rec.afterFp ?? null,
          status: rec.status ?? (rec.external === true ? 'attention' : 'planned'),
          appliedAt: new Date().toISOString(),
          message: rec.message ?? null,
        };
        await this.store.update(opId, (j) => {
          const plannedSteps = j.plannedSteps.includes(rec.id)
            ? j.plannedSteps
            : [...j.plannedSteps, rec.id];
          return { ...j, plannedSteps, steps: { ...j.steps, [rec.id]: step } };
        });
      },
      recordRollback: async (report) => {
        const outcome: JournalRollbackOutcome = { full: report.full === true, failed: [...report.failed] };
        // 先记内存结论（终态判定只依赖它），再尽力把回滚报告 durable 落到 journal.rollback。
        // **不抛错**：调用方（导入引擎）此刻正走「已回滚、正常 return」路径，抛错会把诚实的
        // 回滚报告换成异常（HTTP 层从 200+报告 变成 500），而终态正确性已由内存结论保证。
        rollbackOutcome.value = outcome;
        await this.store.update(opId, (j) => ({
          ...j,
          rollback: {
            ...j.rollback,
            attemptedAt: j.rollback.attemptedAt ?? new Date().toISOString(),
            full: outcome.full,
            failed: [...outcome.failed],
          },
        })).catch(() => undefined);
      },
    };
    return { ctx, rollbackOutcome };
  }

  /**
   * 轻量 operation 包装（意图 journal，供外部/不可证明操作如 sync-push / autosync-apply / reinstall 用）：
   *   创建 CREATED → APPLYING（含 external intent step）→ 执行 → COMMITTED；异常 → NEEDS_ATTENTION + SAFE MODE。
   *
   * 审计 P0-23：fn 收到的上下文与 runJournaled **共用同一份绑定面**（含 `recordRollback`）。
   * 此前这里只投递 `{ operationId }`，自动同步的 applyMergePlan 因此拿不到上报面 —— 它在 fn
   * 内部完成整体回滚后正常返回，尾操作照样写 COMMITTED，把**已回滚**的 operation 记成成功。
   */
  async runExternalIntent<T>(opts: {
    operationType: string;
    lockCtx: MutationLockContext;
    intent: { adapter: string; ref: string; kind: string };
    fn: (ctx?: JournalRunContext) => Promise<T>;
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
    // 与 runJournaled 共用同一份绑定面（审计 P0-23）：fn 内部若已完成整体回滚，必须能经
    // recordRollback 上报，否则下面的尾操作会把已回滚的 operation 写成 COMMITTED。
    const { ctx: journalCtx, rollbackOutcome } = this.buildJournalCtx(opId, operationType, ownerInstanceId);
    try {
      await this.store.update(opId, (j) => {
        const extStep: import('./journal.ts').JournalStep = { adapter: intent.adapter, ref: intent.ref, kind: intent.kind, external: true, beforeFp: null, afterFp: null, status: 'planned', appliedAt: null };
        const withStep = {
          ...j, plannedSteps: ['ext'], steps: { ext: extStep },
        };
        return transitionJournalState(withStep, 'APPLYING');
      });
      // Phase 4 F29/F30：把绑定面暴露给 fn，使调用方（如 CLI reinstall / autosync-apply）能在首个
      // destructive side effect 前写 durably-bound recovery point，并在就地回滚后上报结论。
      const result = await fn(journalCtx);
      const rolledBack = rollbackOutcome.value;
      if (rolledBack !== null) {
        // 审计 P0-23：fn 内部已完成整体回滚 —— 终态必须是 ROLLED_BACK，绝不是
        // 「fn 正常返回 ⇒ COMMITTED」。本分支与 runJournaled 的同名分支语义逐字一致。
        await this.recordRolledBackOutcome(opId, rolledBack);
        if (!rolledBack.full) {
          // 半回滚态（存在补偿失败项）→ durable SAFE MODE，使下次启动不判 NORMAL（与导入路径一致）。
          this.safeModeActive = true;
          await this.store.writeSafeMode(true).catch(() => undefined);
        }
        await this.store.moveToCompleted(opId).catch(() => undefined);
        return { operationId: opId, result };
      }
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
      this.safeModeActive = true;
      await this.store.writeSafeMode(true).catch(() => undefined);
      const rolledBack = rollbackOutcome.value;
      if (rolledBack !== null) {
        // 引擎已就地回滚但随后抛错：终态仍是 ROLLED_BACK —— 不把「已知结论：已回滚」误报成
        // 「不可证明」的 NEEDS_ATTENTION（与 runJournaled 的同一分支同姿态）。
        await this.recordRolledBackOutcome(opId, rolledBack).catch(() => undefined);
        await this.store.moveToCompleted(opId).catch(() => undefined);
      } else {
        const j = await this.store.loadActive(opId);
        if (j !== null && !isTerminalState(j.state)) {
          await this.store.update(opId, (cur) => transitionJournalState(cur, 'NEEDS_ATTENTION')).catch(() => undefined);
        }
      }
      throw err;
    }
  }
}
