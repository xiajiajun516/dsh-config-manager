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
import { ConfirmDialog } from '../../common/ConfirmDialog.tsx'
import { RefreshIcon } from '../../common/Icon.tsx'
import { toast } from '../../common/toast-store.ts'
import css from '../../config-manager.module.css'

export interface DiskUsageCardProps {
  api: ConfigManagerApi
  /** 回收过期备份文件后通知外层刷新备份列表（否则产物库会短暂显示已删条目） */
  onBackupsChanged?: () => void
}

export function DiskUsageCard({ api, onBackupsChanged }: DiskUsageCardProps) {
  const t = api.t
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<DiskUsageReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [includeExpired, setIncludeExpired] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const mountedRef = useRef(true)

  /**
   * 挂载标记：只在**卸载**时置 false，并在每次挂载时显式写回 true。
   * 必须写回：React 18 StrictMode 会走 `effect → cleanup → effect` 双调用，只挂 cleanup 的话
   * 第二次挂载后标记永远是 false ⇒ 清理请求的 resolve/reject 被整段吞掉，
   * 表现就是「点了清理，弹窗不关、按钮一直在转」。
   */
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  /**
   * 清理：**点确认的那一刻就关掉弹窗**，进度交给卡片上的「立即清理」按钮承载
   * （loading 图标 + 文案「正在清理…」，见下方按钮）。
   *
   * 为什么不把 busy 留在弹窗里转圈：清理可能耗时数秒，而弹窗正好盖住卡片 ——
   * 用户既看不到按钮进入 loading，也看不到释放量从有变没，观感就是「点了没反应」。
   * 关窗**不等于操作可取消**：`busy` 期间刷新与清理按钮一律禁用、不会重复提交；
   * 失败走 toast（卡片保持 ready，不重载列表、不掉回骨架）。
   */
  const runCleanup = (): void => {
    if (busy) return
    setBusy(true)
    setConfirmOpen(false)
    // categories 是**分区白名单**：没勾过期导出就一个导出文件都不碰（硬边界 ②）
    const categories: Array<'tmp' | 'expired-exports'> = ['tmp']
    if (includeExpired) categories.push('expired-exports')
    api.cleanupDiskUsage(categories).then(
      (result) => {
        if (!mountedRef.current) return
        setBusy(false)
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
        toast.error(redact(err instanceof Error ? err.message : String(err)))
      },
    )
  }

  return (
    <Card className={css.activityCard + ' ' + css.diskUsageCard}>
      <div className={css.groupHeader}>
        <span
          className={css.groupLabel}
          title={exportRetentionDays !== null
            ? t('diskUsage.backupRetention', {
              count: String(report?.backupRetention.keepLast ?? 0),
              days: String(exportRetentionDays),
            })
            : undefined}
        >{t('diskUsage.title')}</span>
        {/* 保留期说明属「机制怎么工作」（MOVE 类）：挂在标题文字的 title 上，不再常驻占一行；
            标题旁也不再挂一颗「合计」徽章 —— 下面那行已经是合计，同一个数同一屏出现两次
            只会让人先去比对它们。 */}
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
          {/* 合计一行给出这张卡的两个总数（占用 + 文件数）：逐行不再重复文件数（见下方行注释）。
              统计根路径仍要可查（它决定「这些数字量的是哪里」），但它是**恒定的上下文**，
              不是每次体检都变的结论 ⇒ 进 title，不占一行。 */}
          <div className={css.cellMeta} title={redact(vm.summary.dataDir)}>
            {t('diskUsage.total', { size: vm.summary.total, files: vm.summary.files })}
          </div>
          {/* 读不到的子区如实说明：既不显示 0，也不整卡报错（硬边界：unreadable ≠ 0） */}
          {vm.summary.anyUnreadable && <div className={css.hint}>{t('diskUsage.partial')}</div>}

          {/*
           * 单行式分区行（2026-11-14）：这张卡渲染的是 13 个真实分区，两行式每行 44px 时
           * 一屏只放得下 8 行，且「比大小」被拆到两行（占用在首行、策略徽章在次行）。
           * 现在一行 = 区域名（超长省略，全名在行 title）· 过期量 · 占用 · 回收策略，
           * 13 行一屏读完。文件数不逐行渲染（它不改变「能不能删」这个决定），
           * 总数在合计行、逐行明细留在行 title 里。
           * desc 进 title：它说明「这块是哪来的」，不改变「能不能删」这个决定。
           */}
          <div className={css.planScroll + ' ' + css.diskUsageScroll + ' ' + css.duList} role="list">
            {vm.rows.map((row) => (
              <div
                key={row.id}
                className={css.duRow}
                role="listitem"
                title={row.unreadable ? row.desc : `${row.desc} · ${row.files}`}
              >
                <span className={css.duRowName} title={row.label}>{row.label}</span>
                {row.expired !== null && (
                  <span className={css.duRowNote}>{t('diskUsage.expiredHint', { size: row.expired })}</span>
                )}
                <span className={css.duRowSize}>
                  {row.unreadable ? t('diskUsage.unreadable') : row.size}
                </span>
                {row.policy === 'regenerable' && <Badge kind="ok">{t('diskUsage.policy.regenerable')}</Badge>}
                {row.policy === 'retained' && <Badge kind="info">{t('diskUsage.policy.retained', { retention: row.retention })}</Badge>}
                {row.policy === 'protected' && <span className={css.duRowPolicy}>{t('diskUsage.policy.protected')}</span>}
              </div>
            ))}
          </div>

          <div className={css.groupLabel} title={t('diskUsage.clean.hint')}>{t('diskUsage.clean.title')}</div>

          {/* 清理块三行一套（2026-11-14 用户要求重排位置与间距）：清什么 / 是否连带回收过期备份 /
              释放多少 + 动手按钮。改前每行是一条 `.actionRow[data-inline]`（margin 0）⇒ 行间零间距，
              勾选框贴在前一行下沿；两枚体量徽章一枚紧跟文字、一枚被 spacer 顶到卡右缘 ⇒ 同一块两种摆法。
              现在：统一行距的纵向栈，徽章一律紧跟它管辖的文案，卡右缘只留「立即清理」一颗按钮。 */}
          <div className={css.cleanupLines}>
            {tmpMarket !== undefined && (
              <div className={css.cleanupScope}>
                <span>{tmpMarket.label}</span>
                <Badge kind={tmpMarket.bytes > 0 ? 'info' : 'ok'}>{tmpMarket.size}</Badge>
              </div>
            )}

            {expiredExports !== undefined && (
              <div className={css.cleanupOption}>
                <Checkbox
                  checked={includeExpired}
                  onChange={(next) => { setIncludeExpired(next) }}
                  label={t('diskUsage.clean.includeExpired')}
                />
                {/* 勾选框已经说明了「回收什么」，这里只补可回收量；紧挨着它管辖的那句话，不顶到右缘 */}
                <Badge kind={expiredExports.bytes > 0 ? 'warn' : 'ok'}>{expiredExports.size}</Badge>
              </div>
            )}
          </div>

          <div className={css.cleanupAction}>
            <span className={css.cellMeta}>{t('diskUsage.clean.reclaimableLabel')}</span>
            <span className={css.mono}>{formatBytes(reclaimTargets)}</span>
            <span className={css.statusSpacer} />
            <Button
              variant={includeExpired ? 'danger' : 'primary'}
              disabled={busy || nothingToReclaim}
              loading={busy}
              title={nothingToReclaim ? t('diskUsage.clean.nothing') : undefined}
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
