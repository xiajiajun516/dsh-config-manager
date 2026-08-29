/**
 * 文件类分区共享 adapter 基类（skills / agentPresets / sessions 复用；
 * agentInstructions 因位于 homeDir 根、只能白名单收集，覆写 export 后复用本类其余逻辑）。
 * 基准目录与 core/backup.ts 的 FILE_BASES 保持一致（skills→'skills'、agentPresets→'.agent-presets'、sessions→'sessions'），
 * 保证引擎通用快照/回滚（resolveFileTarget）与 applyItem 的写入路径完全一致。
 *
 * 文件内容以真实文件进入 ZIP（custom/skills/… 等前缀由 exporter 按 SECTION_FILE_PREFIXES 处理）。
 * 幂等：相对路径 + 内容 SHA-256 hash 比对（重复导入 → Skip）。
 */
import path from 'node:path';
import { sha256Hex } from '../utils/hashing.ts';
import { isReservedInternalRel, normalizePath } from '../utils/paths.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { FilesSection, SectionId } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, Portability, ValidationResult,
} from '../core/types.ts';

export abstract class FileCollectionAdapter implements ConfigAdapter<FilesSection> {
  abstract readonly id: SectionId;
  abstract readonly displayName: string;
  abstract readonly defaultIncluded: boolean;
  abstract readonly portability: Portability;
  /** 相对 homeDir 的基准目录（与 core/backup.ts FILE_BASES 一致） */
  abstract readonly baseDir: string;

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<FilesSection>> {
    const files: FilesSection['files'] = [];
    const warnings: string[] = [];
    let rels: string[] = [];
    try {
      rels = await ctx.fs.listRecursive(this.baseDir);
    } catch {
      // 目录不存在视为空
    }
    for (const rel of rels) {
      const data = await ctx.fs.readFile(rel);
      const relPath = this.baseDir === '' ? rel : rel.replace(new RegExp(`^${escapeRegExp(this.baseDir)}[\\/]`), '');
      files.push({ relativePath: relPath, data, contentHash: sha256Hex(data) });
    }
    if (rels.length === 0) warnings.push(msgOf(ctx)('adapter.dirEmpty', { type: this.displayName }));
    return {
      sectionId: this.id,
      data: { version: 1, files },
      counts: { files: files.length },
      warnings,
    };
  }

  async analyzeImport(data: FilesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const file of data.files) {
      const id = `${this.id}:${file.relativePath}`;
      // F23 修复：不可信 import 不得写内部 control-plane namespace。
      // 检查 baseDir+ref 解析后的 homeDir 相对路径（self 适配器 baseDir='dsh-config-manager' 是主投毒向量）。
      const resolvedRel = normalizePath(path.join(this.baseDir, file.relativePath));
      if (isReservedInternalRel(resolvedRel)) {
        items.push({
          id, kind: 'Error', adapter: this.id,
          description: msg('adapter.fileReserved', { path: file.relativePath }), severity: 'error',
        });
        continue;
      }
      let current: Uint8Array | null = null;
      try {
        current = await ctx.target.fs.readFile(path.join(this.baseDir, file.relativePath));
      } catch {
        current = null;
      }
      if (current === null) {
        items.push({
          id, kind: 'Create', adapter: this.id,
          description: msg('adapter.fileCreate', { type: this.displayName, path: file.relativePath }), severity: 'info',
          target: { adapter: this.id, ref: file.relativePath },
        });
      } else if (sha256Hex(current) === file.contentHash) {
        items.push({ id, kind: 'Skip', adapter: this.id, description: msg('adapter.fileSame', { path: file.relativePath }), severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: this.id,
          description: msg('adapter.fileDiff', { path: file.relativePath }), severity: 'warning',
          target: { adapter: this.id, ref: file.relativePath },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    // F23 修复：apply 前拒绝写内部 control-plane namespace（纵深防御，analyzeImport 已标 Error）
    const resolvedRel = normalizePath(path.join(this.baseDir, ref));
    if (isReservedInternalRel(resolvedRel)) {
      return { ok: false, message: msg('adapter.fileReserved', { path: ref }) };
    }
    const data = ctx.sections.get(this.id) as FilesSection | undefined;
    const file = data?.files.find((f) => f.relativePath === ref);
    if (!file) return { ok: false, message: msg('adapter.dataMissingFile', { ref }) };
    await ctx.target.fs.writeFile(path.join(this.baseDir, ref), file.data);
    return { ok: true };
  }

  async validate(data: FilesSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.fileSection'), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.files)) {
      issues.push({ path: 'files', message: msg('adapter.validate.array', { subject: 'files' }), severity: 'error' });
    } else {
      for (const f of data.files) {
        if (f === null || typeof f !== 'object' || typeof f.relativePath !== 'string' || f.relativePath === '') {
          issues.push({ path: 'files[]', message: msg('adapter.validate.fileRelativePath'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
