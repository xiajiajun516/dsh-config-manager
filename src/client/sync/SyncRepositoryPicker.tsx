/**
 * 同步通道「仓库选择器」—— 选择已有仓库 / 新建仓库。
 *
 * 为什么单独成文件（与 ChannelClearConfirmDialog 同一条理由）：
 * SyncPanel.tsx 有行数棘轮（拆分后的量级），而本段是**自包含**的「拉列表 → 选择 / 新建 → 回执」流程，
 * 塞回装配层只会让它继续膨胀。它也不占用父组件的状态：列表、新建表单、错误全在本文件内，
 * 只通过 `onPick(cloneUrl)` 把选中的地址交回父组件（父组件负责 patch 表单 + 防抖保存）。
 *
 * 交互与安全约定：
 * - 列表**只列私有仓库**（`repoPickerRepos`）：同步仓库公开 = 配置内容公开；
 * - 新建仓库**没有「公开」开关**，请求体也不传 private —— 宿主对这条端点恒定以 private:true 建仓，
 *   客户端连表达「公开」这个意图的途径都没有（安全约束落在宿主侧，UI 侧不重复也不放宽）；
 * - **绝不嵌套第二个 Modal**：新建表单是同一弹窗内的内联区块（双 overlay 会与宿主遮罩互相打架，
 *   关闭语义也会变得含糊 —— 与 SyncSectionPickerDialog 同一纪律），因此父组件不需要新增顶层状态；
 * - 失败**绝不静默，也绝不把拒绝抛出去**（调用点在 void 上下文里）：错误同时进 toast 与内联红字
 *   （toast 会被后续提示挤掉，内联红字留在原地），宿主下发的文本一律先过 `redact()` 再渲染。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'

import type { TranslateNS } from '../client-types.ts'
import { redact } from '../../security/redaction.ts'
import { Button, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { Select } from '../common/Select.tsx'
import { toast } from '../common/toast-store.ts'
import type { SyncApi } from './sync-api.ts'
import {
  formatRepoUpdatedAt, repoCreateBody, repoNameError, repoPickerOptions, repoPickerRepos,
  repoPickerValueFor, REPO_PICKER_CREATE_VALUE, type RepoNameError, type RepoPickerRepo,
} from '../../ui/sync-repository-picker.ts'
import css from '../config-manager.module.css'

export interface SyncRepositoryPickerProps {
  /** 弹窗是否打开：关闭时收起新建表单（与 SyncSectionPickerDialog 的视图复位同款纪律） */
  open: boolean
  /** 同步 API（列表 / 新建两条端点） */
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 表单里当前的仓库地址（用于回显「当前选中的是哪一个」） */
  repoUrl: string
  /** 表单繁忙（保存中 / 同步中）时禁用选择与新建 */
  busy: boolean
  /** 选中仓库（或新建成功）后把地址交回父组件 */
  onPick: (cloneUrl: string) => void
}

/** 打开下拉时才拉列表（Select 的 onOpen）—— 弹窗一打开就请求会白跑一次网络。 */
export function SyncRepositoryPicker({ open, api, t, repoUrl, busy, onPick }: SyncRepositoryPickerProps) {
  const [repos, setRepos] = useState<RepoPickerRepo[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [nameError, setNameError] = useState<RepoNameError>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  /** 拉取仓库列表。**绝不抛出**（调用点在 void 上下文里，抛出的拒绝会变成 unhandled rejection）。 */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await api.githubListRepositories()
      setRepos(res.repos)
      setLoaded(true)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api])

  // 关闭时收起新建表单（下次打开从「选择」开始，不留上一次的半截输入）
  useEffect(() => {
    if (open) return
    setCreateOpen(false)
    setName('')
    setDescription('')
    setNameError(null)
    setCreateError(null)
  }, [open])

  // 表单里已经有地址（例如上次选过）→ 进弹窗就把列表拉出来，让用户直接看到「当前选中的是哪一个」；
  // 空地址则等 onOpen 惰性加载。失败过就不自动重试（避免每开一次弹窗打一次必然失败的请求）。
  useEffect(() => {
    if (!open || loaded || loading || loadError !== null) return
    if (repoUrl.trim() === '') return
    void load()
  }, [open, loaded, loading, loadError, repoUrl, load])

  const pick = (value: string): void => {
    if (value === REPO_PICKER_CREATE_VALUE) {
      // 内联展开新建表单（不是第二个 Modal）：这里只做「准备好表单」这一件事
      setCreateOpen(true)
      setNameError(null)
      setCreateError(null)
      return
    }
    onPick(value)
  }

  /** 提交新建。成功 → toast + 回填地址 + 收起表单；失败 → toast + 内联红字，绝不外抛。 */
  const submitCreate = async (): Promise<void> => {
    const invalid = repoNameError(name)
    setNameError(invalid)
    if (invalid !== null) return
    setCreating(true)
    setCreateError(null)
    const body = repoCreateBody(name, description)
    try {
      const res = await api.githubCreateRepository(body.name, body.description ?? '')
      // 新仓库排到列表最前：它是用户此刻最可能要选的那一个
      setRepos((prev) => [res.repo, ...prev])
      setLoaded(true)
      toast.ok(t('repoPicker.created', { name: res.repo.fullName }))
      onPick(res.repo.cloneUrl)
      setCreateOpen(false)
      setName('')
      setDescription('')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setCreateError(detail)
      toast.error(t('repoPicker.createFailed') + t('common.labelSeparator') + redact(detail))
    } finally {
      setCreating(false)
    }
  }

  const label = (repo: RepoPickerRepo, shortName: string): string => {
    // 与 SyncChannelEntryCard 的「上次同步」同口径：不传 locale，走浏览器本地时间格式
    const time = formatRepoUpdatedAt(repo.updatedAt)
    const parts = [shortName]
    if (repo.fork) parts.push(t('repoPicker.forkBadge'))
    if (time !== '') parts.push(t('repoPicker.updatedAt', { time }))
    return parts.join(' · ')
  }

  const options = repoPickerOptions(repos, label, t('repoPicker.create'))
  const privateRepos = repoPickerRepos(repos)
  const selectedValue = repoPickerValueFor(repoUrl, repos)
  const nameHint = nameError === 'empty' ? t('repoPicker.nameRequired') : nameError === 'invalid' ? t('repoPicker.nameInvalid') : null

  return (
    <>
      <div className={css.field}>
        <span className={css.fieldLabel}>
          {t('repoPicker.label')} <InfoHint text={t('repoPicker.hint')} label={t('common.infoHint')} />
        </span>
        <div className={css.controlRow}>
          <Select
            value={selectedValue}
            options={options}
            disabled={busy || creating}
            ariaLabel={t('repoPicker.label')}
            placeholder={t('repoPicker.placeholder')}
            onOpen={() => { if (!loaded && !loading) void load() }}
            onChange={pick}
          />
          <Button size="sm" disabled={busy || loading} onClick={() => { void load() }}>
            {loading ? <Spinner label={t('repoPicker.refreshing')} /> : t('repoPicker.refresh')}
          </Button>
        </div>
        {/* 空态 / 失败说明留在原地（不进 ⓘ）：用户正卡在这里，说明必须看得见 */}
        {loaded && privateRepos.length === 0 && <span className={css.hint}>{t('repoPicker.empty')}</span>}
        {loadError !== null && (
          <span className={css.formError}>{t('repoPicker.loadFailed')}{t('common.parens', { text: redact(loadError) })}</span>
        )}
      </div>
      {createOpen && (
        <div className={css.field}>
          <span className={css.groupLabel}>{t('repoPicker.createTitle')} <InfoHint text={t('repoPicker.privateOnly')} label={t('common.infoHint')} /></span>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('repoPicker.name')}</span>
            <input
              type="text"
              className={css.input}
              value={name}
              placeholder={t('repoPicker.namePlaceholder')}
              disabled={creating}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setName(e.target.value)
                if (nameError !== null) setNameError(repoNameError(e.target.value))
              }}
            />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('repoPicker.description')}</span>
            <input
              type="text"
              className={css.input}
              value={description}
              placeholder={t('repoPicker.descriptionPlaceholder')}
              disabled={creating}
              onChange={(e: ChangeEvent<HTMLInputElement>) => { setDescription(e.target.value) }}
            />
          </label>
          {nameHint !== null && <span className={css.formError}>{nameHint}</span>}
          {createError !== null && <span className={css.formError}>{redact(createError)}</span>}
          <div className={css.actionRowTop}>
            <Button variant="primary" size="sm" disabled={busy || creating} onClick={() => { void submitCreate() }}>
              {creating ? <Spinner label={t('repoPicker.creating')} /> : t('repoPicker.createSubmit')}
            </Button>
            <Button size="sm" disabled={creating} onClick={() => { setCreateOpen(false) }}>
              {t('repoPicker.createCancel')}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
