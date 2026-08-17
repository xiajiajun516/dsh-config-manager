/**
 * m-sync-transport：sync-state.json 模型测试。
 * - hashSection：JSON 分区与文件类分区的内容 hash（确定性、键序无关、文件序无关）
 * - saveSyncState / loadSyncState：往返、缺省、schemaVersion 校验、损坏 JSON 拒绝
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hashSection, loadSyncState, saveSyncState, SYNC_STATE_FILE, SYNC_STATE_SCHEMA_VERSION } from './sync-state.ts';
import type { SyncState } from './sync-state.ts';
import type { FileEntry, SectionData } from '../schema/types.ts';

test('hashSection: JSON 分区确定性 + 键序无关（同一内容不同插入序 → 相同 hash）', () => {
  const a: SectionData = { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } };
  const b: SectionData = {
    namespaces: { general: { secrets: [], revision: 1, value: { theme: 'dark' } } },
    version: 1,
  } as unknown as SectionData;
  assert.equal(hashSection(a), hashSection(b), '键序无关');
  const c: SectionData = { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 1, secrets: [] } } };
  assert.notEqual(hashSection(a), hashSection(c), '内容变化 hash 必须变化');
  // 确定性：同对象多次调用
  assert.equal(hashSection(a), hashSection(a));
});

test('hashSection: 文件类分区确定性 + 文件序无关，内容变化 → hash 变化', () => {
  const mk = (files: { relativePath: string; data: Uint8Array; contentHash?: string }[]): SectionData => ({
    version: 1,
    files: files.map((f): FileEntry => ({ relativePath: f.relativePath, data: f.data, contentHash: f.contentHash ?? '' })),
  });
  const f1 = { relativePath: 'a.md', data: new TextEncoder().encode('# A\n') };
  const f2 = { relativePath: 'b/skill.md', data: new TextEncoder().encode('# B\n') };
  const x = hashSection(mk([f1, f2]));
  const y = hashSection(mk([f2, f1]));
  assert.equal(x, y, '文件数组顺序无关');
  const z = hashSection(mk([{ ...f1, data: new TextEncoder().encode('# A changed\n') }, f2]));
  assert.notEqual(x, z, '文件内容变化 hash 必须变化');
  // contentHash 字段不参与（以字节为准）
  const w = hashSection(mk([{ relativePath: f1.relativePath, data: f1.data, contentHash: 'trusted' }, f2]));
  assert.equal(x, w, 'contentHash 字段值不影响分区 hash');
});

test('hashSection: JSON 分区与文件类分区 hash 空间不冲突', () => {
  const jsonHash = hashSection({ version: 1, namespaces: {} } as SectionData);
  const fileHash = hashSection({ version: 1, files: [] } as SectionData);
  assert.notEqual(jsonHash, fileHash);
  assert.equal(jsonHash.length, 64);
  assert.equal(fileHash.length, 64);
});

test('saveSyncState / loadSyncState: 完整往返（含 transport 字段）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-'));
  try {
    const state: SyncState = {
      schemaVersion: SYNC_STATE_SCHEMA_VERSION,
      lastSyncAt: '2026-08-16T12:00:00.000Z',
      sections: {
        settings: { hash: 'a'.repeat(64), updatedAt: '2026-08-16T12:00:00.000Z' },
        skills: { hash: 'b'.repeat(64), updatedAt: '2026-08-16T12:00:00.000Z' },
      },
      transport: { type: 'git', ref: 'main' },
      lastSnapshotId: 'sync-abc',
    };
    await saveSyncState(tmp, state);
    const raw = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_STATE_SCHEMA_VERSION);
    assert.deepEqual(await loadSyncState(tmp), state);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadSyncState: 文件不存在 → 返回缺省空状态（lastSyncAt 为空串，lastSnapshotId 为空串）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-missing-'));
  try {
    const state = await loadSyncState(tmp);
    assert.equal(state.schemaVersion, SYNC_STATE_SCHEMA_VERSION);
    assert.equal(state.lastSyncAt, '');
    assert.equal(state.lastSnapshotId, '');
    assert.deepEqual(state.sections, {});
    assert.equal(state.transport, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadSyncState: 不支持的 schemaVersion → 拒绝', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-ver-'));
  try {
    await fs.writeFile(path.join(tmp, SYNC_STATE_FILE), JSON.stringify({ schemaVersion: 99, lastSyncAt: '', sections: {} }), 'utf8');
    await assert.rejects(() => loadSyncState(tmp), /schemaVersion/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadSyncState: 损坏 JSON → 拒绝（不静默降级）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-bad-'));
  try {
    await fs.writeFile(path.join(tmp, SYNC_STATE_FILE), '{not-json', 'utf8');
    await assert.rejects(() => loadSyncState(tmp));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('saveSyncState: 自动创建目录', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-mkdir-'));
  try {
    const dir = path.join(tmp, 'nested', 'sync');
    await saveSyncState(dir, { schemaVersion: SYNC_STATE_SCHEMA_VERSION, lastSyncAt: '', sections: {}, lastSnapshotId: '' });
    const state = await loadSyncState(dir);
    assert.equal(state.schemaVersion, SYNC_STATE_SCHEMA_VERSION);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('loadSyncState: v1 文件 → 内存迁移到 v2 形态（lastSnapshotId=""），不动磁盘', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-v1-'));
  try {
    // 写入一个 schemaVersion=1 的旧文件（缺 lastSnapshotId）
    await fs.writeFile(
      path.join(tmp, SYNC_STATE_FILE),
      JSON.stringify({
        schemaVersion: 1,
        lastSyncAt: '2026-08-15T00:00:00.000Z',
        sections: { settings: { hash: 'c'.repeat(64), updatedAt: '2026-08-15T00:00:00.000Z' } },
      }),
      'utf8',
    );
    const state = await loadSyncState(tmp);
    assert.equal(state.schemaVersion, SYNC_STATE_SCHEMA_VERSION, '内存中应已升级为 v2');
    assert.equal(state.lastSnapshotId, '', 'v1 文件缺祖先指针时迁移为 ""');
    assert.equal(state.lastSyncAt, '2026-08-15T00:00:00.000Z');
    assert.equal(state.sections.settings?.hash, 'c'.repeat(64));
    // 磁盘上仍是 v1（不就地升级）
    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, SYNC_STATE_FILE), 'utf8'));
    assert.equal(onDisk.schemaVersion, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('saveSyncState / loadSyncState: lastSnapshotId 非空往返', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-state-ancestor-'));
  try {
    const state: SyncState = {
      schemaVersion: SYNC_STATE_SCHEMA_VERSION,
      lastSyncAt: '2026-08-16T12:00:00.000Z',
      sections: {},
      lastSnapshotId: 'sync-deadbeef-1234',
    };
    await saveSyncState(tmp, state);
    const loaded = await loadSyncState(tmp);
    assert.equal(loaded.lastSnapshotId, 'sync-deadbeef-1234');
    assert.deepEqual(loaded, state);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
