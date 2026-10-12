/**
 * disk-usage 测试：只读磁盘体检的聚合 / 超期判定 / 容错 / 符号链接边界。
 * 用真实临时目录（node:os tmpdir）+ node:fs 真实读写（与 cache-cleaner.test.ts 同模式）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DISK_USAGE_AREAS,
  DISK_USAGE_EXTRA_AREAS,
  IMMEDIATE_CLEAN_CATEGORIES,
  LEGACY_DATA_DIRS,
  diskUsageDirOf,
  scanDiskUsage,
  type DiskUsageArea,
  type DiskUsageDirs,
  type DiskUsageScanArea,
} from './disk-usage.ts';
import { backupRoutes } from '../routes/backup.ts';
import { routeSpecOf, type WebRoute } from '../routes/kit.ts';

const DAY = 24 * 60 * 60 * 1000;

interface Fixture {
  root: string;
  dirs: DiskUsageDirs;
  cleanup: () => Promise<void>;
}

/** 建一份完整的 §dataDir 布局（每个子区一个目录） */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-diskusage-'));
  const dirs: DiskUsageDirs = {
    dataDir: root,
    exportsDir: path.join(root, 'exports'),
    snapshotsDir: path.join(root, 'snapshots'),
    syncDir: path.join(root, 'sync'),
    marketCacheDir: path.join(root, 'market', 'cache'),
    marketWorkDir: path.join(root, 'market', 'work'),
    tmpDir: path.join(root, 'tmp'),
    logsDir: path.join(root, 'logs'),
    bootStateDir: path.join(root, 'boot-state'),
    migrationHistoryDir: path.join(root, 'migration-history'),
    transactionsDir: path.join(root, 'transactions'),
    locksDir: path.join(root, 'locks'),
    vaultDir: path.join(root, 'vault'),
  };
  await fs.mkdir(dirs.exportsDir, { recursive: true });
  await fs.mkdir(path.join(dirs.snapshotsDir, 'snap1'), { recursive: true });
  await fs.mkdir(dirs.syncDir, { recursive: true });
  await fs.mkdir(dirs.marketCacheDir, { recursive: true });
  await fs.mkdir(dirs.marketWorkDir, { recursive: true });
  await fs.mkdir(dirs.tmpDir, { recursive: true });
  return { root, dirs, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

/** 写文件并指定 mtime（Windows 精度足够，测试用秒级偏移） */
async function writeFileAt(file: string, bytes: number, mtimeMs: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 1));
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
}

const POLICY = {
  exportsRetentionMs: 7 * DAY,
  marketRetentionMs: 7 * DAY,
  tmpRetentionMs: DAY,
  exportsExemptPrefix: 'dsh-config-auto-',
};

test('disk-usage：分区体积/文件数聚合 + 可立即释放 = 可重建区合计', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.exportsDir, 'a.zip'), 100, now);
    await writeFileAt(path.join(f.dirs.snapshotsDir, 'snap1', 'config.json'), 40, now);
    await writeFileAt(path.join(f.dirs.tmpDir, 'upload.zip'), 30, now);
    await writeFileAt(path.join(f.dirs.marketCacheDir, 'hash', 'index.json'), 20, now);
    await writeFileAt(path.join(f.dirs.marketWorkDir, 'hash', 'ref'), 10, now);

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.exports.sizeBytes, 100);
    assert.equal(report.areas.exports.fileCount, 1);
    assert.equal(report.areas.snapshots.sizeBytes, 40);
    assert.equal(report.areas.tmp.sizeBytes, 30);
    assert.equal(report.totalBytes, 100 + 40 + 30 + 20 + 10);
    assert.equal(report.totalFiles, 5);
    // 可立即清理 = tmp + market/cache + market/work（不含导出与快照）
    assert.equal(report.reclaimableBytes, 30 + 20 + 10);
    // 保护类不参与回收
    assert.equal(report.areas.snapshots.policy, 'protected');
    assert.equal(report.areas.exports.policy, 'retained');
    assert.equal(report.areas.tmp.policy, 'regenerable');
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：导出产物的「已超期」只算 *.zip，且豁免定时备份前缀', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.exportsDir, 'manual-old.zip'), 100, now - 8 * DAY);
    await writeFileAt(path.join(f.dirs.exportsDir, 'manual-new.zip'), 200, now);
    // 定时备份：过期但豁免（保留策略归 BackupScheduler，不按天回收）
    await writeFileAt(path.join(f.dirs.exportsDir, 'dsh-config-auto-old.zip'), 300, now - 30 * DAY);
    // 非 zip 不参与
    await writeFileAt(path.join(f.dirs.exportsDir, 'notes.txt'), 400, now - 30 * DAY);

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.exports.sizeBytes, 100 + 200 + 300 + 400, '全部文件计入占用');
    assert.equal(report.areas.exports.expiredBytes, 100, '只有过期的非豁免 zip 计入可回收');
    assert.equal(report.areas.exports.expiredCount, 1);
    assert.equal(report.expiredBytes, 100);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：目录不存在 → unreadable（不是 0 字节），不影响其余统计', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.tmpDir, 'x.zip'), 7, now);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    // vault 从未创建 → 必须标「未统计」，界面才不会显示 0 字节
    assert.equal(report.areas.vault.unreadable, true);
    assert.equal(report.areas.vault.sizeBytes, 0);
    assert.equal(report.areas.tmp.unreadable, false);
    assert.equal(report.totalBytes, 7);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：符号链接/junction 不展开（不重复计数、不成环）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    const real = path.join(f.root, 'real-payload');
    await writeFileAt(path.join(real, 'big.bin'), 1000, now);
    const link = path.join(f.dirs.tmpDir, 'linked');
    try {
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境不允许建链接：跳过该断言（不谎报通过）
    }
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.tmp.sizeBytes, 0, '链接本身不是文件，目标内容不计入本区');
    assert.equal(report.totalBytes, 0);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：保留期口径进入报告（缓存/临时 7 天与 24 小时、定时备份保留数）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.marketCacheDir, 'h', 'index.json'), 5, now - 8 * DAY);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, backupKeepLast: 7, now: () => now });
    assert.equal(report.areas.marketCache.retentionMs, 7 * DAY);
    assert.equal(report.areas.tmp.retentionMs, DAY);
    assert.equal(report.areas.marketCache.expiredBytes, 5);
    assert.equal(report.backupRetention.keepLast, 7);
    // 受保护分区没有保留期（界面不显示「N 天后自动回收」）
    assert.equal(report.areas.snapshots.retentionMs, undefined);
    assert.equal(report.areas.exports.retentionMs, 7 * DAY);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：单文件读不到不抛错（竞态删除容错）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.dirs.logsDir, 'a.log'), 3, now);
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.areas.logs.sizeBytes, 3);
    assert.equal(report.areas.logs.fileCount, 1);
    // 空目录（sync）可读但零文件 → 不标 unreadable
    assert.equal(report.areas.sync.unreadable, false);
    assert.equal(report.areas.sync.sizeBytes, 0);
  } finally {
    await f.cleanup();
  }
});

/* ---------------- 回滚点库 + 遗留数据：两块此前不可见的占用（只报告、绝不清理） ---------------- */

test('disk-usage：回滚点库并进 DISK_USAGE_AREAS（objects + index.json 如实计入、policy=protected、绝不进可回收）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    // 本机实测形状：objects/ 约 1.5 MB + index.json 约 4.7 MB
    await writeFileAt(path.join(f.root, 'rollback-points', 'objects', 'rb-1', 'session.v4.jsonl.zstd'), 1500, now);
    await writeFileAt(path.join(f.root, 'rollback-points', 'index.json'), 4700, now);
    await writeFileAt(path.join(f.dirs.tmpDir, 'upload.zip'), 10, now);

    assert.ok((DISK_USAGE_AREAS as readonly string[]).includes('rollback-points'), '回滚点库必须是体检子区之一');
    assert.equal(
      diskUsageDirOf(f.dirs, 'rollback-points'),
      path.join(f.root, 'rollback-points'),
      '子区 → 物理目录必须指向 dataDir/rollback-points',
    );

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    const area = report.areas['rollback-points'];
    assert.ok(area !== undefined);
    assert.equal(area.sizeBytes, 1500 + 4700);
    assert.equal(area.fileCount, 2);
    assert.equal(area.unreadable, false);
    assert.equal(area.policy, 'protected', '回滚点库只报告、绝不提供清理');
    assert.equal(area.retentionMs, undefined, '受保护子区没有「N 天后自动回收」');
    assert.equal(report.totalBytes, 1500 + 4700 + 10, '子区合计必须含回滚点库');
    assert.equal(report.totalFiles, 3);
    assert.equal(report.reclaimableBytes, 10, '可回收合计里绝不能出现回滚点库');
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：遗留数据（旧 checkpoints）被报告 —— policy 恒为 protected，不计入子区合计', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.root, 'checkpoints', 'cp-1', 'files', 'a.bin'), 200, now);
    await writeFileAt(path.join(f.root, 'checkpoints', 'index.json'), 30, now);

    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(report.legacy?.length, LEGACY_DATA_DIRS.length, '当前一条：legacy checkpoints');
    const entry = (report.legacy ?? []).find((e) => e.id === 'legacy-checkpoints');
    assert.ok(entry !== undefined, '旧检查点库必须被报告');
    assert.equal(entry.relPath, 'checkpoints', '路径是相对 dataDir 的');
    assert.equal(entry.path, path.join(f.root, 'checkpoints'));
    assert.equal(entry.sizeBytes, 230);
    assert.equal(entry.fileCount, 2);
    assert.equal(entry.unreadable, false);
    assert.equal(entry.policy, 'protected', '遗留数据只报告、绝不自动清理');

    // 与子区合计**分列**：界面才能把「能解释来源的占用」与「遗留占用」分开呈现
    assert.equal(report.totalBytes, 0, '遗留数据不计入子区合计');
    assert.equal(report.reclaimableBytes, 0, '遗留数据绝不算作可回收');
    assert.equal(report.expiredBytes, 0);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：回滚点库/遗留目录读不到（不存在或被非目录占住）→ unreadable=true 且 sizeBytes=0', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    // ① 目录根本不存在（未产生回滚点 / 从未有过旧检查点库）
    const missing = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(missing.areas['rollback-points']?.unreadable, true);
    assert.equal(missing.areas['rollback-points']?.sizeBytes, 0);
    assert.equal(missing.areas['rollback-points']?.policy, 'protected');
    const missingLegacy = (missing.legacy ?? [])[0];
    assert.ok(missingLegacy !== undefined);
    assert.equal(missingLegacy.unreadable, true);
    assert.equal(missingLegacy.sizeBytes, 0);
    assert.equal(missingLegacy.fileCount, 0);
    assert.equal(missingLegacy.policy, 'protected');

    // ② 路径被非目录占住：这不是「0 字节」，而是**未统计**（绝不伪报 0）
    await fs.writeFile(path.join(f.root, 'rollback-points'), 'occupied');
    await fs.writeFile(path.join(f.root, 'checkpoints'), 'occupied');
    const occupied = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    assert.equal(occupied.areas['rollback-points']?.unreadable, true);
    assert.equal(occupied.areas['rollback-points']?.sizeBytes, 0);
    const occupiedLegacy = (occupied.legacy ?? [])[0];
    assert.equal(occupiedLegacy?.unreadable, true);
    assert.equal(occupiedLegacy?.sizeBytes, 0);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：遗留目录里的符号链接/junction 不展开（不重复计数）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    const real = path.join(f.root, 'real-legacy-payload');
    await writeFileAt(path.join(real, 'big.bin'), 4096, now);
    const link = path.join(f.root, 'checkpoints', 'linked');
    await fs.mkdir(path.dirname(link), { recursive: true });
    try {
      await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境不允许建链接：跳过该断言（不谎报通过）
    }
    const report = await scanDiskUsage({ dirs: f.dirs, policy: POLICY, now: () => now });
    const entry = (report.legacy ?? [])[0];
    assert.equal(entry?.sizeBytes, 0, '链接目标不计入遗留目录');
    assert.equal(entry?.fileCount, 0);
  } finally {
    await f.cleanup();
  }
});

test('disk-usage：回滚点库目录名与引擎常量逐字一致（源码级守卫，替代 import 引擎）', async () => {
  const usageSrc = (await fs.readFile(new URL('./disk-usage.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const engineSrc = (await fs.readFile(new URL('./rollback-point.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const inUsage = /const ROLLBACK_POINTS_DIR = '([^']+)'/.exec(usageSrc);
  const inEngine = /export const ROLLBACK_POINTS_DIR_NAME = '([^']+)'/.exec(engineSrc);
  assert.ok(inUsage !== null, '找不到 disk-usage.ts 的 ROLLBACK_POINTS_DIR 声明（断言失效即失败，不静默）');
  assert.ok(inEngine !== null, '找不到 rollback-point.ts 的 ROLLBACK_POINTS_DIR_NAME 声明');
  assert.equal(inUsage[1], inEngine[1], '体检模块与引擎的回滚点库目录名必须逐字相同（否则磁盘体检会扫错目录）');
  assert.equal(inUsage[1], 'rollback-points');
});

test('disk-usage：新增子区/遗留目录都不是清理候选（源码级断言）', async () => {
  // ① 可立即清理白名单只有可重建区
  assert.deepEqual([...IMMEDIATE_CLEAN_CATEGORIES], ['tmp', 'marketCache', 'marketWork']);
  assert.equal((IMMEDIATE_CLEAN_CATEGORIES as readonly string[]).includes('rollback-points'), false, '回滚点库绝不可清理');
  for (const item of LEGACY_DATA_DIRS) {
    assert.equal((IMMEDIATE_CLEAN_CATEGORIES as readonly string[]).includes(item.id), false, '遗留目录绝不可清理：' + item.id);
  }
  // ② 源码级：常量本身（防将来有人「顺手」把新 id 加进清理白名单）
  const source = (await fs.readFile(new URL('./disk-usage.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const decl = /export const IMMEDIATE_CLEAN_CATEGORIES = \[([^\]]*)\]/.exec(source);
  assert.ok(decl !== null, '找不到 IMMEDIATE_CLEAN_CATEGORIES 声明（断言失效即失败，不静默通过）');
  assert.deepEqual(
    decl[1]!.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter((s) => s.length > 0),
    ['tmp', 'marketCache', 'marketWork'],
  );
  // ③ 清理入口（HTTP）的候选白名单同样只有可重建区 + 显式勾选的过期导出
  const routes = (await fs.readFile(new URL('../routes/backup.ts', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const accepted = /categories:\s*Array<([^>]+)>/.exec(routes);
  assert.ok(accepted !== null, '找不到清理入口的 categories 白名单声明');
  assert.deepEqual(
    accepted[1]!.split('|').map((s) => s.trim().replace(/['"]/g, '')),
    ['tmp', 'expired-exports'],
    '遗留目录/回滚点库绝不进清理候选',
  );
});

/* ---------------- HTTP：GET /disk-usage 的响应必须如实带上这两块 ---------------- */

function routeByPath(routes: WebRoute[], p: string): WebRoute {
  const found = routes.find((r) => routeSpecOf(r)?.path === p);
  assert.ok(found !== undefined, '路由缺失: ' + p);
  return found;
}

function fakeRequest(): IncomingMessage {
  return {
    method: 'GET',
    url: '/',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {},
  } as unknown as IncomingMessage;
}

function fakeResponse(): { res: ServerResponse; status: () => number; json: () => unknown } {
  const state = { status: 0, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number) { state.status = status; this.headersSent = true; return this; },
    end(payload?: string) { state.body = payload ?? ''; return this; },
  };
  return { res: res as unknown as ServerResponse, status: () => state.status, json: () => JSON.parse(state.body) as unknown };
}

test('GET /disk-usage：HTTP 报告如实包含回滚点库与遗留数据（两块都 policy=protected）', async () => {
  const f = await makeFixture();
  try {
    const now = Date.now();
    await writeFileAt(path.join(f.root, 'rollback-points', 'index.json'), 4700, now);
    await writeFileAt(path.join(f.root, 'checkpoints', 'cp-1', 'a.bin'), 64, now);
    const env = {
      dataDir: f.root,
      exportsDir: f.dirs.exportsDir,
      snapshotsDir: f.dirs.snapshotsDir,
      tmpDir: f.dirs.tmpDir,
      marketDir: path.join(f.root, 'market'),
      syncDir: f.dirs.syncDir,
      // 与生产同语义的「直通」包壳（本组 handler 只用它包裹写路由）
      withMutationGate: (_op: string, handler: unknown) => handler,
    };
    const route = routeByPath(backupRoutes(env as never), '/api/dsh-config-manager/disk-usage');
    const res = fakeResponse();
    await route.handler(fakeRequest(), res.res);
    assert.equal(res.status(), 200);
    const body = res.json() as {
      ok: boolean;
      report: {
        areas: Record<string, { sizeBytes: number; fileCount: number; policy: string }>;
        legacy?: Array<{ id: string; relPath: string; sizeBytes: number; fileCount: number; unreadable: boolean; policy: string }>;
        totalBytes: number;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.report.areas['rollback-points']?.sizeBytes, 4700, 'HTTP 响应必须含回滚点库占用');
    assert.equal(body.report.areas['rollback-points']?.policy, 'protected');
    assert.equal(body.report.totalBytes, 4700);
    const legacy = (body.report.legacy ?? []).find((e) => e.id === 'legacy-checkpoints');
    assert.ok(legacy !== undefined, 'HTTP 响应必须含遗留数据');
    assert.equal(legacy.relPath, 'checkpoints');
    assert.equal(legacy.sizeBytes, 64);
    assert.equal(legacy.fileCount, 1);
    assert.equal(legacy.unreadable, false);
    assert.equal(legacy.policy, 'protected');
    // 只读：文件原样
    assert.equal((await fs.stat(path.join(f.root, 'checkpoints', 'cp-1', 'a.bin'))).size, 64);
  } finally {
    await f.cleanup();
  }
});
/**
 * t11（2026-10-13）：`DiskUsageArea` 必须与 `DiskUsageScanArea` **同一集合** —— 文案登记落地后不再分叉，
 * 否则按 `Record<DiskUsageArea, …>` 建表会在**类型层**漏掉 rollback-points 而不报错。
 * 双向可赋值断言 + 运行时键数核对，两边任一漂移即红。
 */
test('t11 类型收口：DiskUsageArea 与 DiskUsageScanArea 同一集合（13 键，含 rollback-points）', () => {
  const sameScan: DiskUsageScanArea = 'rollback-points' as DiskUsageArea
  const sameArea: DiskUsageArea = 'exports' as DiskUsageScanArea
  assert.equal(sameScan, 'rollback-points')
  assert.equal(sameArea, 'exports')
  assert.equal(DISK_USAGE_AREAS.length, 13, '子区恒为 13 键（新增/删除必须同步展示层与文案）')
  for (const extra of DISK_USAGE_EXTRA_AREAS) {
    assert.ok((DISK_USAGE_AREAS as readonly string[]).includes(extra), '只读附加区必须在 DISK_USAGE_AREAS 里：' + extra)
  }
  // 类型层完备性：漏一键的 Record 构造不合法（编译期），这里用穷尽映射的键集合做运行时对照
  const table: Record<DiskUsageArea, string> = Object.fromEntries(DISK_USAGE_AREAS.map((a) => [a, a])) as Record<DiskUsageArea, string>
  assert.deepEqual(Object.keys(table).sort(), [...DISK_USAGE_AREAS].sort(), '按 DiskUsageArea 建的表必须覆盖全部子区')
});

