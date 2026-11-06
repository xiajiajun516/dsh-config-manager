/**
 * 宿主信任面委托（issue #126）：把「回环之外还能不能访问内嵌面板」交给 DSH 自己的判定。
 *
 * 为什么不是本插件自建一套局域网判据：宿主已经有一份**权威**答案 ——
 * `HostConnectionService.requestRejection(request)`（dsh-client-connection）先判
 * isTrustedApiRequest（Host 属于 trustedHosts / 回环 + 非 cross-site + Origin 同源），
 * 再判 browserAuth.isAuthenticated（按 authority 命名、HMAC 签名的 dsh-auth cookie）。
 * `--host` 绑定的接口字面量、`--trusted-host`、cookie 过期与轮换全在宿主里，
 * 插件复刻一份必然分叉（也拿不到签名密钥）。
 *
 * 只委托、不接管：
 * - 回环请求根本不会走到这里（kit 先放行），所以本机 curl / 脚本 / 单测行为不变；
 * - 服务缺失（老宿主 / 独立 CLI 救急台）或判定抛错 → 退回严格回环（fail-closed）。
 *
 * 边界：本模块只做**结构窄化 + 错误码映射**，不 import @deepseek-ai/*（架构边界测试）。
 */
import type { IncomingMessage } from 'node:http'

import { BROWSER_SESSION_CODE, LOOPBACK_ONLY_CODE, UNTRUSTED_AUTHORITY_CODE } from '../core/access-mode.ts'
import { clearRequestTrustResolver, setRequestTrustResolver, type RequestRejection, type RequestTrustResolver } from './kit.ts'

/** 宿主 connection 服务的结构化窄化（只取围栏判定这一个方法）。 */
export interface HostConnectionLike {
  requestRejection?: (request: unknown) => unknown
}

/** 诊断日志最小形状（只取 warn，避免依赖整个 host）。 */
export interface TrustLog {
  warn(message: string): void
}

/** 无委托可用时的兜底（与改造前逐字一致）。 */
const LOOPBACK_ONLY: RequestRejection = Object.freeze({
  status: 403,
  message: 'forbidden: loopback-only',
  code: LOOPBACK_ONLY_CODE,
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 构造「非回环请求」的信任判定。
 *
 * @param readConnection 惰取 connection 服务（调用期读取：本插件 apply 时宿主服务可能还没组合）
 * @param log 诊断出口（判定抛错时留一行，随后 fail-closed）
 */
export function createHostRequestTrust(readConnection: () => unknown, log?: TrustLog): RequestTrustResolver {
  return (request: IncomingMessage): RequestRejection | undefined => {
    let service: unknown
    try {
      // ctx.get 在插件已卸载 / 服务组合中会抛（不是返回 undefined）—— 围栏抛错会绕过
      // endpoint 的 try/catch 落到 webserver 的空体 400，所以这里自己接住。
      service = readConnection()
    } catch (error) {
      log?.warn('reading the connection service threw; falling back to loopback-only: ' + describe(error))
      return LOOPBACK_ONLY
    }
    if (service === null || typeof service !== 'object') return LOOPBACK_ONLY
    const candidate = service as HostConnectionLike
    if (typeof candidate.requestRejection !== 'function') return LOOPBACK_ONLY
    let verdict: unknown
    try {
      // 成员调用：宿主的方法依赖 this（browserAuth / trustedHosts），抽出来单独调会丢绑定。
      verdict = candidate.requestRejection(request as unknown)
    } catch (error) {
      log?.warn('connection.requestRejection threw; falling back to loopback-only: ' + describe(error))
      return LOOPBACK_ONLY
    }
    if (verdict === undefined) return undefined
    return verdict === 401
      ? { status: 401, message: 'unauthorized: browser-session', code: BROWSER_SESSION_CODE }
      : { status: 403, message: 'forbidden: untrusted-authority', code: UNTRUSTED_AUTHORITY_CODE }
  }
}

/** 安装所需的宿主上下文最小形状（只取 effect 与 get，避免依赖 Cordis 类型）。 */
export interface TrustInstallContext {
  effect(callback: () => () => void, label: string): unknown
  get(name: string): unknown
}

/**
 * 把宿主信任面装进 kit 围栏（组合根只需一行）。
 *
 * 用 ctx.effect 安装 = 卸载/重载插件时自动卸回严格回环，不残留上一实例的判定闭包
 * （闭包捕获的是旧 ctx：旧实例卸载后它读到的 connection 服务可能是失效引用）。
 */
export function installHostRequestTrust(ctx: TrustInstallContext, log?: TrustLog): void {
  ctx.effect(() => {
    const resolver = createHostRequestTrust(() => ctx.get('connection'), log)
    setRequestTrustResolver(resolver)
    // 只撤自己装的那一个：另一实例（bundle + 隔离 profile）可能已经覆盖了委托。
    return () => clearRequestTrustResolver(resolver)
  }, 'config-manager: request trust')
}
