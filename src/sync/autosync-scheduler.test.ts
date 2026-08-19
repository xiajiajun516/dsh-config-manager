/**
 * AutoSyncScheduler 测试：interval 换算、shouldTriggerStartupRun 阈值、
 * enabled=false 不执行、连续失败通知、冲突跳过。
 *
 * 采用真实 RunRegistry + 注入 readConfig/writeConfig/readSyncConfigFn/readHistoryFn/
 * appendHistoryFn/makeSyncEngine/now，全程不触碰真实网络与真实定时器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AutoSyncScheduler, intervalToMs, shouldTriggerStartupRun, buildAutoApplyPlan,
} from './autosync-scheduler.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import type { AutosyncConfig } from './autosync-config.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import type { SectionId } from '../schema/types.ts';
import type { SyncEngine } from './sync-engine.ts';
import type { SyncConfig, SyncTransportType } from './sync-config.ts';
import { syncIsConfigured } from './autosync-scheduler.ts';

test('intervalToMs: 间隔换算正确', () => {
  assert.equal(intervalToMs('5m'), 5 * 60 * 1000);
  assert.equal(intervalToMs('15m'), 15 * 60 * 1000);
  assert.equal(intervalToMs('30m'), 30 * 60 * 1000);
  assert.equal(intervalToMs('60m'), 60 * 60 * 1000);
  assert.equal(intervalToMs('6h'), 6 * 60 * 60 * 1000);
  assert.equal(intervalToMs('12h'), 12 * 60 * 60 * 1000);
  assert.equal(intervalToMs('24h'), 24 * 60 * 60 * 1000);
});

test('shouldTriggerStartupRun: 阈值判断', () => {
  const threshold = 5 * 60 * 1000;
  const now = 1_000_000_000_000;
  assert.equal(shouldTriggerStartupRun(new Date(now - 60 * 1000).toISOString(), threshold, now), false);
  assert.equal(shouldTriggerStartupRun(new Date(now - 6 * 60 * 1000).toISOString(), threshold, now), true);
  assert.equal(shouldTriggerStartupRun(undefined, threshold, now), true);
  assert.equal(shouldTriggerStartupRun(new Date(now - threshold).toISOString(), threshold, now), true);
  assert.equal(shouldTriggerStartupRun(new Date(now - threshold - 1).toISOString(), threshold, now), true);
  assert.equal(shouldTriggerStartupRun(new Date(now - threshold + 1).toISOString(), threshold, now), false);
});

/** 构造一个可控 scheduler：注入全部 fs/engine 依赖，验证 runOnce 行为。 */
function makeScheduler(opts: {
  cfg: AutosyncConfig;
  engine: Partial<SyncEngine>;
  history: AutosyncHistoryEntry[];
  syncCfg?: SyncConfig | null;
}) {
  const runs = new RunRegistry();
  const entries: AutosyncHistoryEntry[] = [...opts.history];
  let config = opts.cfg;
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => opts.engine as SyncEngine,
    msg: (k: string) => k,
    runs,
    now: () => new Date(1_000_000_000_000),
    readConfig: async (_channel: SyncTransportType) => config,
    writeConfig: async (_channel: SyncTransportType, c: AutosyncConfig) => { config = c; },
    readSyncConfigFn: async (_channel: SyncTransportType) => opts.syncCfg !== undefined ? opts.syncCfg : ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: entries, updatedAt: '' }),
    appendHistoryFn: async (e) => { entries.push(e); },
    // 测试不用真实定时器：不调 start()
  });
  return { scheduler, runs, getConfig: () => config, getEntries: () => entries };
}

function mergeResult(id: string, decision: MergeSectionResult['decision']): MergeSectionResult {
  return { id: id as never, decision, conflicts: [], merged: {} as never };
}

function makeMergePlan(ids: Array<[string, MergeSectionResult['decision']]>): MergePlan {
  return { sections: ids.map(([id, decision]) => mergeResult(id, decision)) };
}

test('runOnce: enabled=false → skipped(disabled)，不写历史', async () => {
  const cfg: AutosyncConfig = { enabled: false, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const { scheduler, getConfig, getEntries } = makeScheduler({ cfg, engine: {}, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'disabled');
  assert.equal(getEntries().length, 0, 'disabled 不写历史');
  assert.equal(getConfig().consecutiveFailures, 0);
});

test('runOnce: 未配置仓库 → skipped(unconfigured)，写历史但不计失败', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => ({} as SyncEngine),
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async () => cfg,
    writeConfig: async () => {},
    readSyncConfigFn: async () => null,
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
  });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'unconfigured');
  assert.equal(result.consecutiveFailures, 0, '未配置不累计失败');
});

test('runOnce: webdav 已配置（webdav.url 非空）→ 不判 unconfigured，正常走 merge（按通道判定）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'skip']]),
    hasLocalChanges: async () => false,
  };
  const syncCfg: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/remote.php/dav/files/u' } };
  const { scheduler } = makeScheduler({ cfg, engine, history: [], syncCfg });
  const result = await scheduler.runOnce('webdav');
  assert.equal(result.status, 'success', 'webdav 已配置应进入合并流程');
  assert.equal(result.skipReason, 'unchanged', '空变更 → pull/unchanged');
});

test('runOnce: webdav 未配置（webdav.url 缺）→ skipped(unconfigured)，不计失败', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 1 };
  const syncCfg: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: '' } };
  const { scheduler, getConfig } = makeScheduler({ cfg, engine: {}, history: [], syncCfg });
  const result = await scheduler.runOnce('webdav');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'unconfigured');
  assert.equal(result.consecutiveFailures, 1, '未配置不计失败（保持 1）');
  assert.equal(getConfig().consecutiveFailures, 1);
});

test('syncIsConfigured: git 看 git.repoUrl、webdav 看 webdav.url；null 未配置', () => {
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }), true);
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'git', git: { repoUrl: '' } }), false, 'git 缺 repoUrl → 未配置');
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com' } }), true);
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'webdav', webdav: { url: '' } }), false, 'webdav 缺 url → 未配置');
  assert.equal(syncIsConfigured(null), false);
});

test('runOnce: merge 抛错 → failed，连续失败计数 +1', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 2 };
  const engine = { merge: async () => { throw new Error('network down'); } };
  const { scheduler, getConfig, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'failed');
  assert.equal(result.consecutiveFailures, 3, '连续失败 2→3');
  assert.equal(getConfig().consecutiveFailures, 3);
  assert.ok(getEntries().some((e) => e.status === 'failed'), '写入失败历史');
});

test('runOnce: 有冲突 → skipped(conflict)，不写本地，不计失败', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 1 };
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'conflict']]),
  };
  const { scheduler, getConfig, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'conflict');
  assert.deepEqual(result.conflictedSections, ['settings']);
  assert.equal(result.consecutiveFailures, 1, '冲突跳过不计失败');
  assert.equal(getConfig().consecutiveFailures, 1);
  assert.ok(getEntries().some((e) => e.skipReason === 'conflict'), '写入冲突跳过历史');
});

test('runOnce: 无冲突且无变化 → success(pull,unchanged)，不上传（本地也无改动）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'skip']]),
    hasLocalChanges: async () => false,
  };
  const { scheduler } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  assert.equal(result.direction, 'pull');
  assert.equal(result.skipReason, 'unchanged');
});

test('runOnce: 完整双向 → 无冲突合并写本地 + push', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const applyCalls: string[] = [];
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'useRemote']]),
    applyMergePlan: async () => { applyCalls.push('apply'); return { ok: true, applied: ['settings'], restoreId: 'r1', rolledBack: false, review: [], warnings: [] }; },
    push: async () => ({ ok: true, snapshotId: 'snap-push', sections: ['settings'] as never, warnings: [] }),
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  assert.equal(result.direction, 'both');
  assert.deepEqual(result.appliedSections, ['settings']);
  assert.equal(result.pushedSnapshotId, 'snap-push');
  assert.equal(applyCalls.length, 1);
  assert.ok(getEntries().some((e) => e.status === 'success' && e.direction === 'both'), '写入双向成功历史');
});

test('runOnce: startup 变体 → 只做 pull 合并，不上传', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const pushCalls: string[] = [];
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'useRemote']]),
    applyMergePlan: async () => ({ ok: true, applied: ['settings'], restoreId: 'r1', rolledBack: false, review: [], warnings: [] }),
    push: async () => { pushCalls.push('push'); return { ok: true, snapshotId: 'x', sections: [] as never, warnings: [] }; },
  };
  const { scheduler } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git', { startup: true });
  assert.equal(result.direction, 'pull', 'startup 不上传');
  assert.equal(pushCalls.length, 0, 'startup 变体不调用 push');
});

test('runOnce: 连续两次执行不再 skip(conflict)（run 完成收尾）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'useRemote']]),
    applyMergePlan: async () => ({ ok: true, applied: ['settings'], restoreId: 'r1', rolledBack: false, review: [], warnings: [] }),
    push: async () => ({ ok: true, snapshotId: 's1', sections: ['settings'] as never, warnings: [] }),
  };
  const { scheduler, runs } = makeScheduler({ cfg, engine, history: [] });
  const first = await scheduler.runOnce('git');
  assert.equal(first.status, 'success', '首次执行成功');
  assert.equal(runs.listActive().filter((r) => r.kind === 'autosync').length, 0, '执行后 registry 无滞留 autosync running 记录');
  const second = await scheduler.runOnce('git');
  assert.equal(second.status, 'success', '第二次执行不再被同 kind 注册冲突拦截');
  assert.equal(second.direction, 'both');
  assert.equal(runs.listActive().filter((r) => r.kind === 'autosync').length, 0);
});

test('runOnce: 远端无新快照且本地无改动 → success(upToDate)，不 merge 不 push', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const mergeCalls: string[] = [];
  const pushCalls: string[] = [];
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => false,
    merge: async () => { mergeCalls.push('merge'); return makeMergePlan([]); },
    push: async () => { pushCalls.push('push'); return { ok: true, snapshotId: 's', sections: [] as never, warnings: [] }; },
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  assert.equal(result.direction, 'none');
  assert.equal(result.skipReason, 'upToDate');
  assert.equal(mergeCalls.length, 0, '远端无新生不拉取');
  assert.equal(pushCalls.length, 0, '本地无改动不上传');
  assert.ok(getEntries().some((e) => e.skipReason === 'upToDate'), '写入 upToDate 历史');
});

test('runOnce: 远端无新快照但本地有改动 → 只 push 不拉取（direction=push）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const mergeCalls: string[] = [];
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => true,
    merge: async () => { mergeCalls.push('merge'); return makeMergePlan([]); },
    push: async () => ({ ok: true, snapshotId: 'snap-local', sections: ['settings'] as never, warnings: [] }),
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  assert.equal(result.direction, 'push', '远端无新生只上传本地改动');
  assert.equal(result.pushedSnapshotId, 'snap-local');
  assert.equal(mergeCalls.length, 0, '远端无新生不执行 merge/拉取');
  assert.ok(getEntries().some((e) => e.status === 'success' && e.direction === 'push'), '写入 push 历史');
});

test('runOnce: 远端有新快照但本地无改动 → 只 pull 合并，不 push', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const pushCalls: string[] = [];
  const engine = {
    hasNewRemoteSnapshot: async () => true,
    hasLocalChanges: async () => false,
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'useRemote']]),
    applyMergePlan: async () => ({ ok: true, applied: ['settings'], restoreId: 'r1', rolledBack: false, review: [], warnings: [] }),
    push: async () => { pushCalls.push('push'); return { ok: true, snapshotId: 'x', sections: [] as never, warnings: [] }; },
  };
  const { scheduler } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  assert.equal(result.direction, 'pull', '本地无改动不上传，只拉取合并');
  assert.deepEqual(result.appliedSections, ['settings']);
  assert.equal(pushCalls.length, 0, '本地无改动不 push');
});

test('start(): 定时器触发后自动重排下一次（周期性后台同步）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const pending: Array<() => void> = [];
  let timerSeq = 0;
  const engine = {
    merge: async (): Promise<MergePlan> => makeMergePlan([]),
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => engine as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async (channel: SyncTransportType) => channel === 'git' ? cfg : { ...cfg, enabled: false },
    writeConfig: async () => {},
    readSyncConfigFn: async (_channel: SyncTransportType) => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
    setTimer: (fn) => { pending.push(fn); timerSeq += 1; return String(timerSeq) as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
  });
  scheduler.start();
  // start() → refreshTimer 异步读配置后排入首个定时器（startupRun 不会排定时器）
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 1, '启动后已排入首个定时器');
  // 触发一次定时回调：应执行 runOnce 并在结束后重新排定下一次
  const firstTimer = pending[0];
  assert.ok(firstTimer, '首个定时器句柄存在');
  firstTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(pending.length >= 2, '一轮执行后重新排入下一次定时器（循环调度）');
  scheduler.stop();
  // stop 后触发已排定时器不再重排
  const countAfterStop = pending.length;
  const lastTimer = pending[countAfterStop - 1];
  assert.ok(lastTimer, '停止前最后一次排期的定时器存在');
  lastTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, countAfterStop, 'stop 后不再排期');
});

test('buildAutoApplyPlan: 把非 skip 非 conflict 项归入 autoApply', () => {
  const plan = makeMergePlan([
    ['settings', 'useRemote'],
    ['providers', 'keepLocal'],
    ['plugins', 'skip'],
    ['mcp', 'conflict'],
  ]);
  const apply = buildAutoApplyPlan(plan);
  assert.deepEqual(apply.autoApply.map((s) => s.id), ['settings', 'providers']);
  assert.deepEqual(apply.review.map((s) => s.id), ['mcp']);
  assert.deepEqual(apply.skipped.map((s) => s.id), ['plugins']);
});

test('runOnce: 远端最新快照为加密 → 跳过 + 历史 skipReason=encrypted（不 merge 不 push）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const mergeCalls: string[] = [];
  const pushCalls: string[] = [];
  const engine = {
    listSnapshots: async () => [
      {
        id: 'remote-enc', createdAt: '2026-08-16T12:00:00.000Z', sections: {},
        manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings' as SectionId], containsSecrets: true, encrypted: true },
      },
    ],
    hasNewRemoteSnapshot: async () => true,
    hasLocalChanges: async () => true,
    merge: async () => { mergeCalls.push('merge'); return makeMergePlan([]); },
    push: async () => { pushCalls.push('push'); return { ok: true, snapshotId: 'x', sections: [] as never, warnings: [] }; },
  };
  const { scheduler, getEntries, getConfig } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped', '加密快照 → 跳过');
  assert.equal(result.skipReason, 'encrypted');
  assert.equal(mergeCalls.length, 0, '加密快照不拉取合并');
  assert.equal(pushCalls.length, 0, '加密快照不上传');
  assert.ok(getEntries().some((e) => e.skipReason === 'encrypted'), '写入 encrypted 跳过历史');
  assert.equal(getConfig().lastRunStatus, 'skipped', 'autosync 状态记录为 skipped');
});

test('runOnce: 远端最新快照为普通 → 加密检测不触发（listSnapshots 正常路径不受影响）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const engine = {
    listSnapshots: async () => [
      {
        id: 'remote-plain', createdAt: '2026-08-16T12:00:00.000Z', sections: {},
        manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings' as SectionId], containsSecrets: false },
      },
    ],
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => false,
    merge: async (): Promise<MergePlan> => makeMergePlan([]),
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success', '普通快照照常执行');
  assert.equal(result.skipReason, 'upToDate');
  assert.ok(!getEntries().some((e) => e.skipReason === 'encrypted'), '普通快照不产生 encrypted 跳过历史');
});

test('双通道：git/webdav 同时 enabled → 各自独立排期；runOnce 写各自通道配置', async () => {
  const gitCfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const webdavCfg: AutosyncConfig = { enabled: true, interval: '5m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const configs: Record<SyncTransportType, AutosyncConfig> = { git: gitCfg, webdav: webdavCfg };
  const pending: Array<() => void> = [];
  let timerSeq = 0;
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => false,
    merge: async (): Promise<MergePlan> => makeMergePlan([]),
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => engine as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async (channel: SyncTransportType) => configs[channel],
    writeConfig: async (channel: SyncTransportType, c: AutosyncConfig) => { configs[channel] = c; },
    readSyncConfigFn: async (channel: SyncTransportType) => channel === 'webdav'
      ? ({ schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav' } } as SyncConfig)
      : ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } } as SyncConfig),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
    setTimer: (fn) => { pending.push(fn); timerSeq += 1; return String(timerSeq) as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 2, '两个 enabled 通道各自排期');
  scheduler.stop();
  // 停止后不再重排
  const countAfterStop = pending.length;
  const lastTimer = pending[countAfterStop - 1];
  assert.ok(lastTimer, '停止前最后一次排期的定时器存在');
  lastTimer();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, countAfterStop, 'stop 后不再排期');
  // runOnce 按通道独立：只跑 webdav 时 git 配置不受影响
  // （start() 的启动触发已对 git 通道跑过一次 startup 变体，故先记录基线再对比）
  const gitBefore = { ...configs.git };
  const result = await scheduler.runOnce('webdav');
  assert.equal(result.status, 'success', 'webdav 通道照常执行');
  assert.deepEqual(configs.git, gitBefore, 'git 通道配置未被 webdav 运行改变');
  assert.equal(configs.webdav.lastRunStatus, 'success', 'webdav 通道写入自己的运行状态');
});
