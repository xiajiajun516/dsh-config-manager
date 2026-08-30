/**
 * 迁移前咨询 UI 纯渲染模型（Phase 7）单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUiT } from './i18n.ts';
import {
  consultView, consultVerdictBadgeKind, consultRecommendationBadgeKind,
  consultDimensionLabel, consultRecommendationLabel,
} from './migration-consult-view.ts';
import type { ConsultReport } from '../core/migration-consult.ts';

const t = makeUiT('zh');

function makeReport(over: Partial<ConsultReport> = {}): ConsultReport {
  return {
    source: { type: 'export-zip', id: '/tmp/x.zip' },
    healthScore: 100,
    verdict: 'healthy',
    recommendation: 'proceed',
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
