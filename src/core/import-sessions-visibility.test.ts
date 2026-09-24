/**
 * 导入侧加固（issue #45 真机事故）：备份里**有会话、没有工作区**时，必须在分析阶段就告警。
 *
 * 事故现场：源机那次导出用的是**未含耦合逻辑的插件构建**，于是包里只有会话文件；导入后会话在 DSH 的
 * 工作区列表里看不见，用户理解成「对话丢了」。工作区记录是会话可见性的前提（workspace.path 必须等于
 * 会话首帧 cwd，且 id 在 sessionIds 里），所以「有会话没工作区」的包在导入前就必须被指出来。
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

function sessionsStub(): ConfigAdapter {
  return {
    id: 'sessions',
    displayName: 'Sessions',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'sessions',
        data: { version: 1, files: [{ relativePath: '--proj--/s1/session-1.jsonl.zstd', contentHash: sha256Hex(BYTES), data: BYTES }] },
        counts: { files: 1 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<PlanItem[]> { return []; },
    async applyItem(): Promise<ApplyResult> { return { ok: true }; },
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
    async applyItem(): Promise<ApplyResult> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-import-visibility-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function analyze(dir: string, opts: { withWorkspaces: boolean }): Promise<string[]> {
  const zipPath = path.join(dir, opts.withWorkspaces ? 'both.zip' : 'sessions-only.zip');
  const adapters = opts.withWorkspaces ? [workspacesStub(), sessionsStub()] : [sessionsStub()];
  const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-09-22T00:00:00.000Z') })
    .export({ includeSecrets: false, only: opts.withWorkspaces ? ['sessions', 'workspaces'] : ['sessions'], outPath: zipPath });
  const dst = makeContext('win32', 'C:/dst-home/.dsh', 'web');
  const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });
  const analysis = await importer.analyzeImport(zipPath);
  return analysis.warnings;
}

test('分析阶段：包里有会话但没有工作区 → 告警「导入后这些对话可能看不见」', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: false });
    assert.ok(
      warnings.some((line) => /没有任何工作区记录/.test(line)),
      '必须在分析阶段告警（用户点执行之前就能看见）：' + JSON.stringify(warnings),
    );
  });
});

test('分析阶段：包里有工作区 → 不产生该告警（避免假阳性）', async () => {
  await withTmp(async (dir) => {
    const warnings = await analyze(dir, { withWorkspaces: true });
    assert.equal(warnings.some((line) => /没有任何工作区记录/.test(line)), false, '有工作区就不该告警：' + JSON.stringify(warnings));
  });
});
