/**
 * 条目级导出选择（Phase 2）—— JSON / 记录型分区的「一个条目 = 一个单元」契约与回归。
 *
 * 背景：导出选择器能否展开某一行，取决于 /export-preview 拿到的 units 是否为空
 * （src/ui/selection-model.ts 的 sectionExpandable = units.length > 0 || unitsUnread）。
 * mcp / skills / plugins 等文件类分区早已实现 listUnits，而 settings / ui / providers /
 * prompts / credentialsStatus 这五个「数据型」分区此前没有 —— 用户只能整体勾选、无法逐条取舍。
 *
 * 这里钉住四件事（每个分区都要成立）：
 *  1. listUnits 与 export 的键/条目**同源**（unit id 直接能被 includeItems 接受）；
 *  2. 部分勾选时只带走被勾的那几条；
 *  3. 空数组 = 一条都不带（不静默产出「勾了 0 条却整分区照搬」）；
 *  4. providers 的 raw 必须随勾选收窄 —— raw 是 namespace 级快照，导入按 namespace 整体替换，
 *     不收窄就会把「没勾的 provider」一并写回目标机（选择器撒谎）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SettingsAdapter } from './settings.ts';
import { UiAdapter } from './ui.ts';
import { ProvidersAdapter } from './providers.ts';
import { PromptsAdapter } from './prompts.ts';
import { CredentialsAdapter } from './credentials.ts';
import { createAdapters } from './index.ts';
import { makeContext } from './test-helpers.ts';
import type { ExportOptions, HostContext } from '../core/types.ts';

const HOME = 'C:\\Users\\alice';

/** 单分区导出：includeItems 显式给定（undefined = 全量） */
function opts(section: string, allow: string[] | undefined): ExportOptions {
  return allow === undefined ? { includeSecrets: false } : { includeSecrets: false, includeItems: { [section]: allow } };
}

test('settings 条目级：一个 namespace = 一个单元，勾哪条带哪条', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.settings.ns.set('llm-pi-ai', { value: { a: 1 }, revision: 1, secrets: [] });
  ctx.settings.ns.set('dsh-ops', { value: { b: 2 }, revision: 1, secrets: [] });
  const adapter = new SettingsAdapter(['llm-pi-ai', 'dsh-ops']);

  const full = await adapter.export(ctx, opts('settings', undefined));
  const units = adapter.listUnits(full);
  assert.deepEqual(units.map((u) => u.id).sort(), ['settings:dsh-ops', 'settings:llm-pi-ai']);
  assert.deepEqual(units.map((u) => u.label).sort(), ['dsh-ops', 'llm-pi-ai']);
  assert.ok(units.every((u) => u.sizeBytes > 0), '单元体积必须非零（选择器要显示真实体积）');

  const part = await adapter.export(ctx, opts('settings', ['settings:llm-pi-ai']));
  assert.deepEqual(Object.keys(part.data.namespaces), ['llm-pi-ai']);
  assert.equal(part.counts?.namespaces, 1);

  const none = await adapter.export(ctx, opts('settings', []));
  assert.deepEqual(Object.keys(none.data.namespaces), [], '空数组 = 一条都不带');
  assert.equal(none.counts?.namespaces, 0);
});

test('ui 条目级：勾选只作用于 namespace，迁移说明（纯说明）恒在', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.settings.ns.set('pet', { value: { on: true }, revision: 1, secrets: [] });
  ctx.settings.ns.set('theme', { value: { dark: true }, revision: 1, secrets: [] });
  const adapter = new UiAdapter(['pet', 'theme']);

  const full = await adapter.export(ctx, opts('ui', undefined));
  assert.deepEqual(adapter.listUnits(full).map((u) => u.id).sort(), ['ui:pet', 'ui:theme']);

  const none = await adapter.export(ctx, opts('ui', []));
  assert.deepEqual(Object.keys(none.data.namespaces), []);
  assert.ok((none.data.uiMigrationNotes?.length ?? 0) > 0, '迁移说明是提示信息，不随勾选消失');
});

test('providers 条目级：一台 provider = 一个单元，且 raw.providers 按勾选收窄', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.settings.ns.set('llm-pi-ai', {
    value: { providers: { p1: { baseUrl: 'u1' }, p2: { baseUrl: 'u2' } } },
    revision: 1,
    secrets: [],
  });
  const adapter = new ProvidersAdapter(['llm-pi-ai']);

  const full = await adapter.export(ctx, opts('providers', undefined));
  const units = adapter.listUnits(full);
  assert.deepEqual(units.map((u) => u.id).sort(), ['providers:p1', 'providers:p2']);
  assert.equal(units.find((u) => u.id === 'providers:p1')?.detail, 'llm-pi-ai', 'detail = 来源 namespace');
  // 全量导出不得改动 raw（旧备份逐字节兼容）
  assert.deepEqual(Object.keys(full.data.providers['p1']!.raw as Record<string, unknown>), ['providers']);
  assert.deepEqual(Object.keys((full.data.providers['p1']!.raw as { providers: Record<string, unknown> }).providers), ['p1', 'p2']);

  const part = await adapter.export(ctx, opts('providers', ['providers:p1']));
  assert.deepEqual(Object.keys(part.data.providers), ['p1']);
  assert.equal(part.counts?.providers, 1);
  // 关键：未勾的 p2 不能借 raw 混进包（导入按 namespace 整体替换）
  assert.deepEqual(
    Object.keys((part.data.providers['p1']!.raw as { providers: Record<string, unknown> }).providers),
    ['p1'],
    'raw.providers 必须收窄到被勾选的 route，否则未勾的 provider 会被写回目标机',
  );

  const none = await adapter.export(ctx, opts('providers', []));
  assert.deepEqual(part.data.providers, part.data.providers, 'sanity');
  assert.deepEqual(Object.keys(none.data.providers), []);
  assert.equal(none.counts?.providers, 0);
});

test('prompts 条目级：一条 persona / plan-mode 段 = 一个单元', async () => {
  const ctx = makeContext('win32', HOME, 'desktop');
  ctx.patchFile.lines.set('p1', {
    lineId: 'p1',
    raw: { id: 'p1', name: 'agent-x', config: { systemPrompt: { persona: 'be brief' } } },
  });
  ctx.patchFile.lines.set('p2', {
    lineId: 'p2',
    raw: { id: 'p2', name: 'agent-y', config: { systemPrompt: 'be verbose' } },
  });
  const adapter = new PromptsAdapter();

  const full = await adapter.export(ctx, opts('prompts', undefined));
  const units = adapter.listUnits(full);
  assert.deepEqual(units.map((u) => u.id).sort(), ['prompts:prompt:p1:persona', 'prompts:prompt:p2:persona']);
  assert.deepEqual(units.map((u) => u.detail).sort(), ['systemPrompt', 'systemPrompt']);

  const part = await adapter.export(ctx, opts('prompts', ['prompts:prompt:p2:persona']));
  assert.deepEqual(part.data.prompts.map((p) => p.id), ['prompt:p2:persona']);

  const none = await adapter.export(ctx, opts('prompts', []));
  assert.deepEqual(none.data.prompts, [], '空数组 = 一条都不带');
});

test('credentialsStatus 条目级：勾掉一条 = 少一个「需补录」项', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.credentials.values.set('TOKEN_A', 'secret-a');
  const adapter = new CredentialsAdapter({ refs: async () => ['TOKEN_A', 'TOKEN_B'] });

  const full = await adapter.export(ctx, opts('credentialsStatus', undefined));
  const units = adapter.listUnits(full);
  assert.deepEqual(units.map((u) => u.id).sort(), ['credentialsStatus:TOKEN_A', 'credentialsStatus:TOKEN_B']);
  assert.equal(units.find((u) => u.id === 'credentialsStatus:TOKEN_A')?.detail, 'configured');
  assert.equal(units.find((u) => u.id === 'credentialsStatus:TOKEN_B')?.detail, 'missing');
  assert.ok(units.every((u) => !JSON.stringify(u).includes('secret-a')), '单元里绝不能出现凭据值');

  const part = await adapter.export(ctx, opts('credentialsStatus', ['credentialsStatus:TOKEN_B']));
  assert.deepEqual(part.data.credentials.map((c) => c.ref), ['TOKEN_B']);
  assert.equal(part.counts?.credentials, 1);

  const none = await adapter.export(ctx, opts('credentialsStatus', []));
  assert.deepEqual(none.data.credentials, []);
});

test('自洽性守卫：每个分区的 listUnits 所报 id 都能被自己的 export 接受', async () => {
  const ctx = makeContext('win32', HOME);
  ctx.settings.ns.set('llm-pi-ai', { value: { providers: { p1: {}, p2: {} } }, revision: 1, secrets: [] });
  ctx.settings.ns.set('pet', { value: { on: true }, revision: 1, secrets: [] });
  ctx.credentials.values.set('TOKEN_A', 'x');

  // 四种 adapter 的 data 形态互不相同，统一收窄成本地结构类型（只用到 export / listUnits 两件事）
  type UnitCase = {
    section: string;
    picked: (data: unknown) => number;
    adapter: {
      export: (c: HostContext, o: ExportOptions) => Promise<{ data: unknown }>;
      listUnits: (s: never) => { id: string }[];
    };
  };
  const cases: UnitCase[] = [
    { adapter: new SettingsAdapter(['llm-pi-ai']), section: 'settings', picked: (d) => Object.keys((d as { namespaces: object }).namespaces).length },
    { adapter: new UiAdapter(['pet']), section: 'ui', picked: (d) => Object.keys((d as { namespaces: object }).namespaces).length },
    { adapter: new ProvidersAdapter(['llm-pi-ai']), section: 'providers', picked: (d) => Object.keys((d as { providers: object }).providers).length },
    { adapter: new CredentialsAdapter({ refs: async () => ['TOKEN_A'] }), section: 'credentialsStatus', picked: (d) => (d as { credentials: unknown[] }).credentials.length },
  ];
  for (const c of cases) {
    const full = await c.adapter.export(ctx, { includeSecrets: false });
    const units = c.adapter.listUnits(full as never);
    assert.ok(units.length > 0, c.section + ' 必须有可展开的单元');
    for (const unit of units) {
      const only = await c.adapter.export(ctx, { includeSecrets: false, includeItems: { [c.section]: [unit.id] } });
      assert.equal(c.picked(only.data), 1, '勾选单元 ' + unit.id + ' 后必须恰好带出它自己');
    }
  }
});
test('全集守卫：createAdapters() 里每个分区都实现了 listUnits，且空分区返回空数组而非抛错', () => {
  // 为什么要有这条：选择器是否可展开只看 units 是否为空。任何 adapter 漏实现 listUnits，
  // 那个分区就退化成「只能整体勾选」—— 用户报的现象（MCP 服务器不能展开）就是这么来的。
  const adapters = createAdapters({ includeSessions: true });
  assert.ok(adapters.length >= 14, 'registry 至少 14 个分区，实际 ' + adapters.length);
  for (const adapter of adapters) {
    assert.equal(typeof adapter.listUnits, 'function', adapter.id + ' 未实现 listUnits，该分区将无法展开');
    const empty = { sectionId: adapter.id, data: {}, counts: {}, warnings: [] } as never;
    // 必须 call(adapter)：listUnits 内部要用 this.id，裸取方法会丢接收者（真机曾因此抛错）
    const listUnits = adapter.listUnits as (s: never) => { id: string }[];
    assert.deepEqual(listUnits.call(adapter, empty), [], adapter.id + ' 的空分区必须返回空数组');
  }
});
