/**
 * m-sync-flow：分级自动应用策略测试。
 * 覆盖：风险映射、首次强制预览、决策分流、形状 contract、互斥分组。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SECTION_RISK_TIER, classifyMergePlan, summarizeApplyPlan } from './risk.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';

const sec = (
  id: MergeSectionResult['id'],
  decision: MergeSectionResult['decision'],
  merged?: MergeSectionResult['merged'],
  conflicts: MergeSectionResult['conflicts'] = [],
): MergeSectionResult => ({ id, decision, conflicts, ...(merged !== undefined ? { merged } : {}) });

test('SECTION_RISK_TIER：规划表约定的映射正确', () => {
  assert.equal(SECTION_RISK_TIER.settings, 'low');
  assert.equal(SECTION_RISK_TIER.ui, 'low');
  assert.equal(SECTION_RISK_TIER.providers, 'low');
  assert.equal(SECTION_RISK_TIER.prompts, 'low');
  assert.equal(SECTION_RISK_TIER.workspaces, 'medium');
  assert.equal(SECTION_RISK_TIER.plugins, 'medium');
  assert.equal(SECTION_RISK_TIER.mcp, 'medium');
  assert.equal(SECTION_RISK_TIER.credentialsStatus, 'high');
  assert.equal(SECTION_RISK_TIER.secrets, 'high');
});

test('classifyMergePlan：firstSync=false 时低风险 useRemote/keepLocal → autoApply', () => {
  const plan: MergePlan = { sections: [
    sec('settings', 'useRemote', { version: 1, namespaces: {} }),
    sec('providers', 'useRemote', { version: 1, providers: {} }),
  ]};
  const out = classifyMergePlan(plan, { firstSync: false });
  assert.equal(out.autoApply.length, 2);
  assert.equal(out.review.length, 0);
  assert.equal(out.skipped.length, 0);
});

test('classifyMergePlan：firstSync=false 时中风险 → review', () => {
  const plan: MergePlan = { sections: [
    sec('workspaces', 'useRemote', { version: 1, workspaces: [] }),
    sec('plugins', 'keepLocal', { version: 1, plugins: [], patch: [] }),
    sec('mcp', 'useRemote', { version: 1, servers: [] }),
  ]};
  const out = classifyMergePlan(plan, { firstSync: false });
  assert.equal(out.autoApply.length, 0);
  assert.equal(out.review.length, 3);
  assert.equal(out.skipped.length, 0);
});

test('classifyMergePlan：firstSync=false 时 high → review（永不自动）', () => {
  const plan: MergePlan = { sections: [
    sec('credentialsStatus', 'useRemote', { version: 1, credentials: [] }),
    sec('secrets', 'keepLocal', { version: 1, files: [] } as MergeSectionResult['merged']),
  ]};
  const out = classifyMergePlan(plan, { firstSync: false });
  assert.equal(out.autoApply.length, 0);
  assert.equal(out.review.length, 2);
});

test('classifyMergePlan：双向冲突永远进 review（无论 firstSync）', () => {
  const plan: MergePlan = { sections: [
    sec('settings', 'conflict', undefined, [{ path: 'general', kind: 'key' }]),
  ]};
  assert.equal(classifyMergePlan(plan, { firstSync: false }).review.length, 1);
  assert.equal(classifyMergePlan(plan, { firstSync: true }).review.length, 1);
});

test('classifyMergePlan：firstSync=true 时所有非 skip 项一律进 review', () => {
  const plan: MergePlan = { sections: [
    sec('settings', 'useRemote', { version: 1, namespaces: {} }),
    sec('providers', 'keepLocal', { version: 1, providers: {} }),
    sec('workspaces', 'useRemote', { version: 1, workspaces: [] }),
    sec('settings', 'skip'), // 重复测试：skip 永远进 skipped
  ]};
  const out = classifyMergePlan(plan, { firstSync: true });
  assert.equal(out.review.length, 3, '低+中风险全部进 review');
  assert.equal(out.autoApply.length, 0);
  assert.equal(out.skipped.length, 1);
});

test('classifyMergePlan：决策为 skip → skipped（与 firstSync 无关）', () => {
  const plan: MergePlan = { sections: [sec('settings', 'skip')] };
  assert.equal(classifyMergePlan(plan, { firstSync: false }).skipped.length, 1);
  assert.equal(classifyMergePlan(plan, { firstSync: true }).skipped.length, 1);
});

test('classifyMergePlan：同一 section 不出现在多个分组', () => {
  const plan: MergePlan = { sections: [
    sec('settings', 'useRemote', { version: 1, namespaces: {} }),
    sec('providers', 'skip'),
    sec('workspaces', 'conflict', undefined, [{ path: '$', kind: 'key' }]),
    sec('mcp', 'keepLocal', { version: 1, servers: [] }),
  ]};
  const out = classifyMergePlan(plan, { firstSync: false });
  const seen = new Set<string>();
  for (const bucket of [out.autoApply, out.review, out.skipped]) {
    for (const r of bucket) {
      assert.ok(!seen.has(r.id), `section ${r.id} 出现在多个分组`);
      seen.add(r.id);
    }
  }
  assert.equal(out.autoApply.length, 1, 'settings → autoApply');
  assert.equal(out.review.length, 2, 'workspaces conflict + mcp medium → review');
  assert.equal(out.skipped.length, 1, 'providers skip → skipped');
});

test('classifyMergePlan：输出 SyncApplyPlan 形状符合 contract', () => {
  const plan: MergePlan = { sections: [] };
  const out = classifyMergePlan(plan, { firstSync: false });
  assert.ok(Array.isArray(out.autoApply));
  assert.ok(Array.isArray(out.review));
  assert.ok(Array.isArray(out.skipped));
});

test('summarizeApplyPlan：计数正确', () => {
  const plan: MergePlan = { sections: [
    sec('settings', 'useRemote', { version: 1, namespaces: {} }),
    sec('providers', 'useRemote', { version: 1, providers: {} }),
    sec('workspaces', 'useRemote', { version: 1, workspaces: [] }),
    sec('settings', 'skip'),
  ]};
  const apply = classifyMergePlan(plan, { firstSync: false });
  const sum = summarizeApplyPlan(apply);
  assert.equal(sum.autoApplyCount, 2);
  assert.equal(sum.reviewCount, 1);
  assert.equal(sum.skippedCount, 1);
  assert.equal(sum.totalCount, 4);
});
