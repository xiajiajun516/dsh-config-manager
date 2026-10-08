/**
 * 离线救急台的**结构化动作层**（阶段 0 只读 + 阶段 2/3 写动作）。
 *
 * 为什么要有这一层：CLI 与救急台网页必须给出**同一个结论**。CLI 现在是「算完就打印」，
 * 而网页要的是数据；若让网页自己重算一遍，同一个备份迟早出现「命令行说 OK、网页说坏」。
 * 所以凡是两边都要用的判定都收敛到这里：函数返回结构，CLI 负责排版、网页负责渲染。
 *
 * 纪律（与 CLI 同源）：
 *  - 零 @deepseek-ai 依赖（peerDependencies 缺失也能跑）；
 *  - 只读函数（verify/磁盘体检/会话体检/档案列表/心跳与锁读取）不写任何字节；
 *    写函数一律在**调用方过完门之后**才执行（门本身也在这里：checkWriteGates），并且复用 CLI 的同一实现；
 *  - 读不到一律如实上报（error / unreadable），绝不把「读不到」显示成 0 或「没问题」。
 */
import fssync from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { verifyBackupZip, type BackupVerifyResult } from '../core/backup-verify.ts'
import {
  EXPORTS_RETENTION_DEFAULT_MS, MARKET_RETENTION_DEFAULT_MS, TMP_RETENTION_DEFAULT_MS,
} from '../core/cache-cleaner.ts'
import { scanDiskUsage, type DiskUsageDirs, type DiskUsageReport } from '../core/disk-usage.ts'
import { readSafeModeMarkerSync, safeModeMarkerPath } from '../core/phase3-host.ts'
import { listSnapshots, type SnapshotMeta } from '../core/restore.ts'
import { readInstalledVersion, resolveProfileDir } from '../core/plugin-cli.ts'
import { DshProfileError, DshProfileManager } from '../profiles/dsh-profile-manager.ts'
import { DshProfileLauncher, LAUNCHES_FILENAME, parseLaunches } from '../profiles/dsh-profile-launcher.ts'
import { DshProfileRuntimeRegistry, parseRuntimeRecord, RUNTIME_STALE_MS } from '../profiles/dsh-profile-runtime.ts'
import { isManagedProfileName, type DshProfileMeta } from '../profiles/dsh-profile-shared.ts'
import { readTextSafe } from '../profiles/dsh-profile-io.ts'
import {
  AUTO_BACKUP_PREFIX, DEFAULT_BACKUP_RETENTION, listBackupFiles, type BackupFileMeta,
} from '../sync/backup-files.ts'
import { EnvironmentLockManager, OWNERSHIP_FILE } from '../utils/env-lock.ts'
import { scanSessionHealth, type SessionHealthScanResult } from '../utils/session-health-scan.ts'
import type { SessionVerifyResult } from '../utils/session-verify.ts'

/* ------------------------------------------------------------ 进程/实例事实 */

/** 进程是否存活（不发送信号，只探测）。EPERM = 存在但无权限发信号 → 仍算存活。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 一个在跑的 DSH 实例（来自 `<root>/running/<profile>.json` 心跳）。 */
export interface RunningInstance {
  name: string
  pid: number
  port: number | null
  startedAt: string
  updatedAt: number
}

/**
 * 读「本机正在跑的 DSH 实例」。
 *
 * **为什么按候选根扫描**：心跳在 `<插件 dataDir>/running/`，而 CLI 的 `--data-dir` 语义是
 * 「快照目录」（缺省 `$DSH_HOME/dsh-config-manager/snapshots`）。旧实现把快照目录当 dataDir 用，
 * 于是缺省路径下**永远找不到心跳** —— 那道「DSH 在跑就别写会话字节」的门形同虚设（fail-open）。
 * 这里改为复用 `resolveControlRoots` 的候选根：显式 `--data-root` 只认它，否则同时看
 * `--data-dir` 本身与它的父目录，再叠加缺省根；多查几处只会更保守。
 */
export async function readRunningInstances(controlRoots: readonly string[]): Promise<RunningInstance[]> {
  const alive: RunningInstance[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (const root of controlRoots) {
    const dir = path.join(root, 'running')
    let names: string[]
    try {
      names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'))
    } catch {
      continue // 该候选根没有心跳目录：正常情况，不阻断
    }
    for (const name of names) {
      try {
        const record = parseRuntimeRecord(await fsp.readFile(path.join(dir, name), 'utf8'))
        if (record === null) continue
        if (!isProcessAlive(record.pid) || now - record.updatedAt > RUNTIME_STALE_MS) continue
        const key = record.name + '#' + String(record.pid)
        if (seen.has(key)) continue
        seen.add(key)
        alive.push({
          name: record.name,
          pid: record.pid,
          port: record.port,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
        })
      } catch {
        // 单条心跳读不出来不阻断（best-effort）
      }
    }
  }
  return alive
}

/* ------------------------------------------------------------ 备份自检（verify） */

export type VerifyOutcome =
  | { ok: true; results: BackupVerifyResult[] }
  | { ok: false; error: string }

/**
 * 定位待校验目标：显式目标（文件名或路径）优先，否则列出导出目录下全部 *.zip（名称升序）。
 * 与 `dsh-config-manager verify` 同一实现（CLI 与网页共用）。
 */
export async function resolveVerifyTargets(
  exportsDir: string,
  explicit: string | undefined,
): Promise<{ ok: true; targets: string[] } | { ok: false; error: string }> {
  if (explicit !== undefined && explicit !== '') {
    // 文件名：在导出目录内解析；路径：按原样使用（相对当前工作目录）
    const looksLikePath = explicit.includes('/') || explicit.includes('\\') || path.isAbsolute(explicit)
    const target = looksLikePath ? path.resolve(explicit) : path.join(exportsDir, explicit)
    return { ok: true, targets: [target] }
  }
  let names: string[]
  try {
    names = (await fsp.readdir(exportsDir)).filter((n) => n.endsWith('.zip')).sort()
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return { ok: false, error: '导出目录不存在 / export directory not found: ' + exportsDir }
    }
    return { ok: false, error: '读取导出目录失败 / failed to read export directory: ' + (err instanceof Error ? err.message : String(err)) }
  }
  if (names.length === 0) {
    return { ok: false, error: '导出目录内没有备份 ZIP / no backup ZIP in: ' + exportsDir }
  }
  return { ok: true, targets: names.map((n) => path.join(exportsDir, n)) }
}

/** 收集备份自检结果（只读；不通过不是异常，而是结果里的 verdict）。 */
export async function collectVerifyResults(exportsDir: string, explicit?: string): Promise<VerifyOutcome> {
  const resolved = await resolveVerifyTargets(exportsDir, explicit)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const results: BackupVerifyResult[] = []
  for (const target of resolved.targets) results.push(await verifyBackupZip(target))
  return { ok: true, results }
}

/* ------------------------------------------------------------ 快照 / 备份产物 */

/**
 * 快照列表（与 `dsh-config-manager snapshots` 同源）。
 *
 * `unreadable` = 目录**读不出来**（不是不存在）—— 调用方必须如实展示，绝不显示成「没有快照」。
 */
export async function readSnapshots(
  snapshotsDir: string,
  out?: { unreadable?: string },
): Promise<SnapshotMeta[]> {
  return await listSnapshots(snapshotsDir, out)
}

/**
 * 导出产物列表；**打开容器形态探测**（加密容器 DCA1 必须在列表里被标出来）。
 * `unreadable` = 目录读不出来（非 ENOENT），调用方必须如实展示。
 */
export async function readBackups(
  exportsDir: string,
  out?: { unreadable?: string },
): Promise<BackupFileMeta[]> {
  const options: { withContainerKind: boolean; unreadable?: string } = { withContainerKind: true }
  // 把调用方给的对象**直接挂上**：listBackupFiles 会把读不出来的原因写进 options.unreadable，
  // 若在别处复制一份，原因就回不到调用方（验收 F2 的第一版就是这么漏的）。
  const result = await listBackupFiles(exportsDir, Object.assign(options, out ?? {}))
  if (options.unreadable !== undefined && out !== undefined) out.unreadable = options.unreadable
  return result
}

/* ------------------------------------------------------------ 磁盘占用 */

/**
 * 插件数据根的固定布局 → 磁盘体检子区目录。
 *
 * 与宿主 `src/routes/backup.ts` 的 `diskUsageDirsOf` 同一映射（子区目录不在这里另立一套语义）。
 * `exportsDir` 允许覆盖：`--data-dir` 可被当成导出目录使用（verify/backup 的历史语义）。
 */
export function diskUsageDirsOf(dataDir: string, exportsDir?: string): DiskUsageDirs {
  const under = (name: string): string => path.join(dataDir, name)
  return {
    dataDir,
    exportsDir: exportsDir !== undefined && exportsDir !== '' ? exportsDir : under('exports'),
    snapshotsDir: under('snapshots'),
    syncDir: under('sync'),
    marketCacheDir: path.join(dataDir, 'market', 'cache'),
    marketWorkDir: path.join(dataDir, 'market', 'work'),
    tmpDir: under('tmp'),
    logsDir: under('logs'),
    bootStateDir: under('boot-state'),
    migrationHistoryDir: under('migration-history'),
    transactionsDir: under('transactions'),
    locksDir: under('locks'),
    vaultDir: under('vault'),
  }
}

/** 只读磁盘体检（零写入）。 */
export async function readDiskUsage(dataDir: string, exportsDir?: string): Promise<DiskUsageReport> {
  return await scanDiskUsage({
    dirs: diskUsageDirsOf(dataDir, exportsDir),
    policy: {
      tmpRetentionMs: TMP_RETENTION_DEFAULT_MS,
      exportsRetentionMs: EXPORTS_RETENTION_DEFAULT_MS,
      marketRetentionMs: MARKET_RETENTION_DEFAULT_MS,
      // 定时备份产物不按天回收（保留策略归 BackupScheduler）——「已超期」统计必须排除它们
      exportsExemptPrefix: AUTO_BACKUP_PREFIX,
    },
    backupKeepLast: DEFAULT_BACKUP_RETENTION,
  })
}

/* ------------------------------------------------------------ 会话体检 */

export type SessionsHealthOutcome =
  | { ok: true; result: SessionHealthScanResult }
  | { ok: false; error: string }

/** 只读会话体检（结构档 + 限额内的行档）。scanSessionHealth 本身不写任何字节。 */
export async function readSessionsHealth(homeDir: string): Promise<SessionsHealthOutcome> {
  try {
    return { ok: true, result: await scanSessionHealth({ homeDir }) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------ SAFE MODE / 环境锁 */

export interface SafeModeReport {
  /** 候选控制面根 */
  root: string
  /** 标记文件绝对路径（写进界面，便于人工核对） */
  marker: string
  /** clear = 明确没有标记；blocked = 有未结案的 transaction；unknown = 读不出来（按阻断处理） */
  state: ReturnType<typeof readSafeModeMarkerSync>
  /**
   * 该候选根下是否已经存在有效的「控制面目录」（dataDir 或 transactions）。
   *
   * 为什么需要：候选根里绝大多数**本来就不存在**（`--data-dir` 的父目录、缺省根都可能没有），
   * 那些根的 'clear' 只是「这里什么都没建」，把它当成「SAFE MODE 未激活」的正面证据是把
   * 「没查」说成「没问题」。界面只在**有效根**上给绿灯，其余如实说「未建立 / 未发现标记」。
   */
  established: boolean
}

/** 逐个候选根读 SAFE MODE 标记（fail-closed 的判定仍在 CLI/core；这里只报事实）。 */
export function readSafeMode(controlRoots: readonly string[]): SafeModeReport[] {
  return controlRoots.map((root) => ({
    root,
    marker: safeModeMarkerPath(root),
    state: readSafeModeMarkerSync(root),
    established: fssync.existsSync(root) || fssync.existsSync(path.join(root, 'transactions')),
  }))
}

export interface LockReport {
  locksDir: string
  /** 锁文件是否存在（不存在 = 没有活动锁） */
  present: boolean
  /** 没有锁时恒为 'NONE'；否则为 inspectLockState 的结论 */
  state: string
  detail?: string
}

/**
 * 读环境锁状态（只读）。
 *
 * 复用宿主/CLI 同一套 `inspectLockState`：**绝不**因为「看起来是残留」就自动回收 ——
 * 回收只有显式命令一条路（`recover-stale-lock`）。
 */
export async function readLockState(locksDir: string): Promise<LockReport> {
  const present = await pathExists(path.join(locksDir, OWNERSHIP_FILE))
  if (!present) return { locksDir, present: false, state: 'NONE' }
  const lock = new EnvironmentLockManager({ locksDir, op: 'rescue-console-inspect', target: locksDir, lockVersion: '0.1.0' })
  const inspection = await lock.inspectLockState()
  return inspection.detail === undefined
    ? { locksDir, present: true, state: inspection.state }
    : { locksDir, present: true, state: inspection.state, detail: inspection.detail }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 首页聚合 */

/** 救急台首页所需的路径事实（由 CLI 侧解析后注入，保证与各子命令同一口径）。 */
export interface RescuePaths {
  homeDir: string
  /** 插件数据根（`$DSH_HOME/dsh-config-manager` 或缺省 dataRoot） */
  dataDir: string
  snapshotsDir: string
  exportsDir: string
  locksDir: string
  controlRoots: readonly string[]
  profile: string
  /**
   * 离线导出的 manifest.exporter.version（CLI 传真实版本；缺省 = 中性占位）。
   * 为什么不在这里再算一次版本：actions.ts 不得 import ./index.ts（会成环），
   * 而版本号只有 CLI 侧从 package.json 读得到 —— 由 runWeb 经本结构注入。
   */
  exporterVersion?: string
}

export interface RescueStatus {
  generatedAt: string
  paths: RescuePaths
  safeMode: SafeModeReport[]
  lock: LockReport
  instances: RunningInstance[]
  snapshots: SnapshotMeta[]
  backups: BackupFileMeta[]
  /** 任一项读失败的原因（首页必须显示，绝不静默当作空） */
  errors: string[]
}

/** 首页聚合：每一项各自 try/catch，缺一项不影响其余（但失败必须在 errors 里可见）。 */
export async function readRescueStatus(paths: RescuePaths, now: () => Date = () => new Date()): Promise<RescueStatus> {
  const errors: string[] = []
  let snapshots: SnapshotMeta[] = []
  try {
    const probe: { unreadable?: string } = {}
    snapshots = await readSnapshots(paths.snapshotsDir, probe)
    // 目录存在但读不出来 ≠ 没有快照（验收 F2）：必须进横幅，不能显示成空列表
    if (probe.unreadable !== undefined) errors.push(probe.unreadable)
  } catch (error) {
    errors.push('快照列表读取失败：' + errorText(error))
  }
  let backups: BackupFileMeta[] = []
  try {
    const probe: { unreadable?: string } = {}
    backups = await readBackups(paths.exportsDir, probe)
    if (probe.unreadable !== undefined) errors.push(probe.unreadable)
  } catch (error) {
    errors.push('导出产物列表读取失败：' + errorText(error))
  }
  let instances: RunningInstance[] = []
  try {
    instances = await readRunningInstances(paths.controlRoots)
  } catch (error) {
    errors.push('实例心跳读取失败：' + errorText(error))
  }
  let lock: LockReport = { locksDir: paths.locksDir, present: false, state: 'NONE' }
  try {
    lock = await readLockState(paths.locksDir)
  } catch (error) {
    errors.push('环境锁读取失败：' + errorText(error))
  }
  return {
    generatedAt: now().toISOString(),
    paths,
    safeMode: readSafeMode(paths.controlRoots),
    lock,
    instances,
    snapshots,
    backups,
    errors,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------ 写动作（阶段 2）

写动作的三道门（**全部在服务端**，前端确认不算数）：
  ① SAFE MODE：任一有效控制面根下存在未结案的 transaction → 一律拒绝（有事务在途时改磁盘 = 自己制造第二现场）；
  ② 环境锁：能证明「上次异常退出的残留锁」时先让用户回收，否则拒绝（绝不自动回收、也绝不带着残留锁写入）；
  ③ DSH 在跑：改写会话字节前必须确认没有存活实例（DSH 的会话位置/内存注册表都在运行期建立）。

三条纪律：
  - 每个写动作都**调用 CLI 用的同一批实现**（`runSessionsRepair` / `cleanupCaches` / `recoverStaleLock`），
    网页不许自己重写判定；
  - 写之前先跑一次**只读计划**（dry-run / 占用体检），把「会发生什么」回执给用户；
  - 回执如实：完成、失败、跳过分别列出，绝不把「没做」说成「做了」。
*/

export type WriteRefusalCode =
  | 'safe-mode'
  | 'stale-lock'
  | 'dsh-running'
  | 'nothing-to-do'
  | 'io-error'

export interface WriteGateRefusal {
  ok: false
  code: WriteRefusalCode
  /** 用户可读原因（页面直接展示） */
  reason: string
  /**
   * 拒因的结构化明细（页面据此给出「怎么解除」的可操作指引，而不是只丢一句 reason）。
   *
   * 为什么要有：`dsh-running` 是最常被撞到的一道门，光给「请先关闭 DSH」用户会问
   * 「关哪个、怎么确认关掉了」。这里把**是谁在跑**（心跳台账里的 profile/pid/端口）
   * 如实带出来 —— 只读事实，不猜、不代关进程。
   */
  detail?: {
    kind: 'dsh-running' | 'stale-lock' | 'safe-mode'
    /** 正在运行的实例（心跳合并视图：本插件启动的 + 手动启动的） */
    instances?: Array<{ name: string; pid: number; port: number | null }>
    /** 环境锁状态（kind = 'stale-lock'） */
    lock?: { state: string; locksDir: string }
    /** SAFE MODE 标记文件（kind = 'safe-mode'） */
    markers?: string[]
    /** 与 CLI 逐字同源的等价命令（可复制去终端跑） */
    commands: string[]
  }
}

export type WriteGateOutcome = { ok: true } | WriteGateRefusal

/**
 * 写动作的前置门（与 CLI `sessions repair --fix` 同一判据）。
 *
 * `needsDshStopped`：**改写/搬动会话字节**的动作（会话布局归位 repairSessions、字节级就地修复
 * repairSessionLogInline）与**快照恢复**（runSnapshotRestore 会覆盖/删除 `$DSH_HOME` 下正在使用的文件）
 * 都要「DSH 已停」这一条；磁盘清理不需要（只碰可重建缓存）。
 */
export async function checkWriteGates(
  controlRoots: readonly string[],
  options: { needsDshStopped: boolean; locksDir?: string } = { needsDshStopped: true },
): Promise<WriteGateOutcome> {
  for (const report of readSafeMode(controlRoots)) {
    if (report.state === 'blocked') {
      return {
        ok: false,
        code: 'safe-mode',
        reason: 'SAFE MODE 已激活（存在未结案的配置 transaction）：先处理恢复事项再改磁盘。标记：' + report.marker,
      }
    }
    if (report.state === 'unknown') {
      return {
        ok: false,
        code: 'safe-mode',
        reason: 'SAFE MODE 标记无法判定（按最保守口径处理）：先人工核对标记文件。路径：' + report.marker,
      }
    }
  }
  /**
   * ② 环境锁：**存在锁就必须先处理**。
   *
   * 为什么不能跳过：CLI 侧 destructive 入口（restore/reinstall）都要求成功获取 GLOBAL 环境锁，
   * 而残留锁（STALE_LOCK_DETECTED）正是「上次异常退出、别的操作也被挡着」的状态；
   * 这时改磁盘等于在一个已知不一致的状态上继续写。判据与 `recover-stale-lock` 同源（inspectLockState），
   * 所以**不给自动回收**，只如实拒绝并把出口指出来。
   */
  if (options.locksDir !== undefined) {
    const lock = await readLockState(options.locksDir)
    if (lock.present) {
      const stale = lock.state === 'STALE_LOCK_DETECTED'
      return {
        ok: false,
        code: 'stale-lock',
        reason: (stale
          ? '检测到残留的环境锁（持有进程已被确证不存在）：先回收它再执行写动作。'
          : '环境锁被持有或状态无法判定（' + lock.state + '）：先确认没有其它操作在跑，再执行写动作。')
          + '锁目录：' + lock.locksDir + '；出口：dsh-config-manager recover-stale-lock（本机救急台的「环境锁」页也可回收）。',
      }
    }
  }
  if (options.needsDshStopped) {
    const running = await readRunningInstances(controlRoots)
    if (running.length > 0) {
      return {
        ok: false,
        code: 'dsh-running',
        reason: '检测到 DSH 正在运行（' + running.map((i) => i.name + ' pid=' + String(i.pid)).join('、')
          + '）：请先关闭 DSH 再改写会话字节。',
        detail: {
          kind: 'dsh-running',
          instances: running.map((i) => ({ name: i.name, pid: i.pid, port: i.port })),
          commands: [
            // 桌面端独占档案不让普通 CLI 停，如实给出「关窗口」这条唯一通道（见 AGENTS.md 的 desktop 条）
            ...running.filter((i) => i.name === 'desktop').map(() => '桌面端（desktop）：直接关闭 DSH 桌面窗口；它不接受命令行停止'),
            ...running.filter((i) => i.name !== 'desktop').map((i) => 'dsh-config-manager stop ' + i.name + '  # 或在「档案与实例」页点「停止 ' + i.name + '」'),
            'dsh-config-manager web  # 停完再回本页点「重新检查」',
          ],
        },
      }
    }
  }
  return { ok: true }
}

/** 会话修复步骤的机器可读形态（页面渲染用；CLI 走它自己的文本输出）。 */
export interface RepairStep {
  kind: 'move' | 'rewrite-move' | 'quarantine' | 'skip'
  sessionId: string
  fromProjectKey: string
  toProjectKey?: string
  prefixRewrite?: { from: string; to: string }
  reason: string
  /** 是否真的会执行（duplicate-id 且没点名 --keep 时为 false） */
  applies: boolean
}

export interface RepairOutcome {
  ok: boolean
  dryRun: boolean
  /** 需要人工处理（位置错位 / 重复 id / 前缀需映射等） */
  needsAttention: boolean
  home: string
  steps: RepairStep[]
  /** 计划摘要：scanned / ok / move / rewriteMove / skip / duplicates */
  scanned: number
  movable: number
  skipped: number
  duplicates: number
  /** 真实执行时的逐条结果（dry-run 时为空） */
  done: string[]
  errors: string[]
  /** 计划阶段就读不出来的文本（如非 projectKey 目录）——绝不静默，原样带回 */
  notices: string[]
  error?: string
}

/** 就地修复（重放族）单条结果：给页面直接渲染用。 */
export interface SessionLogRepairRow {
  unitId: string
  ok: boolean
  /** 机器可读原因（ok=false 时） */
  reason?: string
  /** 丢弃的重放重复行数（ok=true 时） */
  droppedRows?: number
  bytesBefore?: number
  bytesAfter?: number
  /** 预览给出的指纹（apply 时必须原样回传） */
  expect?: { size: number; mtimeMs: number }
  /** 备份文件名（与日志同目录，回滚只认台账，不认用户给的路径） */
  backupName?: string
  repairId?: string
  /**
   * 写后真 codec 复验结论（**逐字段透传** service 的 SessionVerifyResult，不改造/不丢字段）。
   * JSON 消费者必须据它区分三态：verified+equivalentToReadPath（现役读盘可读）/
   * verified+!equivalentToReadPath（只有迁移链能还原）/ !verified（未验证，原因见 reason）。
   * 预览路径不跑复验门 ⇒ 这一项缺省。
   */
  verify?: SessionVerifyResult
  /** 确定性失败（reason='verify-failed'）时：本次备份的自动回滚是否成功（false = 目标仍是修复后字节） */
  rolledBack?: boolean
  message: string
}

export interface InlineRepairOutcome {
  ok: boolean
  dryRun: boolean
  rows: SessionLogRepairRow[]
  /**
   * 离线出口命令（可复制去终端）。
   *
   * **不是本入口的等价实现** —— 见 `repairSessionLogInline` 的能力边界：`sessions repair` 只做
   * 布局归位与重复 id 隔离，不改写会话字节；字节级离线通道只有救急台 `dcm web`。
   */
  commands: string[]
  error?: string
}

/* ----------------------------------------------- 会话修复行的文案（纯函数，可单测） */

/**
 * 真 codec 复验结论 → 一句人话（**三态**；服务层 utils/session-verify.ts 的定义为准）。
 *
 *  · verified && equivalentToReadPath   → 「现役读盘可读」= header.version === catalog.currentVersion === 已装版本，
 *                                          DSH 的现役读盘路径此刻就能直接读它；
 *  · verified && !equivalentToReadPath  → 只有**迁移链**能还原（pre-v4 日志：官方 resolveCurrentLog 对本代之前的
 *                                          代际返回 undefined，即「没有现役日志」）；
 *  · !verified                          → 「**未验证**」= 本机跑不了真 codec 门（如 available catalog 缺席 / 代际对不上 /
 *                                          缺子会话事实）——**这是最常见的一态，必须说出来**，绝不能让它看起来像成功；
 *  · verify 缺失（改造前的旧结果 / 预览路径）→ 空串：调用方保持原文案，绝不臆造「已验证」。
 */
export function sessionVerifyNoteOf(verify: SessionVerifyResult | undefined): string {
  if (verify === undefined) return ''
  if (verify.verified) {
    return verify.equivalentToReadPath
      ? '真 codec 复验通过（现役读盘可读）。'
      : '真 codec 复验通过（迁移链可还原，非现役读盘）。'
  }
  return '未验证：本机无法运行真 codec 复验（' + verify.reason + '）。'
}

/** 会话修复行的文案入参（只吃机器可读事实 —— 便于单测与两边共用）。 */
export interface SessionRepairRowFacts {
  ok: boolean
  reason?: string
  droppedRows?: number
  backupName?: string
  rolledBack?: boolean
  verify?: SessionVerifyResult
}

/**
 * 会话修复行 → message（CLI 与离线救急台**同一份**文案）。
 *
 * 成功路径按 verify 分三态；**!verified 时不出现无限定的成功表述**（先声明未验证，再如实说写入已生效）；
 * verify 缺失时**逐字保持改造前的文案**（向后兼容，不臆造）；verify-failed 时说明已自动回滚 + 官方错误 detail。
 */
export function sessionRepairRowMessage(facts: SessionRepairRowFacts): string {
  const dropped = String(facts.droppedRows ?? 0)
  const backup = String(facts.backupName ?? '（未落盘）')
  if (!facts.ok) {
    if (facts.reason === 'verify-failed') {
      const rolled = facts.rolledBack === true
        ? '已自动回滚到修复前字节'
        : facts.rolledBack === false
          ? '已自动回滚未成功（目标仍是修复后字节，需人工处理）'
          : '已自动回滚（服务层未回传结果，请以目标字节为准）'
      const detail = facts.verify !== undefined && !facts.verify.verified && facts.verify.detail !== undefined && facts.verify.detail !== ''
        ? '；官方错误：' + facts.verify.detail
        : ''
      return '未修复（verify-failed）：真 codec 复验未通过，' + rolled + detail + '。'
    }
    return '未修复（' + (facts.reason ?? 'unknown') + '）：原文件未改动。'
  }
  if (facts.verify === undefined) {
    // 向后兼容：没有复验结论就不添油加醋（改造前逐字如此）
    return '已丢弃 ' + dropped + ' 行重放重复事件；备份 ' + backup
  }
  if (facts.verify.verified) {
    return '已丢弃 ' + dropped + ' 行重放重复事件；备份 ' + backup + '。' + sessionVerifyNoteOf(facts.verify)
  }
  return sessionVerifyNoteOf(facts.verify)
    + '写入已生效（已丢弃 ' + dropped + ' 行重放重复事件；备份 ' + backup + '）——本机 DSH 能否现役读它**没有被证明**，可用 repairId 回滚。'
}

/**
 * **就地修复「重放重复行」**（离线救急台 /sessions 页的写入口）。
 *
 * 能力边界（**不得放宽**）：
 *  - 只做 `session-repair-service` 已有的那一类 —— 字节相同 + seq 相同的重放重复行（零损失）；
 *    其余类别（合成 closer / seq 空洞 / 不可解析行 / 容器非法 / header 不可读 / 子代理缺父）
 *    **只报告**，绝不在这里扩张（设计稿 §10.3/§10.4 的 G-23 界限）。
 *  - **离线出口只有一个**：救急台 `dsh-config-manager web`（别名 `dcm web`）—— 它调用的就是本函数。
 *    CLI 的 `sessions repair`（加 `--fix`/`--apply` 才落盘）**不是**字节级修复的等价命令：
 *    它只做**布局归位**（按首帧 cwd 把目录搬回 `projectKeyOf(cwd)`）与**重复 id 隔离**，不碰会话字节。
 *    此前把 `sessions repair --apply` 写成「等价命令」是不实表述（已订正，见下面的 `commands`）。
 *  - 三道写入门由服务层自持：单元必须解析到会话根内 / 无 `session.lock` / 文件不在 30s 静止期内；
 *    「DSH 已停」这一条由 `checkWriteGates` 在这里补上（与 CLI 写动作共用同一道写入门，
 *    比应用内 T8 通道更严：T8 跑在 DSH 内部，靠静止期而非停机）。
 *  - 与 CLI 同源：预览-应用指纹一致（TOCTOU）/ 时间戳备份 / 原子换入 / 写后复验，全在服务层。
 *
 * 为什么页面需要一个「一键」入口：救急台的定位是「DSH 起不来时唯一的可视化通道」，
 * 而 `session-repair-service` 的 CLI 出入口此前只挂在应用内通道上 —— 离线时用户只能敲命令。
 */
export async function repairSessionLogInline(
  options: { home: string; dataDir: string; unitIds: readonly string[]; apply: boolean; expects?: Record<string, { size: number; mtimeMs: number }> },
  controlRoots: readonly string[],
): Promise<InlineRepairOutcome> {
  const base: InlineRepairOutcome = {
    ok: true, dryRun: !options.apply, rows: [],
    // 不得再把 `sessions repair --apply` 说成等价命令：它只做布局归位与重复 id 隔离，不改写会话字节。
    commands: [
      'dsh-config-manager web  # 离线救急台：字节级就地修复的唯一离线通道（别名 dcm web）',
      'dsh-config-manager sessions repair  # 只做布局归位与重复 id 隔离，不改写会话字节（--fix/--apply 才落盘）',
    ],
  }
  if (options.unitIds.length === 0) return { ...base, ok: false, error: '没有选中任何会话单元。' }
  if (options.apply) {
    // 与 CLI 写动作共用同一道写入门：改写会话字节必须先停 DSH（+ SAFE MODE + 环境锁）
    const gate = await checkWriteGates(controlRoots, { needsDshStopped: true })
    if (!gate.ok) return { ...base, ok: false, error: gate.reason }
  }
  const svc = await import('../utils/session-repair-service.ts')
  const rows: SessionLogRepairRow[] = []
  for (const unitId of options.unitIds.slice(0, 50)) {
    if (!options.apply) {
      const preview = await svc.previewSessionRepair({ homeDir: options.home, unitId })
      rows.push({
        unitId,
        ok: preview.ok,
        ...(preview.reason !== undefined ? { reason: preview.reason } : {}),
        ...(preview.droppedRows !== undefined ? { droppedRows: preview.droppedRows } : {}),
        ...(preview.bytesBefore !== undefined ? { bytesBefore: preview.bytesBefore } : {}),
        ...(preview.bytesAfter !== undefined ? { bytesAfter: preview.bytesAfter } : {}),
        ...(preview.expect !== undefined ? { expect: preview.expect } : {}),
        message: preview.ok
          ? '可零损失修复：将丢弃 ' + String(preview.droppedRows ?? 0) + ' 行重放重复事件。'
          : '不可修复（' + (preview.reason ?? 'unknown') + '）：这一类只报告，本入口绝不改写它的字节；'
            + '字节级离线出口是救急台 dsh-config-manager web（sessions repair 只做布局归位与重复 id 隔离）。',
      })
      continue
    }
    const expect = options.expects?.[unitId]
    const applied = await svc.applySessionRepair({
      homeDir: options.home, dataDir: options.dataDir, unitId,
      ...(expect !== undefined ? { expect } : {}),
    })
    // 文案与结构化字段同源：verify 逐字段透传（JSON 消费者据它区分三态），message 由纯函数分派
    const facts = {
      ok: applied.ok,
      ...(applied.reason !== undefined ? { reason: applied.reason } : {}),
      ...(applied.droppedRows !== undefined ? { droppedRows: applied.droppedRows } : {}),
      ...(applied.backupName !== undefined ? { backupName: applied.backupName } : {}),
      ...(applied.rolledBack !== undefined ? { rolledBack: applied.rolledBack } : {}),
      ...(applied.verify !== undefined ? { verify: applied.verify } : {}),
    };
    rows.push({
      unitId,
      ...facts,
      ...(applied.bytesBefore !== undefined ? { bytesBefore: applied.bytesBefore } : {}),
      ...(applied.bytesAfter !== undefined ? { bytesAfter: applied.bytesAfter } : {}),
      ...(applied.repairId !== undefined ? { repairId: applied.repairId } : {}),
      message: sessionRepairRowMessage(facts),
    })
  }
  return { ...base, ok: rows.every((r) => r.ok || !options.apply), rows }
}

/**
 * 会话布局修复：`dryRun: true` 时**零写入**（与 `sessions repair` 缺省行为一致）。
 *
 * 实现方式：复用 `runSessionsRepair`（CLI 的同一实现）并收集它的输出行 —— 这样「网页看到的计划」
 * 与「命令行看到的计划」逐字同源；解析失败的极端情况如实进 notices，不假装成功。
 */
export async function repairSessions(
  options: { home: string; fix: boolean; maps?: readonly string[]; keep?: string; locksDir?: string },
  controlRoots: readonly string[],
): Promise<RepairOutcome> {
  const base: RepairOutcome = {
    ok: true, dryRun: !options.fix, needsAttention: false, home: options.home,
    steps: [], scanned: 0, movable: 0, skipped: 0, duplicates: 0,
    done: [], errors: [], notices: [],
  }
  if (options.fix) {
    const gate = await checkWriteGates(controlRoots, {
      needsDshStopped: true,
      ...(options.locksDir !== undefined ? { locksDir: options.locksDir } : {}),
    })
    if (!gate.ok) {
      return { ...base, ok: false, error: gate.reason, errors: [gate.reason] }
    }
  }
  const { runSessionsRepair } = await import('./sessions-repair.ts')
  const out: string[] = []
  const err: string[] = []
  const io = { log: (line: string) => out.push(line), error: (line: string) => err.push(line) }
  const code = await runSessionsRepair(
    {
      home: options.home,
      fix: options.fix,
      maps: options.maps ?? [],
      json: false,
      ...(options.keep !== undefined ? { keep: options.keep } : {}),
    },
    io,
  )
  const text = out.join('\n')
  const summary = /扫描 (\d+) 条会话：位置正确 (\d+)，待搬家 (\d+)，待改写\+搬家 (\d+)，跳过 (\d+)，重复 id (\d+)/.exec(text)
  if (summary !== null) {
    base.scanned = Number(summary[1])
    base.movable = Number(summary[2]) === 0 ? Number(summary[3]) + Number(summary[4]) : Number(summary[3]) + Number(summary[4])
    base.skipped = Number(summary[5])
    base.duplicates = Number(summary[6])
  }
  for (const line of out) {
    // 解析 CLI 的逐条计划行。**括号形态两种都认**（验收 F5：CLI 打印用的是全角括号，
    // 只写半角会让 rewrite-move 行静默丢失；同时容忍英文环境下的半角写法）。
    const step = /^ {2}\[(\w[\w-]*)\] (\S+) {2}(\S+)(?: → (\S+))?(?:[（(]改写首帧 cwd: (.+) → (.+)[）)])? {2}reason=(.*)$/.exec(line)
    if (step !== null && step[1] !== 'ok' && step[1] !== 'keep') {
      const kind = step[1] as RepairStep['kind']
      base.steps.push({
        kind,
        sessionId: step[2]!,
        fromProjectKey: step[3]!,
        ...(step[4] !== undefined ? { toProjectKey: step[4] } : {}),
        ...(step[5] !== undefined && step[6] !== undefined ? { prefixRewrite: { from: step[5], to: step[6] } } : {}),
        reason: step[7] ?? '',
        /**
         * 是否能真的执行 —— **由 planner 的语义决定，不靠「kind 不是 keep」这种猜测**（验收 F5）。
         * planner 里只有 move / rewrite-move 是可执行的；skip / ok 恒不可执行；
         * quarantine 只在用户点名 --keep 时才可执行，而救急台当前不暴露 keep。
         */
        applies: kind === 'move' || kind === 'rewrite-move',
      })
      continue
    }
    if (line.startsWith('已归位') || line.startsWith('已隔离重复副本')) base.done.push(line.trim())
    else if (line.startsWith('跳过非 projectKey')) base.notices.push(line.trim())
  }
  base.errors = err.slice()
  base.ok = code === 0
  base.needsAttention = base.steps.length > 0
  if (!base.ok && base.error === undefined && err.length > 0) base.error = err[0]
  return base
}

/** 磁盘清理结果（页面渲染用） */
export interface CleanupOutcome {
  ok: boolean
  removed: number
  freedBytes: number
  errors: number
  detail: string[]
  sections: string[]
  error?: string
}

/**
 * 清理可重建缓存（tmp / 市场缓存 / 市场工作副本）。
 *
 * 硬边界（与路由 `/disk-usage/cleanup` 同源）：
 *  - 候选集只有**可重建区**；`snapshots` 与 `sync` 永不在候选集内；
 *  - **只有用户显式勾选 expired-exports 才碰导出产物**，且永远只按保留期（绝不「立即清空」）；
 *  - 不做 SAFE MODE / 环境锁门（本动作不写配置、不碰会话字节），但绝不越界删别的目录。
 */
export async function cleanupDisk(
  dataDir: string,
  exportsDir: string,
  selection: { caches: boolean; expiredExports: boolean },
): Promise<CleanupOutcome> {
  const sections: Array<'tmp' | 'exports' | 'marketCache' | 'marketWork'> = []
  if (selection.caches) sections.push('tmp', 'marketCache', 'marketWork')
  if (selection.expiredExports) sections.push('exports')
  if (sections.length === 0) {
    return { ok: false, removed: 0, freedBytes: 0, errors: 0, detail: [], sections: [], error: '没有勾选任何清理项。' }
  }
  const { cleanupCaches } = await import('../core/cache-cleaner.ts')
  try {
    const result = await cleanupCaches({
      tmpDir: path.join(dataDir, 'tmp'),
      exportsDir,
      marketCacheRoot: path.join(dataDir, 'market', 'cache'),
      marketWorkRoot: path.join(dataDir, 'market', 'work'),
      // 手动清理：可重建区忽略保留期整块清（与 GUI 「立即清理」同一语义）
      includeRecent: selection.caches,
      sections,
      // 定时备份产物由保留策略管理，不按天回收
      exportsExemptPrefix: AUTO_BACKUP_PREFIX,
    })
    /**
     * 「目录不存在」不是失败：cache-cleaner 把 readdir 失败统一记进 errors（其余分区照常回执），
     * 所以判据不是 errors === 0，而是「没有分区因为目录本来就不存在而整个跳过」。
     * 做法：先对本次勾选的分区各 stat 一次，缺失的都不计入失败 —— 剩下的才是真实删除失败。
     */
    let missing = 0
    for (const section of sections) {
      const dir = section === 'exports' ? exportsDir
        : section === 'tmp' ? path.join(dataDir, 'tmp')
          : path.join(dataDir, 'market', section === 'marketCache' ? 'cache' : 'work')
      if (!fssync.existsSync(dir)) missing += 1
    }
    const realErrors = Math.max(0, result.errors - missing)
    return {
      ok: realErrors === 0,
      removed: result.removed,
      freedBytes: result.freedBytesRecursive,
      errors: result.errors,
      detail: result.detail.slice(0, 200),
      sections: result.sections.slice(),
    }
  } catch (error) {
    return { ok: false, removed: 0, freedBytes: 0, errors: 0, detail: [], sections: [], error: errorText(error) }
  }
}

export interface RecoverLockOutcome {
  ok: boolean
  removed: boolean
  state: string
  detail: string
}

/**
 * 回收残留环境锁（**显式动作**，与 `recover-stale-lock` 同一实现）。
 *
 * 绝不自动、绝不放宽：只有 `inspectLockState` 确证 stale（或崩溃残留无有效 owner）才动；
 * 活锁一律拒绝（判据在 `EnvironmentLockManager.recoverStaleLock` 内部二次验证）。
 */
export async function recoverStaleEnvironmentLock(locksDir: string, dataDir: string): Promise<RecoverLockOutcome> {
  const { EnvironmentLockManager } = await import('../utils/env-lock.ts')
  const lock = new EnvironmentLockManager({
    locksDir,
    op: 'rescue-console-recover',
    target: dataDir,
    lockVersion: '0.1.0',
  })
  try {
    const result = await lock.recoverStaleLock()
    return {
      ok: result.ok && result.removed === true,
      removed: result.removed === true,
      state: result.state,
      detail: result.detail ?? '（无详情）',
    }
  } catch (error) {
    return { ok: false, removed: false, state: 'LOCK_IO_ERROR', detail: errorText(error) }
  }
}


/* ------------------------------------------------------------ 档案与实例（阶段 3） */

/**
 * 救急台要能回答「DSH 起不来了，我还能不能把它起回来」：
 *  - **列档案**：复用 `DshProfileManager`（纯文件读，与宿主/CLI 同一实现）；
 *  - **启动实例**：复用 `DshProfileLauncher`（挑空闲端口 → detached spawn → 抓带 token 的认证 URL → 探活）；
 *  - **停止实例**：先按**台账**（本插件启动的）停，找不到再看**心跳**（手动 `dsh web` 起来的）——
 *    两个来源缺一不可：只认台账会漏掉手动实例（真机 bug：同名能反复启动）。
 *
 * 三条硬约束（与宿主 profile 路由同源）：
 *  ① `desktop` 是 Electron 独占档案 → 一律按 `managedProfile` 拒绝（普通 CLI 对它会直接报错退出）；
 *  ② 非 web 形态不可启动（headless/generic spawn 出去是用户看不见的进程）；
 *  ③ **绝不静默**：每个失败码都带原因，启动失败附子进程日志尾部。
 */

export interface ProfileRow {
  name: string
  shape: string
  bundles: number
  dependencies: number
  hasNodeModules: boolean
  patchEntryCount: number
  updatedAtMs: number | null
  dshVersion: string | null
  sessionFormatVersion: number | null
  /** 是否可启动（web 形态 + 非 Electron 独占档案 + 当前没有实例） */
  launchable: boolean
  launchBlockedReason?: string
  /** 本插件台账里的实例（有则说明是我们启动的） */
  owned: boolean
  /** 台账 ∪ 心跳表明有实例在跑（含手动启动的） */
  running: boolean
  port: number | null
  /** 台账里带认证 token 的 URL（只有本插件启动的才有） */
  url: string | null
  pid: number | null
}

export interface ProfilesOutcome {
  ok: boolean
  profilesDir: string
  rows: ProfileRow[]
  /** 台账/心跳读取失败的原因（页面必须显示） */
  errors: string[]
}

/** 同步读心跳（列表页用；异步版 readRunningInstances 仍是网页其余部分的口径）。 */
function readRunningInstancesSync(controlRoots: readonly string[]): RunningInstance[] {
  const out: RunningInstance[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (const root of controlRoots) {
    const dir = path.join(root, 'running')
    let names: string[]
    try {
      names = fssync.readdirSync(dir).filter((n) => n.endsWith('.json'))
    } catch {
      continue
    }
    for (const name of names) {
      try {
        const record = parseRuntimeRecord(fssync.readFileSync(path.join(dir, name), 'utf8'))
        if (record === null) continue
        if (!isProcessAlive(record.pid) || now - record.updatedAt > RUNTIME_STALE_MS) continue
        const key = record.name + '#' + String(record.pid)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ name: record.name, pid: record.pid, port: record.port, startedAt: record.startedAt, updatedAt: record.updatedAt })
      } catch {
        // 单条读不出来不阻断
      }
    }
  }
  return out
}

/** 列档案 + 实例状态（台账 ∪ 心跳；零写入 —— 只读 launches.json 与 running/）。 */
export function readProfiles(paths: RescuePaths): ProfilesOutcome {
  const errors: string[] = []
  const profilesDir = path.join(paths.homeDir, 'profiles')
  let rows: ProfileRow[] = []
  try {
    const manager = new DshProfileManager({ homeDir: paths.homeDir })
    const launches = parseLaunches(readTextSafe(path.join(paths.dataDir, LAUNCHES_FILENAME)) ?? '')
    const heartbeats = readRunningInstancesSync(paths.controlRoots)
    rows = manager.list().map((meta) => {
      const managed = isManagedProfileName(meta.name)
      const shapeOk = meta.shape === 'web'
      const record = launches.find((l) => l.name === meta.name && isProcessAlive(l.pid))
      const beat = heartbeats.find((h) => h.name === meta.name)
      const running = record !== undefined || beat !== undefined
      const launchable = !managed && shapeOk && !running
      const blocked = managed
        ? '该档案由桌面端（Electron）独占管理，普通 CLI 无法启动它。'
        : shapeOk
          ? '已有实例在运行（先停止再启动，避免同名多开）。'
          : '该档案不是 web 形态（没有浏览器界面），启动出来是看不见的进程。'
      return {
        name: meta.name,
        shape: meta.shape,
        bundles: meta.bundles.length,
        dependencies: Object.keys(meta.dependencies).length,
        hasNodeModules: meta.hasNodeModules,
        patchEntryCount: meta.patchEntryCount,
        updatedAtMs: meta.updatedAtMs,
        dshVersion: meta.dshVersion ?? null,
        sessionFormatVersion: meta.sessionFormatVersion ?? null,
        launchable,
        ...(launchable ? {} : { launchBlockedReason: blocked }),
        owned: record !== undefined,
        running,
        port: record?.port ?? beat?.port ?? null,
        url: record?.url ?? null,
        pid: record?.pid ?? beat?.pid ?? null,
      }
    })
  } catch (error) {
    errors.push('档案列表读取失败：' + errorText(error))
  }
  return { ok: errors.length === 0, profilesDir, rows, errors }
}

export interface LaunchOutcome {
  ok: boolean
  /** started / managedProfile / notLaunchable / alreadyRunning / launcherUnavailable / launchFailed / notFound */
  code: string
  message: string
  url?: string
  port?: number
  pid?: number
  logFile?: string
  /** 就绪/URL 的告警（notReady / urlNotFound），如实回传 */
  warnings: string[]
}

/** 启动某个档案的独立实例（与宿主「启动」按钮同一实现）。 */
export async function launchProfile(paths: RescuePaths, name: string): Promise<LaunchOutcome> {
  const manager = new DshProfileManager({ homeDir: paths.homeDir })
  const meta: DshProfileMeta | undefined = manager.list().find((m) => m.name === name)
  if (meta === undefined) {
    return { ok: false, code: 'notFound', message: '找不到该档案：' + name, warnings: [] }
  }
  const launcher = new DshProfileLauncher({
    homeDir: paths.homeDir,
    dataDir: paths.dataDir,
    deps: {
      // 心跳判据：手动 `dsh web` 起来的实例也必须挡住同名多开（与宿主注入同源）
      isProfileRunning: (candidate) => readRunningInstancesSync(paths.controlRoots).some((r) => r.name === candidate),
    },
  })
  try {
    const result = await launcher.launch({ name: meta.name, shape: meta.shape })
    return {
      ok: true,
      code: 'started',
      message: result.ready ? '实例已就绪。' : '进程已启动，但探活未通过（见下方告警）。',
      ...(result.url !== null ? { url: result.url } : {}),
      port: result.port,
      // pid 为 null 时（极端：拿不到子进程 pid）如实省略，不塞一个假数字
      ...(result.pid !== null ? { pid: result.pid } : {}),
      logFile: result.logFile,
      warnings: result.warnings.slice(),
    }
  } catch (error) {
    const code = error instanceof DshProfileError ? error.code : 'launchFailed'
    return { ok: false, code, message: errorText(error), warnings: [] }
  }
}

export interface StopOutcome {
  ok: boolean
  code: string
  message: string
  /** graceful / killed / already-stopped */
  result?: string
}

/** 停止实例：先台账（本插件启动的），再心跳（手动启动的）。都找不到 → notRunning。 */
export async function stopProfile(paths: RescuePaths, name: string): Promise<StopOutcome> {
  const launcher = new DshProfileLauncher({ homeDir: paths.homeDir, dataDir: paths.dataDir })
  try {
    const result = await launcher.stop(name)
    return { ok: true, code: 'stopped', message: '已停止（' + result.result + '）。', result: result.result }
  } catch (error) {
    const code = error instanceof DshProfileError ? error.code : 'stopFailed'
    if (code !== 'notRunning') return { ok: false, code, message: errorText(error) }
  }
  // 台账里没有 → 看心跳（手动启动 / 别的实例管理的）。
  // **pid 必须传本进程**：stopExternal 的「不能停自己」判定是 record.pid === this.pid，
  // 传一个假的 -1 会让那道护栏永远不成立 —— 心跳恰好指向本进程时就会把自己杀掉（实测踩到）。
  const registry = new DshProfileRuntimeRegistry({ dataDir: paths.dataDir, name, pid: process.pid })
  try {
    const result = await registry.stopExternal(name)
    const portText = result.port === undefined ? '' : '，端口 ' + String(result.port)
    return { ok: true, code: 'stopped', message: '已停止外部实例（' + result.result + portText + '）。', result: result.result }
  } catch (error) {
    const code = error instanceof DshProfileError ? error.code : 'stopFailed'
    return { ok: false, code, message: errorText(error) }
  }
}

/* ------------------------------------------------------------ 加密备份解锁（阶段 4a） */

export interface UnlockOutcome {
  ok: boolean
  /** 失败码：not-encrypted / bad-password / tampered / unsupported / not-found / io-error */
  code: string
  message: string
  /** 成功时的清单（只读，绝不回传文件内容） */
  entries?: Array<{ path: string; sizeBytes: number }>
  entryCount?: number
  totalBytes?: number
  /** 明文 ZIP 是否被落盘（恒 false —— 这里的实现从不写盘，字段用于自证） */
  plaintextWritten?: false
}

/**
 * 解锁一个**加密容器备份**（DCA1）并列出其内容清单（**零写入**）。
 *
 * 三条硬约束：
 *  ① 明文 ZIP **只在进程内存**里存在（不落盘、不进日志、不回传内容），用完即弃；
 *  ② 失败码可判别（not-encrypted / bad-password / tampered / unsupported），页面据此给不同指引；
 *  ③ 只处理「导出目录里确实存在的那个文件名」（与 /verify 同源），不解析用户给的路径 → 无目录穿越。
 */
export async function unlockEncryptedBackup(
  exportsDir: string,
  fileName: string,
  password: string,
): Promise<UnlockOutcome> {
  if (password === '') return { ok: false, code: 'bad-password', message: '密码为空。' }
  const target = path.join(exportsDir, fileName)
  try {
    await fsp.stat(target)
  } catch {
    return { ok: false, code: 'not-found', message: '导出目录里没有这个备份：' + fileName }
  }
  const { decryptArchive, verifyEncryptedBlob } = await import('../security/encryption.ts')
  const { parseZip } = await import('../utils/zip.ts')
  try {
    const blob = await fsp.readFile(target)
    const verified = await verifyEncryptedBlob(blob, password)
    if (!verified.valid) {
      /**
       * 统一归一到 'not-encrypted'：core 的 TAMPERED / UNSUPPORTED_FORMAT 是**字节级**分类，
       * 而这里对用户要说的是「这个文件不是本插件的加密容器（或已损坏）——先确认选对了文件」。
       * 原始 code 保留在 message 里，便于排查。
       */
      return {
        ok: false,
        code: 'not-encrypted',
        message: '这不是本插件产出的加密容器（或文件已损坏）。底层判定：' + String(verified.code ?? 'unknown'),
      }
    }
    if (!verified.ok) {
      return { ok: false, code: 'bad-password', message: '密码不正确（认证标签校验失败）。' }
    }
    if (verified.info === null || verified.kdf === null) {
      return { ok: false, code: 'unsupported', message: '容器参数缺失，无法解密。' }
    }
    const plain = await decryptArchive(blob, verified.info, verified.kdf, password)
    const archive = parseZip(plain)
    const entries: Array<{ path: string; sizeBytes: number }> = []
    let totalBytes = 0
    for (const name of archive.names()) {
      const data = archive.readEntry(name)
      entries.push({ path: name, sizeBytes: data.length })
      totalBytes += data.length
      if (entries.length >= 5000) break
    }
    return {
      ok: true,
      code: 'ok',
      message: '解锁成功（清单如下；明文只在内存中解出，未写入磁盘）。',
      entries,
      entryCount: entries.length,
      totalBytes,
      plaintextWritten: false,
    }
  } catch (error) {
    const code = (error as { code?: string }).code
    return { ok: false, code: code ?? 'io-error', message: errorText(error) }
  }
}

/* ------------------------------------------------------------ 快照恢复（阶段 4b） */

export interface RestorePlanView {
  ok: boolean
  code: string
  message: string
  snapshotId?: string
  createdAt?: string
  sourceZip?: string
  pluginBaselineConfirmed?: boolean
  /** 逐条动作（页面渲染；kind/target/detail 直接来自 core 的 RestorePlan） */
  actions?: Array<{ kind: string; description: string; target?: string; detail?: string; manualHint?: string; dangerous: boolean }>
  summary?: Record<string, number>
}

/** 危险动作判定：会改动磁盘的分区（skip / credentialHint 不算）。 */
function isDangerousRestoreKind(kind: string): boolean {
  return kind === 'hostFileRestore' || kind === 'hostFileRemove' || kind === 'fileRestore' || kind === 'fileRemove' || kind === 'pluginRemove'
}

/** 本机 DSH 包名（T8-F3；与 core/restore.ts 的 `DSH_PACKAGE_NAME` 同值 —— 两处读的是同一个文件）。 */
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/**
 * 目标档案当前的 DSH 版本（T8-F3；离线 CLI 的 best-effort 来源）。
 *
 * 为什么是这个来源：CLI 恰恰在 **DSH 已经起不来** 的场景下运行，没有「运行时权威版本」可问
 * （那是宿主侧的东西：`HostContext.dshVersion` / `profileContext.installAnchor`）。这里与
 * `core/restore.ts` 的兜底、档案页的 `DshProfileMeta.dshVersion` **读的是同一个文件**
 * （`profiles/<p>/node_modules/@deepseek-ai/dsh/package.json`），所以显式传出不改变数值，
 * 但把「版本判定来源」固定在一处（将来 CLI 若拿到更好的来源只改这里），且不再让 core 猜一次。
 * 读不到 → undefined：core 按「版本未知」处理（不猜、不产出「版本不同」告警）。
 */
function currentProfileDshVersion(paths: RescuePaths): string | undefined {
  try {
    return readInstalledVersion(resolveProfileDir(paths.homeDir, paths.profile), DSH_PACKAGE_NAME) ?? undefined
  } catch {
    // 档案名非法 / 目录不可读 → 与「没装」同样处理：不猜版本（绝不因此让恢复计划失败）
    return undefined
  }
}

/**
 * 取某个快照的**恢复计划**（只读；与 CLI \`restore --dry-run\` 同一实现）。
 *
 * 与 CLI 完全同源：\`planRestore\` + 同一个 \`snapshotsRoot\` 校验（存在/READY/manifest/blob-hash/symlink/provenance）。
 */
export async function planSnapshotRestore(paths: RescuePaths, snapshotId: string): Promise<RestorePlanView> {
  const { planRestore } = await import('../core/restore.ts')
  const snapshotDir = path.join(paths.snapshotsDir, snapshotId)
  try {
    const plan = await planRestore({
      snapshotDir,
      homeDir: paths.homeDir,
      profile: paths.profile,
      snapshotsRoot: paths.snapshotsDir,
      currentDshVersion: currentProfileDshVersion(paths),
    })
    return {
      ok: true,
      code: 'ok',
      message: '计划已生成（尚未改动任何文件）。',
      snapshotId: plan.snapshotId,
      createdAt: plan.createdAt,
      sourceZip: plan.sourceZip,
      pluginBaselineConfirmed: plan.pluginBaselineConfirmed,
      actions: plan.actions.map((action) => ({
        kind: action.kind,
        description: action.description,
        ...(action.target !== undefined ? { target: action.target } : {}),
        ...(action.detail !== undefined ? { detail: action.detail } : {}),
        ...(action.manualHint !== undefined ? { manualHint: action.manualHint } : {}),
        dangerous: isDangerousRestoreKind(action.kind),
      })),
      summary: { ...plan.summary },
    }
  } catch (error) {
    return { ok: false, code: 'plan-failed', message: errorText(error) }
  }
}

export interface RestoreRunOutcome {
  ok: boolean
  code: string
  message: string
  restored?: string[]
  removedPlugins?: string[]
  manualHints?: string[]
  failed?: Array<{ item: string; reason: string }>
  skipped?: string[]
}

/**
 * 执行快照恢复（**destructive**：会覆盖 $DSH_HOME 文件、删除文件、卸载插件）。
 *
 * 与 CLI 同源：执行前过 \`checkWriteGates\`（SAFE MODE → 残留锁 → DSH 未运行），
 * 覆盖前由 core 复制到 \`<snapshotDir>/pre-restore/\`（可人工反悔），并在恢复后刷新工作区登记序号。
 */
export async function runSnapshotRestore(paths: RescuePaths, snapshotId: string): Promise<RestoreRunOutcome> {
  const gate = await checkWriteGates(paths.controlRoots, { needsDshStopped: true, locksDir: paths.locksDir })
  if (!gate.ok) return { ok: false, code: gate.code, message: gate.reason }
  const { restore } = await import('../core/restore.ts')
  try {
    const report = await restore({
      snapshotDir: path.join(paths.snapshotsDir, snapshotId),
      homeDir: paths.homeDir,
      profile: paths.profile,
      snapshotsRoot: paths.snapshotsDir,
      currentDshVersion: currentProfileDshVersion(paths),
    })
    return {
      ok: report.failed.length === 0,
      code: report.failed.length === 0 ? 'restored' : 'partial',
      message: report.failed.length === 0 ? '恢复完成。' : '恢复完成但有失败项（见下）。',
      restored: report.restored.slice(0, 500),
      removedPlugins: report.removedPlugins.slice(0, 200),
      manualHints: report.manualHints.slice(0, 200),
      failed: report.failed.slice(0, 200).map((f) => ({ item: f.item, reason: f.reason })),
      skipped: report.skipped.slice(0, 200),
    }
  } catch (error) {
    return { ok: false, code: 'restore-failed', message: errorText(error) }
  }
}

/* ------------------------------------------------------------ 离线导出（阶段 4c） */

export interface ExportOutcome {
  ok: boolean
  code: string
  message: string
  outPath?: string
  entryCount?: number
  sections?: Array<{ sectionId: string; label: string; entryCount: number; excludedCount: number; risk?: string }>
  warnings?: string[]
  /** 离线**不可收集**的分区（必须如实列出，绝不假装导出成功） */
  unavailableSections?: string[]
}

/**
 * 离线文件级导出（与 CLI \`backup\` 同一实现：collectBackupEntries → buildChecksums/manifest → writeZip）。
 *
 * 只打包**离线可直读**的文件类分区；结构化分区读不到就不进归档（宁可如实少导，也不给假备份）。
 * 文件落在导出目录，命名与 CLI 一致（自动去重，绝不覆盖既有文件）。
 */
export async function exportOfflineBackup(
  paths: RescuePaths,
  sections: readonly string[],
): Promise<ExportOutcome> {
  const {
    collectBackupEntries, buildSectionFlags, OFFLINE_UNAVAILABLE_SECTIONS,
  } = await import('../core/backup-plan.ts')
  const { buildChecksums } = await import('../utils/hashing.ts')
  const { stringifyJsonSafe } = await import('../utils/json.ts')
  const { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } = await import('../schema/manifest.ts')
  const { writeZip } = await import('../utils/zip.ts')
  const only = sections as never[]
  try {
    const collection = await collectBackupEntries(paths.homeDir, only)
    if (collection.entries.length === 0) {
      return { ok: false, code: 'nothing-to-export', message: '没有可打包的内容（该 home 下未找到可离线收集的分区）。' }
    }
    const now = new Date()
    const stamp = String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
      + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0')
    const { randomBytes } = await import('node:crypto')
    const desired = 'dsh-config-cli-' + stamp + '-' + randomBytes(4).toString('hex') + '.zip'
    await fsp.mkdir(paths.exportsDir, { recursive: true })
    let existing: string[] = []
    try { existing = await fsp.readdir(paths.exportsDir) } catch { existing = [] }
    let outPath = path.join(paths.exportsDir, desired)
    if (existing.includes(desired)) {
      const base = desired.slice(0, -4)
      for (let i = 1; ; i += 1) {
        const candidate = base + '-' + String(i) + '.zip'
        if (!existing.includes(candidate)) { outPath = path.join(paths.exportsDir, candidate); break }
      }
    }
    const checksums = buildChecksums(collection.entries)
    const manifest = buildManifest({
      // 真实版本（runWeb 经 RescuePaths 注入）；拿不到时给中性占位，绝不谎报某个具体版本。
      exporterVersion: paths.exporterVersion ?? '0.0.0-unknown',
      // 离线探测不到真实 DSH 版本：如实标注，不谎报
      dshVersion: 'cli-offline',
      platform: process.platform as never,
      arch: process.arch,
      sections: buildSectionFlags(collection.included),
      containsSecrets: false,
      encrypted: false,
      encryption: null,
    })
    const entries = [
      ...collection.entries,
      { name: CHECKSUMS_FILE, data: new TextEncoder().encode(stringifyJsonSafe(checksums, { space: 2 })) },
      { name: MANIFEST_FILE, data: new TextEncoder().encode(stringifyJsonSafe(manifest, { space: 2 })) },
    ]
    await writeZip(outPath, entries)
    // 落盘后立即自检（与 verify 同一实现）：只有自检通过才算成功
    const check = await verifyBackupZip(outPath)
    if (check.verdict !== 'OK') {
      return {
        ok: false, code: 'self-check-failed',
        message: '备份已写出但自检未通过（文件保留供复核）：' + outPath,
        outPath,
      }
    }
    return {
      ok: true,
      code: 'exported',
      message: '导出完成并已自检通过。',
      outPath,
      entryCount: collection.entries.length,
      sections: collection.sections.map((s) => ({
        sectionId: s.sectionId, label: s.label, entryCount: s.entryCount, excludedCount: s.excludedCount,
        ...(s.risk !== undefined ? { risk: s.risk } : {}),
      })),
      warnings: collection.warnings.slice(0, 200),
      unavailableSections: [...OFFLINE_UNAVAILABLE_SECTIONS],
    }
  } catch (error) {
    return { ok: false, code: 'export-failed', message: errorText(error) }
  }
}

/** 离线默认可导出的分区（页面渲染勾选项）。 */
export async function defaultExportSections(): Promise<string[]> {
  const { DEFAULT_BACKUP_SECTIONS } = await import('../core/backup-plan.ts')
  return [...DEFAULT_BACKUP_SECTIONS]
}

/* ------------------------------------------------------------ 重装 DSH（阶段 4d，高危） */

export interface ReinstallPlanView {
  ok: boolean
  code: string
  message: string
  version?: string
  wipeConfig?: boolean
  steps?: Array<{ label: string; command: string; dangerous: boolean }>
  /** 当前已安装版本（探测不到 → null：按 fail-closed 不允许继续） */
  currentVersion?: string | null
}

/** 生成重装计划（只读；与 CLI \`reinstall --dry-run\` 同一实现）。 */
export async function planDshReinstall(
  selection: readonly string[],
  version: string,
  exec: (cmd: string) => Promise<string>,
): Promise<ReinstallPlanView> {
  const { buildReinstallPlan, detectInstalledDshVersion } = await import('../core/reinstall.ts')
  try {
    const current = await detectInstalledDshVersion(exec)
    const plan = await buildReinstallPlan(new Set(selection) as never, version, exec)
    return {
      ok: true,
      code: 'ok',
      message: current === null
        ? '探测不到当前已安装版本：执行会被 fail-closed 拒绝（先确认 dsh --version 可用）。'
        : '计划已生成（尚未执行任何命令）。',
      version: plan.version,
      wipeConfig: plan.wipeConfig,
      steps: plan.steps.map((s) => ({ label: s.label, command: s.command, dangerous: s.dangerous === true })),
      currentVersion: current,
    }
  } catch (error) {
    return { ok: false, code: 'plan-failed', message: errorText(error) }
  }
}

export interface ReinstallRunOutcome {
  ok: boolean
  code: string
  message: string
  executed?: string[]
  failed?: Array<{ label: string; command: string; reason: string }>
  recoveryPointWritten?: boolean
}

/**
 * 执行重装（**最高危**：卸载全局包 + 清缓存，勾选数据类还会清 ~/.dsh）。
 *
 * 与 CLI 同源的安全序列（一步都不能省）：
 *  ① SAFE MODE 门 + 环境锁（\`runWithMutationLock\`）；
 *  ② program 步前先探测旧版本，探测不到 → fail-closed 不执行；
 *  ③ 写 durable recovery point 成功后才跑第一条命令；
 *  ④ 逐条执行、逐条记录结果（失败不静默）。
 */
export async function runDshReinstall(
  paths: RescuePaths,
  selection: readonly string[],
  version: string,
  exec: (cmd: string) => Promise<string>,
): Promise<ReinstallRunOutcome> {
  const {
    buildReinstallPlan, detectInstalledDshVersion, writeReinstallRecoveryPoint,
  } = await import('../core/reinstall.ts')
  const { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError } = await import('../utils/env-lock.ts')
  const { Phase3Recovery } = await import('../core/phase3-host.ts')
  const safeMsg = checkSafeModeBlockedLocal(paths.controlRoots)
  if (safeMsg !== null) return { ok: false, code: 'safe-mode', message: safeMsg }
  try {
    const plan = await buildReinstallPlan(new Set(selection) as never, version, exec)
    const failed: Array<{ label: string; command: string; reason: string }> = []
    const executed: string[] = []
    let recoveryPointWritten = false
    const lock = new EnvironmentLockManager({
      locksDir: paths.locksDir,
      op: 'console-reinstall',
      target: plan.version,
      lockVersion: '0.1.0',
    })
    const recovery = new Phase3Recovery({ dataDir: paths.dataDir, packageVersion: '0.1.0', fingerprintDataDir: paths.dataDir })
    await recovery.initFingerprint().catch(() => undefined)
    await runWithMutationLock(lock, { op: 'console-reinstall', target: plan.version }, async (lockCtx) => {
      const runAll = async (journalCtx?: { operationId?: string }): Promise<void> => {
        if (selection.includes('program')) {
          const previous = await detectInstalledDshVersion(exec)
          if (previous === null) {
            failed.push({
              label: 'program recovery point', command: 'detectInstalledDshVersion',
              reason: '探测不到当前已安装版本，拒绝执行（fail-closed）：先确认 dsh --version 可用。',
            })
            return
          }
          try {
            await writeReinstallRecoveryPoint(paths.dataDir, {
              operationId: journalCtx?.operationId ?? 'console-reinstall',
              environmentFingerprint: recovery.recoveryEnvFingerprint,
              previousInstalledVersion: previous,
              requestedTargetSpec: plan.version,
              createdAt: new Date().toISOString(),
              recoveryHint: '如需手动恢复此版本：npm install -g @deepseek-ai/dsh@' + previous,
            })
            recoveryPointWritten = true
          } catch (error) {
            failed.push({ label: 'program recovery point', command: 'writeReinstallRecoveryPoint', reason: errorText(error) })
            return
          }
        }
        for (const step of plan.steps) {
          try {
            await exec(step.command)
            executed.push(step.label)
          } catch (error) {
            failed.push({ label: step.label, command: step.command, reason: errorText(error) })
          }
        }
      }
      if (lockCtx !== null) {
        await recovery.runExternalIntent({
          operationType: 'console-reinstall', lockCtx,
          intent: { adapter: 'dsh', ref: 'program', kind: 'Reinstall' }, fn: runAll,
        })
      } else {
        await runAll()
      }
    })
    return {
      ok: failed.length === 0,
      code: failed.length === 0 ? 'reinstalled' : 'partial',
      message: failed.length === 0 ? '重装完成。' : '重装完成但有 ' + String(failed.length) + ' 步失败。',
      executed, failed, recoveryPointWritten,
    }
  } catch (error) {
    if (error instanceof EnvironmentLockUnavailableError) {
      return { ok: false, code: 'locked', message: '拒绝执行：' + error.message }
    }
    return { ok: false, code: 'reinstall-failed', message: errorText(error) }
  }
}

/** 与 CLI 的 SAFE MODE 门同源（fail-closed：读不到也算阻断）。 */
function checkSafeModeBlockedLocal(controlRoots: readonly string[]): string | null {
  if (controlRoots.length === 0) {
    return '无法确定插件数据目录（控制面根），出于安全考虑拒绝执行。'
  }
  for (const root of controlRoots) {
    const state = readSafeModeMarkerSync(root)
    if (state === 'blocked') return 'SAFE MODE 已激活（存在未结案的配置 transaction）：先处理恢复事项再重装。'
    if (state === 'unknown') return 'SAFE MODE 标记无法判定（按最保守口径处理）：先人工核对标记文件。'
  }
  return null
}
