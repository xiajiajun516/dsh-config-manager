/**
 * report 测试（m6-ui）：§21 导出报告 / §22 导入报告 / §17 回滚报告 / 动作按钮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportCountsText, formatBytes, importProblems, importSectionStats, importTotals,
  renderExportReport, renderImportReport, renderRollbackReport, sectionFromItemId, suggestedActions,
} from './report.ts';
import { makeUiT } from './i18n.ts';
import { makeExportReport, makeImportResult, makeRollbackReport } from './test-helpers.ts';

const enT = makeUiT('en');
const zhT = makeUiT('zh');

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

test('report: 导出报告含 Included/Excluded/Security/File（en / zh）', () => {
  const enText = renderExportReport(makeExportReport(), enT);
  assert.ok(enText.includes('Backup Created'));
  assert.ok(enText.includes('✓ settings'));
  assert.ok(enText.includes('8 plugins'));
  assert.ok(enText.includes('○ sessions'));
  assert.ok(enText.includes('API Keys excluded: yes'));
  assert.ok(enText.includes('File: dsh-config-2026-08-14.zip'));
  assert.ok(enText.includes('2 sensitive field(s) redacted'));
  const zhText = renderExportReport(makeExportReport(), zhT);
  assert.ok(zhText.includes('备份已创建'));
});

test('report: exportCountsText —— 计数单位中文化（zh/en），未知单位键原样回退', () => {
  assert.equal(exportCountsText({ namespaces: 18 }, zhT), '18 个命名空间');
  assert.equal(exportCountsText({ plugins: 10, patchLines: 11 }, zhT), '10 个插件，11 行补丁');
  assert.equal(exportCountsText({ namespaces: 18 }, enT), '18 namespace(s)');
  assert.equal(exportCountsText({ servers: 0 }, zhT), '0 个服务器', '0 是有效值，不能当空');
  assert.equal(exportCountsText({ customThing: 2 }, zhT), '2 customThing', '未知单位键原样显示，不吞信息');
  assert.equal(exportCountsText({}, zhT), '', '空 counts → 空串（由调用方渲染占位符）');
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

test('report: 导入报告渲染含分节/重启/缺失 secret（en）', () => {
  const text = renderImportReport(makeImportResult(), enT);
  assert.ok(text.includes('Import Complete'));
  assert.ok(text.includes('settings: ✓ 2 imported/restored'));
  assert.ok(text.includes('Secrets: ⚠ 1 credential(s) need to be entered'));
  assert.ok(text.includes('Plugin / MCP changes take effect'));
});

test('report: 失败导入渲染 Import Failed + 回滚报告（en）', () => {
  const result = makeImportResult({
    ok: false,
    executed: [
      { itemId: 'settings:a', status: 'ok' },
      { itemId: 'mcp:m', status: 'failed', message: 'npx not found' },
    ],
    rollback: makeRollbackReport(),
  });
  const text = renderImportReport(result, enT);
  assert.ok(text.includes('Import Failed'));
  assert.ok(text.includes('Rollback partially completed.'));
  assert.ok(text.includes('manual recovery'));
  assert.ok(text.includes('npx not found'));
});

test('report: 回滚报告 full / partial（zh 缺省 + en）', () => {
  assert.ok(renderRollbackReport({ full: true, restored: [], failed: [] }, zhT).includes('已完整恢复'));
  const partial = renderRollbackReport(makeRollbackReport(), enT);
  assert.ok(partial.includes('Rollback partially completed.'));
  assert.ok(partial.includes('manual recovery'));
  const partialZh = renderRollbackReport(makeRollbackReport(), zhT);
  assert.ok(partialZh.includes('请手动'));
});

test('report: suggestedActions 仅「完成」（报告已内联全部详情，无空操作按钮）', () => {
  assert.deepEqual(suggestedActions(makeImportResult()), ['done']);
  const failed = makeImportResult({
    executed: [{ itemId: 'mcp:m', status: 'failed' }],
  });
  assert.deepEqual(suggestedActions(failed), ['done']);
});

test('report: importTotals 汇总（ok/跳过/警告/失败 + problems 不含跳过）', () => {
  const totals = importTotals(makeImportResult().executed);
  assert.deepEqual(totals, { ok: 5, skipped: 2, warned: 0, failed: 0, problems: 0 });

  const withIssues = importTotals([
    { itemId: 'settings:a', status: 'ok' },
    { itemId: 'plugin:x', status: 'warning', message: '装不上' },
    { itemId: 'mcp:m', status: 'failed', message: 'npx 不存在' },
    { itemId: 'plugin:y', status: 'skipped' },
  ]);
  assert.deepEqual(withIssues, { ok: 1, skipped: 1, warned: 1, failed: 1, problems: 2 });
});

test('report: importProblems 抽失败/警告项（带分区与原因，保持执行顺序）', () => {
  const problems = importProblems([
    { itemId: 'settings:a', status: 'ok' },
    { itemId: 'plugin:x', status: 'warning', message: '插件 x 安装失败: npm 不可达' },
    { itemId: 'plugin:y', status: 'skipped' },
    { itemId: 'mcp:m', status: 'failed', message: 'npx 不存在' },
    { itemId: 'weird', status: 'warning' },
  ]);
  assert.deepEqual(problems.map((p) => p.itemId), ['plugin:x', 'mcp:m', 'weird'], '只留失败/警告，顺序不变');
  assert.equal(problems[0]!.section, 'plugins', '分区由 itemId 前缀推断（与分区统计同源）');
  assert.equal(problems[0]!.status, 'warning');
  assert.equal(problems[0]!.message, '插件 x 安装失败: npm 不可达');
  assert.equal(problems[1]!.section, 'mcp');
  assert.equal(problems[2]!.section, 'other', '未知前缀归 other');
  assert.equal(problems[2]!.message, undefined, '无原因时不留 undefined 字段');
});

test('report: formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(20480), '20.0 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
});
