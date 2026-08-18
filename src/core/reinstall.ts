/**
 * dsh-config-manager reinstall — 一键重装 DSH 程序（跨平台）。
 *
 * 场景：DSH 配置损坏 / 无法启动时，用户可用本命令迅速重装 `@deepseek-ai/dsh`
 * 启动器（连同可选清理），装好后启动 GUI 插件，再同步远程仓库中的快照恢复配置。
 *
 * 设计要点：
 *  - 纯 Node，零新增依赖；命令执行（child_process）由调用方注入，便于 TDD。
 *  - 动作按类别组织，CLI 层据此做交互式多选：
 *      program   重装 DSH 程序本体（卸载 -g + 清全局残留 + 重装 -g + 验证）
 *      cache     清理全局残留缓存（pnpm store / npm cache）
 *      settings  清空 ~/.dsh 设置（settings.yaml 等）
 *      plugins   清空 profile 已装插件依赖
 *      data      清空会话记录与凭据（最高风险，CLI 层强制二次确认）
 *  - 跨平台：npm 子命令（uninstall/install/cache clean）本身跨平台；目录删除用
 *    平台对应命令（Windows PowerShell `Remove-Item` / Unix `rm -rf`）；路径用
 *    node:os / process.env 动态解析，绝不硬编码机器路径。
 *  - 平台可注入：`isWindows(platform)` 与各命令构建器接受可选的 `platform`
 *    参数（缺省 process.platform），便于在任意宿主上测试 Windows / Unix 两套输出。
 *  - `NS` = 一律不删快照目录（snapshots/）：它是恢复的最后依靠，除非用户将来
 *    显式亮出独立开关删除。
 */

import os from 'node:os'
import path from 'node:path'

/* ------------------------------------------------------------ 类别定义 */

export type ReinstallItemId = 'program' | 'cache' | 'settings' | 'plugins' | 'data'

export interface ReinstallItemDef {
  id: ReinstallItemId
  /** 中文名（CLI 交互清单 / 日志用） */
  label: string
  /** 一句话影响说明（交互选择时展示） */
  desc: string
  /** 是否触及用户数据（即是否属于"清空 ~/.dsh"危险面，需二次确认） */
  destructive: boolean
  /** 是否默认勾选（program / cache 默认；数据类默认不勾） */
  defaultOn: boolean
}

export const REINSTALL_ITEMS: readonly ReinstallItemDef[] = [
  {
    id: 'program',
    label: 'DSH 程序本体',
    desc: '卸载并重装 @deepseek-ai/dsh 全局启动器（核心动作）',
    destructive: false,
    defaultOn: true,
  },
  {
    id: 'cache',
    label: '全局残留缓存',
    desc: '清 pnpm store 与 npm cache（可选）',
    destructive: false,
    defaultOn: true,
  },
  {
    id: 'settings',
    label: '~/.dsh 设置',
    desc: '清空 settings.yaml 等配置（不可逆）',
    destructive: true,
    defaultOn: false,
  },
  {
    id: 'plugins',
    label: '~/.dsh 已装插件',
    desc: '清空 profiles 下已装插件依赖（不可逆）',
    destructive: true,
    defaultOn: false,
  },
  {
    id: 'data',
    label: '会话记录与凭据',
    desc: '清空 sessions 会话与 .credentials.yaml 凭据（最高风险，强制二次确认）',
    destructive: true,
    defaultOn: false,
  },
]

export type ReinstallSelection = ReadonlySet<ReinstallItemId>

/* ------------------------------------------------------------ 跨平台命令 */

/**
 * 当前是否 Windows。platform 可注入以便测试 Unix 分支。
 */
export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/** 当前用户主目录。 */
export function resolveHomeDir(env: Record<string, string | undefined> = process.env): string {
  return os.homedir()
}

/** DSH 数据主目录：$DSH_HOME 优先，缺省 ~/.dsh（与 CLI resolveDshHome 一致）。 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return path.join(resolveHomeDir(env), '.dsh')
}

/** 全局 npm root（node_modules 所在目录）：`npm root -g`。 */
export function resolveNpmGlobalRoot(
  exec: (cmd: string) => Promise<string>,
): Promise<string> {
  return exec('npm root -g').then((s) => s.trim())
}

/** 全局 pnpm 缓存/存储目录：优先 $PNPM_STORE_PATH，其次 $LOCALAPPDATA/pnpm/store（Win）或 ~/.local/share/pnpm/store（Unix）。 */
export function resolvePnpmStoreDir(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const explicit = env.PNPM_STORE_PATH
  if (explicit !== undefined && explicit !== '') return explicit
  const home = resolveHomeDir(env)
  if (isWindows(platform)) {
    const local = env.LOCALAPPDATA
    if (local !== undefined && local !== '') return path.join(local, 'pnpm', 'store')
    return null
  }
  return path.join(home, '.local', 'share', 'pnpm', 'store')
}

/**
 * POSIX / sh 单引号逃逸：路径含单引号时按 `'...'\''...'` 拼接。
 * 用于 Unix 命令（rm -rf / cp -r）。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * PowerShell 单引号逃逸：内嵌单引号用 `''` 翻倍（PowerShell 语法），
 * 用于 Windows 命令（Remove-Item / Copy-Item）。
 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, `''`)}'`
}

/**
 * 目录删除命令（平台差异）：Windows → PowerShell `Remove-Item -Recurse -Force`；
 * Unix → `rm -rf`。路径已做对应 shell 安全逃逸。
 */
export function rmCommand(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = isWindows(platform) ? psQuote(dir) : shellQuote(dir)
  if (isWindows(platform)) {
    return `Remove-Item -Recurse -Force ${target} -ErrorAction SilentlyContinue`
  }
  return `rm -rf ${target}`
}

/**
 * 复制目录（Windows 用 Copy-Item / Unix 用 cp -r）。为避免残留旧备份，
 * 先删除目标再复制。
 */
export function copyDirCommand(
  src: string,
  dest: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const s = isWindows(platform) ? psQuote(src) : shellQuote(src)
  const d = isWindows(platform) ? psQuote(dest) : shellQuote(dest)
  if (isWindows(platform)) {
    return `Remove-Item -Recurse -Force ${d} -ErrorAction SilentlyContinue; Copy-Item -Recurse ${s} ${d} -ErrorAction SilentlyContinue`
  }
  return `rm -rf ${d}; cp -r ${s} ${d} 2>/dev/null; true`
}

/* ------------------------------------------------------------ 计划 */

export interface ReinstallStep {
  /** 步骤中文描述（日志 / dry-run 展示） */
  label: string
  /** 实际执行的 shell 命令；dry-run 时不执行 */
  command: string
  /** 是否属于危险（触及 ~/.dsh 数据）动作 */
  dangerous: boolean
}

export interface ReinstallPlan {
  /** 目标 DSH 版本（'latest' 表示最新版） */
  version: string
  steps: ReinstallStep[]
  /** 是否涉及清空 ~/.dsh 数据（settings/plugins/data 任一勾选即 true） */
  wipeConfig: boolean
}

/**
 * 生成重装计划。exec 用于实时解析 npm root 等路径；plan 生成完成后，
 * 执行由调用方逐条跑 `exec(step.command)`（dry-run 则不跑）。
 *
 * @param selection 已选类别集合
 * @param version   DSH 版本号（空或 'latest' → latest）
 * @param exec      命令执行器（解析 npm 路径用；纯测试可注入假实现）
 * @param env       环境变量（home / DSH_HOME / pnpm 路径）
 * @param platform  平台判定（缺省 process.platform；测试可注入）
 */
export async function buildReinstallPlan(
  selection: ReinstallSelection,
  version: string,
  exec: (cmd: string) => Promise<string>,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ReinstallPlan> {
  const steps: ReinstallStep[] = []
  const dshHome = resolveDshHome(env)
  const versionSpec = version === '' || version === 'latest' ? 'latest' : version

  if (selection.has('program')) {
    const globalRoot = await resolveNpmGlobalRoot(exec)
    const dshGlobalDir = path.join(globalRoot, '@deepseek-ai', 'dsh')
    steps.push({
      label: '卸载全局 @deepseek-ai/dsh',
      command: 'npm uninstall -g @deepseek-ai/dsh',
      dangerous: false,
    })
    steps.push({
      label: '清理全局残留 @deepseek-ai/dsh',
      command: rmCommand(dshGlobalDir, platform),
      dangerous: false,
    })
    steps.push({
      label: `安装全局 @deepseek-ai/dsh@${versionSpec}`,
      command: `npm install -g @deepseek-ai/dsh@${versionSpec}`,
      dangerous: false,
    })
    steps.push({
      label: '验证版本（dsh --version）',
      command: 'dsh --version',
      dangerous: false,
    })
  }

  if (selection.has('cache')) {
    const pnpmStore = resolvePnpmStoreDir(env, platform)
    if (pnpmStore !== null) {
      steps.push({
        label: '清理 pnpm store',
        command: rmCommand(pnpmStore, platform),
        dangerous: false,
      })
    }
    steps.push({
      label: '清理 npm cache',
      command: 'npm cache clean --force',
      dangerous: false,
    })
  }

  const wipeConfig = selection.has('settings') || selection.has('plugins') || selection.has('data')

  // 删除 ~/.dsh 数据前先做一次同级备份（snapshots/ 由设计保证从不动它，
  // 但历史会话/凭据在此备份，作为抢救兜底）。
  if (wipeConfig) {
    steps.push({
      label: '备份 ~/.dsh 到同级 .reinstall-backup（抢救兜底）',
      command: copyDirCommand(dshHome, `${dshHome}.reinstall-backup`, platform),
      dangerous: true,
    })
  }
  if (selection.has('settings')) {
    steps.push({
      label: '清空 ~/.dsh 设置（settings.yaml 等）',
      command: rmCommand(path.join(dshHome, 'settings.yaml'), platform),
      dangerous: true,
    })
  }
  if (selection.has('plugins')) {
    steps.push({
      label: '清空 ~/.dsh 已装插件（profiles/*/node_modules）',
      command: rmCommand(path.join(dshHome, 'profiles'), platform),
      dangerous: true,
    })
  }
  if (selection.has('data')) {
    steps.push({
      label: '清空会话记录（sessions/）',
      command: rmCommand(path.join(dshHome, 'sessions'), platform),
      dangerous: true,
    })
    steps.push({
      label: '清空凭据（.credentials.yaml，仅删除文件）',
      command: rmCommand(path.join(dshHome, '.credentials.yaml'), platform),
      dangerous: true,
    })
  }

  return { version: versionSpec, steps, wipeConfig }
}
