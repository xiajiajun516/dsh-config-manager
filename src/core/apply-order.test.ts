/**
 * APPLY_ORDER 序位回归（t35）：端到端证明 **sessions 计划项真的进入执行循环**。
 *
 * 背景（批次 4 修复 + 验证者 t33 实测）：analyzer 的 APPLY_ORDER 曾手抄 13 项，漏了 secrets 与
 * sessions 两个序位 —— 后果是 sessions 计划项**根本不进执行循环**（静默跳过），而当时
 * roundtrip / sessions / analyzer-mapping / sync-engine **全绿**：该缺陷此前零覆盖。
 *
 * 本文件补的正是那条端到端断言：真实导出 ZIP → createImportPlan → executeImportPlan，
 * 断言 sessions 项出现在执行结果里、且 applyItem 以该条被调用。它不依赖任何源码文本锚点
 * （注释改动不会假绿），而是靠行为 —— 故把 APPLY_ORDER 退回旧手抄清单时必然变红（见 t35 output 的
 * 临时回退实验探针输出）。
 *
 * 另覆盖 secrets 的分区语义一致性：无 ZIP 载荷、必须有序位、不得作为快照目标（t30 显式报错）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { APPLY_ORDER } from './analyzer.ts';
import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { createSnapshot } from './backup.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { SECTION_IDS, sectionMeta } from '../schema/config.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { ConfigAdapter, ExportSection, ImportContext, ImportPlan, PlanItem } from './types.ts';

/* ------------------------------------------------------------ 夹具 */

/** 会话日志的相对路径（形态与 SessionsAdapter 的 relativePath 一致：<projectKey>/<sessionId>/<file>） */
const SESSION_REL = '--proj--/s1/session-1.jsonl.zstd';
const SESSION_ITEM_ID = `sessions:${SESSION_REL}`;

async function tmpDir(t: { after: (fn: () => Promise<void> | void) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-order-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** 会话 adapter 替身：export 产出 sessions 分区载荷，analyzeImport 由载荷派生计划项，applyItem 记账 */
function sessionsAdapter(applied: string[]): ConfigAdapter {
  const bytes = new TextEncoder().encode('fake-zstd-frame-bytes');
  return {
    id: 'sessions',
    displayName: 'Sessions',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'sessions',
        data: { version: 1, files: [{ relativePath: SESSION_REL, contentHash: sha256Hex(bytes), data: bytes }] },
        counts: { files: 1 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(data: unknown, _ctx: ImportContext) {
      const files = (data as { files?: { relativePath?: unknown }[] }).files ?? [];
      const items: PlanItem[] = [];
      for (const f of files) {
        if (typeof f.relativePath !== 'string' || f.relativePath === '') continue;
        items.push({
          id: `sessions:${f.relativePath}`,
          kind: 'Create',
          adapter: 'sessions',
          description: f.relativePath,
          severity: 'info',
          target: { adapter: 'sessions', ref: f.relativePath },
        });
      }
      return items;
    },
    async applyItem(item: PlanItem, _ctx: ImportContext) { applied.push(item.id); return { ok: true }; },
  } as unknown as ConfigAdapter;
}

/** 真实导出：产出含 sessions 分区（1 个会话日志）的备份 ZIP */
async function exportSessionsZip(outPath: string): Promise<void> {
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({
    ctx: src,
    adapters: [sessionsAdapter([])],
    now: () => new Date('2026-09-22T00:00:00.000Z'),
  }).export({ includeSecrets: false, only: ['sessions'], outPath });
}

function planOf(items: PlanItem[]): ImportPlan {
  return {
    items,
    globalStrategy: 'merge',
    pathMappings: [],
    missingSecrets: [],
    needsRestart: false,
    estimatedActions: {} as ImportPlan['estimatedActions'],
  };
}

/* ------------------------------------------------------------ 端到端：sessions 必须真的被执行 */

test('sessions 计划项必须进入执行循环（真实 ZIP → createImportPlan → executeImportPlan）', async (t) => {
  const dir = await tmpDir(t);
  const zipPath = path.join(dir, 'sessions-backup.zip');
  await exportSessionsZip(zipPath);

  const applied: string[] = [];
  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  const store = new MemSnapshotStore();
  const importer = new Importer({ ctx: dst, adapters: [sessionsAdapter(applied)], snapshotStore: store });

  // 1) 计划必须包含 sessions 项（前置条件：载荷解析正确）
  const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
  const planIds = plan.items.map((i) => i.id);
  assert.ok(
    planIds.includes(SESSION_ITEM_ID),
    `计划里必须有 sessions 项；实际=${JSON.stringify(planIds)}`,
  );

  // 2) 执行：sessions 项必须真的走到 applyItem（而不是被 APPLY_ORDER 静默跳过）
  const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
  const executedIds = result.executed.map((e) => e.itemId);
  assert.ok(
    executedIds.includes(SESSION_ITEM_ID),
    `sessions 计划项必须进入执行循环；实际执行项=${JSON.stringify(executedIds)}`,
  );
  assert.deepEqual(
    applied,
    [SESSION_ITEM_ID],
    `applyItem 必须以该 sessions 条被调用；实际=${JSON.stringify(applied)}`,
  );
  assert.equal(result.executed.find((e) => e.itemId === SESSION_ITEM_ID)?.status, 'ok');
  assert.equal(result.ok, true);
  assert.notEqual(result.snapshotId, '', '导入前强制快照必须已建立');
});

test('APPLY_ORDER 必须覆盖注册表全集（手抄 13 项漏 secrets/sessions 的回归）', () => {
  const missing = SECTION_IDS.filter((id) => !APPLY_ORDER.includes(id));
  assert.deepEqual(
    missing,
    [],
    `APPLY_ORDER 缺序位的分区会被执行循环静默跳过（t33 探针风格：missing=${JSON.stringify(missing)}）`,
  );
  // sessions 正是当年被漏掉的那一项 —— 单列断言，失败信息直指问题
  assert.ok(APPLY_ORDER.includes('sessions'), 'sessions 必须有序位（漏掉它 = 会话分区永远不被执行）');
  assert.ok(APPLY_ORDER.includes('secrets'), 'secrets 必须有序位（与 sessions 同批漏掉过）');
});

/* ------------------------------------------------------------ secrets 分区语义一致性 */

test('secrets：无 ZIP 载荷、必须有序位、不得作为快照目标（显式报错而非静默错分）', async (t) => {
  // ① 注册表事实：secrets 没有分区载荷（凭据值走独立加密容器），因此没有 adapter 会消费它
  assert.equal(sectionMeta('secrets').payload.kind, 'none', 'secrets 无 ZIP 内分区载荷');
  // ② 序位：与 sessions 同批被手抄清单漏掉过 —— 缺序位就会被静默跳过
  assert.ok(APPLY_ORDER.includes('secrets'), 'secrets 必须有序位');

  // ③ 不得作为快照目标：t30 起显式报错，绝不静默记成 settingsNamespace（否则写入无法回滚）
  const dir = await tmpDir(t);
  const zipPath = path.join(dir, 'sessions-backup.zip');
  await exportSessionsZip(zipPath);
  const store = new MemSnapshotStore();
  const secretItem: PlanItem = {
    id: 'secrets:DEMO_KEY',
    kind: 'Update',
    adapter: 'secrets',
    description: '凭据占位（绝不应成为写入目标）',
    severity: 'info',
    target: { adapter: 'secrets', ref: 'DEMO_KEY' },
  };
  await assert.rejects(
    () => createSnapshot({
      ctx: makeContext('win32', 'C:/dst-home/.dsh', 'web'),
      plan: planOf([secretItem]),
      sourceZip: zipPath,
      store,
      adapters: [],
    }),
    /secrets 分区/,
    'secrets 不应作为快照目标（凭据值走独立加密容器）',
  );
  assert.equal(store.snapshots.size, 0, '拒绝时不得留下半成品快照');
});
