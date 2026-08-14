/**
 * report 测试（m6-ui）：§21 导出报告 / §22 导入报告 / §17 回滚报告 / 动作按钮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes, importSectionStats, renderExportReport, renderImportReport,
  renderRollbackReport, sectionFromItemId, suggestedActions,
} from './report.ts';
import { makeExportReport, makeImportResult, makeRollbackReport } from './test-helpers.ts';

test('report: sectionFromItemId 前缀推断', () => {
  assert.equal(sectionFromItemId('settings:general'), 'settings');
  assert.equal(sectionFromItemId('ui:theme'), 'ui');
  assert.equal(sectionFromItemId('provider:pi-ai'), 'providers');
  assert.equal(sectionFromItemId('plugin:x'), 'plugins');
  assert.equal(sectionFromItemId('patch:line-1'), 'plugins');
  assert.equal(sectionFromItemId('mcp:filesystem'), 'mcp');
  assert.equal(sectionFromItemId('prompt:p1'), 'prompts');
  assert.equal(sectionFromItemId('workspace:ws-1'), 'workspaces');
  assert.equal(sectionFromItemId('secret:K1'), 'credentialsStatus');
  assert.equal(sectionFromItemId('skills:my.md'), 'skills');
  assert.equal(sectionFromItemId('sessions:s1'), 'sessions');
  assert.equal(sectionFromItemId('unknown'), 'other');
});

test('report: 导出报告含 Included/Excluded/Security/File', () => {
  const text = renderExportReport(makeExportReport());
  assert.ok(text.includes('Backup Created'));
  assert.ok(text.includes('✓ settings'));
  assert.ok(text.includes('8 plugins'));
  assert.ok(text.includes('○ sessions'));
  assert.ok(text.includes('API Keys excluded: yes'));
  assert.ok(text.includes('File: dsh-config-2026-08-14.zip'));
  assert.ok(text.includes('2 sensitive field(s) redacted'));
});

test('report: 导入报告分节统计', () => {
  const result = makeImportResult();
  const stats = importSectionStats(result.executed);
  const settings = stats.find((s) => s.section === 'settings')!;
  assert.equal(settings.ok, 2);
  const plugins = stats.find((s) => s.section === 'plugins')!;
  assert.equal(plugins.ok, 1);
  assert.equal(plugins.skipped, 1);
  const secrets = stats.find((s) => s.section === 'credentialsStatus')!;
  assert.equal(secrets.skipped, 1);
});

test('report: 导入报告渲染含分节/重启/缺失 secret', () => {
  const text = renderImportReport(makeImportResult());
  assert.ok(text.includes('Import Complete'));
  assert.ok(text.includes('settings: ✓ 2 imported'));
  assert.ok(text.includes('Secrets: ⚠ 1 credentials need to be entered'));
  assert.ok(text.includes('Restart required'));
});

test('report: 失败导入渲染 Import Failed + 回滚报告', () => {
  const result = makeImportResult({
    ok: false,
    executed: [
      { itemId: 'settings:a', status: 'ok' },
      { itemId: 'mcp:m', status: 'failed', message: 'npx not found' },
    ],
    rollback: makeRollbackReport(),
  });
  const text = renderImportReport(result);
  assert.ok(text.includes('Import Failed'));
  assert.ok(text.includes('Rollback partially completed.'));
  assert.ok(text.includes('manual recovery'));
  assert.ok(text.includes('npx not found'));
});

test('report: 回滚报告 full / partial', () => {
  assert.ok(renderRollbackReport({ full: true, restored: [], failed: [] }).includes('完整恢复'));
  const partial = renderRollbackReport(makeRollbackReport());
  assert.ok(partial.includes('Rollback partially completed.'));
  assert.ok(partial.includes('请手动安装'));
});

test('report: suggestedActions 顺序（fixIssues → viewDetails → done）', () => {
  assert.deepEqual(suggestedActions(makeImportResult()), ['viewDetails', 'done']);
  const failed = makeImportResult({
    executed: [{ itemId: 'mcp:m', status: 'failed' }],
  });
  assert.deepEqual(suggestedActions(failed), ['fixIssues', 'viewDetails', 'done']);
});

test('report: formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(20480), '20.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});
