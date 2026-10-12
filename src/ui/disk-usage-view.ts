/**
 * 磁盘占用视图模型（框架无关纯函数层，node 可测）。
 *
 * 输入 = 宿主 `GET /disk-usage` 的报告（`src/core/disk-usage.ts` 的 DiskUsageReport），
 * 输出 = 界面要渲染的行/汇总（含**已翻译**的标签与说明）——组件只负责摆放，判定都在这里。
 *
 * 三条判定规则（都有单测钉住）：
 *  ① 读不到的子区**绝不显示 0 字节**，而是标 `unreadable`（未统计），否则用户会以为盘是空的；
 *  ② 只有 `policy === 'regenerable'` 的子区进「可立即清理」清单，且**不显示保留期**
 *     （它们本来就是随时可清，给一个「7 天后自动清理」的说明会误导）；
 *  ③ 定时备份（豁免前缀）不计入导出产物的「可回收」数字 —— 与宿主回收口径逐条一致；
 *  ④ 遗留数据（core 的 `report.legacy`：插件已不再读取的旧目录）**单列**，既不计入合计、也不进任何清理候选；
 *     标签走字典、相对路径只作「在哪儿」展示（**绝不**把 id / 路径当文案渲染）。
 */
import type { DiskUsageArea, DiskUsageReport, DiskUsageScanArea } from '../core/disk-usage.ts'
import type { UiT } from './i18n.ts'

/**
 * 子区 → 字典键（标签 / 说明在字典里；本模块只挑键，不内嵌文案）。
 *
 * 键域 = `DiskUsageScanArea`（**含**只报告、不清理的附加子区，如 `rollback-points`）：
 * core 的 `DiskUsageArea` 刻意把附加子区排除在外 —— 它描述的是「**展示层已登记文案**的清单」，
 * 而登记文案正是本文件（`AREA_KEYS` 是穷尽 Record，少一个 id 就编译不过）。
 * 因此这里用更宽的 `DiskUsageScanArea`：新增附加子区时，core 加统计、本文件加文案，两边都必须动。
 */
const AREA_KEYS: Record<DiskUsageScanArea, { label: UiKey; desc: UiKey }> = {
  exports: { label: 'diskUsage.area.exports', desc: 'diskUsage.area.exportsDesc' },
  snapshots: { label: 'diskUsage.area.snapshots', desc: 'diskUsage.area.snapshotsDesc' },
  sync: { label: 'diskUsage.area.sync', desc: 'diskUsage.area.syncDesc' },
  marketCache: { label: 'diskUsage.area.marketCache', desc: 'diskUsage.area.marketCacheDesc' },
  marketWork: { label: 'diskUsage.area.marketWork', desc: 'diskUsage.area.marketWorkDesc' },
  tmp: { label: 'diskUsage.area.tmp', desc: 'diskUsage.area.tmpDesc' },
  logs: { label: 'diskUsage.area.logs', desc: 'diskUsage.area.logsDesc' },
  bootState: { label: 'diskUsage.area.bootState', desc: 'diskUsage.area.bootStateDesc' },
  migrationHistory: { label: 'diskUsage.area.migrationHistory', desc: 'diskUsage.area.migrationHistoryDesc' },
  transactions: { label: 'diskUsage.area.transactions', desc: 'diskUsage.area.transactionsDesc' },
  locks: { label: 'diskUsage.area.locks', desc: 'diskUsage.area.locksDesc' },
  vault: { label: 'diskUsage.area.vault', desc: 'diskUsage.area.vaultDesc' },
  // 只报告、**不提供清理**的附加子区（policy 恒 protected）：回滚点库
  'rollback-points': { label: 'diskUsage.area.rollbackPoints', desc: 'diskUsage.area.rollbackPointsDesc' },
}

/** 字典键（`UiTextKey` 的窄别名，避免此处 import 整个 i18n 类型后与组件耦合） */
type UiKey = Parameters<UiT>[0]

/** 展示所需的最小注入面 */
export interface DiskUsageViewDeps {
  t: UiT
  /** 字节格式化（复用 `src/ui/report.ts` 的 formatBytes，保持全仓同口径） */
  formatBytes: (n: number) => string
}

/** 子区展示行（id 域含附加子区：`rollback-points` 等只报告区也要成行） */
export interface DiskUsageRow {
  id: DiskUsageScanArea
  /** 子区名（已翻译） */
  label: string
  /** 一句话说明（已翻译） */
  desc: string
  /** 体积文本（未统计时为空串） */
  size: string
  /** 文件数文本 */
  files: string
  /** 目录读不到（界面显示「未统计」而不是 0） */
  unreadable: boolean
  policy: 'regenerable' | 'retained' | 'protected'
  /** 保留期文本（仅 retained 有值，形如「7 天」） */
  retention: string
  /** 按保留期已到回收条件的体积文本（仅 retained；无过期项为 null） */
  expired: string | null
  /** 是否属于「可立即清理」区（regenerable） */
  reclaimable: boolean
}

/**
 * 遗留数据展示行（`report.legacy`）。
 *
 * 与 `DiskUsageRow` 分开：遗留目录**不计入**上方子区合计（core 刻意分列），且插件已不再读取它们 ——
 * 界面必须能把「能解释来源的占用」与「遗留占用」分开说，不能让用户以为合计里已经算过。
 */
export interface DiskUsageLegacyRow {
  /** core 的稳定 id（`LEGACY_DATA_DIRS`）——**只作 React key / 去重**，绝不直接当文案渲染 */
  id: string
  /** 相对 dataDir 的路径（如 `checkpoints`）：这是「在哪儿」，不是机器码文案 */
  relPath: string
  /** 已翻译的标签（走字典，不渲染 id） */
  label: string
  /** 体积文本（未统计时为空串） */
  size: string
  /** 文件数文本（未统计时为空串） */
  files: string
  /** 读不到/不存在/被非目录占住 → 界面显示「未统计」而不是 0 字节 */
  unreadable: boolean
  /** 恒为 `protected`：只报告，绝不提供自动清理 */
  policy: 'protected'
}
/** 可立即清理的动作（供界面按 _可用性_ 决定按钮 disabled —— 组件不再自行判断） */
export interface DiskUsageCleanAction {
  id: 'tmp-market' | 'expired-exports'
  label: string
  /** 该动作当前能释放多少（0 → 界面禁用它） */
  bytes: number
  /** 体积文本 */
  size: string
  /** 说明（已翻译；含保留期口径） */
  desc: string
}

/** 完整视图模型 */
export interface DiskUsageViewModel {
  summary: {
    total: string
    files: string
    dataDir: string
    /** 有子区读不到（界面顶部给一条「部分未统计」提示） */
    anyUnreadable: boolean
  }
  rows: DiskUsageRow[]
  /**
   * 遗留数据行（插件已不再读取、也不代删；**不计入** summary.total）。
   * 恒为数组（无遗留目录时为空），组件不需要判空。
   */
  legacy: DiskUsageLegacyRow[]
  clean: {
    /** 可立即清理区当前合计 */
    reclaimable: string
    /** 到回收期的导出产物合计 */
    expired: string
    actions: DiskUsageCleanAction[]
  }
}

/** 保留期 → 人类可读（7 天 / 24 小时；非整档按小时/分钟回落） */
export function formatRetention(ms: number, t: UiT): string {
  if (!Number.isFinite(ms) || ms <= 0) return t('diskUsage.retention.none')
  const day = 24 * 60 * 60 * 1000
  const hour = 60 * 60 * 1000
  if (ms % day === 0) return t('diskUsage.retention.days', { count: String(ms / day) })
  if (ms % hour === 0) return t('diskUsage.retention.hours', { count: String(ms / hour) })
  return t('diskUsage.retention.minutes', { count: String(Math.max(1, Math.round(ms / 60000))) })
}

/**
 * 报告 → 视图模型。
 * `report` 为 null 时返回 null（界面显示加载态；调用方不必自己判空）。
 */
export function diskUsageViewModel(report: DiskUsageReport | null, deps: DiskUsageViewDeps): DiskUsageViewModel | null {
  if (report === null) return null
  const { t, formatBytes } = deps

  const rows: DiskUsageRow[] = []
  let anyUnreadable = false
  /**
   * 合计与「可回收」全部**由渲染出来的行现算**（不直接用报告里的聚合字段）。
   * 为什么：界面上的按钮数字必须与它旁边列出的行逐项对得上；一旦宿主聚合与明细漂移，
   * 用户会按「可释放 600 B」点下去却只释放 0 —— 宁可让两侧都基于同一份明细。
   */
  let totalBytes = 0
  let totalFiles = 0
  let reclaimableBytes = 0
  let expiredBytesTotal = 0
  for (const area of Object.keys(AREA_KEYS) as DiskUsageScanArea[]) {
    const entry = report.areas[area]
    if (entry === undefined) continue
    const keys = AREA_KEYS[area]
    if (entry.unreadable) anyUnreadable = true
    const expiredBytes = entry.expiredBytes ?? 0
    totalBytes += entry.sizeBytes
    totalFiles += entry.fileCount
    // ui-F4：只有 exports 的过期字节属于「回收过期备份文件」动作 —— 宿主 cleanup 的
    // expired-exports 只删 exports/**（cache-cleaner 显式注释「includeRecent 不作用于本区」）；
    // tmp / market 的过期项已由 tmp-market（整块清）覆盖，混进这里会让按钮/确认框数字虚高，
    // 且这些字节在行上（只有 retained 区渲染 expired）根本没有对应文本。
    if (area === 'exports') expiredBytesTotal += expiredBytes
    if (entry.policy === 'regenerable') reclaimableBytes += entry.sizeBytes
    rows.push({
      id: area,
      label: t(keys.label),
      desc: t(keys.desc),
      size: entry.unreadable ? '' : formatBytes(entry.sizeBytes),
      files: entry.unreadable ? '' : t('diskUsage.files', { count: String(entry.fileCount) }),
      unreadable: entry.unreadable,
      policy: entry.policy,
      retention: entry.policy === 'retained' && entry.retentionMs !== undefined ? formatRetention(entry.retentionMs, t) : '',
      expired: entry.policy === 'retained' && expiredBytes > 0 ? formatBytes(expiredBytes) : null,
      reclaimable: entry.policy === 'regenerable',
    })
  }

  /**
   * 遗留数据行：core 只报告（`policy` 恒 protected、**不计入**合计），界面如实分列。
   * 标签走字典，**绝不**把 id / relPath 当标签渲染（relPath 只作「在哪儿」的路径展示）。
   */
  const legacyRows: DiskUsageLegacyRow[] = []
  for (const entry of report.legacy ?? []) {
    if (entry.unreadable) anyUnreadable = true
    legacyRows.push({
      id: entry.id,
      relPath: entry.relPath,
      label: t('diskUsage.legacy.label'),
      size: entry.unreadable ? '' : formatBytes(entry.sizeBytes),
      files: entry.unreadable ? '' : t('diskUsage.files', { count: String(entry.fileCount) }),
      unreadable: entry.unreadable,
      policy: 'protected',
    })
  }
  const actions: DiskUsageCleanAction[] = [
    {
      id: 'tmp-market',
      label: t('diskUsage.clean.tmpMarket'),
      bytes: reclaimableBytes,
      size: formatBytes(reclaimableBytes),
      desc: t('diskUsage.clean.tmpMarketDesc'),
    },
    {
      id: 'expired-exports',
      label: t('diskUsage.clean.expiredExports'),
      bytes: expiredBytesTotal,
      size: formatBytes(expiredBytesTotal),
      desc: t('diskUsage.clean.expiredExportsDesc'),
    },
  ]

  return {
    summary: {
      total: formatBytes(totalBytes),
      files: t('diskUsage.files', { count: String(totalFiles) }),
      dataDir: report.dataDir,
      anyUnreadable,
    },
    rows,
    legacy: legacyRows,
    clean: {
      reclaimable: formatBytes(reclaimableBytes),
      expired: formatBytes(expiredBytesTotal),
      actions,
    },
  }
}
/* ------------------------------------------------------------------ 清理回执判定 */

/**
 * 清理回执的呈现分类（e2e-F3 / client 侧）。
 *
 * 为什么需要它：宿主回执只有 `removed` / `freedBytes` / `errors` / `detail` 四个数字/列表，
 * 而 `errors > 0` 有两种完全不同的现场：
 *  ① **真失败** —— 目标区里还有东西（rm 失败/占用），必须报出来；
 *  ② **目标不存在/已空** —— 全新安装时 market/cache、market/work 尚未创建，或清理前就已经没有内容；
 *     这不是失败，用红色「清理失败 N 项」呈现会让用户以为自己弄坏了什么。
 * 判据只在**一份**实现里（本函数）：用回执里带回来的**清理后体检报告**看目标区是否仍有内容。
 * 组件只按 kind 挑 toast —— AGENTS.md §UI 分层铁律 1（逻辑放 src/ui/）。
 */
export type CleanupOutcomeKind = 'nothing' | 'nothing-absent' | 'cleaned' | 'partial' | 'failed'

export interface CleanupOutcome {
  kind: CleanupOutcomeKind
  /** 成功/中性文案（ok toast）；空串 = 不弹 */
  okText: string
  /** 需注意文案（warn/error toast）；空串 = 不弹 */
  warnText: string
  /** warnText 的语义色：'warn' = 部分条目被跳过；'error' = 一件都没清成 */
  warnKind: 'warn' | 'error'
}

export interface CleanupOutcomeInput {
  /** 删除条目数 */
  removed: number
  /** 释放字节数 */
  freedBytes: number
  /** 单项失败数（宿主已把「可选目录不存在」排除在外） */
  errors: number
  /** 清理后重新体检的报告（缺省 = 老宿主/测试没带 → 保守按真失败呈现） */
  report?: DiskUsageReport | null
  /** 本次请求实际覆盖的动作（缺省 = 只清可重建缓存） */
  requested?: readonly string[]
}

/** 请求动作 → 该动作会碰到的子区（与 routes/backup.ts 的分区白名单同源）。 */
const REQUEST_AREAS: Record<string, readonly DiskUsageArea[]> = {
  tmp: ['tmp', 'marketCache', 'marketWork'],
  'expired-exports': ['exports'],
}

/** 目标区清理后是否**仍有内容**（判「真失败」还是「本来就没东西」）。 */
function targetStillHasContent(report: DiskUsageReport | null | undefined, requested: readonly string[]): boolean {
  // 没有「清理后体检报告」就无法证明「本来就没东西」→ **保守**按「还有内容」处理（宁可报失败，不谎报成功）
  if (report === null || report === undefined) return true
  for (const action of requested) {
    for (const area of REQUEST_AREAS[action] ?? []) {
      const entry = report.areas[area]
      if (entry !== undefined && entry.sizeBytes > 0) return true
    }
  }
  return false
}

/**
 * 清理回执 → 呈现分类（纯函数）。
 *
 * - `nothing`：一件都没删、也没有失败 → 「没有可释放的内容」（成功语义）；
 * - `nothing-absent`：有失败计数但目标区**已空** → 归为「没有需要清理的内容（目标目录不存在或已为空）」，
 *   **不报失败**（e2e-F3 的用户现场）；
 * - `cleaned`：全成；
 * - `partial`：删到了一些又失败了若干 → 成功 + 「N 项失败（已跳过）」；
 * - `failed`：一件都没删成、目标区**仍有内容** → 真失败。
 */
export function cleanupOutcome(input: CleanupOutcomeInput, deps: DiskUsageViewDeps): CleanupOutcome {
  const { t, formatBytes } = deps
  const done = t('diskUsage.clean.done', { size: formatBytes(input.freedBytes), count: String(input.removed) })
  const failed = t('diskUsage.clean.failed', { count: String(input.errors) })
  if (input.removed === 0 && input.freedBytes === 0 && input.errors === 0) {
    return { kind: 'nothing', okText: t('diskUsage.clean.nothing'), warnText: '', warnKind: 'warn' }
  }
  if (input.errors === 0) {
    return { kind: 'cleaned', okText: done, warnText: '', warnKind: 'warn' }
  }
  if (input.removed > 0) {
    return { kind: 'partial', okText: done, warnText: failed, warnKind: 'warn' }
  }
  // 一件都没删成：看目标区是否还有内容 —— 没有内容就不是失败
  const stillHas = targetStillHasContent(input.report, input.requested ?? ['tmp'])
  if (!stillHas) {
    return { kind: 'nothing-absent', okText: t('diskUsage.clean.nothingAbsent'), warnText: '', warnKind: 'warn' }
  }
  return { kind: 'failed', okText: '', warnText: failed, warnKind: 'error' }
}

