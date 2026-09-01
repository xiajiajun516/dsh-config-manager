/**
 * ui-prefs 测试：ui-prefs.json 读写往返、缺省值、损坏 JSON 回退缺省、非法通道值忽略、
 * Star 引导弹窗状态字段往返与非法值忽略、updateUiPrefs 局部原子更新不互相覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultUiPrefs, readUiPrefs, writeUiPrefs, updateUiPrefs,
  UI_PREFS_FILE, UI_PREFS_SCHEMA_VERSION,
} from './ui-prefs.ts';

test('writeUiPrefs + readUiPrefs：写入通道 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rt-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, 'webdav');
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal(raw.lastSyncChannel, 'webdav');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeUiPrefs：无通道 → 文件不写 lastSyncChannel 字段', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-none-'));
  try {
    await writeUiPrefs(dir, defaultUiPrefs());
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal('lastSyncChannel' in raw, false, '未配置通道不落字段');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：文件不存在 → 缺省（无通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-default-'));
  try {
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, UI_PREFS_FILE), '{not-json', 'utf8');
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-schema-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 99, lastSyncChannel: 'git' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：非法通道值 → 忽略（回退缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-bad-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, lastSyncChannel: 'ftp' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined, '非 git/webdav 值被忽略');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Star 引导状态：写入三字段 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-star-'));
  try {
    await writeUiPrefs(dir, {
      schemaVersion: 1,
      starPromptFirstSeenAt: 1700000000000,
      starPromptDismissed: false,
      starPromptClicked: true,
    });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.starPromptFirstSeenAt, 1700000000000);
    assert.equal(prefs.starPromptDismissed, undefined, 'false 不落字段');
    assert.equal(prefs.starPromptClicked, true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.starPromptFirstSeenAt, 1700000000000);
    assert.equal('starPromptDismissed' in raw, false, 'false 不写字段');
    assert.equal(raw.starPromptClicked, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：Star 字段非法值（字符串时间戳 / 非布尔）→ 忽略', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-star-bad-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, starPromptFirstSeenAt: 'yesterday', starPromptDismissed: 'yes' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.starPromptFirstSeenAt, undefined);
    assert.equal(prefs.starPromptDismissed, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('updateUiPrefs：局部补丁合并，不覆盖未涉及的字段（防多端点互覆盖）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-upd-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    // star-prompt 端点更新：只补弹窗字段，lastSyncChannel 必须保留
    const next = await updateUiPrefs(dir, { starPromptFirstSeenAt: 1700000000000, starPromptClicked: true });
    assert.equal(next.lastSyncChannel, 'webdav', '未涉及的 lastSyncChannel 保留');
    assert.equal(next.starPromptFirstSeenAt, 1700000000000);
    assert.equal(next.starPromptClicked, true);
    // sync/ui-prefs 端点更新：只补通道字段，弹窗字段必须保留
    const after = await updateUiPrefs(dir, { lastSyncChannel: 'git' });
    assert.equal(after.lastSyncChannel, 'git');
    assert.equal(after.starPromptFirstSeenAt, 1700000000000, '未涉及的 Star 字段保留');
    assert.equal(after.starPromptClicked, true);
    // 磁盘最终态
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.lastSyncChannel, 'git');
    assert.equal(raw.starPromptFirstSeenAt, 1700000000000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('更新内容弹窗状态：写入字段 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rn-'));
  try {
    await writeUiPrefs(dir, {
      schemaVersion: 1,
      releaseNotesLastSeenVersion: '0.1.54',
      releaseNotesDismissed: true,
    });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.releaseNotesLastSeenVersion, '0.1.54');
    assert.equal(prefs.releaseNotesDismissed, true);
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.releaseNotesLastSeenVersion, '0.1.54');
    assert.equal(raw.releaseNotesDismissed, true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

