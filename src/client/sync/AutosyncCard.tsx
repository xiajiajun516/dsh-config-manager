/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺；v2 第 5 步主文件改名 SyncPanel.tsx）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncPanel 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Card } from '../common/ui.tsx'
import { Select } from '../common/Select.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
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

/** 间隔下拉的取值顺序（t42：随卡片一起从主文件迁出）。 */
const AUTOSYNC_INTERVAL_OPTIONS: AutosyncInterval[] = ['5m', '15m', '30m', '60m', '6h', '12h', '24h']

/** AutosyncInterval → 可读标签（键映射在 ui/sync-settings-view.ts，未命中时原样展示）。 */
function intervalLabel(iv: AutosyncInterval, t: TranslateNS<'config-manager-sync'>): string {
  const key: SyncAutosyncIntervalKey | null = autosyncIntervalKey(iv)
  return key === null ? iv : t(key)
}

/* ------------------------------------------- 拆分出的 render 段（t42，同文件内子组件） */

/** 自动同步设置（当前通道）：总开关 + 间隔下拉 + 状态徽章（文案/倒计时在卡内派生）。 */
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
  /** 距下次自动同步剩余 ms（null = 从未运行；0 = 已到期） */
  const autosyncCountdownMs = settings.autosync !== null && settings.autosync.elapsedMs >= 0
    ? computeAutosyncCountdown(settings.autosync.elapsedMs, autosyncIntervalMs(settings.autosync.interval))
    : null
  // issue #79：本轮为什么没同步 / 失败了什么，必须看得见 —— 此前只写进 info 级日志
  // （默认日志级别 warn），界面恒无提示，用户只能去翻 sync-autosync.json。
  const skipDetail = settings.autosync !== null ? autosyncSkipDetail(settings.autosync, t) : null
  // issue #105：只有本轮真的失败才渲染错误原文。此前只看「非空」，于是上一轮（甚至十天前）
  // 的旧错误会被当成当前结论继续展示；判据现在收在 autosyncFailureMessage 一处。
  const failureMessage = settings.autosync !== null ? autosyncFailureMessage(settings.autosync) : null
  const lastMessage = failureMessage === null ? null : redact(failureMessage)
  return (
    <Card>
      <span className={css.groupLabel}>{t('autosync.title')} <InfoHint text={t('autosync.description')} label={t('common.infoHint')} /></span>
      <label className={css.checkboxRow}>
        <input
          type="checkbox"
          checked={settings.autosyncEnabled}
          disabled={busy}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onToggleAutosync(e.target.checked) }}
        />
        <span>{t('autosync.enable')}</span>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('autosync.interval')} <InfoHint text={t('autosync.intervalHint')} label={t('common.infoHint')} /></span>
        <Select
          value={settings.autosyncInterval}
          disabled={busy}
          ariaLabel={t('autosync.interval')}
          onChange={(next) => { onUpdateInterval(next as AutosyncInterval) }}
          options={AUTOSYNC_INTERVAL_OPTIONS.map((iv) => ({ value: iv, label: intervalLabel(iv, t) }))}
        />
      </label>
      <label className={css.checkboxRow}>
        <input
          type="checkbox"
          checked={realtime}
          disabled={busy}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onUpdateOptions({ realtime: e.target.checked }) }}
        />
        <span>{t('autosync.realtime')} <InfoHint text={t('autosync.realtimeHint')} label={t('common.infoHint')} /></span>
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('autosync.autoApplyTier')} <InfoHint text={t('autosync.autoApplyTierHint')} label={t('common.infoHint')} /></span>
        <Select
          value={autoApplyTier}
          disabled={busy}
          ariaLabel={t('autosync.autoApplyTier')}
          onChange={(next) => { onUpdateOptions({ autoApplyTier: next as AutosyncAutoApplyTier }) }}
          options={[
            { value: 'low', label: t('autosync.tierLow') },
            { value: 'medium', label: t('autosync.tierMedium') },
          ]}
        />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('autosync.conflictPolicy')} <InfoHint text={t('autosync.conflictPolicyHint')} label={t('common.infoHint')} /></span>
        <Select
          value={conflictPolicy}
          disabled={busy}
          ariaLabel={t('autosync.conflictPolicy')}
          onChange={(next) => { onUpdateOptions({ conflictPolicy: next as AutosyncConflictPolicy }) }}
          options={[
            { value: 'local', label: t('autosync.conflictLocal') },
            { value: 'ask', label: t('autosync.conflictAsk') },
          ]}
        />
      </label>
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
    </Card>
  )
}
