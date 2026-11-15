/**
 * 通用按键三方合并（issue #145）：一个纯函数的规则表。
 *
 * 这里只测「按键逐条的取/舍/冲突」与顺序 —— 具体集合（插件、patch 行……）的键与身份
 * 由各自的调用方给，见 plugin-removals.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeKeyedList } from './merge-keyed.ts';

interface Item { key: string; value: string }

const spec = {
  keyOf: (item: Item) => item.key,
  identityOf: (item: Item) => item.value,
  pathOf: (key: string) => `items.${key}`,
  followDelete: true,
};

function item(key: string, value: string): Item {
  return { key, value };
}

test('mergeKeyedList: 两侧同键同身份 → 保留本机，不算合并点', () => {
  const res = mergeKeyedList({ local: [item('a', '1')], remote: [item('a', '1')], ancestor: [item('a', '1')], spec });
  assert.deepEqual(res.merged, [item('a', '1')]);
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.mergePoints, 0);
});

test('mergeKeyedList: 单侧改动（另一侧等于祖先）→ 取改动侧', () => {
  const fromLocal = mergeKeyedList({ local: [item('a', '2')], remote: [item('a', '1')], ancestor: [item('a', '1')], spec });
  assert.deepEqual(fromLocal.merged, [item('a', '2')]);
  assert.equal(fromLocal.mergePoints, 1);
  const fromRemote = mergeKeyedList({ local: [item('a', '1')], remote: [item('a', '3')], ancestor: [item('a', '1')], spec });
  assert.deepEqual(fromRemote.merged, [item('a', '3')]);
  assert.equal(fromRemote.mergePoints, 1);
});

test('mergeKeyedList: 两侧都改 → both-modified（不猜用哪一侧）', () => {
  const res = mergeKeyedList({ local: [item('a', '2')], remote: [item('a', '3')], ancestor: [item('a', '1')], spec });
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0]!.reason, 'both-modified');
  assert.equal(res.conflicts[0]!.path, 'items.a');
});

test('mergeKeyedList: 无祖先时本机独有保留、远端独有采纳；两侧同键不同身份 → both-modified', () => {
  const res = mergeKeyedList({ local: [item('mine', '1'), item('both', 'x')], remote: [item('theirs', '1'), item('both', 'y')], ancestor: undefined, spec });
  assert.deepEqual(res.merged.map((i) => i.key), ['mine', 'theirs']);
  assert.deepEqual(res.conflicts.map((c) => c.reason), ['both-modified']);
  assert.equal(res.conflicts[0]!.path, 'items.both');
});

test('mergeKeyedList: followDelete=true → 本机未改且远端删了，跟随删除', () => {
  const res = mergeKeyedList({ local: [item('a', '1')], remote: [], ancestor: [item('a', '1')], spec });
  assert.deepEqual(res.merged, []);
  assert.equal(res.mergePoints, 1);
});

test('mergeKeyedList: followDelete=false → 远端删了也保留本机，且不计合并点', () => {
  const res = mergeKeyedList({ local: [item('a', '1')], remote: [], ancestor: [item('a', '1')], spec: { ...spec, followDelete: false } });
  assert.deepEqual(res.merged, [item('a', '1')]);
  assert.equal(res.mergePoints, 0);
  assert.deepEqual(res.conflicts, []);
});

test('mergeKeyedList: 本机改过而远端删了 → modify-delete；本机删了而远端改过 → delete-modify', () => {
  const modified = mergeKeyedList({ local: [item('a', '2')], remote: [], ancestor: [item('a', '1')], spec });
  assert.deepEqual(modified.conflicts.map((c) => c.reason), ['modify-delete']);
  const deleted = mergeKeyedList({ local: [], remote: [item('a', '2')], ancestor: [item('a', '1')], spec });
  assert.deepEqual(deleted.conflicts.map((c) => c.reason), ['delete-modify']);
  assert.deepEqual(deleted.merged, []);
});

test('mergeKeyedList: 本机删过、远端未改 → 跟随本机删除（不复活）', () => {
  const res = mergeKeyedList({ local: [], remote: [item('a', '1')], ancestor: [item('a', '1')], spec });
  assert.deepEqual(res.merged, []);
  assert.deepEqual(res.conflicts, []);
});

test('mergeKeyedList: 两侧都没有 → 消失（祖先里的条目不会凭空回来）', () => {
  const res = mergeKeyedList({ local: [], remote: [], ancestor: [item('a', '1')], spec });
  assert.deepEqual(res.merged, []);
});

test('mergeKeyedList: 顺序 = 本机顺序，远端独有的键按远端顺序追加', () => {
  const res = mergeKeyedList({
    local: [item('b', '1'), item('a', '1')],
    remote: [item('c', '1'), item('a', '1'), item('d', '1')],
    ancestor: undefined,
    spec,
  });
  assert.deepEqual(res.merged.map((i) => i.key), ['b', 'a', 'c', 'd']);
});

test('mergeKeyedList: keepLocal 命中的条目以本机为准 —— 既不被远端删掉，也不报冲突', () => {
  const keep = { ...spec, keepLocal: (i: Item) => i.key === 'self' };
  const deleted = mergeKeyedList({ local: [item('self', '1')], remote: [], ancestor: [item('self', '1')], spec: keep });
  assert.deepEqual(deleted.merged, [item('self', '1')]);
  assert.deepEqual(deleted.conflicts, []);
  const changed = mergeKeyedList({ local: [item('self', '2')], remote: [item('self', '3')], ancestor: [item('self', '1')], spec: keep });
  assert.deepEqual(changed.merged, [item('self', '2')]);
  assert.deepEqual(changed.conflicts, []);
});

test('mergeKeyedList: 空键的条目让整轮退回通用路径（malformed，不按位置对齐）', () => {
  const res = mergeKeyedList({ local: [item('', '1')], remote: [item('', '2')], ancestor: undefined, spec });
  assert.deepEqual(res.merged, []);
  assert.deepEqual(res.conflicts, []);
  assert.equal(res.malformed, true, '没有身份键 = 形状不支持按键合并');
});

test('mergeKeyedList: 同键重复 → malformed（绝不「留一条丢一条」，复审 P1-2）', () => {
  const res = mergeKeyedList({ local: [item('a', '1'), item('a', '2')], remote: [item('a', '1')], ancestor: undefined, spec });
  assert.equal(res.malformed, true);
  assert.deepEqual(res.merged, []);
});

test('mergeKeyedList: 非对象条目 → malformed（畸形数据交回通用路径）', () => {
  const res = mergeKeyedList<Item>({ local: [null as unknown as Item], remote: [], ancestor: undefined, spec });
  assert.equal(res.malformed, true);
});

test('mergeKeyedList: 采纳远端时 compose 合成（本机态字段留在本机，复审 P0-2）', () => {
  const composed = { ...spec, compose: (l: Item, r: Item) => ({ key: r.key, value: r.value + '/keep:' + l.value }) };
  const res = mergeKeyedList({ local: [item('a', '1')], remote: [item('a', '2')], ancestor: [item('a', '1')], spec: composed });
  assert.deepEqual(res.merged, [item('a', '2/keep:1')]);
});

test('mergeKeyedList: keepLocal 只在本机独有时不计合并点（复审 P2-3）', () => {
  const keep = { ...spec, keepLocal: (i: Item) => i.key === 'self' };
  const res = mergeKeyedList({ local: [item('self', '1')], remote: [], ancestor: undefined, spec: keep });
  assert.equal(res.mergePoints, 0);
});

test('mergeKeyedList: 身份上下文每键只算一次，并交给该键各条目的 identityOf 复用（性能，2026-11-15）', () => {
  const seen: unknown[] = [];
  let contextCalls = 0;
  let identityCalls = 0;
  const cached = {
    keyOf: (i: Item) => i.key,
    identityContextOf: (peers: readonly Item[]) => {
      contextCalls += 1;
      return peers.map((p) => p.value).join(',');
    },
    identityOf: (i: Item, _peers: readonly Item[], ctx?: unknown) => {
      identityCalls += 1;
      seen.push(ctx);
      return i.value;
    },
    pathOf: (key: string) => `items.${key}`,
    followDelete: true,
  };
  const res = mergeKeyedList({
    local: [item('a', '1'), item('b', '2')],
    remote: [item('a', '9'), item('b', '2')],
    ancestor: [item('a', '0'), item('b', '2')],
    spec: cached,
  });
  assert.equal(contextCalls, 2, '两个键 → 只算两次上下文');
  assert.equal(new Set(seen).size, 2, '同一键上的各条目拿到同一个上下文实例');
  assert.ok(identityCalls <= 6, '每条目最多问一次身份，实际 ' + identityCalls);
  assert.equal(res.conflicts.length, 1, '缓存不改变结论：a 两侧都改 → 冲突');
  assert.equal(res.conflicts[0]!.path, 'items.a');
});

