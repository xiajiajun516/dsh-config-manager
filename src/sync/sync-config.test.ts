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
  readSyncConfig, readFullSyncConfig, writeSyncConfig, isGitConfig, isWebDavConfig,
  SYNC_CONFIG_FILE, SYNC_CONFIG_SCHEMA_VERSION, SYNC_CONFIG_SUPPORTED_VERSIONS,
  validateWebDavUrl, type SyncConfig,
  SYNC_CHANNELS, channelOf, channelMap, isSyncTransportType, parseSyncChannel,
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
/* ---------------- t32：通道枚举唯一来源（SYNC_CHANNELS / channelOf / channelMap） ---------------- */

test('t32：SYNC_CHANNELS 是通道枚举唯一来源；isSyncTransportType / parseSyncChannel 同源', () => {
  assert.deepEqual([...SYNC_CHANNELS], ['git', 'webdav']);
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
  assert.deepEqual(out, { git: 'git!', webdav: 'webdav!' });
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
  assert.equal(canonical[0]!.file, 'sync/sync-config.ts', '唯一声明处必须是 src/sync/sync-config.ts');
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

