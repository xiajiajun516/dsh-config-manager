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
import { SECTION_IDS, sectionMeta } from '../schema/section-registry.ts';
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

/**
 * 清单读取失败的**分区**（UI-07）。
 *
 * 宿主 /export-preview 只回一个 `sectionsFailed` 数字，拿不到分区 id，所以按
 * 「请求了但没回来」自行判定 —— 与引擎「清单缺失的分区按整体导出处理」的语义一致。
 * 展示层据此逐行标注「读取失败 · 将整体导出」并抑制误导性的「已选 0/0」；
 * 请求**整体失败**（宿主异常 / 断网）时调用方直接把本批在途分区全部计入失败。
 * 纯函数（node 可测），React 壳不自己写判定。
 */
export function failedSectionsFromResponse(
  requested: readonly SectionId[],
  returned: readonly SectionId[],
): SectionId[] {
  const got = new Set(returned)
  return requested.filter((s) => !got.has(s))
}

/** 勾选校验结果（结构化；文案由展示层 i18n 渲染，见 validateSelection）。 */
export interface SelectionValidation {
  /** 全部为已知分区 */
  valid: boolean;
  /** 未知 / 不存在的分区 id */
  unknown: SectionId[];
  /** 勾选中属于「设备相关」的分区（跨设备使用时可能不适用；非阻断） */
  deviceSpecific: SectionId[];
}

export interface ExportFlowOptions {
  port: ExportPort;
  /** 分类目录（缺省用内置目录 —— 由分区注册表派生，见 DEFAULT_CATEGORIES） */
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

/**
 * 目录条目描述（**报告文本 / 日志**用，非 UI 显示名）—— 只存在于本文件，无第二份副本。
 *
 * 键类型 `Exclude<SectionId, 'secrets'>`：secrets 无 ZIP 载荷、不进导出目录，
 * 因此除它以外的分区**全部**必须有描述 —— 漏一个即编译失败（与注册表同一穷举纪律）。
 */
const CATEGORY_DESCRIPTIONS: Record<Exclude<SectionId, 'secrets'>, string> = {
  settings: 'DSH 全局设置（namespace 分区，redacted）',
  providers: 'LLM Provider / Model / 默认模型 / BaseURL',
  plugins: '已安装插件清单与启用状态（不含二进制）',
  pluginFiles: '插件自有配置文件（白名单 + plugin-config/ 目录，整文件复制）',
  self: '本插件自身配置（同步/自动同步/分区选择/UI 偏好/市场；sync-*.json 等，不含凭据值）',
  mcp: 'MCP 服务器组合配置（需重启生效）',
  prompts: 'System Prompt / Plan Mode 提示',
  skills: '用户技能文件（~/.dsh/skills）',
  agentPresets: 'Agent 预设（~/.dsh/.agent-presets）',
  agentInstructions: '全局指令文件（~/.dsh/AGENTS.md，注入每个会话）',
  workspaces: '工作区记录（含绝对路径，需路径映射）',
  ui: 'UI 类 settings namespace（localStorage 项仅说明）',
  credentialsStatus: '凭据状态（configured 标记，永不导出值）',
  sessions: '历史会话（默认关闭，含敏感内容）',
};

/** 需在 UI 标注安全提示、但绝不显示值的分区（凭据状态只有 configured 标记） */
const SENSITIVE_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(['credentialsStatus']);

/**
 * 内置分类目录 —— **从分区注册表派生**（t31）。
 *
 * 改动前这里与 `src/adapters/*` 各自维护一份 defaultIncluded / portability / 显示名，
 * 是「同一事实两处维护」的典型（且 credentialsStatus 的显示名已经漂移）。现在：
 *  - `label` ← `sectionMeta(id).displayName`（唯一英文规范名，与 client 字典 section.<id> 的 en 一致）；
 *  - `group` ← `sectionMeta(id).group`；
 *  - `defaultIncluded` / `portability` ← 注册表同名派生值；
 *  - 只有 `description`（报告文案）与 `sensitive`（安全提示）留在本文件。
 *
 * **顺序是行为的一部分**（Custom Export 树的展示顺序）：外层按 `EXPORT_GROUPS` 顺序、
 * 内层按 `SECTION_IDS`（= applyOrder 升序），与改造前的手写顺序逐项一致。
 * `payload.kind === 'none'` 的分区（secrets）不进目录 —— 其值走独立加密容器。
 */
function buildDefaultCategories(): readonly ExportCategory[] {
  const categories: ExportCategory[] = [];
  for (const group of EXPORT_GROUPS) {
    for (const id of SECTION_IDS) {
      const meta = sectionMeta(id);
      if (meta.payload.kind === 'none') continue;
      if (meta.group !== group.id) continue;
      categories.push({
        id,
        label: meta.displayName,
        description: CATEGORY_DESCRIPTIONS[id as Exclude<SectionId, 'secrets'>],
        defaultIncluded: meta.defaultIncluded,
        portability: meta.portability,
        group: meta.group,
        ...(SENSITIVE_SECTIONS.has(id) ? { sensitive: true } : {}),
      });
    }
  }
  return categories;
}

/** 内置分类目录（注册表派生；宿主可经 ExportFlowOptions.categories 覆盖） */
export const DEFAULT_CATEGORIES: readonly ExportCategory[] = buildDefaultCategories();

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

  /**
   * 校验勾选：未知分区 = invalid；deviceSpecific 分区需就地警示（非阻断，仍可继续）。
   *
   * 返回**结构化结果**（不是拼好的字符串）：文案必须由展示层走 i18n 字典渲染 ——
   * 原实现把中文警告文本硬编码在纯逻辑层，且生产代码无人调用（审计 UI-09），
   * 而同一批文案在 `ui/i18n.ts` 里另有一份（`export.unknownSection` /
   * `export.deviceSpecific`），属于「同一句话两处维护」。展示层按分区 id 自己起名
   * （`common/section-labels.ts`）即可，这里只说「哪些分区有问题」。
   */
  validateSelection(selection: readonly SectionId[]): SelectionValidation {
    const known = new Set(this.categories.map((c) => c.id));
    const unknown = selection.filter((id) => !known.has(id));
    const deviceSpecific = this.categories
      .filter((c) => c.portability === 'deviceSpecific' && selection.includes(c.id))
      .map((c) => c.id);
    return { valid: unknown.length === 0, unknown, deviceSpecific };
  }

  /** 执行导出：发进度事件 → 调 core → 渲染 §21 报告 */
  async run(
    selection: readonly SectionId[],
    opts: {
      includeSecrets?: boolean
      fileName?: string
      note?: string
      /**
       * 条目级选择（Phase 1）：只在部分勾选的分区上下发（由 selection-model 的
       * buildExportRequest 决定）。缺省不下发 = 这些分区全量导出。
       */
      includeItems?: Partial<Record<SectionId, string[]>>
    } = {},
  ): Promise<ExportRunResult> {
    const tracker = new ProgressTracker(EXPORT_STAGES, this.onProgress);
    // 只有一个导出流程：导出的就是调用方传进来的这个集合（内容选择器的唯一出口）。
    const only = [...selection];

    // 导出工作全部发生在 port.export() 的单次请求内，客户端无法逐阶段上报真实进度。
    // 旧实现把整串阶段一次性 emit，请求期间 UI 会静止在假的「Calculating checksums... 86%」，
    // 任何慢请求/挂起请求看起来都像卡死。改为：请求期间只发一个不带 step/total 的 in-flight
    // 阶段（ProgressBar 显示不定态动画），完成后发 done（100%）。超时/失败由 api 层显式抛出。
    tracker.emit('exporting');
    const result = await this.port.export({
      includeSecrets: opts.includeSecrets ?? false,
      only,
      // 条目级白名单（稀疏：只有部分勾选的分区才会出现）
      ...(opts.includeItems !== undefined ? { includeItems: opts.includeItems } : {}),
      // P0-④：透传自定义文件名/备注（非敏感；host 做安全校验与持久化）
      ...(opts.fileName !== undefined && opts.fileName !== '' ? { outPath: opts.fileName } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });

    tracker.emit('done');
    return { ...result, text: renderExportReport(result.report, this.t) };
  }
}
