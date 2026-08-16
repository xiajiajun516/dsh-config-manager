/**
 * 远程同步区块的纯渲染模型（m-sync-ui）。
 *
 * 与 src/ui/progress.ts → progress-view.ts 同模式：把「报告怎么渲染 / 按钮什么状态 /
 * 状态行写什么 / 私有仓库提示怎么展示」做成无副作用纯函数，node --test 直接测，
 * React 组件只做装配。文案直接用中文（项目源语言），组件不重复造。
 */
import type { PlanItem, PlanItemKind } from '../../core/types.ts';
import type { PullChange, SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts';
import type { SyncStatusResponse } from './sync-api.ts';

/* ---------------------------------------------------------------- 私有仓库提示 */

/**
 * 私有仓库强制提示文案（Settings 区块常驻警示横幅）。
 * 安全约束：同步内容为可移植配置，public 仓库会公开配置 → 必须私有；
 * token 仅用于认证，绝不写入同步文件/提交内容/日志。
 */
export const PRIVATE_REPO_HINT =
  '安全要求：同步仓库必须为私有仓库（public 仓库会公开你的配置内容）。认证 token 仅用于仓库访问，绝不写入同步文件、提交内容或日志。';

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
export function kindLabel(kind: PlanItemKind): string {
  switch (kind) {
    case 'Create': return '新增';
    case 'Update': return '更新';
    case 'Skip': return '跳过';
    case 'Conflict': return '冲突';
    case 'Install': return '安装';
    case 'MissingSecret': return '缺密钥';
    case 'MissingDependency': return '缺依赖';
    case 'PathMapping': return '路径映射';
    case 'Warning': return '警告';
    case 'Error': return '错误';
    default: return kind;
  }
}

/** severity → 短标签 */
export function severityLabel(severity: PlanItem['severity']): string {
  switch (severity) {
    case 'error': return '错误';
    case 'warning': return '警告';
    default: return '信息';
  }
}

/* ---------------------------------------------------------------- 按钮状态 */

export interface SyncButtons {
  canPush: boolean;
  canPull: boolean;
  pushLabel: string;
  pullLabel: string;
}

/**
 * 按钮可用性与文案：
 * - 任一操作进行中（busy）→ 两个按钮都禁用（防并发 push/pull）；
 * - 仓库地址为空 → 禁用（无仓库无从同步）；
 * - busy 时按钮文案切换为「正在推送/拉取…」（配 Spinner）。
 */
export function computeSyncButtons(busy: 'push' | 'pull' | null, repoUrl: string): SyncButtons {
  const idle = busy === null;
  const repoOk = repoUrl.trim() !== '';
  const enabled = idle && repoOk;
  return {
    canPush: enabled,
    canPull: enabled,
    pushLabel: busy === 'push' ? '正在推送…' : '推送到远端',
    pullLabel: busy === 'pull' ? '正在拉取…' : '拉取差异预览',
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
): SyncStatusSummary {
  if (loading) return { kind: 'loading', text: '正在读取同步状态…' };
  if (error !== null) return { kind: 'error', text: error };
  if (statusInfo === null || !statusInfo.configured) {
    return { kind: 'unconfigured', text: '尚未配置同步仓库（请填写仓库地址并推送一次以保存配置）' };
  }
  const cred = statusInfo.credentialConfigured
    ? '凭据已配置'
    : '未配置凭据（token 将在首次推送/拉取时写入 DSH credentials）';
  const last =
    statusInfo.lastSyncAt !== undefined && statusInfo.lastSyncAt !== ''
      ? `上次同步：${formatDateTime(statusInfo.lastSyncAt)}`
      : '尚未同步过';
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
export function formatLastSync(iso: string | undefined): string {
  if (iso === undefined || iso === '') return '从未同步';
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
export function pushReportView(report: SyncPushReport | null): PushReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return { kind: 'error', headline: report.message ?? '推送失败', sections: report.sections, warnings: report.warnings };
  }
  return {
    kind: 'ok',
    headline: `推送成功（快照 ${report.snapshotId}）`,
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
export function pullReportView(report: SyncPullReport | null): PullReportView | null {
  if (report === null) return null;
  if (!report.ok) {
    return { kind: 'error', headline: report.message ?? '拉取失败', summary: null, previewHint: '' };
  }
  if (report.changes.length === 0) {
    return { kind: 'empty', headline: report.message ?? '远端快照与本地一致（无变更）', summary: null, previewHint: '' };
  }
  return {
    kind: 'ok',
    headline: `远端快照 ${report.snapshotId} 差异预览：共 ${report.changes.length} 项变更`,
    summary: summarizePullChanges(report.changes),
    previewHint:
      '以上为只读差异预览，不会执行导入。v1 暂不提供一键导入接线；如需应用远端配置，请使用「导入恢复」向导手动导入导出的备份。',
  };
}
