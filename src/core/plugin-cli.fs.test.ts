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
  listInstalledPlugins, readInstalled, readInstalledVersion, reconcileBundles,
  resolveProfileDir,
} from './plugin-cli.ts';
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
    '@deepseek-ai/dsh-base': '0.1.0-rc.6',
  });
  try {
    writeInstalledPkg(profileDir, '@linxin666/dsh-ssh', '0.1.12', 'patch.yml');
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, '@deepseek-ai/dsh-base', '0.1.0-rc.6');

    const list = listInstalledPlugins(homeDir, 'web');
    const ssh = list.find((p) => p.name === '@linxin666/dsh-ssh');
    const plain = list.find((p) => p.name === 'pkg-a');
    assert.equal(ssh?.version, '0.1.12', '必须返回落盘真实版本，而不是声明的 ^0.1.0');
    assert.equal(ssh?.isBundle, true);
    assert.deepEqual(ssh?.inBundles, ['@linxin666/dsh-ssh'], '直接依赖的 bundle 自身就是 profile 层');
    assert.equal(plain?.version, '1.0.0');
    assert.equal(plain?.isBundle, false);
    assert.deepEqual(plain?.inBundles, []);
    assert.equal(list.some((p) => p.name === '@deepseek-ai/dsh-base'), false, 'in-box bundle 不出现');
    assert.equal(list.every((p: PluginInfo) => p.enabled === true), true, '文件视图依赖即视为启用');
  } finally {
    cleanup();
  }
});

test('listInstalledPlugins: 声明了依赖但未实际安装 → version 空串不抛', () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile({ 'ghost-dep': '^9.9.9' });
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

test('reconcileBundles: 当前依赖但非 bundle 的条目移出；从未是依赖的手动条目保留；无变化不写回', () => {
  // 语义对齐官方 dsh reconcilePlugins（plugin-9h8shc4d.js）：移除条件 =
  // 「(之前或当前)是依赖 且 不再声明 bundle patch」——从未是依赖的 bundles 条目
  // 视为手动维护的层，永远保留（in-box 同理不碰）。
  const { homeDir, profileDir, cleanup } = makeTempProfile(
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
