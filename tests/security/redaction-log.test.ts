/**
 * 日志 Redaction 测试（m7-tests-docs；规范 §24 日志系统 / §23 错误设计）。
 *
 * 覆盖：logger 输出强制 redact（消息文本 + meta 对象级掩码）、
 *       核心流程（导出/导入/回滚）全链路日志不泄 secret 值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { createLogger, redact as loggerRedact, redactValue as loggerRedactValue, type LogLevel, type LogSink } from '../../src/utils/logger.ts';
import { redact } from '../../src/security/redaction.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';

const NS = ['general', 'llm-deepseek'];
const SECRET = 'sk-super-secret-value-123';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-redact-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 收集日志的内存 sink */
function collectingSink(): { sink: LogSink; lines: { level: LogLevel; message: string; meta?: unknown }[] } {
  const lines: { level: LogLevel; message: string; meta?: unknown }[] = [];
  const sink: LogSink = (level, message, meta) => { lines.push({ level, message, meta }); };
  return { sink, lines };
}

/** 给 ctx 换上收集日志的 logger */
function attachLogger(ctx: MockHostContext, lines: { level: LogLevel; message: string; meta?: unknown }[]): void {
  ctx.log = createLogger({ level: 'debug', sink: (lvl, msg, meta) => { lines.push({ level: lvl, message: msg, meta }); } });
}

test('L-01 logger 消息文本：默认 sink 的 redact 掩码敏感字段值（= / : / JSON 形态）', () => {
  // logger 的默认 sink 在输出前用本模块 redact() 掩码消息文本（自定义 sink 收到原始消息，由调用方负责）
  const masked = loggerRedact('login with apiKey=sk-abc1234567890abcdef now | token: ghp_abcdefghijklmnopqrstuvwxyz | {"password": "hunter2", "theme": "dark"}');
  assert.ok(!masked.includes('sk-abc1234567890abcdef'), 'sk- 值不得出现在日志');
  assert.ok(!masked.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'github token 不得出现在日志');
  assert.ok(!masked.includes('hunter2'), 'password 值不得出现在日志');
  assert.ok(masked.includes('***REDACTED***'), '应出现掩码占位');
  assert.ok(masked.includes('"theme": "dark"'), '非敏感字段保留');
});

test('L-02 logger meta：redactValue 对象级字段掩码（嵌套 + 数组）', () => {
  const masked = loggerRedactValue({ apiKey: SECRET, theme: 'dark', nested: { clientSecret: 'cs-value' }, list: [{ token: 't1' }] }) as Record<string, unknown>;
  const text = JSON.stringify(masked);
  assert.ok(!text.includes(SECRET), 'meta 不得含 secret 值');
  assert.ok(!text.includes('cs-value'), '嵌套 secret 不得出现');
  assert.ok(!text.includes('t1'), '数组内 token 不得出现');
  assert.ok(text.includes('***REDACTED***'), '掩码占位出现');
  assert.ok(text.includes('"theme":"dark"') || text.includes('"theme": "dark"'), '非敏感字段保留');
});

test('L-03 导出全链路：Exporter 日志不泄 secret 值', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('llm-deepseek', {
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: SECRET },
      revision: 5,
      secrets: [{ path: ['apiKey'], set: true }],
    });
    src.credentials.values.set('DEEPSEEK_API_KEY', SECRET);
    const lines: { level: LogLevel; message: string; meta?: unknown }[] = [];
    attachLogger(src, lines);

    const adapters = createAdapters({ namespaces: NS });
    await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: path.join(dir, 'x.zip') });

    const all = JSON.stringify(lines);
    assert.ok(!all.includes(SECRET), '导出日志不得含 secret 值');
    assert.ok(!all.includes('DEEPSEEK_API_KEY:'), '凭据文件内容不得入日志');
  });
});

test('L-04 导入全链路：Importer 日志不泄 secret 值（含补录输入）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    src.settings.ns.set('llm-deepseek', {
      value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
      revision: 5,
      secrets: [{ path: ['apiKeyEnv'], set: true }],
    });
    src.credentials.values.set('DEEPSEEK_API_KEY', SECRET);
    const adapters = createAdapters({ namespaces: NS });
    const zipPath = path.join(dir, 'x.zip');
    await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
      .export({ includeSecrets: false, outPath: zipPath });

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const lines: { level: LogLevel; message: string; meta?: unknown }[] = [];
    attachLogger(dst, lines);
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      secretInputs: { DEEPSEEK_API_KEY: 'sk-reentered-value-999' },
    });

    const all = JSON.stringify(lines);
    assert.ok(!all.includes(SECRET), '导入日志不得含源 secret 值');
    assert.ok(!all.includes('sk-reentered-value-999'), '补录输入值不得入日志');
  });
});

test('L-05 redact 幂等：重复脱敏结果不变（不二次泄漏）', () => {
  const sample = 'token=abc123def456 theme=dark';
  const once = redact(sample);
  const twice = redact(once);
  assert.equal(twice, once);
  assert.ok(once.includes('***REDACTED***'));
  assert.ok(once.includes('theme=dark'));
});
