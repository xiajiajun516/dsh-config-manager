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
  STALE_JOURNAL_TEMP_MS,
  JournalReferenceUnreadableError,
  type JournalIo, type OperationJournal,
} from './journal.ts';
import { readSafeModeMarkerSync, safeModeMarkerPath } from './phase3-host.ts';
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

// ---------- SAFE MODE：判定单一来源（t26：两份判据收敛） ----------

/**
 * 三态读取：优先用 readSafeModeState（修复后新增）；修复前该方法不存在 → 退化为 boolean 兼容面
 * （unknown 无法表达 → 落成 clear），于是「无法判定」的两条用例会立刻暴露差异。
 */
async function journalSafeModeState(store: JournalStore): Promise<string> {
  const probe = store as JournalStore & { readSafeModeState?: () => Promise<string> };
  if (typeof probe.readSafeModeState === 'function') return probe.readSafeModeState();
  return (await store.readSafeMode()) ? 'blocked' : 'clear';
}

test('SAFE MODE：journal 与宿主同步探测对同一 marker 判定一致（含「无法判定」→ unknown）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const markerDir = path.join(dir, 'transactions');
  await fs.mkdir(markerDir, { recursive: true });
  const marker = path.join(markerDir, 'safe-mode');

  // 路径口径单源（宿主/CLI 沿用 phase3-host 的 re-export）
  assert.equal(safeModeMarkerPath(dir), marker);

  // ① 标记不存在（布局完好）→ 两侧 clear
  assert.equal(await journalSafeModeState(store), 'clear');
  assert.equal(readSafeModeMarkerSync(dir), 'clear');
  assert.equal(await store.readSafeMode(), false);

  // ② 阻断内容 → 两侧 blocked（同一内容判据）
  await fs.writeFile(marker, JSON.stringify({ blocked: true, at: '2026-09-22T00:00:00.000Z' }), 'utf8');
  assert.equal(await journalSafeModeState(store), 'blocked');
  assert.equal(readSafeModeMarkerSync(dir), 'blocked');
  assert.equal(await store.readSafeMode(), true);

  // ③ 非阻断内容 → 两侧 clear。注意内容判据是**包含式**（含 blocked/true 即阻断），
  //    所以「清理」形态由 writeSafeMode(false) 删文件表达，不会出现 blocked:false 的标记。
  await fs.writeFile(marker, 'reset by user', 'utf8');
  assert.equal(await journalSafeModeState(store), 'clear');
  assert.equal(readSafeModeMarkerSync(dir), 'clear');
  assert.equal(await store.readSafeMode(), false);

  // ④ 「无法判定」：标记存在但不是普通文件 → 两侧 unknown，绝不静默放行
  //    修复前 journal 侧读目录抛错/吞错，被当成「没有标记」（放行），与同步侧结论相反。
  await fs.rm(marker, { force: true });
  await fs.mkdir(marker, { recursive: true });
  assert.equal(readSafeModeMarkerSync(dir), 'unknown', '同步侧 fail-closed');
  const verdict = await journalSafeModeState(store).catch(() => 'threw');
  assert.equal(verdict, 'unknown', `journal 侧必须同判（修复前：抛错或误判 clear）；实际 ${verdict}`);
  assert.equal(await store.readSafeMode(), false, 'boolean 兼容面：unknown 不在此层提升为阻断（与 probeSafeModeSync 同姿态）');
  await fs.rm(marker, { recursive: true, force: true });

  // ⑤ 祖先布局损坏：transactions 是普通文件（Windows 上 statSync 只报 ENOENT，靠祖先核对兜住）
  const dir2 = tmp(t);
  await fs.writeFile(path.join(dir2, 'transactions'), 'not a dir', 'utf8');
  const store2 = mkStore(dir2);
  assert.equal(readSafeModeMarkerSync(dir2), 'unknown', '布局不可信 → fail-closed');
  assert.equal(await journalSafeModeState(store2), 'unknown', 'journal 侧必须同判（修复前误判 clear）');
});

// ---------- cross-F2：孤儿原子写 tmp 的清理点 ----------

test('cross-F2：transactions 里的孤儿原子写 tmp 必须有清理点（新鲜的可能在写 → 不动）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.ensureDirs();
  const activeDir = path.join(dir, 'transactions', 'active');
  const stale = path.join(activeDir, '.dshcm.11111111-2222-4333-8444-555555555555.json.1504.1bbe1211075cd69d.tmp');
  const fresh = path.join(activeDir, '.dshcm.99999999-2222-4333-8444-555555555555.json.1504.2bbe1211075cd69d.tmp');
  await fs.writeFile(stale, '{"partial":true}');
  await fs.writeFile(fresh, '{"partial":true}');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(stale, old, old);

  await store.ensureDirs();

  assert.equal(await exists(stale), false, '超过窗口的孤儿 tmp 必须被清掉（否则 transactions 里的垃圾永远既不可回收也不可见）');
  assert.equal(await exists(fresh), true, '新鲜 tmp 必须保留（可能正在写）');
  assert.deepEqual(await store.scanActive(), [], '清理后 active 里不再有幽灵项');
});

// ---------- t65：sweepStaleTemps 的边界语义（t60 的 O1 / O3） ----------

test('t65-O1：年龄恰好 60:00.000 视为陈旧（达到即删、判据 age >= 阈值），差 1ms 则保留', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.ensureDirs();
  const activeDir = path.join(dir, 'transactions', 'active');
  const exact = path.join(activeDir, '.dshcm.a.json.1504.0123456789abcdef.tmp');
  const justUnder = path.join(activeDir, '.dshcm.b.json.1504.0123456789abcdef.tmp');
  await fs.writeFile(exact, '{}');
  await fs.writeFile(justUnder, '{}');
  const T = Date.now();
  const atThreshold = new Date(T - STALE_JOURNAL_TEMP_MS);
  const oneMsUnder = new Date(T - STALE_JOURNAL_TEMP_MS + 1);
  await fs.utimes(exact, atThreshold, atThreshold);
  await fs.utimes(justUnder, oneMsUnder, oneMsUnder);

  const removed = await store.sweepStaleTemps(T);

  assert.equal(removed, 1, '恰好 60:00.000 必须被回收（判据是 age >= STALE_JOURNAL_TEMP_MS，注释与此一致）');
  assert.equal(await exists(exact), false, '达到阈值 → 删');
  assert.equal(await exists(justUnder), true, '未达到阈值（差 1ms）→ 保留');
});

test('t65-O3：判据是有意保守宽判 —— 前缀与 .tmp 同时命中的才回收，缺一者一律保留', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.ensureDirs();
  const activeDir = path.join(dir, 'transactions', 'active');
  const realShape = path.join(activeDir, '.dshcm.11111111-2222-4333-8444-555555555555.json.1504.0123456789abcdef.tmp');
  const broadOnly = path.join(activeDir, '.dshcm.notes.tmp');
  const noTmpSuffix = path.join(activeDir, '.dshcm.notes.json');
  const noPrefix = path.join(activeDir, 'notes.tmp');
  const all = [realShape, broadOnly, noTmpSuffix, noPrefix];
  for (const p of all) await fs.writeFile(p, '{}');
  const T = Date.now();
  const old = new Date(T - 2 * 60 * 60 * 1000);
  for (const p of all) await fs.utimes(p, old, old);

  const removed = await store.sweepStaleTemps(T);

  assert.equal(removed, 2, '实际 atomic-write 形态与「.dshcm.*.tmp」宽形态各 1 条被收');
  assert.equal(await exists(realShape), false, '实际形态（.dshcm.<base>.<pid>.<16hex>.tmp）必须被收');
  assert.equal(await exists(broadOnly), false, 'O3：宽判有意保留 —— .dshcm.*.tmp 一律收（理由见 isJournalTempBasename 注释）');
  assert.equal(await exists(noTmpSuffix), true, '缺 .tmp 后缀 → 不删');
  assert.equal(await exists(noPrefix), true, '缺 .dshcm. 前缀 → 不删');
});
// ---------- P3-5：读不到 ≠ 没有引用（引用集合必须能如实「不完整」） ----------

/** 直接落一条 completed journal（绕过状态机，用于构造「可解析 / 损坏」两种磁盘形态）。 */
async function writeCompletedJournal(dir: string, name: string, text: string): Promise<void> {
  const completed = path.join(dir, 'transactions', 'completed');
  await fs.mkdir(completed, { recursive: true });
  await fs.writeFile(path.join(completed, name), text, 'utf8');
}

/** 自定义 io 的基线（跟随本文件既有注入风格；readdir 只把 ENOENT 当空，其余原样抛）。 */
function probeIo(over: Partial<JournalIo> = {}): JournalIo {
  return {
    mkdir: async (d) => { await fs.mkdir(d, { recursive: true }); },
    readFileText: async (p) => (await fs.readFile(p, 'utf8')).toString(),
    writeAll: async (target, content) => { await fs.writeFile(target, content, { mode: 0o600 }); },
    rename: async (a, b) => fs.rename(a, b),
    readdirNames: async (d) => {
      try { return await fs.readdir(d); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    readdirEntries: async (d) => {
      try { return await fs.readdir(d, { withFileTypes: true }); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    lstat: async (p) => { try { return await fs.lstat(p); } catch { return null; } },
    rm: async (p, o) => fs.rm(p, o as never),
    exists: async (p) => { try { await fs.access(p); return true; } catch { return false; } },
    ...over,
  };
}

test('P3-5：completed 里有解析不了的 journal → 引用集合显式失败（旧实现当成「没有这条引用」放行删除）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const goodId = '11111111-1111-4111-8111-111111111111';
  const badName = '22222222-2222-4222-8222-222222222222.json';
  const good: OperationJournal = {
    ...createJournalEntry('import-apply', { ...LOCK_CTX, operationId: goodId }, '2026-01-01T00:00:00.000Z'),
    state: 'ROLLING_BACK',
    snapshotId: 'snap-keep',
  };
  await writeCompletedJournal(dir, `${goodId}.json`, JSON.stringify(good));
  await writeCompletedJournal(dir, badName, '{ not json');

  await assert.rejects(
    () => store.listReferencedSnapshotIds(),
    (err: unknown) => {
      assert.ok(err instanceof JournalReferenceUnreadableError, '必须是可识别的「引用集合不可读」错误');
      assert.deepEqual(err.unreadable, [`completed/${badName}`], '必须指出具体哪条读不出（诊断面）');
      return true;
    },
  );

  const scan = await store.scanSnapshotReferences();
  assert.equal(scan.complete, false, '有解析不了的 journal ⇒ 集合不完整');
  assert.deepEqual([...scan.referenced], ['snap-keep'], '可解析的部分仍如实给出（供保守分支做诊断）');

  // 损坏件消失后集合恢复可用：证明失败来自「读不出」，不是「永远拒绝」
  await fs.rm(path.join(dir, 'transactions', 'completed', badName));
  assert.deepEqual([...(await store.listReferencedSnapshotIds())], ['snap-keep']);
});

test('P3-5：journal 目录读不到（非 ENOENT）→ 不完整 + 抛错，绝不当空集合；ENOENT 才算真没有', async (t) => {
  const dir = tmp(t);
  const completed = path.join(dir, 'transactions', 'completed');
  await fs.mkdir(completed, { recursive: true });
  const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  const store = new JournalStore({
    transactionsDir: path.join(dir, 'transactions'),
    io: probeIo({
      readdirNames: async (d) => {
        if (path.resolve(d) === path.resolve(completed)) throw denied;
        return await probeIo().readdirNames(d);
      },
    }),
  });

  const scan = await store.scanSnapshotReferences();
  assert.equal(scan.complete, false, '目录读不到 = 引用集合未知，不能折叠成「没有引用」');
  assert.deepEqual(scan.unreadable, ['completed']);
  await assert.rejects(() => store.listReferencedSnapshotIds(), JournalReferenceUnreadableError);

  // 对照：目录确实不存在 → 空集合且完整（ENOENT 与「读不到」必须不同结论）
  const emptyDir = tmp(t);
  const fresh = mkStore(emptyDir);
  const freshScan = await fresh.scanSnapshotReferences();
  assert.equal(freshScan.complete, true);
  assert.deepEqual([...(await fresh.listReferencedSnapshotIds())], []);
});

test('P3-5：默认 io 只把「确实不存在」当空目录 —— active 是普通文件（ENOTDIR）必须抛错', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const active = path.join(dir, 'transactions', 'active');
  await fs.mkdir(path.dirname(active), { recursive: true });
  await fs.writeFile(active, 'not a dir', 'utf8');

  await assert.rejects(
    () => store.scanActive(),
    (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOTDIR',
    '路径类型错误必须抛给调用方（旧实现 catch 一切 → []，让「读不到」与「没有」不可区分）',
  );

  const scan = await store.scanSnapshotReferences();
  assert.equal(scan.complete, false, 'active 读不到 ⇒ 引用集合不完整（上层必须 fail-closed）');
  assert.deepEqual(scan.unreadable, ['active']);
  await assert.rejects(() => store.listReferencedSnapshotIds(), JournalReferenceUnreadableError);
});

// ---------- P3-7：retention 按真实时间删最旧（不是 UUID 文件名字典序） ----------

test('P3-7：completed 按记录内 updatedAt 删最旧，UUID 字典序不再决定删谁', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const newestName = '00000000-0000-4000-8000-000000000001.json';
  const oldestName = 'ffffffff-ffff-4fff-8fff-ffffffffffff.json';
  // 名字字典序：newest 在前；真实时间：oldest 在前 —— 两者刻意相反，逼出实现用的是哪个键
  await writeCompletedJournal(dir, newestName, JSON.stringify({
    ...createJournalEntry('import-apply', { ...LOCK_CTX, operationId: '00000000-0000-4000-8000-000000000001' }, '2026-01-01T00:00:00.000Z'),
    state: 'NEEDS_ATTENTION',
    updatedAt: '2026-01-02T00:00:00.000Z',
  }));
  await writeCompletedJournal(dir, oldestName, JSON.stringify({
    ...createJournalEntry('import-apply', { ...LOCK_CTX, operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, '2026-01-01T00:00:00.000Z'),
    state: 'NEEDS_ATTENTION',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));

  const removed = await store.retention(1, 10);

  assert.equal(removed.completed, 1);
  assert.equal(await exists(path.join(dir, 'transactions', 'completed', newestName)), true, '最新的一条必须保留（旧实现按名字删掉它）');
  assert.equal(await exists(path.join(dir, 'transactions', 'completed', oldestName)), false, '更旧的一条才是要删的');
});

test('P3-7：判不了新旧（损坏 / 读不出）的 completed journal 绝不被当「最旧」删除', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const corruptName = '00000000-0000-4000-8000-000000000000.json'; // 字典序第一，旧实现必删
  await writeCompletedJournal(dir, corruptName, '{ broken');
  for (const [id, updatedAt] of [
    ['11111111-1111-4111-8111-111111111111', '2026-01-01T00:00:00.000Z'],
    ['22222222-2222-4222-8222-222222222222', '2026-01-02T00:00:00.000Z'],
  ] as const) {
    await writeCompletedJournal(dir, `${id}.json`, JSON.stringify({
      ...createJournalEntry('import-apply', { ...LOCK_CTX, operationId: id }, '2026-01-01T00:00:00.000Z'),
      state: 'NEEDS_ATTENTION',
      updatedAt,
    }));
  }

  const removed = await store.retention(1, 10);

  assert.equal(removed.completed, 1, '只有一条可判新旧且超限');
  assert.equal(await exists(path.join(dir, 'transactions', 'completed', corruptName)), true, '未知年龄的 journal 不得被删（宁可暂时超限）');
  assert.equal(await exists(path.join(dir, 'transactions', 'completed', '22222222-2222-4222-8222-222222222222.json')), true);
  assert.equal(await exists(path.join(dir, 'transactions', 'completed', '11111111-1111-4111-8111-111111111111.json')), false);
});

test('P3-7：recovery-history 的时间键是文件名 epoch 数值，不是字典序（10 位 vs 7 位不再颠倒）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const histDir = path.join(dir, 'transactions', 'recovery-history');
  await fs.mkdir(histDir, { recursive: true });
  // 生产名是定宽 13 位 epochMs；这里用不同位数把「数值键 vs 字典序」的差异逼出来，防止有人改回 .sort()
  const newer = '1000000-bbbbbb.marker.json';
  const older = '999000-aaaaaa.marker.json';
  await fs.writeFile(path.join(histDir, older), '{}\n', 'utf8');
  await fs.writeFile(path.join(histDir, newer), '{}\n', 'utf8');

  const removed = await store.retention(10, 1);

  assert.equal(removed.history, 1);
  assert.equal(await exists(path.join(histDir, newer)), true, 'epoch 更大的一条必须保留（旧实现按名字把它当第一删掉）');
  assert.equal(await exists(path.join(histDir, older)), false);
});

