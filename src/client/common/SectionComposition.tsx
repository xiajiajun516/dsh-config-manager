/**
 * 分区构成网格（共享渲染原语）。
 *
 * 用途：总览页「分区构成」卡与导出页「本次将导出」数据块共用同一套分区清单渲染
 * （分区名 + 条目数 + 体积，两列网格），保证两处视觉与文案完全一致，避免重复实现漂移。
 *
 * 职责边界：本组件**只渲染网格**——卡片外框（Card）、标题行（含合计 / 跳过提示）
 * 与空判断由调用方负责。纯装配，无业务逻辑、无数据请求、无状态。
 */
import type { SectionId } from '../../schema/types.ts'
import type { TranslateNS } from '../client-types.ts'
import { formatBytes } from '../../ui/report.ts'
import css from '../config-manager.module.css'

/**
 * 行的清单读取状态（F-03）。
 * `loading` / `failed` 时**不显示 0 条目 / 0 B** —— 0 会被读成「这一项没有内容」，
 * 而引擎对清单缺失的分区按**整体导出**处理（语义相反）。未知就如实说未知。
 */
export type SectionCompositionState = 'ready' | 'loading' | 'failed'

export interface SectionCompositionItem {
  section: SectionId
  /** 条目数（state !== 'ready' 时忽略） */
  count: number
  /** 体积字节（state !== 'ready' 时忽略） */
  sizeBytes: number
  /** 清单读取状态；缺省 'ready'（总览页的数据来自 export-preview 全量响应） */
  state?: SectionCompositionState
}

export interface SectionCompositionProps {
  /** 分区构成条目（来自 export-preview 只读预览；顺序原样渲染） */
  sections: SectionCompositionItem[]
  t: TranslateNS<'config-manager'>
  /**
   * 分区显示名（SectionId → 文案）。缺省原样显示 id —— 只有「id 本身就是给开发者看的」
   * 场合才允许省略；用户可见场合一律传 `sectionLabeler(t)`（见 common/section-labels.ts，UI-08）。
   */
  sectionLabel?: (id: SectionId) => string
}

/**
 * 分区构成网格：每行「分区名 · 条目数 · 体积」；未读到清单的行显示读取状态而不是 0。
 */
export function SectionComposition({ sections, t, sectionLabel }: SectionCompositionProps) {
  return (
    <div className={css.sectionGrid}>
      {sections.map((s) => {
        const state = s.state ?? 'ready'
        /* 真·空行降权（2026-11-01）：条目与体积都为 0 的分区（如未启用的 Agent Presets）
           与有内容的行同权重，会让「这一项什么都没有」读成和「941 条」一样重要。
           app-screens §13：零值不给状态色，用灰 —— 有内容但 0 条目的行（如 Prompts 0 条 / 26 B）
           保持正常色，因为它确实带着配置。 */
        const isEmptyRow = state === 'ready' && s.count === 0 && s.sizeBytes === 0
        return (
          <div key={s.section} className={isEmptyRow ? `${css.sectionRow} ${css.sectionRowEmpty}` : css.sectionRow}>
            <span className={css.sectionName}>{sectionLabel?.(s.section) ?? s.section}</span>
            {state === 'ready'
              ? (
                <>
                  <span className={css.sectionCount}>{t('overview.sections.entries', { count: String(s.count) })}</span>
                  <span className={`${css.sectionSize} ${css.mono}`}>{formatBytes(s.sizeBytes)}</span>
                </>
              )
              : (
                <>
                  {/* 读取中 = 中性；读取失败 = warn 语义色（DESIGN.md「状态即语义」） */}
                  <span className={`${css.sectionCount}${state === 'failed' ? ` ${css.warnText}` : ''}`}>
                    {state === 'loading' ? t('picker.loadingSection') : t('picker.sectionLoadFailed')}
                  </span>
                  <span className={`${css.sectionSize} ${css.mono}`}>—</span>
                </>
              )}
          </div>
        )
      })}
    </div>
  )
}
