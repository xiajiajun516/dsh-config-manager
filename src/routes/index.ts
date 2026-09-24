/**
 * 路由表装配点（W1）：把按域拆分的组文件拼成一张路由表。
 *
 * 顺序对匹配无影响：DSH webServer 的契约是「命名路由必须互不相同，注册顺序不影响请求」
 * （见 @deepseek-ai/dsh-host-webserver 的 WebServer 文档）。src/index.ts 保留的 8 条被源码级
 * 守卫按文件窗口钉住，其余 57 条在这里组装。
 */
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { importRoutes } from './import.ts'
import { snapshotRoutes } from './snapshots.ts'
import { profileRoutes } from './profiles.ts'
import { backupRoutes } from './backup.ts'
import { consultRoutes } from './consult.ts'
import { syncRoutes } from './sync.ts'
import { prefsRoutes } from './prefs.ts'
import { marketRoutes } from './market.ts'
import { meRoutes } from './me.ts'
import { historyRoutes } from './history.ts'
import { recoveryRoutes } from './recovery.ts'

export function buildRoutes(env: RoutesEnv): WebRoute[] {
  return [
    ...importRoutes(env),
    ...snapshotRoutes(env),
    ...profileRoutes(env),
    ...backupRoutes(env),
    ...consultRoutes(env),
    ...syncRoutes(env),
    ...prefsRoutes(env),
    ...marketRoutes(env),
    ...meRoutes(env),
    ...historyRoutes(env),
    ...recoveryRoutes(env),
  ]
}
