# DSH 架构研究报告（m1-research）

> 本报告基于对真实运行环境的逐文件检查（2026-08-14），所有路径、包名、API 均来自
> 实际安装的 DSH 0.1.0-rc.6（`@deepseek-ai/dsh`）与已挂载插件的源码，无任何编造。
>
> 检查范围：
> - `C:\Users\3Layers-01\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`（CLI 启动器）
> - `C:\Users\3Layers-01\.dsh`（DSH 数据主目录，含 settings.yaml / .credentials.yaml / cordis.patch.yml / plugins / profiles / sessions / memories / storages / skills / bin / logs）
> - `C:\Users\3Layers-01\.dsh\profiles\node_modules\@deepseek-ai\`（约 200 个核心包源码）
> - `C:\Users\3Layers-01\.dsh\profiles\web\node_modules\@linxin666\*`（dsh-web-ui 全家桶：dsh-ssh / dsh-task-board / dsh-aionui-panel 等已装插件）
> - `C:\Repository\DeepSeekHarness\`（本机已有的 export-dsh.ps1 / import-dsh.ps1 实验脚本）

---

## 0. 关键结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| DSH 是什么 | 一个 **profile 化的 Cordis 插件组合系统**：`dsh --profile <name>` 把「bundle 包」的 patch 层按顺序叠加成插件树 |
| 配置存哪 | 绝大部分在 `$DSH_HOME`（默认 `~/.dsh`）：`settings.yaml`（按 namespace 分区，插件各自注册）、`.credentials.yaml`（密钥）、`storages/`（workspace 等结构化数据）、`sessions/`（会话日志）、`skills/`、`.agent-presets/`、`cordis.patch.yml`（插件树补丁）、`profiles/web/`（profile 包） |
| 插件怎么装 | `dsh plugin --profile web add <pkg>`（pnpm 转发）；bundle 包进 `dsh.profile.bundles`，普通包在 profile `cordis.patch.yml` 插行；已运行进程内还有 `ctx.pluginMarketplace.installPlugin()` 等价实现 |
| 可复用 API | `ctx.settings`（describe 自带 **secret 剥离**）、`ctx.credentials`、`ctx.llm`、`ctx.skills`、`ctx.agentPresets`、`ctx.workspace`、`ctx.pluginInventory`、`ctx.pluginMarketplace`、`ctx.commands/tools/systemPrompt/webServer`；Client 侧 `ctx.connection.api`（settings/credentials/llm/workspace/skills/agentPresets/host 等 30+ 端点） |
| 不可完成 | 无任何 backup/import/export/migration/sync 现成实现（本插件正是空白点）；无 secrets 加密存储；无 MCP 管理 API；无 UI/主题/keybinding 标准配置面（部分在浏览器 localStorage，Host 无法读取）；无「重启 dsh 服务」插件 API |
| 推荐路线 | 独立 npm 包工程（仿 dsh-ssh：`src/index.ts` Host + `src/client/` React UI，tsc + tsdown），bundle patch 挂载；TypeScript/Node.js 完全可行；依赖面：`@deepseek-ai/dsh-settings`、`dsh-credentials`、`dsh-tools`、`dsh-host-webserver`、`@deepseek-ai/cordis`、`schemastery`、react（client），ZIP/加密可用 Node 内置 `node:zlib`/`node:crypto`，**零新增重依赖** |

---

## 1. DSH 插件体系

### 1.1 CLI 与 Profile 机制

DSH CLI 本体 `@deepseek-ai/dsh@0.1.0-rc.6`（npm 全局安装，`type: module`，入口 `lib/bin.js`）只是一个**启动器**，核心逻辑都在 profile 里：

```
dsh --profile web            # 启动 web profile（别名：dsh web）
dsh --profile headless "…"   # 单轮 headless
dsh plugin --profile web add <pkg>   # 管理 profile 插件依赖（转发给 pnpm）
dsh --dump-config            # 打印组合后的 profile 插件树（可用于验证）
dsh --patch ./extra.yml      # 额外 patch 覆盖层（可重复）
```

**Profile 定义**（`dsh-app-boot/lib/index.js`，已读源码确认）：
> A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json`
> (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its
> ordered `bundles` list) and a `cordis.patch.yml` (the user's own patch layer, applied
> after every bundle layer).

本机真实 profile：`C:\Users\3Layers-01\.dsh\profiles\web\`，内容：
- `package.json`：`dependencies`（已装插件）+ `dsh.profile.bundles`（有序 bundle 列表，当前为 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@nanmicoder/dsh-agent-teams`、`dsh-better-sidebar`、`dshmarket`、`dsh-notification`、`@linxin666/dsh-web-ui-all`、`dsh-find-plugin`）
- `cordis.patch.yml`：用户 patch 层（本机由 DSH Desktop 维护，插入 balance/file-changes/terminal/plugin-marketplace/dsh-memory-evolve）
- `pnpm-workspace.yaml`：`nodeLinker: hoisted`（所以 profile 的 node_modules 是平铺的）
- `node_modules/`：profile 自装插件

另有安装器维护的扁平回退目录 `$DSH_HOME/profiles/node_modules/`（依赖闭包每个包一个 junction symlink），使**所有内置包从任意 profile 都能被 Node 解析** —— 这就是 200 个 `@deepseek-ai/*` 核心包源码所在。

### 1.2 插件（Bundle）形态与 manifest

插件即 npm 包，package.json 里可声明（dsh-ssh 的 package.json 为真实范本）：

```jsonc
{
  "name": "@linxin666/dsh-ssh",
  "type": "module",
  "main": "lib/index.js",               // Host 半：跑在 dsh 进程里
  "exports": {
    ".":            { "default": "./lib/index.js" },
    "./client":     { "default": "./lib/client.js" },  // Browser 半：Web GUI 加载
    "./src/*":      "./src/*"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },       // 作为 bundle 时的 patch 文件
    "client": {                                         // Client 半声明
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection", "..."],
      "platform": "web"
    }
  },
  "peerDependencies": { "@deepseek-ai/dsh-settings": "^0.1.0-rc.6", "..." }
}
```

**Bundle patch 文件**（`cordis.patch.yml`）是 YAML 顶层数组，dsh-base 的 patch 是完整范例：
```yaml
- insert:
    - id: settings            # 行 id（全局定位键）
      name: '@deepseek-ai/dsh-settings-file'
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
    - id: web
      name: '@deepseek-ai/dsh-web'
      config: { searchProvider: deepseek-official }
- id: skill-badge
  disabled: true               # 禁用行
```

**树组合规则**（已读 dsh-app-boot 源码）：
1. 从空 entry 列表开始
2. 按 `dsh.profile.bundles` 顺序应用每个 bundle 的 patch 层
3. 应用 profile 自己的 `cordis.patch.yml`
4. 应用 CLI `--patch` 覆盖层
5. 每行按 `id` 定位，**后写整行覆盖前写**（`config` 是整体替换不是合并）；patch 支持 `!!js` 表达式（如 `process.env.X`、`dshHomePath('sessions')`）

**已安装的聚合插件范式**：`@linxin666/dsh-web-ui-all@0.1.12`（web profile 的 bundle）只是一个聚合包，其 `cordis.patch.yml` 由 `scripts/aggregate.mjs` 自动生成，把 dsh-ssh、dsh-task-board、dsh-aionui-panel、dsh-pet、dsh-remote-web-ui 等 10 个子插件各插一行 —— 说明**插件可以以「聚合 bundle」方式组团挂载**。

### 1.3 插件生命周期（Cordis 插件）

每个插件是标准 Cordis 插件（`@deepseek-ai/cordis`，基于 Cordis 4）：

```ts
export const name = 'ssh'
export const inject = ['webServer', 'tools', 'systemPrompt']   // 硬依赖声明
export const Config: z<Config> = z.object({ ... })              // schemastery schema
export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => () => { engine.dispose() }, 'label')          // 副作用随 fiber 回收
  ctx.systemPrompt.section({ name: 'plugin:dsh-ssh', order: 150, text: '…' })
  ctx.effect(() => { routes.map(r => ctx.webServer.register(r)) }, 'routes')
  ctx.effect(() => { tools.map(t => ctx.tools.register(t)) }, 'tools')
  installSettingsSection(ctx, settingsNamespace('dsh-ssh'), Config, config ?? {}, {...})
}
```

- `Config` 用 **schemastery** schema（DSH 用 `@deepseek-ai/schemastery`，与 `zod` 并存：host 侧 schemastery、client wire 层 zod）
- 生命周期由 Loader 管理（`dsh-app-boot` 的 Loader 类：`loader/config-update` 事件、config 文件热重载写回）；`dsh-host-plugin-inventory` 暴露每个 entry 的 `fiberPhase`（pending/loading/active/failed/disposed/unloading）
- **权限模型**：插件在 dsh 进程内运行，**拥有进程全部能力**（文件系统、网络、子进程）——不是沙箱边界。HTTP 路由需要插件自己做安全围栏（dsh-ssh 的 `isLoopbackRequest`：仅接受 127.0.0.1/localhost + 同源 Origin，范例）

### 1.4 插件可用的 DSH API（Host 侧 Service）

从 dsh-base 核心树与已装插件源码归纳的**真实可注入服务**（节选与本插件相关者）：

| Service | 包 | 能力 |
|---|---|---|
| `ctx.settings` | `dsh-settings` + `dsh-settings-file` | 设置文档（settings.yaml）读写：`register/describe/get/update/replace/mutate`；`describe({redactSecrets:true})` 返回剥离密钥后的值与 secrets 位置；`installSettingsSection()` 标准接线 |
| `ctx.credentials` | `dsh-credentials` + `dsh-credentials-local` | `resolve(ref)/describe(ref)/set(ref,val)/unset(ref)`；值永不出现在 describe 里 |
| `ctx.llm` | `dsh-llm` | `registerAdapter/registerConfigurableProviders/listProviders/providerDirectory` |
| `ctx.skills` | `dsh-skill` | 技能注册中心（provider 由 `dsh-skill-filesystem` 提供） |
| `ctx.agentPresets` | `dsh-agent-presets` | `list/resolve/mount/copy/remove/readComposition/…` |
| `ctx.workspace` | `dsh-workspace` | 工作区域（经 `ctx.storageDomain`） |
| `ctx.storage` / `ctx.storageDomain` | `dsh-storage` / `dsh-storage-json` / `dsh-storage-domain` | 结构化 JSON 存储（`~/.dsh/storages/*.json`） |
| `ctx.pluginInventory` | `dsh-host-plugin-inventory` | `list()`：loader entries（entryId/moduleName/enabled/fiberPhase） |
| `ctx.pluginMarketplace` | `dsh-plugin-marketplace` | `search/installed/installPlugin/uninstallPlugin`（web profile 专属，npm 驱动） |
| `ctx.commands` | `dsh-commands` | 注册 slash 命令（如 `/export`） |
| `ctx.tools` | `dsh-tools` | `register(defineTool({name,description,parameters,output,execute}))` 注册模型工具 |
| `ctx.systemPrompt` | `dsh-system-prompt` | `section({name,order,text})` 向 agent 注入提示段 |
| `ctx.webServer` | `dsh-host-webserver` | `register(route)/registerUpgrade(ws)/registerFallback` 注册 HTTP/WS 路由（如 `/api/dsh-ssh/*`） |
| `ctx.sessionPersistence` | `dsh-session-persistence-jsonl` | 会话日志读写（zstd jsonl） |

### 1.5 Client（浏览器半）机制

- Client 插件经 `dsh-cordis-client-runner` + `dsh-client-runtime` 在 Web GUI 里以 `window.__ModuleLoader__.load({ id, factory(require) })` 加载（已见 dsh-ssh / dsh-plugin-marketplace 的 `lib/client.js`）
- 数据通道两条：
  1. **同源 fetch** 插件自注册的 `/api/<插件>` 路由（dsh-ssh 全 UI 走这条：`fetch('/api/dsh-ssh/hosts')`）
  2. **`ctx.connection.api`**（`dsh-client-connection` + `dsh-host-apiproxy`）：RPC over `/api`，含 30+ 官方端点（见 §3.3）
- **UI 挂载点（官方 Slot 契约）**（`dsh-client-ui-slots` 的 `SlotMap` 模块增强，已读 d.ts）：
  - `settings.section`（list）：注册**设置页**（id/order/label；渲染在设置面板内容列）← Config Manager 主界面首选
  - `settings.plugins.tab`（list）：Plugins 设置区的 tab
  - `settings.general.item`（list）：General 页的单行偏好
  - `settings.action` / `sidebar.footer.action`（list）：底部动作
  - 侧边栏**没有**给外部插件的 entry slot（只有 `sidebar.workspaces`/`sidebar.settings` 两个 single，已被内置占用），因此 dsh-ssh / dsh-task-board 采用 **DOM 注入 + MutationObserver 自愈** 加侧边栏入口（已读 sidebar-entry.ts 源码，成熟范式）

---

## 2. DSH 配置存储（真实文件清单）

`$DSH_HOME` 解析规则（`dsh-home-paths`）：显式配置 > `$DSH_HOME` 环境变量 > `~/.dsh`。本机为 `C:\Users\3Layers-01\.dsh`。

### 2.1 顶层结构（本机真实 ls）

```
.dsh/
├── settings.yaml            # 用户设置文档（YAML，namespace 分区，热重载）
├── .credentials.yaml        # 凭据（CredentialRef → string；明文，0600 意图）
├── .anonymous-user-id       # 设备匿名 ID（随机 UUID，一行）
├── cordis.patch.yml         # 顶层插件树补丁（本机：皮肤禁用/插入）
├── pet.json                 # dsh-pet 插件 UI 状态（宠物显示位置等）
├── skill-manager-ytxue.*    # dsh-skill 管理器痕迹（第三方）
├── bin/                     # 本机 dsh web 启动脚本（dsh-web.ps1 等）
├── logs/
├── plugins/dsh-deep-whale/  # 皮肤源码仓库（git clone 形态）
├── profiles/                # profile 目录（web/ + 共享 node_modules/）
│   └── web/                 # 见 §1.1
├── sessions/                # 会话日志（zstd jsonl）
├── memories/                # dsh-memory-evolve 插件数据（非核心）
├── skills/                  # 用户技能（flat .md + 目录 bundle）
├── storages/                # 结构化 JSON（workspace.json 等）
└── dsh-ssh.json             # dsh-ssh 插件自有配置（不存在时自动建）
```

### 2.2 各类配置的存储位置与格式（逐项确认）

| 配置类别 | 真实位置 | 格式 / 管理方 | 备注 |
|---|---|---|---|
| **全局设置** | `~/.dsh/settings.yaml` | YAML 文档，顶层 key = namespace | 由 `dsh-settings-file` 管理：chokidar 热重载、跨进程文件锁、**comment-preserving 的 leaf-level diff 写入**（不重排、不丢注释） |
| Providers | settings.yaml 的 `llm-deepseek:` section | apiKeyEnv/baseURL/thinking/reasoningEffort/maxTokens/defaultContextWindow/models[]/retryPolicy | `dsh-llm-deepseek` 注册；API key 经 `ctx.credentials.resolve(apiKeyEnv)` |
| 多 Provider | settings.yaml 的 `llm-pi-ai:` section | `providers: { <route>: { apiKeyEnv, displayName, api, baseURL, models[], modelOverrides, headers, reasoning, transport, retryPolicy, … } }` | `dsh-llm-pi-ai`（web Models 页写入目标）；settingsPath 为 `["providers", route]` |
| Secrets | `~/.dsh/.credentials.yaml` | `CredentialRef → string`（如 `DEEPSEEK_API_KEY: sk-…`）；POSIX 检查 0600（Windows 跳过） | 解析优先级：进程 env > 文件 > 项目 `.env` > `$DSH_HOME/.env`；**明文存储**，无加密层 |
| MCP | **组合文件**（bundle/profile patch 的 `config`） | 每个 `dsh-mcp-client` 实例一个 server：stdio（serverName/command/args/env/cwd）或 streamable-http（url/headers） | **没有 settings 面、没有管理 UI、没有独立配置文件** —— MCP 配置在插件树 config 里 |
| 插件启用/配置 | ① profile `package.json` 的 `dependencies` + `dsh.profile.bundles`；② profile `cordis.patch.yml`；③ `~/.dsh/cordis.patch.yml`；④ 插件自己的 settings namespace | JSON / YAML patch | 启用/禁用 = patch 行 `disabled` 或从 bundles 增删 |
| Prompts / Rules | **无独立文件** | system-prompt（persona，patch config）；plan-mode section（patch config）；agent-instructions 读项目里 `AGENTS.md`/`CLAUDE.md` | 插件可经 `ctx.systemPrompt.section()` 注入 |
| Skills | `~/.dsh/skills/`（flat `.md` + 目录 bundle）；`~/.agents/skills`；项目 `.dsh/skills`/`.agents/skills`；内置 `DSH_BUNDLED_SKILL_DIR` | Markdown（frontmatter name/description）或 SKILL.md | `dsh-skill-filesystem` 发现；本机 28 个技能文件在此 |
| Agent Presets | `~/.dsh/.agent-presets/`（用户可写）；安装目录 `config/agent-presets/{cordis,standard,minimal,code}/`（system，只读） | 每个 preset 一个目录：`agent.cordis.yml`（组合）+ `preset.yml`（显示元数据） | settings `agent-presets.default`（本机 `cordis`）；`ctx.agentPresets` 管理 |
| Workspaces | `~/.dsh/storages/workspace.json` | JSON：`{unit:{name:"workspace",version:2}, global:{workspaceIds[],archivedSessionIds[]}, tables:{workspaces:{<id>:{path,title,sessionIds[],createdAt,updatedAt}}}}` | `dsh-workspace` 经 `ctx.storageDomain` 写入；**path 为绝对路径（如 `C:\Repository\OpsFlow`）→ 跨设备必须路径映射** |
| Sessions | `~/.dsh/sessions/<projectKey>/<sessionId>/session.jsonl.zstd` | zstd 压缩 JSONL（可配 `compression:none`） | projectKey 如 `--C-Repository-DeepSeekHarness--`（cwd 编码）；会话内容含敏感信息 |
| 设备 ID | `~/.dsh/.anonymous-user-id` | 随机 UUID | 规范明确「设备唯一 ID 不迁移」→ 不要导出 |
| UI 偏好 / 主题 | ① settings.yaml namespace（pet、dsh-better-sidebar、remote-web-ui、ui-onboarding 等）；② **浏览器 localStorage**（dsh-task-board 的 `dsh.taskBoard.v1`、aionui-panel 宽度等）；③ 插件自有文件（pet.json） | 混合 | **localStorage 部分 Host 无法读取**（只能随浏览器）—— 迁移范围受限 |
| Keybindings | **未发现**任何 keybinding 配置 | — | DSH 当前无用户 keybinding 概念（规范 §1.13 不适用，不要发明） |
| Workflows | **无配置文件** | `dsh-workflow` 工具 = 运行时 JS 脚本编排（worker-thread 执行） | 无「workflow 配置」可迁移 |
| Commands（slash） | 无用户文件 | `ctx.commands.register()` 由插件注册 | 无独立存储 |
| 环境变量 | 无配置文件 | `dsh-launch-environment`：进程 env / `.env` 分层 | 迁移时只能导出「变量名 + 是否有值」，不能导出值 |
| Logs / Cache / 临时 | `~/.dsh/logs/` 等 | — | 默认不导出 |

> **重要**：DSH 的配置是「**一个集中 YAML + 多个独立文件 + 插件自有文件 + 浏览器 localStorage**」的混合模型，且 `settings.yaml` 的热重载与「插件 config = patch 组合」两层并存。备份/迁移必须**按 namespace 走 `ctx.settings.describe`（redact）+ 文件级收集**，不能把整个 `~/.dsh` 打包（规范 §34.20 亦禁止）。

---

## 3. 现有能力盘点（优先复用）

### 3.1 官方 CLI
- `dsh --dump-config` / `dsh --dump-default-config`：打印组合后的 profile 插件树（用于校验与调试，非导出）
- `dsh plugin --profile <name> add|remove|why <pkg>`：插件安装（**转发 pnpm**，在 profile 目录执行）

### 3.2 Host 侧可复用 API（插件内直接可用）
- **`ctx.settings`**：`describe({redactSecrets:true})` → 每个 namespace 的 `{ns, schema, value, base, user, applies, revision, secrets:[{path,set}]}` —— 这是导出「无密钥配置」的**主通道**；`update/replace/mutate` + `expectedRevision` 冲突检测 → 导入的**安全写通道**（SETTINGS_CONFLICT 错误即冲突信号）
- **`ctx.credentials`**：`describe(ref)` → `{configured, source:'env'|'file'|..., writable}`（永远不返回值）；`set/unset` → 导入后补录密钥的通道
- **`ctx.llm`**：`listProviders()/providerDirectory` → 当前可配置 provider 清单（与 settings `llm-*` section 对应）
- **`ctx.pluginInventory.list()`**：当前插件树（entryId/moduleName/enabled/fiberPhase）→ 插件迁移的「已安装」判定
- **`ctx.pluginMarketplace`**（web profile）：`installed()/installPlugin(pkg)/uninstallPlugin(pkg)` → 插件安装/卸载的可编程通道（内部即 npm install + 改 bundles/patch；**返回 `needsRestart`，无重启能力**）
- **`ctx.skills` / `ctx.agentPresets` / `ctx.workspace` / `ctx.sessionPersistence`**：技能 / 预设 / 工作区 / 会话的清单与读写
- **`ctx.commands`**：注册 `/export` 之类命令（dsh-session-log-export 先例）

### 3.3 Client 侧官方 API（`ctx.connection.api`，RPC over `/api`，已读 schema 源码）
- `settings.describe/update/replace/mutate/openDocument`
- `credentials.describe/set/unset`
- `llm.providers/models/discoverModels`（discoverModels 可带一次性 apiKey 探测端点模型）
- `skills.list`、`workspace.list/create/rename/delete/…`、`agentPresets.list/read/copy/remove/select/…`
- `host.describe`（version/cwd/provider/model/canOpenPath）、**`host.pickDirectory`**（原生目录选择器！导入 ZIP 选择、路径映射「Choose Folder」直接用）、`host.listDirectory/createDirectory/openPath`
- `sessions.*`、`subagents.*`、`goals.*`、`jobs.*`、`downloads`（`session.export` 下载会话日志 ZIP 的既有端点）
- 传输：`/api/events.mux`（SSE）、WebSocket downlinks

### 3.4 本机已有但非插件的实现（参考而非依赖）
`C:\Repository\DeepSeekHarness\export-dsh.ps1` + `import-dsh.ps1` + `dsh-export-test\dsh-config-20260814-171100.zip`：
- 手工 PowerShell 脚本级导出：plugins（profile package.json + cordis.patch.yml + ~/.dsh/plugins 源码）、skills、MCP（读 **`~/.claude.json` 的 mcpServers**！）、settings、secrets（可选 `-IncludeSecrets` 明文导出）
- 价值：验证了「配置文件清单」方向；**缺陷**：绕开 DSH API 直接拷文件、MCP 概念来自 Claude 而非 DSH（DSH 的 MCP 在组合 config 里）、无 manifest/schema 版本/校验/回滚 —— 正是本插件要做的正规化
- 结论：**不要复用其机制**，可参考其「导出哪些文件」的清单；本插件应走 DSH Service API + 受控文件读取

### 3.5 结论：可复用能力清单（给 m2/m3 的输入）
```
✓ settings 读（redact）写（乐观锁）     → ctx.settings / api.settings.*
✓ secrets 状态读 / 补录写               → ctx.credentials / api.credentials.*
✓ providers/models 读                  → ctx.llm + settings llm-* namespace
✓ 插件清单 / 安装 / 卸载                → ctx.pluginInventory / ctx.pluginMarketplace
✓ skills 清单与文件                     → ctx.skills + ~/.dsh/skills 文件
✓ agent presets 读写                    → ctx.agentPresets + ~/.dsh/.agent-presets 文件
✓ workspaces 读写                       → ctx.workspace / api.workspace.* + storages/workspace.json
✓ 目录选择器 / 打开路径                  → api.host.pickDirectory / host.openPath
✓ ZIP 下载通道                          → 自注册 /api 路由（dsh-ssh 范式）或 downloads 端点
✓ slash 命令入口                        → ctx.commands
✓ UI 设置页 / 侧边栏动作                → settings.section / sidebar.footer.action slots + DOM 注入
✓ 冲突检测语义                          → settings expectedRevision / SETTINGS_CONFLICT
```

---

## 4. 当前 DSH Plugin API 无法直接完成的能力（明确声明）

> 以下每条均基于真实检查，是 m2 设计阶段的硬约束。格式按规范 §34 要求。

1. **当前 DSH Plugin API 无法直接完成「配置一键迁移 / 导入导出」**：DSH 没有任何 backup/import/export/migration/sync 的实现或 API（全部约 200 个核心包源码已检查，仅有的「export」是单会话日志下载 `session.export` 与 `/export` 命令）。本插件必须自建 Export Schema、ImportPlan、校验、快照与回滚。
2. **当前 DSH Plugin API 无法直接完成「加密的 secrets 存储」**：`.credentials.yaml` 是明文（无加密层、无主密码概念）；`ctx.credentials.set()` 直接写明文。导出含密钥的备份必须由本插件用 `node:crypto` 自行加密（AES-256-GCM + scrypt KDF），且**不能**把解密密码写入任何 DSH 配置。
3. **当前 DSH Plugin API 无法直接管理 MCP 服务器**：`dsh-mcp-client` 没有 settings namespace、没有管理 service、没有增删改 API；MCP 配置只存在于组合 patch 的 config 里。导入 MCP 只能：写 profile `cordis.patch.yml` 插入 `mcp-client` 行（重启生效）→ 与「插件挂载」同机制。
4. **当前 DSH Plugin API 无法读写浏览器 localStorage 里的 UI 状态**（dsh-task-board 数据、面板宽度、部分 UI 偏好）：Host 侧无通道。迁移时需明确标注「UI 状态不迁移」或提供「仅导出清单」的降级。
5. **当前 DSH Plugin API 无法重启 dsh web 服务**：`pluginMarketplace.installPlugin` 只返回 `needsRestart:true`，重启依赖 DSH Desktop 的「restart service」按钮。本插件的「安装插件/导入后需重启生效」提示只能做到 UI 引导。
6. **当前 DSH Plugin API 无法直接完成「profile 切换」**（规范 §20 的配置 Profile 概念）：`ctx.agentPresets` 是 agent 预设（组合层），不是「配置 Profile」（settings+plugins+providers+… 的快照）。配置 Profile 必须由本插件自建存储（建议 `~/.dsh/dsh-config-manager/` 或 settings namespace）。
7. **当前 DSH Plugin API 无法在运行中持久化「插件启用/禁用」**：loader 树由 patch 文件决定，运行期 `pluginInventory.list()` 只读；要持久化需本插件写 patch 文件（与 marketplace 同机制）并提示重启。
8. **当前 DSH Plugin API 没有「配置事务 / 原子导入」**：`settings.update` 逐 namespace 提交；跨命名空间、跨文件（skills/workspaces/credentials）的整体回滚必须由本插件实现应用层快照 + compensating actions（规范 §27 已预判）。
9. **当前 DSH Plugin API 不提供会话批量导出/导入**：只有单会话日志下载。历史会话迁移要么逐会话走 `session.export`，要么文件级复制 `~/.dsh/sessions/`（zstd jsonl，需处理编码与版本），默认应**不迁移**（规范默认关闭 History）。
10. **当前 DSH Plugin API 没有「UI 主题 / keybinding / 布局」的标准配置面**：主题是皮肤插件（`dsh-client-ui-skin-*`，经 cordis.patch.yml 挂载），keybinding 不存在，布局在 localStorage。只能按「插件（皮肤）清单 + settings namespace + 明确不迁移项」处理。

---

## 5. 推荐实现路线（给 m2 设计 / m3 实现的输入）

### 5.1 项目形态（照抄 dsh-ssh 工程范式，已被本机验证）
```
DSH Config Manager/
├── packages/dsh-config-manager/          # （或仓库根即包）
│   ├── package.json                      # name/exports("./client")/dsh.bundle.patch/dsh.client
│   ├── cordis.patch.yml                  # - insert: - id: config-manager, name: '@…/dsh-config-manager'
│   ├── tsconfig.json / tsconfig.build.json
│   ├── tsdown.config.ts                  # 构建 lib/（index.js + client.js）
│   ├── src/
│   │   ├── index.ts                      # Host 半：services、/api/dsh-config-manager 路由、agent 工具、settings namespace
│   │   ├── core/                         # exporter / importer / analyzer / validator / backup / rollback / plan
│   │   ├── adapters/                     # settings / credentials / plugins / providers / mcp / skills / workspaces / agentPresets
│   │   ├── schema/                       # manifest schema（schemaVersion v1）
│   │   ├── migrations/                   # v1→v2 迁移目录
│   │   ├── security/                     # secret-scanner / encryption / integrity / zip-security / redaction
│   │   ├── profiles/                     # 配置 Profile 存储（W6）
│   │   └── client/                       # React UI：settings.section 页 + 可选 sidebar.footer.action
│   └── tests/
```
- **挂载**：把包 `dsh plugin --profile web add <path|pkg>` 安装进 profile；声明 `dsh.bundle.patch` 成为 bundle，或直接 patch 行
- **构建**：`tsc`（类型）+ `tsdown`（bundle client）→ `lib/`；与 dsh-ssh 完全一致
- **运行时**：Host 半跑在 dsh 进程（Node ≥22，`node:zlib` 有内置 **zstd**，`node:crypto` 有 scrypt/aes-256-gcm），Client 半跑 Web GUI

### 5.2 依赖策略（最小依赖，符合规范 §34.15）
- 必需 peer/依赖：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-llm`（类型）、`@deepseek-ai/schemastery`、react/react-dom（client）
- ZIP：优先 **Node 内置**（`node:zlib` deflate + 自写最小 ZIP 容器，或系统 `Compress-Archive` 不可用时的内置方案）；若追求稳妥可引 `fflate`（~8KB，唯一候选）—— 由 m3 决定，**不引入 archiver/yazl 等大依赖**
- 加密：**`node:crypto`**（scrypt + AES-256-GCM），零依赖
- 校验：`node:crypto` SHA-256；YAML 解析用 `js-yaml`（DSH 生态同款）
- 测试：`vitest`（dsh-ssh 同款）

### 5.3 关键架构决策建议（已由研究发现支撑）
1. **导出主通道 = `ctx.settings.describe({redactSecrets:true})` + 逐项文件读取**；绝不打 `~/.dsh` 整包
2. **schemaVersion v1 + migrations/**：settings namespace 与文件格式都可能随 DSH 版本演化；manifest 必须记 dshVersion/schemaVersion/exporter 版本
3. **秘密默认不导出**；「含秘密完整备份」= 可选 + 密码加密（scrypt→AES-256-GCM），密码绝不入 manifest
4. **导入 = analyze → plan → preview → snapshot → execute → validate → rollback**；用 `settings.expectedRevision`（SETTINGS_CONFLICT）做冲突检测；快照 = 导出被改项的原值（应用层事务）
5. **插件迁移**：导出 `{name, version, isBundle, inBundles}`（`pluginInventory`/`pluginMarketplace.installed()` 可得），导入时「已装→跳过/更新，未装→installPlugin（提示重启）」，**绝不把插件二进制打进 ZIP**
6. **MCP 迁移**：作为「组合 config 条目」导入（写 profile cordis.patch.yml 的 `mcp-client` 行），标记 needsRestart；依赖检测（npx 等）按规范 §15
7. **路径映射**：`storages/workspace.json` 的绝对 path + MCP cwd + 插件配置里的路径都要过 analyzer；UI 用 `api.host.pickDirectory` 做「Choose Folder」
8. **UI**：主界面注册 `settings.section`（id:`config-manager`，label「Backup & Migration」）；若需侧边栏入口，抄 dsh-ssh 的 DOM 注入范式；进度用现有样式体系
9. **设备 ID / sessions / localStorage / logs 默认不导出**（规范 §34.19/20）
10. **本插件自身配置**（最近备份、Profile 列表）存 `~/.dsh/dsh-config-manager/`（参照 dsh-ssh.json 先例）或 settings namespace

### 5.4 版本与兼容
- 本机 DSH：`0.1.0-rc.6`（`@deepseek-ai/dsh` package.json）
- 本机 Node：需 `^22.19.0 || >=24.0.0`（dsh-ssh engines 声明，即 DSH 运行基线）
- 平台：Windows（本机），但 DSH 核心包普遍做了 POSIX/Windows 双路径（settings-file 的锁、session 的 win32 mkdir、credentials 的 0600 跳过）—— 插件代码应同样双平台考虑，路径处理一律 `node:path`

---

## 6. 附录：本机已装插件与仓库（工程参考索引）

| 插件 | 包名 | 位置 | 参考价值 |
|---|---|---|---|
| dsh-ssh | `@linxin666/dsh-ssh@0.1.12` | `~/.dsh/profiles/web/node_modules/@linxin666/dsh-ssh/`（**含完整 src/**） | **首选工程范本**：Host+Client 双半、routes/tools/settings namespace、DOM 侧边栏注入、store 原子写 |
| 任务看板 | `@linxin666/dsh-client-ui-task-board` | 同目录 | Client 半、localStorage 数据、DOM 注入先例 |
| 右侧面板 | `@linxin666/dsh-client-ui-aionui-panel` | 同目录 | Client 半、host /aionui-panel 路由 |
| 聚合包 | `@linxin666/dsh-web-ui-all` | 同目录 | 多插件 bundle patch 聚合范式 |
| 插件市场 | `@deepseek-ai/dsh-plugin-marketplace` | `~/.dsh/profiles/web/node_modules/@deepseek-ai/` | Host Typert Remote + client 调用范式；`installPlugin` 的真实实现（npm 驱动） |
| 皮肤 | `~/.dsh/plugins/dsh-deep-whale/` | git 源码仓库 | 「本地 git 源码插件」形态 |
| 全家桶仓库 | `github.com/zhu1090093659/dsh-web-ui` | 线上（本机安装的是 npm 产物） | 插件开发/发布参考 |

*注：本机 `~/.dsh/plugins/` 只有皮肤源码仓库；dsh-ssh 等通过 `dsh-web-ui-all` bundle 挂载，未在 `~/.dsh/plugins/`。*

---

## 7. 对 m2（设计）的移交清单

1. Export Schema / manifest（v1）字段已可定：以 §2.2 表为准，只含 DSH 真实存在的概念
2. Adapter 清单（m3 输入）：settings、credentials(状态)、plugins、providers(models)、mcp(组合config)、skills、workspaces、agentPresets、sessions(默认关)、plugin-own-files(如 dsh-ssh.json)
3. 冲突模型：settings 乐观锁（expectedRevision）+ 文件级 mtime/hash 比对
4. 秘密模型：默认不含；加密备份走 node:crypto scrypt+AES-256-GCM；「3 credentials need attention」来自 credentials.describe()
5. 快照/回滚：应用层（settings 每个 namespace 先 describe 后 replace；文件先复制后写）
6. 不可完成项（§4）必须体现在产品说明与 UI 文案，禁止假装支持
