# AGENTS.md — DSH Config Manager 仓库协作指南

> 完整架构/测试矩阵/限制见 `DEVELOPERS.md`；用户文档见 `README.md`；UI 唯一权威见 `DESIGN.md`。
> 本文只写改动前必知的隐性约定与坑。

## 🌐 语言
与用户交流一律中文；代码注释/commit/文档以中文为主，技术术语可保留英文。

## 📦 概览
- 用途：DSH 配置的备份/导出/导入/迁移/远程同步/配置市场，双面 Cordis 插件。
- 技术栈：TS 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node≥22（host）、React 18 + CSS Modules（web）、`node:test` 零依赖、tsdown + lightningcss 打包 client。
- 样式：**CSS Modules 唯一样式表 `src/client/config-manager.module.css`**；颜色/字体/阴影全走 DSH `--dsw-*` 变量；**默认不引入 Tailwind/CSS-in-JS/Sass/UI 库/图标库/动画库**——确需追加时按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估后落地。

## 🗂️ 结构与分层
```
src/index.ts   host 入口(name='config-manager'，apply() 装配 + 保留的 8 条路由)；路由表与 kit 见下行
src/routes/    路由 kit(单入口 endpoint()：loopback 围栏 + 方法白名单 + readJsonBody/requireJsonObject + 统一错误映射
               + 顶层 try/catch) 与按域拆分的组文件(import/snapshots/profiles/backup/consult/sync/prefs/market/me/
               history/recovery)；新增一条 API = 在所属组文件加一条 endpoint({ path, methods }, handler) 声明
src/core/      引擎(exporter/importer/restore/rollback/run-registry/plugin-cli)，与DSH解耦(ConfigAdapter/HostContext+内存mock)
src/schema/    类型/Manifest/版本(CURRENT_SCHEMA_VERSION=1)
src/security/  secret-scanner/redaction/zip-security/integrity/encryption(scrypt+AES-256-GCM)
src/adapters/  13适配器(settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self；includeSessions:true 时 +sessions=14)
src/sync/      SyncEngine+Git/WebDav+AutoSyncScheduler+config/state/history/sync-selection
src/market/    GitMarketReader+index-parser+security校验+builtin；github-repos.ts+my-repo.ts+git-file-writer.ts
src/migrations/ schema迁移链(registry+v1→v2占位)
src/profiles/  档案=DSH自带profile：dsh-profile-shared(零依赖类型/常量/纯函数)+dsh-profile-manager(列表/详情/新建/重命名/物理删/记录下次启动)
src/ui/        框架无关UI逻辑(纯函数/控制器，无React，node可测)  ← 业务逻辑必须在此
src/utils/     paths/zip/hashing/json/logger/atomic-write/env-lock/recursive-walk（跟随 junction 的递归遍历内核，issue #37）
src/client/    React壳(浏览器半)  ← 只做装配
tests/ 集成测试(node --test)；docs/README.md 文档索引；docs/design/ 设计文档；docs/spec/ 对外契约(格式规格/schema/兼容矩阵/已知缺口)；\n               docs/seo/ 曝光审计记录；docs/handoff/ 阶段交接文档(历史归档，非当前状态)；其余文档一律进 docs/，根目录只放对外文档
```

### UI 分层铁律
1. **逻辑放 `src/ui/`**（纯函数/控制器）——禁止在 React 组件里写可测试业务逻辑。
2. **React 壳只装配**（`src/client/` 组件只渲染+交互状态，模型来自 `src/ui/`）。

- 页面落位、共享原语、状态中枢、文案字典的完整清单：见 `DEVELOPERS.md` §「从 AGENTS.md 下移的细则」。

## 🔢 版本三处必须同步（最易漏）
`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`(约L124) ≡ `package-lock.json` 根对象 version(L3) 与 `packages[""].version`(L9)。bump 后跑 `npm run typecheck` 确认。

## 🚀 发布（打 tag 全自动）

**发版前必做两道门禁**（漏了 CI 直接 fail）：① `package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION` ≡ `package-lock.json` 根对象与 `packages[""].version` 三处同步；② `CHANGELOG.md` 顶部加当前版本双语亮点段。
打 tag 即全自动（`tag v* push → typecheck → test → build → pack → npm publish(OIDC) → GitHub Release`）；完整步骤、OIDC 配置与产物路径见 `DEVELOPERS.md` §「自动发布」。

## 🔐 安全不变量（硬约束，不得破坏）
- **Secret 默认不导出**：`includeSecrets` 缺省 false；凭据值绝不写入同步文件/日志/回传浏览器。
- **同步「导出密钥」= 独立密文凭据载荷**（issue #38）：`includeSecrets=true` 时 `.credentials.yaml` 原文加密为 `SyncSnapshot.credentials`（**绝不进 `sections`**，那是 `FORBIDDEN_SECTIONS` 结构性拒绝分区），拉取侧解密为 `Map<ref,value>` → `MissingSecret` 计划项 → `decryptedCredentials` → `credentials.set`。读不到/为空必须**显式告警**（不得静默成功）；`includeSecrets ⇒ encrypt` 与「非加密快照声明 containsSecrets 即拒绝」两条不放宽；该 Map 只存进程内存（存值不存密码），随同步会话 TTL/消费/取消消失。
- **凭据不可回读**：`ctx.credentials` 永不回读值，只经 `HostContext.fs` 文件级读 `.credentials.yaml`；`encryption.ts` 只做字节级加解密。
- **凭据计划项只在计划生成期产出，判据「值的有无」优先于「本机状态」**（两轮真机反馈的合并结论：先是「已有的重复密钥也会提示」，接着是「导入密钥没真正导入」——只按本机状态跳过会把有值的凭据也挡掉）：
  - **有值**（宿主解开 `security/secrets.enc` / `SyncSnapshot.credentials` 得到的 ref）→ 一律 `MissingSecret`（导入侧文案 `import.secretFromArchive` / 同步侧 `sync.credentialsItemDesc`）并在执行期写回，**不因本机已配置而跳过**（这正是「导出密钥」的语义）。要逐项放过用确认列表的批量按钮（`sync-view.isBulkDecidable`）。
  - **无值**（普通备份：`credentialsStatus` 声明的 ref）→ 本机已配置 → `Skip`（`import.secretAlreadyConfigured`，保留本机值、不再索要补录）；本机没有 → `MissingSecret`（要求补录）。判据 `isCredentialConfigured`（`src/core/credential-status.ts`；读不到 → false 保守）。凭据值不可回读 ⇒ 无值分支绝不覆盖本机值。
  - 实现与坑：导入 `analyzer.buildCredentialPlanItems`（ref 取**并集** = credentialsStatus ∪ 解密出的 ref；原名 `ensureMissingSecrets`）。**`createImportPlan` 必须收到 `decryptedCredentials`**——只认 credentialsStatus 会漏掉「未被任何 settings namespace 引用」的 ref（`.credentials.yaml` 是原文加密），这些值会静默丢掉：宿主 `/plan` 按 `decryptPassword` 解密后传入，客户端 `api.createImportPlan` 与 `/analyze`、`/execute` 同源传同一个密码（`ImportWizard.planOpts()`）。同步 `sync-engine.appendCredentialPlanItems` 只处理有值 ref，并把先前按「无值」判成 `Skip` 的同 id 项**升级**回 `MissingSecret`（否则有值也被 Skip 挡住），同时让 `plan.missingSecrets` 与 items 同源。注意 `credentialsStatus` 是 `deviceSpecific` → **永不进同步通道**，所以同步侧的值只能来自凭据载荷。
  - 回归护栏：`src/security/security.test.ts`「归档携带的凭据必须全部进计划并写回」（6 类分支：未被引用的 ref / 本机已有仍写回 / 无值未配置要补录 / 无值已配置 → Skip）、`src/adapters/roundtrip.test.ts`（普通备份 + 本机已配置 → Skip）、`src/sync/sync-credentials.test.ts`（有值一律进计划且写回 + 无载荷快照不含 credentialsStatus 的说明）、`src/ui/import-wizard.test.ts`（计划期同样带解密密码）；`tests/core/rollback.test.ts` 的 E-02（凭据不可回滚 → 部分回滚）改为在**计划生成之后**才让目标机拥有旧凭据。
- **一键同步差异确认的批量按钮覆盖「全部确认项」**（`sync-view.isBulkDecidable`）：`keepLocalAll`/`useRemoteAll` 作用于确认列表里的每一项（Conflict 项连带给 resolution），**只排除 Error**（硬失败项被采用后必记 failed，不能由批量按钮代裁）。此前批量只认 Conflict → 含 N 条凭据迁移项（`缺密钥`）时按钮恒灰、只能逐条勾（用户报告）。
- **日志全程脱敏**：`redactValue` 掩码敏感值；UI 渲染前所有错误/报告再过 `redact()`（`ErrorBanner.tsx`/`ReportView.tsx`）。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）。
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖。
- **加密备份 / 导出**：密码仅内存传入，不落盘/不落日志；解密明文 ZIP 为临时文件用完即清。
- **同步通道的加密/解密密码**（唯一例外，product requirement）：用户不勾选加密就删除、不留空；勾选后保存到 DSH credentials 的独立槽位（`syncPasswordRef('ENCRYPT'|'DECRYPT', 通道)` → `DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_<GIT|WEBDAV>` / `..._DECRYPT_...`），由 `POST /sync/selection` 写/删、`GET /sync/status` 只回 `configured` 布尔。**值绝不写入 sync-*.json / 响应 / 日志 / 直出浏览器**；请求体里的密码优先于已存密码，删除优先于写入。
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 仅布尔标记。
- **同步分区目录含一个显式可选项**：`syncSectionCatalog` = portable + `OPT_IN_SYNC_SECTIONS`（目前只有 sessions）。可选分区**永不默认进入同步通道**，必须两侧都显式放行：**推**要 `opts.sessions = { limit }`（否则 `pushTargets` 按非 portable 警告跳过），**拉**要引擎实例的 `includeOptInSections: true`（`pullSectionIds()` 决定远端快照里哪些分区进临时 ZIP；宿主只在用户驱动的 pull / 一键同步路由上、且持久化选择确实含 sessions 时传，自动同步与 model-tools 恒不传 —— 会话绝不悄悄下行）。
- **同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地；对外格式见 `docs/spec/sync-channel-v1.md`）**：
  ① **远端保留接 GFS**：`SyncEngineOptions.retentionPolicy`（宿主注入 `readBackupSchedule().retention`）驱动 `pruneRemoteSnapshots`，与本地备份产物/本地快照共用同一份 `RetentionPolicy`。缺省 `DEFAULT_RETENTION_POLICY`（keepLast=10）走 core 的 `selectPruneCandidates` 快速路径 → 与旧硬编码 `MAX_REMOTE_SNAPSHOTS` **逐字等价**；**刚 push 的快照恒保留**（三层全关时也不删它）。此前「会话寿命 = 最近 10 次 push」由此消除。
  ② **跨机重定基贯通同步链路**：push 把 `ctx.homeDir` 写进 `snapshot.manifest.sourceHome`，`snapshotToZip` 透传进临时 ZIP → Importer 的 `rebaseMapping` 生成「源机 home → 本机 home」；`merge()` 额外**备忘**远端 sourceHome（`lastMergedRemoteSourceHome`）供 `applyMergePlan` 写入临时 ZIP 的 manifest（否则一键同步/自动同步路径永远不重定基）。`SyncPullOptions.pathMappings` 与路由 `extractPathMappings` 承载**用户映射**，排在自动规则之后。**缺 sourceHome 的旧快照不猜**（行为与改造前一致）。
  ③ **逐会话点名**：`sync-selection.json` 的 `sessionsInclude`（非空时**优先于** `sessionsLimit`；空 = 回到「最新 N 个」）。引擎用 `sessionExportOptions` 保证「显式勾选 > 数量上限」——adapter 里 `restrictUnits` 先于 `includeItems` 执行，两者叠加是**交集**（会退化成「最新 N 个里我勾中的那几个」），所以 include 非空时**不施加数量限制**。UI 复用导出侧的 `ContentPicker`（`SyncSectionPickerDialog` 内切换视图，**不嵌套第二个 Modal**），清单来自 `/export-preview`（`SyncApi.exportPreview`），勾选模型在 `ui/sync-settings-view.ts`（`initialSessionPicks`/`sessionPickerSelection`/`pickedSessionIds`）——组件里不得再实现「sessions 显式放行」判定（`SyncSettingsView.test.ts` 的 t42 守卫会红，判定走 `needsSessionInventory`）。
  ④ **内容寻址 blob 仓**（`src/sync/blob-store.ts`）：`sessions` 在**通道侧**外置为 `blobs/<sha256>` + 引用形态（散文件 `<section>.blobs.json` / WebDAV 载荷 `blobRefs`），**只有 transport 传了 BlobSink 才启用**（引擎/导出/导入看到的仍是普通 FilesSection）。命中已有哈希 = 零传输。**读回缺 blob 必须硬失败**（绝不降级为空分区）；**加密快照永不外置**；`sectionHashes` 一律按明文分区算（拉取侧不解仓也能比较变更）。GC：保护窗 10 分钟 + 「任一引用文件读不出来就放弃本轮」。这两条线**不做协议协商**（旧版读新版会把 sessions 当缺失分区）→ 登记为 `known-gaps.md` **G-19**。
  ⑤ **会话删除墓碑**（`src/sync/session-tombstones.ts`）：push 时「`sync-state.sessionUnits`（上次实际带走）− `adapter.listAllUnitIds(ctx)`（本机现存全量）」= 本次新删，累积成 `manifest.deletedSessions` 随每份快照传播（上限 5000；本机又出现实体则**撤销**墓碑）。**三情形一律不动既有记录**：本次没推 sessions / 适配器不支持全量枚举 / 本机枚举为空或失败（把「读不到」当「全删」会一次性标错几百条）。pull/preview/merge 按墓碑把命中的会话单元从**将要导入的载荷**里剔除（整目录，`relativePath` 前两段），**不删除本机数据**（删除是不可回滚的用户动作）→ 登记为 **G-20**。剔除必须可见（`sync.sessionsTombstoned` / `sync.sessionDeletionsRecorded`，绝不静默）。
- **sessionStorage 白名单**：`run-store.ts` `toPersistedState()` 解构剔除 `password/passwordConfirm/secretInputs/decryptPassword/decryptRefs/archiveUnlocked/conflictCollector`；新敏感字段不显式放行即不落盘。

## 🏗️ 架构心智
- 双面插件：host `src/index.ts`（Cordis `name='config-manager'`，`/api/dsh-config-manager/*`）+ web `src/client/`（React，settings.section，经 api 调 host）。
- **宿主路由只经 `src/routes/kit.ts` 的 `endpoint()` 声明**（W1，host-entry#F-02/F-03/F-05）：围栏（loopback + 同源）与方法白名单由 kit 在**注册点**统一包装（`registerRoutes()` 兜底断言「未经 kit 的路由直接抛错」），**禁止**再写逐路由的 `guard`/裸 `isLoopbackRequest` 样板；新增一条 API 只改一处（组文件里那一条 `endpoint({ path, methods }, handler)`）。路由源 = `src/index.ts`（被源码级窗口守卫钉住的 8 条）+ `src/routes/*.ts`（59 条）——**源码级守卫必须扫全部路由源**（见 `tests/route/route-fence.test.ts`、`route-parity.test.ts`、`route-channel-guard.test.ts`），只扫 index.ts 会静默失去覆盖。
- **宿主路由只能经 `src/routes/kit.ts` 的 `registerRoutes()` 注册**（W1，约定级防线）：全仓唯一调用点是 `src/index.ts`（也是唯一 webServer 消费点），它逐条断言路由出自 `endpoint()`；**绕过它直接 `webServer.register(...)` 的旁路当前不存在，但未来新增第二个注册点会静默失去围栏覆盖**（route-fence 只覆盖现有注册路径）。新增注册路径时必须同时接上 `registerRoutes`，或补一条同等的结构守卫。
- **插件 HTTP API 的真实认证边界 = kit 的围栏，不是 DSH 的 cookie**（W2 真机 E2E 实测 + DSH 源码读码确证；线上证据 `outputs/e2e-w2/`）：DSH 的 browser-session cookie 拒绝只挂在 **`kind:'prefix'`、`path:'/api'` 的 RPC 承载路由**上（`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `requestRejection()` L553-556 = Host/Origin 403 + browserAuth 401，只被 `register()` L605-618 的 prefix 路由调用），而 host-webserver 的派发顺序是 **exact 表先命中**（`@deepseek-ai/dsh-host-webserver/lib/index.js` 的 `match()` L321-331：先查 exact 表，未命中才按 prefix 最长匹配）。本插件 67 条路由（`src/routes/*.ts` 59 + `src/index.ts` 保留 8 = 65 条 exact + `recovery`/`lifecycle` 2 条**插件私有前缀**）都命中 exact 或更长的私有 prefix，**永不进入** DSH 的 `/api` 认证路由——实测**无 cookie** 的 `GET /api/dsh-config-manager/status` 返回 **200 + 完整 JSON**，而 DSH 自己的 `GET /api/<未认领路径>` 与 `GET /` 无 cookie 均 **401**（认证确实存在，只是不覆盖插件 exact 路由）。**影响面**：本机任意非浏览器进程（含本机其它本地用户）**无 token/cookie 即可调用全部 67 条路由**，含破坏性路由（`/profiles/delete`、`/execute`、`/sync/rollback`、`/snapshots/delete`、`/recovery/**` 等）；**远程/LAN 来源**被 kit 的 `remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 判定挡掉，**浏览器跨站 CSRF** 被同源/Host 围栏挡掉（实测跨站 Origin 403、同源对照 200）——**围栏确实在生效，不得把这条写成「插件 API 无认证」**。两个不得误解的推论：① **不得把 DSH 会话认证当作插件 API 的兜底**——认证挂在通用 prefix 路由 `/api` 上 + exact 优先的派发顺序是**平台级性质**，任何在 `/api` 下注册 exact 路由的 DSH 插件同理；插件 API 的边界只能是 kit 的 `endpoint()` 围栏。② 若将来要在**共享机器**或**经本机代理/隧道转发**（非回环来源、`trustedHosts`/LAN 绑定）的场景暴露插件 API，**必须**在 kit 里自行对接认证（方向：在 `endpoint()` 注册点统一加一道校验，勿逐路由散写），届时应重新评级本条的残余风险。**复核路径**：读上述两处 DSH 源码（安装位置 `.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{dsh-host-webserver,dsh-client-connection}/lib/index.js`）；线上复核 `powershell -NoProfile -File outputs/e2e-w2/run-e2e.ps1 -Strict`（本机无 pwsh 7，脚本支持 5.1；探针 `outputs/e2e-w2/probe.mjs`，原始打点与结论见 `outputs/e2e-w2/FINDINGS.md` §4 / §6 D1）。
- `src/core/` 与 DSH 解耦：`ConfigAdapter`/`HostContext`+内存 mock；**新功能优先加 core，适配器/UI 薄壳**。
- 13 adapter 见结构；`self`=插件自身配置（`$DSH_HOME/dsh-config-manager/` 下 `sync-*.json`/`market-config.json`/`ui-prefs.json` 白名单收，portable 默认包含；`dataDir` 在 `~/.dsh` 外不挂载）。
- 同步：`SyncEngine`+`Git/WebDavTransport`+`AutoSyncScheduler`(事件驱动,远端新快照才拉/本地改动才推)+`sync-selection`；**autosync 与 sync-selection 按通道(git/webdav)独立**(schema v2，v1→git)，调度器双通道各自排期。
- **import 一律带 `.ts` 后缀**(Deno-style，勿写无后缀)。
- 设计决策看 `docs/design/`（上游依据，实现规格在下游）。
- **对外契约看 `docs/spec/`**：与 `docs/design/` 性质不同——`design/` 是**上游设计依据**（写给本仓库），`spec/` 是**对外契约**（写给第三方实现者，应能在不读 `src/` 的前提下据此实现兼容的 exporter/importer）。含：`bundle-format-v1.md`（格式规格）、`bundle-manifest.schema.json`（机器可校验）、`compat-matrix.md`（DSH 兼容区间与升级风险）、`headless-consumption.md`（无 UI 栈消费引擎）、`sync-channel-v1.md`（**同步通道**快照格式：远端布局 / 内容寻址外置 / 删除墓碑）、`known-gaps.md`（已知缺口登记）。**改格式行为必须同步 `spec/`，并重跑 `tests/conformance/`。**
- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts`（零依赖扫描内核，**多趟并集**避免注释内反引号导致的状态失衡假阴性）+ `src/client/bundle-selfcontained.test.ts`（产物护栏，白名单仅 react/react-dom/react-dom/client/react/jsx-runtime）。**必须 Build 之后单独跑**——`npm test` 在 Build 前执行，此时 `lib/client.js` 不存在，测试会跳过；故 `ci.yml`/`publish.yml` 各有一独立步骤。注释里的同名字符串会造成假阳性（本仓库实测过）。
- DI 走 Cordis fiber：client 经 `ctx.slots.inject('settings.section')`+`inject:()=>({api,syncApi,...})`；host 可选服务 `ctx.get()` 惰取。

## 🛠️ 开发规范

### TS/命名
- **import type**（`verbatimModuleSyntax` 强制）；类型合并用 `declare module`+`import type{}`。
- React：函数组件+hooks，无 class/高阶组件；props 显式 `XxxProps`；导出类型汇总于 `src/client/index.ts`。
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，CSS 类名 camelCase。
- 分号暂未统一——跟随所在文件风格，勿同一次 diff 混改。

### 状态管理
- 状态归属：高频可恢复流程（Export/Import）进 `run-store.ts`（切 tab 不丢/刷新恢复）；低频面板组件自持 + 非敏感切片镜像；凭据只存内存并被 `toPersistedState` 白名单剔除。细则见 `DEVELOPERS.md`。

### 数据访问/错误
- 一律走类型化 api 类(`ConfigManagerApi/SyncApi/MarketApi`)，实现 `src/ui/types.ts` port 契约；**组件禁止直接 fetch**。
- 错误链：`toActionableError()` → `ErrorBanner`；**展示文本渲染前过 `redact()`**。
- 进行中任务 `runStore.watchRunning(kind,500)` 轮询真实进度；定时器卸载清理+防重。

### i18n
- i18n：**禁止硬编码用户可见字符串**；文案进字典，`src/ui/` 走 `UiT`（`makeUiT`），React 壳走 `t()`（`ConfigManagerKey` 编译校验，zh 源 / en 镜像）。**7 套字典的对照表与「查不到 key 不等于缺陷」的排查姿势见 `DEVELOPERS.md`——那一段极易误判，漏读会产出 600+ 假阳性。**

### 测试
- `node:test`+`node:assert`(零依赖)，同文件 `*.test.ts` 同目录。
- `src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 无组件框架，逻辑提炼到 `src/ui/` 保证可测。
- 新功能必带测试，加密/同步/安全类尤其（样板：`src/security/security.test.ts`、`src/sync/sync-engine.test.ts`）。

## 🧪 命令
```bash
npm install --legacy-peer-deps   # 必须带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts
npm run smoke                    # 仅 core 冒烟
npm run bundle                   # 仅重建 client bundle
```
- 无 lint/format 脚本，只以 typecheck 兜底（历史 `eslint-disable` 是遗留）。
- CSS Modules 由 tsdown+lightningcss 编译为内联注入，单文件 `lib/client.js` 自带样式；**新增样式只能在 `config-manager.module.css`**。

## 🎨 UI / DESIGN SYSTEM（最高优先级）
> **`DESIGN.md` 是 UI/样式决策唯一权威**。涉及 UI/Layout/CSS/颜色/字体/间距/图标/动效/响应式/视觉状态前必读。

**硬性规则：**
1. 颜色/字体/阴影必走 `--dsw-*` token；**禁止 hardcode**(`#fff`等)，tint 用 `color-mix(in srgb, <token> <pct>%, transparent)`。
2. 样式只能进 `src/client/config-manager.module.css`；禁止新增 css/内联 `<style>`/第三方 css；类名用 CSS Modules 引用(`css.xxx`)，**勿写字符串 class**(`sync-history-table` 属遗留)。
3. 复用 `src/client/common/ui.tsx` 原语 + Common 的 `ErrorBanner/ErrorList/ProgressBar/ReportView`；已有公共组件能解决禁止重建，新页面先搜库。
4. **默认不引入第二套视觉体系**(Tailwind/CSS-in-JS/Sass/UI库/图标库/动画库)；图标默认用文本符号/emoji。确需追加第三方 UI 库时，按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估后落地。
5. 按钮语义：`variant="primary"`(主操作)/默认 ghost(次)/`variant="danger"`(危险如恢复/回滚)；勿用 primary 做危险操作。
6. 徽章：`Badge kind="ok|info|warn|error"` 与 `Banner` 四态一一对应；先想语义再选 kind。
7. 文案走 i18n 字典；展示文本渲染前进 `redact()`。
8. 长列表/大报告限高内滚(`planScroll/reportScroll/confirmScroll/pullScroll/diffScroll`)，禁止撑长整页。

### Missing Design Rule（DESIGN.md 未覆盖）
- DESIGN.md 未覆盖的设计决策：搜库确认 → 能扩展先扩展 → token+color-mix 组合 → 新规范并**写回 DESIGN.md** → 再使用。步骤全文见 `DEVELOPERS.md`。

### Style Change Workflow
读 DESIGN.md → 识别相关规则 → 搜可复用组件 → 尽量用现有 token/组件 → 新 pattern 则先定义→更新 DESIGN.md → 实现 → 与既有页面对比验证。

### Existing UI Protection
除非明确要求 redesign，否则最小范围修改(fix only asked)、保持既有视觉/交互/Pattern、不顺便改无关页面、与既有页面观感不一致时以既有为准。

### 第三方 UI 库准入（按需追加）
- 默认不引入第二套视觉体系；确需追加按 7 步准入流程（必要性 → token 对齐 → CSS 隔离 → 体积 → 依赖同步 → 文档落位 → 验证）。流程全文与已落地清单见 `DEVELOPERS.md` 与 `DESIGN.md` §6。

## ♻️ Reuse Before Creating
新建任何 Component/Hook/Utility/Style/Type/API 前按序：①Reuse ②Extend ③Refactor ④Create。
检查顺序：`src/client/common/*` → `src/ui/*` → `src/core/*` → `src/utils/*` → `src/security/*` → DESIGN.md。避免功能相同实现不同。

## 📦 Dependency Rules
- 已有库能满足优先用现有（运行时依赖仅 `js-yaml`；peer 是 DSH 官方包）。
- 不为小功能随意加 UI/CSS/Icon/Animation/Utility 库。
- 加依赖前确认现有方案无合适选择，评估发布限制；新增后同步更新 `package.json`+`package-lock.json`（两处+根对象）。

## ✅ Verification
```bash
npm run typecheck   # 所有改动
npm test            # 动逻辑/纯函数/引擎/适配器
npm run build       # 动 client/样式
npm run smoke       # 大改动
```
UI 自查：DESIGN.md 一致(token/组件/spacing/radius/状态语义)、响应式、Hover/Focus/Disabled/Loading/Empty/Error 齐全、Dark Mode 无 hardcode、未建重复组件、新样式进 css+DESIGN.md、新文案进 locale(zh/en)、敏感字段未落 storage/日志/回显。

## 📚 文档同步
| 代码变化 | 更新 |
|---|---|
| 新 Design Pattern/Shared Component/Token/主题/新页面 | `DESIGN.md` |
| 新目录约定/架构Pattern/开发规范/脚本/CI | `AGENTS.md` |
代码与文档同步；冲突时以代码为准修正文档。

## 📌 常见坑
- **pnpm 发布年龄**：`@latest` 装旧版是 pnpm 11 `minimumReleaseAge`（<30天被排除）；解决：精确版本装一次白名单，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。
- **Windows LF→CRLF 警告**：无害噪音。
- 根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore。
- `dist/` 需先创建再 `npm pack --pack-destination ./dist`（fresh checkout 否则 ENOENT）。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`。
- **`src/client/` 不 import node 模块**（`PathMappingForm` 因 `utils/paths.ts` 依赖 node:path 做了轻量等价实现，刻意为之）。
- **style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回 `isSymbolicLink()===true`（`isDirectory()` 为 false），自己写 `if (isDirectory())` 分支会**静默丢掉整块内容**且备份仍报成功（issue #37 实测丢 12 MB）。新文件类 adapter 用 `adapters/link-report.ts` 的 `listFilesDetailed` + `linkWarnings`，别直接调 `ctx.fs.listRecursive`。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**（issue #35）：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`（`Failed to read patch file`）。导入端写入前必须剔除目标机无法满足的 `patchedDependencies` 条目（`adapters/pnpm-workspace.ts`），并让剔除在计划里可见；市场通道对 `patchFiles` 与 `localTarballs` 同级双端拒收。
- **会话日志的字节改写只允许在宿主侧**（issue #45）：DSH 会话日志（`session*.jsonl.zstd`）是**拼接的多帧 zstd 容器**，改写 cwd 必须只换第 1 帧 + 尾部**流式**拷贝 + 发布前自检（长度 / 首帧 cwd / 尾部抽查），且 **Windows 上 rename 覆盖前必须关闭读句柄**（否则 EPERM，实测踩过）。`src/utils/zstd-frame.ts` 是纯字节帧工具；`src/utils/session-log.ts`（首帧 cwd 读取 / 多 generation 改写 / 发布前自检 / 失败回滚）是**宿主适配器与 CLI 的唯一实现**——core 禁止 import（不得把 DSH 存储格式带进引擎）。改写后尽力刷新注册表索引（`reindexSessionHeader`，d.ts 标 private、已能力探测；不要用会清空 sessionPaths 的 replaceHeaderIndex），刷新不了就如实汇报、绝不谎报。**头等硬约束（实测）**：DSH 启动时校验「日志位置 == `projectKey(header.cwd)/id`」，位置与 header 不一致会让 `dsh web` 直接报 `corrupt session log ... header id ... and cwd identify ...`（同一 id 出现在两个 projectKey 目录则报 `duplicate JSONL session id ... in multiple project directories`）——所以**改写 header 必须连目录一起归位**，搬不动就回滚改写，绝不留半套。
- **本插件是 bundle 包，隔离实例里挂载必须进 `dsh.profile.bundles`**（E2E 实测）：包的 `package.json` 有 `dsh.bundle.patch`，DSH 只会把它作为 bundle 组合进 profile 树；只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行是**非 bundle 包**的做法，插件不会挂载（表现为宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库（免 pnpm 联网）→ 把 `dsh-config-manager` 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**（`/` 与 DSH 的 `/api` 承载路由；插件 exact 路由无 cookie 同样可达，见「安全不变量 / 架构心智」的认证边界条）：先 `curl.exe -c jar "http://127.0.0.1:3099/?token=<token>"`（token 取自启动输出），再 `-b jar` 调那些路由；POST 体用 `--data-binary @<file>`（PowerShell 传 `-d '{"x":1}'` 会丢引号 → 路由报 `invalid JSON body`）。脚本留存于 `outputs/e2e-45/`。
- **文件集合分区永不参与导入期前缀映射**（issue #45）：`ConfigAdapter.fileCollection`（`FileCollectionAdapter` 置 true）标记的分区（sessions / pluginFiles / skills …）里，`relativePath` 是**身份**不是配置 —— 前缀映射一旦命中它的首段（`--projectKey--`），文件就会落到 `projectKeyOf(首帧 cwd)` 之外，目标机**下次启动直接失败**；`analyzer.applyMappingsToSections` 已按该标记整段跳过（`src/core/analyzer-mapping.test.ts` 钉住）。会话侧走**专用通道**：`SessionsAdapter.finalizeApply` 在整个分区写完后逐会话把 `ctx.pathMappings` 应用到**首帧 cwd**（`rewriteLogDir` 只换第 1 帧）再归位到 `projectKeyOf(映射后 cwd)`，搬不动就回滚首帧；没命中映射只做原有位置护栏。**导出会话时自动连带其所属工作区**（`exporter.coupleSessionWorkspaces`），因为会话要在目标机显示就必须有工作区指向它的 cwd；**这条不变量必须硬保证**（真机事故：用户只勾「历史会话」时导出过一个 `sections.sessions=true / workspaces=false` 的包，目标机上会话看不见 = 「对话丢了」）：① 归属匹配不上时**整分区带上全部工作区记录**，② 本机一条记录都没有 / 注册表读不到时如实告警，③ 连带白名单与分区选定**共用同一份 includeItems**（否则用户「全部取消勾选工作区」下发的 `includeItems.workspaces = []` 会在第二道过滤里把刚强制选中的分区再挡掉），④ 四种结果各有一条报告文案（`export.sessionsWorkspacesCoupled` / `export.sessionsWorkspacesCarriedAll` / `export.sessionsWithoutWorkspaces` / `export.sessionsWorkspacesUnreadable`）绝不静默，⑤ 导入侧对「有会话但没有任何工作区数据」的包（旧构建导出的历史包就是这种）在**分析阶段**告警 `import.sessionsWithoutWorkspaces`（`analyzer.analyzeBundle` 共享给分析与执行两条路径）；宿主半在 DSH 启动时加载、**没有热重载**——改了导出/导入逻辑后必须重启 DSH 才生效；工作区记录里的 `sessionIds` 由 `WorkspacesAdapter.finalizeImport` 在**全部分区收尾之后**（APPLY_ORDER 里 workspaces 在 sessions 之前）逐个 `attachSession` 登记，未登记成功记 warning。DSH 起不来时的唯一通道仍是离线 CLI（`dsh-config-manager sessions repair`）；隔离实例里复位 `storages/workspace.json` **必须先停宿主再改文件**（插件运行时 DSH registry 的内存是权威域）。**选择器层的联动**：勾了会话自动勾上拥有它的工作区、取消工作区自动取消它的会话（`src/ui/selection-model.ts` 的 `applySessionWorkspaceCoupling`；导出页与导入向导共用 `ContentPicker`，所以只写一份）。**方向必须显式传入**（`focus: 'sessions' | 'workspaces' | 'both'`）：这两条规则在「会话勾着、它的工作区被取消」时会互相抵消，按本次动作方向定夺才确定。工作区单元与会话单元配对用**两套判据**（`WorkspacesAdapter.listUnits` / `analyzeImport` 带上 `sessionIds` 与 `projectKey`）：
① 注册表 `sessionIds`（经 `sessionIdKey` 去掉 `session-` 前缀后比较 —— 会话目录名有 `session-<uuid>` / 裸 `<uuid>` 两种形态并存）；
② **cwd 目录键相同**（工作区 `path` 的 `projectKeyOf(path)`，客户端在旧宿主未回传该字段时用单元 `detail`=绝对路径现算）。
**为什么必须有 ②**（真机实测）：DSH 的 `sessionIds` 覆盖率极低 —— 一次可选择的 **570 条会话里只有 23 条**在里面，只认 sessionIds 时「点一个对话不带工作区」是常态；
而界面又按 cwd 目录键把会话显示在该工作区下（`session-meta` 分组同口径），联动必须与看到的一致。**绝不按会话路径做前缀匹配**（跨机路径不可靠）。
导出页的清单是逐分区惰性拉的：勾了会话就必须把 `workspaces` 清单一起读（`couplingInventorySections`），清单到货后再补一次联动（`ExportView` 的 effect，方向固定 `sessions`，用 `sameSelection` 防自激）。**跨机基础路径自动重定基**：导出时把本机 `$DSH_HOME` 写进 `manifest.sourceHome`；导入时若与本机 home 不同，`analyzer.rebaseMapping` 生成一条 `{oldPrefix: 源home, newPrefix: 本机home, appliesTo: []}` 并**插到用户映射之前**（`createImportPlan` 与 `executeImportPlan` 都走 `plan.pathMappings`，所以结构化分区路径 + 会话首帧 cwd + 目录归位一起生效），计划里通过 `ImportPlan.automaticMappings` 可见。只对**绝对路径**、且落在**段边界**的前缀生效（相对路径 / 两边相同 / 旧包缺字段一律不猜，行为与改造前一致）；用户映射排在其后可覆盖。
- **导出/导入的会话可见性必须由「包内实际带走的会话」驱动**（issue #45 ③，真机事故）：DSH 工作区注册表的 `sessionIds` 覆盖率极低（真机实测 570 条会话里只有 23 条），所以**绝不能只搬注册表原样的 `sessionIds`** —— 导出侧 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`，由 `Exporter.export` 在收集完分区后调用）按「cwd 目录键相同」把本次真正带走的会话声明进所属工作区记录（按 `sessionIdKey` 裸键去重、只增不减、写**日志侧原名**），报告出 `export.sessionsDeclaredInWorkspaces`；导入侧 `WorkspacesAdapter.finalizeImport` 的登记目标 = 记录声明的 ∪ 包内带数据的，失败**必须按「这次有没有带它的数据」分类**（带数据的失败 = warning + 真实原因；包外会话 = 不计失败的信息行 `adapter.workspaceSessionsOutsideBundle`），且每个 id 先试声明形态、再试另一种命名形态 —— DSH 只认会话日志首帧 header 的 `id`，它 `session-<uuid>` / 裸 `<uuid>` 两种并存（实测目录名与 header id 逐字相同），只试一种会以 `session persistence holds no such session` 被拒，用户看到的就是「导入后对话不显示」。复核：`outputs/e2e-45b/run.ps1`（隔离实例真导入，直接看 `storages/workspace.json` 的 `sessionIds`）。
- **子代理会话（origin='subagent'）不是工作区里的对话：导出时必须连带父对话**（真机事故：导入全部「成功」，工作区里一条都看不见）：DSH 客户端 `dsh-client-ui-workspace` 的 `sessionVisible()` 是 `session.origin !== "subagent" && ...` —— 工作区列表**只显示**顶层会话，子代理会话只作为**父对话的下一级**出现；只把子会话导出/同步过去，目标机导入侧一切成功（文件落盘、`workspace.json` 也登记了），用户在 DSH 工作区里却一条都看不到（真机：用户勾了 4 条子代理会话导出再导入，全无踪影 —— 它们的父对话都不在包里）。修复（**双向**）：`SessionsAdapter.export()` 收尾调用 `coupleSessionParents`（`src/adapters/sessions.ts`）——① **向上**：选中子代理会话就补父对话（父对话本身也可能是子代理会话 → 继续往上追），报告 `export.sessionParentsCoupled`；② **向下（2026-09 改为界面联动，引擎不再自己做）**：勾父时由**界面**自动勾上它的子代理会话（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，ContentPicker 的 `commit` 在每次单元点击后调用）——为什么要挪走：条目级白名单是用户意图的唯一事实，而引擎看不到「界面为什么没勾这条子会话」，自己向下补会把「用户单独取消的子会话」无声加回包里（真机：只勾 2 条 → 导出 41 个目录）；子会话清单由宿主 `SessionStoreFacade.parentRelations()`（`src/index.ts` 用 DSH `sessionPersistence.list()` 的 header `parentSession`+`origin` 实现，**不读日志字节**）提供，只收 `origin='subagent'` 的子会话（非 subagent 的会话即使带 parentSession 也是顶层行），经 `/export-preview` 的 `ExportUnit.parentSessionId`（裸键）下发给浏览器；**注意 `export.sessionChildrenCoupled` 已不再产生**（字典键保留备用）；追不到（本机没有 / 超出分区上限）报 `export.sessionParentsUncoupled`，绝不静默；**BFS 的「已排队」与「已展开」必须分成两个集合**（某个会话可能既是被选中的父对话、又是别人的子会话；混用一个集合会把它当「已见过」而不再展开 → 它的子代理会话静默丢失，真机实测踩过）；导入侧 `finalizeApply` 对「父对话不在包内」的子代理会话报 `import.subagentSessionsWithoutParents`（旧包兜底，把「导入成功却看不见」变成可读告警）。**父对话 id 在磁盘 header 里叫 `parentSession`，DSH 的 RPC 投影才改名 `parentSessionId`**（只认后者一个都认不出来，静默失效 —— 已由 `src/utils/session-log.test.ts` 钉住两种写法）。复核：`outputs/subagent-fix/export-check.ps1`（只勾 4 条子会话 → 包内 8 个会话文件 + 「已连带导出 4 个父对话」）与 `import-check.ps1`（干净目标导入 → DSH `session/list` 8 条，其中 4 条顶层会话 `cwd == workspace.path` 且在 `sessionIds` 里 = 工作区可见，4 条子会话按其父之下显示）。**②.1 父子联动的方向语义（白名单即权威）**（真机第二轮：用户只勾 2 条子代理会话，导出却打了 41 个会话目录 = 2 个父对话 + 37 条**从未勾选**的兄弟子会话，导入页显示「43 个历史会话」）：界面侧 = 勾父带子（传递）、勾子带父（父链向上）、取消父连带取消子、**取消子只取消这一条**；批量动作（分区/分组/全选、清单到货后补跑）走**正向闭包**（只补齐、绝不取消任何勾选项）。方向必须显式传入（`SessionParentChange`）——这两条规则会互相抵消（取消父后若还跑「已勾选的子 ⇒ 勾上父」，父立刻被勾回来，与工作区联动同一个坑）。引擎侧**只保留向上补父对话**（父缺席 = 导入后完全看不见）、**绝不再向下展开**：白名单即权威。复核测试：`src/ui/selection-model.test.ts` 的 5 条「父对话 ↔ 子代理会话联动」与 `src/adapters/sessions.test.ts` 的「只勾子会话 …不把用户没勾的兄弟会话一起打包」。
- **导出选择器里「历史对话」的排序时间有两个来源**（用户报告「没有按最新到最旧排」）：第一口径 = `storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`），第二口径 = `SessionsAdapter.unitActivityTimes()` 现算的**会话日志 mtime**（`/export-preview` 注入 `applySessionMeta`）。为什么必须有第二口径：那份缓存只覆盖一部分会话（真机实测同一项目 **731 个目录里 347 个不在缓存内**），缺时间的会话会退化成组尾的 uuid 字典序。**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`，单元 id 末段是目录名，`session-<uuid>` / 裸 `<uuid>` 两种形态并存 —— 不归一化会同时丢掉标题与时间）。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning`（非致命失败，§34.17）与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35 实测）。

## ⛔ 技术限制（勿突破）
凭据值无法回滚(DSH 不回读)、插件安装需重启、MCP 无管理 API(组合 patch 行导入)、localStorage UI 状态不迁移、Schema v1→v2 为占位(CURRENT=1)、历史会话默认不迁移、加密备份密码丢失无法解密。完整清单见 DEVELOPERS.md §「完整技术限制」。
