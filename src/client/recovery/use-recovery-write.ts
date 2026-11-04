/**
 * 恢复面板「进行中的短写盘动作」—— 统一登记点（tech-debt #7）。
 *
 * 为什么单独一个文件：面板拆成 4 个文件后，体检卡 / 体检弹窗 / 布局归位 / 主面板都要读写同一份
 * 进行中态。state 的归属方是 `run-store.ts` 的 `recovery.write` 切片（内存瞬态、不落盘），
 * 这里只放三样东西：订阅 hook、动作 key 常量表、统一的登记/清除包装。
 */
import { useSyncExternalStore } from 'react'
import { runStore } from '../run-store.ts'

/**
 * 动作 key 表：一个动作一个**稳定字符串**（切页 / 重挂后按键判定同一条，不能带随机成分）。
 * 单条会话修复用 unitId 派生 —— 它是会话库给的稳定 id，不是渲染序号。
 */
export const WRITE_KEY = {
  /** 单条会话修复的「预览 → 应用」 */
  sessionRepair: (unitId: string): string => `session-repair:${unitId}`,
  /** 一键修复：整批只占一个槽（取舍见 SessionHealthDialog 头注释） */
  sessionRepairAll: 'session-repair-all',
  sessionLayoutPreview: 'session-layout:preview',
  sessionLayoutApply: 'session-layout:apply',
  safeModeClear: 'safe-mode-clear',
  lockRecover: 'lock-recover',
  rescueOn: 'rescue:on',
  rescueOff: 'rescue:off',
} as const

/** 选择器必须是模块级常量（引用稳定，subscribe 才能跳过无变化的重渲染）。 */
const selectWriteKey = (): string | null => runStore.getSnapshot().recovery.write?.key ?? null

/**
 * 订阅「当前进行中的写盘动作 key」。
 *
 * 读的是模块级单例 ⇒ 切 tab 卸载再挂载，读回的还是同一个动作 —— 这正是 tech-debt #7 的诉求
 * （「切页丢视图、用户不知道还在写」）。刷新则一律回 null（该字段不进 `toPersistedState` 白名单）。
 */
export function useRecoveryWriteKey(): string | null {
  return useSyncExternalStore(runStore.subscribe, selectWriteKey)
}

/**
 * 登记 → 执行 → 清除。**所有**短写盘动作都走这里，别在组件里手写 begin/end：
 * 漏掉一次 end 就是一个永远不结束的进行中态（按钮永久禁用），比不登记更糟。
 * `finally` 保证抛错也清除；`endRecoveryWrite` 的 key 校验保证晚到的清除不抹掉后一个动作。
 */
export async function withRecoveryWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  runStore.beginRecoveryWrite(key)
  try {
    return await task()
  } finally {
    runStore.endRecoveryWrite(key)
  }
}
