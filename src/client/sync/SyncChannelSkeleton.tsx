/**
 * 远程同步页「通道区」首屏骨架（2026-11-19 用户要求：骨架必须是**真实尺寸**的填充符，
 * 数据到货后页面不抖）。
 *
 * 做法：不另造第二套视觉 —— 骨架**复用真实渲染的容器类**（.card / .cardTitleRow /
 * .statRow / .factGrid / .actionRowTop / .syncChannelBody / .sectionPickerRow /
 * .snapshotPickerRow / .addChannelCard），只把文字与控件换成等高的 .skeletonBar。
 * 于是盒模型（内边距 / 行距 / 间隙 / 按钮高度）与真实卡逐项一致，换装时高度不变。
 *
 * 形状（铺几张卡、哪张带展开体、有没有「添加通道」行）由 ui 层纯函数
 * syncChannelSkeletonPlan 决定 —— 与真实渲染共用同一条 channelRemoteReady 判据。
 *
 * 无障碍沿用 common/Skeleton.tsx 的约定：外框 role="status" + aria-busy + aria-label，
 * 视觉块 aria-hidden，**绝不渲染可见的「加载中」文案**（skeleton-guard.test.ts 钉住）。
 * 同理不用 SkeletonRoot：它的 flex + gap 会破坏通道卡的盒模型。
 */
import type { SyncChannelSkeletonPlan } from '../../ui/sync-settings-view.ts'
import { Card } from '../common/ui.tsx'
import css from '../config-manager.module.css'

/**
 * 通道区骨架：N 张「已配置」通道卡（其中一张带展开体）+ 可选的「添加通道」行。
 * label 是给读屏器的整块说明（调用方传 t('common.loading')）。
 */
export function SyncChannelSkeleton({ plan, label }: { plan: SyncChannelSkeletonPlan; label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label}>
      <div aria-hidden="true">
        {plan.cards.map((channel) => (
          <ChannelCardSkeleton key={channel} channel={channel} expanded={plan.expanded === channel} />
        ))}
        {plan.addRow && <AddChannelRowSkeleton />}
      </div>
    </div>
  )
}

/** 占位块：统一 .skeletonBar + 一个给出真实宽高的类（见 config-manager.module.css 的 .skc*）。 */
function Bar({ shape }: { shape?: string }) {
  // CSS Modules 的索引类型是 string | undefined（noUncheckedIndexedAccess），缺类名时只留骨架底色。
  return <span className={[css.skeletonBar, shape].filter(Boolean).join(' ')} />
}

/**
 * 一张「已配置」通道卡 = SyncChannelEntryCard 的占位镜像：
 * 标题行（通道名 + 上次同步）/ 徽章行 / 事实行（当前远端）/ 动作行（配置 + 断开 + 折叠箭头）。
 * expanded 时再镜像展开体（摘要行 → 双方向按钮 → 快照行），层级与真实 Collapse 一致。
 */
function ChannelCardSkeleton({ channel, expanded }: { channel: string; expanded: boolean }) {
  return (
    <>
      <Card>
        <div className={css.cardTitleRow}>
          <Bar shape={css.skcCardTitle} />
          <span className={css.statusSpacer} />
          <Bar shape={css.skcInline} />
        </div>
        <div className={css.statRow}>
          <Bar shape={css.skcBadge} />
          <Bar shape={css.skcBadge} />
        </div>
        <div className={css.factGrid} style={{ marginTop: 8 }}>
          <div className={css.factCell}>
            <Bar shape={css.skcFactLabel} />
            <Bar shape={css.skcFactValue} />
          </div>
        </div>
        <div className={css.actionRowTop}>
          <Bar shape={css.skcBtn} />
          <Bar shape={css.skcBtn} />
          <span className={css.statusSpacer} />
          <Bar shape={css.skcIconSm} />
        </div>
      </Card>
      {expanded && (
        <div className={css.syncChannelBody} data-channel={channel}>
          <div className={css.collapseInner}>
            <Card>
              <div className={css.sectionPickerRow}>
                <Bar shape={css.skcGroupLabel} />
                <Bar shape={css.skcCategoryDesc} />
                <Bar shape={css.skcBadge} />
                <Bar shape={`${css.skcBtn} ${css.pickerBtn}`} />
              </div>
              <div className={css.actionRow} data-split="">
                <Bar shape={`${css.skcBtn} ${css.splitBtn}`} />
                <Bar shape={`${css.skcBtn} ${css.splitBtn}`} />
              </div>
              <div className={css.snapshotPickerRow}>
                <span className={css.field} style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <Bar shape={css.skcFactLabel} />
                  <Bar shape={css.skcSelect} />
                </span>
                <span className={css.pickerAction}>
                  <Bar shape={css.skcIcon} />
                  <Bar shape={css.skcIcon} />
                </span>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  )
}

/** 「添加通道」行占位：图标位 + 标题 + 右端通道清单（与 AddChannelCard 同高）。 */
function AddChannelRowSkeleton() {
  return (
    <div className={css.addChannelCard}>
      <Bar shape={css.skcAddIcon} />
      <Bar shape={css.skcAddLabel} />
      <Bar shape={css.skcAddHint} />
    </div>
  )
}
