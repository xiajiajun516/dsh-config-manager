/**
 * providers 分区 adapter（设计 §3.3/§13.1）：
 * 数据源 = settings.yaml 的 llm-deepseek / llm-pi-ai section（providers 与 models 天然同 section，不拆文件）。
 *
 * 导入走 settings 写通道（replace llm-* namespace + 乐观锁）：
 * 每项携带 raw（该 namespace 的完整 redacted 值）用于整体写回，apiKey 值经 credentials 状态占位（不导出值）。
 */
import { isDeepStrictEqual } from 'node:util';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { ProviderEntry } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, ExportUnit, HostContext,
  ImportContext, NamespaceInfo, PlanItem, ValidationResult,
} from '../core/types.ts';
import { resolveNamespaces, isEmptyValue, type NamespaceProvider } from './settings.ts';
import { sectionMeta } from '../schema/section-registry.ts';
import { validateJsonSection } from './json-section.ts';
import { entryByteSize, filterByUnits } from './units.ts';

/** 导出记录：ProviderEntry 之外附加 namespace 级元数据（导入写回用），满足 ProvidersSection 形状 */
export interface ProviderExportEntry extends ProviderEntry {
  /** 来源 settings namespace（llm-deepseek / llm-pi-ai） */
  namespace: string;
  /** 乐观锁 revision（导入时检测并发修改） */
  revision: number;
  secrets?: { path: string[]; set: boolean }[];
  /** 该 namespace 的完整 redacted 值（导入整体写回，避免按字段重建丢失结构） */
  raw?: Record<string, unknown>;
}

export interface ProviderExportSection { version: 1; providers: Record<string, ProviderExportEntry>; }

export const DEFAULT_PROVIDER_NAMESPACES: readonly string[] = ['llm-deepseek', 'llm-pi-ai'];

/** 无 raw 时的兜底重建：只取 ProviderEntry 已知字段 */
function stripEntry(entry: ProviderExportEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['apiKeyEnv', 'displayName', 'baseURL', 'models', 'modelOverrides', 'reasoning', 'transport', 'retryPolicy'] as const) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

export class ProvidersAdapter implements ConfigAdapter<ProviderExportSection> {
  readonly id = 'providers' as const;
  // 元数据唯一来源 = 注册表（t31）：不再与 ui/export-flow.ts 的导出目录各写一份
  readonly displayName = sectionMeta('providers').displayName;
  readonly defaultIncluded = sectionMeta('providers').defaultIncluded;
  readonly portability = sectionMeta('providers').portability;
  private readonly namespaces: string[] | NamespaceProvider;

  constructor(namespaces: string[] | NamespaceProvider = DEFAULT_PROVIDER_NAMESPACES as unknown as string[]) {
    this.namespaces = namespaces;
  }

  async export(ctx: HostContext, options: ExportOptions): Promise<ExportSection<ProviderExportSection>> {
    const providers: Record<string, ProviderExportEntry> = {};
    const warnings: string[] = [];
    for (const ns of await resolveNamespaces(this.namespaces, ctx)) {
      let info: NamespaceInfo;
      try {
        info = await ctx.settings.describe(ns, { redactSecrets: true });
      } catch (err) {
        warnings.push(msgOf(ctx)('adapter.providerNsReadFailed', { ns, reason: err instanceof Error ? err.message : String(err) }));
        continue;
      }
      const value = (info.value ?? {}) as Record<string, unknown>;
      // llm-pi-ai 形态：value.providers = { route: {...} }；llm-deepseek 形态：value 即单 provider 配置
      const routes: [string, unknown][] =
        value.providers !== null && typeof value.providers === 'object'
          ? Object.entries(value.providers as Record<string, unknown>)
          : [[ns, value]];
      for (const [route, pv] of routes) {
        // 每个 route 独立深拷贝 secrets / pv / raw：同一 namespace 的多 route 若共享引用，
        // m4 强化版 createSecretScanner 的 visited 循环检测会误判「检测到循环引用」（见 providers.test.ts）。
        providers[route] = {
          route,
          namespace: ns,
          revision: info.revision,
          secrets: structuredClone(info.secrets),
          ...structuredClone(pv as Record<string, unknown>),
          raw: structuredClone(value),
        };
      }
    }
    const picked = this.pickProviders(providers, options.includeItems?.[this.id]);
    return {
      sectionId: 'providers',
      data: { version: 1, providers: picked },
      counts: { providers: Object.keys(picked).length },
      warnings,
    };
  }

  /** 单元 id：`providers:<route>`（route 是 providers 记录的键，天然唯一） */
  private unitId(route: string): string {
    return this.id + ':' + route;
  }

  /**
   * 条目级单元清单（零 I/O）：一台 provider（记录里的一个 route）= 一个单元。
   *
   * detail 给来源 namespace —— 用户靠它区分「同一个模型走哪个 ns」，不放任何 key 值。
   */
  listUnits(section: ExportSection<ProviderExportSection>): ExportUnit[] {
    return Object.entries(section.data.providers ?? {}).map(([route, entry]) => ({
      id: this.unitId(route),
      label: route,
      detail: entry.namespace,
      sizeBytes: entryByteSize(entry),
    }));
  }

  /**
   * 白名单过滤 + raw 重建。
   *
   * 为什么必须重建 raw：每个 entry.raw 存的是**整个 namespace** 的快照（导入按 namespace 整体替换）。
   * 只勾 llm-pi-ai 下的一条 route 时若原样带走 raw，未勾的 route 会随 raw 一起进包、
   * 导入时又被整 namespace 写回目标机 —— 用户看到「没勾却没生效」，选择器等于撒谎。
   * 因此这里把每个 namespace 的 raw.providers 收窄成「该 ns 里被勾选的 route」集合。
   */
  private pickProviders(
    providers: Record<string, ProviderExportEntry>,
    allow: readonly string[] | undefined,
  ): Record<string, ProviderExportEntry> {
    const picked = filterByUnits(Object.entries(providers), allow, ([route]) => this.unitId(route));
    const out: Record<string, ProviderExportEntry> = {};
    const keepByNs = new Map<string, Set<string>>();
    for (const [route, entry] of picked) {
      out[route] = entry;
      const keep = keepByNs.get(entry.namespace) ?? new Set<string>();
      keep.add(route);
      keepByNs.set(entry.namespace, keep);
    }
    if (allow === undefined) return out; // 全量导出不动 raw（保持与旧备份逐字节一致）
    for (const entry of Object.values(out)) {
      const raw = entry.raw;
      if (raw === null || typeof raw !== 'object') continue;
      const pv = raw['providers'];
      if (pv === null || typeof pv !== 'object' || Array.isArray(pv)) continue;
      const keep = keepByNs.get(entry.namespace) ?? new Set<string>();
      const narrowed: Record<string, unknown> = {};
      for (const [route, value] of Object.entries(pv as Record<string, unknown>)) {
        if (keep.has(route)) narrowed[route] = value;
      }
      entry.raw = { ...raw, providers: narrowed };
    }
    return out;
  }

  async analyzeImport(data: ProviderExportSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    for (const [route, entry] of Object.entries(data.providers)) {
      const id = `provider:${route}`;
      let current: NamespaceInfo | null = null;
      let targetUnavailable = false;
      try {
        current = await ctx.target.settings.describe(entry.namespace, { redactSecrets: true });
      } catch {
        // 目标未注册该 namespace（缺少提供它的插件）→ 写入必失败，按依赖缺失处理（§15）
        targetUnavailable = true;
      }
      if (targetUnavailable) {
        items.push({
          id, kind: 'MissingDependency', adapter: 'providers',
          description: msg('adapter.providerUnregistered', { route, ns: entry.namespace }),
          severity: 'warning', target: { adapter: 'providers', ref: entry.namespace },
        });
      } else if (current !== null && isDeepStrictEqual(current.value, entry.raw ?? stripEntry(entry))) {
        // 值相等优先于「目标为空」——与 settings.planNamespaceItems 同一口径与顺序（issue #73）
        items.push({ id, kind: 'Skip', adapter: 'providers', description: msg('adapter.providerSame', { route }), severity: 'info' });
      } else if (current === null || isEmptyValue(current.value)) {
        // 目标已注册但为空**且导入值非空** → 初始化（Create）
        items.push({
          id, kind: 'Create', adapter: 'providers',
          description: msg('adapter.providerCreate', { route, ns: entry.namespace }), severity: 'info',
          target: { adapter: 'providers', ref: entry.namespace },
        });
      } else {
        items.push({
          id, kind: 'Conflict', adapter: 'providers',
          description: msg('adapter.providerDiff', { route }),
          detail: `namespace=${entry.namespace} current=${JSON.stringify(current.value)} imported=${JSON.stringify(entry.raw ?? stripEntry(entry))}`.slice(0, 200),
          severity: 'warning', target: { adapter: 'providers', ref: entry.namespace },
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const route = item.id.replace(/^provider:/, '');
    const data = ctx.sections.get('providers') as ProviderExportSection | undefined;
    const entry = data?.providers[route];
    if (!entry) return { ok: false, message: ctx.msg('adapter.providerMissing', { route }) };
    const value = entry.raw ?? stripEntry(entry);
    let expected: number | undefined;
    try {
      expected = (await ctx.target.settings.describe(entry.namespace, { redactSecrets: true })).revision;
    } catch {
      expected = undefined; // 目标 namespace 不存在（Create）
    }
    await ctx.target.settings.replace(entry.namespace, value, expected);
    return { ok: true };
  }

  async validate(data: ProviderExportSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    return validateJsonSection<ProviderExportSection>('providers', data, msg, (section, issues) => {
      if (section.providers === null || typeof section.providers !== 'object') {
        issues.push({ path: 'providers', message: msg('adapter.validate.missingObject', { subject: 'providers' }), severity: 'error' });
      } else {
        for (const [route, entry] of Object.entries(section.providers)) {
          if (entry === null || typeof entry !== 'object') {
            issues.push({ path: `providers.${route}`, message: msg('adapter.validate.recordObject', { subject: 'provider' }), severity: 'error' });
            continue;
          }
          if (typeof entry.namespace !== 'string' || entry.namespace === '') {
            issues.push({ path: `providers.${route}.namespace`, message: msg('adapter.validate.sourceNamespace'), severity: 'error' });
          }
          if (typeof entry.revision !== 'number') {
            issues.push({ path: `providers.${route}.revision`, message: msg('adapter.validate.number', { subject: 'revision' }), severity: 'error' });
          }
        }
      }
    });
  }
}
