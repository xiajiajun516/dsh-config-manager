/**
 * ui 分区 adapter（设计 §3.3/§4.1/§4.3）：
 * 数据源 = settings.yaml 中「UI 类」namespace（pet / dsh-better-sidebar / remote-web-ui / ui-onboarding / skin 等）。
 * localStorage 等 Host 不可迁移的 UI 状态以 uiMigrationNotes 纯说明形式导出（不含任何值）。
 */
import type { NamespaceRecord, UiMigrationNote, UiSection } from '../schema/types.ts';
import { zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import { engineMsg } from './messages.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { collectNamespaceRecords, planNamespaceItems, applyNamespaceItem, resolveNamespaces, type NamespaceProvider } from './settings.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';
import { pickRecord, recordUnits } from './units.ts';

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

/**
 * localStorage 等 Host 无通道的 UI 状态说明（纯说明，不含值；研究报告 §2.2/§4.4）。
 *
 * t6（英文界面零中文）：说明行的 `reason` 是用户可见文案 ⇒ 表里只放**目录键**，取文案在导出期现取
 * （`uiMigrationNotes(msg)`）—— 这样导出的说明行跟随界面语言，而不是冻结在装配期语言。
 * （表本身是数据；中文只存在于 adapters 域的追加目录 `src/adapters/messages.ts`。）
 */
const UI_MIGRATION_NOTE_ROWS: ReadonlyArray<Omit<UiMigrationNote, 'reason'> & { reasonKey: string }> = [
  { plugin: 'dsh-task-board', storage: 'localStorage', key: 'dsh.taskBoard.v1', migratable: false, reasonKey: 'adapter.uiLocalStorageTaskBoard' },
  { plugin: 'dsh-aionui-panel', storage: 'localStorage', key: 'aionui-panel.*', migratable: false, reasonKey: 'adapter.uiLocalStoragePanel' },
  { plugin: 'dsh-client-ui-*', storage: 'localStorage', key: '*', migratable: false, reasonKey: 'adapter.uiLocalStorageGeneric' },
];

/** UI 迁移说明行（取文案在调用期现取；缺省 = 当前引擎语言的 engineMsg）。 */
export function uiMigrationNotes(msg: MsgFunc = engineMsg): UiSection['uiMigrationNotes'] {
  return UI_MIGRATION_NOTE_ROWS.map((row) => ({
    plugin: row.plugin,
    storage: row.storage,
    key: row.key,
    migratable: row.migratable,
    reason: msg(row.reasonKey),
  }));
}

export class UiAdapter implements ConfigAdapter<UiSection> {
  readonly id = 'ui' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('ui').displayName;
  readonly defaultIncluded = sectionMeta('ui').defaultIncluded;
  readonly portability = sectionMeta('ui').portability;
  private readonly namespaces: string[] | NamespaceProvider;

  constructor(namespaces: string[] | NamespaceProvider = []) {
    this.namespaces = namespaces;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<UiSection>> {
    const warnings: string[] = [];
    const all = await resolveNamespaces(this.namespaces, ctx);
    const uiNames = all.filter((n) => isUiNamespace(n));
    const collected: Record<string, NamespaceRecord> = await collectNamespaceRecords(ctx, uiNames, warnings);
    // 条目级白名单：未勾选的 namespace 整条不带走；迁移说明（纯说明、不含值）与选择无关，始终保留
    const namespaces = pickRecord(collected, options.includeItems?.[this.id], (ns) => this.unitId(ns));
    const notes = uiMigrationNotes(ctx.msg);
    return {
      sectionId: 'ui',
      data: { version: 1, namespaces, uiMigrationNotes: notes },
      counts: { namespaces: Object.keys(namespaces).length, notes: notes.length },
      warnings,
    };
  }

  /** 单元 id：`ui:<namespace>` */
  private unitId(namespace: string): string {
    return this.id + ':' + namespace;
  }

  /** 条目级单元清单（零 I/O）：一个 UI namespace = 一个单元 */
  listUnits(section: ExportSection<UiSection>): ExportUnit[] {
    return recordUnits(this.id, section.data.namespaces ?? {});
  }

  async analyzeImport(data: UiSection, ctx: ImportContext): Promise<PlanItem[]> {
    return planNamespaceItems(data.namespaces, 'ui', ctx);
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    return applyNamespaceItem(item, 'ui', ctx);
  }

  async validate(data: UiSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<UiSection>('ui', data, msg, (section, issues) => {
      if (section.namespaces === null || typeof section.namespaces !== 'object') {
        issues.push({ path: 'namespaces', message: msg('adapter.validate.missingObject', { subject: 'namespaces' }), severity: 'error' });
      }
      if (section.uiMigrationNotes !== undefined && !Array.isArray(section.uiMigrationNotes)) {
        issues.push({ path: 'uiMigrationNotes', message: msg('adapter.validate.array', { subject: 'uiMigrationNotes' }), severity: 'error' });
      }
    });
  }
}
