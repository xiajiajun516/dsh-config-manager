/**
 * issue #108：API 前缀解析（反代子路径）。
 *
 * 背景：API_BASE 曾写死 '/api/dsh-config-manager'，用户把 DSH 挂在
 * https://gw.example.com/app/dsh/ 时，请求打到网关根 → HTML 404 → 误报「插件未挂载」。
 * 现在按 document.baseURI 的目录解析；Node / 无 document 回落根路径默认值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { API_BASE, resolveApiBase } from './routes.ts';

test('api-base: 根路径 / → 默认前缀（与宿主常量逐字相同）', () => {
  assert.equal(resolveApiBase('https://host/'), '/api/dsh-config-manager');
  assert.equal(resolveApiBase('https://host'), '/api/dsh-config-manager');
});

test('api-base: 反代子路径三种入口都解析到同一前缀（issue #108）', () => {
  assert.equal(resolveApiBase('https://gw.example.com/app/dsh/'), '/app/dsh/api/dsh-config-manager');
  assert.equal(resolveApiBase('https://gw.example.com/app/dsh'), '/app/dsh/api/dsh-config-manager');
  assert.equal(resolveApiBase('https://gw.example.com/app/dsh/index.html'), '/app/dsh/api/dsh-config-manager');
  // 带查询串 / 锚点时只看 pathname
  assert.equal(resolveApiBase('https://gw.example.com/app/dsh/?x=1#/sync'), '/app/dsh/api/dsh-config-manager');
  // 多层前缀同样成立
  assert.equal(resolveApiBase('https://gw.example.com/a/b/c/'), '/a/b/c/api/dsh-config-manager');
});

test('api-base: 拿不到 baseURI / 非法值一律回落默认（绝不产出空前缀）', () => {
  assert.equal(resolveApiBase(undefined), '/api/dsh-config-manager');
  assert.equal(resolveApiBase(''), '/api/dsh-config-manager');
  assert.equal(resolveApiBase('::not a url::'), '/api/dsh-config-manager');
});

test('api-base: 无 document 的 Node 环境里 API_BASE 仍是默认根路径（守卫与单测依赖它）', () => {
  assert.equal(API_BASE, '/api/dsh-config-manager');
});