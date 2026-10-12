/**
 * 「会话体检」面板的**展示模型**（T5；框架无关纯函数，node 可测）。
 *
 * 数据来自只读路由 `GET /recovery/sessions`（宿主扫本机会话库 → core 分类器出结论）。
 * 本模块只做三件事，全部可单测：
 *  ① 行 → 可渲染的展示行（严重级徽章语义 / **对话标题** / 版本 / 归属 / 大小 / 时间 / 可复制命令）；
 *  ② 摘要 → 一行可读的计数（**必须能说清「未检查」与「未验证」**）；
 *  ③ 空态 / 截断 / 只读提示的判定 —— 界面据此渲染，不在组件里写业务判断。
 *
 * 「绝不猜」：缺字段一律不显示该列（不填 0、不写「未知」当结论）。
 */
import type { SessionHealthSeverity } from '../core/session-health.ts'
import { SESSION_HEALTH_SEVERITIES } from '../core/session-health.ts'
import { redact } from '../security/redaction.ts'

/** 路由返回的一行（与宿主 session-health 的 SessionHealthRow 同构；此处只取展示所需）。 */
export interface SessionHealthRowView {
  unitId: string
  sessionId: string
  /**
   * 对话标题（宿主从 DSH 会话缓存补；**可能缺省** —— 缓存没覆盖这条会话时就没有）。
   * 界面不得拿目录名伪装成标题，也不得编造：缺省 → 回落显示 sessionId。
   */
  title?: string
  /** 空白会话（从未提问过；宿主下发的事实）—— 界面显示本地化的「新会话」，不用 uuid 冒充标题。 */
  blank?: boolean
  projectKey: string
  severity: SessionHealthSeverity
  issues: { code: string; severity: SessionHealthSeverity; detail?: string }[]
  version?: number
  cwd?: string
  origin?: string
  sizeBytes?: number
  mtimeMs?: number
}

/** 路由响应（`GET /recovery/sessions`）。 */
export interface SessionHealthResponse {
  ok: boolean
  readOnly: boolean
  sessionsDir: string
  sessionsDirExists: boolean
  targetFormatVersion: number | null
  summary: {
    total: number
    bySeverity: Record<SessionHealthSeverity, number>
    structurallyChecked: number
    deepVerified: number
    deepUnverified: number
    untested: number
    unreadableEntries: number
  }
  rows: SessionHealthRowView[]
  /** 被 limit 截断掉的条数 */
  truncated: number
  nextSteps: { commands: { command: string; reason: string }[]; notes: string[] }
  /** T8：本机可回滚的修复（台账；宿主保证**不含任何绝对路径**） */
  repairs?: SessionRepairEntry[]
  /** 台账读不出来时的事实（界面如实提示，不谎报「没有可回滚的修复」） */
  repairsError?: string
}

/** 一次修复的台账记录（宿主回传；只有标识与计数，没有目录）。 */
export interface SessionRepairEntry {
  repairId: string
  unitId: string
  sessionId: string
  projectKey?: string
  logName?: string
  backupName?: string
  /** 修复时刻（epoch ms） */
  at?: number
  droppedRows?: number
  bytesBefore?: number
  bytesAfter?: number
  /** 已回滚时刻（epoch ms；缺省 = 未回滚） */
  rolledBackAt?: number
}

/** 计划里的一步动作（与宿主 SessionRepairAction 同构；界面只渲染）。 */
export interface SessionRepairActionView {
  code: string
  detail: string
  lossy: boolean
  rows: number
}

/**
 * 写后**真 codec 复验结论**的展示视图（src/ui 内部定义的结构化类型）。
 *
 * 为什么不直接 import utils/session-verify.ts 的 SessionVerifyResult：src/ui 会被打进 **client bundle**
 * （浏览器半），而那个模块经 utils/zstd-frame.ts 间接依赖 `node:zlib` —— bundle 里一旦出现对 node: 内建模块的
 * 引用，DSH loader 会报 missed the module table，**整个插件不加载**（本项目实测过）。
 * 所以这里只**逐字段镜像**宿主回传的形状（结构化鸭子类型），判定逻辑落在本模块的纯函数里。
 *
 * 语义（与 utils/session-verify.ts 的 SessionVerifyResult 逐字同源，**不许曲解**）：
 *  · verified && equivalentToReadPath   → 「现役读盘可读」（header 版本 = 本机现役代际）；
 *  · verified && !equivalentToReadPath  → 「迁移链可还原」（pre-v4 日志），**不等于**现役读盘可读；
 *  · !verified                          → 「**未验证**」（本机跑不了真 codec 门），**不等于**已验证。
 */
export interface SessionVerifyView {
  verified: boolean
  /** verified 时解出的事件数 */
  events?: number
  /** !verified 时的机器可读原因（unavailable / invalid-header / decode-failed / finish-failed） */
  reason?: string
  /** !verified 时的补充详情（机器可读码 + 候选标签，**不含路径**） */
  detail?: string
  /** 额外的「已安装 build 语义校验」结论（不参与判定） */
  strong?: boolean
  strongDetail?: string
  /** 是否等价于 DSH 现役读盘路径（未验证时恒 false = 「没有任何可声称的现役等价」） */
  equivalentToReadPath: boolean
}

/** 修复预览 / 应用结果（POST /recovery/sessions/repair）。 */
export interface SessionRepairResult {
  ok: boolean
  /** 机器可读原因（文案由界面映射；未知原因回退通用文案） */
  reason?: string
  unitId: string
  sessionId?: string
  logName?: string
  droppedRows?: number
  bytesBefore?: number
  bytesAfter?: number
  /** 应用时必须回传的指纹（预览给出） */
  expect?: { size: number; mtimeMs: number }
  /** busy 时的最近写入时间（epoch ms） */
  mtimeMs?: number
  repairId?: string
  backupName?: string
  /** 修复发生了但台账没记上（回滚入口不可用；备份文件仍在） */
  ledgerRecorded?: boolean
  /** 计划里的动作清单（预览也回传：界面据此逐条说明「将要做什么」） */
  actions?: SessionRepairActionView[]
  /** 计划含**有损**动作（截断）：应用时必须显式放行 */
  lossy?: boolean
  /** 保留的行数 */
  keptRows?: number
  /**
   * 写后真 codec 复验结论（**应用期才有**）。调用方必须据它区分三态；
   * 缺省 = 没回传复验结论（预览路径）—— **绝不**当成「已验证」。
   */
  verify?: SessionVerifyView
  /**
   * 确定性失败（reason=`verify-failed`）时：自动回滚是否成功。
   * false = 目标当前仍是「修复后字节」（危险态，必须可见）；缺省 = 服务层没回传（不猜）。
   */
  rolledBack?: boolean
}

/** 回滚结果（POST /recovery/sessions/rollback）。 */
export interface SessionRepairRollbackResult {
  ok: boolean
  reason?: string
  repairId: string
  unitId?: string
  sessionId?: string
}

/**
 * 应用内**可修**的问题码（与执行器 planSessionLogRepair 的三类动作同源）：
 *  重放重复行 / 可证明的合成收尾块（零损失）；seq 空洞 / 不可解析行（截断，**有损**，需显式确认）。
 * 其余码（撕裂尾帧自愈、格式超前、缺工作区/缺父对话…）一律不给应用内入口。
 *
 * T4 的工具生命周期码（`missing-message-id` / `empty-tool-call-id` / `dangling-tool-call` /
 * `tool-result-id-mismatch` / `duplicate-tool-call-id`）同样**只报不修**，刻意不进本集合：
 * 修复它们必须真的改写消息/工具行，超出「只读体检」的范围。
 * 界面文案经 src/ui/session-issue-labels.ts 映射成词典键（**绝不裸渲染机器 code**；
 * 未知码回落 sessions.issue.unknown）—— 与 sessionLayoutReasonKey / cloudIssueKey 同一条判据。
 */
export const SESSION_REPAIRABLE_ISSUE_CODES: ReadonlySet<string> = new Set([
  'replay-duplicate-rows',
  'synthetic-closer',
  'seq-gap',
  'unparsable-event',
])

/** 单个问题码是否可应用内修复。 */
export function sessionIssueRepairable(code: string): boolean {
  return SESSION_REPAIRABLE_ISSUE_CODES.has(code)
}

/** 严重级 → 徽章语义（与 Badge 的四态一一对应；DESIGN.md 先想语义再选 kind）。 */
export function sessionSeverityBadgeKind(severity: SessionHealthSeverity): 'info' | 'ok' | 'warn' | 'error' {
  if (severity === 'blocksStartup') return 'error'
  if (severity === 'unloadable') return 'error'
  if (severity === 'nextRequestFails') return 'warn'
  if (severity === 'invisible') return 'warn'
  return 'ok'
}

/** 严重级 → 面板文案键（config-manager-recovery 命名空间）。 */
export const SESSION_SEVERITY_KEYS = {
  blocksStartup: 'sessions.severity.blocksStartup',
  unloadable: 'sessions.severity.unloadable',
  nextRequestFails: 'sessions.severity.nextRequestFails',
  invisible: 'sessions.severity.invisible',
  ok: 'sessions.severity.ok',
} as const

/**
 * 需要处理的四档（不含 ok），顺序 = 由重到轻（直接派生自 core 的 `SESSION_HEALTH_SEVERITIES`，
 * 不在展示层另抄一份顺序）。
 *
 * 用途：摘要里的严重级 chips 与列表排序共用同一份顺序 —— 两处各写一遍必然分叉。
 */
export const SESSION_ATTENTION_SEVERITIES: readonly Exclude<SessionHealthSeverity, 'ok'>[] =
  SESSION_HEALTH_SEVERITIES.filter(
    (severity): severity is Exclude<SessionHealthSeverity, 'ok'> => severity !== 'ok',
  )

/**
 * 严重级 → **短标签**键（摘要 chips 进屏的那一份）。
 *
 * 为什么另有一份短标签：完整句（`SESSION_SEVERITY_KEYS`，如「会让 DSH 起不来」）在 564px
 * 画布上四档并排必然折行成两行同权重灰字（用户 2026-10-12 反馈「UI 太丑」）。
 * 短标签进屏、完整句仍走 `title` —— 事实一个字不少。
 * `satisfies` 让「新增一档而漏配短标签」在 typecheck 阶段就红灯。
 */
export const SESSION_SEVERITY_SHORT_KEYS = {
  blocksStartup: 'sessions.severityShort.blocksStartup',
  unloadable: 'sessions.severityShort.unloadable',
  nextRequestFails: 'sessions.severityShort.nextRequestFails',
  invisible: 'sessions.severityShort.invisible',
} as const satisfies Record<Exclude<SessionHealthSeverity, 'ok'>, string>

/** 四档「需要处理」的**短标签键**联合（`ok` 档没有短标签）。 */
export type SessionSeverityShortKey = (typeof SESSION_SEVERITY_SHORT_KEYS)[Exclude<SessionHealthSeverity, 'ok'>]

/**
 * 进屏的徽章键联合：四档走短标签，`ok` 档回落完整键
 * （它只会出现在「可修但被判 ok」的分叉行里，界面不得给它一个空徽章）。
 */
export type SessionSeverityBadgeKey = SessionSeverityShortKey | (typeof SESSION_SEVERITY_KEYS)['ok']

/**
 * 严重级 → **进屏的短标签键**（`ok` 档回落完整键）。
 *
 * 单一出口：摘要 chips 与列表行徽章都走它 —— 两处各判一次必然分叉（一处显示「阻断启动」、
 * 另一处显示「会让 DSH 起不来」就是同屏术语漂移）。
 */
export function sessionSeverityShortKey(severity: SessionHealthSeverity): SessionSeverityBadgeKey {
  return severity === 'ok' ? SESSION_SEVERITY_KEYS.ok : SESSION_SEVERITY_SHORT_KEYS[severity]
}

/** 摘要里的一个严重级 chip（组件只渲染这些字段）。 */
export interface SessionSeverityChipView {
  severity: Exclude<SessionHealthSeverity, 'ok'>
  /** 短标签键（进屏） */
  shortKey: (typeof SESSION_SEVERITY_SHORT_KEYS)[Exclude<SessionHealthSeverity, 'ok'>]
  /** 完整句键（title）—— 与 SESSION_SEVERITY_KEYS 同源，绝不新写一句 */
  fullKey: (typeof SESSION_SEVERITY_KEYS)[Exclude<SessionHealthSeverity, 'ok'>]
  count: number
  badgeKind: 'warn' | 'error'
}

/**
 * 摘要 → 严重级 chips（只保留 count > 0 的档）。
 *
 * 「0 条」的档不渲染：0 值 chip 会被读成「有这一类但不多」，而摘要里真正要回答的是
 * 「哪几档、各多少」。总数另有 tiles 承载，不缺这一条。
 */
export function sessionSeverityChips(summary: SessionHealthSummaryView | null): SessionSeverityChipView[] {
  if (summary === null) return []
  return SESSION_ATTENTION_SEVERITIES
    .filter((severity) => summary.bySeverity[severity] > 0)
    .map((severity) => ({
      severity,
      shortKey: SESSION_SEVERITY_SHORT_KEYS[severity],
      fullKey: SESSION_SEVERITY_KEYS[severity],
      count: summary.bySeverity[severity],
      badgeKind: sessionSeverityBadgeKind(severity) === 'error' ? 'error' : 'warn',
    }))
}

/** 一行的问题 chip 视图。 */
export interface SessionIssueChipsView {
  /** 进屏的问题码（最多 limit 条，顺序 = 由重到轻） */
  codes: string[]
  /** 被折叠的条数；0 = 全部在屏上（>0 时界面**必须**显式给出，绝不静默少显示） */
  hidden: number
}

/** 缺省进屏的问题 chip 条数：564px 画布下超过 2 条就折行、把行卡拉成三行。 */
export const SESSION_ISSUE_CHIP_LIMIT = 2

/**
 * 问题码 → chip 视图（截断 + 如实计数）。
 *
 * 为什么截断：一行可能有 4~6 条码，全量进屏会让行卡高度随问题数变化、列表节奏被打散；
 * 折叠的条数由 `hidden` 如实回传，界面渲染「还有 N 条」并把全文放进 title。
 */
export function sessionIssueChips(codes: readonly string[], limit: number = SESSION_ISSUE_CHIP_LIMIT): SessionIssueChipsView {
  const size = Number.isInteger(limit) && limit >= 0 ? limit : SESSION_ISSUE_CHIP_LIMIT
  return { codes: codes.slice(0, size), hidden: Math.max(0, codes.length - size) }
}

/** 展示行（组件只渲染这些字段）。 */
export interface SessionHealthDisplayRow {
  unitId: string
  /** 会话目录名（列表主键） */
  sessionId: string
  /**
   * 对话标题（**已脱敏**）；null = 宿主没给标题 → 渲染层回落显示 sessionId。
   * 用户要认的是「哪条是我的对话」，所以标题占行首最宽的位置；目录名退到 meta 行当可核对的主键。
   */
  title: string | null
  /**
   * 空白会话（从未提问过）：没有标题，也没有任何内容可认 —— 界面显示本地化的「新会话」
   * （与 DSH 自己的 `session.new` 同口径），**绝不用 uuid 冒充标题**。
   */
  blank: boolean
  projectKey: string
  severity: SessionHealthSeverity
  severityKey: (typeof SESSION_SEVERITY_KEYS)[SessionHealthSeverity]
  /** 进屏的短标签键（完整句仍走 severityKey + title）—— 长句徽章在 564px 画布上会把行卡拉宽换行 */
  severityShortKey: SessionSeverityBadgeKey
  badgeKind: 'info' | 'ok' | 'warn' | 'error'
  /** 问题码列表（文案由界面映射；顺序 = 由重到轻） */
  issueCodes: string[]
  /**
   * 问题的**补充事实**（core 的 `issue.detail`，如「seq 12→18」/「3 row(s)」）合并成一行；
   * null = 没有任何 detail。此前 detail 完全不进 UI 模型，用户只能看到「有事件无法解析」而不知道
   * 规模。渲染前过 redact（与其它宿主/扫描文本同一条铁律）。
   */
  issueDetailText: string | null
  /** 版本徽章文本（缺省 = 不显示） */
  versionText: string | null
  /** 归属工作区目录键（缺省 = 不显示） */
  projectKeyText: string | null
  /** 子代理会话标记 */
  subagent: boolean
  /** 体积文本（如 `1.2 MiB`；缺省 = 不显示） */
  sizeText: string | null
  /** 最近活动时间（毫秒；缺省 = 不显示） */
  mtimeMs: number | null
  /** T8：本行有「重放重复行」——应用内可零损失修复的那一类 */
  repairable: boolean
}

/** 字节 → 人类可读体积（与磁盘占用卡同一套阈值，避免两处口径）。 */
export function formatSessionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  const mib = kib / 1024
  if (mib < 1024) return `${mib.toFixed(1)} MiB`
  return `${(mib / 1024).toFixed(2)} GiB`
}

/** 行 → 展示行（纯映射；缺字段不填假值）。 */
/** 严重级是否需要处理（ok = 不需要）。 */
function needsAttention(severity: SessionHealthSeverity): boolean {
  return severity !== 'ok'
}

/**
 * 行列表：**默认只显示「需要处理」的行**（非 ok），
 * 但**可应用内修复的行一律保留**（哪怕它当前被判为 ok —— 那说明判据分叉，宁可显示也不藏）。
 * 全绿时返回空列表，界面据此渲染空态；「共 N 条」仍在摘要里如实给出总数。
 */
export function sessionHealthRows(response: SessionHealthResponse | null): SessionHealthDisplayRow[] {
  if (response === null) return []
  const all = response.rows.map((row) => ({
    unitId: row.unitId,
    sessionId: row.sessionId,
    // 展示文本一律先脱敏（标题是用户自由文本，可能含粘贴进来的密钥）；省略由 CSS 单行省略负责
    title: typeof row.title === 'string' && row.title.trim() !== '' ? redact(row.title) : null,
    blank: row.blank === true,
    projectKey: row.projectKey,
    severity: row.severity,
    severityKey: SESSION_SEVERITY_KEYS[row.severity],
    severityShortKey: sessionSeverityShortKey(row.severity),
    badgeKind: sessionSeverityBadgeKind(row.severity),
    issueCodes: row.issues.map((issue) => issue.code),
    issueDetailText: (() => {
      const parts = row.issues
        .map((issue) => issue.detail)
        .filter((detail): detail is string => typeof detail === 'string' && detail !== '')
      return parts.length === 0 ? null : redact(parts.join(' · '))
    })(),
    versionText: row.version !== undefined ? 'v' + String(row.version) : null,
    projectKeyText: row.projectKey !== '' ? row.projectKey : null,
    subagent: row.origin === 'subagent',
    sizeText: row.sizeBytes !== undefined ? formatSessionBytes(row.sizeBytes) : null,
    mtimeMs: row.mtimeMs ?? null,
    // 应用内修复只做「能从字节证明」的三类（与执行器 planSessionLogRepair 同源判据）
    repairable: row.issues.some((issue) => sessionIssueRepairable(issue.code)),
  }))
  return all.filter((row) => row.repairable || needsAttention(row.severity))
}

/** 这一档严重级是否需要处理（ok = 不需要；与 healthNeedAttention 同口径）。 */
export function sessionSeverityNeedsAttention(severity: SessionHealthSeverity): boolean {
  return needsAttention(severity)
}

/** 摘要展示模型。 */
export interface SessionHealthSummaryView {
  /** 需要处理的总条数（非 ok） */
  needsAttention: number
  /** 按严重级（含 ok） */
  bySeverity: Record<SessionHealthSeverity, number>
  total: number
  /** **必须显示**：未做深度校验的条数（把「没检查」说成「没问题」是本轮要消灭的谎报） */
  deepUnverified: number
  deepVerified: number
  /** 因上限未体检的会话数 */
  untested: number
  /** 读取失败的目录/文件数 */
  unreadableEntries: number
  /** 本机 DSH 会话格式版本（null = 读不到 → 不做「超前」判定） */
  targetFormatVersion: number | null
  /** 是否一条问题都没有（空态判定） */
  allHealthy: boolean
  /** 返回行里**可应用内零损失修复**的条数（重放重复行；界面据此决定给不给「修复」入口） */
  repairable: number
  /** 因「只显示有问题的对话」而被隐藏的正常会话数（界面必须说明，绝不静默少显示） */
  hiddenHealthy: number
}

export function sessionHealthSummaryView(response: SessionHealthResponse | null): SessionHealthSummaryView | null {
  if (response === null) return null
  const by = response.summary.bySeverity
  const needsAttention = by.blocksStartup + by.unloadable + by.nextRequestFails + by.invisible
  return {
    needsAttention,
    bySeverity: { ...by },
    total: response.summary.total,
    deepUnverified: response.summary.deepUnverified,
    deepVerified: response.summary.deepVerified,
    untested: response.summary.untested,
    unreadableEntries: response.summary.unreadableEntries,
    targetFormatVersion: response.targetFormatVersion,
    allHealthy: response.summary.total === 0 ? true : needsAttention === 0,
    // 只数**返回行**里的可修复条数（没回传的行界面看不到，也就不该给它入口）
    repairable: response.rows.filter((row) => row.issues.some((issue) => sessionIssueRepairable(issue.code))).length,
    hiddenHealthy: response.rows.filter((row) => row.severity === 'ok' && !row.issues.some((issue) => sessionIssueRepairable(issue.code))).length,
  }
}

/** 空态判定：没有会话数据（不是错误）。 */
export function sessionHealthEmpty(response: SessionHealthResponse | null): boolean {
  return response !== null && response.summary.total === 0
}

/** 截断提示（>0 时必须显示）。 */
export function sessionHealthTruncated(response: SessionHealthResponse | null): number {
  return response?.truncated ?? 0
}

/**
 * 每行的「复制修复命令」（离线）。
 *
 * 为什么仍然保留：应用内修复（T8）只覆盖「重放重复行」这一零损失类；其它损坏类别
 * （seq 空洞 / 不可解析行 / 容器非法 / 格式超前 …）仍然只能离线处理，所以这条出路必须一直在。
 * 按问题码精细生成命令会给人「点一下就能修」的错觉 —— 那是错的。
 */
export function sessionRepairCommands(): { command: string; reason: string }[] {
  return [
    { command: 'dsh-config-manager sessions doctor --json', reason: 'diagnose' },
    { command: 'dsh-config-manager sessions repair', reason: 'preview' },
    { command: 'dsh-config-manager sessions repair --fix', reason: 'apply' },
  ]
}

/** 修复失败/提示原因 → 文案键（config-manager-recovery 命名空间；未知原因回退通用文案）。 */
export const SESSION_REPAIR_REASON_KEYS = {
  'unknown-unit': 'sessions.repair.reason.unknownUnit',
  'not-found': 'sessions.repair.reason.notFound',
  locked: 'sessions.repair.reason.locked',
  busy: 'sessions.repair.reason.busy',
  changed: 'sessions.repair.reason.changed',
  'repair-not-found': 'sessions.repair.reason.repairNotFound',
  'already-rolled-back': 'sessions.repair.reason.alreadyRolledBack',
  unavailable: 'sessions.repair.reason.unavailable',
  unreadable: 'sessions.repair.reason.unreadable',
  'corrupt-container': 'sessions.repair.reason.corruptContainer',
  'torn-tail': 'sessions.repair.reason.tornTail',
  'invalid-header': 'sessions.repair.reason.invalidHeader',
  'nothing-to-fix': 'sessions.repair.reason.nothingToFix',
  'lossy-required': 'sessions.repair.reason.lossyRequired',
  'verification-refused': 'sessions.repair.reason.verificationRefused',
  'write-failed': 'sessions.repair.reason.writeFailed',
  'postcheck-failed': 'sessions.repair.reason.postcheckFailed',
  'backup-invalid': 'sessions.repair.reason.backupInvalid',
  // M2 缺口⑥：写后真 codec 复验未通过（已按安全序列处置）与回滚时目标又被改过 —— 过去只落到通用「未知原因」文案
  'verify-failed': 'sessions.repair.reason.verifyFailed',
  'target-changed': 'sessions.repair.reason.targetChanged',
  unknown: 'sessions.repair.reason.unknown',
} as const

export type SessionRepairReasonKey = (typeof SESSION_REPAIR_REASON_KEYS)[keyof typeof SESSION_REPAIR_REASON_KEYS]

/** 机器可读原因 → 字典键（未知原因一律回退 unknown，**绝不**把裸枚举渲染出去）。 */
export function sessionRepairReasonKey(reason: string | undefined): SessionRepairReasonKey {
  if (reason !== undefined && Object.prototype.hasOwnProperty.call(SESSION_REPAIR_REASON_KEYS, reason)) {
    return SESSION_REPAIR_REASON_KEYS[reason as keyof typeof SESSION_REPAIR_REASON_KEYS]
  }
  return SESSION_REPAIR_REASON_KEYS.unknown
}

/** 写后复验三态（+ 一个危险态）→ 文案键（config-manager-recovery 命名空间）。 */
export const SESSION_REPAIR_VERIFY_KEYS = {
  current: 'sessions.repair.verify.current',
  migrated: 'sessions.repair.verify.migrated',
  unverified: 'sessions.repair.verify.unverified',
  rollbackFailed: 'sessions.repair.verify.rollbackFailed',
} as const

export type SessionRepairVerifyKey = (typeof SESSION_REPAIR_VERIFY_KEYS)[keyof typeof SESSION_REPAIR_VERIFY_KEYS]

/**
 * 写后真 codec 复验结论 → 文案键（**三态 + 一个危险态**；undefined → null，绝不臆造「已验证」）。
 *
 *  · rolledBack === false  → rollbackFailed（**最高优先**）：复验确定性失败、且自动回滚**没成功**
 *    ⇒ 目标当前仍是「修复后字节」，这是危险态，必须压过其它一切叙述；
 *  · verified && equivalentToReadPath  → current（现役读盘可读）；
 *  · verified && !equivalentToReadPath → migrated（迁移链可还原，**不等于**现役读盘可读）；
 *  · !verified → unverified（**未验证 ≠ 已验证**）；
 *  · verify === undefined → null（没回传复验结论就不添油加醋；预览路径就是这一态）。
 *
 * 判定全部落在这个纯函数里：组件只拿返回值去查字典，不在 JSX 里写三态判断。
 */
export function sessionRepairVerifyKey(verify: SessionVerifyView | undefined, rolledBack?: boolean): SessionRepairVerifyKey | null {
  if (rolledBack === false) return SESSION_REPAIR_VERIFY_KEYS.rollbackFailed
  if (verify === undefined) return null
  if (!verify.verified) return SESSION_REPAIR_VERIFY_KEYS.unverified
  return verify.equivalentToReadPath ? SESSION_REPAIR_VERIFY_KEYS.current : SESSION_REPAIR_VERIFY_KEYS.migrated
}

/**
 * 批量「一键修复」里的一条结果（**类型定义在 ui 层**，与 RecoveryPanel 的批量视图条目同构）。
 *
 * 为什么放这里：成功与失败**两条分支**必须同源搬运 verify / rolledBack —— A2-F1 正是失败分支漏搬，
 * 于是「自动回滚未成功」的危险态在批量视图里不可见，而失败文案还说着「见下方复验结论」。
 * 把搬运收成一个可单测的纯函数后，任何一条分支漏字段都会在单测里红。
 */
export interface SessionRepairBatchEntryView {
  unitId: string
  sessionId: string
  ok: boolean
  /** 被拒原因（机器可读；未知一律走 unknown 文案，绝不渲染裸枚举） */
  reason?: string
  /** 被拒是「需要逐个确认的有损修复」 */
  lossy?: boolean
  /** 成功时丢弃的行数 */
  droppedRows?: number
  /** 传输层失败（HTTP/网络）时的原文 */
  transportError?: string
  /** 写后真 codec 复验结论（成功项与 verify-failed 失败项都有） */
  verify?: SessionVerifyView
  /** 确定性失败时自动回滚是否成功（false = 目标仍是修复后字节，危险态必须可见） */
  rolledBack?: boolean
}

/**
 * 一次 `repairSession` 调用的结果 → 批量条目（成功 / 失败**两条分支的唯一搬运**）。
 *
 * 只搬真实存在的字段（缺字段不填假值）：verify 缺席 = 没做/没回传复验，
 * 界面据此**不渲染**任何复验结论，也绝不臆造「已验证」。
 */
export function sessionRepairBatchEntry(input: {
  unitId: string
  sessionId: string
  ok: boolean
  reason?: string
  lossy?: boolean
  droppedRows?: number
  transportError?: string
  verify?: SessionVerifyView
  rolledBack?: boolean
}): SessionRepairBatchEntryView {
  const entry: SessionRepairBatchEntryView = { unitId: input.unitId, sessionId: input.sessionId, ok: input.ok }
  if (input.reason !== undefined) entry.reason = input.reason
  if (input.lossy === true) entry.lossy = true
  if (input.droppedRows !== undefined) entry.droppedRows = input.droppedRows
  if (input.transportError !== undefined) entry.transportError = input.transportError
  if (input.verify !== undefined) entry.verify = input.verify
  if (input.rolledBack !== undefined) entry.rolledBack = input.rolledBack
  return entry
}

/** 台账记录 → 展示行（跳过没有 repairId 的坏记录；最近在前）。 */
export interface SessionRepairEntryView {
  repairId: string
  unitId: string
  sessionId: string
  logName: string | null
  backupName: string | null
  at: number | null
  droppedRows: number
  rolledBack: boolean
}

export function sessionRepairEntries(response: SessionHealthResponse | null): SessionRepairEntryView[] {
  const raw = response?.repairs
  if (raw === undefined) return []
  return raw
    .filter((entry): entry is SessionRepairEntry => typeof entry?.repairId === 'string' && entry.repairId !== '')
    .map((entry) => ({
      repairId: entry.repairId,
      unitId: entry.unitId,
      sessionId: entry.sessionId,
      logName: entry.logName ?? null,
      backupName: entry.backupName ?? null,
      at: entry.at ?? null,
      droppedRows: entry.droppedRows ?? 0,
      rolledBack: entry.rolledBackAt !== undefined,
    }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
}

/** 面板状态（loading / error / ready）的判定 —— 组件只映射，不自己判。 */
export type SessionHealthPhase = 'idle' | 'loading' | 'ready' | 'error'

export function sessionHealthPhase(state: {
  loading: boolean
  error: string | null
  response: SessionHealthResponse | null
}): SessionHealthPhase {
  if (state.error !== null) return 'error'
  if (state.loading) return 'loading'
  return state.response === null ? 'idle' : 'ready'
}
