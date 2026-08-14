/**
 * settings 分区 adapter（设计 §3.3/§4.1/§4.2）：
 * 数据源 = ~/.dsh/settings.yaml 中「非 UI 类」namespace（经 ctx.settings.describe({redactSecrets:true})）。
 *
 * 说明：DSH settings 服务没有「枚举全部 namespace」的 API（研究报告 §3.2），
 * 因此 namespace 清单由宿主注入（真实实现可从 settings.yaml 顶层 key 解析）。
 * 默认只导出名单内且不属于 UI 类（isUiNamespace）的 namespace，与 ui adapter 互斥并集 = 全部设置。
 */
import { isDeepStrictEqual } from 'node:util';
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
      warnings.push(`设置 namespace ${name} 读取失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return namespaces;
}

/** 对比导入记录与目标当前值：不存在 → Create；一致 → Skip；不同 → Conflict（纯计算，零写入） */
export async function planNamespaceItems(
  data: Record<string, NamespaceRecord>,
  adapter: 'settings' | 'ui',
  ctx: ImportContext,
): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const [name, rec] of Object.entries(data)) {
    let current: NamespaceInfo | null = null;
    try {
      current = await ctx.target.settings.describe(name, { redactSecrets: true });
    } catch {
      current = null;
    }
    const id = `${adapter}:${name}`;
    if (current === null) {
      items.push({
        id, kind: 'Create', adapter, description: `创建设置 ${name}`, severity: 'info',
        target: { adapter, ref: name },
      });
    } else if (isDeepStrictEqual(current.value, rec.value)) {
      items.push({ id, kind: 'Skip', adapter, description: `设置 ${name} 已一致`, severity: 'info' });
    } else {
      items.push({
        id, kind: 'Conflict', adapter, description: `设置 ${name} 与目标不同`,
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
  if (!ref) return { ok: false, message: '缺少 target.ref' };
  const data = ctx.sections.get(sectionId) as { namespaces?: Record<string, NamespaceRecord> } | undefined;
  const rec = data?.namespaces?.[ref];
  if (!rec) return { ok: false, message: `导入数据缺少 namespace ${ref}` };
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
    if (nonUi.length === 0) warnings.push('未配置 settings namespace 清单，settings 分区为空');
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

  async validate(data: SettingsSection): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: 'settings 数据必须是对象', severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: `version 必须为 1（收到 ${String(data.version)}）`, severity: 'error' });
    }
    if (data.namespaces === null || typeof data.namespaces !== 'object') {
      issues.push({ path: 'namespaces', message: '缺少 namespaces 对象', severity: 'error' });
    } else {
      for (const [name, rec] of Object.entries(data.namespaces)) {
        if (rec === null || typeof rec !== 'object') {
          issues.push({ path: `namespaces.${name}`, message: 'namespace 记录必须是对象', severity: 'error' });
          continue;
        }
        if (typeof rec.revision !== 'number') {
          issues.push({ path: `namespaces.${name}.revision`, message: 'revision 必须是数字', severity: 'error' });
        }
        if (!('value' in rec)) {
          issues.push({ path: `namespaces.${name}.value`, message: '缺少 value', severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
