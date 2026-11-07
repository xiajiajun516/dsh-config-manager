/**
 * issue #127：一键同步的临时 ZIP 装配 —— 只装 autoApply 的 merged 载荷，并在「应用了会话」时
 * **伴随**一份 workspaces 载荷。
 *
 * 为什么必须伴随：DSH 把会话显示在工作区里靠「首帧 cwd 的 realpath == workspace.path 且会话 id 在
 * 该记录的 sessionIds 里」，而这条挂接只在导入计划的 workspaces 分区有执行项时才会被
 * `finalizeImport` 触发（analyzer 对零计划项的 adapter 直接跳过）。所以「勾了会话、没勾工作区」
 * 的同步会把会话写进本机，却一条都不显示 —— 用户看到的正是 #127 的现象。
 *
 * 载荷口径：本地现值 ∪ 远端（或本次 merged）记录 —— 走 `mergeWorkspacesSection` 的记录级合并，
 * 于是本机既有工作区不会被覆盖、两侧各自的 sessionIds 都保住（并集）。冲突字段取本地值，
 * 与「不静默覆盖用户本机记录」一致。
 *
 * 边界：本实例没放行 workspaces（构造期 optInSections）或远端压根没有该分区 → 不带伴随载荷，
 * 不越权凭空造工作区。伴随失败**不阻断**主流程（宁可少挂会话，也不让整次同步失败）。
 */
import type { ConfigAdapter, HostContext } from '../core/types.ts';
import type { Platform, SectionData, SectionId } from '../schema/types.ts';
import { CURRENT_SCHEMA_VERSION } from '../schema/versions.ts';
import type { MergeSectionResult } from './merge.ts';
import type { ManifestSummary, SyncSnapshot } from './transport.ts';
import { mergeWorkspacesSection } from './workspace-merge.ts';

/** prepareApplyBundle 的入参：只取装配所需的事实，不把引擎实例漏进来（纯函数好测）。 */
export interface ApplyBundleInput {
  /** autoApply 的分区（本次真正要写本机的） */
  autoApply: readonly MergeSectionResult[];
  /** 本次 autoApply 的分区 id（返回值会补上伴随分区） */
  baseIds: readonly SectionId[];
  /** 本实例是否放行 workspaces（构造期 optInSections 派生） */
  pullAllowsWorkspaces: boolean;
  /** 计划里待裁决/跳过的项（取其中 merged 作为远端载荷的兜底） */
  planEntries: readonly MergeSectionResult[];
  /** 本次 merge() 记下的远端输入（缺省 = 退回 planEntries 里的 merged） */
  remote: SectionData | undefined;
  ancestor: SectionData | undefined;
  adapter: ConfigAdapter | undefined;
  ctx: HostContext;
  snapshotId: string;
  createdAt: string;
  dshVersion: string;
  platform: Platform;
  /** 远端快照的源机 home（'' = 未知，不写进 manifest，跨机重定基自然不发生） */
  sourceHome: string;
}

export interface ApplyBundle {
  /** 临时 ZIP 的 sectionIds（可能比 baseIds 多一个 workspaces） */
  sectionIds: SectionId[];
  /** 伴随的 workspaces 载荷（undefined = 本次不需要 / 拿不到） */
  companion: SectionData | undefined;
  tempSnapshot: SyncSnapshot;
}

export async function prepareApplyBundle(input: ApplyBundleInput): Promise<ApplyBundle> {
  let companion: SectionData | undefined;
  try {
    companion = await companionWorkspaces(input);
  } catch {
    companion = undefined;
  }
  const sectionIds: SectionId[] = companion === undefined ? [...input.baseIds] : [...input.baseIds, 'workspaces'];
  const sections: Record<string, SectionData> = {};
  for (const r of input.autoApply) {
    if (r.merged !== undefined) sections[r.id] = r.merged as SectionData;
  }
  if (companion !== undefined) sections.workspaces = companion;
  const manifest: ManifestSummary = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    dshVersion: input.dshVersion,
    platform: input.platform,
    sectionIds: [...sectionIds],
    containsSecrets: false,
    ...(input.sourceHome !== '' ? { sourceHome: input.sourceHome } : {}),
  };
  return {
    sectionIds,
    companion,
    tempSnapshot: {
      id: input.snapshotId,
      createdAt: input.createdAt,
      manifest,
      sections: sections as SyncSnapshot['sections'],
    },
  };
}

/** 会话落地时是否/如何带上工作区（口径见文件头；形状不认识就交回远端原样）。 */
async function companionWorkspaces(input: ApplyBundleInput): Promise<SectionData | undefined> {
  if (!input.baseIds.includes('sessions') || input.baseIds.includes('workspaces')) return undefined;
  if (!input.pullAllowsWorkspaces || input.adapter === undefined) return undefined;
  const planEntry = input.planEntries.find((r) => r.id === 'workspaces');
  const remote = input.remote ?? planEntry?.merged;
  if (remote === undefined) return undefined;
  let local: SectionData | undefined;
  try {
    local = (await input.adapter.export(input.ctx, { includeSecrets: false })).data as SectionData;
  } catch {
    local = undefined; // 读不到本机现值就只带远端（畸形载荷交给 analyzeImport/validate 如实报错）
  }
  if (local === undefined) return remote;
  const merged = mergeWorkspacesSection(local, remote, input.ancestor);
  return merged === undefined ? remote : merged.merged;
}
