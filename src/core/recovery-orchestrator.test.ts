/**
 * RecoveryOrchestrator 测试（issue #31 聚焦）。
 *
 * 背景：残留环境锁**不是** journal —— 进程死在 `op=autosync` 期间时 `journalId: null`、
 * `transactions/active/` 为空，因此 status() 的 incidents 恒为 []，「事故恢复」面板对纯锁
 * 残留恒空，而 423 文案却让用户去那个面板处理。本测试锁定三件事：
 *  ① status() 必须附带环境锁分类，让面板能显示可执行的锁事项；
 *  ② 锁分类**只上报 state/attention**，绝不把 owner pid/op 等内部诊断放进响应体；
 *  ③ recoverStaleLock() 必须要求显式确认，且**绝不**在未证明 stale 时谎称成功。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRecoveryOrchestrator } from './recovery-orchestrator.ts';
import type { RecoveryOrchestratorDeps } from './recovery-orchestrator.ts';
import { JournalStore } from './journal.ts';
import { RunRegistry } from './run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import { zhMsg } from './messages.ts';
import type { HostContext } from './types.ts';

/** 记录注入依赖的调用次数（断言「拒绝时不得调用回收」用）。 */
interface RecoverSpy {
  calls: number;
  result: { ok: boolean; removed: boolean; state: string; detail?: string };
}

async function makeOrchestrator(opts: {
  lockState?: string;
  lockDetail?: string;
  lockThrows?: boolean;
  recoverResult?: { ok: boolean; removed: boolean; state: string; detail?: string };
} = {}): Promise<{ orchestrator: ReturnType<typeof createRecoveryOrchestrator>; spy: RecoverSpy }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-recovery-orch-'));
  const spy: RecoverSpy = {
    calls: 0,
    result: opts.recoverResult ?? { ok: true, removed: true, state: 'STALE_LOCK_DETECTED', detail: '已移除 stale ownership (op=autosync, pid=24140)' },
  };
  const deps: RecoveryOrchestratorDeps = {
    store: new JournalStore({ transactionsDir: path.join(dir, 'transactions') }),
    runs: new RunRegistry(),
    snapshotsDir: path.join(dir, 'snapshots'),
    host: { log: nullLogger() } as unknown as HostContext,
    msg: zhMsg,
    snapshotExists: async () => false,
    getEnvironmentFingerprint: () => 'fp-test',
    clearSafeMode: async () => undefined,
    inspectLockState: async () => {
      if (opts.lockThrows === true) throw new Error('probe failed');
      return { state: opts.lockState ?? 'FREE', ...(opts.lockDetail !== undefined ? { detail: opts.lockDetail } : {}) };
    },
    recoverStaleLock: async () => {
      spy.calls += 1;
      return spy.result;
    },
  };
  return { orchestrator: createRecoveryOrchestrator(deps), spy };
}

// ---------- ① 纯锁残留场景：incidents 为空，但锁事项必须可见 ----------

test('status：无 journal（纯残留锁）时 incidents 为空，但仍上报锁分类供面板显示', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'STALE_LOCK_DETECTED' });
  const r = await orchestrator.status();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['incidents'], [], '残留锁不是 journal → incidents 恒空（#31 根因 C）');
  assert.deepEqual(r.body['lock'], { state: 'STALE_LOCK_DETECTED', attention: true });
});

test('status：LOCKED（另一任务活跃持有）→ attention=false，不催用户回收', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'LOCKED' });
  const r = await orchestrator.status();
  assert.deepEqual(r.body['lock'], { state: 'LOCKED', attention: false });
});

test('status：UNKNOWN_STATE（无法判定）→ attention=true', async () => {
  const { orchestrator } = await makeOrchestrator({ lockState: 'UNKNOWN_STATE' });
  const r = await orchestrator.status();
  assert.deepEqual(r.body['lock'], { state: 'UNKNOWN_STATE', attention: true });
});

test('status：锁探测抛错 → 不阻断 status，保守上报 UNKNOWN_STATE/attention', async () => {
  const { orchestrator } = await makeOrchestrator({ lockThrows: true });
  const r = await orchestrator.status();
  assert.equal(r.status, 200, '探测失败不得让整个恢复面板加载失败');
  assert.deepEqual(r.body['lock'], { state: 'UNKNOWN_STATE', attention: true });
});

// ---------- ② 响应体不得含内部诊断（pid/op） ----------

test('status：锁分类只上报 state/attention，绝不泄漏 owner pid/op（detail 只进日志）', async () => {
  const { orchestrator } = await makeOrchestrator({
    lockState: 'STALE_LOCK_DETECTED',
    lockDetail: 'owner pid=24140 确证不存在 (heartbeat expired)',
  });
  const r = await orchestrator.status();
  const serialized = JSON.stringify(r.body);
  assert.equal(serialized.includes('24140'), false, 'owner pid 不得进入响应体');
  assert.equal(serialized.includes('heartbeat'), false, '判定依据细节不得进入响应体');
  assert.deepEqual(r.body['lock'], { state: 'STALE_LOCK_DETECTED', attention: true });
});

// ---------- ③ 显式回收：需确认、不谎称成功 ----------

test('recoverStaleLock：未携带 userConfirmed=true → 400 且不调用回收', async () => {
  const { orchestrator, spy } = await makeOrchestrator();
  const r = await orchestrator.recoverStaleLock(false);
  assert.equal(r.status, 400);
  assert.equal(spy.calls, 0, '未确认不得触碰锁文件');
});

test('recoverStaleLock：确认后成功 → ok/removed，且响应体不含内部诊断', async () => {
  const { orchestrator, spy } = await makeOrchestrator();
  const r = await orchestrator.recoverStaleLock(true);
  assert.equal(spy.calls, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body['ok'], true);
  assert.equal(r.body['removed'], true);
  assert.equal(JSON.stringify(r.body).includes('24140'), false, 'pid 只进日志');
});

test('recoverStaleLock：未被判定为 stale → ok=false（绝不谎称成功），且不改动任何东西', async () => {
  const { orchestrator, spy } = await makeOrchestrator({
    recoverResult: { ok: false, removed: false, state: 'LOCKED', detail: '非 stale，拒绝 recovery' },
  });
  const r = await orchestrator.recoverStaleLock(true);
  assert.equal(r.status, 200, '拒绝是正常结果而非服务错误');
  assert.equal(r.body['ok'], false);
  assert.equal(r.body['removed'], false);
  assert.equal(r.body['state'], 'LOCKED');
  assert.equal(spy.calls, 1);
});

// ---------- 源码守卫：回收路由的接线形态（#31 的关键不变量） ----------

/**
 * 为什么必须守卫：若要回收的正是那把挡住 acquire 的残留锁，把回收路由改成
 * `runWithMutationLock`/`withMutationGate` 包裹后，acquire 必然返回 STALE_LOCK_DETECTED
 * → 抛 423 → **回收永远无法执行**（正是本 issue 报告的那类「入口存在但结构上不可达」）。
 * 同时锁分支必须排在 :operationId 解析之前——'lock' 不是 UUID，否则会被 400 挡掉。
 * 按文本解析源码前先归一化行尾（Windows 工作区 CRLF / CI LF），否则守卫只在一边通过。
 */
/** W1 起路由按域拆到 src/routes/*.ts：源码级守卫必须扫**全部**宿主路由源，否则会静默失去覆盖。 */
async function hostRouteSource(): Promise<string> {
  const parts = [await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8')];
  const dir = new URL('../routes/', import.meta.url);
  for (const entry of (await fs.readdir(dir)).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    parts.push(await fs.readFile(new URL(entry, dir), 'utf8'));
  }
  return parts.join('\n').replace(/\r\n/g, '\n');
}

test('源码守卫：/recovery/lock/recover 分支先于 operationId 解析，且不经 acquire（否则回收必然失败）', async () => {
  // W1：recovery 路由已拆到 src/routes/recovery.ts —— 扫「宿主路由源」（index.ts + src/routes/**）
  const source = await hostRouteSource();

  const lockBranch = source.indexOf("if (segments[0] === 'lock') {");
  assert.ok(lockBranch > 0, '应能找到残留锁回收分支（segments[0] === \'lock\'）');

  const idParse = source.indexOf('const operationId = segments[0]!');
  assert.ok(idParse > 0, '应能找到 operationId 解析点');
  assert.ok(
    lockBranch < idParse,
    `锁分支必须排在 operationId 解析之前（lock=${lockBranch}, idParse=${idParse}）：'lock' 不是 UUID，落到后面会被 400 invalid operationId 挡掉`,
  );

  const branchBody = source.slice(lockBranch, idParse);
  // 先剥注释再判定：本分支**注释里**会解释「为何不经 acquire」，直接正则匹配注释会误报
  const code = branchBody
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.equal(
    /runWithMutationLock|withMutationGate/.test(code),
    false,
    '回收分支不得经 acquire：要回收的正是挡住 acquire 的残留锁，先取锁必然抛 423 → 回收永不生效',
  );
  assert.equal(
    code.includes('recoverStaleLock'), true,
    '回收分支必须真的调用编排器 recoverStaleLock',
  );

  // 接线不得丢：创建编排器时必须注入两个新依赖
  const ctor = source.indexOf('createRecoveryOrchestrator({');
  assert.ok(ctor > 0, '应能找到 createRecoveryOrchestrator 调用');
  const ctorBody = source.slice(ctor, source.indexOf('\n  })', ctor));
  assert.ok(ctorBody.includes('inspectLockState:'), 'createRecoveryOrchestrator 必须注入 inspectLockState');
  assert.ok(ctorBody.includes('recoverStaleLock:'), 'createRecoveryOrchestrator 必须注入 recoverStaleLock');
});
