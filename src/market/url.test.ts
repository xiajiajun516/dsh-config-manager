/**
 * m-market：validateMarketRepoUrl 单测（docs/design/2026-08-19-market-publish-design.md §3.1）。
 * 覆盖：合法 https 通过；git@/ssh/scp 形态拒绝；userinfo / 空白 / 空串拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateMarketRepoUrl } from './url.ts'

test('market-url：合法 https 通过', () => {
  assert.equal(validateMarketRepoUrl('https://github.com/xiaojun/items.git'), null)
  assert.equal(validateMarketRepoUrl('http://example.com/repo'), null)
})

test('market-url：git@/ssh/scp 形态拒绝（市场只走 https clone）', () => {
  assert.ok(validateMarketRepoUrl('git@github.com:xiaojun/items.git') !== null, 'git@ scp 形态拒绝')
  assert.ok(validateMarketRepoUrl('ssh://git@github.com/xiaojun/items.git') !== null, 'ssh:// 拒绝')
  assert.ok(validateMarketRepoUrl('git://github.com/xiaojun/items.git') !== null, 'git:// 拒绝')
})

test('market-url：userinfo / 空白 / 空串拒绝', () => {
  assert.ok(validateMarketRepoUrl('https://user:token@github.com/x') !== null, 'userinfo 拒绝')
  assert.ok(validateMarketRepoUrl('https://github.com/x/a b.git') !== null, '空白拒绝')
  assert.ok(validateMarketRepoUrl('') !== null, '空串拒绝')
})
