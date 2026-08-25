/**
 * 配置档案面板（第 7 个 tab「配置文件」；m-profiles）。
 *
 * Profile = 用户在 DSH 中的一组配置快照（Work / Personal / …），由 src/profiles/
 * 的 ProfileManager 管理（save/list/delete/rename/switch）。本视图：
 * - **保存当前配置**：输入名 → POST /profiles/save（复用 adapter.export，天然不含秘密值）；
 * - **切换**：点「切换预览」→ 只读 preview（零写入）→ 确认弹窗 → executeSwitch
 *   （confirm 安全阀 + 自动快照 + 失败整体回滚，与导入同一语义）；
 * - **重命名 / 删除**：危险操作删除走 ConfirmDialog；
 * - **导入**：上传 profile.json 文本（JSON 字段 content）→ POST /profiles/import。
 *
 * 状态组件自持（useState），同时镜像 runStore.profiles 切片（切 tab/刷新不丢列表/预览/结果）。
 * 安全：Profile 天然不含秘密值（Save 走 adapter.export 脱敏）；重命名/删除/切换均确认。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ProfileMeta, ProfileSwitchResult, SwitchPreview } from '../../profiles/profile-manager.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore, toProfilesStoreSlice, type ProfilesStoreSlice } from '../run-store.ts'
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner } from '../common/ui.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { profileSwitchKind, summarizeSwitchPreview, validateProfileNameInput } from '../../ui/profiles-view.ts'
import { groupPlanItems } from '../../ui/backup-inspect.ts'
import type { InspectGroupKey } from '../../ui/backup-inspect.ts'
import css from '../config-manager.module.css'

export interface ProfilesPanelProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
}

interface PanelState {
  status: 'loading' | 'ready' | 'error'
  loadError: string | null
  profiles: ProfileMeta[]
  /** 保存新档案的表单名 */
  saveName: string
  saving: boolean
  /** 切换流程：当前预览目标 + preview（null = 无预览会话）；执行中 */
  previewName: string | null
  preview: SwitchPreview | null
  previewing: boolean
  switching: boolean
  switchResult: ProfileSwitchResult | null
  /** 重命名目标（null = 无重命名会话） */
  renameTarget: ProfileMeta | null
  renameValue: string
  renaming: boolean
  /** 删除确认目标（null = 无删除会话） */
  deleteTarget: ProfileMeta | null
  deleting: boolean
  /** 导入会话：导入文件名 → 读入 content 待确认 */
  importError: string | null
  actionError: string | null
}

const initial: PanelState = {
  status: 'loading',
  loadError: null,
  profiles: [],
  saveName: '',
  saving: false,
  previewName: null,
  preview: null,
  previewing: false,
  switching: false,
  switchResult: null,
  renameTarget: null,
  renameValue: '',
  renaming: false,
  deleteTarget: null,
  deleting: false,
  importError: null,
  actionError: null,
}

function initFromStore(): PanelState {
  const s: ProfilesStoreSlice = runStore.getSnapshot().profiles
  return {
    ...initial,
    profiles: s.profiles ?? [],
    previewName: s.selectedName,
    preview: s.preview,
    switchResult: s.switchResult,
    actionError: s.error,
    loadError: s.loadError,
  }
}

export function ProfilesPanel({ api, t }: ProfilesPanelProps) {
  const [state, setState] = useState<PanelState>(initFromStore)
  const stateRef = useRef<PanelState>(state)
  const mountedRef = useRef(true)

  const commit = (next: PanelState): void => {
    stateRef.current = next
    if (mountedRef.current) setState(next)
    runStore.patch({
      profiles: toProfilesStoreSlice({
        profiles: next.profiles,
        selectedName: next.previewName,
        preview: next.preview,
        switchResult: next.switchResult,
        error: next.actionError,
        loadError: next.loadError,
      }),
    })
  }
  const patch = (p: Partial<PanelState>): void => commit({ ...stateRef.current, ...p })

  useEffect(() => () => {
    mountedRef.current = false
    runStore.patch({
      profiles: toProfilesStoreSlice({
        profiles: stateRef.current.profiles,
        selectedName: stateRef.current.previewName,
        preview: stateRef.current.preview,
        switchResult: stateRef.current.switchResult,
        error: stateRef.current.actionError,
        loadError: stateRef.current.loadError,
      }),
    })
  }, [])

  const load = (): void => {
    patch({ status: 'loading', loadError: null })
    api.profilesList().then(
      (profiles) => {
        patch({ status: 'ready', profiles })
        // 列表刷新后过滤失效的选择/预览目标
        if (stateRef.current.previewName !== null && !profiles.some((p) => p.name === stateRef.current.previewName)) {
          patch({ previewName: null, preview: null, switchResult: null })
        }
      },
      (err) => {
        patch({ status: 'error', loadError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  useEffect(load, [api])

  /** 保存当前配置为新 Profile（输入名校验；成功后刷新列表并清空输入） */
  const doSave = (): void => {
    const name = state.saveName.trim()
    const invalid = validateProfileNameInput(name)
    if (invalid !== null) {
      patch({ actionError: invalid })
      return
    }
    if (state.saving) return
    patch({ saving: true, actionError: null })
    api.profileSave(name).then(
      (meta) => {
        patch({ saving: false, saveName: '', actionError: null })
        void meta
        load()
      },
      (err) => {
        patch({ saving: false, actionError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  /** 切换预览（只读，零写入）：分析切换到该 Profile 会产生的计划项 */
  const runPreview = (profile: ProfileMeta): void => {
    patch({ previewName: profile.name, previewing: true, preview: null, switchResult: null, actionError: null })
    api.profileAnalyzeSwitch(profile.name).then(
      (preview) => {
        patch({ previewing: false, preview })
      },
      (err) => {
        patch({ previewing: false, previewName: null, actionError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  /** 执行切换（confirm 安全阀 + 自动快照 + 失败回滚） */
  const doSwitch = (): void => {
    const name = state.previewName
    if (name === null || state.switching) return
    patch({ switching: true, actionError: null })
    api.profileExecuteSwitch(name, { rollbackOnError: true }).then(
      (result) => {
        patch({ switching: false, switchResult: result })
      },
      (err) => {
        patch({ switching: false, actionError: err instanceof Error ? err.message : String(err) })
      },
    ).finally(() => {
      // 切换完成后面板保持（结果展示在预览卡内）；刷新列表时间戳
      load()
    })
  }

  /** 关闭预览弹窗（放弃本次切换会话） */
  const closePreview = (): void => {
    if (state.switching) return
    patch({ previewName: null, preview: null, switchResult: null })
  }

  /** 重命名（目录级移动） */
  const doRename = (): void => {
    const target = state.renameTarget
    if (target === null || state.renaming) return
    const newName = state.renameValue.trim()
    const invalid = validateProfileNameInput(newName)
    if (invalid !== null) {
      patch({ actionError: invalid })
      return
    }
    patch({ renaming: true, actionError: null })
    api.profileRename(target.name, newName).then(
      () => {
        patch({ renaming: false, renameTarget: null, renameValue: '', actionError: null })
        load()
      },
      (err) => {
        patch({ renaming: false, actionError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  /** 删除 Profile（危险操作：该组配置快照不可恢复） */
  const doDelete = (): void => {
    const target = state.deleteTarget
    if (target === null || state.deleting) return
    patch({ deleting: true, actionError: null })
    api.profileDelete(target.name).then(
      () => {
        patch({ deleting: false, deleteTarget: null, actionError: null })
        // 删除的是当前预览目标 → 清空会话
        if (stateRef.current.previewName === target.name) {
          patch({ previewName: null, preview: null, switchResult: null })
        }
        load()
      },
      (err) => {
        patch({ deleting: false, actionError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  /** 导入 Profile（读 JSON 文本 → 确认 → import） */
  const importFile = (file: File | undefined): void => {
    if (file === undefined) return
    patch({ importError: null, actionError: null })
    file.text().then(
      (content) => {
        // 取「文件名去 .json 后缀」作默认目标名；空名回退 'imported'
        const stem = file.name.replace(/\.json$/i, '').trim() || 'imported'
        api.profileImport(content, stem).then(
          (meta) => {
            void meta
            load()
          },
          (err) => {
            patch({ importError: err instanceof Error ? err.message : String(err) })
          },
        )
      },
      (err) => {
        patch({ importError: err instanceof Error ? err.message : String(err) })
      },
    )
  }

  const saveInvalid = validateProfileNameInput(state.saveName.trim()) !== null && state.saveName.trim() !== ''

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('profiles.title')} subtitle={t('profiles.subtitle')} />

      {/* —— 保存当前配置为 Profile —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.save.title')}</div>
        <div className={css.hint}>{t('profiles.save.hint')}</div>
        <div className={css.actionRow}>
          <input
            type="text"
            className={css.input}
            placeholder={t('profiles.save.placeholder')}
            value={state.saveName}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ saveName: e.target.value }) }}
          />
          <Button variant="primary" disabled={state.saving || state.saveName.trim() === ''} onClick={doSave}>
            {state.saving ? <Spinner label={t('profiles.save.saving')} /> : t('profiles.save.action')}
          </Button>
        </div>
        {saveInvalid && <span className={css.formError}>{t('profiles.nameInvalid')}</span>}
        {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}
      </Card>

      {/* —— Profile 列表 —— */}
      {state.status === 'loading' && <Spinner label={t('profiles.loading')} />}
      {state.status === 'error' && (
        <Banner kind="error">
          {state.loadError ?? t('common.unknownError')}
          <Button variant="primary" onClick={load}>{t('common.retry')}</Button>
        </Banner>
      )}
      {state.status === 'ready' && state.profiles.length === 0 && (
        <Empty>{t('profiles.empty')}</Empty>
      )}
      {state.status === 'ready' && state.profiles.length > 0 && (
        <div className={css.snapshotList} role="list" aria-label={t('profiles.title')}>
          <div className={css.profileRowHeader}>
            <span>{t('profiles.name')}</span>
            <span>{t('profiles.sections')}</span>
            <span>{t('profiles.updatedAt')}</span>
            <span>{t('snapshots.actions')}</span>
          </div>
          {state.profiles.map((profile) => (
            <div key={profile.name} className={css.profileRow} role="listitem">
              <button
                type="button"
                className={css.profileRowMain}
                onClick={() => { runPreview(profile) }}
                title={t('profiles.previewHint')}
              >
                <span title={profile.name}>{profile.name}</span>
                <span>
                  {profile.sections.slice(0, 4).join(', ')}
                  {profile.sections.length > 4 ? ` +${profile.sections.length - 4}` : ''}
                </span>
                <span>{new Date(profile.updatedAt).toLocaleString()}</span>
              </button>
              <span className={css.actionRow}>
                <Button onClick={() => { runPreview(profile) }}>{t('profiles.switch')}</Button>
                <Button
                  onClick={() => { patch({ renameTarget: profile, renameValue: profile.name, actionError: null }) }}
                >
                  {t('profiles.rename')}
                </Button>
                <Button variant="danger" onClick={() => { patch({ deleteTarget: profile, actionError: null }) }}>
                  {t('profiles.delete')}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* —— 导入 Profile —— */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.import.title')}</div>
        <div className={css.hint}>{t('profiles.import.hint')}</div>
        <input
          type="file"
          accept=".json,application/json"
          className={css.hiddenFile}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            importFile(file)
          }}
        />
        <div className={css.actionRow}>
          <Button onClick={() => { (document.querySelector<HTMLInputElement>(`input[type="file"][accept=".json,application/json"]`))?.click() }}>
            {t('profiles.import.choose')}
          </Button>
        </div>
        {state.importError !== null && <Banner kind="error">{state.importError}</Banner>}
      </Card>

      {/* —— 切换预览弹窗（只读 → 确认执行） —— */}
      {(state.previewName !== null && (state.preview !== null || state.previewing || state.switchResult !== null))
        && (
          <div
            className={css.dialogMask}
            onMouseDown={(e) => { if (e.target === e.currentTarget && !state.switching) closePreview() }}
          >
            <div className={`${css.dialogCard} ${css.dialogWide}`} role="dialog" aria-modal="true" aria-label={t('profiles.switch')}>
              <div className={css.dialogHeaderRow}>
                <span className={css.dialogHeader}>{t('profiles.switchPreviewTitle', { name: state.previewName })}</span>
                <button
                  type="button"
                  className={css.dialogClose}
                  aria-label={t('common.close')}
                  disabled={state.switching}
                  onClick={closePreview}
                >
                  ×
                </button>
              </div>
              <div className={css.dialogBodyScroll}>
                {state.previewing && <Spinner label={t('profiles.previewing')} />}
                {state.preview !== null && (
                  <SwitchPreviewCard preview={state.preview} t={t} />
                )}
                {state.switchResult !== null && (
                  <ProfileSwitchResultCard result={state.switchResult} t={t} />
                )}
                <div className={css.actionRow}>
                  <Button variant="ghost" disabled={state.switching} onClick={closePreview}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={state.switching || state.preview === null || !state.preview.items.some((i) => i.kind !== 'Skip')}
                    onClick={doSwitch}
                  >
                    {state.switching ? <Spinner label={t('profiles.switching')} /> : t('profiles.switchConfirm')}
                  </Button>
                </div>
                {state.actionError !== null && <Banner kind="error">{state.actionError}</Banner>}
              </div>
            </div>
          </div>
        )}

      {/* —— 重命名弹窗 —— */}
      {state.renameTarget !== null && (
        <ConfirmDialog
          open
          title={t('profiles.renameTitle')}
          message={t('profiles.renameMessage', { name: state.renameTarget.name })}
          confirmLabel={t('profiles.rename')}
          cancelLabel={t('common.cancel')}
          busy={state.renaming}
          onConfirm={doRename}
          onCancel={() => { patch({ renameTarget: null, renameValue: '' }) }}
        >
          <input
            type="text"
            className={css.input}
            value={state.renameValue}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { patch({ renameValue: e.target.value }) }}
          />
        </ConfirmDialog>
      )}

      {/* —— 删除确认弹窗（危险操作） —— */}
      <ConfirmDialog
        open={state.deleteTarget !== null}
        title={t('profiles.deleteTitle')}
        message={state.deleteTarget !== null ? t('profiles.deleteMessage', { name: state.deleteTarget.name }) : undefined}
        confirmLabel={t('profiles.delete')}
        cancelLabel={t('common.cancel')}
        danger
        busy={state.deleting}
        onConfirm={doDelete}
        onCancel={() => { patch({ deleteTarget: null }) }}
      />
    </div>
  )
}

/* ------------------------------------------------ 视图子组件 */

/**
 * 切换预览内容（与备份文件「查看/对比」预览同构，2026-08-25）：
 * 三分区 = 分区清单（Badge 流）→ 差异摘要（将变更/已一致/冲突/需补录/重启）
 * → 变更明细分组（冲突→变更→路径映射→已一致→其他，带颜色 kindTag，限高内滚）。
 * 渲染模型来自 src/ui/profiles-view.ts 纯函数 + 备份 diff 共用 groupPlanItems 分组。
 */
function SwitchPreviewCard({ preview, t }: {
  preview: SwitchPreview
  t: TranslateNS<'config-manager'>
}) {
  const s = summarizeSwitchPreview(preview)
  const groups = groupPlanItems(preview.items)
  // 分组标题字典键（与备份查看/对比弹窗共用同一组文案键）
  const groupLabelKey = (key: InspectGroupKey): 'backupFiles.inspectGroup.conflicts' | 'backupFiles.inspectGroup.changes' | 'backupFiles.inspectGroup.paths' | 'backupFiles.inspectGroup.skipped' | 'backupFiles.inspectGroup.others' => {
    switch (key) {
      case 'conflicts': return 'backupFiles.inspectGroup.conflicts'
      case 'changes': return 'backupFiles.inspectGroup.changes'
      case 'paths': return 'backupFiles.inspectGroup.paths'
      case 'skipped': return 'backupFiles.inspectGroup.skipped'
      case 'others': return 'backupFiles.inspectGroup.others'
    }
  }
  const kindTagClass = (kind: 'error' | 'info' | 'warn' | 'ok'): string => {
    switch (kind) {
      case 'error': return css.kindTagError ?? ''
      case 'warn': return css.kindTagWarn ?? ''
      case 'ok': return css.kindTagOk ?? ''
      case 'info': return css.kindTagInfo ?? ''
    }
  }
  return (
    <div>
      {/* 差异摘要（切到这个档案会动你什么） */}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('profiles.previewSummary')}</div>
        <div className={css.statRow}>
          <Badge kind="info">{t('profiles.previewWillChange', { count: String(s.willChange) })}</Badge>
          {s.unchanged > 0 && <Badge kind="ok">{t('profiles.previewUnchanged', { count: String(s.unchanged) })}</Badge>}
          {s.conflicts > 0 && <Badge kind="error">{t('profiles.previewConflicts', { count: String(s.conflicts) })}</Badge>}
          {s.secretsNeeded > 0 && <Badge kind="warn">{t('profiles.previewSecrets', { count: String(s.secretsNeeded) })}</Badge>}
          {s.needsRestart && <Badge kind="warn">{t('profiles.previewRestart')}</Badge>}
        </div>
        <div className={css.hint}>{t('profiles.previewNote')}</div>
      </Card>

      {/* 分区清单（档案包含的分区） */}
      {s.sectionsInProfile.length > 0 && (
        <Card className={css.card}>
          <div className={css.groupLabel}>{t('profiles.previewSections')}</div>
          <div className={css.statRow}>
            {s.sectionsInProfile.map((section) => <Badge key={section} kind="info">{section}</Badge>)}
          </div>
        </Card>
      )}

      {/* 变更明细分组（与备份查看/对比同视觉：冲突红色 / 变更蓝色 / 路径黄色 / 已一致绿色 / 其他） */}
      {groups.length > 0 && (
        <Card className={css.card}>
          <div className={css.groupLabel}>{t('profiles.previewItems')}</div>
          {groups.map((group) => (
            <div key={group.key} className={css.inspectGroup}>
              <div className={css.statRow}>
                <span className={css.groupLabel}>{t(groupLabelKey(group.key))}</span>
                <Badge kind={group.kind}>{String(group.items.length)}</Badge>
              </div>
              <div className={css.reportScroll}>
                <ul className={css.reportList}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <span className={`${css.kindTag} ${kindTagClass(group.kind)}`}>{item.kind}</span>
                      {' '}{item.adapter}: {item.description}
                      {item.detail !== undefined && <span className={css.hint}>（{item.detail}）</span>}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

/** 切换结果（ok / failed / rolledBack；绑定 profileSwitchKind 语义）。 */
function ProfileSwitchResultCard({ result, t }: {
  result: ProfileSwitchResult
  t: TranslateNS<'config-manager'>
}) {
  const kind = profileSwitchKind(result)
  const okCount = result.executed.filter((e) => e.status === 'ok').length
  const failed = result.executed.filter((e) => e.status === 'failed')
  return (
    <div>
      <Banner kind={kind === 'ok' ? 'ok' : kind === 'rolledBack' ? 'error' : 'error'}>
        {kind === 'ok'
          ? t('profiles.switchDone', { count: String(okCount) })
          : kind === 'rolledBack'
            ? t('profiles.switchRolledBack')
            : t('profiles.switchFailed')}
      </Banner>
      {result.warnings.length > 0 && (
        <Banner kind="warn">{result.warnings.join('；')}</Banner>
      )}
      {failed.length > 0 && (
        <div className={css.reportScroll}>
          <ul className={css.reportList}>
            {failed.map((f) => (
              <li key={f.itemId}>{f.itemId}: {f.message ?? ''}</li>
            ))}
          </ul>
        </div>
      )}
      {result.needsRestart && <Banner kind="warn">{t('report.needsRestart')}</Banner>}
    </div>
  )
}

