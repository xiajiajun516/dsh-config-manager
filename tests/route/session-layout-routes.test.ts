/**
 * E1 路由行为测试：`POST /api/dsh-config-manager/recovery/sessions/layout`。
 *
 * 为什么必须有：这是面板第一次能在 **DSH 运行中**改会话**位置**（CLI 要求先停 DSH，面板不可能满足）。
 * 逐条钉住：只读计划零写入 / 真归位 / 重复 id 必须显式 keep / 索引刷新失败回滚 / 门拒绝 /
 * SAFE MODE 拦截 / 响应不含绝对路径。**受保护的 session-repair-routes.test.ts 一个字节都不动。**
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { recoveryRoutes } from '../../src/routes/recovery.ts';
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts';
import { emptySessionMeta, projectKeyOf } from '../../src/core/session-meta.ts';
import { readLogFileCwd } from '../../src/utils/session-log.ts';
import { encodeZstdFrame, zstdAvailable } from '../../src/utils/zstd-frame.ts';

const CAPABLE = zstdAvailable();
const BASE = '/api/dsh-config-manager/recovery';
const LOG_NAME = 'session.v4.jsonl.zstd';
const MISPLACED = '--D-Ghost-proj--';
const REAL_CWD = 'D:/Real/proj';

interface Harness {
  root: string;
  homeDir: string;
  dataDir: string;
  safeMode: { blocked: boolean };
  reindexCalls: string[];
  reindexOk: { value: boolean };
  lock: { port: unknown; acquireCalls: () => number };
  cleanup: () => Promise<void>;
}

function logBytes(sessionId: string, cwd: string): Buffer {
  const header = { type: 'session', version: 4, id: sessionId, cwd };
  return Buffer.concat([
    encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8')),
    encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 0 }) + '\n', 'utf8')),
  ]);
}

async function makeUnit(h: Harness, projectKey: string, sessionId: string, cwd: string, opts: { fresh?: boolean; lock?: boolean } = {}): Promise<string> {
  const dir = path.join(h.homeDir, 'sessions', projectKey, sessionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOG_NAME);
  await fs.writeFile(file, logBytes(sessionId, cwd));
  const stamp = opts.fresh === true ? new Date() : new Date(Date.now() - 600_000);
  await fs.utimes(file, stamp, stamp);
  if (opts.lock === true) await fs.writeFile(path.join(dir, 'session.lock'), 'locked');
  return dir;
}

async function treeOf(root: string): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out.push(rel + ':' + String((await fs.stat(path.join(dir, entry.name))).size));
    }
  }
  await walk(root, '');
  return out.join('|');
}

/** 真实临时 home + 真实路由 handler；锁端口恒 ACQUIRED（锁行为由 env-lock 单测覆盖）。 */
async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-layout-route-'));
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(homeDir, 'sessions'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const stats = { acquire: 0 };
  const h: Harness = {
    root,
    homeDir,
    dataDir,
    safeMode: { blocked: false },
    reindexCalls: [],
    reindexOk: { value: true },
    lock: {
      port: {
        acquire: async () => {
          stats.acquire += 1;
          return { state: 'ACQUIRED' as const, token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() } };
        },
        validate: () => true,
        release: async () => {},
      },
      acquireCalls: () => stats.acquire,
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
  return h;
}

function envFor(h: Harness): never {
  const env = {
    dataDir: h.dataDir,
    host: {
      mutationLock: h.lock.port,
      safeModeIsBlocked: () => h.safeMode.blocked,
      log: { warn: () => {} },
      sessions: {
        reindexSessionHeader: async (sessionId: string) => {
          h.reindexCalls.push(sessionId);
          return h.reindexOk.value;
        },
      },
    },
    sessionHealth: {
      homeDir: h.homeDir,
      targetFormatVersion: () => 4,
      workspaceKeys: async () => new Set<string>(),
      knownSessionIds: async () => new Set<string>(),
      // T4+：体检行补「对话标题」（路由经它与导出选择器共用同一份会话元数据索引）；
      // 这里给空索引 = 读不到 DSH 缓存时的形态（不许在路由层编造标题）。
      sessionMeta: async () => emptySessionMeta(),
    },
    tryAppendHistory: async () => undefined,
    recoveryOrchestrator: {},
    makeRecoveryExecutors: () => ({}),
  };
  return env as never;
}

function routeFor(h: Harness): WebRoute {
  const routes = recoveryRoutes(envFor(h));
  const found = routes.find((r) => routeSpecOf(r)?.path === BASE);
  assert.ok(found !== undefined, 'recovery prefix 路由缺失');
  return found;
}

function fakeRequest(opts: { method?: string; url?: string; body?: string } = {}): IncomingMessage {
  const req = {
    method: opts.method ?? 'POST',
    url: opts.url ?? BASE + '/sessions/layout',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      if (opts.body !== undefined) yield Buffer.from(opts.body, 'utf8');
    },
  };
  return req as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this },
    end(payload?: string) { state.body = payload ?? ''; return this },
  };
  return { res: res as unknown as ServerResponse, status: () => state.status, json: () => JSON.parse(state.body) as Record<string, unknown> };
}

async function call(h: Harness, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routeFor(h);
  const res = fakeResponse();
  await route.handler(fakeRequest({ body: JSON.stringify(body) }), res.res);
  return { status: res.status(), json: res.json() };
}

test('E1 ① 计划只读：POST layout（apply 缺省）返回计划且**零写入**，不含绝对路径', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    await makeUnit(h, MISPLACED, 'session-move', REAL_CWD);
    await makeUnit(h, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(h, '--b--', 'session-dup', REAL_CWD);
    const before = await treeOf(h.homeDir);
    const res = await call(h, {});
    assert.equal(res.status, 200);
    assert.equal(res.json['ok'], true);
    assert.equal(res.json['readOnly'], true);
    const actions = res.json['actions'] as Record<string, unknown>[];
    assert.equal(actions.some((a) => a['unitId'] === MISPLACED + '/session-move' && a['kind'] === 'move'), true);
    assert.deepEqual(res.json['needsKeep'], ['session-dup']);
    assert.deepEqual(h.reindexCalls, [], '只读计划不得刷新索引');
    assert.equal(h.lock.acquireCalls(), 0, '只读计划不拿 mutation lock');
    assert.deepEqual(await treeOf(h.homeDir), before, '计划必须零写入');
    const text = JSON.stringify(res.json);
    assert.equal(text.includes(h.root), false, '响应不得含绝对路径');
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, '响应不得含盘符路径');
    assert.equal(text.includes(String.fromCharCode(92)), false, '响应不得含 Windows 分隔符');
  } finally {
    await h.cleanup();
  }
});

test('E1 ② 应用：location-mismatch 真搬目录 + 首帧不改写 + 索引刷新被调用；SAFE MODE 时被拦（零写入）', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const from = await makeUnit(h, MISPLACED, 'session-move', REAL_CWD);
    const bytes = await fs.readFile(path.join(from, LOG_NAME));

    // SAFE MODE：过 mutation gate 时被拦 → 423 mutation-locked，且一个字节都不动（也没去拿锁）
    h.safeMode.blocked = true;
    const blocked = await call(h, { apply: true });
    assert.equal(blocked.status, 423, JSON.stringify(blocked.json));
    assert.equal(blocked.json['code'], 'mutation-locked');
    assert.equal(await fs.stat(from).then(() => true, () => false), true, 'SAFE MODE 下不得搬目录');
    assert.equal(h.lock.acquireCalls(), 0, 'SAFE MODE 判定在拿锁之前（根本没去 acquire）');

    h.safeMode.blocked = false;
    const res = await call(h, { apply: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json['ok'], true);
    assert.equal(res.json['applied'], 1);
    assert.deepEqual(h.reindexCalls, ['session-move'], '每次移动后必须刷新索引');
    const placedKey = projectKeyOf(REAL_CWD);
    const to = path.join(h.homeDir, 'sessions', placedKey, 'session-move');
    assert.equal(await fs.stat(to).then(() => true, () => false), true);
    assert.equal(await fs.stat(from).then(() => true, () => false), false);
    assert.equal((await fs.readFile(path.join(to, LOG_NAME))).equals(bytes), true, '纯归位不改字节');
    assert.equal(await readLogFileCwd(path.join(to, LOG_NAME)), REAL_CWD);
    const text = JSON.stringify(res.json);
    assert.equal(text.includes(h.root), false, '响应不得含绝对路径');
    assert.equal(/[A-Za-z]:[\\/]/.test(text), false, '响应不得含盘符路径');
  } finally {
    await h.cleanup();
  }
});

test('E1 ③ 重复 id 未给 keep → 拒绝执行并说明（missing-keep），零写入', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    await makeUnit(h, '--a--', 'session-dup', REAL_CWD);
    await makeUnit(h, '--b--', 'session-dup', REAL_CWD);
    const before = await treeOf(h.homeDir);
    const res = await call(h, { apply: true });
    assert.equal(res.status, 200);
    assert.equal(res.json['ok'], false);
    assert.equal(res.json['applied'], 0);
    const results = res.json['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    assert.deepEqual([...new Set(results.map((r) => r['reason']))], ['missing-keep']);
    assert.deepEqual(h.reindexCalls, []);
    assert.deepEqual(await treeOf(h.homeDir), before);
  } finally {
    await h.cleanup();
  }
});

test('E1 ④ 给了 keep → 保留者不动、其余进 quarantine 目录（响应给相对去向）', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const kept = await makeUnit(h, '--a--', 'session-dup', REAL_CWD);
    const dup = await makeUnit(h, '--b--', 'session-dup', REAL_CWD);
    const res = await call(h, { apply: true, keep: { 'session-dup': '--a--/session-dup' } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json['ok'], true);
    assert.equal(res.json['applied'], 1);
    const item = (res.json['results'] as Record<string, unknown>[]).find((r) => r['action'] === 'quarantine');
    const quarantineDir = String(item?.['quarantineDir']);
    assert.match(quarantineDir, /^\.cm-repair-quarantine-\d{4}-\d{2}-\d{2}T[\d-]+Z\/--b--\/session-dup$/);
    assert.equal(quarantineDir.startsWith('.cm-repair-quarantine-'), true);
    assert.equal(await fs.stat(kept).then(() => true, () => false), true, '保留者原地不动');
    assert.equal(await fs.stat(dup).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(h.homeDir, 'sessions', quarantineDir)).then(() => true, () => false), true);
    assert.deepEqual(h.reindexCalls, ['session-dup'], '隔离后必须刷新该会话索引');
    const text = JSON.stringify(res.json);
    assert.equal(text.includes(h.root), false, '响应不得含绝对路径');
  } finally {
    await h.cleanup();
  }
});

test('E1 ⑤ 索引刷新失败 → 该条回滚（目录回原位、字节不变、rolledBack:true）', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const from = await makeUnit(h, MISPLACED, 'session-move', REAL_CWD);
    const bytes = await fs.readFile(path.join(from, LOG_NAME));
    const before = await treeOf(h.homeDir);
    h.reindexOk.value = false;
    const res = await call(h, { apply: true });
    assert.equal(res.status, 200);
    assert.equal(res.json['ok'], false);
    assert.equal(res.json['applied'], 0);
    const item = (res.json['results'] as Record<string, unknown>[])[0];
    assert.equal(item?.['reason'], 'reindex-failed');
    assert.equal(item?.['rolledBack'], true, '刷新失败必须回滚该条');
    assert.deepEqual(await treeOf(h.homeDir), before);
    assert.equal((await fs.readFile(path.join(from, LOG_NAME))).equals(bytes), true);
    assert.deepEqual(h.reindexCalls, ['session-move']);
  } finally {
    await h.cleanup();
  }
});

test('E1 ⑥ 门前置：session.lock → locked；30s 内有写入 → busy；两条都零写入', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    await makeUnit(h, MISPLACED, 'session-locked', REAL_CWD, { lock: true });
    await makeUnit(h, MISPLACED, 'session-busy', REAL_CWD, { fresh: true });
    const before = await treeOf(h.homeDir);
    const res = await call(h, { apply: true });
    assert.equal(res.status, 200);
    const reasons = (res.json['results'] as Record<string, unknown>[]).map((r) => r['reason']);
    assert.equal(reasons.includes('locked'), true, JSON.stringify(reasons));
    assert.equal(reasons.includes('busy'), true, JSON.stringify(reasons));
    assert.equal(res.json['applied'], 0);
    assert.deepEqual(h.reindexCalls, []);
    assert.deepEqual(await treeOf(h.homeDir), before);
  } finally {
    await h.cleanup();
  }
});

test('E1 ⑦ 宿主没给索引刷新端口 → 一条也不执行（reindex-unavailable，零写入）', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    await makeUnit(h, MISPLACED, 'session-move', REAL_CWD);
    const before = await treeOf(h.homeDir);
    const routes = recoveryRoutes({
      ...(envFor(h) as unknown as Record<string, unknown>),
      host: { mutationLock: h.lock.port, safeModeIsBlocked: () => false, log: { warn: () => {} } },
    } as never);
    const route = routes.find((r) => routeSpecOf(r)?.path === BASE);
    assert.ok(route !== undefined);
    const res = fakeResponse();
    await route.handler(fakeRequest({ body: JSON.stringify({ apply: true }) }), res.res);
    assert.equal(res.status(), 200);
    assert.equal(res.json()['reason'], 'reindex-unavailable');
    assert.equal(res.json()['applied'], 0);
    assert.deepEqual(await treeOf(h.homeDir), before);
  } finally {
    await h.cleanup();
  }
});

test('E1 ⑧ 既有字节级路由未被牵连：/sessions 仍是 GET 只读，/sessions/repair 仍要求 unitId', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const route = routeFor(h);
    const listRes = fakeResponse();
    await route.handler(fakeRequest({ method: 'GET', url: BASE + '/sessions' }), listRes.res);
    assert.equal(listRes.status(), 200);
    assert.equal(listRes.json()['ok'], true);

    const repairRes = fakeResponse();
    await route.handler(
      fakeRequest({ method: 'POST', url: BASE + '/sessions/repair', body: JSON.stringify({}) }),
      repairRes.res,
    );
    assert.equal(repairRes.status(), 400);
    assert.equal(repairRes.json()['error'], 'unitId required');

    const wrongMethod = fakeResponse();
    await route.handler(fakeRequest({ method: 'GET', url: BASE + '/sessions/layout' }), wrongMethod.res);
    assert.equal(wrongMethod.status(), 405);
  } finally {
    await h.cleanup();
  }
});
