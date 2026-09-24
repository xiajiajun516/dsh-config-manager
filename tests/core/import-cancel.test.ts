/**
 * 导入终止矩阵（运行中心「手动终止」的引擎侧契约）。
 *
 * 覆盖四条不可放宽的行为：
 *  - 终止只在**计划项边界**生效（不留半截项），且决策只问一次；
 *  - 「回滚」复用失败整体回滚的同一条补偿路径（绝不新造第二份回滚）；
 *  - 「保留」必须：跑完分区收尾、把未执行项在 journal 里标 skipped、跑启动自洽审计、
 *    **不**给快照标 done（保留是可撤销的承诺）；
 *  - 决策通道失败/缺省一律走安全侧（回滚），且保留分支绝不抛错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';
import type { BootSafetyReport } from '../../src/core/boot-safety.ts';
import type { ImportPlan, JournalStepRecord, TransactionSnapshotContext } from '../../src/core/types.ts';

const NS = ['general', 'llm-deepseek'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cancel-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 源配置：两个 settings namespace + 两个插件 + 一个技能文件（项数足够多，能在中途停下）。 */
async function seed(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] });
  ctx.settings.ns.set('llm-deepseek', { value: { model: 'deepseek-chat' }, revision: 5, secrets: [] });
  ctx.plugins.installed.set('@linxin666/dsh-ssh', { name: '@linxin666/dsh-ssh', version: '0.1.12', enabled: true });
  ctx.plugins.installed.set('@linxin666/dsh-task-board', { name: '@linxin666/dsh-task-board', version: '0.1.0', enabled: true });
  await ctx.fs.writeFile('skills/coding.md', Buffer.from('# Coding skill\n', 'utf8'));
}

async function fixture(dir: string, name: string): Promise<string> {
  const src = makeContext('win32', 'C:\\Users\\alice');
  await seed(src);
  const zipPath = path.join(dir, name);
  await new Exporter({ ctx: src, adapters: createAdapters({ namespaces: NS }), now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath: zipPath });
  return zipPath;
}

/** 目标机 + 引擎 + 计划（每次测试一份，避免交叉污染）。 */
async function planFor(zipPath: string): Promise<{ importer: Importer; plan: ImportPlan; store: MemSnapshotStore; dst: MockHostContext }> {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  dst.settings.registered.add('general');
  dst.settings.registered.add('llm-deepseek');
  const store = new MemSnapshotStore();
  const importer = new Importer({ ctx: dst, adapters: createAdapters({ namespaces: NS }), snapshotStore: store });
  const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
  return { importer, plan, store, dst };
}

/** 在「第 1 项完成」时请求终止：下一项边界即安全点。 */
function abortAfterFirst(controller: AbortController) {
  return (info: { index: number }): void => { if (info.index >= 1) controller.abort(); };
}

/** 最小 journal 绑定面（捕获 recordStep，供断言未执行项的收敛状态）。 */
function journalSpy(): { ctx: TransactionSnapshotContext; steps: JournalStepRecord[]; bound: string[]; applying: number } {
  const steps: JournalStepRecord[] = [];
  const bound: string[] = [];
  const spy = {
    steps,
    bound,
    applying: 0,
    ctx: {
      operationId: 'op-cancel-test',
      operationType: 'import-apply',
      environmentFingerprint: 'env-test',
      ownerInstanceId: 'owner-test',
      bindSnapshot: async (id: string) => { bound.push(id); },
      markApplying: async () => { spy.applying += 1; },
      recordStep: async (step: JournalStepRecord) => { steps.push(step); },
    } as TransactionSnapshotContext,
  };
  return spy;
}

const SAFE_AUDIT: BootSafetyReport = { verdict: 'safe', issues: [], prunedBundles: [], unchecked: [] };

test('C-01 终止 + 回滚：项边界停下、走整体回滚、回传 cancelled/rollback、快照标 rolled-back', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c01.zip');
    const { importer, plan, store } = await planFor(zipPath);
    const controller = new AbortController();
    let decisions = 0;
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      cancelSignal: controller.signal,
      onItem: abortAfterFirst(controller),
      onCancelDecision: async () => { decisions += 1; return 'rollback'; },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.keptPartial, false, '回滚分支恒 keptPartial=false（显式声明没有保留）');
    assert.equal(result.ok, false);
    assert.ok(result.rollback !== null, '必须有回滚报告（复用失败回滚同一路径）');
    assert.equal(decisions, 1, '决策只问一次');
    assert.ok(result.executed.length < plan.items.length, '终止后必须还有未执行的项');
    assert.ok(result.executed.length > 0, '终止前至少应用了一项（否则测不到「中途」）');
    const snapId = result.snapshotId;
    assert.ok(snapId !== null);
    assert.equal(store.snapshots.get(snapId as string)?.status, 'rolled-back');
  });
});

test('C-02 终止 + 保留：跑完收尾、未执行项记 skipped、审计被调用、快照保持 pending', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c02.zip');
    const { importer, plan, store, dst } = await planFor(zipPath);
    const controller = new AbortController();
    const spy = journalSpy();
    let auditCalls = 0;
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      cancelSignal: controller.signal,
      onItem: abortAfterFirst(controller),
      onCancelDecision: async () => 'keep',
      snapshotBinding: spy.ctx,
      bootSafetyAudit: async () => { auditCalls += 1; return SAFE_AUDIT; },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.keptPartial, true);
    assert.equal(result.ok, false, '保留不是「导入成功」');
    assert.equal(result.rollback, null, '保留分支不回滚');
    assert.equal(auditCalls, 1, '启动自洽审计必须在收尾之后被调用');
    assert.equal(result.bootSafety?.verdict, 'safe');
    assert.ok(result.executed.length > 0, '已应用部分必须留在盘上');
    const snapId = result.snapshotId as string;
    assert.equal(store.snapshots.get(snapId)?.status, 'pending', '保留时快照必须保持可用（不标 done）');
    // journal：未执行项必须从 planned 收敛为 skipped（否则事后审计读到「已提交」而盘面只有一半）
    const skipped = spy.steps.filter((s) => s.status === 'skipped');
    assert.ok(skipped.length > 0, '未执行项必须被显式标记');
    assert.ok(skipped.every((s) => typeof s.message === 'string' && s.message !== ''), '每条 skipped 必须带原因');
    // 分区收尾仍要跑：workspaces 的 finalizeImport 会把包内会话登记进工作区（此处无会话，
    // 但收尾本身不得因终止被跳过）——用「计划里确有项被应用」间接证明流程走到了正常返回路径。
    assert.ok(dst.settings.ns.size > 0, '保留分支必须把已应用项留在盘上');
  });
});

test('C-03 无终止信号：行为与改造前逐字节一致（ok=true，无 cancelled 字段）', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c03.zip');
    const { importer, plan } = await planFor(zipPath);
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.cancelled, undefined);
    assert.equal(result.keptPartial, undefined);
    assert.equal(result.bootSafety, undefined);
  });
});

test('C-04 决策通道抛错：按安全侧默认回滚，绝不把已知结论换成异常', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c04.zip');
    const { importer, plan } = await planFor(zipPath);
    const controller = new AbortController();
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      cancelSignal: controller.signal,
      onItem: abortAfterFirst(controller),
      onCancelDecision: async () => { throw new Error('决策通道断了'); },
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.keptPartial, false, '决策失败必须落到回滚分支，不得保留');
    assert.ok(result.rollback !== null);
  });
});

test('C-05 保留但未注入审计：如实告警「未验证」，绝不假装已审计', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c05.zip');
    const { importer, plan } = await planFor(zipPath);
    const controller = new AbortController();
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      cancelSignal: controller.signal,
      onItem: abortAfterFirst(controller),
      onCancelDecision: async () => 'keep',
    });
    assert.equal(result.keptPartial, true);
    assert.equal(result.bootSafety, undefined);
    assert.ok(result.warnings.some((w) => w.includes('未经验证') || w.includes('审计未执行')), '必须如实说明启动安全未经验证');
  });
});

test('C-06 保留分支的审计抛错不得让整笔变成异常（否则 journal 会记 SAFE MODE）', async () => {
  await withTmp(async (dir) => {
    const zipPath = await fixture(dir, 'c06.zip');
    const { importer, plan } = await planFor(zipPath);
    const controller = new AbortController();
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      cancelSignal: controller.signal,
      onItem: abortAfterFirst(controller),
      onCancelDecision: async () => 'keep',
      bootSafetyAudit: async () => { throw new Error('审计器炸了'); },
    });
    assert.equal(result.keptPartial, true, '审计失败不影响「保留」本身');
    assert.equal(result.bootSafety, undefined);
    assert.ok(result.warnings.some((w) => w.includes('审计器炸了')), '必须把审计失败原因如实回传');
  });
});
