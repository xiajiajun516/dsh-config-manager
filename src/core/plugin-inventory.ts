/**
 * 远端依赖清单（⑤「落地 cloud-sync 借鉴的 6 个功能」）——**不绑定本次同步操作**的
 * 「远端声明插件 vs 本机现状」只读对照内核。
 *
 * ## 为什么要一个独立纯函数
 * 既有的插件差异是在**同步这一刻**由 analyzer 逐插件 diff 出来的
 * （\`src/adapters/plugins.ts\` 的 Install / Conflict / Skip），只在「拉取 → 差异确认」流程里存在：
 * 用户不发起同步就看不到「远端到底声明了哪些插件、本机差哪些」。
 * 本模块把同一事实抽成**随时可算**的对照表，并且把既有视图含糊掉的一处补上：
 * **installed（包在 node_modules 里）与 enabled（名字在 dsh.profile.bundles 里）分开判定** ——
 * 包在盘上却没进 bundles = 半装（DSH 不会挂载它）。
 *
 * ## 三源并集（与竞品 \`dsh-cloud-sync\` 的 getSyncInventory 同口径）
 * 行集合 = 远端快照声明的包 ∪ 本机 profile 依赖声明 ∪ 本机 cordis.yml / cordis.patch.yml 引用的 name。
 * 名称去重后按字典序输出（稳定顺序 = 界面不会因来源顺序抖动）。
 *
 * ## 字段语义（诚实性约定，界面文案按此措辞）
 * - \`requested\`         远端快照声明了它（快照 plugins 分区 = 导出机 profile 依赖）。
 * - \`configuredInRemote\` 远端快照的配置层引用了它（快照 patch 行的 name）。
 * - \`installed\`         本机 node_modules 里**真的有落盘副本**（不是「声明了依赖」）。
 * - \`enabled\`           名字在本机 \`dsh.profile.bundles\` 里（DSH 启动时会挂载它）。
 * - \`localSource\`       本机依赖 spec 是本地来源（\`file:\` / \`link:\` / \`workspace:\` / \`portal:\`）。
 * - \`sourceArchived\`    本地来源指向的路径**已不存在**（换机会失效，重新同步 / 重装都会失败）。
 * - \`configurationOnly\` 本机**只被配置层引用**：既不在依赖声明里、也没有落盘副本 —— 纯本机事实，
 *                        与远端是否可达无关（远端不可达时该字段仍然可信）。
 *
 * ## 远端不可达
 * \`remote.available === false\` 时：**绝不谎报**成「远端没有声明」——\`requested\` /
 * \`configuredInRemote\` 一律 false 且调用方必须把 \`available\` 透给界面（该字段在
 * 远端不可达时只是「未取到」，不是判定结果）。error 原文由调用方过 \`redact()\` 后再回传。
 *
 * ## 纯度
 * 本模块**零 import、零 I/O**：所有「磁盘上有没有」的判定都由调用方以谓词注入，
 * 这样浏览器半也能安全地按类型引用它（client bundle 自包含护栏）。
 */

/** 远端快照侧声明的一个包（来源：快照 plugins 分区的 PluginEntry）。 */
export interface InventoryRemoteEntry {
  name: string
  /** 导出机 profile 里声明的依赖 spec（可回显，非敏感） */
  spec?: string
  /** 导出机落盘版本（旧备份缺省 = 空） */
  version?: string
  /** 只在 dsh.profile.bundles 声明、导出机也没有落盘副本（issue #95 语义） */
  bundlesOnly?: boolean
}

/** 本机 profile 现状（调用方从 profile package.json 读）。 */
export interface InventoryLocalProfile {
  /** package.json 的 dependencies：包名 → spec */
  dependencies: Readonly<Record<string, string>>
  /** package.json 的 dsh.profile.bundles（DSH 启动时挂载的层） */
  bundles: readonly string[]
}

/** 远端快照侧输入：可取到 → 声明清单；取不到 → available:false + error（绝不猜）。 */
export type InventoryRemote =
  | {
    available: true
    /** 快照 id（界面展示用，缺省 = 未指定） */
    snapshotId?: string
    /** 快照 plugins 分区里的包声明（= 导出机 profile 依赖） */
    plugins: readonly InventoryRemoteEntry[]
    /** 快照 patch 行引用的 name（= 导出机配置层引用） */
    configuredNames?: readonly string[]
  }
  | { available: false; error: string }

/** 逐条状态（**互斥单值**；界面按 status → 字典键映射，禁止渲染裸枚举）。 */
export type InventoryStatus =
  /** 已装且已启用（installed && enabled） */
  | 'enabled'
  /** 半装：包在 node_modules 里、是 bundle 形态，却没进 dsh.profile.bundles（DSH 不会挂载） */
  | 'half-installed'
  /** 已装但非 bundle 层（普通依赖，本就不参与挂载） */
  | 'dependency-only'
  /** 在 bundles 里声明、本 profile 却没有落盘副本（由 DSH 从自身安装位置解析的层） */
  | 'host-resolved'
  /** 有来源要求它存在（远端声明 / 本机依赖声明），本机没装 → 缺席 */
  | 'missing'
  /** 只被本机配置层引用（cordis.yml / cordis.patch.yml），无依赖声明也无落盘副本 */
  | 'configuration-only'

/** 对照表的一行。 */
export interface InventoryEntry {
  name: string
  /** 远端快照声明了它（远端不可达时恒 false = 未取到，见文件头诚实性约定） */
  requested: boolean
  /** 远端快照的配置层引用了它 */
  configuredInRemote: boolean
  /** 本机配置层（cordis.yml / cordis.patch.yml）引用了它 */
  configuredLocally: boolean
  /** 本机 node_modules 里有落盘副本 */
  installed: boolean
  /** 名字在本机 dsh.profile.bundles 里 */
  enabled: boolean
  /** 本机依赖 spec 是本地来源 */
  localSource: boolean
  /** 本地来源指向的路径已不存在 */
  sourceArchived: boolean
  /** 只被本机配置层引用（纯本机事实，与远端可达性无关） */
  configurationOnly: boolean
  /** 属于三源中的哪几源（用于界面解释「这行从哪来」） */
  inRemote: boolean
  inLocalDependencies: boolean
  inLocalConfig: boolean
  /** 包声明 dsh.bundle.patch（bundle 形态）；unknown 一律按 false（宁可不报） */
  isBundle: boolean
  /** 半装 = installed && !enabled && isBundle（与「已装且已启用」显式区分） */
  halfInstalled: boolean
  status: InventoryStatus
  /** 本机依赖 spec（缺省 undefined = 无声明） */
  localSpec?: string
  /** 远端依赖 spec（缺省 undefined = 远端无此声明/远端不可达） */
  remoteSpec?: string
  /** 本机落盘版本（缺省 '' = 读不到 / 未装） */
  version: string
}

/** 汇总计数（界面统计行用；由同一批 entries 现算，不单独维护）。 */
export interface InventoryCounts {
  total: number
  enabled: number
  halfInstalled: number
  missing: number
  configurationOnly: number
  localSource: number
}

export interface InventoryResult {
  /** 远端快照是否取到。**false 时下文的 requested / configuredInRemote 不可作为判定依据**。 */
  available: boolean
  /** 远端不可达时的原因（调用方已脱敏）；可达时 undefined */
  error?: string
  snapshotId?: string
  entries: InventoryEntry[]
  counts: InventoryCounts
}

export interface InventoryInput {
  remote: InventoryRemote
  local: InventoryLocalProfile
  /** 本机 profile 的 cordis.yml / cordis.patch.yml 引用的 name（见 collectConfigPluginNames） */
  configNames?: readonly string[]
  /** 包在本机 profile 的 node_modules 里是否真有落盘副本 */
  isInstalled: (name: string) => boolean
  /** 包是否是 bundle 形态（声明 dsh.bundle.patch）；缺省 false */
  isBundle?: (name: string) => boolean
  /** 本机落盘版本（可回显）；缺省 '' */
  versionOf?: (name: string) => string
  /** 本地来源 spec 指向的路径是否已不存在；缺省不判（恒 false） */
  isSourceArchived?: (name: string, spec: string) => boolean
}

/** 本地来源 spec 前缀（pnpm 支持的四类：文件 / 链接 / 工作区 / 门户）。 */
const LOCAL_SOURCE_PREFIX_RE = /^(file|link|workspace|portal):/i

/** 该依赖 spec 是否指向本机路径（换机即失效的那一类）。 */
export function isLocalSourceSpec(spec: string): boolean {
  return LOCAL_SOURCE_PREFIX_RE.test(spec.trim())
}

/** 去掉本地来源前缀后的路径文本（供调用方做 path.resolve / 存在性判定；非本地来源返回 null）。 */
export function localSourcePath(spec: string): string | null {
  const trimmed = spec.trim()
  if (!LOCAL_SOURCE_PREFIX_RE.test(trimmed)) return null
  const idx = trimmed.indexOf(':')
  // 显式 trim 掉分隔符后的空格（pnpm 允许 'file: ./x' 这种写法）
  return trimmed.slice(idx + 1).trim()
}

/**
 * 从「已解析的 YAML 文档」里收集被引用的包名（cordis.yml / cordis.patch.yml 共用）。
 *
 * 形状：顶层是 loader patch 条目数组，每条形如 \`{ id, name?, config?, disabled? }\`；
 * 插入块形如 \`{ insert: [ 条目, … ] }\`。**只取条目自身的 \`name\` 字符串** ——
 * 绝不递归进 \`config\`（那里有大量无关的 name，例如模型显示名
 * \`{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }\`，递归会产生假阳性）。
 *
 * 无法解析（document 不是数组 / 条目不是对象）一律跳过：宁可少收，不可猜。
 */
export function collectConfigPluginNames(doc: unknown): string[] {
  const out = new Set<string>()
  const visitEntry = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
    const rec = entry as Record<string, unknown>
    const name = rec['name']
    if (typeof name === 'string' && name !== '') out.add(name)
    const insert = rec['insert']
    if (Array.isArray(insert)) for (const item of insert) visitEntry(item)
  }
  if (Array.isArray(doc)) for (const item of doc) visitEntry(item)
  return [...out]
}

/**
 * 从快照的 patch 行（\`PluginsSection.patch\`，形如 \`{ file, lineId, raw }\`）里收集被引用的包名。
 *
 * \`raw\` 就是 loader patch 条目本体（与 cordis.patch.yml 同一方言）：可以是单条目对象，
 * 也可以是 \`insert\` 数组。形状不符一律跳过 —— 远端载荷是**不可信输入**，宁可少收。
 */
export function collectPatchLineNames(patch: readonly unknown[]): string[] {
  const out = new Set<string>()
  for (const line of patch) {
    if (line === null || typeof line !== 'object') continue
    const raw = (line as { raw?: unknown }).raw
    if (raw === undefined) continue
    const names = Array.isArray(raw) ? collectConfigPluginNames(raw) : collectConfigPluginNames([raw])
    for (const name of names) out.add(name)
  }
  return [...out]
}

/** 快照 plugins 分区的解析结果（意义见各字段）。 */
export interface RemotePluginsSectionParse {
  /** 远端声明的包（= 导出机 profile 依赖） */
  plugins: InventoryRemoteEntry[]
  /** 远端配置层引用的 name（= 导出机 cordis patch 行） */
  configuredNames: string[]
}

/**
 * 解析快照 plugins 分区的**原始 JSON**（来自 ZIP，按不可信输入处理）。
 *
 * 为什么在宿主内核里做而不是在路由里现写：形状判定必须与单测同源；路由只做 I/O 与装配。
 * 任何形状不符一律跳过该条（绝不猜、绝不抛），全部不符时如实回 \`[]\`（= 远端确实没有声明）。
 */
export function parseRemotePluginsSection(section: unknown): RemotePluginsSectionParse {
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { plugins: [], configuredNames: [] }
  }
  const rec = section as Record<string, unknown>
  const plugins: InventoryRemoteEntry[] = []
  const rawPlugins = rec['plugins']
  if (Array.isArray(rawPlugins)) {
    for (const item of rawPlugins as unknown[]) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      const name = entry['name']
      if (typeof name !== 'string' || name === '') continue
      const spec = entry['spec']
      const version = entry['version']
      plugins.push({
        name,
        ...(typeof spec === 'string' && spec !== '' ? { spec } : {}),
        ...(typeof version === 'string' && version !== '' ? { version } : {}),
        ...(entry['bundlesOnly'] === true ? { bundlesOnly: true } : {}),
      })
    }
  }
  const patch = rec['patch']
  return { plugins, configuredNames: Array.isArray(patch) ? collectPatchLineNames(patch as unknown[]) : [] }
}

/**
 * 三源并集 → 逐条对照表。
 *
 * 顺序：三源名称合并去重后按字典序（稳定、可 diff、界面不抖动）。
 * 值域：见文件头的字段语义；\`status\` 判定优先级见下方实现（互斥单值）。
 */
export function buildPluginInventory(input: InventoryInput): InventoryResult {
  const remoteAvailable = input.remote.available
  const remotePlugins = remoteAvailable ? input.remote.plugins : []
  const remoteConfigured = new Set(remoteAvailable ? (input.remote.configuredNames ?? []) : [])

  const remoteByName = new Map<string, InventoryRemoteEntry>()
  for (const p of remotePlugins) {
    if (typeof p?.name !== 'string' || p.name === '') continue
    if (!remoteByName.has(p.name)) remoteByName.set(p.name, p)
  }
  const localDeps = input.local.dependencies ?? {}
  const bundles = new Set(input.local.bundles ?? [])
  const configNames = new Set(input.configNames ?? [])

  const names = new Set<string>([
    ...remoteByName.keys(),
    ...Object.keys(localDeps),
    ...configNames,
  ])

  const isInstalled = input.isInstalled
  const isBundleFn = input.isBundle ?? ((): boolean => false)
  const versionOf = input.versionOf ?? ((): string => '')

  const entries: InventoryEntry[] = []
  for (const name of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const remoteEntry = remoteByName.get(name)
    const localSpec = Object.prototype.hasOwnProperty.call(localDeps, name) ? localDeps[name] : undefined
    const installed = isInstalled(name)
    const enabled = bundles.has(name)
    const localSource = localSpec !== undefined && isLocalSourceSpec(localSpec)
    const sourceArchived = localSource && localSpec !== undefined
      ? (input.isSourceArchived?.(name, localSpec) ?? false)
      : false
    const inRemote = remoteEntry !== undefined
    const inLocalDependencies = localSpec !== undefined
    const inLocalConfig = configNames.has(name)
    const configuredInRemote = remoteConfigured.has(name)
    // 纯本机事实：不在依赖声明里、也没有落盘副本 → 配置层引用的孤名。
    // **只看本机**：远端不可达时它也依然成立（绝不因远端未知而改口）。
    const configurationOnly = !inLocalDependencies && !installed && inLocalConfig
    const isBundle = installed && isBundleFn(name)
    const halfInstalled = installed && !enabled && isBundle

    let status: InventoryStatus
    if (halfInstalled) status = 'half-installed'
    else if (installed && enabled) status = 'enabled'
    else if (!installed && enabled) status = 'host-resolved'
    else if (installed) status = 'dependency-only'
    else if (inRemote || inLocalDependencies) status = 'missing'
    else status = 'configuration-only'

    entries.push({
      name,
      requested: inRemote,
      configuredInRemote,
      configuredLocally: inLocalConfig,
      installed,
      enabled,
      localSource,
      sourceArchived,
      configurationOnly,
      inRemote,
      inLocalDependencies,
      inLocalConfig,
      isBundle,
      halfInstalled,
      status,
      ...(localSpec === undefined ? {} : { localSpec }),
      ...(remoteEntry?.spec === undefined ? {} : { remoteSpec: remoteEntry.spec }),
      version: versionOf(name) || (remoteEntry?.version ?? ''),
    })
  }

  const counts: InventoryCounts = {
    total: entries.length,
    enabled: entries.filter((e) => e.status === 'enabled').length,
    halfInstalled: entries.filter((e) => e.halfInstalled).length,
    missing: entries.filter((e) => e.status === 'missing').length,
    configurationOnly: entries.filter((e) => e.configurationOnly).length,
    localSource: entries.filter((e) => e.localSource).length,
  }

  return {
    available: remoteAvailable,
    ...(remoteAvailable ? {} : { error: input.remote.available === false ? input.remote.error : '' }),
    ...(remoteAvailable && input.remote.snapshotId !== undefined ? { snapshotId: input.remote.snapshotId } : {}),
    entries,
    counts,
  }
}
