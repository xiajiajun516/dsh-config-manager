/**
 * 导出耦合回归（issue #45 新流程）：勾选/导出 sessions 时**自动连带**这些会话所属的工作区记录。
 *
 * 为什么必须钉住：DSH 里会话能否显示取决于「有没有一条工作区记录指向它的 cwd 且 id 在 sessionIds 里」，
 * 只带会话不带工作区 = 目标机必然「数据恢复了却显示不出来」。这条依赖用户不该记，所以由导出侧自动带上，
 * 并在报告里可见（warning 一行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { makeContext } from '../adapters/test-helpers.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { parseZip } from '../utils/zip.ts';
import type { ConfigAdapter, ExportOptions, ExportSection } from './types.ts';
import type { SectionId, WorkspaceRecord } from '../schema/types.ts';

const BYTES = new TextEncoder().encode('fake-session-log-bytes');

function record(id: string, sessionIds: string[]): WorkspaceRecord {
  return { id, path: 'D:/' + id, title: id, sessionIds, createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' };
}

/** workspaces 替身：记录收到的 includeItems.workspaces（undefined = 没被限制）；records 决定实际导出的记录 */
function workspacesStub(seen: { ids?: string[] }, records: WorkspaceRecord[] = []): ConfigAdapter {
  return {
    id: 'workspaces' as SectionId,
    displayName: 'Workspaces',
    defaultIncluded: true,
    portability: 'platformSpecific',
    async export(_ctx: unknown, options: ExportOptions): Promise<ExportSection> {
      seen.ids = options.includeItems?.['workspaces'];
      return { sectionId: 'workspaces' as SectionId, data: { version: 1, workspaces: records }, counts: {}, warnings: [] };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<never[]> { return []; },
    async applyItem(): Promise<{ ok: boolean }> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

/** sessions 替身：产出一个会话文件（id 可由 unit 白名单过滤，简化：总是产出 --proj--/s1） */
function sessionsStub(): ConfigAdapter {
  return {
    id: 'sessions' as SectionId,
    displayName: 'Sessions',
    defaultIncluded: false,
    portability: 'deviceSpecific',
    async export(): Promise<ExportSection> {
      return {
        sectionId: 'sessions' as SectionId,
        // 文件名用真实形态 `session.jsonl.zstd`（`session-1.jsonl.zstd` 不是合法会话日志名，会被按「运行文件」忽略）
        data: { version: 1, files: [{ relativePath: '--proj--/s1/session.jsonl.zstd', contentHash: sha256Hex(BYTES), data: BYTES }] },
        counts: { files: 1 },
        warnings: [],
      };
    },
    async validate(): Promise<{ valid: boolean; issues: [] }> { return { valid: true, issues: [] }; },
    async analyzeImport(): Promise<never[]> { return []; },
    async applyItem(): Promise<{ ok: boolean }> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-export-couple-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function seedWorkspaces(src: ReturnType<typeof makeContext>, records: WorkspaceRecord[]): void {
  src.workspace.listRecords = async () => records;
}

test('导出 sessions → 自动连带其所属工作区（精确匹配 sessionIds），并写进报告', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, [record('ws-own', ['s1']), record('ws-other', ['s9']), record('ws-empty', [])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--proj--/s1'] },
      outPath: path.join(dir, 'a.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-own'], '只连带拥有被选会话的工作区；用户没勾 workspaces 也要带');
    assert.ok(result.report.included.some((entry) => entry.section === ('workspaces' as SectionId)), '工作区分区被强制带上');
    assert.ok(result.report.warnings.some((line: string) => /已连带导出/.test(line)), '报告里必须看得见连带行为：' + JSON.stringify(result.report.warnings));
  });
});

test('导出 sessions（limit 模式，选中的是最新 N 个）→ 连带所有声明了 sessionIds 的工作区', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, [record('ws-a', ['s1']), record('ws-b', ['s9']), record('ws-empty', [])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    await exporter.export({ includeSecrets: false, sessions: { limit: 1 }, outPath: path.join(dir, 'b.zip') });
    assert.deepEqual(seen.ids, ['workspace:ws-a', 'workspace:ws-b'], '无法精确匹配时宽进：所有带会话的工作区都带');
  });
});

test('issue #45 ③：勾选的会话即使不在工作区 sessionIds 里，也会被声明进所属工作区记录（包自洽）', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    // /proj 的 cwd 目录键 == sessionsStub 产出的 --proj--（归属判据与选择器同一口径）
    const projRecord: WorkspaceRecord = {
      id: 'ws-proj', path: '/proj', title: 'proj', sessionIds: ['session-other'],
      createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    };
    seedWorkspaces(src, [projRecord]);
    const exporter = new Exporter({
      ctx: src,
      adapters: [workspacesStub(seen, [projRecord]), sessionsStub()],
      now: () => new Date('2026-09-22T00:00:00.000Z'),
    });
    const zipPath = path.join(dir, 'declared.zip');
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--proj--/s1'] },
      outPath: zipPath,
    });
    assert.deepEqual(seen.ids, ['workspace:ws-proj'], '连带仍按归属匹配');
    // 从**产物 zip**里读回来（不是内存对象）：这才是目标机真正拿到的东西
    const archive = parseZip(new Uint8Array(await fs.readFile(zipPath)));
    const data = archive.readEntryJson('workspaces/workspaces.json') as { workspaces: WorkspaceRecord[] };
    assert.deepEqual(data.workspaces[0]?.sessionIds, ['session-other', 's1'],
      '导出的工作区记录必须声明包内实际带数据的会话（写日志侧原名 = header id）；注册表原有 id 保留');
    assert.ok(
      result.report.warnings.some((line: string) => /已把本次导出的 1 次会话声明进/.test(line)),
      '宣告行为必须在报告里可见：' + JSON.stringify(result.report.warnings),
    );
  });
});

test('不导出 sessions → 不连带（工作区白名单保持用户原样）', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, [record('ws-own', ['s1'])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['workspaces'],
      includeItems: { workspaces: ['workspace:ws-own'] },
      outPath: path.join(dir, 'c.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-own'], '用户自己选的保持不变');
    assert.equal(result.report.warnings.some((line: string) => /已连带导出/.test(line)), false, '没有会话就不该出现连带提示');
  });
});
test('加固：会话没登记进任何工作区 → 整分区带上工作区（绝不产出「有会话、没工作区」的包）', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, [record('ws-a', ['other-1']), record('ws-b', ['other-2'])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--proj--/s1'] },
      outPath: path.join(dir, 'd.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-a', 'workspace:ws-b'], '归属判定不出来 → 整分区带上，宁可多带元数据');
    assert.ok(result.report.included.some((entry) => entry.section === ('workspaces' as SectionId)), '工作区分区被强制带上');
    assert.ok(result.report.warnings.some((line: string) => /已连带导出全部/.test(line)), '报告必须说明是整分区带的：' + JSON.stringify(result.report.warnings));
  });
});

test('加固：本机一条工作区记录都没有 → 会话照常导出，但必须显式告警（不再静默）', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, []);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({ includeSecrets: false, only: ['sessions'], outPath: path.join(dir, 'e.zip') });
    assert.equal(seen.ids, undefined, '没有记录就不强塞空白名单（不产出空载荷分区）');
    assert.ok(result.report.included.some((entry) => entry.section === ('sessions' as SectionId)), '会话照常导出');
    assert.ok(result.report.warnings.some((line: string) => /没有任何工作区记录/.test(line)), '必须告警：' + JSON.stringify(result.report.warnings));
  });
});

test('加固：用户「把工作区全部取消勾选」（includeItems.workspaces = []）不能把连带的包变成无工作区', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    seedWorkspaces(src, [record('ws-own', ['s1'])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--proj--/s1'], workspaces: [] },
      outPath: path.join(dir, 'f.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-own'], '连带白名单必须作用到分区过滤：否则 [] 会把刚强制选中的分区再挡掉');
    assert.ok(result.report.included.some((entry) => entry.section === ('workspaces' as SectionId)), '回归：工作区分区不得被空白名单挡掉');
  });
});

test('连带匹配：会话目录名是裸 uuid（新形态）、注册表写 session-<uuid> → 仍精确认出所属工作区', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    // 真机形态：目录名是裸 uuid，注册表里是全量 id
    seedWorkspaces(src, [record('ws-own', ['session-2b549283-846a-47ab-a438-d69d977d48e3']), record('ws-other', ['session-deadbeef-0000-0000-0000-000000000000'])]);
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--proj--/2b549283-846a-47ab-a438-d69d977d48e3'] },
      outPath: path.join(dir, 'h.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-own'], '归一化后必须精确命中（不是「整分区带上」）');
    assert.ok(result.report.warnings.some((line: string) => /已连带导出 1 条/.test(line)), '报告应写精确连带条数：' + JSON.stringify(result.report.warnings));
  });
});

test('连带匹配：工作区 sessionIds 里没有这条会话 → 按 cwd 目录键（工作区 path）精确认领', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    src.workspace.listRecords = async () => [
      { id: 'ws-repo', path: 'D:/Projects/repo', title: 'repo', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
      { id: 'ws-other', path: 'D:/Elsewhere', title: 'other', sessionIds: [], createdAt: 'x', updatedAt: 'x' },
    ];
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({
      includeSecrets: false,
      only: ['sessions'],
      includeItems: { sessions: ['sessions:--D-Projects-repo--/2b549283-846a-47ab-a438-d69d977d48e3'] },
      outPath: path.join(dir, 'i.zip'),
    });
    assert.deepEqual(seen.ids, ['workspace:ws-repo'], 'projectKey 命中即认领（不是「整分区带上」）');
    assert.ok(result.report.warnings.some((line: string) => /已连带导出 1 条/.test(line)), '精确连带 1 条：' + JSON.stringify(result.report.warnings));
  });
});

test('加固：读不到工作区注册表 → 导出照常完成 + 告警（绝不因连带失败而让导出整体失败）', async () => {
  await withTmp(async (dir) => {
    const seen: { ids?: string[] } = {};
    const src = makeContext('win32', 'C:/src-home/.dsh', 'web');
    src.workspace.listRecords = async () => { throw new Error('registry down'); };
    const exporter = new Exporter({ ctx: src, adapters: [workspacesStub(seen), sessionsStub()], now: () => new Date('2026-09-22T00:00:00.000Z') });
    const result = await exporter.export({ includeSecrets: false, only: ['sessions'], outPath: path.join(dir, 'g.zip') });
    assert.ok(result.report.included.some((entry) => entry.section === ('sessions' as SectionId)), '会话仍然导出');
    assert.ok(result.report.warnings.some((line: string) => /读不到本机工作区记录/.test(line)), '必须告警：' + JSON.stringify(result.report.warnings));
  });
});
