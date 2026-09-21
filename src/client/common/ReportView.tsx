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
import type { SectionId } from '../../schema/types.ts'
import {
  exportCountsText,
  formatBytes,
  importSectionStats,
  renderImportReport,
  renderRollbackReport,
  suggestedActions,
} from '../../ui/report.ts'
import type { ImportResultAction } from '../../ui/types.ts'
import { redact } from '../../security/redaction.ts'
import { zhUiT, type UiT, type UiTextKey } from '../../ui/i18n.ts'
import { Badge, Button, Spinner, type BadgeKind } from './ui.tsx'
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
 * 动作按钮文案：suggestedActions() 返回的是 **动作 id**（'done' / 'fixIssues'…），
 * 不是用户可见文案。原实现直接把 id 渲染进按钮（中文界面显示「done」），
 * 这里映射到字典键再渲染（见 UI-02）。
 */
const ACTION_LABEL: Record<ImportResultAction, UiTextKey> = {
  fixIssues: 'report.action.fixIssues',
  viewDetails: 'report.action.viewDetails',
  done: 'report.action.done',
}

/**
 * 结果报告视图。
 * 文本详情 = report.ts 渲染器的输出（已脱敏），展示前再过 redact() 双保险；
 * 以 <pre> 等宽块呈现保持对齐，容器套 .reportScroll 限高内滚（AGENTS.md §UI 硬性规则 8）。
 */
export function ReportView({ kind, exportReport, importResult, onAction, onDownload, downloadBusy = false, t = zhUiT, sectionLabel }: ReportViewProps) {
  const actions = kind === 'import' && importResult !== undefined
    ? suggestedActions(importResult)
    : []

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
        <>
          <SectionStatBadges result={importResult} />
          <div className={css.reportScroll}>
            <pre className={css.reportText}>{redact(renderImportReport(importResult, t))}</pre>
          </div>
          {importResult.rollback !== null && (
            <div className={css.rollbackBox}>
              <strong>{t('report.rollback')}</strong>
              <div className={css.reportScroll}>
                <pre className={css.reportText}>{redact(renderRollbackReport(importResult.rollback as RollbackReport, t))}</pre>
              </div>
            </div>
          )}
          {actions.length > 0 && (
            <div className={css.reportFooter}>
              {actions.map((a) => (
                <Button key={a} variant={a === 'done' ? 'primary' : 'ghost'} onClick={() => onAction?.(a)}>
                  {t(ACTION_LABEL[a])}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
