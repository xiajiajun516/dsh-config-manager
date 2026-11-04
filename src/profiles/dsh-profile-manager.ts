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
 *  - 本引擎**不做任何进程操作**：档案的启动/停止在 `dsh-profile-launcher.ts`（独立实例）。
 *    历史上这里还有一个 `<dataDir>/next-profile`「下次启动」标记——DSH 根本没有消费者，
 *    只会误导用户（2026-09 按产品决策整体移除，连同前端按钮）。
 *
 * 物理删除：remove() 走 rmSync(recursive)，profile 目录内的 junction（pnpm 链接）
 * 只删链接本身，不会跟随进 pnpm store。
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, type Dirent } from 'node:fs'
// 复制走 async fs（整档案上万个文件，cpSync 会把宿主事件循环卡住二十多秒）
import { copyFile, cp, mkdir, readdir, readlink, rm, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import { isRecord } from '../utils/guards.ts'
import { resolveProfileDir, validateProfileName } from '../core/plugin-cli.ts'
import { readTextSafe } from './dsh-profile-io.ts'
import { readSessionFormatVersionInTree } from '../utils/session-format.ts'
import {
  DSH_PROFILE_TEMPLATES, PROFILE_COPY_MARKER_FILENAME, checkProfileName, classifyShape, isManagedProfileName,
  type DshProfileCopyMarker, type DshProfileCopyWarning, type DshProfileDetail, type DshProfileErrorCode,
  type DshProfileIncompleteCopy, type DshProfileIssue, type DshProfileMeta, type DshProfilePatchReload,
} from './dsh-profile-shared.ts'

/** DSH home 下的 profile 根目录名（与 dsh-app-boot 的 PROFILES_DIR 一致）。 */
export const PROFILES_DIR = 'profiles'
/** profile 的用户 patch 层文件名（与 dsh-app-boot 的 PROFILE_PATCH_FILENAME 一致）。 */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
/** pnpm 装出来的依赖目录（复制档案时可选择跳过）。 */
const NODE_MODULES_DIR = 'node_modules'
/** DSH 按 node_modules 投影出的派生目录（与 dsh-app-boot 的 PROFILE_MODULE_FALLBACK_DIR 一致）。 */
const MODULE_FALLBACK_DIR = '.dsh-module-fallback'

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
  /** 插件 dataDir（保留给调用方复用；本引擎不再落任何状态） */
  /** 当前运行中的 profile 名（惰性读取，宿主注入） */
  currentProfile?: () => string
}

/**
 * `candidate` 是否落在 `root` **内部**（root 自身不算）。
 * 跨盘符时 `relative` 会回一个绝对路径 → 判为「不在内部」（路径来自别的卷，不能重指向）。
 */
function isInsideDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '' || isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * t89：残留枚举结果 —— `unreadable` 让「枚举失败」与「确实没有残留」可区分；
 * `reason` 仅为诊断码（非用户文案，界面文案走字典键）。
 */
export interface DshProfileIncompleteCopiesScan {
  copies: DshProfileIncompleteCopy[]
  unreadable: boolean
  reason: string | null
}

/** t89：profiles 根目录枚举失败的原因码（诊断/日志用）。 */
export const PROFILES_ROOT_UNREADABLE = 'profiles-root-unreadable'

/** 回滚复制目标目录的缺省删除实现（递归强制；不存在不算错）。 */
const defaultProfileRemove = async (target: string): Promise<void> => {
  await rm(target, { recursive: true, force: true })
}

/**
 * 复制失败时回滚目标目录（cross-F3 收尾 / tech-debt #5）。
 *
 * **顺序即不变量：先删内容，标记留到最后。** 标记（`.dcm-copy-in-progress.json`）是「这个目录是半截副本」
 * 的唯一证据 —— `listIncompleteCopies()` 只认它，`requireManagedDir` 也只认它，没有 package.json
 * 又没有标记的目录既不进列表、删除还报 notFound（孤儿）。
 *
 * 此前 catch 里是一把 `rm(recursive)` 加一句注释：rm 先删掉标记再失败（例如某个只读子目录让它中途放弃），
 * 残留目录恰好落进那个「看不见也删不掉」的形态。这里两道保险：
 *  ① 逐条删顶层内容，标记不参与删除批次 —— 中途失败时标记必然还在；
 *  ② 收尾时若目录仍存在而标记没了（rm 部分生效 / 外部工具删过），**按原样重写标记**再放手。
 *
 * 因此只要返回，残留（若还在）**必然**能被 `listIncompleteCopies()` / `listIncompleteCopiesScan()`
 * 扫到，并能经 `remove()`（UI 的 diskApi.profileDelete）删除。
 *
 * @param remove 删除实现（缺省递归强制删除），仅供测试注入「部分失败」的 fs。
 */
export async function rollbackCopiedProfileDir(
  destDir: string,
  marker: DshProfileCopyMarker,
  remove: (target: string) => Promise<void> = defaultProfileRemove,
): Promise<{ removed: boolean; failedEntries: string[]; markerRestored: boolean }> {
  const markerPath = join(destDir, PROFILE_COPY_MARKER_FILENAME)
  const failedEntries: string[] = []
  let entries: Dirent[] = []
  try {
    entries = await readdir(destDir, { withFileTypes: true })
  } catch {
    // 读不出目录（已被删掉 / 无权限）：交给下面的存在性判据，不在此下结论
    entries = []
  }
  for (const entry of entries) {
    // 标记不进删除批次：它必须活到「内容全删完」那一刻
    if (entry.name === PROFILE_COPY_MARKER_FILENAME) continue
    try {
      await remove(join(destDir, entry.name))
    } catch {
      failedEntries.push(entry.name)
    }
  }
  if (failedEntries.length === 0) {
    // 内容已空：连标记带目录一起删（这一步失败也不影响下面的补写）
    try {
      await remove(destDir)
    } catch {
      // 目录删不掉（标记已随 rm 消失的风险由下面兜住）
    }
  }
  if (!existsSync(destDir)) return { removed: true, failedEntries: [], markerRestored: false }
  let markerRestored = false
  if (!existsSync(markerPath)) {
    try {
      atomicWriteFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 })
      markerRestored = true
    } catch {
      // 目录已不可写：连标记都补不回去，只能让调用方照常抛错（用户可手动删）
    }
  }
  return { removed: false, failedEntries, markerRestored }
}

/** 「档案」= DSH profile 的读写引擎（同步 fs；profile 数量级为个位数，无需异步）。 */
export class DshProfileManager {
  private readonly homeDir: string
  private readonly currentProfile: () => string

  constructor(options: DshProfileManagerOptions) {
    this.homeDir = options.homeDir
    this.currentProfile = options.currentProfile ?? ((): string => 'web')
  }

  /** profiles 根目录（`$DSH_HOME/profiles`） */
  profilesRoot(): string {
    return join(this.homeDir, PROFILES_DIR)
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
      // 正常 profile：以 package.json 为准（DSH 自己也是这么认的）
      if (existsSync(join(dir, 'package.json'))) { out.push(this.readMeta(entry.name, dir)); continue }
      // cross-F3：没有 package.json 但带「复制进行中标记」= 中断的复制残留。
      // 它是一个**必须可见**的条目 —— 否则查不到（不在列表里）、也删不掉（requireProfile → notFound）。
      const marker = this.readCopyMarker(dir)
      if (marker.present) out.push(this.incompleteMeta(entry.name, dir, marker))
      // 既无 package.json 又无标记的目录仍按既有口径跳过（DSH 自己也不会用）
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 单个 profile 的详情（含 package.json / cordis.patch.yml 原文）。 */
  detail(name: string): DshProfileDetail {
    const dir = this.requireManagedDir(name)
    const meta = existsSync(join(dir, 'package.json'))
      ? this.readMeta(name, dir)
      : this.incompleteMeta(name, dir, this.readCopyMarker(dir))
    const manifest = readTextSafe(join(dir, 'package.json'))
    const patchRaw = readTextSafe(join(dir, PROFILE_PATCH_FILENAME))
    const patch = patchRaw !== null && patchRaw.length <= PATCH_TEXT_LIMIT ? patchRaw : null
    return { ...meta, manifest, patch }
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

  /**
   * 复制档案：把 `<home>/profiles/<name>` 整份拷成 `<home>/profiles/<newName>`（清单 + patch 层 + pnpm 锁文件…），
   * package.json 的 name 字段改写为新档案名。
   *
   * 为什么是「目录级复制」而不是「按模板新建」：档案的全部差异（bundles 声明、patch 层、pnpm 锁文件、
   * 树外插件依赖）只存在于磁盘目录里 —— 按模板建出来的新档案与源档案毫无关系，而用户复制档案的
   * 真实意图是「拿一份可改的等价副本」。
   *
   * includeNodeModules（缺省 true）决定要不要一并拷 node_modules：
   *  - true  = 副本**立刻可用**（bundles 里的树外插件解析得到），代价是与源档案同体积且耗时
   *            （实测 285 MB / 1.7 万文件 ≈ 30 s）；
   *  - false = 秒级完成，但副本启动时会 `cannot resolve profile bundle`（DSH 自己的报错指向
   *            `dsh plugin --profile <名> install`）→ 返回 warning depsNotInstalled，调用方必须如实转达。
   *
   * 实现要点（都是实测踩出来的）：
   *  - 用 async `fs.promises.cp` 而不是 cpSync：整档案上万个文件，同步拷贝会把宿主事件循环卡住
   *    二十多秒（DSH 界面整个冻结）；async 版让拷贝期间服务器仍能响应其它请求；
   *  - `verbatimSymlinks: true`：保持相对符号链接仍是相对（副本内自解），而不是被解析成指向源档案的
   *    绝对路径；但 **cp 不会展开 junction**（实测：cpSync 会、promises.cp 不会）—— 它留下的是指向
   *    **源档案**的链接，所以复制后必须跑一遍 `relinkCopiedTree` 把「指向源档案内部」的链接重指向副本自身
   *    （否则用户删掉源档案，副本就会缺包）；指向源档案**之外**的链接（如 `link:` 依赖指向用户仓库）
   *    一律原样保留 —— 那本来就是「共享外部目录」的语义；
   *  - 链接重指向只碰链接本身（unlink + 重建 junction，不需要管理员权限）：实测副本 285 MB / 1.7 万条目里
   *    只有 48 个链接，且用 `readdir(withFileTypes)` 判链接无需逐条 lstat，代价可忽略；
   *  - includeNodeModules=false 时**同时跳过 node_modules 与 `.dsh-module-fallback`**：后者是 DSH 按
   *    node_modules 投影出来的派生目录，只搬它只会留下一堆悬空链接（DSH 启动时会自行重建）；
   *  - 其余顶层条目一律照搬（cordis.patch.yml / cordis.yml / pnpm-lock.yaml / 各种 .bak 备份都在里面）；
   *  - 中途失败**回滚目标目录**：留一个「看起来正常、实则缺文件」的半套档案比不复制更危险。
   */
  async copy(
    name: string,
    newName: string,
    opts: { includeNodeModules?: boolean } = {},
  ): Promise<{ meta: DshProfileMeta; warnings: DshProfileCopyWarning[]; durationMs: number }> {
    const reason = checkProfileName(newName)
    if (reason !== null) throw new DshProfileError(reason)
    const srcDir = this.requireProfile(name)
    const destDir = resolveProfileDir(this.homeDir, validateProfileName(newName))
    if (existsSync(destDir)) throw new DshProfileError('exists')
    const includeNodeModules = opts.includeNodeModules !== false
    const startedAt = Date.now()
    await mkdir(destDir, { recursive: true })
    // cross-F3：**先落标记再拷文件**。进程被强杀时标记留在目标目录里，使这个半截副本可被
    // 档案列表 / 恢复面板辨识并物理删除；不留标记的话它既不在列表里、删除又报 notFound。
    const marker: DshProfileCopyMarker = {
      sourceName: name,
      newName,
      startedAt: new Date().toISOString(),
      includeNodeModules,
      pid: process.pid,
    }
    atomicWriteFileSync(this.copyMarkerPath(destDir), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 })
    try {
      const entries = await readdir(srcDir, { withFileTypes: true })
      for (const entry of entries) {
        // node_modules 与 DSH 投影出来的 .dsh-module-fallback 同进同出（后者的链接都指向前者）
        if (!includeNodeModules && (entry.name === NODE_MODULES_DIR || entry.name === MODULE_FALLBACK_DIR)) continue
        await cp(join(srcDir, entry.name), join(destDir, entry.name), {
          recursive: true, verbatimSymlinks: true, force: false, errorOnExist: false,
        })
      }
      await this.relinkCopiedTree(srcDir, destDir)
      const manifest = this.readManifestObject(destDir)
      if (manifest !== null) {
        manifest['name'] = `dsh-profile-${newName}`
        atomicWriteFileSync(join(destDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
      }
    } catch (error) {
      // 回滚失败 ≠ 放任孤儿：rollbackCopiedProfileDir 把标记留到最后，并在「目录还在、标记没了」时补写标记
      // —— 残留目录因此仍能被 listIncompleteCopies() 扫到，并能经 remove()（UI 的「删除残留副本」）删掉。
      try {
        await rollbackCopiedProfileDir(destDir, marker)
      } catch {
        // 连回滚入口都抛（理论上不会）：标记在写盘前就已落盘，用户仍可手动删掉这个半套目录
      }
      throw new DshProfileError('copyFailed', `copyFailed: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 复制成功：移除标记（此后它就是一个正常 profile）。删标记失败无害 —— 列表以 package.json 为准。
    try {
      rmSync(this.copyMarkerPath(destDir), { force: true })
    } catch {
      // 忽略：有 package.json 时列表不会把它当半截副本
    }
    const meta = this.readMeta(newName, destDir)
    // 没拷 node_modules 却声明了依赖 → 副本启动必然解析不到 bundle：显式告警，绝不静默
    const warnings: DshProfileCopyWarning[] = []
    if (!includeNodeModules && Object.keys(meta.dependencies).length > 0) warnings.push('depsNotInstalled')
    return { meta, warnings, durationMs: Date.now() - startedAt }
  }

  /** 重命名（目录级移动；同步修正 package.json 的 name 字段）。 */
  rename(name: string, newName: string): DshProfileMeta {
    // Desktop 独占档案：改名 = 桌面端下次启动时找不到自己的档案（它会按 web 模板重建一个空的，
    // 已装插件全部消失），而普通 dsh CLI 连 --profile desktop 都拒绝。直接拒绝并说明原因。
    if (isManagedProfileName(name)) throw new DshProfileError('managedProfile')
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
    return this.readMeta(newName, to)
  }

  /**
   * 把副本里「指向源档案内部」的链接重指向副本自身的对应路径。
   *
   * 为什么必须做：`fs.promises.cp` 把 junction 当链接照抄（目标仍是源档案的绝对路径）—— 源档案一旦被删，
   * 副本就会缺包（实测：拷完删掉源档案，副本 node_modules 里被链接的包直接 ENOENT）。指向源档案之外的
   * 链接（`link:` 依赖指向用户仓库、DSH 从安装目录投影出来的 fallback）保持原样：那是共享语义，不是缺陷。
   */
  private async relinkCopiedTree(srcRoot: string, destRoot: string): Promise<void> {
    const pending: string[] = [destRoot]
    while (pending.length > 0) {
      const dir = pending.pop() as string
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        // juction/符号链接在 readdir 里就是 isSymbolicLink()（Windows 亦然）→ 无需逐条 lstat
        if (entry.isSymbolicLink()) {
          await this.relinkCopiedEntry(path, srcRoot, destRoot)
          continue
        }
        if (entry.isDirectory()) pending.push(path)
      }
    }
  }

  /** 单个链接的重指向（失败保持原样：源档案还在时仍旧可用，不让整次复制失败）。 */
  private async relinkCopiedEntry(linkPath: string, srcRoot: string, destRoot: string): Promise<void> {
    let rawTarget: string
    try {
      rawTarget = await readlink(linkPath)
    } catch {
      return
    }
    // junction 的 readlink 带 \\?\ 前缀；相对链接按其所在目录解析
    const target = rawTarget.startsWith('\\\\?\\') ? rawTarget.slice(4) : rawTarget
    const resolved = isAbsolute(target) ? target : resolve(dirname(linkPath), target)
    if (!isInsideDir(srcRoot, resolved)) return
    const mapped = join(destRoot, relative(srcRoot, resolved))
    try {
      const isDirectory = (await stat(linkPath)).isDirectory()
      await unlink(linkPath)
      if (isDirectory) await symlink(mapped, linkPath, 'junction')
      else await copyFile(mapped, linkPath)
    } catch {
      // 目标读不到 / 重指向失败：保持这个链接原样（绝不因为一个链接让整次复制失败）
    }
  }

  /**
   * 物理删除 profile 目录（rmSync recursive；目录内 junction 只删链接本身）。
   * 当前运行中的 profile 需要 allowCurrent=true 显式确认（删除会让重启后的实例直接失败）。
   *
   * Desktop 独占档案（desktop）**一律拒绝**（连 allowCurrent 也不行）：它由桌面端应用自己
   * 初始化与维护，删掉之后桌面端要么起不来、要么按 web 模板重建一个空档案（插件全丢）。
   *
   * cross-F3：**中断的复制残留**（有进行中标记、无 package.json）也接受删除 —— 它此前既不在
   * `list()` 里、`requireProfile` 又报 notFound，成了「查不到也删不掉」的孤儿目录。
   */
  remove(name: string, opts: { allowCurrent?: boolean } = {}): void {
    if (isManagedProfileName(name)) throw new DshProfileError('managedProfile')
    const dir = this.requireManagedDir(name)
    if (name === this.currentProfile() && opts.allowCurrent !== true) {
      throw new DshProfileError('currentProfile')
    }
    rmSync(dir, { recursive: true, force: true })
  }

  /**
   * cross-F3：目标目录 = **正常 profile（有 package.json）** 或 **中断的复制残留（有进行中标记）**；
   * 两者都没有 → notFound。残余标记的目录必须能被定位与删除，否则就是孤儿。
   */
  private requireManagedDir(name: string): string {
    let dir: string
    try {
      dir = resolveProfileDir(this.homeDir, validateProfileName(name))
    } catch {
      throw new DshProfileError('invalidName')
    }
    if (existsSync(join(dir, 'package.json'))) return dir
    if (this.readCopyMarker(dir).present) return dir
    throw new DshProfileError('notFound')
  }

  /** 复制进行中标记的路径。 */
  private copyMarkerPath(dir: string): string {
    return join(dir, PROFILE_COPY_MARKER_FILENAME)
  }

  /**
   * 读「复制进行中标记」。**只判存在性**：内容坏掉（手工改过 / 写盘中断）仍算半截副本 ——
   * 宁可多报一个可疑残留，也绝不把孤儿目录重新变成「查不到也删不掉」。
   */
  private readCopyMarker(dir: string): { present: boolean; marker: DshProfileCopyMarker | null } {
    const markerPath = this.copyMarkerPath(dir)
    if (!existsSync(markerPath)) return { present: false, marker: null }
    const raw = readTextSafe(markerPath)
    if (raw === null) return { present: true, marker: null }
    try {
      const parsed = JSON.parse(raw) as Partial<DshProfileCopyMarker>
      return {
        present: true,
        marker: {
          sourceName: typeof parsed.sourceName === 'string' ? parsed.sourceName : '',
          newName: typeof parsed.newName === 'string' ? parsed.newName : '',
          startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
          includeNodeModules: parsed.includeNodeModules === true,
          pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
        },
      }
    } catch {
      return { present: true, marker: null }
    }
  }

  /**
   * cross-F3：把「中断的复制残留」渲染成一个可列出、可删除的条目。
   *
   * 形态恒为 `generic` ⇒ `isLaunchableShape('generic')` 为假：半截副本**绝不能**给出启动按钮
   * （没有 package.json，spawn 出去只会得到一个起不来的实例）。
   */
  private incompleteMeta(
    name: string,
    dir: string,
    marker: { present: boolean; marker: DshProfileCopyMarker | null },
  ): DshProfileMeta {
    let updatedAtMs: number | null = null
    try {
      updatedAtMs = statSync(dir).mtimeMs
    } catch {
      updatedAtMs = null
    }
    const known = marker.marker
    return {
      name,
      dir,
      bundles: [],
      dependencies: {},
      shape: 'generic',
      patchReload: 'startup',
      hasNodeModules: existsSync(join(dir, NODE_MODULES_DIR)),
      patchEntryCount: 0,
      patchBytes: 0,
      isCurrent: false,
      issues: [],
      updatedAtMs,
      incomplete: true,
      ...(known !== null && known.sourceName !== '' ? { copiedFrom: known.sourceName } : {}),
      ...(known !== null && known.startedAt !== '' ? { copyStartedAt: known.startedAt } : {}),
    }
  }

  /**
   * cross-F3：列出全部**中断的档案复制**残留（有标记、无 package.json），含目标绝对路径。
   *
   * 与 `list()` 共用同一份判定（标记存在即残留），避免「列表说没有、这里说有」的分叉；
   * 档案列表消费 `list()` 里的 `incomplete` 条目，恢复面板消费本方法。
   */
  listIncompleteCopies(): DshProfileIncompleteCopy[] {
    return this.listIncompleteCopiesScan().copies
  }

  /**
   * t89（FINAL-SWEEP-2 S2-3）：与 `listIncompleteCopies()` **同源**的枚举结果，额外区分
   * 「枚举失败」与「确实没有残留」。
   *
   * 此前读目录失败直接回落 `[]`（t54 的**有意**选择：残留枚举失败不得让 /recovery/status 整页 500），
   * 但调用方因此无法把「读不到」与「没有」分开 —— 而更深的 `markerReadable` 已经诚实过一次，
   * 说明本仓库口径本应区分这两者。本方法保持**不抛**（t54 口径不变），只把失败这一事实交给调用方。
   *
   * 判据只有一条：`readdirSync` 失败 = unreadable。根目录**本来不存在**（`!existsSync`）不算失败 ——
   * 那是「新装机器还没有 profiles 目录」，与「读不动」是两件事。
   */
  listIncompleteCopiesScan(): DshProfileIncompleteCopiesScan {
    const root = this.profilesRoot()
    if (!existsSync(root)) return { copies: [], unreadable: false, reason: null }
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return { copies: [], unreadable: true, reason: PROFILES_ROOT_UNREADABLE }
    }
    const out: DshProfileIncompleteCopy[] = []
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const dir = join(root, entry.name)
      if (!this.isProfileDir(dir, entry.isDirectory(), entry.isSymbolicLink())) continue
      if (existsSync(join(dir, 'package.json'))) continue
      const marker = this.readCopyMarker(dir)
      if (!marker.present) continue
      const known = marker.marker
      out.push({
        name: entry.name,
        dir,
        sourceName: known !== null && known.sourceName !== '' ? known.sourceName : null,
        startedAt: known !== null && known.startedAt !== '' ? known.startedAt : null,
        markerReadable: known !== null,
      })
    }
    return { copies: out.sort((a, b) => a.name.localeCompare(b.name)), unreadable: false, reason: null }
  }

  /** 解析 profile 目录（不存在 → notFound；**只认正常 profile**，半截副本走 requireManagedDir）。 */
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
  /** 该档案依赖树里的 `@deepseek-ai/dsh` 版本；读不到/不是非空字符串 → null。 */
  private readProfileDshVersion(modulesDir: string): string | null {
    const raw = readTextSafe(join(modulesDir, '@deepseek-ai', 'dsh', 'package.json'))
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      const version = isRecord(parsed) ? parsed['version'] : undefined
      return typeof version === 'string' && version !== '' ? version : null
    } catch {
      return null
    }
  }

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
    // 版本信息 best-effort：读不到就是 null（桌面端档案的运行时在 app.asar 内，磁盘上没有它）。
    const modulesDir = join(dir, NODE_MODULES_DIR)
    // 档案自己的 dsh 版本同时用于在 pnpm store 的多个 dsh-session 之间挑同版本者（issue #74）；
    // 版本读不出来且多于一个候选 → 放弃（不猜，宁可显示 null）。
    const dshVersion = this.readProfileDshVersion(modulesDir)
    return {
      name,
      dir,
      bundles,
      dependencies,
      dshVersion,
      sessionFormatVersion: readSessionFormatVersionInTree(modulesDir, dshVersion ?? undefined) ?? null,
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
