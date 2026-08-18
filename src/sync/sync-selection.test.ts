/**
 * sync-selection 测试：sync-selection.json 读写往返、缺省值、损坏 JSON 回退缺省、
 * 非字符串 sections 过滤、effectiveSections（高级模式 → 勾选分区；其余 → undefined）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultSyncSelection, effectiveSections, readSyncSelection, writeSyncSelection,
  SYNC_SELECTION_FILE, SYNC_SELECTION_SCHEMA_VERSION,
} from './sync-selection.ts';

test('writeSyncSelection + readSyncSelection：advanced 模式写入 → 读回字段一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-rt-'));
  try {
    await writeSyncSelection(dir, { schemaVersion: 1, mode: 'advanced', sections: ['settings', 'skills'] });
    const sel = await readSyncSelection(dir);
    assert.equal(sel.mode, 'advanced');
    assert.deepEqual(sel.sections, ['settings', 'skills']);
    // 原始文件校验
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_SELECTION_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_SELECTION_SCHEMA_VERSION);
    assert.equal(raw.mode, 'advanced');
    assert.deepEqual(raw.sections, ['settings', 'skills']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：文件不存在 → 返回缺省（default 模式 + 空 sections）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-default-'));
  try {
    const sel = await readSyncSelection(dir);
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_SELECTION_FILE), '{not-json', 'utf8');
    const sel = await readSyncSelection(dir);
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-schema-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 99, mode: 'advanced', sections: ['settings'] }),
      'utf8',
    );
    const sel = await readSyncSelection(dir);
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：非法 mode / 非字符串 sections 元素 → 过滤回退', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-filter-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, mode: 'bogus', sections: ['settings', 42, '', 'skills'] }),
      'utf8',
    );
    const sel = await readSyncSelection(dir);
    assert.equal(sel.mode, 'default', '非法 mode 回退 default');
    assert.deepEqual(sel.sections, ['settings', 'skills'], '非字符串/空串元素被过滤');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('effectiveSections：advanced + 非空 → 勾选分区；default / advanced 空勾选 → undefined（全量）', () => {
  assert.deepEqual(
    effectiveSections({ schemaVersion: 1, mode: 'advanced', sections: ['settings', 'skills'] }),
    ['settings', 'skills'],
  );
  assert.equal(effectiveSections(defaultSyncSelection()), undefined, 'default 模式 = 全量推荐分区');
  assert.equal(
    effectiveSections({ schemaVersion: 1, mode: 'advanced', sections: [] }),
    undefined,
    'advanced 但未勾选 → 回退全量（避免自动同步卡死）',
  );
});
