/**
 * SEC-03 可见性 + webdav username 回填：下沉模块 `config-issue-reporting.ts` 的行为契约。
 *
 * 这里守的两条都是**可见性语义**，不是实现细节：
 *  1) 「同步配置被拒」的告警按 (通道/码/文案) 去重 —— prepareSync 每个同步请求都跑，
 *     重复行会把日志刷成噪音；但不同被拒地址的文案不同，必须再报一次。
 *  2) webdav 请求体没带 username 时从持久化配置回填（留空 = 沿用已保存凭据），
 *     回填失败（读不到/读坏）保持原值交给下游校验，绝不静默改成别的通道配置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPrepareSync, createSyncConfigIssueReporter } from './config-issue-reporting.ts';
import { isGitConfig, isWebDavConfig, SYNC_CONFIG_FILE, type SyncConfig, type SyncConfigIssue } from './sync-config.ts';

const issue = (message: string, channel: SyncConfigIssue['channel'] = 'git'): SyncConfigIssue =>
  ({ code: 'repo-url-invalid', channel, message });

const webdavCfg = (username?: string): SyncConfig => ({
  schemaVersion: 2,
  transport: 'webdav',
  webdav: username === undefined ? { url: 'https://dav.example.com/remote.php/dav' } : { url: 'https://dav.example.com/remote.php/dav', username },
});

const gitCfg = (repoUrl: string): SyncConfig => ({ schemaVersion: 2, transport: 'git', git: { repoUrl } });

/** 与宿主 `mergePersistedWebDavUsername` 同语义的最小实现（不 import 4400 行的入口模块）。 */
const mergeStub = (cfg: SyncConfig, persisted: SyncConfig | null): SyncConfig => {
  if (persisted === null || persisted.transport !== 'webdav' || persisted.schemaVersion !== 2) return cfg;
  if (cfg.transport !== 'webdav' || cfg.schemaVersion !== 2) return cfg;
  const saved = persisted.webdav.username;
  if (saved === undefined || saved === '') return cfg;
  return { ...cfg, webdav: { ...cfg.webdav, username: saved } };
};

async function tmpSyncDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-issue-report-'));
  return dir;
}

test('SEC-03 报告器：同一 (通道/码/文案) 只输出一次，跨调用累计', () => {
  const lines: string[] = [];
  const report = createSyncConfigIssueReporter((line) => lines.push(line));
  report([issue('private address')]);
  report([issue('private address')]);
  report([issue('private address'), issue('private address')]);
  assert.deepEqual(lines, ['sync config rejected (git/repo-url-invalid): private address']);
});

test('SEC-03 报告器：不同文案或不同通道各自成一条（新信息不吞）', () => {
  const lines: string[] = [];
  const report = createSyncConfigIssueReporter((line) => lines.push(line));
  report([issue('private address 192.168.1.10'), issue('private address 10.0.0.5')]);
  report([issue('private address 192.168.1.10', 'webdav')]);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, [
    'sync config rejected (git/repo-url-invalid): private address 192.168.1.10',
    'sync config rejected (git/repo-url-invalid): private address 10.0.0.5',
    'sync config rejected (webdav/repo-url-invalid): private address 192.168.1.10',
  ]);
});

test('SEC-03 报告器：空 issues 不产生任何输出（无幻影告警）', () => {
  const lines: string[] = [];
  createSyncConfigIssueReporter((line) => lines.push(line))([]);
  assert.deepEqual(lines, []);
});

test('prepareSync：webdav 未带 username → 从持久化配置回填（留空 = 沿用已保存凭据）', async () => {
  const dir = await tmpSyncDir();
  await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({
    schemaVersion: 3,
    transport: 'webdav',
    webdav: { url: 'https://dav.example.com/remote.php/dav', username: 'saved-user' },
  }), 'utf8');
  const lines: string[] = [];
  const prepareSync = createPrepareSync({
    syncDir: dir,
    parseBody: async () => webdavCfg(),
    mergeWebDavUsername: mergeStub,
    log: (line) => lines.push(line),
  });
  const cfg = await prepareSync({});
  assert.ok(isWebDavConfig(cfg));
  assert.equal(cfg.webdav.username, 'saved-user');
  assert.deepEqual(lines, []);
});

test('prepareSync：已存 repoUrl 被白名单拒绝 → 日志报成因，且按通道/文案去重（两次调用只一行）', async () => {
  const dir = await tmpSyncDir();
  await fs.writeFile(path.join(dir, SYNC_CONFIG_FILE), JSON.stringify({
    schemaVersion: 3,
    transport: 'git',
    git: { repoUrl: 'https://192.168.1.10/owner/repo.git' },
  }), 'utf8');
  const lines: string[] = [];
  const prepareSync = createPrepareSync({
    syncDir: dir,
    parseBody: async () => webdavCfg(),
    mergeWebDavUsername: mergeStub,
    log: (line) => lines.push(line),
  });
  await prepareSync({});
  await prepareSync({});
  assert.equal(lines.length, 1, '同一成因重复请求也只能报一次');
  assert.match(lines[0]!, /^sync config rejected \(git\/repo-url-invalid\): /);
  assert.match(lines[0]!, /192\.168\.1\.10/);
});

test('prepareSync：请求体已带 username → 不读盘、不改值（git 通道同样原样返回）', async () => {
  const dir = await tmpSyncDir();
  let merged = 0;
  const prepareSync = createPrepareSync({
    syncDir: dir,
    parseBody: async () => webdavCfg('explicit-user'),
    mergeWebDavUsername: (cfg, persisted) => { merged += 1; return mergeStub(cfg, persisted); },
    log: () => {},
  });
  const cfg = await prepareSync({});
  assert.ok(isWebDavConfig(cfg));
  assert.equal(cfg.webdav.username, 'explicit-user');
  assert.equal(merged, 0);

  const gitPrepare = createPrepareSync({
    syncDir: dir,
    parseBody: async () => gitCfg('https://github.com/owner/repo.git'),
    mergeWebDavUsername: () => { throw new Error('git 通道不该走 webdav 回填'); },
    log: () => {},
  });
  const git = await gitPrepare({});
  assert.ok(isGitConfig(git));
  assert.equal(git.git.repoUrl, 'https://github.com/owner/repo.git');
});

test('prepareSync：持久化配置缺失 → 保持请求体原值（不猜、不改通道）', async () => {
  const dir = await tmpSyncDir();
  const prepareSync = createPrepareSync({
    syncDir: dir,
    parseBody: async () => webdavCfg(),
    mergeWebDavUsername: mergeStub,
    log: () => {},
  });
  const cfg = await prepareSync({});
  assert.deepEqual(cfg, webdavCfg());
});
