# 配置市场（Config Marketplace）架构设计文档（m-market）

> 版本：v1.0（第一版：只做**单向浏览 + 下载**；发布/上传为二期，本文预留但不在本期实现）
> 依据：复用现有同步通道（`src/sync/`）+ 现有导入安全管道（`src/security/zip-security.ts`、`src/core/importer.ts`）。
> 原则（沿用项目硬约束）：**下载即不可信输入** · **无 secret 硬不变式** · **宁缺毋滥、不编造 API** · **严格分层信任** · 纯渲染模型函数 + 薄 React 组件 + Host API。
> 读者：backend（目录读取 / Host 端点 / 安全校验）、frontend（client API、纯渲染模型、React 第 5 个 tab、i18n）、reviewer（安全不变式 + 架构纪律一致性）。

---

## 0. 目标与非目标

**目标（v1，本期）**
- 浏览：从「公开 Git 仓库」读取市场目录（`index.json`），展示条目列表。
- 下载：从市场仓库拉取某条目（`config.zip`），**以现有导入管道**做安全校验与预览导入（零写入到确认）。
- 严格分层信任：来自网络的条目默认视为不可信，导入前必经校验 + 供应链警示 + 用户确认。

**非目标（v1，明确不做，二期再议）**
- 发布 / 上传 / 更新自己的条目到市场（不提供 push / publish 端点）。
- 用户鉴权 / 实名 / 评分 / 评论。
- 私密市场（本版默认**公开**市场；token 能力预留但 UI 不引导）。

---

## 1. 分层信任模型（安全顶层约束）

网络下载的配置 = **不可信输入**，与「导入用户自选 ZIP」同等对待，但多一层**来源信任降级**：

| 层 | 信任 | 处理 |
|---|---|---|
| L0 仓库地址本身 | 用户**显式**添加的市场 URL（settings 持久化） | 只读拉取；绝不写入远端 |
| L1 目录 `index.json` | 不可信：可被仓库持有者篡改 | 结构校验 + 字段白名单；仅作为「浏览卡片」展示，不直接作为导入依据 |
| L2 条目 `manifest.json`（仓库内） | 不可信 | 校验 + 展示供应链/来源信息；`manifest` 声明的 section、checksum 必须与 `config.zip` 实际内容一致才放行 |
| L3 `config.zip` 载荷 | 不可信（**最高风险层**） | 走现有 `parseZipHardened`（Zip Slip / zip bomb / 恶意路径 / checksum），再喂 `Importer.analyzeImport → preview → confirm` |

**供应链警示（硬不变式）**：任何从市场下载的条目，在**确认导入之前**都必须在 UI 逐条展示并默认可见：来源仓库 URL、条目作者/发布信息、内容 section 清单、built/downloaded 时间、以及「来自公共网络、非官方审核」警示横幅；`needsReview` 恒为 true，**不提供「自动信任该来源」的默认**（二期才考虑来源白名单）。

**无 secret 硬不变式**：市场通道绝不处理、也绝不接收任何 secret/token 输入值。读取公开市场不需要凭据；私有市场 token（二期）也只经 DSH credentials 槽位，绝不落 URL / argv / 日志 / 文件。**下载的 config.zip 内若出现 secret 值，由导入管道按现有规则处理（默认不采纳，要求重输），市场层不做任何回传。**

---

## 2. 市场仓库布局（index.json / manifest 布局）

一个市场 = 一个 Git 仓库，根目录固定布局：

```text
<market repo root>/
├── index.json                     # 市场目录：全部条目摘要（浏览列表的唯一来源，L1）
└── items/
    └── <itemId>/                  # 每条目一个目录，itemId 需过安全字符集（见 §5.3）
        ├── manifest.json          # 单条目元信息（L2：描述 + checksums + 供应链来源）
        └── config.zip             # 共享配置包（L3：复用现有 Export ZIP 结构，内含它自己的 manifest.json）
```

### 2.1 `index.json`（市场目录，L1）

字段白名单（多出的字段**拒绝**，未知字段不忽略 —— 防字段渗透）：

```ts
interface MarketIndex {
  schemaVersion: 1;                                  // 恒 1（本版）
  /** 市场名（展示用，可空） */
  name?: string;
  /** 市场描述（可空） */
  description?: string;
  /** 条目摘要列表（浏览列表数据源） */
  items: MarketIndexItem[];
}

interface MarketIndexItem {
  /** 条目 id —— 对应 items/<itemId>/，必须过 SAFE_ITEM_ID_RE */
  id: string;
  /** 条目标题（卡片标题） */
  name: string;
  /** 一句话描述 */
  description?: string;
  /** 作者 / 发布者（字符串，不做身份校验） */
  author?: string;
  /** 条目版本号（展示用；与 manifest.version 一致性校验见 §3） */
  version?: string;
  /** 发布/更新时间 ISO-8601（展示用） */
  updatedAt?: string;
  /** 内容类别标签（展示用；禁止执行语义） */
  categories?: string[];
}
```

**浏览原则**：`index.json` 只用于列表渲染。**导入依据永远以 `items/<id>/manifest.json` + `config.zip` 为准**（L2/L3），绝不信任 `index.json` 里携带的任何「内容声明」。

### 2.2 `items/<itemId>/manifest.json`（L2）

```ts
interface MarketItemManifest {
  schemaVersion: 1;
  id: string;                          // 必须与目录名 itemId 一致（不一致 → 拒绝）
  name: string;
  version: string;
  author?: string;
  description?: string;
  updatedAt?: string;                  // ISO-8601
  categories?: string[];
  /** 内容 section 清单：config.zip 内含哪些分区（正常应等于 config.zip 内部 manifest.sections 的子集） */
  sections: SectionId[];               // 复用 src/schema/types.ts SectionId
  /** 供应链/来源信息（纯展示，不做身份验证） */
  provenance?: {
    /** 作者声明的来源（仓库 URL 等，展示用） */
    source?: string;
    /** 作者自述（展示用） */
    note?: string;
  };
  /** 完整性校验和：config.zip → SHA-256 hex。缺失或与实算不符 → 拒绝该条目 */
  checksums: {
    /** config.zip 的 SHA-256 */
    zip: string;
  };
}
```

### 2.3 `config.zip`（L3）

单条目载荷 = **现有 Export ZIP**（`src/utils/zip.ts` 结构 + 内部 `manifest.json`），complete with `integrity/checksums.json`。这样可**原样复用**：

- `parseZipHardened`（Zip Slip / zip bomb / 路径安全）
- `parseManifest` + `validateSectionData`
- `validateChecksums`（内部 checksums.json ↔ 实际条目）
- `Importer.analyzeImport / createImportPlan / executeImportPlan`

> 注意：条目 `manifest.json`（L2）的 `sections` 声明是**目录侧**信息；真正校验以 `config.zip` **内部** `manifest.json` 为准，两者不冲突（L2 用于卡片展示「内容包含」，L3 才是导入依据）。

---

## 3. 数据模型：后端纯类型（`src/market/`）

新模块 `src/market/`（与 `src/sync/` 同级），Host 侧纯逻辑：

```text
src/market/
├── types.ts            # 纯领域类型（index/manifest/条目/状态，零副作用）
├── index.json→parser   # 见下
├── market-config.ts    # 市场列表持久化（market-config.json：已添加的市场 URL）
├── reader.ts           # 目录读取（git fetch → index.json / item manifest / config.zip）
├── security.ts         # 校验（复用 zip-security + validator，见 §6）
├── view.ts             # 纯渲染模型（node 可测；→ 供 frontend 复用）
└── *.test.ts           # node --test
```

### 3.1 `src/market/types.ts`（纯类型）

与 `src/schema/types.ts` 同纪律（纯数据形状，不 import 运行时包）。

```ts
import type { SectionId } from '../schema/types.ts';

export const MARKET_INDEX_SCHEMA_VERSION = 1;
export const MARKET_ITEM_SCHEMA_VERSION = 1;

// —— index.json（L1）——
export interface MarketIndexItem { id: string; name: string; description?: string; author?: string; version?: string; updatedAt?: string; categories?: string[]; }
export interface MarketIndex { schemaVersion: number; name?: string; description?: string; items: MarketIndexItem[]; }

// —— items/<id>/manifest.json（L2）——
export interface MarketItemProvenance { source?: string; note?: string; }
export interface MarketItemManifest { schemaVersion: number; id: string; name: string; version: string; author?: string; description?: string; updatedAt?: string; categories?: string[]; sections: SectionId[]; provenance?: MarketItemProvenance; checksums: { zip: string }; }

// —— 解析/校验结果（纯结构）——
export interface ParseIndexResult { ok: boolean; index: MarketIndex | null; errors: string[]; }
export interface ParseItemManifestResult { ok: boolean; manifest: MarketItemManifest | null; errors: string[]; }
```

### 3.2 解析与校验（纯函数，node 可测）

`src/market/index-parser.ts`（或并入 reader）——纯字符串级校验，零 fs：

- `parseMarketIndex(raw: string): ParseIndexResult` —— 深度保护（`parseJsonSafe`）+ 字段白名单 + `schemaVersion===1` + items 每项 `id` 过 `SAFE_ITEM_ID_RE`。
- `parseMarketItemManifest(raw: string): ParseItemManifestResult` —— 同上。
- 未知字段、越界字段一律 `errors`（拒绝，不忽略）。

---

## 4. 复用同步传输：读取通道设计

### 4.1 决策：市场用「**只读 git fetch**」，不复用 `GitTransport` 的写路径

`GitTransport`（`src/sync/git/git-transport.ts`）是**写优先**通道（work 副本 `snapshots/<id>/` + commit + push 到 `origin HEAD`）。市场是**只读、公共、单仓库多条目**：

- 复用点：git 命令执行层（`execFile` 封装 / credential helper / token 脱敏 `mask()`）+ `SnapshotFs` + `isPathSafe`。
- 不复用点：`SyncTransport` 接口的 `snapshots/<id>/` 布局、`SyncSnapshot` 语义、push/delete 写路径。

因此新建 **`src/market/reader.ts`：`MarketReader`**，内部持有一个可注入 git 执行器（默认 `execFile` promise 封装，与 `GitTransport` 同款），暴露只读操作：

```ts
/** 可注入 git 执行器（与 git-transport GitExecFn 同构；测试 mock 用） */
export type MarketGitExecFn = (cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<GitExecResult>;

/** 只读市场读取通道 */
export interface MarketReader {
  /** 拉取市场目录（拉最新 index.json；缓存失效策略见 §5.1） */
  readIndex(opts: { url: string; workDir: string }): Promise<{ text: string; fetchedAt: string }>;
  /** 拉取单条目 manifest.json（返回 raw） */
  readItemManifest(opts: { url: string; workDir: string; itemId: string }): Promise<{ text: string }>;
  /** 拉取单条目 config.zip（返回 bytes；配合 §6 校验） */
  readItemZip(opts: { url: string; workDir: string; itemId: string }): Promise<{ data: Uint8Array }>;
}
```

`MarketReader` git 实现 `GitMarketReader`：

- `ensureRepo(workDir, url)`：`git clone --depth 1 <url> <workDir>`（首次）或 `git pull --ff-only`（复用存在副本）。**只读方针**：完成后不留本地仓删除竞态（`--depth 1` 兜底体积）。
- 读取 `index.json` / `items/<itemId>/manifest.json` / `items/<itemId>/config.zip` 直接以文件读回。
- **默认公开市场不注入凭据**（`repoUrl` 拒绝 userinfo，复用 `validateRepoUrl`）。二期私有市场才走 token credential helper（复用 `GitTransport.buildCredentialArgs` 思路，但 token 只从 DSH credentials 槽位读）。
- 命令超时（默认 60s）、错误消息复用 `mask()` 脱敏思路（公开 URL 无可泄 token，但保留通用脱敏）。

> **为什么不做成 `SyncTransport` 实现**：`SyncTransport` 契约（list/upload/download/delete + `SyncSnapshotMeta` + `snapshots/<id>/` 布局）与市场（单仓库目录 + 多条目 + 每条目即 zip）形状不符。强行套用会污染同步通道。市场用自己的 `MarketReader`，但**git 命令层/脱敏/SnapshotFs 全复用现有 `src/sync/fs.ts` + `git-transport` 的私有 helper 思想（可抽取为共享 `src/sync/git/git-command.ts`）**。

### 4.2 文件/API 形状总览

```text
# —— Host 半新增（index.ts makeRoutes 追加 market 路由族）——
GET  /api/dsh-config-manager/market/status          → { configured: boolean; markets: MarketSummary[] }   // 已添加市场列表
POST /api/dsh-config-manager/market/add             → { ok, markets: MarketSummary[] }                    // body: { url }
POST /api/dsh-config-manager/market/remove          → { ok, markets: MarketSummary[] }                    // body: { url }
POST /api/dsh-config-manager/market/refresh         → { ok, items: MarketIndexItem[], market: … }          // body: { url }  拉取最新 index.json
POST /api/dsh-config-manager/market/browse          → { ok, items: MarketListItem[] }                      // body: { url }  合并 index + 已下载缓存
POST /api/dsh-config-manager/market/download        → { ok, item: MarketItemDetail, zipPath }              // body: { url, itemId }  拉取+校验+落受控区，零写入导入预览
# 注意：没有 market/apply 端点。确认导入 = 前端拿 download 返回的 zipPath+plan 直接调现有 POST /execute
```

> **确认导入（apply）不新增端点**：前端对 `market/download` 返回的预览确认后，直接调用**现有** `POST /api/dsh-config-manager/execute`（body: { zipPath, plan, opts }，`confirm:true` 安全阀 + 回滚），**不新增 market/apply**。这样导入只有一条既有路径，安全校验/回滚/凭据补录全部走既有管道，避免实现分叉。`market/download` 只负责「拉取 + 校验 + 生成 ImportPlan（dry-run 预览）」，真正落盘由用户确认后走 `/execute`。

**client 半**：`src/client/market/market-api.ts`（`MarketApi` 类，仿 `SyncApi`）+ `src/client/market/market-view.ts`（纯渲染模型，仿 `sync-view.ts`）+ `src/client/market/MarketPanel.tsx`（第 5 个 tab 组件）+ `market-locales.ts`（i18n）+ 在 `ConfigManagerSection.tsx` 加第 5 个 tab。

---

## 5. 状态与缓存

### 5.1 市场列表持久化：`src/market/market-config.ts`

`$DSH_HOME/dsh-config-manager/market/market-config.json`（schemaVersion=1，仿 `sync-config.json`）：

```json
{
  "schemaVersion": 1,
  "markets": [
    { "url": "https://github.com/example/dsh-config-market", "addedAt": "2026-08-16T00:00:00.000Z" }
  ]
}
```

- 只存 `url`（拒绝 userinfo，复用 `validateRepoUrl`）+ `addedAt`；无任何凭据。
- 提供 `readMarketConfig(dir)` / `writeMarketConfig(dir, cfg)` / `addMarket` / `removeMarket`（仿 `sync-config.ts`）。

### 5.2 拉取缓存：`$DSH_HOME/dsh-config-manager/market/cache/<url-hash>/`

- `index.json` 缓存 + `items/<id>/config.zip` + `manifest.json` 缓存，供浏览/离线重复查看。
- 每次 `refresh` 覆盖 index 缓存；条目点击下载时刷新该条目。
- **缓存内容一律视为不可信**：读取展示前必经结构校验（§3.2）；导入前必经 §6 完整校验。
- **校验失败不写缓存**：任何条目在 §6 全管线校验失败时，**不落任何缓存**（含 index/manifest/config.zip 的缓存文件一律不写）——与「零写入」原则一致，避免把可疑载荷留存在磁盘上。

### 5.3 安全字符集

```ts
// itemId / 仓库 url-hash 的安全校验（防路径穿越 + 用作目录名）
export const SAFE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function assertSafeItemId(id: string): void;   // 不合法 → 抛错（防 items/<id>/ 越界）
```

---

## 6. 安全校验管线（`src/market/security.ts`）— 复用「不可信输入」全部现有能力

下载条目 `${zipPath}` 后，**在生成 ImportPlan 之前**依次执行（全部纯函数，node 可测）：

1. **来源一致**：`items/<id>/manifest.json.id === itemId`（否则拒绝）。
2. **字节体积上限**：`config.zip` ≤ `MAX_MARKET_ZIP_BYTES`（建议 64 MB，对齐现有上传上限量级）—— 防 zip bomb 首道闸。
3. **Zip 加固解包**：`createHardenedZipParser()`（复用 `src/security/zip-security.ts`：Zip Slip / 绝对路径 / 恶意条目 / 深度 / 解压比限制），任一条目违规 → 拒绝整包。
4. **内部 manifest 校验**：`parseManifest`（复用 `src/schema/manifest.ts`）+ `validateSectionData` 逐分区（复用 `src/schema/config.ts`）。
5. **内部 checksum 校验**：`integrity/checksums.json` ↔ 实际条目（复用 `src/utils/hashing.ts buildChecksums` + validator）。
6. **L2↔L3 一致性**：`MarketItemManifest.checksums.zip` 与实际 `config.zip` 的 SHA-256 一致（防 index/manifest 描述与载荷不符）；`MarketItemManifest.sections` 与 `config.zip` 内部 manifest 声明的 sections 取交集后至少非空（空 → 拒绝）。
7. **供应链警示**：把 `MarketItemManifest.provenance`/市场 URL/下载时间投影为 `MarketItemDetail.warnings`（模型层生成，UI 恒展示）。

> 校验失败 → 该条目标记 `status:'error'` + `errors[]`，**不进入导入预览**，UI 显示具体原因。任何一步失败都不落配置、不回退、不写任何东西（零写入原则）：**同时不写缓存、删除已拉的临时 `config.zip`/`manifest.json`**，避免可疑载荷留盘。

---

## 7. 渲染模型与响应类型（client 契约）

### 7.1 响应类型（`src/client/market/market-api.ts` + `src/market/types.ts` 对齐）

```ts
/** GET/POST market 响应的市场摘要（无凭据） */
export interface MarketSummary { url: string; addedAt: string; name?: string; itemCount?: number; lastFetchedAt?: string; }

/** POST /market/browse 响应：合并 index + 缓存状态的列表项 */
export interface MarketListItem {
  id: string;                   // 条目 id
  name: string;
  description?: string;
  author?: string;
  version?: string;
  updatedAt?: string;
  categories?: string[];
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
  /** 供应链/来源信息（UI 恒展示） */
  provenance?: { source?: string; note?: string };
  /** 下载/校验时间 */
  downloadedAt: string;
  /** 校验状态：valid | invalid */
  status: 'valid' | 'invalid';
  errors?: string[];
  /** 供应链警示（不论 status 都恒有；invalid 时叠加 errors） */
  warnings: string[];
}

/** market/download 的 payload（供后续 /execute） */
export interface MarketDownloadResult extends MarketItemDetail {
  zipPath: string;             // 受控临时区路径，供 confirm 后调 /execute
  analysis: ImportAnalysis;    // 复用现有 analyzeImport 输出（dry-run）
  plan: ImportPlan;            // 复用现有 createImportPlan 输出（dry-run 预览）
}
```

### 7.2 纯渲染模型 `src/market/view.ts`（frontend 直接复用，node 可测）

仿 `src/ui/progress.ts` / `sync-view.ts` 模式，全部无副作用纯函数：

- `marketStatusText(summary|marketList, t)` —— 状态行文案。
- `marketListSummary(items, t)` —— 列表计数 + 缓存徽章数据。
- `computeItemBadge(detail, t)` —— valid/invalid、sections、供应链警示文案。
- `marketItemWarnings(manifest, url, t)` —— 恒生成供应链警示行（来源 URL / 时间 / 非官方审核）。
- `needsReview(detail): boolean` —— 恒 true（供应链警示不让默认信任）。

**i18n**：新增 `config-manager-market` locale 命名空间（仿 `config-manager-sync`），中英双语键补进 `src/client/locales.ts` + `src/client/sync/sync-locales.ts` 同款结构。

---

## 8. Host 路由装配要点（backend 实现指引）

- 市场目录常量：`$DSH_HOME/dsh-config-manager/market/{cache,config}`。
- `makeRoutes(deps)` 内追加 `market` 路由族（沿用 `guard = loopback-only + method` 围栏，仿现有 sync 路由）。
- `makeMarketReader(url)`：每次请求装配 `GitMarketReader`（注入 `gitBin`、`exec`、超时、可选的 credentials resolve —— 默认公开无凭据）。
- `market/download` 全流程：
  1. `reader.readItemZip(url, workDir, itemId)` → bytes（受控临时文件）。
  2. `validateMarketItem(itemId, manifestRaw, zipBytes, tmpDir)`（§6）→ `MarketItemDetail`。
  3. `analyzeImport + createImportPlan`（复用 importer，dry-run 零写入）→ 组装 `MarketDownloadResult`。
  4. 返回；`zipPath` **落盘在 `<dataDir>/tmp`（严格复用现有 `makeRoutes` 的 `tmpDir`，或其直接子目录）**。原因：现有 `POST /execute` 的 `isControlledPath`（src/index.ts:1161）只认 `roots=[exportsDir, tmpDir]`，若 market 新开别的临时目录，交给 `/execute` 会被 400 拒绝。实现时 `market/download` 须复用同一个 `tmpDir` 常量，不得另起目录。
- 确认导入（apply）：前端拿 `market/download` 返回的 `zipPath + plan` **直接调现有 `POST /execute`**（`confirm:true` 安全阀 + 回滚）。**没有 market/apply 端点**（见 §4.2）。

---

## 9. 顶层契约清单（backend / frontend / reviewer 对齐）

| 契约 | 位置 | 责任 |
|---|---|---|
| `MarketIndexItem` / `MarketIndex` / `MarketItemManifest` | `src/market/types.ts` | backend 定义，frontend type-only 引用 |
| `parseMarketIndex` / `parseMarketItemManifest` | `src/market/` | backend（纯函数，node 测试） |
| `SAFE_ITEM_ID_RE` / `assertSafeItemId` | `src/market/` | backend |
| `readMarketConfig` / `addMarket` / `removeMarket` | `src/market/market-config.ts` | backend |
| `MarketReader` / `GitMarketReader` | `src/market/reader.ts` | backend（复用 git-transport 命令层） |
| `validateMarketItem` | `src/market/security.ts` | backend（复用 zip-security + validator + hashing） |
| `MarketSummary` / `MarketListItem` / `MarketItemDetail` / `MarketDownloadResult` | `src/market/types.ts` + `src/client/market/market-api.ts` | backend 定响应，frontend 引用 |
| `MarketApi` | `src/client/market/market-api.ts` | frontend |
| `market-view.ts` 纯渲染模型 | `src/market/view.ts` | backend 写模型，frontend 用；node 测试 |
| `MarketPanel.tsx`（第 5 个 tab）| `src/client/market/MarketPanel.tsx` | frontend（薄组件） |
| `ConfigManagerSection` 加第 5 个 tab + `client-types.ts` 注入 | `src/client/` | frontend |
| i18n `config-manager-market` | `src/client/locales.ts` + market-locales | frontend |
| 供应链警示恒展示 + 无默认信任 | UI + `view.ts` | frontend + reviewer 校验 |

**安全不变式核对（reviewer 用）**：
1. 下载即不可信输入：所有网络载荷必经 §6 校验 + 现有 import 安全阀。
2. 无 secret：market 端点不接收/不回传任何 token；`repoUrl` 拒绝 userinfo。
3. 供应链警示恒在：任何条目确认导入前都可见「来源 + 非官方 + 下载时间」。
4. 零写入到确认：`download/browse/refresh` 均不落配置；落盘只在 `/execute`（confirm:true）。
5. 纯渲染模型可测：列表/徽章/警示/状态全部为无副作用纯函数。

---

## 10. 测试矩阵（backend / frontend 落地时覆盖）

| 类别 | 用例 |
|---|---|
| 解析（L1/L2） | 合法 index / 缺失字段 / 未知字段拒绝 / schemaVersion 不符 / `id` 越界字符 |
| 校验（§6） | 正常 zip / Zip Slip / zip bomb（超大条目）/ checksum 不匹配 / L2↔L3 不一致 / 空 sections |
| 读取 | mock git exec 命令序列 / clone & pull 复用 / 只读不 push / 超时 / 脱敏 |
| 配置 | add/remove 持久化 / userinfo url 拒绝 / 缓存写读 |
| 渲染模型 | 状态文案 / 徽章 / 供应链警示恒生成 / needsReview 恒 true |
| 端到端（集成） | 本地 bare repo 模拟市场 → browse → download → 校验 → preview → apply（确认后）→ 触发回滚 |
