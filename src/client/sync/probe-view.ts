/**
 * 连通性自检结果的**展示投影**（React 无关、可单测）。
 *
 * 为什么单独抽出来：\`/sync/probe\` 的渲染规则必须能被逐条证明 ——
 *  1. \`ok:false\` 是**预期结论**（诊断动作），必须与「传输层异常」走不同通道展示；
 *  2. \`hint\` 是「需要注意但没失败」→ warn 级，不和成功文案混成一句；
 *  3. \`createdCollections\` 是**唯一可能写远端**的事实 → 必须逐条列出，绝不静默。
 * 组件只消费本投影，规则变更只需改这里 + 改测试。
 */
import type { SyncProbeResult } from './sync-api.ts'

/** 投影结果：tone = 徽章/横幅语义（与 common/ui 的 Banner 四态同值域）。 */
export interface ProbeView {
  tone: 'ok' | 'warn' | 'error'
  /** 主结论（成功时 = 宿主本地化好的 message；失败时 = 宿主本地化好的 error） */
  message: string
  /** 附加提醒（仅成功且宿主给了 hint 时出现）→ warn 级展示 */
  hint?: string
  /** 自检过程中自动创建的远端目录（逐条展示；空数组 = 没写远端） */
  createdCollections: string[]
  /** 远端现有快照数（仅在成功且宿主回传时出现） */
  snapshotCount?: number
}

export function projectProbeResult(result: SyncProbeResult): ProbeView {
  if (!result.ok) {
    return { tone: 'error', message: result.error, createdCollections: [] }
  }
  const created = (result.createdCollections ?? []).filter((c) => c !== '')
  return {
    tone: created.length > 0 || (result.hint !== undefined && result.hint !== '') ? 'warn' : 'ok',
    message: result.message,
    ...(result.hint !== undefined && result.hint !== '' ? { hint: result.hint } : {}),
    createdCollections: created,
    ...(result.snapshotCount !== undefined ? { snapshotCount: result.snapshotCount } : {}),
  }
}
