/**
 * BackupScheduler：宿主后台定时全量备份调度器（P0-3）。
 *
 * 与 AutoSyncScheduler（同步通道自动同步）并列的独立能力：按固定间隔把当前 DSH
 * 完整配置导出为全量备份 ZIP（复用 Exporter 引擎，走 exportsDir）。
 *
 * 生命周期：
 *  - start()：读 backup-schedule.json；enabled 时启动定时器；无条件执行一次
 *    「启动触发备份」（受 startupMinIntervalMs 阈值约束）。
 *  - stop()：清定时器、标记不再调度。
 *  - reload()：重新读配置并重排定时器（配置保存路由调用）。
 *  - runOnce()：立即执行一次全量备份（受 runs.register('backup-schedule') 防重）。
 *
 * 安全不变量（硬约束）：
 *  - 定时备份恒 includeSecrets=false 且不加密——加密密码仅内存且不能持久化，
 *    与自动同步恒不含 secret 同语义；要加密备份请走手动导出。
 *  - 出参只写非敏感摘要（文件名/大小/分区/计数），日志经 redact 兜底。
 *
 * 扩展点（供生态调度层 / 测试注入）：
 *  - 外部调度器（dsh-automation cron、任务看板）可直接调 runOnce() 触发备份，
 *    或复用 P0-1 的 config_backup 模型工具在 agent 会话内驱动。
 */
import type { Logger } from '../utils/logger.ts';
import type { MsgFunc } from '../core/messages.ts';
import type { RunRegistry } from '../core/run-registry.ts';
import type { ConfigAdapter, HostContext } from '../core/types.ts';
import { Exporter } from '../core/exporter.ts';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readBackupSchedule, writeBackupSchedule, backupIntervalToMs } from './backup-schedule-config.ts';
import type { BackupScheduleConfig, BackupRunStatus } from './backup-schedule-config.ts';
import { shouldTriggerStartupRun } from './autosync-scheduler.ts';

export interface BackupRunResult {
  status: BackupRunStatus;
  zip?: string;
  sizeBytes?: number;
  sections?: string[];
  skipReason?: string;
  error?: string;
  consecutiveFailures: number;
}

export interface BackupSchedulerOptions {
  /** 同步状态目录（$DSH_HOME/dsh-config-manager/sync；配置存 backup-schedule.json） */
  syncDir: string;
  /** 导出 ZIP 落盘目录（$DSH_HOME/dsh-config-manager/exports） */
  exportsDir: string;
  host: HostContext;
  adapters: ConfigAdapter[];
  runs: RunRegistry;
  msg: MsgFunc;
  /** 插件版本（manifest.exporter.version） */
  exporterVersion?: string;
  /** 时间源（测试注入） */
  now?: () => Date;
  /** 注入配置读写（测试可内存实现） */
  readConfig?: () => Promise<BackupScheduleConfig>;
  writeConfig?: (cfg: BackupScheduleConfig) => Promise<void>;
  /** 注入计时器（测试用；缺省 setInterval/clearInterval） */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /** 日志（缺省 host.log） */
  log?: Logger;
}

export class BackupScheduler {
  private readonly syncDir: string;
  private readonly exportsDir: string;
  private readonly host: HostContext;
  private readonly adapters: ConfigAdapter[];
  private readonly runs: RunRegistry;
  private readonly msg: MsgFunc;
  private readonly exporterVersion: string;
  private readonly now: () => Date;
  private readonly readConfig: () => Promise<BackupScheduleConfig>;
  private readonly writeConfig: (cfg: BackupScheduleConfig) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly log: Logger;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running = false;

  constructor(opts: BackupSchedulerOptions) {
    this.syncDir = opts.syncDir;
    this.exportsDir = opts.exportsDir;
    this.host = opts.host;
    this.adapters = opts.adapters;
    this.runs = opts.runs;
    this.msg = opts.msg;
    this.exporterVersion = opts.exporterVersion ?? '0.1.0';
    this.now = opts.now ?? (() => new Date());
    this.readConfig = opts.readConfig ?? (() => readBackupSchedule(this.syncDir));
    this.writeConfig = opts.writeConfig ?? ((cfg) => writeBackupSchedule(this.syncDir, cfg));
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
    this.log = opts.log ?? this.host.log;
  }

  /** 启动：读配置 → enabled 时排定时器 → 执行一次启动触发备份。 */
  start(): void {
    if (this.stopped) return;
    this.refreshTimer();
    void this.startupRun();
  }

  /** 停止：清定时器、标记不再调度；正在执行的任务允许自然结束。 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /** 重新加载配置（配置保存后调用；重排定时器）。 */
  async reload(): Promise<void> {
    if (this.stopped) return;
    this.refreshTimer();
  }

  private refreshTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    void this.readConfig().then((cfg) => {
      if (this.stopped || !cfg.enabled) return;
      const ms = backupIntervalToMs(cfg.interval);
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        if (this.stopped) return;
        void this.runOnce()
          .catch((err) => {
            this.log.error('定时备份触发失败', { error: err instanceof Error ? err.message : String(err) });
          })
          .then(() => {
            // 本轮结束（成功 / 跳过 / 失败）后重新排定下一次；refreshTimer 重读配置，
            // 期间若被关闭（enabled=false）则不再排期。
            if (!this.stopped) this.refreshTimer();
          });
      }, ms);
    }).catch(() => { /* 读配置失败静默 */ });
  }

  /** 启动触发备份（受 startupMinIntervalMs 阈值约束）。 */
  private async startupRun(): Promise<void> {
    try {
      const cfg = await this.readConfig();
      if (!cfg.enabled) return;
      if (!shouldTriggerStartupRun(cfg.lastRunAt, cfg.startupMinIntervalMs, this.now().getTime())) {
        this.log.info('定时备份启动触发跳过：距上次运行未达阈值');
        return;
      }
      await this.runOnce();
    } catch (err) {
      this.log.error('启动触发备份失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 执行一次全量备份（防重：同一时刻至多一个备份任务）。 */
  async runOnce(): Promise<BackupRunResult> {
    if (this.running) {
      return { status: 'skipped', skipReason: 'running', consecutiveFailures: 0 };
    }
    const cfg = await this.readConfig();
    if (!cfg.enabled) {
      return { status: 'skipped', skipReason: 'disabled', consecutiveFailures: cfg.consecutiveFailures };
    }

    this.running = true;
    let runId: string | null = null;
    try {
      const run = this.runs.register('backup-schedule');
      runId = run.runId;
    } catch {
      this.running = false;
      return { status: 'skipped', skipReason: 'conflict', consecutiveFailures: cfg.consecutiveFailures };
    }

    try {
      const exporter = new Exporter({
        ctx: this.host,
        adapters: this.adapters,
        encryption: null, // 定时备份恒不加密：加密密码仅内存且不能持久化
        exporterVersion: this.exporterVersion,
        msg: this.msg,
      });
      // 显式落 exportsDir（与 host 路由同构；Exporter 缺省 outPath 是相对文件名，不落目录）
      const outPath = join(this.exportsDir, `dsh-config-${dateStamp(this.now())}-${randomBytes(3).toString('hex')}.zip`);
      const { report } = await exporter.export({
        includeSecrets: false, // 恒不含 secret（与自动同步同语义）
        outPath,
      });
      const result: BackupRunResult = {
        status: 'success',
        zip: report.file.name,
        sizeBytes: report.file.sizeBytes,
        sections: report.included.map((s) => s.section),
        consecutiveFailures: 0,
      };
      await this.writeConfig({
        enabled: cfg.enabled,
        interval: cfg.interval,
        startupMinIntervalMs: cfg.startupMinIntervalMs,
        consecutiveFailures: 0,
        lastRunAt: this.now().toISOString(),
        lastRunStatus: 'success',
      });
      this.log.info('定时备份完成', {
        zip: result.zip,
        sizeBytes: result.sizeBytes,
        sections: result.sections,
      });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result: BackupRunResult = {
        status: 'failed', error, consecutiveFailures: cfg.consecutiveFailures + 1,
      };
      await this.writeConfig({
        ...cfg,
        lastRunAt: this.now().toISOString(),
        lastRunStatus: 'failed',
        consecutiveFailures: cfg.consecutiveFailures + 1,
        lastRunMessage: error,
      });
      this.log.warn(`定时备份失败（连续 ${cfg.consecutiveFailures + 1} 次）`, { error });
      return result;
    } finally {
      this.running = false;
      if (runId !== null) {
        try {
          this.runs.finish(runId, { kind: 'backup-schedule' });
        } catch {
          /* 尽力而为 */
        }
      }
    }
  }
}

/** 导出文件时间戳（YYYYMMDD-HHmmss），与 host 路由 dateStamp 同构。 */
function dateStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
