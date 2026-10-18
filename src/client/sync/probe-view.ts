/**
 * 连通性自检结果的**展示投影**（React 无关、可单测）。
 *
 * 为什么单独抽出来：/sync/probe 的渲染规则必须能被逐条证明 ——
 *  1. ok:false 是**预期结论**（诊断动作），必须与「传输层异常」走不同通道展示；
 *  2. hint 是「需要注意但没失败」→ warn 级，不和成功文案混成一句；
 *  3. createdCollections 是**唯一可能写远端**的事实 → 必须逐条列出，绝不静默；
 *  4. **「该通道不提供自检」是能力边界、不是故障** → 中性 info，绝不渲染成「操作失败」。
 *
 * 组件只消费本投影；规则变更只需改这里 + 改测试。
 */
import type { SyncProbeResult } from './sync-api.ts'

/**
 * 投影结果：tone = 横幅语义（与 common/ui 的 Banner 四态同值域）。
 *
 * info 是**中性态**：专用于「该通道不提供自检」（传输层未实现 probe）。
 * 必须与 error（真的没连通）分开 —— 真机反馈过：git 通道点「测试连接」被渲染成红色
 * 「操作失败」，把「没有这项能力」说成了「出故障」。
 */
export interface ProbeView {
  tone: 'ok' | 'warn' | 'info' | 'error'
  /** 主结论（成功时 = 宿主本地化好的 message；失败/不支持时 = 宿主本地化好的 error） */
  message: string
  /** 该通道不提供连通性自检（能力边界；true 时组件用中性 Banner，绝不显示「操作失败」） */
  unsupported: boolean
  /** 附加提醒（仅成功且宿主给了 hint 时出现）→ warn 级展示 */
  hint?: string
  /** 自检过程中自动创建的远端目录（逐条展示；空数组 = 没写远端） */
  createdCollections: string[]
  /** 远端现有快照数（仅在成功且宿主回传时出现） */
  snapshotCount?: number
}

/**
 * 结果 → 展示投影。
 *
 * fallbackUnsupportedMessage：宿主没给 error 文案时的**本地化兜底**（调用方传 t(...)）——
 * 本模块零依赖、不碰字典，文案只在调用点解析（「语言在取文案那一刻解析」的硬规则）。
 */
export function projectProbeResult(result: SyncProbeResult, fallbackUnsupportedMessage = ''): ProbeView {
  if (!result.ok) {
    // 能力边界优先于失败判定：unsupported=true 一律走中性分支，绝不落进 error
    if (result.unsupported === true) {
      return {
        tone: 'info',
        message: result.error !== '' ? result.error : fallbackUnsupportedMessage,
        unsupported: true,
        createdCollections: [],
      }
    }
    return { tone: 'error', message: result.error, unsupported: false, createdCollections: [] }
  }
  const created = (result.createdCollections ?? []).filter((c) => c !== '')
  return {
    tone: created.length > 0 || (result.hint !== undefined && result.hint !== '') ? 'warn' : 'ok',
    message: result.message,
    unsupported: false,
    ...(result.hint !== undefined && result.hint !== '' ? { hint: result.hint } : {}),
    createdCollections: created,
    ...(result.snapshotCount !== undefined ? { snapshotCount: result.snapshotCount } : {}),
  }
}
