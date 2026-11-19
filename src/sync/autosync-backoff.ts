/**
 * J 项：自动同步失败退避与短暂环境锁阻塞（mutation-locked）脏改动补偿调度辅助。
 *
 * 解决的问题：
 * 1) `scheduleChannelTimer` / `scheduleRemoteTimers` 此前在连续失败（网络断/502/认证过期）后
 *    仍以固定间隔（如 5 分钟 / 30 分钟）死敲远端；这里按 `consecutiveFailures` 计算指数退避
 *    时间 `lastRunNextRetryAt`（封顶 `MAX_AUTOSYNC_BACKOFF_MS = 1h`，且永不缩小于配置基准周期），
 *    仅节流后台定时轮询（`interval` / `remote-poll`），绝不阻断手工同步或本地保存后的主动重试。
 * 2) `withMutationLock` 因其他活跃任务返回 `mutation-locked`（`DEFAULT_ACQUIRE_TIMEOUT_MS = 0`）后，
 *    watcher 已消费完本次修改事件且 `remote-poll` 默认 `localCheck=false` —— 未推上去的本地改动会
 *    卡到下一个 30m `interval` 甚至丢失。记录待补推通道并安排有限次数退避重试，且下一次轮询自动
 *    升级做本地检测；对不可自愈的 `stale` 残留锁与 `SAFE MODE` 绝不空转重连。
 */

/** 后台自动同步失败退避上限（1 小时；若配置 interval 本身更长如 24h，不缩水）。 */
export const MAX_AUTOSYNC_BACKOFF_MS = 60 * 60 * 1000;

/** 环境锁短暂占用的首次重试基础延迟（ms）。 */
export const DEFAULT_LOCK_RETRY_BASE_MS = 15 * 1000;

/** 环境锁补偿重试单次等待上限（ms）。 */
export const MAX_LOCK_RETRY_DELAY_MS = 60 * 1000;

/** 单次脏改动因环境锁被挡后，专用定时补偿的最多尝试次数（超出仍保留待补推标记给下次轮询/兜底扫描）。 */
export const MAX_LOCK_RETRY_ATTEMPTS = 5;

/**
 * 计算失败后的指数退避延迟（ms）。
 * - `consecutiveFailures <= 0` → `Math.max(0, baseMs)`；
 * - `consecutiveFailures >= 1` → `baseMs * 2^min(failures, 10)`，封顶 `max(MAX_AUTOSYNC_BACKOFF_MS, baseMs)`。
 */
export function computeFailureBackoffMs(baseMs: number, consecutiveFailures: number): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return safeBase;
  const exp = Math.min(Math.floor(consecutiveFailures), 10);
  const cap = Math.max(MAX_AUTOSYNC_BACKOFF_MS, safeBase);
  return Math.min(cap, Math.round(safeBase * Math.pow(2, exp)));
}

/** 计算下一次允许后台重试的时间戳（ISO-8601 UTC）；无连续失败则返回 undefined。 */
export function computeNextRetryIso(
  nowMs: number,
  scheduleBaseMs: number,
  consecutiveFailures: number,
): string | undefined {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return undefined;
  return new Date(nowMs + computeFailureBackoffMs(scheduleBaseMs, consecutiveFailures)).toISOString();
}

/**
 * 定时器排期实际等待时长（ms）：取「配置基准周期」与「距离 lastRunNextRetryAt 剩余时间」的较大值。
 * 无退避记录或已过期 → 直接返回 `baseMs`。
 */
export function effectiveTimerDelayMs(
  baseMs: number,
  lastRunNextRetryAt: string | undefined,
  nowMs: number,
): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  if (lastRunNextRetryAt === undefined || lastRunNextRetryAt === '') return safeBase;
  const nextMs = Date.parse(lastRunNextRetryAt);
  if (Number.isNaN(nextMs) || nextMs <= nowMs) return safeBase;
  return Math.max(safeBase, nextMs - nowMs);
}

/** 计算短暂锁冲突后的第 N 次（1-based）补偿重试延迟（指数退避，封顶 MAX_LOCK_RETRY_DELAY_MS）。 */
export function computeLockRetryDelayMs(baseMs: number, attempt: number): number {
  const safeBase = Number.isFinite(baseMs) && baseMs >= 0 ? baseMs : DEFAULT_LOCK_RETRY_BASE_MS;
  if (safeBase === 0) return 0;
  const safeAttempt = Math.max(1, Math.min(Math.floor(attempt), 10));
  return Math.min(MAX_LOCK_RETRY_DELAY_MS, Math.round(safeBase * Math.pow(2, safeAttempt - 1)));
}

/** 只有真被另一活跃任务持有（mutation-locked）才排短周期补偿重试定时器；锁 IO 不可用仅标记待补扫描，残留锁与 SAFE MODE 绝不重试。 */
export function isTransientLockSkipReason(skipReason: string): boolean {
  return skipReason === 'mutation-locked';
}

/** 仅后台周期性触发（interval / remote-poll）在退避窗口内需要让步；用户手动与本地保存始终放行。 */
export function isScheduledTriggerDuringBackoff(
  nextRetryAtMs: number | undefined,
  nowMs: number,
  reason: string,
): boolean {
  if (reason !== 'interval' && reason !== 'remote-poll') return false;
  if (nextRetryAtMs === undefined || !Number.isFinite(nextRetryAtMs)) return false;
  return nowMs < nextRetryAtMs;
}
