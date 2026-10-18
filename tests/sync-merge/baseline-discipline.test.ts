/**
 * 场景 11 / 12 / 14 / 15：基线纪律（远端推进拒绝 / 中断回滚重试 / 备份失败零写入 / 历史恢复后再同步）。
 *
 * 核心口径：**只有真正成功的应用才推进基线**；被拒、失败、跳过一律逐字节保持 sync-state.json 不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import type { SyncApplyPlan } from '../../src/sync/risk.ts';
import type { SectionData } from '../../src/schema/types.ts';
import type { Importer } from '../../src/core/importer.ts';
import path from 'node:path';
import {
  createDevice, createSharedDevices, filesSection, getNamespace, makeRoot, readSkill,
  readStateJson, readStateText, setNamespace, transportError, writeSkill,
} from './helpers.ts';

/** 测试用 mock Importer：可控地「写到一半失败」，用于验证整体回滚与基线不动。 */
class MockImporter {
  ok = true;
  executeCalls = 0;
  onExecute: (() => Promise<void>) | undefined;

  async analyzeImport(): Promise<unknown> {
    return { valid: true, compatibility: 'full' };
  }

  async createImportPlan(): Promise<unknown> {
    return {
      items: [{
        id: 'skills:coding.md',
        kind: 'Update',
        adapter: 'skills',
        target: { adapter: 'skills', ref: 'coding.md' },
        description: 'mock write',
        severity: 'info',
      }],
      globalStrategy: 'merge',
      pathMappings: [],
      missingSecrets: [],
      needsRestart: false,
      estimatedActions: { skills: 1 } as Record<string, number>,
    };
  }

  async executeImportPlan(): Promise<unknown> {
    this.executeCalls += 1;
    if (this.onExecute !== undefined) await this.onExecute();
    return {
      ok: this.ok,
      executed: [],
      needsRestart: false,
      missingSecrets: [],
      warnings: [],
      rollback: null,
      snapshotId: null,
    };
  }
}

/** 造一个「应用 skills 分区」的计划（merged = 远端 skills 内容）。 */
function skillsApplyPlan(merged: SectionData): SyncApplyPlan {
  return {
    autoApply: [{ id: 'skills', decision: 'useRemote', conflicts: [], merged }],
    review: [],
    skipped: [],
  };
}

test('场景 11 两台设备并发改远端：A 基线 X、B 推 Y、A push → 被拒且 sync-state 原文未变；force 放行', async () => {
  const root = await makeRoot('remote-advanced');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b', 'c']);
    const a = devices['a']!;
    const b = devices['b']!;
    const c = devices['c']!;
    setNamespace(a, 'general', { theme: 'dark' }, 3);
    setNamespace(b, 'general', { theme: 'dark' }, 3);

    await a.engine.push({ snapshotId: 'a-1' }); // A 建立基线 X
    setNamespace(b, 'general', { theme: 'light' }, 4);
    await b.engine.push({ snapshotId: 'b-1' }); // B 推了 Y

    const rawBefore = await readStateText(a);
    assert.notEqual(rawBefore, null);
    const uploadsBefore = a.transport.count('upload');

    // 冻结契约：默认 push 返回 { ok:false, conflict:true, snapshotId:'', sections:[] }，不抛错
    const rejected = await a.engine.push({ snapshotId: 'a-2' }) as unknown as {
      ok: boolean; conflict?: boolean; snapshotId: string; sections: unknown[]; warnings: string[]; message?: string;
    };
    assert.equal(rejected.ok, false, '远端已推进 → push 必须被拒');
    assert.equal(rejected.conflict, true, '被拒原因必须是 conflict:true（供 UI 引导先合并）');
    assert.equal(rejected.snapshotId, '', '被拒时不得给出快照 id');
    assert.deepEqual(rejected.sections, [], '被拒时不得声称推了任何分区');
    assert.ok((rejected.message ?? '').length > 0, '被拒必须给出说明');
    assert.equal(a.transport.count('upload'), uploadsBefore, '被拒时绝不写远端');
    assert.equal(await readStateText(a), rawBefore, '被拒时 sync-state.json 逐字节不变');

    // 显式放行：force:true
    const forced = await (a.engine.push as unknown as (o: unknown) => Promise<{ ok: boolean; snapshotId: string }>)({ snapshotId: 'a-force', force: true });
    assert.equal(forced.ok, true, 'force:true 是显式覆盖意图 → 放行');
    assert.equal(a.transport.snapshots.has('a-force'), true);

    // 首次同步不拦：C 无基线（lastSnapshotId=''），远端有 b-1/a-force 也应允许
    const first = await c.engine.push({ snapshotId: 'c-1' });
    assert.equal(first.ok, true, '无基线（首次同步）不得被「远端推进」拦下');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 11b 前置检查读不到远端列表：不拦（不把「读不到」当「没变」），但如实告警', async () => {
  const root = await makeRoot('advance-check-unreadable');
  try {
    const { devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    setNamespace(a, 'general', { theme: 'dark' }, 3);
    await a.engine.push({ snapshotId: 'a-1' });
    a.transport.failNext('list', transportError('server', '503 during advance check'));

    const report = await a.engine.push({ snapshotId: 'a-2' });
    assert.equal(report.ok, true, '读不到远端列表时必须照常推送（上传本身会再次暴露通道问题）');
    assert.ok(report.warnings.length > 0, '无法判定远端是否被推进时必须如实告警');
    assert.equal(a.transport.snapshots.has('a-2'), true);
    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'a-2', '推送成功 → 基线正常推进');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 12 执行中途失败：整体回滚（文件字节复原）+ 基线不动 + 重试成功且幂等', async () => {
  const root = await makeRoot('interrupted-retry');
  try {
    const { devices } = await createSharedDevices(root, ['a', 'b']);
    const a = devices['a']!;
    const b = devices['b']!;
    await writeSkill(a, 'coding.md', '# Coding\n');
    await writeSkill(b, 'coding.md', '# Coding\n');
    await a.engine.push({ snapshotId: 'a-1' });
    await writeSkill(b, 'coding.md', '# Coding by B\n');
    await b.engine.push({ snapshotId: 'b-1' });

    const mergePlan = await a.engine.merge();
    const skillsResult = mergePlan.sections.find((s) => s.id === 'skills')!;
    assert.ok(skillsResult.merged !== undefined, '远端改动应产出可用 merged');
    const apply = skillsApplyPlan(skillsResult.merged as SectionData);

    const mock = new MockImporter();
    mock.ok = false;
    // 模拟「写到一半失败」：文件已被改成半个结果
    mock.onExecute = async () => { await writeSkill(a, 'coding.md', '# PARTIAL HALF-WRITTEN\n'); };
    const engineWithMock = a.makeEngine({ importer: mock as unknown as Importer });

    const rawBefore = await readStateText(a);
    const failed = await engineWithMock.applyMergePlan(apply, { remoteSnapshotId: 'b-1' });
    assert.equal(failed.ok, false);
    assert.equal(failed.rolledBack, true, '失败必须触发整体回滚');
    assert.notEqual(failed.restoreId, '', '回滚快照 id 必须回传（UI 一键回滚要用）');
    assert.equal(await readSkill(a, 'coding.md'), '# Coding\n', '回滚必须把文件字节恢复到执行前');
    assert.equal(await readStateText(a), rawBefore, '失败时基线逐字节不变（不得推进）');

    // 重试：这次成功；真实写入由 mock 模拟
    const mock2 = new MockImporter();
    mock2.ok = true;
    mock2.onExecute = async () => { await writeSkill(a, 'coding.md', '# Coding by B\n'); };
    const engineRetry = a.makeEngine({ importer: mock2 as unknown as Importer });
    const retried = await engineRetry.applyMergePlan(apply, { remoteSnapshotId: 'b-1' });
    assert.equal(retried.ok, true);
    assert.deepEqual(retried.applied, ['skills']);
    assert.equal(await readSkill(a, 'coding.md'), '# Coding by B\n');
    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'b-1', '成功后基线推进到本次远端快照');

    // 幂等：同内容再同步 → skip（本地==远端），不产生新的应用
    const again = await a.engine.merge();
    assert.equal(again.sections.find((s) => s.id === 'skills')!.decision, 'skip', '同内容二次同步必须 skip');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 14 备份（createSnapshot）失败时数据保护：零写入 + 明确告警', async () => {
  const root = await makeRoot('snapshot-fail');
  try {
    const merged = filesSection([['coding.md', '# Coding by B\n']]);
    const faulty = await createDevice(root, 'faulty');
    await writeSkill(faulty, 'coding.md', '# Coding\n');
    await faulty.engine.recordBaseline('faulty-base', { skills: filesSection([['coding.md', '# Coding\n']]) });
    // 备份失败注入：把回滚快照目录位置占成**普通文件** → FileSnapshotStore 建目录/写入失败
    // （等价于磁盘满 / 权限不足），createSnapshot 因此抛错。
    await fs.writeFile(path.join(faulty.stateDir, 'snapshots'), 'not a directory');

    const rawBefore = await readStateText(faulty);
    const report = await faulty.engine.applyMergePlan(skillsApplyPlan(merged), { remoteSnapshotId: 'b-1' });
    assert.equal(report.ok, false);
    assert.equal(report.restoreId, '', '没有可回滚快照时不得伪造 restoreId');
    assert.equal(report.rolledBack, false, '没执行任何写入 → 不得声称回滚过');
    assert.ok(report.warnings.length > 0, '备份失败必须留下可见告警');
    assert.equal(await readSkill(faulty, 'coding.md'), '# Coding\n', '备份失败 → 本机数据零改动');
    assert.equal(await readStateText(faulty), rawBefore, '备份失败 → 基线逐字节不变');

    // 正向对照：把注入的「假目录」移走后，同一计划必须能成功应用 ——
    // 证明上面的失败确实由「备份失败」引起，而不是计划本身不可执行。
    await fs.rm(path.join(faulty.stateDir, 'snapshots'), { force: true });
    const healthy = await faulty.engine.applyMergePlan(skillsApplyPlan(merged), { remoteSnapshotId: 'b-1' });
    assert.equal(healthy.ok, true, '移除故障注入后同一计划必须能成功');
    assert.equal(await readSkill(faulty, 'coding.md'), '# Coding by B\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 15 恢复历史版本后再次同步：指针停在被恢复的版本，下一轮能再次看到更新的远端', async () => {
  const root = await makeRoot('history-restore');
  try {
    const { transport, devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
    await a.engine.push({ snapshotId: 'a-1' });
    setNamespace(a, 'general', { theme: 'light', language: 'zh-CN' }, 4);
    await a.engine.push({ snapshotId: 'a-2' });

    const oldSettings = (transport.snapshots.get('a-1')!.sections as Record<string, SectionData>)['settings']!;
    const plan: SyncApplyPlan = {
      autoApply: [{ id: 'settings', decision: 'useRemote', conflicts: [], merged: oldSettings }],
      review: [],
      skipped: [],
    };
    const restored = await a.engine.applyMergePlan(plan, { remoteSnapshotId: 'a-1' });
    assert.equal(restored.ok, true, '恢复历史版本必须走真实导入路径并成功');
    assert.deepEqual(getNamespace(a, 'general'), { theme: 'dark', language: 'zh-CN' }, '本机已恢复到 a-1 的内容');
    const state = (await readStateJson(a))!;
    assert.equal(state['lastSnapshotId'], 'a-1', '恢复历史版本后远端指针 = 被恢复的那一版（不冒充最新）');

    assert.equal(await a.engine.hasNewRemoteSnapshot(), true, '远端仍有更新的 a-2 → 必须能再次看到');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('场景 15b 恢复历史版本后再同步：不得因为「写回时自增的 revision」产生假冲突（F-2 证据）', async () => {
  const root = await makeRoot('history-restore-resync');
  try {
    const { transport, devices } = await createSharedDevices(root, ['a']);
    const a = devices['a']!;
    setNamespace(a, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
    await a.engine.push({ snapshotId: 'a-1' });
    setNamespace(a, 'general', { theme: 'light', language: 'zh-CN' }, 4);
    await a.engine.push({ snapshotId: 'a-2' });

    const oldSettings = (transport.snapshots.get('a-1')!.sections as Record<string, SectionData>)['settings']!;
    const plan: SyncApplyPlan = {
      autoApply: [{ id: 'settings', decision: 'useRemote', conflicts: [], merged: oldSettings }],
      review: [],
      skipped: [],
    };
    const restored = await a.engine.applyMergePlan(plan, { remoteSnapshotId: 'a-1' });
    assert.equal(restored.ok, true);
    assert.deepEqual(getNamespace(a, 'general'), { theme: 'dark', language: 'zh-CN' }, '值已恢复到 a-1');
    // F-2 更锐利的回归门：基线必须等于**本机实际内容**（而不是 merged 载荷）。
    // 修复前这条为 true（settings 写回时 revision 自增 → hash 对不上）。
    assert.equal(await a.engine.hasLocalChanges(), false, '基线 == 本机实际导出（F-2 回归门）');

    // 致命点：applyMergePlan 用 merged 载荷（a-1 的 revision=3）写基线/祖先，
    // 而本机写回时 revision 自增（MemSettings.replace → 5；真机 DSH settings 同样自增）。
    // 于是下一次同步把「只有 revision 不同」判成 both-modified 冲突 → 每轮重复冲突。
    const next = await a.engine.merge();
    const settings = next.sections.find((s) => s.id === 'settings')!;
    assert.equal(settings.decision, 'useRemote', '恢复到 a-1 后，a-2 相对祖先（=a-1）应只是远端单侧改动');
    assert.deepEqual(
      (settings.merged as unknown as { namespaces: Record<string, { value: unknown }> }).namespaces['general']!.value,
      { theme: 'light', language: 'zh-CN' },
      '再次同步能拿到最新远端内容',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
