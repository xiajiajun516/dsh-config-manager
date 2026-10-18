/**
 * 远端快照设备身份投影单测（cloud-sync 借鉴项 ⑥）。
 *
 * 钉住的唯一规则：**旧快照没有 deviceName ⇒ 不产出任何文案**（不是空串，也不是「未知设备」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLabel, deviceLabelsById } from './remote-device-view.ts';

const format = (device: string): string => `由 ${device} 推送`;

test('deviceLabel：有名字才产出文案', () => {
  assert.equal(deviceLabel({ deviceName: 'macbook-pro' }, format), '由 macbook-pro 推送');
});

test('deviceLabel：缺字段 / 空串 / 非字符串一律 undefined（不显示占位）', () => {
  assert.equal(deviceLabel({}, format), undefined);
  assert.equal(deviceLabel({ deviceName: undefined }, format), undefined);
  assert.equal(deviceLabel({ deviceName: '' }, format), undefined);
  assert.equal(deviceLabel({ deviceName: 42 }, format), undefined);
  assert.equal(deviceLabel({ deviceName: null }, format), undefined);
});

test('deviceLabelsById：只收有名字的快照，按 id 建表（缺字段的行不进表）', () => {
  const map = deviceLabelsById([
    { id: 's1', deviceName: 'dev-a' },
    { id: 's2' },
    { id: 's3', deviceName: '' },
    { id: 's4', deviceName: 'dev-b' },
  ], format);
  assert.deepEqual([...map.entries()], [['s1', '由 dev-a 推送'], ['s4', '由 dev-b 推送']]);
  assert.equal(map.size, 2);
  assert.equal(map.get('s2'), undefined);
});
