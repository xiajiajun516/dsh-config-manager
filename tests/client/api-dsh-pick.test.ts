/**
 * DSH 宿主自带目录选择器（`workspaces.pickDirectory`）的客户端适配。
 *
 * 三条结果语义必须分清：选中 / 用户取消 / 宿主不支持 —— 前者回填，中者静默，后者回落下一层。
 * 这里不碰 fetch：这条能力走 DSH 自己的 wire 客户端，不经过插件 HTTP 端点。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApi } from '../../src/client/api.ts';
import { zhUiT } from '../../src/ui/i18n.ts';

const apiWith = (picker?: () => Promise<string | null>): ConfigManagerApi =>
  new ConfigManagerApi(zhUiT, picker);

test('D-01 宿主返回路径 → ok，原样交回调用方', async () => {
  const api = apiWith(async () => 'D:\\Projects\\dsh-config-manager');
  assert.deepEqual(await api.pickDshPath(), { ok: true, path: 'D:\\Projects\\dsh-config-manager' });
});

test('D-02 宿主返回 null（用户取消）→ canceled，不当成不支持', async () => {
  const api = apiWith(async () => null);
  assert.deepEqual(await api.pickDshPath(), { ok: false, reason: 'canceled' });
});

test('D-03 宿主返回空串 → canceled（空路径不可用，也不能回填）', async () => {
  const api = apiWith(async () => '');
  assert.deepEqual(await api.pickDshPath(), { ok: false, reason: 'canceled' });
});

test('D-04 没有注入宿主选择器 → unavailable（调用方回落插件自己的原生对话框）', async () => {
  const api = apiWith();
  assert.deepEqual(await api.pickDshPath(), { ok: false, reason: 'unavailable' });
});

test('D-05 宿主服务缺失/抛错 → unavailable，绝不把异常抛给组件', async () => {
  const api = apiWith(async () => {
    throw new Error('config-manager: workspaces service unavailable');
  });
  assert.deepEqual(await api.pickDshPath(), { ok: false, reason: 'unavailable' });
});

test('D-06 每次调用都重新取服务（惰取）：第二次能拿到新宿主的结果', async () => {
  let calls = 0;
  const api = apiWith(async () => {
    calls += 1;
    return calls === 1 ? null : 'E:\\target';
  });
  assert.deepEqual(await api.pickDshPath(), { ok: false, reason: 'canceled' });
  assert.deepEqual(await api.pickDshPath(), { ok: true, path: 'E:\\target' });
  assert.equal(calls, 2);
});
