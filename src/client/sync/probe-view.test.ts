/**
 * 连通性自检展示投影单测（node:test + node:assert，零依赖）。
 *
 * 把「ok:false 是结论不是崩溃」「hint 走 warn」「自动创建目录必须逐条列出」三条规则钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { projectProbeResult } from './probe-view.ts';

test('成功无附加信息 → ok 级，只回结论', () => {
  const view = projectProbeResult({ ok: true, transport: 'git', message: '连接正常（可读写）' });
  assert.equal(view.tone, 'ok');
  assert.equal(view.message, '连接正常（可读写）');
  assert.equal(view.hint, undefined);
  assert.deepEqual(view.createdCollections, []);
  assert.equal(view.snapshotCount, undefined);
});

test('成功带 hint → warn 级（提醒不等于失败）', () => {
  const view = projectProbeResult({
    ok: true, transport: 's3', message: '连接正常', hint: '该端点要求 region=auto',
  });
  assert.equal(view.tone, 'warn');
  assert.equal(view.hint, '该端点要求 region=auto');
  assert.equal(view.message, '连接正常');
});

test('成功带自动创建的远端目录 → warn 级 + 逐条列出（空串被剔除）', () => {
  const view = projectProbeResult({
    ok: true, transport: 'webdav', message: '已连通', createdCollections: ['dsh-config-manager', '', 'snapshots'],
  });
  assert.equal(view.tone, 'warn');
  assert.deepEqual(view.createdCollections, ['dsh-config-manager', 'snapshots']);
});

test('成功且回传快照数 → 原样透传（0 也要保留，不是「没有」）', () => {
  const view = projectProbeResult({ ok: true, transport: 'git', message: 'ok', snapshotCount: 0 });
  assert.equal(view.snapshotCount, 0);
  assert.equal(view.tone, 'ok');
});

test('失败 → error 级，error 原文当结论（诊断动作的预期结果，绝不丢成异常）', () => {
  const view = projectProbeResult({ ok: false, error: 'connect ETIMEDOUT 1.2.3.4:443' });
  assert.equal(view.tone, 'error');
  assert.equal(view.message, 'connect ETIMEDOUT 1.2.3.4:443');
  assert.deepEqual(view.createdCollections, []);
  assert.equal(view.hint, undefined);
});

test('空 hint 字符串不得产生 warn（不发假提醒）', () => {
  const view = projectProbeResult({ ok: true, transport: 'git', message: 'ok', hint: '' });
  assert.equal(view.tone, 'ok');
  assert.equal(view.hint, undefined);
});
