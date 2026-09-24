/**
 * issue #39 Feature 1：会话子集筛选的纯逻辑（core/session-select.ts）。
 *
 * 三条被真机钉住的规则：单位 = 会话目录；文件名判据不写死（session.lock / 未来格式）；
 * 按「最新一份会话日志的 mtime」倒序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bundledSessionDirs,
  declareBundledSessionsInWorkspaces,
  groupSessionUnits,
  isSessionLogFileName,
  normalizeSessionLimit,
  pickLatestSessionUnits,
  projectKeyOf,
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

test('issue #45 ③：bundledSessionDirs 从 sessions 分区反推包内真正带数据的会话（保留日志侧原名）', () => {
  const units = bundledSessionDirs({
    version: 1,
    files: [
      // 裸 uuid 目录名（= 日志 header id）原样保留
      { relativePath: '--p--/11111111-2222-3333-4444-555555555555/session.jsonl.zstd' },
      // 已带前缀的目录名同样原样保留（真机两种形态并存）
      { relativePath: '--p--/session-66666666-7777-8888-9999-000000000000/session.v3.jsonl.zstd' },
      // 同一会话的第二个 generation → 仍是一条
      { relativePath: '--p--/11111111-2222-3333-4444-555555555555/session.v3.jsonl.zstd' },
      // 另一个项目
      { relativePath: '--q--/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/session.jsonl.zstd' },
      // 反斜杠分隔也认
      { relativePath: '--q--\\ffffffff-0000-1111-2222-333333333333\\session.jsonl.zstd' },
      // 以下都不算会话：只有运行文件、深度不足、非字符串
      { relativePath: '--p--/cccccccc-dddd-eeee-ffff-000000000000/session.lock' },
      { relativePath: '--p--/loose.jsonl.zstd' },
      { relativePath: 42 },
      null,
    ],
  });
  assert.deepEqual([...units.keys()].sort(), ['--p--', '--q--']);
  assert.deepEqual([...units.get('--p--')!.keys()].sort(), [
    '11111111-2222-3333-4444-555555555555',
    '66666666-7777-8888-9999-000000000000',
  ]);
  assert.equal(units.get('--p--')!.get('11111111-2222-3333-4444-555555555555'), '11111111-2222-3333-4444-555555555555');
  assert.equal(units.get('--p--')!.get('66666666-7777-8888-9999-000000000000'), 'session-66666666-7777-8888-9999-000000000000');
  assert.deepEqual([...units.get('--q--')!.values()].sort(), [
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'ffffffff-0000-1111-2222-333333333333',
  ]);
});

test('issue #45 ③：bundledSessionDirs 把备份数据当不可信输入（形状不符一律忽略，不抛错）', () => {
  for (const bad of [undefined, null, 0, 'x', {}, { files: 'x' }, { files: [1, 'a'] }]) {
    assert.equal(bundledSessionDirs(bad).size, 0, `${JSON.stringify(bad)} 应得到空映射`);
  }
});

test('issue #45 ③：declareBundledSessionsInWorkspaces 只增不减、按 cwd 目录键归属、按裸键去重', () => {
  const workspaces = {
    version: 1,
    workspaces: [
      // 这条会话已经用「前缀形态」声明过 —— 同一个会话不得因写法不同再声明一次
      { id: 'w1', path: '/proj', sessionIds: ['session-11111111-2222-3333-4444-555555555555'] },
      { id: 'w2', path: '/other', sessionIds: [] },
      { id: 'w3', path: '', sessionIds: [] },
    ],
  };
  const sessions = {
    version: 1,
    files: [
      { relativePath: projectKeyOf('/proj') + '/11111111-2222-3333-4444-555555555555/session.jsonl.zstd' },
      { relativePath: projectKeyOf('/proj') + '/66666666-7777-8888-9999-000000000000/session.jsonl.zstd' },
    ],
  };
  const linked = declareBundledSessionsInWorkspaces(sessions, workspaces);
  assert.deepEqual(linked, { declared: 1, workspaces: 1 });
  assert.deepEqual(workspaces.workspaces[0]!.sessionIds, [
    'session-11111111-2222-3333-4444-555555555555',
    '66666666-7777-8888-9999-000000000000',
  ], '新声明用日志侧原名（= header id，注册表认的那个）');
  assert.deepEqual(workspaces.workspaces[1]!.sessionIds, [], '别的目录键不受影响');
  // 幂等：再跑一次不再新增
  assert.deepEqual(declareBundledSessionsInWorkspaces(sessions, workspaces), { declared: 0, workspaces: 0 });
  assert.deepEqual(declareBundledSessionsInWorkspaces(undefined, workspaces), { declared: 0, workspaces: 0 });
  assert.deepEqual(declareBundledSessionsInWorkspaces(sessions, { workspaces: 'x' }), { declared: 0, workspaces: 0 });
});
