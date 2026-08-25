/**
 * Export 控制器（规范 §1 / §21，m6-ui）。
 *
 * 职责：
 *  - Quick Export：推荐项 = defaultIncluded 且非 deviceSpecific 的分区（设计 §11.1）；
 *  - Custom Export：按 §1 分组目录逐项勾选（含默认关闭的可选分区 pluginFiles/sessions）；
 *  - 进度事件：调用 core 前后按 §29 阶段文案发出（UI 不冻结）；
 *  - 结果：返回 ExportReport 并渲染 §21 文本报告。
 *
 * 依赖注入：ExportPort 由宿主在挂载时接入真实 Exporter（core/exporter.ts），
 * 测试注入内存 mock —— 本层零依赖 core 实现。
 */
import type { Manifest, SectionId } from '../schema/types.ts';
import type { ExportOptions, ExportReport } from '../core/types.ts';
import {
  EXPORT_GROUPS, type ExportCategory, type ExportGroup,
  type ProgressListener, isQuickRecommended,
} from './types.ts';
import { EXPORT_STAGES, ProgressTracker } from './progress.ts';
import { renderExportReport } from './report.ts';
import { zhUiT, type UiT } from './i18n.ts';

/** UI → core 的导出端口（宿主注入 Exporter.export；测试注入 mock） */
export interface ExportPort {
  export(options: ExportOptions): Promise<{ zipPath: string; manifest: Manifest; report: ExportReport }>;
}

/**
 * 自定义导出文件名的归一化（P0-④ 体验优化）：无需用户手动输入 `.zip`。
 * - trim 首尾空白；空串 → ''（宿主自动命名）；
 * - 非空且未以 `.zip` 结尾 → 自动补全 `.zip`（大小写不敏感判定，统一补小写后缀）；
 * - 已以 `.zip` 结尾 → 原样返回（含首字符为字母数字的校验由调用方/宿主把关）。
 */
export function normalizeExportFileName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /\.zip$/i.test(trimmed) ? trimmed : `${trimmed}.zip`
}

/** 导出附加选项（P0-④：自定义文件名/备注——经 ExportFlow.run 透传给 host /export） */
export interface ExportExtraOptions {
  /** 自定义导出文件名（.zip；缺省宿主自动命名） */
  fileName?: string
  /** 导出备注（写入 exports/.backup-notes.json；缺省无） */
  note?: string
}

export interface ExportFlowOptions {
  port: ExportPort;
  /** 分类目录（缺省用内置目录，与 adapters 的 displayName/defaultIncluded/portability 对齐） */
  categories?: ExportCategory[];
  onProgress?: ProgressListener;
  /** 报告渲染翻译器（zh/en，见 i18n.ts） */
  t?: UiT;
}

export interface ExportRunResult {
  zipPath: string;
  manifest: Manifest;
  report: ExportReport;
  /** §21 渲染文本（report.ts） */
  text: string;
}

/** 内置分类目录（与 src/adapters/* 的 displayName/defaultIncluded/portability 对齐，研究报告 §2.2） */
export const DEFAULT_CATEGORIES: readonly ExportCategory[] = [
  { id: 'settings', label: 'Settings', description: 'DSH 全局设置（namespace 分区，redacted）', defaultIncluded: true, portability: 'portable', group: 'general' },
  { id: 'providers', label: 'Providers & Models', description: 'LLM Provider / Model / 默认模型 / BaseURL', defaultIncluded: true, portability: 'portable', group: 'ai' },
  { id: 'plugins', label: 'Plugins', description: '已安装插件清单与启用状态（不含二进制）', defaultIncluded: true, portability: 'portable', group: 'extensions' },
  { id: 'pluginFiles', label: 'Plugin Files', description: '插件自有配置文件（白名单 + plugin-config/ 目录，整文件复制）', defaultIncluded: false, portability: 'deviceSpecific', group: 'extensions' },
  { id: 'self', label: 'Plugin Self Config', description: '本插件自身配置（同步/自动同步/分区选择/UI 偏好/市场；sync-*.json 等，不含凭据值）', defaultIncluded: true, portability: 'portable', group: 'extensions' },
  { id: 'mcp', label: 'MCP Servers', description: 'MCP 服务器组合配置（需重启生效）', defaultIncluded: true, portability: 'platformSpecific', group: 'mcp' },
  { id: 'prompts', label: 'Prompts', description: 'System Prompt / Plan Mode 提示', defaultIncluded: true, portability: 'portable', group: 'customization' },
  { id: 'skills', label: 'Skills', description: '用户技能文件（~/.dsh/skills）', defaultIncluded: true, portability: 'portable', group: 'customization' },
  { id: 'agentPresets', label: 'Agent Presets', description: 'Agent 预设（~/.dsh/.agent-presets）', defaultIncluded: true, portability: 'portable', group: 'customization' },
  { id: 'agentInstructions', label: 'Agent Instructions', description: '全局指令文件（~/.dsh/AGENTS.md，注入每个会话）', defaultIncluded: true, portability: 'portable', group: 'customization' },
  { id: 'workspaces', label: 'Workspaces', description: '工作区记录（含绝对路径，需路径映射）', defaultIncluded: true, portability: 'platformSpecific', group: 'workspace' },
  { id: 'ui', label: 'UI Preferences', description: 'UI 类 settings namespace（localStorage 项仅说明）', defaultIncluded: true, portability: 'portable', group: 'ui' },
  { id: 'credentialsStatus', label: 'Credentials Status', description: '凭据状态（configured 标记，永不导出值）', defaultIncluded: true, portability: 'deviceSpecific', group: 'optional', sensitive: true },
  { id: 'sessions', label: 'Sessions', description: '历史会话（默认关闭，含敏感内容）', defaultIncluded: false, portability: 'deviceSpecific', group: 'optional' },
] as const;

export class ExportFlow {
  readonly categories: readonly ExportCategory[];
  private readonly port: ExportPort;
  private readonly onProgress: ProgressListener | undefined;
  private readonly t: UiT;

  constructor(opts: ExportFlowOptions) {
    this.port = opts.port;
    this.categories = opts.categories ?? DEFAULT_CATEGORIES;
    this.onProgress = opts.onProgress;
    this.t = opts.t ?? zhUiT;
  }

  /** Quick Export 推荐分区（defaultIncluded 且非 deviceSpecific） */
  quickSelection(): SectionId[] {
    return this.categories.filter(isQuickRecommended).map((c) => c.id);
  }

  /** 按 §1 分组返回分类目录（Custom Export 树） */
  groupedCatalog(): { group: ExportGroup; label: string; note?: string; categories: ExportCategory[] }[] {
    return EXPORT_GROUPS.map((g) => ({
      group: g.id,
      label: g.label,
      note: g.note,
      categories: this.categories.filter((c) => c.group === g.id),
    }));
  }

  /** 校验 Custom 勾选：未知分区 = invalid；deviceSpecific 分区给提示警告（仍可继续） */
  validateSelection(selection: readonly SectionId[]): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];
    let valid = true;
    const known = new Set(this.categories.map((c) => c.id));
    for (const id of selection) {
      if (!known.has(id)) {
        warnings.push(`未知分区：${id}`);
        valid = false;
      }
    }
    for (const c of this.categories) {
      if (selection.includes(c.id) && c.portability === 'deviceSpecific') {
        warnings.push(`${c.label} 为设备相关数据（${c.portability}），跨设备导入时可能不适用`);
      }
    }
    return { valid, warnings };
  }

  /** 执行导出：发进度事件 → 调 core → 渲染 §21 报告 */
  async run(
    mode: 'quick' | 'custom',
    selection: readonly SectionId[],
    opts: { includeSecrets?: boolean; fileName?: string; note?: string } = {},
  ): Promise<ExportRunResult> {
    const tracker = new ProgressTracker(EXPORT_STAGES, this.onProgress);
    const only = mode === 'quick' ? this.quickSelection() : [...selection];
    if (mode === 'quick' && opts.includeSecrets === undefined) opts = { ...opts, includeSecrets: false };

    // 导出工作全部发生在 port.export() 的单次请求内，客户端无法逐阶段上报真实进度。
    // 旧实现把整串阶段一次性 emit，请求期间 UI 会静止在假的「Calculating checksums... 86%」，
    // 任何慢请求/挂起请求看起来都像卡死。改为：请求期间只发一个不带 step/total 的 in-flight
    // 阶段（ProgressBar 显示不定态动画），完成后发 done（100%）。超时/失败由 api 层显式抛出。
    tracker.emit('exporting');
    const result = await this.port.export({
      includeSecrets: opts.includeSecrets ?? false,
      only,
      // P0-④：透传自定义文件名/备注（非敏感；host 做安全校验与持久化）
      ...(opts.fileName !== undefined && opts.fileName !== '' ? { outPath: opts.fileName } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });

    tracker.emit('done');
    return { ...result, text: renderExportReport(result.report, this.t) };
  }
}
