/**
 * 回归护栏（audit-sync **sync-F5**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * sync-F5（P2）：自动同步是唯一自动写本地的路径，此前用 buildAutoApplyPlan **无条件**应用
 * 全部非冲突分区（不查风险等级），而 risk.ts 的 classifyMergePlan 规定 medium/high → review。
 * 修复后：medium/high（及未注册分区）不得被自动应用；被扣下的分区必须进历史 conflictedSections
 * （可见，绝不静默）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AutoSyncScheduler } from './autosync-scheduler.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import type { AutosyncConfig } from './autosync-config.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import type { SyncEngine } from './sync-engine.ts';
import type { SyncConfig } from './sync-config.ts';

function section(id: string, decision: MergeSectionResult['decision']): MergeSectionResult {
  return { id: id as never, decision, conflicts: [], merged: { version: 1, namespaces: {} } as never };
}

const GIT_CFG: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } };

test('sync-F5：缺省 autoApplyTier=medium → plugins（中风险）自动落盘，不再挂起等人工', async () => {
  const cfg: AutosyncConfig = { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 };
  const entries: AutosyncHistoryEntry[] = [];
  const appliedPlans: string[][] = [];
  const engine = {
    // settings = low（应自动应用）；plugins = medium（必须留给人工确认）
    merge: async (): Promise<MergePlan> => ({ sections: [section('settings', 'useRemote'), section('plugins', 'useRemote')] }),
    applyMergePlan: async (plan: { autoApply: MergeSectionResult[] }) => {
      appliedPlans.push(plan.autoApply.map((s) => String(s.id)));
      return { ok: true, applied: plan.autoApply.map((s) => s.id), restoreId: 'r1', rolledBack: false, review: [], warnings: [] };
    },
    push: async () => ({ ok: true, snapshotId: 'snap-1', sections: [] as never, warnings: [] }),
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => engine as unknown as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async () => cfg,
    writeConfig: async () => undefined,
    readSyncConfigFn: async () => GIT_CFG,
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: entries, updatedAt: '' }),
    appendHistoryFn: async (e) => { entries.push(e); },
  });

  const result = await scheduler.runOnce('git');

  assert.deepEqual(appliedPlans, [['settings', 'plugins']], '缺省 medium 档：settings(low) 与 plugins(medium) 都可自动应用');
  assert.ok(!entries.some((e) => (e.conflictedSections ?? []).length > 0), '没有分区被扣下 → 不该产生待确认记录');
  assert.equal(result.status, 'success', '自动落盘中风险分区仍是一轮成功');
});

test('sync-F5：autoApplyTier=low → medium 风险分区（plugins）仍必须留给人工确认并进历史 conflictedSections', async () => {
  const cfg: AutosyncConfig = {
    enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0,
    autoApplyTier: 'low',
  };
  const entries: AutosyncHistoryEntry[] = [];
  const appliedPlans: string[][] = [];
  const engine = {
    merge: async (): Promise<MergePlan> => ({ sections: [section('settings', 'useRemote'), section('plugins', 'useRemote')] }),
    applyMergePlan: async (plan: { autoApply: MergeSectionResult[] }) => {
      appliedPlans.push(plan.autoApply.map((s) => String(s.id)));
      return { ok: true, applied: plan.autoApply.map((s) => s.id), restoreId: 'r1', rolledBack: false, review: [], warnings: [] };
    },
    push: async () => ({ ok: true, snapshotId: 'snap-1', sections: [] as never, warnings: [] }),
  };
  const scheduler = new AutoSyncScheduler({
    syncDir: '/tmp',
    host: { log: nullLogger() },
    makeSyncEngine: () => engine as unknown as SyncEngine,
    msg: (k: string) => k,
    runs: new RunRegistry(),
    now: () => new Date(1_000_000_000_000),
    readConfig: async () => cfg,
    writeConfig: async () => undefined,
    readSyncConfigFn: async () => GIT_CFG,
    readHistoryFn: async () => ({ schemaVersion: 1, autosyncEntries: entries, updatedAt: '' }),
    appendHistoryFn: async (e) => { entries.push(e); },
  });

  const result = await scheduler.runOnce('git');

  assert.deepEqual(appliedPlans, [['settings']], 'low 档下 medium 风险分区（plugins）绝不能被自动应用');
  const withSections = entries.find((e) => (e.conflictedSections ?? []).length > 0);
  assert.ok(withSections !== undefined, '被扣下的分区必须写进历史（可见，不静默）');
  assert.deepEqual(withSections!.conflictedSections, ['plugins']);
  assert.equal(result.status, 'success', '扣下中风险分区不等于整轮失败');
});
