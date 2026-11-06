/**
 * 围栏拒绝码（access-mode）—— 宿主路由与浏览器两半的**唯一字面量来源**。
 *
 * 为什么需要独立模块：issue #126 里局域网访问内嵌面板时，每条只读路由都回
 * `{"error":"forbidden: loopback-only"}`，而界面只能把它当普通错误显示成
 * 「有 5 项数据读取失败」+ 一个点了没用的「重试」—— 用户据此会以为数据坏了。
 * 客户端要能认出「这是访问方式问题、不是数据问题」，就必须有一个**机器码**，
 * 且这个码不能各写一份（宿主 kit 写一个、浏览器 api 写一个，早晚分叉）。
 *
 * 三档语义（与 src/routes/kit.ts 的围栏一一对应）：
 * - `loopback-only`：只接受本机回环（无宿主信任面可委托时的兜底 / 独立 CLI 救急台）；
 * - `untrusted-authority`：宿主拒绝了这次请求的 Host/Origin（不在 trustedHosts）；
 * - `browser-session`：地址可信但缺 dsh web 的登录会话 cookie（401）。
 *
 * 本模块零依赖、零 import（宿主与浏览器 bundle 都要能引）。
 */

/** 只接受回环（无委托或委托不可用）。 */
export const LOOPBACK_ONLY_CODE = 'loopback-only' as const

/** 宿主不认这个 authority（Host 头不在 trustedHosts）。 */
export const UNTRUSTED_AUTHORITY_CODE = 'untrusted-authority' as const

/** 地址可信，但请求没有有效的 dsh web 登录会话。 */
export const BROWSER_SESSION_CODE = 'browser-session' as const

export type AccessModeCode =
  | typeof LOOPBACK_ONLY_CODE
  | typeof UNTRUSTED_AUTHORITY_CODE
  | typeof BROWSER_SESSION_CODE

const ACCESS_MODE_CODES: readonly string[] = [LOOPBACK_ONLY_CODE, UNTRUSTED_AUTHORITY_CODE, BROWSER_SESSION_CODE]

/** 该 code 是否属于「访问方式」这一类拒绝（客户端据此换文案，而不是当成读取失败）。 */
export function isAccessModeCode(value: unknown): value is AccessModeCode {
  return typeof value === 'string' && ACCESS_MODE_CODES.includes(value)
}
