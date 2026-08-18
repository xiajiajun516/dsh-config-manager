/**
 * pluginFiles 分区 adapter（可选，设计 §3.3/§1.2）：
 * 数据源 = 插件自有配置文件（相对 ~/.dsh 根）：
 *   1. 白名单固定文件（dsh-ssh.json、pet.json 等，避免扫描整个主目录）；
 *   2. 约定的插件配置目录（collectDir，如 plugin-config/）递归收集其下所有文件。
 * relativePath 一律是「相对 ~/.dsh 根」的完整路径（与白名单文件一致），
 * 导入时按同一相对路径写回原位置。默认关闭（defaultIncluded=false，用户显式勾选才导出）。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { zhMsg } from '../core/messages.ts';
import { isPathSafe } from '../utils/paths.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';

export const DEFAULT_PLUGIN_FILE_WHITELIST: readonly string[] = ['dsh-ssh.json', 'pet.json'];

export class PluginFilesAdapter implements ConfigAdapter<FilesSection> {
  readonly id = 'pluginFiles' as const;
  readonly displayName = 'Plugin Files';
  readonly defaultIncluded = false;
  readonly portability = 'deviceSpecific' as const;
  private readonly whitelist: string[];
  /** 约定配置目录（相对 ~/.dsh 根，如 'plugin-config'）；递归收集其下所有文件。undefined = 不收集。 */
  private readonly collectDir?: string;

  constructor(whitelist: string[] = [...DEFAULT_PLUGIN_FILE_WHITELIST], collectDir?: string) {
    this.whitelist = whitelist;
    if (collectDir !== undefined && collectDir !== '' && !isPathSafe(collectDir)) {
      throw new Error(`pluginFiles collectDir 非法（须为相对 ~/.dsh 根的安全路径）: ${collectDir}`);
    }
    this.collectDir = collectDir === '' ? undefined : collectDir;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const seen = new Set<string>();
    // 1) 白名单固定文件（不存在则跳过，dsh-ssh.json 等为按需创建）
    for (const rel of this.whitelist) {
      try {
        const data = await ctx.fs.readFile(rel);
        files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        seen.add(rel);
      } catch {
        /* 白名单文件不存在则跳过 */
      }
    }
    // 2) 约定配置目录递归收集（相对 ~/.dsh 根的完整路径；与白名单文件去重）
    if (this.collectDir !== undefined) {
      let rels: string[] = [];
      try {
        rels = await ctx.fs.listRecursive(this.collectDir);
      } catch {
        // 目录不存在视为空
      }
      for (const rel of rels) {
        if (seen.has(rel)) continue;
        try {
          const data = await ctx.fs.readFile(rel);
          files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
        } catch {
          continue;
        }
      }
    }
    return {
      sectionId: 'pluginFiles',
      data: { version: 1, files },
      counts: { files: files.length },
      warnings: [],
    };
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `pluginFile:${file.relativePath}`;
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(file.relativePath);
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, kind: 'Create', adapter: 'pluginFiles',
          description: msg('adapter.pluginFileCreate', { path: file.relativePath }), severity: 'info',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: 'pluginFiles', description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'pluginFiles',
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: 'pluginFiles', ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    const data = ctx.sections.get('pluginFiles') as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: ctx.msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(ref, file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'pluginFiles' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.files)) {
      issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
