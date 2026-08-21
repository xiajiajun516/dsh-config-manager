/**
 * 「我的配置」区块的客户端纯渲染装配层（m-my-configs-view，node 可测）。
 *
 * 设计纪律（docs/design/2026-08-20-my-configs-design.md §4.5 / §4.6）：
 *  - 全部无副作用纯函数，React 壳（MyConfigsView）只装配，不承载业务逻辑；
 *  - 输入数据一律由调用方（组件 / api 层）提供 —— 本文件不发起任何请求，不持有凭据；
 *  - 录入最小化（§1.2）：表单仅 name（预填 zip 文件名，可改）/ description（可选）/
 *    categories（可选）；id / author / version / updatedAt 均为系统自动生成，
 *    界面以「系统自动」徽章展示（MY_CONFIG_AUTO_FIELDS）；
 *  - 收录状态三态（§4.5）：未收录（本地独有）｜ PR 待审核（带 PR 链接）｜ 已收录
 *    （官方 dsh-config-market/index.json 含该 id）；已收录 > PR 待审核 > 未收录
 *    （官方已收录时即使存在 open PR 也以收录为准——PR 已合并后不应再显示待审核）；
 *  - open PR 匹配按固定分支 `dsh-market-sync/<itemId>`（§2.4 自动 PR 分支约定）；
 *  - 文案走 src/ui/i18n.ts 的 UiT（'myConfigs.*' 键，zh 源 / en 镜像），不硬编码中文。
 *
 * 安全硬约束：本层只做展示推导，不接触 token / 凭据；PR URL 由调用方提供，
 * 渲染前仍过 redact() 兜底（与全站一致）。
 */
import { zhUiT, type UiT } from '../../ui/i18n.ts'
import type { UploadResult } from '../../market/my-repo.ts'
import type { MarketDownloadResult } from '../../market/types.ts'
import type { ImportResult } from '../../core/types.ts'
import type { MarketApprovals } from './market-view.ts'

/* ---------------------------------------------------------------- 登录状态展示模型 */

/**
 * 已登录状态（/me/status 返回；仅用户名等非敏感展示位，token 值永不回传浏览器）。
 * 由调用方（api 层）把宿主返回的 { loggedIn, login?, repoUrl?, repoExists? } 传入。
 */
export interface MeStatusData {
  loggedIn: boolean
  /** GitHub 登录名（展示 @login 用；非敏感） */
  login?: string
  /** 用户自己的配置仓库 URL（无则尚未创建） */
  repoUrl?: string
  /** 配置仓库是否已存在（false = 尚未创建过） */
  repoExists?: boolean
}

/** 登录状态展示模型（未登录 / 已登录 @login / token 失效）。 */
export type LoginView =
  | { kind: 'loading' }
  | { kind: 'logged-out' }
  | { kind: 'logged-in'; login: string; repoUrl: string; repoExists: boolean }
  /** token 失效（/me/status 返回 401 等鉴权错误）→ UI 引导重新登录 */
  | { kind: 'token-invalid' }

/**
 * 登录状态推导（纯函数）：loading 优先；authError 非空（401 等）→ token 失效；
 * 否则按 status.loggedIn 区分已登录 / 未登录。输入由调用方提供。
 */
export function deriveLoginState(input: {
  loading: boolean
  status: MeStatusData | null
  /** 鉴权错误信号（/me/status 调用失败或 401）；null = 无 */
  authFailed: boolean
}): LoginView {
  if (input.loading) return { kind: 'loading' }
  if (input.authFailed) return { kind: 'token-invalid' }
  const s = input.status
  if (s !== null && s.loggedIn) {
    return {
      kind: 'logged-in',
      login: s.login ?? '',
      repoUrl: s.repoUrl ?? '',
      repoExists: s.repoExists ?? false,
    }
  }
  return { kind: 'logged-out' }
}

/* ---------------------------------------------------------------- 上传表单模型 */

/**
 * 一键上传/更新表单（§2.4 用户输入最小化）：仅名称（必填，预填 zip 文件名可改）/
 * 描述（可选）/ 类别（可选，逗号分隔原始文本）。id/author/version/updatedAt
 * 均由系统自动生成，不在表单里。
 * `id` 为**更新模式内部字段**（「更新」按钮预填条目 id，避免后端靠 name→slug 猜错），
 * 不渲染为输入框；上传模式恒为空串。
 */
export interface MyConfigForm {
  name: string
  description: string
  /** 类别原始文本（逗号分隔；UI 解析为数组，空串 = 无类别） */
  categories: string
  /** 更新目标条目 id（update 模式预填；upload 模式空串） */
  id: string
}

/** 空表单初值（React 壳 useState 初始 + 测试用）。 */
export const EMPTY_MY_CONFIG_FORM: MyConfigForm = { name: '', description: '', categories: '', id: '' }

/** 表单字段错误（null = 该字段合法；文案已翻译）。 */
export interface MyConfigFormErrors {
  name: string | null
}

/** 表单校验：名称必填（trim 后非空）。描述/类别可选。 */
export function validateMyConfigForm(form: MyConfigForm, t: UiT = zhUiT): MyConfigFormErrors {
  return { name: form.name.trim() === '' ? t('myConfigs.form.errorName') : null }
}

/** 表单是否全部合法（上传按钮可用性）。 */
export function myConfigFormValid(errors: MyConfigFormErrors): boolean {
  return errors.name === null
}

/** 逗号分隔类别文本 → 去空白数组（空结果 = 无类别；与 PublishView 相同语义）。 */
export function parseCategories(csv: string): string[] {
  return csv.split(',').map((c) => c.trim()).filter((c) => c !== '')
}

/* ---------------------------------------------------------------- 上传/更新向导状态模型 */

/**
 * 上传结果（对齐 host 半 my-repo.ts 的 UploadResult 类型，避免客户端各层重复声明）。
 * 纯 JSON 无 token：error/listingError 在宿主侧已脱敏；可安全持久化。
 */
export type MyUploadResult = UploadResult

/**
 * 上传/更新向导的运行时全量状态（迁移自 MyConfigsView 组件内私有 WizardState）。
 * validating/validated/running/formErrors 为瞬态/派生字段：不进入持久化切片
 * （MyWizardSlice）；validated 虽为瞬态，但「是否已校验通过」值得随切片保留，
 * 恢复后由组件结合 zipPath 决定是否自动重校验（详见 restoreMyWizard 注释）。
 */
export interface MyWizardState {
  mode: 'upload' | 'update'
  step: 'select' | 'validate' | 'form'
  zipPath: string | null
  fileName: string | null
  /** 瞬态：校验进行中（不持久化，恢复后恒 false） */
  validating: boolean
  /** 瞬态：最近一次校验是否通过（切片保留，恢复后由组件决定是否重校验） */
  validated: boolean
  validationError: string | null
  form: MyConfigForm
  /** 派生：由 validateMyConfigForm(form) 重算（不持久化） */
  formErrors: MyConfigFormErrors
  /** 瞬态：上传/更新请求进行中（不持久化，恢复后恒 false） */
  running: boolean
  result: MyUploadResult | null
  error: string | null
}

/** 向导初始状态常量（initialWizard('upload') 语义；调用方应经 initialWizard 获取新对象）。 */
export const EMPTY_MY_WIZARD: MyWizardState = {
  mode: 'upload',
  step: 'select',
  zipPath: null,
  fileName: null,
  validating: false,
  validated: false,
  validationError: null,
  form: { ...EMPTY_MY_CONFIG_FORM },
  formErrors: { name: null },
  running: false,
  result: null,
  error: null,
}

/**
 * 向导的持久化切片 = 全量状态去掉瞬态/派生字段（validating/running/formErrors）。
 * formErrors 恢复时由 restoreMyWizard 经 validateMyConfigForm 重算；validating/running 恢复后恒 false。
 * 仅非敏感字段：zipPath 为宿主受控临时文件路径、form 为用户输入描述性内容（含 update 模式的
 * 公开条目 id）、result 为无 token 的 UploadResult —— 与 run-store market 切片整体落盘纪律一致。
 */
export interface MyWizardSlice {
  mode: 'upload' | 'update'
  step: 'select' | 'validate' | 'form'
  zipPath: string | null
  fileName: string | null
  validated: boolean
  validationError: string | null
  form: MyConfigForm
  result: MyUploadResult | null
  error: string | null
}

/** 全量状态 → 持久化切片（忽略 validating/running/formErrors；form 浅拷贝，result 直接引用纯 JSON）。 */
export function toMyWizardSlice(w: MyWizardState): MyWizardSlice {
  return {
    mode: w.mode,
    step: w.step,
    zipPath: w.zipPath,
    fileName: w.fileName,
    validated: w.validated,
    validationError: w.validationError,
    form: { ...w.form },
    result: w.result,
    error: w.error,
  }
}

/**
 * 持久化切片 → 全量状态（null → 全新向导）。瞬态字段归零（validating/running 恒 false），
 * formErrors 按 form 经 validateMyConfigForm 重算；form 拷贝新对象（不共享切片引用）。
 */
export function restoreMyWizard(slice: MyWizardSlice | null): MyWizardState {
  if (slice === null) return { ...EMPTY_MY_WIZARD, form: { ...EMPTY_MY_CONFIG_FORM } }
  return {
    mode: slice.mode,
    step: slice.step,
    zipPath: slice.zipPath,
    fileName: slice.fileName,
    validating: false,
    validated: slice.validated,
    validationError: slice.validationError,
    form: { ...slice.form },
    formErrors: validateMyConfigForm(slice.form),
    running: false,
    result: slice.result,
    error: slice.error,
  }
}

/** 指定模式的向导初始状态（form 全新空表；mode/step 之外同 EMPTY_MY_WIZARD）。 */
export function initialWizard(mode: 'upload' | 'update'): MyWizardState {
  return { ...EMPTY_MY_WIZARD, mode, form: { ...EMPTY_MY_CONFIG_FORM } }
}

/* ---------------------------------------------------------------- 装回本地状态模型 */

/**
 * 装回本地（下载 + 逐分区批准 + 执行导入）的运行时全量状态。
 * importing 为瞬态：不进入持久化切片（MyInstallSlice）；approvals（逐分区批准）是
 * 用户昂贵的人工决策，必须随切片保留（切 tab/刷新不丢）。
 */
export interface MyInstallState {
  itemId: string
  detail: MarketDownloadResult | null
  /** 逐分区批准表（安全不变式 (c)：高风险分区默认不勾选） */
  approvals: MarketApprovals
  /** 瞬态：导入执行中（不持久化，恢复后恒 false） */
  importing: boolean
  importResult: ImportResult | null
  error: string | null
}

/**
 * 装回本地的持久化切片 = 全量状态去掉瞬态（importing）。
 * 仅非敏感字段：detail.zipPath 为宿主受控临时文件路径、approvals 为布尔批准表、
 * importResult 为纯 JSON、error 为已 redact 文本 —— 与 run-store market 切片整体落盘纪律一致。
 */
export interface MyInstallSlice {
  itemId: string
  detail: MarketDownloadResult | null
  approvals: MarketApprovals
  importResult: ImportResult | null
  error: string | null
}

/** 全量状态 → 持久化切片（忽略 importing；detail/approvals/importResult 直接引用纯 JSON/布尔表）。 */
export function toMyInstallSlice(s: MyInstallState): MyInstallSlice {
  return {
    itemId: s.itemId,
    detail: s.detail,
    approvals: s.approvals,
    importResult: s.importResult,
    error: s.error,
  }
}

/** 持久化切片 → 全量状态（null → 无装回本地会话；importing 恢复后恒 false）。 */
export function restoreMyInstall(slice: MyInstallSlice | null): MyInstallState | null {
  if (slice === null) return null
  return {
    itemId: slice.itemId,
    detail: slice.detail,
    approvals: slice.approvals,
    importing: false,
    importResult: slice.importResult,
    error: slice.error,
  }
}

/* ---------------------------------------------------------------- 系统自动字段徽章 */

/** 系统自动字段（表单不用填，UI 以「系统自动」徽章展示，§2.4）。 */
export const MY_CONFIG_AUTO_FIELDS = ['id', 'author', 'version', 'updatedAt'] as const
export type MyConfigAutoField = (typeof MY_CONFIG_AUTO_FIELDS)[number]

/** 系统自动字段的徽章展示（label 走 myConfigs.field.* 键；autoText = 「系统自动」）。 */
export interface AutoFieldBadge {
  field: MyConfigAutoField
  label: string
  autoText: string
}

/** 系统自动字段徽章列表（id/作者/版本/更新时间 → 「系统自动」徽章）。 */
export function autoFieldBadges(t: UiT = zhUiT): AutoFieldBadge[] {
  const autoText = t('myConfigs.autoField')
  const labels: { field: MyConfigAutoField; label: string }[] = [
    { field: 'id', label: t('myConfigs.field.id') },
    { field: 'author', label: t('myConfigs.field.author') },
    { field: 'version', label: t('myConfigs.field.version') },
    { field: 'updatedAt', label: t('myConfigs.field.updatedAt') },
  ]
  return labels.map(({ field, label }) => ({ field, label, autoText }))
}

/* ---------------------------------------------------------------- 已上传条目列表投影 */

/**
 * 用户仓库（<login>/dsh-configs）index.json 的条目（§4.1 形态；调用方 / api 层提供，
 * 与 MarketIndexItem 同构子集，字段缺失由投影兜底）。
 */
export interface MyItemSource {
  id: string
  name?: string
  version?: string
  updatedAt?: string
  categories?: string[]
  author?: string
  /** 来源仓库 star 数（仓库级；可选，缺省无数据） */
  stars?: number
}

/** 收录状态徽章模板：语义 + 展示文本（kind 对应用户列表徽章四态之一）。 */
export interface ItemStatusBadge {
  kind: 'ok' | 'info' | 'warn'
  text: string
  /** PR 待审核时携带 PR 链接（供「带 PR 链接」行操作/徽章） */
  prUrl?: string
  /** PR 编号（PR 待审核时；供展示 #N） */
  prNumber?: number
}

/** 收录状态（§4.5）：未收录 / PR 待审核（带 PR 链接）/ 已收录。 */
export type ItemStatus =
  | { kind: 'not-listed' }
  | { kind: 'pending-pr'; prUrl: string; prNumber?: number }
  | { kind: 'listed' }

/** open PR 信息（调用方 / api 层从官方市场仓库 pulls 列表提供）。 */
export interface OpenPrInfo {
  number: number
  url: string
  /** PR head 分支名（匹配 dsh-market-sync/<itemId>） */
  head: string
}

/**
 * 自动收录 PR 的固定分支前缀（设计文档 §2.4）：`dsh-market-sync/<itemId>`。
 * 同一约定由 host 半（MyRepoService）生成分支、client 半（本模型/api 层）匹配 PR，
 * 此常量是 client 侧的唯一事实源；调用方组装 OpenPrInfo.head 时应使用
 * `MARKET_SYNC_PR_BRANCH_PREFIX + itemId`，不要内联字符串。
 */
export const MARKET_SYNC_PR_BRANCH_PREFIX = 'dsh-market-sync/'

/** 按固定分支约定生成条目对应的 PR head 分支名。 */
export function prBranchFor(itemId: string): string {
  return `${MARKET_SYNC_PR_BRANCH_PREFIX}${itemId}`
}

/**
 * 收录状态推导（§4.5）：
 * - officialListed = 官方 dsh-config-market/index.json 含该 id → 已收录；
 * - 否则 openPr 匹配（head 分支 = dsh-market-sync/<itemId>）→ PR 待审核（带链接）；
 * - 否则未收录（本地独有）。
 * 优先级：已收录 > PR 待审核 > 未收录。
 */
export function deriveItemStatus(input: {
  /** 用户仓库 index 条目 */
  item: MyItemSource
  /** 官方 index 是否含该 id */
  officialListed: boolean
  /** 面向该条目的 open PR（head 分支）；无则 null */
  openPr: OpenPrInfo | null
}): ItemStatus {
  if (input.officialListed) return { kind: 'listed' }
  if (input.openPr !== null) {
    return { kind: 'pending-pr', prNumber: input.openPr.number, prUrl: input.openPr.url }
  }
  return { kind: 'not-listed' }
}

/**
 * Host 侧收录状态桥（§4.5 在 Host 判定）→ 客户端判别联合 ItemStatus：
 * my-repo.ts 的 MyItemStatus = 'not-listed' | 'pr-pending' | 'listed'，
 * prUrl 在 pr-pending 时由 Host 提供；prNumber 可选（Host 未提供时缺省）。
 * 纯映射，无副作用；MyConfigsView 消费 /me/items 条目时经此桥转徽章模型。
 */
export function itemStatusFromHost(entry: {
  status: 'not-listed' | 'pr-pending' | 'listed'
  prUrl?: string
  prNumber?: number
}): ItemStatus {
  switch (entry.status) {
    case 'listed':
      return { kind: 'listed' }
    case 'pr-pending':
      return { kind: 'pending-pr', prUrl: entry.prUrl ?? '', prNumber: entry.prNumber }
    default:
      return { kind: 'not-listed' }
  }
}

/** 收录状态 → 徽章模板（ok=已收录 / warn=PR 待审核 / info=未收录）。 */
export function itemStatusBadge(status: ItemStatus, t: UiT = zhUiT): ItemStatusBadge {
  switch (status.kind) {
    case 'listed':
      return { kind: 'ok', text: t('myConfigs.status.listed') }
    case 'pending-pr':
      return { kind: 'warn', text: t('myConfigs.status.pendingPr'), prUrl: status.prUrl, prNumber: status.prNumber }
    case 'not-listed':
      return { kind: 'info', text: t('myConfigs.status.notListed') }
  }
}

/** 已上传条目列表的投影行（字段缺失给安全默认，展示零容错）。 */
export interface MyItemView {
  id: string
  name: string
  version: string
  updatedAt: string
  categories: string[]
  author: string
  /** 来源仓库（<login>/dsh-configs）的 star 数（仓库级；undefined = 无数据，UI 显示「—」） */
  stars?: number
  /** 状态推导结果（调用方传入 status 或经 buildMyItemsView 装配） */
  status: ItemStatus
  /** 徽章模板（kind + 文案 + PR 链接） */
  badge: ItemStatusBadge
}

/** 条目投影：缺失字段给默认值（name 缺省回退 id；其余空串/空数组）。 */
export function toMyItemView(item: MyItemSource, status: ItemStatus, t: UiT = zhUiT): MyItemView {
  return {
    id: item.id,
    name: item.name !== undefined && item.name.trim() !== '' ? item.name : item.id,
    version: item.version ?? '',
    updatedAt: item.updatedAt ?? '',
    categories: item.categories ?? [],
    author: item.author ?? '',
    ...('stars' in item && typeof item.stars === 'number' ? { stars: item.stars } : {}),
    status,
    badge: itemStatusBadge(status, t),
  }
}

/** 列表级装配入参：用户仓库条目 + 官方已收录 id 集合 + open PR 列表。 */
export interface MyItemsInput {
  items: MyItemSource[]
  /** 官方 dsh-config-market/index.json 中存在的条目 id 集合 */
  officialListedIds: ReadonlySet<string>
  /** 官方市场仓库的 open PR 列表（head 分支匹配 dsh-market-sync/<itemId>） */
  openPrs: OpenPrInfo[]
}

/** 列表级装配：每条目推导收录状态 + 投影 + 徽章（React 壳只渲染）。 */
export function buildMyItemsView(input: MyItemsInput, t: UiT = zhUiT): MyItemView[] {
  return input.items.map((item) => {
    const officialListed = input.officialListedIds.has(item.id)
    const openPr = input.openPrs.find((p) => p.head === prBranchFor(item.id)) ?? null
    const status = deriveItemStatus({ item, officialListed, openPr })
    return toMyItemView(item, status, t)
  })
}

/** 列表摘要（空列表 → 全零；React 壳做统计行渲染）。 */
export interface MyItemsSummary {
  total: number
  listed: number
  pendingPr: number
  notListed: number
}

/** 列表摘要统计（按 status 分类计数）。 */
export function summarizeMyItems(views: readonly MyItemView[]): MyItemsSummary {
  let listed = 0
  let pendingPr = 0
  let notListed = 0
  for (const v of views) {
    if (v.status.kind === 'listed') listed += 1
    else if (v.status.kind === 'pending-pr') pendingPr += 1
    else notListed += 1
  }
  return { total: views.length, listed, pendingPr, notListed }
}