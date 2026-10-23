/**
 * git 快进拉取参数单测（src/utils/git-fast-forward.ts）。
 *
 * 这些字符串是「不再读写 FETCH_HEAD」的契约：sync 与 market 两侧都必须产出同形状参数，
 * 任何一方退回 `['pull','--ff-only']` 都会在并发下重新触发
 * `fatal: Cannot fast-forward to multiple branches.`（→ durable SAFE MODE）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fastForwardFetchArgs,
  fastForwardMergeArgs,
  isMissingRemoteRefError,
  parseCurrentBranch,
} from './git-fast-forward.ts';

test('fetch 参数走显式 refspec（绝不出现裸 fetch 或 pull）', () => {
  const args = fastForwardFetchArgs('main');
  assert.deepEqual(args, ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  assert.equal(args.includes('pull'), false);
  assert.equal(args.includes('FETCH_HEAD'), false);
});

test('merge 参数钉死 --ff-only 与远端跟踪分支', () => {
  assert.deepEqual(fastForwardMergeArgs('main'), ['merge', '--ff-only', 'origin/main']);
});

test('分支名带斜杠时 refspec 与 merge 目标都保持完整', () => {
  assert.deepEqual(fastForwardFetchArgs('release/1.x'), ['fetch', 'origin', '+refs/heads/release/1.x:refs/remotes/origin/release/1.x']);
  assert.deepEqual(fastForwardMergeArgs('release/1.x'), ['merge', '--ff-only', 'origin/release/1.x']);
});

test('识别「远端没有同名分支」的两种措辞', () => {
  assert.equal(isMissingRemoteRefError("fatal: couldn't find remote ref refs/heads/main"), true);
  assert.equal(isMissingRemoteRefError('error: could not find remote ref refs/heads/main'), true);
  assert.equal(isMissingRemoteRefError('fatal: Could not read from remote repository.'), false);
});

test('detached HEAD 解析为空串（调用方据此跳过拉取）', () => {
  assert.equal(parseCurrentBranch('main\n'), 'main');
  assert.equal(parseCurrentBranch('HEAD\n'), '');
  assert.equal(parseCurrentBranch('   '), '');
});
