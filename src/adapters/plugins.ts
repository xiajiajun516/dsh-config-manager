/**
 * plugins 分区 adapter（设计 §3.3/§8）：
 * 数据源 = ctx.plugins.listInstalled()（插件清单）+ 用户 patch 层（profile cordis.patch.yml）。
 *
 * 安全不变量：绝不打包插件二进制；导入走 DSH 官方机制（dsh plugin CLI → needsRestart 提示）。
 * patch 行导入（用户自定义行：启用/禁用/插入）写回 cordis.patch.yml，同样 needsRestart。
 *
 * T1（本地源插件迁移）：`link:` / `file:` 来源的插件指向本机路径，换机后必然不可达
 * （曾导致插件被静默丢失）。导出时经注入的 `localPack` 执行 `npm pack`，把 tarball 作为
 * 文件条目随分区进入 ZIP（落在 `plugin-files/local-plugins/` 前缀下，复用既有文件类分区通道，
 * **不新增分区 id**）；导入时把 spec 重写为 `file:<解包后的绝对路径>` 再交给官方安装通道。
 */
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256Hex } from '../utils/hashing.ts';
import { isBundlesOnlyEntry, mergeBundleDeclaration, pluginInstallTarget, resolveProcessProfileName } from '../core/plugin-cli.ts';
import { classifyPluginSpec, LOCAL_PLUGIN_DIR, resolveLocalPluginPath } from '../core/local-plugin-pack.ts';
import type { PackLocalPluginsResult } from '../core/local-plugin-pack.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { engineMsg } from './messages.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { isPathSafe, normalizePath } from '../utils/paths.ts';
import { isENOENT } from '../utils/guards.ts';
import { PLUGIN_PATCH_REF_PREFIX, PLUGIN_PROFILE_MANIFEST_REF } from '../core/backup.ts';
import { readEffectivePatchLines, resolveWriteLayer, USER_PATCH_FILE } from '../core/patch-layers.ts';
import {
  parsePnpmPatchedDependencies, restorePnpmMachinePaths, sanitizePnpmWorkspacePatches, stripPnpmMachinePaths,
} from './pnpm-workspace.ts';
import type { LocalPluginTarball, PatchLine, PluginEntry, PluginsSection, PnpmPatchFile } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, PluginAreaRef, SectionPreview, ValidationResult,
} from '../core/types.ts';
import { BUILTIN_PLUGIN_DATA_SOURCES, areasForSection } from '../core/plugin-data-registry.ts';
import type { PluginDataSource } from '../core/plugin-data-registry.ts';
import { declaredProfileName, scanDeclaredDataSources } from './plugin-data-declared.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';

/**
 * 用户（home）patch 层路径 —— 定义已移到 `core/patch-layers.ts`（issue #71：patch 有 home /
 * profile 两层，层身份属于引擎知识，不属于某个 adapter）。此处 re-export 保持既有 import 面。
 */
export { USER_PATCH_FILE };

/**
 * 本地源插件打包钩子（由宿主注入，见 src/index.ts createAdapters）。
 * 返回打包结果（含字节与重写后的 spec）；不注入 = 不做本地源打包（保持旧行为）。
 */
export type LocalPluginPackHook = (
  plugins: PluginEntry[],
  /** 结构化类型：HostContext 满足它（core 侧刻意不 import adapters 的 HostContext 类型） */
  ctx: Pick<HostContext, 'profile' | 'profileDir'>,
) => Promise<PackLocalPluginsResult>;

/** tarball 字节 → base64（零依赖，避免 Buffer 在浏览器侧类型问题） */
function bytesToBase64(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(data).toString('base64');
  let binary = '';
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 → 字节（导入端解包用） */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 本地插件 tarball 解包到 homeDir 内的固定缓存目录（相对 $DSH_HOME）。 */
export const LOCAL_TARBALL_CACHE_REL = 'dsh-config-manager/local-plugins';

/** 按包名取出备份内的 tarball 条目（不存在返回 undefined）。 */
function tarballOf(data: PluginsSection, pkgName: string): LocalPluginTarball | undefined {
  return data.localTarballs?.find((t) => t.packageName === pkgName);
}

/** 归档内相对路径 → 缓存目录下的安全文件名（拒绝任何路径穿越）。 */
export function localTarballCacheName(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? '';
  if (base === '' || base.includes('\\') || base === '.' || base === '..') {
    throw new Error(engineMsg('adapter.tarballRelPathInvalid', { path: relativePath }));
  }
  return base;
}

/**
 * 把备份内的 tarball 写入 `$DSH_HOME/dsh-config-manager/local-plugins/<name>`，
 * 返回**绝对路径**（供 `file:` spec 使用）。
 *
 * 为什么写进 $DSH_HOME 内：`ctx.target.fs` 是「限定在 home 根内」的门面
 * （`DshFileSystemFacade.abs()` 对根外路径抛 fsPathEscape），写 homeDir 外会被拒。
 * 该目录同时落在既有保留区内（`dsh-config-manager/`），随 self 分区语义一致。
 */
async function writeLocalTarball(
  ctx: ImportContext,
  tarball: LocalPluginTarball,
): Promise<string> {
  const name = localTarballCacheName(tarball.relativePath);
  const rel = `${LOCAL_TARBALL_CACHE_REL}/${name}`;
  await ctx.target.fs.writeFile(rel, base64ToBytes(tarball.base64));
  // `file:` spec 一律用正斜杠（pnpm 跨平台接受正斜杠；反斜杠在部分版本需转义）
  const abs = `${ctx.target.homeDir.replace(/[\\/]+$/, '')}/${rel}`;
  return abs.replace(/\\/g, '/');
}




/** profile 目录相对 $DSH_HOME 的路径（patches/ 与 pnpm-workspace.yaml 都挂在这里）。 */
export const PNPM_PROFILE_DIR = (profile: string | undefined): string =>
  `profiles/${profile !== undefined && profile !== '' ? profile : 'web'}`;

/** pnpm-workspace.yaml 相对 $DSH_HOME 的路径（plugins 分区内按「插件安装配置」管理）。 */
export const PNPM_WORKSPACE_REL = (profile: string | undefined): string =>
  `${PNPM_PROFILE_DIR(profile)}/pnpm-workspace.yaml`;

/**
 * pnpm 配置可移植净化的可见文案（导出告警 / 导入计划项 detail / 写入结果三处**同一句**，
 * 不另造通道）：来源机的机器路径键被剥离、本机原有的机器路径键被保留，都必须说出来。
 */
function machinePathNotes(msg: MsgFunc, stripped: string[], restored: string[]): string[] {
  const notes: string[] = [];
  if (stripped.length > 0) {
    notes.push(msg('adapter.pwMachinePathStripped', { count: String(stripped.length), keys: stripped.join(', ') }));
  }
  if (restored.length > 0) {
    notes.push(msg('adapter.pwMachinePathKept', { count: String(restored.length), keys: restored.join(', ') }));
  }
  return notes;
}

/** 单个 patch 文件随备份迁移的体积上限（issue #35；patch 是纯文本，超过说明放错了东西）。 */
export const MAX_PATCH_FILE_BYTES = 2 * 1024 * 1024;

/** patch 行 raw 是否由其他 adapter 管理（mcp-client 行 / systemPrompt / planMode 行）。
 * 这些行的导入归 mcp.ts / prompts.ts，plugins 分区只负责普通用户行（启用/禁用/插入插件等）。 */
function isManagedElsewhere(raw: unknown): boolean {
  for (const entry of entriesOfRaw(raw)) {
    const config = entry.config;
    if (config === null || typeof config !== 'object') continue;
    const c = config as Record<string, unknown>;
    if (typeof c['serverName'] === 'string' && c['serverName'] !== '') return true;
    if (c['systemPrompt'] !== undefined) return true;
    if (c['planMode'] !== undefined) return true;
  }
  return false;
}

/** patch 行 → entry 列表（兼容单行与 insert 块；与 mcp/prompts 共用形态） */
function entriesOfRaw(raw: unknown): { config?: unknown }[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['insert'])) {
    return obj['insert']
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => e as { config?: unknown });
  }
  if (obj['id'] !== undefined || obj['name'] !== undefined) {
    return [obj as { config?: unknown }];
  }
  return [];
}

/**
 * 预览路径测到的本地源插件体积（`preview()` 写入，`listUnits()` 读取）。
 *
 * 为什么用 WeakMap 而不是给 `PluginsSection` 加字段：`localTarballs` 是备份格式的一部分
 * （schema 校验、市场安全防线都在看它），而预览产物里本就没有 tarball 字节；把「只读预览测到的
 * 体积」混进载荷只会让「预览说的」与「导出做的」更难分辨。挂在载荷对象上则随对象一起回收，
 * 导出产物（真实 base64）走另一条分支，行为逐字不变。
 */
const previewTarballBytes = new WeakMap<object, Map<string, number>>();

/**
 * 「插件包名 → 它声明的数据区域」映射（只有 \`plugin:<包名>\` 单元用；导出选择器「按插件看」的树骨架）。
 *
 * 为什么挂 WeakMap 而不是给 PluginsSection 加字段：这是**展示用旁路信息** —— 既不是备份格式的
 * 一部分（schema 校验与市场防线都不该看见它），也与「导出真的带什么」无关；挂在载荷对象上随对象
 * 一起回收，载荷本身逐字节不变（与 previewTarballBytes 同一套理由）。
 */
const relatedAreasByData = new WeakMap<object, Map<string, PluginAreaRef[]>>();

/** 内置来源 + 自述声明的扫描缓存（TTL 内的同一 home/profile 只扫一次；/export-preview 一趟会问两次） */
const declaredSourcesMemo: { key: string; at: number; sources: readonly PluginDataSource[] } =
  { key: '', at: 0, sources: [] };
const DECLARED_MEMO_TTL_MS = 5_000;

/**
 * 本机可归属的插件数据来源 = 内置来源表 + 已安装插件自述声明。
 *
 * 缓存键必须带 homeDir + profile：同一台机器换 profile 就是另一批已安装插件，拿旧声明画树
 * 会让用户看到不属于当前 profile 的数据区域。
 */
async function pluginDataSources(ctx: HostContext): Promise<readonly PluginDataSource[]> {
  const key = ctx.homeDir + '|' + declaredProfileName(ctx.profile);
  const now = Date.now();
  if (declaredSourcesMemo.key === key && now - declaredSourcesMemo.at < DECLARED_MEMO_TTL_MS) {
    return declaredSourcesMemo.sources;
  }
  const sources = [...BUILTIN_PLUGIN_DATA_SOURCES, ...await scanDeclaredDataSources(ctx)];
  declaredSourcesMemo.key = key;
  declaredSourcesMemo.at = now;
  declaredSourcesMemo.sources = sources;
  return sources;
}

/**
 * 包名 → 该插件的数据区域引用。
 *
 * 口径与 pluginData / pluginAssets 的收集面**同源**（同一个 areasForSection）：role=config 进
 * pluginData、role=assets 进 pluginAssets；role=cache 的区域不属于任何分区，因此**绝不进树**
 * （缓存是可再生产物，列出来只会诱导用户把它带走）。
 *
 * 只产出「注册表说它应该在哪儿」，不代表磁盘上真有 —— 界面必须把两者分开渲染。
 */
async function relatedAreasOf(ctx: HostContext): Promise<Map<string, PluginAreaRef[]>> {
  const sources = await pluginDataSources(ctx);
  const map = new Map<string, PluginAreaRef[]>();
  for (const source of sources) {
    const refs: PluginAreaRef[] = [];
    for (const section of ['pluginData', 'pluginAssets'] as const) {
      for (const entry of areasForSection([source], section)) {
        refs.push({ section, relPath: entry.area.relPath, role: entry.area.role === 'assets' ? 'assets' : 'config' });
      }
    }
    if (refs.length === 0) continue;
    for (const pkg of source.packages) {
      const cur = map.get(pkg);
      if (cur === undefined) map.set(pkg, [...refs]);
      else cur.push(...refs);
    }
  }
  return map;
}

/**
 * 零 spawn 推导本地源插件的体积（预览专用）。
 *
 * 两条路径，都是**只读度量**、都不 spawn 打包进程：
 *  - `file:` 源 → 一次 stat：源 tarball 本身就是 gzip 容器，字节数与 `npm pack` 产物同量级；
 *  - `link:` 源 → 目录体积上界（`fs.dirSizeBytes`）：这是 `npm pack` 的输入目录，体积比
 *    pack 产物大（真机约 3.4 倍，pack 产物是 gzip），用来展示「量级」足够。
 *    绝不在这里手写递归（见 local-plugin-pack.ts 安全约束：node_modules 由 npm pack 自己排除，
 *    手写递归会把它整个算进来）——度量交给宿主门面，由它负责跳过 node_modules 与链接目录。
 *
 * 登记本身就是语义：Map 里有该插件 = 「该单元随备份携带一个文件」，与导出产物里
 * `npm pack` 打出的 tarball（`fileCount: 1`）对齐；宿主未实现相应度量、越界路径
 * （fs 门面对 home 外绝对路径抛 `host.fsPathEscape`）、目录读不到一律按 0 ——
 * 预览绝不能因为一个体积数字而失败。
 */
async function measureLocalSources(plugins: PluginEntry[], ctx: HostContext): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const statSize = ctx.fs.statSize;
  const dirSize = ctx.fs.dirSizeBytes;
  // profile 目录与打包钩子同源（local-plugin-host.ts：优先 profileDir，回退按 profile 名拼接）
  const profileDir = ctx.profileDir !== undefined && ctx.profileDir !== ''
    ? ctx.profileDir
    : join(ctx.homeDir, PNPM_PROFILE_DIR(ctx.profile));
  for (const pl of plugins) {
    const kind = classifyPluginSpec(pl.spec);
    if (kind !== 'file' && kind !== 'link') continue;
    try {
      const abs = resolveLocalPluginPath(pl.spec ?? '', { homeDir: ctx.homeDir, profileDir });
      // 宿主未实现对应度量 → null → 按 0（旧行为，只少一个数字）
      const size = kind === 'link'
        ? (dirSize !== undefined ? await dirSize.call(ctx.fs, abs) : null)
        : (statSize !== undefined ? await statSize.call(ctx.fs, abs) : null);
      sizes.set(pl.name, size !== null && size > 0 ? size : 0);
    } catch {
      // 越界 / 读不到：按 0 处理（预览不因此失败），但仍算「随包携带一个文件」
      sizes.set(pl.name, 0);
    }
  }
  return sizes;
}

/**
 * 由分区载荷派生单元清单（纯函数、零 I/O）。
 *
 * 单元 = 插件包 / cordis 补丁行 / pnpm-workspace.yaml / 单个 patch 文件。
 * 后两者构成**原子组**：patchedDependencies 的声明与 patches/** 文件必须同进同出
 * （issue #35 —— 只搬声明会让目标机 pnpm 拒绝一切 add），故互相写进 lockedWith，
 * 由选择模型保证勾选/取消同步。
 *
 * `tarballBytes` = 预览路径登记到的本地源体积（见 measureLocalSources，0 = 体积未知但仍随包携带）；
 * 缺省时体积与文件数完全按导出产物里的 base64 计算 —— 与改造前逐字一致。
 */
function unitsOf(
  data: PluginsSection,
  tarballBytes?: Map<string, number>,
  related?: Map<string, PluginAreaRef[]>,
): ExportUnit[] {
  const wsId = 'plugins:pnpm-workspace';
  const patchFileIds = (data.patchFiles ?? []).map((pf) => `plugins:patch:${normalizePath(pf.relativePath)}`);
  const group = [wsId, ...patchFileIds];
  const units: ExportUnit[] = [];
  // data.plugins 可能缺省（空分区 / 手写 section）：按空表处理，不抛错 ——
  // 选择器对任何分区都会调 listUnits，抛错会让整行退化成不可展开。
  for (const pl of data.plugins ?? []) {
    const tarball = tarballOf(data, pl.name);
    const measured = tarballBytes?.get(pl.name);
    const areas = related?.get(pl.name);
    units.push({
      id: `plugin:${pl.name}`,
      label: pl.name,
      detail: pl.version,
      // base64 长度 → 原始字节数（仅用于展示体积，不求精确）；预览路径没有字节，用 stat 量到的源体积
      sizeBytes: tarball !== undefined ? Math.floor((tarball.base64.length * 3) / 4) : measured ?? 0,
      ...(tarball !== undefined || measured !== undefined ? { fileCount: 1 } : {}),
      // 「按插件看」的树骨架：该插件声明的数据区域（零数据目录 I/O）
      ...(areas !== undefined && areas.length > 0 ? { relatedAreas: areas } : {}),
    });
  }
  for (const line of data.patch ?? []) {
    // 由 mcp / prompts adapter 管理的行不属本分区（applyItem 同样跳过），列出来只会误导用户
    if (isManagedElsewhere(line.raw)) continue;
    units.push({ id: `patch:${line.lineId}`, label: line.lineId, sizeBytes: 0 });
  }
  if (data.pnpmWorkspace !== undefined && data.pnpmWorkspace !== null && data.pnpmWorkspace !== '') {
    units.push({
      id: wsId,
      label: 'pnpm-workspace.yaml',
      sizeBytes: data.pnpmWorkspace.length,
      ...(group.length > 1 ? { lockedWith: group } : {}),
    });
  }
  for (const pf of data.patchFiles ?? []) {
    units.push({
      id: `plugins:patch:${normalizePath(pf.relativePath)}`,
      label: pf.relativePath,
      sizeBytes: Math.floor((pf.base64.length * 3) / 4),
      ...(group.length > 1 ? { lockedWith: group } : {}),
    });
  }
  return units;
}

/**
 * 目标机 profile 的 `dsh.profile.bundles` 视图（issue #95）。
 *
 * 三态**必须分开**：`absent`（没有 package.json）、`unreadable`（读失败 / JSON 坏 / 形状不符）、
 * `ok`。把后两者当成「没有」会直接去写一份清单，抹掉 profile 的其它字段。
 */
type TargetBundleView =
  | { state: 'ok'; names: Set<string>; text: string }
  | { state: 'absent' }
  | { state: 'unreadable'; reason: string };

export class PluginsAdapter implements ConfigAdapter<PluginsSection> {
  readonly id = 'plugins' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('plugins').displayName;
  readonly defaultIncluded = sectionMeta('plugins').defaultIncluded;
  readonly portability = sectionMeta('plugins').portability;
  /** 插件自身包名：导出 plugins 分区时不列自己（避免备份里出现「当前正在生成备份的插件」的自引用条目） */
  private readonly selfName: string;
  /** T1：本地源（link:/file:）插件打包钩子；未注入 = 不打包（保持改造前行为） */
  private readonly localPack: LocalPluginPackHook | undefined;

  constructor(selfName: string = 'dsh-config-manager', localPack?: LocalPluginPackHook) {
    this.selfName = selfName;
    this.localPack = localPack;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<PluginsSection>> {
    return this.collect(ctx, options, true);
  }

  /**
   * 只读预览（`/export-preview` 用）：与 `export()` **同口径**，但不做任何本地源打包。
   *
   * 为什么必须覆写：基类缺省会让调用方退回 `export()`，而 `export()` 会为每个 `link:`/`file:`
   * 插件 spawn 一次 `npm pack`（真机 12 个本地源插件 ≈12 s）。「总览」页只想知道条目数与体积，
   * 却因此每次都要打包一遍全部本地插件 —— 预览是纯只读路径，不该有任何进程副作用。
   *
   * 与 `export()` 的**唯一**差异：
   * - 不注入 `localTarballs`（没有字节），故清单 spec 保持原样（不做 `file:<tarball>` 改写）；
   * - 插件单元体积改为 `file:` 源的一次 stat（`measureLocalSources`），`link:` 目录按 0；
   * - 体积用一次 `stringify` 算 UTF-8 字节数（与 /export-preview 对 JSON 分区的口径一致）。
   * 其余（清单过滤、patch 行、pnpm-workspace、patchFiles、条目级白名单、告警文案、单元分组）逐字相同。
   */
  async preview(ctx: HostContext, options: ExportOptions): Promise<SectionPreview<PluginsSection>> {
    const collected = await this.collect(ctx, options, false);
    const data = collected.data;
    const tarballBytes = await measureLocalSources(data.plugins, ctx);
    if (tarballBytes.size > 0) previewTarballBytes.set(data, tarballBytes);
    return {
      section: collected,
      // 与 src/index.ts 对 JSON 分区现算体积的口径一致（utf8 字节数）
      sizeBytes: new TextEncoder().encode(stringifyJsonSafe(data)).length,
      items: unitsOf(data, tarballBytes, relatedAreasByData.get(data)),
    };
  }

  /**
   * 导出与预览的共同内核。
   *
   * `pack=false` 时跳过本地源打包（预览路径）—— 除该段外两条路径逐字共用，
   * 避免「预览说会带什么」与「导出真的带什么」分叉。
   */
  private async collect(ctx: HostContext, options: ExportOptions, pack: boolean): Promise<ExportSection<PluginsSection>> {
    const plugins: PluginEntry[] = [];
    const warnings: string[] = [];
    try {
      const installed = await ctx.plugins.listInstalled();
      for (const p of installed) {
        // 不导出自身：本插件即正在生成该备份的插件，备份不应包含指向自己的清单条目
        if (this.selfName !== '' && p.name === this.selfName) continue;
        plugins.push({
          name: p.name,
          version: p.version,
          // 声明依赖 spec（github:/file:/link: 等非 registry 来源导入时按此重装）
          spec: p.spec,
          isBundle: p.isBundle ?? false,
          inBundles: p.inBundles ?? [],
          enabled: p.enabled,
          // issue #95：只在 dsh.profile.bundles 里声明的层（源机无依赖声明）必须带上这个标记，
          // 导入端据此走「只声明」而不是 npm 安装。缺省不写，普通依赖的字节与改造前逐字一致。
          ...(p.bundlesOnly === true ? { bundlesOnly: true } : {}),
        });
      }
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.pluginListReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
    const patch: PatchLine[] = [];
    // issue #71：patch 有两层（home 层 + profile 层），只读 home 层会漏掉 DSH 工具与 marketplace
    // 写入 profile 层的激活行 —— 导出少了它们，导入到新机就少一批插件加载项。
    const patchRead = await readEffectivePatchLines(ctx.patchFile, ctx.profile);
    for (const l of patchRead.lines) patch.push({ file: l.file, lineId: l.lineId, raw: l.raw });
    for (const f of patchRead.failures) {
      warnings.push(msgOf(ctx)('adapter.patchReadFailed', { reason: `${f.file}: ${f.reason}` }));
    }
    // pnpm-workspace.yaml（allowBuilds / minimumReleaseAgeExclude 等）：随插件分区迁移，
    // 否则目标 profile 的 pnpm 可能因构建白名单/冷静期拒绝安装插件（§34.17 同款语义）。
    let pnpmWorkspace: string | null = null;
    try {
      const rel = PNPM_WORKSPACE_REL(ctx.profile);
      if (await ctx.fs.exists(rel)) {
        const raw = new TextDecoder().decode(await ctx.fs.readFile(rel));
        // 可移植性净化（收集侧）：storeDir / cacheDir … 的值是本机绝对路径，跟着快照跑到
        // 别的机器上必然指向不存在的目录 → 只带「可移植」的那部分（逐行删除，其余逐字不变）。
        const strip = stripPnpmMachinePaths(raw);
        pnpmWorkspace = strip.text;
        if (strip.stripped.length > 0) {
          warnings.push(msgOf(ctx)('adapter.pwMachinePathStripped', {
            count: String(strip.stripped.length), keys: strip.stripped.join(', '),
          }));
        }
      }
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.pnpmReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }

    // issue #35：`patchedDependencies` 引用的 patches/** 必须与声明同进同出。
    // 只搬 pnpm-workspace.yaml 文本会让目标机拿到「声明在、文件不在」的组合，
    // 此后 pnpm 拒绝**一切** add（含插件安装）——实测 13/13 插件安装全灭。
    let patchFiles: PnpmPatchFile[] | undefined;
    if (pnpmWorkspace !== null && pnpmWorkspace !== '') {
      const parsed = parsePnpmPatchedDependencies(pnpmWorkspace);
      if (parsed.unsupported !== null) {
        warnings.push(msgOf(ctx)('adapter.pwPatchesUnsupported', { line: parsed.unsupported }));
      }
      const collected: PnpmPatchFile[] = [];
      for (const decl of parsed.declared) {
        const rel = normalizePath(decl.path);
        if (rel === '' || !isPathSafe(rel)) {
          warnings.push(msgOf(ctx)('adapter.patchFileUnsafe', { name: decl.name, path: decl.path }));
          continue;
        }
        const homeRel = `${PNPM_PROFILE_DIR(ctx.profile)}/${rel}`;
        try {
          if (!(await ctx.fs.exists(homeRel))) {
            warnings.push(msgOf(ctx)('adapter.patchFileMissing', { name: decl.name, path: rel }));
            continue;
          }
          const data = await ctx.fs.readFile(homeRel);
          if (data.byteLength > MAX_PATCH_FILE_BYTES) {
            warnings.push(msgOf(ctx)('adapter.patchFileTooLarge', {
              name: decl.name, path: rel, limit: `${Math.floor(MAX_PATCH_FILE_BYTES / 1024)} KiB`,
            }));
            continue;
          }
          collected.push({ relativePath: rel, base64: bytesToBase64(data) });
        } catch (err) {
          warnings.push(msgOf(ctx)('adapter.patchFileReadFailed', {
            name: decl.name, path: rel, reason: err instanceof Error ? err.message : String(err),
          }));
        }
      }
      if (collected.length > 0) patchFiles = collected;
    }

    // T1：本地源（link:/file:）插件打包。这些 spec 指向本机路径，换机后必然不可达
    // （曾导致插件被静默丢失）。钩子由宿主注入；未注入 / 无本地源 / 单个失败一律不中断导出。
    let localTarballs: LocalPluginTarball[] | undefined;
    let effectivePlugins = plugins;
    if (pack && this.localPack !== undefined) {
      try {
        const packed = await this.localPack(plugins, ctx);
        warnings.push(...packed.warnings);
        if (packed.packed.length > 0) {
          localTarballs = packed.packed.map((p) => ({
            packageName: p.packageName,
            version: p.version,
            relativePath: p.relativePath,
            base64: bytesToBase64(p.data),
          }));
          // 清单里的 spec 同步改写为可移植形式：即便导入端不拆 tarball，
          // 也不会再把本机绝对路径写进目标 profile package.json。
          const rewritten = packed.rewritten;
          effectivePlugins = plugins.map((p) =>
            rewritten[p.name] !== undefined ? { ...p, spec: rewritten[p.name] } : p,
          );
        }
      } catch (err) {
        warnings.push(msgOf(ctx)('adapter.localPackFailed', { reason: err instanceof Error ? err.message : String(err) }));
      }
    }


    // Phase 1 条目级选择：只保留白名单命中的单元。键缺省 = 全量（与改造前逐字节一致）；
    // 空数组由 Exporter 在选定阶段整分区剔除，不会走到这里。
    const allow = options.includeItems?.[this.id];
    let keptPlugins = effectivePlugins;
    let keptPatch = patch;
    let keptWorkspace = pnpmWorkspace;
    let keptPatchFiles = patchFiles;
    let keptTarballs = localTarballs;
    if (allow !== undefined) {
      // 原子组（D5 / issue #35）：pnpm-workspace.yaml ↔ patch 文件必须同进同出 ——
      // 声明在而文件不在会让目标机 pnpm 拒绝一切 add；文件在而声明不在则补丁静默失效。
      // 这里用 every（全或无）做纵深防御：即使 UI 的 lockedWith 没生效也不会产出半套。
      const wsId = 'plugins:pnpm-workspace';
      const pfIds = (patchFiles ?? []).map((pf) => `plugins:patch:${normalizePath(pf.relativePath)}`);
      const groupKept = [wsId, ...pfIds].every((id) => allow.includes(id));
      keptWorkspace = groupKept ? pnpmWorkspace : null;
      keptPatchFiles = groupKept ? patchFiles : undefined;
      keptPlugins = effectivePlugins.filter((pl) => allow.includes(`plugin:${pl.name}`));
      keptPatch = patch.filter((pl) => allow.includes(`patch:${pl.lineId}`));
      // tarball 只跟随存活的插件（本地源插件的打包产物不得被孤立带走）
      const alive = new Set(keptPlugins.map((pl) => pl.name));
      keptTarballs = localTarballs?.filter((t) => alive.has(t.packageName));
    }
    const data: PluginsSection = {
      version: 1,
      plugins: keptPlugins,
      patch: keptPatch,
      pnpmWorkspace: keptWorkspace,
      ...(keptTarballs !== undefined ? { localTarballs: keptTarballs } : {}),
      ...(keptPatchFiles !== undefined ? { patchFiles: keptPatchFiles } : {}),
    };
    /**
     * 「按插件看」的树骨架（导出选择器）：登记每个插件声明的数据区域。
     * 只登记「至少有一个区域」的插件 —— 其余插件单元保持无该字段，界面据此不显示空壳节点。
     * 归属信息是**附加**信息：扫描失败不得影响导出/预览本身（与 pluginData 同一纪律）。
     */
    try {
      const related = await relatedAreasOf(ctx);
      if (related.size > 0) relatedAreasByData.set(data, related);
    } catch {
      // 读不到声明就不登记（界面按「没有已知关联」渲染，绝不猜）
    }
    return {
      sectionId: 'plugins',
      data,
      counts: {
        plugins: keptPlugins.length,
        patchLines: keptPatch.length,
        ...(keptTarballs !== undefined ? { localTarballs: keptTarballs.length } : {}),
        ...(keptPatchFiles !== undefined ? { patchFiles: keptPatchFiles.length } : {}),
      },
      warnings,
    };
  }

  /**
   * 单元清单（Phase 1；零 I/O：直接由 export 产物派生）。
   *
   * 单元 = 插件包 / cordis 补丁行 / pnpm-workspace.yaml / 单个 patch 文件。
   * 后两者构成**原子组**：patchedDependencies 的声明与 patches/** 文件必须同进同出
   * （issue #35 —— 只搬声明会让目标机 pnpm 拒绝一切 add），故互相写进 lockedWith，
   * 由选择模型保证勾选/取消同步。
   */
  listUnits(section: ExportSection<PluginsSection>): ExportUnit[] {
    // 预览产物没有 tarball 字节，体积来自 measureLocalSources 挂上的统计（导出产物走 base64 分支）；
    // 「按插件看」的数据区域骨架同样由 collect() 登记在载荷对象上（两条路径逐字一致，units.test 钉住）
    return unitsOf(section.data, previewTarballBytes.get(section.data), relatedAreasByData.get(section.data));
  }

  /**
   * 导入后目标机**可能**存在的 patch 文件集合（相对 profile 目录）——issue #35。
   * = 备份携带的 patchFiles ∪ 目标机本来就有的文件。只用于判定「声明能否被满足」，
   * 不做任何写入（写入在 applyItem 内、且先于 pnpm-workspace.yaml）。
   */
  private async patchAvailability(data: PluginsSection, ctx: ImportContext): Promise<Set<string>> {
    const set = new Set<string>();
    for (const pf of data.patchFiles ?? []) {
      const rel = normalizePath(pf.relativePath);
      if (rel !== '' && isPathSafe(rel)) set.add(rel);
    }
    const profileDir = PNPM_PROFILE_DIR(ctx.target.profile);
    for (const decl of parsePnpmPatchedDependencies(data.pnpmWorkspace ?? '').declared) {
      const rel = normalizePath(decl.path);
      if (rel === '' || !isPathSafe(rel) || set.has(rel)) continue;
      try {
        if (await ctx.target.fs.exists(`${profileDir}/${rel}`)) set.add(rel);
      } catch (err) {
        // t81 / t23 口径：**读不到 ≠ 没有**。只有 ENOENT 才是「本来就没有」；EACCES/EBUSY/IO 一律上抛，
        // 否则会把「声明在、文件也在」的 patch 当作不存在 → 从将要写入的 pnpm-workspace.yaml 里剔除
        // （issue #35 的症状：目标机 pnpm 从此拒绝一切 add）。存在性探测自身失败不得降级成「不存在」。
        if (!isENOENT(err)) throw err;
      }
    }
    return set;
  }

  /**
   * 读目标机 profile 的 `dsh.profile.bundles`（issue #95）。
   *
   * 相对路径与写入目标同源（`profiles/<profile>/package.json`），走 `ctx.target.fs` 而不是
   * 宿主私有通道：与 pnpm-workspace.yaml / patch 文件同一条 I/O 纪律（受限、可被 MemFs 测试）。
   */
  private async targetBundles(ctx: ImportContext): Promise<TargetBundleView> {
    const rel = `${PNPM_PROFILE_DIR(ctx.target.profile)}/package.json`;
    try {
      if (!(await ctx.target.fs.exists(rel))) return { state: 'absent' };
      const text = new TextDecoder().decode(await ctx.target.fs.readFile(rel));
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { state: 'unreadable', reason: ctx.msg('adapter.pluginHostBundleBadJson') };
      }
      const bundles = (parsed as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles;
      if (!Array.isArray(bundles) || bundles.some((entry) => typeof entry !== 'string')) {
        return { state: 'unreadable', reason: ctx.msg('adapter.pluginHostBundleBadShape') };
      }
      return { state: 'ok', names: new Set(bundles as string[]), text };
    } catch (err) {
      return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 把 host 自带的层声明进目标机 profile 的 `dsh.profile.bundles`（issue #95）。
   *
   * 为什么**不走安装通道**：这类层的包由 DSH 从自己的安装位置解析；按裸包名 `dsh plugin add`
   * 会把 npm `dist-tags.latest` 的副本装进 profile，与 host 的版本线脱节 —— 真机故障：
   * host 0.2.1-rc.2 + 包 0.2.1-alpha.2 的隔离组契约对不上 → `session-controller` 一直 pending
   * → 新建会话 service-unavailable。声明不了时只报非致命 warning（§34.17），不拖垮其余配置。
   */
  private async declareHostBundle(name: string, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    const rel = `${PNPM_PROFILE_DIR(ctx.target.profile)}/package.json`;
    const view = await this.targetBundles(ctx);
    if (view.state === 'absent') {
      return { ok: false, warning: true, message: msg('adapter.pluginHostBundleNoManifest', { name }) };
    }
    if (view.state === 'unreadable') {
      return {
        ok: false,
        warning: true,
        message: msg('adapter.pluginHostBundleManifestUnreadable', { name, reason: view.reason }),
      };
    }
    if (view.names.has(name)) {
      return { ok: true, needsRestart: false, message: msg('adapter.pluginHostBundleSame', { name }) };
    }
    const merged = mergeBundleDeclaration(view.text, name);
    if (merged === null) {
      return {
        ok: false,
        warning: true,
        message: msg('adapter.pluginHostBundleManifestUnreadable', {
          name,
          reason: msg('adapter.pluginHostBundleBadShape'),
        }),
      };
    }
    try {
      await ctx.target.fs.writeFile(rel, new TextEncoder().encode(merged.text));
    } catch (err) {
      return {
        ok: false,
        warning: true,
        message: msg('adapter.pluginHostBundleWriteFailed', { name, reason: err instanceof Error ? err.message : String(err) }),
      };
    }
    return { ok: true, needsRestart: true, message: msg('adapter.pluginHostBundleDeclared', { name }) };
  }

  async analyzeImport(data: PluginsSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];

    // pnpm-workspace.yaml：先于插件安装写入（allowBuilds / minimumReleaseAgeExclude 需在
    // pnpm add 时生效）。与目标不同 → Create/Update；无文件/内容一致 → Skip。
    if (data.pnpmWorkspace !== undefined && data.pnpmWorkspace !== null && data.pnpmWorkspace !== '') {
      // issue #35：patch 文件项必须**先于** pnpm-workspace.yaml。
      // 原因有二：① 配置里的 patchedDependencies 只有文件已就位才可用，先写配置会留下
      // 「声明在、文件未到」的窗口（中途中断 → 目标机 pnpm 从此拒绝一切 add）；
      // ② 它们是独立计划项（可被用户 keepCurrent 否决），配置项的写入不得越权替它们落盘。
      // 作为计划项还有第三个作用：进入导入前快照（回滚可还原被覆盖的原文件）。
      for (const pf of data.patchFiles ?? []) {
        const rel = normalizePath(pf.relativePath);
        if (rel === '' || !isPathSafe(rel)) continue;
        const id = `plugins:patch:${rel}`;
        const abs = `${PNPM_PROFILE_DIR(ctx.target.profile)}/${rel}`;
        let current: Uint8Array | null = null;
        try {
          current = await ctx.target.fs.exists(abs) ? await ctx.target.fs.readFile(abs) : null;
        } catch {
          current = null;
        }
        const target = { adapter: 'plugins' as const, ref: `${PLUGIN_PATCH_REF_PREFIX}${rel}` };
        if (current === null) {
          items.push({
            id, kind: 'Create', adapter: 'plugins',
            description: msg('adapter.patchFileCreate', { path: rel }), severity: 'info', target,
          });
        } else if (sha256Hex(current) === sha256Hex(base64ToBytes(pf.base64))) {
          items.push({ id, kind: 'Skip', adapter: 'plugins', description: msg('adapter.fileSame', { path: rel }), severity: 'info' });
        } else {
          items.push({
            id, kind: 'Conflict', adapter: 'plugins',
            description: msg('adapter.fileDiff', { path: rel }), severity: 'warning', target,
          });
        }
      }

      // issue #35：目标机满足不了的 patchedDependencies 声明必须剔除——否则写进去之后，
      // 目标机 pnpm 会因为「patch 文件读不到」拒绝**一切** add（含本次要装的插件）。
      const available = await this.patchAvailability(data, ctx);
      // 可移植性净化（写回侧·纵深防御）：老版本备份 / 第三方工具产出的载荷里可能仍带着
      // 来源机的机器路径键（本版本收集侧已剥离，正常路径这里就是 no-op）。
      const stripped = stripPnpmMachinePaths(data.pnpmWorkspace);
      const clean = sanitizePnpmWorkspacePatches(stripped.text, (rel) => available.has(rel));
      const droppedNames = clean.dropped.map((d) => d.name).join(', ');
      let current: string | null = null;
      try {
        const rel = PNPM_WORKSPACE_REL(ctx.target.profile);
        current = await ctx.target.fs.exists(rel)
          ? new TextDecoder().decode(await ctx.target.fs.readFile(rel))
          : null;
      } catch {
        current = null;
      }
      // 写回侧：不搬运来源机的机器路径，也不清掉**本机**自己的设置 → 接回目标机原有的那几行。
      const merged = restorePnpmMachinePaths(clean.text, current);
      // 「只差机器路径行」= 目标机现文本剥掉它自己的机器路径行后与将要写入的内容逐字一致。
      // 此时写回只会把本机那几行挪到末尾（YAML 映射顺序无语义），没有意义 → 不生成计划项：
      // 零写入、本机设置原地不动，也不给用户造一条无意义的 Update 噪音。
      const onlyMachinePaths = current !== null && stripPnpmMachinePaths(current).text === clean.text;
      // 剥完机器路径键后**没有可移植内容**（来源机的配置只剩机器路径）→ 不产出空文件项：
      // 「无内容形态不得交给 importer」与 collect() 的口径一致。
      if (merged.text !== '' && !onlyMachinePaths && current !== merged.text) {
        const details = machinePathNotes(msg, stripped.stripped, merged.restored);
        if (clean.dropped.length > 0) {
          // 既有口径不变：剔除声明的那句话排在最前
          details.unshift(msg('adapter.pwPatchesDroppedDetail', { count: String(clean.dropped.length), names: droppedNames }));
        }
        items.push({
          id: 'plugins:pnpm-workspace',
          kind: current === null ? 'Create' : 'Update',
          adapter: 'plugins',
          description: current === null ? msg('adapter.pwCreate') : msg('adapter.pwUpdate'),
          // detail 非空 ⇒ isToolchainChangeItem ⇒ 进确认列表（可见、可取消）——净化绝不静默
          ...(details.length > 0 ? { detail: details.join(msg('adapter.listSeparator')) } : {}),
          severity: 'info',
          target: { adapter: 'plugins', ref: 'pnpm-workspace.yaml' },
        });
      }

      // 剔除是**可见**的信息项（不静默改变用户配置语义）
      if (clean.dropped.length > 0) {
        items.push({
          id: 'plugins:pnpm-workspace-dropped',
          kind: 'Warning',
          adapter: 'plugins',
          description: msg('adapter.pwPatchesDropped', { count: String(clean.dropped.length), names: droppedNames }),
          severity: 'warning',
        });
      }
      if (clean.unsupported !== null) {
        items.push({
          id: 'plugins:pnpm-workspace-flow',
          kind: 'Warning',
          adapter: 'plugins',
          description: msg('adapter.pwPatchesUnsupported', { line: clean.unsupported }),
          severity: 'warning',
        });
      }
    }

    // 插件：包名唯一键；同版本 Skip / 未装 Install / 版本不同 Conflict
    const targetInstalled = await ctx.target.plugins.listInstalled();
    // issue #95：只在 dsh.profile.bundles 里声明的层（源机没有依赖声明）**不装 npm 包** ——
    // 它的名字只声明进目标机的 bundles，由 DSH 从自己的安装位置解析。只在真出现这类条目时才读
    // 目标清单（其余场景零额外 I/O，行为与改造前逐字一致）。
    const bundleView = data.plugins.some((p) => isBundlesOnlyEntry(p)) ? await this.targetBundles(ctx) : null;
    for (const p of data.plugins) {
      const id = `plugin:${p.name}`;
      if (isBundlesOnlyEntry(p)) {
        if (bundleView !== null && bundleView.state === 'ok' && bundleView.names.has(p.name)) {
          items.push({
            id, kind: 'Skip', adapter: 'plugins',
            description: msg('adapter.pluginHostBundleSame', { name: p.name }),
            detail: msg('adapter.pluginHostBundleDetail'),
            severity: 'info',
          });
        } else if (bundleView !== null && bundleView.state === 'ok') {
          items.push({
            id, kind: 'Create', adapter: 'plugins',
            description: msg('adapter.pluginHostBundleDeclare', { name: p.name }),
            detail: msg('adapter.pluginHostBundleDetail'),
            severity: 'info',
            target: { adapter: 'plugins', ref: PLUGIN_PROFILE_MANIFEST_REF },
          });
        } else {
          // 清单缺 / 读不到 / 形态不符：**不猜也不重建**，如实告警（非致命，其余分区照常导入）
          items.push({
            id,
            kind: 'Warning',
            adapter: 'plugins',
            description: bundleView === null || bundleView.state === 'absent'
              ? msg('adapter.pluginHostBundleNoManifest', { name: p.name })
              : msg('adapter.pluginHostBundleManifestUnreadable', { name: p.name, reason: bundleView.reason }),
            severity: 'warning',
          });
        }
        continue;
      }
      const tp = targetInstalled.find((t) => t.name === p.name);
      // T1：该插件在备份内自带 tarball（本地源 link:/file:）→ 目标机无需原始路径即可安装。
      const hasTarball = tarballOf(data, p.name) !== undefined;
      const tarballHint = hasTarball ? msg('adapter.pluginLocalTarballHint') : undefined;
      if (!tp) {
        items.push({
          id, kind: 'Install', adapter: 'plugins',
          description: msg('adapter.pluginInstall', { name: p.name, version: p.version }),
          detail: p.isBundle ? msg('adapter.pluginBundleMember') : tarballHint,
          severity: 'info',
        });
      } else if (tp.version === p.version) {
        items.push({ id, kind: 'Skip', adapter: 'plugins', description: msg('adapter.pluginSame', { name: p.name }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'plugins',
          description: msg('adapter.pluginDiff', { name: p.name }),
          detail: msg('adapter.pluginVersionDetail', { current: tp.version, imported: p.version }),
          severity: 'warning',
        });
      }
    }

    // 用户 patch 行：lineId 唯一键；存在且同 → Skip；存在不同 → Conflict；不存在 → Create。
    // mcp-client 行与 systemPrompt/planMode 行由 mcp/prompts adapter 管理，此处跳过（避免重复写入覆盖）。
    // issue #71：目标行同样跨两层（否则 profile 层已有的行会被误判成 Create → 导入后出现重复行）
    const targetLines = (await readEffectivePatchLines(ctx.target.patchFile, ctx.target.profile)).lines;
    for (const pl of data.patch) {
      if (isManagedElsewhere(pl.raw)) continue;
      const id = `patch:${pl.lineId}`;
      const tl = targetLines.find((l) => l.lineId === pl.lineId);
      // 层身份随计划项走：applyItem 按 pl.file 写回，导入前快照按 target.file 记原行，
      // 两者必须是同一层，否则回滚会把另一层改坏（issue #71）。
      const layer = resolveWriteLayer(pl.file, ctx.target.profile);
      if (!tl) {
        items.push({
          id, kind: 'Create', adapter: 'plugins',
          description: msg('adapter.patchLineCreate', { lineId: pl.lineId }), severity: 'info',
          target: { adapter: 'plugins', ref: pl.lineId, file: layer },
        });
      } else if (isDeepStrictEqual(tl.raw, pl.raw)) {
        items.push({ id, kind: 'Skip', adapter: 'plugins', description: msg('adapter.patchLineSame', { lineId: pl.lineId }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'plugins',
          description: msg('adapter.patchLineDiff', { lineId: pl.lineId }), severity: 'warning',
          target: { adapter: 'plugins', ref: pl.lineId, file: layer },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    // pnpm-workspace.yaml：插件安装的 pnpm 配置（allowBuilds / minimumReleaseAgeExclude），
    // 必须先于任何插件安装写入，pnpm add 时才能生效。失败为非致命 warning。
    // issue #35：patch 文件项（写入 profile 的 patches/ 目录；同时进入导入前快照，可回滚）
    if (item.id.startsWith('plugins:patch:')) {
      const ref = item.target?.ref;
      if (ref === undefined || !ref.startsWith(PLUGIN_PATCH_REF_PREFIX)) {
        return { ok: false, message: msg('adapter.missingTargetRef') };
      }
      const rel = normalizePath(ref.slice(PLUGIN_PATCH_REF_PREFIX.length));
      if (rel === '' || !isPathSafe(rel)) {
        return { ok: false, message: msg('adapter.patchFileUnsafe', { name: item.id, path: rel }) };
      }
      const data = ctx.sections.get('plugins') as PluginsSection | undefined;
      const pf = data?.patchFiles?.find((p) => normalizePath(p.relativePath) === rel);
      if (pf === undefined) return { ok: false, message: msg('adapter.dataMissingFile', { ref: rel }) };
      try {
        await ctx.target.fs.writeFile(`${PNPM_PROFILE_DIR(ctx.target.profile)}/${rel}`, base64ToBytes(pf.base64));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          warning: true,
          message: msg('adapter.patchFileWriteFailed', { path: rel, reason: err instanceof Error ? err.message : String(err) }),
        };
      }
    }

    if (item.id === 'plugins:pnpm-workspace') {
      const data = ctx.sections.get('plugins') as PluginsSection | undefined;
      const text = data?.pnpmWorkspace;
      if (text === undefined || text === null || text === '') {
        return { ok: false, message: msg('adapter.pwMissing') };
      }
      // issue #35：判定「声明能否被满足」只看**此刻磁盘上的真实状态**——patch 文件项
      // （`plugins:patch:*`）在计划里排在本项之前，已按用户决策落盘或保留原样。
      // 这里**绝不**替它们写文件：那样会绕过用户在冲突项上的 keepCurrent 选择，
      // 正是 issue #35 要消除的「静默覆盖」。
      const profileDir = PNPM_PROFILE_DIR(ctx.target.profile);
      const available = new Set<string>();
      for (const decl of parsePnpmPatchedDependencies(text).declared) {
        const rel = normalizePath(decl.path);
        if (rel === '' || !isPathSafe(rel) || available.has(rel)) continue;
        try {
          if (await ctx.target.fs.exists(`${profileDir}/${rel}`)) available.add(rel);
        } catch (err) {
          // 同上（t81 / t23）：探测失败必须上抛，绝不把它降级成「声明不可满足」而写瘦 pnpm-workspace.yaml。
          if (!isENOENT(err)) throw err;
        }
      }
      // 可移植性净化（写回侧）：先剥掉载荷里的机器路径键（纵深防御），再把目标机**原有的**
      // 那几行接回去 —— 既不搬运来源机的路径，也不清掉本机自己的 store / 缓存位置。
      const stripped = stripPnpmMachinePaths(text);
      const clean = sanitizePnpmWorkspacePatches(stripped.text, (rel) => available.has(rel));
      const wsRel = PNPM_WORKSPACE_REL(ctx.target.profile);
      let local: string | null = null;
      try {
        local = (await ctx.target.fs.exists(wsRel))
          ? new TextDecoder().decode(await ctx.target.fs.readFile(wsRel))
          : null;
      } catch (err) {
        // 「存在但读不到」必须显式失败（只有 ENOENT 才算本来就没有）：读不到就无法保证本机的
        // 路径设置不被清掉 —— 宁可不写，也不静默丢掉本机的 store / 缓存位置。
        if (!isENOENT(err)) {
          return {
            ok: false,
            warning: true,
            message: msg('adapter.pwLocalReadFailed', { reason: err instanceof Error ? err.message : String(err) }),
          };
        }
        local = null;
      }
      const merged = restorePnpmMachinePaths(clean.text, local);
      try {
        await ctx.target.fs.writeFile(wsRel, new TextEncoder().encode(merged.text));
        const notes: string[] = [msg('adapter.pwWritten')];
        if (clean.dropped.length > 0) {
          notes.push(msg('adapter.pwWrittenPatchesDropped', {
            count: String(clean.dropped.length),
            names: clean.dropped.map((d) => d.name).join(', '),
          }));
        }
        notes.push(...machinePathNotes(msg, stripped.stripped, merged.restored));
        return { ok: true, needsRestart: true, message: notes.join(msg('adapter.listSeparator')) };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          warning: true,
          message: msg('adapter.pwWriteFailed', { msg: reason }),
        };
      }
    }

    // 插件安装/更新：官方机制 dsh plugin CLI（dsh plugin --profile <p> add <pkg>）；
    // needsRestart 提示（设计 §8：不打包二进制）。
    // 版本冲突（useImported）会解析成 Update，同样走这条安装通道（官方机制只能装到 npm
    // 最新版，无法精确锁定备份版本，故如实提示）。
    // 失败为非致命 warning（§34.17）：一个装不上的插件（npm 依赖冲突/网络不可达等）不得
    // 拖垮已成功导入的其余配置——与 workspaces 的「目标不可达 → warning」同款语义。
    if (item.id.startsWith('plugin:')) {
      const name = item.id.replace(/^plugin:/, '');
      const data = ctx.sections.get('plugins') as PluginsSection | undefined;
      // issue #95：host 自带的层（源机只在 dsh.profile.bundles 声明、没有依赖声明）走「只声明」，
      // 绝不进 npm 安装通道（按裸包名装 = 把 dist-tag latest 的副本塞进 profile）。
      const entry = data?.plugins.find((p) => p.name === name);
      if (entry !== undefined && isBundlesOnlyEntry(entry)) {
        return await this.declareHostBundle(name, ctx);
      }
      try {
        // 安装目标由 pluginInstallTarget 统一决策（issue #101）：备份里有具体版本时精确安装，
        // 其余 registry 包带「包名@spec」；非 registry 来源原样。
        // T1：备份内自带 tarball → 解包到 homeDir 内的本地插件缓存目录，改以 file:<abs> 安装。
        // 这是「换机后本地插件不再丢失」的关键：原始绝对路径在目标机不存在，解包出的 tgz 一定存在。
        let tarballPath: string | undefined;
        const tarball = data !== undefined ? tarballOf(data, name) : undefined;
        if (tarball !== undefined) {
          try {
            tarballPath = await writeLocalTarball(ctx, tarball);
          } catch (err) {
            // 解包失败不阻断安装尝试：退回原 spec（可能失败，但会如实报错而非静默丢失）
            ctx.onLog?.(msg('adapter.localTarballUnpackFailed', { name, err: err instanceof Error ? err.message : String(err) }));
          }
        }
        const target = pluginInstallTarget(name, { version: entry?.version, spec: entry?.spec, tarballPath });
        // 执行日志：记录实际将发起的子进程命令行（与宿主 DshPluginsFacade 的
        // dsh plugin --profile <p> add <target> 一致）；仅非敏感文本，渲染前 UI 再 redact 兜底
        ctx.onLog?.(`$ dsh plugin --profile ${ctx.target.profile ?? resolveProcessProfileName()} add ${target}`);
        // 透传中止信号：用户「跳过当前插件」→ 宿主 kill 子进程 + 清半装状态 → 抛 ImportUserSkippedError
        const result = await ctx.target.plugins.install(name, target, ctx.signal);
        const suffix = result.needsRestart ? msg('adapter.pluginRestartSuffix') : '';
        // 落地校验（issue #101）：官方 CLI 退出 0 不等于版本变了 —— pnpm 会尊重目标机既有
        // package.json spec，固定版已装、区间已满足时「什么都没装」同样返回 0。回读实际版本再下结论。
        const expected = entry?.version;
        const actual = result.installedVersion ?? null;
        if (expected !== undefined && expected !== '' && actual !== null && actual !== expected) {
          return {
            ok: false,
            warning: true,
            needsRestart: true,
            message: msg('adapter.pluginVersionMismatch', {
              name,
              expected,
              actual,
              command: `dsh plugin --profile ${ctx.target.profile ?? resolveProcessProfileName()} add ${name}@${expected}`,
            }),
          };
        }
        if (actual !== null) {
          return { ok: true, needsRestart: true, message: msg('adapter.pluginInstalledAtVersion', { name, version: actual, suffix }) };
        }
        return {
          ok: true,
          needsRestart: true,
          message: item.kind === 'Update'
            ? msg('adapter.pluginUpdateTriggered', { name, suffix })
            : msg('adapter.pluginInstallOk', { name, suffix }),
        };
      } catch (err) {
        // 用户跳过：原样上抛（引擎 applyOne 捕获 → skipped + skippedByUser，不触发回滚）
        if (ctx.signal?.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        // 提示里的 profile 必须与**实际安装目标**同源（ctx.target.profile = 宿主解析出的
        // config.profile → profileContext → --profile → env → web）。此前这里单独调
        // resolveProcessProfileName()（只认 argv/env）：Desktop 外壳不传 --profile，
        // 真机于是出现「安装用的是 desktop、提示却写 dsh plugin --profile web add …」的自相矛盾。
        const hintProfile = ctx.target.profile ?? resolveProcessProfileName();
        return {
          ok: false,
          warning: true,
          // 保留 warning（§34.17 非致命）：一个装不上的插件不得拖垮已成功导入的其余配置；
          // message 附可复制的手动安装命令（profile 解析与 M1 宿主一致）。
          message: (item.kind === 'Update' ? msg('adapter.pluginUpdateFailed', { name, msg: reason, profile: hintProfile }) : msg('adapter.pluginInstallFailed', { name, msg: reason, profile: hintProfile })),
        };
      }
    }
    // patch 行：Create → insert，Update/Conflict(useImported) → update
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    const data = ctx.sections.get('plugins') as PluginsSection | undefined;
    const pl = data?.patch.find((p) => p.lineId === ref);
    if (!pl) return { ok: false, message: msg('adapter.patchMissing', { ref }) };
    // 层身份按**语义**映射到目标机：来源是别的 profile 层时不能照抄名字（目标机未必有那个
    // profile，宿主门面会拒绝），一律落到目标机当前 profile 层（与计划项 target.file 同口径）。
    await ctx.target.patchFile.applyPatchChanges(resolveWriteLayer(pl.file, ctx.target.profile), [
      { lineId: ref, raw: pl.raw, action: item.kind === 'Create' ? 'insert' : 'update' },
    ]);
    return { ok: true, needsRestart: true, message: msg('adapter.patchWritten', { ref }) };
  }

  async validate(data: PluginsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<PluginsSection>('plugins', data, msg, (section, issues) => {
      if (!Array.isArray(section.plugins)) {
        issues.push({ path: 'plugins', message: msg('adapter.validate.array', { subject: 'plugins' }), severity: 'error' });
      } else {
        // ui-F3：条目级形状必须与 analyzeImport 的假设对齐（它直接读 p.name / p.version）。
        // 只校验「是数组」会放过 plugins:[null]，analyzeImport 抛内部 TypeError → 整包被拦下。
        for (const [i, raw] of section.plugins.entries()) {
          const p = raw as unknown;
          if (p === null || typeof p !== 'object') {
            issues.push({ path: `plugins[${i}]`, message: msg('adapter.validate.recordObject', { subject: 'plugin' }), severity: 'error' });
            continue;
          }
          const name = (p as { name?: unknown }).name;
          if (typeof name !== 'string' || name === '') {
            issues.push({ path: `plugins[${i}].name`, message: msg('adapter.validate.requiredField', { subject: 'plugins[].name' }), severity: 'error' });
          }
          // issue #95：`bundlesOnly` 决定走不走 npm 安装通道，写错类型必须拦下（缺省合法）
          const bundlesOnly = (p as { bundlesOnly?: unknown }).bundlesOnly;
          if (bundlesOnly !== undefined && typeof bundlesOnly !== 'boolean') {
            issues.push({ path: `plugins[${i}].bundlesOnly`, message: msg('adapter.validate.boolean', { subject: 'plugins[].bundlesOnly' }), severity: 'error' });
          }
        }
      }
      if (section.patch !== undefined && !Array.isArray(section.patch)) {
        issues.push({ path: 'patch', message: msg('adapter.validate.array', { subject: 'patch' }), severity: 'error' });
      } else if (Array.isArray(section.patch)) {
        // ui-F3：patch 条目在 analyzeImport 里被读 pl.raw / pl.lineId（isManagedElsewhere(pl.raw)）。
        for (const [i, raw] of section.patch.entries()) {
          const pl = raw as unknown;
          if (pl === null || typeof pl !== 'object') {
            issues.push({ path: `patch[${i}]`, message: msg('adapter.validate.recordObject', { subject: 'patch line' }), severity: 'error' });
          }
        }
      }
      if (section.pnpmWorkspace !== undefined && section.pnpmWorkspace !== null && typeof section.pnpmWorkspace !== 'string') {
        issues.push({ path: 'pnpmWorkspace', message: msg('adapter.validate.string', { subject: 'pnpmWorkspace' }), severity: 'error' });
      }
      // T1：本地插件 tarball 载荷（缺省合法；存在时逐条校验形状与路径安全）
      if (section.localTarballs !== undefined) {
        if (!Array.isArray(section.localTarballs)) {
          issues.push({ path: 'localTarballs', message: msg('adapter.validate.array', { subject: 'localTarballs' }), severity: 'error' });
        } else {
          section.localTarballs.forEach((t, i) => {
            if (t === null || typeof t !== 'object') {
              issues.push({ path: `localTarballs[${i}]`, message: msg('adapter.validate.object', { subject: 'localTarballs[]' }), severity: 'error' });
              return;
            }
            for (const field of ['packageName', 'version', 'relativePath', 'base64'] as const) {
              if (typeof t[field] !== 'string' || t[field] === '') {
                issues.push({ path: `localTarballs[${i}].${field}`, message: msg('adapter.validate.string', { subject: field }), severity: 'error' });
              }
            }
            // 相对路径必须落在 LOCAL_PLUGIN_DIR 之下且不含穿越段（防写 homeDir 外）
            const rel = typeof t.relativePath === 'string' ? t.relativePath.replace(/\\/g, '/') : '';
            if (rel !== '' && (!rel.startsWith(`${LOCAL_PLUGIN_DIR}/`) || rel.includes('..'))) {
              issues.push({ path: `localTarballs[${i}].relativePath`, message: msg('adapter.validate.localTarballPath', { path: rel }), severity: 'error' });
            }
          });
        }
      }
    });
  }
}
