/**
 * credentials adapter 测试：状态导出（永不泄值）、ref 收集、MissingSecret 由引擎兜底、
 * applyItem 经 secretInputs/decryptedCredentials 补录（仅内存）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialsAdapter, defaultCredentialRefs } from './credentials.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

const NS = ['llm-deepseek', 'llm-pi-ai'];

test('credentials: 状态导出（configured/source/hasValue=false，值绝不含）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.settings.ns.set('llm-pi-ai', {
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    revision: 2,
    secrets: [],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-123');

  const adapter = new CredentialsAdapter({ namespaces: NS });
  const out = await adapter.export(ctx, { includeSecrets: false });
  const refs = out.data.credentials.map((c) => c.ref).sort();
  assert.deepEqual(refs, ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'], '从 apiKeyEnv + secrets 标记收集');
  const dk = out.data.credentials.find((c) => c.ref === 'DEEPSEEK_API_KEY');
  assert.equal(dk?.configured, true);
  assert.equal(dk?.hasValue, false, '值未导出（安全不变量）');
  const ok = out.data.credentials.find((c) => c.ref === 'OPENAI_API_KEY');
  assert.equal(ok?.configured, false);
  // 序列化后的导出数据不得包含秘密值
  const serialized = JSON.stringify(out.data);
  assert.ok(!serialized.includes('sk-super-secret-123'), '凭据值不得进入导出数据');

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('credentials: defaultCredentialRefs 从 settings 收集', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  // 顶层 apiKeyEnv + secrets 引用类字段（apiKeyEnv）的值 = 凭据 ref
  ctx.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [{ path: ['apiKeyEnv'], set: true }] });
  const refs = await defaultCredentialRefs(NS)(ctx);
  assert.ok(refs.includes('DEEPSEEK_API_KEY'));
  // secrets[].path[0] 若为非引用类字段（如 apiKey 字段路径），不收集为 ref
  const ctx2 = makeContext('win32', 'C:\\Users\\alice');
  ctx2.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [{ path: ['apiKey'], set: true }] });
  const refs2 = await defaultCredentialRefs(NS)(ctx2);
  assert.ok(!refs2.includes('apiKey'), '字段路径不是凭据 ref');
});

test('credentials: applyItem 用 secretInputs / decryptedCredentials 补录（仅内存，不落盘值）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
  const adapter = new CredentialsAdapter({ namespaces: NS });
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['credentialsStatus', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const ictx = makeImportContext(dst, sections, { secretInputs: { DEEPSEEK_API_KEY: 'sk-from-user-input' } });
  const item: PlanItem = {
    id: 'secret:DEEPSEEK_API_KEY', kind: 'MissingSecret', adapter: 'credentialsStatus',
    description: '凭据补录', severity: 'warning', target: { adapter: 'credentialsStatus', ref: 'DEEPSEEK_API_KEY' },
  };
  const r = await adapter.applyItem(item, ictx);
  assert.equal(r.ok, true);
  assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-from-user-input');

  // 解密通道（加密备份）
  const dst2 = makeContext('linux', '/home/bob');
  const dec = new Map<string, string>([['DEEPSEEK_API_KEY', 'sk-decrypted']]);
  const r2 = await adapter.applyItem(item, makeImportContext(dst2, sections, { decryptedCredentials: dec }));
  assert.equal(r2.ok, true);
  assert.equal(dst2.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-decrypted');

  // 无值 → 失败（引擎在 MissingSecret 无值时先跳过，这里兜底）
  const r3 = await adapter.applyItem(item, makeImportContext(dst2, sections));
  assert.equal(r3.ok, false);
});

test('credentials: validate 拒绝 hasValue=true（安全不变量）', async () => {
  const adapter = new CredentialsAdapter();
  const bad = await adapter.validate({ version: 1, credentials: [{ ref: 'X', required: true, configured: true, hasValue: true } as never] });
  assert.equal(bad.valid, false);
});
