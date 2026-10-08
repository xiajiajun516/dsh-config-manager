/**
 * 产物库的视图模型（UI v2 §6.3）—— 把**四套来源**合并成一张混合平铺列表。
 *
 * 为什么要合并：v1 把「本机快照 / 备份文件 / 远端快照 / 市场配置」分成四处列表、四套行结构、
 * 四套动作。用户找「我上周那份」时不该先想它落在哪个源里（§1.3）。
 *
 * 三条不变量：
 *  ① **动作由 capabilities 分派，不由 kind 分派**。行只渲染它真正支持的动作 ——
 *     远端快照不能删本机文件，市场条目不能「恢复」只能「安装」。这是「不再每种来源写一套列表」的落点。
 *  ② **未知值不编造**（§3 第三条）：体积只有备份文件有（§6.8 ①），缺失就是 `undefined`，
 *     渲染成「—」而不是 0；作者/版本缺失就不占元数据行的位置；时间缺失排到最后而不是当「最早」。
 *  ③ **本模块不掺 locale**：数字千分位、字节单位、文案全部走 UiT / formatBytes；
 *     时间只以 ISO 字符串流转，本地化格式化留给 React 层（像 `title: {kind:'time'}`）。
 *
 * 输入用**结构类型**而不是 import 四套真实类型：`src/ui` 不该依赖 `src/client/*` 的类型
 * （分层方向是 client → ui）。四个真实对象都比这里声明的更宽，直接传即可。
 */
import { formatBytes } from './report.ts'
import type { UiT, UiTextKey } from './i18n.ts'

/* ------------------------------------------------------------------ 输入 */

/** 本机快照（`core/restore.ts` 的 SnapshotMeta 子集） */
export interface SnapshotInput {
  id: string
  createdAt: string
  entryCount: number
  /** 快照**之前**已装的插件数 */
  beforePluginCount: number
  pinned?: boolean
}

/** 备份文件（`sync/backup-files.ts` 的 BackupFileMeta 子集） */
export interface BackupFileInput {
  path: string
  name: string
  sizeBytes: number
  /** 修改时间（ms 时间戳） */
  mtimeMs: number
  source: 'auto' | 'manual'
  note?: string | null
  /** 容器形态探测结果；`'encrypted'` = 需先解锁（issue #55 的界面侧根因：不探测会让用户以为备份坏了） */
  containerType?: 'zip' | 'encrypted'
}

/** 远端快照（`client/sync/sync-api.ts` 的 SyncSnapshotLite 子集） */
export interface RemoteSnapshotInput {
  id: string
  createdAt: string
  sectionCount: number
  platform: string
  dshVersion: string
}

/** 市场条目（`market/types.ts` 的 MarketListItem 子集） */
export interface MarketItemInput {
  id: string
  name: string
  author?: string
  version?: string
  updatedAt?: string
}

export interface ArtifactInput {
  snapshots?: readonly SnapshotInput[]
  backupFiles?: readonly BackupFileInput[]
  remoteSnapshots?: readonly RemoteSnapshotInput[]
  /** 远端当前基线（sync-state.lastSnapshotId）；命中即标「当前基线」。未知/缺省 = 不标 */
  remoteCurrentId?: string | null
  /** 远端通道类型（元数据行第 1 段）。未知 = 该段不渲染（不猜成 Git） */
  remoteChannel?: 'git' | 'webdav' | null
  marketItems?: readonly MarketItemInput[]
}

/* ------------------------------------------------------------------ 形状 */

export type ArtifactKind = 'snapshot' | 'backup-file' | 'remote-snapshot' | 'market'

/**
 * 行内可用动作。**这就是动作矩阵本身**（§6.4），没有第二份 kind → 动作的映射表。
 *
 * 与 §6.3 草案的两处收敛（实际落地时证明草案多余）：
 *  - 去掉 `'unlock'`：解锁不是独立行内动作，它是**导入流程的第一个阶段**，
 *    所以行内主操作的**文案**随 `encrypted` 徽章切换（`library.cap.unlockImport`），动作仍是 `import`；
 *  - 去掉 `'diff'`：本机快照的「查看差异」**就是**恢复的 dry-run 计划预览，
 *    与主操作同入口（§6.8 ②），单列只会让同一次调用有两个按钮。
 */
export type ArtifactCapability =
  | 'restore' | 'import' | 'pull' | 'install'
  | 'inspect' | 'download' | 'consult'
  | 'pin' | 'unpin' | 'delete'

/** 徽章（`Badge` 四态的语义入口；颜色由渲染层按 §6.2 映射） */
export type ArtifactBadge = 'pinned' | 'current' | 'encrypted' | 'unreadable'

/**
 * 主标识。`time` 是**标签**而不是格式化好的字符串：快照/远端快照的主标识就是时间，
 * 而本地化在 React 层做（本模块不掺 locale）。
 */
export type ArtifactTitle = { kind: 'text'; value: string } | { kind: 'time'; iso: string }

/** 展开态的一行完整元数据。
 *  `iso` 非空 = 这一行是时间：模型只给 ISO，**格式化留给渲染层**（本模块不掺 locale）。 */
export interface ArtifactDetailPair {
  label: string
  value: string
  iso?: string
}

/** 定位到具体动作的载荷（渲染层按 kind 取对应字段） */
export interface ArtifactRef {
  snapshotId?: string
  path?: string
  remoteId?: string
  marketId?: string
}

export interface ArtifactRow {
  /** 全局唯一（React key + 展开态持久化）：`<kind>:<id>` */
  key: string
  kind: ArtifactKind
  title: ArtifactTitle
  /** 元数据行的各段（**已本地化**，不含分隔符；「·」由渲染层插） */
  meta: string[]
  /** 排序时间（ISO）；未知 = null（时间排序时排最后，名称排序时退化为空串） */
  at: string | null
  /** 只有备份文件带体积（§6.8 ①）；`undefined` → 渲染「—」，绝不显示 0 */
  sizeBytes?: number
  badges: ArtifactBadge[]
  /** **展示顺序**：第 0 项 = 行内主操作，其余进 ⋯ 菜单（§6.4） */
  capabilities: ArtifactCapability[]
  ref: ArtifactRef
  /** 展开态的完整元数据（已本地化；**不含变更摘要** —— 那要跑一次 dry-run，§6.8 ③） */
  detail: ArtifactDetailPair[]
  /** 搜索用的小写 haystack（构造期算一次；含文件名/备注/快照 id/条目名/作者） */
  searchText: string
}

export interface ArtifactQuery {
  /** 来源筛选；`null`/`undefined` = 全部 */
  kind?: ArtifactKind | null
  /** 搜索词：按空白切词，**全部命中**才算匹配（AND，比整串子串更好用） */
  text?: string
  /** 排序：时间倒序（缺省）/ 名称 */
  sort?: 'time' | 'name'
}

export interface LibrarySummary {
  count: number
  /** 各来源条数（筛选条上的计数）。**只在「全部」视图可信** —— 单来源视图下它是该来源的已加载条数 */
  counts: Record<ArtifactKind, number>
  encrypted: number
  /** 没有体积的条数（三种来源都没有体积，所以这个数通常很大） */
  unknownSize: number
  /** 已知体积之和；**只要有一条没有体积就是 `null`**（不把「未知」混进「合计」，§6.8 ①） */
  bytes: number | null
}

/* ------------------------------------------------- 字典键（编译期穷尽） */

export const ARTIFACT_KIND_LABEL_KEY: Record<ArtifactKind, UiTextKey> = {
  'snapshot': 'library.kind.snapshot',
  'backup-file': 'library.kind.backupFile',
  'remote-snapshot': 'library.kind.remote',
  'market': 'library.kind.market',
}

export const ARTIFACT_BADGE_LABEL_KEY: Record<ArtifactBadge, UiTextKey> = {
  'pinned': 'library.badge.pinned',
  'current': 'library.badge.current',
  'encrypted': 'library.badge.encrypted',
  'unreadable': 'library.badge.unreadable',
}

export const ARTIFACT_CAPABILITY_LABEL_KEY: Record<ArtifactCapability, UiTextKey> = {
  'restore': 'library.cap.restore',
  'import': 'library.cap.import',
  'pull': 'library.cap.pull',
  'install': 'library.cap.install',
  'inspect': 'library.cap.inspect',
  'download': 'library.cap.download',
  'consult': 'library.cap.consult',
  'pin': 'library.cap.pin',
  'unpin': 'library.cap.unpin',
  'delete': 'library.cap.delete',
}

/** 数字千分位（固定 en-US：zh 的分组规则与它一致，且测试不依赖运行环境的 ICU 区域设置） */
function group(n: number): string {
  return n.toLocaleString('en-US')
}

/* ------------------------------------------------------------------ 构造 */

/**
 * 四源 → 行。返回**已按时间倒序**（缺时间的排最后）——
 * 面板不必再造一遍序，筛选/排序只覆盖用户的显式选择。
 */
export function toArtifactRows(input: ArtifactInput, t: UiT): ArtifactRow[] {
  const rows: ArtifactRow[] = [
    ...(input.snapshots ?? []).map((s) => snapshotRow(s, t)),
    ...(input.backupFiles ?? []).map((f) => backupFileRow(f, t)),
    ...(input.remoteSnapshots ?? []).map((r) => remoteSnapshotRow(r, input, t)),
    ...(input.marketItems ?? []).map((m) => marketRow(m, t)),
  ]
  return sortRows(rows, 'time')
}

function snapshotRow(s: SnapshotInput, t: UiT): ArtifactRow {
  const badges: ArtifactBadge[] = []
  if (s.pinned === true) badges.push('pinned')
  return {
    key: `snapshot:${s.id}`,
    kind: 'snapshot',
    title: { kind: 'time', iso: s.createdAt },
    meta: [
      t('library.meta.entries', { count: group(s.entryCount) }),
      t('library.meta.plugins', { count: group(s.beforePluginCount) }),
    ],
    at: s.createdAt,
    badges,
    // 恢复 = dry-run 计划预览（§6.8 ②）；「查看差异」与它同入口，故不单列
    // 置顶已移除（用户要求）：它只是一个排序偏好，却占了「更多」里的一格，收益不抵成本
  capabilities: ['restore', 'consult', 'delete'],
    ref: { snapshotId: s.id },
    detail: [
      { label: t('library.detail.id'), value: s.id },
      { label: t('library.detail.created'), value: '', iso: s.createdAt },
      { label: t('library.detail.entries'), value: group(s.entryCount) },
      { label: t('library.detail.plugins'), value: group(s.beforePluginCount) },
      { label: t('library.detail.pinned'), value: s.pinned === true ? t('library.value.yes') : t('library.value.no') },
    ],
    // 检索词也属界面文案（按当前语言的用户输入匹配；字面量中文会让英文界面命中中文词）
    searchText: [s.id, 'snapshot', t('library.kind.snapshot')].join(' ').toLowerCase(),
  }
}

function backupFileRow(f: BackupFileInput, t: UiT): ArtifactRow {
  const encrypted = f.containerType === 'encrypted'
  const badges: ArtifactBadge[] = encrypted ? ['encrypted'] : []
  return {
    key: `backup-file:${f.path}`,
    kind: 'backup-file',
    title: { kind: 'text', value: f.name },
    meta: [
      f.source === 'auto' ? t('library.meta.sourceAuto') : t('library.meta.sourceManual'),
      formatBytes(f.sizeBytes),
    ],
    at: new Date(f.mtimeMs).toISOString(),
    sizeBytes: f.sizeBytes,
    badges,
    capabilities: ['import', 'consult', 'inspect', 'download', 'delete'],
    ref: { path: f.path },
    // 备注可能为空 → 整行不出现（不渲染一个空值行）
    detail: [
      { label: t('library.detail.path'), value: f.path },
      ...(f.note === undefined || f.note === null || f.note === ''
        ? []
        : [{ label: t('library.detail.note'), value: f.note }]),
      { label: t('library.detail.source'), value: f.source === 'auto' ? t('library.meta.sourceAuto') : t('library.meta.sourceManual') },
      { label: t('library.detail.size'), value: formatBytes(f.sizeBytes) },
      { label: t('library.detail.modified'), value: '', iso: new Date(f.mtimeMs).toISOString() },
      { label: t('library.detail.container'), value: encrypted ? t('library.value.encryptedContainer') : t('library.value.plainZip') },
    ],
    searchText: [f.name, f.note ?? '', f.path].join(' ').toLowerCase(),
  }
}

function remoteSnapshotRow(r: RemoteSnapshotInput, input: ArtifactInput, t: UiT): ArtifactRow {
  const badges: ArtifactBadge[] = input.remoteCurrentId === r.id ? ['current'] : []
  // 通道类型未知 → 该段不渲染（不猜成 Git）
  const channel = input.remoteChannel === 'webdav'
    ? t('library.meta.channelWebdav')
    : input.remoteChannel === 'git' ? t('library.meta.channelGit') : null
  const meta: string[] = []
  if (channel !== null) meta.push(channel)
  meta.push(t('library.meta.sections', { count: group(r.sectionCount) }))
  meta.push(t('library.meta.dshVersion', { version: r.dshVersion }))
  return {
    key: `remote-snapshot:${r.id}`,
    kind: 'remote-snapshot',
    title: { kind: 'time', iso: r.createdAt },
    meta,
    at: r.createdAt,
    badges,
    // 与备份文件**对齐**（2026-10-04 用户要求）：查看与对比 / 下载 / 删除都进 ⋯ 菜单。
    // 「查看与对比」不再受「客户端拿不到分区明细」限制：宿主把该快照落地成本机 ZIP
    // （/sync/download）后走备份文件那条只读分析，于是远端也看得见真实分区与差异。
    // 删除只动**远端那一份**（宿主 /sync/snapshot-delete），本机配置与同步基线都不碰。
    capabilities: ['pull', 'consult', 'inspect', 'download', 'delete'],
    ref: { remoteId: r.id },
    detail: [
      { label: t('library.detail.id'), value: r.id },
      { label: t('library.detail.created'), value: '', iso: r.createdAt },
      { label: t('library.detail.sections'), value: group(r.sectionCount) },
      { label: t('library.detail.platform'), value: r.platform },
      { label: t('library.detail.dsh'), value: r.dshVersion },
    ],
    searchText: [r.id, r.platform, 'remote', t('library.kind.remote')].join(' ').toLowerCase(),
  }
}

function marketRow(m: MarketItemInput, t: UiT): ArtifactRow {
  const meta: string[] = []
  if (m.author !== undefined && m.author !== '') meta.push(m.author)
  if (m.version !== undefined && m.version !== '') meta.push(`v${m.version}`)
  return {
    key: `market:${m.id}`,
    kind: 'market',
    title: { kind: 'text', value: m.name },
    meta,
    at: m.updatedAt ?? null,
    badges: [],
    // 市场条目只有**一个**动作：安装（= 打开「逛市场」流程并直接进入该条目的下载/审阅）。
    // 此前的「查看与对比」与它同入口（都是开市场流程），是重复项 —— 2026-10-04 按用户要求移除。
    // 「打开来源」需要宿主的外链能力，本步不引入。
    capabilities: ['install'],
    ref: { marketId: m.id },
    detail: [
      { label: t('library.detail.id'), value: m.id },
      ...(m.author === undefined || m.author === '' ? [] : [{ label: t('library.detail.author'), value: m.author }]),
      ...(m.version === undefined || m.version === '' ? [] : [{ label: t('library.detail.version'), value: `v${m.version}` }]),
      ...(m.updatedAt === undefined ? [] : [{ label: t('library.detail.updated'), value: '', iso: m.updatedAt }]),
    ],
    searchText: [m.id, m.name, m.author ?? '', 'market', t('library.kind.market')].join(' ').toLowerCase(),
  }
}

/* ------------------------------------------------------------ 落地文件名 */

/**
 * 远端快照的**落地文件名**（「下载」与「拉取即导入」共用）。
 *
 * 为什么需要它：宿主把远端快照落地成 ZIP 时用的是 `snapshotToZip` 的临时名 `snapshot.zip`，
 * 直接落进浏览器「下载」目录会得到一堆同名文件（第二份就变成 `snapshot (1).zip`），
 * 事后也认不出是哪一份快照。这里按创建时间生成 `dsh-config-remote-<YYYYMMDD-HHmmss>.zip`。
 *
 * 两条边界：时间不是 ISO 形态 → 回退到**清洗后的**快照 id；两者都拿不到才用 `snapshot`。
 * 清洗只留 `[A-Za-z0-9._-]` —— 这个名字会进宿主 `path.join(dir, name)`，绝不能带路径分隔符。
 */
export function remoteSnapshotFileName(createdAt: string, id: string): string {
  const stamp = createdAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const safeStamp = /^\d{8}-\d{6}$/.test(stamp) ? stamp : ''
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48)
  const suffix = safeStamp !== '' ? safeStamp : safeId !== '' ? safeId : 'snapshot'
  return `dsh-config-remote-${suffix}.zip`
}

/* ------------------------------------------------------------------ 排序 */

/** 名称排序键：文本标识直接用；时间标识退化成 ISO（快照/远端快照的「名字」本就是时间） */
export function artifactSortKey(row: ArtifactRow): string {
  return row.title.kind === 'text' ? row.title.value : row.at ?? ''
}

function compareRows(a: ArtifactRow, b: ArtifactRow, sort: 'time' | 'name'): number {
  if (sort === 'name') {
    const byName = artifactSortKey(a).localeCompare(artifactSortKey(b), 'en')
    // 同名时退化为 key，保证排序**稳定且确定**（否则每次渲染顺序可能抖动）
    return byName !== 0 ? byName : a.key.localeCompare(b.key)
  }
  // 时间倒序；**缺时间的排最后**（当作「未知」，绝不当「最早」）
  if (a.at === null && b.at === null) return a.key.localeCompare(b.key)
  if (a.at === null) return 1
  if (b.at === null) return -1
  if (a.at !== b.at) return a.at < b.at ? 1 : -1
  return a.key.localeCompare(b.key)
}

function sortRows(rows: readonly ArtifactRow[], sort: 'time' | 'name'): ArtifactRow[] {
  return [...rows].sort((a, b) => compareRows(a, b, sort))
}

/* ------------------------------------------------------------------ 筛选 */

/** 来源 + 搜索词 + 排序。空查询 = 原序（恒为时间倒序，或用户选的名称序）。 */
export function filterArtifacts(rows: readonly ArtifactRow[], q: ArtifactQuery): ArtifactRow[] {
  const kind = q.kind ?? null
  const tokens = (q.text ?? '').trim().toLowerCase().split(/\s+/).filter((token) => token !== '')
  const hits = rows.filter((row) => {
    if (kind !== null && row.kind !== kind) return false
    return tokens.every((token) => row.searchText.includes(token))
  })
  return sortRows(hits, q.sort ?? 'time')
}

/** 各来源条数（筛选条上的计数；**用未筛选的行**算，否则选中一个来源后其余计数会变 0） */
export function countByKind(rows: readonly ArtifactRow[]): Record<ArtifactKind, number> {
  const counts: Record<ArtifactKind, number> = { 'snapshot': 0, 'backup-file': 0, 'remote-snapshot': 0, 'market': 0 }
  for (const row of rows) counts[row.kind] += 1
  return counts
}

export function librarySummary(rows: readonly ArtifactRow[]): LibrarySummary {
  let encrypted = 0
  let unknownSize = 0
  let known = 0
  for (const row of rows) {
    if (row.badges.includes('encrypted')) encrypted += 1
    if (row.sizeBytes === undefined) unknownSize += 1
    else known += row.sizeBytes
  }
  return {
    count: rows.length,
    counts: countByKind(rows),
    encrypted,
    unknownSize,
    // 只要有一条没体积，合计就是「未知」而不是一个偏小的数字（§6.8 ①）
    bytes: unknownSize === 0 ? known : null,
  }
}
