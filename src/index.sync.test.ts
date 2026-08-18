/**
 * M3：Host 同步路由的 transport 分支解析与校验测试（failing-first 目标）。
 *
 * 直接测导出的纯函数（仿 buildRestoreBody 模式），不依赖真实 Cordis Context：
 * - parseSyncBody：按 body.transport 分支解析 git/webdav（可辨识联合 SyncConfig）；
 *   必填校验；validateWebDavUrl/validateRepoUrl；password/token 非空写入对应
 *   独立 credentials ref（SYNC_WEBDAV_CREDENTIAL_REF / SYNC_CREDENTIAL_REF）。
 * - webdavBaseUrl：由 webdav.url 合成通道 baseUrl（尾部 '/'）；git 通道返回 ''。
 * - SyncRouteError：非 2xx 请求级错误。
 *
 * 凭据用内存 mock（记录 set 的 (ref, value)），不触碰真实 DSH credentials。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSyncBody, webdavBaseUrl, extractSyncSections, mergePersistedWebDavUsername, SyncRouteError,
  SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF,
  type ParseSyncBodyDeps,
} from './index.ts';
import { isWebDavConfig, type SyncConfig } from './sync/sync-config.ts';

/** 内存凭据 mock：记录写入的 (ref, value) 列表 */
function memCreds(): ParseSyncBodyDeps & { writes: Array<[string, string]>; } {
  const writes: Array<[string, string]> = [];
  return {
    writes,
    credentials: {
      async set(ref: unknown, value: string) {
        writes.push([String(ref), value]);
      },
    } as unknown as ParseSyncBodyDeps['credentials'],
  };
}

/* ---------------- git 分支 ---------------- */

test('parseSyncBody: git 分支（缺省 transport）解析 repoUrl（gitBin 已废弃），token 写入 SYNC_CREDENTIAL_REF', async () => {
  const deps = memCreds();
  const cfg = await parseSyncBody(
    { repoUrl: 'https://github.com/foo/bar.git', gitBin: '/usr/bin/git', token: 'tok-123' },
    deps,
  );
  assert.deepEqual(cfg, {
    schemaVersion: 2,
    transport: 'git',
    git: { repoUrl: 'https://github.com/foo/bar.git' },
  });
  assert.deepEqual(deps.writes, [[SYNC_CREDENTIAL_REF, 'tok-123']], 'token 写 git credentials ref，不写 webdav ref');
});

test('parseSyncBody: git 分支无 token → 不写凭据', async () => {
  const deps = memCreds();
  const cfg = await parseSyncBody({ repoUrl: 'git@github.com:foo/bar.git' }, deps);
  assert.deepEqual(cfg, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } });
  assert.equal(deps.writes.length, 0, '无 token 不产生凭据写入');
});

test('parseSyncBody: git 分支缺 repoUrl → SyncRouteError', async () => {
  const deps = memCreds();
  await assert.rejects(
    () => parseSyncBody({ transport: 'git' }, deps),
    (err) => err instanceof SyncRouteError && /repoUrl is required/.test(err.message),
  );
});

test('parseSyncBody: git 分支 repoUrl 含 userinfo（token 拼 URL）→ 拒绝', async () => {
  const deps = memCreds();
  await assert.rejects(
    () => parseSyncBody({ repoUrl: 'https://user:pass@github.com/foo/bar.git' }, deps),
    (err) => err instanceof SyncRouteError,
  );
});

/* ---------------- webdav 分支 ---------------- */

test('parseSyncBody: webdav 分支解析 url/username，password 写入 SYNC_WEBDAV_CREDENTIAL_REF', async () => {
  const deps = memCreds();
  const cfg = await parseSyncBody(
    {
      transport: 'webdav',
      url: 'https://dav.example.com/remote.php/dav/files/user',
      username: 'alice',
      password: 'pw-secret',
    },
    deps,
  );
  assert.deepEqual(cfg, {
    schemaVersion: 2,
    transport: 'webdav',
    webdav: { url: 'https://dav.example.com/remote.php/dav/files/user', username: 'alice' },
  });
  assert.deepEqual(deps.writes, [[SYNC_WEBDAV_CREDENTIAL_REF, 'pw-secret']], 'password 写独立 webdav credentials ref');
});

test('parseSyncBody: webdav 分支缺 url → SyncRouteError', async () => {
  const deps = memCreds();
  await assert.rejects(
    () => parseSyncBody({ transport: 'webdav', username: 'alice' }, deps),
    (err) => err instanceof SyncRouteError && /url is required/.test(err.message),
  );
});

test('parseSyncBody: webdav 分支 url 非 http(s)/含 userinfo → 拒绝', async () => {
  const deps = memCreds();
  await assert.rejects(
    () => parseSyncBody({ transport: 'webdav', url: 'ftp://dav.example.com' }, deps),
    (err) => err instanceof SyncRouteError,
  );
  await assert.rejects(
    () => parseSyncBody({ transport: 'webdav', url: 'https://u:p@dav.example.com' }, deps),
    (err) => err instanceof SyncRouteError,
  );
});

test('parseSyncBody: webdav 分支无 password → 不写凭据', async () => {
  const deps = memCreds();
  const cfg = await parseSyncBody({ transport: 'webdav', url: 'https://dav.example.com' }, deps);
  assert.equal(cfg.transport, 'webdav');
  assert.equal(deps.writes.length, 0);
});

test('parseSyncBody: HTTP 凭据写入失败 → SyncRouteError（含 ref 名，无 secret）', async () => {
  const deps: ParseSyncBodyDeps = {
    credentials: {
      async set() { throw new Error('denied'); },
    } as unknown as ParseSyncBodyDeps['credentials'],
  };
  await assert.rejects(
    () => parseSyncBody({ transport: 'webdav', url: 'https://dav.example.com', password: 'pw' }, deps),
    (err) => err instanceof SyncRouteError && err.message.includes(SYNC_WEBDAV_CREDENTIAL_REF) && !err.message.includes('pw'),
  );
});

/* ---------------- webdavBaseUrl ---------------- */

test('webdavBaseUrl: webdav.url 作为 base，尾部规范化带 /；git 通道返回空', () => {
  const webdav: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/remote.php/dav/files/user' } };
  assert.equal(webdavBaseUrl(webdav), 'https://dav.example.com/remote.php/dav/files/user/');
  assert.equal(
    webdavBaseUrl({ ...webdav, webdav: { url: 'https://dav.example.com/' } }),
    'https://dav.example.com/',
  );
  const git: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } };
  assert.equal(webdavBaseUrl(git), '', 'git 通道无 webdav baseUrl');
});

/* ---------------- extractSyncSections（push 分区选择） ---------------- */

const KNOWN = new Set(['settings', 'providers', 'plugins', 'skills']);

test('extractSyncSections: 缺省 / 非数组 / 空数组 → undefined（默认全量推荐分区）', () => {
  assert.equal(extractSyncSections({ repoUrl: 'x' }, KNOWN), undefined);
  assert.equal(extractSyncSections({ sections: 'settings' }, KNOWN), undefined, '非数组视为未指定');
  assert.equal(extractSyncSections({ sections: [] }, KNOWN), undefined, '空数组视为未指定');
});

test('extractSyncSections: 合法分区 → 去重保序返回 SectionId[]', () => {
  assert.deepEqual(
    extractSyncSections({ sections: ['plugins', 'settings', 'settings'] }, KNOWN),
    ['plugins', 'settings'],
    '重复分区去重，保持首次出现顺序',
  );
});

test('extractSyncSections: 元素非字符串 / 空串 → SyncRouteError', () => {
  assert.throws(
    () => extractSyncSections({ sections: ['settings', 42] }, KNOWN),
    (err) => err instanceof SyncRouteError && /sections/.test(err.message),
  );
  assert.throws(
    () => extractSyncSections({ sections: [''] }, KNOWN),
    (err) => err instanceof SyncRouteError,
  );
});

test('extractSyncSections: 元素为未知分区 id → SyncRouteError（不静默吞错）', () => {
  assert.throws(
    () => extractSyncSections({ sections: ['settings', 'nope'] }, KNOWN),
    (err) => err instanceof SyncRouteError && /nope/.test(err.message),
  );
});

/* ---------------- mergePersistedWebDavUsername（prepareSync username 回退） ---------------- */

const WEBDAV_CFG: SyncConfig = { schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav' } };
const WEBDAV_WITH_USER: SyncConfig = {
  schemaVersion: 2, transport: 'webdav', webdav: { url: 'https://dav.example.com/dav', username: 'alice' },
};
const GIT_CFG: SyncConfig = { schemaVersion: 2, transport: 'git', git: { repoUrl: 'git@github.com:foo/bar.git' } };

test('mergePersistedWebDavUsername: webdav 缺 username + 持久化有 username → 回填（snapshotsList 挂载自动加载场景）', () => {
  const cfg = mergePersistedWebDavUsername({ ...WEBDAV_CFG }, { ...WEBDAV_WITH_USER });
  assert.ok(isWebDavConfig(cfg) && cfg.webdav.username === 'alice', '回填持久化 username');
});

test('mergePersistedWebDavUsername: 请求已带 username → 保留新值不回填（用户输入优先）', () => {
  const cfg = mergePersistedWebDavUsername(
    { ...WEBDAV_CFG, webdav: { ...WEBDAV_CFG.webdav, username: 'bob' } },
    { ...WEBDAV_WITH_USER },
  );
  assert.ok(isWebDavConfig(cfg) && cfg.webdav.username === 'bob');
});

test('mergePersistedWebDavUsername: 持久化无 username / 非 webdav / 为 null → 原样返回', () => {
  const noUser = mergePersistedWebDavUsername({ ...WEBDAV_CFG }, { ...WEBDAV_CFG });
  assert.ok(isWebDavConfig(noUser) && noUser.webdav.username === undefined, '持久化无 username 不回填');

  const gitPersisted = mergePersistedWebDavUsername({ ...WEBDAV_CFG }, { ...GIT_CFG });
  assert.ok(isWebDavConfig(gitPersisted) && gitPersisted.webdav.username === undefined, '持久化是 git 通道不回填');

  const nullPersisted = mergePersistedWebDavUsername({ ...WEBDAV_CFG }, null);
  assert.ok(isWebDavConfig(nullPersisted) && nullPersisted.webdav.username === undefined, '无持久化配置原样返回');

  const gitCfg = mergePersistedWebDavUsername({ ...GIT_CFG }, { ...WEBDAV_WITH_USER });
  assert.deepEqual(gitCfg, GIT_CFG, 'git 请求体不受影响');
});
