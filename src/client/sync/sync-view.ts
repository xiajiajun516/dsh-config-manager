/**
 * 远程同步区块的纯渲染模型（m-sync-ui）。
 *
 * 与 src/ui/progress.ts → progress-view.ts 同模式：把「报告怎么渲染 / 按钮什么状态 /
 * 状态行写什么 / 私有仓库提示怎么展示」做成无副作用纯函数，node --test 直接测，
 * React 组件只做装配。文案直接用中文（项目源语言），组件不重复造。
 */
import type { PlanItem, PlanItemKind } from '../../core/types.ts';
import type { PullChange, SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts';
import type {
  ApplyItemsResponse, AutosyncInterval, AutosyncStatusResponse, GithubPollResponse, SyncConfirmItem,
  SyncItemAdoption, SyncStatusResponse,
} from './sync-api.ts';
import { zhUiT, type UiT } from '../../ui/i18n.ts';

/* ---------------------------------------------------------------- 私有仓库提示 */

/**
 * 私有仓库强制提示文案（Settings 区块常驻警示横幅）。
 * 安全约束：同步内容为可移植配置，public 仓库会公开配置 → 必须私有；
 * token 仅用于认证，绝不写入同步文件/提交内容/日志。
 */
export function privateRepoHint(t: UiT = zhUiT): string {
  return t('sync.privateRepoHint');
}

/* ---------------------------------------------------------------- 变更摘要 */

/** 需要人工决策的 PlanItem 类型（与 SyncEngine.pull 的 needsReview 判定一致） */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Install', 'Error',
]);

export interface PullChangeSummary {
  total: number;
  info: number;
  warning: number;
  error: number;
  /** 是否包含需要人工决策的项（冲突/密钥/依赖/安装/错误） */
  needsReview: boolean;
  items: PullChange[];
}

/** 差异摘要：按 severity 计数 + 需人工决策标记（UI 统计徽章与警示横幅的数据源） */
export function summarizePullChanges(changes: readonly PullChange[]): PullChangeSummary {
  let info = 0;
  let warning = 0;
  let error = 0;
  let needsReview = false;
  for (const c of changes) {
    if (c.severity === 'error') error += 1;
    else if (c.severity === 'warning') warning += 1;
    else info += 1;
    if (REVIEW_KINDS.has(c.kind)) needsReview = true;
  }
  return { total: changes.length, info, warning, error, needsReview, items: [...changes] };
}

/** PlanItemKind → 短标签（列表徽章） */
export function kindLabel(kind: PlanItemKind, t: UiT = zhUiT): string {
  switch (kind) {
    case 'Create': return t('sync.kind.create');
    case 'Update': return t('sync.kind.update');
    case 'Skip': return t('sync.kind.skip');
    case 'Conflict': return t('sync.kind.conflict');
    case 'Install': return t('sync.kind.install');
    case 'MissingSecret': return t('sync.kind.missingSecret');
    case 'MissingDependency': return t('sync.kind.missingDependency');
    case 'PathMapping': return t('sync.kind.pathMapping');
    case 'Warning': return t('sync.kind.warning');
    case 'Error': return t('sync.kind.error');
    default: return kind;
  }
}

/** severity → 短标签 */
export function severityLabel(severity: PlanItem['severity'], t: UiT = zhUiT): string {
  switch (severity) {
    case 'error': return t('sync.severity.error');
    case 'warning': return t('sync.severity.warning');
    default: return t('sync.severity.info');
  }
}

/* ---------------------------------------------------------------- 按钮状态 */

/** 远程同步通道类型：git（默认）或 webdav */
export type SyncChannel = 'git' | 'webdav';

export interface SyncButtons {
  canPush: boolean;
  canPull: boolean;
  pushLabel: string;
  pullLabel: string;
}

/** 活动通道的远端地址是否就绪（git=repoUrl，webdav=webdavUrl）。 */
export function computeRemoteReady(channel: SyncChannel, gitUrl: string, webdavUrl: string): boolean {
  const url = channel === 'webdav' ? webdavUrl : gitUrl;
  return url.trim() !== '';
}

/**
 * 按钮可用性与文案：
 * - 任一操作进行中（busy）→ 两个按钮都禁用（防并发 push/pull）；
 * - 活动通道远端地址未就绪（remoteReady=false）→ 禁用（无从同步）；
 * - busy 时按钮文案切换为「正在推送/拉取…」（配 Spinner）。
 */
export function computeSyncButtons(busy: 'sync' | 'push' | 'pull' | 'apply' | 'rollback' | null, remoteReady: boolean, t: UiT = zhUiT): SyncButtons {
  const idle = busy === null;
  const enabled = idle && remoteReady;
  return {
    canPush: enabled,
    canPull: enabled,
    pushLabel: busy === 'push' ? t('sync.pushing') : busy === 'sync' ? t('sync.syncing') : t('sync.pushLabel'),
    pullLabel: busy === 'pull' ? t('sync.pulling') : busy === 'sync' ? t('sync.syncing') : t('sync.pullLabel'),
  };
}

/* ---------------------------------------------------------------- 状态行 */

export type SyncStatusKind = 'loading' | 'unconfigured' | 'ready' | 'error';

export interface SyncStatusSummary {
  kind: SyncStatusKind;
  text: string;
}

/** 状态行渲染模型：加载 / 未配置 / 就绪（凭据 + 上次同步 + 通道）/ 错误 */
export function computeSyncStatus(
  statusInfo: SyncStatusResponse | null,
  loading: boolean,
  error: string | null,
  t: UiT = zhUiT,
): SyncStatusSummary {
  if (loading) return { kind: 'loading', text: t('sync.statusLoading') };
  if (error !== null) return { kind: 'error', text: error };
  if (statusInfo === null || !statusInfo.configured) {
    return { kind: 'unconfigured', text: t('sync.statusUnconfigured') };
  }
  const isWebdav = statusInfo.transport?.type === 'webdav';
  const credOk = isWebdav
    ? (statusInfo.webdav?.passwordConfigured ?? false)
    : statusInfo.credentialConfigured;
  const cred = credOk
    ? t('sync.credConfigured')
    : t('sync.credMissing');
  const last =
    statusInfo.lastSyncAt !== undefined && statusInfo.lastSyncAt !== ''
      ? t('sync.lastSync', { time: formatDateTime(statusInfo.lastSyncAt) })
      : t('sync.neverSynced');
  const transport =
    statusInfo.transport !== undefined
      ? ` · ${statusInfo.transport.type}${statusInfo.transport.ref !== '' ? `/${statusInfo.transport.ref}` : ''}`
      : '';
  return { kind: 'ready', text: `${cred} · ${last}${transport}` };
}

/** ISO-8601 → 本地可读时间（YYYY-MM-DD HH:mm；非法输入原样返回） */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 上次同步时间的展示文本（'' / undefined = 从未同步） */
export function formatLastSync(iso: string | undefined, t: UiT = zhUiT): string {
  if (iso === undefined || iso === '') return t('sync.neverSyncedShort');
  return formatDateTime(iso);
}

/* ---------------------------------------------------------------- 报告渲染模型 */

export interface PushReportView {
  kind: 'ok' | 'error';
  headline: string;
  sections: string[];
  warnings: string[];
}

/** push 报告 → 渲染模型（ok 头部带快照 id；失败显示引擎 message；分区与告警透传） */
export function pushReportView(report: SyncPushReport | null, t: UiT = zhUiT): PushReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return { kind: 'error', headline: report.message ?? t('sync.pushFailed'), sections: report.sections, warnings: report.warnings };
  }
  return {
    kind: 'ok',
    headline: t('sync.pushOk', { id: report.snapshotId }),
    sections: report.sections,
    warnings: report.warnings,
  };
}

export interface PullReportView {
  kind: 'ok' | 'empty' | 'error';
  headline: string;
  summary: PullChangeSummary | null;
  /** 只读预览提示（ok 时非空：明确「预览不执行导入」） */
  previewHint: string;
}

/** pull 报告 → 渲染模型（差异预览；empty = 无变更；error = 拉取失败） */
export function pullReportView(report: SyncPullReport | null, t: UiT = zhUiT): PullReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return { kind: 'error', headline: report.message ?? t('sync.pullFailed'), summary: null, previewHint: '' };
  }
  if (report.changes.length === 0) {
    return { kind: 'empty', headline: report.message ?? t('sync.pullEmpty'), summary: null, previewHint: '' };
  }
  return {
    kind: 'ok',
    headline: t('sync.pullOk', { id: report.snapshotId, count: String(report.changes.length) }),
    summary: summarizePullChanges(report.changes),
    previewHint: t('sync.previewHint'),
  };
}

/* ---------------------------------------------------------------- GitHub 登录视图模型 */

export type GithubLoginPhase = 'idle' | 'starting' | 'waiting' | 'polling' | 'success' | 'error';

export interface GithubLoginView {
  phase: GithubLoginPhase;
  /** 一次性用户码（waiting/polling 展示，用户到 GitHub 授权页输入） */
  userCode: string;
  /** GitHub 授权页 URL */
  verificationUri: string;
  /** 状态行文案（中文，项目源语言；与 computeSyncStatus 同策略，不依赖 locale 注入） */
  statusText: string;
  /** 主按钮文案：发起 / 重新登录 */
  startLabel: string;
  /** 是否可发起/重试登录 */
  canStart: boolean;
  /** 流程进行中是否展示「取消」按钮 */
  canCancel: boolean;
  /** 是否展示设备码 + 授权链接区块 */
  showCode: boolean;
  /** 错误消息（phase=error；来自轮询终止态或请求失败） */
  error: string | null;
}

/**
 * GitHub 登录区块渲染模型（纯函数，node 可测）：
 * - idle → 可发起；starting → 请求设备码中；waiting → 展示设备码等待用户在浏览器授权；
 * - polling → 轮询 GitHub 中（仍展示代码区块）；success → 完成；error → 可重试。
 */
export function computeGithubLoginView(
  phase: GithubLoginPhase,
  userCode: string,
  verificationUri: string,
  error: string | null,
  t: UiT = zhUiT,
): GithubLoginView {
  const inFlight = phase === 'starting' || phase === 'waiting' || phase === 'polling';
  let statusText: string;
  switch (phase) {
    case 'starting':
      statusText = t('sync.github.starting');
      break;
    case 'waiting':
      statusText = userCode === ''
        ? t('sync.github.waitingNoCode')
        : t('sync.github.waiting', { code: userCode });
      break;
    case 'polling':
      statusText = t('sync.github.polling');
      break;
    case 'success':
      statusText = t('sync.github.success');
      break;
    case 'error':
      statusText = error ?? t('sync.github.failed');
      break;
    default:
      statusText = t('sync.github.defaultStatus');
  }
  return {
    phase,
    userCode,
    verificationUri,
    statusText,
    startLabel: phase === 'error' ? t('sync.github.relogin') : t('sync.github.login'),
    canStart: phase === 'idle' || phase === 'error',
    canCancel: inFlight,
    showCode: phase === 'waiting' || phase === 'polling',
    error,
  };
}

/** 轮询终止态 → 用户可读消息（pending 不是终止态，返回空串；成功/拒绝/过期/错误给出明确文案） */
export function githubPollMessage(poll: GithubPollResponse, t: UiT = zhUiT): string {
  switch (poll.status) {
    case 'success':
      return t('sync.github.pollSuccess');
    case 'denied':
      return t('sync.github.pollDenied');
    case 'expired':
      return t('sync.github.pollExpired');
    case 'error':
      return t('sync.github.pollError', { detail: poll.message ?? poll.errorCode ?? t('sync.github.unknownError') });
    default:
      return '';
  }
}

/* ---------------------------------------------------------------- 一键同步差异确认（方案 A） */

/** 需要人工决策的 PlanItemKind（与 Host /sync/sync 的 needsReview 判定对齐）。 */
const CONFIRM_REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Install', 'Error', 'PathMapping',
]);

/**
 * 是否需要人工决策（是否进入差异确认列表）。
 * 非决策项（Create / Update / Skip / Warning 等）默认自动采用（defaultAdopt=true），
 * 不逐项展示但 apply-items 时照常导入。
 */
export function isReviewItem(kind: PlanItemKind): boolean {
  return CONFIRM_REVIEW_KINDS.has(kind);
}

/**
 * 仅保留需人工决策的项（差异确认列表只渲染这些）。
 * 统计（summarizeConfirmItems）仍基于全量 items，不受影响。
 */
export function reviewItems(items: readonly SyncConfirmItem[]): SyncConfirmItem[] {
  return items.filter((it) => CONFIRM_REVIEW_KINDS.has(it.kind));
}

/** 冲突解决方式：与导入恢复向导（ConflictList）完全一致的两项（保留当前 / 使用导入）。
 *  - keepLocal = keepCurrent（保留本地现有值，不写入）；
 *  - useRemote = useImported（采用远端快照值，写入本地）。
 */
export type SyncConflictResolution = 'keepLocal' | 'useRemote';

/** 单条 Conflict 项的批量决策（resolution + adopt）。 */
export interface ConflictDecision {
  itemId: string;
  resolution: SyncConflictResolution;
  adopt: boolean;
}

/**
 * 「全部保留本地」：所有 Conflict 项 → resolution=keepLocal、adopt=false。
 * 仅作用于 Conflict 项，非 Conflict 项的 adopt 保持默认。
 */
export function keepLocalAll(items: readonly SyncConfirmItem[]): ConflictDecision[] {
  return items
    .filter((it) => it.kind === 'Conflict')
    .map((it) => ({ itemId: it.itemId, resolution: 'keepLocal', adopt: false }));
}

/**
 * 「全部采用远端」：所有 Conflict 项 → resolution=useRemote、adopt=true。
 * 仅作用于 Conflict 项，非 Conflict 项的 adopt 保持默认。
 */
export function useRemoteAll(items: readonly SyncConfirmItem[]): ConflictDecision[] {
  return items
    .filter((it) => it.kind === 'Conflict')
    .map((it) => ({ itemId: it.itemId, resolution: 'useRemote', adopt: true }));
}

export interface SyncConfirmSummary {
  total: number;
  info: number;
  warning: number;
  error: number;
  /** 默认/当前采用数（adopt=true 的项数）。 */
  adopted: number;
  /** 是否包含任何需人工决策项。 */
  needsReview: boolean;
}

/** 差异确认列表摘要（按 severity 计数 + 采用数 + needsReview 徽章数据源）。 */
export function summarizeConfirmItems(items: readonly SyncConfirmItem[]): SyncConfirmSummary {
  let info = 0;
  let warning = 0;
  let error = 0;
  let adopted = 0;
  let needsReview = false;
  for (const it of items) {
    if (it.severity === 'error') error += 1;
    else if (it.severity === 'warning') warning += 1;
    else info += 1;
    if (it.adopt) adopted += 1;
    if (CONFIRM_REVIEW_KINDS.has(it.kind)) needsReview = true;
  }
  return { total: items.length, info, warning, error, adopted, needsReview };
}

/**
 * 收集用户逐项决策 → apply-items 请求体 adoptions[]。
 * 仅包含 adopt=true 的项；Conflict 项 adopt=true 且未给 resolution → 抛错（强制先解决）。
 * 与导入恢复向导一致：只提供「保留当前 / 使用导入」两项，跳过 = 取消勾选（adopt=false）。
 */
export function buildAdoptions(
  items: readonly SyncConfirmItem[],
  adopted: ReadonlyMap<string, boolean>,
  resolutions: ReadonlyMap<string, SyncConflictResolution>,
): SyncItemAdoption[] {
  const out: SyncItemAdoption[] = [];
  for (const it of items) {
    if (adopted.get(it.itemId) !== true) continue; // adopt=false / 未列出 → 跳过
    const adoption: SyncItemAdoption = { itemId: it.itemId, adopt: true };
    if (it.kind === 'Conflict') {
      const resolution = resolutions.get(it.itemId);
      if (resolution === undefined) {
        throw new Error(`冲突项 ${it.itemId} 必须先选择解决方式（保留当前 / 使用导入）`);
      }
      adoption.resolution = resolution;
    }
    out.push(adoption);
  }
  return out;
}

export type ApplyItemsViewKind = 'ok' | 'failed' | 'rolledBack';

export interface ApplyItemsView {
  kind: ApplyItemsViewKind;
  headline: string;
  sections: string[];
  warnings: string[];
  restoreId: string;
  needsRestart: boolean;
}

/** apply-items 执行结果 → 渲染模型（ok / failed / 整体回滚）。 */
export function applyItemsReportView(
  report: ApplyItemsResponse | null,
  t: UiT = zhUiT,
): ApplyItemsView | null {
  if (report === null) return null;
  const failedOnly = report.failed.length > 0 && !report.ok;
  const kind: ApplyItemsViewKind = !report.ok && report.rolledBack ? 'rolledBack' : failedOnly ? 'failed' : 'ok';
  const headline = kind === 'ok'
    ? t('sync.importDone', { n: String(report.applied.length) })
    : kind === 'rolledBack'
      ? t('sync.importFailed')
      : t('sync.importFailed');
  return {
    kind,
    headline,
    sections: report.applied,
    warnings: report.warnings,
    restoreId: report.restoreId,
    needsRestart: report.needsRestart,
  };
}

/* ---------------------------------------------------------------- 自动同步（方案 A） */

/** AutosyncInterval → ms。 */
export function autosyncIntervalMs(interval: AutosyncInterval): number {
  switch (interval) {
    case '5m': return 5 * 60 * 1000;
    case '15m': return 15 * 60 * 1000;
    case '60m': return 60 * 60 * 1000;
    case '6h': return 6 * 60 * 60 * 1000;
    case '12h': return 12 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

/** 距下次自动同步剩余 ms（已到期 → 0）。elapsedMs 为 host 计算的「距上次执行已过 ms」。 */
export function computeAutosyncCountdown(elapsedMs: number, intervalMs: number): number {
  if (elapsedMs < 0) return -1; // 从未运行
  return Math.max(0, intervalMs - elapsedMs);
}

/**
 * 剩余时长 → 可读文案（向上取整，避免出现「0 分钟」；≤0 视为 1 分钟兜底）。
 * 例：4 分钟 →「4 分钟」；90 分钟 →「2 小时」；30 小时 →「2 天」。
 */
export function formatIntervalDuration(ms: number, t: UiT = zhUiT): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  if (totalMinutes < 60) return t('sync.duration.min', { n: totalMinutes });
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return t('sync.duration.hour', { n: totalHours });
  const totalDays = Math.ceil(totalHours / 24);
  return t('sync.duration.day', { n: totalDays });
}

/** 自动同步状态行的可读文案（未运行 / 上次状态 / 连续失败计数）。 */
export function autosyncStatusText(status: AutosyncStatusResponse, t: UiT = zhUiT): string {
  if (status.lastRunAt === undefined || status.lastRunAt === '' || status.lastRunStatus === undefined) {
    return t('sync.autosyncNever');
  }
  const statusText = status.lastRunStatus === 'success'
    ? t('sync.autosyncSuccess')
    : status.lastRunStatus === 'skipped'
      ? t('sync.autosyncSkipped')
      : status.lastRunStatus === 'partial'
        ? t('sync.autosyncPartial')
        : t('sync.autosyncFailed');
  const time = formatDateTime(status.lastRunAt);
  const base = t('sync.autosyncLastRun', { time });
  const fail = status.consecutiveFailures > 0 ? ` · ${t('sync.autosyncFailCount', { n: String(status.consecutiveFailures) })}` : '';
  return `${statusText} · ${base}${fail}`;
}
