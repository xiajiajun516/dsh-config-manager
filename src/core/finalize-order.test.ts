/**
 * 收尾阶段顺序回归（issue #45 新流程）：
 *
 * ① 分区的 finalizeApply 先跑（会话首帧按映射改写 + 目录归位必须在这里完成）；
 * ② 全部分区跑完之后才跑 finalizeImport（把会话登记进工作区：attachSession 要读会话 header
 *    并按 cwd 的 realpath 校验，早一步必然失败）。
 *
 * 为什么必须钉住顺序：workspaces 在 APPLY_ORDER 里排在 sessions 之前，把 attachSession 放回
 * workspaces.applyItem 会让「跨机映射导入」永远登记失败 —— 这个回归是静默的（报告里只有一句
 * 「N 个会话未能登记」），只有顺序被钉住才不会再退化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { ApplyResult, ConfigAdapter, ExportSection, PlanItem } from './types.ts';

const BYTES = new TextEncoder().encode('fake-session-log-bytes');

/** 最小 adapter 替身：export 产出一个分区载荷，analyzeImport 派生一项，applyItem/finalize* 记账。 */
function stub(id: 'workspaces' | 'sessions', order: string[]): ConfigAdapter {
  const data = id === 'sessions'
    ? { version: 1, files: [{ relativePath: '--proj--/s1/session-1.jsonl.zstd', contentHash: sha256Hex(BYTES), data: BYTES }] }
    : { version: 1, workspaces: [{ id: 'ws-1', path: 'D:/proj', title: 'proj', sessionIds: ['session-1'] }] };
  return {
    id,
    displayName: id,
    defaultIncluded: true,
    portability: 'platformSpecific',
    async export(): Promise<ExportSection> {
      return { sectionId: id, data, counts: {}, warnings: [] };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<PlanItem[]> {
      return [{
        id: id + ':only',
        kind: 'Create',
        adapter: id,
        description: id,
        severity: 'info',
        target: { adapter: id, ref: 'only' },
      }];
    },
    async applyItem(): Promise<{ ok: boolean }> { return { ok: true }; },
    ...(id === 'sessions'
      ? { async finalizeApply(): Promise<ApplyResult[]> { order.push('sessions:finalizeApply'); return [{ ok: true, message: 'sessions finalized' }]; } }
      : { async finalizeImport(): Promise<ApplyResult[]> { order.push('workspaces:finalizeImport'); return [{ ok: true, message: 'sessions attached' }]; } }),
  } as unknown as ConfigAdapter;
}

test('finalizeImport 必须在所有分区的 finalizeApply 之后执行（会话登记依赖会话已改写/归位）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-finalize-order-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const zipPath = path.join(dir, 'both.zip');

  const order: string[] = [];
  const adapters = [stub('workspaces', order), stub('sessions', order)];
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
    .export({ includeSecrets: false, only: ['workspaces', 'sessions'], outPath: zipPath });

  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
  const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
  const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });

  assert.ok(order.includes('sessions:finalizeApply'), '会话分区收尾必须执行');
  assert.ok(order.includes('workspaces:finalizeImport'), '工作区登记收尾必须执行');
  assert.ok(
    order.indexOf('sessions:finalizeApply') < order.indexOf('workspaces:finalizeImport'),
    '登记必须发生在会话收尾之后；实际顺序=' + JSON.stringify(order),
  );
  const ids = result.executed.map((item) => item.itemId);
  assert.ok(ids.includes('sessions:finalize'), '会话收尾结果进入报告');
  assert.ok(ids.includes('workspaces:finalizeImport'), '登记结果进入报告');
});
