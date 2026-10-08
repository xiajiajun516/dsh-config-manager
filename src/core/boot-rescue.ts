/**
 * Boot Rescue（启动救援 / SAFE MODE 级兜底）。
 *
 * 背景：DSH 从 profile 树加载插件——
 *   - <homeDir>/profiles/<profile>/cordis.patch.yml（profile 补丁层）
 *   - <homeDir>/cordis.patch.yml（home 补丁层）
 *   - <homeDir>/profiles/<profile>/package.json（dsh.profile.bundles 清单）
 * 一旦装进坏插件或某个 bundle 不再可解析，DSH 可能整个启动失败、连恢复 UI 都进不去。
 * 本模块提供「救援模式」：
 *   进入 → 备份三处原件 → 裁剪不可解析的 bundles（disableUserBundles 时连同**全部非核心
 *        bundle** 一起剔除，见 restrictToRescueBundles）→ 把 profile patch 改写成宿主给定的
 *        最小内容 →（默认）把 home patch 置空 → 落状态文件；
 *   退出 → 先校验全部备份存在 → 逐个还原 → 删状态文件。
 *
 * 关键不变量（对应历史事故，勿破坏）：
 *   1. `dsh.profile.bundles` 必须**扁平**：`pkg.dsh.profile.bundles = kept`（string[]）。
 *      曾有实现写成 `[kept]`（双层包裹 `[[name]]`），DSH 加载器读到非字符串条目后再次启动失败。
 *   2. 幂等：同 home/profile 已激活时 enter 直接返回 already-active，一个字节都不改。
 *   3. 备份先于任何目标写入；备份失败（或原件读失败）→ backup-failed，目标文件保持原样。
 *   4. exit 先校验全部备份存在，任一缺失 → backup-missing 且不做任何还原。
 *   5. package.json 存在但不可解析（或根不是 JSON 对象）→ package-json-invalid，不做任何写入。
 *   6. bundles 无裁剪时**不重写** package.json（避免无意义的重序列化）。
 *   7. 状态里的 homeFingerprint 失效（换机器 / 重建 home / profile 变化）→ 状态自动降级 stale：
 *      enterRescueMode 允许覆盖旧痕迹重新进入；exitRescueMode 拒绝照 stale 状态还原（宁可不做）。
 *      指纹输入经 normalizeHomeDir 归一化——同一目录的不同写法（分隔符 / 尾分隔符 / 大小写）
 *      必须得到同一指纹，否则「自己判自己 stale」会让退出救援一个文件都不动。
 *
 * 分层：只依赖 node:* 与 ../utils（core 分层约束），零 DSH 运行时依赖，零适配器耦合。
 * 文案：本模块不产出用户可见文案——失败只给 `code`（+ 英文诊断 message，供日志/测试排查），
 * i18n 由调用方按 code 负责。
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { engineMsg } from './messages-core.ts';

/* ---------------------------------------------------------------- 常量 */

/** 默认备份目录（相对 homeDir 的 posix 路径；backupDir 缺省时使用） */
const DEFAULT_BACKUP_DIR_REL = 'dsh-config-manager/transactions/rescue-backups';

/** 状态文件名（位于 backupDir 下，唯一事实源；缺失/损坏即视为未激活） */
const STATE_FILE = 'state.json';

/** 备份文件名（位于 backupDir 下，固定命名；状态里记录其绝对路径） */
const BACKUP_PROFILE_PATCH = 'profile-patch.yml.orig';
const BACKUP_HOME_PATCH = 'home-patch.yml.orig';
const BACKUP_PROFILE_PACKAGE_JSON = 'profile-package.json.orig';

/** home patch 置空内容（空补丁层 = 不挂任何行） */
const EMPTY_PATCH = '[]\n';

/* ---------------------------------------------------------------- 路径 */

/** 三处被救援模式改写/备份的文件（相对 homeDir 的 posix 路径）。 */
export interface RescuePaths {
  profilePatch: string; // profiles/<profile>/cordis.patch.yml
  homePatch: string; // cordis.patch.yml
  profilePackageJson: string; // profiles/<profile>/package.json
}

/** 三处文件的 homeDir 相对 posix 路径（profile 名按字面拼接，不做清洗）。 */
export function rescuePaths(profile: string): RescuePaths {
  return {
    profilePatch: `profiles/${profile}/cordis.patch.yml`,
    homePatch: 'cordis.patch.yml',
    profilePackageJson: `profiles/${profile}/package.json`,
  };
}

/**
 * homeDir 归一化（指纹的输入键）。
 *
 * 为什么必须归一化：指纹原先直接哈希调用方传入的**原始字符串**，同一目录换个写法
 * （`C:/x/.dsh` vs `C:\x\.dsh`，或带尾分隔符 / `.` / `..`）就会算出不同指纹，于是
 * `exitRescueMode` 把**自己的**状态判成 stale 并拒绝还原——一个文件都不动，用户只能
 * 手改文件。从插件 UI 进出时两次都原样传 `host.homeDir` 所以看不出来；从 CLI / 脚本
 * 手动进出（各自拼路径）就会踩到。
 *
 * 规则：先 resolve 成绝对规范路径（消掉分隔符混用、`.` / `..`、尾分隔符），
 * win32 下再折叠大小写（该平台路径大小写不敏感）。
 * `platform` 可注入，使 win32 语义在非 win32 的 CI 上也能被验证。
 */
export function normalizeHomeDir(homeDir: string, platform: NodeJS.Platform = process.platform): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const resolved = impl.resolve(homeDir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** homeDir|profile 的 sha256 指纹（换机器/重建 home 后用于自动降级失效）。 */
export function homeFingerprint(homeDir: string, profile: string): string {
  return sha256Hex(`${normalizeHomeDir(homeDir)}|${profile}`);
}

/**
 * 历史指纹形态：直接哈希调用方传入的**原始字符串**（归一化修复前的算法）。
 * 仅用于向后兼容 —— 用户可能停留在「已进入救援」与「升级插件」之间；若只认新指纹，
 * 他们的状态会被误判为 stale 而无法退出救援（正是本 bug 的另一面）。
 */
function legacyHomeFingerprint(homeDir: string, profile: string): string {
  return sha256Hex(`${homeDir}|${profile}`);
}

/**
 * 记录的指纹是否属于「这个 home + profile」。
 *
 * 认两种形态：归一化后的新指纹，或原样字符串的历史指纹。安全性不受影响 ——
 * 历史指纹要求调用方传入与「进入救援时」完全相同的字符串，按定义就是同一个 home；
 * 换机器 / 重建 home 得到的是不同字符串，依旧判 stale 并拒绝还原。
 */
function fingerprintMatches(homeDir: string, profile: string, recorded: string): boolean {
  return recorded === homeFingerprint(homeDir, profile) || recorded === legacyHomeFingerprint(homeDir, profile);
}

/** posix 相对路径 → 宿主平台原生绝对路径（Windows 下逐段 join，避免混用分隔符）。 */
function absFromRel(homeDir: string, relPosix: string): string {
  return path.join(homeDir, ...relPosix.split('/'));
}

/** 默认备份目录：<homeDir>/dsh-config-manager/transactions/rescue-backups */
function defaultBackupDir(homeDir: string): string {
  return path.join(homeDir, ...DEFAULT_BACKUP_DIR_REL.split('/'));
}

/** 状态里记录的备份路径 → 绝对路径（兼容绝对/相对两种记录形态）。 */
function resolveBackupPath(backupDir: string, recorded: string): string {
  return path.isAbsolute(recorded) ? recorded : path.join(backupDir, ...recorded.split('/'));
}

/* ---------------------------------------------------------------- 小工具 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return isPlainObject(err) && err['code'] === 'ENOENT';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 读文件：不存在（ENOENT）→ null；其余 IO 错误上抛（调用方判为 backup-failed）。 */
async function readBytesOrNull(file: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** 文件是否存在（任何 stat 错误都按「不存在/不可用」处理，保守）。 */
async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 删除文件；文件不存在视为成功。 */
async function unlinkIfExists(file: string): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/** 非字符串条目的可读标签（诊断用，不参与逻辑）。 */
function describeEntry(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    /* 循环引用等 → 退化为 String */
  }
  try {
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

/* ---------------------------------------------------------------- bundles 裁剪 */

/** bundle 可解析性探测（由宿主注入，core 不做模块解析）。返回 true=可解析。 */
export type BundleResolver = (name: string) => Promise<boolean> | boolean;

export interface SafeBundlesResult {
  kept: string[]; // 可解析、保留
  pruned: { name: string; reason: string }[]; // 被剔除
}

/**
 * 过滤 dsh.profile.bundles：逐个用 resolve() 探测，不可解析的剔除。
 * - 非字符串条目 → pruned，reason='non-string'
 * - resolve 返回 false 或抛错 → pruned，reason='unresolved'
 * - 非数组/缺失 → kept=[], pruned=[], 且 inputWasArray=false
 * 纯函数（async），零 IO。只有严格 `true` 视为可解析（保守：undefined/其他返回值一律剔除）。
 */
export async function computeSafeBundles(
  bundles: unknown,
  resolve: BundleResolver,
): Promise<SafeBundlesResult & { inputWasArray: boolean }> {
  if (!Array.isArray(bundles)) {
    return { kept: [], pruned: [], inputWasArray: false };
  }
  const kept: string[] = [];
  const pruned: { name: string; reason: string }[] = [];
  for (const entry of bundles) {
    if (typeof entry !== 'string') {
      pruned.push({ name: describeEntry(entry), reason: 'non-string' });
      continue;
    }
    let resolvable = false;
    try {
      resolvable = (await resolve(entry)) === true;
    } catch {
      resolvable = false;
    }
    if (resolvable) kept.push(entry);
    else pruned.push({ name: entry, reason: 'unresolved' });
  }
  return { kept, pruned, inputWasArray: true };
}

/** 读取 pkg.dsh.profile.bundles（路径任一层非普通对象 → undefined）。 */
function readBundlesField(pkg: Record<string, unknown>): unknown {
  const dsh = pkg['dsh'];
  if (!isPlainObject(dsh)) return undefined;
  const profile = dsh['profile'];
  if (!isPlainObject(profile)) return undefined;
  return profile['bundles'];
}

/** 救援模式下必须保留的 bundle 前缀（DSH 核心；剪掉它们 DSH 自身都起不来）。 */
export const RESCUE_KEEP_BUNDLE_PREFIXES: readonly string[] = ['@deepseek-ai/'];

/**
 * 把「可解析的 bundle 清单」进一步收窄到**救援必需项**：DSH 核心（默认 `@deepseek-ai/*`）
 * 与救援插件自身；其余用户 bundle 一律剔除，reason='rescue-disabled'。
 *
 * 为什么需要它：只中和 patch 层 + 剪掉「不可解析」的 bundle，治的是「patch/插件配置把启动
 * 搞挂了」。bundle 只要能解析就会照旧挂载，所以「插件代码自己把 DSH 搞挂」这一类根本救不了。
 * 收窄 bundle 才是「临时禁用除本插件外的全部用户插件」的实现（退出仍按备份逐字节还原）。
 * 纯函数，零 IO。
 */
export function restrictToRescueBundles(
  kept: readonly string[],
  selfPackageName: string,
  keepPrefixes: readonly string[] = RESCUE_KEEP_BUNDLE_PREFIXES,
): SafeBundlesResult {
  const outKept: string[] = [];
  const pruned: { name: string; reason: string }[] = [];
  for (const name of kept) {
    if (name === selfPackageName || keepPrefixes.some((prefix) => name.startsWith(prefix))) outKept.push(name);
    else pruned.push({ name, reason: 'rescue-disabled' });
  }
  return { kept: outKept, pruned };
}

/**
 * 写入 pkg.dsh.profile.bundles（**扁平** string[]，绝不做 `[kept]` 二次包裹）。
 * 仅当 dsh / dsh.profile 均为普通对象时成功；返回是否已写入。
 */
function writeBundlesField(pkg: Record<string, unknown>, bundles: string[]): boolean {
  const dsh = pkg['dsh'];
  if (!isPlainObject(dsh)) return false;
  const profile = dsh['profile'];
  if (!isPlainObject(profile)) return false;
  profile['bundles'] = bundles;
  return true;
}

/**
 * 从 pkg.dependencies 里就地摘掉这些包名（不存在/非普通对象 → 零改动）。
 *
 * 为什么救援模式必须做这一步：**「声明 dsh.bundle.patch 的依赖必须出现在 dsh.profile.bundles」**
 * 是本插件 reconcileBundles 与 DSH 官方 `dsh plugin` reconcilePlugins 的共同规则。只把包从
 * bundles 里移出、却把依赖行留在 package.json，下一次 reconcile 就会用依赖行把它们**原样加回**
 * bundles —— 而 reconcile 会在每次「读插件清单」时跑（导出预览、自动快照的 plugins 分区、
 * 插件页都会触发）。真机实测：救援写入后约 1.5 秒 bundles 就被改回 5 条，重启后用户插件照常
 * 挂载，救援名存实亡。摘掉依赖行让 manifest 自洽（插件确实只剩核心 + 自身），任何 reconcile
 * 都无从加回；包本身不卸载（node_modules 原样），退出时整份 package.json 从备份逐字节还原。
 */
function stripDependencies(pkg: Record<string, unknown>, names: readonly string[]): void {
  const deps = pkg['dependencies'];
  if (!isPlainObject(deps)) return;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(deps, name)) delete deps[name];
  }
}

/* ---------------------------------------------------------------- 状态 */

export interface RescueState {
  active: true;
  enteredAt: string;
  profile: string;
  /** homeDir+profile 的指纹（换机器/重建 home 后用于自动降级失效） */
  homeFingerprint: string;
  /**
   * 备份文件绝对路径；null = 原件不存在、未产生备份。
   * profilePatch 例外：类型为 string，原件不存在时取 ''（配合 profilePatchWasAbsent=true 判读）。
   */
  backup: { profilePatch: string; homePatch: string | null; profilePackageJson: string | null };
  prunedBundles: { name: string; reason: string }[];
  /** 进入时 profile patch 是否原本不存在（退出时需删除而非还原） */
  profilePatchWasAbsent: boolean;
}

export type RescueEnterResult =
  | { ok: true; state: RescueState }
  | { ok: false; code: 'already-active' | 'backup-failed' | 'package-json-invalid' | 'write-failed'; message: string };

export type RescueExitResult =
  | { ok: true; restored: string[] }
  | { ok: false; code: 'not-active' | 'backup-missing' | 'restore-failed'; message: string };

export interface RescueStatus {
  active: boolean;
  /** 状态存在但 homeFingerprint 不匹配 → 已自动降级，不激活 */
  stale: boolean;
  state: RescueState | null;
}

/** `string | null` 严格解析；其他类型 → undefined（判为损坏）。 */
function asStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** prunedBundles 宽松解析（形状不符的条目丢弃，不因它把整个状态判为损坏）。 */
function parsePrunedBundles(value: unknown): { name: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { name: string; reason: string }[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const name = item['name'];
    const reason = item['reason'];
    if (typeof name === 'string' && typeof reason === 'string') out.push({ name, reason });
  }
  return out;
}

/** 状态文件文本 → RescueState；缺失/损坏/形状不符 → null。 */
function parseRescueState(text: string): RescueState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  if (raw['active'] !== true) return null;
  const enteredAt = raw['enteredAt'];
  const profile = raw['profile'];
  const fingerprint = raw['homeFingerprint'];
  if (typeof enteredAt !== 'string' || typeof profile !== 'string' || typeof fingerprint !== 'string') return null;
  const backup = raw['backup'];
  if (!isPlainObject(backup)) return null;
  const backupProfilePatch = asStringOrNull(backup['profilePatch']);
  const backupHomePatch = asStringOrNull(backup['homePatch']);
  const backupPackageJson = asStringOrNull(backup['profilePackageJson']);
  if (typeof backupProfilePatch !== 'string' || backupHomePatch === undefined || backupPackageJson === undefined) return null;
  return {
    active: true,
    enteredAt,
    profile,
    homeFingerprint: fingerprint,
    backup: {
      profilePatch: backupProfilePatch,
      homePatch: backupHomePatch,
      profilePackageJson: backupPackageJson,
    },
    prunedBundles: parsePrunedBundles(raw['prunedBundles']),
    profilePatchWasAbsent: raw['profilePatchWasAbsent'] === true,
  };
}

/** 读状态文件（缺失/损坏 → null）。 */
async function readRescueState(backupDir: string): Promise<RescueState | null> {
  const statePath = path.join(backupDir, STATE_FILE);
  let text: string;
  try {
    text = await fs.readFile(statePath, 'utf8');
  } catch {
    return null;
  }
  return parseRescueState(text);
}

/**
 * 救援插件自身的挂载描述。
 * - `packageName` 与 profile package.json 的 `dsh.profile.bundles` 条目比对：
 *   命中 → 本插件由 bundle 层挂载，patch 层不得再插入同 id 行（否则 loader 报重复 id）。
 * - `row` 仅在包不在 bundles 时写入（手工 patch 层挂载的场景）。
 */
export interface RescueSelfMount {
  packageName: string;
  row: { id: string; name: string };
}

/** 救援模式 profile patch 的头注释（说明本文件被谁接管、bundle 层的实际状态）。 */
const RESCUE_PATCH_HEADER_LINES = [
  '# dsh-config-manager RESCUE MODE',
  engineMsg('core.bootRescue.patchTakenOver'),
];

/** 救援模式 profile patch 的头注释（按 bundle 处理方式给出准确说明，不得夸大能力）。 */
function rescuePatchHeader(bundlesDisabled: boolean): string {
  const note = bundlesDisabled
    ? engineMsg('core.bootRescue.bundlesNarrowed')
    : engineMsg('core.bootRescue.bundlesNote');
  return [...RESCUE_PATCH_HEADER_LINES, note, ''].join('\n');
}

/** 单引号 YAML 标量（按 YAML 规则把 `'` 转义为 `''`）。 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 生成救援期间 profile patch 内容。
 *
 * 关键不变量：**本插件已由 bundle 层挂载时，patch 层绝不能再写一行挂载自己**。
 * bundle 层先于 profile patch 层应用，重复 entry id 会让 loader 抛
 * `duplicate loader entry id: <id>`，整棵插件树加载失败 → 救援模式反而把自己锁死
 * （DSH 起不来，UI 里的「退出救援」也点不到）。因此这种情况只写空列表。
 */
function rescuePatchText(mount: RescueSelfMount, alreadyInBundles: boolean, bundlesDisabled: boolean): string {
  const header = rescuePatchHeader(bundlesDisabled);
  if (alreadyInBundles) return `${header}[]\n`;
  const row = [
    '- insert:',
    `    - id: ${yamlScalar(mount.row.id)}`,
    `      name: ${yamlScalar(mount.row.name)}`,
    '',
  ].join('\n');
  return `${header}${row}`;
}

/* ---------------------------------------------------------------- 进入救援 */

export interface RescueEnterOptions {
  homeDir: string;
  profile: string;
  /** 救援插件自身的挂载描述（宿主传入；决定最小 patch 是否需要显式插入本插件行）。 */
  rescueMount: RescueSelfMount;
  /** 是否同时把 home patch 置空（写 '[]\n'）。缺省 true。 */
  neutralizeHomePatch?: boolean;
  /** bundle 解析器；缺省 = 不裁剪任何 bundle（保守）。 */
  resolveBundle?: BundleResolver;
  /**
   * 是否连同 bundle 一起收窄（缺省 false = 只剪「不可解析」的）。
   * true → 在可解析的基础上再保留 DSH 核心（keepBundlePrefixes）与救援插件自身，
   * 其余用户 bundle 全部剔除——这才是「禁用其它插件」，见 restrictToRescueBundles。
   */
  disableUserBundles?: boolean;
  /** disableUserBundles=true 时的保留前缀（缺省 RESCUE_KEEP_BUNDLE_PREFIXES） */
  keepBundlePrefixes?: readonly string[];
  /** 备份目录（缺省 <homeDir>/dsh-config-manager/transactions/rescue-backups） */
  backupDir?: string;
  now?: () => Date;
}

/** 进入救援阶段的目标写入计划（回滚复用同一组原件字节）。 */
interface OriginalSet {
  targetProfilePatch: string;
  targetHomePatch: string;
  targetPackageJson: string;
  origProfilePatch: Uint8Array | null;
  origHomePatch: Uint8Array | null;
  origPackageJson: Uint8Array | null;
}

/** 尽力回滚已改写/已创建的目标；返回失败清单（空 = 全部回滚成功）。 */
async function rollbackTargets(
  originals: OriginalSet,
  opts: { wrotePackageJson: boolean; wroteHomePatch: boolean },
): Promise<string[]> {
  const failures: string[] = [];
  const step = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failures.push(`${label}: ${errorText(err)}`);
    }
  };
  await step('profile-patch', async () => {
    if (originals.origProfilePatch !== null) await atomicWriteFile(originals.targetProfilePatch, originals.origProfilePatch);
    else await unlinkIfExists(originals.targetProfilePatch);
  });
  if (opts.wrotePackageJson && originals.origPackageJson !== null) {
    await step('package-json', async () => {
      await atomicWriteFile(originals.targetPackageJson, originals.origPackageJson as Uint8Array);
    });
  }
  if (opts.wroteHomePatch) {
    await step('home-patch', async () => {
      if (originals.origHomePatch !== null) await atomicWriteFile(originals.targetHomePatch, originals.origHomePatch);
      else await unlinkIfExists(originals.targetHomePatch);
    });
  }
  return failures;
}

/** 进入救援模式：备份三处文件 → 裁剪 bundles → 写最小 profile patch → 可能置空 home patch → 写状态文件。 */
export async function enterRescueMode(opts: RescueEnterOptions): Promise<RescueEnterResult> {
  const homeDir = opts.homeDir;
  const profile = opts.profile;
  const backupDir = opts.backupDir ?? defaultBackupDir(homeDir);
  const fingerprint = homeFingerprint(homeDir, profile);
  const neutralizeHome = opts.neutralizeHomePatch !== false;
  // 缺省保守：不注入解析器时视所有字符串名字为可解析（只剔除非字符串条目）
  const resolveBundle: BundleResolver = opts.resolveBundle ?? (() => true);
  const now = opts.now ?? (() => new Date());

  const rel = rescuePaths(profile);
  const targetProfilePatch = absFromRel(homeDir, rel.profilePatch);
  const targetHomePatch = absFromRel(homeDir, rel.homePatch);
  const targetPackageJson = absFromRel(homeDir, rel.profilePackageJson);
  const statePath = path.join(backupDir, STATE_FILE);

  // —— 1. 幂等：同 home/profile 已激活 → 立刻返回，一个字节都不动 ——
  const current = await readRescueState(backupDir);
  if (current !== null && fingerprintMatches(homeDir, profile, current.homeFingerprint)) {
    return {
      ok: false,
      code: 'already-active',
      message: `rescue mode is already active for ${rel.profilePatch} (enteredAt=${current.enteredAt}); nothing was modified`,
    };
  }
  // 指纹不匹配（换机器/重建 home/profile 变化）或状态损坏 → 视为失效残留，允许覆盖重进

  // —— 2. 读原件（读失败 → backup-failed；备份先于任何目标写入） ——
  let origProfilePatch: Uint8Array | null;
  let origHomePatch: Uint8Array | null;
  let origPackageJson: Uint8Array | null;
  try {
    origProfilePatch = await readBytesOrNull(targetProfilePatch);
    origHomePatch = await readBytesOrNull(targetHomePatch);
    origPackageJson = await readBytesOrNull(targetPackageJson);
  } catch (err) {
    return { ok: false, code: 'backup-failed', message: `cannot read originals for backup: ${errorText(err)}` };
  }

  // —— 3. 校验 + 计算 package.json 新内容（纯计算，不落盘；非法 → 不做任何写入） ——
  let prunedBundles: { name: string; reason: string }[] = [];
  let nextPackageJsonText: string | null = null;
  // 本插件是否已由 bundle 层挂载（决定 patch 层要不要写挂载行；见 rescuePatchText 注释）
  let selfAlreadyBundled = false;
  if (origPackageJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(origPackageJson));
    } catch (err) {
      return {
        ok: false,
        code: 'package-json-invalid',
        message: `${rel.profilePackageJson} is not valid JSON, left untouched: ${errorText(err)}`,
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        code: 'package-json-invalid',
        message: `${rel.profilePackageJson} does not contain a JSON object root, left untouched`,
      };
    }
    // 用「裁剪前」的 bundles 判定：本插件即使因不可解析被裁掉，也不该再由 patch 层重复挂载
    const rawBundles = readBundlesField(parsed);
    selfAlreadyBundled = Array.isArray(rawBundles) && rawBundles.includes(opts.rescueMount.packageName);
    const safe = await computeSafeBundles(rawBundles, resolveBundle);
    // 救援模式（disableUserBundles）：在「可解析」之上再收窄到核心 + 自身。
    // 不做这一步的话，bundle 层会把用户插件照旧挂载回来，「禁用其它插件」名不副实。
    const narrowed = opts.disableUserBundles === true
      ? restrictToRescueBundles(safe.kept, opts.rescueMount.packageName, opts.keepBundlePrefixes ?? RESCUE_KEEP_BUNDLE_PREFIXES)
      : { kept: safe.kept, pruned: [] as { name: string; reason: string }[] };
    const finalPruned = [...safe.pruned, ...narrowed.pruned];
    // 无裁剪 → 不重写（保持原字节/原格式）；有裁剪 → 扁平写回 kept（绝无 [kept] 二次包裹）
    if (finalPruned.length > 0 && writeBundlesField(parsed, narrowed.kept)) {
      prunedBundles = finalPruned;
      // 同一份写入里把被禁用的包从 dependencies 摘掉（见 stripDependencies：否则任何
      // reconcile 都会按依赖行把它们加回 bundles，救援当场失效）。仅摘 narrowed（收窄禁用）
      // 的那批；safe.pruned（解析不到）本来就不会被 reconcile 加回。
      stripDependencies(parsed, narrowed.pruned.map((entry) => entry.name));
      nextPackageJsonText = `${JSON.stringify(parsed, null, 2)}\n`;
    }
  }

  // —— 4. 备份（任何目标写入之前；失败 → backup-failed，原件保持原样） ——
  const backup: RescueState['backup'] = {
    profilePatch: origProfilePatch === null ? '' : path.join(backupDir, BACKUP_PROFILE_PATCH),
    homePatch: origHomePatch === null ? null : path.join(backupDir, BACKUP_HOME_PATCH),
    profilePackageJson: origPackageJson === null ? null : path.join(backupDir, BACKUP_PROFILE_PACKAGE_JSON),
  };
  try {
    await fs.mkdir(backupDir, { recursive: true });
    if (origProfilePatch !== null) await atomicWriteFile(path.join(backupDir, BACKUP_PROFILE_PATCH), origProfilePatch);
    if (origHomePatch !== null) await atomicWriteFile(path.join(backupDir, BACKUP_HOME_PATCH), origHomePatch);
    if (origPackageJson !== null) await atomicWriteFile(path.join(backupDir, BACKUP_PROFILE_PACKAGE_JSON), origPackageJson);
  } catch (err) {
    return { ok: false, code: 'backup-failed', message: `backup failed, originals untouched: ${errorText(err)}` };
  }

  const state: RescueState = {
    active: true,
    enteredAt: now().toISOString(),
    profile,
    homeFingerprint: fingerprint,
    backup,
    prunedBundles,
    profilePatchWasAbsent: origProfilePatch === null,
  };
  const originals: OriginalSet = {
    targetProfilePatch,
    targetHomePatch,
    targetPackageJson,
    origProfilePatch,
    origHomePatch,
    origPackageJson,
  };
  const wrotePackageJson = nextPackageJsonText !== null;

  // —— 5. 写目标：profile patch → package.json → home patch → 状态文件 ——
  //    任一步失败 → 尽力回滚已改动的目标（状态文件最后写，失败时不会被留下）
  try {
    await atomicWriteFile(targetProfilePatch, rescuePatchText(opts.rescueMount, selfAlreadyBundled, opts.disableUserBundles === true));
    if (nextPackageJsonText !== null) await atomicWriteFile(targetPackageJson, nextPackageJsonText);
    if (neutralizeHome) await atomicWriteFile(targetHomePatch, EMPTY_PATCH);
    await atomicWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    const rollbackFailures = await rollbackTargets(originals, { wrotePackageJson, wroteHomePatch: neutralizeHome });
    const rollbackNote = rollbackFailures.length === 0 ? 'rollback ok' : `rollback incomplete (${rollbackFailures.join('; ')})`;
    return { ok: false, code: 'write-failed', message: `write failed, ${rollbackNote}: ${errorText(err)}` };
  }

  return { ok: true, state };
}

/* ---------------------------------------------------------------- 退出救援 */

/** 退出步骤：restore = 从备份还原；delete = 进入时不存在（本次创建）→ 删除 */
interface ExitStep {
  rel: string;
  target: string;
  action: 'restore' | 'delete';
  backup: string | null;
}

/** 退出救援模式：先校验全部备份存在，再逐个还原；状态文件删除。 */
export async function exitRescueMode(opts: { homeDir: string; backupDir?: string }): Promise<RescueExitResult> {
  const homeDir = opts.homeDir;
  const backupDir = opts.backupDir ?? defaultBackupDir(homeDir);
  const statePath = path.join(backupDir, STATE_FILE);

  let text: string;
  try {
    text = await fs.readFile(statePath, 'utf8');
  } catch {
    return { ok: false, code: 'not-active', message: `no rescue state at ${statePath}` };
  }
  const state = parseRescueState(text);
  if (state === null) {
    return { ok: false, code: 'not-active', message: `rescue state is corrupt/unreadable: ${statePath}` };
  }
  // 指纹不匹配 = 别的 home/profile 的残留状态：拒绝按它改写本 home 的文件（宁可不做）
  if (!fingerprintMatches(homeDir, state.profile, state.homeFingerprint)) {
    return {
      ok: false,
      code: 'not-active',
      message: `rescue state is stale (homeFingerprint mismatch), refusing to touch files: ${statePath}`,
    };
  }

  const rel = rescuePaths(state.profile);
  const targetProfilePatch = absFromRel(homeDir, rel.profilePatch);
  const targetHomePatch = absFromRel(homeDir, rel.homePatch);
  const targetPackageJson = absFromRel(homeDir, rel.profilePackageJson);

  const plan: ExitStep[] = [];
  // profile patch：进入时不存在 → 删除本次创建的；否则从备份还原
  if (state.profilePatchWasAbsent) {
    plan.push({ rel: rel.profilePatch, target: targetProfilePatch, action: 'delete', backup: null });
  } else {
    const backup = state.backup.profilePatch === '' ? null : resolveBackupPath(backupDir, state.backup.profilePatch);
    plan.push({ rel: rel.profilePatch, target: targetProfilePatch, action: 'restore', backup });
  }
  // home patch：原件不存在 → 删除本次置空创建的
  if (state.backup.homePatch === null) {
    plan.push({ rel: rel.homePatch, target: targetHomePatch, action: 'delete', backup: null });
  } else {
    plan.push({ rel: rel.homePatch, target: targetHomePatch, action: 'restore', backup: resolveBackupPath(backupDir, state.backup.homePatch) });
  }
  // package.json：备份为 null = 原件不存在，且救援模式从不创建它 → 无需动作
  if (state.backup.profilePackageJson !== null) {
    plan.push({
      rel: rel.profilePackageJson,
      target: targetPackageJson,
      action: 'restore',
      backup: resolveBackupPath(backupDir, state.backup.profilePackageJson),
    });
  }

  // —— 1. 先校验全部备份存在：任一缺失 → 一个文件都不动 ——
  for (const step of plan) {
    if (step.action !== 'restore') continue;
    const backup = step.backup;
    if (backup === null || backup === '' || !(await fileExists(backup))) {
      return { ok: false, code: 'backup-missing', message: `missing rescue backup for ${step.rel}: ${backup ?? '<none>'}` };
    }
  }

  // —— 2. 逐个还原 / 删除，最后删状态文件（中途崩溃仍保留状态，可重试还原） ——
  const restored: string[] = [];
  try {
    for (const step of plan) {
      if (step.action === 'restore') {
        const backup = step.backup;
        if (backup === null) throw new Error(`missing backup path for ${step.rel}`);
        const bytes = await fs.readFile(backup);
        await atomicWriteFile(step.target, bytes);
      } else {
        await unlinkIfExists(step.target);
      }
      restored.push(step.rel);
    }
    await fs.unlink(statePath);
  } catch (err) {
    return {
      ok: false,
      code: 'restore-failed',
      message: `restore failed after ${restored.length} step(s): ${errorText(err)}`,
    };
  }
  return { ok: true, restored };
}

/* ---------------------------------------------------------------- 状态查询 */

/**
 * 同步版救援状态探测：状态文件存在且 homeDir+profile 指纹匹配 → true。
 *
 * 为什么需要同步版：本插件的 `reconcileBundles`（plugin-cli，同步路径）必须能在**写盘之前**
 * 判断「现在处于救援模式吗」—— 救援期间它一旦把声明 `dsh.bundle.patch` 的依赖加回
 * `dsh.profile.bundles`，救援就被静默撤销（详见 boot-rescue 顶部与 stripDependencies 注释）。
 * 语义与 {@link rescueModeStatus} 的 `active` 一致：stale（换机/重建 home）不算激活。
 */
export function isRescueActiveSync(opts: { homeDir: string; profile: string; backupDir?: string }): boolean {
  const backupDir = opts.backupDir ?? defaultBackupDir(opts.homeDir);
  let text: string;
  try {
    text = readFileSync(path.join(backupDir, STATE_FILE), 'utf8');
  } catch {
    return false;
  }
  const state = parseRescueState(text);
  return state !== null && fingerprintMatches(opts.homeDir, opts.profile, state.homeFingerprint);
}

/**
 * 救援是否已在**当前进程**生效：进程启动时刻晚于（或等于）进入救援的时刻 → 本次启动就是救援启动。
 *
 * 为什么需要它：横幅文案不能永远写「请重启 DSH 使其生效」—— 用户重启之后那句话还在（真机反馈），
 * 而实际上救援已经生效。宿主传入进程启动时刻（`Date.now() - process.uptime()*1000`），core 只做判据
 * （保持纯函数、可单测，不依赖 process）。enteredAt 不可解析（损坏状态）→ false（保守：仍提示重启）。
 */
export function rescueAppliedInThisProcess(enteredAt: string, processStartedAtMs: number): boolean {
  const entered = Date.parse(enteredAt);
  return Number.isFinite(entered) && entered <= processStartedAtMs;
}

/** 读状态；指纹不匹配时返回 { active:false, stale:true, state }。损坏/缺失 → { active:false, stale:false, state:null }。 */
export async function rescueModeStatus(opts: { homeDir: string; profile: string; backupDir?: string }): Promise<RescueStatus> {
  const backupDir = opts.backupDir ?? defaultBackupDir(opts.homeDir);
  const state = await readRescueState(backupDir);
  if (state === null) return { active: false, stale: false, state: null };
  if (!fingerprintMatches(opts.homeDir, opts.profile, state.homeFingerprint)) {
    return { active: false, stale: true, state };
  }
  return { active: true, stale: false, state };
}
