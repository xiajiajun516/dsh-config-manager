/**
 * 远程合并弹窗（T-ui-merge 的装配层）—— 弹窗壳 + 状态 + 请求都在这一个文件里：
 *   - 预览 / 裁决草稿 / 执行结果 / 三个进行中标志 / 错误 → 组件自持（不持久化）；
 *   - 视觉与列表渲染 → `MergePreviewView.tsx`（纯展示）；
 *   - **底部动作走 Modal.Footer（DESIGN UI-23）**：「执行合并」是写操作 + 过 mutation gate，
 *     必须与「关闭」同处底栏，正文里不制造第二条执行通道。
 *
 * 为什么把状态搬到这里：裁决结果只能由弹窗底栏触发执行，而底栏在 Modal.Body 之外 ——
 * 状态若留在视图里，就要靠 ref / render-prop 把按钮递出去，反而更脆。
 *
 * 方案 A（一键同步命中合并路径）：预览由父级那一次 /sync/merge-preview 预置（seed），
 * 打开即渲染、**不再二次请求**；「重新预览」/错误重试才显式再拉一次（只读）。
 */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Modal } from '../common/Modal.tsx'
import { Button } from '../common/ui.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import type {
  MergeApplyResponse, MergePreviewPayload, MergePreviewResponse, SyncApi, SyncPushPayload,
} from './sync-api.ts'
import type { SyncChannel } from './sync-view.ts'
import {
  applyBulkResolution, buildMergeResolutions, hasApplicableSections, initialResolutionDraft,
  mergeDecisionCounts, mergeResultView, mergeSectionRows,
} from './merge-view.ts'
import type { MergeBulkAction, MergeResolutionAction, MergeResolutionDraft } from './merge-view.ts'
import { MergePreviewView } from './MergePreviewView.tsx'
import css from '../config-manager.module.css'

/**
 * 预览/执行共用的请求体：**通道请求体在前**（transport / 地址 / 凭据引用，与 push/pull 同源），
 * 再叠加预览可选字段（decryptPassword / pathMappings / snapshotId）。
 * 宿主侧契约是 MergePreviewPayload，但实际请求一直带着通道字段（见 sync-entry.ts 的同款写法的原因）——
 * 两者取交集才是真实形状。
 */
type MergeRequestBody = SyncPushPayload & MergePreviewPayload

/** 一键同步分派命中合并路径时递进来的种子（预览已取到，通道 = 该次请求用的通道）。 */
export interface MergeSeed {
  channel: SyncChannel
  preview: MergePreviewResponse
}

export interface MergeModalProps {
  /** 打开态（种子的有无即开关：null = 关闭）。关闭时保留壳，交给 Radix 播退场动画。 */
  seed: MergeSeed | null
  onClose: () => void
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 该通道的请求体（父级用当次表单快照构造；弹窗不读通道状态、不拼 URL） */
  channelBody: (channel: SyncChannel) => SyncPushPayload
  /** 分区 id → 本地化名称 */
  sectionName: (id: string) => string
  /** 该通道的解密密码（可选，仅内存；留空 = 用本机已存凭据） */
  decryptPasswordOf: (channel: SyncChannel) => string
  /** 父级忙碌（其它同步操作进行中）→ 禁止并发写 */
  busy?: boolean
  /** 执行成功后通知父级刷新同步状态 */
  onApplied?: () => void
  /** 回滚完成后通知父级刷新同步状态 */
  onRolledBack?: () => void
}

/**
 * 远程合并弹窗：概览 → 分区裁决 → 执行（底栏）→ 结果（含一键回滚）。
 *
 * 草稿**不持久化**：裁决是当次操作的一部分，刷新页面等于放弃本次裁决，
 * 不会静默留下半套选择（与旧行为一致）。
 */
export function MergeModal({
  seed, onClose, api, t, channelBody, sectionName, decryptPasswordOf, busy = false,
  onApplied, onRolledBack,
}: MergeModalProps) {
  const [preview, setPreview] = useState<MergePreviewResponse | null>(seed?.preview ?? null)
  const [draft, setDraft] = useState<MergeResolutionDraft>(() => initialResolutionDraft(seed?.preview ?? null))
  const [result, setResult] = useState<MergeApplyResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 新的种子 = 新的远端快照：旧裁决属于上一份快照，必须整体丢弃（不做「尽量保留」）。
  useEffect(() => {
    if (seed === null) return
    setPreview(seed.preview)
    setDraft(initialResolutionDraft(seed.preview))
    setResult(null)
    setError(null)
  }, [seed])

  /** 该通道的请求体（解密密码只进请求体，不落任何状态）。 */
  const requestBody = (channel: SyncChannel): MergeRequestBody => {
    const password = decryptPasswordOf(channel)
    return { ...channelBody(channel), ...(password !== '' ? { decryptPassword: password } : {}) }
  }

  /** 只读预览：拉远端快照做三方合并（宿主侧零写入），并按结果重建裁决草稿。 */
  const reload = async (): Promise<void> => {
    if (seed === null) return
    setLoading(true)
    setError(null)
    try {
      const next = await api.mergePreview(requestBody(seed.channel))
      setPreview(next)
      setDraft(initialResolutionDraft(next))
      setResult(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const setAction = (sectionId: string, action: MergeResolutionAction): void => {
    setDraft((cur) => ({ ...cur, [sectionId]: action }))
  }

  const bulk = (action: MergeBulkAction): void => {
    setDraft((cur) => applyBulkResolution(preview, cur, action))
  }

  /** 执行合并（写动作，过宿主 mutation gate）；结果如实展示，包括 pendingConflicts。 */
  const apply = async (): Promise<void> => {
    if (seed === null) return
    setApplying(true)
    setError(null)
    try {
      const report = await api.applyMerge({ ...requestBody(seed.channel), resolutions: buildMergeResolutions(draft) })
      setResult(report)
      if (report.ok) toast.ok(t('merge.toast.applied'))
      else toast.error(t('merge.toast.applyFailed'))
      onApplied?.()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(t('merge.toast.applyFailed') + t('common.labelSeparator') + redact(message))
    } finally {
      setApplying(false)
    }
  }

  /** 一键回滚：复用既有 /sync/rollback 数据流（restoreId 来自本次执行）。 */
  const rollback = async (): Promise<void> => {
    const view = mergeResultView(result)
    if (view === null || view.restoreId === null) return
    setRollingBack(true)
    try {
      const report = await api.rollback({ restoreId: view.restoreId })
      if (report.full) toast.ok(t('merge.result.rolledBackTo', { id: view.restoreId }))
      else toast.error(t('merge.result.rollbackIncomplete'))
      onRolledBack?.()
    } catch (err) {
      toast.error(t('merge.toast.rollbackFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    } finally {
      setRollingBack(false)
    }
  }

  const rows = mergeSectionRows(preview)
  const counts = mergeDecisionCounts(preview, draft)
  const applicable = hasApplicableSections(preview)
  const blocked = busy || loading || preview === null || rows.length === 0

  return (
    <Modal
      open={seed !== null}
      onClose={onClose}
      title={t('merge.title')}
      wide
      busy={busy || applying}
      cardStyle={{ width: 'min(860px, 100%)', maxHeight: '88vh' }}
    >
      <Modal.Header
        title={t('merge.title')}
        closeLabel={t('common.close')}
        onClose={onClose}
        closeDisabled={busy || applying}
      />
      <Modal.Body scroll style={{ maxHeight: '72vh' }}>
        <MergePreviewView
          api={api}
          t={t}
          preview={preview}
          draft={draft}
          result={result}
          loading={loading}
          rollingBack={rollingBack}
          error={error}
          busy={busy || applying}
          sectionName={sectionName}
          onReload={() => { void reload() }}
          onAction={setAction}
          onBulk={bulk}
          onRollback={() => { void rollback() }}
          showTitle={false}
        />
      </Modal.Body>
      {/* 底栏：裁决进度（左）+ 关闭 / 执行合并（右）。执行是唯一写入口。 */}
      <Modal.Footer>
        <span className={css.mergeFooterSummary}>
          {t('merge.apply.summary', { decided: String(counts.decided), needs: String(counts.needsDecision) })}
          {counts.applicable > 0 ? ' · ' + t('merge.apply.willApply', { n: String(counts.applicable) }) : ''}
        </span>
        <span className={css.statusSpacer} />
        <Button variant="ghost" disabled={applying} onClick={onClose}>{t('common.close')}</Button>
        <Button
          variant="primary"
          loading={applying}
          disabled={blocked || !applicable}
          onClick={() => { void apply() }}
        >
          {applying ? t('merge.applying') : t('merge.apply')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
