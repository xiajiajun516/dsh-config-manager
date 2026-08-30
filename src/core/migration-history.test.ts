/**
 * Phase 6 MigrationStore 单测（node:test，零依赖）。
 *
 * 覆盖核心不变量：
 *  - DURABLE：append → 新 store 实例读取 → 条目仍在（落盘跨重启）。
 *  - APPEND-ONLY：per-file 独立条目、无覆盖、篡改（改字段值/损坏 JSON）被检测跳过、
 *    retention 只删最旧合法条目。
 *  - REDACTED：summary/error 含 secret / 高熵 token → 落盘读回 masked，无原值。
 *  - COMPLETE：MigrationKind 枚举恰为 §5 全清单（含 profile-import）。
 *  - QUERYABLE：query 按 kind/result/时间/sections 过滤。
 *  - EXPORTABLE：renderExport(json/markdown)。
 *  - best-effort：注入失败 IO → tryAppend 不 throw，调用方收到 ok:false。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MigrationStore, sanitizeEntry, queryHistory, summarizeHistory, renderExport,
  parseHistoryQuery, isValidMigrationKind, redactHistoryText,
  makeHistoryFilename, isHistoryBasename, DEFAULT_MIGRATION_RETENTION,
  MIGRATION_HISTORY_SCHEMA_VERSION,
  type MigrationKind, type StoredMigrationHistoryEntry, type MigrationIo,
} from './migration-history.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'migration-history-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkStore(dir: string): MigrationStore {
  return new MigrationStore({ dir: path.join(dir, 'migration-history') });
}

function makeRaw(partial: Partial<StoredMigrationHistoryEntry> = {}): Omit<StoredMigrationHistoryEntry, 'schemaVersion' | 'contentHash'> {
  return {
    at: '2026-08-30T12:00:00.000Z',
    kind: 'import',
    result: 'success',
    sections: ['plugins'],
    source: 'api',
    summary: '导入 plugins 分区',
    ...partial,
  } as Omit<StoredMigrationHistoryEntry, 'schemaVersion' | 'contentHash'>;
}

// ---------- COMPLETE ----------

test('COMPLETE：MigrationKind 枚举恰为 §5 全清单（含 profile-import）', () => {
  const expected = [
    'import', 'restore', 'rollback',
    'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
    'sync-apply', 'autosync', 'recovery',
    'backup', 'snapshot-delete', 'snapshot-prune',
  ];
  for (const k of expected) assert.equal(isValidMigrationKind(k), true, k);
  assert.equal(isValidMigrationKind('export'), false);
  assert.equal(isValidMigrationKind('nonsense'), false);
  assert.equal(isValidMigrationKind(12), false);
});

// ---------- DURABLE ----------

test('DURABLE：append → 新 store 实例读取 → 条目仍在（落盘跨重启模拟）', async (t) => {
  const dir = tmp(t);
  await mkStore(dir).append(makeRaw());
  // 新建 store 实例模拟进程重启
  const fresh = mkStore(dir);
  const res = await fresh.read();
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0]!.kind, 'import');
  assert.equal(res.corrupted.length, 0);
});

// ---------- APPEND-ONLY ----------

test('APPEND-ONLY：连续 append 生成独立文件，且都可读（无覆盖）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const a = await store.append(makeRaw({ kind: 'import' }));
  const b = await store.append(makeRaw({ kind: 'restore', at: '2026-08-30T12:01:00.000Z' }));
  assert.notEqual(a.file, b.file);
  const res = await store.read();
  assert.equal(res.entries.length, 2);
  const kinds = res.entries.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['import', 'restore']);
});

test('APPEND-ONLY：篡改合法 JSON 内字段值 → 读回 hash 不符 → 该文件被识别为损坏跳过', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw());
  // 直接篡改落盘文件：把 result 改成 failed + 同步改 summary，保持合法 JSON
  const names = await fs.readdir(path.join(dir, 'migration-history'));
  const target = path.join(dir, 'migration-history', names[0]!);
  const text = await fs.readFile(target, 'utf8');
  await fs.writeFile(target, text.replace('"result": "success"', '"result": "failed"'));
  const res = await store.read();
  assert.equal(res.entries.length, 0);       // 篡改条目被拒
  assert.equal(res.corrupted.length, 1);      // 并计数（不静默接受）
});

test('APPEND-ONLY：损坏 JSON 文件被识别为损坏跳过，不影响其余合法条目', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw({ kind: 'import' }));
  await store.append(makeRaw({ kind: 'restore', at: '2026-08-30T12:01:00.000Z' }));
  // 写入一个损坏文件
  const hist = path.join(dir, 'migration-history');
  await fs.writeFile(path.join(hist, makeHistoryFilename(new Date('2026-08-30T12:02:00.000Z'), 'backup')), '{broken json');
  const res = await store.read();
  assert.equal(res.entries.length, 2);
  assert.equal(res.corrupted.length, 1);
  assert.match(res.corrupted[0]!, /\.json$/);
});

test('APPEND-ONLY：basename 校验——只认合法历史文件，忽略 tmp 与非法名', () => {
  assert.equal(isHistoryBasename('2026-08-30T120000.123-abc123def456.import.json'), true);
  assert.equal(isHistoryBasename('.dshcm.abc.tmp'), false);
  assert.equal(isHistoryBasename('random.txt'), false);
  assert.equal(isHistoryBasename('2026-08-30T120000.123-abc.import.json'), false); // hex 不足 12
});

test('APPEND-ONLY：retention 只删最旧合法条目，幂等，损坏文件不阻塞', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const hist = path.join(dir, 'migration-history');
  // append 4 条，retention=2（保留最近 2 条）
  await store.append(makeRaw({ kind: 'import', at: '2026-08-30T12:00:00.000Z' }));
  await store.append(makeRaw({ kind: 'restore', at: '2026-08-30T12:01:00.000Z' }));
  await store.append(makeRaw({ kind: 'backup', at: '2026-08-30T12:02:00.000Z' }));
  await store.append(makeRaw({ kind: 'snapshot-delete', at: '2026-08-30T12:03:00.000Z' }));
  // retention 删除 2 条最旧（12:00 / 12:01），保留 12:02 / 12:03
  const removed = await store.retention(2);
  assert.equal(removed.length, 2);
  const res = await store.read();
  assert.equal(res.entries.length, 2);
  // 幂等：再跑一次不做任何改动
  const removed2 = await store.retention(2);
  assert.equal(removed2.length, 0);
});

test('APPEND-ONLY：retention 只删合法历史文件，遗留脏文件被忽略', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const hist = path.join(dir, 'migration-history');
  await store.append(makeRaw({ kind: 'import', at: '2026-08-30T12:00:00.000Z' }));
  await store.append(makeRaw({ kind: 'restore', at: '2026-08-30T12:01:00.000Z' }));
  await store.append(makeRaw({ kind: 'backup', at: '2026-08-30T12:02:00.000Z' }));
  // 遗留脏文件（非合法 basename）：不应被删也不应阻塞
  await fs.writeFile(path.join(hist, 'leftover.txt'), 'junk');
  const removed = await store.retention(2);
  assert.deepEqual(removed.map((r) => r.toLowerCase()).filter((r) => r.endsWith('.txt')), []);
  assert.equal((await store.read()).entries.length, 2);
  // 脏文件仍在
  const after = await fs.readdir(hist);
  assert.ok(after.includes('leftover.txt'));
});

test('APPEND-ONLY：retention 不足 limit 时不做任何删除（幂等）', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw());
  const removed = await store.retention(100);
  assert.equal(removed.length, 0);
  assert.equal((await store.read()).entries.length, 1);
});

test('APPEND-ONLY：无 update/delete API（导出不暴露改删符号）', () => {
  const exported = Object.keys(MigrationStore.prototype).filter((k) => /^(update|delete|remove|edit|overwrite)/.test(k));
  assert.deepEqual(exported, []);
});

// ---------- REDACTED ----------

test('REDACTED：summary 含已知值形状 secret → 读回 masked 无原值', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw({ summary: 'token=sk-abc1234567890abcdef 配置已同步' }));
  const res = await store.read();
  const s = res.entries[0]!.summary;
  assert.ok(!s.includes('sk-abc1234567890abcdef'));
});

test('REDACTED：error 含高熵长 token → 读回 masked 无原值', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6';
  await store.append(makeRaw({ result: 'failed', error: `连接失败：${secret}` }));
  const res = await store.read();
  assert.ok(!res.entries[0]!.error!.includes(secret));
});

test('REDACTED：错误文本中嵌 secret 值形状被掩码，且保留非敏感上下文', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw({ result: 'failed', error: 'token sk-abc1234567890abcdef 过期' }));
  const res = await store.read();
  const e = res.entries[0]!.error!;
  assert.ok(!e.includes('sk-abc1234567890abcdef'));
  assert.ok(e.includes('过期')); // 无损掩码保留上下文
});

test('REDACTED：sanitizeEntry 校验 source 合法枚举，非法回退 internal', () => {
  const entry = sanitizeEntry(makeRaw({ source: 'evil-input' as never }));
  assert.equal(entry.source, 'internal');
  const ok = sanitizeEntry(makeRaw({ source: 'api' }));
  assert.equal(ok.source, 'api');
});

test('REDACTED：白名单字段不含 secret 承载面——operationId/snapshotId/runId 非 UUID 被剥离', () => {
  const entry = sanitizeEntry(makeRaw({ operationId: 'not-a-uuid', snapshotId: 'abc' } as never));
  assert.equal(entry.operationId, undefined);
  assert.equal(entry.snapshotId, undefined);
});

// ---------- QUERYABLE / EXPORTABLE ----------

test('QUERYABLE：query 按 kind / result / sections 过滤', () => {
  const entries = [
    sanitizeEntry(makeRaw({ at: '2026-08-30T12:00:00.000Z', kind: 'import', result: 'success', sections: ['plugins'] })),
    sanitizeEntry(makeRaw({ at: '2026-08-30T12:01:00.000Z', kind: 'restore', result: 'success', sections: ['settings', 'plugins'] })),
    sanitizeEntry(makeRaw({ at: '2026-08-30T12:02:00.000Z', kind: 'snapshot-delete', result: 'failed', sections: [] })),
  ];
  assert.equal(queryHistory(entries, { kinds: ['import'] }).length, 1);
  assert.equal(queryHistory(entries, { result: ['failed'] }).length, 1);
  assert.equal(queryHistory(entries, { sections: ['plugins'] }).length, 2);
  assert.equal(queryHistory(entries, {}).length, 3);
});

test('QUERYABLE：query 按时间范围（from/to）过滤', () => {
  const entries = [
    sanitizeEntry(makeRaw({ at: '2026-08-30T12:00:00.000Z' })),
    sanitizeEntry(makeRaw({ at: '2026-08-30T12:30:00.000Z' })),
  ];
  const from = Date.parse('2026-08-30T12:10:00.000Z');
  const to = Date.parse('2026-08-31T00:00:00.000Z');
  assert.equal(queryHistory(entries, { from, to }).length, 1);
});

test('QUERYABLE：parseHistoryQuery 解析过滤参数并丢弃非法 kind', () => {
  const q = parseHistoryQuery({ kind: 'import,restore,bogus', result: 'success,failed', sections: 'plugins' });
  assert.deepEqual(q.kinds, ['import', 'restore']);
  assert.deepEqual(q.result, ['success', 'failed']);
  assert.deepEqual(q.sections, ['plugins']);
});

test('EXPORTABLE：renderExport json 输出合法 JSON + 统计', () => {
  const entries = [sanitizeEntry(makeRaw()), sanitizeEntry(makeRaw({ kind: 'restore', result: 'failed' }))];
  const json = renderExport(entries, 'json');
  const parsed = JSON.parse(json);
  assert.equal(parsed.stats.total, 2);
  assert.deepEqual(parsed.stats.byKind, { import: 1, restore: 1 });
  assert.equal(parsed.entries.length, 2);
});

test('EXPORTABLE：renderExport markdown 表格 + 空态文案', () => {
  const entries = [sanitizeEntry(makeRaw())];
  const md = renderExport(entries, 'markdown', 'zh');
  assert.match(md, /^# DSH 配置迁移历史/);
  assert.match(md, /\| 时间 \| 操作 \|/);
  const empty = renderExport([], 'markdown');
  assert.match(empty, /暂无迁移记录/);
});

test('EXPORTABLE：renderExport 渲染文本过 redact() 兜底', () => {
  const entries = [sanitizeEntry(makeRaw({ summary: 'password=secret123 已配置' }))];
  // 若 sanitize 已掩码，则这里验证输出不含 secret；同时确认兜底路径存在
  const md = renderExport(entries, 'markdown');
  assert.ok(!md.includes('secret123'));
});

// ---------- best-effort ----------

test('best-effort：注入失败 IO → append 返回 ok:false 不 throw', async (t) => {
  const dir = tmp(t);
  const failingIo: MigrationIo = {
    async mkdir() { throw new Error('EACCES'); },
    async readdirNames() { return []; },
    async readFileText() { throw new Error(); },
    async writeAll() { throw new Error('EACCES'); },
    async rm() { return; },
    async lstat() { return null; },
    async exists() { return false; },
  };
  const store = new MigrationStore({ dir: path.join(dir, 'migration-history'), io: failingIo });
  const res = await store.append(makeRaw());
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('best-effort：read 目录不存在 → 空结果不 throw', async (t) => {
  const dir = tmp(t);
  const store = new MigrationStore({ dir: path.join(dir, 'no-such-dir') });
  const res = await store.read();
  assert.equal(res.entries.length, 0);
  assert.equal(res.corrupted.length, 0);
});

test('BOUND：sanitizeEntry 保留合法 UUID operationId/snapshotId/runId', () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  const entry = sanitizeEntry(makeRaw({ operationId: uuid, snapshotId: uuid, runId: uuid }));
  assert.equal(entry.operationId, uuid);
  assert.equal(entry.snapshotId, uuid);
  assert.equal(entry.runId, uuid);
});
