/**
 * M4 restore 路由纯函数测试（criterion m4-gui-works；正式 TDD 证据归 t5 tester）。
 * 覆盖：buildRestoreBody 请求体校验（含路径穿越防御）、executeRestorePlan 执行器
 * 语义（整文件/文件还原与删除、插件卸载成败、凭据提示、跳过、逐项失败不拖垮其余）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRestoreBody, executeRestorePlan, type RestoreExecutor } from '../../src/index.ts';
import type { RestorePlan } from '../../src/core/restore.ts';

test('G-01 buildRestoreBody：合法/缺 id/非法 id/越界 id/dryRun 解析', () => {
  const ok = buildRestoreBody({ snapshotId: 'abc-123', dryRun: true });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.snapshotId, 'abc-123');
    assert.equal(ok.value.dryRun, true);
  }
  assert.equal(buildRestoreBody(undefined).ok, false, 'null/undefined → 错误');
  assert.equal(buildRestoreBody('str').ok, false, '非对象 → 错误');
  assert.equal(buildRestoreBody([]).ok, false, '数组 → 错误');
  assert.equal(buildRestoreBody({}).ok, false, '缺 snapshotId → 错误');
  assert.equal(buildRestoreBody({ snapshotId: '' }).ok, false, '空 snapshotId → 错误');
  assert.equal(buildRestoreBody({ snapshotId: 42 }).ok, false, '非字符串 snapshotId → 错误');
  for (const bad of ['.', '..', 'a/b', 'a\\b']) {
    const r = buildRestoreBody({ snapshotId: bad });
    assert.equal(r.ok, false, `越界 id 应拒绝: ${JSON.stringify(bad)}`);
  }
  const noDry = buildRestoreBody({ snapshotId: 'ok-id' });
  assert.ok(noDry.ok);
  if (noDry.ok) assert.equal(noDry.value.dryRun, false, '缺省 dryRun=false');
});

function makePlan(actions: RestorePlan['actions']): RestorePlan {
  return {
    snapshotId: 'snap-g1',
    createdAt: '2026-08-14T12:00:00.000Z',
    sourceZip: 'backup.zip',
    pluginBaselineConfirmed: true,
    actions,
    summary: {
      hostFileRestores: 0, hostFileRemoves: 0, pluginRemoves: 0,
      fileRestores: 0, fileRemoves: 0, credentialHints: 0, skips: 0,
    },
  };
}

test('G-02 executeRestorePlan：整文件/文件还原与删除 + pre-restore 双保险', async () => {
  const existing = new Set(['settings.yaml', 'profiles/web/cordis.patch.yml']);
  const calls: string[] = [];
  const exec: RestoreExecutor = {
    readBlob: async (blobPath) => Buffer.from(`blob:${blobPath}`, 'utf8'),
    savePreRestore: async (relPath) => { calls.push(`pre:${relPath}`) },
    existsHome: async (relPath) => existing.has(relPath),
    writeHome: async (relPath, data) => { calls.push(`write:${relPath}:${data.toString()}`) },
    removeHome: async (relPath) => { calls.push(`remove:${relPath}`) },
    uninstallPlugin: async () => ({ ok: true }),
  };

  const plan = makePlan([
    { kind: 'hostFileRestore', description: '整文件还原 settings.yaml', target: 'settings.yaml', blobPath: 'blobs/host/settings' },
    { kind: 'fileRestore', description: '还原文件 skills/coding.md', target: 'skills/coding.md', blobPath: 'blobs/skills-1' },
    { kind: 'hostFileRemove', description: '移除 profile patch', target: 'profiles/web/cordis.patch.yml' },
    { kind: 'fileRemove', description: '删除导入写入的文件 x.md', target: 'x.md' },
  ]);

  const report = await executeRestorePlan(plan, exec);
  assert.deepEqual(report.restored.sort(), ['profiles/web/cordis.patch.yml', 'settings.yaml', 'skills/coding.md', 'x.md']);
  assert.deepEqual(report.failed, []);
  // pre-restore 只对「当前存在」的目标调用（settings.yaml / profile patch 存在，skills/x.md 不存在）
  assert.deepEqual(calls.filter((c) => c.startsWith('pre:')).sort(), [
    'pre:profiles/web/cordis.patch.yml',
    'pre:settings.yaml',
  ]);
  assert.ok(calls.includes('write:settings.yaml:blob:blobs/host/settings'));
  assert.ok(calls.includes('write:skills/coding.md:blob:blobs/skills-1'));
  assert.ok(calls.includes('remove:profiles/web/cordis.patch.yml'));
});

test('G-03 executeRestorePlan：插件卸载成败、凭据提示、跳过、单项失败不拖垮其余', async () => {
  const uninstalled: string[] = [];
  const exec: RestoreExecutor = {
    readBlob: async () => Buffer.from('x'),
    savePreRestore: async () => {},
    existsHome: async () => false,
    writeHome: async () => {},
    removeHome: async () => {},
    uninstallPlugin: async (name) => {
      uninstalled.push(name);
      return name === 'good-plugin' ? { ok: true } : { ok: false, message: '模拟 pnpm 卸载失败' };
    },
  };

  const plan = makePlan([
    { kind: 'pluginRemove', description: '卸载 good-plugin', pluginName: 'good-plugin', target: 'good-plugin' },
    { kind: 'pluginRemove', description: '卸载 bad-plugin', pluginName: 'bad-plugin', target: 'bad-plugin' },
    { kind: 'credentialHint', description: '凭据 KEY 需人工补录', target: 'KEY', manualHint: '凭据 "KEY" 请人工重新填写' },
    { kind: 'skip', description: '旧快照无基线，跳过插件动作' },
    { kind: 'fileRestore', description: '缺少 target 的坏动作' }, // target undefined → failed
  ]);

  const report = await executeRestorePlan(plan, exec);
  assert.deepEqual(uninstalled, ['good-plugin', 'bad-plugin']);
  assert.deepEqual(report.removedPlugins, ['good-plugin']);
  assert.deepEqual(report.manualHints, ['凭据 "KEY" 请人工重新填写']);
  assert.deepEqual(report.skipped, ['旧快照无基线，跳过插件动作']);
  assert.equal(report.failed.length, 2, 'bad-plugin 失败 + 坏动作失败都应记录');
  assert.ok(report.failed.some((f) => f.item === 'plugin:bad-plugin' && f.reason.includes('模拟 pnpm 卸载失败')));
  assert.ok(report.failed.some((f) => f.reason.includes('缺少 target')), '坏动作如实记录且不中断其余');
});
