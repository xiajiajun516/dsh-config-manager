/**
 * sync-selection 测试：sync-selection.json 读写往返、缺省值、损坏 JSON 回退缺省、
 * 非字符串 sections 过滤、effectiveSections（高级模式 → 勾选分区；其余 → undefined）、
 * 按通道独立（git/webdav 互不干扰）、v1（顶层单通道）迁移为 git。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultSyncSelection, effectiveSections, readSyncSelection, writeSyncSelection,
  readAllSyncSelections, SYNC_SELECTION_FILE, SYNC_SELECTION_SCHEMA_VERSION,
} from './sync-selection.ts';

test('writeSyncSelection + readSyncSelection：advanced 模式写入 → 读回字段一致（git 通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-rt-'));
  try {
    await writeSyncSelection(dir, 'git', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'], encrypt: true, includeSecrets: true });
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'advanced');
    assert.deepEqual(sel.sections, ['settings', 'skills']);
    assert.equal(sel.encrypt, true);
    assert.equal(sel.includeSecrets, true);
    // 原始文件校验（v2 按通道）
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_SELECTION_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_SELECTION_SCHEMA_VERSION);
    assert.equal(raw.channels.git.mode, 'advanced');
    assert.deepEqual(raw.channels.git.sections, ['settings', 'skills']);
    assert.equal(raw.channels.webdav.mode, 'default', '未配置的 webdav 通道落盘为缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：文件不存在 → 返回缺省（default 模式 + 空 sections）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-default-'));
  try {
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'default');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_SELECTION_FILE), '{not-json', 'utf8');
    const sel = await readSyncSelection(dir, 'git');
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
    const sel = await readSyncSelection(dir, 'git');
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
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default', '非法 mode 回退 default');
    assert.deepEqual(sel.sections, ['settings', 'skills'], '非字符串/空串元素被过滤');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('effectiveSections：advanced + 非空 → 勾选分区；default / advanced 空勾选 → undefined（全量）', () => {
  assert.deepEqual(
    effectiveSections({ schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'], encrypt: false, includeSecrets: false }),
    ['settings', 'skills'],
  );
  assert.equal(effectiveSections(defaultSyncSelection()), undefined, 'default 模式 = 全量推荐分区');
  assert.equal(
    effectiveSections({ schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: [], encrypt: false, includeSecrets: false }),
    undefined,
    'advanced 但未勾选 → 回退全量（避免自动同步卡死）',
  );
});

test('readSyncSelection：includeSecrets 但未 encrypt（持久化被篡改）→ 强制关闭导出密钥', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-safe-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, mode: 'advanced', sections: ['settings'], encrypt: false, includeSecrets: true }),
      'utf8',
    );
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.encrypt, false);
    assert.equal(sel.includeSecrets, false, '密钥未加密时强制关闭（安全兜底）');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('按通道独立：写 webdav 不影响 git，反之亦然', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-perchannel-'));
  try {
    await writeSyncSelection(dir, 'git', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'default', sections: [], encrypt: false, includeSecrets: false });
    await writeSyncSelection(dir, 'webdav', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'], encrypt: true, includeSecrets: true });
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'default', 'git 通道保持 default');
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'advanced');
    assert.deepEqual(webdav.sections, ['settings', 'skills']);
    assert.equal(webdav.encrypt, true);
    // 全量读取视图
    const all = await readAllSyncSelections(dir);
    assert.equal(all.git.mode, 'default');
    assert.equal(all.webdav.mode, 'advanced');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('v1 迁移：顶层单通道字段 → git 通道（webdav 缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-v1-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, mode: 'advanced', sections: ['settings'], encrypt: true }),
      'utf8',
    );
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'advanced', 'v1 mode 迁移到 git 通道');
    assert.deepEqual(git.sections, ['settings']);
    assert.equal(git.encrypt, true);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'default', 'webdav 通道回退缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
