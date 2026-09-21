/**
 * issue #39 Feature 1：会话子集筛选的纯逻辑（core/session-select.ts）。
 *
 * 三条被真机钉住的规则：单位 = 会话目录；文件名判据不写死（session.lock / 未来格式）；
 * 按「最新一份会话日志的 mtime」倒序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupSessionUnits,
  isSessionLogFileName,
  normalizeSessionLimit,
  pickLatestSessionUnits,
  sessionUnitIdOf,
} from './session-select.ts';

test('issue #39：会话日志文件名判据不写死，运行文件不算会话', () => {
  for (const ok of ['session.jsonl.zstd', 'session.jsonl', 'session.v3.jsonl.zstd', 'session.2.jsonl.zstd']) {
    assert.equal(isSessionLogFileName(ok), true, `${ok} 应被认作会话日志`);
  }
  for (const no of ['session.lock', 'sessionstate.jsonl', 'session', 'foo.jsonl', 'session.jsonl.zstd.tmp', 'session.v-1.jsonl']) {
    assert.equal(isSessionLogFileName(no), false, `${no} 不应被认作会话日志`);
  }
});

test('issue #39：单元 = <projectKey>/<sessionId>，深度不足两段不算会话', () => {
  assert.equal(sessionUnitIdOf('--proj--/a1b2/session.jsonl.zstd'), '--proj--/a1b2');
  assert.equal(sessionUnitIdOf('--proj--/a1b2/deep/nested.jsonl'), '--proj--/a1b2');
  assert.equal(sessionUnitIdOf('loose.jsonl'), null);
  assert.equal(sessionUnitIdOf('--proj--'), null);
});

test('issue #39：同一会话的新旧日志同进同出，最新时间取最大值', () => {
  const rels = [
    '--p--/s1/session.jsonl.zstd',
    '--p--/s1/session.v3.jsonl.zstd',
    '--p--/s1/session.lock',
    '--p--/s2/session.jsonl.zstd',
    '--p--/s2/attachments/blob.bin',
    '--p--/s3/session.lock',
    '--p--/loose.jsonl',
  ];
  const at: Record<string, number> = {
    '--p--/s1/session.jsonl.zstd': 100,
    '--p--/s1/session.v3.jsonl.zstd': 300,
    '--p--/s2/session.jsonl.zstd': 200,
  };
  const units = groupSessionUnits(rels, (rel) => at[rel] ?? null);
  assert.deepEqual(units.map((u) => u.unitId).sort(), ['--p--/s1', '--p--/s2'], '只有含日志的目录才是会话');
  const s1 = units.find((u) => u.unitId === '--p--/s1')!;
  assert.deepEqual(s1.logs.sort(), ['--p--/s1/session.jsonl.zstd', '--p--/s1/session.v3.jsonl.zstd']);
  assert.equal(s1.latestMtimeMs, 300, '取最新一份日志的时间（不用目录 mtime）');
});

test('issue #39：最新 N 个按日志 mtime 倒序；时间未知的单元排在最后', () => {
  const units = [
    { unitId: 'p/old', logs: ['p/old/session.jsonl.zstd'], latestMtimeMs: 10 },
    { unitId: 'p/new', logs: ['p/new/session.jsonl.zstd'], latestMtimeMs: 900 },
    { unitId: 'p/mid', logs: ['p/mid/session.jsonl.zstd'], latestMtimeMs: 500 },
    { unitId: 'p/undated', logs: ['p/undated/session.jsonl.zstd'], latestMtimeMs: null },
  ];
  assert.deepEqual([...pickLatestSessionUnits(units, 2)].sort(), ['p/mid', 'p/new']);
  assert.deepEqual([...pickLatestSessionUnits(units, 4)], ['p/new', 'p/mid', 'p/old', 'p/undated']);
  assert.deepEqual([...pickLatestSessionUnits(units, 99)].length, 4, 'N 超过总数 → 全带');
  assert.equal(pickLatestSessionUnits(units, 0).size, 0, '0 = 一个都不带');
  assert.equal(pickLatestSessionUnits(units, -1).size, 4, '负数 = 全带');
});

test('issue #39：时间并列时按 unitId 字典序，结果稳定可复现', () => {
  const units = [
    { unitId: 'p/b', logs: ['p/b/session.jsonl.zstd'], latestMtimeMs: 5 },
    { unitId: 'p/a', logs: ['p/a/session.jsonl.zstd'], latestMtimeMs: 5 },
  ];
  assert.deepEqual([...pickLatestSessionUnits(units, 1)], ['p/a']);
  assert.deepEqual([...pickLatestSessionUnits([...units].reverse(), 1)], ['p/a']);
});

test('issue #39：limit 归一化——只有整数才作数，其余视为「不施加限制」', () => {
  assert.equal(normalizeSessionLimit(3), 3);
  assert.equal(normalizeSessionLimit(0), 0);
  assert.equal(normalizeSessionLimit(-5), -5);
  for (const bad of [undefined, null, '3', 1.5, NaN, Infinity, {}]) {
    assert.equal(normalizeSessionLimit(bad), undefined, `${String(bad)} 应归一为 undefined`);
  }
});
