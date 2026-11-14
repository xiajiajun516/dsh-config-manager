/**
 * 冲突决策的**单点**实现（导入计划使用；恢复/回放路径历史上共用同一份语义）。
 *
 * 为什么独立成模块：这段逻辑原先私有在 `core/analyzer.ts` 里。灾备的撤销/重做回放
 * （`core/config-snapshot.ts`，已随灾备快照线下线）需要同一条决策链 —— 「把快照内容
 * 写回目标」，但它**不能**反向 import analyzer（那是导入管线的重模块，反向引用成环，
 * 也把两件事耦在一起）。抽成零依赖纯函数模块后，两条路径共用同一份语义，历史上出现过的
 * 「导入是 skip、回放却 applyItem」这类双语义无法再出现；回放侧删除后，本模块仍是导入
 * 计划（analyzer）的决策实现与回归基线。
 *
 * 纯函数：不读盘、不写盘、不碰 adapter。
 */
import type { MsgFunc } from './messages.ts';
import type { ImportDecisions, PlanItem } from './types.ts';

/** 应用用户冲突决策 + 全局策略（纯函数，返回新数组）。语义与导入路径逐条一致。 */
export function applyItemResolution(item: PlanItem, decisions: ImportDecisions, msg: MsgFunc): PlanItem {
  if (item.kind !== 'Conflict') return item;
  const resolution = decisions.resolutions[item.id];
  if (resolution === 'keepCurrent') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictKeepCurrent')}` };
  }
  if (resolution === 'useImported') {
    // decidedBy: 'item' —— 来源是用户对该计划项的逐项决策（写回守卫据此允许清空被剥空叶子）
    return { ...item, kind: 'Update', severity: 'info', conflict: { itemId: item.id, resolution, decidedBy: 'item' } };
  }
  // review / 未决策：按全局策略兜底
  if (decisions.strategy === 'skipExisting') {
    return { ...item, kind: 'Skip', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictSkipExisting')}` };
  }
  if (decisions.strategy === 'replace') {
    return { ...item, kind: 'Update', severity: 'info', detail: `${item.detail ?? ''}${msg('import.conflictReplace')}` };
  }
  return item; // merge + 未决策 → 保持 Conflict，由报告列明
}
