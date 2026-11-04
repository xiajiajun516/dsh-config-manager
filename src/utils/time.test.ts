/**
 * #8 时间戳收敛：`src/utils/time.ts` 是唯一实现（此前同一串格式散在 12 处）。
 * 这里钉住**形态**（定宽 / 仅 ASCII / 本地时区）与解析守卫（空 / 非有限 / 非法），
 * 不钉调用点的回退文案（那是各处的产品口径）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatDateOnly, formatDateStamp, formatMinuteStamp, parseDateInput } from './time.ts';

test('core-T1 三种形态：定宽、零填充、本地时区、仅 ASCII', () => {
  const d = new Date(2026, 0, 5, 7, 8, 9); // 本地 2026-01-05 07:08:09
  assert.equal(formatDateStamp(d), '20260105-070809');
  assert.equal(formatDateOnly(d), '2026-01-05');
  assert.equal(formatMinuteStamp(d), '2026-01-05 07:08');
  // 定宽（导出文件名按字典序 = 时间序，靠的就是这个）
  assert.equal(formatDateStamp(d).length, 15);
  assert.equal(formatDateOnly(d).length, 10);
  assert.equal(formatMinuteStamp(d).length, 16);
  assert.match(formatDateStamp(d), /^[0-9]{8}-[0-9]{6}$/);

  // 两位数边界：12 月 31 日 23:59:59 不得退化成一位
  const edge = new Date(2026, 11, 31, 23, 59, 59);
  assert.equal(formatDateStamp(edge), '20261231-235959');
  assert.equal(formatMinuteStamp(edge), '2026-12-31 23:59');

  // 缺省参数 = now（形态判定，不比对具体时刻）
  assert.match(formatDateStamp(), /^[0-9]{8}-[0-9]{6}$/);
});

test('core-T2 parseDateInput：空 / 非有限 / 非法一律 null（不静默变 1970）', () => {
  assert.equal(parseDateInput(null), null);
  assert.equal(parseDateInput(undefined), null);
  assert.equal(parseDateInput(''), null);
  assert.equal(parseDateInput('   '), null);
  assert.equal(parseDateInput(Number.NaN), null);
  assert.equal(parseDateInput(Number.POSITIVE_INFINITY), null);
  assert.equal(parseDateInput(Number.NEGATIVE_INFINITY), null);
  assert.equal(parseDateInput('not-a-date'), null);
});

test('core-T3 parseDateInput：合法字符串与毫秒数照常解析（毫秒 0 不得被当成空）', () => {
  assert.equal(parseDateInput('2026-01-05T07:08:09.000Z')?.toISOString(), '2026-01-05T07:08:09.000Z');
  assert.equal(parseDateInput(0)?.getTime(), 0);
  assert.equal(parseDateInput(1_767_593_289_000)?.getTime(), 1_767_593_289_000);
});
