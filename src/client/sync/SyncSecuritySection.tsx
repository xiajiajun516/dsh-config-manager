import { useId } from 'react'
/**
 * 加密与密钥导出 + 解密密码（原来是两张独立的 Card：SecurityOptionsCard / DecryptPasswordCard）。
 * 2026-11-14 用户要求：三块设置收进**一个**弹窗，页面只剩摘要行 —— 两张卡因此不再是卡，
 * 而是弹窗里的两段（.settingsGroup），由 SyncSettingsDialog 的「设置」页承载（该页签 2026-11-14 由「自动同步与密码」改名）。
 *
 * 为什么写方向（加密密码）与读方向（解密密码）同页：它们服务同一份加密快照，一写一读；
 * 但两段各有自己的段头与状态 —— 分开表达「给远端加密」与「读远端的加密」，不混成一个密码。
 * 2026-11-14 用户要求：本页（连同自动同步段）的 ⓘ 全部移除，只留设置本身。
 *
 * 2026-11-14 二次收口（Stitch 稿 D-39）：段内改成**行式设置行**（标签左、控件右、行高 34、
 * 0.5px 行线），段头的开关贴右。原来每项都是「标题一行 + 控件一行」的竖排 .field ——
 * 同一页还要放自动同步四项，竖排一屏装不下。
 *
 * 约定同其余渲染段（t42）：只看渲染所需字段 + 回调；联动规则在 ui/sync-settings-view.ts 的
 * encryptToggle / includeSecretsToggle。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button, Switch } from '../common/ui.tsx'
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
  /** 开关的 id：段头那句「加密备份」也能拨动（label htmlFor），与原来勾选框的点击面一致 */
  const encryptId = useId()
  const includeSecretsId = useId()
  /** 两个密码框的 id：标签文字点一下就聚焦（行式布局里标签与输入框不再同属一个 .field） */
  const passwordId = useId()
  const confirmId = useId()
  return (
    <>
      <div className={css.settingsGroup}>
        {/* 段头：段名在左，属于这一段的开关（加密备份）连它的名字一起贴右 ——
            标题只标段名，控件自己的名字必须贴在控件旁边。 */}
        <div className={css.settingsGroupHead}>
          <span className={css.settingsGroupTitle}>{t('mode.security')}</span>
          <span className={css.settingsGroupAction}>
            <label className={css.settingsRowLabel} htmlFor={encryptId}>{t('mode.encrypt')}</label>
            {/* 弹性开关（2026-11-14）：与自动同步段同一类 —— 单一布尔、拨动即落库。 */}
            <Switch id={encryptId} checked={settings.encrypt} onChange={onToggleEncrypt} label={t('mode.encrypt')} />
          </span>
        </div>
        {settings.encrypt && (
          <>
            <div className={css.settingsRow}>
              <span className={css.settingsRowMain}>
                <label className={css.settingsRowLabel} htmlFor={passwordId}>{t('mode.password')}</label>
              </span>
              <span className={css.settingsRowControl}>
                <input id={passwordId}
                  aria-label={t('mode.password')}
                  type="password"
                  className={css.input + ' ' + css.settingsInput}
                  value={settings.encryptPassword}
                  autoComplete="new-password"
                  placeholder={settings.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ encryptPassword: e.target.value }) }}
                  // 失焦即落库（两个框一致才写）——用户不必手动保存，下次留空即沿用
                  onBlur={onPersistEncryptPassword}
                />
              </span>
            </div>
            <div className={css.settingsRow}>
              <span className={css.settingsRowMain}>
                <label className={css.settingsRowLabel} htmlFor={confirmId}>{t('mode.passwordConfirm')}</label>
              </span>
              <span className={css.settingsRowControl}>
                <input id={confirmId}
                  aria-label={t('mode.passwordConfirm')}
                  type="password"
                  className={css.input + ' ' + css.settingsInput}
                  value={settings.encryptPasswordConfirm}
                  autoComplete="new-password"
                  placeholder={settings.encryptPasswordSaved ? t('mode.passwordPlaceholder') : undefined}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ encryptPasswordConfirm: e.target.value }) }}
                  onBlur={onPersistEncryptPassword}
                />
              </span>
            </div>
            {/* 数据丢失后果贴在它真正发生的那个开关下面（且只在确有已保存密码时出现）。
                原先写在密码输入区里：用户在「改密码」的位置读到「取消勾选会删密码」，位置与决定对不上。 */}
            {settings.encryptPasswordSaved && (
              <span className={css.hint + ' ' + css.warnText + ' ' + css.settingsNote}>{t('mode.passwordClearNotice')}</span>
            )}
            {settings.encryptPassword !== '' && settings.encryptPassword !== settings.encryptPasswordConfirm && (
              <span className={css.formError + ' ' + css.settingsNote}>{t('mode.passwordMismatch')}</span>
            )}
            {settings.encryptPassword === '' && !settings.encryptPasswordSaved && (
              <span className={css.formError + ' ' + css.settingsNote}>{t('mode.passwordRequired')}</span>
            )}
          </>
        )}
        <div className={css.settingsRow}>
          <span className={css.settingsRowMain}>
            <label className={css.settingsRowLabel} htmlFor={includeSecretsId}>{t('mode.includeSecrets')}</label>
          </span>
          <span className={css.settingsRowControl}>
            <Switch id={includeSecretsId} checked={settings.includeSecrets} onChange={onToggleIncludeSecrets} label={t('mode.includeSecrets')} />
          </span>
        </div>
      </div>
      {/* 读方向（拉取加密快照）自成一段，但同页 —— 它们服务同一份加密快照，分开在两页
          会让用户以为要用两个密码。段头右侧的「已保存到本机」只说这一段的存储状态。 */}
      <div className={css.settingsGroup}>
        <div className={css.settingsGroupHead}>
          <span className={css.settingsGroupTitle}>{t('mode.decryptGroup')}</span>
          {settings.decryptPasswordSaved && <Badge kind="ok">{t('mode.decryptPasswordSaved')}</Badge>}
        </div>
        <div className={css.settingsRow}>
          <span className={css.settingsRowMain}>
            <span className={css.settingsRowLabel}>{t('mode.decryptPasswordShort')}</span>
          </span>
          <span className={css.settingsRowControl}>
            <input aria-label={t('mode.decryptPassword')}
              type="password"
              className={css.input + ' ' + css.settingsInput}
              value={settings.decryptPassword}
              autoComplete="off"
              placeholder={settings.decryptPasswordSaved ? t('mode.decryptPasswordPlaceholder') : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onPatchSettings({ decryptPassword: e.target.value }) }}
              onBlur={onPersistDecryptPassword}
            />
          </span>
        </div>
        {settings.decryptPasswordSaved && (
          /* 危险语义：删除本机已保存的密码（不可逆，用户主动操作）—— 段尾右对齐，不与上面的
             输入框挤一行（挤在一起会读成「这个按钮作用于当前正在输入的密码」）。 */
          <div className={css.settingsGroupFoot}>
            <Button size="sm" variant="danger" onClick={onClearSavedPassword}>
              {t('mode.clearSavedPassword')}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}
