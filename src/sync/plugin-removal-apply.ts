/**
 * issue #132：跟随远端删除插件的**编排层**（判据 → 卸载 → 告警 → undo 线索）。
 *
 * 为什么从 sync-engine 下沉：引擎已顶到文件体量棘轮（tests/file-size-ratchet.test.ts），
 * 而这部分只依赖「三方载荷 + 本机已装清单 + 卸载函数 + msg」，不碰引擎内部状态；
 * 独立成模块后可单独测，也不会把引擎继续堆高。判据本体仍留在 ./plugin-removals.ts（纯函数、零 IO）。
 *
 * 三条语义在此定型，改之前先读 issue #132 的裁决：
 *  1. 开关关闭 = **不删但也绝不装作没有候选**：逐项发 warning 说明「开着会删谁」；
 *  2. 卸载失败（含 desktop 保留档案被 CLI 拒）逐项进报告 + warning，不阻断其余项、不回滚整轮；
 *  3. undo 线索只写「真的删成功」的那些，写不进去只告警（报告里的 reinstallTarget 仍是人工兜底）。
 */
import { registerMessageCatalog } from '../core/engine-locale.ts';
import { pluginInstallTarget } from '../core/plugin-cli.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { SnapshotPluginRemoval } from '../core/types.ts';
import type { SectionData, SectionId } from '../schema/types.ts';
import { planPluginRemovals } from './plugin-removals.ts';
import type { PluginRemovalEntry, PluginRemovalPlan } from './plugin-removals.ts';

const zh = {
  'sync.pluginRemoveDone': '已跟随远端删除插件 {name}@{version}（可随时用 "{name}@{version}" 重装）',
  'sync.pluginRemoveFailed': '删除插件 {name} 失败：{reason}（其余项继续，失败项下一轮会重新判定）',
  'sync.pluginRemoveConflict': '插件 {name} 远端已删除，但本机改过（本机 {local}，共同祖先 {ancestor}）：未删除，请人工确认',
  'sync.pluginRemoveSkipped': '插件 {name} 在远端已删除，但"跟随删除插件"未开启：已保留（开启后会删除）',
  'sync.pluginRemoveUndoUnrecorded': '插件已经删除，但没能写进本次回滚快照的 undo 记录（{names}）：恢复这份快照不会自动装回它们，需要时请手动执行 dsh plugin add',
} as const;

const en: Record<keyof typeof zh, string> = {
  'sync.pluginRemoveDone': 'Removed plugin {name}@{version} to follow the remote (reinstall anytime with "{name}@{version}")',
  'sync.pluginRemoveFailed': 'Could not remove plugin {name}: {reason} (the remaining items continue; this one is re-evaluated next round)',
  'sync.pluginRemoveConflict': 'Plugin {name} was deleted remotely but changed locally (local {local}, common ancestor {ancestor}): not removed, needs a human decision',
  'sync.pluginRemoveSkipped': 'Plugin {name} was deleted remotely, but "delete plugins to follow the remote" is off: kept (it will be removed once enabled)',
  'sync.pluginRemoveUndoUnrecorded': 'The plugin(s) were removed, but the undo record could not be written into this rollback snapshot ({names}): restoring that snapshot will not reinstall them — run dsh plugin add manually if needed',
};

registerMessageCatalog({ id: 'sync-plugin-removal', zh, en });

/** 一条插件卸载结果（reinstallTarget 供 undo 与人工补装使用）。 */
export interface PluginRemovalReportItem {
  name: string;
  version: string;
  /** 重装目标：`name@version`（版本未知时退回裸包名） */
  reinstallTarget: string;
  ok: boolean;
  /** 失败原因（已由 CLI 分类器给出可操作文案）；ok=true 时缺省 */
  message?: string;
}

/** 预览侧的删除视图（确认页据此单列「将删除：X@1.2.3」，用户可整轮取消）。 */
export interface PluginRemovalPreviewView {
  pluginRemovals: { name: string; version: string }[];
  pluginRemovalConflicts: { name: string; ancestorVersion: string; localVersion: string }[];
  pluginRemovalSkipped: { name: string; reason: string }[];
}

/** 判据输入侧的「已装插件」最小形状（PluginInfo 与 PluginEntry 都能直接传）。 */
type InstalledPlugin = { name: string; version: string; enabled?: boolean; spec?: string; bundlesOnly?: boolean };

/**
 * 把某个分区载荷里的插件清单抽成判据要的形状（不认识 = undefined）。
 *
 * 为什么直接从「本轮合并的三方输入」读而不是再 export 一次：那三个载荷就是本轮合并的真实输入，
 * 再 export 会拿到「已经写了一半」的状态，判据与合并结论就会打架。
 */
export function pluginEntriesOf(data: SectionData | undefined): PluginRemovalEntry[] | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const obj = data as { version?: unknown; plugins?: unknown };
  if (obj.version !== 1 || !Array.isArray(obj.plugins)) return undefined;
  const out: PluginRemovalEntry[] = [];
  for (const raw of obj.plugins) {
    if (raw === null || typeof raw !== 'object') continue;
    const p = raw as { name?: unknown; version?: unknown; spec?: unknown; bundlesOnly?: unknown };
    if (typeof p.name !== 'string' || p.name === '') continue;
    out.push({
      name: p.name,
      version: typeof p.version === 'string' ? p.version : '',
      ...(typeof p.spec === 'string' ? { spec: p.spec } : {}),
      ...(p.bundlesOnly === true ? { bundlesOnly: true } : {}),
    });
  }
  return out;
}

/** 三方输入 + 本机已装 → 删除计划（预览与执行共用同一份判据）。 */
export function pluginRemovalPlanOf(args: {
  ancestor?: SectionData;
  remote?: SectionData;
  installed: readonly InstalledPlugin[];
  enabled: boolean;
  selfName?: string;
}): PluginRemovalPlan {
  return planPluginRemovals({
    enabled: args.enabled,
    ancestor: pluginEntriesOf(args.ancestor),
    remote: pluginEntriesOf(args.remote),
    local: args.installed,
    selfName: args.selfName ?? '',
  });
}

/**
 * 执行删除（逐项失败不阻断）。
 *
 * 为什么只在 plugins 分区真的被应用时才动：分区冲突/跳过 = 本轮还没确定「远端删了它」，
 * 此时删本机插件等于拿未裁决的远端差异动用户机器。
 */
export async function applyPluginRemovalStep(args: {
  appliedIds: readonly SectionId[];
  plan: PluginRemovalPlan | undefined;
  enabled: boolean;
  uninstall: (name: string) => Promise<unknown>;
  msg: MsgFunc;
}): Promise<{ removals: PluginRemovalReportItem[]; warnings: string[] }> {
  const removals: PluginRemovalReportItem[] = [];
  const warnings: string[] = [];
  if (!args.appliedIds.includes('plugins')) return { removals, warnings };
  const plan = args.plan;
  if (plan === undefined) return { removals, warnings };
  for (const c of plan.conflicts) {
    warnings.push(args.msg('sync.pluginRemoveConflict', {
      name: c.name, local: c.localVersion, ancestor: c.ancestorVersion,
    }));
  }
  if (!args.enabled) {
    // 开关关：把「打开后会删什么」如实说出来（不删，但也绝不装作没有候选）
    for (const k of plan.kept) {
      if (k.reason === 'switch-off') warnings.push(args.msg('sync.pluginRemoveSkipped', { name: k.name }));
    }
    return { removals, warnings };
  }
  for (const r of plan.removals) {
    // 重装目标与导入侧同一决策（core/plugin-cli.ts 的 pluginInstallTarget）：github:/git+/file:/link:
    // 这类来源只靠 name@version 装不回同一份代码，必须带祖先记录的 spec。
    const reinstallTarget = pluginInstallTarget(r.name, {
      ...(r.version === '' ? {} : { version: r.version }),
      ...(r.spec === undefined ? {} : { spec: r.spec }),
    });
    try {
      await args.uninstall(r.name);
      removals.push({ name: r.name, version: r.version, reinstallTarget, ok: true });
      warnings.push(args.msg('sync.pluginRemoveDone', { name: r.name, version: r.version }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      removals.push({ name: r.name, version: r.version, reinstallTarget, ok: false, message: reason });
      warnings.push(args.msg('sync.pluginRemoveFailed', { name: r.name, reason }));
    }
  }
  return { removals, warnings };
}

/**
 * 把「本轮删掉哪些插件」写进本次回滚快照（undo 线索）。
 *
 * 写不进去不中止同步（分区已落地且已重导出），但必须留一条可见告警 ——
 * 报告里的 reinstallTarget 仍可人工执行，静默丢失 undo 线索才是真问题。
 */
export async function recordPluginRemovalUndo(args: {
  removals: readonly PluginRemovalReportItem[];
  snapshotId: string;
  record?: (id: string, entries: SnapshotPluginRemoval[]) => Promise<void>;
  msg: MsgFunc;
}): Promise<string[]> {
  const removed = args.removals.filter((r) => r.ok);
  if (removed.length === 0) return [];
  const names = removed.map((r) => r.reinstallTarget).join(', ');
  const entries = removed.map((r) => ({ name: r.name, version: r.version, target: r.reinstallTarget }));
  if (args.record === undefined) return [args.msg('sync.pluginRemoveUndoUnrecorded', { names })];
  try {
    await args.record(args.snapshotId, entries);
    return [];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [args.msg('sync.pluginRemoveUndoUnrecorded', { names }), reason];
  }
}

/**
 * 预览侧的删除视图：确认页必须能单列「将删除：X@1.2.3」让用户整轮取消，
 * 也必须如实说明「开关关着，所以没删」与「远端删了但本机改过」两种不删的原因。
 *
 * plugins 分区本轮不可应用（conflict / skip）时不列删除项：那时「远端删了它」还没被用户确认。
 */
export function pluginRemovalPreviewOf(args: {
  plan: PluginRemovalPlan | undefined;
  sections: readonly { id: SectionId; decision: string }[];
}): PluginRemovalPreviewView | undefined {
  if (args.plan === undefined) return undefined;
  const section = args.sections.find((s) => s.id === 'plugins');
  const applied = section !== undefined && section.decision !== 'conflict' && section.decision !== 'skip';
  return {
    pluginRemovals: applied ? args.plan.removals.map((r) => ({ name: r.name, version: r.version })) : [],
    pluginRemovalConflicts: args.plan.conflicts.map((c) => ({
      name: c.name, ancestorVersion: c.ancestorVersion, localVersion: c.localVersion,
    })),
    pluginRemovalSkipped: args.plan.kept.map((k) => ({ name: k.name, reason: k.reason })),
  };
}
