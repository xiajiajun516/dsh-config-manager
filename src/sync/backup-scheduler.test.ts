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
import { backupIntervalToMs, defaultBackupSchedule, readBackupSchedule, writeBackupSchedule } from './backup-schedule-config.ts';
import type { BackupScheduleConfig } from './backup-schedule-config.ts';
import { shouldTriggerStartupRun } from './autosync-scheduler.ts';
import { RunRegistry } from '../core/run-registry.ts';
import { nullLogger } from '../utils/logger.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import { createAdapters } from '../adapters/index.ts';
import { zhMsg } from '../core/messages.ts';

const NS = ['general', 'theme'];

function seedSettings(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] });
}

/** 构造一个可控 scheduler：注入全部 fs/engine 依赖，验证 runOnce 行为。 */
function makeScheduler(opts: {
  cfg: BackupScheduleConfig;
  tmp: string;
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
  });
  return { scheduler, runs, getConfig: () => config };
}

test('backupIntervalToMs: 间隔换算正确', () => {
  assert.equal(backupIntervalToMs('6h'), 6 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('12h'), 12 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('24h'), 24 * 60 * 60 * 1000);
  assert.equal(backupIntervalToMs('7d'), 7 * 24 * 60 * 60 * 1000);
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
