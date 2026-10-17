/**
 * 徽章四态 → DSH 原生 Tag tone 的映射（**唯一一份**）。
 *
 * 为什么单独成模块：徽章现在优先渲染 DSH 自带的 `Tag`（@deepseek-ai/dsh-client-ui-primitives，
 * 与宿主同一颗组件），它只有 tone 语义、没有 kind 语义；映射关系是纯函数，放这里可被 node 单测覆盖，
 * 也让 React 壳保持「只装配」。老宿主拿不到原生包时回落本仓库的 `.badge[data-kind]` 样式，
 * 两条路径共用同一套 kind → tone 语义，不允许各自漂移。
 */

/** 插件侧的四态徽章语义。 */
export type BadgeKind = 'info' | 'ok' | 'warn' | 'error'

/** DSH 原生 Tag 的调色板选项（与其 .d.ts 逐字同形）。 */
export type DshTagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'

/** 四态 → 原生 tone（ok=success / warn=warning / error=danger / info=info）。 */
export const BADGE_TONE: Readonly<Record<BadgeKind, DshTagTone>> = {
  ok: 'success',
  info: 'info',
  warn: 'warning',
  error: 'danger',
}

/** 取某个四态对应的原生 tone；未知输入按 info 处理（调用方给的是字面量联合，此为防御）。 */
export function badgeTone(kind: BadgeKind): DshTagTone {
  return BADGE_TONE[kind] ?? 'info'
}
