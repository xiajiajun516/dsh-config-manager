/**
 * autosync-config 测试：sync-autosync.json 读写往返、缺省值、损坏 JSON 回退缺省、
 * 按通道独立（git/webdav 互不干扰）、v1（顶层单通道）迁移为 git、原子写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readAutosyncConfig, writeAutosyncConfig, readAllAutosyncConfigs, AUTOSYNC_CONFIG_FILE,
  AUTOSYNC_CONFIG_SCHEMA_VERSION, DEFAULT_AUTOSYNC_INTERVAL,
  DEFAULT_STARTUP_MIN_INTERVAL_MS, lastRunFailureMessage, clearLastRunResult, shouldRunOnEnable,
} from './autosync-config.ts';

test('writeAutosyncConfig + readAutosyncConfig：写入 → 读回字段一致（git 通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-rt-'));
  try {
    await writeAutosyncConfig(dir, 'git', {
      enabled: true,
      interval: '15m',
      startupMinIntervalMs: 300000,
      consecutiveFailures: 2,
      lastRunAt: '2026-08-16T12:00:00.000Z',
      lastRunStatus: 'skipped',
      lastRunMessage: '有冲突项，跳过',
      lastRunHistoryId: 'hist-1',
    });
    const cfg = await readAutosyncConfig(dir, 'git');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.interval, '15m');
    assert.equal(cfg.startupMinIntervalMs, 300000);
    assert.equal(cfg.consecutiveFailures, 2);
    assert.equal(cfg.lastRunAt, '2026-08-16T12:00:00.000Z');
    assert.equal(cfg.lastRunStatus, 'skipped');
    assert.equal(cfg.lastRunMessage, '有冲突项，跳过');
    assert.equal(cfg.lastRunHistoryId, 'hist-1');
    // 原始文件校验（v2 按通道）
    const raw = JSON.parse(await fs.readFile(path.join(dir, AUTOSYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, AUTOSYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.channels.git.enabled, true);
    assert.equal(raw.channels.git.interval, '15m');
    assert.equal(raw.channels.webdav.enabled, false, '未配置的 webdav 通道落盘为缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readAutosyncConfig：文件不存在 → 返回缺省值（两个通道都缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-default-'));
  try {
    const cfg = await readAutosyncConfig(dir, 'git');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.interval, DEFAULT_AUTOSYNC_INTERVAL);
    assert.equal(cfg.startupMinIntervalMs, DEFAULT_STARTUP_MIN_INTERVAL_MS);
    assert.equal(cfg.consecutiveFailures, 0);
    assert.equal(cfg.lastRunAt, undefined);
    assert.equal(cfg.lastRunStatus, undefined);
    const webdav = await readAutosyncConfig(dir, 'webdav');
    assert.equal(webdav.enabled, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readAutosyncConfig：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, AUTOSYNC_CONFIG_FILE), '{not-json', 'utf8');
    const cfg = await readAutosyncConfig(dir, 'git');
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.interval, DEFAULT_AUTOSYNC_INTERVAL);
    assert.equal(cfg.startupMinIntervalMs, DEFAULT_STARTUP_MIN_INTERVAL_MS);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readAutosyncConfig：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-badver-'));
  try {
    await fs.writeFile(path.join(dir, AUTOSYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 99, enabled: true }), 'utf8');
    const cfg = await readAutosyncConfig(dir, 'git');
    assert.equal(cfg.enabled, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeAutosyncConfig：原子写（自动创建目录）', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-mkdir-'));
  try {
    const dir = path.join(base, 'nested', 'sync');
    await writeAutosyncConfig(dir, 'git', { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 });
    const cfg = await readAutosyncConfig(dir, 'git');
    assert.ok(cfg);
    assert.equal(cfg.enabled, true);
    // 确认没有残留临时文件
    const files = await fs.readdir(dir);
    assert.ok(files.length >= 1, '应有配置文件');
    assert.ok(!files.some((f) => f.includes('.tmp')), '不应残留 .tmp 临时文件');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('按通道独立：写 webdav 不影响 git，反之亦然', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-perchannel-'));
  try {
    await writeAutosyncConfig(dir, 'git', { enabled: true, interval: '5m', startupMinIntervalMs: 300000, consecutiveFailures: 0 });
    await writeAutosyncConfig(dir, 'webdav', { enabled: true, interval: '24h', startupMinIntervalMs: 300000, consecutiveFailures: 3, lastRunAt: '2026-08-16T12:00:00.000Z', lastRunStatus: 'failed' });
    // git 通道保持首次写入的值
    const git = await readAutosyncConfig(dir, 'git');
    assert.equal(git.enabled, true);
    assert.equal(git.interval, '5m');
    assert.equal(git.consecutiveFailures, 0);
    // webdav 通道独立
    const webdav = await readAutosyncConfig(dir, 'webdav');
    assert.equal(webdav.enabled, true);
    assert.equal(webdav.interval, '24h');
    assert.equal(webdav.consecutiveFailures, 3);
    assert.equal(webdav.lastRunStatus, 'failed');
    // 全量读取视图
    const all = await readAllAutosyncConfigs(dir);
    assert.equal(all.git.interval, '5m');
    assert.equal(all.webdav.interval, '24h');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('v1 迁移：顶层单通道字段 → git 通道（webdav 缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-v1-'));
  try {
    await fs.writeFile(
      path.join(dir, AUTOSYNC_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, enabled: true, interval: '60m', consecutiveFailures: 1, lastRunAt: '2026-08-15T08:00:00.000Z' }),
      'utf8',
    );
    const git = await readAutosyncConfig(dir, 'git');
    assert.equal(git.enabled, true, 'v1 enabled 迁移到 git 通道');
    assert.equal(git.interval, '60m');
    assert.equal(git.consecutiveFailures, 1);
    assert.equal(git.lastRunAt, '2026-08-15T08:00:00.000Z');
    const webdav = await readAutosyncConfig(dir, 'webdav');
    assert.equal(webdav.enabled, false, 'webdav 通道回退缺省');
    // 缺 schemaVersion 的旧文件同样视为 v1
    await fs.writeFile(
      path.join(dir, AUTOSYNC_CONFIG_FILE),
      JSON.stringify({ enabled: true, interval: '12h' }),
      'utf8',
    );
    const git2 = await readAutosyncConfig(dir, 'git');
    assert.equal(git2.enabled, true);
    assert.equal(git2.interval, '12h');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
/* ------------------------------------------------- issue #105：旧运行结果不得被当成结论 */

test('lastRunFailureMessage：只有 failed 才回传错误原文（issue #105）', () => {
  // failed + 有原文 → 原样回传
  assert.equal(
    lastRunFailureMessage({ lastRunStatus: 'failed', lastRunMessage: 'git pull 失败: 认证失败' }),
    'git pull 失败: 认证失败',
  );
  // 其余状态一律 undefined —— 这正是「卡片挂着十天前旧错误」的根因
  for (const status of ['success', 'skipped', 'partial'] as const) {
    assert.equal(
      lastRunFailureMessage({ lastRunStatus: status, lastRunMessage: '上一轮认证失败' }),
      undefined,
      `${status} 不得回传上一轮的旧错误`,
    );
  }
  // 空串 / 缺字段 / 从未运行 → 都不得渲染
  assert.equal(lastRunFailureMessage({ lastRunStatus: 'failed', lastRunMessage: '' }), undefined);
  assert.equal(lastRunFailureMessage({ lastRunStatus: 'failed' }), undefined);
  assert.equal(lastRunFailureMessage({}), undefined);
});

test('clearLastRunResult：配置变更清空上一轮结论，但保留「上次跑过什么」（issue #105）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-clear-'));
  try {
    await writeAutosyncConfig(dir, 'git', {
      enabled: true,
      interval: '15m',
      startupMinIntervalMs: 300000,
      consecutiveFailures: 4,
      lastRunAt: '2026-08-17T10:00:00.000Z',
      lastRunStatus: 'failed',
      lastRunMessage: '认证失败',
      lastRunSkipReason: 'conflict',
      lastRunSkipCount: 2,
      lastRunHistoryId: 'hist-9',
    });
    const cleared = clearLastRunResult(await readAutosyncConfig(dir, 'git'));
    assert.equal(cleared.lastRunMessage, undefined);
    assert.equal(cleared.lastRunSkipReason, undefined);
    assert.equal(cleared.lastRunSkipCount, undefined);
    // 配置与「上次运行事实」必须保留：改间隔不等于抹掉历史
    assert.equal(cleared.enabled, true);
    assert.equal(cleared.interval, '15m');
    assert.equal(cleared.lastRunAt, '2026-08-17T10:00:00.000Z');
    assert.equal(cleared.lastRunStatus, 'failed');
    assert.equal(cleared.consecutiveFailures, 4);
    // 落盘后旧结论真的不在文件里（不是只在内存里清掉）
    await writeAutosyncConfig(dir, 'git', cleared);
    const raw = JSON.parse(await fs.readFile(path.join(dir, AUTOSYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.channels.git.lastRunMessage, undefined);
    assert.equal(raw.channels.git.lastRunSkipReason, undefined);
    assert.equal(raw.channels.git.lastRunSkipCount, undefined);
    assert.equal(raw.channels.git.lastRunStatus, 'failed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('issue #105 建议 4：shouldRunOnEnable —— 只有「关→开」且已过启动冷却才立刻跑一轮', () => {
  const now = Date.parse('2026-10-21T21:00:00.000Z');
  const base = { enabled: true, lastRunAt: '2026-10-01T10:00:00.000Z', startupMinIntervalMs: 300_000 };
  // 关 → 开，上次运行是十天前：立刻跑
  assert.equal(shouldRunOnEnable({ enabled: false }, base, now), true);
  // 本来就开着（只是改间隔/阈值）：不跑
  assert.equal(shouldRunOnEnable({ enabled: true }, base, now), false);
  // 这次是关掉：不跑
  assert.equal(shouldRunOnEnable({ enabled: false }, { ...base, enabled: false }, now), false);
  // 刚跑过（冷却窗口内）：不跑，避免连点把通道打爆
  assert.equal(shouldRunOnEnable({ enabled: false }, { ...base, lastRunAt: '2026-10-21T20:58:00.000Z' }, now), false);
  // 从未跑过 / 时间读不出：当作「很久没跑」→ 跑
  assert.equal(shouldRunOnEnable({ enabled: false }, { ...base, lastRunAt: undefined }, now), true);
  assert.equal(shouldRunOnEnable({ enabled: false }, { ...base, lastRunAt: 'garbage' }, now), true);
});
