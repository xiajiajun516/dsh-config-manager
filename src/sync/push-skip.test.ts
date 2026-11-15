/**
 * issue #146：**未裁决冲突的分区不得随本轮推送上行**（SyncPushOptions.skipSections）。
 *
 * 事故形态（真机）：A 机推了 19 个插件，B 机只有 18 个且基线为空 → B 的 pull 把 plugins 判成
 * 冲突（一个都不落地），但 B 的 Phase C 照样 push 全量导出 ⇒ 远端最新快照的 plugins 被压成 18 条。
 * 修法：调用方（自动同步）把「本轮仍未裁决的分区」作为 skipSections 下传，引擎在**计算推送目标
 * 的那一处**扣掉它们；push 与 previewPush 共用同一处过滤（预览 = 实际）。
 *
 * 契约（对应票面 Agent Brief）：
 *  - skipSections 缺省 = 不扣任何分区；force:true 时即使传了也不扣（强推 = 用户明确覆盖）；
 *  - 部分扣下：只推剩余分区，基线只记已推分区，待裁决只剔除已推分区（保留被扣下分区的 since）；
 *  - 全扣下：不上传、不新建快照、不改基线、不动待裁决 → ok:true + skipped:'all-conflicted'；
 *  - previewPush 空目标要区分「全被冲突扣下」与「没有可同步分区」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from './sync-engine.ts';
import { pendingMergeAfterPush, resolveHeldSections } from './push-skip.ts';
import { memoAsync } from '../utils/async-once.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { loadSyncState, saveSyncState } from './sync-state.ts';
import type { SectionId } from '../schema/types.ts';
import { computeSnapshotMeta } from './transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from './transport.ts';
import { createAdapters } from '../adapters/index.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { Importer } from '../core/importer.ts';
import { zhMsg } from '../core/messages.ts';

class MemTransport implements SyncTransport {
  readonly type = 'memory';
  snapshots = new Map<string, SyncSnapshot>();
  metas: SyncSnapshotMeta[] = [];
  calls: string[] = [];

  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list');
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload');
    this.snapshots.set(snapshot.id, snapshot);
    this.metas = this.metas.filter((m) => m.id !== snapshot.id);
    this.metas.push(computeSnapshotMeta(snapshot));
    return computeSnapshotMeta(snapshot);
  }

  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download');
    const snap = this.snapshots.get(id);
    if (snap === undefined) throw new Error('missing snapshot: ' + id);
    return snap;
  }

  async delete(id: string): Promise<void> {
    this.calls.push('delete');
    this.snapshots.delete(id);
    this.metas = this.metas.filter((m) => m.id !== id);
  }
}

type Ctx = ReturnType<typeof makeContext>;

function seed(ctx: Ctx): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 1, secrets: [] });
  for (const name of ['alpha', 'beta']) {
    ctx.plugins.installed.set(name, { name, version: '1.0.0', enabled: true });
  }
}

function makeEngine(ctx: Ctx, transport: SyncTransport, stateDir: string): SyncEngine {
  const adapters = createAdapters({ namespaces: ['general'] });
  const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
  return new SyncEngine({
    ctx,
    transport,
    stateDir,
    adapters,
    importer,
    now: () => new Date('2026-11-15T12:00:00.000Z'),
  } as ConstructorParameters<typeof SyncEngine>[0]);
}

/** 每个用例独立临时目录（stateDir 就是 tmp 本身，便于直接读写 sync-state.json）。 */
async function withTmp(fn: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-push-skip-'));
  try {
    await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function setup(tmp: string): { ctx: Ctx; transport: MemTransport; engine: SyncEngine } {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  seed(ctx);
  const transport = new MemTransport();
  return { ctx, transport, engine: makeEngine(ctx, transport, tmp) };
}

/** 直接改盘上的 pendingMerge（模拟「上一轮 merge 判了冲突、还没裁决」）。 */
async function seedPendingMerge(tmp: string, sections: SectionId[], since: string): Promise<void> {
  const state = await loadSyncState(tmp);
  await saveSyncState(tmp, {
    ...state,
    pendingMerge: { remoteSnapshotId: state.lastSnapshotId, sections, since },
  });
}

test('#146 缺省不扣分区：push 仍把 portable 分区全量上行', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    const report = await engine.push({ snapshotId: 'snap-1' });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    assert.equal(report.skipped, undefined, '没传 skipSections ⇒ 不是「全扣下」');
    const uploaded = transport.snapshots.get('snap-1');
    assert.ok(uploaded !== undefined);
    const keys = Object.keys(uploaded.sections);
    assert.ok(keys.includes('plugins') && keys.includes('settings'), '缺省必须带上 plugins 与 settings：' + keys.join(','));
  });
});

test('#146 部分扣下：被扣分区不上行，其余分区照推，基线只记已推分区', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    const report = await engine.push({ snapshotId: 'snap-1', skipSections: ['plugins'] });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    assert.equal(report.sections.includes('plugins'), false, '报告里的 sections 只能是真正推上去的分区');
    assert.ok(report.sections.includes('settings'), '其余分区照推');
    const uploaded = transport.snapshots.get('snap-1');
    assert.ok(uploaded !== undefined);
    assert.equal('plugins' in uploaded.sections, false, '快照里不得出现被扣下的 plugins');
    assert.ok('settings' in uploaded.sections, '其余分区必须进快照');

    const state = await loadSyncState(tmp);
    assert.equal(state.sections.plugins, undefined, '基线不得记录没推上去的分区');
    assert.ok(state.sections.settings !== undefined, '已推分区必须进基线');
  });
});

test('#146 全扣下：不上传、不新建快照、不改基线、不动待裁决', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    // 先推一次建立基线，再模拟「上一轮判了 plugins 冲突、未裁决」
    const first = await engine.push({ snapshotId: 'snap-1' });
    assert.equal(first.ok, true);
    await seedPendingMerge(tmp, ['plugins'], '2026-11-14T00:00:00.000Z');
    const before = await loadSyncState(tmp);
    transport.calls.length = 0;

    // 全部目标分区一起扣下（portable 全量由预览取，避免把「可同步面」写死在测试里）
    const all = (await engine.previewPush({})).sections.map((s) => s.section);
    assert.ok(all.includes('plugins') && all.length > 1);
    const report = await engine.push({ snapshotId: 'snap-2', skipSections: all });
    assert.equal(report.ok, true, '全扣下不是失败：' + JSON.stringify(report.warnings));
    assert.equal(report.skipped, 'all-conflicted', '必须显式区分「什么都没推」与「推成功」');
    assert.equal(report.snapshotId, '', '没有新快照就不能给一个 id');
    assert.deepEqual(report.sections, []);
    // 文案点名被扣分区：用裸分区 id（与其它引擎消息同口径，见 sync.skipNonPortable）——
    // 反过来把英文 displayName 塞进中文句子才是错的那一面。
    assert.ok((report.message ?? '').includes('plugins'), '文案要说明是哪些分区被冲突扣下');
    assert.equal((report.message ?? '').includes(sectionMeta('plugins').displayName), false, '中文文案不得夹英文 displayName');

    assert.equal(transport.calls.includes('upload'), false, '全扣下绝不能上传');
    assert.equal(transport.metas.length, 1, '远端快照数不变');

    const after = await loadSyncState(tmp);
    assert.equal(after.lastSnapshotId, before.lastSnapshotId, '基线不得前进');
    assert.deepEqual(after.pendingMerge, before.pendingMerge, '待裁决原样保留（含 since）');
    assert.deepEqual(after.sections, before.sections, '分区基线不得变动');
  });
});

test('#146 待裁决分区不因「本轮没点名」而放行，since 原样保留', async () => {
  await withTmp(async (tmp) => {
    const { engine } = setup(tmp);
    const first = await engine.push({ snapshotId: 'snap-1' });
    assert.equal(first.ok, true);
    await seedPendingMerge(tmp, ['plugins', 'settings'], '2026-11-14T00:00:00.000Z');

    const report = await engine.push({ snapshotId: 'snap-2', skipSections: ['plugins'] });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    assert.equal(report.sections.includes('settings'), false, 'settings 仍在待裁决 ⇒ 本轮同样不能上行');

    const state = await loadSyncState(tmp);
    assert.deepEqual(state.pendingMerge?.sections, ['plugins', 'settings'], '待裁决只在真正推上去之后才消解');
    assert.equal(state.pendingMerge?.since, '2026-11-14T00:00:00.000Z', '同一批待裁决保留首次时间');
  });
});

test('#146 force:true 时不扣分区（强推 = 用户明确覆盖远端）', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    const report = await engine.push({ snapshotId: 'snap-1', force: true, skipSections: ['plugins'] });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    const uploaded = transport.snapshots.get('snap-1');
    assert.ok(uploaded !== undefined);
    assert.ok('plugins' in uploaded.sections && 'settings' in uploaded.sections, 'force 必须带上全部目标分区');
  });
});

test('#146 预览与 push 同口径：扣下分区不出现在预览里；全扣下与「没有可同步分区」文案不同', async () => {
  await withTmp(async (tmp) => {
    const { engine } = setup(tmp);

    const partial = await engine.previewPush({ skipSections: ['plugins'] });
    assert.equal(partial.ok, true);
    const previewIds = partial.sections.map((s) => s.section);
    assert.equal(previewIds.includes('plugins'), false, '预览 = 实际：扣下的分区不出现');
    assert.ok(previewIds.includes('settings'), '其余分区照常在预览里');

    const all = (await engine.previewPush({})).sections.map((s) => s.section);
    const allHeld = await engine.previewPush({ skipSections: all });
    // issue #146：预览与 push 同口径 —— 全扣下不是错误（push 回 ok:true + skipped），预览同样不报错
    assert.equal(allHeld.ok, true, '全扣下不是错误：与 push 同口径回 ok:true');
    assert.equal(allHeld.skipped, 'all-conflicted', '预览也要能区分「全扣下」与「没有可同步分区」');
    assert.deepEqual(allHeld.sections, []);
    assert.equal(
      allHeld.message,
      zhMsg('sync.pushAllConflicted', { sections: all.join(', ') }),
      '全被冲突扣下必须有独立文案（点名被扣分区，裸 id 与其它引擎消息同口径）',
    );

    // 对照组：不是冲突扣下，而是「没有任何可同步分区」
    const nothing = await engine.previewPush({ sections: ['secrets'] });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.message, zhMsg('sync.noPortableSections'), '两种空目标必须能区分');
  });
});

test('#146 磁盘上仍待裁决的分区也一并扣下（调用方只点名一部分）', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    const first = await engine.push({ snapshotId: 'snap-1' });
    assert.equal(first.ok, true, '先建基线：' + JSON.stringify(first.warnings));
    await seedPendingMerge(tmp, ['plugins'], '2026-11-14T00:00:00.000Z');

    const report = await engine.push({ snapshotId: 'snap-2', skipSections: ['settings'] });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    assert.equal(report.sections.includes('plugins'), false, '待裁决分区绝不上行（即使调用方没点名）');
    assert.equal(report.sections.includes('settings'), false, '点名分区照扣');
    const uploaded = transport.snapshots.get('snap-2');
    assert.ok(uploaded !== undefined);
    assert.equal('plugins' in uploaded.sections, false, '快照里不得出现待裁决的 plugins');

    const state = await loadSyncState(tmp);
    assert.deepEqual(state.pendingMerge?.sections, ['plugins'], '被扣分区的待裁决必须原样保留');
    assert.equal(state.pendingMerge?.since, '2026-11-14T00:00:00.000Z', 'since 不得被本轮刷新');
  });
});

test('#146 读不到状态时只扣点名分区，且绝不抹掉待裁决', async () => {
  const boom = async (): Promise<{ pendingMerge?: { remoteSnapshotId: string; sections: SectionId[]; since: string } }> => {
    throw new Error('state unreadable');
  };
  const held = await resolveHeldSections({ skipSections: ['plugins'] }, boom);
  assert.deepEqual([...held], ['plugins'], '读失败只扣点名分区（不猜）');
  assert.equal((await resolveHeldSections({}, boom)).size, 0, '没点名分区 ⇒ 不扣（手动推送照旧）');
  assert.equal((await resolveHeldSections({ force: true, skipSections: ['plugins'] }, boom)).size, 0, 'force 不扣');
  assert.equal(
    await pendingMergeAfterPush(boom, ['plugins']),
    undefined,
    '读失败必须返回 undefined：recordBaseline 只在 null 时删字段，返回 null 等于抹掉待裁决',
  );
});


test('#146 本轮没判出新冲突也要扣下磁盘上的待裁决（skipSections 传空数组）', async () => {
  await withTmp(async (tmp) => {
    const { transport, engine } = setup(tmp);
    const first = await engine.push({ snapshotId: 'snap-1' });
    assert.equal(first.ok, true, '先建基线：' + JSON.stringify(first.warnings));
    await seedPendingMerge(tmp, ['plugins'], '2026-11-14T00:00:00.000Z');

    const report = await engine.push({ snapshotId: 'snap-2', skipSections: [] });
    assert.equal(report.ok, true, 'push 必须成功：' + JSON.stringify(report.warnings));
    assert.equal(report.sections.includes('plugins'), false, '上一轮留下的待裁决分区绝不上行');
    assert.ok(report.sections.includes('settings'), '其余分区照推');
    const uploaded = transport.snapshots.get('snap-2');
    assert.ok(uploaded !== undefined);
    assert.equal('plugins' in uploaded.sections, false);

    const state = await loadSyncState(tmp);
    assert.deepEqual(state.pendingMerge?.sections, ['plugins'], '待裁决仍挂着');
    assert.equal(state.pendingMerge?.since, '2026-11-14T00:00:00.000Z', 'since 原样保留');
  });
});

test('#146 待裁决按「推上去的分区」剔除：不在候选里的分区记录必须留下', async () => {
  const state = { pendingMerge: { remoteSnapshotId: 'r1', sections: ['plugins', 'sessions'] as SectionId[], since: '2026-11-14T00:00:00.000Z' } };
  const kept = await pendingMergeAfterPush(async () => state, ['plugins']);
  assert.deepEqual(kept?.sections, ['sessions'], 'sessions 本轮没推上去（不在候选）⇒ 记录不得被剔除');
  assert.equal(kept?.since, '2026-11-14T00:00:00.000Z');
  assert.equal(await pendingMergeAfterPush(async () => state, ['plugins', 'sessions']), null, '全推上去才清空');
  const set = await resolveHeldSections({ skipSections: [] }, async () => state);
  assert.deepEqual([...set], ['plugins', 'sessions'], '空数组 = 仍按磁盘待裁决扣');
});

test('memoAsync：同一轮只读一次 sync-state（扣下集合与推送后待裁决必须看同一份）', async () => {
  let reads = 0;
  const load = memoAsync(async () => {
    reads += 1;
    return { pendingMerge: { sections: ['plugins'] as SectionId[], since: '2026-11-14T00:00:00.000Z' } };
  });
  const first = await load();
  const second = await load();
  assert.equal(reads, 1, '两次取用只触发一次磁盘读');
  assert.equal(first, second, '两处看到的必须是同一份状态对象');
});

test('memoAsync：失败也被记忆化（同一轮不重试 ⇒ 两处看到同一份「读不到」）', async () => {
  let reads = 0;
  const load = memoAsync(async () => {
    reads += 1;
    throw new Error('state unreadable');
  });
  await assert.rejects(load);
  await assert.rejects(load);
  assert.equal(reads, 1, 'reject 必须被记住：重试就会看到另一份状态（两条路径各读一次）');
});

