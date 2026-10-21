/**
 * 导入向导的各步骤视图（每个步骤一个具名子组件）
 *
 * t45 物理拆分：从 client/import/ImportWizardView.tsx 抽出。
 * 职责：只做渲染与交互接线（业务派生在 src/ui/import-wizard.ts，状态在 use-import-wizard-controller.ts）。
 * 行为与视觉保持不变（JSX 逐字搬运，仅参数化）。
 */
import type { ChangeEvent, MutableRefObject } from 'react'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import { mergeSecretInput } from '../../ui/import-wizard.ts'
import type { ImportAnalysis, PathMapping } from '../../core/types.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import type { TranslateNS } from '../client-types.ts'
import type { UiT } from '../../ui/i18n.ts'
import {
  Banner, Button, Card, Checkbox, Empty, SectionTitle, Spinner,
} from '../common/ui.tsx'
import { Skeleton } from '../common/Skeleton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ErrorBanner, ErrorList } from '../common/ErrorBanner.tsx'
import { CopyButton } from '../common/CopyButton.tsx'
import {
  SESSION_FORMAT_DOCTOR_COMMAND,
  sessionFormatNewest,
  type SessionFormatFacts,
} from '../../ui/session-format-disposition.ts'
import type { SessionFormatDisposition } from '../../core/types.ts'
import { ProgressBar } from '../common/ProgressBar.tsx'
import type { RunProgress } from '../common/progress-view.ts'
import { ConflictList } from './ConflictList.tsx'
import { PathMappingForm } from './PathMappingForm.tsx'
import { ConsultCard } from '../consult/ConsultCard.tsx'
import { browseLabelKey, consumePickedFile } from './import-file-select.ts'
import css from '../config-manager.module.css'
/**
 * 密钥补录表单（仅内存收集，值不外泄；onChange 写入 store 的仅内存字段）。
 *
 * 受控组件（UI-06）：输入值直接来自 store 的 `secretInputs` —— 本组件**不自己持有**输入
 * 状态。原因：该页是可来回切换的中间步骤，组件会随阶段切换卸载重挂；若以本地 state 为准，
 * 「上一步」再回来会显示空输入框而提交集合里仍是旧值（看到的值 ≠ 提交的值），
 * 且在空表上编辑任一字段会把其它 ref 已填的值丢掉。合并一律经 mergeSecretInput（src/ui）。
 */
export function SecretsForm({
  missing,
  value,
  t,
  onChange,
}: {
  missing: { ref: string; required: boolean }[]
  /** 当前提交集合（store 的 secretInputs；唯一事实） */
  value: Record<string, string>
  t: TranslateNS<'config-manager'>
  onChange: (inputs: Record<string, string>) => void
}) {
  const setRef = (ref: string, next: string): void => {
    onChange(mergeSecretInput(value, ref, next))
  }
  return (
    <div className={css.secretsList}>
      {missing.length === 0 && <Empty>{t('import.secrets.none')}</Empty>}
      {missing.map((s) => (
        <label key={s.ref} className={css.field}>
          <span className={css.fieldLabel}>
            {s.ref} {s.required ? t('import.secrets.required') : t('import.secrets.optional')}
          </span>
          <input
            type="password"
            className={css.input}
            autoComplete="off"
            value={value[s.ref] ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setRef(s.ref, e.target.value) }}
          />
        </label>
      ))}
    </div>
  )
}

/**
 * 导入执行日志面板（importing 步骤进度条下方）：展示导入过程中执行的命令
 * （逐计划项操作 `▶/✓/⚠/✗/–` + 子进程命令行 `$ dsh plugin …`）。
 * - 数据来自 Host RunRegistry（经 /progress 轮询回传），行文本仅非敏感内容，
 *   渲染前再过 redact() 兜底（安全不变量：UI 展示文本先脱敏）；
 * - 限高内滚（logScroll）；**智能自动滚动**：仅当用户贴近底部时跟随最新行；
 *   用户向上滚动查看历史时不强制拉回，改显示「↓ 新输出」提示，点击再滚到底部；
 * - memo 自定义比较：lines 数组为同一引用被 append（RunState.log push 不换引用），
 *   按引用浅比较无法感知新行 —— 比较长度 + t 引用，避免整页轮询反复重渲染整个列表。
 */
export function SelectStep(props: {
  fileInput: MutableRefObject<HTMLInputElement | null>
  selectModel: { selectedName: string | null }
  uploading: boolean
  error: string | null
  onCancel: () => void
  onPickFile: (file: File | undefined) => void
  onReset: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
  /**
   * 「从其它 agent 导入」入口（t17，**可选**）：壳层注入 uiT 与导航回调时才渲染。
   *
   * 为什么放在本步而不是加一级页签：导入是 Task 面板里的多阶段流程，外部来源只是
   * 「包从哪来」的另一种选择 —— 与「选择 ZIP 文件」并列，用户心智上是同一件事的两个入口。
   * 老调用方不传该 prop → 本区块不渲染，既有行为逐字不变。
   */
  foreignEntry?: { uiT: UiT; onOpen: () => void }
}) {
  const { fileInput, selectModel, uploading, error, onCancel, onPickFile, onReset, apiT, t, foreignEntry } = props
  return (
    <div className={`${css.viewBody} ${css.sparseFill}`}>
      <SectionTitle title={t('import.select.title')} info={<InfoHint text={t('import.select.hint')} label={t('common.infoHint')} />} />
      <input
        ref={fileInput}
        type="file"
        accept=".zip,application/zip"
        className={css.hiddenFile}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          // 恒清空 input value → 同一文件再次选择也会触发 onChange（同文件换选）
          const file = consumePickedFile(e.target.files?.[0], e.target)
          void onPickFile(file)
        }}
      />
      {selectModel.selectedName !== null && (
        <div className={css.hint} data-testid="import-selected-file">
          {t('import.select.file', { name: selectModel.selectedName })}
        </div>
      )}
      <div className={css.actionRow} style={{ marginBottom: 0 }}>
        {selectModel.selectedName !== null && (
          <Button variant="ghost" onClick={onCancel}>
            {t('import.select.cancel')}
          </Button>
        )}
        <Button
          variant="primary"
          disabled={uploading}
          onClick={() => { fileInput.current?.click() }}
        >
          {uploading ? <Spinner label={t('import.analyzing')} /> : t(browseLabelKey(selectModel.selectedName !== null))}
        </Button>
      </div>
      {error !== null && <ErrorBanner error={error} onRetry={onReset} t={apiT} />}
      {foreignEntry !== undefined && (
        <>
          <div className={css.actionRow} style={{ marginBottom: 0 }}>
            <Button onClick={foreignEntry.onOpen}>{t('foreign.source.title')}</Button>
            <InfoHint text={t('foreign.source.hint')} label={t('common.infoHint')} />
          </div>
        </>
      )}
    </div>
  )
}

/** 分析中（step=analyzing）：进度条 + 错误。 */
export function AnalyzingStep(props: {
  progress: RunProgress | null
  error: string | null
  errors: string[]
  onReset: () => void
  apiT: UiT
}) {
  const { progress, error, errors, onReset, apiT } = props
  return (
    <div className={css.viewBody}>
      <ProgressBar event={progress} active t={apiT} />
      {error !== null && <ErrorBanner error={error} onRetry={onReset} t={apiT} />}
      <ErrorList errors={errors} />
    </div>
  )
}

/** 兼容性结论（step=compatibility）。 */
export function ConsultStage(props: {
  consultLoading: boolean
  consultReport: ConsultReport | null
  error: string | null
  onNext: () => void
  onReset: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const { consultLoading, consultReport, error, onNext, onReset, apiT, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.preview.title')} info={<InfoHint text={t('import.consult.hint')} label={t('common.infoHint')} />} />
      {consultLoading && <Skeleton shape="line" count={5} label={apiT('consult.loading')} />}
      {consultReport !== null && <ConsultCard report={consultReport} t={apiT} />}
      {!consultLoading && consultReport === null && (
        <Banner kind="info">{t('import.consult.unavailable')}</Banner>
      )}
      {error !== null && <ErrorBanner error={error} onRetry={onNext} t={apiT} />}
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onReset}>{t('import.select.reselect')}</Button>
        <Button variant="primary" onClick={onNext}>
          {t('import.consult.next')}
        </Button>
      </div>
    </div>
  )
}

/** 预览步第 2 页：选择要导入的内容（分区 → 最小单元）+ 预览摘要徽章。 */
export function DecryptArchiveStep(props: {
  password: string
  onPasswordChange: (next: string) => void
  unlockError: string | null
  unlocking: boolean
  onUnlock: () => void
  onReset: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const { password, onPasswordChange, unlockError, unlocking, onUnlock, onReset, apiT, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.decryptArchive.title')} info={<InfoHint text={t('import.decryptArchive.hint')} label={t('common.infoHint')} />} />
      <input
        type="password"
        className={css.input}
        autoComplete="off"
        placeholder={t('import.decryptArchive.passwordPlaceholder')}
        value={password}
        onChange={(e: ChangeEvent<HTMLInputElement>) => { onPasswordChange(e.target.value) }}
      />
      {unlockError !== null && <ErrorBanner error={unlockError} t={apiT} />}
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onReset}>{t('import.select.reselect')}</Button>
        <Button
          variant="primary"
          disabled={password === '' || unlocking}
          onClick={onUnlock}
        >
          {unlocking ? <Spinner label={t('import.decryptArchive.unlocking')} /> : t('import.decryptArchive.unlock')}
        </Button>
      </div>
    </div>
  )
}

/** 冲突解决（phase=conflicts）。 */
export function ConflictsStage(props: {
  collector: ConflictCollector
  onChanged: () => void
  onBack: () => void
  onNext: () => void
  t: TranslateNS<'config-manager'>
}) {
  const { collector, onChanged, onBack, onNext, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.conflicts.title')} info={<InfoHint text={t('import.conflicts.hint')} label={t('common.infoHint')} />} />
      <ConflictList
        collector={collector}
        t={t}
        onChanged={onChanged}
      />
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>
        <Button variant="primary" disabled={collector.hasUnresolved} onClick={onNext}>
          {t('common.next')}
        </Button>
      </div>
    </div>
  )
}

/** 路径映射（phase=path-mapping）。 */
export function PathMappingStage(props: {
  issues: ImportAnalysis['pathIssues']
  mappings: PathMapping[]
  onMappingsChange: (next: PathMapping[]) => void
  onBack: () => void
  onNext: () => void
  t: TranslateNS<'config-manager'>
}) {
  const { issues, mappings, onMappingsChange, onBack, onNext, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.paths.title')} info={<InfoHint text={t('import.paths.hint')} label={t('common.infoHint')} />} />
      <PathMappingForm issues={issues} initial={mappings} t={t} onChange={onMappingsChange} />
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>
        <Button variant="primary" onClick={onNext}>{t('common.next')}</Button>
      </div>
    </div>
  )
}

/** 凭据补录（phase=secrets）。 */
export function SecretsStage(props: {
  missing: { ref: string; required: boolean }[]
  value: Record<string, string>
  onValueChange: (next: Record<string, string>) => void
  onBack: () => void
  onNext: () => void
  t: TranslateNS<'config-manager'>
}) {
  const { missing, value, onValueChange, onBack, onNext, t } = props
  return (
    <div className={css.viewBody}>
      <SectionTitle title={t('import.secrets.title')} info={<InfoHint text={t('import.secrets.hint')} label={t('common.infoHint')} />} />
      <SecretsForm
        missing={missing}
        value={value}
        t={t}
        onChange={onValueChange}
      />
      <div className={css.actionRow}>
        <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>
        <Button variant="primary" onClick={onNext}>{t('common.next')}</Button>
      </div>
    </div>
  )
}

/**
 * 会话格式处置三选一（T1）—— 导入预览页与最终确认页**共用同一个组件**。
 *
 * 为什么必须有它：DSH 读到「非本 build 的会话格式版本」会**静默跳过**（不报错、不在工作区
 * 列表里），而本插件是逐字节搬运，所以用户必须能在导入前显式决定：中止（缺省，零写入）/
 * 跳过这些会话（其余照常导入）/ 仅提示照常导入。三选一 + 结果回显缺一不可。
 *
 * 判据全部来自 `src/ui/session-format-disposition.ts`（与宿主 409 判定同一个纯函数）：
 * 组件只做渲染，不自己判断「读不了」。
 */
export function SessionFormatDispositionField(props: {
  disposition: SessionFormatDisposition
  onDispositionChange: (next: SessionFormatDisposition) => void
  /** 单元级事实（本机版本未知 / 没有读不了的会话 → null：整个控件不渲染） */
  facts: SessionFormatFacts | null
  /** 宿主已按 abort 拒绝过本次计划生成（渲染阻断态说明） */
  blocked: boolean
  t: TranslateNS<'config-manager'>
}) {
  const { disposition, onDispositionChange, facts, blocked, t } = props
  if (facts === null) return null
  const newest = sessionFormatNewest(facts) ?? facts.target
  const options: { value: SessionFormatDisposition; label: string; hint: string }[] = [
    { value: 'abort', label: t('import.sessionFormat.option.abort'), hint: t('import.sessionFormat.hint.abort') },
    { value: 'skip', label: t('import.sessionFormat.option.skip'), hint: t('import.sessionFormat.hint.skip') },
    { value: 'guide', label: t('import.sessionFormat.option.guide'), hint: t('import.sessionFormat.hint.guide') },
  ]
  return (
    <Card className={css.optionsCard}>
      <div className={css.groupLabel}>{t('import.sessionFormat.title')}</div>
      {blocked && <Banner kind="error">{t('import.sessionFormat.blocked')}</Banner>}
      <Banner kind="warn">
        {t('import.sessionFormat.summary', {
          count: String(facts.unreadable.length),
          newer: String(newest),
          target: String(facts.target),
        })}
      </Banner>
      {facts.unsampled !== undefined && facts.unsampled > 0 && (
        <div className={css.hint}>
          {t('import.sessionFormat.sampled', { checked: String(facts.inspected ?? 0), skipped: String(facts.unsampled) })}
        </div>
      )}
      <div className={css.conflictOptions}>
        {options.map((opt) => (
          <label key={opt.value} className={css.radioLabel}>
            <input
              type="radio"
              name="session-format-disposition"
              checked={disposition === opt.value}
              onChange={() => { onDispositionChange(opt.value) }}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
      <div className={css.hint}>{options.find((o) => o.value === disposition)?.hint ?? ''}</div>
      {/* 升级/重导出的指引 + 可复制命令：三种处置下都摆出来（guide 不阻塞，但也需要它） */}
      <div className={css.groupLabel}>{t('import.sessionFormat.guide.title')}</div>
      <ul className={css.reportList}>
        <li>{t('import.sessionFormat.guide.upgrade', { newer: String(newest), target: String(facts.target) })}</li>
        <li>{t('import.sessionFormat.guide.doctor')}</li>
      </ul>
      <div className={css.actionRow}>
        <code className={css.hint}>{SESSION_FORMAT_DOCTOR_COMMAND}</code>
        <CopyButton text={SESSION_FORMAT_DOCTOR_COMMAND} label={t('import.sessionFormat.guide.copy')} t={t} />
      </div>
    </Card>
  )
}

/** 确认（最后一道闸门，phase=confirm）。 */
export function ConfirmStage(props: {
  rollbackOnError: boolean
  onRollbackChange: (next: boolean) => void
  isEncrypted: boolean
  decryptRefs: string[]
  summary: { sections: number; units: number }
  excludedCount: number
  running: boolean
  nothingSelected: boolean
  error: string | null
  /** T1：会话格式处置（当前选择 / setter / 事实 / 是否被宿主按 abort 拦过） */
  sessionFormatDisposition: SessionFormatDisposition
  onSessionFormatDispositionChange: (next: SessionFormatDisposition) => void
  sessionFormatFacts: SessionFormatFacts | null
  sessionFormatBlocked: boolean
  /** skip 处置下**实际未导入**的会话条数（与选择模型同源；>0 时逐条回显） */
  sessionFormatSkipped: number
  onBack: () => void
  onExecute: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const {
    rollbackOnError, onRollbackChange, isEncrypted, decryptRefs, summary, excludedCount,
    running, nothingSelected, error,
    sessionFormatDisposition, onSessionFormatDispositionChange, sessionFormatFacts, sessionFormatBlocked,
    sessionFormatSkipped,
    onBack, onExecute, apiT, t,
  } = props
  return (
    <div className={css.viewBody}>
      <Card className={css.optionsCard}>
        {/* UI-13：提示语必须随「失败时整体回滚」勾选状态切换 ——
            该复选框可取消，取消后仍承诺「失败时整体回滚」是自相矛盾的文案 */}
        <Banner kind="info">
          {rollbackOnError ? t('import.confirm.warning') : t('import.confirm.warningNoRollback')}
        </Banner>
        {isEncrypted && decryptRefs.length > 0 && (
          <Banner kind="ok">{t('import.confirm.encrypted', { count: String(decryptRefs.length) })}</Banner>
        )}
        {/* UI-14：将导入的分区/条目合计（与预览步选择器同源）+ 被用户取消的项数 */}
        <div className={css.hint}>
          {t('picker.summaryImport', {
            sections: String(summary.sections),
            units: String(summary.units),
          })}
        </div>
        {excludedCount > 0 && (
          <div className={css.hint}>{t('import.excludedByUser', { count: String(excludedCount) })}</div>
        )}
        {/* T1：确认页是最后一道闸门 —— 处置选择在这里仍可改（改完点「确认导入」时会用新处置
            重新生成计划，abort 仍然在计划阶段被拦住）。 */}
        <SessionFormatDispositionField
          disposition={sessionFormatDisposition}
          onDispositionChange={onSessionFormatDispositionChange}
          facts={sessionFormatFacts}
          blocked={sessionFormatBlocked}
          t={t}
        />
        {sessionFormatSkipped > 0 && (
          <Banner kind="info">{t('import.sessionFormat.skipped', { count: String(sessionFormatSkipped) })}</Banner>
        )}
        <Checkbox
          checked={rollbackOnError}
          onChange={onRollbackChange}
          label={t('import.rollbackOnError')}
        />
        <div className={css.actionRow}>
          <Button variant="ghost" onClick={onBack}>{t('common.back')}</Button>
          {/* m3-lock：进行中禁用「确认导入」，防止重复启动；
              空选择同样禁用（UI-05：不让「什么都没勾」走完最后一道闸门） */}
          <Button variant="primary" disabled={running || nothingSelected} onClick={onExecute}>
            {t('import.confirm.execute')}
          </Button>
        </div>
      </Card>
      {error !== null && <ErrorBanner error={error} onRetry={onExecute} t={apiT} />}
    </div>
  )
}

