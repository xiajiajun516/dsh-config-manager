/**
 * prompts 分区 adapter（设计 §3.3/§1.2）：
 * 数据源 = 组合 patch config 中的 systemPrompt persona / plan-mode section（研究报告 §2.2：
 * DSH 无独立 prompt/rules 文件，persona 与 plan-mode 均经 patch config 注入）。
 *
 * v1 策略（诚实降级）：
 *  - 目标存在同 lineId 行 → 同内容 Skip / 不同 Conflict（更新该行 config）；
 *  - 目标无该行但存在同名 prompt → Conflict（更新其所在行）；
 *  - 均不存在 → Warning（不编造行名自动创建，提示手动配置）。
 * rules/commands 无独立存储（研究报告 §2.2），不实现。
 */
import { isDeepStrictEqual } from 'node:util';
import { msgOf, zhMsg } from '../core/messages.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { PromptEntry, PromptsSection } from '../schema/types.ts';
import type {
  ApplyResult, ConfigAdapter, ExportOptions, ExportSection, HostContext,
  ImportContext, PlanItem, ValidationResult,
} from '../core/types.ts';
import { USER_PATCH_FILE } from './plugins.ts';

/** 导出记录：PromptEntry 之外记录来源行名（导入需要重建行时使用） */
export interface PromptExportEntry extends PromptEntry {
  sourceLineName?: string;
}

export interface PromptsExportSection { version: 1; prompts: PromptExportEntry[]; }

/** 从 patch 行 config 中提取 prompt 条目（systemPrompt.persona / planMode.sections[].text） */
export function extractPrompts(lines: { lineId: string; raw: unknown }[]): PromptExportEntry[] {
  const prompts: PromptExportEntry[] = [];
  for (const line of lines) {
    for (const entry of entriesOf(line.raw)) {
      const config = entry.config;
      if (config === null || typeof config !== 'object') continue;
      const c = config as Record<string, unknown>;
      const sourceLineName = typeof entry.name === 'string' ? entry.name : undefined;

      const sp = c['systemPrompt'];
      if (typeof sp === 'string' && sp.trim() !== '') {
        prompts.push({ id: `prompt:${line.lineId}:persona`, name: `${line.lineId}:persona`, kind: 'systemPrompt', text: sp, sourceLineId: line.lineId, sourceLineName });
      } else if (sp !== null && typeof sp === 'object' && typeof (sp as Record<string, unknown>)['persona'] === 'string') {
        const persona = (sp as Record<string, unknown>)['persona'] as string;
        if (persona.trim() !== '') {
          prompts.push({ id: `prompt:${line.lineId}:persona`, name: `${line.lineId}:persona`, kind: 'systemPrompt', text: persona, sourceLineId: line.lineId, sourceLineName });
        }
      }

      const pm = c['planMode'];
      if (pm !== null && typeof pm === 'object' && Array.isArray((pm as Record<string, unknown>)['sections'])) {
        const sections = (pm as Record<string, unknown>)['sections'] as Record<string, unknown>[];
        for (const [i, s] of sections.entries()) {
          if (s === null || typeof s !== 'object' || typeof s['text'] !== 'string' || (s['text'] as string).trim() === '') continue;
          const name = typeof s['name'] === 'string' && s['name'] !== '' ? s['name'] : `${line.lineId}:section${i}`;
          prompts.push({ id: `prompt:${line.lineId}:${name}`, name, kind: 'planMode', text: s['text'] as string, sourceLineId: line.lineId, sourceLineName });
        }
      }
    }
  }
  return prompts;
}

/** patch 行 → 可枚举 entry（兼容单行与 insert 块；与 mcp.ts 共用形态） */
function entriesOf(raw: unknown): { id?: unknown; name?: unknown; config?: unknown }[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['insert'])) {
    return obj['insert']
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .map((e) => e as { id?: unknown; name?: unknown; config?: unknown });
  }
  if (obj['id'] !== undefined || obj['name'] !== undefined) {
    return [obj as { id?: unknown; name?: unknown; config?: unknown }];
  }
  return [];
}

/** 把 prompt 文本合并进目标行 config（systemPrompt.persona 或 planMode.sections） */
export function mergePromptIntoLine(raw: unknown, prompt: PromptExportEntry): Record<string, unknown> {
  const cloned = structuredClone(raw) as Record<string, unknown>;
  if (cloned['config'] === null || typeof cloned['config'] !== 'object') cloned['config'] = {};
  const config = cloned['config'] as Record<string, unknown>;
  if (prompt.kind === 'systemPrompt') {
    const sp = config['systemPrompt'];
    if (typeof sp === 'string') config['systemPrompt'] = { persona: sp };
    else if (sp === null || typeof sp !== 'object') config['systemPrompt'] = { persona: prompt.text };
    else (config['systemPrompt'] as Record<string, unknown>)['persona'] = prompt.text;
  } else {
    if (config['planMode'] === null || typeof config['planMode'] !== 'object') config['planMode'] = {};
    const pm = config['planMode'] as Record<string, unknown>;
    if (!Array.isArray(pm['sections'])) pm['sections'] = [];
    const sections = pm['sections'] as Record<string, unknown>[];
    const sec = sections.find((s) => s !== null && typeof s === 'object' && s['name'] === prompt.name);
    if (sec) sec['text'] = prompt.text;
    else sections.push({ name: prompt.name, text: prompt.text });
  }
  return cloned;
}

/** 由导出条目构造「重建行」raw（Create 导入用；行名取自来源行，缺失时用占位名） */
export function buildPromptLine(lineId: string, prompt: PromptExportEntry): Record<string, unknown> {
  const name = prompt.sourceLineName ?? 'dsh-config-manager';
  if (prompt.kind === 'planMode') {
    return { id: lineId, name, config: { planMode: { sections: [{ name: prompt.name, text: prompt.text }] } } };
  }
  return { id: lineId, name, config: { systemPrompt: { persona: prompt.text } } };
}

export class PromptsAdapter implements ConfigAdapter<PromptsExportSection> {
  readonly id = 'prompts' as const;
  readonly displayName = 'Prompts';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;

  async export(ctx: HostContext, _options: ExportOptions): Promise<ExportSection<PromptsExportSection>> {
    const warnings: string[] = [];
    let lines: { lineId: string; raw: unknown }[] = [];
    try {
      lines = await ctx.patchFile.readPatchLines(USER_PATCH_FILE);
    } catch (err) {
      warnings.push(msgOf(ctx)('adapter.patchReadFailedPrompts', { reason: err instanceof Error ? err.message : String(err) }));
    }
    const prompts = extractPrompts(lines);
    return {
      sectionId: 'prompts',
      data: { version: 1, prompts },
      counts: { prompts: prompts.length },
      warnings,
    };
  }

  async analyzeImport(data: PromptsExportSection, ctx: ImportContext): Promise<PlanItem[]> {
    const msg = ctx.msg;
    const items: PlanItem[] = [];
    const targetLines = await ctx.target.patchFile.readPatchLines(USER_PATCH_FILE);
    const targetPrompts = extractPrompts(targetLines);
    for (const p of data.prompts) {
      const id = p.id;
      const sameName = targetPrompts.find((t) => t.name === p.name);
      const targetLine = targetLines.find((l) => l.lineId === p.sourceLineId);
      if (targetLine && sameName && sameName.sourceLineId === p.sourceLineId) {
        if (sameName.text === p.text && sameName.kind === p.kind) {
          items.push({ id, kind: 'Skip', adapter: 'prompts', description: msg('adapter.promptSame', { name: p.name }), severity: 'info' });
        } else {
          items.push({
            id, kind: 'Conflict', adapter: 'prompts',
            description: msg('adapter.promptDiff', { name: p.name }),
            detail: `行 ${p.sourceLineId} current=${JSON.stringify(sameName.text).slice(0, 80)} imported=${JSON.stringify(p.text).slice(0, 80)}`,
            severity: 'warning',
            target: { adapter: 'prompts', ref: p.sourceLineId ?? '' },
          });
        }
      } else if (sameName) {
        // 目标存在同名 prompt（不同来源行）→ 更新其所在行
        if (sameName.text === p.text && sameName.kind === p.kind) {
          items.push({ id, kind: 'Skip', adapter: 'prompts', description: msg('adapter.promptSame', { name: p.name }), severity: 'info' });
        } else {
          items.push({
            id, kind: 'Conflict', adapter: 'prompts',
            description: msg('adapter.promptDiffWithLine', { name: p.name, line: sameName.sourceLineId ?? '' }),
            severity: 'warning',
            target: { adapter: 'prompts', ref: sameName.sourceLineId ?? '' },
          });
        }
      } else if (p.sourceLineName) {
        // 目标无来源行但记录到行名 → 重建行（Create）；幂等键 = 行 id
        const lineId = p.sourceLineId ?? `prompt-${p.name}`;
        items.push({
          id, kind: 'Create', adapter: 'prompts',
          description: msg('adapter.promptCreate', { name: p.name, line: lineId }), severity: 'info',
          target: { adapter: 'prompts', ref: lineId },
        });
      } else {
        items.push({
          id, kind: 'Warning', adapter: 'prompts',
          description: msg('adapter.promptManual', { name: p.name }),
          severity: 'info',
        });
      }
    }
    return items;
  }

  async applyItem(item: PlanItem, ctx: ImportContext): Promise<ApplyResult> {
    const msg = ctx.msg;
    if (item.kind === 'Warning') return { ok: true, message: msg('adapter.promptWarningNoWrite') };
    const ref = item.target?.ref;
    if (!ref) return { ok: false, message: msg('adapter.missingTargetRef') };
    const data = ctx.sections.get('prompts') as PromptsExportSection | undefined;
    const prompt = data?.prompts.find((p) => p.id === item.id);
    if (!prompt) return { ok: false, message: msg('adapter.promptMissing', { id: item.id }) };
    // Create：目标无来源行 → 用记录的行名重建 patch 行（insert）
    if (item.kind === 'Create') {
      const raw = buildPromptLine(ref, prompt);
      await ctx.target.patchFile.applyPatchChanges(USER_PATCH_FILE, [
        { lineId: ref, raw, action: 'insert' },
      ]);
      return { ok: true, needsRestart: true, message: msg('adapter.promptCreated', { name: prompt.name, ref }) };
    }
    // Update / Conflict(useImported)：合并进目标行 config
    const lines = await ctx.target.patchFile.readPatchLines(USER_PATCH_FILE);
    const line = lines.find((l) => l.lineId === ref);
    if (!line) return { ok: false, message: msg('adapter.patchLineMissing', { ref }) };
    const newRaw = mergePromptIntoLine(line.raw, prompt);
    await ctx.target.patchFile.applyPatchChanges(USER_PATCH_FILE, [
      { lineId: ref, raw: newRaw, action: 'update' },
    ]);
    return { ok: true, needsRestart: true, message: msg('adapter.promptWritten', { name: prompt.name, ref }) };
  }

  async validate(data: PromptsExportSection, msg: MsgFunc = zhMsg): Promise<ValidationResult> {
    const issues: ValidationResult['issues'] = [];
    if (data === null || typeof data !== 'object') {
      return { valid: false, issues: [{ path: '$', message: msg('adapter.validate.object', { subject: 'prompts' }), severity: 'error' }] };
    }
    if (data.version !== 1) {
      issues.push({ path: 'version', message: msg('adapter.validate.version', { value: String(data.version) }), severity: 'error' });
    }
    if (!Array.isArray(data.prompts)) {
      issues.push({ path: 'prompts', message: msg('adapter.validate.array', { subject: 'prompts' }), severity: 'error' });
    } else {
      for (const p of data.prompts) {
        if (p === null || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.text !== 'string') {
          issues.push({ path: 'prompts[]', message: msg('adapter.validate.promptIdentity'), severity: 'error' });
        }
      }
    }
    return { valid: issues.filter((i) => i.severity === 'error').length === 0, issues };
  }
}
