/**
 * 宿主路由 kit —— \`/api/dsh-config-manager/*\` 全部路由的**唯一入口**与唯一基础设施。
 *
 * 为什么存在（host-entry 审计 F-02/F-03/F-05）：
 * - 改造前 **65** 条路由各自手写「围栏 + 方法判定 + body 解析 + try/catch + 错误映射」，
 *   5 条路由连 try/catch 都没有（抛错会被 webserver 兜底成**空体 400**，客户端把它误报成
 *   「响应不是合法 JSON」并丢掉真实原因）；
 * - 「每条路由首行 guard」这条安全不变量此前**只写在注释里**，零测试覆盖；
 * - 3 条 prefix 路由自造围栏（裸 isLoopbackRequest + 自判方法）。
 *
 * 计数口径（三路一致 = 65，勿再照抄审计初稿的 66 —— 那是计数口径 overcount）：
 *   HEAD 的 routesList 65 条 ＝ 现行 `endpoint()` 声明 65 条 ＝ 运行期 `buildRoutes()` 57 条 + `src/index.ts` 保留的 8 条。
 *
 * 现在：`endpoint()` 是唯一入口，注册点（`registerRoutes`）兜底断言每条路由都出自本 kit。
 * 新增一条路由 = 在所属组文件里加一条 `endpoint({ path, methods, kind? }, handler)` 声明，
 * 围栏/方法/异常处理由 kit 统一提供，无需再写样板。
 *
 * 分层：本文件只依赖 node:http。WebRoute 刻意在本地结构化声明（与
 * @deepseek-ai/dsh-host-webserver 的同名接口结构等价），因为架构边界测试规定
 * @deepseek-ai/* 只能出现在 src/index.ts 与 src/client/（见 tests/architecture-boundaries.test.ts）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/* --------------------------------------------------------------- 路由形状 */

/** 路由匹配方式：exact 逐字匹配；prefix 匹配 p 与 p/<任意>（与 DSH webServer.register 契约一致）。 */
export type WebRouteKind = 'exact' | 'prefix'

/** 一条已注册路由（结构等价于 @deepseek-ai/dsh-host-webserver 的 WebRoute）。 */
export interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 本路由族使用的方法（前缀路由按 path 分发，因此只做粗粒度白名单）。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** 端点声明：method + path 的**唯一声明处**（新增 API 只改这里 + 组文件里的 handler）。 */
export interface EndpointSpec {
  /** 缺省 exact。 */
  kind?: WebRouteKind
  path: string
  /** 允许的方法白名单；不在白名单 → 405（与旧 guard 的文案一致）。 */
  methods: readonly HttpMethod[]
}

/** 端点 handler：围栏与方法判定已由 kit 完成，body 解析按需调用本文件的 readJsonBody。 */
export type EndpointHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** kit 产出的路由上挂的声明信息（供注册点兜底断言与 route-parity 测试读取）。 */
export const ROUTE_SPEC: unique symbol = Symbol('dsh-config-manager.routeSpec')

/* ------------------------------------------------------------------ 错误 */

/**
 * 路由可预期的请求级错误（唯一机制）。
 *
 * 为什么取代原先 4 套语义：profile 用 code→404/409/400、sync 用 status、mutation gate 用 423、
 * 其余按路由内联 500 —— 同一个「请求非法」在不同路由落成不同状态码，客户端只能各自适配。
 * 现在 handler 抛 RouteError（或其子类）即可，映射只有这一份。
 */
export class RouteError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number = 500, code?: string) {
    super(message)
    this.name = 'RouteError'
    this.status = status
    this.code = code
  }
}

/** 错误 → 文本的一口径（原先 65 处 `error instanceof Error ? error.message : String(error)` 的内联三元）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* --------------------------------------------------------- 响应与请求体 */

/** JSON 响应（唯一写出点：content-type + no-referrer 头只在这一处维护）。 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** JSON 错误响应（唯一形状：{error, code?}）。 */
export function writeJsonError(res: ServerResponse, status: number, message: string, code?: string): void {
  writeJson(res, status, code === undefined ? { error: message } : { error: message, code })
}

/** 统一错误出口：RouteError（含子类）用其 status/code，其余 500 + 消息（已由调用方脱敏）。 */
export function writeRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RouteError) {
    writeJsonError(res, error.status, error.message, error.code)
    return
  }
  writeJsonError(res, 500, errorMessage(error))
}

/** Cap on raw JSON bodies (4 MiB) —— 文件上传走 MAX_UPLOAD_BYTES 的另一条路径。 */
export const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

/** 读取 JSON 请求体：非法 JSON / 超限 / 非对象 → undefined（调用方决定语义）。 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取 JSON 请求体，非法即抛 400（原先 25 处「readJsonBody + if (body === undefined) writeJson(400…)」
 * 的三行样板，响应体逐字相同）。
 */
export async function requireJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req)
  if (body === undefined) throw new RouteError('invalid JSON body', 400)
  return body
}

/** URL query 取值（首个值，已解码）。 */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/* ------------------------------------------------------------ loopback 围栏 */

/** Loopback literal check plus browser same-origin markers (dsh-ssh's fence). */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- 唯一入口 */

/**
 * 声明一条端点。这是全部路由的**唯一构造入口**：
 * ① loopback 围栏（非 loopback → 403）；② 方法白名单（不在白名单 → 405）；
 * ③ 顶层 try/catch → writeRouteError（异常绝不再落到 webserver 的空体 400 兜底）。
 */
export function endpoint(spec: EndpointSpec, handler: EndpointHandler): WebRoute {
  const route: WebRoute = {
    kind: spec.kind ?? 'exact',
    path: spec.path,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (!isLoopbackRequest(req)) {
        writeJsonError(res, 403, 'forbidden: loopback-only')
        return
      }
      if (!spec.methods.includes(req.method as HttpMethod)) {
        writeJsonError(res, 405, `method not allowed: ${req.method}`)
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        // 预期错误走 RouteError（带 status/code），其余 500 —— 与旧路由的内联出口逐条对齐。
        writeRouteError(res, error)
      }
    },
  }
  Object.defineProperty(route, ROUTE_SPEC, { value: Object.freeze({ kind: route.kind, path: route.path, methods: [...spec.methods] }), enumerable: false })
  return route
}

/** 读回 endpoint() 写下的声明（未经过 kit 的路由 → undefined）。 */
export function routeSpecOf(route: WebRoute): { kind: WebRouteKind; path: string; methods: readonly HttpMethod[] } | undefined {
  return (route as unknown as Record<symbol, unknown>)[ROUTE_SPEC] as { kind: WebRouteKind; path: string; methods: readonly HttpMethod[] } | undefined
}

/** 注册点可用的最小 registry 形状（结构等价于 WebServer.register）。 */
export interface RouteRegistry {
  register(route: WebRoute): () => void
}

/**
 * 注册点唯一包装：逐条断言路由出自 kit（漏用 endpoint() 直接抛错 → 插件启动失败而非静默少一道围栏），
 * 然后交给 webServer 注册，返回 disposers。
 */
export function registerRoutes(registry: RouteRegistry, routes: readonly WebRoute[]): Array<() => void> {
  return routes.map((route) => {
    const spec = routeSpecOf(route)
    if (spec === undefined) {
      throw new Error(`路由 ${route.path} 未经 route kit 声明（endpoint()）——禁止裸 handler（安全不变量：围栏必须在注册点统一包装）`)
    }
    return registry.register(route)
  })
}
