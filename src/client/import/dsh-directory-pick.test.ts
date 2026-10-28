/**
 * DSH 目录选择器解析层单测。
 *
 * 回归点（真机踩过的）：服务名是 `uiWorkspace`，不是 `workspaces` ——
 * 只写 `workspaces` 时真机上永远取不到服务，于是「复用 DSH 自带选择器」根本没发生，
 * 用户看到的一直是插件自己的对话框。这个文件钉住解析顺序与降级。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDshDirectoryPicker } from './dsh-directory-pick.ts';
import type { DirectoryPickSources } from './dsh-directory-pick.ts';

test('DSH-01 桌面全局优先：__DSH_DIRECTORY_PICKER__.pick 直接返回路径', async () => {
  const calls: string[] = [];
  const sources: DirectoryPickSources = {
    desktop: { pick: async () => { calls.push('desktop'); return '/desktop/path' } },
    getService: (name) => ({ pickDirectory: async () => { calls.push(name); return '/service/path' } }),
  };
  assert.equal(await makeDshDirectoryPicker(sources)(), '/desktop/path');
  assert.deepEqual(calls, ['desktop'], '全局有就不该再碰服务');
});

test('DSH-02 服务名 uiWorkspace（真机口径）：即使 workspaces 不存在也必须成功', async () => {
  const sources: DirectoryPickSources = {
    getService: (name) => (name === 'uiWorkspace' ? { pickDirectory: async () => '/ws/path' } : undefined),
  };
  assert.equal(await makeDshDirectoryPicker(sources)(), '/ws/path');
});

test('DSH-03 老版本回退：只有 workspaces 时仍取得到', async () => {
  const sources: DirectoryPickSources = {
    getService: (name) => (name === 'workspaces' ? { pickDirectory: async () => '/legacy' } : undefined),
  };
  assert.equal(await makeDshDirectoryPicker(sources)(), '/legacy');
});

test('DSH-04 用户取消：服务返回 null 原样传出去（不是抛错）', async () => {
  const sources: DirectoryPickSources = { getService: () => ({ pickDirectory: async () => null }) };
  assert.equal(await makeDshDirectoryPicker(sources)(), null);
});

test('DSH-05 没有任何入口：抛错交给上层降级，绝不冒充「用户取消」', async () => {
  await assert.rejects(makeDshDirectoryPicker({})(), /DSH directory picker unavailable/);
  // 服务在但没有 pickDirectory（形态不符）同样算没有。
  await assert.rejects(makeDshDirectoryPicker({ getService: () => ({ other: 1 }) })(), /unavailable/);
});

test('DSH-06 惰取：每次调用重新读服务，宿主重连后能拿到新实例', async () => {
  let current: unknown = { pickDirectory: async () => '/first' };
  const sources: DirectoryPickSources = { getService: () => current };
  const pick = makeDshDirectoryPicker(sources);
  assert.equal(await pick(), '/first');
  current = { pickDirectory: async () => '/second' };
  assert.equal(await pick(), '/second');
});
