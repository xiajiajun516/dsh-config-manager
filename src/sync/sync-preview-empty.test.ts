/**
 * issue #116：远端没有任何快照时，preview() 必须回**结构化原因** reason='remote-empty'。
 *
 * 为什么钉这个：客户端靠它把「首次同步」渲染成引导（先推送），而不是红色「同步失败」。
 * 只靠 message 文案不行 —— 文案会随语言/措辞变化，判定必须落在结构化字段上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from './sync-engine.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { computeSnapshotMeta } from './transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';

/** 空远端（与 sync-preview-push.test.ts 同款最小实现，list() 恒为空）。 */
class EmptySyncTransport implements SyncTransport {
  readonly type = 'memory';
  async list(): Promise<SyncSnapshotMeta[]> { return []; }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> { return computeSnapshotMeta(snapshot); }
  async download(id: string): Promise<SyncSnapshot> { throw new Error('不该下载: ' + id); }
  async delete(): Promise<void> { /* noop */ }
}

test('issue #116：远端无快照 → ok:false 且 reason=remote-empty（不是无理由的失败）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-preview-empty-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    const adapters = createAdapters({ namespaces: ['general'] });
    const engine = new SyncEngine({
      ctx,
      transport: new EmptySyncTransport(),
      stateDir: tmp,
      adapters,
      importer: new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() }),
      now: () => new Date('2026-10-27T10:00:00.000Z'),
    } as ConstructorParameters<typeof SyncEngine>[0]);

    const result = await engine.preview({});
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'remote-empty', '客户端据此把首次同步渲染成引导');
    assert.equal(result.plan, null);
    assert.equal(result.analysis, null);

    // 合并预览路径（一键同步命中 hasBaseline 时走这条）必须同口径：空远端也带结构化原因，
    // 否则客户端只能靠文案猜，红色「预览失败」会盖住「先推送」的引导。
    const merge = await engine.previewMerge({});
    assert.equal(merge.ok, false);
    assert.equal(merge.reason, 'remote-empty', '合并预览同样不许把「首次同步」当成故障');
    assert.deepEqual(merge.sections, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
