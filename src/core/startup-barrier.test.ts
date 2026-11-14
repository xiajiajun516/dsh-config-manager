/**
 * issue #87：启动分类 → SAFE MODE 处置的单一判据（纯函数矩阵）。
 *
 * 背景：`probeSafeModeSync()` 读的是上一轮留下的 durable 标记，分类结论才是本轮权威。旧实现只做
 * `safeModeActive = safeModeActive || kind ∈ {RECOVERY_REQUIRED, NEEDS_ATTENTION, UNKNOWN_STATE}` ——
 * 只会把标志**置真**，于是「崩溃前什么都没写」的残留会让本会话的写操作一直被 423 挡着（界面却说
 * 「无待处理事项」），且下次启动又从头再来一遍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveStartupSafeMode, classifyStartup, FAIL_CLOSED_STARTUP } from './startup-barrier.ts';
import { JournalStore, createJournalEntry } from './journal.ts';
import type { ReconcileEnv, ReconcileProbeHooks } from './reconcile.ts';

test('issue #87：NORMAL + 无活锁者 + 陈旧 blocked 标记 → 解除（内存标志与 durable 标记一起复位）', () => {
  assert.deepEqual(
    resolveStartupSafeMode({ kind: 'NORMAL', lockState: 'FREE', currentlyBlocked: true }),
    { blocked: false, clearStaleMarker: true },
  );
});

test('issue #87：NORMAL 但没有陈旧标记 → 不动标记（不做无意义写入）', () => {
  assert.deepEqual(
    resolveStartupSafeMode({ kind: 'NORMAL', lockState: 'FREE', currentlyBlocked: false }),
    { blocked: false, clearStaleMarker: false },
  );
});

test('issue #87：NORMAL 但锁被别人持有（LOCKED）→ 绝不清标记、保持阻断（不替活锁者解除保护）', () => {
  assert.deepEqual(
    resolveStartupSafeMode({ kind: 'NORMAL', lockState: 'LOCKED', currentlyBlocked: true }),
    { blocked: true, clearStaleMarker: false },
  );
});

test('issue #87：残留锁（STALE_LOCK_DETECTED）未显式回收 → 不清标记（仍需用户回收残留锁）', () => {
  assert.deepEqual(
    resolveStartupSafeMode({ kind: 'NORMAL', lockState: 'STALE_LOCK_DETECTED', currentlyBlocked: true }),
    { blocked: true, clearStaleMarker: false },
  );
});

test('issue #87：RECOVERY_REQUIRED / NEEDS_ATTENTION / UNKNOWN_STATE → 一律阻断且不清标记', () => {
  for (const kind of ['RECOVERY_REQUIRED', 'NEEDS_ATTENTION', 'UNKNOWN_STATE'] as const) {
    assert.deepEqual(
      resolveStartupSafeMode({ kind, lockState: 'FREE', currentlyBlocked: false }),
      { blocked: true, clearStaleMarker: false },
      kind + ' 必须阻断',
    );
  }
});

test('issue #87：fail-closed 结论（FAIL_CLOSED_STARTUP）经同一判据仍然是阻断', () => {
  const verdict = resolveStartupSafeMode({
    kind: FAIL_CLOSED_STARTUP.state.kind,
    lockState: 'FREE',
    currentlyBlocked: false,
  });
  assert.equal(verdict.blocked, true, 'inspect 抛错时绝不因 NORMAL 之外的分支被解除');
  assert.equal(verdict.clearStaleMarker, false);
});

test('issue #87：classifyStartup 仍是分类唯一来源（形状自检，防止第二份分类漂移）', () => {
  const classifier = classifyStartup({
    store: {} as never,
    hooks: {} as never,
    env: { environmentFingerprint: 'fp', isLiveOwner: async () => false },
    lockState: 'FREE',
  });
  assert.equal(typeof classifier.classify, 'function');
});

// ---------- P3-8：LOCKED_LIVE 的判据是「持锁 + live 且未 terminal 的 journal」 ----------

function tmpDir(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const probeHooks: ReconcileProbeHooks = {
  verifyStepFingerprint: async () => 'before-match',
  probeExternal: async () => 'not-installed',
  snapshotExists: async () => true,
};
// 保守 env：真实进程探测恒 false（LOCKED 下由 inspectStartup 强制按 live 处理）
const probeEnv: ReconcileEnv = { environmentFingerprint: 'fp', isLiveOwner: async () => false };

function journalStore(dir: string): JournalStore {
  return new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
}

test('审计 P3-8：另一实例持锁 + 存在真正在跑的 journal（live 且未 terminal）→ LOCKED_LIVE（旧实现给 NORMAL）', async (t) => {
  const dir = tmpDir(t);
  const store = journalStore(dir);
  const operationId = '00000000-0000-4000-8000-0000000000a1';
  await store.create(createJournalEntry(
    'import-apply',
    { operationId, ownerInstanceId: 'other-instance', lockId: 'lock-1', packageVersion: '0.1.80', environmentFingerprint: 'fp' },
    '2026-01-01T00:00:00.000Z',
  ));
  // 进行中（非 terminal）：另一个存活实例正在 apply
  await store.update(operationId, (cur) => ({ ...cur, state: 'APPLYING' }));

  const { state } = await classifyStartup({
    store, hooks: probeHooks, env: probeEnv, lockState: 'LOCKED',
  }).classify();

  assert.equal(state.kind, 'LOCKED_LIVE', `持锁 + 真正在跑必须分类为 LOCKED_LIVE；实际 ${state.kind}`);
  assert.equal(state.kind === 'LOCKED_LIVE' ? state.operationId : undefined, operationId, '必须指出是哪条 live op');
});

test('审计 P3-8 对照：持锁但 active 里只有已 terminal 的 journal → NORMAL（不误报 LOCKED_LIVE）', async (t) => {
  const dir = tmpDir(t);
  const store = journalStore(dir);
  const operationId = '00000000-0000-4000-8000-0000000000a2';
  await store.create(createJournalEntry(
    'import-apply',
    { operationId, ownerInstanceId: 'other-instance', lockId: 'lock-1', packageVersion: '0.1.80', environmentFingerprint: 'fp' },
    '2026-01-01T00:00:00.000Z',
  ));
  await store.update(operationId, (cur) => ({ ...cur, state: 'COMMITTED' }));

  const { state } = await classifyStartup({
    store, hooks: probeHooks, env: probeEnv, lockState: 'LOCKED',
  }).classify();

  assert.equal(state.kind, 'NORMAL', '没有未收敛的 live op ⇒ 不存在「正在跑的操作」可报');
});

