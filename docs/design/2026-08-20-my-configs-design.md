# 配置「一键上传 / 查看 / 更新」功能设计文档（个人公开仓库 + 自动 PR）

> 日期：2026-08-20 · 状态：**已实施（2026-08-20）** · 上游约束：
> [AGENTS.md](../../AGENTS.md)（安全不变量 / UI 分层纪律 / 文档规范）、[DESIGN.md](../../DESIGN.md)（Design System 唯一权威）、
> [2026-08-19-market-publish-design.md](./2026-08-19-market-publish-design.md)（发布向导与去中心化引用方案的既有设计）

## 1. 背景与目标

### 1.1 现状痛点

dsh-config-manager 的「发布到市场」向导（`src/client/market/PublishView.tsx`，5 步）目前只做到「生成条目包 + 给出手动操作指引」：

1. 选配置包（zip）✓ 方便
2. 本地 8 道校验 + 秘密扫描 ✓ 方便
3. 填表单 → 生成 manifest / SHA-256 / 分区 ✓ 方便
4. **复制 git 命令，用户需自己在终端敲命令推送** ✗ 门槛高
5. **手动 fork 官方市场仓库、改 index.json、网页上提 PR** ✗ 门槛更高

对非开发用户来说，最后的「推送 + 提 PR」两步基本不可用。

### 1.2 产品目标（用户原话整理）

1. 用户**登录自己的 GitHub 账号**（无感授权，不填密码）；
2. 点击上传后**一键**把配置上传到 GitHub 仓库，**没有仓库则自动创建**；
3. 仓库结构**支持多个配置**（一个仓库放多个配置包）；
4. 提供一个地方**查看已上传的配置（读取仓库）**；
5. 可以**一键更新**已上传的配置；
6. 上传完成后**自动向 `xiajiajun516/dsh-config-market` 提交收录 PR**（合并后即进入官方市场，供所有人下载）；
7. **目标仓库固定**：收录/上传相关目标固定为 `xiajiajun516/dsh-config-market`（写死在代码常量中，**界面不提供任何修改入口** —— "用户不能手动更改"）；
8. **元数据全自动**：凡是系统可自动生成/更新的信息（id / author / version / updatedAt / sha256 / sections / manifest.json / index.json 条目）一律由系统生成与更新，用户只需填少量描述性内容。

### 1.3 目标用户

配置作者（不限于开发人员）：登录 GitHub → 选包 → 填几个字段 → 点上传，其余全部自动。

## 2. 方案选型

### 2.1 候选方案

**方案 A：直推官方市场仓库** —— 用户一键把条目直接写进 `xiajiajun516/dsh-config-market`（若拥有写权限）。

**方案 B（选定）：个人公开仓库托管内容 + 自动 PR 收录** —— 配置本体（items/ + index.json）写入**上传者自己的公开仓库**；官方市场 `index.json` 只收录带 `repo` 字段的引用条目；插件自动完成 fork → 改索引 → 提 PR。

### 2.2 对比

| 维度 | A 直推官方仓库 | B 个人仓库 + 自动 PR（选定） |
|---|---|---|
| 与现有「去中心化引用」设计（market-publish-design §2） | 冲突：官方仓库将混入多方内容，丧失「只读零凭据」模型 | ✅ 一脉相承：内容留在作者仓库，官方只收录引用 |
| 多人上传的隔离 | ✗ 全混在一个官方仓库，无归属边界 | ✅ 每作者一个仓库，归属清晰 |
| 内容管理权（下线/改版/删除） | ✗ 作者无控制权 | ✅ 作者拥有自己的仓库 |
| 收录流程 | 需开放官方写权限或 PR | ✅ PR（GitHub 天然协作机制）+ CI 自动校验 |
| 用户门槛 | 低（若官方开放写权限） | 低（上传后插件代劳 fork/PR） |
| 安全 | 官方仓库写路径 + 凭据面扩大 | ✅ 沿用现有「官方仓库零凭据只读」不变量；写凭据仅作用于作者自己的仓库与 fork |

### 2.3 决策依据

1. **与现有设计一致**：[2026-08-19-market-publish-design.md](./2026-08-19-market-publish-design.md) 已选定「去中心化引用」（官方 index 条目级 `repo` 字段，下载时按条目从作者仓库 clone）。本设计只是把「作者手动 push + 手动提 PR」升级为「插件自动 push + 自动提 PR」，**数据模型与读取路径零改动**。
2. **安全边界清晰**：写凭据（GitHub token）只作用于「作者自己的仓库 + 作者自己的 fork + PR」，不再需要官方仓库写权限；官方仓库保持只读零凭据。
3. **用户需求原话**即方案 B：「上传配置到 github 仓库，如果没有仓库就会自动生成」「自动提交 pr 到我的 dsh-config-market」。

### 2.4 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| GitHub 登录 | 复用现有 **device flow**（`src/sync/github-auth.ts` + `src/index.ts` 内置 `DEFAULT_GITHUB_CLIENT_ID`） | 零配置开箱即用；token 存入现有凭据槽（与 git 同步共用），无新增认证面 |
| 内容推送 | 复用 **GitTransport**（clone 工作副本 → 写文件 → commit → push） | token 经 credentials resolve、不落盘不泄漏；无 GitHub API 单文件大小限制 |
| 元操作（建仓 / fork / PR / 查状态） | 新增 **GitHub REST 薄客户端**（注入 fetch，可单测） | REST 没有本地 git 依赖，天然适合账户级操作 |
| 自动 PR 分支 | 固定分支 `dsh-market-sync/<itemId>` | 同一条目反复更新复用同一分支：PR 未合并 → force push 即自动更新 PR；已合并 → 基于最新 main 重开 PR |
| 官方收录条目 | 带 `repo` 字段的自托管引用（version/updatedAt/checksum 同步自 manifest） | 完全走现有 `INDEX_ITEM_ALLOWED` 白名单 + `validateMarketRepoUrl` |
| 目标仓库 | **固定 `xiajiajun516/dsh-config-market`**（硬编码常量，与内置市场同一仓库） | 不提供任何手动配置项，用户不可更改 |
| 用户输入最小化 | 仅 `name`（可改预填）/ `description`（可选）/ `categories`（可选） | id / author / version / updatedAt / manifest / index 条目全部系统自动生成与更新 |

## 3. 背景资产盘点（全部复用，无重复造轮子）

| 资产 | 位置 | 在本设计中的用途 |
|---|---|---|
| GitHub device flow（客户端 + DeviceFlowStore + 测试） | `src/sync/github-auth.ts` | 登录：`startDeviceFlow` / `pollForToken` |
| 登录 UI 交互模式（发起 → 展示用户码 → 轮询 → 成功） | `src/client/sync/SyncSettingsView.tsx` + `src/client/sync/sync-api.ts`（`githubStart`/`githubPoll`/`githubCancel`） | 前端直接复用同一组路由做登录卡 |
| 凭据槽 + token resolve | `src/index.ts` L1385-1400（`credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))`） | REST 客户端与 GitTransport 的 token 来源，值永不回传浏览器 |
| GitTransport（认证推送） | `src/sync/git/git-transport.ts` | 写「用户仓库」与「fork 分支」的内容 |
| 发布校验（8 道 + 秘密扫描） | `src/market/prepare.ts` + 路由 `/market/prepare` | 上传与 PR 前的强制安全闸门 |
| 条目级 repo 自托管读取 | `src/market/reader.ts`（`readItemManifest`/`readItemZip` 的 `repo` 参数）、`src/market/index-parser.ts` | 官方收录后下载端自动从作者仓库拉取（无需任何改动） |
| PR CI 校验 | `dsh-config-market/.github/workflows/validate.yml`（`pull_request: branches: [main]`） | 自动 PR 自带 8 道校验 + 秘密扫描监督 |
| 发布向导前三步 UI | `src/client/market/PublishView.tsx` + `src/ui/market-publish.ts` | 复制/提取为上传向导骨架 |
| 下载 + 逐分区安全导入 | `src/client/market/MarketPanel.tsx` | 「装回本地」直接复用现有导入链路 |

## 4. 详细设计

### 4.1 仓库结构（上传者公开仓库 = 数据源，多配置）

```
<login>/dsh-configs/               # 无则插件自动创建（公开）；仓库名由系统按固定规则生成，不可配置
├── index.json                     # 目录清单（插件自动维护）
└── items/<config-id>/
    ├── manifest.json              # 条目说明（系统生成）
    └── config.zip                 # 配置包
```

- 上传者公开仓库名 = `<GitHub 登录名>/dsh-configs`（系统自动创建或复用，**无手动配置项**）；
- 条目目录名 `config-id` 由系统从 name 自动生成稳定 slug（重名自动加后缀），不要求用户填写。

用户仓库 `index.json` 形态（与官方市场同一模型）：

```json
{
  "schemaVersion": 1,
  "name": "我的配置仓库",
  "items": [
    { "id": "my-config", "name": "我的配置", "version": "1.0.0",
      "updatedAt": "2026-08-20T00:00:00.000Z", "categories": ["plugins"], "author": "xxx" }
  ]
}
```

官方市场 `dsh-config-market/index.json` 收录条目（自托管引用，白名单字段）：

```json
{ "id": "my-config", "name": "我的配置", "version": "1.0.0",
  "updatedAt": "2026-08-20T00:00:00.000Z", "categories": ["plugins"], "author": "xxx",
  "repo": "https://github.com/xxx/dsh-configs" }
```

> 该条目由系统从 manifest 自动提取生成（id / version / updatedAt / categories / author / repo 均不需要用户填写），用户在界面上只看到「已收录 / PR 待审核」等状态。

### 4.2 新增模块（host 半）

**`src/market/github-repos.ts` —— GitHubAuthRest（薄客户端）**

- 构造：`{ tokenProvider: () => Promise<string>, fetcher = fetch, now = Date.now }`；
- 方法：`getUser()`（验证 token → `GET /user`）、`repoExists()`、`createPublicRepo(name, description)`（`POST /user/repos`；name 由系统按固定规则生成）、`ensureFork(owner, repo)`（复用已 fork 的 / 新建 + 轮询就绪）、`readFile(owner, repo, path, ref?)`、`openPullRequest({ base, head, title, body })`、`listOpenPullRequests(head)`；
- 错误统一为 `GitHubApiError { status, code, message }`，消息脱敏（绝不内嵌 token）。

**`src/market/my-repo.ts` —— MyRepoService（上传编排，纯逻辑 + 依赖注入）**

- 依赖：`prepare`（校验）、`gitWriter`（写/推送内容，包 GitTransport 或 mock）、`rest`（GitHubAuthRest 或 mock）、`tokenProvider`、`now`；
- 状态机方法：
  - `upload({ zipBytes, form })` → `UploadResult`
  - `update({ zipBytes, form })` → `UploadResult`（版本 bump）
  - `listItems()` → `MyItemEntry[]`（含收录状态）
- `form` 仅含 `{ name（可改预填）, description?, categories? }` —— id / author / version / updatedAt / repoUrl / manifest / index 条目均由系统生成，**无任何手动配置项**；
- 时序（见 §4.3）。

**`src/index.ts` 新增路由 `/api/dsh-config-manager/me/*`**

| 路由 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `POST /me/status` | - | `{ loggedIn, login?, repoUrl?, repoExists }` | 用凭据槽 resolve token 调 `GET /user`；401 → 未登录 |
| `POST /me/upload` | `{ zipPath, form }` | `UploadResult` | 一键上传全流程 |
| `POST /me/items` | - | `{ items: MyItemEntry[] }` | 读用户仓库 index.json |
| `POST /me/update` | `{ zipPath, form }` | `UploadResult` | 一键更新 |
| 登录 | **复用** `POST /sync/github/start\|poll\|cancel` | - | 前端直接调现有 sync 登录路由，凭据槽共用 |

> 凭据安全：token 只在 host 内部 resolve 使用；浏览器只拿 `login` 用户名；所有错误/报告文本渲染前过 `redact()`。

### 4.3 上传编排时序（upload）

```
① PREPARE        prepare(zip) → 8 道校验 + 秘密扫描（含密钥 → 拒绝，零推送）。
                 元数据全自动：author=GitHub 登录名、updatedAt=now、version=首次 1.0.0、
                 id=name 的稳定 slug（冲突自动加后缀）、sha256/sections 来自校验结果
② ENSURE_REPO    ensureConfigRepo()：目标 = <login>/dsh-configs（固定规则，无用户输入）
                 repoExists ? 复用 : createPublicRepo（公开，系统命名）
③ WRITE_USER_REPO  克隆用户仓库工作副本 → 写 items/<id>/manifest.json + config.zip
                 → 读最新 index.json → 追加/更新条目（自动提取 manifest 字段）→ 提交 + push
④ ENSURE_FORK    ensureFork(xiajiajun516/dsh-config-market)：已 fork ? 复用 : 创建 + 轮询就绪
⑤ SYNC_BRANCH    拉官方最新 main → 检出分支 dsh-market-sync/<id> → 改 index.json（该条目
                 版本/时间/checksum 自动同步 manifest）→ 提交 → force push 到 fork
⑥ ENSURE_PR      查 fork 分支 open PR ? 复用 : createPullRequest(base=官方main, head=fork分支)
                 → 返回 prNumber / prUrl
```

返回 `UploadResult`：`{ ok, itemId, version, sha256, sections, repoUrl, prNumber, prUrl, warnings? }`。

### 4.4 一键更新（update）

与 upload 同时序；差异：
- 版本：**纯自动**：更新时 `version` 自动 +1（无手动输入；manifest 与 index 条目同步更新）；
- `updatedAt` 自动刷新为当前时间；id 保持不变（同一配置的稳定标识）；
- ③ 覆盖用户仓库同名条目，`index.json` 内 version / updatedAt 随新 manifest 更新；
- ⑤⑥ 同一分支 force push：旧 PR 未合并 → 自动反映新内容；已合并 → 基于最新官方 main 重新开 PR。

### 4.5 查看已上传（listItems）

读**用户自己的仓库** `index.json`（经 GitTransport 工作副本或 REST raw，具体以实现时最小成本为准），每条目附：
- 基本字段：id / name / version / updatedAt / categories / author；
- **收录状态徽章**：未收录（本地独有）｜ PR 待审核（带 PR 链接，`GET /repos/x/dsh-config-market/pulls?head=<login>:<branch>`）｜ 已收录（官方 `dsh-config-market/index.json` 含该 id，读固定官方仓库判断）；
- 行操作：**更新**（进入上传向导，预填条目信息）、**装回本地**（复用市场下载 + 逐分区导入链路）、**打开仓库**（`https://github.com/<login>/<repo>/tree/main/items/<id>`）。

### 4.6 UI（client 半，React 壳只装配）

- `MarketPanel.tsx`：顶部新增子视图切换「浏览市场 / 我的配置」（与现有 PublishView 打开模式同风格）；
- 新增 `src/client/market/MyConfigsView.tsx`：
  - **登录卡**：未登录 → 「使用 GitHub 登录」（device flow：展示一次性用户码 + 授权页链接 + 轮询，交互与 SyncSettingsView 一致）；已登录 → 显示 `@login` + **固定目标仓库** `dsh-config-market` 的状态（只读展示，无任何编辑入口）；
  - **上传向导**：复用 PublishView 前两步（选 zip → 本地校验）+ 精简表单 + 第 3 步「一键上传」（调用 `/me/upload`）→ 结果卡（PR 链接 / 仓库链接 / sha256 / 分区）。表单仅含：**名称**（预填 zip 文件名，可改）、**描述**（可选）、**分类**（可选）；id / author / version / updatedAt 以「系统自动」徽章展示，无需填写；
  - **已上传列表**：条目卡片（字段 + 状态徽章 + 行操作按钮）；
- 纯渲染模型放 `src/client/market/my-configs-view.ts`（node 单测）；文案进 `market-locales.ts`（zh 源 / en 镜像）；状态镜像进 `runStore`（低频面板策略：切 tab 不丢）；样式仅使用/扩充 `config-manager.module.css`，新 Pattern 才进 DESIGN.md。

### 4.7 安全约束（不破坏现有不变量）

1. **市场通道永不携带秘密**：上传前强制 `prepare` 8 道校验 + 秘密扫描；含密钥的包在 ① 即被拒绝，不进入公开仓库 / PR / 官方索引；
2. **token 只存凭据槽**：`credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))` 在 host 内部使用，值不下发浏览器、不进 sessionStorage、不进日志；错误与展示文本过 `redact()`；
3. **URL 不拼凭据**：仓库 URL / PR 相关内容沿用 `validateRepoUrl`（拒绝 userinfo）纪律；
4. **写前防覆盖**：用户仓库与官方索引的 `index.json` 一律「先拉最新 → 修改 → 写回」；PR 分支基于官方最新 main，避免陈旧 base；
5. **PR 内容最小化**：fork 上只改目标条目所在的那一处 index.json 内容，不触碰其他条目与文件。

### 4.8 测试计划（仓库纪律：新功能必须带测试）

| 测试文件 | 覆盖 |
|---|---|
| `src/market/github-repos.test.ts` | mock fetch：`getUser` 200/401、`createPublicRepo` 201/422、fork 复用与轮询就绪、`openPullRequest`、`listOpenPullRequests`；错误分类与脱敏 |
| `src/market/my-repo.test.ts` | mock gitWriter/rest：首次上传全流程、更新 bump 版本、PR 复用（未合并）与重开（已合并）、防覆盖（远端 index 前进）、校验失败零推送、401 token 过期路径 |
| `src/client/market/my-configs-view.test.ts` | 渲染模型纯函数：条目投影、状态徽章推导、表单校验 |
| 验证命令 | `npm run typecheck` + `npm test` + `npm run build`（若 client/样式变更再加 `npm run bundle`） |

**端到端冒烟（真实 GitHub 账号，分步带用户操作）**：
上传一个测试配置 → 确认「我的配置」列表出现 → 打开生成的 PR 链接确认内容 → 合并 PR → 市场面板拉到新条目 → 一键更新一次 → 装回本地一次。

### 4.9 风险与对策

| 风险 | 对策 |
|---|---|
| PR 需维护者人工合并（GitHub 协作机制） | 保持人工环节（收录审核）；CI（validate.yml）红灯时提示用户修正 |
| fork 创建是异步的 | `ensureFork` 轮询就绪（超时报可重试错误） |
| token 过期（401） | `/me/status` 与各操作返回明确「请重新登录」，UI 引导重登 |
| 官方 main 前进导致 PR 冲突 | 更新时基于最新 main rebase 重开/更新分支 |
| 大配置包 | 走 GitTransport 推送，无 GitHub API 单文件大小限制 |
| 用户仓库与他人冲突 | 个人仓库单作者场景低风险；写前先拉最新兜底 |

### 4.10 执行顺序

1. 读 `git-transport.ts` 公开接口，确认「clone → 写文件 → commit → push」适配面（必要时加薄封装）；
2. host 半：`github-repos.ts` → `my-repo.ts` → 路由接入 → 单测全绿；
3. client 半：纯渲染模型 `my-configs-view.ts` → `MyConfigsView.tsx` → 路由接入（复用 sync 登录路由）→ locales → runStore 镜像 → 样式；
4. 全量验证：typecheck / test / build；
5. 端到端冒烟（真实 GitHub 账号，分步执行）；
6. 文档同步：DESIGN.md / AGENTS.md（若有新约定与新 Pattern）；`dsh-config-market/README.md` 增补「用插件一键发布」小节。

### 4.11 本次不实现（留作第二版）

- 删除 / 下线条目（含从官方市场移除）；
- 私有仓库选项（进市场必须公开；不公开的仓库可后续做「个人私密备份」通道）；
- 一键提交到多个官方市场；
- 市场收录审核流（合并权限仍归官方仓库 owner）。