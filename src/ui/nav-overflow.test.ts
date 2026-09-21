/**
 * UI-19 守卫：页签条溢出可发现性的判定（纯函数，node 可测）。
 *
 * 关键语义：
 *  - 放得下 → none（**不画遮罩**：给放得下的界面加渐隐是噪音）；
 *  - 右端还有内容 → end（右侧遮罩）；滚到中间 → both；滚到最右 → start。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { navOverflowAttr, navOverflowState, NAV_OVERFLOW_EPSILON } from './nav-overflow.ts';

test('nav-overflow: 内容放得下 → 不溢出、不提示', () => {
  const state = navOverflowState({ scrollLeft: 0, scrollWidth: 500, clientWidth: 531 });
  assert.equal(state.overflowing, false);
  assert.equal(state.atStart, true);
  assert.equal(state.atEnd, true);
  assert.equal(navOverflowAttr(state), 'none');
});

test('nav-overflow: 亚像素差异不算溢出（容差内）', () => {
  const state = navOverflowState({ scrollLeft: 0, scrollWidth: 531 + NAV_OVERFLOW_EPSILON, clientWidth: 531 });
  assert.equal(state.overflowing, false, '0.5px 级差异不得被当成"还能滚"');
  assert.equal(navOverflowAttr(state), 'none');
});

test('nav-overflow: 英文页签条溢出（实测口径）逐侧判定', () => {
  // 未滚动：右边还有内容 → end
  const start = navOverflowState({ scrollLeft: 0, scrollWidth: 640, clientWidth: 531 });
  assert.deepEqual(start, { overflowing: true, atStart: true, atEnd: false });
  assert.equal(navOverflowAttr(start), 'end');

  // 滚到中间：两侧都有 → both
  assert.equal(navOverflowAttr(navOverflowState({ scrollLeft: 60, scrollWidth: 640, clientWidth: 531 })), 'both');

  // 滚到最右：只剩左侧 → start
  assert.equal(navOverflowAttr(navOverflowState({ scrollLeft: 109, scrollWidth: 640, clientWidth: 531 })), 'start');
});

test('nav-overflow: 越界/异常输入被夹到合法区间（不产生 start+end 同时为假的假象）', () => {
  // scrollLeft 超过最大可滚动量（浏览器在回弹/缩放时可能越界）
  const past = navOverflowState({ scrollLeft: 500, scrollWidth: 640, clientWidth: 531 });
  assert.equal(past.atEnd, true);
  assert.equal(past.atStart, false);
  assert.equal(navOverflowAttr(past), 'start');

  // 负值（部分浏览器 RTL 回弹）→ 视为最左
  const negative = navOverflowState({ scrollLeft: -20, scrollWidth: 640, clientWidth: 531 });
  assert.equal(negative.atStart, true);
  assert.equal(navOverflowAttr(negative), 'end');
});

test('nav-overflow: 两种子状态下 maxScroll=0（容器未布局）不误报溢出', () => {
  const state = navOverflowState({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 });
  assert.equal(state.overflowing, false);
  assert.equal(navOverflowAttr(state), 'none');
});
