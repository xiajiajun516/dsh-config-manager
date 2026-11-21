/**
 * P3 的落点：把逐条比对结论标到**具体计划项**上（键空间对齐见 import-planning 的 sessionUnitLookup）。
 *
 * 为什么独立于 session-analyze：那是「分析期」（读包、解码、算差异），这里是「计划期」
 * （只读 planItems、只写展示字段），职责不同、测试面也不同。
 *
 * 标记是纯附加字段：不改 kind、不拦执行 —— 它只回答「这条导入会覆盖掉本机多少新内容」，
 * 决策仍归用户（本插件的导入是「以包为准」，没有只追加模式）。
 */
import { sessionUnitLookup } from './import-planning.ts';
import type { PlanItem, SessionCompareRow } from './types.ts';

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
    // 只降显示级别，绝不复原已被阻断的项：SEC-05 在 analyzeBundle 期已把表外条目设成
    // severity:'error' + kind:'Error'，无条件覆盖会把「为什么不导」的红色警示降成普通警告。
    if ((row.verdict === 'localAhead' || row.verdict === 'diverged') && item.kind !== 'Error') {
      item.severity = 'warning';
    }
  }
}
