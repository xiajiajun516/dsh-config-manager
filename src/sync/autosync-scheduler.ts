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
 *  - 冲突 → 只挡**下行**：跳过 Phase B（绝不写本地）+ 记 conflictedSections[]，
 *    但**继续**走到 Phase C 做纯上行导出（issue #79：远端冲突不该连坐「把本机配置推上去当备份」）
 *  - Phase B: 无冲突 → 按 risk.ts 的 classifyMergePlan 分流（audit-sync sync-F5）：
 *    低风险项自动应用；medium/high 项**不自动应用**并进 conflictedSections（待人工确认，绝不静默）
 *    → engine.applyMergePlan(autoApply) 写入本地
 *  - Phase C: 完整双向 → engine.push() 上传（本轮有冲突且推送成功 → 状态 partial，不谎报 success）
 *  - 收尾：写该通道 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures,
 *    lastRunHistoryId, lastRunMessage/跳过原因 —— 每轮覆盖上一轮，绝不残留旧错误）
 *
 * 连续失败计数（issue #79 起）：只有**真的失败**（网络/传输/apply）才 +1；success / skipped /
 * partial 一律归零 —— 否则「2 次真失败 + 16 次跳过」会长期显示「连续失败 2 次」，把用户引向网络排查。
 * 连续失败 ≥ 3 → host.log.warn 通知 + 记 notifiedAt。
 */
import crypto from 'node:crypto';

import type { Logger } from '../utils/logger.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { SectionId } from '../schema/types.ts';
import type { RunRegistry } from '../core/run-registry.ts';
import type { JournalRunContext } from '../core/phase3-host.ts';
import type { SyncEngine } from './sync-engine.ts';
import type { MutationLockPort, MutationLockContext } from '../utils/env-lock.ts';
import { withMutationLock, LOCK_BLOCK_MESSAGE } from '../utils/env-lock.ts';
import { engineMsg } from './messages.ts';
import { readAutosyncConfig, writeAutosyncConfig } from './autosync-config.ts';
import type { AutosyncConfig, AutosyncInterval } from './autosync-config.ts';
import { readSyncConfigFor, isGitConfig, isWebDavConfig, isS3Config, isGistConfig, SYNC_CHANNELS } from './sync-config.ts';
import type { SyncConfig, SyncTransportType } from './sync-config.ts';
import { readSyncHistory, appendAutosyncEntry } from './sync-history.ts';
import { classifyMergePlan } from './risk.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { MergePlan } from './merge.ts';
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
  /** Phase 2 跨进程环境锁端口（可选注入；缺省无锁环境——自动同步 apply（写本地配置）属 GLOBAL mutation） */
  mutationLock?: MutationLockPort;
  /** Phase 3 SAFE MODE：注入同步谓词（被挡 → autosync skip），供 withMutationLock isBlocked 用。 */
  isBlocked?: () => boolean;
  /** Phase 3 recovery（可选注入）：apply/push 包 intent journal（P0-A 接线）。 */
  phase3Recovery?: {
    runExternalIntent(opts: {
      operationType: string;
      lockCtx: MutationLockContext;
      intent: { adapter: string; ref: string; kind: string };
      /**
       * 审计 P0-23：上下文与 runJournaled **共用同一份绑定面**（含 recordRollback）。
       * 自动同步 apply 必须把它透传给 applyMergePlan，否则引擎内部完成的整体回滚
       * 会被 executeImportPlan 正常返回，最终被记成 COMMITTED（已回滚却报成功）。
       */
      fn: (ctx?: JournalRunContext) => Promise<unknown>;
    }): Promise<{ operationId: string; result: unknown }>;
  };
}

export class AutoSyncScheduler {
  private readonly syncDir: string;
  private readonly host: { log: Logger };
  private readonly makeSyncEngine: (cfg: SyncConfig) => SyncEngine;
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
  private readonly mutationLock: MutationLockPort | undefined;
  private readonly isBlocked: (() => boolean) | undefined;
  private readonly phase3Recovery: { runExternalIntent(opts: { operationType: string; lockCtx: MutationLockContext; intent: { adapter: string; ref: string; kind: string }; fn: (ctx?: JournalRunContext) => Promise<unknown> }): Promise<{ operationId: string; result: unknown }> } | undefined;
  /** 本次 runOnce 由 withMutationLock 取得的下游锁上下文（供 apply/push journal-wrap），非线程级。 */
  private lockCtxForJournal: MutationLockContext | null = null;

  /** 每通道一个定时器（git/webdav 各自 enabled 时独立排期）。 */
  private readonly timers = new Map<SyncTransportType, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private running = false;

  constructor(opts: AutoSyncSchedulerOptions) {
    this.syncDir = opts.syncDir;
    this.host = opts.host;
    this.makeSyncEngine = opts.makeSyncEngine;
    this.runs = opts.runs;
    this.now = opts.now ?? (() => new Date());
    this.readConfig = opts.readConfig ?? ((channel) => readAutosyncConfig(this.syncDir, channel));
    this.writeConfig = opts.writeConfig ?? ((channel, cfg) => writeAutosyncConfig(this.syncDir, channel, cfg));
    this.readSyncConfigFn = opts.readSyncConfigFn ?? ((channel) => readSyncConfigFor(this.syncDir, channel));
    this.readHistoryFn = opts.readHistoryFn ?? (() => readSyncHistory(this.syncDir));
    this.appendHistoryFn = opts.appendHistoryFn ?? ((entry) => appendAutosyncEntry(this.syncDir, entry));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.mutationLock = opts.mutationLock;
    this.isBlocked = opts.isBlocked;
    this.phase3Recovery = opts.phase3Recovery;
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
    // 通道清单唯一来源 = SYNC_CHANNELS（此前同一数组在本文件写了两遍：漏改一处即某通道永不排期）
    const channels = SYNC_CHANNELS;
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
    // 通道清单唯一来源 = SYNC_CHANNELS（此前同一数组在本文件写了两遍：漏改一处即某通道永不排期）
    const channels = SYNC_CHANNELS;
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

    /**
     * 收敛 run 账。**注册之后的每一条提前 return 都必须先调用它**。
     *
     * 为什么要有这个函数（真机 bug，2026-09）：锁获取段（下面 Phase 2）位于主 try **之外**，
     * 那两个 mutation-locked 早退曾经直接 return —— run 于是永久停在 running。实测证据：
     * sync-history 记下 `skipped / mutation-locked @19:30:45.104`，同刻注册的 run 直到 25 分钟后
     * 仍 updatedAt == createdAt；此后每次 autosync 都 `register('autosync')` → RunConflictError
     * → 后台同步静默停摆（正是下面 finally 注释警告的后果），运行中心里那张卡片也「一直在加载」。
     */
    const finishRun = (): void => {
      if (runId === null) return;
      try {
        this.runs.finish(runId, { kind: 'autosync' });
      } catch {
        /* 尽力而为：收尾失败不影响同步结果 */
      }
    };

    // Phase 2 锁：autosync 的 apply（写本地配置）与 push（写远端+本地散文件）属 GLOBAL mutation。
    // 获取失败（另一项 DSH 任务进行中）→ skipped(mutation-locked)；成功则在整个 runOnce 持锁并在 finally 释放。
    // 无锁环境（测试未注入 mutationLock）→ 不锁定，直接执行（与旧行为一致）。
    let releaseLock: (() => Promise<void>) | null = null;
    if (this.mutationLock !== undefined) {
      try {
        const lk = await withMutationLock(this.mutationLock, { op: 'autosync', target: channel, isBlocked: this.isBlocked });
        if (lk.context === null) {
          this.running = false;
          // issue #27：被挡时按分类告知用户。stale 残留锁「重试不会自愈」，必须显式回收——
          // 这里把与 423 响应同文案的指引写进日志，否则自动同步只会静默跳过，用户无从下手。
          // issue #31：与 backup-scheduler 对齐——非 stale 分类也留一行（不再只对 stale 说话）；
          // 更重要的是**补写历史**：此前该分支 return 前不写 sync-history，用户看历史面板
          // 只能发现「自动同步不再更新」，却看不到任何一条「为什么跳过」（实测 9 天 0 条记录）。
          if (lk.reason === 'stale') {
            this.host.log.warn(`自动同步已跳过（${channel}）：${LOCK_BLOCK_MESSAGE.stale}`);
          } else if (lk.reason !== undefined) {
            this.host.log.info(`自动同步已跳过（${channel}）：${LOCK_BLOCK_MESSAGE[lk.reason]}`);
          }
          // issue #79：被挡不是「失败」，连续失败计数归零 —— 真机现场「2 次真失败 + 16 次跳过」
          // 长期把计数挂在 2 上，面板却说「连续失败」，误导用户去查网络。
          await this.appendHistory(channel, {
            direction: 'both',
            status: 'skipped',
            skipReason: 'mutation-locked',
            createdAt: nowIso,
            failureCountAtRun: 0,
          });
          finishRun();
          return {
            status: 'skipped', direction: 'none', skipReason: 'mutation-locked', historyId,
            consecutiveFailures: 0,
          };
        }
        releaseLock = lk.release;
        this.lockCtxForJournal = lk.context;
      } catch {
        // issue #31 D：acquire 本身抛错（锁目录 IO/权限）也是「被挡」，同样必须留历史 ——
        // 否则用户在历史面板只会看到「自动同步不再更新」，而没有任何一条解释。
        this.running = false;
        await this.appendHistory(channel, {
          direction: 'both',
          status: 'skipped',
          skipReason: 'mutation-locked',
          createdAt: nowIso,
          failureCountAtRun: 0,
        });
        finishRun();
        return { status: 'skipped', direction: 'none', skipReason: 'mutation-locked', historyId, consecutiveFailures: 0 };
      }
    }

    try {
      // 读该通道 sync-config：按通道判定「已配置」——git 看 git.repoUrl、webdav 看 webdav.url。
      const syncCfg = await this.readSyncConfigFn(channel);
      if (!syncIsConfigured(syncCfg)) {
        const result: AutosyncRunResult = {
          status: 'skipped', direction: 'none', skipReason: 'unconfigured', historyId,
          consecutiveFailures: 0,
        };
        await this.appendHistory(channel, {
          direction: 'both',
          status: 'skipped',
          skipReason: 'unconfigured',
          createdAt: nowIso,
          failureCountAtRun: 0,
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
          consecutiveFailures: 0,
        };
        await this.appendHistory(channel, {
          direction: 'pull', status: 'skipped', skipReason: 'encrypted',
          createdAt: nowIso, failureCountAtRun: 0,
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
          consecutiveFailures: 0,
        };
        await this.appendHistory(channel, {
          direction: 'both', status: 'success', skipReason: 'upToDate',
          createdAt: nowIso, failureCountAtRun: 0,
        });
        await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
        return result;
      }

      let appliedSections: SectionId[] = [];
      // audit-sync sync-F5：被风险分级扣下、需人工确认的分区（medium/high）。在 Phase A 赋值、
      // Phase C 与收尾写历史都要用，故声明在两者之外。
      let deferredSections: SectionId[] = [];
      /**
       * 本轮远端冲突分区（issue #79）。非空 = **下行**被冲突挡下（绝不写本地），
       * 但 **上行 push 与冲突无关** —— 不再像改造前那样整轮 return 连纯上行一起封死：
       * 真机现场「推本机配置当备份」这条链路被远端冲突连续阻塞，用户却只看到 skipped/conflict。
       */
      let conflictedSections: SectionId[] = [];

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
        conflictedSections = reviewSections.map((s) => s.id);

        // 冲突：跳过 Phase B（绝不把冲突内容写进本地），但**继续**走到 Phase C 做纯上行导出。
        // 风险分级（audit-sync sync-F5）照旧只在无冲突时执行。
        if (conflictedSections.length === 0) {
          // 无冲突：按 risk.ts 的风险分级契约分流（audit-sync sync-F5）。
          // 此前用 buildAutoApplyPlan 无条件应用全部非冲突分区 → medium/high 分区（plugins/mcp/
          // workspaces 等）在无用户确认时被自动写进本地，与 classifyMergePlan 的既定口径
          // （低风险自动应用；medium/high → 待审）分叉，「首次同步强制预览」在自动路径上也形同虚设。
          // firstSync 恒 false：真正的首次同步没有祖先基线，merge 已把两侧差异判成 conflict → 走人工确认。
          const apply = classifyMergePlan(mergePlan, { firstSync: false });
          // 待审项（medium/high：决策明确但不该自动应用）必须可见 —— 进历史 conflictedSections，
          // 绝不静默丢弃；真正的冲突已在上方记入 conflictedSections。
          deferredSections = apply.review.map((s) => s.id);
          if (apply.autoApply.length === 0) {
            // 远端快照无物可应用（全部 skip / 无变化）→ 无远端合并产出；若本地有改动则仅走上传。
            // 此处不立即返回，让 Phase C 依据 localDirty 决定是否上传本地改动。
          } else {
            // Phase B: 写入本地（applyMergePlan，无 review-queue 写）。P0-A：包 intent journal。
            const rawApply = async (ctx?: JournalRunContext) => engine.applyMergePlan(
              apply,
              // 审计 P0-23（真实调用方提供绑定）：把 intent journal 的绑定面透传下去，使
              // applyMergePlan 内部的整体回滚经 recordRollback 上报 → 终态 ROLLED_BACK 而非 COMMITTED。
              // 无 phase3Recovery（无锁环境/测试）时不传绑定，行为与改造前逐字一致。
              ctx !== undefined ? { snapshotBinding: ctx } : {},
            );
            const applyReport = (this.phase3Recovery !== undefined && this.lockCtxForJournal !== null)
              ? (await this.phase3Recovery.runExternalIntent({
                  operationType: 'autosync-apply', lockCtx: this.lockCtxForJournal,
                  intent: { adapter: 'sync', ref: channel, kind: 'Apply' }, fn: rawApply,
                })).result as import('./sync-engine.ts').ApplyReport
              : await rawApply();
            appliedSections = applyReport.applied as SectionId[];
            if (!applyReport.ok) {
              const error = applyReport.warnings.join('; ') || engineMsg('sync.autosyncApplyMergeFailed');
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
      }

      // Phase C: push 上传（完整双向）—— 仅当本地真有改动才上传（§3.1）；startup 变体不上传。
      if (!opts.startup && localDirty) {
        try {
          // Phase C: 完整双向 → engine.push() 上传。P0-A：外部 push 包 intent journal。
          const rawPush = async () => engine.push();
          const pushReport = (this.phase3Recovery !== undefined && this.lockCtxForJournal !== null)
            ? (await this.phase3Recovery.runExternalIntent({
                operationType: 'autosync-push', lockCtx: this.lockCtxForJournal,
                intent: { adapter: 'sync', ref: channel, kind: 'Push' }, fn: rawPush,
              })).result as import('./sync-engine.ts').SyncPushReport
            : await rawPush();
          if (!pushReport.ok && pushReport.conflict === true) {
            // 引擎前置检测拒绝写入：远端已被别的设备推进 —— 这是**有冲突待处理**，不是通道/凭据故障。
            // 绝不记 failed（那会累加连续失败计数并对用户发通知，把「需要用『检查远程合并』处理」
            // 谎报成「同步坏了」）；错误摘要保留引擎给出的说明（用户能看见到底为什么没推上去）。
            const message = pushReport.message ?? engineMsg('sync.autosyncPushFailed');
            const conflictResult: AutosyncRunResult = {
              status: conflictedSections.length > 0 ? 'partial' : 'skipped',
              direction: appliedSections.length ? 'both' : 'push',
              skipReason: 'conflict', error: message, historyId,
              appliedSections,
              ...(conflictedSections.length > 0 ? { conflictedSections } : {}),
              consecutiveFailures: 0,
            };
            await this.appendHistory(channel, {
              direction: appliedSections.length ? 'both' : 'push', status: conflictResult.status,
              skipReason: 'conflict', error: message,
              appliedSections,
              ...(conflictedSections.length > 0 ? { conflictedSections } : {}),
              createdAt: nowIso, failureCountAtRun: 0,
            });
            await this.writeFinalConfig(cfg, conflictResult, nowIso, historyId, channel);
            return conflictResult;
          }
          if (!pushReport.ok) {
            const error = pushReport.message ?? engineMsg('sync.autosyncPushFailed');
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
          // issue #79：上行成功但下行被冲突挡下 → partial（绝不把「半个方向完成」报成 success，
          // 也绝不因为它报成 failed：网络与凭据都是好的，只是远端有内容要用户确认）。
          const partial = conflictedSections.length > 0;
          const result: AutosyncRunResult = {
            status: partial ? 'partial' : 'success',
            direction: appliedSections.length ? 'both' : 'push',
            appliedSections, pushedSnapshotId: pushReport.snapshotId, historyId,
            ...(partial ? { skipReason: 'conflict' as const } : {}),
            ...(deferredSections.length > 0 ? { conflictedSections: deferredSections } : {}),
            ...(partial ? { conflictedSections } : {}),
            consecutiveFailures: 0,
          };
          await this.appendHistory(channel, {
            direction: appliedSections.length ? 'both' : 'push',
            status: partial ? 'partial' : 'success',
            appliedSections, pushedSnapshotId: pushReport.snapshotId,
            ...(partial ? { skipReason: 'conflict' as const, conflictedSections } : {}),
            ...(!partial && deferredSections.length > 0 ? { conflictedSections: deferredSections } : {}),
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

      // 本轮下行被冲突挡下、且没有可上行内容（startup 变体 / 本地无改动）→ 如实 skipped/conflict。
      if (conflictedSections.length > 0) {
        const conflictResult: AutosyncRunResult = {
          status: 'skipped', direction: 'pull', skipReason: 'conflict',
          conflictedSections, historyId, consecutiveFailures: 0,
        };
        await this.appendHistory(channel, {
          direction: 'pull', status: 'skipped', skipReason: 'conflict',
          conflictedSections, createdAt: nowIso, failureCountAtRun: 0,
        });
        await this.writeFinalConfig(cfg, conflictResult, nowIso, historyId, channel);
        return conflictResult;
      }

      // startup 变体 / 仅远端合并：只做 pull 合并（不上传），或远端无新生且本地无改动（已在上方 upToDate 短路上）。
      const result: AutosyncRunResult = {
        status: 'success', direction: 'pull', appliedSections,
        ...(appliedSections.length === 0 ? { skipReason: 'unchanged' as const } : {}),
        ...(deferredSections.length > 0 ? { conflictedSections: deferredSections } : {}),
        historyId, consecutiveFailures: 0,
      };
      await this.appendHistory(channel, {
        direction: 'pull', status: 'success', appliedSections,
        ...(appliedSections.length === 0 ? { skipReason: 'unchanged' as const } : {}),
        ...(deferredSections.length > 0 ? { conflictedSections: deferredSections } : {}),
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
      // 收尾 RunRegistry：不 finish 会让 autosync 的 running 记录滞留，期间任何再次 runOnce
      // 都会 register('autosync') → RunConflictError → 永远 skip(conflict)，后台同步就此停摆。
      // 同一收敛点也必须在**主 try 之外**的早退路径上调用（见 finishRun 的注释）。
      finishRun();
      // Phase 2 锁：始终释放（若本次成功获取）
      if (releaseLock !== null) {
        await releaseLock().catch(() => { /* 尽力而为 */ });
      }
    }
  }

  /**
   * 收尾：写该通道 autosync-config（lastRunAt / lastRunStatus / consecutiveFailures /
   * lastRunHistoryId / 本轮消息与跳过原因）。
   *
   * issue #79：**每一轮都必须覆盖上一轮的 lastRunMessage 与 lastRunSkipReason**。
   * 此前只在 `result.error !== undefined` 时写 lastRunMessage → 真机现场连续 16 次 skipped 期间，
   * 面板一直挂着几天前「旧地址连接超时」，用户据此去查网络；跳过原因则只进了 info 级日志
   * （默认日志级别 warn），所以「为什么没同步」在界面与日志里都看不见。
   * 现在：失败写错误原文；跳过写**结构化原因码**（界面按码取字典，语言在渲染那刻解析）；
   * 成功清空两者（空串/undefined 不进文件，见 autosync-config.toChannelPayload）。
   */
  private async writeFinalConfig(
    base: AutosyncConfig,
    result: AutosyncRunResult,
    nowIso: string,
    historyId: string,
    channel: SyncTransportType,
  ): Promise<void> {
    const skipReason = result.status === 'failed' ? undefined : result.skipReason;
    const skipCount = skipReason !== 'conflict' || result.conflictedSections === undefined
      ? undefined
      : result.conflictedSections.length;
    await this.writeConfig(channel, {
      ...base,
      lastRunAt: nowIso,
      lastRunStatus: result.status,
      consecutiveFailures: result.consecutiveFailures,
      lastRunHistoryId: historyId,
      lastRunMessage: result.error ?? '',
      lastRunSkipReason: skipReason,
      lastRunSkipCount: skipCount,
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
            lastRunMessage: engineMsg('sync.autosyncConsecutiveFailureNotified', { count: failures }),
          });
        }
      }).catch(() => { /* 尽力而为 */ });
    }
  }
}

/**
 * 从 MergePlan 构造 SyncApplyPlan —— **单一决策源 = risk.ts 的 classifyMergePlan**
 * （audit-sync sync-F5）。
 *
 * 此前本函数自己写了一套「非 skip 非 conflict 一律 autoApply」的分流，绕过了风险分级：
 * medium/high 分区（plugins/mcp/workspaces…）会在无人确认时被自动写进本地，与
 * `classifyMergePlan`（低风险自动应用；medium/high → 待审）分叉；`merged === undefined`
 * 的项还会被静默丢进 skipped。
 *
 * 现在委托 classifyMergePlan（firstSync=false：真正的首次同步没有祖先基线，merge 已把
 * 两侧差异判成 conflict → 走人工确认），并把「决策明确但缺 merged 数据」的项保守改判为
 * review —— 绝不静默应用空载荷。
 */
export function buildAutoApplyPlan(plan: MergePlan): SyncApplyPlan {
  const split = classifyMergePlan(plan, { firstSync: false });
  const autoApply = split.autoApply.filter((s) => s.merged !== undefined);
  const review = [
    ...split.review,
    ...split.autoApply.filter((s) => s.merged === undefined),
  ];
  return { autoApply, review, skipped: split.skipped };
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
  // 云端点通道：非密字段已解析出来（读取层对未配置一律回 null）；这里再核一次必填项。
  // 缺任一必填 → 视为未配置 → autosync 安静跳过（unconfigured），不抛错、不空转。
  if (isS3Config(cfg)) {
    return cfg.s3.bucket !== '' && cfg.s3.accessKeyId !== '';
  }
  if (isGistConfig(cfg)) {
    return cfg.gist.gistId !== '';
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
