/**
 * 迁移前咨询卡（Phase 7）：展示健康评分徽章 + 维度明细 + 建议 + 触发项。
 *
 * 纯渲染模型来自 src/ui/migration-consult-view.ts（consultView，node 单测覆盖），
 * 组件只做装配。安全：所有展示文本渲染前过 redact() 兜底（REDACTED 不变量辅防线）。
 * 复用公共原语：Card / Badge / Banner / SectionTitle；维度明细限高内滚。
 */
import type { ConsultReport } from '../../core/migration-consult.ts'
import { consultReasonGroups, consultView } from '../../ui/migration-consult-view.ts'
import type { UiT } from '../../ui/i18n.ts'
import { Badge, Banner, Card, SectionTitle } from '../common/ui.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface ConsultCardProps {
  report: ConsultReport
  t: UiT
  /** 卡片标题（缺省「迁移前咨询」） */
  title?: string
}

/** 迁移前咨询卡：健康评分 + 维度明细 + 建议 + 触发项 */
export function ConsultCard({ report, t, title }: ConsultCardProps) {
  const view = consultView(report, t)
  // 建议依据：core 的 reasons 是各维度 issue message 的拼接，存在重复；
  // 去重后逐条展示，重复条目以「×N」标注（count 由 consultReasonGroups 统计）
  const reasonGroups = consultReasonGroups(view.reasons)
  return (
    <Card className={css.card}>
      <SectionTitle title={title ?? t('consult.title')} />
      <div className={css.statRow}>
        <Badge kind={view.verdictBadgeKind}>
          {t('consult.healthScore', { score: String(view.healthScore) })}
        </Badge>
        <Badge kind={view.recommendationBadgeKind}>{view.recommendationLabel}</Badge>
        {/* 结论的可核对依据：硬阻断（为什么不能导）与需处理项（要做什么）分开计数 ——
            不再让一个分数代替结论（用户实测抱怨过「评分 89 却建议阻止执行」）。 */}
        {view.blockerCount > 0 && (
          <Badge kind="error">{t('consult.blockers', { count: String(view.blockerCount) })}</Badge>
        )}
        {view.attentionCount > 0 && (
          <Badge kind="warn">{t('consult.attention', { count: String(view.attentionCount) })}</Badge>
        )}
        <Badge kind="info">{t('consult.dryRun')}</Badge>
      </div>

      {/* 建议触发项：去重后每条一行（不再依赖 Banner 的 flex 换行） */}
      {reasonGroups.length > 0 && (
        <Banner kind={view.verdictBadgeKind === 'error' ? 'error' : view.verdictBadgeKind === 'warn' ? 'warn' : 'info'}>
          <div className={css.groupLabel}>{t('consult.reasons')}</div>
          <div className={css.reasonList}>
            {reasonGroups.map((g) => (
              <div key={g.message} className={css.reasonLine}>
                <span>{redact(g.message)}</span>
                {g.count > 1 && <Badge kind="info">{`×${g.count}`}</Badge>}
              </div>
            ))}
          </div>
        </Banner>
      )}

      {/* 将应用摘要 */}
      <div className={css.consultSection}>
        <div className={css.groupLabel}>{t('consult.willApply')}</div>
        <div className={css.statRow}>
          {view.willApply.sections.length > 0 && (
            <Badge kind="info">{t('consult.sections', { count: String(view.willApply.sections.length) })}</Badge>
          )}
          {view.willApply.itemCount > 0 && (
            <Badge kind="info">{t('consult.items', { count: String(view.willApply.itemCount) })}</Badge>
          )}
          {view.willApply.conflicts > 0 && (
            <Badge kind="warn">{t('consult.conflicts', { count: String(view.willApply.conflicts) })}</Badge>
          )}
          {view.willApply.risks > 0 && (
            <Badge kind="warn">{t('consult.risks', { count: String(view.willApply.risks) })}</Badge>
          )}
        </div>
      </div>

      {/* 维度明细（限高内滚） */}
      <div className={css.consultSection}>
        <div className={css.groupLabel}>{t('consult.dimensions')}</div>
        <div className={css.consultScroll}>
          {view.dimensions.map((d) => (
            <div key={d.id} className={css.consultDimension}>
              <div className={css.statRow}>
                <Badge kind={d.badgeKind}>{d.label}</Badge>
                <Badge kind="info">{d.score}</Badge>
              </div>
              {d.issues.length > 0 && (
                <ul className={css.reportList}>
                  {d.issues.map((issue, i) => (
                    <li key={i}>{redact(issue.message)}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  )
}
