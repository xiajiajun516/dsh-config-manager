/**
 * Phase 3 JournalStore 与状态机单测（node:test，零依赖）。
 * 覆盖：状态迁移合法/非法/terminal、create/load/update 原子持久、active 扫描（忽略 tmp）、
 * isTerminal、moveToCompleted、quarantine、retention、safe-mode、environmentFingerprint、
 * 故障注入（write 失败 / symlink）。只测 journal 层，不测 outcome 决策。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JournalStore, createJournalEntry, transitionJournalState, isTerminalState,
  isValidTransition, generateOperationId,
  environmentFingerprint, isValidOperationId, isJournalBasename,
  VALID_OPERATION_ID_RE,
} from './journal.ts';
import { sha256Hex } from '../utils/hashing.ts';

const LOCK_CTX = {
  operationId: '00000000-0000-4000-8000-000000000000',
  ownerInstanceId: 'owner-a',
  lockId: 'lock-1',
  packageVersion: '0.1.54',
  environmentFingerprint: 'fp-1',
};

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkStore(dir: string) {
  return new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
}

/** 读文件原始字节（测 ownership/immutability） */
async function readBytes(p: string): Promise<Buffer> { return fs.readFile(p); }
async function exists(p: string): Promise<boolean> { try { await fs.access(p); return true; } catch { return false; } }

// ---------- 状态机 ----------

test('状态机：合法/非法 transition 与 terminal 判定', () => {
  assert.equal(isValidTransition('CREATED', 'SNAPSHOT_CREATED'), true);
  assert.equal(isValidTransition('CREATED', 'APPLYING'), true);
  assert.equal(isValidTransition('CREATED', 'COMMITTED'), false);
  assert.equal(isValidTransition('APPLYING', 'VALIDATING'), true);
  assert.equal(isValidTransition('APPLYING', 'ROLLING_BACK'), true);
  assert.equal(isValidTransition('VALIDATING', 'COMMITTED'), true);
  assert.equal(isValidTransition('VALIDATING', 'NEEDS_ATTENTION'), true);
  assert.equal(isValidTransition('ROLLING_BACK', 'ROLLED_BACK'), true);
  assert.equal(isValidTransition('ROLLED_BACK', 'RECOVERED'), true);
  assert.equal(isValidTransition('NEEDS_ATTENTION', 'RECOVERING'), true);
  assert.equal(isValidTransition('COMMITTED', 'APPLYING'), false); // terminal 不可回退
  assert.equal(isValidTransition('RECOVERED', 'COMMITTED'), false);

  for (const s of ['COMMITTED', 'ROLLED_BACK', 'RECOVERED', 'NEEDS_ATTENTION']) {
    assert.equal(isTerminalState(s as never), true, s);
  }
  for (const s of ['CREATED', 'SNAPSHOT_CREATED', 'APPLYING', 'VALIDATING', 'ROLLING_BACK', 'RECOVERING']) {
    assert.equal(isTerminalState(s as never), false, s);
  }
});

test('状态机：transitionJournalState 非法迁移抛错', () => {
  const j = createJournalEntry('import-apply', LOCK_CTX, '2026-01-01T00:00:00.000Z');
  const c = transitionJournalState(j, 'SNAPSHOT_CREATED');
  assert.equal(c.state, 'SNAPSHOT_CREATED');
  assert.throws(() => transitionJournalState(j, 'COMMITTED'), /非法 journal state transition/);
  // SNAPSHOT_CREATED → VALIDATING 非法（须先 APPLYING）
  assert.throws(() => transitionJournalState(c, 'VALIDATING'), /非法 journal state transition/);
  // CREATED 允许恢复为 RECOVERED；terminal 不可再变向
  const recovered = transitionJournalState(j, 'RECOVERED');
  assert.equal(recovered.state, 'RECOVERED');
  assert.throws(() => transitionJournalState(recovered, 'APPLYING'), /非法 journal state transition/);
});

// ---------- create / load / update / 原子 ----------

test('create→load→transition→persist 往返', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const entry = createJournalEntry('import-apply', LOCK_CTX, '2026-01-01T00:00:00.000Z');
  await store.create(entry);
  const loaded = await store.loadActive(LOCK_CTX.operationId);
  assert.ok(loaded);
  assert.equal(loaded!.state, 'CREATED');
  assert.equal(loaded!.ownerInstanceId, 'owner-a');
  assert.equal(loaded!.lockId, 'lock-1');
  await store.transition(LOCK_CTX.operationId, 'SNAPSHOT_CREATED');
  const after = await store.loadActive(LOCK_CTX.operationId);
  assert.equal(after!.state, 'SNAPSHOT_CREATED');
  assert.equal(after!.operationType, 'import-apply');
});

test('journal 文件为 0600 且无 symlink（sensitive；POSIX）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const entry = createJournalEntry('restore', LOCK_CTX, '2026-01-01T00:00:00.000Z');
  await store.create(entry);
  const p = path.join(dir, 'transactions', 'active', `${LOCK_CTX.operationId}.json`);
  const ls = await fs.lstat(p);
  assert.equal(ls.isSymbolicLink(), false);
  // Windows 不强制执行 POSIX 权限位（ACL 体系）→ 模式断言仅 POSIX
  if (process.platform !== 'win32') {
    const st = await fs.stat(p);
    assert.equal(st.mode & 0o777, 0o600);
  }
});

// ---------- active 扫描 ----------

test('active 扫描只认 uuid.json，忽略 .dshcm.*.tmp 及其它', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.ensureDirs();
  const activeDir = path.join(dir, 'transactions', 'active');
  await store.create(createJournalEntry('import-apply', LOCK_CTX, 'x'));
  // tmp / 非 journal 文件（Windows 断电残留在同目录）
  await fs.writeFile(path.join(activeDir, `.dshcm.${LOCK_CTX.operationId}.abc.tmp`), 'garbage');
  await fs.writeFile(path.join(activeDir, 'README'), 'hi');
  await fs.writeFile(path.join(activeDir, 'not-a-uuid.json'), '{}');
  await fs.mkdir(path.join(activeDir, 'subdir'), { recursive: true });
  const scanned = await store.scanActive();
  assert.deepEqual(scanned.sort(), [LOCK_CTX.operationId].sort());
  assert.equal(isJournalBasename(`.dshcm.${LOCK_CTX.operationId}.abc.tmp`), false);
  assert.equal(isJournalBasename('not-a-uuid.json'), false);
  assert.equal(isJournalBasename(`${LOCK_CTX.operationId}.json`), true);
});

test('isValidOperationId 严格 UUID', () => {
  assert.equal(isValidOperationId('00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isValidOperationId('../etc'), false);
  assert.equal(isValidOperationId('abc'), false);
  assert.equal(isValidOperationId('../../x.json'), false);
  assert.ok(VALID_OPERATION_ID_RE.test(generateOperationId()));
});

// ---------- terminal / move ----------

test('moveToCompleted：仅 terminal；幂等；非法 state 抛错', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.create(createJournalEntry('import-apply', LOCK_CTX, 'x'));
  // 非 terminal → 拒绝
  await assert.rejects(() => store.moveToCompleted(LOCK_CTX.operationId), /仅接受 terminal/);
  await store.update(LOCK_CTX.operationId, (cur) => ({ ...cur, state: 'COMMITTED' }));
  assert.equal(await store.isTerminal(LOCK_CTX.operationId), true);
  await store.moveToCompleted(LOCK_CTX.operationId);
  assert.equal(await exists(path.join(dir, 'transactions', 'active', `${LOCK_CTX.operationId}.json`)), false);
  const completedPath = path.join(dir, 'transactions', 'completed', `${LOCK_CTX.operationId}.json`);
  assert.equal(await exists(completedPath), true);
  // 幂等再 move（active 已无 → no-op）
  await store.moveToCompleted(LOCK_CTX.operationId);
  assert.ok((await store.load(LOCK_CTX.operationId)) !== null);
});

// ---------- quarantine ----------

test('quarantine：幂等 + attention sidecar；非法 id 拒绝', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.create(createJournalEntry('import-apply', LOCK_CTX, 'x'));
  await store.quarantine(LOCK_CTX.operationId, 'corrupt parse');
  const qPath = path.join(dir, 'transactions', 'quarantine', `${LOCK_CTX.operationId}.json`);
  assert.equal(await exists(qPath), true);
  assert.equal(await exists(`${qPath}.needs-attention`), true);
  // active 已移走
  assert.equal(await exists(path.join(dir, 'transactions', 'active', `${LOCK_CTX.operationId}.json`)), false);
  // 幂等：不重复 move（quarantine 已有 → 删任意 active 副本）
  await store.quarantine(LOCK_CTX.operationId, 'again');
  // quarantine 后 load（active+completed）返回 null（在 quarantine 目录），active 也清空
  assert.equal(await store.loadActive(LOCK_CTX.operationId), null);
  assert.ok((await fs.readFile(qPath, 'utf8')).length > 0);
  // 非法 id：安全 no-op（不 throw、不 touch 文件系统）
  await store.quarantine('../evil', 'x');
  assert.equal(await exists(path.join(dir, 'transactions', 'quarantine', '../evil.json')), false);
});

// ---------- retention ----------

test('retention：completed 与 recovery-history 各保留上限，删最旧', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  for (let i = 0; i < 5; i++) {
    const op = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const j = createJournalEntry('op', { ...LOCK_CTX, operationId: op }, `2026-01-01T0${i}:00:00.000Z`);
    await store.create(j);
    // 直接 update 到 terminal（retention 只测存储，不测迁移链）
    await store.update(op, (cur) => ({ ...cur, state: 'COMMITTED' }));
    await store.moveToCompleted(op);
  }
  await store.retention(2, 10);
  const completed = await fs.readdir(path.join(dir, 'transactions', 'completed'));
  assert.equal(completed.filter((n) => n.endsWith('.json')).length, 2);
});

// ---------- safe-mode ----------

test('safe-mode marker 写/读/清', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  assert.equal(await store.readSafeMode(), false);
  await store.writeSafeMode(true);
  assert.equal(await store.readSafeMode(), true);
  await store.writeSafeMode(false);
  assert.equal(await store.readSafeMode(), false);
});

// ---------- environment fingerprint ----------

test('environmentFingerprint 同 dataDir 稳定、跨 dataDir 不同', async (t) => {
  const dirA = tmp(t);
  const dirB = tmp(t);
  const fp1a = await environmentFingerprint(dirA);
  const fp2a = await environmentFingerprint(dirA);
  assert.equal(fp1a, fp2a, '同 dataDir 应稳定');
  assert.match(fp1a, /^[0-9a-f]{64}$/);
  const fpB = await environmentFingerprint(dirB);
  assert.notEqual(fp1a, fpB, '跨安装应不同');
});

// ---------- 故障注入 ----------

test('journal write 失败时不落盘（atomicWrite throw = target 未变）', async (t) => {
  const dir = tmp(t);
  let failWrite = true;
  const store = new JournalStore({
    transactionsDir: path.join(dir, 'transactions'),
    io: {
      mkdir: async (d) => { await fs.mkdir(d, { recursive: true }); },
      readFileText: async (p) => (await fs.readFile(p, 'utf8')).toString(),
      writeAll: async (target, content) => {
        if (failWrite && target.includes('.json')) throw new Error('injected write fail');
        await fs.writeFile(target, content, { mode: 0o600 });
      },
      rename: async (a, b) => fs.rename(a, b),
      readdirNames: async (d) => { try { return await fs.readdir(d); } catch { return []; } },
      readdirEntries: async (d) => { try { return await fs.readdir(d, { withFileTypes: true }); } catch { return []; } },
      lstat: async (p) => { try { return await fs.lstat(p); } catch { return null; } },
      rm: async (p, o) => fs.rm(p, o as never),
      exists: async (p) => { try { await fs.access(p); return true; } catch { return false; } },
    },
  });
  await assert.rejects(() => store.create(createJournalEntry('x', LOCK_CTX, 'x')));
  // 该 op 不应出现在 active（写失败 → no final file）
  failWrite = false;
  const scanned = await store.scanActive();
  assert.deepEqual(scanned, []);
});

test('sha256 指纹辅助可用', () => {
  const h = sha256Hex(new TextEncoder().encode('hello'));
  assert.match(h, /^[0-9a-f]{64}$/);
});
