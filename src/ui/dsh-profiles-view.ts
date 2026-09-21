/**
 * 「档案」页（DSH profile 管理）—— 框架无关纯函数层（node 可测）。
 *
 * 职责：名字输入校验、列表排序（当前/待切换置顶）、列表摘要统计、危险态判定、
 * 展示格式化（时间/字节）、重启命令文本。不产出用户可见散文（文案走 locale 字典 `t()`），
 * 不 import node 模块、不 import React。
 *
 * 依赖方向：只从 `src/profiles/dsh-profile-shared.ts`（零依赖）取类型与纯函数——
 * 绝不 import 用 node fs 的引擎（否则 client bundle 会带上 node 内置模块依赖而整插件不加载）。
 */
import {
  checkProfileName,
  type DshProfileIssue, type DshProfileMeta, type DshProfileSelection, type DshProfileShape,
} from '../profiles/dsh-profile-shared.ts'

/** 名称输入校验结果（UI 按码映射 i18n；null = 合法）。 */
export type ProfileNameIssue = 'required' | 'tooLong' | 'illegal' | 'reserved'

/** 校验输入框里的 profile 名：与 host 侧同规则，但把「空」与「过长」细分以便给出更准的提示。 */
export function validateProfileNameInput(name: string): ProfileNameIssue | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'required'
  if (trimmed.length > 64) return 'tooLong'
  const reason = checkProfileName(trimmed)
  if (reason === 'invalidNameInput') return 'illegal'
  if (reason === 'reservedName') return 'reserved'
  return null
}

/** 「下次启动」标记的界面语义。 */
export type ProfileSelectionState = 'none' | 'pending' | 'current' | 'missing'

export function selectionState(selection: DshProfileSelection | null): ProfileSelectionState {
  if (selection === null) return 'none'
  if (!selection.exists) return 'missing'
  return selection.isCurrent ? 'current' : 'pending'
}

/** 列表排序：当前运行中的置顶 → 待切换目标 → 其余按名字（localeCompare）。 */
export function sortProfilesForDisplay(
  profiles: readonly DshProfileMeta[],
  opts: { currentName?: string | null; selectionName?: string | null } = {},
): DshProfileMeta[] {
  const rank = (p: DshProfileMeta): number => {
    if (opts.currentName !== undefined && opts.currentName !== null && p.name === opts.currentName) return 0
    if (opts.selectionName !== undefined && opts.selectionName !== null && p.name === opts.selectionName) return 1
    return 2
  }
  return [...profiles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** 列表页顶部的概览统计（全部来自列表本身，无额外 IO）。 */
export interface ProfilesSummary {
  total: number
  web: number
  headless: number
  generic: number
  /** 有 issue 的档案数（如 package.json 损坏） */
  broken: number
  /** 已装 node_modules（有树外插件）的档案数 */
  withNodeModules: number
  /** patch 条目总数（启发式计数） */
  patchEntries: number
}

export function summarizeProfiles(profiles: readonly DshProfileMeta[]): ProfilesSummary {
  const summary: ProfilesSummary = { total: profiles.length, web: 0, headless: 0, generic: 0, broken: 0, withNodeModules: 0, patchEntries: 0 }
  for (const p of profiles) {
    summary[p.shape] += 1
    if (p.issues.length > 0) summary.broken += 1
    if (p.hasNodeModules) summary.withNodeModules += 1
    summary.patchEntries += p.patchEntryCount
  }
  return summary
}

/**
 * 列表行摘要事实：行内**只显示计数**（bundle 层数 / patch 条目 / 依赖数 / 是否装了 node_modules），
 * 完整清单（有序 bundle 层、逐条依赖）只在详情弹窗里展开——行内铺开整串包名会把行撑爆
 * （实测 web 档案 13 个包名把元信息挤成窄列）。
 */
export interface ProfileRowFacts {
  bundles: number
  patchEntries: number
  deps: number
  hasNodeModules: boolean
}

export function profileRowFacts(profile: DshProfileMeta): ProfileRowFacts {
  return {
    bundles: profile.bundles.length,
    patchEntries: profile.patchEntryCount,
    deps: Object.keys(profile.dependencies).length,
    hasNodeModules: profile.hasNodeModules,
  }
}

/** 详情弹窗：bundle 层（**保持声明顺序** —— 顺序就是 patch 应用顺序，不可排序）。 */
export function bundleLines(profile: DshProfileMeta): string[] {
  return [...profile.bundles]
}

/** 详情弹窗：依赖行（按包名排序，`<name> <spec>`；spec 为空时只给包名）。 */
export function dependencyLines(profile: DshProfileMeta): string[] {
  return Object.entries(profile.dependencies)
    .map(([name, spec]) => (spec === '' ? name : `${name} ${spec}`))
    .sort((a, b) => a.localeCompare(b))
}

/** 手动重启命令（DSH 无法在运行中切换 profile，必须由用户/启动脚本带 --profile 重启）。 */
export function restartCommand(name: string): string {
  return `dsh --profile ${name}`
}

/** 形态 → i18n key（保持 key 字面量类型，便于 t() 编译期校验）。 */
export function shapeLabelKey(shape: DshProfileShape): 'profiles.shape.web' | 'profiles.shape.headless' | 'profiles.shape.generic' {
  if (shape === 'web') return 'profiles.shape.web'
  if (shape === 'headless') return 'profiles.shape.headless'
  return 'profiles.shape.generic'
}

/** issue → i18n key。 */
export function issueLabelKey(issue: DshProfileIssue): 'profiles.issue.manifestInvalid' | 'profiles.issue.patchTooLarge' {
  return issue === 'manifestInvalid' ? 'profiles.issue.manifestInvalid' : 'profiles.issue.patchTooLarge'
}

/** 时间戳（毫秒）→ 本地 `YYYY-MM-DD HH:mm`；null / 非法 = 空串。 */
export function formatProfileTime(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 字节数 → 人类可读（B / KB / MB，保留一位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
