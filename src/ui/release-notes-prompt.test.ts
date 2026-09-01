import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateReleaseNotesPrompt } from './release-notes-prompt.ts';

test('evaluateReleaseNotesPrompt: 用户设置 dismissed=true 时永不弹出', () => {
  const res1 = evaluateReleaseNotesPrompt({ dismissed: true, lastSeenVersion: undefined }, '0.1.54');
  assert.equal(res1.shouldShow, false);

  const res2 = evaluateReleaseNotesPrompt({ dismissed: true, lastSeenVersion: '0.1.50' }, '0.1.54');
  assert.equal(res2.shouldShow, false);
});

test('evaluateReleaseNotesPrompt: 首次进入 (lastSeenVersion 为 undefined) 时自动弹出', () => {
  const res = evaluateReleaseNotesPrompt({ lastSeenVersion: undefined }, '0.1.54');
  assert.equal(res.shouldShow, true);
});

test('evaluateReleaseNotesPrompt: 版本更新 (lastSeenVersion !== currentVersion) 时自动弹出', () => {
  const res = evaluateReleaseNotesPrompt({ lastSeenVersion: '0.1.53' }, '0.1.54');
  assert.equal(res.shouldShow, true);
});

test('evaluateReleaseNotesPrompt: 当前版本相同 (lastSeenVersion === currentVersion) 时不弹出', () => {
  const res = evaluateReleaseNotesPrompt({ lastSeenVersion: '0.1.54' }, '0.1.54');
  assert.equal(res.shouldShow, false);
});
