/**
 * export-flow 测试（m6-ui）：Quick 推荐项 / Custom 分组目录 / 校验 / 执行进度与端口调用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportFlow, failedSectionsFromResponse, normalizeExportFileName } from './export-flow.ts';
import { makeUiT } from './i18n.ts';

const enT = makeUiT('en');
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

test('export-flow: validateSelection 结构化返回未知分区与 deviceSpecific 分区（UI-09）', () => {
  const flow = new ExportFlow({ port: new MockExportPort() });
  const ok = flow.validateSelection(['settings', 'sessions']);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.unknown, []);
  assert.deepEqual(ok.deviceSpecific, ['sessions'], 'sessions 为设备相关分区，须就地警示');
  assert.ok(!flow.validateSelection(['settings']).deviceSpecific.includes('settings'));
  const bad = flow.validateSelection(['nope'] as never);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.unknown, ['nope']);
});

test('export-flow: failedSectionsFromResponse 判定清单读取失败的分区（UI-07）', () => {
  // 请求了 3 个分区、只回来 2 个 → 没回来的那个 = 读取失败（⇒ UI 标注「将整体导出」）
  assert.deepEqual(
    failedSectionsFromResponse(['settings', 'plugins', 'sessions'], ['settings', 'sessions']),
    ['plugins'],
  );
  // 全部回来 = 无失败（不得凭空标记失败，否则界面会误报「读取失败」）
  assert.deepEqual(failedSectionsFromResponse(['settings'], ['settings']), []);
  // 请求整体失败由调用方处理（这里只表达「一个都没回来时全算失败」）
  assert.deepEqual(failedSectionsFromResponse(['sessions', 'skills'], []), ['sessions', 'skills']);
  // 顺序跟随请求顺序（UI 逐分区记账的稳定性）
  assert.deepEqual(failedSectionsFromResponse(['skills', 'settings'], []), ['skills', 'settings']);
});

test('export-flow: run 调 port 并携带 only 选择与进度事件', async () => {
  const port = new MockExportPort();
  const events: string[] = [];
  const flow = new ExportFlow({ port, onProgress: (e) => events.push(e.stage), t: enT });
  const out = await flow.run(['settings', 'plugins']);

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

test('export-flow: run 只导出传入的集合（模式已移除；空集合不得回落到默认分区）', async () => {
  const port = new MockExportPort();
  const flow = new ExportFlow({ port });
  await flow.run(['settings', 'skills']);
  assert.deepEqual(port.calls[0]!.only, ['settings', 'skills']);

  // 回归：点「全不选」后必须什么都不导出。曾经的 mode==='quick' 分支会在这里回落成推荐分区。
  const empty = new MockExportPort();
  await new ExportFlow({ port: empty }).run([]);
  assert.deepEqual(empty.calls[0]!.only, []);
});

test('export-flow: 报告包含 Excluded 与 Security 信息', async () => {
  const report = makeExportReport({ excluded: ['sessions'] });
  const out = await new ExportFlow({ port: new MockExportPort(report) }).run([]);
  assert.equal(out.report.excluded.includes('sessions'), true);
  assert.equal(out.report.security.secretsExcluded, true);
});

test('export-flow: normalizeExportFileName 自动补全 .zip（无需手动输入后缀）', () => {
  assert.equal(normalizeExportFileName('my-backup'), 'my-backup.zip', '无后缀自动补全');
  assert.equal(normalizeExportFileName('my-backup.zip'), 'my-backup.zip', '已有 .zip 不重复追加');
  assert.equal(normalizeExportFileName(' My Backup '), 'My Backup.zip', 'trim 首尾空白');
  assert.equal(normalizeExportFileName('a.ZIP'), 'a.ZIP', '已有 .zip（大小写不敏感）不重复追加');
  assert.equal(normalizeExportFileName('   '), '', '全空白 → 空串（宿主自动命名）');
  assert.equal(normalizeExportFileName(''), '', '空串 → 空串');
});
