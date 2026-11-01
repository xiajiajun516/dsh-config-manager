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
import { fileURLToPath } from 'node:url';

import { stripJsComments } from '../utils/bundle-scan.ts';

import {
  readSyncConfig, readFullSyncConfig, readSyncConfigFor, writeSyncConfig, isGitConfig, isWebDavConfig,
  isS3Config, isGistConfig, listConfiguredChannels, readActiveS3Provider,
  SYNC_CONFIG_FILE, SYNC_CONFIG_SCHEMA_VERSION, SYNC_CONFIG_SUPPORTED_VERSIONS, CLOUD_SYNC_CONFIG_FILE,
  validateWebDavUrl, validateRepoUrl, type SyncConfig, type SyncConfigIssue,
  SYNC_CHANNELS, channelOf, channelMap, isSyncTransportType, parseSyncChannel, clearSyncChannel,
  S3_COMPAT_PROVIDERS, CLOUD_SYNC_PROVIDERS, cloudSecretRef,
} from './sync-config.ts';
// t88 跨侧常量守卫：共享零依赖常量 + 客户端镜像（见文件末尾的 t88 用例）
import { S3_COMPAT_PROVIDERS as SHARED_S3_COMPAT_PROVIDERS, cloudSecretRefName } from '../utils/shared-constants.ts';
import { S3_PROVIDERS as UI_S3_PROVIDERS } from '../ui/sync-settings-view.ts';

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
/* ---------------- t32：通道枚举唯一来源（SYNC_CHANNELS / channelOf / channelMap） ---------------- */

test('t32：SYNC_CHANNELS 是通道枚举唯一来源；isSyncTransportType / parseSyncChannel 同源', () => {
  // 预期值从枚举自身派生（不再手抄字面量：新增通道只改声明处，避免两处不同步）
  assert.ok(SYNC_CHANNELS.length > 0, '通道清单非空');
  assert.deepEqual([...new Set(SYNC_CHANNELS)], [...SYNC_CHANNELS], '通道清单无重复');
  for (const ch of SYNC_CHANNELS) {
    assert.equal(isSyncTransportType(ch), true);
    assert.equal(parseSyncChannel(ch), ch);
  }
  // 非法/缺失一律 undefined（缺省由调用方决定，不在此静默兜底成 git）
  assert.equal(isSyncTransportType('ftp'), false);
  assert.equal(isSyncTransportType(undefined), false);
  assert.equal(isSyncTransportType(null), false);
  assert.equal(isSyncTransportType(1), false);
  assert.equal(parseSyncChannel('ftp'), undefined);
  assert.equal(parseSyncChannel(undefined), undefined);
  // 云端点两条通道已并入（s3 承载五家兼容商 / gist）：漏并会让用户点不到云端点同步
  assert.equal(isSyncTransportType('s3'), true);
  assert.equal(isSyncTransportType('gist'), true);
});

test('t32：channelOf 是「配置 → 通道」的唯一判定口径（等价于原 isWebDavConfig ? webdav : git）', () => {
  const git: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'x' } };
  const webdav: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com' } };
  assert.equal(channelOf(git), 'git');
  assert.equal(channelOf(webdav), 'webdav');
  // 与既有守卫同口径（两者都读 transport，不得出现第二套判定）
  assert.equal(channelOf(git), isGitConfig(git) ? 'git' : 'webdav');
  assert.equal(channelOf(webdav), isWebDavConfig(webdav) ? 'webdav' : 'git');
});

test('t32：channelMap 覆盖 SYNC_CHANNELS 全通道（Record 构造不再逐处穷举字面量）', () => {
  const seen: string[] = [];
  const out = channelMap((channel) => {
    seen.push(channel);
    return channel + '!';
  });
  assert.deepEqual([...seen], [...SYNC_CHANNELS], '回调按 SYNC_CHANNELS 顺序对每个通道各调用一次');
  // 预期值同样从枚举派生（不手抄字面量）
  const expected: Record<string, string> = {};
  for (const ch of SYNC_CHANNELS) expected[ch] = ch + '!';
  assert.deepEqual(out, expected);
});

/** 递归收集 src 下的地面代码（*.ts / *.tsx，排除 *.test.ts 与 *.d.ts） */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectSourceFiles(abs)));
    } else if ((e.name.endsWith('.ts') || e.name.endsWith('.tsx')) && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * t32 源码守卫：通道字面量数组只允许出现在唯一声明处；任何其它出现都必须带「客户端镜像」标记
 * （satisfies readonly SyncTransportType[] + 穷尽检查），否则视为偷偷多出一份枚举
 * （历史上 autosync-scheduler 把同一个数组写了两遍，漏改一处即某通道永不排期）。
 */
test('t32 源码守卫：地面代码里通道数组只有一处声明（其余只允许被守卫的客户端镜像）', async () => {
  // 声明处已迁到**零依赖**的 utils/shared-constants.ts（client 半必须能运行时 import；
  // sync/sync-config.ts 依赖 node:fs，不能被浏览器半 import）——本守卫的意图不变：
  // 通道数组全仓只允许一处声明，其余只允许带穷尽检查标记的镜像。

  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const files = await collectSourceFiles(srcRoot);
  const needle = "'git', 'webdav'";
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    const content = await fs.readFile(file, 'utf8');
    content.split(String.fromCharCode(10)).forEach((line, i) => {
      if (line.includes(needle)) hits.push({ file: rel, line: i + 1, text: line.trim() });
    });
  }
  const canonical = hits.filter((h) => h.text.includes('export const SYNC_CHANNELS'));
  assert.equal(canonical.length, 1, 'SYNC_CHANNELS 必须且只能声明一次: ' + JSON.stringify(hits));
  assert.equal(
    canonical[0]!.file,
    'utils/shared-constants.ts',
    '唯一声明处必须是零依赖的 src/utils/shared-constants.ts（client 半可运行时 import）',
  );
  // 宿主侧 sync-config.ts 只做 re-export，不得再声明一份（两处声明 = 漏改一处即静默失配）
  const syncConfigSrc = await fs.readFile(path.join(srcRoot, 'sync', 'sync-config.ts'), 'utf8');
  assert.ok(
    syncConfigSrc.includes("import { SYNC_CHANNELS } from '../utils/shared-constants.ts'"),
    'sync-config.ts 必须从零依赖模块导入通道清单',
  );
  assert.ok(
    syncConfigSrc.includes('export { SYNC_CHANNELS }'),
    'sync-config.ts 必须 re-export 通道清单（宿主沿用既有 import 路径）',
  );
  assert.equal(
    syncConfigSrc.includes("= ['git', 'webdav'"),
    false,
    'sync-config.ts 不得再自己声明通道数组',
  );
  const others = hits.filter((h) => h.text !== canonical[0]!.text || h.file !== canonical[0]!.file);
  for (const h of others) {
    assert.ok(
      h.text.includes('satisfies readonly SyncTransportType[]'),
      '除 SYNC_CHANNELS 外只允许带穷尽检查标记的客户端镜像: ' + h.file + ':' + String(h.line) + ' ' + h.text,
    );
  }
  // 宿主 sync 目录不得再出现通道数组字面量（客户端镜像在 src/client/sync/ 下，不在此列）
  const hostDupes = others.filter((h) => h.file.startsWith('sync/') || h.file.startsWith('core/'));
  assert.deepEqual(hostDupes, [], '宿主代码不得出现第二处通道数组: ' + JSON.stringify(hostDupes));
});

/**
 * t33/B7 源码守卫（t40 的 findings B7-GUARD-SCOPE 收尾 / t47 落地）：
 * src/index.ts（host 路由层）不得再手写通道数组字面量与裸通道三元判定 ——
 * 一律消费 t32 建立的单一来源（SYNC_CHANNELS / channelOf / parseSyncChannel）。
 *
 * 为什么不用原文 includes / indexOf：本工作流已两次踩到「锚到注释里的同名串」——
 * index.ts 的注释里本来就写着 isWebDavConfig(cfg) ? 'webdav' : 'git' 这类描述文本，
 * 直接对原文匹配会假阳；一旦解析失衡又可能假阴。这里复用仓库既有内核
 * utils/bundle-scan.ts 的 stripJsComments（注释剥离 + 保留行号；对反引号/引号失衡有
 * 「多趟并集」的既有设计），取两个极端模式（tpl+str 与 opaque-both）后
 * **只采信两趟都保留内容的行**：注释行在任一趟都会被清空，故不会命中。
 *
 * 已实测的载重与抗注释（%TEMP% 隔离副本，仓库零写入）：
 *  - 注释诱饵（注释里写 ['git', 'webdav'] 与 isWebDavConfig(cfg) ? 'webdav' : 'git'）→ 本守卫保持绿；
 *    同一实验里 t32 的旧守卫（原文 includes）会误报 —— 正是本守卫存在的原因；
 *  - 把诱饵换成真实代码 → 本守卫变红并报出行号（当时为 5868 / 5869）。
 */
test('t33/B7 源码守卫：src/index.ts 不再手写通道数组/裸通道三元，全部消费单一来源', async () => {
  const indexSrc = await fs.readFile(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
  const tplMode = stripJsComments(indexSrc, true, false)
  const opaqueMode = stripJsComments(indexSrc, false, true)
  const tplLines = tplMode.split(String.fromCharCode(10))
  const opaqueLines = opaqueMode.split(String.fromCharCode(10))
  const bad: string[] = []
  tplLines.forEach((line, i) => {
    const t = line.trim()
    // 只有两趟都认为这里是「真实代码」时才判定（注释在其中一趟必被清空）
    if (t === '' || (opaqueLines[i] ?? '').trim() === '') return
    if (t.includes("['git', 'webdav']") || t.includes("['git','webdav']")) bad.push(String(i + 1) + ': 通道数组字面量 ' + t)
    if (t.includes("? 'webdav' : 'git'") || t.includes("?'webdav':'git'")) bad.push(String(i + 1) + ': 裸通道三元判定 ' + t)
  })
  assert.deepEqual(bad, [], 'src/index.ts 不得再手写通道判定/枚举（应消费 channelOf / parseSyncChannel / SYNC_CHANNELS）:' + String.fromCharCode(10) + bad.join(String.fromCharCode(10)))
  // 正向断言：确实接上了单一来源（否则上面可能因「什么都没写」而假绿）
  assert.ok(
    tplMode.includes('channelOf, parseSyncChannel, SYNC_CHANNELS')
    || (tplMode.includes('parseSyncChannel') && tplMode.includes('channelOf')),
    'src/index.ts 必须从 ./sync/sync-config.ts 导入单一来源 API',
  )
  assert.ok(
    tplMode.includes('for (const channel of SYNC_CHANNELS)') || tplMode.includes('SYNC_CHANNELS.map('),
    'src/index.ts 的通道集合必须由 SYNC_CHANNELS 派生（不得穷举字面量）',
  )
})

/* ------------------------------- clearSyncChannel：断开通道配置（用户要求：配置过必须能删掉） */

test('clearSyncChannel：删掉活动通道 → 另一条保留，活动通道自动切过去', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-clear-active-'));
  try {
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } });
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav/' } });
    assert.equal((await readFullSyncConfig(dir))?.transport, 'webdav', '前置：第二次写入后活动通道应为 webdav');
    const res = await clearSyncChannel(dir, 'webdav');
    assert.deepEqual(res, { removed: true, hasRemaining: true, transport: 'git' });
    const full = await readFullSyncConfig(dir);
    // 不自动切过去的话，readSyncConfig 会因 transport=webdav 而返回 null —— 一条**配置过**的通道
    // 反而被 UI 显示成「未配置」，用户会以为配置丢了。
    assert.equal(full?.transport, 'git', '活动通道必须自动切到剩下的那条');
    assert.equal(full?.webdav, undefined, '被断开通道的命名空间必须消失');
    assert.equal(full?.git?.repoUrl, 'https://github.com/u/r.git', '另一条通道的地址必须原样保留');
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.transport, 'git');
    assert.equal(raw.webdav, undefined);
    assert.equal(raw.schemaVersion, SYNC_CONFIG_SCHEMA_VERSION);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('clearSyncChannel：删掉非活动通道 → 活动通道保持不变', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-clear-idle-'));
  try {
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } });
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav/' } });
    const res = await clearSyncChannel(dir, 'git');
    assert.deepEqual(res, { removed: true, hasRemaining: true, transport: 'webdav' });
    const full = await readFullSyncConfig(dir);
    assert.equal(full?.transport, 'webdav', '被删的不是活动通道 → 活动通道不动');
    assert.equal(full?.git, undefined);
    assert.equal(full?.webdav?.url, 'https://dav.example.com/dav/');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('clearSyncChannel：删掉唯一一条 → 整个文件被删除（如实回落「未配置」）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-clear-only-'));
  try {
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav/' } });
    const res = await clearSyncChannel(dir, 'webdav');
    assert.deepEqual(res, { removed: true, hasRemaining: false, transport: 'webdav' });
    assert.equal(await readFullSyncConfig(dir), null, '一条不剩必须回落成「未配置」，不得留空配置');
    await assert.rejects(fs.stat(path.join(dir, SYNC_CONFIG_FILE)), '文件必须真的不存在');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('clearSyncChannel：该通道本来没配置 → 幂等成功（removed=false）且不动另一条', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-clear-idem-'));
  try {
    await writeSyncConfig(dir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } });
    const before = await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8');
    const res = await clearSyncChannel(dir, 'webdav');
    assert.deepEqual(res, { removed: false, hasRemaining: true, transport: 'git' });
    assert.equal(await fs.readFile(path.join(dir, SYNC_CONFIG_FILE), 'utf8'), before, '逻辑删除没发生 → 文件不得被改写');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('clearSyncChannel：文件不存在 → 幂等成功且不创建文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-clear-none-'));
  try {
    const res = await clearSyncChannel(dir, 'git');
    assert.deepEqual(res, { removed: false, hasRemaining: false, transport: 'git' });
    await assert.rejects(fs.stat(path.join(dir, SYNC_CONFIG_FILE)), '不得因幂等清空而凭空创建配置文件');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


/* ------------------------------- 云端点通道（s3 / gist）：写 / 读 / 清 往返 */

test('云端点 s3 通道：writeSyncConfig → readSyncConfigFor 往返（只写非密字段，文件无密钥值）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-s3-'));
  try {
    await writeSyncConfig(dir, {
      schemaVersion: 2,
      transport: 's3',
      s3: {
        provider: 'oss',
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        region: 'cn-hangzhou',
        bucket: 'demo-bucket',
        accessKeyId: 'AKIA-FAKE-ID',
        prefix: 'team',
        pathStyle: true,
      },
    });
    const cfg = await readSyncConfigFor(dir, 's3');
    assert.ok(cfg !== null && isS3Config(cfg), 's3 通道必须可回读');
    assert.equal(cfg.s3.provider, 'oss');
    assert.equal(cfg.s3.bucket, 'demo-bucket');
    assert.equal(cfg.s3.pathStyle, true);
    assert.equal(cfg.s3.prefix, 'team');
    assert.equal(channelOf(cfg), 's3');
    // 「保存即选定」：活动 provider 与活动通道指针都指向刚保存的这条
    assert.equal(await readActiveS3Provider(dir), 'oss');
    assert.equal((await readFullSyncConfig(dir))?.transport, 's3');
    assert.equal((await readFullSyncConfig(dir))?.s3?.provider, 'oss');
    // 未配置的 gist 通道 → null（autosync 安静跳过的判据）
    assert.equal(await readSyncConfigFor(dir, 'gist'), null);
    const active = await readSyncConfig(dir);
    assert.ok(active !== null && isS3Config(active), '活动通道 = s3（sync-config.json 的 transport 指针）');
    // 配置文件里只有非密白名单字段，绝无任何密钥值
    const raw = await fs.readFile(path.join(dir, CLOUD_SYNC_CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { savedProviders: { oss: Record<string, unknown> } };
    assert.deepEqual(
      Object.keys(parsed.savedProviders.oss).sort(),
      ['accessKeyId', 'bucket', 'endpoint', 'pathStyle', 'prefix', 'region'],
    );
    for (const key of ['secret', 'secretAccessKey', 'token', 'password']) {
      assert.equal(raw.includes(key), false, '配置文件不得出现密钥字段: ' + key);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('云端点 gist 通道：往返 + 断开（同时收回活动指针）；s3 与 gist 互相独立', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-cloud-'));
  try {
    await writeSyncConfig(dir, {
      schemaVersion: 2,
      transport: 'gist',
      gist: { gistId: 'aa5a315d61ae9438b18d', filePrefix: 'team-sync' },
    });
    await writeSyncConfig(dir, {
      schemaVersion: 2,
      transport: 's3',
      s3: {
        provider: 'minio',
        endpoint: 'https://minio.example.com:9000',
        region: 'us-east-1',
        bucket: 'team-bucket',
        accessKeyId: 'MINIO-KEY-ID',
      },
    });
    // 两条云端点通道可同时配置（各自独立，互不覆盖）
    assert.deepEqual(await listConfiguredChannels(dir), ['s3', 'gist']);
    const gist = await readSyncConfigFor(dir, 'gist');
    assert.ok(gist !== null && isGistConfig(gist));
    assert.equal(gist.gist.gistId, 'aa5a315d61ae9438b18d');
    assert.ok((await readSyncConfigFor(dir, 's3')) !== null);

    // 断 gist → s3 仍在，活动通道自动切回仍配置的那条
    const res = await clearSyncChannel(dir, 'gist');
    assert.deepEqual(res, { removed: true, hasRemaining: true, transport: 's3' });
    assert.equal(await readSyncConfigFor(dir, 'gist'), null);
    assert.ok((await readSyncConfigFor(dir, 's3')) !== null);
    assert.equal((await readFullSyncConfig(dir))?.transport, 's3');

    // 断 s3 → 一条不剩 → sync-config.json 整个删除（如实回落「未配置」）
    const res2 = await clearSyncChannel(dir, 's3');
    assert.deepEqual(res2, { removed: true, hasRemaining: false, transport: 's3' });
    assert.equal(await readFullSyncConfig(dir), null);
    await assert.rejects(fs.stat(path.join(dir, SYNC_CONFIG_FILE)), '一条不剩必须删掉配置文件');
    await assert.rejects(fs.stat(path.join(dir, CLOUD_SYNC_CONFIG_FILE)), '云端点一条不剩时同样删除云配置文件');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('未配置的云端点通道 → readSyncConfigFor 返回 null（autosync 安静跳过 + status 不显示已配置）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-cloud-none-'));
  try {
    assert.equal(await readSyncConfigFor(dir, 's3'), null);
    assert.equal(await readSyncConfigFor(dir, 'gist'), null);
    assert.deepEqual(await listConfiguredChannels(dir), []);
    // 幂等断开：本来没配置 → 不创建任何文件
    assert.deepEqual(await clearSyncChannel(dir, 's3'), { removed: false, hasRemaining: false, transport: 'git' });
    await assert.rejects(fs.stat(path.join(dir, SYNC_CONFIG_FILE)));
    await assert.rejects(fs.stat(path.join(dir, CLOUD_SYNC_CONFIG_FILE)));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('旧云端点文件（无 active）：唯一已保存的 S3 兼容商可推断；多家并存不猜（回落未配置）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-cloud-legacy-'));
  const base = { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', bucket: 'demo-bucket', accessKeyId: 'AK' };
  try {
    await fs.writeFile(
      path.join(dir, CLOUD_SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, savedProviders: { oss: base } }),
      'utf8',
    );
    assert.equal(await readActiveS3Provider(dir), 'oss');
    assert.ok((await readSyncConfigFor(dir, 's3')) !== null);

    // 两家并存且无 active → 不猜（s3 通道视为未配置，绝不随便挑一家同步）
    await fs.writeFile(
      path.join(dir, CLOUD_SYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, savedProviders: { oss: base, cos: base } }),
      'utf8',
    );
    assert.equal(await readActiveS3Provider(dir), null);
    assert.equal(await readSyncConfigFor(dir, 's3'), null);
    assert.deepEqual(await listConfiguredChannels(dir), ['s3'], '已保存 provider 仍表明该通道有配置残留');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


/**
 * t88 跨侧常量守卫：宿主与客户端**同构常量**不得各写一份（t82 的 S2-2）。
 *
 * 背景：`ui/sync-settings-view.ts` 的 `S3_PROVIDERS` 与 `client/sync/sync-view.ts` 的 `cloudSecretRefName()`
 * 曾是宿主 `sync-config.ts` 的 `S3_COMPAT_PROVIDERS` / `cloudSecretRef()` 的**手工镜像**，两侧零断言；
 * 客户端的 `satisfies` 穷尽检查只能拦「宿主新增」，拦不住**改名 / 删除 / 换序** ⇒ 界面静默失配。
 * 处置（t88 选 ①）= 两组常量都提到零依赖的 `utils/shared-constants.ts`（先例 = t32 的 SYNC_CHANNELS），
 * 宿主只 re-export；本守卫 = 运行时逐字相等 + 源码级「只允许一处声明」（与 t32 守卫同风格）。
 */
test('t88 跨侧常量守卫：S3 兼容商清单与云端点密钥槽位引用只有一处声明，两侧必须逐字相等', async () => {
  // ── ① 运行时：共享 = 宿主 re-export = 客户端镜像 ──
  assert.deepEqual([...SHARED_S3_COMPAT_PROVIDERS], ['s3', 'oss', 'cos', 'minio', 'kodo'], '共享清单是唯一声明处（值本身也在此钉住）');
  assert.deepEqual([...S3_COMPAT_PROVIDERS], [...SHARED_S3_COMPAT_PROVIDERS], '宿主必须 re-export 共享清单，不得再写一份');
  assert.deepEqual([...CLOUD_SYNC_PROVIDERS], [...SHARED_S3_COMPAT_PROVIDERS, 'gist'], '云端点通道 = S3 兼容系 + gist');
  assert.deepEqual([...UI_S3_PROVIDERS], [...SHARED_S3_COMPAT_PROVIDERS], 'UI 镜像必须等于共享清单（宿主改名/换序这里就红）');
  const EXPECTED_REFS: Record<string, string> = {
    s3: 'DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY',
    oss: 'DSH_CONFIG_MANAGER_SYNC_OSS_SECRET_ACCESS_KEY',
    cos: 'DSH_CONFIG_MANAGER_SYNC_COS_SECRET_ACCESS_KEY',
    minio: 'DSH_CONFIG_MANAGER_SYNC_MINIO_SECRET_ACCESS_KEY',
    kodo: 'DSH_CONFIG_MANAGER_SYNC_KODO_SECRET_ACCESS_KEY',
    gist: 'DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN',
  };
  for (const p of CLOUD_SYNC_PROVIDERS) {
    assert.equal(cloudSecretRef(p), EXPECTED_REFS[p], '槽位名是与用户可见文案绑定的对外事实，不得漂移：' + p);
    assert.equal(cloudSecretRefName(p), cloudSecretRef(p), '客户端显示用的派生名必须与宿主同源：' + p);
  }
  assert.equal(
    cloudSecretRefName('r2'),
    'DSH_CONFIG_MANAGER_SYNC_R2_SECRET_ACCESS_KEY',
    '未知通道仍按同规则派生（保持历史客户端行为，不因共享化收紧）',
  );

  // ── ② 源码级：字面量只允许出现在零依赖共享模块（测试文件除外：断言里必然要写期望值）──
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));
  const files = (await collectSourceFiles(srcRoot)).filter((f) => !f.endsWith('.test.ts'));
  const providerNeedle = "'s3', 'oss', 'cos', 'minio', 'kodo'";
  const refNeedles = ['DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY', 'DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN'];
  const providerHits: string[] = [];
  const refHits: string[] = [];
  for (const file of files) {
    const rel = path.relative(srcRoot, file).split(path.sep).join('/');
    const content = await fs.readFile(file, 'utf8');
    content.split(String.fromCharCode(10)).forEach((line, i) => {
      if (line.includes(providerNeedle)) providerHits.push(rel + ':' + (i + 1));
      for (const needle of refNeedles) if (line.includes(needle)) refHits.push(needle + '@' + rel + ':' + (i + 1));
    });
  }
  assert.equal(providerHits.length, 1, '兼容商字面量只允许声明一次: ' + JSON.stringify(providerHits));
  assert.ok(providerHits[0]!.startsWith('utils/shared-constants.ts:'), '唯一声明处必须是零依赖共享模块: ' + providerHits[0]);
  const strayRefs = refHits.filter((h) => !h.includes('@utils/shared-constants.ts:'));
  assert.deepEqual(strayRefs, [], '槽位名字面量不得出现在共享模块之外（宿主/客户端都只能引用它）');
  assert.equal(
    refHits.filter((h) => h.includes('@utils/shared-constants.ts:')).length,
    refNeedles.length,
    '每个槽位名都要在共享模块里恰好声明一次',
  );
  // 宿主只 re-export；UI/客户端不得再声明字面量（防「哪天又抄回去」）
  const cfgSrc = await fs.readFile(path.join(srcRoot, 'sync', 'sync-config.ts'), 'utf8');
  assert.ok(cfgSrc.includes('export { S3_COMPAT_PROVIDERS, GIST_PROVIDER, CLOUD_SYNC_PROVIDERS };'), 'sync-config.ts 必须 re-export 兼容商清单');
  const uiSrc = await fs.readFile(path.join(srcRoot, 'ui', 'sync-settings-view.ts'), 'utf8');
  assert.ok(!uiSrc.includes(providerNeedle), 'UI 侧不得再抄一份兼容商字面量（必须是共享常量别名）');
  const viewSrc = await fs.readFile(path.join(srcRoot, 'client', 'sync', 'sync-view.ts'), 'utf8');
  assert.ok(
    viewSrc.includes("export { cloudSecretRefName } from '../../utils/shared-constants.ts';"),
    'client 侧必须 re-export 共享派生函数（不得自己再实现一遍）',
  );
});
/* ------------------------------------------------------------------------------------------------
 * SEC-02 / SEC-03 / SEC-12：repoUrl 白名单（审计 §安全 P0 链）
 *
 * 事实：repoUrl 直接进 git 子进程 argv，且 http(s) 通道会把凭据注入到它的 host 上。原实现只拒
 * 空白与 userinfo，于是「file:// 任意本机仓」「ext::sh -c …」「-c core.pager=…」、环回/私网地址
 * 全都能当同步目标 —— 一旦写进本机配置，git 就会按包方指定的地址执行/送凭据。
 * 白名单口径：只认 http/https/ssh/scp-like 远端；无 host、私网/环回/链路本地、非网络方案、
 * 整串以 '-' 开头一律拒绝。本机路径保留（git 通道的老用法，见 GitTransportOptions.repoUrl 注释）。
 * ---------------------------------------------------------------------------------------------- */

test('validateRepoUrl（SEC-02/03/12）：白名单 —— http(s)/ssh/scp-like 远端通过，危险方案与私网地址一律拒绝', () => {
  // 通过：真实用法的四种形状（https / http / ssh:// / scp-like）+ 本机路径
  for (const ok of [
    'https://github.com/u/r.git',
    'http://git.example.com/u/r.git',
    'ssh://git@git.example.com:2222/u/r.git',
    'git@github.com:u/r.git',
    'git@git.example.com:team/r.git',
    '/home/bob/repos/config.git',
    '../bare',
    'D:/repos/bare',
    'https://github.com/u/r-1.git',
    // 私网边界外（172.16/12 之外的 172.x 与 11.x 不是保留段）
    'https://172.32.0.1/r.git',
    'https://11.0.0.1/r.git',
  ]) {
    assert.equal(validateRepoUrl(ok), null, '应通过: ' + ok);
  }

  // 拒绝：方案白名单（SEC-03）+ 无 host + 私网/环回/链路本地（SEC-02）+ 以 '-' 开头（SEC-12）
  for (const bad of [
    'file:///c:/repos/x.git',
    'file:///etc/passwd',
    'ext::sh -c touch% /tmp/pwned',
    'ftp://git.example.com/r.git',
    'git://git.example.com/r.git',
    'https://',
    'https:///r.git',
    'https://127.0.0.1:8443/r.git',
    'http://localhost:3000/r.git',
    'https://[::1]/r.git',
    'ssh://git@127.0.0.1/r.git',
    'git@localhost:r.git',
    'https://10.0.0.5/r.git',
    'https://192.168.1.10/r.git',
    'https://172.16.0.9/r.git',
    'https://172.31.255.1/r.git',
    'https://169.254.169.254/latest/meta-data/',
    'https://[fe80::1]/r.git',
    '-c core.pager=touch /tmp/pwned',
    '--upload-pack=touch /tmp/pwned',
    'https://user:ghp_token@github.com/u/r.git',
    'https://github.com/u/r .git',
  ]) {
    const err = validateRepoUrl(bad);
    assert.equal(typeof err, 'string', '必须拒绝: ' + bad);
    assert.ok(err !== null && err.length > 0, '拒绝必须带可展示原因: ' + bad);
  }
});

test('readSyncConfig（SEC-01 读侧）：已存 repoUrl 走同一校验；不合法 → 不返回该配置并给明确 issue', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-cfg-repo-'));
  try {
    // 合法：照常读出，无 issue
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({
      schemaVersion: 3, transport: 'git',
      git: { repoUrl: 'https://github.com/u/r.git' }, webdav: {},
    }, null, 2), 'utf8');
    const issues: SyncConfigIssue[] = [];
    const ok = await readSyncConfig(dir, issues);
    assert.equal(issues.length, 0, '合法 repoUrl 不该产生 issue');
    assert.ok(ok !== null && isGitConfig(ok));

    // 不合法：包方写进来的 file:// 目标 —— 读侧必须当成「未配置」，且给出明确原因
    for (const badUrl of [
      'file:///c:/repos/x.git',
      'ext::sh -c touch% /tmp/pwned',
      'https://169.254.169.254/latest/meta-data/',
      'https://user:ghp_x@github.com/u/r.git',
    ]) {
      await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({
        schemaVersion: 3, transport: 'git', git: { repoUrl: badUrl }, webdav: {},
      }, null, 2), 'utf8');
      const local: SyncConfigIssue[] = [];
      const cfg = await readSyncConfig(dir, local);
      assert.equal(cfg, null, '不合法的 repoUrl 不得进入后续凭据注入: ' + badUrl);
      assert.equal(local.length, 1, '必须显式记录被拒的通道，不得静默: ' + badUrl);
      assert.equal(local[0]?.code, 'repo-url-invalid');
      assert.equal(local[0]?.channel, 'git');
      assert.ok((local[0]?.message ?? '').length > 0, '必须带可展示原因');

      // 省略 issue 收集参数时行为不变（老调用方仍拿 null = 未配置）
      assert.equal(await readSyncConfig(dir), null);
    }

    // v1 旧文件（扁平 repoUrl）走同一校验
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({ schemaVersion: 1, repoUrl: 'file:///etc' }), 'utf8');
    const legacyIssues: SyncConfigIssue[] = [];
    assert.equal(await readSyncConfig(dir, legacyIssues), null, 'v1 旧文件的 repoUrl 也要校验');
    assert.equal(legacyIssues.length, 1);

    // 本机路径仍是 git 通道的合法目标（产品既有能力，不因白名单被砍）
    await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({
      schemaVersion: 3, transport: 'git', git: { repoUrl: '/home/bob/repos/config.git' }, webdav: {},
    }, null, 2), 'utf8');
    const localIssues: SyncConfigIssue[] = [];
    const localCfg = await readSyncConfig(dir, localIssues);
    assert.equal(localIssues.length, 0);
    assert.ok(localCfg !== null && isGitConfig(localCfg) && localCfg.git.repoUrl === '/home/bob/repos/config.git');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------------------------------
 * RV1-F6 / F7：私网拒绝的文案口径 + userinfo 覆盖 ssh（复核在 SEC-02/12 里抓到的两处边角）
 *
 * F6：环回/私网复用「无法解析仓库地址」= 给了用户错的方向（他会反复改写法）。真实判据是
 *     「这个地址指向本机/内网，不作为同步目标」，因此单独一条 sync.configPrivateHost。
 * F7：userinfo 检查原来只在 http/https 分支内，`ssh://user:tok@host/r.git` 能过白名单，
 *     token 会跟着 repoUrl 进 argv、进 sync-config.json。口径改成「password 位任何 scheme 都拒」。
 * ---------------------------------------------------------------------------------------------- */

test('validateRepoUrl（RV1-F6）：私网/环回用专属文案，且回显地址已脱敏（不含 userinfo）', () => {
  const cases: Array<[string, string]> = [
    ['https://127.0.0.1:8443/r.git', '127.0.0.1:8443'],
    ['http://localhost:3000/r.git', 'localhost:3000'],
    ['https://192.168.1.10/r.git', '192.168.1.10'],
    ['https://169.254.169.254/latest/meta-data/', '169.254.169.254'],
    ['ssh://git@10.0.0.5/r.git', '10.0.0.5'],
  ];
  for (const [url, host] of cases) {
    const err = validateRepoUrl(url);
    assert.ok(err !== null, '私网地址必须拒绝: ' + url);
    assert.ok(err.includes('本机或内网'), '原因必须是「指向本机/内网」，不能复用解析失败: ' + err);
    assert.ok(!err.includes('无法解析'), '不得再用「无法解析仓库地址」描述私网: ' + err);
    assert.ok(err.includes(host), '要能认出被拒的是哪个地址: ' + err);
  }

  // 回显脱敏：私网 + userinfo 同时出现时，文案里只能有 host，不能有 user/token
  const withToken = validateRepoUrl('https://user:ghp_secretvalue@192.168.1.10/r.git');
  assert.ok(withToken !== null);
  assert.ok(withToken.includes('192.168.1.10'), '地址主体保留: ' + withToken);
  assert.ok(!withToken.includes('ghp_secretvalue') && !withToken.includes('user:'), '文案不得回显凭据: ' + withToken);

  // 私网判定先于 userinfo：带 userinfo 的私网地址仍报「内网」，而不是「别带凭据」
  assert.ok(withToken.includes('本机或内网'), '私网判定优先: ' + withToken);
});

test('validateRepoUrl（RV1-F7）：带 scheme 的 userinfo —— ssh 的 token 也被拒，ssh 登录名仍放行', () => {
  // ssh 里 password 位 = 可粘贴的 token → 拒
  for (const bad of ['ssh://user:tok@example.com/r.git', 'ssh://git:ghp_abc@example.com:22/u/r.git', 'ssh://:tok@example.com/r.git']) {
    assert.equal(validateRepoUrl(bad), validateRepoUrl('https://user:tok@example.com/r.git'), 'ssh userinfo 与 http 同口径: ' + bad);
    assert.ok((validateRepoUrl(bad) ?? '').includes('用户名/密码'), '必须是 userinfo 文案: ' + bad);
  }
  // ssh 的 username 是登录名（标准写法）→ 放行；否则会杀掉合法用法
  for (const ok of ['ssh://git@git.example.com:2222/u/r.git', 'ssh://deploy@git.example.com/u/r.git', 'git@github.com:u/r.git']) {
    assert.equal(validateRepoUrl(ok), null, 'ssh 登录名不是凭据，必须放行: ' + ok);
  }
  // http(s) 的 username 与口令等同（Basic 认证）→ 仍拒
  for (const bad of ['https://user@github.com/u/r.git', 'http://user@git.example.com/u/r.git']) {
    assert.ok((validateRepoUrl(bad) ?? '').includes('用户名/密码'), 'http(s) 的 username 仍拒: ' + bad);
  }

  // 解析不了的半截地址也必须脱敏回显（`https://user:tok@` 前缀就是凭据）
  const half = validateRepoUrl('https://user:ghp_halfsecret@');
  assert.ok(half !== null);
  assert.ok(!half.includes('ghp_halfsecret'), '无法解析的地址同样不得回显凭据: ' + half);
});
