/**
 * plugins 分区 adapter（设计 §3.3/§8）：
 * 数据源 = ctx.plugins.listInstalled()（插件清单）+ 用户 patch 层（profile cordis.patch.yml）。
 *
 * 安全不变量：绝不打包插件二进制；导入走 DSH 官方机制（installPlugin → needsRestart 提示）。
 * patch 行导入（用户自定义行：启用/禁用/插入）写回 cordis.patch.yml，同样 needsRestart。
 */
import { isDeepStrictEqual } from 'node:util';
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
    // 插件安装：官方机制 installPlugin；needsRestart 提示（设计 §8：不打包二进制）
    if (item.kind === 'Install') {
      const name = item.id.replace(/^plugin:/, '');
      const result = await ctx.target.plugins.install(name);
      return {
        ok: true,
        needsRestart: true,
        message: result.needsRestart ? `插件 ${name} 已安装，重启 dsh 后生效` : `插件 ${name} 已安装`,
      };
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
