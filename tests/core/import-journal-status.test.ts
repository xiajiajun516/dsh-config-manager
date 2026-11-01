/**
 * issue #35（可观测性部分）：导入执行后的 journal step 状态必须能区分
 * 「安装失败/警告」与「用户主动跳过」——此前 `warning` 被记成 `skipped` 且无 message，
 * 事后审计（人 / CLI / agent 读 transactions 或 migration-history）会得出
 * 「用户跳过了这些插件、同步成功」的错误结论。
 *
 * 用真实 Exporter/Importer + 真实 adapter 管线驱动（仅替换 skills adapter 的行为）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { SkillsAdapter } from '../../src/adapters/skills.ts';
import { ImportUserSkippedError } from '../../src/core/types.ts';
import { makeContext, MemSnapshotStore } from '../../src/adapters/test-helpers.ts';
import type { ApplyResult, ConfigAdapter, PlanItem, TransactionSnapshotContext } from '../../src/core/types.ts';
import type { JournalStepRecord } from '../../src/core/types.ts';

const NS = ['general'];

/** 四种结局各一个：成功 / 非致命警告（安装失败但 warning:true）/ 硬失败 / 用户主动跳过 */
class OutcomeSkills extends SkillsAdapter {
  override async analyzeImport(): Promise<PlanItem[]> {
    return ['ok', 'warn', 'fail', 'skip'].map((n) => ({
      id: `skills:${n}.md`,
      kind: 'Update' as const,
      adapter: 'skills' as const,
      description: n,
      severity: 'info' as const,
      target: { adapter: 'skills' as const, ref: `${n}.md` },
    }));
  }
  override async applyItem(item: PlanItem): Promise<ApplyResult> {
    if (item.id.endsWith('warn.md')) return { ok: false, warning: true, message: '插件安装失败：Failed to read patch file' };
    if (item.id.endsWith('fail.md')) return { ok: false, message: '硬失败：写不进去' };
    // 注意：构造函数接受 MsgFunc（不是字符串）——传字符串会 TypeError 并被记成 failed
    if (item.id.endsWith('skip.md')) throw new ImportUserSkippedError();
    return { ok: true };
  }
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-jstep-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('issue #35：warning 不得记为 skipped；用户跳过才记 skipped；message 必须落盘', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await src.fs.writeFile('skills/ok.md', Buffer.from('ok', 'utf8'));
    const zipPath = path.join(dir, 'b.zip');
    await new Exporter({ ctx: src, adapters: createAdapters({ namespaces: NS }) })
      .export({ includeSecrets: false, outPath: zipPath });

    const dst = makeContext('win32', 'C:\\Users\\bob');
    const adapters: ConfigAdapter[] = createAdapters({ namespaces: NS })
      .map((a) => (a.id === 'skills' ? new OutcomeSkills() : a));
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.equal(plan.items.filter((i) => i.adapter === 'skills').length, 4, '四个受控计划项都应进入计划');

    const recorded = new Map<string, JournalStepRecord>();
    const binding: TransactionSnapshotContext = {
      operationId: 'op-issue35', operationType: 'import-apply',
      environmentFingerprint: 'fp', ownerInstanceId: 'owner',
      bindSnapshot: async () => undefined,
      markApplying: async () => undefined,
      recordStep: async (rec) => { recorded.set(rec.id, rec); },
    };

    // 本用例只验 journal 状态映射：显式关掉整体回滚（IE-02 缺省是 true），否则硬失败项会连带回滚。
    const result = await importer.executeImportPlan(
      zipPath, plan, { confirm: true, snapshotBinding: binding, rollbackOnError: false },
    );
    assert.equal(result.ok, true, '非致命警告不得让整次导入失败');

    // ① 安装失败（warning）→ attention，绝不是 skipped
    assert.equal(recorded.get('skills:warn.md')?.status, 'attention', 'warning 必须记为 attention');
    assert.equal(recorded.get('skills:warn.md')?.message, '插件安装失败：Failed to read patch file', '失败原因必须落盘');
    // ② 硬失败 → attention + message
    assert.equal(recorded.get('skills:fail.md')?.status, 'attention');
    assert.equal(recorded.get('skills:fail.md')?.message, '硬失败：写不进去');
    // ③ 成功 → done
    assert.equal(recorded.get('skills:ok.md')?.status, 'done');
    // ④ 用户主动跳过 → skipped（与失败可区分）
    assert.equal(recorded.get('skills:skip.md')?.status, 'skipped');
  });
});
