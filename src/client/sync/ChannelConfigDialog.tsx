/**
 * t42 物理拆分（从 SyncSettingsView.tsx 拆出的渲染段，同领域目录平铺；v2 第 5 步主文件改名 SyncPanel.tsx）。
 *
 * 约定：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用仍由
 * SyncPanel 持有（单一状态源）；可测纯逻辑在 src/ui/sync-settings-view.ts。
 */
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Banner, Button, Checkbox, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Modal } from '../common/Modal.tsx'
import { Select } from '../common/Select.tsx'
import { SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF } from './sync-api.ts'
import type { SyncApi, SyncStatusResponse } from './sync-api.ts'
import { SyncRepositoryPicker } from './SyncRepositoryPicker.tsx'
import {
  cloudIssueKey, cloudSecretRefName, presetById, presetIdForUrl, privateRepoHint,
  S3_PROVIDER_LABEL_KEY, SYNC_CHANNEL_LABEL_KEY, WEBDAV_PRESETS,
} from './sync-view.ts'
import { GIST_LARGE_SECTION_HINT_KEY } from './sync-view.ts'
import type { GithubLoginView } from './sync-view.ts'
import { S3_PROVIDERS } from '../../ui/sync-settings-view.ts'
import type { CloudFormIssue, SyncFormSnapshot } from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/** 通道配置弹窗的表单字段补丁（onFormChange 入参：git/webdav + 云端点两组）。 */
export type ChannelFormPatch = {
  repoUrl?: string
  token?: string
  webdavUrl?: string
  webdavUsername?: string
  webdavPassword?: string
  s3Provider?: string
  s3Endpoint?: string
  s3Region?: string
  s3Bucket?: string
  s3Prefix?: string
  s3AccessKeyId?: string
  s3PathStyle?: boolean
  s3Secret?: string
  gistId?: string
  gistApiBaseUrl?: string
  gistFilePrefix?: string
  gistToken?: string
}

/**
 * 通道配置弹窗（**按打开它的通道**渲染 git / webdav / s3 / gist 四选一表单 + GitHub 登录 + 保存）。
 * 弹窗内不再提供通道切换（子 tab 已移除）：换通道 = 回页面上点另一张通道卡的「配置」。
 * 拆出的职责单元只接收「渲染所需数据 + 回调」：`onFormChange` 由父组件实现为
 * 「patch 表单 + 防抖自动保存」—— 防抖定时器与卸载 flush 仍归父组件（单一状态源）。
 */
export function ChannelConfigDialog({ open, onClose, api, t, uiT, form, cloudIssues, busy, savingConfig, remoteReady, statusInfo, githubSignedIn, githubView, onFormChange, onGithubStart, onGithubCancel, onSave }: {
  open: boolean
  onClose: () => void
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
  /**
   * 当前激活通道的**完整表单快照**（git / webdav / s3 / gist 四组字段都在内）。
   * 为什么整份传入而不是逐个 prop：加一条通道就要在 props 里再铺 7~10 行，弹窗与壳层同时膨胀；
   * `SyncFormSnapshot` 是 ui 层既有契约（组装与校验都以它为准），这里只做渲染。
   */
  form: SyncFormSnapshot
  /** 云端点表单的校验问题（git/webdav 恒为空表）：内联横幅逐条给出可读原因，绝不渲染裸码 */
  cloudIssues: readonly CloudFormIssue[]
  busy: boolean
  savingConfig: boolean
  remoteReady: boolean
  statusInfo: SyncStatusResponse | null
  githubSignedIn: boolean | null
  githubView: GithubLoginView
  onFormChange: (patch: ChannelFormPatch) => void
  onGithubStart: () => void
  onGithubCancel: () => void
  onSave: () => void
}) {
  const channel = form.channel
  const {
    repoUrl, token, webdavUrl, webdavUsername, webdavPassword,
    s3Provider, s3Endpoint, s3Region, s3Bucket, s3Prefix, s3AccessKeyId, s3PathStyle, s3Secret,
    gistId, gistApiBaseUrl, gistFilePrefix, gistToken,
  } = form
  /** 密钥槽位引用名（与宿主 cloudSecretRef 同构；只用于提示文案，值从不经过前端） */
  const cloudSecretRef = cloudSecretRefName(channel)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('channel.title')}
      wide
      busy={savingConfig}
    >
      <Modal.Header
        title={t('channel.title')}
        closeLabel={t('common.close')}
        onClose={onClose}
        closeDisabled={savingConfig}
        // 通道身份徽章 + 弹窗级说明：贴在标题右边，不单独成行
        // （子 tab 已移除，弹窗只配置**打开它的那条通道** —— 通道切换在页面的两张通道卡上做）
        trailing={<><Badge kind="info">{t(SYNC_CHANNEL_LABEL_KEY[channel])}</Badge> <InfoHint text={t('channel.perChannelHint')} label={t('common.infoHint')} /></>}
      />
      <Modal.Body scroll>

    {/* 私有仓库强制提示：仅 git 通道适用 */}
    {channel === 'git' && <Banner kind="warn">{privateRepoHint(uiT)}</Banner>}

      {/* git 通道分支 */}
      {channel === 'git' && (
        <>
          <span className={css.groupLabel}>{t('config.title')}</span>
          {/* 仓库选择器：选择已有私有仓库 / 新建私有仓库（手填地址仍保留在下方 —— ssh、
              本地路径、不在列表里的仓库都得能填） */}
          <SyncRepositoryPicker
            open={open}
            api={api}
            t={t}
            repoUrl={repoUrl}
            busy={busy}
            onPick={(cloneUrl) => { onFormChange({ repoUrl: cloneUrl }) }}
          />
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('config.repoUrl')} <InfoHint text={t('config.repoUrlHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={repoUrl}
              placeholder="https://github.com/user/private-repo.git"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ repoUrl: e.target.value }) // 改动自动保存（防抖；关闭设置页不丢输入）
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('config.token')}
              {' '}
              {statusInfo?.credentialConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
              <InfoHint text={t('config.tokenHint', { ref: SYNC_CREDENTIAL_REF })} label={t('common.infoHint')} />
            </span>
            <input
              type="password"
              className={css.input}
              value={token}
              autoComplete="off"
              placeholder={t('config.tokenPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ token: e.target.value })
              }}
            />
          </label>

          {/* GitHub OAuth 登录（device flow）：弹窗内仅 git 通道显示；已登录（token 有效）时整块隐藏 */}
          {githubSignedIn === false && (
            <>
              {statusInfo?.credentialConfigured === true && (
                <Banner kind="warn">{t('github.tokenInvalid')}</Banner>
              )}
              <span className={css.groupLabel}>{t('github.title')} <InfoHint text={t('github.description')} label={t('common.infoHint')} /></span>
              {githubView.showCode && (
                <div className={css.statRow}>
                  <Badge kind="info">{t('github.userCode')}{t('common.labelSeparator')}<strong>{githubView.userCode}</strong></Badge>
                  <a
                    className={css.ghostButton}
                    href={githubView.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: 'none' }}
                  >
                    {t('github.openAuth')}
                  </a>
                </div>
              )}
              <div className={css.actionRow}>
                <Button
                  variant="primary"
                  disabled={!githubView.canStart || busy}
                  onClick={() => { void onGithubStart() }}
                >
                  {githubView.startLabel}
                </Button>
                {githubView.canCancel && (
                  <Button disabled={busy} onClick={() => { void onGithubCancel() }}>
                    {t('github.cancel')}
                  </Button>
                )}
              </div>
              <div className={css.statRow}>
                <Badge kind={githubView.phase === 'success' ? 'ok' : githubView.phase === 'error' ? 'error' : 'warn'}>
                  {githubView.statusText}
                </Badge>
              </div>
            </>
          )}
        </>
      )}

      {/* webdav 通道分支 */}
      {channel === 'webdav' && (
        <>
          <span className={css.groupLabel}>{t('webdav.title')}</span>
          {/* 常见 WebDAV 服务器预设：选择后填充 url 模板（含占位符待替换）。
              ⓘ 与控件**同一行**（.controlRow：控件按自身宽度，ⓘ 保持自身尺寸）。 */}
          <div className={css.controlRow}>
            <Select
              value={presetIdForUrl(webdavUrl)}
              disabled={busy}
              ariaLabel={t('webdav.presetHint')}
              onChange={(next) => {
                const preset = presetById(next)
                onFormChange({ webdavUrl: preset.url })
              }}
              options={WEBDAV_PRESETS.map((preset) => ({ value: preset.id, label: t(preset.labelKey) }))}
            />
            <InfoHint text={t('webdav.presetHint')} label={t('common.infoHint')} />
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('webdav.url')} <InfoHint text={t('webdav.urlHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={webdavUrl}
              placeholder="https://dav.example.com/dav/config"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavUrl: e.target.value })
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('webdav.username')}
              {' '}
              {statusInfo?.webdav?.usernameConfigured === true && <Badge kind="ok">{t('config.tokenSaved')}</Badge>}
              {' '}
              <InfoHint text={t('webdav.usernameHint')} label={t('common.infoHint')} />
            </span>
            <input
              type="text"
              className={css.input}
              value={webdavUsername}
              autoComplete="off"
              placeholder="alice"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavUsername: e.target.value })
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('webdav.password')}
              {' '}
              {statusInfo?.webdav?.passwordConfigured === true && <Badge kind="ok">{t('webdav.passwordSaved')}</Badge>}
              <InfoHint text={t('webdav.passwordHint', { ref: SYNC_WEBDAV_CREDENTIAL_REF })} label={t('common.infoHint')} />
            </span>
            <input
              type="password"
              className={css.input}
              value={webdavPassword}
              autoComplete="off"
              placeholder={t('webdav.passwordPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                onFormChange({ webdavPassword: e.target.value })
              }}
            />
          </label>
        </>
      )}

      {/* s3 通道分支（S3 兼容系五家共用一条通道；密钥只写 DSH 凭据槽位） */}
      {channel === 's3' && (
        <>
          <span className={css.groupLabel}>{t('cloud.s3Title')}</span>
          {/* 兼容商：五家共用同一套 SigV4 实现，差异只在端点与寻址风格 */}
          <div className={css.controlRow}>
            <Select
              value={s3Provider}
              disabled={busy}
              ariaLabel={t('cloud.provider')}
              onChange={(next) => { onFormChange({ s3Provider: next }) }}
              options={S3_PROVIDERS.map((p) => ({ value: p, label: t(S3_PROVIDER_LABEL_KEY[p]) }))}
            />
            <InfoHint text={t('cloud.providerHint')} label={t('common.infoHint')} />
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.endpoint')} <InfoHint text={t('cloud.endpointHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={s3Endpoint}
              placeholder="https://s3.us-east-1.amazonaws.com"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3Endpoint: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.region')} <InfoHint text={t('cloud.regionHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={s3Region}
              placeholder="us-east-1"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3Region: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.bucket')} <InfoHint text={t('cloud.bucketHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={s3Bucket}
              placeholder="dsh-config-manager"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3Bucket: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.prefix')} <InfoHint text={t('cloud.prefixHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={s3Prefix}
              placeholder="dsh-config-manager"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3Prefix: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.accessKeyId')} <InfoHint text={t('cloud.accessKeyIdHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={s3AccessKeyId}
              autoComplete="off"
              placeholder="AKIA…"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3AccessKeyId: e.target.value }) }}
            />
          </label>
          <div className={css.controlRow}>
            <Checkbox
              checked={s3PathStyle}
              disabled={busy}
              label={t('cloud.pathStyle')}
              onChange={(next) => { onFormChange({ s3PathStyle: next }) }}
            />
            <InfoHint text={t('cloud.pathStyleHint')} label={t('common.infoHint')} />
          </div>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('cloud.secret')}
              {' '}
              {statusInfo?.s3?.secretStored === true && <Badge kind="ok">{t('cloud.secretSaved')}</Badge>}
              <InfoHint text={t('cloud.secretHint', { ref: cloudSecretRef })} label={t('common.infoHint')} />
            </span>
            <input
              type="password"
              className={css.input}
              value={s3Secret}
              autoComplete="off"
              placeholder={t('cloud.secretPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ s3Secret: e.target.value }) }}
            />
          </label>
        </>
      )}

      {/* gist 通道分支（GitHub Gist：走 REST，token 只写 DSH 凭据槽位） */}
      {channel === 'gist' && (
        <>
          {/* G-34：gist 刻意不外置 blob（一次 GET 全量 / 单文件超限截断 / 文件数上限）⇒ 大分区不适合走 gist；
              该说明属机制类，收进标题 ⓘ（2026-10-12 用户要求） */}
          <span className={css.groupLabel}>{t('cloud.gistTitle')} <InfoHint text={t(GIST_LARGE_SECTION_HINT_KEY)} label={t('common.infoHint')} /></span>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.gistId')} <InfoHint text={t('cloud.gistIdHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={gistId}
              autoComplete="off"
              placeholder="0123456789abcdef"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ gistId: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.apiBaseUrl')} <InfoHint text={t('cloud.apiBaseUrlHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={gistApiBaseUrl}
              placeholder="https://api.github.com"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ gistApiBaseUrl: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('cloud.filePrefix')} <InfoHint text={t('cloud.filePrefixHint')} label={t('common.infoHint')} /></span>
            <input
              type="text"
              className={css.input}
              value={gistFilePrefix}
              placeholder="dsh-sync"
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ gistFilePrefix: e.target.value }) }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>
              {t('cloud.token')}
              {' '}
              {statusInfo?.gist?.secretStored === true && <Badge kind="ok">{t('cloud.tokenSaved')}</Badge>}
              <InfoHint text={t('cloud.tokenHint', { ref: cloudSecretRef })} label={t('common.infoHint')} />
            </span>
            <input
              type="password"
              className={css.input}
              value={gistToken}
              autoComplete="off"
              placeholder={t('cloud.tokenPlaceholder')}
              disabled={busy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { onFormChange({ gistToken: e.target.value }) }}
            />
          </label>
        </>
      )}

      {/* 云端点表单校验：逐条给出可读原因（码 → 字典键唯一映射，绝不渲染裸码） */}
      {cloudIssues.length > 0 && (
        <Banner kind="error">
          {t('cloud.invalidTitle')}{' '}
          {cloudIssues.map((issue) => t(cloudIssueKey(issue.code) ?? 'cloud.invalidTitle')).join(' · ')}
        </Banner>
      )}

      {/* 配置保存：改动自动保存（防抖，静默）；按钮立即保存并给出 Toast 回执（announce=true） */}
      <div className={css.actionRow}>
        <Button
          variant="primary"
          disabled={busy || savingConfig || !remoteReady}
          onClick={() => { onSave() }}
        >
          {savingConfig ? <Spinner label={t('config.saving')} /> : t('config.save')}
        </Button>
        <InfoHint text={t('config.saveHint')} label={t('common.infoHint')} />
      </div>
      </Modal.Body>
    </Modal>
  )
}
