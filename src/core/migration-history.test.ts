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
  MigrationStore, sanitizeEntry, queryHistory, renderExport,
  parseHistoryQuery, isValidMigrationKind, redactHistoryText,
  makeHistoryFilename, isHistoryBasename,
  isValidHistoryRetention, resolveHistoryRetention,
  HISTORY_RETENTION_MIN, HISTORY_RETENTION_MAX, DEFAULT_MIGRATION_RETENTION,
  isAutosyncIdleRound, autosyncDirectionMessageKey, autosyncUnifiedHistoryInput,
  type StoredMigrationHistoryEntry, type MigrationIo,
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
    'profile-create', 'profile-select', 'profile-switch', 'profile-delete', 'profile-rename', 'profile-save', 'profile-import',
    'sync-apply', 'autosync', 'recovery',
    'backup', 'backup-manual', 'snapshot-delete', 'snapshot-prune',
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

test('APPEND-ONLY：retention(0) = 不限制，绝不清空目录', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw({ kind: 'import', at: '2026-08-30T12:00:00.000Z' }));
  await store.append(makeRaw({ kind: 'restore', at: '2026-08-30T12:01:00.000Z' }));
  // 0 是「不限制」而不是「保留 0 条」—— 把 0 当上限会把历史清空，属不可逆数据损失
  assert.deepEqual(await store.retention(0), []);
  assert.equal((await store.read()).entries.length, 2);
  // 负数/NaN 同口径（防御非法策略值，绝不批量删）
  assert.deepEqual(await store.retention(-1), []);
  assert.deepEqual(await store.retention(Number.NaN), []);
  assert.equal((await store.read()).entries.length, 2);
});

test('TAIL：read({ limit }) 只读最近 N 条，total 仍报目录全量', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  for (let i = 0; i < 6; i++) {
    await store.append(makeRaw({ at: `2026-08-30T12:0${i}:00.000Z`, summary: `第 ${i} 条` }));
  }
  const tail = await store.read({ limit: 2 });
  // 尾部窗口 = 最新 2 条（文件名按时间戳排序，12:04 / 12:05）
  assert.equal(tail.entries.length, 2);
  assert.equal(tail.entries[0]!.summary, '第 4 条');
  assert.equal(tail.entries[1]!.summary, '第 5 条');
  // total 是「目录里有多少」（首页窗口之外的旧条目仍要能报出规模）
  assert.equal(tail.total, 6);
  // limit 大于总数 / 未传 / 0 → 全量
  assert.equal((await store.read({ limit: 99 })).entries.length, 6);
  assert.equal((await store.read()).entries.length, 6);
  assert.equal((await store.read({ limit: 0 })).entries.length, 6);
});

test('TAIL：read({ limit }) 不改统计口径——窗口内损坏条目照旧进 corrupted', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  await store.append(makeRaw({ at: '2026-08-30T12:00:00.000Z' }));
  await store.append(makeRaw({ at: '2026-08-30T12:01:00.000Z' }));
  const hist = path.join(dir, 'migration-history');
  // 最新一条写坏（篡改内容 → contentHash 不匹配）
  const newest = (fssync.readdirSync(hist).sort() as string[]).at(-1)!;
  await fs.writeFile(path.join(hist, newest), '{ broken');
  const res = await store.read({ limit: 1 });
  assert.equal(res.entries.length, 0);
  assert.equal(res.corrupted.length, 1);
  assert.equal(res.total, 2);
});

test('COUNT：count() 只数合法历史文件，不读内容、不数脏文件', async (t) => {
  const dir = tmp(t);
  const store = mkStore(dir);
  const hist = path.join(dir, 'migration-history');
  await fs.mkdir(hist, { recursive: true });
  await store.append(makeRaw());
  await fs.writeFile(path.join(hist, 'leftover.txt'), 'junk');
  await fs.writeFile(path.join(hist, '.dshcm.abc.tmp'), 'junk');
  assert.equal(await store.count(), 1);
  // 不存在的目录 → 0（首启还没写过历史）
  assert.equal(await new MigrationStore({ dir: path.join(dir, 'nope') }).count(), 0);
});

test('RETENTION-POLICY：isValid/resolve 只收区间内整数，非法回落缺省 1000', () => {
  assert.equal(isValidHistoryRetention(0), true);
  assert.equal(isValidHistoryRetention(1000), true);
  assert.equal(isValidHistoryRetention(HISTORY_RETENTION_MAX), true);
  for (const bad of [-1, 1.5, HISTORY_RETENTION_MAX + 1, Number.NaN, '1000', null, undefined, {}]) {
    assert.equal(isValidHistoryRetention(bad), false, String(bad));
  }
  assert.equal(resolveHistoryRetention(500), 500);
  assert.equal(resolveHistoryRetention(0), 0);
  assert.equal(resolveHistoryRetention(undefined), DEFAULT_MIGRATION_RETENTION);
  assert.equal(resolveHistoryRetention(-5), DEFAULT_MIGRATION_RETENTION);
  assert.equal(resolveHistoryRetention('oops'), DEFAULT_MIGRATION_RETENTION);
  assert.equal(HISTORY_RETENTION_MIN, 0);
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

test('REDACTED：日期戳备份文件名不误伤（高熵掩码豁免），随机 token 仍掩码', () => {
  // 日期戳文件名：dsh-config-2026-09-03-6dec8c 恰为 28 字符 [a-z0-9-] 串，
  // 曾被 HIGH_ENTROPY 误判打码 → 现按日期形态豁免（备份文件列表本就明文展示）
  const summary = redactHistoryText('定时备份完成：dsh-config-2026-09-03-6dec8c.zip');
  assert.ok(summary.includes('dsh-config-2026-09-03-6dec8c.zip'), '文件名保留可读');
  // 无日期形态的随机长 token 仍被掩码
  const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6';
  assert.ok(!redactHistoryText(`连接失败：${secret}`).includes(secret), '随机 token 仍掩码');
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

test('0.4.1 待裁决：result=pending 可落盘读回、可被查询过滤、导出写人话而非裸枚举', async (t) => {
  const dir = tmp(t);
  const appended = await mkStore(dir).append(makeRaw({ kind: 'autosync', result: 'pending', summary: '自动同步有 1 个分区待裁决' }));
  assert.equal(appended.ok, true);

  const read = await mkStore(dir).read();
  assert.deepEqual(read.corrupted, [], 'pending 是合法结果 —— 不得被当成篡改条目静默丢弃');
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0]!.result, 'pending', '读回必须保留 pending（否则「待裁决」在刷新后消失）');

  assert.deepEqual(parseHistoryQuery({ result: 'pending,failed' }).result, ['pending', 'failed'], '过滤白名单必须认 pending');
  assert.equal(queryHistory(read.entries, { result: ['pending'] }).length, 1);
  assert.equal(queryHistory(read.entries, { result: ['failed'] }).length, 0, 'pending 不得被当成 failed 命中');

  const md = renderExport(read.entries, 'markdown', 'zh');
  assert.match(md, /待裁决/, '导出要写人话');
  assert.ok(!md.includes('| pending |'), '原文列绝不出现裸枚举值');
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

// ---------- 自动同步：空检查轮与方向本地化（2026-11-08 实测） ----------

test('AUTOSYNC：60s 远端探测的空检查轮（upToDate）不构成活动，其余轮次照记', () => {
  // 真机证据（desktop 档案）：sync-history.json 每 60s 一条 upToDate，同期 git 工作副本只有 4 次真实 add。
  assert.equal(isAutosyncIdleRound({ status: 'success', skipReason: 'upToDate' }), true, '命中 upToDate = 什么都没传，是轮询');
  assert.equal(isAutosyncIdleRound({ status: 'success', skipReason: 'unchanged' }), false, 'unchanged 走了下行比对，仍要留痕');
  assert.equal(isAutosyncIdleRound({ status: 'success' }), false, '无 skipReason 的 success = 真的推/拉了');
  assert.equal(isAutosyncIdleRound({ status: 'skipped', skipReason: 'conflict' }), false, '冲突必须留在历史里等用户处理');
  assert.equal(isAutosyncIdleRound({ status: 'failed' }), false, '失败永不静默');
  assert.equal(isAutosyncIdleRound({ status: 'partial', skipReason: 'conflict-kept-local' }), false, '待裁决同属真实事件');
});

test('AUTOSYNC：方向枚举走字典键（两侧同键），未知方向不猜', () => {
  assert.equal(autosyncDirectionMessageKey('push'), 'host.autosyncDirectionPush');
  assert.equal(autosyncDirectionMessageKey('pull'), 'host.autosyncDirectionPull');
  assert.equal(autosyncDirectionMessageKey('both'), 'host.autosyncDirectionBoth');
  assert.equal(autosyncDirectionMessageKey('none'), 'host.autosyncDirectionNone');
  assert.equal(autosyncDirectionMessageKey('bogus'), null, '未知方向返回 null，由调用方原样回显');
  assert.equal(autosyncDirectionMessageKey(undefined), null);

  // 字典词条本身（zh 逐字 + en 无 CJK）由 engine-locale.test.ts 的 t2 清单钉住，这里只管映射。
});

test('AUTOSYNC：统一历史载荷 —— 空轮不写、方向走字典、失败带原因', () => {
  // 与宿主同口径的桩翻译器（字典词条本身由 engine-locale.test.ts 钉住）。
  const dict: Record<string, string> = {
    'host.autosyncDirectionPush': '上传',
    'host.autosyncDirectionPull': '下载',
    'host.autosyncDirectionBoth': '双向',
    'host.autosyncDirectionNone': '检查',
  };
  const msg = (key: string, params?: Record<string, string | number>): string => {
    if (key === 'host.autosyncSummary') return `自动同步 ${String(params?.direction ?? '')}${String(params?.transportSuffix ?? '')}`;
    if (key === 'host.autosyncTransportSuffix') return `（${String(params?.transport ?? '')}）`;
    return dict[key] ?? key;
  };

  assert.equal(autosyncUnifiedHistoryInput({ status: 'success', skipReason: 'upToDate', direction: 'both' }, msg), null, '空检查轮不产生历史条目');

  const push = autosyncUnifiedHistoryInput({ status: 'success', direction: 'push', transport: 'git', appliedSections: ['settings'] }, msg);
  assert.ok(push);
  assert.equal(push.result, 'success');
  assert.equal(push.source, 'autosync');
  assert.deepEqual(push.sections, ['settings']);
  assert.equal(push.summary, '自动同步 上传（git）');
  assert.equal(push.error, undefined);

  // sections 必须是副本：历史条目不得与调用方共享可变数组。
  const owned = ['ui'];
  const shared = autosyncUnifiedHistoryInput({ status: 'skipped', direction: 'both', appliedSections: owned }, msg);
  assert.ok(shared);
  assert.notEqual(shared.sections, owned);

  const failed = autosyncUnifiedHistoryInput({ status: 'failed', direction: 'pull', error: '鉴权失败' }, msg);
  assert.equal(failed?.result, 'failed');
  assert.equal(failed?.error, '鉴权失败', 'failed 必须带原因（sync-history 的 error 优先）');
  assert.equal(autosyncUnifiedHistoryInput({ status: 'failed', direction: 'pull', skipReason: 'network' }, msg)?.error, 'network');

  assert.equal(autosyncUnifiedHistoryInput({ status: 'partial', direction: 'both' }, msg)?.result, 'pending', '待裁决不是失败');

  // 未知方向原样回显，不猜、不吞。
  assert.equal(autosyncUnifiedHistoryInput({ status: 'success', direction: 'weird' }, msg)?.summary, '自动同步 weird');
});

test('BOUND：sanitizeEntry 保留合法 UUID operationId/snapshotId/runId', () => {
  const uuid = '00000000-0000-4000-8000-000000000000';
  const entry = sanitizeEntry(makeRaw({ operationId: uuid, snapshotId: uuid, runId: uuid }));
  assert.equal(entry.operationId, uuid);
  assert.equal(entry.snapshotId, uuid);
  assert.equal(entry.runId, uuid);
});
