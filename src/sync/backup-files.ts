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
 * 目录缺失/不可读 → 返回空数组（不抛错）。
 */
export async function listBackupFiles(exportsDir: string): Promise<BackupFileMeta[]> {
  let entries
  try {
    entries = await fs.readdir(exportsDir, { withFileTypes: true })
  } catch {
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
    metas.push({
      name: entry.name,
      path: target,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      source: backupFileSource(entry.name),
      note: notes[entry.name] ?? null,
    })
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
    throw new Error(`非法备份文件名: ${name}`)
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
