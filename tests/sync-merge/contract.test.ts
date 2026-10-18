/**
 * 场景 17：客户端 / 服务端契约兼容。
 *
 * 三条独立证据（不依赖被测方自述）：
 *  ① 引擎层 previewMerge / applyMergeResolutions 的**运行时字段集合**与冻结类型一致，
 *     且只含文档化字段（多出未声明字段 = 客户端会拿到没约定的数据）；
 *  ② 路由侧确实按 kit 声明了 merge-preview / apply-merge，并接到引擎方法上；
 *  ③ 客户端类型（sync-api.ts）里新响应类型字段齐备、**旧类型未被移除**（源码级断言）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSharedDevices, makeRoot, readSkill, setNamespace, writeSkill } from './helpers.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 读源码（断言契约用；避免把 client 类型引入 node 测试的编译面）。 */
async function readSource(rel: string): Promise<string> {
  return await fs.readFile(path.join(repoRoot, rel), 'utf8');
}

async function setupConflict(root: string) {
  const { devices } = await createSharedDevices(root, ['a', 'b']);
  const a = devices['a']!;
  const b = devices['b']!;
  await writeSkill(a, 'coding.md', '# Coding\n');
  await writeSkill(b, 'coding.md', '# Coding\n');
  setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  setNamespace(b, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
  await a.engine.push({ snapshotId: 'a-1' });
  setNamespace(a, 'general', { theme: 'blue', language: 'zh-CN' }, 4);
  await writeSkill(a, 'coding.md', '# Coding by A\n');
  setNamespace(b, 'general', { theme: 'red', language: 'zh-CN' }, 4);
  await writeSkill(b, 'writing.md', '# Writing by B\n');
  await b.engine.push({ snapshotId: 'b-1' });
  return a;
}

test('契约 ①：previewMerge 返回的字段集合 = 冻结类型（含冲突三侧预览），不多不少', async () => {
  const root = await makeRoot('contract-preview-keys');
  try {
    const a = await setupConflict(root);
    const preview = (await a.engine.previewMerge()) as unknown as Record<string, unknown>;
    const allowed = new Set(['ok', 'snapshotId', 'hasAncestor', 'sections', 'summary', 'message']);
    for (const key of Object.keys(preview)) {
      assert.ok(allowed.has(key), 'previewMerge 出现未声明字段: ' + key);
    }
    for (const required of ['ok', 'snapshotId', 'hasAncestor', 'sections', 'summary']) {
      assert.ok(required in preview, '缺少契约字段: ' + required);
    }
    const summaryKeys = new Set(Object.keys(preview['summary'] as object));
    assert.deepEqual([...summaryKeys].sort(), ['auto', 'conflicts', 'review', 'skipped']);

    const sections = preview['sections'] as Array<Record<string, unknown>>;
    for (const s of sections) {
      for (const key of Object.keys(s)) {
        assert.ok(['id', 'decision', 'autoMerged', 'conflictCount', 'conflicts'].includes(key), '分区视图未声明字段: ' + key);
      }
      assert.ok(['useRemote', 'keepLocal', 'merge', 'skip', 'conflict'].includes(String(s['decision'])));
      assert.equal(typeof s['conflictCount'], 'number');
      const conflicts = s['conflicts'] as Array<Record<string, unknown>>;
      for (const c of conflicts) {
        for (const key of Object.keys(c)) {
          assert.ok(['path', 'kind', 'reason', 'localPreview', 'remotePreview', 'ancestorPreview'].includes(key), '冲突视图未声明字段: ' + key);
        }
        assert.equal(typeof c['localPreview'], 'string');
        assert.equal(typeof c['remotePreview'], 'string');
        assert.equal(typeof c['ancestorPreview'], 'string');
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('契约 ①b：applyMergeResolutions 报告 = ApplyReport + pendingConflicts（沿用旧字段，不删不改名）', async () => {
  const root = await makeRoot('contract-apply-report');
  try {
    const a = await setupConflict(root);
    const report = (await a.engine.applyMergeResolutions([{ id: 'settings', action: 'skip' }])) as unknown as Record<string, unknown>;
    const allowed = new Set(['ok', 'applied', 'restoreId', 'rolledBack', 'review', 'warnings', 'rollbackFull', 'pendingConflicts']);
    for (const key of Object.keys(report)) {
      assert.ok(allowed.has(key), 'applyMergeResolutions 出现未声明字段: ' + key);
    }
    for (const required of ['ok', 'applied', 'restoreId', 'rolledBack', 'review', 'warnings', 'pendingConflicts']) {
      assert.ok(required in report, '缺少契约字段: ' + required);
    }
    assert.ok(Array.isArray(report['applied']));
    assert.ok(Array.isArray(report['pendingConflicts']));
    assert.ok(Array.isArray(report['warnings']));
    assert.equal(await readSkill(a, 'coding.md'), '# Coding by A\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('契约 ②：路由按 kit 声明两条合并接口，并接到引擎的 previewMerge / applyMergeResolutions', async () => {
  const src = await readSource('src/routes/sync.ts');
  const preview = src.indexOf("/sync/merge-preview");
  const apply = src.indexOf("/sync/apply-merge");
  assert.ok(preview > 0, '缺少 /sync/merge-preview 路由声明');
  assert.ok(apply > 0, '缺少 /sync/apply-merge 路由声明');
  assert.ok(src.includes('engine.previewMerge('), 'merge-preview 必须调用引擎 previewMerge');
  assert.ok(src.includes('engine.applyMergeResolutions('), 'apply-merge 必须调用引擎 applyMergeResolutions');
  // 写路径必须过 mutation gate；读路径必须是 POST 且解析 JSON body
  const applyIdx = src.indexOf("endpoint({ path: '/api/dsh-config-manager/sync/apply-merge'");
  assert.ok(src.slice(applyIdx, applyIdx + 200).includes('withMutationGate'), 'apply-merge 必须过 mutation gate');
  const previewIdx = src.indexOf("endpoint({ path: '/api/dsh-config-manager/sync/merge-preview'");
  assert.ok(src.slice(previewIdx, previewIdx + 200).includes("methods: ['POST']"), 'merge-preview 必须是 POST（请求体带密码/路径映射）');
});

test('契约 ③：客户端类型齐备，且旧响应类型仍在（旧字段未被移除）', async () => {
  const src = await readSource('src/client/sync/sync-api.ts');
  assert.ok(src.includes('export interface MergePreviewResponse'), '缺少 MergePreviewResponse');
  assert.ok(src.includes('export interface MergeApplyResponse'), '缺少 MergeApplyResponse');

  const bodyOf = (name: string): string => {
    const at = src.indexOf('export interface ' + name);
    assert.ok(at >= 0, '缺少接口 ' + name);
    const end = src.indexOf('\n}', at);
    return src.slice(at, end > 0 ? end : at + 4000);
  };
  const previewBody = bodyOf('MergePreviewResponse');
  for (const field of ['ok', 'snapshotId', 'hasAncestor', 'sections', 'summary']) {
    assert.ok(previewBody.includes(field), 'MergePreviewResponse 缺少字段 ' + field);
  }
  const applyBody = bodyOf('MergeApplyResponse');
  for (const field of ['ok', 'applied', 'skipped', 'warnings', 'restoreId', 'rolledBack', 'pendingConflicts']) {
    assert.ok(applyBody.includes(field), 'MergeApplyResponse 缺少字段 ' + field);
  }
  // 旧的同步契约不得被这轮改动删掉/改名（客户端仍有调用方）
  for (const legacy of ['SyncStartResponse', 'ApplyItemsResponse', 'SyncHistoryResponse', 'SyncSnapshotsListResponse', 'SyncStatusResponse']) {
    assert.ok(src.includes('export interface ' + legacy), '旧契约被移除或改名: ' + legacy);
  }
});
