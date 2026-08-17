/**
 * P2c e2e：/sync/apply 完整链路（engine 级，真实 Importer + 内存 transport + 真实 makeContext）。
 *
 * 链路：push（建立祖先基线）→ 塞远端快照（模拟另一台机器改了 settings）→
 *       engine.merge()（三方合并）→ classifyMergePlan（firstSync=false）→
 *       engine.applyMergePlan()（真实 Importer.executeImportPlan 写本地）→
 *       验证：本地 settings 被写入 + sync-state.lastSnapshotId 更新 + review-queue 行为正确。
 *
 * 说明：不启动真实 HTTP server（那需要拉起 DSH 插件运行时）；以 SyncEngine 为边界走
 * 与 Host /sync/apply 路由完全相同的代码路径（makeSyncEngine + engine.merge + classifyMergePlan + applyMergePlan）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from '../src/sync/sync-engine.ts';
import { loadSyncState } from '../src/sync/sync-state.ts';
import { classifyMergePlan } from '../src/sync/risk.ts';
import { createAdapters } from '../src/adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../src/adapters/test-helpers.ts';
import { Importer } from '../src/core/importer.ts';
import { readReviewQueue } from '../src/sync/review-queue.ts';
import type { SyncSnapshot, SyncTransport, SyncSnapshotMeta } from '../src/sync/transport.ts';
import { computeSnapshotMeta } from '../src/sync/transport.ts';

/** 内存 SyncTransport（与 sync-engine.test.ts 同款） */
class MemTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  async list(): Promise<SyncSnapshotMeta[]> {
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.snapshots.set(snapshot.id, snapshot);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }
  async download(id: string): Promise<SyncSnapshot> {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`快照不存在: ${id}`);
    return s;
  }
  async delete(id: string): Promise<void> {
    this.snapshots.delete(id);
  }
}

const NS = ['general', 'theme'];

function makeEngine(
  ctx: ReturnType<typeof makeContext>,
  transport: MemTransport,
  stateDir: string,
  localSnapshotsDir: string,
): SyncEngine {
  const adapters = createAdapters({ namespaces: NS });
  const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx,
    transport,
    stateDir,
    localSnapshotsDir,
    adapters,
    importer,
    now: () => new Date('2026-08-17T00:00:00.000Z'),
  });
}

/** 构造一个仅含 settings 分区的远端快照（模拟另一台机器推的） */
function remoteSnapshot(id: string, theme: string): SyncSnapshot {
  return {
    id,
    createdAt: '2026-08-17T00:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: false },
    sections: {
      settings: {
        version: 1,
        namespaces: { general: { value: { theme }, revision: 5, secrets: [] } },
      },
    },
  };
}

test('e2e: push 建基线 → 远端改 → merge → classify → applyMergePlan → 本地 settings 被写 + review-queue 正确', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-apply-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const localSnapshotsDir = path.join(tmp, 'snapshots');
    const engine = makeEngine(ctx, transport, stateDir, localSnapshotsDir);

    // ① push：本地 dark → 祖先基线
    const push = await engine.push({ snapshotId: 'sync-base' });
    assert.equal(push.ok, true);
    assert.equal(push.snapshotId, 'sync-base');

    // ② 远端被另一台机器改为 light（本地仍 dark = 祖先，远端 != 祖先 → useRemote）
    const remote = remoteSnapshot('sync-remote', 'light');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // ③ merge（三方）：本地==祖先、远端!=祖先 → settings useRemote
    const merge = await engine.merge();
    const settingsResult = merge.sections.find((s) => s.id === 'settings');
    assert.ok(settingsResult, 'merge 应产出 settings 分区');
    assert.equal(settingsResult!.decision, 'useRemote', '本地==祖先、远端改 → useRemote');

    // ④ classify（firstSync=false，settings 低风险）→ autoApply
    const apply = classifyMergePlan(merge, { firstSync: false });
    assert.equal(apply.autoApply.length, 1);
    assert.equal(apply.autoApply[0]!.id, 'settings');
    assert.equal(apply.review.length, 0);

    // ⑤ applyMergePlan（真实 Importer 写本地）
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true, 'apply 应成功');
    assert.deepEqual(report.applied, ['settings']);
    assert.notEqual(report.restoreId, '', 'restoreId 非空');
    assert.equal(report.rolledBack, false);

    // ⑥ 本地 settings 被真实 adapter 写回
    const local = ctx.settings.ns.get('general');
    assert.ok(local, 'general namespace 已存在');
    assert.equal((local!.value as { theme: string }).theme, 'light', '本地 theme 已被应用为远端 light');

    // ⑦ sync-state.lastSnapshotId 已更新（applyMergePlan 内部 recordBaseline；
    // 用 apply 时生成的合并快照 id，而非 push 的 sync-base）
    const state = await loadSyncState(stateDir);
    assert.notEqual(state.lastSnapshotId, '', 'apply 后基线已更新');
    // ⑧ 祖先目录有快照
    const dirs = await fs.readdir(localSnapshotsDir);
    assert.ok(dirs.length > 0, '祖先副本已写入');
    // ⑨ review-queue 未被写入（无冲突无失败）
    const rq = await readReviewQueue(stateDir);
    assert.equal(rq.items.length, 0, '无冲突时 review-queue 应为空');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: 双向冲突 → classify 进 review，applyMergePlan 短路（不写本地）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-conflict-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const localSnapshotsDir = path.join(tmp, 'snapshots');
    const engine = makeEngine(ctx, transport, stateDir, localSnapshotsDir);

    // ① push 建基线 dark
    await engine.push({ snapshotId: 'sync-base' });

    // ② 本地改 blue（相对祖先 dark）+ 远端改 red → 双侧都改 → conflict
    ctx.settings.ns.set('general', { value: { theme: 'blue' }, revision: 4, secrets: [] });
    const remote = remoteSnapshot('sync-remote', 'red');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // ③ merge → settings conflict
    const merge = await engine.merge();
    const settingsResult = merge.sections.find((s) => s.id === 'settings');
    assert.ok(settingsResult);
    assert.equal(settingsResult!.decision, 'conflict', '双侧都改 → conflict');

    // ④ classify → review（双向冲突永不自动）
    const apply = classifyMergePlan(merge, { firstSync: false });
    assert.equal(apply.review.length, 1);
    assert.equal(apply.autoApply.length, 0);

    // ⑤ applyMergePlan（autoApply 空 → 短路，不写本地）
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true, '空 autoApply → ok:true 短路');
    assert.equal(report.applied.length, 0);

    // ⑥ 本地仍为 blue（未被覆盖）
    const local = ctx.settings.ns.get('general');
    assert.equal((local!.value as { theme: string }).theme, 'blue', '冲突时本地不被覆盖');
    // ⑦ review-queue 未被写（review 项由 UI 决策；短路路径不 enqueue）
    const rq = await readReviewQueue(stateDir);
    assert.equal(rq.items.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('e2e: 首次同步（firstSync=true）→ 低风险也进 review 而非自动应用', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-firstsync-'));
  try {
    const ctx = makeContext('win32', 'C:\\Users\\alice');
    for (const n of NS) ctx.settings.registered.add(n);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    const transport = new MemTransport();
    const stateDir = path.join(tmp, 'sync');
    const localSnapshotsDir = path.join(tmp, 'snapshots');
    const engine = makeEngine(ctx, transport, stateDir, localSnapshotsDir);

    // 远端有 light；本地从未同步（无 sync-state → firstSync 由调用方判定）
    const remote = remoteSnapshot('sync-remote', 'light');
    transport.snapshots.set(remote.id, remote);
    transport.metas.push(computeSnapshotMeta(remote));

    // merge：无祖先（lastSnapshotId=''）→ 两方差异 → conflict（P2a 语义：不猜测祖先）
    const merge = await engine.merge();
    assert.equal(merge.sections[0]!.decision, 'conflict', '无祖先 → 整分区 conflict（不猜测）');

    // classify（firstSync=true）→ 全部非 skip 进 review（本地全部 portable 分区参与 merge，
    // 故 review 可能含多个分区；settings 必在其中且 autoApply 必为空）
    const apply = classifyMergePlan(merge, { firstSync: true });
    assert.equal(apply.autoApply.length, 0, 'firstSync 时无任何自动应用');
    assert.ok(apply.review.some((r) => r.id === 'settings'), 'settings 进 review');

    // 短路 apply
    const report = await engine.applyMergePlan(apply);
    assert.equal(report.ok, true);
    assert.equal(report.applied.length, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
