/**
 * workspaces 分区 adapter（设计 §3.3/§11）：
 * 数据源 = ~/.dsh/storages/workspace.json 的 tables.workspaces（经 ctx.workspace 门面）。
 * workspace.path 为绝对路径 → 跨设备必须 PathMapping（analyzeImport 生成 PathMapping 项，
 * 映射由引擎 PathMapper 先行应用到 sections，applyItem 拿到的已是映射后数据）。
 */
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceRecord, WorkspacesSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';

export class WorkspacesAdapter implements ConfigAdapter<WorkspacesSection> {
  readonly id = 'workspaces' as const;
  readonly displayName = 'Workspaces';
  readonly defaultIncluded = true;
  readonly portability = 'platformSpecific' as const;

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<WorkspacesSection>> {
    const records = await ctx.workspace.listRecords();
    return {
      sectionId: 'workspaces',
      data: { version: 1, workspaces: records },
      counts: { workspaces: records.length },
      warnings: [],
    };
  }

  async analyzeImport(data: WorkspacesSection, ctx: ImportContext): Promise<PlanItem[]> {
    const items: PlanItem[] = [];
    for (const rec of data.workspaces) {
      const id = `workspace:${rec.id}`;
      const existing = (await ctx.target.workspace.listRecords()).find((r) => r.id === rec.id);
      if (!existing) {
        items.push({
          id, kind: 'Create', adapter: 'workspaces',
          description: `创建工作区 ${rec.title ?? rec.id}（${rec.path}）`, severity: 'info',
          target: { adapter: 'workspaces', ref: rec.id },
        });
      } else if (isDeepStrictEqual(existing, rec)) {
        items.push({ id, kind: 'Skip', adapter: 'workspaces', description: `工作区 ${rec.id} 已一致`, severity: 'info' });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'workspaces',
          description: `工作区 ${rec.id} 与目标不同`,
          detail: `current=${JSON.stringify(existing)} imported=${JSON.stringify(rec)}`.slice(0, 200),
          severity: 'warning', target: { adapter: 'workspaces', ref: rec.id },
        });
      }
      // 绝对路径 → 路径映射提示（oldPrefix 先用整条路径占位，newPrefix 由 UI 确认）
      if (rec.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rec.path)) {
        items.push({
          id: `${id}:path`, kind: 'PathMapping', adapter: 'workspaces',
          description: `路径需映射: ${rec.path}`, severity: 'warning',
          pathMapping: { oldPrefix: rec.path, newPrefix: '', appliesTo: ['workspaces'] },
          target: { adapter: 'workspaces', ref: rec.id },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    // PathMapping 项：数据已由 PathMapper 应用到 sections，无需额外写入
    if (item.kind === 'PathMapping') return { ok: true };
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: '缺少 target.ref' };
    const data = ctx.sections.get('workspaces') as WorkspacesSection | undefined;
    const rec = data?.workspaces.find((r) => r.id === ref);
    if (!rec) return { ok: false, message: `导入数据缺少工作区 ${ref}` };
    try {
      await ctx.target.workspace.writeRecord(rec);
      return { ok: true };
    } catch (err) {
      // 目标端无法写入（如路径 realpath 失败/目录不存在）→ 非致命警告（§34.17），
      // 不触发整体回滚——否则一个失效路径会拖垮已成功导入的其余配置。
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        warning: true,
        message: `工作区 ${ref} 未能写入：${msg}（需映射路径或先在目标创建目录）`,
      };
    }
  }

  async validate(data: WorkspacesSection): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: 'workspaces 数据必须是对象', severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: `version 必须为 1（收到 ${String(data.version)}）`, severity: 'error' });
    }
    if (!Array.isArray(data.workspaces)) {
      issues.push({ path: 'workspaces', message: 'workspaces 必须是数组', severity: 'error' });
    } else {
      for (const w of data.workspaces as WorkspaceRecord[]) {
        if (w === null || typeof w !== 'object' || typeof w.id !== 'string' || typeof w.path !== 'string') {
          issues.push({ path: 'workspaces[]', message: 'workspace 记录必须含字符串 id 与 path', severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
