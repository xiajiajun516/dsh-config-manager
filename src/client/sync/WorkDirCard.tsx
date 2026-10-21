/**
 * 工作副本卡（issue #79；t42 物理拆分：渲染段自成文件，主文件只装配）。
 *
 * 为什么需要它：改仓库地址后同步失败时，App 内此前**没有任何自救路径** —— 只能手工
 * `git remote set-url`，或删掉 `<dataDir>/sync/work` 重来。这里给出工作副本的只读事实
 * （路径 / origin / 与配置地址是否一致）与三条出口：
 *  - 「重指向仓库地址」= host 的 relink（非破坏性：只改 git 配置，不碰工作树与本地提交）；
 *  - 「采纳远端历史」= host 的 adopt（issue #104：把远端分支合并进本地工作副本 —— 换仓库 / 远端历史
 *    被重写后两条历史不相交，pull --ff-only 永远失败。不改写本地提交，可 revert，冲突自动 abort）；
 *  - 「重新克隆工作副本」= host 的 reclone（**丢弃未上行的本地提交**）→ danger 二次确认。
 *
 * 约定（与 ChannelClearConfirmDialog 同族）：确认弹窗、宿主调用与终局回执都在本文件内自持，
 * 调用方只传「渲染所需的数据 + 变更通知」；判定在 `src/ui/sync-settings-view.ts`（可测）。
 */
import { useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncApi, SyncStatusResponse } from './sync-api.ts'
import { Badge, Button, Card } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import { redact } from '../../security/redaction.ts'
import {
  canAdoptWorkdir, canRecloneWorkdir, formatSyncUrlPreview, needsWorkdirRelink, workdirBacklog, workdirStateBadgeKind,
  workdirStateKey,
} from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

/** 三种出口各自的终局回执（zh/en 都在 sync-locales，禁止在这里拼用户可见文案）。 */
const WORKDIR_TOAST = {
  relink: 'toast.workdirRelinked',
  adopt: 'toast.workdirAdopted',
  reclone: 'toast.workdirRecloned',
} as const

export function WorkDirCard({ t, api, workDir, busy, onChanged }: {
  t: TranslateNS<'config-manager-sync'>
  api: SyncApi
  /** GET /sync/status 的 workDir 字段（非 git 通道 / 未配置时 undefined） */
  workDir: SyncStatusResponse['workDir']
  busy: boolean
  /** 重建成功后重拉状态（调用方负责它的状态源） */
  onChanged: () => void
}) {
  /** 重新克隆的二次确认（破坏性：丢弃未上行的本地提交） */
  const [recloneOpen, setRecloneOpen] = useState(false)
  /** 本次发起的出口（relink / adopt / reclone）：请求在途时卡片按钮就地转加载态。
   *  为什么必须有：reclone 要删目录 + 重新 clone（真机可达数十秒），此前点了只有 toast 在**结束**时才响，
   *  用户无从判断是否正在执行，容易重复点击或以为没反应。 */
  const [pending, setPending] = useState<'relink' | 'adopt' | 'reclone' | null>(null)
  const stateKey = workdirStateKey(workDir)
  const badgeKind = workdirStateBadgeKind(stateKey)
  const facts = workDir !== undefined && 'facts' in workDir ? workDir.facts : null
  /** issue #104 建议 3：本地攒了提交、远端却一个快照都没有 —— 这一条必须显式喊出来 */
  const backlog = workdirBacklog(workDir)
  const backlogBadge = backlog.kind === 'never-synced'
    ? { kind: 'warn' as const, key: 'workdir.backlogNeverSynced' as const }
    : backlog.kind === 'ahead'
      ? { kind: 'warn' as const, key: 'workdir.backlogAhead' as const }
      : null

  const reset = async (mode: 'relink' | 'adopt' | 'reclone'): Promise<void> => {
    setRecloneOpen(false)
    setPending(mode)
    try {
      await api.workdirReset(mode === 'reclone' ? { mode, confirm: true } : { mode })
      toast.ok(t(WORKDIR_TOAST[mode]))
      onChanged()
    } catch (err) {
      toast.error(t('toast.workdirResetFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    } finally {
      // 无论成功/失败都要收掉加载态，否则按钮会永远转圈（状态重拉由 onChanged 负责）
      setPending(null)
    }
  }

  return (
    <Card>
      <span className={css.groupLabel}>{t('workdir.title')} <InfoHint text={t('workdir.hint')} label={t('common.infoHint')} /></span>
      {stateKey !== null && badgeKind !== null && (
        <div className={css.statRow}>
          <Badge kind={badgeKind}>{t(stateKey)}</Badge>
          {backlogBadge !== null && <Badge kind={backlogBadge.kind}>{t(backlogBadge.key)}</Badge>}
        </div>
      )}
      {workDir === undefined ? (
        <span className={css.categoryDesc}>{t('workdir.unknown')}</span>
      ) : (
        <div className={css.factGrid} style={{ marginTop: 8 }}>
          <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
            <span className={css.factLabel}>{t('workdir.path')}</span>
            <span className={css.factValue}>
              <span className={css.mono}>{formatSyncUrlPreview(facts?.path ?? t('workdir.unknown'))}</span>
            </span>
          </div>
          <div className={css.factCell} style={{ gridColumn: '1 / -1' }}>
            <span className={css.factLabel}>{t('workdir.origin')}</span>
            <span className={css.factValue}>
              <span className={css.mono}>
                {facts === null || facts.origin === null ? t('workdir.unknown') : formatSyncUrlPreview(facts.origin)}
              </span>
            </span>
          </div>
          {backlog.kind !== 'unknown' && (
            <div className={css.factCell}>
              <span className={css.factLabel}>{t('workdir.ahead')}</span>
              <span className={css.factValue}>{backlog.kind === 'clean' ? 0 : backlog.ahead}</span>
            </div>
          )}
          {(backlog.kind === 'clean' || backlog.kind === 'ahead') && (
            <div className={css.factCell}>
              <span className={css.factLabel}>{t('workdir.remoteSnapshots')}</span>
              <span className={css.factValue}>{backlog.remoteSnapshots}</span>
            </div>
          )}
        </div>
      )}
      <div className={css.actionRowTop}>
        {needsWorkdirRelink(workDir) && (
          <Button disabled={busy || pending !== null} loading={pending === 'relink'} onClick={() => { void reset('relink') }}>
            {t('workdir.relink')}
          </Button>
        )}
        {canAdoptWorkdir(workDir) && (
          <>
            <Button disabled={busy || pending !== null} loading={pending === 'adopt'} onClick={() => { void reset('adopt') }}>
              {t('workdir.adopt')}
            </Button>
            <InfoHint text={t('workdir.adoptHint')} label={t('common.infoHint')} />
          </>
        )}
        {canRecloneWorkdir(workDir) && (
          <Button variant="danger" disabled={busy || pending !== null} loading={pending === 'reclone'} onClick={() => { setRecloneOpen(true) }}>
            {t('workdir.reclone')}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={recloneOpen}
        danger
        title={t('workdir.recloneConfirmTitle')}
        message={t('workdir.recloneConfirmMessage')}
        confirmLabel={t('workdir.recloneConfirm')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => reset('reclone')}
        onCancel={() => { setRecloneOpen(false) }}
      />
    </Card>
  )
}
