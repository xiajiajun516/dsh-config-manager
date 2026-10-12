/**
 * t54：「中断的档案复制残留」区块（事故恢复）。
 *
 * 这些目录带 `.dcm-copy-in-progress.json` 标记但没有 package.json —— 复制被中断留下的半截副本。
 * 它们**不能启动**（没有 package.json ⇒ shape=generic），所以本区块只给一个动作：删除；
 * 删除走**既有**的 `POST /profiles/delete`（不新开写路由）。
 *
 * SAFE MODE 阻断写操作时宿主回 423 `mutation-locked`：本区块必须给「原因 + 出口」
 * （出口 = 既有的 `POST /recovery/safe-mode/clear`），绝不呈现成没有出路的死胡同。
 *
 * 判定（谁能删、时间怎么显示）在 `recovery-view.ts` 的纯函数里；这里只装配。
 */
import { useState } from 'react'

import { Badge, Button, Card } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'
import type { TranslateNS } from '../client-types.ts'
import type { RecoveryPort } from '../../ui/types.ts'
import { incompleteDeleteErrorCode } from './recovery-view.ts'
import type { RecoveryIncompleteCopyView } from './recovery-view.ts'

export interface IncompleteCopiesSectionProps {
  rows: readonly RecoveryIncompleteCopyView[]
  t: TranslateNS<'config-manager-recovery'>
  /** 走既有 POST /profiles/delete 的主 API */
  diskApi: import('../api.ts').ConfigManagerApi
  /** 解除 SAFE MODE 的既有出口（POST /recovery/safe-mode/clear） */
  recoveryApi: RecoveryPort
  /** 处置成功后让父组件重拉 /recovery/status（该行随之消失） */
  onChanged: () => void
}

const errorTextOf = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

export function IncompleteCopiesSection(props: IncompleteCopiesSectionProps) {
  const { rows, t, diskApi, recoveryApi, onChanged } = props
  const [pending, setPending] = useState<RecoveryIncompleteCopyView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [locked, setLocked] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const doDelete = async (row: RecoveryIncompleteCopyView): Promise<void> => {
    setPending(null)
    setBusy(row.name)
    setError(null)
    setLocked(null)
    try {
      await diskApi.profileDelete(row.name)
      onChanged()
    } catch (err) {
      if (incompleteDeleteErrorCode(err) === 'mutation-locked') setLocked(errorTextOf(err))
      else setError(errorTextOf(err))
    } finally {
      setBusy(null)
    }
  }

  const doUnlock = async (): Promise<void> => {
    setUnlocking(true)
    setError(null)
    try {
      await recoveryApi.clearSafeMode(true)
      setLocked(null)
      onChanged()
    } catch (err) {
      setError(errorTextOf(err))
    } finally {
      setUnlocking(false)
    }
  }

  return (
    <Card>
      <div className={css.statRow}>
        <strong>{t('recovery.incomplete.title')}</strong>
        <InfoHint text={t('recovery.incomplete.hint')} label={t('common.infoHint')} />
        <Badge kind="warn">{String(rows.length)}</Badge>
      </div>
      <div className={css.snapshotList}>
        {rows.map((row) => (
          <div key={row.name} className={css.snapshotRow}>
            <div className={css.snapshotRowMain}>
              <div className={css.snapshotRowText}>
                <span className={css.snapshotRowName}>{row.name}</span>
                <span className={css.snapshotRowMeta}>
                  {(row.sourceName !== null ? t('recovery.incomplete.from', { name: row.sourceName }) + ' · ' : '')
                    + t('recovery.incomplete.startedAt', { time: row.startedAtText })}
                </span>
              </div>
              <div className={css.snapshotRowFacts}>{t('recovery.incomplete.dir', { dir: redact(row.dir) })}</div>
              <div className={css.actionRow}>
                {pending?.name === row.name
                  ? (
                    <>
                      <span className={css.hint}>{t('recovery.incomplete.deleteConfirm')}</span>
                      <Button variant="danger" loading={busy === row.name} onClick={() => { void doDelete(row) }}>
                        {t('recovery.incomplete.delete')}
                      </Button>
                      <Button onClick={() => { setPending(null) }}>{t('common.cancel')}</Button>
                    </>
                  )
                  : (
                    <Button
                      variant="danger"
                      disabled={!row.canDelete || busy !== null}
                      loading={busy === row.name}
                      onClick={() => { setPending(row); setError(null); setLocked(null) }}
                    >
                      {t('recovery.incomplete.delete')}
                    </Button>
                  )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {locked !== null && (
        <div>
          <div className={css.hint}>{t('recovery.incomplete.locked', { reason: locked })}</div>
          <div className={css.actionRow}>
            <Button loading={unlocking} onClick={() => { void doUnlock() }}>
              {t('recovery.incomplete.unlock')}
            </Button>
          </div>
        </div>
      )}
      {error !== null && <div className={css.hint}>{error}</div>}
    </Card>
  )
}
