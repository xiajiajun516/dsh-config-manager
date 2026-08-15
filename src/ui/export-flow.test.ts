/**
 * export-flow 测试（m6-ui）：Quick 推荐项 / Custom 分组目录 / 校验 / 执行进度与端口调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportFlow } from './export-flow.ts';
import { MockExportPort, makeExportReport } from './test-helpers.ts';

test('export-flow: Quick 推荐项 = defaultIncluded 且非 deviceSpecific', () => {
  const flow = new ExportFlow({ port: new MockExportPort() });
  const sel = flow.quickSelection();
  assert.ok(sel.includes('settings'));
  assert.ok(sel.includes('plugins'));
  assert.ok(sel.includes('mcp'));
  assert.ok(sel.includes('providers'));
  assert.ok(!sel.includes('sessions'), 'sessions 默认关闭');
  assert.ok(!sel.includes('pluginFiles'), 'pluginFiles 默认关闭');
  assert.ok(!sel.includes('credentialsStatus'), 'deviceSpecific 不进 Quick');
});

test('export-flow: Custom 分组目录按 §1 分组且 automation 有说明', () => {
  const flow = new ExportFlow({ port: new MockExportPort() });
  const groups = flow.groupedCatalog();
  const ids = groups.map((g) => g.group);
  assert.ok(ids.includes('general'));
  assert.ok(ids.includes('ai'));
  assert.ok(ids.includes('extensions'));
  assert.ok(ids.includes('optional'));
  const automation = groups.find((g) => g.group === 'automation');
  assert.ok(automation, 'automation 组存在（说明 DSH 无对应配置）');
  assert.ok(automation!.note !== undefined);
  const optional = groups.find((g) => g.group === 'optional')!;
  assert.ok(optional.categories.some((c) => c.id === 'sessions'), '可选分区在 optional 组');
});

test('export-flow: validateSelection 对 deviceSpecific 分区给出警告', () => {
  const flow = new ExportFlow({ port: new MockExportPort() });
  const { valid, warnings } = flow.validateSelection(['settings', 'sessions']);
  assert.equal(valid, true);
  assert.ok(warnings.some((w) => w.includes('Sessions')));
  const bad = flow.validateSelection(['nope'] as never);
  assert.ok(bad.warnings.some((w) => w.includes('未知分区')));
});

test('export-flow: run 调 port 并携带 only 选择与进度事件', async () => {
  const port = new MockExportPort();
  const events: string[] = [];
  const flow = new ExportFlow({ port, onProgress: (e) => events.push(e.stage) });
  const out = await flow.run('custom', ['settings', 'plugins']);

  assert.equal(port.calls.length, 1);
  assert.deepEqual(port.calls[0]!.only, ['settings', 'plugins']);
  assert.equal(port.calls[0]!.includeSecrets, false);
  assert.equal(out.text.includes('Backup Created'), true);
  assert.equal(out.text.includes('✓ settings'), true);
  assert.equal(out.text.includes('8 plugins'), true);
  assert.equal(events[events.length - 1], 'done');
  // 请求期间只发 in-flight 阶段（不定态，不显示假百分比），完成后 done
  assert.ok(events.includes('exporting'));
  assert.ok(!events.includes('calculating-checksums'), '不再预先发出假阶段文案');
});

test('export-flow: Quick 模式 only 使用推荐项', async () => {
  const port = new MockExportPort();
  const flow = new ExportFlow({ port });
  await flow.run('quick', []);
  assert.deepEqual(port.calls[0]!.only, flow.quickSelection());
});

test('export-flow: 报告包含 Excluded 与 Security 信息', async () => {
  const report = makeExportReport({ excluded: ['sessions'] });
  const out = await new ExportFlow({ port: new MockExportPort(report) }).run('quick', []);
  assert.equal(out.report.excluded.includes('sessions'), true);
  assert.equal(out.report.security.secretsExcluded, true);
});
