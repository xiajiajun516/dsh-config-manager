/**
 * Config Manager 浏览器半 —— `/api/dsh-config-manager/*` 的类型化 fetch 封装。
 *
 * 设计对齐 dsh-ssh 的 `src/client/api.ts` 范式（同源 fetch、readJson、query helper），
 * 但方法签名直接实现 `src/ui/types.ts` 的 `ExportPort` / `ImportPort` 端口契约：
 * 客户端控制器（ExportFlow / ImportWizard）把本类实例当作 port 注入即可，
 * 无需任何额外适配层 —— 这是「直接绑定 src/ui，不重复实现」的关键。
 *
 * 端点契约（Host 半 `src/index.ts` 按此实现，见 CLIENT_DEPENDENCIES.md 的接口说明）：
 * ```
 * GET  /api/dsh-config-manager/status             → ServiceStatus        （健康/版本检查）
 * POST /api/dsh-config-manager/export             → ExportResponse       （body: ExportOptions；响应含 runId）
 * GET  /api/dsh-config-manager/download?path=…    → 文件流（content-disposition 文件名）
 * POST /api/dsh-config-manager/upload?name=…      → UploadResponse       （body: 原始字节）
 * POST /api/dsh-config-manager/analyze            → ImportAnalysis       （body: { zipPath }）
 * POST /api/dsh-config-manager/plan               → ImportPlan           （body: { zipPath, decisions }）
 * POST /api/dsh-config-manager/execute            → ImportResult         （body: { zipPath, plan, opts }；响应含 runId）
 * GET  /api/dsh-config-manager/progress?runId=…   → RunState             （run 实时状态：轮询/刷新恢复）
 * GET  /api/dsh-config-manager/runs               → RunState[]           （活跃 run 列表）
 * GET  /api/dsh-config-manager/backup-files       → { files: BackupFileMeta[] }（exports 备份文件列表）
 * POST /api/dsh-config-manager/backup-files/delete → { removed }          （body: { name }）
 * ```
 * 安全约束：
 *  - 所有响应/错误文本在进入 UI 前经 `redact()`（见 common/ErrorBanner.tsx）；
 *  - secretInputs 只存在于请求体内，绝不落日志；
 *  - 本文件不 import 任何 node 模块（纯浏览器 bundle）。
 */

import type { ImportAnalysis, ImportDecisions, ImportPlan, ImportResult } from '../core/types.ts';
import type { ExportOptions, ExportReport } from '../core/types.ts';
import type { RestorePlan, RestoreReport, SnapshotMeta } from '../core/restore.ts';
import type { ProfileMeta, ProfileSwitchResult, SwitchPreview } from '../profiles/profile-manager.ts';

import type { RunState } from '../core/run-registry.ts';
import type { ConsultReport } from '../core/migration-consult.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import type { BackupScheduleStatus, BackupRunResult, BackupScheduleDraft } from '../ui/backup-schedule.ts';
import type { BackupFileMeta } from '../sync/backup-files.ts';
import { zhUiT, type UiT } from '../ui/i18n.ts';

/** Host 半健康检查响应（plugin 版本 / DSH 版本 / 平台，用于主页横幅与兼容性说明） */
export interface ServiceStatus {
  ready: boolean;
  pluginVersion: string;
  dshVersion: string;
  platform: string;
  arch: string;
}

/** export 端点响应（对齐 ExportFlow 的 ExportRunResult 前半部分；runId 为 m1 run 注册表标识） */
export interface ExportResponse {
  zipPath: string;
  manifest: Manifest;
  report: ExportReport;
  /** m1：本次导出 run 的 id（可用 /progress 查询状态 / 刷新恢复） */
  runId: string;
}

/** upload 端点响应：Host 把用户上传的 ZIP 存入受控临时目录，返回可被 analyze/plan/execute 引用的路径 */
export interface UploadResponse {
  zipPath: string;
  name: string;
  sizeBytes: number;
  /** zip=普通备份；encrypted=整体加密备份容器（需先 decryptArchive 解锁才能按 ZIP 解析） */
  containerType: 'zip' | 'encrypted';
}

/** P1-⑦/P2-⑬：备份内容查看 / 差异对比结果（只读；复用 analyze + plan 链路，零写入） */
export interface BackupInspectResult {
  analysis: ImportAnalysis;
  plan: ImportPlan;
}

/** P2-⑫：导出前预览响应（不落盘 ZIP；各分区 counts + 估算大小） */
export interface ExportPreviewResponse {
  ok: boolean;
  sections: { section: SectionId; count: number; sizeBytes: number }[];
  totalSections: number;
  totalSizeBytes: number;
  sectionsFailed: number;
}

/** execute 端点请求体（对齐 ImportWizard.execute 的 opts） */
export interface ExecutePayload {
  zipPath: string;
  plan: ImportPlan;
  opts: {
    /** 安全阀：非 true 拒绝执行（core ImportNotConfirmedError） */
    confirm: boolean;
    /** 秘密补录值（仅内存，经 HTTPS 传输，Host 端不落盘） */
    secretInputs: Record<string, string>;
    /** true=任一项失败整体回滚（场景 E）；false=单项失败继续 */
    rollbackOnError: boolean;
    /** 加密备份的解密密码（仅内存；加密备份必须提供，core 拒绝无密码导入） */
    decryptPassword?: string;
  };
}

/** decrypt-archive 端点响应：解锁整体加密容器后返回明文 ZIP 路径 + 解密覆盖的凭据 ref 名（非值） */
export interface DecryptArchiveResponse {
  zipPath: string;
  /** 解密覆盖的凭据 ref 名（非值）；UI 据此从补录阶段剔除已恢复项 */
  refs: string[];
}

/** restore 端点响应：dryRun=true 返回 plan；执行返回 report（与 CLI 一致的诚实报告）。
 *  runId 仅真实执行时存在（宿主 RunRegistry 登记；/runs + /progress 刷新恢复用）。 */
export interface RestoreResponse {
  dryRun: boolean;
  plan?: RestorePlan;
  report?: RestoreReport;
  runId?: string;
}

/** Star 引导弹窗状态（GET /star-prompt；纯偏好，无 secret） */
export interface StarPromptStatus {
  ok: boolean;
  /** 引导用户点 Star 的 GitHub 仓库地址（Host 提供，硬编码常量） */
  repoUrl: string;
  /** 首次进入页面时间（ms 时间戳）；undefined = 尚未进入过页面 */
  firstSeenAt?: number;
  /** 用户点过「不再提示」 */
  dismissed: boolean;
  /** 用户点过「去点 Star」（方案 A：引导完成） */
  clicked: boolean;
}

/** Star 引导弹窗状态的局部更新补丁（POST /star-prompt；全部可选） */
export interface StarPromptPatch {
  firstSeenAt?: number;
  dismissed?: boolean;
  clicked?: boolean;
}

/** POST /star-prompt 响应（更新后的最新状态） */
export interface StarPromptSaveResponse {
  ok: boolean;
  firstSeenAt?: number;
  dismissed: boolean;
  clicked: boolean;
}

/** 路由族常量（集中管理，与 Host 半的路由前缀保持一致） */
export const CONFIG_MANAGER_API = {
  base: '/api/dsh-config-manager',
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  exportPreview: '/api/dsh-config-manager/export-preview',
  download: '/api/dsh-config-manager/download',
  upload: '/api/dsh-config-manager/upload',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  execute: '/api/dsh-config-manager/execute',
  skipExecute: '/api/dsh-config-manager/execute/skip',
  decryptArchive: '/api/dsh-config-manager/decrypt-archive',
  progress: '/api/dsh-config-manager/progress',
  runs: '/api/dsh-config-manager/runs',
  snapshots: '/api/dsh-config-manager/snapshots',
  restore: '/api/dsh-config-manager/restore',
  snapshotDelete: '/api/dsh-config-manager/snapshots/delete',
  snapshotPin: '/api/dsh-config-manager/snapshots/pin',
  backupSchedule: '/api/dsh-config-manager/backup-schedule',
  backupScheduleRun: '/api/dsh-config-manager/backup-schedule/run',
  backupFiles: '/api/dsh-config-manager/backup-files',
  backupFilesDelete: '/api/dsh-config-manager/backup-files/delete',
  consult: '/api/dsh-config-manager/consult',
  profiles: '/api/dsh-config-manager/profiles',
  profilesSave: '/api/dsh-config-manager/profiles/save',
  profilesDelete: '/api/dsh-config-manager/profiles/delete',
  profilesRename: '/api/dsh-config-manager/profiles/rename',
  profilesAnalyzeSwitch: '/api/dsh-config-manager/profiles/analyze-switch',
  profilesExecuteSwitch: '/api/dsh-config-manager/profiles/execute-switch',
  profilesImport: '/api/dsh-config-manager/profiles/import',
  starPrompt: '/api/dsh-config-manager/star-prompt',
} as const;

/** 导出请求超时（ms）：与 Host 半 ROUTE_TIMEOUT_MS 对齐，防止宿主卡死时 UI 无限等待 */
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;

/** 携带路由 JSON error 消息的错误类型 */
export class ConfigManagerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigManagerApiError';
  }
}

/** 解析 JSON 响应；非 2xx 时抛出带路由 error 消息的 ConfigManagerApiError */
async function readJson<T>(response: Response, t: UiT): Promise<T> {
  const notMountedMessage = t('error.notMounted');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) throw new ConfigManagerApiError(notMountedMessage);
    throw new ConfigManagerApiError(t('error.httpInvalidJson', { status: String(response.status) }));
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.status === 404
          ? notMountedMessage
          : `HTTP ${response.status}`;
    throw new ConfigManagerApiError(message);
  }
  return body as T;
}

/** query-string 辅助（跳过 undefined/空串，与 dsh-ssh 一致） */
function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : '?' + text;
}

/** 浏览器 File System Access API 的最小表面（非全部 lib.dom 版本都有） */
interface WindowWithFileSystemAccess {
  showSaveFilePicker?: (options: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<{ write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

/** 导出下载结果（流式落盘或内存 Blob 兜底） */
export interface DownloadResult {
  blob?: Blob;
  filename: string;
  streamed: boolean;
  bytes: number;
}

/** 下载选项：saveDialog=true 才弹系统保存对话框（需用户手势）；缺省自动下载到浏览器下载目录 */
export interface DownloadOptions {
  saveDialog?: boolean;
}

/** 用 Blob URL + <a download> 触发浏览器静默下载到默认下载目录（无需用户手势/另存为对话框）。 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // 稍后释放 URL：立即 revoke 可能让部分浏览器来不及开始下载
  setTimeout(() => { URL.revokeObjectURL(url) }, 15_000)
}

/**
 * Config Manager 浏览器半的唯一数据入口。
 * 同时实现 `ExportPort`（export-flow 用）与 `ImportPort`（import-wizard 用）。
 */
export class ConfigManagerApi {
  /**
   * 加密备份密码（仅内存，默认 null = 普通备份）。
   * ExportView 在 run 前设置；export 请求体携带给 Host 半做 AES-256-GCM 加密。
   * 绝不写入 manifest / 任何 DSH 配置 / localStorage。
   */
  exportPassword: string | null = null
  /** 客户端展示层翻译器（zh 源 / en 镜像，见 ui/i18n.ts）。 */
  readonly t: UiT

  constructor(t: UiT = zhUiT) {
    this.t = t
  }

  // ------------------------------------------------------------- status
  /** 健康/版本检查（主页横幅：插件版本 / DSH 版本 / 平台） */
  async status(): Promise<ServiceStatus> {
    const response = await fetch(CONFIG_MANAGER_API.status);
    return readJson<ServiceStatus>(response, this.t);
  }

  // ------------------------------------------------------------- star-prompt
  /** Star 引导弹窗状态（进入页面时判定是否展示 / 是否补记首次使用时间）。 */
  async starPromptStatus(): Promise<StarPromptStatus> {
    const response = await fetch(CONFIG_MANAGER_API.starPrompt);
    return readJson<StarPromptStatus>(response, this.t);
  }

  // ------------------------------------------------------- export-preview
  /** P2-⑫：导出前只读预览（不落盘 ZIP）——「将打包 X 分区 / Y 条目 / 约 Z 大小」。 */
  async exportPreview(only?: SectionId[]): Promise<ExportPreviewResponse> {
    const response = await fetch(CONFIG_MANAGER_API.exportPreview, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ only }),
    });
    return readJson<ExportPreviewResponse>(response, this.t);
  }

  /** 保存 Star 引导弹窗状态（局部更新：firstSeenAt / dismissed / clicked）。
   * 纯偏好无 secret；失败由调用方静默降级（本次不弹/不记，下次再判）。 */
  async saveStarPrompt(patch: StarPromptPatch): Promise<StarPromptSaveResponse> {
    const body: StarPromptPatch = {};
    if (patch.firstSeenAt !== undefined) body.firstSeenAt = patch.firstSeenAt;
    if (patch.dismissed === true) body.dismissed = true;
    if (patch.clicked === true) body.clicked = true;
    const response = await fetch(CONFIG_MANAGER_API.starPrompt, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return readJson<StarPromptSaveResponse>(response, this.t);
  }

  // ------------------------------------------------------------- export
  /** ExportPort.export：调用 Host 侧导出编排（core Exporter）。加密密码随请求体传输（仅内存）。
   * 带 AbortController 超时：宿主若卡死，客户端得到明确错误而不是永远停在进度条。 */
  async export(options: ExportOptions): Promise<ExportResponse> {
    const body: ExportOptions & { password?: string } = {
      ...options,
      password: this.exportPassword ?? undefined,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
    try {
      const response = await fetch(CONFIG_MANAGER_API.export, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return await readJson<ExportResponse>(response, this.t);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ConfigManagerApiError(this.t('error.exportTimeout', { minutes: String(Math.round(EXPORT_TIMEOUT_MS / 60000)) }));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 把导出的 ZIP 下载到本机。
   * - 默认（saveDialog 缺省/false）：读取为 Blob 后用 <a download> 触发浏览器
   *   静默下载到「下载」目录，无需用户额外操作（导出完成即可自动调用）；
   * - saveDialog: true：优先 File System Access API 流式落盘（不占整文件内存），
   *   用户可在系统保存对话框中选择位置；不可用/取消时回退 Blob 下载。
   */
  async download(
    zipPath: string,
    opts?: DownloadOptions,
    onProgress?: (received: number, total: number) => void,
  ): Promise<DownloadResult> {
    const response = await fetch(CONFIG_MANAGER_API.download + query({ path: zipPath }));
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => '');
      throw new ConfigManagerApiError(text !== '' ? text : this.t('error.downloadFailed', { status: String(response.status) }));
    }
    const total = Number(response.headers.get('content-length') ?? '0');
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match?.[1] ?? zipPath.split(/[\\/]/).pop() ?? 'dsh-config.zip';
    const reader = response.body.getReader();
    const usePicker =
      opts?.saveDialog === true
      && typeof window !== 'undefined'
      && (window as WindowWithFileSystemAccess).showSaveFilePicker !== undefined;
    let writable: { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void> } | undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    if (usePicker) {
      try {
        const picker = (window as WindowWithFileSystemAccess).showSaveFilePicker!;
        const handle = await picker.call(window, { suggestedName: filename });
        writable = await handle.createWritable();
      } catch {
        // 用户取消保存对话框或 API 不可用：回退内存 Blob + <a download>。
        writable = undefined;
      }
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writable !== undefined) {
        await writable.write(value as Uint8Array);
      } else {
        chunks.push(value as Uint8Array<ArrayBuffer>);
      }
      received += value.length;
      onProgress?.(received, total);
    }
    if (writable !== undefined) {
      await writable.close();
      return {
        blob: undefined,
        filename,
        streamed: true,
        bytes: received,
      };
    }
    // 默认路径：<a download> 静默下载到浏览器「下载」目录
    const blob = new Blob(chunks);
    triggerBlobDownload(blob, filename);
    return {
      blob,
      filename,
      streamed: false,
      bytes: received,
    };
  }

  // ------------------------------------------------------------- import
  /** 上传用户选择的 ZIP 到 Host 受控临时目录，返回可引用的 zipPath（dsh-ssh 同款原始字节上传） */
  async upload(file: File): Promise<UploadResponse> {
    const response = await fetch(CONFIG_MANAGER_API.upload + query({ name: file.name }), {
      method: 'POST',
      body: file,
    });
    return readJson<UploadResponse>(response, this.t);
  }

  /** ImportPort.analyzeImport：零写入分析（校验/兼容性/差异/路径/秘密检测） */
  async analyzeImport(zipPath: string): Promise<ImportAnalysis> {
    const response = await fetch(CONFIG_MANAGER_API.analyze, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zipPath }),
    });
    return readJson<ImportAnalysis>(response, this.t);
  }

  /** ImportPort.createImportPlan：用用户决策（冲突/路径映射/策略）生成最终计划（Dry Run 零写入） */
  async createImportPlan(zipPath: string, decisions: ImportDecisions): Promise<ImportPlan> {
    const response = await fetch(CONFIG_MANAGER_API.plan, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zipPath, decisions }),
    });
    return readJson<ImportPlan>(response, this.t);
  }

  /** ImportPort.decryptArchive：解锁整体加密备份容器 → 明文 ZIP 路径 + 解密覆盖的凭据 ref 名 */
  async decryptArchive(zipPath: string, password: string): Promise<DecryptArchiveResponse> {
    const response = await fetch(CONFIG_MANAGER_API.decryptArchive, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ zipPath, password }),
    });
    return readJson<DecryptArchiveResponse>(response, this.t);
  }

  /** ImportPort.executeImportPlan：快照→分阶段 apply→validate→commit/rollback */
  async executeImportPlan(
    zipPath: string,
    plan: ImportPlan,
    opts: { confirm: boolean; secretInputs?: Record<string, string>; rollbackOnError: boolean; decryptPassword?: string },
  ): Promise<ImportResult & { runId: string }> {
    const payload: ExecutePayload = {
      zipPath,
      plan,
      opts: {
        confirm: opts.confirm,
        secretInputs: opts.secretInputs ?? {},
        rollbackOnError: opts.rollbackOnError,
        decryptPassword: opts.decryptPassword,
      },
    };
    const response = await fetch(CONFIG_MANAGER_API.execute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return readJson<ImportResult & { runId: string }>(response, this.t);
  }

  // ------------------------------------------------------------- run 进度
  /** m1：查询单个 run 的实时状态（执行中轮询 / 刷新恢复用；404 = 已过保留期或不存在） */
  async progress(runId: string): Promise<RunState> {
    const response = await fetch(CONFIG_MANAGER_API.progress + query({ runId }));
    return readJson<RunState>(response, this.t);
  }

  /** m1：列出当前活跃（running）的 run（刷新后重新订阅进行中任务的入口） */
  async runs(): Promise<RunState[]> {
    const response = await fetch(CONFIG_MANAGER_API.runs);
    return readJson<RunState[]>(response, this.t);
  }

  /** 导入中「跳过当前插件」：宿主 abort 当前计划项的中止控制器（kill 子进程 + 清半装状态）。
   * 404 = run 不在执行（已完成/无进行中导入）。 */
  async skipExecute(runId: string): Promise<{ skipped: boolean }> {
    const response = await fetch(CONFIG_MANAGER_API.skipExecute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    return readJson<{ skipped: boolean }>(response, this.t);
  }

  // ------------------------------------------------------- 快照恢复（M4）
  /** 列出全部快照元信息（createdAt 倒序；含 status/条目数/宿主文件数/插件数） */
  async snapshots(): Promise<SnapshotMeta[]> {
    const response = await fetch(CONFIG_MANAGER_API.snapshots);
    const body = await readJson<{ snapshots: SnapshotMeta[] }>(response, this.t);
    return body.snapshots;
  }

  /** 快照恢复：dryRun=true 只取动作计划（零写入）；false 执行并返回诚实报告 */
  async restoreSnapshot(snapshotId: string, dryRun: boolean): Promise<RestoreResponse> {
    const response = await fetch(CONFIG_MANAGER_API.restore, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId, dryRun }),
    });
    return readJson<RestoreResponse>(response, this.t);
  }

  /** P1-⑧：手动删除单个快照（危险操作：该导入前回滚点不可恢复；`removed` 为是否实际删除）。 */
  async deleteSnapshot(snapshotId: string): Promise<{ removed: boolean }> {
    const response = await fetch(CONFIG_MANAGER_API.snapshotDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId }),
    });
    return readJson<{ ok: boolean; removed: boolean }>(response, this.t);
  }

  /** P1-⑧：置顶/取消置顶快照（置顶快照豁免自动保留清理，只能手动删除）。 */
  async setSnapshotPinned(snapshotId: string, pinned: boolean): Promise<{ pinned: boolean }> {
    const response = await fetch(CONFIG_MANAGER_API.snapshotPin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId, pinned }),
    });
    return readJson<{ ok: boolean; pinned: boolean }>(response, this.t);
  }

  // ------------------------------------------------- 配置档案（m-profiles）
  /** 列出全部 Profile（name/createdAt/updatedAt/sections/fileCount）。 */
  async profilesList(): Promise<ProfileMeta[]> {
    const response = await fetch(CONFIG_MANAGER_API.profiles);
    const body = await readJson<{ ok: boolean; profiles: ProfileMeta[] }>(response, this.t);
    return body.profiles;
  }

  /** 保存当前 DSH 配置为新 Profile（天然不含秘密值）。 */
  async profileSave(name: string, sections?: SectionId[]): Promise<ProfileMeta> {
    const response = await fetch(CONFIG_MANAGER_API.profilesSave, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, sections }),
    });
    const body = await readJson<{ ok: boolean; profile: ProfileMeta }>(response, this.t);
    return body.profile;
  }

  /** 删除 Profile（危险操作：该组配置快照不可恢复）。 */
  async profileDelete(name: string): Promise<void> {
    const response = await fetch(CONFIG_MANAGER_API.profilesDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await readJson<{ ok: boolean }>(response, this.t);
  }

  /** 重命名 Profile（目录级移动）。 */
  async profileRename(name: string, newName: string): Promise<ProfileMeta> {
    const response = await fetch(CONFIG_MANAGER_API.profilesRename, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, newName }),
    });
    const body = await readJson<{ ok: boolean; profile: ProfileMeta }>(response, this.t);
    return body.profile;
  }

  /** 切换前预览（只读，零写入）：分析切换到该 Profile 会产生的计划项。 */
  async profileAnalyzeSwitch(name: string): Promise<SwitchPreview> {
    const response = await fetch(CONFIG_MANAGER_API.profilesAnalyzeSwitch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await readJson<{ ok: boolean; preview: SwitchPreview }>(response, this.t);
    return body.preview;
  }

  /** 执行切换（confirm=true 安全阀；走快照 + 分阶段 apply + 失败回滚；响应含 runId）。 */
  async profileExecuteSwitch(name: string, opts: {
    strategy?: 'merge' | 'replace' | 'skipExisting'
    secretInputs?: Record<string, string>
    rollbackOnError?: boolean
  }): Promise<ProfileSwitchResult & { runId: string }> {
    const response = await fetch(CONFIG_MANAGER_API.profilesExecuteSwitch, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, confirm: true, ...opts }),
    });
    return readJson<ProfileSwitchResult & { runId: string }>(response, this.t);
  }

  /** 导入 Profile（content = profile.json 字符串；asName 可选覆盖目标名）。 */
  async profileImport(content: string, asName?: string): Promise<ProfileMeta> {
    const response = await fetch(CONFIG_MANAGER_API.profilesImport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, ...(asName !== undefined ? { asName } : {}) }),
    });
    const body = await readJson<{ ok: boolean; profile: ProfileMeta }>(response, this.t);
    return body.profile;
  }

  // ------------------------------------------------- 定时全量备份（快照 tab）
  /** 读取定时备份配置（enabled / interval / 上次运行状态；无敏感字段）。 */
  async backupSchedule(): Promise<BackupScheduleStatus> {
    const response = await fetch(CONFIG_MANAGER_API.backupSchedule);
    const body = await readJson<{ schedule: BackupScheduleStatus }>(response, this.t);
    return body.schedule;
  }

  /** 保存定时备份设置（enabled + interval）；Host 校验后原子写 + 重排调度器。 */
  async saveBackupSchedule(draft: BackupScheduleDraft): Promise<BackupScheduleStatus> {
    const response = await fetch(CONFIG_MANAGER_API.backupSchedule, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft),
    });
    const body = await readJson<{ schedule: BackupScheduleStatus }>(response, this.t);
    return body.schedule;
  }

  /** 立即执行一次全量备份（复用调度器 runOnce，防重；返回执行结果 + 最新配置）。 */
  async runBackupNow(): Promise<{ run: BackupRunResult; schedule: BackupScheduleStatus }> {
    const response = await fetch(CONFIG_MANAGER_API.backupScheduleRun, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    return readJson<{ run: BackupRunResult; schedule: BackupScheduleStatus }>(response, this.t);
  }

  // ------------------------------------------------- 备份文件管理（快照 tab）
  /** 列出导出目录（exports/*.zip）下的全部备份文件（时间倒序；含来源 auto/manual）。 */
  async listBackupFiles(): Promise<BackupFileMeta[]> {
    const response = await fetch(CONFIG_MANAGER_API.backupFiles);
    const body = await readJson<{ ok: boolean; files: BackupFileMeta[] }>(response, this.t);
    return body.files;
  }

  /** 删除一个备份文件（危险操作：不可恢复；仅限 exports 目录内 .zip）。 */
  async deleteBackupFile(name: string): Promise<{ removed: boolean }> {
    const response = await fetch(CONFIG_MANAGER_API.backupFilesDelete, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return readJson<{ ok: boolean; removed: boolean }>(response, this.t);
  }

  // ------------------------------------------------- Phase 7 迁移前咨询
  /** 迁移前咨询（只读健康评分 + 建议）：对 4 种可迁移源生成统一咨询报告。 */
  async consult(input: { type: 'export-zip' | 'local-snapshot' | 'remote-snapshot' | 'profile'; id: string; snapshotId?: string }): Promise<ConsultReport> {
    const response = await fetch(CONFIG_MANAGER_API.consult, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return readJson<ConsultReport>(response, this.t);
  }

  // ------------------------------------------------- P1-⑦/P2-⑬ 备份内容查看 / 差异对比
  /** 「查看备份内容」：对 exports 目录内的备份文件做只读分析（reuse /analyze，零写入）。
   *  返回分析 + 与当前配置的差异计划摘要（"装/导这个备份会动你什么"）。 */
  async inspectBackup(zipPath: string): Promise<BackupInspectResult> {
    // 1) 只读分析（分区清单 / 兼容性 / 路径 / 密钥数）
    const analysis = await this.analyzeImport(zipPath);
    // 2) 差异计划（merge 策略，零写入）：将更新的项 / 已一致的项 / 冲突等
    const plan = await this.createImportPlan(zipPath, {
      strategy: 'merge',
      resolutions: {},
      pathMappings: [],
    });
    return { analysis, plan };
  }
}
