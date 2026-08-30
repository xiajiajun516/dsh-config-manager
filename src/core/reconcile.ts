/**
 * Reconciler（Phase 3：startup reconciliation）。
 *
 * 职责：扫描 active journals → parse/schema 校验（corrupt 隔离）→ 验 environment fingerprint
 * → 验 Journal→Lock 绑定 → 验快照 → 验 step 指纹 → 外部探测 → 选择推荐 recovery outcome
 * → 执行（需用户确认的破坏性动作才执行）→ recovery-history → 幂等。
 *
 * **Reconciler 不拥有 Environment Lock primitive 实现** —— 通过 Coordinator/port 使用
 * （release、active≤1、recover 显式流程由宿主/Coordinator 编排）。
 *
 * **Startup（Rev 3 P1-NEW-2）不自动 recover stale lock**：
 *  - 若发现 stale lock + incomplete journal → RECOVERY_REQUIRED / SAFE MODE，不自动 recoverStaleLock；
 *  - 用户显式确认后才 prove stale → recover → acquire → reconcile。
 */
import {
  JournalStore, isTerminalState, transitionJournalState, JOURNAL_SCHEMA_VERSION,
  type OperationJournal, type JournalStep,
} from './journal.ts';

// ---------- 注入 hooks（引擎/宿主具体化） ----------

export type StepFingerprintVerdict =
  | 'before-match'      // 磁盘 == side effect 前 → 未应用
  | 'after-match'       // 磁盘 == afterFp → 已应用
  | 'none'              // 与 before/after 都不符 → 混合/未知
  | 'unable';           // 不可指纹（settings/patchLine/workspace）

export type ExternalProbe =
  | 'installed' | 'half-installed' | 'reverse-residue' | 'not-installed' | 'unknown';

export interface ReconcileProbeHooks {
  /** 对某 step 的目标做磁盘指纹判定。 */
  verifyStepFingerprint(step: JournalStep): Promise<StepFingerprintVerdict>;
  /** 外部步骤（插件/Git/WebDAV）状态探测。 */
  probeExternal(step: JournalStep): Promise<ExternalProbe>;
  /**
   * 快照完整性（id 合法 + snapshot.json 存在 + 必要 blobs 存在 + READY + 属于本 op）。
   * binding 为 journal 的绑定字段（operationId/ownerInstanceId/environmentFingerprint），
   * 实现应校验 snapshot 的 manifest binding 与 journal 一致（P1-1：防伪造快照过 snapshotExists）。
   */
  snapshotExists(
    snapshotId: string | null,
    binding?: { operationId?: string; ownerInstanceId?: string; environmentFingerprint?: string },
  ): Promise<boolean>;
}

export interface ReconcileEnv {
  environmentFingerprint: string;
  /** 判定某 journal 是否属于仍存活的 live owner（live op 不可 reconcile/quarantine/move）。 */
  isLiveOwner(journal: OperationJournal): boolean | Promise<boolean>;
  /**
   * P1-A：期望的 crashed-ownership instanceId（= stale environment.lock owner.instanceId）。
   * 显式 recovery 捕获 stale ownership 证据后传入：active journal 的 ownerInstanceId/lockId
   * 必须匹配该 crashed ownership，才可作为 trusted transaction 参与 reconcile/rollback/resume；
   * 否则 → needs-attention（SAFE MODE，不 trusted），防跨 transaction/伪造 journal。
   */
  expectedOwnershipInstanceId?: string;
}

export interface ReconcileOptions {
  /** 是否自动隔离 corrupt journal（move 到 quarantine + attention sidecar）。默认 true。 */
  autoQuarantine?: boolean;
  /** 是否对 terminal-in-active journal 自动 move 到 completed。默认 true。 */
  organizeTerminal?: boolean;
}

export type ReconcileDecisionKind =
  | 'live'                // 活 owner 持有，跳过
  | 'corrupt'             // 无法 parse / 非法 schema → quarantine（已隔离）
  | 'env-mismatch'        // environmentFingerprint 不符 → 不恢复
  | 'organized'           // terminal 遗留 active → 已规整到 completed（无实际 recovery）
  | 'recovered'           // 所有 step 已 prove done → 视同 commit（resume 不需重做）
  | 'noop'                // 无任何 step 应用 + 无快照可回滚 → 安全丢弃
  | 'rollback-recommended'// 可安全回滚（快照有效）→ 需用户确认后才执行
  | 'rollback-continue'   // 回滚中断（ROLLING_BACK/部分 entryDone）→ 需用户确认续跑，绝不判 recovered
  | 'needs-attention'     // 不可证明（external / 不可指纹 / 快照缺失 / 冲突）→ SAFE MODE，等用户确认

export interface ReconcileDecision {
  operationId: string;
  kind: ReconcileDecisionKind;
  reason: string;
  snapshotId: string | null;
}

/** 汇总结果：是否该进入 SAFE MODE（任一 needs-attention / env-mismatch / corrupt / rollback-recommended）。 */
export interface ReconcileOutcome {
  decisions: ReconcileDecision[];
  safeModeRequired: boolean;
  /** unresolved（未到 terminal）的 incomplete op id（RECOVERY_REQUIRED 候选）。 */
  unresolved: string[];
}

// ---------- Reconcile ----------

/**
 * 分析 active/ 下的所有 journal，返回每个 op 的决策 + 是否需 SAFE MODE。
 * 只读（除 corrupt quarantine 与 terminal organize / recovery-history 外，不做 data mutation）。
 */
export async function reconcileActive(
  store: JournalStore,
  hooks: ReconcileProbeHooks,
  env: ReconcileEnv,
  opts: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const decisions: ReconcileDecision[] = [];
  const unresolved: string[] = [];
  let safeModeRequired = false;

  const activeIds = await store.scanActive();
  for (const operationId of activeIds) {
    const outcome = await reconcileOne(store, hooks, env, opts, operationId);
    decisions.push(outcome.decision);
    if (outcome.safeMode) safeModeRequired = true;
    if (outcome.unresolved) unresolved.push(operationId);
  }
  return { decisions, safeModeRequired, unresolved };
}

async function reconcileOne(
  store: JournalStore,
  hooks: ReconcileProbeHooks,
  env: ReconcileEnv,
  opts: ReconcileOptions,
  operationId: string,
): Promise<{ decision: ReconcileDecision; safeMode: boolean; unresolved: boolean }> {
  const j = await store.loadActive(operationId);
  if (j === null) {
    // 存在但 parse/校验失败 → corrupt → quarantine
    const reason = `journal ${operationId} 无法解析或 schema 非法（隔离处理）`;
    if (opts.autoQuarantine !== false) {
      try {
        await store.quarantine(operationId, reason);
      } catch { /* 隔离失败由上层诊断 */ }
    }
    await store.writeSafeMode(true).catch(() => undefined);
    return { decision: { operationId, kind: 'corrupt', reason, snapshotId: null }, safeMode: true, unresolved: true };
  }

  // live owner 检查
  if (await env.isLiveOwner(j)) {
    return { decision: { operationId, kind: 'live', reason: 'owner 存活，live operation 进行中', snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  // P1-A：ownership binding 强制校验（显式 recovery 捕获的 crashed ownership 证据）。
  // journal.ownerInstanceId/lockId 必须匹配期望的 crashed ownership instanceId，否则不作 trusted 恢复。
  if (env.expectedOwnershipInstanceId !== undefined && env.expectedOwnershipInstanceId !== '') {
    const bindingOk = j.ownerInstanceId === env.expectedOwnershipInstanceId
      && j.lockId === env.expectedOwnershipInstanceId; // lockId = 同 epoch identity（ownerInstanceId）
    if (!bindingOk) {
      const reason = `ownership binding 不匹配（journal.ownerInstanceId/lockId 非 crashed ownership ${env.expectedOwnershipInstanceId}），不作 trusted 恢复`;
      await store.writeSafeMode(true).catch(() => undefined);
      await store.appendRecoveryHistory('binding-mismatch', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
      return { decision: { operationId, kind: 'needs-attention', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
  }

  // env fingerprint
  if (env.environmentFingerprint && j.environmentFingerprint && env.environmentFingerprint !== j.environmentFingerprint) {
    const reason = `environment fingerprint 不匹配（跨机/环境变化），不自动恢复`;
    await store.writeSafeMode(true).catch(() => undefined);
    return { decision: { operationId, kind: 'env-mismatch', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // terminal 遗留 active → 规整到 completed（无实质 recovery）
  if (isTerminalState(j.state)) {
    if (j.state === 'NEEDS_ATTENTION') {
      // NEEDS_ATTENTION 是「待用户确认」状态，保持 active 可见（不静默规整），SAFE MODE
      await store.writeSafeMode(true).catch(() => undefined);
      return { decision: { operationId, kind: 'needs-attention', reason: 'NEEDS_ATTENTION 待用户确认', snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
    // COMMITTED / ROLLED_BACK / RECOVERED 遗留 → 规整
    if (opts.organizeTerminal !== false) {
      try { await store.moveToCompleted(operationId); } catch { /* move 失败不影响 */ }
    }
    return { decision: { operationId, kind: 'organized', reason: `terminal(${j.state}) journal 规整到 completed`, snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  // 回滚进行中（ROLLING_BACK）或已部分补偿（entryDone 非空）：**绝不判 RECOVERED**
  // （P0-B：崩溃在回滚中 = 半回滚态，判 recovered 会把破坏状态误报为成功）。
  if (j.state === 'ROLLING_BACK' || Object.keys(j.rollback.entryDone ?? {}).length > 0) {
    const reason = `回滚中断（${j.state === 'ROLLING_BACK' ? 'ROLLING_BACK' : `entryDone ${Object.keys(j.rollback.entryDone).join(',')}`}），需显式续跑回滚（用户确认）`;
    await store.writeSafeMode(true).catch(() => undefined);
    await store.appendRecoveryHistory('rollback-interrupted', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
    return { decision: { operationId, kind: 'rollback-continue', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // incomplete：判定 steps
  const stepIds = [...new Set([...j.plannedSteps, ...Object.keys(j.steps)])];
  let anyApplied = false;
  let allDoneConfirmed = true;
  let anyUnprovable = false;
  let anyExternalUnknown = false;
  const details: string[] = [];

  for (const stepId of stepIds) {
    const step = j.steps[stepId];
    const plannedExternal = step?.external === true;
    if (step === undefined) {
      // Review D P2：plannedSteps 引用悬空（steps 缺条目）→ 不可证明，绝不能经 noop 判 RECOVERED。
      anyUnprovable = true;
      allDoneConfirmed = false;
      details.push(`planned step ${stepId} 缺少 steps 条目（损坏/篡改 journal）`);
      continue;
    }

    if (plannedExternal) {
      // 外部 step：probe 判定
      const probe = await hooks.probeExternal(step);
      if (probe === 'installed') { anyApplied = true; continue; }
      if (probe === 'not-installed') { continue; } // 未装，无副作用
      // half-installed / reverse-residue / unknown → 不可证明
      anyExternalUnknown = true;
      anyUnprovable = true;
      allDoneConfirmed = false;
      details.push(`external ${step.kind} ${step.ref}: ${probe}`);
      continue;
    }

    // 本地 step：指纹判定
    if (step.status === 'done') {
      // 即使 done 也重验 afterFp（Windows rename 顺序失效）
      let verdict: StepFingerprintVerdict;
      try { verdict = await hooks.verifyStepFingerprint(step); } catch { verdict = 'unable'; }
      if (verdict === 'after-match') { anyApplied = true; continue; }
      if (verdict === 'before-match') { anyApplied = false; details.push(`step ${step.ref} 未可靠完成（磁盘==before）`); allDoneConfirmed = false; anyUnprovable = true; continue; }
      anyUnprovable = true; allDoneConfirmed = false;
      details.push(`step ${step.ref} 指纹 ${verdict}`);
    } else {
      // planned/attention/failed → 未完成
      allDoneConfirmed = false;
      if (step.status === 'attention' || step.status === 'failed') { anyUnprovable = true; details.push(`step ${step.ref} ${step.status}`); }
      else { // planned：指纹判定 side effect 是否发生
        let verdict: StepFingerprintVerdict;
        try { verdict = await hooks.verifyStepFingerprint(step); } catch { verdict = 'unable'; }
        if (verdict === 'after-match') { anyApplied = true; }
        else if (verdict === 'before-match') { /* 未应用，安全 */ }
        else { anyUnprovable = true; anyApplied = anyApplied || verdict === 'none'; details.push(`step ${step.ref} ${verdict}`); }
      }
    }
  }

  const snapshotExists = await hooks.snapshotExists(j.snapshotId, {
    operationId: j.operationId,
    ownerInstanceId: j.ownerInstanceId,
    environmentFingerprint: j.environmentFingerprint,
  });

  // F20 修复：空 steps（opaque intent journal）不得因 [].every() 真空真而判 RECOVERED。
  // 若 mutation 是否执行无法证明 → NEEDS_ATTENTION；若有 trusted bound snapshot → rollback-recommended。
  if (stepIds.length === 0) {
    // CREATED / SNAPSHOT_CREATED：mutation 尚未开始 → 安全 no-op
    if (j.state === 'CREATED' || j.state === 'SNAPSHOT_CREATED') {
      await store.update(operationId, (cur) => {
        let next = transitionJournalState(cur, 'RECOVERED');
        next = { ...next, recovery: { ...next.recovery, attemptedAt: new Date().toISOString(), outcome: 'RECOVERED', reason: 'no mutation started (empty steps, pre-APPLYING)', attempts: next.recovery.attempts + 1 } };
        return next;
      });
      await store.moveToCompleted(operationId).catch(() => undefined);
      await store.appendRecoveryHistory('noop', { operationId, at: new Date().toISOString(), reason: 'no mutation started' }).catch(() => undefined);
      return { decision: { operationId, kind: 'noop', reason: 'mutation 未开始，安全完成', snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
    }
    // APPLYING（或其它非 terminal）：mutation 可能已开始，无法证明
    if (j.snapshotId !== null && snapshotExists) {
      // 有 trusted bound snapshot → rollback-recommended（需用户确认）
      await store.writeSafeMode(true).catch(() => undefined);
      const reason = 'opaque APPLYING（空 steps）且 mutation 可能已开始，有 trusted snapshot 可回滚（需用户确认）';
      await store.update(operationId, (cur) => {
        let next = transitionJournalState(cur, 'NEEDS_ATTENTION');
        next = { ...next, error: next.error || reason, recovery: { ...next.recovery, reason, attempts: next.recovery.attempts + 1 } };
        return next;
      }).catch(() => undefined);
      await store.appendRecoveryHistory('needs-attention', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
      return { decision: { operationId, kind: 'rollback-recommended', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
    // 无 trusted snapshot → NEEDS_ATTENTION（SAFE MODE）
    await store.writeSafeMode(true).catch(() => undefined);
    const reason = 'opaque APPLYING（空 steps）且 mutation 可能已开始，无 trusted snapshot 可回滚';
    await store.update(operationId, (cur) => {
      let next = transitionJournalState(cur, 'NEEDS_ATTENTION');
      next = { ...next, error: next.error || reason, recovery: { ...next.recovery, reason, attempts: next.recovery.attempts + 1 } };
      return next;
    }).catch(() => undefined);
    await store.appendRecoveryHistory('needs-attention', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
    return { decision: { operationId, kind: 'needs-attention', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // 决策
  if (allDoneConfirmed && !anyUnprovable) {
    // 所有 step 已 prove done → resume（RECOVERED），不重做
    await store.update(operationId, (cur) => {
      let next = transitionJournalState(cur, 'RECOVERED');
      next = { ...next, recovery: { ...next.recovery, attemptedAt: new Date().toISOString(), outcome: 'RECOVERED', reason: 'all steps confirmed done', attempts: next.recovery.attempts + 1 } };
      return next;
    });
    await store.moveToCompleted(operationId).catch(() => undefined);
    await store.appendRecoveryHistory('recovered', { operationId, at: new Date().toISOString(), reason: 'all steps proven done' }).catch(() => undefined);
    return { decision: { operationId, kind: 'recovered', reason: 'all steps proven applied', snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  if (!anyApplied && !anyUnprovable) {
    // 无任何 step 应用（全 beforeFp / all planned）＋ 无外部/不可指纹 → no-op 安全丢弃
    await store.update(operationId, (cur) => {
      let next = transitionJournalState(cur, 'RECOVERED');
      next = { ...next, recovery: { ...next.recovery, attemptedAt: new Date().toISOString(), outcome: 'RECOVERED', reason: 'no step applied', attempts: next.recovery.attempts + 1 } };
      return next;
    });
    await store.moveToCompleted(operationId).catch(() => undefined);
    await store.appendRecoveryHistory('noop', { operationId, at: new Date().toISOString(), reason: 'no step applied' }).catch(() => undefined);
    return { decision: { operationId, kind: 'noop', reason: '无副作用可恢复，安全完成', snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  if (anyUnprovable || anyExternalUnknown || !snapshotExists) {
    // 不可证明 / 外部未知 / 快照缺失 → NEEDS_ATTENTION（SAFE MODE）
    await store.writeSafeMode(true).catch(() => undefined);
    const reason = `不可证明步骤: ${details.join('; ') || '外部副作用未知'}` + (snapshotExists ? '' : '；快照缺失');
    await store.update(operationId, (cur) => {
      let next = transitionJournalState(cur, 'NEEDS_ATTENTION');
      next = { ...next, error: next.error || reason, recovery: { ...next.recovery, reason, attempts: next.recovery.attempts + 1 } };
      return next;
    }).catch(() => undefined);
    await store.appendRecoveryHistory('needs-attention', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
    return { decision: { operationId, kind: 'needs-attention', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // 快照有效 + 已应用部分 + 无不可证明 → rollback 可安全执行（需用户确认）
  await store.writeSafeMode(true).catch(() => undefined);
  const reason = '部分 step 已应用，可安全回滚（需用户确认）';
  return { decision: { operationId, kind: 'rollback-recommended', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
}

// ---------- 执行（用户确认后） ----------

export interface RecoveryExecutorInput {
  operationId: string;
  action: 'rollback' | 'resume' | 'dismiss';
  snapshotId: string | null;
}

/** 执行恢复（破坏性动作必须 userConfirm=true 才执行）。 */
export interface RecoveryExecutorInput {
  operationId: string;
  action: 'rollback' | 'resume' | 'dismiss';
  snapshotId: string | null;
  /** 宿主注入的实际回滚执行器（破坏性副作用由宿主/Coordinator 执行，此处只做 journal 终态）。 */
  performRollback?: (snapshotId: string) => Promise<{ full: boolean; failed: string[] }>;
}

export async function executeRecovery(
  store: JournalStore,
  input: RecoveryExecutorInput,
  userConfirmed: boolean,
): Promise<'done' | 'needs-confirmation' | 'failed'> {
  const j = await store.loadActive(input.operationId);
  if (j === null) return 'failed'; // 不再 active（已处理/隔离）

  if (input.action === 'resume') {
    // resume 不重做已完成副作用：标记 RECOVERED + move
    await store.update(input.operationId, (cur) => {
      let next = cur.state === 'RECOVERED' ? cur : transitionJournalState(cur, 'RECOVERED');
      next = { ...next, recovery: { ...next.recovery, attemptedAt: new Date().toISOString(), outcome: 'RECOVERED', reason: 'user resume' } };
      return next;
    });
    await store.moveToCompleted(input.operationId).catch(() => undefined);
    return 'done';
  }

  if (input.action === 'rollback') {
    if (!userConfirmed) return 'needs-confirmation'; // 普通 metadata 不是 destructive 授权
    if (input.snapshotId === null) return 'failed'; // 无有效快照不可回滚
    if (input.performRollback === undefined) return 'failed';
    // 先推进 ROLLING_BACK（若当前允许），再 ROLLED_BACK（crash-during-rollback 续跑也稳）
    await store.update(input.operationId, (cur) => {
      if (cur.state === 'ROLLING_BACK') return cur;
      if (['CREATED', 'SNAPSHOT_CREATED', 'APPLYING', 'VALIDATING', 'RECOVERING', 'NEEDS_ATTENTION'].includes(cur.state)) {
        return transitionJournalState(cur, 'ROLLING_BACK');
      }
      return cur;
    }).catch(() => undefined);
    const report = await input.performRollback(input.snapshotId);
    await store.update(input.operationId, (cur) => {
      let next = transitionJournalState(cur, 'ROLLED_BACK');
      next = { ...next, rollback: { ...next.rollback, full: report.full, failed: report.failed } };
      return next;
    });
    await store.moveToCompleted(input.operationId).catch(() => undefined);
    return 'done';
  }

  // dismiss（quarantine & dismiss）：移出 active，不视为恢复（用户显式放弃）
  if (!userConfirmed) return 'needs-confirmation';
  await store.quarantine(input.operationId, 'user dismissed').catch(() => undefined);
  return 'done';
}

// ---------- startup 只读判定（不自动 recover stale lock） ----------

export interface StartupInspection {
  safeModeRequired: boolean;
  recoveryRequired: boolean;
  decisions: ReconcileDecision[];
  unresolved: string[];
}

/**
 * Startup 只读事务状态 + 锁状态扫描（Rev 3 P1-NEW-2）：
 * 只检测、只读；**不自动 recoverStaleLock、不自动 create journal**。
 * lockState: 'LOCKED' | 'STALE_LOCK_DETECTED' | 'UNKNOWN_STATE' | 'FREE'
 */
export async function inspectStartup(
  store: JournalStore,
  hooks: ReconcileProbeHooks,
  env: ReconcileEnv,
  opts: ReconcileOptions,
  lockState: 'LOCKED' | 'STALE_LOCK_DETECTED' | 'UNKNOWN_STATE' | 'FREE',
): Promise<StartupInspection> {
  // 锁为 LOCKED（fresh heartbeat，活跃 owner）→ 任何 incomplete journal 皆视为 live op，不 reconcile/quarantine/move；
  // 仅 STALE / UNKNOWN / FREE 时才对 journal 做 recover 判定（修 isLiveOwner 并发误判，§18）。
  // 注意：此处用 `||`（不能 `&&`——env.isLiveOwner 在保守 hooks 下恒 false，`LOCKED && false` 会让 live 分支永不到达）。
  const envWithLive = {
    ...env,
    isLiveOwner: async (j: OperationJournal) => lockState === 'LOCKED' || (await env.isLiveOwner(j)),
  };
  const outcome = await reconcileActive(store, hooks, envWithLive, { ...opts, organizeTerminal: true });
  const hasIncomplete = outcome.unresolved.length > 0;

  let recoveryRequired = false;
  if (hasIncomplete && (lockState === 'STALE_LOCK_DETECTED' || lockState === 'UNKNOWN_STATE')) {
    recoveryRequired = true;
    await store.writeSafeMode(true).catch(() => undefined);
  }
  // 读 durable SAFE MODE 标记（跨重启保持阻断）：即使 active 已规整，标记在则仍须阻断
  const durableSafe = await store.readSafeMode().catch(() => false);
  const safeModeRequired = outcome.safeModeRequired || recoveryRequired || durableSafe;
  return { safeModeRequired, recoveryRequired, decisions: outcome.decisions, unresolved: outcome.unresolved };
}
