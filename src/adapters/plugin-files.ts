/**
 * pluginFiles 分区 adapter（可选，设计 §3.3/§1.2）：
 * 数据源 = 插件自有配置文件白名单（dsh-ssh.json、pet.json 等，相对 ~/.dsh 根）。
 * 白名单机制避免扫描整个主目录；默认关闭（defaultIncluded=false，用户显式勾选才导出）。
 */
import { sha256Hex } from '../utils/hashing.ts';
import { zhMsg } from '../core/messages.ts';
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

  constructor(whitelist: string[] = [...DEFAULT_PLUGIN_FILE_WHITELIST]) {
    this.whitelist = whitelist;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    for (const rel of this.whitelist) {
      try {
        const data = await ctx.fs.readFile(rel);
        files.push({ relativePath: rel, data, contentHash: sha256Hex(data) });
      } catch {
        // 白名单文件不存在则跳过（dsh-ssh.json 等为按需创建）
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
