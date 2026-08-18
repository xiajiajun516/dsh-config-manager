/**
 * m-market：内置（官方）配置市场仓库。
 *
 * 产品决策（2026-08）：「内置市场 = 由创建者 xiajiajun516 维护的公开 Read-Only 仓库，
 * 只绑定、不可编辑」。市场面板不再允许用户手动添加/移除市场仓库；本模块是唯一来源。
 *
 * 运行时可经 `DSH_CONFIG_MARKET_URL` 覆盖（便于维护者切换/预览其他仓库），默认指向
 * 官方公开市场。公开仓库：无需任何凭据（继承 m-market 的“无 secret”硬不变式）。
 */
export const BUILTIN_MARKET_URL = (
  process.env.DSH_CONFIG_MARKET_URL ?? 'https://github.com/xiajiajun516/dsh-config-market.git'
).trim()

/** 内置市场是否为默认官方地址（用于 UI 展示「内置 / 官方」徽章与文案）。 */
export function isOfficialMarket(url: string): boolean {
  return url.trim() === BUILTIN_MARKET_URL
}
