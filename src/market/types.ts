/**
 * m-market：配置市场的纯领域类型（src/market/）。
 * 与 src/schema/types.ts 同纪律：纯数据形状，零副作用，不 import 任何 DSH 运行时包。
 *
 * 分层信任（docs/design/marketplace.md §1）：
 *  - L1 index.json（市场目录）→ 字段白名单，仅作浏览卡片展示，不直接作为导入依据；
 *  - L2 items/<id>/manifest.json → 校验 + 供应链/来源信息展示；sections/checksums 须与
 *    config.zip 实际内容一致才放行；
 *  - L3 config.zip → 走现有 parseZipHardened + Importer 分析/预览/确认。
 */
import type { ImportAnalysis, ImportPlan } from '../core/types.ts';
import type { SectionId } from '../schema/types.ts';

/** index.json schema 版本（本版恒 1） */
export const MARKET_INDEX_SCHEMA_VERSION = 1;
/** items/<id>/manifest.json schema 版本（本版恒 1） */
export const MARKET_ITEM_SCHEMA_VERSION = 1;

/**
 * 单条目 config.zip 体积上限（64 MB，对齐现有上传上限量级）—— zip bomb 首道闸。
 */
export const MAX_MARKET_ZIP_BYTES = 64 * 1024 * 1024;

/**
 * 市场条目禁止携带的分区（产品决策 2026-08-19，guide docs/design/2026-08-19-market-repo-setup-guide.md）：
 *  - sessions：历史会话，含个人交互记录/上下文；
 *  - pluginFiles：任意文件直通（目录放啥带啥），无内容过滤，最易泄漏 token/密钥文件；
 *  - self：本地环境专属（sync 通道 URL / WebDAV 地址 / 市场配置 / UI 偏好），无分享价值且泄漏环境信息。
 * 发布（prepare）与下载（validateMarketItem）两端强制拒绝。
 */
export const BANNED_MARKET_SECTIONS: readonly SectionId[] = ['sessions', 'pluginFiles', 'self'] as const;

/**
 * itemId / 仓库 url-hash 的安全字符集（防路径穿越 + 用作目录名）：
 * 字母数字开头，仅 . _ -，最长 128。与 sync GitTransport 的 SAFE_ID_RE 同构。
 */
export const SAFE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 校验 itemId 是否合法；不合法抛错（防 items/<id>/ 越界）。 */
export function assertSafeItemId(id: string): void {
  if (typeof id !== 'string' || !SAFE_ITEM_ID_RE.test(id)) {
    throw new Error(`非法市场条目 id: ${JSON.stringify(id)}（仅允许字母数字开头，字符限 . _ -）`);
  }
}

/* ---------------- L1：market repo 根 index.json ---------------- */

/** index.json 中的单条目摘要（浏览卡片数据源；仅展示，不直接作为导入依据） */
export interface MarketIndexItem {
  /** 条目 id —— 对应 items/<itemId>/，必须过 SAFE_ITEM_ID_RE */
  id: string;
  /** 条目标题（卡片标题） */
  name: string;
  /** 一句话描述 */
  description?: string;
  /** 作者 / 发布者（字符串，不做身份校验） */
  author?: string;
  /** 条目版本号（展示用；与 L2 manifest.version 一致性见 security） */
  version?: string;
  /** 发布/更新时间 ISO-8601（展示用） */
  updatedAt?: string;
  /** 内容类别标签（展示用；禁止执行语义） */
  categories?: string[];
  /** 条目来源仓库 URL（发布者自托管；读取路由依据）；缺省 = 市场仓库自身（兼容现状单仓）。
   *  存在时必须过 validateRepoUrl（拒绝 userinfo / 空白），只读拉取、永不注入凭据。 */
  repo?: string;
}

/** 市场目录 index.json（字段白名单：多出的字段拒绝） */
export interface MarketIndex {
  schemaVersion: number;
  /** 市场名（展示用，可空） */
  name?: string;
  /** 市场描述（可空） */
  description?: string;
  /** 条目摘要列表（浏览列表数据源） */
  items: MarketIndexItem[];
}

/* ---------------- L2：items/<id>/manifest.json ---------------- */

/** 供应链/来源信息（纯展示，不做身份验证） */
export interface MarketItemProvenance {
  /** 作者声明的来源（仓库 URL 等，展示用） */
  source?: string;
  /** 作者自述（展示用） */
  note?: string;
}

/** 单条目清单（L2：描述 + checksums + 供应链来源） */
export interface MarketItemManifest {
  schemaVersion: number;
  /** 必须与目录名 itemId 一致（不一致 → 拒绝） */
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  updatedAt?: string;
  categories?: string[];
  /** 内容 section 清单：config.zip 内含哪些分区（正常应等于 zip 内部 manifest.sections 的子集） */
  sections: SectionId[];
  /** 供应链/来源信息（纯展示，不做身份验证） */
  provenance?: MarketItemProvenance;
  /** 完整性校验和：config.zip → SHA-256 hex。缺失或与实算不符 → 拒绝该条目 */
  checksums: {
    /** config.zip 的 SHA-256 */
    zip: string;
  };
}

/* ---------------- 解析/校验结果（纯结构） ---------------- */

export interface ParseIndexResult {
  ok: boolean;
  index: MarketIndex | null;
  errors: string[];
  /** 因 repo 非法（未过 validateRepoUrl）被丢弃的条目数：仅丢弃该条目，不整体拒绝 index */
  dropped?: number;
}

export interface ParseItemManifestResult {
  ok: boolean;
  manifest: MarketItemManifest | null;
  errors: string[];
}

/* ---------------- Host/Client 响应契约（§4.2 / §7.1） ---------------- */

/** 已添加的市场摘要（GET/POST market 响应；无凭据） */
export interface MarketSummary {
  url: string;
  addedAt: string;
  /** 最近一次刷新拉到的 index.json 市场名（可空） */
  name?: string;
  /** 缓存 index 的条目数（可空） */
  itemCount?: number;
  /** 最近一次成功拉取时间（可空） */
  lastFetchedAt?: string;
}

/** POST /market/browse 响应：合并 index + 缓存状态的列表项 */
export interface MarketListItem {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  updatedAt?: string;
  categories?: string[];
  /** 条目来源仓库 URL（来自 index 条目；UI 据此显示来源徽章）；缺省 = 市场仓库自身 */
  repo?: string;
  /** 本地缓存状态：cached | fresh | none（UI 徽章） */
  cacheState: 'cached' | 'fresh' | 'none';
}

/** POST /market/download 响应：条目详情 + 校验结果（dry-run 预览） */
export interface MarketItemDetail {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  updatedAt?: string;
  sections: SectionId[];
  /** 条目来源仓库 URL（本次下载实际读取的仓库，repo ?? 市场 url）；展示用 */
  repo?: string;
  /** 供应链/来源信息（UI 恒展示） */
  provenance?: MarketItemProvenance;
  /** 下载/校验时间 */
  downloadedAt: string;
  /** 校验状态：valid | invalid */
  status: 'valid' | 'invalid';
  errors?: string[];
  /** 供应链警示（不论 status 都恒有；invalid 时叠加 errors） */
  warnings: string[];
}

/** market/download 的 payload（供后续 /execute 确认导入用） */
export interface MarketDownloadResult extends MarketItemDetail {
  /** 受控临时区路径，供 confirm 后调 /execute */
  zipPath: string;
  /** 复用现有 analyzeImport 输出（dry-run） */
  analysis: ImportAnalysis;
  /** 复用现有 createImportPlan 输出（dry-run 预览） */
  plan: ImportPlan;
}

/* ---------------- 有效载荷类型别名（Host 用，避免重复构造） ---------------- */

/** GET /market/status 响应：{ configured, markets } */
export interface MarketStatusResponse {
  ok: boolean;
  /** 是否已添加过至少一个市场 */
  configured: boolean;
  markets: MarketSummary[];
  /** 本次 dsh 启动后市场是否已刷新过（首次打开市场页自动更新一次的依据；进程内存，dsh 重启后重置） */
  bootAutoRefreshed?: boolean;
}

/** POST /market/add | /market/remove 响应：{ ok, markets } */
export interface MarketMutateResponse {
  ok: boolean;
  markets: MarketSummary[];
}

/** POST /market/refresh 响应：{ ok, items, market } */
export interface MarketRefreshResponse {
  ok: boolean;
  items: MarketIndexItem[];
  /** 该市场的缓存摘要（含最新 name/itemCount/lastFetchedAt） */
  market: MarketSummary;
}

/** POST /market/browse 响应：{ ok, items } */
export interface MarketBrowseResponse {
  ok: boolean;
  items: MarketListItem[];
}

/** POST /market/prepare 请求体：由上传 zip + 用户填写元数据生成市场条目包（发布向导） */
export interface MarketPreparePayload {
  /** 受控临时区中的配置 zip 路径（upload 端点返回；必须引用 staged upload） */
  zipPath: string;
  itemId: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** 作者托管仓库 URL（可选；非空须过 validateRepoUrl） */
  repoUrl?: string;
  categories?: string[];
}

/** POST /market/prepare 响应：条目包生成结果（manifest 文本 + 校验摘要 + 发布目录） */
export interface MarketPrepareResponse {
  ok: boolean;
  /** 发布目录（受控临时区，含 items/<id>/manifest.json + config.zip；懒 GC 与下载临时区同款） */
  dir: string;
  /** 发布目录打包 zip 路径（受控临时区，供 /download 端点下载；懒 GC 清理） */
  zipPath: string;
  /** items/<id>/manifest.json 内容（pretty JSON，可直接复制/写入） */
  manifestText: string;
  /** config.zip 的 SHA-256（与 manifest.checksums.zip 一致） */
  sha256: string;
  /** zip 内启用的分区（与 manifest.sections 一致） */
  sections: SectionId[];
  /** 供应链警示（恒生成：发布即公开、未经审核） */
  warnings: string[];
}
