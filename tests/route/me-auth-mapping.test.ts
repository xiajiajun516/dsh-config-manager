/**
 * issue #29 回归：GitHub 凭据「缺失 / 失效」的统一映射。
 *
 * 缺陷：'no_token'（credentials 里从未配置 token）原先只在部分路由被当作「未登录」，
 * `/me/status` 会把它 rethrow 成 500，前端 loadStatus 捕获异常 → 渲染「登录状态读取失败」，
 * 让首次使用的用户以为登录态读取功能损坏（真实状态是「未登录」）。
 *
 * 契约（本文件锁定）：
 *  - 'no_token' 与 'unauthorized' 同为「未登录」；
 *  - 其余分类（network_error / rate_limited / server_error / …）是真实故障，仍按 500 暴露；
 *  - /me/* 路由不得再出现「只映射 unauthorized」的残留写法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isGitHubAuthMissing } from '../../src/index.ts';
import { GitHubApiError } from '../../src/market/github-repos.ts';

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

/** W1 起路由按域拆到 src/routes/*.ts：源码级守卫必须扫**全部**宿主路由源，否则会静默失去覆盖。 */
async function hostRouteSource(): Promise<string> {
  const root = path.resolve(here, '../..');
  const parts = [await fs.readFile(path.join(root, 'src/index.ts'), 'utf8')];
  const dir = path.join(root, 'src/routes');
  for (const entry of (await fs.readdir(dir)).sort()) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    parts.push(await fs.readFile(path.join(dir, entry), 'utf8'));
  }
  return parts.join('\n').replace(/\r\n/g, '\n');
}

test('M1 isGitHubAuthMissing：no_token（未配置 token）与 unauthorized（401 失效）同属未登录', () => {
  assert.equal(isGitHubAuthMissing(new GitHubApiError('GitHub token 未配置（请先登录）', 'no_token')), true);
  assert.equal(isGitHubAuthMissing(new GitHubApiError('Bad credentials', 'unauthorized', 401)), true);
});

test('M2 isGitHubAuthMissing：真实故障 / 非 GitHubApiError 一律 false（仍按 500 暴露，不伪装成未登录）', () => {
  for (const code of ['network_error', 'rate_limited', 'server_error', 'validation_failed', 'fork_timeout']) {
    assert.equal(isGitHubAuthMissing(new GitHubApiError(`boom:${code}`, code)), false, `${code} 不得判为未登录`);
  }
  assert.equal(isGitHubAuthMissing(new Error('boom')), false, '普通 Error 不得判为未登录');
  assert.equal(isGitHubAuthMissing(undefined), false);
  assert.equal(isGitHubAuthMissing(null), false);
  assert.equal(isGitHubAuthMissing('no_token'), false, '只认 GitHubApiError 实例，不按字符串匹配');
});

test('M3 源码守卫：/me/* 路由统一走 isGitHubAuthMissing，无「只映射 unauthorized」残留', async () => {
  // W1：/me/* 路由已拆到 src/routes/me.ts —— 守卫改扫「宿主路由源」（index.ts + src/routes/**）
  const src = await hostRouteSource();

  assert.ok(
    !src.includes("error.code === 'unauthorized' ? 401 : 500"),
    '不得残留 unauthorized-only 的 401/500 映射（issue #29 根因）',
  );

  const mapped = src.split('isGitHubAuthMissing(error) ? 401 : 500').length - 1;
  assert.equal(mapped, 4, 'me/items、me/listing、me/relist、me/delete 四条路由都必须走统一判定');

  assert.ok(
    src.includes('if (!isGitHubAuthMissing(error)) throw error'),
    '/me/status 必须把 no_token 一并视为未登录（否则 500 → UI 误报「登录状态读取失败」）',
  );
});
