/**
 * Boot Rescue（启动救援）单测 —— 真实临时目录（os.tmpdir() / fs.mkdtemp），
 * node:test + node:assert/strict。
 *
 * 覆盖：
 *  - B-01/B-02   rescuePaths 形状 / homeFingerprint 稳定性
 *  - B-02b..B-02d normalizeHomeDir + 指纹对「同一目录的不同写法」不敏感
 *                （C:/… vs C:\… 曾让 exitRescueMode 自判 stale，一个文件都不动）
 *  - B-03..B-07  computeSafeBundles：保留+剔除（保序）、非字符串、resolver 抛错、
 *                非数组（inputWasArray=false）、空数组、异步 resolver、零 IO 纯函数
 *  - B-08..B-15  enterRescueMode：happy path（备份=原始字节 / 最小 patch / home patch 置空 /
 *                bundles 裁剪且**扁平** / 状态文件）、profile patch 原本缺失、
 *                幂等 already-active（零字节改动）、package.json 非法（零改动）、
 *                备份失败（原件不动）、无裁剪不重写、默认备份目录、neutralizeHomePatch=false
 *  - B-16..B-19  exitRescueMode：三处逐字节还原 + 状态文件删除、备份缺失（零改动）、
 *                未激活、stale 状态拒绝还原
 *  - B-20        rescueModeStatus：active / stale（指纹不匹配）/ 缺失 / 损坏
 *  - B-21        全流程往返：enter → status active → exit → status inactive + 逐字节还原
 *  - B-22        rescueMount：本插件在 bundles 里 → patch 只写空列表（不得重复插入同 id 行）
 *  - B-23        rescueMount：package.json 缺失 / bundles 非数组 → 回退 patch 层挂载行
 *  - B-24..B-26  restrictToRescueBundles / disableUserBundles：真正把用户插件移出 bundles
 *                （保留 @deepseek-ai/* 与自身）、缺省仍走保守路径、退出可完全还原
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256Hex } from '../utils/hashing.ts';
import { FAIL_CLOSED_STARTUP, StartupRecoveryController } from './startup-barrier.ts';

import {
  computeSafeBundles,
  enterRescueMode,
  exitRescueMode,
  homeFingerprint,
  normalizeHomeDir,
  rescueModeStatus,
  rescuePaths,
  restrictToRescueBundles,
  RESCUE_KEEP_BUNDLE_PREFIXES,
  type RescueEnterOptions,
  type RescueEnterResult,
  type RescueExitResult,
  type RescueSelfMount,
  type RescueState,
} from './boot-rescue.ts';

/* ---------------------------------------------------------------- 常量与夹具 */

const PROFILE = 'web';

/** 救援插件自身的挂载描述（宿主传入；packageName 与 profile package.json 的 bundles 条目比对） */
const RESCUE_MOUNT: RescueSelfMount = {
  packageName: 'dsh-config-manager',
  row: { id: 'config-manager', name: 'dsh-config-manager' },
};

/** 救援 patch 头注释锚点（正文由 core 生成，测试只锚定首行 + 生效行） */
const RESCUE_HEAD = '# dsh-config-manager RESCUE MODE';

/** 三处原件（package.json 故意用单行/非 2 空格缩进，用于验证「无裁剪不重写」与逐字节还原） */
const ORIGINAL_PROFILE_PATCH = '# profile patch\n- name: config-manager\n  config: { keepMe: true }\n';
const ORIGINAL_HOME_PATCH = '# home patch\n- name: config-manager\n';
const ORIGINAL_PACKAGE_JSON =
  '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["good-bundle","broken-bundle"]}}}\n';

/** bundles 里含本插件（bundle 层已挂载）的 package.json */
const PACKAGE_JSON_WITH_SELF_BUNDLE =
  '{"name":"dsh-profile-web","private":true,"dsh":{"profile":{"bundles":["good-bundle","dsh-config-manager"]}}}\n';

/** 默认备份目录（相对 homeDir 的 posix 路径，与实现的缺省约定一致） */
const DEFAULT_BACKUP_DIR_REL = 'dsh-config-manager/transactions/rescue-backups';

type EnterFailure = Extract<RescueEnterResult, { ok: false }>;
type ExitFailure = Extract<RescueExitResult, { ok: false }>;

/** 真实临时 home 目录，测试结束自动清理 */
async function makeHome(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bootrescue-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 相对 homeDir 的 posix 相对路径 → 原生绝对路径（测试侧独立实现，不复用被测代码） */
function at(homeDir: string, relPosix: string): string {
  return path.join(homeDir, ...relPosix.split('/'));
}

/** 三处受救援模式管理的绝对路径 */
function targets(homeDir: string): { profilePatch: string; homePatch: string; packageJson: string } {
  const rel = rescuePaths(PROFILE);
  return {
    profilePatch: at(homeDir, rel.profilePatch),
    homePatch: at(homeDir, rel.homePatch),
    packageJson: at(homeDir, rel.profilePackageJson),
  };
}

/** 写入（自动建父目录） */
async function writeFileDeep(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, 'utf8');
}

async function readText(file: string): Promise<string> {
  return new TextDecoder().decode(await fs.readFile(file));
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 递归快照整棵树：相对路径 → base64 字节。用于「字节级零改动」断言。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: Awaited<ReturnType<typeof fs.readdir>> extends unknown ? import('node:fs').Dirent[] : never;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 → 该子树为空
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(abs, rel);
      else out[rel] = (await fs.readFile(abs)).toString('base64');
    }
  }
  await walk(root, '');
  return out;
}

/** 铺好三处原件 */
async function seedOriginals(homeDir: string): Promise<void> {
  const p = targets(homeDir);
  await writeFileDeep(p.profilePatch, ORIGINAL_PROFILE_PATCH);
  await writeFileDeep(p.homePatch, ORIGINAL_HOME_PATCH);
  await writeFileDeep(p.packageJson, ORIGINAL_PACKAGE_JSON);
}

function enterOpts(homeDir: string, backupDir: string, over: Partial<RescueEnterOptions> = {}): RescueEnterOptions {
  return { homeDir, profile: PROFILE, rescueMount: RESCUE_MOUNT, backupDir, ...over };
}

/**
 * 断言 profile patch 只挂载救援插件自身（去注释后的生效行）。
 * selfInBundles=true → 必须为空列表：本插件已由 bundle 层挂载，patch 层再插一行同 id
 * 会让 loader 抛 duplicate loader entry id，整棵插件树加载失败（回归护栏）。
 */
async function assertRescuePatch(file: string, selfInBundles: boolean): Promise<void> {
  const text = await readText(file);
  assert.ok(text.startsWith(RESCUE_HEAD), `profile patch 应以救援头注释开头，实际：${text.slice(0, 40)}`);
  const body = text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n');
  if (selfInBundles) {
    assert.equal(body, '[]', 'bundle 层已挂载本插件 → patch 层必须写空列表');
    return;
  }
  assert.equal(body, "- insert:\n    - id: 'config-manager'\n      name: 'dsh-config-manager'");
}

async function enterOk(opts: RescueEnterOptions): Promise<RescueState> {
  const res = await enterRescueMode(opts);
  if (!res.ok) throw new Error(`expected enterRescueMode to succeed, got ${res.code}: ${res.message}`);
  return res.state;
}

async function enterFail(opts: RescueEnterOptions): Promise<EnterFailure> {
  const res = await enterRescueMode(opts);
  if (res.ok) throw new Error('expected enterRescueMode to fail, but it succeeded');
  return res;
}

async function exitOk(opts: { homeDir: string; backupDir?: string }): Promise<string[]> {
  const res = await exitRescueMode(opts);
  if (!res.ok) throw new Error(`expected exitRescueMode to succeed, got ${res.code}: ${res.message}`);
  return res.restored;
}

async function exitFail(opts: { homeDir: string; backupDir?: string }): Promise<ExitFailure> {
  const res = await exitRescueMode(opts);
  if (res.ok) throw new Error('expected exitRescueMode to fail, but it succeeded');
  return res;
}

/* ---------------------------------------------------------------- 路径与指纹 */

test('B-01 rescuePaths：三处文件的 homeDir 相对 posix 路径', () => {
  assert.deepEqual(rescuePaths('web'), {
    profilePatch: 'profiles/web/cordis.patch.yml',
    homePatch: 'cordis.patch.yml',
    profilePackageJson: 'profiles/web/package.json',
  });
  assert.deepEqual(rescuePaths('other'), {
    profilePatch: 'profiles/other/cordis.patch.yml',
    homePatch: 'cordis.patch.yml',
    profilePackageJson: 'profiles/other/package.json',
  });
});

test('B-02 homeFingerprint：homeDir+profile 决定，稳定且可区分', () => {
  const base = homeFingerprint('/home/u/.dsh', 'web');
  assert.equal(base, homeFingerprint('/home/u/.dsh', 'web'), '同输入稳定');
  assert.match(base, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.notEqual(base, homeFingerprint('/home/u/.dsh', 'other'), 'profile 变化 → 指纹变化');
  assert.notEqual(base, homeFingerprint('/home/u/other', 'web'), 'homeDir 变化 → 指纹变化');
});

/*
 * B-02b 回归：同一目录的不同**写法**必须得到同一指纹。
 * 原始实现直接哈希调用方传入的字符串，于是 `C:/x/.dsh` 与 `C:\x\.dsh` 算出不同指纹，
 * exitRescueMode 把自己的状态判成 stale 并拒绝还原（一个文件都不动，只能手改文件）。
 * 从插件 UI 进出时两次都原样传 host.homeDir 所以看不出来，从 CLI / 脚本进出就会踩到。
 */
test('B-02b normalizeHomeDir：消掉分隔符混用 / 尾分隔符 / . 与 .. / win32 大小写', () => {
  // 分隔符混用与尾分隔符、`.` 段：跨平台都必须归一（Linux 上正斜杠本就是规范形式）
  assert.equal(
    normalizeHomeDir('/home/u/.dsh'),
    normalizeHomeDir('/home/u/.dsh/'),
    '尾分隔符必须归一',
  );
  assert.equal(
    normalizeHomeDir('/home/u/.dsh'),
    normalizeHomeDir('/home/u/./.dsh'),
    '`.` 段必须归一',
  );
  assert.equal(
    normalizeHomeDir('/home/u/.dsh'),
    normalizeHomeDir('/home/u/x/../.dsh'),
    '`..` 段必须归一',
  );
  // win32 语义用显式 platform 断言，使该分支在非 win32 的 CI 上同样被守卫
  assert.equal(
    normalizeHomeDir('C:/Users/a/.dsh', 'win32'),
    normalizeHomeDir('c:\\Users\\A\\.dsh', 'win32'),
    'win32：分隔符混用 + 大小写差异必须归一到同一键',
  );
  assert.equal(normalizeHomeDir('C:/Users/a/.dsh', 'win32'), 'c:\\users\\a\\.dsh');
  // 非 win32 不折叠大小写（区分大小写的文件系统上这是两个目录）
  assert.notEqual(normalizeHomeDir('/Home/U/.dsh', 'linux'), normalizeHomeDir('/home/u/.dsh', 'linux'));
});

test('B-02c homeFingerprint：同一目录的不同写法 → 同一指纹', () => {
  const homeDir = path.join(os.tmpdir(), 'dsh-fp', 'home');
  assert.equal(
    homeFingerprint(homeDir, PROFILE),
    homeFingerprint(`${homeDir}${path.sep}`, PROFILE),
    '尾分隔符不得改变指纹',
  );
  assert.equal(
    homeFingerprint(homeDir, PROFILE),
    homeFingerprint(homeDir.split(path.sep).join('/'), PROFILE),
    '分隔符混用不得改变指纹（这正是 CLI 手写路径踩到的那个坑）',
  );
});

/**
 * B-02d 端到端：从「不同写法」的 homeDir 退出救援，必须真的还原文件。
 * 这是用户实际卡住的场景 —— 进救援与出救援各自拼路径，写法不同。
 */
test('B-02d exitRescueMode：homeDir 换个写法进出，仍能还原（不再自判 stale）', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);
  const original = await readText(p.profilePatch);

  // 进入用原生形式
  await enterOk(enterOpts(homeDir, backupDir));
  // 退出用一个「等价但写法不同」的路径（模拟 CLI 手写 DSH_HOME）。
  // 必须按平台选写法：Windows 用正斜杠（手写最常见），POSIX 用尾随分隔符——
  // 不能统一写 split(path.sep).join('/')，POSIX 上 path.sep 本来就是 '/'，
  // 换完与原串逐字节相同，前置断言会在 Linux CI 上失败（v0.1.60 首次发布时实测踩到）。
  const slashed = process.platform === 'win32'
    ? homeDir.split(path.sep).join('/')
    : `${homeDir}${path.sep}`;
  assert.notEqual(slashed, homeDir, '前置条件：两种写法确实是不同字符串');
  assert.equal(path.resolve(slashed), path.resolve(homeDir), '前置条件：两种写法指向同一目录');
  const restored = await exitOk({ homeDir: slashed, backupDir });
  assert.ok(restored.length > 0, '必须真的还原了文件');
  assert.equal(await readText(p.profilePatch), original, 'profile patch 必须逐字节还原');
});

/**
 * B-02e 向后兼容：修复前写入的状态用的是「原始字符串」指纹。
 * 用户可能停留在「已进入救援」与「升级插件」之间；只认新指纹会让他们**无法退出救援**，
 * 等于把旧 bug 换成新 bug。历史形态必须仍被接受。
 */
test('B-02e exitRescueMode：接受历史（归一化前）指纹的状态，老状态也能退出', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);
  const original = await readText(p.profilePatch);

  await enterOk(enterOpts(homeDir, backupDir));

  // 把状态文件的指纹改写成「旧算法」的结果（= 原始字符串直接哈希）
  const statePath = path.join(backupDir, 'state.json');
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
  raw['homeFingerprint'] = sha256Hex(`${homeDir}|${PROFILE}`);
  await fs.writeFile(statePath, JSON.stringify(raw), 'utf8');

  // status 仍须判为 active（否则 UI 不给「退出救援」按钮）
  const status = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(status.active, true, '历史指纹必须仍被判为 active');
  assert.equal(status.stale, false);

  const restored = await exitOk({ homeDir, backupDir });
  assert.ok(restored.length > 0, '必须真的还原');
  assert.equal(await readText(p.profilePatch), original);
});

/** B-02f 安全性不因兼容而削弱：换一个 home 仍必须判 stale、拒绝还原。 */
test('B-02f exitRescueMode：指纹属于别的 home 时仍拒绝还原（兼容不得削弱保护）', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);
  await enterOk(enterOpts(homeDir, backupDir));
  const before = await readText(p.profilePatch);

  const statePath = path.join(backupDir, 'state.json');
  const raw = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
  raw['homeFingerprint'] = sha256Hex(`${homeDir}-other-machine|${PROFILE}`);
  await fs.writeFile(statePath, JSON.stringify(raw), 'utf8');

  const res = await exitFail({ homeDir, backupDir });
  assert.equal(res.code, 'not-active');
  assert.match(res.message, /stale/);
  assert.equal(await readText(p.profilePatch), before, '拒绝还原必须零改动');
});

/* ---------------------------------------------------------------- computeSafeBundles */

test('B-03 computeSafeBundles：保留可解析、剔除不可解析（保序，逐个探测）', async () => {
  const seen: string[] = [];
  const r = await computeSafeBundles(['a', 'b', 'c'], (name) => {
    seen.push(name);
    return name !== 'b';
  });
  assert.deepEqual(r.kept, ['a', 'c']);
  assert.deepEqual(r.pruned, [{ name: 'b', reason: 'unresolved' }]);
  assert.equal(r.inputWasArray, true);
  assert.deepEqual(seen, ['a', 'b', 'c'], '按原顺序逐个探测');
});

test('B-04 computeSafeBundles：非字符串条目 → non-string，且不调用 resolver', async () => {
  let calls = 0;
  const r = await computeSafeBundles(['ok', 42, null, { name: 'x' }, ['nested']], () => {
    calls += 1;
    return true;
  });
  assert.deepEqual(r.kept, ['ok']);
  assert.deepEqual(
    r.pruned.map((p) => p.reason),
    ['non-string', 'non-string', 'non-string', 'non-string'],
  );
  assert.equal(calls, 1, '非字符串条目不需要探测');
  assert.equal(r.pruned[0]?.name, '42');
  assert.equal(r.pruned[1]?.name, 'null');
});

test('B-05 computeSafeBundles：resolver 抛错 → unresolved（异常不外泄）', async () => {
  const r = await computeSafeBundles(['boom', 'fine'], (name) => {
    if (name === 'boom') throw new Error('cannot resolve boom');
    return true;
  });
  assert.deepEqual(r.kept, ['fine']);
  assert.deepEqual(r.pruned, [{ name: 'boom', reason: 'unresolved' }]);
});

test('B-06 computeSafeBundles：异步 resolver + undefined/非布尔返回值一律保守剔除', async () => {
  const r = await computeSafeBundles(['async-ok', 'async-bad'], async (name) => name === 'async-ok');
  assert.deepEqual(r.kept, ['async-ok']);
  assert.deepEqual(r.pruned, [{ name: 'async-bad', reason: 'unresolved' }]);

  const loose = await computeSafeBundles(['weird'], (() => undefined) as unknown as () => boolean);
  assert.deepEqual(loose.kept, []);
  assert.deepEqual(loose.pruned, [{ name: 'weird', reason: 'unresolved' }]);
});

test('B-07 computeSafeBundles：非数组/缺失 → inputWasArray=false；空数组 → 空结果', async () => {
  for (const bad of [undefined, null, 'good-bundle', 42, { 0: 'good-bundle' }, { bundles: ['good-bundle'] }]) {
    const r = await computeSafeBundles(bad, () => true);
    assert.deepEqual(r, { kept: [], pruned: [], inputWasArray: false });
  }
  assert.deepEqual(await computeSafeBundles([], () => true), { kept: [], pruned: [], inputWasArray: true });
});

/* ---------------------------------------------------------------- enterRescueMode */

test('B-08 enterRescueMode happy path：备份→裁剪 bundles→最小 patch→置空 home patch→状态', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  const state = await enterOk(
    enterOpts(homeDir, backupDir, {
      resolveBundle: (name) => name === 'good-bundle',
      now: () => new Date('2026-01-02T03:04:05.000Z'),
    }),
  );

  // 状态字段
  assert.equal(state.active, true);
  assert.equal(state.profile, PROFILE);
  assert.equal(state.enteredAt, '2026-01-02T03:04:05.000Z');
  assert.equal(state.homeFingerprint, homeFingerprint(homeDir, PROFILE));
  assert.equal(state.profilePatchWasAbsent, false);
  assert.deepEqual(state.prunedBundles, [{ name: 'broken-bundle', reason: 'unresolved' }]);

  // 备份 = 原始字节
  assert.notEqual(state.backup.profilePatch, '');
  assert.equal(await readText(state.backup.profilePatch), ORIGINAL_PROFILE_PATCH);
  const homeBackup = state.backup.homePatch;
  const pkgBackup = state.backup.profilePackageJson;
  assert.ok(homeBackup !== null && pkgBackup !== null, '原件存在 → 备份路径非 null');
  assert.equal(await readText(homeBackup), ORIGINAL_HOME_PATCH);
  assert.equal(await readText(pkgBackup), ORIGINAL_PACKAGE_JSON);

  // 目标文件：最小 patch + home patch 置空
  await assertRescuePatch(p.profilePatch, false);
  assert.equal(await readText(p.homePatch), '[]\n');

  // package.json：只改 dsh.profile.bundles，且必须是扁平字符串数组
  const raw = await readText(p.packageJson);
  const pkg = JSON.parse(raw) as { name?: unknown; private?: unknown; dsh?: { profile?: { bundles?: unknown } } };
  const bundles = pkg.dsh?.profile?.bundles;
  assert.deepEqual(bundles, ['good-bundle'], 'bundles = 扁平字符串数组');
  assert.notDeepEqual(bundles, [['good-bundle']], 'bundles 不得被二次包裹为 [[name]]');
  assert.equal(raw.includes('[["good-bundle"]]'), false, '磁盘文本不得出现双层数组');
  assert.equal(raw.includes('["good-bundle"]'), false, '磁盘文本不得出现（无空格）双层数组');
  assert.equal(pkg.name, 'dsh-profile-web', '其余字段保持不变');
  assert.equal(pkg.private, true);
  assert.notEqual(raw, ORIGINAL_PACKAGE_JSON, '有裁剪 → 文件被重写');
  assert.ok(raw.endsWith('\n'), '保留尾换行');
  assert.ok(raw.includes('\n  "dsh"'), '2 空格缩进重序列化');

  // 状态文件
  const stateFile = path.join(backupDir, 'state.json');
  const written = JSON.parse(await readText(stateFile)) as { active?: unknown; profile?: unknown };
  assert.equal(written.active, true);
  assert.equal(written.profile, PROFILE);

  // 进入后 status 应为 active
  const status = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(status.active, true);
  assert.equal(status.stale, false);
});

test('B-09 enterRescueMode：profile patch 原本不存在 → profilePatchWasAbsent 且文件被创建', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await writeFileDeep(p.homePatch, ORIGINAL_HOME_PATCH); // 只有 home patch，无 profile patch / package.json

  const state = await enterOk(enterOpts(homeDir, backupDir));

  assert.equal(state.profilePatchWasAbsent, true);
  assert.equal(state.backup.profilePatch, '', '原件不存在 → 无备份路径');
  assert.equal(state.backup.homePatch === null, false, 'home patch 存在 → 有备份');
  assert.equal(state.backup.profilePackageJson, null, 'package.json 不存在 → 无备份');
  await assertRescuePatch(p.profilePatch, false); // 无 package.json → 无法判定 bundle 挂载 → 回退插入行
  assert.equal(await fileExists(p.packageJson), false, '不创建不存在的 package.json');
  assert.equal(state.prunedBundles.length, 0);

  // 退出：profile patch 是本次创建的 → 删除而非还原
  assert.deepEqual(await exitOk({ homeDir, backupDir }), [rescuePaths(PROFILE).profilePatch, rescuePaths(PROFILE).homePatch]);
  assert.equal(await fileExists(p.profilePatch), false, '进入时不存在 → 退出时删除');
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH, 'home patch 还原');
});

test('B-10 enterRescueMode 幂等：第二次 already-active 且磁盘字节零改动', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  await seedOriginals(homeDir);

  await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: (name) => name === 'good-bundle' }));
  const before = await snapshotTree(homeDir);

  const again = await enterFail(enterOpts(homeDir, backupDir, { resolveBundle: () => false }));
  assert.equal(again.code, 'already-active');
  assert.deepEqual(await snapshotTree(homeDir), before, 'already-active 必须一个字节都不改');
});

test('B-11 enterRescueMode：package.json 存在但不可解析 → package-json-invalid 且零改动', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);
  const malformed = '{"name":"web","dsh":{"profile":{"bundles":[';
  await fs.writeFile(p.packageJson, malformed, 'utf8');
  const before = await snapshotTree(homeDir);

  const res = await enterFail(enterOpts(homeDir, backupDir));

  assert.equal(res.code, 'package-json-invalid');
  assert.equal(await readText(p.packageJson), malformed, 'package.json 逐字节不变');
  assert.deepEqual(await snapshotTree(homeDir), before, '零改动（profile/home patch 也没被改）');
  assert.equal(await fileExists(path.join(backupDir, 'state.json')), false, '未写状态文件');
});

test('B-12 enterRescueMode：备份失败 → backup-failed 且原件不动', async (t) => {
  const homeDir = await makeHome(t);
  const p = targets(homeDir);
  await seedOriginals(homeDir);
  // 备份目录路径上放一个普通文件 → 无法创建目录
  const blocked = path.join(homeDir, 'blocked-backup');
  await fs.writeFile(blocked, 'not a directory\n', 'utf8');
  const before = await snapshotTree(homeDir);

  const res = await enterFail(enterOpts(homeDir, path.join(blocked, 'nested')));

  assert.equal(res.code, 'backup-failed');
  assert.deepEqual(await snapshotTree(homeDir), before, '备份失败 → 目标文件保持原样');
  assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH);
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH);
  assert.equal(await readText(p.packageJson), ORIGINAL_PACKAGE_JSON);
});

test('B-13 enterRescueMode：无裁剪 → 保持原字节（不重写 package.json）；缺省 resolver 保守', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  // 全部可解析 → pruned 为空 → 不重写（单行 JSON 原样保留）
  const state = await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: () => true }));
  assert.deepEqual(state.prunedBundles, []);
  assert.equal(await readText(p.packageJson), ORIGINAL_PACKAGE_JSON, '无裁剪 → 不重序列化');

  // 第二个 home：不传 resolver（缺省保守）→ 字符串名字全部保留，同样不重写
  const homeDir2 = await makeHome(t);
  const p2 = targets(homeDir2);
  await writeFileDeep(p2.packageJson, ORIGINAL_PACKAGE_JSON);
  await writeFileDeep(p2.profilePatch, ORIGINAL_PROFILE_PATCH);
  const state2 = await enterOk(enterOpts(homeDir2, path.join(homeDir2, 'b')));
  assert.deepEqual(state2.prunedBundles, []);
  assert.equal(await readText(p2.packageJson), ORIGINAL_PACKAGE_JSON, '缺省 resolver = 不裁剪');
});

test('B-14 enterRescueMode：缺省备份目录 = <homeDir>/dsh-config-manager/transactions/rescue-backups', async (t) => {
  const homeDir = await makeHome(t);
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  const state = await enterRescueMode({ homeDir, profile: PROFILE, rescueMount: RESCUE_MOUNT, resolveBundle: () => false });
  assert.equal(state.ok, true);
  if (!state.ok) return;

  const defaultDir = at(homeDir, DEFAULT_BACKUP_DIR_REL);
  assert.equal(await fileExists(path.join(defaultDir, 'state.json')), true, '状态文件落在缺省备份目录');
  const status = await rescueModeStatus({ homeDir, profile: PROFILE });
  assert.equal(status.active, true, '不传 backupDir 时状态同样可读');

  // 走缺省目录退出
  await exitOk({ homeDir });
  assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH);
  assert.equal(await readText(p.packageJson), ORIGINAL_PACKAGE_JSON);
});

test('B-15 enterRescueMode：neutralizeHomePatch=false → home patch 不被动，退出也不还原它', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  await enterOk(enterOpts(homeDir, backupDir, { neutralizeHomePatch: false }));
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH, '未置空');

  const restored = await exitOk({ homeDir, backupDir });
  assert.equal(restored.includes(rescuePaths(PROFILE).homePatch), true, '仍按备份还原 home patch');
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH);
});

test('B-22 rescueMount：本插件已在 bundles 里 → patch 只写空列表（禁止重复插入同 id 行）', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await writeFileDeep(p.profilePatch, ORIGINAL_PROFILE_PATCH);
  await writeFileDeep(p.homePatch, ORIGINAL_HOME_PATCH);
  await writeFileDeep(p.packageJson, PACKAGE_JSON_WITH_SELF_BUNDLE);

  const state = await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: () => true }));

  // 回归护栏：bundle 层已挂载本插件 → patch 层必须是空列表。
  // 旧实现无条件写 `- insert: id: config-manager`，与 bundle 提供的同 id 行冲突 →
  // loader 抛 "duplicate loader entry id: config-manager" → 整棵插件树加载失败，DSH 起不来。
  await assertRescuePatch(p.profilePatch, true);
  const body = (await readText(p.profilePatch))
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n');
  assert.equal(body.includes('insert'), false, '不得出现 insert 块');
  assert.deepEqual(state.prunedBundles, [], '全部可解析 → 无裁剪');
  assert.equal(await readText(p.packageJson), PACKAGE_JSON_WITH_SELF_BUNDLE, '无裁剪 → package.json 不重写');
  assert.equal(await readText(p.homePatch), '[]\n', 'home patch 仍被置空');

  // 退出后逐字节还原
  await exitOk({ homeDir, backupDir });
  assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH);
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH);
});

test('B-23 rescueMount：package.json 缺失 / bundles 非数组 → 回退 patch 层挂载行', async (t) => {
  const cases: (string | undefined)[] = [
    undefined, // 无 package.json
    '{"name":"dsh-profile-web","dsh":{"profile":{"bundles":"dsh-config-manager"}}}\n', // 字符串
    '{"name":"dsh-profile-web","dsh":{"profile":{"bundles":{"0":"dsh-config-manager"}}}}\n', // 对象
  ];
  for (const pkgText of cases) {
    const homeDir = await makeHome(t);
    const backupDir = path.join(homeDir, 'rescue-backups');
    const p = targets(homeDir);
    await writeFileDeep(p.profilePatch, ORIGINAL_PROFILE_PATCH);
    if (pkgText !== undefined) await writeFileDeep(p.packageJson, pkgText);

    await enterOk(enterOpts(homeDir, backupDir)); // 缺省 resolver = 不裁剪

    // 无法确认 bundle 层挂载 → 必须由 patch 层挂载，否则救援模式里没有救援插件
    await assertRescuePatch(p.profilePatch, false);
    await exitOk({ homeDir, backupDir });
    assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH);
  }
});

/* ---------------------------------------------------------------- 救援范围收窄（禁用其它插件） */

test('B-24 restrictToRescueBundles：只留 DSH 核心与救援插件自身', () => {
  assert.deepEqual(RESCUE_KEEP_BUNDLE_PREFIXES, ['@deepseek-ai/']);
  const r = restrictToRescueBundles(
    ['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-config-manager', 'dsh-agy-link', '@deepseek-ai/dsh-web-app'],
    'dsh-config-manager',
  );
  assert.deepEqual(r.kept, ['@deepseek-ai/dsh-base', 'dsh-config-manager', '@deepseek-ai/dsh-web-app'], '保序保留核心 + 自身');
  assert.deepEqual(r.pruned, [
    { name: 'dshmarket', reason: 'rescue-disabled' },
    { name: 'dsh-agy-link', reason: 'rescue-disabled' },
  ]);
  // 自定义保留前缀
  const custom = restrictToRescueBundles(['@deepseek-ai/a', 'keep-me', 'drop-me'], 'self', ['keep-']);
  assert.deepEqual(custom.kept, ['keep-me']);
  assert.deepEqual(custom.pruned.map((p) => p.name), ['@deepseek-ai/a', 'drop-me']);
});

/**
 * B-25 端到端：disableUserBundles=true 时必须真的把用户插件移出 bundles。
 * 只中和 patch 层治不了「bundle 能解析但插件代码把 DSH 搞挂」——bundle 层会照旧挂载，
 * 救援模式名不副实。本测试锁定「文案承诺 = 实际行为」。
 */
test('B-25 enterRescueMode(disableUserBundles)：用户插件被移出 bundles，核心与自身保留', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await writeFileDeep(p.profilePatch, ORIGINAL_PROFILE_PATCH);
  await writeFileDeep(p.homePatch, ORIGINAL_HOME_PATCH);
  await writeFileDeep(p.packageJson, JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-config-manager', 'dsh-agy-link'] } },
  }) + '\n');

  const state = await enterOk(enterOpts(homeDir, backupDir, {
    resolveBundle: () => true, // 全部可解析：收窄必须靠 disableUserBundles，而不是靠「不可解析」
    disableUserBundles: true,
  }));

  const written = JSON.parse(await readText(p.packageJson)) as { dsh: { profile: { bundles: unknown } } };
  assert.deepEqual(
    written.dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', 'dsh-config-manager'],
    'bundles 必须收窄为 DSH 核心 + 本插件（且是扁平 string[]）',
  );
  assert.deepEqual(state.prunedBundles, [
    { name: 'dshmarket', reason: 'rescue-disabled' },
    { name: 'dsh-agy-link', reason: 'rescue-disabled' },
  ]);
  // 本插件仍在 bundles → patch 层只能写空列表（否则 loader 抛 duplicate id）
  await assertRescuePatch(p.profilePatch, true);
  // patch 头注释必须如实说明 bundle 已被收窄（不得再写「只裁剪不可解析的 bundle」）
  assert.ok((await readText(p.profilePatch)).includes('已被收窄'), '头注释必须说明 bundle 已收窄');

  // 退出：逐字节还原（收窄完全可逆）
  await exitOk({ homeDir, backupDir });
  assert.ok((await readText(p.packageJson)).includes('dshmarket'), '退出后用户插件必须回来');
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH);
});

test('B-26 disableUserBundles 缺省关闭：只剪不可解析的（保守路径不变）', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await writeFileDeep(p.profilePatch, ORIGINAL_PROFILE_PATCH);
  await writeFileDeep(p.packageJson, JSON.stringify({
    name: 'dsh-profile-web',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good-bundle'] } },
  }) + '\n');

  const state = await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: () => true }));
  assert.deepEqual(state.prunedBundles, [], '缺省不按「非核心」收窄');
  assert.ok((await readText(p.packageJson)).includes('good-bundle'), 'package.json 不得被重写');
});

/* ---------------------------------------------------------------- exitRescueMode */

test('B-16 exitRescueMode happy path：三处逐字节还原 + 状态文件删除', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: (name) => name === 'good-bundle' }));
  assert.notEqual(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH, '进入后已被改写');

  const restored = await exitOk({ homeDir, backupDir });

  assert.deepEqual(restored, [rescuePaths(PROFILE).profilePatch, rescuePaths(PROFILE).homePatch, rescuePaths(PROFILE).profilePackageJson]);
  assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH, 'profile patch 逐字节还原');
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH, 'home patch 逐字节还原');
  assert.equal(await readText(p.packageJson), ORIGINAL_PACKAGE_JSON, 'package.json 逐字节还原（含原单行格式）');
  assert.equal(await fileExists(path.join(backupDir, 'state.json')), false, '状态文件已删除');
  assert.deepEqual(await rescueModeStatus({ homeDir, profile: PROFILE, backupDir }), { active: false, stale: false, state: null });
});

test('B-17 exitRescueMode：备份缺失 → backup-missing 且先校验后还原（零改动）', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  await seedOriginals(homeDir);

  const state = await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: (name) => name === 'good-bundle' }));
  const homeBackup = state.backup.homePatch;
  assert.ok(homeBackup !== null);
  await fs.rm(homeBackup); // 破坏其中一个备份

  const before = await snapshotTree(homeDir);
  const res = await exitFail({ homeDir, backupDir });

  assert.equal(res.code, 'backup-missing');
  assert.deepEqual(await snapshotTree(homeDir), before, '校验失败必须先于任何还原/删除');
  assert.equal(await fileExists(path.join(backupDir, 'state.json')), true, '状态文件保留（可修好后重试）');
});

test('B-18 exitRescueMode：未激活（无状态文件/状态损坏）→ not-active', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');

  const missing = await exitFail({ homeDir, backupDir });
  assert.equal(missing.code, 'not-active');

  await writeFileDeep(path.join(backupDir, 'state.json'), '{ not json');
  const corrupt = await exitFail({ homeDir, backupDir });
  assert.equal(corrupt.code, 'not-active');
});

test('B-19 exitRescueMode：stale 状态（指纹不匹配）拒绝还原，零改动', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  await seedOriginals(homeDir);

  await enterOk(enterOpts(homeDir, backupDir));
  const stateFile = path.join(backupDir, 'state.json');
  const raw = JSON.parse(await readText(stateFile)) as Record<string, unknown>;
  raw['homeFingerprint'] = 'f'.repeat(64);
  await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const before = await snapshotTree(homeDir);
  const res = await exitFail({ homeDir, backupDir });

  assert.equal(res.code, 'not-active', 'stale 状态不激活');
  assert.deepEqual(await snapshotTree(homeDir), before, '拒绝按 stale 状态改写本 home 的文件');
});

/* ---------------------------------------------------------------- rescueModeStatus */

test('B-20 rescueModeStatus：active / stale / 缺失 / 损坏', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const stateFile = path.join(backupDir, 'state.json');
  await seedOriginals(homeDir);

  // 缺失 → 非激活且非 stale
  assert.deepEqual(await rescueModeStatus({ homeDir, profile: PROFILE, backupDir }), { active: false, stale: false, state: null });

  // active
  const entered = await enterOk(enterOpts(homeDir, backupDir));
  const active = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(active.active, true);
  assert.equal(active.stale, false);
  assert.equal(active.state?.profile, PROFILE);
  assert.equal(active.state?.homeFingerprint, entered.homeFingerprint);

  // stale：指纹不匹配 → active=false, stale=true（仍返回解析出的状态供展示）
  const raw = JSON.parse(await readText(stateFile)) as Record<string, unknown>;
  raw['homeFingerprint'] = '0'.repeat(64);
  await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  const stale = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(stale.active, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.state?.active, true, 'stale 分支返回磁盘上的状态');
  // 换了 profile / 换了 home → 同样是 stale
  assert.equal((await rescueModeStatus({ homeDir, profile: 'other', backupDir })).stale, true);
  assert.equal((await rescueModeStatus({ homeDir: `${homeDir}-moved`, profile: PROFILE, backupDir })).stale, true);

  // 损坏 → 与缺失同形
  await fs.writeFile(stateFile, '{ not json', 'utf8');
  assert.deepEqual(await rescueModeStatus({ homeDir, profile: PROFILE, backupDir }), { active: false, stale: false, state: null });
  // 合法 JSON 但形状不对（如 active:false / 缺字段）→ 同样判为损坏
  await fs.writeFile(stateFile, '{"active":false}\n', 'utf8');
  assert.deepEqual(await rescueModeStatus({ homeDir, profile: PROFILE, backupDir }), { active: false, stale: false, state: null });
});

/* ---------------------------------------------------------------- 全流程往返 */

test('B-21 全流程往返：enter → status active → exit → status inactive，profile patch 逐字节相等', async (t) => {
  const homeDir = await makeHome(t);
  const backupDir = path.join(homeDir, 'rescue-backups');
  const p = targets(homeDir);
  await seedOriginals(homeDir);

  assert.equal((await rescueModeStatus({ homeDir, profile: PROFILE, backupDir })).active, false);

  await enterOk(enterOpts(homeDir, backupDir, { resolveBundle: (name) => name === 'good-bundle' }));
  const active = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(active.active, true);
  await assertRescuePatch(p.profilePatch, false);

  await exitOk({ homeDir, backupDir });

  const inactive = await rescueModeStatus({ homeDir, profile: PROFILE, backupDir });
  assert.equal(inactive.active, false);
  assert.equal(inactive.stale, false);
  assert.equal(await readText(p.profilePatch), ORIGINAL_PROFILE_PATCH, '往返后 profile patch 与原始字节完全相等');
  assert.equal(await readText(p.homePatch), ORIGINAL_HOME_PATCH);
  assert.equal(await readText(p.packageJson), ORIGINAL_PACKAGE_JSON);
});

/* ---------------------------------------------------------------- 启动恢复 fail-closed（t16：P0-10） */

/*
 * 启动分类/探测抛错时的 fail-closed 姿态必须是**单一来源**（core/startup-barrier.ts 的
 * FAIL_CLOSED_STARTUP）：只置「调度器不启动」而不同时置 SAFE MODE 属半套 fail-open
 * （审计 P0-10：宿主 catch 曾如此 → inspectStartup 抛错时 destructive 路由不被阻断）。
 * 本用例把该姿态钉成契约：包装器（StartupRecoveryController）与宿主 catch 必须一致消费它。
 * 放在 boot-rescue.test.ts 是因为它与「启动期故障兜底」同域，且是 t16 的 in-scope 测试文件。
 */
test('P0-10：启动恢复抛错的 fail-closed 姿态为单一来源，且包装器与之一致', async () => {
  assert.equal(FAIL_CLOSED_STARTUP.state.kind, 'RECOVERY_REQUIRED', '绝不默认 NORMAL');
  assert.equal(FAIL_CLOSED_STARTUP.safeModeRequired, true, '无法证明环境干净 → 必须置 SAFE MODE');
  assert.equal(FAIL_CLOSED_STARTUP.startSchedulers, false, 'destructive 调度器不得启动');

  let started = 0;
  const controller = new StartupRecoveryController(
    { async classify(): Promise<never> { throw new Error('inspectStartup boom'); } },
    { start: () => { started += 1; } },
  );
  const state = await controller.run();
  assert.deepEqual(state, FAIL_CLOSED_STARTUP.state, '包装器必须收敛到同一 fail-closed 状态');
  assert.equal(controller.startSchedulersIfAllowed(), false, '非 NORMAL 一律不启动调度器');
  assert.equal(started, 0);
});
