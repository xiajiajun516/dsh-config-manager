/**
 * `dcm import --from <来源> [--dry-run]` —— 把**本机已装的外部 agent 配置**翻译成标准 bundle v1 ZIP。
 *
 * 为什么是「翻译成标准 bundle」而不是自己写导入：读侧只需要实现一次（Importer/analyzer）——
 * 校验和、schema 版本协商、Zip Slip 拒绝、冲突判定、导入前强制快照、dry-run 全部自动生效，
 * 不为外部来源另开一条写入通道（见 src/foreign/bundle.ts 的文件头）。
 *
 * 四条纪律：
 *  ① **--dry-run 零写入**：只跑检测 + 构建并打印分区摘要，连导出目录都不 mkdir；
 *  ② **绝不覆盖既有文件**：--out 命中已有文件时自动加 -1/-2 后缀（与 backup 同语义）；
 *     一个分区都产不出来时退出码 1（空的 bundle 会「自检通过」却什么都没有，绝不静默成功）；
 *  ③ **凭据值绝不出现**：摘要只打印 skipped 机器码与**凭据引用名**（形如 mcp:svc:GITHUB_TOKEN）；
 *  ④ **未知来源不猜**：打印可用来源清单并退出码 1（绝不回退到某个默认来源）。
 *
 * 本模块不 import ./index.ts（避免运行时循环）：所有需要由 CLI 解析的东西
 * （导出目录、版本号、--data-dir 语义）都由调用方作为参数传入。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { verifyBackupZip } from '../core/backup-verify.ts';
import { writeForeignBundle } from '../foreign/bundle.ts';
import {
  FOREIGN_CONFLICT_POLICY,
  ForeignSourceError,
  createBuiltinForeignSourceRegistry,
} from '../foreign/registry.ts';
import { foreignSourceContext } from '../routes/foreign-context.ts';
import type { ForeignSourceContext, ForeignSourceDetection } from '../foreign/registry.ts';
import type { ForeignImportResult } from '../foreign/types.ts';
import type { Platform } from '../schema/types.ts';
import { formatDateStamp } from '../utils/time.ts';

/** CLI 侧只依赖这个最小 IO 形状（与 src/cli/index.ts 的 CliIo 结构等价，避免循环 import） */
export interface ImportIo {
  log: (s: string) => void;
  error: (s: string) => void;
}

export interface ImportSourceOptions {
  /** 外部来源 id（六个之一；未知 → 打印可用清单并退出 1） */
  from: string;
  /** 只打印计划，零写入 */
  dryRun: boolean;
  /** 输出 ZIP 路径（缺省写入 exportsDir 下自动命名，且绝不覆盖既有文件） */
  out?: string;
  /** 项目目录（契约 §8.2 的项目级路径；缺省 = 进程 cwd） */
  cwd?: string;
  /** 缺省导出目录（由 CLI 的 resolveExportsDir 解析后传入，本模块不做 --data-dir 语义） */
  exportsDir: string;
  /** manifest.exporter.version（缺省中性占位，绝不谎报版本） */
  exporterVersion?: string;
  /** manifest.source.dshVersion（缺省 cli-offline：离线 CLI 探测不到真实 DSH 版本） */
  dshVersion?: string;
}

export interface ImportSourceDeps {
  /** 用户 home（缺省 os.homedir()，由 foreignSourceContext 回退；测试注入临时目录，绝不依赖真机 home） */
  userHome?: string;
}

/** 分区摘要的一行：文件类给文件数，JSON 类给该分区的计数键（全部是机器可读的条目数） */
function sectionLine(section: ForeignImportResult['sections'][number], result: ForeignImportResult): string {
  if (section.files !== undefined) return `  ${section.sectionId}: ${section.files.length} 个文件`;
  const counters = Object.entries(result.counts)
    .filter(([key]) => key.startsWith(section.sectionId + '.'))
    .map(([key, value]) => key + '=' + String(value));
  return `  ${section.sectionId}: JSON${counters.length > 0 ? '（' + counters.join(', ') + '）' : '（无条目计数）'}`;
}

function printSkipped(result: ForeignImportResult, io: ImportIo): void {
  if (result.skipped.length === 0) {
    io.log('未迁移项 / skipped: 无');
    return;
  }
  io.log(`未迁移项 / skipped（${result.skipped.length}）:`);
  for (const s of result.skipped) {
    const origin = s.origin !== undefined ? s.origin : '';
    const detail = s.detail !== undefined ? '（' + s.detail + '）' : '';
    const count = s.count !== undefined ? ' ×' + String(s.count) : '';
    io.log(`  [${s.code}] ${origin}${detail}${count}`);
  }
}

/** 打印摘要：**只有路径/机器码/引用名，绝无任何配置值** */
function printImportSummary(
  sourceId: string,
  detection: ForeignSourceDetection,
  result: ForeignImportResult,
  io: ImportIo,
): void {
  io.log(`来源 / source: ${sourceId}`);
  io.log(`本机检测 / detection: ${detection.found ? '已找到 / found' : '未找到本机痕迹 / not found'}`);
  if (detection.paths.length > 0) io.log(`  位置 /${' '}paths: ${detection.paths.join(', ')}`);
  for (const s of detection.skipped ?? []) {
    io.log(`  检测提示 / detection note: [${s.code}]${s.origin !== undefined ? ' ' + s.origin : ''}`);
  }
  io.log(`待导入分区 / sections（${result.sections.length}）:`);
  if (result.sections.length === 0) io.log('  （无可导入内容）/ nothing to import');
  for (const section of result.sections) io.log(sectionLine(section, result));
  printSkipped(result, io);
  io.log(
    result.credentialRefs.length > 0
      ? `需在 DSH 补录的凭据引用 / credential refs（${result.credentialRefs.length}）: ${result.credentialRefs.join(', ')}`
      : '需在 DSH 补录的凭据引用 / credential refs: 无',
  );
  io.log(`冲突策略 / conflict policy: ${FOREIGN_CONFLICT_POLICY}（不覆盖目标机既有同 id；跳过并报码）`);
}

/** 目标 ZIP：--out 优先；命中既有文件时自动加后缀，**绝不覆盖** */
async function resolveOutPath(options: ImportSourceOptions, sourceId: string): Promise<string> {
  const desired = options.out !== undefined && options.out !== ''
    ? path.resolve(options.out)
    : path.join(options.exportsDir, 'foreign-' + sourceId + '-' + formatDateStamp() + '-' + randomHex4() + '.zip');
  if (!(await pathExists(desired))) return desired;
  const base = desired.endsWith('.zip') ? desired.slice(0, -4) : desired;
  for (let i = 1; ; i += 1) {
    const candidate = base + '-' + String(i) + '.zip';
    if (!(await pathExists(candidate))) return candidate;
  }
}

function randomHex4(): string {
  // 用全局 crypto（Node ≥ 19）；零额外依赖
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行 `import --from`。
 *
 * `projectDir` 语义：`--cwd` 显式给出时用它；缺省 = 进程 cwd（「我现在在哪个项目里」就是
 * Cursor/Codex 项目级配置的含义）。宿主路由走 `?projectDir=`，缺省不猜（不扫 DSH 自己的 cwd）。
 */
export async function runImportSource(
  options: ImportSourceOptions,
  io: ImportIo,
  env: Record<string, string | undefined> = process.env,
  deps: ImportSourceDeps = {},
): Promise<number> {
  const registry = createBuiltinForeignSourceRegistry();
  let source;
  try {
    source = registry.get(options.from);
  } catch (error) {
    if (error instanceof ForeignSourceError) {
      io.error('未知外部来源 / unknown foreign source: ' + options.from);
      io.error('可用来源 / available sources: ' + (error.available.length > 0 ? error.available.join(', ') : '(空)'));
      return 1;
    }
    throw error;
  }

  /**
   * 来源上下文**经唯一构造点**（src/routes/foreign-context.ts）——宿主 GET/POST 与 CLI 三处
   * 必须同源，否则会出现「界面上找得到、命令行读不到」这类只在某一入口复现的怪事。
   *
   * 注意 projectDir 的缺省语义**在 CLI 侧不同**：CLI 的「我现在在哪个项目里」就是进程 cwd
   * （用户显式在项目目录下敲命令），所以这里缺省传 process.cwd()；宿主侧则**绝不猜**
   * （宿主进程的 cwd 不是用户的项目，缺省不传 = 不扫项目级）。这是刻意的入口语义差异，
   * 不是分叉 —— 传什么由调用方决定，怎么拼只有一处实现。
   */
  const ctx: ForeignSourceContext = foreignSourceContext({
    userHome: deps.userHome,
    env,
    projectDir: options.cwd !== undefined && options.cwd !== '' ? options.cwd : process.cwd(),
  });

  const detection = await source.detect(ctx);
  const result = await source.build(ctx);
  printImportSummary(source.id, detection, result, io);

  // 一个分区都产不出来时**必须失败**：空的 bundle 会自检通过，用户却拿到什么都没有的包
  //（与 backup「没有可打包的内容」同口径）。读盘层的 skipped 已经在上面如实打印了原因。
  if (result.sections.length === 0) {
    io.error('没有可导入的内容 / nothing to import（' + source.id + '：本机没有可转换的配置）');
    return 1;
  }

  if (options.dryRun) {
    io.log('（dry-run：零写入，未生成任何 ZIP）/ dry-run: nothing written');
    return 0;
  }

  const outPath = await resolveOutPath(options, source.id);
  try {
    // 真正落盘前才创建目录（dry-run 已提前返回，不产生任何写入）
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await writeForeignBundle({
      result,
      outPath,
      exporterVersion: options.exporterVersion ?? '0.0.0-unknown',
      // 离线 CLI 探测不到真实 DSH 版本：如实标注（与 backup 同口径，绝不谎报）
      dshVersion: options.dshVersion ?? 'cli-offline',
      platform: process.platform as Platform,
      arch: process.arch,
    });
  } catch (error) {
    io.error('生成 bundle 失败 / failed to write bundle: ' + (error instanceof Error ? error.message : String(error)));
    return 1;
  }
  io.log('已生成 bundle / bundle written: ' + outPath);

  // 落盘后立即自检（与 verify 同一引擎）：只有自检通过才返回 0
  const check = await verifyBackupZip(outPath);
  io.log(`[${check.verdict}] ${path.basename(outPath)}`);
  for (const e of check.errors) io.error('    ! ' + e);
  if (check.verdict !== 'OK') {
    io.error('自检未通过（文件已保留，请复核）/ self-verification failed（file kept）');
    return 1;
  }
  io.log('自检通过 / self-verification OK');
  return 0;
}
