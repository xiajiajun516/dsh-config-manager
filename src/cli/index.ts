#!/usr/bin/env node
/**
 * dsh-config-manager CLI（M3，criterion m3-cli-works）：
 * 离线快照列表/恢复 + 一键重装 DSH 命令，零 DSH 运行时依赖（仅 node 内置 + 本项目
 * core 引擎；绝不 import @deepseek-ai/*，peerDependencies 缺失也能跑）。
 *
 * 子命令：
 *   snapshots [--data-dir <dir>]         列出快照（listSnapshots）
 *   restore [--id <uuid>] [--dry-run]    恢复到导入前状态（planRestore 预览 / restore 执行）
 *           [--data-dir <dir>] [--profile <name>] [--settings <path>]
 *   reinstall [--version <v>] [--yes] [--list] [--wipe-config] [--dry-run]
 *             一键重装 DSH 程序（交互多选 + 二次确认 / 跨平台执行）
 *   verify [--id <file|path>] [--json] [--data-dir <dir>]
 *             离线只读自检备份 ZIP（结构 + integrity/checksums 完整性；不改一个字节）
 *   backup [--sections <a,b,c>] [--out <path>] [--dry-run] [--data-dir <dir>]
 *             离线文件级备份（导出目录内生成与 GUI 同结构的 ZIP，落盘后自检）
 *   help | --help | -h                    显示全部命令与说明
 *
 * 缺省数据目录 = $DSH_HOME/dsh-config-manager/snapshots（$DSH_HOME 缺省 ~/.dsh）。
 */
import os from 'node:os';
import fssync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';

import {
  listSnapshots, planRestore, restore,
  type RestorePlan, type RestoreReport, type SnapshotMeta,
} from '../core/restore.ts';
import {
  REINSTALL_ITEMS, buildReinstallPlan, isWindows, detectInstalledDshVersion,
  writeReinstallRecoveryPoint,
  type ReinstallPlan, type ReinstallItemId, type ReinstallStep,
} from '../core/reinstall.ts';
import { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError } from '../utils/env-lock.ts';
import { Phase3Recovery } from '../core/phase3-host.ts';
import {
  verifyBackupZip, type BackupVerifyResult, type BackupVerifyVerdict,
} from '../core/backup-verify.ts';
import {
  collectBackupEntries, buildSectionFlags, parseSectionsArg,
  DEFAULT_BACKUP_SECTIONS, OFFLINE_UNAVAILABLE_SECTIONS,
  type BackupCollection,
} from '../core/backup-plan.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import { writeZip } from '../utils/zip.ts';
import type { Manifest, SectionId } from '../schema/types.ts';

/* ------------------------------------------------------------ 参数解析（纯函数） */

export type CliCommand =
  | 'snapshots' | 'restore' | 'reinstall' | 'recover-stale-lock'
  | 'verify' | 'backup' | 'help';

export interface CliOptions {
  command: CliCommand;
  /** --data-dir：快照数据目录覆盖 */
  dataDir?: string;
  /** --id：目标快照 id（restore 缺省取最近非 rolled-back） */
  id?: string;
  /** --dry-run：只打印计划（restore / reinstall） */
  dryRun: boolean;
  /** --profile：管理的 DSH profile（缺省 web） */
  profile: string;
  /** --settings：覆盖 settings 文件路径 */
  settings?: string;
  /** --version：reinstall 要安装的 DSH 版本（缺省 latest） */
  version?: string;
  /** --yes：reinstall 非交互（全选 + 跳过确认） */
  yes: boolean;
  /** --list：reinstall 列出可选清理项后退出 */
  list: boolean;
  /** --wipe-config：reinstall 等价勾选全部数据类（settings/plugins/data） */
  wipeConfig: boolean;
  /** --json：verify 输出机器可读结果（便于 CI / 定时任务断言） */
  json: boolean;
  /** --sections <a,b,c>：backup 要打包的离线分区白名单（缺省取默认分区） */
  sections?: string;
  /** --out <path>：backup 输出 ZIP 路径（缺省写入导出目录，自动去重不覆盖） */
  out?: string;
  /** verify 的位置参数（文件名或路径；与 --id 同义，最多一个） */
  positionals: string[];
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const VALUE_FLAGS = new Map<string, 'dataDir' | 'id' | 'profile' | 'settings' | 'sections' | 'out'>([
  ['--data-dir', 'dataDir'],
  ['--id', 'id'],
  ['--profile', 'profile'],
  ['--settings', 'settings'],
  ['--sections', 'sections'],
  ['--out', 'out'],
]);

/** 仅 verify 子命令允许的参数（--json 为布尔开关，不在 VALUE_FLAGS 内） */
const VERIFY_ONLY_FLAGS = new Set(['--json']);

/** 仅 backup 子命令允许的参数 */
const BACKUP_ONLY_FLAGS = new Set(['--sections', '--out']);

/** backup 明确不支持的 restore 系参数（--dry-run 对 backup 有效，故不在此表） */
const BACKUP_REJECTED_FLAGS = new Set(['--id', '--profile', '--settings']);

/** 仅 restore 子命令允许的参数 */
const RESTORE_ONLY_FLAGS = new Set(['--id', '--dry-run', '--profile', '--settings']);

/** 仅 reinstall 子命令允许的参数 */
const REINSTALL_ONLY_FLAGS = new Set(['--yes', '--list', '--wipe-config', '--version']);

/** recover-stale-lock 专用解析：只接受 --data-dir（用于定位 locks 目录），返回 dataDir 选项 */
function parseCliDataDir(argv: readonly string[]): ParseResult {
  const options: CliOptions = { command: 'recover-stale-lock', dryRun: false, profile: 'web', yes: false, list: false, wipeConfig: false, json: false, positionals: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { ok: false, error: '参数 --data-dir 缺少值 / missing value for --data-dir' };
      }
      options.dataDir = value;
      i += 1;
    } else if (flag.startsWith('--data-dir=')) {
      options.dataDir = flag.slice('--data-dir='.length);
      if (options.dataDir === '') return { ok: false, error: '参数 --data-dir 缺少值 / missing value for --data-dir' };
    } else {
      return { ok: false, error: `未知参数 / unknown flag: ${flag}` };
    }
  }
  return { ok: true, options };
}

/** 解析 CLI 参数（纯函数；help 返回 command:'help'，未知/缺值返回错误） */
export function parseCli(argv: readonly string[]): ParseResult {  const command = argv[0];
  if (command === undefined) return { ok: false, error: '缺少子命令 / missing subcommand' };
  if (command === '--help' || command === '-h' || command === 'help') {
    return { ok: true, options: { command: 'help', dryRun: false, profile: 'web', yes: false, list: false, wipeConfig: false, json: false, positionals: [] } };
  }
  if (command !== 'snapshots' && command !== 'restore' && command !== 'reinstall'
    && command !== 'recover-stale-lock' && command !== 'verify' && command !== 'backup') {
    return { ok: false, error: `未知子命令 / unknown subcommand: ${command}` };
  }
  if (command === 'recover-stale-lock') {
    // recover-stale-lock：独立显式 recovery，不接受 destructive 执行参数（只能 --data-dir 定位锁目录）
    for (const flag of argv.slice(1)) {
      if (flag !== '--data-dir' && !flag.startsWith('--data-dir=') && !flag.startsWith('-')) {
        return { ok: false, error: `recover-stale-lock 只接受 --data-dir / accepts only --data-dir` };
      }
    }
    return parseCliDataDir(argv);
  }

  const options: CliOptions = { command, dryRun: false, profile: 'web', yes: false, list: false, wipeConfig: false, json: false, positionals: [] };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    if (flag === '--help' || flag === '-h') {
      return { ok: true, options: { ...options, command: 'help' } };
    }
    // 位置参数：仅 verify 接受（文件名或路径），其余子命令沿用「未知参数」拒绝
    if (!flag.startsWith('-')) {
      if (command === 'verify') {
        if (options.positionals.length >= 1) {
          return { ok: false, error: 'verify 只接受一个目标 / verify accepts a single target' };
        }
        options.positionals.push(flag);
        continue;
      }
      return { ok: false, error: `未知参数 / unknown flag: ${flag}` };
    }
    if (command !== 'verify' && VERIFY_ONLY_FLAGS.has(flag)) {
      return { ok: false, error: `${command} 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (command !== 'backup' && BACKUP_ONLY_FLAGS.has(flag)) {
      return { ok: false, error: `${command} 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (command === 'backup' && BACKUP_REJECTED_FLAGS.has(flag)) {
      return { ok: false, error: `backup 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    if (command === 'snapshots' && RESTORE_ONLY_FLAGS.has(flag)) {
      return { ok: false, error: `snapshots 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (command !== 'reinstall' && REINSTALL_ONLY_FLAGS.has(flag)) {
      return { ok: false, error: `${command} 子命令不支持参数 / flag not allowed here: ${flag}` };
    }
    if (flag === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (flag === '--yes') {
      options.yes = true;
      continue;
    }
    if (flag === '--list') {
      options.list = true;
      continue;
    }
    if (flag === '--wipe-config') {
      options.wipeConfig = true;
      continue;
    }
    if (flag === '--version') {
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { ok: false, error: '参数 --version 缺少值 / missing value for --version' };
      }
      options.version = value;
      i += 1;
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
    if (key === 'sections') {
      // 分区名提前校验：未知/离线不可用的分区一律在这里拒绝（不留到收集阶段才报）
      const parsed = parseSectionsArg(value);
      if (!parsed.ok) return { ok: false, error: parsed.error };
    }
    options[key] = value;
    i += 1;
  }
  return { ok: true, options };
}

/** 解析 reinstall 交互多选输入：逗号/空格分隔的 1-based 编号；空串返回 null（用默认）。非法编号也返回 null。 */
export function parseSelectionInput(text: string): Set<ReinstallItemId> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parts = trimmed.split(/[,，\s]+/).filter((p) => p !== '');
  const indexes = parts.map((p) => Number(p));
  const valid = indexes.length > 0
    && indexes.every((n) => Number.isInteger(n) && n >= 1 && n <= REINSTALL_ITEMS.length);
  if (!valid) return null;
  const set = new Set<ReinstallItemId>();
  for (const n of indexes) set.add(REINSTALL_ITEMS[n - 1]!.id);
  return set;
}

/** 解析 reinstall 二次确认输入：仅 "YES" 或 "Y"（忽略大小写/空白）视为确认。 */
export function parseConfirmInput(text: string): boolean {
  const t = text.trim().toUpperCase();
  return t === 'YES' || t === 'Y';
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

/** Phase 3 SAFE MODE durable 标记路径：<dataDir>/transactions/safe-mode（dataDir = $DSH_HOME/dsh-config-manager）。 */
function safeModeMarkerPath(homeDir: string): string {
  return path.join(homeDir, 'dsh-config-manager', 'transactions', 'safe-mode');
}

/** 检查 Phase 3 SAFE MODE：存在未恢复 transaction → CLI destructive 应拒绝（返回错误文案，否则 null）。 */
export function checkSafeModeBlocked(homeDir: string): string | null {
  try {
    const p = safeModeMarkerPath(homeDir);
    if (fssync.existsSync(p)) {
      const text = fssync.readFileSync(p, 'utf8');
      if (/blocked|true/i.test(text)) {
        return '存在未恢复的配置 transaction（SAFE MODE 激活）。destructive 操作被阻断：请先用恢复流程处理（GUI 恢复 / 显式 recover）后再重试。';
      }
    }
    return null;
  } catch {
    return null; // 读不到标记不阻断（离线 CLI 保守放行读取类）
  }
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

/**
 * CLI 写进 manifest.exporter.version 的版本号。
 *
 * **运行时从 package.json 读取，不硬编码**：本仓库铁律是「版本必须同步多处」，
 * 再加一个常量就等于多一个会漂移的同步点（实测已发生：插件升到 0.1.59 后，
 * 这个常量仍停在 0.1.58，导致新产出的备份被标成旧版本）。
 * 只用 node 内置 `node:fs`，不引入 DSH 依赖，不破坏「CLI 零 @deepseek-ai 依赖」铁律。
 *
 * 路径解析：`src/cli/index.ts`（源码直跑）与 `lib/cli/index.js`（发布产物）都在包根下两级，
 * 因此 `../../package.json` 两种形态均正确。读取失败时回退为中性占位（绝不谎报具体版本）。
 */
function resolveCliVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const parsed = JSON.parse(fssync.readFileSync(pkgUrl, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version;
  } catch {
    // 包结构不可解析（被裁剪/单文件打包）：回退中性占位，不谎报版本
  }
  return '0.0.0-unknown';
}

/** 进程内缓存（每次 CLI 运行只读一次 package.json） */
const CLI_EXPORTER_VERSION = resolveCliVersion();

export function printUsage(io: CliIo = defaultIo): void {
  io.log(
    [
      'dsh-config-manager — DSH Config Manager CLI（离线救急 / snapshot restore + 一键重装）',
      '',
      '用法 / Usage:',
      '  dsh-config-manager snapshots [--data-dir <dir>]',
      '      列出快照 / list snapshots',
      '  dsh-config-manager restore [--id <uuid>] [--dry-run] [--data-dir <dir>]',
      '                            [--profile <name>] [--settings <path>]',
      '      恢复到导入前状态 / restore to pre-import state（--dry-run 只打印计划）',
      '  dsh-config-manager reinstall [--version <v>] [--yes] [--list] [--wipe-config] [--dry-run]',
      '      一键重装 DSH 程序（交互多选 + 二次确认），DSH 损坏时救急 / reinstall DSH',
      '  dsh-config-manager recover-stale-lock [--data-dir <dir>]',
      '      回收残留的环境锁（上次进程被强制结束留下的死锁）',
      '      / recover a stale environment lock left by a killed process',
      '      仅当持有者已确证死亡才回收；活锁一律拒绝。GUI 操作报「操作暂时无法执行」',
      '      且重试无效时使用（另有 GUI「事故恢复」入口）。',
      '      Refuses unless the owner is proven dead; never touches a live lock.',
      '  dsh-config-manager verify [--id <file|path>] [--json] [--data-dir <dir>]',
      '      离线只读自检备份 ZIP（结构 + integrity/checksums 完整性；不改一个字节）',
      '      / read-only integrity check of backup ZIPs（零写入）',
      '      无参校验导出目录下全部 *.zip；也可用位置参数指定单个文件或路径。',
      '      退出码：全部 OK → 0，任一非 OK → 1（便于 CI / 定时任务断言）。',
      '      Exit code: 0 only when every checked backup is OK.',
      '  dsh-config-manager backup [--sections <a,b,c>] [--out <path>] [--dry-run]',
      '                            [--data-dir <dir>]',
      '      离线文件级备份（导出目录内生成与 GUI 同结构的 ZIP，落盘后自动自检）',
      '      / offline file-level backup（dropped ZIP is self-verified）',
      '      只打包离线可直读的分区；凭据类文件（凭据文件名 / .env / *.pem）永不进入备份。',
      '  dsh-config-manager help',
      '      显示全部命令与说明 / show all commands',
      '',
      '选项 / Options:',
      '  --data-dir <dir>   快照数据目录（缺省 $DSH_HOME/dsh-config-manager/snapshots；',
      '                     recover-stale-lock 用它定位环境锁所在的数据目录）',
      '  --id <uuid>        目标快照 id（缺省取最近一个非 rolled-back 快照）',
      '  --dry-run          只打印计划，不执行 / print plan only',
      '  --profile <name>   管理的 DSH profile（缺省 web）',
      '  --settings <path>  覆盖 settings 文件路径',
      '  --version <v>      要安装的 DSH 版本（缺省 latest）',
      '  --yes              非交互：全选并跳过二次确认 / non-interactive',
      '  --list             只列出 reinstall 可选清理项 / list selectable items only',
      '  --wipe-config      一并勾选数据类（settings/plugins/data）/ also wipe ~/.dsh data',
      '  --json             verify 输出机器可读 JSON / machine-readable output',
      '  --sections <list>  backup 分区白名单（逗号分隔；缺省 ' + DEFAULT_BACKUP_SECTIONS.join(',') + '）',
      '  --out <path>       backup 输出 ZIP 路径（缺省自动命名，绝不覆盖既有文件）',
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

function printReinstallItems(io: CliIo): void {
  io.log('可选清理项 / selectable items（默认勾选项带 *，[危险] 需二次确认）:');
  const lines = REINSTALL_ITEMS.map((it, idx) => {
    const mark = it.defaultOn ? '*' : ' ';
    const risk = it.destructive ? ' [危险/destructive]' : '';
    return `  ${mark} ${idx + 1}. ${it.label} — ${it.desc}${risk}`;
  });
  io.log(lines.join('\n'));
}

function printReinstallPlan(plan: ReinstallPlan, io: CliIo): void {
  io.log(`重装计划 / reinstall plan — 版本 ${plan.version}`);
  if (plan.wipeConfig) {
    io.log('⚠ 该计划将清除 ~/.dsh 数据（settings/plugins/data），执行前会先备份到 .reinstall-backup / WARNING: will wipe ~/.dsh data');
  }
  io.log(`步骤 / steps（${plan.steps.length}）：`);
  for (const s of plan.steps) {
    const tag = s.dangerous ? '[D]' : '   ';
    io.log(`  ${tag} ${s.label}`);
    io.log(`      ${s.command}`);
  }
}

/* ------------------------------------------------------------ reinstall 交互与执行 */

export interface CliDeps {
  /** 交互提问（缺省用真实 stdin/stdout readline） */
  ask?: (prompt: string) => Promise<string>;
  /** 命令执行器（缺省跨平台：Windows powershell -Command / Unix bash -c） */
  exec?: (cmd: string) => Promise<string>;
  /** 平台（仅影响缺省 exec 的包装方式，缺省 process.platform） */
  platform?: NodeJS.Platform;
}

type Exec = (cmd: string) => Promise<string>;

/** 运行一条外部命令并返回 stdout（错误时 reject）。 */
function runExternal(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout));
    });
  });
}

/**
 * 缺省跨平台执行器：Windows 经 `powershell -NoProfile -Command <cmd>`，
 * Unix 经 `bash -c <cmd>` 整条命令串直接跑（步骤命令含 PowerShell 内建与 npm）。
 * 同样用于 buildReinstallPlan 内的 `npm root -g` 路径解析。
 */
function createDefaultExec(platform: NodeJS.Platform = process.platform): Exec {
  return async (cmd: string): Promise<string> => {
    if (isWindows(platform)) {
      return runExternal('powershell', ['-NoProfile', '-Command', cmd]);
    }
    return runExternal('bash', ['-c', cmd]);
  };
}

let defaultRl: ReturnType<typeof createInterface> | undefined;
/** 缺省交互提问（懒建真实 readline；注入 ask 时不会创建）。 */
async function defaultAsk(prompt: string): Promise<string> {
  if (defaultRl === undefined) {
    defaultRl = createInterface({ input: processStdin, output: processStdout });
  }
  return defaultRl.question(prompt);
}
function closeDefaultAsk(): void {
  if (defaultRl !== undefined) {
    defaultRl.close();
    defaultRl = undefined;
  }
}

/** 交互多选：打印编号清单，按 "1,3,5" 输入，空回车用默认。 */
async function interactiveReinstallSelect(
  defaults: Set<ReinstallItemId>,
  io: CliIo,
  ask: (prompt: string) => Promise<string>,
): Promise<Set<ReinstallItemId>> {
  io.log('可选清理项 / selectable items（默认勾选项带 *，[危险] 需二次确认）:');
  const lines = REINSTALL_ITEMS.map((it, idx) => {
    const mark = defaults.has(it.id) ? '*' : ' ';
    const risk = it.destructive ? ' [危险/destructive]' : '';
    return `  ${mark} ${idx + 1}. ${it.label} — ${it.desc}${risk}`;
  });
  io.log(lines.join('\n'));
  io.log('输入数字多选（逗号/空格分隔，如 1,3,5），空回车用默认 / enter numbers, empty for default');
  for (;;) {
    const line = (await ask('选择 / select> ')).trim();
    if (line === '') return defaults;
    const parsed = parseSelectionInput(line);
    if (parsed === null) {
      io.log('输入无效，请重新输入（1~5，空回车用默认）/ invalid input, try again');
      continue;
    }
    return parsed;
  }
}

async function runReinstall(
  options: CliOptions,
  io: CliIo,
  env: Record<string, string | undefined>,
  deps: CliDeps,
): Promise<number> {
  const ask = deps.ask ?? defaultAsk;
  const exec: Exec = deps.exec ?? createDefaultExec(deps.platform);
  try {
    if (options.list) {
      printReinstallItems(io);
      return 0;
    }

    let selection: Set<ReinstallItemId>;
    if (options.yes) {
      // 非交互：全选 + 跳过二次确认
      selection = new Set(REINSTALL_ITEMS.map((it) => it.id));
    } else {
      const defaults: Set<ReinstallItemId> = new Set(
        REINSTALL_ITEMS.filter((it) => it.defaultOn).map((it) => it.id),
      );
      if (options.wipeConfig) {
        defaults.add('settings');
        defaults.add('plugins');
        defaults.add('data');
      }
      selection = await interactiveReinstallSelect(defaults, io, ask);
      const hasDestructive = [...selection].some((id) =>
        REINSTALL_ITEMS.find((it) => it.id === id)?.destructive === true,
      );
      if (hasDestructive || options.wipeConfig) {
        io.log('⚠ 所选动作包含清除 ~/.dsh 数据的危险步骤（执行前会先做 .reinstall-backup 备份）。/ WARNING: destructive ~/.dsh actions selected');
        if (!parseConfirmInput(await ask('输入 YES 确认继续 / type YES to continue> '))) {
          io.log('已取消 / cancelled');
          return 1;
        }
      }
    }

    const plan = await buildReinstallPlan(selection, options.version ?? 'latest', exec, env);

    if (options.dryRun) {
      printReinstallPlan(plan, io);
      return 0;
    }

    // Phase 3 SAFE MODE：存在未恢复 transaction → 拒绝 destructive（CLI 不旁路 SAFE MODE）。
    const safeMsg = checkSafeModeBlocked(resolveDshHome(env));
    if (safeMsg !== null) {
      io.error(`拒绝执行：${safeMsg}`);
      return 1;
    }

    // 执行（Phase 2 锁：reinstall 卸载/清扫/重装属 GLOBAL destructive，必须成功获取环境锁）
    const lockHome = resolveDshHome(env);
    const lock = new EnvironmentLockManager({
      locksDir: path.join(lockHome, 'dsh-config-manager', 'locks'),
      op: 'cli-reinstall',
      target: plan.version,
      lockVersion: '0.1.0',
    });
    const failed: Array<{ label: string; command: string; reason: string }> = [];
    // Phase 3 P0-A：CLI reinstall 也建 intent journal（外部副作用不可证明 → crash 后 NEEDS_ATTENTION）。
    const cliDataDir = path.join(lockHome, 'dsh-config-manager');
    const recovery = new Phase3Recovery({ dataDir: cliDataDir, packageVersion: '0.1.0', fingerprintDataDir: cliDataDir });
    await recovery.initFingerprint().catch(() => undefined);
    try {
      await runWithMutationLock(lock, { op: 'cli-reinstall', target: plan.version }, async (lockCtx) => {
        const runReinstall = async (journalCtx?: { operationId?: string }): Promise<void> => {
          io.log(`开始重装 / reinstall started — 版本 ${plan.version}`);
          // Phase 4 F29/F30：在首个 destructive side effect（npm uninstall -g）前，写 durable
          // operation-bound recovery point。若涉及 program 步但无法探测旧版本 → fail-closed，不继续 uninstall。
          if (selection.has('program')) {
            const prev = await detectInstalledDshVersion(exec);
            if (prev === null) {
              const message = '无法探测当前已安装 DSH 版本，拒绝执行 program 步（fail-closed）：先手动确认 dsh --version 可用';
              failed.push({ label: 'program recovery point', command: 'detectInstalledDshVersion', reason: message });
              io.error(`✘ ${message}`);
              // 不执行任何步骤（避免在无 recovery point 下 uninstall）
              return;
            }
            try {
              const opId = journalCtx?.operationId ?? 'cli-reinstall';
              await writeReinstallRecoveryPoint(cliDataDir, {
                operationId: opId,
                environmentFingerprint: recovery.recoveryEnvFingerprint,
                previousInstalledVersion: prev,
                requestedTargetSpec: plan.version,
                createdAt: new Date().toISOString(),
                recoveryHint: `如需手动恢复此版本：npm install -g @deepseek-ai/dsh@${prev}`,
              });
            } catch (rpErr) {
              const message = `recovery point 写入失败，拒绝执行 program 步（fail-closed）：${rpErr instanceof Error ? rpErr.message : String(rpErr)}`;
              failed.push({ label: 'program recovery point', command: 'writeReinstallRecoveryPoint', reason: message });
              io.error(`✘ ${message}`);
              return;
            }
          }
          for (const step of plan.steps) {
            if (step.dangerous) {
              io.log(`⚠ 危险步骤 / dangerous step: ${step.label}`);
            }
            try {
              await exec(step.command);
              io.log(`✔ ${step.label}`);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              failed.push({ label: step.label, command: step.command, reason });
              io.error(`✘ ${step.label} — ${reason}`);
            }
          }
        };
        if (lockCtx !== null) {
          await recovery.runExternalIntent({ operationType: 'cli-reinstall', lockCtx, intent: { adapter: 'dsh', ref: 'program', kind: 'Reinstall' }, fn: runReinstall });
        } else {
          await runReinstall();
        }
      });
    } catch (err) {
      if (err instanceof EnvironmentLockUnavailableError) {
        io.error(`拒绝执行：${err.message}`)
        return 1;
      }
      throw err;
    }
    io.log(failed.length === 0 ? '重装完成 / reinstall done' : `重装完成但有 ${failed.length} 步失败 / done with ${failed.length} failed step(s)`);
    for (const f of failed) {
      io.error(`  - ${f.label}（${f.command}）: ${f.reason}`);
    }
    return failed.length > 0 ? 1 : 0;
  } finally {
    closeDefaultAsk();
  }
}

/* ------------------------------------------------------------ 执行 */

/**
 * CLI 主流程（io/env/deps 可注入供测试）：
 * snapshots → 列表；restore → dry-run 打印计划 / 执行并打印诚实报告；
 * reinstall → 交互多选 + 二次确认 + 跨平台执行。失败项存在时 exit 1，否则 0。
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
  env: Record<string, string | undefined> = process.env,
  deps: CliDeps = {},
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
  if (options.command === 'reinstall') {
    return runReinstall(options, io, env, deps);
  }
  // verify / backup 全程只读或只写导出目录：不碰 $DSH_HOME 配置、不需要环境锁
  if (options.command === 'verify') {
    return runVerify(options, io, env);
  }
  if (options.command === 'backup') {
    return runBackup(options, io, env);
  }

  const lockDataDir = resolveDataDir(options.dataDir, env);
  const lockHome = resolveDshHome(env);

  // recover-stale-lock：独立显式 recovery（只 inspect + prove stale + 原子回收；不自动、无 --force）。
  if (options.command === 'recover-stale-lock') {
    const lock = new EnvironmentLockManager({
      locksDir: path.join(lockHome, 'dsh-config-manager', 'locks'),
      op: 'recover-stale-lock',
      target: lockDataDir,
      lockVersion: '0.1.0',
    });
    const insp = await lock.inspectLockState();
    if (insp.state !== 'STALE_LOCK_DETECTED' && !(insp.state === 'UNKNOWN_STATE' && insp.detail?.includes('无有效 owner'))) {
      // 非 stale 或无法证明 → 拒绝 recovery（owner healthy 的活锁绝不删）
      io.error(`环境锁未判定为 stale（state=${insp.state}），拒绝 recovery。不会触碰活锁。/ lock not stale, recovery refused`);
      return 1;
    }
    const result = await lock.recoverStaleLock();
    if (result.ok && result.removed) {
      io.log(`已回收 stale 环境锁 / stale lock recovered: ${result.detail ?? ''}`);
      return 0;
    }
    io.error(`recovery 失败：${result.detail ?? '未知原因'}（可能二次验证失败，已保留 quarantine 文件供诊断）`);
    return 1;
  }

  const dataDir = lockDataDir;

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
    // Phase 4 统一恢复校验（与 Host/ModelTools 同强度：存在/READY/manifest/blob-hash/symlink/provenance）
    snapshotsRoot: dataDir,
  };
  if (options.dryRun) {
    printPlan(await planRestore(restoreOptions), io);
    return 0;
  }
  // Phase 3 SAFE MODE：存在未恢复 transaction → 拒绝 destructive（CLI 不旁路 SAFE MODE）。
  const safeMsg2 = checkSafeModeBlocked(resolveDshHome(env));
  if (safeMsg2 !== null) {
    io.error(`拒绝执行：${safeMsg2}`);
    return 1;
  }
  // Phase 2 锁：真实 restore 是 destructive（覆盖/删除 $DSH_HOME + 卸载插件），必须成功获取
  // GLOBAL 环境锁；被另一 DSH 任务持有 → 明确报错退出（无 --force 旁路）。无锁目录 → 用默认 dataDir。
  const lock = new EnvironmentLockManager({
    locksDir: path.join(dataDir, '..', 'locks'),
    op: 'cli-restore',
    target: id,
    lockVersion: '0.1.0',
  });
  try {
    // Phase 3 P0-A：CLI restore 也创建 durable journal（关闭 bypass）。
    const recovery = new Phase3Recovery({ dataDir: path.dirname(dataDir), packageVersion: '0.1.0', fingerprintDataDir: path.dirname(dataDir) });
    await recovery.initFingerprint().catch(() => undefined);
    const report = await runWithMutationLock(lock, { op: 'cli-restore', target: id }, async (lockCtx) => {
      if (lockCtx !== null) {
        return (await recovery.runJournaled({ operationType: 'cli-restore', lockCtx, fn: () => restore(restoreOptions) })).result;
      }
      return restore(restoreOptions);
    });
    printReport(report, io);
    return report.failed.length > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof EnvironmentLockUnavailableError) {
      io.error(`拒绝执行：${err.message}`)
      return 1;
    }
    throw err;
  }
}

/* ------------------------------------------------------------ verify：备份只读自检 */

/** verdict → 行首标记（人读摘要用；OK 才不显眼） */
function verdictTag(v: BackupVerifyVerdict): string {
  switch (v) {
    case 'OK': return '[OK]';
    case 'MISSING': return '[MISSING]';
    case 'CORRUPT': return '[CORRUPT]';
    case 'UNSUPPORTED': return '[UNSUPPORTED]';
    case 'VERIFY_ERROR': return '[VERIFY_ERROR]';
  }
}

/** 导出目录：--data-dir 覆盖优先，缺省 $DSH_HOME/dsh-config-manager/exports */
export function resolveExportsDir(flag: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (flag !== undefined && flag !== '') return flag;
  return path.join(resolveDshHome(env), 'dsh-config-manager', 'exports');
}

/** 定位待校验目标：显式目标（文件名或路径）优先，否则列出导出目录下全部 *.zip（名称升序） */
async function resolveVerifyTargets(
  dataDir: string,
  explicit: string | undefined,
): Promise<{ ok: true; targets: string[] } | { ok: false; error: string }> {
  if (explicit !== undefined && explicit !== '') {
    // 文件名：在导出目录内解析；路径：按原样使用（相对当前工作目录）
    const looksLikePath = explicit.includes('/') || explicit.includes('\\') || path.isAbsolute(explicit);
    const target = looksLikePath ? path.resolve(explicit) : path.join(dataDir, explicit);
    return { ok: true, targets: [target] };
  }
  let names: string[];
  try {
    names = (await fsp.readdir(dataDir)).filter((n) => n.endsWith('.zip')).sort();
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { ok: false, error: `导出目录不存在 / export directory not found: ${dataDir}` };
    }
    return { ok: false, error: `读取导出目录失败 / failed to read export directory: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (names.length === 0) {
    return { ok: false, error: `导出目录内没有备份 ZIP / no backup ZIP in: ${dataDir}` };
  }
  return { ok: true, targets: names.map((n) => path.join(dataDir, n)) };
}

/** 打印单个校验结果（文件级一行摘要 + 详情缩进） */
function printVerifyResult(r: BackupVerifyResult, io: CliIo): void {
  const size = r.sizeBytes !== undefined ? ` ${r.sizeBytes}B` : '';
  const entries = r.entryCount !== undefined ? ` ${r.entryCount} entries` : '';
  io.log(`${verdictTag(r.verdict)} ${path.basename(r.file)}${size}${entries}`);
  for (const e of r.errors) io.log(`    ! ${e}`);
  for (const w of r.warnings) io.log(`    - ${w}`);
}

async function runVerify(
  options: CliOptions,
  io: CliIo,
  env: Record<string, string | undefined>,
): Promise<number> {
  const dataDir = resolveExportsDir(options.dataDir, env);
  const explicit = options.id ?? options.positionals[0];
  const resolved = await resolveVerifyTargets(dataDir, explicit);
  if (!resolved.ok) {
    // --json：错误也走 JSON（否则 CI 会拿到空 stdout 导致 jq 解析失败）
    if (options.json) io.log(stringifyJsonSafe({ error: resolved.error }, { space: 2 }));
    else io.error(resolved.error);
    return 1;
  }
  const results: BackupVerifyResult[] = [];
  for (const target of resolved.targets) results.push(await verifyBackupZip(target));

  if (options.json) {
    // 机器可读：单目标 → 对象；多目标 → 数组（便于 CI 用 jq 直接取 verdict）
    const payload = results.length === 1 ? results[0]! : results;
    io.log(stringifyJsonSafe(payload, { space: 2 }));
  } else {
    for (const r of results) printVerifyResult(r, io);
  }

  const failed = results.filter((r) => r.verdict !== 'OK');
  if (!options.json) {
    const counts = new Map<BackupVerifyVerdict, number>();
    for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
    const parts = [...counts.entries()].map(([v, n]) => `${v} ${n}`);
    io.log(`汇总 / summary: ${results.length} 个备份 checked — ${parts.join(' · ')}`);
  }
  if (failed.length > 0) {
    if (!options.json) io.error(`${failed.length} 个备份未通过自检 / ${failed.length} backup(s) failed verification`);
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------ backup：离线文件级备份 */

/** 打印待打包清单（--dry-run 与真实执行前的预览共用） */
function printBackupPlan(col: BackupCollection, outPath: string, io: CliIo): void {
  io.log(`备份计划 / backup plan（${col.entries.length} 个文件 → ${outPath}）`);
  for (const s of col.sections) {
    io.log(`  ${s.label}（${s.sectionId}）: ${s.entryCount} 个文件${s.excludedCount > 0 ? `，已排除 ${s.excludedCount}` : ''}`);
    if (s.risk !== undefined) io.log(`      ⚠ ${s.risk}`);
  }
  for (const id of OFFLINE_UNAVAILABLE_SECTIONS) {
    io.log(`  （离线不可收集 / not offline-collectable）${id}`);
  }
  io.log('凭据类文件（.credentials.* / .env / *.pem 等）已显式排除，绝不进入备份。');
}

async function runBackup(
  options: CliOptions,
  io: CliIo,
  env: Record<string, string | undefined>,
): Promise<number> {
  const homeDir = resolveDshHome(env);
  const exportsDir = resolveExportsDir(options.dataDir, env);

  let only: SectionId[] = [];
  if (options.sections !== undefined && options.sections !== '') {
    const parsed = parseSectionsArg(options.sections);
    if (!parsed.ok) {
      io.error(parsed.error);
      return 1;
    }
    only = parsed.sections;
  }

  const collection = await collectBackupEntries(homeDir, only);
  if (collection.entries.length === 0) {
    io.error(`没有可打包的内容 / nothing to back up（${homeDir} 下未找到可离线收集的分区）`);
    return 1;
  }

  // 输出路径：--out 优先；否则导出目录内按时间自动命名，且绝不覆盖既有文件
  let outPath: string;
  if (options.out !== undefined && options.out !== '') {
    outPath = path.resolve(options.out);
    if (await pathExists(outPath)) {
      const base = outPath.endsWith('.zip') ? outPath.slice(0, -4) : outPath;
      let candidate = `${base}-1.zip`;
      for (let i = 2; await pathExists(candidate); i += 1) candidate = `${base}-${i}.zip`;
      outPath = candidate;
    }
  } else {
    // 注意：此处刻意不 mkdir —— dry-run 必须零写入，目录在真正落盘前才创建
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
      + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    try {
      const rand = await randomHex4();
      outPath = await resolveNonCollidingName(exportsDir, `dsh-config-cli-${stamp}-${rand}.zip`);
    } catch (err) {
      io.error(`生成输出路径失败 / failed to build output path: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (options.dryRun) {
    printBackupPlan(collection, outPath, io);
    return 0;
  }

  // 组装 ZIP（manifest / checksums 复用 GUI 导出的同一构造方式）
  const sectionFlags = buildSectionFlags(collection.included);
  const checksums = buildChecksums(collection.entries);
  const manifest = buildManifest({
    exporterVersion: CLI_EXPORTER_VERSION,
    // 离线 CLI 探测不到真实 DSH 版本：如实标注（不谎报成某个版本号）
    dshVersion: 'cli-offline',
    platform: process.platform as Manifest['source']['platform'],
    arch: process.arch,
    sections: sectionFlags,
    containsSecrets: false, // 凭据文件已被显式排除，恒为 false
    encrypted: false,
    encryption: null,
  });
  const entries = [
    ...collection.entries,
    { name: CHECKSUMS_FILE, data: new TextEncoder().encode(stringifyJsonSafe(checksums, { space: 2 })) },
    { name: MANIFEST_FILE, data: new TextEncoder().encode(stringifyJsonSafe(manifest, { space: 2 })) },
  ];
  try {
    // 真正落盘前才创建导出目录（dry-run 已在上面提前返回，不产生任何写入）
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await writeZip(outPath, entries);
  } catch (err) {
    io.error(`写入备份失败 / failed to write backup: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  printBackupPlan(collection, outPath, io);
  io.log(`备份已创建 / backup created: ${outPath}`);
  for (const w of collection.warnings) io.error(`  - ${w}`);

  // 落盘后立即自检（与 verify 同一引擎）：只有自检通过才返回 0
  const check = await verifyBackupZip(outPath);
  printVerifyResult(check, io);
  if (check.verdict !== 'OK') {
    io.error('备份自检未通过（文件已保留，请复核）/ self-verification failed（file kept for inspection）');
    return 1;
  }
  io.log('自检通过 / self-verification OK');
  return 0;
}

/** 文件是否存在 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 4 字节随机十六进制（与宿主导出命名风格一致，避免引入额外依赖） */
async function randomHex4(): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  return randomBytes(4).toString('hex');
}

/** 导出目录内取不冲突的文件名（复用既有去重语义：foo.zip → foo-1.zip） */
async function resolveNonCollidingName(dir: string, desired: string): Promise<string> {
  let existing: string[] = [];
  try {
    existing = await fsp.readdir(dir);
  } catch {
    existing = [];
  }
  if (!existing.includes(desired)) return path.join(dir, desired);
  const base = desired.endsWith('.zip') ? desired.slice(0, -4) : desired;
  for (let i = 1; ; i += 1) {
    const candidate = `${base}-${i}.zip`;
    if (!existing.includes(candidate)) return path.join(dir, candidate);
  }
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
