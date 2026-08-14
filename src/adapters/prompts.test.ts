/**
 * prompts adapter 测试：patch config 提取（systemPrompt persona / planMode sections）、
 * 同行 Skip/Conflict、目标无来源行 → Warning（诚实降级）、applyItem 合并写回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PromptsAdapter, extractPrompts, mergePromptIntoLine } from './prompts.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PromptsExportSection } from './prompts.ts';
import type { PlanItem } from '../core/types.ts';

const LINES = [
  {
    lineId: 'persona-line',
    raw: { id: 'persona-line', name: '@deepseek-ai/dsh-web', config: { systemPrompt: { persona: 'You are a helpful coding assistant.' } } },
  },
  {
    lineId: 'plan-line',
    raw: { id: 'plan-line', name: 'plan-mode', config: { planMode: { sections: [{ name: 'plan', order: 1, text: 'Plan first, then code.' }] } } },
  },
];

test('prompts: extractPrompts 提取 persona 与 planMode sections', () => {
  const prompts = extractPrompts(LINES);
  assert.equal(prompts.length, 2);
  const persona = prompts.find((p) => p.kind === 'systemPrompt');
  assert.equal(persona?.name, 'persona-line:persona');
  assert.equal(persona?.text, 'You are a helpful coding assistant.');
  assert.equal(persona?.sourceLineId, 'persona-line');
  const plan = prompts.find((p) => p.kind === 'planMode');
  assert.equal(plan?.name, 'plan');
  assert.equal(plan?.text, 'Plan first, then code.');
});

test('prompts: mergePromptIntoLine 合并 persona / planMode 文本', () => {
  // persona 更新（原为对象形态）
  const merged = mergePromptIntoLine(LINES[0]!.raw, {
    id: 'prompt:persona-line:persona', name: 'persona-line:persona', kind: 'systemPrompt',
    text: 'New persona.', sourceLineId: 'persona-line',
  });
  const config = (merged as Record<string, unknown>)['config'] as Record<string, unknown>;
  assert.equal((config['systemPrompt'] as Record<string, unknown>)['persona'], 'New persona.');

  // planMode 新增 section
  const planMerged = mergePromptIntoLine(LINES[1]!.raw, {
    id: 'prompt:plan-line:step2', name: 'step2', kind: 'planMode',
    text: 'Step two text.', sourceLineId: 'plan-line',
  });
  const planConfig = (planMerged as Record<string, unknown>)['config'] as Record<string, unknown>;
  const sections = (planConfig['planMode'] as Record<string, unknown>)['sections'] as Record<string, unknown>[];
  assert.equal(sections.length, 2);
  assert.equal(sections[1]?.['text'], 'Step two text.');
});

test('prompts: 同行同内容 Skip / 不同 Conflict(update) / 目标无 → Warning', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  for (const l of LINES) src.patchFile.lines.set(l.lineId, { lineId: l.lineId, raw: l.raw });
  const adapter = new PromptsAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.equal(exported.data.prompts.length, 2);
  const sections = new Map([['prompts', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  for (const l of LINES) dst.patchFile.lines.set(l.lineId, { lineId: l.lineId, raw: l.raw });
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.ok(items.every((i) => i.kind === 'Skip'), '目标一致 → 全部 Skip');

  // 目标 persona 不同 → Conflict（target.ref = 来源行）
  dst.patchFile.lines.set('persona-line', {
    lineId: 'persona-line',
    raw: { id: 'persona-line', name: '@deepseek-ai/dsh-web', config: { systemPrompt: { persona: 'Old persona.' } } },
  });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  const conflict = items.find((i) => i.id === 'prompt:persona-line:persona');
  assert.equal(conflict?.kind, 'Conflict');
  assert.equal(conflict?.target?.ref, 'persona-line');
  const useItem: PlanItem = { ...conflict!, kind: 'Update' };
  const r = await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(r.needsRestart, true);
  const raw = dst.patchFile.lines.get('persona-line')?.raw as Record<string, unknown>;
  const sp = (raw['config'] as Record<string, unknown>)['systemPrompt'] as Record<string, unknown>;
  assert.equal(sp['persona'], 'You are a helpful coding assistant.', 'Conflict useImported 应合并更新 persona');

  // 目标无来源行但有行名 → Create（重建行）
  const dst2 = makeContext('darwin', '/Users/bob');
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst2, sections));
  assert.ok(items.every((i) => i.kind === 'Create'), '目标无来源行但有行名 → Create 重建');
  for (const item of items) {
    const rc = await adapter.applyItem(item, makeImportContext(dst2, sections));
    assert.equal(rc.ok, true);
  }
  const created = dst2.patchFile.lines.get('persona-line')?.raw as Record<string, unknown>;
  assert.equal(((created['config'] as Record<string, unknown>)['systemPrompt'] as Record<string, unknown>)['persona'], 'You are a helpful coding assistant.');

  // 无行名的 prompt（来源信息缺失）→ Warning，不编造自动创建
  const orphan: PromptsExportSection = { version: 1, prompts: [{ id: 'p1', name: 'orphan', kind: 'systemPrompt', text: 'x' }] };
  const itemsNoName = await adapter.analyzeImport(orphan, makeImportContext(dst2, new Map([['prompts', orphan]])));
  assert.ok(itemsNoName.every((i) => i.kind === 'Warning'), '来源行名缺失 → Warning 提示手动配置');
  const w = await adapter.applyItem(itemsNoName[0]!, makeImportContext(dst2, sections));
  assert.equal(w.ok, true, 'Warning 项 applyItem 无副作用');
});

test('prompts: validate', async () => {
  const adapter = new PromptsAdapter();
  const ok = await adapter.validate({ version: 1, prompts: [{ id: 'a', name: 'n', kind: 'systemPrompt', text: 't' }] });
  assert.equal(ok.valid, true);
  const bad = await adapter.validate({ version: 1, prompts: [{ id: 'a', name: 1 as never, kind: 'systemPrompt', text: 't' }] });
  assert.equal(bad.valid, false);
});
