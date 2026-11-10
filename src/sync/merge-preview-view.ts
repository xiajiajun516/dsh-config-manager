/**
 * 合并预览的**可渲染视图**（分区结果 → 界面结构），与「预览产物能否与基线比对」的判定。
 *
 * 为什么独立成文件：sync-engine 已顶到文件体量棘轮（tests/file-size-ratchet.test.ts），
 * 而这两件事都只依赖 merge.ts 的结果类型与预览文本工具，不碰引擎实例状态；放这里可单测，
 * 也让引擎只管编排。类型经 sync-engine 再导出，既有导入方（model-tools 等）无需改动。
 */
import { isLocalPluginSpec } from '../core/local-plugin-pack.ts';
import type { SectionData, SectionId } from '../schema/types.ts';
import type { MergeConflictReason, MergeSectionResult } from './merge.ts';
import { previewTextOf } from './merge-preview-text.ts';

/** plan 的单个分区结果 → 预览视图（三侧都只回传可读文本，绝不回传原始值）。 */
export function mergePreviewSectionView(result: MergeSectionResult): MergePreviewSectionView {
  const conflicts: MergePreviewConflictView[] = result.conflicts.map((c) => ({
    path: c.path,
    kind: c.kind,
    ...(c.reason !== undefined ? { reason: c.reason } : {}),
    localPreview: previewTextOf(c.local),
    remotePreview: previewTextOf(c.remote),
    ancestorPreview: previewTextOf(c.ancestor),
  }));
  return {
    id: result.id,
    decision: result.decision,
    ...(result.autoMerged !== undefined ? { autoMerged: result.autoMerged } : {}),
    conflictCount: result.conflicts.length,
    conflicts,
  };
}

/**
 * issue #91：走只读 `preview()` 拿到的产物，能否直接与该分区**基线 hash**（push 时按 export() 产物记录）比对。
 *
 * 为什么需要这个判定：`plugins` 适配器的 `preview()` 走 `collect(…, pack=false)` —— 刻意**不做**
 * 本地源（`link:` / `file:`）插件的 `npm pack`。于是当 profile 里存在本地源插件时，预览产物既没有
 * `localTarballs`、插件 spec 也保持原样（export() 会改写成 `file:<tarball>`），与基线**不同口径**：
 * 此时既不能断言「无变化」（本地插件源码改了体积/内容，预览看不见），也不该为了比对去打包
 * （那正是本 issue 的缺陷本身）。
 *
 * 返回 true = 该分区本趟**不可比** ⇒ 调用方只能保守报「有变化」并如实说明原因。
 * 其余分区的 preview() 产物与 export() 逐字节相同（文件类分区不走 preview()，见 previewPush）。
 */
export function previewCaliberDiffersFromExport(sectionId: SectionId, data: SectionData): boolean {
  if (sectionId !== 'plugins') return false;
  const plugins = (data as { plugins?: { spec?: string }[] }).plugins;
  return Array.isArray(plugins) && plugins.some((p) => isLocalPluginSpec(p?.spec));
}

/** previewMerge 的单条冲突视图（三侧文本都已截断 + redact；绝不回传原始值对象）。 */
export interface MergePreviewConflictView {
  /** 冲突位置：JSON 分区是 top-level key；文件类分区是 relativePath；'$' = 整分区冲突。 */
  path: string;
  kind: 'key' | 'file';
  /** 冲突成因（可选：旧数据/旧 merge 结果没有该字段，界面缺省按 'both-modified' 措辞）。 */
  reason?: MergeConflictReason;
  /** 本机侧的可读预览（≤ 2 KiB，超出截断加省略号；已过 redact()）。 */
  localPreview: string;
  /** 远端侧的可读预览（同上）。 */
  remotePreview: string;
  /** 共同祖先侧的可读预览（同上；无祖先时为空串）。 */
  ancestorPreview: string;
}

/** previewMerge 的单个分区视图。 */
export interface MergePreviewSectionView {
  id: SectionId;
  decision: MergeSectionResult['decision'];
  /** 自动合并并入的变更点数量（仅 decision === 'merge' 时有意义；缺省 = 未统计）。 */
  autoMerged?: number;
  conflictCount: number;
  conflicts: MergePreviewConflictView[];
}

/** previewMerge 结果（只读、零写入）。 */
export interface MergePreview {
  /** 预览是否成功产出（远端无快照 → false + message，分区清单为空）。 */
  ok: boolean;
  /** 本次预览针对的**远端**快照 id；'' = 远端无快照。 */
  snapshotId: string;
  /** 是否拿到了本地祖先副本（false = 退化为两方合并 → 所有双侧差异都会呈现为 conflict）。 */
  hasAncestor: boolean;
  sections: MergePreviewSectionView[];
  /** 与 risk.ts 的 classifyMergePlan 同口径计数：auto = 可自动应用，review = 需人工，conflicts = 冲突，skipped = 跳过。 */
  summary: { auto: number; review: number; conflicts: number; skipped: number };
  message?: string;
  reason?: 'remote-empty'; // 远端没有任何快照：首次同步的正常起点，不是故障（客户端据此给「先推送」引导，issue 116）
  /**
   * 本轮合并**将卸载**的插件（issue #132）：确认页必须单列出来，用户据此可以整轮取消。
   * 仅在 plugins 分区可应用（useRemote/keepLocal/merge）时才有条目 —— 分区冲突时不删。
   */
  pluginRemovals?: { name: string; version: string }[];
  /** 远端删了、本机却改过 → 不删，等人工裁决（与 conflict 清单同语义，这里为插件专列） */
  pluginRemovalConflicts?: { name: string; ancestorVersion: string; localVersion: string }[];
  /** 考察过但没删的条目及原因（含开关关闭 = 'switch-off'，界面据此如实说明） */
  pluginRemovalSkipped?: { name: string; reason: string }[];
}
