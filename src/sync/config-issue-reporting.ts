/**
 * 同步请求准备期的两个只读旁路（从宿主壳 `src/index.ts` 下沉，行为逐字保持）。
 *
 * 为什么独立成模块：
 *  1) `prepareSync` 每个同步请求都跑一次（含挂载时 snapshotsList 的自动加载），它的副作用
 *     （回填 webdav username、把「配置被拒」告警一次）需要自己的单测，而宿主壳本身不可实例化；
 *  2) 去重语义是**可见性契约**的一部分（同一 (通道/码/文案) 只报一次），写在 4400 行的
 *     assembly 文件里没人守得住。
 *
 * 这两件事共享同一个来源：读已落盘的 sync-config。读出来的产物有两种用途 —— 回填缺失字段、
 * 报告被读侧丢弃的成因，因此放在同一个模块里，但各自独立导出、独立可测。
 */
import { isWebDavConfig, readSyncConfig } from './sync-config.ts';
import type { SyncConfig, SyncConfigIssue } from './sync-config.ts';

/**
 * 造一个「配置被拒」报告器：返回的函数幂等 —— 同一 (通道/码/文案) 只输出一行。
 *
 * 去重理由：调用方每次同步请求都跑一遍，按请求打日志会被零信息量的重复行刷满；而
 * 「地址被拒」是**持久状态**，报一次即可。键里带 message 而不只带 code：不同被拒地址的
 * 成因文案不同，那是新的有用信息，用户改了配置再被拒应当再报一次。
 *
 * `log` 由调用方注入（宿主传 `host.log.warn`），本模块不碰日志设施与 i18n 字典。
 */
export function createSyncConfigIssueReporter(
  log: (line: string) => void,
): (issues: readonly SyncConfigIssue[]) => void {
  const reported = new Set<string>();
  return (issues) => {
    for (const issue of issues) {
      const key = issue.channel + '/' + issue.code + '/' + issue.message;
      if (reported.has(key)) continue;
      reported.add(key);
      log('sync config rejected (' + issue.channel + '/' + issue.code + '): ' + issue.message);
    }
  };
}

/** `createPrepareSync` 的依赖（全部注入，便于单测与避免与 index.ts 形成循环依赖）。 */
export interface PrepareSyncOptions {
  /** 同步配置目录（`sync-config.json` 所在处）。 */
  syncDir: string;
  /** 解析请求体（宿主传入带 credentials 的 closure）。 */
  parseBody: (body: Record<string, unknown>) => Promise<SyncConfig>;
  /** 把已保存的 webdav username 回填进请求体（宿主传入 `mergePersistedWebDavUsername`）。 */
  mergeWebDavUsername: (cfg: SyncConfig, persisted: SyncConfig | null) => SyncConfig;
  /** 告警出口（宿主传 `(line) => host.log.warn(line)`）。 */
  log: (line: string) => void;
}

/**
 * 造 `prepareSync`：解析请求体，webdav 请求体未带 username 时从持久化配置回填 ——
 * 否则 WebDavTransport 构造会因空 username 抛错，导致「保存过配置仍无法列出快照」。
 * 语义与 password 一致：留空 = 沿用已保存凭据。
 *
 * SEC-03：顺带把「已落盘但过不了白名单、被读取侧丢弃」的 repoUrl 成因报一次；界面侧的
 * 权威出口是 GET /sync/status 的 `configIssues`（字段恒在、按请求实时算），这里只补日志。
 * 读配置失败时保持原值（空 username 由 WebDavTransport 构造校验兜底报错）。
 */
export function createPrepareSync(opts: PrepareSyncOptions): (body: Record<string, unknown>) => Promise<SyncConfig> {
  const reportIssues = createSyncConfigIssueReporter(opts.log);
  return async (body) => {
    const cfg = await opts.parseBody(body);
    if (!isWebDavConfig(cfg)) return cfg;
    if (cfg.webdav.username !== undefined && cfg.webdav.username !== '') return cfg;
    try {
      const issues: SyncConfigIssue[] = [];
      const persisted = await readSyncConfig(opts.syncDir, issues);
      reportIssues(issues);
      return opts.mergeWebDavUsername(cfg, persisted);
    } catch {
      return cfg;
    }
  };
}
