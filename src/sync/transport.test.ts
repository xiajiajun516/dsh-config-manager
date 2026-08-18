/**
 * m-sync-transport：SyncTransport 抽象层测试。
 * - computeSnapshotMeta：sections hash 记录 + manifest 摘要透传
 * - manifestSummaryFrom：Manifest → 摘要
 * - 接口形状由类型系统保证（编译期），此处验证纯 helper 行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSnapshotMeta, manifestSummaryFrom } from './transport.ts';
import { hashSection } from './sync-state.ts';
import type { ManifestSummary, SyncSnapshot, SyncTransport } from './transport.ts';
import type { Manifest, SectionData, SectionId } from '../schema/types.ts';

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
    ...overrides,
  };
}

test('computeSnapshotMeta: 透传 id/createdAt/manifest，sections 为各分区内容 hash', () => {
  const snap = sampleSnapshot();
  const meta = computeSnapshotMeta(snap);
  assert.equal(meta.id, 'snap-001');
  assert.equal(meta.createdAt, snap.createdAt);
  assert.deepEqual(meta.manifest, snap.manifest);
  const snapPlain = snap.sections as Partial<Record<string, unknown>>;
  assert.equal(meta.sections['settings'], hashSection(snapPlain['settings'] as SectionData));
  assert.equal(meta.sections['providers'], hashSection(snapPlain['providers'] as SectionData));
  assert.equal(Object.keys(meta.sections).length, 2);
});

test('computeSnapshotMeta: 空 sections → 空 hash 记录', () => {
  const meta = computeSnapshotMeta(sampleSnapshot({ sections: {} }));
  assert.deepEqual(meta.sections, {});
});

test('computeSnapshotMeta: hash 与分区内容一一对应，内容变化 → hash 变化', () => {
  const a = computeSnapshotMeta(sampleSnapshot());
  const b = computeSnapshotMeta(sampleSnapshot({
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
  }));
  assert.notEqual(a.sections['settings'], b.sections['settings'], 'settings 内容变化 hash 必须变化');
  assert.equal(a.sections['providers'], b.sections['providers'], 'providers 未变化 hash 必须相同');
});

test('manifestSummaryFrom: 从导出 Manifest 提取摘要（只含启用分区）', () => {
  const manifest: Manifest = {
    schemaVersion: 1,
    exporter: { name: 'dsh-config-manager', version: '0.1.0' },
    source: { dshVersion: '2.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: '2026-08-16T12:00:00.000Z',
    sections: {
      settings: true, ui: true, providers: true, plugins: false, mcp: false,
      prompts: false, skills: true, agentPresets: false, agentInstructions: false, workspaces: false,
      pluginFiles: false, credentialsStatus: false, secrets: false, sessions: false,
    },
    security: { containsSecrets: true, encrypted: false, encryption: null },
  };
  const summary = manifestSummaryFrom(manifest);
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.dshVersion, '2.0.0');
  assert.equal(summary.platform, 'linux');
  assert.deepEqual(summary.sectionIds, ['settings', 'ui', 'providers', 'skills']);
  assert.equal(summary.containsSecrets, true);
});

test('SyncTransport 契约形状：实现对象必须具备 list/upload/download/delete', async () => {
  const fake: SyncTransport = {
    type: 'memory',
    async list() { return []; },
    async upload(s) { return computeSnapshotMeta(s); },
    async download(id: string) { return sampleSnapshot({ id }); },
    async delete(_id: string) {},
  };
  const snap = sampleSnapshot();
  const meta = computeSnapshotMeta(snap);
  assert.equal(fake.type, 'memory');
  assert.equal((await fake.list()).length, 0);
  assert.equal((await fake.download('x')).id, 'x');
  assert.equal((await fake.upload(snap)).id, meta.id);
  assert.doesNotThrow(() => fake.delete('x'));
});

test('ManifestSummary 类型形状（编译期保证 + 运行期检查）', () => {
  const s: ManifestSummary = {
    schemaVersion: 1,
    dshVersion: '1.0.0',
    platform: 'darwin',
    sectionIds: [] as SectionId[],
    containsSecrets: false,
  };
  assert.equal(s.schemaVersion, 1);
  assert.ok(Array.isArray(s.sectionIds));
});
