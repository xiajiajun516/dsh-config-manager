/**
 * 离线会话修复规划（issue #45 Fix 3，**纯函数**：零 IO、零字节操作）。
 *
 * 场景：DSH 已经起不来（实测报 corrupt session log / duplicate JSONL session id），插件也就加载不了，
 * 因此在线路径（导入期护栏 / 「会话归位」卡片）全部不可用 —— 唯一可用的通道是 CLI 离线修复。
 * 本模块只做「怎么修」的判定；读写字节与搬目录在 src/cli/sessions-repair.ts（宿主侧）。
 *
 * 判定口径（与在线 planner 的 projectKey 口径完全一致，共用 projectKeyOf）：
 *   1. 同一 id 出现在多个 projectKey 目录 → duplicate-id：**只在用户点名 --keep 时**才隔离其它副本
 *      （否则只报告：谁是权威副本是用户才知道的事，猜错就是删数据）；
 *   2. 目录内有 session.lock → 不动（可能正被其它进程使用）；
 *   3. header 读不出 cwd → 不动（DSH 的 _no-cwd 会话；猜错会让下次启动更糟）；
 *   4. 命中路径映射且与原 cwd 不同 → 先改写首帧 header 再搬目录（rewrite-move）；
 *   5. 否则只按 header 的 cwd 把目录搬到 projectKeyOf(cwd)（move）——**不需要映射**：
 *      位置与 header 一致之后 DSH 就能启动，剩下的「认到本机工作区」交给在线归位卡片。
 */
import { normalizePath } from '../utils/paths.ts';
import { projectKeyOf } from './session-meta.ts';
import { applyPathMapping } from './path-mapping.ts';
import type { PathMappingRule } from './path-mapping.ts';

/** 单条会话的修复原因（机器可读；文案由 CLI 输出层决定）。 */
export type SessionRepairReason =
  /** header 里没有 cwd（DSH 的 _no-cwd 会话）：无法判定目标目录 */
  | 'no-cwd'
  /** 同一会话的多份 generation 的 cwd 不一致：不猜哪份为准 */
  | 'inconsistent-generations'
  /** 目录内有 session.lock：可能正被使用 */
  | 'locked'
  /** 位置已经正确 */
  | 'already-placed'
  /** 需要搬家（header 未变） */
  | 'needs-move'
  /** 需要先改写首帧 cwd（路径映射命中）再搬家 */
  | 'needs-rewrite-move'
  /** 同一 id 出现在多个 projectKey 目录 */
  | 'duplicate-id';

/** 一条动作的类别（决定 CLI 做什么）。 */
export type SessionRepairActionKind =
  /** 无需动作 */
  | 'ok'
  /** 搬目录到正确 projectKey 段 */
  | 'move'
  /** 改写首帧 cwd 后再搬目录 */
  | 'rewrite-move'
  /** 只报告，不动（缺 cwd / 加锁 / 多 generation 不一致） */
  | 'skip'
  /** 重复 id 里按 --keep 保留的那一份 */
  | 'keep'
  /** 重复 id 里被移到隔离目录的那一份 */
  | 'quarantine';

/** 扫描到的一条会话（由 CLI 读盘得出；规划本身不碰文件系统）。 */
export interface RepairSessionInput {
  /** 会话目录名（DSH 用 session-<uuid> 或裸 <uuid>） */
  sessionId: string;
  /** 会话目录当前所在的 projectKey 段（= 父目录名） */
  fromProjectKey: string;
  /** 会话目录绝对路径 */
  dir: string;
  /** 首帧 header 的 cwd（读不出或缺省 = 无法判定） */
  cwd?: string;
  /** 目录内有 session.lock（POSIX） */
  locked?: boolean;
  /** 该会话的多份 generation cwd 是否一致（false = 不猜） */
  consistent?: boolean;
}

export interface SessionRepairOptions {
  /** 可选路径映射（--map old=new，按顺序应用） */
  mappings?: readonly PathMappingRule[];
  /** 重复 id 时保留哪一份（绝对目录路径，或它的规范化形式） */
  keep?: string;
}

export interface SessionRepairAction {
  kind: SessionRepairActionKind;
  sessionId: string;
  dir: string;
  fromProjectKey: string;
  /** 目标 projectKey 段（move / rewrite-move 时给出） */
  toProjectKey?: string;
  /** 需要改写的首帧 cwd（rewrite-move 时给出） */
  rewrite?: { from: string; to: string };
  reason: SessionRepairReason;
  /** 是否真的落盘（false = 只报告：缺 cwd / 加锁 / 未点名 keep 的重复项） */
  applies: boolean;
}

export interface SessionRepairSummary {
  scanned: number;
  ok: number;
  move: number;
  rewriteMove: number;
  skip: number;
  keep: number;
  quarantine: number;
  /** 受影响的重复 id 条数（同一 id 的多份只算一次） */
  duplicates: number;
}

export interface SessionRepairPlan {
  actions: SessionRepairAction[];
  summary: SessionRepairSummary;
}

function emptySummary(): SessionRepairSummary {
  return { scanned: 0, ok: 0, move: 0, rewriteMove: 0, skip: 0, keep: 0, quarantine: 0, duplicates: 0 };
}

/** 路径等价（大小写不敏感 + 分隔符归一；Windows 盘符大小写常不一致）。 */
function sameDir(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/**
 * 规划离线修复（纯函数；顺序稳定 = 输入顺序）。
 */
export function planSessionRepair(
  sessions: readonly RepairSessionInput[],
  options: SessionRepairOptions = {},
): SessionRepairPlan {
  const plan: SessionRepairPlan = { actions: [], summary: emptySummary() };
  const mappings = options.mappings ?? [];
  const byId = new Map<string, RepairSessionInput[]>();
  for (const session of sessions) {
    const list = byId.get(session.sessionId);
    if (list === undefined) byId.set(session.sessionId, [session]);
    else list.push(session);
  }
  const countedDuplicates = new Set<string>();
  for (const session of sessions) {
    const group = byId.get(session.sessionId) ?? [];
    plan.summary.scanned += 1;
    const push = (action: SessionRepairAction): void => {
      plan.actions.push(action);
      if (action.kind === 'ok') plan.summary.ok += 1;
      else if (action.kind === 'move') plan.summary.move += 1;
      else if (action.kind === 'rewrite-move') plan.summary.rewriteMove += 1;
      else if (action.kind === 'skip') plan.summary.skip += 1;
      else if (action.kind === 'keep') plan.summary.keep += 1;
      else if (action.kind === 'quarantine') plan.summary.quarantine += 1;
    };
    // 1. 重复 id：只在用户点名保留谁时才隔离其它副本（否则只报告）
    if (group.length > 1) {
      if (!countedDuplicates.has(session.sessionId)) {
        countedDuplicates.add(session.sessionId);
        plan.summary.duplicates += 1;
      }
      const kept = options.keep !== undefined && sameDir(options.keep, session.dir);
      push({
        kind: kept ? 'keep' : 'quarantine',
        sessionId: session.sessionId,
        dir: session.dir,
        fromProjectKey: session.fromProjectKey,
        reason: 'duplicate-id',
        // 被保留下来的那份也要继续参与位置修复，所以它不算「已处理」；
        // 隔离副本只在用户点名 keep 时才允许落盘。
        applies: !kept && options.keep !== undefined,
      });
      continue;
    }
    // 2. 加锁 / 多 generation 不一致 / 缺 cwd：只报告
    if (session.locked === true) {
      push({ kind: 'skip', sessionId: session.sessionId, dir: session.dir, fromProjectKey: session.fromProjectKey, reason: 'locked', applies: false });
      continue;
    }
    if (session.consistent === false) {
      push({ kind: 'skip', sessionId: session.sessionId, dir: session.dir, fromProjectKey: session.fromProjectKey, reason: 'inconsistent-generations', applies: false });
      continue;
    }
    if (session.cwd === undefined || session.cwd === '') {
      push({ kind: 'skip', sessionId: session.sessionId, dir: session.dir, fromProjectKey: session.fromProjectKey, reason: 'no-cwd', applies: false });
      continue;
    }
    // 3. 目标 cwd：命中映射就用映射后的值（并需要改写首帧），否则沿用原文
    const mapped = applyPathMapping(session.cwd, mappings);
    const toProjectKey = projectKeyOf(mapped ?? session.cwd);
    const rewrite = mapped === null ? undefined : { from: session.cwd, to: mapped };
    if (rewrite === undefined && toProjectKey === session.fromProjectKey) {
      push({ kind: 'ok', sessionId: session.sessionId, dir: session.dir, fromProjectKey: session.fromProjectKey, toProjectKey, reason: 'already-placed', applies: false });
      continue;
    }
    push({
      kind: rewrite === undefined ? 'move' : 'rewrite-move',
      sessionId: session.sessionId,
      dir: session.dir,
      fromProjectKey: session.fromProjectKey,
      toProjectKey,
      ...(rewrite !== undefined ? { rewrite } : {}),
      reason: rewrite === undefined ? 'needs-move' : 'needs-rewrite-move',
      applies: true,
    });
  }
  return plan;
}

/** 报告里是否需要用户介入（重复项 / 跳过项 / 待搬迁项）。 */
export function sessionRepairNeedsAttention(plan: SessionRepairPlan): boolean {
  const s = plan.summary;
  return s.move > 0 || s.rewriteMove > 0 || s.skip > 0 || s.duplicates > 0;
}
