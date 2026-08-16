/**
 * progress 测试（m6-ui，规范 §29）：阶段文案与进度追踪。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_STAGES, IMPORT_STAGES, ProgressTracker, stageText } from './progress.ts';
import { makeUiT } from './i18n.ts';

const enT = makeUiT('en');
const zhT = makeUiT('zh');

test('progress: 阶段文案映射（导出/导入/回滚，en / zh）', () => {
  assert.equal(stageText('analyzing', enT), 'Analyzing configuration...');
  assert.equal(stageText('creating-snapshot', enT), 'Creating safety snapshot...');
  assert.equal(stageText('rolling-back', enT), 'Rolling back...');
  assert.equal(stageText('restoring-mcp', enT), 'Restoring MCP...');
  assert.equal(stageText('done', enT), 'Done');
  assert.equal(stageText('analyzing', zhT), '正在分析配置…');
  // 未知阶段回退 id
  assert.equal(stageText('unknown-phase', enT), 'unknown-phase');
});

test('progress: 导出阶段序列完整', () => {
  assert.deepEqual(EXPORT_STAGES, [
    'analyzing', 'exporting-settings', 'scanning-secrets', 'exporting-plugins',
    'creating-archive', 'calculating-checksums', 'done',
  ]);
});

test('progress: 导入阶段序列含快照/回滚', () => {
  assert.ok(IMPORT_STAGES.includes('creating-snapshot'));
  assert.ok(IMPORT_STAGES.includes('rolling-back'));
  assert.ok(IMPORT_STAGES.includes('restoring-settings'));
});

test('progress: tracker 发出事件并带 step/total', () => {
  const events: { stage: string; step?: number; total?: number }[] = [];
  const t = new ProgressTracker(IMPORT_STAGES, (e) => events.push(e));
  t.emit('validating');
  t.emit('creating-snapshot');
  t.emit('done');
  assert.deepEqual(t.events, ['validating', 'creating-snapshot', 'done']);
  assert.equal(events[0]!.step, 1);
  assert.equal(events[0]!.total, IMPORT_STAGES.length);
  assert.equal(events[1]!.step, 3);
  assert.equal(events[2]!.step, IMPORT_STAGES.length);
});
