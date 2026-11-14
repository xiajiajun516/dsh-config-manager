/**
 * issue #136 A/C：patch 行写回守卫的纯逻辑测试。
 *
 * 三条必须钉住的事实：
 *  - 载荷声明了「被剥空」的路径 + 本机同叶子非空 → 保留本机值，绝不写空；
 *  - 载荷给的是**真实非空新值** → 照常写入（守卫不得挡住远端新配置）；
 *  - 只有逐行显式确认（confirmed）才允许清空；旧载荷（无声明路径）走保守分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatchSecretGuard, __test } from './patch-secret-guard.ts';

test('#136 守卫：声明路径 + 导入空 + 本机非空 → 保留本机值（不写空）', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { id: 'gate', config: { apiKey: '' } },
    localRaw: { id: 'gate', config: { apiKey: 'sk-local-plain' } },
    redactedPaths: ['raw.config.apiKey'],
    confirmed: false,
  });
  assert.deepEqual(r.raw, { id: 'gate', config: { apiKey: 'sk-local-plain' } }, '被剥空的叶子必须换回本机值');
  assert.deepEqual(r.kept, ['raw.config.apiKey'], '报告只带路径，不带值');
  assert.deepEqual(r.cleared, []);
  assert.equal(r.conservative, false, '有声明路径 → 非保守分支');
  // 报告面（kept/cleared）只有路径：这是能直接进事务报告/日志的部分（raw 本身是写盘载荷，必然含本机值）
  assert.equal(JSON.stringify({ kept: r.kept, cleared: r.cleared }).includes('sk-local-plain'), false, '报告里不得出现值本身');
});

test('#136 守卫：声明路径 + 导入真实非空新值 → 照常写入（不回归远端更新）', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { id: 'gate', config: { apiKey: 'sk-remote-new' } },
    localRaw: { id: 'gate', config: { apiKey: 'sk-local-old' } },
    redactedPaths: ['raw.config.apiKey'],
    confirmed: false,
  });
  assert.deepEqual(r.raw, { id: 'gate', config: { apiKey: 'sk-remote-new' } }, '远端真值必须落地');
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.cleared, []);
});

test('#136 守卫：逐行显式确认（confirmed）→ 允许清空，并把「已清空」写进结果', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { id: 'gate', config: { apiKey: '' } },
    localRaw: { id: 'gate', config: { apiKey: 'sk-local-plain' } },
    redactedPaths: ['raw.config.apiKey'],
    confirmed: true,
  });
  assert.deepEqual(r.raw, { id: 'gate', config: { apiKey: '' } }, '确认后按导入值写空');
  assert.deepEqual(r.cleared, ['raw.config.apiKey']);
  assert.deepEqual(r.kept, []);
});

test('#136 守卫：旧载荷（无 redactedPaths）→ 保守分支：空串 + 本机非空即保留 + warning 路径', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { id: 'gate', nested: { token: '' }, keep: 'same' },
    localRaw: { id: 'gate', nested: { token: 'plain-token' }, keep: 'same' },
    confirmed: false,
  });
  assert.equal(r.conservative, true, '缺字段 = 未知 → 保守');
  assert.deepEqual(r.raw, { id: 'gate', nested: { token: 'plain-token' }, keep: 'same' });
  assert.deepEqual(r.kept, ['raw.nested.token']);
});

test('#136 守卫：旧载荷保守分支也允许在显式确认后清空（不把「用户主动清空」永久锁死）', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { id: 'gate', token: '' },
    localRaw: { id: 'gate', token: 'plain-token' },
    confirmed: true,
  });
  assert.equal(r.conservative, true);
  assert.deepEqual(r.raw, { id: 'gate', token: '' });
  assert.deepEqual(r.cleared, ['raw.token']);
});

test('#136 守卫：本机没有这一行（Create）→ 原样返回，不凭空造保护', () => {
  const imported = { id: 'new-line', token: '' };
  const r = applyPatchSecretGuard({ importedRaw: imported, localRaw: undefined, confirmed: false });
  assert.deepEqual(r.raw, imported);
  assert.deepEqual(r.kept, []);
  assert.equal(r.conservative, false);
});

test('#136 守卫：数组路径（扫描器语法 a.b[0].c）逐段解析与展示', () => {
  assert.deepEqual(__test.parsePath('raw.mcp.args[2].token'), ['raw', 'mcp', 'args', 2, 'token']);
  assert.equal(__test.formatPath(['raw', 'mcp', 'args', 2, 'token']), 'raw.mcp.args[2].token');
  const r = applyPatchSecretGuard({
    importedRaw: { mcp: { args: [{ token: 'a' }, { token: '' }] } },
    localRaw: { mcp: { args: [{ token: 'a' }, { token: 'local-b' }] } },
    redactedPaths: ['raw.mcp.args[1].token'],
    confirmed: false,
  });
  assert.equal((r.raw as { mcp: { args: { token: string }[] } }).mcp.args[1]?.token, 'local-b');
  assert.deepEqual(r.kept, ['raw.mcp.args[1].token']);
});

test('#136 守卫：语法不认识的声明路径 → 宁可放过（不误判、不崩）', () => {
  const imported = { a: '' };
  const r = applyPatchSecretGuard({
    importedRaw: imported, localRaw: { a: 'local' }, redactedPaths: ['[[bad'], confirmed: false,
  });
  assert.deepEqual(r.raw, imported);
  assert.deepEqual(r.kept, []);
});

test('#136 守卫：本机同叶子为空 → 无保护对象（导入空仍写空，值确实一致）', () => {
  const r = applyPatchSecretGuard({
    importedRaw: { token: '' }, localRaw: { token: '' }, redactedPaths: ['raw.token'], confirmed: false,
  });
  assert.deepEqual(r.raw, { token: '' });
  assert.deepEqual(r.kept, []);
});
