/**
 * 产物行（UI v2 §6.2）—— 四源共用的唯一行结构。
 *
 * 三层必须分离，这是 DESIGN.md「可点列表行 + 行内按钮」通则的落地：
 *  ① `li.artifactRow`：整行响应**鼠标**点击展开，**不加 role/tabIndex**
 *     （`role="button"` 里再套 `button` 非法，且与全局焦点环规则打架）；
 *  ② `button.artifactExpand`：**键盘与读屏的唯一入口**（aria-expanded + aria-controls +
 *     morphicons 的 ExpandChevron —— 折叠展开是形变层的合法用途）；
 *  ③ `div.artifactActions`：行内动作**全部 stopPropagation**，否则「想展开却删了」（§6.5）。
 *
 * 主操作**永远只有一个**（§6.5：降低误点），其余进 ⋯ 菜单；删除恒 danger。
 * 加密行的主操作文案换成「解锁后导入」—— 动作仍是 import，解锁只是它的第一个阶段。
 */
import { useId } from 'react'
import {
  ARTIFACT_BADGE_LABEL_KEY, ARTIFACT_CAPABILITY_LABEL_KEY, ARTIFACT_KIND_LABEL_KEY,
  type ArtifactBadge, type ArtifactCapability, type ArtifactRow,
} from '../../ui/artifact-view.ts'
import type { UiT } from '../../ui/i18n.ts'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button } from '../common/ui.tsx'
import { ExpandChevron } from '../common/Icon.tsx'
import { MoreMenu } from '../common/MoreMenu.tsx'
import { ArtifactDetail } from './ArtifactDetail.tsx'
import css from '../config-manager.module.css'

/** 徽章 → Badge 四态（§6.2：置顶 info / 当前基线 ok / 加密 warn / 读不到 error） */
const BADGE_KIND: Record<ArtifactBadge, 'info' | 'ok' | 'warn' | 'error'> = {
  'pinned': 'info',
  'current': 'ok',
  'encrypted': 'warn',
  'unreadable': 'error',
}

export interface ArtifactRowViewProps {
  row: ArtifactRow
  t: TranslateNS<'config-manager'>
  uiT: UiT
  /** ISO → 展示时间（主标识是时间时也用它） */
  formatTime: (iso: string) => string
  expanded: boolean
  onToggle: () => void
  onAction: (capability: ArtifactCapability, row: ArtifactRow) => void
  /** 该行有动作在跑：禁用行内按钮（防重复提交） */
  busy?: boolean
  /**
   * cloud-sync 借鉴项 ⑥：该行远端快照的**推送方设备**文案（如「由 <设备名> 推送」）。
   * 只有快照 manifest 真的带 deviceName 时才由调用方给出 —— 缺省 undefined 表示**不渲染**
   * （旧快照没有该字段，绝不显示空串或占位）。
   */
  deviceLabel?: string | undefined
}

export function ArtifactRowView({
  row, t, uiT, formatTime, expanded, onToggle, onAction, busy = false, deviceLabel,
}: ArtifactRowViewProps) {
  const detailId = useId()
  const primary = row.capabilities[0]
  const rest = row.capabilities.slice(1)
  const encrypted = row.badges.includes('encrypted')
  const name = row.title.kind === 'text' ? row.title.value : formatTime(row.title.iso)
  /** 加密徽章的可访问说明（「导入前需解锁」= 安全类文案，必须可见可读，不能只靠颜色） */
  const encryptedHint = t('backupFiles.encryptedHint')

  return (
    <li className={css.artifactRow} data-expanded={expanded ? '' : undefined}>
      <div className={css.artifactRowHead} onClick={onToggle}>
        <button
          type="button"
          className={css.artifactExpand}
          aria-expanded={expanded}
          aria-controls={detailId}
          aria-label={t('library.expand', { name })}
          onClick={(event) => { event.stopPropagation(); onToggle() }}
        >
          <ExpandChevron open={expanded} />
        </button>
        <div className={css.artifactMain}>
          <div className={css.artifactTitle}>
            {/* 来源标签上标题行（定案 B）：来源已由此表达，再放一个 kind 图标属重复表达 */}
            <span className={css.kindTag}>{uiT(ARTIFACT_KIND_LABEL_KEY[row.kind])}</span>
            <span className={css.artifactName} title={name}>{name}</span>
          </div>
          {/* 元数据是**自由序列**而不是表格列：某一段没有（如快照没有体积）就整段不出现，
              绝不补一个「—」占位 —— 这里没有对齐问题，占位只会变成噪音（§3 第三条） */}
          {(row.meta.length > 0 || deviceLabel !== undefined) && (
            <div className={css.artifactMeta}>
              {[...row.meta, ...(deviceLabel === undefined ? [] : [deviceLabel])].join(' · ')}
            </div>
          )}
        </div>
        {row.badges.length > 0 && (
          <div className={css.artifactBadges}>
            {row.badges.map((badge) => (
              <Badge key={badge} kind={BADGE_KIND[badge]} title={badge === 'encrypted' ? encryptedHint : undefined}>
                {uiT(ARTIFACT_BADGE_LABEL_KEY[badge])}
              </Badge>
            ))}
          </div>
        )}
        <div className={css.artifactActions} onClick={(event) => { event.stopPropagation() }}>
          {primary !== undefined && (
            <Button
              size="sm"
              variant={primary === 'delete' ? 'danger' : 'primary'}
              disabled={busy}
              onClick={() => { onAction(primary, row) }}
            >
              {actionLabel(primary, encrypted, uiT)}
            </Button>
          )}
          {rest.length > 0 && (
            <MoreMenu
              items={rest.map((capability) => ({ id: capability, label: actionLabel(capability, encrypted, uiT) }))}
              activeId=""
              onSelect={(id) => { onAction(id as ArtifactCapability, row) }}
              label={t('library.moreActions')}
            />
          )}
        </div>
      </div>
      {/* **始终挂载**：展开/收回由 data-expanded 驱动 CSS 过渡。
          条件渲染会让「收回」没有收尾帧（节点先没了），动画根本播不出来。
          aria-hidden 让读屏在收起时不念到它；内容不可聚焦，所以不必加 inert。 */}
      <div className={css.artifactDetailWrap} id={detailId} aria-hidden={!expanded}>
        <div className={css.artifactDetailInner}>
          <ArtifactDetail row={row} formatTime={formatTime} />
        </div>
      </div>
    </li>
  )
}

/** 加密行的主操作文案换成「解锁后导入」——动作仍是 import */
function actionLabel(capability: ArtifactCapability, encrypted: boolean, uiT: UiT): string {
  if (capability === 'import' && encrypted) return uiT('library.cap.unlockImport')
  return uiT(ARTIFACT_CAPABILITY_LABEL_KEY[capability])
}
