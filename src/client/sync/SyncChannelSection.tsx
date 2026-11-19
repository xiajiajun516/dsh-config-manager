/**
 * 同步页「通道区」：已配置通道卡 + 末尾「添加通道」行，与首屏骨架**二选一**。
 *
 * 拆出来只为两件事：① 真实内容与骨架的分支判断只写一处；② SyncPanel 的体量棘轮
 * （tests/file-size-ratchet.test.ts）要求新增逻辑下沉到独立模块，而不是继续往上堆。
 * 骨架形状由 src/ui 的 syncChannelSkeletonPlan 决定（与真实渲染同一条就绪判据）。
 */
import type { ReactNode } from 'react'
import type { SyncChannelSkeletonPlan } from '../../ui/sync-settings-view.ts'
import { SyncChannelSkeleton } from './SyncChannelSkeleton.tsx'

/**
 * skeleton 非 null = 首次加载窗口：只铺骨架（真实内容还在路上，插进来就会抖）。
 * children 是调用方渲染好的通道卡（卡是渲染函数、依赖 sync 状态，不便搬进来）。
 */
export function SyncChannelSection({ skeleton, label, children }: {
  skeleton: SyncChannelSkeletonPlan | null
  label: string
  children: ReactNode
}) {
  if (skeleton !== null) return <SyncChannelSkeleton plan={skeleton} label={label} />
  return <>{children}</>
}
