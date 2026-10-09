/**
 * settings adapter 测试：非 UI namespace 导出（redact+revision）/ Create·Skip·Conflict 分析 /
 * applyItem 乐观锁写回 / validate。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsAdapter } from './settings.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem, SensitiveHit } from '../core/types.ts';
import { createSecretScanner } from '../security/secret-scanner.ts';

const NS = ['general', 'theme', 'llm-deepseek'];

test('settings: 导出只含非 UI namespace（redacted + revision + secrets 标记）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] }); // UI 类 → 排除
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });

  const adapter = new SettingsAdapter(NS);
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.version, 1);
  assert.ok(out.data.namespaces['general']);
  assert.ok(out.data.namespaces['llm-deepseek']);
  assert.ok(!out.data.namespaces['theme'], 'theme 属 UI 类，应被 settings 排除');
  assert.equal(out.data.namespaces['llm-deepseek']?.revision, 5);
  assert.deepEqual(out.data.namespaces['llm-deepseek']?.secrets, [{ path: ['apiKey'], set: true }]);
  assert.equal(out.counts.namespaces, 2);

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('settings: analyzeImport 未注册→MissingDependency / 空→Create / 一致→Skip / 不同→Conflict + applyItem 写回（幂等）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  const adapter = new SettingsAdapter(NS);
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['settings', exported.data]]);

  // 场景 A：目标命名空间未注册（缺少提供插件）→ MissingDependency（不是 Create，写入必失败）
  const dstA = makeContext('linux', '/home/bob');
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dstA, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'MissingDependency');
  assert.equal(items[0]?.target?.ref, 'general');

  // 场景 B：目标已注册但为空 → Create 并写入（初始化）
  const dst = makeContext('linux', '/home/bob');
  dst.settings.registered.add('general'); // 注册但无值
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Create');
  assert.equal(items[0]?.target?.ref, 'general');
  const r = await adapter.applyItem(items[0]!, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' });

  // 重复导入 → Skip（幂等）
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 目标不同 → Conflict；useImported（Update）后覆盖
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
  const useItem: PlanItem = { ...items[0]!, kind: 'Update' };
  await adapter.applyItem(useItem, makeImportContext(dst, sections));
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' });
});

test('settings: applyItem 读时锁 — 目标 revision 不同时仍按当前值提交（不覆盖并发修改）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  const adapter = new SettingsAdapter(NS);
  const exported = await adapter.export(src, { includeSecrets: false });

  const dst = makeContext('linux', '/home/bob');
  dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 9, secrets: [] });
  const sections = new Map([['settings', exported.data]]);
  const item: PlanItem = {
    id: 'settings:general', kind: 'Update', adapter: 'settings',
    description: '更新 general', severity: 'info',
    target: { adapter: 'settings', ref: 'general' },
  };
  const r = await adapter.applyItem(item, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark' }, 'useImported 应覆盖目标');
  assert.equal(dst.settings.ns.get('general')?.revision, 10, '提交后 revision 递增');
});

test('settings: validate 拒绝非法结构', async () => {
  const adapter = new SettingsAdapter(NS);
  const bad = await adapter.validate({ version: 2, namespaces: {} } as never);
  assert.equal(bad.valid, false);
  const noNs = await adapter.validate({ version: 1, namespaces: null as never });
  assert.equal(noNs.valid, false);
});

/* ---------------- issue #73：两端皆空必须 Skip，否则同步永不收敛 ---------------- */

test('settings: 两端皆空（{}）→ Skip；目标非空 + 导入为 {} → 仍 Conflict', async () => {
  const adapter = new SettingsAdapter(NS);
  // 远端/包内值本身就是 {}：DSH 对「已注册但从未配置」的 namespace 返回 {}，导出侧如实记下。
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('general', { value: {}, revision: 0, secrets: [] });
  const exported = await adapter.export(src, { includeSecrets: false });
  assert.deepEqual(exported.data.namespaces['general']?.value, {}, '导出侧值确实是空对象');

  // 目标机同名 namespace 已注册且值同为 {}。反序（空判定在前）会判 Create，而 applyItem 的
  // replace(ref, {}) 是空写入，下一轮 describe 仍返回 {} → 每次同步都重现同一项（issue #73）。
  const dst = makeContext('linux', '/home/bob');
  dst.settings.ns.set('general', { value: {}, revision: 0, secrets: [] });
  const sections = new Map([['settings', exported.data]]);
  let items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'Skip', '两端皆 {} → Skip');
  // 收敛：再分析一次仍是 Skip（等价于「应用之后不会再冒出来」）
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Skip');

  // 边界：目标非空 + 导入为 {} → Conflict（不得借「跳过空值」把本机配置静默清空）
  dst.settings.ns.set('general', { value: { theme: 'dark' }, revision: 7, secrets: [] });
  items = await adapter.analyzeImport(exported.data, makeImportContext(dst, sections));
  assert.equal(items[0]?.kind, 'Conflict');
});
/* ---------------- 快路径：宿主实现 describeAll 时只读一趟，且结果与逐名路径逐字相同 ---------------- */

/** 给 MemSettings 挂一个批量读（真实宿主即如此：多一个全量 describe，其余不变） */
function withDescribeAll(ctx: ReturnType<typeof makeContext>): { calls: () => number } {
  let calls = 0;
  const base = ctx.settings;
  ctx.settings.describeAll = async (opts?: { redactSecrets?: boolean }) => {
    calls += 1;
    const out: { ns: string; info: Awaited<ReturnType<typeof base.describe>> }[] = [];
    for (const ns of base.registered) out.push({ ns, info: await base.describe(ns, opts) });
    return out;
  };
  return { calls: () => calls };
}

test('settings: 宿主实现 describeAll 时只读一趟，条目/告警与逐名路径逐字相同', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  // 'zz-unregistered' 非 UI 类且未注册：两条路径都必须产出同一条 settingsNsReadFailed 告警
  const NSX = [...NS, 'zz-unregistered'];
  const slowOut = await new SettingsAdapter(NSX).export(ctx, { includeSecrets: false });

  const counted = withDescribeAll(ctx);
  const fastOut = await new SettingsAdapter(NSX).export(ctx, { includeSecrets: false });

  assert.equal(counted.calls(), 1, 'N 个 namespace 只允许一次全量读取（真机 24 个逐个 describe ≈1.7 s）');
  assert.deepEqual(fastOut.data, slowOut.data);
  assert.equal(fastOut.warnings.length, 1, '未注册 namespace 仍要告警（不得静默吞掉）');
  assert.equal(slowOut.warnings.length, 1);
  // 告警点名同一个 namespace：真实宿主两条路径都由 DshSettingsFacade 抛同一条
  // `namespace not found: <ns>`（describe 复用 describeAll），此处内存宿主文案不同，
  // 故只钉「数量 + 点名」而不是整句文本
  assert.ok(fastOut.warnings[0]?.includes('zz-unregistered'));
  assert.ok(slowOut.warnings[0]?.includes('zz-unregistered'));
});

test('settings: describeAll 抛错时退回逐名路径（快路径失败不得让整分区告警）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
  ctx.settings.describeAll = async () => { throw new Error('boom'); };
  const out = await new SettingsAdapter(['general']).export(ctx, { includeSecrets: false });
  assert.equal(out.data.namespaces['general']?.revision, 3, '退回逐名 describe 后仍要读到值');
  assert.deepEqual(out.warnings, []);
});

test('settings: value/base 共享同一嵌套对象不得触发强化 scanner 的循环误报（用户上报 2026-10-09）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  // 真实 DSH 的 describe() 同时回传 value（生效值）与 base（组合层）：未被用户覆盖的嵌套分组在两处是
  // 同一个对象 → 导出结构里出现 DAG 共享引用。旧版全局 visited 判环会把它读成
  // 「检测到循环引用，无法扫描（路径 namespaces.<ns>.value.<key>）」，整次备份失败。
  const dream = { enabled: true, idleMinutes: 180, apiKey: 'sk-live-abcdefgh12345' };
  ctx.settings.ns.set('meow-memory', {
    value: { promptLang: 'zh', dream },
    base: { promptLang: 'zh', dream },
    revision: 3,
    secrets: [],
  });
  const adapter = new SettingsAdapter(['meow-memory']);
  const exported = await adapter.export(ctx, { includeSecrets: false });
  const rec = exported.data.namespaces['meow-memory'];
  // 前置条件：导出的 value/base 确实共享同一个对象（否则这条测试没覆盖到目标形态）
  assert.strictEqual(
    (rec?.value as { dream?: unknown } | undefined)?.dream,
    (rec?.base as { dream?: unknown } | undefined)?.dream,
    'value/base 必须共享同一 dream 对象',
  );

  const scanner = createSecretScanner();
  let scanned: { sanitized: unknown; hits: SensitiveHit[] } | undefined;
  assert.doesNotThrow(() => { scanned = scanner.scanAndRedact(exported.data); }, '共享引用不得被误判为循环');
  const outRec = (scanned!.sanitized as {
    namespaces: Record<string, { value: { dream: Record<string, unknown> }; base: { dream: Record<string, unknown> } }>;
  }).namespaces['meow-memory']!;
  // 两个分支都要在，且各自完成脱敏（不能因为共享就丢分支或漏剥）
  assert.equal(outRec.value.dream['apiKey'], '', 'value 分支脱敏');
  assert.equal(outRec.base.dream['apiKey'], '', 'base 分支脱敏');
  assert.equal(outRec.value.dream['idleMinutes'], 180, '非敏感字段保留');
  assert.ok(scanned!.hits.some((h) => h.path === 'namespaces.meow-memory.value.dream.apiKey'));
  assert.ok(scanned!.hits.some((h) => h.path === 'namespaces.meow-memory.base.dream.apiKey'));
});

