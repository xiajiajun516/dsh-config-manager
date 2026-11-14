/**
 * 快照恢复的「改动预览」引擎（core 层）。
 *
 * 恢复计划本身（RestorePlan）只有「动作 + 一句描述」，看不到**哪个文件、改了哪几行**。
 * 本模块补上这一层，供「恢复计划预览」弹窗渲染 git 风格视图：
 *  - summarizeRestoreChanges(plan)：逐动作读取「磁盘现状（before）」与「快照内容（after）」，
 *    给出变更状态（修改 / 新增 / 删除 / 卸载插件 / 人工提示 / 无动作）与行数统计。
 *  - snapshotFileDiff({target, blobPath, kind})：单个文件的完整 hunks（左右双栏 / 统一格式渲染用）。
 *
 * 设计要点：
 *  - **两级读取**：列表阶段只做轻量统计（单侧 ≤ maxStatSideBytes，总量 ≤ maxStatTotalBytes，
 *    文件数 ≤ maxStatFiles，超限的文件标记 statSkipped 而不是拖慢预览）；点开某个文件才算出完整
 *    hunks（单侧 ≤ maxSideBytes，超出则只报体积不逐行对比）。
 *  - **安全**：路径一律经 restore.ts 的 homeAbs / blobAbs 护栏（$DSH_HOME 内、快照目录内），
 *    越界直接拒绝；二进制文件不逐行对比；返回值不含凭据值（内容由 UI 渲染前再 redact）。
 *  - **绝不抛错**：单项失败只影响该项（标记 unreadable / skip），不影响其余动作与整个预览。
 */
import fs from 'node:fs/promises';

import { diffLines, splitLines, type DiffHunk } from '../utils/line-diff.ts';
import { blobAbs, homeAbs, type RestoreActionKind, type RestorePlan } from './restore.ts';
import { zhMsg } from './messages.ts';
import type { MsgFunc } from './messages.ts';

/** 读取 / 统计上限（常量导出供测试与 UI 文案引用同一口径）。 */
export const SNAPSHOT_DIFF_LIMITS = {
  /** 完整 diff：单侧参与逐行对比的字节上限（超出 → 只报体积，不逐行对比） */
  maxSideBytes: 1024 * 1024,
  /** 列表统计：单侧参与行数统计的字节上限 */
  maxStatSideBytes: 256 * 1024,
  /** 列表统计：所有文件两侧读取的总字节预算 */
  maxStatTotalBytes: 8 * 1024 * 1024,
  /** 列表统计：最多统计多少个文件（其余标记为未统计） */
  maxStatFiles: 80,
  /** Myers 输入行数上限（超出 → 整块替换降级） */
  maxLines: 6000,
  /** Myers 最大编辑距离 */
  maxD: 400,
  /** 上下文行数 */
  context: 3,
} as const;

/** 变更状态（用户视角的 git status 语义）。 */
export type SnapshotChangeStatus = 'modified' | 'added' | 'deleted' | 'plugin' | 'hint' | 'skip';

/** 行数统计未能产出的原因。 */
export type ChangeStatSkipReason = 'too-large' | 'binary' | 'unreadable' | 'budget';

/** 列表阶段：单个恢复动作的改动摘要（与 plan.actions 下标一一对应）。 */
export interface SnapshotChangeEntry {
  /** plan.actions 下标（前端按此关联） */
  index: number;
  kind: RestoreActionKind;
  status: SnapshotChangeStatus;
  /** homeDir 相对路径（plugin 项 = 插件名；无目标时为 undefined） */
  target?: string;
  description: string;
  detail?: string;
  /** 磁盘现状是否存在 */
  beforeExists: boolean;
  /** 快照内容是否存在 */
  afterExists: boolean;
  beforeBytes?: number;
  afterBytes?: number;
  added?: number;
  removed?: number;
  statSkipped?: ChangeStatSkipReason;
}

export interface RestoreChangeSummary {
  entries: SnapshotChangeEntry[];
  /** 成功统计行数的文件数 */
  computed: number;
  /** 因体积 / 预算未统计行数的文件数 */
  skipped: number;
  /** 两侧读取的总字节数（预算口径） */
  totalBytes: number;
  /** 因总预算触顶而提前停止统计 */
  budgetExhausted: boolean;
  /** 统计口径上限（UI 提示用） */
  limits: typeof SNAPSHOT_DIFF_LIMITS;
}

/** 单侧读取结果（缺文件 = exists:false 且 text 为空串）。 */
interface SideRead {
  exists: boolean;
  bytes: number;
  /** 文本内容；null = 未读取（二进制 / 超限 / 不可读） */
  text: string | null;
  binary: boolean;
  oversized: boolean;
  unreadable: boolean;
}

const ABSENT: SideRead = { exists: false, bytes: 0, text: '', binary: false, oversized: false, unreadable: false };

/** 该 errno 是否等于「路径真的不存在」（其余 = 存在但拿不到，绝不能当作不存在）。 */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * 「存在但读不出」的唯一形态（目录 / 无权限 / 被占用 / stat 抛非 ENOENT）。
 * 与 ABSENT（真的不存在）严格区分：判成不存在会让预览把改不了的文件显示成「新增」（审计 P2-6）。
 */
function unreadableAt(bytes: number): SideRead {
  return { exists: true, bytes, text: null, binary: false, oversized: false, unreadable: true };
}

/** 只探测存在性（预算触顶时用：不读内容，只 stat）。 */
async function probeExists(
  opts: { homeDir: string; target: string; msg: MsgFunc },
): Promise<'exists' | 'absent' | 'unreadable' | 'escape'> {
  let abs: string;
  try {
    abs = homeAbs(opts.homeDir, opts.target, opts.msg);
  } catch {
    return 'escape';
  }
  try {
    const stat = await fs.stat(abs);
    return stat.isFile() ? 'exists' : 'unreadable';
  } catch (err) {
    // ENOENT 才是「没有」；EACCES 一类说明路径在，只是拿不到状态
    return isEnoent(err) ? 'absent' : 'unreadable';
  }
}

/** readSide 依赖的最小 fs 能力（默认 = 真 fs）。 */
export interface SideReadIo {
  stat(abs: string): Promise<{ isFile(): boolean; size: number }>;
  readFile(abs: string): Promise<Buffer>;
}

const REAL_SIDE_IO: SideReadIo = {
  stat: (abs) => fs.stat(abs),
  readFile: (abs) => fs.readFile(abs),
};

/**
 * 读单侧内容。
 *
 * 三种结果必须分开：真的没有（ABSENT）/ 存在但读不出（unreadable）/ 正常读到。
 * 原先整段包一个 try + 末尾 `catch { return ABSENT }`，把「stat 成功、readFile 抛 EACCES」
 * 判成了不存在 —— 预览因此把只读文件显示成「新增」（审计 P2-6）。
 *
 * `io` 参数只为单测注入：Windows 上造不出 EACCES 夹具，而这条分支必须被真正覆盖；
 * 生产调用方一律不传（走 REAL_SIDE_IO）。
 */
export async function readSide(abs: string, maxBytes: number, io: SideReadIo = REAL_SIDE_IO): Promise<SideRead> {
  let stat: { isFile(): boolean; size: number };
  try {
    stat = await io.stat(abs);
  } catch (err) {
    return isEnoent(err) ? ABSENT : unreadableAt(0);
  }
  if (!stat.isFile()) return unreadableAt(stat.size);
  if (stat.size > maxBytes) {
    return { exists: true, bytes: stat.size, text: null, binary: false, oversized: true, unreadable: false };
  }
  let buf: Buffer;
  try {
    buf = await io.readFile(abs);
  } catch (err) {
    // stat 已证明它是普通文件：这里读失败 = 存在但读不出（EACCES/EBUSY/…）；
    // stat 与 read 之间被删掉的 ENOENT 仍按「不存在」处理，那才是当时的真实状态
    return isEnoent(err) ? ABSENT : unreadableAt(stat.size);
  }
  if (buf.subarray(0, 8192).includes(0)) {
    return { exists: true, bytes: buf.byteLength, text: null, binary: true, oversized: false, unreadable: false };
  }
  return { exists: true, bytes: buf.byteLength, text: buf.toString('utf8'), binary: false, oversized: false, unreadable: false };
}

/** 变更状态判定（恢复类：before 存在 = 修改，不存在 = 新增）。 */
function statusOf(kind: RestoreActionKind, beforeExists: boolean): SnapshotChangeStatus {
  switch (kind) {
    case 'hostFileRestore':
    case 'fileRestore':
      return beforeExists ? 'modified' : 'added';
    case 'hostFileRemove':
    case 'fileRemove':
      return 'deleted';
    case 'pluginRemove':
    case 'pluginInstall':
      return 'plugin';
    case 'credentialHint':
      return 'hint';
    case 'skip':
      return 'skip';
    default:
      return 'skip';
  }
}

/** 该状态是否值得逐行对比（skip / plugin / hint 不是文件内容变更）。 */
function isDiffable(status: SnapshotChangeStatus): boolean {
  return status === 'modified' || status === 'added' || status === 'deleted';
}

interface ResolvedSide {
  side: SideRead;
  /** 护栏拒绝 / 无 blob 目标 */
  reason?: 'path-escape' | 'missing-blob';
}

/** 解析动作的 before/after 绝对路径并读取（越界不与磁盘交互，直接返回拒绝原因）。 */
async function readBothSides(
  opts: { snapshotDir: string; homeDir: string; kind: RestoreActionKind; target?: string; blobPath?: string; msg: MsgFunc },
  maxBytes: number,
): Promise<{ before: ResolvedSide; after: ResolvedSide }> {
  const restoreKind = opts.kind === 'hostFileRestore' || opts.kind === 'fileRestore';
  const removeKind = opts.kind === 'hostFileRemove' || opts.kind === 'fileRemove';
  if (opts.target === undefined || (!restoreKind && !removeKind)) {
    return { before: { side: ABSENT }, after: { side: ABSENT } };
  }
  let targetAbs: string;
  try {
    targetAbs = homeAbs(opts.homeDir, opts.target, opts.msg);
  } catch {
    return { before: { side: ABSENT, reason: 'path-escape' }, after: { side: ABSENT, reason: 'path-escape' } };
  }
  const before = await readSide(targetAbs, maxBytes);
  if (removeKind) return { before: { side: before }, after: { side: ABSENT } };
  if (opts.blobPath === undefined || opts.blobPath === '') {
    return { before: { side: before }, after: { side: ABSENT, reason: 'missing-blob' } };
  }
  let blobFile: string;
  try {
    blobFile = blobAbs(opts.snapshotDir, opts.blobPath, opts.msg);
  } catch {
    return { before: { side: before }, after: { side: ABSENT, reason: 'path-escape' } };
  }
  const after = await readSide(blobFile, maxBytes);
  if (!after.exists) return { before: { side: before }, after: { side: ABSENT, reason: 'missing-blob' } };
  return { before: { side: before }, after: { side: after } };
}

/** 行数统计（任一必需侧不可读 → 返回跳过原因）。 */
function statsOf(
  status: SnapshotChangeStatus,
  before: SideRead,
  after: SideRead,
): { added?: number; removed?: number; skipped?: ChangeStatSkipReason } {
  if (!isDiffable(status)) return {};
  if (before.binary || after.binary) return { skipped: 'binary' };
  if (before.oversized || after.oversized) return { skipped: 'too-large' };
  if (before.unreadable || after.unreadable) return { skipped: 'unreadable' };
  const result = diffLines(before.text ?? '', after.text ?? '', {
    context: SNAPSHOT_DIFF_LIMITS.context,
    maxLines: SNAPSHOT_DIFF_LIMITS.maxLines,
    maxD: SNAPSHOT_DIFF_LIMITS.maxD,
  });
  return { added: result.added, removed: result.removed };
}

/**
 * 列表阶段：逐动作产出变更状态 + 行数统计（零写入；不抛错）。
 * plan 为空或 action 不可分析时返回对应 entry（status='skip'），绝不抛错给路由。
 */
export async function summarizeRestoreChanges(opts: {
  plan: RestorePlan;
  snapshotDir: string;
  homeDir: string;
  msg?: MsgFunc;
}): Promise<RestoreChangeSummary> {
  const msg = opts.msg ?? zhMsg;
  const entries: SnapshotChangeEntry[] = [];
  let computed = 0;
  let skipped = 0;
  let totalBytes = 0;
  let budgetExhausted = false;
  for (let index = 0; index < opts.plan.actions.length; index += 1) {
    const action = opts.plan.actions[index];
    if (action === undefined) continue;
    const restoreKind = action.kind === 'hostFileRestore' || action.kind === 'fileRestore';
    const removeKind = action.kind === 'hostFileRemove' || action.kind === 'fileRemove';
    const entry: SnapshotChangeEntry = {
      index,
      kind: action.kind,
      status: statusOf(action.kind, false),
      target: action.target,
      description: action.description,
      detail: action.detail,
      beforeExists: false,
      afterExists: false,
    };
    if (restoreKind || removeKind) {
      const withinBudget = !budgetExhausted && totalBytes < SNAPSHOT_DIFF_LIMITS.maxStatTotalBytes && computed + skipped < SNAPSHOT_DIFF_LIMITS.maxStatFiles;
      if (!withinBudget) {
        // 预算触顶：只探测存在性（stat 很便宜），行数统计留空并标记原因
        budgetExhausted = true;
        const probe = await probeExists({ homeDir: opts.homeDir, target: action.target ?? '', msg });
        if (probe === 'escape') {
          entry.status = 'skip';
          entry.statSkipped = 'unreadable';
        } else {
          // 「存在但读不出」与 readSide 同口径：算存在（否则会显示成「新增」），只把行数统计标成 unreadable
          const unreadable = probe === 'unreadable';
          entry.beforeExists = probe === 'exists' || unreadable;
          entry.afterExists = restoreKind;
          entry.status = statusOf(action.kind, entry.beforeExists);
          entry.statSkipped = unreadable ? 'unreadable' : 'budget';
        }
        skipped += 1;
        entries.push(entry);
        continue;
      }
      const { before, after } = await readBothSides(
        { snapshotDir: opts.snapshotDir, homeDir: opts.homeDir, kind: action.kind, target: action.target, blobPath: action.blobPath, msg },
        SNAPSHOT_DIFF_LIMITS.maxStatSideBytes,
      );
      const rejected = before.reason !== undefined || after.reason !== undefined;
      entry.beforeExists = before.side.exists;
      entry.afterExists = after.side.exists;
      entry.beforeBytes = before.side.bytes;
      entry.afterBytes = after.side.exists ? after.side.bytes : undefined;
      totalBytes += before.side.bytes + after.side.bytes;
      if (rejected) {
        // 护栏拒绝 / blob 缺失：不是一个可展示的文件变更
        entry.status = 'skip';
        entry.statSkipped = 'unreadable';
        skipped += 1;
        entries.push(entry);
        continue;
      }
      entry.status = statusOf(action.kind, before.side.exists);
      if (removeKind) entry.afterExists = false;
      const stats = statsOf(entry.status, before.side, after.side);
      if (stats.skipped !== undefined) {
        entry.statSkipped = stats.skipped;
        skipped += 1;
      } else {
        entry.added = stats.added;
        entry.removed = stats.removed;
        computed += 1;
      }
      if (totalBytes >= SNAPSHOT_DIFF_LIMITS.maxStatTotalBytes) budgetExhausted = true;
      entries.push(entry);
      continue;
    }
    if (action.kind === 'pluginRemove' || action.kind === 'pluginInstall') entry.status = 'plugin';
    else if (action.kind === 'credentialHint') entry.status = 'hint';
    else entry.status = 'skip';
    entries.push(entry);
  }
  return {
    entries,
    computed,
    skipped,
    totalBytes,
    budgetExhausted,
    limits: SNAPSHOT_DIFF_LIMITS,
  };
}

/** 单侧展示信息（供 UI 显示体积 / 行数 / 二进制标记）。 */
export interface SnapshotFileDiffSide {
  exists: boolean;
  bytes: number;
  /** 行数；null = 未读取（二进制 / 超限 / 不可读） */
  lines: number | null;
  binary: boolean;
  oversized: boolean;
  unreadable: boolean;
}

export type SnapshotFileDiffReason =
  | 'path-escape'
  | 'missing-blob'
  | 'binary'
  | 'too-large'
  | 'unreadable'
  | 'no-target'
  | 'not-diffable';

export interface SnapshotFileDiff {
  kind: RestoreActionKind;
  status: SnapshotChangeStatus;
  target?: string;
  before: SnapshotFileDiffSide;
  after: SnapshotFileDiffSide;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  identical: boolean;
  /** 规模超限 → 结果仍是完整替换，只是不是最小编辑脚本 */
  degraded: boolean;
  /** 无法逐行对比的原因（有值时 hunks 为空） */
  reason?: SnapshotFileDiffReason;
  limits: typeof SNAPSHOT_DIFF_LIMITS;
}

function sideView(side: SideRead): SnapshotFileDiffSide {
  return {
    exists: side.exists,
    bytes: side.bytes,
    lines: side.text === null ? null : splitLines(side.text).length,
    binary: side.binary,
    oversized: side.oversized,
    unreadable: side.unreadable,
  };
}

/**
 * 单个文件的完整 diff（零写入；不抛错）。
 * 越界 / blob 缺失 / 二进制 / 超限都返回结构化 reason 而不是异常。
 */
export async function snapshotFileDiff(opts: {
  snapshotDir: string;
  homeDir: string;
  kind: RestoreActionKind;
  target?: string;
  blobPath?: string;
  msg?: MsgFunc;
}): Promise<SnapshotFileDiff> {
  const msg = opts.msg ?? zhMsg;
  const base: Omit<SnapshotFileDiff, 'before' | 'after' | 'status'> = {
    kind: opts.kind,
    target: opts.target,
    hunks: [],
    added: 0,
    removed: 0,
    identical: false,
    degraded: false,
    limits: SNAPSHOT_DIFF_LIMITS,
  };
  const emptySide: SnapshotFileDiffSide = { exists: false, bytes: 0, lines: null, binary: false, oversized: false, unreadable: false };
  if (opts.target === undefined || opts.target === '') {
    return { ...base, status: 'skip', before: emptySide, after: emptySide, reason: 'no-target' };
  }
  const status = statusOf(opts.kind, true);
  if (!isDiffable(status)) {
    return { ...base, status, before: emptySide, after: emptySide, reason: 'not-diffable' };
  }
  const { before, after } = await readBothSides(
    { snapshotDir: opts.snapshotDir, homeDir: opts.homeDir, kind: opts.kind, target: opts.target, blobPath: opts.blobPath, msg },
    SNAPSHOT_DIFF_LIMITS.maxSideBytes,
  );
  const view: SnapshotFileDiff = {
    ...base,
    status: statusOf(opts.kind, before.side.exists),
    before: sideView(before.side),
    after: sideView(after.side),
  };
  const escape = before.reason ?? after.reason;
  if (escape !== undefined) return { ...view, reason: escape };
  if (before.side.binary || after.side.binary) return { ...view, reason: 'binary' };
  if (before.side.oversized || after.side.oversized) return { ...view, reason: 'too-large' };
  if (before.side.unreadable || after.side.unreadable) return { ...view, reason: 'unreadable' };
  const result = diffLines(before.side.text ?? '', after.side.text ?? '', {
    context: SNAPSHOT_DIFF_LIMITS.context,
    maxLines: SNAPSHOT_DIFF_LIMITS.maxLines,
    maxD: SNAPSHOT_DIFF_LIMITS.maxD,
  });
  return {
    ...view,
    hunks: result.hunks,
    added: result.added,
    removed: result.removed,
    identical: result.identical,
    degraded: result.degraded,
  };
}
