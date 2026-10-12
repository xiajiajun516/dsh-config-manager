/**
 * 插件私有出站代理（issue #30）。
 *
 * 背景：Node 内置 `fetch()`（undici）**默认不读** `HTTP_PROXY` / `HTTPS_PROXY`，因此「必须经代理
 * 访问 GitHub」的网络下，GitHub 登录（device flow）与市场 API 全部失败（`fetch failed`），
 * 而浏览器与 git 都正常。全局开关（`NODE_USE_ENV_PROXY` / `http.setGlobalProxyFromEnv()`）虽然
 * 有效，但那是**进程级**的：它会连带改变宿主自身（含模型 API）的出站行为 —— 一个备份插件不该
 * 有这种越界副作用（且该 API 需 Node ≥ 24.14，覆盖不全）。
 *
 * 本模块只服务本插件自己的出站请求，**不改动任何全局状态**，且**零第三方依赖**：
 *  - `http:` 目标经 HTTP 代理 → 使用 absolute-form 请求（`GET http://host/path HTTP/1.1`）；
 *  - `https:` 目标经 HTTP 代理 → 自行完成 `CONNECT` 隧道，再在该 socket 上叠加 TLS（SNI 保留）；
 *  - 命中 `NO_PROXY` 或未配置代理 → 完全直连，行为与未启用前一致。
 *
 * 与全局开关的分工：插件侧默认直连（不改变现状）；仅当检测到代理环境变量时才启用代理路由。
 * 如需在已配置代理的环境下刻意直连，设置 `DSH_CONFIG_MANAGER_PROXY=off`。
 *
 * 安​全：代理 URL 的 userinfo（账号/密码）只用于 `Proxy-Authorization` 头，绝不进日志；
 * `describeProxy()` 输出的代理描述已剥离凭据；跨源重定向剥离 `authorization`（GitHub token
 * 绝不转发给第三方域名）。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { utilsMsg } from './messages-utils.ts'

/** 代理相关环境变量（大小写兼容后的归一形态） */
export interface ProxyEnv {
  /** http 目标使用的代理（`HTTP_PROXY` / `http_proxy`） */
  httpProxy: string | null
  /** https 目标使用的代理（`HTTPS_PROXY` / `https_proxy`） */
  httpsProxy: string | null
  /** 直连白名单（`NO_PROXY` / `no_proxy`） */
  noProxy: string | null
}

/** 环境变量开关：`DSH_CONFIG_MANAGER_PROXY=off|none|0` 时即使配了代理也强制直连（调试/特殊情况）。 */
const PROXY_OFF_VALUES = new Set(['off', 'none', '0', 'false', 'disable', 'disabled'])

/** 隧道建立与单次请求的默认上限（避免代理不可达时无限挂起）。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/**
 * 默认 User-Agent（issue #86）。
 *
 * node 原生 `http`/`https` **不会**像 undici 那样自动补 UA，而本模块正是「配了代理」时唯一
 * 的出站通道 —— 于是同一份代码出现「不配代理能用、配了代理反而 403」（GitHub 前置层直接拒绝
 * 无 UA 请求）。统一兜底使两条通道的请求语义一致；调用方显式传入时绝不覆盖。
 */
const DEFAULT_USER_AGENT = 'DSH-Config-Manager'

/** 视为可跟随的重定向状态码（与 WebDAV 通道同一套语义） */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 不能带响应体的状态码（`new Response(body, {status})` 会抛错） */
const BODYLESS_STATUSES = new Set([101, 204, 205, 304])

/** 取第一个非空值（环境变量大小写与平台差异的归一） */
function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

/** 读代理环境变量（纯函数，便于测试注​入任意 env） */
export function readProxyEnv(env: Record<string, string | undefined> = process.env): ProxyEnv {
  const off = firstNonEmpty(env['DSH_CONFIG_MANAGER_PROXY'])
  if (off !== null && PROXY_OFF_VALUES.has(off.toLowerCase())) {
    return { httpProxy: null, httpsProxy: null, noProxy: null }
  }
  return {
    httpProxy: firstNonEmpty(env['HTTP_PROXY'], env['http_proxy']),
    httpsProxy: firstNonEmpty(env['HTTPS_PROXY'], env['https_proxy']),
    noProxy: firstNonEmpty(env['NO_PROXY'], env['no_proxy']),
  }
}

/** 是否配置了任何代理（用于启动日志与「是否需要走代理链路」的判定） */
export function isProxyConfigured(env: ProxyEnv = readProxyEnv()): boolean {
  return env.httpProxy !== null || env.httpsProxy !== null
}

/** `host[:port]` 切分（兼容 IPv6 方括号形态）；无端口 → null */
function splitHostPort(entry: string): { host: string; port: string | null } {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']')
    if (end !== -1) {
      const host = entry.slice(0, end + 1)
      const rest = entry.slice(end + 1)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host, port: null }
    }
    return { host: entry, port: null }
  }
  const at = entry.lastIndexOf(':')
  // 仅当冒号后全是数字才视作端口（避免把裸 IPv6 误切）
  if (at !== -1 && /^\d+$/.test(entry.slice(at + 1))) {
    return { host: entry.slice(0, at), port: entry.slice(at + 1) }
  }
  return { host: entry, port: null }
}

/**
 * 目标是否命中 `NO_PROXY`。
 * 支持：`*`（全直连）、精确主机、`.example.com` 与 `example.com`（含子域）、可选 `:port` 限定。
 */
export function matchesNoProxy(host: string, port: string, noProxy: string | null): boolean {
  if (noProxy === null) return false
  const target = host.toLowerCase()
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const { host: entryHost, port: entryPort } = splitHostPort(entry)
    if (entryPort !== null && entryPort !== port) continue
    const bare = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost
    if (bare === '') continue
    if (target === bare || target.endsWith(`.${bare}`)) return true
  }
  return false
}

/** URL 的有效端口（缺省按协议补） */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * 该目标应使用的代理 URL；无需代理（未配置 / 命中 NO_PROXY / 非法）→ null。
 *
 * 选择规则（对齐 undici `EnvHttpProxyAgent` 的直觉语义）：
 *  - `https:` 目标 → `HTTPS_PROXY`，缺省回退 `HTTP_PROXY`；
 *  - `http:` 目标 → `HTTP_PROXY`，缺省回退 `HTTPS_PROXY`。
 */
export function proxyUrlFor(target: string | URL, env: ProxyEnv = readProxyEnv()): string | null {
  let url: URL
  try {
    url = typeof target === 'string' ? new URL(target) : target
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (matchesNoProxy(url.hostname, effectivePort(url), env.noProxy)) return null
  const candidate = url.protocol === 'https:'
    ? (env.httpsProxy ?? env.httpProxy)
    : (env.httpProxy ?? env.httpsProxy)
  if (candidate === null) return null
  try {
    const proxy = new URL(candidate.includes('://') ? candidate : `http://${candidate}`)
    if (proxy.hostname === '') return null
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') return null
    return proxy.toString()
  } catch {
    return null
  }
}

/** 代理的**脱敏**描述（供日志/报错提示；凭据一律剥离，绝不外泄） */
export function describeProxy(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl)
    return `${u.protocol}//${u.hostname}${u.port !== '' ? `:${u.port}` : ''}`
  } catch {
    return '(invalid proxy)'
  }
}

/** 一次性 socket 的 agent（隧道已建立；keepAlive 关闭，用完即毁） */
class TunnelAgent extends https.Agent {
  private readonly tunnel: net.Socket
  constructor(tunnel: net.Socket) {
    super({ keepAlive: false, maxSockets: 1 })
    this.tunnel = tunnel
  }
  override createConnection(): net.Socket {
    return this.tunnel
  }
}

/** 建立到代理的连接（代理本身可能是 https） */
function connectToProxy(proxy: URL, timeoutMs: number): Promise<net.Socket> {
  const port = Number(proxy.port !== '' ? proxy.port : (proxy.protocol === 'https:' ? 443 : 80))
  return new Promise((resolve, reject) => {
    const onConnect = (): void => { socket.setTimeout(0); resolve(socket) }
    const socket = proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port, servername: proxy.hostname }, onConnect)
      : net.connect({ host: proxy.hostname, port }, onConnect)
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      reject(new Error(utilsMsg('utils.proxy.connectTimeout', { ms: timeoutMs })))
    })
    socket.once('error', (err) => { reject(err) })
  })
}

/**
 * 经 HTTP 代理建立到目标的隧道（`CONNECT host:port`）。
 * 返回的 socket 已与目标建立字节通道；https 目标再由调用方叠加 TLS。
 */
async function openTunnel(target: URL, proxy: URL, timeoutMs: number): Promise<net.Socket> {
  const socket = await connectToProxy(proxy, timeoutMs)
  const targetPort = effectivePort(target)
  const authority = `${target.hostname}:${targetPort}`
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    // 代理凭据只在此处使用，绝不写日志
    ...(proxy.username !== '' || proxy.password !== ''
      ? [`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`]
      : []),
    'Proxy-Connection: keep-alive',
    '',
    '',
  ]
  return await new Promise<net.Socket>((resolve, reject) => {
    let buffered = ''
    const fail = (message: string): void => {
      socket.destroy()
      reject(new Error(message))
    }
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1')
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffered.length > 8192) {
          socket.off('data', onData)
          fail(utilsMsg('utils.proxy.malformedConnectResponse'))
        }
        return
      }
      socket.off('data', onData)
      const head = buffered.slice(0, end)
      const status = Number((head.split('\r\n')[0] ?? '').split(' ')[1])
      if (status !== 200) {
        fail(utilsMsg('utils.proxy.refusedConnect', { status }))
        return
      }
      // CONNECT 响应头之后的字节已属隧道数据 → 回填，避免 TLS 握手丢包
      const rest = Buffer.from(buffered.slice(end + 4), 'latin1')
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
    socket.once('error', (err) => { socket.off('data', onData); reject(err) })
    socket.once('close', () => { socket.off('data', onData); reject(new Error(utilsMsg('utils.proxy.closedDuringConnect'))) })
    socket.write(lines.join('\r\n'))
  })
}

/** 单次请求的输入 */
export interface RawRequestOptions {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: Buffer | string | undefined
  timeoutMs?: number
  signal?: AbortSignal
  env?: ProxyEnv
}

/** 单次请求的响应（始终缓冲完整响应体；插件用到的响应体都是小 JSON/文本） */
export interface RawResponse {
  status: number
  statusText: string
  headers: Headers
  body: Buffer
}

/** 请求结果归一到 node 的 IncomingMessage（直连与经代理两条路径共用收尾逻辑） */
function collectResponse(res: http.IncomingMessage, timeoutMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    res.on('end', () => {
      const headers = new Headers()
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const v of value) headers.append(key, v)
        else headers.set(key, String(value))
      }
      resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? '',
        headers,
        body: Buffer.concat(chunks),
      })
    })
    res.on('error', reject)
    if (timeoutMs > 0) {
      res.setTimeout(timeoutMs, () => {
        res.destroy()
        reject(new Error(`Request timed out after ${timeoutMs}ms`))
      })
    }
  })
}

/**
 * 发起一次 HTTP/1.1 请求（自动：直连 / 经代理 absolute-form / 经代理 CONNECT 隧道）。
 * 不跟随重定向（跟随策略由调用方决定：WebDAV 保方法语义，fetch 按浏览器语义）。
 */
export async function requestOnce(options: RawRequestOptions): Promise<RawResponse> {
  const target = new URL(options.url)
  const env = options.env ?? readProxyEnv()
  const proxyUrl = proxyUrlFor(target, env)
  const method = (options.method ?? 'GET').toUpperCase()
  const timeoutMs = options.timeoutMs ?? 0
  const payload = options.body === undefined
    ? undefined
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body, 'utf8')
  // 调用方显式传入的 User-Agent（大小写不敏感）优先；缺省补默认 UA（见 DEFAULT_USER_AGENT）。
  const callerHeaders = options.headers ?? {}
  const hasUserAgent = Object.keys(callerHeaders).some((key) => key.toLowerCase() === 'user-agent')
  const headers: Record<string, string> = {
    ...(payload !== undefined ? { 'content-length': String(payload.length) } : {}),
    ...(hasUserAgent ? {} : { 'user-agent': DEFAULT_USER_AGENT }),
    ...callerHeaders,
  }

  /** url 非 null → 以 URL 形态发起（node 自行解析 host/port/path/TLS）；否则按显式 options 发起。 */
  const send = (
    lib: typeof http | typeof https,
    url: string | null,
    requestOptions: http.RequestOptions,
  ): Promise<RawResponse> =>
    new Promise<RawResponse>((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage): void => {
        collectResponse(res, timeoutMs).then(resolve, reject)
      }
      const req = url === null
        ? lib.request(requestOptions, onResponse)
        : lib.request(url, requestOptions, onResponse)
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy()
          reject(new Error(`Request timed out after ${timeoutMs}ms`))
        })
      }
      req.on('error', reject)
      if (options.signal !== undefined) {
        const onAbort = (): void => { req.destroy(new Error('The operation was aborted.')) }
        if (options.signal.aborted) onAbort()
        else options.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (payload !== undefined) req.write(payload)
      req.end()
    })

  // ---- 未经代理：直连（默认路径，行为与此前一致）----
  if (proxyUrl === null) {
    const lib = target.protocol === 'https:' ? https : http
    return await send(lib, options.url, { method, headers })
  }

  const proxy = new URL(proxyUrl)

  // ---- http 目标经代理：absolute-form 直接把完整 URL 交给代理 ----
  if (target.protocol === 'http:') {
    const port = Number(proxy.port !== '' ? proxy.port : (proxy.protocol === 'https:' ? 443 : 80))
    const lib = proxy.protocol === 'https:' ? https : http
    return await send(lib, null, {
      method,
      host: proxy.hostname,
      port,
      path: target.toString(),
      headers: {
        ...headers,
        host: target.host,
        ...(proxy.username !== '' || proxy.password !== ''
          ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
          : {}),
      },
    })
  }

  // ---- https 目标经代理：CONNECT 隧道 + TLS（SNI 保留目标主机名）----
  const tunnel = await openTunnel(target, proxy, timeoutMs > 0 ? timeoutMs : DEFAULT_CONNECT_TIMEOUT_MS)
  const secure = tls.connect({
    socket: tunnel,
    servername: target.hostname,
    // 与直连一致：默认校验证书链；不做任何降级
  })
  await new Promise<void>((resolve, reject) => {
    secure.once('secureConnect', () => { resolve() })
    secure.once('error', reject)
  })
  return await send(https, null, {
    method,
    headers,
    host: target.hostname,
    port: Number(effectivePort(target)),
    path: `${target.pathname}${target.search}`,
    agent: new TunnelAgent(secure),
  })
}

/** 把 `HeadersInit` 归一为小写键的普通对象 */
function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (init === undefined) return out
  if (init instanceof Headers) {
    init.forEach((value, key) => { out[key.toLowerCase()] = value })
    return out
  }
  if (Array.isArray(init)) {
    for (const [key, value] of init) out[String(key).toLowerCase()] = String(value)
    return out
  }
  for (const [key, value] of Object.entries(init)) {
    if (value !== undefined) out[key.toLowerCase()] = String(value)
  }
  return out
}

/** 同源判断（协议 + host，含端口） */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.protocol === ub.protocol && ua.host === ub.host
  } catch {
    return false
  }
}

/** 重定向上限（与 WebDAV 通道一致） */
const MAX_REDIRECTS = 5

/**
 * 代理感知的 fetch 兼容实现（仅插件自身使用；替代 `globalThis.fetch` 的默认值）。
 *
 * 与浏览器 fetch 的关键语义对齐：自动跟随 301/302/303/307/308（上限 5 跳）；303 且非 GET/HEAD
 * 降级为 GET 并丢弃请求体；**跨源跳转剥离 `authorization`**（token 不转发给第三方域名）；
 * 无响应体状态（204/304 等）不构造 body。
 */
export function createProxyAwareFetch(env: ProxyEnv = readProxyEnv()): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : (input as Request).url
    let currentUrl = url
    let method = (init?.method ?? 'GET').toUpperCase()
    let headers = normalizeHeaders(init?.headers)
    let body: string | Buffer | undefined = init?.body === undefined || init?.body === null
      ? undefined
      : String(init.body)

    for (let hop = 0; ; hop += 1) {
      const res = await requestOnce({
        method,
        url: currentUrl,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(init?.signal != null ? { signal: init.signal } : {}),
        env,
      })

      const location = res.headers.get('location')
      if (!REDIRECT_STATUSES.has(res.status) || location === null) {
        return new Response(
          BODYLESS_STATUSES.has(res.status) ? null : new Uint8Array(res.body),
          { status: res.status, statusText: res.statusText, headers: res.headers },
        )
      }
      if (hop >= MAX_REDIRECTS) {
        throw new TypeError(`fetch failed: too many redirects (${MAX_REDIRECTS} max)`)
      }
      let nextUrl: string
      try {
        nextUrl = new URL(location, currentUrl).toString()
      } catch {
        return new Response(
          BODYLESS_STATUSES.has(res.status) ? null : new Uint8Array(res.body),
          { status: res.status, statusText: res.statusText, headers: res.headers },
        )
      }
      if (!sameOrigin(currentUrl, nextUrl)) delete headers['authorization']
      if (res.status === 303 && method !== 'GET' && method !== 'HEAD') {
        method = 'GET'
        body = undefined
        delete headers['content-length']
      }
      currentUrl = nextUrl
    }
  }
  return impl as unknown as typeof fetch
}

/**
 * 默认出站 fetcher：**未配置代理时原样返回全局 `fetch`**（保持既有行为零变化）；
 * 配置了代理才切到代理感知实现。
 */
export function defaultFetcher(env: ProxyEnv = readProxyEnv()): typeof fetch {
  return isProxyConfigured(env) ? createProxyAwareFetch(env) : globalThis.fetch
}

/** 启动日志用：当前生效的代理描述（已脱敏），未启用 → null */
export function activeProxySummary(env: ProxyEnv = readProxyEnv()): { http: string | null; https: string | null; noProxyEntries: number } | null {
  if (!isProxyConfigured(env)) return null
  return {
    http: env.httpProxy !== null ? describeProxy(env.httpProxy) : null,
    https: env.httpsProxy !== null ? describeProxy(env.httpsProxy) : null,
    noProxyEntries: env.noProxy !== null ? env.noProxy.split(',').filter((s) => s.trim() !== '').length : 0,
  }
}
