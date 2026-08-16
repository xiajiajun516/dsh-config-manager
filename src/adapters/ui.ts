/**
 * ui 分区 adapter（设计 §3.3/§4.1/§4.3）：
 * 数据源 = settings.yaml 中「UI 类」namespace（pet / dsh-better-sidebar / remote-web-ui / ui-onboarding / skin 等）。
 * localStorage 等 Host 不可迁移的 UI 状态以 uiMigrationNotes 纯说明形式导出（不含任何值）。
 */
import type { NamespaceRecord, UiSection } from '../schema/types.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { collectNamespaceRecords, planNamespaceItems, applyNamespaceItem, resolveNamespaces, type NamespaceProvider } from './settings.ts';

/** UI 类 namespace 前缀名单（设计 §4.1；随新插件扩展，只影响「某一 namespace 归哪一边」，不影响数据完整性） */
export const KNOWN_UI_NAMESPACE_PREFIXES: readonly string[] = [
  'pet',
  'dsh-better-sidebar',
  'remote-web-ui',
  'ui-onboarding',
  'dsh-client-ui',
  'skin',
  'theme',
  'layout',
  'sidebar',
  'appearance',
];

/** namespace 名是否属于 UI 类（大小写不敏感前缀匹配） */
export function isUiNamespace(name: string): boolean {
  const lower = name.toLowerCase();
  return KNOWN_UI_NAMESPACE_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()));
}

/** localStorage 等 Host 无通道的 UI 状态说明（纯说明，不含值；研究报告 §2.2/§4.4） */
export const UI_MIGRATION_NOTES: UiSection['uiMigrationNotes'] = [
  {
    plugin: 'dsh-task-board',
    storage: 'localStorage',
    key: 'dsh.taskBoard.v1',
    migratable: false,
    reason: '任务看板数据存于浏览器 localStorage，Host 侧无访问通道，需在目标机器重新配置',
  },
  {
    plugin: 'dsh-aionui-panel',
    storage: 'localStorage',
    key: 'aionui-panel.*',
    migratable: false,
    reason: '面板宽度/折叠状态存于浏览器 localStorage，Host 侧无访问通道，需在目标机器重新配置',
  },
  {
    plugin: 'dsh-client-ui-*',
    storage: 'localStorage',
    key: '*',
    migratable: false,
    reason: '浏览器端 UI 状态无法经 Host API 迁移',
  },
];

export class UiAdapter implements ConfigAdapter<UiSection> {
  readonly id = 'ui' as const;
  readonly displayName = 'UI Preferences';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  private readonly namespaces: string[] | NamespaceProvider;

  constructor(namespaces: string[] | NamespaceProvider = []) {
    this.namespaces = namespaces;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<UiSection>> {
    const warnings: string[] = [];
    const all = await resolveNamespaces(this.namespaces, ctx);
    const uiNames = all.filter((n) => isUiNamespace(n));
    const namespaces: Record<string, NamespaceRecord> = await collectNamespaceRecords(ctx, uiNames, warnings);
    return {
      sectionId: 'ui',
      data: { version: 1, namespaces, uiMigrationNotes: UI_MIGRATION_NOTES },
      counts: { namespaces: Object.keys(namespaces).length, notes: UI_MIGRATION_NOTES.length },
      warnings,
    };
  }

  async analyzeImport(data: UiSection, ctx: ImportContext): Promise<PlanItem[]> {
    return planNamespaceItems(data.namespaces, 'ui', ctx);
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    return applyNamespaceItem(item, 'ui', ctx);
  }

  async validate(data: UiSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'ui' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (data.namespaces === null || typeof data.namespaces !== 'object') {
      issues.push({ path: 'namespaces', message: msg('adapter.validate.missingObject', { subject: 'namespaces' }), severity: 'error' });
    }
    if (data.uiMigrationNotes !== undefined && !Array.isArray(data.uiMigrationNotes)) {
      issues.push({ path: 'uiMigrationNotes', message: msg('adapter.validate.array', { subject: 'uiMigrationNotes' }), severity: 'error' });
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
