/**
 * 会话逐条比对（P3）的显性事实层 —— 框架无关、node 可测。
 *
 * 为什么需要一层：导入是以包为准的**恢复**（replace），不是追加合并（K1：双机日常同步
 * 走同步通道）。于是「本机这条对话在导出之后又聊了 40 轮」这件事，用户必须在按下
 * 「确认导入」前看见 —— 而且必须看见**数字**，不是一句「可能有差异」。
 *
 * 三条纪律：
 *  - 缺省 ≠ 一致：没有 `sessionCompare`（旧包 / 没选会话分区 / 适配器不提供）时返回 null，
 *    调用方不得把 null 渲染成「全部一致」；
 *  - 只报可判定的量：compared / 五态计数 / 会覆盖的条数 / 包内缺的附件 —— 全部来自
 *    `core/session-compare.ts` 的纯函数，这里不重新判定；
 *  - 文案键在 locale 字典里（本模块只给键名），组件不拼自然语言。
 */
import type { ImportAnalysis, PlanItem, SessionVerdict } from '../core/types.ts'
import { countSessionVerdicts, overwriteExposure } from '../core/session-compare.ts'

/** 展示用五态（`new` 在文案里叫「本机没有」，键名统一用 fresh 以免与 JS 关键字混淆）。 */
export type SessionCompareDisplayVerdict = 'identical' | 'packAhead' | 'localAhead' | 'diverged' | 'fresh' | 'unreadable'

export interface SessionCompareFacts {
  /** 真正比对过的会话条数（不含 skipped） */
  compared: number
  /** 因预算未比对的条数（>0 时必须说出来：未比对不代表一致） */
  skipped: number
  counts: Record<SessionCompareDisplayVerdict, number>
  /** 导入会覆盖掉的本机内容（localAhead + diverged 两类之和） */
  overwrite: { units: number; events: number }
  /** 包内会话引用到的附件数（0 = 这些会话没有附件） */
  attachmentsReferenced: number
  /** 被引用但**包内没有**的附件 id（恢复后会缺图） */
  attachmentsMissing: string[]
  /** 有内容会丢（覆盖或附件缺失）—— 只有它为真时确认页才需要那条红字 */
  lossy: boolean
}

const ZERO_COUNTS: Record<SessionCompareDisplayVerdict, number> = {
  identical: 0, packAhead: 0, localAhead: 0, diverged: 0, fresh: 0, unreadable: 0,
}

function countsOf(rows: readonly { verdict: SessionVerdict }[]): Record<SessionCompareDisplayVerdict, number> {
  const raw = countSessionVerdicts(rows as never)
  const out = { ...ZERO_COUNTS }
  out.identical = raw.identical
  out.packAhead = raw.packAhead
  out.localAhead = raw.localAhead
  out.diverged = raw.diverged
  out.fresh = raw.new
  out.unreadable = raw.unreadable
  return out
}

/** 分析结果 → 事实；没有比对结果（旧包 / 未选会话）时返回 null。 */
export function sessionCompareFactsFromAnalysis(
  analysis: Pick<ImportAnalysis, 'sessionCompare'> | null | undefined,
): SessionCompareFacts | null {
  const compare = analysis?.sessionCompare
  if (compare === undefined || compare === null) return null
  const rows = compare.rows ?? []
  const overwrite = overwriteExposure(rows)
  const missing = compare.attachmentsMissing ?? []
  return {
    compared: rows.length,
    skipped: compare.skipped ?? 0,
    counts: countsOf(rows),
    overwrite,
    attachmentsReferenced: compare.attachmentsReferenced ?? 0,
    attachmentsMissing: missing,
    lossy: overwrite.units > 0 || missing.length > 0,
  }
}

/**
 * 计划项 → 事实（`/plan` 之后只有计划、没有分析时的同一口径）。
 *
 * 只看带 `sessionVerdict` 的项：没有该字段说明这一项没参与比对（不是「一致」）。
 */
export function sessionCompareFactsFromPlan(items: readonly PlanItem[]): SessionCompareFacts | null {
  const rows = items
    .filter((item) => item.sessionVerdict !== undefined)
    .map((item) => ({
      unitId: item.unitId ?? item.id,
      verdict: item.sessionVerdict!.verdict,
      packEvents: item.sessionVerdict!.packEvents,
      localEvents: item.sessionVerdict!.localEvents,
      ...(item.sessionVerdict!.localAheadBy === undefined ? {} : { localAheadBy: item.sessionVerdict!.localAheadBy }),
      ...(item.sessionVerdict!.packAheadBy === undefined ? {} : { packAheadBy: item.sessionVerdict!.packAheadBy }),
    }))
  if (rows.length === 0) return null
  const overwrite = overwriteExposure(rows)
  return {
    compared: rows.length,
    skipped: 0,
    counts: countsOf(rows),
    overwrite,
    attachmentsReferenced: 0,
    attachmentsMissing: [],
    lossy: overwrite.units > 0,
  }
}

/** 五态 → 字典键（组件只做 key → 文案，禁渲染裸枚举，见 AGENTS.md「兼容性评分」条）。 */
export function sessionCompareVerdictKey(verdict: SessionCompareDisplayVerdict): string {
  return `import.sessionCompare.verdict.${verdict}`
}

/** 逐条明细里「必须让用户看见」的那些行（覆盖/分叉/读不出），按严重度排。 */
export function sessionCompareAttentionRows(
  analysis: Pick<ImportAnalysis, 'sessionCompare'> | null | undefined,
): { unitId: string; verdict: SessionCompareDisplayVerdict; localAheadBy: number }[] {
  const rows = analysis?.sessionCompare?.rows ?? []
  const out: { unitId: string; verdict: SessionCompareDisplayVerdict; localAheadBy: number }[] = []
  for (const row of rows) {
    if (row.verdict !== 'localAhead' && row.verdict !== 'diverged') continue
    out.push({
      unitId: row.unitId,
      verdict: row.verdict,
      localAheadBy: row.localAheadBy ?? 0,
    })
  }
  return out.sort((a, b) => b.localAheadBy - a.localAheadBy)
}
