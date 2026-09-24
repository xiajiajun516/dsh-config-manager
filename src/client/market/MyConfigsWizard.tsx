/**
 * 「我的配置」上传 / 更新向导弹窗 —— t49 物理拆分：从 MyConfigsView.tsx 的 renderWizard 段
 * 原样提取，行为/视觉不变（步骤：选 zip → 校验 → 表单 → 结果卡）。
 * 本文件只渲染 + 上抛回调：向导全量状态是受控 prop，所有状态迁移与请求（校验/上传/更新/重试收录）
 * 都在 MyConfigsView.tsx；PR 链接来源优先级复用 ../../ui/my-configs-view.ts 的 myPrLinkSource。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ListingStatusResponse } from '../../market/my-repo.ts'
import { redact } from '../../security/redaction.ts'
import { myPrLinkSource } from '../../ui/my-configs-view.ts'
import { Badge, Banner, Button, Field, Spinner } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { myConfigFormValid } from './my-configs-view.ts'
import type { AutoFieldBadge, MyConfigForm, MyWizardState } from './my-configs-view.ts'
import css from '../config-manager.module.css'

export interface MyConfigsWizardProps {
  /** 向导全量状态（受控：容器经 restoreMyWizard/myWizardRef 装配） */
  wizard: MyWizardState
  /** 收录任务实时状态（结果卡的 pending/failed 分支 + PR 链接优先来源） */
  listingStatus: ListingStatusResponse | null
  /** 市场字典（与 MyConfigsView 同一个 t） */
  t: TranslateNS<'config-manager-market'>
  /** 隐藏 file input（选 zip；由容器持有） */
  fileInput: { current: HTMLInputElement | null }
  /** 系统自动字段徽章（容器用 autoFieldBadges 装配） */
  autoBadges: readonly AutoFieldBadge[]
  /** 关闭弹窗（容器负责重置向导会话） */
  onClose: () => void
  /** 选完 zip（容器负责上传 + 自动校验） */
  onPickFile: (file: File | undefined) => void
  /** 表单字段更新 + 实时校验 */
  onFormField: (field: keyof MyConfigForm, value: string) => void
  /** 一键上传 / 一键更新 */
  onRunUpload: () => void
  /** 取消更新：向导回到「一键上传」初始态（弹窗保持打开） */
  onCancelUpdate: () => void
  /** 结果卡「重新收录」 */
  onRelist: (itemId: string) => void
  /** 重选 zip：update 轻量重置（保留预填表单）/ upload 完全重置 */
  onReset: () => void
}

export function MyConfigsWizard({
  wizard, listingStatus, t, fileInput, autoBadges,
  onClose, onPickFile, onFormField, onRunUpload, onCancelUpdate, onRelist, onReset,
}: MyConfigsWizardProps) {
  /** PR 链接（优先实时任务状态；收录完成后由轮询补上，或直接取同步结果） */
  const prLink = ((): { url: string; label: string } | null => {
    // 来源优先级（实时任务状态 → 向导结果）在 src/ui/my-configs-view.ts 的 myPrLinkSource
    const source = myPrLinkSource(listingStatus, wizard.result)
    if (source === null) return null
    return {
      url: source.url,
      label: source.number !== null
        ? t('myconfigs.result.pr', { number: String(source.number) })
        : t('myconfigs.result.openPr'),
    }
  })()
  return (
    <Modal
      open
      onClose={onClose}
      title={wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
      wide
      busy={wizard.running || wizard.validating}
    >
      <Modal.Header
        title={wizard.mode === 'update' ? t('myconfigs.update.title') : t('myconfigs.upload.title')}
        closeLabel={t('common.close')}
        onClose={onClose}
        closeDisabled={wizard.running || wizard.validating}
        trailing={wizard.mode === 'update' ? <Badge kind="info">{t('myconfigs.update.hint')}</Badge> : undefined}
      />
      <Modal.Body scroll>

      {/* 步骤 1：选配置包 */}
      {wizard.step === 'select' && (<>
        <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,application/zip"
          className={css.hiddenFile}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const picked = e.target.files?.[0]
            e.target.value = ''
            onPickFile(picked)
          }}
        />
        <div className={css.actionRow}>
          <Button variant="primary" disabled={wizard.running} onClick={() => { fileInput.current?.click() }}>
            {t('myconfigs.upload.select')}
          </Button>
        </div>
      </>)}

      {/* 步骤 2：本地校验（dry-run 零写入；选完 zip 自动执行，通过即自动进表单，
          本步骤仅短暂展示「校验中」；失败时展示错误 + 重新选择） */}
      {wizard.step === 'validate' && (<>
        <span className={css.hint}>{t('myconfigs.upload.selectHint')}</span>
        {wizard.fileName !== null && (
          <div className={css.statRow}>
            <Badge kind="info">{t('myconfigs.upload.selected', { name: wizard.fileName })}</Badge>
          </div>
        )}
        <div className={css.actionRow}>
          <Button
            variant="primary"
            disabled={wizard.validating}
            onClick={onReset}
          >
            {wizard.validating ? <Spinner label={t('myconfigs.upload.validating')} /> : t('myconfigs.upload.reselect')}
          </Button>
        </div>
        {wizard.validationError !== null && <Banner kind="error">{redact(wizard.validationError)}</Banner>}
      </>)}

      {/* 步骤 3：精简表单（仅 name/description/categories；其余系统自动） → 上传/更新 */}
      {wizard.step === 'form' && (<>
        {/* update 模式：表单页内嵌「选择新 ZIP」入口（选中自动校验，通过后才可一键更新） */}
        {wizard.mode === 'update' && (<>
          <span className={css.hint}>{t('myconfigs.update.zipHint')}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            className={css.hiddenFile}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              const picked = e.target.files?.[0]
              e.target.value = ''
              onPickFile(picked)
            }}
          />
          <div className={css.actionRow}>
            <Button variant="primary" disabled={wizard.validating || wizard.running} onClick={() => { fileInput.current?.click() }}>
              {wizard.fileName !== null && wizard.zipPath !== null
                ? t('myconfigs.upload.selected', { name: wizard.fileName })
                : t('myconfigs.update.selectZip')}
            </Button>
            {wizard.zipPath !== null && (
              <Button disabled={wizard.validating || wizard.running} onClick={onReset}>{t('myconfigs.upload.reselect')}</Button>
            )}
          </div>
          {wizard.validationError !== null && <Banner kind="error">{redact(wizard.validationError)}</Banner>}
        </>)}
        {wizard.validated && (
          <div className={css.statRow}>
            <Badge kind="ok">{t('myconfigs.upload.validateOk')}</Badge>
          </div>
        )}
        <Field label={t('myconfigs.upload.form.name')} hint={t('myconfigs.upload.form.nameHint')}>
          <input className={css.input} value={wizard.form.name} onChange={(e) => { onFormField('name', e.target.value) }} />
          {wizard.formErrors.name !== null && <span className={css.formError}>{redact(wizard.formErrors.name)}</span>}
        </Field>
        <Field label={t('myconfigs.upload.form.description')}>
          <textarea className={css.input} value={wizard.form.description} onChange={(e) => { onFormField('description', e.target.value) }} />
        </Field>
        <Field label={t('myconfigs.upload.form.categories')}>
          <input className={css.input} value={wizard.form.categories} onChange={(e) => { onFormField('categories', e.target.value) }} />
        </Field>
        {/* F6 发布模式：迁移（全带）/ 分享（自动排除敏感分区 + 强制隐私拦截）—— 复用既有 conflictOptions/radioLabel 单选样式 */}
        <Field label={t('myconfigs.upload.mode.title')}>
          <div className={css.conflictOptions}>
            {([
              ['migrate', t('myconfigs.upload.mode.migrate')],
              ['share', t('myconfigs.upload.mode.share')],
            ] as const).map(([value, label]) => (
              <label key={value} className={css.radioLabel}>
                <input
                  type="radio"
                  name="my-config-publish-mode"
                  checked={wizard.form.publishMode === value}
                  disabled={wizard.running || wizard.validating}
                  onChange={() => { onFormField('publishMode', value) }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {wizard.form.publishMode === 'share' && (
            <span className={css.hint}>{t('myconfigs.upload.mode.shareHint')}</span>
          )}
        </Field>
        {/* 系统自动字段（id/author/version/updatedAt 徽章，无需填写） */}
        <span className={css.hint}>{t('myconfigs.upload.form.autoHint')}</span>
        <div className={css.statRow}>
          {autoBadges.map((b) => (
            <Badge key={b.field} kind="info">{b.label}：{b.autoText}</Badge>
          ))}
        </div>
        <div className={css.actionRow}>
          <Button
            variant="primary"
            disabled={
              wizard.validated !== true || wizard.running || wizard.zipPath === null
              || !myConfigFormValid(wizard.formErrors)
            }
            onClick={() => { onRunUpload() }}
          >
            {wizard.running
              ? <Spinner label={wizard.mode === 'update' ? t('myconfigs.update.running') : t('myconfigs.upload.running')} />
              : (wizard.mode === 'update' ? t('myconfigs.update.run') : t('myconfigs.upload.run'))}
          </Button>
          {wizard.mode === 'update' && (
            <Button disabled={wizard.running || wizard.validating} onClick={onCancelUpdate}>{t('common.cancel')}</Button>
          )}
          {wizard.mode === 'upload' && <Button disabled={wizard.running} onClick={onReset}>{t('myconfigs.upload.reselect')}</Button>}
        </div>
      </>)}

      {/* R-14：向导失败提示已由全局 Toast 送达（原 wizard.error Banner 移除） */}

      {/* 结果卡：收录状态（异步）/ PR 链接 / 仓库链接 / sha256 / 分区。
          R-19：上传/更新**失败**分支已由 runUpload 的全局 Toast 告知，此处只渲染成功结果卡
          （失败分支本无其他可展示内容，故整块以 ok 守卫）。 */}
      {wizard.result !== null && wizard.result.ok && (<>
          <span className={css.groupLabel}>{t('myconfigs.result.title')}</span>
          <div className={css.statRow}>
            <Badge kind="ok">{t('myconfigs.result.version', { version: wizard.result.version })}</Badge>
            <Badge kind="info">{t('myconfigs.result.sha256', { hash: wizard.result.sha256 })}</Badge>
            <Badge kind="info">{t('myconfigs.result.sections', { sections: wizard.result.sections.join(', ') })}</Badge>
          </div>
          {/* 收录状态：pending=后台处理中（轮询中）；failed=失败可重试；done=已提交（PR 链接）。
              R-16：失败**原因**改由常驻 Toast 送达（见 notifyListingFailure），此处保留徽章 + 重试按钮 */}
          {wizard.result.listing === 'pending' && (
            <div className={css.statRow}>
              {listingStatus !== null && listingStatus.listing === 'failed' ? (
                <>
                  <Badge kind="error">{t('myconfigs.result.listingFailed')}</Badge>
                  <Button variant="danger" onClick={() => { void onRelist(wizard.result!.itemId) }}>
                    {t('myconfigs.result.relist')}
                  </Button>
                </>
              ) : (
                <Badge kind="info">{t('myconfigs.result.listingPending')}</Badge>
              )}
            </div>
          )}
          <div className={css.actionRow}>
            <Badge kind="info">{t('myconfigs.result.repo')}</Badge>
            <Button href={wizard.result.repoUrl}>{t('myconfigs.result.openRepo')}</Button>
            {(prLink !== null) && (
              <Button href={prLink.url}>{prLink.label}</Button>
            )}
          </div>
      </>)}
      </Modal.Body>
    </Modal>
  )
}
