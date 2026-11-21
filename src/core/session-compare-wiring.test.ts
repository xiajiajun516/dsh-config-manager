/**
 * P3 接线：会话逐条比对的结果必须一路走到「告警 + 计划项标记」。
 *
 * 三层各自的单测已在 core/session-compare.test.ts（纯函数）与 adapters/sessions.test.ts
 * （适配器读本机）覆盖；这里钉的是**接线**：
 *   适配器 compareSessions → analyzer.resolveSessionCompare → analyzeImport.sessionCompare
 *                          → 告警文案 → createImportPlan 的 item.sessionVerdict
 * 任何一环断掉，用户就只会看到「导入成功」，而本机被覆盖掉的新消息没人提。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { ConfigAdapter, ExportSection, PlanItem, SessionCompareSummary } from './types.ts';

const HEX = 'a'.repeat(64);
const ATTACHMENT_ID = 'sha256:' + HEX;

function sessionBytes(): Uint8Array {
  return new Uint8Array(encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id: 'session-1' }) + '\n', 'utf8')));
}

function sessionsStub(compare?: () => Promise<SessionCompareSummary | null>): ConfigAdapter {
  const bytes = sessionBytes();
  return {
    id: 'sessions',
    displayName: 'Sessions',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'sessions',
        data: { version: 1, files: [{ relativePath: '--proj--/s1/session.jsonl.zstd', contentHash: sha256Hex(bytes), data: bytes }] },
        counts: { files: 1 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(data: unknown): Promise<PlanItem[]> {
      const files = (data as { files?: { relativePath: string }[] }).files ?? [];
      return files.map((f) => {
        const parts = f.relativePath.split('/');
        return {
          id: 'sessions:' + f.relativePath,
          unitId: 'sessions:' + parts.slice(0, 2).join('/'),
          kind: 'Create',
          adapter: 'sessions',
          description: f.relativePath,
          severity: 'info',
        } as PlanItem;
      });
    },
    async applyItem() { return { ok: true }; },
    ...(compare === undefined ? {} : { compareSessions: compare }),
  } as unknown as ConfigAdapter;
}

function workspacesStub(): ConfigAdapter {
  return {
    id: 'workspaces',
    displayName: 'Workspaces',
    defaultIncluded: true,
    portability: 'platformSpecific',
    async export(): Promise<ExportSection> {
      return { sectionId: 'workspaces', data: { version: 1, workspaces: [] }, counts: {}, warnings: [] };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<PlanItem[]> { return []; },
    async applyItem() { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

/** 附件分区桩：只是让 resolveSessionCompare 能看见「包内确实带了这个对象」。 */
function attachmentsStub(withObject: boolean): ConfigAdapter {
  const data = new Uint8Array([1]);
  return {
    id: 'attachments',
    displayName: 'Attachments',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'attachments',
        data: {
          version: 1,
          files: withObject
            ? [{ relativePath: 'attachments/v1/objects/' + HEX.slice(0, 2) + '/' + HEX, contentHash: sha256Hex(data), data }]
            : [],
        },
        counts: { files: withObject ? 1 : 0 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<PlanItem[]> { return []; },
    async applyItem() { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-compare-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const LOCAL_AHEAD: SessionCompareSummary = {
  rows: [{
    unitId: '--proj--/s1',
    verdict: 'localAhead',
    packEvents: 4,
    localEvents: 7,
    localAheadBy: 3,
  }],
  skipped: 0,
  attachmentsReferenced: 1,
  attachmentsMissing: [ATTACHMENT_ID],
};

async function run(
  dir: string,
  adapters: ConfigAdapter[],
): Promise<{ analysis: Awaited<ReturnType<Importer['analyzeImport']>>; zipPath: string }> {
  const zipPath = path.join(dir, 'bundle.zip');
  const only = adapters.map((a) => a.id);
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
    .export({ includeSecrets: false, only, outPath: zipPath });
  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
  return { analysis: await importer.analyzeImport(zipPath), zipPath };
}

test('P3 接线：localAhead → 分析阶段告警「会覆盖掉本机新消息」+ 计划项带 sessionVerdict 与 warning 严重度', async () => {
  await withTmp(async (dir) => {
    const adapters = [workspacesStub(), sessionsStub(async () => LOCAL_AHEAD)];
    const { analysis, zipPath } = await run(dir, adapters);

    assert.equal(analysis.sessionCompare?.rows[0]?.verdict, 'localAhead', '结构化摘要必须原样进分析结果');
    assert.ok(
      analysis.warnings.some((line) => /覆盖掉/.test(line) && /3/.test(line)),
      '必须在点执行之前就说清「会覆盖掉 3 条」：' + JSON.stringify(analysis.warnings),
    );

    const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    const marked = plan.items.filter((item) => item.sessionVerdict !== undefined);
    assert.equal(marked.length, 1, '计划项必须带上结论：' + JSON.stringify(plan.items.map((i) => [i.id, i.unitId])));
    assert.equal(marked[0]?.unitId, 'sessions:--proj--/s1', '计划项 unitId 带适配器前缀，键归一后仍要命中');
    assert.deepEqual(marked[0]?.sessionVerdict, {
      verdict: 'localAhead',
      packEvents: 4,
      localEvents: 7,
      localAheadBy: 3,
    });
    assert.equal(marked[0]?.severity, 'warning', '会丢数据的那一条必须显式标警告');
  });
});

test('P3 接线：包内确实带了该附件 → 缺失清单被对账清空，不再告警', async () => {
  await withTmp(async (dir) => {
    const adapters = [workspacesStub(), sessionsStub(async () => LOCAL_AHEAD), attachmentsStub(true)];
    const { analysis } = await run(dir, adapters);
    assert.deepEqual(analysis.sessionCompare?.attachmentsMissing, [], '包里有这个对象就不该报缺失');
    assert.equal(analysis.sessionCompare?.attachmentsReferenced, 1, '被引用数照旧上报');
    assert.equal(
      analysis.warnings.some((line) => /没有随包/.test(line)),
      false,
      '不缺失就不能报缺：' + JSON.stringify(analysis.warnings),
    );
  });
});

test('P3 接线：包内没带该附件 → 告警列出缺口（用户点执行前就知道会有打不开的图）', async () => {
  await withTmp(async (dir) => {
    const adapters = [workspacesStub(), sessionsStub(async () => LOCAL_AHEAD), attachmentsStub(false)];
    const { analysis } = await run(dir, adapters);
    assert.deepEqual(analysis.sessionCompare?.attachmentsMissing, [ATTACHMENT_ID]);
    assert.ok(
      analysis.warnings.some((line) => /没有随包/.test(line)),
      '缺附件必须告警：' + JSON.stringify(analysis.warnings),
    );
  });
});

test('P3 接线：适配器没有比对能力 → 分析结果不带 sessionCompare，也不产生任何相关告警（不许编造「全部一致」）', async () => {
  await withTmp(async (dir) => {
    const adapters = [workspacesStub(), sessionsStub()];
    const { analysis } = await run(dir, adapters);
    assert.equal(analysis.sessionCompare, undefined, '没比对就不能有字段（UI 据此不渲染）');
    assert.equal(
      analysis.warnings.some((line) => /覆盖掉|没有随包|抽查/.test(line)),
      false,
      '没有比对就没有结论：' + JSON.stringify(analysis.warnings),
    );
  });
});
