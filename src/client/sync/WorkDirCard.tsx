/**
 * 工作副本卡（issue #79；t42 物理拆分：渲染段自成文件，主文件只装配）。
 *
 * 为什么需要它：改仓库地址后同步失败时，App 内此前**没有任何自救路径** —— 只能手工
 * `git remote set-url`，或删掉 `<dataDir>/sync/work` 重来。这里给出工作副本的只读事实
 * （路径 / origin / 与配置地址是否一致）与两条出口：
 *  - 「重指向仓库地址」= host 的 relink（非破坏性：只改 git 配置，不碰工作树与本地提交）；
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
  canRecloneWorkdir, formatSyncUrlPreview, needsWorkdirRelink, workdirStateBadgeKind, workdirStateKey,
} from '../../ui/sync-settings-view.ts'
import css from '../config-manager.module.css'

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
  const stateKey = workdirStateKey(workDir)
  const badgeKind = workdirStateBadgeKind(stateKey)
  const facts = workDir !== undefined && 'facts' in workDir ? workDir.facts : null

  const reset = async (mode: 'relink' | 'reclone'): Promise<void> => {
    setRecloneOpen(false)
    try {
      await api.workdirReset(mode === 'reclone' ? { mode, confirm: true } : { mode })
      toast.ok(t(mode === 'relink' ? 'toast.workdirRelinked' : 'toast.workdirRecloned'))
      onChanged()
    } catch (err) {
      toast.error(t('toast.workdirResetFailed') + t('common.labelSeparator') + redact(err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <Card>
      <span className={css.groupLabel}>{t('workdir.title')} <InfoHint text={t('workdir.hint')} label={t('common.infoHint')} /></span>
      {stateKey !== null && badgeKind !== null && (
        <div className={css.statRow}>
          <Badge kind={badgeKind}>{t(stateKey)}</Badge>
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
        </div>
      )}
      <div className={css.actionRowTop}>
        {needsWorkdirRelink(workDir) && (
          <Button disabled={busy} onClick={() => { void reset('relink') }}>
            {t('workdir.relink')}
          </Button>
        )}
        {canRecloneWorkdir(workDir) && (
          <Button variant="danger" disabled={busy} onClick={() => { setRecloneOpen(true) }}>
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
