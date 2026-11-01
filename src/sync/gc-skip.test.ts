/**
 * gc-skip.ts 单测（SYN-04b：通道「本轮 GC 放弃码」的读取判据与冒泡）。
 *
 * 行为契约（本文件钉死）：
 *  - 只有**非空字符串**算「有放弃码」；字段缺失 / null / 数字 / 空串 / getter 抛错 一律当没有；
 *  - 冒泡进 warnings，且同一轮只报一次；码在文本里必须明文出现（字典未补键时也能 grep）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcSkipWarning, readGcSkipCode, reportGcSkipOnce } from './gc-skip.ts';
import type { MsgFunc } from '../core/messages.ts';

/** 造一个「像 transport」的对象：getter 形态与 webdav/s3 通道一致（可配置抛错）。 */
function withLastGc(spec: { value?: unknown; throw?: boolean }): unknown {
  const obj = {};
  Object.defineProperty(obj, 'lastGcSkip', {
    configurable: true,
    get() {
      if (spec.throw === true) throw new Error('getter exploded');
      return spec.value;
    },
  });
  return obj;
}

test('gc-skip/①：只有非空字符串算放弃码，其余形态一律当没有', () => {
  assert.equal(readGcSkipCode(withLastGc({ value: 'gc-skip-reference-missing' })), 'gc-skip-reference-missing');
  assert.equal(readGcSkipCode(withLastGc({ value: '' })), null);
  assert.equal(readGcSkipCode(withLastGc({ value: null })), null);
  assert.equal(readGcSkipCode(withLastGc({ value: 42 })), null);
  assert.equal(readGcSkipCode(withLastGc({ value: { code: 'x' } })), null);
});

test('gc-skip/②：字段缺失与 getter 抛错都当没有（诊断能力绝不影响 push）', () => {
  assert.equal(readGcSkipCode({}), null);
  assert.equal(readGcSkipCode(null), null);
  assert.equal(readGcSkipCode(undefined), null);
  assert.equal(readGcSkipCode(withLastGc({ throw: true })), null);
});

test('gc-skip/③：字典未补键时码以明文兜底（可 grep），补键后不重复追加', () => {
  const bare: MsgFunc = (key) => key;
  const text = gcSkipWarning(bare, 'gc-skip-snapshot-unparsable');
  assert.equal(text, 'sync.gcSkipped: gc-skip-snapshot-unparsable');

  const filled: MsgFunc = () => '本轮已放弃回收远端孤立文件（gc-skip-reference-missing）';
  assert.equal(gcSkipWarning(filled, 'gc-skip-reference-missing'), '本轮已放弃回收远端孤立文件（gc-skip-reference-missing）');
});

test('gc-skip/④：同一轮只报一次；无码 / 非法形态零告警', () => {
  const msg: MsgFunc = (key, vars) => `${key}(${String((vars as { code?: string } | undefined)?.code ?? '')})`;

  const warnings: string[] = [];
  const state = { done: false };
  const transport = withLastGc({ value: 'gc-skip-reference-missing' });
  reportGcSkipOnce(transport, msg, warnings, state);
  reportGcSkipOnce(transport, msg, warnings, state);
  reportGcSkipOnce(transport, msg, warnings, state);
  assert.equal(warnings.length, 1);
  assert.equal(state.done, true);

  const quiet: string[] = [];
  reportGcSkipOnce({}, msg, quiet, { done: false });
  reportGcSkipOnce(withLastGc({ value: 0 }), msg, quiet, { done: false });
  assert.deepEqual(quiet, []);
});
