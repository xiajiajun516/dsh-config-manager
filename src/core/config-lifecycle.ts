/**
 * 配置生命周期编排（Phase 1 P0-1 + P0-2 的可用能力层）。
 *
 * 把地基三件套组装成宿主可用的能力：
 *  - `config-state`   采集分区指纹 → 判断「有没有变、变了哪些分区」
 *  - `config-snapshot` 持久化与回放
 *  - `watcher`        防抖监听 + 回声抑制
 *
 * 提供：自动快照（watch → 防抖 → 回声判定 → 落盘 → 保留清理）、
 * 撤销/重做（按内容差异选目标，撤销前落 pre-restore 供重做）、状态查询。
 *
 * 全部 IO 依赖注入（adapters / ctx / 目录 / watch 工厂），因此可在测试中
 * 用内存门面 + 假定时器完整驱动，不需要真文件系统与 sleep。
 *
 * 回声抑制的两条防线（缺一不可，竞品的真实事故）：
 *  1. 写操作窗口：`watcher.beginSuppress/endSuppress` 直接丢弃事件；
 *  2. 窗口之后：`EchoRegistry` 按内容指纹识别「延迟投递的恢复自写事件」。
 * 二者都在本类内统一管理，调用方无需关心。
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs'
import path from 'node:path';
import { sha256Hex } from '../utils/hashing.ts';
import { normalizePath } from '../utils/paths.ts';
import { stateFromExports, statesEqual, type ConfigState } from './config-state.ts';
import {
  listConfigSnapshots, pruneConfigSnapshots, readConfigSnapshotMeta, restoreConfigSnapshot, saveConfigSnapshot,
  toUndoCandidate,
  type ConfigSnapshotMeta, type ConfigSnapshotRestoreReport,
} from './config-snapshot.ts';
import { canRedo, canUndo, planRedo, planUndo, steppedIds, type ConfigSnapshotKind } from './undo.ts';
import { DebouncedWatcher, EchoRegistry, type TimerApi, type WatchFactory, type WatcherEvent } from './watcher.ts';
import { updateConfigSnapshotMeta } from './config-snapshot.ts';
import type { ConfigAdapter, ExportSection, HostContext } from './types.ts';
import type { SectionId } from '../schema/types.ts';

/** 启动关键配置文件（相对 homeDir）——自动快照最需要覆盖的那一批 */
export const BOOT_CRITICAL_RELS: readonly string[] = [
  'settings.yaml',
  'settings.json',
  'cordis.patch.yml',
  '.env',
  'AGENTS.md',
];

/** profile 下启动关键配置文件（相对 homeDir） */
export function profileCriticalRels(profile: string): string[] {
  return [
    `profiles/${profile}/cordis.patch.yml`,
    `profiles/${profile}/package.json`,
    `profiles/${profile}/cordis.yml`,
    `profiles/${profile}/pnpm-workspace.yaml`,
  ];
}

/** 需要监听变更的目录（绝对路径；去重） */
export function watchDirsFor(homeDir: string, profile: string): string[] {
  const dirs = [
    homeDir,
    path.join(homeDir, 'profiles', profile),
    path.join(homeDir, 'skills'),
    path.join(homeDir, '.agent-presets'),
  ];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

/** 回声候选文件（绝对路径）：我们恢复时会写的配置面文件 */
export function echoCandidatePaths(homeDir: string, profile: string): string[] {
  return [...BOOT_CRITICAL_RELS, ...profileCriticalRels(profile)]
    .map((rel) => path.resolve(homeDir, rel));
}

export interface ConfigLifecycleOptions {
  /** 配置快照根目录（建议 <dataDir>/config-snapshots） */
  dir: string;
  adapters: readonly ConfigAdapter[];
  ctx: HostContext;
  /** profile 名（决定监听目录与 profile 文件集） */
  profile: string;
  /** 分区应用顺序（回放用；建议传与导入管线一致的顺序） */
  applyOrder?: readonly SectionId[];
  /** 自动快照开关（缺省 true） */
  autoEnabled?: boolean;
  /** 防抖窗口（缺省 1500ms） */
  debounceMs?: number;
  /** 保留份数（缺省 auto 20 / pre-restore 10 / manual 不限） */
  keepAuto?: number;
  keepPreRestore?: number;
  /** watch 工厂（缺省由宿主注入真 fs.watch；未注入则自动快照不启动） */
  watchFactory?: WatchFactory;
  /** 定时器注入（透传给 DebouncedWatcher；测试用假定时器即可完整驱动时序） */
  timers?: TimerApi;
  /** 采集时单分区失败回调（不阻断） */
  onSectionError?: (section: SectionId, error: unknown) => void;
  /** 自动快照落盘后的回调（宿主写审计史） */
  onAutoSnapshot?: (meta: ConfigSnapshotMeta) => void;
  /** 诊断日志（默认静默） */
  onWarn?: (message: string, detail?: unknown) => void;
}

export interface LifecycleStatus {
  canUndo: boolean;
  canRedo: boolean;
  total: number;
  /** 最近一次自动快照时间（null = 从未） */
  lastAutoAt: string | null;
  /** 当前是否正在监听文件变更 */
  watching: boolean;
}

export interface UndoOutcome {
  ok: boolean;
  /** 命中目标快照 id（成功时） */
  targetId?: string;
  /** 撤销前落下的「撤销前状态」快照 id（重做的依据） */
  preSnapshotId?: string;
  /** 失败原因（未命中/回放失败） */
  reason?: string;
  report?: ConfigSnapshotRestoreReport;
  /** 被标记为「已跨过」的快照 id */
  stepped?: string[];
}

export interface RedoOutcome {
  ok: boolean;
  targetId?: string;
  reason?: string;
  report?: ConfigSnapshotRestoreReport;
  /** 重做后清除 stepped 标记的快照 id */
  unstepped?: string[];
}

export interface SnapshotRequest {
  kind: ConfigSnapshotKind;
  reason: string;
  trigger?: string;
  note?: string;
  tags?: string[];
  /** 只采集这些分区（缺省全部） */
  only?: readonly SectionId[];
}

/** 一次采集的完整产物：分区导出结果 + 由其派生的分区指纹 + 导出失败的分区。 */
interface CapturedConfig {
  sections: Map<SectionId, ExportSection>;
  state: ConfigState;
  /** 导出失败而被跳过的分区（非空 = 本次状态不可信，见 undo 的 capture-incomplete） */
  failed: SectionId[];
}

/**
 * 配置生命周期服务（宿主单例）。
 * 所有公开方法都不抛：错误转为 `ok:false + reason`，避免拖垮宿主路由。
 */
export class ConfigLifecycle {
  private readonly opts: ConfigLifecycleOptions;
  private readonly echo = new EchoRegistry();
  private watcher: DebouncedWatcher | null = null;
  private flushRunning = false;
  private disposed = false;
  /**
   * flush 进行中到达的事件批（见 onAutoFlush）。
   * watcher 在回调前已把事件批从 pending 摘除，若直接丢弃就再也没有定时器补发，
   * 那一次变更将永远不会被快照 —— 撤销会直接跳过它。
   */
  private deferred: WatcherEvent[] = [];
  /**
   * 最近一次回放（撤销/重做）把配置写成的目标状态。
   * 第二层回声防线的兜底：抑制窗口只能挡住**窗口内**的事件，窗口之后才投递的事件
   * （macOS / 网络盘 / 杀毒扫描后重写）只能靠内容判定 —— 若此刻采集到的状态仍等于
   * 刚写回的目标状态，那批事件就是恢复自写的回声，不得产生新快照（否则它比
   * pre-restore 更新，会把重做通道堵死）。真实变更一旦落盘即清空。
   */
  private lastReplayState: ConfigState | null = null;
  /** 当前实际建立监听的目录（供 reconcileWatchSet 比对，避免无谓重建） */
  private watchedDirs: string[] = [];

  constructor(options: ConfigLifecycleOptions) {
    this.opts = options;
  }

  private warn(message: string, detail?: unknown): void {
    this.opts.onWarn?.(message, detail);
  }

  get dir(): string {
    return this.opts.dir;
  }

  get isWatching(): boolean {
    return this.watcher?.isRunning === true;
  }

  /* ---------------------------------------------------------- 采集与快照 */

  /**
   * 采集各分区导出结果 + 分区指纹：**单次遍历**，不重复 export。
   * 单分区失败 → 记入 failed 并跳过（不抛），使调用方能判断这次状态是否可信。
   */
  private async captureSections(only?: readonly SectionId[]): Promise<CapturedConfig> {
    const sections = new Map<SectionId, ExportSection>();
    const failed: SectionId[] = [];
    for (const adapter of this.opts.adapters) {
      if (only !== undefined && !only.includes(adapter.id)) continue;
      try {
        sections.set(adapter.id, await adapter.export(this.opts.ctx, { includeSecrets: false, only: [adapter.id] }));
      } catch (error) {
        failed.push(adapter.id);
        this.opts.onSectionError?.(adapter.id, error);
        this.warn(`采集分区失败，已跳过: ${adapter.id}`, error);
      }
    }
    return { sections, state: stateFromExports(sections), failed };
  }

  /** 采集当前配置状态（单分区失败跳过，不抛） */
  async capture(only?: readonly SectionId[]): Promise<ConfigState> {
    return (await this.captureSections(only)).state;
  }

  /** 采集并落盘一个配置快照 */
  async snapshot(req: SnapshotRequest): Promise<ConfigSnapshotMeta> {
    return this.saveSnapshot(req, await this.captureSections(req.only));
  }

  /**
   * 用一个**已采集**的产物落盘快照。
   * 为什么必须支持传入已采集结果：撤销的 pre-restore 快照必须与「据以挑选目标的
   * 那次采集」是同一份观测 —— 否则二次采集之间用户又改了配置，pre-restore 记下的
   * 就不是「撤销前状态」，重做会把用户没见过的内容写回去。
   */
  private async saveSnapshot(req: SnapshotRequest, captured: CapturedConfig): Promise<ConfigSnapshotMeta> {
    const meta = await saveConfigSnapshot({
      dir: this.opts.dir,
      kind: req.kind,
      reason: req.reason,
      sections: captured.sections,
      state: captured.state,
      ...(req.trigger !== undefined ? { trigger: req.trigger } : {}),
      ...(req.note !== undefined ? { note: req.note } : {}),
      ...(req.tags !== undefined ? { tags: req.tags } : {}),
    });
    if (req.kind !== 'manual') {
      await this.prune();
    }
    return meta;
  }

  async list(): Promise<ConfigSnapshotMeta[]> {
    return listConfigSnapshots(this.opts.dir);
  }

  async prune(): Promise<string[]> {
    return pruneConfigSnapshots(this.opts.dir, {
      ...(this.opts.keepAuto !== undefined ? { keepAuto: this.opts.keepAuto } : {}),
      ...(this.opts.keepPreRestore !== undefined ? { keepPreRestore: this.opts.keepPreRestore } : {}),
    });
  }

  /* ---------------------------------------------------------- 状态 */

  async status(): Promise<LifecycleStatus> {
    const metas = await this.list();
    const captured = await this.captureSections();
    const candidates = metas.map(toUndoCandidate);
    // 采集不完整（有分区导出失败）→ 状态不可信：宁可报「不可撤销」，也不能拿一个
    // 缺分区的状态去挑目标 —— 它会与内容其实相同的快照判为「不同」，做成一次假成功的空操作。
    const trustworthy = captured.failed.length === 0;
    const lastAuto = metas.find((m) => m.kind === 'auto' || m.kind === 'baseline');
    return {
      canUndo: trustworthy && canUndo(captured.state, candidates),
      canRedo: canRedo(candidates),
      total: metas.length,
      lastAutoAt: lastAuto?.createdAt ?? null,
      watching: this.isWatching,
    };
  }

  /* ---------------------------------------------------------- 撤销 / 重做 */

  /**
   * 撤销：回退到与当前状态**内容不同**的最新快照。
   * 撤销前先落 `pre-restore` 快照记录当前状态，使重做可逆。
   */
  async undo(): Promise<UndoOutcome> {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    let captured: CapturedConfig;
    let metas: ConfigSnapshotMeta[];
    try {
      captured = await this.captureSections();
      metas = await this.list();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    // 采集不完整时状态不可信：拒绝执行，而不是做一次「回放内容其实相同」的假成功空操作。
    if (captured.failed.length > 0) {
      return { ok: false, reason: `capture-incomplete:${captured.failed.join(',')}` };
    }
    const current = captured.state;
    const plan = planUndo(current, metas.map(toUndoCandidate));
    if (plan.kind === 'none') return { ok: false, reason: plan.reason };

    let pre: ConfigSnapshotMeta;
    try {
      // 复用上面那次采集：pre-restore 记录的必须正是「据以挑选目标的那个状态」，
      // 二次采集会让两者之间用户的新改动溜进 pre-restore（重做时写回没见过的内容）。
      pre = await this.saveSnapshot(
        { kind: 'pre-restore', reason: `before-undo:${plan.targetId}`, trigger: 'undo' },
        captured,
      );
      await updateConfigSnapshotMeta(this.opts.dir, pre.id, { undoOf: plan.targetId });
    } catch (error) {
      return { ok: false, reason: `撤销前快照失败: ${error instanceof Error ? error.message : String(error)}` };
    }

    const report = await this.replay(plan.targetId);
    // 标记被跨过的快照（重做回来时要清掉）
    const stepped = steppedIds(metas.map(toUndoCandidate), plan.targetId, current);
    for (const id of stepped) {
      try {
        await updateConfigSnapshotMeta(this.opts.dir, id, { stepped: true });
      } catch (error) {
        this.warn(`标记 stepped 失败: ${id}`, error);
      }
    }
    return {
      ok: report.ok,
      targetId: plan.targetId,
      preSnapshotId: pre.id,
      report,
      stepped,
      ...(report.ok ? {} : { reason: '回放失败，详见 report.failed' }),
    };
  }

  /** 重做：回到最近一次未消费的 pre-restore（其后若有新快照则拒绝）。 */
  async redo(): Promise<RedoOutcome> {
    if (this.disposed) return { ok: false, reason: 'disposed' };
    let metas: ConfigSnapshotMeta[];
    try {
      metas = await this.list();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const plan = planRedo(metas.map(toUndoCandidate));
    if (plan.kind === 'none') return { ok: false, reason: plan.reason };

    const report = await this.replay(plan.targetId);
    // 只有回放真的成功才消费 pre-restore。失败时若照样标记 consumed，planRedo 立刻
    // 变成 no-pre-restore，用户就再没有回到「撤销前状态」的通道了 —— 而配置此刻正停在
    // 半应用的中间态（这正是最需要重做/回退的时候）。
    if (report.ok) {
      try {
        await updateConfigSnapshotMeta(this.opts.dir, plan.targetId, { consumed: true });
      } catch (error) {
        this.warn(`标记 consumed 失败: ${plan.targetId}`, error);
      }
    }
    // 重做后：内容已回到撤销前状态的那些「被跨过」快照，清除标记
    const unstepped: string[] = [];
    try {
      const restored = await this.capture();
      for (const meta of metas) {
        if (meta.stepped !== true) continue;
        if (statesEqual(meta.state, restored)) {
          await updateConfigSnapshotMeta(this.opts.dir, meta.id, { stepped: false });
          unstepped.push(meta.id);
        }
      }
    } catch (error) {
      this.warn('重做后清理 stepped 标记失败', error);
    }
    return {
      ok: report.ok,
      targetId: plan.targetId,
      report,
      unstepped,
      ...(report.ok ? {} : { reason: '回放失败，详见 report.failed' }),
    };
  }

  /**
   * 回放指定快照（撤销/重做共用）。
   * 全程在监听抑制窗口内，并在结束后登记回声指纹——两道防线都在这里落地。
   */
  async replay(id: string): Promise<ConfigSnapshotRestoreReport> {
    // 先取目标快照的状态：回放后用它做「延迟回声」的内容判定（见 lastReplayState）。
    const targetMeta = await readConfigSnapshotMeta(this.opts.dir, id);
    const run = async (): Promise<ConfigSnapshotRestoreReport> => restoreConfigSnapshot({
      dir: this.opts.dir,
      id,
      adapters: this.opts.adapters,
      ctx: this.opts.ctx,
      ...(this.opts.applyOrder !== undefined ? { applyOrder: this.opts.applyOrder } : {}),
    });
    const report = this.watcher !== null
      ? await this.watcher.suppressWhileAsync(run)
      : await run();
    this.lastReplayState = targetMeta?.state ?? null;
    await this.recordEcho();
    return report;
  }

  /* ---------------------------------------------------------- 回声抑制 */

  /**
   * 登记「刚写回的内容指纹」：恢复动作写完文件后调用。
   * 只登记我们确实会写的配置面文件（存在才登记），避免把无关文件误判为回声而漏拍。
   */
  async recordEcho(): Promise<void> {
    this.echo.clear();
    for (const abs of echoCandidatePaths(this.opts.ctx.homeDir, this.opts.profile)) {
      try {
        const data = await fs.readFile(abs);
        this.echo.record(normalizePath(abs), sha256Hex(data));
      } catch {
        // 文件不存在（恢复时被删除）→ 不登记；后续出现即视为真实变更
      }
    }
  }

  /**
   * 事件批是否为「恢复自写的回声」。
   * 判定：批内每个文件都必须已登记**且**内容仍等于登记值；任一文件内容变了、
   * 未登记、或读不到（新增/删除）→ 真实变更。
   */
  async isEchoBatch(events: readonly WatcherEvent[]): Promise<boolean> {
    if (this.echo.size === 0 || events.length === 0) return false;
    let checked = false;
    for (const event of events) {
      const abs = normalizePath(path.resolve(event.dir, event.filename));
      if (!this.echo.has(abs)) return false;
      let data: Uint8Array;
      try {
        data = await fs.readFile(abs);
      } catch {
        return false; // 读不到 = 新增或删除 → 真实变更
      }
      if (!this.echo.isEcho(abs, sha256Hex(data))) return false;
      checked = true;
    }
    return checked;
  }

  /* ---------------------------------------------------------- 自动快照 */

  /** 启动自动快照监听（幂等；未注入 watchFactory 或已关闭则空操作） */
  startAutoSnapshot(): void {
    if (this.disposed) return;
    if (this.opts.autoEnabled === false) return;
    if (this.opts.watchFactory === undefined) return;
    this.stopAutoSnapshot();
    // 只监听**已存在**的目录：skills / .agent-presets 等在 DSH 首次启动时常常不存在，
    // 直接 watch 会为每个缺失目录刷一条告警（真实 QA 启动实测 2 条），既吵又无意义。
    // 自动快照的主战场是 settings.yaml / cordis.patch.yml / profile 目录 —— 它们在任何
    // 可用安装里都存在；仅在运行期才出现的目录由 reconcileWatchSet() 在下次快照后接管。
    const dirs = watchDirsFor(this.opts.ctx.homeDir, this.opts.profile).filter((d) => existsSync(d))
    if (dirs.length === 0) {
      this.warn('没有可监听的目录，自动快照未启动')
      return
    }
    this.watcher = new DebouncedWatcher({
      dirs,
      debounceMs: this.opts.debounceMs ?? 1500,
      watchFactory: this.opts.watchFactory,
      onFlush: (events) => { void this.onAutoFlush(events); },
      onError: (dir, error) => this.warn(`监听失败: ${dir}`, error),
      ...(this.opts.timers !== undefined ? { timers: this.opts.timers } : {}),
    });
    this.watchedDirs = [...dirs];
    this.watcher.start();
  }

  /**
   * 监听集自愈：启动之后才出现的目录（skills / .agent-presets 在全新安装里通常不存在）
   * 在**下一次快照之后**自动纳入监听。
   *
   * 为什么需要它：startAutoSnapshot 每次进程只被调用一次（启动闸门），若只在那里过滤
   * 一次，那两个目录在整个进程生命周期里都不会被监听 —— 与注释里的承诺不符（「注释承诺 >
   * 实际防线」正是本仓库踩过的坑）。放在 flush 之后调用，既不打断进行中的采集，也不会
   * 丢掉排队中的事件批。
   */
  private reconcileWatchSet(): void {
    if (this.disposed || this.watcher === null) return;
    const desired = watchDirsFor(this.opts.ctx.homeDir, this.opts.profile).filter((d) => existsSync(d));
    const current = this.watchedDirs;
    if (desired.length === current.length && desired.every((d, i) => d === current[i])) return;
    this.startAutoSnapshot(); // 内含 stop + 重建，幂等
  }

  stopAutoSnapshot(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.watchedDirs = [];
    // 停监听即作废排队中的事件批：它们对应的变更已经错过防抖窗口，
    // 且 dispose 之后不应再产生快照。
    this.deferred = [];
  }

  /** 释放：停止监听（宿主 dispose 调用） */
  dispose(): void {
    this.disposed = true;
    this.stopAutoSnapshot();
  }

  /** 供宿主在路由层复用的抑制包装（例如 Profile 切换时） */
  async suppressWhileAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (this.watcher === null) return fn();
    return this.watcher.suppressWhileAsync(fn);
  }

  /**
   * 防抖到期后的自动快照。
   *
   * 并发保护是「排队」而不是「丢弃」：watcher 在回调前已经把事件批从 pending 摘除，
   * 若这里直接 return，那批事件就再也没有定时器补发 —— 那次变更永远不会被快照，
   * 撤销会直接跳过它（实测：连写 v2、v3 只落了 1 份快照，且 undo 无从回到 v2）。
   */
  private async onAutoFlush(events: WatcherEvent[]): Promise<void> {
    if (this.disposed) return;
    if (this.flushRunning) {
      this.deferred.push(...events);
      return;
    }
    this.flushRunning = true;
    try {
      let batch = events;
      for (;;) {
        await this.flushOnce(batch);
        batch = this.deferred.splice(0);
        if (batch.length === 0) break;
      }
    } catch (error) {
      this.warn('自动快照失败', error);
    } finally {
      this.flushRunning = false;
      // 异常路径上仍积压的事件不得滞留（否则那次变更同样永远不会被快照）
      if (this.deferred.length > 0 && !this.disposed) {
        const rest = this.deferred.splice(0);
        void this.onAutoFlush(rest);
        return;
      }
      // 队列已排空 → 顺带让新增目录（skills / .agent-presets）进入监听集
      this.reconcileWatchSet();
    }
  }

  /** 处理一批事件：回声判定 → 采集 → 落盘。 */
  private async flushOnce(events: WatcherEvent[]): Promise<void> {
    if (await this.isEchoBatch(events)) return; // 恢复自写的回声 → 不产生快照
    const captured = await this.captureSections();
    // 第二层回声兜底（见 lastReplayState）：恢复动作刚把配置写成 X，此刻采集到的仍是 X
    // → 这批事件是窗口之后才投递的恢复自写回声，不得产生快照（否则挡住重做）。
    if (this.lastReplayState !== null && statesEqual(captured.state, this.lastReplayState)) return;
    // 第三层兜底：与最新快照内容完全相同 → 这份快照不携带任何新信息。
    // 覆盖面比前两层广：**任何**恢复通道（导入、备份恢复、Profile 切换、同步应用）写完
    // 配置都会触发事件，而它们不会经过 replay()，因此拿不到 lastReplayState。
    // 若不跳过，恢复完立刻多出一份「等于刚恢复内容」的快照，它会比 pre-restore 更新，
    // 把重做通道永久堵死（正是竞品记录过的那起事故）。
    const newest = (await this.list()).find((m) => m.kind !== 'pre-restore');
    if (newest !== undefined && statesEqual(newest.state, captured.state)) {
      this.echo.clear();
      this.lastReplayState = captured.state;
      return;
    }
    this.echo.clear(); // 真实变更发生 → 清空登记，避免后续合法修改被误判为回声
    this.lastReplayState = null;
    const meta = await this.saveSnapshot({ kind: 'auto', reason: 'config-change', trigger: 'watcher' }, captured);
    this.opts.onAutoSnapshot?.(meta);
  }
}
