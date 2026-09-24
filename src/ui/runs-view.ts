/**
 * 运行中心（Run Center）纯渲染模型：把宿主 /runs 的 RunState 列表变成「一张卡片 + 一次决策」。
 *
 * 为什么单独一层：卡片要区分「在跑 / 在等人 / 已结束」，决策框要算「已应用多少 / 剩下多少」
 * 并给出默认选项 —— 这些判据都必须可单测（UI 分层铁律：逻辑在 src/ui，React 壳只装配）。
 *
 * 三条设计约束（读码得出，不是偏好）：
 *  1. **可终止 ≠ 所有 run**：只有导入引擎实现了「计划项边界协作式取消」（/runs/cancel）；
 *     其余 run 类型（同步/恢复/备份/自动同步）没有安全点，UI 必须如实禁用而不是给个假按钮。
 *  2. **待决策态优先于一切**：pendingDecision 非空时 run 并没有卡住，它在等人 —— 卡片必须显性提示，
 *     否则用户会以为任务死了（这正是「终止需弹窗」的功能入口）。
 *  3. **默认选项跟随既有偏好**：用户此前勾过「失败不回滚」（rollbackOnError=false）时，决策框默认落在
 *     「保留已应用项」；没勾过则默认「回滚」。不推翻用户已有的心智，也不替他做更危险的选择。
 */
import type { RunKind, RunState } from '../core/run-registry.ts'
import { buildImportLogModel } from './import-log.ts'
import { isSkippablePluginInstall } from './import-wizard.ts'
import type { ImportLogCounts } from './import-log.ts'

/** 终止决策（与宿主 /runs/cancel/decision 的取值一一对应）。 */
export type CancelDecision = 'rollback' | 'keep'

/** 一张运行卡片的纯数据模型（文案一律给 key，由壳层翻译）。 */
export interface RunCardModel {
  runId: string
  kind: RunKind
  /** 卡片标题 key（`runs.kind.<kind>`）。 */
  kindLabelKey: string
  status: 'running' | 'done' | 'failed'
  /** 状态徽章 key（`runs.status.<status>`；待决策时另由 awaitingDecision 覆盖显示）。 */
  statusLabelKey: string
  /** 已到安全点、等用户选「回滚 / 保留」。 */
  awaitingDecision: boolean
  /** 可手动终止（只有导入支持计划项边界协作式取消；已请求过就不再显示按钮）。 */
  canCancel: boolean
  /**
   * 已请求终止、正等当前计划项结束（null = 未请求）。
   * `stuck` = 等待超过阈值 → 界面必须从「请稍候」升级为「给出路」。
   */
  cancelWait: { minutes: number; stuck: boolean } | null
  /** 可「跳过当前插件」（仅导入的插件安装阶段有意义）。 */
  canSkip: boolean
  /** 进度（item/itemTotal 优先；导出用 section 计数）。 */
  progress: {
    labelKey: string
    section: string | null
    item: number | null
    itemTotal: number | null
    detail: string | null
    percent: number | null
  }
  /** 日志聚合计数（无日志时为 null）。 */
  counts: ImportLogCounts | null
  /** 需要用户关注的项数（警告 + 失败）。 */
  problems: number
  /** 最近日志行（已截断；供折叠查看，不含敏感内容：宿主侧落账前已 redact）。 */
  logTail: string[]
  updatedAt: number
  /**
   * 「最近一次更新」的相对时间（复用 overview.time.* 字典）。
   * 为什么需要：没有它，「进行中」和「三小时前就结束的僵尸卡片」在界面上长得一模一样，
   * 用户只能得出「一直在加载」的结论（真机报告）。
   */
  time: { key: string; params?: { n: string } }
}

/** 日志尾部保留行数（卡片里只给「最近发生了什么」，完整日志在所属页面）。 */
export const RUN_CARD_LOG_TAIL = 8

/**
 * 终止请求等多久算「可能卡住」（2 分钟）。
 * 为什么要有阈值：协作式取消只能等到**项边界**，而插件安装可以跑几十分钟。
 * 2 分钟内大概率是在装插件（正常），超过就该把出路摆到用户面前（跳过当前项 / 重启），
 * 否则用户只能一遍遍点「终止…」——而那个按钮此刻已经没有任何作用了。
 */
export const CANCEL_STUCK_AFTER_MS = 2 * 60 * 1000

/**
 * 相对时间（纯函数，now 显式传入 → 可单测）：刚刚 / N 分钟前 / N 小时前 / N 天前。
 * 键复用 config-manager 字典里既有的 overview.time.*（同字典，不新造文案）。
 */
export function relativeTimeLabel(updatedAt: number, now: number): { key: string; params?: { n: string } } {
  const diffMs = Math.max(0, now - updatedAt)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return { key: 'overview.time.now' }
  if (minutes < 60) return { key: 'overview.time.min', params: { n: String(minutes) } }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'overview.time.hour', params: { n: String(hours) } }
  return { key: 'overview.time.day', params: { n: String(Math.floor(hours / 24)) } }
}

function percentOf(item: number | null, itemTotal: number | null): number | null {
  if (item === null || itemTotal === null || itemTotal <= 0) return null
  return Math.min(100, Math.max(0, Math.round((item / itemTotal) * 100)))
}

/** RunState[] → 卡片模型（按 updatedAt 倒序；终态与进行中同列，由 status 区分）。 */
export function runCards(
  runs: readonly RunState[],
  opts: { logTail?: number; now?: number } = {},
): RunCardModel[] {
  const tail = opts.logTail ?? RUN_CARD_LOG_TAIL
  const now = opts.now ?? Date.now()
  return [...runs]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((run) => {
      const log = run.log ?? []
      const model = log.length > 0 ? buildImportLogModel(log) : null
      const running = run.status === 'running'
      const awaitingDecision = running && run.pendingDecision === 'cancel'
      // 终止请求已到达、但还没走到安全点：把「等了多久」算出来给界面用（见 CANCEL_STUCK_AFTER_MS）
      const requestedAt = typeof run.cancelRequestedAt === 'number' ? run.cancelRequestedAt : null
      const waitedMs = requestedAt === null ? 0 : Math.max(0, now - requestedAt)
      const cancelWait = requestedAt !== null && running && !awaitingDecision
        ? { minutes: Math.floor(waitedMs / 60_000), stuck: waitedMs >= CANCEL_STUCK_AFTER_MS }
        : null
      return {
        runId: run.runId,
        kind: run.kind,
        kindLabelKey: `runs.kind.${run.kind}`,
        status: run.status,
        statusLabelKey: `runs.status.${run.status}`,
        awaitingDecision,
        // 只有导入实现了协作式取消；其余类型给禁用态（不给假按钮）。
        // 已请求过终止就不再给按钮：再点也不会有新效果（run 级信号是幂等的），
        // 留着一个亮着的主按钮只会让用户以为「多点几次就能好」。
        canCancel: running && run.kind === 'import' && !awaitingDecision && cancelWait === null,
        cancelWait,
        // 「跳过当前插件」复用向导的**同一判据**（isSkippablePluginInstall：detail 带 plugin: 前缀），
        // 绝不在这里另写一份「是不是插件安装项」的判断 —— 两份判据漂移会让两个页面对同一个 run
        // 给出不同的可操作性。skipRequested 由运行中心自己的在途状态抑制（见 RunsCenter）。
        canSkip: running && run.kind === 'import' && run.pendingDecision !== 'cancel'
          && isSkippablePluginInstall(run.detail ?? undefined, running, false),
        progress: {
          labelKey: `runs.progress.${running ? 'running' : run.status === 'done' ? 'done' : 'failed'}`,
          section: run.section,
          item: run.item,
          itemTotal: run.itemTotal,
          detail: run.detail,
          percent: percentOf(run.item, run.itemTotal),
        },
        counts: model === null ? null : model.counts,
        problems: model === null ? 0 : model.problems,
        logTail: log.slice(-Math.max(0, tail)),
        updatedAt: run.updatedAt,
        time: relativeTimeLabel(run.updatedAt, now),
      }
    })
}

/** 状态栏 / 抽屉徽章用的计数。 */
export function runSummary(runs: readonly RunState[]): { running: number; awaiting: number; total: number } {
  let running = 0
  let awaiting = 0
  for (const run of runs) {
    if (run.status !== 'running') continue
    running += 1
    if (run.pendingDecision === 'cancel') awaiting += 1
  }
  return { running, awaiting, total: runs.length }
}

/** 终止决策框模型。 */
export interface CancelDialogModel {
  runId: string
  kindLabelKey: string
  /** 已经应用的计划项数（引擎回传的 executed 长度不可得，故用进度计数近似并如实标注）。 */
  appliedCount: number | null
  /** 计划项总数（null = 宿主未上报）。 */
  totalCount: number | null
  /** 未执行项数（total - applied；无法计算时 null）。 */
  pendingCount: number | null
  defaultDecision: CancelDecision
  options: { id: CancelDecision; labelKey: string; descKey: string }[]
}

/**
 * 终止决策框模型。默认选项跟随用户既有的 rollbackOnError 偏好：
 * 勾过「失败不回滚」→ 默认保留（与他的心智一致）；否则默认回滚（安全侧）。
 */
export function cancelDialogModel(
  run: Pick<RunState, 'runId' | 'kind' | 'item' | 'itemTotal'>,
  opts: { defaultRollbackOnError: boolean },
): CancelDialogModel {
  const applied = run.item
  const total = run.itemTotal
  return {
    runId: run.runId,
    kindLabelKey: `runs.kind.${run.kind}`,
    appliedCount: applied,
    totalCount: total,
    pendingCount: applied !== null && total !== null ? Math.max(0, total - applied) : null,
    defaultDecision: opts.defaultRollbackOnError ? 'rollback' : 'keep',
    options: [
      { id: 'rollback', labelKey: 'runs.cancel.rollback', descKey: 'runs.cancel.rollbackDesc' },
      { id: 'keep', labelKey: 'runs.cancel.keep', descKey: 'runs.cancel.keepDesc' },
    ],
  }
}

/** 「已应用/未执行」的用户可读摘要参数（null → 壳层显示「未知」而不是编个数字）。 */
export function cancelCostParams(model: CancelDialogModel): { applied: string; pending: string } {
  return {
    applied: model.appliedCount === null ? '' : String(model.appliedCount),
    pending: model.pendingCount === null ? '' : String(model.pendingCount),
  }
}
