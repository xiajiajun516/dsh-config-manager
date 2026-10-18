/**
 * 工作区 + 会话回滚点引擎（t1：把「三态同点检查点」改写为「工作区 + 会话回滚」）。
 *
 * ## 口径（S1–S8）
 * - **S1 自动留点**：不再有手动「拍点」表单，也没有 capture 子路径。宿主订阅
 *   `session/event`，每见到一个 `turn/end` 就为**当前会话**留一个回滚点 =
 *   工作区快照（内容寻址入对象仓）+ 会话游标（事件数 / 字节长度 / fork 边界）。
 * - **S2 两态**：只有 `workspace` 与 `session`。**没有** config 第三态，**没有**
 *   `samePointVerdictOf`（两态之间没有「同点」可判；`spreadMs` 只作为诚实事实回传）。
 * - **S3 会话回退 = fork 子会话**：在**目标回合开始前的稳定边界**（boundarySeq =
 *   该回合 `turn/start` 事件的 seq − 1）用 `ctx.sessions.fork(source, boundary, childId?)`
 *   切一个子会话；**原会话日志只读、绝不改写**（这与旧版「逐字节写回日志」相反，
 *   旧版的静止期门 / 分叉门 / 字节副本写回因此全部下线）。结果回传 `childSessionId`。
 *   fork 由宿主注入的 seam 提供（core 不 import @deepseek-ai/* —— 架构边界）。
 * - **S4 工作区恢复 = 只覆盖记录在案的路径 + 只删「未记录且可证」的路径**：写回前先做**只读校验**
 *   （路径必须落在记录里的分块内 + 对象仓内容 SHA-256 必须与记录一致），任何一条不合格 →
 *   **零写入**整体失败。
 *   删除（用户 2026-10-11 定案 A + 2026-10-12 修法 A+B）只作用于**能证明「留点时刻不存在」**的路径：
 *   候选 = 当前存在、在分块内、且**不在**证明名单里（证明名单 = `files` ∪ `skipped` ∪
 *   `unreadableFiles` ∪ `excludedDirs` ∪ **路径索引** `pathIndex` —— 捕获时走查过的全部路径，
 *   gzip 对象；逐条跳过名单被记录上限截断时它就是那份完整名单）。候选再过安全判据才删
 *   （`.git`/`node_modules` 段、插件数据区、分块外、非绝对路径、单文件超上限一律**拒删**并如实进
 *   `createdSkipped`）；**证明名单不完整时一条都不删**（只有两类情形：跳过名单被截断时路径索引缺失/读不出
 *   —— 老台账、对象丢失、gzip 坏；或有读不出的目录）。**「预算截断」本身不再拒删** —— 旧口径拿它当「捕获不完整」整体放弃，
 *   于是大工作区（本仓实测 88 138 个文件）里每个点都不删，中间回合新建的文件全部留在工作区。
 *   预览与执行**共用同一份规划**（`planCreatedRemovals`）⇒ 预览说会删的 = 实际删的。
 *   **捕获边界口径（t13 冻结）**：单文件上限 `maxFileBytes`（缺省 = 总量预算 `maxBytes`）**先 stat 判大小**，
 *   超限就跳过、绝不整份读进内存；文件数预算（maxFiles）与字节预算（maxBytes）耗尽时其后**每一条**都进
 *   `skipped` 并带原因（`too-large` / `budget-bytes` / `budget-files`）；`skipped` 列表记录上限
 *   `maxSkippedEntries`（缺省 5000）只影响**记录条数**，超出只计数 + 置 `skippedTruncated`，
 *   `skippedCount` 仍是跳过事件总数、如实回传 —— **绝不静默丢弃，也不整点丢弃**。
 * - **S5 安全链**：只读预览（零写入）→ 二次确认（`userConfirmed` 必须**恰好** true，
 *   否则 `confirmation-required`）→ 恢复前自动留**救援点**（guard）→ 写回 →
 *   **T10：救援点的成败判据是「台账真的写进去了」（`appendRecord` 成功）**，不是「拿到了内存 record」：
 *   写失败时 `require` 档整体中止（`guard-failed`、零写入），`warn` 档只告警继续且**不报** `guardPointId`。
 *   **逐文件重新读回并核对 SHA-256**；任一不符或任一写失败 → **整体回滚到恢复前状态**
 *   （把每个被触碰文件写回前像；本来不存在的就删掉我们刚创建的那个）→ 结构化失败。
 *   写路径由路由层过 withMutationLock + SAFE MODE（引擎不持锁）。
 *   **准入判定只有一份口径（t22）**：回退只拒 `protected`（不可回退）与 `incomplete`（需显式
 *   `allowPartial`）；`kind:'guard'` 的救援点**可以**作为回退目标 —— 它是「回到回退前那一刻」的
 *   唯一路径。`canRestore`（能否回退）与 `canRemove`（能否删除，排除 guard）**互相独立**。
 * - **S6 留存（t14 冻结 + 2026-10-12 追加 guard 全局上限）**：自动点每会话最多
 *   `maxRecordsPerSession`（缺省 20）、全局最多 `maxRecords`（缺省 50），**只删最旧的自动点**。
 *   `kind:'guard'` 的救援点（回退前自动留）**不占**自动点预算、**不受** 20/50 淘汰，也**不被用户
 *   删除**（`remove` 一律 `protected-point`）—— 因此它有**自己的两道**上限：每会话
 *   `maxGuardsPerSession`（`ROLLBACK_MAX_GUARDS_PER_SESSION`，缺省 20）→ 全局 `maxGuards`
 *   （`ROLLBACK_MAX_GUARDS`，缺省 50）；两轮都只淘汰最旧的 guard，否则「反复回退 + 多会话」
 *   会让台账无界增长。guard 的全局 50 与自动点的全局 50 **互相独立**（谁也不吃谁的额度）。
 *   `protected:true` 的点仍「只进不出」（生产路径造不出来：capture 端点已下线、tracker 不设 protect）。
 *
 * ## 机器可读、零用户可见文案
 * 本模块只回 code / reasonCode（枚举）与技术细节（路径、errno、计数）；用户可见文案一律
 * 由界面层按字典键映射。code → HTTP 的映射在路由层 `rollbackHttpStatus`。
 *
 * ## 会话日志是不透明字节流
 * 本模块不解析会话日志格式（不做 generation 归位）：会话态只记录 sessionId / 事件游标 / 字节数 /
 * 内容指纹，**且只在容量允许时**把字节副本放进对象仓（仅为审计证据；回退不依赖它）。
 *
 * **唯一的例外（t9）**：为了把「fork 子会话的继承回合」解析到祖先点上，需要知道
 * **谁是从谁播种来的** —— 这只能读会话日志的**第一帧头**（只读、有界 64 KiB、带 mtime+size 缓存，
 * 见 {@link readSessionForkHeader}）。它**不参与任何捕获**（点的字节仍是不透明流），
 * 也只登记「历史被继承」的 fork 子会话（子代理会话的回合号是它自己的，按回合上溯会误命中）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

import { atomicWriteFile } from '../utils/atomic-write.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { isRecord } from '../utils/guards.ts'
import { EXCLUDED_DEP_DIR_NAMES } from '../utils/recursive-walk.ts'
import { diffLines, type DiffHunk } from '../utils/line-diff.ts'
import { projectKeyOf } from './session-select.ts'
import { ignoreRelativePath, ignoreRuleMatches, loadIgnoreRules, type IgnoreRules } from './rollback-ignore-rules.ts'
import type { RollbackWriteAttributionPort, RollbackWriteFact, RollbackWriteRecorder } from './rollback-attribution.ts'
import { mergeThreeWay } from './rollback-merge.ts'
import { decodeTextBytes, encodeTextBytes } from './text-fidelity.ts'
import { UndoJournalWriter, findInterruptedUndos, readUndoJournal, replayUndoJournal, type InterruptedUndo, type UndoJournalEntry } from './rollback-undo-journal.ts'
import { isSessionLogName } from '../utils/session-log.ts'
import { decodeZstdFrame, scanZstdFrames, zstdAvailable, ZSTD_MAGIC } from '../utils/zstd-frame.ts'
import {
  cleanupOrphanTempFiles,
  entrySummaryOf,
  ROLLBACK_DEFAULT_LEDGER_BYTES,
  ROLLBACK_UNDO_DIR_NAME,
  RollbackLedger,
  type RollbackLedgerManifestEntry,
  type RollbackLedgerMigration,
  type RollbackLedgerPrepared,
} from './rollback-ledger.ts'

/* ------------------------------------------------ 跨会话回退的归属证据 */

/** 合并被拒绝的机器原因（界面映射成字典键，绝不裸渲染） */
type MergeBlockReason =
  | 'conflict' | 'no-base' | 'ambiguous' | 'binary' | 'non-utf8' | 'degraded'
  | 'theirs-missing' | 'theirs-unreadable' | 'ours-unreadable'
  /** 落点无人认领：改这条路径的那一刻没有任何会话活跃（手改 / 外部工具 / 另一个进程） */
  | 'unclaimed'

/**
 * 「这条路径**是不是本会话写的**」—— 只读旁证，**绝不从内容猜**（2026-10-18）。
 *
 *  · 'target'    = 有证据表明是**本会话**写的（归属台账命中本会话，或 mtime 落在本会话活跃窗口内）
 *                  ⇒ 允许按旧口径撤销；
 *  · 'foreign'   = 有证据表明是**别的会话**写的（归属命中别的会话，或 mtime 落在别的会话窗口内）
 *                  ⇒ 必须合并或拒绝，**绝不整文件覆盖**；
 *  · 'unclaimed' = **有覆盖**（时间窗数据可用）却没有任何会话在那一刻活跃 ⇒ 拒绝覆盖；
 *  · 'unknown'   = 完全拿不到证据（老数据 / 未接时间窗 / stat 失败）⇒ **不得据此拦截**，退回既有口径。
 *
 * 为什么要时间窗：归属台账只从 tool/call 的参数里抽路径，bash / 脚本 / 外部编辑器写的路径拿不到归属
 *（2026-10-17 真机「B 对话加了描述、回退 A 时把 B 那行也抹掉」的根因之一就是归属缺了 B 那次写入）。
 * mtime 落在谁的活跃窗口内与工具参数无关，因此那类写入同样能被判出来。
 */
type WriteProvenance = 'target' | 'foreign' | 'unclaimed' | 'unknown'

/** 一次合并判定所需的全部旁证（调用方算好，本模块只消费） */
interface ForeignEvidence {
  provenance: WriteProvenance
  /** 别的会话的回合点里**没有**这条路径 ⇒ 当前内容是那个点之后才出现的（新建 / 重建） */
  absentAtForeignPoint: boolean
}

/** 活跃时间窗的**读**端口（core/rollback-activity.ts 的实现注入；缺省 = 没有时间证据） */
export interface RollbackActivityPort {
  hasDataFor(sessionId: string): boolean
  sessionsActiveAt(at: number, toleranceMs?: number): string[]
}

/** 活跃时间窗的**写**端口（tracker 用；缺省 = 不采集） */
export interface RollbackActivityRecorder {
  noteActivity(sessionId: string, at?: number): void
}

/** 逐字节相等（救援点当 base 的自证用） */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
  return true
}

/** 前 8 KiB 是否含 NUL（与 text-fidelity / line-diff 同口径） */
function hasNulByte(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192)
  for (let i = 0; i < head.length; i += 1) if (head[i] === 0) return true
  return false
}

/**
 * latin1 视图：**字节的双射**（0..255 ↔ U+0000..U+00FF，逐字节一一对应）。
 *
 * 用途：三方合并的输入必须是「文本」，而非 UTF-8 文件（GBK / Latin-1 / 半截序列）用 UTF-8 解码
 * 会把非法字节变成 U+FFFD ⇒ 写回即内容损毁（2026-10-18 真机形状：caf\u00E9 的 0xE9 被写成 EF BF BD）。
 * latin1 视图下「字符串相等」= 「字节相等」，行级 diff / 合并因此**等价于按字节做**：非法字节逐字保留。
 */
function latin1Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1')
}

/* ------------------------------------------------------------------ 常量 */

/** 增量链的最大长度：到顶就落一个**全量锚点**（重建最多读 1 份全量 + 几份小增量） */
const ROLLBACK_DELTA_CHAIN_LIMIT = 8
/** path → 基准摘要键（sha256/bytes/chunk 拼成，只用于判「这条与基准逐条相同」） */
type RollbackDeltaDigest = { hash: string; chain: string[]; chunks: string[]; entries: Map<string, string> }
/** 增量视图只有在小于全量的这个比例时才采用（否则直接全量，简单可靠） */
const ROLLBACK_DELTA_MAX_RATIO = 0.6

export const ROLLBACK_SCHEMA_VERSION = 2
/** 回滚点库目录名（dataDir/rollback-points）——路由族 /recovery/rollback-points/* 同源 */
export const ROLLBACK_POINTS_DIR_NAME = 'rollback-points'
/**
 * 台账**清单**文件名（v3，issue #89）：它只是一份小清单（元数据 + 段摘要），
 * 完整记录在 records/<id>.json、工作区载荷在 payloads/<sha256>.json —— 清单里绝不含大数组。
 */
export const ROLLBACK_LEDGER_NAME = 'index.json'
export const ROLLBACK_OBJECTS_DIR_NAME = 'objects'
/**
 * 台账字节预算（records/ + payloads/）的缺省值，可由 RollbackEngineOptions.ledgerBytesBudget 覆盖。
 * 为什么需要它：ROLLBACK_MAX_RECORDS（50）只限**条数**；本机实测 50 条 = 473 MB 直接把宿主撑爆。
 */
export { ROLLBACK_DEFAULT_LEDGER_BYTES }
/** 全局自动点上限（S6）；protected / guard 点不占预算、只进不出 */
export const ROLLBACK_MAX_RECORDS = 50
/** 每会话自动点上限（S6） */
export const ROLLBACK_MAX_RECORDS_PER_SESSION = 20
/**
 * 每会话 **guard 点**上限（S6 的显式例外，t14 冻结）：guard 是「回退前自动救援点」，
 * 用户无法手动删除（remove 一律回 protected-point），所以**必须**有自己的上限，
 * 否则反复回退会让台账无界增长。超过上限时只淘汰**最旧的 guard**（每会话各自计）。
 *
 * 与 20/50 的关系：guard **不占**自动点预算、也**不**被自动点的 20/50 淘汰；
 * 反过来自动点也不会因 guard 的淘汰而受影响。protected 点（只有测试能造出来 ——
 * capture 端点已下线、tracker 从不设 protect）仍保持「只进不出」。
 */
export const ROLLBACK_MAX_GUARDS_PER_SESSION = 20
/**
 * **全局** guard 点上限（S6 的第二道 guard 预算，用户 2026-10-12 追加）。
 *
 * 每会话 20 只挡住单个会话：本机 1300+ 会话时，跨会话的 guard 仍会无界增长（台账 + 对象仓
 * 都留在磁盘上）。所以全局再设一道 —— 全部会话的 guard 合计最多 50，超出只淘汰**最旧的 guard**。
 *
 * 与自动点的全局 `ROLLBACK_MAX_RECORDS`（50）**互相独立**：两类各自计预算，谁也不吃谁的额度
 * （数值相同纯属巧合，不构成耦合 —— 改一个不必改另一个）。
 */
export const ROLLBACK_MAX_GUARDS = 50

/**
 * fork **继承链**扫描时最多读多少个会话日志头（有界）。
 *
 * 为什么有上限：一次扫描的代价必须可预测；超限时如实把链标成**不完整**
 * （客户端据此把「未命中」报成**未知**而不是「确知没有」，绝不把看不完说成没有）。
 */
export const ROLLBACK_FORK_LINKS_MAX_READS = 500

/**
 * 继承链扫描结果的缓存 TTL（毫秒）。
 *
 * 为什么要有 TTL：`list()` 是只读热路径（聊天里每条消息一颗按钮、回滚卡刷新都走它），
 * 每次重扫会话目录会把只读路径变成 IO 热点。15 s 是「刚 fork 出来的子会话最多 15 s 内被认出来」
 * 与「热路径几乎不重扫」之间的折中；活会话登记（{@link RollbackPointEngine.noteSessionBinding}）
 * 让**本次运行**里刚 fork 的子会话立刻可用，不依赖这个 TTL。
 */
export const ROLLBACK_FORK_LINKS_TTL_MS = 15_000

/**
 * 会话父链上溯的**深度上限**（与宿主侧 `ANCESTOR_LOOKUP_MAX_DEPTH` 同口径取 8：
 * DSH 的分叉 / 子代理树实际深度是个位数）。上限 + 环保护一道，异常数据不会把路径卡死。
 */
export const ROLLBACK_ANCESTOR_MAX_DEPTH = 8

/**
 * `list()` 里为 fork 子会话补的**继承视图**条目上限（有界；超出如实标记
 * {@link RollbackListResult.inheritedViewTruncated}）。
 */
export const ROLLBACK_INHERITED_VIEW_MAX = 100

/**
 * 继承判据用的台账快照 TTL（毫秒）。
 *
 * 为什么需要：留点器每个 `turn/start` 都要问一次「祖先有没有这个回合的点」，而台账是整份读
 * （真机 4.7 MB）—— 每回合都读会把写热路径拖慢。2 s 足够短（父会话的点通常早就写完了，
 * 而且留点器还会先用**本进程见过的祖先回合**这一档判据），也足够省。
 */
export const ROLLBACK_INHERITED_LEDGER_TTL_MS = 2_000
export const ROLLBACK_DEFAULT_MAX_FILES = 20000
export const ROLLBACK_DEFAULT_MAX_BYTES = 512 * 1024 * 1024
/** 单文件上限（缺省 = 总量预算）：超限文件**先 stat 判大小后跳过**，绝不整份读进内存 */
export const ROLLBACK_DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
/**
 * 用户可在分块根放的忽略规则文件名（语法同 .gitignore 的常用子集；见 rollback-ignore-rules.ts）。
 * 被忽略的**文件**照旧进 skipped（证明名单仍完整）；被忽略的**整个目录**不进走查，
 * 因此证明名单不完整 ⇒ 该点的删除集整体拒绝（fail-closed）。
 */
export const ROLLBACK_IGNORE_FILE_NAME = '.dsh-rollback-ignore'
/** skipped / excludedDirs 列表的**记录条数**上限：超出只计数 + 置 skippedTruncated（计数仍如实回传） */
export const ROLLBACK_SKIPPED_LIST_LIMIT = 5000
/** 会话日志超过此大小则只记游标 + 弱指纹（字节副本不进对象仓） */
export const ROLLBACK_DEFAULT_SESSION_MAX_BYTES = 32 * 1024 * 1024
/** 预览里「该会话日志刚被写过」的窗口（仅供提示；fork 只读，不再据此拒绝） */
export const ROLLBACK_DEFAULT_SESSION_QUIESCENT_MS = 30_000
/** 轮询回退的间隔上界（S1：会话日志 mtime ≤5 s 轮询） */
export const ROLLBACK_DEFAULT_POLL_INTERVAL_MS = 5_000
export const ROLLBACK_LEFTOVER_LIST_LIMIT = 20

/**
 * 工作区捕获的**挂钟时间预算**（缺省 30 s）。
 *
 * 为什么需要（对标 dsh-turn-rewind 的 `deadline.ts`、dsh-checkpoint-rewind 至今未合并的 PR #25）：
 * 捕获路径此前只有「文件数 / 总字节 / 单文件字节」三个**规模**上限，没有**时间**上限 ——
 * 一个「文件数很多但总量不大」的工作区能让 walk + stat + sha256 跑很久。
 * 超预算**不是失败**：已收条目照常成点（ok=true），未走查的部分按 `budget-time` 逐条留痕、
 * `truncated` 置真 ⇒ 删除集自动 fail-closed（证明名单不完整就一条都不删）。
 */
export const ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS = 30_000
/**
 * 自适应预算区间（见 RollbackEngineOptions.captureBudgetMs）：上一次留点被截断 ⇒ 下次 ×2，
 * 上一次只用掉不到 1/4 ⇒ 下次 ÷2。区间外不再调整（避免无限拉长 / 缩到不可用）。
 */
export const ROLLBACK_MIN_CAPTURE_BUDGET_MS = 10_000
export const ROLLBACK_MAX_CAPTURE_BUDGET_MS = 120_000
/**
 * 捕获期「读内容 + 写对象仓」的并发上限。
 *
 * 为什么必须并发：真机实测（34k 文件 / 512 MiB）一次全量捕获 175 s，其中 **148 s 花在
 * 31,702 次对象写**（一次 4.7 ms：temp + fsync + rename），而走查本身只要 0.66 s。
 * 对象写入是纯 I/O，串行做等于把预算全花在等待上 ⇒ 覆盖永远只有一小半。
 * 并发上限与**在飞字节闸门**共同限流（在飞内容上界 = `captureInFlightBytes`）。
 */
export const ROLLBACK_DEFAULT_CAPTURE_CONCURRENCY = 16
/**
 * 捕获期**读入内存、尚未落对象仓**的内容字节上限（真正的内存闸门）。
 *
 * 为什么必须独立于 `maxFileBytes`（0.1.74 真机闪退事故，2026-10-16）：
 *  `maxFileBytes` 的缺省是**总量预算** `maxBytes`（512 MiB）。并发捕获把闸门接到它上面，
 *  于是「同时在飞的内容」可以到 ~512 MiB —— 串行实现的上界是「一份文件」，并发实现的
 *  上界是「闸门限额」，两者差着两三个数量级。真机表现：发出消息后 1–2 s（= `turn/start`
 *  开始留点）DSH Desktop 宿主被系统终止 ⇒ 桌面闪退（无 JS 栈、插件零错误、
 *  退出码是「被外部终止」形状）。这里取一个小常量当闸门；要放宽只能显式传
 *  `captureInFlightBytes`，且被 `maxBytes` 夹住。
 */
export const ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES = 32 * 1024 * 1024
/** 对象写遇到这些码视为「瞬时占用」，有界退避重试（判据同 atomic-write 的 isRetryableLockCode） */
const OBJECT_WRITE_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']
/** 捕获阶段①的 stat 批大小：判定仍严格按顺序，只是 stat 并发取（真机 34k 次 stat 从 5 s → <1 s） */
export const ROLLBACK_CAPTURE_STAT_BATCH = 128
/**
 * 捕获期**候选名单**上限（不是入点上限）：必须显著大于 maxFiles，否则「缺口优先」排序作用不到
 * 那些排在遍历顺序尾部、上一回合没覆盖到的文件（它们连候选都进不了 ⇒ 覆盖率永远不收敛）。
 * 走查本来就会把每条路径记进 walked（路径索引的来源），这里多留的只是候选数组本身。
 */
export const ROLLBACK_CAPTURE_LIST_LIMIT = 200_000
/** 捕获阶段①的 stat 结果（一次 bigint stat 拿到大小 / mtime / 身份；失败时带原始 detail） */
interface RollbackFileStat {
  isFile: boolean
  size: number
  mtimeMs: number
  identity: string | null
  error?: string
}
/** 走查中断时逐条记下的「没进去的子树」上限；超出即放弃精确范围，退回全局 fail-closed */
export const ROLLBACK_UNWALKED_DIRS_LIMIT = 200

/**
 * 「删除回退点之后新建的路径」的**整套上限**（用户 2026-10-11 定案 A）。
 * 超过就整套拒绝（fail-closed），绝不删一半 —— 半套删除既没有可解释的状态，也无法整体回滚。
 */
export const ROLLBACK_MAX_CREATED_REMOVALS = 5000
export const ROLLBACK_DETAIL_LIMIT = 50

/**
 * E1：预览里「逐文件行级统计」的规模上限。四条**只影响** `workspace.files[].added/removed`：
 * 触到任一条的条目仍然照给 status，但 added/removed 置 null 且 truncated=true ——
 * **宁可说「不知道」，也绝不谎报行数**。
 *
 * 为什么需要：预览要读「快照对象 + 当前文件」两份内容再做行级 diff，而一个点的记录可能有上千条目；
 * 没有上限时一次预览就能把宿主的 I/O 与 CPU 拖住。
 * - 单文件 1 MiB：单条目的读写/解码都钉在一个小上限内（绝大多数源码文件远小于它）；
 * - 单张预览累计 32 MiB：与捕获期字节预算（`ROLLBACK_DEFAULT_MAX_BYTES`）同量级；
 * - 单文件 8e6 步 / 单张预览 32e6 步：行级 diff 是 Myers O((N+M)·D)，步数上限就是时间上限
 *   （32e6 步在毫秒~百毫秒量级），避免「大文件被整篇改写」这种最坏情形把请求拖死。
 */
export const ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES = 1024 * 1024
export const ROLLBACK_PREVIEW_DIFF_MAX_TOTAL_BYTES = 32 * 1024 * 1024
export const ROLLBACK_PREVIEW_DIFF_MAX_WORK = 8_000_000
export const ROLLBACK_PREVIEW_DIFF_TOTAL_WORK = 32_000_000
/**
 * 单文件前后对照（fileDiff）的展示上限：
 *  · maxFileBytes 与预览行数统计**同一档**（同一份数据不该有两个口径）；
 *  · context = 变更块外保留的上下文行数（3，与 git unified diff 一致）。
 * 超限时的行为是**说「看不了」**（结构化 reason + 空 hunks），绝不截半截差异。
 */
export const ROLLBACK_FILE_DIFF_LIMITS = {
  maxFileBytes: ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES,
  context: 3,
  /**
   * Myers 编辑距离上限（2026-10-15 用户：不该动辄出现「已按整块替换展示」）。
   * 实测（本仓 rollback-point.ts 的 4983 行 × 2492 行版本对）：D 在 3000~4000 就能拿到
   * 最小编辑脚本 —— 耗时 ≤70 ms；代价是回溯的 V 快照 O(D²)，RSS 峰值 +~100 MB。
   * 缺省那档 400 会让几千行里的普通改动一律退化成「整块替换」，那正是用户看到的那条提示；
   * 单文件是**按需点开**的一屏，这点内存换「真差异」划算。再大就换算法，不加预算。
   */
  maxD: 4000,
} as const

/** 恢复顺序（工作区在前；工作区失败即中止后面的会话段） */
export const ROLLBACK_REWIND_ORDER = ['workspace', 'session'] as const

/** 存储栈缺失时给出的组合指引（技术标识；界面按 code 映射字典键） */
export const ROLLBACK_STORAGE_REQUIREMENTS: readonly string[] = [
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
]

const MAX_WALK_DEPTH = 64
const OBJECT_KEY_RE = /^[0-9a-f]{64}$/

/**
 * 路径身份缓存的落盘格式版本（dataDir/rollback-points/path-cache.json）。
 * 键 = dev:ino:size:mtimeNs:ctimeNs:mode（全 BigInt 字符串化）⇒ 身份未变即认为内容未变，
 * 于是不必重读、重算 sha256。缓存是**纯优化**：读失败 / 形状不符一律丢弃并回落全量读，
 * 且**绝不**参与任何删除 / 覆盖判定（那些判据只认本次走查与台账）。
 */
export const ROLLBACK_PATH_CACHE_VERSION = 1
export const ROLLBACK_PATH_CACHE_NAME = 'path-cache.json'

/** 一条路径身份缓存记录（键 = 身份键，值是内容寻址的 sha256 + 字节数） */
interface RollbackPathCacheEntry {
  path: string
  sha256: string
  bytes: number
}

/* ------------------------------------------------------------------ 类型 */

export type RollbackStateKind = 'workspace' | 'session'
/**
 * auto = 回合自动留点；guard = 恢复前自动救援点（用户不可删、不占自动点的 20/50 预算，
 * 但受 `maxGuardsPerSession` 自身上限约束、可作为回退目标 —— 见 ROLLBACK_MAX_GUARDS_PER_SESSION）。
 */
export type RollbackPointKind = 'auto' | 'guard'
export type RollbackOutcome = 'restored' | 'partial' | 'failed' | 'denied'
export type RollbackSegmentStatus = 'restored' | 'skipped' | 'failed'
export type RollbackGuardPolicy = 'require' | 'warn' | 'off'
/** mode 三选一（S5/S7）；显式 segments 优先于 mode */
export type RollbackMode = 'files+session' | 'files' | 'session'

/**
 * 机器可读结果码。**冻结集**（wire contract，必须严格保用）：
 * ok / deleted / confirmation-required / protected-point / record-not-found /
 * record-incomplete / invalid-input / no-boundary / storage-unavailable /
 * mutation-locked / method-not-allowed。
 * 其余为**内部分级码**：只出现在 segments[].reasonCode / warnings / detail，
 * 顶层 code 只用冻结集（例外：`restore-failed`、`guard-failed`、`ledger-write-failed`，
 * 前端按「未知码回落 unknown」处理）。
 */
export type RollbackCode =
  | 'ok'
  | 'deleted'
  | 'storage-unavailable'
  | 'ledger-unreadable'
  | 'ledger-write-failed'
  | 'confirmation-required'
  | 'record-not-found'
  | 'protected-point'
  | 'record-incomplete'
  | 'invalid-input'
  | 'no-boundary'
  | 'guard-failed'
  | 'invalid-path'
  | 'object-missing'
  | 'object-hash-mismatch'
  | 'restore-failed'
  | 'verify-failed'
  | 'nothing-to-restore'
  /**
   * 待删除的「该点未记录」路径数超过 `ROLLBACK_MAX_CREATED_REMOVALS` ⇒ **整套拒绝、零写入**
   * （绝不删一半）。是**顶层 code**：界面必须说清「因为待删路径超过上限，一条都没动」，
   * 不得回落成泛化的「请求参数不合法」（那正是用户看不懂「回退为什么失败」的来源）。
   */
  | 'created-removals-limit'
  /**
   * T10：该态**没有记录任何文件**（工作区段 files=0）—— 与「有记录但全部已一致」严格分开：
   * 界面必须说两句不同的话（「这点没记录文件」vs「工作区已与该点一致」），
   * 而 `detail` 是技术细节、**不能**当用户可见分派依据。只出现在 segments[].reasonCode。
   */
  | 'no-recorded-files'
  | 'mutation-locked'
  | 'method-not-allowed'
  | 'session-missing'
  | 'session-out-of-root'
  | 'session-too-large'
  | 'session-active'
  /**
   * 子代理会话（`header.origin === 'subagent'`）：**不自动留点**。
   * 它的工作区与父会话相同、回合号是自己的，留点既与父会话重复又只挤占预算；
   * 用户在侧栏看到的是嵌套在父对话下的子代理，不需要单独回退。
   * 读不到 `origin`（老宿主）时**不加判定** —— 绝不因为读不到就少留点。
   */
  | 'subagent-session'
  | 'session-fork-unavailable'
  | 'fork-failed'
  | 'capture-failed'
  | 'capture-truncated'
  | 'capture-degraded'
  | 'no-chunks'
  | 'chunk-not-absolute'
  | 'chunk-not-found'
  /** 单文件差异：该路径**不在**这个回滚点的记录里（收窄：绝不把本端点做成任意路径读取器）。 */
  | 'file-not-recorded'

/** 结构化指引 / 告警：code 供界面映射字典键，detail 是技术标识（路径 / errno / 计数）。 */
export interface RollbackGuidance {
  code: string
  detail?: string
}

export interface RollbackWorkspaceFile {
  /** 捕获时的绝对路径（恢复目标） */
  path: string
  /** 该文件所属的显式分块（chunks 里的一项） */
  chunk: string
  bytes: number
  sha256: string
  mtimeMs: number
  /** 对象仓键（= 内容 SHA-256） */
  object: string
}

export interface RollbackSkippedEntry {
  path: string
  /**
   * link（符号链接/junction，不跟随）/ missing / not-a-file / self-store /
   * dep-dir（运行时依赖目录，整棵忽略）/ ignored（用户忽略规则命中）/ too-large（超单文件上限）/
   * budget-bytes（加它会超总量预算）/ budget-files（文件数预算用尽）/
   * asar-container（含 `.asar` 段的路径：宿主会把它当容器解析、畸形夹具能带走宿主，因此绝不碰）
   */
  reason: string
}

/**
 * 「留点时刻**走过**哪些路径」的完整证明名单（内容寻址的 gzip 对象：每行一个绝对路径，UTF-8）。
 *
 * 它存在的唯一理由 = **方向 B**：`maxSkippedEntries`（逐条跳过名单的记录上限，缺省 5000）一旦截断，
 * `files ∪ skipped` 就不再是完整名单 —— 没有它，「未记录」就无法与「留点时就存在」区分，
 * 于是只能整点放弃删除（那正是「中间回合新建的文件一个都没被删」的机制）。
 */
export interface RollbackPathIndex {
  /** 对象仓键（内容寻址到 gzip 后的字节） */
  object: string
  /** 名单条数（= 走查过的文件数） */
  count: number
  /** gzip 后的字节数（诊断 / 日志用） */
  bytes: number
}

export interface RollbackWorkspacePayload {
  /** 显式路径分块：恢复只在这些分块内覆盖 */
  chunks: string[]
  /**
   * 记录在案的**文件条目数**。**必须自带**（不能再用 `files.length`）：增量视图下 `files` 只是
   * 「相对基准新增/改写的子集」，而摘要（界面上的条数 / 可恢复判定）要的是全量条数。
   */
  fileCount?: number
  files: RollbackWorkspaceFile[]
  /**
   * **存盘专用**：这份载荷是「相对某个基准载荷的增量」（见 rollback-ledger 的 resolvePayload）。
   * 只在写盘那一刻存在 —— 任何读路径（readRecord / 预览 / 回退 / 对象回收）拿到的都是**物化后**
   * 的完整 `files`（`delta` 已被抹掉）。**绝不把带 delta 的对象交给消费者**：它看起来像一份
   * 「只有这几条记录」的完整清单，拿去规划删除会删掉其它全部文件。
   */
  delta?: {
    /** 基准载荷的内容寻址哈希（必须在 prune/回收时一并保活） */
    base: string
    /** 基准自己的依赖链（深→浅，含基准），保活用 */
    baseChain: string[]
    /** 相对基准**不再存在**的路径（逐字，与捕获产出的绝对路径同形） */
    removed: string[]
    /** 相对基准**新增 / 改写**的条目（`files` 在增量视图下为 null） */
    added?: RollbackWorkspaceFile[]
  }
  skipped: RollbackSkippedEntry[]
  /**
   * 整棵跳过的「运行时依赖目录」（忽略规则 = 全仓唯一来源 EXCLUDED_DEP_DIR_NAMES，当前 node_modules）。
   * 与 skipped 分开：这是**预期的忽略**（不是降级），所以不计入 degraded，但必须留痕。
   */
  excludedDirs: RollbackSkippedEntry[]
  unreadableDirs: string[]
  unreadableFiles: RollbackSkippedEntry[]
  /**
   * `skipped` 桶的跳过事件**总数**（含超出 maxSkippedEntries 只计数的那部分）。
   * 不含 excludedDirs —— 那是预期内的忽略（如 node_modules），逐条记在 `excludedDirs` 里、
   * 不使该点降级。语义：逐条列表 + 本计数都必须实话实说，谁也不许静默。
   */
  skippedCount: number
  /** `skipped` 逐条列表到达记录上限（skippedCount 仍然如实） */
  skippedTruncated: boolean
  /**
   * 用户忽略规则整棵跳过的**目录**（与 excludedDirs 分开：内置 node_modules 是预期内的忽略，
   * 用户忽略的目录则意味着「其下有什么我们不知道」⇒ 见 ignoreIncomplete）。
   */
  ignoredDirs: RollbackSkippedEntry[]
  /** ignoredDirs 的**总数**（逐条列表可截断，计数仍如实） */
  ignoredDirCount: number
  /**
   * true = 有整个目录被用户忽略 ⇒ 走查证明名单**不完整** ⇒ 删除集整体拒绝（fail-closed）。
   * 文件级忽略**不**置它：被忽略的文件既进 skipped、也进 walked（路径索引来源）⇒ 名单照样完整。
   */
  ignoreIncomplete?: boolean
  /**
   * true = 走查被**时间预算 / 取消信号**中断 ⇒ 剩余子树**一条都没进任何名单**
   * （不在 files / skipped / walked 里）⇒ 证明名单**不完整** ⇒ 删除集整体拒绝（fail-closed）。
   *
   * 与 `truncated` 的**关键区别**：`truncated` 的三种成因（文件数 / 总字节 / 单文件超限）都是
   * 「继续遍历 + 逐条留痕」，名单依然完整，所以**不**拒删；只有「整棵子树根本没被走查」才必须拒删
   * —— 否则那些文件会被判成「留点后才新建」而被删掉（数据丢失）。
   * 老台账（本字段诞生前写下的点）一律没有它：按「名单完整」处理（与旧行为一致）。
   */
  walkIncomplete?: boolean
  /**
   * 走查被中断时**栈里还没进去的子树**（精确到目录）。有它 ⇒ 拒删只覆盖这些子树
   * （分子树 fail-closed），而不是把整个工作区的删除全关掉；缺它（老台账 / 栈太深被截断）
   * ⇒ 退回全局拒删。与 walkIncomplete 一起看：后者是「安全判据」，本字段是「精确范围」。
   */
  unwalkedDirs?: string[]
  /** 命中文件数 / 字节上限（内容未全部进来，已如实留痕） */
  truncated: boolean
  bytes: number
  /**
   * 捕获时走查过的**全部**文件路径（gzip 对象）。只在 `skippedTruncated === true`（逐条跳过名单被
   * 记录上限截断）时才有值：
   *  · 有值 ⇒ 删除候选可以证明「当前存在但不在任何名单里」= 留点之后新建的；
   *  · null 且 `skippedTruncated` ⇒ **证明不了** ⇒ 回退一条都不删（fail-closed，如实报告）；
   *  · null 且未截断 ⇒ 不需要它（`files ∪ skipped` 已经是完整名单）。
   * 老台账（本字段诞生前写下的点）一律没有它 —— 与「索引丢失」同一条 fail-closed 路径。
   */
  pathIndex?: RollbackPathIndex | null
}

export interface RollbackSessionPayload {
  sessionId: string | null
  /** 会话日志绝对路径（宿主能给就给；缺失 = null —— 本引擎不做字节写回，路径只作审计） */
  logPath: string | null
  /** 会话游标（**事件数** = session.seq）：fork 的语义位置 */
  cursorSeq: number | null
  /** 会话日志字节数（能 stat 到才有；审计证据） */
  cursorBytes: number | null
  mtimeMs: number | null
  /** content = 内容 SHA-256；size = 只认字节数（超上限）；cursor = 只有事件游标 */
  fingerprintKind: 'content' | 'size' | 'cursor'
  fingerprint: string
  /** 内容副本的对象仓键；null = 没有副本（回退不依赖它，fork 走 sessionId + boundarySeq） */
  object: string | null
  bytes: number
  /** 目标回合（1 基）；未知 = null */
  turnSeq: number | null
  /** 目标回合开始前最后一个事件 seq（fork 的 inclusive 稳定边界）；null = 无前置边界 */
  boundarySeq: number | null
  /** 目标回合 turn/end 事件的 seq（inclusive）；未知 = null */
  boundaryEndSeq: number | null
}

export interface RollbackTrack<TPayload> {
  kind: RollbackStateKind
  /** 捕获时刻（单调非回退） */
  capturedAt: number
  ok: boolean
  /** 捕获成功但**不完整**（截断 / 链接跳过 / 内容副本缺失）—— 不静默 */
  degraded: boolean
  /** 该态的内容指纹；null = 没有可指纹的内容 */
  fingerprint: string | null
  reasonCode: RollbackCode | null
  reasonDetail: string | null
  payload: TPayload | null
}

export interface RollbackPointRecord {
  schemaVersion: number
  id: string
  kind: RollbackPointKind
  createdAt: number
  /** 两态 capturedAt 的跨度（诚实事实；两态之间没有「同点」判定） */
  spreadMs: number
  /** 用户显式保护：不可回退、不可删除、不被自动清理 */
  protected: boolean
  /** 有态捕获失败的（回退缺省拒绝，需显式 allowPartial） */
  incomplete: boolean
  note: string | null
  /** 归属会话（自动留点必有；无会话信息 = null） */
  sessionId: string | null
  /** 会话单元键 <projectKey>/<sessionId>（界面展示 / 归属） */
  unitId: string | null
  /** 目标回合（1 基） */
  turnSeq: number | null
  /** 目标回合开始前最后一个事件 seq（fork 边界） */
  boundarySeq: number | null
  workspace: RollbackTrack<RollbackWorkspacePayload>
  session: RollbackTrack<RollbackSessionPayload>
}

export interface RollbackSegmentSummary {
  state: RollbackStateKind
  ok: boolean
  degraded: boolean
  capturedAt: number
  fingerprint: string | null
  reasonCode: RollbackCode | null
  /** 该态捕获的条目数（工作区文件数 / 会话 0|1） */
  entries: number
  bytes: number
  /** 会话态：事件游标；其它态 null */
  cursorBytes: number | null
  /** 该态是否**可回退**（工作区有可写回条目 / 会话有 sessionId + 边界） */
  restorable: boolean
  /** 跳过事件总数（工作区态：skipped + excludedDirs；会话态恒 0） */
  skippedCount: number
  /** 该态捕获是否被上限截断（工作区态 = payload.truncated） */
  truncated: boolean
}

export interface RollbackPointSummary {
  id: string
  createdAt: number
  sessionId: string | null
  unitId: string | null
  /** 1 基回合号；无法判定 = null */
  turn: number | null
  /** fork 的 inclusive 边界 seq；null = 无前置边界 */
  boundarySeq: number | null
  kind: RollbackPointKind
  protected: boolean
  incomplete: boolean
  note: string | null
  spreadMs: number
  /** 恒为 [workspace, session] 两项 */
  segments: RollbackSegmentSummary[]
  /**
   * **继承视图**标记（t9）：该条目属于 fork 子会话，但状态/边界都来自这个祖先点 id。
   * 同一个 `id` ⇒ `preview` / `rewind` / `remove` 全部作用在**原点**上，
   * 回退仍在原会话上做 fork（语义与今天逐字相同）；台账里**没有**这条记录（零幽灵点）。
   */
  inheritedFrom?: string
  /** 继承视图里「状态真正的归属会话」（= 祖先会话 id；与 `inheritedFrom` 成对出现） */
  inheritedSessionId?: string | null
}

/**
 * 台账（records/ + payloads/）的可观测快照。
 * 路由层转发给界面时必须**照抄字段名与形状**（issue #89 的交付契约）。
 */
export interface RollbackLedgerStatus {
  /** 清单里的记录条数 */
  records: number
  /** records/ + payloads/ 当前总字节 */
  bytes: number
  /** 生效的字节预算（缺省 ROLLBACK_DEFAULT_LEDGER_BYTES） */
  budgetBytes: number
  /** 本进程内被**预算**淘汰的自动点累计数（条数淘汰不计入） */
  evicted: number
  /**
   * 当前磁盘字节**已超**预算、且已无处可淘汰（典型：单条点本身就大于预算）。
   * 界面据此说「台账已超预算、无法再自动回收」，绝不静默成「一切正常」。
   */
  overBudget: boolean
}

export interface RollbackStorageStatus {
  available: boolean
  root: string
  detail?: string
  guidance: RollbackGuidance[]
  requirements: readonly string[]
  /** 新增，可选（不破坏既有构造点）；存储栈不可用时缺省 */
  ledger?: RollbackLedgerStatus
}

/** 捕获一个回滚点的输入（宿主/测试构造；无 HTTP capture 端点） */
export interface RollbackPointInput {
  kind?: RollbackPointKind
  sessionId?: string | null
  unitId?: string | null
  sessionLogPath?: string | null
  /** 会话事件游标（session.seq） */
  cursorSeq?: number | null
  /** 目标回合（1 基） */
  turnSeq?: number | null
  /** 目标回合开始前最后一个事件 seq */
  boundarySeq?: number | null
  /** 目标回合 turn/end 的 seq */
  boundaryEndSeq?: number | null
  /** 工作区显式路径分块（绝对路径） */
  chunks?: readonly string[]
  note?: string | null
  protect?: boolean
  /**
   * 调用方的取消信号（插件卸载 / 会话销毁）：已中止时捕获在**下一个文件边界**停下，
   * 已收条目照常成点（部分点 + truncated）。缺省不传 = 只受时间预算约束。
   */
  signal?: AbortSignal
}

export interface RollbackCaptureResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  point?: RollbackPointRecord
  guidance: RollbackGuidance[]
  storage: RollbackStorageStatus
}

/** 会话 fork seam（宿主注入；core 不 import @deepseek-ai/*） */
export interface RollbackForkInput {
  sessionId: string
  /** inclusive 边界 seq */
  boundarySeq: number
}
export type RollbackForkOutcome =
  /**
   * 成功 fork。`warning` 非空 = 子会话**没能挂回原工作区**（宿主侧三档匹配全落空），
   * 它会出现在侧栏「未分组」—— 回退本身仍然成功，但必须如实告诉用户（绝不假装已归位）。
   */
  | { ok: true; childSessionId: string; warning?: string }
  | { ok: false; code: RollbackCode; detail?: string }
export type RollbackForkSeam = (input: RollbackForkInput) => Promise<RollbackForkOutcome>
/** 宿主侧的 fork 载体（DshSessionStoreFacade 结构性实现；路由侧只做窄化读取） */
export interface RollbackForkCarrier {
  forkSession?: (sessionId: string, boundarySeq: number) => Promise<{ childSessionId: string; warning?: string } | { error: string }>
}

/** 预览里「回退会改动的一个文件」的动作。 */
export type RollbackPreviewFileStatus = 'overwrite' | 'create' | 'delete'

/**
 * E1：逐文件的行级统计（简洁版预览弹窗的数据源）。
 * **只列真的会被改动的文件** —— 已与快照一致的条目一个都不列（353 项里 0 项不同 ⇒ 空数组）。
 */
export interface RollbackPreviewFile {
  path: string
  /**
   * overwrite = 覆盖已有文件；create = 当前不存在（回退会重新创建）。
   *
   * `delete` **不由 `files[]` 产出**：整文件删除是**另一条**清单 —— 该点**未记录**的路径
   * （`RollbackPreviewWorkspace.removals` = 会被删的，`createdSkipped` = 按安全判据拒删的）。
   * 那些路径**不在**这个点的记录里，所以既不进这份逐文件行级统计，也读不出前后对照。
   * 保留该取值只为契约形状向前兼容。
   */
  status: RollbackPreviewFileStatus
  /** 回退会让该文件**新增**的行数；null = 本次不给数字（见 truncated） */
  added: number | null
  /** 回退会从该文件**删除**的行数；null = 本次不给数字（见 truncated） */
  removed: number | null
  /**
   * true = 本次没有可信行数（added/removed 均为 null）：任一侧超过单文件上限、单张预览累计上限、
   * 行级比对步数上限，或内容不是文本，或对象仓读不出，或**当前文件 stat 失败但不是 ENOENT**
   * （存在性未知 —— 这种条目 status 仍给 'overwrite'，绝不谎报成 create）。
   * **宁可说「不知道」，也绝不谎报行数。**
   */
  truncated: boolean
  /**
   * true = 该文件在留点**之后**是**别的会话**写的（写入归属台账证明；见 core/rollback-attribution.ts）。
   * 界面据此默认不勾选它（用户仍可勾上）。缺字段 / false = **没有归属证据**，
   * 而不是「本会话写的」——「未判定」与「确知是本会话」必须分开。
   */
  foreign?: boolean
  /** 那些「别的会话」的会话 id（仅当 foreign 为 true） */
  foreignSessionId?: string
  /** 那次写入的时间（毫秒；仅当 foreign 为 true） */
  foreignAt?: number
  /**
   * true = 这次回退**不会改动它**：要么与其它对话的改动冲突、要么无法安全合并（缺共同祖先 / 二进制 /
   * 差异被降级 / 对方删了它）。行级统计一律为 null —— 「不改动」不是「0 行变化」。
   */
  skipped?: boolean
  /** 不改动的机器原因（界面映射成字典键，绝不裸渲染） */
  mergeReason?: string
}

/** 单文件差异里一侧（当前磁盘 / 回退点快照）的展示信息。 */
export interface RollbackFileDiffSide {
  /** 该侧当前存在吗（快照侧 false = 对象仓里那份读不出来，**不是**「空文件」） */
  exists: boolean
  bytes: number
  /** 行数；null = 未读取（二进制 / 超限 / 不可读）—— 只有真读到文本才有数字 */
  lines: number | null
  binary: boolean
  oversized: boolean
  unreadable: boolean
}

/**
 * 单文件差异**无法逐行对比**的原因。有值时 hunks 恒为空数组 ——
 * 「不知道」与「没有差异」是两件事，界面必须分开说。
 */
export type RollbackFileDiffReason = 'missing-blob' | 'binary' | 'too-large' | 'unreadable'

/**
 * fileDiff 的返回：**一个记录在案的文件**的前后逐行对照。
 *
 * 方向（与预览行数统计同一口径，别读反）：before = **当前磁盘**，after = **回退点快照**
 * —— 也就是「点下回退之后该文件会变成的样子」。界面左右双栏与之一致。
 */
export interface RollbackFileDiffResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  id: string
  /** 记录里的绝对路径（收窄后 = 请求路径逐字命中记录的那一条） */
  path: string
  status: RollbackPreviewFileStatus
  before: RollbackFileDiffSide
  after: RollbackFileDiffSide
  hunks: DiffHunk[]
  added: number
  removed: number
  identical: boolean
  /** 规模超限 → 结果仍是完整替换，只是不是最小编辑脚本 */
  degraded: boolean
  /** 无法逐行对比的原因（有值时 hunks 为空） */
  reason?: RollbackFileDiffReason
  /** true = 「回退后」一侧显示的是**三方合并**的结果，而不是记录里的原文 */
  merged?: boolean
  /**
   * true = 这次回退**不会改动**它（与其它对话的改动冲突 / 无法安全合并）—— 此时 after 与 before 相同。
   * 界面必须把「不会改动」与「0 行变化」分开说。
   */
  mergeSkipped?: boolean
  /** 不改动的机器原因（界面映射成字典键，绝不裸渲染） */
  mergeReason?: string
  limits: typeof ROLLBACK_FILE_DIFF_LIMITS
}

export interface RollbackPreviewWorkspace {
  /** 记录在案、会被覆盖的条目数 */
  overwrite: number
  /** 与当前内容不同、确实会被改动 */
  different: number
  /** 记录里的文件当前已不存在（恢复会重新创建） */
  missing: number
  /**
   * 该点**未记录**的条目总数（含留点时被跳过的既有文件）。**不是**「之后新建」，
   * 也**不是**「会被删除」—— 会被删的是 {@link removals}。
   */
  createdAfter: number
  /** E1：逐文件行级统计；**只含会被改动的文件**（内容已一致的一个都不列） */
  files: RollbackPreviewFile[]
  /**
   * **能证明「留点之后新建」**的路径（含被拒删的；逐条清单上限 `ROLLBACK_LEFTOVER_LIST_LIMIT`）。
   * 判据 = 当前存在、在分块内、且不在证明名单（`files` ∪ `skipped` ∪ `unreadableFiles` ∪
   * `excludedDirs` ∪ 路径索引）里 —— 留点时被预算挡下的既有文件同样在名单里，**不算**新建。
   * **不是删除清单**：删除清单是 {@link removals}（逐条过了同一套安全判据）。
   */
  leftovers: string[]
  leftoversTruncated: boolean
  /**
   * **会被删除**的路径（= 该点未记录 **且**通过安全判据）—— **全量**（不切上限）：
   * 界面直接把这份清单渲染成「删除」行，所以它逐条等于实际会删的。
   *
   * 与 rewind 执行阶段**共用同一个函数**（`planCreatedRemovals`）⇒ 「预览说会删的」与
   * 「实际删的」逐条一致（旧实现两处各算一次：预览用未过滤的 leftovers、执行用过滤后的
   * 全量清单，于是预览里混进永不删除的 .git 路径、又会漏掉第 21 条之后的会删路径）。
   */
  removals: string[]
  /** 会被删除的条数（= {@link removals}.length；两者同源，恒相等） */
  removalsCount: number
  /** 遍历被文件数上限截断 ⇒ 清单可能不完整（实践中蕴含捕获也截断 ⇒ 删除已整体拒绝、清单为空） */
  removalsTruncated: boolean
  /**
   * 按安全判据**拒删**的路径（逐条清单有界，总数见 {@link createdSkippedCount}）：
   * `.git`/`node_modules` 段、插件数据区、分块外、非绝对路径、单文件超上限，
   * 以及**证明名单不完整**时全部候选（见 {@link createdRefusedReason}）。
   */
  createdSkipped: string[]
  createdSkippedCount: number
  createdSkippedTruncated: boolean
  /**
   * 非 null = **证明名单不完整** ⇒「未记录」不能证明「新建」，故**一条都不删**。
   * 只有两种成因：跳过名单被记录上限截断而路径索引缺失/读不出、有读不出的目录
   * （**不是**「预算截断」—— 那正是 2026-10-12 修掉的那一条假判据）。
   */
  createdRefusedReason: 'capture-incomplete' | null
  chunks: string[]
  available: boolean
  reasonCode: RollbackCode | null
  /**
   * `skipped` 桶的跳过事件**总数**（含超出记录上限只计数的那部分）。
   *
   * **不含** `excludedDirs`（内置运行时依赖目录等**预期内的忽略**：逐条记在 `excludedDirs` 里，
   * 另有自己的列表、不使该点降级）与 `ignoredDirs`（用户忽略规则整棵跳过的目录，总数见
   * `ignoredDirCount`）。与引擎内部的 `ChunkWalkSink.skippedCount` 同一口径 ——
   * `recordSkip` 只对 `skipped` 桶 +1。上限截断只影响逐条列表，不影响本计数。
   */
  skippedCount: number
  /** 捕获是否被上限截断（超单文件上限 / 字节预算 / 文件数预算任一命中即为 true） */
  truncated: boolean
  /**
   * **冲突**：两侧改到同一处（含同一插入点）⇒ 回退会**跳过**该文件（零写入）。
   * 与执行阶段的 `conflictCount` 同一判据（调用同一份 `mergeForeignRecord`）⇒「预览说有冲突的」=「执行时真的跳过」。
   */
  conflictCount: number
  /** 冲突路径逐条清单（上限 {@link ROLLBACK_LEFTOVER_LIST_LIMIT}） */
  conflictPaths: string[]
  /**
   * **无法安全撤销**而会被跳过的文件总数（冲突之外的成因：没有共同祖先 / 二进制 / 差异被降级 /
   * 对方把它改成了不存在 / 读不出）。预览把它们**列出来**而不是静默略过 —— 逐条原因在
   * {@link files} 的 `mergeReason` 上。
   */
  unavailableCount: number
  /**
   * **落点无人认领**而会被跳过的文件总数（时间窗归属判定：文件在目标会话静默之后被改过，
   * 且当时没有任何会话处于活跃窗口 —— 手改 / 外部工具 / 另一个进程）。
   * 成因逐条在 {@link files} 的 `mergeReason`（`external-edits`）上。
   */
  externalCount: number
}

export interface RollbackPreviewSession {
  /** fork 的 inclusive 边界 seq（目标回合开始前最后一个事件）；null = 无边界 */
  from: number | null
  /** 目标回合 turn/end 的 seq；null = 未知 */
  to: number | null
  /** 目标回合号（1 基） */
  turns: number | null
  cursorSeq: number | null
  cursorNowBytes: number | null
  cursorTargetBytes: number | null
  restorable: boolean
  /** 会话日志刚被写过（仅供参考：fork 只读，不会覆盖日志） */
  active: boolean
  reasonCode: RollbackCode | null
}

export interface RollbackPreviewResult {
  ok: boolean
  code: RollbackCode
  detail?: string
  id: string
  point?: RollbackPointSummary
  workspace: RollbackPreviewWorkspace
  session: RollbackPreviewSession
  /**
   * 能否作为**回退目标**（t22 冻结口径）：`!protected && !incomplete && 至少一个段可恢复`。
   * **不**包含 `kind !== 'guard'` —— 救援点正是「回到回退前」的唯一路径，必须可回退。
   * 与 rewind() 的准入判定**逐条一致**（preview 说能恢复，rewind 就必须真能成功）。
   */
  canRestore: boolean
  /**
   * 能否**删除**：`!protected && kind !== 'guard'`。
   * 与 canRestore **互相独立**（t22）：guard 用户删不掉（自动淘汰见 ROLLBACK_MAX_GUARDS_PER_SESSION），
   * 但它照样可以回退 —— 把「不可删除」当成「不可恢复」是曾经的缺陷。
   */
  canRemove: boolean
  storage: RollbackStorageStatus
  guidance: RollbackGuidance[]
  warnings: RollbackGuidance[]
}

export interface RollbackListResult {
  ok: boolean
  storage: RollbackStorageStatus
  points: RollbackPointSummary[]
  maxRecords: number
  maxRecordsPerSession: number
  /** **全局** guard 救援点上限（S6 第二道 guard 预算，见 ROLLBACK_MAX_GUARDS） */
  maxGuards: number
  /**
   * **继承链**（fork 子会话 id → 父会话 id；只登记「历史被继承」的 fork 子会话，t9）。
   *
   * 客户端据此在「本会话/本回合未命中」时沿链只上溯找祖先的同回合点（环保护 + 深度上限在客户端）。
   * 缺省 = 本次没算出来（未知，不是「没有」）—— 客户端此时保持今天的口径，绝不猜。
   */
  inheritLinks?: Record<string, string>
  /** 继承链是否**完整**（false = 扫描被预算截断 ⇒ 未命中不得当成「确知没有」） */
  inheritLinksComplete?: boolean
  /** 继承视图条目是否被上限截断（`points` 里补的继承条目） */
  inheritedViewTruncated?: boolean
  error?: string
}

export interface RollbackRemoveResult {
  ok: boolean
  code: RollbackCode
  id: string
  detail?: string
}

export interface RollbackSegmentResult {
  state: RollbackStateKind
  status: RollbackSegmentStatus
  reasonCode?: RollbackCode
  /** 逐条事实（技术细节，非用户可见文案） */
  detail: string[]
  restored: number
  failed: number
  /**
   * 能证明「留点之后新建」的路径（逐条清单有界；含被拒删的）。缺省只报告；
   * 开 `removeCreated` 时其中通过安全判据的会被删 —— 那一份是 `removedPaths`，**不是**本字段。
   */
  leftovers: string[]
  leftoversTruncated: boolean
  /** 本次真的**删除**的「该点未记录」路径数（用户 2026-10-11 定案 A） */
  removed?: number
  /**
   * 已删除路径（**全量**；与预览的 `workspace.removals` 同源同序 —— 两份清单逐条相等，
   * 界面因此可以把「预览说会删的」当成「实际删的」）。
   */
  removedPaths?: string[]
  /**
   * 按安全判据**拒删**的路径（越界 / 落在插件数据区 / `.git` / `node_modules` / 单文件过大；
   * 证明名单不完整时是**全部候选**）。逐条清单有界，总数见 `createdSkippedCount`。
   */
  createdSkipped?: string[]
  /** 拒删路径的**真实总数**（不受逐条清单上限影响） */
  createdSkippedCount?: number
  /** 拒删逐条清单不完整（条数超上限 / 遍历被截断） */
  createdSkippedTruncated?: boolean
  /**
   * 非 null = 该点捕获**不完整** ⇒ 一条都没删（安全拒删，绝不误删既有文件）；
   * 与 preview.workspace.createdRefusedReason 同一判据。
   */
  createdRefusedReason?: 'capture-incomplete'
  writtenBytes?: number
  /**
   * 因路径选择（onlyPaths）而未恢复 / 未删除的条目数。
   * 与 createdSkipped（安全拒删）**分开**：这里的原因是用户自己没勾它，不是安全判据挡下。
   */
  selectionSkipped?: number
  /**
   * 因**归属隔离**（2026-10-17 定案 B）而跳过的记录条目数：该文件在留点之后是**别的会话**写的。
   * 只在**没有显式点名**（`onlyPaths` 缺省）时生效；显式点名 = 用户明确要它，归属不再拦。
   */
  foreignSkipped?: number
  /**
   * **落点无人认领**而未写回的文件总数（时间窗归属判定：文件在目标会话静默之后被改过，
   * 而那一刻没有任何会话处于活跃窗口 ⇒ 手改 / 外部工具 / 另一个 DSH 进程）。
   * 与 conflictCount / unavailableCount 一样是「故意没退」，绝不能并进「0 变更」。
   */
  externalCount?: number
  /** 无人认领而未写回的路径逐条清单（上限 {@link ROLLBACK_LEFTOVER_LIST_LIMIT}） */
  externalPaths?: string[]
  /** 三方合并成功、写回「撤销本会话 + 保留对方改动」的条目数（有界清单同给） */
  mergedCount?: number
  mergedPaths?: string[]
  /** 冲突：两侧改到同一处 ⇒ **未写**，交给用户处理 */
  conflictCount?: number
  conflictPaths?: string[]
  /** 无法安全撤销（无中间版本 / 二进制 / 差异被降级 / 对方改成了不存在）⇒ **未写** */
  unavailableCount?: number
  unavailablePaths?: string[]
  /** 写入前发现又被改过（并发）⇒ **未写** */
  concurrentCount?: number
  concurrentPaths?: string[]
  /** 会话段：fork 出来的子会话 id */
  childSessionId?: string
  guidance?: RollbackGuidance[]
}

export interface RollbackRewindInput {
  id: string
  /** fail-closed 确认门：必须**恰好** true */
  userConfirmed: boolean
  mode?: RollbackMode
  segments?: readonly RollbackStateKind[]
  allowPartial?: boolean
  guardPolicy?: RollbackGuardPolicy
  /**
   * 是否**删除**「回退点之后新建」的路径（用户 2026-10-11 定案 A：回退要连文件一起退回去）。
   *
   * 缺省 false = 老口径（只报告 leftovers）。开启后：先读前像 → 删 → 任一失败就**整体回滚**
   * （把已写回的文件还原、把已删的文件写回）。拒删判据见 createdRemovalRefusal。
   */
  removeCreated?: boolean
  /**
   * **路径级选择性恢复**（2026-10-17 用户定案 A）：只恢复 / 只删除这些路径。
   *
   * 缺省（undefined）= 既有全量口径，行为一字不变。给了值就：
   *  · 记录在案的文件里**不在**清单中的：不写（计入 selectionSkipped）；
   *  · 「留点后新建」的候选里**不在**清单中的：不删（同样计入）。
   * 清单里出现**既未记录、也不在删除候选**里的路径 ⇒ **fail-closed 拒绝、零写入**（invalid-input）：
   * 绝不把「用户打错一个路径」变成「静默少恢复几个文件」。
   */
  onlyPaths?: readonly string[]
}

export interface RollbackRewindResult {
  ok: boolean
  outcome: RollbackOutcome
  code: RollbackCode
  detail?: string
  id: string
  segments: RollbackSegmentResult[]
  skippedSegments: RollbackStateKind[]
  /** S3：会话段的 fork 产物 */
  childSessionId?: string
  /** S5：恢复前自动救援点 */
  guardPointId?: string
  storage: RollbackStorageStatus
  guidance: RollbackGuidance[]
  warnings: RollbackGuidance[]
}

export type RollbackStorageProbe = () => Promise<{ ok: true } | { ok: false; detail: string }>

export interface RollbackEngineOptions {
  /** 插件数据目录（= $DSH_HOME/dsh-config-manager）；回滚点库在 dataDir/rollback-points */
  dataDir: string
  /**
   * 写入归属台账（2026-10-17 用户定案 B）。缺省 = 没有归属信息 ⇒ 预览不标 foreign，
   * 回退行为与旧版**逐字一致**（未判定绝不当作「别的会话写的」）。
   */
  attribution?: RollbackWriteAttributionPort
  /**
   * 会话活跃时间窗（2026-10-18 新增）。缺省 = 没有时间证据 ⇒ 归属判定退回归属台账那一条，
   * 回退行为与加它之前**逐字一致**（未判定绝不当作「别的会话写的」，也绝不凭空拦截）。
   */
  activity?: RollbackActivityPort
  /** DSH home（会话根 = homeDir/sessions） */
  homeDir: string
  now?: () => number
  maxFiles?: number
  maxBytes?: number
  /** 单文件上限（缺省 = maxBytes）：超限文件先 stat 判大小后跳过，绝不整份读进内存 */
  maxFileBytes?: number
  /** skipped / excludedDirs 的逐条记录上限（缺省 5000）；超出只计数 + 置 skippedTruncated */
  maxSkippedEntries?: number
  sessionMaxBytes?: number
  sessionQuiescentMs?: number
  maxRecords?: number
  maxRecordsPerSession?: number
  /** 每会话 guard 点上限（缺省 20，见 ROLLBACK_MAX_GUARDS_PER_SESSION） */
  maxGuardsPerSession?: number
  /** **全局** guard 点上限（缺省 50，见 ROLLBACK_MAX_GUARDS；与自动点的 maxRecords 无关） */
  maxGuards?: number
  /**
   * 台账字节预算（records/ + payloads/ 的总字节，缺省 ROLLBACK_DEFAULT_LEDGER_BYTES）。
   * 超预算时**只淘汰最旧的 auto 点**（guard / protected 不淘汰，沿用 selectPrune 的类别口径）。
   */
  ledgerBytesBudget?: number
  /**
   * 工作区捕获的挂钟时间预算（毫秒，缺省 ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS）。
   * 超时留**部分点**，不拒绝留点；见该常量的说明。
   *
   * 运行期**自适应**：被截断 ⇒ 下次翻倍；用得很少 ⇒ 下次减半（区间见
   * ROLLBACK_MIN/MAX_CAPTURE_BUDGET_MS）。回退期走查的预算见 rewindBudgetMs。
   */
  captureBudgetMs?: number
  /** 自适应区间下界（缺省 ROLLBACK_MIN_CAPTURE_BUDGET_MS；测试可注入更小值） */
  captureBudgetMinMs?: number
  /** 自适应区间上界（缺省 ROLLBACK_MAX_CAPTURE_BUDGET_MS；测试可注入更小值） */
  captureBudgetMaxMs?: number
  /** 回退期走查的时间预算（缺省 = captureBudgetMs 初值；**不参与自适应**） */
  rewindBudgetMs?: number
  /** 捕获期读 + 写并发上限（缺省 ROLLBACK_DEFAULT_CAPTURE_CONCURRENCY，1..64） */
  captureConcurrency?: number
  /**
   * 捕获期**在飞内容字节**上限（缺省 ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES = 32 MiB，
   * 有效范围 1..maxBytes）。与 `maxFileBytes`（单文件「要不要读」的判据）是两件事：
   * **这个才是并发的内存闸门**。
   */
  captureInFlightBytes?: number
  guardPolicy?: RollbackGuardPolicy
  /** 存储栈探针（缺省 = 真实磁盘探测）；注入失败探针可测「缺失时仍可挂载」 */
  storage?: RollbackStorageProbe
  /** 会话 fork seam（宿主注入 ctx.get('sessions').fork） */
  fork?: RollbackForkSeam
  /** 写回 seam（缺省 = atomicWriteFile + symlink:'reject'）；测试可注入以验证「校验失败整体回滚」 */
  writeFile?: (target: string, bytes: Uint8Array) => Promise<void>
  /**
   * 读文件 seam（缺省 = node:fs/promises readFile）：只用于**捕获期读内容**这一步。
   * 测试用它计数「真的读了几次」，从而钉住路径身份缓存命中时**零重读**。
   */
  readFile?: (target: string) => Promise<Uint8Array>
  /**
   * 台账读盘观测 seam（缺省不观测）：每次「读一条记录文件 / 一份载荷文件」前回调一次。
   * 与 readFile seam 同一用途 —— 测试用它**确定性地**计数「一次留点到底读了几份记录」，
   * 而不是靠无法复现的堆采样（issue #89 的内存护栏）。
   */
  ledgerReadFile?: (file: string) => void
  /** E1：预览行级统计的规模上限（缺省见 ROLLBACK_PREVIEW_DIFF_*）；注入小值即可确定性地覆盖 truncated 分支 */
  previewDiffMaxFileBytes?: number
  previewDiffMaxTotalBytes?: number
  previewDiffMaxWork?: number
  previewDiffTotalWork?: number
  /** best-effort 日志（清理失败等；绝不抛给调用方） */
  log?: (line: string) => void
}

/* ------------------------------------------------------------ 纯函数/工具 */

function win32Fold(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * 路径里是否存在以 `.asar` 结尾的段（**捕获 / 走查期一律不碰这类路径**）。
 *
 * 为什么（真机事故，0.1.76）：Electron 宿主对任何含 `.asar` 段的路径**启用了 asar 虚拟化** ——
 * 即使那只是个普通文件，`fs.stat`/`readdir`/`read` 也会被接管去当容器解析。工作区里只要躺着一枚
 * **畸形** `.asar`（测试夹具、被打断的打包残留），宿主进程就会被原生层带走：crashpad
 * `not connected`、退出码 4294930435 ⇒ DSH Desktop 闪退（无 JS 栈、插件零错误）。
 * 实测（本仓真机捕获、同一份输入）：`.tmp` 下 19 枚 `.asar` 夹具在场 → Electron 进程死；
 * 全部改名后 → 同一趟捕获 9 s 跑完、退出码 0。
 * `.asar.unpacked` 是**真目录**（段名不以 `.asar` 结尾）⇒ 不拦。
 */
export function hasAsarSegment(target: string): boolean {
  for (const segment of target.split(/[\\/]+/)) {
    if (segment.length > '.asar'.length && win32Fold(segment).endsWith('.asar')) return true
  }
  return false
}

/** child 是否等于 parent 或位于其下（win32 折叠大小写；段边界判定） */
export function isInsidePath(child: string, parent: string): boolean {
  const c = win32Fold(path.resolve(child))
  const p = win32Fold(path.resolve(parent))
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** 路径比较键（win32 折叠大小写） */
function pathKey(value: string): string {
  return win32Fold(path.resolve(value))
}

/** 两个分块列表是否逐个相同（增量基准必须作用于同一批分块） */
function sameChunks(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * **存盘视图**：条目里的 `object` 恒等于 `sha256`（内容寻址的名字就是内容哈希）⇒ 落盘时不写这个字段，
 * 读取时按 `sha256` 补回（见 ledger 的 `withObjectRefs`）。每条约省 1/5 字节。
 */
function compactPayloadForStorage(payload: RollbackWorkspacePayload): RollbackWorkspacePayload {
  const strip = (list: RollbackWorkspaceFile[] | null | undefined): RollbackWorkspaceFile[] | null | undefined => {
    if (!Array.isArray(list)) return list
    return list.map((file) => {
      const copy: Record<string, unknown> = { ...file }
      delete copy['object']
      return copy as unknown as RollbackWorkspaceFile
    })
  }
  const delta = payload.delta
  return {
    ...payload,
    files: strip(payload.files) as RollbackWorkspaceFile[],
    ...(delta === undefined
      ? {}
      : { delta: { ...delta, ...(delta.added === undefined ? {} : { added: strip(delta.added) as RollbackWorkspaceFile[] }) } }),
  }
}

/**
 * 构造「相对基准的增量视图」；不划算（≥ 全量 × {@link ROLLBACK_DELTA_MAX_RATIO}）时返回 null。
 *
 * 条目**逐字比较**：路径、sha、字节数、mtimeMs、所属分块任一不同 ⇒ 进 `added`；基准里不再存在的路径进 `removed`。
 * 重建 = 基准 − removed，再用 added 覆盖/追加，最后按路径排序（与全量捕获同序）。
 */
/** 基准摘要键：内容 + 字节数 + 所属分块（`mtimeMs` 不参与 —— 只被触摸、内容没变的文件不必进增量） */
function digestKeyOf(file: RollbackWorkspaceFile): string {
  return String(file.sha256) + ':' + String(file.bytes) + ':' + String(file.chunk)
}

/** 相对**内存基准摘要**的条目差异（新增/改写 / 不再存在）；路径逐字比较，不读任何文件 */
function payloadDiffAgainstDigest(
  payload: RollbackWorkspacePayload,
  baseEntries: ReadonlyMap<string, string>,
): { added: RollbackWorkspaceFile[]; removed: string[] } {
  const added: RollbackWorkspaceFile[] = []
  const nextPaths = new Set<string>()
  for (const file of payload.files) {
    nextPaths.add(file.path)
    const prev = baseEntries.get(file.path)
    if (prev === undefined || prev !== digestKeyOf(file)) added.push(file)
  }
  const removed: string[] = []
  for (const path of baseEntries.keys()) if (!nextPaths.has(path)) removed.push(path)
  return { added, removed }
}


/**
 * 构造「相对基准的增量视图」；不划算（≥ 全量 × {@link ROLLBACK_DELTA_MAX_RATIO}）时返回 null。
 * 重建 = 基准 − removed，再用 added 覆盖/追加，最后按路径排序（与全量捕获同序）。
 */
function buildPayloadDelta(
  payload: RollbackWorkspacePayload,
  baseHash: string,
  baseChain: readonly string[],
  diff: { added: RollbackWorkspaceFile[]; removed: string[] },
): RollbackWorkspacePayload | null {
  if (baseHash === '') return null
  const delta: RollbackWorkspacePayload = {
    ...payload,
    // **故意不是数组**：不认识 `delta` 的旧读取器会在形状校验这一步**拒绝这个点**（fail-closed），
    // 而不是把「增量那几条」当成完整清单去规划删除 —— 那会把留点时存在的文件全判成新建、全部删掉。
    files: null as unknown as RollbackWorkspaceFile[],
    delta: { base: baseHash, baseChain: [...baseChain], removed: diff.removed, added: diff.added },
  }
  if (JSON.stringify(delta).length >= JSON.stringify(payload).length * ROLLBACK_DELTA_MAX_RATIO) return null
  return delta
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code + ': ' + error.message
    return error.message
  }
  return String(error)
}

function pushDetail(list: string[], line: string): void {
  if (list.length < ROLLBACK_DETAIL_LIMIT) list.push(line)
}

/* ------------------------------------------------ E1：行级统计（纯函数） */

const DIFF_TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })

/** 二进制判据：前 8 KiB 出现 NUL 字节 → 不是文本，「行数」没有意义（**不猜、不谎报**）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 8192)
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true
  }
  return false
}

/**
 * 行切分口径（**空文件边界的唯一事实源**）：
 * - 0 字节 = 0 行；
 * - `'\n'` = 1 行（一个空行）；
 * - 末尾换行不产生多余的一行（`'a\nb\n'` 与 `'a\nb'` 都是 2 行）；
 * - CRLF / CR / LF 都算行分隔符 ⇒「只有换行风格不同」不会被谎报成行增减。
 */
function splitDiffLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/)
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Myers 最短编辑脚本长度 D（O((N+M)·D) 步）。**只在需要长度时**如此实现：
 * 典型编辑（局部小改）D 很小 ⇒ 快；整篇改写时步数会爆炸 ⇒ 由 `limit` 截断并如实返回未完成。
 * `used` 是真实消耗的步数（中止时也要把预算扣掉，避免总预算被绕过）。
 */
function cappedEditDistance(
  a: readonly string[],
  b: readonly string[],
  limit: number,
): { ok: true; distance: number; used: number } | { ok: false; used: number } {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return { ok: true, distance: n + m, used: 0 }
  const max = n + m
  const offset = max
  const v = new Int32Array(2 * max + 1)
  let used = 0
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      used += 1
      if (used > limit) return { ok: false, used: used - 1 }
      const down = k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))
      let x = down ? (v[k + 1 + offset] ?? 0) : (v[k - 1 + offset] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        used += 1
        if (used > limit) return { ok: false, used: used - 1 }
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) return { ok: true, distance: d, used }
    }
  }
  return { ok: true, distance: max, used }
}

/**
 * 行级 diff 计数：把「before → after 的最短编辑脚本」拆成 added / removed。
 * 由 `added - removed = m - n` 与 `added + removed = D` 解出：
 *   added = (D + m - n) / 2、removed = (D - m + n) / 2（与 LCS 口径等价：added = after 独有行数）。
 *
 * 先折掉公共前后缀（典型编辑只动一小段 ⇒ 内存与步数都随之变小），再对中间段跑 Myers；
 * 步数超过 `maxWork` 或单张预览的总预算（`budget.work`）时返回 null ——
 * 调用方如实置 added/removed = null + truncated，**绝不用近似值糊过去**。
 */
function lineDiffCounts(
  before: readonly string[],
  after: readonly string[],
  maxWork: number,
  totalWork: number,
  budget: { work: number },
): { added: number; removed: number } | null {
  let head = 0
  const maxHead = Math.min(before.length, after.length)
  while (head < maxHead && before[head] === after[head]) head += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > head && endAfter > head && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  const n = endBefore - head
  const m = endAfter - head
  if (n === 0 || m === 0) return { added: m, removed: n }
  const limit = Math.min(maxWork, Math.max(0, totalWork - budget.work))
  const outcome = cappedEditDistance(before.slice(head, endBefore), after.slice(head, endAfter), limit)
  budget.work += outcome.used
  if (!outcome.ok) return null
  const d = outcome.distance
  return { added: (d + m - n) / 2, removed: (d - m + n) / 2 }
}

/**
 * T10：`preview` 里 `fs.stat` 失败的**唯一**分类口径。
 * **只有 ENOENT** 才表示「当前确实不存在」→ 回退会重新创建它（create + 快照行数）；
 * 其余一切（EACCES / EPERM / ELOOP / ENOTDIR / ERR_INVALID_ARG_VALUE / 拿不到 errno）
 * 都是「存在性与可读性**未知**」⇒ 绝不报成 create +N/-0，必须 status 照给 + added/removed=null + truncated=true。
 * 判据只看 errno **code**，不看 message（message 里出现 ENOENT 不算数）。
 */
export function classifyPreviewStatFailure(error: unknown): 'missing' | 'unavailable' {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return code === 'ENOENT' ? 'missing' : 'unavailable'
}

/** 「本次没有可信行数」的统一返回值（超限 / 非文本 / 对象读不出 / stat 失败但不是 ENOENT）。 */
function previewCountsUnavailable(): { added: number | null; removed: number | null; truncated: boolean } {
  return { added: null, removed: null, truncated: true }
}

function storageGuidance(root: string, detail: string): RollbackGuidance[] {
  return [
    { code: 'rollback.guidance.mountStorage', detail: ROLLBACK_STORAGE_REQUIREMENTS.join(' ') },
    { code: 'rollback.guidance.fixDataDir', detail: root },
    { code: 'rollback.guidance.readOnlyFallback' },
    { code: 'rollback.guidance.probeDetail', detail },
  ]
}

async function defaultStorageProbe(root: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await fs.mkdir(root, { recursive: true })
    // **F-3（t12 修复）**：probe 名必须逐次唯一 —— 同进程同毫秒的并发留点曾因文件名碰撞
    // 互相 rm/读失败，被判成 storage-unavailable(EPERM)（真机 4 路并发稳定失败 1 条）。
    const probe = path.join(root, '.dshcm-probe-' + String(process.pid) + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex'))
    await atomicWriteFile(probe, 'ok')
    await fs.readFile(probe, 'utf8')
    await fs.rm(probe, { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: errorDetail(error) }
  }
}

function newPointId(createdAt: number): string {
  return 'rb-' + createdAt.toString(36) + '-' + crypto.randomUUID().slice(0, 8)
}

/* ------------------------------------------------------- 回合边界的纯函数 */

/** 会话事件的最小形状（宿主把 session/event 的载荷窄化后喂进来；core 不认识 DSH 事件类型）。 */
export interface RollbackEventLike {
  seq: number
  type: string
  data?: unknown
}

export interface RollbackTurnBoundary {
  turn: number
  /** turn/start 的 seq */
  startSeq: number
  /** turn/end 的 seq；回合还没结束 = null */
  endSeq: number | null
  /**
   * **稳定边界** = 该回合开始前最后一个事件的 seq（startSeq − 1）。
   * startSeq === 0（本会话第一条事件就是 turn/start，首回合）→ null = 无前置边界。
   */
  boundarySeq: number | null
}

function turnOfData(data: unknown): number | null {
  if (!isRecord(data)) return null
  const turn = data['turn']
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null
}

/**
 * 从事件流里抽出回合边界（只认 turn/start 与 turn/end 的 seq；不解析日志字节）。
 */
export function turnBoundariesOf(events: readonly RollbackEventLike[]): RollbackTurnBoundary[] {
  const out: RollbackTurnBoundary[] = []
  for (const event of events) {
    if (!Number.isFinite(event.seq)) continue
    if (event.type === 'turn/start') {
      out.push({
        turn: turnOfData(event.data) ?? out.length + 1,
        startSeq: event.seq,
        endSeq: null,
        boundarySeq: event.seq > 0 ? event.seq - 1 : null,
      })
      continue
    }
    if (event.type === 'turn/end') {
      const turn = turnOfData(event.data)
      for (let i = out.length - 1; i >= 0; i -= 1) {
        const item = out[i]
        if (item === undefined) continue
        if (item.endSeq === null && (turn === null || item.turn === turn)) {
          item.endSeq = event.seq
          break
        }
      }
    }
  }
  return out
}

/**
 * 求「回退到第 turnSeq 回合末」所需的 fork 边界。
 * 首回合无前置边界（turn/start 在 seq 0）→ **结构化 no-boundary**（绝不猜一个不存在的 seq）。
 */
export function resolveTurnBoundary(
  events: readonly RollbackEventLike[],
  turnSeq: number,
): { ok: true; boundarySeq: number; endSeq: number | null } | { ok: false; code: 'no-boundary'; detail: string } {
  const boundary = turnBoundariesOf(events).find((item) => item.turn === turnSeq)
  if (boundary === undefined) {
    return { ok: false, code: 'no-boundary', detail: 'turn=' + String(turnSeq) + ' not-found' }
  }
  if (boundary.boundarySeq === null) {
    return { ok: false, code: 'no-boundary', detail: 'turn=' + String(turnSeq) + ' startSeq=0' }
  }
  return { ok: true, boundarySeq: boundary.boundarySeq, endSeq: boundary.endSeq }
}

/**
 * 记录在案的文件条目数：优先用载荷自带的 `fileCount`（增量视图下 `files` 可能只是子集），
 * 老载荷没有该字段才回落到 `files.length`。
 */
export function workspaceFileCount(payload: RollbackWorkspacePayload | null): number {
  if (payload === null) return 0
  if (typeof payload.fileCount === 'number' && Number.isFinite(payload.fileCount)) return payload.fileCount
  return payload.files.length
}

export function summarizeRollbackPoint(record: RollbackPointRecord): RollbackPointSummary {
  const workspace = record.workspace.payload
  const session = record.session.payload
  const segment = (
    state: RollbackStateKind,
    track: RollbackTrack<unknown>,
    entries: number,
    bytes: number,
    cursorBytes: number | null,
    restorable: boolean,
    skippedCount: number,
    truncated: boolean,
  ): RollbackSegmentSummary => ({
    state,
    ok: track.ok,
    degraded: track.degraded,
    capturedAt: track.capturedAt,
    fingerprint: track.fingerprint,
    reasonCode: track.reasonCode,
    entries,
    bytes,
    cursorBytes,
    restorable,
    skippedCount,
    truncated,
  })
  return {
    id: record.id,
    createdAt: record.createdAt,
    sessionId: record.sessionId,
    unitId: record.unitId,
    turn: record.turnSeq,
    boundarySeq: record.boundarySeq,
    kind: record.kind,
    protected: record.protected,
    incomplete: record.incomplete,
    note: record.note,
    spreadMs: record.spreadMs,
    segments: [
      segment(
        'workspace',
        record.workspace,
        workspaceFileCount(workspace),
        workspace?.bytes ?? 0,
        null,
        workspaceFileCount(workspace) > 0,
        workspace?.skippedCount ?? 0,
        workspace?.truncated ?? false,
      ),
      segment(
        'session',
        record.session,
        session === null ? 0 : 1,
        session?.bytes ?? 0,
        session?.cursorBytes ?? null,
        session !== null && session.sessionId !== null && session.boundarySeq !== null,
        0,
        false,
      ),
    ],
  }
}

/* ------------------------------------------------------------ 记录校验 */

function isTrack(value: unknown, kind: RollbackStateKind): boolean {
  if (!isRecord(value)) return false
  if (value['kind'] !== kind) return false
  if (typeof value['capturedAt'] !== 'number' || !Number.isFinite(value['capturedAt'])) return false
  if (typeof value['ok'] !== 'boolean') return false
  return true
}

/** 浅层形状校验：台账被篡改 / 半写时不把它当记录用（宁可当「读不到」）。 */
export function isRollbackPointRecord(value: unknown): value is RollbackPointRecord {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'] === '') return false
  if (typeof value['createdAt'] !== 'number' || !Number.isFinite(value['createdAt'])) return false
  if (value['kind'] !== 'auto' && value['kind'] !== 'guard') return false
  if (typeof value['spreadMs'] !== 'number') return false
  return isTrack(value['workspace'], 'workspace') && isTrack(value['session'], 'session')
}

/** mode → 要恢复的段（显式 segments 优先，路由层负责优先级） */
export function statesForMode(mode: RollbackMode | undefined): RollbackStateKind[] {
  if (mode === 'files') return ['workspace']
  if (mode === 'session') return ['session']
  return ['workspace', 'session']
}

/* ------------------------------------------------- 台账写序列化（F-1）

/**
 * 进程内台账写互斥：key = 台账文件**绝对路径**。
 *
 * 为什么必须有：同一 dataDir 下**同时存在多个引擎实例** —— 宿主自动留点器（src/index.ts 的
 * `ctx.on('session/event')` 那条链）持一个，recovery 路由**每个请求新建**一个；两者都对
 * index.json 做「读全文 → 改 → 原子写」。没有互斥就会丢更新（评审实测 20 轮并发
 * capture vs remove：12 轮「删除后点复活」、5 轮「新点丢失」；15 轮 capture vs rewind：
 * 2 轮「响应回了 guardPointId 但台账里已被覆盖」）。
 *
 * 覆盖范围（**所有**台账变更入口，只此一份序列化实现）：
 *   - `capturePoint` → `appendRecord`（合并 + S6 淘汰/prune + 原子写 + 对象回收）
 *   - `remove`（读 → 过滤 → 原子写 + 对象回收）
 *   - `rewind` 的 guard 救援点（内部走 `capturePoint` → `appendRecord`，同一条队列）
 * 读路径（list / read / preview）**不进队列**：纯读，最多读到稍旧的快照，不会破坏台账。
 *
 * 边界（**不可混淆**）：本队列只保证**单进程内**的读-改-写原子。跨进程（另一个 DSH 实例、
 * 离线 CLI）仍由路由层的 runWithMutationLock（EnvironmentLockManager，
 * `<dataDir>/locks/environment.lock`）负责 —— 进程内队列**不能**替代它：env 锁管「谁能写」，
 * 本队列管「进程内多个写者别互相踩」。两者都必须在。
 */
const ledgerWriteChain = new Map<string, Promise<void>>()

function withLedgerWriteLock<T>(ledgerPath: string, task: () => Promise<T>): Promise<T> {
  const previous = ledgerWriteChain.get(ledgerPath) ?? Promise.resolve()
  // 前一个写者失败不能阻断后一个（`then(task, task)` 两个分支都跑 task）
  const run = previous.then(task, task)
  // 队列尾巴只保留「完成信号」并吞掉异常：调用方拿到的仍是 run（异常照原样抛给它）
  const tail: Promise<void> = run.then(() => undefined, () => undefined)
  ledgerWriteChain.set(ledgerPath, tail)
  void tail.then(() => {
    if (ledgerWriteChain.get(ledgerPath) === tail) ledgerWriteChain.delete(ledgerPath)
  })
  return run
}

/* ------------------------------------------------------------------ 引擎 */

/** 目录遍历的留痕槽（跳过 / 整棵忽略 / 读不到）——绝不静默：任何被跳过的路径都必须出现在结果里。 */
interface ChunkWalkSink {
  skipped: RollbackSkippedEntry[]
  excludedDirs: RollbackSkippedEntry[]
  /** 用户忽略规则整棵跳过的目录（见 RollbackWorkspacePayload.ignoredDirs；逐条列表受记录上限截断） */
  ignoredDirs: RollbackSkippedEntry[]
  /** 被忽略目录的**真实总数**（恒增计数器；F-6：列表可截断、计数绝不跟着缩水） */
  ignoredDirCount: number
  unreadableDirs: string[]
  /** 跳过事件**总数**（含超出记录上限只计数的那部分） */
  skippedCount: number
  /** 逐条列表到达记录上限（skippedCount 仍如实计数） */
  skippedTruncated: boolean
}

/**
 * 一次「证明为留点之后新建的路径」的**完整规划**：预览与执行共用同一份（单一事实源）。
 * 逐条清单**不截断**（删除不能只删前 20 条）—— 展示层的上限只在渲染时切。
 */
interface CreatedRemovalPlan {
  /** **证明为留点之后新建**的全部路径（遍历顺序、全量；含被拒删的） */
  all: string[]
  /** 其中**会被删除**的（全量；安全判据 + 单文件上限都过了） */
  paths: string[]
  /** 其中**拒删**的（全量） */
  skipped: string[]
  /** 遍历被文件数上限截断（还有未列出的路径 —— 清单不完整） */
  truncated: boolean
  /**
   * 非 null = 该点捕获**不完整** ⇒ 一条都不删（{@link planCreatedRemovals} 的判据）；
   * 此时 `paths` 恒为空数组。
   */
  refused: 'capture-incomplete' | null
  /** 拒删成因的如实说明（点级告警；没有可解释成因时为空） */
  warnings: RollbackGuidance[]
}

interface RewindDraft {
  outcome: RollbackOutcome
  code: RollbackCode
  detail?: string
  id: string
  segments?: RollbackSegmentResult[]
  skippedSegments?: RollbackStateKind[]
  guardPointId?: string
  childSessionId?: string
  storage: RollbackStorageStatus
  guidance?: RollbackGuidance[]
  warnings?: RollbackGuidance[]
}

/**
 * 回退前像暂存器：**字节落盘、索引随栈**。
 *
 * 为什么不是内存数组（旧实现）：大工作区整体回退时前像峰值 = 待写总字节（可达数百 MB），
 * 与 issue #89 的 OOM 同族。落盘后内存只随**文件条数**增长。
 *
 * 生命周期：`stage()` 逐条写前像 → 成功则 `dispose()`；中途失败则 `rollback()` 写回再 `dispose()`。
 * 目录名带 pid，崩溃残留由 rollback-ledger 的 `cleanupOrphanTempFiles` 在下次启动回收。
 */
class UndoStager {
  private readonly dir: string
  private readonly journal: UndoJournalWriter

  constructor(dir: string, journal: UndoJournalWriter) {
    this.dir = dir
    this.journal = journal
  }

  /**
   * 记一条前像：`bytes === null` = 该路径当时**不存在**（回滚时删掉它）。
   *
   * `after` = 本条**回退动作会写成什么**（写入 = 内容 sha256；删除 = deleted）。它同时是崩溃恢复
   * 的安全判据：只有「当前内容仍等于 after 镜像」时重放才被允许（绝不覆盖后来又被改过的文件）。
   */
  async stage(target: string, bytes: Uint8Array | null, after: { sha256: string } | { deleted: true }): Promise<void> {
    await this.journal.record(target, bytes, after)
  }

  /**
   * 全部写入 / 删除都成功之后才调用：落 `done` 标记 ⇒ 这条前像不再算「中断的回退」。
   * 崩在它之前 = 启动期能认出「半回退现场」并按 after 镜像安全重放（见 interruptedRollbacks）。
   */
  async finish(): Promise<void> {
    await this.journal.finish()
  }

  /**
   * 逐条写回（**逆序**：同一路径被 stage 两次时，最后一次 stage 记的是最早状态，必须最后写）。
   * 返回失败清单 —— 回滚失败绝不静默。
   */
  async rollback(writer: (target: string, bytes: Uint8Array) => Promise<void>): Promise<string[]> {
    // 判据来源改成 **journal 本身**（不再是进程内的内存列表）：内存路径与崩溃后的磁盘路径共用
    // 同一份条目，不会各存一套、也不会各有一套口径。
    let entries: UndoJournalEntry[]
    try {
      const snapshot = await readUndoJournal(this.dir)
      entries = snapshot === null ? [] : snapshot.entries
    } catch (error) {
      // 前像读不出来 ⇒ **必须报失败**，绝不静默当成「没有要回滚的」
      return ['undo-journal-unreadable ' + errorDetail(error)]
    }
    const failed: string[] = []
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.bin === null) await fs.rm(entry.path, { force: true })
        else await writer(entry.path, await fs.readFile(path.join(this.dir, entry.bin)))
      } catch (error) {
        failed.push(entry.path + ' ' + errorDetail(error))
      }
    }
    return failed
  }

  /** 前像目录用完即清（best-effort：清理失败不该把回退报成失败）。 */
  async dispose(): Promise<void> {
    try {
      await fs.rm(this.dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 单文件字节闸门：保证「同时在飞（已读入、尚未落仓）的内容字节」≤ limit。
 *
 * 与 captureConcurrency 一起构成捕获期的内存上界：并发只放大**同时**驻留的量，而它被
 * `captureInFlightBytes` 钉死（缺省 32 MiB）。**不能**用 maxFileBytes 当限额 —— 它缺省 =
 * 总量预算 512 MiB，「一份文件」与「整个点的预算」不是同一个量级（0.1.74 闪退根因）。
 */
/**
 * 路径身份键：dev:ino:size:mtimeNs:ctimeNs:mode（全 BigInt 字符串化）。必须 BigInt：ino / mtimeNs /
 * ctimeNs 在 64 位 inode 文件系统上超出 Number 安全整数范围，用 Number 会静默丢精度（把两次不同的
 * 写当成同一个身份）。单一来源：fileStatOf 与 pathIdentityOf 都用它。
 */
function fileIdentityOf(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; mode: bigint }): string {
  return [
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeNs),
    String(stat.ctimeNs),
    String(stat.mode & 0o777n),
  ].join(':')
}

/** 预览的逐条判定（阶段 A 并发产出；阶段 B 按记录顺序装配，语义与旧串行实现逐条一致） */
type PreviewScanResult =
  | { kind: 'ok'; size: number; regular: boolean; unchanged: boolean }
  | { kind: 'missing' }
  | { kind: 'unavailable' }

class ByteGate {
  private used = 0
  private readonly waiters: (() => void)[] = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  async acquire(bytes: number): Promise<void> {
    const need = Math.max(0, Math.min(bytes, this.limit))
    while (this.used + need > this.limit && this.used > 0) {
      await new Promise<void>((resolve) => { this.waiters.push(resolve) })
    }
    this.used += need
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - Math.max(0, Math.min(bytes, this.limit)))
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

export class RollbackPointEngine {
  private readonly dataDir: string
  private readonly homeDir: string
  private readonly sessionsRoot: string
  private readonly root: string
  private readonly objectsDir: string
  private readonly ledgerPath: string
  private readonly nowFn: () => number
  private readonly maxFiles: number
  private readonly maxBytes: number
  private readonly maxFileBytes: number
  private readonly captureInFlightBytes: number
  private readonly maxSkippedEntries: number
  private readonly sessionMaxBytes: number
  private readonly sessionQuiescentMs: number
  private readonly maxRecords: number
  private readonly maxRecordsPerSession: number
  private readonly maxGuardsPerSession: number
  private readonly maxGuards: number
  private readonly guardPolicy: RollbackGuardPolicy
  private readonly probe: RollbackStorageProbe | undefined
  private readonly forkSeam: RollbackForkSeam | undefined
  private readonly writeSeam: ((target: string, bytes: Uint8Array) => Promise<void>) | undefined
  private readonly readSeam: ((target: string) => Promise<Uint8Array>) | undefined
  /** 路径身份缓存（首次用到时惰读；纯优化，任何异常都只回落全量读） */
  private pathCache: Map<string, RollbackPathCacheEntry> | null = null
  private readonly previewDiffMaxFileBytes: number
  private readonly previewDiffMaxTotalBytes: number
  private readonly previewDiffMaxWork: number
  private readonly previewDiffTotalWork: number
  private readonly log: ((line: string) => void) | undefined

  private lastStamp = 0

  /**
   * fork **继承链**（子会话 → 父会话，t9）。两个来源：
   *  ① 活会话登记（{@link noteSessionBinding}，本次运行里刚 fork 的立刻可用）；
   *  ② 台账所在项目键下的会话日志头扫描（{@link refreshForkLinks}，覆盖「已存在的坏子会话」）。
   */
  private readonly forkLinks = new Map<string, string>()
  private forkLinksAt = 0
  private forkLinksComplete = true
  /** 会话日志头缓存（mtime + size 失效；只服务 fork 链扫描） */
  /**
   * **本进程**最近一次成功留点的工作区摘要（清单增量化的基准）。
   *
   * 为什么是内存而不是读盘：一次留点只准读清单（L-08 / issue #89）—— 读上一份 12 MB 载荷去算差异
   * 正是那条被消灭的路。内存量 ≈ 每文件一个 `sha:bytes:chunk` 串（3.4 万文件约几 MB），
   * 与已有的身份缓存（`pathCache`）同量级；进程重启后第一次留点落全量锚点，随后继续链。
   */
  private deltaBase: RollbackDeltaDigest | null = null

  private readonly forkHeaderCache = new Map<string, { mtimeMs: number; size: number; header: SessionForkHeader | null }>()
  /** 继承判据用的台账快照（TTL 缓存；只缓存**清单条目**，绝不缓存完整记录） */
  private ledgerSnapshotCache: { at: number; entries: RollbackLedgerManifestEntry[] } | null = null
  /** 台账存储层（v3：清单 + 单条记录 + 内容寻址载荷；issue #89） */
  private readonly ledger: RollbackLedger
  /** 写入归属（2026-10-17 定案 B）。undefined = 没有归属信息 ⇒ 预览不标 foreign */
  private readonly attribution: RollbackWriteAttributionPort | undefined
  private readonly activity: RollbackActivityPort | undefined
  private readonly ledgerBytesBudget: number
  /**
   * 工作区捕获的挂钟时间预算（毫秒；见 ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS）。**可变**：
   * 每次留点后按「是否被截断 / 用掉多少」自适应（见 ROLLBACK_MIN/MAX_CAPTURE_BUDGET_MS）。
   */
  private captureBudgetMs: number
  /** 自适应区间下界 / 上界（构造期定死，运行期只调 captureBudgetMs） */
  private readonly captureBudgetMinMs: number
  private readonly captureBudgetMaxMs: number
  /** 回退期走查的时间预算（与捕获预算分开：自适应不该顺手拉长回退期的走查） */
  private readonly rewindBudgetMs: number
  /** 捕获期读 + 写并发上限 */
  private readonly captureConcurrency: number
  /** 对象仓目录已确认存在（省掉每个对象一次 mkdir） */
  private objectsDirReady = false
  /**
   * 本回合对象名单快照（一次 readdir 顶掉「每个候选一次 fs.access」；真机 34k 次 access ≈ 3.7 s）。
   * null = 读不到名单（首次还没建目录/异常）⇒ 回落逐条 objectExists。
   * 只保证「写进去的立刻可见」：捕获期间被**并发删除**的对象可能仍被判为存在 —— 那一路由
   * 读取侧（readObject + 哈希校验）响亮失败，不会静默给出错误的 before 内容。
   */
  private captureObjectNames: Set<string> | null = null
  /**
   * 启动期一次性初始化（流式迁移 v2 -> v3 + 孤儿 tmp 清理）的惰性单飞。
   * 为什么惰取而不是构造时同步跑：构造发生在每个请求路径上，同步扫盘/迁移会把请求卡死；
   * 而「每回合都扫一遍」正是要避免的浪费 —— 所以只跑一次并记住结果。
   */
  private initPromise: Promise<void> | null = null
  /** 启动期初始化失败的如实记录（读路径必须报出来，绝不假装台账是空的） */
  private initError: string | undefined

  constructor(options: RollbackEngineOptions) {
    this.dataDir = path.resolve(options.dataDir)
    this.homeDir = path.resolve(options.homeDir)
    this.sessionsRoot = path.join(this.homeDir, 'sessions')
    this.root = path.join(this.dataDir, ROLLBACK_POINTS_DIR_NAME)
    this.objectsDir = path.join(this.root, ROLLBACK_OBJECTS_DIR_NAME)
    this.ledgerPath = path.join(this.root, ROLLBACK_LEDGER_NAME)
    this.nowFn = options.now ?? (() => Date.now())
    this.maxFiles = options.maxFiles ?? ROLLBACK_DEFAULT_MAX_FILES
    this.maxBytes = options.maxBytes ?? ROLLBACK_DEFAULT_MAX_BYTES
    // 单文件上限缺省 = 总量预算（一个文件不可能比整个点的预算更大）
    this.maxFileBytes = options.maxFileBytes ?? this.maxBytes
    // **内存闸门与单文件上限分开**：拿 maxFileBytes 当闸门 = 允许把整个点的预算同时驻留
    // （0.1.74 真机闪退的根因），见 ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES。
    const inFlight = options.captureInFlightBytes ?? ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES
    this.captureInFlightBytes = Math.max(1, Math.min(this.maxBytes, Math.floor(inFlight)))
    this.maxSkippedEntries = options.maxSkippedEntries ?? ROLLBACK_SKIPPED_LIST_LIMIT
    this.sessionMaxBytes = options.sessionMaxBytes ?? ROLLBACK_DEFAULT_SESSION_MAX_BYTES
    this.sessionQuiescentMs = options.sessionQuiescentMs ?? ROLLBACK_DEFAULT_SESSION_QUIESCENT_MS
    this.maxRecords = options.maxRecords ?? ROLLBACK_MAX_RECORDS
    this.maxRecordsPerSession = options.maxRecordsPerSession ?? ROLLBACK_MAX_RECORDS_PER_SESSION
    this.maxGuardsPerSession = options.maxGuardsPerSession ?? ROLLBACK_MAX_GUARDS_PER_SESSION
    this.maxGuards = options.maxGuards ?? ROLLBACK_MAX_GUARDS
    this.guardPolicy = options.guardPolicy ?? 'warn'
    this.probe = options.storage
    this.attribution = options.attribution
    this.activity = options.activity
    this.forkSeam = options.fork
    this.writeSeam = options.writeFile
    this.readSeam = options.readFile
    this.previewDiffMaxFileBytes = options.previewDiffMaxFileBytes ?? ROLLBACK_PREVIEW_DIFF_MAX_FILE_BYTES
    this.previewDiffMaxTotalBytes = options.previewDiffMaxTotalBytes ?? ROLLBACK_PREVIEW_DIFF_MAX_TOTAL_BYTES
    this.previewDiffMaxWork = options.previewDiffMaxWork ?? ROLLBACK_PREVIEW_DIFF_MAX_WORK
    this.previewDiffTotalWork = options.previewDiffTotalWork ?? ROLLBACK_PREVIEW_DIFF_TOTAL_WORK
    this.log = options.log
    this.ledgerBytesBudget = options.ledgerBytesBudget ?? ROLLBACK_DEFAULT_LEDGER_BYTES
    this.captureBudgetMs = options.captureBudgetMs ?? ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS
    this.captureBudgetMinMs = options.captureBudgetMinMs ?? ROLLBACK_MIN_CAPTURE_BUDGET_MS
    this.captureBudgetMaxMs = options.captureBudgetMaxMs ?? ROLLBACK_MAX_CAPTURE_BUDGET_MS
    this.rewindBudgetMs = options.rewindBudgetMs ?? this.captureBudgetMs
    this.captureConcurrency = Math.max(1, Math.min(64, Math.floor(options.captureConcurrency ?? ROLLBACK_DEFAULT_CAPTURE_CONCURRENCY)))
    this.ledger = new RollbackLedger({
      root: this.root,
      bytesBudget: this.ledgerBytesBudget,
      // 摘要与记录校验的单一事实源都在本模块：注入而不是反向 import，避免运行期循环依赖
      summarize: summarizeRollbackPoint,
      isLedgerRecord: isRollbackPointRecord,
      now: () => this.stamp(),
      log: (line) => this.warn(line),
      onFileRead: options.ledgerReadFile,
    })
  }

  /** 回滚点库根目录（只读侦察用；写路径全部经本类的门） */
  get storeDir(): string {
    return this.root
  }

  get sessionsRootDir(): string {
    return this.sessionsRoot
  }

  private stamp(): number {
    const raw = this.nowFn()
    const value = Number.isFinite(raw) && raw > this.lastStamp ? raw : this.lastStamp
    this.lastStamp = value
    return value
  }

  private warn(line: string): void {
    try { this.log?.(line) } catch { /* 日志失败绝不影响主流程 */ }
  }

  /**
   * 记一条留痕。`skipped` 桶：列表未满就逐条落盘，满了只计数 + 置 skippedTruncated（上限只影响
   * **记录条数**，不影响 skippedCount —— 绝不静默丢弃）；`excluded` 桶（预期内的忽略目录，如
   * node_modules）逐条记录、**不计入 skippedCount**，因此不会把点判成 degraded。
   */
  private recordSkip(sink: ChunkWalkSink, bucket: 'skipped' | 'excluded' | 'ignored', entry: RollbackSkippedEntry): void {
    // **F-4（t12 修复）**：这两个桶也受 maxSkippedEntries 的**逐条记录**上限约束（超限只丢列表、
    // 计数仍如实），否则台账 payload 会随忽略目录数无界增长。
    if (bucket === 'excluded') {
      if (sink.excludedDirs.length < this.maxSkippedEntries) sink.excludedDirs.push(entry)
      return
    }
    if (bucket === 'ignored') {
      // **F-6（t14 修复）**：计数走恒增计数器 —— 逐条列表可截断，计数绝不跟着缩水
      // （否则 ignoredDirCount 会被当成「真值」，maxSkippedEntries=0 时还会让 ignoreIncomplete 静默失效）
      sink.ignoredDirCount += 1
      if (sink.ignoredDirs.length < this.maxSkippedEntries) sink.ignoredDirs.push(entry)
      return
    }
    sink.skippedCount += 1
    if (sink.skipped.length < this.maxSkippedEntries) sink.skipped.push(entry)
    else sink.skippedTruncated = true
  }

  /**
   * 打开一次回退的前像暂存目录（`<root>/undo/<pid>-<ts36>-<8hex>/`）。
   * 返回 null = 建不出来（权限 / 磁盘满）⇒ 调用方必须**零写入失败**。
   */
  private async openUndoStager(): Promise<UndoStager | null> {
    const name = String(process.pid) + '-' + this.stamp().toString(36) + '-' + crypto.randomBytes(4).toString('hex')
    const dir = path.join(this.root, ROLLBACK_UNDO_DIR_NAME, name)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (error) {
      this.warn('rollback undo staging unavailable: ' + errorDetail(error))
      return null
    }
    // 前像 journal（2026-10-18）：**先落 bin → 再 append 一行索引 + fsync**；全部写完才落 done。
    // 崩在写入中途时这个目录会被启动期认出是「中断的回退」并保持可重放，
    // 而不会被 cleanupOrphanTempFiles 当垃圾删掉（见 rollback-ledger 的同名判据）。
    try {
      return new UndoStager(dir, await UndoJournalWriter.create(dir, { now: () => this.stamp() }))
    } catch (error) {
      // journal 建不出来 = 没有安全网 ⇒ **零写入失败**（与「暂存目录建不出来」同一条判据）
      this.warn('rollback undo journal unavailable: ' + errorDetail(error))
      return null
    }
  }

  private async writeFile(target: string, bytes: Uint8Array): Promise<void> {
    if (this.writeSeam !== undefined) {
      await this.writeSeam(target, bytes)
      return
    }
    await atomicWriteFile(target, bytes, { symlink: 'reject' })
  }

  /* ---------------------------------------------------------- 存储栈探针 */

  /**
   * 启动期一次性初始化（惰性单飞）：先**流式**迁移 v2 单文件 -> v3，再清理崩溃残留的原子写 tmp。
   *
   * 为什么惰取而不是在构造里同步跑：引擎在每个请求路径上都会被新建（路由层不缓存引擎），
   * 构造里同步扫盘/迁移会把请求卡死；而「每回合扫一遍」又是纯浪费 —— 所以只跑一次并记住结果。
   * 迁移失败**不抛**：如实记进 initError，由读路径报出来，并**拒写**（绝不覆盖还没迁完的 v2 文件）。
   */
  private async ensureReady(): Promise<void> {
    if (this.initPromise === null) this.initPromise = this.runInit()
    await this.initPromise
  }

  private async runInit(): Promise<void> {
    let migration: RollbackLedgerMigration
    try {
      migration = await this.ledger.migrateIfNeeded()
    } catch (error) {
      this.initError = 'ledger unreadable: ' + errorDetail(error)
      return
    }
    if (migration.error !== undefined) {
      this.initError = migration.error
      this.warn('rollback ledger migration failed: ' + migration.error)
      return
    }
    if (migration.migrated) {
      this.warn('rollback ledger migrated: records=' + String(migration.records) + ' skipped=' + String(migration.skipped))
    }
    // 迁移**之后**再清残留：连本次迁移自己的 tmp 一并收掉（只放行可自证形状的崩溃残留）
    try {
      const cleaned = await cleanupOrphanTempFiles(this.root)
      if (cleaned.removed > 0) {
        this.warn('rollback temp cleanup: removed=' + String(cleaned.removed) + ' bytes=' + String(cleaned.bytes) + ' skipped=' + String(cleaned.skipped))
      }
    } catch (error) {
      this.warn('rollback temp cleanup failed: ' + errorDetail(error))
    }
  }

  async storageStatus(): Promise<RollbackStorageStatus> {
    const base = { root: this.root, requirements: ROLLBACK_STORAGE_REQUIREMENTS }
    await this.ensureReady()
    let result: { ok: true } | { ok: false; detail: string }
    if (this.probe !== undefined) {
      try {
        result = await this.probe()
      } catch (error) {
        result = { ok: false, detail: errorDetail(error) }
      }
    } else {
      result = await defaultStorageProbe(this.root)
    }
    if (!result.ok) {
      return { ...base, available: false, detail: result.detail, guidance: storageGuidance(this.root, result.detail) }
    }
    const out: RollbackStorageStatus = { ...base, available: true, guidance: [] }
    const ledger = await this.ledgerStatus()
    if (ledger !== undefined) out.ledger = ledger
    if (this.initError !== undefined) {
      // 磁盘本身没问题，但台账读不出来（迁移失败 / 迁到一半被别人占着）：如实上屏，不谎报可用
      out.detail = this.initError
      out.guidance = storageGuidance(this.root, this.initError)
    }
    return out
  }

  /** 台账可观测快照（清单条数 + 磁盘字节 + 预算 + 本进程淘汰计数） */
  private async ledgerStatus(): Promise<RollbackLedgerStatus | undefined> {
    try {
      const manifest = await this.ledger.readManifest()
      const stats = await this.ledger.stats()
      return {
        records: manifest.entries.length,
        bytes: stats.bytes,
        budgetBytes: this.ledgerBytesBudget,
        evicted: this.ledger.evictedCount,
        // 每次 append 都会尽力淘汰到预算内 ⇒「bytes > budget」本身就等于「淘汰到极限了」
        // （单条点大于预算时恒为 true）。这里不额外读盘，只用已有 stats。
        overBudget: stats.bytes > this.ledgerBytesBudget,
      }
    } catch (error) {
      this.warn('rollback ledger status failed: ' + errorDetail(error))
      return undefined
    }
  }

  /* -------------------------------------------------------------- 对象仓 */

  /** 对象仓目录只 mkdir 一次（每个对象各 mkdir 一次是纯白花的 syscall） */
  private async ensureObjectsDir(): Promise<void> {
    if (this.objectsDirReady) return
    await fs.mkdir(this.objectsDir, { recursive: true })
    this.objectsDirReady = true
  }

  /**
   * 写内容寻址对象（对象文件名 = 内容 SHA-256）。
   *
   * **为什么这里不用 atomicWriteFile**：那是给「可写配置文件」用的强原子写（同目录 tmp → fsync →
   * rename），真机实测一次约 4.7 ms —— 34k 文件的工作区一次全量捕获 148 s 全花在它上面（走查本身
   * 只要 0.66 s）。对象仓的正确性要求不同：文件名即内容哈希 ⇒
   *   · 用 'wx' **独占创建最终名**本身已是原子的（不覆盖已有对象；并发同写只有一方成功）；
   *   · 半截 / 被篡改的内容在读取侧必然过不了哈希校验（readObject + sha256Hex）⇒ 按「读不出」
   *     处理并 fail-closed，绝不会冒充有效前像；
   *   · 不做 fsync：回滚点是尽力而为的本地快照，不为掉电持久性付出每文件一次 fsync 的代价。
   */
  private async writeObjectWithHash(bytes: Uint8Array, sha: string): Promise<string> {
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('rollback object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('rollback object path escapes store')
    await this.ensureObjectsDir()
    let delay = 10
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.writeFile(target, bytes, { flag: 'wx' })
        this.captureObjectNames?.add(sha)
        return sha
      } catch (error) {
        const code = (error as { code?: unknown }).code
        if (code === 'EEXIST') return sha // 已有同内容对象（去重 / 并发竞写）
        // 杀软 / 句柄瞬时占用：有界退避重试（与 atomic-write 的判据同族）
        if (OBJECT_WRITE_RETRY_CODES.includes(code as string) && attempt < 3) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
          delay *= 2
          continue
        }
        throw error
      }
    }
  }

  /** 对象仓里是否真有这个 blob（缓存命中时校验；任何异常一律按「没有」处理） */
  private async objectExists(sha: string): Promise<boolean> {
    if (!OBJECT_KEY_RE.test(sha)) return false
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) return false
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }

  private async readObject(sha: string): Promise<Uint8Array> {
    if (!OBJECT_KEY_RE.test(sha)) throw new Error('rollback object key invalid')
    const target = path.join(this.objectsDir, sha)
    if (!isInsidePath(target, this.objectsDir)) throw new Error('rollback object path escapes store')
    return await fs.readFile(target)
  }

  /**
   * 读回路径索引并校验完整性（内容寻址 ⇒ 字节一变就对不上，绝不用坏名单下删除判断）。
   * 任何异常（对象丢失 / gzip 坏 / 哈希不符）都抛给调用方 —— 调用方据此 fail-closed。
   */
  private async readPathIndex(index: RollbackPathIndex): Promise<string[]> {
    const raw = await this.readObject(index.object)
    if (sha256Hex(raw) !== index.object) throw new Error('rollback path index hash mismatch')
    const text = gunzipSync(raw).toString('utf8')
    if (text === '') return []
    const paths = text.split('\n')
    if (paths.length !== index.count) throw new Error('rollback path index count mismatch: ' + String(paths.length) + ' != ' + String(index.count))
    return paths
  }

  /* ------------------------------------------------------------ 捕获：态 */

  private emptyTrack<TPayload = never>(
    kind: RollbackStateKind,
    capturedAt: number,
    code: RollbackCode,
    detail: string | null,
  ): RollbackTrack<TPayload> {
    return { kind, capturedAt, ok: false, degraded: false, fingerprint: null, reasonCode: code, reasonDetail: detail, payload: null }
  }

  /**
   * 会话态捕获：记录 sessionId / 事件游标 / 字节数 / 指纹；容量允许时把**字节副本**放进
   * 对象仓（仅为审计证据 —— 回退走 fork，不依赖它）。
   */
  private async captureSession(input: {
    sessionId: string | null
    logPath: string | null
    cursorSeq: number | null
    turnSeq: number | null
    boundarySeq: number | null
    boundaryEndSeq: number | null
  }): Promise<RollbackTrack<RollbackSessionPayload>> {
    const capturedAt = this.stamp()
    if (input.sessionId === null || input.sessionId === '') {
      return this.emptyTrack('session', capturedAt, 'session-missing', 'sessionId missing')
    }
    const payload: RollbackSessionPayload = {
      sessionId: input.sessionId,
      logPath: input.logPath,
      cursorSeq: input.cursorSeq,
      cursorBytes: null,
      mtimeMs: null,
      fingerprintKind: 'cursor',
      fingerprint: 'cursor:' + String(input.cursorSeq ?? 'unknown'),
      object: null,
      bytes: 0,
      turnSeq: input.turnSeq,
      boundarySeq: input.boundarySeq,
      boundaryEndSeq: input.boundaryEndSeq,
    }
    if (input.logPath === null || input.logPath === '') {
      // 没有日志路径也能回退（fork 只要 sessionId + 边界）；如实标注指纹种类
      return { kind: 'session', capturedAt, ok: true, degraded: false, fingerprint: payload.fingerprint, reasonCode: null, reasonDetail: null, payload }
    }
    try {
      const realRoot = await fs.realpath(this.sessionsRoot).catch(() => undefined)
      const realLog = await fs.realpath(input.logPath).catch(() => undefined)
      if (realLog === undefined) {
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: 'session-log-missing ' + input.logPath, payload }
      }
      if (realRoot === undefined || !isInsidePath(realLog, realRoot)) {
        return this.emptyTrack('session', capturedAt, 'session-out-of-root', realLog)
      }
      const stat = await fs.stat(realLog)
      if (!stat.isFile()) {
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: 'session-log-not-file ' + realLog, payload }
      }
      payload.logPath = realLog
      payload.cursorBytes = stat.size
      payload.mtimeMs = stat.mtimeMs
      payload.bytes = stat.size
      if (stat.size > this.sessionMaxBytes) {
        payload.fingerprintKind = 'size'
        payload.fingerprint = 'size:' + String(stat.size)
        return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'session-too-large', reasonDetail: realLog, payload }
      }
      const bytes = await fs.readFile(realLog)
      const sha = sha256Hex(bytes)
      await this.writeObjectWithHash(bytes, sha)
      payload.fingerprintKind = 'content'
      payload.fingerprint = sha
      payload.object = sha
      return { kind: 'session', capturedAt, ok: true, degraded: false, fingerprint: sha, reasonCode: null, reasonDetail: null, payload }
    } catch (error) {
      return { kind: 'session', capturedAt, ok: true, degraded: true, fingerprint: payload.fingerprint, reasonCode: 'capture-degraded', reasonDetail: errorDetail(error), payload }
    }
  }

  /**
   * 列出一个显式分块内的候选文件（不跟随符号链接 / junction；跳过与读不到都留痕）。
   * 返回 null = 该分块本身不可用（不存在 / 是链接 / 非常规文件），细节已写进 sink。
   *
   * `truncated` 与 `walkAborted` 是**两件事**：前者只说「本次列表不完整」（文件数上限 / 提交上限），
   * 后者说「走查被预算或取消打断，栈里还有没进去的子树」—— 只有后者才意味着那些路径
   * **一条都没进任何名单**，调用方必须据此让删除集 fail-closed。
   */
  private async listChunkFiles(
    chunk: string,
    sink: ChunkWalkSink,
    limit: number,
    /**
     * 捕获期专用：把**走查过**的每条文件路径都记进来（含超出 limit、因而没进 `out` 的那些）——
     * 路径索引（{@link RollbackPathIndex}）的来源。回退期的走查不传它（那份名单只由记录决定）。
     */
    collect?: string[],
    ignore?: IgnoreRules,
    /**
     * 停止判据（捕获期传时间/取消预算；回退期的走查不传）—— 返回 true 立即停止遍历，
     * 已走查的部分照常返回并置 truncated + walkAborted（栈里剩余的子树从未进门 ⇒ 由调用方据此 fail-closed；
     * 回退期不传它，故 walkAborted 恒 false）。
     */
    shouldStop?: () => boolean,
  ): Promise<{ files: string[]; truncated: boolean; walkAborted: boolean; unwalkedDirs: string[] } | null> {
    // 分块根本身就是 `.asar` 段 ⇒ 一次 fs 调用都不发（见 hasAsarSegment）
    if (hasAsarSegment(chunk)) {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'asar-container' })
      return null
    }
    let stat
    try {
      stat = await fs.lstat(chunk)
    } catch {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'missing' })
      return null
    }
    if (stat.isSymbolicLink()) {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'link' })
      return null
    }
    if (stat.isFile()) return { files: [chunk], truncated: false, walkAborted: false, unwalkedDirs: [] }
    if (!stat.isDirectory()) {
      this.recordSkip(sink, 'skipped', { path: chunk, reason: 'not-a-file' })
      return null
    }
    const out: string[] = []
    let truncated = false
    // 走查**被预算 / 取消打断**：栈里还压着没进去的子树 —— 那些路径一条都没进任何名单
    let walkAborted = false
    // 中断时把**还没进去的子树**如实带出去 ⇒ 调用方可以只对这几棵子树 fail-closed（精确范围）
    let unwalkedDirs: string[] = []
    const stack: { dir: string; depth: number }[] = [{ dir: chunk, depth: 0 }]
    while (stack.length > 0) {
      if (shouldStop?.() === true) {
        truncated = true
        walkAborted = true
        unwalkedDirs = stack.length > ROLLBACK_UNWALKED_DIRS_LIMIT ? [] : stack.map((item) => item.dir)
        break
      }
      const item = stack.pop()
      if (item === undefined) break
      if (item.depth >= MAX_WALK_DEPTH) {
        sink.unreadableDirs.push(item.dir)
        continue
      }
      let entries
      try {
        entries = await fs.readdir(item.dir, { withFileTypes: true })
      } catch {
        sink.unreadableDirs.push(item.dir)
        continue
      }
      for (const entry of entries) {
        const full = path.join(item.dir, entry.name)
        // **绝不把含 `.asar` 段的路径交给 fs**（见 hasAsarSegment：宿主里这一步是原生解析，
        // 畸形夹具会让整个宿主进程消失）。留痕进 skipped —— 它是**证明名单**的一员，
        // 因此该路径绝不会被当成「留点后新建」删掉。
        if (hasAsarSegment(full)) {
          this.recordSkip(sink, 'skipped', { path: full, reason: 'asar-container' })
          continue
        }
        if (entry.isSymbolicLink()) {
          this.recordSkip(sink, 'skipped', { path: full, reason: 'link' })
          continue
        }
        if (entry.isDirectory()) {
          // `.git` 与运行时依赖目录**同档**：整棵不进快照。两条理由 ——
          //  ① 回退写回 .git（index/refs/logs）会让 git 状态错乱（提交看似消失、可能留 index.lock），
          //     而删除侧本来就把 .git 当拒删目录 ⇒ 排除它才让两侧口径一致；
          //  ② .git 常常几百 MB，会**挤掉 maxBytes 预算里的源码文件**。
          // 大小写折半比较：Windows 上 .GIT/.Git 是同一个目录。
          const dirName = win32Fold(entry.name)
          if (EXCLUDED_DEP_DIR_NAMES.includes(entry.name) || dirName === '.git') {
            // 内置忽略规则（S4「沿用现有 IGNORE 规则」）：整棵不进快照，但留痕（不静默）
            this.recordSkip(sink, 'excluded', { path: full, reason: dirName === '.git' ? 'git-dir' : 'dep-dir' })
            continue
          }
          if (ignore !== undefined && this.ignoredByRules(ignore, full, true)) {
            // 用户忽略规则命中**整个目录**：不进走查 ⇒ 证明名单不完整（调用方置 ignoreIncomplete）
            this.recordSkip(sink, 'ignored', { path: full, reason: 'ignored' })
            continue
          }
          stack.push({ dir: full, depth: item.depth + 1 })
          continue
        }
        if (!entry.isFile()) {
          this.recordSkip(sink, 'skipped', { path: full, reason: 'not-a-file' })
          continue
        }
        // **F-1（t12 修复）**：走查记录必须在「忽略 / 预算」判定**之前**——被忽略的文件也要进
        // walked（= 路径索引的来源）。否则 skipped 被记录上限截断后，「留点时已存在但被忽略」
        // 的文件既不在 files、也不在 skipped、更不在 pathIndex ⇒ 被当成「留点后新建」删掉。
        collect?.push(full)
        if (ignore !== undefined && this.ignoredByRules(ignore, full, false)) {
          // 文件级忽略：逐条进 skipped（名单完整时删除照常；被记录上限截断时由 pathIndex 兜底）
          this.recordSkip(sink, 'skipped', { path: full, reason: 'ignored' })
          continue
        }
        if (out.length >= limit) {
          // 文件数预算用尽：**逐条留痕**（不静默截断），但不再收进 files；继续遍历把后面每条也记上
          truncated = true
          this.recordSkip(sink, 'skipped', { path: full, reason: 'budget-files' })
          continue
        }
        out.push(full)
      }
    }
    out.sort()
    return { files: out, truncated, walkAborted, unwalkedDirs }
  }

  private async captureWorkspace(
    chunks: readonly string[],
    signal?: AbortSignal,
  ): Promise<RollbackTrack<RollbackWorkspacePayload>> {
    const capturedAt = this.stamp()
    if (chunks.length === 0) return this.emptyTrack('workspace', capturedAt, 'no-chunks', 'chunks empty')
    // 时间预算（见 ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS）：用 stamp()（单调）比较，
    // 系统时钟回拨也不会让预算永不触发。超时置 payload.truncated ⇒ 结尾的 reasonCode
    // 自动落成 capture-truncated，UI 走既有的 degraded 提示路径（零新增文案）。
    const deadline = capturedAt + this.captureBudgetMs
    const outOfBudget = (): boolean => signal?.aborted === true || this.stamp() >= deadline
    // 对象名单快照按回合重建（一次 readdir 换掉每个候选一次 fs.access）
    this.captureObjectNames = null
    const payload: RollbackWorkspacePayload = {
      chunks: [...chunks],
      files: [],
      skipped: [],
      excludedDirs: [],
      unreadableDirs: [],
      unreadableFiles: [],
      skippedCount: 0,
      skippedTruncated: false,
      ignoredDirCount: 0,
      ignoredDirs: [],
      ignoreIncomplete: false,
      truncated: false,
      bytes: 0,
    }
    let read = 0
    let sawChunk = false
    // 走查过的**全部**文件路径（含被预算 / 单文件上限挡下的）—— 路径索引的来源（方向 B）
    const walked: string[] = []
    // 走查中断时**没进去的子树**（精确到目录）—— 供删除集做分子树 fail-closed
    const unwalked: string[] = []
    for (const chunk of chunks) {
      if (outOfBudget()) {
        // 分块之间就超预算：不再开新分块，并如实留痕（该分块的条目一条都没被走查）
        // walkIncomplete 是**安全判据**（删除集 fail-closed）；这里能精确给出「没进去的是哪个分块」
        // ⇒ 删除只拒这棵子树，不再把整个工作区的新建文件一起放弃。
        payload.walkIncomplete = true
        payload.truncated = true
        unwalked.push(chunk)
        this.recordSkip(payload, 'skipped', { path: chunk, reason: 'budget-time' })
        break
      }
      if (!path.isAbsolute(chunk)) return this.emptyTrack('workspace', capturedAt, 'chunk-not-absolute', chunk)
      const resolved = path.resolve(chunk)
      // 文件数预算还剩多少就收多少；+1 只用于让遍历器发现「还有溢出」——溢出条目逐条记 skipped
      // 候选名单上限取 ROLLBACK_CAPTURE_LIST_LIMIT（而不是 maxFiles）：入点上限由阶段①的 slots
      // 把关，这里若提前截断，缺口优先排序就够不到尾部文件 ⇒ 覆盖率不收敛
      const listed = await this.listChunkFiles(resolved, payload, ROLLBACK_CAPTURE_LIST_LIMIT, walked, await loadIgnoreRules(resolved), outOfBudget)
      if (listed === null) continue
      sawChunk = true
      if (listed.truncated) payload.truncated = true
      // 走查本身被打断 ⇒ 栈里还有没进去的子树（那些路径从未进任何名单）⇒ fail-closed。
      // **区别于**下面「走查已结束、只是读到一半超时」：后者的路径全在 walked 里，
      // 由文件末尾的覆盖自检补进证明名单（补不齐才拒删），不该整体拒删。
      if (listed.walkAborted) {
        payload.walkIncomplete = true
        for (const dir of listed.unwalkedDirs) unwalked.push(dir)
      }
      read += await this.captureChunkCandidates(resolved, listed.files, Math.max(0, this.maxFiles - read), payload, outOfBudget)
    }
    // 精确的「没进去的子树」：有 ⇒ 删除集只在这些子树里 fail-closed；没有（老台账 / 栈被截断）
    // ⇒ 退回全局拒删（见 planCreatedRemovals）
    if (unwalked.length > 0) payload.unwalkedDirs = [...new Set(unwalked)].sort()

    // `truncated` 为真时**不能**判 chunk-not-found：那是「分块确实存在、只是没来得及走查完」
    // （时间预算 / 取消信号）—— 报成「找不到分块」会让用户以为工作区配错了。
    if (!sawChunk && payload.files.length === 0 && !payload.truncated) {
      return this.emptyTrack('workspace', capturedAt, 'chunk-not-found', chunks.join(' '))
    }
    // **方向 B**：把走查过的全部路径另存成路径索引对象 —— 「未记录」与「留点时就存在」只有在
    // 证明名单完整时才可区分。触发条件是**覆盖自检**（不是「跳过名单被截断」这一种特例）：
    //  · 逐条跳过名单被记录上限截断（skippedTruncated）；或
    //  · 读到一半被时间预算 / 取消打断 —— 本分块剩余文件进了 walked、却一条都没进任何名单。
    // 覆盖完整时不必写（未截断时 files ∪ skipped 本身就是完整名单，零额外成本）。
    // 写失败 ⇒ 证明名单补不齐 ⇒ 必须整体拒删（安全方向；R-05f）。
    const proven = new Set<string>()
    for (const file of payload.files) proven.add(pathKey(file.path))
    for (const entry of payload.skipped) proven.add(pathKey(entry.path))
    for (const entry of payload.unreadableFiles) proven.add(pathKey(entry.path))
    const uncovered = walked.some((item) => !proven.has(pathKey(item)))
    if (uncovered) {
      try {
        const paths = [...new Set(walked)].sort()
        const gz = gzipSync(Buffer.from(paths.join('\n'), 'utf8'))
        const object = sha256Hex(gz)
        await this.writeObjectWithHash(gz, object)
        payload.pathIndex = { object, count: paths.length, bytes: gz.byteLength }
      } catch (error) {
        this.warn('rollback path index failed: ' + errorDetail(error))
        // 走查过、却没进名单的路径无法被证明 ⇒ 删除集整体拒绝（绝不「删一半」）
        payload.walkIncomplete = true
      }
    }
    // 用户忽略的整目录 ⇒ 证明名单不完整（删除集整体拒绝；见 planCreatedRemovals）。
    // F-6：计数取捕获期的**恒增计数器**（列表可被记录上限截断），因此 maxSkippedEntries=0 时
    // ignoreIncomplete 仍然为 true —— fail-closed 不会因「列表为空」而静默失效。
    payload.ignoreIncomplete = payload.ignoredDirCount > 0
    // 路径身份缓存落盘（best-effort：写不进去只意味着下次全量读，绝不影响留点成败）
    await this.persistPathCache()
    // 落点列表排序：并发读让入点顺序不定，契约必须是「按路径有序」（预览 / 对账 / 指纹都靠它）
    payload.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    // 留痕列表也排序：跨分块 / 依赖 readdir 顺序时输出仍确定（测试与对账都能逐条比）
    payload.skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    payload.excludedDirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    payload.ignoredDirs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const canonical = [...payload.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, f.bytes, f.sha256])
    payload.fileCount = payload.files.length
    const fingerprint = sha256Hex(JSON.stringify({ chunks: [...payload.chunks].sort(), files: canonical }))
    // 自适应预算（见 ROLLBACK_MIN/MAX_CAPTURE_BUDGET_MS）：被截断 ⇒ 下次翻倍（上限）；
    // 用得很少 ⇒ 下次减半（下限）。大仓库第一次撞上限后自动拿到更大预算，小仓库自动回落，
    // 不会每回合白等。回退期的走查预算（rewindBudgetMs）**不参与**这套调整。
    if (payload.truncated || payload.walkIncomplete === true) {
      this.captureBudgetMs = Math.min(this.captureBudgetMaxMs, this.captureBudgetMs * 2)
    } else if (this.stamp() - capturedAt < this.captureBudgetMs / 4) {
      this.captureBudgetMs = Math.max(this.captureBudgetMinMs, Math.floor(this.captureBudgetMs / 2))
    }
    // 「降级（留得不完整）」只由**真的缺内容**触发：
    //  ① truncated —— 文件数 / 总字节 / 单文件上限 / 时间预算挡下的内容；
    //  ② unreadableDirs / unreadableFiles —— 读不出来或捕获竞态（内容不可信）。
    // **不再用 skippedCount**：那里的条目大多是**设计内**的跳过（符号链接不跟随、文件级忽略、
    // 自身数据区、读之前就消失），既不缺内容也无法回退 —— 旧口径让「工作区里有任何一个符号链接」
    // 的仓库每个点都挂「回退可能不完整」，真出问题时反而被噪声淹没（真机 2026-10-15：10 个 link
    // 跳过 ⇒ 每个点 degraded=true）。条目与计数仍逐条留痕（skippedCount / skipped 列表不变）。
    const degraded = payload.truncated
      || payload.unreadableDirs.length > 0
      || payload.unreadableFiles.length > 0
    return {
      kind: 'workspace', capturedAt, ok: true, degraded, fingerprint,
      reasonCode: payload.truncated ? 'capture-truncated' : degraded ? 'capture-degraded' : null,
      reasonDetail: degraded
        ? 'files=' + String(payload.files.length) + ' skipped=' + String(payload.skippedCount)
          + (payload.skippedTruncated ? '(list-capped)' : '')
          + ' unreadableDirs=' + String(payload.unreadableDirs.length) + ' unreadableFiles=' + String(payload.unreadableFiles.length)
        : null,
      payload,
    }
  }

  /* ---------------------------------------------------------- 忽略规则 / 路径身份缓存 */

  /** 用户忽略规则是否命中该路径（只认「相对分块根」的斜杠路径） */
  /**
   * 处理一个分块的候选文件（**两阶段**）。
   *
   *  ① **顺序判定**（与旧的串行实现逐条一致，保证预算 / 计数 / 字节上限完全确定）：
   *     文件数上限、时间预算、自身数据区、stat、单文件上限、总量上限、身份缓存 + 对象存在性
   *     → 得出「当场入点（缓存命中）」还是「要真读」，该跳过的**当场**按原有 reason 逐条留痕。
   *     stat 按**有序批**并发取（判定仍严格按顺序），并用「一次 readdir 的对象名单快照」代替
   *     每个文件一次 fs.access —— 这两处是稳态成本的大头（真机实测各占 ~5 s / ~3.7 s）。
   *  ② **并发读 + 哈希 + 落对象仓**：这是捕获耗时的**唯一大头**（真机 148 s / 31,702 个对象，
   *     96% 的时间），用 captureConcurrency 个 worker 并发跑；并用**在飞字节闸门**保证
   *     「同时在飞的内容字节 ≤ captureInFlightBytes」。**不是** maxFileBytes —— 它缺省 =
   *     总量预算（512 MiB），拿它当闸门等于允许把整个点的预算同时驻留（0.1.74 闪退根因）。
   *
   * 返回本分块**真正入点**的文件数（调用方据此推进 maxFiles 预算）。
   * 没判到 / 没读完的条目一律逐条进 skipped(budget-time)，绝不静默丢弃。
   */
  private async captureChunkCandidates(
    chunk: string,
    candidates: readonly string[],
    slots: number,
    payload: RollbackWorkspacePayload,
    outOfBudget: () => boolean,
  ): Promise<number> {
    // 缺口优先：身份缓存里还没有的路径排前面 ⇒ 每个点都在补上次没覆盖的部分（见 orderByCoverage）
    const ordered = await this.orderByCoverage(candidates)
    const decided = new Array<boolean>(ordered.length).fill(false)
    interface ReadPlan { path: string; size: number; mtimeMs: number; identity: string | null }
    const plans: ReadPlan[] = []
    let captured = 0
    let newReads = 0
    // 字节预算必须在**准入那一刻**按 stat.size 预留：真正入点发生在并发的第二阶段，
    // 若拿 payload.bytes 当判据，同一个分块里后面的文件会全部误判成「还有额度」
    let accounted = payload.bytes
    // 对象名单快照：一次 readdir 顶掉「每个候选一次 fs.access」（读不到则回落逐条判断）
    const names = await this.objectNamesSnapshot()

    let cursor = 0
    while (cursor < ordered.length) {
      if (outOfBudget()) break // 剩余条目由收尾循环逐条记 budget-time（不预取 stat）
      const window = ordered.slice(cursor, cursor + ROLLBACK_CAPTURE_STAT_BATCH)
      const stats = await Promise.all(window.map((file) => this.fileStatOf(file)))
      let broke = false
      for (let offset = 0; offset < window.length; offset += 1) {
        const file = window[offset] ?? ''
        const info: RollbackFileStat = stats[offset] ?? { isFile: false, size: 0, mtimeMs: 0, identity: null, error: 'stat-missing' }
        const index = cursor + offset
        if (outOfBudget()) { broke = true; break }
        decided[index] = true
        if (isInsidePath(file, this.root)) {
          this.recordSkip(payload, 'skipped', { path: file, reason: 'self-store' })
          continue
        }
        // **先 stat 判大小、再决定读不读**：单文件超限或加上它会超总量 → 跳过并如实留痕
        // （旧实现的 read > 0 短路让**首个**文件完全不设上限，会被整份读进内存 —— t5-F1）
        if (info.error !== undefined) {
          payload.unreadableFiles.push({ path: file, reason: info.error })
          continue
        }
        if (!info.isFile) {
          this.recordSkip(payload, 'skipped', { path: file, reason: 'not-a-file' })
          continue
        }
        if (info.size > this.maxFileBytes) {
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'too-large' })
          continue
        }
        // 路径身份缓存：身份（dev:ino:size:mtimeNs:ctimeNs:mode）未变 ⇒ 复用已存 sha256，**不重读**
        const candidate = info.identity === null ? null : await this.lookupCachedFile(info.identity, file)
        // **F-2（t12 修复）**：缓存命中也要确认对象仓里真有那个 blob —— 对象被外部清掉后
        // 若直接复用 sha256，新点会「零对象却 canRestore=true」，预览骗人（执行才响亮失败）。
        // 对象不在 ⇒ 当作未命中：真读 + 重写对象（缓存因此自愈）。
        const objectPresent = candidate === null
          ? false
          : names !== null ? names.has(candidate.sha256) : await this.objectExists(candidate.sha256)
        if (candidate !== null && objectPresent) {
          // 身份未变 ⇒ 内容必然与缓存一致：零 I/O 直接入点（稳态成本与仓库大小无关的来源）。
          // **不占读预算**：maxFiles / maxBytes 约束的是「这回合新读进来的内容」，不是「记录多少条」
          // —— 否则大仓库每个点都只能记下前 N 条，滚回某点时会漏掉其余文件（覆盖率永远不收敛）。
          payload.files.push({
            path: file, chunk, bytes: candidate.bytes, sha256: candidate.sha256, mtimeMs: info.mtimeMs, object: candidate.sha256,
          })
          payload.bytes += candidate.bytes
          captured += 1
          continue
        }
        // 只有**要真读的新内容**才受每回合的规模预算约束（判定仍严格按顺序 ⇒ 结果确定）
        if (newReads >= slots) {
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'budget-files' })
          continue
        }
        if (accounted + info.size > this.maxBytes) {
          payload.truncated = true
          this.recordSkip(payload, 'skipped', { path: file, reason: 'budget-bytes' })
          continue
        }
        accounted += info.size
        newReads += 1
        plans.push({ path: file, size: info.size, mtimeMs: info.mtimeMs, identity: info.identity })
      }
      cursor += window.length
      if (broke) break
    }

    if (plans.length > 0) {
      // ② 并发读 + 落对象仓。outOfBudget 一命中就**不再开新条目**（在飞的照常收尾），
      //    未开工的条目在循环外逐条记 budget-time —— 与串行版「中断处逐条留痕」同一诚实口径。
      const gate = new ByteGate(this.captureInFlightBytes)
      const done: boolean[] = new Array<boolean>(plans.length).fill(false)
      let planCursor = 0
      let stopped = false
      const workers = Array.from({ length: Math.min(this.captureConcurrency, plans.length) }, async () => {
        for (;;) {
          if (stopped) return
          const index = planCursor
          planCursor += 1
          if (index >= plans.length) return
          const item = plans[index] as ReadPlan
          if (outOfBudget()) { stopped = true; return }
          await gate.acquire(item.size)
          try {
            if (outOfBudget()) { stopped = true; return }
            const data = await this.readFileBytes(item.path)
            if (data.byteLength !== item.size) {
              // stat 与 read 之间文件变了（旧口径：budget-bytes）—— 绝不按旧字节数记账
              payload.truncated = true
              this.recordSkip(payload, 'skipped', { path: item.path, reason: 'budget-bytes' })
              done[index] = true
              continue
            }
            // **捕获竞态**：读之前拿到的身份若在读完时已变，说明这次读到的内容未必是「留点时刻」
            // 的内容（回合与留点并发）⇒ 不当作前像，只如实进 unreadableFiles（它本身是**证明名单**
            // 的一员：证明「留点时存在」，因此绝不会被当成新建删掉）。
            const after = item.identity === null ? null : await this.pathIdentityOf(item.path)
            if (item.identity !== null && after !== item.identity) {
              payload.unreadableFiles.push({ path: item.path, reason: 'changed-during-read' })
              done[index] = true
              continue
            }
            const sha = sha256Hex(data)
            await this.writeObjectWithHash(data, sha)
            if (item.identity !== null) this.rememberCachedFile(item.identity, item.path, sha, data.byteLength)
            payload.files.push({
              path: item.path, chunk, bytes: data.byteLength, sha256: sha, mtimeMs: item.mtimeMs, object: sha,
            })
            payload.bytes += data.byteLength
            captured += 1
            done[index] = true
          } catch (error) {
            payload.unreadableFiles.push({ path: item.path, reason: errorDetail(error) })
            done[index] = true
          } finally {
            gate.release(item.size)
          }
        }
      })
      await Promise.all(workers)
      for (let index = 0; index < plans.length; index += 1) {
        if (done[index] === true) continue
        payload.truncated = true
        this.recordSkip(payload, 'skipped', { path: (plans[index] as ReadPlan).path, reason: 'budget-time' })
      }
    }

    // 阶段 ① 里没判定到的（时间预算打断）同样逐条留痕 —— 覆盖自检因此仍认为名单完整
    for (let index = 0; index < ordered.length; index += 1) {
      if (decided[index] === true) continue
      payload.truncated = true
      this.recordSkip(payload, 'skipped', { path: ordered[index] ?? '', reason: 'budget-time' })
    }
    // 返回值 = 本分块消耗掉的**读槽位**（缓存命中不占槽位；调用方据此推进 maxFiles）
    return newReads
  }

  /**
   * 缺口优先排序：身份缓存里**没有**的路径排前面。
   *
   * 为什么：预算固定时按目录顺序走查，同一个「已覆盖且便宜」的前缀每回合都会吃掉全部预算，
   * 尾部永远进不来（真机：34k 文件每次只覆盖 1/5，且五次都是同一批 outputs/ 前缀）。
   * 未覆盖的排前面 ⇒ 每个点都在补上一次的缺口，覆盖率随回合**单调收敛**到 100%。
   * 组内保持走查顺序（稳定），因此同一输入下的结果仍然确定。
   */
  private async orderByCoverage(candidates: readonly string[]): Promise<string[]> {
    if (candidates.length <= 1) return [...candidates]
    const cache = await this.loadPathCache()
    if (cache.size === 0) return [...candidates]
    const covered = new Set<string>()
    for (const entry of cache.values()) covered.add(pathKey(entry.path))
    if (covered.size === 0) return [...candidates]
    const cold: string[] = []
    const hot: string[] = []
    for (const file of candidates) (covered.has(pathKey(file)) ? hot : cold).push(file)
    return cold.length === 0 ? hot : [...cold, ...hot]
  }

  private ignoredByRules(rules: IgnoreRules, target: string, isDir: boolean): boolean {
    const rel = ignoreRelativePath(rules.root, target)
    return rel === null ? false : ignoreRuleMatches(rules, rel, isDir)
  }

  /** 读文件（可注入 seam；只用于捕获期读内容这一步） */
  private async readFileBytes(target: string): Promise<Uint8Array> {
    return this.readSeam === undefined ? await fs.readFile(target) : await this.readSeam(target)
  }

  /**
   * 路径身份键：dev:ino:size:mtimeNs:ctimeNs:mode（全 BigInt 字符串化）。
   *
   * 为什么必须 BigInt：ino / mtimeNs / ctimeNs 在 64 位 inode 文件系统上会超出 Number 的
   * 安全整数范围，用 Number 会静默丢精度（把两次不同的写当成同一个身份）。
   * 用毫秒换算同样不行：会把「同一毫秒内的两次写」当成同一个身份。
   * 读不到身份（文件消失 / 权限 / 平台不支持 bigint stat）→ null ⇒ 回落全量真读。
   */
  /**
   * 一次 bigint stat 拿到阶段①需要的**全部**东西（是否文件 / 大小 / mtime / 身份）。
   * 旧实现「fs.stat + pathIdentityOf」每文件 stat 两次，真机 34k 文件白花约 5 s。
   */
  private async fileStatOf(target: string): Promise<RollbackFileStat> {
    try {
      const stat = await fs.stat(target, { bigint: true })
      const isFile = stat.isFile()
      return {
        isFile,
        size: Number(stat.size),
        mtimeMs: Number(stat.mtimeMs),
        identity: isFile ? fileIdentityOf(stat) : null,
      }
    } catch (error) {
      return { isFile: false, size: 0, mtimeMs: 0, identity: null, error: errorDetail(error) }
    }
  }

  /** 对象名单快照（每个捕获回合一次 readdir）；读不到则返回 null ⇒ 调用方回落逐条判断 */
  private async objectNamesSnapshot(): Promise<Set<string> | null> {
    if (this.captureObjectNames !== null) return this.captureObjectNames
    try {
      this.captureObjectNames = new Set(await fs.readdir(this.objectsDir))
    } catch {
      this.captureObjectNames = null
    }
    return this.captureObjectNames
  }

  private async pathIdentityOf(target: string): Promise<string | null> {
    try {
      const stat = await fs.stat(target, { bigint: true })
      if (!stat.isFile()) return null
      return fileIdentityOf(stat)
    } catch {
      return null
    }
  }

  private pathCachePath(): string {
    return path.join(this.root, ROLLBACK_PATH_CACHE_NAME)
  }

  /**
   * 惰读缓存（每个引擎实例一次）。任何形状不符 / 读失败都当作空缓存 —— 缓存是纯优化，
   * 绝不因为缓存坏掉而拒绝留点或改变任何判定。
   */
  private async loadPathCache(): Promise<Map<string, RollbackPathCacheEntry>> {
    if (this.pathCache !== null) return this.pathCache
    const map = new Map<string, RollbackPathCacheEntry>()
    this.pathCache = map
    try {
      const raw = await fs.readFile(this.pathCachePath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return map
      if (parsed['version'] !== ROLLBACK_PATH_CACHE_VERSION) return map
      const entries = parsed['entries']
      if (!isRecord(entries)) return map
      for (const [identity, value] of Object.entries(entries)) {
        if (!isRecord(value)) continue
        const p = value['path']
        const sha = value['sha256']
        const bytes = value['bytes']
        if (typeof p !== 'string' || typeof sha !== 'string' || !OBJECT_KEY_RE.test(sha)) continue
        if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) continue
        map.set(identity, { path: p, sha256: sha, bytes })
      }
    } catch { /* 空缓存 / 坏缓存都只意味着全量真读 */ }
    return map
  }

  /** 缓存命中：身份键存在、且路径逐字相同（身份被复用也绝不认）。 */
  /**
   * 「这条记录的当前内容**仍然是它**吗」的身份快路径 —— **预览与执行共用同一条判据**
   * （否则「预览说会改的 = 实际会改的」这条不变式会被打破）。
   *
   * 判据：路径身份（dev:ino:size:mtimeNs:ctimeNs:mode）命中**身份缓存**，且缓存里的 sha/bytes 与记录一致。
   * 身份未变 ⇒ 内容未变：缓存里的 sha 就是**这份内容**在留点那一次真读出来的哈希（身份含 size/mtimeNs/
   * ctimeNs/ino/dev/mode，改内容必动 mtime/ctime，Windows 上 user 代码改不了 ctime）。
   * 任何一环拿不到（读不到身份 / 缓存没有该身份 / sha 或 bytes 不同）⇒ false，调用方回落「真读 + 哈希」。
   *
   * 为什么必须有它：大仓库一次预览/回退要判 3 万+ 条目，逐个真读等于把整个工作区读两遍
   * （真机 34k 文件 / 609 MiB：预览 14.2 s 里 13 s 全在这，回退 60 s+ 同理）。**记录的指纹被篡改**
   * 时本判据必然不成立（缓存的 sha 是真算出来的）⇒ 仍走真读 + 哈希的旧路径，护栏不退化。
   */
  private async unchangedByIdentity(file: RollbackWorkspaceFile, identity: string | null): Promise<boolean> {
    if (identity === null) return false
    const cached = await this.lookupCachedFile(identity, file.path)
    return cached !== null && cached.sha256 === file.sha256 && cached.bytes === file.bytes
  }

  private async lookupCachedFile(identity: string, target: string): Promise<{ sha256: string; bytes: number } | null> {
    const cache = await this.loadPathCache()
    const hit = cache.get(identity)
    if (hit === undefined || hit.path !== target) return null
    return { sha256: hit.sha256, bytes: hit.bytes }
  }

  private async rememberCachedFile(identity: string, target: string, sha256: string, bytes: number): Promise<void> {
    const cache = await this.loadPathCache()
    cache.set(identity, { path: target, sha256, bytes })
  }

  /** 缓存落盘（best-effort：写失败只意味着下次全量读，绝不影响留点成败） */
  private async persistPathCache(): Promise<void> {
    if (this.pathCache === null) return
    try {
      await fs.mkdir(this.root, { recursive: true })
      const entries: Record<string, RollbackPathCacheEntry> = {}
      for (const [identity, entry] of this.pathCache) entries[identity] = entry
      await atomicWriteFile(this.pathCachePath(), JSON.stringify({ version: ROLLBACK_PATH_CACHE_VERSION, entries }, null, 2))
    } catch (error) {
      this.warn('rollback path cache persist failed: ' + errorDetail(error))
    }
  }

  /**
   * 缓存随引用回收：台账里没有任何回滚点引用的路径，其条目一律清掉（不无界增长）。
   * 注意判据是**路径**（缓存条目自带 path 字段），而不是内容哈希。
   */
  private async gcPathCache(referencedPaths: ReadonlySet<string>): Promise<void> {
    const cache = this.pathCache
    if (cache === null) return
    let dropped = false
    for (const [identity, entry] of [...cache]) {
      if (referencedPaths.has(pathKey(entry.path))) continue
      cache.delete(identity)
      dropped = true
    }
    if (dropped) await this.persistPathCache()
  }

  /** 拒删成因的如实说明（没有可解释成因时返回空数组，绝不编理由） */
  private createdRefusalWarnings(payload: RollbackWorkspacePayload): RollbackGuidance[] {
    const out: RollbackGuidance[] = []
    if (payload.ignoreIncomplete === true) {
      out.push({ code: 'rollback.warn.createdRefused', detail: 'ignore-dirs' })
      return out
    }
    if (payload.walkIncomplete === true) {
      out.push({ code: 'rollback.warn.createdRefused', detail: 'walk-incomplete' })
      return out
    }
    if (payload.skippedTruncated && (payload.pathIndex === null || payload.pathIndex === undefined)) {
      out.push({ code: 'rollback.warn.createdRefused', detail: 'path-index-missing' })
      return out
    }
    if (payload.unreadableDirs.length > 0) {
      out.push({ code: 'rollback.warn.createdRefused', detail: 'unreadable-dirs' })
      return out
    }
    return out
  }

  /* -------------------------------------------------------------- 台账 */

  /**
   * 读台账**清单**（只读元数据 + 段摘要；代价与工作区文件数**无关**）。
   *
   * 与 v2 的差别只在实现：v2 每回合把整份 index.json 读进内存并 parse（473 MB 那条路），
   * v3 读的是一份小清单。**外部语义一个字没变**：返回 entries + 同一套 error 文案。
   * 启动期初始化失败时如实回报（不读 v2 文件、不假装台账为空）。
   */
  private async readManifest(): Promise<{ entries: RollbackLedgerManifestEntry[]; error?: string }> {
    await this.ensureReady()
    if (this.initError !== undefined) return { entries: [], error: this.initError }
    return await this.ledger.readManifest()
  }

  /**
   * 读**完整**记录（引用解析对调用方透明）。失败一律如实回报，**绝不返回半个记录**：
   * 载荷缺失 / 哈希不符 / 形状不符 ⇒ error（调用方走 record-incomplete 路径）。
   */
  private async readFullRecord(id: string): Promise<{ record?: RollbackPointRecord; error?: string }> {
    await this.ensureReady()
    if (this.initError !== undefined) return { error: this.initError }
    return await this.ledger.readRecord(id)
  }

  /**
   * S6 淘汰（t14 冻结 + 2026-10-12 guard 全局上限）：三类点各按各的预算裁，**只删最旧的**。
   *
   * | 类别 | 预算 | 说明 |
   * |---|---|---|
   * | auto 自动点 | 每会话 `maxRecordsPerSession`（20）→ 全局 `maxRecords`（50） | 两次裁剪都只删最旧 |
   * | guard 救援点 | 每会话 `maxGuardsPerSession`（20）→ 全局 `maxGuards`（`ROLLBACK_MAX_GUARDS`，50） | **不占**自动点预算、**不受**自动点的 20/50 影响；用户删不掉 ⇒ 必须有自己的两道预算（单会话挡住不够，跨会话也要收敛） |
   * | protected 点 | 无上限（只进不出） | 生产路径**造不出来**（capture 端点已下线、tracker 从不设 protect），只有测试能造 |
   */
  /**
   * 条数淘汰（口径与 v2 逐字相同，只是从「记录」换成「清单条目」）：三类点各按各的预算裁，**只删最旧的**。
   *
   * | 类别 | 预算 | 说明 |
   * |---|---|---|
   * | auto 自动点 | 每会话 maxRecordsPerSession（20）→ 全局 maxRecords（50） | 两次裁剪都只删最旧 |
   * | guard 救援点 | 每会话 maxGuardsPerSession（20）→ 全局 maxGuards（ROLLBACK_MAX_GUARDS，50） | **不占**自动点预算、**不受**自动点的 20/50 影响；用户删不掉 ⇒ 必须有自己的两道预算（单会话挡住不够，跨会话也要收敛） |
   * | protected 点 | 无上限（只进不出） | 生产路径**造不出来**（capture 端点已下线、tracker 从不设 protect），只有测试能造 |
   */
  private selectPruneEntries(entries: readonly RollbackLedgerManifestEntry[]): { kept: RollbackLedgerManifestEntry[]; removed: string[] } {
    const kept: RollbackLedgerManifestEntry[] = []
    const guards: RollbackLedgerManifestEntry[] = []
    const prunable: RollbackLedgerManifestEntry[] = []
    for (const entry of entries) {
      if (entry.protected) kept.push(entry)
      else if (entry.kind === 'guard') guards.push(entry)
      else prunable.push(entry)
    }
    // 最新在前（下面三类裁剪共用同一排序口径）
    const newestFirst = (a: RollbackLedgerManifestEntry, b: RollbackLedgerManifestEntry): number =>
      a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0
    // guard：先每会话各自保留最近 maxGuardsPerSession 个，再全局保留最近 maxGuards 个
    // （guards 已按 newestFirst 排序，withinGuardSession 保持同序 ⇒ 两轮裁掉的都是「最旧的」）
    guards.sort(newestFirst)
    const guardsPerSession = new Map<string, number>()
    const withinGuardSession: RollbackLedgerManifestEntry[] = []
    for (const entry of guards) {
      const key = entry.sessionId ?? ''
      const used = guardsPerSession.get(key) ?? 0
      if (used >= this.maxGuardsPerSession) continue
      guardsPerSession.set(key, used + 1)
      withinGuardSession.push(entry)
    }
    kept.push(...withinGuardSession.slice(0, Math.max(0, this.maxGuards)))
    // 自动点：先每会话上限，再全局上限
    prunable.sort(newestFirst)
    const perSession = new Map<string, number>()
    const withinSession: RollbackLedgerManifestEntry[] = []
    for (const entry of prunable) {
      const key = entry.sessionId ?? ''
      const used = perSession.get(key) ?? 0
      if (used >= this.maxRecordsPerSession) continue
      perSession.set(key, used + 1)
      withinSession.push(entry)
    }
    kept.push(...withinSession.slice(0, Math.max(0, this.maxRecords)))
    const keptIds = new Set(kept.map((r) => r.id))
    const removed = entries.filter((r) => !keptIds.has(r.id)).map((r) => r.id)
    return { kept, removed }
  }

  /**
   * 字节预算淘汰（issue #89 的**根因修复**）：条数没超、字节超了照样会 OOM。
   *
   * 判据与条数淘汰共用同一类别口径：**只淘汰最旧的 auto 点**（guard / protected 永不淘汰）。
   * 释放量按「记录文件字节 + 载荷**最后一个引用**消失时的载荷字节」估算（引用计数靠清单，不读载荷）。
   * 返回淘汰后的清单（调用方负责落盘与删文件）。
   */
  private async applyByteBudget(
    all: readonly RollbackLedgerManifestEntry[],
    keptInput: readonly RollbackLedgerManifestEntry[],
    extraBytes: number,
    protectedNewId: string | null,
  ): Promise<RollbackLedgerManifestEntry[]> {
    const kept = [...keptInput]
    // 基线口径（**精确**，不用估算）：当前磁盘字节 - 本次已定要删的条目所占字节 + 本次新增字节。
    // 「已定要删」= 条数淘汰掉的（它们的文件马上会被删），所以不能拿 stats.bytes 当基线。
    const keptIds = new Set(kept.map((entry) => entry.id))
    const keptPayloads = new Set<string>()
    for (const entry of kept) {
      if (entry.workspace.payload !== null) keptPayloads.add(entry.workspace.payload)
    }
    let freed = 0
    const freedPayloads = new Set<string>()
    for (const entry of all) {
      if (keptIds.has(entry.id)) continue
      freed += entry.recordBytes
      const hash = entry.workspace.payload
      if (hash !== null && !keptPayloads.has(hash) && !freedPayloads.has(hash)) {
        freedPayloads.add(hash)
        freed += entry.workspace.payloadBytes
      }
    }
    const stats = await this.ledger.stats()
    let bytes = stats.bytes - freed + extraBytes
    if (bytes <= this.ledgerBytesBudget) return kept
    const refs = new Map<string, number>()
    for (const entry of kept) {
      const hash = entry.workspace.payload
      if (hash !== null) refs.set(hash, (refs.get(hash) ?? 0) + 1)
    }
    const candidates = kept
      .filter((entry) => !entry.protected && entry.kind === 'auto' && entry.id !== protectedNewId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    const victims = new Set<string>()
    for (const entry of candidates) {
      if (bytes <= this.ledgerBytesBudget) break
      victims.add(entry.id)
      const index = kept.findIndex((item) => item.id === entry.id)
      if (index >= 0) kept.splice(index, 1)
      bytes -= entry.recordBytes
      const hash = entry.workspace.payload
      if (hash !== null) {
        const left = (refs.get(hash) ?? 1) - 1
        refs.set(hash, left)
        if (left <= 0) bytes -= entry.workspace.payloadBytes
      }
    }
    if (victims.size === 0) {
      // 一条都淘汰不了却仍然超预算（典型：单条点自身的体积就大于预算）—— **如实留痕**。
      // 不写这一条，「预算生效」就是假象（竞品 dsh-checkpoint-rewind #35 正是「软配额 bound
      // 不住单条」的口子）；界面侧由 RollbackLedgerStatus.overBudget 如实上屏。
      if (bytes > this.ledgerBytesBudget) {
        this.warn('rollback ledger over budget: nothing prunable bytes=' + String(bytes) + ' budget=' + String(this.ledgerBytesBudget))
      }
      return kept
    }
    this.ledger.markEvicted(victims.size)
    this.warn('rollback ledger over budget: evicted=' + String(victims.size) + ' bytes=' + String(bytes) + ' budget=' + String(this.ledgerBytesBudget))
    return kept
  }

  /**
   * 对象仓回收（**重写版**，issue #89）：账本字节数不再进内存。
   *
   * 旧实现要从「内存里所有记录的全部 files 数组」累计引用 ⇒ 回收一次 = 把整份台账读进内存。
   * 现在：扫**清单** -> 逐个读引用到的**载荷文件**（一次只驻留一份）-> 累计 referenced 对象键 -> 扫 objects/。
   * 峰值内存 ∝ 单份载荷 + 对象键集合，**不 ∝ 台账总字节**。
   * 任何一份被引用的载荷读不出来 ⇒ 整体放弃回收（fail-closed：读不到的载荷里有什么对象谁也不知道）。
   */
  private async gcObjects(entries: readonly RollbackLedgerManifestEntry[]): Promise<void> {
    const result = await this.ledger.collectObjects(entries)
    if (result.aborted !== null) {
      this.warn('rollback gc skipped: ' + result.aborted)
      return
    }
    // 路径身份缓存随引用回收：没有任何回滚点引用的路径不留条目（不无界增长）
    await this.gcPathCache(new Set([...result.referencedPaths].map(pathKey)))
  }

  /**
   * 把记录写进台账（**留点侧唯一写入口**）：整段「读全文 → 合并 → S6 淘汰 → 原子写 → 回收对象」
   * 都在 {@link withLedgerWriteLock} 的进程内串行队列里 —— 绝不与 tracker / 路由的另一次写交错。
   */
  /**
   * 写一条记录（**最多三次尝试**）—— 跨进程乐观并发（①B）。
   *
   * dataDir 由 `$DSH_HOME` 决定、**不随 profile 分家**（与本插件自带的实例锁同一套多实例假设），
   * 所以「另一个 DSH 实例正在写同一份清单」是设计内的场景，而 `withLedgerWriteLock` 只串行本进程。
   * 策略：读清单前后各取一次**代际戳**，被改过就重读重试；三次都变 ⇒ **放弃本次留点并 warn**，
   * 绝不拿自己的快照覆盖别人的清单（宁可少一条点，也不丢别人的点）。
   * 诚实的边界：检测与写入之间仍有极小窗口，无跨进程锁时无法彻底消除 —— 这里保证的是
   * 「不静默覆盖 + 尽量合并」，不是原子性。
   */
  /**
   * 把工作区载荷改写成**增量视图**（相对最近一个同分块的点）——清单增量化，省的是磁盘，不是语义。
   *
   * 判据与安全边界（逐条）：
   *  · 基准 = 清单里最近一个 `workspace.payload` 非空、**分块完全相同**的点（只试最近几个，代价有界）；
   *  · 增量 = 「相对基准新增 / 改写的条目」+「基准里不再存在的路径」，条目**逐字比较**（同形绝对路径）；
   *  · 只有增量明显更小（< 全量的 60%）才用；否则原样全量落盘；
   *  · 读路径由 ledger 物化（`resolvePayload`）⇒ 预览 / 回退 / 回收看到的永远是完整清单；
   *  · 基准读不出来 / 分块对不上 / 任何异常 ⇒ 原样全量（绝不因为省字节而让点不可用）；
   *  · 基准载荷的保活由 ledger 的 `payloadChain` 负责（淘汰时不会把基准删掉）。
   */
  private async storagePlanFor(
    record: RollbackPointRecord,
    entries: readonly RollbackLedgerManifestEntry[],
  ): Promise<{ record: RollbackPointRecord; reuse: { hash: string; bytes: number; chain: string[] } | null }> {
    const full = { record, reuse: null }
    const payload = record.workspace.payload
    if (payload === null || record.workspace.ok !== true || payload.files.length === 0) return full
    if (payload.delta !== undefined) return full
    // 基准 = **本进程上一次成功留点**的内存摘要（绝不读别人的载荷/记录文件：L-08 / issue #89）。
    // 没有摘要（进程刚起 / 分块变了）⇒ 这一次落**全量锚点**，随后由摘要继续链下去。
    const base = this.deltaBase
    if (base !== null && sameChunks(base.chunks, payload.chunks)) {
      const diff = payloadDiffAgainstDigest(payload, base.entries)
      if (diff.added.length === 0 && diff.removed.length === 0) {
        // 工作区与该点**逐条相同** ⇒ 直接复用它的载荷文件（零额外字节、链不增长）
        const entry = entries.find((candidate) => candidate.workspace.payload === base.hash)
        if (entry !== undefined && (await this.ledger.hasPayload(base.hash))) {
          return { record, reuse: { hash: base.hash, bytes: entry.workspace.payloadBytes, chain: [...base.chain] } }
        }
      } else if (base.chain.length < ROLLBACK_DELTA_CHAIN_LIMIT) {
        const delta = buildPayloadDelta(payload, base.hash, base.chain, diff)
        if (delta !== null) {
          return {
            record: { ...record, workspace: { ...record.workspace, payload: compactPayloadForStorage(delta) } },
            reuse: null,
          }
        }
      }
    }
    // 没有可用基准 / 分块不同 / 增量不划算 ⇒ 全量落盘（仍省掉冗余的 object 字段）
    return {
      record: { ...record, workspace: { ...record.workspace, payload: compactPayloadForStorage(payload) } },
      reuse: null,
    }
  }

  /** 记下这份点作为下一次留点的增量基准（内存摘要，见 {@link deltaBase}） */
  private rememberDeltaBase(record: RollbackPointRecord, prepared: RollbackLedgerPrepared): void {
    const payload = record.workspace.payload
    const hash = prepared.payloadHash
    if (payload === null || hash === null) {
      this.deltaBase = null
      return
    }
    const entries = new Map<string, string>()
    for (const file of payload.files) entries.set(file.path, digestKeyOf(file))
    this.deltaBase = {
      hash,
      chain: prepared.entry.workspace.payloadChain ?? [hash],
      chunks: [...payload.chunks],
      entries,
    }
  }

  private async appendRecord(record: RollbackPointRecord): Promise<{ ok: boolean; detail?: string }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.appendRecordOnce(record)
      if (result.conflict !== true) {
        return result.detail !== undefined ? { ok: result.ok, detail: result.detail } : { ok: result.ok }
      }
    }
    this.warn('rollback ledger busy: another instance kept changing the manifest (auto point skipped)')
    return { ok: false, detail: 'ledger-busy: manifest changed by another instance' }
  }

  /** `appendRecord` 的单次尝试；`conflict: true` = 这期间清单被别的实例改过，调用方应当重试。 */
  private async appendRecordOnce(record: RollbackPointRecord): Promise<{ ok: boolean; detail?: string; conflict?: boolean }> {
    return await withLedgerWriteLock(this.ledgerPath, async () => {
      // 读之前先取一次代际戳（不参与锁：它天生是跨进程的探针）
      const stampBefore = await this.ledger.manifestStamp()
      let manifest = await this.readManifest()
      if (this.initError !== undefined) {
        // 台账还有 v2 没迁完（或迁移失败）：**拒写**，绝不覆盖原文件（下次启动重试）
        return { ok: false, detail: this.initError }
      }
      if (manifest.error !== undefined) {
        // 清单**读不出来**：先**从 records/ 重建**（旧点的最终真相在记录文件里），
        // 而不是拿一个空 entries 覆盖 —— 后者会把旧点整批从清单抹掉，紧接着 prunePayloads
        // 还会删掉它们的载荷 ⇒ 永久不可恢复。重建后**仍**读不出来才拒写（fail-closed）。
        manifest = await this.ledger.recoverManifest()
        if (manifest.error !== undefined) {
          return { ok: false, detail: 'ledger unreadable: ' + manifest.error }
        }
      }
      // 清单增量化：能省就把这份载荷改写成「相对最近一个同分块载荷的增量」（读路径由 ledger 物化回来）。
      // 失败 / 不划算 / 没有可用基准一律**原样返回** —— 增量只影响磁盘占用，绝不参与正确性判断。
      const storage = await this.storagePlanFor(record, manifest.entries)
      const prepared = this.ledger.prepareRecord(storage.record, storage.reuse ?? undefined)
      const merged = [prepared.entry, ...manifest.entries.filter((r) => r.id !== record.id)]
      const pruned = this.selectPruneEntries(merged)
      // 本次新增字节：记录文件 + **首次落盘**的载荷（同一工作区态已存在 ⇒ 零额外字节）
      const payloadIsNew = prepared.payloadHash !== null && !(await this.ledger.hasPayload(prepared.payloadHash))
      const extraBytes = prepared.entry.recordBytes + (payloadIsNew ? prepared.entry.workspace.payloadBytes : 0)
      // 刚写入的这一条不参与本轮字节淘汰（否则 capturePoint 会回一个台账里查不到的幽灵点）
      const kept = await this.applyByteBudget(merged, pruned.kept, extraBytes, prepared.entry.id)
      kept.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
      // 写之前复核：这份清单在这期间有没有被别的实例改过？改过就**不写**，交给调用方重读重试。
      // 读不出代际戳（任一时刻为 null）⇒ 不参与判定、照常写 —— 绝不因为一个可选探针失败就拒绝留点。
      const stampAfter = await this.ledger.manifestStamp()
      if (stampBefore !== null && stampAfter !== null && stampBefore !== stampAfter) {
        return { ok: false, conflict: true, detail: 'manifest changed by another instance' }
      }
      try {
        await fs.mkdir(this.root, { recursive: true })
        await this.ledger.writePrepared(prepared)
      } catch (error) {
        return { ok: false, detail: errorDetail(error) }
      }
      try {
        await this.ledger.writeManifest(kept)
      } catch (error) {
        // 清单没写成 ⇒ 这一条**不算落进台账**：撤掉刚落的记录文件与无人引用的载荷（不留半截）
        await this.ledger.deleteRecords([prepared.entry.id])
        await this.ledger.prunePayloads(manifest.entries)
        return { ok: false, detail: errorDetail(error) }
      }
      // 记下「这次留点」作为下一次的增量基准（只在真正写成功后；失败不更新 ⇒ 链只跨成功落盘的点）
      this.rememberDeltaBase(record, prepared)
      const keptIds = new Set(kept.map((entry) => entry.id))
      const dropped = merged.filter((entry) => !keptIds.has(entry.id)).map((entry) => entry.id)
      await this.ledger.deleteRecords(dropped)
      await this.ledger.prunePayloads(kept)
      // **只在真的淘汰了记录时**才扫对象仓：对象回收需要逐份读被引用的载荷（代价 ∝ 载荷总量），
      // 而没有淘汰时不可能产生无人引用的对象 —— 每回合都扫一遍等于把「读全账本」搬进了留点热路径
      // （issue #89 正是要消灭这条路）。删除点 / 预算淘汰 / 清理入口都会走到这里。
      if (dropped.length > 0) await this.gcObjects(kept)
      return { ok: true }
    })
  }

  /* -------------------------------------------------------------- 留点 */

  /**
   * 留一个回滚点（宿主自动留点 / 恢复前救援点 / 测试构造都走这一条）。
   * 没有 HTTP capture 端点 —— 手动「拍点」已随规格 S1 下线。
   */
  async capturePoint(input: RollbackPointInput = {}): Promise<RollbackCaptureResult> {
    const storage = await this.storageStatus()
    if (!storage.available) {
      return { ok: false, code: 'storage-unavailable', detail: storage.detail, guidance: storage.guidance, storage }
    }
    const createdAt = this.stamp()
    const kind: RollbackPointKind = input.kind === 'guard' ? 'guard' : 'auto'
    const chunks = (input.chunks ?? []).filter((c): c is string => typeof c === 'string' && c !== '')
    const session = await this.captureSession({
      sessionId: typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null,
      logPath: typeof input.sessionLogPath === 'string' && input.sessionLogPath !== '' ? input.sessionLogPath : null,
      cursorSeq: typeof input.cursorSeq === 'number' && Number.isFinite(input.cursorSeq) ? input.cursorSeq : null,
      turnSeq: typeof input.turnSeq === 'number' && Number.isFinite(input.turnSeq) ? input.turnSeq : null,
      boundarySeq: typeof input.boundarySeq === 'number' && Number.isFinite(input.boundarySeq) ? input.boundarySeq : null,
      boundaryEndSeq: typeof input.boundaryEndSeq === 'number' && Number.isFinite(input.boundaryEndSeq) ? input.boundaryEndSeq : null,
    })
    const workspace = await this.captureWorkspace(chunks, input.signal)
    const spreadMs = Math.abs(session.capturedAt - workspace.capturedAt)
    const record: RollbackPointRecord = {
      schemaVersion: ROLLBACK_SCHEMA_VERSION,
      id: newPointId(createdAt),
      kind,
      createdAt,
      spreadMs,
      protected: input.protect === true && kind !== 'guard',
      incomplete: !(session.ok && workspace.ok),
      note: typeof input.note === 'string' && input.note !== '' ? input.note : null,
      sessionId: session.payload?.sessionId ?? null,
      unitId: typeof input.unitId === 'string' && input.unitId !== '' ? input.unitId : null,
      turnSeq: session.payload?.turnSeq ?? null,
      boundarySeq: session.payload?.boundarySeq ?? null,
      workspace,
      session,
    }
    const stored = await this.appendRecord(record)
    if (!stored.ok) {
      // T10（S5 安全链）：台账**真的没写进去** ⇒ 不返回这个内存 record。
      // 旧实现把它一起返回，消费方（rewind 的救援点 / tracker）拿 `point.id` 当「留点成功」，
      // 于是对外报出一个台账里根本查不到的**幽灵 id**。判据只有一条：appendRecord 真的成功。
      return { ok: false, code: 'ledger-write-failed', detail: stored.detail, guidance: [], storage }
    }
    return { ok: true, code: 'ok', point: record, guidance: [], storage }
  }

  /* ------------------------------------------------- fork 继承链（t9） */

  /**
   * 活会话登记时喂进来的 fork 关系（宿主每见一个会话对象调一次；非 fork 子会话不记）。
   *
   * 为什么需要：磁盘扫描只覆盖**台账里有点的项目键**，而「本次运行里刚 fork 出来的子会话」
   * 必须立刻可用（否则用户刚回退完、打开子会话还是灰的）。
   */
  noteSessionBinding(binding: RollbackSessionBinding): void {
    const parent = binding.parentSessionId
    if (binding.forked !== true || typeof parent !== 'string' || parent === '') return
    if (parent === binding.sessionId) return
    this.forkLinks.set(binding.sessionId, parent)
  }

  /** 沿继承链**只上溯**（环保护 + 深度上限）；返回祖先 id 列表（不含起点）。 */
  ancestorIdsOf(sessionId: string): string[] {
    const out: string[] = []
    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let depth = 0; depth < ROLLBACK_ANCESTOR_MAX_DEPTH; depth += 1) {
      const parent = this.forkLinks.get(current)
      if (parent === undefined || seen.has(parent)) break
      seen.add(parent)
      out.push(parent)
      current = parent
    }
    return out
  }

  /** 台账快照（TTL；继承判据用 —— 只读、失败按空台账处理，绝不因此拒绝留点）。 */
  private async ledgerSnapshot(): Promise<RollbackLedgerManifestEntry[]> {
    const now = this.stamp()
    if (this.ledgerSnapshotCache !== null && now - this.ledgerSnapshotCache.at < ROLLBACK_INHERITED_LEDGER_TTL_MS) {
      return this.ledgerSnapshotCache.entries
    }
    const ledger = await this.readManifest()
    this.ledgerSnapshotCache = { at: now, entries: ledger.entries }
    return ledger.entries
  }

  /**
   * 本会话/本回合**没有自己的点**时，沿继承链找祖先的同回合点（t9 的判据层）。
   *
   * 只上溯、带环保护与深度上限；返回 null = 链上没有（祖先没有点 / 不是继承子会话）——
   * 调用方（留点器）据此区分「继承回合」与「本会话自己的新回合」。
   */
  async ancestorPointForTurn(sessionId: string, turn: number): Promise<RollbackPointSummary | null> {
    if (!Number.isFinite(turn)) return null
    const ancestors = this.ancestorIdsOf(sessionId)
    if (ancestors.length === 0) return null
    const records = await this.ledgerSnapshot()
    for (const ancestor of ancestors) {
      const hit = records.find((r) => r.sessionId === ancestor && r.turnSeq === turn)
      if (hit !== undefined) return entrySummaryOf(hit)
    }
    return null
  }

  /** 读会话日志头（带 mtime + size 缓存；失败缓存 null，不反复打盘）。 */
  private async readForkHeaderCached(logPath: string): Promise<SessionForkHeader | null> {
    let info: Awaited<ReturnType<typeof fs.stat>> | null = null
    try { info = await fs.stat(logPath) } catch { info = null }
    if (info === null) return null
    const cached = this.forkHeaderCache.get(logPath)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.header
    const header = await readSessionForkHeader(logPath)
    this.forkHeaderCache.set(logPath, { mtimeMs: info.mtimeMs, size: info.size, header })
    return header
  }

  /**
   * 补齐继承链：扫「台账里有点的项目键」下的会话目录，登记 fork 子会话 → 父会话。
   *
   * 为什么只扫这些项目键：继承点解析只对「**祖先有回滚点**」的子会话有意义（祖先没有点 ⇒ 解析不出
   * 任何东西），而 fork 子会话与父会话在**同一个项目键**下（fork 不改 cwd）⇒ 覆盖这点就够了。
   * 台账空 ⇒ 直接返回（零扫描，热路径零代价）；结果按 {@link ROLLBACK_FORK_LINKS_TTL_MS} 缓存。
   */
  private async refreshForkLinks(entries: readonly RollbackLedgerManifestEntry[]): Promise<void> {
    const now = this.stamp()
    if (this.forkLinksAt !== 0 && now - this.forkLinksAt < ROLLBACK_FORK_LINKS_TTL_MS) return
    this.forkLinksAt = now
    const projectKeys = new Set<string>()
    for (const entry of entries) {
      const key = unitProjectKeyOf(entry.unitId)
      if (key !== null) projectKeys.add(key)
    }
    if (projectKeys.size === 0) {
      this.forkLinksComplete = true
      return
    }
    let reads = 0
    let complete = true
    for (const projectKey of projectKeys) {
      if (!complete) break
      const dir = path.join(this.sessionsRoot, projectKey)
      // 只用到 name / isDirectory（Dirent 的结构子集；不引 node:fs 的 Dirent 泛型，免得 Buffer 变体打架）
      let entries: Array<{ name: string; isDirectory(): boolean }>
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        continue // 项目目录不在了（会话被清理）：跳过，不影响其余项目
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (reads >= ROLLBACK_FORK_LINKS_MAX_READS) { complete = false; break }
        const sessionDir = path.join(dir, entry.name)
        let names: string[]
        try { names = await fs.readdir(sessionDir) } catch { continue }
        const logs = names.filter((name) => isSessionLogName(name)).sort()
        const picked = logs[logs.length - 1]
        if (picked === undefined) continue
        reads += 1
        const header = await this.readForkHeaderCached(path.join(sessionDir, picked))
        if (header === null || header.parentSessionId === null || !header.forked) continue
        if (header.parentSessionId === header.id) continue
        this.forkLinks.set(header.id, header.parentSessionId)
      }
    }
    this.forkLinksComplete = complete
  }

  /**
   * `list()` 里为 fork 子会话补的**继承视图**条目（t9）。
   *
   * 为什么必须补：**不属于本任务 scope 的匹配器**（`RollbackReviewDialog` 的 `findPointForTurn`）
   * 只认「`sessionId` + `turn` 同时相等」—— 不补的话，入口按钮亮了、点开对话框却说「没有回滚点」。
   * 条目语义（**不是幽灵点**）：
   *  · 与祖先点**同一个 id**：preview / rewind / remove 全部作用在原点 ⇒ 回退仍在原会话上做 fork
   *    （`boundarySeq` 也来自原点），与今天的语义逐字相同；
   *  · 台账**不写任何记录**（只在只读列表里成景），状态全部来自祖先的真实捕获；
   *  · `inheritedFrom` / `inheritedSessionId` 如实标出它的来处。
   * 有界（{@link ROLLBACK_INHERITED_VIEW_MAX}），超出如实标记。
   */
  private inheritedViews(manifest: readonly RollbackLedgerManifestEntry[]): { entries: RollbackPointSummary[]; truncated: boolean } {
    const entries: RollbackPointSummary[] = []
    let truncated = false
    const ownTurnsOf = (sessionId: string): Set<number> => {
      const out = new Set<number>()
      for (const entry of manifest) {
        if (entry.sessionId === sessionId && entry.turnSeq !== null) out.add(entry.turnSeq)
      }
      return out
    }
    for (const child of this.forkLinks.keys()) {
      const chain = this.ancestorIdsOf(child)
      if (chain.length === 0) continue
      const own = ownTurnsOf(child)
      // 多代链（A→B→D）里同一个回合可能同时存在于多个祖先：**只取最近的那个**。
      // 没有这份集合时，D 会拿到两条 (sessionId=D, turn=N) 却指向**不同状态**的记录，
      // 客户端取第一条时结果随祖先顺序漂移。chain 由近到远 ⇒ 先到先得。
      const pickedTurns = new Set<number>()
      for (const ancestor of chain) {
        for (const entry of manifest) {
          if (entry.sessionId !== ancestor || entry.turnSeq === null) continue
          if (own.has(entry.turnSeq)) continue // 本会话自己有这一回合的点 ⇒ 用自己那个
          if (pickedTurns.has(entry.turnSeq)) continue // 更近的祖先已经提供过这一回合
          if (entries.length >= ROLLBACK_INHERITED_VIEW_MAX) { truncated = true; break }
          pickedTurns.add(entry.turnSeq)
          entries.push({
            // 段摘要来自清单里**写入时算好**的那份（口径仍是 summarizeRollbackPoint）
            ...entrySummaryOf(entry),
            sessionId: child,
            unitId: childUnitIdOf(entry.unitId, child),
            inheritedFrom: entry.id,
            inheritedSessionId: entry.sessionId,
          })
        }
        if (truncated) break
      }
      if (truncated) break
    }
    return { entries, truncated }
  }

  /* -------------------------------------------------------------- 列 / 读 */

  async list(): Promise<RollbackListResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readManifest()
    await this.refreshForkLinks(ledger.entries)
    // v3：列表**只读清单**（元数据 + 写入时算好的段摘要）—— 一个记录文件都不读（issue #89 的内存护栏）
    const points = [...ledger.entries]
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
      .map(entrySummaryOf)
    const inherited = this.inheritedViews(ledger.entries)
    const out: RollbackListResult = {
      ok: storage.available,
      storage,
      points: inherited.entries.length === 0 ? points : [...points, ...inherited.entries],
      maxRecords: this.maxRecords,
      maxRecordsPerSession: this.maxRecordsPerSession,
      maxGuards: this.maxGuards,
      inheritLinks: Object.fromEntries(this.forkLinks),
      inheritLinksComplete: this.forkLinksComplete,
    }
    if (inherited.truncated) out.inheritedViewTruncated = true
    if (ledger.error !== undefined) out.error = ledger.error
    return out
  }

  async read(id: string): Promise<{ point?: RollbackPointRecord; records: RollbackPointRecord[]; error?: string; storage: RollbackStorageStatus }> {
    const storage = await this.storageStatus()
    const ledger = await this.readManifest()
    const entry = ledger.entries.find((r) => r.id === id)
    // v3：records 只回传命中的那一条 —— 调用方只用 point；逐条读全部记录文件是不可接受的代价
    const out: { point?: RollbackPointRecord; records: RollbackPointRecord[]; error?: string; storage: RollbackStorageStatus } = {
      records: [],
      storage,
    }
    let error = ledger.error
    if (entry !== undefined) {
      const resolved = await this.readFullRecord(entry.id)
      if (resolved.record !== undefined) {
        out.point = resolved.record
        out.records = [resolved.record]
      } else if (resolved.error !== undefined) {
        error = error === undefined ? resolved.error : error + '; ' + resolved.error
      }
    }
    if (error !== undefined) out.error = error
    return out
  }

  /* -------------------------------------------------------------- 预览 */

  /**
   * 预览的**单条只读判定**（阶段 A，可并发跑）：一次 bigint lstat + 身份快路径。
   * `unchanged = true` 表示「已证明与记录一致」（身份命中身份缓存且 sha/bytes 相同）⇒ 调用方直接跳过。
   */
  private async previewScan(file: RollbackWorkspaceFile): Promise<PreviewScanResult> {
    try {
      // **lstat，不是 stat**：写入侧用 `symlink:'reject'`（lstat 是链接即抛），预览若跟随链接就会
      // 说「会创建 / 会覆盖」，执行却整段失败 —— 两侧必须是同一个口径。链接一律按「不可写」报。
      const stat = await fs.lstat(file.path, { bigint: true })
      if (stat.isSymbolicLink()) return { kind: 'unavailable' }
      const size = Number(stat.size)
      const regular = stat.isFile()
      const unchanged = regular && size === file.bytes
        && (await this.unchangedByIdentity(file, regular ? fileIdentityOf(stat) : null))
      return { kind: 'ok', size, regular, unchanged }
    } catch (error) {
      return classifyPreviewStatFailure(error) === 'missing' ? { kind: 'missing' } : { kind: 'unavailable' }
    }
  }

  private trackWarnings(record: RollbackPointRecord): RollbackGuidance[] {
    const out: RollbackGuidance[] = []
    for (const track of [record.workspace, record.session]) {
      if (!track.ok) {
        out.push({ code: 'rollback.warn.trackMissing', detail: track.kind + ' ' + String(track.reasonCode ?? '') })
        continue
      }
      if (track.degraded && track.reasonCode !== null) {
        out.push({ code: 'rollback.warn.trackDegraded', detail: track.kind + ' ' + track.reasonCode })
      }
    }
    if (record.protected) out.push({ code: 'rollback.warn.protected', detail: record.id })
    return out
  }

  /**
   * 「证明为留点之后新建」的完整规划 —— 预览（`preview`）与执行（`restoreWorkspace`）**共用这一份**。
   *
   * 为什么必须只有一份：旧实现两处各算一次删除口径 —— 预览用只按「未记录 + 在 chunks 内」
   * 过滤、且只取前 `ROLLBACK_LEFTOVER_LIST_LIMIT` 条、**不过滤拒删项**的清单；执行用
   * 「全量 + 过安全判据」的清单。于是预览里混进**永远不会删**的 `.git` 路径，又漏掉第 21 条
   * 之后**真的会删**的路径 —— 跳过的回合越多，两个集合差得越远（用户 2026-10-12 实测：
   * 预览列 20 条 = 3 条 .git（不会删）+ 17 条会删；实际删 25 条 ⇒ 8 条会删的没被列出）。
   *
   * 三条判据都在这里一次算清（预览与执行逐条同源）：
   *  ① **证明**（方向 A+B）：候选 = 当前存在、在分块内、且不在证明名单里的路径 —— 证明名单 =
   *     `files` ∪ `skipped` ∪ `unreadableFiles` ∪ `excludedDirs` ∪ **路径索引**（`payload.pathIndex`，
   *     捕获时走查过的全部路径）。证明名单**不完整时一条都不删**（只有两种情形：名单被记录上限截断
   *     而索引缺失/读不出、有读不出的目录 —— 目录内容在留点时刻未知，索引也补不上）。
   *     **「预算截断」本身不再拒删**：预算挡下的既有文件都在 `skipped` 或路径索引里 ⇒ 它们照样不是候选；
   *     旧口径拿它整体放弃删除，于是大工作区里中间回合新建的文件一条都删不掉（用户 2026-10-12 真机）。
   *  ② 路径判据 {@link createdRemovalRefusal}（分块外 / 数据区 / `.git` / `node_modules` / 非绝对路径）；
   *  ③ 单文件上限（先 `stat` 判大小；读不出大小且非 ENOENT 一律拒删 ——「不知道多大」≠「可以删」）。
   */
  private async planCreatedRemovals(
    payload: RollbackWorkspacePayload,
    sink: ChunkWalkSink,
  ): Promise<CreatedRemovalPlan> {
    // 证明名单：捕获时**存在过**的路径（能证明的都在这里）
    const proof = new Set<string>()
    for (const file of payload.files) proof.add(pathKey(file.path))
    for (const entry of payload.skipped) proof.add(pathKey(entry.path))
    for (const entry of payload.unreadableFiles) proof.add(pathKey(entry.path))
    for (const entry of payload.excludedDirs) proof.add(pathKey(entry.path))
    for (const entry of payload.ignoredDirs ?? []) proof.add(pathKey(entry.path))
    let refused: CreatedRemovalPlan['refused'] = null
    // 路径索引**存在即并入**证明名单：写入条件已从「跳过名单被截断」推广为「覆盖自检不完整」
    // （读到一半被预算打断也会写索引）—— 这里只看 skippedTruncated 会漏读索引 ⇒ 把老文件当新建删掉。
    const index = payload.pathIndex ?? null
    if (index !== null) {
      try {
        for (const item of await this.readPathIndex(index)) proof.add(pathKey(item))
      } catch (error) {
        this.warn('rollback path index unreadable: ' + errorDetail(error))
        refused = 'capture-incomplete'
      }
    } else if (payload.skippedTruncated) {
      // 逐条跳过名单被记录上限截断、又没有索引 ⇒ 「未记录」≠「留点之后新建」，证明不了
      refused = 'capture-incomplete'
    }
    // —— 分子树拒删范围 ——
    // 忽略目录 / 读不出的目录 / 走查没进去的子树：这三类的共同点是「其下内容在留点时刻未知」，
    // 但它们**各自只影响自己那棵子树**。旧口径一律全局拒删，代价是「忽略一个 outputs/ 就让整个
    // 工作区的新建文件一条都不删」；现在只拒这几棵子树，范围之外由证明名单照常判。
    // 走查中断且拿不到精确子树列表（老台账 / 栈被截断）时才退回全局。
    // 范围**说得清**才敢分子树拒删：忽略目录的逐条列表可能被记录上限截断（ignoredDirCount 是恒增
    // 计数），走查中断也可能拿不到子树列表（老台账 / 栈太深）。任一「说不清」⇒ 退回全局拒删。
    const ignoredKnown = (payload.ignoredDirs ?? []).length >= (payload.ignoredDirCount ?? 0)
    const unwalkedKnown = (payload.unwalkedDirs ?? []).length > 0 || payload.walkIncomplete !== true
    const scopesKnown = ignoredKnown && unwalkedKnown
    const refusalScopes: string[] = scopesKnown
      ? [
        ...(payload.ignoredDirs ?? []).map((entry) => entry.path),
        ...payload.unreadableDirs,
        ...(payload.unwalkedDirs ?? []),
      ]
      : []
    if (refused === null && !scopesKnown) {
      // 证明名单不完整、且**说不出**不完整的确切范围 ⇒ 整个工作区一条都不删（安全方向）
      refused = 'capture-incomplete'
    }
    const chunks = payload.chunks
    // 走查上限 = 全树：候选的**准入**由证明名单负责，条数上限不再是安全阀
    //（旧上限 maxFiles*4 会在巨型工作区里静默漏掉真正的新建文件 —— 那是「删一半」，不是 fail-closed）
    const limit = Number.MAX_SAFE_INTEGER
    // **时间预算**：回退期的走查同样不能无限跑（分块 = 会话 cwd，家目录 / 大仓库会走很久，
    // 而捕获侧早就有 30 s 预算 —— 只修一侧等于把 OOM 形态从留点搬到了回退）。
    // 中断只会让候选**变少**（安全方向），但必须如实置 truncated（绝不静默漏删、也不谎报完整）。
    const deadline = this.stamp() + this.rewindBudgetMs
    const outOfBudget = (): boolean => this.stamp() >= deadline
    const candidates: string[] = []
    let truncated = false
    for (const chunk of chunks) {
      if (!path.isAbsolute(chunk)) continue
      if (outOfBudget()) { truncated = true; break }
      const listed = await this.listChunkFiles(path.resolve(chunk), sink, limit, undefined, await loadIgnoreRules(path.resolve(chunk)), outOfBudget)
      if (listed === null) continue
      if (listed.truncated) truncated = true
      for (const file of listed.files) {
        if (outOfBudget()) { truncated = true; break }
        if (proof.has(pathKey(file))) continue
        candidates.push(file)
      }
    }
    // 警告只在**全局拒绝**时给：分子树拒绝由 createdSkipped 逐条说明（那句「本次不删除任何
    // 『留点后新建』的路径」在分子树拒绝下是假话 —— 文案诚实要求按真实范围分派）。
    const refusalWarnings = refused === null ? [] : this.createdRefusalWarnings(payload)
    const all: string[] = []
    const paths: string[] = []
    const skipped: string[] = []
    for (const file of candidates) {
      all.push(file)
      // 拒删的也留在「未记录」清单里（如实报告），但绝不进删除集合
      // 分子树拒删（忽略目录 / 读不出的目录 / 没走查到的子树）：只拒这几棵子树里的候选
      if (refusalScopes.length > 0 && refusalScopes.some((dir) => isInsidePath(file, dir))) {
        skipped.push(file)
        continue
      }
      if (this.createdRemovalRefusal(file, chunks) !== null) { skipped.push(file); continue }
      let stat
      try {
        stat = await fs.stat(file)
      } catch (error) {
        // 遍历之后文件已经消失（ENOENT）：它既不是「未记录的内容」也不是「要删的」—— 两边都拿掉
        if ((error as { code?: unknown }).code === 'ENOENT') { all.pop(); continue }
        skipped.push(file)
        continue
      }
      if (!stat.isFile() || stat.size > this.maxFileBytes) { skipped.push(file); continue }
      paths.push(file)
    }
    return {
      all,
      paths: refused === null ? paths : [],
      skipped: refused === null ? skipped : [...skipped, ...paths],
      truncated,
      refused,
      warnings: refusalWarnings,
    }
  }

  /**
   * E1：一个**执行过但无事可做**的段。T10 起按原因分成两个码（界面据此说两句不同的话，
   * **不靠 detail 分派**）：
   * - `'nothing-to-restore'`：记录了条目、但全部已与快照一致（工作区已与该点一致）；
   * - `'no-recorded-files'`：该态**没有记录任何文件**（例如捕获时分块不可用 / 空分块）。
   *
   * status 用 'restored' 而不是 'skipped' —— 它不是「没执行」，而是「执行了、0 变更」（restored=0）；
   * 于是 rewind 能靠它把「无事可做」与「真失败」分开（见 rewind 的 allNoop）。两者都不是错误。
   */
  private noopSegment(
    state: RollbackStateKind,
    reasonCode: 'nothing-to-restore' | 'no-recorded-files',
    detail: string,
  ): RollbackSegmentResult {
    return {
      state, status: 'restored', reasonCode, detail: [detail],
      restored: 0, failed: 0, leftovers: [], leftoversTruncated: false,
    }
  }

  /**
   * E1：单个「会被改动的文件」的行级统计 —— 方向**只有一侧**，别读反：
   * **current → snapshot**（=「这次回退会给该文件新增/删除多少行」），与 `RollbackPreviewFile`
   * 的 `added` / `removed` 字段注释同一口径：
   *  · `added`   = 快照里有、当前**没有**的行 ⇒ 回退会**加进去**的行数；
   *  · `removed` = 当前有、快照里**没有**的行 ⇒ 回退会**删掉**的行数。
   * 对应到实现：`lineDiffCounts(before, after)` 的 **`after` 是快照（回退目标）**、`before` 是当前文件。
   *
   * 任何一条超限、读不出、非文本 ⇒ 返回 null 数字 + truncated（调用方照给 status，但**不给数字**）。
   * `budget` 是**单张预览**共享的累计预算（字节 + 步数），跨条目生效。
   */
  private async previewFileCounts(
    file: RollbackWorkspaceFile,
    current: Uint8Array | null,
    status: RollbackPreviewFileStatus,
    budget: { bytes: number; work: number },
  ): Promise<{ added: number | null; removed: number | null; truncated: boolean }> {
    const currentBytes = current === null ? 0 : current.byteLength
    if (file.bytes > this.previewDiffMaxFileBytes || currentBytes > this.previewDiffMaxFileBytes) {
      return previewCountsUnavailable()
    }
    if (budget.bytes + file.bytes + currentBytes > this.previewDiffMaxTotalBytes) {
      return previewCountsUnavailable()
    }
    budget.bytes += file.bytes + currentBytes
    let snapshot: Uint8Array
    try {
      snapshot = await this.readObject(file.object)
    } catch {
      // 对象仓读不出（缺失 / 越界 / 权限）：status 照给，行数不给
      return previewCountsUnavailable()
    }
    if (looksBinary(snapshot) || (current !== null && looksBinary(current))) {
      return previewCountsUnavailable()
    }
    const target = splitDiffLines(DIFF_TEXT_DECODER.decode(snapshot))
    // 当前不存在 ⇒ 回退只会**新建**该文件：新增 = 快照行数、删除 = 0
    if (status === 'create') return { added: target.length, removed: 0, truncated: false }
    // 存在但读不出（目录 / 权限）⇒ 没有 before 可比，**不给数字**
    if (current === null) return previewCountsUnavailable()
    // 步数预算由 lineDiffCounts 直接记进共享 budget（中止时也扣满 limit，**总预算不可绕过**）
    const counts = lineDiffCounts(
      splitDiffLines(DIFF_TEXT_DECODER.decode(current)),
      target,
      this.previewDiffMaxWork,
      this.previewDiffTotalWork,
      budget,
    )
    if (counts === null) return previewCountsUnavailable()
    return { added: counts.added, removed: counts.removed, truncated: false }
  }

  /**
   * **合并结果**的逐文件行级统计（与 `previewFileCounts` 同一套预算与降级判据）。
   *
   * 为什么单独一份：合并后要写进去的内容既不是记录里的原文（ours），也不是磁盘现状（theirs）——
   * 预览若照旧拿 ours 算差异，就会把「其实会被保留的对方改动」显示成「会被删掉」。
   */
  private async previewMergeCounts(
    targetBytes: Uint8Array,
    current: Uint8Array,
    budget: { bytes: number; work: number },
  ): Promise<{ added: number | null; removed: number | null; truncated: boolean }> {
    if (targetBytes.byteLength > this.previewDiffMaxFileBytes || current.byteLength > this.previewDiffMaxFileBytes) {
      return previewCountsUnavailable()
    }
    if (budget.bytes + targetBytes.byteLength + current.byteLength > this.previewDiffMaxTotalBytes) {
      return previewCountsUnavailable()
    }
    budget.bytes += targetBytes.byteLength + current.byteLength
    if (looksBinary(targetBytes) || looksBinary(current)) return previewCountsUnavailable()
    const counts = lineDiffCounts(
      splitDiffLines(DIFF_TEXT_DECODER.decode(current)),
      splitDiffLines(DIFF_TEXT_DECODER.decode(targetBytes)),
      this.previewDiffMaxWork,
      this.previewDiffTotalWork,
      budget,
    )
    if (counts === null) return previewCountsUnavailable()
    return { added: counts.added, removed: counts.removed, truncated: false }
  }

  /**
   * **中断的回退**（2026-10-18）：进程在「回退写到一半」时没了 ⇒ 工作区停在半回退状态。
   *
   * 判据 = 目录名形态（`<pid>-<ts36>-<8hex>`）+ 有 journal 索引 + **没有 done** + 持锁进程已死
   *（全部在 rollback-undo-journal.ts 里，可注入 isAlive 以便测试）。
   *
   * 只读：不改工作区、不删现场；是否重放由用户决定（见 recoverInterruptedRollback）。
   * 这也是 cleanupOrphanTempFiles 不再整目录删它的原因 —— 删了就等于把半回退现场变成
   * 「无人知晓的部分修改」，正是任务要求里禁止留下的东西。
   */
  async interruptedRollbacks(): Promise<InterruptedUndo[]> {
    try {
      return await findInterruptedUndos(path.join(this.root, ROLLBACK_UNDO_DIR_NAME))
    } catch (error) {
      this.warn('rollback interrupted scan failed: ' + errorDetail(error))
      return []
    }
  }

  /**
   * 把一条中断的回退**退回回退前**（重放前像），返回逐条结果。
   *
   * 安全边界全在 replayUndoJournal 里：只有「当前内容仍等于 after 镜像」的条目才写回 ——
   * 之后发生的任何人工 / 外部 / 别的会话的改动一律**跳过**并如实回报（绝不覆盖）。
   * 只有全部条目都成功（没有 skipped / failed）才清理现场；否则现场留着，可以再看、再试。
   */
  async recoverInterruptedRollback(dir: string): Promise<{ ok: boolean; restored: number; skipped: string[]; failed: string[]; detail: string }> {
    const list = await this.interruptedRollbacks()
    const hit = list.find((item) => pathKey(item.dir) === pathKey(dir))
    if (hit === undefined) return { ok: false, restored: 0, skipped: [], failed: [], detail: 'not-an-interrupted-rollback' }
    let result: { restored: number; skipped: string[]; failed: string[] }
    try {
      result = await replayUndoJournal(hit, {
        readCurrent: async (target) => {
          try {
            return await this.readFileBytes(target)
          } catch (error) {
            // 读不出来（EACCES 等）**不等于不存在**：抛出去让 replay 记 failed，绝不写
            if ((error as { code?: unknown }).code === 'ENOENT') return null
            throw error
          }
        },
        write: (target, bytes) => this.writeFile(target, bytes),
      })
    } catch (error) {
      return { ok: false, restored: 0, skipped: [], failed: [], detail: errorDetail(error) }
    }
    const ok = result.failed.length === 0 && result.skipped.length === 0
    if (ok) {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch {
        /* 现场清理失败不影响「已经恢复好了」这个事实 */
      }
    }
    return {
      ok, restored: result.restored, skipped: result.skipped, failed: result.failed,
      detail: 'restored=' + String(result.restored) + ' skipped=' + String(result.skipped.length) + ' failed=' + String(result.failed.length),
    }
  }

  /** 只读预览：零写入（不过确认门、不拍 guard、不写任何字节）。 */
  async preview(id: string): Promise<RollbackPreviewResult> {
    const storage = await this.storageStatus()
    const ledger = await this.readManifest()
    const warnings: RollbackGuidance[] = []
    if (ledger.error !== undefined) warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail: ledger.error })
    const workspace: RollbackPreviewWorkspace = {
      overwrite: 0, different: 0, missing: 0, createdAfter: 0, files: [],
      leftovers: [], leftoversTruncated: false,
      removals: [], removalsCount: 0, removalsTruncated: false,
      createdSkipped: [], createdSkippedCount: 0, createdSkippedTruncated: false,
      createdRefusedReason: null,
      conflictCount: 0, conflictPaths: [], unavailableCount: 0, externalCount: 0,
      chunks: [], available: false, reasonCode: null,
      skippedCount: 0, truncated: false,
    }
    const session: RollbackPreviewSession = {
      from: null, to: null, turns: null, cursorSeq: null, cursorNowBytes: null, cursorTargetBytes: null,
      restorable: false, active: false, reasonCode: null,
    }
    const base: RollbackPreviewResult = {
      ok: false, code: 'ok', id, workspace, session,
      canRestore: false, canRemove: false, storage, guidance: [], warnings,
    }
    if (!storage.available) {
      return { ...base, code: 'storage-unavailable', detail: storage.detail, guidance: storage.guidance }
    }
    const entry = ledger.entries.find((r) => r.id === id)
    if (entry === undefined) return { ...base, code: 'record-not-found' }
    const resolved = await this.readFullRecord(entry.id)
    if (resolved.record === undefined) {
      // 引用解析失败（载荷文件缺失 / 哈希不符 / 形状不符）：**如实失败** —— 绝不拿半个记录去预览
      // （半个记录会让「可回退」看起来成立，然后回退真的写错文件）
      const detail = resolved.error ?? 'record-incomplete'
      warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail })
      return { ...base, code: 'record-incomplete', detail }
    }
    const record = resolved.record
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)

    // 工作区态
    const wsTrack = record.workspace
    const wsPayload = wsTrack.payload
    let workspaceRestorable = false
    if (!wsTrack.ok || wsPayload === null) {
      workspace.reasonCode = wsTrack.reasonCode ?? 'capture-failed'
    } else {
      workspace.chunks = [...wsPayload.chunks]
      workspace.available = true
      let different = 0
      let missing = 0
      // E1：逐文件行级统计 —— **只列会被改动的文件**（内容已一致的一个都不列）
      const changedFiles: RollbackPreviewFile[] = []
      // 写入归属（2026-10-17 定案 B）：只有**确知**最后写入者是别的会话、且写入发生在留点**之后**时，
      // 才敢标 foreign。缺归属 / 归属就是本会话 / 写入早于留点 ⇒ 一律不标
      // （未判定 ≠ 别的会话写的；宁可少标一次，也不误判一次）。
      const foreignWriterOf = (target: string): RollbackWriteFact | undefined => {
        const writer = this.attribution?.writerOf(target)
        if (writer === undefined) return undefined
        if (writer.sessionId === record.sessionId) return undefined
        if (writer.at <= wsTrack.capturedAt) return undefined
        return writer
      }
      // 单张预览共享的比对预算（字节 + 步数）；只有真的会被改动的条目才消耗它
      const diffBudget = { bytes: 0, work: 0 }
      /** 合并判定的会话身份与 base 缓存（与执行端同一判据：拿目标点的会话当「本会话」） */
      // 救援点（guard）是「回到回退前那一刻」的**精确恢复**语义 ⇒ 关掉隔离与三方合并
      // （sessionId='' ⇒ isolationSessionId=null）。R-25 冻结了这条口径：回退救援点必须把工作区
      // **逐字**写回那一刻；让它走合并会变成「什么都不做」（内容与当前磁盘一致）。
      const previewIsolationSessionId = record.kind === 'guard'
        ? null
        : (typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null)
      const previewBaseCache = new Map<string, { bytes: Uint8Array; fromGuard: boolean } | null>()
      // T10：stat 的三种结局分开表达 —— 「不存在（ENOENT）」与「存在性未知（其它 errno）」绝不混为一谈
      const previewFiles = wsPayload.files
      // 阶段 A（**并发**）：逐条一次 bigint lstat + 身份快路径。大仓库这里是预览的大头：
      // 真机 34k 条实测 —— 串行 lstat ≈ 6 s、串行真读 ≈ 13 s；并发后降到亚秒级 + 只读真正变了的那几条。
      const scans = new Array<PreviewScanResult>(previewFiles.length)
      let scanCursor = 0
      const scanWorkers = Array.from(
        { length: Math.min(this.captureConcurrency, Math.max(1, previewFiles.length)) },
        async () => {
          for (;;) {
            const index = scanCursor
            scanCursor += 1
            if (index >= previewFiles.length) return
            scans[index] = await this.previewScan(previewFiles[index] as RollbackWorkspaceFile)
          }
        },
      )
      await Promise.all(scanWorkers)
      // 阶段 B（**顺序**）：只对「变了 / 没了 / 不可写」的条目按记录顺序装配 —— 列表顺序与行级 diff 的
      // 共享预算因此仍**完全确定**（与并发前逐条一致，测试可逐字对账）。
      for (let index = 0; index < previewFiles.length; index += 1) {
        const file = previewFiles[index] as RollbackWorkspaceFile
        const outcome: PreviewScanResult = scans[index] ?? { kind: 'unavailable' }
        if (outcome.kind === 'missing') {
          // **只有 ENOENT** 才算「当前确实不存在」⇒ 回退会重新创建它
          missing += 1
          changedFiles.push({
            path: file.path, status: 'create',
            ...(await this.previewFileCounts(file, null, 'create', diffBudget)),
          })
          continue
        }
        if (outcome.kind === 'unavailable') {
          // 存在性未知（EACCES 等）：**不得**报成 create +N/-0，也不给行数 —— 只说「会被尝试写入」。
          // 计入 different 的理由：回退一定会尝试写它（restoreWorkspace 里「已一致」判定失败即视为需要写），
          // 这样 overwrite = 已一致 + different + missing 的算术仍然成立。
          different += 1
          const foreignMissing = foreignWriterOf(file.path)
          changedFiles.push({
            path: file.path, status: 'overwrite',
            ...(foreignMissing === undefined ? {} : { foreign: true, foreignSessionId: foreignMissing.sessionId, foreignAt: foreignMissing.at }),
            ...previewCountsUnavailable(),
          })
          continue
        }
        // 身份快路径已证明「与记录一致」⇒ 一个字段都不改（内容一致的文件不列进列表）
        if (outcome.unchanged) continue
        const { size, regular } = outcome
        const sizeMatches = regular && size === file.bytes
        const withinCaps = file.bytes <= this.previewDiffMaxFileBytes && size <= this.previewDiffMaxFileBytes
        let current: Uint8Array | null = null
        // 读当前内容的两个理由：① 大小一致时必须比 hash（判「内容真的变了吗」）；
        // ② 大小不一致时也得读一次才能给行级统计（超限的大文件不白读）。
        if (regular && (sizeMatches || withinCaps)) {
          try {
            current = await this.readFileBytes(file.path)
          } catch {
            current = null
          }
        }
        if (sizeMatches && current !== null && sha256Hex(current) === file.sha256) continue
        // **合并判定与执行同口径**（2026-10-17 修）：预览必须说清「这次到底会写成什么」。
        // 之前预览只按「覆盖回记录版本」算差异，而执行端会先做三方合并 ⇒ 预览把对方后来的行
        // 也算成「会被删掉」，用户据此以为会丢别人的改动（真机：两行描述都显示要删，实际只删 A 那行）。
        const decision = await (async (): Promise<{ mode: 'overwrite' | 'merged' | 'skip' | 'unchanged'; bytes?: Uint8Array; reason?: string }> => {
          if (current === null || previewIsolationSessionId === null) return { mode: 'overwrite' }
          let base = previewBaseCache.get(pathKey(file.path))
          if (base === undefined) {
            base = await this.baseFor(file.path, wsTrack.capturedAt, previewIsolationSessionId)
            previewBaseCache.set(pathKey(file.path), base)
          }
          const evidence: ForeignEvidence = {
            provenance: await this.provenanceOf(file.path, wsTrack.capturedAt, previewIsolationSessionId),
            // 「别人的回合点里没有它」只在**拿不到祖先**时才问（有祖先就不必再读一遍台账）
            absentAtForeignPoint: base === null
              && await this.absentAtForeignPointOf(file.path, wsTrack.capturedAt, previewIsolationSessionId),
          }
          const outcome = await this.mergeForeignRecord(file, base, evidence)
          if (outcome.kind === 'write') return { mode: 'merged', bytes: outcome.bytes }
          if (outcome.kind === 'unchanged') return { mode: 'unchanged' }
          if (outcome.kind === 'blocked') return { mode: 'skip', reason: outcome.reason }
          return { mode: 'overwrite' }
        })()
        // 合并结论是「保持现状」⇒ 它不会被改动，不该出现在「会被改动」的清单里
        if (decision.mode === 'unchanged') continue
        different += 1
        const foreignWriter = foreignWriterOf(file.path)
        changedFiles.push({
          path: file.path, status: 'overwrite',
          ...(foreignWriter === undefined ? {} : { foreign: true, foreignSessionId: foreignWriter.sessionId, foreignAt: foreignWriter.at }),
          ...(decision.mode === 'skip'
            ? { skipped: true, mergeReason: decision.reason, ...previewCountsUnavailable() }
            : decision.mode === 'merged' && decision.bytes !== undefined && current !== null
              ? await this.previewMergeCounts(decision.bytes, current, diffBudget)
              : await this.previewFileCounts(file, current, 'overwrite', diffBudget)),
        })
      }
      const sink: ChunkWalkSink = { skipped: [], excludedDirs: [], ignoredDirs: [], ignoredDirCount: 0, unreadableDirs: [], skippedCount: 0, skippedTruncated: false }
      // 删除集与执行阶段**同一份**（planCreatedRemovals）：预览说会删的，就是真的会删的
      const plan = await this.planCreatedRemovals(wsPayload, sink)
      workspace.overwrite = wsPayload.files.length
      workspace.different = different
      workspace.missing = missing
      workspace.createdAfter = plan.all.length
      workspace.files = changedFiles
      workspace.leftovers = plan.all.slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT)
      workspace.leftoversTruncated = plan.truncated
      // **全量**清单（不再切 20 条）：预览列出的就是会删的 —— 逐条与执行阶段同一份规划。
      // 超 ROLLBACK_MAX_CREATED_REMOVALS 时执行端**整套拒绝**（一条都不删）⇒ 这里如实给空集，
      // 「预览说会删的 = 实际删的」这条不变式在任何输入下都成立（那时回退以 created-removals-limit 失败）。
      const overRemovalLimit = plan.paths.length > ROLLBACK_MAX_CREATED_REMOVALS
      workspace.removals = overRemovalLimit ? [] : plan.paths
      workspace.removalsCount = workspace.removals.length
      // 遍历被截断（该分块还有没列出的路径）时清单才可能不完整；实践中它蕴含捕获也被截断
      // （⇒ 删除已整体拒绝、paths 为空），故这里只作事实回传。
      workspace.removalsTruncated = !overRemovalLimit && plan.truncated
      workspace.createdSkipped = plan.skipped.slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT)
      workspace.createdSkippedCount = plan.skipped.length
      workspace.createdSkippedTruncated = plan.truncated || plan.skipped.length > ROLLBACK_LEFTOVER_LIST_LIMIT
      workspace.createdRefusedReason = plan.refused
      for (const warning of plan.warnings) warnings.push(warning)
      // 捕获期的跳过计数与截断标记如实回传（列表被记录上限截断时 skippedCount 仍是真实总数）
      workspace.skippedCount = wsPayload.skippedCount
      workspace.truncated = wsPayload.truncated
      // 冲突 / 无法安全撤销 / 落点无人认领 —— **预览逐条列出**，不是静默略过（任务要求：
      // 「回退前显示预计撤销的修改、保留的后续修改及潜在冲突」）。三者与执行阶段**同源**：
      // 都来自同一份 mergeForeignRecord 的 blocked 原因，写进逐文件的 mergeReason。
      const blockedFiles = changedFiles.filter((item) => item.skipped === true)
      workspace.conflictCount = blockedFiles.filter((item) => item.mergeReason === 'conflict').length
      workspace.conflictPaths = blockedFiles
        .filter((item) => item.mergeReason === 'conflict')
        .map((item) => item.path)
        .slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT)
      workspace.externalCount = blockedFiles.filter((item) => item.mergeReason === 'external-edits').length
      workspace.unavailableCount = blockedFiles.length - workspace.conflictCount - workspace.externalCount
      workspaceRestorable = wsPayload.files.length > 0
    }

    // 会话态
    const sessionTrack = record.session
    const sessionPayload = sessionTrack.payload
    let sessionRestorable = false
    if (!sessionTrack.ok || sessionPayload === null) {
      session.reasonCode = sessionTrack.reasonCode ?? 'capture-failed'
    } else {
      session.from = sessionPayload.boundarySeq
      session.to = sessionPayload.boundaryEndSeq
      session.turns = sessionPayload.turnSeq
      session.cursorSeq = sessionPayload.cursorSeq
      session.cursorTargetBytes = sessionPayload.cursorBytes
      if (sessionPayload.logPath !== null) {
        try {
          const stat = await fs.stat(sessionPayload.logPath)
          session.cursorNowBytes = stat.size
          session.active = this.sessionQuiescentMs > 0 && this.nowFn() - stat.mtimeMs < this.sessionQuiescentMs
        } catch {
          session.cursorNowBytes = null
        }
      }
      if (sessionPayload.sessionId === null) session.reasonCode = 'session-missing'
      else if (sessionPayload.boundarySeq === null) session.reasonCode = 'no-boundary'
      else {
        sessionRestorable = true
        session.reasonCode = null
      }
    }

    session.restorable = sessionRestorable
    // 两个准入门**互相独立**（t22 口径，三处收敛为同一份说法）：
    //   canRemove  = 用户能不能删 —— 排除 guard（救援点是自动产物，删了就丢了「回到回退前」的路径）
    //   canRestore = 能不能作回退目标 —— **不**排除 guard，且与 rewind() 的准入逐条对应：
    //                rewind 只拒 protected / incomplete（+ 存储不可用 / 记录不存在 / 空 segments），
    //                所以这里就是「!protected && !incomplete && 至少一个段可恢复」。
    const canRemove = !record.protected && record.kind !== 'guard'
    const canRestore = !record.protected && !record.incomplete && (workspaceRestorable || sessionRestorable)
    return {
      ok: true, code: 'ok', id,
      point: summarizeRollbackPoint(record),
      workspace, session,
      canRestore, canRemove,
      storage, guidance: [], warnings,
    }
  }

  /* ------------------------------------------------- 单文件前后对照（只读） */

  /**
   * 只读：单个回滚点里**一个记录在案的文件**的逐行前后对照（零写入、不拍 guard、不写字节）。
   *
   * 收窄（安全不变量）：路径必须**逐字命中**记录里的 workspace.files ——
   * 绝不把这条端点做成「任意路径读取器」；未命中 ⇒ file-not-recorded，**一个字节都不读**。
   * 二进制 / 单侧超限 / 对象仓读不出 / 当前读不出都返回结构化 reason（hunks 恒为空数组），
   * 既不抛错，也不把「不知道」谎报成「没有差异」。
   */
  async fileDiff(id: string, filePath: string): Promise<RollbackFileDiffResult> {
    const emptySide = (): RollbackFileDiffSide => ({
      exists: false, bytes: 0, lines: null, binary: false, oversized: false, unreadable: false,
    })
    const base: RollbackFileDiffResult = {
      ok: false, code: 'invalid-input', id, path: filePath, status: 'overwrite',
      before: emptySide(), after: emptySide(),
      hunks: [], added: 0, removed: 0, identical: false, degraded: false,
      limits: ROLLBACK_FILE_DIFF_LIMITS,
    }
    const storage = await this.storageStatus()
    if (!storage.available) return { ...base, code: 'storage-unavailable', detail: storage.detail }
    if (filePath === '') return { ...base, detail: 'empty-path' }
    const ledger = await this.readManifest()
    const entry = ledger.entries.find((r) => r.id === id)
    if (entry === undefined) return { ...base, code: 'record-not-found' }
    const resolved = await this.readFullRecord(entry.id)
    if (resolved.record === undefined) {
      // 引用解析失败：**如实失败**（RollbackFileDiffResult 没有 warnings 槽位，用 detail 说清楚）
      return { ...base, code: 'record-incomplete', detail: resolved.error ?? 'record-incomplete' }
    }
    const record = resolved.record
    const payload = record.workspace.payload
    if (!record.workspace.ok || payload === null) {
      const detail = record.workspace.reasonDetail
      return detail === null ? { ...base, code: 'capture-failed' } : { ...base, code: 'capture-failed', detail }
    }
    const key = pathKey(filePath)
    const file = payload.files.find((entry) => pathKey(entry.path) === key)
    if (file === undefined) return { ...base, code: 'file-not-recorded', detail: filePath }

    // 快照一侧（回退后的样子）：超限**不读进内存**（与捕获期 / 预览行数统计同一口径）
    const snapshotOversized = file.bytes > this.previewDiffMaxFileBytes
    let snapshot: Uint8Array | null = null
    if (!snapshotOversized) {
      try {
        snapshot = await this.readObject(file.object)
      } catch {
        snapshot = null
      }
    }
    // 当前一侧（现在的样子）：**只有 ENOENT** 才算「不存在 ⇒ 回退会新建它」
    let current: Uint8Array | null = null
    let currentExists = false
    let currentBytes = 0
    let currentOversized = false
    let currentUnreadable = false
    try {
      const stat = await fs.stat(file.path)
      currentExists = true
      currentBytes = stat.size
      if (!stat.isFile()) currentUnreadable = true
      else if (stat.size > this.previewDiffMaxFileBytes) currentOversized = true
      else current = await fs.readFile(file.path)
    } catch (error) {
      if (classifyPreviewStatFailure(error) === 'missing') currentExists = false
      else currentUnreadable = true
    }

    // **合并判定与执行同口径**（2026-10-17 修）：「回退后」一侧必须显示这次**真正会写进去**的内容。
    // 以前它恒定显示记录里的原文（= 整文件覆盖的样子），于是预览列表写着「+0 −2」，点开「查看差异」
    // 却还是「−1,4 +1,1」—— 同一件事两个说法（真机 2026-10-17 用户当场发现）。
    let mergedAfter: Uint8Array | null = null
    /** true 只表示「after 侧真的是合并算出来的」——「不会改动」时 after 也是现状，但不算合并 */
    let mergedFlag = false
    let mergeSkippedReason: string | null = null
    const isolationSessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null
    if (current !== null && snapshot !== null && isolationSessionId !== null) {
      const base = await this.baseFor(file.path, record.workspace.capturedAt, isolationSessionId)
      const evidence: ForeignEvidence = {
        provenance: await this.provenanceOf(file.path, record.workspace.capturedAt, isolationSessionId),
        absentAtForeignPoint: base === null
          && await this.absentAtForeignPointOf(file.path, record.workspace.capturedAt, isolationSessionId),
      }
      if (base !== null || evidence.provenance !== 'unknown' || evidence.absentAtForeignPoint) {
        const outcome = await this.mergeForeignRecord(file, base, evidence)
        if (outcome.kind === 'write') {
          mergedAfter = outcome.bytes
          mergedFlag = true
        }
        // 合并结论 = 保持现状 ⇒ 「回退后」就是当前内容（该文件根本不会被写）
        else if (outcome.kind === 'unchanged') mergedAfter = current
        else if (outcome.kind === 'blocked') {
          // 冲突 / 无法安全合并 ⇒ 这次**不会写**它：「回退后」就是现状（两侧相同），
          // 界面据此说「不会改动」，绝不显示成「会被覆盖成记录原文」。
          mergeSkippedReason = outcome.reason
          mergedAfter = current
        }
      }
    }
    /** 回退后一侧的字节：合并结果优先，其次才是记录里的原文 */
    const afterBytes: Uint8Array | null = mergedAfter ?? snapshot
    const before: RollbackFileDiffSide = {
      exists: currentExists, bytes: currentBytes, lines: null,
      binary: false, oversized: currentOversized, unreadable: currentUnreadable,
    }
    if (current !== null) {
      before.binary = looksBinary(current)
      before.lines = before.binary ? null : splitDiffLines(DIFF_TEXT_DECODER.decode(current)).length
    }
    const after: RollbackFileDiffSide = {
      exists: afterBytes !== null, bytes: afterBytes?.byteLength ?? file.bytes, lines: null,
      binary: false, oversized: snapshotOversized,
      unreadable: afterBytes === null && !snapshotOversized,
    }
    if (afterBytes !== null) {
      after.binary = looksBinary(afterBytes)
      after.lines = after.binary ? null : splitDiffLines(DIFF_TEXT_DECODER.decode(afterBytes)).length
    }
    const view: RollbackFileDiffResult = {
      ...base, ok: true, code: 'ok', path: file.path,
      status: currentExists ? 'overwrite' : 'create', before, after,
      ...(mergedFlag ? { merged: true } : {}),
      ...(mergeSkippedReason === null ? {} : { mergeSkipped: true, mergeReason: mergeSkippedReason }),
    }
    // 结构性不可比对：逐条给出原因（有原因 ⇒ hunks 恒为空，绝不给半截差异）
    if (snapshotOversized) return { ...view, reason: 'too-large' }
    if (snapshot === null) return { ...view, reason: 'missing-blob' }
    if (currentUnreadable) return { ...view, reason: 'unreadable' }
    if (currentOversized) return { ...view, reason: 'too-large' }
    if (before.binary || after.binary) return { ...view, reason: 'binary' }
    const result = diffLines(
      current === null ? '' : DIFF_TEXT_DECODER.decode(current),
      afterBytes === null ? '' : DIFF_TEXT_DECODER.decode(afterBytes),
      { context: ROLLBACK_FILE_DIFF_LIMITS.context, maxD: ROLLBACK_FILE_DIFF_LIMITS.maxD },
    )
    return {
      ...view,
      hunks: result.hunks, added: result.added, removed: result.removed,
      identical: result.identical, degraded: result.degraded,
    }
  }

  /* -------------------------------------------------------------- 回退 */

  private result(partial: RewindDraft): RollbackRewindResult {
    const out: RollbackRewindResult = {
      ok: partial.outcome === 'restored',
      outcome: partial.outcome,
      code: partial.code,
      id: partial.id,
      segments: partial.segments ?? [],
      skippedSegments: partial.skippedSegments ?? [],
      storage: partial.storage,
      guidance: partial.guidance ?? [],
      warnings: partial.warnings ?? [],
    }
    if (partial.detail !== undefined) out.detail = partial.detail
    if (partial.guardPointId !== undefined) out.guardPointId = partial.guardPointId
    if (partial.childSessionId !== undefined) out.childSessionId = partial.childSessionId
    return out
  }

  private emptySegment(state: RollbackStateKind, code: RollbackCode, detail: string): RollbackSegmentResult {
    return { state, status: 'skipped', reasonCode: code, detail: [detail], restored: 0, failed: 0, leftovers: [], leftoversTruncated: false }
  }

  async rewind(input: RollbackRewindInput): Promise<RollbackRewindResult> {
    const warnings: RollbackGuidance[] = []
    const storage = await this.storageStatus()
    if (!storage.available) {
      return this.result({ outcome: 'failed', code: 'storage-unavailable', detail: storage.detail, id: input.id, storage, guidance: storage.guidance })
    }
    const ledger = await this.readManifest()
    if (ledger.error !== undefined) warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail: ledger.error })
    const entry = ledger.entries.find((r) => r.id === input.id)
    if (entry === undefined) {
      return this.result({ outcome: 'failed', code: 'record-not-found', id: input.id, storage, warnings })
    }
    const resolved = await this.readFullRecord(entry.id)
    if (resolved.record === undefined) {
      // 记录读不完整（载荷缺失 / 哈希不符 / 形状不符）：**零写入**失败，绝不拿半个记录去回退
      const detail = resolved.error ?? 'record-incomplete'
      warnings.push({ code: 'rollback.warn.ledgerUnreadable', detail })
      return this.result({ outcome: 'failed', code: 'record-incomplete', detail, id: input.id, storage, warnings })
    }
    const record = resolved.record
    // 门 1（fail-closed 确认门）：必须恰好 true
    if (input.userConfirmed !== true) {
      return this.result({ outcome: 'denied', code: 'confirmation-required', detail: 'userConfirmed!==true', id: input.id, storage, warnings })
    }
    // 门 2：保护点不可回退。**注意：guard 不在此列**（t22 口径）—— 救援点允许作为回退目标，
    // 它是「回到回退前」的唯一路径；这里与 preview().canRestore 是同一份判定（逐条一致）。
    if (record.protected) {
      return this.result({ outcome: 'denied', code: 'protected-point', detail: record.id, id: input.id, storage, warnings })
    }
    // 门 3：两态不全的记录缺省拒绝（allowPartial 才放行）
    if (record.incomplete && input.allowPartial !== true) {
      return this.result({ outcome: 'denied', code: 'record-incomplete', id: input.id, storage, warnings })
    }
    const requested = input.segments !== undefined
      ? uniqueStates(input.segments)
      : statesForMode(input.mode)
    if (requested.length === 0) {
      return this.result({ outcome: 'denied', code: 'invalid-input', detail: 'segments empty', id: input.id, storage, warnings })
    }
    // S5：恢复前自动留救援点（guard）
    const guardPolicy = input.guardPolicy ?? this.guardPolicy
    let guardPointId: string | undefined
    if (guardPolicy !== 'off') {
      const sessionPayload = record.session.payload
      const wsPayload = record.workspace.payload
      const guard = await this.capturePoint({
        kind: 'guard',
        chunks: wsPayload?.chunks ?? [],
        note: 'pre-rewind guard for ' + record.id,
        sessionId: sessionPayload?.sessionId ?? record.sessionId,
        sessionLogPath: sessionPayload?.logPath ?? null,
        cursorSeq: sessionPayload?.cursorSeq ?? null,
        turnSeq: sessionPayload?.turnSeq ?? null,
        boundarySeq: sessionPayload?.boundarySeq ?? null,
        boundaryEndSeq: sessionPayload?.boundaryEndSeq ?? null,
        unitId: record.unitId,
      })
      // T10：成败判据 = **appendRecord 真的成功**（guard.ok），而不是「拿到了内存 record」。
      // 留不下救援点就是 S5 的硬门：require 档**整体中止、零写入、不返回 childSessionId**；
      // warn 档按既有策略只告警继续，但同样**不报** guardPointId（绝不报幽灵点）。
      if (guard.ok === true && guard.point !== undefined && (guardPolicy !== 'require' || !guard.point.incomplete)) {
        guardPointId = guard.point.id
      } else {
        const detail = guard.detail ?? guard.code
        if (guardPolicy === 'require') {
          return this.result({ outcome: 'failed', code: 'guard-failed', detail, id: input.id, storage, warnings })
        }
        warnings.push({ code: 'rollback.warn.guardFailed', detail })
      }
    }
    // 段：工作区失败即中止后面的段
    const segments: RollbackSegmentResult[] = []
    const skippedSegments: RollbackStateKind[] = []
    let aborted = false
    let childSessionId: string | undefined
    for (const state of ROLLBACK_REWIND_ORDER) {
      if (!requested.includes(state) || aborted) {
        skippedSegments.push(state)
        continue
      }
      const segment = state === 'workspace'
        // 路径级选择（2026-10-17 定案 A）只在显式给出时透传 —— 缺省口径一字不变
        ? await this.restoreWorkspace(record.workspace, input.onlyPaths === undefined
      // 救援点（guard）是「回到回退前那一刻」的**精确恢复**语义 ⇒ 关掉隔离与三方合并
      // （sessionId='' ⇒ isolationSessionId=null）。R-25 冻结了这条口径：回退救援点必须把工作区
      // **逐字**写回那一刻；让它走合并会变成「什么都不做」（内容与当前磁盘一致）。
          ? { removeCreated: input.removeCreated === true, sessionId: record.kind === 'guard' ? '' : (record.sessionId ?? '') }
          : { removeCreated: input.removeCreated === true, onlyPaths: input.onlyPaths, sessionId: record.kind === 'guard' ? '' : (record.sessionId ?? '') })
        : await this.restoreSession(record.session)
      segments.push(segment)
      if (segment.childSessionId !== undefined) childSessionId = segment.childSessionId
      if (state === 'workspace' && segment.status === 'failed') aborted = true
    }
    for (const guidance of this.trackWarnings(record)) warnings.push(guidance)
    const anyFailed = segments.some((s) => s.status === 'failed')
    const workspaceFailed = segments.some((s) => s.state === 'workspace' && s.status === 'failed')
    const anySkipped = segments.some((s) => s.status === 'skipped')
    /**
     * E1：「没有可恢复的内容」不是失败（也**不再是 500**）：
     * - `status='restored' && restored===0`：段**执行过**、0 变更（工作区已与快照一致，
     *   或该态压根没有记录任何文件）；
     * - `status='skipped'`：该态没有可用的捕获 ⇒ 同样无事可做（reasonCode 如实回传）。
     * 只有**所有**被请求的段都无事可做，整体才是「成功、0 变更」= outcome 'restored' +
     * code 'nothing-to-restore'；只要有一段真的动了东西或真的失败，就按原口径判（partial / failed）。
     */
    // 「0 变更」必须真的是 0 变更：**删了文件的段不算无事可做**（restored=0 只表示没写回记录在案的
    // 路径；truncated 的点回退时常常「一条都不用写、但删掉了几个新建文件」—— 那种情形说
    // 「没有可恢复的内容」就是假尾句。真机端到端实测：removed=2 而 code 曾为 nothing-to-restore）
    /**
     * **被安全判据主动跳过**的文件总数（冲突 / 无法安全撤销 / 落点无人认领）。
     *
     * 与「无事可做」是两件事：用户要求回退，这些文件**是故意没有回退的**。
     * 把它们算进「成功、0 变更 / 没有可恢复的内容」就是假尾句 —— 竞品口径可以直接引用：
     * Claude Code 的原文是 Restored the code, but skipped N files（官方文档 errors 一节）。
     * 判据只读段上已经如实回传的三个计数，不新增任何猜测。
     */
    const deliberatelySkipped = segments.reduce((sum, s) => sum
      + (s.conflictCount ?? 0) + (s.externalCount ?? 0), 0)
    const allNoop = segments.length > 0
      && segments.every((s) => s.status === 'skipped'
        || (s.status === 'restored' && s.restored === 0 && (s.removed ?? 0) === 0))
      && deliberatelySkipped === 0
    let outcome: RollbackOutcome
    let code: RollbackCode
    if (workspaceFailed) {
      outcome = 'failed'
      code = 'restore-failed'
    } else if (allNoop) {
      outcome = 'restored'
      code = 'nothing-to-restore'
    } else if (anyFailed || anySkipped || deliberatelySkipped > 0) {
      outcome = 'partial'
      code = anyFailed ? 'restore-failed' : 'ok'
    } else {
      outcome = 'restored'
      code = 'ok'
    }
    const guidance: RollbackGuidance[] = []
    for (const segment of segments) {
      for (const item of segment.guidance ?? []) guidance.push(item)
    }
    if (workspaceFailed) guidance.push({ code: 'rollback.guidance.workspaceRolledBack' })
    const draft: RewindDraft = { outcome, code, id: input.id, segments, skippedSegments, storage, guidance, warnings }
    if (guardPointId !== undefined) draft.guardPointId = guardPointId
    if (childSessionId !== undefined) draft.childSessionId = childSessionId
    return this.result(draft)
  }

  /**
   * S4/S5：写回**记录在案**的路径，并删除**该点未记录且可证**的路径（同一份 planCreatedRemovals）。
   * 阶段 1 只读校验（任何一条不合格 → 零写入整体失败）→ 阶段 2 记前像 + 写 →
   * 阶段 3 逐文件 hash 复核 → 阶段 4 删除；任一失败 → **整体回滚到恢复前状态**。
   */
  /**
   * 「这一条新建路径**不许删**」的判据（命中即拒删；每条都能被逐字解释，绝不靠启发式）。
   *
   * · 不在任何记录在案的分块内（chunk 之外不是我们的地盘）；
   * · 落在插件自己的数据区（`this.root`）内 —— 那是回滚台账/对象仓本身；
   * · 路径里出现 `.git` 或 `node_modules` 段（仓库元数据与依赖树：它们在回退点之后**天天在变**，
   *   按「新建」判据删掉等于毁掉工作副本）；
   * · 不是绝对路径。
   */
  private createdRemovalRefusal(file: string, chunks: readonly string[]): string | null {
    if (!path.isAbsolute(file)) return 'not-absolute'
    if (!chunks.some((chunk) => path.isAbsolute(chunk) && isInsidePath(file, chunk))) return 'outside-chunk'
    if (isInsidePath(file, this.root)) return 'inside-data-dir'
    // Windows 文件系统**不分大小写**：`.GIT` / `.Git` / `NODE_MODULES` 是同一个目录，必须折大小写后
    // 再比 —— 不折会让它们的子树失去保护（本文件其它路径判据都走 win32Fold，这里此前漏了）。
    const segments = win32Fold(path.resolve(file)).split(/[\\/]+/)
    if (segments.includes('.git')) return 'excluded-dir'
    if (segments.includes('node_modules')) return 'excluded-dir'
    return null
  }

  /**
   * 把一条「留点之后被**别的会话**写过」的记录做成三方合并结果（2026-10-17 跨对话安全回退）。
   *
   * 三方：`ours` = 记录里的内容（回退目标）、`base` = 目标点之后**最早**那份中间版本、
   * `theirs` = 当前磁盘。结果是「撤销本会话那次改动 + 保留对方后来的改动」。
   *
   * 返回：`write`（合并干净且确实要写，带目标哈希 + 期望的当前哈希）、
   * `unchanged`（合并结果就是当前内容 —— 对方没动这一处，本来就不需要写）、
   * `blocked`（不能安全处理：冲突 / 没有中间版本 / 二进制 / 差异被降级 / 对方改成了不存在 / 读不出）。
   */
  private async mergeForeignRecord(
    file: RollbackWorkspaceFile,
    base: { bytes: Uint8Array; fromGuard: boolean } | null,
    evidence: ForeignEvidence,
  ): Promise<
    | { kind: 'write'; bytes: Uint8Array; sha256: string; expectedCurrent: string }
    | { kind: 'unchanged' }
    | { kind: 'blocked'; reason: MergeBlockReason }
    /** 没有可用祖先、也没有任何旁证 ⇒ 退回旧口径（整文件覆盖回目标版本） */
    | { kind: 'fallback' }
  > {
    let oursBytes: Uint8Array
    try {
      oursBytes = await this.readObject(file.object)
      if (sha256Hex(oursBytes) !== file.sha256) return { kind: 'blocked', reason: 'ours-unreadable' }
    } catch {
      return { kind: 'blocked', reason: 'ours-unreadable' }
    }
    let theirsBytes: Uint8Array
    try {
      theirsBytes = await fs.readFile(file.path)
    } catch (error) {
      // 读不出来（EACCES / EMFILE…）⇒ **存在性未知**，绝不按「不存在」处理
      if ((error as { code?: unknown }).code !== 'ENOENT') return { kind: 'blocked', reason: 'theirs-unreadable' }
      // 记录在案的路径**当前不存在**：旧口径是「按记录重建」—— 但那会连带把「别人删掉它」
      // 这件事一起撤销。判据只有两条，且都能逐字解释：
      //  ① 存在共同祖先（别的会话的回合点里还有它）⇒ 它是在那个点**之后**才消失的 ⇒ 别人删的，
      //     绝不复活（真机：B 删掉文件后回退 A）；
      //  ② 归属 / 时间窗表明那一刻是别人在写 ⇒ 同样不复活。
      // 注意**不能**用 absentAtForeignPoint 当判据：本会话自己把它改名 / 删除时，它在别人的回合点里
      // 本来就不存在（T6-3 真机形状）—— 拿它当「别人删的」会让正常的改名回退失效。
      if (base !== null) return { kind: 'blocked', reason: 'theirs-missing' }
      if (evidence.provenance === 'unclaimed') return { kind: 'blocked', reason: 'unclaimed' }
      if (evidence.provenance === 'foreign') return { kind: 'blocked', reason: 'theirs-missing' }
      return { kind: 'fallback' }
    }
    // 救援点当 base 只在「它之后确实又变过」时才成立：救援点是在**执行回退那一刻**拍的，若它与
    // 当前磁盘逐字相同，说明它提供不了任何「回退之后发生了什么」的知识 —— 拿它当共同祖先会把
    // 对方已经改进去的内容当成基线，合并结论变成 ours ⇒ 整文件覆盖、抹掉对方的改动。
    const usableBase = base !== null && !(base.fromGuard && sameBytes(base.bytes, theirsBytes)) ? base.bytes : null
    // 二进制（任一侧 8 KiB 内出现 NUL）绝不按文本合并：三方合并算法对它没有定义
    if (hasNulByte(oursBytes) || hasNulByte(theirsBytes) || (usableBase !== null && hasNulByte(usableBase))) {
      return { kind: 'blocked', reason: 'binary' }
    }
    const oursDecoded = decodeTextBytes(oursBytes)
    const theirsDecoded = decodeTextBytes(theirsBytes)
    const baseDecoded = usableBase === null ? null : decodeTextBytes(usableBase)
    /**
     * **base 必须真的携带「本会话改动之后」的信息**：若它与 ours（回退目标）逐字相同，说明它
     * 提供不了任何「本会话改了什么」的知识 —— 拿它当共同祖先会让合并结论变成「保持当前」，
     * 于是「回退到该点」成了「什么都不做」。
     *
     * 但**没有可用祖先**不等于「可以整文件覆盖」：撤销本会话的唯一依据是「这条路径确实是本会话
     * 写的」，而这条依据只能来自旁证（归属台账 / 活跃时间窗）或「别人的回合点里有没有它」。
     * 拿不到依据就**一个字节都不写** —— 宁可少退一次，也绝不覆盖别人的（或用户的）内容。
     * 只有在**完全没有证据**（老数据 / 未接时间窗）时才退回旧口径，与加这套判据之前逐字一致：
     * 判据只允许「少做」，不允许凭空多拦。
     */
    if (usableBase === null || (baseDecoded !== null && baseDecoded.ok && oursDecoded.ok && baseDecoded.text === oursDecoded.text)) {
      if (evidence.provenance === 'foreign' || evidence.absentAtForeignPoint) return { kind: 'blocked', reason: 'no-base' }
      if (evidence.provenance === 'unclaimed') return { kind: 'blocked', reason: 'unclaimed' }
      if (usableBase === null) return { kind: 'fallback' }
      return evidence.provenance === 'target' ? { kind: 'fallback' } : { kind: 'blocked', reason: 'unclaimed' }
    }
    /**
     * 合并的文本视图：三方都能**无损 UTF-8 往返** ⇒ 按 UTF-8 文本合并，落盘按 result.shape
     *（行尾 / BOM 由 text-fidelity 描述，encodeTextBytes 负责还原）；
     * 否则退到 **latin1 视图** —— latin1 是字节的双射，「字符串相等」= 「字节相等」，
     * 行级 diff / 合并因此等价于**按字节**做：非法 UTF-8（GBK / Latin-1 / 半截序列）逐字保留，
     * 绝不会被替换成 U+FFFD（2026-10-18 修：真机把 0xE9 写成 EF BF BD）。
     */
    const baseBytes = usableBase as Uint8Array
    const useLatin1 = !oursDecoded.ok || !theirsDecoded.ok || baseDecoded === null || !baseDecoded.ok
    const oursText = useLatin1 ? latin1Of(oursBytes) : (oursDecoded as { ok: true; text: string }).text
    const theirsText = useLatin1 ? latin1Of(theirsBytes) : (theirsDecoded as { ok: true; text: string }).text
    const baseText = useLatin1 ? latin1Of(baseBytes) : (baseDecoded as { ok: true; text: string }).text
    const result = mergeThreeWay(oursText, baseText, theirsText)
    if (!result.ok) {
      return {
        kind: 'blocked',
        reason: result.reason === 'conflict' ? 'conflict'
          : result.reason === 'degraded' ? 'degraded'
            : result.reason === 'non-utf8' ? 'non-utf8' : 'binary',
      }
    }
    // 调用方只在「当前内容 ≠ 记录内容」时才会走到这里 ⇒ `ours === theirs` 只可能是内容恰好相同
    if (oursText === theirsText) return { kind: 'unchanged' }
    if (result.text === theirsText) {
      // **合并结论 = 保持现状**：这次回退对工作区什么也做不了 —— 但 ours 与 theirs 明明不同
      //（否则上面那条就返回了）。真机 2026-10-17 的形状：base 取到了目标点**之后**的另一份快照
      //（里面已经含有「要撤销的那部分改动」），于是「应用对方的改动到 ours」恰好又变回现状。
      // 绝不能把它当成「无需改动」静默跳过 —— 那会让「回退」整个失效、界面上还看不到任何痕迹
      //（预览报 0 个文件、执行返回 nothing-to-restore）。这里按**无法安全撤销**如实处理：
      // 一个字节都不写，让用户看到并自己决定。
      return { kind: 'blocked', reason: 'ambiguous' }
    }
    // 落盘字节：UTF-8 路径按 shape 还原 BOM（result.text 里不含 BOM）；latin1 路径逐字节回写。
    // 两条路径的行尾都已由 mergeThreeWay 按 shape.eol 收尾 ⇒ CRLF 文件不再被折成 LF。
    const bytes = useLatin1
      ? Buffer.from(result.text, 'latin1')
      : Buffer.from(encodeTextBytes(result.text, result.shape))
    return { kind: 'write', bytes, sha256: sha256Hex(bytes), expectedCurrent: sha256Hex(theirsBytes) }
  }

  /**
   * 三方合并的 **base**：目标点之后**最早**那份仍含该路径的中间版本（共同祖先）。
   *
   * 为什么这么取：回滚点的「工作区态」是回合开始前拍的 ⇒ 别的会话那个回合的点，
   * 正好是「本会话改动之后、对方改动之前」的版本 —— 标准三方合并的共同祖先。
   * 取**最早**而不是最近是刻意选安全方向：宁可少撤销，也绝不把对方更晚的改动算进 ours 侧。
   *
   * 排除四类：目标点自己（`createdAt > afterAt`）、**救援点 guard**（它在执行回退那一刻拍，
   * 内容 ≈ 当前磁盘，拿它当 base 会让合并结果直接等于 ours = 整文件覆盖，正是本机制要消灭的形态）、
   * **本会话的点**（见上）、以及内容读不出来的点（继续往后找 —— 找不到 ⇒ 调用方按「无法安全撤销」
   * 处理，绝不用近似值代替）。
   */
  /**
   * 这条路径**是谁写的** —— 只读旁证（归属台账 + 活跃时间窗），**绝不从内容猜**。
   *
   * 优先归属台账（tool/call 参数，精确到调用）；没有归属时看文件 mtime 落在谁的活跃窗口内 ——
   * 这一条与工具无关，因此 bash / 脚本 / 外部编辑器写的路径同样能被判出来。
   * `hasDataFor` 是「有没有覆盖」的自证：**没有覆盖就返回 unknown**（不拦），有覆盖却没有任何会话
   * 活跃在那一刻才返回 unclaimed（手改 / 外部工具 / 另一个 DSH 进程）。
   */
  private async provenanceOf(target: string, capturedAt: number, sessionId: string | null): Promise<WriteProvenance> {
    if (sessionId === null) return 'unknown'
    const writer = this.attribution?.writerOf(target)
    if (writer !== undefined && writer.at > capturedAt) {
      return writer.sessionId === sessionId ? 'target' : 'foreign'
    }
    const activity = this.activity
    if (activity === undefined) return 'unknown'
    let mtimeMs: number
    try {
      mtimeMs = (await fs.stat(target)).mtimeMs
    } catch {
      return 'unknown'
    }
    if (!(mtimeMs > capturedAt)) return 'unknown'
    const active = activity.sessionsActiveAt(mtimeMs)
    if (active.length > 0) {
      // 只有「那一刻唯一活跃的就是本会话」才算自有证据；多会话同时活跃 ⇒ 保守当成别人的
      if (active.includes(sessionId) && active.every((id) => id === sessionId)) return 'target'
      return 'foreign'
    }
    return activity.hasDataFor(sessionId) ? 'unclaimed' : 'unknown'
  }

  /**
   * 目标点之后**别的会话的回合点**里，有没有哪个**不含**这条路径（= 那一刻它不存在）。
   *
   * 它证明的是：「当前磁盘上这份内容是该点之后才出现的」⇒ 拿目标点的内容整文件覆盖它，等于
   * 抹掉对方新建/重建的工作（2026-10-18：A 删文件、B 重建，回退 A 把 B 的内容覆盖回旧版本）。
   * 截断的点（`payload.truncated`）不能用来证明「不存在」，一律跳过；只扫最早的若干个点（有界）。
   */
  private async absentAtForeignPointOf(target: string, afterAt: number, sessionId: string | null): Promise<boolean> {
    const ledger = await this.readManifest()
    const key = pathKey(target)
    const candidates = ledger.entries
      .filter((entry) => entry.createdAt > afterAt
        && entry.kind !== 'guard'
        && (sessionId === null || entry.sessionId !== sessionId))
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
      .slice(0, 8)
    for (const entry of candidates) {
      const resolved = await this.readFullRecord(entry.id)
      const payload = resolved.record?.workspace.payload
      if (payload === null || payload === undefined) continue
      if (payload.truncated === true) continue
      if (!payload.files.some((item) => pathKey(item.path) === key)) return true
    }
    return false
  }

  /** 两档 base：**别的会话的回合点**优先，其次**救援点**（见 baseVersionFor 的判据注释） */
  private async baseFor(target: string, afterAt: number, excludeSessionId: string | null): Promise<{ bytes: Uint8Array; fromGuard: boolean } | null> {
    const turn = await this.baseVersionFor(target, afterAt, excludeSessionId, false)
    if (turn !== null) return turn
    return await this.baseVersionFor(target, afterAt, excludeSessionId, true)
  }

  private async baseVersionFor(
    target: string,
    afterAt: number,
    excludeSessionId: string | null,
    fromGuard: boolean,
  ): Promise<{ bytes: Uint8Array; fromGuard: boolean } | null> {
    const ledger = await this.readManifest()
    const key = pathKey(target)
    const candidates = ledger.entries
      .filter((entry) => entry.createdAt > afterAt
        // 第一档（fromGuard=false）= **别的会话的回合点**：共同祖先的正统来源。本会话后续回合的点
        // 不能当 base —— 它会把「本会话后续改动」也一并保留，与「回退到该点之前」的直觉冲突。
        // 第二档（fromGuard=true）= **救援点**：连续回退（先退 A 再退 B）时，B 的目标点之后往往只有
        // 第一次回退留下的救援点，而它的内容正是「A 已改、B 未改」那一刻的状态 —— 只有它能算出
        // 「把 A 的改动也一并撤销、同时保住 B 之后的内容」。旧口径在这时直接整文件覆盖 ⇒ A 的改动
        // 复活、B 的改动被抹掉（2026-10-18 真机可复现）。救援点与当前磁盘相同的情形由调用方挡掉。
        && (fromGuard
          ? entry.kind === 'guard'
          : entry.kind !== 'guard' && (excludeSessionId === null || entry.sessionId !== excludeSessionId)))
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
    for (const entry of candidates) {
      const resolved = await this.readFullRecord(entry.id)
      const payload = resolved.record?.workspace.payload
      if (payload === null || payload === undefined) continue
      const hit = payload.files.find((item) => pathKey(item.path) === key)
      if (hit === undefined) continue
      try {
        const bytes = await this.readObject(hit.object)
        if (sha256Hex(bytes) !== hit.sha256) continue
        return { bytes, fromGuard }
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * **别的会话的回合点里记录过的路径集合** —— 删除集保护的第二种证据（不依赖归属台账）。
   *
   * 为什么需要第二证据：归属可能整条缺失（工具不在白名单 / 另一个 DSH 进程把 attribution.json
   * 整体覆盖写 / 采集时机错过），而「别人的点里出现过这个路径」是**点台账本身**记录的事实 ——
   * 它足以证明「这条路径在留点之后被别的会话所在的回合捕获过」，因此删它就是销毁别人的工作。
   *
   * 有界：只扫目标点之后**最早**的 `limit` 个别的会话的点（按时间升序），且只读路径不读内容。
   * 扫不完不影响安全方向（少保护也会被归属那条兜一部分），但绝不因此声称「已扫全」。
   */
  private async foreignRecordedPaths(afterAt: number, excludeSessionId: string | null, limit = 10): Promise<Set<string>> {
    const out = new Set<string>()
    const ledger = await this.readManifest()
    const candidates = ledger.entries
      .filter((entry) => entry.createdAt > afterAt
        && entry.kind !== 'guard'
        && (excludeSessionId === null || entry.sessionId !== excludeSessionId))
      .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0))
      .slice(0, Math.max(1, limit))
    for (const entry of candidates) {
      const resolved = await this.readFullRecord(entry.id)
      const payload = resolved.record?.workspace.payload as
        | (RollbackWorkspacePayload & { delta?: { added?: unknown; removed?: unknown } })
        | null
        | undefined
      if (payload === null || payload === undefined) continue
      const files = (payload as { files?: unknown }).files
      if (Array.isArray(files)) {
        for (const item of files) {
          const target = (item as { path?: unknown }).path
          if (typeof target === 'string' && target !== '') out.add(pathKey(target))
        }
        continue
      }
      const delta = payload.delta
      if (delta === null || delta === undefined) continue
      for (const bucket of [delta.added, delta.removed]) {
        if (!Array.isArray(bucket)) continue
        for (const item of bucket) {
          const target = typeof item === 'string' ? item : (item as { path?: unknown } | null)?.path
          if (typeof target === 'string' && target !== '') out.add(pathKey(target))
        }
      }
    }
    return out
  }

  private async restoreWorkspace(
    track: RollbackTrack<RollbackWorkspacePayload>,
    options: { removeCreated?: boolean; onlyPaths?: readonly string[]; sessionId?: string } = {},
  ): Promise<RollbackSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('workspace', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    // E1：记录在案的条目数为 0 = 成功、0 变更（不是失败，更不是 500）
    // T10：**没有记录任何文件** 与「记录了但全部已一致」是两件不同的事，给不同的码
    // （界面据此说「该点没记录文件」而不是「工作区已与该点一致」）。
    if (payload.files.length === 0) return this.noopSegment('workspace', 'no-recorded-files', 'files=0 nothingToDo=true')
    const detail: string[] = []
    // 路径级选择性恢复（2026-10-17 定案 A）：null = 全量（旧口径，行为一字不变）。
    const selection = options.onlyPaths === undefined ? null : new Set(options.onlyPaths.map((target) => pathKey(target)))
    /** 因用户没勾选而跳过的记录条目数（只作事实回传，不参与任何安全判据） */
    let selectionSkipped = 0
    /**
     * 归属隔离（2026-10-17 定案 B）：**没有显式点名**时，把「留点之后被别的会话写过」的记录条目
     * 自动跳过（上层据此如实报告）。只有 attribution 在、且这次回退知道自己属于哪个会话时才可能生效；
     * 缺任何一样 ⇒ 退化成旧口径（照常恢复）—— **未判定绝不当作别的会话写的**。
     */
    let foreignSkipped = 0
    const isolationSessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : null
    /**
     * **合并保护**（2026-10-17 修）：触发条件**不看归属**，只看「有没有共同祖先可用」。
     *
     * 为什么必须这样：归属台账是**旁证**而不是判据 —— 对方的写入可能因为工具不在白名单、
     * 或另一个 DSH 进程把 attribution.json 整体覆盖写而**没被记到**。真机 2026-10-17：
     * 两个对话各给 README 加了一行描述，回退其中一个之后**两行都没了**，根因正是
     * 「归属里只有本会话那次编辑」⇒ 不认为有第三方 ⇒ 退回整文件覆盖。
     * 只要目标点之后**存在别的会话的回合点**，那它就是共同祖先 ⇒ 必须走三方合并。
     */
    const mergeGuardEnabled = selection === null && isolationSessionId !== null
    /** 同一路径的 base 只查一次（合并判定在「确认需要写」之后，命中数很少） */
    const baseCache = new Map<string, { bytes: Uint8Array; fromGuard: boolean } | null>()
    const sink: ChunkWalkSink = { skipped: [], excludedDirs: [], ignoredDirs: [], ignoredDirCount: 0, unreadableDirs: [], skippedCount: 0, skippedTruncated: false }
    // 删除集与**预览**共用同一份规划（planCreatedRemovals）⇒「预览说会删的」= 「实际删的」。
    // 为什么提到文件循环**之前**：选择模式要拿它当「合法路径」的第二来源（新建候选也允许被点名），
    // 而校验必须在**任何写入之前**完成。它是只读走查，提前算不会写任何东西。
    const plan = await this.planCreatedRemovals(payload, sink)
    if (selection !== null) {
      const legal = new Set<string>()
      for (const file of payload.files) legal.add(pathKey(file.path))
      for (const target of plan.all) legal.add(pathKey(target))
      const unknown = [...selection].filter((key) => !legal.has(key))
      if (unknown.length > 0) {
        // 点名了一个「既未记录、也不在删除候选」里的路径 ⇒ fail-closed：零写入失败，
        // 绝不把「用户打错一个路径」变成「静默少恢复几个文件」。
        pushDetail(detail, 'selection-unknown-path ' + unknown[0] + ' unknown=' + String(unknown.length) + ' zeroWrites=true')
        return {
          state: 'workspace', status: 'failed', reasonCode: 'invalid-input', detail,
          restored: 0, failed: unknown.length,
          leftovers: plan.all.slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT), leftoversTruncated: plan.truncated,
        }
      }
    }
    /**
     * 待写条目。`sha256` / `expectedCurrent` **只被三方合并路径**使用：
     *  · `sha256` = 这次真正要写进去的内容哈希（普通路径恒等于记录里的 `file.sha256`）；
     *  · `expectedCurrent` = 合并时读到的「当前磁盘」哈希 —— 写入前必须仍是它，否则说明
     *    文件在预览/合并之后又被改过 ⇒ **放弃写入**（并发保护：绝不覆盖比我们更新的内容）。
     */
    const writable: { file: RollbackWorkspaceFile; bytes: Uint8Array; sha256?: string; expectedCurrent?: string }[] = []
    let failed = 0
    // 「已与记录一致」的条目数（身份快路径证明）—— 后面「0 变更」的文案与统计要用
    let unchanged = 0
    /** 三方合并成功、写回「撤销本会话 + 保留对方改动」结果的条目数 */
    let mergedCount = 0
    /** 冲突：两侧改到同一处 ⇒ 绝不自动选边，交给用户 */
    let conflictCount = 0
    /** 无法安全撤销：没有中间版本 / 二进制 / 差异被降级 / 对方把它改成了不存在 */
    let unavailableCount = 0
    /** 落点无人认领（时间窗表明那一刻没有会话活跃）⇒ 拒绝覆盖，交由用户决定 */
    let externalCount = 0
    /** 写入前发现文件又被改过（并发）⇒ 放弃写入 */
    let concurrentCount = 0
    const mergedPaths: string[] = []
    const conflictPaths: string[] = []
    const unavailablePaths: string[] = []
    const externalPaths: string[] = []
    const concurrentPaths: string[] = []
    for (const file of payload.files) {
      // 路径级选择：没被点名的记录条目**不写**（用户自己的选择，不是安全判据）
      if (selection !== null && !selection.has(pathKey(file.path))) {
        selectionSkipped += 1
        continue
      }
      // 门：记录里的路径必须落在记录里的分块内（记录不可成为写原语）
      const inChunk = payload.chunks.some((chunk) => path.isAbsolute(chunk) && isInsidePath(file.path, chunk))
      if (!path.isAbsolute(file.path) || !inChunk || isInsidePath(file.path, this.root)) {
        failed += 1
        pushDetail(detail, 'invalid-path ' + file.path)
        continue
      }
      // **身份快路径**：身份（dev:ino:size:mtimeNs:ctimeNs:mode）命中身份缓存、且缓存的 sha/bytes 与记录
      // 一致 ⇒ 这个文件当前就是留点时刻的内容，**它根本不会被写** ⇒ 连对象都不必读。
      // 大仓库实测：旧口径下阶段 1 会把 34k 个对象（609 MiB）全读一遍 + 哈希一遍（回退 60 s+ 全在这）。
      // 语义变化（有意、且更准）：阶段 1 的对象校验只对**真要写**的条目做 —— 一个用不到的对象坏掉，
      // 不该中止整次回退；真要用它时（该文件确实变了）照样会 `object-missing` / `object-hash-mismatch` 硬失败。
      const info = await this.fileStatOf(file.path)
      if (info.error === undefined && info.isFile && info.size === file.bytes
        && (await this.unchangedByIdentity(file, info.identity))) {
        unchanged += 1
        continue
      }
      try {
        const bytes = await this.readObject(file.object)
        if (sha256Hex(bytes) !== file.sha256) {
          failed += 1
          pushDetail(detail, 'object-hash-mismatch ' + file.path)
          continue
        }
        // **合并保护**（2026-10-17 修）：到这里才确认「这个文件确实需要写」，也才值得去查共同祖先。
        // 触发不吃归属：只要目标点之后存在**别的会话**的回合点（那它就是共同祖先），就走三方合并。
        if (mergeGuardEnabled) {
          let base = baseCache.get(pathKey(file.path))
          if (base === undefined) {
            base = await this.baseFor(file.path, track.capturedAt, isolationSessionId)
            baseCache.set(pathKey(file.path), base)
          }
          const evidence: ForeignEvidence = {
            provenance: await this.provenanceOf(file.path, track.capturedAt, isolationSessionId),
            // 「别人的回合点里没有它」只在**拿不到祖先**时才问（有祖先就不必再读一遍台账）
            absentAtForeignPoint: base === null
              && await this.absentAtForeignPointOf(file.path, track.capturedAt, isolationSessionId),
          }
          const outcome = await this.mergeForeignRecord(file, base, evidence)
          if (outcome.kind === 'fallback') {
            // 没有可用祖先、也没有任何旁证 ⇒ 落到下面的旧口径（整文件覆盖回目标版本）
          } else if (outcome.kind === 'write') {
            writable.push({ file, bytes: outcome.bytes, sha256: outcome.sha256, expectedCurrent: outcome.expectedCurrent })
            mergedCount += 1
            if (mergedPaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) mergedPaths.push(file.path)
            continue
          } else if (outcome.kind === 'unchanged') {
            unchanged += 1
            continue
          } else {
            foreignSkipped += 1
            if (outcome.reason === 'conflict') {
              conflictCount += 1
              if (conflictPaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) conflictPaths.push(file.path)
            } else if (outcome.reason === 'unclaimed') {
              externalCount += 1
              if (externalPaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) externalPaths.push(file.path)
            } else {
              unavailableCount += 1
              if (unavailablePaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) unavailablePaths.push(file.path)
            }
            pushDetail(detail, 'foreign-' + outcome.reason + ' ' + file.path + ' zeroWrites=true')
            continue
          }
        }
        writable.push({ file, bytes })
      } catch (error) {
        failed += 1
        pushDetail(detail, 'object-missing ' + file.path + ' ' + errorDetail(error))
      }
    }

    if (selectionSkipped > 0) {
      pushDetail(detail, 'selection-skipped=' + String(selectionSkipped) + ' selection=' + String(selection?.size ?? 0))
    }
    if (foreignSkipped > 0) {
      pushDetail(detail, 'foreign-skipped=' + String(foreignSkipped) + ' (records written by other sessions after this point; not overwritten)')
    }
    if (mergedCount > 0) pushDetail(detail, 'foreign-merged=' + String(mergedCount) + ' (reverted this session, kept the other side)')
    if (conflictCount > 0) pushDetail(detail, 'foreign-conflict=' + String(conflictCount) + ' (both sides changed the same place; needs a human)')
    if (unavailableCount > 0) pushDetail(detail, 'foreign-unavailable=' + String(unavailableCount) + ' (no safe way to revert; left untouched)')
    if (concurrentCount > 0) pushDetail(detail, 'concurrent-change=' + String(concurrentCount) + ' (changed again after the merge; left untouched)')
    const leftovers = {
      leftovers: plan.all.slice(0, ROLLBACK_LEFTOVER_LIST_LIMIT),
      truncated: plan.truncated,
      count: plan.all.length,
    }
    // 用户 2026-10-11 定案 A：把「回退点之后新建」的路径也退回去（删除）。
    // removeCreated !== true ⇒ 只报告（paths 清空）；判据仍是同一份 plan。
    // 归属保护同样作用于**删除集**（2026-10-17 跨对话安全回退）：某路径若在留点之后被**别的会话**
    // 写过，删它同样是在销毁别人的工作 ⇒ 拒删（进 createdSkipped；预览与执行共用同一份规划，
    // 所以界面看到的「不会删」与执行端的「真的没删」仍然一致）。
    const removalPlan = options.removeCreated === true
      ? { paths: plan.paths, skipped: plan.skipped, truncated: plan.truncated, refused: plan.refused }
      : { paths: [] as string[], skipped: [] as string[], truncated: false, refused: null as CreatedRemovalPlan['refused'] }
    const protectedRemovals: string[] = []
    if (mergeGuardEnabled && removalPlan.paths.length > 0) {
      // 两类证据（任一成立就保护）：① 归属表明别的会话写过它；② **别的会话的回合点里记录过该路径**。
      // 后者不依赖归属（归属可能因工具白名单 / 跨进程整体覆盖 / 采集时机而缺失，见 mergeGuardEnabled 的说明）。
      const foreignPaths = await this.foreignRecordedPaths(track.capturedAt, isolationSessionId)
      const keep: string[] = []
      for (const target of removalPlan.paths) {
        const writer = this.attribution?.writerOf(target)
        const byWriter = writer !== undefined && writer.sessionId !== isolationSessionId && writer.at > track.capturedAt
        if (byWriter || foreignPaths.has(pathKey(target))) {
          protectedRemovals.push(target)
          removalPlan.skipped.push(target)
          continue
        }
        keep.push(target)
      }
      removalPlan.paths = keep
    }
    const removal = removalPlan
    if (protectedRemovals.length > 0) {
      pushDetail(detail, 'foreign-removal-protected=' + String(protectedRemovals.length) + ' (written by other sessions; not deleted)')
    }
    if (removal.paths.length > ROLLBACK_MAX_CREATED_REMOVALS) {
      detail.push('created-removals=' + String(removal.paths.length) + ' limit=' + String(ROLLBACK_MAX_CREATED_REMOVALS) + ' zeroWrites=true')
      return {
        state: 'workspace', status: 'failed', reasonCode: 'created-removals-limit', detail,
        restored: 0, failed: removal.paths.length,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        createdSkipped: removal.skipped,
        createdSkippedCount: removal.skipped.length,
        createdSkippedTruncated: removal.truncated || removal.skipped.length > ROLLBACK_LEFTOVER_LIST_LIMIT,
      }
    }
    if (failed > 0) {
      // 零写入：一条不合格就不写任何一条。
      // **reasonCode 必须分得清成因**（2026-10-18 X-12a 真机）：这里此前一律写 'invalid-path'，
      // 把「对象仓丢对象 / 哈希不符」也报成「路径非法」—— 界面与排障都会指向错误的方向。
      // 判据只读本段已累积的 detail（与回传的逐条说明同源，不另算一套口径）。
      const hasDetail = (prefix: string): boolean => detail.some((line) => line.startsWith(prefix))
      const reasonCode: RollbackCode = hasDetail('object-missing') ? 'object-missing'
        : hasDetail('object-hash-mismatch') ? 'object-hash-mismatch'
          : 'invalid-path'
      detail.push('restored=0 failed=' + String(failed) + ' leftovers=' + String(leftovers.count) + ' zeroWrites=true')
      return {
        state: 'workspace', status: 'failed', reasonCode, detail,
        restored: 0, failed,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
      }
    }
    // E1：内容已与快照一致的条目**不再写** —— 「0 变更」就要是真的 0 次写入
    // （否则工作区已与该点一致时也会重写全部文件，白耗 I/O 并抖动 mtime）。
    const needed: { file: RollbackWorkspaceFile; bytes: Uint8Array; sha256?: string; expectedCurrent?: string }[] = []
    for (const item of writable) {
      const targetSha = item.sha256 ?? item.file.sha256
      // 合并路径的**并发闸门**：写入前必须确认磁盘上仍是合并时读到的那一份
      if (item.expectedCurrent !== undefined) {
        let current: string | null = null
        try {
          current = sha256Hex(await fs.readFile(item.file.path))
        } catch {
          current = null
        }
        if (current !== item.expectedCurrent) {
          concurrentCount += 1
          if (concurrentPaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) concurrentPaths.push(item.file.path)
          pushDetail(detail, 'concurrent-change ' + item.file.path + ' zeroWrites=true')
          continue
        }
      }
      let identical = false
      try {
        const stat = await fs.stat(item.file.path)
        // 长度比的是**这次要写进去的那份内容**（合并路径下它与记录里的原文长度不一定相同）
        if (stat.isFile() && stat.size === item.bytes.byteLength) {
          identical = sha256Hex(await fs.readFile(item.file.path)) === targetSha
        }
      } catch {
        identical = false
      }
      if (identical) {
        unchanged += 1
        continue
      }
      needed.push(item)
    }
    if (needed.length === 0 && removal.paths.length === 0) {
      // 记录在案的路径全都已与快照一致、且没有要删的新建路径 ⇒ 该段成功、0 变更（不是失败、也不中止整体）
      const noop = this.noopSegment('workspace', 'nothing-to-restore', 'unchanged=' + String(unchanged) + ' nothingToDo=true')
      noop.leftovers = leftovers.leftovers
      noop.leftoversTruncated = leftovers.truncated
      noop.createdSkipped = removal.skipped
      noop.createdSkippedCount = removal.skipped.length
      noop.createdSkippedTruncated = removal.truncated || removal.skipped.length > ROLLBACK_LEFTOVER_LIST_LIMIT
      if (removal.refused !== null) noop.createdRefusedReason = removal.refused
      if (selectionSkipped > 0) noop.selectionSkipped = selectionSkipped
      if (foreignSkipped > 0) noop.foreignSkipped = foreignSkipped
      if (mergedCount > 0) { noop.mergedCount = mergedCount; noop.mergedPaths = mergedPaths }
      if (conflictCount > 0) { noop.conflictCount = conflictCount; noop.conflictPaths = conflictPaths }
      if (unavailableCount > 0) { noop.unavailableCount = unavailableCount; noop.unavailablePaths = unavailablePaths }
      if (externalCount > 0) { noop.externalCount = externalCount; noop.externalPaths = externalPaths }
      // **noop 也要保住原因**：冲突 / 无法安全撤销 / 无人认领的逐条说明都累积在 detail 里。
      // 只留一行 nothingToDo=true 会让用户看到「没有可退的」却看不到「有 3 个文件因冲突没退」
      //（2026-10-18 X-3 真机形状：conflictCount=1 但 detail 里一个字都没有）。
      for (const line of detail) {
        if (line.startsWith('foreign-') || line.startsWith('concurrent-change')) noop.detail.push(line)
      }
      if (concurrentCount > 0) { noop.concurrentCount = concurrentCount; noop.concurrentPaths = concurrentPaths }
      return noop
    }
    // 前像（**字节落盘、索引随栈**）：失败时要能整体回到恢复前状态 —— 只覆盖**真会被写**的文件。
    // 字节之所以不留在内存：大工作区整体回退时前像峰值 = 待写总字节（可达数百 MB），
    // 与 issue #89 的 OOM 同族；落盘后内存只随**文件条数**增长。
    // 暂存目录建不出来 ⇒ **零写入失败**（fail-closed）：回退没有安全网就不该开始。
    const stager = await this.openUndoStager()
    if (stager === null) {
      pushDetail(detail, 'undo-staging-unavailable root=' + this.root + ' zeroWrites=true')
      return {
        state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail,
        restored: 0, failed: needed.length + removal.paths.length,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
      }
    }
    // **最终并发校验**（紧邻写入之前）：合并/预览之后文件可能又被改过。前一刻的 needed 判定与
    // 真正写入之间还隔着前像暂存，所以这里再确认一次；不符的条目直接摘掉 ——
    // 绝不覆盖比我们更新的内容。
    if (needed.some((item) => item.expectedCurrent !== undefined)) {
      const keep: typeof needed = []
      for (const item of needed) {
        if (item.expectedCurrent === undefined) { keep.push(item); continue }
        let current: string | null = null
        try {
          current = sha256Hex(await fs.readFile(item.file.path))
        } catch {
          current = null
        }
        if (current !== item.expectedCurrent) {
          concurrentCount += 1
          if (concurrentPaths.length < ROLLBACK_LEFTOVER_LIST_LIMIT) concurrentPaths.push(item.file.path)
          pushDetail(detail, 'concurrent-change ' + item.file.path + ' zeroWrites=true')
          continue
        }
        keep.push(item)
      }
      needed.length = 0
      needed.push(...keep)
    }
    const preCount = needed.length
    for (const item of needed) {
      let bytes: Uint8Array | null = null
      let unreadable: string | null = null
      try {
        bytes = await this.readFileBytes(item.file.path)
      } catch (error) {
        // **只认 ENOENT = 当时确实不存在**。其它 errno（EACCES / EMFILE / EBUSY…）是
        // 「读不出来」而不是「没有」—— 折成 null 会让回滚阶段把这个**存在**的文件删掉
        // （UndoStager.stage(null) 的语义正是「回滚时删掉它」）。
        if ((error as { code?: unknown }).code !== 'ENOENT') unreadable = errorDetail(error)
      }
      if (unreadable !== null) {
        await stager.dispose()
        pushDetail(detail, 'preimage-unreadable ' + item.file.path + ' ' + unreadable + ' zeroWrites=true')
        return {
          state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail,
          restored: 0, failed: needed.length + removal.paths.length,
          leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        }
      }
      try {
        await stager.stage(item.file.path, bytes, { sha256: item.sha256 ?? item.file.sha256 })
      } catch (error) {
        // 暂存写不下去（ENOSPC / EACCES）：**零写入失败** —— 绝不带着不完整的前像开工，
        // 也绝不让异常穿出引擎（那会被路由兜成没有机器码的裸 500，且暂存目录无人清理）。
        await stager.dispose()
        pushDetail(detail, 'preimage-stage-failed ' + item.file.path + ' ' + errorDetail(error) + ' zeroWrites=true')
        return {
          state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail,
          restored: 0, failed: needed.length + removal.paths.length,
          leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        }
      }
    }
    let restored = 0
    let writtenBytes = 0
    for (const item of needed) {
      try {
        await this.writeFile(item.file.path, item.bytes)
        restored += 1
        writtenBytes += item.bytes.byteLength
      } catch (error) {
        failed += 1
        pushDetail(detail, 'restore-failed ' + item.file.path + ' ' + errorDetail(error))
      }
    }
    // 阶段 3：逐文件复核（重新读回并核对 SHA-256）
    const mismatched: string[] = []
    if (failed === 0) {
      for (const item of needed) {
        try {
          const current = await this.readFileBytes(item.file.path)
          // 合并路径写入的不是记录里的原文，而是合并结果 ⇒ 复核必须比**这次真正写进去的那份**
          if (sha256Hex(current) !== (item.sha256 ?? item.file.sha256)) mismatched.push(item.file.path)
        } catch {
          mismatched.push(item.file.path)
        }
      }
    }
    if (failed > 0 || mismatched.length > 0) {
      const rollbackFailed = await stager.rollback((target, bytes) => this.writeFile(target, bytes))
      await stager.dispose()
      for (const target of mismatched) pushDetail(detail, 'verify-mismatch ' + target)
      for (const line of rollbackFailed) pushDetail(detail, 'rolled-back-failed ' + line)
      detail.push('restored=0 failed=' + String(failed + mismatched.length) + ' rolledBack=' + String(preCount - rollbackFailed.length) + ' unchanged=' + String(unchanged))
      return {
        state: 'workspace', status: 'failed',
        reasonCode: mismatched.length > 0 ? 'verify-failed' : 'restore-failed',
        detail,
        restored: 0,
        failed: failed + mismatched.length,
        leftovers: leftovers.leftovers,
        leftoversTruncated: leftovers.truncated,
        guidance: [{ code: 'rollback.guidance.workspaceRolledBack', detail: rollbackFailed.length > 0 ? rollbackFailed.join(' ') : undefined }],
      }
    }
    // 阶段 4（用户 2026-10-11 定案 A）：删除「回退点之后新建」的路径。
    // 顺序刻死：记录在案的路径**先写并复核通过**，再删新建的 —— 先删后写一旦写失败就回不去了。
    // 删除同样可回滚：先读前像（内存）→ 删；任一失败就把已写的还原、把已删的写回。
    // 待删文件的前像同样落盘（stage(path, bytes) 的语义就是「回滚时把它写回」）
    let destroyedCount = 0
    const removalFailures: string[] = []
    // 逐条记录**真的删掉**的路径（全量，不再切 20 条）：它与预览的 workspace.removals 同源同序，
    // 界面把两份清单当作同一件事（「预览说会删的 = 实际删的」）。
    const removedPaths: string[] = []
    let removed = 0
    for (const target of removal.paths) {
      try {
        const bytes = await fs.readFile(target)
        if (bytes.byteLength > this.maxFileBytes) {
          pushDetail(detail, 'created-too-large ' + target)
          removal.skipped.push(target)
          continue
        }
        await stager.stage(target, bytes, { deleted: true })
        destroyedCount += 1
        await fs.rm(target, { force: true })
        removed += 1
        removedPaths.push(target)
      } catch (error) {
        removalFailures.push(target + ' ' + errorDetail(error))
      }
    }
    if (removalFailures.length > 0) {
      const rollbackFailed = await stager.rollback((target, bytes) => this.writeFile(target, bytes))
      await stager.dispose()
      for (const line of removalFailures) pushDetail(detail, 'created-remove-failed ' + line)
      for (const line of rollbackFailed) pushDetail(detail, 'rolled-back-failed ' + line)
      detail.push(
        'restored=0 removed=0 failed=' + String(removalFailures.length) +
        ' rolledBack=' + String(preCount + destroyedCount - rollbackFailed.length) +
        ' unchanged=' + String(unchanged),
      )
      return {
        state: 'workspace', status: 'failed', reasonCode: 'restore-failed', detail,
        restored: 0, failed: removalFailures.length,
        leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
        removed: 0, removedPaths: [], createdSkipped: removal.skipped,
        createdSkippedCount: removal.skipped.length,
        createdSkippedTruncated: removal.truncated || removal.skipped.length > ROLLBACK_LEFTOVER_LIST_LIMIT,
        guidance: [{ code: 'rollback.guidance.workspaceRolledBack', detail: rollbackFailed.length > 0 ? rollbackFailed.join(' ') : undefined }],
      }
    }
    detail.push(
      'restored=' + String(restored) + ' verified=' + String(needed.length) + ' unchanged=' + String(unchanged) +
      ' leftovers=' + String(leftovers.count) + ' removed=' + String(removed) + ' createdSkipped=' + String(removal.skipped.length),
    )
    const segment: RollbackSegmentResult = {
      state: 'workspace', status: 'restored', detail,
      restored, failed: 0,
      leftovers: leftovers.leftovers, leftoversTruncated: leftovers.truncated,
      removed, removedPaths, createdSkipped: removal.skipped,
      createdSkippedCount: removal.skipped.length,
      createdSkippedTruncated: removal.truncated || removal.skipped.length > ROLLBACK_LEFTOVER_LIST_LIMIT,
      writtenBytes,
    }
    if (selectionSkipped > 0) segment.selectionSkipped = selectionSkipped
    if (foreignSkipped > 0) segment.foreignSkipped = foreignSkipped
    if (mergedCount > 0) { segment.mergedCount = mergedCount; segment.mergedPaths = mergedPaths }
    if (conflictCount > 0) { segment.conflictCount = conflictCount; segment.conflictPaths = conflictPaths }
    if (unavailableCount > 0) { segment.unavailableCount = unavailableCount; segment.unavailablePaths = unavailablePaths }
    if (externalCount > 0) { segment.externalCount = externalCount; segment.externalPaths = externalPaths }
    if (concurrentCount > 0) { segment.concurrentCount = concurrentCount; segment.concurrentPaths = concurrentPaths }
    // 捕获不完整 ⇒ 一条都没删：如实回报原因（界面据此说「因为捕获不完整，一条都没动」）
    if (removal.refused !== null) segment.createdRefusedReason = removal.refused
    // 全部写入 / 删除都成功 ⇒ 先落 done 标记（这条前像不再是「中断的回退」），再清前像字节。
    await stager.finish()
    // 前像字节用完即清（成功路径）：留在磁盘上只会变成无人认领的残留
    await stager.dispose()
    return segment
  }

  /**
   * S3：会话回退 = 在目标回合前的稳定边界 **fork 子会话**。
   * 原会话日志**只读**：本方法不写任何字节（旧版的静止期门 / 分叉门 / 字节写回全部下线）。
   */
  private async restoreSession(track: RollbackTrack<RollbackSessionPayload>): Promise<RollbackSegmentResult> {
    const payload = track.payload
    if (!track.ok || payload === null) {
      return this.emptySegment('session', track.reasonCode ?? 'capture-failed', 'track-not-ok')
    }
    if (payload.sessionId === null) {
      const segment = this.emptySegment('session', 'session-missing', 'sessionId=null')
      segment.status = 'failed'
      return segment
    }
    if (payload.boundarySeq === null) {
      const segment = this.emptySegment('session', 'no-boundary', 'turn=' + String(payload.turnSeq ?? 'unknown') + ' startSeq=0')
      segment.status = 'failed'
      return segment
    }
    if (this.forkSeam === undefined) {
      const segment = this.emptySegment('session', 'session-fork-unavailable', 'no fork seam injected')
      segment.status = 'failed'
      segment.guidance = [{ code: 'rollback.guidance.forkUnavailable', detail: payload.sessionId }]
      return segment
    }
    try {
      const outcome = await this.forkSeam({ sessionId: payload.sessionId, boundarySeq: payload.boundarySeq })
      if (!outcome.ok) {
        const segment = this.emptySegment('session', outcome.code, outcome.detail ?? outcome.code)
        segment.status = 'failed'
        return segment
      }
      // 归位失败（宿主三档都没命中）**不静默**：会话确实回退了，但它会在侧栏落到
      // 「未分组」——多一条指引如实说明，别让用户以为回退把对话"弄丢了"。
      const notAttached = typeof outcome.warning === 'string' && outcome.warning !== ''
      return {
        state: 'session',
        status: 'restored',
        detail: [
          'forked session=' + payload.sessionId,
          'boundary=' + String(payload.boundarySeq),
          'child=' + outcome.childSessionId,
          'logUnchanged=true',
          'workspaceAttached=' + (notAttached ? 'false' : 'true'),
        ],
        restored: 1,
        failed: 0,
        leftovers: [],
        leftoversTruncated: false,
        childSessionId: outcome.childSessionId,
        guidance: notAttached
          ? [
            { code: 'rollback.guidance.sessionForked', detail: outcome.childSessionId },
            { code: 'rollback.guidance.sessionNotAttached', detail: outcome.childSessionId },
          ]
          : [{ code: 'rollback.guidance.sessionForked', detail: outcome.childSessionId }],
      }
    } catch (error) {
      const segment = this.emptySegment('session', 'fork-failed', errorDetail(error))
      segment.status = 'failed'
      return segment
    }
  }

  /* -------------------------------------------------------------- 删除 */

  /**
   * 删除一个回滚点。保护点与 guard 点**一律拒绝**（「不删被保护点」，用户删不掉 guard；
   * guard 的增长靠两道自动淘汰收敛 —— 每会话 `maxGuardsPerSession`（20）与全局 `maxGuards`（50），
   * 见 ROLLBACK_MAX_GUARDS_PER_SESSION / ROLLBACK_MAX_GUARDS），
   * 没有 force 后门。成功后回收无人引用的对象（best-effort）。
   *
   * 整段「读 → 判 → 写 → 回收」都在 {@link withLedgerWriteLock} 队列里：否则并发的自动留点
   * 会在本方法的读与写之间插入一次 append，把刚删掉的点**复活**（评审 20 轮实测 12 轮复现）。
   */
  async remove(id: string): Promise<RollbackRemoveResult> {
    const storage = await this.storageStatus()
    if (!storage.available) return { ok: false, code: 'storage-unavailable', detail: storage.detail, id }
    return await withLedgerWriteLock<RollbackRemoveResult>(this.ledgerPath, async () => {
      const ledger = await this.readManifest()
      if (this.initError !== undefined) {
        return { ok: false, code: 'ledger-write-failed', detail: this.initError, id }
      }
      // 删除只看**清单元数据**（protected / kind 都在清单里）—— 一个记录文件都不读、一个载荷都不读
      const entry = ledger.entries.find((r) => r.id === id)
      if (entry === undefined) return { ok: false, code: 'record-not-found', id }
      if (entry.protected || entry.kind === 'guard') {
        return { ok: false, code: 'protected-point', detail: entry.kind, id }
      }
      const kept = ledger.entries.filter((r) => r.id !== id)
      try {
        await this.ledger.writeManifest(kept)
      } catch (error) {
        return { ok: false, code: 'ledger-write-failed', detail: errorDetail(error), id }
      }
      await this.ledger.deleteRecords([id])
      await this.ledger.prunePayloads(kept)
      await this.gcObjects(kept)
      return { ok: true, code: 'deleted', id }
    })
  }

  /**
   * 磁盘清理入口（引擎侧）：删**全部**自动点（includeGuards=true 时连 guard 也删），
   * protected 点**永不删**（生产路径造不出来，只有测试能造）。随后回收无人引用的载荷与对象。
   *
   * 零写入拒绝路径照旧：存储不可用 / 清单读不出来（形状不符、迁移失败、迁移中）⇒ **抛带 code 的错误**，
   * 一个字节都不动、也绝不静默返回全 0（「什么都没删」与「读不出来所以没删」是两件事）。
   * 返回的 bytes = 本次真正删掉的字节（记录文件 + 载荷文件 + 对象文件）。
   */
  async purgeLedger(options: { includeGuards?: boolean } = {}): Promise<{
    removedRecords: number
    removedPayloads: number
    removedObjects: number
    bytes: number
  }> {
    const storage = await this.storageStatus()
    if (!storage.available) {
      throw new RollbackLedgerRefusedError('storage-unavailable', storage.detail ?? 'rollback storage unavailable')
    }
    return await withLedgerWriteLock(this.ledgerPath, async () => {
      const ledger = await this.readManifest()
      if (this.initError !== undefined) throw new RollbackLedgerRefusedError('ledger-unreadable', this.initError)
      if (ledger.error !== undefined) throw new RollbackLedgerRefusedError('ledger-unreadable', ledger.error)
      const includeGuards = options.includeGuards === true
      const victims = ledger.entries.filter((entry) => !entry.protected && (includeGuards || entry.kind === 'auto'))
      if (victims.length === 0) return { removedRecords: 0, removedPayloads: 0, removedObjects: 0, bytes: 0 }
      const victimIds = new Set(victims.map((entry) => entry.id))
      const kept = ledger.entries.filter((entry) => !victimIds.has(entry.id))
      // 先落清单、再删文件：崩在中途也只会留下「清单已删、文件还在」的垃圾，不会留下指向空文件的清单
      await this.ledger.writeManifest(kept)
      const records = await this.ledger.deleteRecords([...victimIds])
      const payloads = await this.ledger.prunePayloads(kept)
      const objects = await this.ledger.collectObjects(kept)
      if (objects.aborted === null) {
        await this.gcPathCache(new Set([...objects.referencedPaths].map(pathKey)))
      } else {
        this.warn('rollback purge: object gc skipped: ' + objects.aborted)
      }
      return {
        removedRecords: records.removed,
        removedPayloads: payloads.removed,
        removedObjects: objects.removed,
        bytes: records.bytes + payloads.bytes + objects.bytes,
      }
    })
  }
}

/**
 * 台账清理的**显式拒绝**（形状不符 / 存储不可用）：带机器可读 code，绝不静默返回全 0。
 * 路由层按 code 映射 HTTP（与既有 RollbackCode 冻结集同源）。
 */
export class RollbackLedgerRefusedError extends Error {
  readonly code: RollbackCode
  constructor(code: RollbackCode, detail: string) {
    super(detail)
    this.name = 'RollbackLedgerRefusedError'
    this.code = code
  }
}

function uniqueStates(states: readonly RollbackStateKind[]): RollbackStateKind[] {
  const out: RollbackStateKind[] = []
  for (const state of states) {
    if ((state === 'workspace' || state === 'session') && !out.includes(state)) out.push(state)
  }
  return out
}

/* ---------------------------------------------------------------- 自动留点 */

/** 会话登记（宿主订阅 session/event 时按会话登记一次）。 */
export interface RollbackSessionBinding {
  sessionId: string
  /** 会话单元键 <projectKey>/<sessionId>（界面展示 / 归属） */
  unitId?: string | null
  /** 会话日志绝对路径（能拿到就给；只作审计，回退走 fork） */
  logPath?: string | null
  /** 工作区快照分块（通常 = 会话 cwd）；缺省 = 只留会话态（该点 incomplete） */
  chunks?: readonly string[]
  /**
   * 父会话 id（t9）：活会话头里有 `parentSession` / `parentSessionId` 就带出来。
   * 它**不改变任何留点行为**（点仍只属于本会话），只服务于「这条 replay 出来的回合是不是继承的」判据。
   */
  parentSessionId?: string | null
  /**
   * 该会话的历史是不是**从父会话播种**来的（`isSeeded` / `seedLength`，t9）。
   * 只有 true 的父子关系才进继承链 —— 子代理会话的回合号是它自己的，按同回合上溯会误命中。
   */
  forked?: boolean
}

export interface RollbackTrackedEvent {
  sessionId: string
  seq: number
  type: string
  data?: unknown
  /**
   * 事件的写入面（DSH 的顶层 `surfaceOp`；`'append'` = 用户新发的一条消息）。
   *
   * 为什么留点器需要它：**排队中的用户消息**（上一回合还在跑时发出的那条）会先落成
   * `user/message(surfaceOp='append')` / `agent/inbox/spliced`，**再**出现下一个 `turn/start`。
   * 若边界直接取 `startSeq - 1`，这些「还没被消费的输入」会被切进子会话 ——
   * 真机表现就是「回退后的对话变成排队发送里的一条消息」（2026-10-11 用户反馈）。
   */
  surfaceOp?: string
}

/**
 * 「还没被任何回合消费的输入」的判据（与 DSH 的 latestCompletedPrefixBoundary 同口径）：
 *  · `user/message` 且 `surfaceOp === 'append'`（用户新发的一条）；
 *  · `agent/inbox/spliced`（排队输入被并入）。
 * 只在**没有未收尾回合**时才当成待消费输入（回合内的同类事件属于当前回合）。
 */
function isPendingInputEvent(event: RollbackTrackedEvent): boolean {
  if (event.type === 'agent/inbox/spliced') return true
  return event.type === 'user/message' && event.surfaceOp === 'append'
}

export interface RollbackTrackerOptions {
  engine: RollbackPointEngine
  now?: () => number
  /** 轮询回退间隔（≤5 s） */
  pollIntervalMs?: number
  log?: (line: string) => void
  /** 会话日志 stat 探针（轮询回退用） */
  statSessionLog?: (logPath: string) => Promise<{ size: number; mtimeMs: number } | undefined>
  /**
   * 写入归属采集器（2026-10-17 定案 B）。缺省 = 不采集 ⇒ 预览永远没有 foreign 标记，
   * 回退行为与旧版**逐字一致**。
   */
  attribution?: RollbackWriteRecorder
  /**
   * 会话活跃时间窗采集器（2026-10-18）。缺省 = 不采集 ⇒ 归属判定只剩 tool/call 参数那一条。
   * **每个事件都记一次**（与工具参数无关），因此 bash / 脚本 / 外部编辑器写的路径同样有归属证据。
   */
  activity?: RollbackActivityRecorder
}

export interface RollbackTrackerResult {
  captured: boolean
  pointId?: string
  code?: RollbackCode
  detail?: string
}

/**
 * session/event 载荷的窄化结果（F-2）：形状不符走**显式机器码**，绝不静默回落到「什么都不做」。
 * 宿主拿到 ok:false 必须记日志/上报，而不是当成「这个事件不需要留点」。
 */
export type RollbackEventNarrowResult =
  | { ok: true; event: RollbackTrackedEvent }
  | { ok: false; code: RollbackCode; detail: string }

/**
 * 把 DSH 的 session/event 载荷窄化成留点器认识的最小形状（seq / type / 透传 data）。
 * core 不认识 DSH 的事件类型：只做**形状**校验，语义判断（turn/end 才留点）在 noteEvent 里。
 */
export function rollbackTrackedEventOf(sessionId: string, event: unknown): RollbackEventNarrowResult {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, code: 'invalid-input', detail: 'session-id-missing' }
  }
  if (event === null || typeof event !== 'object') {
    return { ok: false, code: 'invalid-input', detail: 'event-not-object' }
  }
  const seq = (event as { seq?: unknown }).seq
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    return { ok: false, code: 'invalid-input', detail: 'event-seq-missing' }
  }
  const type = (event as { type?: unknown }).type
  if (typeof type !== 'string' || type === '') {
    return { ok: false, code: 'invalid-input', detail: 'event-type-missing' }
  }
  const out: RollbackTrackedEvent = { sessionId, seq, type }
  const data = (event as { data?: unknown }).data
  if (data !== undefined) out.data = data
  const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
  if (typeof surfaceOp === 'string' && surfaceOp !== '') out.surfaceOp = surfaceOp
  return { ok: true, event: out }
}

/**
 * 一次 live Session → 留点器的会话登记（F-2）。
 *
 * 工作区快照分块取 `session.header.cwd`（DSH 记录会话创建时的绝对工作目录）；cwd 缺失或
 * 非绝对时**不给分块** —— 那个点只留会话态（`incomplete=true` + workspace.reasonCode
 * `no-chunks`），由界面如实展示，**绝不**拿别的目录凑数；`chunkless` 给出机器码供宿主记录。
 * 会话日志路径不在这里猜：回退走 `fork(sessionId, boundarySeq)`（S3），引擎不依赖日志路径。
 */
export type RollbackBindingNarrowResult =
  | { ok: true; binding: RollbackSessionBinding; chunkless: 'cwd-missing' | 'cwd-not-absolute' | null }
  | { ok: false; code: RollbackCode; detail: string }

export function rollbackSessionBindingOf(session: unknown): RollbackBindingNarrowResult {
  if (session === null || typeof session !== 'object') {
    return { ok: false, code: 'invalid-input', detail: 'session-not-object' }
  }
  const id = (session as { id?: unknown }).id
  if (typeof id !== 'string' || id === '') {
    return { ok: false, code: 'invalid-input', detail: 'session-id-missing' }
  }
  const header = (session as { header?: unknown }).header
  const headerRecord = header !== null && typeof header === 'object' ? header as Record<string, unknown> : null
  // 子代理会话**不自动留点**（见 RollbackCode 的 'subagent-session'）：它的工作区与父会话相同、
  // 回合号是自己的，留点只挤占用户自己会话的预算。**只在字段逐字等于 'subagent' 时判定** ——
  // 读不到 origin（老宿主 / 形状不符）就不判，绝不因为读不到而少留点。
  if (headerRecord?.['origin'] === 'subagent') {
    return { ok: false, code: 'subagent-session', detail: 'origin=subagent session=' + id }
  }
  const cwd = headerRecord?.['cwd']
  // t9：父链与「是否播种而来」只从**活会话头**读；读不到就不带字段（＝不是继承子会话），绝不猜
  const fork: { parentSessionId?: string; forked?: boolean } = {}
  if (headerRecord !== null) {
    for (const key of ['parentSession', 'parentSessionId'] as const) {
      const value = headerRecord[key]
      if (typeof value === 'string' && value !== '') { fork.parentSessionId = value; break }
    }
    if (headerRecord['isSeeded'] === true || typeof headerRecord['seedLength'] === 'number') fork.forked = true
  }
  if (typeof cwd !== 'string' || cwd === '') return { ok: true, binding: { sessionId: id, ...fork }, chunkless: 'cwd-missing' }
  if (!path.isAbsolute(cwd)) return { ok: true, binding: { sessionId: id, ...fork }, chunkless: 'cwd-not-absolute' }
  const binding: RollbackSessionBinding = { sessionId: id, chunks: [cwd], unitId: projectKeyOf(cwd) + '/' + id, ...fork }
  return { ok: true, binding, chunkless: null }
}

/* ------------------------------------------------------- fork 继承链（t9） */

/** 会话日志头的 fork 视图（只读；读不到 = 不建链） */
interface SessionForkHeader {
  id: string
  parentSessionId: string | null
  /** true = 历史是从父会话**播种**来的（isSeeded / seedLength）—— 只有这种才允许按回合上溯 */
  forked: boolean
}

/** 只读日志头这么多字节（头在第一帧里；1 MiB 是标题兜底的上限，这里更省） */
const FORK_HEADER_SCAN_BYTES = 64 * 1024

/**
 * 读一个会话日志头的 fork 视图（只读、有界、失败一律 null）。
 *
 * 字段口径与 `utils/session-log.ts` 的 `readLogHeaderFromBytes` **同源**（父对话 id 在磁盘 header 里
 * 叫 `parentSession`、DSH 的 RPC 投影才叫 `parentSessionId`，两种写法都认）；那边不暴露 fork 标记
 * （`isSeeded` / `seedLength`），而这条标记是安全的要害：**只有 fork 子会话才允许按回合上溯**。
 */
async function readSessionForkHeader(logPath: string): Promise<SessionForkHeader | null> {
  if (!zstdAvailable()) return null
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(logPath, 'r')
    const buffer = Buffer.allocUnsafe(FORK_HEADER_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, FORK_HEADER_SCAN_BYTES, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== ZSTD_MAGIC) return null
    const first = scanZstdFrames(bytes, 1).frames[0]
    if (first === undefined) return null
    const line = decodeZstdFrame(bytes.subarray(first.start, first.end)).toString('utf8').split('\n')[0] ?? ''
    if (line === '') return null
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const rec = parsed as Record<string, unknown>
    const id = rec['id']
    if (typeof id !== 'string' || id === '') return null
    let parent: string | null = null
    for (const key of ['parentSession', 'parentSessionId'] as const) {
      const value = rec[key]
      if (typeof value === 'string' && value !== '') { parent = value; break }
    }
    const forked = rec['isSeeded'] === true
      || (typeof rec['seedLength'] === 'number' && Number.isFinite(rec['seedLength']))
    return { id, parentSessionId: parent, forked }
  } catch {
    return null
  } finally {
    try { await handle?.close() } catch { /* 关不掉不影响结论 */ }
  }
}

/**
 * `unitId`（`<projectKey>/<sessionId>`）→ 项目键段；形状不符 / 可疑段一律 null（绝不拼可疑路径）。
 * 与 `core/session-title.ts` 的 `unitSegments` 同一条判据（越界 / 分隔符 / 盘符一律拒绝）。
 */
function unitProjectKeyOf(unitId: string | null | undefined): string | null {
  if (typeof unitId !== 'string' || unitId === '') return null
  const parts = unitId.split('/').filter((part) => part !== '')
  const first = parts[0]
  if (parts.length < 2 || first === undefined || first === '') return null
  if (first === '.' || first === '..' || first.includes('\\') || first.includes(':') || first.includes('/')) return null
  return first
}

/** 同项目键下的子会话 unitId（`<projectKey>/<childId>`）；项目键拿不到就 null。 */
function childUnitIdOf(ancestorUnitId: string | null, childSessionId: string): string | null {
  const projectKey = unitProjectKeyOf(ancestorUnitId)
  return projectKey === null ? null : projectKey + '/' + childSessionId
}

/**
 * 回合自动留点器（S1）。
 *
 * **主路径 = 事件驱动**：宿主订阅 `session/event`，把每个事件交给 `noteEvent`；
 * 见到 `turn/end` 就为当前会话留一个回滚点（工作区快照 + 会话游标 + fork 边界）。
 * 边界来自该回合的 `turn/start`：`boundarySeq = startSeq - 1`（startSeq=0 → 无前置边界）。
 *
 * **回退路径 = mtime 轮询**（宿主拿不到事件订阅时）：`start()` 起 ≤5 s 的定时器，
 * 日志 size/mtime 变了就留一个点。轮询**拿不到回合边界**（core 不解析日志字节），
 * 因此这些点只有工作区态 + 会话游标，`boundarySeq=null` → 会话回退会结构化 `no-boundary`。
 *
 * 幂等：同一会话同一回合只留一次（重复事件 / 重复轮询都不会重复留点）。
 */
export class RollbackAutoTracker {
  private readonly engine: RollbackPointEngine
  private readonly nowFn: () => number
  private readonly pollIntervalMs: number
  private readonly log: ((line: string) => void) | undefined
  private readonly statSessionLog: ((logPath: string) => Promise<{ size: number; mtimeMs: number } | undefined>) | undefined
  private readonly attribution: RollbackWriteRecorder | undefined
  private readonly activity: RollbackActivityRecorder | undefined
  private readonly bindings = new Map<string, RollbackSessionBinding>()
  private readonly open = new Map<string, { turn: number | null; startSeq: number; boundarySeq: number | null }>()
  /**
   * 每个会话「尚未被回合消费的输入」的首个 seq（排队发送的用户消息 / inbox 拼接）。
   * 见 {@link RollbackTrackedEvent.surfaceOp} 的说明与 {@link isPendingInputEvent}。
   */
  private readonly pendingInput = new Map<string, number>()
  private readonly lastBoundary = new Map<string, number>()
  private readonly seenTurns = new Map<string, Set<string>>()
  private readonly lastStat = new Map<string, { size: number; mtimeMs: number }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private mechanism: 'event' | 'poll' = 'event'
  /** 在途捕获的取消信号（stop() 时 abort；重新 start() 时换一个新的） */
  private captureAbort = new AbortController()

  constructor(options: RollbackTrackerOptions) {
    this.engine = options.engine
    this.nowFn = options.now ?? (() => Date.now())
    this.pollIntervalMs = Math.min(
      options.pollIntervalMs ?? ROLLBACK_DEFAULT_POLL_INTERVAL_MS,
      ROLLBACK_DEFAULT_POLL_INTERVAL_MS,
    )
    this.log = options.log
    this.statSessionLog = options.statSessionLog
    this.attribution = options.attribution
    this.activity = options.activity
  }

  /** 实际采用的留点机制（output / 诊断用） */
  get mechanismKind(): 'event' | 'poll' {
    return this.mechanism
  }

  registerSession(binding: RollbackSessionBinding): void {
    this.bindings.set(binding.sessionId, binding)
    // t9：fork 关系立刻喂给引擎的继承链 —— 本次运行里刚 fork 出来的子会话不必等磁盘扫描的 TTL
    this.engine.noteSessionBinding(binding)
  }

  unregisterSession(sessionId: string): void {
    this.bindings.delete(sessionId)
    this.open.delete(sessionId)
    this.pendingInput.delete(sessionId)
    this.lastStat.delete(sessionId)
  }

  private warn(line: string): void {
    try { this.log?.(line) } catch { /* 日志失败绝不影响主流程 */ }
  }

  private async captureFor(binding: RollbackSessionBinding, info: {
    turn: number | null
    boundarySeq: number | null
    endSeq: number | null
  }): Promise<RollbackTrackerResult> {
    const result = await this.engine.capturePoint({
      kind: 'auto',
      sessionId: binding.sessionId,
      unitId: binding.unitId ?? null,
      sessionLogPath: binding.logPath ?? null,
      turnSeq: info.turn,
      boundarySeq: info.boundarySeq,
      boundaryEndSeq: info.endSeq,
      chunks: binding.chunks ?? [],
      note: this.mechanism === 'poll' ? 'auto:poll' : 'auto:turn',
      // 卸载 / 停止 ⇒ 立刻中断在途捕获（下一个文件边界停下；已收条目照常成点）
      signal: this.captureAbort.signal,
    })
    // T10：写台账失败（ok=false）绝不算留点成功 —— 否则 tracker 会记住一个台账里不存在的 pointId，
    // 后续 rewind/详情都查不到它。（capturePoint 失败时也不再回传 point，这条判据是第二道保险。）
    if (result.ok !== true || result.point === undefined) {
      return { captured: false, code: result.code, detail: result.detail }
    }
    if (info.turn !== null) {
      const seen = this.seenTurns.get(binding.sessionId) ?? new Set<string>()
      seen.add(String(info.turn))
      this.seenTurns.set(binding.sessionId, seen)
    }
    if (info.endSeq !== null) this.lastBoundary.set(binding.sessionId, info.endSeq)
    return { captured: true, pointId: result.point.id, code: result.code }
  }

  /**
   * 事件驱动的入口。宿主订阅 session/event 后把事件窄化成 {@link RollbackTrackedEvent} 再喂进来。
   * 绝不对未知事件抛错（宿主回调必须 try/catch 也就够了，但这里也不抛）。
   */
  async noteEvent(event: RollbackTrackedEvent): Promise<RollbackTrackerResult> {
    try {
      this.mechanism = 'event'
      // 时间窗归属（2026-10-18）：**每个**事件都记一次活跃 —— 与工具参数无关，因此 bash / 脚本 /
      // 外部编辑器写的文件也能按「mtime 落在谁的活跃窗口内」判定归属。零 I/O（内存 + debounce 落盘）。
      this.activity?.noteActivity(event.sessionId, this.nowFn())
      const binding = this.bindings.get(event.sessionId)
      if (binding === undefined) return { captured: false, code: 'invalid-input', detail: 'unknown-session ' + event.sessionId }
      // 未开回合时出现的「待消费输入」属于**下一个**回合：边界必须落在它之前，
      // 否则排队发送的那条消息会被切进子会话（真机 = 回退后停在「排队发送」一条消息上）。
      if (!this.open.has(event.sessionId) && !this.pendingInput.has(event.sessionId) && isPendingInputEvent(event)) {
        this.pendingInput.set(event.sessionId, event.seq)
      }
      if (event.type === 'turn/start') {
        const inputSeq = this.pendingInput.get(event.sessionId)
        const from = inputSeq ?? event.seq
        const turn = turnOfData(event.data)
        this.open.set(event.sessionId, {
          turn,
          startSeq: event.seq,
          boundarySeq: from > 0 ? from - 1 : null,
        })
        this.pendingInput.delete(event.sessionId)
        if (turn !== null) {
          const seen = this.seenTurns.get(event.sessionId)
          if (seen !== undefined && seen.has(String(turn))) return { captured: false, detail: 'already-captured turn=' + String(turn) }
          // t9：**继承回合**不补点（见 inheritedTurnOf 的语义说明）
          const inheritedFrom = await this.inheritedTurnOf(binding, turn)
          if (inheritedFrom !== null) {
            return { captured: false, detail: 'inherited-turn from=' + inheritedFrom + ' turn=' + String(turn) }
          }
        }
        // **留点发生在回合开始之前**（用户 2026-10-11 定案）：点的「工作区态」必须是**这条消息之前**的样子。
        // 旧口径在 turn/end 才拍工作区 ⇒ 回退时只能把文件写回「这个回合结束后」的状态（真机症状：
        // 预览说「工作区与该回退点一致」，而被这一回合改过的文件一个都没退回去）。
        // 参照实现（dsh-turn-rewind / Change Ledger）也是「先把工作区拍在消息那一刻，再让 agent 去改」。
        return await this.captureFor(binding, {
          turn,
          boundarySeq: from > 0 ? from - 1 : null,
          endSeq: null,
        })
      }
      if (event.type === 'tool/call') {
        // 写入归属（2026-10-17 定案 B）：**只记，不改任何留点行为**，也不 await 落盘
        // （落盘由 attribution 自己 debounce；tool/call 洪峰不该在这里等 I/O）。
        this.attribution?.noteToolCall(event.sessionId, event.data)
        return { captured: false }
      }
      if (event.type !== 'turn/end') return { captured: false }
      // 回合结束只为「缺省边界」留个记号（轮询/无边界回退用它），不再拍点。
      this.open.delete(event.sessionId)
      this.lastBoundary.set(event.sessionId, event.seq)
      return { captured: false }
    } catch (error) {
      this.warn('rollback tracker noteEvent failed: ' + errorDetail(error))
      return { captured: false, code: 'capture-failed', detail: errorDetail(error) }
    }
  }

  /**
   * 该回合是不是**继承**来的（t9）。
   *
   * 判据（两档，先便宜后准）：
   *  ① 本进程里已经见过**祖先**这一回合的点（父会话通常同时在跑，这一档零 IO）；
   *  ② 台账快照里祖先有同回合点（{@link RollbackPointEngine.ancestorPointForTurn}，只上溯 + 环保护 + 深度上限）。
   *
   * 语义（为什么继承回合**不补点**）：
   *  · fork 子会话 replay 出来的历史回合，其「该回合之前的工作区态」属于**父会话**那一时刻；
   *    在这里补一个点 = 把**现在**的工作区态贴到那个回合上 ⇒ **幽灵点**（回退会把文件写回错误状态）；
   *  · 继承回合的可回退性由**祖先点**提供：客户端沿继承链解析（`lookupPointForTurn`）、
   *    `list()` 里另有继承视图条目供其它匹配器使用 —— 所以「继承回合不补点」不会让子会话永久无点；
   *  · 本会话**自己的新回合**（祖先没有同回合点）照常留点 ⇒ 子会话从此有自己的点。
   */
  private async inheritedTurnOf(binding: RollbackSessionBinding, turn: number): Promise<string | null> {
    const parent = binding.parentSessionId
    if (binding.forked !== true || typeof parent !== 'string' || parent === '') return null
    for (const ancestor of [parent, ...this.engine.ancestorIdsOf(binding.sessionId)]) {
      if (this.seenTurns.get(ancestor)?.has(String(turn)) === true) return ancestor
    }
    const hit = await this.engine.ancestorPointForTurn(binding.sessionId, turn)
    return hit === null ? null : (hit.sessionId ?? parent)
  }

  private async defaultStat(logPath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
    try {
      const stat = await fs.stat(logPath)
      return { size: stat.size, mtimeMs: stat.mtimeMs }
    } catch {
      return undefined
    }
  }

  /**
   * 轮询回退：日志 size/mtime 变了就留一个点（**无回合边界**）。
   * 首次见到某会话只记基线（不立刻留点），避免把「历史文件」当成新回合。
   */
  async pollOnce(): Promise<RollbackTrackerResult[]> {
    const out: RollbackTrackerResult[] = []
    for (const binding of this.bindings.values()) {
      const logPath = binding.logPath
      if (logPath === undefined || logPath === null || logPath === '') continue
      let stat: { size: number; mtimeMs: number } | undefined
      try {
        stat = this.statSessionLog !== undefined ? await this.statSessionLog(logPath) : await this.defaultStat(logPath)
      } catch (error) {
        this.warn('rollback tracker stat failed: ' + errorDetail(error))
        continue
      }
      if (stat === undefined) continue
      const prev = this.lastStat.get(binding.sessionId)
      this.lastStat.set(binding.sessionId, stat)
      if (prev === undefined) continue
      if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue
      out.push(await this.captureFor(binding, { turn: null, boundarySeq: null, endSeq: null }))
    }
    return out
  }

  /** 起轮询定时器（≤5 s）。已起则幂等返回。 */
  start(): void {
    if (this.timer !== null) return
    // 上一轮 stop() 已经把信号 abort 掉：重新 start 必须换一个新的，否则捕获一动就停。
    if (this.captureAbort.signal.aborted) this.captureAbort = new AbortController()
    this.mechanism = 'poll'
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => { this.warn('rollback tracker poll failed: ' + errorDetail(error)) })
    }, this.pollIntervalMs)
    const handle = this.timer as unknown as { unref?: () => void }
    if (typeof handle.unref === 'function') handle.unref()
  }

  stop(): void {
    // 中断在途捕获：卸载之后不该再有任何一次「读工作区 + 写对象仓」跑完。
    this.captureAbort.abort()
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 当前时钟（测试用；保持与引擎 now 同源语义） */
  now(): number {
    return this.nowFn()
  }
}
