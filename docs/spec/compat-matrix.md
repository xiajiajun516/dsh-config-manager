# DSH 兼容矩阵（compat-matrix）

> 本文件回答一个问题：**本插件支持哪个 DSH 版本区间，以及 DSH 升级时哪一部分会先破。**
> 所有断言均标注取证位置（`file:line`）或标记为「未验证」。凡未实际读取文件确认的结论一律不写入本文件。

- 适用插件版本：`dsh-config-manager@0.1.67`（`package.json:3`，与 `src/index.ts` 的 `export const PLUGIN_VERSION` 一致）
- 取证环境：Windows，Node `v24.13.0`，npm `11.19.0`
- 本机 DSH 部署：`@deepseek-ai/dsh@0.1.5-rc.1`（`D:\Apps\nodejs\node_global\node_modules\@deepseek-ai\dsh\package.json`）
- 兼容闸取证（2026-09-28，issue #53）：另从 npm 取 `@deepseek-ai/dsh-app-boot@0.2.0-rc.1`、`@deepseek-ai/dsh@0.1.7-rc.2` 与 `@deepseek-ai/dsh@0.2.0-rc.1` 的 tarball 逐字读源码，并用 app-boot 导出的 `evaluatePluginCompatibility` 对**本插件的 manifest** 真跑判定（结果见 §3.3）

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
| `$DSH_HOME/cordis.patch.yml` + `$DSH_HOME/profiles/<name>/cordis.patch.yml` 文件格式 | MCP / prompts 分区与插件激活行的读写对象（经 `js-yaml`，非官方服务）；**两层同读、按来源层写回**（issue #71） | `src/core/patch-layers.ts` 是层身份的唯一来源：`USER_PATCH_FILE`（`'cordis.patch.yml'`）、`PROFILE_PATCH_FILENAME`、`profilePatchRel(profile)`（`profiles/<name>/cordis.patch.yml`）、`patchLayerRels`（home 层优先，与 DSH 合并序一致）、`readEffectivePatchLines` / `resolveWriteLayer` / `locatePatchLineLayer`；patch 读写实现 = `src/index.ts` 的 `DshPatchFileFacade`（`patchFile.readPatchLines` / `applyPatchChanges`，`file` 参数按**相对 homeDir 的 POSIX 路径**解析）；`src/adapters/plugins.ts` 重导出 `USER_PATCH_FILE`，`src/adapters/index.ts` 继续 re-export（旧路径不变） |

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

`@deepseek-ai/dsh-agent-presets`、`dsh-client-connection`、`dsh-client-locale`、`dsh-client-runtime`、`dsh-client-ui-settings`、`dsh-client-ui-slots`、`dsh-credentials`、`dsh-home-paths`、`dsh-host-plugin-inventory`、`dsh-host-webserver`、`dsh-llm`、`dsh-settings`、`dsh-system-prompt`、`dsh-tools` —— **全部声明为 `>=0.1.0-rc.6 <0.3.0-0`**（0.1.66 起，显式上下界；改前为带预发布版的 caret `^0.1.0-rc.6`，见 §3.3）；`react` / `react-dom` 为 `^18.2.0`。

### 3.2 本机三套并存的实际版本

| 版本宇宙 | 位置 | 版本 | 插件是否真的用它 |
|---|---|---|---|
| **DSH 应用本体** | `D:\Apps\nodejs\node_global\node_modules\@deepseek-ai\dsh` | **`0.1.5-rc.1`** | — （仅决定 loader / 客户端 shell 行为） |
| **DSH profile 解析** | `$DSH_HOME/profiles/node_modules/@deepseek-ai/*`（244 个包） | **`0.1.5-rc.2`** | 否（见下） |
| **插件自身解析** | `D:\Projects\personal\dsh-config-manager\node_modules/@deepseek-ai/*` | **`0.1.0-rc.6` / `0.1.0-rc.8`** | **是** |
| 仓库 devDependencies 声明 | `package.json`（2026-10-04 复核，PR #64 / #65 合并后） | 多数 `^0.1.0-rc.6`；`dsh-timeout` 为 `^0.1.0-rc.8`；**`dsh-client-ui-slots` / `dsh-client-locale` 为 `^0.2.0-rc.2`**（`package-lock.json` 实测解析到 `0.2.0-rc.2`；其余官方包在 npm 上没有 0.2.0-rc.2，`dsh-client-runtime` 最新仍为 `0.1.0-rc.8`） | 决定上者装到什么 |

> **2026-10-04 追加（PR #64 / #65）**：`dsh-client-ui-slots` 与 `dsh-client-locale` 的 devDependencies 下限已提到
> `^0.2.0-rc.2`。两者在本插件里**只有 type-only import**（`src/client/index.ts:18,22`、`src/client/client-types.ts:13`），
> 因此升级只影响类型面：**不进产物、不改运行时解析**（peer 区间仍是 `>=0.1.0-rc.6 <0.3.0-0`，用户端不受影响）。
> 官方 monorepo 并非每个包都发 0.2.0-rc.2（`dsh-client-runtime` 就没有），所以「让全部官方包同版本」在当前上游
> 发布节奏下做不到。本机 `node_modules` 尚未重装，仍为 `0.1.0-rc.6` / `0.1.0-rc.8`；下一次 `npm install` 后这两个
> 包会变成 `0.2.0-rc.2`（`package-lock.json` 已按此锁定）。

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

**旧声明（≤ 0.1.65，已被 issue #53 修掉）**：14 条 peer 全是**带预发布版的 caret** `^0.1.0-rc.6`。用 DSH 自带 `semver` 实测：

| 候选版本 | `^0.1.0-rc.6` 默认 | `^0.1.0-rc.6` + `{includePrerelease:true}` |
|---|---|---|
| `0.1.0-rc.6` | ✅ true | ✅ true |
| `0.1.5-rc.2`（profile 实际） | ❌ **false** | ✅ true |
| `0.1.5-rc.1`（DSH 本体） | ❌ **false** | ✅ true |
| `0.1.6`（假设正式版） | ✅ true | ✅ true |
| `0.1.99` | ✅ true | ✅ true |
| `0.2.0-rc.1`（npm `next`，2026-09-28） | ❌ false | ❌ **false** |
| `0.2.0` | ❌ false | ❌ false |
| `0.1.0-rc.5`（更旧的 rc） | ❌ false | ❌ false |

根因：`semver.validRange('^0.1.0-rc.6')` = **`>=0.1.0-rc.6 <0.2.0-0`** —— 带预发布版的 caret，上界会被补成「下一个 minor 的 `-0`」，于是 `0.2.0` 的**任何**预发布版都落在区间之外。

**现行声明（0.1.66 起）**：`>=0.1.0-rc.6 <0.3.0-0` —— 显式上下界，`-0` 把整条 `0.2.x`（含其预发布版）锚进区间。同一份 semver、同一组候选版本实测：

| 候选版本 | `>=0.1.0-rc.6 <0.3.0-0` + `{includePrerelease:true}` |
|---|---|
| `0.1.0-rc.5` | ❌ false |
| `0.1.0-rc.6` / `0.1.5-rc.1` / `0.1.5-rc.2` / `0.1.7-rc.2` | ✅ true |
| `0.2.0-rc.1` / `0.2.0` / `0.2.9` | ✅ true |
| `0.3.0-0` / `0.3.0-rc.1` / `1.0.0` | ❌ false |

**结论与风险**：

1. 兼容闸的判定式（读 `@deepseek-ai/dsh-app-boot@0.2.0-rc.1` 源码的 `evaluatePluginCompatibility`，`lib/index.js:286-313`）是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，只检查名字为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer；**任一不满足 → 整份 bundle 在启动时被跳过**（stderr 只多一行 `skipping profile bundle`，进程照常起来、功能静默消失）。0.1.5-rc.1 还没有这道闸。
2. **真跑判定**（runtime = `0.2.0-rc.1`，manifest = 本插件）：改前 `^0.1.0-rc.6` → **INCOMPATIBLE（14 条 peer 全中）**；改后 → **COMPATIBLE**。`0.1.5-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` 三种 runtime 全部 COMPATIBLE。回归护栏：`tests/packaging-contract.test.ts` 的 **P-3**（钉住 14 条 peer 一律是显式上下界，caret/tilde 一律红灯）。
3. 旧声明的另外两处脆弱点也在现行区间下消失：**默认语义**下 `^0.1.0-rc.6` 不匹配任何 `0.1.x-rc.y`（`x>0` 或 `y>6`，因为 `<upper>` 被钉在 `0.1.0` 那一格），所以一旦打开 `autoInstallPeers` 或走 pnpm `strict-peer-dependencies` / npm 的 peer 校验就立刻报冲突 —— 现在 profile 实际装的 `0.1.5-rc.2` 在默认语义下也满足 `>=0.1.0-rc.6 <0.3.0-0`。
4. rc 期 semver 不可靠的根因：prerelease 段的存在使「兼容区间」的实际边界依赖工具的 `includePrerelease` 选择，而 npm / pnpm / 各 loader 的选择并不统一。**因此本插件的兼容性事实上靠「运行时实测 + 优雅降级」维持，而不是靠 semver 保证** —— peer 只是**安装期闸门**，不构成运行时承诺（真正运行时 import 的官方包只有 §1.3 的 4 个）。

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

### 3.5 DSH Desktop（Electron 外壳）的两个硬事实（2026-09-30 取证）

| 事实 | 取证位置 | 对本插件的影响 |
|---|---|---|
| **`desktop` 是 Electron 独占保留档案**：普通 CLI 对 `--profile desktop` **无条件**报 `error: profile "desktop" is managed exclusively by the Electron application` | `@deepseek-ai/dsh@0.1.5-rc.1` 与 `0.2.0-rc.2` 的 `lib/bin.js` 中 `rejectElectronProfile`（`plugin` 子命令分支只在 `manageDesktopProfile` 为真时跳过它）；0.2.0 的 `lib/plugin-BGnVfe_D.js` 对 desktop 额外要求 `package.json` 已存在 | 插件通道（安装/更新/卸载/恢复）在桌面端一度**全部失败**；0.1.67 起改走下面的 CLI 载体 |
| **桌面端自带 CLI 载体 = `@deepseek-ai/dsh-desktop-host/lib/cli.js`**：它以 `runCli({ manageDesktopProfile: true, packageManager })` 启动，用桌面端内置 runtime 与内置 pnpm；宿主进程由 Electron 主进程以 Node 模式拉起，`process.argv[1]` 即同包的 `lib/index.js` | `app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`（`runDesktopCli`）与 `lib/index.js`（`main()` 读 `process.argv[2..6]`）；Electron 主进程 `lib/main.js` 的 `HostProcess.start()`（`spawn(node, ['--expose-internals', <runtimeDir>/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js, runtimeDir, projectDir, primaryRuntime, pnpm, nodeBin])`，env 带 `ELECTRON_RUN_AS_NODE=1`） | 插件据此识别载体（`src/utils/desktop-carrier.ts`）并在目标是 desktop 档案时改用它 |
| **运行时在 `app.asar` 内**：桌面端的 `@deepseek-ai/dsh` 是 `0.2.0-rc.2`，磁盘上 `<home>/profiles/node_modules/@deepseek-ai/dsh` 却是 web 档案 hoisted 出来的 `0.1.5-rc.1` | `app.asar` 内 `dsh/node_modules/@deepseek-ai/dsh/package.json`（`version: 0.2.0-rc.2`）vs 本机 `<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh/package.json`（`0.1.5-rc.1`） | 「关于」页与导出 manifest 的 DSH 版本一度报错版本号；0.1.67 起优先读 `profileContext.installAnchor`（= `app.asar` 内那份 `package.json`） |
| **会话日志格式版本单向不兼容，且 DSH 静默跳过**：读会话时对非本 build 的 `header.version` 直接拒绝，而会话列表 `listArtifacts()` 对这种错误 `continue`（不报错、不显示 → 用户看到「对话消失」）。高版本可读低版本（V0→V4 迁移链），**反向不可读** | `@deepseek-ai/dsh-session` 的 `SESSION_FORMAT_VERSION`：桌面端内置 0.2.0-rc.2 = **4**，磁盘 CLI 档案 0.1.5-rc.1 = **3**；`dsh-session-persistence-jsonl` 的 `refuseForeignFormatVersion` 与 `listArtifacts` 的 catch-continue | 插件在导入/同步分析阶段做格式体检并告警（`import.sessionsFormatUnsupported`），档案页展示每个档案的 DSH 版本与会话格式版本；**跨版本迁移前请先把目标机 DSH 升到与导出机相同或更新的版本**（反向只能靠升级，插件不代做格式迁移） |
| **`profileContext` 是宿主 boot 时 provide 的服务**（含 `name` / `dir` / `patchPath` / **`installAnchor`** / `startedBundles` / `packageManager`…），desktop 才带 `packageManager` | 0.2.0-rc.2 的 `dsh/lib/profile-boot-BZ2ZjNWi.js` 的 `profileContext` 构造 + `hostCtx.provide("profileContext", …)` | 档案识别（issue #52）、DSH 版本（0.1.67）都从这里取；`packageManager` 可作为「是否桌面端」的旁证 |

> 真机复核（2026-09-30，隔离 `DSH_HOME`）：桌面端载体 `plugin --profile desktop add <pkg>` 落盘成功（`package.json` 依赖 + `node_modules` + pnpm 日志），
> 同一命令用普通 `dsh` 仍按设计拒绝；载体 `--profile <name> --port <n> --no-open` 也能正常拉起实例并在 stdout 打出 `dsh web: http://127.0.0.1:<port>/?token=…`。

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
| **R11** | 插件加载器改为**强制 peer / engines 校验**（0.1.7 起已落地为兼容闸） | 安装/启动期 | 插件装不上，或启动即被**静默跳过**（stderr 一行 `skipping profile bundle`） | 闸门判定式见 §3.3；peer 范围必须在 `{includePrerelease:true}` 下满足实际 runtime（`tests/packaging-contract.test.ts` 的 P-3 已钉住 14 条 peer 的形状） |
| **R12** | DSH 进入 `0.3.x` | 全部 peer 范围 | 同 R11（现行上界 `<0.3.0-0` 恰好挡住 `0.3.0-0` 及以上的预发布版；`0.2.x` 已放行） | §3.3 现行区间表末行；越过 0.3 前必须按 M8 重采证据集 |
| **R13** | `$DSH_HOME/cordis.patch.yml` 或 profile patch 文件格式变化（含**合并顺序**变化） | MCP 分区、prompts 分区、插件激活行 | MCP/prompts 导入后不生效；`patch 行` 解析报错；**同一条 lineId 在两层各一份时以哪层为准**（本插件按 home 层优先，与 DSH 的合并序一致） | `src/core/patch-layers.ts` 的 `readEffectivePatchLines`（两层读取 + 按层优先去重）与 `patchLayerRels`；`src/index.ts` 的 `DshPatchFileFacade`（`patchFile.readPatchLines`）；`src/adapters/mcp.ts`；`src/adapters/prompts.ts` |
| **R15** | DSH 的 MCP 配置形态变化：`dsh-mcp-client` patch 行的字段（`config.serverName` / `command` / `args` / `cwd` / `url`）或合并顺序变化 | `mcp` 分区的导出/导入与**同步通道**（可选分区） | MCP 服务器导入后不出现、或参数错位；同步时 `mcp` 分区内容为空 | `src/adapters/mcp.ts`（`extractMcpServers` 按 `config.serverName` 判定 + 两形态兼容）、`src/core/patch-layers.ts`（按层读回）、`src/schema/section-registry.ts` 的 `mcp.syncOptIn='auto'`（issue #78；放行集合由 `SyncEngineOptions.optInSections` 决定） |
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

现行区间 `>=0.1.0-rc.6 <0.3.0-0` **同时声明支持 `0.1.x` 与 `0.2.x`（含两者的预发布版）**（0.1.66 起，issue #53）。
**任何对上界的改动都是改兼容声明**（扩大支持范围或收窄都算）：必须按 M8 重采证据集、同步改 `peerDependencies` 全部 14 个范围，并更新 `tests/packaging-contract.test.ts` 的 P-3 期望值。
依据：旧的 `^0.1.0-rc.6` 对 `0.2.0-rc.1` 与 `0.2.0` 实测均为 **false**（上界 `0.2.0-0`）；现行区间实测见 §3.3。

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
| **在本机真机运行 DSH 0.1.7-rc.2 / 0.2.0-rc.1**（issue #53） | 本机全局装的是 `0.1.5-rc.1`，未做运行版本切换 | 逐字读两个版本的 `dsh-app-boot` / `dsh` 源码确认闸门判定式；用 `evaluatePluginCompatibility` 真跑本插件 manifest（三种 runtime 全 COMPATIBLE）；区间语义用 DSH 自带 semver 实测 |
| **在真实 DSH Desktop 上复现 issue #52** | 无桌面版环境 | 读 `@deepseek-ai/dsh@0.1.7-rc.2` 与 `0.2.0-rc.1` 的 `profile-boot` 源码，确认 boot 时确实 `hostCtx.provide('profileContext', { name, dir, patchPath, … })`（`0.1.5-rc.1` 尚无）；解析链为纯函数并有单测（`src/core/plugin-cli.test.ts`）；**end-to-end 未验证** |

---

## 附：一句话结论

本插件对 DSH 的实际依赖面**远小于其 peer 声明**：host 侧真正运行时 import 的官方包只有 4 个，client 侧为 **0 个**；14 个 peer 中至少 4 个（`dsh-agent-presets`、`dsh-llm`、`dsh-system-prompt`、`dsh-host-plugin-inventory`）在源码与构建产物中**完全未被引用**。因此「peer 声明范围」目前更多是**安装期契约**而非**运行时契约**；真正的兼容性风险集中在 §5 的 R1 / R3 / R7 三项，以及 §3.3 的 rc 期 semver 声明缺陷（R11 / R12）。
