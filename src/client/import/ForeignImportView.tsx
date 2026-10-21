/**
 * 外部 agent 来源选择（t17）—— 导入任务的**第一个页面级步骤**。
 *
 * 为什么是页面级步骤而不是 Modal：既有导入向导是「面板内的多阶段流程」（Select ZIP →
 * Analyzing → … → Result），把来源选择做成弹窗就成了「弹窗套向导」。而且仓库既有注释
 * 明确记录过：把发起动作的 Modal 渲染进 task 面板，**定位基准会变成那块侧滑区域**
 * （见 ConfigManagerSection 的 libraryAction 注释）。所以本组件是普通页面内容，
 * 只有「单次决策」类交互才用 Modal。
 *
 * 职责（严格按 AGENTS.md 的 UI 分层铁律）：
 *  · **本组件只装配**：判定与文案映射全在 `src/ui/foreign-view.ts` 的纯函数里（node 可测）；
 *  · **数据访问只走类型化 api 类**（`api.foreignSources` / `api.foreignImport`），组件内**不 fetch**；
 *  · 产出的 zipPath 经 `onReady` 上抛给既有导入向导（**绝不**新建第二套向导）。
 *
 * 三条交互纪律：
 *  ① **未检测到的来源也列出来**（置灰、不可选）：用户才知道「本机确实没有这个工具」，
 *     而不是「这个功能没做」；
 *  ② **空来源不可选**（found 但读不到任何内容）：点进去必然空手，禁用比报错友好；
 *  ③ **失败必须说清**：产包失败按宿主回的机器码映射文案，绝不静默留在原页；
 *  ④ **输入一变，旧结果立刻作废**（F-3，照 dsh-movein 的 resetPreview 语义）：切换来源或
 *     重新检测都会清掉上一次的产包结果与失败横幅，并在页面上留下可见反馈 —— 否则屏幕上
 *     留着的是**上一个来源**的结果（用户会以为它就是刚选的那个来源的）。
 *
 * 另有 F-5 的「三类已知有损」：它们在**导入前**就摆明（文件类分区不剥离明文 / 条目名中段
 * 反斜杠的跨平台落点 / prompts 的 systemPrompt 形状变化），只做可见性，不改引擎语义。
 */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { ConfigManagerApi, ForeignImportResponse } from '../api.ts'
import type { UiT } from '../../ui/i18n.ts'
import { foreignLossyRows, foreignPathsText, foreignSourcesViewModel, type ForeignSourceRow } from '../../ui/foreign-view.ts'
import { Badge, Banner, Button, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { SkeletonList } from '../common/Skeleton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface ForeignImportViewProps {
  api: ConfigManagerApi
  t: TranslateNS<'config-manager'>
  /** 渲染模型层的翻译器（来源名 / skip 码文案在那本字典里，见 t16） */
  uiT: UiT
  /**
   * 产包成功：把 zipPath 交给**既有导入向导**。
   *
   * 由上层（ConfigManagerSection）负责「写进 runStore.library.pendingZip 并切到导入面板」——
   * 复用产物库「一键导入」那条已被验证的通道（它连容器形态一起带过去），
   * 而不是在这里再造一条 seed 路径。
   */
  onReady: (result: ForeignImportResponse) => void
}

/** 来源卡的一行（装配件：只渲染，判定全在 view model） */
function SourceRow(props: {
  row: ForeignSourceRow
  selected: boolean
  disabled: boolean
  uiT: UiT
  onSelect: (id: string) => void
}) {
  const { row, selected, disabled, uiT, onSelect } = props
  return (
    <button
      type="button"
      className={css.sourceRow}
      data-selected={selected ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      disabled={disabled}
      aria-pressed={selected}
      onClick={() => { onSelect(row.id) }}
    >
      <span className={css.sourceRowMain}>
        <span className={css.sourceRowHead}>
          <span className={css.sourceRowName}>{row.label}</span>
          {/* 状态徽章语义由 view model 给定（未检测到 = info，不是 error） */}
          <Badge kind={row.badge}>{row.statusText}</Badge>
        </span>
        {/* 命中路径：等宽 + 任意位置换行（长 Windows 路径不撑宽行，见 §16 的 .sourcePaths） */}
        <span className={css.sourcePaths}>{foreignPathsText(row, uiT)}</span>
      </span>
    </button>
  )
}

/** 一条未迁移项：稳定机器码 + 人话（码本身可见，便于用户搜索 / 上报） */
function SkipLine(props: { code: string; text: string; meta: string }) {
  return (
    <li className={css.skipRow}>
      <span className={css.skipCode}>{props.code}</span>
      <span className={css.skipText}>{props.text}</span>
      {props.meta !== '' && <span className={css.skipMeta}>{props.meta}</span>}
    </li>
  )
}

/**
 * 来源选择页。
 *
 * 加载态与错误态都是**首屏**状态：检测失败时不留空白页，而是给出可重试的红色横幅
 * （否则用户看到的是一张空列表，会以为「本机什么都没装」——那是**假结论**）。
 */
export function ForeignImportView({ api, t, uiT, onReady }: ForeignImportViewProps) {
  const [vm, setVm] = useState<ReturnType<typeof foreignSourcesViewModel>>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  /** 最近一次产包结果的跳过项与凭据引用（产包成功后仍显示，供用户在进向导前先看到） */
  const [produced, setProduced] = useState<ForeignImportResponse | null>(null)
  /** F-3：上一次的产包结果因输入变化被作废 —— 重置必须在 UI 上有反馈（绝不静默） */
  const [previewReset, setPreviewReset] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    api.foreignSources().then(
      (res) => {
        if (cancelled) return
        setVm(foreignSourcesViewModel(res, uiT))
        setLoading(false)
      },
      (err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      },
    )
    return () => { cancelled = true }
  }, [api, uiT, tick])

  const rows = vm?.rows ?? []
  /**
   * 三类已知有损的展示行（F-5）：尚未产包时 applicable=null（界面不渲染适用性徽章），
   * 产包后按包内分区逐条标注是否适用。判定全在 src/ui/foreign-view.ts 的纯函数里。
   */
  const lossyRows = foreignLossyRows(produced?.sections ?? null, uiT)

  /**
   * 作废上一次的产包结果（F-3）：任何输入变化都走这里。
   *
   * 「上一次的产包结果」与「上一次的失败横幅」都属于上一次输入 —— 只清 produced 而留着
   * 失败横幅，用户会把上一个来源的失败读成刚选的这个来源的失败。
   */
  const resetProduced = (): void => {
    if (produced !== null) setPreviewReset(true)
    setProduced(null)
    setImportError(null)
  }

  /** 切换来源：同一个来源重复点击不算输入变化（不重置，免得谎报「已作废」）。 */
  const handleSelect = (id: string): void => {
    if (id === selected) return
    setSelected(id)
    resetProduced()
  }

  /** 重新检测：检测结果本身也是输入（来源可能新增/消失），与切换来源同档作废旧结果。 */
  const handleRefresh = (): void => {
    resetProduced()
    setTick((n) => n + 1)
  }

  /** 产包 → 交给既有导入向导。 */
  const runImport = async (): Promise<void> => {
    if (selected === null) return
    setImporting(true)
    setImportError(null)
    setProduced(null)
    setPreviewReset(false)
    try {
      const result = await api.foreignImport(selected)
      setProduced(result)
      // 交给上层 → 写进 runStore.library.pendingZip → 导入面板消费（复用既有通道）
      onReady(result)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  if (loading) {
    return (
      <div className={css.viewBody}>
        <SectionTitle title={t('foreign.source.title')} />
        <div className={css.marketReviewPage}>
          {/* 来源卡还没到货：按来源卡（卡片列表）的形状铺骨架，不再只给一个居中转圈 */}
          <SkeletonList count={4} label={t('foreign.source.loading')} />
        </div>
      </div>
    )
  }

  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('foreign.source.title')} info={<InfoHint text={t('foreign.source.hint')} label={t('common.infoHint')} />} />

      {loadError !== null && (
        <ErrorBanner
          error={loadError}
          onRetry={() => { setTick((n) => n + 1) }}
          t={uiT}
        />
      )}

      {loadError === null && vm !== null && !vm.anyFound && (
        <Banner kind="info">{t('foreign.source.empty')}</Banner>
      )}

      {/* 冲突策略（用户决策：同 id 不覆盖、跳过并报码）——
          在用户点下去**之前**就把规则说清楚，而不是等他遇到冲突才解释。 */}
      {vm !== null && vm.conflictPolicy !== null && (
        <div className={css.hint}>{t('foreign.conflict.policy')}</div>
      )}


      <div className={css.marketReviewPage}>
        <div className={css.marketReviewScroll}>
          <div className={css.sourceList}>
            {rows.map((row) => (
              <SourceRow
                key={row.id}
                row={row}
                selected={selected === row.id}
                // 未检测到 / 读到空 → 不可选（点进去必然空手）
                disabled={!row.found || row.empty}
                uiT={uiT}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 三类已知有损（F-5）：不阻断导入，也不会出现在兼容性评分里（评分对它们零原因）。
          三条文案与判定都在纯函数 foreignLossyRows 里，这里只摆放；产包后逐条标注本包是否
          适用（未产包时不给徽章，绝不写「不适用」）。
          **位置**：来源列表之后、动作行（含「开始导入」）之前 —— 既保证「导入前必读」，
          又不把六个来源挤出首屏（t10 的 T10-F2 真机体验反馈）。 */}
      <Card>
        <div className={css.groupLabel}>{t('foreign.lossy.title')} <InfoHint text={t('foreign.lossy.hint')} label={t('common.infoHint')} /></div>
        <ul className={css.skipList}>
          {lossyRows.map((row) => (
            <li key={row.kind} className={css.skipRow}>
              {row.applicable !== null && (
                <Badge kind={row.applicable ? row.severity : 'info'}>
                  {row.applicable ? t('foreign.lossy.applies') : t('foreign.lossy.notApplies')}
                </Badge>
              )}
              <span className={css.skipText}>
                <strong>{redact(row.title)}</strong>{' '}
                {redact(row.detail)}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {/* 选中来源的未迁移项：**在选它之后**才展开，避免六来源的码堆在一起淹没有效信息 */}
      {(() => {
        const row = rows.find((r) => r.id === selected) ?? null
        if (row === null || row.skips.length === 0) return null
        return (
          <Card>
            <div className={css.groupLabel}>
              {t('foreign.skipped', { count: String(row.skips.length) })}
            </div>
            <ul className={css.skipList}>
              {row.skips.map((s, i) => (
                <SkipLine
                  key={s.code + '-' + String(i)}
                  code={s.code}
                  // 文案来自字典（机器码 → 人话），渲染前过 redact 兜底（路径可能含用户名）
                  text={redact(s.text)}
                  meta={s.count !== undefined ? String(s.count) : ''}
                />
              ))}
            </ul>
          </Card>
        )
      })()}

      {/* F-3 的重置反馈：旧结果被输入变化作废时**必须说出来**，否则用户以为结果丢了 */}
      {previewReset && <Banner kind="info">{t('foreign.previewReset')}</Banner>}

      {/* 产包结果（成功后才出现）：让用户在进向导前先看到「包里有什么」 */}
      {produced !== null && (
        <Card>
          <div className={css.groupLabel}>{t('foreign.previewTitle')} <InfoHint text={t('foreign.previewDryRun')} label={t('common.infoHint')} /></div>
          <div className={css.statRow}>
            <Badge kind="ok">
              {t('foreign.previewSections', { sections: produced.sections.join(' · ') })}
            </Badge>
            {produced.credentialRefs.length > 0
              ? <Badge kind="warn">{t('foreign.credentialRefs', { count: String(produced.credentialRefs.length) })}</Badge>
              : <Badge kind="info">{t('foreign.credentialRefsNone')}</Badge>}
          </div>
        </Card>
      )}

      {importError !== null && (
        <Banner kind="error">{t('foreign.importFailed', { reason: redact(importError) })}</Banner>
      )}

      <div className={css.actionRow}>
        <Button onClick={handleRefresh} disabled={importing}>
          {t('foreign.action.refresh')}
        </Button>
        <Button variant="primary" onClick={() => { void runImport() }} disabled={importing || selected === null}>
          {importing ? <Spinner label={t('foreign.importing')} /> : t('foreign.action.import')}
        </Button>
      </div>
    </div>
  )
}
