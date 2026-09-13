/**
 * BackupScheduler 测试：interval 换算、阈值判断、enabled=false 跳过、
 * runOnce 成功产出真实 ZIP、连续失败计数、防重跳过。
 *
 * 采用真实 RunRegistry + 注入 readConfig/writeConfig/now/计时器，
 * 全程不触碰真实定时器；导出用真实 tmp 目录 + makeContext 内存宿主。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BackupScheduler } from './backup-scheduler.ts';
import { BACKUP_SCHEDULE_SCHEMA_VERSION, backupIntervalToMs, defaultBackupSchedule, nextBackupDelayMs, parseWeeklySchedule, readBackupSchedule, writeBackupSchedule } from './backup-schedule-config.ts';
import type { BackupScheduleConfig } from './backup-schedule-config.ts';
import { shouldTriggerStartupRun } from './autosync-scheduler.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import { createAdapters } from '../adapters/index.ts';
import { zhMsg } from '../core/messages.ts';
import { Exporter } from '../core/exporter.ts';
import { createSecretScanner } from '../security/secret-scanner.ts';
import type { SecretScanner } from '../core/types.ts';

const NS = ['general', 'theme'];

function seedSettings(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
}

/** 构造一个可控 scheduler：注入全部 fs/engine 依赖，验证 runOnce 行为。 */
function makeScheduler(opts: {
  cfg: BackupScheduleConfig;
  tmp: string;
  /** M1：可选注入强化 secret 扫描器（含 scanText）——验证定时备份文件类分区凭据告警 */
  scanner?: SecretScanner;
}) {
  const runs = new RunRegistry();
  let config = opts.cfg;
  const ctx = makeContext('win32', path.join(opts.tmp, 'home'));
  seedSettings(ctx);
  const adapters = createAdapters({ namespaces: NS });
  const scheduler = new BackupScheduler({
    syncDir: path.join(opts.tmp, 'sync'),
    exportsDir: path.join(opts.tmp, 'exports'),
    host: ctx,
    adapters,
    runs,
    msg: zhMsg,
    exporterVersion: '0.1.45',
    now: () => new Date(1_000_000_000_000),
    readConfig: async () => config,
    writeConfig: async (c) => { config = c; },
    log: nullLogger(),
    // 测试不用真实定时器：不调 start()
    // M1：缺省不传 scanner（保持旧行为：Exporter 落回 defaultSecretScanner，无 scanText）
    ...(opts.scanner === undefined ? {} : { scanner: opts.scanner }),
  });
  return { scheduler, runs, ctx, getConfig: () => config };
}

test('backupIntervalToMs: 间隔换算正确', () => {
  assert.equal(backupIntervalToMs('6h'), 6 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('12h'), 12 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('24h'), 24 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.ok(Number.isNaN(backupIntervalToMs('custom')), 'custom 无固定周期 → NaN');
});

test('parseWeeklySchedule: 合法/非法值域校验（P0-⑤）', () => {
  assert.deepEqual(parseWeeklySchedule({ dayOfWeek: 1, hour: 3, minute: 30 }), { dayOfWeek: 1, hour: 3, minute: 30 });
  assert.equal(parseWeeklySchedule({ dayOfWeek: 7, hour: 3, minute: 30 }), null);
  assert.equal(parseWeeklySchedule({ dayOfWeek: 1, hour: 24, minute: 0 }), null);
  assert.equal(parseWeeklySchedule({ dayOfWeek: 1, hour: 3, minute: 60 }), null);
  assert.equal(parseWeeklySchedule(null), null);
  assert.equal(parseWeeklySchedule('x'), null);
});

test('nextBackupDelayMs: 固定间隔档返回 interval ms（P0-⑤）', () => {
  const now = new Date(1_000_000_000_000);
  assert.equal(nextBackupDelayMs({ interval: '24h' }, now), 24 * 60 * 60 * 1000);
  assert.equal(nextBackupDelayMs({ interval: '7d' }, now), 7 * 24 * 60 * 60 * 1000);
});

test('nextBackupDelayMs: custom 档对齐下一个每周时刻（P0-⑤）', () => {
  // 2026-08-24 是周一 → 选周五(5) 03:30，应到本周五
  const monday = new Date(2026, 7, 24, 10, 0, 0, 0); // 2026-08-24 10:00 周一
  const cfg = { interval: 'custom' as const, customSchedule: { dayOfWeek: 5, hour: 3, minute: 30 } };
  const delay = nextBackupDelayMs(cfg, monday)!;
  const target = new Date(monday.getTime() + delay);
  assert.equal(target.getDay(), 5, '目标是周五');
  assert.equal(target.getHours(), 3);
  assert.equal(target.getMinutes(), 30);
  assert.ok(delay > 0 && delay < 7 * 24 * 60 * 60 * 1000);

  // 同样是周五、但已过 03:30（周五 10:00 排期）→ 排到下周周五
  const fridayLate = new Date(2026, 7, 28, 10, 0, 0, 0); // 2026-08-28 周五 10:00
  const delay2 = nextBackupDelayMs(cfg, fridayLate)!;
  const target2 = new Date(fridayLate.getTime() + delay2);
  assert.equal(target2.getDay(), 5);
  assert.ok(delay2 > 6 * 24 * 60 * 60 * 1000, '已过同刻 → 下周（略小于整周）');

  // 当天未过同刻（周五 02:00 排 03:30）→ 今天同刻
  const fridayEarly = new Date(2026, 7, 28, 2, 0, 0, 0);
  const delay3 = nextBackupDelayMs(cfg, fridayEarly)!;
  const target3 = new Date(fridayEarly.getTime() + delay3);
  assert.equal(target3.getDay(), 5);
  assert.equal(target3.getHours(), 3);
  assert.ok(delay3 > 0 && delay3 < 2 * 60 * 60 * 1000, '同天未过 → 几小时内');
});

test('nextBackupDelayMs: custom 档缺 customSchedule → null（不排期）', () => {
  assert.equal(nextBackupDelayMs({ interval: 'custom' }, new Date()), null);
  assert.equal(nextBackupDelayMs({ interval: 'custom', customSchedule: undefined }, new Date()), null);
});

test('shouldTriggerStartupRun: 阈值判断（复用 autosync 实现）', () => {
  const threshold = 60 * 60 * 1000;
  const now = 1_000_000_000_000;
  assert.equal(shouldTriggerStartupRun(new Date(now - 60 * 1000).toISOString(), threshold, now), false);
  assert.equal(shouldTriggerStartupRun(new Date(now - 61 * 60 * 1000).toISOString(), threshold, now), true);
  assert.equal(shouldTriggerStartupRun(undefined, threshold, now), true);
});

test('runOnce: enabled=false → skipped(disabled)，不写配置', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: false, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const { scheduler, getConfig } = makeScheduler({ cfg, tmp });
    const result = await scheduler.runOnce();
    assert.equal(result.status, 'skipped');
    assert.equal(result.skipReason, 'disabled');
    assert.equal(getConfig().consecutiveFailures, 0, 'disabled 不写状态');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOnce: 成功 → 产出真实 ZIP 到 exports，写成功状态，连续失败清零', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 3 };
    const { scheduler, getConfig } = makeScheduler({ cfg, tmp });
    const result = await scheduler.runOnce();
    assert.equal(result.status, 'success');
    assert.ok(result.zip !== undefined && result.zip!.startsWith('dsh-config-auto-') && result.zip!.endsWith('.zip'), 'ZIP 文件名带 auto 前缀（定时备份产物标识）');
    assert.ok(result.sections !== undefined && result.sections.includes('settings'), 'settings 分区进入备份');
    // ZIP 确实落盘
    const stat = await fs.stat(path.join(tmp, 'exports', result.zip!));
    assert.ok(stat.size > 0);
    // 配置状态：成功 + 连续失败清零 + lastRunAt 写入
    const saved = getConfig();
    assert.equal(saved.lastRunStatus, 'success');
    assert.equal(saved.consecutiveFailures, 0);
    assert.ok(saved.lastRunAt !== undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOnce: 导出失败 → failed + 连续失败 +1', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    // 用一个无法写出的 exportsDir（只读父目录不可行 → 用文件占用路径模拟写失败）
    const ctx = makeContext('win32', path.join(tmp, 'home'));
    seedSettings(ctx);
    const adapters = createAdapters({ namespaces: NS });
    const runs = new RunRegistry();
    let config = cfg;
    // exportsDir 指向一个「已存在的文件路径」→ mkdir 抛 EEXIST → 导出失败
    const exportsDir = path.join(tmp, 'blocked-exports');
    await fs.writeFile(exportsDir, 'blocked');
    const scheduler = new BackupScheduler({
      syncDir: path.join(tmp, 'sync'),
      exportsDir,
      host: ctx,
      adapters,
      runs,
      msg: zhMsg,
      exporterVersion: '0.1.45',
      now: () => new Date(1_000_000_000_000),
      readConfig: async () => config,
      writeConfig: async (c) => { config = c; },
      log: nullLogger(),
    });
    const result = await scheduler.runOnce();
    assert.equal(result.status, 'failed');
    assert.ok(result.error !== undefined && result.error !== '');
    assert.equal(config.consecutiveFailures, 1, '连续失败 +1');
    assert.equal(config.lastRunStatus, 'failed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOnce: 并发防重 → running 中第二次调用 skipped(running)', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const { scheduler } = makeScheduler({ cfg, tmp });
    // 同时触发两次：第一次进入 running，第二次立即被防重拦截
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, ['skipped', 'success'], '一个成功、一个被防重跳过');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOnce: 成功后按保留策略清理旧 auto 备份（只留最近 10 个，手动导出不动）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    // 预置 12 个旧的定时备份 ZIP（mtime 递增，最旧在前）+ 1 个手动导出 ZIP
    const exportsDir = path.join(tmp, 'exports');
    await fs.mkdir(exportsDir, { recursive: true });
    const oldNames: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `dsh-config-auto-20260801-0000${String(i).padStart(2, '0')}-abc.zip`;
      oldNames.push(name);
      const p = path.join(exportsDir, name);
      await fs.writeFile(p, `old-${i}`);
      await fs.utimes(p, new Date(1_000_000_000_000 + i * 1000), new Date(1_000_000_000_000 + i * 1000));
    }
    await fs.writeFile(path.join(exportsDir, 'dsh-config-manual.zip'), 'manual');

    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const { scheduler } = makeScheduler({ cfg, tmp });
    const result = await scheduler.runOnce();
    assert.equal(result.status, 'success');

    // 12 旧 + 1 新 = 13 auto → 保留 10，删最旧的 3 个
    const remaining = await fs.readdir(exportsDir);
    const autoLeft = remaining.filter((n) => n.startsWith('dsh-config-auto-'));
    assert.equal(autoLeft.length, 10, '只保留最近 10 个定时备份');
    assert.ok(!remaining.includes(oldNames[0]!), '最旧的已删');
    assert.ok(!remaining.includes(oldNames[1]!), '第二旧的已删');
    assert.ok(!remaining.includes(oldNames[2]!), '第三旧的已删');
    assert.ok(remaining.includes(oldNames[3]!), '保留线（第 4 旧）保留');
    assert.ok(remaining.includes(oldNames[11]!), '最新的旧文件保留');
    assert.ok(remaining.includes('dsh-config-manual.zip'), '手动导出文件不被保留策略清理');
    const fresh = autoLeft.find((n) => !oldNames.includes(n));
    assert.ok(fresh !== undefined, '本次新产出的备份保留在列表中');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOnce: 自定义 retention 生效（keep=2 → 只留最近 2 个）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const exportsDir = path.join(tmp, 'exports');
    await fs.mkdir(exportsDir, { recursive: true });
    const oldNames: string[] = [];
    for (let i = 0; i < 3; i++) {
      const name = `dsh-config-auto-20260801-0000${String(i).padStart(2, '0')}-abc.zip`;
      oldNames.push(name);
      const p = path.join(exportsDir, name);
      await fs.writeFile(p, `old-${i}`);
      await fs.utimes(p, new Date(1_000_000_000_000 + i * 1000), new Date(1_000_000_000_000 + i * 1000));
    }
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const runs = new RunRegistry();
    let config = cfg;
    const ctx = makeContext('win32', path.join(tmp, 'home'));
    seedSettings(ctx);
    const adapters = createAdapters({ namespaces: NS });
    const scheduler = new BackupScheduler({
      syncDir: path.join(tmp, 'sync'),
      exportsDir,
      host: ctx,
      adapters,
      runs,
      msg: zhMsg,
      exporterVersion: '0.1.45',
      now: () => new Date(1_000_000_000_000),
      readConfig: async () => config,
      writeConfig: async (c) => { config = c; },
      log: nullLogger(),
      retention: 2,
    });
    const result = await scheduler.runOnce();
    assert.equal(result.status, 'success');
    // 3 旧 + 1 新 = 4 auto → keep=2 → 删最旧的 2 个
    const remaining = await fs.readdir(exportsDir);
    const autoLeft = remaining.filter((n) => n.startsWith('dsh-config-auto-'));
    assert.equal(autoLeft.length, 2, '自定义 retention=2 只留最近 2 个');
    assert.ok(!remaining.includes(oldNames[0]!), '最旧已删');
    assert.ok(!remaining.includes(oldNames[1]!), '第二旧已删');
    assert.ok(remaining.includes(oldNames[2]!), '第三旧（保留线）保留');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('配置持久化: 写入再读取往返 + 损坏回退缺省', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const syncDir = path.join(tmp, 'sync');
    const cfg: BackupScheduleConfig = {
      enabled: true, interval: '12h', startupMinIntervalMs: 3600000, consecutiveFailures: 2,
      lastRunAt: '2026-08-16T12:00:00.000Z', lastRunStatus: 'failed', lastRunMessage: 'boom',
    };
    await writeBackupSchedule(syncDir, cfg);
    const loaded = await readBackupSchedule(syncDir);
    assert.equal(loaded.enabled, true);
    assert.equal(loaded.interval, '12h');
    assert.equal(loaded.consecutiveFailures, 2);
    assert.equal(loaded.lastRunStatus, 'failed');
    assert.equal(loaded.lastRunMessage, 'boom');
    // 损坏文件 → 缺省
    await fs.writeFile(path.join(syncDir, 'backup-schedule.json'), '{ not json');
    const fallback = await readBackupSchedule(syncDir);
    assert.deepEqual(fallback, defaultBackupSchedule());
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- m-retention：持久化契约（captain review 要求的三问） ---------------- */

/** RP-CFG-01：retention **仅在非缺省时**写入文件（老/新代码互读无 diff 噪音） */
test('m-retention 持久化: 缺省策略不写入文件（避免无意义字段与 diff 噪音）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-retention-cfg-'));
  try {
    const syncDir = path.join(tmp, 'sync');
    const file = path.join(syncDir, 'backup-schedule.json');
    // 1) 缺省策略（等价旧行为）→ 文件中**不应**出现 retention 键
    await writeBackupSchedule(syncDir, {
      enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0,
      retention: { keepLast: 10, keepMonthly: 0, keepYearly: 0 },
    });
    const rawDefault = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal('retention' in rawDefault, false, '缺省策略不写入 retention 键');

    // 2) 非缺省策略 → 写入
    await writeBackupSchedule(syncDir, {
      enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0,
      retention: { keepLast: 5, keepMonthly: 6, keepYearly: 0 },
    });
    const rawTiered = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(rawTiered['retention'], { keepLast: 5, keepMonthly: 6, keepYearly: 0 }, '非缺省策略写入');
    const loadedTiered = await readBackupSchedule(syncDir);
    assert.deepEqual(loadedTiered.retention, { keepLast: 5, keepMonthly: 6, keepYearly: 0 }, '写入后读回一致');

    // 3) 回退到缺省 → 键消失，读回缺省（= 用户可真正「重置」策略）
    await writeBackupSchedule(syncDir, {
      enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0,
      retention: { keepLast: 10, keepMonthly: 0, keepYearly: 0 },
    });
    const rawReset = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal('retention' in rawReset, false, '回退缺省后键消失（writeBackupSchedule 是全量覆盖写）');
    const loadedReset = await readBackupSchedule(syncDir);
    assert.deepEqual(loadedReset.retention, { keepLast: 10, keepMonthly: 0, keepYearly: 0 }, '读回缺省策略');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** RP-CFG-02：schemaVersion 恒为 1（升版本会让线上用户配置整体回退缺省） */
test('m-retention 持久化: schemaVersion 保持 1（不升版本，避免已存在用户配置失效）', async () => {
  assert.equal(BACKUP_SCHEDULE_SCHEMA_VERSION, 1, 'schemaVersion 常量必须仍为 1');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-retention-schema-'));
  try {
    const syncDir = path.join(tmp, 'sync');
    const file = path.join(syncDir, 'backup-schedule.json');
    await writeBackupSchedule(syncDir, {
      enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0,
      retention: { keepLast: 3, keepMonthly: 2, keepYearly: 1 },
    });
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    assert.equal(raw['schemaVersion'], 1, '写出的文件 schemaVersion 必须是 1');
    // 老文件（无 retention、schemaVersion=1）→ 正常读，retention 取缺省
    await fs.writeFile(file, JSON.stringify({
      schemaVersion: 1, enabled: true, interval: '7d', startupMinIntervalMs: 1000, consecutiveFailures: 0,
    }), 'utf8');
    const legacy = await readBackupSchedule(syncDir);
    assert.equal(legacy.enabled, true, '老文件 enabled 保留（不因新字段缺失而回退）');
    assert.equal(legacy.interval, '7d', '老文件 interval 保留');
    assert.deepEqual(legacy.retention, { keepLast: 10, keepMonthly: 0, keepYearly: 0 }, '老文件 retention 取缺省');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** RP-CFG-03：文件中 retention 非法 → **静默回退缺省，且不影响同级字段**（宽容解析契约） */
test('m-retention 持久化: 非法 retention 静默回退缺省，其它字段不受影响（不整体回退）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-retention-illegal-'));
  try {
    const syncDir = path.join(tmp, 'sync');
    const file = path.join(syncDir, 'backup-schedule.json');
    await fs.mkdir(syncDir, { recursive: true }); // 直写文件需先建目录（不经 writeBackupSchedule）
    const illegalCases: unknown[] = [
      { keepLast: -5, keepMonthly: 0, keepYearly: 0 },      // 负数
      { keepLast: 1.5, keepMonthly: 0, keepYearly: 0 },     // 小数
      { keepLast: 1, keepMonthly: 'x', keepYearly: 0 },     // 类型错
      { keepLast: 1, keepMonthly: 0, keepYearly: 99999 },   // 越界
      { keepLast: 1, keepMonthly: 0 },                      // 缺字段
      'not-an-object',
      null,
      [1, 2, 3],
    ];
    for (const retention of illegalCases) {
      await fs.writeFile(file, JSON.stringify({
        schemaVersion: 1, enabled: true, interval: '6h', startupMinIntervalMs: 123456, consecutiveFailures: 3,
        lastRunAt: '2026-01-01T00:00:00.000Z', lastRunStatus: 'success', lastRunMessage: 'ok',
        retention,
      }), 'utf8');
      const cfg = await readBackupSchedule(syncDir);
      const label = JSON.stringify(retention);
      // 1) 策略回退缺省（静默，不抛错）
      assert.deepEqual(cfg.retention, { keepLast: 10, keepMonthly: 0, keepYearly: 0 }, `非法 ${label} → 缺省策略`);
      // 2) 同级字段必须全部保留（否则改坏一个字段会停掉定时备份）
      assert.equal(cfg.enabled, true, `非法 ${label} 不得影响 enabled`);
      assert.equal(cfg.interval, '6h', `非法 ${label} 不得影响 interval`);
      assert.equal(cfg.startupMinIntervalMs, 123456, `非法 ${label} 不得影响 startupMinIntervalMs`);
      assert.equal(cfg.consecutiveFailures, 3, `非法 ${label} 不得影响 consecutiveFailures`);
      assert.equal(cfg.lastRunStatus, 'success', `非法 ${label} 不得影响 lastRunStatus`);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- M1（G-09 接线）：定时备份必须与手动导出共用同一 scanner ---------------- */

type ExportReportShape = Awaited<ReturnType<typeof Exporter.prototype.export>>['report'];

/** 捕获定时备份内部真实 Exporter 产出的报告（monkey-patch 原型，测试结束还原；不改生产代码）。
 *  先例：tests/cli/backup-verify.test.ts 用同法 patch ZipArchive.prototype.readEntry。
 *  这样断言的 report 就是 scheduler 自己那次导出的报告，能证明 scanner 真的被接上并生效。 */
async function runOnceCapturingReport(
  scheduler: BackupScheduler,
): Promise<{ result: Awaited<ReturnType<BackupScheduler['runOnce']>>; report: ExportReportShape }> {
  const original = Exporter.prototype.export;
  let captured: ExportReportShape | undefined;
  Exporter.prototype.export = (async function (this: Exporter, options: Parameters<typeof original>[0]) {
    const out = await original.call(this, options);
    captured = out.report;
    return out;
  }) as typeof original;
  try {
    const result = await scheduler.runOnce();
    const report = captured;
    assert.ok(report !== undefined, '定时备份必须真实调用 Exporter.export');
    return { result, report };
  } finally {
    Exporter.prototype.export = original;
  }
}

/** M1 行为：注入含 scanText 的 scanner（与 HTTP 路由 / config_backup 同档位）→ 文件类分区告警 + 计入 redactedHits */
test('M1 定时备份：注入含 scanText 的 scanner → 文件类分区凭据告警 + redactedHits 增加', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const { scheduler, ctx } = makeScheduler({ cfg, tmp, scanner: createSecretScanner() });
    // 技能文件（文件类分区）里的明文凭据：手动导出会报，定时备份必须同样报
    await ctx.fs.writeFile('skills/deploy.md', Buffer.from('# Deploy skill\napiKey: "sk-live-sched-9f3a2b1c"\n', 'utf8'));

    const { result, report } = await runOnceCapturingReport(scheduler);
    assert.equal(result.status, 'success');
    assert.ok(result.sections !== undefined && result.sections.includes('skills'), 'skills 分区进入定时备份');
    assert.ok(
      report.warnings.some((w) => w.includes('skills') && w.includes('疑似凭据')),
      `注入 scanner 后文件类分区必须告警（export.fileSectionSecrets），实际 warnings=${JSON.stringify(report.warnings)}`,
    );
    assert.ok(
      report.security.redactedHits >= 1,
      `文件类分区命中应计入 redactedHits，实际 ${report.security.redactedHits}`,
    );
    assert.ok(!JSON.stringify(report.warnings).includes('sk-live-sched-9f3a2b1c'), '告警不回显凭据值本身');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** M1 行为（向后兼容）：未注入 scanner → Exporter 落回 defaultSecretScanner()（无 scanText）→ 文件类分区零告警 */
test('M1 定时备份：未注入 scanner → 文件类分区零告警、零命中（旧行为）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-backup-sched-'));
  try {
    const cfg: BackupScheduleConfig = { enabled: true, interval: '24h', startupMinIntervalMs: 3600000, consecutiveFailures: 0 };
    const { scheduler, ctx } = makeScheduler({ cfg, tmp }); // 不传 scanner
    await ctx.fs.writeFile('skills/plain.md', Buffer.from('apiKey: "sk-live-sched-noscan-7c1d"\n', 'utf8'));

    const { result, report } = await runOnceCapturingReport(scheduler);
    assert.equal(result.status, 'success');
    assert.equal(report.security.redactedHits, 0, '缺省扫描器无 scanText → 文件类分区不计命中（旧行为）');
    assert.ok(!report.warnings.some((w) => w.includes('疑似凭据')), '未注入 scanner 时文件类分区不告警（旧行为）');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/** M1 源码守卫：index.ts 把**同一个** scanner 实例注入三条导出路径，且只构造一次（防档位漂移） */
test('M1 源码守卫：index.ts 给 BackupScheduler 注入与 makeRoutes/registerModelTools 同一个 scanner 实例', async () => {
  const source = await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8');

  // 1) 单一实例来源：createConfiguredSecretScanner 在 index.ts 里只构造一次
  const ctorCall = 'createConfiguredSecretScanner(config?.personalPatterns)';
  const ctorCount = source.split(ctorCall).length - 1;
  assert.equal(ctorCount, 1, `scanner 必须只构造一次（单一实例来源），实际 ${ctorCount} 次`);

  // 2) 捕获该实例的标识符
  const decl = source.match(/const ([A-Za-z_$][\w$]*) = createConfiguredSecretScanner\(/);
  assert.ok(decl !== null, '应能找到 scanner 实例构造（const <name> = createConfiguredSecretScanner(...)）');
  const name = decl[1]!;

  // 3) TDZ 守卫：声明必须早于 BackupScheduler 构造（对象字面量中的 scanner 为即时求值）
  const declIndex = source.indexOf(`const ${name} = createConfiguredSecretScanner(`);
  const schedulerStart = source.indexOf('new BackupScheduler({');
  assert.ok(schedulerStart > 0, '应能找到 new BackupScheduler({');
  assert.ok(
    declIndex > 0 && declIndex < schedulerStart,
    `scanner 声明必须早于 BackupScheduler 构造（否则 TDZ ReferenceError），decl=${declIndex} ctor=${schedulerStart}`,
  );

  // 4) 定时备份实参含同一实例
  const schedulerEnd = source.indexOf('\r\n  })', schedulerStart);
  assert.ok(schedulerEnd > schedulerStart, '应能找到 BackupScheduler 调用结尾');
  const schedulerBody = source.slice(schedulerStart, schedulerEnd);
  assert.ok(
    schedulerBody.includes(`scanner: ${name},`),
    `BackupScheduler 必须注入同一个 scanner 实例（scanner: ${name},）`,
  );

  // 5) 另两条路径仍用同一标识符（三路一致，防将来各造实例）
  const routesStart = source.indexOf('makeRoutes({');
  const routesBody = source.slice(routesStart, source.indexOf('\r\n  })', routesStart));
  assert.ok(routesBody.includes(`scanner: ${name},`), `makeRoutes 必须注入同一 scanner（scanner: ${name},）`);
  const toolsStart = source.indexOf('registerModelTools(ctx, {');
  const toolsBody = source.slice(toolsStart, source.indexOf('\r\n  })', toolsStart));
  assert.ok(toolsBody.includes(`scanner: ${name},`), `registerModelTools 必须注入同一 scanner（scanner: ${name},）`);
});
