/**
 * t42 物理拆分（从 SyncPanel.tsx 抽出的渲染段；同领域目录平铺）。
 *
 * 为什么它值得单独一个文件：这张卡有**四条**并列提示带（只读说明 / 首次基线 / 加密 /
 * 含凭据），issue #91 又补了第五条「引擎告警」——留在主文件里只会把
 * `SyncSettingsView.test.ts` 的行数棘轮一节节往上抬（该棘轮的口径：新增行必须是
 * 确实无法下沉的装配；能抽就抽，而不是调上限）。
 *
 * 约定（与 AutosyncCard / WorkDirCard 一致）：只接收「渲染所需的数据」；
 * 渲染模型仍来自 `./sync-view.ts` 的 `pushPreviewView`（纯函数、node 单测覆盖），本文件零逻辑。
 */
import type { TranslateNS } from '../client-types.ts'
import type { SyncPushPreview } from '../../sync/sync-engine.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { SectionId } from '../../schema/types.ts'
import { Banner, Card } from '../common/ui.tsx'
import { pushPreviewView } from './sync-view.ts'
import css from '../config-manager.module.css'

/** P0-②：push 预览内容（绑 src/ui/i18n.ts 的 UiT 文案；纯展示，无敏感字段）。 */
export function PushPreviewCard({ preview, t, uiT, sectionName }: {
  preview: SyncPushPreview | null
  t: TranslateNS<'config-manager-sync'>
  uiT: UiT
  sectionName: (id: SectionId) => string
}) {
  const view = pushPreviewView(preview, uiT)
  if (view === null) return null
  if (view.error !== null) return <Banner kind="error">{view.error}</Banner>
  return (
    <div>
      <Banner kind="info">{view.headline}</Banner>
      {view.previewHint !== '' && <div className={css.hint}>{view.previewHint}</div>}
      {view.remoteSnapshotCount === 0 && (
        <Banner kind="warn">{t('syncflow.pushFirstBaseline')}</Banner>
      )}
      {view.encryptedHint !== '' && <Banner kind="warn">{view.encryptedHint}</Banner>}
      {view.credentialsHint !== '' && <Banner kind="warn">{view.credentialsHint}</Banner>}
      {/* 引擎告警（分区导出失败已跳过 / 本地源插件未打包 ⇒ 该分区不做「无变化」断言，issue #91）：
          如实上屏 —— 否则预览的分区数会静静地少，或者某个分区永远显示「有变化」而无解释 */}
      {view.hint !== '' && <Banner kind="warn">{view.hint}</Banner>}
      <Card className={css.card}>
        <div className={css.groupLabel}>{t('syncflow.pushPreviewSections')}</div>
        <div className={css.planScroll}>
          <ul className={css.reportList}>
            {view.rows.map((row) => (
              <li key={row.section}>
                <span className={css.kindTag}>{row.changed ? t('syncflow.pushChanged') : t('syncflow.pushUnchanged')}</span>
                {' '}{sectionName(row.section)} · {row.count}
              </li>
            ))}
          </ul>
        </div>
      </Card>
    </div>
  )
}
