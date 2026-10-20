/**
 * dsh plugin CLI 通道（方案A 主机侧实现，M1）。
 *
 * 本模块是唯一的子进程启动点：把「安装 / 更新 profile 插件」转成官方
 * `dsh plugin --profile <name> <args…>` 调用（dsh CLI 内部转发 pnpm，并在
 * 成功后 reconcile dsh.profile.bundles），以及从 profile 文件实时读取已装
 * 插件清单（不依赖 web 专用 pluginMarketplace / pluginInventory 服务）。
 *
 * 设计对齐：
 *  - dsh 官方实现 @deepseek-ai/dsh/lib/plugin-*.js（runPlugin / reconcilePlugins /
 *    exportsPatch 的 bundle 判定语义）；
 *  - dshmarket src/dsh-cli.ts（dshArgv / spawnShim / killTree / spawnEnv）与
 *    src/profile.ts（readInstalled / readInstalledVersion / hasDshManifest）。
 *
 * 只依赖 node 内置模块，零 DSH 运行时依赖（M5 的 TDD 可直接单测本模块）。
 */

import { engineMsg } from './messages-core.ts'
import { isConcreteVersion } from './validator.ts';
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { atomicWriteFileSync } from '../utils/atomic-write.ts'
import { isDesktopProfile, resolveDesktopCarrier } from '../utils/desktop-carrier.ts'
import { isRescueActiveSync } from './boot-rescue.ts'
import type { PluginInfo } from './types.ts'

/* ------------------------------------------------------------ profile 文件 */

/**
 * dsh 出厂自带的 in-box bundle（profile 模板自身安装的层）：唯一从「已装
 * 插件清单」中隐藏的名字。社区插件可以合法地发布在官方 scope 下，因此不能
 * 按 scope 整段过滤（dshmarket #28 的结论）。
 */
export const INBOX_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
])

/**
 * profile 名合法性校验，与 dsh-app-boot 的 resolveProfileDir 一致：拒绝空名、
 * 路径分隔符与保留名，防止 join(home, 'profiles', name) 越界。
 */
export function validateProfileName(profile: string): string {
  if (
    profile === ''
    || profile.includes('/') || profile.includes('\\')
    || profile === '.' || profile === '..' || profile === 'node_modules'
  ) {
    throw new Error(`invalid profile name ${JSON.stringify(profile)}`)
  }
  return profile
}

/** Profile 目录：$DSH_HOME/profiles/<name>（homeDir 由宿主 resolveDshHome() 解析）。 */
export function resolveProfileDir(homeDir: string, profile: string): string {
  return join(homeDir, 'profiles', validateProfileName(profile))
}

/**
 * `--profile <name>` 的合法取值（同时支持 `--profile <name>` 与 `--profile=<name>`）；
 * 没给 / 缺值 / 值以 '-' 开头 / 校验非法 → null（宽容语义，绝不抛错）。
 * argv 参数化便于测试；缺省读当前进程 argv。
 */
export function profileNameFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === undefined) continue
    let value: string | undefined
    if (token === '--profile') value = argv[i + 1]
    else if (token.startsWith('--profile=')) value = token.slice('--profile='.length)
    else continue
    if (value === undefined || value === '' || value.startsWith('-')) return null
    try {
      return validateProfileName(value)
    } catch {
      return null
    }
  }
  return null
}

/**
 * 从 profile 目录的绝对路径取叶子名（`profileContext.dir` / `DSH_PROFILE_DIR`）：
 * 两种分隔符都切（POSIX 上也可能拿到 Windows 形态路径），取不到 / 非法 → null。
 */
export function profileNameFromDir(dir: string): string | null {
  const leaf = dir.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  if (leaf === '') return null
  try {
    return validateProfileName(leaf)
  } catch {
    return null
  }
}

/**
 * 从宿主 `profileContext` 服务的值里取 profile 名（issue #52）。
 *
 * DSH ≥ 0.1.7 在 boot 时 `hostCtx.provide('profileContext', { name, dir, patchPath, … })`
 * （取证：0.1.7-rc.2 / 0.2.0-rc.1 的 `@deepseek-ai/dsh` 中 profile-boot 的 provide 调用），
 * 这是「真正启动了哪个档案」的**唯一权威**：DSH Desktop（Electron 外壳）拉起宿主时
 * **不传 `--profile`**（只在 Electron 层把 projectDir / profileContext 交给宿主），
 * 只认 argv 会把 desktop 档案认成 'web'，于是插件清单来源、档案页「当前运行」标记、
 * 备份/导出/恢复目标全部落到 profiles/web。
 *
 * 纯函数便于单测：`name` 缺失/非法时退到 `dir` 的叶子名；两者都取不到 → null
 * （调用方继续回退到 --profile / 环境变量 / web）。
 */
export function profileNameFromProfileContext(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const fields = value as { name?: unknown; dir?: unknown }
  if (typeof fields.name === 'string' && fields.name.trim() !== '') {
    try {
      return validateProfileName(fields.name.trim())
    } catch {
      // name 非法 → 继续尝试 dir（DSH 的消费点是 profile.dir，见 app-boot 的 preflight）
    }
  }
  return typeof fields.dir === 'string' ? profileNameFromDir(fields.dir) : null
}

/**
 * 从宿主 `profileContext` 取**当前运行时的安装锚点**（issue #桌面端兼容）：
 * `installAnchor` 是 **拉起本宿主那份** `@deepseek-ai/dsh/package.json` 的绝对路径
 * （dsh 的 profile-boot 在 boot 时写进 profileContext；Desktop 传的是
 * `<app.asar>/dsh/node_modules/@deepseek-ai/dsh/package.json`）。
 *
 * 为什么必须用它：磁盘上 `<home>/profiles/node_modules/@deepseek-ai/dsh/package.json`
 * 是 web profile 装出来的 **hoisted 旧副本**（真机：Desktop 运行时 0.2.0-rc.2，该文件却是
 * 0.1.5-rc.1），只按磁盘猜会让「关于」页与备份 manifest 的 DSH 版本整个报错。
 * 取不到 / 非字符串 / 空串 → null（调用方继续按磁盘候选回退）。
 */
export function installAnchorFromProfileContext(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const anchor = (value as { installAnchor?: unknown }).installAnchor
  return typeof anchor === 'string' && anchor.trim() !== '' ? anchor.trim() : null
}

/**
 * 从进程环境解析 profile 名：`DSH_PROFILE`（名字）→ `DSH_PROFILE_DIR`（绝对目录，取叶子名）。
 * 由启动外壳注入；DSH 自身（0.1.5 / 0.1.7 / 0.2.0 全量扫描）**从不写这两个变量**，
 * 所以它只是 profileContext 之外的一道兜底。两条都读不到 / 非法 → null，绝不抛错。
 */
export function resolveProfileNameFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const direct = env.DSH_PROFILE
  if (typeof direct === 'string' && direct.trim() !== '') {
    try {
      return validateProfileName(direct.trim())
    } catch {
      // 值非法（空 / 含分隔符 / 保留名）→ 继续尝试 DSH_PROFILE_DIR
    }
  }
  const dir = env.DSH_PROFILE_DIR
  if (typeof dir === 'string' && dir.trim() !== '') return profileNameFromDir(dir)
  return null
}

/**
 * 进程侧 profile 名（不依赖 Cordis ctx）：`--profile` 启动参数 →
 * `DSH_PROFILE` / `DSH_PROFILE_DIR` 环境变量 → 'web'。
 * 宿主 apply 的真实优先级更高一层（config.profile → profileContext 服务），见 src/index.ts。
 */
export function resolveProcessProfileName(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return profileNameFromArgv(argv) ?? resolveProfileNameFromEnv(env) ?? 'web'
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

/** 读 profile package.json；不可读（未初始化 / 损坏）返回 null。 */
export function readProfileManifest(profileDir: string): ProfileManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ProfileManifest : null
  } catch {
    return null
  }
}

/** 写回 profile package.json（2 空格缩进 + 尾换行，与 dsh-app-boot 一致；原子写防半装损坏）。 */
export function writeProfileManifest(profileDir: string, manifest: ProfileManifest): void {
  atomicWriteFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
}

/** 真实已装的依赖（in-box bundles 过滤掉）：name → 声明的版本 spec。 */
export function readInstalled(profileDir: string): Record<string, string> {
  const manifest = readProfileManifest(profileDir)
  const installed: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest?.dependencies ?? {})) {
    if (!INBOX_BUNDLES.has(name)) installed[name] = spec
  }
  return installed
}

/** node_modules/<name>/package.json 里实际落盘的版本；未装 / 不可读为 null。 */
export function readInstalledVersion(profileDir: string, name: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  }
}

/** 包的 package.json 是否声明 dsh.bundle.patch（即它是一个 bundle / profile 层）。 */
export function hasDshBundlePatch(pkgDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: unknown } }
    }
    return manifest.dsh?.bundle?.patch !== undefined
  } catch {
    return false
  }
}

/**
 * 维护 dsh.profile.bundles 与已装依赖一致（语义对齐官方 plugin 命令的
 * reconcilePlugins，按「已装状态」而非依赖 diff 判定）：
 *  - 声明 dsh.bundle.patch 的依赖必须出现在 bundles（追加在依赖顺序尾部）；
 *  - bundles 中「曾是依赖、但不再是（移除或版本不再声明 patch）」的条目移出；
 *  - in-box bundles 不是依赖，永远不碰。
 * 仅在确有变化时写回 package.json。返回是否写回。
 */
export function reconcileBundles(profileDir: string): boolean {
  // 救援模式停手（硬约束，真机实测的失效点）：救援把 dsh.profile.bundles 收窄为
  // 「DSH 核心 + 本插件」，而本函数的第一条规则正是「把声明 dsh.bundle.patch 的依赖加回
  // bundles」—— 二者直接冲突。救援期间只要**读一次**插件清单（导出预览、自动快照的 plugins
  // 分区、插件页都会经 listInstalledPlugins 走这里），刚收窄的 bundles 就会被原样加回
  // （实测写入后约 1.5s），用户重启 DSH 后插件全部照常挂载 = 救援名存实亡。
  // 救援是操作者的显式决定：这段时间 bundle 清单归它所有，reconcile 一律不写盘。
  if (isRescueActiveForProfileDir(profileDir)) return false
  const manifest = readProfileManifest(profileDir)
  if (manifest === null) return false
  const dependencies = Object.keys(manifest.dependencies ?? {})
  const dependencySet = new Set(dependencies)
  const bundles = manifest.dsh?.profile?.bundles
  const plugins = Array.isArray(bundles) ? [...bundles] : []
  let changed = false

  for (const name of dependencies) {
    if (INBOX_BUNDLES.has(name)) continue
    const isBundle = hasDshBundlePatch(join(profileDir, 'node_modules', name))
    if (isBundle && !plugins.includes(name)) {
      plugins.push(name)
      changed = true
    }
  }
  for (const name of [...plugins]) {
    const wasDependency = dependencySet.has(name)
    const stillBundle = dependencySet.has(name) && hasDshBundlePatch(join(profileDir, 'node_modules', name))
    if (wasDependency && !stillBundle) {
      plugins.splice(plugins.indexOf(name), 1)
      changed = true
    }
  }
  if (!changed) return false
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: plugins },
  }
  writeProfileManifest(profileDir, manifest)
  return true
}

/**
 * profileDir（`<home>/profiles/<name>`）形状 → 救援状态探测；形状不符时保守返回 false
 * （宁可不拦，也不要把别人的目录误判成救援态——非该形状的调用方本来也不是救援场景）。
 */
function isRescueActiveForProfileDir(profileDir: string): boolean {
  const profile = basename(profileDir)
  const profilesRoot = dirname(profileDir)
  if (basename(profilesRoot) !== 'profiles') return false
  return isRescueActiveSync({ homeDir: dirname(profilesRoot), profile })
}

/**
 * 中止安装后清理半装状态（用户「跳过当前插件」）：移除 profile package.json 中的
 * 依赖行 + reconcile bundles + 删 node_modules/<pkg>。
 *
 * 目的：pnpm add 被中途 kill 后，package.json 可能已声明依赖但 node_modules 不完整，
 * 直接启动 DSH 会因缺包而失败。本函数把 manifest 恢复为「该插件未安装」的一致状态，
 * 消除「声明了依赖但没装全」的启动风险。pnpm-lock.yaml 不触碰（运行时不被读取，
 * 下次安装 pnpm 自行对齐）。尽力而为：任何失败不抛错，由调用方记录告警。
 */
export function cleanupAbortedInstall(profileDir: string, pkg: string): void {
  const manifest = readProfileManifest(profileDir)
  if (manifest !== null) {
    const deps = manifest.dependencies ?? {}
    if (Object.prototype.hasOwnProperty.call(deps, pkg)) {
      delete deps[pkg]
      manifest.dependencies = deps
      writeProfileManifest(profileDir, manifest)
    }
    // 若 pkg 曾是 bundle 成员且已非依赖 → 从 bundles 移除
    reconcileBundles(profileDir)
  }
  try {
    rmSync(join(profileDir, 'node_modules', pkg), { recursive: true, force: true })
  } catch {
    // 尽力而为：目录可能不存在或正被占用，忽略
  }
}

/** 实时读 profile 已装插件清单（先 reconcile bundles，再逐依赖取版本/bundle 属性）。 */
export function listInstalledPlugins(homeDir: string, profile: string): PluginInfo[] {
  const dir = resolveProfileDir(homeDir, profile)
  reconcileBundles(dir)
  const out: PluginInfo[] = []
  const installed = readInstalled(dir)
  for (const name of Object.keys(installed)) {
    const isBundle = hasDshBundlePatch(join(dir, 'node_modules', name))
    out.push({
      name,
      version: readInstalledVersion(dir, name) ?? '',
      // 文件视图无法区分 patch 行禁用：依赖即视为启用（与旧 marketplace 视图一致）。
      enabled: true,
      isBundle,
      // 直接依赖的 bundle 自己就是 profile 层；普通依赖不属于任何聚合 bundle。
      inBundles: isBundle ? [name] : [],
      // 声明依赖 spec 原样保留：github:/file:/link: 等非 registry 来源导入时按此安装。
      spec: installed[name],
    })
  }
  // issue #28：仅通过 `dsh.profile.bundles` 声明的层（不在 dependencies 里）此前**完全不可见**，
  // 于是「明明装了、备份里却是空的」。reconcileBundles 对这类条目是**保留**的（它的移除条件
  // 要求该名字曾是依赖），所以它们确实会被 DSH 挂载，清单来源必须与之一致。
  const manifest = readProfileManifest(dir)
  const declaredBundles = manifest?.dsh?.profile?.bundles
  for (const name of Array.isArray(declaredBundles) ? declaredBundles : []) {
    if (INBOX_BUNDLES.has(name)) continue
    if (Object.prototype.hasOwnProperty.call(installed, name)) continue // 已在依赖清单里
    const installedVersion = readInstalledVersion(dir, name) ?? ''
    out.push({
      name,
      version: installedVersion,
      enabled: true,
      isBundle: true,
      // 直接声明的层自己就是 profile 层
      inBundles: [name],
      // issue #95：无依赖声明 + **本 profile 也没有它的落盘副本** ⇒ 这个包只可能由 DSH 从自己的
      // 安装位置解析。导入端只能把它声明进目标机的 bundles，绝不按裸包名走 npm（那会把
      // dist-tag latest 的副本装进 profile，与 host 版本线脱节）。
      // 本地**有**落盘副本的手工层不在此列：那种层得靠安装通道才能在目标机上存在，保持旧行为。
      ...(installedVersion === '' ? { bundlesOnly: true } : {}),
    })
  }
  return out
}

/**
 * 「只在 `dsh.profile.bundles` 里声明、`dependencies` 里没有该包」的条目判定（issue #95）。
 *
 * 为什么要一个共享判据：导出端的显式字段（`bundlesOnly`）只存在于新备份；旧备份只能按形状
 * 推断——**有依赖 spec 的绝不是**（那是普通依赖，哪怕本机没装全）；**没有 spec 且读不到已装版本**
 * 的才是（本 profile 里没有任何东西提供它，DSH 只能从自己的安装位置解析，issue #95）。
 */
export function isBundlesOnlyEntry(entry: { bundlesOnly?: unknown; spec?: unknown; version?: unknown }): boolean {
  if (entry.bundlesOnly === true) return true
  if (entry.bundlesOnly !== undefined) return false
  const spec = typeof entry.spec === 'string' ? entry.spec : ''
  const version = typeof entry.version === 'string' ? entry.version : ''
  return spec === '' && version === ''
}

/**
 * 把 `name` 声明进 profile package.json 的 `dsh.profile.bundles`（issue #95）。
 *
 * 只做「追加一个名字」：其余字段逐字保留，重复声明返回 `changed: false`（幂等，不空写文件）。
 * 形状不可认（JSON 坏 / `dsh.profile` 非对象 / `bundles` 非字符串数组）→ 返回 null：
 * 调用方必须**如实报告**并放弃这次声明，绝不重建一份清单出来（那会抹掉 profile 的其它字段）。
 *
 * `bundles` 字段**缺省也拒绝**：DSH 的语义是「bundles 非空即替换默认插件栈」，凭空造一个只含
 * 一个名字的数组 = 悄悄改掉目标机的装配语义（应当由 DSH 自己写这个字段）。
 */
export function mergeBundleDeclaration(pkgText: string, name: string): { text: string; changed: boolean } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(pkgText)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const pkg = parsed as Record<string, unknown>
  const dsh = pkg.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return null
  const profile = (dsh as Record<string, unknown>).profile
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return null
  const raw = (profile as Record<string, unknown>).bundles
  if (raw === undefined) return null
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) return null
  const bundles = raw as string[]
  if (bundles.includes(name)) return { text: pkgText, changed: false }
  bundles.push(name)
  ;(profile as Record<string, unknown>).bundles = bundles
  return { text: `${JSON.stringify(pkg, null, 2)}\n`, changed: true }
}

/* --------------------------------------------------------------- CLI 通道 */

/** 15 分钟默认上限（慢网络 + git 安装），可用环境变量覆盖（CI/测试）。 */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_CONFIG_MANAGER_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * 非 registry 来源的依赖 spec 前缀：这些来源必须把 spec 原样交给 pnpm add，
 * 裸包名在 registry 上查不到（fetch-404 → 幽灵依赖拖垮整个 profile 的安装）。
 * registry 包由 `pluginInstallTarget()` 拼精确版本或「包名@spec」（issue #101）。
 */
const NON_REGISTRY_SPEC = /^(github:|gitlab:|bitbucket:|git\+|file:|link:|workspace:|https?:)/i

/** `pluginInstallTarget()` 的输入：全部来自备份里的 `PluginEntry`（都可缺省 = 旧备份）。 */
export interface PluginInstallTargetInput {
  /** 备份记录的实际安装版本（`PluginEntry.version`）：具体 semver 时精确安装到它（issue #101）。 */
  version?: string | undefined
  /** 备份记录的声明依赖 spec（`PluginEntry.spec`）：非 registry 来源原样，registry 区间带包名。 */
  spec?: string | undefined
  /** 备份内自带 tarball 解包后的绝对路径：优先于 spec（T1 本地源插件迁移）。 */
  tarballPath?: string | undefined
}

/**
 * 安装目标：可直接交给 `dsh plugin add` 的**完整参数**（issue #101）。
 *
 * 为什么不能只传裸包名：pnpm add 会尊重目标机 `package.json` 里既有的 spec —— 固定版不动、
 * 已经满足的区间也不动，于是「备份里记着 0.9.5、目标机装着 0.9.3」的升级会**空转却报成功**。
 * 规则按优先级排列（`src/core/plugin-cli.test.ts` 表驱动钉住）：
 *  ① 备份内 tarball → `file:<abs>`（换机后原绝对路径必然失效）；
 *  ② 非 registry 来源（github:/git+/file:/link:）→ spec 原样（裸包名在 registry 上查不到）；
 *  ③ `version` 是具体 semver → `<pkg>@<version>`（精确版本，pnpm 无法被既有 spec 挡住）；
 *  ④ 其余 spec（`^1.2.3` / dist-tag）→ `<pkg>@<spec>`（交给 pnpm 解析，至少不会退回裸包名）；
 *  ⑤ 什么都没有（旧备份 / 无版本记录）→ 裸包名（npm 最新版，改造前行为）。
 */
export function pluginInstallTarget(pkg: string, input: PluginInstallTargetInput = {}): string {
  const { version, spec, tarballPath } = input
  if (tarballPath !== undefined && tarballPath !== '') return `file:${tarballPath}`
  if (spec !== undefined && spec !== '' && NON_REGISTRY_SPEC.test(spec)) return spec
  if (version !== undefined && isConcreteVersion(version)) return `${pkg}@${version}`
  if (spec !== undefined && spec !== '') return `${pkg}@${spec}`
  return pkg
}

/** Windows 的 npm/corepack/pnpm/dsh 都是 .cmd 垫片：Node 直接 spawn 无法启动（ENOENT/EINVAL）。 */
const winCmdShim = process.platform === 'win32'

/**
 * 子进程环境：CI=true 让 pnpm v10+ 在无 TTY 时立即行动或失败，而不是卡在
 * 静默交互提示；macOS GUI 启动不继承 shell PATH，补上常见 bin 目录（dshmarket #32）。
 */
function spawnEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return { ...process.env, CI: 'true' }
  const parts = (process.env.PATH ?? '').split(':').filter((part) => part !== '')
  for (const bin of ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME ?? ''}/.local/bin`]) {
    if (bin !== '' && !parts.includes(bin)) parts.push(bin)
  }
  return { ...process.env, CI: 'true', PATH: parts.join(':') }
}

/** 一次 CLI 调用的启动描述（env 只在需要覆写子进程环境时出现）。 */
export interface DshCliArgv {
  file: string
  args: string[]
  cwd: string | undefined
  viaShell: boolean
  /** 额外/覆写的子进程环境（Desktop 载体需要 ELECTRON_RUN_AS_NODE=1）。 */
  env?: Readonly<Record<string, string>>
}

/**
 * 重放启动当前宿主进程的 dsh CLI：
 *  - **Desktop 保留档案（`--profile desktop`）**：普通 dsh CLI 会硬拒绝（见
 *    `utils/desktop-carrier.ts` 的说明），必须改用桌面端自带的 CLI 载体
 *    `@deepseek-ai/dsh-desktop-host/lib/cli.js`（它以 `manageDesktopProfile: true` 启动
 *    runCli，并用桌面端内置 runtime + 内置 pnpm）。检测不到载体时落回下面的通用路径，
 *    失败信息由 classifyDshPluginFailure 的 desktop-profile-reserved 分类给可操作说明；
 *  - process.argv[1] 是 dsh 入口（全局 bin / 源码启动的 bin.ts / bin.js）→ 用
 *    当前 Node 重新执行该入口（execArgv 原样保留，cwd 靠近入口保持相对导入可解析）；
 *  - 否则退回 PATH 上的 `dsh`（Windows 是 .cmd，需经 shell）。
 */
export function dshArgv(profile?: string, carrier: ReturnType<typeof resolveDesktopCarrier> = resolveDesktopCarrier()): DshCliArgv {
  if (profile !== undefined && isDesktopProfile(profile)) {
    if (carrier !== null) {
      return {
        file: carrier.execPath,
        args: [carrier.cliPath],
        cwd: dirname(carrier.cliPath),
        viaShell: false,
        env: carrier.env,
      }
    }
  }
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

/** cmd.exe 视为语法字符（即使在一个 token 内）。 */
const CMD_METACHARS = /[\s"&|<>^()%!]/

/** 为一个 argv token 构造 cmd.exe 命令行引用（需要引用的 token 用双引号包裹并加倍内部引号）。 */
export function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

/** 由 argv 构造 cmd.exe 命令行（仅 Windows 垫片路径使用）。 */
export function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

/** cmd.exe 解析结果（仅 Windows 垫片路径使用）。 */
const COMSPEC = process.env.ComSpec ?? 'cmd.exe'

type SpawnShimOptions = SpawnOptions & { viaShell?: boolean }

/**
 * 启动命令：Windows .cmd 垫片经 cmd.exe /d /s /c 显式构造的命令行（避开 Node
 * 弃用的 shell:true + argv 组合，DEP0190）；其余直接 shell:false 启动。
 */
function spawnShim(file: string, args: readonly string[], options: SpawnShimOptions): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell || process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  return spawn(COMSPEC, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

/**
 * 杀掉子进程整棵进程树：Windows 的 kill() 只终止包装进程、pnpm 子进程还活着，
 * 用 taskkill /T /F；POSIX 子进程独立进程组启动（detached），先 SIGTERM 组、
 * 5 秒后 SIGKILL 兜底。
 */
export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      return
    } catch {
      /* fall through to plain kill */
    }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/** 一次 dsh plugin 子进程调用的原始结果（M2 失败分类器的输入）。 */
export interface DshPluginResult {
  exitCode: number | null
  timedOut: boolean
  /** 经 AbortSignal 中止（用户跳过/取消）：进程树被 kill，非失败语义 */
  aborted?: boolean
  stdout: string
  stderr: string
  /** spawn 自身失败（如 ENOENT）；此时 exitCode 固定为 127。 */
  spawnError?: string
}

/**
 * 运行 `dsh plugin --profile <profile> <pluginArgs…>`：
 * cwd=profile 目录、CI 环境、windowsHide、pipe 输出、15 分钟超时杀进程树。
 * 永远 resolve（不 throw），由调用方判定成败。
 *
 * signal：可选 AbortSignal。中止时立即 killTree 杀掉整棵进程树（dsh 包装 + pnpm 孙进程），
 * 结果标记 aborted=true（调用方据此判定「用户跳过/取消」，而非失败）。
 */
export function runDshPlugin(
  profileDir: string,
  profile: string,
  pluginArgs: readonly string[],
  timeoutMs: number = INSTALL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DshPluginResult> {
  const { file, args, viaShell, env: argvEnv } = dshArgv(profile)
  return new Promise((resolvePromise) => {
    const child = spawnShim(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd: profileDir,
      // argvEnv 覆盖 spawnEnv：Desktop 载体子进程必须带 ELECTRON_RUN_AS_NODE=1
      env: { ...spawnEnv(), ...argvEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      viaShell,
      // POSIX 下独立进程组，超时/取消可一次杀掉 dsh 包装进程 + pnpm 孙进程。
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      clearTimeout(timer)
      killTree(child)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-256 * 1024)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ exitCode: 127, timedOut: false, aborted, stdout, stderr, spawnError: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolvePromise({ exitCode: code, timedOut, aborted, stdout, stderr })
    })
  })
}

/* ------------------------------------------------------------ 失败分类（M2） */

/**
 * 已识别的 pnpm/dsh CLI 失败模式（纯函数，可独立单测）。
 * 识别语义对齐 dshmarket src/pnpm-compat.ts：dsh 的包装行不提供原因，必须
 * 从 pnpm 的真实诊断文本里认。
 */
export type DshPluginFailureCode =
  | 'hoist-pattern-diff'      // node_modules 由不同 pnpm major 创建，默认配置漂移
  | 'adding-to-root'          // pnpm 拒绝在 workspace 根直接 add（缺 -w）
  | 'not-a-workspace'         // 传了 -w 但目录不是 workspace
  | 'release-age-violation'   // 刚发布版本触发 pnpm 的成熟度等待期
  | 'git-build-blocked'       // git 插件构建脚本被 allowBuilds 白名单拦截
  | 'fetch-404'               // 依赖在 registry 不存在（幽灵依赖 / 私有包）
  | 'transient-network'       // 瞬时网络故障（直接重试通常即可）
  | 'pnpm-missing'            // pnpm 不在 PATH（dsh 转发层报错）
  | 'patch-file-missing'      // patchedDependencies 指向的 patch 文件不存在（issue #35）
  | 'desktop-profile-reserved' // dashboard 保留档案：普通 dsh CLI 拒绝 --profile desktop（桌面端兼容）

export interface DshPluginFailure {
  code: DshPluginFailureCode
  /** 双语可操作消息（同一字符串内 zh / en）。 */
  message: string
  /** true = 按消息指示重跑（重建 / 直接重试）通常即可恢复；false = 需要人工动作。 */
  recoverable: boolean
}

/**
 * 瞬时网络故障判定：pnpm 的 5xx 拉取码、meta 拉取放弃、以及穿透 dsh 包装的
 * 原始 socket 错误。永久的形态（404、鉴权）刻意排除——重试只会加倍等坏消息。
 */
export function isTransientDshPluginFailure(output: string): boolean {
  return /ERR_PNPM_FETCH_5\d\d|ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout/i.test(output)
}

/**
 * 把一次失败的 dsh plugin 调用的合并输出映射到已知失败模式。
 * @param output - stdout+stderr 合并文本。
 * @returns 分类结果；未识别返回 null（调用方展示原始摘要）。
 */
export function classifyDshPluginFailure(output: string): DshPluginFailure | null {
  if (output.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
    return {
      code: 'hoist-pattern-diff',
      recoverable: true,
      message: engineMsg('core.pluginCli.hoistPatternDiff'),
    }
  }
  if (output.includes('ERR_PNPM_ADDING_TO_ROOT')) {
    return {
      code: 'adding-to-root',
      recoverable: true,
      message: engineMsg('core.pluginCli.addingToRoot'),
    }
  }
  if (/--workspace-root may only be used inside a workspace/i.test(output)) {
    return {
      code: 'not-a-workspace',
      recoverable: false,
      message: engineMsg('core.pluginCli.notAWorkspace'),
    }
  }
  if (output.includes('ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION') || output.includes('ERR_PNPM_NO_MATURE_MATCHING_VERSION')) {
    return {
      code: 'release-age-violation',
      recoverable: true,
      message: engineMsg('core.pluginCli.releaseAgeViolation'),
    }
  }
  if (output.includes('ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED') || /git-hosted package "[^"]+" needs to execute build scripts/i.test(output)) {
    return {
      code: 'git-build-blocked',
      recoverable: false,
      message: engineMsg('core.pluginCli.gitBuildBlocked'),
    }
  }
  // issue #35：pnpm-workspace.yaml 的 patchedDependencies 指向不存在的 patch 文件时，
  // pnpm 会在**任何** add 上失败（含与补丁无关的插件）。此时逐条报「插件装不上」是误导——
  // 真正要修的是缺失的 patch 文件或那条声明。
  if (/Failed to read patch file|patch file .*does not exist/i.test(output)) {
    // 路径可能含盘符冒号（C:\...），故按整行取、再切掉尾随的 ':' 或 ': <错误文本>'
    const raw = /Failed to read patch file\s+([^\r\n]+)/i.exec(output)?.[1]?.trim()
    const file = raw === undefined ? undefined : raw.split(/:\s/)[0]?.replace(/:\s*$/, '').trim()
    const patchSuffix = file === undefined ? '' : engineMsg('core.pluginCli.parenValue', { value: file })
    return {
      code: 'patch-file-missing',
      recoverable: false,
      message: engineMsg('core.pluginCli.patchFileMissing', { patch: patchSuffix }),
    }
  }
  if (output.includes('ERR_PNPM_FETCH_404')) {
    const pkg = /GET\s+\S*\/([^/\s]+):/.exec(output)?.[1]?.replace(/%2[Ff]/g, '/')
    const pkgSuffix = pkg === undefined ? '' : engineMsg('core.pluginCli.parenValue', { value: pkg })
    return {
      code: 'fetch-404',
      recoverable: false,
      message: engineMsg('core.pluginCli.fetch404', { pkg: pkgSuffix }),
    }
  }
  if (isTransientDshPluginFailure(output)) {
    return {
      code: 'transient-network',
      recoverable: true,
      message: engineMsg('core.pluginCli.transientNetwork'),
    }
  }
  // 桌面端保留档案：普通 dsh CLI（< 0.2 的旧版尤其）对 `--profile desktop` 直接报
  // 'profile "desktop" is managed exclusively by the Electron application' 并且**什么都不做**。
  // 正常情况下宿主已经是 Desktop（走 dsh-desktop-host/lib/cli.js 载体），命中这里说明载体检测
  // 失败（例如插件在普通 dsh web 里运行、却把安装目标指到了 desktop 档案）。给可操作说明。
  if (/profile\s+"desktop"\s+is managed exclusively by the Electron application/i.test(output)) {
    return {
      code: 'desktop-profile-reserved',
      recoverable: false,
      message: engineMsg('core.pluginCli.desktopProfileReserved'),
    }
  }
  if (output.includes('pnpm not found on PATH')) {
    return {
      code: 'pnpm-missing',
      recoverable: false,
      message: engineMsg('core.pluginCli.pnpmMissing'),
    }
  }
  return null
}

/** 安装失败 → 分类后的双语可读 Error；未识别则保留 stderr 尾部摘要。 */
export function installErrorFor(pkg: string, result: DshPluginResult): Error {
  if (result.spawnError !== undefined && /ENOENT|EINVAL/.test(result.spawnError)) {
    return new Error(engineMsg('core.pluginCli.dshCliStartFailed', { spawnError: result.spawnError, pkg }))
  }
  if (result.timedOut) {
    return new Error(engineMsg('core.pluginCli.installTimeout', { pkg }))
  }
  const output = `${result.stderr}\n${result.stdout}`
  const failure = classifyDshPluginFailure(output)
  if (failure !== null) {
    return new Error(engineMsg('core.pluginCli.installFailed', { pkg, code: failure.code, message: failure.message }))
  }
  const tail = (result.stderr.trim().split('\n').slice(-8).join('\n')
    || result.stdout.trim().split('\n').slice(-8).join('\n')
    || engineMsg('core.pluginCli.noOutput'))
  return new Error(engineMsg('core.pluginCli.installFailedWithTail', { pkg, exitCode: String(result.exitCode), tail }))
}
