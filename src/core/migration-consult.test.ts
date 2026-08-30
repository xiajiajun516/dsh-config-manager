/**
 * 迁移前咨询（Phase 7）核心评分单测。
 * 覆盖：各维度 healthy/needs-attention/critical、HealthScore 加权、verdict、
 * recommendation 三态、一致性检查、敏感暴露、可迁移性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConsultReport, computeDimensions, scoreCompatibility, scoreConsistency,
  scoreIntegrity, scoreSections, scoreSensitive, scoreMigratability,
  type ConsultSourceData, type ConsultTarget, type MigratabilityResult,
} from './migration-consult.ts';
import type { Manifest, SectionId } from '../schema/types.ts';

const TARGET: ConsultTarget = { targetDsh: '0.1.54', targetPlatform: 'win32' };

function makeManifest(over: Partial<Manifest> = {}): Manifest {
  const sections = {} as Record<SectionId, boolean>;
  for (const sid of ['settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills', 'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles', 'credentialsStatus', 'secrets', 'sessions', 'self'] as SectionId[]) {
    sections[sid] = false;
  }
  sections.settings = true;
  sections.providers = true;
  sections.credentialsStatus = true;
  return {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: '0.1.54' },
    source: { dshVersion: '0.1.54', platform: 'win32', arch: 'x64' },
    exportedAt: '2026-08-25T00:00:00.000Z',
    sections,
    security: { containsSecrets: false, encrypted: false, encryption: null },
    ...over,
  };
}

function makeData(over: Partial<ConsultSourceData> = {}): ConsultSourceData {
  const manifest = makeManifest();
  return {
    source: { type: 'export-zip', id: '/tmp/backup.zip' },
    manifest,
    manifestIssues: [],
    sections: new Map<SectionId, unknown>([
      ['settings', { version: 1, namespaces: {} }],
      ['providers', { version: 1, providers: {} }],
      ['credentialsStatus', { version: 1, credentials: [] }],
    ]),
    sectionFiles: new Map(),
    checksums: {},
    checksumIssues: [],
    zipSlipIssues: [],
    encrypted: false,
    containsSecrets: false,
    sourceDsh: '0.1.54',
    sourcePlatform: 'win32',
    schemaVersion: 1,
    missingSections: [],
    sensitiveHits: [],
    migratability: { ok: true, itemCount: 5, fatalConflicts: 0, warnings: 0, sections: ['settings', 'providers'], errors: [] },
    ...over,
  };
}

/* ---------------- 兼容性维度 ---------------- */

test('consult: 兼容性 excellent → 100 healthy', () => {
  const d = scoreCompatibility(makeData(), TARGET);
  assert.equal(d.score, 100);
  assert.equal(d.verdict, 'healthy');
  assert.equal(d.issues.length, 0);
});

test('consult: 兼容性 partial（跨平台）→ 60 needs-attention + warning', () => {
  const data = makeData({ sourcePlatform: 'darwin' });
  const d = scoreCompatibility(data, TARGET);
  assert.equal(d.score, 60);
  assert.equal(d.verdict, 'needs-attention');
  assert.ok(d.issues.some((i) => i.code === 'compatibility.partial'));
});

test('consult: 兼容性 unsupported（schema 过新）→ 0 critical + error', () => {
  const data = makeData({ schemaVersion: 99 });
  const d = scoreCompatibility(data, TARGET);
  assert.equal(d.score, 0);
  assert.equal(d.verdict, 'critical');
  assert.ok(d.issues.some((i) => i.code === 'compatibility.unsupported'));
});

test('consult: manifest 缺失 → 兼容性 0 critical', () => {
  const d = scoreCompatibility(makeData({ manifest: null }), TARGET);
  assert.equal(d.score, 0);
  assert.equal(d.verdict, 'critical');
});

/* ---------------- 完整性维度 ---------------- */

test('consult: 完整性无问题 → 100 healthy', () => {
  const d = scoreIntegrity(makeData());
  assert.equal(d.score, 100);
  assert.equal(d.verdict, 'healthy');
});

test('consult: manifest 缺失 → 完整性 0 critical', () => {
  const d = scoreIntegrity(makeData({ manifest: null }));
  assert.equal(d.score, 0);
  assert.equal(d.verdict, 'critical');
});

test('consult: manifest error issue → 扣 30', () => {
  const data = makeData({ manifestIssues: [{ path: 'schemaVersion', message: '必须是数字', severity: 'error' }] });
  const d = scoreIntegrity(data);
  assert.equal(d.score, 70);
  assert.equal(d.verdict, 'needs-attention');
});

test('consult: checksum mismatch → 扣 30', () => {
  const data = makeData({ checksumIssues: ['config/settings.json (hash 不符)'] });
  const d = scoreIntegrity(data);
  assert.equal(d.score, 70);
  assert.ok(d.issues.some((i) => i.code === 'integrity.checksumMismatch'));
});

test('consult: zip slip → 扣 30', () => {
  const data = makeData({ zipSlipIssues: ['../evil'] });
  const d = scoreIntegrity(data);
  assert.equal(d.score, 70);
  assert.ok(d.issues.some((i) => i.code === 'integrity.zipSlip'));
});

/* ---------------- 分区完整性维度 ---------------- */

test('consult: 分区无缺失 → 100 healthy', () => {
  const d = scoreSections(makeData());
  assert.equal(d.score, 100);
});

test('consult: missingSections 每个 -20', () => {
  const data = makeData({ missingSections: ['settings', 'providers'] });
  const d = scoreSections(data);
  assert.equal(d.score, 60);
  assert.equal(d.verdict, 'needs-attention');
});

test('consult: 声明但数据缺失（非 missingSections）→ -30', () => {
  // manifest 声明 settings/providers/credentialsStatus，但 sections 只含 settings
  const data = makeData({
    sections: new Map<SectionId, unknown>([['settings', { version: 1, namespaces: {} }]]),
  });
  const d = scoreSections(data);
  // providers + credentialsStatus 各 -30 → 40
  assert.equal(d.score, 40);
  assert.equal(d.verdict, 'critical');
});

/* ---------------- 一致性维度 ---------------- */

test('consult: 无悬空凭据引用 → 100 healthy', () => {
  const d = scoreConsistency(makeData());
  assert.equal(d.score, 100);
});

test('consult: 悬空凭据引用 → 每个 -15', () => {
  const data = makeData({
    sections: new Map<SectionId, unknown>([
      ['settings', { version: 1, namespaces: { web: { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } } }],
      ['providers', { version: 1, providers: {} }],
      ['credentialsStatus', { version: 1, credentials: [] }],
    ]),
  });
  const d = scoreConsistency(data);
  assert.equal(d.score, 85);
  assert.equal(d.verdict, 'needs-attention');
  assert.ok(d.issues.some((i) => i.code === 'consistency.danglingCredentialRef'));
});

test('consult: 已声明凭据引用 → 不报悬空', () => {
  const data = makeData({
    sections: new Map<SectionId, unknown>([
      ['settings', { version: 1, namespaces: { web: { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } } }],
      ['providers', { version: 1, providers: {} }],
      ['credentialsStatus', { version: 1, credentials: [{ ref: 'DEEPSEEK_API_KEY', required: true, configured: true, source: 'file', hasValue: false }] }],
    ]),
  });
  const d = scoreConsistency(data);
  assert.equal(d.score, 100);
  assert.equal(d.issues.length, 0);
});

/* ---------------- 敏感暴露维度 ---------------- */

test('consult: 无敏感暴露 → 100 healthy', () => {
  const d = scoreSensitive(makeData());
  assert.equal(d.score, 100);
});

test('consult: 未加密秘密 → -40 critical', () => {
  const data = makeData({ containsSecrets: true, encrypted: false });
  const d = scoreSensitive(data);
  assert.equal(d.score, 60);
  assert.equal(d.verdict, 'needs-attention');
  assert.ok(d.issues.some((i) => i.code === 'sensitive.unencryptedSecrets'));
});

test('consult: 敏感命中 → 每个 -5 封顶 -40', () => {
  const data = makeData({ sensitiveHits: [{ path: 'a', field: 'token' }, { path: 'b', field: 'password' }] });
  const d = scoreSensitive(data);
  assert.equal(d.score, 90);
  assert.equal(d.verdict, 'healthy');
});

test('consult: 敏感命中封顶 -40', () => {
  const data = makeData({ sensitiveHits: Array.from({ length: 20 }, (_, i) => ({ path: `p${i}`, field: 'token' })) });
  const d = scoreSensitive(data);
  assert.equal(d.score, 60);
});

/* ---------------- 可迁移性维度 ---------------- */

test('consult: 可迁移性 ok → 100 healthy', () => {
  const d = scoreMigratability(makeData());
  assert.equal(d.score, 100);
});

test('consult: 可迁移性 null → 60 needs-attention', () => {
  const d = scoreMigratability(makeData({ migratability: null }));
  assert.equal(d.score, 60);
  assert.equal(d.verdict, 'needs-attention');
});

test('consult: 可迁移性 !ok → 0 critical', () => {
  const m: MigratabilityResult = { ok: false, itemCount: 0, fatalConflicts: 0, warnings: 0, sections: [], errors: ['致命错误'] };
  const d = scoreMigratability(makeData({ migratability: m }));
  assert.equal(d.score, 0);
  assert.equal(d.verdict, 'critical');
});

test('consult: 致命冲突 → 每个 -30', () => {
  const m: MigratabilityResult = { ok: true, itemCount: 3, fatalConflicts: 2, warnings: 0, sections: [], errors: [] };
  const d = scoreMigratability(makeData({ migratability: m }));
  assert.equal(d.score, 40);
  assert.equal(d.verdict, 'critical');
});

/* ---------------- 汇总：HealthScore / verdict / recommendation ---------------- */

test('consult: 全健康 → healthScore 100, verdict healthy, recommendation proceed', () => {
  const report = computeConsultReport(makeData(), TARGET);
  assert.equal(report.healthScore, 100);
  assert.equal(report.verdict, 'healthy');
  assert.equal(report.recommendation, 'proceed');
  assert.equal(report.recommendationReasons.length, 0);
});

test('consult: 加权平均正确', () => {
  // 让 sensitive 维度 = 60（未加密秘密），其余 100
  const data = makeData({ containsSecrets: true, encrypted: false });
  const report = computeConsultReport(data, TARGET);
  // 加权 = 0.20*100 + 0.25*100 + 0.20*100 + 0.10*100 + 0.15*60 + 0.10*100 = 100 - 6 = 94
  assert.equal(report.healthScore, 94);
  assert.equal(report.verdict, 'needs-attention');
  assert.equal(report.recommendation, 'review');
});

test('consult: critical + allowBlock → block', () => {
  const data = makeData({ schemaVersion: 99 }); // compatibility 0 → critical
  const report = computeConsultReport(data, TARGET, { allowBlock: true });
  assert.equal(report.verdict, 'critical');
  assert.equal(report.recommendation, 'block');
});

test('consult: critical + 不允许 block → review', () => {
  const data = makeData({ schemaVersion: 99 });
  const report = computeConsultReport(data, TARGET, { allowBlock: false });
  assert.equal(report.verdict, 'critical');
  assert.equal(report.recommendation, 'review');
});

test('consult: needs-attention → review + 触发项', () => {
  const data = makeData({ missingSections: ['settings'] });
  const report = computeConsultReport(data, TARGET);
  assert.equal(report.verdict, 'needs-attention');
  assert.equal(report.recommendation, 'review');
  assert.ok(report.recommendationReasons.length > 0);
});

test('consult: willApply 来自 migratability，dryRun 恒 true', () => {
  const report = computeConsultReport(makeData(), TARGET);
  assert.equal(report.willApply.itemCount, 5);
  assert.equal(report.willApply.sections.length, 2);
  assert.equal(report.willApply.dryRun, true);
});

test('consult: bound 关联 manifest 与 snapshotId', () => {
  const data = makeData({ source: { type: 'local-snapshot', id: 'snap-1', snapshotId: 'snap-1' } });
  const report = computeConsultReport(data, TARGET);
  assert.equal(report.bound.sourceId, 'snap-1');
  assert.equal(report.bound.snapshotId, 'snap-1');
  assert.ok(report.bound.manifest !== undefined);
});

test('consult: 确定性（同一源两次评分一致）', () => {
  const data = makeData({ missingSections: ['settings'], containsSecrets: true, encrypted: false });
  const a = computeConsultReport(data, TARGET);
  const b = computeConsultReport(data, TARGET);
  assert.equal(a.healthScore, b.healthScore);
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.recommendation, b.recommendation);
  assert.deepEqual(a.dimensions.map((d) => d.score), b.dimensions.map((d) => d.score));
});

test('consult: computeDimensions 返回 6 个维度', () => {
  const dims = computeDimensions(makeData(), TARGET);
  assert.equal(dims.length, 6);
  const ids = dims.map((d) => d.id);
  assert.deepEqual(ids, ['compatibility', 'integrity', 'sections', 'consistency', 'sensitive', 'migratability']);
});
