/**
 * 同步通道「仓库选择器」的**框架无关纯逻辑**（t42 分层：可测部分放 src/ui）。
 *
 * 背景（用户实测要求）：同步通道原先只能手填仓库地址 —— 用户得自己去 GitHub 建仓库、
 * 复制 clone URL、再回来粘贴。本模块支撑「选择已有仓库 / 新建仓库」两条路径。
 *
 * 分层约定（与 src/ui/sync-settings-view.ts 同款）：
 * - 本模块**不 import src/client/**（避免 ui → client 反向依赖，也让 node 可直接测）；
 *   宿主 DTO 与本模块的 `RepoPickerRepo` 结构同形，可直接传入（类型变了 typecheck 会报出来）；
 * - 只放「派生计算 / 校验 / 请求体组装 / 格式化」，不放 React、不碰网络。
 *
 * 安全语义（与宿主端点一致，这里是 UI 侧的第二道口径）：
 * - **同步仓库必须私有**：公开仓库会把配置内容公开，故 `repoPickerRepos` 只保留
 *   `private === true` 的仓库 —— 即使宿主将来放宽，选择器也不会把公开仓库摆到用户面前；
 * - 新建仓库的请求体**不带 private 字段**：宿主对 `POST /sync/github/repositories` 恒定
 *   以 private:true 建仓（安全约束在宿主侧强制），UI 不传反而是更强的口径 ——
 *   客户端没有任何途径把「公开」这个意图送出去。
 */
import type { SelectOption } from './select-model.ts'

/** 仓库列表条目（与宿主 `GitHubRepoSummary` 同形：结构类型，客户端对象可直接传入）。 */
export interface RepoPickerRepo {
  /** `owner/name`（GitHub 的 full_name；仅作展示与去重，不作为提交值） */
  fullName: string
  /** 提交值：选择后写进表单的仓库地址（https 形态，绝不含凭据） */
  cloneUrl: string
  private: boolean
  fork: boolean
  /** 最近一次 push（ISO 8601；空仓库 / 缺字段 → 空串） */
  pushedAt: string
  /** 最近一次更新（ISO 8601；缺字段 → 空串） */
  updatedAt: string
}

/**
 * 「＋ 新建私有仓库…」选项的哨兵值。
 *
 * 为什么用哨兵而不是「额外按钮」：Select 只能提交字符串，把「新建」混进同一个下拉
 * 让两条路径共享同一处交互（选中即展开表单），也避免在字段旁再堆一个动作按钮。
 * 前缀 `__` 保证不会与真实仓库地址（https://…）撞值。
 */
export const REPO_PICKER_CREATE_VALUE = '__create__'

/** 仓库名长度上限（GitHub 的硬限制；超长必然被拒，本地先挡掉给即时反馈）。 */
export const REPO_NAME_MAX_LENGTH = 100

/** 仓库名非法字符（GitHub 允许字母/数字/点/下划线/连字符）。 */
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

/** ISO 时间 → 毫秒；空串 / 非法 → null（排序与展示都按「未知」处理，不猜）。 */
function timeOf(iso: string): number | null {
  if (iso === '') return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

/**
 * 可选择的仓库清单：**只留私有**，按最近更新降序。
 *
 * 排序用 `updatedAt`（不是 `pushedAt`）：用户刚建的仓库还没有 push，`pushedAt` 是空的，
 * 按它排会把「刚建好、正准备用」的那个仓库沉到列表底部。时间未知（空 / 非法）排最后。
 */
export function repoPickerRepos(repos: readonly RepoPickerRepo[]): RepoPickerRepo[] {
  return repos
    .filter((repo) => repo.private)
    .map((repo, index) => ({ repo, index }))
    .sort((a, b) => {
      const ta = timeOf(a.repo.updatedAt)
      const tb = timeOf(b.repo.updatedAt)
      if (ta === tb) return a.index - b.index
      if (ta === null) return 1
      if (tb === null) return -1
      return tb - ta
    })
    .map((entry) => entry.repo)
}

/** `owner/name` → `name`（仓库都是当前用户自己的，下拉里重复 owner 只是噪音）。 */
export function repoShortName(fullName: string): string {
  const slash = fullName.lastIndexOf('/')
  return slash < 0 ? fullName : fullName.slice(slash + 1)
}

/**
 * 仓库地址归一化：去空白、去尾斜杠、去 `.git` 后缀、协议与主机小写。
 *
 * 为什么需要：GitHub 对同一个仓库给出多种等价写法（`https://github.com/u/r`、
 * `https://github.com/u/r.git`、尾斜杠、大小写不同的主机名），用户手填的形态无法预期；
 * 不归一化就会出现「明明选的就是这个仓库，下拉却显示未选中」。
 */
export function normalizeRepoUrl(url: string): string {
  let out = url.trim()
  while (out.endsWith('/')) out = out.slice(0, -1)
  if (out.toLowerCase().endsWith('.git')) out = out.slice(0, -4)
  const schemeEnd = out.indexOf('://')
  if (schemeEnd < 0) return out
  const scheme = out.slice(0, schemeEnd + 3).toLowerCase()
  const rest = out.slice(schemeEnd + 3)
  const slash = rest.indexOf('/')
  if (slash < 0) return scheme + rest.toLowerCase()
  return scheme + rest.slice(0, slash).toLowerCase() + rest.slice(slash)
}

/**
 * 当前表单里的仓库地址对应哪个下拉选项；命中 → cloneUrl，未命中 → 空串。
 *
 * 未命中时返回空串（而不是回显地址）是有意的：Select 对空值显示 `placeholder`，
 * 让「手填的 / 不在列表里的仓库」明确呈现为「自定义地址」这一状态，而不是伪装成已选中项。
 */
export function repoPickerValueFor(repoUrl: string, repos: readonly RepoPickerRepo[]): string {
  const target = normalizeRepoUrl(repoUrl)
  if (target === '') return ''
  // 与 repoPickerOptions 同口径：公开仓库不在选择器里，填了它的地址也不算「已选中」
  for (const repo of repoPickerRepos(repos)) {
    if (normalizeRepoUrl(repo.cloneUrl) === target) return repo.cloneUrl
  }
  return ''
}

/**
 * 下拉选项：私有仓库（最近更新在前）+ 末尾的「新建」项。
 *
 * 仓库标签由调用方本地化（`label` 回调），本模块不碰字典 —— 与 sync-settings-view.ts
 * 「不在本层做 i18n」同一条纪律。`updatedAt` 为空时 `label` 收到空串，由调用方决定省略。
 */
export function repoPickerOptions(
  repos: readonly RepoPickerRepo[],
  label: (repo: RepoPickerRepo, shortName: string) => string,
  createLabel: string,
): SelectOption[] {
  const options: SelectOption[] = repoPickerRepos(repos).map((repo) => ({
    value: repo.cloneUrl,
    label: label(repo, repoShortName(repo.fullName)),
  }))
  options.push({ value: REPO_PICKER_CREATE_VALUE, label: createLabel })
  return options
}

/** 仓库名校验结果（`null` = 合法；其余为错误类别，文案由调用方本地化）。 */
export type RepoNameError = 'empty' | 'invalid' | null

/**
 * 仓库名校验（本地预检，给即时反馈；最终仍以 GitHub 的 422 为准）。
 * GitHub 规则：字母/数字/点/下划线/连字符，最长 100，不得以点开头。
 */
export function repoNameError(name: string): RepoNameError {
  const trimmed = name.trim()
  if (trimmed === '') return 'empty'
  if (trimmed.length > REPO_NAME_MAX_LENGTH) return 'invalid'
  if (trimmed.startsWith('.')) return 'invalid'
  if (!REPO_NAME_PATTERN.test(trimmed)) return 'invalid'
  return null
}

/**
 * 新建仓库请求体。
 *
 * **刻意不带 `private`**：宿主对这条端点恒定以 private:true 建仓（安全约束在宿主侧强制），
 * 客户端连「公开」这个意图都无法表达。`description` 为空则整个字段不传（不写空串，
 * 免得 GitHub 上出现一堆空描述）。
 */
export function repoCreateBody(name: string, description: string): { name: string; description?: string } {
  const trimmedName = name.trim()
  const trimmedDesc = description.trim()
  return trimmedDesc === '' ? { name: trimmedName } : { name: trimmedName, description: trimmedDesc }
}

/**
 * 仓库更新时间展示（`updatedAt` ISO → 本地时间字符串）。
 *
 * 空串 → 空串（调用方据此省略整段）；非法值 → 原样回显（宁可显示原始值也不显示空白或
 * `Invalid Date`）；与 src/ui/snapshots-view.ts:170 同一口径（`toLocaleString()`）。
 */
export function formatRepoUpdatedAt(iso: string, locale?: string): string {
  if (iso === '') return ''
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const date = new Date(ms)
  return locale === undefined ? date.toLocaleString() : date.toLocaleString(locale)
}
/**
 * 仓库列表是否该**自动加载**（不要求用户先点开下拉）。
 *
 * 用户反馈（2026-11-08）：GitHub 登录成功后界面没有任何提示，列表也不会自己出现 ——
 * 必须手动点一下「从我的仓库中选择」才知道成功了。这里把「该拉列表」的判定收成一条纯函数，
 * 三个触发点共用：弹窗打开、登录状态由「未登录」变「已登录」、表单里已经有地址。
 *
 * 规则：
 * - 弹窗没打开 / 已加载过 / 正在加载 → 不重复发请求；
 * - `failed` 为真 → 不自动重试（否则每次重渲染都会打一次必然失败的请求；重试由「刷新列表」或
 *   登录状态变化后的复位负责）。
 * - 未登录且地址为空 → 保持惰性（此时拉列表必然 401，白跑一次网络）。
 */
export function shouldAutoLoadRepos(input: {
  open: boolean
  signedIn: boolean | null
  loaded: boolean
  loading: boolean
  failed: boolean
  repoUrl: string
}): boolean {
  if (!input.open || input.loaded || input.loading || input.failed) return false
  return input.signedIn === true || input.repoUrl.trim() !== ''
}
