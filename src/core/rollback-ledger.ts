/**
 * 回滚点台账**存储层**（issue #89）。
 *
 * ## 为什么要有这一层
 * v2 台账是**单文件** index.json：每回合「读全文 -> JSON.parse -> 合并 -> JSON.stringify -> 原子写」。
 * 本机实测该文件涨到 473 285 138 字节（50 条记录）后宿主反复 V8 heap OOM（exit 134）——
 * 根因不是条数（50 条是上限）而是**字节**：ROLLBACK_MAX_RECORDS 只限条数、不限字节，
 * 而每条记录的 workspace.payload.files 数组可达数万项（一次整份读入 = 数百 MB 常驻）。
 *
 * ## v3 布局（清单 + 单条记录 + 内容寻址载荷）
 *   rollback-points/
 *     index.json                       # **小清单**：{ schemaVersion: 3, records: LedgerManifestEntry[] }
 *     index.v2.backup.json             # v2 单文件迁移成功后的改名保留（人要退回旧版仍有原文件）
 *     records/<id>.json                # 单条完整记录（workspace.payload 换成一个载荷哈希引用）
 *     payloads/<sha256 of JSON>.json   # 内容寻址的 RollbackWorkspacePayload —— 同一工作区态只落一份
 *     objects/<sha256>                 # 文件内容对象仓（口径不变）
 *     path-cache.json                  # 路径身份缓存（口径不变）
 *
 * 三条硬性质：
 *  1. **清单里绝不含大数组** —— 每条只有元数据 + 段摘要（纯标量）⇒ 序列化字节数与文件条目数无关。
 *  2. **按条解析** —— readRecord(id) 才去读那一条记录文件与它引用的载荷，「一个回合」的内存峰值
 *     ∝ 单份载荷，而**不是** ∝ 台账总字节。
 *  3. **载荷去重** —— 内容寻址：同一工作区态只写一次，连续多个回合工作区未变时零额外字节。
 *
 * ## 不静默
 * 载荷文件缺失 / 哈希不符 / 形状不符一律**如实失败**（返回 error，绝不拼半个记录出来）；
 * 调用方据此走既有的 record-incomplete / ledger-unreadable 路径。
 *
 * ## 为什么用注入的 summarize / isLedgerRecord
 * 摘要口径（summarizeRollbackPoint）与记录校验（isRollbackPointRecord）是 rollback-point.ts 的
 * **冻结单一事实源**；本模块只做存储。用注入而不是 import，是为了让依赖方向保持单向
 * （rollback-point.ts -> rollback-ledger.ts），避免两个模块互相 import 形成运行期循环。
 */
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { atomicWriteFile } from '../utils/atomic-write.ts'
import { isRecord } from '../utils/guards.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { UNDO_DONE_FILE_NAME, UNDO_JOURNAL_FILE_NAME } from './rollback-undo-journal.ts'
import type {
  RollbackCode,
  RollbackPointKind,
  RollbackPointRecord,
  RollbackPointSummary,
  RollbackSegmentSummary,
  RollbackSessionPayload,
  RollbackStateKind,
  RollbackWorkspaceFile,
  RollbackWorkspacePayload,
} from './rollback-point.ts'

/* ------------------------------------------------------------------ 常量 */

/** 清单格式版本（与**记录**的 schemaVersion 无关：后者是记录内容的版本，恒为 2） */
export const ROLLBACK_LEDGER_SCHEMA_VERSION = 3
/** 单条记录目录名 */
export const ROLLBACK_RECORDS_DIR_NAME = 'records'
/** 内容寻址载荷目录名 */
export const ROLLBACK_PAYLOADS_DIR_NAME = 'payloads'
/**
 * 回退前像暂存目录名（`<root>/undo/<pid>-<ts36>-<8hex>/`）。
 * 名字以 pid 开头是**清理判据的一部分**（见 cleanupOrphanTempFiles）；改命名必须同步改 `UNDO_DIR_RE`。
 */
export const ROLLBACK_UNDO_DIR_NAME = 'undo'
/** v2 单文件迁移成功后的保留名（改名，不是删除） */
export const ROLLBACK_LEDGER_BACKUP_NAME = 'index.v2.backup.json'
/**
 * 台账（records/ + payloads/）缺省字节预算。
 *
 * 为什么需要它：ROLLBACK_MAX_RECORDS（50）只限**条数**，一条记录的工作区载荷可以到几十 MB
 * （本机实测 50 条 = 473 MB，直接把宿主撑爆）。字节预算与条数预算**互相独立**，两者都生效。
 */
export const ROLLBACK_DEFAULT_LEDGER_BYTES = 256 * 1024 * 1024

/** 迁移锁名（同一 dataDir 被多个引擎实例并发初始化时的互斥） */
const MIGRATION_LOCK_NAME = '.dshcm-ledger-migrating'
/** 迁移锁视为陈旧（持锁进程已崩）的阈值 */
const MIGRATION_LOCK_STALE_MS = 5 * 60 * 1000
/** 探测清单 schemaVersion 时只读文件头这么多字节（**绝不**为探测而整份读） */
const SCHEMA_SNIFF_BYTES = 8 * 1024
/** 迁移时单条记录允许的最大字符数（异常输入的保护；正常记录远小于它） */
const MIGRATE_MAX_ITEM_CHARS = 512 * 1024 * 1024
/** v2 头部里 records 数组起始 '[' 的搜索上限（超出 = 形状不符，如实失败） */
const MIGRATE_MAX_HEAD_CHARS = 64 * 1024

const OBJECT_KEY_RE = /^[0-9a-f]{64}$/
/** 记录文件名 = 记录 id；只允许可自证安全的字符（防篡改清单把路径引出去） */
export const LEDGER_RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * atomic-write.ts 产生的临时文件名形态：
 * .dshcm.<safeBase>.<pid>.<16 位 hex>.tmp（见该文件 tmpPath()：TMP_PREFIX + base + '.' + pid + '.' + randomHex(8) + '.tmp'）。
 * **先读实现再写判据** —— 判不出来就一个都不删（宁可留垃圾也不删用户数据）。
 */
const TEMP_FILE_RE = /^\.dshcm\.(.+)\.(\d+)\.([0-9a-f]{16})\.tmp$/
/** 前像暂存目录名：`<pid>-<ts36>-<8hex>`（pid 必须在最前，清理判据要读它） */
const UNDO_DIR_RE = /^(\d+)-[0-9a-z]+-[0-9a-f]{8}$/

/* --------------------------------------------------------------- 类型 */

/** 台账里一条记录的**纯标量**头（与 RollbackTrack 的可序列化部分逐字对应） */
export interface RollbackLedgerTrackHeader {
  kind: RollbackStateKind
  capturedAt: number
  ok: boolean
  degraded: boolean
  fingerprint: string | null
  reasonCode: string | null
  reasonDetail: string | null
}

/**
 * 清单条目：**绝不含大数组**。段摘要（segments）在写入时由注入的 summarize 算出，
 * list() 直接回放 —— 口径只有一份，且清单大小与工作区文件数无关。
 */
export interface RollbackLedgerManifestEntry {
  id: string
  kind: RollbackPointKind
  createdAt: number
  spreadMs: number
  protected: boolean
  incomplete: boolean
  note: string | null
  sessionId: string | null
  unitId: string | null
  turnSeq: number | null
  boundarySeq: number | null
  /** 该条记录文件的字节数（预算淘汰时用于估算可释放空间） */
  recordBytes: number
  workspace: RollbackLedgerTrackHeader & {
    /** 内容寻址载荷哈希；null = 该态没有载荷（捕获失败） */
    payload: string | null
    /** 载荷文件字节数（**同一哈希只算一次**，预算与统计用） */
    payloadBytes: number
    /**
     * 这份点**解析所需的全部载荷哈希**（自身在前、基准依次在后）。
     * 增量载荷依赖基准 ⇒ 回收（prunePayloads）必须按链保活，否则链一断这个点就读不出来了。
     * 老清单没有该字段 ⇒ 视为 `[payload]`（老载荷都是全量、无依赖）。
     */
    payloadChain?: string[]
  }
  session: RollbackLedgerTrackHeader & {
    /** 会话字节副本的对象仓键；null = 没有副本（回收对象时用，不必读记录文件） */
    object: string | null
  }
  /** 冻结口径的段摘要（= summarizeRollbackPoint(record).segments） */
  segments: RollbackSegmentSummary[]
}

/** 清单条目 -> 列表投影（逐字等于旧的 summarizeRollbackPoint(record)，因为它是写入时算好的） */
export function entrySummaryOf(entry: RollbackLedgerManifestEntry): RollbackPointSummary {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    sessionId: entry.sessionId,
    unitId: entry.unitId,
    turn: entry.turnSeq,
    boundarySeq: entry.boundarySeq,
    kind: entry.kind,
    protected: entry.protected,
    incomplete: entry.incomplete,
    note: entry.note,
    spreadMs: entry.spreadMs,
    segments: entry.segments,
  }
}

export interface RollbackLedgerMigration {
  /** 是否真的改了磁盘布局（v2 -> v3，或从 records/ 重建清单） */
  migrated: boolean
  /** 成功落盘的记录条数 */
  records: number
  /** 形状不合格被跳过的条数（如实计数，绝不静默） */
  skipped: number
  /** 非空 = 迁移失败（原文件未动，下次启动重试） */
  error?: string
}

export interface RollbackLedgerOptions {
  /** 回滚点库根目录（= dataDir/rollback-points） */
  root: string
  /** 冻结口径的摘要（rollback-point.ts 的 summarizeRollbackPoint） */
  summarize: (record: RollbackPointRecord) => RollbackPointSummary
  /** 冻结口径的记录校验（rollback-point.ts 的 isRollbackPointRecord） */
  isLedgerRecord: (value: unknown) => value is RollbackPointRecord
  /** 字节预算；缺省 ROLLBACK_DEFAULT_LEDGER_BYTES */
  bytesBudget?: number
  now?: () => number
  /** best-effort 日志（绝不抛给调用方） */
  log?: (line: string) => void
  /**
   * 每次「读一条记录文件 / 一份载荷文件」前的观测钩子（生产不传）。
   * 为什么要有它：内存护栏需要**确定性**证据 —— 「单次 append 绝不读别人的记录文件」
   * 只能靠数读盘次数来钉，而不是靠不可复现的堆采样。
   */
  onFileRead?: (file: string) => void
  /** 写 seam（缺省 = atomicWriteFile）；测试用它注入「第 N 次写失败」以验证迁移中断可重试 */
  writeFile?: (target: string, bytes: Uint8Array) => Promise<void>
}

/** 一次「准备写一条记录」的产物（先把清单条目算出来，预算淘汰才能在写之前决策） */
export interface RollbackLedgerPrepared {
  entry: RollbackLedgerManifestEntry
  /** 记录文件内容（workspace.payload 已换成哈希引用） */
  recordJson: string
  /** 载荷文件内容；null = 该态没有载荷 */
  payloadJson: string | null
  payloadHash: string | null
}

export interface RollbackLedgerStats {
  /** records/ 下的文件数 */
  records: number
  /** records/ + payloads/ 的总字节 */
  bytes: number
}

/* ----------------------------------------------------- 迁移：流式切片 */

/**
 * 从 v2 单文件里**流式**切出 records 数组的每个顶层对象，逐个交给 onRecord。
 *
 * 为什么必须流式：451 MiB 的文件 readFile + 整份 JSON.parse 必然 OOM（这正是本 issue 的现场）。
 * 状态机只在一个对象内累积文本（一个对象 = 一条记录），其余字节掠过即丢。
 */
async function streamLedgerRecords(
  file: string,
  onRecord: (text: string) => Promise<void>,
): Promise<{ count: number; skipped: number }> {
  const stream = createReadStream(file)
  const decoder = new StringDecoder('utf8')
  let phase: 'head' | 'array' | 'done' = 'head'
  let head = ''
  let rest = ''
  let depth = 0
  let inString = false
  let item: string[] = []
  let itemChars = 0
  let count = 0
  let skipped = 0

  const STRUCT_RE = /[{}[\]"]/g

  /** 从头里找 'records' 键之后的数组起始 '['（v2 文件头部的一小段，有界） */
  const tryFindArray = (): boolean => {
    const key = head.indexOf('"records"')
    if (key < 0) return false
    const open = head.indexOf('[', key + 9)
    if (open < 0) return false
    rest = head.slice(open + 1)
    head = ''
    phase = 'array'
    return true
  }

  for await (const raw of stream) {
    const text = typeof raw === 'string' ? raw : decoder.write(raw as Buffer)
    if (phase === 'head') {
      head += text
      if (!tryFindArray()) {
        if (head.length > MIGRATE_MAX_HEAD_CHARS) {
          // v2 文件一定在头部就有 records 键；找不到 = 形状不符（如实失败，不猜）
          stream.destroy()
          throw new Error('ledger records array not found in head')
        }
        continue
      }
    } else {
      rest += text
    }

    let i = 0
    while (i < rest.length) {
      if (itemChars > MIGRATE_MAX_ITEM_CHARS) {
        stream.destroy()
        throw new Error('ledger record too large while migrating')
      }
      if (depth === 0 && !inString) {
        // 数组顶层：两个对象之间的空白 / 逗号是**分隔符**，绝不能混进下一条记录的文本
        // （真机踩过：pretty-print 的 v2 文件里 ,\n  会被拼到下一个 { 前面，导致 JSON.parse 失败并把记录当垃圾跳过）
        if (itemChars > 0) { item = []; itemChars = 0 }
      }
      if (inString) {
        // 字符串内：跳到结束引号（快路径 = indexOf + 反斜杠奇偶判据）
        const end = findStringEnd(rest, i)
        if (end < 0) {
          item.push(rest.slice(i))
          itemChars += rest.length - i
          i = rest.length
          break
        }
        item.push(rest.slice(i, end + 1))
        itemChars += end + 1 - i
        i = end + 1
        inString = false
        continue
      }
      STRUCT_RE.lastIndex = i
      const m = STRUCT_RE.exec(rest)
      if (m === null) {
        if (depth > 0) { item.push(rest.slice(i)); itemChars += rest.length - i }
        i = rest.length
        break
      }
      const at = m.index
      const ch = m[0]
      // 顶层（depth === 0）的空白 / 逗号只是分隔符：push 进去会把下一条记录的 JSON 弄坏
      if (at > i && depth > 0) {
        item.push(rest.slice(i, at))
        itemChars += at - i
      }
      i = at + 1
      if (ch === '"') { inString = true; item.push('"'); continue }
      if (ch === '{' || ch === '[') {
        if (depth === 0 && ch !== '{') {
          // records 数组里的顶层项必须是对象；不是就跳过并计数（形状不符，不猜）
          skipped += 1
          item = []
          itemChars = 0
          continue
        }
        depth += 1
        item.push(ch)
        continue
      }
      if (ch === '}' || ch === ']') {
        if (depth === 0) {
          if (ch === ']') { phase = 'done'; break }
          skipped += 1
          continue
        }
        depth -= 1
        item.push(ch)
        if (depth === 0) {
          const text2 = item.join('')
          item = []
          itemChars = 0
          await onRecord(text2)
          count += 1
        }
        continue
      }
    }
    if (phase === 'done') break
    rest = rest.slice(i)
  }
  return { count, skipped }
}

/** 在 s 的 from 之后找**未被转义**的结束引号；找不到返回 -1 */
function findStringEnd(s: string, from: number): number {
  let i = from
  for (;;) {
    const q = s.indexOf('"', i)
    if (q < 0) return -1
    let backslashes = 0
    let k = q - 1
    while (k >= 0 && s.charCodeAt(k) === 92) { backslashes += 1; k -= 1 }
    if (backslashes % 2 === 0) return q
    i = q + 1
  }
}

/* --------------------------------------------------- 孤儿临时文件清理 */

export interface RollbackTempCleanupResult {
  removed: number
  bytes: number
  /** 形似临时文件但**判据不足**（判不准就不删） */
  skipped: number
}

/** 统计一棵目录树的字节数（只用于清理统计；读不到按 0 计，绝不因为统计失败而不删） */
async function dirBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await dirBytes(full)
      else total += (await fs.stat(full)).size
    } catch {
      /* 读不到就不计 */
    }
  }
  return total
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限发信号（Windows 上很常见）⇒ 仍然算活着
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * 删除 rollback-points/ 下**形状可自证**的崩溃残留原子写临时文件。
 *
 * 判据（三条全中才删，判不准一律不删）：
 *  1. 名字逐字符合 atomic-write.ts 的 tmpPath() 形态：.dshcm.<base>.<pid>.<16hex>.tmp；
 *  2. 该 pid **不是本进程**（本进程的 tmp 可能正在写）；
 *  3. 该 pid 进程已不存在（崩溃残留）—— 仍然活着的进程可能正在写，绝不抢。
 * 只扫根目录与它的一级子目录（records/ payloads/ objects/），不递归。
 */
/**
 * 这个 undo 目录是不是「**回退写到一半就没了**」的现场（有 journal 索引、但没有 done 标记）。
 *
 * 判据必须与 journal 模块**同一份常量**（import 而不是抄字面量）：名字改了这里要跟着改，否则
 * 要么把现场当垃圾删掉（灾难），要么永远不清残留（垃圾堆积）。
 */
async function hasUnfinishedJournal(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, UNDO_DONE_FILE_NAME))
    return false
  } catch {
    /* 没有 done：再看有没有 journal 索引 */
  }
  try {
    await fs.access(path.join(dir, UNDO_JOURNAL_FILE_NAME))
    return true
  } catch {
    return false
  }
}

export async function cleanupOrphanTempFiles(root: string): Promise<RollbackTempCleanupResult> {
  const out: RollbackTempCleanupResult = { removed: 0, bytes: 0, skipped: 0 }
  let dirs: string[]
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    dirs = [root]
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name))
    }
  } catch {
    return out
  }
  for (const dir of dirs) {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = TEMP_FILE_RE.exec(name)
      if (m === null) continue
      const base = m[1] ?? ''
      const pid = Number(m[2])
      if (base === '' || base.includes('/') || base.includes('\\')) { out.skipped += 1; continue }
      if (pid === process.pid || isProcessAlive(pid)) { out.skipped += 1; continue }
      const target = path.join(dir, name)
      let bytes = 0
      try {
        const info = await fs.stat(target)
        if (!info.isFile()) { out.skipped += 1; continue }
        bytes = info.size
        await fs.rm(target, { force: true })
      } catch {
        out.skipped += 1
        continue
      }
      out.removed += 1
      out.bytes += bytes
    }
  }
  // 回退前像暂存目录（<root>/undo/<pid>-<ts>-<hex>/）：**进程已死的残留整目录删除**。
  // 判据与 tmp 文件同源：pid 必须不是本进程、且已不存在；判不准一律不碰（skipped）。
  try {
    const undoRoot = path.join(root, ROLLBACK_UNDO_DIR_NAME)
    const names = await fs.readdir(undoRoot)
    for (const name of names) {
      const m = UNDO_DIR_RE.exec(name)
      if (m === null) { out.skipped += 1; continue }
      const pid = Number(m[1])
      if (pid === process.pid || isProcessAlive(pid)) { out.skipped += 1; continue }
      const target = path.join(undoRoot, name)
      // **例外（2026-10-18）**：有 journal 却没有 done ⇒ 这不是垃圾，是「回退写到一半进程就没了」
      // 的现场。必须留住：既能被 findInterruptedUndos 认出来，也能按 after 镜像安全重放
      //（把工作区退回回退前）。删掉它 = 让半回退的工作区变成无人知晓的残留。
      try {
        if (await hasUnfinishedJournal(target)) { out.skipped += 1; continue }
      } catch {
        // 判据自己读不出来 ⇒ **不碰**（宁可留垃圾，也不删可能还能救命的现场）
        out.skipped += 1
        continue
      }
      try {
        const bytes = await dirBytes(target)
        await fs.rm(target, { recursive: true, force: true })
        out.removed += 1
        out.bytes += bytes
      } catch {
        out.skipped += 1
      }
    }
  } catch {
    /* undo 目录不存在（正常状态） */
  }
  return out
}

/* ------------------------------------------------------------ 校验工具 */

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function asReasonCode(value: unknown): RollbackCode | null {
  return typeof value === 'string' && value !== '' ? (value as RollbackCode) : null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeTrackHeader(value: unknown, kind: RollbackStateKind): RollbackLedgerTrackHeader | null {
  if (!isRecord(value)) return null
  if (value['kind'] !== kind) return null
  const capturedAt = value['capturedAt']
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  if (typeof value['ok'] !== 'boolean') return null
  return {
    kind,
    capturedAt,
    ok: value['ok'],
    degraded: value['degraded'] === true,
    fingerprint: asNullableString(value['fingerprint']),
    reasonCode: typeof value['reasonCode'] === 'string' ? value['reasonCode'] : null,
    reasonDetail: asNullableString(value['reasonDetail']),
  }
}

function normalizeSegment(value: unknown, state: RollbackStateKind): RollbackSegmentSummary | null {
  if (!isRecord(value)) return null
  if (value['state'] !== state) return null
  const capturedAt = value['capturedAt']
  const entries = value['entries']
  const bytes = value['bytes']
  const skippedCount = value['skippedCount']
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  if (typeof entries !== 'number' || !Number.isFinite(entries)) return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null
  if (typeof skippedCount !== 'number' || !Number.isFinite(skippedCount)) return null
  return {
    state,
    ok: value['ok'] === true,
    degraded: value['degraded'] === true,
    capturedAt,
    fingerprint: asNullableString(value['fingerprint']),
    reasonCode: asReasonCode(value['reasonCode']),
    entries,
    bytes,
    cursorBytes: asNullableNumber(value['cursorBytes']),
    restorable: value['restorable'] === true,
    skippedCount,
    truncated: value['truncated'] === true,
  }
}

/** 清单条目校验：形状不对就**丢掉并计数**（与 v2 的 records.filter(isRollbackPointRecord) 同一条路） */
export function normalizeManifestEntry(value: unknown): RollbackLedgerManifestEntry | null {
  if (!isRecord(value)) return null
  const id = value['id']
  if (typeof id !== 'string' || !LEDGER_RECORD_ID_RE.test(id)) return null
  const kind = value['kind']
  if (kind !== 'auto' && kind !== 'guard') return null
  const createdAt = value['createdAt']
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  const spreadMs = value['spreadMs']
  if (typeof spreadMs !== 'number' || !Number.isFinite(spreadMs)) return null
  const workspace = normalizeTrackHeader(value['workspace'], 'workspace')
  const session = normalizeTrackHeader(value['session'], 'session')
  if (workspace === null || session === null) return null
  const rawSegments = value['segments']
  if (!Array.isArray(rawSegments) || rawSegments.length !== 2) return null
  const first = normalizeSegment(rawSegments[0], 'workspace')
  const second = normalizeSegment(rawSegments[1], 'session')
  if (first === null || second === null) return null
  const workspaceRaw = value['workspace']
  const sessionRaw = value['session']
  const wsPayload = isRecord(workspaceRaw) ? workspaceRaw['payload'] : null
  if (wsPayload !== null && (typeof wsPayload !== 'string' || !OBJECT_KEY_RE.test(wsPayload))) return null
  const sessionObject = isRecord(sessionRaw) ? sessionRaw['object'] : null
  if (sessionObject !== null && (typeof sessionObject !== 'string' || !OBJECT_KEY_RE.test(sessionObject))) return null
  const rawRecordBytes = value['recordBytes']
  const rawPayloadBytes = isRecord(workspaceRaw) ? workspaceRaw['payloadBytes'] : 0
  const rawPayloadChain = isRecord(workspaceRaw) ? workspaceRaw['payloadChain'] : null
  return {
    id,
    kind,
    createdAt,
    spreadMs,
    protected: value['protected'] === true,
    incomplete: value['incomplete'] === true,
    note: asNullableString(value['note']),
    sessionId: asNullableString(value['sessionId']),
    unitId: asNullableString(value['unitId']),
    turnSeq: asNullableNumber(value['turnSeq']),
    boundarySeq: asNullableNumber(value['boundarySeq']),
    recordBytes: typeof rawRecordBytes === 'number' && Number.isFinite(rawRecordBytes) && rawRecordBytes >= 0 ? rawRecordBytes : 0,
    workspace: {
      ...workspace,
      payload: typeof wsPayload === 'string' ? wsPayload : null,
      payloadBytes: typeof rawPayloadBytes === 'number' && Number.isFinite(rawPayloadBytes) && rawPayloadBytes >= 0 ? rawPayloadBytes : 0,
    // 只保留形状合法的哈希；读不回来的链由解析器如实失败（绝不猜）
    ...(Array.isArray(rawPayloadChain)
      ? { payloadChain: rawPayloadChain.filter((h) => typeof h === 'string' && OBJECT_KEY_RE.test(h)) }
      : {}),
    },
    session: { ...session, object: typeof sessionObject === 'string' ? sessionObject : null },
    segments: [first, second],
  }
}

/** 载荷形状校验：**严格**（形状不符 = readRecord 失败，绝不拼半个 payload） */
function normalizeWorkspacePayload(value: unknown): RollbackWorkspacePayload | null {
  if (!isRecord(value)) return null
  const arrays = ['chunks', 'files', 'skipped', 'excludedDirs', 'unreadableDirs', 'unreadableFiles', 'ignoredDirs']
  for (const key of arrays) {
    if (!Array.isArray(value[key])) return null
  }
  const numbers = ['skippedCount', 'ignoredDirCount', 'bytes']
  for (const key of numbers) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return null
  }
  if (typeof value['skippedTruncated'] !== 'boolean') return null
  if (typeof value['truncated'] !== 'boolean') return null
  return value as unknown as RollbackWorkspacePayload
}

/**
 * **存盘**形状校验：完整清单（`files` 是数组）或增量视图（`delta` 是对象、`files` 故意留 null）。
 * 与 {@link normalizeWorkspacePayload}（消费侧，要求物化后的完整形状）分开：增量载荷**绝不会**被当成完整清单读出去。
 */
function normalizeStoredPayload(value: unknown): RollbackWorkspacePayload | null {
  const base = normalizeWorkspacePayload(value)
  if (base !== null) return base
  if (!isRecord(value)) return null
  const delta = value['delta']
  if (!isRecord(delta)) return null
  if (typeof delta['base'] !== 'string') return null
  if (!Array.isArray(delta['added']) || !Array.isArray(delta['removed'])) return null
  const clone = { ...value, files: [] }
  return normalizeWorkspacePayload(clone)
}

function normalizeSessionPayload(value: unknown): RollbackSessionPayload | null {
  if (!isRecord(value)) return null
  if (value['sessionId'] !== null && typeof value['sessionId'] !== 'string') return null
  if (typeof value['bytes'] !== 'number' || !Number.isFinite(value['bytes'])) return null
  if (typeof value['fingerprint'] !== 'string') return null
  return value as unknown as RollbackSessionPayload
}

/* ---------------------------------------------------------------- 存储层 */

export class RollbackLedger {
  readonly root: string
  readonly manifestPath: string
  readonly backupPath: string
  readonly recordsDir: string
  readonly payloadsDir: string
  readonly objectsDir: string
  readonly bytesBudget: number
  private readonly summarize: (record: RollbackPointRecord) => RollbackPointSummary
  private readonly isLedgerRecord: (value: unknown) => value is RollbackPointRecord
  private readonly nowFn: () => number
  private readonly log: ((line: string) => void) | undefined
  private readonly onFileRead: ((file: string) => void) | undefined
  private readonly writeSeam: ((target: string, bytes: Uint8Array) => Promise<void>) | undefined
  /**
   * 被**字节预算**淘汰的自动点累计数（可观测；与「条数上限」淘汰分开计数）。
   *
   * 为什么必须**持久化**而不是只记在实例上：宿主每个请求都新建一个引擎（路由侧），
   * 只记在实例上的话这个数字永远是 0 —— 界面就永远看不到「已经因为预算淘汰过 N 个」。
   * 值随清单落盘（`evicted` 字段），读清单时取「磁盘值与内存值的大者」，
   * 这样「先 markEvicted 再读清单」的时序也不会把刚加上的计数抹掉。
   */
  private evicted = 0

  constructor(options: RollbackLedgerOptions) {
    this.root = path.resolve(options.root)
    this.manifestPath = path.join(this.root, 'index.json')
    this.backupPath = path.join(this.root, ROLLBACK_LEDGER_BACKUP_NAME)
    this.recordsDir = path.join(this.root, ROLLBACK_RECORDS_DIR_NAME)
    this.payloadsDir = path.join(this.root, ROLLBACK_PAYLOADS_DIR_NAME)
    this.objectsDir = path.join(this.root, 'objects')
    this.summarize = options.summarize
    this.isLedgerRecord = options.isLedgerRecord
    this.bytesBudget = options.bytesBudget ?? ROLLBACK_DEFAULT_LEDGER_BYTES
    this.nowFn = options.now ?? (() => Date.now())
    this.log = options.log
    this.onFileRead = options.onFileRead
    this.writeSeam = options.writeFile
  }

  get evictedCount(): number {
    return this.evicted
  }

  markEvicted(count: number): void {
    if (count > 0) this.evicted += count
  }

  private warn(line: string): void {
    try { this.log?.(line) } catch { /* 日志失败绝不影响主流程 */ }
  }

  private async write(target: string, bytes: Uint8Array): Promise<void> {
    if (this.writeSeam !== undefined) {
      await this.writeSeam(target, bytes)
      return
    }
    await atomicWriteFile(target, bytes)
  }

  private async readText(file: string): Promise<string> {
    this.onFileRead?.(file)
    return await fs.readFile(file, 'utf8')
  }

  private async exists(target: string): Promise<boolean> {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  }

  private recordPath(id: string): string | null {
    if (!LEDGER_RECORD_ID_RE.test(id)) return null
    const target = path.join(this.recordsDir, id + '.json')
    if (!target.startsWith(this.recordsDir + path.sep)) return null
    return target
  }

  private payloadPath(hash: string): string | null {
    if (!OBJECT_KEY_RE.test(hash)) return null
    return path.join(this.payloadsDir, hash + '.json')
  }

  /**
   * 清单文件的**代际戳**（mtimeMs + 字节数）。跨进程乐观并发用：留点侧在读清单前后各取一次，
   * 不一致说明另一个实例写过 ⇒ 重读重试，绝不拿自己的快照覆盖别人的清单。
   * 读不到返回 null = **不参与判定**（可选探针失败绝不阻塞留点）。
   */
  async manifestStamp(): Promise<string | null> {
    try {
      const info = await fs.stat(this.manifestPath)
      return String(info.mtimeMs) + ':' + String(info.size)
    } catch {
      return null
    }
  }

  /** 这份载荷是否已经落过盘（内容寻址 ⇒ 已存在就是同一份，可零写入；也是「本次新增字节」的判据） */
  async hasPayload(hash: string): Promise<boolean> {
    const target = this.payloadPath(hash)
    if (target === null) return false
    return await this.exists(target)
  }

  /* ------------------------------------------------------------ 清单 */

  async readManifest(): Promise<{ entries: RollbackLedgerManifestEntry[]; error?: string }> {
    let raw: string
    try {
      raw = await this.readText(this.manifestPath)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      // 不存在 = 首次使用（不是错误）；其它读失败如实回报
      if (code === 'ENOENT') return { entries: [] }
      return { entries: [], error: 'ledger unreadable: ' + errorDetail(error) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { entries: [], error: 'ledger unreadable: ' + errorDetail(error) }
    }
    if (!isRecord(parsed)) return { entries: [], error: 'ledger shape invalid' }
    if (parsed['schemaVersion'] !== ROLLBACK_LEDGER_SCHEMA_VERSION) {
      // v2 单文件（迁移没跑成）或未来版本：绝不拿它当清单用（否则会把记录当垃圾丢掉）
      return { entries: [], error: 'ledger unreadable: unsupported ledger schemaVersion ' + String(parsed['schemaVersion']) }
    }
    // 预算淘汰累计：取磁盘值与内存值的大者（markEvicted 后立刻读清单的时序不得回退计数）
    const persistedEvicted = parsed['evicted']
    if (typeof persistedEvicted === 'number' && Number.isFinite(persistedEvicted) && persistedEvicted > this.evicted) {
      this.evicted = Math.floor(persistedEvicted)
    }
    const list = parsed['records']
    if (!Array.isArray(list)) return { entries: [], error: 'ledger.records invalid' }
    const entries: RollbackLedgerManifestEntry[] = []
    let dropped = list.length
    for (const value of list) {
      const entry = normalizeManifestEntry(value)
      if (entry === null) continue
      entries.push(entry)
      dropped -= 1
    }
    // 自证：清单里的每个 id 都必须在 records/ 里真的有一份（找不到就跳过并计数）
    const missing = await this.findMissingRecordFiles(entries)
    if (missing.size > 0) {
      const errors: string[] = []
      if (dropped > 0) errors.push('ledger dropped ' + String(dropped) + ' invalid record(s)')
      errors.push('ledger missing ' + String(missing.size) + ' record file(s)')
      return { entries: entries.filter((entry) => !missing.has(entry.id)), error: errors.join('; ') }
    }
    return dropped > 0
      ? { entries, error: 'ledger dropped ' + String(dropped) + ' invalid record(s)' }
      : { entries }
  }

  private async findMissingRecordFiles(entries: readonly RollbackLedgerManifestEntry[]): Promise<Set<string>> {
    const missing = new Set<string>()
    if (entries.length === 0) return missing
    let names: string[]
    try {
      names = await fs.readdir(this.recordsDir)
    } catch {
      // 目录都没有 ⇒ 所有条目都缺文件（诚实计数）
      for (const entry of entries) missing.add(entry.id)
      return missing
    }
    const present = new Set<string>()
    for (const name of names) {
      if (name.endsWith('.json')) present.add(name.slice(0, -5))
    }
    for (const entry of entries) {
      if (!present.has(entry.id)) missing.add(entry.id)
    }
    return missing
  }

  /** 原子写清单（小文件；条目由调用方决定） */
  async writeManifest(entries: readonly RollbackLedgerManifestEntry[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    const body = JSON.stringify({
      schemaVersion: ROLLBACK_LEDGER_SCHEMA_VERSION,
      records: entries,
      // 预算淘汰累计（持久化：见 evicted 字段的说明 —— 每请求新实例的场景下必须靠它才看得见）
      evicted: this.evicted,
    }, null, 2)
    await this.write(this.manifestPath, Buffer.from(body, 'utf8'))
  }

  /* -------------------------------------------------------- 单条记录 */

  /** 把完整记录拆成「清单条目 + 记录文件内容 + 载荷文件内容」（**不做 IO**，纯函数） */
  prepareRecord(
    record: RollbackPointRecord,
    reuse?: { hash: string; bytes: number; chain?: string[] },
  ): RollbackLedgerPrepared {
    const summary = this.summarize(record)
    const workspaceTrack = record.workspace
    const sessionTrack = record.session
    const payload = workspaceTrack.payload
    let payloadJson: string | null = null
    let payloadHash: string | null = null
    let payloadBytes = 0
    if (payload !== null && reuse !== undefined) {
      // **复用**：这份工作区态与基准点逐条相同 ⇒ 直接引用它已经落盘的载荷（零额外字节，链不增长）
      payloadHash = reuse.hash
      payloadBytes = reuse.bytes
    } else if (payload !== null) {
      payloadJson = JSON.stringify(payload)
      payloadHash = sha256Hex(payloadJson)
      payloadBytes = byteLength(payloadJson)
    }
    const recordJson = JSON.stringify({
      ledgerSchemaVersion: ROLLBACK_LEDGER_SCHEMA_VERSION,
      schemaVersion: record.schemaVersion,
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      spreadMs: record.spreadMs,
      protected: record.protected,
      incomplete: record.incomplete,
      note: record.note,
      sessionId: record.sessionId,
      unitId: record.unitId,
      turnSeq: record.turnSeq,
      boundarySeq: record.boundarySeq,
      workspace: { ...trackHeader(workspaceTrack), payload: payloadHash },
      session: { ...trackHeader(sessionTrack), payload: sessionTrack.payload },
    })
    // 增量视图 ⇒ 清单条目带上「解析所需的全部载荷哈希」（自身 + 基准链），回收按链保活
    const payloadChain = payloadHash === null
      ? undefined
      : reuse !== undefined
        ? (reuse.chain !== undefined && reuse.chain.length > 0 ? [...reuse.chain] : [payloadHash])
        : payload?.delta === undefined
          ? [payloadHash]
          : [payloadHash, ...payload.delta.baseChain]
    const entry: RollbackLedgerManifestEntry = {
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      spreadMs: record.spreadMs,
      protected: record.protected,
      incomplete: record.incomplete,
      note: record.note,
      sessionId: record.sessionId,
      unitId: record.unitId,
      turnSeq: record.turnSeq,
      boundarySeq: record.boundarySeq,
      recordBytes: byteLength(recordJson),
      workspace: { ...trackHeader(workspaceTrack), payload: payloadHash, payloadBytes, ...(payloadChain === undefined ? {} : { payloadChain }) },
      session: { ...trackHeader(sessionTrack), object: sessionTrack.payload?.object ?? null },
      segments: summary.segments,
    }
    return { entry, recordJson, payloadJson, payloadHash }
  }

  /**
   * 落盘：载荷（内容寻址；同一哈希已存在则**零写入**）+ 记录文件。
   * 先载荷后记录：中途失败只留一份没人引用的载荷（垃圾，不是坏数据），下次 prune 回收。
   */
  async writePrepared(prepared: RollbackLedgerPrepared): Promise<void> {
    if (prepared.payloadJson !== null && prepared.payloadHash !== null) {
      const target = this.payloadPath(prepared.payloadHash)
      if (target === null) throw new Error('ledger payload key invalid')
      await fs.mkdir(this.payloadsDir, { recursive: true })
      if (!(await this.exists(target))) {
        await this.write(target, Buffer.from(prepared.payloadJson, 'utf8'))
      }
    }
    const recordFile = this.recordPath(prepared.entry.id)
    if (recordFile === null) throw new Error('ledger record id invalid')
    await fs.mkdir(this.recordsDir, { recursive: true })
    await this.write(recordFile, Buffer.from(prepared.recordJson, 'utf8'))
  }

  /** 读校验过的载荷（哈希不符 / 形状不符 -> error，绝不返回半个） */
  /**
   * **原始**读取一份载荷（形状校验 + 内容寻址自证）。
   * `files` 可能只是「相对基准的增量子集」（`payload.delta` 非空）—— **只给解析器用**，
   * 消费者一律走 {@link resolvePayload} 拿物化后的完整清单。
   */
  private async readStoredPayload(hash: string): Promise<{ payload?: RollbackWorkspacePayload; error?: string }> {
    const target = this.payloadPath(hash)
    if (target === null) return { error: 'record-incomplete: payload ref invalid' }
    let raw: string
    try {
      raw = await this.readText(target)
    } catch (error) {
      return { error: 'record-incomplete: payload unreadable (' + errorDetail(error) + ')' }
    }
    // 内容寻址 ⇒ 字节一变就对不上：这是「这份载荷是不是我以为的那份」的唯一自证
    if (sha256Hex(raw) !== hash) return { error: 'record-incomplete: payload hash mismatch' }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { error: 'record-incomplete: payload unreadable (' + errorDetail(error) + ')' }
    }
    const payload = normalizeStoredPayload(parsed)
    if (payload === null) return { error: 'record-incomplete: payload shape invalid' }
    return { payload }
  }


  /**
   * 解析一份载荷：增量视图**物化**成完整 `files`（含 `object` 字段补回），全量视图原样返回。
   *
   * 任何一环不成立（基准缺失 / 哈希不符 / 形状不符 / 链成环）⇒ **如实失败**：绝不返回半个清单 ——
   * 半份清单会让「留点后新建」的判据把绝大多数文件当成新建的，回退就会删掉它们。
   */
  async resolvePayload(hash: string): Promise<{ payload?: RollbackWorkspacePayload; error?: string }> {
    // **不缓存**：载荷被删/被改必须立刻看得见（缓存会把「存储已经坏了」蒙过去），
    // 也守住「一次只驻留一份载荷」的内存护栏（issue #89 的 OOM 现场）。
    return this.materializePayload(hash, new Set([hash]))
  }

  private async materializePayload(
    hash: string,
    seen: Set<string>,
  ): Promise<{ payload?: RollbackWorkspacePayload; error?: string }> {
    const stored = await this.readStoredPayload(hash)
    if (stored.payload === undefined) return { error: stored.error ?? 'record-incomplete: payload unreadable' }
    const payload = stored.payload
    const delta = payload.delta
    if (delta === undefined) return { payload: withObjectRefs(payload) }
    if (typeof delta.base !== 'string' || !OBJECT_KEY_RE.test(delta.base)) {
      return { error: 'record-incomplete: delta base ref invalid' }
    }
    if (seen.has(delta.base)) return { error: 'record-incomplete: delta chain cycle' }
    const next = new Set(seen)
    next.add(delta.base)
    const base = await this.materializePayload(delta.base, next)
    if (base.payload === undefined) {
      return { error: 'record-incomplete: delta base unresolved (' + String(base.error ?? '') + ')' }
    }
    const removed = new Set<string>()
    for (const p of Array.isArray(delta.removed) ? delta.removed : []) if (typeof p === 'string') removed.add(p)
    const added = withObjectRefs({ ...payload, files: delta.added ?? [], delta: undefined }).files
    const addedPaths = new Set<string>()
    for (const file of added) if (typeof file?.path === 'string') addedPaths.add(file.path)
    const files: RollbackWorkspaceFile[] = []
    for (const file of base.payload.files) {
      if (typeof file?.path !== 'string') continue
      if (removed.has(file.path) || addedPaths.has(file.path)) continue
      files.push(file)
    }
    for (const file of added) files.push(file)
    // 与全量捕获同序（`payload.files.sort` 用的就是这个比较器）
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return { payload: { ...payload, files, delta: undefined } }
  }

  /** 读一条**完整**记录（引用解析对调用方透明）；任何一步不成立就如实失败 */
  async readRecord(id: string): Promise<{ record?: RollbackPointRecord; error?: string }> {
    const target = this.recordPath(id)
    if (target === null) return { error: 'record-incomplete: record id invalid' }
    let raw: string
    try {
      raw = await this.readText(target)
    } catch (error) {
      return { error: 'record-incomplete: record file unreadable (' + errorDetail(error) + ')' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { error: 'record-incomplete: record unreadable (' + errorDetail(error) + ')' }
    }
    if (!isRecord(parsed) || parsed['id'] !== id) return { error: 'record-incomplete: record shape invalid' }
    const workspace = normalizeTrackHeader(parsed['workspace'], 'workspace')
    const session = normalizeTrackHeader(parsed['session'], 'session')
    if (workspace === null || session === null) return { error: 'record-incomplete: record track invalid' }
    const payloadRef = isRecord(parsed['workspace']) ? parsed['workspace']['payload'] : null
    let payload: RollbackWorkspacePayload | null = null
    if (payloadRef !== null) {
      if (typeof payloadRef !== 'string' || !OBJECT_KEY_RE.test(payloadRef)) {
        return { error: 'record-incomplete: payload ref invalid' }
      }
      const resolved = await this.resolvePayload(payloadRef)
      if (resolved.payload === undefined) return { error: resolved.error ?? 'record-incomplete: payload unreadable' }
      payload = resolved.payload
    }
    const sessionPayloadRaw = isRecord(parsed['session']) ? parsed['session']['payload'] : null
    let sessionPayload: RollbackSessionPayload | null = null
    if (sessionPayloadRaw !== null) {
      sessionPayload = normalizeSessionPayload(sessionPayloadRaw)
      if (sessionPayload === null) return { error: 'record-incomplete: session payload shape invalid' }
    }
    const record: RollbackPointRecord = {
      schemaVersion: typeof parsed['schemaVersion'] === 'number' ? parsed['schemaVersion'] : 0,
      id,
      kind: parsed['kind'] === 'guard' ? 'guard' : 'auto',
      createdAt: typeof parsed['createdAt'] === 'number' ? parsed['createdAt'] : 0,
      spreadMs: typeof parsed['spreadMs'] === 'number' ? parsed['spreadMs'] : 0,
      protected: parsed['protected'] === true,
      incomplete: parsed['incomplete'] === true,
      note: asNullableString(parsed['note']),
      sessionId: asNullableString(parsed['sessionId']),
      unitId: asNullableString(parsed['unitId']),
      turnSeq: asNullableNumber(parsed['turnSeq']),
      boundarySeq: asNullableNumber(parsed['boundarySeq']),
      workspace: { ...workspace, reasonCode: asReasonCode(workspace.reasonCode), payload },
      session: { ...session, reasonCode: asReasonCode(session.reasonCode), payload: sessionPayload },
    }
    if (!this.isLedgerRecord(record)) return { error: 'record-incomplete: record shape invalid' }
    return { record }
  }

  /** 删记录文件（返回实际释放字节；ENOENT 不计），**不**动载荷与对象 */
  async deleteRecords(ids: readonly string[]): Promise<{ removed: number; bytes: number }> {
    let removed = 0
    let bytes = 0
    for (const id of ids) {
      const target = this.recordPath(id)
      if (target === null) continue
      let size = 0
      try {
        const info = await fs.stat(target)
        size = info.size
      } catch {
        continue
      }
      try {
        await fs.rm(target, { force: true })
      } catch (error) {
        this.warn('rollback ledger record delete failed: ' + id + ' ' + errorDetail(error))
        continue
      }
      removed += 1
      bytes += size
    }
    return { removed, bytes }
  }

  /* ---------------------------------------------------------- 载荷回收 */

  /** 没人引用的载荷文件一律删（引用计数靠扫清单得到，**不读载荷内容**） */
  async prunePayloads(entries: readonly RollbackLedgerManifestEntry[]): Promise<{ removed: number; bytes: number }> {
    const referenced = new Set<string>()
    for (const entry of entries) {
      // 增量载荷依赖基准 ⇒ **按链保活**（否则淘汰/删点会把基准删掉，那个点就永远读不回来了）
      const chain = entry.workspace.payloadChain
      if (Array.isArray(chain) && chain.length > 0) {
        for (const hash of chain) referenced.add(hash)
        continue
      }
      if (entry.workspace.payload !== null) referenced.add(entry.workspace.payload)
    }
    let names: string[]
    try {
      names = await fs.readdir(this.payloadsDir)
    } catch {
      return { removed: 0, bytes: 0 }
    }
    let removed = 0
    let bytes = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const hash = name.slice(0, -5)
      if (!OBJECT_KEY_RE.test(hash) || referenced.has(hash)) continue
      const target = path.join(this.payloadsDir, name)
      try {
        const info = await fs.stat(target)
        if (!info.isFile()) continue
        await fs.rm(target, { force: true })
        removed += 1
        bytes += info.size
      } catch (error) {
        this.warn('rollback ledger payload delete failed: ' + name + ' ' + errorDetail(error))
        continue
      }
    }
    return { removed, bytes }
  }

  /* ---------------------------------------------------------- 对象回收 */

  /**
   * 内容寻址对象仓回收（**重写版，内存 ∝ 单份载荷 + 对象键集合**）。
   *
   * 旧实现要先在内存里拿到「所有记录的全部 files 数组」，于是回收一次就等于把整份台账读进内存
   * （issue #89 的 OOM 现场之一）。现在：扫清单 -> **逐个读引用到的载荷文件（一次只驻留一份）**
   * -> 累计 referenced 对象键 -> 扫 objects/ 删无引用项。
   *
   * 任何一份被引用的载荷读不出来（缺失 / 哈希不符 / 形状不符）⇒ **整体放弃回收**（aborted 非空）：
   * 读不到的载荷里有什么对象谁也不知道，此时删对象可能删掉活数据 —— fail-closed。
   */
  async collectObjects(entries: readonly RollbackLedgerManifestEntry[]): Promise<{
    removed: number
    bytes: number
    referencedPaths: Set<string>
    aborted: string | null
  }> {
    const referenced = new Set<string>()
    const referencedPaths = new Set<string>()
    for (const entry of entries) {
      const hash = entry.workspace.payload
      if (hash !== null) {
        const resolved = await this.resolvePayload(hash)
        if (resolved.payload === undefined) {
          return { removed: 0, bytes: 0, referencedPaths, aborted: resolved.error ?? 'payload unreadable' }
        }
        for (const file of resolved.payload.files) {
          if (typeof file?.object === 'string') referenced.add(file.object)
          if (typeof file?.path === 'string') referencedPaths.add(file.path)
        }
        const index = resolved.payload.pathIndex ?? null
        if (index !== null && index !== undefined && typeof index.object === 'string') referenced.add(index.object)
      }
      if (entry.session.object !== null) referenced.add(entry.session.object)
    }
    let names: string[]
    try {
      names = await fs.readdir(this.objectsDir)
    } catch {
      return { removed: 0, bytes: 0, referencedPaths, aborted: null }
    }
    let removed = 0
    let bytes = 0
    for (const name of names) {
      if (!OBJECT_KEY_RE.test(name) || referenced.has(name)) continue
      const target = path.join(this.objectsDir, name)
      try {
        const info = await fs.stat(target)
        if (!info.isFile()) continue
        await fs.rm(target, { force: true })
        removed += 1
        bytes += info.size
      } catch (error) {
        this.warn('rollback gc failed: ' + name + ' ' + errorDetail(error))
      }
    }
    return { removed, bytes, referencedPaths, aborted: null }
  }

  /* ------------------------------------------------------------ 统计 */

  /** records/ + payloads/ 的**实际**磁盘占用与文件数（诚实：含尚未回收的孤儿文件） */
  async stats(): Promise<RollbackLedgerStats> {
    let records = 0
    let bytes = 0
    const dirs: Array<{ dir: string; count: boolean }> = [
      { dir: this.recordsDir, count: true },
      { dir: this.payloadsDir, count: false },
    ]
    for (const item of dirs) {
      let names: string[]
      try {
        names = await fs.readdir(item.dir)
      } catch {
        continue
      }
      for (const name of names) {
        try {
          const info = await fs.stat(path.join(item.dir, name))
          if (!info.isFile()) continue
          bytes += info.size
          if (item.count) records += 1
        } catch { /* 竞态消失的文件：跳过 */ }
      }
    }
    return { records, bytes }
  }

  /* ------------------------------------------------------------ 迁移 */

  private async sniffSchemaVersion(): Promise<{ present: boolean; schemaVersion: number | null }> {
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(this.manifestPath, 'r')
    } catch {
      return { present: false, schemaVersion: null }
    }
    try {
      const buf = Buffer.alloc(SCHEMA_SNIFF_BYTES)
      const { bytesRead } = await handle.read(buf, 0, SCHEMA_SNIFF_BYTES, 0)
      const head = buf.subarray(0, bytesRead).toString('utf8')
      const m = /"schemaVersion"\s*:\s*(\d+)/.exec(head)
      return { present: true, schemaVersion: m === null ? null : Number(m[1]) }
    } catch {
      return { present: true, schemaVersion: null }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  private async acquireMigrationLock(): Promise<string | null> {
    const lockPath = path.join(this.root, MIGRATION_LOCK_NAME)
    await fs.mkdir(this.root, { recursive: true }).catch(() => {})
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fs.open(lockPath, 'wx')
        await handle.close()
        return lockPath
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') return null
        let stale = true
        try {
          const info = await fs.stat(lockPath)
          stale = this.nowFn() - info.mtimeMs > MIGRATION_LOCK_STALE_MS
        } catch { stale = true }
        if (!stale) return null
        await fs.rm(lockPath, { force: true }).catch(() => {})
      }
    }
    return null
  }

  /**
   * v2 单文件 -> v3：**流式**切记录、逐条落盘，最后才动原文件。
   *
   * 幂等与崩溃安全：
   *  · 步骤 1（流式落 records/ + payloads/）可重复执行 —— id 稳定，重复写是覆盖，不产生重复条目；
   *  · 步骤 2 才把 v2 文件改名为 index.v2.backup.json（**成功之前原文件一动不动**）；
   *  · 若在步骤 2 与 3 之间崩溃（没有 index.json、有 index.v2.backup.json），下次启动走
   *    rebuildManifest() 从 records/ 重建清单 —— 清单自证：每条 id 必须在 records/ 找得到。
   */
  /**
   * 清单**读不出来**时从 `records/` 重建，并返回重建后重新读到的清单。
   *
   * 为什么公开：留点侧（`appendRecord`）在 `readManifest` 报错时**必须**走这里 —— 旧点的最终真相
   * 在记录文件里，而拿一个空 entries 直接覆盖清单会把旧点整批抹掉、紧接着 `prunePayloads` 还会删掉
   * 它们的载荷（永久不可恢复）。重建后仍读不出来才由调用方拒写（fail-closed）。
   */
  async recoverManifest(): Promise<{ entries: RollbackLedgerManifestEntry[]; error?: string }> {
    const ids = await this.listRecordIds().catch(() => [] as string[])
    if (ids.length === 0) {
      // `records/` 里一条记录都没有 ⇒ 台账**本来就是空的**（或目录还没建）：
      // 落一份空清单让留点继续 —— 这不是「覆盖」，因为没有东西可丢。
      // （rebuildManifest 在这种情形会刻意什么都不做，于是清单仍读不出来、留点被永久卡死。）
      try {
        await this.writeManifest([])
      } catch (error) {
        return { entries: [], error: 'ledger manifest reset failed: ' + errorDetail(error) }
      }
      return { entries: [] }
    }
    try {
      await this.rebuildManifest()
    } catch (error) {
      return { entries: [], error: 'ledger unreadable: rebuild failed (' + errorDetail(error) + ')' }
    }
    return await this.readManifest()
  }

  async migrateIfNeeded(): Promise<RollbackLedgerMigration> {
    const sniff = await this.sniffSchemaVersion()
    if (!sniff.present) return await this.rebuildManifest()
    if (sniff.schemaVersion !== 2) return { migrated: false, records: 0, skipped: 0 }
    const lock = await this.acquireMigrationLock()
    if (lock === null) {
      // 另一个实例正在迁：如实说「进行中」，绝不假装读到了空台账
      return { migrated: false, records: 0, skipped: 0, error: 'ledger unreadable: migration in progress' }
    }
    try {
      const again = await this.sniffSchemaVersion()
      if (!again.present) return await this.rebuildManifest()
      if (again.schemaVersion !== 2) return { migrated: false, records: 0, skipped: 0 }
      return await this.migrateV2()
    } finally {
      await fs.rm(lock, { force: true }).catch(() => {})
    }
  }

  private async migrateV2(): Promise<RollbackLedgerMigration> {
    let written = 0
    let skipped = 0
    try {
      const streamed = await streamLedgerRecords(this.manifestPath, async (text) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          skipped += 1
          return
        }
        if (!this.isLedgerRecord(parsed)) {
          skipped += 1
          return
        }
        await this.writePrepared(this.prepareRecord(parsed))
        written += 1
      })
      skipped += streamed.skipped
    } catch (error) {
      // 原文件仍在：下次启动重试（已写的记录文件会被同 id 覆盖，不产生重复清单条目）
      return { migrated: false, records: written, skipped, error: 'ledger migration failed: ' + errorDetail(error) }
    }
    try {
      await fs.rename(this.manifestPath, this.backupPath)
    } catch (error) {
      return { migrated: false, records: written, skipped, error: 'ledger migration rename failed: ' + errorDetail(error) }
    }
    try {
      const built = await this.readEntriesFromRecords()
      await this.writeManifest(built.entries)
    } catch (error) {
      return { migrated: false, records: written, skipped, error: 'ledger migration manifest failed: ' + errorDetail(error) }
    }
    return { migrated: true, records: written, skipped }
  }

  /** 从 records/ 重建清单（崩溃恢复；清单自证：找不到记录文件的 id 一律跳过并计数） */
  private async rebuildManifest(): Promise<RollbackLedgerMigration> {
    const ids = await this.listRecordIds()
    if (ids.length === 0) return { migrated: false, records: 0, skipped: 0 }
    const built = await this.readEntriesFromRecords()
    try {
      await this.writeManifest(built.entries)
    } catch (error) {
      return { migrated: false, records: built.entries.length, skipped: built.skipped, error: 'ledger manifest rebuild failed: ' + errorDetail(error) }
    }
    return { migrated: true, records: built.entries.length, skipped: built.skipped }
  }

  private async listRecordIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.recordsDir)
    } catch {
      return []
    }
    const out: string[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      if (LEDGER_RECORD_ID_RE.test(id)) out.push(id)
    }
    return out.sort()
  }

  private async readEntriesFromRecords(): Promise<{ entries: RollbackLedgerManifestEntry[]; skipped: number }> {
    const entries: RollbackLedgerManifestEntry[] = []
    let skipped = 0
    for (const id of await this.listRecordIds()) {
      const resolved = await this.readRecord(id)
      if (resolved.record === undefined) { skipped += 1; continue }
      entries.push(this.prepareRecord(resolved.record).entry)
    }
    entries.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
    return { entries, skipped }
  }
}

/* --------------------------------------------------------------- 工具 */

function trackHeader(track: {
  kind: RollbackStateKind
  capturedAt: number
  ok: boolean
  degraded: boolean
  fingerprint: string | null
  reasonCode: RollbackCode | null
  reasonDetail: string | null
}): RollbackLedgerTrackHeader {
  return {
    kind: track.kind,
    capturedAt: track.capturedAt,
    ok: track.ok,
    degraded: track.degraded,
    fingerprint: track.fingerprint,
    reasonCode: track.reasonCode,
    reasonDetail: track.reasonDetail,
  }
}

/**
 * 补回**落盘时省掉的** `object` 字段：内容寻址的名字就是内容哈希 ⇒ `object ≡ sha256`。
 * 缺 `sha256` 的畸形条目保持原样（消费侧的防御判据照旧生效）。
 */
function withObjectRefs(payload: RollbackWorkspacePayload): RollbackWorkspacePayload {
  for (const file of payload.files) {
    if (file === null || typeof file !== 'object') continue
    if (typeof file.object === 'string') continue
    if (typeof file.sha256 === 'string') file.object = file.sha256
  }
  return payload
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code + ': ' + error.message : error.message
  }
  return String(error)
}
