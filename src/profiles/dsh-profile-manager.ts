/**
 * DSH Profile 管理器（`$DSH_HOME/profiles/<name>`）—— 引擎层（node fs）。
 *
 * 「档案」在本插件里 = **DSH 自带 profile**（`dsh --profile <name>` 启动的那份），
 * 不是插件自有的配置快照。事实源恒为磁盘目录（DSH 自己也是这么读的）：
 *
 *   ~/.dsh/profiles/<name>/
 *     package.json        dependencies + dsh.profile.bundles（有序 bundle 层）+ patchReload
 *     cordis.patch.yml    用户 patch 层（patchReload: live 时热生效）
 *     pnpm-workspace.yaml 树外插件所需的 pnpm 设置（nodeLinker: hoisted）
 *     node_modules/       pnpm 装的树外插件（可能不存在）
 *
 * 设计约束（只消费 DSH 的稳定表面，不 import 任何 @deepseek-ai 内部包）：
 *  - 脚手架三个文件与 dsh-app-boot 的 initProfile 逐字节等价；
 *  - 保留名（shipped template 名 + Electron 的 desktop）不允许自建；
 *  - 名字校验复用 core/plugin-cli 的 validateProfileName（host 侧兜底）与 shared 的纯函数（双端一致）；
 *  - 「切换」在本引擎里只表示「记录下次启动用哪个」（`<dataDir>/next-profile`）——
 *    DSH 无法在运行中切换 profile，重启由用户/启动脚本负责。
 *
 * 物理删除：remove() 走 rmSync(recursive)，profile 目录内的 junction（pnpm 链接）
 * 只删链接本身，不会跟随进 pnpm store。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import { resolveProfileDir, validateProfileName } from '../core/plugin-cli.ts'
import {
  DSH_PROFILE_TEMPLATES, checkProfileName, classifyShape,
  type DshProfileDetail, type DshProfileErrorCode, type DshProfileIssue,
  type DshProfileMeta, type DshProfilePatchReload, type DshProfileSelection,
} from './dsh-profile-shared.ts'

/** DSH home 下的 profile 根目录名（与 dsh-app-boot 的 PROFILES_DIR 一致）。 */
export const PROFILES_DIR = 'profiles'
/** profile 的用户 patch 层文件名（与 dsh-app-boot 的 PROFILE_PATCH_FILENAME 一致）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
/** 「下次启动用哪个 profile」标记文件名（存放在插件 dataDir 下，机器本地状态，不参与备份）。 */
export const NEXT_PROFILE_FILENAME = 'next-profile'

export class DshProfileError extends Error {
  readonly code: DshProfileErrorCode
  constructor(code: DshProfileErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'DshProfileError'
    this.code = code
  }
}

/** cordis.patch.yml 脚手架（与 dsh-app-boot 的 PROFILE_PATCH_TEMPLATE 逐字节一致）。 */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** pnpm-workspace.yaml 脚手架（与 dsh-app-boot 的 PROFILE_PNPM_WORKSPACE 逐字节一致）。 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/** 详情里回传的 patch 原文上限（超过则截断为 null，避免把巨型文件塞进响应）。 */
const PATCH_TEXT_LIMIT = 256 * 1024

export interface DshProfileManagerOptions {
  /** DSH home（`$DSH_HOME`，宿主 resolveDshHome() 解析） */
  homeDir: string
  /** 插件 dataDir（「下次启动」标记落在这里） */
  dataDir: string
  /** 当前运行中的 profile 名（惰性读取，宿主注入） */
  currentProfile?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读文本文件；不可读返回 null（调用方决定是 prompt 还是 issue）。 */
function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 「档案」= DSH profile 的读写引擎（同步 fs；profile 数量级为个位数，无需异步）。 */
export class DshProfileManager {
  private readonly homeDir: string
  private readonly dataDir: string
  private readonly currentProfile: () => string

  constructor(options: DshProfileManagerOptions) {
    this.homeDir = options.homeDir
    this.dataDir = options.dataDir
    this.currentProfile = options.currentProfile ?? ((): string => 'web')
  }

  /** profiles 根目录（`$DSH_HOME/profiles`） */
  profilesRoot(): string {
    return join(this.homeDir, PROFILES_DIR)
  }

  /** 「下次启动」标记文件绝对路径 */
  selectionFile(): string {
    return join(this.dataDir, NEXT_PROFILE_FILENAME)
  }

  /** 列出全部可管理的 profile（有 package.json 的目录），按名字排序。 */
  list(): DshProfileMeta[] {
    const root = this.profilesRoot()
    if (!existsSync(root)) return []
    const out: DshProfileMeta[] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const dir = join(root, entry.name)
      if (!this.isProfileDir(dir, entry.isDirectory(), entry.isSymbolicLink())) continue
      // 没有 package.json 的目录不是 profile（DSH 自己也不会用）
      if (!existsSync(join(dir, 'package.json'))) continue
      out.push(this.readMeta(entry.name, dir))
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 单个 profile 的详情（含 package.json / cordis.patch.yml 原文）。 */
  detail(name: string): DshProfileDetail {
    const dir = this.requireProfile(name)
    const meta = this.readMeta(name, dir)
    const manifest = readTextSafe(join(dir, 'package.json'))
    const patchRaw = readTextSafe(join(dir, PROFILE_PATCH_FILENAME))
    const patch = patchRaw !== null && patchRaw.length <= PATCH_TEXT_LIMIT ? patchRaw : null
    return { ...meta, manifest, patch }
  }

  /** 读「下次启动」标记；无标记 / 内容为空 = null。 */
  readSelection(): DshProfileSelection | null {
    const raw = readTextSafe(this.selectionFile())
    if (raw === null) return null
    const name = raw.trim()
    if (name === '') return null
    let exists = false
    try {
      const dir = resolveProfileDir(this.homeDir, name)
      exists = existsSync(join(dir, 'package.json'))
    } catch {
      exists = false
    }
    return { name, exists, isCurrent: name === this.currentProfile() }
  }

  /** 写「下次启动」标记；目标 profile 必须已存在。 */
  writeSelection(name: string): DshProfileSelection {
    this.requireProfile(name)
    mkdirSync(this.dataDir, { recursive: true })
    atomicWriteFileSync(this.selectionFile(), `${name}\n`, { mode: 0o644 })
    return { name, exists: true, isCurrent: name === this.currentProfile() }
  }

  /** 清除「下次启动」标记（回到默认启动方式）。 */
  clearSelection(): void {
    rmSync(this.selectionFile(), { force: true })
  }

  /** 新建 profile（等价 dsh-app-boot 的 initProfile：三个脚手架文件）。 */
  create(name: string, templateId = 'base'): DshProfileMeta {
    const reason = checkProfileName(name)
    if (reason !== null) throw new DshProfileError(reason)
    const template = DSH_PROFILE_TEMPLATES.find((t) => t.id === templateId)
    if (template === undefined) throw new DshProfileError('unknownTemplate', `unknown template ${templateId}`)
    const dir = resolveProfileDir(this.homeDir, name)
    if (existsSync(dir)) throw new DshProfileError('exists')

    mkdirSync(dir, { recursive: true })
    const manifest = {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...template.bundles], patchReload: template.patchReload } },
    }
    atomicWriteFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    const patchPath = join(dir, PROFILE_PATCH_FILENAME)
    if (!existsSync(patchPath)) atomicWriteFileSync(patchPath, PROFILE_PATCH_TEMPLATE, { mode: 0o644 })
    const workspacePath = join(dir, 'pnpm-workspace.yaml')
    if (!existsSync(workspacePath)) atomicWriteFileSync(workspacePath, PROFILE_PNPM_WORKSPACE, { mode: 0o644 })
    return this.readMeta(name, dir)
  }

  /** 重命名（目录级移动；同步修正 package.json 的 name 字段与「下次启动」标记）。 */
  rename(name: string, newName: string): DshProfileMeta {
    const reason = checkProfileName(newName)
    if (reason !== null) throw new DshProfileError(reason)
    const from = this.requireProfile(name)
    const to = resolveProfileDir(this.homeDir, newName)
    if (existsSync(to)) throw new DshProfileError('exists')
    if (name === this.currentProfile()) {
      // 运行中的 profile 目录被改名会让当前进程的 patch 监视/写回指向旧路径
      throw new DshProfileError('currentProfile')
    }
    renameSync(from, to)
    const manifest = this.readManifestObject(to)
    if (manifest !== null) {
      manifest['name'] = `dsh-profile-${newName}`
      atomicWriteFileSync(join(to, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
    }
    const selection = this.readSelection()
    if (selection !== null && selection.name === name) {
      atomicWriteFileSync(this.selectionFile(), `${newName}\n`, { mode: 0o644 })
    }
    return this.readMeta(newName, to)
  }

  /**
   * 物理删除 profile 目录（rmSync recursive；目录内 junction 只删链接本身）。
   * 当前运行中的 profile 需要 allowCurrent=true 显式确认（删除会让重启后的实例直接失败）。
   */
  remove(name: string, opts: { allowCurrent?: boolean } = {}): void {
    const dir = this.requireProfile(name)
    if (name === this.currentProfile() && opts.allowCurrent !== true) {
      throw new DshProfileError('currentProfile')
    }
    rmSync(dir, { recursive: true, force: true })
    const selection = this.readSelection()
    if (selection !== null && selection.name === name) this.clearSelection()
  }

  /** 解析 profile 目录（不存在 → notFound）。 */
  private requireProfile(name: string): string {
    let dir: string
    try {
      dir = resolveProfileDir(this.homeDir, validateProfileName(name))
    } catch {
      throw new DshProfileError('invalidName')
    }
    if (!existsSync(join(dir, 'package.json'))) throw new DshProfileError('notFound')
    return dir
  }

  /** 目录判定：普通目录，或指向目录的符号链接/junction。 */
  private isProfileDir(dir: string, isDirectory: boolean, isSymbolicLink: boolean): boolean {
    if (isDirectory) return true
    if (!isSymbolicLink) return false
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  /** package.json 解析为对象（不可读 / 非对象 = null）。 */
  private readManifestObject(dir: string): Record<string, unknown> | null {
    const raw = readTextSafe(join(dir, 'package.json'))
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /** 组装列表行数据（损坏项不抛，标 issue 后照常返回）。 */
  private readMeta(name: string, dir: string): DshProfileMeta {
    const issues: DshProfileIssue[] = []
    const manifest = this.readManifestObject(dir)
    if (manifest === null) issues.push('manifestInvalid')
    const dshProfile = isRecord(manifest?.['dsh']) && isRecord((manifest['dsh'] as Record<string, unknown>)['profile'])
      ? (manifest['dsh'] as Record<string, unknown>)['profile'] as Record<string, unknown>
      : null
    const bundles = Array.isArray(dshProfile?.['bundles'])
      ? (dshProfile['bundles'] as unknown[]).filter((b): b is string => typeof b === 'string')
      : []
    const rawDeps = isRecord(manifest?.['dependencies']) ? manifest['dependencies'] as Record<string, unknown> : {}
    const dependencies: Record<string, string> = {}
    for (const [dep, spec] of Object.entries(rawDeps)) {
      if (typeof spec === 'string') dependencies[dep] = spec
    }
    const patchReload: DshProfilePatchReload = dshProfile?.['patchReload'] === 'startup' ? 'startup' : 'live'
    const patchRaw = readTextSafe(join(dir, PROFILE_PATCH_FILENAME))
    const patchBytes = patchRaw === null ? 0 : Buffer.byteLength(patchRaw, 'utf8')
    if (patchRaw !== null && patchBytes > PATCH_TEXT_LIMIT) issues.push('patchTooLarge')
    const patchEntryCount = patchRaw === null
      ? 0
      : patchRaw.split('\n').filter((line) => line.trimStart().startsWith('- ')).length
    let updatedAtMs: number | null = null
    try {
      updatedAtMs = statSync(join(dir, 'package.json')).mtimeMs
    } catch {
      updatedAtMs = null
    }
    return {
      name,
      dir,
      bundles,
      dependencies,
      shape: classifyShape(bundles),
      patchReload,
      hasNodeModules: existsSync(join(dir, 'node_modules')),
      patchEntryCount,
      patchBytes,
      isCurrent: name === this.currentProfile(),
      issues,
      updatedAtMs,
    }
  }
}
