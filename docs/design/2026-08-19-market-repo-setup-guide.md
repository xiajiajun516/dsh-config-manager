# dsh-config-market 官方配置市场仓库 · 搭建规格书

> 日期：2026-08-19 · 用途：**整份复制发给搭建 AI 的规格文档** · 上游依据：dsh-config-manager 插件 `src/market/`（types.ts / index-parser.ts / security.ts / reader.ts / builtin.ts 为唯一事实来源，本规格与代码逐项一致）

---

## 1. 这个市场是干什么的（背景介绍）

`dsh-config-market` 是 **DSH Config Manager 插件（dsh-config-manager）的官方配置市场仓库**。它不包含任何程序代码，只是一个**纯内容仓库**：存放社区共享的 DSH 配置包（settings / 模型供应商 / 插件 / skill / agent preset 等），供所有安装了该插件的用户在「配置市场」面板中浏览、下载、校验并一键导入。

**核心架构（方案 B：去中心化引用）**：

- 官方市场仓库 = **目录索引**（index.json），只收录条目的**元信息与引用**；
- 条目内容（manifest + config.zip）由**作者在自己的公开 git 仓库自托管**（条目可带 `repo` 字段指向作者仓库，也允许直接放在本仓库 `items/<id>/` 下）；
- 官方仓库**永远只读、零凭据**：插件端只做 `git clone --depth 1` + `git pull --ff-only`，绝不写回、绝不需要任何 token。

**插件侧的用户流程**：设置页 → Market tab → 浏览条目列表（搜索/类别过滤/来源徽章）→ 查看详情（下载 + 8 道安全校验 + dry-run 预览）→ 逐分区批准（高风险分区须显式勾选）→ 确认导入（自动快照可回滚）。另有「发布到市场」5 步向导，引导作者发布配置（本地校验 → 生成条目包 → 推自己仓库 → PR 收录）。

**安全不变量（仓库必须配合，插件侧强制执行）**：
- 市场通道**永不携带秘密**：任何声明 `containsSecrets=true` 的配置包会被拒绝；
- 供应链警示恒展示：从市场下载的条目一律视为「未经官方审核的不可信输入」；
- 条目必须通过 8 道校验（见 §5），任一失败即拒绝导入。

---

## 2. 仓库目录结构（必须严格遵循）

```
dsh-config-market/
├── index.json                  # L1 市场目录（唯一必建文件）
├── README.md                   # 市场说明（可选，推荐）
└── items/
    └── <itemId>/               # 每个条目一个目录；目录名 = itemId
        ├── manifest.json       # L2 条目清单（sections + checksums + 供应链信息）
        └── config.zip          # L3 实际配置内容（导出/备份格式 ZIP）
```

- 条目可以全部放在本仓库 `items/<id>/`（官方托管），也可以只在本仓库的 index.json 里写一条**引用**（`repo` 指向作者仓库，内容作者自托管，官方零内容负担）；两者可混合。
- **推荐实践**：官方市场只维护 index.json 引用 + 少量精选条目本体；社区条目走「作者仓库 + PR 收录引用」。

---

## 3. index.json（L1 市场目录）规范

**字段白名单**（此表之外的任何字段会**整体拒绝**该 index，绝不忽略）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | number | ✅ | **恒为 `1`** |
| `name` | string | — | 市场名（UI 展示） |
| `description` | string | — | 市场描述 |
| `items` | array | ✅ | 条目摘要列表（可为空数组） |

`items[]` 单项字段白名单：

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---|---|
| `id` | string | ✅ | 字母数字开头，仅 `. _ -`，最长 128（正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）；同时是 `items/<id>/` 目录名 |
| `name` | string | ✅ | 非空；条目标题（卡片显示） |
| `description` | string | — | 一句话描述 |
| `author` | string | — | 作者（纯展示，不做身份校验） |
| `version` | string | — | 展示用版本号 |
| `updatedAt` | string | — | ISO-8601 时间 |
| `categories` | string[] | — | 类别标签（纯展示；UI 用作过滤） |
| `repo` | string | — | **可选**：条目来源仓库 URL（作者自托管时必填）。必须是 `http(s)` 且**不含 userinfo**（拒绝 `user:pass@`、拒绝 `git@...`/`ssh://` 形态）——见 §7 校验 |

**解析行为**：`id` 越界 / 未知字段 → **整份 index 拒绝**；`repo` 非法 → **仅丢弃该条目**（其余条目照常展示，UI 有 dropped 计数）。

**最小示例**：

```json
{
  "schemaVersion": 1,
  "name": "DSH 官方配置市场",
  "description": "DSH Config Manager 社区配置共享",
  "items": [
    {
      "id": "llm-deepseek-settings",
      "name": "DeepSeek 常用设置包",
      "description": "常用 settings 命名空间配置",
      "author": "xiajiajun516",
      "version": "1.0.0",
      "updatedAt": "2026-08-19T00:00:00.000Z",
      "categories": ["settings"],
      "repo": "https://github.com/xiajiajun516/dsh-config-market.git"
    }
  ]
}
```

---

## 4. items/<id>/manifest.json（L2 清单）规范

**字段白名单**（未知字段 → 拒绝该条目）：

| 字段 | 类型 | 必填 | 校验规则 |
|---|---|---|---|
| `schemaVersion` | number | ✅ | 恒为 `1` |
| `id` | string | ✅ | **必须与目录名一致**，否则拒绝（防目录/内容错位） |
| `name` | string | ✅ | 非空 |
| `version` | string | ✅ | 版本号 |
| `author` | string | — | 作者 |
| `description` | string | — | 描述 |
| `updatedAt` | string | — | ISO-8601 时间 |
| `categories` | string[] | — | 类别标签 |
| `sections` | SectionId[] | ✅ | 本条目包含的分区清单（须是 §5 分区表的合法 id；**必须与 config.zip 内部实际启用的分区有交集且非空**） |
| `provenance` | object | — | 供应链信息：`source`（作者声明的来源 URL）+ `note`（自述）；纯展示 |
| `checksums` | object | ✅ | `{ "zip": "<config.zip 的 SHA-256 hex>" }`——**必须等于 config.zip 实算值**，不符即拒绝 |

**最小示例**：

```json
{
  "schemaVersion": 1,
  "id": "llm-deepseek-settings",
  "name": "DeepSeek 常用设置包",
  "version": "1.0.0",
  "sections": ["settings", "providers"],
  "provenance": { "source": "https://github.com/xiajiajun516/dsh-config-market" },
  "checksums": { "zip": "0123abcd...64位hex" }
}
```

---

## 5. 分区（sections）全集与 config.zip 内部结构

**合法分区 id 全集（15 个）**：

```
settings, ui, providers, plugins, mcp, prompts,
skills, agentPresets, agentInstructions, workspaces, pluginFiles,
credentialsStatus, secrets, sessions, self
```

**config.zip 内部布局**（导出/备份格式 = 插件自身导出产物的格式）：

- 根部必须有 **`manifest.json`**（标准导出 manifest：`schemaVersion=1`、`exporter`、`source`、`sections: Record<SectionId, boolean>`、`security: { containsSecrets, encrypted, encryption }`）；其 `security.containsSecrets` **必须为 false**；
- JSON 分区按固定路径落盘（下表左列），文件类分区按目录前缀落盘（右列）：

| 分区 | 落盘位置 |
|---|---|
| settings | `config/settings.json` |
| ui | `config/ui.json` |
| providers | `ai/providers.json` |
| plugins | `plugins/plugins.json` |
| mcp | `mcp/servers.json` |
| prompts | `custom/prompts.json` |
| workspaces | `workspaces/workspaces.json` |
| credentialsStatus | `security/credentials.json` |
| skills | `custom/skills/`（目录，含真实文件） |
| agentPresets | `agents/presets/`（目录） |
| agentInstructions | `custom/agent-instructions/`（目录） |
| pluginFiles | `plugin-files/`（目录）——**禁止进入市场条目**（任意文件直通，无内容过滤，最易泄漏 token/密钥文件，见下） |
| sessions | `sessions/`（目录）——**禁止进入市场条目**（历史会话含个人交互记录，见下） |
| self | `self/`（目录）——**禁止进入市场条目**（本地环境专属：sync 通道 URL / WebDAV 地址 / 市场配置 / UI 偏好，见下） |
| secrets | **禁止进入市场条目**（见安全不变量） |

**禁止分区**：`secrets`（凭据）、`sessions`（历史会话，含个人交互记录与上下文）、`pluginFiles`（任意文件直通，无结构过滤，目录放啥带啥）、`self`（本地环境专属：sync 通道地址/WebDAV 主机等环境信息）为市场条目硬性禁止分区——发布向导（prepare）与下载校验（validateMarketItem）两端均强制，含任一禁止分区的条目直接 invalid / 拒绝发布。作者发布前需在导出时排除这些分区。

**内容级秘密扫描（纵深防御）**：发布向导除校验 `containsSecrets` 标记外，还会对 config.zip 内各分区**实际内容**做敏感扫描（复用 secret-scanner：字段名 + 值形状识别 api-key/token/password/SK- 形态；环境变量引用名豁免不误报）。扫描采用**宽松档**：占位符（`your-token`、`<token>`）、模板引用（`${VAR}` / `{{VAR}}` / `%VAR%` / `$VAR`）、代码表达式（`process.env.X`）与示例形态（`sk-your-*`、`Bearer example-*`、JWT 教学串）一律放行；只有值像**真实字面量凭据**（sk- 真实串 / ghp_ / AKIA / PEM / 完整 JWT，或字段名敏感且值为含数字/符号的混合长串）才拦截——即使导出标记被绕过，内容中残留的凭据也会被拦下。作者发布前应确认 providers/mcp/settings 等分区内容已脱敏（apiKey 请改为 env 引用名或 `${VAR}` 模板引用）。

- `integrity/checksums.json`：**可选**；存在则会校验其声明的各文件 SHA-256 与实际内容一致，不一致拒绝；
- 每个启用分区的数据文件在 ZIP 内必须真实存在（缺失 → 拒绝）。

**⚡ 最省事的生成方式**：不要手写 config.zip——用 dsh-config-manager 插件的「导出」功能生成备份 zip（结构天然正确），再用插件的「发布到市场 → 生成条目包」自动产出 manifest.json 与 SHA-256。本仓库的人工维护只碰 index.json 引用。

---

## 6. 插件消费方式（仓库如何被读取）

- **绑定**：插件内置默认地址 `https://github.com/xiajiajun516/dsh-config-market.git`（`src/market/builtin.ts`）；host 端可经环境变量 `DSH_CONFIG_MARKET_URL` 覆盖（网页端安全回退默认地址）。
- **读取机制**：首次 `git clone --depth 1` 到 `$DSH_HOME/dsh-config-manager/market/work/<url-hash>/`；之后每次读取 `git pull --ff-only`（内容更新 = 直接 push 本仓库，用户端自动同步）。
- **条目不带 `repo`** → 从本仓库读 `items/<id>/`；**带 `repo`** → 从作者仓库读（按 url-hash 独立工作副本，天然隔离）。
- **插件公开 API（供参考，UI 已封装，无需另建）**：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/api/dsh-config-manager/market/status` | GET | 市场状态 |
| `/api/dsh-config-manager/market/refresh` | POST | 强制 re-pull index.json |
| `/api/dsh-config-manager/market/browse` | POST | 浏览（合并 index + 缓存状态） |
| `/api/dsh-config-manager/market/download` | POST | 下载条目（拉 manifest+zip → 8 道校验 → dry-run 预览） |
| `/api/dsh-config-manager/market/prepare` | POST | 发布向导：生成条目包 |
| `/api/dsh-config-manager/download` | GET | 受控临时区文件下载（发布包） |

---

## 7. 插件侧 8 道校验（仓库条目必须全部满足）

1. **id 一致**：manifest.json.id === 请求目录名；
2. **体积上限**：config.zip ≤ 64 MB；
3. **checksum**：manifest.checksums.zip === config.zip 实算 SHA-256；
4. **zip 加固**：无 Zip Slip（`../`/绝对路径）、无 zip bomb、无恶意条目（解包安全）；
5. **内部 manifest 可解析**且 `containsSecrets=true` → **拒绝**（市场永不携带秘密）；
6. **内部完整性**：`integrity/checksums.json` 存在则校验全部文件摘要；
7. **分区数据合法**：JSON 分区过结构校验（version=1 + 顶层形状），文件分区目录非空；
8. **L2↔L3 一致**：manifest.sections 与 zip 内部启用分区交集**非空**（空 → 拒绝）；
9. **禁止分区拒绝**：`sessions`（历史会话）、`pluginFiles`（任意文件）、`self`（本地环境）为市场硬性禁止分区（与 `secrets` 同级）——发布向导与下载校验两端强制，含任一即拒绝；
10. **内容级秘密扫描（发布侧纵深防御）**：对区内实际内容做敏感扫描（字段名 + 值形状，宽松档：占位符/模板引用/代码表达式/示例形态放行），发现疑似**真实凭据**即拒绝发布——不依赖导出 `containsSecrets` 标记。

辅以：`repo` 必须 `http(s)` 且无 userinfo（`git@`/`ssh://` 形态拒绝）；供应链警示对任何来源恒展示。

---

## 8. 发布与收录流程（社区协作模型）

1. 作者在 dsh-config-manager「发布到市场」向导完成：选 zip → 本地校验（拒绝含密钥）→ 生成条目包（manifest + SHA-256）→ 下载发布包；
2. 作者把 `items/<id>/`（manifest.json + config.zip）推到**自己的公开仓库**（或直接提到本仓库的 PR）；
3. 作者提 **PR 到本仓库 index.json**，在 `items[]` 追加一条引用（`id` + `name` + `repo` 等，见 §3 示例）；
4. 维护者**人工审核**后合并（后续计划：CI 自动预检，见 §9）；
5. 用户端 `pull --ff-only` 自动拿到新引用；条目内容始终从作者仓库实时拉取，作者更新配置无需再提 PR。

---

## 9. 后续计划（Roadmap）

**近期（阶段 3 增强，不阻塞搭建）**：
- [ ] GitHub Actions CI 预检：PR 时自动跑插件同款 `validateMarketItem` 校验（zip 解析 + checksums + sections），非法引用 fail；
- [ ] 收录申请表单/issue 模板预填（作者提交 id + repo，维护者人工收录）；
- [ ] 条目仓库 workDir LRU 清理与配额（条目数量增长后防累积）。

**中期**：
- [ ] 官方精选/已验证徽章（index 增加 `verified` 字段扩展，schema v2 需与插件同步演进）；
- [ ] 多市场 / 社区市场支持（插件底层已按 url-hash 支持多仓库，UI 开放多市场 tab 即可）；
- [ ] 私有/鉴权市场（二期：git token credential helper，仍不走 userinfo 注入）。

**长期**：
- [ ] 条目热度/下载统计（需要配套计数服务或 Git 流量分析，影响市场 UI 排序）；
- [ ] 配置包签名（作者 GPG/SSH 签名 manifest，提供比 checksum 更强的来源保证）。

---

## 10. 搭建步骤 Checklist（给 AI 的直接实施清单）

1. `git init` 空仓库，创建 `index.json`（schemaVersion:1 + items:[]）与 README；
2. 推送 GitHub（仓库名建议 `dsh-config-market`，公开）；
3. 确认插件侧内置地址命中（或临时用 `DSH_CONFIG_MARKET_URL` 指向你的仓库验证）；
4. 用插件「导出 + 发布向导」生成 1 个种子条目，放入 `items/<id>/`，在 index.json 登记；
5. 在插件 Market tab 「拉取最新」→ 验证条目出现、详情校验通过、逐分区批准导入成功；
6. 建立 PR 收录约定（README 写清「如何提交条目」），按 §8 流程放行社区条目。

**勿做**：❌ 提交任何含密钥/凭据的内容（市场硬性拒绝，含内容级扫描拦截）· ❌ 提交含禁止分区（sessions 历史会话 / pluginFiles 任意文件 / self 本地环境）的内容 · ❌ 使用非 http(s)/带 userinfo 的 repo 引用 · ❌ 在 index.json 引入白名单外字段（整体拒绝）· ❌ 依赖任何写回/凭据（官方仓库只读是架构不变量）。