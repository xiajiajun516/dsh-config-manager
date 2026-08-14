/**
 * 结果报告（规范 §21 导出 / §22 导入 / §17 回滚，绑 src/ui/report.ts）。
 *
 * 直接调用 report.ts 的纯文本渲染器（renderExportReport / renderImportReport /
 * renderRollbackReport / suggestedActions / importSectionStats），React 只做外壳：
 * 标题 + 结构化统计徽章 + 文本详情 + 建议动作按钮。
 *
 * 安全约束：所有渲染文本展示前再过 `redact()` 兜底，Secret 不进入 UI。
 */
import type { ExportReport, ImportResult, RollbackReport } from '../../core/types.ts'
import {
  importSectionStats,
  renderExportReport,
  renderImportReport,
  renderRollbackReport,
  suggestedActions,
} from '../../ui/report.ts'
import type { ImportResultAction } from '../../ui/types.ts'
import { redact } from '../../security/redaction.ts'
import { Badge, Button, type BadgeKind } from './ui.tsx'
import css from '../config-manager.module.css'

export type ReportViewKind = 'export' | 'import'

export interface ReportViewProps {
  kind: ReportViewKind
  exportReport?: ExportReport
  importResult?: ImportResult
  /** 结果页动作回调（Fix Issues / View Details / Done） */
  onAction?: (action: ImportResultAction) => void
  /** 下载导出文件的回调（导出报告场景） */
  onDownload?: () => void
}

/** 导入分区的统计徽章（由 report.importSectionStats 计算） */
function SectionStatBadges({ result }: { result: ImportResult }) {
  const stats = importSectionStats(result.executed)
  return (
    <div className={css.statRow}>
      {stats.map((s) => {
        let kind: BadgeKind = 'ok'
        if (s.failed > 0) kind = 'error'
        else if (s.skipped > 0) kind = 'warn'
        return (
          <Badge key={s.section} kind={kind}>
            {s.section}: {s.ok}✓{s.skipped > 0 ? ` ${s.skipped}≈` : ''}{s.failed > 0 ? ` ${s.failed}✗` : ''}
          </Badge>
        )
      })}
    </div>
  )
}

/** 导出报告的安全摘要（Included / Excluded / Security 徽章） */
function ExportSummary({ report }: { report: ExportReport }) {
  const included = report.included.length
  const excluded = report.excluded.length
  return (
    <div className={css.statRow}>
      <Badge kind="ok">{included} included</Badge>
      {excluded > 0 && <Badge kind="warn">{excluded} excluded</Badge>}
      {report.security.containsSecrets && <Badge kind="warn">encrypted</Badge>}
      {!report.security.containsSecrets && <Badge kind="ok">no secrets</Badge>}
      {report.security.redactedHits > 0 && (
        <Badge kind="error">{report.security.redactedHits} redacted</Badge>
      )}
    </div>
  )
}

/**
 * 结果报告视图。
 * 文本详情 = report.ts 渲染器的输出（已脱敏），展示前再过 redact() 双保险；
 * 以 <pre> 等宽块呈现保持对齐。
 */
export function ReportView({ kind, exportReport, importResult, onAction, onDownload }: ReportViewProps) {
  const actions = kind === 'import' && importResult !== undefined
    ? suggestedActions(importResult)
    : []

  return (
    <div className={css.reportView}>
      {kind === 'export' && exportReport !== undefined && (
        <>
          <ExportSummary report={exportReport} />
          <pre className={css.reportText}>{redact(renderExportReport(exportReport))}</pre>
          {onDownload !== undefined && (
            <div className={css.reportFooter}>
              <Button variant="primary" onClick={onDownload}>Download</Button>
            </div>
          )}
        </>
      )}
      {kind === 'import' && importResult !== undefined && (
        <>
          <SectionStatBadges result={importResult} />
          <pre className={css.reportText}>{redact(renderImportReport(importResult))}</pre>
          {importResult.rollback !== null && (
            <div className={css.rollbackBox}>
              <strong>Rollback</strong>
              <pre className={css.reportText}>{redact(renderRollbackReport(importResult.rollback as RollbackReport))}</pre>
            </div>
          )}
          {actions.length > 0 && (
            <div className={css.reportFooter}>
              {actions.map((a) => (
                <Button key={a} variant={a === 'done' ? 'primary' : 'ghost'} onClick={() => onAction?.(a)}>
                  {a}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
