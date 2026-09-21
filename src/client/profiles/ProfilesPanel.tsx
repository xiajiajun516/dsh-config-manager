/**
 * 「档案」面板（第 7 个 tab；DSH 自带 profile 管理）。
 *
 * 「档案」= DSH 的 profile（`$DSH_HOME/profiles/<name>`），由 src/profiles/dsh-profile-manager.ts
 * 读写（列表 / 详情 / 新建 / 重命名 / 物理删除 / 记录「下次启动」）。本视图：
 * - **列表**：形态（web/headless/自定义）、bundle 层、依赖数、patch 条目、node_modules、更新时间；
 * - **下次启动**：DSH 无法在运行中切换 profile —— 这里只写 `<dataDir>/next-profile` 标记并给出
 *   手动重启命令（`dsh --profile <name>`），由用户自己重启；
 * - **新建 / 重命名 / 删除**：删除是**物理删除**（含 node_modules），走 ConfirmDialog；
 *   删除当前运行中的档案需额外勾选确认；
 * - **详情**：package.json 与 cordis.patch.yml 原文（只读）。
 *
 * 状态组件自持（useState），同时镜像 runStore.profiles 切片（切 tab/刷新不丢列表与选择）。
 * 安全：profile 定义不含秘密值（dependencies 只有包名与 spec）；错误文本渲染前过 redact()。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { redact } from '../../security/redaction.ts'
import type { DshProfileDetail, DshProfileMeta, DshProfileSelection, DshProfileTemplate } from '../../profiles/dsh-profile-shared.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore, toProfilesStoreSlice, type ProfilesStoreSlice } from '../run-store.ts'
import { Badge, Banner, Button, Card, Checkbox, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { toast } from '../common/toast-store.ts'
import {
  bundleLines, dependencyLines, formatBytes, formatProfileTime, issueLabelKey, profileRowFacts, restartCommand,
  selectionState, shapeLabelKey, sortProfilesForDisplay, summarizeProfiles, validateProfileNameInput,
} from '../../ui/dsh-profiles-view.ts'
import css from '../config-manager.module.css'

export interface ProfilesPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

interface PanelState {
  status: 'loading' | 'ready' | 'error'
  loadError: string | null
  profiles: DshProfileMeta[]
  current: string
  selection: DshProfileSelection | null
  templates: DshProfileTemplate[]
  /** 新建表单 */
  createName: string
  createTemplate: string
  creating: boolean
  /** 重命名会话 */
  renameTarget: DshProfileMeta | null
  renameValue: string
  renaming: boolean
  /** 删除会话（物理删除，不可恢复） */
  deleteTarget: DshProfileMeta | null
  deleteCurrentConfirmed: boolean
  deleting: boolean
  /** 「下次启动」写入中 */
  selecting: boolean
  /** 详情目标（null = 未打开） */
  detailName: string | null
  actionError: string | null
}

const initial: PanelState = {
  status: 'loading',
  loadError: null,
  profiles: [],
  current: '',
  selection: null,
  templates: [],
  createName: '',
  createTemplate: 'base',
  creating: false,
  renameTarget: null,
  renameValue: '',
  renaming: false,
  deleteTarget: null,
  deleteCurrentConfirmed: false,
  deleting: false,
  selecting: false,
  detailName: null,
  actionError: null,
}

function initFromStore(): PanelState {
  const s: ProfilesStoreSlice = runStore.getSnapshot().profiles
  return {
    ...initial,
    profiles: s.profiles ?? [],
    current: s.current ?? '',
    selection: s.selection,
    // detailName 不恢复：详情原文是一次性拉取的（恢复弹窗目标只会得到一个空弹窗）
    detailName: null,
    actionError: s.error,
    loadError: s.loadError,
  }
}

/** host 侧 engine 错误码 → 文案（未知错误回退到通用模板，不显示裸英文码）。 */
const ERROR_CODES = ['exists', 'notFound', 'currentProfile', 'invalidName', 'reservedName', 'unknownTemplate'] as const

function profileErrorText(t: TranslateNS<'config-manager'>, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  for (const code of ERROR_CODES) {
    if (message === code || message.includes(code)) return t(`profiles.error.${code}`)
  }
  return t('profiles.error.generic', { message: redact(message) })
}

/** 复制文本到剪贴板（与 OverviewPanel 同一交互约定：结果以 Toast 反馈）。 */
function copyText(text: string, t: TranslateNS<'config-manager'>): void {
  try {
    const pending = navigator.clipboard?.writeText(text)
    if (pending === undefined) {
      toast.warn(t('toast.copyFailed'))
      return
    }
    void pending.then(
      () => { toast.ok(t('profiles.copied')) },
      () => { toast.warn(t('toast.copyFailed')) },
    )
  } catch {
    toast.warn(t('toast.copyFailed'))
  }
}

export function ProfilesPanel({ api, t }: ProfilesPanelProps) {
  const [state, setState] = useState<PanelState>(initFromStore)
  const stateRef = useRef<PanelState>(state)
  const mountedRef = useRef(true)
  /** 详情原文（一次性读取；非持久化） */
  const [detail, setDetail] = useState<DshProfileDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const commit = (next: PanelState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({
      profiles: toProfilesStoreSlice({
        profiles: next.profiles,
        selection: next.selection,
        current: next.current === '' ? null : next.current,
        selectedName: next.detailName,
        error: next.actionError,
        loadError: next.loadError,
      }),
    })
  }
  const patch = (p: Partial<PanelState>): void => commit({ ...stateRef.current, ...p })

  useEffect(() => () => {
    mountedRef.current = false
    const cur = stateRef.current
    runStore.patch({
      profiles: toProfilesStoreSlice({
        profiles: cur.profiles,
        selection: cur.selection,
        current: cur.current === '' ? null : cur.current,
        selectedName: cur.detailName,
        error: cur.actionError,
        loadError: cur.loadError,
      }),
    })
  }, [])

  const load = (): void => {
    patch({ status: 'loading', loadError: null })
    api.profilesList().then(
      (snapshot) => {
        const profiles = snapshot.profiles ?? []
        const cur = stateRef.current
        // 目标已消失 → 关闭详情/重命名/删除会话，避免对着幽灵档案操作
        const stillExists = (name: string | null): boolean => name !== null && profiles.some((p) => p.name === name)
        patch({
          status: 'ready',
          profiles,
          current: snapshot.current ?? '',
          selection: snapshot.selection ?? null,
          templates: snapshot.templates ?? [],
          createTemplate: (snapshot.templates ?? []).some((tp) => tp.id === cur.createTemplate) ? cur.createTemplate : 'base',
          detailName: stillExists(cur.detailName) ? cur.detailName : null,
          renameTarget: stillExists(cur.renameTarget?.name ?? null) ? cur.renameTarget : null,
          deleteTarget: stillExists(cur.deleteTarget?.name ?? null) ? cur.deleteTarget : null,
        })
      },
      (err) => {
        patch({ status: 'error', loadError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  useEffect(load, [api])

  /** 打开详情（只读；原文一次性拉取） */
  const openDetail = (profile: DshProfileMeta): void => {
    patch({ detailName: profile.name, actionError: null })
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    api.profileDetail(profile.name).then(
      (value) => {
        if (!mountedRef.current) return
        setDetail(value)
        setDetailLoading(false)
      },
      (err) => {
        if (!mountedRef.current) return
        setDetailError(profileErrorText(t, err))
        setDetailLoading(false)
      },
    )
  }

  const closeDetail = (): void => {
    patch({ detailName: null })
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
  }

  const doCreate = (): void => {
    const name = state.createName.trim()
    const issue = validateProfileNameInput(name)
    if (issue !== null) {
      patch({ actionError: nameIssueText(t, name, issue) })
      return
    }
    if (state.creating) return
    patch({ creating: true, actionError: null })
    api.profileCreate(name, state.createTemplate).then(
      (meta) => {
        patch({ creating: false, createName: '', actionError: null })
        toast.ok(t('profiles.create.done', { name: meta.name }))
        load()
      },
      (err) => {
        patch({ creating: false, actionError: profileErrorText(t, err) })
        toast.error(profileErrorText(t, err))
      },
    )
  }

  const doRename = (): void => {
    const target = state.renameTarget
    if (target === null || state.renaming) return
    const newName = state.renameValue.trim()
    const issue = validateProfileNameInput(newName)
    if (issue !== null) {
      patch({ actionError: nameIssueText(t, newName, issue) })
      return
    }
    patch({ renaming: true, actionError: null })
    api.profileRename(target.name, newName).then(
      (meta) => {
        patch({ renaming: false, renameTarget: null, renameValue: '', actionError: null })
        toast.ok(t('profiles.rename.done', { name: meta.name }))
        load()
      },
      (err) => {
        patch({ renaming: false, actionError: profileErrorText(t, err) })
      },
    )
  }

  const doDelete = (): void => {
    const target = state.deleteTarget
    if (target === null || state.deleting) return
    if (target.isCurrent && !state.deleteCurrentConfirmed) {
      patch({ actionError: t('profiles.deleteCurrentWarning') })
      return
    }
    patch({ deleting: true, actionError: null })
    api.profileDelete(target.name, { allowCurrent: target.isCurrent }).then(
      () => {
        patch({ deleting: false, deleteTarget: null, deleteCurrentConfirmed: false, actionError: null })
        toast.ok(t('profiles.delete.done', { name: target.name }))
        load()
      },
      (err) => {
        patch({ deleting: false, actionError: profileErrorText(t, err) })
      },
    )
  }

  const doSelect = (name: string | null): void => {
    if (state.selecting) return
    patch({ selecting: true, actionError: null })
    api.profileSelect(name).then(
      (selection) => {
        patch({ selecting: false, selection, actionError: null })
        toast.ok(name === null ? t('profiles.selectCleared') : t('profiles.selectDone', { name }))
      },
      (err) => {
        patch({ selecting: false, actionError: profileErrorText(t, err) })
      },
    )
  }

  const rows = sortProfilesForDisplay(state.profiles, {
    currentName: state.current === '' ? null : state.current,
    selectionName: state.selection?.name ?? null,
  })
  const summary = summarizeProfiles(state.profiles)
  const selection = state.selection
  const selState = selectionState(selection)
  const createIssue = state.createName.trim() === '' ? null : validateProfileNameInput(state.createName)

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('profiles.title')} subtitle={t('profiles.subtitle')} />

      {/* —— 当前运行 / 下次启动 —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.nextLaunch')}</div>
        <div className={css.kvRow}>
          <span className={css.kvKey}>{t('profiles.current')}</span>
          <span className={css.kvValue}>
            {state.current === '' ? '—' : <span className={css.mono}>{state.current}</span>}
          </span>
        </div>
        {selState === 'none' && <div className={css.hint}>{t('profiles.selectHint')}</div>}
        {selState === 'current' && selection !== null && (
          <Banner kind="ok">{t('profiles.selectCurrent', { name: selection.name })}</Banner>
        )}
        {selState === 'missing' && selection !== null && (
          <Banner kind="warn">
            {t('profiles.selectMissing', { name: selection.name })}
            <Button size="sm" disabled={state.selecting} onClick={() => { doSelect(null) }}>
              {t('profiles.selectClear')}
            </Button>
          </Banner>
        )}
        {selState === 'pending' && selection !== null && (
          <div className={css.actionRow}>
            <span className={css.hint}>{t('profiles.selectPending', { name: selection.name })}</span>
            <code className={css.mono}>{restartCommand(selection.name)}</code>
            <Button size="sm" onClick={() => { copyText(restartCommand(selection.name), t) }}>
              {t('profiles.copy')}
            </Button>
            <Button size="sm" variant="ghost" disabled={state.selecting} onClick={() => { doSelect(null) }}>
              {t('profiles.selectClear')}
            </Button>
          </div>
        )}
      </Card>

      {/* —— 新建档案 —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.create.title')}</div>
        <div className={css.hint}>{t('profiles.create.hint')}</div>
        <div className={css.actionRow}>
          <input
            type="text"
            className={css.input}
            placeholder={t('profiles.create.placeholder')}
            aria-label={t('profiles.create.nameLabel')}
            value={state.createName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ createName: e.target.value }) }}
          />
          <select
            className={css.select}
            aria-label={t('profiles.create.templateLabel')}
            value={state.createTemplate}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => { patch({ createTemplate: e.target.value }) }}
          >
            {state.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.id} — {template.bundles.join(' + ')}
              </option>
            ))}
          </select>
          <Button variant="primary" disabled={state.creating || state.createName.trim() === '' || createIssue !== null} onClick={doCreate}>
            {state.creating ? <Spinner label={t('profiles.create.creating')} /> : t('profiles.create.action')}
          </Button>
        </div>
        {createIssue !== null && <span className={css.formError}>{nameIssueText(t, state.createName.trim(), createIssue)}</span>}
      </Card>

      {/* —— 列表 —— */}
      {state.status === 'loading' && <Spinner label={t('profiles.loading')} />}
      {state.status === 'error' && (
        <Banner kind="error">
          {redact(state.loadError ?? t('common.unknownError'))}
          <Button size="sm" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}
      {state.status === 'ready' && state.profiles.length === 0 && <Empty>{t('profiles.empty')}</Empty>}
      {state.status === 'ready' && state.profiles.length > 0 && (
        <>
          <div className={css.listHeaderRow}>
            <span className={css.groupLabel}>{t('profiles.list.title')}</span>
            <span className={css.cellMeta}>
              {t('profiles.list.count', { count: summary.total })} ·{' '}
              {t('profiles.list.summary', { web: summary.web, headless: summary.headless, generic: summary.generic, installed: summary.withNodeModules })}
            </span>
            <Button size="sm" onClick={load}>{t('profiles.refresh')}</Button>
          </div>
          <div className={css.hint}>{t('profiles.list.hint')}</div>
          <div className={css.snapshotList} role="list" aria-label={t('profiles.list.title')}>
            {rows.map((profile) => {
              const facts = profileRowFacts(profile)
              return (
                <div key={profile.name} className={css.profileRow} role="listitem" data-selected={profile.name === state.detailName ? '' : undefined}>
                  <div className={css.profileRowHeader}>
                    {/* 整行「信息区」可点：行内只给计数，完整清单（bundle 层 / 逐条依赖 / patch 原文）在详情弹窗里 */}
                    <button type="button" className={css.profileRowMain} title={t('profiles.list.hint')} onClick={() => { openDetail(profile) }}>
                      <span className={css.profileRowTitle}>
                        <span className={`${css.mono} ${css.profileRowName}`}>{profile.name}</span>
                        <span className={css.badgeRow}>
                          {profile.isCurrent && <Badge kind="ok">{t('profiles.current')}</Badge>}
                          {selection !== null && selection.name === profile.name && !profile.isCurrent && (
                            <Badge kind="info">{t('profiles.nextLaunch')}</Badge>
                          )}
                          <Badge kind="info">{t(shapeLabelKey(profile.shape))}</Badge>
                          {profile.issues.map((issue) => (
                            <Badge key={issue} kind="error">{t(issueLabelKey(issue))}</Badge>
                          ))}
                        </span>
                      </span>
                      <span className={css.profileRowMeta}>
                        {t('profiles.row.summary', { bundles: facts.bundles, patch: facts.patchEntries, deps: facts.deps })}
                        {' · '}{facts.hasNodeModules ? t('profiles.nodeModules.yes') : t('profiles.nodeModules.no')}
                        {' · '}{profile.patchReload === 'startup' ? t('profiles.patchReload.startup') : t('profiles.patchReload.live')}
                        {profile.updatedAtMs !== null && ` · ${t('profiles.updatedAt', { time: formatProfileTime(profile.updatedAtMs) })}`}
                      </span>
                    </button>
                    <span className={css.actionRow} data-inline>
                      <Button size="sm" disabled={state.selecting} onClick={() => { doSelect(profile.name) }}>
                        {t('profiles.select')}
                      </Button>
                      <Button size="sm" onClick={() => { patch({ renameTarget: profile, renameValue: profile.name, actionError: null }) }}>
                        {t('profiles.rename')}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => { patch({ deleteTarget: profile, deleteCurrentConfirmed: false, actionError: null }) }}>
                        {t('profiles.delete')}
                      </Button>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* —— 详情弹窗（只读原文） —— */}
      <Modal open={state.detailName !== null} onClose={closeDetail} title={t('profiles.detail')} wide busy={detailLoading}>
        <Modal.Header
          title={state.detailName !== null ? t('profiles.detailTitle', { name: state.detailName }) : t('profiles.detail')}
          closeLabel={t('common.close')}
          onClose={closeDetail}
          closeDisabled={false}
        />
        <Modal.Body scroll>
          {detailLoading && <Spinner label={t('profiles.loading')} />}
          {detailError !== null && <Banner kind="error">{detailError}</Banner>}
          {detail !== null && (
            <>
              {/* 概览：行内被折叠掉的计数/状态在这里全量展开 */}
              <div className={css.groupLabel}>{t('profiles.detail.info')}</div>
              <div className={css.badgeRow}>
                <Badge kind="info">{t(shapeLabelKey(detail.shape))}</Badge>
                <Badge kind="info">{t('profiles.bundles.count', { count: detail.bundles.length })}</Badge>
                <Badge kind="info">{t('profiles.patchEntries', { count: detail.patchEntryCount })}（{formatBytes(detail.patchBytes)}）</Badge>
                <Badge kind="info">{detail.patchReload === 'startup' ? t('profiles.patchReload.startup') : t('profiles.patchReload.live')}</Badge>
                <Badge kind={detail.hasNodeModules ? 'ok' : 'warn'}>
                  {detail.hasNodeModules ? t('profiles.nodeModules.yes') : t('profiles.nodeModules.no')}
                </Badge>
                {detail.updatedAtMs !== null && <Badge kind="info">{t('profiles.updatedAt', { time: formatProfileTime(detail.updatedAtMs) })}</Badge>}
              </div>
              <div className={css.kvRow}>
                <span className={css.kvKey}>{t('profiles.dir')}</span>
                <span className={css.kvValue}><span className={css.mono}>{detail.dir}</span></span>
              </div>
              {detail.issues.length > 0 && (
                <Banner kind="warn">
                  {detail.issues.map((issue) => <div key={issue}>{t(issueLabelKey(issue))}</div>)}
                </Banner>
              )}
              <div className={css.kvRow}>
                <span className={css.kvKey}>{t('profiles.bundles')}</span>
                <span className={css.kvValue}>
                  {bundleLines(detail).length === 0
                    ? t('profiles.bundles.none')
                    : (
                      <span className={css.detailLines}>
                        {bundleLines(detail).map((line, index) => (
                          <span key={line} className={css.mono}>{index + 1}. {line}</span>
                        ))}
                      </span>
                    )}
                </span>
              </div>
              {dependencyLines(detail).length > 0 && (
                <div className={css.kvRow}>
                  <span className={css.kvKey}>{t('profiles.deps')}</span>
                  <span className={css.kvValue}>
                    <span className={css.detailLines}>
                      {dependencyLines(detail).map((line) => (
                        <span key={line} className={css.mono}>{line}</span>
                      ))}
                    </span>
                  </span>
                </div>
              )}
              <div className={css.groupLabel}>{t('profiles.detail.manifest')}</div>
              <div className={css.reportScroll}>
                {/* 档案原文一律先过 redact()：package.json 的依赖 spec 可能内联私有源/令牌 */}
                <pre className={css.reportText}>{redact(detail.manifest ?? '')}</pre>
              </div>
              <div className={css.groupLabel}>{t('profiles.detail.patch')}</div>
              <div className={css.reportScroll}>
                {/* cordis.patch.yml 可能内联字面量密钥（!!js 表达式旁），同样先脱敏 */}
                <pre className={css.reportText}>{detail.patch !== null ? redact(detail.patch) : (detail.patchBytes > 0 ? t('profiles.detail.patchTooLarge') : t('profiles.detail.patchMissing'))}</pre>
              </div>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={closeDetail}>{t('common.close')}</Button>
        </Modal.Footer>
      </Modal>

      {/* —— 重命名 —— */}
      {state.renameTarget !== null && (
        <ConfirmDialog
          open
          title={t('profiles.renameTitle')}
          message={t('profiles.renameMessage', { name: state.renameTarget.name })}
          confirmLabel={t('profiles.rename')}
          cancelLabel={t('common.cancel')}
          busy={state.renaming}
          onConfirm={doRename}
          onCancel={() => { patch({ renameTarget: null, renameValue: '', actionError: null }) }}
        >
          <input
            type="text"
            className={css.input}
            value={state.renameValue}
            aria-label={t('profiles.renameTitle')}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ renameValue: e.target.value }) }}
          />
          {state.actionError !== null && <span className={css.formError}>{state.actionError}</span>}
        </ConfirmDialog>
      )}

      {/* —— 删除（物理删除，不可恢复） —— */}
      <ConfirmDialog
        open={state.deleteTarget !== null}
        title={t('profiles.deleteTitle')}
        message={state.deleteTarget !== null
          ? `${t('profiles.deleteMessage', { name: state.deleteTarget.name })}${state.deleteTarget.isCurrent ? `\n\n${t('profiles.deleteCurrentWarning')}` : ''}`
          : undefined}
        confirmLabel={t('profiles.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.deleting}
        onConfirm={doDelete}
        onCancel={() => { patch({ deleteTarget: null, deleteCurrentConfirmed: false, actionError: null }) }}
      >
        {state.deleteTarget?.isCurrent === true && (
          <Checkbox
            checked={state.deleteCurrentConfirmed}
            onChange={(checked: boolean) => { patch({ deleteCurrentConfirmed: checked, actionError: null }) }}
            label={t('profiles.deleteCurrentConfirm')}
          />
        )}
        {state.actionError !== null && <span className={css.formError}>{state.actionError}</span>}
      </ConfirmDialog>

      {/* —— 表单级错误（无弹窗时也要可见） —— */}
      {state.actionError !== null && state.renameTarget === null && state.deleteTarget === null && (
        <Banner kind="error">{state.actionError}</Banner>
      )}
    </div>
  )
}

/** 名称校验码 → 文案（保留名文案带 {name} 占位）。 */
function nameIssueText(t: TranslateNS<'config-manager'>, name: string, issue: 'required' | 'tooLong' | 'illegal' | 'reserved'): string {
  if (issue === 'required') return t('profiles.nameRequired')
  if (issue === 'tooLong') return t('profiles.nameTooLong')
  if (issue === 'reserved') return t('profiles.nameReserved', { name })
  return t('profiles.nameInvalid')
}
