/**
 * Phase 1 地基回归：配置快照持久化与回放（config-snapshot.ts）。
 *
 * 覆盖用户可见契约：
 *  - 快照落盘 → 读回：分区**字节**（Uint8Array）必须无损往返（JSON 会把它变成 {0:..}）；
 *  - id 冲突自动避让，不覆盖既有快照；
 *  - 非法/损坏快照读不炸（返回 null / 抛出可读错误），且不阻断列表；
 *  - 保留清理按 kind 分桶，pinned 一律豁免，manual 默认永不自动清理；
 *  - 回放走 adapter 管线：单向「validate → analyzeImport → applyItem」，Skip 项不执行；
 *  - 回放中单分区校验失败只跳过该分区，不中止其余分区。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  CONFIG_SNAPSHOT_FILE, deleteConfigSnapshot, listConfigSnapshots, loadConfigSnapshot,
  makeConfigSnapshotId, pruneConfigSnapshots, readConfigSnapshotMeta, restoreConfigSnapshot,
  saveConfigSnapshot, toUndoCandidate, updateConfigSnapshotMeta,
} from './config-snapshot.ts';
import { createSnapshot } from './backup.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import { SettingsAdapter } from '../adapters/settings.ts';
import type { ConfigState } from './config-state.ts';
import type {
  ConfigAdapter, ExportSection, HostContext, ImportPlan, PlanItem, PlanItemKind,
} from './types.ts';
import type { SectionId } from '../schema/types.ts';

async function tmpDir(t: { after: (fn: () => Promise<void> | void) => void }, label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-cfgsnap-${label}-`));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

function state(sections: [SectionId, string][] = [['settings', 'h1']], capturedAt = '2026-09-13T00:00:00.000Z'): ConfigState {
  return { capturedAt, sections: sections.map(([section, hash]) => ({ section, hash, counts: {}, fileCount: 0 })) };
}

function exported(id: SectionId, data: unknown, files?: { relativePath: string; data: Uint8Array }[]): ExportSection {
  return { sectionId: id, data, ...(files !== undefined ? { files } : {}), counts: { n: 1 }, warnings: [] };
}

function ctx(): HostContext {
  return makeContext('win32', 'C:/home/.dsh', 'web');
}

/** 可编程回放用 adapter：记录 applyItem 调用，validate 可失败。 */
function replayAdapter(
  id: SectionId,
  behavior: {
    items?: { id: string; kind: string; conflict?: { itemId: string; resolution: string } }[];
    invalid?: boolean;
    applyFails?: boolean;
  } = {},
): ConfigAdapter & { applied: string[] } {
  const applied: string[] = [];
  const adapter = {
    id,
    displayName: id,
    defaultIncluded: true,
    portability: 'portable' as const,
    applied,
    async export(): Promise<ExportSection> { return exported(id, { v: 1 }); },
    async validate() {
      return behavior.invalid === true
        ? { valid: false, issues: [{ path: '$', message: 'bad shape', severity: 'error' as const }] }
        : { valid: true, issues: [] };
    },
    async analyzeImport() {
      return (behavior.items ?? []).map((it) => ({
        id: it.id,
        kind: it.kind as never,
        adapter: id,
        description: it.id,
        severity: 'info' as const,
        target: { adapter: id, ref: it.id },
        ...(it.conflict !== undefined ? { conflict: it.conflict as never } : {}),
      }));
    },
    async applyItem(item: { id: string }) {
      if (behavior.applyFails === true) return { ok: false, message: 'apply boom' };
      applied.push(item.id);
      return { ok: true };
    },
  };
  return adapter as unknown as ConfigAdapter & { applied: string[] };
}

/* ------------------------------------------------------------ 创建与往返 */

test('saveConfigSnapshot + loadConfigSnapshot：分区字节无损往返（Uint8Array 不被 JSON 退化成对象）', async (t) => {
  const dir = await tmpDir(t, 'roundtrip');
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const sections = new Map<SectionId, ExportSection>([
    ['skills', exported('skills', { version: 1, files: [{ relativePath: 'a.md', contentHash: 'x', data: bytes }] })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'manual', reason: 'test', sections, state: state() });
  const loaded = await loadConfigSnapshot(dir, meta.id);
  const data = loaded.data.skills as { files: { data: Uint8Array }[] };
  assert.ok(data.files[0]!.data instanceof Uint8Array, '必须是 Uint8Array，而不是 {0:0,1:1} 这种对象');
  assert.deepEqual([...data.files[0]!.data], [...bytes]);
});

test('saveConfigSnapshot：写入 meta 与 data，totalBytes > 0，sections 升序', async (t) => {
  const dir = await tmpDir(t, 'meta');
  const sections = new Map<SectionId, ExportSection>([
    ['ui', exported('ui', { v: 1 })],
    ['settings', exported('settings', { v: 1 })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'auto-change', trigger: 'watcher', sections, state: state() });
  assert.equal(meta.kind, 'auto');
  assert.equal(meta.trigger, 'watcher');
  assert.ok(meta.totalBytes > 0);
  assert.deepEqual(meta.sections, ['settings', 'ui']);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, meta.id, CONFIG_SNAPSHOT_FILE), 'utf8')) as { meta: { id: string } };
  assert.equal(onDisk.meta.id, meta.id);
});

test('saveConfigSnapshot：id 冲突时自动避让，不覆盖既有快照', async (t) => {
  const dir = await tmpDir(t, 'collision');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const fixed = (): string => 'fixed-id';
  const first = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'a', sections, state: state(), idFactory: fixed });
  const second = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'b', sections, state: state(), idFactory: fixed });
  assert.equal(first.id, 'fixed-id');
  assert.notEqual(second.id, first.id);
  assert.equal((await readConfigSnapshotMeta(dir, 'fixed-id'))?.reason, 'a', '既有快照不得被覆盖');
});

test('saveConfigSnapshot：超出 maxBytes 抛错且不落盘', async (t) => {
  const dir = await tmpDir(t, 'toolarge');
  const sections = new Map<SectionId, ExportSection>([
    ['settings', exported('settings', { blob: 'x'.repeat(4096) })],
  ]);
  await assert.rejects(
    () => saveConfigSnapshot({ dir, kind: 'auto', reason: 'big', sections, state: state(), maxBytes: 512, idFactory: () => 'big-one' }),
    /超出上限/,
  );
  const entries = await fs.readdir(dir);
  assert.equal(entries.length, 0, '超限不得留下半个快照目录');
});

test('makeConfigSnapshotId：形如 YYYYMMDD-HHMMSS-xxxx 且可被 isValidSnapshotId 接受', () => {
  const id = makeConfigSnapshotId(() => new Date('2026-09-13T07:08:09.000Z'));
  assert.match(id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

/* ------------------------------------------------------------ 读取容错 */

test('readConfigSnapshotMeta：缺失 / 损坏 / 非法 id 一律 null', async (t) => {
  const dir = await tmpDir(t, 'tolerant');
  assert.equal(await readConfigSnapshotMeta(dir, 'nope'), null);
  assert.equal(await readConfigSnapshotMeta(dir, '../escape'), null);
  assert.equal(await readConfigSnapshotMeta(dir, ''), null);
  await fs.mkdir(path.join(dir, 'broken'), { recursive: true });
  await fs.writeFile(path.join(dir, 'broken', CONFIG_SNAPSHOT_FILE), '{ not json', 'utf8');
  assert.equal(await readConfigSnapshotMeta(dir, 'broken'), null);
  await fs.mkdir(path.join(dir, 'mismatch'), { recursive: true });
  await fs.writeFile(path.join(dir, 'mismatch', CONFIG_SNAPSHOT_FILE), JSON.stringify({ meta: { id: 'other', createdAt: 'x', kind: 'auto' } }), 'utf8');
  assert.equal(await readConfigSnapshotMeta(dir, 'mismatch'), null, '目录名与 meta.id 不一致必须拒绝');
});

test('loadConfigSnapshot：非法 id 抛可读错误，不越界读', async (t) => {
  const dir = await tmpDir(t, 'badid');
  await assert.rejects(() => loadConfigSnapshot(dir, '../../etc/passwd'), /非法配置快照 id/);
});

/*
 * 回归：meta.state 存在但形状不对 → 整条丢弃。
 * 一条被手改/截断的快照曾能让 statesEqual 抛 TypeError，进而使 status()/undo() 整体 500
 * —— 用户连快照列表都看不见。而「state 缺失」的旧格式快照仍应放行（可见/可恢复）。
 */
test('readConfigSnapshotMeta：meta.state 形状不对 → 丢弃；state 缺失（旧格式）→ 放行', async (t) => {
  const dir = await tmpDir(t, 'statefield');
  const write = async (id: string, meta: Record<string, unknown>): Promise<void> => {
    await fs.mkdir(path.join(dir, id), { recursive: true });
    await fs.writeFile(
      path.join(dir, id, CONFIG_SNAPSHOT_FILE),
      JSON.stringify({ meta: { id, createdAt: '2026-09-13T00:00:00.000Z', kind: 'auto', ...meta }, data: {} }),
      'utf8',
    );
  };

  await write('corrupt-null', { state: null });
  assert.equal(await readConfigSnapshotMeta(dir, 'corrupt-null'), null, 'state=null → 丢弃');

  await write('corrupt-string', { state: 'oops' });
  assert.equal(await readConfigSnapshotMeta(dir, 'corrupt-string'), null, 'state 非对象 → 丢弃');

  await write('corrupt-nosections', { state: { capturedAt: 'x' } });
  assert.equal(await readConfigSnapshotMeta(dir, 'corrupt-nosections'), null, 'state 缺 sections → 丢弃');

  await write('legacy', {});
  assert.notEqual(await readConfigSnapshotMeta(dir, 'legacy'), null, '无 state 的旧格式快照仍须放行');

  await write('good', { state: { capturedAt: 'x', sections: [] } });
  assert.notEqual(await readConfigSnapshotMeta(dir, 'good'), null, '合法 state 放行');
});

test('listConfigSnapshots：损坏条目跳过，不阻断其余，结果按 createdAt 倒序', async (t) => {
  const dir = await tmpDir(t, 'list');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  await saveConfigSnapshot({ dir, kind: 'auto', reason: 'old', sections, state: state(), idFactory: () => 'old' });
  await saveConfigSnapshot({
    dir, kind: 'auto', reason: 'new', sections,
    state: state([['settings', 'h2']], '2026-09-13T05:00:00.000Z'), idFactory: () => 'new',
  });
  await fs.mkdir(path.join(dir, 'corrupt'), { recursive: true });
  await fs.writeFile(path.join(dir, 'corrupt', CONFIG_SNAPSHOT_FILE), 'garbage', 'utf8');
  const metas = await listConfigSnapshots(dir);
  assert.deepEqual(metas.map((m) => m.id), ['new', 'old']);
});

/* ------------------------------------------------------------ 元数据更新与删除 */

test('updateConfigSnapshotMeta：只改元数据字段，分区数据不动', async (t) => {
  const dir = await tmpDir(t, 'updatemeta');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { keep: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const updated = await updateConfigSnapshotMeta(dir, meta.id, { consumed: true, note: 'hello' });
  assert.equal(updated?.consumed, true);
  assert.equal(updated?.note, 'hello');
  const loaded = await loadConfigSnapshot(dir, meta.id);
  assert.deepEqual(loaded.data.settings, { keep: 1 });
  assert.equal(loaded.consumed, true);
  assert.equal(await updateConfigSnapshotMeta(dir, 'missing', { consumed: true }), null);
});

test('deleteConfigSnapshot：删除幂等，非法 id 抛错', async (t) => {
  const dir = await tmpDir(t, 'delete');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  assert.equal(await deleteConfigSnapshot(dir, meta.id), true);
  assert.equal(await deleteConfigSnapshot(dir, meta.id), false, '再次删除幂等返回 false');
  await assert.rejects(() => deleteConfigSnapshot(dir, '../x'), /非法配置快照 id/);
});

/* ------------------------------------------------------------ 保留清理 */

test('pruneConfigSnapshots：按 kind 分桶，各留最新 N 份；manual 默认永不清理', async (t) => {
  const dir = await tmpDir(t, 'prune');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const mk = async (id: string, kind: 'auto' | 'pre-restore' | 'manual', createdAt: string): Promise<void> => {
    await saveConfigSnapshot({ dir, kind, reason: id, sections, state: state([['settings', id]], createdAt), idFactory: () => id });
  };
  await mk('a1', 'auto', '2026-09-13T01:00:00.000Z');
  await mk('a2', 'auto', '2026-09-13T02:00:00.000Z');
  await mk('a3', 'auto', '2026-09-13T03:00:00.000Z');
  await mk('p1', 'pre-restore', '2026-09-13T01:00:00.000Z');
  await mk('p2', 'pre-restore', '2026-09-13T02:00:00.000Z');
  await mk('m1', 'manual', '2026-09-13T01:00:00.000Z');
  const removed = await pruneConfigSnapshots(dir, { keepAuto: 2, keepPreRestore: 1 });
  assert.deepEqual(removed.sort(), ['a1', 'p1']);
  const left = (await listConfigSnapshots(dir)).map((m) => m.id).sort();
  assert.deepEqual(left, ['a2', 'a3', 'm1', 'p2']);
});

test('pruneConfigSnapshots：pinned 一律豁免，即使超出保留数', async (t) => {
  const dir = await tmpDir(t, 'prunepin');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const mk = async (id: string, createdAt: string): Promise<void> => {
    await saveConfigSnapshot({ dir, kind: 'auto', reason: id, sections, state: state([['settings', id]], createdAt), idFactory: () => id });
  };
  await mk('old-pinned', '2026-09-13T01:00:00.000Z');
  await mk('mid', '2026-09-13T02:00:00.000Z');
  await mk('new', '2026-09-13T03:00:00.000Z');
  await updateConfigSnapshotMeta(dir, 'old-pinned', { pinned: true });
  const removed = await pruneConfigSnapshots(dir, { keepAuto: 1 });
  assert.deepEqual(removed, ['mid']);
  const left = (await listConfigSnapshots(dir)).map((m) => m.id).sort();
  assert.deepEqual(left, ['new', 'old-pinned']);
});

test('pruneConfigSnapshots：未超限时不删任何东西', async (t) => {
  const dir = await tmpDir(t, 'prunenoop');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  await saveConfigSnapshot({ dir, kind: 'auto', reason: 'one', sections, state: state(), idFactory: () => 'one' });
  assert.deepEqual(await pruneConfigSnapshots(dir, { keepAuto: 5 }), []);
});

/* ------------------------------------------------------------ 回放 */

test('restoreConfigSnapshot：走 adapter 管线，Skip 项不执行', async (t) => {
  const dir = await tmpDir(t, 'replay');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const adapter = replayAdapter('settings', {
    items: [
      { id: 'create-a', kind: 'Create' },
      { id: 'skip-b', kind: 'Skip' },
      { id: 'update-c', kind: 'Update' },
    ],
  });
  const report = await restoreConfigSnapshot({ dir, id: meta.id, adapters: [adapter], ctx: ctx() });
  assert.equal(report.ok, true);
  assert.deepEqual(adapter.applied, ['create-a', 'update-c']);
  assert.deepEqual(report.applied, ['settings:create-a', 'settings:update-c']);
  assert.deepEqual(report.skipped, ['settings:skip-b']);
  assert.deepEqual(report.failed, []);
});

test('restoreConfigSnapshot：分区校验失败只跳过该分区，其余照常回放', async (t) => {
  const dir = await tmpDir(t, 'replayinvalid');
  const sections = new Map<SectionId, ExportSection>([
    ['settings', exported('settings', { v: 1 })],
    ['ui', exported('ui', { v: 2 })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const bad = replayAdapter('settings', { invalid: true, items: [{ id: 'x', kind: 'Create' }] });
  const good = replayAdapter('ui', { items: [{ id: 'y', kind: 'Create' }] });
  const report = await restoreConfigSnapshot({ dir, id: meta.id, adapters: [bad, good], ctx: ctx() });
  assert.equal(report.invalidSections.length, 1);
  assert.equal(report.invalidSections[0]!.section, 'settings');
  assert.deepEqual(good.applied, ['y'], '另一分区必须照常回放');
  assert.deepEqual(report.applied, ['ui:y']);
});

test('restoreConfigSnapshot：applyItem 失败如实计入 failed 且 ok=false，不抛', async (t) => {
  const dir = await tmpDir(t, 'replayfail');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const adapter = replayAdapter('settings', { items: [{ id: 'boom', kind: 'Update' }], applyFails: true });
  const report = await restoreConfigSnapshot({ dir, id: meta.id, adapters: [adapter], ctx: ctx() });
  assert.equal(report.ok, false);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0]!.reason, /apply boom/);
});

test('restoreConfigSnapshot：only 限制回放分区', async (t) => {
  const dir = await tmpDir(t, 'replayonly');
  const sections = new Map<SectionId, ExportSection>([
    ['settings', exported('settings', { v: 1 })],
    ['ui', exported('ui', { v: 1 })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const settings = replayAdapter('settings', { items: [{ id: 'a', kind: 'Create' }] });
  const ui = replayAdapter('ui', { items: [{ id: 'b', kind: 'Create' }] });
  const report = await restoreConfigSnapshot({ dir, id: meta.id, adapters: [settings, ui], ctx: ctx(), only: ['ui'] });
  assert.deepEqual(settings.applied, []);
  assert.deepEqual(ui.applied, ['b']);
  assert.deepEqual(report.applied, ['ui:b']);
});

test('restoreConfigSnapshot：APPLY 顺序按 applyOrder 排定（副作用大的置后）', async (t) => {
  const dir = await tmpDir(t, 'replayorder');
  const sections = new Map<SectionId, ExportSection>([
    ['settings', exported('settings', { v: 1 })],
    ['plugins', exported('plugins', { v: 1 })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const order: string[] = [];
  const mk = (id: SectionId): ConfigAdapter => {
    const a = replayAdapter(id, { items: [{ id: `${id}-item`, kind: 'Create' }] });
    const original = a.applyItem.bind(a);
    return { ...a, async applyItem(item, c) { order.push(id); return original(item, c); } } as ConfigAdapter;
  };
  await restoreConfigSnapshot({
    dir, id: meta.id, adapters: [mk('settings'), mk('plugins')], ctx: ctx(),
    applyOrder: ['settings', 'plugins'],
  });
  assert.deepEqual(order, ['settings', 'plugins']);
});

test('toUndoCandidate：只为 undo 规划暴露最小字段', async (t) => {
  const dir = await tmpDir(t, 'candidate');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const candidate = toUndoCandidate(meta);
  assert.deepEqual(Object.keys(candidate).sort(), ['consumed', 'createdAt', 'id', 'kind', 'state']);
  assert.equal(candidate.id, meta.id);
});

/* ------------------------------------------------------------ 快照范围与回放可执行集合（P0-4 / P0-5 回归） */

/** 构造最小计划项：快照条目的种类只由 target.adapter 决定，故统一用 settings 目标，
 *  本组测试只关心「哪些 kind 会写目标 → 是否进快照范围」。 */
function planItem(kind: PlanItemKind, ref: string, extra: Partial<PlanItem> = {}): PlanItem {
  return {
    id: `${kind}:${ref}`, kind, adapter: 'settings', description: ref, severity: 'info',
    target: { adapter: 'settings', ref },
    ...extra,
  };
}

function planOf(items: PlanItem[]): ImportPlan {
  return {
    items,
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: {} as ImportPlan['estimatedActions'],
  };
}

/*
 * 回归（P0-4）：快照范围必须覆盖**每一个会写目标的 kind**。
 * 修复前 backup.ts 用一份与执行侧不同源的 kind 清单收集目标（不含 PathMapping 与
 * Conflict）→ 这两类项会写目标却不在快照里：导入失败回滚 / 恢复都撤不掉原值，
 * 而报告仍声称「已快照、可回滚」。断言：会写的必须进快照；不写的不许占快照条目。
 */
test('createSnapshot：会写目标的 kind 一个都不能漏（PathMapping / Conflict(useImported)）', async () => {
  const c = makeContext('win32', 'C:/home/.dsh', 'web');
  const plan = planOf([
    planItem('Create', 'ns-create'),
    planItem('Update', 'ns-update'),
    planItem('Install', 'ns-install'),
    planItem('MissingSecret', 'ns-secret'),
    planItem('PathMapping', 'ns-pathmap'),
    planItem('Conflict', 'ns-conflict-use', {
      conflict: { itemId: 'Conflict:ns-conflict-use', resolution: 'useImported' },
    }),
    planItem('Conflict', 'ns-conflict-review'),
    planItem('Skip', 'ns-skip'),
    planItem('Warning', 'ns-warning'),
    planItem('MissingDependency', 'ns-dependency'),
    planItem('Error', 'ns-error'),
  ]);
  const snapshot = await createSnapshot({
    ctx: c, plan, sourceZip: 'unit.zip', store: new MemSnapshotStore(), adapters: [],
  });
  const refs = new Set(snapshot.entries.map((e) => e.ref));

  const mustSnapshot: [string, string][] = [
    ['Create', 'ns-create'],
    ['Update', 'ns-update'],
    ['Install', 'ns-install'],
    ['MissingSecret', 'ns-secret'],
    ['PathMapping', 'ns-pathmap'],
    ['Conflict(useImported)', 'ns-conflict-use'],
  ];
  for (const [kind, ref] of mustSnapshot) {
    assert.ok(refs.has(ref), `${kind} 会写目标，必须在快照范围内（否则「写了撤不掉」）`);
  }
  for (const ref of ['ns-conflict-review', 'ns-skip', 'ns-warning', 'ns-dependency', 'ns-error']) {
    assert.equal(refs.has(ref), false, `${ref} 不写目标，不应占用快照条目`);
  }
});

/*
 * 回归（P0-5）：回放的「可执行集合」必须与导入路径同源。
 * 修复前 config-snapshot.ts 自持 NON_EXECUTABLE_KINDS（不含 Conflict）→ 未采纳的
 * Conflict 会被交给 applyItem（settings adapter 无条件 settings.replace）静默覆盖本地值；
 * 而导入路径对同一项是 skip。断言：未采纳的 Conflict 不执行，显式采纳与 PathMapping 仍执行。
 */
test('restoreConfigSnapshot：未采纳的 Conflict 不写目标；显式采纳与 PathMapping 保持可执行', async (t) => {
  const dir = await tmpDir(t, 'replayconflict');
  const sections = new Map<SectionId, ExportSection>([['settings', exported('settings', { v: 1 })]]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const adapter = replayAdapter('settings', {
    items: [
      { id: 'conflict-review', kind: 'Conflict' },
      { id: 'conflict-keep', kind: 'Conflict', conflict: { itemId: 'settings:conflict-keep', resolution: 'keepCurrent' } },
      { id: 'conflict-use', kind: 'Conflict', conflict: { itemId: 'settings:conflict-use', resolution: 'useImported' } },
      { id: 'path-map', kind: 'PathMapping' },
      { id: 'need-secret', kind: 'MissingSecret' },
    ],
  });
  const report = await restoreConfigSnapshot({ dir, id: meta.id, adapters: [adapter], ctx: ctx() });
  assert.deepEqual(
    adapter.applied,
    ['conflict-use', 'path-map'],
    '未采纳的 Conflict 绝不能写目标；显式 useImported 与 PathMapping 保持既有可执行语义',
  );
  assert.deepEqual(
    report.skipped,
    ['settings:conflict-review', 'settings:conflict-keep', 'settings:need-secret'],
    '跳过的项必须如实进报告（不静默）',
  );
  assert.equal(report.ok, true);
});

/*
 * 回归（P0-5）实证：真实 settings adapter + 真实回放管线。
 * 快照里 demo={mode:from-snapshot}，目标机已经是 demo={mode:local-change}（revision 7）
 * → analyzeImport 产出未采纳的 Conflict。修复前回放会调 settings.replace 把本地值覆盖成
 * 快照值（revision 递增），用户的新改动无声消失。断言：本地值 / revision 原样保留。
 */
test('restoreConfigSnapshot：本地值不同的 namespace 不被静默 replace 覆盖（P0-5 实证）', async (t) => {
  const dir = await tmpDir(t, 'replayreplace');
  const snapshotValue = { mode: 'from-snapshot' };
  const localValue = { mode: 'local-change' };
  const sections = new Map<SectionId, ExportSection>([
    ['settings', exported('settings', {
      version: 1,
      namespaces: { demo: { value: snapshotValue, revision: 1, secrets: [] } },
    })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });
  const c = makeContext('win32', 'C:/home/.dsh', 'web');
  c.settings.ns.set('demo', { value: localValue, revision: 7, secrets: [] });

  const report = await restoreConfigSnapshot({
    dir, id: meta.id, adapters: [new SettingsAdapter(['demo'])], ctx: c,
  });

  assert.deepEqual(c.settings.ns.get('demo')?.value, localValue, '未采纳的冲突不得覆盖本地值');
  assert.equal(c.settings.ns.get('demo')?.revision, 7, 'revision 不得递增（即没有发生 settings.replace）');
  assert.deepEqual(report.applied, []);
  assert.deepEqual(report.skipped, ['settings:settings:demo']);
});


/* ------------------------------------------------------------ 未注册分区不得静默错分（t30 / core-flow#F-10） */

/*
 * 回归（F-10）：engineSnapshotEntry（core/backup.ts）的旧 default 分支把**未知分区**静默记成
 * settingsNamespace 条目（连 existed 都没有）→ 回滚把它当「原本不存在」而什么都不做：
 * 该分区的写入永远撤不掉，而报告仍声称「已快照、可回滚」。修复后 default 分支只做编译期穷尽断言 +
 * 运行期显式报错，secrets（已注册但无分区载荷）也有自己的显式报错分支。
 * 构造方式：伪造一个未注册 id 的 plan 项（等价于被篡改的 plan / 旧 journal 反序列化）。
 */
test('createSnapshot：未注册分区必须显式报错，绝不静默按 settingsNamespace 记录', async () => {
  const c = makeContext('win32', 'C:/home/.dsh', 'web');
  const plan = planOf([
    planItem('Update', 'ghost-ref', { target: { adapter: 'ghostSection' as SectionId, ref: 'ghost-ref' } }),
  ]);
  await assert.rejects(
    () => createSnapshot({ ctx: c, plan, sourceZip: 'unit.zip', store: new MemSnapshotStore(), adapters: [] }),
    /不支持分区|未在 schema\/section-registry\.ts 注册/,
    '未注册分区必须得到错误，而不是被静默记成 settingsNamespace',
  );
});

test('createSnapshot：secrets 分区不作为快照目标（显式报错而非落到 default）', async () => {
  const c = makeContext('win32', 'C:/home/.dsh', 'web');
  const plan = planOf([
    planItem('Update', 'cred-ref', { target: { adapter: 'secrets' as SectionId, ref: 'cred-ref' } }),
  ]);
  await assert.rejects(
    () => createSnapshot({ ctx: c, plan, sourceZip: 'unit.zip', store: new MemSnapshotStore(), adapters: [] }),
    /secrets 分区/,
    'secrets 无 adapter / 无分区载荷 → 不应作为快照目标',
  );
});

test('restoreConfigSnapshot：快照里的未注册分区必须显式进报告，绝不静默丢弃/错分', async (t) => {
  const dir = await tmpDir(t, 'replayghost');
  const sections = new Map<SectionId, ExportSection>([
    ['ghostSection' as SectionId, exported('ghostSection' as SectionId, { v: 1 })],
    ['settings', exported('settings', { version: 1, namespaces: {} })],
  ]);
  const meta = await saveConfigSnapshot({ dir, kind: 'auto', reason: 'r', sections, state: state() });

  const applied: string[] = [];
  const replay = replayAdapter('settings', { items: [{ id: 'a', kind: 'Create' }] });
  const report = await restoreConfigSnapshot({
    dir, id: meta.id, adapters: [replay, { ...replayAdapter('ghostSection' as SectionId), applyItem: async () => { applied.push('ghost'); return { ok: true }; } }],
    ctx: ctx(),
  });

  assert.equal(report.invalidSections.length, 1, '未注册分区必须显式记录在报告里');
  assert.equal(report.invalidSections[0]!.section, 'ghostSection');
  assert.match(report.invalidSections[0]!.reason, /未注册分区/);
  assert.deepEqual(applied, [], '未注册分区绝不被任何 adapter 回放（不按其它分区语义处理）');
});
