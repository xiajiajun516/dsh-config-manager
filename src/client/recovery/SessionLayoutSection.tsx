/**
 * 会话布局归位（E2）—— 从 RecoveryPanel.tsx 拆出的独立文件（tech-debt #7）。
 *
 * 归位 = 把「声明了会话但布局里排不上」的会话补进布局；**只读预览（plan）与写盘（apply）同一套行**，
 * 预览不可提交时按钮就是禁用的（`sessionLayoutPlanSubmittable`），绝不「先点了再说」。
 * 写盘进行中态登记在 runStore 的 recovery.write 切片（`use-recovery-write.ts`）：
 * 切页回来仍显示「正在归位」，不会退成可再点一次的按钮。
 */
import { useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Banner, Button, StatusDot } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import {
  sessionLayoutApplyItems,
  sessionLayoutCandidates,
  sessionLayoutKeepState,
  sessionLayoutOverallReasonKey,
  sessionLayoutPlanActionableRows,
  sessionLayoutPlanDisplayRows,
  sessionLayoutPlanSkippedCount,
  sessionLayoutPlanSubmittable,
  sessionLayoutResultCounts,
  sessionLayoutSectionState,
  type SessionLayoutApplyView,
  type SessionLayoutPlanView,
} from '../../ui/session-layout-view.ts'
import type { SessionHealthResponse } from '../../ui/session-inventory-view.ts'
import { sessionIssuesText } from '../../ui/session-issue-labels.ts'
import { redact } from '../../security/redaction.ts'
import { WRITE_KEY, useRecoveryWriteKey, withRecoveryWrite } from './use-recovery-write.ts'
import type { LayoutRecoveryApi } from './recovery-api.ts'
import css from '../config-manager.module.css'

/**
 * 宿主/错误文本渲染前统一过 redact（AGENTS.md §UI 硬性规则 7）。
 * 每个渲染点在各自文件里各留一份局部定义（同 LibraryActions / ExportView / RunsCenter / RollbackCard 的既有口径）。
 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/**
 * E2：面板「会话布局归位 / 重复 id 隔离」写入口（宿主 E1：`POST /recovery/sessions/layout`）。
 *
 * 与字节级修复（/repair）的分工：那条改日志**字节**，这条改**位置** —— 把会话目录搬回首帧 cwd
 * 对应的 projectKey 段，并把重复 id 的其它副本移进隔离目录（可人工找回）。
 *
 * 安全口径（键 `sessions.layout.runtimeNote`）：本入口在 **DSH 运行时**执行，与离线 CLI 的「须先停 DSH」
 * 不同 —— 靠门前置 + 索引刷新必须成功 + 失败逐条回滚；宿主没给索引刷新端口时**一条也不执行**。
 *
 * 硬约束：**本组件不做任何业务判断** —— 候选筛选 / keep 完整性 / 可否提交 / 逐条状态与计数全在
 * `ui/session-layout-view.ts`（含「未执行 / 已回滚不得算成功」的判定），组件只装配与渲染。
 */
interface SessionLayoutSectionProps {
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  response: SessionHealthResponse | null
  /** 执行后重扫列表（结果已落盘，列表必须跟着刷新） */
  onScan: () => void
}

export function SessionLayoutSection({ recoveryApi, t, response, onScan }: SessionLayoutSectionProps) {
  const [plan, setPlan] = useState<SessionLayoutPlanView | null>(null)
  const [applied, setApplied] = useState<SessionLayoutApplyView | null>(null)
  /** sessionId → 用户选定保留的副本 unitId（提交判定在 sessionLayoutKeepState） */
  const [keep, setKeep] = useState<Record<string, string>>({})
  /**
   * 写盘进行中态登记在 runStore（不是组件 state）：切页回来还显示「正在归位」，也不会被再点一次。
   * 两个动作互斥，各自一个 key —— 于是按钮文案能如实区分「预览中」与「写入中」。
   */
  const writeKey = useRecoveryWriteKey()
  const previewing = writeKey === WRITE_KEY.sessionLayoutPreview
  const applying = writeKey === WRITE_KEY.sessionLayoutApply
  const busy = previewing || applying
  /** 客户端/传输层失败（宿主的拒绝走结果里的机器码，不进这里） */
  const [failure, setFailure] = useState<string | null>(null)

  const candidates = sessionLayoutCandidates(response)
  const keepState = sessionLayoutKeepState(plan, keep)
  const submittable = sessionLayoutPlanSubmittable(plan, keepState)
  const planRows = sessionLayoutPlanDisplayRows(plan)
  const actionableRows = sessionLayoutPlanActionableRows(plan)
  const skippedCount = sessionLayoutPlanSkippedCount(plan)
  const planReasonKey = sessionLayoutOverallReasonKey(plan?.reason)
  const appliedReasonKey = sessionLayoutOverallReasonKey(applied?.reason)
  const appliedItems = sessionLayoutApplyItems(applied)
  const counts = sessionLayoutResultCounts(appliedItems)

  const preview = (): void => {
    if (busy) return
    setFailure(null)
    void withRecoveryWrite(WRITE_KEY.sessionLayoutPreview, async () => {
      const request = recoveryApi.layoutRepairSessions?.(false)
      if (request === undefined) {
        setFailure(t('sessions.layout.apiMissing'))
        return
      }
      try {
        const next = await request
        if ('results' in next) { setApplied(next); return }
        setPlan(next)
        setKeep({})
        setApplied(null)
      } catch (err) {
        setFailure(redactErrorText(err))
      }
    })
  }

  const apply = (): void => {
    if (busy || !submittable) return
    setFailure(null)
    void withRecoveryWrite(WRITE_KEY.sessionLayoutApply, async () => {
      const request = recoveryApi.layoutRepairSessions?.(true, keep)
      if (request === undefined) {
        setFailure(t('sessions.layout.apiMissing'))
        return
      }
      try {
        const next = await request
        if ('results' in next) {
          setApplied(next)
          // 结果已落盘（含逐条回滚）：重扫列表是唯一权威，结果视图保留到用户关闭
          onScan()
          return
        }
        setPlan(next)
        setKeep({})
        setApplied(null)
      } catch (err) {
        setFailure(redactErrorText(err))
      }
    })
  }

  // 扫过之后入口**始终可见**（否则本机没有这一档的用户根本找不到它）；只有「还没扫过且手上没计划/结果」才隐藏。
  const sectionState = sessionLayoutSectionState({ response, plan, applied })
  if (sectionState === 'hidden') return null

  // 本档是否真的有可执行的动作：空档时机制散文与运行时告警整段不渲染（DESIGN.md §7 文案分层），
  // 说明走 ⓘ；安全口径（运行时写入门 / 隔离目录不删会话）只在真会写盘时常驻。
  const actionable = sectionState !== 'empty'

  return (
    <div className={css.card}>
      <div className={css.shSectionHead}>
        <span className={css.groupLabel}>{t('sessions.layout.title')}</span>
        <InfoHint text={t('sessions.layout.desc')} label={t('common.infoHint')} />
      </div>
      {/* 与离线 CLI 的差异（它要求先停 DSH）：真会写盘时才占据屏幕（安全告警类，必须可见） */}
      {actionable && <Banner kind="warn">{t('sessions.layout.runtimeNote')}</Banner>}
      {/* 已知为空只给一行状态，不用虚线空框（空框读作「本该有内容却没加载出来」） */}
      {sectionState === 'empty' && (
        <div className={css.statusLine} role="status"><StatusDot kind="ok" /><span>{t('sessions.layout.noCandidates')}</span></div>
      )}
      {candidates.length > 0 && (
        <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
          {candidates.map((candidate) => (
            <div key={candidate.unitId} className={css.shRow}>
              <div className={css.shRowTop}>
                <span className={`${css.shRowId} ${css.mono}`} title={candidate.unitId}>{candidate.sessionId}</span>
              </div>
              <div className={css.shRowMeta}>
                <span>{sessionIssuesText(candidate.issueCodes, t)}</span>
                <span className={css.shMetaDot} aria-hidden="true">·</span>
                <span className={css.mono}>{candidate.projectKey}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* 上方恒有状态行/横幅 ⇒ actionRowTop 自带 10px 上边距（2026-11-04 反馈按钮上下边距） */}
      <div className={css.actionRowTop}>
        <Button variant={actionable ? 'primary' : 'ghost'} loading={previewing} disabled={busy} onClick={preview}>
          {previewing ? t('sessions.layout.previewing') : t('sessions.layout.preview')}
        </Button>
      </div>
      {failure !== null && <Banner kind="error">{failure}</Banner>}
      {applied === null && plan !== null && (
        <div className={css.shPanel}>
          <div className={css.shPanelHead}>
            <span className={css.shPanelTitle}>{t('sessions.layout.planTitle')}</span>
            <InfoHint text={t('sessions.layout.planReadOnly')} label={t('common.infoHint')} />
          </div>
          <div className={css.statRow}>
            <Badge kind="info">{t('sessions.layout.summary', { move: String(plan.summary.move), quarantine: String(plan.summary.quarantine) })}</Badge>
          </div>
          {planReasonKey !== null && <Banner kind="warn">{t(planReasonKey)}</Banner>}
          {planRows.length === 0 && <div className={css.hint}>{t('sessions.layout.planEmpty')}</div>}
          {planRows.length > 0 && (
            <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
              {planRows.map((row) => (
                <div key={row.unitId} className={css.shRow}>
                  <div className={css.shRowTop}>
                    <Badge kind="info">{t(row.kindKey)}</Badge>
                    {row.kind === 'skip' && <Badge kind="warn">{t('sessions.layout.onlyReported')}</Badge>}
                    <span className={`${css.shRowId} ${css.mono}`} title={row.unitId}>{row.sessionId}</span>
                  </div>
                  <div className={css.shRowMeta}>
                    <span>{row.toProjectKey !== null ? row.fromProjectKey + ' → ' + row.toProjectKey : row.fromProjectKey}</span>
                    <span className={css.shMetaDot} aria-hidden="true">·</span>
                    <span>{t(row.reasonKey)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {skippedCount > 0 && <div className={css.statRow}><Badge kind="info">{t('sessions.layout.planSkipped', { count: String(skippedCount) })}</Badge></div>}
          {/* 重复 id：必须选定保留哪一份才可提交（判定在 ui 纯函数层） */}
          {plan.needsKeep.length > 0 && (
            <>
              <div className={css.groupLabel}>{t('sessions.layout.keepTitle')}</div>
              {/* 隔离目录口径（会搬走用户的会话文件 ⇒ 安全类，必须可见）：只在真要处理重复 id 时出现 */}
              <div className={css.hint}>{t('sessions.layout.quarantineNote')}</div>
              {plan.needsKeep.map((sessionId) => (
                <div key={sessionId} className={css.conflictChoices} role="radiogroup" aria-label={sessionId}>
                  {(keepState.candidates[sessionId] ?? []).map((unitId) => {
                    const selected = keep[sessionId] === unitId
                    return (
                      <label key={unitId} className={css.choiceCard} data-selected={selected ? '' : undefined}>
                        <input
                          type="radio"
                          name={'layout-keep-' + sessionId}
                          checked={selected}
                          onChange={() => { setKeep((prev) => ({ ...prev, [sessionId]: unitId })) }}
                        />
                        <span className={css.choiceTitle}>{unitId}</span>
                      </label>
                    )
                  })}
                </div>
              ))}
              {!keepState.complete && <div className={css.statRow}><Badge kind="warn">{t('sessions.layout.keepMissing', { count: String(keepState.missing.length) })}</Badge></div>}
            </>
          )}
          {/* 真的没有动作时不画「执行」（点下去只跑空计划）；不可提交时禁用（判定在纯函数层） */}
          {(actionableRows.length > 0 || plan.needsKeep.length > 0) && (
            <div className={css.actionRow}>
              <Button variant="primary" loading={applying} disabled={busy || !submittable} onClick={apply}>
                {applying ? t('sessions.layout.applying') : t('sessions.layout.apply')}
              </Button>
            </div>
          )}
        </div>
      )}
      {applied !== null && (
        <div className={css.shPanel}>
          <div className={css.shPanelHead}>
            <span className={css.shPanelTitle}>{t('sessions.layout.resultTitle')}</span>
          </div>
          {/* 整体未执行（如 reindex-unavailable）**不是**成功：单独说明，且下面不会有任何成功条目 */}
          {appliedReasonKey !== null && <Banner kind="warn">{t(appliedReasonKey)}</Banner>}
          {appliedItems.length > 0 && (
            <div className={css.statRow}>
              <Badge kind={counts.failedTotal > 0 ? 'warn' : 'ok'}>
                {t('sessions.layout.done', { moved: String(counts.moved), quarantined: String(counts.quarantined), failed: String(counts.failedTotal), skipped: String(counts.skipped) })}
              </Badge>
            </div>
          )}
          {appliedItems.length > 0 && (
            <div className={`${css.snapshotList} ${css.reportScroll} ${css.shScroll}`}>
              {appliedItems.map((item, index) => (
                <div key={item.unitId + '#' + String(index)} className={css.shRow}>
                  <div className={css.shRowTop}>
                    <Badge kind={item.badgeKind}>{t(item.statusKey)}</Badge>
                    <span className={`${css.shRowId} ${css.mono}`} title={item.unitId}>{item.sessionId}</span>
                  </div>
                  <div className={css.shRowMeta}>
                    <span>{item.reasonKey !== null ? t(item.reasonKey) : ''}</span>
                    <span>{item.movedUnitId !== null ? ' → ' + item.movedUnitId : ''}</span>
                    <span>{item.quarantineDir !== null ? ' → ' + item.quarantineDir : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className={css.actionRow}>
            <Button variant="ghost" onClick={() => { setApplied(null); setPlan(null); setKeep({}) }}>
              {t('sessions.layout.close')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
