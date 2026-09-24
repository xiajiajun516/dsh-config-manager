/**
 * P1-5 会话删除墓碑纯函数测试：检测、累积、撤销、上限、载荷剔除、单元提取。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SESSION_TOMBSTONES, nextSessionTombstones, sessionUnitIdOfPath, sessionUnitIdsOfSection, stripTombstonedUnits,
} from './session-tombstones.ts';

const A = 'sessions:--p--/a';
const B = 'sessions:--p--/b';
const C = 'sessions:--p--/c';

test('sessionUnitIdOfPath: 只认 <projectKey>/<sessionId> 两段', () => {
  assert.equal(sessionUnitIdOfPath('--p--/a/session.jsonl.zstd'), A);
  assert.equal(sessionUnitIdOfPath('--p--\\a\\session.jsonl.zstd'), A, '反斜杠归一');
  assert.equal(sessionUnitIdOfPath('--p--/a'), A);
  assert.equal(sessionUnitIdOfPath('onlyfile.jsonl'), null, '单段不是会话单元');
  assert.equal(sessionUnitIdOfPath('/a'), null, '空项目键不算');
});

test('nextSessionTombstones: 上次推过、本机已不存在 → 记墓碑；还在的绝不记', () => {
  const r = nextSessionTombstones({ previousUnits: [A, B], localUnits: [B], previousTombstones: [] });
  assert.deepEqual(r.deletedNow, [A]);
  assert.deepEqual(r.tombstones, [A]);
});

test('nextSessionTombstones: 累积（不丢旧墓碑）+ 去重保序', () => {
  const r = nextSessionTombstones({ previousUnits: [B], localUnits: [], previousTombstones: [C, C] });
  assert.deepEqual(r.tombstones, [C, B], '旧墓碑在前，新删的在后');
});

test('nextSessionTombstones: 会话又出现（从别处恢复）→ 撤销墓碑', () => {
  const r = nextSessionTombstones({ previousUnits: [A], localUnits: [A, C], previousTombstones: [A, C] });
  assert.deepEqual(r.tombstones, [], '有实体 = 没删过');
  assert.deepEqual(r.deletedNow, [], '本机还在 → 不算新删');
});

test('nextSessionTombstones: 无上次记录 → 检测不到删除（绝不当成全删）', () => {
  const r = nextSessionTombstones({ previousUnits: [], localUnits: [A, B], previousTombstones: [] });
  assert.deepEqual(r.tombstones, []);
  assert.deepEqual(r.deletedNow, []);
});

test('nextSessionTombstones: 超过上限 → 保留最新（FIFO 截断，不无限膨胀）', () => {
  const many = Array.from({ length: 10 }, (_, i) => 'sessions:--p--/s' + String(i));
  const r = nextSessionTombstones({ previousUnits: [], localUnits: [], previousTombstones: many, cap: 3 });
  assert.deepEqual(r.tombstones, ['sessions:--p--/s7', 'sessions:--p--/s8', 'sessions:--p--/s9']);
  assert.equal(MAX_SESSION_TOMBSTONES, 5000);
});

test('stripTombstonedUnits: 按会话单元整目录剔除；无命中不动对象', () => {
  const section = {
    version: 1,
    files: [
      { relativePath: '--p--/a/session.jsonl.zstd', data: new Uint8Array([1]) },
      { relativePath: '--p--/b/session.jsonl.zstd', data: new Uint8Array([2]) },
      { relativePath: '--p--/b/session.v3.jsonl.zstd', data: new Uint8Array([3]) },
    ],
  };
  const hit = stripTombstonedUnits(section, [A]);
  assert.deepEqual(hit.removed, [A]);
  const kept = (hit.section as { files: { relativePath: string }[] }).files.map((f) => f.relativePath);
  assert.deepEqual(kept, ['--p--/b/session.jsonl.zstd', '--p--/b/session.v3.jsonl.zstd'], '同单元的 generation 一起留');

  const miss = stripTombstonedUnits(section, ['sessions:--q--/zzz']);
  assert.equal(miss.section, section, '无命中 → 原对象（不白复制）');
  assert.deepEqual(miss.removed, []);
  // 非文件类分区 / 空墓碑 → 原样
  assert.equal(stripTombstonedUnits({ version: 1, namespaces: {} }, [A]).section instanceof Object, true);
  assert.deepEqual(stripTombstonedUnits(section, []).removed, []);
});

test('sessionUnitIdsOfSection: 从载荷反推本次带走的会话单元（去重保序）', () => {
  const ids = sessionUnitIdsOfSection({
    version: 1,
    files: [
      { relativePath: '--p--/b/session.jsonl.zstd' },
      { relativePath: '--p--/a/session.jsonl.zstd' },
      { relativePath: '--p--/b/session.v3.jsonl.zstd' },
    ],
  });
  assert.deepEqual(ids, [B, A], '按首次出现保序且去重');
  assert.deepEqual(sessionUnitIdsOfSection(null), []);
  assert.deepEqual(sessionUnitIdsOfSection({ version: 1, namespaces: {} }), []);
});
