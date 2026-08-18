/**
 * SyncSessionStore 测试：内存登记临时 ZIP + ImportPlan，TTL 30 分钟，惰性清理，同 id 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { SyncSessionStore } from './sync-session.ts';
import type { SyncConfig } from './sync-config.ts';
import type { ImportAnalysis, ImportPlan } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';

const GIT_CONFIG: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/foo/bar.git' } };

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function makePlan(seed: string): ImportPlan {
  return {
    items: [{ id: `item-${seed}`, kind: 'Update', adapter: 'settings', description: `desc-${seed}`, severity: 'info', target: { adapter: 'settings', ref: 'general' } }],
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: { settings: 1 } as unknown as Record<SectionId, number>,
  };
}

function makeAnalysis(seed: string): ImportAnalysis {
  return {
    valid: true,
    errors: [],
    warnings: [],
    compatibility: 'excellent',
    sectionsInZip: ['settings'] as SectionId[],
    pluginSummary: { installed: 0, toInstall: 0 },
    pathIssues: [],
    secretCount: 0,
    dependencyIssues: [],
    encrypted: false,
  };
}

function makeSession(store: SyncSessionStore, opts: { seed: string; nowMs?: number }): string {
  const now = opts.nowMs ?? Date.now();
  const id = crypto.randomUUID();
  store.set({
    id,
    zipPath: `/tmp/session-${opts.seed}.zip`,
    plan: makePlan(opts.seed),
    analysis: makeAnalysis(opts.seed),
    snapshotId: `snap-${opts.seed}`,
    config: GIT_CONFIG,
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
  });
  return id;
}

test('SyncSessionStore: set/get 往返；同 id 覆盖', () => {
  const store = new SyncSessionStore({ now: () => 5_000_000 });
  const id = makeSession(store, { seed: 'a', nowMs: 5_000_000 });
  const s1 = store.get(id);
  assert.ok(s1, 'get 应返回 session');
  assert.equal(s1!.zipPath, '/tmp/session-a.zip');
  assert.equal(s1!.plan.items[0]!.id, 'item-a');
  assert.equal(s1!.snapshotId, 'snap-a');

  // 同 id 覆盖（仍在有效期内）
  store.set({
    id,
    zipPath: '/tmp/session-b.zip',
    plan: makePlan('b'),
    analysis: makeAnalysis('b'),
    snapshotId: 'snap-b',
    config: GIT_CONFIG,
    createdAt: 5_000_000,
    expiresAt: 5_000_000 + DEFAULT_TTL_MS,
  });
  const s2 = store.get(id);
  assert.equal(s2!.zipPath, '/tmp/session-b.zip');
  assert.equal(s2!.plan.items[0]!.id, 'item-b');
  assert.equal(s2!.snapshotId, 'snap-b');
});

test('SyncSessionStore: get 过期条目 → undefined（惰性清理）', () => {
  const store = new SyncSessionStore();
  const now = 1_000_000;
  const id = crypto.randomUUID();
  store.set({
    id,
    zipPath: '/tmp/expired.zip',
    plan: makePlan('x'),
    analysis: makeAnalysis('x'),
    snapshotId: 'snap-x',
    config: GIT_CONFIG,
    createdAt: now - DEFAULT_TTL_MS - 1,
    expiresAt: now - 1,
  });
  const s = store.get(id);
  assert.equal(s, undefined, '过期条目应返回 undefined');
});

test('SyncSessionStore: delete 移除条目', () => {
  const store = new SyncSessionStore({ now: () => 5_000_000 });
  const id = makeSession(store, { seed: 'del', nowMs: 5_000_000 });
  assert.ok(store.get(id), 'set 后存在');
  store.delete(id);
  assert.equal(store.get(id), undefined, 'delete 后不存在');
});

test('SyncSessionStore: TTL 边界——过期临界点', () => {
  const store = new SyncSessionStore({ now: () => 2_000_000 });
  const now = 2_000_000;
  const id = crypto.randomUUID();
  // 恰好在 expiresAt（now === expiresAt）→ 视为过期（惰性清理）
  store.set({
    id,
    zipPath: '/tmp/boundary.zip',
    plan: makePlan('boundary'),
    analysis: makeAnalysis('boundary'),
    snapshotId: 'snap-b',
    config: GIT_CONFIG,
    createdAt: now - DEFAULT_TTL_MS,
    expiresAt: now,
  });
  assert.equal(store.get(id), undefined, 'expiresAt === now 视为过期');

  // 还差 1ms → 仍有效
  const id2 = crypto.randomUUID();
  store.set({
    id: id2,
    zipPath: '/tmp/boundary2.zip',
    plan: makePlan('boundary2'),
    analysis: makeAnalysis('boundary2'),
    snapshotId: 'snap-b2',
    config: GIT_CONFIG,
    createdAt: now - DEFAULT_TTL_MS,
    expiresAt: now + 1,
  });
  assert.ok(store.get(id2), 'expiresAt > now 仍应有效');
});
