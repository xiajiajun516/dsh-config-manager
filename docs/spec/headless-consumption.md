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
| `dsh-config-manager/schema` | `lib/schema/index.js` | **无**（零 import） | 类型 + 运行时值（版本判定 / 分区注册表；见下） |
| `dsh-config-manager` | `lib/index.js` | `js-yaml` + DSH peer 包 | 作为 DSH host 插件加载 |
| `dsh-config-manager/client` | `lib/client.js` | `react` / `react-dom`（宿主提供） | DSH client loader |

> `dsh-config-manager/core` 的产物**只 import 相对路径**，不 import 任何外部包——这是
> 「零成本消费」的技术依据。
>
> `dsh-config-manager/schema` 指向 `lib/schema/index.js`（**运行时入口**，源码 `src/schema/index.ts`；零 `node:` / 零 npm 依赖）。
> 除全部载荷类型外，它还导出 **24 个运行时值**（实测 `node -e "import('dsh-config-manager/schema')"` → 24 个键）：
> 版本判定（`CURRENT_SCHEMA_VERSION` / `MIN_SUPPORTED_SCHEMA_VERSION` / `UnsupportedSchemaError` / `isCurrent` /
> `isSupported` / `needsMigration` / `isTooNew` / `canImport` / `describeVersion`，9 个）、
> 分区表（`SECTION_IDS` / `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` / `isFileSection`，4 个）与
> 分区注册表（`SECTION_REGISTRY` / `SECTION_DATA_VERSION` / `sectionMeta` / `sectionMetaOf` / `requireSectionMeta` /
> `isSectionId` / `jsonPathOf` / `filePrefixOf` / `PORTABLE_SECTION_IDS` / `OPT_IN_SYNC_SECTION_IDS` /
> `DEFAULT_INCLUDED_SECTION_IDS`，11 个）。
>
> **`SECTION_REGISTRY` 是分区清单的机器可读唯一来源**（「有哪些分区、ZIP 内形态、可移植性、同步可选分区、
> 默认勾选」）——第三方实现自己的 importer/exporter 时据此枚举，不必读 `src/`；
> `docs/spec/bundle-format-v1.md` §2.5 的清单即由它派生。
>
> **历史（已修复）**：该入口曾指向 `lib/schema/types.js`（纯类型模块，编译产物零运行时导出），第三方 `import`
> 只会拿到 `{}`，`CURRENT_SCHEMA_VERSION` 等**在包外无法导入**。缺口登记见 `known-gaps.md` 的 **L2**；
> 回归护栏：`tests/packaging-contract.test.ts`（断言 `exports["./schema"]` 指向 `lib/schema/index.js` / `.d.ts`）。

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

// 加密备份（includeSecrets）：**必须**把用备份密码解出的凭据一并传给计划生成，
// 否则「归档里带值、但未被任何 settings namespace 引用」的凭据不会进计划，
// 执行期也就不写回（值静默丢失）。同一份 Map 之后还要交给 executeImportPlan。
const planEnc = await analyzer.createImportPlan(zipPath, decisions, { decryptedCredentials })
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

### 4.5 会话按数量筛选 + 凭据可恢复性（issue #39 Feature 1–3）

```js
// ① 会话只带最近的（键缺省 = 现有行为：sessions 的 defaultIncluded=false，不选不带）
await exporter.export({ includeSecrets: false, sessions: { limit: 5 } })
//   limit === 0 → 整个 sessions 分区不带；limit < 0 → 全带；缺省 / 非整数 → 显式选中但不限数量
//   单位 = 会话目录 <projectKey>/<sessionId>：同一会话的新旧日志必须一起走；
//   排序 = 会话日志文件的最新 mtime。宿主 FileSystemFacade 需实现可选的 mtimeMs()；
//   未实现（或时间全读不到）→ 退回全量导出 + 一条告警，绝不把「时间未知」当成最旧（那会静默丢最近的会话）。

// ② 分析时顺带拿到「包里的凭据能不能自动回填」——不必自己解 security/secrets.enc 再解析 .credentials.yaml
const analysis = await analyzer.analyzeImport(zipPath, { decryptedCredentials })
//   analysis.credentials = { inArchive, refs, satisfied }
//   inArchive  = manifest.security.containsSecrets（归档声明携带真实凭据值）
//   refs       = 本次实际解出的凭据 ref 名；**只回传名字，永不回传值**（不传 decryptedCredentials 时为 []）
//   satisfied  = refs 中本机已配置的子集（无需回填、也无需人工补录）

// ③ 导入结果带 credentialsRestored：从加密归档内解出并回填本机的条数（字段只增不改）
const result = await analyzer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials })
```

宿主 HTTP API 的对应关系（同一套语义，只增不改）：`/export` 请求体加可选 `sessions: { limit }`；
`/analyze` 请求体加可选 `decryptPassword`（提供即解开 `security/secrets.enc` 并回传 `credentials`）；
`/execute` 结果加 `credentialsRestored`。

### 4.6 会话跨机恢复：导出连带工作区 + 导入期一条映射改两处（issue #45）

> **旧接口已移除**：`/core` 不再导出 `groupSessions`，宿主不再提供 `POST /sessions/group`，
> 界面上也不再有一个独立的「会话归位」面板 —— 会话的归属关系改由**导出/导入这对动作本身**保证。

**导出侧（自动连带工作区）**：只要本次导出包含 sessions 分区（`sessions` 键 / `only` 含 `sessions` /
条目级 `includeItems.sessions`），导出器就会把**拥有这些会话的工作区记录**（`WorkspaceRecord`，含
`sessionIds`）一并纳入 `workspaces` 分区，并在报告里给一行 `export.sessionsWorkspacesCoupled`（`{ count }`）。
理由是硬依赖：DSH 只按「有没有一条工作区记录指向该会话的 cwd 且 id 在 `sessionIds` 里」决定会话显不显示，
不带工作区的会话在目标机必然看不到。条目级选择时按 `sessionIds` 精确匹配；只给 `sessions.limit`
（选中的是「最新 N 个」，此刻还不知道是哪几个）时，凡声明了 `sessionIds` 的工作区都算。

**导入侧（一条映射同时改两处）**：用户在导入向导里填的路径映射（`ImportPlan.pathMappings`）同时作用于
① `workspace.path`（`analyzer.applyMappingsToSections`）与 ② **会话日志首帧 cwd**
（`SessionsAdapter.finalizeApply` → 宿主 `SessionStoreFacade.rewriteLogDir`）。顺序与一致性：

1. 会话分区整个写完之后，逐会话从**字节**读出首帧 cwd（`readLogCwd`；此刻存储的解析接口可能正处在
   「位置与 header 不一致」的坏状态，只有自己解字节这条路可用）；
2. 命中映射 → `rewriteLogDir` 只替换**第 1 帧**（其余帧逐字节流式保留；重压缩用与 DSH 同款的带内容
   校验和帧；写临时文件 + 发布前自检 + 原子替换；同一会话**全部 generation** 一起改，中途失败回滚已改写项）；
3. 目录归位到 `projectKeyOf(映射后 cwd)`（`relocateDir`：目标已存在不覆盖、目录内有 `session.lock` 不搬、
   搬后自检失败回滚）；
4. 搬不动 → **回滚首帧改写**（绝不留「header 与位置不一致」的半套状态：DSH 下次启动会直接报
   `corrupt session log`）；回滚也失败 → 按硬失败上报（`rollbackOnError` 时宁可整体回滚）；
5. 未命中映射 → 只做原有位置护栏（目录段 ≠ `projectKeyOf(首帧 cwd)` 就归位，只搬目录、不改内容）。

**收尾阶段（全部分区写完之后）**：`ConfigAdapter.finalizeImport` 把工作区记录里声明的会话逐个
`attachSession`（DSH 自己读 header、按 cwd 的 realpath 校验），成功/待登记如实计入报告（未登记成功记
warning，绝不让「会话没进工作区」静默通过）。为什么必须放在这里：`APPLY_ORDER` 把 `workspaces` 排在
`sessions` 之前，在 `applyItem` 里登记时会话文件还没写完、首帧还没改写，必然失败 —— 这正是旧症结
「数据恢复了却显示不出来」。

**边界**：会话**没有任何工作区**（或对应工作区不在备份里）时，导入侧不会凭空建工作区，目标机上仍然
看不到它；这类情况用离线 CLI 兜底（`dsh-config-manager sessions repair`，见 README 的 CLI 章节），
或在 DSH 里手动把该目录添加为工作区。读写会话日志字节的能力只存在于宿主侧（`src/utils/session-log.ts`
是宿主适配器与 CLI 的唯一实现，`/core` 不碰 DSH 存储格式）。

---

## 5. 边界与限制

- **不要**从 `dsh-config-manager`（根导出）加载引擎。根导出是 host 插件入口，它会
  import `js-yaml` 与 DSH peer 包（`@deepseek-ai/dsh-settings` 等），在 headless
  环境里必然失败。引擎消费请一律走 `/core`。
- `js-yaml` 保留为运行时依赖，因为它被 host 半真正使用（YAML 配置读写）。
  只消费 `/core` 与 `/schema` 的消费者实际上不会加载它。
- `react` / `react-dom` 是 **peerDependencies**，由 DSH client runtime 提供，
  消费者不需要（也不应该）自行安装来跑 headless 引擎。
  但**注意**：npm 7+ 默认会自动安装 peer——本包用 **`peerDependenciesMeta` 把全部 16 个 peer 标成
  `optional: true`**，所以 npm 不再自动装 peer，headless 消费者实际只装 `js-yaml`（隔离安装实测见 §7：
  16 个 UNMET peer，无 React 栈）。该不变量由 `tests/packaging-contract.test.ts` 钉死（peer 全 optional
  ＋ `dependencies` 仅 `js-yaml`）；历史缺口 `P-1` / `P-2` 见 `docs/spec/known-gaps.md`（已修复）。
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
#          14 个 @deepseek-ai/* + react + react-dom（2 个 React peer，见 docs/spec/known-gaps.md §P-1）

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
