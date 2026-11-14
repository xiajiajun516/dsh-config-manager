/**
 * 加密与密钥导出 + 解密密码（原来是两张独立的 Card：SecurityOptionsCard / DecryptPasswordCard）。
 * 2026-11-14 用户要求：三块设置收进**一个**弹窗，页面只剩摘要行 —— 两张卡因此不再是卡，
 * 而是弹窗里的两段（`.dialogSection` + 段间分隔线），由 SyncSettingsDialog 的第二页签承载。
 *
 * 为什么写方向（加密密码）与读方向（解密密码）同页：它们服务同一份加密快照，一写一读；
 * 但两段各有自己的标题与 ⓘ —— 分开表达「给远端加密」与「读远端的加密」，不混成一个密码。
 *
 * 约定同其余渲染段（t42）：只看渲染所需字段 + 回调；联动规则在 ui/sync-settings-view.ts 的
 * encryptToggle / includeSecretsToggle。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button, Checkbox } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import type { ChannelSyncState } from './sync-view.ts'
import type { SyncChannelSettingsPatch } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

export function SyncSecuritySection({ t, settings, onToggleEncrypt, onToggleIncludeSecrets, onPatchSettings, onPersistEncryptPassword, onPersistDecryptPassword, onClearSavedPassword }: {
  t: TranslateNS<'config-manager-sync'>
  settings: Pick<ChannelSyncState, 'encrypt' | 'includeSecrets' | 'encryptPassword' | 'encryptPasswordConfirm' | 'encryptPasswordSaved' | 'decryptPassword' | 'decryptPasswordSaved'>
  onToggleEncrypt: (next: boolean) => void
  onToggleIncludeSecrets: (next: boolean) => void
  onPatchSettings: (patch: SyncChannelSettingsPatch) => void
  onPersistEncryptPassword: () => void
  onPersistDecryptPassword: () => void
  onClearSavedPassword: () => void
}) {
  return (
    <div className={css.dialogSection}>
      <span className={css.groupLabel}>{t('mode.security')}</span>
      {/* 说明性文案一律进 ⓘ（2026-10-12 用户要求：卡里只留勾选项与控件）。
          「加密方式 + 密码存哪 + 自动同步跳过加密快照」在 2026-11-14 合成一个键。 */}
      <div className={css.controlRow}>
        <Checkbox
          checked={settings.encrypt}
          onChange={onToggleEncrypt}
          label={<span className={css.categoryName}>{t('mode.encrypt')}</span>}
        />
        <InfoHint
          text={t('mode.encryptHint')}
          label={t('common.infoHint')}
        />
      </div>
      {/* 数据丢失后果贴在它真正发生的那个勾选框下面（且只在确有已保存密码时出现）。
          原先写在密码输入区里：用户在「改密码」的位置读到「取消勾选会删密码」，位置与决定对不上。 */}
      {settings.encrypt && settings.encryptPasswordSaved && (
        <span className={css.hint + ' ' + css.warnText}>{t('mode.passwordClearNotice')}</span>
      )}
      {settings.encrypt && (
        <div className={css.secretFields}>
          <div className={css.field}>
            <span className={css.fieldLabel}>
              {t('mode.password')}
            </span>
            <input aria-label={t('mode.password')}
              type="password"
              className={css.input}
              value={settings.encryptPassword}
              autoComplete="new-password"
              placeholder={settings.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ encryptPassword: e.target.value }) }}
              // 失焦即落库（两个框一致才写）——用户不必手动保存，下次留空即沿用
              onBlur={onPersistEncryptPassword}
            />
          </div>
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
        </div>
      )}
      <div className={css.controlRow}>
        <Checkbox
          checked={settings.includeSecrets}
          onChange={onToggleIncludeSecrets}
          label={<span className={css.categoryName}>{t('mode.includeSecrets')}</span>}
        />
        <InfoHint text={t('mode.includeSecretsHint')} label={t('common.infoHint')} />
      </div>
      {/* 段间分隔：读方向（拉取加密快照）与写方向（给远端加密）各自成段，但同页 —— 它们
          服务同一份加密快照，分开在两页会让用户以为要用两个密码。 */}
      <div className={css.dialogSectionDivide} />
      <div className={css.field}>
        <span className={css.fieldLabel}>{t('mode.decryptPassword')} <InfoHint text={t('mode.decryptPasswordHint')} label={t('common.infoHint')} /></span>
        <input aria-label={t('mode.decryptPassword')}
          type="password"
          className={css.input}
          value={settings.decryptPassword}
          autoComplete="off"
          placeholder={settings.decryptPasswordSaved ? t('mode.decryptPasswordPlaceholder') : undefined}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ decryptPassword: e.target.value }) }}
          onBlur={onPersistDecryptPassword}
        />
      </div>
      {settings.decryptPasswordSaved && (
        <div className={css.actionRow}>
          <Badge kind="ok">{t('mode.decryptPasswordSaved')}</Badge>
          {/* 危险语义：删除本机已保存的密码（不可逆，用户主动操作） */}
          <Button size="sm" variant="danger" onClick={onClearSavedPassword}>
            {t('mode.clearSavedPassword')}
          </Button>
        </div>
      )}
    </div>
  )
}