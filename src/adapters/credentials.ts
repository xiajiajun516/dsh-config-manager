/**
 * credentialsStatus 分区 adapter（设计 §3.3/§7.1）：
 * 数据源 = ctx.credentials.describe(ref) 的状态（configured/source/writable），
 * 以及 settings secrets 标记 / llm apiKeyEnv 中引用的凭据 ref 名。
 *
 * 安全不变量：永不导出值（hasValue 恒 false）；导入生成 MissingSecret 清单，
 * 用户补录值经 ctx.secretInputs / decryptedCredentials（仅内存）→ credentials.set()。
 * .credentials.yaml 文件字节交由 m4 加密层处理，本 adapter 不触碰。
 */
import type { CredentialStatus, CredentialsSection } from '../schema/types.ts';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { resolveNamespaces, type NamespaceProvider } from './settings.ts';

export type CredentialRefsProvider = (ctx: HostContext) => Promise<string[]>;

/** 缺省 ref 收集：遍历 settings namespace，收集 llm apiKeyEnv / providers[].apiKeyEnv，
 * 以及 secrets 标记中「引用类字段」（apiKeyEnv/tokenEnv…）的字段值。
 * 注意 secrets[].path[0] 是 settings 文档内的字段路径（如 ['apiKey']），本身不是凭据 ref（设计 §4.2），
 * 只有指向 env 名的引用字段才值得收集。 */
export function defaultCredentialRefs(namespaces: string[] | NamespaceProvider): CredentialRefsProvider {
  return async (ctx: HostContext): Promise<string[]> => {
    const refs = new Set<string>();
    for (const ns of await resolveNamespaces(namespaces, ctx)) {
      try {
        const info = await ctx.settings.describe(ns, { redactSecrets: true });
        const value = (info.value ?? {}) as Record<string, unknown>;
        // 引用类字段名（值 = env/凭据引用名，非秘密本身）
        const REFERENCE_REF_FIELDS = new Set([
          'apikeyenv', 'api_key_env', 'apikeyname', 'tokenenv', 'accesstokenenv',
          'refreshtokenenv', 'clientsecretenv', 'passwordenv',
        ]);
        for (const s of info.secrets) {
          const first = s.path?.[0];
          if (typeof first !== 'string' || first === '') continue;
          const norm = first.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (!REFERENCE_REF_FIELDS.has(norm)) continue;
          const val = value[first];
          if (typeof val === 'string' && val !== '') refs.add(val);
        }
        if (typeof value['apiKeyEnv'] === 'string' && value['apiKeyEnv'] !== '') refs.add(value['apiKeyEnv'] as string);
        const providers = value['providers'];
        if (providers !== null && typeof providers === 'object') {
          for (const pv of Object.values(providers as Record<string, { apiKeyEnv?: unknown }>)) {
            if (pv !== null && typeof pv === 'object' && typeof pv.apiKeyEnv === 'string' && pv.apiKeyEnv !== '') {
              refs.add(pv.apiKeyEnv);
            }
          }
        }
      } catch {
        // namespace 不存在则跳过
      }
    }
    return [...refs];
  };
}

export interface CredentialsAdapterOptions {
  /** 凭据 ref 名收集器（缺省从 settings 推断） */
  refs?: CredentialRefsProvider;
  /** 供缺省 refs 使用的 namespace 清单 */
  namespaces?: string[] | NamespaceProvider;
}

export class CredentialsAdapter implements ConfigAdapter<CredentialsSection> {
  readonly id = 'credentialsStatus' as const;
  readonly displayName = 'Credentials';
  readonly defaultIncluded = true;
  readonly portability = 'deviceSpecific' as const;
  private readonly refs: CredentialRefsProvider;

  constructor(options: CredentialsAdapterOptions = {}) {
    this.refs = options.refs ?? defaultCredentialRefs(options.namespaces ?? []);
  }

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<CredentialsSection>> {
    const credentials: CredentialStatus[] = [];
    const warnings: string[] = [];
    for (const ref of await this.refs(ctx)) {
      try {
        const status = await ctx.credentials.describe(ref);
        credentials.push({
          ref,
          required: true,
          configured: status.configured,
          source: (status.source as CredentialStatus['source']) ?? 'file',
          hasValue: false, // 值未导出（安全不变量）
        });
      } catch (err) {
        warnings.push(msgOf(ctx)('adapter.credStatusReadFailed', { ref, reason: err instanceof Error ? err.message : String(err) }));
      }
    }
    return {
      sectionId: 'credentialsStatus',
      data: { version: 1, credentials },
      counts: { credentials: credentials.length },
      warnings,
    };
  }

  async analyzeImport(_data: CredentialsSection, _ctx: ImportContext): Promise<PlanItem[]> {
    // MissingSecret 计划项由引擎在 createImportPlan 兜底生成（analyzer.ensureMissingSecrets），
    // 依据 = 本分区里 configured=true 的凭据 → 用户补录清单。这里保持零写入纯计算。
    return [];
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: ctx.msg('adapter.missingTargetRef') };
    const value = ctx.secretInputs[ref] ?? ctx.decryptedCredentials?.get(ref);
    if (value === undefined || value === '') return { ok: false, message: ctx.msg('adapter.credentialValueMissing') };
    await ctx.target.credentials.set(ref, value);
    return { ok: true };
  }

  async validate(data: CredentialsSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'credentials' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.credentials)) {
      issues.push({ path: 'credentials', message: msg('adapter.validate.array', { subject: 'credentials' }), severity: 'error' });
    } else {
      for (const c of data.credentials) {
        if (c === null || typeof c !== 'object' || typeof c.ref !== 'string' || c.ref === '') {
          issues.push({ path: 'credentials[]', message: msg('adapter.validate.credentialRef'), severity: 'error' });
        }
        if (c.hasValue === true) {
          // 安全不变量：普通导出恒不携带值；若备份声称有值，视为结构异常
          issues.push({ path: `credentials.${c.ref}.hasValue`, message: msg('adapter.validate.hasValueFalse'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
