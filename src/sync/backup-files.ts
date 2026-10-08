/**
 * 备份文件管理 —— 框架无关纯函数层（node 可测）。
 *
 * 管理 $DSH_HOME/dsh-config-manager/exports 下的导出 ZIP 产物：
 *  - 手动导出（host /export 路由）与定时备份（BackupScheduler）共用该目录；
 *  - 定时备份产物用独立前缀（dsh-config-auto-）与手动导出（dsh-config-）区分：
 *    ① 备份文件列表展示来源（Badge）；② cache-cleaner 的 exports 7 天回收
 *    豁免 auto 前缀（定时备份的保留策略归 BackupScheduler，见 pruneAutoBackups）；
 *  - 保留策略：定时备份只保留最近 N 个（缺省 10），超出的旧文件在每次
 *    成功备份后清理；手动导出文件不自动删（由 cache-cleaner 按 7 天回收）。
 *
 * 安全约束：deleteBackupFile 只接受文件名（服务端 join exportsDir 后 basename
 * 校验，防路径穿越）；不触碰 snapshots/ 与 sync/（用户数据/安全网，不在此层）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDefaultRetentionPolicy, selectRetentionKeepers } from './retention-policy.ts'
import type { RetentionPolicy } from './retention-policy.ts'
import { readContainerKind, type BackupContainerKind } from '../security/container-kind.ts'
import { engineMsg } from './messages.ts'

/** 定时备份产物前缀（区别于手动导出的 dsh-config-；同时是来源标识与清理豁免依据） */
export const AUTO_BACKUP_PREFIX = 'dsh-config-auto-'

/** 定时备份缺省保留数量：最近 N 个（用户决策 2026-08-24） */
export const DEFAULT_BACKUP_RETENTION = 10

/** 备份文件来源（UI Badge 展示） */
export type BackupFileSource = 'auto' | 'manual'

/** 文件名 → 来源判定（auto 前缀优先；未知前缀归 manual，UI 上仍可管理） */
export function backupFileSource(name: string): BackupFileSource {
  return name.startsWith(AUTO_BACKUP_PREFIX) ? 'auto' : 'manual'
}

/** 备份文件元信息（列表行数据；无敏感字段） */
export interface BackupFileMeta {
  /** 文件名（如 dsh-config-auto-20260824-120000-abc.zip） */
  name: string
  /** 绝对路径（供 /download 与导入向导引用） */
  path: string
  /** 字节数 */
  sizeBytes: number
  /** 修改时间（ms 时间戳；按此倒序展示/清理） */
  mtimeMs: number
  /** 来源：auto = 定时备份；manual = 手动导出 */
  source: BackupFileSource
  /** 用户备注（手动导出时可选填写；null = 无备注） */
  note?: string | null
  /**
   * 容器形态（仅 `listBackupFiles(dir, { withContainerKind: true })` 时探测）。
   * 界面据此决定「导入」要不要先走「解锁加密备份」阶段（issue #55）；未探测的调用方
   * （保留策略 / 磁盘体检只要名称与时间）拿到 undefined，消费方按「非 encrypted」保守处理
   * —— 等同既有明文路径，绝不让缺字段把明文备份挡在解锁页。
   */
  containerType?: BackupContainerKind
}

/** listBackupFiles 选项。 */
export interface ListBackupFilesOptions {
  /**
   * **输出参数**：读目录失败（非 ENOENT）时写入原因，调用方据此如实展示
   * —— 「读不到」与「没有备份」是两件事，前者绝不能显示成空列表。
   */
  unreadable?: string
  /**
   * 是否逐文件探测容器形态（DCA1 magic，只读前 4 字节）。
   * 默认 false：保留策略（prune*）与磁盘体检不需要它，逐文件 open 是纯开销。
   */
  withContainerKind?: boolean
}

/** 备注清单文件名（exports 目录内；可随 self 分区白名单迁移——见 src/adapters/self.ts） */
export const BACKUP_NOTES_FILE = '.backup-notes.json'

/** 文件名校验（导出自定义文件名复用）：非空、仅文件名、.zip 结尾；
 *  显式拒绝 `/` `\` 与空白字符（防路径穿越与非法字符）。 */
export function isValidExportFileName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed === '' || trimmed !== name) return false
  if (!name.endsWith('.zip')) return false
  if (name.includes('/') || name.includes('\\')) return false
  // 只允许安全字符（字母数字、- _ . 与空格），杜绝 shell/路径元字符
  return /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\.zip$/.test(name)
}

/**
 * 同名去重：导出时若目标文件名已存在，自动追加数字后缀而非覆盖
 * （用户决策 2026-08-25：同名导出保留两个备份，不互相覆盖）。
 *
 * - 纯函数：仅依据现有文件名集合计算，无 I/O（可 node 直测）；
 * - `foo.zip` 已存在 → `foo-1.zip`；`foo-1.zip` 也存在 → `foo-2.zip` …；
 * - `existingNames` 为现有集合（目录下所有文件名）或可迭代；
 * - 集合不含该名 → 原样返回（零额外开销）。
 */
export function resolveNonCollidingExportName(
  desiredName: string,
  existingNames: Iterable<string>,
): string {
  const existing = new Set(existingNames)
  if (!existing.has(desiredName)) return desiredName
  const base = desiredName.endsWith('.zip') ? desiredName.slice(0, -4) : desiredName
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}.zip`
    if (!existing.has(candidate)) return candidate
  }
}

/** 读取备注清单（{ 文件名 → 备注 }；缺失/损坏 → 空对象）。 */
export async function readBackupNotes(exportsDir: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(exportsDir, BACKUP_NOTES_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 写入单条备注（保留其余；删除备份文件时同步清理，见 deleteBackupFile）。 */
export async function writeBackupNote(exportsDir: string, name: string, note: string): Promise<Record<string, string>> {
  const notes = await readBackupNotes(exportsDir)
  const trimmed = note.trim()
  if (trimmed === '') {
    delete notes[name]
  } else {
    notes[name] = trimmed
  }
  await fs.mkdir(exportsDir, { recursive: true })
  await fs.writeFile(path.join(exportsDir, BACKUP_NOTES_FILE), JSON.stringify(notes, null, 2), 'utf8')
  return notes
}

/**
 * 列出导出目录下的全部备份 ZIP（*.zip，时间倒序），合并备注。
 * 目录缺失（ENOENT）→ 返回空数组（不抛错）。
 *
 * **「读不到」不算「没有」**（验收 F2）：EACCES / EPERM / ENOTDIR 等一律回传
 * `options.unreadable`（调用方如实展示），默认不传 → 行为与改造前一致。
 *
 * `options.withContainerKind` 打开时逐个探测容器形态（解密判定走 security/container-kind 单一实现）。
 */
export async function listBackupFiles(exportsDir: string, options: ListBackupFilesOptions = {}): Promise<BackupFileMeta[]> {
  let entries
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'ENOENT') {
      options.unreadable = engineMsg('sync.backupExportsDirUnreadable', { code: String(code ?? 'unknown'), dir: exportsDir })
    }
    return []
  }
  const notes = await readBackupNotes(exportsDir)
  const metas: BackupFileMeta[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue
    const target = path.join(exportsDir, entry.name)
    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      continue // 竞态删除/不可读：跳过该文件
    }
    const meta: BackupFileMeta = {
      name: entry.name,
      path: target,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      source: backupFileSource(entry.name),
      note: notes[entry.name] ?? null,
    }
    // 形态探测按需做：只读前 4 字节，文件级失败在 readContainerKind 内回落为 'zip'
    if (options.withContainerKind === true) meta.containerType = await readContainerKind(target)
    metas.push(meta)
  }
  metas.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return metas
}

/** 文件名合法性校验：非空、仅文件名（无路径分隔符，防穿越）、.zip 结尾。
 *  显式拒绝 `/` 与 `\` 两种分隔符——不能依赖 path.basename 判定（平台相关：
 *  POSIX 的 basename 不识别反斜杠，Windows 两者都识别，跨平台会不一致）。 */
export function isValidBackupFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '') return false
  if (name.includes('/') || name.includes('\\')) return false
  return name.endsWith('.zip')
}

/**
 * 删除一个备份文件（仅限 exportsDir 内 *.zip；防穿越由 isValidBackupFileName 保证）。
 * 同步清理该文件的备注（若存在）。不存在视为成功（幂等）；返回是否实际删除。
 */
export async function deleteBackupFile(exportsDir: string, name: string): Promise<boolean> {
  if (!isValidBackupFileName(name)) {
    throw new Error(engineMsg('sync.backupFileNameInvalid', { name }))
  }
  const target = path.join(exportsDir, name)
  let removed = false
  try {
    await fs.rm(target, { force: false })
    removed = true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    throw err
  }
  try {
    await writeBackupNote(exportsDir, name, '')
  } catch {
    // 备注清理失败不影响文件删除结果（下次写备注时自然覆盖）
  }
  return removed
}

/**
 * 定时备份保留策略：只保留最近 keep 个 auto 前缀 ZIP，删除更旧的。
 * - 只动 AUTO_BACKUP_PREFIX 前缀的文件（手动导出文件永不在此被删）；
 * - 按 mtime 取最新的 keep 个，其余删除（stat 失败保守不删该文件）；
 * - 返回删除的文件名列表；目录缺失 → 空（不抛错）。
 *
 * 说明：本函数是既有公开 API（测试与调用方依赖），**签名与行为保持不变**。
 * 需要 GFS 分层（每月/每年留一份）请用 `pruneAutoBackupsByPolicy`。
 */
export async function pruneAutoBackups(exportsDir: string, keep: number): Promise<string[]> {
  const metas = await listBackupFiles(exportsDir)
  const auto = metas.filter((m) => m.source === 'auto')
  if (auto.length <= keep) return []
  const removed: string[] = []
  for (const meta of auto.slice(keep)) {
    try {
      await fs.rm(meta.path, { force: false })
      removed.push(meta.name)
    } catch {
      // 竞态/权限失败：保守跳过，下次清理再试
    }
  }
  return removed
}

/**
 * GFS 分层保留策略：按 RetentionPolicy 选出「应保留」的 auto 前缀 ZIP，删除其余。
 *
 * - 与 `pruneAutoBackups` 同一适用范围：**只动 AUTO_BACKUP_PREFIX 前缀**（手动导出永不删）；
 * - 时间口径 = `mtimeMs`（备份产物无 createdAt，mtime 即其诞生时间）；
 * - 缺省策略（keepLast=10 且无分层）走 `pruneAutoBackups` 快速路径 → 与改造前**逐字节等价**
 *   （保留旧实现的排序/切片语义，避免两条路径在 mtime 相同场景下出现差分）；
 * - 返回删除的文件名列表；目录缺失 → 空（不抛错）；单个删除失败保守跳过、不影响其余。
 */
export async function pruneAutoBackupsByPolicy(
  exportsDir: string,
  policy: RetentionPolicy,
): Promise<string[]> {
  // 快速路径：等价既有的「保留最近 N 个」（逐字节兼容，含 mtime 相同场景）
  if (isDefaultRetentionPolicy(policy)) {
    return pruneAutoBackups(exportsDir, policy.keepLast)
  }
  // audit-sync sync-F4（P2）：三层全关（0/0/0）= **不自动清理**（与 retentionPolicySummary 的
  // 自述「三层均未启用（策略等价于不自动清理）」、远端 prune 的「刚 push 恒保留」保护同一口径）。
  // 此前该策略会删光全部 auto 产物（含本轮刚生成的那一份），用户把 keepLast 拉到 0 就等于
  // 静默不再保留任何定时备份。
  if (policy.keepLast <= 0 && policy.keepMonthly <= 0 && policy.keepYearly <= 0) return []
  const metas = await listBackupFiles(exportsDir)
  const auto = metas.filter((m) => m.source === 'auto')
  if (auto.length === 0) return []
  const keepers = selectRetentionKeepers(
    auto.map((m) => ({ name: m.name, mtimeMs: m.mtimeMs })),
    policy,
  )
  const removed: string[] = []
  for (const meta of auto) {
    if (keepers.has(meta.name)) continue
    try {
      await fs.rm(meta.path, { force: false })
      removed.push(meta.name)
    } catch {
      // 竞态/权限失败：保守跳过，下次清理再试
    }
  }
  return removed
}
