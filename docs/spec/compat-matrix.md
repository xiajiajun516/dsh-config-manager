# DSH 兼容矩阵（compat-matrix）

> 本文件回答一个问题：**本插件支持哪个 DSH 版本区间，以及 DSH 升级时哪一部分会先破。**
> 所有断言均标注取证位置（`file:line`）或标记为「未验证」。凡未实际读取文件确认的结论一律不写入本文件。

- 适用插件版本：`dsh-config-manager@0.1.59`（`package.json:3`，与 `src/index.ts` 的 `export const PLUGIN_VERSION` 一致）
- 取证环境：Windows，Node `v24.13.0`，npm `11.19.0`
- 本机 DSH 部署：`@deepseek-ai/dsh@0.1.5-rc.1`（`D:\Apps\nodejs\node_global\node_modules\@deepseek-ai\dsh\package.json`）

---

## 0. 取证方法（可复现）

| 取证对象 | 实际做法 |
|---|---|
| 插件声明 | 直接读 `package.json`（`peerDependencies` / `devDependencies` / `engines` / `dsh`） |
| 本机 DSH 部署 | `node -e "require('.../@deepseek-ai/dsh/package.json')"` 读取其 `version` 与 `dependencies`（不猜） |
| 实际生效版本 | 读 `$DSH_HOME/profiles/web/package.json` + `pnpm-workspace.yaml` + `$DSH_HOME/profiles/node_modules/@deepseek-ai/*/package.json` |
| 插件运行时解析目标 | `createRequire(pathToFileURL(插件 lib/index.js)).resolve(spec)` 逐个解析 10 个官方包 |
| 构建产物是否真的引用 | 在 `lib/` 全部 `.js` 中按字符串计数各 `@deepseek-ai/*` 出现次数 |
| semver 行为 | 用 DSH 自带的 `semver` 实测 `^0.1.0-rc.6` 对各候选版本的判定 |
| 官方 API 面 | `require()` 各版本 `lib/index.js`，比较 `Object.keys(exports)` |

**编码校验**：本文件写入后以 Node 逐字节读取校验，确认不含零宽字符（正则 `[\u200b\u200c\u200d\u2060\ufeff]`）、且为合法 UTF-8。PowerShell 控制台显示的中文 mojibake 属显示层假象，不作为编码判据。

---

## 1. host 半依赖的官方服务清单

### 1.1 硬依赖（写入 `inject`，缺失则插件 fiber 不挂载）

`src/index.ts` 的 `export const inject`：

```ts
export const inject = ['settings', 'credentials']
```

| 服务 | 用途 | 取证位置 |
|---|---|---|
| `settings` | 读写 `$DSH_HOME/settings.yaml` 的非 UI 类 namespace（导出/导入/回滚/快照 diff），并经 `describe({redactSecrets:true})` 让 DSH 剥离已知秘密 | `src/index.ts` 的 `export const inject`（inject）；`src/index.ts` 的 `class DshSettingsFacade`；`src/index.ts` 的 `resolveAppLanguage`（读 locale namespace）；`src/index.ts` 的 `createAdapters({ namespaces: … })` 注入点（列出全部 namespace：`ctx.settings.describe({redactSecrets:true})`） |
| `credentials` | 凭据**状态**读写（`describe`/`set`/`unset`），用于同步 token、WebDAV 密码、GitHub device flow token 的槽位引用 | `src/index.ts` 的 `export const inject`（inject）；`src/index.ts` 的 `class DshCredentialsFacade`；`src/index.ts` 的 `makeRoutes({ credentials: ctx.credentials, … })` 调用（注入路由依赖） |

### 1.2 可选服务（一律 `ctx.get()` 惰取，缺失时降级而非崩溃）

`src/index.ts` 头部设计注释明确记录了这一策略：「Optional services are read with ctx.get() at call time (never injected)」。

| 服务 | 用途 | 缺失时的行为 | 取证位置 |
|---|---|---|---|
| `workspaceRegistry` | 工作区记录的列举/建/删/改标题（`workspaces` 分区） | `listRecords()` 返回 `[]`；写入抛 `host.workspaceUnavailable` | `src/index.ts` 的 `function readService`；`DshWorkspaceFacade.registry()`（唯一读取点）；`DshWorkspaceFacade` 的 `listRecords` / `writeRecord` / `removeRecord` / `attachSession` |
| `webServer` | 注册 `/api/dsh-config-manager/*` 全部 HTTP 路由 | 记一条 warn 并 `return`：**路由完全不注册**，引擎能力仍在但浏览器半不可用 | `src/index.ts` 的 `readService<WebServer>(ctx, 'webServer')` 缺失分支（warn + `return`；路由注册见 `src/routes/kit.ts` 的 `registerRoutes`） |
| `tools` | 注册 5 个 Agent 可调用模型工具（`config_backup` 等） | 记一条 warn 并 `return`，跳过工具注册 | `src/core/model-tools.ts`；`src/core/model-tools.ts:320+`（`defineTool` 薄壳） |

> `src/core/model-tools.ts:313-315` 有一条硬约束注释：**必须**经 `ctx.get('tools')` 的返回值注册，绝不能写 `ctx.tools.register` —— Cordis 的属性访问要求插件声明 `inject:['tools']`，未声明时即使服务存在也会抛 `cannot get property X without inject`。`src/core/model-tools.test.ts` 用模拟 ctx 固定了这个守卫。

### 1.3 非 Cordis 服务、但同样是 host 侧「官方契约」的依赖

| 依赖 | 用途 | 取证位置 |
|---|---|---|
| `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` / `dshHomePath()` | 解析 `$DSH_HOME`（`homeDir`）与插件数据根 `$DSH_HOME/dsh-config-manager` | `src/index.ts` 的 `import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'`（import）；`apply()` 内 `resolveDshHome()` 与 `dshHomePath('dsh-config-manager')` |
| 官方 `dsh plugin --profile <name>` CLI | 插件安装/列举通道（pnpm forwarder），不依赖 `pluginMarketplace` / `pluginInventory` 服务 | `src/index.ts` 头部设计注释（不依赖 web-only `pluginMarketplace` / `pluginInventory`）；`src/core/plugin-cli.ts`（实现）；`src/index.ts` 的插件 CLI facade（`listInstalledPlugins()` / `runner(…, ['add', …])`） |
| `$DSH_HOME/cordis.patch.yml` + `$DSH_HOME/profiles/<name>/cordis.patch.yml` 文件格式 | MCP / prompts 分区与插件激活行的读写对象（经 `js-yaml`，非官方服务） | `src/index.ts` 的 `PROFILE_PATCH_FILE`（`'cordis.patch.yml'`）与 patch 读写实现（`patchFile.readPatchLines` / `applyPatchChanges`）；`src/adapters/index.ts` 的 `USER_PATCH_FILE` —— 该常量在 `src/index.ts` 只被 import，未在那里定义 |

**运行时真实 import 的官方包只有 4 个**（在构建产物 `lib/` 全量 `.js` 中按字符串计数验证）：

| 官方包 | 出现位置 | 出现次数 |
|---|---|---|
| `@deepseek-ai/dsh-settings` | `lib/index.js:42` | 1 |
| `@deepseek-ai/dsh-credentials` | `lib/index.js:43` | 1 |
| `@deepseek-ai/dsh-home-paths` | `lib/index.js:44` | 1 |
| `@deepseek-ai/dsh-tools` | `lib/core/model-tools.js` | 1 |

其余 `@deepseek-ai/*` 在 `lib/` 中**出现 0 次** —— 即 `dsh-workspace`、`dsh-host-webserver` 是纯 `import type`（`src/index.ts` 的 `import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'`，源码注释明写 "Type-only … without any runtime import"），编译后不留痕迹。

---

## 2. client 半依赖的官方包清单

### 2.1 运行时：client bundle 对官方包的真实依赖 = 0

对已安装产物 `lib/client.js`（**1,046,404 字节 / 960,801 字符**）做 `require("…")` 字面量扫描，**外部 require 只有 4 个**：

```
react
react-dom
react/jsx-runtime
node:https   ← 仅出现在解释历史 bug 的注释文本里，不是真实调用
```

`node:https` 那处命中位于 `src/market/upstream.ts` 的注释中，该注释本身在解释「为什么官方市场常量要单独成零依赖文件」——因为一旦 client 从 `github-repos.ts` 导入，rolldown 会把经 `utils/proxy.ts` 依赖 `node:https` 的整条依赖链拉进浏览器 bundle，DSH loader 模块表没有该条目，插件直接加载失败。**这是一个已被修掉的坑，不是现存依赖。**

`@deepseek-ai/*` 在 `lib/client.js` 中出现 **0 次**。即：client 半对全部 6 个 `dsh-client-*` peer 包都是**纯类型依赖**，只在编译期生效。

### 2.2 编译期：6 个 `dsh-client-*` peer 包

| 包 | 用途 | 取证位置 |
|---|---|---|
| `@deepseek-ai/dsh-client-runtime` | `ClientContext` 类型来源 | `src/client/client-types.ts:12` |
| `@deepseek-ai/dsh-client-locale` | 拉入 `ctx.locale` 的 `Context` 合并（`locale.register` / `bind` / `getLocale`） | `src/client/index.ts:18`；`src/client/index.ts:87-105` |
| `@deepseek-ai/dsh-client-ui-settings` | 拉入 `settings.section` 的 `SlotMap` 合并 | `src/client/index.ts:20`；`src/client/index.ts:111` |
| `@deepseek-ai/dsh-client-ui-slots` | `SlotMap` / `LocaleNamespaceMap` / `TranslateNS` / `PropsRuntime` 合并表 | `src/client/client-types.ts`；`src/client/ConfigManagerSection.tsx:23`；`src/client/index.ts:22,50-63` |
| `@deepseek-ai/dsh-client-connection` | 见 2.3 —— 仅出现在 `dsh.client.inject`，源码无 import | `package.json:63`（`dsh.client.inject`） |
| `react` / `react-dom` | React 18 运行时，由 client 运行时以 seed 形式提供 | `package.json:106-107`；`tsdown.config.ts:99` |

### 2.3 `dsh.client` 声明面

`package.json:57-69`：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-ui-settings"
    ],
    "platform": "web"
  }
}
```

已安装产物 `$DSH_HOME/profiles/web/node_modules/dsh-config-manager/package.json` 的 `dsh` / `engines` 字段与仓库一致（`version: 0.1.59`，`engines.node: ^22.19.0 || >=24.0.0`），**未验证**该目录是否为符号链接以外的其它安装形态。

### 2.4 client 侧的宿主契约（读 DSH 实现源码取证）

`dsh.client.inject` 的**语义是排序提示，不是硬依赖**。取证（`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-client-modules`，`0.1.0-rc.8`）：

- `lib/index.js:145` 读取 `dsh.client.inject`；`lib/index.js:334` 仅在非空时写入 boot graph row 的 `inject` 字段。
- `lib/client.js:265-268`：对每个 `row.inject` 名字 `graphRows.get(name)`，**`dependency !== undefined` 才递归等待**；未命中的名字直接跳过，**不抛错**。
- 对比 `lib/client.js:300-309` 的 `makeRequire`：`require(spec)` 若既不在 seed、也不在已物化表、也无注册 factory，才抛 `client-modules: require("…") missed the module table`。

即：**「`dsh.client.inject` 声明了 boot graph 里不存在的包」不会导致加载失败**；只有 bundle 里真实的 `require(...)` 落不到 seed/factory 才会炸。

平台 seed 表（即 `require` 能直接命中的白名单）在 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js` 中定义，共 9 项：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

**关键推论**：本插件 client bundle 的外部 require 恰好是 `react` / `react-dom` / `react/jsx-runtime`，三者全在 seed 表内 → 当前可加载。若 DSH 将来把 `react/jsx-runtime` 从 seed 表移除，或把 React 升到 19（seed 版本与 `peerDependencies` 的 `^18.2.0` 冲突），client 半会**立即整块加载失败**。详见 §6 风险表 R7。

---

## 3. peer 声明范围 vs 本机实测版本

### 3.1 peer 声明（`package.json:91-108`，共 14 个官方包 + react/react-dom）

`@deepseek-ai/dsh-agent-presets`、`dsh-client-connection`、`dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-settings`、`dsh-client-ui-slots`、`dsh-credentials`、`dsh-home-paths`、`dsh-host-plugin-inventory`、`dsh-host-webserver`、`dsh-llm`、`dsh-settings`、`dsh-system-prompt`、`dsh-tools` —— **全部声明为 `^0.1.0-rc.6`**；`react` / `react-dom` 为 `^18.2.0`。

### 3.2 本机三套并存的实际版本

| 版本宇宙 | 位置 | 版本 | 插件是否真的用它 |
|---|---|---|---|
| **DSH 应用本体** | `D:\Apps\nodejs\node_global\node_modules\@deepseek-ai\dsh` | **`0.1.5-rc.1`** | — （仅决定 loader / 客户端 shell 行为） |
| **DSH profile 解析** | `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（244 个包） | **`0.1.5-rc.2`** | 否（见下） |
| **插件自身解析** | `D:\Projects\personal\dsh-config-manager\node_modules/@deepseek-ai/*` | **`0.1.0-rc.6` / `0.1.0-rc.8`** | **是** |
| 仓库 devDependencies 声明 | `package.json:109-137` | 多数 `^0.1.0-rc.6`，`dsh-timeout` 为 `^0.1.0-rc.8` | 决定上者装到什么 |

**为什么插件用的是 rc.6/rc.8 而不是 profile 的 rc.2**：

1. `$DSH_HOME/profiles/web/package.json` 中该插件是 **link 依赖**：`"dsh-config-manager": "link:D:/Projects/personal/dsh-config-manager"`；
2. `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 设了 `nodeLinker: hoisted` 且 **`autoInstallPeers: false`** → pnpm 不会为它补装 peer；
3. 于是 `lib/index.js` 的裸 import 沿 Node 解析规则落到**仓库自己的** `node_modules`。

用 `createRequire(插件 lib/index.js).resolve()` 实测，10 个官方包全部解析到 `D:\Projects\personal\dsh-config-manager\node_modules\.pnpm\...`：

| 官方包 | 插件实际解析到 |
|---|---|
| `dsh-settings` | `0.1.0-rc.6` |
| `dsh-credentials` | `0.1.0-rc.6` |
| `dsh-home-paths` | `0.1.0-rc.6` |
| `dsh-tools` | `0.1.0-rc.8` |
| `dsh-workspace` / `dsh-host-webserver` | `0.1.0-rc.6`（纯类型，运行时不用） |

> **发布形态差异（重要）**：从 npm 正常安装（非 link）时，插件落在 `$DSH_HOME/profiles/web/node_modules/dsh-config-manager/`，其裸 import 会解析到 **profile 的 `0.1.5-rc.2`**。因此「同一份插件代码，link 开发态跑 rc.6、发布态跑 rc.2」是现实存在的双解析路径。**未验证**发布态（非 link）在真实 npm 安装下的完整行为，仅验证了解析规则与两套版本的 API 差异（见 §3.4）。

### 3.3 「rc 期 semver 不可靠」——实测结论

用 DSH 自带 `semver` 实测 `^0.1.0-rc.6`（本插件全部 peer 的范围）：

| 候选版本 | 默认 `semver.satisfies` | `{includePrerelease:true}` |
|---|---|---|
| `0.1.0-rc.6` | ✅ true | ✅ true |
| `0.1.5-rc.2`（profile 实际） | ❌ **false** | ✅ true |
| `0.1.5-rc.1`（DSH 本体） | ❌ **false** | ✅ true |
| `0.1.6`（假设正式版） | ✅ true | ✅ true |
| `0.1.99` | ✅ true | ✅ true |
| `0.2.0` | ❌ false | ❌ false |
| `0.1.0-rc.5`（更旧的 rc） | ❌ false | ❌ false |

**结论与风险**：

1. `^0.1.0-rc.6` 在**默认语义**下**不匹配任何 `0.1.x-rc.y`（y>6）**。语义上，`^0.1.0-rc.6` 的 `<upper>` 是 `0.1.0` 的最后一个 prerelease —— 按 semver 规范，`0.1.0-rc.7` 会匹配，但 `0.1.1-rc.1` 这类**更高 patch 的 prerelease 不匹配**。本插件当前靠 `autoInstallPeers: false` + link 安装「绕过」了这条规则，而不是「满足」了它。
2. **一旦有人打开 `autoInstallPeers`，或走严格 peer 校验的包管理器（pnpm strict-peer-dependencies / npm 的 peer 校验），peer 会立刻报冲突** —— 因为 profile 装的是 `0.1.5-rc.2`，默认语义下不满足 `^0.1.0-rc.6`。这是本插件**最脆的一条声明**。
3. `0.2.0` 不匹配 → **DSH 一旦进 `0.2.x`，本插件全部 peer 范围集体失效**，无论 rc 与否。
4. rc 期 semver 不可靠的根因：prerelease 段的存在使「兼容区间」的实际边界依赖工具的 `includePrerelease` 选择，而 npm / pnpm / 各 loader 的选择并不统一。**因此本插件的兼容性事实上靠「运行时实测 + 优雅降级」维持，而不是靠 semver 保证。**

### 3.4 API 面漂移实证（rc.6 vs rc.2）

`dsh-settings` 的导出（实测 `Object.keys`）：

| 版本 | 导出 |
|---|---|
| `0.1.0-rc.6`（插件 link 态实际用） | `SettingsConflictError, SettingsProvider, deepEqualJson, installSettingsSection, redactSecrets, settingsNamespace, default` |
| `0.1.5-rc.2`（profile 解析） | `SettingsConflictError, SettingsProvider, redactSecrets, default` |

→ **`settingsNamespace` / `deepEqualJson` / `installSettingsSection` 在 rc.6 → rc.2 之间被移除。**
插件对此**有防御**：`src/index.ts` 的 `safeSettingsNamespace` 先探测 `typeof fn === 'function'`，不在时回退为正则校验的纯字符串；`src/index.ts` 的 `safeCredentialRef` 同构。这是 rc 期 API 漂移已被踩过的直接证据（源码注释点名兼容 `0.1.1` 与 `0.1.2-alpha.x`）。

`dsh-credentials` 的导出：rc.6 为 4 项，rc.2 为 10 项（新增 `credentialKey` / `credentialKeyId` / `credentialKeyScope` / `isCredentialKeySegment` / `isCredentialRefName` / `parseCredentialKey`），`credentialRef` 两版都在 → **本插件不受影响**。

> **未验证**：`dsh-settings@0.1.0-rc.8` 的导出面（仓库内未安装该版本），以及 `dsh-tools@0.1.5-rc.2` 与 `0.1.0-rc.8` 之间 `defineTool` 签名的差异。`defineTool` 在两版均存在（实测 probe 命中），但签名未比对。

---

## 4. Node engines 与理由

`package.json:30-32`：

```json
"engines": { "node": "^22.19.0 || >=24.0.0" }
```

| 事实 | 取证 |
|---|---|
| 本机实际 Node 为 `v24.13.0` → 落在 `>=24.0.0` 分支，满足 | `node -v` |
| 排除 Node 23.x 与 25.x 以下的所有奇数/中间版本：`^22.19.0` 允许 `22.19.0 ≤ v < 23`，`>=24.0.0` 允许 `24.0.0` 以上 | 范围字面语义 |
| **未验证**：`22.19.0` 这个下限的具体技术理由（仓库内无注释说明，`DEVELOPERS.md` 亦未记录） | 无取证 |
| **未验证**：DSH 运行时是否真的强制 engines。对 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 下 724 个 `.js` 文件扫描 `EBADENGINE` / `Unsupported engine`，**命中 0 处** | 全量扫描 |
| `@types/node` 声明为 `^26.2.0`（`package.json:128`），仅影响类型检查，不影响运行时 | `package.json:128` |

**实践含义**：`engines` 目前是**声明性**的，不是运行时可强制的门槛。真正决定可用性的是宿主 Node 能否加载插件的 ESM 产物与 DSH 自身的 Node 要求。

---

## 5. 升级风险表

「DSH 若改动 X → 本插件哪一部分会破 → 用户看到什么现象 → 如何快速定位」

| # | DSH 若改动 | 会破的部分 | 用户看到的现象 | 快速定位 |
|---|---|---|---|---|
| **R1** | `settings` 服务方法签名（`describe` 返回结构、`replace`/`update` 的 revision 语义）或 `settingsNamespace` 一类导出再次变动 | host 半全部读写路径：13 个 adapter 里的 settings/providers/credentials、回滚、快照 diff | 导出/导入/回滚报 `namespace not found` 或 revision 冲突；`设置` tab 空数据 | `ctx.get('settings')` 是否存在 → `src/index.ts` 的 `class DshSettingsFacade`；`Object.keys(require('@deepseek-ai/dsh-settings'))` 比对 `settingsNamespace` |
| **R2** | `credentials` 服务方法签名或 `credentialRef` 导出移除 | 同步 token / WebDAV 密码 / GitHub device flow 的槽位读写 | 同步配置保存后 `passwordConfigured` 恒 false；WebDAV/Git 同步鉴权失败 | `src/index.ts` 的 `class DshCredentialsFacade`；`Object.keys(require('@deepseek-ai/dsh-credentials'))` |
| **R3** | `webServer` 服务名或 `register(route)` 契约变化 | **整个 `/api/dsh-config-manager/*` 路由族** | 设置页能打开但每个操作都失败；host 日志出现 `webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册` | `src/index.ts` 的 `readService<WebServer>(ctx, 'webServer')` 缺失分支（缺服务即打这条 warn）；确认 `ctx.get('webServer')` |
| **R4** | `workspaceRegistry` 服务名或 `list/get/create/delete` 契约变化 | `workspaces` 分区 | 工作区列表导出为空；导入工作区报 `host.workspaceUnavailable` | `DshWorkspaceFacade.registry()`（服务名硬编码 `'workspaceRegistry'`）；`DshWorkspaceFacade` 的其余方法 |
| **R5** | `tools` 服务名或 `register(toolDef)` 契约变化 / `defineTool` 签名变化 | 5 个 Agent 模型工具（`config_backup` 等） | Agent 侧工具消失或调用报错；host 日志 `tools 服务不可用：跳过模型工具注册` | `src/core/model-tools.ts`；`src/core/model-tools.test.ts` 复现守卫 |
| **R6** | `dshHomePath` / `resolveDshHome` 语义变化（`$DSH_HOME` 解析规则、返回路径形态） | 插件数据根、所有文件级读写、快照目录 | 数据写到意外位置；快照/导出列表「看不到刚做的备份」 | `apply()` 内 `resolveDshHome()` / `dshHomePath('dsh-config-manager')`；直接 `console.log(resolveDshHome())` |
| **R7** | client 运行时 seed 表变化（移除 `react/jsx-runtime`，或 React 升到 19 与 peer `^18.2.0` 冲突） | **整个 client 半**（设置页整块） | 设置页 `config-manager` section 不出现，或页面出现 `client-modules: require("react/jsx-runtime") missed the module table` | 读 `dsh-web-frontend/dist/assets/index-*.js` 里的 seed 表（`by()` 函数，9 项）；读 `dsh-client-modules/lib/client.js:300-309` 的抛错点 |
| **R8** | `settings.section` Slot 契约变化（owner props、`register` 字段、`inject` face 形态） | 设置页注册 | 设置页 section 消失或白屏；控制台报 Slot 注册失败 | `src/client/index.ts:111-118`；对照 DSH 的 `dsh-client-ui-settings` SlotMap |
| **R9** | `ctx.locale.register/bind/getLocale` 契约变化 | 全部 5 套 locale 字典 + `UiT` | 界面文案回退成裸 key（如 `section.label`）或英文/中文错配 | `src/client/index.ts:87-105`；`src/ui/i18n.ts`（缺 key 静默返回 key 本身） |
| **R10** | `dsh.client.inject` / `dsh.client.platform` 字段校验变严（例如要求 inject 名字必须命中 boot graph） | client 半装载 | 设置页不出现；控制台报 client-modules 图相关错误 | 现状为「未命中即跳过、不抛错」（`dsh-client-modules/lib/client.js:265-268`），若 DSH 改为抛错则本节结论失效 |
| **R11** | 插件加载器改为**强制 peer / engines 校验** | 安装/启动期 | 插件装不上或启动即被拒；报 peer 冲突（因 profile 为 `0.1.5-rc.2`，默认语义不满足 `^0.1.0-rc.6`） | §3.3 的 semver 实测表；检查 profile 是否开了 `autoInstallPeers` |
| **R12** | DSH 进入 `0.2.x` | 全部 peer 范围 | 同 R11，且与 rc 无关（`^0.1.0-rc.6` 的上界是 `0.2.0`） | §3.3 表末行 |
| **R13** | `$DSH_HOME/cordis.patch.yml` 或 profile patch 文件格式变化 | MCP 分区、prompts 分区、插件激活行 | MCP/prompts 导入后不生效；`patch 行` 解析报错 | `src/index.ts` 的 `PROFILE_PATCH_FILE` 与 patch 读写实现（`patchFile.readPatchLines`）；`src/adapters/mcp.ts`；`src/adapters/prompts.ts` |
| **R14** | profile 目录布局变化（`profiles/<name>/` 或 `profiles/node_modules`） | `resolveDshVersion`（版本显示）、`resolveProfileDir`、插件 CLI 通道 | 关于页版本显示 `unknown`；插件安装/列举失败 | `src/index.ts` 的 `resolveDshVersion`（两个候选路径）；`src/core/plugin-cli.ts` |

### 5.1 按「先破顺序」排序的直觉

按本插件对契约的**暴露面**排序，DSH 大版本升级时最可能先破的是：

1. **R3（`webServer`）** —— 唯一让整个浏览器半变砖的单点；且它缺失时插件**不报错**，只打一条 warn，用户会误以为插件坏了。
2. **R1（`settings`）** —— 13 个 adapter 里过半依赖它，且 revision 冲突是静默的语义错误。
3. **R7（client seed 表）** —— 影响面 100%，但触发条件是 React 主版本变化，节奏可预测。
4. **R11 / R12（peer 校验 / `0.2.x`）** —— 一旦触发是「装不上」，比「装上了但坏」更好定位。

---

## 6. 「什么情况下必须升 major」判定规则

本插件当前为 `0.1.x`（`package.json:3`）。按 semver 的 prerelease 语义与 §3.3 的实测，**判定必须升 major（对 `0.x` 而言即 `0.1.x → 0.2.0`，因为 `0.x` 下 minor 承担 breaking 语义）** 的规则如下：

### 规则 M1 —— peer 上界被越过（硬规则）

只要本插件声明支持的最高 DSH 系列从 `0.1.x` 变为 `0.2.x`，**必须**升 minor/major 并同步改 `peerDependencies` 全部 14 个范围。
依据：`^0.1.0-rc.6` 对 `0.2.0` 实测判定为 **false**（§3.3）。

### 规则 M2 —— 任一硬依赖服务被移除或改名

`inject` 中的 `settings` / `credentials`（`src/index.ts` 的 `export const inject`）任一被 DSH 移除或改名 → **必须**升 major。
理由：这会让插件 fiber 直接不挂载，属不可降级的破坏。

### 规则 M3 —— 可选服务契约破坏且无降级路径

`webServer` / `workspaceRegistry` / `tools` 三者中，若某个的服务名或方法签名变化**且插件无法用 `ctx.get()` + 特性探测继续工作** → **必须**升 major。
若仍能靠探测降级（例如 `webServer` 缺失时只丢路由、引擎仍可用），则可只升 patch/minor 并在文档标注降级行为。

### 规则 M4 —— client seed 表或 Slot 契约破坏

出现 R7（React 主版本变化 / seed 表移除本插件 require 的模块）或 R8（`settings.section` Slot 契约变化）→ **必须**升 major。
理由：client 半无降级路径，`require` 未命中即整块失败。

### 规则 M5 —— 数据格式（manifest / schema / patch 文件）不向后兼容

`CURRENT_SCHEMA_VERSION` 变更（`src/schema/`）或导出 ZIP 的 manifest 结构不向后兼容，导致**旧版本插件无法读取新版本产出的备份** → **必须**升 major，并在 CHANGELOG 给出迁移说明。
理由：备份文件是跨版本资产，读不了即数据风险。

### 规则 M6 —— 声明范围与实测范围脱节

若某一版 DSH 发布后，本插件的 peer 范围在**默认 semver 语义**下不满足实际安装的 DSH 版本（当前即已处于该状态：profile `0.1.5-rc.2` vs `^0.1.0-rc.6`）→ **不**自动触发 major，但**必须**修正 peer 范围使其在默认语义下成立（例如改为 `^0.1.0-rc.6 || ^0.1.5-rc.1` 或按 DSH 实际发布节奏重设）。
理由：这属于声明缺陷，不是行为破坏；但长期不修会累积成 R11 的安装期爆炸。

### 规则 M7 —— 不需要升 major 的情形（明确排除）

以下变化**不**构成升 major 的理由：

- DSH 仅在 `0.1.x` 内发布新的 `-rc.y`（如 rc.6 → rc.8 → rc.10）：实测 rc.6 → rc.2 的 API 漂移已被 `safeSettingsNamespace` / `safeCredentialRef` 一类探测吸收；仍属 patch/minor。
- 仅 `devDependencies` 里的官方包版本变化，且运行时真实使用的 4 个包（`dsh-settings` / `dsh-credentials` / `dsh-home-paths` / `dsh-tools`）导出面未变。
- 插件自身功能新增（新增分区、新增 UI tab）—— 属 minor。
- 新增未被 peer 声明的可选服务依赖（走 `ctx.get()` 惰取）—— 属 minor。

### 规则 M8 —— 判定所需的最小证据集

每次 DSH 升级后，**必须**重新采集并记录：

1. `@deepseek-ai/dsh` 自身 `version`（读其 `package.json`）。
2. profile 内 `@deepseek-ai/dsh-*` 的实际版本（读 `$DSH_HOME/profiles/node_modules/@deepseek-ai/*/package.json`）。
3. 用 `createRequire` 从插件 `lib/index.js` 解析 §1.3 的 4 个运行时包，记录解析目标与版本。
4. 比对这 4 个包的 `Object.keys(exports)` 与本文 §3.4 基线。
5. 读 DSH 的 client seed 表（`dsh-web-frontend/dist/assets/index-*.js` 中 `by()` 的返回对象），确认仍含 `react` / `react/jsx-runtime` / `react-dom`。
6. 确认 `ctx.get('webServer')` / `ctx.get('workspaceRegistry')` / `ctx.get('tools')` 仍能取到。

任一不成立 → 按 M1–M5 判定升 major，或按 M6 修正 peer 范围。

---

## 7. 本文件未验证的部分（明确清单）

| 未验证项 | 原因 | 已完成的替代验证 |
|---|---|---|
| `engines.node` 下限 `22.19.0` 的具体技术理由 | 仓库内无注释、`DEVELOPERS.md` 未记录 | 确认本机 Node `v24.13.0` 满足范围 |
| DSH 是否在运行时强制 `engines` | 未做「用低版本 Node 启动 DSH」的破坏性实验 | 对 profile 内 724 个 `.js` 扫描 `EBADENGINE` / `Unsupported engine`，命中 0 处 |
| **发布态（非 link）安装**下插件的完整行为 | 本机 profile 用的是 `link:` 依赖，未做 npm 真实安装 | 验证了解析规则（裸 import 沿 Node 解析到最近的 `node_modules`）与两套版本的 API 差异 |
| `dsh-settings@0.1.0-rc.8` 的导出面 | 仓库内未安装该版本 | 比对 rc.6（link 态实际用）与 rc.2（profile 解析） |
| `dsh-tools` `defineTool` 在 rc.8 与 rc.2 之间的签名差异 | 仅验证了两版都存在该导出，未比对参数 schema | 实测两版均命中 `defineTool` probe |
| `0.1.0-rc.6` → `0.1.5-rc.2` 之间 `SettingsProvider` **方法签名**（非导出名）的变化 | 未逐个方法做行为比对 | 确认 `settingsNamespace` 等导出名被移除，且插件有探测降级 |
| 各风险项（R1–R14）的**实际发生概率** | 需要 DSH 的发布计划，本仓库不可得 | 仅给出「契约暴露面」排序（§5.1），非概率 |

---

## 附：一句话结论

本插件对 DSH 的实际依赖面**远小于其 peer 声明**：host 侧真正运行时 import 的官方包只有 4 个，client 侧为 **0 个**；14 个 peer 中至少 4 个（`dsh-agent-presets`、`dsh-llm`、`dsh-system-prompt`、`dsh-host-plugin-inventory`）在源码与构建产物中**完全未被引用**。因此「peer 声明范围」目前更多是**安装期契约**而非**运行时契约**；真正的兼容性风险集中在 §5 的 R1 / R3 / R7 三项，以及 §3.3 的 rc 期 semver 声明缺陷（R11 / R12）。
