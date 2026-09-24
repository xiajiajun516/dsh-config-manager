/**
 * 跨机基础路径自动重定基（issue #45 用户补充）。
 *
 * 场景：不同设备上 DSH 的基础路径（$DSH_HOME，如 /opt/dsh/.dsh）可能不同，而备份里的路径是绝对路径
 * （会话首帧 cwd、工作区 path…）—— 即便目标机把目录建出来，路径语义仍然错。做法：导出时把**导出机的
 * home** 写进 manifest，导入时若与本机 home 不同，就自动把「位于导出机 home 之下的路径」重定基到
 * 本机 home（同一后缀），排在用户映射之前；用户映射仍可覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from './exporter.ts';
import { Importer } from './importer.ts';
import { rebaseMapping } from './analyzer.ts';
import { MemSnapshotStore, makeContext } from '../adapters/test-helpers.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { ApplyResult, ConfigAdapter, ExportSection, PathMapping, PlanItem } from './types.ts';

const BYTES = new TextEncoder().encode('fake-session-log-bytes');

/** 最小 adapter 替身：workspaces 一条记录（path 在导出机 home 之下）+ sessions 一个会话单元。 */
function stub(id: 'workspaces' | 'sessions', sourceHome: string): ConfigAdapter {
  const data = id === 'sessions'
    ? { version: 1, files: [{ relativePath: '--opt-dsh-proj--/s1/session.v3.jsonl.zstd', contentHash: sha256Hex(BYTES), data: BYTES }] }
    : { version: 1, workspaces: [{ id: 'ws-1', path: sourceHome + '/proj', title: 'proj', sessionIds: ['s1'] }] };
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
      return [{ id: id + ':only', kind: 'Create', adapter: id, description: id, severity: 'info', target: { adapter: id, ref: 'only' } }];
    },
    async applyItem(): Promise<ApplyResult> { return { ok: true }; },
  } as unknown as ConfigAdapter;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-rebase-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 用 sourceHome 导出一个小备份（manifest 里带上 sourceHome）。 */
async function exportBundle(zipPath: string, sourceHome: string): Promise<void> {
  const src = makeContext('linux', sourceHome, 'web');
  await new Exporter({
    ctx: src,
    adapters: [stub('workspaces', sourceHome), stub('sessions', sourceHome)],
    now: () => new Date('2026-09-22T00:00:00.000Z'),
  }).export({ includeSecrets: false, only: ['workspaces', 'sessions'], outPath: zipPath });
}

test('rebaseMapping：不同绝对基础路径才生成规则（同路径/缺失/相对路径一律不猜）', () => {
  assert.deepEqual(rebaseMapping('/opt/dsh/.dsh/', '/home/bob/.dsh'), { oldPrefix: '/opt/dsh/.dsh', newPrefix: '/home/bob/.dsh', appliesTo: [] });
  assert.deepEqual(rebaseMapping('C:\\Tools\\.dsh', 'D:/home/.dsh'), { oldPrefix: 'C:/Tools/.dsh', newPrefix: 'D:/home/.dsh', appliesTo: [] });
  assert.equal(rebaseMapping('/opt/dsh/.dsh', '/opt/dsh/.dsh/'), undefined, '同路径（仅尾斜杠不同）→ 不重定基');
  assert.equal(rebaseMapping(undefined, '/home/bob/.dsh'), undefined, '旧包没有 sourceHome → 不猜');
  assert.equal(rebaseMapping('', '/home/bob/.dsh'), undefined);
  assert.equal(rebaseMapping('opt/dsh/.dsh', '/home/bob/.dsh'), undefined, '相对 sourceHome → 不重定基');
});

test('导入：导出机 home ≠ 本机 home → 自动重定基规则排在用户映射之前，并写进计划', async (t) => {
  await withTmp(async (dir) => {
    const zipPath = path.join(dir, 'bundle.zip');
    await exportBundle(zipPath, '/opt/dsh/.dsh');
    const dst = makeContext('linux', '/home/bob/.dsh', 'web');
    const importer = new Importer({ ctx: dst, adapters: [stub('workspaces', '/opt/dsh/.dsh'), stub('sessions', '/opt/dsh/.dsh')], snapshotStore: new MemSnapshotStore() });
    const userMapping: PathMapping = { oldPrefix: '/opt/dsh/.dsh/proj', newPrefix: '/home/bob/work', appliesTo: [] };
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [userMapping] });
    assert.deepEqual(plan.automaticMappings, [{ oldPrefix: '/opt/dsh/.dsh', newPrefix: '/home/bob/.dsh', appliesTo: [] }]);
    assert.equal(plan.pathMappings[0]?.oldPrefix, '/opt/dsh/.dsh', '重定基排在第一位（基础路径先定，用户映射再覆盖）');
    assert.deepEqual(plan.pathMappings[1], userMapping, '用户映射紧随其后且原样保留');
  });
});

test('导入：两边 home 相同 → 不产生任何自动改写（行为与改造前一致）', async (t) => {
  await withTmp(async (dir) => {
    const zipPath = path.join(dir, 'bundle.zip');
    await exportBundle(zipPath, '/home/bob/.dsh');
    const dst = makeContext('linux', '/home/bob/.dsh', 'web');
    const importer = new Importer({ ctx: dst, adapters: [stub('workspaces', '/home/bob/.dsh'), stub('sessions', '/home/bob/.dsh')], snapshotStore: new MemSnapshotStore() });
    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.equal(plan.automaticMappings, undefined);
    assert.deepEqual(plan.pathMappings, []);
  });
});
