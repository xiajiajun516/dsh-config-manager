/**
 * 生效 patch 链索引（issue #144）。
 *
 * 「这个 id 已存在吗」必须按**整条链**判定：bundle 层（`dsh.bundle.patch`，按
 * `dsh.profile.bundles` 顺序）→ profile 层 → home 层 → overlays。只看 home/profile 两个
 * 文件会把 bundle 已提供的 id 当成「本机没有」，于是写第二条 `- insert:` 成员，宿主
 * compose 后同一 id 两份新增来源 —— 插件保存配置时报
 * `Configuration for "X" is overridden by a home patch or command-line overlay`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { patchChainIndex, providedByOtherLayers, readPatchChainIndex } from './patch-chain.ts';
import type { PatchChainRead } from './patch-chain.ts';

const BUNDLE = 'bundles:demo-bundle/cordis.patch.yml';
const PROFILE = 'profiles/web/cordis.patch.yml';
const HOME = 'cordis.patch.yml';

test('#144 链索引：同一 id 跨层合流（层按合并序、name 取首个声明者、记 insert 形态）', () => {
  const index = patchChainIndex({
    sources: [
      { file: BUNDLE, doc: [{ insert: [{ id: 'remote-ssh', name: '@zhangfengshun/dsh-remote-ssh', config: { port: 22 } }] }] },
      { file: PROFILE, doc: [{ id: 'remote-ssh', disabled: false }, { id: 'local-only' }] },
      { file: HOME, doc: [{ id: 'remote-ssh', disabled: true }] },
    ],
    failures: [],
  });
  const entry = index.get('remote-ssh');
  assert.deepEqual(entry?.layers, [BUNDLE, PROFILE, HOME], '层按宿主合并序去重');
  assert.deepEqual(entry?.insertLayers, [BUNDLE], '只有 bundle 层是「新增」来源，其余是覆盖行');
  assert.equal(entry?.name, '@zhangfengshun/dsh-remote-ssh', 'name 取首个声明它的层（写覆盖行要与之一致）');
  assert.deepEqual(index.get('local-only'), { id: 'local-only', layers: [PROFILE], insertLayers: [] });
});

test('#144 链索引：写某一层时「别的层是否提供」不含本层自己', () => {
  const read: PatchChainRead = {
    sources: [
      { file: PROFILE, doc: [{ id: 'dup' }, { id: 'only-here' }] },
      { file: HOME, doc: [{ id: 'dup' }] },
    ],
    failures: [],
  };
  const byOther = providedByOtherLayers(patchChainIndex(read), PROFILE);
  assert.deepEqual([...byOther.keys()], ['dup'], '仅在本层的 id 不算「已存在」，仍然可以 insert');
  assert.deepEqual(byOther.get('dup')?.layers, [PROFILE, HOME], 'layers 保留全部提供者，调用方按需筛');
});

test('#144 链索引：读不出来的层只进 failures，不贡献 id 也不抛错（fail-open）', () => {
  const read: PatchChainRead = {
    sources: [{ file: HOME, doc: [{ id: 'x' }] }],
    failures: [{ file: BUNDLE, reason: 'package not installed in this profile' }],
  };
  assert.deepEqual([...patchChainIndex(read).keys()], ['x']);
});

test('#144 readPatchChainIndex：门面没实现该能力 → null（判定退化为两层，绝不阻断写入）', async () => {
  assert.equal(await readPatchChainIndex({}), null);
  const index = await readPatchChainIndex({
    readPatchChain: async () => ({ sources: [{ file: BUNDLE, doc: [{ insert: [{ id: 'y' }] }] }], failures: [] }),
  });
  assert.deepEqual(index?.get('y'), { id: 'y', layers: [BUNDLE], insertLayers: [BUNDLE] });
});
