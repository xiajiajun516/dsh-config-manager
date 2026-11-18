/**
 * G 项单测：冲突扣下按分区隔离允许推非冲突分区 + 同一待裁决远端快照不再每轮重复全量下载。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import { AutoSyncScheduler } from './autosync-scheduler.ts';
import type { AutosyncConfig } from './autosync-config.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import { loadSyncState } from './sync-state.ts';
import { SyncEngine } from './sync-engine.ts';
import { computeSnapshotMeta, type SyncSnapshot, type SyncSnapshotMeta, type SyncTransport } from './transport.ts';

class CountingMemTransport implements SyncTransport {
  readonly type = 'git' as const;
  readonly snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  listCount = 0;
  downloadCount = 0;
  uploadCount = 0;

  async list(): Promise<SyncSnapshotMeta[]> {
    this.listCount += 1;
    return [...this.metas];
  }

  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.uploadCount += 1;
    const copy = structuredClone(snapshot);
    this.snapshots.set(copy.id, copy);
    const meta = computeSnapshotMeta(copy);
    this.metas.push(meta);
    return meta;
  }

  async download(id: string): Promise<SyncSnapshot> {
    this.downloadCount += 1;
    const hit = this.snapshots.get(id);
    if (!hit) throw new Error(`missing snapshot ${id}`);
    return structuredClone(hit);
  }

  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

function makeTestEngine(
  ctx: ReturnType<typeof makeContext>,
  transport: SyncTransport,
  stateDir: string,
  nextId: () => string,
): SyncEngine {
  const adapters = createAdapters({ namespaces: ['general'] }).filter(
    (a) => a.id === 'settings' || a.id === 'agentInstructions',
  );
  return new SyncEngine({
    ctx,
    adapters,
    importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
    transport,
    transportRef: 'mem://repo',
    stateDir,
    localSnapshotsDir: path.join(stateDir, 'local-snaps'),
    snapshotId: nextId,
  });
}

test('G 项(1)：冲突分区（settings）扣下时，非冲突本地改动（agentInstructions）必须成功上行，且远端/祖先均不丢失双侧信息', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-item-g1-'));
  t.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const ctxA = makeContext('win32', 'C:\\Users\\alice');
  const ctxB = makeContext('win32', 'C:\\Users\\bob');
  ctxA.settings.ns.set('general', { value: { theme: 'base' }, revision: 1, secrets: [] });
  await ctxA.fs.writeFile('AGENTS.md', Buffer.from('base rule\n'));
  ctxB.settings.ns.set('general', { value: { theme: 'base' }, revision: 1, secrets: [] });
  await ctxB.fs.writeFile('AGENTS.md', Buffer.from('base rule\n'));

  const transport = new CountingMemTransport();
  let seq = 0;
  const stateA = path.join(tmp, 'stateA');
  const stateB = path.join(tmp, 'stateB');
  const engA = makeTestEngine(ctxA, transport, stateA, () => `snap-a-${++seq}`);
  const engB = makeTestEngine(ctxB, transport, stateB, () => `snap-b-${++seq}`);

  // 基线：snap-a-1
  await engA.push({ snapshotId: 'snap-base' });
  // Device B 推进远端 snap-B（只改 settings）
  ctxB.settings.ns.set('general', { value: { theme: 'remote-v2' }, revision: 2, secrets: [] });
  await engB.push({ snapshotId: 'snap-B', force: true });

  // Device A 产生真冲突（settings=local-v2）+ 无冲突本地改动（AGENTS.md=local-clean）
  ctxA.settings.ns.set('general', { value: { theme: 'local-v2' }, revision: 2, secrets: [] });
  await ctxA.fs.writeFile('AGENTS.md', Buffer.from('local clean change\n'));

  transport.listCount = 0;
  transport.downloadCount = 0;
  transport.uploadCount = 0;

  let cfg: AutosyncConfig = {
    enabled: true, interval: '30m', startupMinIntervalMs: 300_000,
    consecutiveFailures: 0, realtime: true, conflictPolicy: 'ask',
  };
  const history: AutosyncHistoryEntry[] = [];
  const scheduler = new AutoSyncScheduler({
    syncDir: stateA,
    host: { log: nullLogger() },
    makeSyncEngine: () => makeTestEngine(ctxA, transport, stateA, () => `snap-a-${++seq}`),
    msg: (k, p) => k + (p ? JSON.stringify(p) : ''),
    runs: new RunRegistry(),
    readConfig: async () => cfg,
    writeConfig: async (_c, next) => { cfg = next; },
    readSyncConfigFn: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/a/b.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: history, updatedAt: '' }),
    appendHistoryFn: async (entry) => { history.push(entry as AutosyncHistoryEntry); },
  });

  // 1) Round 1：混合冲突轮必须推上去 agentInstructions，同时扣下 settings
  const r1 = await scheduler.runOnce('git', { reason: 'local-change' });
  assert.equal(r1.status, 'partial');
  assert.equal(r1.skipReason, 'conflict');
  assert.deepEqual(r1.conflictedSections, ['settings']);
  assert.ok(r1.pushedSnapshotId && r1.pushedSnapshotId !== '', '非冲突分区必须生成远端快照');
  assert.equal(transport.uploadCount, 1, '非冲突分区必须完成上行');
  assert.equal(transport.downloadCount, 1, 'merge 只下载 1 次，push 复用该快照零额外下载');

  // 远端最新快照同时包含：A 推的非冲突 agentInstructions + B 的 settings（未被 A 丢弃或覆盖）
  const uploaded = transport.snapshots.get(r1.pushedSnapshotId!)!;
  const upSections = uploaded.sections as Record<string, unknown>;
  assert.ok(upSections['agentInstructions'] !== undefined);
  assert.equal(
    (upSections['settings'] as { namespaces?: { general?: { value?: { theme?: string } } } })?.namespaces?.general?.value?.theme,
    'remote-v2',
    '被扣下的 settings 必须沿用远端 version（remote-v2），不得被本地 local-v2 覆盖或从快照抹掉',
  );
  // Device A 本机冲突值保留不动，且预览合并仍能精确看到 3-way 冲突（ancestor=base, local=local-v2, remote=remote-v2）
  assert.equal((ctxA.settings.ns.get('general')?.value as { theme?: string } | undefined)?.theme, 'local-v2');
  const preview = await engA.previewMerge();
  const previewSettings = preview.sections.find((s) => s.id === 'settings');
  assert.equal(previewSettings?.decision, 'conflict', '扣下分区在后续人工裁决视图中仍为 conflict');
  assert.equal(preview.sections.find((s) => s.id === 'agentInstructions')?.decision, 'skip', '已推送的非冲突分区已对齐');

  // 2) 后续多轮 remote-poll 与 interval：零重复下载、零空上传
  const dlAfterR1 = transport.downloadCount;
  const ulAfterR1 = transport.uploadCount;
  await scheduler.runOnce('git', { reason: 'remote-poll' });
  await scheduler.runOnce('git', { reason: 'remote-poll' });
  const rInterval = await scheduler.runOnce('git', { reason: 'interval' });
  assert.equal(transport.downloadCount, dlAfterR1, '后续轮次不得重复 download');
  assert.equal(transport.uploadCount, ulAfterR1, '仅被扣分区有本机改动时不得空推');
  assert.equal(rInterval.status, 'skipped');
  assert.equal(rInterval.skipReason, 'all-conflicted');
});

test('G 项(2)：仅冲突分区改动（无非冲突改动）→ 首轮落 pendingMerge；后续 5m remote-poll 零重复下载；远端推进后恢复拉取', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-item-g2-'));
  t.after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  const ctxA = makeContext('win32', 'C:\\Users\\alice');
  const ctxB = makeContext('win32', 'C:\\Users\\bob');
  ctxA.settings.ns.set('general', { value: { theme: 'base' }, revision: 1, secrets: [] });
  await ctxA.fs.writeFile('AGENTS.md', Buffer.from('base rule\n'));
  ctxB.settings.ns.set('general', { value: { theme: 'base' }, revision: 1, secrets: [] });
  await ctxB.fs.writeFile('AGENTS.md', Buffer.from('base rule\n'));

  const transport = new CountingMemTransport();
  const stateA = path.join(tmp, 'stateA');
  const stateB = path.join(tmp, 'stateB');
  let seq = 0;
  const engA = makeTestEngine(ctxA, transport, stateA, () => `snap-a-${++seq}`);
  const engB = makeTestEngine(ctxB, transport, stateB, () => `snap-b-${++seq}`);

  await engA.push({ snapshotId: 'snap-base' });
  ctxB.settings.ns.set('general', { value: { theme: 'remote-v2' }, revision: 2, secrets: [] });
  await engB.push({ snapshotId: 'snap-B', force: true });
  // Device A 仅改了有冲突的 settings（无任何非冲突本地改动）
  ctxA.settings.ns.set('general', { value: { theme: 'local-v2' }, revision: 2, secrets: [] });

  transport.downloadCount = 0;
  transport.uploadCount = 0;
  let cfg: AutosyncConfig = {
    enabled: true, interval: '30m', startupMinIntervalMs: 300_000,
    consecutiveFailures: 0, realtime: true, conflictPolicy: 'ask',
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: stateA,
    host: { log: nullLogger() },
    makeSyncEngine: () => makeTestEngine(ctxA, transport, stateA, () => `snap-a-${++seq}`),
    msg: (k, p) => k + (p ? JSON.stringify(p) : ''),
    runs: new RunRegistry(),
    readConfig: async () => cfg,
    writeConfig: async (_c, next) => { cfg = next; },
    readSyncConfigFn: async () => ({ schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/a/b.git' } }),
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: [], updatedAt: '' }),
    appendHistoryFn: async () => {},
  });

  // Round 1：发现冲突并落盘 pendingMerge，无非冲突改动故跳过上传
  const r1 = await scheduler.runOnce('git', { reason: 'local-change' });
  assert.equal(r1.status, 'skipped');
  assert.equal(r1.skipReason, 'conflict');
  assert.equal(transport.downloadCount, 1);
  assert.equal(transport.uploadCount, 0);
  const st = await loadSyncState(stateA);
  assert.equal(st.pendingMerge?.remoteSnapshotId, 'snap-B');

  // Round 2 & Round 3（remote-poll）：同一份 snap-B 不再重复下载
  const p1 = await scheduler.runOnce('git', { reason: 'remote-poll' });
  const p2 = await scheduler.runOnce('git', { reason: 'remote-poll' });
  assert.equal(p1.status, 'skipped');
  assert.equal(p1.skipReason, 'conflict');
  assert.equal(p2.skipReason, 'conflict');
  assert.equal(transport.downloadCount, 1, '同一待裁决快照 snap-B 在 remote-poll 下不得重复全量下载');

  // 负例控制：远端一旦出现新快照 snap-C，下次 remote-poll 必须立刻重新下载合并
  ctxB.settings.ns.set('general', { value: { theme: 'remote-v3' }, revision: 3, secrets: [] });
  await engB.push({ snapshotId: 'snap-C', force: true });
  await scheduler.runOnce('git', { reason: 'remote-poll' });
  assert.equal(transport.downloadCount, 2, '远端推进至 snap-C 后必须重新下载评估');

  // 正向安全控制：未经评估的新远端下，盲调 engine.push() 仍被 §7.4 precheck 拒绝
  const uploadsBeforeBlind = transport.uploadCount;
  const blind = await engA.push({ snapshotId: 'blind-push' });
  assert.equal(blind.ok, false);
  assert.equal(blind.conflict, true);
  assert.equal(transport.uploadCount, uploadsBeforeBlind);
});
