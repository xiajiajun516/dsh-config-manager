/**
 * #132 跟随远端删除插件：两个纯函数的行为规格。
 *
 * 接缝（seam）：
 *  1. planPluginRemovals —— 「哪些已装插件该被删」的唯一判据（开关、祖先、远端、本机三方）；
 *  2. mergePluginsSection —— plugins 分区的按名三方合并（否则通用 JSON 合并对数组两侧各改即冲突，
 *     会把「远端删 X + 本机新装 Y」误报成整分区冲突，让删除永远进不了自动应用）。
 *
 * 两个函数都是纯函数、零 I/O：引擎与 UI 都只读它们的返回值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergePluginsSection, planPluginRemovals } from './plugin-removals.ts';
import type { PluginEntry, PluginsSection } from '../schema/types.ts';

function entry(name: string, version: string, extra: Partial<PluginEntry> = {}): PluginEntry {
  return { name, version, isBundle: false, inBundles: [], enabled: true, ...extra };
}

const SELF = 'dsh-config-manager';

/* ------------------------------------------------------------------ 计划：删除判定 */

test('planPluginRemovals: 开关关闭 → 一个都不删，候选降级为 switch-off', () => {
  const plan = planPluginRemovals({
    enabled: false,
    ancestor: [entry('alpha', '1.2.0')],
    remote: [],
    local: [entry('alpha', '1.2.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, [{ name: 'alpha', reason: 'switch-off' }]);
});

test('planPluginRemovals: 祖先有、远端没有、本机未改 → 删（issue 行为表 A→B）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('alpha', '1.2.0'), entry('beta', '0.4.0')],
    remote: [entry('beta', '0.4.0')],
    local: [entry('alpha', '1.2.0'), entry('beta', '0.4.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, [{ name: 'alpha', version: '1.2.0' }]);
  assert.deepEqual(plan.conflicts, []);
});

test('planPluginRemovals: 本机新装的插件（祖先没有）绝不删', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('alpha', '1.2.0')],
    remote: [],
    local: [entry('alpha', '1.2.0'), entry('mine', '9.9.9')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, [{ name: 'alpha', version: '1.2.0' }]);
  assert.equal(plan.removals.some((r) => r.name === 'mine'), false);
});

test('planPluginRemovals: 本机版本已变（本地升级）→ 报冲突、不删（issue 行为表 B 升级 X）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('alpha', '1.2.0')],
    remote: [],
    local: [entry('alpha', '1.3.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.conflicts, [{ name: 'alpha', reason: 'version-changed', ancestorVersion: '1.2.0', localVersion: '1.3.0' }]);
});

test('planPluginRemovals: bundlesOnly 条目永不删（它由 DSH 自身安装位置解析，不是本 profile 的依赖）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('host-layer', '', { bundlesOnly: true })],
    remote: [],
    local: [entry('host-layer', '', { bundlesOnly: true })],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, [{ name: 'host-layer', reason: 'bundles-only' }]);
});

test('planPluginRemovals: 本插件自己永不删（删了等于把正在跑的宿主插件卸掉）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry(SELF, '0.2.0')],
    remote: [],
    local: [entry(SELF, '0.2.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, [{ name: SELF, reason: 'self' }]);
});

test('planPluginRemovals: 远端仍装着 → 不删', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('alpha', '1.2.0')],
    remote: [entry('alpha', '1.2.0')],
    local: [entry('alpha', '1.2.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, [{ name: 'alpha', reason: 'still-in-remote' }]);
});

test('planPluginRemovals: 本机根本没装 → 无需卸载（不产生动作，也不报错）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: [entry('alpha', '1.2.0')],
    remote: [],
    local: [],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, [{ name: 'alpha', reason: 'not-installed' }]);
});

test('planPluginRemovals: 没有祖先（首次同步）→ 一律不删（无法区分「对方删了」与「本机独有」）', () => {
  const plan = planPluginRemovals({
    enabled: true,
    ancestor: undefined,
    remote: [],
    local: [entry('alpha', '1.2.0')],
    selfName: SELF,
  });
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.kept, []);
});

/* ------------------------------------------------------------------ 合并：按名三方 */

/** 钩子只在开关打开时参与；单测里显式开启（关闭路径另有用例）。 */
const ON = { deletePlugins: true };

function section(plugins: PluginEntry[], extra: Partial<PluginsSection> = {}): PluginsSection {
  return { version: 1, plugins, patch: [], ...extra };
}

test('mergePluginsSection: 远端删 X、本机新装 Y → 合并结果只留 Y，不报冲突', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.2.0'), entry('y', '2.0.0')]),
    section([]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.ok(res !== undefined);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual((res.merged as PluginsSection).plugins.map((p) => p.name), ['y']);
});

test('mergePluginsSection: 本机升级 X、远端删 X → modify-delete 冲突（不静默删也不静默留）', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.3.0')]),
    section([]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.ok(res !== undefined);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0]!.path, 'plugins.alpha');
  assert.equal(res.conflicts[0]!.reason, 'modify-delete');
});

test('mergePluginsSection: 两侧同版本 → 保留，两侧同删 → 消失', () => {
  const same = mergePluginsSection(
    section([entry('alpha', '1.2.0')]),
    section([entry('alpha', '1.2.0')]),
    undefined,
    ON,
  );
  assert.deepEqual((same!.merged as PluginsSection).plugins.map((p) => p.name), ['alpha']);
  const both = mergePluginsSection(section([]), section([]), section([entry('alpha', '1.2.0')]), ON);
  assert.deepEqual((both!.merged as PluginsSection).plugins, []);
});

test('mergePluginsSection: 无祖先时本机独有/远端独有都保留（不按删除解释）', () => {
  const res = mergePluginsSection(section([entry('mine', '1.0.0')]), section([entry('theirs', '1.0.0')]), undefined, ON);
  assert.deepEqual(res!.conflicts, []);
  assert.deepEqual((res!.merged as PluginsSection).plugins.map((p) => p.name).sort(), ['mine', 'theirs']);
});

test('mergePluginsSection: 两侧把同一插件改到不同版本 → both-modified 冲突', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.3.0')]),
    section([entry('alpha', '1.4.0')]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.equal(res!.conflicts.length, 1);
  assert.equal(res!.conflicts[0]!.reason, 'both-modified');
});

test('mergePluginsSection: 插件列表以外的字段（patch 行等）两侧不必相同 —— 不同即交回通用合并', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.2.0')], { pnpmWorkspace: 'onlyBuiltDependencies: [a]\n' }),
    section([entry('alpha', '1.2.0')], { pnpmWorkspace: 'onlyBuiltDependencies: [b]\n' }),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.equal(res, undefined, 'patch/pnpmWorkspace 的口径由通用路径负责，这里不自造第二套');
});

test('mergePluginsSection: 形状不认识 → undefined（畸形数据交通用路径的形状闸门）', () => {
  assert.equal(mergePluginsSection({ version: 2 } as unknown as PluginsSection, section([]), undefined, ON), undefined);
});

test('mergePluginsSection: 开关关着 → 钩子不参与（undefined = 通用合并，行为与 #132 之前逐字一致）', () => {
  assert.equal(
    mergePluginsSection(
      section([entry('alpha', '1.2.0')]),
      section([]),
      section([entry('alpha', '1.2.0')]),
      { deletePlugins: false },
    ),
    undefined,
    '开关关闭时绝不能丢掉本机条目：包还在盘上，下一轮导出会把它当本机独有推回远端 = 复活',
  );
});
