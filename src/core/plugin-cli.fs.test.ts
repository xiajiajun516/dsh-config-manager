/**
 * plugin-cli 文件读取层测试（M5 补写，failing-first 目标：listInstalled 从文件实时读真实版本）。
 * 使用真实临时目录（node:os tmpdir）+ 真实 fs，不 mock 磁盘——验证的是真实读取语义：
 *   - readInstalledVersion 读 node_modules/<name>/package.json 落盘版本（不是声明 spec）
 *   - readInstalled 过滤 in-box bundles（@deepseek-ai/dsh-base / dsh-web-app / dsh-headless）
 *   - listInstalledPlugins 组装 PluginInfo（name/version/isBundle/inBundles）
 *   - reconcileBundles 按已装状态维护 dsh.profile.bundles 并写回
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isBundlesOnlyEntry, listInstalledPlugins, mergeBundleDeclaration, readInstalled, readInstalledVersion,
  reconcileBundles, resolveProfileDir,
} from './plugin-cli.ts';
import { enterRescueMode } from './boot-rescue.ts';
import type { PluginInfo } from './types.ts';

/** 建一个带真实文件的临时 profile（web），返回 { homeDir, profileDir, cleanup }。 */
function makeTempProfile(deps: Record<string, string>, bundles: string[] = []): {
  homeDir: string;
  profileDir: string;
  cleanup: () => void;
} {
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-cm-fs-'));
  const profileDir = resolveProfileDir(homeDir, 'web');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', dependencies: deps, dsh: { profile: { bundles } } }, null, 2)}\n`,
    'utf8',
  );
  return {
    homeDir,
    profileDir,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

/** 写 node_modules/<name>/package.json。 */
function writeInstalledPkg(profileDir: string, name: string, version: string, bundlePatch?: string): void {
  const pkgDir = join(profileDir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (bundlePatch !== undefined) manifest['dsh'] = { bundle: { patch: bundlePatch } };
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

test('readInstalledVersion: 读 node_modules 落盘真实版本；未装 / 无 version 字段 → null', () => {
  const { profileDir, cleanup } = makeTempProfile({});
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '0.2.3');
    assert.equal(readInstalledVersion(profileDir, 'pkg-a'), '0.2.3');
    assert.equal(readInstalledVersion(profileDir, 'not-installed'), null, '未装 → null');
    // 落盘 package.json 存在但没有 version 字段 → null（不抛）
    writeInstalledPkg(profileDir, 'broken', 'x');
    writeFileSync(join(profileDir, 'node_modules', 'broken', 'package.json'), '{"name":"broken"}\n', 'utf8');
    assert.equal(readInstalledVersion(profileDir, 'broken'), null);
  } finally {
    cleanup();
  }
});

test('readInstalled: 返回真实依赖映射并过滤 in-box bundles，保留社区插件', () => {
  const { profileDir, cleanup } = makeTempProfile({
    '@deepseek-ai/dsh-base': '0.1.0-rc.6',
    '@deepseek-ai/dsh-web-app': '0.1.0-rc.6',
    '@deepseek-ai/dsh-headless': '0.1.0-rc.6',
    '@linxin666/dsh-ssh': '^0.1.12',
    'pkg-a': '1.0.0',
  });
  try {
    const installed = readInstalled(profileDir);
    assert.deepEqual(installed, { '@linxin666/dsh-ssh': '^0.1.12', 'pkg-a': '1.0.0' });
  } finally {
    cleanup();
  }
});

test('listInstalledPlugins: 版本取 node_modules 真实落盘版本（声明 ^0.1.0 → 实际 0.1.12）', () => {
  // failing-first 目标：listInstalled 从文件实时读真实版本，而非声明 spec。
  const { homeDir, profileDir, cleanup } = makeTempProfile({
    '@linxin666/dsh-ssh': '^0.1.0',
    'pkg-a': '1.0.0',
    'dsh-memory-evolve': 'github:csyangwen/dsh-memory-evolve',
    '@deepseek-ai/dsh-base': '0.1.0-rc.6',
  });
  try {
    writeInstalledPkg(profileDir, '@linxin666/dsh-ssh', '0.1.12', 'patch.yml');
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, 'dsh-memory-evolve', '1.0.0');
    writeInstalledPkg(profileDir, '@deepseek-ai/dsh-base', '0.1.0-rc.6');

    const list = listInstalledPlugins(homeDir, 'web');
    const ssh = list.find((p) => p.name === '@linxin666/dsh-ssh');
    const plain = list.find((p) => p.name === 'pkg-a');
    const git = list.find((p) => p.name === 'dsh-memory-evolve');
    assert.equal(ssh?.version, '0.1.12', '必须返回落盘真实版本，而不是声明的 ^0.1.0');
    assert.equal(ssh?.isBundle, true);
    assert.deepEqual(ssh?.inBundles, ['@linxin666/dsh-ssh'], '直接依赖的 bundle 自身就是 profile 层');
    assert.equal(plain?.version, '1.0.0');
    assert.equal(plain?.isBundle, false);
    assert.deepEqual(plain?.inBundles, []);
    // 声明 spec 原样保留：github 来源 / 版本区间都要随清单带出（导入重装依据）
    assert.equal(git?.spec, 'github:csyangwen/dsh-memory-evolve');
    assert.equal(ssh?.spec, '^0.1.0');
    assert.equal(list.some((p) => p.name === '@deepseek-ai/dsh-base'), false, 'in-box bundle 不出现');
    assert.equal(list.every((p: PluginInfo) => p.enabled === true), true, '文件视图依赖即视为启用');
  } finally {
    cleanup();
  }
});

test('listInstalledPlugins: 声明了依赖但未实际安装 → version 空串不抛', () => {
  const { homeDir, cleanup } = makeTempProfile({ 'ghost-dep': '^9.9.9' });
  try {
    // 不写 node_modules/ghost-dep：node_modules 缺失不应让 listInstalled 抛错
    const list = listInstalledPlugins(homeDir, 'web');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'ghost-dep');
    assert.equal(list[0]?.version, '', '未落盘 → 版本空串（不抛）');
  } finally {
    cleanup();
  }
});

test('issue #28: 仅由 dsh.profile.bundles 声明的层必须出现在已装清单里（此前完全不可见）', () => {
  // 场景：用户手动把社区 bundle 写进 dsh.profile.bundles（或某个安装路径只写了 bundles 而没写
  // dependencies）。reconcileBundles 对这类条目是**保留**的（移除条件要求曾是依赖），
  // 所以 DSH 启动时确实会挂载它 —— 但旧清单只遍历 dependencies，于是「装了却识别不到」。
  const { homeDir, profileDir, cleanup } = makeTempProfile(
    { 'pkg-a': '1.0.0', '@deepseek-ai/dsh-base': '0.1.0-rc.6' },
    ['@linxin666/dsh-web-ui-all', 'stale-pkg', '@deepseek-ai/dsh-base'],
  );
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, '@linxin666/dsh-web-ui-all', '0.3.1', 'patch.yml');
    writeInstalledPkg(profileDir, '@deepseek-ai/dsh-base', '0.1.0-rc.6');

    const list = listInstalledPlugins(homeDir, 'web');
    const bundleOnly = list.find((p) => p.name === '@linxin666/dsh-web-ui-all');
    assert.ok(bundleOnly !== undefined, '仅 bundles 声明的层必须出现在清单里');
    assert.equal(bundleOnly?.version, '0.3.1', '版本取 node_modules 落盘版本');
    assert.equal(bundleOnly?.isBundle, true);
    assert.deepEqual(bundleOnly?.inBundles, ['@linxin666/dsh-web-ui-all']);
    assert.equal(bundleOnly?.spec, undefined, '无依赖声明 → 无 spec');
    // issue #95：本机**有**落盘副本的手工层不是「host 自带层」，标记不得出现（保持安装通道行为）
    assert.equal(bundleOnly?.bundlesOnly, undefined, '本机有副本 → 不标记 bundlesOnly');
    // 从未落盘的 bundles 条目：仍列出（它确实是启动时会挂载的层），版本空串不抛
    assert.equal(list.find((p) => p.name === 'stale-pkg')?.version, '');
    // in-box bundle 依然不出现（无论来自 dependencies 还是 bundles）
    assert.equal(list.some((p) => p.name === '@deepseek-ai/dsh-base'), false);
    // 依赖里的普通插件不受影响
    assert.equal(list.find((p) => p.name === 'pkg-a')?.spec, '1.0.0');
  } finally {
    cleanup();
  }
});

test('reconcileBundles: 当前依赖但非 bundle 的条目移出；从未是依赖的手动条目保留；无变化不写回', () => {
  // 语义对齐官方 dsh reconcilePlugins（plugin-9h8shc4d.js）：移除条件 =
  // 「(之前或当前)是依赖 且 不再声明 bundle patch」——从未是依赖的 bundles 条目
  // 视为手动维护的层，永远保留（in-box 同理不碰）。
  const { profileDir, cleanup } = makeTempProfile(
    { 'pkg-bundle': '1.0.0', 'pkg-plain': '1.0.0' },
    ['pkg-plain', 'stale-pkg'],
  );
  try {
    writeInstalledPkg(profileDir, 'pkg-bundle', '1.0.0', 'patch.yml');
    writeInstalledPkg(profileDir, 'pkg-plain', '1.0.0');

    assert.equal(reconcileBundles(profileDir), true, '有变化 → 写回并返回 true');
    const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.deepEqual(
      after.dsh.profile.bundles,
      ['stale-pkg', 'pkg-bundle'],
      'pkg-plain 是当前依赖但非 bundle → 移出；stale-pkg 从未是依赖 → 保留；pkg-bundle 追加',
    );

    assert.equal(reconcileBundles(profileDir), false, '已一致 → 不写回返回 false');
  } finally {
    cleanup();
  }
});

/**
 * 救援模式与 reconcile 的冲突（真机实测的失效点，2026-09）。
 *
 * 救援把 dsh.profile.bundles 收窄为「DSH 核心 + 本插件」，而 reconcileBundles 的规则是
 * 「声明 dsh.bundle.patch 的依赖必须出现在 bundles」——二者直接冲突。只要救援期间依赖行
 * 又出现（导入 / 恢复 / 市场安装都会写 dependencies），reconcile 就会把用户插件加回
 * bundles；而 reconcile 会随**每次读插件清单**跑（导出预览、自动快照的 plugins 分区、
 * 插件页），于是救援刚写下的收窄约 1.5 秒就被撤销，用户重启后插件照常挂载 = 名存实亡。
 */
test('reconcileBundles：救援模式下必须停手（不得把收窄掉的用户插件加回 bundles）', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile(
    { 'user-plugin': '1.0.0' },
    ['@deepseek-ai/dsh-base', 'user-plugin'],
  );
  try {
    writeInstalledPkg(profileDir, 'user-plugin', '1.0.0', './cordis.patch.yml');
    const pkgPath = join(profileDir, 'package.json');
    type Manifest = { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    const manifest = (): Manifest => JSON.parse(readFileSync(pkgPath, 'utf8')) as Manifest;
    const write = (m: Manifest): void => { writeFileSync(pkgPath, JSON.stringify(m, null, 2) + '\n', 'utf8'); };

    // 对照组（没有救援状态）：依赖里有 bundle patch 的包会被加回 bundles —— 证明断言不是空转
    write({ name: 'dsh-profile-web', dependencies: { 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } } as unknown as Manifest);
    assert.equal(reconcileBundles(profileDir), true, '对照组：无救援 → 正常 reconcile 并写回');
    assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'user-plugin']);

    // 进入救援（disableUserBundles）：bundles 收窄 + 依赖行被摘掉
    const entered = await enterRescueMode({
      homeDir,
      profile: 'web',
      rescueMount: { packageName: 'dsh-config-manager', row: { id: 'config-manager', name: 'dsh-config-manager' } },
      disableUserBundles: true,
    });
    assert.equal(entered.ok, true, '进入救援必须成功');
    assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'bundles 收窄为核心');
    assert.equal('user-plugin' in manifest().dependencies, false, '依赖行同时被摘掉');

    // 模拟「救援期间依赖行又出现」（导入 / 恢复 / 市场安装都会写 dependencies）
    const cur = manifest();
    cur.dependencies['user-plugin'] = '1.0.0';
    write(cur);

    assert.equal(reconcileBundles(profileDir), false, '救援期间必须停手（false = 未写盘）');
    assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'bundles 必须保持收窄后的形态');
    listInstalledPlugins(homeDir, 'web');
    assert.deepEqual(manifest().dsh.profile.bundles, ['@deepseek-ai/dsh-base'], 'listInstalledPlugins 同样不得改回 bundles');
  } finally {
    cleanup();
  }
});

test('issue #95: 只在 bundles 里声明、且本机没有落盘副本的层必须标记 bundlesOnly', () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile(
    { 'pkg-a': '1.0.0' },
    ['@deepseek-ai/dsh-experimental-session-search', '@linxin666/dsh-web-ui-all'],
  );
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, '@linxin666/dsh-web-ui-all', '0.3.1', 'patch.yml');

    const list = listInstalledPlugins(homeDir, 'web');
    const hostLayer = list.find((p) => p.name === '@deepseek-ai/dsh-experimental-session-search');
    assert.equal(hostLayer?.version, '', '本 profile 没装它 → 版本空串');
    assert.equal(hostLayer?.bundlesOnly, true, '无依赖 + 无落盘副本 ⇒ 只能由 DSH 自己提供');
    assert.equal(list.find((p) => p.name === '@linxin666/dsh-web-ui-all')?.bundlesOnly, undefined, '有落盘副本 → 保持旧行为');
    assert.equal(list.find((p) => p.name === 'pkg-a')?.bundlesOnly, undefined, '普通依赖不得带标记');
  } finally {
    cleanup();
  }
});

test('issue #95: isBundlesOnlyEntry —— 显式字段优先，旧备份按形状推断', () => {
  assert.equal(isBundlesOnlyEntry({ bundlesOnly: true, spec: '^1.0.0', version: '1.0.0' }), true, '显式字段优先');
  assert.equal(isBundlesOnlyEntry({ bundlesOnly: false, version: '' }), false, '显式 false 不得被形状覆盖');
  assert.equal(isBundlesOnlyEntry({ version: '' }), true, '旧备份：无 spec 且无已装版本');
  assert.equal(isBundlesOnlyEntry({ spec: '^1.0.0', version: '' }), false, '有依赖声明 → 普通依赖（哪怕本机没装全）');
  assert.equal(isBundlesOnlyEntry({ version: '0.3.1' }), false, '本机有落盘副本 → 手工层');
});

test('issue #95: mergeBundleDeclaration 只追加一个名字；形状不符一律拒绝', () => {
  const base = `${JSON.stringify({ name: 'dsh-profile-web', dependencies: { a: '1.0.0' }, dsh: { profile: { bundles: ['x'] } } }, null, 2)}\n`;
  const merged = mergeBundleDeclaration(base, 'y');
  assert.equal(merged?.changed, true);
  const parsed = JSON.parse(merged!.text) as {
    dependencies: Record<string, string>;
    dsh: { profile: { bundles: string[] } };
  };
  assert.deepEqual(parsed.dsh.profile.bundles, ['x', 'y'], '名字追加在尾部');
  assert.deepEqual(parsed.dependencies, { a: '1.0.0' }, '其余字段逐字保留');
  assert.equal(mergeBundleDeclaration(merged!.text, 'y')?.changed, false, '幂等：重复声明不空写');

  assert.equal(mergeBundleDeclaration('{', 'y'), null, 'JSON 坏 → null（绝不重建清单）');
  assert.equal(mergeBundleDeclaration('[]', 'y'), null, '顶层非对象 → null');
  assert.equal(mergeBundleDeclaration(JSON.stringify({ name: 'p' }), 'y'), null, '缺 dsh.profile → null');
  assert.equal(
    mergeBundleDeclaration(JSON.stringify({ dsh: { profile: { bundles: 'x' } } }), 'y'),
    null,
    'bundles 非数组 → null',
  );
  assert.equal(
    mergeBundleDeclaration(JSON.stringify({ dsh: { profile: { bundles: ['x', 1] } } }), 'y'),
    null,
    'bundles 含非字符串 → null',
  );
  assert.equal(
    mergeBundleDeclaration(JSON.stringify({ dsh: { profile: {} } }), 'y'),
    null,
    'bundles 字段缺省 → null（非空 bundles 会替换默认插件栈，绝不凭空造）',
  );
});
