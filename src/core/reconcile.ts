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
import { engineMsg } from './messages-core.ts';
import {
  JournalStore, isTerminalState, transitionJournalState,
  type OperationJournal, type JournalStep, type SafeModeMarkerState,
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

/**
 * **唯一**被放行的 operationType（issue #87）：定时备份。
 *
 * 为什么只放行它：它整条链路**不可能改用户配置** —— backup-scheduler 的 `doExport` 只做三件事：
 * 往 `<dataDir>/exports/` 写一个归档 zip、写插件自身的调度状态文件、按保留策略删旧 auto 归档
 * （src/sync/backup-scheduler.ts）。因此「崩溃前到底跑没跑到」这个不可判定问题，对**用户配置是否半成品**
 * 完全无关紧要 —— 那才是 SAFE MODE 要防的东西。
 *
 * **其它 operationType 一律不得套用**：`autosync-apply` / `import-apply` 之类会真的改用户配置，
 * 它们「已开始但未登记 step」永远不可证明，必须留在原保守路径（NEEDS_ATTENTION + SAFE MODE）。
 */
const ARTIFACT_ONLY_OPERATION_TYPES: ReadonlySet<string> = new Set<string>(['backup-schedule'])

/** 可自证「不可能掩盖半成品配置改动」的残留类型（issue #87）。 */
export type SelfProvableResidualClass = 'artifact-only' | 'no-steps'

/**
 * 判定崩溃残留是否**可自证**「没发生」（issue #87）；不可自证 → null，走原保守路径。
 *
 * 只回答一个问题：这次残留有没有可能掩盖「半成品用户配置改动」？只放行 artifact-only 通道的两类形状 ——
 *  - `no-steps`：一个 step 都没登记。该通道（core/phase3-host.ts runExternalIntent）在调用 `fn` **之前**
 *    就把 external step 落进 journal，没有 step ⇒ `fn` 从未开始 ⇒ 连归档都没产出；
 *  - `artifact-only`：有 step 且全是 external backup（形状与 runExternalIntent 写的 ext step 逐字一致）。
 *
 * 形状门缺一不可：state ∈ {APPLYING, NEEDS_ATTENTION}、无 snapshotId、`commit.at` 为空、
 * rollback 未尝试且无已补偿条目、recovery 未尝试、所有 step 都是 `planned` 且 `appliedAt` 为空。
 * ownership / environmentFingerprint 绑定校验由调用方在**更早**的信任门完成，这里不重复也不放松。
 */
function selfProvableResidual(j: OperationJournal): { cls: SelfProvableResidualClass; reason: string } | null {
  if (!ARTIFACT_ONLY_OPERATION_TYPES.has(j.operationType)) return null
  if (j.state !== 'APPLYING' && j.state !== 'NEEDS_ATTENTION') return null
  if (j.snapshotId !== null && j.snapshotId !== '') return null
  if (j.commit.at !== null) return null
  if (j.rollback.attemptedAt !== null) return null
  if (Object.keys(j.rollback.entryDone ?? {}).length > 0) return null
  if (j.recovery.attemptedAt !== null) return null
  const steps = Object.values(j.steps)
  if (steps.some((s) => s.status !== 'planned' || s.appliedAt !== null)) return null

  if (steps.length === 0) {
    if (j.plannedSteps.length > 0) return null // 悬空 plannedSteps：损坏/篡改 → 保守
    return { cls: 'no-steps', reason: engineMsg('core.reconcile.selfProvenNoSteps') }
  }
  if (steps.every((s) => s.external === true && s.adapter === 'backup')) {
    return { cls: 'artifact-only', reason: engineMsg('core.reconcile.selfProvenArtifactOnly') }
  }
  return null
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
    const reason = engineMsg('core.reconcile.journalUnparsable', { opId: operationId });
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
    return { decision: { operationId, kind: 'live', reason: engineMsg('core.reconcile.ownerLive'), snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  // P1-A：ownership binding 强制校验（显式 recovery 捕获的 crashed ownership 证据）。
  // journal.ownerInstanceId/lockId 必须匹配期望的 crashed ownership instanceId，否则不作 trusted 恢复。
  if (env.expectedOwnershipInstanceId !== undefined && env.expectedOwnershipInstanceId !== '') {
    const bindingOk = j.ownerInstanceId === env.expectedOwnershipInstanceId
      && j.lockId === env.expectedOwnershipInstanceId; // lockId = 同 epoch identity（ownerInstanceId）
    if (!bindingOk) {
      const reason = engineMsg('core.reconcile.bindingMismatch', { instanceId: env.expectedOwnershipInstanceId });
      await store.writeSafeMode(true).catch(() => undefined);
      await store.appendRecoveryHistory('binding-mismatch', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
      return { decision: { operationId, kind: 'needs-attention', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
  }

  // env fingerprint
  if (env.environmentFingerprint && j.environmentFingerprint && env.environmentFingerprint !== j.environmentFingerprint) {
    const reason = engineMsg('core.reconcile.envMismatch');
    await store.writeSafeMode(true).catch(() => undefined);
    return { decision: { operationId, kind: 'env-mismatch', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // issue #87：自证「没发生」的残留自动放行（APPLYING/NEEDS_ATTENTION → RECOVERED，history = noop）。
  // 位置刻意放在 live-owner / ownership-binding / env-fingerprint 三道信任门**之后**、terminal 与步态判定
  // **之前**：只有已通过全部绑定校验、且形状证明副作用不可能已开始的残留才会走到这里；其余一律落回原保守路径。
  const residual = selfProvableResidual(j)
  if (residual !== null) {
    const reason = residual.reason
    await store.update(operationId, (cur) => {
      let next = transitionJournalState(cur, 'RECOVERED')
      next = { ...next, recovery: { ...next.recovery, attemptedAt: new Date().toISOString(), outcome: 'RECOVERED', reason, attempts: next.recovery.attempts + 1 } }
      return next
    })
    await store.moveToCompleted(operationId).catch(() => undefined)
    await store.appendRecoveryHistory('noop', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined)
    return { decision: { operationId, kind: 'noop', reason, snapshotId: j.snapshotId }, safeMode: false, unresolved: false }
  }

  // terminal 遗留 active → 规整到 completed（无实质 recovery）
  if (isTerminalState(j.state)) {
    if (j.state === 'NEEDS_ATTENTION') {
      // NEEDS_ATTENTION 是「待用户确认」状态，保持 active 可见（不静默规整），SAFE MODE
      await store.writeSafeMode(true).catch(() => undefined);
      return { decision: { operationId, kind: 'needs-attention', reason: engineMsg('core.reconcile.needsAttentionConfirm'), snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
    // COMMITTED / ROLLED_BACK / RECOVERED 遗留 → 规整
    if (opts.organizeTerminal !== false) {
      try { await store.moveToCompleted(operationId); } catch { /* move 失败不影响 */ }
    }
    return { decision: { operationId, kind: 'organized', reason: engineMsg('core.reconcile.terminalOrganized', { state: j.state }), snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  // 回滚进行中（ROLLING_BACK）或已部分补偿（entryDone 非空）：**绝不判 RECOVERED**
  // （P0-B：崩溃在回滚中 = 半回滚态，判 recovered 会把破坏状态误报为成功）。
  if (j.state === 'ROLLING_BACK' || Object.keys(j.rollback.entryDone ?? {}).length > 0) {
    const rollbackDetail = j.state === 'ROLLING_BACK' ? 'ROLLING_BACK' : `entryDone ${Object.keys(j.rollback.entryDone).join(',')}`;
    const reason = engineMsg('core.reconcile.rollbackInterrupted', { detail: rollbackDetail });
    await store.writeSafeMode(true).catch(() => undefined);
    await store.appendRecoveryHistory('rollback-interrupted', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
    return { decision: { operationId, kind: 'rollback-continue', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
  }

  // §6.5 recovery hard gate（Reviewer A P0 + 第三轮 P2 收紧）：
  // 置于 entryDone/回滚中断检查（:180）之后、step 指纹判定（:187）之前。
  // RECOVERING +（无 recoveryVerification 或 verdict 非 MATCH/PARTIAL_MATCH）→ needs-attention，
  // **绝不自动判 RECOVERED**（VERIFIED 不变量：恢复未验证不得视为完成）。
  // 只有 recoveryVerification.verdict === 'MATCH' | 'PARTIAL_MATCH' 的 RECOVERING journal
  // 才可转 ROLLED_BACK / RECOVERED（该终态迁移由 verify 路由以单次原子 journal update 完成）。
  if (j.state === 'RECOVERING') {
    const v = j.recoveryVerification;
    const verified = v !== undefined && (v.verdict === 'MATCH' || v.verdict === 'PARTIAL_MATCH');
    if (!verified) {
      const reason = engineMsg('core.reconcile.recoveringUnverified');
      await store.writeSafeMode(true).catch(() => undefined);
      await store.update(operationId, (cur) => {
        let next = transitionJournalState(cur, 'NEEDS_ATTENTION');
        next = { ...next, error: next.error || reason, recovery: { ...next.recovery, reason, attempts: next.recovery.attempts + 1 } };
        return next;
      }).catch(() => undefined);
      await store.appendRecoveryHistory('recovery-unverified', { operationId, at: new Date().toISOString(), reason }).catch(() => undefined);
      return { decision: { operationId, kind: 'needs-attention', reason, snapshotId: j.snapshotId }, safeMode: true, unresolved: true };
    }
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
      details.push(engineMsg('core.reconcile.danglingPlannedStep', { stepId }));
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
      if (verdict === 'before-match') { anyApplied = false; details.push(engineMsg('core.reconcile.stepNotReliablyDone', { ref: step.ref })); allDoneConfirmed = false; anyUnprovable = true; continue; }
      anyUnprovable = true; allDoneConfirmed = false;
      details.push(engineMsg('core.reconcile.stepFingerprint', { ref: step.ref, verdict }));
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
      return { decision: { operationId, kind: 'noop', reason: engineMsg('core.reconcile.mutationNotStarted'), snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
    }
    // APPLYING（或其它非 terminal）：mutation 可能已开始，无法证明
    if (j.snapshotId !== null && snapshotExists) {
      // 有 trusted bound snapshot → rollback-recommended（需用户确认）
      await store.writeSafeMode(true).catch(() => undefined);
      const reason = engineMsg('core.reconcile.opaqueRollbackAvailable');
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
    const reason = engineMsg('core.reconcile.opaqueNoSnapshot');
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
    return { decision: { operationId, kind: 'noop', reason: engineMsg('core.reconcile.noSideEffects'), snapshotId: j.snapshotId }, safeMode: false, unresolved: false };
  }

  if (anyUnprovable || anyExternalUnknown || !snapshotExists) {
    // 不可证明 / 外部未知 / 快照缺失 → NEEDS_ATTENTION（SAFE MODE）
    await store.writeSafeMode(true).catch(() => undefined);
    const reason = engineMsg('core.reconcile.unprovableSteps', { details: details.join('; ') || engineMsg('core.reconcile.externalSideEffectsUnknown') })
      + (snapshotExists ? '' : engineMsg('core.reconcile.snapshotMissingSuffix'));
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
  const reason = engineMsg('core.reconcile.partialApplied');
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
  /**
   * 恢复决策（§5.2 引擎映射）：rollback-recommended → restore executor（恢复到 trusted snapshot）；
   * rollback-continue → rollback executor（续跑中断回滚）。缺省 = rollback-continue（兼容旧调用）。
   */
  decision?: 'rollback-recommended' | 'rollback-continue';
  /** 宿主注入的实际回滚执行器（rollback-continue：续跑中断回滚；破坏性副作用由宿主/Coordinator 执行）。 */
  performRollback?: (snapshotId: string) => Promise<{ full: boolean; failed: string[] }>;
  /** 宿主注入的 restore 执行器（rollback-recommended：恢复到 trusted snapshot）。 */
  performRestore?: (snapshotId: string) => Promise<{ full: boolean; failed: string[] }>;
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
    // §11.2：execute 仅接受 NEEDS_ATTENTION（confirm 后）或 RECOVERING（retry 续跑）；terminal 拒绝 replay。
    if (j.state !== 'NEEDS_ATTENTION' && j.state !== 'RECOVERING') return 'failed';
    // §5.2 引擎映射：rollback-recommended → restore executor；rollback-continue → rollback executor。
    // 不混用两套引擎；缺省 decision 走 rollback executor（兼容旧调用）。
    const executor = input.decision === 'rollback-recommended' ? input.performRestore : input.performRollback;
    if (executor === undefined) return 'failed';
    // 真正开始时：NEEDS_ATTENTION → RECOVERING（§4.2/§7.1）。recovery 全程保持 RECOVERING，
    // **不引入 ROLLING_BACK**（ALLOWED_TRANSITIONS['RECOVERING'] 不含 ROLLING_BACK）。
    // retry 续跑时 journal 已 RECOVERING → 幂等保持。
    await store.update(input.operationId, (cur) => {
      if (cur.state === 'RECOVERING') return cur;
      if (cur.state === 'NEEDS_ATTENTION') return transitionJournalState(cur, 'RECOVERING');
      return cur; // 其它状态（terminal 等）不迁移
    }).catch(() => undefined);
    const report = await executor(input.snapshotId);
    // 执行完成：保持 RECOVERING（记录 rollback 报告；终态迁移 + verification 写入由 verify 路由
    // 以单次原子 journal update 完成，见 §6.5）。此处绝不自行转 ROLLED_BACK。
    await store.update(input.operationId, (cur) => {
      return { ...cur, rollback: { ...cur.rollback, full: report.full, failed: report.failed } };
    }).catch(() => undefined);
    return 'done';
  }

  // dismiss（quarantine & dismiss）：移出 active，不视为恢复（用户显式放弃）
  if (!userConfirmed) return 'needs-confirmation';
  await store.quarantine(input.operationId, 'user dismissed').catch(() => undefined);
  return 'done';
}

// ---------- recovery decision 重算（§5.4） ----------

/**
 * 对 terminal `NEEDS_ATTENTION` journal 重算 recovery 决策（§5.4，Reviewer A 第二轮 P1-2）。
 *
 * `reconcileActive` 对 terminal `NEEDS_ATTENTION` journal 恒返回 `needs-attention`
 * （`NEEDS_ATTENTION` 是 terminal，`rollback-recommended`/`rollback-continue` 只在转换进
 * NEEDS_ATTENTION 的当次 pass 出现一次）。`GET /recovery/status` 用本函数重算，区分
 * `rollback-recommended` / `rollback-continue` / `needs-attention`。
 *
 * **只读**：不修改 journal，不写 SAFE MODE，不写 recovery-history。
 */
export async function recomputeRecoveryDecision(
  j: OperationJournal,
  hooks: Pick<ReconcileProbeHooks, 'snapshotExists'>,
): Promise<'rollback-continue' | 'rollback-recommended' | 'needs-attention'> {
  // 回滚中断（entryDone 非空）→ 续跑中断回滚
  if (Object.keys(j.rollback.entryDone ?? {}).length > 0) return 'rollback-continue';
  // 有合法且存在的 trusted bound snapshot → 可恢复到快照
  if (j.snapshotId !== null && j.snapshotId !== '') {
    const exists = await hooks.snapshotExists(j.snapshotId, {
      operationId: j.operationId,
      ownerInstanceId: j.ownerInstanceId,
      environmentFingerprint: j.environmentFingerprint,
    });
    if (exists) return 'rollback-recommended';
  }
  return 'needs-attention';
}

// ---------- startup 只读判定（不自动 recover stale lock） ----------

export interface StartupInspection {
  safeModeRequired: boolean;
  recoveryRequired: boolean;
  decisions: ReconcileDecision[];
  unresolved: string[];
  /**
   * durable SAFE MODE 标记的三态判定（t37）：'blocked' / 'clear' / **'unknown'**。
   * 单独暴露的原因：`safeModeRequired` 是聚合结论（还可能因 corrupt journal / needs-attention 为 true），
   * 消费方与事后审计需要区分「标记确实不存在」与「标记在但无法判定」——后者已按 fail-closed 计入
   * `safeModeRequired`，这里如实透出，绝不把 unknown 压成 clear。
   */
  durableSafeState: SafeModeMarkerState;
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
  // 读 durable SAFE MODE 标记（跨重启保持阻断）：即使 active 已规整，标记在则仍须阻断。
  //
  // t37：消费**三态**而不是 boolean 兼容面 —— classifySafeModeMarker 的契约是「调用方必须 fail-closed」，
  // 因此只有 'clear'（确实没有标记）才不因标记阻断；'blocked' 与 'unknown'（标记存在但无法判定 / 布局
  // 不可信 / 读不出）一律计入 safeModeRequired。旧实现 `readSafeMode().catch(() => false)` 把「无法判定」
  // 读成「没有标记」（fail-open 外观），在 startup 这道最后的门上不可接受。
  const durableSafeState = await store.readSafeModeState();
  const durableSafe = durableSafeState !== 'clear';
  const safeModeRequired = outcome.safeModeRequired || recoveryRequired || durableSafe;
  return {
    safeModeRequired, recoveryRequired, decisions: outcome.decisions, unresolved: outcome.unresolved, durableSafeState,
  };
}
