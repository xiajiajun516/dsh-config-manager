# 配置市场「发布到市场」功能设计文档

> 日期：2026-08-19 · 状态：待评审 · 上游约束：[AGENTS.md](../../AGENTS.md)（安全不变量 / 分层纪律 / 文档规范）、[DESIGN.md](../../DESIGN.md)（Design System 唯一权威）、[marketplace.md 已删除](./)（2026-08-19 旧大写 Docs/ 清理，本文件为市场设计的新上游依据）

## 1. 背景与目标

dsh-config-manager 的配置市场（Market）当前是**内置单市场、只读、不可编辑**：

- 市场固定绑定创建者维护的公开只读仓库（`src/market/builtin.ts` 的 `BUILTIN_MARKET_URL`，默认 `https://github.com/xiajiajun516/dsh-config-market.git`）；
- `GitMarketReader` 只做 `clone --depth 1` + `pull --ff-only`，无任何写路径、无凭据；
- 用户只能浏览 / 下载 / 校验 / 导入条目，**无法发布自己的配置**。

用户需求：在 Market 面板新增一个**「发布到市场」（上传配置）**入口，让用户能把本地导出的配置分享给社区。

本文档回答产品形态决策（中心化直传 vs 去中心化引用），并给出选定方案的完整设计。

## 2. 方案选型

### 2.1 候选方案

**方案 A：中心化直传** —— 用户点按钮直接把 config.zip 推到官方市场仓库。

**方案 B：去中心化引用** —— 用户在自己的公开 git 仓库托管条目（manifest + config.zip），官方市场 index.json 只收录**下载引用**（条目级仓库 URL），下载时按条目从其仓库拉取。

### 2.2 对比

| 维度 | A 中心化直传 | B 去中心化引用（选定） |
|---|---|---|
| 安全不变量（市场无 secret / 零凭据） | ❌ 需写官方仓库凭据，直接违反 | ✅ 官方仓库保持只读零凭据 |
| 供应链模型（`needsReview` 恒 true） | ❌ 官方条目须豁免，等于改安全模型 | ✅ 警示恒展示，天然适配第三方来源 |
| 官方维护负担 | 审核 + 托管全部内容（存储/带宽/责任） | ✅ 只审核 index.json 引用，不托管内容 |
| 用户门槛 | 最低（一个按钮），但需官方开放写权限 | 中：建公开仓库 + push + 提交收录 |
| 实现成本 | 新增发布写路径 + 凭据管理 | 中：reader 支持条目级 repo + 发布向导 |
| 可扩展性 | 单官方仓库，无社区生态 | ✅ 多市场 / 社区市场 / 官方精选徽章 |

### 2.3 决策依据

1. **安全不变量是硬约束**：`src/market/security.ts` 的校验管线连 `containsSecrets=true` 的 zip 都拒绝（L105-107），整个市场通道设计为「公开仓库、无凭据、内容不可信」。A 方案需要 GitHub 写凭据，直接违反 `docs/design/marketplace.md §5.1`（该文档已删，但 `market-config.ts` / `types.ts` / `reader.ts` 注释仍引用其不变量）与 AGENTS.md「同步凭据走 DSH credentials 槽位引用」的纪律——且写凭据的回读值受 DSH 硬约束限制。
2. **A 的现实形态等于 B**：官方不可能给所有用户开放官方仓库写权限；A 落地必然是「fork 官方仓库 → 推自己的 fork → 提 PR → 官方合并」，与 B 的唯一区别是官方要不要把第三方内容拉进自己仓库托管。与其让用户维护 fork，不如让内容留在作者自己的仓库，官方只收录引用。
3. **B 与现有架构天然兼容**：
   - 校验是**内容级、与仓库位置无关**的（`validateMarketItem`：id 一致性 / SHA-256 / zip 加固 / 内部分区 / L2↔L3 交集），条目在哪个仓库都能验；
   - host 层 cache/work 已按 `urlHash(url)` 分目录（`src/index.ts` L1391-1396），**多仓库并存有基础设施**；
   - `MarketIndexItem` / `MarketItemManifest` 已有 `provenance.source` 字段（供应链来源展示位，`view.ts` `marketItemWarnings` 已投影）；
   - 供应链警示恒展示（`generateSupplyChainWarnings` / `needsReview` 恒 true）天然适配「条目来自第三方仓库」。

### 2.4 决策

**采用方案 B（去中心化引用 + 官方审核收录）。** 官方市场仓库只读不改；条目内容由作者自托管；官方只维护 index.json 引用。

## 3. 详细设计（方案 B）

### 3.1 数据模型：条目级来源仓库

`src/market/types.ts`：

```ts
export interface MarketIndexItem {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  updatedAt?: string;
  categories?: string[];
  /** 条目来源仓库 URL（发布者自托管）；缺省 = 市场仓库自身（兼容现状单仓） */
  repo?: string;
}
```

- `repo` 缺省时行为与现状完全一致（条目与 index 同仓）；
- `repo` 存在时必须过 `validateRepoUrl`（拒绝 userinfo / 非 http(s) git 地址），**只读拉取、永不注入凭据**；
- `MarketItemManifest` 不变（其 `provenance.source` 继续作为展示字段；`repo` 是**读取路由依据**，二者职责分离）。

### 3.2 GitMarketReader：按条目选择仓库

`src/market/reader.ts` 的 `readItemManifest` / `readItemZip` 增加可选 `repo` 参数：

```ts
readItemManifest(opts: { url: string; workDir: string; itemId: string; repo?: string }): Promise<{ text: string }>;
readItemZip(opts: { url: string; workDir: string; itemId: string; repo?: string }): Promise<{ data: Uint8Array }>;
```

实现要点：

- 实际读取目录 = `repo ?? url`，即条目仓库与市场仓库不同时，clone/pull **条目仓库** 到该仓库自己的 workDir（host 层 `marketWorkDir(repoUrl)` 已按 url hash 分目录，天然隔离）；
- `index.json` 永远从市场仓库读（不变）；
- 校验 `repo` 合法性在 host 路由层完成（见 3.3），reader 只做读路径；
- 每条目按需 clone 会导致条目仓库数量增长：workDir 保留策略（LRU 清理 / 上限个数）见 §5 风险项，本期可先不做自动清理（单仓库体积 `--depth 1` 可控，条目仓库由官方审核控制数量）。

### 3.3 host 路由改动

`src/index.ts` market 段（L2557-2710）：

| 路由 | 改动 |
|---|---|
| `market/browse` | 透出条目来源标记：`MarketListItem` 增加 `repo` 字段（来自 index item），UI 据此显示来源徽章 |
| `market/download` | body 增加可选 `repo`；有则用条目仓库拉 manifest/zip（校验后 `provenance.source` 展示不变） |
| `market/refresh` | 不变（只拉市场 index） |
| `market/status` | 不变 |

安全：

- `repo` 必须通过 `validateRepoUrl`（复用 `sync-config.ts`），拒绝 userinfo；
- 供应链警示文案将包含条目仓库 URL（复用 `marketItemWarnings` 的 `supplySource` 投影）；
- 下载校验管线（`validateMarketItem`）完全不变——校验与仓库位置无关。

### 3.4 发布向导（UI：「发布到市场」按钮）

新增 `src/client/market/PublishView.tsx`（React 壳）+ `src/ui/market-publish.ts`（纯函数控制器，node 可测），状态组件内自持（同 MarketPanel 策略，不进 sessionStorage）。流程分 5 步：

1. **选择配置包**：复用现有导出产物（用户先走 Export tab 导出 zip，或本地选择文件）。零新增导入逻辑。
2. **本地校验（零写入）**：复用现有 `POST /api/dsh-config-manager/upload` + importer 的 `analyzeImport`（dry-run）确认内容合法；**强制检查不含 secrets**（`containsSecrets=true` 直接拒绝，市场通道永不携带秘密——与 `security.ts` L105-107 同款硬约束）。
3. **生成条目包**（host 端新端点 `POST /market/prepare`，纯内存计算 + 受控临时区落盘）：
   - `items/<id>/config.zip`（即所选导出 zip，校验 SHA-256）；
   - `items/<id>/manifest.json`：`schemaVersion=1`、`id`（按 `SAFE_ITEM_ID_RE` 生成或用户输入）、`name`/`description`/`author`/`categories` 由用户填写、`sections` 取自内部 manifest、`checksums.zip` = 实算 SHA-256、`provenance.source` = 用户仓库 URL；
   - 输出「发布目录」打包下载（或直接在 UI 展示目录结构 + 文件内容供复制）。
4. **引导推送到作者仓库**：展示 `git` 命令模板（clone 空仓库 / 复制 items/<id>/ 目录 / add / commit / push），用户在自己的公开仓库完成托管。**插件不做任何 git 写操作、不持有凭据**（同 About 页「Star 由用户在 GitHub 完成」的产品纪律）。
5. **提交收录申请**：展示「提 PR」指引（fork 官方市场仓库 → 在 index.json 的 `items[]` 追加一条含 `id` + `repo` 的引用 → PR）或收录申请表单（收集 id + repo 提交 issue/表单，由创建者人工合并）。**收录始终人工审核**，官方 index.json 只收录合法引用。

新 host 端点汇总：

| 端点 | 说明 | 安全 |
|---|---|---|
| `POST /market/prepare` | 由上传 zip 生成条目包（manifest + checksums + 发布目录） | 纯内存 + 受控临时区；含 secrets 拒绝；不写配置 |

### 3.5 收录流程（人工审核）

- 官方仓库 `index.json` 的 `items[]` 新增条目格式：

```json
{
  "id": "my-settings",
  "name": "我的设置包",
  "description": "...",
  "author": "xiaojun",
  "version": "1.0.0",
  "updatedAt": "2026-08-19T00:00:00.000Z",
  "categories": ["settings"],
  "repo": "https://github.com/xiaojun/dsh-config-market-items.git"
}
```

- 合并 PR 前创建者核对：`repo` 合法、`id` 过 `SAFE_ITEM_ID_RE`、`items/<id>/manifest.json` 与 config.zip 存在（可选：CI 自动跑 `validateMarketItem` 做预检，本期不做，列为后续增强）。
- 作者后续更新条目 = push 自己仓库，用户下载时 `pull --ff-only` 自动拿到新版本，官方零维护。

### 3.6 安全分析

| 威胁 | 缓解（全部复用现有能力） |
|---|---|
| 恶意条目进官方 index | 人工审核收录 + index.json 字段白名单解析（`index-parser.ts`） |
| 条目仓库被篡改（checksums 不符） | `validateMarketItem` 第 3 步 SHA-256 校验 → invalid 拒绝 |
| zip 炸弹 / Zip Slip | `parseZipHardened` + 64MB 上限（`MAX_MARKET_ZIP_BYTES`） |
| 条目含 secrets | `security.ts` L105-107 `containsSecrets=true` 拒绝 + 发布向导强制检查 |
| `repo` 注入凭据 / 路径穿越 | `validateRepoUrl`（拒绝 userinfo）+ `assertSafeItemId` |
| 供应链信任被滥用 | 警示恒展示（`needsReview` 恒 true），逐分区批准不变 |
| 官方仓库被写 | **不新增任何写路径、不持有凭据**（结构性防御） |

安全不变量零破坏：无 secret 新增、无凭据落盘、零写入到配置、供应链警示恒展示。

## 4. 实现清单

### 阶段 1（核心，最小可用）

1. `src/market/types.ts`：`MarketIndexItem.repo`、`MarketListItem.repo`、`MarketItemDetail` 增加 `repo?`。
2. `src/market/reader.ts`：`readItemManifest` / `readItemZip` 支持 `repo` 参数。
3. `src/market/index-parser.ts`：index.json 字段白名单加入 `repo`（`validateRepoUrl` 校验，非法条目丢弃）。
4. `src/index.ts`：`market/browse` 透出 `repo`；`market/download` 接受并校验 `repo`。
5. `src/client/market/MarketPanel.tsx`：条目卡片显示来源徽章（官方 = `isOfficialMarket(item.repo ?? BUILTIN_MARKET_URL)` / 第三方）。
6. locale：`market-locales.ts` 新增来源徽章 / 发布向导键（zh 源 / en 镜像）。
7. 测试：`reader` 多仓库单测、`index-parser` 白名单单测、`market.test.ts` 扩展。

### 阶段 2（发布向导）

8. `src/ui/market-publish.ts` 纯函数控制器：条目包生成模型 / 校验模型 / git 命令模板渲染（node 单测）。
9. `src/index.ts`：`POST /market/prepare` 端点。
10. `src/client/market/PublishView.tsx` + `market-api.ts` 扩展。
11. `DESIGN.md` 记录新增 UI Pattern（发布向导 / 来源徽章）。

### 阶段 3（后续增强，本期不做）

- 收录申请表单落库 / GitHub issue 模板预填；
- 官方 index.json 收录 CI 预检（自动跑 `validateMarketItem`）；
- 条目仓库 workDir LRU 清理与配额；
- 社区市场 / 多市场支持（`MarketSummary` 已是列表形状，底层 url-hash 已分目录）。

## 5. 风险与限制

| 风险 | 说明 / 缓解 |
|---|---|
| 用户门槛高于一键直传 | 产品取舍：安全不变量优先；发布向导用「复制 git 命令 + PR 模板」把门槛降到最低 |
| 条目仓库数量增长 | 官方审核控制收录数量；`--depth 1` 控制体积；workDir 清理列为阶段 3 |
| 条目作者删除仓库 | 下载时 clone 失败 → 报错并可提示「条目已失效」，index 引用由官方清理 |
| 同 id 冲突 | 官方审核时人工核对；`assertSafeItemId` 保证路径安全 |
| 凭据类内容误发布 | 发布向导强制 `containsSecrets` 检查拒绝（与市场下载校验一致） |

## 6. 明确不包含

- ❌ 不做中心化直传（方案 A）：不新增官方仓库写路径、不引入 GitHub 凭据/OAuth
- ❌ 不做私有/鉴权市场（二期再说：token credential helper）
- ❌ 不改下载侧安全模型：供应链警示恒展示、`needsReview` 恒 true、逐分区批准
- ❌ 不引入新依赖（git 命令执行复用现有 `execFile` 封装层）
- ❌ 不重新设计既有 Market 面板外观（沿用 Card / Badge / Button 原语）
