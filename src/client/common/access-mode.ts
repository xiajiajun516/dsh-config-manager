/**
 * 「访问方式」类拒绝的识别（issue #126）。
 *
 * 背景：宿主以 --host 10.0.0.10 起 dsh web 后，从局域网打开内嵌面板时每条只读请求都被围栏
 * 拒掉。改造前客户端只能把这条 403 当普通错误显示成「有 N 项数据读取失败」+ 一个点了没用的
 * 「重试」—— 用户据此会以为数据坏了。
 *
 * 判据（两条并存，缺一不可）：
 * 1. 宿主给的新机器码（src/core/access-mode.ts，与围栏同一份字面量）；
 * 2. 旧宿主（< 本修复）没有 code，只有 'forbidden: loopback-only' 文案 —— 用文案兜底识别，
 *    这样升级插件但没升级 DSH 的用户也能看到正确解释。
 */
import { isAccessModeCode } from '../../core/access-mode.ts'
import { ConfigManagerApiError } from './http.ts'

/** 该错误是否属于「当前访问方式不受支持」（不是数据问题，重试也没用）。 */
export function isAccessModeError(error: unknown): boolean {
  if (!(error instanceof ConfigManagerApiError)) return false
  if (isAccessModeCode(error.code)) return true
  return error.status === 403 && /loopback-only/i.test(error.message)
}
