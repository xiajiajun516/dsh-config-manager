/**
 * star-prompt 判定逻辑测试：
 * 首次进入只记时间不弹、满 3 天弹、未满不弹、dismissed/clicked 后永久不弹、边界值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateStarPrompt, STAR_PROMPT_DELAY_MS } from './star-prompt.ts';

// 基准时间（固定值，便于断言）
const NOW = 1_700_000_000_000;
const THREE_DAYS = STAR_PROMPT_DELAY_MS;

test('首次进入（无 firstSeenAt）：不弹窗，但需补记首次使用时间', () => {
  const ev = evaluateStarPrompt({}, NOW);
  assert.equal(ev.shouldShow, false);
  assert.equal(ev.shouldRecordFirstSeen, true);
});

test('距首次使用未满 3 天：不弹窗、不补记', () => {
  const ev = evaluateStarPrompt({ firstSeenAt: NOW - THREE_DAYS + 1 }, NOW);
  assert.equal(ev.shouldShow, false);
  assert.equal(ev.shouldRecordFirstSeen, false);
});

test('距首次使用恰好满 3 天（边界）：弹窗', () => {
  const ev = evaluateStarPrompt({ firstSeenAt: NOW - THREE_DAYS }, NOW);
  assert.equal(ev.shouldShow, true);
  assert.equal(ev.shouldRecordFirstSeen, false);
});

test('距首次使用超过 3 天：弹窗', () => {
  const ev = evaluateStarPrompt({ firstSeenAt: NOW - THREE_DAYS - 1 }, NOW);
  assert.equal(ev.shouldShow, true);
});

test('点过「不再提示」：永久不弹，即使满 3 天', () => {
  const ev = evaluateStarPrompt({ firstSeenAt: NOW - THREE_DAYS, dismissed: true }, NOW);
  assert.equal(ev.shouldShow, false);
  assert.equal(ev.shouldRecordFirstSeen, false);
});

test('点过「去点 Star」（方案 A）：永久不弹，即使满 3 天', () => {
  const ev = evaluateStarPrompt({ firstSeenAt: NOW - THREE_DAYS, clicked: true }, NOW);
  assert.equal(ev.shouldShow, false);
  assert.equal(ev.shouldRecordFirstSeen, false);
});

test('dismissed/clicked 后即使 firstSeenAt 缺失也不补记', () => {
  const ev = evaluateStarPrompt({ dismissed: true }, NOW);
  assert.equal(ev.shouldShow, false);
  assert.equal(ev.shouldRecordFirstSeen, false);
});
