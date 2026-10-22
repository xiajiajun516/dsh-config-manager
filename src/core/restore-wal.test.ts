/**
 * 恢复逐动作 WAL 的单测（src/core/restore-wal.ts）。
 *
 * 为什么值得单独测：WAL 的判定端（reconcile）依赖三个**语义约定**，任何一个写错都会让崩溃后的
 * 结论从「可证明」退化或（更糟）**谎报完成**：
 *  1. 只登记会动盘的动作（credentialHint/skip 登记了只会制造永远不可证明的项）；
 *  2. 目标文件「本来就不存在」必须记哨兵（ABSENT_FINGERPRINT），不能记 null（null = 不可指纹）；
 *  3. 删除类动作 settle 后 afterFp 也必须是哨兵 —— 否则「删掉了」与「读不出来」在 journal 里长得一样。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ABSENT_FINGERPRINT } from './journal.ts';
import { Phase3Recovery } from './phase3-host.ts';
import { createRestoreWal, isWalActionKind, restoreFingerprint } from './restore-wal.ts';
import type { JournalStepRecord } from './types.ts';
import { sha256Hex } from '../utils/hashing.ts';

function tmp(t: test.TestContext): string {
  const dir = fssync.mkdtempSync(path.join(os.tmpdir(), 'restore-wal-'));
  t.after(() => fssync.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 只收 step 的最小 journal 端口（按调用顺序记录）。 */
function recorder(): { steps: JournalStepRecord[]; port: { recordStep: (s: JournalStepRecord) => Promise<void> } } {
  const steps: JournalStepRecord[] = [];
  return {
    steps,
    port: { recordStep: async (s) => { steps.push(s); } },
  };
}

test('R-01 没有 recordStep 的 journal（或 undefined）⇒ 返回 null，恢复保持旧行为、零开销', () => {
  assert.equal(createRestoreWal(undefined), null);
  assert.equal(createRestoreWal({}), null);
  assert.equal(createRestoreWal({ bindSnapshot: async () => undefined }), null);
});

test('R-02 preRegister 只登记会动盘的动作，返回值与入参同序（非动盘项对应 undefined）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'a.yaml');
  await fs.writeFile(file, 'A', 'utf8');
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const handles = await wal.preRegister([
    { kind: 'credentialHint', target: 'settings.yaml', abs: file },
    { kind: 'hostFileRestore', target: 'settings.yaml', abs: file },
    { kind: 'skip', abs: null },
  ]);
  assert.equal(handles[0], undefined, 'credentialHint 无副作用 ⇒ 不登记');
  assert.equal(handles[2], undefined, 'skip 无副作用 ⇒ 不登记');
  assert.ok(handles[1], 'hostFileRestore 必须登记');
  assert.equal(rec.steps.length, 1);
  assert.equal(rec.steps[0]!.status, 'planned');
  assert.equal(rec.steps[0]!.external, false);
  assert.equal(rec.steps[0]!.ref, file, 'ref 必须是绝对路径（reconcile 直接拿它读盘）');
  assert.equal(rec.steps[0]!.afterFp, null, '预登记时 afterFp 必须为空');
  assert.equal(rec.steps[0]!.beforeFp, sha256Hex(Buffer.from('A')));
  assert.equal(isWalActionKind('credentialHint'), false);
  assert.equal(isWalActionKind('pluginRemove'), true);
});

test('R-03 目标本来就不存在 ⇒ beforeFp 记哨兵（不是 null）；不可读 ⇒ null', async (t) => {
  const dir = tmp(t);
  assert.equal(await restoreFingerprint(path.join(dir, 'nope.yaml')), ABSENT_FINGERPRINT);
  assert.equal(await restoreFingerprint(null), null, '没有绝对路径 ⇒ 不可指纹');
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const handles = await wal.preRegister([
    { kind: 'hostFileRestore', target: 'new.yaml', abs: path.join(dir, 'new.yaml') },
  ]);
  assert.equal(handles[0]!.beforeFp, ABSENT_FINGERPRINT);
  assert.equal(rec.steps[0]!.beforeFp, ABSENT_FINGERPRINT);
});

test('R-04 settle：还原类写 done + 新内容指纹；删除类写哨兵（「删掉了」可自证）', async (t) => {
  const dir = tmp(t);
  const restored = path.join(dir, 'restore.yaml');
  const removed = path.join(dir, 'remove.yaml');
  await fs.writeFile(restored, 'OLD', 'utf8');
  await fs.writeFile(removed, 'GONE-SOON', 'utf8');
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const handles = await wal.preRegister([
    { kind: 'hostFileRestore', target: 'restore.yaml', abs: restored },
    { kind: 'fileRemove', target: 'remove.yaml', abs: removed },
  ]);
  await fs.writeFile(restored, 'NEW', 'utf8');
  await fs.unlink(removed);
  await wal.settle(handles[0], 'done');
  await wal.settle(handles[1], 'done');

  // rec.steps = [pre-register restore, pre-register remove, settle restore, settle remove]
  const first = rec.steps[2]!;
  const second = rec.steps[3]!;
  assert.equal(first.status, 'done');
  assert.equal(first.beforeFp, sha256Hex(Buffer.from('OLD')));
  assert.equal(first.afterFp, sha256Hex(Buffer.from('NEW')));
  assert.equal(second.status, 'done');
  assert.equal(second.beforeFp, sha256Hex(Buffer.from('GONE-SOON')));
  assert.equal(second.afterFp, ABSENT_FINGERPRINT, '删除类动作的期望态只能由哨兵表达');

  // 判定端认这个哨兵：文件确实不在 ⇒ after-match；哨兵出现在 beforeFp 侧 ⇒ before-match
  const recovery = new Phase3Recovery({ dataDir: dir, packageVersion: '0.1.79', environmentFingerprint: 'fp-wal' });
  const hooks = recovery.recoveryHooks;
  const asStep = (s: JournalStepRecord) => ({
    adapter: s.adapter,
    ref: s.ref,
    kind: s.kind,
    external: s.external === true,
    beforeFp: s.beforeFp ?? null,
    afterFp: s.afterFp ?? null,
    status: s.status ?? 'planned',
    appliedAt: null,
  });
  assert.equal(await hooks.verifyStepFingerprint(asStep(second)), 'after-match');
  assert.equal(
    await hooks.verifyStepFingerprint({ ...asStep(second), beforeFp: ABSENT_FINGERPRINT, afterFp: sha256Hex(Buffer.from('x')) }),
    'before-match',
  );
  assert.equal(await hooks.verifyStepFingerprint(asStep(first)), 'after-match');
});

test('R-05 settle：失败记 attention 并带结论文案（且 afterFp 仍按真实盘面算，不伪造成 done）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'half.yaml');
  await fs.writeFile(file, 'ORIGINAL', 'utf8');
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const handles = await wal.preRegister([{ kind: 'hostFileRestore', target: 'half.yaml', abs: file }]);
  await wal.settle(handles[0], 'attention', 'copy failed');
  const settled = rec.steps[1]!;
  assert.equal(settled.status, 'attention');
  assert.equal(settled.message, 'copy failed');
  assert.equal(settled.afterFp, sha256Hex(Buffer.from('ORIGINAL')), '未改动 ⇒ afterFp 等于 beforeFp');
  // 传 undefined 句柄安全（非动盘动作的调用点不判空）
  await wal.settle(undefined, 'done');
});

test('R-06 插件卸载记 external 且不带指纹（外部副作用刻意不自证 ⇒ reconcile 恒保守）', async (t) => {
  tmp(t);
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const handles = await wal.preRegister([{ kind: 'pluginRemove', pluginName: 'some-plugin', abs: null }]);
  assert.ok(handles[0]);
  assert.equal(rec.steps[0]!.external, true);
  assert.equal(rec.steps[0]!.ref, '', '外部 step 没有可指纹的 ref');
  assert.equal(rec.steps[0]!.beforeFp, null);
  await wal.settle(handles[0], 'done');
  assert.equal(rec.steps[1]!.afterFp, null, 'external step 永不写 afterFp');
  assert.match(rec.steps[0]!.id, /^restore:pluginRemove:/, 'step id 由动作语义派生');
  assert.ok(rec.steps[0]!.id.includes('some-plugin'));
});

test('R-07 step id 由语义派生（同目标两次登记得到同一 id，plan 下标漂移不影响对齐）', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'same.yaml');
  await fs.writeFile(file, 'X', 'utf8');
  const rec = recorder();
  const wal = createRestoreWal(rec.port)!;
  const a = await wal.preRegister([{ kind: 'hostFileRestore', target: 'same.yaml', abs: file }]);
  const b = await wal.preRegister([{ kind: 'hostFileRestore', target: 'same.yaml', abs: file }]);
  assert.equal(rec.steps[0]!.id, rec.steps[1]!.id);
  assert.equal(a[0]!.id, b[0]!.id);
});
