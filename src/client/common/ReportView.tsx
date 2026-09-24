/**
 * 结果报告（规范 §21 导出 / §22 导入 / §17 回滚，绑 src/ui/report.ts）。
 *
 * 直接调用 report.ts 的纯函数（renderExportReport / renderImportReport / renderRollbackReport /
 * importSectionStats / importTotals / importProblems），React 只做外壳：
 * 标题 + 结构化统计 + 「需要你关注」清单 + 分区明细 + 完整文本（渐进披露）。
 * 导入的收尾动作（完成 / 重试）由**向导**的固定操作栏提供（ImportWizardView），
 * 本组件不再渲染动作按钮（原先埋在报告卡底部，被挤压布局裁掉）。
 *
 * 安全约束：所有渲染文本展示前再过 `redact()` 兜底，Secret 不进入 UI。
 */
import type { ExportReport, ImportResult, RollbackReport } from '../../core/types.ts'
import type { SectionId } from '../../schema/types.ts'
import {
  exportCountsText,
  formatBytes,
  importProblems,
  importSectionStats,
  importTotals,
  renderImportReport,
  renderRollbackReport,
  type ImportProblem,
} from '../../ui/report.ts'
import type { ImportSectionStat } from '../../ui/types.ts'
import { redact } from '../../security/redaction.ts'
import { zhUiT, type UiT } from '../../ui/i18n.ts'
import { Badge, Button, Spinner } from './ui.tsx'
import css from '../config-manager.module.css'

export type ReportViewKind = 'export' | 'import'

export interface ReportViewProps {
  kind: ReportViewKind
  exportReport?: ExportReport
  importResult?: ImportResult
  /** 下载导出文件的回调（导出报告场景） */
  onDownload?: () => void
  /** 下载进行中（导出报告场景：下载按钮 spinner + 禁用，防重复下载） */
  downloadBusy?: boolean
  /** 展示层翻译器（缺省 zh；与 ErrorBanner 同策略，不绑定 settings 命名空间） */
  t?: UiT
  /**
   * 分区显示名（SectionId → 文案）。导出报告的分区清单**必须**传 section-labels 的
   * sectionLabeler(t)（分区名的单一映射）；缺省回退裸 id，只允许用于非 UI 场合
   * （禁止让用户看见 pluginFiles 这类适配器 id）。
   */
  sectionLabel?: (id: SectionId) => string
}

/** 导出报告的安全摘要（已包含 / 未包含 / 安全 徽章；文案走 UiT 字典，见 UI-03） */
function ExportSummary({ report, t }: { report: ExportReport; t: UiT }) {
  const included = report.included.length
  const excluded = report.excluded.length
  return (
    <div className={css.statRow}>
      <Badge kind="ok">{t('report.includedCount', { count: included })}</Badge>
      {excluded > 0 && <Badge kind="warn">{t('report.excludedCount', { count: excluded })}</Badge>}
      {report.security.containsSecrets && <Badge kind="warn">{t('report.badgeEncrypted')}</Badge>}
      {!report.security.containsSecrets && <Badge kind="ok">{t('report.badgeNoSecrets')}</Badge>}
      {report.security.redactedHits > 0 && (
        <Badge kind="error">{t('report.badgeRedacted', { count: report.security.redactedHits })}</Badge>
      )}
    </div>
  )
}

/**
 * 导出报告正文（结构化）。
 *
 * 为什么不再直接渲染 renderExportReport 的纯文本：那一整块等宽 pre 里分区名是适配器 id
 * （pluginFiles/sessions）、计数单位是英文键（namespaces/patchLines），与界面上其他地方
 * 的中文分区名（section-labels）自相矛盾。这里改成「中文分区名 + 中文单位」的行式清单，
 * 视觉沿用共享的 .sectionGrid/.sectionRow（与总览「分区构成」卡同一套）。
 * renderExportReport 仍保留给非 UI 场合（文本报告 / run-store 记录），不是替代关系。
 */
function ExportDetails({ report, t, sectionLabel }: { report: ExportReport; t: UiT; sectionLabel?: (id: SectionId) => string }) {
  const label = (id: SectionId): string => sectionLabel?.(id) ?? id
  return (
    <div className={css.reportBody}>
      {/* 保留「备份已创建」这一条状态信息（原先是纯文本报告的首行；结构化后不能凭空消失） */}
      <div className={css.reportHeadline}>{t('report.backupCreated')}</div>
      <div className={css.groupLabel}>{t('report.includedSections')}</div>
      <div className={css.sectionGrid}>
        {report.included.map(({ section, counts }) => {
          const text = exportCountsText(counts, t)
          return (
            <div key={section} className={css.sectionRow}>
              <span className={css.sectionName} title={label(section)}>{redact(label(section))}</span>
              <span className={css.sectionCount}>{text === '' ? '—' : redact(text)}</span>
            </div>
          )
        })}
      </div>

      {report.excluded.length > 0 && (
        <>
          <div className={css.groupLabel}>{t('report.excludedSections')}</div>
          <div className={css.sectionGrid}>
            {report.excluded.map((section) => (
              <div key={section} className={css.sectionRow}>
                <span className={css.sectionName} title={label(section)}>{redact(label(section))}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className={css.groupLabel}>{t('report.security')}</div>
      <div className={css.sectionGrid}>
        <div className={css.sectionRow}>
          <span className={css.sectionName}>{t('report.apiKeysExcluded')}</span>
          <span className={css.sectionCount}>{report.security.secretsExcluded ? t('report.yes') : t('report.no')}</span>
        </div>
        <div className={css.sectionRow}>
          <span className={css.sectionName}>{t('report.containsSecrets')}</span>
          <span className={css.sectionCount}>
            {report.security.containsSecrets ? t('report.yesEncrypted') : t('report.no')}
          </span>
        </div>
        <div className={css.sectionRow}>
          <span className={css.sectionName}>{t('report.encrypted')}</span>
          <span className={css.sectionCount}>{report.security.encrypted ? t('report.yes') : t('report.no')}</span>
        </div>
      </div>
      {report.security.redactedHits > 0 && (
        <div className={css.warnText}>{redact(t('report.redacted', { count: String(report.security.redactedHits) }))}</div>
      )}

      <div className={css.sectionGrid}>
        <div className={css.sectionRow}>
          <span className={css.sectionName}>{t('report.file')}</span>
          <span className={css.sectionCount} title={report.file.name}>
            {redact(report.file.name)} ({formatBytes(report.file.sizeBytes)})
          </span>
        </div>
      </div>

      {report.warnings.length > 0 && (
        <>
          <div className={css.groupLabel}>{t('report.warnings')}</div>
          {report.warnings.map((warning, index) => (
            <div key={String(index)} className={css.warnText}>⚠ {redact(warning)}</div>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * 导入结果「总览」徽章（跨分区合计）—— 取代逐分区 `settings: 6✓ 12≈` 的紧凑天书：
 * 用户第一眼要的是「一共成了多少 / 有没有需要我处理的」。
 */
function ImportTotalsRow({ result, t }: { result: ImportResult; t: UiT }) {
  const totals = importTotals(result.executed)
  return (
    <div className={css.statRow}>
      <Badge kind={totals.ok > 0 ? 'ok' : 'info'}>✓ {totals.ok} {t('report.importedRestored')}</Badge>
      {totals.skipped > 0 && <Badge kind="info">≈ {totals.skipped} {t('report.skipped')}</Badge>}
      {totals.warned > 0 && <Badge kind="warn">⚠ {totals.warned} {t('report.needAttention')}</Badge>}
      {totals.failed > 0 && <Badge kind="error">✗ {totals.failed} {t('report.failed')}</Badge>}
    </div>
  )
}

/**
 * 「需要你关注」：失败 / 警告项 + 原因的结构化清单（限高内滚）。
 *
 * 原实现把这些原因埋在纯文本报告里的一行（`  说明: 插件 x 安装失败…`），用户看到
 * 「⚠ 5 需注意」却无从知道是哪 5 项、为什么；这里把「哪一项 + 什么原因」直接成列。
 */
function ImportProblemList({ problems, labelOf, t }: {
  problems: ImportProblem[]
  labelOf: (section: ImportProblem['section']) => string
  t: UiT
}) {
  return (
    <div className={css.reportBlock}>
      <div className={css.groupLabel}>{t('report.problems', { count: String(problems.length) })}</div>
      <div className={css.reportScroll}>
        <ul className={css.reportList}>
          {problems.map((p) => (
            <li key={p.itemId} className={css.reportProblemRow}>
              <div className={css.reportProblemHead}>
                <Badge kind={p.status === 'failed' ? 'error' : 'warn'}>{labelOf(p.section)}</Badge>
                <span className={css.reportProblemText}>{redact(p.itemId)}</span>
              </div>
              <div className={css.reportProblemReason}>{redact(p.message ?? t('report.unknownReason'))}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** 分区明细：每个分区一行「显示名 + ✓/≈/⚠/✗ 计数」（替代裸 id 的等宽文本行）。 */
function ImportSectionTable({ stats, labelOf, t }: {
  stats: ImportSectionStat[]
  labelOf: (section: ImportProblem['section']) => string
  t: UiT
}) {
  return (
    <div className={css.reportBlock}>
      <div className={css.groupLabel}>{t('report.sectionDetail')}</div>
      <div className={css.reportScroll}>
        <div className={css.reportBody}>
          {stats.map((s) => (
            <div key={s.section} className={css.reportSectionRow}>
              <span className={css.sectionName}>{labelOf(s.section)}</span>
              <span className={css.statusSpacer} />
              <Badge kind="ok">✓ {s.ok}</Badge>
              {s.skipped > 0 && <Badge kind="info">≈ {s.skipped}</Badge>}
              {s.warned > 0 && <Badge kind="warn">⚠ {s.warned}</Badge>}
              {s.failed > 0 && <Badge kind="error">✗ {s.failed}</Badge>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 结果报告视图。
 * 导入：总览 + 「需要你关注」+ 分区明细 + 回滚 + 完整文本（渐进披露），正文全部过 redact()；
 * 导出：结构化摘要 + 正文（既有）；限高内滚见 AGENTS.md §UI 硬性规则 8。
 *
 * 动作按钮**不在这里**：导入的收尾动作（完成 / 重试）属于向导的固定操作栏
 * （ImportWizardView 的 .resultFooter）——原先埋在报告卡底部，被
 * `flex + overflow:hidden` 的挤压布局裁掉，用户报告「导入完成后没有完成按钮」。
 */
export function ReportView({ kind, exportReport, importResult, onDownload, downloadBusy = false, t = zhUiT, sectionLabel }: ReportViewProps) {
  const importStats = kind === 'import' && importResult !== undefined
    ? importSectionStats(importResult.executed)
    : []
  const importProblemList = importResult !== undefined ? importProblems(importResult.executed) : []
  /** 分区显示名（缺省回退裸 id；'other' 走 UiT 的 report.other）。 */
  const labelOf = (section: ImportProblem['section']): string => {
    if (section === 'other') return t('report.other')
    return sectionLabel !== undefined ? sectionLabel(section) : section
  }

  return (
    <div className={css.reportView}>
      {kind === 'export' && exportReport !== undefined && (
        <>
          <ExportSummary report={exportReport} t={t} />
          {/* 限高内滚（DESIGN.md「长列表限高内滚」）；正文是结构化清单而非等宽文本块 */}
          <div className={css.reportScroll}>
            <ExportDetails report={exportReport} t={t} {...(sectionLabel !== undefined ? { sectionLabel } : {})} />
          </div>
          {onDownload !== undefined && (
            <div className={css.reportFooter}>
              <Button variant="primary" onClick={onDownload} loading={downloadBusy}>
                {downloadBusy ? <Spinner /> : t('export.download')}
              </Button>
            </div>
          )}
        </>
      )}
      {kind === 'import' && importResult !== undefined && (
        /* .reportBody = 卡片内边距容器（与导出分支的 ExportDetails 同一个类，不与卡片边框贴合） */
        <div className={css.reportBody}>
          <div className={css.reportHeadline}>
            {importResult.ok ? t('report.importComplete') : t('report.importFailed')}
          </div>
          <ImportTotalsRow result={importResult} t={t} />
          {(importResult.skippedTombstoned?.length ?? 0) > 0 && (
            <div className={css.hint}>
              {t('report.tombstonedSkipped', { count: String(importResult.skippedTombstoned!.length) })}
            </div>
          )}
          {importProblemList.length > 0 && (
            <ImportProblemList problems={importProblemList} labelOf={labelOf} t={t} />
          )}
          {importStats.length > 0 && <ImportSectionTable stats={importStats} labelOf={labelOf} t={t} />}
          {importResult.warnings.length > 0 && (
            <div className={css.reportBlock}>
              <div className={css.groupLabel}>{t('report.warnings')}</div>
              <ul className={css.reportList}>
                {importResult.warnings.map((w, i) => <li key={i} className={css.reportWarningRow}>{redact(w)}</li>)}
              </ul>
            </div>
          )}
          {importResult.rollback !== null && (
            <div className={css.rollbackBox}>
              <strong>{t('report.rollback')}</strong>
              <div className={css.reportScroll}>
                <pre className={css.reportText}>{redact(renderRollbackReport(importResult.rollback as RollbackReport, t))}</pre>
              </div>
            </div>
          )}
          {/* 完整文本报告（渐进披露）：结构化视图已是主路径，这里保留「想逐字核对」的原文入口
              （逐项原因 / 墓碑跳过 / 缺失凭据 / 重启提示都在里面），也保证 renderImportReport
              与结构化视图同源可对照。 */}
          <details className={css.reportDetails}>
            <summary>{t('report.fullText')}</summary>
            <div className={css.reportScroll}>
              <pre className={css.reportText}>{redact(renderImportReport(importResult, t))}</pre>
            </div>
          </details>
        </div>
      )}
    </div>
  )
}
