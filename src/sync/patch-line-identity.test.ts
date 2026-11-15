/**
 * patch 行的内容身份与它的缓存（issue #145 门② / 性能 2026-11-15）。
 *
 * 缓存只影响「算几次」，不许影响「算出什么」：这里逐条钉住带上下文 / 不带上下文、
 * 冷缓存 / 热缓存的结果完全一致，并钉住入参 raw 不被改写。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { patchIdentityContext, patchLineIdentity, redactedUnion } from './patch-line-identity.ts';
import type { PatchLine } from '../schema/types.ts';

function line(over: Partial<PatchLine> = {}): PatchLine {
  return {
    file: 'cfg.yml',
    lineId: 'l1',
    raw: { config: { apiKey: '', model: 'x', list: [{ token: '' }] } },
    ...over,
  } as PatchLine;
}

test('patchLineIdentity: 带上下文与逐次重算结果一致（本机剥空 vs 远端明文算同一行）', () => {
  const local = line({ redactedPaths: ['raw.config.apiKey', 'raw.config.list[0].token'] });
  const remote = line({ raw: { config: { apiKey: 'sk-live', model: 'x', list: [{ token: 'sk-2' }] } } });
  const peers = [local, remote];
  const context = patchIdentityContext(peers);
  assert.equal(patchLineIdentity(local, peers, context), patchLineIdentity(local, peers));
  assert.equal(patchLineIdentity(remote, peers, context), patchLineIdentity(remote, peers));
  assert.equal(patchLineIdentity(local, peers, context), patchLineIdentity(remote, peers, context));
});

test('patchLineIdentity: 两侧都写了自己的值（都不在剥空声明里）仍然不同 —— 缓存不抹掉真改动', () => {
  const local = line({ redactedPaths: ['raw.config.apiKey'], raw: { config: { apiKey: '', model: 'x' } } });
  const remote = line({ raw: { config: { apiKey: 'sk-live', model: 'y' } } });
  const peers = [local, remote];
  const context = patchIdentityContext(peers);
  assert.notEqual(patchLineIdentity(local, peers, context), patchLineIdentity(remote, peers, context));
});

test('patchLineIdentity: 上下文可跨多条行复用，结果与每行各自重算一致（500 行三侧逐行对齐）', () => {
  for (let i = 0; i < 500; i += 1) {
    const local = line({ file: 'f' + (i % 20) + '.yml', lineId: 'l' + i, redactedPaths: ['raw.config.apiKey'] });
    const remote = line({ file: 'f' + (i % 20) + '.yml', lineId: 'l' + i, raw: { config: { apiKey: 'sk-' + i, model: 'x' } } });
    const peers = [local, remote];
    const context = patchIdentityContext(peers);
    assert.equal(patchLineIdentity(local, peers, context), patchLineIdentity(local, peers));
  }
});

test('patchLineIdentity: 解析缓存不改变对非法路径的处理（不认识就放过，不猜形状）', () => {
  const clean = line({ raw: { config: { apiKey: 'sk-live' } } });
  const weird = line({ raw: { config: { apiKey: 'sk-live' } }, redactedPaths: ['raw..config', 'not a path['] });
  const peers = [weird];
  const context = patchIdentityContext(peers);
  assert.deepEqual(context.segments, [], '两条路径都解析不了 → 空上下文');
  assert.equal(patchLineIdentity(weird, peers, context), patchLineIdentity(clean, [clean]));
});

test('patchLineIdentity: 不改写入参 raw（归一化只在副本上做）', () => {
  const raw = { config: { apiKey: '' } };
  const local = line({ raw, redactedPaths: ['raw.config.apiKey'] });
  patchLineIdentity(local, [local], patchIdentityContext([local]));
  assert.deepEqual(raw, { config: { apiKey: '' } });
});

test('patchLineIdentity: 键序不稳定不算改动（上下文与缓存都不影响）', () => {
  const a = line({ raw: { config: { apiKey: 'sk-live', model: 'x' } } });
  const b = line({ raw: { config: { model: 'x', apiKey: 'sk-live' } } });
  const peers = [a, b];
  const context = patchIdentityContext(peers);
  assert.equal(patchLineIdentity(a, peers, context), patchLineIdentity(b, peers, context));
  assert.deepEqual(redactedUnion(peers), []);
});
