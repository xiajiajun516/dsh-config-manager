/**
 * 迁移前咨询 UI 纯渲染模型（Phase 7）单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUiT } from './i18n.ts';
import {
  consultView, consultVerdictBadgeKind, consultRecommendationBadgeKind,
  consultDimensionLabel, consultRecommendationLabel,
  dedupeConsultReasons, consultReasonGroups,
} from './migration-consult-view.ts';
import type { ConsultReport } from '../core/migration-consult.ts';

const t = makeUiT('zh');

function makeReport(over: Partial<ConsultReport> = {}): ConsultReport {
  return {
    source: { type: 'export-zip', id: '/tmp/x.zip' },
    healthScore: 100,
    verdict: 'healthy',
    recommendation: 'proceed',
    blockerCount: 0,
    attentionCount: 0,
    recommendationReasons: [],
    dimensions: [
      { id: 'compatibility', score: 100, verdict: 'healthy', issues: [] },
      { id: 'integrity', score: 100, verdict: 'healthy', issues: [] },
      { id: 'sections', score: 100, verdict: 'healthy', issues: [] },
      { id: 'consistency', score: 100, verdict: 'healthy', issues: [] },
      { id: 'sensitive', score: 100, verdict: 'healthy', issues: [] },
      { id: 'migratability', score: 100, verdict: 'healthy', issues: [] },
    ],
    willApply: { sections: ['settings'], itemCount: 3, conflicts: 0, risks: 0, overwritten: 0, dryRun: true },
    bound: { sourceId: '/tmp/x.zip' },
    generatedAt: '2026-08-25T00:00:00.000Z',
    ...over,
  };
}

test('consult-view: 健康报告 → 视图数据完整', () => {
  const view = consultView(makeReport(), t);
  assert.equal(view.healthScore, 100);
  assert.equal(view.verdict, 'healthy');
  assert.equal(view.verdictBadgeKind, 'ok');
  assert.equal(view.recommendation, 'proceed');
  assert.equal(view.recommendationBadgeKind, 'ok');
  assert.equal(view.dimensions.length, 6);
  assert.equal(view.willApply.itemCount, 3);
  assert.equal(view.willApply.dryRun, true);
});

test('consult-view: critical + block → 视图反映', () => {
  const report = makeReport({
    healthScore: 40,
    verdict: 'critical',
    recommendation: 'block',
    recommendationReasons: ['不受支持：schema 超出范围'],
    dimensions: [
      { id: 'compatibility', score: 0, verdict: 'critical', issues: [{ severity: 'error', code: 'x', message: '不受支持' }] },
    ],
  });
  const view = consultView(report, t);
  assert.equal(view.verdictBadgeKind, 'error');
  assert.equal(view.recommendationBadgeKind, 'error');
  assert.equal(view.recommendationLabel, '建议：阻止执行');
  assert.equal(view.reasons.length, 1);
});

test('consult-view: 维度 label 映射', () => {
  assert.equal(consultDimensionLabel('compatibility', t), '版本/平台兼容性');
  assert.equal(consultDimensionLabel('integrity', t), '结构完整性');
  assert.equal(consultDimensionLabel('sensitive', t), '敏感暴露');
});

test('consult-view: verdict/recommendation badge kind 映射', () => {
  assert.equal(consultVerdictBadgeKind('healthy'), 'ok');
  assert.equal(consultVerdictBadgeKind('needs-attention'), 'warn');
  assert.equal(consultVerdictBadgeKind('critical'), 'error');
  assert.equal(consultRecommendationBadgeKind('proceed'), 'ok');
  assert.equal(consultRecommendationBadgeKind('review'), 'warn');
  assert.equal(consultRecommendationBadgeKind('block'), 'error');
  assert.equal(consultRecommendationLabel('proceed', t), '建议：可继续');
  assert.equal(consultRecommendationLabel('review', t), '建议：需人工确认');
  assert.equal(consultRecommendationLabel('block', t), '建议：阻止执行');
});

/* ---------------- 建议依据：去重与分组 ---------------- */

test('consult-reasons: dedupeConsultReasons 原文去重 + 保持首现顺序 + 丢弃空串/纯空白', () => {
  const input = ['B', 'A', 'B', '', '   ', 'A', '\t', 'C'];
  assert.deepEqual(dedupeConsultReasons(input), ['B', 'A', 'C']);
  // 纯函数：不修改入参
  assert.deepEqual(input, ['B', 'A', 'B', '', '   ', 'A', '\t', 'C']);
});

test('consult-reasons: dedupeConsultReasons 不做 trim 合并（前后空格视为不同条目）', () => {
  // 规则 1 明确：只按原文去重，'A' / ' A' / 'A ' 是三个不同条目
  assert.deepEqual(dedupeConsultReasons(['A', ' A', 'A ', 'A']), ['A', ' A', 'A ']);
});

test('consult-reasons: 空数组 / 全空白 → 空结果', () => {
  assert.deepEqual(dedupeConsultReasons([]), []);
  assert.deepEqual(dedupeConsultReasons(['', '  ', '\n']), []);
  assert.deepEqual(consultReasonGroups([]), []);
  assert.deepEqual(consultReasonGroups(['', '   ']), []);
});

test('consult-reasons: consultReasonGroups 计数取原始数组，顺序 = 首次出现顺序', () => {
  assert.deepEqual(consultReasonGroups(['B', 'A', 'B', 'C', 'B', 'A']), [
    { message: 'B', count: 3 },
    { message: 'A', count: 2 },
    { message: 'C', count: 1 },
  ]);
});

test('consult-reasons: 真实场景 — 迁移项重复 3 次 + 敏感暴露重复 2 次', () => {
  const reasons = [
    '存在需注意的迁移项',
    '存在需注意的迁移项',
    '存在需注意的迁移项',
    '检测到 2 处敏感字段暴露（已脱敏）',
    '检测到 2 处敏感字段暴露（已脱敏）',
  ];
  const groups = consultReasonGroups(reasons);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { message: '存在需注意的迁移项', count: 3 });
  assert.deepEqual(groups[1], { message: '检测到 2 处敏感字段暴露（已脱敏）', count: 2 });
});

test('consult-reasons: 需求验收样例 → 2 组且第一组 count=2', () => {
  const groups = consultReasonGroups([
    '存在需注意的迁移项',
    '存在需注意的迁移项',
    '检测到 2 处敏感字段暴露（已脱敏）',
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.count, 2);
  assert.equal(groups[1]?.count, 1);
});

test('consult-reasons: 与 consultView 串联（reasons 字段语义保持不变）', () => {
  const view = consultView(makeReport({
    verdict: 'needs-attention',
    recommendation: 'review',
    recommendationReasons: ['x', 'x', 'y'],
  }), t);
  // 既有字段语义不变：仍返回原始数组（含重复）
  assert.deepEqual(view.reasons, ['x', 'x', 'y']);
  assert.deepEqual(consultReasonGroups(view.reasons), [
    { message: 'x', count: 2 },
    { message: 'y', count: 1 },
  ]);
});
