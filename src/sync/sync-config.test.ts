/**
 * m-sync-ui：sync-config.json schemaVersion v3（双命名空间共存）往返与迁移测试。
 *
 * schema v3 统一契约：
 * - 顶层形状 { schemaVersion:3, transport:'git'|'webdav', git:{...}, webdav:{...} }。
 *   git 与 webdav 两个命名空间可并存：切换通道保存时保留另一通道配置（repoUrl/url 不丢失）。
 * - webdav 命名空间字段：url（必填，不含凭据）/ username?（可选）。
 * - 读入返回可辨识联合 SyncConfig（schemaVersion=2，按 transport 选取对应通道）+ isGitConfig()/isWebDavConfig() 守卫。
 * - 兼容旧 v1（{schemaVersion:1, repoUrl, gitBin?} 或缺 schemaVersion）与 v2 文件
 *   → 读取时归一为 v2 git/webdav 形态；写入时统一升级为 v3 双命名空间。
 *
 * 安全不变量：配置文件绝不出现密码/token；url 校验拒绝空白/非 http(s)/userinfo。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readSyncConfig, readFullSyncConfig, writeSyncConfig, isGitConfig, isWebDavConfig,
  SYNC_CONFIG_FILE, SYNC_CONFIG_SCHEMA_VERSION, SYNC_CONFIG_SUPPORTED_VERSIONS,
  validateWebDavUrl, type SyncConfig,
} from './sync-config.ts';

test('writeSyncConfig + readSyncConfig（git 通道）：写入 v3 双命名空间形态（无另一通道时不写空命名空间）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-git2-'));
  try {
    const cfg: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } };
    await writeSyncConfig(dir, cfg);
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, cfg);
    assert.ok(isGitConfig(loaded!));
    assert.equal(isWebDavConfig(loaded!), false);
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.transport, 'git');
    assert.equal(raw.git.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(raw.webdav, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeSyncConfig + readSyncConfig（webdav 通道）：写入 v3 双命名空间形态', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-webdav-'));
  try {
    const cfg: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/remote.php/dav/files/user' } };
    await writeSyncConfig(dir, cfg);
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, cfg);
    assert.ok(isWebDavConfig(loaded!));
    assert.equal(isGitConfig(loaded!), false);
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
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

test('通道切换：先配置 git 再配置 webdav → 文件保留两个命名空间，git repoUrl 不丢失', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-switch-'));
  try {
    // 1) 配置 git 通道
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } });
    // 2) 切到 webdav 通道并保存（此前 bug：覆盖文件导致 git repoUrl 丢失）
    await writeSyncConfig(dir, {
      schemaVersion: 2,
      transport: 'webdav',
      webdav: { url: 'https://dav.example.com/remote.php/dav/files/user', username: 'alice' },
    });
    // 文件同时含两个命名空间
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.transport, 'webdav');
    assert.equal(raw.git.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(raw.webdav.url, 'https://dav.example.com/remote.php/dav/files/user');
    // 当前通道视图为 webdav
    const loaded = await readSyncConfig(dir);
    assert.ok(isWebDavConfig(loaded!));
    // 完整视图可回读两通道
    const full = await readFullSyncConfig(dir);
    assert.equal(full?.git?.repoUrl, 'git@github.com:foo/bar.git');
    assert.equal(full?.webdav?.username, 'alice');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('通道切换：再切回 git → webdav 配置同样保留', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-switchback-'));
  try {
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } });
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com' } });
    // 切回 git 并更新 repoUrl
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/new.git' } });
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.transport, 'git');
    assert.equal(raw.git.repoUrl, 'git@github.com:foo/new.git', 'git repoUrl 更新为最新值');
    assert.equal(raw.webdav.url, 'https://dav.example.com', 'webdav 配置保留');
    const loaded = await readSyncConfig(dir);
    assert.ok(isGitConfig(loaded!));
    assert.equal(loaded!.git.repoUrl, 'git@github.com:foo/new.git');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：旧 v1 文件（无 schemaVersion）→ 归一为 v2 git 形态（旧 gitBin 被忽略）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-v1legacy-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ repoUrl: 'git@github.com:foo/bar.git', gitBin: '/bin/git' }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.deepEqual(loaded, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } });
    // v1 亦可读出完整视图（git 命名空间）
    const full = await readFullSyncConfig(dir);
    assert.equal(full?.git?.repoUrl, 'git@github.com:foo/bar.git');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncConfig：显式 schemaVersion=1 的旧文件 → 归一为 v2 git 形态', async () => {
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

test('readSyncConfig：v2 旧文件（单命名空间）→ 正常读取', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-v2-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com', username: 'bob' } }),
      'utf8',
    );
    const loaded = await readSyncConfig(dir);
    assert.ok(isWebDavConfig(loaded!));
    assert.equal(loaded!.webdav.url, 'https://dav.example.com');
    // 完整视图读回
    const full = await readFullSyncConfig(dir);
    assert.equal(full?.webdav?.username, 'bob');
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
      JSON.stringify({ schemaVersion: 2, transport: 'git', git: {} }),
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

test('SYNC_CONFIG_SUPPORTED_VERSIONS 包含 1、2 与 3', () => {
  assert.ok(SYNC_CONFIG_SUPPORTED_VERSIONS.includes(1));
  assert.ok(SYNC_CONFIG_SUPPORTED_VERSIONS.includes(2));
  assert.ok(SYNC_CONFIG_SUPPORTED_VERSIONS.includes(3));
});

test('readFullSyncConfig：文件不存在 → null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-fullmissing-'));
  try {
    const full = await readFullSyncConfig(dir);
    assert.equal(full, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readFullSyncConfig：损坏 JSON → null', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-fullbadjson-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), '{bad', 'utf8');
    const full = await readFullSyncConfig(dir);
    assert.equal(full, null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
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
