/**
 * m-sync-ui：sync-config.json schemaVersion v2（命名空间 + WebDAV 通道）往返与迁移测试。
 *
 * schema v2 统一契约（captain 冻结）：
 * - 顶层形状 { schemaVersion:2, transport:'git'|'webdav', git:{...} | webdav:{...} }。
 * - webdav 命名空间字段：url（必填，不含凭据）/ username?（可选）。
 * - 可辨识联合 SyncConfig + isGitConfig()/isWebDavConfig() 守卫。
 * - 兼容旧 v1 文件（{schemaVersion:1, repoUrl, gitBin?} 或缺 schemaVersion）→ 读取时归一为 v2 git 形态。
 *
 * 安全不变量：配置文件绝不出现密码/token；url 校验拒绝空白/非 http(s)/userinfo。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSyncConfig, writeSyncConfig, isGitConfig, isWebDavConfig,
  SYNC_CONFIG_FILE, SYNC_CONFIG_SCHEMA_VERSION, SYNC_CONFIG_SUPPORTED_VERSIONS,
  validateWebDavUrl, type SyncConfig,
} from './sync-config.ts';

test('writeSyncConfig + readSyncConfig（git 通道）：写入 v2 命名空间形态 → 读回一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-git2-'));
  try {
    const cfg: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git', gitBin: '/usr/bin/git' } };
    await writeSyncConfig(dir, cfg);
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, cfg);
    assert.ok(isGitConfig(loaded!));
    assert.equal(isWebDavConfig(loaded!), false);
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.transport, 'git');
    assert.equal(raw.git.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(raw.git.gitBin, '/usr/bin/git');
    assert.equal(raw.webdav, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig + readSyncConfig（webdav 通道）：写入 v2 webdav 命名空间 → 读回一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-webdav-'));
  try {
    const cfg: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/remote.php/dav/files/user' } };
    await writeSyncConfig(dir, cfg);
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, cfg);
    assert.ok(isWebDavConfig(loaded!));
    assert.equal(isGitConfig(loaded!), false);
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, 2);
    assert.equal(raw.transport, 'webdav');
    assert.equal(raw.webdav.url, cfg.webdav.url);
    assert.equal(raw.webdav.username, undefined);
    assert.equal(raw.git, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig（webdav 通道）：username 非空才写入', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-webdavfull-'));
  try {
    const cfg: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com', username: 'alice' } };
    await writeSyncConfig(dir, cfg);
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.webdav.username, 'alice');
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, cfg);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：旧 v1 文件（无 schemaVersion）→ 归一为 v2 git 命名空间', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-v1legacy-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ repoUrl: 'git@github.com:foo/bar.git', gitBin: '/bin/git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git', gitBin: '/bin/git' } });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：显式 schemaVersion=1 的旧文件 → 归一为 v2 git 命名空间', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-v1-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, repoUrl: 'git@github.com:foo/bar.git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig（webdav）：缺 webdav.url → 返回 null（未配置）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-webdavnourl-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 2, transport: 'webdav', webdav: { username: 'alice' } }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig（git）：缺 git.repoUrl → 返回 null（未配置）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-gitnourl-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 2, transport: 'git', git: { gitBin: '/bin/git' } }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：transport 非法值 → 返回 null（拒绝垃圾）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badtrans-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 2, transport: 'ftp', webdav: { url: 'https://x.example.com' } }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：不支持的 schemaVersion → 返回 null（拒绝）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badver-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 99, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.equal(loaded, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：schemaVersion 非数字 → 返回 null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-badtype-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 'v2', transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } }),
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

test('readSyncConfig：文件不存在 → 返回 null（未配置）', async () => {
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
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com' } });
    const loaded = await readSyncConfig(dir);
    assert.ok(loaded);
    assert.equal(loaded.transport, 'webdav');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('isGitConfig / isWebDavConfig 守卫：只命中对应通道', () => {
  const git: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'x' } };
  const webdav: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com' } };
  assert.equal(isGitConfig(git), true);
  assert.equal(isGitConfig(webdav), false);
  assert.equal(isWebDavConfig(webdav), true);
  assert.equal(isWebDavConfig(git), false);
});

test('SYNC_CONFIG_SUPPORTED_VERSIONS 包含 1 与 2', () => {
  assert.ok(SYNC_CONFIG_SUPPORTED_VERSIONS.includes(1));
  assert.ok(SYNC_CONFIG_SUPPORTED_VERSIONS.includes(2));
});

test('validateWebDavUrl：空字符串 → 返回错误（必填）', () => {
  assert.ok(validateWebDavUrl(''));
  assert.ok(validateWebDavUrl('   '));
});

test('validateWebDavUrl：含空白字符 → 返回错误', () => {
  assert.ok(validateWebDavUrl('https://dav.example.com /x'));
});

test('validateWebDavUrl：非 http(s) → 返回错误', () => {
  assert.ok(validateWebDavUrl('ftp://dav.example.com'));
  assert.ok(validateWebDavUrl('dav.example.com'));
});

test('validateWebDavUrl：含 userinfo（username:password@）→ 拒绝（凭据不入 URL）', () => {
  assert.ok(validateWebDavUrl('https://user:pass@dav.example.com'));
  assert.ok(validateWebDavUrl('https://user@dav.example.com'));
});

test('validateWebDavUrl：合法 http(s) 地址 → 返回 null（合法）', () => {
  assert.equal(validateWebDavUrl('https://dav.example.com/remote.php/dav/files/user'), null);
  assert.equal(validateWebDavUrl('http://dav.local:8080/'), null);
});
