/**
 * Star 引导弹窗的判定逻辑（框架无关纯函数，node 可测）。
 *
 * 触发规则（用户需求 + 方案 A）：
 *  - 首次进入 dsh-config-manager 页面：只记录「首次使用时间」，不弹窗；
 *  - 之后每次进入页面：距首次使用满 3 天（STAR_PROMPT_DELAY_MS）才弹窗；
 *  - 用户点过「不再提示」（dismissed）或点过「去点 Star」（clicked，方案 A：
 *    引导完成）→ 永久不再弹。
 *
 * 本模块只做「判定」，不碰存储/网络/React：
 *  - 存储（ui-prefs.json）见 src/sync/ui-prefs.ts；
 *  - 组件装配（何时调用、如何展示）见 src/client/ConfigManagerSection.tsx。
 */

/** 距首次使用满 3 天才提示（ms）：3 天 × 24 小时 × 60 分 × 60 秒 × 1000 */
export const STAR_PROMPT_DELAY_MS = 3 * 24 * 60 * 60 * 1000

/** Star 引导弹窗的持久化状态（来自 ui-prefs.json；全部可选）。 */
export interface StarPromptState {
  /** 首次进入页面时间（ms 时间戳）；undefined = 尚未进入过页面 */
  firstSeenAt?: number
  /** 用户点过「不再提示」 */
  dismissed?: boolean
  /** 用户点过「去点 Star」（方案 A：引导完成） */
  clicked?: boolean
}

/** 判定结果：是否弹窗 + 是否需要补记首次使用时间。 */
export interface StarPromptEvaluation {
  /** 本次进入页面是否展示弹窗 */
  shouldShow: boolean
  /** 是否需要在存储里补记首次使用时间（首次进入时 true，写入后下次再判） */
  shouldRecordFirstSeen: boolean
}

/**
 * 判定本次进入页面是否展示 Star 引导弹窗。
 * @param state 持久化状态（undefined 字段 = 未配置）
 * @param now 当前时间（ms 时间戳；注入便于测试）
 */
export function evaluateStarPrompt(state: StarPromptState, now: number): StarPromptEvaluation {
  // 已表态（不再提示 / 点过 Star）：永久不再弹
  if (state.dismissed === true || state.clicked === true) {
    return { shouldShow: false, shouldRecordFirstSeen: false }
  }
  // 首次进入：只记时间，不弹（等满 3 天后的下一次进入）
  if (state.firstSeenAt === undefined) {
    return { shouldShow: false, shouldRecordFirstSeen: true }
  }
  // 距首次使用满 3 天 → 弹窗
  return {
    shouldShow: now - state.firstSeenAt >= STAR_PROMPT_DELAY_MS,
    shouldRecordFirstSeen: false,
  }
}
