/**
 * 快照空态页（t43 从 SnapshotsPanel.tsx 物理拆出）：垂直居中 + 图形 + 双 CTA。
 * 纯展示组件：两个动作（查看备份文件 / 立即备份）由调用方注入，本文件不直接调宿主 api。
 * 文案全部来自既有字典键，本层不新增文案、不新增样式。
 */
import type { TranslateNS } from '../client-types.ts'
import { Button } from '../common/ui.tsx'
import { SnapshotIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'

export function SnapshotsEmptyState({ t, onViewFiles, onRunBackup }: {
  t: TranslateNS<'config-manager'>
  /** 「查看备份文件」：切到备份文件子视图 */
  onViewFiles: () => void
  /** 「立即备份」：宿主 runBackupNow（调用方负责刷新备份文件列表） */
  onRunBackup: () => void
}) {
  return (
    <div className={css.emptyHero}>
      <span className={css.emptyHeroSymbol} aria-hidden="true"><SnapshotIcon size={28} /></span>
      <span className={css.emptyHeroTitle}>{t('snapshots.empty.title')}</span>
      <span className={css.emptyHeroBody}>{t('snapshots.empty.body')}</span>
      <div className={css.toolRow} style={{ justifyContent: 'center', marginBottom: 0 }}>
        <Button size="sm" onClick={onViewFiles}>{t('snapshots.empty.viewFiles')}</Button>
        <Button size="sm" variant="primary" onClick={onRunBackup}>
          {t('snapshots.empty.runBackup')}
        </Button>
      </div>
    </div>
  )
}