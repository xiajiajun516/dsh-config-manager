/**
 * issue #140：同步「内容是否变化」判定层（唯一实现）。
 *
 * 为什么单独一个纯函数：拉取（hasNewRemoteSnapshot）与推送（push 是否新建快照）必须
 * 用同一把尺子，否则会出现「拉取说没变、推送说变了」的自相矛盾状态。
 *
 * G-44：本文件只吃**调用方给出的远端观测**（SyncSnapshotMeta.sections），绝不接受
 * 「本机基线」冒充远端现状 —— 那是 recordBaseline 一参两用的事故模式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { diffSnapshotContent, hashSections } from './content-diff.ts';
import type { ManifestSummary, SyncSnapshotMeta } from './transport.ts';
import type { SectionData, SectionId } from '../schema/types.ts';

const manifest: ManifestSummary = {
  schemaVersion: 3,
  dshVersion: '0.0.0-test',
  platform: 'win32',
  sectionIds: ['settings'],
  containsSecrets: false,
};

function meta(id: string, sections: Partial<Record<SectionId, string>>): SyncSnapshotMeta {
  return { id, createdAt: '2026-11-14T00:00:00.000Z', sections, manifest };
}

const A = 'hash-a';
const B = 'hash-b';

test('diffSnapshotContent：远端最新与对照侧哈希相同 → same-content（changed=false）', () => {
  const result = diffSnapshotContent(meta('s2', { settings: A, ui: B }), { settings: A, ui: B });
  assert.equal(result.reason, 'same-content');
  assert.equal(result.changed, false);
});

test('diffSnapshotContent：id 变了但分区哈希集合相同 → false（只看内容，不看 id）', () => {
  // 同一内容被重新推了一次（旧行为每推一次一个新 id）——这不是「远端有新东西」。
  assert.equal(diffSnapshotContent(meta('s3', { settings: A }), { settings: A }).changed, false);
});

test('diffSnapshotContent：任一分区哈希变化 → content-changed（changed=true）', () => {
  const result = diffSnapshotContent(meta('s3', { settings: B }), { settings: A });
  assert.equal(result.reason, 'content-changed');
  assert.equal(result.changed, true);
});

test('diffSnapshotContent：分区键集合变化（新增/缺失）→ changed=true（集合相等才算没变）', () => {
  // 远端多一个分区
  assert.equal(diffSnapshotContent(meta('s3', { settings: A, ui: B }), { settings: A }).changed, true);
  // 远端少一个分区
  assert.equal(diffSnapshotContent(meta('s3', { settings: A }), { settings: A, ui: B }).changed, true);
});

test('diffSnapshotContent：远端 sections 为空（加密快照 / 旧通道不给哈希）→ unknown', () => {
  const encrypted = diffSnapshotContent(meta('s9', {}), { settings: A });
  assert.equal(encrypted.reason, 'unknown');
  // unknown 的 changed 恒 false：调用方必须按 reason 回落（推送按旧行为新建、拉取比 id），
  // 绝不能把「读不到」当成「没变」直接跳过。
  assert.equal(encrypted.changed, false);
});

test('diffSnapshotContent：没有远端 / 没有对照侧 → unknown（绝不猜）', () => {
  assert.equal(diffSnapshotContent(undefined, { settings: A }).reason, 'unknown');
  assert.equal(diffSnapshotContent(null, { settings: A }).reason, 'unknown');
  assert.equal(diffSnapshotContent(meta('s1', { settings: A }), undefined).reason, 'unknown');
  assert.equal(diffSnapshotContent(meta('s1', { settings: A }), {}).reason, 'unknown');
});

test('diffSnapshotContent：local 优先于 baseline（推送场景传本次导出）', () => {
  const remote = meta('s2', { settings: B });
  const baseline = { settings: A };
  const local = { settings: B }; // 本机已改成与远端一致
  assert.equal(diffSnapshotContent(remote, baseline, local).changed, false);
  // local 省略 → 用 baseline 比（拉取场景：比的是上次记录的远端观测）
  assert.equal(diffSnapshotContent(remote, baseline).changed, true);
});

test('hashSections：逐分区签名（与 state.sections / 远端观测同一口径）', () => {
  const sections: Partial<Record<SectionId, SectionData>> = {
    settings: { value: { ui: 'dark' } } as unknown as SectionData,
    ui: { value: { mode: 'dark' } } as unknown as SectionData,
  };
  const hashes = hashSections(sections);
  assert.deepEqual(Object.keys(hashes).sort(), ['settings', 'ui']);
  // 同内容两次 ⇒ 同哈希；改一个值 ⇒ 该分区哈希变
  assert.deepEqual(hashSections(sections), hashes);
  const changed = hashSections({ settings: { value: { ui: 'light' } } as unknown as SectionData });
  assert.notEqual(changed.settings, hashes.settings);
});

test('hashSections：空载荷 → 空对象（调用方据此判 unknown，而不是「相同」）', () => {
  assert.deepEqual(hashSections({}), {});
});
