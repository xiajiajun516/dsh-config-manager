/**
 * 删除墓碑（tombstone）机制测试（F4）：
 * 覆盖 addTombstone 去重、isTombstoned 匹配、filterTombstoned 过滤、
 * load/save 持久化 roundtrip、缺失/损坏文件安全降级。
 * 基于内存 TombstoneFs（纯逻辑，零依赖）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTombstone, filterTombstoned, isTombstoned, loadTombstones, saveTombstones, TOMBSTONES_FILE,
} from './tombstones.ts';
import type { Tombstone, TombstoneFs } from './tombstones.ts';

/** 内存 fs：完整路径为 key（与 loadTombstones 的 `${dataDir}/${TOMBSTONES_FILE}` 拼接一致） */
class MemTombstoneFs implements TombstoneFs {
  files = new Map<string, Uint8Array>();
  async readFile(relPath: string): Promise<Uint8Array> {
    const v = this.files.get(relPath);
    if (v === undefined) throw new Error(`ENOENT: ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    this.files.set(relPath, data);
  }
}

const DATA_DIR = '/home/alice/dsh-config-manager';

function ts(kind: Tombstone['kind'], id: string, deletedAt = '2026-08-20T00:00:00.000Z'): Tombstone {
  return { kind, id, deletedAt };
}

test('T-01 addTombstone：追加新条目 + 同 kind+id 去重（替换保留最新）', () => {
  const a = ts('plugin', '@x/pkg-a', '2026-08-20T00:00:00.000Z');
  const b = ts('plugin', '@x/pkg-b');
  const once = addTombstone([], a);
  assert.deepEqual(once, [a], '空表追加');

  const two = addTombstone(once, b);
  assert.equal(two.length, 2, '不同 id 追加');

  // 同 kind+id 再注册 → 替换（更新 deletedAt/reason），不重复
  const updated = ts('plugin', '@x/pkg-a', '2026-08-21T00:00:00.000Z');
  const deduped = addTombstone(two, updated);
  assert.equal(deduped.length, 2, '同键去重不增长');
  assert.deepEqual(deduped[0], updated, '旧条目被新条目替换');
  assert.equal(deduped[1], b, '无关条目不受影响');

  // 同 id 不同 kind 视为不同键
  const asFile = ts('file', '@x/pkg-a');
  const mixed = addTombstone(deduped, asFile);
  assert.equal(mixed.length, 3, '同 id 不同 kind 是不同墓碑');
});

test('T-02 isTombstoned：kind+id 精确匹配', () => {
  const list = [ts('plugin', '@x/pkg-a'), ts('skill', 'coding.md'), ts('section', 'agentPresets')];
  assert.equal(isTombstoned('plugin', '@x/pkg-a', list), true);
  assert.equal(isTombstoned('skill', 'coding.md', list), true);
  assert.equal(isTombstoned('section', 'agentPresets', list), true);
  assert.equal(isTombstoned('plugin', '@x/pkg-b', list), false, '未删除的插件不命中');
  assert.equal(isTombstoned('file', 'coding.md', list), false, '同 id 不同 kind 不命中');
  assert.equal(isTombstoned('plugin', '@x/pkg-a', []), false, '空表恒 false');
});

test('T-03 filterTombstoned：剔除命中条目、保留其余、非墓碑 kind 不误伤', () => {
  const tombstones = [ts('plugin', '@x/pkg-a'), ts('skill', 'coding.md')];
  const items = [
    { kind: 'plugin', id: '@x/pkg-a' },
    { kind: 'plugin', id: '@x/pkg-b' },
    { kind: 'skill', id: 'coding.md' },
    { kind: 'file', id: 'coding.md' },
    // 非 TombstoneKind 的 kind（模拟导入计划项 kind）永不被误伤
    { kind: 'Install', id: '@x/pkg-a' },
  ];
  const out = filterTombstoned(items, tombstones);
  assert.deepEqual(
    out.map((i) => i.id),
    ['@x/pkg-b', 'coding.md', '@x/pkg-a'],
    '命中 plugin/skill 墓碑的剔除；file 与 Install kind 保留',
  );
  // 原数组不被修改
  assert.equal(items.length, 5);
  // 空墓碑 → 原样返回（新数组）
  const none = filterTombstoned(items, []);
  assert.deepEqual(none, items);
});

test('T-04 loadTombstones/saveTombstones：roundtrip 一致', async () => {
  const mem = new MemTombstoneFs();
  const list = [
    ts('plugin', '@x/pkg-a', '2026-08-20T01:02:03.000Z'),
    { ...ts('skill', 'coding.md'), reason: '不再需要' },
    ts('section', 'agentPresets'),
  ];
  await saveTombstones(mem, DATA_DIR, list);
  assert.ok(mem.files.has(`${DATA_DIR}/${TOMBSTONES_FILE}`), '文件写入 <dataDir>/tombstones.json');
  const loaded = await loadTombstones(mem, DATA_DIR);
  assert.deepEqual(loaded, list, 'roundtrip 数据一致（含 deletedAt/reason）');
});

test('T-05 loadTombstones：文件不存在 → []（安全降级，不抛错）', async () => {
  const mem = new MemTombstoneFs();
  assert.deepEqual(await loadTombstones(mem, DATA_DIR), []);
});

test('T-06 loadTombstones：损坏 JSON / 非法结构 → 降级（非数组 → []；部分非法条目被剔除）', async () => {
  const mem = new MemTombstoneFs();
  // 损坏 JSON
  await mem.writeFile(`${DATA_DIR}/${TOMBSTONES_FILE}`, new TextEncoder().encode('{not json'));
  assert.deepEqual(await loadTombstones(mem, DATA_DIR), [], '损坏 JSON → []');

  // 非数组结构
  await mem.writeFile(`${DATA_DIR}/${TOMBSTONES_FILE}`, new TextEncoder().encode('{"kind":"plugin"}'));
  assert.deepEqual(await loadTombstones(mem, DATA_DIR), [], '非数组 → []');

  // 混合合法/非法条目 → 保留合法项
  const raw = JSON.stringify([
    ts('plugin', '@x/pkg-a'),
    { kind: 'hacker', id: 'x' },          // 未知 kind → 剔除
    { kind: 'plugin', id: '' },           // 空 id → 剔除
    { kind: 'skill' },                    // 缺 id → 剔除
    { kind: 'file', id: 'keep.md', deletedAt: '2026-08-20T00:00:00.000Z' },
  ]);
  await mem.writeFile(`${DATA_DIR}/${TOMBSTONES_FILE}`, new TextEncoder().encode(raw));
  const loaded = await loadTombstones(mem, DATA_DIR);
  assert.deepEqual(loaded, [
    ts('plugin', '@x/pkg-a'),
    { kind: 'file', id: 'keep.md', deletedAt: '2026-08-20T00:00:00.000Z' },
  ], '合法条目保留、非法条目剔除');
});
