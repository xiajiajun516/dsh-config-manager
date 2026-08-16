/**
 * DshPluginsFacade / ensureActivationRow 测试（M5 补写，failing-first 目标）：
 *   - install 无 marketplace 时走官方 dsh plugin CLI 通道，且绝不抛「插件市场服务不可用」
 *   - listInstalled 委托 profile 文件实时读取（真实版本）
 *   - ensureActivationRow 幂等（重复安装不重复行；bundle 包跳过）
 *
 * 通过注入 mock runner（DshPluginsFacade 构造器第 4 参）拦截子进程，不触发真实
 * dsh/pnpm；profile 目录用真实临时目录（node:fs），node_modules 落盘 package.json
 * 驱动 hasDshBundlePatch 判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DshPluginsFacade, ensureActivationRow } from './index.ts';
import { resolveProfileDir } from './core/plugin-cli.ts';
import type { DshPluginResult } from './core/plugin-cli.ts';
import type { PatchChange, PatchFileFacade } from './core/types.ts';

/* ------------------------------------------------ mock 基础设施 */

class MemPatchFile implements PatchFileFacade {
  lines = new Map<string, { lineId: string; raw: unknown }>();
  async readPatchLines(_file: string): Promise<{ lineId: string; raw: unknown }[]> {
    return [...this.lines.values()];
  }
  async applyPatchChanges(_file: string, changes: PatchChange[]): Promise<void> {
    for (const c of changes) {
      if (c.action === 'remove') this.lines.delete(c.lineId);
      else this.lines.set(c.lineId, { lineId: c.lineId, raw: c.raw });
    }
  }
}

interface TempProfile {
  homeDir: string;
  profileDir: string;
  cleanup: () => void;
}

function makeTempProfile(): TempProfile {
  const homeDir = mkdtempSync(join(tmpdir(), 'dsh-cm-facade-'));
  const profileDir = resolveProfileDir(homeDir, 'web');
  mkdirSync(profileDir, { recursive: true });
  return {
    homeDir,
    profileDir,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

/** 写 node_modules/<name>/package.json；bundlePatch 缺省 = 非 bundle。 */
function writeInstalledPkg(profileDir: string, name: string, version: string, bundlePatch?: string): void {
  const pkgDir = join(profileDir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version };
  if (bundlePatch !== undefined) manifest['dsh'] = { bundle: { patch: bundlePatch } };
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function okResult(): DshPluginResult {
  return { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
}

/* ------------------------------------------------------- 测试主体 */

test('install: 无 marketplace 时走 CLI 通道（mock runner 记录 argv），成功 → needsRestart + 非 bundle 补激活行', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0'); // 非 bundle
    const calls: { profileDir: string; profile: string; args: string[] }[] = [];
    const runner = async (p: string, profile: string, args: readonly string[]): Promise<DshPluginResult> => {
      calls.push({ profileDir: p, profile, args: [...args] });
      return okResult();
    };
    const patchFile = new MemPatchFile();
    const facade = new DshPluginsFacade(homeDir, 'web', patchFile, runner);

    const r = await facade.install('pkg-a');
    assert.equal(r.needsRestart, true);
    assert.equal(calls.length, 1, 'install 恰好一次 CLI 调用');
    assert.equal(calls[0]?.profileDir, profileDir);
    assert.equal(calls[0]?.profile, 'web');
    assert.deepEqual(calls[0]?.args, ['add', 'pkg-a'], '必须构造 dsh plugin --profile web add pkg-a 的 argv');
    // 非 bundle：成功路径幂等补激活行
    assert.deepEqual(
      [...patchFile.lines.keys()],
      ['pm-pkg-a'],
      '非 bundle 插件安装后写入 pm-<slug> 激活行',
    );
    assert.deepEqual(patchFile.lines.get('pm-pkg-a')?.raw, { id: 'pm-pkg-a', name: 'pkg-a' });
  } finally {
    cleanup();
  }
});

test('install: bundle 包成功 → 不补 patch 行（reconcile 维护 bundles）', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-bundle', '1.0.0', 'patch.yml'); // bundle
    const runner = async (): Promise<DshPluginResult> => okResult();
    const patchFile = new MemPatchFile();
    const facade = new DshPluginsFacade(homeDir, 'web', patchFile, runner);

    await facade.install('pkg-bundle');
    assert.equal(patchFile.lines.size, 0, 'bundle 包不写 patch 行');
  } finally {
    cleanup();
  }
});

test('install: CLI 失败 → 分类后的可读错误，且绝不出现「插件市场服务不可用」', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const runner = async (): Promise<DshPluginResult> => ({
      exitCode: 1, timedOut: false, stdout: '',
      stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/ghost-pkg: Not Found - 404',
    });
    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), runner);

    await assert.rejects(
      () => facade.install('pkg-a'),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.match(msg, /fetch-404/, '错误必须带分类 code');
        assert.doesNotMatch(msg, /插件市场服务不可用/, 'CLI 通道失败绝不能回退到 marketplace 报错');
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test('install: 激活行补写失败 → 明确报错（不吞），允许重试幂等补行', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const runner = async (): Promise<DshPluginResult> => okResult();
    const brokenPatch = new MemPatchFile();
    brokenPatch.applyPatchChanges = async () => {
      throw new Error('disk full');
    };
    const facade = new DshPluginsFacade(homeDir, 'web', brokenPatch, runner);

    await assert.rejects(
      () => facade.install('pkg-a'),
      /激活行写入 profile 补丁失败/,
    );
  } finally {
    cleanup();
  }
});

test('listInstalled: 委托 profile 文件实时读取，返回真实落盘版本', async () => {
  const { homeDir, profileDir, cleanup } = makeTempProfile();
  try {
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        dependencies: { '@linxin666/dsh-ssh': '^0.1.0', 'pkg-a': '1.0.0', '@deepseek-ai/dsh-base': '0.1.0-rc.6' },
        dsh: { profile: { bundles: ['@linxin666/dsh-ssh'] } },
      }, null, 2) + '\n',
      'utf8',
    );
    writeInstalledPkg(profileDir, '@linxin666/dsh-ssh', '0.1.12', 'patch.yml');
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    writeInstalledPkg(profileDir, '@deepseek-ai/dsh-base', '0.1.0-rc.6');

    const facade = new DshPluginsFacade(homeDir, 'web', new MemPatchFile(), async () => okResult());
    const list = await facade.listInstalled();
    const ssh = list.find((p) => p.name === '@linxin666/dsh-ssh');
    assert.equal(ssh?.version, '0.1.12', '真实落盘版本（声明是 ^0.1.0）');
    assert.equal(ssh?.isBundle, true);
    assert.equal(list.some((p) => p.name === '@deepseek-ai/dsh-base'), false);
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: 幂等——重复安装不重复行', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    assert.equal(patchFile.lines.size, 1, '三次调用只产生一行');
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: 已有同 name 行（任意 id）→ 不重复插入', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();
    patchFile.lines.set('user-line', { lineId: 'user-line', raw: { id: 'user-line', name: 'pkg-a' } });

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-a'), 'pkg-a');
    assert.equal(patchFile.lines.size, 1, '按 name 去重，不新增行');
    assert.equal(patchFile.lines.has('user-line'), true);
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: bundle 包跳过（reconcile 已维护 bundles）', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, 'pkg-bundle', '1.0.0', 'patch.yml');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', 'pkg-bundle'), 'pkg-bundle');
    assert.equal(patchFile.lines.size, 0, 'bundle 包不写 patch 行');
  } finally {
    cleanup();
  }
});

test('ensureActivationRow: scope 包名 slug 形态正确（@scope/name → pm-scope-name）', async () => {
  const { profileDir, cleanup } = makeTempProfile();
  try {
    writeInstalledPkg(profileDir, '@org/pkg-a', '1.0.0');
    const patchFile = new MemPatchFile();

    await ensureActivationRow(patchFile, join(profileDir, 'node_modules', '@org', 'pkg-a'), '@org/pkg-a');
    assert.equal(patchFile.lines.size, 1);
    assert.equal(patchFile.lines.has('pm-org-pkg-a'), true, '去 @ 后连字符 slug');
  } finally {
    cleanup();
  }
});
