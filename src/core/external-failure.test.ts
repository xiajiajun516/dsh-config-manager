/**
 * 本地可修外部失败标记（core/external-failure.ts）单测。
 *
 * 判据只有一条：失败是否只由**本机配置/凭据**决定、能在本机直接修好，且不会让磁盘停在半写状态。
 * 只有打了标记的失败才允许 phase3 不升 durable SAFE MODE —— 其余一切保持 fail-closed，
 * 所以「没有标记」必须是默认行为，且任何形状的输入都不能被误判成有标记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLocalOnlyExternalFailure,
  localOnlyFailureReason,
  markLocalOnlyExternalFailure,
} from './external-failure.ts';

test('默认无标记：普通错误/非对象输入一律不算 localOnly（fail-closed 的默认面）', () => {
  assert.equal(isLocalOnlyExternalFailure(new Error('boom')), false);
  assert.equal(localOnlyFailureReason(new Error('boom')), null);
  for (const weird of [null, undefined, 0, '', 'fatal: unable to auto-detect email address', [], {}, () => {}]) {
    assert.equal(isLocalOnlyExternalFailure(weird), false, '非错误输入不得被判为 localOnly: ' + String(weird));
    assert.equal(localOnlyFailureReason(weird), null);
  }
});

test('标记后原样返回同一对象（便于 throw mark(...)），并带上判据名', () => {
  const err = new Error('fatal: empty ident name');
  const marked = markLocalOnlyExternalFailure(err, 'git-identity');
  assert.equal(marked, err, '必须返回同一实例（不得包裹）');
  assert.equal(isLocalOnlyExternalFailure(err), true);
  assert.equal(localOnlyFailureReason(err), 'git-identity');
});

test('标记不可枚举：JSON/日志序列化不会泄漏内部判据字段', () => {
  const err = new Error('x');
  markLocalOnlyExternalFailure(err, 'git-identity');
  // 先展开再补 message（Error.message 不可枚举，不会覆盖；顺序反了 tsc 会报 TS2783）
  const json = JSON.stringify({ ...err, message: err.message });
  assert.equal(json.includes('git-identity'), false, '标记不得出现在可枚举/序列化字段里: ' + json);
});

test('重复标记以最后一次为准（后写覆盖先写，不抛错）', () => {
  const err = new Error('x');
  markLocalOnlyExternalFailure(err, 'first');
  markLocalOnlyExternalFailure(err, 'second');
  assert.equal(localOnlyFailureReason(err), 'second');
});

test('冻结/不可扩展的错误不会被标记（打不上就按「不可证明」保持 fail-closed）', () => {
  const err = Object.freeze(new Error('frozen'));
  const out = markLocalOnlyExternalFailure(err, 'git-identity');
  assert.equal(out, err, '仍返回同一实例');
  assert.equal(isLocalOnlyExternalFailure(err), false, '冻结对象打不上标记 → 不得误判为 localOnly');
});

test('空判据名不算标记（localOnlyFailureReason 只认非空字符串）', () => {
  const err = new Error('x');
  markLocalOnlyExternalFailure(err, '');
  assert.equal(isLocalOnlyExternalFailure(err), false);
});
