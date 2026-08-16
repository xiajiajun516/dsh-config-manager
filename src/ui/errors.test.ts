/**
 * errors 测试（m6-ui，规范 §23）：可操作错误 Reason/Suggested action，Secret 脱敏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActionableError, toActionableError } from './errors.ts';
import { makeUiT } from './i18n.ts';

const enT = makeUiT('en');

test('errors: SETTINGS_CONFLICT 映射为可操作建议', () => {
  const e = toActionableError(new Error('SETTINGS_CONFLICT: llm-deepseek revision 12 != 14'));
  assert.equal(e.title, '配置已被并发修改');
  assert.ok(e.suggestedAction !== undefined);
  assert.equal(e.retryable, true);
});

test('errors: 完整性失败不可重试', () => {
  const e = toActionableError(new Error('备份完整性校验失败: "config/settings.json"'));
  assert.equal(e.title, '备份完整性校验失败');
  assert.equal(e.retryable, false);
});

test('errors: 未知错误回退通用文案（仍给 Reason）', () => {
  const e = toActionableError(new Error('boom'));
  assert.equal(e.title, '操作失败');
  assert.equal(e.reason, 'boom');
});

test('errors: Secret 值绝不进入输出（脱敏）', () => {
  const e = toActionableError(new Error('写入失败: apiKey=sk-abcdef1234567890'));
  assert.ok(!e.reason.includes('sk-abcdef1234567890'));
  assert.ok(e.reason.includes('REDACTED'));
});

test('errors: 带 item 的错误也脱敏', () => {
  const e = toActionableError(new Error('fail'), { item: 'apiKey=sk-zzz999' });
  assert.ok(!e.item!.includes('sk-zzz999'));
});

test('errors: formatActionableError 输出 Reason + Suggested action（en）', () => {
  const e = toActionableError(new Error('ENOENT: no such file'), { item: 'x.zip', t: enT });
  const text = formatActionableError(e, enT);
  assert.ok(text.includes('Reason:'));
  assert.ok(text.includes('Suggested action:'));
  assert.ok(text.includes('Item:'));
});
