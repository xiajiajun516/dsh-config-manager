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
import { ErrorBanner, ErrorList } from '../common/ErrorBanner.tsx'
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
      <div className={css.hint}>{t('import.secrets.hint')}</div>
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
}) {
  const { fileInput, selectModel, uploading, error, onCancel, onPickFile, onReset, apiT, t } = props
  return (
    <div className={`${css.viewBody} ${css.sparseFill}`}>
      <SectionTitle title={t('import.select.title')} subtitle={t('import.select.hint')} />
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
      <ProgressBar event={progress} active />
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
      <SectionTitle title={t('import.preview.title')} subtitle={t('import.consult.hint')} />
      {consultLoading && <Spinner label={apiT('consult.loading')} />}
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
      <SectionTitle title={t('import.decryptArchive.title')} subtitle={t('import.decryptArchive.hint')} />
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
      <SectionTitle title={t('import.conflicts.title')} subtitle={t('import.conflicts.hint')} />
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
      <SectionTitle title={t('import.paths.title')} subtitle={t('import.paths.hint')} />
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
      <SectionTitle title={t('import.secrets.title')} />
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
  onBack: () => void
  onExecute: () => void
  apiT: UiT
  t: TranslateNS<'config-manager'>
}) {
  const {
    rollbackOnError, onRollbackChange, isEncrypted, decryptRefs, summary, excludedCount,
    running, nothingSelected, error, onBack, onExecute, apiT, t,
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

