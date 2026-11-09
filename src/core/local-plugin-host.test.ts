/**
 * local-plugin-host 单测：超限负缓存（2026-11-07 真机事故的治本项之一）。
 *
 * 事故：210MB 的本地插件每轮 npm pack 44.7s、结果每次都被体积上限丢弃；自动同步 60s 一轮 ⇒
 * 每分钟白烧 45s，且整段时间持有 GLOBAL mutation 锁（用户删除档案恒 423）。
 * 这里验证：源没变就不再重复打包、源变了会重打包、TTL 到期会重打包、关闭缓存时行为不变。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createLocalPluginPackHook } from './local-plugin-host.ts';
import type { LocalPluginPackHook } from './local-plugin-host.ts';
import type { PackExec } from './local-plugin-pack.ts';

const TARBALL = 'local-pkg-0.1.0.tgz';

interface Fixture {
  hook: LocalPluginPackHook;
  calls: () => number;
  sourceDir: string;
  plugins: { name: string; version: string; spec?: string }[];
}

/** 造一个本地源插件目录 + 假 npm pack（把指定字节数的 tgz 写进 --pack-destination）。 */
async function fixture(t: { after: (fn: () => Promise<void>) => void }, opts: {
  tarballBytes?: number;
  oversizeTtlMs?: number;
  maxTarballBytes?: number;
  /** 内容缓存上限（字节；0 = 关闭） */
  packedCacheMaxBytes?: number;
} = {}): Promise<Fixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshcm-packhost-'));
  t.after(async () => { await fsp.rm(root, { recursive: true, force: true }); });
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const sourceDir = path.join(root, 'local-pkg');
  await fsp.mkdir(sourceDir, { recursive: true });
  await fsp.writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'local-pkg', version: '0.1.0' }));

  let calls = 0;
  const tarballBytes = opts.tarballBytes ?? 4096;
  const exec: PackExec = async (_file, args) => {
    calls += 1;
    const idx = args.indexOf('--pack-destination');
    const packDir = args[idx + 1] as string;
    await fsp.writeFile(path.join(packDir, TARBALL), Buffer.alloc(tarballBytes));
    return { stdout: TARBALL + '\n', stderr: '', code: 0 };
  };

  const hook = createLocalPluginPackHook({
    homeDir,
    dataDir,
    exec,
    maxTarballBytes: opts.maxTarballBytes ?? 1024,
    ...(opts.oversizeTtlMs === undefined ? {} : { oversizeTtlMs: opts.oversizeTtlMs }),
    ...(opts.packedCacheMaxBytes === undefined ? {} : { packedCacheMaxBytes: opts.packedCacheMaxBytes }),
  });
  return {
    hook,
    calls: () => calls,
    sourceDir,
    plugins: [{ name: 'local-pkg', version: '0.1.0', spec: 'file:' + sourceDir }],
  };
}

const ctx = { profile: 'web', profileDir: undefined } as const;

test('超限拒绝：首次打包 → warnings 有超限文案、oversize 带出源路径（供负缓存记账）', async (t) => {
  const fx = await fixture(t);
  const res = await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1);
  assert.equal(res.packed.length, 0, '超限的 tarball 不得进备份');
  assert.equal(res.oversize.length, 1);
  assert.equal(res.oversize[0]?.source, 'dir');
  assert.equal(res.oversize[0]?.sourcePath, fx.sourceDir);
  assert.equal(res.oversize[0]?.size, 4096);
  assert.equal(res.warnings.length, 1);
});

test('超限负缓存：源没变 → 第二轮不再 npm pack，但告警照旧（调用方看不出区别）', async (t) => {
  const fx = await fixture(t);
  const first = await fx.hook(fx.plugins, ctx);
  const second = await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1, '第二次必须走缓存，不再白跑 npm pack');
  assert.equal(second.packed.length, 0, '缓存命中同样不得产出 tarball（否则会带一个超限的大包）');
  assert.deepEqual(second.warnings, first.warnings, '缓存命中的告警与实测超限逐字一致');
  assert.equal(second.oversize.length, 1, '缓存命中也要原样回出超限项：调用方/界面不区分「刚发现」与「上轮已记」');
  assert.deepEqual(second.oversize, first.oversize, '超限项字段与首次发现逐字一致');
});

test('超限负缓存：源变了（package.json mtime 变化）→ 重新打包', async (t) => {
  const fx = await fixture(t);
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1);
  const pkg = path.join(fx.sourceDir, 'package.json');
  const future = new Date(Date.now() + 5000);
  await fsp.utimes(pkg, future, future);
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 2, '指纹变了必须重新打包（不能长期静默不备份）');
});

test('超限负缓存：TTL 到期 → 重新打包', async (t) => {
  const fx = await fixture(t, { oversizeTtlMs: 5 });
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1);
  await new Promise((r) => setTimeout(r, 20));
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 2, 'TTL 到期必须重新实测，不能永久跳过');
});

test('oversizeTtlMs=0：关闭缓存，两轮都真打（测试与排障用）', async (t) => {
  const fx = await fixture(t, { oversizeTtlMs: 0 });
  await fx.hook(fx.plugins, ctx);
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 2);
});

test('未超限：正常产出 packed；源没变时第二轮走内容缓存，不再 npm pack', async (t) => {
  const fx = await fixture(t, { tarballBytes: 256, maxTarballBytes: 1024 });
  const first = await fx.hook(fx.plugins, ctx);
  assert.equal(first.packed.length, 1);
  assert.equal(first.oversize.length, 0);
  assert.equal(first.warnings.length, 0);

  // 2026-11-09：内容缓存上线后，源没变的第二轮直接复用 tarball 字节（此前是每轮都真打）。
  const second = await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1, '源没变 → 复用缓存，不再 spawn npm pack');
  assert.equal(second.packed.length, 1, '缓存命中同样要产出 packed（备份缺它会把插件丢掉）');
  assert.deepEqual(second.packed[0]?.data, first.packed[0]?.data, '复用的必须是同一份字节');
  assert.equal(second.packed[0]?.rewrittenSpec, first.packed[0]?.rewrittenSpec);
});

test('内容缓存：源目录里改一个文件（lib/ 里那种不改目录 mtime 的改动）→ 必须重新打包', async (t) => {
  const fx = await fixture(t, { tarballBytes: 256, maxTarballBytes: 1024 });
  await fsp.mkdir(path.join(fx.sourceDir, 'lib'), { recursive: true });
  await fsp.writeFile(path.join(fx.sourceDir, 'lib', 'index.js'), 'export const a = 1\n');
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 1);

  const file = path.join(fx.sourceDir, 'lib', 'index.js');
  const future = new Date(Date.now() + 5000);
  await fsp.utimes(file, future, future);
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 2, '内容指纹按文件级 rel/size/mtime 算，改文件必须重打包（不能把旧 tarball 当当前内容）');
});

test('内容缓存：packedCacheMaxBytes=0 → 关闭，两轮都真打', async (t) => {
  const fx = await fixture(t, { tarballBytes: 256, maxTarballBytes: 1024, packedCacheMaxBytes: 0 });
  await fx.hook(fx.plugins, ctx);
  await fx.hook(fx.plugins, ctx);
  assert.equal(fx.calls(), 2, '关闭缓存时行为与改造前一致');
});

test('无本地源插件：零 spawn、零目录创建', async (t) => {
  const fx = await fixture(t);
  const res = await fx.hook([{ name: 'x', version: '1.0.0', spec: '^1.0.0' }], ctx);
  assert.equal(fx.calls(), 0);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(res.oversize, []);
});
