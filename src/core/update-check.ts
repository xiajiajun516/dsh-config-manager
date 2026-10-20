/**
 * 插件自身版本检查（update-check）—— 只读探测 npm registry，**绝不自动安装/升级**。
 *
 * 为什么需要：插件随 DSH 一起加载，用户没有任何地方能看到「我装的是不是最新版」。生态里的插件
 * （beancookie 等榜单收录的那批）都靠「有新版本可用」这一点提醒用户回访，而本插件此前只有
 * 「关于」页里一个静态版本号。本模块只回答一个问题：**npm 上的 latest 是否比当前运行版本新**。
 *
 * 四条硬边界：
 *  ① **只读、不改盘、不安装**：返回结论 + 一条用户可复制的升级命令（文案与命令在界面层组装）。
 *  ② **进程内缓存**（缺省 10 分钟）：界面首次打开/反复点「检查更新」不得把 registry 当成轮询端点；
 *     `force` 可绕过缓存（用户显式点「重新检查」）。
 *  ③ **失败必须如实**：网络不可达 / 非 200 / 响应体畸形 / 超时 / 体积超限 → 结构化 `ok:false` + 原因；
 *     绝不「失败当最新」（那会让用户以为已经是最新版，比不检查更糟）。
 *  ④ **不猜版本格式**：只有能解析成 semver 形态的 `version` 才被接受；比较复用 `validator.ts` 的
 *     同一份解析/比较规则（预发布版低于同名正式版），**不在此另写一套 semver**。
 *
 * 不读代理设置（Node 的 fetch 默认不认 HTTP_PROXY/HTTPS_PROXY）：公司网络下可能直接失败 ——
 * 这时如实报「检查失败」，其余功能不受影响（本模块与插件主干零耦合）。
 */
import { compareVersionStrings, isConcreteVersion } from './validator.ts'

/** 被检查的 npm 包名（= package.json 的 name；单点常量，勿在别处再写一份） */
export const PLUGIN_NPM_PACKAGE = 'dsh-config-manager'

/** registry 的 latest 端点（体积约数 KB，只取版本号） */
export const NPM_LATEST_URL = `https://registry.npmjs.org/${PLUGIN_NPM_PACKAGE}/latest`

/** 网络超时（ms）：界面在等，宁可快速失败也不让按钮长时间转圈 */
export const UPDATE_CHECK_TIMEOUT_MS = 5000

/** 进程内缓存时长（ms）：10 分钟 */
export const UPDATE_CHECK_CACHE_MS = 10 * 60 * 1000

/** 响应体上限（字节）：latest 端点实测约 3 KB，超过一律视为异常（不把 registry 的大响应读进内存） */
export const UPDATE_CHECK_MAX_BYTES = 64 * 1024

/** 检查成功的结果（无敏感字段；全部来自 npm 公开元数据） */
export interface PluginUpdateInfo {
  /** 当前运行的插件版本（PLUGIN_VERSION） */
  current: string
  /** npm 上的 latest */
  latest: string
  /** latest > current（严格大于；相同或更旧均为 false） */
  updateAvailable: boolean
  /** 本次结论的时间戳（ms；缓存命中时为首次检查的时间） */
  checkedAt: number
}

/** 检查结果：成功 / 失败（失败必须带原因，绝不静默当作最新） */
export type PluginUpdateResult =
  | { ok: true; info: PluginUpdateInfo; cached: boolean }
  | { ok: false; current: string; error: string }

/**
 * 解析 registry 的 latest 响应体（只认 `{ version: 'x.y.z' }`）。
 * 畸形 / 缺字段 / 版本号不是 semver 形态 → null（调用方据此报「响应异常」，不猜）。
 */
export function parseLatestVersion(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const version = (payload as Record<string, unknown>)['version']
  if (typeof version !== 'string') return null
  const trimmed = version.trim()
  return isConcreteVersion(trimmed) ? trimmed : null
}

/**
 * 请求 URL 是否要求**绕过缓存**（`?force=1`）。
 *
 * 抽在这里而不是写在路由 handler 里：路由组文件会 import 宿主入口（拿 PLUGIN_VERSION），
 * 单测不宜把它整个拖进来；这个判定是纯字符串处理，放 core 可直接 node 测。
 * 只认精确的 `force=1`（`force=true`/`force=0` 一律不算，避免「随便带个参数就绕过缓存」）。
 */
export function wantsForcedUpdateCheck(url: string | undefined): boolean {
  if (typeof url !== 'string' || url === '') return false
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  if (query === '') return false
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq) === 'force' && pair.slice(eq + 1) === '1') return true
  }
  return false
}

/** 一次网络探测的注入面（测试用桩；生产用全局 fetch 与 Date.now） */
export interface UpdateCheckDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  cacheMs?: number
  now?: () => number
}

/** 探测结果（内部用）：成功给版本号，失败给原因 */
type ProbeResult = { ok: true; version: string } | { ok: false; error: string }

/**
 * 探测 npm latest（无缓存、无状态）。任何异常都被收成 `{ ok:false, error }`：
 * 网络错误 / 超时 / 非 2xx / 体积超限 / JSON 畸形 / 版本号形态不认识。
 */
export async function probeLatestVersion(deps: UpdateCheckDeps = {}): Promise<ProbeResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch unavailable in this runtime' }
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const res = await fetchImpl(NPM_LATEST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return { ok: false, error: `registry returned HTTP ${res.status}` }
    const text = await res.text()
    if (text.length > UPDATE_CHECK_MAX_BYTES) return { ok: false, error: 'registry response too large' }
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return { ok: false, error: 'registry response is not valid JSON' }
    }
    const version = parseLatestVersion(payload)
    if (version === null) return { ok: false, error: 'registry response has no usable version' }
    return { ok: true, version }
  } catch (error) {
    const aborted = controller.signal.aborted
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: aborted ? `timed out after ${timeoutMs} ms` : `network error: ${detail}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带进程内缓存的检查器（宿主侧单例；每次请求复用同一个实例）。
 *
 * 为什么要用类而不是模块级变量：route 组文件在注册时构造一次，测试可注入 `fetchImpl`/`now`
 * 独立驱动；模块级可变状态会让并发测试互相污染。
 */
export class UpdateChecker {
  private cached: { at: number; info: PluginUpdateInfo } | null = null
  private readonly current: string
  private readonly deps: UpdateCheckDeps

  constructor(current: string, deps: UpdateCheckDeps = {}) {
    this.current = current
    this.deps = deps
  }

  /** 检查更新（缺省读缓存；`force` 绕过缓存重新探测） */
  async check(opts: { force?: boolean } = {}): Promise<PluginUpdateResult> {
    const nowMs = (this.deps.now ?? Date.now)()
    const cacheMs = this.deps.cacheMs ?? UPDATE_CHECK_CACHE_MS
    if (opts.force !== true && this.cached !== null && nowMs - this.cached.at < cacheMs) {
      return { ok: true, info: this.cached.info, cached: true }
    }
    const probe = await probeLatestVersion(this.deps)
    if (!probe.ok) return { ok: false, current: this.current, error: probe.error }
    const info: PluginUpdateInfo = {
      current: this.current,
      latest: probe.version,
      // 只有严格更新才算「有新版本」：本地跑的是更新的预发布版时不得提示降级
      updateAvailable: compareVersionStrings(probe.version, this.current) > 0,
      checkedAt: nowMs,
    }
    this.cached = { at: nowMs, info }
    return { ok: true, info, cached: false }
  }
}
