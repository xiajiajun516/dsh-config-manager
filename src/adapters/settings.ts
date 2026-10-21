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
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, NamespaceInfo, PlanItem, ValidationResult,
} from '../core/types.ts';
import { isUiNamespace } from './ui.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';
import { pickRecord, recordUnits } from './units.ts';

/** namespace 清单提供者：宿主从 settings.yaml 顶层 key / 插件注册表获得 */
export type NamespaceProvider = (ctx: HostContext) => Promise<string[]> | string[];

export async function resolveNamespaces(
  namespaces: string[] | NamespaceProvider,
  ctx: HostContext,
): Promise<string[]> {
  return typeof namespaces === 'function' ? namespaces(ctx) : namespaces;
}

/**
 * 一次读回全部 namespace 的 redacted 记录（仅当宿主实现了 `SettingsFacade.describeAll`）。
 *
 * 为什么需要：真实 DSH 的 `SettingsProvider.describe()` 是「无参 = 全量」的 —— 每次调用都对
 * 全部注册项重跑 `schema.toJSON()` + 多次 `structuredClone` + `redactSecrets`，所以「按名单
 * 逐个 describe」实际是 O(N²)：真机 24 个 namespace 实测 ≈1.7 s，而一次全量只需 ≈70 ms。
 * 宿主未实现 describeAll（或调用抛错）时返回 `null`，调用方退回逐名 describe —— 与改造前逐字一致。
 */
export async function readNamespaceMap(ctx: HostContext): Promise<Map<string, NamespaceInfo> | null> {
  const describeAll = ctx.settings.describeAll;
  if (typeof describeAll !== 'function') return null;
  try {
    const all = await describeAll.call(ctx.settings, { redactSecrets: true });
    return new Map(all.map((d) => [d.ns, d.info]));
  } catch {
    return null;
  }
}

/**
 * 从全量 Map 取单个 namespace；缺失时抛出与逐名 `describe()` **逐字相同**的错误
 * （`namespace not found: <name>`），保证快慢两条路径的告警文案与条目一致。
 */
export function namespaceFromMap(all: Map<string, NamespaceInfo>, name: string): NamespaceInfo {
  const info = all.get(name);
  if (info === undefined) throw new Error(`namespace not found: ${name}`);
  return info;
}

/** 批量读取 namespace 的 redacted 记录（settings/ui 共用；单项失败跳过并告警） */
export async function collectNamespaceRecords(
  ctx: HostContext,
  names: string[],
  warnings: string[],
): Promise<Record<string, NamespaceRecord>> {
  const namespaces: Record<string, NamespaceRecord> = {};
  // 快路径：宿主能一次读回全部 namespace 时只读一趟；否则逐名读（见 readNamespaceMap）
  const all = names.length > 0 ? await readNamespaceMap(ctx) : null;
  for (const name of names) {
    try {
      const info = all !== null ? namespaceFromMap(all, name) : await ctx.settings.describe(name, { redactSecrets: true });
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

/** 对比导入记录与目标当前值：一致（含两端皆空）→ Skip；目标为空且导入非空 → Create；其余不同 → Conflict；
 * 目标端 describe 抛错（命名空间未注册：提供它的插件在目标未激活/未安装）→ MissingDependency（§15 依赖检测），
 * 此时 Create/Update 必然失败，标记为“需注意”让导入继续，而不是整体失败。纯计算，零写入。
 *
 * **判定顺序不得回退**（issue #73）：一致判定必须排在「目标为空」之前 —— isEmptyValue({}) 为真，
 * 反序会把「{} 覆盖 {}」判成 Create，而写入 {} 是空写入 no-op，下一轮 describe 仍返回 {}，
 * 于是每次同步都重现同一项，永不收敛。 */
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
    } else if (current !== null && isDeepStrictEqual(current.value, rec.value)) {
      // 值相等优先于「目标为空」：两端皆空（如注册后从未配置的 {}）必须 Skip（issue #73）。
      items.push({ id, kind: 'Skip', adapter, description: msg('adapter.settingsSame', { name }), severity: 'info' });
    } else if (current === null || isEmptyValue(current.value)) {
      // 目标已注册但从未配置（空值）**且导入值非空** → 初始化（Create）
      items.push({
        id, kind: 'Create', adapter, description: msg('adapter.settingsCreate', { name }), severity: 'info',
        target: { adapter, ref: name },
      });
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
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('settings').displayName;
  readonly defaultIncluded = sectionMeta('settings').defaultIncluded;
  readonly portability = sectionMeta('settings').portability;
  private readonly namespaces: string[] | NamespaceProvider;

  constructor(namespaces: string[] | NamespaceProvider = []) {
    this.namespaces = namespaces;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<SettingsSection>> {
    const warnings: string[] = [];
    const all = await resolveNamespaces(this.namespaces, ctx);
    const nonUi = all.filter((n) => !isUiNamespace(n));
    if (nonUi.length === 0) warnings.push(msgOf(ctx)('adapter.noSettingsNamespaces'));
    // 条目级白名单：未勾选的 namespace 整条不进包（勾了却全量搬 = 选择器在撒谎）
    const collected = await collectNamespaceRecords(ctx, nonUi, warnings);
    const namespaces = pickRecord(collected, options.includeItems?.[this.id], (ns) => this.unitId(ns));
    return {
      sectionId: 'settings',
      data: { version: 1, namespaces },
      counts: { namespaces: Object.keys(namespaces).length },
      warnings,
    };
  }

  /** 单元 id：`settings:<namespace>`（同一命名空间下的唯一键） */
  private unitId(namespace: string): string {
    return this.id + ':' + namespace;
  }

  /** 条目级单元清单（零 I/O：输入即 export 产物）；一个 namespace = 一个单元 */
  listUnits(section: ExportSection<SettingsSection>): ExportUnit[] {
    return recordUnits(this.id, section.data.namespaces ?? {});
  }

  async analyzeImport(data: SettingsSection, ctx: ImportContext): Promise<PlanItem[]> {
    return planNamespaceItems(data.namespaces, 'settings', ctx);
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    return applyNamespaceItem(item, 'settings', ctx);
  }

  async validate(data: SettingsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<SettingsSection>('settings', data, msg, (section, issues) => {
      if (section.namespaces === null || typeof section.namespaces !== 'object') {
        issues.push({ path: 'namespaces', message: msg('adapter.validate.missingObject', { subject: 'namespaces' }), severity: 'error' });
      } else {
        for (const [name, rec] of Object.entries(section.namespaces)) {
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
    });
  }
}
