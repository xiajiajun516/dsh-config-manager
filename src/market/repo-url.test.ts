/**
 * m-market：repo-url.ts（parseGitHubRepoUrl）单测。
 * 覆盖：github.com 正常 / .git 后缀 / www 前缀 / 非 github 域名（GitLab）/ 路径段数不符 /
 * 段名非法 / 非法 URL / 空输入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGitHubRepoUrl } from './repo-url.ts';

test('repo-url: github.com 标准 URL → owner/repo', () => {
  assert.deepEqual(parseGitHubRepoUrl('https://github.com/xiajiajun516/dsh-config-market'), {
    owner: 'xiajiajun516',
    repo: 'dsh-config-market',
  });
});

test('repo-url: 带 .git 后缀 → 剥离', () => {
  assert.deepEqual(parseGitHubRepoUrl('https://github.com/alice/dsh-configs.git'), {
    owner: 'alice',
    repo: 'dsh-configs',
  });
});

test('repo-url: www.github.com 前缀 → 接受', () => {
  assert.deepEqual(parseGitHubRepoUrl('https://www.github.com/alice/repo'), {
    owner: 'alice',
    repo: 'repo',
  });
});

test('repo-url: 非 github.com 域名（GitLab）→ null', () => {
  assert.equal(parseGitHubRepoUrl('https://gitlab.com/alice/repo'), null);
});

test('repo-url: 路径多于两段（子路径）→ null', () => {
  assert.equal(parseGitHubRepoUrl('https://github.com/alice/repo/tree/main'), null);
});

test('repo-url: 单段路径 → null', () => {
  assert.equal(parseGitHubRepoUrl('https://github.com/alice'), null);
});

test('repo-url: 段名含非法字符 → null', () => {
  assert.equal(parseGitHubRepoUrl('https://github.com/al ice/repo'), null);
  assert.equal(parseGitHubRepoUrl('https://github.com/alice/re p'), null);
});

test('repo-url: 非法 URL / 空输入 → null', () => {
  assert.equal(parseGitHubRepoUrl('not a url'), null);
  assert.equal(parseGitHubRepoUrl(''), null);
  assert.equal(parseGitHubRepoUrl('   '), null);
});

test('repo-url: http 形态（非 https）→ 接受（市场 repo 允许 http）', () => {
  assert.deepEqual(parseGitHubRepoUrl('http://github.com/alice/repo'), {
    owner: 'alice',
    repo: 'repo',
  });
});
