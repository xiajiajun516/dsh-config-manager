/**
 * 通用「按键三方合并」（issue #145）。
 *
 * 为什么单独一个模块：plugins 分区里除插件清单外还有几组**有序条目集**（patch 行、本地 tarball、
 * patch 文件），它们共同的语义是「同一键 = 同一条目」。通用 JSON 合并不认这个语义 —— 数组
 * 两侧各改一次就判整分区冲突，于是 patch 行永远合不进去（issue #145 的两道门之一）。规则三处
 * 完全相同，故只写一份。
 *
 * 规则（与 git 同口径；祖先只用来判断「谁动过它」，绝不猜）：
 *  - 两侧同键且内容身份相同 → 保留本机；
 *  - 某一侧与祖先相同 → 取另一侧（mergePoints + 1）；
 *  - 两侧都改（或没有祖先且两者不同）→ both-modified；
 *  - 只有本机：无祖先 = 本机独有 → 保留；有祖先且未改 → followDelete ? 跟随删除 : 保留并记进
 *    keptAgainstDelete（开关关着 = 一个都不删，见 issue #145 的裁决）；有祖先且已改 → modify-delete；
 *  - 只有远端：无祖先 = 远端独有 → 采纳；有祖先且未改 → 本机删过它，跟随删除；有祖先且已改 →
 *    delete-modify；
 *  - 顺序 = 本机顺序，远端独有的键按远端相对顺序追加；
 *  - keepLocal 命中的条目永远以本机为准（既删不掉，也不报冲突）。
 *
 * 冲突只回报、不进 merged：调用方拿到非空 conflicts 时按整分区冲突处置（与既有钩子同口径，
 * 绝不「合一半就落地」）。纯函数、零 I/O。
 */
import type { MergeConflict } from './merge.ts';

/** 单条目的冲突理由：只可能是这三种（跨侧改同一个键 / 一侧删一侧改）。 */
export type KeyedConflictReason = 'both-modified' | 'modify-delete' | 'delete-modify';

export interface KeyedMergeSpec<T> {
  /** 身份键（同键 = 同一条目）；返回空串 = 该条目没有身份，跳过不参与合并。 */
  keyOf(item: T): string;
  /**
   * 内容身份（相等 = 这一侧没改过它）。peers 是同一键上出现过的三侧原值，供「按需归一化」用
   * —— patch 行要按三侧 redactedPaths 并集把被剥空的叶子归零后再比（issue #145 门②）。
   */
  identityOf(item: T, peers: readonly T[]): string;
  /** 冲突路径（给人看的定位，如 `plugins.alpha`）。 */
  pathOf(key: string): string;
  /** 本机未改、远端删了：true = 跟随删除；false = 保留本机并记进 keptAgainstDelete。 */
  followDelete: boolean;
  /** 永远以本机为准的条目（本插件自己这类「删了会坏事」的东西）：不删、不报冲突。 */
  keepLocal?(item: T): boolean;
}

export interface KeyedMergeResult<T> {
  merged: T[];
  conflicts: MergeConflict[];
  /** 自动并入的变更点（「两侧各自的改动都保住了」处数） */
  mergePoints: number;
  /** 远端删了、但因 followDelete=false 留下的键（供报告说明「开关关着所以保留」） */
  keptAgainstDelete: string[];
}

function indexByKey<T>(list: readonly T[] | undefined, keyOf: (item: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of list ?? []) {
    if (item === null || typeof item !== 'object') continue;
    const key = keyOf(item);
    if (key !== '') index.set(key, item);
  }
  return index;
}

export function mergeKeyedList<T>(args: {
  local: readonly T[];
  remote: readonly T[];
  ancestor: readonly T[] | undefined;
  spec: KeyedMergeSpec<T>;
}): KeyedMergeResult<T> {
  const { spec } = args;
  const localIndex = indexByKey(args.local, spec.keyOf);
  const remoteIndex = indexByKey(args.remote, spec.keyOf);
  const ancestorIndex = indexByKey(args.ancestor, spec.keyOf);

  const order: string[] = [...localIndex.keys()];
  for (const key of remoteIndex.keys()) if (!localIndex.has(key)) order.push(key);

  const merged: T[] = [];
  const conflicts: MergeConflict[] = [];
  const keptAgainstDelete: string[] = [];
  let mergePoints = 0;

  for (const key of order) {
    const l = localIndex.get(key);
    const r = remoteIndex.get(key);
    const a = ancestorIndex.get(key);
    const peers = [l, r, a].filter((item): item is T => item !== undefined);
    const identity = (item: T | undefined): string => (item === undefined ? '' : spec.identityOf(item, peers));
    const conflict = (reason: KeyedConflictReason): void => {
      conflicts.push({ path: spec.pathOf(key), kind: 'key', reason, autoMergeAttempted: false, local: l ?? null, remote: r ?? null, ancestor: a ?? null });
    };

    if (l !== undefined && spec.keepLocal?.(l) === true) {
      merged.push(l);
      if (identity(l) !== identity(r)) mergePoints += 1;
      continue;
    }
    if (l !== undefined && r !== undefined) {
      const [li, ri] = [identity(l), identity(r)];
      if (li === ri) { merged.push(l); continue; }
      if (a === undefined) { conflict('both-modified'); continue; }
      const ai = identity(a);
      if (li === ai) { merged.push(r); mergePoints += 1; continue; }
      if (ri === ai) { merged.push(l); mergePoints += 1; continue; }
      conflict('both-modified');
      continue;
    }
    if (l !== undefined) {
      if (a === undefined) { merged.push(l); mergePoints += 1; continue; } // 本机独有
      if (identity(l) !== identity(a)) { conflict('modify-delete'); continue; } // 本机改过 → 交人工
      if (spec.followDelete) { mergePoints += 1; continue; } // 跟随远端删除
      merged.push(l);
      keptAgainstDelete.push(key);
      continue;
    }
    if (r !== undefined) {
      if (a === undefined) { merged.push(r); mergePoints += 1; continue; } // 远端独有
      if (identity(r) !== identity(a)) { conflict('delete-modify'); continue; } // 本机删了、远端改过 → 交人工
      mergePoints += 1; // 远端未改，本机删过它 → 跟随本机删除
    }
  }
  return { merged, conflicts, mergePoints, keptAgainstDelete };
}
