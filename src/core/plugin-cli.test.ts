/**
 * plugin-cli 失败分类器测试（M2）：classifyDshPluginFailure / isTransientDshPluginFailure /
 * installErrorFor。纯函数，样本文本取自 pnpm 真实诊断形态（dshmarket pnpm-compat 矩阵）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDshPluginFailure, installErrorFor, isTransientDshPluginFailure,
  resolveProfileNameFromArgv,
  type DshPluginResult,
} from './plugin-cli.ts';

test('resolveProfileNameFromArgv: --profile 取值 / 缺省 web / 非法值宽容回退', () => {
  assert.equal(resolveProfileNameFromArgv(['--profile', 'tui']), 'tui');
  assert.equal(resolveProfileNameFromArgv(['web', '--profile', 'headless', 'x']), 'headless');
  assert.equal(resolveProfileNameFromArgv(['--profile']), 'web', '缺值回退');
  assert.equal(resolveProfileNameFromArgv(['--profile', '--flag']), 'web', '值以 - 开头回退');
  assert.equal(resolveProfileNameFromArgv([]), 'web');
  assert.equal(resolveProfileNameFromArgv(['--profile', '../evil']), 'web', '非法值不抛错回退（消息构建路径安全）');
});

test('classify: ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF → hoist-pattern-diff (recoverable)', () => {
  const f = classifyDshPluginFailure('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF\nsome pnpm output');
  assert.equal(f?.code, 'hoist-pattern-diff');
  assert.equal(f?.recoverable, true);
  assert.match(f!.message, /pnpm install/);
});

test('classify: ERR_PNPM_ADDING_TO_ROOT → adding-to-root', () => {
  const f = classifyDshPluginFailure('ERR_PNPM_ADDING_TO_ROOT Running this command will add the dependency to the workspace root');
  assert.equal(f?.code, 'adding-to-root');
  assert.match(f!.message, /add -w/);
});

test('classify: --workspace-root may only be used inside a workspace → not-a-workspace', () => {
  const f = classifyDshPluginFailure('ERR_PNPM_WORKSPACE_ROOT "--workspace-root may only be used inside a workspace"');
  assert.equal(f?.code, 'not-a-workspace');
  assert.equal(f?.recoverable, false);
});

test('classify: minimumReleaseAge（两个错误码）→ release-age-violation', () => {
  const a = classifyDshPluginFailure('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION');
  const b = classifyDshPluginFailure('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
  assert.equal(a?.code, 'release-age-violation');
  assert.equal(b?.code, 'release-age-violation');
  assert.match(a!.message, /minimumReleaseAge/);
});

test('classify: git 构建脚本 allowBuilds 拦截（pnpm 10 句子 / pnpm 11 错误码）→ git-build-blocked', () => {
  const sentence = 'The git-hosted package "dsh-memory-evolve@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.';
  const a = classifyDshPluginFailure(sentence);
  const b = classifyDshPluginFailure('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED');
  assert.equal(a?.code, 'git-build-blocked');
  assert.equal(b?.code, 'git-build-blocked');
  assert.match(a!.message, /allowBuilds/);
});

test('classify: ERR_PNPM_FETCH_404 → fetch-404（含包名提取）', () => {
  const out = 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/some-ghost-pkg: Not Found - 404';
  const f = classifyDshPluginFailure(out);
  assert.equal(f?.code, 'fetch-404');
  assert.match(f!.message, /some-ghost-pkg/);
});

test('classify: 瞬时网络（各形态）→ transient-network，recoverable', () => {
  const samples = [
    'ERR_PNPM_FETCH_503 Service Unavailable',
    'ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: request failed',
    'FetchError: request to https://registry.npmjs.org/x failed, reason: socket hang up',
    'fetch failed: ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'network timeout',
  ];
  for (const s of samples) {
    assert.equal(classifyDshPluginFailure(s)?.code, 'transient-network', `sample: ${s}`);
  }
  assert.equal(isTransientDshPluginFailure('ERR_PNPM_FETCH_503'), true);
  assert.equal(isTransientDshPluginFailure('ECONNRESET'), true);
  assert.equal(isTransientDshPluginFailure('ERR_PNPM_FETCH_404'), false, '404 不算瞬时网络');
});

test('classify: pnpm not found → pnpm-missing', () => {
  const f = classifyDshPluginFailure('dsh: pnpm not found on PATH — install pnpm to manage profile plugins');
  assert.equal(f?.code, 'pnpm-missing');
  assert.match(f!.message, /pnpm/);
});

test('classify: 未识别输出 → null', () => {
  assert.equal(classifyDshPluginFailure('some random pnpm error text'), null);
  assert.equal(classifyDshPluginFailure(''), null);
});

test('installErrorFor: spawnError(ENOENT) → dsh 不可用提示', () => {
  const r: DshPluginResult = { exitCode: 127, timedOut: false, stdout: '', stderr: '', spawnError: 'spawn dsh ENOENT' };
  const e = installErrorFor('pkg-a', r);
  assert.match(e.message, /dsh CLI/);
});

test('installErrorFor: timedOut → 超时提示', () => {
  const r: DshPluginResult = { exitCode: null, timedOut: true, stdout: '', stderr: '' };
  const e = installErrorFor('pkg-a', r);
  assert.match(e.message, /超时/);
});

test('installErrorFor: 已分类失败 → 双语可读消息 + code', () => {
  const r: DshPluginResult = {
    exitCode: 1, timedOut: false,
    stdout: '', stderr: 'ERR_PNPM_FETCH_503 Service Unavailable',
  };
  const e = installErrorFor('pkg-a', r);
  assert.match(e.message, /transient-network/);
  assert.match(e.message, /网络临时失败/);
  assert.match(e.message, /transient network/);
});

test('installErrorFor: 未识别 → stderr 尾部摘要', () => {
  const r: DshPluginResult = {
    exitCode: 1, timedOut: false,
    stdout: 'line1', stderr: 'mystery error line\nanother line',
  };
  const e = installErrorFor('pkg-a', r);
  assert.match(e.message, /exit 1/);
  assert.match(e.message, /mystery error line/);
});
