/**
 * AutoSyncScheduler：宿主后台自动同步调度器。
 *
 * 生命周期：
 *  - start()：读 autosync-config；若 enabled 启动定时器（按 interval）；无条件执行一次
 *    「启动触发下载合并」（受 startupMinIntervalMs 阈值约束）。
 *  - stop()：清定时器、标记不再调度。
 *  - runOnce()：执行一次完整双向自动同步（§6.1 流程）。
 *
 * 核心逻辑（runOnce）：
 *  - 读配置；若 !enabled → return
 *  - runs.register('autosync') 防重复；同 kind running → 跳过
 *  - readSyncConfig → repoUrl 无 → 记 skipped(未配置) → return
 *  - Phase A: engine.merge() 三方合并 → 判定 needsReview（冲突/缺失依赖/Install/Error）
 *  - 冲突 → 跳过 + 写历史 skipped + conflictedSections[] → return
 *  - Phase B: 无冲突 → engine.applyMergePlan(apply) 写入本地
 *  - Phase C: 完整双向 → engine.push() 上传
 *  - 收尾：写 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures, lastRunHistoryId）
 *
 * 连续失败计数：只对网络/传输/apply 真实失败计数；skipped（未配置/冲突跳过/无远端）不计。
 * 连续失败 ≥ 3 → host.log.warn 通知 + 记 notifiedAt。
 */
import crypto from 'node:crypto';

import type { Logger } from '../utils/logger.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { SectionId } from '../schema/types.ts';
import type { RunRegistry } from '../core/run-registry.ts';
import type { SyncEngine } from './sync-engine.ts';
import { readAutosyncConfig, writeAutosyncConfig } from './autosync-config.ts';
import type { AutosyncConfig, AutosyncInterval, AutosyncRunStatus } from './autosync-config.ts';
import { readSyncConfig } from './sync-config.ts';
import type { SyncConfig } from './sync-config.ts';
import { readSyncHistory, appendAutosyncEntry } from './sync-history.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { MergePlan, MergeSectionResult } from './merge.ts';
import type { SyncApplyPlan } from './risk.ts';

/** 间隔 → ms 换算（§4.3） */
export function intervalToMs(interval: AutosyncInterval): number {
  const table: Record<AutosyncInterval, number> = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '60m': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  return table[interval];
}

/**
 * 启动触发下载合并且满足阈值（now - lastRunAt >= startupMinIntervalMs）？
 * lastRunAt 为 undefined（从未运行）→ true。
 */
export function shouldTriggerStartupRun(
  lastRunAt: string | undefined,
  startupMinIntervalMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (lastRunAt === undefined || lastRunAt === '') return true;
  const lastMs = Date.parse(lastRunAt);
  if (Number.isNaN(lastMs)) return true;
  return nowMs - lastMs >= startupMinIntervalMs;
}

/** runOnce 执行结果 */
export interface AutosyncRunResult {
  status: 'success' | 'skipped' | 'failed' | 'partial';
  direction: 'pull' | 'push' | 'both' | 'none';
  skipReason?: string;
  conflictedSections?: SectionId[];
  appliedSections?: SectionId[];
  pushedSnapshotId?: string;
  pulledSnapshotId?: string;
  error?: string;
  historyId: string;
  consecutiveFailures: number;
}

export interface AutoSyncSchedulerOptions {
  syncDir: string;
  host: { log: Logger };
  makeSyncEngine: (repoUrl: string, gitBin?: string) => SyncEngine;
  /** 消息翻译器 */
  msg: MsgFunc;
  runs: RunRegistry;
  /** 时间源（测试注​入） */
  now?: () => Date;
  /** 注入 autosync-config 读写（测试可内存实现） */
  readConfig?: () => Promise<AutosyncConfig>;
  writeConfig?: (cfg: AutosyncConfig) => Promise<void>;
  /** 注入 sync-config 读取 */
  readSyncConfigFn?: () => Promise<SyncConfig | null>;
  /** 注入 sync-history 读写 */
  readHistoryFn?: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  appendHistoryFn?: (entry: AutosyncHistoryEntry) => Promise<void>;
  /** 注入计时器（测试用；缺省 setInterval/clearInterval） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class AutoSyncScheduler {
  private readonly syncDir: string;
  private readonly host: { log: Logger };
  private readonly makeSyncEngine: (repoUrl: string, gitBin?: string) => SyncEngine;
  private readonly msg: MsgFunc;
  private readonly runs: RunRegistry;
  private readonly now: () => Date;
  private readonly readConfig: () => Promise<AutosyncConfig>;
  private readonly writeConfig: (cfg: AutosyncConfig) => Promise<void>;
  private readonly readSyncConfigFn: () => Promise<SyncConfig | null>;
  private readonly readHistoryFn: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  private readonly appendHistoryFn: (entry: AutosyncHistoryEntry) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;

  constructor(opts: AutoSyncSchedulerOptions) {
    this.syncDir = opts.syncDir;
    this.host = opts.host;
    this.makeSyncEngine = opts.makeSyncEngine;
    this.msg = opts.msg;
    this.runs = opts.runs;
    this.now = opts.now ?? (() => new Date());
    this.readConfig = opts.readConfig ?? (() => readAutosyncConfig(this.syncDir));
    this.writeConfig = opts.writeConfig ?? ((cfg) => writeAutosyncConfig(this.syncDir, cfg));
    this.readSyncConfigFn = opts.readSyncConfigFn ?? (() => readSyncConfig(this.syncDir));
    this.readHistoryFn = opts.readHistoryFn ?? (() => readSyncHistory(this.syncDir));
    this.appendHistoryFn = opts.appendHistoryFn ?? ((entry) => appendAutosyncEntry(this.syncDir, entry));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** 启动：读配置 → 若 enabled 启动定时器 → 无条件执行一次启动触发下载合并。 */
  start(): void {
    if (this.stopped) return;
    this.refreshTimer();
    void this.startupRun();
  }

  /** 停止：清定时器、标记不再调度；正在执行的任务允许自然结束。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** 重新加载配置（路由 POST /sync/autosync 后调用）。 */
  async reload(): Promise<void> {
    if (this.stopped) return;
    this.refreshTimer();
  }

  private refreshTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    void this.readConfig().then((cfg) => {
      if (this.stopped || !cfg.enabled) return;
      const ms = intervalToMs(cfg.interval);
      this.timer = this.setTimer(() => {
        if (this.stopped) return;
        void this.runOnce().catch((err) => {
          this.host.log.error('自动同步定时触发失败', { error: err instanceof Error ? err.message : String(err) });
        });
      }, ms);
    }).catch(() => { /* 读配置失败静默 */ });
  }

  /** 启动触发下载合并（受 startupMinIntervalMs 阈值约束）。 */
  private async startupRun(): Promise<void> {
    try {
      const cfg = await this.readConfig();
      if (!cfg.enabled) return; // 总开关关闭 → 启动触发不执行
      if (!shouldTriggerStartupRun(cfg.lastRunAt, cfg.startupMinIntervalMs, this.now().getTime())) {
        this.host.log.info('自动同步启动触发跳过：距上次运行未达阈值');
        return;
      }
      await this.runOnce({ startup: true });
    } catch (err) {
      this.host.log.error('启动触发下载合并失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 执行一次自动同步（§6.1）。
   * @param opts.startup - true 表示启动触发变体（只做 Phase A+B，不做 Phase C push）
   */
  async runOnce(opts: { startup?: boolean } = {}): Promise<AutosyncRunResult> {
    if (this.running) return { status: 'skipped', direction: 'none', skipReason: 'running', historyId: '', consecutiveFailures: 0 };
    const cfg = await this.readConfig();
    if (!cfg.enabled) {
      return { status: 'skipped', direction: 'none', skipReason: 'disabled', historyId: '', consecutiveFailures: cfg.consecutiveFailures };
    }

    this.running = true;
    const nowIso = this.now().toISOString();
    const historyId = `autosync-${crypto.randomUUID()}`;

    // runs 防重复：同 kind running → 跳过（内部语义，不打搅用户）
    let runId: string | null = null;
    try {
      const run = this.runs.register('autosync');
      runId = run.runId;
    } catch {
      this.running = false;
      return { status: 'skipped', direction: 'none', skipReason: 'conflict', historyId, consecutiveFailures: cfg.consecutiveFailures };
    }

    try {
      // 读 sync-config → repoUrl
      const syncCfg = await this.readSyncConfigFn();
      if (syncCfg === null || syncCfg.repoUrl === '') {
        const result: AutosyncRunResult = {
          status: 'skipped', direction: 'none', skipReason: 'unconfigured', historyId,
          consecutiveFailures: cfg.consecutiveFailures,
        };
        await this.appendHistoryFn({
          direction: 'both',
          status: 'skipped',
          skipReason: 'unconfigured',
          createdAt: nowIso,
          failureCountAtRun: cfg.consecutiveFailures,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId);
        return result;
      }

      const engine = this.makeSyncEngine(syncCfg.repoUrl, syncCfg.gitBin);

      // Phase A: pull 合并（下载）
      let mergePlan: MergePlan;
      try {
        mergePlan = await engine.merge();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const result: AutosyncRunResult = {
          status: 'failed', direction: 'pull', error, historyId,
          consecutiveFailures: cfg.consecutiveFailures + 1,
        };
        await this.appendHistoryFn({
          direction: 'pull', status: 'failed', error, createdAt: nowIso,
          failureCountAtRun: cfg.consecutiveFailures + 1,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId);
        this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso);
        return result;
      }

      // 判定 needsReview
      const reviewSections = mergePlan.sections.filter((s) => s.decision === 'conflict');
      if (reviewSections.length > 0) {
        const conflictedSections = reviewSections.map((s) => s.id);
        const result: AutosyncRunResult = {
          status: 'skipped', direction: 'pull', skipReason: 'conflict',
          conflictedSections, historyId,
          consecutiveFailures: cfg.consecutiveFailures,
        };
        await this.appendHistoryFn({
          direction: 'pull', status: 'skipped', skipReason: 'conflict',
          conflictedSections, createdAt: nowIso,
          failureCountAtRun: cfg.consecutiveFailures,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId);
        return result;
      }

      // 无冲突：构造 SyncApplyPlan（autoApply = 所有 useRemote/keepLocal 项；skipped = skip 项）
      const apply = buildAutoApplyPlan(mergePlan);
      if (apply.autoApply.length === 0) {
        // 无物可应用（全部 skip / 无变化）
        const result: AutosyncRunResult = {
          status: 'success', direction: 'pull', skipReason: 'unchanged', historyId,
          consecutiveFailures: 0,
        };
        await this.appendHistoryFn({
          direction: 'pull', status: 'success', skipReason: 'unchanged',
          createdAt: nowIso, failureCountAtRun: 0,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId);
        return result;
      }

      // Phase B: 写入本地（applyMergePlan，无 review-queue 写）
      const applyReport = await engine.applyMergePlan(apply);
      const appliedSections = applyReport.applied as SectionId[];
      if (!applyReport.ok) {
        const error = applyReport.warnings.join('; ') || 'applyMergePlan 执行失败';
        const result: AutosyncRunResult = {
          status: 'failed', direction: 'pull', error, historyId,
          consecutiveFailures: cfg.consecutiveFailures + 1,
        };
        await this.appendHistoryFn({
          direction: 'pull', status: 'failed', error, createdAt: nowIso,
          failureCountAtRun: cfg.consecutiveFailures + 1,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId);
        this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso);
        return result;
      }

      // Phase C: push 上传（完整双向）
      if (!opts.startup) {
        try {
          const pushReport = await engine.push();
          if (!pushReport.ok) {
            const error = pushReport.message ?? 'push 失败';
            const result: AutosyncRunResult = {
              status: 'failed', direction: 'both', appliedSections, error, historyId,
              consecutiveFailures: cfg.consecutiveFailures + 1,
            };
            await this.appendHistoryFn({
              direction: 'both', status: 'failed', appliedSections, error,
              createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
            });
            await this.writeFinalConfig(cfg, result, nowIso, historyId);
            this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso);
            return result;
          }
          const result: AutosyncRunResult = {
            status: 'success', direction: 'both', appliedSections,
            pushedSnapshotId: pushReport.snapshotId, historyId, consecutiveFailures: 0,
          };
          await this.appendHistoryFn({
            direction: 'both', status: 'success', appliedSections,
            pushedSnapshotId: pushReport.snapshotId, createdAt: nowIso, failureCountAtRun: 0,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const result: AutosyncRunResult = {
            status: 'failed', direction: 'both', appliedSections, error, historyId,
            consecutiveFailures: cfg.consecutiveFailures + 1,
          };
          await this.appendHistoryFn({
            direction: 'both', status: 'failed', appliedSections, error,
            createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId);
          this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso);
          return result;
        }
      }

      // startup 变体：只做 pull 合并（不上传）
      const result: AutosyncRunResult = {
        status: 'success', direction: 'pull', appliedSections, historyId, consecutiveFailures: 0,
      };
      await this.appendHistoryFn({
        direction: 'pull', status: 'success', appliedSections,
        createdAt: nowIso, failureCountAtRun: 0,
      });
      await this.writeFinalConfig(cfg, result, nowIso, historyId);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result: AutosyncRunResult = {
        status: 'failed', direction: 'none', error, historyId,
        consecutiveFailures: cfg.consecutiveFailures + 1,
      };
      await this.appendHistoryFn({
        direction: 'both', status: 'failed', error,
        createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
      });
      await this.writeFinalConfig(cfg, result, nowIso, historyId);
      this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso);
      return result;
    } finally {
      this.running = false;
      if (runId !== null) {
        // 完成标记（不抛错，尽力而为）
      }
    }
  }

  /** 收尾：写 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures, lastRunHistoryId）。 */
  private async writeFinalConfig(
    base: AutosyncConfig,
    result: AutosyncRunResult,
    nowIso: string,
    historyId: string,
  ): Promise<void> {
    await this.writeConfig({
      ...base,
      lastRunAt: nowIso,
      lastRunStatus: result.status,
      consecutiveFailures: result.consecutiveFailures,
      lastRunHistoryId: historyId,
      ...(result.error !== undefined ? { lastRunMessage: result.error } : {}),
    });
  }

  /** 连续失败 ≥ 3 → 通知（host.log.warn）。 */
  private maybeNotify(failures: number, historyId: string, nowIso: string): void {
    if (failures >= 3) {
      this.host.log.warn(`自动同步连续失败 ${failures} 次，请检查仓库配置/凭据`);
      // 记录 notifiedAt（更新历史 entry）
      void this.readHistoryFn().then(async (hist) => {
        const entry = hist.autosyncEntries.find((e) => e.createdAt === nowIso);
        if (entry) {
          entry.notifiedAt = nowIso;
          await this.writeConfig({
            ...(await this.readConfig()),
            lastRunMessage: `连续失败 ${failures} 次，已通知`,
          });
        }
      }).catch(() => { /* 尽力而为 */ });
    }
  }
}

/** 从 MergePlan 构造 SyncApplyPlan（autoApply = 所有非 skip 非 conflict 项）。 */
export function buildAutoApplyPlan(plan: MergePlan): SyncApplyPlan {
  const autoApply: MergeSectionResult[] = [];
  const review: MergeSectionResult[] = [];
  const skipped: MergeSectionResult[] = [];
  for (const s of plan.sections) {
    if (s.decision === 'skip') {
      skipped.push(s);
      continue;
    }
    if (s.decision === 'conflict') {
      review.push(s);
      continue;
    }
    // useRemote / keepLocal：都有 merged 数据
    if (s.merged !== undefined) {
      autoApply.push(s);
    } else {
      skipped.push(s);
    }
  }
  return { autoApply, review, skipped };
}
