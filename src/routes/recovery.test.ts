/**
 * t54 回归（路由层）：GET /recovery/status 必须带上「中断的档案复制残留」。
 *
 * 三条硬要求：
 *  ① 字段**只**来自 t39 的 `profiles.listIncompleteCopies()`（这里用替身注入，证明数据来源单一）；
 *  ② 只回传界面需要的四个字段（内部字段 markerReadable 这类不得外泄）；
 *  ③ 枚举失败时 `/recovery/status` 仍 200 且 `incompleteCopies=[]` —— 恢复面板的首要职责是把
 *     incident 说清楚，绝不因为残留枚举失败整页 500。
 *
 * 同目录约定：本用例与被测文件 src/routes/recovery.ts 同目录（仓库既有先例：kit/foreign/session-format）。
 * base sha 3f42a8b 上无此字段 ⇒ 本文件在 base 上是红的（见 t54 修前红证据）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

import { recoveryRoutes } from './recovery.ts';
import { routeSpecOf, type WebRoute } from './kit.ts';
import { DshProfileManager } from '../profiles/dsh-profile-manager.ts';

const BASE = '/api/dsh-config-manager/recovery';

/** 只挂 recovery 组、只经 kit 的 endpoint 包装（与生产同一份产物）。 */
function routeOf(env: unknown): WebRoute {
  const routes = recoveryRoutes(env as never);
  assert.equal(routes.length, 1, 'recovery 组仍是**一条** prefix 路由（本任务不新增注册条目）');
  const found = routes.find((r) => routeSpecOf(r)?.path === BASE);
  assert.ok(found !== undefined, '必须能找到 recovery prefix 路由');
  return found;
}

function envWith(copies: () => unknown[]): unknown {
  return {
    dataDir: '/tmp/dcm-t54-data',
    host: { homeDir: '/tmp/dcm-t54-home', profile: 'web', log: { warn: () => {} } },
    profiles: { listIncompleteCopies: copies },
    recoveryOrchestrator: { status: async () => ({ status: 200, body: { incidents: [], running: [] } }) },
    sessionHealth: {},
    makeRecoveryExecutors: () => ({}),
    tryAppendHistory: async () => undefined,
  };
}

async function withServer(route: WebRoute, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = http.createServer((req, res) => { void route.handler(req, res) });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn('http://127.0.0.1:' + String(port) + BASE);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()) });
  }
}

test('t54：/recovery/status 回传 incompleteCopies（只 4 个字段，内部字段不外泄）', async () => {
  const route = routeOf(envWith(() => [
    { name: 'work-copy', dir: '/home/bob/profiles/work-copy', sourceName: 'work', startedAt: '2026-10-05T10:00:00.000Z', markerReadable: true },
  ]));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200);
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, [
      { name: 'work-copy', dir: '/home/bob/profiles/work-copy', sourceName: 'work', startedAt: '2026-10-05T10:00:00.000Z' },
    ], '只回传界面需要的四个字段（markerReadable 这类内部字段不得外泄）');
  });
});

test('t54：残留枚举抛错 → /recovery/status 仍 200 且 incompleteCopies=[]（绝不整页 500）', async () => {
  const route = routeOf(envWith(() => { throw new Error('EACCES: profiles 目录读不动'); }));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200, '枚举失败不得让恢复面板整页失败');
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
  });
});

test('t54：没有残留时字段恒在（空数组），客户端无需判 undefined 分支', async () => {
  const route = routeOf(envWith(() => []));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200);
    const body = await res.json() as { incompleteCopies?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
  });
});

/* ------------------------------------------------------------------ t89（S2-3）：枚举失败 ≠ 没有残留 */

/** 用**真实** DshProfileManager 构造 env（不是替身）：证明失败事实来自引擎而非路由层猜测。 */
function envWithProfiles(profiles: unknown): unknown {
  return {
    dataDir: '/tmp/dcm-t89-data',
    host: { homeDir: '/tmp/dcm-t89-home', profile: 'web', log: { warn: () => {} } },
    profiles,
    recoveryOrchestrator: { status: async () => ({ status: 200, body: { incidents: [], running: [] } }) },
    sessionHealth: {},
    makeRecoveryExecutors: () => ({}),
    tryAppendHistory: async () => undefined,
  };
}

/** 临时 DSH home；返回 home 与清理函数。 */
function tmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dcm-t89-'));
  return { home, cleanup: () => { rmSync(home, { recursive: true, force: true }) } };
}

test('t89：残留枚举失败（profiles 根不是目录）→ 仍 200 且 incompleteCopiesUnreadable=true', async () => {
  const { home, cleanup } = tmpHome();
  try {
    // 让 profilesRoot() 指向一个**文件**：existsSync 为真、readdirSync 抛 ENOTDIR —— 与「读不动的目录」同类
    writeFileSync(join(home, 'profiles'), 'not-a-directory');
    const profiles = new DshProfileManager({ homeDir: home });
    const route = routeOf(envWithProfiles(profiles));
    await withServer(route, async (base) => {
      const res = await fetch(base + '/status');
      assert.equal(res.status, 200, 't54 口径不变：枚举失败绝不整页 500');
      const body = await res.json() as { incompleteCopies?: unknown; incompleteCopiesUnreadable?: unknown };
      assert.deepEqual(body.incompleteCopies, []);
      assert.equal(body.incompleteCopiesUnreadable, true, '失败必须与「没有残留」可区分');
    });
  } finally { cleanup() }
});

test('t89：确实没有残留（空 profiles 目录）→ 200 且不含 incompleteCopiesUnreadable 键', async () => {
  const { home, cleanup } = tmpHome();
  try {
    mkdirSync(join(home, 'profiles'));
    const profiles = new DshProfileManager({ homeDir: home });
    const route = routeOf(envWithProfiles(profiles));
    await withServer(route, async (base) => {
      const res = await fetch(base + '/status');
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual(body.incompleteCopies, []);
      assert.equal('incompleteCopiesUnreadable' in body, false, '读到了就是读到了：不得新增键（响应与 t54 逐字相同）');
    });
  } finally { cleanup() }
});

test('t89：旧宿主/替身（只有 listIncompleteCopies 且抛错）→ 仍 200、空数组、且置 unreadable=true', async () => {
  const route = routeOf(envWith(() => { throw new Error('EACCES: profiles 目录读不动'); }));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    assert.equal(res.status, 200, '抛错路径仍是 200（不得变成 500）');
    const body = await res.json() as { incompleteCopies?: unknown; incompleteCopiesUnreadable?: unknown };
    assert.deepEqual(body.incompleteCopies, []);
    assert.equal(body.incompleteCopiesUnreadable, true, '拿不到 scan 时的抛错同样必须可见');
  });
});

test('t89：旧宿主不抛错 → 不得凭空声称失败（unreadable 键缺省）', async () => {
  const route = routeOf(envWith(() => []));
  await withServer(route, async (base) => {
    const res = await fetch(base + '/status');
    const body = await res.json() as Record<string, unknown>;
    assert.equal('incompleteCopiesUnreadable' in body, false);
    assert.deepEqual(body.incompleteCopies, []);
  });
});

/* ============================================ t17 历史 fork 归位（显式触发） */

/**
 * 影子工作区注册表：成员集合 + **写计数** + cwd 解析（真实判定语义，不是固定桩）——
 * 「已归位 ⇒ 幂等不重复写」「解析不到 ⇒ refused」才是被真的判据证明的。
 */
function shadowRegistry(input: { id: string; path: string; members?: string[] }) {
  return {
    id: input.id,
    path: input.path,
    members: new Set<string>(input.members ?? []),
    writes: 0,
    attach(childId: string): void {
      this.writes += 1;
      this.members.add(childId);
    },
  };
}

/** 宿主会话端口替身：父子关系（只读）+ t10 那一份归位动作（成员 / cwd 同目录 / 写后复核）。 */
function t17Sessions(ws: ReturnType<typeof shadowRegistry>, cwdOf: Record<string, string>, parents?: Record<string, string>, subagents?: string[]) {
  return {
    parentRelations: async () => new Map(Object.keys(cwdOf).map((id) => [id, { parent: parents?.[id] ?? 'parent-1', subagent: subagents?.includes(id) === true }])),
    attachChildToParentWorkspace: async (_parentId: string, childId: string) => {
      if (ws.members.has(childId)) return { ok: true, reason: 'already-attached', workspaceId: ws.id };
      const cwd = cwdOf[childId];
      if (cwd === undefined) return { ok: false, reason: 'cwd-unavailable' };
      if (cwd !== ws.path) return { ok: false, reason: 'no-workspace-for-cwd', detail: cwd };
      ws.attach(childId);
      return ws.members.has(childId)
        ? { ok: true, reason: 'attached', workspaceId: ws.id }
        : { ok: false, reason: 'verify-failed', detail: 'child-not-in-any-workspace-sessionIds' };
    },
  };
}

/** 在 rollbackEnv 的 host 上换掉 sessions 端口。 */
function envWithSessions(h: RollbackHarness, sessions: Record<string, unknown>): unknown {
  const env = rollbackEnv(h) as { host: Record<string, unknown> };
  env.host['sessions'] = sessions;
  return env;
}

async function callForkReconcile(base: string, method = 'POST'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + '/fork-reconcile', { method });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('t17 路由：只读盘点 + 逐条归位 + 逐条复核 —— attached/already/refused 计数与理由分布', async () => {
  const h = makeRollbackHarness();
  try {
    const ws = shadowRegistry({ id: 'ws-1', path: 'D:/proj/a', members: ['child-already'] });
    const logBefore = readFileSync(h.logFile, 'utf8');
    const route = routeOf(envWithSessions(h, t17Sessions(ws, {
      'child-attached': 'D:/proj/a',
      'child-already': 'D:/proj/a',
      'child-elsewhere': 'D:/other/place',
    })));
    await withServer(route, async (base) => {
      const r = await callForkReconcile(base);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
      assert.equal(r.body.ok, true);
      assert.equal(r.body.candidates, 3);
      assert.equal(r.body.attached, 1);
      assert.equal(r.body.already, 1);
      assert.equal(r.body.refused, 1);
      assert.deepEqual(r.body.reasonCounts, { 'no-workspace-for-cwd': 1 });
      const receipts = r.body.receipts as { sessionId: string; status: string; reason: string }[];
      assert.deepEqual(receipts.map((x) => [x.sessionId, x.status, x.reason]), [
        ['child-attached', 'attached', 'attached'],
        ['child-already', 'already', 'already-attached'],
        ['child-elsewhere', 'refused', 'no-workspace-for-cwd'],
      ]);
      assert.equal(r.body.receiptsTruncated, false);
      assert.deepEqual(r.body.skipped, { subagent: 0 });
      // GET 不被允许（这是一次**写**动作，必须显式 POST）
      const wrongMethod = await callForkReconcile(base, 'GET');
      assert.equal(wrongMethod.status, 405);
      // 子路径不得被当成 operationId（'fork-reconcile' 不是 UUID）
      const extra = await fetch(base + '/fork-reconcile/extra', { method: 'POST' });
      assert.equal(extra.status, 404);
    });
    assert.equal(ws.writes, 1, 'already 那条绝不重复写；refused 那条一次都没写');
    assert.deepEqual([...ws.members].sort(), ['child-already', 'child-attached']);
    assert.equal(readFileSync(h.logFile, 'utf8'), logBefore, '会话日志字节一个都没动');
  } finally {
    h.cleanup();
  }
});

test('t17 路由：subagent 标记照做（真机 50/58 条回退 fork 自己就带这个标记 ⇒ 不得据此窄化）', async () => {
  const h = makeRollbackHarness();
  try {
    const ws = shadowRegistry({ id: 'ws-1', path: 'D:/proj/a' });
    const route = routeOf(envWithSessions(h, t17Sessions(
      ws,
      { 'fork-1': 'D:/proj/a', 'fork-2': 'D:/proj/a' },
      undefined,
      ['fork-2'],
    )));
    await withServer(route, async (base) => {
      const r = await callForkReconcile(base);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(r.body.candidates, 2, '带 subagent 标记的回退 fork 也是候选');
      assert.deepEqual(r.body.skipped, { subagent: 0 }, '默认口径不窄化（窄化开关默认关）');
      assert.equal(r.body.attached, 2);
      assert.deepEqual((r.body.receipts as { sessionId: string }[]).map((x) => x.sessionId), ['fork-1', 'fork-2']);
    });
    assert.equal(ws.writes, 2);
  } finally {
    h.cleanup();
  }
});

test('t17 路由：读不到父子关系 ⇒ 503 + error（**不是**「本机没有子会话」），零写入', async () => {
  const h = makeRollbackHarness();
  try {
    const route = routeOf(envWithSessions(h, {
      parentRelations: async () => { throw new Error('session store not ready') },
      attachChildToParentWorkspace: async () => ({ ok: true, reason: 'attached' }),
    }));
    await withServer(route, async (base) => {
      const r = await callForkReconcile(base);
      assert.equal(r.status, 503);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.candidates, 0);
      assert.match(String(r.body.error), /child-sessions-unavailable/);
    });
  } finally {
    h.cleanup();
  }
});

test('t17 路由：宿主没有归位实现（老外壳）⇒ 逐条 refused/reconcile-seam-missing，绝不假装已归位', async () => {
  const h = makeRollbackHarness();
  try {
    const route = routeOf(envWithSessions(h, {
      parentRelations: async () => new Map([['child-1', { parent: 'parent-1' }]]),
    }));
    await withServer(route, async (base) => {
      const r = await callForkReconcile(base);
      assert.equal(r.status, 200);
      assert.equal(r.body.attached, 0, '没有实现就不许报成功');
      assert.equal(r.body.refused, 1);
      assert.deepEqual(r.body.reasonCounts, { 'reconcile-seam-missing': 1 });
    });
  } finally {
    h.cleanup();
  }
});

/* ============================================ t8 运行中的对话：带文件段的回退被硬拒 */

const RB_PROJECT_KEY = '--p--';
const RB_SESSION_ID = 'session-abc';
const RB_UNIT_ID = RB_PROJECT_KEY + '/' + RB_SESSION_ID;

interface RollbackHarness {
  root: string;
  homeDir: string;
  dataDir: string;
  workspaceDir: string;
  logFile: string;
  ledgerPath: string;
  history: { kind?: string; result?: string; error?: string }[];
  forkCalls: { sessionId: string; boundarySeq: number }[];
  cleanup: () => void;
}

/** 真临时 home/dataDir/工作区/会话日志（与 tests/route/recovery-rollback.test.ts 同一套夹具口径）。 */
function makeRollbackHarness(): RollbackHarness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cm-t8-route-'));
  const homeDir = join(root, 'home');
  const dataDir = join(homeDir, 'dsh-config-manager');
  const workspaceDir = join(root, 'proj');
  const logDir = join(homeDir, 'sessions', RB_PROJECT_KEY, RB_SESSION_ID);
  const logFile = join(logDir, 'session.v4.jsonl.zstd');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'x.txt'), 'X1');
  writeFileSync(logFile, 'LOGBYTES');
  return {
    root, homeDir, dataDir, workspaceDir, logFile,
    ledgerPath: join(dataDir, 'rollback-points', 'index.json'),
    history: [], forkCalls: [],
    cleanup: () => { rmSync(root, { recursive: true, force: true }) },
  };
}

/** 留一个回滚点（与路由侧共用同一份台账；引擎实例按生产同款构造）。 */
async function captureRollbackPoint(h: RollbackHarness, extra: Record<string, unknown> = {}): Promise<string> {
  const { RollbackPointEngine } = await import('../core/rollback-point.ts');
  const engine = new RollbackPointEngine({ dataDir: h.dataDir, homeDir: h.homeDir, sessionQuiescentMs: 0 });
  const result = await engine.capturePoint({
    chunks: [h.workspaceDir],
    sessionId: RB_SESSION_ID,
    unitId: RB_UNIT_ID,
    sessionLogPath: h.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
    ...extra,
  });
  assert.equal(result.ok, true, result.detail ?? result.code);
  return result.point?.id ?? '';
}

/** 会话日志 mtime = 现在 - ageMs（ageMs=0 ⇒ 刚被写过 = 引擎判「正在运行」）。 */
function ageSessionLog(h: RollbackHarness, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  utimesSync(h.logFile, when, when);
}

function ledgerRecords(h: RollbackHarness): number {
  try {
    const parsed = JSON.parse(readFileSync(h.ledgerPath, 'utf8')) as { records?: unknown[] };
    return Array.isArray(parsed.records) ? parsed.records.length : 0;
  } catch {
    return 0;
  }
}

/** 锁端口替身：恒 ACQUIRED（锁机制本身由 env-lock 自测覆盖）。 */
function rollbackLockPort(): unknown {
  return {
    acquire: async () => ({ state: 'ACQUIRED' as const, token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() } }),
    validate: () => true,
    release: async () => {},
  };
}

function rollbackEnv(h: RollbackHarness): unknown {
  return {
    dataDir: h.dataDir,
    host: {
      homeDir: h.homeDir,
      profile: 'web',
      mutationLock: rollbackLockPort(),
      safeModeIsBlocked: () => false,
      log: { warn: () => {} },
      sessions: {
        forkSession: async (sessionId: string, boundarySeq: number) => {
          h.forkCalls.push({ sessionId, boundarySeq });
          return { childSessionId: 'child-' + sessionId };
        },
      },
    },
    sessionHealth: {
      homeDir: h.homeDir,
      targetFormatVersion: () => 4,
      workspaceKeys: async () => new Set<string>(),
      knownSessionIds: async () => new Set<string>(),
      sessionMeta: async () => ({ bySessionId: new Map(), byProjectKey: new Map(), workspaceTitleByProjectKey: new Map() }),
    },
    tryAppendHistory: async (raw: unknown) => { h.history.push(raw as { kind?: string }); return undefined },
    recoveryOrchestrator: {},
    makeRecoveryExecutors: () => ({}),
  };
}

async function postRewind(base: string, id: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(base + '/rollback-points/' + id + '/rewind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userConfirmed: true, ...body }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('t8 R1：对话正在运行 + mode=files+session ⇒ 409 session-active、零写入（不 fork、不留点、文件原样）', async () => {
  const h = makeRollbackHarness();
  try {
    const id = await captureRollbackPoint(h);
    ageSessionLog(h, 0); // 刚被写过 ⇒ preview.session.active === true（静默窗缺省 30 s）
    const before = readFileSync(join(h.workspaceDir, 'x.txt'), 'utf8');
    const ledgerBefore = ledgerRecords(h);
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const r = await postRewind(base, id, { mode: 'files+session' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'session-active');
      assert.equal(r.body.outcome, 'denied');
      assert.deepEqual(r.body.segments, [], '一段都没动');
      assert.match(String(r.body.detail), /conversation is running/, 'detail 必须说清「等本轮结束或只回退对话」');
    });
    assert.equal(readFileSync(join(h.workspaceDir, 'x.txt'), 'utf8'), before, '工作区文件必须逐字节未变');
    assert.equal(h.forkCalls.length, 0, '会话也没 fork（整次请求零写入）');
    assert.equal(ledgerRecords(h), ledgerBefore, '台账不变（连救援点都没留）');
  } finally {
    h.cleanup();
  }
});

test('t8 R1：UI 默认档（不带 mode）与 mode=files 同样被挡 —— 缺省就是 files+session', async () => {
  const h = makeRollbackHarness();
  try {
    const id = await captureRollbackPoint(h);
    ageSessionLog(h, 0);
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const byDefault = await postRewind(base, id, {});
      assert.equal(byDefault.status, 409, 'UI 默认档（不带 mode）必须被挡');
      assert.equal(byDefault.body.code, 'session-active');
      const filesOnly = await postRewind(base, id, { mode: 'files' });
      assert.equal(filesOnly.status, 409, 'mode=files 同样带工作区段');
      const explicit = await postRewind(base, id, { segments: ['workspace'] });
      assert.equal(explicit.status, 409, '显式 segments 也挡（含直接打 HTTP API 的调用）');
    });
    assert.equal(h.forkCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('t8 R1：对话正在运行 + mode=session ⇒ 200 正常 fork（只回溯消息不受影响）', async () => {
  const h = makeRollbackHarness();
  try {
    const id = await captureRollbackPoint(h);
    ageSessionLog(h, 0);
    const before = readFileSync(join(h.workspaceDir, 'x.txt'), 'utf8');
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const r = await postRewind(base, id, { mode: 'session' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.outcome, 'restored');
      assert.equal(r.body.childSessionId, 'child-' + RB_SESSION_ID);
    });
    assert.deepEqual(h.forkCalls, [{ sessionId: RB_SESSION_ID, boundarySeq: 1 }], '会话段照常 fork');
    assert.equal(readFileSync(join(h.workspaceDir, 'x.txt'), 'utf8'), before, '只回溯消息不动工作区');
  } finally {
    h.cleanup();
  }
});

test('t8 非运行态回归：日志早已静默 + mode=files+session ⇒ 照常回退文件（既有口径一字未改）', async () => {
  const h = makeRollbackHarness();
  try {
    const id = await captureRollbackPoint(h);
    ageSessionLog(h, 120_000); // 远超 30 s 静默窗 ⇒ active=false
    writeFileSync(join(h.workspaceDir, 'x.txt'), 'CHANGED');
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const r = await postRewind(base, id, { mode: 'files+session' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.outcome, 'restored');
    });
    assert.equal(readFileSync(join(h.workspaceDir, 'x.txt'), 'utf8'), 'X1', '文件被真的退回留点时的内容');
    assert.equal(h.forkCalls.length, 1, '会话段照常 fork');
  } finally {
    h.cleanup();
  }
});

test('t8 判定链位置（选项 ②）：既有护栏优先 —— 确认门没开 / 点本来不可回退时，让引擎给它的结构化码', async () => {
  const h = makeRollbackHarness();
  try {
    // ① 未确认 + 运行中 + 可回退 ⇒ 必须是 confirmation-required（不是 session-active）
    const normal = await captureRollbackPoint(h);
    ageSessionLog(h, 0);
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const res = await fetch(base + '/rollback-points/' + normal + '/rewind', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userConfirmed: false, mode: 'files+session' }),
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as Record<string, unknown>).code, 'confirmation-required', '确认门语义不变、且优先');
    });
    assert.equal(h.forkCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('t8 判定链位置（选项 ②）：protected 点即使在运行中也如实回 protected-point（不是 session-active）', async () => {
  const h = makeRollbackHarness();
  try {
    const protectedId = await captureRollbackPoint(h, { protect: true });
    ageSessionLog(h, 0);
    const route = routeOf(rollbackEnv(h));
    await withServer(route, async (base) => {
      const r = await postRewind(base, protectedId, { mode: 'files+session' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'protected-point', '受保护点的语义不变：等多久都退不了，说「正在运行」是误导');
    });
    assert.equal(h.forkCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('t8 源码级：判据取自 preview 的 session.active，路由**不自己 stat 会话日志**；R1/R2 两道门都在', () => {
  const source = readFileSync(new URL('./recovery.ts', import.meta.url), 'utf8');
  assert.match(source, /preview\.session\.active === true/, '必须读 preview 已算好的 session.active');
  assert.ok(!source.includes('logPath'), '路由不得碰会话日志路径（那会变成第二份判据）');
  assert.ok(!/\bfs\.stat\b/.test(source), '路由不得自己 stat 会话日志');
  assert.equal((source.match(/sessionActiveDenied\(/g) ?? []).length, 3, 'R1 预检 + R2 锁内二道保险 + 定义处');
  assert.match(source, /rewindTouchesWorkspace\(rewindInput\)/, '是否要动工作区必须有唯一判据');
  assert.equal((source.match(/sessionActiveGateApplies\(/g) ?? []).length, 3, '判定链位置只有一份判据（定义 + R1 + R2）');
});
