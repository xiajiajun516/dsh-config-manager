/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncSettingsView 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Card } from '../common/ui.tsx'
import {
  autosyncIntervalMs, autosyncStatusText, computeAutosyncCountdown, formatIntervalDuration,
} from './sync-view.ts'
import type { AutosyncInterval } from './sync-api.ts'
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
export function AutosyncCard({ t, uiT, settings, busy, onToggleAutosync, onUpdateInterval }: {
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
  settings: Pick<ChannelSyncState, 'autosync' | 'autosyncEnabled' | 'autosyncInterval'>
  busy: boolean
  onToggleAutosync: (enabled: boolean) => void
  onUpdateInterval: (interval: AutosyncInterval) => void
}) {
  const autosyncText = settings.autosync !== null ? autosyncStatusText(settings.autosync, uiT) : t('autosync.statusNever')
  /** 距下次自动同步剩余 ms（null = 从未运行；0 = 已到期） */
  const autosyncCountdownMs = settings.autosync !== null && settings.autosync.elapsedMs >= 0
    ? computeAutosyncCountdown(settings.autosync.elapsedMs, autosyncIntervalMs(settings.autosync.interval))
    : null
  return (
    <Card>
      <span className={css.groupLabel}>{t('autosync.title')}</span>
      <span className={css.hint}>{t('autosync.description')}</span>
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
        <span className={css.fieldLabel}>{t('autosync.interval')}</span>
        <select
          className={css.input}
          value={settings.autosyncInterval}
          disabled={busy}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            onUpdateInterval(e.target.value as AutosyncInterval)
          }}
        >
          {AUTOSYNC_INTERVAL_OPTIONS.map((iv) => (
            <option key={iv} value={iv}>{intervalLabel(iv, t)}</option>
          ))}
        </select>
        <span className={css.hint}>{t('autosync.intervalHint')}</span>
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
    </Card>
  )
}
