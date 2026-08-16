/**
 * settings 分区 adapter（设计 §3.3/§4.1/§4.2）：
 * 数据源 = ~/.dsh/settings.yaml 中「非 UI 类」namespace（经 ctx.settings.describe({redactSecrets:true})）。
 *
 * 说明：DSH settings 服务没有「枚举全部 namespace」的 API（研究报告 §3.2），
 * 因此 namespace 清单由宿主注入（真实实现可从 settings.yaml 顶层 key 解析）。
 * 默认只导出名单内且不属于 UI 类（isUiNamespace）的 namespace，与 ui adapter 互斥并集 = 全部设置。
 */
import { isDeepStrictEqual } from 'node:util';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { NamespaceRecord, SettingsSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, NamespaceInfo, PlanItem, ValidationResult,
} from '../core/types.ts';
import { isUiNamespace } from './ui.ts';

/** namespace 清单提供者：宿主从 settings.yaml 顶层 key / 插件注册表获得 */
export type NamespaceProvider = (ctx: HostContext) => Promise<string[]> | string[];

export async function resolveNamespaces(
  namespaces: string[] | NamespaceProvider,
  ctx: HostContext,
): Promise<string[]> {
  return typeof namespaces === 'function' ? namespaces(ctx) : namespaces;
}

/** 批量读取 namespace 的 redacted 记录（settings/ui 共用；单项失败跳过并告警） */
export async function collectNamespaceRecords(
  ctx: HostContext,
  names: string[],
  warnings: string[],
): Promise<Record<string, NamespaceRecord>> {
  const namespaces: Record<string, NamespaceRecord> = {};
  for (const name of names) {
    try {
      const info = await ctx.settings.describe(name, { redactSecrets: true });
      namespaces[name] = {
        value: info.value,
        base: info.base,
        revision: info.revision,
        applies: info.applies,
        secrets: info.secrets,
      };
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.settingsNsReadFailed', { name, reason: err instanceof Error ? err.message : String(err) }));
    }
  }
  return namespaces;
}

/** 值是否“空”（目标已注册但从未配置 → 视为待初始化，Create 而非 Conflict） */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/** 对比导入记录与目标当前值：不存在 → Create；一致 → Skip；不同 → Conflict；
 * 目标端 describe 抛错（命名空间未注册：提供它的插件在目标未激活/未安装）→ MissingDependency（§15 依赖检测），
 * 此时 Create/Update 必然失败，标记为“需注意”让导入继续，而不是整体失败。纯计算，零写入。 */
export async function planNamespaceItems(
  data: Record<string, NamespaceRecord>,
  adapter: 'settings' | 'ui',
  ctx: ImportContext,
): Promise<PlanItem[]> {
  const msg = ctx.msg;
  const items: PlanItem[] = [];
  for (const [name, rec] of Object.entries(data)) {
    let current: NamespaceInfo | null = null;
    let targetUnavailable = false;
    try {
      current = await ctx.target.settings.describe(name, { redactSecrets: true });
    } catch {
      // 目标连 describe 都失败 → 命名空间未注册（缺少提供插件）或目标不可读：
      // 不能假定“不存在就创建”（replace 会同样失败），按依赖缺失处理。
      targetUnavailable = true;
    }
    const id = `${adapter}:${name}`;
    if (targetUnavailable) {
      items.push({
        id, kind: 'MissingDependency', adapter,
        description: msg('adapter.settingsUnregistered', { ns: name }),
        severity: 'warning', target: { adapter, ref: name },
      });
    } else if (current === null || isEmptyValue(current.value)) {
      // 目标已注册但从未配置（空值）→ 初始化（Create）
      items.push({
        id, kind: 'Create', adapter, description: msg('adapter.settingsCreate', { name }), severity: 'info',
        target: { adapter, ref: name },
      });
    } else if (isDeepStrictEqual(current.value, rec.value)) {
      items.push({ id, kind: 'Skip', adapter, description: msg('adapter.settingsSame', { name }), severity: 'info' });
    } else {
      items.push({
        id, kind: 'Conflict', adapter, description: msg('adapter.settingsDiff', { name }),
        detail: `current=${JSON.stringify(current.value)} imported=${JSON.stringify(rec.value)}`.slice(0, 200),
        severity: 'warning', target: { adapter, ref: name },
      });
    }
  }
  return items;
}

/** 写入单个 namespace（settings/ui 共用）：读时锁 + expectedRevision 乐观锁，防覆盖并发修改 */
export async function applyNamespaceItem(
  item: PlanItem,
  sectionId: 'settings' | 'ui',
  ctx: ImportContext,
): Promise<ApplyResult> {
  const ref = item.target?.ref;
  if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
  const data = ctx.sections.get(sectionId) as { namespaces?: Record<string, NamespaceRecord> } | undefined;
  const rec = data?.namespaces?.[ref];
  if (!rec) return { ok: false, message: ctx.msg('adapter.namespaceMissing', { ref }) };
  // 写入前读当前 revision 作为 expectedRevision（读时锁）：目标不存在（Create）则不带锁提交
  let expected: number | undefined;
  try {
    expected = (await ctx.target.settings.describe(ref, { redactSecrets: true })).revision;
  } catch {
    expected = undefined;
  }
  await ctx.target.settings.replace(ref, rec.value, expected);
  return { ok: true };
}

export class SettingsAdapter implements ConfigAdapter<SettingsSection> {
  readonly id = 'settings' as const;
  readonly displayName = 'Settings';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  private readonly namespaces: string[] | NamespaceProvider;

  constructor(namespaces: string[] | NamespaceProvider = []) {
    this.namespaces = namespaces;
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<SettingsSection>> {
    const warnings: string[] = [];
    const all = await resolveNamespaces(this.namespaces, ctx);
    const nonUi = all.filter((n) => !isUiNamespace(n));
    if (nonUi.length === 0) warnings.push(msgOf(ctx)('adapter.noSettingsNamespaces'));
    const namespaces = await collectNamespaceRecords(ctx, nonUi, warnings);
    return {
      sectionId: 'settings',
      data: { version: 1, namespaces },
      counts: { namespaces: Object.keys(namespaces).length },
      warnings,
    };
  }

  async analyzeImport(data: SettingsSection, ctx: ImportContext): Promise<PlanItem[]> {
    return planNamespaceItems(data.namespaces, 'settings', ctx);
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    return applyNamespaceItem(item, 'settings', ctx);
  }

  async validate(data: SettingsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'settings' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (data.namespaces === null || typeof data.namespaces !== 'object') {
      issues.push({ path: 'namespaces', message: msg('adapter.validate.missingObject', { subject: 'namespaces' }), severity: 'error' });
    } else {
      for (const [name, rec] of Object.entries(data.namespaces)) {
        if (rec === null || typeof rec !== 'object') {
          issues.push({ path: `namespaces.${name}`, message: msg('adapter.validate.recordObject', { subject: 'namespace' }), severity: 'error' });
          continue;
        }
        if (typeof rec.revision !== 'number') {
          issues.push({ path: `namespaces.${name}.revision`, message: msg('adapter.validate.number', { subject: 'revision' }), severity: 'error' });
        }
        if (!('value' in rec)) {
          issues.push({ path: `namespaces.${name}.value`, message: msg('adapter.validate.missingValue'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
