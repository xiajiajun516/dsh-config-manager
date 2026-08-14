/**
 * providers adapter 测试：llm-deepseek（单 provider）与 llm-pi-ai（多 provider）导出、
 * Create/Skip/Conflict 分析、整体 namespace 写回（raw + 乐观锁）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProvidersAdapter } from './providers.ts';
import { createSecretScanner } from '../security/secret-scanner.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

test('providers: 导出单/多 provider section（含 revision 与 raw）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-secret' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.settings.ns.set('llm-pi-ai', {
    value: {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com', models: ['gpt-4o'] },
        local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:11434' },
      },
    },
    revision: 2,
    secrets: [],
  });

  const adapter = new ProvidersAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  const routes = Object.keys(out.data.providers).sort();
  assert.deepEqual(routes, ['llm-deepseek', 'local', 'openai']);
  const deepseek = out.data.providers['llm-deepseek'];
  assert.equal(deepseek?.namespace, 'llm-deepseek');
  assert.equal(deepseek?.revision, 5);
  assert.equal(deepseek?.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.ok(deepseek?.raw, 'raw 保存完整 redacted namespace 值');
  const openai = out.data.providers['openai'];
  assert.equal(openai?.namespace, 'llm-pi-ai');
  assert.equal(openai?.baseURL, 'https://api.openai.com');
  assert.equal(out.counts.providers, 3);

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('providers: analyzeImport Create/Skip/Conflict + applyItem 写回整个 namespace', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('llm-pi-ai', {
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com' } } },
    revision: 2,
    secrets: [],
  });
  const adapter = new ProvidersAdapter();
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['providers', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  dst.settings.registered.add('llm-pi-ai'); // 目标已安装提供该命名空间的插件（空值 → Create 初始化）
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.id, 'provider:openai');
  assert.equal(items[0]?.target?.ref, 'llm-pi-ai', '快照定位 namespace');
  let r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('llm-pi-ai')?.value, { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com' } } });

  // 幂等：一致 → Skip
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 目标不同 → Conflict；useImported 覆盖
  dst.settings.ns.set('llm-pi-ai', {
    value: { providers: { openai: { apiKeyEnv: 'OTHER_KEY', baseURL: 'https://other.example.com' } } },
    revision: 8,
    secrets: [],
  });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
  const useItem: PlanItem = { ...items[0]!, kind: 'Update' };
  await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.deepEqual(dst.settings.ns.get('llm-pi-ai')?.value, { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com' } } });
});

test('providers: validate 拒绝缺 namespace/revision 的记录', async () => {
  const adapter = new ProvidersAdapter();
  const bad = await adapter.validate({ version: 1, providers: { x: { route: 'x' } as never } });
  assert.equal(bad.valid, false);
});

test('providers: 多 route 共享 secrets 引用不触发强化 scanner 循环误报（m4 createSecretScanner）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('llm-pi-ai', {
    value: {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com', models: ['gpt-4o'], apiKey: 'sk-openai-123' },
        local: { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:11434', token: 'local-token-456' },
      },
    },
    revision: 2,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  const adapter = new ProvidersAdapter();
  const exported = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(Object.keys(exported.data.providers).length, 2);

  // 隔离断言：route 间 secrets / raw 必须独立引用（共享引用会被 visited 循环检测误判）
  const openai = exported.data.providers['openai'];
  const local = exported.data.providers['local'];
  assert.notStrictEqual(openai?.secrets, local?.secrets, 'route 间 secrets 数组必须独立');
  assert.notStrictEqual(openai?.raw, local?.raw, 'route 间 raw 必须独立');

  // m4 强化版 scanner 扫描导出数据：不得抛「检测到循环引用」，且敏感字段被剥离
  const scanner = createSecretScanner();
  let scanned: { sanitized: unknown; hits: import('../core/types.ts').SensitiveHit[] };
  assert.doesNotThrow(() => { scanned = scanner.scanAndRedact(exported.data); }, '共享引用不得被误判为循环');
  assert.ok(scanned!.hits.length >= 2, `apiKey/token 字段应被剥离（实际 ${scanned!.hits.length}）`);
  const sanitizedProviders = (scanned!.sanitized as { providers: Record<string, Record<string, unknown>> }).providers;
  assert.equal(sanitizedProviders['openai']?.['apiKey'], '', 'apiKey 值剥离');
  assert.equal(sanitizedProviders['local']?.['token'], '', 'token 值剥离');
  assert.equal(sanitizedProviders['openai']?.['apiKeyEnv'], 'OPENAI_API_KEY', '引用字段 apiKeyEnv 保留');
  assert.equal(sanitizedProviders['openai']?.['baseURL'], 'https://api.openai.com', '非敏感字段保留');
});
