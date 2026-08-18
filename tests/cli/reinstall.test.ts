/**
 * reinstall 命令单测（tester，criterion m3-cli-works / reinstall）。
 *
 * 风格与 tests/cli/cli.test.ts 一致：node:test + node:assert/strict，纯函数注入
 * （exec / env / platform）测试，不触真实系统。
 *
 * 覆盖：
 *  - src/core/reinstall.ts 纯函数（isWindows/resolveDshHome/shellQuote/psQuote/
 *    rmCommand/copyDirCommand/resolvePnpmStoreDir/buildReinstallPlan）——完整激活。
 *    命令构建器与 buildReinstallPlan 接受可选 platform 参数（缺省 process.platform），
 *    故可在任意宿主上一次性断言 Windows / Unix 两套输出。
 *  - src/cli/index.ts 的 reinstall 接入与交互纯函数（parseCli reinstall / runCli
 *    dry-run / --list / parseSelectionInput / parseConfirmInput）——R-CLI 块，
 *    动态导入 + 能力探测，t3 未完成时自动跳过；当前 t3 已完成，本块激活。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  REINSTALL_ITEMS,
  buildReinstallPlan,
  copyDirCommand,
  isWindows,
  psQuote,
  resolveDshHome,
  resolvePnpmStoreDir,
  rmCommand,
  shellQuote,
  type ReinstallItemId,
} from '../../src/core/reinstall.ts';

/* ------------------------------------------------------------ core 纯函数 */

test('R-01 isWindows：可注入平台（win32→true；darwin/linux→false）', () => {
  assert.equal(isWindows('win32'), true);
  assert.equal(isWindows('darwin'), false);
  assert.equal(isWindows('linux'), false);
});

test('R-02 resolveDshHome：DSH_HOME 优先，缺省 ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/home' }), '/custom/home');
  assert.equal(resolveDshHome({ DSH_HOME: '' }), path.join(os.homedir(), '.dsh'));
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'));
});

test('R-03 shellQuote（POSIX）与 psQuote（PowerShell）：单引号转义', () => {
  // POSIX：单引号包裹，内嵌单引号按 \' 折叠
  assert.equal(shellQuote('/a b'), "'/a b'");
  assert.equal(shellQuote("/a/b'c"), "'/a/b'\\''c'", "POSIX 单引号折叠（反斜杠-引号）");
  // PowerShell：单引号包裹，内嵌单引号用 '' 翻倍
  assert.equal(psQuote('/a b'), "'/a b'");
  assert.equal(psQuote("/home/o'brien"), "'/home/o''brien'", "PowerShell 单引号翻倍（两个单引号）");
});

test('R-04 rmCommand：平台可注入——Windows Remove-Item / Unix rm -rf', () => {
  assert.equal(
    rmCommand('/x dir', 'win32'),
    "Remove-Item -Recurse -Force '/x dir' -ErrorAction SilentlyContinue",
  );
  assert.equal(rmCommand('/x dir', 'linux'), "rm -rf '/x dir'");
  // 含单引号路径：Windows 用 psQuote（'' 翻倍），POSIX 用 shellQuote（\'）
  assert.equal(
    rmCommand("/home/o'brien", 'win32'),
    "Remove-Item -Recurse -Force '/home/o''brien' -ErrorAction SilentlyContinue",
  );
  assert.equal(rmCommand("/home/o'brien", 'linux'), "rm -rf '/home/o'\\''brien'");
});

test('R-05 copyDirCommand：平台可注入——先删旧再拷', () => {
  assert.equal(
    copyDirCommand('/src', '/dest', 'win32'),
    "Remove-Item -Recurse -Force '/dest' -ErrorAction SilentlyContinue; Copy-Item -Recurse '/src' '/dest' -ErrorAction SilentlyContinue",
  );
  assert.equal(
    copyDirCommand('/src', '/dest', 'linux'),
    "rm -rf '/dest'; cp -r '/src' '/dest' 2>/dev/null; true",
  );
});

test('R-06 resolvePnpmStoreDir：PNPM_STORE_PATH 优先，否则按注入平台默认', () => {
  assert.equal(resolvePnpmStoreDir({ PNPM_STORE_PATH: '/explicit/store' }, 'win32'), '/explicit/store');
  assert.equal(resolvePnpmStoreDir({}, 'win32'), null, 'win32 无 LOCALAPPDATA 且无显式 → null');
  assert.equal(
    resolvePnpmStoreDir({ LOCALAPPDATA: '/localappdata' }, 'win32'),
    path.join('/localappdata', 'pnpm', 'store'),
  );
  assert.equal(
    resolvePnpmStoreDir({}, 'linux'),
    path.join(os.homedir(), '.local', 'share', 'pnpm', 'store'),
    'unix 默认 ~/.local/share/pnpm/store',
  );
});

test('R-07 buildReinstallPlan program：生成 4 步（卸载/清残留/安装/验证）双平台', async () => {
  const exec = async (cmd: string): Promise<string> => {
    assert.equal(cmd, 'npm root -g', 'program 类别只需调用 npm root -g 解析全局路径');
    return '/fake/global';
  };
  for (const platform of ['linux', 'win32'] as const) {
    const plan = await buildReinstallPlan(new Set<ReinstallItemId>(['program']), 'latest', exec, { DSH_HOME: '/home' }, platform);

    assert.equal(plan.version, 'latest');
    assert.equal(plan.wipeConfig, false, '仅 program → 不触及配置，wipeConfig=false');
    assert.equal(plan.steps.length, 4, 'program 类别应恰好 4 步');
    assert.equal(plan.steps[0]!.label, '卸载全局 @deepseek-ai/dsh');
    assert.equal(plan.steps[0]!.command, 'npm uninstall -g @deepseek-ai/dsh');
    assert.equal(plan.steps[0]!.dangerous, false);
    assert.equal(
      plan.steps[1]!.command,
      rmCommand(path.join('/fake/global', '@deepseek-ai', 'dsh'), platform),
      '清理全局残留目录（随平台）',
    );
    assert.equal(plan.steps[2]!.command, 'npm install -g @deepseek-ai/dsh@latest', '缺省 latest');
    assert.equal(plan.steps[3]!.command, 'dsh --version', '验证步骤');
  }
});

test('R-08 buildReinstallPlan program 指定版本：安装命令含指定 version', async () => {
  const exec = async () => '/fake/global';
  const plan = await buildReinstallPlan(new Set<ReinstallItemId>(['program']), '0.1.0-rc.6', exec, { DSH_HOME: '/home' }, 'linux');
  assert.equal(plan.version, '0.1.0-rc.6');
  assert.ok(plan.steps.some((s) => s.command === 'npm install -g @deepseek-ai/dsh@0.1.0-rc.6'), '安装命令含指定版本');
});

test('R-09 buildReinstallPlan cache：清 pnpm store + npm cache clean --force', async () => {
  const exec = async (): Promise<string> => {
    throw new Error('cache 类别不应调用 exec');
  };
  const plan = await buildReinstallPlan(
    new Set<ReinstallItemId>(['cache']),
    'latest',
    exec,
    { DSH_HOME: '/home', PNPM_STORE_PATH: '/store' },
    'linux',
  );
  assert.equal(plan.wipeConfig, false);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]!.command, rmCommand('/store', 'linux'), '清理 pnpm store');
  assert.equal(plan.steps[1]!.command, 'npm cache clean --force', '清理 npm cache');
  assert.ok(plan.steps.every((s) => s.dangerous === false), 'cache 非危险');
});

test('R-10 buildReinstallPlan 数据类（settings/plugins/data）：危险步骤 + 备份兜底 + wipeConfig=true', async () => {
  const exec = async (): Promise<string> => {
    throw new Error('数据类不应调用 exec');
  };
  const plan = await buildReinstallPlan(
    new Set<ReinstallItemId>(['settings', 'plugins', 'data']),
    'latest',
    exec,
    { DSH_HOME: '/home' },
    'linux',
  );

  assert.equal(plan.wipeConfig, true, '选了数据类 → wipeConfig=true');
  // 清除 ~/.dsh 数据前的抢救备份（dangerous）放在最前
  assert.equal(plan.steps[0]!.label, '备份 ~/.dsh 到同级 .reinstall-backup（抢救兜底）');
  assert.equal(plan.steps[0]!.command, copyDirCommand('/home', '/home.reinstall-backup', 'linux'));
  assert.equal(plan.steps[0]!.dangerous, true);

  // settings / plugins / data 各生成删除步骤，全部 dangerous
  const commands = plan.steps.map((s) => s.command);
  assert.ok(commands.includes(rmCommand(path.join('/home', 'settings.yaml'), 'linux')), '清空 settings.yaml');
  assert.ok(commands.includes(rmCommand(path.join('/home', 'profiles'), 'linux')), '清空已装插件 profiles');
  assert.ok(commands.includes(rmCommand(path.join('/home', 'sessions'), 'linux')), '清空会话 sessions');
  assert.ok(commands.includes(rmCommand(path.join('/home', '.credentials.yaml'), 'linux')), '清空凭据');
  const dangerousSteps = plan.steps.filter((s) => s.dangerous);
  assert.equal(dangerousSteps.length, plan.steps.length, '数据类所有步骤均 dangerous');
});

test('R-11 buildReinstallPlan：snapshots 目录绝不出现在任何命令里（恢复最后依靠）', async () => {
  const exec = async (): Promise<string> => '/fake/global';
  // 全选覆盖：program + cache + 全部数据类
  const all: ReinstallItemId[] = ['program', 'cache', 'settings', 'plugins', 'data'];
  const plan = await buildReinstallPlan(new Set(all), 'latest', exec, { DSH_HOME: '/home', PNPM_STORE_PATH: '/store' }, 'linux');
  assert.ok(plan.steps.length > 0, '全选应生成步骤');
  for (const step of plan.steps) {
    assert.ok(
      !step.command.includes('snapshots'),
      `不应删除/触碰快照目录 snapshots，got: ${step.command}`,
    );
  }
});

test('R-12 REINSTALL_ITEMS：类别定义齐全（defaultOn/destructive 语义）', () => {
  const byId = new Map(REINSTALL_ITEMS.map((it) => [it.id, it]));
  // program/cache 非破坏且默认勾选
  assert.equal(byId.get('program')!.destructive, false);
  assert.equal(byId.get('program')!.defaultOn, true);
  assert.equal(byId.get('cache')!.destructive, false);
  assert.equal(byId.get('cache')!.defaultOn, true);
  // 数据类破坏且默认不勾
  for (const id of ['settings', 'plugins', 'data'] as const) {
    assert.equal(byId.get(id)!.destructive, true, `${id} 应 destructive`);
    assert.equal(byId.get(id)!.defaultOn, false, `${id} 默认不勾`);
  }
});

/* ------------------------------------------------------------------ */
/* R-CLI 块：依赖 t3（src/cli/index.ts 接入 reinstall + 交互纯函数导出）。 */
/* 动态导入 + 能力探测：t3 未完成时自动跳过，不因缺导出而全红；t3 完成后      */
/* 本块自动激活。                                                        */
/* ------------------------------------------------------------------ */

type ParseResultLike = {
  ok: boolean;
  options?: { version?: string; yes?: boolean; list?: boolean; wipeConfig?: boolean };
  error?: string;
};

test('R-CLI reinstall 参数解析（parseCli）', async (t) => {
  const mod = await import('../../src/cli/index.ts') as unknown as Record<string, unknown>;
  const parseCli = mod.parseCli as ((argv: readonly string[]) => ParseResultLike) | undefined;
  if (typeof parseCli !== 'function') {
    t.skip('src/cli/index.ts 未导出 parseCli（待 t3）');
    return;
  }
  if (!parseCli(['reinstall']).ok) {
    t.skip(`reinstall 未接入 CLI（待 t3）：${parseCli(['reinstall']).error}`);
    return;
  }

  assert.equal(parseCli(['reinstall']).ok, true);

  const v = parseCli(['reinstall', '--version', '0.1.0-rc.6']);
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.options!.version, '0.1.0-rc.6');

  const y = parseCli(['reinstall', '--yes']);
  assert.equal(y.ok, true);
  if (y.ok) assert.equal(y.options!.yes, true);

  const l = parseCli(['reinstall', '--list']);
  assert.equal(l.ok, true);
  if (l.ok) assert.equal(l.options!.list, true);

  const w = parseCli(['reinstall', '--wipe-config']);
  assert.equal(w.ok, true);
  if (w.ok) assert.equal(w.options!.wipeConfig, true);

  // reinstall 专用参数不应出现在 restore 子命令
  assert.equal(parseCli(['restore', '--yes']).ok, false, 'restore 不支持 --yes');
  // --version 缺值报错
  assert.equal(parseCli(['reinstall', '--version']).ok, false, '--version 缺值报错');
  // --version 值不能以 - 开头
  assert.equal(parseCli(['reinstall', '--version', '--yes']).ok, false, '--version 值不能是另一标志');
});

test('R-CLI 交互纯函数（parseSelectionInput / parseConfirmInput）', async (t) => {
  const mod = await import('../../src/cli/index.ts') as unknown as Record<string, unknown>;
  const parseSel = mod.parseSelectionInput as ((input: string) => Set<string> | null) | undefined;
  const parseConf = mod.parseConfirmInput as ((input: string) => boolean) | undefined;
  if (typeof parseSel !== 'function' || typeof parseConf !== 'function') {
    t.skip('交互纯函数未导出（待 t3）');
    return;
  }

  // —— 多选解析：1-based 编号 → REINSTALL_ITEMS 的 id 集合 ——
  const set13 = parseSel('1,3');
  assert.ok(set13 !== null);
  assert.ok(set13!.has('program'), '编号 1 → program');
  assert.ok(set13!.has('settings'), '编号 3 → settings');
  assert.ok(parseSel('1,3')!.has('cache') === false, '未选编号不出现');

  // 空串/仅空白 → null（用默认）；非法编号 → null
  assert.equal(parseSel(''), null);
  assert.equal(parseSel('   '), null);
  assert.equal(parseSel('0'), null, '0 不在 1~5 → null');
  assert.equal(parseSel('9'), null, '超界 → null');
  assert.equal(parseSel('abc'), null, '非数字 → null');
  // 中文逗号 / 空格分隔均可
  assert.ok(parseSel('2，4')!.has('cache'), '中文逗号分隔');
  assert.ok(parseSel('1 4')!.has('data') === false);

  // —— 二次确认：仅 YES / Y（忽略大小写与空白）为真 ——
  assert.equal(parseConf('YES'), true);
  assert.equal(parseConf('yes'), true);
  assert.equal(parseConf('Y'), true);
  assert.equal(parseConf(' y '), true, '忽略空白');
  assert.equal(parseConf('no'), false);
  assert.equal(parseConf(''), false);
  assert.equal(parseConf('YESS'), false, '必须精确匹配');
});

test('R-CLI runCli reinstall --dry-run：只做计划，不执行步骤命令', async (t) => {
  const mod = await import('../../src/cli/index.ts') as unknown as Record<string, unknown>;
  const runCli = mod.runCli as (
    argv: readonly string[],
    io?: { log: (s: string) => void; error: (s: string) => void },
    env?: Record<string, string | undefined>,
    deps?: { exec?: (cmd: string) => Promise<string>; ask?: (p: string) => Promise<string>; platform?: string },
  ) => Promise<number> | undefined;
  if (typeof runCli !== 'function') {
    t.skip('runCli 未导出（待 t3）');
    return;
  }

  const calls: string[] = [];
  const fakeExec = async (cmd: string): Promise<string> => {
    calls.push(cmd);
    return '/fake/global';
  };
  const out: string[] = [];
  const io = { log: (s: string) => out.push(s), error: (s: string) => out.push(s) };

  // --yes 非交互 + --dry-run：只打印计划（含 5 类全选），不执行任何步骤命令
  const code = await runCli(['reinstall', '--yes', '--dry-run'], io, { DSH_HOME: '/home' }, { exec: fakeExec, platform: 'linux' });
  assert.equal(code, 0, 'dry-run 正常退出 0');
  assert.ok(out.join('\n').includes('重装计划'), '输出重装计划标题');
  const stepCmds = calls.filter((c) => c !== 'npm root -g');
  assert.deepEqual(stepCmds, [], `dry-run 除路径解析外不应执行任何步骤命令，got: ${JSON.stringify(stepCmds)}`);
});

test('R-CLI runCli reinstall --list：仅列清单，不执行任何命令、不询问', async (t) => {
  const mod = await import('../../src/cli/index.ts') as unknown as Record<string, unknown>;
  const runCli = mod.runCli as (
    argv: readonly string[],
    io?: { log: (s: string) => void; error: (s: string) => void },
    env?: Record<string, string | undefined>,
    deps?: { exec?: (cmd: string) => Promise<string>; ask?: (p: string) => Promise<string>; platform?: string },
  ) => Promise<number> | undefined;
  if (typeof runCli !== 'function') {
    t.skip('runCli 未导出（待 t3）');
    return;
  }

  let asked = 0;
  let executed = 0;
  const out: string[] = [];
  const io = { log: (s: string) => out.push(s), error: (s: string) => out.push(s) };
  const code = await runCli(
    ['reinstall', '--list'],
    io,
    { DSH_HOME: '/home' },
    {
      exec: async () => { executed += 1; return ''; },
      ask: async () => { asked += 1; return ''; },
      platform: 'linux',
    },
  );
  assert.equal(code, 0, '--list 正常退出 0');
  assert.ok(out.join('\n').includes('可选清理项'), '输出可选项清单');
  assert.equal(executed, 0, '--list 不执行任何外部命令');
  assert.equal(asked, 0, '--list 不进行交互询问');
});
