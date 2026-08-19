/**
 * ui-prefs 测试：ui-prefs.json 读写往返、缺省值、损坏 JSON 回退缺省、非法通道值忽略。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultUiPrefs, readUiPrefs, writeUiPrefs,
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
