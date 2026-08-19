/**
 * AutoSyncScheduler：宿主后台自动同步调度器（按同步通道独立调度）。
 *
 * 生命周期：
 *  - start()：读两个通道（git/webdav）的 autosync 配置；每个 enabled 通道启动独立定时器
 *    （按各自 interval）；无条件对每个 enabled 通道执行一次「启动触发下载合并」
 *    （受各自 startupMinIntervalMs 阈值约束）。
 *  - stop()：清全部定时器、标记不再调度。
 *  - runOnce(channel)：对指定通道执行一次完整双向自动同步（§6.1 流程）。
 *
 * 双通道语义：git 与 webdav 的自动同步配置（enabled/interval/运行状态）各自独立，
 * 互不干扰；同一时刻至多执行一个通道的 runOnce（runs.register('autosync') 全局防重，
 * 避免两个引擎并发写本地配置），另一通道的定时触发在本轮结束后自然补跑。
 *
 * 核心逻辑（runOnce）：
 *  - 读该通道配置；若 !enabled → return
 *  - runs.register('autosync') 防重复；同 kind running → 跳过
 *  - readSyncConfig(该通道) → 按通道判定未配置（git 无 git.repoUrl / webdav 无 webdav.url）
 *    → 记 skipped(未配置) → return
 *  - Phase A: engine.merge() 三方合并 → 判定 needsReview（冲突/缺失依赖/Install/Error）
 *  - 冲突 → 跳过 + 写历史 skipped + conflictedSections[] → return
 *  - Phase B: 无冲突 → engine.applyMergePlan(apply) 写入本地
 *  - Phase C: 完整双向 → engine.push() 上传
 *  - 收尾：写该通道 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures, lastRunHistoryId）
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
import { readSyncConfigFor, isGitConfig, isWebDavConfig } from './sync-config.ts';
import type { SyncConfig, SyncTransportType } from './sync-config.ts';
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
  /** 注入 SyncEngine 构造器：按 SyncConfig 构造对应通道的引擎（git/webdav）。 */
  makeSyncEngine: (cfg: SyncConfig) => SyncEngine;
  /** 消息翻译器 */
  msg: MsgFunc;
  runs: RunRegistry;
  /** 时间源（测试注入） */
  now?: () => Date;
  /** 注入 autosync-config 读写（按通道；测试可内存实现） */
  readConfig?: (channel: SyncTransportType) => Promise<AutosyncConfig>;
  writeConfig?: (channel: SyncTransportType, cfg: AutosyncConfig) => Promise<void>;
  /** 注入 sync-config 读取（按通道） */
  readSyncConfigFn?: (channel: SyncTransportType) => Promise<SyncConfig | null>;
  /** 注入 sync-history 读写 */
  readHistoryFn?: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  appendHistoryFn?: (entry: AutosyncHistoryEntry) => Promise<void>;
  /** 注入计时器（测试用；缺省 setInterval/clearInterval） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * 远端新快照检测（§3.2「下载=检测到远端新快照才拉取」）。
   * 缺省：若 engine 实现了 hasNewRemoteSnapshot() 则调用；否则视为 true（保持旧行为=每次拉取）。
   */
  detectRemoteNew?: (engine: SyncEngine) => Promise<boolean>;
  /**
   * 本地配置变化检测（§3.1「上传=本地改动才推」）。
   * 缺省：若 engine 实现了 hasLocalChanges() 则调用；否则视为 true（保持旧行为=每次都推）。
   */
  detectLocalChange?: (engine: SyncEngine) => Promise<boolean>;
}

export class AutoSyncScheduler {
  private readonly syncDir: string;
  private readonly host: { log: Logger };
  private readonly makeSyncEngine: (cfg: SyncConfig) => SyncEngine;
  private readonly msg: MsgFunc;
  private readonly runs: RunRegistry;
  private readonly now: () => Date;
  private readonly readConfig: (channel: SyncTransportType) => Promise<AutosyncConfig>;
  private readonly writeConfig: (channel: SyncTransportType, cfg: AutosyncConfig) => Promise<void>;
  private readonly readSyncConfigFn: (channel: SyncTransportType) => Promise<SyncConfig | null>;
  private readonly readHistoryFn: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  private readonly appendHistoryFn: (entry: AutosyncHistoryEntry) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly detectRemoteNew: (engine: SyncEngine) => Promise<boolean>;
  private readonly detectLocalChange: (engine: SyncEngine) => Promise<boolean>;

  /** 每通道一个定时器（git/webdav 各自 enabled 时独立排期）。 */
  private readonly timers = new Map<SyncTransportType, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private running = false;

  constructor(opts: AutoSyncSchedulerOptions) {
    this.syncDir = opts.syncDir;
    this.host = opts.host;
    this.makeSyncEngine = opts.makeSyncEngine;
    this.msg = opts.msg;
    this.runs = opts.runs;
    this.now = opts.now ?? (() => new Date());
    this.readConfig = opts.readConfig ?? ((channel) => readAutosyncConfig(this.syncDir, channel));
    this.writeConfig = opts.writeConfig ?? ((channel, cfg) => writeAutosyncConfig(this.syncDir, channel, cfg));
    this.readSyncConfigFn = opts.readSyncConfigFn ?? ((channel) => readSyncConfigFor(this.syncDir, channel));
    this.readHistoryFn = opts.readHistoryFn ?? (() => readSyncHistory(this.syncDir));
    this.appendHistoryFn = opts.appendHistoryFn ?? ((entry) => appendAutosyncEntry(this.syncDir, entry));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.detectRemoteNew = opts.detectRemoteNew ?? defaultDetectRemoteNew;
    this.detectLocalChange = opts.detectLocalChange ?? defaultDetectLocalChange;
  }

  /** 追加一条自动同步历史（自动带上触发通道；0x 安全：绝不覆盖调用方显式 transport）。 */
  private async appendHistory(channel: SyncTransportType, entry: AutosyncHistoryEntry): Promise<void> {
    await this.appendHistoryFn({ ...entry, transport: channel });
  }

  /** 启动：读两个通道配置 → enabled 通道各自排定时器 → 对每个 enabled 通道执行一次启动触发。 */
  start(): void {
    if (this.stopped) return;
    this.refreshTimers();
    void this.startupRuns();
  }

  /** 停止：清全部定时器、标记不再调度；正在执行的任务允许自然结束。 */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
  }

  /** 重新加载配置（路由 POST /sync/autosync 后调用；重排所有通道定时器）。 */
  async reload(): Promise<void> {
    if (this.stopped) return;
    this.refreshTimers();
  }

  private refreshTimers(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    const channels: SyncTransportType[] = ['git', 'webdav'];
    for (const channel of channels) {
      void this.readConfig(channel).then((cfg) => {
        if (this.stopped || !cfg.enabled) return;
        const ms = intervalToMs(cfg.interval);
        const timer = this.setTimer(() => {
          // 一次性定时器：触发后立即从表移除，避免 reload() 清理到已失效的句柄
          this.timers.delete(channel);
          if (this.stopped) return;
          void this.runOnce(channel)
            .catch((err) => {
              this.host.log.error(`自动同步定时触发失败（${channel}）`, { error: err instanceof Error ? err.message : String(err) });
            })
            .then(() => {
              // 本轮结束（成功 / 跳过 / 失败）后重新排定下一次；refreshTimers
              // 内部重读配置，若期间被关闭（enabled=false）则不再排期。
              if (!this.stopped) this.refreshTimers();
            });
        }, ms);
        this.timers.set(channel, timer);
      }).catch(() => { /* 读配置失败静默 */ });
    }
  }

  /** 启动触发下载合并（每个 enabled 通道；受各自 startupMinIntervalMs 阈值约束）。 */
  private async startupRuns(): Promise<void> {
    const channels: SyncTransportType[] = ['git', 'webdav'];
    for (const channel of channels) {
      try {
        const cfg = await this.readConfig(channel);
        if (!cfg.enabled) continue; // 该通道总开关关闭 → 启动触发不执行
        if (!shouldTriggerStartupRun(cfg.lastRunAt, cfg.startupMinIntervalMs, this.now().getTime())) {
          this.host.log.info(`自动同步启动触发跳过（${channel}）：距上次运行未达阈值`);
          continue;
        }
        await this.runOnce(channel, { startup: true });
      } catch (err) {
        this.host.log.error(`启动触发下载合并失败（${channel}）`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * 执行一次指定通道的自动同步（§6.1）。
   * @param channel - 同步通道（git / webdav；各自独立的配置与运行状态）
   * @param opts.startup - true 表示启动触发变体（只做 Phase A+B，不做 Phase C push）
   */
  async runOnce(channel: SyncTransportType, opts: { startup?: boolean } = {}): Promise<AutosyncRunResult> {
    if (this.running) return { status: 'skipped', direction: 'none', skipReason: 'running', historyId: '', consecutiveFailures: 0 };
    const cfg = await this.readConfig(channel);
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
      // 读该通道 sync-config：按通道判定「已配置」——git 看 git.repoUrl、webdav 看 webdav.url。
      const syncCfg = await this.readSyncConfigFn(channel);
      if (!syncIsConfigured(syncCfg)) {
        const result: AutosyncRunResult = {
          status: 'skipped', direction: 'none', skipReason: 'unconfigured', historyId,
          consecutiveFailures: cfg.consecutiveFailures,
        };
        await this.appendHistory(channel, {
          direction: 'both',
          status: 'skipped',
          skipReason: 'unconfigured',
          createdAt: nowIso,
          failureCountAtRun: cfg.consecutiveFailures,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
        return result;
      }

      const engine = this.makeSyncEngine(syncCfg!);

      // 加密快照检测：远端最新快照为加密 → 自动同步无密码无法解密 → 整体跳过，
      // 同步历史记录 skipReason='encrypted'（提示需手动输入密码同步）。
      // 加密快照只通过手动推送/拉取产生与消费；自动同步仅处理普通快照。
      // list 失败宽容处理：视为无加密快照，继续正常流程（网络问题由后续链路暴露为 failed）。
      let encryptedRemote = false;
      try {
        const metas = await engine.listSnapshots();
        const latestMeta = metas.length > 0 ? metas[metas.length - 1]! : null;
        encryptedRemote = latestMeta !== null && latestMeta.manifest.encrypted === true;
      } catch {
        encryptedRemote = false;
      }
      if (encryptedRemote) {
        const result: AutosyncRunResult = {
          status: 'skipped', direction: 'pull', skipReason: 'encrypted', historyId,
          consecutiveFailures: cfg.consecutiveFailures,
        };
        await this.appendHistory(channel, {
          direction: 'pull', status: 'skipped', skipReason: 'encrypted',
          createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
        return result;
      }

      // 事件驱动触发（§3.1/§3.2/§3.3 看变化不看时间）：
      // - remoteNew：远端是否出现比本地祖先更新的快照 → 决定是否做下载合并（Phase A）；
      // - localDirty：本地 portable 配置相对基线是否真的变了 → 决定是否上传（Phase C）。
      // 定时器只是兜底轮询；真正驱动是这两个「变化」信号。
      const remoteNew = await this.detectRemoteNew(engine);
      const localDirty = await this.detectLocalChange(engine);

      // 两端都无变化 → 什么都不做，记为 upToDate（不重复拉取/不空转）。
      if (!remoteNew && !localDirty) {
        const result: AutosyncRunResult = {
          status: 'success', direction: 'none', skipReason: 'upToDate', historyId,
          consecutiveFailures: cfg.consecutiveFailures,
        };
        await this.appendHistory(channel, {
          direction: 'both', status: 'success', skipReason: 'upToDate',
          createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
        return result;
      }

      let appliedSections: SectionId[] = [];

      // Phase A: pull 合并（下载）—— 仅当远端有新快照才拉取（§3.2）。
      if (remoteNew) {
        let mergePlan: MergePlan;
        try {
          mergePlan = await engine.merge();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const result: AutosyncRunResult = {
            status: 'failed', direction: 'pull', error, historyId,
            consecutiveFailures: cfg.consecutiveFailures + 1,
          };
          await this.appendHistory(channel, {
            direction: 'pull', status: 'failed', error, createdAt: nowIso,
            failureCountAtRun: cfg.consecutiveFailures + 1,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
          this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso, channel);
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
          await this.appendHistory(channel, {
            direction: 'pull', status: 'skipped', skipReason: 'conflict',
            conflictedSections, createdAt: nowIso,
            failureCountAtRun: cfg.consecutiveFailures,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
          return result;
        }

        // 无冲突：构造 SyncApplyPlan（autoApply = 所有 useRemote/keepLocal 项；skipped = skip 项）
        const apply = buildAutoApplyPlan(mergePlan);
        if (apply.autoApply.length === 0) {
          // 远端快照无物可应用（全部 skip / 无变化）→ 无远端合并产出；若本地有改动则仅走上传。
          // 此处不立即返回，让 Phase C 依据 localDirty 决定是否上传本地改动。
        } else {
          // Phase B: 写入本地（applyMergePlan，无 review-queue 写）
          const applyReport = await engine.applyMergePlan(apply);
          appliedSections = applyReport.applied as SectionId[];
          if (!applyReport.ok) {
            const error = applyReport.warnings.join('; ') || 'applyMergePlan 执行失败';
            const result: AutosyncRunResult = {
              status: 'failed', direction: 'pull', error, historyId,
              consecutiveFailures: cfg.consecutiveFailures + 1,
            };
            await this.appendHistory(channel, {
              direction: 'pull', status: 'failed', error, createdAt: nowIso,
              failureCountAtRun: cfg.consecutiveFailures + 1,
            });
            await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
            this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso, channel);
            return result;
          }
        }
      }

      // Phase C: push 上传（完整双向）—— 仅当本地真有改动才上传（§3.1）；startup 变体不上传。
      if (!opts.startup && localDirty) {
        try {
          const pushReport = await engine.push();
          if (!pushReport.ok) {
            const error = pushReport.message ?? 'push 失败';
            const result: AutosyncRunResult = {
              status: 'failed', direction: appliedSections.length ? 'both' : 'push',
              appliedSections, error, historyId,
              consecutiveFailures: cfg.consecutiveFailures + 1,
            };
            await this.appendHistory(channel, {
              direction: appliedSections.length ? 'both' : 'push', status: 'failed',
              appliedSections, error,
              createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
            });
            await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
            this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso, channel);
            return result;
          }
          const result: AutosyncRunResult = {
            status: 'success', direction: appliedSections.length ? 'both' : 'push',
            appliedSections, pushedSnapshotId: pushReport.snapshotId, historyId,
            consecutiveFailures: 0,
          };
          await this.appendHistory(channel, {
            direction: appliedSections.length ? 'both' : 'push', status: 'success',
            appliedSections, pushedSnapshotId: pushReport.snapshotId,
            createdAt: nowIso, failureCountAtRun: 0,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const result: AutosyncRunResult = {
            status: 'failed', direction: appliedSections.length ? 'both' : 'push',
            appliedSections, error, historyId,
            consecutiveFailures: cfg.consecutiveFailures + 1,
          };
          await this.appendHistory(channel, {
            direction: appliedSections.length ? 'both' : 'push', status: 'failed',
            appliedSections, error,
            createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
          });
          await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
          this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso, channel);
          return result;
        }
      }

      // startup 变体 / 仅远端合并：只做 pull 合并（不上传），或远端无新生且本地无改动（已在上方 upToDate 短路上）。
      const result: AutosyncRunResult = {
        status: 'success', direction: 'pull', appliedSections,
        ...(appliedSections.length === 0 ? { skipReason: 'unchanged' as const } : {}),
        historyId, consecutiveFailures: 0,
      };
      await this.appendHistory(channel, {
        direction: 'pull', status: 'success', appliedSections,
        ...(appliedSections.length === 0 ? { skipReason: 'unchanged' as const } : {}),
        createdAt: nowIso, failureCountAtRun: 0,
      });
      await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result: AutosyncRunResult = {
        status: 'failed', direction: 'none', error, historyId,
        consecutiveFailures: cfg.consecutiveFailures + 1,
      };
      await this.appendHistory(channel, {
        direction: 'both', status: 'failed', error,
        createdAt: nowIso, failureCountAtRun: cfg.consecutiveFailures + 1,
      });
      await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
      this.maybeNotify(cfg.consecutiveFailures + 1, historyId, nowIso, channel);
      return result;
    } finally {
      this.running = false;
      // 收尾 RunRegistry：不 finish 会让 autosync 的 running 记录滞留
      // （保留期 30 分钟），期间任何再次 runOnce 都会 register('autosync')
      // → RunConflictError → 永远 skip(conflict)，后台同步就此停摆。
      if (runId !== null) {
        try {
          this.runs.finish(runId, { kind: 'autosync' });
        } catch {
          /* 尽力而为：收尾失败不影响同步结果 */
        }
      }
    }
  }

  /** 收尾：写该通道 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures, lastRunHistoryId）。 */
  private async writeFinalConfig(
    base: AutosyncConfig,
    result: AutosyncRunResult,
    nowIso: string,
    historyId: string,
    channel: SyncTransportType,
  ): Promise<void> {
    await this.writeConfig(channel, {
      ...base,
      lastRunAt: nowIso,
      lastRunStatus: result.status,
      consecutiveFailures: result.consecutiveFailures,
      lastRunHistoryId: historyId,
      ...(result.error !== undefined ? { lastRunMessage: result.error } : {}),
    });
  }

  /** 连续失败 ≥ 3 → 通知（host.log.warn）。 */
  private maybeNotify(failures: number, historyId: string, nowIso: string, channel: SyncTransportType): void {
    if (failures >= 3) {
      this.host.log.warn(`自动同步连续失败 ${failures} 次，请检查仓库配置/凭据（${channel}）`);
      // 记录 notifiedAt（更新历史 entry）
      void this.readHistoryFn().then(async (hist) => {
        const entry = hist.autosyncEntries.find((e) => e.createdAt === nowIso);
        if (entry) {
          entry.notifiedAt = nowIso;
          await this.writeConfig(channel, {
            ...(await this.readConfig(channel)),
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

/**
 * 同步通道是否「已配置」：git 看 git.repoUrl 非空；webdav 看 webdav.url 非空；
 * 未配置（null / 缺字段）→ false。作为 autosync 未配置跳过的判定依据。
 */
export function syncIsConfigured(cfg: SyncConfig | null): boolean {
  if (cfg === null || typeof cfg !== 'object') return false;
  if (isWebDavConfig(cfg)) {
    return typeof cfg.webdav.url === 'string' && cfg.webdav.url !== '';
  }
  if (isGitConfig(cfg)) {
    return typeof cfg.git.repoUrl === 'string' && cfg.git.repoUrl !== '';
  }
  return false;
}

/**
 * 缺省远端新快照检测（§3.2）：engine 实现了 hasNewRemoteSnapshot() → 调用；
 * 否则（测试 mock 未实现）保守返回 true（假设有新生，保持旧行为=每次都尝试拉取）。
 */
async function defaultDetectRemoteNew(engine: SyncEngine): Promise<boolean> {
  const fn = (engine as unknown as { hasNewRemoteSnapshot?: () => Promise<boolean> }).hasNewRemoteSnapshot;
  if (typeof fn === 'function') {
    try {
      return await fn.call(engine);
    } catch {
      return true; // 检测失败保守视为有新生，避免漏拉
    }
  }
  return true;
}

/**
 * 缺省本地变化检测（§3.1）：engine 实现了 hasLocalChanges() → 调用；
 * 否则（测试 mock 未实现）保守返回 true（假设有本地改动，保持旧行为=每次都尝试上传）。
 */
async function defaultDetectLocalChange(engine: SyncEngine): Promise<boolean> {
  const fn = (engine as unknown as { hasLocalChanges?: () => Promise<boolean> }).hasLocalChanges;
  if (typeof fn === 'function') {
    try {
      return await fn.call(engine);
    } catch {
      return true; // 检测失败保守视为有改动，避免漏传
    }
  }
  return true;
}
