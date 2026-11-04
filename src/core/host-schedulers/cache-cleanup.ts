/**
 * 宿主缓存自动清理的**调度**部分（tech-debt #23 下沉：index.ts 只留一次装配）。
 *
 * 为什么单独成模块：清理动作本身在 `core/cache-cleaner.ts`（纯 IO + 保留期判定，已单测），
 * 而「什么时候跑、跑几次、跑挂了怎么办」是**调度语义**，此前和 apply() 的其他接线混在
 * src/index.ts 里，无法在不挂宿主的情况下验证。这里把调度抽成**可注入动作**的薄壳：
 *
 * - 启动即清一次 + 按 `intervalMs` 定时清（默认由调用方给 24h）；
 * - 每一次清理都是**尽力而为**：失败只记 warn，绝不打断插件挂载、也不停掉定时器
 *   （定时器停掉的代价是「以后再也不清」，比一次失败严重得多）；
 * - `removed === 0` 不记 info（每次启动都刷一行「清理完成 0 个」是噪音）。
 *
 * 边界：本文件只依赖 `node:` 与本地相对导入（core 子目录不得 import core 兄弟模块，
 * 见 tests/architecture-boundaries.test.ts 的 allow 白名单），因此清理动作与日志口一律注入。
 */

/** 一次清理的可观测结果（`core/cache-cleaner.ts` 的 CacheCleanupResult 满足此形状）。 */
export interface CacheCleanupTally {
  removed: number
  freedBytes: number
}

/** 日志口：只用到 info / warn，宿主 host.log 直接满足。 */
export interface CacheCleanupLogSink {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface CacheCleanupSchedulerOptions {
  /** 执行一次清理（注入 `cleanupCaches` 的绑定版本，便于单测替换）。 */
  cleanup: () => Promise<CacheCleanupTally>
  /** 定时周期（毫秒）。 */
  intervalMs: number
  log: CacheCleanupLogSink
}

export interface CacheCleanupScheduler {
  /** 启动：立即清一次 + 挂上定时器（重复调用幂等，不会叠出第二个定时器）。 */
  start(): void
  /** 停掉定时器（插件卸载 / 宿主关停）。幂等。 */
  dispose(): void
  /** 立刻清一次（启动路径与手动触发共用同一条错误口径）。 */
  runNow(): void
}

export function createCacheCleanupScheduler(options: CacheCleanupSchedulerOptions): CacheCleanupScheduler {
  let timer: ReturnType<typeof setInterval> | null = null

  const runNow = (): void => {
    void options.cleanup()
      .then((report) => {
        if (report.removed > 0) {
          options.log.info('缓存自动清理完成', { removed: report.removed, freedBytes: report.freedBytes })
        }
      })
      .catch((error: unknown) => {
        options.log.warn('缓存自动清理失败', { error: error instanceof Error ? error.message : String(error) })
      })
  }

  return {
    runNow,
    start(): void {
      if (timer !== null) return
      runNow()
      timer = setInterval(runNow, options.intervalMs)
    },
    dispose(): void {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
  }
}
