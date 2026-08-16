/**
 * plugins 分区 adapter（设计 §3.3/§8）：
 * 数据源 = ctx.plugins.listInstalled()（插件清单）+ 用户 patch 层（profile cordis.patch.yml）。
 *
 * 安全不变量：绝不打包插件二进制；导入走 DSH 官方机制（dsh plugin CLI → needsRestart 提示）。
 * patch 行导入（用户自定义行：启用/禁用/插入）写回 cordis.patch.yml，同样 needsRestart。
 */
import { isDeepStrictEqual } from 'node:util';
import { resolveProfileNameFromArgv } from '../core/plugin-cli.ts';
import type { PatchLine, PluginEntry, PluginsSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';

export const USER_PATCH_FILE = 'cordis.patch.yml';

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

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<PluginsSection>> {
    const plugins: PluginEntry[] = [];
    const warnings: string[] = [];
    try {
      const installed = await ctx.plugins.listInstalled();
      for (const p of installed) {
        plugins.push({
          name: p.name,
          version: p.version,
          isBundle: p.isBundle ?? false,
          inBundles: p.inBundles ?? [],
          enabled: p.enabled,
        });
      }
    } catch (err) {
      warnings.push(`插件清单读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const patch: PatchLine[] = [];
    try {
      const lines = await ctx.patchFile.readPatchLines(USER_PATCH_FILE);
      for (const l of lines) patch.push({ file: USER_PATCH_FILE, lineId: l.lineId, raw: l.raw });
    } catch (err) {
      warnings.push(`patch 文件读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      sectionId: 'plugins',
      data: { version: 1, plugins, patch },
      counts: { plugins: plugins.length, patchLines: patch.length },
      warnings,
    };
  }

  async analyzeImport(data: PluginsSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    const targetInstalled = await ctx.target.plugins.listInstalled();

    // 插件：包名唯一键；同版本 Skip / 未装 Install / 版本不同 Conflict
    for (const p of data.plugins) {
      const id = `plugin:${p.name}`;
      const tp = targetInstalled.find((t) => t.name === p.name);
      if (!tp) {
        items.push({
          id, kind: 'Install', adapter: 'plugins',
          description: `安装插件 ${p.name}@${p.version}`,
          detail: p.isBundle ? '（bundle 成员，经聚合包安装）' : undefined,
          severity: 'info',
        });
      } else if (tp.version === p.version) {
        items.push({ id, kind: 'Skip', adapter: 'plugins', description: `插件 ${p.name} 已安装且版本一致`, severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'plugins',
          description: `插件 ${p.name} 版本不同`,
          detail: `当前 ${tp.version} vs 导入 ${p.version}`,
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
          description: `写入 patch 行 ${pl.lineId}`, severity: 'info',
          target: { adapter: 'plugins', ref: pl.lineId },
        });
      } else if (isDeepStrictEqual(tl.raw, pl.raw)) {
        items.push({ id, kind: 'Skip', adapter: 'plugins', description: `patch 行 ${pl.lineId} 已一致`, severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'plugins',
          description: `patch 行 ${pl.lineId} 与目标不同`, severity: 'warning',
          target: { adapter: 'plugins', ref: pl.lineId },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    // 插件安装/更新：官方机制 dsh plugin CLI（dsh plugin --profile <p> add <pkg>）；
    // needsRestart 提示（设计 §8：不打包二进制）。
    // 版本冲突（useImported）会解析成 Update，同样走这条安装通道（官方机制只能装到 npm
    // 最新版，无法精确锁定备份版本，故如实提示）。
    // 失败为非致命 warning（§34.17）：一个装不上的插件（npm 依赖冲突/网络不可达等）不得
    // 拖垮已成功导入的其余配置——与 workspaces 的「目标不可达 → warning」同款语义。
    if (item.id.startsWith('plugin:')) {
      const name = item.id.replace(/^plugin:/, '');
      const verb = item.kind === 'Update' ? '更新' : '安装';
      try {
        const result = await ctx.target.plugins.install(name);
        const suffix = result.needsRestart ? '，重启 dsh 后生效' : '';
        return {
          ok: true,
          needsRestart: true,
          message: item.kind === 'Update'
            ? `插件 ${name} 已触发${verb}（npm 最新版）${suffix}`
            : `插件 ${name} 已${verb}${suffix}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          warning: true,
          // 保留 warning（§34.17 非致命）：一个装不上的插件不得拖垮已成功导入的其余配置；
          // message 附可复制的手动安装命令（profile 解析与 M1 宿主一致）。
          message: `插件 ${name} ${verb}失败：${msg}。可手动安装：dsh plugin --profile ${resolveProfileNameFromArgv()} add ${name}（其余配置已导入；可修复依赖后在设置页重试或手动安装）`,
        };
      }
    }
    // patch 行：Create → insert，Update/Conflict(useImported) → update
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 target.ref' };
    const data = ctx.sections.get('plugins') as PluginsSection | undefined;
    const pl = data?.patch.find((p) => p.lineId === ref);
    if (!pl) return { ok: false, message: `导入数据缺少 patch 行 ${ref}` };
    await ctx.target.patchFile.applyPatchChanges(pl.file, [
      { lineId: ref, raw: pl.raw, action: item.kind === 'Create' ? 'insert' : 'update' },
    ]);
    return { ok: true, needsRestart: true, message: `patch 行 ${ref} 已写入，重启后生效` };
  }

  async validate(data: PluginsSection): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: 'plugins 数据必须是对象', severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: `version 必须为 1（收到 ${String(data.version)}）`, severity: 'error' });
    }
    if (!Array.isArray(data.plugins)) {
      issues.push({ path: 'plugins', message: 'plugins 必须是数组', severity: 'error' });
    }
    if (data.patch !== undefined && !Array.isArray(data.patch)) {
      issues.push({ path: 'patch', message: 'patch 必须是数组', severity: 'error' });
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
