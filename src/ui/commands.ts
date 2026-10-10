/**
 * 命令面板的纯数据注册表（UI v2 §5.3）—— `src/client/common/CommandPalette.tsx` 只做装配。
 *
 * 为什么要有它：v2 把一级导航从「功能目录」降级为「最常去的地方」，其余靠 `⌘K` 直达。
 * 于是**增一个功能 = 注册一条命令**，而不是再挤一个页签进 564px 的导航条。
 *
 * 分层铁律：本文件零依赖（不 import react / 浏览器 API / 客户端字典）——
 *   - **文案键**只声明字面量联合（`PaletteTitleKey`），实际文案由壳层用 `t()` 解析；
 *     键不存在于 `src/client/locales.ts` 时，壳层那一句 `t(item.titleKey)` 编译报错。
 *   - **匹配文本**（标题）由调用方通过 `titleOf` 注入，因此本模块与语言无关、node 可测。
 *   - 命令 id 用英文（`go.overview` / `export.open`），顺带充当英文别名：
 *     中文用户敲「导出」命中标题，英文用户敲 "export" 命中 id。
 */

// 只导入**类型**：type-only import 在编译期被擦除，不会把 src/sync 的运行时依赖带进 client bundle。
import type { SyncTransportType } from '../sync/sync-config.ts'

/**
 * 通道搜索词 = **受守卫的客户端镜像**。
 *
 * 为什么必须写成这个形状：t32 源码守卫（`src/sync/sync-config.test.ts`）把「两个通道名的
 * 字面量相邻出现」视为第二处通道枚举声明（历史上一模一样的两份数组漏改过一份，导致某通道
 * 永不排期），只有带 `satisfies` 穷尽标记的客户端镜像才放行。**连注释里都不许把这两个名字
 * 写成相邻的带引号字面量** —— 守卫扫的是文本，不区分代码与注释。
 * 写成搜索关键词也一样要守这条规矩 —— 守卫认的是形状，不是用途。
 */
const SYNC_CHANNEL_TERMS = ['git', 'webdav'] satisfies readonly SyncTransportType[]

/** 命令分组（渲染顺序见 `COMMAND_GROUP_ORDER`）。 */
export type CommandGroup = 'navigate' | 'library' | 'action' | 'view' | 'rescue'

/** 命令面板的分组渲染顺序。 */
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = ['navigate', 'library', 'action', 'view', 'rescue']

/** 命令文案键：必须是 `src/client/locales.ts` 里存在的键（由壳层的 t() 编译校验）。 */
export type PaletteTitleKey =
  | 'nav.home' | 'library.title' | 'nav.sync' | 'environment.title'
  | 'nav.market' | 'task.title.publish'
  | 'nav.export' | 'nav.import' | 'environment.tab.maintenance' | 'foreign.source.title'
  | 'task.title.runs' | 'task.title.history' | 'task.title.about'
  | 'palette.rescue.recovery' | 'palette.rescue.mode' | 'palette.rescue.rollback'
  | 'library.source.all' | 'library.kind.snapshot' | 'library.kind.backupFile'
  | 'library.kind.remote' | 'library.kind.market'

/** 可用性上下文：由壳层从 runStore 现算（不要在注册表里读 store）。 */
export interface CommandContext {
  /** 是否有未解决的恢复事项 */
  recoveryRequired: boolean
  /** 进行中的任务数 */
  runningCount: number
}

export interface CommandItem {
  id: string
  group: CommandGroup
  titleKey: PaletteTitleKey
  /** 额外匹配词（同义说法、缩写）；与 id、标题一起参与匹配 */
  keywords: readonly string[]
  /**
   * 缺省 = 始终可用；返回 false 表示当前上下文不可用（面板灰显 + 键盘跳过）。
   *
   * **目的地类命令（页面 / 视图 / 流程面板）一律不用它**：那些去处任何时候都能打开，
   * 面板自己会渲染空状态（「暂无进行中的任务」比一个点不动的灰条有用得多）。
   * 这个口子只留给「当前上下文真的做不了」的动作（例如将来某个需要先选目标档案的动作），
   * 且**必须同时给得出原因**，否则用户只会看到一条无法点击的灰条。
   */
  enabled?: (ctx: CommandContext) => boolean
}

export interface CommandMatch {
  item: CommandItem
  /** 当前上下文下不可用：**仍然列出**（灰显），让用户知道这条命令存在、只是现在用不了 */
  disabled: boolean
}

/** 默认最多返回多少条（面板限高，再多也看不见）。 */
export const COMMAND_RESULT_LIMIT = 40

/**
 * 命令清单（UI v2 §5.3 的完整覆盖面）。
 *
 * 三条纪律：
 *   ① **每个可达去处都有一条命令** —— 页面（首页/产物库/同步/环境）、只读视图
 *      （活动记录 / 迁移历史 / 关于）、流程面板（导出 / 导入 / 逛市场 / 发布到市场）、
 *      维护与诊断（事故恢复与救援模式在其中）。
 *      壳层的 `runCommand` 认不出 id 就什么都不做，所以「dispatch 里有、这里没有」= 死代码。
 *   ② **文案统一复用导航与任务面板已有的键**：用户在导航条/面板标题上学到的名字，
 *      在命令面板里必须还能用（新造一套名字会让搜索无果）。
 *   ③ 关键词补齐中英同义说法与口语（"恢复" 也要命中事故恢复、"磁盘" 也要命中维护与诊断）。
 */
export const COMMANDS: readonly CommandItem[] = [
  // —— 前往：四个一级页面（v3 §3.1；市场不再是页面）——
  { id: 'go.home', group: 'navigate', titleKey: 'nav.home', keywords: ['home', 'overview', '首页', '总览'] },
  { id: 'go.library', group: 'navigate', titleKey: 'library.title', keywords: ['library', 'artifact', '产物', '快照'] },
  { id: 'go.sync', group: 'navigate', titleKey: 'nav.sync', keywords: ['sync', ...SYNC_CHANNEL_TERMS, '同步'] },
  {
    // 环境 = 档案 + 维护与诊断。文案用导航条上的名字（environment.title），
    // 不用旧的 nav.profiles（'档案'）—— 面板里找不到「档案」这个页面。
    id: 'go.environment',
    group: 'navigate',
    titleKey: 'environment.title',
    keywords: ['profile', 'profiles', 'environment', '档案', '环境', '实例'],
  },

  // —— 产物库来源筛选：切到产物库并落定筛选（判定与列表同源：runStore.library.sourceFilter）——
  { id: 'library.source.all', group: 'library', titleKey: 'library.source.all', keywords: ['all', '全部', '来源', '筛选'] },
  { id: 'library.source.snapshot', group: 'library', titleKey: 'library.kind.snapshot', keywords: ['snapshot', '快照', '还原点'] },
  { id: 'library.source.backupFile', group: 'library', titleKey: 'library.kind.backupFile', keywords: ['backup', 'file', 'zip', '备份', '归档'] },
  { id: 'library.source.remote', group: 'library', titleKey: 'library.kind.remote', keywords: ['remote', 'sync', '远端', '同步快照'] },
  { id: 'library.source.market', group: 'library', titleKey: 'library.kind.market', keywords: ['market', '市场', '配置'] },

  // —— 动作：市场（流程面板）+ 导出/导入 + 维护与诊断 ——
  {
    // 市场退出导航（v3）：逛市场是**流程**，由 Task 面板承载。
    // 文案沿用导航条上曾经的名字（nav.market）—— 用户学到的词不能被换掉。
    id: 'market.open',
    group: 'action',
    titleKey: 'nav.market',
    keywords: ['market', 'browse', '市场', '逛市场', '配置市场'],
  },
  {
    // 发布到市场 = 市场面板的「我的配置」子视图（payload 让面板直开那一页）。
    // 文案复用 task.title.publish（字典里已有 zh/en）。
    id: 'market.publish.open',
    group: 'action',
    titleKey: 'task.title.publish',
    keywords: ['publish', 'upload', '发布', '上传', '我的配置'],
  },

  {
    // 导出不是页面（Task Mode 的侧滑面板），所以它是 action 不是 navigate。
    // 但文案沿用 nav.export —— 用户在导航条上学到的名字，在命令面板里必须还能用。
    id: 'export.open',
    group: 'action',
    titleKey: 'nav.export',
    keywords: ['export', 'zip', '导出'],
  },
  {
    // 导入同理：它不是页面（goto('import') 会落到产物库并开面板）。
    id: 'import.open',
    group: 'action',
    titleKey: 'nav.import',
    keywords: ['import', 'restore', '导入'],
  },
  {
    // 从其它 agent 导入（Claude Code / Cursor …）：与首页工具栏是**同一个入口** ——
    // 开导入面板并直接停在「来源选择」那一步，而不是让用户先进向导再找按钮（t17 的语义）。
    id: 'import.foreign',
    group: 'action',
    titleKey: 'foreign.source.title',
    keywords: ['foreign', 'claude', 'codex', 'cursor', 'agent', 'migrate', '其它', '其他', '外部', '迁移'],
  },
  {
    // 维护与诊断 = 环境页的全屏子视图（磁盘占用 / 会话健康 / 救援模式都在里面）。
    // 命令必须**直达该子视图**（壳层写 store 的 profiles.subView），只把用户送到「档案」列表
    // 等于什么都没做 —— 这一条此前只在 runCommand 的 dispatch 里存在，注册表漏了它。
    id: 'maintenance.open',
    group: 'action',
    titleKey: 'environment.tab.maintenance',
    keywords: ['maintenance', 'diagnostics', 'disk', 'cleanup', '维护', '诊断', '磁盘', '清理'],
  },

  // —— 视图：三个只读面板（原抽屉内容，§5.9）——
  {
    id: 'activity.open',
    group: 'view',
    titleKey: 'task.title.runs',
    keywords: ['runs', 'activity', 'log', 'lock', '活动', '记录', '进行中', '环境锁'],
  },
  {
    id: 'history.open',
    group: 'view',
    titleKey: 'task.title.history',
    keywords: ['history', 'migration', '历史', '迁移'],
  },
  { id: 'about.open', group: 'view', titleKey: 'task.title.about', keywords: ['about', 'version', 'cli', '关于', '版本'] },

  // —— 处置：事故恢复（SAFE MODE 的界面出口，与维护与诊断同一个子视图）——
  {
    id: 'recovery.open',
    group: 'rescue',
    titleKey: 'palette.rescue.recovery',
    keywords: ['rescue', 'recovery', 'safe', 'safe mode', '事故', '恢复', '去处理'],
  },
  {
    // 救援模式（DSH 起不来时的唯一出口）：与事故恢复同一子视图，但必须**独立成条** ——
    // 不变量 §3-18 要求命令面板里「救援模式」「事故恢复」两条命令都在。
    id: 'rescue.open',
    group: 'rescue',
    titleKey: 'palette.rescue.mode',
    keywords: ['rescue', 'mode', 'profile', 'bundles', '救援', '救援模式', '逃生'],
  },
  {
    // S7：工作区 + 会话回滚（每个回合结束自动留点；会话回退 = fork 子会话）—— 与事故恢复同一子视图，
    // 键盘可达（卡片本身在环境页维护与诊断里，⌘K 直达同一落点）。
    // 中文关键词数量刻意保持 4 个：i18n 守卫的白名单锚定 src/ui/commands.ts 的命中数（53），
    // 增删中文词会让白名单计数漂移（新增豁免只能走 captain）。
    id: 'rollback.open',
    group: 'rescue',
    titleKey: 'palette.rescue.rollback',
    keywords: ['rollback', 'rewind', 'workspace', 'session', 'fork', '回滚', '回退', '工作区', '会话'],
  },
]

/** 一条命令在当前查询下的匹配分档；越小越靠前。-1 = 不匹配。 */
function matchScore(item: CommandItem, title: string, q: string): number {
  const t = title.toLowerCase()
  const idText = item.id.replace(/\./g, ' ')
  const idSegments = idText.split(' ')
  const keywords = item.keywords.map((k) => k.toLowerCase())
  if (t.startsWith(q)) return 0
  if (idSegments.some((seg) => seg.startsWith(q))) return 1
  if (keywords.some((k) => k.startsWith(q))) return 1
  if (t.includes(q)) return 2
  if (idText.includes(q) || keywords.some((k) => k.includes(q))) return 3
  return -1
}

/**
 * 过滤并排序命令。
 *
 * 语义：
 *   ① 空查询（或全空白）→ 返回全部，**保持声明顺序**（分组渲染由调用方负责）；
 *   ② 大小写不敏感；
 *   ③ 排序：标题前缀 > id/关键词前缀 > 标题子串 > id/关键词子串；同档保持声明顺序（稳定）；
 *   ④ 不可用的命令**仍然列出**（`disabled: true`），只是面板灰显并让键盘跳过；
 *   ⑤ `limit` 兜底，避免把上千条命令塞进限高的面板。
 */
export function filterCommands(
  items: readonly CommandItem[],
  query: string,
  titleOf: (key: PaletteTitleKey) => string,
  ctx: CommandContext,
  limit: number = COMMAND_RESULT_LIMIT,
): CommandMatch[] {
  const matches = items.map((item, index) => ({
    item,
    index,
    disabled: item.enabled !== undefined && !item.enabled(ctx),
  }))
  const q = query.trim().toLowerCase()
  // 空查询也走 limit：面板限高，两条分支的上限必须一致（否则「列出全部」会绕开兜底）
  if (q === '') return matches.slice(0, limit).map(({ item, disabled }) => ({ item, disabled }))

  const scored: Array<{ match: CommandMatch; score: number; index: number }> = []
  for (const entry of matches) {
    const score = matchScore(entry.item, titleOf(entry.item.titleKey), q)
    if (score >= 0) scored.push({ match: { item: entry.item, disabled: entry.disabled }, score, index: entry.index })
  }
  scored.sort((a, b) => (a.score - b.score) || (a.index - b.index))
  return scored.slice(0, limit).map((s) => s.match)
}
