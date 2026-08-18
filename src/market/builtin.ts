/**
 * m-market：内置（官方）配置市场仓库。
 *
 * 产品决策（2026-08）：「内置市场 = 由创建者 xiajiajun516 维护的公开 Read-Only 仓库，
 * 只绑定、不可编辑」。市场面板不再允许用户手动添加/移除市场仓库；本模块是唯一来源。
 *
 * 运行时可经 `DSH_CONFIG_MARKET_URL` 覆盖（便于维护者切换/预览其他仓库），默认指向
 * 官方公开市场。公开仓库：无需任何凭据（继承 m-market 的“无 secret”硬不变式）。
 *
 * ⚠️ 浏览器安全：本模块会被 web 端（MarketPanel）直接打包加载，浏览器没有 Node 的
 * `process` 全局。因此在模块顶层读取环境变量时必须用 `typeof process !== 'undefined'`
 * 防御，否则会抛 `ReferenceError: process is not defined` 导致插件加载失败。
 */
const DEFAULT_MARKET_URL = 'https://github.com/xiajiajun516/dsh-config-market.git'

/** 内置市场仓库 URL（host/Node 端可经 `DSH_CONFIG_MARKET_URL` 覆盖；web 端安全回退默认官方地址）。 */
export const BUILTIN_MARKET_URL = (
  typeof process !== 'undefined' && process.env?.DSH_CONFIG_MARKET_URL
    ? process.env.DSH_CONFIG_MARKET_URL
    : DEFAULT_MARKET_URL
).trim()

/** 内置市场是否为默认官方地址（固定默认值比较，不随 env 覆盖变化，保证 UI 判断稳定）。 */
export function isOfficialMarket(url: string): boolean {
  return url.trim() === DEFAULT_MARKET_URL
}
