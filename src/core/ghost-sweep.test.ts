/**
 * 幽灵会话检测纯函数单测（F5 失效归档清理）。
 * 覆盖：sessionKeyOf 归一化（Unix/Windows 分隔符、缺段、空串）、
 * sweepGhostSessions 缺失/存在/混合/去重/磁盘多余会话不算幽灵、
 * expectedSessionRefs 只取 sessions 分区 existed=true 的 file 条目。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedSessionRefs, sessionKeyOf, sweepGhostSessions } from './ghost-sweep.ts';
import type { SnapshotEntry } from './types.ts';

test('G-01 sessionKeyOf：归一为 <projectKey>/<sessionId>', () => {
  assert.equal(sessionKeyOf('proj-a/s1/session.jsonl.zstd'), 'proj-a/s1');
  assert.equal(sessionKeyOf('proj-a/s1/meta.json'), 'proj-a/s1');
  assert.equal(sessionKeyOf('proj-a/s1'), 'proj-a/s1', '两段路径自身就是目录键');
  assert.equal(sessionKeyOf('proj-a/s1/sub/deep.jsonl'), 'proj-a/s1', '更深层路径取前两段');
  assert.equal(sessionKeyOf('a\\b\\c.jsonl'), 'a/b', 'Windows 分隔符归一为 /');
  assert.equal(sessionKeyOf('a//b///c'), 'a/b', '连续分隔符合并');
});

test('G-02 sessionKeyOf：无法归一会话目录 → null', () => {
  assert.equal(sessionKeyOf(''), null);
  assert.equal(sessionKeyOf('proj-a'), null, '单段（项目级）无法归一会话');
  assert.equal(sessionKeyOf('/'), null);
  assert.equal(sessionKeyOf('  '), null);
});

test('G-03 sweepGhostSessions：全部存在 → 无幽灵', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/session.jsonl.zstd', 'proj-b/s2/session.jsonl.zstd'],
    ['proj-a/s1/session.jsonl.zstd', 'proj-b/s2/meta.json'],
  );
  assert.deepEqual(ghosts, []);
});

test('G-04 sweepGhostSessions：全部缺失（磁盘空）→ 全部幽灵', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/session.jsonl.zstd', 'proj-b/s2/session.jsonl.zstd'],
    [],
  );
  assert.deepEqual(ghosts.sort(), ['proj-a/s1', 'proj-b/s2'].sort());
});

test('G-05 sweepGhostSessions：混合 —— 只有磁盘缺失的会话算幽灵', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/session.jsonl.zstd', 'proj-b/s2/session.jsonl.zstd', 'proj-c/s3/session.jsonl.zstd'],
    ['proj-a/s1/session.jsonl.zstd'],
  );
  assert.deepEqual(ghosts.sort(), ['proj-b/s2', 'proj-c/s3'].sort());
});

test('G-06 sweepGhostSessions：磁盘多余会话（备份后新建）不算幽灵', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/session.jsonl.zstd'],
    ['proj-a/s1/session.jsonl.zstd', 'proj-x/new-sess/session.jsonl.zstd'],
  );
  assert.deepEqual(ghosts, []);
});

test('G-07 sweepGhostSessions：目录键粒度匹配 —— 会话目录尚存即不算幽灵', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/session.jsonl.zstd', 'proj-b/s2/session.jsonl.zstd'],
    ['proj-a/s1', 'proj-b/s2/meta.json'],
  );
  assert.deepEqual(ghosts, [], '磁盘出现会话目录（即使部分文件缺失）即视为会话存在');
});

test('G-08 sweepGhostSessions：去重保序 + Windows 分隔符磁盘条目', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a/s1/a.jsonl', 'proj-a/s1/b.jsonl', 'proj-b/s2/x.jsonl'],
    ['proj-b\\s2\\x.jsonl'],
  );
  assert.deepEqual(ghosts, ['proj-a/s1'], '同一会话多个文件缺失只报一次');
});

test('G-09 sweepGhostSessions：无法归一（单段/空）的期望条目不参与判定', () => {
  const ghosts = sweepGhostSessions(
    ['proj-a', 'proj-b/s2/session.jsonl.zstd', ''],
    [],
  );
  assert.deepEqual(ghosts, ['proj-b/s2']);
});

test('G-10 expectedSessionRefs：只取 sessions 分区 existed=true 的 file 条目', () => {
  const entries: SnapshotEntry[] = [
    { kind: 'file', adapter: 'sessions', ref: 'proj-a/s1/session.jsonl.zstd', before: null, existed: true, copiedTo: 'blobs/x' },
    { kind: 'file', adapter: 'sessions', ref: 'proj-b/s2/session.jsonl.zstd', before: null, existed: false },
    { kind: 'file', adapter: 'skills', ref: 'coding.md', before: null, existed: true, copiedTo: 'blobs/y' },
    { kind: 'settingsNamespace', adapter: 'settings', ref: 'general', before: null, revision: 1, existed: true },
  ];
  assert.deepEqual(expectedSessionRefs(entries), ['proj-a/s1/session.jsonl.zstd']);
  assert.deepEqual(expectedSessionRefs([]), []);
});
