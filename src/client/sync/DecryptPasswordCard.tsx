/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncSettingsView 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Button, Card } from '../common/ui.tsx'
import type { ChannelSyncState } from './sync-view.ts'
import type { SyncChannelSettingsPatch } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/** 解密密码卡（当前通道拉取/一键同步加密快照用；输入即保存到本机凭据库）。 */
export function DecryptPasswordCard({ t, settings, onPatchSettings, onPersistDecryptPassword, onClearSavedPassword }: {
  t: TranslateNS<'config-manager-sync'>
  settings: Pick<ChannelSyncState, 'decryptPassword' | 'decryptPasswordSaved'>
  onPatchSettings: (patch: SyncChannelSettingsPatch) => void
  onPersistDecryptPassword: () => void
  onClearSavedPassword: () => void
}) {
  return (
    <Card>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('mode.decryptPassword')}</span>
        <input
          type="password"
          className={css.input}
          value={settings.decryptPassword}
          autoComplete="off"
          placeholder={settings.decryptPasswordSaved ? t('mode.decryptPasswordPlaceholder') : undefined}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ decryptPassword: e.target.value }) }}
          onBlur={onPersistDecryptPassword}
        />
        <span className={css.hint}>{t('mode.decryptPasswordHint')}</span>
      </label>
      {settings.decryptPasswordSaved && (
        <div className={css.actionRow}>
          <span className={css.hint}>{t('mode.decryptPasswordSaved')}</span>
          {/* 危险语义：删除本机已保存的密码（不可逆，用户主动操作） */}
          <Button size="sm" variant="danger" onClick={onClearSavedPassword}>
            {t('mode.clearSavedPassword')}
          </Button>
        </div>
      )}
    </Card>
  )
}
