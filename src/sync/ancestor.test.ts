/**
 * m-sync-flow：ancestor 存储助手测试。
 * - loadAncestor: 存在返回 SyncSnapshot；不存在抛错
 * - writeAncestor: 写出目录能被 readSnapshotFromDir 完整读回，分区 hash 一致
 * - pruneAncestors: 仅删超出 keep 的最旧副本；保留集合完整无损
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadAncestor, pruneAncestors, writeAncestor, DEFAULT_ANCESTOR_KEEP } from './ancestor.ts';
import { hashSection, loadSyncState, saveSyncState } from './sync-state.ts';
import type { SectionData, FilesSection } from '../schema/types.ts';
import type { SyncSnapshot } from './transport.ts';

/** 测试用明文快照：sections 恒为普通分区 Record（ancestor 测试不涉及加密载荷）。 */
type PlainSnapshot = SyncSnapshot & { sections: Record<string, SectionData> };

function mkSnapshot(id: string, createdAt: string, sections: SyncSnapshot['sections']): PlainSnapshot {
  return {
    id,
    createdAt,
    manifest: {
      schemaVersion: 1,
      dshVersion: 'test',
      platform: 'linux',
      sectionIds: Object.keys(sections) as SyncSnapshot['manifest']['sectionIds'],
      containsSecrets: false,
    },
    sections: sections as Record<string, SectionData>,
  };
}

test('loadAncestor: 存在 → 返回 SyncSnapshot（与 writeAncestor 写入一致）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ancestor-load-'));
  try {
    const snap = mkSnapshot('sync-1', '2026-08-16T10:00:00.000Z', {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } } as SectionData,
    });
    await writeAncestor(dir, snap);
    const loaded = (await loadAncestor(dir, 'sync-1')) as unknown as PlainSnapshot;
    assert.equal(loaded.id, 'sync-1');
    assert.equal(loaded.createdAt, '2026-08-16T10:00:00.000Z');
    assert.equal(loaded.sections.settings && hashSection(loaded.sections.settings as SectionData), hashSection(snap.sections.settings as SectionData));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loadAncestor: 不存在 → 抛错（不静默降级）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ancestor-missing-'));
  try {
    await assert.rejects(() => loadAncestor(dir, 'sync-nonexistent'));
    await assert.rejects(() => loadAncestor(dir, ''), /snapshotId/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('writeAncestor: 写出目录可被 readSnapshotFromDir 读回，分区 hash 一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ancestor-write-'));
  try {
    const files: FilesSection = {
      version: 1,
      files: [
        { relativePath: 'a.md', data: new TextEncoder().encode('# A\n'), contentHash: '' },
        { relativePath: 'b/skill.md', data: new TextEncoder().encode('# B\n'), contentHash: '' },
      ],
    };
    const snap = mkSnapshot('sync-2', '2026-08-16T11:00:00.000Z', { skills: files as unknown as SectionData });
    await writeAncestor(dir, snap);
    const loaded = (await loadAncestor(dir, 'sync-2')) as unknown as PlainSnapshot;
    assert.equal(hashSection(loaded.sections.skills as SectionData), hashSection(files as unknown as SectionData));
    assert.equal((loaded.sections.skills as FilesSection).files.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('pruneAncestors: 仅删超出 keep 的最旧副本；保留集合完整无损', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ancestor-prune-'));
  try {
    for (let i = 0; i < 12; i++) {
      const t = `2026-08-16T10:0${i % 10}:00.000Z`.replace('10:00', `10:${String(i).padStart(2, '0')}`);
      const iso = i < 10
        ? `2026-08-16T10:0${i}:00.000Z`
        : `2026-08-16T10:${i}:00.000Z`;
      const snap = mkSnapshot(`sync-${String(i).padStart(2, '0')}`, iso, {
        settings: { version: 1, namespaces: {} } as SectionData,
      });
      await writeAncestor(dir, snap);
    }
    const removed = await pruneAncestors(dir, 10);
    assert.equal(removed.length, 2, '12 - 10 = 2 个最旧被删');
    assert.equal(removed[0], 'sync-00');
    assert.equal(removed[1], 'sync-01');
    // 剩余 10 个仍在
    for (let i = 2; i < 12; i++) {
      const loaded = await loadAncestor(dir, `sync-${String(i).padStart(2, '0')}`);
      assert.equal(loaded.id, `sync-${String(i).padStart(2, '0')}`);
    }
    await assert.rejects(() => loadAncestor(dir, 'sync-00'));
    await assert.rejects(() => loadAncestor(dir, 'sync-01'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('pruneAncestors: keep<=0 视为保留全部', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ancestor-prune0-'));
  try {
    for (let i = 0; i < 3; i++) {
      const snap = mkSnapshot(`s-${i}`, `2026-08-16T10:0${i}:00.000Z`, {
        settings: { version: 1, namespaces: {} } as SectionData,
      });
      await writeAncestor(dir, snap);
    }
    const removed = await pruneAncestors(dir, 0);
    assert.equal(removed.length, 0);
    for (let i = 0; i < 3; i++) {
      const loaded = await loadAncestor(dir, `s-${i}`);
      assert.equal(loaded.id, `s-${i}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('DEFAULT_ANCESTOR_KEEP 默认值符合规划（10）', () => {
  assert.equal(DEFAULT_ANCESTOR_KEEP, 10);
});

// 同时验证 sync-state 在 v2 下 lastSnapshotId 可被 save/load 完整往返（与 M1 互补）
test('saveSyncState + loadSyncState: 写入 v2 含 lastSnapshotId 往返完整（与 M1 互补验证）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-ancestor-rt-'));
  try {
    await saveSyncState(tmp, {
      schemaVersion: 2,
      lastSyncAt: '2026-08-16T12:00:00.000Z',
      sections: {},
      lastSnapshotId: 'sync-1',
    });
    const s = await loadSyncState(tmp);
    assert.equal(s.lastSnapshotId, 'sync-1');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// 抑制 unused import 警告（hashSection/saveSyncState 通过 M1 测试已用到，此处仅 import 即可）
void hashSection;
void saveSyncState;
void path;
