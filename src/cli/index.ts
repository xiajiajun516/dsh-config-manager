#!/usr/bin/env node
/**
 * dsh-config-manager CLI（M3，criterion m3-cli-works）：
 * 离线快照列表与恢复命令，零 DSH 运行时依赖（仅 node 内置 + 本项目 core 引擎，
 * 引擎本身也只依赖 node 内置；绝不 import @deepseek-ai/*，peerDependencies 缺失也能跑）。
 *
 * 子命令：
 *   snapshots [--data-dir <dir>]         列出快照（listSnapshots）
 *   restore [--id <uuid>] [--dry-run]    恢复到导入前状态（planRestore 预览 / restore 执行）
 *           [--data-dir <dir>] [--profile <name>] [--settings <path>]
 *   --help | -h                           显示用法
 *
 * 缺省数据目录 = $DSH_HOME/dsh-config-manager/snapshots（$DSH_HOME 缺省 ~/.dsh）。
 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  listSnapshots, planRestore, restore,
  type RestorePlan, type RestoreReport, type SnapshotMeta,
} from '../core/restore.ts';

/* ------------------------------------------------------------ 参数解析（纯函数） */

export type CliCommand = 'snapshots' | 'restore' | 'help';

export interface CliOptions {
  command: CliCommand;
  /** --data-dir：快照数据目录覆盖 */
  dataDir?: string;
  /** --id：目标快照 id（restore 缺省取最近非 rolled-back） */
  id?: string;
  /** --dry-run：只打印计划 */
  dryRun: boolean;
  /** --profile：管理的 DSH profile（缺省 web） */
  profile: string;
  /** --settings：覆盖 settings 文件路径 */
  settings?: string;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const VALUE_FLAGS = new Map<string, 'dataDir' | 'id' | 'profile' | 'settings'>([
  ['--data-dir', 'dataDir'],
  ['--id', 'id'],
  ['--profile', 'profile'],
  ['--settings', 'settings'],
]);

/** 仅 restore 子命令允许的参数 */
const RESTORE_ONLY_FLAGS = new Set(['--id', '--dry-run', '--profile', '--settings']);

/** 解析 CLI 参数（纯函数；help 返回 command:'help'，未知/缺值返回错误） */
export function parseCli(argv: readonly string[]): ParseResult {
  const command = argv[0];
  if (command === undefined) return { ok: false, error: '缺少子命令 / missing subcommand' };
  if (command === '--help' || command === '-h' || command === 'help') {
    return { ok: true, options: { command: 'help', dryRun: false, profile: 'web' } };
  }
  if (command !== 'snapshots' && command !== 'restore') {
    return { ok: false, error: `未知子命令 / unknown subcommand: ${command}` };
  }

  const options: CliOptions = { command, dryRun: false, profile: 'web' };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    if (flag === '--help' || flag === '-h') {
      return { ok: true, options: { ...options, command: 'help' } };
    }
    if (command === 'snapshots' && RESTORE_ONLY_FLAGS.has(flag)) {
      return { ok: false, error: `snapshots 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const key = VALUE_FLAGS.get(flag);
    if (key === undefined) {
      return { ok: false, error: `未知参数 / unknown flag: ${flag}` };
    }
    const value = rest[i + 1];
    if (value === undefined || value === '' || value.startsWith('-')) {
      return { ok: false, error: `参数 ${flag} 缺少值 / missing value for ${flag}` };
    }
    options[key] = value;
    i += 1;
  }
  return { ok: true, options };
}

/** $DSH_HOME：环境变量优先，缺省 ~/.dsh（dsh-home-paths 的简化规则，CLI 零依赖版） */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** 快照数据目录：--data-dir 覆盖优先，缺省 $DSH_HOME/dsh-config-manager/snapshots */
export function resolveDataDir(flag: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (flag !== undefined && flag !== '') return flag;
  return path.join(resolveDshHome(env), 'dsh-config-manager', 'snapshots');
}

/** 快照 id 校验：拒绝路径分隔符/保留名（防 join 越界） */
export function validateSnapshotId(id: string): string {
  if (id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new Error(`非法快照 id / invalid snapshot id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** 缺省快照选择：metas 已按 createdAt 倒序，取第一个 status !== 'rolled-back' */
export function pickDefaultSnapshotId(metas: readonly SnapshotMeta[]): string | null {
  const eligible = metas.find((m) => m.status !== 'rolled-back');
  return eligible?.id ?? null;
}

/* ------------------------------------------------------------ 输出 */

export interface CliIo {
  log: (s: string) => void;
  error: (s: string) => void;
}

const defaultIo: CliIo = { log: (s) => console.log(s), error: (s) => console.error(s) };

/* ------------------------------------------------------------ 执行 */

export function printUsage(io: CliIo = defaultIo): void {
  io.log(
    [
      'dsh-config-manager — DSH Config Manager 离线恢复工具 / offline restore tool',
      '',
      '用法 / Usage:',
      '  dsh-config-manager snapshots [--data-dir <dir>]',
      '      列出快照 / list snapshots',
      '  dsh-config-manager restore [--id <uuid>] [--dry-run] [--data-dir <dir>]',
      '                            [--profile <name>] [--settings <path>]',
      '      恢复到导入前状态 / restore to pre-import state（--dry-run 只打印计划）',
      '  dsh-config-manager --help | -h',
      '      显示帮助 / show help',
      '',
      '选项 / Options:',
      '  --data-dir <dir>   快照数据目录（缺省 $DSH_HOME/dsh-config-manager/snapshots）',
      '  --id <uuid>        目标快照 id（缺省取最近一个非 rolled-back 快照）',
      '  --dry-run          只打印恢复计划，不执行 / print plan only',
      '  --profile <name>   管理的 DSH profile（缺省 web）',
      '  --settings <path>  覆盖 settings 文件路径',
    ].join('\n'),
  );
}

function printSnapshots(metas: SnapshotMeta[], io: CliIo): void {
  if (metas.length === 0) {
    io.log('（无快照 / no snapshots）');
    return;
  }
  const headers = ['ID', 'CREATED_AT', 'SOURCE_ZIP', 'STATUS', 'ENTRIES', 'HOST_FILES', 'PLUGINS'];
  const rows = metas.map((m) => [
    m.id, m.createdAt, m.sourceZip, m.status ?? 'unknown',
    String(m.entryCount), String(m.hostFileBackupCount), String(m.beforePluginCount),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  io.log(line(headers));
  for (const r of rows) io.log(line(r));
}

function printPlan(plan: RestorePlan, io: CliIo): void {
  io.log(`快照 / snapshot: ${plan.snapshotId}`);
  io.log(`创建时间 / createdAt: ${plan.createdAt}`);
  io.log(`来源备份 / sourceZip: ${plan.sourceZip}`);
  io.log(`插件基线 / plugin baseline: ${plan.pluginBaselineConfirmed ? '已确认 / confirmed' : '缺失 / missing（不计划插件卸载）'}`);
  io.log(`动作计划 / plan（${plan.actions.length} 项 actions）：`);
  for (const a of plan.actions) {
    const detail = a.detail !== undefined ? `（${a.detail}）` : '';
    io.log(`  [${a.kind.padEnd(14)}] ${a.description}${detail}`);
  }
  const s = plan.summary;
  io.log(
    `汇总 / summary: 整文件还原 ${s.hostFileRestores} · 整文件删除 ${s.hostFileRemoves}`
    + ` · 插件卸载 ${s.pluginRemoves} · 文件还原 ${s.fileRestores} · 文件删除 ${s.fileRemoves}`
    + ` · 凭据提示 ${s.credentialHints} · 跳过 ${s.skips}`,
  );
}

function printReport(report: RestoreReport, io: CliIo): void {
  io.log(`恢复完成 / restore done — 快照 ${report.snapshotId}`);
  io.log(`已还原 / restored（${report.restored.length}）：`);
  for (const r of report.restored) io.log(`  - ${r}`);
  io.log(`已卸载插件 / removed plugins（${report.removedPlugins.length}）：`);
  for (const p of report.removedPlugins) io.log(`  - ${p}`);
  io.log(`需人工处理 / manual hints（${report.manualHints.length}）：`);
  for (const h of report.manualHints) io.log(`  - ${h}`);
  io.log(`失败 / failed（${report.failed.length}）：`);
  for (const f of report.failed) io.log(`  - ${f.item}: ${f.reason}`);
  io.log(`跳过 / skipped（${report.skipped.length}）：`);
  for (const sk of report.skipped) io.log(`  - ${sk}`);
}

/**
 * CLI 主流程（io/env 可注入供测试）：
 * snapshots → 列表；restore → dry-run 打印计划 / 执行并打印诚实报告；
 * 失败项存在时 exit 1，否则 0。
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    io.error(parsed.error);
    printUsage(io);
    return 1;
  }
  const { options } = parsed;
  if (options.command === 'help') {
    printUsage(io);
    return 0;
  }

  const dataDir = resolveDataDir(options.dataDir, env);

  if (options.command === 'snapshots') {
    const metas = await listSnapshots(dataDir);
    printSnapshots(metas, io);
    return 0;
  }

  // restore
  let id = options.id;
  if (id === undefined) {
    const picked = pickDefaultSnapshotId(await listSnapshots(dataDir));
    if (picked === null) {
      io.error('没有可用快照（无快照或全部已回滚）/ no usable snapshot (none or all rolled-back)');
      return 1;
    }
    id = picked;
  }
  try {
    validateSnapshotId(id);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const snapshotDir = path.join(dataDir, id);
  const restoreOptions = {
    snapshotDir,
    homeDir: resolveDshHome(env),
    profile: options.profile,
    settingsPath: options.settings,
  };
  if (options.dryRun) {
    printPlan(await planRestore(restoreOptions), io);
    return 0;
  }
  const report = await restore(restoreOptions);
  printReport(report, io);
  return report.failed.length > 0 ? 1 : 0;
}

/* 直接运行（bin / node src/cli/index.ts）时进入主流程；被 import（测试）时不自动执行 */
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(`dsh-config-manager 执行失败 / failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
