/**
 * 导入执行日志面板（t50 物理拆分：从 client/import/ImportWizardView.tsx 抽出）。
 *
 * 原先它必须在主文件里，只因它的脱敏渲染点登记在
 * src/client/common/plan-text-redaction.test.ts 的 `import-log-*` 两条（该登记表才是安全网；
 * 拆到这里后登记表同步指向本文件）。主文件因此保持「只装配」的薄壳。
 *
 * 数据流：宿主 RunRegistry 的原始行（经 /progress 轮询回传）→ ui/import-log.ts 聚合成
 * 「同 itemId 的项记录 + 计数」→ 本组件渲染（项状态行按级别着色、命令/说明缩进挂在其下）。
 * 交互：贴底才自动跟随（上滚显示「↓ 新输出」）、「只看问题」筛选。展示文本一律先过 redact()。
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildImportLogModel, filterImportLogEntries, importLogLevelIcon,
  type ImportLogDetail, type ImportLogEntry,
} from '../../ui/import-log.ts'
import { redact } from '../../security/redaction.ts'
import type { TranslateNS } from '../client-types.ts'
import { ChevronDownIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'

/** 项状态行文本：状态字形 + itemId（`✓ plugin:@scope/name`）。 */
function logEntryTitle(entry: ImportLogEntry): string {
  return importLogLevelIcon(entry.level) + ' ' + entry.id
}

/** 明细行（真实子进程命令行 / 该项目的说明文本）；渲染前过 redact（宿主 /progress 回传文本）。 */
function LogDetailLine({ detail }: { detail: ImportLogDetail }) {
  return <div className={css.logDetail} data-kind={detail.kind}>{redact(detail.text)}</div>
}

function ImportLogPanelBase({ lines, t }: { lines: string[]; t: TranslateNS<'config-manager'> }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 是否贴底（用户上滚置 false；滚动回底部自动恢复） */
  const stickRef = useRef(true)
  /** 用户上滚后是否有新行到达（显示「↓ 新输出」；点击跳到底部清除） */
  const [hasNewOutput, setHasNewOutput] = useState(false)
  /** 「只看问题」（警告/失败/进行中，见 ui/import-log.ts 的 filterImportLogEntries） */
  const [onlyProblems, setOnlyProblems] = useState(false)
  /**
   * 上次渲染的数组引用（新输出 = 引用变化）。依赖 appendLog 的**不可变写入**：
   * 每次追加都生成新数组（run-registry.ts）——行数封顶后长度恒定，但引用必变，
   * 以引用判断才能感知截断后的新行（长度比较在 500 行封顶时失效）。
   */
  const prevLinesRef = useRef(lines)
  /** 原始行 → 可读记录：同一 itemId 的开始/命令/收尾行合并（详见 ui/import-log.ts） */
  const model = useMemo(() => buildImportLogModel(lines), [lines])

  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const hasNew = lines !== prevLinesRef.current
    prevLinesRef.current = lines
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight
      setHasNewOutput(false)
    } else if (hasNew) {
      // 用户已上滚且有新行到达：提示而非强制拉回（§24 自动滚动纪律）
      setHasNewOutput(true)
    }
  }, [lines])

  /** 滚动中更新贴底状态（上滚 → 停止跟随；滚回底部 → 恢复跟随并清除提示） */
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickRef.current = nearBottom
    if (nearBottom) setHasNewOutput(false)
  }

  /** 「↓ 新输出」：跳到底部 + 恢复跟随 */
  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    stickRef.current = true
    setHasNewOutput(false)
  }

  const entries = filterImportLogEntries(model, onlyProblems)
  const showLoose = !onlyProblems && model.loose.length > 0
  const { counts } = model

  return (
    <div className={css.logPanel}>
      <div className={css.logHeader}>
        {t('import.log.title')}
        <span className={css.logCounts}>
          {t('import.log.counts', {
            ok: String(counts.ok),
            skip: String(counts.skip),
            warn: String(counts.warn),
            fail: String(counts.fail),
          })}
        </span>
        {model.problems > 0 && (
          <button
            type="button"
            className={css.logFilterButton}
            data-active={onlyProblems ? '' : undefined}
            onClick={() => { setOnlyProblems((v) => !v) }}
          >
            {onlyProblems ? t('import.log.filterAll') : t('import.log.filterProblems')}
          </button>
        )}
        {hasNewOutput && (
          <button type="button" className={css.logJumpButton} onClick={jumpToBottom}>
            <ChevronDownIcon size={13} /> {t('import.log.newOutput')}
          </button>
        )}
      </div>
      <div className={css.logScroll} ref={scrollRef} onScroll={onScroll}>
        {lines.length === 0 || (entries.length === 0 && !showLoose)
          ? <div className={css.logEmpty}>{lines.length === 0 ? t('import.log.empty') : t('import.log.problemsEmpty')}</div>
          : (
            <>
              {showLoose && model.loose.map((d, i) => <LogDetailLine key={'loose:' + i} detail={d} />)}
              {entries.map((entry) => (
                <div key={entry.key} className={css.logEntry}>
                  <div className={css.logLine} data-level={entry.level}>{redact(logEntryTitle(entry))}</div>
                  {entry.details.map((d, i) => <LogDetailLine key={i} detail={d} />)}
                </div>
              ))}
            </>
          )}
      </div>
    </div>
  )
}

/** memo：lines 数组经 appendLog **不可变追加**（每次 append 换新引用，run-registry.ts）——
 *  自定义比较以「数组引用 + t 引用」为准：引用未变 = 无新输出，跳过整个列表重渲染；
 *  引用已变 = 有新行（含 500 行封顶后长度不变的情况），必须重渲染。 */
export const ImportLogPanel = memo(ImportLogPanelBase, (prev, next) =>
  prev.lines === next.lines && prev.t === next.t,
)
