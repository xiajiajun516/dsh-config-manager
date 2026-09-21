/**
 * DSH profile 的**零依赖共享层**（host 与 client 双端复用）。
 *
 * 本文件不得 import 任何 node 模块：`src/client/` 的运行时 import 会把整条依赖链
 * 打进 lib/client.js，一旦带上 node 内置模块依赖，DSH loader 会拒绝加载整个插件。
 * 引擎（`dsh-profile-manager.ts`，用 node fs）与 UI 视图模型/React 壳都只从这里取
 * 类型、常量与纯函数。
 */

/** profile 形态：按 bundles 能力判定，不枚举界面（社区新形态无需改动即可归为 generic）。 */
export type DshProfileShape = 'web' | 'headless' | 'generic'
/** patch 层生命周期：live = 监视并热生效；startup = 只在启动时应用一次。 */
export type DshProfilePatchReload = 'live' | 'startup'

/** 一个 profile 的非致命问题（列表仍展示，便于用户删除损坏档案）。 */
export type DshProfileIssue = 'manifestInvalid' | 'patchTooLarge'

/** 列表行数据（全部非敏感：profile 定义本身不含秘密值）。 */
export interface DshProfileMeta {
  /** profile 名（= 目录名 = `dsh --profile <name>`） */
  name: string
  /** 绝对目录 */
  dir: string
  /** dsh.profile.bundles（有序 bundle 层） */
  bundles: string[]
  /** package.json dependencies（含 in-box bundle；原样展示） */
  dependencies: Record<string, string>
  shape: DshProfileShape
  patchReload: DshProfilePatchReload
  /** 是否已有 node_modules（树外插件是否装过） */
  hasNodeModules: boolean
  /** cordis.patch.yml 的 patch 条目数（以 `- ` 开头的行，启发式计数） */
  patchEntryCount: number
  /** cordis.patch.yml 字节数（不可读 = 0） */
  patchBytes: number
  /** 是否当前正在运行的 profile */
  isCurrent: boolean
  issues: DshProfileIssue[]
  /** package.json 的 mtime（毫秒）；不可读 = null */
  updatedAtMs: number | null
}

/** 详情：列表字段 + 原始文本（详情弹窗展示；过大时截断为 null）。 */
export interface DshProfileDetail extends DshProfileMeta {
  /** package.json 原文（不可读 = null） */
  manifest: string | null
  /** cordis.patch.yml 原文（不可读或过大 = null） */
  patch: string | null
}

/** 「下次启动」标记的解析结果。 */
export interface DshProfileSelection {
  name: string
  /** 目标 profile 是否仍然存在（被删除后 = false，UI 应提示重新选择） */
  exists: boolean
  /** 目标是否就是当前运行中的 profile（= 无需重启） */
  isCurrent: boolean
}

/** GET /profiles 的响应负载（列表 + 当前运行 + 下次启动 + 模板清单）。 */
export interface DshProfilesSnapshot {
  profiles: DshProfileMeta[]
  /** 当前运行中的 profile 名（宿主从 config/argv 解析） */
  current: string
  /** 「下次启动」标记（无 = null） */
  selection: DshProfileSelection | null
  /** 可选的起步模板（新建档案时用） */
  templates: DshProfileTemplate[]
}

/** 新建 profile 可选的官方模板（与 dsh-app-boot PROFILE_TEMPLATES 对齐，dsh 0.1.5-rc.1）。 */
export interface DshProfileTemplate {
  /** 模板 id（= 官方 `--from-default-profile <template>` 名；base = `dsh plugin` 的默认起步） */
  id: string
  bundles: string[]
  patchReload: DshProfilePatchReload
}

export const DSH_PROFILE_TEMPLATES: readonly DshProfileTemplate[] = [
  { id: 'base', bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' },
  { id: 'web', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  { id: 'headless', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' },
  { id: 'sdk', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  { id: 'sdk-minimal', bundles: ['@deepseek-ai/dsh-sdk-minimal'], patchReload: 'startup' },
  { id: 'acp', bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' },
]

/**
 * 不允许自建的保留名：shipped template 名（DSH 会自行按模板初始化，手建语义冲突）
 * + Electron 独占的 desktop（CLI 明确拒绝）。
 */
export const RESERVED_PROFILE_NAMES: readonly string[] = [
  'web', 'headless', 'sdk', 'sdk-minimal', 'acp', 'desktop',
]

/** engine 错误码（用户可见文案由 UI 层按 code 映射 i18n；未知 code 才回退 message）。 */
export type DshProfileErrorCode =
  | 'invalidName' | 'reservedName' | 'exists' | 'notFound'
  | 'currentProfile' | 'unknownTemplate' | 'invalidNameInput'

/** 形态判定：按 bundles 是否包含官方表层 bundle。 */
export function classifyShape(bundles: readonly string[]): DshProfileShape {
  if (bundles.includes('@deepseek-ai/dsh-web-app')) return 'web'
  if (bundles.includes('@deepseek-ai/dsh-headless')) return 'headless'
  return 'generic'
}

/**
 * 名字校验（与 DSH 的 resolveProfileDir 同规则）→ 返回错误码，合法则 null。
 * 纯函数，供 UI 输入校验与 host 侧二次校验共用（host 侧仍走 validateProfileName 兜底）。
 */
export function checkProfileName(name: string): DshProfileErrorCode | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'invalidNameInput'
  if (trimmed.length > 64) return 'invalidNameInput'
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return 'invalidNameInput'
  if (trimmed === '.' || trimmed === '..' || trimmed === 'node_modules') return 'invalidNameInput'
  if (RESERVED_PROFILE_NAMES.includes(trimmed)) return 'reservedName'
  return null
}
