/**
 * 第三方插件数据迁移的**端到端**验证（真实磁盘 + 两个全新的 home/profile）。
 *
 * 与 src/adapters/plugin-data.test.ts 的分工：那边用内存门面钉单元级语义；这里走**真实文件系统**，
 * 经过完整管道（Exporter → ZIP → Importer 分析 → 计划 → 执行），在**两个不同的 home 目录**之间迁移：
 *  ① 配置类内容逐字节落到目标 home；
 *  ② 可再生成缓存（cache/）绝不出现；
 *  ③ 大资产只随 pluginAssets 走，不随配置分区走；
 *  ④ 目标机既有文件判 Conflict → **不被覆盖**（conflict 不默认覆盖的端到端证据）；
 *  ⑤ 包内路径不在白名单内（.credentials.yaml / 未声明插件目录）→ 计划里 Error、执行期零写入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { PluginDataAdapter } from '../../src/adapters/plugin-data.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import { rebuildBundle } from '../conformance/corpus.ts';
import type { FileSystemFacade } from '../../src/core/types.ts';
import type { SectionId } from '../../src/schema/types.ts';

const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

/** 真实磁盘门面（只允许 home 相对路径；越界即抛错，与宿主门面同一安全约定） */
class DiskFs implements FileSystemFacade {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /**
   * 允许**绝对路径**（与宿主门面同语义：快照/回滚引擎传的是 `resolveFileTarget` 解析出的绝对路径），
   * 但一律要求落在本 home 之内 —— 越界即抛错，绝不放行。
   */
  private abs(rel: string): string {
    const abs = path.resolve(this.home, rel);
    const back = path.relative(this.home, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) {
      throw new Error('path escapes the home directory: ' + rel);
    }
    return abs;
  }

  private toRel(abs: string): string {
    return path.relative(this.home, abs).split(path.sep).join('/');
  }

  async readFile(rel: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.abs(rel)));
  }

  async writeFile(rel: string, data: Uint8Array): Promise<void> {
    const abs = this.abs(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, data);
  }

  async exists(rel: string): Promise<boolean> {
    return existsAbs(this.abs(rel));
  }

  async copy(from: string, to: string): Promise<void> {
    const src = this.abs(from);
    const dst = this.abs(to);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
  }

  async remove(rel: string): Promise<void> {
    await fsp.rm(this.abs(rel), { force: true, recursive: true });
  }

  async mkdir(): Promise<void> {
    /* 真实实现按需建目录 */
  }

  async listRecursive(dir: string): Promise<string[]> {
    const out: string[] = [];
    type Direntish = { name: string; isDirectory(): boolean; isFile(): boolean };
    const walk = async (d: string): Promise<void> => {
      let entries: Direntish[];
      try {
        // readdir 的 withFileTypes 重载在测试 tsconfig 下解析到 Buffer 变体，这里显式收窄成形状接口
        entries = (await fsp.readdir(d, { withFileTypes: true })) as unknown as Direntish[];
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(d, String(entry.name));
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) out.push(this.toRel(full));
      }
    };
    await walk(this.abs(dir));
    return out.sort();
  }

  async statSize(rel: string): Promise<number | null> {
    try {
      const st = await fsp.stat(this.abs(rel));
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }
}

async function existsAbs(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 真机形态的宿主上下文：**$DSH_HOME = <系统 home>/.dsh**，两者是不同的根。
 *
 * `fs` 是 $DSH_HOME 的门面（读 profiles/<p>/package.json 等自述声明用它），
 * `homeFs` 是**系统 home** 的门面（第三方插件数据的真实位置用它）——
 * 这条区分正是本次修复的核心：拿 $DSH_HOME 去读 `~/.mnemon` 会读到不存在的路径。
 */
function diskCtx(osHome: string): MockHostContext {
  const dshHome = path.join(osHome, '.dsh');
  const ctx = makeContext(PLATFORM, dshHome, 'web');
  ctx.osHomeDir = osHome;
  // 两个门面都换成磁盘实现：fs 根 = $DSH_HOME（读 profiles/<p>/package.json 等自述声明），
  // homeFs 根 = 系统 home（读写第三方插件数据）
  ctx.fs = new DiskFs(dshHome) as unknown as MockHostContext['fs'];
  ctx.homeFs = new DiskFs(osHome) as unknown as MockHostContext['fs'];
  return ctx;
}

function adapters() {
  // env 传空对象：端到端验证不依赖运行机器的环境变量（真机由 process.env 决定）
  return [new PluginDataAdapter('pluginData', { env: {} }), new PluginDataAdapter('pluginAssets', { env: {} })];
}

async function exportSection(ctx: MockHostContext, only: SectionId[], outPath: string): Promise<void> {
  await new Exporter({ ctx, adapters: adapters(), exporterVersion: '0.1.0-e2e' }).export({
    includeSecrets: false, only, outPath,
  });
}

async function withHomes(fn: (homeA: string, homeB: string, root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dcm-plugin-data-e2e-'));
  try {
    const a = path.join(root, 'home-a');
    const b = path.join(root, 'home-b');
    await fsp.mkdir(a, { recursive: true });
    await fsp.mkdir(b, { recursive: true });
    await fn(a, b, root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

const WALLPAPER_CONFIG = '{"wallpaper":"scene-42","cacheDir":""}';
const RUNTIME_MEMORY = '# MEMORY\n- 记得\n';
const DB_BYTES = 'sqlite-ish-bytes';

/** 源 home：wallpaper-engine（配置 + 缓存 + 上传的壁纸）与 mnemon（运行时 + 数据库） */
async function seedSourceHome(home: string): Promise<void> {
  const write = async (rel: string, text: string): Promise<void> => {
    const abs = path.join(home, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text, 'utf8');
  };
  await write('.dsh-wallpaper-engine/config.json', WALLPAPER_CONFIG);
  await write('.dsh-wallpaper-engine/cache/frame.bin', 'CACHE-MUST-NOT-TRAVEL');
  await write('.dsh-wallpaper-engine/uploads/wall.mp4', 'video-bytes');
  await write('.mnemon/runtime/MEMORY.md', RUNTIME_MEMORY);
  await write('.mnemon/data/body.db', DB_BYTES);
}

function importerFor(ctx: MockHostContext): Importer {
  return new Importer({ ctx, adapters: adapters(), snapshotStore: new MemSnapshotStore() });
}

test('E2E 1：新 home / 新 profile —— 配置与轻量数据逐字节迁移，缓存与资产不跟来', async () => {
  await withHomes(async (homeA, homeB, root) => {
    await seedSourceHome(homeA);
    const zip = path.join(root, 'pluginData.zip');
    await exportSection(diskCtx(homeA), ['pluginData'], zip);

    const dst = diskCtx(homeB);
    const importer = importerFor(dst);
    const plan = await importer.createImportPlan(zip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const kinds = new Map(plan.items.map((i) => [i.id, i.kind]));
    assert.equal(kinds.get('pluginData:.dsh-wallpaper-engine/config.json'), 'Create');
    assert.equal(kinds.get('pluginData:.mnemon/runtime/MEMORY.md'), 'Create');
    assert.ok(![...kinds.keys()].some((k) => k.includes('/cache/')), '缓存不得出现在计划里');
    assert.ok(![...kinds.keys()].some((k) => k.includes('/uploads/')), '资产不得随配置分区走');
    assert.ok(![...kinds.keys()].some((k) => k.includes('.mnemon/data/')), '数据库属资产，不得随配置分区走');

    const result = await importer.executeImportPlan(zip, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.executed.filter((e) => e.status === 'failed'), []);

    const read = (rel: string) => fsp.readFile(path.join(homeB, ...rel.split('/')), 'utf8');
    assert.equal(await read('.dsh-wallpaper-engine/config.json'), WALLPAPER_CONFIG);
    assert.equal(await read('.mnemon/runtime/MEMORY.md'), RUNTIME_MEMORY);
    await assert.rejects(read('.dsh-wallpaper-engine/cache/frame.bin'), '缓存不得落到目标 home');
    await assert.rejects(read('.dsh-wallpaper-engine/uploads/wall.mp4'), '资产不得落到目标 home');
  });
});

test('E2E 2：大资产走自己的分区 —— 上传的壁纸与本地数据库按需迁移', async () => {
  await withHomes(async (homeA, homeB, root) => {
    await seedSourceHome(homeA);
    const zip = path.join(root, 'pluginAssets.zip');
    await exportSection(diskCtx(homeA), ['pluginAssets'], zip);

    const dst = diskCtx(homeB);
    const importer = importerFor(dst);
    const plan = await importer.createImportPlan(zip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const result = await importer.executeImportPlan(zip, plan, { confirm: true });
    assert.equal(result.ok, true);

    assert.equal(await fsp.readFile(path.join(homeB, '.dsh-wallpaper-engine', 'uploads', 'wall.mp4'), 'utf8'), 'video-bytes');
    assert.equal(await fsp.readFile(path.join(homeB, '.mnemon', 'data', 'body.db'), 'utf8'), DB_BYTES);
    // 缓存既不在计划里，也不可能落盘
    assert.equal(await existsAbs(path.join(homeB, '.dsh-wallpaper-engine', 'cache')), false);
  });
});

test('E2E 3：目标机既有文件判 Conflict —— 冲突不默认覆盖', async () => {
  await withHomes(async (homeA, homeB, root) => {
    await seedSourceHome(homeA);
    const zip = path.join(root, 'pluginData.zip');
    await exportSection(diskCtx(homeA), ['pluginData'], zip);

    // 目标机已有一份**不同**的配置（用户自己放在那儿的）
    const target = path.join(homeB, '.dsh-wallpaper-engine', 'config.json');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, '{"wallpaper":"local-choice"}', 'utf8');

    // 反向哨兵：$DSH_HOME 下**不得**出现同名目录（那正是修复前「读错根」的落点）
    assert.equal(await existsAbs(path.join(homeB, '.dsh', '.dsh-wallpaper-engine')), false);

    const dst = diskCtx(homeB);
    const importer = importerFor(dst);
    const plan = await importer.createImportPlan(zip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.equal(plan.items.find((i) => i.id === 'pluginData:.dsh-wallpaper-engine/config.json')?.kind, 'Conflict');

    const result = await importer.executeImportPlan(zip, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(await fsp.readFile(target, 'utf8'), '{"wallpaper":"local-choice"}', '未决策的冲突不得覆盖目标文件');
  });
});

test('E2E 4：伪造条目被白名单挡住 —— 计划里 Error、执行期零写入', async () => {
  await withHomes(async (homeA, homeB, root) => {
    await seedSourceHome(homeA);
    const clean = path.join(root, 'pluginData.zip');
    await exportSection(diskCtx(homeA), ['pluginData'], clean);

    // 在真实 bundle 上注入两个不在白名单内的条目（并重算 checksums，绕过完整性防线）
    const evil = path.join(root, 'pluginData-evil.zip');
    await rebuildBundle(clean, evil, {
      extraEntries: [
        { name: 'plugin-data/.credentials.yaml', data: Buffer.from('DEEPSEEK_API_KEY: leaked\n', 'utf8') },
        { name: 'plugin-data/.unclaimed-plugin/state.json', data: Buffer.from('{}', 'utf8') },
      ],
    });

    const dst = diskCtx(homeB);
    const importer = importerFor(dst);
    const plan = await importer.createImportPlan(evil, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const denied = plan.items.filter((i) => i.kind === 'Error').map((i) => i.id).sort();
    assert.deepEqual(denied, ['pluginData:.credentials.yaml', 'pluginData:.unclaimed-plugin/state.json']);

    const result = await importer.executeImportPlan(evil, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(await existsAbs(path.join(homeB, '.credentials.yaml')), false, '凭据文件绝不允许被写进来');
    assert.equal(await existsAbs(path.join(homeB, '.unclaimed-plugin')), false, '未声明插件的目录绝不允许被写进来');
  });
});

test('E2E 5：已安装插件自述声明 —— 目标机装了才放行（新 home 未装则拒绝）', async () => {
  await withHomes(async (homeA, homeB, root) => {
    // 自述声明在 **$DSH_HOME** 下（profiles/<profile>/node_modules）——读它用的是 fs 门面，不是 homeFs
    const writeManifest = async (home: string): Promise<void> => {
      const dir = path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-fake');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(home, '.dsh', 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'dsh-fake': '^1.0.0' } }), 'utf8');
      await fsp.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'dsh-fake', dsh: { dataDirs: [{ path: '.fake-plugin', role: 'config' }] } }),
        'utf8',
      );
    };
    await writeManifest(homeA);
    const stateAbs = path.join(homeA, '.fake-plugin', 'state.json');
    await fsp.mkdir(path.dirname(stateAbs), { recursive: true });
    await fsp.writeFile(stateAbs, '{"a":1}', 'utf8');

    const zip = path.join(root, 'declared.zip');
    await exportSection(diskCtx(homeA), ['pluginData'], zip);

    // B 未安装该插件 → 拒绝写（白名单只认本机可解析的区域）
    const fresh = diskCtx(homeB);
    const freshPlan = await importerFor(fresh).createImportPlan(zip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.equal(freshPlan.items[0]?.kind, 'Error', '目标机没装该插件 → 声明解析不出来 → 拒绝');
    assert.equal(await existsAbs(path.join(homeB, '.fake-plugin')), false);

    // B 装上该插件 → 同一份包放行
    await writeManifest(homeB);
    const dst = diskCtx(homeB);
    const plan = await importerFor(dst).createImportPlan(zip, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.equal(plan.items[0]?.kind, 'Create');
    const result = await importerFor(dst).executeImportPlan(zip, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(await fsp.readFile(path.join(homeB, '.fake-plugin', 'state.json'), 'utf8'), '{"a":1}');
  });
});
