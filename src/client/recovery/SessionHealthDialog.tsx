/**
 * 会话体检弹窗（T5/T10）—— 从 RecoveryPanel.tsx 拆出的独立文件（tech-debt #7）。
 *
 * 写盘动作（单条修复 apply、一键修复、ZIP 导出）的「进行中」态：
 *  - 修复 apply / 批量 → runStore 的 recovery.write 切片（`use-recovery-write.ts`），切页回来仍显示进行中；
 *  - ZIP 下载走浏览器下载（无写盘、无 run），仍是组件内短瞬态（zipBusy）—— 它没有「回来还要接着看」的语义。
 * 批量修复期间只占一个槽（session-repair-all）：逐行 spinner 退化为整体禁用，哪几条成了看批量结果，
 * 不为了一个瞬态高亮把「一个动作一个槽」的模型拆掉。
 */
import { useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, Empty, IconButton, Spinner, StatusDot } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { Icon } from '../common/Icon.tsx'
import { CopyButton } from '../common/CopyButton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { SkeletonTable } from '../common/Skeleton.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { toast } from '../common/toast-store.ts'
import {
  formatSessionBytes,
  sessionHealthEmpty,
  sessionHealthPhase,
  sessionHealthRows,
  sessionHealthSummaryView,
  sessionHealthTruncated,
  sessionIssueChips,
  sessionRepairBatchEntry,
  sessionRepairCommands,
  sessionRepairEntries,
  sessionRepairReasonKey,
  sessionRepairVerifyKey,
  sessionSeverityChips,
  type SessionHealthResponse,
  type SessionRepairBatchEntryView,
  type SessionRepairEntryView,
  type SessionRepairResult,
} from '../../ui/session-inventory-view.ts'
import { sessionIssueKey, sessionIssuesText } from '../../ui/session-issue-labels.ts'
import {
  sessionExportEntryState,
  sessionExportReasonText,
  type SessionExportProbe,
} from '../session-export/session-export-view.ts'
import { redact } from '../../security/redaction.ts'
import { WRITE_KEY, useRecoveryWriteKey, withRecoveryWrite } from './use-recovery-write.ts'
import { formatRecoveryTime } from './recovery-view.ts'
import { SessionLayoutSection } from './SessionLayoutSection.tsx'
import type { LayoutRecoveryApi } from './recovery-api.ts'
import css from '../config-manager.module.css'

/**
 * 宿主/错误文本渲染前统一过 redact（AGENTS.md §UI 硬性规则 7）。
 * 每个渲染点在各自文件里各留一份局部定义（同 LibraryActions / ExportView / RunsCenter / RollbackCard 的既有口径）。
 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/**
 * 「会话体检」弹窗（T10）—— 结果与全部动作都在这里：摘要在顶、列表在中（限高内滚）、
 * 修复计划与台账在底部。**本组件不做任何业务判断**（严重级/摘要/可修判定/原因映射全在 ui/ 纯函数里）。
 *
 * 交互约定：打开即扫（scanVersion 变化重扫）；修复一律先 dry-run 预览（零写入），有损计划必须再点
 * 「截断并修复」才执行；回滚走 ConfirmDialog（danger）。
 */
export interface SessionHealthDialogProps {
  open: boolean
  onClose: () => void
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  clipboardT: TranslateNS<'config-manager'>
  response: SessionHealthResponse | null
  loading: boolean
  error: string | null
  onScan: () => void
  /** F-2：官方 session.export 的可用性（null = 还没探出来 → 入口显示加载态，不误判禁用）。 */
  zipProbe: SessionExportProbe | null
  /** 供「下载原始日志 (ZIP)」拼下载地址（同一份 api 实例，别新起一个）。 */
  api: import('../api.ts').ConfigManagerApi
}
export function SessionHealthDialog(props: SessionHealthDialogProps) {
  const { open, onClose, recoveryApi, t, clipboardT, response, loading, error, onScan, zipProbe, api } = props
  /**
   * F-2：「下载原始日志 (ZIP)」入口的三态判定（**唯一**判定点在 ui/ 纯函数里，组件只映射）。
   *
   * 为什么不在组件里判 `status !== 501`（竞品做法）：那条判据在本机 DSH 上**已过时** ——
   * 服务缺失返的是 500 而不是 501，照抄会让入口几乎恒显示。判定与理由见 session-export-view.ts。
   */
  const zipState = sessionExportEntryState(zipProbe)
  const zipHint = sessionExportReasonText(zipState, t)
  const phase = sessionHealthPhase({ loading, error, response })
  /**
   * 本地的「已修复」行集合：批量/单条修复成功后**就地更新界面**，不再整屏重扫。
   *
   * 为什么：重扫要重新遍历整个会话库（真机 1024 条、行档 200 条），用户点完「一键修复」
   * 会被迫再等一次全量扫描、列表还会整屏重排。这里只把受影响的行标成「已修复并移出列表」，
   * 需要最新全貌时用户自己点「开始体检」。
   *
   * **声明必须在使用它的 `rows` 之前** —— 后置声明会触发 TDZ 的
   * `ReferenceError: Cannot access 'repairedUnits' before initialization`，
   * 而插槽异常会把整个插件面板（settings.section）整块打掉（真机白屏）。
   */
  const [repairedUnits, setRepairedUnits] = useState<ReadonlySet<string>>(new Set())
  // 已修复的行就地移出列表（不需要重扫：宿主那边确实改了文件，这里只是不再显示）
  const rows = sessionHealthRows(response).filter((row) => !repairedUnits.has(row.unitId))
  const summary = sessionHealthSummaryView(response)
  const truncated = sessionHealthTruncated(response)
  const repairEntries = sessionRepairEntries(response)
  /** 严重级 chips（只留 count>0 的档，短标签进屏 / 完整句进 title）—— 判定与顺序全在 ui 纯函数层 */
  const severityChips = sessionSeverityChips(summary)
  /**
   * 进行中的写盘动作（预览 / 应用 / 批量 / 回滚）。
   *
   * 住在 runStore 的 recovery.write 切片（tech-debt #7）：**关掉弹窗或切页再回来，仍看得出「还在写」**，
   * 也点不了第二次。此前它只是组件 useState，一卸载就没了。
   * 只占一个槽：这些动作本就互斥（都在同一个弹窗里），单槽让「当前在写什么」永远只有一个答案。
   */
  const writeKey = useRecoveryWriteKey()
  const anyWrite = writeKey !== null
  const batchRunning = writeKey === WRITE_KEY.sessionRepairAll
  /** 该会话是否正被单条动作（预览 / 应用 / 回滚）占着 */
  const isBusy = (unitId: string): boolean => writeKey === WRITE_KEY.sessionRepair(unitId)
  /**
   * F-2：正在下载原始日志的会话 id（进行中态住组件内 —— 弹窗不跨页签，无需进 runStore）。
   *
   * 为什么必须有：ZIP 可达数百 MB，点下去到浏览器开始落盘之间可能好几秒，
   * 没有任何反馈会被当成「点了没反应」而反复点击。
   */
  const [zipBusy, setZipBusy] = useState<string | null>(null)
  /** 触发一次 ZIP 下载；**失败必须显式报告**（绝不静默）。 */
  const downloadZip = (sessionId: string): void => {
    if (zipBusy !== null) return
    setZipBusy(sessionId)
    api.downloadSessionExport(sessionId)
      .then((result) => { toast.ok(t('sessions.zip.done', { name: result.filename })) })
      // 错误文本走 toast（与本节其它动作同一口径；http 层已脱敏）。
      .catch((err) => { toast.error(t('sessions.zip.failed') + ': ' + redactErrorText(err)) })
      .finally(() => { setZipBusy(null) })
  }
  /** 预览得到的修复计划（应用前必须显式确认；ok=false 时也在这里显示拒绝原因） */
  const [plan, setPlan] = useState<{ unitId: string; result: SessionRepairResult } | null>(null)
  /**
   * 应用成功后的结果（含写后真 codec 复验结论）。
   *
   * 为什么必须有：修复「写完了」与「DSH 现在能读它」是两件事 —— 没有复验结论时（如 unavailable）
   * 把这次修复当成普通成功呈现，正是本轮要消灭的谎报。行已从列表移出，所以结果留在这里。
   */
  const [applied, setApplied] = useState<{ unitId: string; result: SessionRepairResult } | null>(null)
  /**
   * 复验三态 / 危险态的字典键（**判定全部在 ui 纯函数层**，组件只装配 —— 见 sessionRepairVerifyKey）。
   * null = 没有复验结论（预览路径）⇒ 不渲染这一行，绝不臆造「已验证」。
   */
  const planVerifyKey = plan !== null ? sessionRepairVerifyKey(plan.result.verify, plan.result.rolledBack) : null
  const appliedVerifyKey = applied !== null ? sessionRepairVerifyKey(applied.result.verify, applied.result.rolledBack) : null
  /** 待确认的回滚目标（ConfirmDialog，danger） */
  const [rollbackTarget, setRollbackTarget] = useState<SessionRepairEntryView | null>(null)
  /**
   * 一键修复全部：进行中 + 本轮结果。
   *
   * `results` 逐条留痕（单位 id / 备份名 / 成功或被拒的**机器可读原因**）——用户点完必须看得见
   * 「哪几条成了、哪几条为什么没成」，绝不只给一个计数。
   */
  const [batch, setBatch] = useState<{ ok: number; failed: number; results: SessionRepairBatchEntryView[] } | null>(null)

  const startRepair = (unitId: string): void => {
    setPlan(null)
    setApplied(null)
    void withRecoveryWrite(WRITE_KEY.sessionRepair(unitId), async () => {
      try {
        setPlan({ unitId, result: await recoveryApi.repairSession(unitId, false) })
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
  }

  /**
   * 一键修复全部：对**当前列表里可修的行**逐条走完整安全序列（预览 → 应用）。
   *
   * 三条纪律：① **逐条独立** —— 一条被拒（指纹变化 / 校验不过 / 有损未确认）不影响其余；
   * ② **有损不批量** —— 需要截断（lossy）的计划跳过并计入 failed，绝不代替用户做有损决定；
   * ③ 结果如实计数（成功/被拒），做完重新扫描（台账与列表随之刷新）。
   */
  const repairAll = async (): Promise<void> => {
    const targets = rows.filter((row) => row.repairable).map((row) => row.unitId)
    if (targets.length === 0) return
    setBatch(null)
    let ok = 0
    let failed = 0
    const results: SessionRepairBatchEntryView[] = []
    const done: string[] = []
    await withRecoveryWrite(WRITE_KEY.sessionRepairAll, async () => {
      for (const unitId of targets) {
        try {
          const plan = await recoveryApi.repairSession(unitId, false)
          if (!plan.ok) {
            failed += 1
            results.push(sessionRepairBatchEntry({
              unitId,
              sessionId: plan.sessionId ?? unitId,
              ok: false,
              ...(plan.reason !== undefined ? { reason: plan.reason } : {}),
            }))
            continue
          }
          if (plan.lossy === true) {
            // 有损（截断）绝不批量代做 —— 逐条确认是硬约束，这里如实说明「需要你逐条确认」
            failed += 1
            results.push(sessionRepairBatchEntry({ unitId, sessionId: plan.sessionId ?? unitId, ok: false, reason: 'lossy-required', lossy: true }))
            continue
          }
          const applied = await recoveryApi.repairSession(unitId, true, plan.expect)
          if (applied.ok) {
            ok += 1
            done.push(unitId)
            results.push(sessionRepairBatchEntry({
              unitId,
              sessionId: applied.sessionId ?? unitId,
              ok: true,
              droppedRows: applied.droppedRows ?? 0,
              ...(applied.verify !== undefined ? { verify: applied.verify } : {}),
              ...(applied.rolledBack !== undefined ? { rolledBack: applied.rolledBack } : {}),
            }))
          } else {
            failed += 1
            // A2-F1：失败分支与成功分支**同源**搬运 —— verify-failed 必带 verify，
            // rolledBack===false（自动回滚未成功）是危险态，必须在批量视图里可见。
            results.push(sessionRepairBatchEntry({
              unitId,
              sessionId: applied.sessionId ?? unitId,
              ok: false,
              ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
              ...(applied.verify !== undefined ? { verify: applied.verify } : {}),
              ...(applied.rolledBack !== undefined ? { rolledBack: applied.rolledBack } : {}),
            }))
          }
        } catch (err) {
          failed += 1
          results.push(sessionRepairBatchEntry({
            unitId,
            sessionId: unitId,
            ok: false,
            transportError: err instanceof Error ? err.message : String(err),
          }))
        }
      }
    })
    setBatch({ ok, failed, results })
    // **就地更新**：把修好的行标成「已修复」并从列表移除，不再整屏重扫（用户要最新全貌时自己点体检）
    if (done.length > 0) setRepairedUnits((prev) => new Set([...prev, ...done]))
    if (ok > 0) toast.ok(t('sessions.repair.applied', { rows: String(results.filter((r) => r.ok).reduce((n, r) => n + (r.droppedRows ?? 0), 0)) }))
  }

  /** 确认应用：带上预览指纹（TOCTOU）；有损计划必须显式放行（applyLossy）。 */
  const applyRepair = (): void => {
    if (plan === null) return
    const { unitId, result } = plan
    void withRecoveryWrite(WRITE_KEY.sessionRepair(unitId), async () => {
      try {
        const next = await recoveryApi.repairSession(unitId, true, result.expect, result.lossy === true)
        if (next.ok) {
          toast.ok(t('sessions.repair.applied', { rows: String(next.droppedRows ?? 0) }))
          setPlan(null)
          // 结果（含复验三态）留在面板上：绝不把「写完了」说成「已可加载」
          setApplied({ unitId, result: next })
          setRepairedUnits((prev) => new Set([...prev, unitId]))
        } else {
          // 应用期被拒（指纹变化 / 校验不过 / 写失败）：**就地给出真实原因**，不假装成功
          setPlan({ unitId, result: next })
        }
      } catch (err) {
        toast.error(redactErrorText(err))
      }
    })
  }

  const doRollback = async (): Promise<void> => {
    const target = rollbackTarget
    if (target === null) return
    await withRecoveryWrite(WRITE_KEY.sessionRepair(target.unitId), async () => {
      try {
        const result = await recoveryApi.rollbackSessionRepair(target.repairId)
        if (result.ok) {
          toast.ok(t('sessions.repair.rolledBack'))
          setRollbackTarget(null)
          onScan()
        } else {
          toast.error(t(sessionRepairReasonKey(result.reason)))
          setRollbackTarget(null)
        }
      } catch (err) {
        toast.error(redactErrorText(err))
        setRollbackTarget(null)
      }
    })
  }

  return (
    <>
      <Modal open={open} onClose={onClose} title={t('sessions.title')} wide busy={anyWrite}>
        <Modal.Header
          title={t('sessions.title')}
          onClose={onClose}
          closeLabel={t('common.close')}
          trailing={(
            <span className={css.shHeaderTrailing}>
              {/* 机制说明（扫什么 / 四档严重级 / 哪些能在应用内修）—— 与入口卡片上那颗 ⓘ 同一条键 */}
              <InfoHint text={t('sessions.desc')} label={t('common.infoHint')} />
              {/* 主操作搬进标题行：旧实现是正文左上角孤零零一颗按钮（要先滚过摘要才找得到） */}
              <Button
                size="sm"
                variant={response === null ? 'primary' : 'ghost'}
                loading={loading}
                disabled={loading}
                onClick={onScan}
              >
                {loading ? t('sessions.scanning') : response === null ? t('sessions.scan') : t('sessions.rescan')}
              </Button>
            </span>
          )}
        />
        <Modal.Body scroll>
          {zipHint !== null && <Banner kind="warn">{zipHint}</Banner>}

          {phase === 'error' && <Banner kind="error">{error ?? t('common.unknownError')}</Banner>}

          {/* 首次扫描（还没有任何结果）：给出进行中反馈 —— 旧实现在这里只留一片空白 */}
          {/* 首次扫描：按会话表的形状铺骨架（表格行），扫描结果到货时表格原地长出来 */}
          {phase === 'loading' && response === null && <SkeletonTable rows={6} label={t('sessions.scanning')} />}

          {phase === 'ready' && response !== null && (
            <>
              {!response.sessionsDirExists && <Banner kind="warn">{t('sessions.noRoot')}</Banner>}
              {response.sessionsDirExists && sessionHealthEmpty(response) && <Empty>{t('sessions.empty')}</Empty>}
              {summary !== null && summary.total > 0 && (
                <>
                  {/* ① 概览：先把数字给出来（旧实现是一串同款徽章，看不出哪个数是重点） */}
                  <div className={css.shSummary}>
                    <div className={css.shMetrics}>
                      <div className={css.shMetric}>
                        <span className={css.shMetricValue}>{String(summary.total)}</span>
                        <span className={css.shMetricLabel}>{t('sessions.metric.total')}</span>
                      </div>
                      <div className={css.shMetric} data-tone={summary.needsAttention > 0 ? 'warn' : 'ok'}>
                        <span className={css.shMetricValue}>{String(summary.needsAttention)}</span>
                        <span className={css.shMetricLabel}>{t('sessions.metric.attention')}</span>
                      </div>
                      {summary.targetFormatVersion !== null && (
                        <div className={css.shMetric}>
                          <span className={css.shMetricValue}>{'v' + String(summary.targetFormatVersion)}</span>
                          <span className={css.shMetricLabel}>{t('sessions.metric.format')}</span>
                        </div>
                      )}
                    </div>
                    {severityChips.length > 0 && (
                      <div className={css.shSeverities}>
                        {severityChips.map((chip) => (
                          <span key={chip.severity} className={css.shSeverity} data-severity={chip.severity} title={t(chip.fullKey)}>
                            <StatusDot kind={chip.badgeKind} />
                            <span>{t(chip.shortKey)}</span>
                            <span className={css.shSeverityCount}>{String(chip.count)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* 数据口径：这次统计覆盖了多少（未深度校验 / 被隐藏的正常会话 / 超上限 / 读不出条目）。
                        全部常驻可见 —— 「未验证 ≠ 没问题」「绝不静默少显示」是本面板的既定口径。 */}
                    <div className={css.shNotes}>
                      {summary.deepUnverified > 0 && <Badge kind="info">{t('sessions.unverified', { count: String(summary.deepUnverified), verified: String(summary.deepVerified) })}</Badge>}
                      {summary.hiddenHealthy > 0 && <Badge kind="info">{t('sessions.hidden.healthyShort', { count: String(summary.hiddenHealthy) })}</Badge>}
                      {summary.untested > 0 && <Badge kind="info">{t('sessions.untested', { count: String(summary.untested) })}</Badge>}
                      {summary.unreadableEntries > 0 && <Badge kind="warn">{t('sessions.unreadableEntries', { count: String(summary.unreadableEntries) })}</Badge>}
                    </div>
                  </div>

                  {/* E2：本档（blocksStartup 的 location-mismatch / duplicate-id）的**应用内写入口**。
                      只在有候选行或手上有计划/结果时渲染；判定与键映射全在 ui/session-layout-view.ts。 */}
                  <SessionLayoutSection
                    recoveryApi={recoveryApi}
                    t={t}
                    response={response}
                    onScan={onScan}
                  />

                  {/* ② 需要处理的会话：列表与「一键修复全部」同屏，动作恒在区块头右侧 */}
                  <div className={css.shSectionHead}>
                    {/* 操作说明属说明性文案 → 完整句进 ⓘ（DESIGN §7）；「可应用内修复 N 条」这种
                        计数句已删（右上按钮本身就带同一个计数）。 */}
                    <span className={css.shSectionTitle}>
                      {t('sessions.section.attention')}
                      <InfoHint text={summary.repairable > 0 ? t('sessions.repair.available', { count: String(summary.repairable) }) : t('sessions.repair.none')} label={t('common.infoHint')} />
                    </span>
                    <Badge kind={rows.length > 0 ? 'warn' : 'ok'}>{String(rows.length)}</Badge>
                    {summary.repairable > 0 && (
                      <>
                        <span className={css.statusSpacer} />
                        <Button
                          size="sm"
                          variant="primary"
                          loading={batchRunning}
                          disabled={anyWrite}
                          onClick={repairAll}
                        >
                          {t('sessions.repair.repairAll', { count: String(summary.repairable) })}
                        </Button>
                      </>
                    )}
                  </div>

                  {/* 一键修复的全部结果（逐条留痕 + 复验结论）：绝不只给一个计数 */}
                  {batch !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle}>
                          {t('sessions.repair.allDone', { ok: String(batch.ok), failed: String(batch.failed) })}
                        </span>
                      </div>
                      <div className={css.snapshotList}>
                        {batch.results.map((item) => {
                          // 一键修复的成功项同样要说出复验结论（三态判定在 ui 纯函数层，组件只查字典），
                          // 与单条修复路径同一个纯函数、同一套 locale 键（失败项也必须给出复验结论）
                          const verifyKey = sessionRepairVerifyKey(item.verify, item.rolledBack)
                          return (
                            <div key={item.unitId} className={css.shRow}>
                              <div className={css.shRowTop}>
                                <Badge kind={item.ok ? 'ok' : 'warn'}>
                                  {item.ok ? t('sessions.repair.batch.ok') : t('sessions.repair.batch.failed')}
                                </Badge>
                                <span className={`${css.shRowId} ${css.mono}`} title={item.unitId}>{item.sessionId}</span>
                              </div>
                              <div className={css.shRowMeta}>
                                <span>
                                  {item.ok
                                    ? t('sessions.repair.batch.dropped', { rows: String(item.droppedRows ?? 0) })
                                    : item.transportError !== undefined
                                      ? t('sessions.repair.batch.transportError', { message: item.transportError })
                                      : item.lossy === true
                                        ? t('sessions.repair.reason.lossyRequired')
                                        : t(sessionRepairReasonKey(item.reason))}
                                </span>
                                {verifyKey !== null && (
                                  <>
                                    <span className={css.shMetaDot} aria-hidden="true">·</span>
                                    <span className={css.mono}>{t(verifyKey)}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* 修复计划（dry-run 结果）。ok=false 时显示**真实拒绝原因**，不给假成功 */}
                  {plan !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle} title={plan.unitId}>
                          {t('sessions.repair.plan.title', { session: plan.result.sessionId ?? plan.unitId })}
                        </span>
                      </div>
                      {plan.result.ok ? (
                        <>
                          <div className={css.statRow}>
                            <Badge kind="info">{t('sessions.repair.plan.summary', { rows: String(plan.result.droppedRows ?? 0), before: formatSessionBytes(plan.result.bytesBefore ?? 0), after: formatSessionBytes(plan.result.bytesAfter ?? 0) })}</Badge>
                          </div>
                          <div className={css.shLines}>
                            {(plan.result.actions ?? []).map((action) => (
                              <div key={action.code} className={css.hint}>
                                <Badge kind={action.lossy ? 'warn' : 'ok'}>
                                  {action.lossy ? t('sessions.repair.actionLossy') : t('sessions.repair.actionLossless')}
                                </Badge>
                                {' '}{action.detail}
                              </div>
                            ))}
                          </div>
                          <div className={css.hint}>{t('sessions.repair.plan.backup')}</div>
                          {plan.result.lossy === true && (
                            <div className={css.hint}>{t('sessions.repair.plan.lossy')}</div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className={css.hint}>{t(sessionRepairReasonKey(plan.result.reason))}</div>
                          {/* 被拒不是「没反应」：告诉用户下一步能做什么（重扫 / 稍后再试 / 用离线命令） */}
                          <div className={css.hint}>{t('sessions.repair.rejectedNext')}</div>
                        </>
                      )}
                      {/* 写后真 codec 复验结论（现役读盘可读 / 迁移链可还原 / 未验证 / 回滚失败）——
                          key 由 ui 纯函数判定，组件不写三态逻辑 */}
                      {planVerifyKey !== null && <div className={css.hint}>{t(planVerifyKey)}</div>}
                      <div className={css.actionRow}>
                        {plan.result.ok && (
                          <Button variant="primary" loading={anyWrite} onClick={applyRepair}>
                            {plan.result.lossy === true ? t('sessions.repair.applyLossy') : t('sessions.repair.apply')}
                          </Button>
                        )}
                        <Button variant="ghost" disabled={anyWrite} onClick={() => { setPlan(null) }}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* 应用成功后的结果（含真 codec 复验结论）：绝不把「写完了」说成「已可加载」 */}
                  {applied !== null && (
                    <div className={css.shPanel}>
                      <div className={css.shPanelHead}>
                        <span className={css.shPanelTitle} title={applied.unitId}>
                          {applied.result.sessionId ?? applied.unitId}
                        </span>
                      </div>
                      <div className={css.statRow}><Badge kind="ok">{t('sessions.repair.applied', { rows: String(applied.result.droppedRows ?? 0) })}</Badge></div>
                      {appliedVerifyKey !== null && <div className={css.hint}>{t(appliedVerifyKey)}</div>}
                      <div className={css.actionRow}>
                        <Button variant="ghost" onClick={() => { setApplied(null) }}>
                          {t('common.close')}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ③ 需要处理的会话列表：两行式行卡 + 限高内滚（DESIGN §8 硬性规则） */}
                  {rows.length === 0
                    ? <div className={css.statusLine} role="status"><StatusDot kind="ok" /><span>{t('sessions.section.attentionNone')}</span></div>
                    : (
                      <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
                        {rows.map((row) => {
                          /** 问题 chip：最多 2 条进屏、其余折叠（条数如实给出，全文进 title） */
                          const issueChips = sessionIssueChips(row.issueCodes)
                          const facts = [
                            row.versionText,
                            row.sizeText,
                            row.mtimeMs !== null ? formatRecoveryTime(String(row.mtimeMs)) : null,
                          ].filter((value): value is string => value !== null).join(' · ')
                          return (
                            <div key={row.unitId} className={css.shRow} data-severity={row.severity}>
                              <div className={css.shRowTop}>
                                {/* 徽章只放短标签（「阻断启动」），完整句（「会让 DSH 起不来」）进 title */}
                                <Badge kind={row.badgeKind} title={t(row.severityKey)}>{t(row.severityShortKey)}</Badge>
                                {row.subagent && <Badge kind="info">{t('sessions.subagent')}</Badge>}
                                {/* 行首最宽的位置给**对话标题**：用户要认的是「哪条是我的对话」，不是 uuid。
                                    宿主没给标题时回落目录名（绝不编造）；全文进 title，脱敏已在 ui 展示模型里做过。 */}
                                <span className={css.shRowId} title={row.title ?? row.unitId}>
                                  {row.title ?? (row.blank ? t('sessions.blank') : row.sessionId)}
                                </span>
                                <div className={css.shRowActions}>
                                  {/* 可应用内修复的类别（与体检的 repairable 同源判定）；点开先 dry-run，绝不直接写 */}
                                  {row.repairable && (
                                    <Button
                                      size="sm"
                                      loading={isBusy(row.unitId)}
                                      disabled={anyWrite && !isBusy(row.unitId)}
                                      onClick={() => { startRepair(row.unitId) }}
                                    >
                                      {t('sessions.repair.action')}
                                    </Button>
                                  )}
                                  {/* F-2：下载该会话的原始日志 ZIP（**只读**；由 DSH 自己打包，含子会话与附件）。
                                      不可用时**禁用并给出原因**（不静默消失）—— 三态判定在 session-export-view.ts。 */}
                                  <IconButton
                                    icon={zipBusy === row.sessionId ? <Spinner /> : <Icon name="download" />}
                                    label={t('sessions.zip.action')}
                                    title={zipHint ?? t('sessions.zip.hint')}
                                    disabled={!zipState.enabled || zipBusy !== null}
                                    onClick={() => { downloadZip(row.sessionId) }}
                                  />
                                </div>
                              </div>
                              <div className={css.shRowMeta}>
                                {/* 目录名常驻可见（等宽）：它是修复 / 下载要核对的主键，也是「没有标题」时的唯一标识 */}
                                <span className={css.mono} title={row.unitId}>{row.sessionId}</span>
                                {issueChips.codes.map((code) => (
                                  <span key={code} className={css.shIssue} title={row.issueDetailText ?? undefined}>
                                    {t(sessionIssueKey(code))}
                                  </span>
                                ))}
                                {issueChips.hidden > 0 && (
                                  <span className={css.shIssue} title={sessionIssuesText(row.issueCodes, t)}>
                                    {t('sessions.issues.more', { count: String(issueChips.hidden) })}
                                  </span>
                                )}
                                {facts !== '' && <span className={css.shRowFacts}>{facts}</span>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  {truncated > 0 && <div className={css.hint}>{t('sessions.truncated', { count: String(truncated) })}</div>}

                  {/* 应用内不动的问题类别：离线出路（命令逐条可复制） */}
                  <div className={css.shSectionHead}>
                    <span className={css.shSectionTitle}>{t('sessions.repair.title')} <InfoHint text={t('sessions.repair.desc')} label={t('common.infoHint')} /></span>
                  </div>
                  <ul className={css.shCommands}>
                    {sessionRepairCommands().map((entry) => (
                      <li key={entry.command} className={css.shCommand}>
                        <code className={css.mono}>{entry.command}</code>
                        <CopyButton text={entry.command} label={t('sessions.repair.copy')} t={clipboardT} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* 本机修复台账（可回滚）。回滚只认 repairId —— 界面拿不到也传不了路径 */}
              {repairEntries.length > 0 && (
                <>
                  <div className={css.shSectionHead}>
                    <span className={css.shSectionTitle}>{t('sessions.repair.history.title')}</span>
                    <Badge kind="info">{String(repairEntries.length)}</Badge>
                  </div>
                  <div className={css.snapshotList}>
                    {repairEntries.map((entry) => (
                      <div key={entry.repairId} className={css.shRow}>
                        <div className={css.shRowTop}>
                          <Badge kind={entry.rolledBack ? 'info' : 'ok'}>
                            {entry.rolledBack ? t('sessions.repair.history.rolledBack') : t('sessions.repair.history.applied')}
                          </Badge>
                          <span className={`${css.shRowId} ${css.mono}`} title={entry.unitId}>{entry.sessionId}</span>
                          {!entry.rolledBack && (
                            <div className={css.shRowActions}>
                              <Button size="sm" disabled={anyWrite} onClick={() => { setRollbackTarget(entry) }}>
                                {t('sessions.repair.rollback')}
                              </Button>
                            </div>
                          )}
                        </div>
                        <div className={css.shRowMeta}>
                          <span>{t('sessions.repair.history.dropped', { rows: String(entry.droppedRows) })}</span>
                          {entry.at !== null && (
                            <>
                              <span className={css.shMetaDot} aria-hidden="true">·</span>
                              <span className={css.mono}>{formatRecoveryTime(String(entry.at))}</span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {response.repairsError !== undefined && (
                <div className={css.hint}>{t('sessions.repair.history.unreadable')}</div>
              )}
            </>
          )}
        </Modal.Body>
      </Modal>
      {/*
        回滚确认（danger）：会把日志换回修复前的备份内容 —— 与其它危险动作同规，
        必须走显式确认弹窗（Radix Dialog 承载 a11y），绝不内联一键回滚。
      */}
      <ConfirmDialog
        open={rollbackTarget !== null}
        title={t('sessions.repair.rollbackConfirmTitle')}
        message={t('sessions.repair.rollbackConfirmMessage', { session: rollbackTarget?.sessionId ?? '' })}
        confirmLabel={t('sessions.repair.rollbackConfirm')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={doRollback}
        onCancel={() => { setRollbackTarget(null) }}
      />
    </>
  )
}
