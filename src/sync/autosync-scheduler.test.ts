/**
 * AutoSyncScheduler 测试：interval 换算、shouldTriggerStartupRun 阈值、
 * enabled=false 不执行、连续失败通知、冲突跳过。
 *
 * 采用真实 RunRegistry + 注入 readConfig/writeConfig/readSyncConfigFn/readHistoryFn/
 * appendHistoryFn/makeSyncEngine/now，全程不触碰真实网络与真实定时器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AutoSyncScheduler, intervalToMs, shouldTriggerStartupRun, buildAutoApplyPlan,
} from './autosync-scheduler.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger, createLogger } from '../utils/logger.ts';
import type { LogSink } from '../utils/logger.ts';
import type { MutationLockPort, MutationLockToken } from '../utils/env-lock.ts';
import type { AutosyncConfig } from './autosync-config.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import type { SyncSnapshotMeta } from './transport.ts';
import type { SectionId } from '../schema/types.ts';
import type { SyncEngine } from './sync-engine.ts';
import type { SyncConfig, SyncTransportType } from './sync-config.ts';
import { SYNC_CHANNELS } from './sync-config.ts';
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
  /** issue #31：注入锁端口以覆盖「被锁挡下」的路径（缺省 = 无锁环境） */
  mutationLock?: MutationLockPort;
  /** issue #31：捕获日志行（断言 stale 指引确实写给用户） */
  logSink?: LogSink;
}) {
  const runs = new RunRegistry();
  const entries: AutosyncHistoryEntry[] = [...opts.history];
  let config = opts.cfg;
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: opts.logSink !== undefined ? createLogger({ level: 'debug', sink: opts.logSink }) : nullLogger() },
    makeSyncEngine: () => opts.engine as SyncEngine,
    msg: (k: string) => k,
    runs,
    now: () => new Date(1_000_000_000_000),
    readConfig: async (_channel: SyncTransportType) => config,
    writeConfig: async (_channel: SyncTransportType, c: AutosyncConfig) => { config = c; },
    readSyncConfigFn: async (_channel: SyncTransportType) => opts.syncCfg !== undefined ? opts.syncCfg : ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: entries, updatedAt: '' }),
    appendHistoryFn: async (e) => { entries.push(e); },
    ...(opts.mutationLock !== undefined ? { mutationLock: opts.mutationLock } : {}),
    // 测试不用真实定时器：不调 start()
  });
  return { scheduler, runs, getConfig: () => config, getEntries: () => entries };
}

/** issue #31：模拟 acquire 被判 stale 的锁端口（真实 manager 在残留锁下返回同一状态）。 */
function staleLockPort(detail = 'owner pid=24140 确证不存在 (heartbeat expired)'): MutationLockPort {
  return {
    acquire: async () => ({ state: 'STALE_LOCK_DETECTED', token: null, detail }),
    validate: (tok: unknown): tok is MutationLockToken => false,
    release: async () => undefined,
  };
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

test('runOnce: 未配置的云端点通道（s3/gist）→ skipped(unconfigured)，不抛错、不构造引擎（安静跳过）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  let engineBuilt = false;
  for (const channel of ['s3', 'gist'] as const) {
    const scheduler = new AutoSyncScheduler({
      syncDir: '/tmp',
      host: { log: nullLogger() },
      makeSyncEngine: () => { engineBuilt = true; return {} as SyncEngine },
      msg: (k: string) => k,
      runs: new RunRegistry(),
      now: () => new Date(1_000_000_000_000),
      readConfig: async () => cfg,
      writeConfig: async () => {},
      // 云端点通道未配置：host 的 readSyncConfigFor 返回 null（配置住在 sync-cloud-config.json）
      readSyncConfigFn: async () => null,
      readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
      appendHistoryFn: async () => {},
    });
    const result = await scheduler.runOnce(channel);
    assert.equal(result.status, 'skipped', channel + '：未配置必须安静跳过而不是报错');
    assert.equal(result.skipReason, 'unconfigured');
  }
  assert.equal(engineBuilt, false, '未配置通道绝不构造同步引擎（不空转、不抛错）');
});

test('syncIsConfigured：云端点通道按必填字段判定（缺项 = 未配置）；git/webdav 口径不变', () => {
  assert.equal(syncIsConfigured(null), false);
  // s3：桶 + AccessKey ID 必填
  assert.equal(syncIsConfigured({
    schemaVersion: 2, transport: 's3',
    s3: { provider: 's3', endpoint: '', region: '', bucket: '', accessKeyId: '' },
  }), false);
  assert.equal(syncIsConfigured({
    schemaVersion: 2, transport: 's3',
    s3: { provider: 'oss', endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'b', accessKeyId: 'k' },
  }), true);
  // gist：gistId 必填
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'gist', gist: { gistId: '' } }), false);
  assert.equal(syncIsConfigured({ schemaVersion: 2, transport: 'gist', gist: { gistId: 'aa5a315d61ae9438b18d' } }), true);
});

// ---------- issue #31：被锁挡下必须留痕（历史 + 指引），不能静默 ----------

test('runOnce: 残留锁挡住 → skipped(mutation-locked) 且**写历史**（issue #31：此前连历史都不写）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const { scheduler, getEntries, getConfig } = makeScheduler({
    cfg, engine: {}, history: [], mutationLock: staleLockPort(),
  });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'mutation-locked');
  const entries = getEntries();
  assert.equal(entries.length, 1, '被锁挡下必须留一条历史（否则用户只看得到「自动同步不再更新」）');
  assert.equal(entries[0]!.status, 'skipped');
  assert.equal(entries[0]!.skipReason, 'mutation-locked');
  assert.equal(entries[0]!.transport, 'git');
  assert.equal(getConfig().consecutiveFailures, 0, '被锁挡下不计入连续失败');
});
/**
 * 真机 bug 回归护栏（2026-09）：被锁挡下的两条早退路径必须**收敛 run 账**。
 *
 * 现场证据：sync-history 记下 `skipped / mutation-locked @19:30:45.104`，同刻注册的 run 25 分钟后
 * 仍 updatedAt == createdAt → 运行中心「自动同步一直在加载」，且此后每次 autosync 都
 * register → RunConflictError → 后台同步静默停摆。
 */
test('runOnce: 被锁挡下（stale）不得泄漏 running run —— 否则后台同步永久停摆', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const { scheduler, runs } = makeScheduler({ cfg, engine: {}, history: [], mutationLock: staleLockPort() });
  await scheduler.runOnce('git');
  assert.deepEqual(runs.listActive(), [], '被锁挡下后不得留下 running run（泄漏会挡住后续每一次 autosync）');
  // 反向控制：泄漏时这个断言必须变红（run 仍在 running）
  const again = await scheduler.runOnce('git');
  assert.equal(again.skipReason, 'mutation-locked', '第二次仍是被锁挡下，而不是 conflict');
});

test('runOnce: acquire 抛错（锁目录 IO）同样不得泄漏 running run', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const throwingPort = {
    acquire: async () => { throw new Error('lock dir IO error') },
    validate: () => false,
    release: async () => {},
  } as unknown as Parameters<typeof makeScheduler>[0]['mutationLock'];
  const { scheduler, runs } = makeScheduler({ cfg, engine: {}, history: [], mutationLock: throwingPort });
  await scheduler.runOnce('git');
  assert.deepEqual(runs.listActive(), [], 'acquire 抛错的路径同样必须收敛 run 账');
});

test('runOnce: 残留锁挡住 → 日志给出与 423 同源的 stale 指引（重试/重启无效 + 回收方式）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const lines: Array<{ level: string; message: string }> = [];
  const { scheduler } = makeScheduler({
    cfg, engine: {}, history: [], mutationLock: staleLockPort(),
    logSink: (level, message) => { lines.push({ level, message }); },
  });
  await scheduler.runOnce('git');
  const staleLine = lines.find((l) => l.message.includes('自动同步已跳过'));
  assert.ok(staleLine !== undefined, `应有跳过日志: ${JSON.stringify(lines)}`);
  assert.match(staleLine!.message, /残留/);
  assert.match(staleLine!.message, /recover-stale-lock/, '必须给出可执行的回收方式');
  assert.equal(staleLine!.message.includes('24140'), false, 'owner pid 属内部诊断，不得进用户文案');
});

test('issue #31 D：acquire 本身抛错（锁目录 IO）同样必须写历史，不得静默跳过', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  // 端口「已配置但 acquire 抛错」：模拟锁目录 IO/权限故障
  const throwingPort = {
    acquire: async () => { throw new Error('lock dir IO error') },
    validate: () => false,
    release: async () => {},
  } as unknown as Parameters<typeof makeScheduler>[0]['mutationLock'];
  const { scheduler, getEntries, getConfig } = makeScheduler({
    cfg, engine: {}, history: [], mutationLock: throwingPort,
  });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'mutation-locked');
  assert.equal(getEntries().length, 1, 'acquire 抛错也是「被挡」，同样要留历史');
  assert.equal(getEntries()[0]!.skipReason, 'mutation-locked');
  assert.equal(getConfig().consecutiveFailures, 0, '不计入连续失败');
});

test('runOnce: 历史记录携带触发通道（transport=调用通道 git/webdav）', async () => {  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  // 两端无变化 → upToDate 成功历史（走 appendHistory）
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => false,
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  await scheduler.runOnce('git');
  let entries = getEntries();
  assert.ok(entries.some((e) => e.transport === 'git' && e.skipReason === 'upToDate'), `git 通道历史应带 transport=git: ${JSON.stringify(entries)}`);
  await scheduler.runOnce('webdav');
  entries = getEntries();
  assert.ok(entries.some((e) => e.transport === 'webdav' && e.skipReason === 'upToDate'), 'webdav 通道历史应带 transport=webdav');
  // 全部历史条目都应携带 channel
  for (const e of entries) assert.ok(e.transport === 'git' || e.transport === 'webdav', `历史必须带 transport: ${JSON.stringify(e)}`);
});

test('runOnce: 缺省远端检测复用本轮列表（一轮至多一次远端 list，不再白跑一次网络往返）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const metas: SyncSnapshotMeta[] = [{
    id: 'sync-001',
    createdAt: '2026-08-16T12:00:00.000Z',
    sections: {},
    manifest: {
      schemaVersion: 3, dshVersion: '0.0.0', platform: 'win32',
      sectionIds: [], containsSecrets: false, encrypted: false,
    },
  }];
  let listCalls = 0;
  let seenListed: unknown = 'not-called';
  const engine = {
    listSnapshots: async () => { listCalls += 1; return metas; },
    hasNewRemoteSnapshot: async (listed?: unknown) => { seenListed = listed; return false; },
    hasLocalChanges: async () => false,
  };
  const { scheduler } = makeScheduler({ cfg, engine, history: [] });
  await scheduler.runOnce('git');
  assert.equal(listCalls, 1, '查加密快照已 list 过一次 → 检测必须复用，不得再 list');
  assert.equal(seenListed, metas, '本轮列表要按引用原样透传给检测');
});

test('runOnce: 列表拿不到（网络失败）时检测回退自己 list，行为与改造前一致', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  let detectCalls = 0;
  let seenListed: unknown = 'not-called';
  const engine = {
    listSnapshots: async () => { throw new Error('network down'); },
    hasNewRemoteSnapshot: async (listed?: unknown) => { detectCalls += 1; seenListed = listed; return false; },
    hasLocalChanges: async () => false,
  };
  const { scheduler, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(detectCalls, 1, '列表失败不阻断检测');
  assert.equal(seenListed, undefined, '没有可用列表 → 传 undefined，让引擎自己 list');
  assert.equal(result.status, 'success');
  assert.equal(result.skipReason, 'upToDate');
  assert.equal(getEntries().length, 1);
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
  // issue #79：连续失败计数只统计「真的失败」——未配置属跳过，必须归零（此前保持 1，
  // 面板于是长期显示「连续失败 N 次」，把用户引向网络排查）
  assert.equal(result.consecutiveFailures, 0, '未配置不算失败 → 计数归零');
  assert.equal(getConfig().consecutiveFailures, 0);
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

test('issue #79 + conflictPolicy=local（缺省）：冲突只挡下行，本机版本强制推成新远端（partial，不谎报 success/failed）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 1 };
  const applyCalls: string[] = [];
  const pushCalls: Array<{ force?: boolean } | undefined> = [];
  const engine = {
    hasNewRemoteSnapshot: async () => true,
    hasLocalChanges: async () => true,
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'conflict']]),
    applyMergePlan: async () => {
      applyCalls.push('apply');
      return { ok: true, applied: [] as never[], restoreId: 'r1', rolledBack: false, review: [], warnings: [] };
    },
    push: async (opts?: { force?: boolean }) => {
      pushCalls.push(opts);
      return { ok: true, snapshotId: 'snap-up', sections: [] as never, warnings: [] };
    },
  };
  const { scheduler, getConfig, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'partial', '上行成功 + 下行被冲突挡下 → partial');
  assert.equal(result.skipReason, 'conflict-kept-local', '本机已按策略覆盖远端，与「待人工裁决」区分开');
  assert.deepEqual(result.conflictedSections, ['settings']);
  assert.equal(result.pushedSnapshotId, 'snap-up', '本机快照仍有上行出口（issue #79 主诉）');
  assert.equal(applyCalls.length, 0, '冲突绝不写本机配置');
  assert.equal(pushCalls.length, 1, '纯上行不被冲突连坐');
  assert.equal(pushCalls[0]?.force, true, 'local 策略下必须带上 force，否则引擎会因「远端已推进」拒绝上传');
  assert.equal(result.consecutiveFailures, 0, '冲突跳过不是失败 → 计数归零');
  assert.equal(getConfig().lastRunSkipReason, 'conflict-kept-local', '跳过原因落到状态（界面按码取字典）');
  assert.equal(getConfig().lastRunSkipCount, 1);
  assert.ok(getEntries().some((e) => e.status === 'partial' && e.skipReason === 'conflict-kept-local'), '写入 partial 历史');
  assert.ok(getEntries().some((e) => e.pushedSnapshotId === 'snap-up'), '历史带上行快照 id');
});

test('issue #79 + conflictPolicy=ask：冲突只挡下行，绝不强推覆盖远端（partial + skipped 码 conflict）', async () => {
  const cfg: AutosyncConfig = {
    enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 1,
    conflictPolicy: 'ask',
  };
  const applyCalls: string[] = [];
  const pushCalls: Array<{ force?: boolean } | undefined> = [];
  const engine = {
    hasNewRemoteSnapshot: async () => true,
    hasLocalChanges: async () => true,
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'conflict']]),
    applyMergePlan: async () => {
      applyCalls.push('apply');
      return { ok: true, applied: [] as never[], restoreId: 'r1', rolledBack: false, review: [], warnings: [] };
    },
    push: async (opts?: { force?: boolean }) => {
      pushCalls.push(opts);
      return { ok: true, snapshotId: 'snap-up', sections: [] as never, warnings: [] };
    },
  };
  const { scheduler, getConfig } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'partial');
  assert.equal(result.skipReason, 'conflict', 'ask 策略保留「待裁决」语义');
  assert.equal(pushCalls[0]?.force, undefined, 'ask 策略绝不 force 覆盖远端');
  assert.equal(applyCalls.length, 0, '冲突绝不写本机配置');
  assert.equal(getConfig().lastRunSkipReason, 'conflict');
});

test('issue #79：冲突且本机无改动（非 startup）→ skipped(conflict) 且不带 push', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const pushCalls: string[] = [];
  const engine = {
    hasNewRemoteSnapshot: async () => true,
    hasLocalChanges: async () => false,
    merge: async (): Promise<MergePlan> => makeMergePlan([['settings', 'conflict']]),
    push: async () => { pushCalls.push('push'); return { ok: true, snapshotId: 'x', sections: [] as never, warnings: [] }; },
  };
  const { scheduler, getConfig } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'conflict');
  assert.equal(pushCalls.length, 0, '本地无改动不上传');
  assert.equal(getConfig().lastRunMessage ?? '', '', '本轮跳过不得残留上一轮的错误文案');
  assert.equal(getConfig().lastRunSkipReason, 'conflict');
});

test('issue #79：本轮成功必须清掉上一轮的错误文案与跳过码（陈旧信息不再挂面板）', async () => {
  const cfg: AutosyncConfig = {
    enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 2,
    lastRunMessage: 'git pull 失败: ssh: connect to host 192.168.10.x port 2222: Connection timed out',
    lastRunSkipReason: 'mutation-locked',
    lastRunSkipCount: 7,
  };
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => true,
    push: async () => ({ ok: true, snapshotId: 'snap-clean', sections: [] as never, warnings: [] }),
  };
  const { scheduler, getConfig } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'success');
  const saved = getConfig();
  assert.equal(saved.lastRunMessage, '', '成功即清空旧错误文案');
  assert.equal(saved.lastRunSkipReason, undefined, '成功即清空旧跳过码');
  assert.equal(saved.lastRunSkipCount, undefined);
  assert.equal(saved.consecutiveFailures, 0, '成功归零连续失败');
});

test('push 被远端推进检测拒绝（conflict）→ skipped(conflict) 而非 failed；不累加连续失败、历史留下引擎说明', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 2 };
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => true,
    push: async () => ({
      ok: false, snapshotId: '', sections: [] as never, warnings: [],
      conflict: true,
      message: '远端最新快照 sync-other 与本地基线 sync-base 不一致：本次推送未执行',
    }),
  };
  const { scheduler, getConfig, getEntries } = makeScheduler({ cfg, engine, history: [] });
  const result = await scheduler.runOnce('git');
  assert.equal(result.status, 'skipped', '有冲突待处理 ≠ 同步坏了');
  assert.equal(result.skipReason, 'conflict');
  assert.equal(result.consecutiveFailures, 0, '冲突跳过不计失败（否则会误发「连续失败」通知）');
  assert.ok((result.error ?? '').includes('sync-other'), '必须把引擎的说明带给用户: ' + (result.error ?? ''));
  assert.equal(getConfig().lastRunStatus, 'skipped');
  assert.equal(getConfig().lastRunSkipReason, 'conflict');
  assert.ok(
    getEntries().some((e) => e.status === 'skipped' && e.skipReason === 'conflict' && (e.error ?? '').includes('sync-other')),
    '历史里必须能看出「有远端冲突待合并」',
  );
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
  // realtime:false 关掉「远端轮询定时器」，本用例只测 interval 兜底排期与重排（每个通道 1 个定时器）。
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
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
  // realtime:false → 只有 interval 兜底定时器（realtime 时每通道还会多一个远端轮询定时器）。
  const gitCfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
  const webdavCfg: AutosyncConfig = { enabled: true, interval: '5m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
  // 全通道配置由唯一枚举派生（新增通道不得手写漏项）；其余通道保持默认关闭
  const configs = {} as Record<SyncTransportType, AutosyncConfig>;
  for (const ch of SYNC_CHANNELS) {
    configs[ch] = { enabled: false, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
  }
  configs.git = gitCfg;
  configs.webdav = webdavCfg;
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
/* ---------------- t32：通道枚举唯一来源 ---------------- */

test('t32：排期覆盖 SYNC_CHANNELS 的每个通道（长度取自枚举，不硬编码 2；此前同一数组写两遍）', async () => {
  const seen: SyncTransportType[] = [];
  const pending: Array<() => void> = [];
  let timerSeq = 0;
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => ({}) as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async (channel: SyncTransportType) => {
      seen.push(channel);
      // realtime:false → 每个通道只排一个 interval 定时器，断言直接对应「通道数」。
      return { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
    },
    writeConfig: async () => {},
    readSyncConfigFn: async () => null,
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
    setTimer: (fn) => { pending.push(fn); timerSeq += 1; return String(timerSeq) as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...new Set(seen)].sort(), [...SYNC_CHANNELS].sort(), '每个通道都被请求过配置（refreshTimers + startupRuns 两处都不漏）');
  assert.equal(pending.length, SYNC_CHANNELS.length, '排期数 = 枚举长度（不得硬编码 2）');
  scheduler.stop();
});

/* ---------------- m-autosync-realtime：即时通道（本地改动监听 + 远端轮询） ---------------- */

interface RealtimeHarness {
  scheduler: AutoSyncScheduler;
  timers: Array<() => void>;
  /** 模拟监听器发现本地改动 */
  fireLocalChange: (changed?: readonly string[]) => void;
  /** 监听器生命周期（started/stopped/suspended/resumed 计数） */
  watcher: { started: boolean; stopped: boolean; suspended: number; resumed: number };
  engineCalls: { merge: number; push: number };
  /** 推进夹具时钟（间隔下限的判定依赖真实时间流逝） */
  advance: (ms: number) => void;
}

function makeRealtimeScheduler(cfg: AutosyncConfig, opts: { minTriggerGapMs?: number } = {}): RealtimeHarness {
  const timers: Array<() => void> = [];
  const watcher = { started: false, stopped: false, suspended: 0, resumed: 0 };
  const engineCalls = { merge: 0, push: 0 };
  let flush: ((changed: readonly string[]) => void) | null = null;
  let clockMs = 1_000_000_000_000;
  const engine = {
    hasNewRemoteSnapshot: async () => false,
    hasLocalChanges: async () => true,
    merge: async (): Promise<MergePlan> => { engineCalls.merge += 1; return makeMergePlan([]); },
    push: async () => {
      engineCalls.push += 1;
      return { ok: true, snapshotId: 'snap-' + engineCalls.push, sections: [] as never, warnings: [] };
    },
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => engine as unknown as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(clockMs),
    // 只有 git 通道开启：其余通道回退 enabled:false，否则 refreshTimers 会给四个通道都排定时器
    readConfig: async (channel) => (channel === 'git' ? cfg : { ...cfg, enabled: false }),
    writeConfig: async () => {},
    readSyncConfigFn: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
    setTimer: (fn) => { timers.push(fn); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
    homeDir: '/home/u/.dsh',
    minTriggerGapMs: opts.minTriggerGapMs ?? 3000,
    makeWatcher: (wopts) => {
      flush = wopts.onFlush;
      return {
        start: () => { watcher.started = true; },
        stop: () => { watcher.stopped = true; },
        setTargets: () => {},
        suspend: () => { watcher.suspended += 1; },
        resume: () => { watcher.resumed += 1; },
        isStarted: () => watcher.started,
        attachmentCount: () => 1,
        flushNow: () => {},
      } as never;
    },
  });
  return {
    scheduler, timers, watcher, engineCalls,
    advance: (ms: number) => { clockMs += ms; },
    fireLocalChange: (changed = ['settings.yaml']) => {
      assert.ok(flush !== null, '监听器尚未创建（start() 未跑或 realtime 关闭）');
      flush!(changed);
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('realtime：本地改动 → 立刻触发一轮（不等 interval），runOnce 期间挂起监听、结束后恢复', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  // gap 归零：本用例只测「监听回调 → 立刻跑一轮」，间隔合并另有用例
  const h = makeRealtimeScheduler(cfg, { minTriggerGapMs: 0 });
  h.scheduler.start();
  await tick();
  await tick();
  assert.equal(h.watcher.started, true, '开启实时同步必须挂上本地改动监听');
  const pushesBefore = h.engineCalls.push;
  const suspendedBefore = h.watcher.suspended;
  const resumedBefore = h.watcher.resumed;
  h.fireLocalChange();
  await tick();
  await tick();
  assert.equal(h.engineCalls.push, pushesBefore + 1, '本地一改就上行（不必等 24h 兜底定时器）');
  assert.equal(h.watcher.suspended, suspendedBefore + 1, '同步自家写入必须被挂起，否则自激');
  assert.equal(h.watcher.resumed, resumedBefore + 1, '收尾必须恢复监听');
  h.scheduler.stop();
  assert.equal(h.watcher.stopped, true, 'stop() 必须关掉监听');
});

test('realtime：间隔下限（minTriggerGapMs）内的第二次触发排成延迟触发，不丢改动', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const h = makeRealtimeScheduler(cfg, { minTriggerGapMs: 3000 });
  h.scheduler.start();
  await tick();
  await tick();
  const before = h.timers.length;
  const pushesBefore = h.engineCalls.push;
  h.fireLocalChange(['settings.yaml']);
  await tick();
  assert.equal(h.engineCalls.push, pushesBefore, '距上轮不足 gap 时不得立刻再跑（避免连续保存打满远端）');
  assert.equal(h.timers.length, before + 1, 'gap 内触发必须排一个延迟定时器（绝不丢用户改动）');
  // 同一通道再来一次：复用同一枚定时器（合并成一轮），不得堆积
  h.fireLocalChange(['skills']);
  await tick();
  assert.equal(h.timers.length, before + 1, '同一通道 gap 内只保留一枚定时器（连续保存合并成一轮）');
  const gapTimer = h.timers[h.timers.length - 1];
  assert.ok(gapTimer !== undefined);
  h.advance(3000); // 真实时间里这 3 秒是自然流逝的；夹具时钟被钉死，必须手动推进
  gapTimer();
  await tick();
  await tick();
  assert.equal(h.engineCalls.push, pushesBefore + 1, '延迟触发到点后必须补跑（两处改动合成一轮）');
  h.scheduler.stop();
});

test('realtime=false：不挂监听、不排远端轮询定时器（退回纯 interval 兜底）', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0, realtime: false };
  const h = makeRealtimeScheduler(cfg);
  h.scheduler.start();
  await tick();
  assert.equal(h.watcher.started, false, 'realtime 关闭时不得挂监听');
  assert.equal(h.timers.length, 1, '只排 interval 兜底定时器（无远端轮询）');
  h.scheduler.stop();
});

test('realtime：远端轮询定时器按 remoteCheckMs 排期，到点触发一轮后立刻重排', async () => {
  const cfg: AutosyncConfig = {
    enabled: true, interval: '24h', startupMinIntervalMs: 300000, consecutiveFailures: 0,
    remoteCheckMs: 60_000,
  };
  const h = makeRealtimeScheduler(cfg);
  h.scheduler.start();
  await tick();
  // interval 兜底 1 个 + 远端轮询 1 个
  assert.equal(h.timers.length, 2, '每通道排 interval + 远端轮询两枚定时器');
  const poll = h.timers[1];
  assert.ok(poll !== undefined);
  poll();
  await tick();
  await tick();
  assert.ok(h.timers.length >= 3, '轮询到点后必须立刻重排下一次');
  h.scheduler.stop();
});

