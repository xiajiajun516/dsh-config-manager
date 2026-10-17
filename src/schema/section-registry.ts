/**
 * 分区注册表 —— **分区集合的唯一权威来源**（t29 建立；t34 并入风险分级）。
 *
 * 为什么存在：改动前「有哪些分区」这件事被抄写在 ≥9 处（types.ts 的 SectionId 联合、
 * config.ts 的 SECTION_IDS / SECTION_JSON_PATHS / SECTION_FILE_PREFIXES / validateSectionData
 * switch、core/backup.ts 的 engineSnapshotEntry、core/backup-plan.ts 与 core/exporter.ts 的
 * buildSectionFlags、market/prepare.ts 的 SECTION_PORTABILITY、sync/risk.ts 风险表、
 * ui/export-flow.ts 目录元数据、core/analyzer.ts），任一处漏改都会产生「某分区被静默按另一
 * 分区语义处理」的缺陷 —— 真实案例就在 `core/backup.ts` 的 `engineSnapshotEntry` default 分支
 * （未知分区被静默记成 settingsNamespace，导致该分区写入无法回滚）。
 *
 * 本批次的硬性质：
 *  a. **新增分区的成本（t34 按实测订正；此前写成「三处」与实测不符）**：
 *     ① 唯一登记：`types.ts` 的 SectionId 联合加一项；
 *     ② **4 个生产强制点**（编译期，漏填即 tsc 报错；**按符号指认，不写行号**——行号随文件演进漂移，
 *        此前写死的注册表锚点已与实测不符、复核后纠正；实测命令见下）：
 *        - `schema/section-registry.ts` 的 `SECTION_REGISTRY: Record<SectionId, SectionMeta>`（报错落在该声明处）——
 *          缺 id → TS2741；该条目需逐项填 displayName / group / payload（zipPath 或 filePrefix）/ dataVersion /
 *          applyOrder / portability / syncOptIn / defaultIncluded / **riskTier** / **configSnapshot**；
 *        - `core/backup.ts` 的 `const unhandled: never = target.adapter` 穷尽 switch → TS2322；
 *        - `client/common/section-labels.ts` 的 `SECTION_LABEL_KEY: Record<SectionId, ConfigManagerKey>` i18n 标签 → TS2741；
 *        - `ui/export-flow.ts` 的 `CATEGORY_DESCRIPTIONS: Record<Exclude<SectionId,'secrets'>, string>` → TS2741；
 *     ③ **4 处测试夹具**（同批强制，但非生产点）：`adapters/test-helpers.ts` 的 `makeManifest()` 内 `sections`、
 *        `sync/transport.test.ts` 的 `manifestSummaryFrom` 用例内 `sections`、
 *        `ui/test-helpers.ts` 的 `makeManifest()` 内 `sections` 与 `makePlan()` 内 `estimatedActions`；
 *     ④ 实现该分区的 adapter。
 *     已被派生、**不再**是独立决策点的两处：`market/prepare.ts` 的可移植性表（t32 起取注册表）、
 *     `sync/risk.ts` 的风险分级（t34 起并入上面注册表条目）。
 *     **可核对的重测方法（不动工作树）**：把 `src` 与 `tsconfig.json` 复制到临时目录、在其中 junction
 *     `node_modules`，往副本的 `schema/types.ts` 加一个 id（如 'experiments'）后跑 `npx tsc -p <副本>`，
 *     报 `TS2741/TS2322` 的文件即全部强制点 —— 实测结果就是上面 ②③ 两份清单
 *     （t33 曾在工作树上直测，得到同一组文件；t29 实验 B 亦然，此后 t31/t32 已派生掉两处）。
 *  b. **编译期穷举**：`SECTION_REGISTRY` 声明为 `Record<SectionId, SectionMeta>` ——
 *     漏注册一个 SectionId（或写错 id / 漏填必填字段如 `riskTier`）即 **tsc 报错**，
 *     不得用 Partial / 索引签名绕过；
 *  c. **零依赖**：本模块只 import 一个**类型**（`type { SectionId }`），
 *     不 import 任何 node 内置模块 / npm 包 —— 可被 client 侧与 headless 消费（铁律：
 *     client bundle 自包含）。新增 import 前请先确认不破坏该性质；
 *  d. **派生而非复制**：ZIP 内 JSON 路径、文件类分区目录前缀、分区载荷版本、
 *     应用顺序、portability、同步可选分区、默认勾选、**风险分级**、**灾备采集口径**全部在本表逐分区声明，
 *     其余模块取派生视图（`SECTION_IDS` / `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` /
 *     `PORTABLE_SECTION_IDS` / … / sync/risk.ts 的 `SECTION_RISK_TIER`）；
 *     同一事实只允许存在一份字面量（载荷版本收敛为 `SECTION_DATA_VERSION`，
 *     风险分级收敛为各条目的 `riskTier`）；
 *  e. **未注册分区不静默**：`sectionMetaOf`（本文件）与 `requireSectionMeta`（t7 起迁到
 *     `config.ts` —— 用户可见文案必须走消息目录，而本文件受「只 import 一个类型」的零依赖铁律约束）
 *     让运行期拿到未注册 id 时显式失败（`validateSectionData` 已按此实现），
 *     绝不落到某个 default 分支按其它分区语义处理
 *     （历史缺陷在 `core/backup.ts` 的 `engineSnapshotEntry` default 分支；
 *     修复与回归用例见 `core/config-snapshot.ts:430` 附近与 `core/config-snapshot.test.ts`）。
 *
 * 下游消费约定（t30 core / t31 ui / t32 adapters 直接用本模块的导出）：
 *  - 需要「分区集合」→ `SECTION_IDS`（按 applyOrder 升序，与历史数组逐项一致）；
 *  - 需要 ZIP 路径 → `jsonPathOf(id)`（null = 该分区无 JSON 载荷）或 `SECTION_JSON_PATHS`；
 *  - 需要文件类目录前缀 → `filePrefixOf(id)`（null = 非文件类）或 `SECTION_FILE_PREFIXES`；
 *  - 需要 portability → `sectionMeta(id).portability`；需要同步可选分区 → `OPT_IN_SYNC_SECTION_IDS`
 *    （其中允许自动同步的子集 → `AUTO_SYNC_OPT_IN_SECTION_IDS`）；
 *  - 需要「快速导出默认勾选」→ `DEFAULT_INCLUDED_SECTION_IDS`；
 *  - 需要灾备（配置状态快照）采集口径 → `CONFIG_SNAPSHOT_SECTION_IDS`；
 *  - 需要风险等级 → `sectionMeta(id).riskTier`（sync 侧经 `riskTierOf(id)`；未注册 → undefined → 待审）；
 *  - 需要校验分区载荷 version → `versions.ts` 的 `isSupportedSectionDataVersion` /
 *    `sectionDataVersionIssue`（唯一校验函数），或直接比对 `sectionMeta(id).dataVersion`；
 *  - 需要「拿不到就显式报错」→ `requireSectionMeta(id)`（throw；t7 起由 `config.ts` 导出）/
 *    `sectionMetaOf(value)`（null）。
 *
 * 注意：本模块的分区 id 联合仍在 `types.ts`（保持对既有 import 路径零破坏）；本文件只依赖它的类型。
 */
import type { SectionId } from './types.ts';

/** 分区可移植性：portable 默认进导出/同步；deviceSpecific 仅本机有意义；platformSpecific 跨平台需映射/重配 */
export type SectionPortability = 'portable' | 'deviceSpecific' | 'platformSpecific';

/**
 * 分区风险等级（驱动同步「自动应用 vs 待审」分流，原 sync/risk.ts 的 RiskTier）。
 * low = 无冲突时自动应用；medium = 待审；high = 永不自动。
 * 这是**产品决策**，因此与其它分区事实一样必须逐分区显式表态（t34 起并入 SectionMeta）。
 */
export type SectionRiskTier = 'low' | 'medium' | 'high';

/**
 * 同步准入档位（见 \`SectionMeta.syncOptIn\`）：
 * 'off' = 不进同步通道；'manual' = 显式勾选且**只跟随手动 push/pull**；
 * 'auto' = 显式勾选后手动与自动同步都带。
 */
export type SectionSyncOptIn = 'off' | 'manual' | 'auto';

/**
 * 分区载荷形态（决定 ZIP 内表示 + 结构校验方式）。
 * 判别联合 + 穷尽 switch = 新增载荷形态会在编译期被 `validateSectionData` 发现。
 */
export type SectionPayload =
  /** 无 ZIP 载荷：值走独立加密容器（secrets 的 `.credentials.yaml` / `secrets.enc`），不进分区 JSON */
  | { readonly kind: 'none' }
  /** namespaces 映射（settings / ui）：每项需 revision / value / secrets 形状 */
  | { readonly kind: 'namespaces'; readonly zipPath: string }
  /** 顶层对象（providers）：`obj[key]` 必须是对象 */
  | { readonly kind: 'object'; readonly zipPath: string; readonly key: string }
  /** 顶层数组（plugins / mcp / prompts / workspaces / credentialsStatus）：`obj[key]` 必须是数组 */
  | {
    readonly kind: 'array';
    readonly zipPath: string;
    readonly key: string;
    /** 额外必须为数组的字段（存在时校验；plugins 的 `patch`） */
    readonly extraArrayKeys?: readonly string[];
    /** 是否逐项校验 `patchFiles`（相对路径安全 + base64 字符串；issue #35 的路径穿越防线） */
    readonly validatePatchFiles?: boolean;
  }
  /** 文件集合（skills / agentPresets / agentInstructions / pluginFiles / sessions / self）：`files` 必须是数组 */
  | { readonly kind: 'files'; readonly filePrefix: string };

/**
 * 导出分类目录的分组 id（Custom Export 树；id 集合必须能赋给 `ui/types.ts` 的 `ExportGroup`——
 * 这里只列**有分区归属**的组，`automation`（DSH 无对应配置）故意不在其中）。
 * 就地定义而不 import：本模块受「唯一 import 必须是 type { SectionId }」的静态守卫约束
 * （registry.test.ts 的零依赖用例 + client bundle 自包含铁律）。
 */
export type SectionExportGroup =
  | 'general' | 'ai' | 'extensions' | 'mcp' | 'customization'
  | 'workspace' | 'ui' | 'optional';

/** 单个分区的元数据 —— 同一事实的唯一落点 */
export interface SectionMeta {
  /** 分区 id（与 manifest.sections 键、ZIP 内布局一一对应） */
  readonly id: SectionId;
  /**
   * 分区显示名（英文规范名，与 client 字典 `section.<id>` 的 en 值逐字一致）。
   * **唯一来源**：adapter 的 `displayName` 与 `ui/export-flow.ts` 的 `ExportCategory.label`
   * 都从这里派生 —— 此前三处各写一份，且 credentialsStatus 已经漂移
   * （adapter 写 'Credentials'，目录写 'Credentials Status'）。UI 显示名仍只经
   * `client/common/section-labels.ts` 的 i18n 映射，本字段供报告文本 / 日志 / 消息使用。
   */
  readonly displayName: string;
  /** 导出分类目录的分组（Custom Export 树的分组归属；顺序由 EXPORT_GROUPS 决定） */
  readonly group: SectionExportGroup;
  /** ZIP 内表示 + 结构校验描述符 */
  readonly payload: SectionPayload;
  /** 分区载荷版本（第二条版本轴，独立于 bundle `CURRENT_SCHEMA_VERSION`） */
  readonly dataVersion: number;
  /** 应用/遍历顺序（导入写盘与报告顺序；= 历史 `SECTION_IDS` 顺序，保持行为等价） */
  readonly applyOrder: number;
  /** 可移植性（同步/分享/市场据此过滤） */
  readonly portability: SectionPortability;
  /**
   * 同步准入档位（非 portable 分区的显式准入；portable 分区恒为 'off'，走默认通道）。
   *  - 'off'    = 永不进入同步通道；
   *  - 'manual' = 必须用户在同步分区弹窗里显式勾选，且**只跟随用户驱动的手动 push/pull**；
   *               自动同步永不带（内容隐私 / 设备相关，例如 sessions）；
   *  - 'auto'   = 用户显式勾选后，手动与自动同步都带（内容可跨机，只是命令 / 路径可能与
   *               目标机不同，例如 mcp）。
   * **必填**（Record<SectionId, SectionMeta> 强制）：新增分区漏填即 tsc 报错。
   */
  readonly syncOptIn: SectionSyncOptIn;
  /** 快速导出（Quick Export）默认勾选（deviceSpecific 分区即使 true 也不会被推荐） */
  readonly defaultIncluded: boolean;
  /**
   * 同步风险等级（t34 起并入）：low = 无冲突时自动应用；medium / high = 待审。
   * **必填** —— 新增分区漏填即编译失败（Record<SectionId, SectionMeta> 强制），
   * 不存在「默认 low」之类的静默兜底（那会让新分区被自动应用，是安全侧最坏结果）。
   */
  readonly riskTier: SectionRiskTier;
  /**
   * 是否进入**配置状态向量**（灾备 / Phase 1 的自动快照与撤销-重做采集口径）。
   *
   * false = 该分区的体量由**内容数据**主导（当前仅 sessions，真机实测 476 MB），
   * 不属于「配置」：采进快照必然撞上 64 MiB 上限，使整条灾备链路持续失败
   * （v0.1.59 因此把灾备整体下线）。**必填** —— 新增分区必须显式表态，
   * 与 riskTier 同一纪律（缺项即 tsc 报错，不存在静默默认）。
   */
  readonly configSnapshot: boolean;
}

/** 分区载荷版本：当前 17 个分区统一为 1（唯一字面量；分区可独立升级时只改对应条目的引用） */
export const SECTION_DATA_VERSION = 1 as const;

/**
 * 分区注册表（**Record<SectionId, SectionMeta>**：漏注册/写错 id → 编译失败）。
 *
 * 字段来源（改动前分散在多处，现已收敛到此处）：
 *  - `zipPath` / `filePrefix` ← config.ts 的 SECTION_JSON_PATHS / SECTION_FILE_PREFIXES；
 *  - `portability` / `defaultIncluded` ← 各 adapter 的 `portability` / `defaultIncluded`，
 *    以及 `ui/export-flow.ts` 的内置目录、`market/prepare.ts` 的 SECTION_PORTABILITY
 *    （三者此前必须人工保持一致，现以本表为源）；
 *  - `syncOptIn` ← **本表声明**（mcp='auto' / sessions='manual' / 其余 'off'），
 *    `sync/sync-selection.ts` 的 OPT_IN_SYNC_SECTIONS 与 `AUTO_SYNC_OPT_IN_SECTION_IDS` 都是它的派生视图
 *    （此前是两份手写字面量、零护栏 —— issue #78 收敛为单一事实源）；
 *  - `applyOrder` ← 历史 SECTION_IDS 数组顺序（1 起，连续）。
 */
export const SECTION_REGISTRY: Record<SectionId, SectionMeta> = {
  settings: {
    id: 'settings',
    displayName: 'Settings',
    group: 'general',
    payload: { kind: 'namespaces', zipPath: 'config/settings.json' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 1,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  ui: {
    id: 'ui',
    displayName: 'UI Preferences',
    group: 'ui',
    payload: { kind: 'namespaces', zipPath: 'config/ui.json' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 2,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  providers: {
    id: 'providers',
    displayName: 'Providers & Models',
    group: 'ai',
    payload: { kind: 'object', zipPath: 'ai/providers.json', key: 'providers' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 3,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  plugins: {
    id: 'plugins',
    displayName: 'Plugin list',
    group: 'extensions',
    payload: {
      kind: 'array', zipPath: 'plugins/plugins.json', key: 'plugins',
      extraArrayKeys: ['patch'], validatePatchFiles: true,
    },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 4,
    riskTier: 'medium',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  mcp: {
    id: 'mcp',
    displayName: 'MCP Servers',
    group: 'mcp',
    payload: { kind: 'array', zipPath: 'mcp/servers.json', key: 'servers' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 5,
    riskTier: 'medium',
    portability: 'platformSpecific',
    // issue #78：MCP 行只写 patch 行（导入期按层写回），按包安装的 stdio server
    // （npx / uvx / pipx）配置本身可跨机 —— 只是命令 / cwd 可能与目标机不同，
    // 由导入分析期 warning 提示。用户显式勾选后，手动与自动同步都带。
    syncOptIn: 'auto',
    defaultIncluded: true,
    configSnapshot: true,
  },
  prompts: {
    id: 'prompts',
    displayName: 'Prompts',
    group: 'customization',
    payload: { kind: 'array', zipPath: 'custom/prompts.json', key: 'prompts' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 6,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  skills: {
    id: 'skills',
    displayName: 'Skills',
    group: 'customization',
    payload: { kind: 'files', filePrefix: 'custom/skills/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 7,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  agentPresets: {
    id: 'agentPresets',
    displayName: 'Agent Presets',
    group: 'customization',
    payload: { kind: 'files', filePrefix: 'agents/presets/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 8,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  agentInstructions: {
    id: 'agentInstructions',
    displayName: 'Agent Instructions',
    group: 'customization',
    payload: { kind: 'files', filePrefix: 'custom/agent-instructions/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 9,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  workspaces: {
    id: 'workspaces',
    displayName: 'Workspaces',
    group: 'workspace',
    payload: { kind: 'array', zipPath: 'workspaces/workspaces.json', key: 'workspaces' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 10,
    riskTier: 'medium',
    portability: 'platformSpecific',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  pluginFiles: {
    id: 'pluginFiles',
    displayName: 'Plugin config files',
    group: 'extensions',
    payload: { kind: 'files', filePrefix: 'plugin-files/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 11,
    riskTier: 'high',
    portability: 'deviceSpecific',
    syncOptIn: 'off',
    defaultIncluded: false,
    configSnapshot: true,
  },
  credentialsStatus: {
    id: 'credentialsStatus',
    displayName: 'Credentials Status',
    group: 'optional',
    payload: { kind: 'array', zipPath: 'security/credentials.json', key: 'credentials' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 12,
    riskTier: 'high',
    portability: 'deviceSpecific',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  secrets: {
    // 无 adapter、无 ZIP 内分区 JSON：凭据值走独立加密容器（导出侧 .credentials.yaml + secrets.enc）
    id: 'secrets',
    displayName: 'Secrets',
    group: 'optional',
    payload: { kind: 'none' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 13,
    riskTier: 'high',
    portability: 'deviceSpecific',
    syncOptIn: 'off',
    defaultIncluded: false,
    configSnapshot: false,
  },
  sessions: {
    id: 'sessions',
    displayName: 'Sessions',
    group: 'optional',
    payload: { kind: 'files', filePrefix: 'sessions/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 14,
    riskTier: 'high',
    portability: 'deviceSpecific',
    syncOptIn: 'manual',
    defaultIncluded: false,
    configSnapshot: false,
  },
  self: {
    id: 'self',
    displayName: 'Config Manager settings',
    group: 'extensions',
    payload: { kind: 'files', filePrefix: 'self/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 15,
    riskTier: 'low',
    portability: 'portable',
    syncOptIn: 'off',
    defaultIncluded: true,
    configSnapshot: true,
  },
  pluginData: {
    id: 'pluginData',
    displayName: 'Plugin data dirs',
    group: 'extensions',
    payload: { kind: 'files', filePrefix: 'plugin-data/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 16,
    riskTier: 'high',
    // 第三方插件的数据目录不在 DSH 的三个核心存储里：路径是「机器的 home 布局」而非配置内容，
    // 换机后可能整个目录不存在（未安装该插件）→ deviceSpecific + 不参与自动同步。
    portability: 'deviceSpecific',
    syncOptIn: 'off',
    defaultIncluded: false,
    // 体量由用户数据主导（可能几百 MB），与 sessions 同理不进「配置状态」采集口径
    configSnapshot: false,
  },
  pluginAssets: {
    id: 'pluginAssets',
    displayName: 'Plugin large files',
    group: 'extensions',
    payload: { kind: 'files', filePrefix: 'plugin-assets/' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 17,
    riskTier: 'high',
    portability: 'deviceSpecific',
    syncOptIn: 'off',
    defaultIncluded: false,
    configSnapshot: false,
  },
};

/** 分区 id（按 applyOrder 升序）——历史上与 SECTION_IDS 数组逐项一致 */
export const SECTION_IDS: readonly SectionId[] = (Object.keys(SECTION_REGISTRY) as SectionId[])
  .sort((a, b) => SECTION_REGISTRY[a].applyOrder - SECTION_REGISTRY[b].applyOrder);

/** 运行时安全查找：未注册 / 非字符串 → null（不抛错，供调用方自己决定如何报错） */
export function sectionMetaOf(value: unknown): SectionMeta | null {
  if (typeof value !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(SECTION_REGISTRY, value)) return null;
  return SECTION_REGISTRY[value as SectionId];
}

/** 类型安全的元数据读取（id 已是 SectionId） */
export function sectionMeta(id: SectionId): SectionMeta {
  return SECTION_REGISTRY[id];
}

/** 该 id 是否是已注册分区（运行期守卫；配合 manifest 的未知键告警使用） */
export function isSectionId(value: unknown): value is SectionId {
  return sectionMetaOf(value) !== null;
}

/** ZIP 内 JSON 分区路径（null = 该分区无 JSON 载荷：文件类分区 / secrets） */
export function jsonPathOf(id: SectionId): string | null {
  const p = SECTION_REGISTRY[id].payload;
  return p.kind === 'files' || p.kind === 'none' ? null : p.zipPath;
}

/** 文件类分区在 ZIP 内的目录前缀（null = 非文件类分区） */
export function filePrefixOf(id: SectionId): string | null {
  const p = SECTION_REGISTRY[id].payload;
  return p.kind === 'files' ? p.filePrefix : null;
}

/** 是否「文件类」分区（ZIP 内以真实文件存放而非单个 JSON） */
export function isFileSection(sectionId: SectionId): boolean {
  return SECTION_REGISTRY[sectionId].payload.kind === 'files';
}

/** JSON 分区在 ZIP 内的相对路径表（派生自注册表；文件类分区与 secrets 不在表内） */
export const SECTION_JSON_PATHS: Partial<Record<SectionId, string>> = Object.fromEntries(
  SECTION_IDS
    .map((id) => [id, jsonPathOf(id)] as const)
    .filter((entry): entry is readonly [SectionId, string] => entry[1] !== null),
) as Partial<Record<SectionId, string>>;

/** 文件类分区在 ZIP 内的目录前缀表（派生自注册表） */
export const SECTION_FILE_PREFIXES: Partial<Record<SectionId, string>> = Object.fromEntries(
  SECTION_IDS
    .map((id) => [id, filePrefixOf(id)] as const)
    .filter((entry): entry is readonly [SectionId, string] => entry[1] !== null),
) as Partial<Record<SectionId, string>>;

/** 可移植分区（同步/分享默认候选） */
export const PORTABLE_SECTION_IDS: readonly SectionId[] = SECTION_IDS.filter(
  (id) => SECTION_REGISTRY[id].portability === 'portable',
);

/**
 * 同步「可选分区」：非 portable、必须推/拉两侧显式放行的分区（syncOptIn !== 'off'）。
 * 当前 = ['mcp', 'sessions']。**顺序按 applyOrder**（mcp=5 在 sessions=14 之前）。
 */
export const OPT_IN_SYNC_SECTION_IDS: readonly SectionId[] = SECTION_IDS.filter(
  (id) => SECTION_REGISTRY[id].syncOptIn !== 'off',
);

/**
 * 「可选分区」里**允许参与自动同步**的子集（syncOptIn === 'auto'）。
 *
 * 为什么必须单独一档：可选分区的准入理由不同 ——
 *  - sessions 是**内容隐私 / 设备相关**（high 风险，自动同步绝不带，绝不悄悄下行会话）；
 *  - mcp 只是**命令 / 路径可能与目标机不同**（medium 风险，用户勾了就该跟着自动同步走）。
 * 用一个布尔没法表达这层差别，会退化成「勾了 mcp 顺带放行 sessions」。
 */
export const AUTO_SYNC_OPT_IN_SECTION_IDS: readonly SectionId[] = SECTION_IDS.filter(
  (id) => SECTION_REGISTRY[id].syncOptIn === 'auto',
);

/** 快速导出默认勾选的分区（deviceSpecific 仍需 UI 就地警示，见 export-flow） */
export const DEFAULT_INCLUDED_SECTION_IDS: readonly SectionId[] = SECTION_IDS.filter(
  (id) => SECTION_REGISTRY[id].defaultIncluded,
);

/**
 * 「配置类分区」的口径（`configSnapshot=true` 的成员）。
 *
 * 与导出口径**刻意不同**：导出要的是「这台机器的完整可迁移状态」，而配置状态只是一小块；
 * 内容数据类分区（sessions，真机 476 MB）属于用户数据，不属于配置状态。
 *
 * **当前无消费者**：这组口径原本服务灾备的自动快照 / 撤销-重做，而灾备快照线已按产品定位
 * 收敛下线（定位 = 迁移 / 同步 / 市场，只保留崩溃归因 + 救援模式）。字段与清单保留为分区的
 * 语义声明（配置类 vs 内容数据类），未来任何状态类功能可直接复用；新增分区若体量由用户数据
 * 主导，把它的 `configSnapshot` 置 false。
 */
export const CONFIG_SNAPSHOT_SECTION_IDS: readonly SectionId[] = SECTION_IDS.filter(
  (id) => SECTION_REGISTRY[id].configSnapshot,
);
