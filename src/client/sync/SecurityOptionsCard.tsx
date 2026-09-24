/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncSettingsView 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Card, Checkbox } from '../common/ui.tsx'
import type { ChannelSyncState } from './sync-view.ts'
import type { SyncChannelSettingsPatch } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/**
 * 加密与密钥导出（当前通道手动推送；仿「导出备份·自定义模式」安全选项）。
 * 只看渲染所需字段 + 回调；联动规则在 ui/sync-settings-view.ts 的 encryptToggle/includeSecretsToggle。
 */
export function SecurityOptionsCard({ t, settings, onToggleEncrypt, onToggleIncludeSecrets, onPatchSettings, onPersistEncryptPassword }: {
  t: TranslateNS<'config-manager-sync'>
  settings: Pick<ChannelSyncState, 'encrypt' | 'includeSecrets' | 'encryptPassword' | 'encryptPasswordConfirm' | 'encryptPasswordSaved'>
  onToggleEncrypt: (next: boolean) => void
  onToggleIncludeSecrets: (next: boolean) => void
  onPatchSettings: (patch: SyncChannelSettingsPatch) => void
  onPersistEncryptPassword: () => void
}) {
  return (
    <Card>
      <span className={css.groupLabel}>{t('mode.security')}</span>
      <Checkbox
        checked={settings.encrypt}
        onChange={onToggleEncrypt}
        label={<span className={css.categoryName}>{t('mode.encrypt')}</span>}
      />
      <div className={css.hint}>{t('mode.encryptHint')}</div>
      {settings.encrypt && settings.encryptPasswordSaved && (
        <div className={css.hint}>{t('mode.passwordSavedHint')}</div>
      )}
      {settings.encrypt && (
        <div className={css.secretFields}>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('mode.password')}</span>
            <input
              type="password"
              className={css.input}
              value={settings.encryptPassword}
              autoComplete="new-password"
              placeholder={settings.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ encryptPassword: e.target.value }) }}
              // 失焦即落库（两个框一致才写）——用户不必手动保存，下次留空即沿用
              onBlur={onPersistEncryptPassword}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('mode.passwordConfirm')}</span>
            <input
              type="password"
              className={css.input}
              value={settings.encryptPasswordConfirm}
              autoComplete="new-password"
              placeholder={settings.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ encryptPasswordConfirm: e.target.value }) }}
              onBlur={onPersistEncryptPassword}
            />
          </label>
          {settings.encryptPassword !== '' && settings.encryptPassword !== settings.encryptPasswordConfirm && (
            <span className={css.formError}>{t('mode.passwordMismatch')}</span>
          )}
          {settings.encryptPassword === '' && !settings.encryptPasswordSaved && (
            <span className={css.formError}>{t('mode.passwordRequired')}</span>
          )}
          <span className={css.hint}>{t('mode.passwordClearNotice')}</span>
        </div>
      )}
      <Checkbox
        checked={settings.includeSecrets}
        onChange={onToggleIncludeSecrets}
        label={<span className={css.categoryName}>{t('mode.includeSecrets')}</span>}
      />
      <div className={css.hint}>{t('mode.includeSecretsHint')}</div>
      <span className={css.hint}>{t('mode.encryptAutosyncNotice')}</span>
    </Card>
  )
}
