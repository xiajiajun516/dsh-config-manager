/**
 * m-sync-ui：sync-config.json schemaVersion 迁移与往返测试。
 * - 写入 schemaVersion=1 + 字段；读回字段一致。
 * - 旧文件无 schemaVersion 字段视为 v1 兼容读取。
 * - 不支持的 schemaVersion 抛错（返回 null）。
 * - 损坏 JSON 返回 null（不静默降级）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSyncConfig, writeSyncConfig, SYNC_CONFIG_FILE, SYNC_CONFIG_SCHEMA_VERSION,
} from './sync-config.ts';

test('writeSyncConfig + readSyncConfig：写入 schemaVersion=1 + repoUrl/gitBin → 读回字段一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-rt-'));
  try {
    await writeSyncConfig(dir, { repoUrl: 'git@github.com:foo/bar.git', gitBin: '/usr/bin/git' });
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, { repoUrl: 'git@github.com:foo/bar.git', gitBin: '/usr/bin/git' });
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(raw.gitBin, '/usr/bin/git');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig：未传 gitBin 时不写入字段（保持文件精简）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-nogitbin-'));
  try {
    await writeSyncConfig(dir, { repoUrl: 'git@github.com:foo/bar.git' });
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(raw.gitBin, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：旧文件无 schemaVersion 字段 → 视为 v1 兼容读取', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-legacy-'));
  try {
    // 旧版（无 schemaVersion 字段）
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ repoUrl: 'git@github.com:foo/bar.git', gitBin: '/bin/git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, { repoUrl: 'git@github.com:foo/bar.git', gitBin: '/bin/git' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：不支持的 schemaVersion → 返回 null（拒绝）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badver-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 99, repoUrl: 'git@github.com:foo/bar.git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：schemaVersion 字段非数字 → 返回 null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badtype-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 'v1', repoUrl: 'git@github.com:foo/bar.git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：损坏 JSON → 返回 null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badjson-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), '{not-json', 'utf8');
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：文件不存在 → 返回 null（视为未配置）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-missing-'));
  try {
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig：自动创建目录', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-mkdir-'));
  try {
    const dir = path.join(base, 'nested', 'sync');
    await writeSyncConfig(dir, { repoUrl: 'git@github.com:foo/bar.git' });
    const loaded = await readSyncConfig(dir);
    assert.ok(loaded);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
