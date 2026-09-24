/**
 * import-wizard 测试（m6-ui）：
 *  - 步骤状态机 select→analyzing→compatibility→preview→importing→result
 *  - 显式 rollbackOnError（场景 E 默认 true）
 *  - Preview 摘要（§10）
 *  - confirm 安全阀、进度事件、reset
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ImportWizard, compatibilityBadgeKind, compatibilityLevel, importApplicablePhases, importBasePathNotices, importFlowFlags,
  importPreviewStageAfter, isSkippablePluginInstall, mergeSecretInput, nextImportPhase, pendingSecretRequests,
} from './import-wizard.ts';
import { MockImportPort, makeAnalysis, makeImportResult, makePlan, makePlanItem } from './test-helpers.ts';
import type { ImportPlan } from '../core/types.ts';

/**
 * UI-06 回归：补录页「看到的值 = 提交的值」。
 * 该页是可来回切换的中间步骤，组件会卸载重挂 —— 提交集合必须在**最新集合上合并**，
 * 否则会出现「回到该页输入框全空但旧值仍被提交」与「编辑一个字段丢掉其它 ref 的值」。
 */
test('import-wizard: mergeSecretInput 在最新集合上合并（不丢其它 ref、不复活已清空的值）', () => {
  // 第一次填写
  let inputs = mergeSecretInput({}, 'API_KEY', 'abc');
  inputs = mergeSecretInput(inputs, 'OTHER', 'def');
  assert.deepEqual(inputs, { API_KEY: 'abc', OTHER: 'def' });

  // 回到该页后再改一个字段：另一个 ref 的值必须保留（原实现用空表覆盖 → 只剩当前 ref）
  inputs = mergeSecretInput(inputs, 'API_KEY', 'xyz');
  assert.deepEqual(inputs, { API_KEY: 'xyz', OTHER: 'def' });

  // 清空单个 ref：只清它自己（不是清空整表）
  inputs = mergeSecretInput(inputs, 'OTHER', '');
  assert.deepEqual(inputs, { API_KEY: 'xyz', OTHER: '' });

  // 不修改入参（纯函数；调用方以 store 快照为准）
  const base = { A: '1' };
  const next = mergeSecretInput(base, 'B', '2');
  assert.deepEqual(base, { A: '1' });
  assert.deepEqual(next, { A: '1', B: '2' });
})

test('import-wizard: selectZip 进入 compatibility 并保存 analysis', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  assert.equal(wiz.currentStep, 'select');

  const analysis = await wiz.selectZip('C:\\backup\\dsh-config.zip');
  assert.equal(port.analyzeCalls, 1);
  assert.equal(analysis.compatibility, 'good');
  assert.equal(wiz.currentStep, 'compatibility');
  assert.equal(wiz.snapshot().zipPath, 'C:\\backup\\dsh-config.zip');
});

test('import-wizard: 分析失败进入 errors 并抛出', async () => {
  const port = new MockImportPort();
  port.analysis = makeAnalysis({ valid: false, errors: ['备份完整性校验失败'] });
  const wiz = new ImportWizard({ port });
  await assert.rejects(() => wiz.selectZip('x.zip'), /完整性/);
  assert.equal(wiz.snapshot().errors.length, 1);
});

test('import-wizard: confirmCompatibility 生成计划并进入 preview', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  const plan = await wiz.confirmCompatibility();
  assert.equal(wiz.currentStep, 'preview');
  assert.ok(plan.items.length > 0);
  assert.equal(port.planCalls.length, 1);
});

test('import-wizard: Preview 摘要统计（§10 数值化）', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  const s = wiz.previewSummary();
  assert.equal(s.willChange, 5); // Create×3 + Update×1 + Install×1（Skip/MissingSecret 不计）
  assert.equal(s.pluginsToInstall, 1);
  assert.equal(s.mcpAdds, 1);
  assert.equal(s.prompts, 1);
  assert.equal(s.conflicts, 0);
  assert.equal(s.secretsNeeded, 1);
  assert.equal(s.needsRestart, true);
});

test('import-wizard: execute 默认显式传 rollbackOnError=true（场景 E）', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  const result = await wiz.execute({ confirm: true });

  assert.equal(result.ok, true);
  assert.equal(wiz.currentStep, 'result');
  assert.equal(port.executeCalls.length, 1);
  assert.equal(port.executeCalls[0]!.confirm, true);
  assert.equal(port.executeCalls[0]!.rollbackOnError, true, '默认整体回滚');
});

test('import-wizard: 用户可选 rollbackOnError=false（单项失败继续 §34.17）', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true, rollbackOnError: false });
  assert.equal(port.executeCalls[0]!.rollbackOnError, false);
});

test('import-wizard: 加密备份的解密密码同时传给 createImportPlan（否则归档里的凭据不进计划）', async () => {
  const port = new MockImportPort();
  port.analysis = makeAnalysis({ encrypted: true });
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  assert.deepEqual(port.planOptsCalls[0], {}, '未设密码时不传 decryptPassword（普通备份）');

  wiz.setDecryptPassword('backup-password-123');
  await wiz.execute({ confirm: true });
  assert.deepEqual(
    port.planOptsCalls[1],
    { decryptPassword: 'backup-password-123' },
    'execute 前重建计划必须带上解密密码：计划缺少归档凭据 = 导入时值被静默丢掉',
  );

  wiz.reset();
  await wiz.selectZip('y.zip');
  await wiz.confirmCompatibility();
  assert.deepEqual(port.planOptsCalls[2], {}, 'reset 后不残留密码');
});

test('import-wizard: 加密备份的解密密码经 execute 传给端口（仅内存）', async () => {
  const port = new MockImportPort();
  port.analysis = makeAnalysis({ encrypted: true });
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();

  // 未设置密码：execute 不携带 decryptPassword
  await wiz.execute({ confirm: true });
  assert.equal(port.executeCalls[0]!.decryptPassword, undefined);

  // 设置密码后：execute 携带；reset 后清空（绝不残留）
  wiz.setDecryptPassword('backup-password-123');
  await wiz.execute({ confirm: true });
  assert.equal(port.executeCalls[1]!.decryptPassword, 'backup-password-123');

  wiz.reset();
  await wiz.selectZip('y.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true });
  assert.equal(port.executeCalls[2]!.decryptPassword, undefined, 'reset 必须清空解密密码');
});

test('import-wizard: confirm=false 拒绝执行（core 安全阀透传）', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await assert.rejects(() => wiz.execute({ confirm: false }), /未确认/);
  assert.equal(port.executeCalls.length, 0);
});

test('import-wizard: secretInputs 仅内存传递', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  wiz.setSecretInputs({ K1: 'sk-xxx' });
  await wiz.execute({ confirm: true });
  assert.equal(port.executeCalls[0]!.secretInputs?.['K1'], 'sk-xxx');
});

test('import-wizard: 失败且回滚时发出 rolling-back 进度事件', async () => {
  const port = new MockImportPort();
  port.result = makeImportResult({
    ok: false,
    rollback: { full: true, restored: ['settings:a'], failed: [] },
  });
  const events: string[] = [];
  const wiz = new ImportWizard({ port, onProgress: (e) => events.push(e.stage) });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  const result = await wiz.execute({ confirm: true });
  assert.equal(result.ok, false);
  assert.ok(events.includes('rolling-back'));
  assert.ok(events.includes('done'));
});

test('import-wizard: execute 请求期间发 executing 不定态而非预发假进度', async () => {
  const port = new MockImportPort();
  const events: { stage: string; step?: number; total?: number }[] = [];
  const wiz = new ImportWizard({ port, onProgress: (e) => events.push({ stage: e.stage, step: e.step, total: e.total }) });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true });

  // 请求期间（executeImportPlan 调用前后）必须发 executing 不定态事件
  // （step/total 缺省 → UI 渲染动画而不是伪造的 78% 假进度）。
  const executing = events.find((e) => e.stage === 'executing');
  assert.ok(executing, 'execute 期间应发出 executing 阶段');
  assert.equal(executing!.step, undefined, 'executing 不在阶段序列 → step 缺省');
  assert.equal(executing!.total, undefined, 'executing 不在阶段序列 → total 缺省');
  // 不再预发 restoring-* / validating-config 假进度
  for (const fake of ['restoring-settings', 'restoring-plugins', 'restoring-mcp', 'validating-config']) {
    assert.ok(!events.some((e) => e.stage === fake), `不应再预发假进度 ${fake}`);
  }
  assert.ok(events.some((e) => e.stage === 'done'));
});

test('import-wizard: reset 清空状态回 select', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true });
  wiz.reset();
  const snap = wiz.snapshot();
  assert.equal(snap.step, 'select');
  assert.equal(snap.zipPath, null);
  assert.equal(snap.plan, null);
  assert.equal(snap.result, null);
});

test('import-wizard: setArchiveEncrypted(true, zipPath) 存入容器路径供 unlock 使用', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  assert.equal(wiz.snapshot().zipPath, null, '初始 zipPath 为 null');

  // setArchiveEncrypted 传入 zipPath → 写入 this.zipPath
  wiz.setArchiveEncrypted(true, '/tmp/encrypted-backup.dca1');
  assert.equal(wiz.snapshot().zipPath, '/tmp/encrypted-backup.dca1',
    'setArchiveEncrypted(true, zipPath) 必须设置 zipPath（防止 syncWizard 覆盖 store');
  // setArchiveEncrypted(false) 不应改 zipPath（普通备份路径保留）
  const wiz2 = new ImportWizard({ port });
  wiz2.setArchiveEncrypted(false);
  assert.equal(wiz2.snapshot().zipPath, null, '非加密容器不应改 zipPath');

  // unlockArchive 后 zipPath 仍为加密路径，unlockedZipPath 为明文路径
  const decrypted = await wiz.unlockArchive('/tmp/encrypted-backup.dca1', 'secret123');
  assert.deepEqual(decrypted, { zipPath: '/tmp/encrypted-backup.dca1', refs: [] },
    'unlockArchive 必须返回明文 ZIP 路径与凭据覆盖清单（导入全程只输一次密码）');
  assert.equal(wiz.snapshot().zipPath, '/tmp/encrypted-backup.dca1',
    'unlockArchive 后 snapshot.zipPath 仍为加密容器路径');
  // resolvedZipPath 应返回明文路径（通过私有字段，这里用 snapshot 验证 zipPath 不变）
  // 后续 selectZip 应使用明文路径（resolvedZipPath 内部逻辑）
});

test('import-wizard: unlockArchive → selectZip 完整流程（加密容器解锁后分析明文 ZIP）', async () => {
  const port = new MockImportPort();
  const wiz = new ImportWizard({ port });
  // 模拟加密容器上传
  wiz.setArchiveEncrypted(true, '/tmp/encrypted.dca1');

  // 解锁
  await wiz.unlockArchive('/tmp/encrypted.dca1', 'password');
  // 解锁后调用 selectZip 应分析解密后的明文 ZIP（mock 固定返回同一路径）
  const analysis = await wiz.selectZip('/tmp/encrypted.dca1');
  assert.equal(analysis.compatibility, 'good');
  assert.equal(wiz.currentStep, 'compatibility');
});

test('import-wizard: retryableCount 只统计 failed 与用户跳过（skippedByUser）项', async () => {
  const port = new MockImportPort({
    result: makeImportResult({
      executed: [
        { itemId: 'settings:a', status: 'ok' },
        { itemId: 'plugin:x', status: 'failed', message: '网络超时' },
        { itemId: 'plugin:y', status: 'skipped', skippedByUser: true },
        { itemId: 'prompt:p', status: 'skipped' }, // 引擎跳过（非用户）不计
      ],
    }),
  });
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true });
  assert.equal(wiz.retryableCount(), 2, 'failed + 用户跳过 各 1');
});

test('import-wizard: executeRetry 只重跑「失败 + 用户跳过」的子集计划', async () => {
  const port = new MockImportPort({
    result: makeImportResult({
      executed: [
        { itemId: 'settings:a', status: 'ok' },
        { itemId: 'settings:b', status: 'ok' },
        { itemId: 'plugin:x', status: 'failed', message: '网络超时' },
        { itemId: 'plugin:y', status: 'skipped', skippedByUser: true },
        { itemId: 'prompt:p', status: 'ok' },
        { itemId: 'mcp:m', status: 'ok' },
        { itemId: 'secret:K1', status: 'skipped' },
      ],
    }),
  });
  const wiz = new ImportWizard({ port });
  await wiz.selectZip('x.zip');
  await wiz.confirmCompatibility();
  await wiz.execute({ confirm: true });
  assert.equal(wiz.retryableCount(), 2, 'plugin:x(failed) + plugin:y(用户跳过)')

  await wiz.executeRetry({});
  assert.equal(wiz.currentStep, 'result', '重试完成后回到结果页');
  assert.equal(port.executeCalls.length, 2, '第二次 execute 调用为重试');
  const retryPlan = port.executeCalls[1]!.plan;
  assert.ok(retryPlan !== undefined, '重试应携带子集计划');
  assert.deepEqual(
    retryPlan.items.map((i) => i.id),
    ['plugin:x', 'plugin:y'],
    '重试计划只含 failed/用户跳过 项（顺序按原计划）',
  );
  assert.equal(retryPlan.pathMappings.length, 0, '子集计划保留 pathMappings');
});

/* ---------------- t45：从 ImportWizardView 迁出的流程/派生纯函数（此前无测试） ---------------- */

const conflictPlan = (): ImportPlan => makePlan({
  items: [
    makePlanItem({ id: 'settings:a', kind: 'Conflict', description: '冲突 a' }),
    makePlanItem({ id: 'settings:b', kind: 'Create', description: '创建 b' }),
  ],
});

test('importFlowFlags：从 Dry Run 产物派生「是否有该阶段」三标志', () => {
  assert.deepEqual(importFlowFlags({ plan: null, analysis: null, decryptRefs: [] }), {
    hasConflicts: false, hasPathIssues: false, hasSecrets: false,
  });
  assert.deepEqual(importFlowFlags({ plan: makePlan(), analysis: makeAnalysis(), decryptRefs: [] }), {
    hasConflicts: false, hasPathIssues: false, hasSecrets: true,
  });
  assert.equal(importFlowFlags({ plan: conflictPlan(), analysis: null, decryptRefs: [] }).hasConflicts, true);
  assert.equal(
    importFlowFlags({ plan: null, analysis: makeAnalysis({ pathIssues: [{ path: 'C:/x', reason: 'r' }] as never }), decryptRefs: [] }).hasPathIssues,
    true,
  );
  // 解密已覆盖的 ref 不再要求补录 → 无 secrets 阶段
  assert.equal(importFlowFlags({ plan: makePlan(), analysis: null, decryptRefs: ['K1'] }).hasSecrets, false);
  assert.equal(importFlowFlags({ plan: makePlan(), analysis: null, decryptRefs: ['OTHER'] }).hasSecrets, true);
});

test('pendingSecretRequests：剔除解密已覆盖的 ref，无 plan → 空数组', () => {
  assert.deepEqual(pendingSecretRequests(null, []), []);
  assert.deepEqual(pendingSecretRequests(makePlan(), []), [{ ref: 'K1', required: true }]);
  assert.deepEqual(pendingSecretRequests(makePlan(), ['K1']), []);
});

test('importApplicablePhases：阶段有序且只含需处理项；加密容器未解锁恒排最前', () => {
  assert.deepEqual(
    importApplicablePhases({ containerEncrypted: false, archiveUnlocked: false, hasConflicts: false, hasPathIssues: false, hasSecrets: false }),
    ['confirm'],
  );
  assert.deepEqual(
    importApplicablePhases({ containerEncrypted: false, archiveUnlocked: false, hasConflicts: true, hasPathIssues: true, hasSecrets: true }),
    ['conflicts', 'path-mapping', 'secrets', 'confirm'],
  );
  assert.deepEqual(
    importApplicablePhases({ containerEncrypted: true, archiveUnlocked: false, hasConflicts: true, hasPathIssues: false, hasSecrets: false }),
    ['decrypt-archive', 'conflicts', 'confirm'],
    '未解锁 → decrypt-archive 第一',
  );
  assert.deepEqual(
    importApplicablePhases({ containerEncrypted: true, archiveUnlocked: true, hasConflicts: false, hasPathIssues: false, hasSecrets: false }),
    ['confirm'],
    '已解锁 → 不再有 decrypt-archive',
  );
});

test('nextImportPhase：只前进（不回退已过阶段），confirm 原地', () => {
  const inputs = { containerEncrypted: false, archiveUnlocked: false, hasConflicts: true, hasPathIssues: true, hasSecrets: true };
  assert.equal(nextImportPhase(inputs, 'preview'), 'conflicts', 'from 不在列表 → 取第一项');
  assert.equal(nextImportPhase(inputs, 'conflicts'), 'path-mapping');
  assert.equal(nextImportPhase(inputs, 'path-mapping'), 'secrets');
  assert.equal(nextImportPhase(inputs, 'secrets'), 'confirm');
  assert.equal(nextImportPhase(inputs, 'confirm'), 'confirm', 'confirm 是终点，原地返回');
  // 已解决阶段仍出现在列表中，但「从后面回来」不会被重新命中（只前进）
  assert.equal(nextImportPhase(inputs, 'secrets'), 'confirm');
});

test('compatibilityLevel / compatibilityBadgeKind：四级映射 + 未知值回落 excellent（此前无测试的分支）', () => {
  for (const c of ['unsupported', 'partial', 'good', 'excellent'] as const) {
    assert.equal(compatibilityLevel(c), c);
  }
  assert.equal(compatibilityLevel('something-new-from-host'), 'excellent', '未知值按历史行为落到 excellent');
  assert.equal(compatibilityBadgeKind('unsupported'), 'error');
  assert.equal(compatibilityBadgeKind('partial'), 'warn');
  assert.equal(compatibilityBadgeKind('good'), 'ok');
  assert.equal(compatibilityBadgeKind('excellent'), 'ok');
});

test('importPreviewStageAfter：换备份回咨询页；「下一步」进内容选择页（幂等）', () => {
  assert.equal(importPreviewStageAfter('new-zip', 'select'), 'consult');
  assert.equal(importPreviewStageAfter('new-zip', 'consult'), 'consult');
  assert.equal(importPreviewStageAfter('next', 'consult'), 'select');
  assert.equal(importPreviewStageAfter('next', 'select'), 'select', '已在该页保持');
});

test('isSkippablePluginInstall：仅插件安装中且未请求跳过时可跳过（此前无测试的分支）', () => {
  assert.equal(isSkippablePluginInstall('plugin:@x/y', true, false), true);
  assert.equal(isSkippablePluginInstall('plugin:left-pad', true, true), false, '已请求跳过 → 不再显示');
  assert.equal(isSkippablePluginInstall('plugin:x', false, false), false, '未在运行 → 不显示');
  assert.equal(isSkippablePluginInstall('settings:a', true, false), false, '非插件项不可跳过');
  assert.equal(isSkippablePluginInstall(undefined, true, false), false, '无 detail 不显示');
  assert.equal(isSkippablePluginInstall('', true, false), false);
});

/* ---------------- issue #45：跨机基础路径自动重定基的提示行 ---------------- */

test('importBasePathNotices：有自动重定基规则才产出提示行（null / 无规则 → 空）', () => {
  assert.deepEqual(importBasePathNotices(null), []);
  assert.deepEqual(importBasePathNotices({}), [], '同机导入（无 automaticMappings）不显示任何提示');
  assert.deepEqual(
    importBasePathNotices({ automaticMappings: [{ oldPrefix: '/opt/dsh/.dsh', newPrefix: 'C:/Users/me/.dsh' }] }),
    [{ from: '/opt/dsh/.dsh', to: 'C:/Users/me/.dsh' }],
  );
});
