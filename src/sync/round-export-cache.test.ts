/**
 * Item I：单轮自动同步本地导出复用缓存单元测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ConfigAdapter, ExportOptions, ExportSection, HostContext } from '../core/types.ts';
import { RoundExportCache } from './round-export-cache.ts';

function fakeAdapter(id: 'settings' | 'prompts' | 'sessions', counter: { count: number }): ConfigAdapter {
  return {
    id,
    displayName: id,
    async export(_ctx: HostContext, opts: ExportOptions): Promise<ExportSection> {
      counter.count += 1;
      const limit = opts.sessions?.limit ?? -1;
      return {
        sectionId: id,
        data: { count: counter.count, limit },
        counts: { items: 1 },
        warnings: [`${id}:warn:${counter.count}`],
      };
    },
    async preview() { return { sectionId: id, data: {}, counts: { items: 1 }, warnings: [] }; },
    async analyzeImport() { throw new Error('unused'); },
    async createImportPlan() { throw new Error('unused'); },
    async executeImportPlan() { throw new Error('unused'); },
  } as unknown as ConfigAdapter;
}

const dummyCtx = {} as HostContext;

test('RoundExportCache：同参数同一轮只导出一次并保留 warnings/counts；includeSecrets=true 绕过缓存', async () => {
  const cache = new RoundExportCache();
  const counter = { count: 0 };
  const adapter = fakeAdapter('settings', counter);

  const first = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: false });
  const second = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: false });
  assert.equal(counter.count, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(second.warnings, ['settings:warn:1']);

  const withSecrets = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: true });
  assert.equal(counter.count, 2, '含密导出必须绕过缓存，避免复用脱敏产物');
  assert.deepEqual(withSecrets.warnings, ['settings:warn:2']);
});

test('RoundExportCache：不同 sessions / includeItems 切片选项分别缓存，互不串用', async () => {
  const cache = new RoundExportCache();
  const counter = { count: 0 };
  const adapter = fakeAdapter('sessions', counter);

  const s5 = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: false, sessions: { limit: 5 } });
  const s10 = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: false, sessions: { limit: 10 }, includeItems: { sessions: ['s1'] } });
  const s5Again = await cache.getOrExport(adapter, dummyCtx, { includeSecrets: false, sessions: { limit: 5 } });

  assert.equal(counter.count, 2);
  assert.equal((s5.data as { limit: number }).limit, 5);
  assert.equal((s10.data as { limit: number }).limit, 10);
  assert.strictEqual(s5Again, s5);
});

test('RoundExportCache：invalidate 按分区精准失效，未写盘分区继续命中缓存', async () => {
  const cache = new RoundExportCache();
  const settingsCounter = { count: 0 };
  const promptsCounter = { count: 0 };
  const settings = fakeAdapter('settings', settingsCounter);
  const prompts = fakeAdapter('prompts', promptsCounter);

  await cache.getOrExport(settings, dummyCtx, { includeSecrets: false });
  await cache.getOrExport(prompts, dummyCtx, { includeSecrets: false });
  cache.invalidate(['settings']);

  await cache.getOrExport(settings, dummyCtx, { includeSecrets: false });
  await cache.getOrExport(prompts, dummyCtx, { includeSecrets: false });
  assert.equal(settingsCounter.count, 2, '被写入的分区失效并重导');
  assert.equal(promptsCounter.count, 1, '未改动分区继续命中缓存');

  cache.clear();
  await cache.getOrExport(prompts, dummyCtx, { includeSecrets: false });
  assert.equal(promptsCounter.count, 2, 'clear 全清（回滚兜底）');
});
