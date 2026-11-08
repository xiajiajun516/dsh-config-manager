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
 * 「真·自动」（VS Code 式）两条即时通道（realtime=true 时生效）：
 *  - **本地改动即时上行**：SyncWatcher 监听本机可同步分区（watch-scope.ts 的清单，已排除
 *    sessions/、sync-autosync.json 等自写回声路径）→ 去抖后 trigger(channel,'local-change')；
 *  - **远端改动即时下行**：每 remoteCheckMs（缺省 60s，可 15s–1h）廉价探测一次远端是否有新快照
 *    → trigger(channel,'remote-poll')。定时器 interval 只作兜底。
 *
 * 核心逻辑（runOnce）：
 *  - 读该通道配置；若 !enabled → return
 *  - runs.register('autosync') 防重复；同 kind running → 跳过
 *  - readSyncConfig(该通道) → 按通道判定未配置（git 无 git.repoUrl / webdav 无 webdav.url）
 *    → 记 skipped(未配置) → return
 *  - Phase A: engine.merge() 三方合并 → 判定 needsReview（冲突/缺失依赖/Install/Error）
 *  - 冲突 → 只挡**下行**：跳过 Phase B（绝不写本地）+ 记 conflictedSections[]，
 *    但**继续**走到 Phase C（issue #79：远端冲突不该连坐「把本机配置推上去当备份」）
 *  - Phase B: 无冲突 → 按 risk.ts 的 classifyMergePlan 分流（audit-sync sync-F5）：
 *    低风险自动应用；medium 仅当 autoApplyTier='medium'（缺省）自动应用；
 *    high/未注册/冲突项**不自动应用**并进 conflictedSections（待人工确认，绝不静默）
 *    → engine.applyMergePlan(autoApply) 写入本地
 *  - Phase C: 完整双向 → engine.push() 上传。两处策略：
 *    ① 无冲突且推送被远端推进挡下 → skipped/partial + skipReason='conflict'（等人工）；
 *    ② conflictPolicy='local'（**只有用户显式选过才生效**；缺省 ask）且本轮有冲突 → **不写本地**，
 *       改 engine.push({force:true}) 把本机版本推成新的远端最新（被覆盖的远端旧版本仍在远端历史快照里
 *       可回滚），状态记 partial + skipReason='conflict-kept-local'（绝不谎报 success）；
 *       SYN-05：首轮 / 远端有新快照时即使选了 local 也降级 ask 并记 forced=true（见
 *       resolveConflictPushPolicy）——这两个时刻覆盖远端等于替用户丢数据。
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
import type { SyncSnapshotMeta } from './transport.ts';
import type { MutationLockPort, MutationLockContext } from '../utils/env-lock.ts';
import { withMutationLock, LOCK_BLOCK_MESSAGE, lockSkipToken } from '../utils/env-lock.ts';
import { engineMsg } from './messages.ts';
import {
  readAutosyncConfig, writeAutosyncConfig, clampRemoteCheckMs,
  DEFAULT_AUTOSYNC_REALTIME, DEFAULT_AUTOSYNC_REMOTE_CHECK_MS, DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
  DEFAULT_AUTOSYNC_CONFLICT_POLICY,
} from './autosync-config.ts';
import type { AutosyncConfig, AutosyncInterval } from './autosync-config.ts';
import { readSyncConfigFor, isGitConfig, isWebDavConfig, isS3Config, isGistConfig, SYNC_CHANNELS } from './sync-config.ts';
import type { SyncConfig, SyncConfigIssue, SyncTransportType } from './sync-config.ts';
import { readSyncHistory, appendAutosyncEntry, markAutosyncNotified } from './sync-history.ts';
import { classifyMergePlan } from './risk.ts';
import type { AutosyncHistoryEntry } from './sync-history.ts';
import type { AutosyncConflictPolicy } from './autosync-config.ts';
import type { MergePlan } from './merge.ts';
import type { SyncApplyPlan } from './risk.ts';
import { SyncWatcher } from './sync-watcher.ts';
import { buildWatchTargets } from './watch-scope.ts';

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
  /**
   * SYN-05：本轮 ask 是**被强制**的（首轮或远端有新快照），不是用户选的 ask。
   * 界面据此说清「这次没让你选」，避免用户以为自己的 local 设置失效了。
   */
  forced?: boolean;
  /**
   * SEC-03：本轮 skipReason='unconfigured' 时，已落盘配置为何被读侧丢弃（地址被白名单拒绝）。
   * 缺省 undefined = 真的没配。有值就必须让用户看见 —— 否则「保存过却被拒」和
   * 「从来没配」在界面上长得一模一样，用户会反复重填同一个被拒地址。
   */
  configIssue?: string;
}

/**
 * SYN-05：本轮冲突（下行冲突）该不该 force push —— 唯一判定点。
 *
 * 规则（缺省 ask 之上再加两道高危闸）：
 *  - 用户没选过策略 → 用缺省（ask）；
 *  - **首轮**（从未跑过）或**远端有新快照**：即使显式选了 'local' 也强制降级 ask（forcedAsk）——
 *    这两个时刻正是「远端最新改动只在历史快照里」的事故现场，静默覆盖等于替用户丢数据；
 *    降级记 forced，界面才能说清「这次没按你的 local 走」；
 *  - 只有「显式 local + 非高危时刻 + 真有冲突」才 force。
 *
 * 纯函数（无状态、无 I/O）：调度层与单测共用同一份判定，避免两处各写一遍阈值。
 */
export function resolveConflictPushPolicy(args: {
  configuredPolicy?: AutosyncConflictPolicy;
  firstRun: boolean;
  remoteNew: boolean;
  conflicted: number;
}): { policy: AutosyncConflictPolicy; force: boolean; forcedAsk: boolean } {
  const configured = args.configuredPolicy ?? DEFAULT_AUTOSYNC_CONFLICT_POLICY;
  // forcedAsk 只描述「用户选了 local，但本轮被降级」——缺省 ask 不算被强制（那不是用户的决定被推翻）。
  const forcedAsk = configured === 'local' && (args.firstRun || args.remoteNew);
  const policy: AutosyncConflictPolicy = forcedAsk ? 'ask' : configured;
  return { policy, force: policy === 'local' && args.conflicted > 0, forcedAsk };
}

/**
 * runOnce 的触发语义（只影响「做什么」的两个分支，不改变同步流程本身）。
 * reason 只进日志，用来说明这一轮是被谁叫醒的（排障时能区分「定时兜底」与「真有事发生」）。
 */
export interface AutosyncRunOptions {
  /** true = 启动触发变体：只做下行合并，不上传。 */
  startup?: boolean;
  /** 触发来源：interval / remote-poll / local-change / manual / startup / enable-toggle。 */
  reason?: string;
}

/** watcher 工厂入参（缺省实现 = 真实 SyncWatcher；测试注入内存实现）。 */
export interface WatcherFactoryOptions {
  homeDir: string;
  profile: string | undefined;
  log: Logger;
  /** 一批本地改动落地（已去抖）→ 交给调度器触发一轮同步。 */
  onFlush: (changed: readonly string[]) => void;
}

/** Phase 1（只读预检）的产出：要么本轮无事可做（skip），要么带回给 Phase A/B/C 的检测结论。 */
type AutosyncDetectOutcome =
  | { kind: 'skip'; result: AutosyncRunResult }
  | { kind: 'work'; engine: SyncEngine; remoteNew: boolean; localDirty: boolean; firstRun: boolean };

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
  /**
   * SEC-03：可选第二参收集「读侧被丢弃的配置成因」。既有注入实现（单参闭包）依然合法 ——
   * 少一个参数不是类型错误，缺省接线才负责真正回填。
   */
  readSyncConfigFn?: (channel: SyncTransportType, issues?: SyncConfigIssue[]) => Promise<SyncConfig | null>;
  /** 注入 sync-history 读写 */
  readHistoryFn?: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  appendHistoryFn?: (entry: AutosyncHistoryEntry) => Promise<void>;
  /** 注入计时器（测试用；缺省 setInterval/clearInterval） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * 远端新快照检测（§3.2「下载=检测到远端新快照才拉取」）。
   * 缺省：若 engine 实现了 hasNewRemoteSnapshot() 则调用；否则视为 true（保持旧行为=每次拉取）。
   * `listed` = 本轮已取到的远端列表（查加密快照时顺手拿到）—— 传下去就不必再 list 一次。
   */
  detectRemoteNew?: (engine: SyncEngine, listed?: readonly SyncSnapshotMeta[]) => Promise<boolean>;
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
  /**
   * 家目录（= DSH 的 $DSH_HOME）。提供时才启用「本地改动即时上行」的文件监听；
   * 缺省（测试/未接线）→ 只靠定时器与远端轮询，行为退化为改造前。
   */
  homeDir?: string;
  /** 当前 profile（决定监听 profiles/<profile>/ 下的组合 patch 与插件清单）。 */
  profile?: string;
  /** 注入 watcher 工厂（缺省 = 真实 SyncWatcher；测试可传内存实现）。 */
  makeWatcher?: (opts: WatcherFactoryOptions) => SyncWatcher;
  /** 触发合并窗口（ms）：连续保存/连续远端探测只跑一轮。缺省 3000。 */
  minTriggerGapMs?: number;
}

export class AutoSyncScheduler {
  private readonly syncDir: string;
  private readonly host: { log: Logger };
  private readonly makeSyncEngine: (cfg: SyncConfig) => SyncEngine;
  private readonly runs: RunRegistry;
  private readonly now: () => Date;
  private readonly readConfig: (channel: SyncTransportType) => Promise<AutosyncConfig>;
  private readonly writeConfig: (channel: SyncTransportType, cfg: AutosyncConfig) => Promise<void>;
  private readonly readSyncConfigFn: (channel: SyncTransportType, issues?: SyncConfigIssue[]) => Promise<SyncConfig | null>;
  private readonly readHistoryFn: () => Promise<Awaited<ReturnType<typeof readSyncHistory>>>;
  private readonly appendHistoryFn: (entry: AutosyncHistoryEntry) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly detectRemoteNew: (engine: SyncEngine, listed?: readonly SyncSnapshotMeta[]) => Promise<boolean>;
  private readonly detectLocalChange: (engine: SyncEngine) => Promise<boolean>;
  private readonly mutationLock: MutationLockPort | undefined;
  private readonly isBlocked: (() => boolean) | undefined;
  private readonly phase3Recovery: { runExternalIntent(opts: { operationType: string; lockCtx: MutationLockContext; intent: { adapter: string; ref: string; kind: string }; fn: (ctx?: JournalRunContext) => Promise<unknown> }): Promise<{ operationId: string; result: unknown }> } | undefined;
  /** 本次 runOnce 由 withMutationLock 取得的下游锁上下文（供 apply/push journal-wrap），非线程级。 */
  private lockCtxForJournal: MutationLockContext | null = null;

  /** 每通道一个定时器（git/webdav 各自 enabled 时独立排期）。 */
  private readonly timers = new Map<SyncTransportType, ReturnType<typeof setTimeout>>();
  /** realtime 通道的远端轮询定时器：与 interval 定时器**分开**，否则每次轮询都会重置兜底间隔。 */
  private readonly remoteTimers = new Map<SyncTransportType, ReturnType<typeof setTimeout>>();
  /** 本地改动监听（只有 enabled && realtime 的通道才挂；全关 → null）。 */
  private watcher: SyncWatcher | null = null;
  /** 当前需要监听的通道（setupWatchers 计算）。 */
  private realtimeChannels: SyncTransportType[] = [];
  /**
   * 运行期到达的触发：本轮收尾后立刻补跑（绝不并发写本地配置，也绝不丢）。
   * **每通道各存一个**：单槽字段会让后到的通道覆盖先到的（审计实测：git 运行期间 webdav 的
   * remote-poll 被 git 的 local-change 覆盖 ⇒ 该通道这一轮触发永久丢失，违反上面那句「绝不丢」）。
   */
  private readonly pendingTriggers = new Map<SyncTransportType, string>();
  /** 上次开始运行的时刻（trigger 的最小间隔合并用）。 */
  private readonly lastRunAtMs = new Map<SyncTransportType, number>();
  /** 因最小间隔被推迟的触发（每通道至多一个）。 */
  private readonly gapTimers = new Map<SyncTransportType, ReturnType<typeof setTimeout>>();
  private readonly homeDir: string | undefined;
  private readonly profile: string | undefined;
  private readonly makeWatcher: ((opts: WatcherFactoryOptions) => SyncWatcher) | undefined;
  private readonly minTriggerGapMs: number;
  /** SEC-03：已 warn 过的「地址被拒」成因（键 = 通道 + 成因文本），进程内去重。 */
  private readonly reportedConfigIssues = new Set<string>();
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
    this.readSyncConfigFn = opts.readSyncConfigFn ?? ((channel, issues) => readSyncConfigFor(this.syncDir, channel, issues));
    this.readHistoryFn = opts.readHistoryFn ?? (() => readSyncHistory(this.syncDir));
    this.appendHistoryFn = opts.appendHistoryFn ?? ((entry) => appendAutosyncEntry(this.syncDir, entry));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.mutationLock = opts.mutationLock;
    this.isBlocked = opts.isBlocked;
    this.phase3Recovery = opts.phase3Recovery;
    this.detectRemoteNew = opts.detectRemoteNew ?? defaultDetectRemoteNew;
    this.detectLocalChange = opts.detectLocalChange ?? defaultDetectLocalChange;
    this.homeDir = opts.homeDir;
    this.profile = opts.profile;
    this.makeWatcher = opts.makeWatcher ?? defaultMakeWatcher;
    this.minTriggerGapMs = opts.minTriggerGapMs ?? 3000;
  }

  /**
   * 追加一条自动同步历史（自动带上触发通道；0x 安全：绝不覆盖调用方显式 transport）。
   *
   * SYN-05：额外允许 forced（本轮 ask 是被强制的）。该字段不在 sync-history.ts 的
   * AutosyncHistoryEntry 里（那是另一个模块的公开契约，本轮不扩），但读写两侧都按普通对象
   * 原样透传（readSyncHistory 逐条 cast），所以运行时可稳定往返；界面按「字段有无」渲染。
   */
  private async appendHistory(
    channel: SyncTransportType,
    entry: AutosyncHistoryEntry & { forced?: boolean; configIssue?: string },
  ): Promise<void> {
    await this.appendHistoryFn({ ...entry, transport: channel });
  }

  /**
   * SEC-03：「地址被拒」是持久状态，而自动同步每 interval（缺省 60s）就转一圈 ——
   * 每轮打一条日志等于把日志刷成噪音。同一 (通道 + 成因) 只 warn 一次。
   * 用户改了配置后成因文本会变（message 带真实地址/原因），自然再报一次。
   */
  private reportConfigIssue(channel: SyncTransportType, detail: string): void {
    const key = channel + '/' + detail;
    if (this.reportedConfigIssues.has(key)) return;
    this.reportedConfigIssues.add(key);
    this.host.log.warn(`自动同步已跳过（${channel}）：同步通道配置被安全校验拒绝，请重新填写地址（${detail}）`);
  }

  /** 启动：读两个通道配置 → enabled 通道各自排定时器 → 对每个 enabled 通道执行一次启动触发。 */
  start(): void {
    if (this.stopped) return;
    this.refreshTimers();
    void this.startupRuns();
  }

  /** 停止：清全部定时器、拆掉文件监听、标记不再调度；正在执行的任务允许自然结束。 */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const timer of this.remoteTimers.values()) this.clearTimer(timer);
    this.remoteTimers.clear();
    for (const timer of this.gapTimers.values()) this.clearTimer(timer);
    this.gapTimers.clear();
    this.pendingTriggers.clear();
    this.watcher?.stop();
    this.watcher = null;
    this.realtimeChannels = [];
  }

  /** 重新加载配置（路由 POST /sync/autosync 后调用；重排所有通道定时器）。 */
  async reload(): Promise<void> {
    if (this.stopped) return;
    this.refreshTimers();
  }

  private refreshTimers(): void {
    this.scheduleIntervalTimers();
    this.scheduleRemoteTimers();
    void this.setupWatchers();
  }

  /**
   * 外部触发一次运行（本地改动 / 远端探测 / 另一通道让位）。
   *
   * - 正在跑 → 记进 pendingTriggers（按通道去重，同通道后来的 reason 覆盖先前的），本轮收尾后**逐通道立刻补跑**
   *   （不并发写本地配置，也绝不丢 —— 单槽时代后到的通道会吃掉先到的 → 该通道这轮触发永久丢失）；
   * - 距上次开始不足 minTriggerGapMs → 合并成一次（连续保存只跑一轮，每通道至多一个定时器）。
   */
  trigger(channel: SyncTransportType, reason: string = 'manual'): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingTriggers.set(channel, reason);
      return;
    }
    const waitMs = this.minTriggerGapMs - (this.now().getTime() - (this.lastRunAtMs.get(channel) ?? 0));
    if (waitMs > 0) {
      if (this.gapTimers.has(channel)) return;
      const timer = this.setTimer(() => {
        this.gapTimers.delete(channel);
        this.trigger(channel, reason);
      }, waitMs);
      this.gapTimers.set(channel, timer);
      return;
    }
    void this.runOnce(channel, { reason }).catch((err) => {
      this.host.log.error(`自动同步触发失败（${channel}/${reason}）`, { error: err instanceof Error ? err.message : String(err) });
    });
  }

  /** 兜底间隔定时器：每个 enabled 通道按各自 interval 排一次性定时器，触发后只重排自己。 */
  private scheduleIntervalTimers(): void {
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
          void this.runOnce(channel, { reason: 'interval' })
            .catch((err) => {
              this.host.log.error(`自动同步定时触发失败（${channel}）`, { error: err instanceof Error ? err.message : String(err) });
            })
            .then(() => {
              // 只重排 interval 定时器（远端轮询有自己的节奏，绝不互相重置）
              if (!this.stopped) this.scheduleIntervalTimers();
            });
        }, ms);
        this.timers.set(channel, timer);
      }).catch(() => { /* 读配置失败静默 */ });
    }
  }

  /**
   * realtime 通道的远端轮询：按 remoteCheckMs（缺省 60s）排一次性定时器。
   * 轮询只是「叫醒一轮 runOnce」—— 是否真的下载仍由 detectRemoteNew 判定，
   * 所以哪怕每 60s 叫醒一次，无变化时也只会记一条 upToDate 而不会反复传输。
   */
  private scheduleRemoteTimers(): void {
    for (const timer of this.remoteTimers.values()) this.clearTimer(timer);
    this.remoteTimers.clear();
    const channels = SYNC_CHANNELS;
    for (const channel of channels) {
      void this.readConfig(channel).then((cfg) => {
        if (this.stopped || !cfg.enabled || !(cfg.realtime ?? DEFAULT_AUTOSYNC_REALTIME)) return;
        const ms = clampRemoteCheckMs(cfg.remoteCheckMs ?? DEFAULT_AUTOSYNC_REMOTE_CHECK_MS);
        const timer = this.setTimer(() => {
          this.remoteTimers.delete(channel);
          if (this.stopped) return;
          this.trigger(channel, 'remote-poll');
          // 固定节奏：轮询不等本轮跑完就排下一次（trigger 自己负责合并/排队）
          if (!this.stopped) this.scheduleRemoteTimers();
        }, ms);
        this.remoteTimers.set(channel, timer);
      }).catch(() => { /* 读配置失败静默 */ });
    }
  }

  /** 按「enabled && realtime」重算监听集合：需要就挂、全关就拆（绝不留下空转句柄）。 */
  private async setupWatchers(): Promise<void> {
    const realtime: SyncTransportType[] = [];
    for (const channel of SYNC_CHANNELS) {
      try {
        const cfg = await this.readConfig(channel);
        if (cfg.enabled && (cfg.realtime ?? DEFAULT_AUTOSYNC_REALTIME)) realtime.push(channel);
      } catch { /* 读配置失败 → 该通道不挂监听 */ }
    }
    this.realtimeChannels = realtime;
    if (realtime.length === 0) {
      this.watcher?.stop();
      this.watcher = null;
      return;
    }
    if (this.homeDir === undefined || this.makeWatcher === undefined) return; // 未接线（测试）→ 只靠定时器
    if (this.watcher === null) {
      this.watcher = this.makeWatcher({
        homeDir: this.homeDir,
        profile: this.profile,
        log: this.host.log,
        onFlush: (changed) => this.onLocalChange(changed),
      });
      this.watcher.start();
      this.host.log.info(`自动同步已开启本地改动监听（${realtime.join('/')}）`);
    }
  }

  /** watcher 回调：任一批改动 → 让所有 realtime 通道各跑一轮（各自有变化检测，不会空转传输）。 */
  private onLocalChange(changed: readonly string[]): void {
    if (this.stopped || changed.length === 0) return;
    this.host.log.debug(`检测到本地配置改动（${changed.length} 个路径）→ 触发自动同步`);
    for (const channel of this.realtimeChannels) this.trigger(channel, 'local-change');
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
        await this.runOnce(channel, { startup: true, reason: 'startup' });
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
  async runOnce(channel: SyncTransportType, opts: AutosyncRunOptions = {}): Promise<AutosyncRunResult> {
    const result = await this.runOnceInternal(channel, opts);
    // 收尾后补跑：运行期到达的触发（watcher 连续保存 / 远端轮询 / 定时器到期）不会丢。
    // 放在内部实现之外（而不是 finally 里）是为了让锁与 run 账**完全释放之后**才开始下一轮。
    // 逐通道排空：多个通道同时排队时都要补跑（单槽时代只有最后那个能活下来）。
    // **串行 await**：并发 fire-and-forget 会在 RunRegistry 里撞同 kind conflict（第二个被 skip 掉，
    // 等于换个方式又丢一次触发）。补跑期间新到达的触发重新进 map，由那一轮自己排空（自然收敛）。
    if (this.pendingTriggers.size > 0 && !this.stopped) {
      const pending = [...this.pendingTriggers];
      this.pendingTriggers.clear();
      for (const [pendingChannel, pendingReason] of pending) {
        if (this.stopped) break;
        await this.runOnce(pendingChannel, { reason: pendingReason });
      }
    }
    return result;
  }

  private async runOnceInternal(channel: SyncTransportType, opts: AutosyncRunOptions = {}): Promise<AutosyncRunResult> {
    if (this.running) return { status: 'skipped', direction: 'none', skipReason: 'running', historyId: '', consecutiveFailures: 0 };
    const cfg = await this.readConfig(channel);
    if (!cfg.enabled) {
      return { status: 'skipped', direction: 'none', skipReason: 'disabled', historyId: '', consecutiveFailures: cfg.consecutiveFailures };
    }

    this.running = true;
    this.lastRunAtMs.set(channel, this.now().getTime());
    // 本轮会写本机配置（apply）→ 暂停监听，别把自己的写入当成「用户改了配置」（否则自激循环）。
    this.watcher?.suspend();
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


    // Phase 1：无锁预检（只读：读配置 + 列远端 + 检测两端变化）。
    //
    // 为什么先检测再取锁（2026-11-07 真机事故）：检测里的 plugins 分区导出会为本机源插件跑 npm pack
    // （实测单个 210MB 插件 44.7s/次、每轮重算）。旧实现把这段整个放进 GLOBAL mutation 锁内，60s 一轮的
    // 轮询于是让锁几乎全程被占（45s/60s），用户任何 destructive 操作（删除档案…）都撞 423「另一个任务正在运行」。
    // 现在稳态（upToDate）根本不取锁；命中「有活干」才取，并在锁内重跑检测再写。
    const preflight = await this.detectPhase(channel, cfg, nowIso, historyId);
    if (preflight.kind === 'skip') {
      this.running = false;
      this.watcher?.resume();
      finishRun();
      return preflight.result;
    }

    let releaseLock: (() => Promise<void>) | null = null;
    if (this.mutationLock !== undefined) {
      try {
        // 本轮开始前先自愈：上一轮异常退出留下的**可证** stale 残留锁只会让每轮静默 skip，
        // 用户不重启就永远不同步。只删可证的（owner 确证死亡 / PID 复用），其余保持下面既有的 warn 路径。
        try { await this.mutationLock.reclaimProvableStaleLock?.() } catch { /* 预检失败不改变既有路径 */ }
        const lk = await withMutationLock(this.mutationLock, { op: 'autosync', target: channel, isBlocked: this.isBlocked });
        if (lk.context === null) {
          this.running = false;
          // issue #27：被挡时按分类告知用户。stale 残留锁「重试不会自愈」，必须显式回收——
          // 这里把与 423 响应同文案的指引写进日志，否则自动同步只会静默跳过，用户无从下手。
          // issue #31：与 backup-scheduler 对齐——非 stale 分类也留一行（不再只对 stale 说话）；
          // 更重要的是**补写历史**：此前该分支 return 前不写 sync-history，用户看历史面板
          // 只能发现「自动同步不再更新」，却看不到任何一条「为什么跳过」（实测 9 天 0 条记录）。
          // stale 与 stale-degraded 同属「重试不会自愈」，都走 warn（都带显式回收指引）。
          if (lk.reason === 'stale' || lk.reason === 'stale-degraded') {
            this.host.log.warn(`自动同步已跳过（${channel}）：${LOCK_BLOCK_MESSAGE[lk.reason]}`);
          } else if (lk.reason !== undefined) {
            this.host.log.info(`自动同步已跳过（${channel}）：${LOCK_BLOCK_MESSAGE[lk.reason]}`);
          }
          // issue #79：被挡不是「失败」，连续失败计数归零 —— 真机现场「2 次真失败 + 16 次跳过」
          // 长期把计数挂在 2 上，面板却说「连续失败」，误导用户去查网络。
          await this.appendHistory(channel, {
            direction: 'both',
            status: 'skipped',
            skipReason: lockSkipToken(lk.reason),
            createdAt: nowIso,
            failureCountAtRun: 0,
          });
          finishRun();
          return {
            status: 'skipped', direction: 'none', skipReason: lockSkipToken(lk.reason), historyId,
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
          // acquire 本身抛错（锁目录 IO/权限）：既不是「被占」也不是「残留」，如实报不可用。
          skipReason: lockSkipToken('unavailable'),
          createdAt: nowIso,
          failureCountAtRun: 0,
        });
        finishRun();
        return { status: 'skipped', direction: 'none', skipReason: lockSkipToken('unavailable'), historyId, consecutiveFailures: 0 };
      }
    }
    try {
      // 锁内重跑一次检测：预检到写入之间可能被别的进程推进（远端新快照 / 本机配置改动），
      // 拿过期结论去写等于覆盖别人的成果。无锁环境（测试）直接用预检结果 —— 同一份数据，没有竞态。
      const phase = releaseLock === null ? preflight : await this.detectPhase(channel, cfg, nowIso, historyId);
      if (phase.kind === 'skip') return phase.result;
      const { engine, remoteNew, localDirty, firstRun } = phase;

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
          // autoApplyTier（缺省 'medium'）= 「真·自动同步所有改动」的开关：low 档只自动落
          // 低风险分区（settings/ui/providers/prompts/skills/agentPresets/agentInstructions/self），
          // medium 档连 plugins / mcp 这两个中风险分区也自动落盘；**high 档永不自动**
          // （类型上限即 medium：secrets/credentialsStatus/pluginData/pluginFiles 根本不在同步面内）。
          // firstSync 恒 false：真正的首次同步没有祖先基线，merge 已把两侧差异判成 conflict → 走人工确认。
          const apply = classifyMergePlan(mergePlan, {
            firstSync: false,
            maxAutoTier: cfg.autoApplyTier ?? DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
          });
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
          /**
           * 冲突策略（conflictPolicy，缺省 'ask'）：
           * - 'ask'：不强制，推送会被引擎的「远端已推进」前置检测挡下 → skipped/partial(conflict)；
           * - 'local'：用户显式选中才生效 —— **不写本地**（下行被冲突挡下），但把本机版本强制推成
           *   新的远端最新。force 只跳过「基线是否落后」这一道检查，仍走正常快照上传与基线记录；
           *   被覆盖的远端旧版本留在远端历史快照里，可手动回滚。
           *
           * SYN-05：首轮 / 远端有新快照时即使显式选了 local 也强制降级 ask（forced=true 进结果与
           * 历史），绝不在这两个高危时刻替用户覆盖远端最新。
           */
          const pushDecision = resolveConflictPushPolicy({
            ...(cfg.conflictPolicy !== undefined ? { configuredPolicy: cfg.conflictPolicy } : {}),
            firstRun,
            remoteNew,
            conflicted: conflictedSections.length,
          });
          const forcePush = pushDecision.force;
          const forcedMark = pushDecision.forcedAsk ? { forced: true as const } : {};
          // Phase C: 完整双向 → engine.push() 上传。P0-A：外部 push 包 intent journal。
          const rawPush = async () => engine.push(forcePush ? { force: true } : {});
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
              ...forcedMark,
            };
            await this.appendHistory(channel, {
              direction: appliedSections.length ? 'both' : 'push', status: conflictResult.status,
              skipReason: 'conflict', error: message,
              appliedSections,
              ...(conflictedSections.length > 0 ? { conflictedSections } : {}),
              createdAt: nowIso, failureCountAtRun: 0,
              ...forcedMark,
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
          // conflictPolicy='local' 时冲突已被「本机覆盖远端」消解，但远端那一版确实被盖掉了 →
          // 同样记 partial，skipReason 换成 conflict-kept-local（界面据此说清「本机已覆盖远端」）。
          const keptLocal = forcePush && conflictedSections.length > 0;
          const partial = conflictedSections.length > 0;
          const skipReason = keptLocal
            ? ('conflict-kept-local' as const)
            : partial
              ? ('conflict' as const)
              : undefined;
          const reportedConflicted = keptLocal
            ? conflictedSections
            : partial
              ? conflictedSections
              : deferredSections;
          // 0.4.1：推送前收养了「本机自己推上去的」远端快照（上次推送在写基线前被打断）→
          // 如实记一条 skipReason，让历史与首页能说清「这次推上去之前先修好了基线」，
          // 而不是让用户以为又发生了一次莫名冲突。冲突原因优先（真有冲突时更该被看见）。
          const adoptedReason = pushReport.adoptedBase !== undefined ? ('baseline-adopted' as const) : undefined;
          const result: AutosyncRunResult = {
            status: partial ? 'partial' : 'success',
            direction: appliedSections.length ? 'both' : 'push',
            appliedSections, pushedSnapshotId: pushReport.snapshotId, historyId,
            ...(skipReason !== undefined || adoptedReason !== undefined ? { skipReason: skipReason ?? adoptedReason } : {}),
            ...(reportedConflicted.length > 0 ? { conflictedSections: reportedConflicted } : {}),
            consecutiveFailures: 0,
            ...forcedMark,
          };
          await this.appendHistory(channel, {
            direction: appliedSections.length ? 'both' : 'push',
            status: partial ? 'partial' : 'success',
            appliedSections, pushedSnapshotId: pushReport.snapshotId,
            ...(skipReason !== undefined || adoptedReason !== undefined ? { skipReason: skipReason ?? adoptedReason } : {}),
            ...(reportedConflicted.length > 0 ? { conflictedSections: reportedConflicted } : {}),
            createdAt: nowIso, failureCountAtRun: 0,
            ...forcedMark,
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
      this.watcher?.resume();
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
  /**
   * Phase 1：只读预检 —— 读该通道配置、列远端快照、判断「远端有新 / 本地有改动」。
   *
   * 为什么不持锁：这些步骤全是只读，但 plugins 分区的导出会为本机源（link: / file:）插件跑 npm pack
   * （真机实测 210MB 插件 44.7s/次、每轮重算）。放进 GLOBAL mutation 锁内，60s 一轮的轮询就让锁几乎
   * 全程被占，用户任何 destructive 操作都撞 423（2026-11-07 真机事故的根因）。
   * 结论**不具权威性**：调用方取到锁之后必须重跑一次（见 runOnceInternal 的 Phase 2）。
   */
  private async detectPhase(
    channel: SyncTransportType,
    cfg: AutosyncConfig,
    nowIso: string,
    historyId: string,
  ): Promise<AutosyncDetectOutcome> {
    // 读该通道 sync-config：按通道判定「已配置」——git 看 git.repoUrl、webdav 看 webdav.url。
    // SEC-03：「未配置」有两种成因 —— 真的没配，或存过的地址被白名单拒掉（读侧丢弃）。
    // 必须区分：后者如果说成前者的「尚未配置」，用户会一遍遍重填同一个被拒地址。
    const configIssues: SyncConfigIssue[] = [];
    const syncCfg = await this.readSyncConfigFn(channel, configIssues);
    if (!syncIsConfigured(syncCfg)) {
      const configIssue = describeConfigIssue(configIssues, channel);
      if (configIssue !== undefined) this.reportConfigIssue(channel, configIssue);
      const result: AutosyncRunResult = {
        status: 'skipped', direction: 'none', skipReason: 'unconfigured', historyId,
        consecutiveFailures: 0,
        ...(configIssue === undefined ? {} : { configIssue }),
      };
      await this.appendHistory(channel, {
        direction: 'both',
        status: 'skipped',
        skipReason: 'unconfigured',
        createdAt: nowIso,
        failureCountAtRun: 0,
        ...(configIssue === undefined ? {} : { configIssue }),
      });
      await this.writeFinalConfig(cfg, result, nowIso, historyId, channel);
      return { kind: 'skip', result };
    }

    const engine = this.makeSyncEngine(syncCfg!);

    // 加密快照检测：远端最新快照为加密 → 自动同步无密码无法解密 → 整体跳过，
    // 同步历史记录 skipReason='encrypted'（提示需手动输入密码同步）。
    // 加密快照只通过手动推送/拉取产生与消费；自动同步仅处理普通快照。
    // list 失败宽容处理：视为无加密快照，继续正常流程（网络问题由后续链路暴露为 failed）。
    let encryptedRemote = false;
    // 本轮远端列表：加密快照检查与「远端是否有新快照」共用同一次 list。
    // 每次 list 都是一次真实网络往返（git = `pull --ff-only`，webdav = PROPFIND/GET），
    // 缺省 60s 轮询下多 list 一次 = 一天白跑 1440 次往返。
    let remoteMetas: readonly SyncSnapshotMeta[] | null = null;
    try {
      const metas = await engine.listSnapshots();
      remoteMetas = metas;
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
      return { kind: 'skip', result };
    }

    // 事件驱动触发（§3.1/§3.2/§3.3 看变化不看时间）：
    // - remoteNew：远端是否出现比本地祖先更新的快照 → 决定是否做下载合并（Phase A）；
    // - localDirty：本地 portable 配置相对基线是否真的变了 → 决定是否上传（Phase C）。
    // 定时器只是兜底轮询；真正驱动是这两个「变化」信号。
    // 列表拿不到（网络失败）时 remoteMetas 为 null → 检测自己再 list 一次，行为与改造前一致
    const remoteNew = await this.detectRemoteNew(engine, remoteMetas ?? undefined);
    const localDirty = await this.detectLocalChange(engine);
    // SYN-05：首轮（从未跑过）与「远端有新快照」是覆盖风险最高的两个时刻 —— 由
    // resolveConflictPushPolicy 统一把这两处的 ask 标成 forced。
    const firstRun = cfg.lastRunAt === undefined || cfg.lastRunAt === '';

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
      return { kind: 'skip', result };
    }
    return { kind: 'work', engine, remoteNew, localDirty, firstRun };
  }

  private async writeFinalConfig(
    base: AutosyncConfig,
    result: AutosyncRunResult,
    nowIso: string,
    historyId: string,
    channel: SyncTransportType,
  ): Promise<void> {
    const skipReason = result.status === 'failed' ? undefined : result.skipReason;
    const countsConflicts = skipReason === 'conflict' || skipReason === 'conflict-kept-local';
    const skipCount = !countsConflicts || result.conflictedSections === undefined
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

  /**
   * 连续失败 ≥ 3 → 通知（host.log.warn）。
   *
   * issue #105：通知的持久痕迹只留历史 entry 的 notifiedAt。
   * 此前这里把通知文案写进 autosync-config.lastRunMessage —— 那是「本轮错误原文」的字段，
   * 一个字段两种语义，界面就无法判断该显示什么；而且 entry.notifiedAt 只在内存对象上改、
   * 从未落盘（sync-history 当时只有 append），通知事实其实没留下。现在两者都走一处：
   * 通知文案只进日志，notifiedAt 落盘到历史记录。
   */
  private maybeNotify(failures: number, historyId: string, nowIso: string, channel: SyncTransportType): void {
    if (failures < 3) return;
    this.host.log.warn(`自动同步连续失败 ${failures} 次，请检查仓库配置/凭据（${channel}）`);
    // readHistory 走注入的 readHistoryFn（测试可替换），写入仍是原子落盘
    void markAutosyncNotified(this.syncDir, nowIso, nowIso, { readHistory: this.readHistoryFn })
      .catch(() => { /* 尽力而为 */ });
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
 * SEC-03：从读侧收集到的 issue 里挑出本通道的成因（`code(channel): message`），
 * 没有就返回 undefined —— 「真的没配」绝不伪造原因（无幻影告警）。
 * 多通道并存时只取本通道，git 的拒因不该挂在 webdav 的历史里。
 */
export function describeConfigIssue(
  issues: readonly SyncConfigIssue[],
  channel: SyncTransportType,
): string | undefined {
  const own = issues.filter((issue) => issue.channel === channel);
  if (own.length === 0) return undefined;
  return own.map((issue) => `${issue.code} (${issue.channel}): ${issue.message}`).join('; ');
}

/**
 * 缺省远端新快照检测（§3.2）：engine 实现了 hasNewRemoteSnapshot() → 调用；
 * 否则（测试 mock 未实现）保守返回 true（假设有新生，保持旧行为=每次都尝试拉取）。
 * `listed` 透传给引擎：本轮已 list 过就直接复用，不再多跑一次网络往返。
 */
async function defaultDetectRemoteNew(engine: SyncEngine, listed?: readonly SyncSnapshotMeta[]): Promise<boolean> {
  const fn = (engine as unknown as { hasNewRemoteSnapshot?: (listed?: readonly SyncSnapshotMeta[]) => Promise<boolean> }).hasNewRemoteSnapshot;
  if (typeof fn === 'function') {
    try {
      return await fn.call(engine, listed);
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
/**
 * 缺省 watcher 工厂 = 真实 fs.watch（SyncWatcher）。
 * targets 由 watch-scope 的静态清单派生（纯函数、不读磁盘），profile 只影响 profiles/ 下的路径。
 */
function defaultMakeWatcher(opts: WatcherFactoryOptions): SyncWatcher {
  return new SyncWatcher({
    homeDir: opts.homeDir,
    targets: buildWatchTargets({ homeDir: opts.homeDir, profile: opts.profile }),
    log: opts.log,
    onFlush: opts.onFlush,
  });
}

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
