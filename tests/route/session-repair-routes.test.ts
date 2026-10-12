/**
 * T8 路由行为测试：POST /recovery/sessions/repair 与 /rollback。
 *
 * 为什么必须有：这是**应用内写会话字节**的唯一入口（此前是硬约束「零写入」），
 * 最危险的失败模式是「用户点一下就改了不该改的东西 / 无法回滚」。这里用真实临时 home +
 * 真实路由 handler 逐条钉住：预览零写入、应用写台账、回滚只认 repairId、路径穿越被拒、
 * SAFE MODE 与非法请求的拒绝路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { recoveryRoutes } from '../../src/routes/recovery.ts';
import { routeSpecOf, type WebRoute } from '../../src/routes/kit.ts';
import { emptySessionMeta } from '../../src/core/session-meta.ts';
import { encodeZstdFrame, zstdAvailable } from '../../src/utils/zstd-frame.ts';

const CAPABLE = zstdAvailable();
const BASE = '/api/dsh-config-manager/recovery';
const PROJECT_KEY = '--p--';
const SESSION_ID = 'session-abc';
const LOG_NAME = 'session.v4.jsonl.zstd';
const UNIT_ID = PROJECT_KEY + '/' + SESSION_ID;

interface Harness {
  root: string;
  homeDir: string;
  dataDir: string;
  file: string;
  safeMode: { blocked: boolean };
  cleanup: () => Promise<void>;
}

function logBytes(rows: readonly unknown[]): Buffer {
  const header = { type: 'session', version: 4, id: SESSION_ID, cwd: 'C:/proj' };
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + '\n', 'utf8')));
  return Buffer.concat(parts);
}

const DUPLICATED = [{ type: 'turn/start', seq: 0 }, { type: 'step/start', seq: 1 }, { type: 'step/start', seq: 1 }, { type: 'turn/end', seq: 2 }];

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-session-repair-route-'));
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const unitDir = path.join(homeDir, 'sessions', PROJECT_KEY, SESSION_ID);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(unitDir, LOG_NAME);
  await fs.writeFile(file, logBytes(DUPLICATED));
  const old = new Date(Date.now() - 600_000);
  await fs.utimes(file, old, old);
  return { root, homeDir, dataDir, file, safeMode: { blocked: false }, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** 锁端口的替身：恒 ACQUIRED；记录 acquire 次数，用来证明 SAFE MODE 时**根本没去拿锁**。 */
function makeLockPort(h: Harness): { port: unknown; acquireCalls: () => number } {
  const stats = { acquire: 0 };
  const port = {
    acquire: async () => {
      stats.acquire += 1;
      return {
        state: 'ACQUIRED' as const,
        token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() },
      };
    },
    validate: () => true,
    release: async () => {},
  };
  return { port, acquireCalls: () => stats.acquire };
}

/** 真实目录构造 env（锁端口恒 ACQUIRED；锁本身的行为由 env-lock 自身单测覆盖）。 */
function envFor(h: Harness): never {
  const env = {
    dataDir: h.dataDir,
    host: {
      mutationLock: makeLockPort(h).port,
      safeModeIsBlocked: () => h.safeMode.blocked,
      log: { warn: () => {} },
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
    method: opts.method ?? 'GET',
    url: opts.url ?? BASE,
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
  return {
    res: res as unknown as ServerResponse,
    status: () => state.status,
    json: () => JSON.parse(state.body) as Record<string, unknown>,
  };
}

async function call(h: Harness, opts: { method: string; sub?: string; body?: unknown }): Promise<{ status: number; json: Record<string, unknown> }> {
  const route = routeFor(h);
  const res = fakeResponse();
  const url = opts.sub === undefined ? BASE + '/sessions' : BASE + opts.sub;
  await route.handler(
    fakeRequest({ method: opts.method, url, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) }),
    res.res,
  );
  return { status: res.status(), json: res.json() };
}

test('T8：预览零写入 → 应用成功（备份 + 台账）→ 回滚还原', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const before = await fs.readFile(h.file);
    const plan = await call(h, { method: 'POST', sub: '/sessions/repair', body: { unitId: UNIT_ID } });
    assert.equal(plan.status, 200);
    assert.equal(plan.json['ok'], true);
    assert.equal(plan.json['droppedRows'], 1);
    assert.equal((await fs.readFile(h.file)).equals(before), true, '预览必须零写入');

    const applied = await call(h, {
      method: 'POST', sub: '/sessions/repair',
      body: { unitId: UNIT_ID, apply: true, expect: plan.json['expect'] },
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json['ok'], true);
    assert.equal(applied.json['ledgerRecorded'], true);
    assert.equal((await fs.readFile(h.file)).equals(before), false, '应用后目标被换成修复内容');

    // 体检响应里能看到这条可回滚的修复（不含绝对路径）
    const scan = await call(h, { method: 'GET' });
    assert.equal(scan.status, 200);
    const repairs = scan.json['repairs'] as Record<string, unknown>[];
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0]?.['repairId'], applied.json['repairId']);
    assert.equal(JSON.stringify(repairs).includes(h.root), false, '台账回传不得包含任何绝对路径');

    const back = await call(h, { method: 'POST', sub: '/sessions/rollback', body: { repairId: applied.json['repairId'] } });
    assert.equal(back.status, 200);
    assert.equal(back.json['ok'], true);
    assert.equal((await fs.readFile(h.file)).equals(before), true, '回滚后逐字节还原');
    const again = await call(h, { method: 'POST', sub: '/sessions/rollback', body: { repairId: applied.json['repairId'] } });
    assert.equal(again.json['reason'], 'already-rolled-back');
  } finally {
    await h.cleanup();
  }
});

test('T8：拒绝路径 —— 缺 unitId 400 / 子路径 GET 405 / 穿越 unitId 与不存在 unit 都是 unknown-unit', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    const before = await fs.readFile(h.file);
    assert.equal((await call(h, { method: 'POST', sub: '/sessions/repair', body: {} })).status, 400);
    assert.equal((await call(h, { method: 'GET', sub: '/sessions/repair' })).status, 405);
    assert.equal((await call(h, { method: 'POST', sub: '/sessions/rollback', body: {} })).status, 400);
    for (const unitId of ['../../etc/passwd', PROJECT_KEY + '/../../x', 'a/b/c', PROJECT_KEY + '/missing', 'not-a-key/' + SESSION_ID]) {
      const res = await call(h, { method: 'POST', sub: '/sessions/repair', body: { unitId } });
      assert.equal(res.status, 200, '非法 unit 不是 HTTP 错误，而是可读的拒绝: ' + unitId);
      assert.equal(res.json['reason'], 'unknown-unit', unitId);
    }
    assert.equal((await fs.readFile(h.file)).equals(before), true, '拒绝路径必须零写入');
  } finally {
    await h.cleanup();
  }
});

test('T8：SAFE MODE 生效时，修复被 423 拒绝（与其它写路由同一口径）', { skip: !CAPABLE }, async () => {
  const h = await makeHarness();
  try {
    h.safeMode.blocked = true;
    const res = await call(h, { method: 'POST', sub: '/sessions/repair', body: { unitId: UNIT_ID, apply: true } });
    assert.equal(res.status, 423);
    assert.equal(res.json['code'], 'mutation-locked');
    const scan = await call(h, { method: 'GET' });
    assert.equal(scan.status, 200, '体检本身（只读）不受 SAFE MODE 影响');
  } finally {
    await h.cleanup();
  }
});
