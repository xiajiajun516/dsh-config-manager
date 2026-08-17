/**
 * autosync-config 测试：sync-autosync.json 读写往返、缺省值、损坏 JSON 回退缺省、原子写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readAutosyncConfig, writeAutosyncConfig, AUTOSYNC_CONFIG_FILE,
  AUTOSYNC_CONFIG_SCHEMA_VERSION, DEFAULT_AUTOSYNC_INTERVAL,
  DEFAULT_STARTUP_MIN_INTERVAL_MS,
} from './autosync-config.ts';

test('writeAutosyncConfig + readAutosyncConfig：写入 → 读回字段一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-rt-'));
  try {
    await writeAutosyncConfig(dir, {
      enabled: true,
      interval: '15m',
      startupMinIntervalMs: 300000,
      consecutiveFailures: 2,
      lastRunAt: '2026-08-16T12:00:00.000Z',
      lastRunStatus: 'skipped',
      lastRunMessage: '有冲突项，跳过',
      lastRunHistoryId: 'hist-1',
    });
    const cfg = await readAutosyncConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.interval, '15m');
    assert.equal(cfg.startupMinIntervalMs, 300000);
    assert.equal(cfg.consecutiveFailures, 2);
    assert.equal(cfg.lastRunAt, '2026-08-16T12:00:00.000Z');
    assert.equal(cfg.lastRunStatus, 'skipped');
    assert.equal(cfg.lastRunMessage, '有冲突项，跳过');
    assert.equal(cfg.lastRunHistoryId, 'hist-1');
    // 原始文件校验
    const raw = JSON.parse(await fs.readFile(path.join(dir, AUTOSYNC_CONFIG_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, AUTOSYNC_CONFIG_SCHEMA_VERSION);
    assert.equal(raw.enabled, true);
    assert.equal(raw.interval, '15m');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readAutosyncConfig：文件不存在 → 返回缺省值', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-default-'));
  try {
    const cfg = await readAutosyncConfig(dir);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.interval, DEFAULT_AUTOSYNC_INTERVAL);
    assert.equal(cfg.startupMinIntervalMs, DEFAULT_STARTUP_MIN_INTERVAL_MS);
    assert.equal(cfg.consecutiveFailures, 0);
    assert.equal(cfg.lastRunAt, undefined);
    assert.equal(cfg.lastRunStatus, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readAutosyncConfig：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, AUTOSYNC_CONFIG_FILE), '{not-json', 'utf8');
    const cfg = await readAutosyncConfig(dir);
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
    const cfg = await readAutosyncConfig(dir);
    assert.equal(cfg.enabled, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeAutosyncConfig：原子写（自动创建目录）', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-autosync-mkdir-'));
  try {
    const dir = path.join(base, 'nested', 'sync');
    await writeAutosyncConfig(dir, { enabled: true, interval: '30m', startupMinIntervalMs: 300000, consecutiveFailures: 0 });
    const cfg = await readAutosyncConfig(dir);
    assert.ok(cfg);
    assert.equal(cfg.enabled, true);
    // 确认没有残留临时文件
    const files = await fs.readdir(dir);
    assert.ok(files.length >= 1, '应有配置文件');
    assert.ok(!files.some((f) => f.includes('.tmp')), '不应残留 .tmp 临时文件');
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
