/**
 * 同步设置弹窗（2026-11-14 用户要求：同步分区 / 加密与密钥导出 / 解密密码三块从通道卡
 * 收进**一个**弹窗 —— 三块各自成卡会把一条通道撑成四张卡，整页读成清单）。
 *
 * 为什么是页签而不是单页竖排：12 个分区勾选已经占满 720 画布的首屏，安全设置与自动同步的
 * 四项策略会被挤到滚动区外 —— 用户点「设置」想改加密时必须先滚过所有分区。页签让每页
 * 首屏见底、高度稳定。
 *
 * 2026-11-14 二次收口（用户三条要求）：① 自动同步与「加密与密码」**合成一页**（三个页签
 * 减到两个 —— 它们都是「这条通道的策略」，原本分两页只是历史遗留）；② 原先挂在「插件」分区
 * 勾选框下的「跟随远端删除插件」搬进这一页（它是策略，不是分区内容）；③ 页面布局按 Stitch
 * 稿 D-39 重排成**行式设置行**（标签左 / 控件右 / 行高 34 / 0.5px 行线），三段的段头各带
 * 自己的开关或状态。
 *
 * 2026-11-14 三次收口（用户要求）：本弹窗**两页的 ⓘ 全部移除**，页签「自动同步与密码」改名「设置」——
 * 说明文案不再挂在图标里，界面只留设置本身（DESIGN.md §7 的「只留能改变用户决定的信息」）。
 *
 * 约定同其余渲染段（t42）：只接收「渲染所需的数据 + 回调」；React 状态、副作用与网络调用
 * 仍在 SyncPanel（单一状态源），可测纯逻辑在 src/ui/sync-settings-view.ts。
 *
 * P0-3：逐会话勾选仍是**同一个 Modal 内的视图切换**（不嵌套第二个 Modal —— 双 overlay 会与
 * 宿主遮罩互相打架，关闭语义也会变得含糊），会话清单复用 ContentPicker。
 */
import { useEffect, useId, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SectionId } from '../../schema/types.ts'
import { Badge, Banner, Button, Card, Checkbox, Segmented, Switch } from '../common/ui.tsx'
import { Modal } from '../common/Modal.tsx'
import { ContentPicker } from '../common/ContentPicker.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import type { SelectionSection } from '../../ui/selection-model.ts'
import {
  initialSessionPicks, pickedSessionIds, sessionPickerSelection,
} from '../../ui/sync-settings-view.ts'
import type { SyncChannelSettingsPatch } from '../../ui/sync-settings-view.ts'
import type { UiT } from '../../ui/i18n.ts'
import { DEFAULT_SYNC_SESSIONS_LIMIT, syncSectionGroups } from './sync-view.ts'
import type { ChannelSyncState, SyncSectionOption } from './sync-view.ts'
import { SyncSecuritySection } from './SyncSecuritySection.tsx'
import { AutosyncCard } from './AutosyncCard.tsx'
import type { AutosyncAutoApplyTier, AutosyncConflictPolicy, AutosyncInterval } from './sync-api.ts'
import css from '../config-manager.module.css'

/** 弹窗内的两个页签：同步内容 / 设置（一条通道的策略全在这一页；2026-11-14 由「自动同步与密码」改名）。 */
type SyncSettingsTab = 'content' | 'settings'

/**
 * 同步设置弹窗（Radix Modal，与通道配置弹窗同一体系）。
 * 勾选与开关**即时生效并持久化**（与导出选择器一致的弹窗语义），因此底部只有「完成」——
 * 没有「取消」（取消会让用户以为改动被丢弃）。
 */
export function SyncSettingsDialog({ open, initialTab, t, cmT, uiT, sectionName, catalog, sections, sessionsLimit, sessionsInclude, deletePlugins, sessionNode, sessionPending, sessionFailed, busy, settings, pendingMerge, onToggleSection, onSessionsLimit, onSessionsInclude, onToggleDeletePlugins, onToggleAutosync, onUpdateAutosyncInterval, onUpdateAutosyncOptions, onToggleEncrypt, onToggleIncludeSecrets, onPatchSettings, onPersistEncryptPassword, onPersistDecryptPassword, onClearSavedPassword, onClose }: {
  t: TranslateNS<'config-manager-sync'>
  /** ui 命名空间的翻译器（UiT）：分区描述与分组说明的**字典键**由它解析（英文界面零中文） */
  uiT: UiT
  /** config-manager 命名空间的翻译器：ContentPicker 的搜索/全选/合计文案来自它 */
  cmT: TranslateNS<'config-manager'>
  open: boolean
  /** 弹窗打开时定位到的初始页签（缺省回落 'content'；失败直达 'settings' 用） */
  initialTab?: SyncSettingsTab
  sectionName: (id: SectionId) => string
  catalog: SyncSectionOption[]
  sections: readonly SectionId[]
  sessionsLimit: number
  /** 显式点名的会话单元 id（非空时优先于 sessionsLimit） */
  sessionsInclude: readonly string[]
  /** 跟随远端删除插件（issue 132；只在 plugins 分区被勾选时可操作） */
  deletePlugins: boolean
  /** 会话单元清单（未取到 / 读取失败 → undefined） */
  sessionNode: SelectionSection | undefined
  sessionPending: boolean
  sessionFailed: boolean
  /** 通道忙碌（同步/推送在途）：自动同步的开关与下拉此时不可改，与页面上的口径一致 */
  busy: boolean
  /** 加密与两个方向的密码（全部属于**这一条通道**；弹窗只读字段 + 回调） */
  settings: Pick<ChannelSyncState, 'encrypt' | 'includeSecrets' | 'encryptPassword' | 'encryptPasswordConfirm' | 'encryptPasswordSaved' | 'decryptPassword' | 'decryptPasswordSaved' | 'autosync' | 'autosyncEnabled' | 'autosyncInterval'>
  /** P2：宿主 sync-state.pendingMerge（有分区等人裁决）；透传给 AutosyncCard 显示状态 */
  pendingMerge?: { sections: string[]; since: string }
  onToggleSection: (id: SectionId, checked: boolean) => void
  onSessionsLimit: (value: number) => void
  /** 点名结果（空数组 = 回到「最新 N 个」模式） */
  onSessionsInclude: (ids: string[]) => void
  onToggleDeletePlugins: (next: boolean) => void
  /** 自动同步（2026-11-14 从通道卡搬进本弹窗；文案与倒计时仍由 AutosyncCard 派生） */
  onToggleAutosync: (enabled: boolean) => void
  onUpdateAutosyncInterval: (interval: AutosyncInterval) => void
  onUpdateAutosyncOptions: (patch: { realtime?: boolean; autoApplyTier?: AutosyncAutoApplyTier; conflictPolicy?: AutosyncConflictPolicy }) => void
  onToggleEncrypt: (next: boolean) => void
  onToggleIncludeSecrets: (next: boolean) => void
  onPatchSettings: (patch: SyncChannelSettingsPatch) => void
  onPersistEncryptPassword: () => void
  onPersistDecryptPassword: () => void
  onClearSavedPassword: () => void
  onClose: () => void
}) {
  /** 页签（关闭即复位到「同步内容」= 用户的心智入口） */
  const [tab, setTab] = useState<SyncSettingsTab>('content')
  /** 内容页内的两个视图：分区目录 / 会话逐项勾选（同一 Modal，不嵌套第二个遮罩） */
  const [view, setView] = useState<'sections' | 'sessions'>('sections')
  useEffect(() => {
    if (!open) {
      setTab('content')
      setView('sections')
      return
    }
    if (initialTab !== undefined) setTab(initialTab)
  }, [open, initialTab])

  const sessionIds = (sessionNode?.units ?? []).map((u) => u.id)
  const sessionNodes: SelectionSection[] = sessionNode === undefined ? [] : [sessionNode]
  const sessionValue = sessionPickerSelection(
    sessionIds,
    initialSessionPicks(sessionIds, sessionsInclude, sessionsLimit),
  )
  /** 「跟随远端删除插件」开关的 id：标签文字点一下就拨动（行式布局里两者不在一个 label 内） */
  const deletePluginsId = useId()

  if (view === 'sessions') {
    return (
      <Modal open={open} onClose={onClose} title={t('mode.sessionsPickTitle')} wide>
        <Modal.Header
          title={t('mode.sessionsPickTitle')}
          closeLabel={t('common.close')}
          onClose={onClose}
        />
        <Modal.Body scroll style={{ maxHeight: '66vh' }}>
          {sessionFailed && <span className={css.hint}>{cmT('picker.unitsUnavailable')}</span>}
          {!sessionFailed && sessionNodes.length === 0 && sessionPending && (
            <Skeleton count={4} label={t('common.loading')} />
          )}
          {!sessionFailed && sessionNodes.length > 0 && (
            <ContentPicker
              nodes={sessionNodes}
              value={sessionValue}
              onChange={(next) => { onSessionsInclude(pickedSessionIds(next, sessionIds)) }}
              t={cmT}
              sectionLabel={sectionName}
              mode="export"
              busy={sessionPending}
            />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button onClick={() => { setView('sections') }}>{t('mode.pickerBack')}</Button>
          <Button variant="primary" onClick={onClose}>{t('mode.pickerDone')}</Button>
        </Modal.Footer>
      </Modal>
    )
  }

  return (
    <Modal open={open} onClose={onClose} title={t('mode.settingsTitle')} wide>
      <Modal.Header
        title={t('mode.settingsTitle')}
        closeLabel={t('common.close')}
        onClose={onClose}
      />
      <Modal.Body scroll style={{ maxHeight: '66vh' }}>
        {/* 页签：两个目标都一屏装得下，用分段而不是并列的两张卡 —— 卡片会让「当前在哪一页」
            变成依靠位置判断，而分段控件的选中态本身就在回答这个问题。 */}
        <Segmented
          items={[
            { id: 'content', label: t('mode.tabContent') },
            { id: 'settings', label: t('mode.tabAutosyncSecurity') },
          ]}
          active={tab}
          onChange={(id) => { setTab(id as SyncSettingsTab) }}
          ariaLabel={t('mode.settingsTitle')}
        />
        {tab === 'settings' ? (
          /* 这条通道的全部策略一页装完（D-39）：自动同步（段头带总开关）→ 加密与密钥导出
             （段头带加密开关）→ 解密密码（段头带「已保存」）→ 插件（跟随远端删除）。
             三段各自成 .settingsGroup，段间距由 .settingsPage 给，段内是行式设置行。 */
          <div className={css.settingsPage}>
            <AutosyncCard
              t={t}
              uiT={uiT}
              settings={settings}
              busy={busy}
              {...(pendingMerge === undefined ? {} : { pendingMerge })}
              onToggleAutosync={onToggleAutosync}
              onUpdateInterval={onUpdateAutosyncInterval}
              onUpdateOptions={onUpdateAutosyncOptions}
            />
            <SyncSecuritySection
              t={t}
              settings={settings}
              onToggleEncrypt={onToggleEncrypt}
              onToggleIncludeSecrets={onToggleIncludeSecrets}
              onPatchSettings={onPatchSettings}
              onPersistEncryptPassword={onPersistEncryptPassword}
              onPersistDecryptPassword={onPersistDecryptPassword}
              onClearSavedPassword={onClearSavedPassword}
            />
            {/* issue 132：插件专属的「跟随远端删除」。原先挂在「插件」分区勾选框下面 ——
                它是一条件随策略（勾了才会真的删），不是分区内容，所以搬到这一页。
                仍然只在 plugins 已被勾选时出现：没勾这个分区，这条开关没有作用对象。 */}
            {sections.includes('plugins') && (
              <div className={css.settingsGroup}>
                <div className={css.settingsGroupHead}>
                  <span className={css.settingsGroupTitle} title={t('mode.pluginsGroupHint')}>{t('mode.pluginsGroup')}</span>
                </div>
                <div className={css.settingsRow}>
                  <span className={css.settingsRowMain}>
                    <label className={css.settingsRowLabel} htmlFor={deletePluginsId} title={t('mode.deletePluginsHint')}>{t('mode.deletePlugins')}</label>
                  </span>
                  <span className={css.settingsRowControl}>
                    <Switch
                      id={deletePluginsId}
                      checked={deletePlugins}
                      onChange={onToggleDeletePlugins}
                      label={t('mode.deletePlugins')}
                    />
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : catalog.length === 0 ? (
          <Skeleton count={4} label={t('common.loading')} />
        ) : (
          /* 分组勾选目录：与「导出备份·自定义模式」同构（分组 Card + 名称/描述/徽章），
             分区名走 section-labels 单一映射 —— 与导出选择器显示**同一个中文名**。 */
          <div className={css.groupList}>
            {syncSectionGroups(catalog, uiT).map((g) => (
              <Card key={g.group} className={css.groupCard}>
                <div className={css.groupHeader}>
                  <span className={css.groupLabel}>{g.label}</span>
                </div>
                <div className={css.groupItems}>
                  {g.items.map((s) => (
                    <div key={s.id} className={css.sectionOptionRow}>
                      <Checkbox
                        checked={sections.includes(s.id)}
                        onChange={(checked) => { onToggleSection(s.id, checked) }}
                        label={
                          <span className={css.categoryItem}>
                            {/* 分区显示名只经 sectionLabeler（禁止在本文件另建一套名字） */}
                            <span className={css.categoryName}>{sectionName(s.id)}</span>
                            <span className={css.categoryDesc}>{s.description}</span>
                            {s.portability === 'portable' && <Badge kind="info">{t('mode.sectionPortable')}</Badge>}
                            {s.portability === 'platformSpecific' && (
                              <Badge kind="warn">{t('mode.sectionPlatformSpecific')}</Badge>
                            )}
                            {s.portability === 'deviceSpecific' && (
                              <Badge kind="warn">{t('mode.sectionDeviceSpecific')}</Badge>
                            )}
                            {s.defaultIncluded && <Badge kind="ok">{t('mode.sectionRecommended')}</Badge>}
                          </span>
                        }
                      />
                      {/* 历史会话专属参数：数量上限 + 逐会话点名。必须放在 Checkbox **之外** ——
                          Checkbox 内部是 label 元素，把输入控件放进去会让点输入框也切换勾选。 */}
                      {s.id === 'sessions' && sections.includes('sessions') && (
                        <div className={css.field}>
                          <div className={css.field}>
                            <span className={css.fieldLabel} title={t('mode.sessionsLimitHint')}>{t('mode.sessionsLimit')}</span>
                            <input aria-label={t('mode.sessionsLimit')}
                              type="number"
                              min={0}
                              max={10000}
                              className={css.input}
                              value={String(sessionsLimit)}
                              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                                onSessionsLimit(e.target.value === '' ? DEFAULT_SYNC_SESSIONS_LIMIT : Number(e.target.value))
                              }}
                            />
                          </div>
                          <div className={css.actionRowTop}>
                            <Button size="sm" onClick={() => { setView('sessions') }}>{t('mode.sessionsPick')}</Button>
                            {sessionsInclude.length > 0 && (
                              <Badge kind="info">{t('mode.sessionsPickCount', { n: String(sessionsInclude.length) })}</Badge>
                            )}
                            {sessionsInclude.length > 0 && (
                              <Button size="sm" onClick={() => { onSessionsInclude([]) }}>
                                {t('mode.sessionsPickReset')}
                              </Button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
        {tab === 'content' && sections.length === 0 && <Banner kind="warn">{t('mode.atLeastOne')}</Banner>}
      </Modal.Body>
      <Modal.Footer>
        {/* 改动即时生效（勾了就走，没有保存按钮）—— 底部只有「完成」，与导出选择器同语义。 */}
        <Button variant="primary" onClick={onClose}>{t('mode.pickerDone')}</Button>
      </Modal.Footer>
    </Modal>
  )
}
