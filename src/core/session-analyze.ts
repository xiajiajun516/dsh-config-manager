/**
 * 分析期的会话体检：格式版本探针、逐条比对、计划项标记 —— 从 analyzer.ts 下沉。
 *
 * 为什么独立成模块：analyzer 越过体量棘轮（tests/file-size-ratchet.test.ts），而这些函数的
 * 依赖全部由入参给出（探针、适配器表、文案函数、本机支持版本），搬出来不改变任何调用点的
 * 语义，也不新增对外契约。**判定口径仍只有一处**：纯比对算法在 core/session-compare.ts。
 */
import type { SectionId } from '../schema/types.ts';
import { attachmentIdOfRelPath } from '../utils/attachment-refs.ts';
import { sessionUnitLookup } from './import-planning.ts';
import type { MsgFunc } from './messages.ts';
import { overwriteExposure } from './session-compare.ts';
import type {
  ConfigAdapter, HostContext, PlanItem, SessionCompareRow, SessionCompareSummary, SessionFormatProbeResult,
} from './types.ts';

/** 会话格式体检的「已落定」结果（探针 + 本机支持版本；不可判定时整体缺省）。 */
export interface ResolvedSessionFormats {
  target: number;
  unreadable: { unitId: string; version: number }[];
  /** 本次体检真正看过的会话条数（解出 header 的 + 解不出的） */
  examined: number;
  /** 因抽样上限未检查的会话条数 */
  skipped: number;
}

/**
 * 会话格式体检（探针注入：core 不解析会话格式）。
 *
 * 「包里的版本 > 本机支持的版本」告警；本机版本解析不到时**不猜**（宁可不报，也不谎报兼容）。
 * 不可判定（无探针 / 无 sessions / 本机版本解析不到 / 探针抛错）一律返回 null。
 */
export function resolveSessionFormats(
  sections: Map<SectionId, unknown>,
  probe: ((files: readonly { relativePath: string; data: Uint8Array }[]) => SessionFormatProbeResult) | undefined,
  target: number | undefined,
): ResolvedSessionFormats | null {
  if (probe === undefined || !sections.has('sessions')) return null;
  if (target === undefined) return null;
  const rows = (sections.get('sessions') as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(rows)) return null;
  const files: { relativePath: string; data: Uint8Array }[] = [];
  for (const row of rows) {
    const item = row as { relativePath?: unknown; data?: unknown };
    if (typeof item.relativePath === 'string' && item.data instanceof Uint8Array) {
      files.push({ relativePath: item.relativePath, data: item.data });
    }
  }
  try {
    const probed = probe(files);
    // 只有明确「版本更高」才算读不了；units 缺省（旧探针实现）时退化为空数组（不猜单元）。
    return {
      target,
      unreadable: (probed.units ?? []).filter((unit) => unit.version > target),
      examined: probed.sampled + probed.unreadable,
      skipped: probed.skipped,
    };
  } catch {
    // 体检失败绝不拖垮分析，也绝不因此宣称兼容（本条静默，另有导出报告可核对）。
    return null;
  }
}

export function sessionFormatWarnings(result: ResolvedSessionFormats | null, msg: MsgFunc): string[] {
  if (result === null) return [];
  const target = result.target;
  const newer = result.unreadable.map((unit) => unit.version);
  if (newer.length === 0) return [];
  const warnings = [msg('import.sessionsFormatUnsupported', {
    count: String(newer.length),
    newer: String(Math.max(...newer)),
    target: String(target),
  })];
  if (result.skipped > 0) {
    warnings.push(msg('import.sessionsFormatSampled', {
      sampled: String(result.examined),
      skipped: String(result.skipped),
    }));
  }
  return warnings;
}

/**
 * 会话逐条比对（包内同名会话 vs **本机**）—— 与格式体检一样**每份归档只跑一次**。
 *
 * 为什么由 sessions adapter 执行而不是这里：解会话日志要用 zstd 帧与首帧能力，那是会话字节
 * 工具（core 不 import 它）；纯比对算法在 core/session-compare.ts。此处只负责「找到适配器、
 * 调一次、再补上附件缺口」。
 *
 * 附件缺口是**纯包内判定**（包内会话引用到的 id ∩ 包内实际带上的附件对象），因此不读本机、
 * 也不会因为本机文件被用户删了而误报：它回答的是「按这个包恢复，哪些图会缺」。
 */
export async function resolveSessionCompare(
  sections: Map<SectionId, unknown>,
  adapters: readonly ConfigAdapter[],
  ctx: HostContext,
): Promise<SessionCompareSummary | null> {
  if (!sections.has('sessions')) return null;
  const data = sections.get('sessions') as { files?: unknown } | undefined;
  if (data === undefined || !Array.isArray(data.files) || data.files.length === 0) return null;
  const adapter = adapters.find(
    (candidate) => candidate.id === 'sessions' && typeof candidate.compareSessions === 'function',
  );
  if (adapter?.compareSessions === undefined) return null;
  let summary: SessionCompareSummary | null;
  try {
    summary = await adapter.compareSessions(ctx, data as never);
  } catch {
    // 比对失败绝不拖垮分析，也绝不因此宣称「无差异」（本条静默）
    return null;
  }
  if (summary === null) return null;
  const present = new Set<string>();
  const attachments = sections.get('attachments') as { files?: unknown } | undefined;
  if (attachments !== undefined && Array.isArray(attachments.files)) {
    for (const row of attachments.files) {
      const rel = (row as { relativePath?: unknown }).relativePath;
      if (typeof rel !== 'string') continue;
      const id = attachmentIdOfRelPath(rel);
      if (id !== null) present.add(id);
    }
  }
  const missing = summary.attachmentsMissing.filter((id) => !present.has(id));
  return { ...summary, attachmentsMissing: missing };
}

/**
 * 逐条比对的告警（只在**真会丢东西**时说话）：
 *  - 本机比包内多内容 → 「导入会覆盖掉本机 N 条消息」（这是本功能存在的理由）；
 *  - 引用了包内没有的附件 → 恢复后图会缺；
 *  - 预算截断 → 「另有 N 条未比对」（绝不让用户以为全都比过了）。
 */
export function sessionCompareWarnings(result: SessionCompareSummary | null, msg: MsgFunc): string[] {
  if (result === null) return [];
  const warnings: string[] = [];
  const exposure = overwriteExposure(result.rows);
  if (exposure.units > 0) {
    warnings.push(msg('import.sessionOverwrite', {
      units: String(exposure.units),
      events: String(exposure.events),
      total: String(result.rows.length),
    }));
  }
  if (result.attachmentsMissing.length > 0) {
    warnings.push(msg('import.sessionAttachmentsMissing', {
      count: String(result.attachmentsMissing.length),
      ids: result.attachmentsMissing.slice(0, 3).map((id) => id.slice(0, 19)).join(', '),
    }));
  }
  if (result.skipped > 0) {
    warnings.push(msg('import.sessionCompareSampled', {
      sampled: String(result.rows.length),
      skipped: String(result.skipped),
    }));
  }
  return warnings;
}

/**
 * P3 的落点：把逐条比对结论标到**具体计划项**上（与格式标记同一个键空间对齐问题）。
 *
 * 标记是纯附加字段：不改 kind、不拦执行 —— 它只回答「这条导入会覆盖掉本机多少新内容」，
 * 决策仍归用户（本插件的导入是「以包为准」，没有只追加模式，所以这里的价值是让覆盖可见）。
 */
export function markSessionVerdicts(planItems: readonly PlanItem[], rows: readonly SessionCompareRow[]): void {
  if (rows.length === 0) return;
  const byUnit = new Map(rows.map((row) => [row.unitId, row]));
  for (const item of planItems) {
    const row = sessionUnitLookup(byUnit, item.unitId ?? item.id);
    if (row === undefined) continue;
    item.sessionVerdict = {
      verdict: row.verdict,
      packEvents: row.packEvents,
      localEvents: row.localEvents,
      ...(row.localAheadBy === undefined ? {} : { localAheadBy: row.localAheadBy }),
      ...(row.packAheadBy === undefined ? {} : { packAheadBy: row.packAheadBy }),
    };
    if (row.verdict === 'localAhead' || row.verdict === 'diverged') item.severity = 'warning';
  }
}
