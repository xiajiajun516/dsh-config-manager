/**
 * 磁盘占用卡（维护与诊断 → 「磁盘占用与清理」）：「我的备份到底占了多少盘、哪些能清」。
 *
 * 为什么放在这里：本插件的备份产物（导出 ZIP）、导入前快照、同步工作副本、市场缓存与临时暂存
 * 全在 `$DSH_HOME/dsh-config-manager` 下，后台虽有每日自动清理，但界面上此前**没有任何数字**。
 *
 * 交互与安全边界：
 *  - 体检（GET /disk-usage）只读；
 *  - 「立即清理」缺省只清**可重建**的缓存/暂存（清理逻辑见 core/cache-cleaner 的 includeRecent）；
 *  - 回收过期备份文件是**显式勾选**的第二档 —— 那是用户的备份文件，未勾选就不动，且走 danger 确认；
 *  - 快照（导入前安全网）与同步数据**永不在候选集内**，界面文案如实说明。
 *
 * 业务判定全在 `src/ui/disk-usage-view.ts`（node 可测）；本组件只做装配与状态。
 *
 * 本文件是**从构建产物（lib/client.js，2026-10-02T23:33Z）还原**的：一次误用的通配删除
 * 把它连同两个仍在使用的组件一起删掉了，而它在 git 里从未被跟踪（一直是 `??`），
 * 没有可 `git show` 的版本。还原时按编译产物逐段翻译 —— 逻辑、文案键、CSS 类与调用顺序
 * 与原实现一致，**排版与注释措辞是重建的**。教训见 AGENTS.md「常见坑」的通配套。
 */
import { useEffect, useRef, useState } from 'react'
import { cleanupOutcome, diskUsageViewModel } from '../../../ui/disk-usage-view.ts'
import { formatBytes } from '../../../ui/report.ts'
import { redact } from '../../../security/redaction.ts'
import type { ConfigManagerApi } from '../../api.ts'
import type { DiskUsageReport } from '../../../core/disk-usage.ts'
import { Badge, Banner, Button, Card, Checkbox, IconButton } from '../../common/ui.tsx'
import { SkeletonList } from '../../common/Skeleton.tsx'
import { InfoHint } from '../../common/InfoHint.tsx'
import { ConfirmDialog } from '../../common/ConfirmDialog.tsx'
import { RefreshIcon } from '../../common/Icon.tsx'
import { toast } from '../../common/toast-store.ts'
import css from '../../config-manager.module.css'

export interface DiskUsageCardProps {
  api: ConfigManagerApi
  /**
   * ⓘ 说明按钮的可访问名（主字典 `common.infoHint`）。本卡全部文案走 **UiT**（`api.t`），
   * 与主字典键域不同、取不到该键 —— 由调用方（环境页的维护视图）显式传入，
   * 避免在英文界面下回落到源语言硬编码。
   */
  infoHintLabel: string
  /** 回收过期备份文件后通知外层刷新备份列表（否则产物库会短暂显示已删条目） */
  onBackupsChanged?: () => void
}

export function DiskUsageCard({ api, infoHintLabel, onBackupsChanged }: DiskUsageCardProps) {
  const t = api.t
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<DiskUsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [includeExpired, setIncludeExpired] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => () => { mountedRef.current = false }, [])

  const load = (): void => {
    setStatus('loading')
    setError(null)
    api.getDiskUsage().then(
      (next) => {
        if (!mountedRef.current) return
        setReport(next)
        setStatus('ready')
      },
      (err) => {
        if (!mountedRef.current) return
        setStatus('error')
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }
  useEffect(load, [api])

  const vm = diskUsageViewModel(report, { t, formatBytes })

  /** 导出产物的保留期（天）；宿主没给（旧宿主/字段缺失）→ null（整句不提，不编数字） */
  const retentionMs = report?.areas.exports.retentionMs
  const exportRetentionDays = retentionMs === undefined ? null : Math.round(retentionMs / 86_400_000)

  const tmpMarket = vm?.clean.actions.find((a) => a.id === 'tmp-market')
  const expiredExports = vm?.clean.actions.find((a) => a.id === 'expired-exports')
  /**
   * 可回收量的算账口径：**由渲染出的行现算**，不用接口的聚合字段 ——
   * 否则会出现「按钮说能释放 600 B、实际清出 0」（AGENTS.md 的硬边界 ④）。
   */
  const reclaimTargets = (tmpMarket?.bytes ?? 0) + (includeExpired ? expiredExports?.bytes ?? 0 : 0)
  const nothingToReclaim = reclaimTargets === 0

  const runCleanup = (): void => {
    if (busy) return
    setBusy(true)
    // categories 是**分区白名单**：没勾过期导出就一个导出文件都不碰（硬边界 ②）
    const categories: Array<'tmp' | 'expired-exports'> = ['tmp']
    if (includeExpired) categories.push('expired-exports')
    api.cleanupDiskUsage(categories).then(
      (result) => {
        if (!mountedRef.current) return
        setBusy(false)
        setConfirmOpen(false)
        setReport(result.report)
        if (includeExpired) onBackupsChanged?.()
        // e2e-F3：呈现判定在 ui/disk-usage-view.ts（「目录不存在」不是失败）；组件只按 kind 挑 toast
        const outcome = cleanupOutcome(
          { removed: result.removed, freedBytes: result.freedBytes, errors: result.errors, report: result.report, requested: result.requested },
          { t, formatBytes },
        )
        if (outcome.okText !== '') toast.ok(outcome.okText)
        if (outcome.warnText !== '') {
          if (outcome.warnKind === 'error') toast.error(outcome.warnText)
          else toast.warn(outcome.warnText)
        }
      },
      (err) => {
        if (!mountedRef.current) return
        setBusy(false)
        setConfirmOpen(false)
        toast.error(redact(err instanceof Error ? err.message : String(err)))
      },
    )
  }

  return (
    <Card className={css.activityCard + ' ' + css.diskUsageCard}>
      <div className={css.groupHeader}>
        <span className={css.groupLabel}>{t('diskUsage.title')}</span>
        {vm !== null && <span className={css.badge}>{vm.summary.total}</span>}
        <span className={css.statusSpacer} />
        <IconButton
          icon={<RefreshIcon size={14} />}
          label={t('diskUsage.refresh')}
          disabled={status === 'loading' || busy}
          onClick={load}
        />
      </div>

      {status === 'loading' && <SkeletonList label={t('diskUsage.loading')} />}

      {status === 'error' && (
        <Banner kind="error">
          {t('diskUsage.loadFailed')}
          {error !== null && <span className={css.cellMetaNoteText}>{redact(error)}</span>}
          <Button variant="primary" onClick={load}>{t('commonRetry')}</Button>
        </Banner>
      )}

      {status === 'ready' && vm !== null && (
        <>
          <div className={css.hint}>
            {t('diskUsage.location')}: <span className={css.mono}>{redact(vm.summary.dataDir)}</span> · {vm.summary.files}
          </div>
          {/* 读不到的子区如实说明：既不显示 0，也不整卡报错（硬边界：unreadable ≠ 0） */}
          {vm.summary.anyUnreadable && <div className={css.hint}>{t('diskUsage.partial')}</div>}

          <div className={css.planScroll + ' ' + css.diskUsageScroll}>
            <table className={`${css.dataTable} ${css.tableFixed} ${css.tableCompact}`}>
              <thead>
                <tr>
                  <th>{t('diskUsage.col.area')}</th>
                  <th className={css.num}>{t('diskUsage.col.size')}</th>
                  <th className={css.num}>{t('diskUsage.col.files')}</th>
                  <th>{t('diskUsage.col.policy')}</th>
                </tr>
              </thead>
              <tbody>
                {vm.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div>{row.label}</div>
                      <div className={css.cellMetaNoteText}>{row.desc}</div>
                    </td>
                    <td className={css.num}>
                      {row.unreadable ? <span className={css.dim}>{t('diskUsage.unreadable')}</span> : row.size}
                    </td>
                    <td className={css.num}>{row.unreadable ? '—' : row.files}</td>
                    <td>
                      {row.policy === 'regenerable' && <Badge kind="ok">{t('diskUsage.policy.regenerable')}</Badge>}
                      {row.policy === 'retained' && <Badge kind="info">{t('diskUsage.policy.retained', { retention: row.retention })}</Badge>}
                      {row.policy === 'protected' && <span className={css.dim}>{t('diskUsage.policy.protected')}</span>}
                      {row.expired !== null && (
                        <div className={css.cellMetaNoteText}>{t('diskUsage.expiredHint', { size: row.expired })}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 保留期说明属「机制怎么工作」（MOVE 类）：收进 ⓘ，不常驻占一行 */}
          {exportRetentionDays !== null && (
            <div className={css.actionRow} data-inline>
              <InfoHint
                text={t('diskUsage.backupRetention', {
                  count: String(report?.backupRetention.keepLast ?? 0),
                  days: String(exportRetentionDays),
                })}
                label={infoHintLabel}
              />
            </div>
          )}

          <div className={css.groupLabel}>{t('diskUsage.clean.title')}</div>
          <div className={css.hint}>{t('diskUsage.clean.hint')}</div>

          {tmpMarket !== undefined && (
            <div className={css.actionRow} data-inline>
              <span>{tmpMarket.label} <Badge kind={tmpMarket.bytes > 0 ? 'info' : 'ok'}>{tmpMarket.size}</Badge></span>
              <span className={css.statusSpacer} />
              <span className={css.hint}>{tmpMarket.desc}</span>
            </div>
          )}

          {expiredExports !== undefined && (
            <div className={css.actionRow} data-inline>
              <Checkbox
                checked={includeExpired}
                onChange={(next) => { setIncludeExpired(next) }}
                label={t('diskUsage.clean.includeExpired')}
              />
              <span className={css.statusSpacer} />
              <span className={css.hint}>
                {expiredExports.label} <Badge kind={expiredExports.bytes > 0 ? 'warn' : 'ok'}>{expiredExports.size}</Badge>
              </span>
            </div>
          )}

          <div className={css.actionRow}>
            <span className={css.hint}>{t('diskUsage.clean.reclaimableLabel')}</span>
            <span className={css.statusSpacer} />
            <Button
              variant={includeExpired ? 'danger' : 'primary'}
              disabled={busy || nothingToReclaim}
              loading={busy}
              onClick={() => { setConfirmOpen(true) }}
            >
              {busy ? t('diskUsage.clean.cleaning') : t('diskUsage.clean.now')}
            </Button>
          </div>
        </>
      )}

      {/* 清理二次确认（勾了过期导出 → danger；那是用户的备份文件） */}
      <ConfirmDialog
        open={confirmOpen}
        title={t('diskUsage.clean.confirmTitle')}
        message={t('diskUsage.clean.confirmMessage')}
        confirmLabel={t('diskUsage.clean.confirm')}
        cancelLabel={t('commonCancel')}
        danger={includeExpired}
        onConfirm={runCleanup}
        onCancel={() => { if (!busy) setConfirmOpen(false) }}
      />
    </Card>
  )
}
