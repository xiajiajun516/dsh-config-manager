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
import { isDeepStrictEqual } from 'node:util';
import { installSpecFor, resolveProfileNameFromArgv } from '../core/plugin-cli.ts';
import { isLocalPluginSpec, isPackedLocalSpec, LOCAL_PLUGIN_DIR } from '../core/local-plugin-pack.ts';
import type { PackLocalPluginsResult } from '../core/local-plugin-pack.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { LocalPluginTarball, PatchLine, PluginEntry, PluginsSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';

export const USER_PATCH_FILE = 'cordis.patch.yml';

/**
 * 本地源插件打包钩子（由宿主注入，见 src/index.ts createAdapters）。
 * 返回打包结果（含字节与重写后的 spec）；不注入 = 不做本地源打包（保持旧行为）。
 */
export type LocalPluginPackHook = (
  plugins: PluginEntry[],
  ctx: HostContext,
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
    throw new Error(`非法 tarball 相对路径: ${relativePath}`);
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




/** pnpm-workspace.yaml 相对 $DSH_HOME 的路径（plugins 分区内按「插件安装配置」管理）。 */
export const PNPM_WORKSPACE_REL = (profile: string | undefined): string =>
  `profiles/${profile !== undefined && profile !== '' ? profile : 'web'}/pnpm-workspace.yaml`;

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

export class PluginsAdapter implements ConfigAdapter<PluginsSection> {
  readonly id = 'plugins' as const;
  readonly displayName = 'Plugins';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  /** 插件自身包名：导出 plugins 分区时不列自己（避免备份里出现「当前正在生成备份的插件」的自引用条目） */
  private readonly selfName: string;
  /** T1：本地源（link:/file:）插件打包钩子；未注入 = 不打包（保持改造前行为） */
  private readonly localPack: LocalPluginPackHook | undefined;

  constructor(selfName: string = 'dsh-config-manager', localPack?: LocalPluginPackHook) {
    this.selfName = selfName;
    this.localPack = localPack;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<PluginsSection>> {
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
        });
      }
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.pluginListReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
    const patch: PatchLine[] = [];
    try {
      const lines = await ctx.patchFile.readPatchLines(USER_PATCH_FILE);
      for (const l of lines) patch.push({ file: USER_PATCH_FILE, lineId: l.lineId, raw: l.raw });
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.patchReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }
    // pnpm-workspace.yaml（allowBuilds / minimumReleaseAgeExclude 等）：随插件分区迁移，
    // 否则目标 profile 的 pnpm 可能因构建白名单/冷静期拒绝安装插件（§34.17 同款语义）。
    let pnpmWorkspace: string | null = null;
    try {
      const rel = PNPM_WORKSPACE_REL(ctx.profile);
      if (await ctx.fs.exists(rel)) {
        pnpmWorkspace = new TextDecoder().decode(await ctx.fs.readFile(rel));
      }
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.pnpmReadFailed', { reason: err instanceof Error ? err.message : String(err) }));
    }

    // T1：本地源（link:/file:）插件打包。这些 spec 指向本机路径，换机后必然不可达
    // （曾导致插件被静默丢失）。钩子由宿主注入；未注入 / 无本地源 / 单个失败一律不中断导出。
    let localTarballs: LocalPluginTarball[] | undefined;
    let effectivePlugins = plugins;
    if (this.localPack !== undefined) {
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

    return {
      sectionId: 'plugins',
      data: {
        version: 1,
        plugins: effectivePlugins,
        patch,
        pnpmWorkspace,
        ...(localTarballs !== undefined ? { localTarballs } : {}),
      },
      counts: {
        plugins: effectivePlugins.length,
        patchLines: patch.length,
        ...(localTarballs !== undefined ? { localTarballs: localTarballs.length } : {}),
      },
      warnings,
    };
  }

  async analyzeImport(data: PluginsSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];

    // pnpm-workspace.yaml：先于插件安装写入（allowBuilds / minimumReleaseAgeExclude 需在
    // pnpm add 时生效）。与目标不同 → Create/Update；无文件/内容一致 → Skip。
    if (data.pnpmWorkspace !== undefined && data.pnpmWorkspace !== null && data.pnpmWorkspace !== '') {
      let current: string | null = null;
      try {
        const rel = PNPM_WORKSPACE_REL(ctx.target.profile);
        current = await ctx.target.fs.exists(rel)
          ? new TextDecoder().decode(await ctx.target.fs.readFile(rel))
          : null;
      } catch {
        current = null;
      }
      if (current !== data.pnpmWorkspace) {
        items.push({
          id: 'plugins:pnpm-workspace',
          kind: current === null ? 'Create' : 'Update',
          adapter: 'plugins',
          description: current === null ? msg('adapter.pwCreate') : msg('adapter.pwUpdate'),
          severity: 'info',
          target: { adapter: 'plugins', ref: 'pnpm-workspace.yaml' },
        });
      }
    }

    // 插件：包名唯一键；同版本 Skip / 未装 Install / 版本不同 Conflict
    const targetInstalled = await ctx.target.plugins.listInstalled();
    for (const p of data.plugins) {
      const id = `plugin:${p.name}`;
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
    const targetLines = await ctx.target.patchFile.readPatchLines(USER_PATCH_FILE);
    for (const pl of data.patch) {
      if (isManagedElsewhere(pl.raw)) continue;
      const id = `patch:${pl.lineId}`;
      const tl = targetLines.find((l) => l.lineId === pl.lineId);
      if (!tl) {
        items.push({
          id, kind: 'Create', adapter: 'plugins',
          description: msg('adapter.patchLineCreate', { lineId: pl.lineId }), severity: 'info',
          target: { adapter: 'plugins', ref: pl.lineId },
        });
      } else if (isDeepStrictEqual(tl.raw, pl.raw)) {
        items.push({ id, kind: 'Skip', adapter: 'plugins', description: msg('adapter.patchLineSame', { lineId: pl.lineId }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'plugins',
          description: msg('adapter.patchLineDiff', { lineId: pl.lineId }), severity: 'warning',
          target: { adapter: 'plugins', ref: pl.lineId },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    // pnpm-workspace.yaml：插件安装的 pnpm 配置（allowBuilds / minimumReleaseAgeExclude），
    // 必须先于任何插件安装写入，pnpm add 时才能生效。失败为非致命 warning。
    if (item.id === 'plugins:pnpm-workspace') {
      const data = ctx.sections.get('plugins') as PluginsSection | undefined;
      const text = data?.pnpmWorkspace;
      if (text === undefined || text === null || text === '') {
        return { ok: false, message: msg('adapter.pwMissing') };
      }
      try {
        await ctx.target.fs.writeFile(PNPM_WORKSPACE_REL(ctx.target.profile), new TextEncoder().encode(text));
        return { ok: true, needsRestart: true, message: msg('adapter.pwWritten') };
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
      try {
        // 非 registry 来源（github:/file: 等）按来源 spec 安装，registry 包按裸包名装 npm 最新版
        const data = ctx.sections.get('plugins') as PluginsSection | undefined;
        let spec = data?.plugins.find((p) => p.name === name)?.spec;

        // T1：备份内自带 tarball → 解包到 homeDir 内的本地插件缓存目录，把 spec 重写为绝对路径。
        // 这是「换机后本地插件不再丢失」的关键：原始绝对路径在目标机不存在，解包出的 tgz 一定存在。
        const tarball = data !== undefined ? tarballOf(data, name) : undefined;
        if (tarball !== undefined) {
          try {
            const abs = await writeLocalTarball(ctx, tarball);
            spec = `file:${abs}`;
          } catch (err) {
            // 解包失败不阻断安装尝试：退回原 spec（可能失败，但会如实报错而非静默丢失）
            ctx.onLog?.(`本地插件 ${name} 的 tarball 解包失败，回退原始 spec：${err instanceof Error ? err.message : String(err)}`);
          }
        }
        // 执行日志：记录实际将发起的子进程命令行（与宿主 DshPluginsFacade 的
        // dsh plugin --profile <p> add <spec> 一致）；仅非敏感文本，渲染前 UI 再 redact 兜底
        ctx.onLog?.(`$ dsh plugin --profile ${ctx.target.profile ?? resolveProfileNameFromArgv()} add ${installSpecFor(name, spec)}`);
        // 透传中止信号：用户「跳过当前插件」→ 宿主 kill 子进程 + 清半装状态 → 抛 ImportUserSkippedError
        const result = await ctx.target.plugins.install(name, spec, ctx.signal);
        const suffix = result.needsRestart ? msg('adapter.pluginRestartSuffix') : '';
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
        return {
          ok: false,
          warning: true,
          // 保留 warning（§34.17 非致命）：一个装不上的插件不得拖垮已成功导入的其余配置；
          // message 附可复制的手动安装命令（profile 解析与 M1 宿主一致）。
          message: (item.kind === 'Update' ? msg('adapter.pluginUpdateFailed', { name, msg: reason, profile: resolveProfileNameFromArgv() }) : msg('adapter.pluginInstallFailed', { name, msg: reason, profile: resolveProfileNameFromArgv() })),
        };
      }
    }
    // patch 行：Create → insert，Update/Conflict(useImported) → update
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    const data = ctx.sections.get('plugins') as PluginsSection | undefined;
    const pl = data?.patch.find((p) => p.lineId === ref);
    if (!pl) return { ok: false, message: msg('adapter.patchMissing', { ref }) };
    await ctx.target.patchFile.applyPatchChanges(pl.file, [
      { lineId: ref, raw: pl.raw, action: item.kind === 'Create' ? 'insert' : 'update' },
    ]);
    return { ok: true, needsRestart: true, message: msg('adapter.patchWritten', { ref }) };
  }

  async validate(data: PluginsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'plugins' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.plugins)) {
      issues.push({ path: 'plugins', message: msg('adapter.validate.array', { subject: 'plugins' }), severity: 'error' });
    }
    if (data.patch !== undefined && !Array.isArray(data.patch)) {
      issues.push({ path: 'patch', message: msg('adapter.validate.array', { subject: 'patch' }), severity: 'error' });
    }
    if (data.pnpmWorkspace !== undefined && data.pnpmWorkspace !== null && typeof data.pnpmWorkspace !== 'string') {
      issues.push({ path: 'pnpmWorkspace', message: msg('adapter.validate.string', { subject: 'pnpmWorkspace' }), severity: 'error' });
    }
    // T1：本地插件 tarball 载荷（缺省合法；存在时逐条校验形状与路径安全）
    if (data.localTarballs !== undefined) {
      if (!Array.isArray(data.localTarballs)) {
        issues.push({ path: 'localTarballs', message: msg('adapter.validate.array', { subject: 'localTarballs' }), severity: 'error' });
      } else {
        data.localTarballs.forEach((t, i) => {
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
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
