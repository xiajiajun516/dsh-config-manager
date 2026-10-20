/**
 * plugin-cli 失败分类器测试（M2）：classifyDshPluginFailure / isTransientDshPluginFailure /
 * installErrorFor。纯函数，样本文本取自 pnpm 真实诊断形态（dshmarket pnpm-compat 矩阵）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDshPluginFailure, dshArgv, installAnchorFromProfileContext, installErrorFor, isTransientDshPluginFailure,
  pluginInstallTarget,
  profileNameFromArgv, profileNameFromDir, profileNameFromProfileContext,
  resolveProcessProfileName, resolveProfileNameFromEnv,
  type DshPluginResult,
} from './plugin-cli.ts';
import type { DesktopCarrier } from '../utils/desktop-carrier.ts';

test('profileNameFromArgv: 取值（含 --profile=<name>）/ 空数组 / 非法值宽容回退（不抛错）', () => {
  assert.equal(profileNameFromArgv(['--profile', 'tui']), 'tui');
  assert.equal(profileNameFromArgv(['web', '--profile', 'headless', 'x']), 'headless');
  assert.equal(profileNameFromArgv(['--profile=headless']), 'headless', '--profile=x 形态');
  assert.equal(profileNameFromArgv(['--profile']), null, '缺值');
  assert.equal(profileNameFromArgv(['--profile=']), null, '空值');
  assert.equal(profileNameFromArgv(['--profile', '--flag']), null, '值以 - 开头');
  assert.equal(profileNameFromArgv([]), null);
  assert.equal(profileNameFromArgv(['-x', '--profile=a/b']), null, '非法值 → null（交由上层继续回退）');
  assert.equal(profileNameFromArgv(['--profile', '../evil']), null, '非法值不抛错（消息构建路径安全）');
});

test('resolveProfileNameFromEnv: DSH_PROFILE → DSH_PROFILE_DIR 叶子名 → null', () => {
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE: 'desktop' }), 'desktop');
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE: '  desktop  ' }), 'desktop', '两端空白去除');
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE_DIR: 'C:\\Users\\me\\.dsh\\profiles\\desktop' }), 'desktop', 'Windows 形态目录（POSIX 上同样解析）');
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE_DIR: '/home/me/.dsh/profiles/work/' }), 'work');
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE: '../evil', DSH_PROFILE_DIR: '/h/.dsh/profiles/work' }), 'work', 'DSH_PROFILE 非法 → 继续尝试 DSH_PROFILE_DIR');
  assert.equal(resolveProfileNameFromEnv({}), null);
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE: '   ', DSH_PROFILE_DIR: '' }), null);
  assert.equal(resolveProfileNameFromEnv({ DSH_PROFILE_DIR: '/h/.dsh/profiles/node_modules' }), null, '保留名 → null');
});

test('profileNameFromProfileContext: 取宿主 profileContext 服务的 name，退化到 dir（issue #52）', () => {
  assert.equal(profileNameFromDir('/a/b/profiles/work/'), 'work');
  assert.equal(profileNameFromDir(''), null);
  assert.equal(profileNameFromProfileContext({ name: 'desktop', dir: '/home/me/.dsh/profiles/desktop' }), 'desktop');
  assert.equal(profileNameFromProfileContext({ name: ' desktop ' }), 'desktop');
  assert.equal(profileNameFromProfileContext(null), null);
  assert.equal(profileNameFromProfileContext(undefined), null);
  assert.equal(profileNameFromProfileContext('desktop'), null, '非对象 → null（不猜）');
  assert.equal(profileNameFromProfileContext({}), null);
  assert.equal(profileNameFromProfileContext({ name: '' }), null);
  assert.equal(profileNameFromProfileContext({ name: 42 }), null);
  assert.equal(profileNameFromProfileContext({ name: '../evil' }), null, '非法名且无 dir → null');
  assert.equal(profileNameFromProfileContext({ name: '../evil', dir: '/h/.dsh/profiles/work' }), 'work', 'name 非法 → 退到 dir 叶子名');
  assert.equal(profileNameFromProfileContext({ dir: 'C:\\Users\\me\\.dsh\\profiles\\desktop' }), 'desktop', '缺 name → 用 dir（Windows 形态）');
  assert.equal(profileNameFromProfileContext({ dir: '/h/.dsh/profiles/node_modules' }), null, 'dir 叶子是保留名 → null');
});

test('resolveProcessProfileName: --profile > DSH_PROFILE > 缺省 web', () => {
  assert.equal(resolveProcessProfileName(['--profile', 'tui'], {}), 'tui');
  assert.equal(resolveProcessProfileName(['--profile', 'tui'], { DSH_PROFILE: 'desktop' }), 'tui', '显式参数优先于外壳注入的环境变量');
  assert.equal(resolveProcessProfileName([], { DSH_PROFILE: 'desktop' }), 'desktop');
  assert.equal(resolveProcessProfileName([], { DSH_PROFILE_DIR: '/h/.dsh/profiles/work' }), 'work');
  assert.equal(resolveProcessProfileName([], {}), 'web');
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

test('classify: patchedDependencies 的 patch 文件缺失 → patch-file-missing（可操作）', () => {
  const zhOut = 'Error: × adding a new package\n╰─▶ Failed to read patch file C:\\Users\\x\\.dsh\\profiles\\web\\patches/dsh-approval-gate.patch:\n    系统找不到指定的文件。 (os error 2)';
  const f = classifyDshPluginFailure(zhOut);
  assert.equal(f?.code, 'patch-file-missing');
  assert.equal(f?.recoverable, false, '需要人工把 patch 文件放回或删掉声明，重试不会自愈');
  assert.match(f!.message, /patches\/dsh-approval-gate\.patch/, '必须点名缺失的 patch 文件');
  assert.match(f!.message, /patchedDependencies/);
  // 英文形态同样识别
  assert.equal(classifyDshPluginFailure('Failed to read patch file /home/u/.dsh/profiles/web/patches/a.patch: ENOENT')?.code, 'patch-file-missing');
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

/* ------------------------------------- 桌面端兼容（Desktop 保留档案） */

test('installAnchorFromProfileContext：取宿主 profileContext.installAnchor（真正在跑的那份 runtime）', () => {
  assert.equal(
    installAnchorFromProfileContext({ installAnchor: 'C:\\Apps\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\package.json' }),
    'C:\\Apps\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\package.json',
  );
  assert.equal(installAnchorFromProfileContext({ installAnchor: '  /x/dsh/package.json  ' }), '/x/dsh/package.json', '两端空白去除');
  assert.equal(installAnchorFromProfileContext({}), null);
  assert.equal(installAnchorFromProfileContext({ installAnchor: '' }), null);
  assert.equal(installAnchorFromProfileContext({ installAnchor: 42 }), null);
  assert.equal(installAnchorFromProfileContext(null), null);
  assert.equal(installAnchorFromProfileContext('x'), null, '非对象 → 不猜');
});

const CARRIER: DesktopCarrier = {
  cliPath: 'C:\\Apps\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
  execPath: 'C:\\Apps\\DSH\\DeepSeek Harness.exe',
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

test('pluginInstallTarget：安装目标决策表（issue #101 空转修复）', () => {
  const cases: { name: string; pkg: string; input: { version?: string | undefined; spec?: string | undefined; tarballPath?: string | undefined }; expected: string }[] = [
    { name: '备份内 tarball 优先于版本与 spec', pkg: 'p', input: { version: '1.0.0', spec: '^2.0.0', tarballPath: '/h/plugins/p.tgz' }, expected: 'file:/h/plugins/p.tgz' },
    { name: '空 tarball 视为没有（回落 spec）', pkg: 'p', input: { tarballPath: '', spec: 'github:u/r' }, expected: 'github:u/r' },
    { name: '非 registry 来源（github:）原样，手里的 version 不再拼', pkg: 'p', input: { version: '1.0.0', spec: 'github:u/r' }, expected: 'github:u/r' },
    { name: '非 registry 来源（file:）原样', pkg: 'p', input: { spec: 'file:../local-p' }, expected: 'file:../local-p' },
    {
      name: '具体 semver → 精确版本（修复升级空转）',
      pkg: 'dsh-free-search',
      input: { version: '0.9.5', spec: '0.9.3' },
      expected: 'dsh-free-search@0.9.5',
    },
    { name: '预发布版本同样精确', pkg: 'p', input: { version: '1.0.0-rc.2' }, expected: 'p@1.0.0-rc.2' },
    { name: '带 build 元数据同样精确', pkg: 'p', input: { version: '1.0.0+build.7' }, expected: 'p@1.0.0+build.7' },
    { name: 'version 不是具体版本 → 落到 spec', pkg: 'p', input: { version: 'latest', spec: '^1.2.3' }, expected: 'p@^1.2.3' },
    { name: 'registry 区间 spec 带包名（手交给 pnpm 解析）', pkg: 'dshmarket', input: { spec: '^1.66.38' }, expected: 'dshmarket@^1.66.38' },
    { name: 'dist-tag spec 带包名', pkg: 'p', input: { spec: 'next' }, expected: 'p@next' },
    { name: '旧备份：version / spec 全缺 → 裸包名（改造前行为）', pkg: 'p', input: {}, expected: 'p' },
    { name: '空字符串按缺省处理', pkg: 'p', input: { version: '', spec: '' }, expected: 'p' },
  ];
  for (const c of cases) {
    assert.equal(pluginInstallTarget(c.pkg, c.input), c.expected, c.name);
  }
});

test('dshArgv：desktop 档案走桌面端 CLI 载体（普通 dsh CLI 对它硬拒绝）', () => {
  const argv = dshArgv('desktop', CARRIER);
  assert.equal(argv.file, CARRIER.execPath, '必须用 Electron 主程序（Node 模式）启动载体');
  assert.deepEqual(argv.args, [CARRIER.cliPath], 'argv[1] 就是宿主同目录的 cli.js');
  assert.equal(argv.viaShell, false, 'exe 直接 spawn，不经 cmd.exe');
  assert.deepEqual(argv.env, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(dshArgv('DESKTOP', CARRIER).file, CARRIER.execPath, '大小写不敏感（dsh CLI 同口径）');
});

test('dshArgv：非 desktop 档案 / 检测不到载体 → 落回通用路径（不改变既有行为）', () => {
  // 非 desktop 档案：即便载体存在也必须走通用路径（普通 dsh 入口 / PATH 上的 dsh）
  const web = dshArgv('web', CARRIER);
  assert.notEqual(web.file, CARRIER.execPath, 'web 档案不得被塞进桌面端载体');
  // 检测不到载体时，desktop 也落回通用路径 —— 真实失败信息由分类器给出（见下一条）
  const fallback = dshArgv('desktop', null);
  assert.notEqual(fallback.file, CARRIER.execPath);
});

test('classify: profile "desktop" is managed exclusively → desktop-profile-reserved（可操作说明）', () => {
  const output = 'error: profile "desktop" is managed exclusively by the Electron application';
  const f = classifyDshPluginFailure(output);
  assert.equal(f?.code, 'desktop-profile-reserved');
  assert.equal(f?.recoverable, false);
  assert.match(f!.message, /desktop/);
  assert.match(f!.message, /DeepSeek Harness Desktop/);
  assert.match(f!.message, /Desktop-bundled CLI carrier/, '双语消息（zh / en 同一字符串）');
  const e = installErrorFor('@scope/pkg', { exitCode: 1, timedOut: false, stdout: '', stderr: output });
  assert.match(e.message, /desktop-profile-reserved/);
});
