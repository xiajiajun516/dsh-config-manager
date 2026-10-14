/**
 * PluginDataAdapter 单测（pluginData / pluginAssets 两个分区）。
 *
 * 覆盖四件必须成立的事：
 *  ① 收录口径：配置 / 大资产各进各的分区；**可再生成缓存永不出现**；
 *  ② 单元 = 区域（选择器按区域勾选；预览与导出体积同口径）；
 *  ③ 环境变量覆盖：报码跳过、不猜新位置；「设成同一个值」不算覆盖；
 *  ④ 导入白名单：只有本机内置来源 / 已安装插件自述声明之下的路径才允许写，
 *     其余（含 .credentials.yaml 这类敏感文件）判 Error 且 applyItem 也拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PluginDataAdapter } from './plugin-data.ts';
import { makeContext, makeImportContext, sha256Hex } from './test-helpers.ts';
import type { PluginDataSource } from '../core/plugin-data-registry.ts';
import type { FilesSection } from '../schema/types.ts';

const HOME = 'C:\\Users\\alice';
const bytes = (s: string): Uint8Array => Buffer.from(s, 'utf8');

/**
 * 测试用的宿主上下文：**把系统 home 与 $DSH_HOME 指向同一个内存根**。
 *
 * 真机上两者不同（$DSH_HOME = ~/.dsh），而这两个分区的根是**系统 home** —— 单测里合并成一个根
 * 只是让夹具短；两者不同的真机形态由 tests/e2e/plugin-data-migration.test.ts 覆盖。
 */
function ctxFor(home: string, profile = 'web') {
  const ctx = makeContext('win32', home, profile);
  ctx.osHomeDir = home;
  ctx.homeFs = ctx.fs;
  return ctx;
}

/** 真机形态的假数据：wallpaper-engine 的配置 + 缓存 + 上传的壁纸；mnemon 的运行时与数据库 */
async function seedHome(ctx: ReturnType<typeof makeContext>): Promise<void> {
  await ctx.fs.writeFile('.dsh-wallpaper-engine/config.json', bytes('{"wallpaper":"a"}'));
  await ctx.fs.writeFile('.dsh-wallpaper-engine/cache/frame.bin', bytes('cache'));
  await ctx.fs.writeFile('.dsh-wallpaper-engine/uploads/wall.mp4', bytes('video'));
  await ctx.fs.writeFile('.mnemon/runtime/MEMORY.md', bytes('memory'));
  await ctx.fs.writeFile('.mnemon/data/body.db', bytes('db'));
}

test('收录口径：配置分区只带配置，资产分区只带大资产，缓存永不出现', async () => {
  const ctx = ctxFor(HOME);
  await seedHome(ctx);

  const config = new PluginDataAdapter('pluginData', { env: {} });
  const configOut = await config.export(ctx, { includeSecrets: false });
  assert.deepEqual(
    configOut.data.files.map((f) => f.relativePath).sort(),
    ['.dsh-wallpaper-engine/config.json', '.mnemon/runtime/MEMORY.md'],
  );
  assert.equal(configOut.data.files[0]?.contentHash, sha256Hex(bytes('{"wallpaper":"a"}')));

  const assets = new PluginDataAdapter('pluginAssets', { env: {} });
  const assetOut = await assets.export(ctx, { includeSecrets: false });
  assert.deepEqual(
    assetOut.data.files.map((f) => f.relativePath).sort(),
    ['.dsh-wallpaper-engine/uploads/wall.mp4', '.mnemon/data/body.db'],
  );

  // 缓存绝不出现（两个分区都不许）
  for (const out of [configOut, assetOut]) {
    assert.ok(!out.data.files.some((f) => f.relativePath.includes('/cache/')), '缓存必须被排除');
  }
});

test('单元 = 区域：单元 id 就是区域路径，且预览与导出的体积同口径', async () => {
  const ctx = ctxFor(HOME);
  await seedHome(ctx);
  const adapter = new PluginDataAdapter('pluginData', { env: {} });

  const out = await adapter.export(ctx, { includeSecrets: false });
  const units = adapter.listUnits(out);
  assert.deepEqual(units.map((u) => u.id).sort(), ['pluginData:.dsh-wallpaper-engine', 'pluginData:.mnemon/runtime']);
  assert.equal(units.find((u) => u.id === 'pluginData:.mnemon/runtime')?.fileCount, 1);

  const preview = await adapter.preview(ctx, { includeSecrets: false });
  assert.deepEqual(preview.items, units, '预览单元必须与导出单元逐项一致');
  assert.equal(
    preview.sizeBytes,
    out.data.files.reduce((n, f) => n + f.data.byteLength, 0),
  );

  // 条目级选择：只勾 mnemon 运行时
  const only = await adapter.export(ctx, { includeSecrets: false, includeItems: { pluginData: ['pluginData:.mnemon/runtime'] } });
  assert.deepEqual(only.data.files.map((f) => f.relativePath), ['.mnemon/runtime/MEMORY.md']);
});

test('环境变量覆盖：报码跳过、不猜位置；设成与默认相同不算覆盖', async () => {
  const ctx = ctxFor(HOME);
  await seedHome(ctx);

  const moved = new PluginDataAdapter('pluginData', { env: { DSH_WE_DATA_DIR: 'D:\\wallpapers' } });
  const movedOut = await moved.export(ctx, { includeSecrets: false });
  assert.deepEqual(
    movedOut.data.files.map((f) => f.relativePath),
    ['.mnemon/runtime/MEMORY.md'],
    '被覆盖的区域不得被读成「默认位置」，未被覆盖的来源照常收录',
  );
  assert.ok(movedOut.warnings.some((w) => w.includes('DSH_WE_DATA_DIR')), '必须如实报出是哪个变量覆盖了它');

  const assetsMoved = new PluginDataAdapter('pluginAssets', { env: { DSH_WE_UPLOAD_DIR: '~/pics' } });
  const assetsOut = await assetsMoved.export(ctx, { includeSecrets: false });
  assert.deepEqual(assetsOut.data.files.map((f) => f.relativePath), ['.mnemon/data/body.db'], '只跳过被覆盖的那一个区域');

  const same = new PluginDataAdapter('pluginData', { env: { DSH_WE_DATA_DIR: '~/.dsh-wallpaper-engine' } });
  const sameOut = await same.export(ctx, { includeSecrets: false });
  assert.equal(sameOut.data.files.length, 2, '值等于默认位置 → 不算覆盖');
});

test('导入白名单：包外路径一律 Error，applyItem 也拒绝；包内路径正常写回', async () => {
  const src = ctxFor(HOME);
  await seedHome(src);
  const adapter = new PluginDataAdapter('pluginData', { env: {} });
  const out = await adapter.export(src, { includeSecrets: false });

  const evil: FilesSection = {
    version: 1,
    files: [
      ...out.data.files,
      { relativePath: '.credentials.yaml', data: bytes('token: x'), contentHash: sha256Hex(bytes('token: x')) },
      { relativePath: '.dsh-wallpaper-engine/uploads/wall.mp4', data: bytes('video'), contentHash: sha256Hex(bytes('video')) },
    ],
  };

  const dst = ctxFor('/home/bob');
  const sections = new Map<string, unknown>([['pluginData', evil]]);
  const items = await adapter.analyzeImport(evil, makeImportContext(dst, sections));

  const denied = items.filter((i) => i.kind === 'Error');
  assert.equal(denied.length, 2, '包外路径 + 资产路径（走配置分区）都必须被拒');
  assert.ok(denied.every((i) => i.description.includes('拒绝')), '拒绝理由必须可见');

  const allowed = items.filter((i) => i.kind === 'Create');
  assert.equal(allowed.length, 2);
  for (const item of allowed) {
    const r = await adapter.applyItem(item, makeImportContext(dst, sections));
    assert.equal(r.ok, true);
  }
  assert.equal(Buffer.from(await dst.fs.readFile('.mnemon/runtime/MEMORY.md')).toString(), 'memory');

  // 纵深防御：手工构造一个指向包外的计划项，applyItem 也必须拒绝
  const forged = await adapter.applyItem(
    { id: 'x', kind: 'Create', adapter: 'pluginData', description: '', severity: 'info', target: { adapter: 'pluginData', ref: 'AGENTS.md' } },
    makeImportContext(dst, sections),
  );
  assert.equal(forged.ok, false);
  assert.equal(await dst.fs.exists('AGENTS.md'), false);
});

test('自述声明（dsh.dataDirs）：已安装插件的区域可导出、可导入；未声明的插件目录仍被拒', async () => {
  const ctx = ctxFor(HOME);
  await ctx.fs.writeFile('profiles/web/package.json', bytes(JSON.stringify({ dependencies: { 'dsh-fake': '^1.0.0' } })));
  await ctx.fs.writeFile(
    'profiles/web/node_modules/dsh-fake/package.json',
    bytes(JSON.stringify({ name: 'dsh-fake', dsh: { dataDirs: [{ path: '.fake-plugin', role: 'config', env: ['FAKE_DIR'] }] } })),
  );
  await ctx.fs.writeFile('.fake-plugin/state.json', bytes('{"a":1}'));

  const adapter = new PluginDataAdapter('pluginData', { env: {} });
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath), ['.fake-plugin/state.json']);
  assert.deepEqual(adapter.listUnits(out).map((u) => u.id), ['pluginData:.fake-plugin']);

  // 目标机也装了同一个插件 → 声明可解析 → 允许写
  const dst = ctxFor('/home/bob');
  await dst.fs.writeFile('profiles/web/package.json', bytes(JSON.stringify({ dependencies: { 'dsh-fake': '^1.0.0' } })));
  await dst.fs.writeFile(
    'profiles/web/node_modules/dsh-fake/package.json',
    bytes(JSON.stringify({ name: 'dsh-fake', dsh: { dataDirs: [{ path: '.fake-plugin', role: 'config' }] } })),
  );
  const sections = new Map<string, unknown>([['pluginData', out.data]]);
  const items = await adapter.analyzeImport(out.data, makeImportContext(dst, sections));
  assert.deepEqual(items.map((i) => i.kind), ['Create']);

  // 换一台机器（没装该插件、也没声明）→ 同一份包必须被拒，绝不静默写到未知位置
  const fresh = ctxFor('/home/carol');
  const freshItems = await adapter.analyzeImport(out.data, makeImportContext(fresh, sections));
  assert.deepEqual(freshItems.map((i) => i.kind), ['Error']);
});

test('空形态：一个区域都不存在时不报错、不加噪音文件（只有 dirEmpty 告警）', async () => {
  const ctx = ctxFor(HOME);
  const adapter = new PluginDataAdapter('pluginData', { env: {} });
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(out.data.files, []);
  assert.equal(out.counts.files, 0);
});

test('旧宿主（没有系统 home 门面）：不收集也不导入，并如实报码 —— 绝不退回 $DSH_HOME 读错位置', async () => {
  // 注意：这里**故意**用未接线的上下文（homeFs 缺省 undefined）
  const ctx = makeContext('win32', HOME, 'web');
  await ctx.fs.writeFile('.dsh-wallpaper-engine/config.json', bytes('{"a":1}'));
  const adapter = new PluginDataAdapter('pluginData', { env: {} });

  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(out.data.files, [], '缺门面时不得在 $DSH_HOME 下按同名相对路径去读');
  assert.ok(out.warnings.some((w) => w.includes('系统主目录')), '必须如实说明为什么什么都没收集');

  const sections = new Map<string, unknown>([['pluginData', {
    version: 1,
    files: [{ relativePath: '.dsh-wallpaper-engine/config.json', data: bytes('{"a":1}'), contentHash: sha256Hex(bytes('{"a":1}')) }],
  }]]);
  const target = makeContext('linux', '/home/bob', 'web');
  const items = await adapter.analyzeImport(
    { version: 1, files: [{ relativePath: '.dsh-wallpaper-engine/config.json', data: bytes('{"a":1}'), contentHash: sha256Hex(bytes('{"a":1}')) }] },
    makeImportContext(target, sections),
  );
  assert.deepEqual(items.map((i) => i.kind), ['Error']);
  assert.equal(await target.fs.exists('.dsh-wallpaper-engine/config.json'), false);
});

test('注入假来源：来源表可替换（测试与未来扩展都走同一条路）', async () => {
  const ctx = ctxFor(HOME);
  await ctx.fs.writeFile('.my-plugin/a.json', bytes('{}'));
  const fake: PluginDataSource[] = [{
    id: 'fake', packages: ['x'], evidence: 'fixture',
    areas: [{ relPath: '.my-plugin', role: 'config' }],
  }];
  const adapter = new PluginDataAdapter('pluginData', { sources: fake, env: {} });
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.deepEqual(out.data.files.map((f) => f.relativePath), ['.my-plugin/a.json']);
});
