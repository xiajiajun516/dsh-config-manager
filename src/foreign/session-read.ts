/**
 * 档 B 会话类来源的**共享读盘层**（宿主侧，node:fs；零业务语义）。
 *
 * 为什么要有这一层：24 个新来源里有十几个都是「在一个目录树里找 *.jsonl / *.json / *.db」，
 * 各自再写一遍 walk / 大小闸门 / 符号链接跳过，必然分叉 —— 而分叉的后果是**同一台机器上
 * 有的来源读到了、有的没读到**（本仓踩过 issue #37 的同类事故：自己写 isDirectory() 分支会
 * 静默丢掉整块内容）。本模块只提供**无业务语义的原语**；真值表（哪个目录、什么文件名）
 * 一律留在各来源自己的 `read-<id>.ts` 里（那才是每个来源需要独立取证的部分）。
 *
 * 四条硬边界（与既有 read-claude-code.ts / read-hermes.ts / read-cursor.ts 同口径）：
 *  ① **不跟随符号链接**（readdir 的 withFileTypes + isSymbolicLink 判定）；
 *  ② 单文件有字节上限，超限**不读**并如实上报，绝不截断；
 *  ③ 读不到一律返回 null / 空数组，**绝不抛**（一个来源读不到不得拖垮整次导入）；
 *  ④ 结果**排序**（目录遍历顺序在三个平台不同，排序让产物与测试确定）。
 */
import fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';

import type { ForeignSkip } from './types.ts';

/** 读不到的**稳定**原因（调用方映射成 ForeignSkip 的 detail，绝不进用户可见文案） */
export type ReadProblem = 'missing' | 'empty' | 'too-large' | 'read-error' | 'json-error' | 'not-a-file';

/** 单文件读取上限的显式取值（各来源可覆盖，缺省 8 MiB 与既有读盘层一致） */
export const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 一次走盘的最大文件数（防病态目录树；超限即停，调用方据此报码） */
export const DEFAULT_MAX_WALK_FILES = 5000;

export async function statOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  const st = await statOrNull(p);
  return st !== null && st.isDirectory();
}

export async function isFile(p: string): Promise<boolean> {
  const st = await statOrNull(p);
  return st !== null && st.isFile();
}

export async function listDirSafe(p: string): Promise<Dirent[]> {
  try {
    const dirents = await fs.readdir(p, { withFileTypes: true });
    return dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

export async function readBytesSafe(p: string, maxBytes: number = DEFAULT_MAX_FILE_BYTES): Promise<Uint8Array | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > maxBytes) return null;
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

/**
 * 只读文件**头部窗口**（审计 P7-7）：给「先看 header 再决定要不要整读」的场景用。
 *
 * 与 readBytesSafe 的区别只有一点：不超过 maxBytes 时只取前 maxBytes 字节，而不是整份读。
 * 语义仍守四条硬边界（读不到返回 null、绝不抛、超上限不读）。调用方必须自己处理
 * 「头部窗口不足以判定」的退化路径 —— 不要把它当成整份内容。
 */
export async function readBytesPrefixSafe(p: string, maxBytes: number): Promise<Uint8Array | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || maxBytes <= 0) return null;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(p, 'r');
    const buf = new Uint8Array(Math.min(maxBytes, st.size));
    const { bytesRead } = await handle.read(buf, 0, buf.byteLength, 0);
    return bytesRead === buf.byteLength ? buf : buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

export async function readTextSafe(p: string, maxBytes: number = DEFAULT_MAX_FILE_BYTES): Promise<string | null> {
  const st = await statOrNull(p);
  if (st === null || !st.isFile() || st.size > maxBytes) return null;
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** 读 + 解析 JSON：**失败给出稳定原因**（0 字节与畸形必须能区分 —— 前者是空文件码，后者是解析错） */
export type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; problem: ReadProblem };

export async function readJsonSafe(p: string, maxBytes: number = DEFAULT_MAX_FILE_BYTES): Promise<JsonReadResult> {
  const st = await statOrNull(p);
  if (st === null) return { ok: false, problem: 'missing' };
  if (!st.isFile()) return { ok: false, problem: 'not-a-file' };
  if (st.size === 0) return { ok: false, problem: 'empty' };
  if (st.size > maxBytes) return { ok: false, problem: 'too-large' };
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    return { ok: false, problem: 'read-error' };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, problem: 'json-error' };
  }
}

/** 逐行 JSONL 解析为「对象行 + 坏行数」（空行不计；**坏行绝不抛**） */
export interface JsonlLines { objects: Record<string, unknown>[]; lines: number; bad: number }

export function parseJsonlText(text: string): JsonlLines {
  const objects: Record<string, unknown>[] = [];
  let lines = 0;
  let bad = 0;
  for (const line of text.split(String.fromCharCode(10))) {
    if (line.trim() === '') continue;
    lines += 1;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        objects.push(parsed as Record<string, unknown>);
      } else {
        bad += 1;
      }
    } catch {
      bad += 1;
    }
  }
  return { objects, lines, bad };
}

/** 走盘命中项（rel = 相对探测根的 POSIX 路径，用作**位置标签**；abs 只在本进程内用） */
export interface WalkedFile { rel: string; abs: string; name: string }

export interface WalkOptions {
  /** 只收满足判定的**文件**（目录一律继续下钻；缺省 = 全部文件） */
  readonly match?: (name: string) => boolean;
  /** 最大下钻深度（根 = 0；缺省 8） */
  readonly maxDepth?: number;
  /** 最多收集多少个文件（缺省 DEFAULT_MAX_WALK_FILES） */
  readonly maxFiles?: number;
}

/**
 * 目录走盘（技能目录等）的**触顶统计**（t36）。
 *
 * 为什么要有它：各来源的目录走盘只回数组、不报是否触顶，于是「单目录文件数上限」
 * （maxSkillFiles=200）与「单文件字节上限」触顶时是**静默丢内容**（audit-foreign F4 的同族残余：
 * qwen 等 9 个会话源已在 t17 报码，技能文件遍历还没报）。走盘把统计交回调用方，
 * 由调用方用 dirWalkSkips() 换成与既有码同族的可见条目。
 */
export interface DirWalkStats {
  /** 命中条目数上限（= 至少还有一个候选文件没被收） */
  truncatedFiles?: boolean;
  /** 因单文件字节上限被跳过的文件数 */
  tooLargeCount?: number;
}

/** 目录走盘的条数触顶 detail（与 max-sessions-reached / max-skills-reached 同族） */
export const MAX_SKILL_FILES_REACHED = 'max-skill-files-reached';

/** 单文件字节上限触顶的 detail（与各读盘层既有的 too-large 同名同义） */
export const DIR_WALK_TOO_LARGE = 'too-large';

/**
 * 把一次目录走盘的触顶统计转成 skipped 条目（各来源共用同一口径）。
 * 无触顶 → 空数组（不产生噪声）；origin 一律是**包内相对标签**，绝不含机器路径或值。
 */
export function dirWalkSkips(
  stats: DirWalkStats | undefined,
  origin: string,
  maxFiles: number,
): ForeignSkip[] {
  if (stats === undefined) return [];
  const out: ForeignSkip[] = [];
  if (stats.truncatedFiles === true) {
    out.push({ code: 'source-unreadable', origin, detail: MAX_SKILL_FILES_REACHED, count: maxFiles });
  }
  const tooLarge = stats.tooLargeCount ?? 0;
  if (tooLarge > 0) {
    out.push({ code: 'source-unreadable', origin, detail: DIR_WALK_TOO_LARGE, count: tooLarge });
  }
  return out;
}

/**
 * 解析一个可选上限：**上下文覆盖 > 读器显式选项 > 默认值**（t36 透传面的唯一口径）。
 * 只用安全正整数（脏值一律落到下一档），因此「不给覆盖」与改造前**逐字同行为**。
 */
export function resolveLimit(
  override: number | undefined,
  explicit: number | undefined,
  fallback: number,
): number {
  const usable = (v: number | undefined): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (usable(override)) return override as number;
  if (usable(explicit)) return explicit as number;
  return fallback;
}

/** 相对路径统一成 POSIX 形态（包内相对路径与位置标签都是 POSIX） */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * 递归收集普通文件（**不跟随符号链接**、深度与条数有上限、结果按相对路径排序）。
 * 读不到的目录静默跳过（它是「这里没有数据」，不是错误 —— 错误由调用方按根的存在性判定）。
 */
export async function walkFiles(root: string, options: WalkOptions = {}): Promise<WalkedFile[]> {
  const match = options.match ?? ((): boolean => true);
  const maxDepth = options.maxDepth ?? 8;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_WALK_FILES;
  const out: WalkedFile[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const entry of await listDirSafe(cur.dir)) {
      if (out.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(cur.dir, entry.name);
      if (entry.isDirectory()) {
        if (cur.depth < maxDepth) stack.push({ dir: abs, depth: cur.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!match(entry.name)) continue;
      out.push({ rel: toPosixPath(path.relative(root, abs)), abs, name: entry.name });
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/** 只列**直接子目录**的名字（排序；不跟随符号链接） */
export async function listDirNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listDirSafe(dir)) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    out.push(entry.name);
  }
  return out;
}

/** 只列**直接子文件**的名字（排序；可给判定） */
export async function listFileNames(dir: string, match?: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await listDirSafe(dir)) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    if (match !== undefined && !match(entry.name)) continue;
    out.push(entry.name);
  }
  return out;
}

/** 去掉扩展名（不引入 path.parse 的平台差异：只切最后一个点之后的非空后缀） */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/* ---------------- 探测：只 stat，绝不读内容 ---------------- */

/** 探测结果：命中位置（**相对 home 的 POSIX 标签**）+ 如实记录的发现 */
export interface ProbeOutcome { readonly paths: readonly string[]; readonly skipped: readonly ForeignSkip[] }

/**
 * 位置标签：相对用户 home 的 POSIX 串（宿主给 GUI/CLI 的位置**绝不能是绝对路径** —— 那是机器身份）。
 * 不在 home 之下的（如 %APPDATA%、XDG 目录、显式项目目录）退化为「可辨识的顺序标签」，仍然不含盘符与用户名。
 */
export function labelForPath(homeDir: string, p: string): string {
  const rel = path.relative(homeDir, p);
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosixPath(rel);
  const normal = toPosixPath(p);
  const segments = normal.split('/');
  // 只保留最后两段（足以辨识 `AppData/Roaming/<product>/User` 这类真值位置），绝不回传盘符/用户名
  return segments.slice(Math.max(0, segments.length - 2)).join('/');
}

/**
 * 按真值表逐个 stat 探测（**只 stat、绝不读内容**：检测层拿不到任何配置值，也就无从泄露）。
 *
 * 三条语义：不存在 = 正常（未安装，不是错误）；0 字节文件如实报码（仍算命中）；
 * 目录/文件都算命中（判据由真值表决定，本函数不额外收窄）。
 */
export async function probeConfiguredPaths(paths: readonly string[], homeDir: string): Promise<ProbeOutcome> {
  const hits: string[] = [];
  const skipped: ForeignSkip[] = [];
  for (const p of paths) {
    const st = await statOrNull(p);
    if (st === null) continue;
    if (!st.isFile() && !st.isDirectory()) continue;
    const label = labelForPath(homeDir, p);
    hits.push(label);
    if (st.isFile() && st.size === 0) skipped.push({ code: 'source-empty-file', origin: label });
  }
  return { paths: hits, skipped };
}
