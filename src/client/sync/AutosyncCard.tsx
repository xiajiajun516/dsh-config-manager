/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺；v2 第 5 步主文件改名 SyncPanel.tsx）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncPanel 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 *
 * 2026-11-14 二次收口（用户要求「自动同步与加密与密码合成一页」+ Stitch 稿 D-39）：
 * 布局从「小节标题 + 竖排 .field」改成**行式设置行**（标签在左、控件在右、行高 34、0.5px 行线）——
 * 同一页还要放加密三项与插件一项，竖排每项占两行（标题一行 + 控件一行），720 画布的
 * 弹窗首屏必然装不下；行式把九行压进 306px，一屏收完（见 .settingsRow 注释）。
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Switch } from '../common/ui.tsx'
import { Select } from '../common/Select.tsx'
import {
  autosyncFailureMessage, autosyncIntervalMs, autosyncSkipDetail, autosyncStatusText, computeAutosyncCountdown,
  formatIntervalDuration,
} from './sync-view.ts'
// 展示文本渲染前统一脱敏（与 ErrorBanner/ReportView 同规矩）
import { redact } from '../../security/redaction.ts'
import type { AutosyncAutoApplyTier, AutosyncConflictPolicy, AutosyncInterval } from './sync-api.ts'
import type { ChannelSyncState } from './sync-view.ts'
import { autosyncIntervalKey } from '../../ui/sync-settings-view.ts'
import type { SyncAutosyncIntervalKey } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/**
 * 倒计时本地推进的节拍（15s）。
 *
 * 审计 P9-3：徽章文案的粒度是分钟（formatIntervalDuration 向上取整到分钟），15s 已足够
 * 让「还剩 X 分钟」在可见范围内按分钟递减，同时几乎不占 CPU。
 */
const AUTOSYNC_COUNTDOWN_TICK_MS = 15_000

/**
 * 让宿主给的「距上次同步已过 ms」在组件内继续走（审计 P9-3）。
 *
 * 语义冲突在哪：`elapsedMs` 是宿主在 /sync/status 那一刻算好的**快照**，而徽章说的是
 * 「距下次自动同步还剩多久」——一个会随时间流逝的相对量。此前组件只在渲染时算一次，
 * 于是文字永远停在打开页面那一秒（页面上也没有别的计时器：全 client 只有 RunsCenter 有）。
 *
 * 做法：以快照到达时刻为锚点，把本地流逝的时间叠上去；快照本身变了（宿主重算过、
 * 或用户改了间隔）就换锚点，避免新旧基准互相污染。返回 null = 从未运行，没有倒计时。
 */
function useAdvancingElapsedMs(snapshotElapsedMs: number | null): number | null {
  const anchor = useMemo(
    () => (snapshotElapsedMs === null ? null : { snapshotElapsedMs, at: Date.now() }),
    [snapshotElapsedMs],
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    if (snapshotElapsedMs === null) return undefined
    const timer = setInterval(() => { setTick((n) => (n + 1) % 1_000_000) }, AUTOSYNC_COUNTDOWN_TICK_MS)
    return () => { clearInterval(timer) }
  }, [snapshotElapsedMs])
  if (anchor === null) return null
  return anchor.snapshotElapsedMs + Math.max(0, Date.now() - anchor.at)
}

/** 间隔下拉的取值顺序（t42：随卡片一起从主文件迁出）。 */
const AUTOSYNC_INTERVAL_OPTIONS: AutosyncInterval[] = ['5m', '15m', '30m', '60m', '6h', '12h', '24h']

/** AutosyncInterval → 可读标签（键映射在 ui/sync-settings-view.ts，未命中时原样展示）。 */
function intervalLabel(iv: AutosyncInterval, t: TranslateNS<'config-manager-sync'>): string {
  const key: SyncAutosyncIntervalKey | null = autosyncIntervalKey(iv)
  return key === null ? iv : t(key)
}

/* ------------------------------------------- 拆分出的 render 段（t42，同文件内子组件） */

/** 自动同步设置（当前通道）：段头（标题 + 总开关）+ 四行策略 + 状态徽章（文案/倒计时在卡内派生）。 */
export function AutosyncCard({ t, uiT, settings, busy, onToggleAutosync, onUpdateInterval, onUpdateOptions }: {
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
  settings: Pick<ChannelSyncState, 'autosync' | 'autosyncEnabled' | 'autosyncInterval'>
  busy: boolean
  onToggleAutosync: (enabled: boolean) => void
  onUpdateInterval: (interval: AutosyncInterval) => void
  /** 真·自动同步的三个策略项（realtime / 自动应用等级 / 冲突策略）；只传要改的字段 */
  onUpdateOptions: (patch: { realtime?: boolean; autoApplyTier?: AutosyncAutoApplyTier; conflictPolicy?: AutosyncConflictPolicy }) => void
}) {
  // 三件套读自宿主状态（缺省值集中在这里，与宿主 DEFAULT_AUTOSYNC_* 的口径一致）
  const realtime = settings.autosync?.realtime ?? true
  const autoApplyTier: AutosyncAutoApplyTier = settings.autosync?.autoApplyTier ?? 'medium'
  const conflictPolicy: AutosyncConflictPolicy = settings.autosync?.conflictPolicy ?? 'local'
  const autosyncText = settings.autosync !== null ? autosyncStatusText(settings.autosync, uiT) : t('autosync.statusNever')
  /** 距下次自动同步剩余 ms（null = 从未运行；0 = 已到期）—— elapsedMs 先经本地推进，见 hook 注释 */
  const snapshotElapsedMs = settings.autosync !== null && settings.autosync.elapsedMs >= 0
    ? settings.autosync.elapsedMs
    : null
  const advancingElapsedMs = useAdvancingElapsedMs(snapshotElapsedMs)
  const autosyncCountdownMs = advancingElapsedMs !== null && settings.autosync !== null
    ? computeAutosyncCountdown(advancingElapsedMs, autosyncIntervalMs(settings.autosync.interval))
    : null
  // issue #79：本轮为什么没同步 / 失败了什么，必须看得见 —— 此前只写进 info 级日志
  // （默认日志级别 warn），界面恒无提示，用户只能去翻 sync-autosync.json。
  const skipDetail = settings.autosync !== null ? autosyncSkipDetail(settings.autosync, t) : null
  // issue #105：只有本轮真的失败才渲染错误原文。此前只看「非空」，于是上一轮（甚至十天前）
  // 的旧错误会被当成当前结论继续展示；判据现在收在 autosyncFailureMessage 一处。
  const failureMessage = settings.autosync !== null ? autosyncFailureMessage(settings.autosync) : null
  const lastMessage = failureMessage === null ? null : redact(failureMessage)
  /** 开关的 id：段头右侧的开关没有可点文字，靠 aria-label 命名；行内的开关由 htmlFor 绑标签 */
  const enableId = useId()
  const realtimeId = useId()
  return (
    /* 段（.settingsGroup）而不是卡：本段所在的弹窗已经是卡，卡里再套一张浮起来的卡会多出
       一圈边界（同 .syncSubBlock 当年的理由）；段与段之间靠 .settingsPage 的 14 间距 */
    <div className={css.settingsGroup}>
      {/* 段头：标题左、总开关右（2026-11-01 用户要求「左标题右按钮」）。开关此刻就叫
          「自动同步」是否开启 —— 标题与开关是同一件事，不该各占一行。 */}
      <div className={css.settingsGroupHead}>
        <span className={css.settingsGroupTitle}>
          {t('autosync.title')}
        </span>
        {/* 弹性开关（2026-11-14 用户要求）：单一布尔、拨动即落库 ⇒ 用 Switch 而不是勾选框 */}
        <Switch
          id={enableId}
          checked={settings.autosyncEnabled}
          disabled={busy}
          label={t('autosync.enable')}
          onChange={onToggleAutosync}
        />
      </div>
      {/* 关闭时不再展示策略项（2026-11-01）：Enabled 没勾选，下面四个控件 + 状态徽章 +
          失败原文仍然全铺开，占掉画布最后三屏里的两屏 —— 用户要按的「合并 / 推送」被推到
          首屏之外，而这一整组在关闭状态下没有一个控件能生效。app-screens §11 与 DESIGN.md §9
          同口径：不给未启用的能力配满配置项。开启后这些控件立刻出现，没有隐藏的能力。 */}
      {settings.autosyncEnabled && (
        <>
          {/* 行式设置行（D-39）：标签在左、控件在右。外壳用 <span> 而不是 <label>：
              这一行里存在的是一段纯文字（2026-11-14 用户要求移除全部 ⓘ 后不再有按钮），
              用 <span> 就不会把指针在标签区域的点击转发给右侧控件。控件的无障碍名
              不靠标签：Select 自带 ariaLabel、Switch 自带 label。 */}
          <div className={css.settingsRow}>
            <span className={css.settingsRowMain}>
              <span className={css.settingsRowLabel}>{t('autosync.interval')}</span>
            </span>
            <span className={css.settingsRowControl}>
              <Select
                className={css.settingsSelect}
                value={settings.autosyncInterval}
                disabled={busy}
                ariaLabel={t('autosync.interval')}
                onChange={(next) => { onUpdateInterval(next as AutosyncInterval) }}
                options={AUTOSYNC_INTERVAL_OPTIONS.map((iv) => ({ value: iv, label: intervalLabel(iv, t) }))}
              />
            </span>
          </div>
          <div className={css.settingsRow}>
            <span className={css.settingsRowMain}>
              <label className={css.settingsRowLabel} htmlFor={realtimeId}>{t('autosync.realtime')}</label>
            </span>
            <span className={css.settingsRowControl}>
              <Switch
                id={realtimeId}
                checked={realtime}
                disabled={busy}
                label={t('autosync.realtime')}
                onChange={(next) => { onUpdateOptions({ realtime: next }) }}
              />
            </span>
          </div>
          <div className={css.settingsRow}>
            <span className={css.settingsRowMain}>
              <span className={css.settingsRowLabel}>{t('autosync.autoApplyTier')}</span>
            </span>
            <span className={css.settingsRowControl}>
              <Select
                className={css.settingsSelect}
                value={autoApplyTier}
                disabled={busy}
                ariaLabel={t('autosync.autoApplyTier')}
                onChange={(next) => { onUpdateOptions({ autoApplyTier: next as AutosyncAutoApplyTier }) }}
                options={[
                  { value: 'low', label: t('autosync.tierLow') },
                  { value: 'medium', label: t('autosync.tierMedium') },
                ]}
              />
            </span>
          </div>
          <div className={css.settingsRow}>
            <span className={css.settingsRowMain}>
              <span className={css.settingsRowLabel}>{t('autosync.conflictPolicy')}</span>
            </span>
            <span className={css.settingsRowControl}>
              <Select
                className={css.settingsSelect}
                value={conflictPolicy}
                disabled={busy}
                ariaLabel={t('autosync.conflictPolicy')}
                onChange={(next) => { onUpdateOptions({ conflictPolicy: next as AutosyncConflictPolicy }) }}
                options={[
                  { value: 'local', label: t('autosync.conflictLocal') },
                  { value: 'ask', label: t('autosync.conflictAsk') },
                ]}
              />
            </span>
          </div>
          <div className={css.statRow}>
            <Badge kind={settings.autosync?.lastRunStatus === 'failed' ? 'error' : settings.autosync?.lastRunStatus === 'skipped' ? 'warn' : 'info'}>
              {autosyncText}
            </Badge>
            {autosyncCountdownMs !== null && settings.autosyncEnabled && (
              <Badge kind="info">
                {autosyncCountdownMs <= 0
                  ? t('autosync.due')
                  : t('autosync.nextRun', { time: formatIntervalDuration(autosyncCountdownMs, uiT) })}
              </Badge>
            )}
          </div>
          {(skipDetail !== null || lastMessage !== null) && (
            <div className={css.factGrid} style={{ marginTop: 8 }}>
              {skipDetail !== null && (
                <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.factLabel}>{t('autosync.skipReasonLabel')}</span>
                  <span className={css.factValue}>{skipDetail}</span>
                </div>
              )}
              {lastMessage !== null && (
                <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
                  <span className={css.factLabel}>{t('autosync.lastMessage')}</span>
                  <span className={css.factValue}>{lastMessage}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
