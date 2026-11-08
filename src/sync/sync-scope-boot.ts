/**
 * 同步作用域的启动接线（per-profile sync scope）—— 从 `src/index.ts` 下沉到这里，
 * 让宿主装配只留一行调用（体量棘轮不允许继续堆在 index.ts 里）。
 *
 * 两件事，都属于「档案作用域」的运行期胶水，本身没有状态：
 *  1. `bootSyncScope`：非默认档案首次启动时从历史同步根继承配置与凭据值（best-effort）；
 *  2. `makeSyncCredentialViews`：密码槽位的「是否已保存」视图（只回布尔，值永不返回）。
 *
 * 依赖只经参数传入（凭据端口 / 日志回调），本模块不 import DSH 运行时。
 */
import { SYNC_CHANNELS } from '../utils/shared-constants.ts'
import type { SyncTransportType } from './sync-config.ts'
import { adoptLegacySyncScope, syncPasswordRef, syncScopeLegacyCredentialRefs, type SyncScope } from './sync-scope.ts'
import { engineMsg } from './messages.ts'

/** 只用到三个方法的凭据端口（与 DSH CredentialProvider 同形）。 */
export interface SyncScopeCredentialPort {
  describe(ref: string): Promise<{ configured: boolean }>
  resolve(ref: string): Promise<{ value?: unknown } | undefined>
  set(ref: string, value: string): Promise<void>
}

/** 同步密码「是否已保存」视图（只回布尔；密码值永不进任何响应）。 */
export interface SyncPasswordViews {
  syncPasswordConfigured: (ref: string) => Promise<boolean>
  syncCredentialsByChannelView: () => Promise<Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }>>
}

/**
 * 启动期继承（**异步 + best-effort**）：失败只记日志，绝不影响插件挂载 ——
 * 最坏结果只是该档案「同步未配置」，用户重填一次即恢复。
 *
 * 幂等由作用域目录本身决定（见 `adoptLegacySyncScope`）：目录已存在就不再继承。
 */
export function bootSyncScope(
  scope: SyncScope,
  credentials: SyncScopeCredentialPort,
  warn: (line: string) => void,
): void {
  if (scope.isDefault) return
  void (async (): Promise<void> => {
    try {
      const adopted = await adoptLegacySyncScope(scope, warn)
      if (adopted.length === 0) return
      for (const pair of syncScopeLegacyCredentialRefs(scope)) {
        // 先看新槽位是否已配置：用户自己填过的值绝不覆盖
        if ((await credentials.describe(pair.to)).configured) continue
        const legacy = await credentials.resolve(pair.from)
        const value = legacy?.value
        if (typeof value !== 'string' || value === '') continue
        // 值只在进程内搬一次：读旧槽位 → 写新槽位，不落盘、不进日志
        await credentials.set(pair.to, value)
      }
    } catch (error) {
      warn(engineMsg('sync.scopeBootFailed', { reason: String(error) }))
    }
  })()
}

/**
 * 密码槽位视图工厂。
 *
 * @param credentials 凭据端口（只用来 describe，永不 resolve 出值）
 * @param profile 本档案名（槽位名按档案加后缀）
 */
export function makeSyncCredentialViews(
  credentials: SyncScopeCredentialPort,
  profile: string,
): SyncPasswordViews {
  const syncPasswordConfigured = async (ref: string): Promise<boolean> => {
    try {
      return (await credentials.describe(ref)).configured
    } catch {
      return false
    }
  }
  const syncCredentialsByChannelView = async (): Promise<Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }>> => {
    const describe = async (channel: SyncTransportType): Promise<{ encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }> => ({
      encryptPasswordConfigured: await syncPasswordConfigured(syncPasswordRef('ENCRYPT', channel, profile)),
      decryptPasswordConfigured: await syncPasswordConfigured(syncPasswordRef('DECRYPT', channel, profile)),
    })
    // t32/B7：通道集合来自唯一枚举（保持 Promise.all 并发语义）
    const pairs = await Promise.all(SYNC_CHANNELS.map(async (channel) => [channel, await describe(channel)] as const))
    return Object.fromEntries(pairs) as Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }>
  }
  return { syncPasswordConfigured, syncCredentialsByChannelView }
}
