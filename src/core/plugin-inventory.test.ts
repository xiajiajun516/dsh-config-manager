/**
 * 远端依赖清单内核单测（node:test + node:assert，零依赖）。
 *
 * 覆盖验收要求：远端不可达 / 三源并集去重 / 半装判定 / 本地 spec → localSource / configurationOnly。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPluginInventory,
  collectConfigPluginNames,
  collectPatchLineNames,
  isLocalSourceSpec,
  localSourcePath,
  parseRemotePluginsSection,
} from './plugin-inventory.ts';
import type { InventoryInput, InventoryResult } from './plugin-inventory.ts';

/** 被测输入的默认值：空远端（可达）+ 空本机；逐用例覆盖需要的部分。 */
function input(over: Partial<InventoryInput> = {}): InventoryInput {
  return {
    remote: { available: true, plugins: [] },
    local: { dependencies: {}, bundles: [] },
    configNames: [],
    isInstalled: () => false,
    ...over,
  };
}

function entryOf(res: InventoryResult, name: string) {
  const found = res.entries.find((e) => e.name === name);
  assert.ok(found !== undefined, `缺行：${name}`);
  return found;
}

/* ------------------------------------------------------------ 远端不可达 */

test('远端不可达：available=false + error 如实透传，绝不谎报「远端没声明」', () => {
  const res = buildPluginInventory(input({
    remote: { available: false, error: 'connect ETIMEDOUT 10.0.0.1:443' },
    local: { dependencies: { 'pkg-local': '^1.0.0' }, bundles: ['pkg-local'] },
    isInstalled: (n) => n === 'pkg-local',
    versionOf: (n) => (n === 'pkg-local' ? '1.0.0' : ''),
    configNames: ['pkg-config-only'],
  }));

  assert.equal(res.available, false);
  assert.equal(res.error, 'connect ETIMEDOUT 10.0.0.1:443');
  // 远端未知 → 每行的远端字段只能是 false（未取到），且界面必须靠 available 区分
  for (const e of res.entries) {
    assert.equal(e.requested, false);
    assert.equal(e.configuredInRemote, false);
    assert.equal(e.inRemote, false);
  }
  // 本机事实不受影响（照常判定）
  assert.equal(entryOf(res, 'pkg-local').status, 'enabled');
  assert.equal(entryOf(res, 'pkg-config-only').status, 'configuration-only');
});

test('远端不可达时 configurationOnly 仍是纯本机事实（不因远端未知而改口）', () => {
  const res = buildPluginInventory(input({
    remote: { available: false, error: 'ENOTFOUND' },
    configNames: ['orphan'],
  }));
  const orphan = entryOf(res, 'orphan');
  assert.equal(orphan.configurationOnly, true);
  assert.equal(orphan.installed, false);
  assert.equal(orphan.status, 'configuration-only');
});

/* ------------------------------------------------------------ 三源并集去重 */

test('三源并集去重：远端 ∪ 本机依赖 ∪ 配置引用，同名只出一行', () => {
  const res = buildPluginInventory(input({
    remote: {
      available: true,
      snapshotId: 'snap-1',
      plugins: [
        { name: 'both', spec: '^2.0.0' },
        { name: 'remote-only', spec: '^1.0.0' },
        { name: 'both', spec: '^9.9.9' }, // 重复声明 → 只留第一条
      ],
      configuredNames: ['remote-only'],
    },
    local: {
      dependencies: { both: '^2.0.0', 'local-only': '^3.0.0' },
      bundles: ['both'],
    },
    configNames: ['remote-only', 'config-only'],
    isInstalled: (n) => n === 'both' || n === 'local-only',
    isBundle: () => true,
  }));

  assert.equal(res.available, true);
  assert.equal(res.snapshotId, 'snap-1');
  // 并集 = 远端声明 ∪ 本机依赖 ∪ 本机配置引用。**远端 patch 行引用的名字不进并集**
  // （它是导出机的配置层，不是「本机要对齐的插件」）—— 只作为既有行的远端侧装饰。
  assert.deepEqual(res.entries.map((e) => e.name), ['both', 'config-only', 'local-only', 'remote-only']);
  assert.equal(res.counts.total, 4);

  const both = entryOf(res, 'both');
  assert.equal(both.inRemote, true);
  assert.equal(both.inLocalDependencies, true);
  assert.equal(both.inLocalConfig, false);
  assert.equal(both.remoteSpec, '^2.0.0'); // 首条声明生效，重复项不覆盖
  assert.equal(both.localSpec, '^2.0.0');

  // 「远端配置层引用」是**装饰字段**：名字只有在它已由三源之一带进来时，该字段才有值
  const remoteOnly = entryOf(res, 'remote-only');
  assert.equal(remoteOnly.configuredInRemote, true);
  assert.equal(remoteOnly.requested, true);
});

test('远端 patch 行独有、且不在其余两源的名字：不产生行（并集口径=三源，绝不凭空多行）', () => {
  const res = buildPluginInventory(input({
    remote: { available: true, plugins: [{ name: 'declared' }], configuredNames: ['remote-config-only'] },
  }));
  assert.deepEqual(res.entries.map((e) => e.name), ['declared']);
});

test('来源标记与排序稳定：字典序输出，不受并集拼接顺序影响', () => {
  const a = buildPluginInventory(input({ remote: { available: true, plugins: [{ name: 'zeta' }, { name: 'alpha' }] } }));
  const b = buildPluginInventory(input({
    remote: { available: true, plugins: [] },
    local: { dependencies: { zeta: '^1.0.0', alpha: '^1.0.0' }, bundles: [] },
  }));
  assert.deepEqual(a.entries.map((e) => e.name), ['alpha', 'zeta']);
  assert.deepEqual(b.entries.map((e) => e.name), ['alpha', 'zeta']);
});

/* ------------------------------------------------------------ 半装判定 */

test('半装：包在 node_modules 但不在 dsh.profile.bundles（bundle 形态）→ half-installed', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: { 'half-bundle': '^1.0.0' }, bundles: [] },
    isInstalled: () => true,
    isBundle: () => true,
    versionOf: () => '1.2.3',
  }));
  const e = entryOf(res, 'half-bundle');
  assert.equal(e.installed, true);
  assert.equal(e.enabled, false);
  assert.equal(e.isBundle, true);
  assert.equal(e.halfInstalled, true);
  assert.equal(e.status, 'half-installed');
  assert.equal(e.version, '1.2.3');
  assert.equal(res.counts.halfInstalled, 1);
  assert.equal(res.counts.enabled, 0);
});

test('已装且已启用与半装必须可区分（同样的落盘、只差 bundles 声明）', () => {
  const deps = { 'as-bundle': '^1.0.0' };
  const enabledRes = buildPluginInventory(input({
    local: { dependencies: deps, bundles: ['as-bundle'] },
    isInstalled: () => true,
    isBundle: () => true,
  }));
  const halfRes = buildPluginInventory(input({
    local: { dependencies: deps, bundles: [] },
    isInstalled: () => true,
    isBundle: () => true,
  }));
  assert.equal(entryOf(enabledRes, 'as-bundle').status, 'enabled');
  assert.equal(entryOf(enabledRes, 'as-bundle').halfInstalled, false);
  assert.equal(entryOf(halfRes, 'as-bundle').status, 'half-installed');
  assert.notEqual(entryOf(enabledRes, 'as-bundle').status, entryOf(halfRes, 'as-bundle').status);
});

test('已装但非 bundle 形态 → dependency-only，不算半装', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: { 'plain-dep': '^1.0.0' }, bundles: [] },
    isInstalled: () => true,
    isBundle: () => false,
  }));
  const e = entryOf(res, 'plain-dep');
  assert.equal(e.halfInstalled, false);
  assert.equal(e.status, 'dependency-only');
});

test('声明在 bundles、本 profile 无落盘副本 → host-resolved（不等于半装）', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: {}, bundles: ['host-layer'] },
    configNames: ['host-layer'],
    isInstalled: () => false,
  }));
  const e = entryOf(res, 'host-layer');
  assert.equal(e.enabled, true);
  assert.equal(e.installed, false);
  assert.equal(e.halfInstalled, false);
  assert.equal(e.status, 'host-resolved');
});

test('只在 bricks/bundles 里声明、三源都没提到的名字：不进表（口径=三源，不得凭空造行）', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: {}, bundles: ['@deepseek-ai/dsh-base'] },
    isInstalled: () => true,
    isBundle: () => true,
  }));
  assert.deepEqual(res.entries, []);
});

test('半装判定不因远端不可达而失效（纯本机事实）', () => {
  const res = buildPluginInventory(input({
    remote: { available: false, error: 'offline' },
    local: { dependencies: { 'half-bundle': '^1.0.0' }, bundles: [] },
    isInstalled: () => true,
    isBundle: () => true,
  }));
  assert.equal(entryOf(res, 'half-bundle').status, 'half-installed');
});

/* ------------------------------------------------------------ localSource */

test('本地 spec → localSource；远端 spec 不参与（本字段只看本机）', () => {
  const res = buildPluginInventory(input({
    remote: { available: true, plugins: [{ name: 'remote-link', spec: 'link:D:/other/repo' }] },
    local: { dependencies: { 'local-link': 'link:D:/Projects/x' }, bundles: [] },
    isInstalled: () => true,
  }));
  assert.equal(entryOf(res, 'local-link').localSource, true);
  assert.equal(entryOf(res, 'local-link').localSpec, 'link:D:/Projects/x');
  assert.equal(entryOf(res, 'remote-link').localSource, false);
  assert.equal(entryOf(res, 'remote-link').remoteSpec, 'link:D:/other/repo');
  assert.equal(res.counts.localSource, 1);
});

test('本地来源丢失 → sourceArchived（只在本地来源上判定）', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: { gone: 'file:./missing', ok: 'link:D:/Projects/present', reg: '^1.0.0' }, bundles: [] },
    isInstalled: (n) => n !== 'gone',
    isSourceArchived: (name) => name === 'gone',
  }));
  assert.equal(entryOf(res, 'gone').sourceArchived, true);
  assert.equal(entryOf(res, 'ok').sourceArchived, false);
  assert.equal(entryOf(res, 'reg').sourceArchived, false);
  assert.equal(entryOf(res, 'reg').localSource, false);
});

test('isLocalSourceSpec / localSourcePath 只认四类本地前缀', () => {
  assert.equal(isLocalSourceSpec('link:D:/a'), true);
  assert.equal(isLocalSourceSpec('file:../a'), true);
  assert.equal(isLocalSourceSpec('workspace:*'), true);
  assert.equal(isLocalSourceSpec('portal:./a'), true);
  assert.equal(isLocalSourceSpec('^1.2.3'), false);
  assert.equal(isLocalSourceSpec('github:u/r'), false);
  assert.equal(isLocalSourceSpec('npm:foo@1.0.0'), false);
  assert.equal(localSourcePath('link: D:/a/b '), 'D:/a/b');
  assert.equal(localSourcePath('^1.2.3'), null);
});

/* ------------------------------------------------------------ configurationOnly */

test('configurationOnly：只被本机配置层引用（无依赖声明、无落盘）', () => {
  const res = buildPluginInventory(input({
    local: { dependencies: { declared: '^1.0.0' }, bundles: [] },
    configNames: ['declared', 'orphan'],
    isInstalled: () => false,
  }));
  const orphan = entryOf(res, 'orphan');
  assert.equal(orphan.configurationOnly, true);
  assert.equal(orphan.configuredLocally, true);
  assert.equal(orphan.status, 'configuration-only');

  // 有依赖声明 → 缺席（缺装），不当成 configurationOnly
  const declared = entryOf(res, 'declared');
  assert.equal(declared.configurationOnly, false);
  assert.equal(declared.status, 'missing');

  assert.equal(res.counts.configurationOnly, 1);
  assert.equal(res.counts.missing, 1);
});

/* ------------------------------------------------------------ 配置名收集 */

test('collectConfigPluginNames：顶层数组 + insert 块，且绝不递归进 config', () => {
  const doc = [
    { id: 'wallpaper-engine', disabled: true }, // 无 name → 不收集
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { preference: 'dark' } },
    {
      id: 'llm',
      name: 'pkg-llm',
      config: {
        providers: { g: { models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] } },
      },
    },
    { insert: [{ name: 'pkg-inserted' }, { id: 'no-name' }] },
  ];
  assert.deepEqual(collectConfigPluginNames(doc), ['@deepseek-ai/dsh-client-ui-theme', 'pkg-llm', 'pkg-inserted']);
});

test('collectConfigPluginNames：形状不符一律跳过（宁可少收，不可猜）', () => {
  assert.deepEqual(collectConfigPluginNames(null), []);
  assert.deepEqual(collectConfigPluginNames({ name: 'not-an-array' }), []);
  assert.deepEqual(collectConfigPluginNames(['str', 42, [], { name: '' }, { name: 7 }]), []);
  assert.deepEqual(collectConfigPluginNames([{ insert: 'nope' }]), []);
});

/* ------------------------------------------------------------ 远端载荷解析（不可信输入） */

test('parseRemotePluginsSection：正常快照 plugins 分区 → 声明 + 远端配置引用', () => {
  const parsed = parseRemotePluginsSection({
    version: 1,
    plugins: [
      { name: 'pkg-a', version: '1.0.0', spec: '^1.0.0' },
      { name: 'pkg-b', bundlesOnly: true },
      { name: '', spec: 'ignored' },
      { spec: 'no-name' },
      'junk',
      null,
    ],
    patch: [
      { file: 'cordis.patch.yml', lineId: 'ui-theme', raw: { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme' } },
      { file: 'cordis.patch.yml', lineId: 'insert-block', raw: { insert: [{ name: 'pkg-inserted' }] } },
      { file: 'cordis.patch.yml', lineId: 'no-raw' },
      null,
    ],
  });
  assert.deepEqual(parsed.plugins, [
    { name: 'pkg-a', version: '1.0.0', spec: '^1.0.0' },
    { name: 'pkg-b', bundlesOnly: true },
  ]);
  assert.deepEqual(parsed.configuredNames, ['@deepseek-ai/dsh-client-ui-theme', 'pkg-inserted']);
});

test('parseRemotePluginsSection：形状不符一律回空（绝不猜、绝不抛）', () => {
  for (const bad of [null, undefined, 42, 'x', [], { plugins: 'nope' }, { plugins: [1, 2] }]) {
    const parsed = parseRemotePluginsSection(bad);
    assert.deepEqual(parsed.plugins, []);
    assert.deepEqual(parsed.configuredNames, []);
  }
});

test('collectPatchLineNames：单条目与 insert 数组两种 raw 都收，形状不符跳过', () => {
  assert.deepEqual(collectPatchLineNames([
    { raw: { name: 'a' } },
    { raw: [{ name: 'b' }, { insert: [{ name: 'c' }] }] },
    { raw: 7 },
    { notRaw: true },
    'junk',
  ]), ['a', 'b', 'c']);
});

/* ------------------------------------------------------------ 形状边界 */

test('远端声明缺 name / 空名字不产生行', () => {
  const res = buildPluginInventory(input({
    remote: { available: true, plugins: [{ name: '' }, { name: 'ok' }] },
  }));
  assert.deepEqual(res.entries.map((e) => e.name), ['ok']);
});

test('空输入 → 空表且 available 如实（可达但远端无声明）', () => {
  const res = buildPluginInventory(input());
  assert.equal(res.available, true);
  assert.deepEqual(res.entries, []);
  assert.deepEqual(res.counts, { total: 0, enabled: 0, halfInstalled: 0, missing: 0, configurationOnly: 0, localSource: 0 });
  assert.equal(res.snapshotId, undefined);
  assert.equal(res.error, undefined);
});
