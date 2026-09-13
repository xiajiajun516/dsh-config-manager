# Headless 消费本插件引擎 / Headless Consumption of the Engine

> 面向想复用 `dsh-config-manager` **引擎**（而不是它的 GUI）的消费者，例如 DSH CLI、
> CI 任务、迁移脚本、其他插件。
>
> 目标：**不安装任何 React UI 栈**即可加载引擎。

---

## 1. TL;DR

```bash
npm i dsh-config-manager
```

```js
// ESM
import { Exporter, Importer, Analyzer, planRestore, restore } from 'dsh-config-manager/core'

// 或 CJS
const { Exporter } = require('dsh-config-manager/core')
```

安装本插件现在只会拉入 **1 个运行时依赖**：`js-yaml`（+ 它的 `argparse`）。
React UI 栈（`lucide-react`、`@radix-ui/react-dialog` 及其传递依赖）**不会**被安装。

---

## 2. 为什么可以做到

本插件是**双面 Cordis 插件**，两半的构建与依赖形态完全不同：

| 半边 | 入口 | 产物 | 打包方式 | 运行时依赖 |
|---|---|---|---|---|
| **client（浏览器）** | `src/client/index.ts` | `lib/client.js`（单文件 cjs） | tsdown + `deps.alwaysBundle` | **零**（UI 库已内联） |
| **host（Node）** | `src/index.ts` | `lib/index.js` + 目录树 | `tsc` | `js-yaml` |
| **引擎（与 DSH 解耦）** | `src/core/index.ts` | `lib/core/*.js` | `tsc` | **零** |

关键点：client 半的 `lucide-react` 与 `@radix-ui/*` 被
`tsdown.config.ts` 的 `deps.alwaysBundle` **内联进 `lib/client.js`**：

```ts
// tsdown.config.ts
deps: {
  neverBundle: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  alwaysBundle: [/^lucide-react(\/.*)?$/, /^@radix-ui\//],
}
```

DSH 的 client loader 只取这一个 `client.js`，不解析额外模块，因此这些库**必须**内联，
否则会在用户端命中 `module-table-miss` 崩溃。既然已经内联，它们就不再是**运行时**
依赖，只对**构建期**有意义——所以它们属于 `devDependencies`。

---

## 3. 导出位（`exports`）

`package.json` 的 `exports` 提供四个入口：

| 说明符 | 产物 | 需要的依赖 | 适用场景 |
|---|---|---|---|
| `dsh-config-manager/core` | `lib/core/index.js` | **无**（零外部 import） | headless 引擎消费 ✅ |
| `dsh-config-manager/schema` | `lib/schema/types.js` | **无**（零 import） | 只要类型（**无运行时值**，见下） |
| `dsh-config-manager` | `lib/index.js` | `js-yaml` + DSH peer 包 | 作为 DSH host 插件加载 |
| `dsh-config-manager/client` | `lib/client.js` | `react` / `react-dom`（宿主提供） | DSH client loader |

> `dsh-config-manager/core` 的产物**只 import 相对路径**，不 import 任何外部包——这是
> 「零成本消费」的技术依据。
>
> ⚠️ `dsh-config-manager/schema` 指向 `lib/schema/types.js`，它是一个**纯类型模块**
> （编译后零运行时导出）。schema 版本常量 `CURRENT_SCHEMA_VERSION` 定义在
> `src/schema/versions.ts`，**不在 `exports` 映射内**，无法从包外导入。需要该常量时，
> 请从 `dsh-config-manager/core` 的导出面寻找等价能力，或直接把版本号作为配置传入。

CLI 入口（`bin: dsh-config-manager` → `lib/cli/index.js`）同样只用 Node 内置模块 +
相对路径，可在零依赖环境下运行。

---

## 4. 消费示例

> 下面的构造参数是**示意**（真实签名见 `lib/core/*.d.ts`）；重点是「从 `/core` 拿到的
> 是什么、需要调用方提供什么」。

### 4.1 只做导出（打包配置）

```js
import { Exporter, EXPORTER_INFO } from 'dsh-config-manager/core'

// ExporterOptions: { ctx, adapters, scanner?, encryption?, exporterVersion?, now? }
const exporter = new Exporter({ ctx, adapters })

// ExportOptions: 分区选择、是否含 secret、目标路径……
const { zipPath, manifest, report } = await exporter.export(exportOptions)
```

### 4.2 只做导入分析（Dry Run，零写入）

```js
import { Analyzer } from 'dsh-config-manager/core'

// AnalyzerOptions: { ctx, adapters, snapshotStore, limits, dependencyChecker, parseZipOverride? }
const analyzer = new Analyzer({ ctx, adapters, snapshotStore, limits, dependencyChecker })

const analysis = await analyzer.analyzeImport(zipPath)      // → ImportAnalysis
const plan = await analyzer.createImportPlan(zipPath, decisions)  // → ImportPlan
// 真正落盘才需要 executeImportPlan(plan, …)
```

### 4.3 兼容性判断 / 恢复计划

```js
import {
  computeCompatibility,
  describeCompatibility,
  describeSchemaStatus,
  planRestore,
  restore,
  rollback,
} from 'dsh-config-manager/core'
```

### 4.4 其他常用导出

`/core` 共 32 个运行时导出，例如：

- 引擎：`Exporter` / `Importer` / `Analyzer` / `MigrationStore`
- 快照：`FileSnapshotStore` / `createSnapshot` / `listSnapshots` / `verifySnapshot`
- 恢复：`planRestore` / `restore` / `rollback` / `resolveFileTarget`
- 历史：`queryHistory` / `summarizeHistory` / `sanitizeEntry` / `redactHistoryText`
- 安全：`defaultSecretScanner`
- 校验：`validateSections` / `computeCompatibility` / `describeCompatibility`

---

## 5. 边界与限制

- **不要**从 `dsh-config-manager`（根导出）加载引擎。根导出是 host 插件入口，它会
  import `js-yaml` 与 DSH peer 包（`@deepseek-ai/dsh-settings` 等），在 headless
  环境里必然失败。引擎消费请一律走 `/core`。
- `js-yaml` 保留为运行时依赖，因为它被 host 半真正使用（YAML 配置读写）。
  只消费 `/core` 与 `/schema` 的消费者实际上不会加载它。
- `react` / `react-dom` 是 **peerDependencies**，由 DSH client runtime 提供，
  消费者不需要（也不应该）自行安装来跑 headless 引擎。
  但**注意**：npm 7+ 默认会自动安装 peer（除非该 peer 已标记 optional，而本包当前
  **没有** `peerDependenciesMeta`），所以 headless 消费者实际会被装进约 4.7 MB 的
  React 栈，而 host 半（`lib/index.js`）**完全不引用 react**。这是已登记缺口，
  处置建议见 `docs/spec/known-gaps.md` §G-11（**未在本轮修改安装语义**）。
- 引擎与 DSH 解耦：`src/core/` 只依赖 `ConfigAdapter` / `HostContext` 抽象与内存 mock。
  需要真实文件系统/凭据时，由调用方提供对应实现。

---

## 6. 护栏（防止回归）

「`lib/client.js` 必须自包含」这条不变量由测试钉死：

```bash
npm run build
node --test src/client/bundle-selfcontained.test.ts
```

- `src/client/bundle-selfcontained.test.ts` — 断言产物只 `require` 白名单内的包。
- `src/utils/bundle-scan.ts` — 扫描内核（纯函数，零依赖，有独立单测）。
- 白名单：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`。

### 为什么扫描器要先剥注释、还要跑多趟

1. **必须剥注释**：bundle 里带 banner 与源码注释，注释中可能出现与真实
   `require("lucide-react")` 完全同名的字符串（本仓库真实存在：`src/market/upstream.ts`
   的注释里写着 `` `require("node:https")` ``）。直接对原文正则匹配会**假阳性**。
2. **必须跑多趟**：注释里的反引号/引号会破坏状态机的配平。本仓库 bundle 中实测有 24 处
   反引号处于注释文本内，某处会让模板态永久失衡——此时扫描器会把后续注释当代码保留
   （假阳性），**也可能把真实代码当注释内容吞掉（假阴性，对护栏致命）**。
   因此 `bundle-scan` 用 4 组解析配置各扫一遍并取**并集**：
   `tpl+str` / `opaque-tpl` / `opaque-str` / `opaque-both`。

### 谁在跑这条护栏

- `.github/workflows/ci.yml` — Build 之后单独跑一次。
- `.github/workflows/publish.yml` — 发版前的最后一道闸。

> 为什么不能只靠 `npm test`：`npm test` 在 Build **之前**运行，此时 `lib/client.js`
> 还不存在，该测试会跳过并打印诊断。CI 因此在 Build 之后补跑一次。

### 改动了 UI 库怎么办

如果你把新的 UI 库加进 `dependencies` 而没有加进 `deps.alwaysBundle`：

1. `npm run build` 后护栏会**失败**，并列出被外置的说明符；
2. 修复方向：把该库加进 `tsdown.config.ts` 的 `deps.alwaysBundle`，并把它放到
   `devDependencies`（因为它已被内联，不再是运行时依赖）。

---

## 7. 验证记录（本仓库实测）

以下命令在 Windows + Node 24 上实际执行过：

```bash
npm run typecheck                 # exit 0
npm run build                     # exit 0（lib/client.js 1.05 MB）
npm test                          # 全量套件（node:test，零依赖）
node --test src/client/bundle-selfcontained.test.ts   # 1 pass

# 打包 + 隔离消费者安装（模拟没有 devDependencies 的消费者）
npm pack --pack-destination <tmp>
cd <tmp>/consumer && npm i <tarball> --legacy-peer-deps
npm ls --all
# → dsh-config-manager@0.1.59
#     +-- js-yaml@5.4.2
#     | `-- argparse@2.0.1
#     `-- (16 个 UNMET peerDependencies —— 由 DSH 宿主提供)
#          14 个 @deepseek-ai/* + react + react-dom（2 个 React peer，见 docs/spec/known-gaps.md §G-11）

node -e "import('dsh-config-manager/core')"     # 32 exports，加载成功
node --check node_modules/dsh-config-manager/lib/client.js   # exit 0
```

安装体积对比：**29 个包 → 3 个包**（UI 栈 26 个包不再被拉入）。

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `package.json` | `exports` 四个入口；`dependencies` 只剩 `js-yaml` |
| `tsdown.config.ts` | `deps.alwaysBundle` 把 UI 库内联进 `lib/client.js` |
| `src/utils/bundle-scan.ts` | 产物扫描内核（剥注释 + 多趟并集） |
| `src/utils/bundle-scan.test.ts` | 扫描内核单测 |
| `src/client/bundle-selfcontained.test.ts` | 自包含护栏 |
| `.github/workflows/ci.yml` | PR/主干门禁（Build 后跑护栏） |
| `.github/workflows/publish.yml` | 发版门禁（发版前跑护栏） |
