# 架构地图（dsh-config-manager）

本文件回答：**这个仓库由哪些层组成、依赖朝哪个方向、一条典型请求/任务如何穿过它们、哪些结构性事实会绊住改动**。
不回答：某个模块的业务细节（→ `docs/modules/`）、UI 视觉决策（→ `DESIGN.md`）、对外数据契约（→ `docs/spec/`）、
单条规则的证据（→ `docs/lessons/`）、历史取舍（→ `docs/decisions/`）。

> 证据口径：本文所有路径与数字都在当前工作区用代码/测试核对过；行号会随改动漂移，**改代码后请改对应行号或删掉行号**。

---

## 1. 运行形态：一个包，两个面

| 面 | 入口 | 运行环境 | 职责 |
|---|---|---|---|
| host（插件宿主侧） | `src/index.ts` | Node / Cordis | 注册插件、装配依赖、声明 82 条 HTTP 路由、跑引擎 |
| web（浏览器侧） | `src/client/index.ts` | 浏览器沙箱 | 注册 locale 字典与 `settings.section` 面板，经 HTTP 调 host |

- host 侧 Cordis 插件名 `config-manager`（`src/index.ts:184`），`inject` 声明为 `['settings','credentials']`；可选服务一律 `ctx.get()` 惰取。
- `src/index.ts:190` 导出 `PLUGIN_VERSION`；它与 `package.json`、`package-lock.json` 三处由测试钉住（`tests/packaging-contract.test.ts`）。
- 打包产物：`main=./lib/index.js`、`bin dcm/dsh-config-manager=./lib/cli/index.js`，外加 client bundle；`lib/` `dist/` 均不入库。

## 2. 分层与依赖方向（有守卫）

```
client/ ──(只有 import type)──► core/types, schema/types
ui/     ──► core/, utils/, security/, schema/            （纯逻辑，可测）
routes/ ──► core/, adapters/, security/, sync/, ...      （薄壳：解析请求 → 调引擎 → 写 JSON）
adapters/► core/, security/, utils/                      （一个分区一个 adapter）
core/   ──► node, 自身, schema/, utils/, security/, migrations/, js-yaml   （引擎，不认识 React/node:http）
security/► node crypto, utils/                           （ZIP/加密/扫描，无业务知识）
schema/ ──► 无运行时依赖（纯类型 + 常量）
```

以上不是约定俗成，而是**可执行断言**：`tests/architecture-boundaries.test.ts` 扫描源码 import 图，
禁止 `core` 依赖 React/client、`migrations` 依赖 `core`、`ui` 依赖 react、`client` 依赖 `node:`、`@deepseek-ai/*` 出现在 `src/index.ts` 与 `src/client/` 之外的模块。
改分层前先跑它；想放宽分层必须先改这条测试**并且**在 `docs/decisions/` 留一条 ADR。

## 3. 路由层：82 条、一个入口、三道统一护栏

- 路由源分两处：`src/index.ts` 保留 **7** 条（被窗口/生命周期守卫钉住），`src/routes/*.ts` 拆出 **75** 条；合计 **82**。
  计数由 `tests/route/route-fence.test.ts` 与 `tests/route/route-parity.test.ts` 双向钉住（后者逐条比对快照，少一条/改方法都会红）。
- 装配：`src/routes/index.ts` 的 `buildRoutes(env)` 聚合 13 个路由组文件；依赖经 `makeRouteEnv()` 显式传入（类型从实现推断，见 `src/routes/context.ts`）。
- **唯一声明入口 `src/routes/kit.ts`**：`endpoint({path,methods}, handler)` 在注册点统一包装 ① loopback 围栏（非本机/跨站 → 403）
  ② 方法白名单（→ 405）③ 顶层 try/catch（→ 统一 JSON 错误，`writeRouteError`）。`registerRoutes()` 对未经 kit 的裸路由直接抛错。
- **认证边界就是这道围栏**，不是 DSH 的 cookie：DSH 的 cookie 拒绝只挂在 `kind:'prefix', path:'/api'` 的 RPC 承载路由上，而 exact 表先命中
  ⇒ 本机任意非浏览器进程无 token 即可调用全部 82 条。经代理/隧道暴露时必须在这里补认证。
- 请求体上限 4 MiB（`readJsonBody`），上传类走独立流式写盘。

## 4. 领域模块与职责边界

| 目录 | 职责 | 边界（不该做什么） | 代表文件 |
|---|---|---|---|
| `src/core/` | 备份/快照/导入/恢复/回滚点/分析器等引擎 | 不碰 HTTP、不碰 React | `core/exporter.ts`、`core/restore.ts`、`core/rollback-point.ts` |
| `src/adapters/` | 一个配置分区一个 adapter；`createAdapters()` 组装 | 不决定「导出什么策略」，只做分区读写 | `adapters/index.ts`、`adapters/file-collection.ts` |
| `src/security/` | 加密、ZIP 安全、脱敏、完整性、容器形态 | 不理解业务语义 | `security/encryption.ts`、`security/zip-security.ts`、`security/container-kind.ts` |
| `src/sync/` | 同步引擎、四传输、自动同步、三方合并 | 不直接改浏览器状态 | `sync/sync-engine.ts`、`sync/autosync-scheduler.ts` |
| `src/foreign/` | 外部 Agent（Claude Code 等）数据读写与迁移 | 不写本仓 `$DSH_HOME` 之外的自由路径 | `foreign/session-source.ts` |
| `src/profiles/` | 隔离实例：复制、重链接、启动 | 不猜「看着像残留就删」 | `profiles/dsh-profile-manager.ts` |
| `src/migrations/` | 数据版本迁移（被 core 调用，反向禁用） | 不 import core | `migrations/` |
| `src/market/` | 市场条目与安装/自更新路径 | 不自动安装 | `market/` |
| `src/schema/` | 分区 ID、manifest 类型与版本 | 无运行时依赖 | `schema/section-registry.ts`、`schema/types.ts` |
| `src/client/` | React 壳、页面、状态中枢、api 客户端 | 不 import `node:`，不裸 fetch | `client/run-store.ts`、`client/common/ui.tsx` |
| `src/ui/` | 与 React 无关的纯逻辑（i18n、视图模型、比较） | 不 import react | `ui/i18n.ts` |
| `src/cli/` | `dcm` 命令（检查/修复/救急台） | 写入必须过与救急台相同的写入门 | `cli/index.ts`、`cli/actions.ts` |

adapter 全量（`createAdapters()`）：settings、ui、providers、plugins、mcp、prompts、skills、agentPresets、agentInstructions、
workspaces、credentialsStatus、pluginFiles、pluginData、pluginAssets、self，外加按需挂载的 sessions。
分区清单以 `src/schema/section-registry.ts` 的 `SECTION_IDS`（17 项）为单一事实源。

## 5. 四条关键数据流

### 5.1 备份导出
`POST /export` → `Exporter.export()` → `FileCollectionAdapter.collect()`（与预览共用同一收集口径）→ 写 ZIP →
有密码时 `encryptArchive()` + 原子写；无密码直接 rename；明文临时 ZIP 在 `finally` 必删。
定时备份复用同一个 Exporter，恒 `includeSecrets:false`、不加密。

### 5.2 导入应用（唯一会改用户数据的链路）
`/upload`（≤256 MiB）→（加密容器）`/decrypt-archive` → `/analyze` → `/plan` → `/execute`：
`/execute` 过 mutation gate → 先 `createSnapshot()`（**导入前强制快照**）→ `executeImportPlan()` 逐动作执行 → 失败走 `core/rollback.ts` 补偿。
`/analyze`、`/plan`、`/execute` 三处都对未解锁容器返回 400 `encrypted-container`（同一常量、同一文案键）。

### 5.3 恢复
`POST /restore`（`dryRun=true` 只 `planRestore()` 零写入）→ 真实执行过 `runWithMutationLock` → 登记 run → `planRestore()` →
用客户端回传的 `planFingerprint` 比对，**不一致即 409 `plan-changed`**（确认之后磁盘又变了，可能多出删除动作）→ `executeRestorePlan()` 逐动作原子写。
恢复前留 pre-restore 副本；快照本身受 `snapshotsRoot` 校验（存在/READY/manifest/blob hash/symlink/provenance）。

### 5.4 同步
`SyncEngine` 状态机 + `Git/WebDav/S3/Gist` 四传输 + `AutoSyncScheduler`（事件驱动）：
push 前先比「基线 vs 远端最新」，不一致即零写入返回 conflict；merge 以 `state.ancestorId` 指向的本地祖先副本 + 分区 hash 为双基线，
**无祖先不猜**；四传输的条件写能力不同（git 靠非快进拒绝、webdav 412、s3 if-match、gist 明确不做 → 见 `docs/modules/sync.md`）。

### 5.5 对话回退
回滚点引擎在 `turn/start` 拍「工作区 + 会话」两态，台账一条一写、载荷内容寻址；回退不是就地截断（运行中的 DSH 不重读磁盘，平台无 reload API），
而是 **fork + 归档原会话**，并归位 cwd。

## 6. 结构性事实（改动的成本来源）

1. **入口 ↔ 路由组有运行时环**：9 个组文件为了共享工具函数反向 `import ... from '../index.ts'`
   （`src/routes/consult.ts:13`、`import.ts:13`、`market.ts:11`、`me.ts:11`、`prefs.ts:15`、`profiles.ts:13`、`recovery.ts:32`、`snapshots.ts:15`、`sync.ts:44`），
   而 `src/index.ts` 又 import `buildRoutes()`。后果：单测里 import 任一这类组文件都会把整个宿主入口拖进来。
   收敛方向（未执行）：把这些共享 helper 下沉到路由层新建的 helpers 目录或 `src/utils/`，让组文件只依赖下层。
2. **巨型文件**：`src/core/rollback-point.ts` 5963 行、`src/index.ts` 5003 行、`src/client/recovery/RecoveryPanel.tsx` 1946 行、`src/core/analyzer.ts` 1824 行、
   `src/sync/sync-engine.ts` 2227 行、`src/client/run-store.ts` 2166 行。体量本身不是缺陷，但它让「改一处要读多少」和 merge 冲突成本线性上升；
   拆分前必须先有对应回归测试（见 `docs/maintenance/tech-debt.md`）。
3. **耦合中枢**（入度最高的模块，改动影响面最大）：`src/schema/types.ts`、`src/core/types.ts`、`src/client/client-types.ts`、`src/security/redaction.ts`、
   `src/foreign/types.ts`、`src/client/common/ui.tsx`、`src/utils/guards.ts`、`src/ui/i18n.ts`。改这些文件的代价不在实现，而在**必须全仓验证**。
4. **双面共享靠零依赖模块**：client 不能碰 `node:`，所以常量/机器码放在 `src/utils/shared-constants.ts`（例如 `ENCRYPTED_CONTAINER_CODE`），
   需要跨端共享时**唯一合法去处**就是这类零依赖文件。
5. **分区口径单一来源**：`src/schema/section-registry.ts`（`SECTION_IDS`）→ `src/adapters/index.ts`（装配）→ `src/core/backup.ts` 的 `resolveFileTarget`（落盘位置）。
   新增分区要同时动这三处 + manifest schema + `docs/spec/`。

## 7. 读完之后

- 具体模块行为 → `docs/modules/`（backup-restore / sync / recovery / foreign-market / profiles-instances）
- 客户端与 UI 规范落点 → `docs/components/client-ui.md`；视觉决策 → `DESIGN.md`
- 为什么要这么做 → `docs/decisions/`
- 已知债与硬限制 → `docs/maintenance/`
- 对外数据格式与兼容性 → `docs/spec/`
- 每条硬规则的证据 → `docs/lessons/`；规则本身 → `AGENTS.md`

最后核对：2026-10-22（当日 HEAD），核对方式 = 跑 `node --test tests/architecture-boundaries.test.ts tests/route/route-fence.test.ts tests/route/route-parity.test.ts` 与源码 grep。
