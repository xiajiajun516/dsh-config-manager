/**
 * 远程同步区块的纯渲染模型（m-sync-ui）。
 *
 * 与 src/ui/progress.ts → progress-view.ts 同模式：把「报告怎么渲染 / 按钮什么状态 /
 * 状态行写什么 / 私有仓库提示怎么展示」做成无副作用纯函数，node --test 直接测，
 * React 组件只做装配。文案直接用中文（项目源语言），组件不重复造。
 */
import type { PlanItem, PlanItemKind } from '../../core/types.ts';
import type { SectionId } from '../../schema/types.ts';
import type { PullChange, SyncPullReport, SyncPushPreview, SyncPushReport } from '../../sync/sync-engine.ts';
import { DEFAULT_CATEGORIES } from '../../ui/export-flow.ts';
import { EXPORT_GROUPS, type ExportGroup } from '../../ui/types.ts';
import type {
  ApplyItemsResponse, AutosyncInterval, AutosyncStatusResponse, GithubPollResponse, SyncConfirmItem, SyncSelectionPayload,
  SyncItemAdoption, SyncSectionInfo, SyncSnapshotLite, SyncStatusResponse,
} from './sync-api.ts';
// 通道枚举的唯一声明处（**零依赖**，可被浏览器半运行时 import）：加一条通道只改这里一处。
import { SYNC_CHANNELS } from '../../utils/shared-constants.ts';
// zh 源目录按**值**引入：本文件的渲染模型（UiT 字典不含 syncflow.* 键）需要为「回滚未完成」
// 这类 sync 命名空间文案取词；组件可经 syncText 参数注入自己的翻译器（缺省 = zh 源）。
import { en as syncEnCatalog, zh as syncZhCatalog, type SyncKey } from './sync-locales.ts';
// 跳过原因码 → 字典键的唯一映射（与同步历史共用；绝不各自维护一份 switch）
import { skipReasonKey } from './history-model.ts';
import type { CloudConfigIssueCode } from '../../ui/sync-settings-view.ts';
import type { S3CompatProvider } from '../../sync/sync-config.ts';
import { currentUiLanguage, type UiT } from '../../ui/i18n.ts';

/* ---------------------------------------------------------------- 私有仓库提示 */

/**
 * 私有仓库强制提示文案（Settings 区块常驻警示横幅）。
 * 安全约束：同步内容为可移植配置，public 仓库会公开配置 → 必须私有；
 * token 仅用于认证，绝不写入同步文件/提交内容/日志。
 */
/**
 * http(s) 的 git 远端**必须有访问令牌才能推送**（拉取公开仓库可以匿名完成 —— 这正是
 * 「拉取成功、推送失败」这条用户报告的不对称来源）。用于在通道卡上提示「未配置令牌」；
 * 本地路径 / ssh 远端走 git 原生认证，不该提示。
 */
export function needsGitToken(repoUrl: string): boolean {
  return /^https?:\/\//i.test(repoUrl.trim());
}

export function privateRepoHint(t: UiT): string {
  return t('sync.privateRepoHint');
}

/* ---------------------------------------------------------------- 同步分区模式 */

/** 远程同步模式：默认（快速导出） / 高级（自定义导出）。 */
export type SyncMode = 'default' | 'advanced';

/** 可同步分区选项（status.syncSections 投影 + 导出目录补充分组/描述；高级模式勾选目录单选项）。 */
export interface SyncSectionOption {
  id: SectionId;
  label: string;
  /** 一句话描述（来自导出目录；未知 id 为空串） */
  description: string;
  /** 所属导出分组（General / AI / Extensions / …；未知 id 兜底 'general'） */
  group: ExportGroup;
  portability: 'portable' | 'deviceSpecific' | 'platformSpecific';
  /** 是否为推荐分区（defaultIncluded=true；默认模式全选、高级模式初始勾选） */
  defaultIncluded: boolean;
}

/** host 目录（SyncSectionInfo[]）→ UI 勾选项（保留 id 顺序）。
 *  同步分区必为导出目录（DEFAULT_CATEGORIES）的可移植子集：分组/描述从导出目录
 *  补充（单一事实源，与「导出备份·自定义模式」的目录保持一致），未命中 id 兜底。 */
export function syncSectionOptions(info: readonly SyncSectionInfo[], t: UiT): SyncSectionOption[] {
  const meta = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c]));
  return info.map((s) => {
    const cat = meta.get(s.id);
    return {
      id: s.id,
      label: s.displayName,
      // 描述是**字典键**（英文界面零中文）：在这里按当前语言解析，渲染层直接显示
      description: cat !== undefined ? t(cat.descriptionKey) : '',
      group: cat?.group ?? 'general',
      portability: s.portability,
      defaultIncluded: s.defaultIncluded,
    };
  });
}

/** 高级模式勾选目录 → 按导出分组（EXPORT_GROUPS）投影：与「导出备份·自定义模式」同构，
 *  空分组省略；UI 直接渲染 groupCard。 */
export function syncSectionGroups(options: readonly SyncSectionOption[], t: UiT): {
  group: ExportGroup;
  label: string;
  note?: string;
  items: SyncSectionOption[];
}[] {
  return EXPORT_GROUPS
    .map((g) => ({
      group: g.id,
      label: g.label,
      ...(g.noteKey !== undefined ? { note: t(g.noteKey) } : {}),
      items: options.filter((o) => o.group === g.id),
    }))
    .filter((g) => g.items.length > 0);
}

/**
 * sessions（历史会话）分区同步「最新 N 个会话」的默认值。
 *
 * 与宿主半 src/sync/sync-selection.ts 的 DEFAULT_SYNC_SESSIONS_LIMIT 同值（客户端 bundle
 * 不能 import 宿主模块，故沿用 SYNC_CREDENTIAL_REF 那套「两处同值」的做法）。
 * 历史会话内容敏感，**默认只带最新 5 个**，避免一次把整棵会话树推上远端。
 */
export const DEFAULT_SYNC_SESSIONS_LIMIT = 5

/** sessionsLimit 归一化（与宿主同口径）：非整数 / 负数 → 默认值；上限 10000。 */
export function normalizeSessionsLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return DEFAULT_SYNC_SESSIONS_LIMIT
  return Math.min(value, 10000)
}

/** 推荐同步分区：可移植且默认包含（与 ExportFlow.quickSelection 同口径）。 */
export function recommendedSyncSections(info: readonly SyncSectionInfo[]): SectionId[] {
  return info.filter((s) => s.portability === 'portable' && s.defaultIncluded).map((s) => s.id);
}

/**
 * 载入时的同步分区初始值（分区弹窗「首次打开」预勾选推荐分区）。
 *
 * 三条规则，必须区分「从没配过」与「用户主动清空」：
 *  - 无持久化（缺省 undefined）或旧 default 模式 → **预勾选推荐分区**
 *    （升级后同步范围不缩水，也不用先配一遍才能用）；
 *  - advanced + 非空勾选 → 原样保留用户的选择；
 *  - advanced + **空勾选** → 保留为空（这是用户主动清空的选择，不能被悄悄填回来，
 *    由「请至少勾选一个同步分区」提示 + 禁用推送兜底）。
 */
export function initialSyncSections(
  selection: Pick<SyncSelectionPayload, 'mode' | 'sections'> | undefined,
  catalog: readonly SyncSectionInfo[],
): SectionId[] {
  if (selection === undefined || selection.mode !== 'advanced') return recommendedSyncSections(catalog)
  return [...selection.sections]
}

/* ---------------------------------------------------------------- 变更摘要 */

/** 需要人工决策的 PlanItem 类型（与 SyncEngine.pull 的 needsReview 判定一致）。
 * 注意：'Install' 不在此列 —— 插件安装随同步自动采用（product requirement）。 */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error',
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
export function kindLabel(kind: PlanItemKind, t: UiT): string {
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
export function severityLabel(severity: PlanItem['severity'], t: UiT): string {
  switch (severity) {
    case 'error': return t('sync.severity.error');
    case 'warning': return t('sync.severity.warning');
    default: return t('sync.severity.info');
  }
}

/* ---------------------------------------------------------------- 按钮状态 */

/**
 * 远程同步通道类型（**由 SYNC_CHANNELS 单一事实源派生**：git | webdav | s3 | gist）。
 *
 * 通道枚举的声明处 = `src/utils/shared-constants.ts`（**零依赖**：浏览器半可运行时 import，
 * 打包后就是内联字符串，不会把 node:fs / node:path 带进 client bundle —— bundle 自包含铁律）。
 * 宿主 `sync-config.ts` 只是 re-export 它，因此「加一条通道」只改声明处一处。
 *
 * 历史：本文件曾维护 `CLIENT_SYNC_CHANNELS`（已接线）+ `PENDING_CLIENT_SYNC_CHANNELS`（待接线）
 * 两份手维护清单，并靠 `UncoveredChannel` 穷尽检查防漂移；t12 把 s3 / gist 接线后两份清单都不再
 * 需要 —— 直接派生既没有漂移面，也不必再维护镜像（下一句注释曾经的理由也已随枚举搬迁而失效）。
 */
export type SyncChannel = (typeof SYNC_CHANNELS)[number];

/** 客户端通道清单（= 共享常量本身；UI 构造 Record / 遍历时取它，避免各处再写一遍数组） */
export const SYNC_CHANNEL_ORDER: readonly SyncChannel[] = SYNC_CHANNELS;

/** 通道值守卫（localStorage / 宿主原值等原始输入）。 */
export function isClientChannel(value: unknown): value is SyncChannel {
  return typeof value === 'string' && (SYNC_CHANNELS as readonly string[]).includes(value);
}

/**
 * 通道显示名 → 字典键。全量 `Record<SyncChannel, SyncKey>`：新增通道而漏配文案 = **编译期错误**
 * （而不是界面上冒出一个裸键）。
 */
export const SYNC_CHANNEL_LABEL_KEY: Record<SyncChannel, SyncKey> = {
  git: 'channel.git',
  webdav: 'channel.webdav',
  s3: 'channel.s3',
  gist: 'channel.gist',
};

/**
 * S3 兼容商 → 显示名字典键（全量 Record：宿主新增兼容商而这里漏配 = 编译期错误；
 * 兼容商清单的穷尽检查在 `src/ui/sync-settings-view.ts` 的 `S3_PROVIDERS`）。
 */
export const S3_PROVIDER_LABEL_KEY: Record<S3CompatProvider, SyncKey> = {
  s3: 'cloud.provider.s3',
  oss: 'cloud.provider.oss',
  cos: 'cloud.provider.cos',
  minio: 'cloud.provider.minio',
  kodo: 'cloud.provider.kodo',
};

/**
/**
 * 云端点密钥槽位引用名（**仅供提示文案显示**；值的读写全在宿主）。
 *
 * t88：**不再本地镜像** —— 声明处与派生实现都在零依赖的 utils/shared-constants.ts
 * （与宿主 sync-config.ts 的 cloudSecretRef() 读同一张表），本文件只 re-export，
 * 既有 import 路径（./sync-view.ts）不变；结构守卫见 sync/sync-config.test.ts 的 t88。
 */
export { cloudSecretRefName } from '../../utils/shared-constants.ts';

/**
 * 云端点校验码 → 字典键（键名与码同名，形如 `cloud.endpointRequired`）。
 *
 * 码的声明处是宿主 `sync-config.ts` 的 `CloudConfigIssueCode`（类型透传到 ui 模块）。本表是
 * **全量 Record**：宿主新增码而这里漏配文案即编译失败；宿主 400 响应里的 `body.code` 也经
 * `cloudIssueKey()` 查到同一条文案，绝不把裸码渲染给用户。
 */
/**
 * 类型化码之外的**运行期码**：路由层 `cloudCredentialWriteError` 用 `cloud.credentialsWriteFailed`
 * 表达「密钥写进 DSH 凭据失败」，但它不在宿主 `CloudConfigIssueCode` 联合里（那是配置校验码）。
 * 单独并进来，既不削弱对类型化码的穷尽检查，也不让界面渲染出裸码。
 */
type ExtraCloudIssueCode = 'cloud.credentialsWriteFailed'

export const SYNC_CLOUD_ISSUE_KEY: Record<CloudConfigIssueCode | ExtraCloudIssueCode, SyncKey> = {
  'cloud.providerUnknown': 'cloud.providerUnknown',
  'cloud.endpointRequired': 'cloud.endpointRequired',
  'cloud.endpointInvalid': 'cloud.endpointInvalid',
  'cloud.endpointUserinfo': 'cloud.endpointUserinfo',
  'cloud.regionRequired': 'cloud.regionRequired',
  'cloud.bucketRequired': 'cloud.bucketRequired',
  'cloud.bucketInvalid': 'cloud.bucketInvalid',
  'cloud.prefixInvalid': 'cloud.prefixInvalid',
  'cloud.accessKeyIdRequired': 'cloud.accessKeyIdRequired',
  'cloud.gistIdRequired': 'cloud.gistIdRequired',
  'cloud.gistIdInvalid': 'cloud.gistIdInvalid',
  'cloud.apiBaseUrlInvalid': 'cloud.apiBaseUrlInvalid',
  'cloud.secretWriterRequired': 'cloud.secretWriterRequired',
  'cloud.credentialsWriteFailed': 'cloud.credentialsWriteFailed',
};

/** 宿主错误码 → 字典键；未知码（未来版本 / 第三方宿主）→ null，调用方回退展示原始码。 */
export function cloudIssueKey(code: string): SyncKey | null {
  return Object.prototype.hasOwnProperty.call(SYNC_CLOUD_ISSUE_KEY, code)
    ? (SYNC_CLOUD_ISSUE_KEY[code as CloudConfigIssueCode | ExtraCloudIssueCode] ?? null)
    : null;
}

/* ------------------------------------------------ G-34：gist 通道不适合大分区 */

/**
 * G-34（docs/spec/known-gaps.md）：gist 通道**刻意不做内容寻址外置** —— 一次 GET 把全部
 * 文件内容取回、单文件内容超限会被截断、文件数还有上限，因此会话这类大分区不适合走 gist。
 *
 * 本常量 = 「gist 表单」常驻提示的字典键（组件按它取 sync 字典文案渲染 hint）。
 */
export const GIST_LARGE_SECTION_HINT_KEY: SyncKey = 'cloud.gistLargeSectionHint'

/**
 * 「通道 = gist 且勾选 sessions」时的风险提示键；不满足 → null。
 *
 * 只做判定、不渲染、**不改选择器逻辑**（不阻止勾选、不动勾选集合）—— 组件拿到非 null 时
 * 用 sync 字典渲染一条 warn Banner（复用既有 hint / Banner 机制，不新增设置项与样式）。
 */
export function gistSessionsRiskKey(channel: SyncChannel, sections: readonly SectionId[]): SyncKey | null {
  return channel === 'gist' && sections.includes('sessions') ? 'mode.gistSessionsWarn' : null
}

/**
 * 按通道构造 `Record<SyncChannel, T>`（缺省值由 `make` 给出）。
 *
 * 为什么要有它：`{ git: …, webdav: … }` 这种手写字面量在加通道时会**静默少一项**
 * （索引到 undefined 才炸，且往往炸在很远的地方）。遍历枚举构造则天然覆盖全部通道。
 */
export function channelMapOf<T>(make: (channel: SyncChannel) => T): Record<SyncChannel, T> {
  const out = {} as Record<SyncChannel, T>
  for (const channel of SYNC_CHANNEL_ORDER) out[channel] = make(channel)
  return out
}

/* ---------------------------------------------------------------- 每通道独立状态 */

/**
 * 每个同步通道（git/webdav）各自独立的设置状态：
 * 自动同步、同步分区勾选、是否加密、远端快照互不共享。
 * 敏感字段（加密/解密密码）仅内存：成功后清空，绝不持久化/回显。
 */
export interface ChannelSyncState {
  /**
   * 同步模式（**宿主 schema 字段；UI 已无「默认/自定义」之分**）。
   *
   * 2026-09 起同步分区恒由用户在弹窗里手动勾选 → 客户端落盘恒为 'advanced'
   * （宿主语义：只同步勾选分区）。'default' 只为旧持久化载荷与宿主 schema 保留。
   */
  syncMode: SyncMode
  /** 勾选的同步分区（初始 = 推荐分区；空 = 未勾选任何分区） */
  syncSections: SectionId[]
  /** sessions 分区「最新 N 个会话」上限（持久化；缺省 5，仅勾选 sessions 时生效） */
  sessionsLimit: number
  /** 显式点名的会话单元 id（持久化；非空时优先于 sessionsLimit，空 = 「最新 N 个」模式） */
  sessionsInclude: string[]
  /** 手动推送默认加密快照（持久化开关；密码不持久化） */
  encrypt: boolean
  /** 手动推送默认导出真实凭据值（持久化开关；必须同时 encrypt） */
  includeSecrets: boolean
  /** 加密密码输入框（仅内存；已保存的密码在 DSH 凭据库里，不回显） */
  encryptPassword: string
  /** 加密密码确认（仅内存） */
  encryptPasswordConfirm: string
  /** 解密密码输入框（仅内存；已保存的密码在 DSH 凭据库里，不回显） */
  decryptPassword: string
  /**
   * 加密备份密码是否已保存在本机凭据库（DSH credentials；只回布尔，值永不回传浏览器）。
   * 为 true 时输入框留空即表示「沿用已保存密码」，不再要求重新输入。
   */
  encryptPasswordSaved: boolean
  /** 解密密码是否已保存在本机凭据库（同上；用户点「删除已保存密码」才清除） */
  decryptPasswordSaved: boolean
  /** 当前选中的历史快照 id（'' = 最新） */
  selectedSnapshotId: string
  /** 该通道远端历史快照列表（「选择历史快照」下拉数据源） */
  snapshots: SyncSnapshotLite[]
  /**
   * 远端**存在但读不出来**的快照（issue #59；列表跳过是必要防御，但必须可见）。
   * 非空即代表「这个列表不完整」—— 与 `snapshots` 同一次 list 请求的结果。
   */
  unreadableSnapshots: { file: string; reason: string }[]
  /** 该通道是否正在拉取远端快照列表 */
  loadingSnapshots?: boolean
  /** 该通道自动同步状态 */
  autosync: AutosyncStatusResponse | null
  /** 该通道自动同步开关（回填自 autosync） */
  autosyncEnabled: boolean
  /** 该通道自动同步间隔（回填自 autosync） */
  autosyncInterval: AutosyncInterval
  /** 本地改动即时触发（回填自 autosync；缺省 true —— 真·自动同步的开关） */
  autosyncRealtime: boolean
}

/** 四通道的缺省状态表（`Record<SyncChannel, ChannelSyncState>`；组件 state 与快照复制共用）。 */
export function channelStateMap(): Record<SyncChannel, ChannelSyncState> {
  return channelMapOf(() => defaultChannelSyncState())
}

/** 缺省每通道状态（未配置时各字段默认值）。 */
export function defaultChannelSyncState(): ChannelSyncState {
  return {
    // 恒为 advanced：勾选集合就是同步范围（详见 ChannelSyncState.syncMode 注释）
    syncMode: 'advanced',
    syncSections: [],
    sessionsLimit: DEFAULT_SYNC_SESSIONS_LIMIT,
    sessionsInclude: [],
    encrypt: false,
    includeSecrets: false,
    encryptPassword: '',
    encryptPasswordConfirm: '',
    decryptPassword: '',
    encryptPasswordSaved: false,
    decryptPasswordSaved: false,
    selectedSnapshotId: '',
    snapshots: [],
    unreadableSnapshots: [],
    loadingSnapshots: false,
    autosync: null,
    autosyncEnabled: false,
    autosyncInterval: '30m',
    autosyncRealtime: true,
  }
}

/* ---------------------------------------------------------------- 通道选择持久化 */

/** 记住用户最近选择的通道（localStorage key；跨会话保持在用户上次所在栏）。
 *  m-self：磁盘持久化（ui-prefs.json）为权威来源（Host 可读、随 self 分区进备份），
 *  localStorage 仅保留为 status 响应未带回填时的同步降级通道（升级前遗留数据兼容）。 */
export const SYNC_CHANNEL_STORAGE_KEY = 'dsh.configManager.syncChannel';

/** 从 localStorage 读用户记住的通道；无/非法 → null（缺省 git，交由配置回填）。
 *  浏览器环境走 globalThis.localStorage；node 测试注入 mock storage 或返回 null。 */
export function readStoredChannel(storage?: Pick<Storage, 'getItem'> | null): SyncChannel | null {
  const s = storage ?? browserStorage();
  if (s === null) return null;
  try {
    const v = s.getItem(SYNC_CHANNEL_STORAGE_KEY);
    return isClientChannel(v) ? v : null;
  } catch {
    return null; // localStorage 不可用（隐私模式等）静默降级
  }
}

/** 把用户选择的通道写入 localStorage（记住，跨进入保持）。 */
export function writeStoredChannel(channel: SyncChannel, storage?: Pick<Storage, 'setItem'> | null): void {
  const s = storage ?? browserStorage();
  if (s === null) return;
  try {
    s.setItem(SYNC_CHANNEL_STORAGE_KEY, channel);
  } catch {
    // 静默；记住失败不阻断功能
  }
}

/** 浏览器 localStorage；非浏览器（node 测试）→ null */
function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  const g = globalThis as { localStorage?: Storage } | undefined;
  return g?.localStorage ?? null;
}

/* ---------------------------------------------------------------- WebDAV 预设 */

/** 常见 WebDAV 服务器预设：labelKey 展示名键 + url 模板（含 <占位> 待用户替换）。 */
export interface WebDavPreset {
  id: string;
  /** 展示名的**字典键**（sync 命名空间；与 SYNC_CHANNEL_LABEL_KEY / S3_PROVIDER_LABEL_KEY 同口径） */
  labelKey: SyncKey;
  /** url 模板；可能含 <server>/<user> 占位符，用户需替换为真实地址 */
  url: string;
  /** 是否需要用户替换占位符 */
  hasPlaceholder: boolean;
}

/** 内置常见 WebDAV 服务器（预设下拉数据源；第一项为自定义）。 */
export const WEBDAV_PRESETS: readonly WebDavPreset[] = [
  { id: 'custom', labelKey: 'webdav.preset.custom', url: '', hasPlaceholder: false },
  { id: 'jianguoyun', labelKey: 'webdav.preset.jianguoyun', url: 'https://dav.jianguoyun.com/dav/', hasPlaceholder: false },
  { id: 'nextcloud', labelKey: 'webdav.preset.nextcloud', url: 'https://<server>/remote.php/dav/files/<user>/', hasPlaceholder: true },
  { id: 'owncloud', labelKey: 'webdav.preset.owncloud', url: 'https://<server>/remote.php/dav/files/<user>/', hasPlaceholder: true },
  { id: 'seafile', labelKey: 'webdav.preset.seafile', url: 'https://<server>/seafdav/', hasPlaceholder: true },
  { id: 'synology', labelKey: 'webdav.preset.synology', url: 'https://<nas-ip>:5006/', hasPlaceholder: true },
  { id: 'box', labelKey: 'webdav.preset.box', url: 'https://dav.box.com/dav/', hasPlaceholder: false },
];

/** 默认预设（自定义）对应的 id。 */
export const WEBDAV_CUSTOM_PRESET_ID = 'custom';

/** 根据预设 id 取 preset；未知 id → 自定义（缺省）。 */
export function presetById(id: string): WebDavPreset {
  return WEBDAV_PRESETS.find((p) => p.id === id) ?? WEBDAV_PRESETS[0]!;
}

/** 从已填 url 反推最接近的预设 id（用于下拉回显；无匹配 → 自定义）。 */
export function presetIdForUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') return WEBDAV_CUSTOM_PRESET_ID;
  for (const p of WEBDAV_PRESETS) {
    if (!p.hasPlaceholder && p.url !== '' && trimmed.toLowerCase().startsWith(p.url.toLowerCase())) {
      return p.id;
    }
  }
  return WEBDAV_CUSTOM_PRESET_ID;
}

export interface SyncButtons {
  canPush: boolean;
  canPull: boolean;
  pushLabel: string;
  pullLabel: string;
}

/**
 * 通道「远端是否就绪」的唯一定义在 `src/ui/sync-settings-view.ts` 的 `channelRemoteReady(form)`：
 * 四条通道各自看哪些字段（git=repoUrl、webdav=url、s3=四必填、gist=gistId）属于业务判断，
 * 且云端点还要过格式校验 —— 这里**不再保留只覆盖 git/webdav 的第二份实现**（两份必然漂移）。
 */

/**
 * 按钮可用性与文案：
 * - 任一操作进行中（busy）→ 两个按钮都禁用（防并发 push/pull）；
 * - 活动通道远端地址未就绪（remoteReady=false）→ 禁用（无从同步）；
 * - busy 时按钮文案切换为「正在推送/拉取…」（配 Spinner）。
 */
export function computeSyncButtons(busy: 'sync' | 'push' | 'pull' | 'apply' | 'rollback' | null, remoteReady: boolean, t: UiT): SyncButtons {
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
  t: UiT,
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
export function formatLastSync(iso: string | undefined, t: UiT): string {
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
export function pushReportView(report: SyncPushReport | null, t: UiT): PushReportView | null {
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

/* ------------------------------------------------ P0-② push 前只读预览渲染模型 */

export interface PushPreviewView {
  ok: boolean;
  /** 将推送的分区行（含计数 + 是否相对基线有变化） */
  /** 分区 id 来自宿主 SyncPushPreviewSection.section（SectionId）——写 string 会让渲染侧被迫转型 */
  rows: { section: SectionId; count: number; changed: boolean }[];
  /** 变更分区数（要展示「新增/更新 N 个分区」） */
  changedCount: number;
  /** 远端现有快照数（0 = 首次推送创建首个基线） */
  remoteSnapshotCount: number;
  /** 加密快照提示（基线不可比） */
  encryptedHint: string;
  /** issue #38：本次推送将带上真实凭据值的提示（未带凭据时为空串） */
  credentialsHint: string;
  /** 只读提示（预览不写远端） */
  previewHint: string;
  /**
   * 引擎随预览回传的告警（分区导出失败、本地源插件未打包导致该分区无法与基线比对等）；
   * 为空串 = 无告警（不占版面）。ok 预览也需要显示它：否则「某分区导出失败已跳过」只存在于
   * 响应体里，用户看到的分区数会静静变少。
   */
  hint: string;
  headline: string;
  error: string | null;
}

/** push 预览 → 渲染模型（P0-②）：列分区 + 变更计数 + 远端基线提示。 */
export function pushPreviewView(preview: SyncPushPreview | null, t: UiT): PushPreviewView | null {
  if (preview === null) return null;
  if (!preview.ok) {
    return {
      ok: false, rows: [], changedCount: 0, remoteSnapshotCount: preview.remoteSnapshotCount,
      encryptedHint: '', credentialsHint: '', previewHint: '', hint: '', headline: '',
      error: preview.message ?? t('sync.pushFailed'),
    };
  }
  const rows = preview.sections.map((s) => ({ section: s.section, count: s.count, changed: s.changed }));
  const changedCount = preview.sections.filter((s) => s.changed).length;
  return {
    ok: true,
    rows,
    changedCount,
    remoteSnapshotCount: preview.remoteSnapshotCount,
    encryptedHint: preview.encrypted ? t('sync.pushPreviewEncrypted') : '',
    credentialsHint: preview.credentialsIncluded ? t('sync.pushPreviewCredentials') : '',
    previewHint: t('sync.pushPreviewHint'),
    hint: preview.message ?? '',
    headline: t('sync.pushPreviewHeadline', {
      total: String(preview.sections.length),
      changed: String(changedCount),
    }),
    error: null,
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
export function pullReportView(report: SyncPullReport | null, t: UiT): PullReportView | null {
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
  t: UiT,
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
export function githubPollMessage(poll: GithubPollResponse, t: UiT): string {
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

/** 需要人工决策的 PlanItemKind（与 Host /sync/sync 的 needsReview 判定对齐）。
 * 注意：'Install'（安装插件）不在其中 —— 插件安装默认自动采用（defaultAdopt=true）、
 * 不逐项展示、无需手动选择（product requirement）。 */
const CONFIRM_REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error', 'PathMapping',
  // issue #35：Warning 也进确认列表 —— 它承载「本次同步会剔除哪些无法满足的
  // patchedDependencies 声明」这类改变配置语义的信息，不能默默自动采用。
  // 与宿主 REVIEW_KINDS 必须保持一致（两处同源，勿单改一处）。
  'Warning',
]);

/**
 * 是否需要人工决策（是否进入差异确认列表）。
 * 非决策项（Create / Update / Skip 等）默认自动采用（defaultAdopt=true），
 * 不逐项展示但 apply-items 时照常导入；Warning 例外 —— 见 CONFIRM_REVIEW_KINDS。
 */
export function isReviewItem(kind: PlanItemKind): boolean {
  return CONFIRM_REVIEW_KINDS.has(kind);
}

/**
 * issue #35：会**改变工具链行为**的项 —— pnpm-workspace.yaml 本次移除了无法满足的
 * patchedDependencies 声明时（宿主会带上 detail）。这类项此前默认自动采用且不展示，
 * 用户即使已知风险也无法否决；现在进确认列表（可取消），默认仍采用（sanitize 结果更安全，
 * 默认不采用会静默丢掉 allowBuilds / 冷静期配置）。
 * 注意：与宿主 src/index.ts 的同名判定必须保持一致（两侧刻意重复，避免跨端 import）。
 */
export function isToolchainChangeItem(item: { itemId: string; detail?: string | undefined }): boolean {
  return item.itemId === 'plugins:pnpm-workspace' && item.detail !== undefined && item.detail !== '';
}

/**
 * 「这一项是否需要人工决策（是否进确认列表）」的唯一判定 —— reviewItems / isBulkDecidable /
 * confirmListSummary 共用同一份，避免三处各写一遍 kind 规则而漂移。
 * 统计（summarizeConfirmItems）仍基于全量 items，不受影响。
 * issue #35：除 kind 命中外，**改变工具链行为**的项（pnpm-workspace 剔除声明）也进列表。
 */
function isListedItem(it: Pick<SyncConfirmItem, 'itemId' | 'kind' | 'detail'>): boolean {
  return CONFIRM_REVIEW_KINDS.has(it.kind) || isToolchainChangeItem(it);
}

/** 仅保留需人工决策的项（差异确认列表只渲染这些）。 */
export function reviewItems(items: readonly SyncConfirmItem[]): SyncConfirmItem[] {
  return items.filter((it) => isListedItem(it));
}

/**
 * 确认列表的可见性摘要：需要人工决策（逐项列出）的项数 vs 按默认方式自动采用的项数。
 *
 * 为什么必须单独给这两个数字（用户报告）：摘要徽章统计的是**全量**差异（如「共 57 项差异」），
 * 而列表只渲染需人工决策的项（常常只有 1 行）—— 中间那些项去哪了完全看不见。
 * 界面据此补一句「列表逐项确认 N 项；其余 M 项按默认方式自动采用」。
 */
export interface ConfirmListSummary {
  /** 逐项列出、由用户确认的项数（= reviewItems 的长度）。 */
  reviewCount: number;
  /** 不在列表里、按默认方式自动采用的项数。 */
  autoCount: number;
}

export function confirmListSummary(items: readonly SyncConfirmItem[]): ConfirmListSummary {
  let reviewCount = 0;
  for (const it of items) if (isListedItem(it)) reviewCount += 1;
  return { reviewCount, autoCount: items.length - reviewCount };
}

/** 冲突解决方式：与导入恢复向导（ConflictList）完全一致的两项（保留当前 / 使用导入）。
 *  - keepLocal = keepCurrent（保留本地现有值，不写入）；
 *  - useRemote = useImported（采用远端快照值，写入本地）。
 */
export type SyncConflictResolution = 'keepLocal' | 'useRemote';

/** 单条批量决策：adopt +（仅 Conflict 项需要）解决方式。 */
export interface BulkDecision {
  itemId: string;
  adopt: boolean;
  /** 仅 Conflict 项：批量决策必须连带给出解决方式，否则 buildAdoptions 抛错。 */
  resolution?: SyncConflictResolution;
}

/** 旧名保留（宿主 core 另有同名类型；本模块内的引用点不必逐个改名）。 */
export type ConflictDecision = BulkDecision;

/**
 * 批量决策覆盖的项 = **确认列表里的全部项**（与 reviewItems 同口径），但排除 Error：
 * Error 是硬失败项（执行侧恒记 failed，可能触发整体回滚），不能让一个批量按钮替用户做决定。
 *
 * 用户报告「导入密钥时无法一键勾选，需要逐个勾『缺密钥』」：此前批量按钮只作用于 Conflict，
 * 列表里 N 条凭据迁移项（MissingSecret）只能手动逐条点。
 */
export function isBulkDecidable(item: Pick<SyncConfirmItem, 'itemId' | 'kind' | 'detail'>): boolean {
  if (item.kind === 'Error') return false;
  return isListedItem(item);
}

/** 是否存在可批量决策项 —— 批量按钮禁用判据与触发条件同源（避免两处规则漂移）。 */
export function hasBulkDecidable(items: readonly SyncConfirmItem[]): boolean {
  return items.some((it) => isBulkDecidable(it));
}

/**
 * 「全部保留当前配置」：全部可批量决策项 → adopt=false；
 * Conflict 项附带 resolution=keepLocal（不连带给解决方式会被 buildAdoptions 拒绝）。
 */
export function keepLocalAll(items: readonly SyncConfirmItem[]): BulkDecision[] {
  return items
    .filter((it) => isBulkDecidable(it))
    .map((it) => (it.kind === 'Conflict'
      ? { itemId: it.itemId, resolution: 'keepLocal' as const, adopt: false }
      : { itemId: it.itemId, adopt: false }));
}

/**
 * 「全部使用备份配置」：全部可批量决策项 → adopt=true；
 * Conflict 项附带 resolution=useRemote。无值的 MissingSecret 项即便被采纳也只是记 skipped
 * （执行侧 planItemWritesTarget 判定），不会误写。
 */
export function useRemoteAll(items: readonly SyncConfirmItem[]): BulkDecision[] {
  return items
    .filter((it) => isBulkDecidable(it))
    .map((it) => (it.kind === 'Conflict'
      ? { itemId: it.itemId, resolution: 'useRemote' as const, adopt: true }
      : { itemId: it.itemId, adopt: true }));
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
  t: UiT,
): SyncItemAdoption[] {
  const out: SyncItemAdoption[] = [];
  for (const it of items) {
    if (adopted.get(it.itemId) !== true) continue; // adopt=false / 未列出 → 跳过
    const adoption: SyncItemAdoption = { itemId: it.itemId, adopt: true };
    if (it.kind === 'Conflict') {
      const resolution = resolutions.get(it.itemId);
      if (resolution === undefined) {
        throw new Error(t('sync.conflictUnresolved', { id: it.itemId }));
      }
      adoption.resolution = resolution;
    }
    out.push(adoption);
  }
  return out;
}

/**
 * 'partial' = 整体**没有回滚**、也没有硬失败，但有项未生效（warning）。
 *
 * 为什么必须与 'ok' 分开（issue #56）：插件安装失败是刻意的非致命 warning，
 * `ok` 因此仍为 true；用户看到「已导入 N 个分区」就以为全部成功，
 * 而排在插件之后的步骤（凭据写入）根本没执行 —— 真机表现就是「模型列表同步过来了、密钥没进来」。
 */
export type ApplyItemsViewKind = 'ok' | 'partial' | 'failed' | 'rolledBack' | 'rollbackIncomplete';

/** sync 命名空间的取词器（缺省 = 该字典的 zh 源；组件可注入自己的 t 以本地化）。 */
export type SyncTextFn = (key: SyncKey, params?: Record<string, unknown>) => string
// **活**取词器（不是 zh 快照）：sync 命名空间的 zh/en 目录都在手边，按当前语言取词 ——
// 否则英文界面上「回滚未完成」这类只住在 sync 字典的文案会原样透出中文。
const defaultSyncText: SyncTextFn = (key, params) => {
  const raw = (currentUiLanguage() === 'zh' ? syncZhCatalog : syncEnCatalog)[key]
  if (params === undefined) return raw
  // 与字典的 {param} 口径一致（缺参原样保留，便于排查）
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => {
    const value = params[name]
    return value === undefined ? m : String(value)
  })
}

export interface ApplyItemsView {
  kind: ApplyItemsViewKind;
  headline: string;
  sections: string[];
  warnings: string[];
  /** 未生效项（kind='partial' 时非空）：逐条展示「哪一步没写进去」 */
  ineffective: { itemId: string; adapter: string; message?: string }[];
  restoreId: string;
  needsRestart: boolean;
  /**
   * 整体回滚是否**完整**（诚实性，2026-10）：`rolledBack=true` 只说明触发了整体回滚，
   * 不代表每一项都补偿成功（凭据原本存在 → DSH 不可回读，无法自动恢复）。
   * false 时 kind='rollbackIncomplete' —— **绝不**渲染成「已整体回滚」。
   * 旧宿主不返回 → 字段缺席（按旧的「已整体回滚」处理，不误报）。
   */
  rollbackFull?: boolean;
}

/** apply-items 执行结果 → 渲染模型（ok / partial / failed / 整体回滚 / 回滚未完成）。 */
export function applyItemsReportView(
  report: ApplyItemsResponse | null,
  t: UiT,
  syncText: SyncTextFn = defaultSyncText,
): ApplyItemsView | null {
  if (report === null) return null;
  const failedOnly = report.failed.length > 0 && !report.ok;
  // 旧宿主不返回 ineffective → 空数组（按「无未生效项」处理，绝不据此误报部分成功）
  const ineffective = report.ineffective ?? [];
  const kind: ApplyItemsViewKind = !report.ok && report.rollbackFull === false
    // 回滚**未完成**优先于「已整体回滚」：半回滚态的配置可能停在中间状态，必须单独成态
    ? 'rollbackIncomplete'
    : !report.ok && report.rolledBack
      ? 'rolledBack'
      : failedOnly
        ? 'failed'
        : ineffective.length > 0
          ? 'partial'
          : 'ok';
  const headline = kind === 'ok'
    ? t('sync.importDone', { n: String(report.applied.length) })
    : kind === 'partial'
      // 不用「失败」措辞：这次同步**大部分成功**，只是有 N 项没生效 —— 措辞必须与事实同强度
      ? t('sync.importPartial', { n: String(ineffective.length) })
      // 回滚未完成：UiT 字典没有这个键（'sync.importFailed' 的文案断言「已整体回滚」），
      // 取 sync 字典的专用文案 —— 措辞与事实同强度，绝不把半回滚说成已回滚
      : kind === 'rollbackIncomplete'
        ? syncText('syncflow.importRollbackIncomplete')
        : t('sync.importFailed');
  return {
    kind,
    headline,
    sections: report.applied,
    warnings: report.warnings,
    ineffective,
    restoreId: report.restoreId,
    needsRestart: report.needsRestart,
    ...(report.rollbackFull !== undefined ? { rollbackFull: report.rollbackFull } : {}),
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
export function formatIntervalDuration(ms: number, t: UiT): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
  if (totalMinutes < 60) return t('sync.duration.min', { n: totalMinutes });
  const totalHours = Math.ceil(totalMinutes / 60);
  if (totalHours < 24) return t('sync.duration.hour', { n: totalHours });
  const totalDays = Math.ceil(totalHours / 24);
  return t('sync.duration.day', { n: totalDays });
}

/**
 * 自动同步状态行的「本轮跳过原因」明细（issue #79）。
 *
 * 为什么单独成行而不是塞进状态徽章：跳过原因可能带数量（远端另有 N 个分区待确认），
 * 徽章会挤成两行；且用户最需要的信息正是「为什么没同步」——改造前它只进 info 级日志
 * （默认日志级别 warn），界面完全看不到。
 *
 * 未知码回退宿主原串（与同步历史同口径，不吞信息，也绝不渲染裸回调码当文案）。
 */
export function autosyncSkipDetail(
  status: AutosyncStatusResponse,
  syncText: SyncTextFn = defaultSyncText,
): string | null {
  const reason = status.lastRunSkipReason
  if (reason === undefined || reason === '') return null
  const key = skipReasonKey(reason)
  // 未知码：给可读兜底，**绝不**把裸码渲染成文案（历史行保留原串以便排查，状态行只要可读）
  const label = key === null ? syncText('history.autosyncReasonUnknown') : syncText(key)
  // 冲突：补一句「远端另有 N 个分区待确认」（数量来自宿主的结构化字段，不是从文案里抠）
  if (reason === 'conflict' && status.lastRunSkipCount !== undefined && status.lastRunSkipCount > 0) {
    return syncText('autosync.skipReasonConflictCount', { reason: label, n: String(status.lastRunSkipCount) })
  }
  return label
}

/**
 * 卡片该不该渲染「上一轮失败原因」（issue #105）。
 *
 * 此前卡片只看 lastRunMessage 非空就渲染，而该字段语义历史上是混用的：既可能是本轮错误原文，
 * 也可能残留十天前那次失败、或被「连续失败通知」文案占用 —— 于是认证早已修好、同步也成功过，
 * 卡片上仍挂着"认证失败"，用户据此去查一个不存在的故障。
 *
 * 渲染权只认一个判据：**本轮状态是 failed**。success/skipped/partial 一律不渲染旧错误。
 * （宿主侧同一判据 = autosync-config.lastRunFailureMessage，此处是渲染层守门，双保险。）
 */
export function autosyncFailureMessage(
  status: Pick<AutosyncStatusResponse, 'lastRunStatus' | 'lastRunMessage'>,
): string | null {
  if (status.lastRunStatus !== 'failed') return null
  const message = status.lastRunMessage
  return message === undefined || message === '' ? null : message
}
/** 自动同步状态行的可读文案（未运行 / 上次状态 / 连续失败计数）。 */
export function autosyncStatusText(status: AutosyncStatusResponse, t: UiT): string {
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
