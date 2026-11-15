/**
 * #132 / #145：跟随远端删除插件的判据 + plugins 分区的按键三方合并。
 *
 * 接缝（seam）：
 *  1. planPluginRemovals —— 「哪些已装插件该被删」的唯一判据（开关、祖先、远端、本机三方）；
 *  2. mergePluginsSection —— plugins 分区的按键三方合并（否则通用 JSON 合并对数组两侧各改即冲突，
 *     会把「远端删 X + 本机新装 Y」误报成整分区冲突，让删除永远进不了自动应用）。
 *
 * issue #145 起两者解耦：合并**恒参与**（开关不再决定钩子是否介入），开关只管「远端删了要不要真删」。
 * 两个函数都是纯函数、零 I/O：引擎与 UI 都只读它们的返回值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergePluginsSection, planPluginRemovals } from './plugin-removals.ts';
import type { PatchLine, PluginEntry, PluginsSection } from '../schema/types.ts';

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

/* ------------------------------------------------------------------ 合并：按键三方 */

/** 开关打开：远端删了、本机未改的条目会被真的删掉（删除判据用同一份开关）。 */
const ON = { deletePlugins: true };

function section(plugins: PluginEntry[], extra: Partial<PluginsSection> = {}): PluginsSection {
  return { version: 1, plugins, patch: [], ...extra };
}

function line(file: string, lineId: string, raw: unknown, redactedPaths?: string[]): PatchLine {
  return { file, lineId, raw, ...(redactedPaths === undefined ? {} : { redactedPaths }) };
}

function names(res: { merged: unknown } | undefined): string[] {
  assert.ok(res !== undefined);
  return ((res.merged as PluginsSection).plugins ?? []).map((p) => p.name);
}

test('mergePluginsSection: 远端删 X、本机新装 Y → 合并结果只留 Y，不报冲突', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.2.0'), entry('y', '2.0.0')]),
    section([]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.deepEqual(res?.conflicts, []);
  assert.deepEqual(names(res), ['y']);
});

test('mergePluginsSection: 本机升级 X、远端删 X → modify-delete 冲突（不静默删也不静默留）', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.3.0')]),
    section([]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.equal(res?.conflicts.length, 1);
  assert.equal(res?.conflicts[0]!.path, 'plugins.alpha');
  assert.equal(res?.conflicts[0]!.reason, 'modify-delete');
});

test('mergePluginsSection: 两侧同版本 → 保留，两侧同删 → 消失', () => {
  const same = mergePluginsSection(section([entry('alpha', '1.2.0')]), section([entry('alpha', '1.2.0')]), undefined, ON);
  assert.deepEqual(names(same), ['alpha']);
  const both = mergePluginsSection(section([]), section([]), section([entry('alpha', '1.2.0')]), ON);
  assert.deepEqual(names(both), []);
});

test('mergePluginsSection: 无祖先时本机独有/远端独有都保留（不按删除解释）', () => {
  const res = mergePluginsSection(section([entry('mine', '1.0.0')]), section([entry('theirs', '1.0.0')]), undefined, ON);
  assert.deepEqual(res?.conflicts, []);
  assert.deepEqual(names(res).sort(), ['mine', 'theirs']);
});

test('mergePluginsSection: 两侧把同一插件改到不同版本 → both-modified 冲突', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.3.0')]),
    section([entry('alpha', '1.4.0')]),
    section([entry('alpha', '1.2.0')]),
    ON,
  );
  assert.equal(res?.conflicts.length, 1);
  assert.equal(res?.conflicts[0]!.reason, 'both-modified');
});

test('mergePluginsSection: 开关关着 + 远端删了本机未改的插件 → 保留（合并仍参与，绝不交回通用路径）', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.2.0')]),
    section([]),
    section([entry('alpha', '1.2.0')]),
    { deletePlugins: false },
  );
  assert.ok(res !== undefined, '关着开关也必须参与：否则 patch 行等与卸载无关的改动会整分区冲突');
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(names(res), ['alpha'], '包还在盘上，删了只会下一轮复活 —— 保留才是诚实结果');
});

test('mergePluginsSection: 不传钩子（缺省开关关）也能按名/按行合并', () => {
  const res = mergePluginsSection(
    section([entry('alpha', '1.2.0')], { patch: [line('cfg.yml', 'l1', { a: 1 })] }),
    section([], { patch: [line('cfg.yml', 'l2', { b: 2 })] }),
    section([entry('alpha', '1.2.0')], { patch: [line('cfg.yml', 'l1', { a: 1 })] }),
  );
  assert.ok(res !== undefined);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(names(res), ['alpha']);
  assert.deepEqual((res.merged as PluginsSection).patch.map((p) => p.lineId), ['l1', 'l2']);
});

test('mergePluginsSection: 自身插件远端删了也保留、两侧改不同版本时本机胜，且都不报冲突', () => {
  const deleted = mergePluginsSection(
    section([entry(SELF, '0.9.1')]),
    section([]),
    section([entry(SELF, '0.9.1')]),
    { ...ON, selfPluginName: SELF },
  );
  assert.deepEqual(deleted?.conflicts, []);
  assert.deepEqual(names(deleted), [SELF]);
  const changed = mergePluginsSection(
    section([entry(SELF, '0.9.2')]),
    section([entry(SELF, '0.9.3')]),
    section([entry(SELF, '0.9.1')]),
    { ...ON, selfPluginName: SELF },
  );
  assert.deepEqual(changed?.conflicts, []);
  assert.deepEqual(names(changed), [SELF]);
  assert.equal(((changed!.merged as PluginsSection).plugins[0]!).version, '0.9.2');
});

test('mergePluginsSection: patch 行按 file+lineId 配对 —— 同一行两侧都改 → both-modified（路径带文件名）', () => {
  const res = mergePluginsSection(
    section([], { patch: [line('cfg.yml', 'l1', { timeout: 10 })] }),
    section([], { patch: [line('cfg.yml', 'l1', { timeout: 20 })] }),
    section([], { patch: [line('cfg.yml', 'l1', { timeout: 1 })] }),
    ON,
  );
  assert.equal(res?.conflicts.length, 1);
  assert.equal(res?.conflicts[0]!.reason, 'both-modified');
  assert.equal(res?.conflicts[0]!.path, 'patch.cfg.yml');
});

test('mergePluginsSection: 同 lineId 不同文件不撞键（两行都保留）', () => {
  const res = mergePluginsSection(
    section([], { patch: [line('a.yml', 'l1', { x: 1 })] }),
    section([], { patch: [line('b.yml', 'l1', { y: 1 })] }),
    undefined,
    ON,
  );
  assert.deepEqual(res?.conflicts, []);
  assert.deepEqual((res!.merged as PluginsSection).patch.map((p) => p.file).sort(), ['a.yml', 'b.yml']);
});

test('mergePluginsSection: 导出侧剥空 + redactedPaths 与远端明文是同一行（门②，不报冲突）', () => {
  // 本机（导出侧）：secret 被剥成空串并记进 redactedPaths；远端/祖先：明文、无该字段。
  const redacted = line('cfg.yml', 'l1', { token: '', keep: 1 }, ['raw.token']);
  const plain = line('cfg.yml', 'l1', { token: 'sk-live-123', keep: 1 });
  const res = mergePluginsSection(section([], { patch: [redacted] }), section([], { patch: [plain] }), section([], { patch: [plain] }), ON);
  assert.deepEqual(res?.conflicts, [], '被剥空的叶子按三侧 redactedPaths 并集归一化后是同一身份');
  // 身份相同 → 保留本机那一行（导出侧形态）：redactedPaths 原样留下，写回守卫据此换回本机明文。
  const merged = (res!.merged as PluginsSection).patch[0]!;
  assert.deepEqual(merged.raw, { token: '', keep: 1 });
  assert.deepEqual(merged.redactedPaths, ['raw.token']);
  // 归一化只抹「被声明剥空」的叶子，绝不挡真实改动：远端把 keep 改了 → 采用远端那一行。
  const changed = line('cfg.yml', 'l1', { token: 'sk-live-123', keep: 2 });
  const res2 = mergePluginsSection(section([], { patch: [redacted] }), section([], { patch: [changed] }), section([], { patch: [plain] }), ON);
  assert.deepEqual(res2?.conflicts, []);
  assert.deepEqual((res2!.merged as PluginsSection).patch[0]!.raw, { token: 'sk-live-123', keep: 2 });
});

test('mergePluginsSection: 不在 redactedPaths 里的字段真改了 → 仍然 both-modified', () => {
  const redacted = line('cfg.yml', 'l1', { token: '', keep: 2 }, ['raw.token']);
  const remote = line('cfg.yml', 'l1', { token: 'sk-other', keep: 3 });
  const res = mergePluginsSection(
    section([], { patch: [redacted] }),
    section([], { patch: [remote] }),
    section([], { patch: [line('cfg.yml', 'l1', { token: 'sk-base', keep: 1 })] }),
    ON,
  );
  assert.equal(res?.conflicts.length, 1);
  assert.equal(res?.conflicts[0]!.reason, 'both-modified');
});

test('mergePluginsSection: 合并输出保留本机行的 redactedPaths（写回守卫要靠它）', () => {
  const redacted = line('cfg.yml', 'l1', { token: '', keep: 1 }, ['raw.token']);
  const res = mergePluginsSection(
    section([], { patch: [redacted] }),
    section([], { patch: [line('cfg.yml', 'l1', { token: '', keep: 1 }, ['raw.token']), line('cfg.yml', 'l2', { b: 2 })] }),
    undefined,
    ON,
  );
  assert.deepEqual(res?.conflicts, []);
  const kept = (res!.merged as PluginsSection).patch.find((p) => p.lineId === 'l1')!;
  assert.deepEqual(kept.redactedPaths, ['raw.token']);
  assert.equal((res!.merged as PluginsSection).patch.length, 2);
});

test('mergePluginsSection: pnpmWorkspace 单侧改动取该侧，两侧都改 → overlap 冲突（不猜用哪一份）', () => {
  const oneSide = mergePluginsSection(
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [a]\n' }),
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [b]\n' }),
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [a]\n' }),
    ON,
  );
  assert.deepEqual(oneSide?.conflicts, []);
  assert.equal((oneSide!.merged as PluginsSection).pnpmWorkspace, 'onlyBuiltDependencies: [b]\n');
  const both = mergePluginsSection(
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [b]\n' }),
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [c]\n' }),
    section([], { pnpmWorkspace: 'onlyBuiltDependencies: [a]\n' }),
    ON,
  );
  assert.equal(both?.conflicts.length, 1);
  assert.equal(both?.conflicts[0]!.path, 'pnpmWorkspace');
  assert.equal(both?.conflicts[0]!.reason, 'overlap');
});

test('mergePluginsSection: 形状不认识 → undefined（畸形数据交通用路径的形状闸门）', () => {
  assert.equal(mergePluginsSection({ version: 2 } as unknown as PluginsSection, section([]), undefined, ON), undefined);
});
