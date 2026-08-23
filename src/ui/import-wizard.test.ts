/**
 * import-wizard 测试（m6-ui）：
 *  - 步骤状态机 select→analyzing→compatibility→preview→importing→result
 *  - 显式 rollbackOnError（场景 E 默认 true）
 *  - Preview 摘要（§10）
 *  - confirm 安全阀、进度事件、reset
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ImportWizard } from './import-wizard.ts';
import { MockImportPort, makeAnalysis, makeImportResult, makePlan } from './test-helpers.ts';

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
