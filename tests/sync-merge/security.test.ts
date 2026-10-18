/**
 * 安全负例：远端载荷路径穿越 + 测试密码字面量不外泄。
 *
 * 这两条是同步通道的硬不变量（AGENTS.md §安全不变量）：
 *  - 远端载荷视为不可信：'../' / 绝对路径必须被拒或规范化，绝不写到目标目录外；
 *  - 密码只在内存里传输：report / message / warnings / sync-state / 远端快照 / 错误信息里都不得出现。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import type { SyncApplyPlan } from '../../src/sync/risk.ts';
import type { SectionData } from '../../src/schema/types.ts';
import {
  assertNoSecret, createDevice, filesSection, makeRoot, readStateText, setNamespace, testPassword,
} from './helpers.ts';

/** 造一个「应用恶意路径的 skills 分区」计划。 */
function traversalPlan(): SyncApplyPlan {
  return {
    autoApply: [{
      id: 'skills',
      decision: 'useRemote',
      conflicts: [],
      merged: filesSection([
        ['coding.md', '# ok\n'],
        ['../evil-up.md', '# escape\n'],
        ['sub/../../evil-deep.md', '# escape\n'],
        ['/abs-evil.md', '# escape\n'],
        ['C:\\\\Windows\\\\evil-abs.md', '# escape\n'],
      ]) as SectionData,
    }],
    review: [],
    skipped: [],
  };
}

test('负例：远端文件路径带 ../ 或绝对路径 → 不得写到 skills 目录之外', async () => {
  const root = await makeRoot('path-traversal');
  try {
    const d = await createDevice(root, 'a');
    await d.ctx.fs.writeFile('skills/coding.md', Buffer.from('# old\n', 'utf8'));
    await d.engine.recordBaseline('base-1', { skills: filesSection([['coding.md', '# old\n']]) });

    let report: { ok: boolean; warnings: string[] } | null = null;
    let threw: unknown = null;
    try {
      report = await d.engine.applyMergePlan(traversalPlan(), { remoteSnapshotId: 'remote-x' });
    } catch (err) {
      threw = err; // 直接拒绝也是可接受的结果
    }

    const keys = [...d.ctx.fs.files.keys()];
    assert.ok(keys.length > 0, '夹具至少应保留原有文件');
    for (const k of keys) {
      assert.ok(!k.includes('..'), '写入路径不得包含 ..（实际: ' + k + '）');
      assert.ok(k.includes('skills/') || k.includes('skills\\\\'), '所有写入都必须落在 skills 目录内（实际: ' + k + '）');
    }
    assert.equal(keys.some((k) => k.endsWith('evil-up.md') || k.endsWith('evil-deep.md')), false, '穿越路径不得在 skills 之外落盘');
    if (report !== null && !report.ok) {
      assert.ok(report.warnings.length > 0, '拒绝写入必须留下可见原因');
    }
    void threw;

    // 正向对照：同一夹具下合法路径必须真的能写进去 —— 否则「没写到外面」可能只是「什么都没写」。
    const benign = await d.engine.applyMergePlan({
      autoApply: [{ id: 'skills', decision: 'useRemote', conflicts: [], merged: filesSection([['safe.md', '# safe\n']]) as SectionData }],
      review: [], skipped: [],
    }, { remoteSnapshotId: 'remote-x2' });
    assert.equal(benign.ok, true, '合法路径必须可写（证明夹具具备写入能力）');
    assert.equal(Buffer.from(await d.ctx.fs.readFile('skills/safe.md')).toString('utf8'), '# safe\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('负例：加密推送的密码绝不出现在报告 / 基线 / 远端快照 / 错误信息里', async () => {
  const root = await makeRoot('password-secrecy');
  try {
    const d = await createDevice(root, 'a');
    setNamespace(d, 'general', { theme: 'dark', language: 'zh-CN' }, 3);
    const pw = testPassword();

    const report = await d.engine.push({ snapshotId: 'enc-1', encrypt: true, password: pw });
    assert.equal(report.ok, true);

    const surfaces: Array<[string, string]> = [
      ['push 报告', JSON.stringify(report)],
      ['push warnings', report.warnings.join('\n')],
      ['push message', report.message ?? ''],
      ['sync-state 原文', (await readStateText(d)) ?? ''],
    ];
    const remote = JSON.stringify(d.transport.snapshots.get('enc-1'));
    surfaces.push(['远端快照 JSON', remote]);
    for (const [label, text] of surfaces) assertNoSecret(text, pw, label);
    assert.ok(!JSON.stringify(d.transport.snapshots.get('enc-1')!.sections).includes('dark'), '加密后 sections 不得残留明文配置值');

    // 用错误密码解密：错误信息里两个密码都不许出现
    const wrong = testPassword();
    await assert.rejects(
      () => d.engine.preview({ snapshotId: 'enc-1', password: wrong }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assertNoSecret(msg, pw, '解密失败错误信息（真密码）');
        assertNoSecret(msg, wrong, '解密失败错误信息（输入密码）');
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
