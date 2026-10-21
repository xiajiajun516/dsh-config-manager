/**
 * m-autosync-realtime：本地文件监听器（fs.watch + 去抖 + 自写回声屏蔽）。
 *
 * 存在的理由：改造前的自动同步**只靠定时器**（最短 5 分钟），本地改完配置得等下一轮才上行，
 * 与「像 VS Code 那样改完就同步」的预期不符（issue: 自动同步不自动）。
 *
 * 设计要点：
 *  - **文件目标监听父目录**（非递归）+ 按 basename 过滤：原子写是 temp + rename，
 *    直接监听文件本身会在 rename 后失去句柄（Linux inode 变化），监听父目录才稳；
 *  - **去抖**（缺省 1500ms）：一次保存往往连写多个文件（settings.yaml + patch），
 *    合并成一次触发，绝不为每个字节排一轮同步；
 *  - **自写回声屏蔽**：调度器在 runOnce 前后 suspend()/resume()，resume 后再静默
 *    `quietAfterSuspendMs`（缺省 2000ms）——否则「同步把远端内容写回本地」自身就会触发下一轮，
 *    形成 push→apply→push 的死循环；
 *  - **静默窗口只「推迟」不「丢弃」**：窗口内到达的事件记进 pending 并排一枚窗口结束后的补跑定时器
 *    （真机实测：窗口内保存若直接丢弃，用户改完要等一整轮兜底间隔才上行 —— 与「改完就同步」不符）。
 *    自家回声由引擎的分区 hash 比对判成「无变化」，多跑一轮不产生任何传输；
 *  - **纯监听、不做判定**：这里只说「有东西变了」（附带 home 相对路径），究竟哪些分区真的变了
 *    由引擎的 `hasLocalChanges()`（分区 hash 比基线）回答 —— 监听器绝不猜。
 *
 * 可靠性取舍：监听失败（ENOENT / 平台不支持 recursive）只 `log.debug/warn`，绝不抛错 ——
 * 自动同步的兜底始终是定时器，监听掉线只是退回「等下一轮」，不能让宿主启动失败。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from '../utils/logger.ts';
import type { WatchTarget } from './watch-scope.ts';
import { isNoiseRelPath, targetAbsPath, toHomeRelPath } from './watch-scope.ts';

/** fs.watch 返回的句柄（只用到 close）。 */
export interface WatchHandle {
  close(): void;
}

/** fs.watch 的最小签名（测试注入假实现）。 */
export type WatchFactory = (
  absPath: string,
  opts: { recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => WatchHandle;

/** 缺省去抖窗口：一次「保存配置」产生的连续事件合并为一次触发。 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
/** 缺省自写回声窗口：resume 后这段时间内的事件一律忽略。 */
export const DEFAULT_WATCH_QUIET_MS = 2000;

export interface SyncWatcherOptions {
  /** `$DSH_HOME` 绝对路径 */
  homeDir: string;
  /** 监听目标（`watch-scope.buildWatchTargets` 的产物） */
  targets: readonly WatchTarget[];
  log: Logger;
  /** 去抖窗口到期：把这一批变更的 home 相对路径交给上层（已过滤噪声）。 */
  onFlush: (changed: readonly string[]) => void;
  debounceMs?: number;
  quietAfterSuspendMs?: number;
  watchFactory?: WatchFactory;
  /** 时间源 / 计时器（测试注入） */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface Attachment {
  target: WatchTarget;
  /** 实际被监听的目录绝对路径 */
  watchedDir: string;
  /** 文件目标：该目录下需要匹配的 basename；目录目标为 null */
  fileBase: string | null;
  handle: WatchHandle;
}

export class SyncWatcher {
  private readonly homeDir: string;
  private readonly log: Logger;
  private readonly onFlush: (changed: readonly string[]) => void;
  private readonly debounceMs: number;
  private readonly quietAfterSuspendMs: number;
  private readonly watchFactory: WatchFactory;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  private targets: readonly WatchTarget[];
  private attachments: Attachment[] = [];
  private pending: Set<string> = new Set();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private suspended = false;
  private quietUntil = 0;

  constructor(opts: SyncWatcherOptions) {
    this.homeDir = opts.homeDir;
    this.targets = opts.targets;
    this.log = opts.log;
    this.onFlush = opts.onFlush;
    this.debounceMs = opts.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.quietAfterSuspendMs = opts.quietAfterSuspendMs ?? DEFAULT_WATCH_QUIET_MS;
    this.watchFactory = opts.watchFactory ?? defaultWatchFactory;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  /** 是否已启动。 */
  isStarted(): boolean {
    return this.started;
  }

  /** 当前实际挂上的监听数（诊断/测试用）。 */
  attachmentCount(): number {
    return this.attachments.length;
  }

  /** 启动监听（重复调用是幂等的）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attachAll();
  }

  /** 停止监听并丢弃未触发的变更（插件卸载 / 自动同步关闭时必须调）。 */
  stop(): void {
    this.started = false;
    this.suspended = false;
    this.quietUntil = 0;
    this.clearPendingTimer();
    this.pending.clear();
    for (const a of this.attachments) {
      try {
        a.handle.close();
      } catch {
        /* 尽力而为：句柄可能已被平台回收 */
      }
    }
    this.attachments = [];
  }

  /** 换监听目标（分区选择/配置变化）；已启动则原子重启。 */
  setTargets(targets: readonly WatchTarget[]): void {
    this.targets = targets;
    if (!this.started) return;
    this.stop();
    this.started = true;
    this.attachAll();
  }

  /**
   * 进入「自写中」：屏蔽事件并丢弃已积累的变更。
   *
   * 在 runOnce 开始时调用 —— 同步自家的 apply/push 会写 settings.yaml / patch / skills，
   * 那些写入不是用户改动。
   */
  suspend(): void {
    this.suspended = true;
    this.clearPendingTimer();
    this.pending.clear();
  }

  /** 退出「自写中」：随后进入静默窗口，避免收尾写入的回声立刻触发下一轮。 */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.quietUntil = this.now() + this.quietAfterSuspendMs;
  }

  /** 立即处理当前积累的变更（测试用；正常路径靠定时器）。 */
  flushNow(): void {
    this.flush();
  }

  private attachAll(): void {
    for (const target of this.targets) this.attach(target);
  }

  private attach(target: WatchTarget): void {
    const abs = targetAbsPath(this.homeDir, target);
    const isDir = target.kind === 'dir';
    const watchedDir = isDir ? abs : path.dirname(abs);
    const fileBase = isDir ? null : path.basename(abs);
    try {
      const handle = this.watchFactory(watchedDir, { recursive: isDir ? target.recursive : false }, (event, filename) => {
        this.onRawEvent(target, watchedDir, fileBase, filename);
      });
      this.attachments.push({ target, watchedDir, fileBase, handle });
      this.log.debug(`自动同步监听已挂载：${target.relPath}`, { watchedDir });
    } catch (err) {
      // 路径不存在 / 平台不支持：不阻断启动，兜底是定时器
      this.log.debug(`自动同步监听未挂载：${target.relPath}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onRawEvent(target: WatchTarget, watchedDir: string, fileBase: string | null, filename: string | null): void {
    if (!this.started || this.suspended) return;
    // 静默窗口内到达的事件：先记账，窗口一结束就补跑一次判定（丢弃会让用户改动漏掉一整轮兜底间隔）
    const quietRemainingMs = this.quietUntil - this.now();
    let abs: string;
    if (fileBase !== null) {
      // 文件目标：只关心父目录里同名文件的事件（原子写的 temp 名字被噪声规则挡掉）
      if (filename !== null && path.basename(filename) !== fileBase) return;
      abs = path.join(watchedDir, fileBase);
    } else {
      if (filename === null) return;
      abs = path.join(watchedDir, filename);
    }
    const rel = toHomeRelPath(this.homeDir, abs);
    if (rel === null || isNoiseRelPath(rel)) return;
    void target; // sections 仅用于诊断；判定交给引擎的分区 hash
    this.pending.add(rel);
    this.scheduleFlush(quietRemainingMs > 0 ? quietRemainingMs + this.debounceMs : this.debounceMs);
  }

  private scheduleFlush(delayMs: number = this.debounceMs): void {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const quietRemainingMs = this.quietUntil - this.now();
    if (quietRemainingMs > 0) {
      // 去抖定时器提前到期：推迟到窗口结束，既不丢用户改动、也不把自家收尾写入当触发
      this.scheduleFlush(quietRemainingMs + this.debounceMs);
      return;
    }
    const changed = [...this.pending];
    this.pending.clear();
    try {
      this.onFlush(changed);
    } catch (err) {
      this.log.warn('自动同步监听回调失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private clearPendingTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

const defaultWatchFactory: WatchFactory = (absPath, opts, listener) => fs.watch(absPath, { recursive: opts.recursive }, listener);
