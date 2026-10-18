/**
 * 远端依赖清单**展示判定**单测（node:test + node:assert，零依赖）。
 *
 * 覆盖三件必须可证的事：状态→字典键（禁止裸枚举）、不可达时远端行不显示、统计与内核一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPluginInventory } from '../../core/plugin-inventory.ts';
import type { InventoryInput } from '../../core/plugin-inventory.ts';
import {
  INVENTORY_STATUS_UNKNOWN_VIEW,
  INVENTORY_STATUS_VIEW,
  inventoryChips,
  inventorySourceLines,
  inventoryStatusView,
  summarizeInventory,
} from './plugin-inventory-view.ts';

/** 与内核同源地造一行（避免手写形状漂移）。 */
function entryOf(over: Partial<InventoryInput>) {
  const res = buildPluginInventory({
    remote: { available: true, plugins: [] },
    local: { dependencies: {}, bundles: [] },
    isInstalled: () => false,
    ...over,
  } satisfies InventoryInput);
  assert.equal(res.entries.length, 1);
  return { entry: res.entries[0]!, result: res };
}

test('状态映射穷尽：每个状态都有 kind + 字典键，绝不渲染裸枚举', () => {
  for (const [status, view] of Object.entries(INVENTORY_STATUS_VIEW)) {
    assert.ok(['ok', 'info', 'warn', 'error'].includes(view.kind), `bad kind for ${status}`);
    assert.match(view.labelKey, /^inventory\.status\./);
    assert.match(view.hintKey, /^inventory\.statusHint\./);
    assert.equal(view.labelKey, 'inventory.status.' + status.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase()));
  }
  // 半装与缺席必须是 warn 语义（需要用户处理），已装已启用才是 ok
  assert.equal(INVENTORY_STATUS_VIEW['half-installed'].kind, 'warn');
  assert.equal(INVENTORY_STATUS_VIEW['missing'].kind, 'warn');
  assert.equal(INVENTORY_STATUS_VIEW['enabled'].kind, 'ok');
});

test('未知状态回落 unknown 文案（前端新、宿主旧也不显示枚举名）', () => {
  const view = inventoryStatusView('something-new-from-host');
  assert.deepEqual(view, INVENTORY_STATUS_UNKNOWN_VIEW);
  assert.equal(view.labelKey, 'inventory.status.unknown');
});

test('可用 / 不可用时状态映射一致（不可达不改变本机状态的措辞）', () => {
  for (const status of Object.keys(INVENTORY_STATUS_VIEW)) {
    assert.equal(inventoryStatusView(status).labelKey, INVENTORY_STATUS_VIEW[status as keyof typeof INVENTORY_STATUS_VIEW].labelKey);
  }
});

test('inventorySourceLines：远端不可达时绝不显示「远端声明」行', () => {
  const { entry } = entryOf({
    remote: { available: true, plugins: [{ name: 'pkg-a', spec: '^1.0.0' }] },
    local: { dependencies: { 'pkg-a': 'link:D:/a' }, bundles: [] },
    isInstalled: () => true,
  });
  assert.deepEqual(inventorySourceLines(entry, true), [
    { key: 'inventory.src.local', spec: 'link:D:/a' },
    { key: 'inventory.src.remote', spec: '^1.0.0' },
  ]);
  // 同一行在远端不可达时只剩本机声明
  assert.deepEqual(inventorySourceLines(entry, false), [
    { key: 'inventory.src.local', spec: 'link:D:/a' },
  ]);
});

test('inventorySourceLines：远端声明无 spec 时回传空串（由组件换用「无 spec」文案）', () => {
  const { entry } = entryOf({ remote: { available: true, plugins: [{ name: 'pkg-b' }] } });
  assert.deepEqual(inventorySourceLines(entry, true), [{ key: 'inventory.src.remote', spec: '' }]);
});

test('inventoryChips：本地来源标记；已失效时只留「已失效」一个（更紧要）', () => {
  const ok = entryOf({
    local: { dependencies: { a: 'link:D:/a' }, bundles: [] },
    isInstalled: () => true,
  }).entry;
  assert.deepEqual(inventoryChips(ok), ['inventory.chip.localSource']);

  const archived = entryOf({
    local: { dependencies: { a: 'link:D:/gone' }, bundles: [] },
    isInstalled: () => false,
    isSourceArchived: () => true,
  }).entry;
  assert.deepEqual(inventoryChips(archived), ['inventory.chip.sourceArchived']);

  const plain = entryOf({ local: { dependencies: { a: '^1.0.0' }, bundles: ['a'] }, isInstalled: () => true }).entry;
  assert.deepEqual(inventoryChips(plain), []);
});

test('summarizeInventory：与内核 counts 同值（界面统计不许自算一套）', () => {
  const res = buildPluginInventory({
    remote: { available: true, plugins: [{ name: 'remote-missing' }] },
    local: { dependencies: { half: '^1.0.0', on: '^1.0.0' }, bundles: ['on'] },
    configNames: ['orphan'],
    isInstalled: (n) => n === 'half' || n === 'on',
    isBundle: () => true,
  });
  const s = summarizeInventory(res);
  assert.deepEqual(s, {
    total: 4,
    enabled: 1,
    halfInstalled: 1,
    missing: 1,
    configurationOnly: 1,
  });
  assert.deepEqual(s, {
    total: res.counts.total,
    enabled: res.counts.enabled,
    halfInstalled: res.counts.halfInstalled,
    missing: res.counts.missing,
    configurationOnly: res.counts.configurationOnly,
  });
});

test('summarizeInventory：缺 counts（旧宿主）时按行现算，不抛错', () => {
  const res = buildPluginInventory({
    remote: { available: true, plugins: [] },
    local: { dependencies: { on: '^1.0.0' }, bundles: ['on'] },
    isInstalled: () => true,
    isBundle: () => true,
  });
  const legacy = { ...res, counts: undefined } as unknown as typeof res;
  assert.equal(summarizeInventory(legacy).total, 1);
});
