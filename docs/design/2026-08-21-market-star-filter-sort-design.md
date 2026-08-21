# 市场页「仓库级 Star 展示 + 来源筛选 + 排序」设计文档

> 日期：2026-08-21 · 状态：**设计稿（待评审）** · 上游约束：
> [AGENTS.md](../../AGENTS.md)（安全不变量 / UI 分层纪律 / 文档规范）、[DESIGN.md](../../DESIGN.md)（Design System 唯一权威）、
> [2026-08-20-my-configs-design.md](./2026-08-20-my-configs-design.md)（「一键上传 / 我的配置」既有实现）、
> [2026-08-19-market-publish-design.md](./2026-08-19-market-publish-design.md)（条目级 `repo` 去中心化引用）

## 1. 背景与目标

### 1.1 现状

市场页（`MarketPanel.tsx`）浏览列表目前只有：
- 🔍 搜索框（name / author / description 子串匹配）
- 📂 类别下拉框（categories）
- 🏷️ 来源徽章（官方 ok / 第三方 warn）——**只能看，不能筛**
- **无排序**（按 index.json 原始顺序）

「我的配置」（`MyConfigsView.tsx`）列表无任何热度信息。

### 1.2 产品目标（用户拍板）

1. **市场浏览列表显示每个条目的 star 数量**（⭐ N）；
2. **star 采用「仓库级」语义**（用户已确认）——star = 条目来源仓库的 star 数，**不是**条目级计数；
3. **新增来源筛选下拉框**：「全部 / 官方配置 / 个人配置」（用户确认用下拉框）；
4. **新增排序下拉框**：「默认 / 最新更新 / ⭐ 最多 / 名称 A–Z」（用户确认用下拉框）；
5. **「我的配置」页顺手显示自己仓库的 star**（激励反馈）。

## 2. 关键概念与决策

### 2.1 star 的「仓库级」语义（用户确认）

GitHub 的 star 是**仓库级**的，不是条目级的。当前市场模型（去中心化引用）：

| 条目类型 | 判定依据（`repo` 字段） | star 来源仓库 |
|---|---|---|
| 官方配置 | `repo` 缺省（= 官方市场仓库自身）或 = 官方地址 | `xiajiajun516/dsh-config-market`（**所有官方条目共享同一数字**） |
| 个人配置 | `repo` 存在且非官方地址（= 作者自托管仓库） | 作者的 `<login>/dsh-configs`（**同一作者的多条目共享同一数字**） |

展示上需用小字注明「来源仓库」，避免用户误以为「这个配置被单独点了 N 次」。

### 2.2 star 获取方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| **A（选定）：GitHub REST API 运行时查询 + Host 缓存** | `GET /repos/{owner}/{repo}` → `stargazers_count`；按仓库去重 + TTL 缓存 | ✅ 数据最新、不动官方仓库格式与 CI；未登录匿名限额 60 次/小时对去重后的仓库数绰绰有余 |
| B：写入 index.json | 发布时快照 star | ❌ star 是动态数据会过期；牵动 index.json 白名单 / schema / dsh-config-market CI |
| C：shields.io 徽章图 | `<img>` 直显 | ❌ 依赖第三方、有缓存延迟、样式与现有徽章体系不统一 |
| D：抓取 GitHub 网页 | HTML 抠数字 | ❌ 结构脆弱、可能触发反爬 |
| E：GraphQL | 需强制 token | ❌ 未登录不可用 |

**关键安全决策**：`/market/browse` 端点**一律匿名查询 star，不触碰任何 token**（市场端点「无凭据」是既有硬不变式，market-api.ts 头注释明确「不接收/不回传任何 token」）。匿名 60 次/小时 + 按仓库去重 + 1 小时 TTL 足够；「我的配置」页因已登录（`/me/*` 本来就要 token），用自己的 token 查自己的仓库（5000 次/小时）。

### 2.3 去重与限额核算

一次浏览要查的仓库数 = 条目来源仓库**去重**后的数量：

- 所有官方条目 → 1 个仓库（官方市场仓库），查 **1 次**；
- 个人条目 → 每作者 1 个 `dsh-configs` 仓库，每作者查 **1 次**。

例如 50 个条目、10 个作者 → 约 11 次查询。叠加 1 小时 TTL：一小时打开页面 100 次也只消耗约 11 次额度，远低于 60 次/小时限额。

## 3. 详细设计

### 3.1 Host 侧

#### 3.1.1 `src/market/github-repos.ts`：新增 `getRepoStars()`

在 `GitHubAuthRest` 增加方法（REST 薄客户端已有 `request` 管道，直接复用）：

```
getRepoStars(owner, repo): Promise<number | null>
```

- `GET /repos/{owner}/{repo}`，解析 `stargazers_count`（非负整数）；
- 404 / 仓库不存在 → 返回 `null`（展示层显示「—」）；
- 其他错误 → 抛 `GitHubApiError`（由调用方按失败降级处理）。

#### 3.1.2 新增 `src/market/repo-url.ts`：GitHub 仓库 URL 解析（纯函数）

```
parseGitHubRepoUrl(url): { owner, repo } | null
```

- 仅接受 `https://github.com/<owner>/<repo>` 形态（可带 `.git` 后缀）；
- 非 `github.com` 域名（GitLab 等，`validateMarketRepoUrl` 只要求 http(s)）→ 返回 `null` → 该条目 star 显示「—」；
- 输入 URL 已过 `validateRepoUrl`（拒绝 userinfo），解析过程零凭据。

#### 3.1.3 新增 `src/market/star-cache.ts`：仓库 star 缓存（Host 侧）

```
class StarCache {
  get(url): Promise<number | undefined>   // undefined = 无数据（未查过/查询失败）
}
```

- **按仓库 URL 去重**：一次 browse 中同一 URL 只查一次 GitHub；
- **内存缓存 + TTL 1 小时**（进程内存，dsh 重启后自然清空，无需落盘）；
- **查询失败降级**：单个仓库失败不影响其他条目（Promise.allSettled 聚合），失败的条目 star 显示「—」，下轮自然重试；
- 只缓存 `number`（star 数），不含任何凭据/URL 敏感内容，无需脱敏。

#### 3.1.4 `src/index.ts`：`/market/browse` 返回带 star 的列表

- 现有 browse 逻辑（L2801-2836）构造 `items: MarketListItem[]`；
- 改造：遍历前先收集所有条目 `repo ?? 市场URL` 去重集合 → 逐仓库查 `StarCache` → 把 `stars` 并入每条 `MarketListItem`；
- **零凭据**：匿名 `fetch`（`getRepoStars` 用 `GitHubAuthRest` 但 tokenProvider 可注入空 token 的匿名模式，或单独实现匿名查询小函数——实现时二选一，保证 browse 不碰凭据槽）。

#### 3.1.5 `src/market/my-repo.ts`：`listItems()` 顺带返回自己仓库 star

- `listItems` 已登录（`rest.getUser()`），返回 `MyItemEntry`；
- 加一步：`rest.getRepoStars(login, USER_CONFIGS_REPO)`（用已登录 token，5000/h）→ `entries[].stars`。

### 3.2 类型变更（`src/market/types.ts` / `my-repo.ts`）

| 类型 | 新增字段 | 说明 |
|---|---|---|
| `MarketListItem` | `stars?: number` | 浏览列表条目；`undefined` = 无数据（查询失败/非 github 仓库），UI 显示「—」 |
| `MyItemEntry` | `stars?: number` | 「我的配置」条目；同上 |

可选字段 → 旧持久化数据（sessionStorage 里的旧 items 缺 `stars`）兼容，无需迁移。

### 3.3 Client 侧

#### 3.3.1 `src/client/market/market-view.ts`：新增纯函数（node 可测）

```
type SourceFilter = 'all' | 'official' | 'personal'
type SortKey = 'default' | 'updatedAt' | 'stars' | 'name'

filterMarketItems(items, query, category, source)   // 扩展现有函数，加 source 参数
sortMarketItems(items, sortKey): MarketListItem[]    // 新函数
```

排序规则（稳定性 + 确定性）：
- `updatedAt`：降序（最新在前）；无 `updatedAt` 的排最后；
- `stars`：降序；`stars` 为 `undefined` 的排最后；
- `name`：升序 A–Z（localeCompare）；
- `default`：保持原顺序（index 顺序）。

来源判定复用现有 `isThirdPartyItem(item, builtinUrl)`（`sourceBadgeKind` 已实现：`repo` 缺省或官方地址 = 官方，否则个人）。

#### 3.3.2 `src/client/market/MarketPanel.tsx`：UI 装配

- 工具栏扩为一行：搜索框 + 类别下拉 + **来源下拉**（全部/官方/个人）+ **排序下拉**（默认/最新更新/⭐ 最多/名称）；
- 卡片上在来源徽章旁显示 **⭐ N** 徽章（`stars` 有值时），带 title 提示「来源仓库 star 数」；
- `source` / `sortKey` 加入 `MarketUiState` 与 `MarketStoreSlice`（持久化：切 tab / 刷新不丢，与现有 search/category 同纪律）。

#### 3.3.3 `src/client/market/MyConfigsView.tsx`：已上传列表显示自己仓库 star

- 登录卡区域或列表顶部显示「⭐ N（你的配置仓库）」；
- `MyItemView` 加 `stars` 投影（`my-configs-view.ts`）。

#### 3.3.4 `src/client/market/market-locales.ts`：新文案（zh 源 / en 镜像）

```
list.sourceAll     全部来源 / All sources
list.sourceOfficial 官方配置 / Official
list.sourcePersonal 个人配置 / Community
list.sortDefault   默认排序 / Default
list.sortUpdated   最新更新 / Recently updated
list.sortStars     ⭐ 最多 / Most starred
list.sortName      名称 A–Z / Name A–Z
list.stars         ⭐ {count}（title=来源仓库 star 数）
```

### 3.4 不改动的地方（刻意保持）

- **官方仓库格式 / index.json / schema / dsh-config-market CI**：零改动（方案 A 的核心收益）；
- **安全不变量**：browse 不碰 token；star 数字非敏感可回传；repo URL 仍过 validateRepoUrl；
- **下载 / 导入链路**：不动；
- **DESIGN.md**：无新视觉 Pattern（沿用现有 Badge / 下拉框 / statRow 布局），若实现中发现需要新样式再按「Missing Design Rule」流程补文档。

## 4. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/market/github-repos.ts` | 新增 `getRepoStars()`（+ 匿名查询模式） |
| `src/market/repo-url.ts`（新） | `parseGitHubRepoUrl()` 纯函数 |
| `src/market/star-cache.ts`（新） | `StarCache`（去重 + TTL + 失败降级） |
| `src/market/types.ts` | `MarketListItem.stars?` |
| `src/market/my-repo.ts` | `MyItemEntry.stars?`；`listItems()` 加查自己仓库 star |
| `src/index.ts` | `/market/browse` 注入 stars |
| `src/client/market/market-view.ts` | 扩展 `filterMarketItems` + 新增 `sortMarketItems` |
| `src/client/market/MarketPanel.tsx` | 两个下拉框 + ⭐ 徽章 + 状态持久化 |
| `src/client/market/MyConfigsView.tsx` / `my-configs-view.ts` | 显示自己仓库 star |
| `src/client/market/market-locales.ts` | 新文案 zh/en |
| `src/client/run-store.ts` | `MarketStoreSlice` 加 `source` / `sortKey` |

## 5. 测试计划

| 文件 | 用例 |
|---|---|
| `github-repos.test.ts` | `getRepoStars`：200 → stargazers_count；404 → null；脱敏错误 |
| `repo-url.test.ts`（新） | github.com 正常 / `.git` 后缀 / 非 github 域名 / 非法 URL |
| `star-cache.test.ts`（新） | 去重只查一次、TTL 过期重查、单仓库失败不影响其他 |
| `market-view.test.ts` | `filterMarketItems` source 过滤；`sortMarketItems` 四键 + undefined 排尾 + 稳定性 |
| `my-configs-view.test.ts` | `MyItemView.stars` 投影 |

验证命令：`npm run typecheck` + `npm test` + `npm run build`（动了 client/样式）。

## 6. 明确不做（本期范围外）

- **条目级 star / 点赞计数**：需自建计数体系 + 防刷，工程量数倍，用户已确认仓库级即可；
- **下载量统计**：GitHub 无免费数据源，需自建后端；
- **star 历史趋势 / 排行页**：无数据源；
- **shields.io 等第三方徽章**：样式不统一且依赖外部服务。
