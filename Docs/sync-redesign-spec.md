# DSH Config Manager — 远程同步重构设计规格（方案 A）

> 本文档是「一键同步 + 自动同步 + 方案 A 重构」全部实现工作的唯一设计依据。
> 面向 host-engineer / client-engineer / reviewer 三份实现分工，覆盖现状、目标、API 契约、
> 后台调度、差异确认数据流、自动同步执行流程、同步历史 schema 扩展、测试计划。
>
> 缩写约定：
> - **host**：宿主插件进程（`src/index.ts` makeRoutes / SyncEngine / adapters）
> - **client**：浏览器半（`src/client/sync/*` React + `sync-api.ts`）
> - **IM**：`Importer`（`src/core/importer.ts`，内部 Analyzer 三段式 analyzeImport/createImportPlan/executeImportPlan）

---

## 1. 现状摘要

### 1.1 现有同步能力（m-sync-ui + m-sync-flow + m-git-channel + P2）

| 层 | 文件 | 能力 |
|---|---|---|
| 传输 | `src/sync/git/git-transport.ts` | `GitTransport` 实现 `SyncTransport` 契约；快照以「散文件目录」提交到 git 工作副本 `work/snapshots/<id>/`（t2 layout：`manifest.json` + 平铺 JSON + 文件类目录），每次 `sync: add/update snapshot <id>` 一次 commit + push；`list()` 先 `pullFromRemote()` 再读本地工作副本；**硬编码 `origin HEAD`**（push/delete 均 `push -u origin HEAD`，见 git-transport.ts L201/L232），无分支/ref 可配 |
| 引擎 | `src/sync/sync-engine.ts` | `SyncEngine`：`push`（export portable → 组装 `SyncSnapshot` → 本地散文件副本 → `transport.upload` → `recordBaseline`）；`pull`（`transport.list/download` → 过滤 portable → `snapshotToZip` → 复用 Importer 三段式预览差异，**绝不直接写配置**）；`merge`（三方合并）；`applyMergePlan`（写本地，自动应用计划）；`recordBaseline`（祖先基线 + sync-state） |
| 状态 | `src/sync/sync-state.ts` | `sync-state.json`，`schemaVersion=2`，`lastSyncAt` + 每分区 `hash/updatedAt` + `transport` + **`lastSnapshotId`（共同祖先指针）** |
| 配置 | `src/sync/sync-config.ts` | `sync-config.json`（`repoUrl/gitBin`，`validateRepoUrl` 拒绝对 URL 拼 token 的 userinfo 注入） |
| 合并 | `src/sync/merge.ts` | 三方合并（local/remote/ancestor）；**ancestor 缺失 → 退化为两方，local≠remote 视为整分区冲突**；JSON 分区按 top-level key 精细合并、FilesSection 按 relativePath 精细合并 |
| 风险 | `src/sync/risk.ts` | `SECTION_RISK_TIER` 静态分级（low/medium/high）+ `classifyMergePlan`（**firstSync 强制全部进 review**；非 firstSync 时 low 且无冲突 → autoApply 静默写） |
| 队列 | `src/sync/review-queue.ts` | `sync-review-queue.json` 待审队列；`enqueueItems` / `resolveItem` / `readReviewQueue` 原子读写 |
| 认证 | `src/sync/github-auth.ts` | GitHub OAuth device flow（start → 展示授权码 → poll → token 写入 DSH credentials，`SYNC_CREDENTIAL_REF`），token 永不进 argv/repoUrl/日志/浏览器 |
| 路由 | `src/index.ts` makeRoutes L1000-1702 | `sync/status`、`sync/push`、`sync/pull`、`sync/github/{start,poll,cancel}`、`sync/history`、`sync/apply`、`sync/rollback`；`makeSyncEngine` 每次请求新建 engine（GitTransport + SyncEngine）；`prepareSync` 解析 repoUrl/gitBin/token |
| UI | `src/client/sync/SyncSettingsView.tsx` 等 | 仓库表单 + push/pull 按钮 + **「自动应用（合并+写本地）」按钮** + GitHub 登录 + 同步历史 |

### 1.2 已知缺陷 / 待消除项

1. **`SyncPullPreviewView.tsx` 死代码**：被 `SyncSettingsView.tsx` L32 import，但**从未渲染**（仅 import，无 `<SyncPullPreviewView>` 节点）。其渲染模型 `pull-preview-model.ts`、测试 `SyncPullPreviewView.test.ts` 全为孤儿。→ **方案 A：整组删除**。
2. **review-queue 只写不读**：`readReviewQueue` / `resolveItem` 仅被测试引用；生产路径只经 `applyMergePlan` 失败时 `enqueueReviewItems` 写入，**没有任何路由读取/消费待审队列**，用户无法查看或解决待审项。待审项是死数据。
3. **「自动应用」按钮 + `POST /sync/apply` 存在「低风险静默写入」**：`classifyMergePlan` 在非 firstSync 时把 `SECTION_RISK_TIER=low` 且无冲突的 useRemote/keepLocal 项直接进 `autoApply` 静默写本地（`applyMergePlan` 全自动，无逐项确认）。这违反「同步必须用户可见确认」的意图。→ **方案 A：废弃该按钮 + 端点，由一键同步逐项确认替代**。
4. **`sync/apply` 自带 merge+classify+apply 一整条链**，与 `pull`（只预览）脱节：用户看不到 apply 到底要写什么就写了。
5. **历史语义弱**：`sync/history` 只列本地祖先快照目录（id/createdAt/sectionCount/reviewCount），不区分「推送 / 拉取 / 自动同步」来源，无自动同步执行记录。
6. **无后台调度**：一切同步都是用户手动触发；重启后无自动同步。
7. **无历史快照选择拉取**：`sync/pull` 虽支持 `snapshotId`，但无「远端历史快照列表」端点，UI 无法做「选择历史快照」下拉。

### 1.3 沿用且不动的部分（安全不变量）

- `includeSecrets=false` 恒成立 + SecretScanner 剥离 + 凭据分区结构性排除（`FORBIDDEN_SECTIONS`）。
- 远端快照 `containsSecrets=true` → 拒绝拉取/合并。
- 同步只走 `portableAdapters()`（`portability === 'portable'`：settings/ui/providers/plugins/prompts/skills/agentPresets）。
- token 只存 DSH credentials，不进 argv/repoUrl/commit/日志/浏览器；GitTransport 错误脱敏。
- Importer 三段式：`analyzeImport` / `createImportPlan` 零写入；`executeImportPlan` 必须 `confirm:true` 且先快照。

---

## 2. 目标方案总览

### 2.1 一键同步（手动，全流程用户可见）

```
连仓库 → 拉取最新/选历史快照 → 差异列表（逐项确认，默认「采用远端」可取消）
→ 冲突项内联弹窗解决（用本地 / 用远端 / 跳过）
→ 确认后逐项执行导入（apply-items）
```

- 一次拉取只产生一份**差异预览会话**（服务端在内存持有一份临时 ZIP + `ImportPlan`，配一个 `syncSessionId`），把「预览」和「逐项执行」解耦，避免重复拉取/重复 build ZIP。
- 每项默认 `useRemote`（采用远端），`Create/Update/Install` 等**默认勾选可取消**；`Conflict` 项强制内联弹窗选择后才能执行。
- 「选择历史快照」下拉读 `sync/snapshots-list`（远端已有快照，按 createdAt 倒序），选定后对该快照拉取预览。

### 2.2 自动同步（宿主后台，不依赖浏览器）

- 一个总开关同时控制上传 + 下载，统一间隔默认 30 分钟（可选 5/15/30/60 分钟 / 6/12/24 小时）。
- **DSH 启动时触发一次「自动下载合并（不上传）」**，带最小间隔阈值（默认 5 分钟，防频繁重启反复同步）。
- 流程：**双向** —— 先 pull 合并（预览差异），无冲突项才自动执行合并导入，再 push 上传本地改动。
- **遇冲突项跳过并写入同步历史标记**；**连续失败 3 次发一次通知**。
- **仅在「无冲突且无需人工干预」时才自动执行**——有冲突/缺失依赖/缺失密钥/Install/Error/路径问题等任一 `needsReview` 项，自动同步一律中止（跳过），不静默写。

### 2.3 方案 A 重构

- **删除**：`POST /sync/apply`、`SyncSettingsView` 的「自动应用」按钮、`SyncPullPreviewView.tsx` + `pull-preview-model.ts` + 相关测试；`classifyMergePlan` / `SECTION_RISK_TIER` 的「自动应用」分支不再被生产路由使用。
- **消除**：一切「低风险静默写入」路径——写入本地只经 `apply-items`（一键同步确认）或 `autosync run`（无冲突自动合并），两者都先出差异预览。
- `review-queue` 不再作为「自动应用失败落点」使用；其写入路径从 `applyMergePlan` 移除。待审语义改由**同步历史中的 skipped 标记**表达（见 §6）。

---

## 3. API 端点契约

> 全部端点挂在 `/api/dsh-config-manager/sync/*`，经 `guard`（loopback + 同源）+ 方法守卫；请求体超限 `MAX_JSON_BODY_BYTES`。
> token 仅经请求体（`prepareSync` 逻辑）写入 DSH credentials，响应永不回传。
> TS 类型建议集中定义于 `src/client/sync/sync-api.ts`（client 侧契约），host 半 `src/index.ts` 按此实现并 `import type` 复用（沿用现有惯例：`sync-engine.ts` 类型被 client type-only 引用）。

### 3.1 复用（不改契约）

| 端点 | 方法 | 用途 |
|---|---|---|
| `sync/status` | GET | 同步状态（配置/凭据/上次同步/分区数）——**新增响应字段见 §3.8** |
| `sync/push` | POST | 手动推送 |
| `sync/github/{start,poll,cancel}` | POST | GitHub OAuth device flow |
| `sync/rollback` | POST | 一键回滚（按 restoreId） |

### 3.2 新增：`GET /api/dsh-config-manager/sync/snapshots-list`

远端历史快照列表（供「选择历史快照」下拉）。

**响应 TS：**
```ts
interface SyncSnapshotsListResponse {
  ok: boolean;
  /** 按 createdAt 倒序（最新在前） */
  snapshots: SyncSnapshotLite[];
  /** 当前本地祖先指针（sync-state.lastSnapshotId），用于高亮当前基线 */
  currentSnapshotId?: string;
}
interface SyncSnapshotLite {
  id: string;                 // 快照 id
  createdAt: string;          // ISO-8601 UTC
  sectionCount: number;       // snapshot.manifest.sectionIds.length
  platform: string;           // snapshot.manifest.platform
  dshVersion: string;         // snapshot.manifest.dshVersion
}
```

**实现要点（host）**：`engine` 的 `transport.list()` 返回 `SyncSnapshotMeta[]`（按 createdAt 升序），倒序映射为 `SyncSnapshotLite`；`currentSnapshotId` 读 `loadSyncState(syncDir).lastSnapshotId`。若远端空 → `snapshots: []`。`repoUrl/gitBin` 取自请求体（同 `prepareSync`）或已保存 `sync-config.json`。

### 3.3 新增：`POST /api/dsh-config-manager/sync/sync`

一键同步第一步：**拉取 → 产出差异确认会话**（取代 `sync/pull` 在 UI 侧的独立用法，`sync/pull` 保留兼容但 UI 不再主用）。

**请求体 TS：**
```ts
interface SyncStartPayload {
  repoUrl: string;            // 必填（复用 prepareSync 校验）
  gitBin?: string;
  token?: string;             // 非空则先写入 DSH credentials
  /** 缺省 = 最新快照；传入则对该历史快照拉取 */
  snapshotId?: string;
}
```

**响应 TS：**
```ts
interface SyncStartResponse {
  ok: boolean;
  /** 差异确认会话 id：后续 apply-items / cancel 引用（host 内存登记，含临时 ZIP 路径 + ImportPlan） */
  syncSessionId: string;
  snapshotId: string;         // 被拉取的远端快照 id
  /** 逐项差异列表（供 UI 逐项确认） */
  items: SyncConfirmItem[];
  /** 是否包含任何需人工决策项（Conflict/Install/MissingSecret/MissingDependency/PathMapping/Error） */
  needsReview: boolean;
  /** 兼容性（复用 ImportAnalysis.compatibility） */
  compatibility: 'excellent' | 'good' | 'partial' | 'unsupported';
  message?: string;
}
/** 单条可确认的差异项（由 ImportPlan.item 投影 + 冲突详情） */
interface SyncConfirmItem {
  itemId: string;             // = PlanItem.id（稳定项 id，如 plugin:pkg / prompt:name / workspace:<id>）
  adapter: SectionId;
  kind: PlanItemKind;         // Create | Update | Install | Conflict | MissingSecret | MissingDependency | PathMapping | Warning | Error | Skip
  description: string;
  severity: 'info' | 'warning' | 'error';
  /** 默认采纳方向；Conflict/MissingSecret 等人工项默认 false */
  defaultAdopt: boolean;
  /** 用户最终决策（缺省 = defaultAdopt） */
  adopt: boolean;
  /** 冲突项内联解决所需详情（仅 Conflict 项非空） */
  conflict?: SyncConflictDetail;
  /** 该项若采用将写入的目标摘要（SnapshotTarget 投影，供回滚登记展示） */
  target?: { adapter: SectionId; ref: string };
}
/** 冲突项内联解决详情（来源 MergeConflict + 可读 diff） */
interface SyncConflictDetail {
  path: string;               // JSON top-level key 或 FilesSection relativePath；整分区冲突 '$'
  kind: 'key' | 'file' | 'section';
  local?: unknown;            // 本地当前值（JSON 键值；file 用可读文本预览，整分区用描述）
  remote?: unknown;           // 远端值
  ancestor?: unknown;         // 共同祖先值（若有）
  /** UI 渲染用的 diff 文本（复用 pull-preview-model 的 formatDiff 思路，host 侧生成） */
  diff?: string;
}
```

**host 实现要点**：
- `prepareSync(body)` 解析 repoUrl/gitBin/token → `makeSyncEngine(repoUrl, gitBin)`。
- `engine.pull({ snapshotId })` 复用现有逻辑：`transport.list/download → snapshotToZip → importer.analyzeImport + createImportPlan(strategy:'merge', resolutions:{}, pathMappings:[])`，得到 `analysis` + `plan`。
- 把临时 ZIP 路径 + `plan` + `analysis` 存入一个**内存 SyncSessionStore**（进程生命周期，如 RunRegistry 同模式），生成 `syncSessionId`（`randomUUID`）。
- 从 `plan.items` 投影出 `SyncConfirmItem[]`：`defaultAdopt` 对 `Create/Update/Install`（kind 非人工项）为 `true`，对 `Conflict/MissingSecret/MissingDependency/PathMapping/Error` 为 `false`。
- `Conflict` 项：从 `plan.items` 中该 `itemId` 的 `conflict?.resolution==='review'` 情形 +（可选）`engine.merge()` 的三方冲突详情组装 `SyncConflictDetail`。为减少额外往返，**优先复用 createImportPlan 的 Conflict item 本身**；若需三方精确 local/remote/ancestor，可调用 `engine.merge()` 补充（`merge` 已存在）。
- 临时 ZIP 生命周期随 session；session 过期（默认 30 分钟）或 cancel 时清理。

**SyncSessionStore**（host 新增模块，建议 `src/sync/sync-session.ts`）：
```ts
interface SyncSession {
  id: string;
  zipPath: string;            // 临时标准 ZIP（apply-items 复用 executeImportPlan 需要）
  plan: ImportPlan;
  analysis: ImportAnalysis;
  snapshotId: string;
  repoUrl: string;
  gitBin?: string;
  createdAt: number;          // epoch ms
  expiresAt: number;          // epoch ms（过期惰性清理）
}
class SyncSessionStore {
  set(id, session): void; get(id): SyncSession | undefined; delete(id): void; // 过期条目视为不存在
}
```

### 3.4 新增：`POST /api/dsh-config-manager/sync/apply-items`

一键同步第二步：**按用户对差异项的逐项决策执行导入**。

**请求体 TS：**
```ts
interface ApplyItemsPayload {
  syncSessionId: string;      // 引用 sync/sync 产生的会话
  /** 每项的最终采纳决策（仅包含用户实际采纳/修改过的项；未列出项视为 adopt=false） */
  adoptions: SyncItemAdoption[];
}
interface SyncItemAdoption {
  itemId: string;
  adopt: boolean;             // true = 采用（导入该项）；false = 跳过
  /** 冲突项解决方案（仅当该项是 Conflict 且 adopt=true 时必须） */
  resolution?: 'useRemote' | 'keepLocal' | 'skip';
}
```

**响应 TS：**
```ts
interface ApplyItemsResponse {
  ok: boolean;
  applied: string[];          // 实际写入的分区 id 列表（去重）
  skipped: string[];          // 未采纳的 itemId 列表
  needsRestart: boolean;
  warnings: string[];
  restoreId: string;          // 应用前快照 id（UI 一键回滚用；失败时仍透传以便排查）
  rolledBack: boolean;        // 任一失败是否整体回滚
  failed: { itemId: string; message?: string }[];
  result: ImportResult;       // 透传 executeImportPlan 结果（executed/needsRestart/warnings）
}
```

**host 实现要点**：
- `syncSessionStore.get(syncSessionId)` → 无/过期 → `400`（提示重新预览）。
- 从 session.plan.items 中选 `adoptions[itemId].adopt===true` 的子集 → 构造**子计划** `subPlan`（仅含采纳项，保持 APPLY_ORDER 顺序；`globalStrategy/pathMappings/needsRestart` 沿用 session.plan）。
- 对采纳项按 `resolution` 调整：`Conflict` 项 `resolution==='keepLocal'` → 从 subPlan 移除该 item（保持本地，不写）；`'useRemote'` → 保留 item（导入远端值）；`'skip'` → 移除。`resolution` 为空但 item 是 `Conflict` → `400` 拒绝（强制用户先在 UI 解决）。
- 复用 `engine.applyMergePlan` 的底层执行姿势（`backup.createSnapshot` 兜底 + `importer.executeImportPlan(confirm:true, rollbackOnError:true, onItem: runs.update)`），但**按 subPlan 执行**：构造临时 ZIP（仅含采纳项对应分区的 merged payload）→ `createImportPlan` → `executeImportPlan` → 成功后 `recordBaseline`。
  > 说明：更直接的方式是给 SyncEngine 新增 `applyItems(zipPath, subPlan, opts)`，内部封装「快照 → executeImportPlan → recordBaseline / rollback+标记」，避免 `applyMergePlan` 里 `SyncApplyPlan` 耦合。建议新增该引擎方法。
- 失败处理：`rollbackOnError=true` 任一失败 → 整体 rollback → `rolledBack:true`；**不再写 review-queue**，改为在同步历史追加一条 skipped/failed 记录（见 §7）。
- 成功后 `recordBaseline` 更新祖先指针到合并后快照；session 标记已消费（可 `delete` 或复用）。
- 复用 run-registry：`runs.register('sync-apply')` 防重复 + `/progress` 进度可见。

### 3.5 新增：`POST /api/dsh-config-manager/sync/cancel`

取消/清理差异确认会话（丢弃临时 ZIP，零副作用）。

**请求体 TS：** `{ syncSessionId: string }`
**响应 TS：** `{ ok: true }`

### 3.6 新增：`GET/POST /api/dsh-config-manager/sync/autosync`

自动同步配置读写（总开关 + 间隔 + 启动阈值）。

**GET 响应 TS：**
```ts
interface AutosyncStatusResponse {
  enabled: boolean;           // 总开关（同时控制上传+下载）
  interval: AutosyncInterval; // 统一间隔
  lastRunAt?: string;         // 最近一次自动同步执行（成功或跳过）时间
  lastRunStatus?: 'success' | 'skipped' | 'failed' | 'partial';
  lastRunMessage?: string;
  consecutiveFailures: number;// 连续失败计数（用于通知判定）
  /** 距上次自动同步已过 ms（host 计算，供 UI 倒计时/立即触发判断） */
  elapsedMs: number;
  /** 最近一次自动同步触发的同步历史条目 id（关联跳转） */
  lastRunHistoryId?: string;
}
type AutosyncInterval = '5m' | '15m' | '30m' | '60m' | '6h' | '12h' | '24h';
```

**POST 请求体 TS：**
```ts
interface AutosyncUpdatePayload {
  enabled: boolean;
  interval?: AutosyncInterval;    // 缺省保持现值
  /** 重启触发的「自动下载合并」最小间隔阈值（缺省保持现值） */
  startupMinIntervalMs?: number;
}
```
**POST 响应 TS：** `AutosyncStatusResponse`（更新后的配置 + 当前状态）。

**持久化**：新增 `sync-autosync.json`（`schemaVersion:1`），字段 `{ enabled, interval, startupMinIntervalMs, consecutiveFailures, lastRunAt, lastRunStatus, lastRunMessage, lastRunHistoryId }`。建议独立文件（与 `sync-config.json` 并列），语义清楚、schema 演进独立。读写模块 `src/sync/autosync-config.ts`（`readAutosyncConfig` / `writeAutosyncConfig`，原子写）。

**默认值**：`enabled=false`、`interval='30m'`、`startupMinIntervalMs=5*60*1000`（5 分钟）。

### 3.7 增强：`GET /api/dsh-config-manager/sync/history`

在现有祖先快照列表基础上，**追加自动同步执行记录**（双向合并、冲突跳过、失败/通知）。

**响应 TS（新增字段，`SyncHistoryEntry` 扩展）：**
```ts
interface SyncHistoryEntry {
  id: string;                 // 快照 id 或自动同步执行记录 id
  createdAt: string;
  /** 'push' | 'pull' | 'apply' | 'autosync'（新） | 'rollback' */
  kind: 'push' | 'pull' | 'apply' | 'autosync' | 'rollback';
  sectionCount?: number;      // 快照分区数（快照类）
  reviewCount?: number;       // 关联待审数（保留，读 review-queue 兼容）
  /** 自动同步记录字段（kind==='autosync' 时非空） */
  autosync?: AutosyncHistoryEntry;
}
interface AutosyncHistoryEntry {
  direction: 'pull' | 'push' | 'both';
  status: 'success' | 'skipped' | 'failed' | 'partial';
  /** 跳过原因（冲突项 / 缺失依赖 / Install / 错误 / 无远端 / 网络） */
  skipReason?: string;
  /** 被跳过的冲突分区 id（冲突跳过时列出） */
  conflictedSections?: SectionId[];
  appliedSections?: SectionId[];      // 本次自动合并实际写入的分区
  pushedSnapshotId?: string;          // 本次 push 产生的快照 id（direction 含 push 时）
  pulledSnapshotId?: string;          // 本次 pull 来源快照 id
  error?: string;                     // failed 时的错误摘要（脱敏）
  notifiedAt?: string;                // 连续失败 3 次通知时间
  failureCountAtRun: number;          // 本次触发时的连续失败计数
}
```
**响应结构**：`{ entries: SyncHistoryEntry[] }`（按 createdAt 倒序）。列表合并「本地祖先快照目录」+「`sync-history.json` 中的自动同步执行记录」两源，按 createdAt 倒序拼接。

### 3.8 废弃：`POST /api/dsh-config-manager/sync/apply`

- **删除**该路由（host makeRoutes 移除 `API.syncApply` 段，index.ts L1644-1673）。
- 删除 `API.syncApply` 常量、`sync-api.ts` 的 `apply` 方法与 `applyReport` UI 状态、`SyncSettingsView` 的「自动应用」按钮块（L409-463）。
- `ApplyReport` / `applyMergePlan`（`SyncApplyPlan` 形态）在引擎层**保留**（自动同步内部仍需「合并 + 写本地」的能力，但改为无冲突才自动、且走 `applyItems` 式执行，见 §6），**不再暴露为独立 UI 按钮/端点**。`classifyMergePlan` 的「自动应用」分支从生产调用链移除（仅测试保留）。

### 3.9 增强：`GET /sync/status` 新增响应字段

```ts
interface SyncStatusResponse {  // 现有字段不变，新增：
  autosync?: AutosyncStatusResponse;   // 自动同步当前状态（供 UI 顶部开关回填）
}
```

---

## 4. 后台调度设计（宿主进程）

### 4.1 所在层：宿主插件进程（Cordis `apply()` / `makeRoutes` 同进程）

- 自动同步**不依赖浏览器**：调度器挂在 host 侧，DSH 启动即随插件 `apply()` 生命周期常驻。
- 位置建议：`src/index.ts` `apply()` 内新建 `AutoSyncScheduler`（`src/sync/autosync-scheduler.ts`），并在 `makeRoutes` 之后 start。它共享 `host / adapters / syncDir / makeSyncEngine / credentials / runs / msg`。

### 4.2 生命周期

| 事件 | 行为 |
|---|---|
| `apply()` 挂载 | 创建 scheduler；`start()`：读 `autosync-config`；若 `enabled` 启动定时器（按 interval）；**无条件执行一次「启动触发下载合并」**（受 startupMinIntervalMs 阈值约束，见 §4.5） |
| 定时器到点 | 若 `enabled` 且无运行中任务 → 执行一次完整双向自动同步 |
| `ctx.effect` 清理（卸载） | `stop()`：清定时器、标记不再调度；正在执行的任务允许自然结束 |
| 运行中任务 | 用 `runs` 登记 `kind:'autosync'`（防重复：同 kind 已有 running → 本次跳过），`/progress` 可查 |

### 4.3 定时器

- 用 `setInterval`（ms 由 interval 换算：`5m=300000`、`15m=900000`、`30m=1800000`、`60m=3600000`、`6h=21600000`、`12h=43200000`、`24h=86400000`）。
- 每次触发前检查 `enabled` + 无同 kind running（`runs.getActive('autosync')` 为空），否则跳过本轮。
- 定时器句柄存于 scheduler 实例，`stop()` 时 `clearInterval`。

### 4.4 配置来源

- 配置存 `sync-autosync.json`（§3.6），经 `GET/POST /sync/autosync` 读写。
- 路由更新配置后需**通知 scheduler 重载**（重启定时器到新 interval、更新 enabled）——建议 scheduler 暴露 `reload()`，路由写完后调用；或 scheduler 每次触发前读盘（简单可靠，推荐「每次触发前读盘」避免并发同步问题）。
- 首次无文件 → 默认 `enabled=false, interval='30m', startupMinIntervalMs=300000`。

### 4.5 重启触发阈值（防抖）

- 每次成功/执行完成写 `autosync-config.lastRunAt`。
- 启动时读 `lastRunAt`；若 `now - lastRunAt < startupMinIntervalMs`（默认 5 分钟）→ **跳过启动触发的下载合并**（防频繁重启反复同步）。**注意**：总开关 `enabled=false` 时，启动触发不执行任何自动同步（启动触发本质是自动同步的首次唤醒，遵循总开关）。
- 该阈值可配（POST `/sync/autosync` 的 `startupMinIntervalMs`）。

### 4.6 防重复 / 并发

- 每次执行（启动触发 / 定时触发 / 手动调 `runNow`）前 `runs.register('autosync')`；同 kind running → `409` 语义内部跳过（不打搅用户）。
- scheduler 内部用 `running` 布尔 + `runs` 双保险。

### 4.7 通知

- 连续失败计数 `consecutiveFailures` 存 `autosync-config`。
- **达到 3 次** → 触发一次通知（`host.log.warn` + 可选浏览器通知/会话横幅）。DSH host 通知通道建议用 `host.log.warn` 保证有落点；若 host 暴露 UI 通知 API 则复用。记录 `notifiedAt`。
- 任一次成功 → 计数清零。

---

## 5. 差异确认数据流（预览 → 逐项执行）

### 5.1 完整数据流

```
[Client SyncSettingsView 一键同步按钮]
   │ POST /sync/sync { repoUrl, gitBin?, token?, snapshotId? }
   ▼
[Host sync/sync]
   prepareSync → makeSyncEngine → engine.pull({snapshotId})
     → transport.list/download → snapshotToZip(临时)
     → importer.analyzeImport + createImportPlan
   → 投影 SyncConfirmItem[] + needsReview + compatibility
   → SyncSessionStore.set(sessionId, {zipPath, plan, analysis, snapshotId})
   → 200 { syncSessionId, snapshotId, items[], needsReview, compatibility }
   ▼
[Client 渲染差异列表]
   每项：kindTag + description + severity + [采用远端 ☑(默认)] + 冲突详情
   Conflict 项：内联弹窗（用本地 / 用远端 / 跳过）
   「选择历史快照」下拉：GET /sync/snapshots-list → 选 id → 重新 POST /sync/sync{snapshotId}
   「取消」：POST /sync/cancel{syncSessionId}
   「确认导入」：收集 adoptions[] → POST /sync/apply-items
   ▼
[Host sync/apply-items]
   sessionStore.get(sessionId) → 按 adoptions 构造 subPlan
     (adopt=false 项剔除；Conflict+keepLocal 剔除；Conflict+skip 剔除；Conflict+useRemote 保留)
   engine.applyItems(zipPath, subPlan)
     → backup.createSnapshot → executeImportPlan(confirm, rollbackOnError, onItem:runs)
     → 成功: recordBaseline + 历史成功记录
     → 失败: rollback + 历史失败/skipped 记录
   → 200 { ok, applied[], skipped[], needsRestart, warnings, restoreId, rolledBack, failed[], result }
   ▼
[Client 渲染执行结果] + 可一键回滚（restoreId）
```

### 5.2 冲突内联解决如何表达

- **Client 侧**：每个 `SyncConfirmItem` 的 `conflict` 非空 → 该项渲染为「冲突卡片」，内联弹窗展示 `SyncConflictDetail.diff` / `local` / `remote`，用户三选一（`useRemote` / `keepLocal` / `skip`）。选择结果写入该 item 的 `resolution`。
- **Service 侧**：仅 `Conflict` 项且 `adopt=true` 时必须带 `resolution`；`keepLocal`/`skip` → 从 subPlan 剔除（不写本地）；`useRemote` → 保留（导入远端值）。`adopt=false` 的 Conflict 项 = 用户决定不处理（跳过）。
- 冲突详情来源优先级：优先复用 `createImportPlan` 里 `item.conflict?.resolution==='review'` 的 item 本身（description 已含差异摘要）；如需精确三方 local/remote/ancestor，host 在 `/sync/sync` 里追加调 `engine.merge()` 把 `MergeConflict[]` 并入 `SyncConflictDetail`。

### 5.3 Session 生命周期与并发

- 单实例内存 `SyncSessionStore`，进程生命周期；默认 TTL 30 分钟，过期惰性清理。
- 同一 session 只允许**一次** `apply-items`（消费后删除，防重复导入）；重复调用 → `400`。
- 一次 UI 一键同步只能有一个活跃 session（可选：client 在发起新 `/sync/sync` 前先 `cancel` 旧 session；host 也可在创建新 session 时清理同 key 旧 session）。

---

## 6. 自动同步执行流程（双向）

### 6.1 每次执行（启动触发 / 定时触发）统一流程

```
[AutoSyncScheduler.runOnce()]
  ├─ 读 autosync-config；若 !enabled → return（启动触发时也遵守）
  ├─ runs.register('autosync')（同 kind running → 本次跳过，不叠加）
  ├─ readSyncConfig → repoUrl 无 → 记录 skipped(未配置) → return
  ├─ makeSyncEngine(repoUrl, gitBin)
  │
  ├─【Phase A：pull 合并（下载）】
  │   engine.merge()   // 三方合并：local(现场export) vs remote(最新) vs ancestor(sync-state.lastSnapshotId 本地副本)
  │   → MergePlan
  │   └─ 判定 needsReview：
  │       任一 section decision==='conflict' 或 kind∈{MissingSecret,MissingDependency,Install,Error}
  │       → 自动同步中止：冲突项跳过 + 写历史 skipped + 记 conflictedSections[] → goto 结束
  │   → 无冲突：对 useRemote/keepLocal/自动合入项构造 merged 载荷
  │
  ├─【Phase B：写入本地（仅无冲突时）】
  │   engine.applyItems(临时ZIP, subPlan)（同 §3.4，confirm:true + backup + rollbackOnError）
  │   → 成功：appliedSections[] 记历史；失败：回滚 + 记历史 failed（计入连续失败计数）
  │
  ├─【Phase C：push 上传（direction=both 的完整双向；仅 pull 后无冲突且本地有变化时）】
  │   engine.push() → pushedSnapshotId → 记历史
  │   push 失败：计入连续失败计数（见 §6.3）
  │
  └─ 收尾：写 autosync-config（lastRunAt, lastRunStatus, consecutiveFailures, lastRunHistoryId）
```

### 6.2 「启动触发下载合并」变体

- 启动时只做 **Phase A + B（pull 合并，不上传）**，不做 Phase C push。
- 受 `startupMinIntervalMs` 阈值约束（§4.5）。
- 目的：重启后把远端最新改动并入本地，避免本地陈旧。

### 6.3 冲突跳过 + 记历史

- **冲突/人工项 → 不写本地、不 push**，仅写同步历史 `{kind:'autosync', status:'skipped', skipReason:'conflict', conflictedSections:[...]}`。**不计入连续失败**（跳过非失败）。
- 历史写入统一走新增 `sync-history.ts`（`appendAutosyncEntry`），存 `sync-history.json`（见 §7）。

### 6.4 连续失败计数 + 通知

- `consecutiveFailures` 只对**网络/传输/apply 真实失败**（Phase A/B/C 抛错或 `ok:false`）计数；skipped（未配置、冲突跳过、无远端）不计。
- 到 3 → 发通知（`host.log.warn`）+ 记 `notifiedAt`；成功清零。

### 6.5 与一键同步的互斥

- 自动同步执行时若用户手动同步进行中（`runs` 有 sync 相关 running）→ 跳过本轮（防 git 工作副本并发 pull/push）。
- 用户手动一键同步时若自动同步正在跑 → UI 显示「自动同步进行中」，手动操作排队或提示稍后。

---

## 7. 同步历史 schema 扩展

### 7.1 新增文件 `sync-history.json`（自动同步执行记录）

```ts
interface SyncHistoryFile {
  schemaVersion: 1;
  /** 自动同步执行记录，按 createdAt 升序追加 */
  autosyncEntries: AutosyncHistoryEntry[];   // 即 §3.7 的 AutosyncHistoryEntry
  updatedAt: string;
}
```
- 读写模块 `src/sync/sync-history.ts`：`readSyncHistory` / `appendAutosyncEntry`（原子写，同 review-queue 的临时文件+rename）。
- 裁剪策略：仅保留最近 N 条（建议 `AUTOSYNC_HISTORY_KEEP = 200`），防无限增长。

### 7.2 `sync-state.json` 不动

- `schemaVersion=2` 保持不变；`lastSnapshotId` 仍为共同祖先指针。自动同步的祖先更新仍走 `recordBaseline`。
- 现有 `sync-history` 端点的「本地祖先快照」部分继续读 `syncDir/snapshots/`（祖先副本目录），与 `sync-history.json` 合并展示。

### 7.3 `sync-autosync.json`（§3.6）

- `schemaVersion:1`，字段见 §3.6 的 `AutosyncStatusResponse` 持久化面（`enabled/interval/startupMinIntervalMs/consecutiveFailures/lastRunAt/lastRunStatus/lastRunMessage/lastRunHistoryId`）。

### 7.4 review-queue 去留

- **不再作为生产写落点**（从 `applyMergePlan` 移除 `enqueueReviewItems`）。
- 遗留的 `sync-review-queue.json` 历史文件：读侧保留兼容（`/sync/history` 的 `reviewCount` 仍读它），不主动写新数据；待审语义由历史 skipped 标记替代。

---

## 8. 测试计划

> 沿用现有 `node --test` + 内存 mock 模式（`MemSyncTransport`、`makeContext`、`MemSnapshotStore`）。

### 8.1 单元测试（新增）

| 模块 | 用例 |
|---|---|
| `sync-session.ts` | set/get/过期惰性清理/delete；同 id 覆盖；TTL 边界 |
| `autosync-config.ts` | 读写往返；缺省值；损坏 JSON 回退缺省；原子写 |
| `sync-history.ts` | append 升序；读不存在→空；损坏拒绝；裁剪 N 条 |
| `autosync-scheduler.ts` | 定时器间隔换算；enabled=false 不触发；同 kind running 跳过；startupMinIntervalMs 阈值（now-lastRunAt<阈值→跳过）；stop 清理定时器 |
| `autosync-flow.ts`（执行流程纯逻辑） | merge 无冲突→apply+push；有冲突→skipped+记 conflictedSections（不写本地不 push）；MissingDependency/Install 触发中止；连续失败 1/2/3→通知+notifiedAt；成功清零 |

### 8.2 引擎层测试（`sync-engine.test.ts` 扩展）

- `applyItems(zipPath, subPlan)`：只执行采纳项；Conflict+keepLocal 不写；Conflict+useRemote 写远端；成功→recordBaseline；失败→rollback+历史 failed（**不再写 review-queue**，断言 review-queue 不新增）。
- `pull({snapshotId})` 指定历史快照预览正确；快照选择列表映射（`snapshots-list` 投影）。

### 8.3 路由测试（`index.test.ts` / 集成风格）

- `POST /sync/sync`：返回 `syncSessionId + items + needsReview + compatibility`；Conflict 项 `defaultAdopt=false`；session 登记可被 `apply-items` 引用。
- `POST /sync/apply-items`：session 不存在/过期→400；同 session 二次执行→400；adoptions 缺 resolution 的 Conflict→400；正常执行→`applied/skipped/restoreId`。
- `GET /sync/snapshots-list`：空/非空/倒序/currentSnapshotId。
- `GET/POST /sync/autosync`：读写 + 状态计算（elapsedMs/consecutiveFailures）。
- `GET /sync/history`：合并祖先快照 + autosync 记录倒序。
- **`POST /sync/apply` 已删除**：断言路由不存在（404）。

### 8.4 客户端测试（`sync-view.test.ts` / `SyncHistoryView.test.ts` 扩展）

- 差异列表渲染模型：逐项默认采纳方向、冲突内联解决投影、needsReview 徽章。
- 一键同步交互流（纯函数部分）：选快照→预览→改 adoptions→apply。
- 自动同步开关 UI：enabled/interval 读写、倒计时、立即触发。

### 8.5 回归（不动项）

- push/pull/merge/recordBaseline 现有测试保持绿。
- GitHub OAuth 测试保持。
- 删除 `SyncPullPreviewView.test.ts` + `pull-preview-model.test.ts`（死代码随删）。

### 8.6 验收场景（对齐方案 A）

- **场景 X（一键同步逐项确认）**：远端有新增/更新/冲突 → UI 逐项默认采用远端，可取消；冲突项内联三选一；确认后只写采纳项；可一键回滚。
- **场景 Y（历史快照选择）**：snapshots-list 列出远端快照，选旧快照 → 对该快照预览/导入。
- **场景 Z（自动同步）**：开关开 → 30 分钟触发双向（pull 合并 + push）；启动时触发下载合并（受 5 分钟阈值）；有冲突 → 跳过 + 历史 skipped；连续 3 次失败 → 通知；无浏览器也执行。
- **场景 W（方案 A 清理）**：无「自动应用」按钮/`sync/apply`；无 `SyncPullPreviewView` 死代码；`review-queue` 不再被生产写入。

---

## 附录 A：文件改动清单（建议）

| 文件 | 改动 |
|---|---|
| `src/sync/autosync-config.ts` | 新增：自动同步配置读写 |
| `src/sync/sync-history.ts` | 新增：自动同步执行记录读写 |
| `src/sync/sync-session.ts` | 新增：差异确认会话内存存储 |
| `src/sync/autosync-scheduler.ts` | 新增：后台调度器（定时/启动触发/防抖/通知） |
| `src/sync/sync-engine.ts` | 新增 `applyItems(zipPath, subPlan, opts)`；`applyMergePlan` 移除 review-queue 写落点（改历史）；保留 push/pull/merge/recordBaseline |
| `src/index.ts` | 新增路由 `sync/snapshots-list` `sync/sync` `sync/apply-items` `sync/cancel` `sync/autosync`；删除 `sync/apply`；`sync/status` 增 autosync；`sync/history` 合并 autosync 记录；`apply()` 装配 AutoSyncScheduler |
| `src/client/sync/sync-api.ts` | 新增端点方法与类型；删除 `apply` |
| `src/client/sync/SyncSettingsView.tsx` | 一键同步流（预览+逐项确认+冲突弹窗+历史快照下拉）；自动同步开关；删除「自动应用」按钮块 |
| `src/client/sync/SyncPullPreviewView.tsx` / `pull-preview-model.ts` / `.test.ts` | **删除**（死代码） |
| 各 `.test.ts` | 按 §8 增删 |

## 附录 B：安全不变量（贯穿实现）

1. 远端快照 `containsSecrets=true` → 拒绝（沿用）。
2. 只同步 portable 分区（沿用）。
3. 写入本地必经 `executeImportPlan(confirm:true)` + 先快照（沿用）。
4. 自动同步只在「无冲突且无需人工干预」时写本地（新增约束）。
5. token 永不进 argv/repoUrl/commit/日志/浏览器/同步文件（沿用）。
6. 同步历史/autosync 配置不记录任何秘密值。
