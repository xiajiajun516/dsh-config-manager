## 🌐 语言
与用户交流一律中文；代码注释/commit/文档以中文为主，技术术语可保留英文。

## 📦 概览
- 用途：DSH 配置的备份/导出/导入/迁移/远程同步/配置市场，双面 Cordis 插件。
- 技术栈：TS 5.9（strict + `verbatimModuleSyntax` + `noUncheckedIndexedAccess`）、Node≥22（host）、React 18 + CSS Modules（web）、`node:test` 零依赖、tsdown + lightningcss 打包 client。
- 样式：**CSS Modules 唯一样式表 `src/client/config-manager.module.css`**；颜色/字体/阴影全走 DSH `--dsw-*` 变量；**默认不引入 Tailwind/CSS-in-JS/Sass/UI 库/图标库/动画库**——确需追加按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估。**已准入（2026-09，均经该流程）**：`lucide-react`（图标）、`morphicons` + vanilla `lucide`（图标**形变**，仅折叠展开 chevron）、`@radix-ui/react-dialog`（弹窗 a11y）；均 devDependencies + `deps.alwaysBundle`，**不得重复引入同类替代库**（清单与体积见 `DEVELOPERS.md` / `DESIGN.md §6`）。

## 🗂️ 结构与分层
```
src/cli/      离线 CLI（bin: `dsh-config-manager` / **`dcm`**）：snapshots/restore/reinstall/verify/backup/**import**/sessions/**web**
              actions.ts = **动作层**（只读判定 + 写动作；CLI 与救急台共用同一实现，返回结构不打印）
              help.ts = **帮助文案单一事实源**（速查页按风险分组 + 每命令详情页；index.ts 只解析与执行，不再散写文案）
              web/ = 离线救急台（node:http + 复用 routes/kit.ts 围栏/方法白名单/错误映射；页面服务端直出）
src/index.ts  host 入口(name='config-manager'，apply() 装配 + 保留的 7 条路由)
src/routes/   路由 kit(单入口 endpoint()：loopback 围栏 + 方法白名单 + readJsonBody/requireJsonObject + 统一错误映射
              + 顶层 try/catch) 与按域拆分的组文件(import/snapshots/profiles/backup/consult/sync/prefs/market/me/
              history/recovery)；新增一条 API = 在所属组文件加一条 endpoint({ path, methods }, handler)
src/core/     引擎(exporter/importer/restore/rollback/run-registry/plugin-cli)，与DSH解耦(ConfigAdapter/HostContext+内存mock)
src/foreign/  外部 agent 配置→bundle v1 的**转换层**（与 adapters/sync/market 同级；30 个来源 =
              6 个配置类 + 24 个会话类，**会话转码一律经 IR 与 kernel.collectSessionSections**；
              2026-10-06 起配置类里的 claude-code / hermes / antigravity / cursor / codex 也会读会话
              （copilot 只有位置、无格式取证 → 未实现，见 docs/spec/known-gaps.md §6）；
              纯翻译 + 读盘 + bundle 产出，凭据值绝不进包，
              见 docs/design/2026-10-04-foreign-import-v1.md）
src/schema/   类型/Manifest/版本(CURRENT_SCHEMA_VERSION=1)
src/security/  secret-scanner/redaction/zip-security/integrity/encryption(scrypt+AES-256-GCM)
src/adapters/  13适配器(settings/ui/providers/plugins/mcp/prompts/skills/agentPresets/agentInstructions/workspaces/credentialsStatus/pluginFiles/self；includeSessions:true 时 +sessions=14)
src/sync/      SyncEngine+Git/WebDav+AutoSyncScheduler+config/state/history/sync-selection
src/market/    GitMarketReader+index-parser+security校验+builtin；github-repos.ts+my-repo.ts+git-file-writer.ts
src/migrations/ schema迁移链(registry+v1→v2占位)
src/profiles/  档案=DSH自带profile：dsh-profile-shared(零依赖类型/常量/纯函数)+dsh-profile-manager(列表/详情/新建/重命名/复制/物理删)+process-control(存活/优雅→强杀)+dsh-profile-launcher(独立实例：spawn/挑端口/抓认证URL/探活/停止/台账)+dsh-profile-runtime(心跳：谁在跑/停别的实例)+dsh-profile-io(**宿主专用**：readTextSafe/sanitizeFilePart，走 node:fs —— 绝不能被浏览器半 import，所以不放进零依赖的 dsh-profile-shared)
src/ui/        框架无关UI逻辑(纯函数/控制器，无React，node可测)  ← 业务逻辑必须在此
src/utils/     paths/zip/hashing/json/logger/atomic-write/env-lock/recursive-walk（跟随 junction 的递归遍历内核，issue #37）
              +guards（零依赖纯判定 isRecord/isENOENT，两端都可 import）+git-quote（git config 值转义）
src/client/    React壳(浏览器半)  ← 只做装配
tests/ 集成测试(node --test)；docs/README.md 文档索引；docs/design/ 设计文档；docs/spec/ 对外契约(格式规格/schema/兼容矩阵/已知缺口)；
              docs/seo/ 曝光审计；docs/handoff/ 阶段交接(历史归档，非当前状态)；其余文档一律进 docs/，根目录只放对外文档
.dsh/skills/  项目级 skill（DSH 启动即自动发现、进会话的 skill 目录）：changelog-writing = CHANGELOG 的落位/体例/发版门禁；**写或改 CHANGELOG.md 前先按它落位并跑自检**
```

### UI 分层铁律
1. **逻辑放 `src/ui/`**（纯函数/控制器）——禁止在 React 组件里写可测试业务逻辑。
2. **React 壳只装配**（`src/client/` 只渲染+交互状态，模型来自 `src/ui/`）。
- 页面落位、共享原语、状态中枢、文案字典的完整清单：见 `DEVELOPERS.md` §「从 AGENTS.md 下移的细则」。

## 🔢 版本三处必须同步（最易漏）
`package.json.version` ≡ `src/index.ts` 的 `PLUGIN_VERSION`(约L124) ≡ `package-lock.json` 根对象 version(L3) 与 `packages[""].version`(L9)。bump 后跑 `npm run typecheck` 确认。
**自动化断言**：`tests/packaging-contract.test.ts` 的 `V-1` 四条（源码级正则读 `PLUGIN_VERSION`，不 import 宿主入口）——任一处漏改即 `npm test` 红灯。

## 🚀 发布（打 tag 全自动）
**发版前两道门禁**（漏了 CI 直接 fail）：① 上述三处 version 同步；② `CHANGELOG.md` 顶部加当前版本双语亮点段。
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
- **磁盘占用体检与手动清理的硬边界**（m-disk-usage，2026-09）：备份页的「磁盘占用」卡走 `GET /disk-usage`（**只读**：`src/core/disk-usage.ts` 递归统计、不跟随符号链接/junction、读不到的子区标 `unreadable` 而不是 0）
  与 `POST /disk-usage/cleanup`（写操作，过 mutation gate）。四条不得放宽：① **候选集只有可重建区**（`tmp` / `market/cache` / `market/work`）**与显式勾选的过期导出产物**；
  `snapshots`（导入前快照）与 `sync`（同步配置/历史/Git 工作副本）**永远进不了候选集**；② 请求里的 `categories` 是**分区白名单**（`cleanupCaches` 的 `sections`）——
  用户没勾 `expired-exports` 时**一个导出文件都不碰**（即使有过期项；守卫 = `tests/route/disk-usage-routes.test.ts`）；
  ③ 手动清理对可重建区忽略保留期（`includeRecent: true`，与自动清理的保留期语义并存但分开），导出产物**永远只按保留期**，绝不「立即清空」；
  ④ 界面数字（合计/可回收/按钮）一律由**渲染出的行现算**（`src/ui/disk-usage-view.ts`），不用接口聚合字段 —— 避免「按钮说能释放 600 B、实际 0」。⑤ **清理时「缺失的可选目录」（ENOENT）不计入 errors**（新装机器上 `market/cache` / `market/work` / `exports` 本来就不存在；其它 errno 仍计）—— 否则前端会把「本来就没有」误报成红色「清理失败 N 项」。
- **ZIP 视为不可信**：条目数上限、checksum、Zip Slip 拒绝（`src/security/zip-security.ts`）。
- **导入前强制快照**（可回滚）、Dry Run 零写入、冲突不默认覆盖。
- **加密备份 / 导出**：密码仅内存传入，不落盘/不落日志；解密明文 ZIP 为临时文件用完即清。
- **同步通道的加密/解密密码**（唯一例外，product requirement）：用户不勾选加密就删除、不留空；勾选后保存到 DSH credentials 的独立槽位（`syncPasswordRef('ENCRYPT'|'DECRYPT', 通道)` → `DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_<GIT|WEBDAV>` / `..._DECRYPT_...`），由 `POST /sync/selection` 写/删、`GET /sync/status` 只回 `configured` 布尔。**值绝不写入 sync-*.json / 响应 / 日志 / 直出浏览器**；请求体里的密码优先于已存密码，删除优先于写入。
- 同步凭据走 DSH credentials 槽位引用（`SYNC_CREDENTIAL_REF` 等），`passwordConfigured` 仅布尔标记。
- **同步分区目录含显式可选项（issue #78 起是「逐分区放行」而不是布尔）**：`syncSectionCatalog` = portable + `OPT_IN_SYNC_SECTIONS`（**注册表派生** = `SectionMeta.syncOptIn !== 'off'`，当前 `mcp` / `sessions`）。可选分区**永不默认进入同步通道**，放行只看引擎构造期的 `optInSections: readonly SectionId[]`（`pullSectionIds()` 决定远端快照里哪些分区进临时 ZIP；`pushTargets()` 决定哪些能上榜）——**绝不用布尔**：布尔会退化成「勾了 mcp 连带放行 sessions」（`sync-engine.test.ts` 有推/拉两条回归）。宿主按驱动方决定传什么：**手动** push/pull / 一键同步传「持久化选择 ∩ OPT_IN_SYNC_SECTIONS」，**自动同步**与 model-tools 只传 `'auto'` 档（`AUTO_SYNC_OPT_IN_SECTIONS`，当前 = mcp）—— sessions（`'manual'`）绝不悄悄上行/下行。`opts.sessions = { limit }` 只是 sessions 的**导出参数**（带哪几个对话），不再兼任开关。
- **同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地；对外格式见 `docs/spec/sync-channel-v1.md`）**：
  ① **远端保留接 GFS**：`SyncEngineOptions.retentionPolicy`（宿主注入 `readBackupSchedule().retention`）驱动 `pruneRemoteSnapshots`，与本地备份产物/本地快照共用同一份 `RetentionPolicy`。缺省 `DEFAULT_RETENTION_POLICY`（keepLast=10）走 core 的 `selectPruneCandidates` 快速路径 → 与旧硬编码 `MAX_REMOTE_SNAPSHOTS` **逐字等价**；**刚 push 的快照恒保留**（三层全关时也不删它）。此前「会话寿命 = 最近 10 次 push」由此消除。
  ② **跨机重定基贯通同步链路**：push 把 `ctx.homeDir` 写进 `snapshot.manifest.sourceHome`，`snapshotToZip` 透传进临时 ZIP → Importer 的 `rebaseMapping` 生成「源机 home → 本机 home」；`merge()` 额外**备忘**远端 sourceHome（`lastMergedRemoteSourceHome`）供 `applyMergePlan` 写入临时 ZIP 的 manifest（否则一键同步/自动同步路径永远不重定基）。`SyncPullOptions.pathMappings` 与路由 `extractPathMappings` 承载**用户映射**，排在自动规则之后。**缺 sourceHome 的旧快照不猜**（行为与改造前一致）。
  ③ **逐会话点名**：`sync-selection.json` 的 `sessionsInclude`（非空时**优先于** `sessionsLimit`；空 = 回到「最新 N 个」）。引擎用 `sessionExportOptions` 保证「显式勾选 > 数量上限」——adapter 里 `restrictUnits` 先于 `includeItems` 执行，两者叠加是**交集**（会退化成「最新 N 个里我勾中的那几个」），所以 include 非空时**不施加数量限制**。UI 复用导出侧的 `ContentPicker`（`SyncSectionPickerDialog` 内切换视图，**不嵌套第二个 Modal**），清单来自 `/export-preview`（`SyncApi.exportPreview`），勾选模型在 `ui/sync-settings-view.ts`（`initialSessionPicks`/`sessionPickerSelection`/`pickedSessionIds`）——组件里不得再实现「sessions 显式放行」判定（t42 守卫会红；判定走 `needsSessionInventory`）。
  ④ **内容寻址 blob 仓**（`src/sync/blob-store.ts`）：`sessions` 在**通道侧**外置为 `blobs/<sha256>` + 引用形态（散文件 `<section>.blobs.json` / WebDAV 载荷 `blobRefs`），**只有 transport 传了 BlobSink 才启用**（引擎/导出/导入看到的仍是普通 FilesSection）。命中已有哈希 = 零传输。**读回缺 blob 必须硬失败**（绝不降级为空分区）；**加密快照永不外置**；`sectionHashes` 一律按明文分区算（拉取侧不解仓也能比较变更）。GC：保护窗 10 分钟 + 「任一引用文件读不出来就放弃本轮」。这两条线**不做协议协商**（旧版读新版会把 sessions 当缺失分区）→ 登记为 `known-gaps.md` **G-19**。
  ⑤ **会话删除墓碑**（`src/sync/session-tombstones.ts`）：push 时「`sync-state.sessionUnits`（上次实际带走）− `adapter.listAllUnitIds(ctx)`（本机现存全量）」= 本次新删，累积成 `manifest.deletedSessions` 随每份快照传播（上限 5000；本机又出现实体则**撤销**墓碑）。**三情形一律不动既有记录**：本次没推 sessions / 适配器不支持全量枚举 / 本机枚举为空或失败（把「读不到」当「全删」会一次性标错几百条）。pull/preview/merge 按墓碑把命中的会话单元从**将要导入的载荷**里剔除（整目录，`relativePath` 前两段），**不删除本机数据**（删除是不可回滚的用户动作）→ 登记为 **G-20**。剔除必须可见（`sync.sessionsTombstoned` / `sync.sessionDeletionsRecorded`，绝不静默）。
- **sessionStorage 白名单**：`run-store.ts` `toPersistedState()` 解构剔除 `password/passwordConfirm/secretInputs/decryptPassword/decryptRefs/archiveUnlocked/conflictCollector`；新敏感字段不显式放行即不落盘。

## 🏗️ 架构心智
- 双面插件：host `src/index.ts`（Cordis `name='config-manager'`，`/api/dsh-config-manager/*`）+ web `src/client/`（React，settings.section，经 api 调 host）。
- **宿主路由只经 `src/routes/kit.ts` 的 `endpoint()` 声明**（W1，host-entry#F-02/F-03/F-05）：围栏（loopback + 同源）与方法白名单由 kit 在**注册点**统一包装（`registerRoutes()` 兜底断言「未经 kit 的路由直接抛错」），**禁止**再写逐路由的 `guard`/裸 `isLoopbackRequest` 样板；新增一条 API 只改一处（组文件里那一条 `endpoint({ path, methods }, handler)`）。路由源 = `src/index.ts`（被源码级窗口守卫钉住的 7 条）+ `src/routes/*.ts`（其余 71 条；合计 **78** 条，见 parity 快照）——**源码级守卫必须扫全部路由源**（见 `tests/route/route-fence.test.ts`、`route-parity.test.ts`、`route-channel-guard.test.ts`），只扫 index.ts 会静默失去覆盖。
- **宿主路由只能经 `src/routes/kit.ts` 的 `registerRoutes()` 注册**（W1，约定级防线）：全仓唯一调用点是 `src/index.ts`（也是唯一 webServer 消费点），它逐条断言路由出自 `endpoint()`；**绕过它直接 `webServer.register(...)` 的旁路当前不存在，但未来新增第二个注册点会静默失去围栏覆盖**（route-fence 只覆盖现有注册路径）。新增注册路径时必须同时接上 `registerRoutes`，或补一条同等的结构守卫。
- **插件 HTTP API 的真实认证边界 = kit 的围栏，不是 DSH 的 cookie**（W2；证据见 known-pitfalls）：DSH 的 browser-session cookie 拒绝只挂在 **`kind:'prefix'`、`path:'/api'` 的 RPC 承载路由**上（源码行号见 `docs/known-pitfalls.md`「t93 容量腾挪」§1），而 host-webserver 的派发顺序是 **exact 表先命中**。本插件 78 条路由（口径见 parity 快照）都命中 exact 或更长的私有 prefix，**永不进入** DSH 的 `/api` 认证路由——实测打点见 `docs/known-pitfalls.md`「t93 容量腾挪」§1。**影响面**：本机任意非浏览器进程（含本机其它本地用户）**无 token/cookie 即可调用全部 78 条路由**（含破坏性路由，清单见 known-pitfalls）；**远程/LAN 来源**被 kit 的 `remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}` 判定挡掉，**浏览器跨站 CSRF** 被同源/Host 围栏挡掉——**围栏确实在生效，不得把这条写成「插件 API 无认证」**。两个不得误解的推论：① **不得把 DSH 会话认证当作插件 API 的兜底**——认证挂在通用 prefix 路由 `/api` 上 + exact 优先的派发顺序是**平台级性质**，任何在 `/api` 下注册 exact 路由的 DSH 插件同理；插件 API 的边界只能是 kit 的 `endpoint()` 围栏。② 若将来要在**共享机器**或**经本机代理/隧道转发**（非回环来源、`trustedHosts`/LAN 绑定）的场景暴露插件 API，**必须**在 kit 里自行对接认证（方向：在 `endpoint()` 注册点统一加一道校验，勿逐路由散写），届时应重新评级本条的残余风险。**复核路径**见 `docs/known-pitfalls.md`「t93 容量腾挪」§1（含 DSH 源码位置与 `outputs/e2e-w2/run-e2e.ps1 -Strict`）。
- `src/core/` 与 DSH 解耦：`ConfigAdapter`/`HostContext`+内存 mock；**新功能优先加 core，适配器/UI 薄壳**。
- 13 adapter 见结构；`self`=插件自身配置（`$DSH_HOME/dsh-config-manager/` 下 `sync-*.json`/`market-config.json`/`ui-prefs.json` 白名单收，portable 默认包含；`dataDir` 在 `~/.dsh` 外不挂载）。
- 同步：`SyncEngine`+`Git/WebDavTransport`+`AutoSyncScheduler`(事件驱动,远端新快照才拉/本地改动才推)+`sync-selection`；**autosync 与 sync-selection 按通道(git/webdav)独立**(schema v2，v1→git)，调度器双通道各自排期。
- **import 一律带 `.ts` 后缀**(Deno-style，勿写无后缀)。
- 设计决策看 `docs/design/`（上游依据，实现规格在下游）。
- **对外契约看 `docs/spec/`**：与 `docs/design/` 性质不同——`design/` 是**上游设计依据**（写给本仓库），`spec/` 是**对外契约**（写给第三方实现者，应能在不读 `src/` 的前提下据此实现兼容的 exporter/importer）。含：`bundle-format-v1.md`（格式规格）、`bundle-manifest.schema.json`（机器可校验）、`compat-matrix.md`（DSH 兼容区间与升级风险）、`headless-consumption.md`（无 UI 栈消费引擎）、`sync-channel-v1.md`（**同步通道**快照格式：远端布局 / 内容寻址外置 / 删除墓碑）、`known-gaps.md`（已知缺口登记）。**改格式行为必须同步 `spec/`，并重跑 `tests/conformance/`。**
- **client bundle 自包含护栏**：`src/utils/bundle-scan.ts`（零依赖扫描内核，**多趟并集**避免注释内反引号导致的状态失衡假阴性）+ `src/client/bundle-selfcontained.test.ts`（产物护栏，白名单仅 react/react-dom/react-dom/client/react/jsx-runtime）。**必须 Build 之后单独跑**——`npm test` 在 Build 前执行，此时 `lib/client.js` 不存在，测试会跳过；故 `ci.yml`/`publish.yml` 各有一独立步骤。注释里的同名字符串会造成假阳性（本仓库实测过）。
- **只读预览与导出必须同口径**（2026-09）：`/export-preview` 走 `ConfigAdapter.preview?()`（文件类分区由 `FileCollectionAdapter` 实现），它只把「读文件内容 + SHA-256」换成 `ctx.fs.statSize`，**单元分组 / 条目白名单 / 单分区字节闸门 / 告警生成逐字共用**同一个内核（`file-collection.ts` 的 `collect(ctx, options, mode)`）。为什么必须共用：预览是用户勾选的唯一依据，一旦与真实导出分叉，用户会按预览勾选却拿到别的包（`file-collection.test.ts` 断言两者逐项相等）。**`preview()` 产出的 `FilesSection` 是无内容形态**（`data` 长度 0 / `contentHash` 空串），只在内存里流转，**不得**交给 exporter/importer/快照；**收集面靠覆写 `export()` 收窄的分区必须改成覆写 `listRelPaths()`**（覆写 `export()` 不参与预览，否则预览落到基类目录递归；量化数据见 known-pitfalls）。
- **已验证归档跨请求缓存**（`src/core/analyzer.ts` 的 `verifiedBundles`，2026-09）：宿主 `makeImporter()` **每请求新建** Importer/Analyzer，实例级 `bundleCache` 跨请求恒不命中，于是 analyze→plan→execute（每改一次决策还会再 plan）会把同一个 ZIP 读入 + 全量解压 + 逐条 SHA-256 校验 3~4 次。三条硬边界：① 缓存键 = **路径 + 文件大小 + mtimeMs**（stat 失败即不缓存）；② **只有只读入口**（`analyzeImport` / `createImportPlan`）读它，`executeImportPlan` 一律 `refresh` —— 每次都重新读盘 + 重新校验，关掉「校验后、写盘前被换掉」的 TOCTOU 窗口（`src/core/analyzer-cache.test.ts` 用「plan 后篡改归档 → execute 必须被完整性校验拦下」钉住）；③ 只缓存 ≤ 64 MiB 的归档，条目上限 2 + TTL 120 s。配套：逐条完整性校验改走 `ZipArchive.readEntryAsync`（`inflateRaw` 走 libuv 线程池），不再用 `inflateRawSync` 阻塞事件循环（实测见 known-pitfalls）。
- **`readSessionMeta` 有 mtime 失效的进程内缓存**（量化数据见 known-pitfalls）：键 = homeDir + 两个 storage 文件的 mtime，**任一读不到 mtime 就不缓存**（宁可多读，不可拿陈旧索引猜会话归属）；测试用 `clearSessionMetaCache()` 隔离。
- **插件版本更新检查与自更新（m-update-check，2026-09；自更新 2026-10）**：`GET /api/dsh-config-manager/update-check`（`src/routes/prefs.ts`）→
  `core/update-check.ts` 的 `UpdateChecker` **只读**探测 npm latest：**检查本身绝不自动安装**；进程内缓存 10 分钟
  （`?force=1` 才绕过）；失败（网络/超时/非 2xx/畸形/超限）一律 `ok:false` + 原因且 **HTTP 仍 200**（离线不是插件故障）。
  用户显式点「立即更新」后走**同组另一条** `POST /update-apply` → `core/self-update.ts`（纯 `planSelfUpdate` + 注入 runner 的 `runSelfUpdate`）：
  **钉住精确版本** `dsh-config-manager@<latest>`、过 mutation gate（SAFE MODE + 环境锁，**不 journal**）、
  `link:`/`file:`/`git:` 等非 registry 安装与 `desktop`/未知档案一律带码拒绝（客户端映射本地化文案）；
  成功只保证文件已换新 —— **必须重启 DSH 才生效**，界面只提示、**绝不自动重启**。详见 `DEVELOPERS.md`。
- **兼容性评分必须能解释自己（2026-09）**：`validator.compatibilityReasons()` 是**单一事实源**（`computeCompatibility` 由它派生），
  `ImportAnalysis` 回传 `compatibilityReasons` + `source`/`target`（可选字段）。两条不得放宽：**评分口径已冻结**
  （`sourceOlder` 仍覆盖跨平台 `partial`，改它要单独决策）；界面只做「原因 → 字典键」映射，**禁止渲染裸枚举**。
  详见 `DEVELOPERS.md`。
- DI 走 Cordis fiber：client 经 `ctx.slots.inject('settings.section')`+`inject:()=>({api,syncApi,...})`；host 可选服务 `ctx.get()` 惰取。

## 🛠️ 开发规范

### TS/命名
- **import type**（`verbatimModuleSyntax` 强制）；类型合并用 `declare module`+`import type{}`。
- React：函数组件+hooks，无 class/高阶组件；props 显式 `XxxProps`；导出类型汇总于 `src/client/index.ts`。
- 命名：组件/类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，CSS 类名 camelCase。
- 分号暂未统一——跟随所在文件风格，勿同一次 diff 混改。

### 状态管理
- 状态归属：高频可恢复流程（Export/Import）进 `run-store.ts`（切 tab 不丢/刷新恢复）；低频面板进切片（**进行中操作也算状态** —— 组件 `useState` 里的 loading 一卸载就归零，切页签回来按钮变回「启动」是用户报过的 bug；档案面板即 `PanelState = ProfilesStoreSlice` + `useSyncExternalStore` 订阅读取，见 `DEVELOPERS.md`）；凭据只存内存并被 `toPersistedState` 白名单剔除。细则见 `DEVELOPERS.md`。

### 数据访问/错误
- 一律走类型化 api 类(`ConfigManagerApi/SyncApi/MarketApi`)，实现 `src/ui/types.ts` port 契约；**组件禁止直接 fetch**。
- 错误链：`toActionableError()` → `ErrorBanner`；**展示文本渲染前过 `redact()`**。
- 进行中任务 `runStore.watchRunning(kind,500)` 轮询真实进度；定时器卸载清理+防重。

### i18n
- i18n：**禁止硬编码用户可见字符串**；文案进字典，`src/ui/` 走 `UiT`（活翻译器 `liveUiT` / `makeLiveUiT`），React 壳走 `t()`（`ConfigManagerKey` 编译校验，zh 源 / en 镜像），宿主 / 引擎走 `engineMsg`（`src/core/engine-locale.ts`：活语言 + 各域目录经 `registerMessageCatalog` 并入）。**语言在「取文案那一刻」解析**，不得在装配期快照（`makeUiT(...)` / `makeMsg(...)` 出现在 `apply()` 里即缺陷）。
- **新增用户可见文案必须进目录**：zh 逐字保留、en 补齐；既有键的 zh/en 指纹冻结在 `src/core/engine-locale.test.ts`（只许追加，改既有键即红）。**静态守卫**：全量 `node --test tests/i18n-hardcoded-guard.test.ts`（退出码 0 = 全仓零命中）；作用域自检 `$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'; node --test tests/i18n-hardcoded-guard.test.ts`（只收窄文件列表，退出码 0 = 本作用域零命中）。扫描集 = `src/**`（−`src/cli/**` −`*.test.ts` −`fixtures/**`）+ `locale/*.json`；注释 / `log.*`·`console.*` 实参 / 目录 zh 区豁免；白名单 4 条 128 命中（已登记的非渲染匹配文本，**新增豁免只能走 captain** → `tests/helpers/i18n-scan.ts`）。
- **7 套字典的对照表与「查不到 key 不等于缺陷」的排查姿势见 `DEVELOPERS.md`——那一段极易误判，漏读会产出 600+ 假阳性。**

### 测试
- `node:test`+`node:assert`(零依赖)，同文件 `*.test.ts` 同目录。
- `src/ui/` 纯函数与 `src/core/` 引擎必须有单测；React 无组件框架，逻辑提炼到 `src/ui/` 保证可测。
- 新功能必带测试，加密/同步/安全类尤其（样板：`src/security/security.test.ts`、`src/sync/sync-engine.test.ts`）。

## 🧪 命令
```bash
npm install --legacy-peer-deps   # 必须带：部分 DSH 核心只在 peerDependencies
npm run typecheck                # tsc --noEmit（根 config，只覆盖 src/**）
npm run typecheck:tests          # tsc -p tsconfig.tests.json（把 tests/** 一起纳入；CI 已接）
npm run build                    # tsc(host lib/) + tsdown(client lib/client.js)
npm test                         # node --test src/**/*.test.ts tests/**/*.test.ts
npm run smoke                    # 仅 core 冒烟
npm run bundle                   # 仅重建 client bundle
```
- 无 lint/format 脚本，只以 typecheck 兜底（历史 `eslint-disable` 是遗留）。
- **CI 是平台矩阵**（2026-09）：`.github/workflows/ci.yml` 的 `verify` 在 **ubuntu + windows + macOS** 跑同一套阶梯
  （`fail-fast: false`；pack 步骤显式 `shell: bash` —— PowerShell 的 `mkdir` 没有 `-p`）——全仓 32 处
  非测试 `process.platform` 分支此前只被 ubuntu 覆盖。**macOS 是观察期**（`experimental: true` +
  job 级 `continue-on-error`）：连续 1~2 次绿灯后删掉那一行即变硬门禁（不做长期「允许失败」）。详见 `DEVELOPERS.md`。
- **`tests/**` 的类型检查是独立一条命令**（`tsconfig.tests.json`）：根 config 只 include `src/**`，历史上 228 个测试文件长期在类型检查之外（实测曾积压 43 条错误，已修完并接进 CI）。改动测试后请跑 `npm run typecheck:tests`。
- CSS Modules 由 tsdown+lightningcss 编译为内联注入，单文件 `lib/client.js` 自带样式；**新增样式只能在 `config-manager.module.css`**。

## 🎨 UI / DESIGN SYSTEM（最高优先级）
> **`DESIGN.md` 是 UI/样式决策唯一权威**。涉及 UI/Layout/CSS/颜色/字体/间距/图标/动效/响应式/视觉状态前必读。

**硬性规则：**
1. **颜色三层单向依赖**（v3）：组件只写 `--cm-*`（`.section` 的 §1 TOKENS 块），`--dsw-*` 只允许出现在 `--cm-*` 定义行；禁止 hardcode，tint 用 `color-mix(in srgb, var(--cm-*) <pct>%, transparent)`；四态/主色直写 `--dsw-alias-state-*` 被 `css-token-guard.test.ts` 拦下。
2. 样式只能进 `src/client/config-manager.module.css`；禁止新增 css/内联 `<style>`/第三方 css；类名用 CSS Modules 引用(`css.xxx`)，**勿写字符串 class**。
   **scale 有源级守卫**（v3）：字号 4 档 / 间距 9 档 / 圆角 4 档 / 行高 2 档 / z-index 走 `--cm-z-*`，越界红（`css-scale-guard.test.ts`）；新档位先改 DESIGN.md §3–§5。
3. 复用 `src/client/common/ui.tsx` 原语 + Common 的 `ErrorBanner/ErrorList/ProgressBar/ReportView`；已有公共组件能解决禁止重建，新页面先搜库。
4. **默认不引入第二套视觉体系**(Tailwind/CSS-in-JS/Sass/UI库/图标库/动画库)。**图标 = `lucide-react`**（`common/Icon.tsx`，深路径导入 + `lucide-icons.d.ts` 兜底）；**形变仅 `ExpandChevron` / `CopyStateIcon`**（`morphicons`，只在「状态确实变化」处用；硬约定 `reducedMotion="user"` / `spring={MORPH_SPRING}`（临界阻尼 k=420，≈1.6 倍速），见 `DESIGN.md §6`，**不得扩大范围**）。确需追加第三方 UI 库时，按 `DEVELOPERS.md` 的「第三方 UI 库准入」7 步流程评估后落地。
5. 按钮语义：`variant="primary"`(主操作)/默认 ghost(次)/`variant="danger"`(危险如恢复/回滚)；勿用 primary 做危险操作。
6. 徽章：`Badge kind="ok|info|warn|error"` 与 `Banner` 四态一一对应；先想语义再选 kind。
7. 文案走 i18n 字典；展示文本渲染前进 `redact()`。
8. 长列表/大报告限高内滚(`planScroll/reportScroll/confirmScroll/pullScroll/diffScroll`)，禁止撑长整页。
9. **页落位（v3）**：`home`/`library`/`sync`/`environment` 四页；**市场不是页面**（Task 承载，入口=产物库底栏+⌘K）；容器判据与旧值映射见 DESIGN.md §1；**加页面/改 id 必须同改 `parsePersistedState` 映射与 `run-store.test.ts` 迁移用例**。

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
- 不为小功能随意加 UI/CSS/Icon/Animation/Utility 库；**也不要引入已准入库的同类替代品**（图标 = lucide-react；图标形变 = morphicons + vanilla lucide；弹窗 = Radix Dialog）。
- 加依赖前确认现有方案无合适选择，评估发布限制；新增后同步更新 `package.json`+`package-lock.json`（两处+根对象）。

## ✅ Verification
```bash
npm run typecheck   # 所有改动
npm test            # 动逻辑/纯函数/引擎/适配器
npm run build       # 动 client/样式
npm run smoke       # 大改动
```

> **本机环境注意**：`npm run build` 需先把 `TEMP`/`TMP` 指向工作区内（`.tmp/buildtmp`）否则 dts 阶段 `Access is denied` 致 build=1；`npm test` 必须用系统 TEMP（`foreign/qoder.test.ts` 用 `os.tmpdir()`）。
UI 自查：DESIGN.md 一致(token/组件/spacing/radius/状态语义)、响应式、Hover/Focus/Disabled/Loading/Empty/Error 齐全、Dark Mode 无 hardcode、未建重复组件、新样式进 css+DESIGN.md、新文案进 locale(zh/en)、敏感字段未落 storage/日志/回显。

## 📚 文档同步
| 代码变化 | 更新 |
|---|---|
| 新 Design Pattern/Shared Component/Token/主题/新页面 | `DESIGN.md` |
| 新目录约定/架构Pattern/开发规范/脚本/CI | `AGENTS.md` |
| 新增/修订常见坑（铁律或细节） | `AGENTS.md` §📌 常见坑 **和** `docs/known-pitfalls.md`（两处同步） |
| 新增/调整 CHANGELOG 体例或分组约定 | `CHANGELOG.md` 头部「条目落位」**和** `.dsh/skills/changelog-writing/SKILL.md`（两处同步） |
| **用户可见的功能 / 行为 / 修复**（含 UI 体验与文案诚实性） | **同轮**写进 `CHANGELOG.md` 的 `## [Unreleased]` 对应分组（按 `changelog-writing` skill 落位并跑 §4 自检）—— 漏写实测过：M2 的四个 UI 修复只提交了代码与守卫，条目是事后补的 |
代码与文档同步；冲突时以代码为准修正文档。

## 📌 常见坑
> 下面只留**铁律/硬约束**；每条的真机证据、量化数据、复现路径与复核脚本见 `docs/known-pitfalls.md`（同序）。

- **CLI 与救急台必须同一道写入门，且「机器可读字段」必须与退出码同源**（2026-10-08 UX 审查）：`dcm restore` 此前只过 SAFE MODE + 环境锁，而救急台传 `checkWriteGates(..., { needsDshStopped: true })` —— 同一个动作在浏览器里被拒、在终端能覆盖 `$DSH_HOME`；现在 CLI 补第三道门（SAFE MODE → 环境锁 → DSH 未运行），`--dry-run` 仍只打印计划。同族三条：① `sessions doctor --json` 的 `ok` 必须 `blocking === 0`（恒 true 会让 CI 把「阻断启动 N 条」读成健康）；② `sessions repair` 在会话根读不出来时必须 exit 1 并说「读不到 ≠ 没有会话」（绝不打印「无需修复」）；③ 救急台 404/405/错误页的「可用页面」清单必须从 `page.ts` 的导航表**派生**（三份硬编码互不一致，还把 JSON 端点 `/healthz` 当页面推荐）。护栏：`src/cli/index-guards.test.ts`、`src/cli/sessions-repair.test.ts`、`src/cli/web/console-route-parity.test.ts`。
- **宿主整文件快照的「存在但读不出来」绝不写 `existed:false`**（2026-10-08 UX 审查，数据安全）：`backupHostFiles` 读失败 / 存在性探测失败一律登记 `existed:true` + `unreadable:true`（无 blob），`planRestore` 据此**只跳过并说明、绝不产生 `hostFileRemove`** —— 写成 false 等于「当时不存在」，回滚会删掉用户真实的 settings.yaml。同轮：`prune` 的 recovery 引用集合**读不到即放弃本轮清理**（绝不按空集合继续删），新增 `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`）让放弃/失败可见。护栏：`src/core/backup.test.ts`、`tests/core/restore.test.ts` 的 `R-host-unreadable`；证据见 `docs/known-pitfalls.md`（同序条目）。
- **DSH 没有「默认 / 下次启动 profile」这种状态**：profile 只由启动参数决定（`dsh <名>` / `--profile <名>`；`dsh web` 是硬编码别名）；`$DSH_HOME/cordis.patch.yml` 只是叠加在**当前** profile 的 home 层补丁；曾写的 `<dataDir>/next-profile` 标记已整体移除。切换只有两条路：**另起独立实例**（实现细节见 known-pitfalls）或让用户改自己的启动命令。**当前档案识别（issue #52）**：`config.profile` → `profileContext`（DSH ≥ 0.1.7 `provide('profileContext', { name, dir, … })`）→ `--profile` → `DSH_PROFILE`/`DSH_PROFILE_DIR` → `web`（`src/index.ts` 的 `resolveProfileName` + `src/core/plugin-cli.ts`）；Desktop 外壳**不传 `--profile`**，只认 argv 会把 desktop 认成 web。六条硬约束：ⓐ 只对 web 形态可启动（否则 `notLaunchable` + 终端命令，绝不假装成功）；ⓑ 实例台账 `<dataDir>/launches.json` 是唯一事实（`listRunning` 按 pid 存活过滤并清死记录）；ⓒ 判重靠**心跳** `<dataDir>/running/<profile>.json`（`dsh-profile-runtime.ts`；20s 刷、60s 判死；**绝不写认证 token**），`running` = 台账 ∪ 心跳；别的实例可停（`stopExternal`），**不能停自己**（`currentProfile`）；ⓓ launch / stop **不过 mutation gate**（gate 会占环境锁且 launch 最长等 20s）；ⓔ 失败绝不静默（`launchFailed`/`stopFailed` 附日志尾部或 pid；停止区分 graceful / killed / already-stopped）；ⓕ 进行中态（`launching/stopping/creating/renaming/deleting`）住 `runStore.profiles` 并用 `useSyncExternalStore` 订阅、**不落 sessionStorage**，新增字段必须进 `toProfilesStoreSlice`。改这块前先读 `src/profiles/dsh-profile-launcher.ts` 文件头。
- **`desktop` 是 Electron 独占保留档案**：普通 CLI 对 `--profile desktop` 无条件拒绝（`rejectElectronProfile`），**唯一入口**是桌面端自带的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`（`manageDesktopProfile: true`）→ 载体识别 `src/utils/desktop-carrier.ts`、接线 `core/plugin-cli.ts` 的 `dshArgv(profile)`（补 `ELECTRON_RUN_AS_NODE=1`；认不到则失败分类 `desktop-profile-reserved`）。「当前 DSH 版本」只能从 `profileContext.installAnchor` 取（`resolveDshVersion`），按磁盘猜必错。**启动 / 删除 / 改名一律以 `managedProfile` 拒绝**（`classifyShape` 会把 desktop 判成 web —— 只看形态会误放行启动）。安装失败提示里的 profile 必须与实际安装目标同源（`ctx.target.profile ?? resolveProcessProfileName()`）。
- **复制档案 `POST /profiles/copy`**：① 拷完必须 `relinkCopiedTree`（`promises.cp` 只照抄链接 → 副本指向源档案；**只重指向树内链接**，判链接用 `readdir(withFileTypes).isSymbolicLink()`）；② 整档案拷贝必须走 async fs（cpSync 卡住宿主 25 s）；③ `includeNodeModules=false` 时同时跳过 `node_modules` 与 `.dsh-module-fallback`，缺依赖进回执（`warnings: ['depsNotInstalled']` + `dsh plugin --profile <副本> install`），中途失败回滚目标目录。
- **复制档案的中断残留（cross-F3）：标记先行 + 只认自己的标记**：复制**开始前**先在目标目录写 `.dcm-copy-in-progress.json`（`sourceName/newName/startedAt/includeNodeModules/pid`），成功删标记、**失败回滚整个目标目录**、**进程被强杀则标记留盘**。`/profiles` 以 `incomplete: true` 列出「有标记但无 `package.json`」的目录（`shape='generic'` ⇒ `isLaunchableShape` 恒假、绝不给启动按钮），`POST /profiles/delete` 可直接删。**判据只有我们自己的标记，边界不放宽**：既无 `package.json` 又无标记的目录仍**跳过**、仍 `notFound`、仍删不掉 —— 绝不引入「看着像残留就删」的启发式；修复前已存在的**无标记**孤儿目录与用户手工建的目录在磁盘上不可区分，只能手工删（细节与真机证据见 `docs/known-pitfalls.md`）。
- **pnpm 发布年龄**：`@latest` 装到旧版 = pnpm 11 `minimumReleaseAge`；用精确版本，或 `pnpm-workspace.yaml` 设 `minimumReleaseAge: 0`。
- **MemFs 测试**：内存 fs key 与宿主 path 解耦（win32 home 注入 cwd）。
- **删任何源文件前先 `git status --porcelain <路径>`，看到 `??` 必须停下确认**（2026-10-03 事故：`Remove-Item src/client/snapshots/*.tsx` 删掉两个**从未被 git 跟踪**的在用组件）。存活久的文件尽早提交；整目录清理先 `git add -A <目录>` 纳管再删。还原靠 `lib/client.js` 编译产物切片（`function <Name>(` + `/**` … `//#endregion`），还原后必须核对文案键与 `css.xxx` 并在文件头注明是还原版。
- **绝不用 `git checkout -- <文件>` 回滚本仓库**（2026-10-03 事故：抹掉整批未提交在途工作，`npm run typecheck` 0 → 170 错）。回滚前先 `git diff --stat HEAD -- <文件>`；撤销自己的改动用**针对性 edit 反向操作**；真要整文件回滚先 `cp` 到 `.tmp/`。字典可从 `lib/client.js` 回捞（键 → zh/en 值 → 注入），注意 `\\"` 转义、值内单引号转义、以及 `PaletteTitleKey`/`CompatibilityNoteKey` 这类联合类型键要去类型定义处抄。
- **Windows LF→CRLF 警告**：EOL 已由仓库根 `.gitattributes`（`* text=auto eol=lf`，issue #70，2026-10-05）钉死 —— ubuntu / windows / macOS 三端检出同一份字节；**源码字面量守卫**仍须按既有先例在读取入口折 LF（`readFileSync(src,'utf8').replace(/\r\n/g,'\n')`），否则 CRLF 工作区（老检出 / 编辑器写 CRLF）会假红（内容无差异，`git diff` 为空）。根目录勿提交：`lib/dist/node_modules/outputs/my-video/.vibeskills/.agent-teams` 均已 gitignore；`dist/` 需先创建再 `npm pack --pack-destination ./dist`。
- **client bundle 是 cjs + `window.__ModuleLoader__.load`**（tsdown.config.ts），改 format/入口会破坏加载器；CSS Modules 只认 `.module.css`；**`src/client/` 不 import node 模块**（`PathMappingForm` 刻意做了轻量等价实现）；**style 属性只允许极小修补**（如 MarketPanel `paddingTop:4`），常规布局用 CSS 类。
- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回 `isSymbolicLink()===true`（`isDirectory()` 为 false），自写分支会**静默丢整块内容且备份仍报成功**（issue #37 丢 12 MB）；新文件类 adapter 用 `adapters/link-report.ts` 的 `listFilesDetailed` + `linkWarnings`，别直接调 `ctx.fs.listRecursive`。内核同时**整棵跳过 `node_modules`**（任意深度，issue #76：技能自带依赖会把单个分区顶到上万条目、撞 10000 条目闸门使定时备份永久失败），跳过项经 `RecursiveListing.skippedDepDirs` 进告警（导出报告 / 预览 / 离线 CLI 三处同源），**绝不静默**。
- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**（issue #35）：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`（`Failed to read patch file`）；导入端写入前剔除目标机无法满足的 `patchedDependencies`（`adapters/pnpm-workspace.ts`）并让剔除在计划里可见；市场通道对 `patchFiles` 与 `localTarballs` 同级双端拒收。
- **会话日志的字节改写只允许在宿主侧**（issue #45）：多帧 zstd 容器，改写 cwd 只换第 1 帧 + 尾部流式拷贝 + 发布前自检，**Windows 上 rename 覆盖前必须关闭读句柄**。`src/utils/zstd-frame.ts` 纯字节帧工具；`src/utils/session-log.ts` 是宿主适配器与 CLI 的唯一实现（core 禁止 import）。**头等硬约束**：DSH 校验「日志位置 == `projectKey(header.cwd)/id`」，**改写 header 必须连目录一起归位**，搬不动就回滚（否则 `dsh web` 报 `corrupt session log`，同 id 出现在两个 projectKey 则报 `duplicate JSONL session id`）。索引刷新用 `reindexSessionHeader`（**不要用会清空 sessionPaths 的 `replaceHeaderIndex`**），刷不了如实汇报。**应用内修复（T8）**：`utils/session-repair-service.ts` + `POST /recovery/sessions/{repair,rollback}` 只做**能从字节证明的修复**（有损需显式 `allowLossy`）：三道写入门（unitId 只解析到会话根内 / 无 `session.lock` / 不在 30s 静止期）+ 预览-应用指纹一致 + SAFE MODE 与 mutation lock + 写前自校验 / 时间戳备份 / 原子换入 / 写后复验；**回滚只认台账 `repairId`**（`<dataDir>/session-repairs.json`）。一键修复必须逐条独立、**有损不批量**、结果如实计数。
- **本插件是 bundle 包，隔离实例挂载必须进 `dsh.profile.bundles`**：只往 profile 的 `cordis.patch.yml` 写 `{id, name}` 激活行不会挂载（宿主路由 404、启动日志无报错）。隔离 E2E 配方：`$env:DSH_HOME=<临时 home>` → `dsh --profile cmtest --from-default-profile web --dump-config` → `profiles/cmtest/node_modules/dsh-config-manager` 用 **Junction** 指向本仓库 → 加进 `dsh.profile.bundles` → `dsh --profile cmtest --port 3099 --no-open`。**抓 cookie 只对 DSH 自身路由有意义**；POST 体用 `--data-binary @<file>`（PowerShell `-d '{"x":1}'` 会丢引号）。
- **文件集合分区永不参与导入期前缀映射**（issue #45）：`ConfigAdapter.fileCollection` 分区里 `relativePath` 是**身份**不是配置（命中 `--projectKey--` 会让目标机下次启动失败），`analyzer.applyMappingsToSections` 整段跳过；会话走专用通道（`SessionsAdapter.finalizeApply` 把 `ctx.pathMappings` 应用到**首帧 cwd** 再归位到 `projectKeyOf(映射后 cwd)`，`rewriteLogDir` 只换第 1 帧）。**导出会话必须连带所属工作区**（`exporter.coupleSessionWorkspaces`）：匹配不上就带上全部工作区、读不到就告警、连带白名单与分区选定**共用同一份 includeItems**、四种结果各有报告文案、导入侧对「有会话没工作区」的包在分析阶段告警。宿主半**无热重载**（改导出/导入必须重启 DSH）；`sessionIds` 由 `WorkspacesAdapter.finalizeImport` 在全部分区收尾后逐个 `attachSession` 登记。**选择器联动**：`applySessionWorkspaceCoupling`（方向必须显式传 `focus: 'sessions' | 'workspaces' | 'both'`）；配对两套判据 = 注册表 `sessionIds`（经 `sessionIdKey` 归一化）+ cwd 目录键（`projectKeyOf(path)`），**绝不按会话路径做前缀匹配**。**跨机重定基**：导出写 `manifest.sourceHome`，导入时 `analyzer.rebaseMapping` 插到用户映射之前，只对绝对路径、段边界生效，计划里见 `ImportPlan.automaticMappings`。
- **会话可见性必须由「包内实际带走的会话」驱动**（issue #45 ③）：导出侧 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`）按 cwd 目录键声明进工作区记录；导入侧登记 = 记录声明的 ∪ 包内带数据的，失败按「这次有没有带它的数据」分类；每个 id 先试声明形态再试另一种命名形态（DSH 只认 header 的 `id`）。
- **子代理会话（`origin='subagent'`）不是工作区里的对话，导出必须连带父对话**：`SessionsAdapter.export()` 调 `coupleSessionParents` **只向上补父对话**；向下由界面联动（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，`ContentPicker.commit` 调用）—— **白名单即权威，引擎绝不向下展开**。子会话清单来自 `SessionStoreFacade.parentRelations()`（读 header `parentSession`+`origin`，不读日志字节）；**BFS 的「已排队」与「已展开」必须分成两个集合**；父对话 id 在磁盘 header 叫 `parentSession`、DSH 的 RPC 投影才叫 `parentSessionId`。复核见 known-pitfalls。
- **「历史对话」排序时间有两个来源**：`storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`）+ `SessionsAdapter.unitActivityTimes()` 现算的日志 mtime（`/export-preview` 注入 `applySessionMeta`）；缓存覆盖不全，**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`）。
- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning` 与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35）。
- **备份有两种物理形态，「形态判定」只有一份实现**（issue #55）：加密产物是 **DCA1 整包容器**（AES-256-GCM 包住整份 ZIP），文件名却仍是 `.zip`。① 判定单一事实源 = `src/security/container-kind.ts`（`containerKindOfBytes` / `readContainerKind`）；② **只读前 4 字节**（open+read(4)+close），**读不到一律回落 `'zip'`**（判不出 ≠ 判为加密）；③ 未解锁容器一律 `400 { code: 'encrypted-container' }`（`ENCRYPTED_CONTAINER_CODE`）+ `import.encryptedContainerNeedsUnlock`，客户端据码自动进解锁阶段。**客户端半铁律**：`src/client/**` 只能 import 零依赖的 `utils/shared-constants.ts` 拿码 —— import `security/container-kind.ts` 会把 `node:crypto` 打进 `lib/client.js`，DSH loader 报 missed the module table，**整个插件不加载**。
- **SAFE MODE 的可见性与出口**（issue #56）：`<dataDir>/transactions/safe-mode` 一旦落盘即跨重启生效，**解除判据只有 `recovery-orchestrator` 的 `resolveSafeMode` 一份**（NEEDS_ATTENTION 视为未解决、扫描失败 fail-closed）。四条不得回退：dismiss 之后必须调用它；`GET /recovery/status` 回传 `safeMode: { blocked, clearable }` 并渲染显式解除入口；`POST /recovery/safe-mode/clear` **故意不过 withMutationGate** 但绝不无条件清（有未解决 incident 拒绝 `reason: 'unresolved-incidents'`，本来没阻断幂等回 `not-blocked`）；阻断态与 mutation gate 的 `isBlocked` 同源**动态探测**，绝不创建期捕获。
- **灾备快照线已收敛下线（2026-09）**：watcher / 撤销重做 / 手动快照 / `/lifecycle` 整体删除；只留 `core/crash-report.ts` + `core/boot-rescue.ts`（并入「事故恢复」子 tab），**不再自建第二条恢复通道**。三条不许回退：`boot-state.json` 移到 `<dataDir>/boot-state/`（`adoptLegacyBootState` 幂等搬迁）；`BOOT_CRITICAL_RELS`/`profileCriticalRels` 搬进 `core/boot-paths.ts`（**导入安全闸门 `boot-safety.ts` 仍在用，删灾备不许连带删**）；`PanelId` 去掉 `'lifecycle'` 并在 `run-store` 迁移到 `snapshots` + `subTab='recovery'`。守卫：`src/core/incident-wiring.test.ts` + `tests/route/route-parity.test.ts` + `src/core/crash-report.test.ts`。
- **救援模式与 `reconcileBundles` 的硬冲突**：进救援收窄 `dsh.profile.bundles` 后，插件自己的 `reconcileBundles`（`src/core/plugin-cli.ts`，规则 = 声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`）很快（秒级）就会用 `dependencies` 把用户插件全部加回，救援名存实亡。两条修法**不许拆开**：① `enterRescueMode` 必须同时 `stripDependencies`（退出时整份 `package.json` 逐字节还原）；② 救援激活期间 `reconcileBundles` 一律停手（`isRescueActiveSync`）。验证必须真机四阶段（收窄 → 数秒不被改写 → 重启不挂载 → 退出逐字节还原）；走 patch 层的插件**不要**写进 `dependencies`（否则 `duplicate loader entry id`）。复核见 known-pitfalls。
- **会话日志格式版本跨版本是「单向兼容 + 静默跳过」**（known-gaps **G-23**）：DSH 对非本 build 版本直接拒绝，而 `listArtifacts()` 对该错误 `continue` → 用户只看到「对话消失」。高版本可读低版本，**反向不可读**。接线：`src/utils/session-format.ts` 宿主探针（只解**首帧**、每会话一条、上限 200，常量从 `installAnchor` 同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 semver 猜**）→ `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe` → `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`；档案页用 `profileVersionFacts` / `sessionFormatRisk`。**任一侧读不到版本一律不提示**（不猜）。core 仍禁止 import 会话存储格式。
- **离线救急台（`dsh-config-manager web` / `dcm web`）**：① 服务端复用 `src/routes/kit.ts`（`endpoint()` + `registerRoutes`），页面服务端直出 HTML（零脚本零外链，CSP `default-src 'none'`），因此没有 client bundle 自包含问题；② **token 是这一层的边界**：kit 对无 Origin 头的请求放行，所以必须启动时生成 32 字节随机 token → 只打印到当前终端 → `/?token=…` 换 HttpOnly + SameSite=Strict 会话 cookie（**用过即废**），其余请求一律 403；③ **读路径只读、写路径有门**：GET 打开页面零写入，但**不是只读服务** —— 已有 **11 条 POST 写路由**（清单与行号见 `docs/known-pitfalls.md`「t93 容量腾挪」§2），`GET /healthz` 自报 `readOnly:false` + 由路由声明派生的 `writeRoutes`。真实边界 = 回环围栏（非回环 403）+ 一次性 token→HttpOnly 会话 cookie（**每个请求含写**都要 cookie，缺则 403）+ 方法白名单（405 走 HTML）；写动作各自过 CLI 同源的写入门（SAFE MODE → 残留锁 → DSH 未运行，fail-closed；`/reinstall/*` 另持 `runWithMutationLock`），磁盘清理只碰可重建缓存故不过 SAFE MODE 门、档案启停**刻意不过**那两道门（它正是「DSH 起不来」时的出口）。**绝不等于「插件 API 无认证」**；④ **判定不许重写**（与 CLI 共用 `src/cli/actions.ts`）。两个已修的坑（细节见 `docs/known-pitfalls.md`「t93 容量腾挪」§2）：心跳候选根必须与 SAFE MODE 同一套 `resolveControlRoots`；退出必须真退出（`close().finally(() => process.exit(0))`）。
- **issue #57–#60 四条硬约束**：ⓐ `file:` spec 打包前必须 `stat` 判形态（`src/core/local-plugin-pack.ts` 的 `statKind`：目录走 `npm pack`、`.tgz` 直接读取；判不出来回落目录流程），profile 目录用 `HostContext.profileDir` 不硬拼；ⓑ 同步快照 JSON 体积上限**读写必须同口径**（`deserializeSnapshot` 用 `MAX_OWN_PAYLOAD_JSON_BYTES` 512 MiB，**不是** `parseJsonSafe` 的缺省 64 MiB），读不出来的一律经 `unreadableSnapshots` 回传可见；ⓒ `runStore.patch()` 会清空密码字段，任何无关 patch 之后必须 `runStore.patchSyncPasswords()` 把在途输入写回**内存**；ⓓ git 源安装需要 `scripts.prepare`（本包已补），pnpm 11 仍要 `allowBuilds`（键逐字照抄 pnpm 打印的那行）；门禁在 `tests/packaging-contract.test.ts` 的 `G-21`。
- **`skippedLinks` 的 `too-deep` 不再必然等于「链接」**（cli-F2 + t37）：递归遍历的深度上限对**普通目录**同样生效并留痕；告警措辞按真实原因分派 —— `too-deep` → 「层级超过上限未进备份」，`loop`/`outside-home`/`broken`/`unreadable` 才写「链接未进备份」。看到 `too-deep` 先按「目录太深」排查，不要再当成链接问题（反之亦然：链接措辞只对应后四种）。
- **文件类分区「存在但读不到」必须显式失败，不得静默跳过**（ui-F2，t23）：只有真不存在（ENOENT）才算「按需创建、本来就没有」；EACCES / EBUSY / IO 错误一律上抛成**分区级可见失败**（`export.sectionFailed` + 一条 warning），与基类同口径。判定「不存在」的探测自身失败时按「存在」处理 —— 读不到 ≠ 没有。

- **值形状判定（`matchSecretValuePattern`）的大小写边界**（t58-F1 / t72，known-gaps **G-36**）：**auth-scheme `bearer` 按 RFC 7235 / 6750 大小写不敏感剥离**（规范 `Bearer …` 的命中名 `bearer-token` 与行为逐字不变），但 token 侧刻意更严以防英文散文过剥 —— 需含非字母字符、或大小写混排、或长度 ≥ 24（`bearer credentials are required` 因此**不**命中）。**厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）保持大小写敏感**：`SK-…` / `GHP_…` / `akia…` **不会被剥离**（不是真实厂商形态；判定是全仓共用单一来源，加 `i` 会连带放宽日志 / 导出扫描 / 界面 `redact()` 三条通道）。**别「顺手加 `i`」**（红在 `t72-d`；要收先单独决策并同步本条与 known-pitfalls）。附带两条口径（细则见 `docs/known-pitfalls.md`「t93 容量腾挪」§3）：尖括号占位符在值形状通道同样被剥空；`redactMcpSection` **自身**过滤非字符串载体。**`sk-` 的误剥边界（t83）**：`sk-` 用**载荷形状守卫** `/sk-(?![a-z-]{1,24}(?![A-Za-z0-9_-]))[A-Za-z0-9_-]{8,}/`（`sk-` 后 1–24 个纯小写字母/连字符 = 词形态 → 放行，修 `task-management` / `risk-assessment` 等误剥），**别改回左边界** `(?<![A-Za-z0-9])`（会漏剥 `'p'.repeat(10000)+'sk-…'` 这类真实长串内嵌 ⇒ 明文进包）。另注（**t78 后已订正**）：`redaction.ts` **不再有独立重复表**，`REDACTION_VALUE_PATTERNS` 派生自 `SECRET_VALUE_PATTERNS`；**仍存差异**是显示层比 scanner **更宽**（示例/占位形态 scanner 放行、`redact()` 仍掩）。残余/取舍/守卫见 `docs/known-pitfalls.md` G-36 与「t93 容量腾挪」§3。

- **v0 打包行（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）不得被当成 seq 空洞**（真机 **407/1194** 份被误判为「需要损失性修复」，按该计划会丢 **865,098/876,680 行 = 98.7%**）：打包行**没有 `seq` 成员**，一行按 `seq0` + payload 展开成 N 个事件（官方 `decodePackedRun`：`firstSeq = seq0`、`eventCount = payload.length`）；**连续性判定必须先展开打包跨度**。判据分两层、不得混同：(i) **形状不可判定**（缺 `seq0` / 载荷非数组 / 长度非安全整数 / `dt` 长度 ≠ len-1 / 带严格键集外成员 / 无 `seq0` 的未知非 packed 类型）→ **不透明跨度**，禁止跨越它下连续性/截断结论，计划 **refuse**（不得截断）；(ii) **形状可判定但 `seq0` 与运行计数不衔接** → 这是**真实 seq 空洞**，与标量行空洞**同待遇**（默认 refuse；显式 `allowLossy` 才在首个异常处截断）—— 别把它当 opaque，否则同一种语义会因前一行的物理编码不同而有两种待遇。**帧粒度**：`≤200 行/帧` 只约束**本次重编码**的帧，**未触及帧（帧内无被丢行且全部保留）必须逐字节复用**，即使它原本超过 200 行 —— 真机有 **226 个事件帧 >200 行、最大 8654 行**，那是 DSH 自己写出的形态，**字节保真优先于自定上限**。证据与复核脚本（`.tmp/probe-session-repair.mjs`）见 `docs/known-pitfalls.md` 同序条目。
- **会话检测口径：严重级按「代际 + 载体」分级，且前台读盘管线是分层的**（known-gaps **G-24**）：v4 与 pre-v4 下 —— `user/message.data.id` 缺失、`assistant/message.message.id` 缺失、`tool/result.message.id` 缺失或 `toolCallId` 与 `source.callId` 不一致、空 tool-call id、重复通告同一 advertised tool call —— 都会被**前台读盘管线拒读**（`unloadable`）；**版本读不出时一律降为 `nextRequestFails` 并标注 `codec-uncalibrated`**。**口径层次必须写准**：官方前台管线 = ① `parseHeaderRecord` 的 `createRestore(recovery:'strict', validation:'transformed')`（既解首帧 header，**也被 `readZstdPrefix` / `SessionLogScanner` 用来逐行 `decodeRow`**）② `assertV4RowAdmission` / `assertReleasedV4Relationships` ③ `adoptSessionEvent`（如 `assertMessageEventShape`）④ `Session.fromRestore` + `assertCurrentAssistantStreams`；**只有 ① 的 `decodeRow`/`finish` 那一层**会对「user/assistant 缺 id」「空 tool-call id」放行 —— **不要写成「transformed 容忍」**，那会低估前台确实会拒。三条官方错误文本与出处：`seed user|assistant/message at index N lacks an identified message`（`dsh-session` 的 `assertMessageEventShape`）/ `tool call id requires a nonempty string`（`dsh-session-format-v3-to-v4`）/ `assistant/message repeats advertised tool call`（同包 v4 关系校验器与迁移器）。**不得写成「缺 id 一律整份拒载」，也不得写成「v4 的 user/assistant 缺 id 只是下次请求会失败」。**
- **复核门 `unavailable` ≠ 成功验证**：**操作完成（`ok`）与可加载验证（`verify`）是两件事**。`unavailable` 时结果与台账必须带 `verify.verified=false`、**不得标记为已验证**；`unavailable` **仍写台账**（否则已应用的修复无法回滚）但**不写成功台账、不触发回滚**；**UI（React 面板）、CLI 与离线救急台两侧**都必须把三态（现役可读 / 迁移链可还原 / 未验证）写进**用户可见输出**，不得把「写完了」说成「已可加载」。
- **复验门的 catalog 解析不得只按 root 缓存，等价性用 `equivalentToReadPath` 判定**（known-gaps **G-24**）：`createRestore(strict+transformed)` 只在 `header.version === 当前代际`（本机 v4）时可达；pre-v4 走**迁移链**，**不等价于 DSH 读盘路径**（官方 `resolveCurrentLog`：pre-v4 没有「当前日志」）。任何依赖日志 header 的判定（代际闸门 / API 闸门 / `equivalentToReadPath`）**都必须按该日志的 `headerVersion` 重跑**，否则同进程内同一输入会给出不同结论（实测过等价性翻转 + v4 被误判 `decode-failed` 并回滚）。

- **外部来源合成的会话行必须满足 DSH 的 `assertMessageEventShape`**（`dsh-session/lib/index.js` 的 `adoptSessionEvent`；真机 2026-10-07 事故：导入 Hermes 后 `历史加载失败：… session event at seq 5 message must have model source`）。四条硬形状，改 `src/foreign/session-ir.ts` 的 `synthesizeDshRows` 时**不得回退**：① `assistant/message` 的 `message.source` 必须是 `{kind:'model', provider, model}` 且 **provider/model 都非空**（写 `kind:'assistant'` 直接拒读）；② 该行的 `data.stream` 必须是**数组**（真实日志必有；正文走 `message.content`，所以 `[]` 安全，但**不能省**）；③ assistant 的 `message.content` **必须含 `tool-call` 块**（`id` 与 `tool/call` 事件 callId 同源；`deriveEventMessage` 对空 content 返回 null，只有工具调用的助手消息会整条消失）；④ `tool/result` 的块是 **`{type:'tool-result', toolCallId, isError, content:[…]}`**（连字符 + camelCase），`source.callId` 必须**非空**且与块内 `toolCallId` 逐字相同 —— Anthropic 那套 `tool_result`/`tool_use_id`/`is_error` 会被直接拒读；源侧结果缺 id 时按「最早未决调用」FIFO 回填，无主结果计数丢弃（**绝不产出空 callId**）。护栏：`src/foreign/session-ir.test.ts`（钉形状）+ `claude-sessions-bytes.test.ts`（字节基线，改形状必须写明理由）；复核 = 用 DSH 自己的 `adoptSessionEvent` 逐行跑真机产物（当前 hermes 71 会话 / 29687 行 → 0 拒绝，见 known-pitfalls 同序条目）。

- **外部来源合成的会话要按目标机的版本写，且 `session/title` 必须满足 `assertTitleSources`**（2026-10-08 真机事故：桌面端 0.2.0-rc.2 = **v4**、转码器只认 v3 ⇒ 每条会话 `session-format-unsupported`、包里没有 `sessions` 分区，用户看到「历史对话不见了」）。四条不得回退：① `SUPPORTED_DSH_SESSION_FORMAT_VERSIONS = [3, 4]`，`header.version` 与日志名**按目标机版本**写（反向不可读，**绝不一律写最高版本**；版本读不到仍旧一条都不转）；② 标题行**不能停在 seq 0**：非 user 来源（调用方都给 `{kind:'fallback'}`）的 `messageSeqs` 必须非空、每个 seq **早于**本条、且指向 `source.kind === 'user'` 的 `user/message`（空 ⟺ user 来源）—— 所以标题行插在**首条人类消息之后**并引用它；旧写法（seq 0 + `[]`）会被 **v3→v4 迁移整份拒收**；③ 整场没有人类消息时**不产标题行**（如实 `session-empty`），绝不编指不到人的引用；④ 改形状后必须用**两代真 codec**复跑 `verifySessionLogBytes`（v3 档 = 本机 CLI 档案树、v4 档 = `app.asar` 内 catalog）并要 `verified/strong/equivalentToReadPath` 全 true。见 known-pitfalls 同序条目。

- **`cordis.patch.yml` 是 DSH 的专用 YAML 方言，读写只有一份实现**（issue #75）：DSH 用 `JSON_SCHEMA` 叠加自定义标量标签 `!!js`（`dsh-app-boot` 的 `entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)`，构造 `{__jsExpr: <源码>}`）。三条不得回退：① 载入/写回一律走 `src/utils/patch-yaml.ts`（方言单一事实源，含 `boot-safety` 注入的 `parseYaml` —— 它解析的启动关键 yaml 里就有两层 patch 文件），**别在别处用 `yaml.load` 读 patch 文件** —— 缺省 schema 遇到 `!!js` 直接抛 unknown tag，被 catch 成空数组就是「整层 patch 行从导出/同步/预览里消失」；② `raw` 里的 `{__jsExpr}` 是对外契约（`docs/spec/bundle-format-v1.md`），它是普通 JSON、写回必须还原成 `!!js`，且载入必须用 `JSON_SCHEMA`（`~` 在缺省 Core 下是 null、在 JSON_SCHEMA 下是字符串，DSH 用后者）；③ `applyPatchChanges` 对「存在但解析不了 / 读不到」的原文件**拒绝覆盖**（`host.patchRefuseClobber`），`readPatchLines` 解析失败**上抛**（`host.patchUnreadable`）经 failures 通道变可见告警；**ENOENT 仍是空层**（边界不放宽）。外流摘要一律走 `describePatchYamlError()`（js-yaml 的 message 会附带源码片段，patch 文件里可能内联密钥）。见 known-pitfalls 同序条目。

- **pnpm 隔离安装的「同树布局」有三种，推导只能有一处**（issue #74）：`@deepseek-ai/dsh/package.json` 的候选根反推为 `dirname/../..` 后，先试 hoisted 同级、再试 `dsh/node_modules` 嵌套，**最后**用 `sessionFormatRoots()` 扫最近 `.pnpm` 里的 `@deepseek-ai+dsh-session@*`（前缀末尾的 `@` 必须有，否则 `-projection` 误命中）。三条不得回退：① 多版本共存取与本机 dsh **同版本**者，**版本读不出来或对不上且多候选 → 不猜**（宁可体检跳过，也不谎报格式）；② `session-verify.ts`（复验门的权威版本）与 `dsh-profile-manager` 必须共用这一份实现，**禁止再写第二份布局推导**；③ 解析失败要把**已尝试的路径**写进日志（`resolveSessionFormatVersion(candidates, tried)`）。见 known-pitfalls 同序条目。

- **面板侧的「布局归位 / 重复 id 隔离」是运行时写路径，安全口径与离线 CLI 不同**（M2 的 E 链路，checkpoint `1dc28d8` 宿主 + `807528b` 面板）：入口 = `POST /recovery/sessions/layout`（`/recovery` 前缀端点下的子路由），服务 = `src/utils/session-layout-repair-service.ts`（**禁止 import `src/cli/**`**），规划复用 core 的 `planSessionRepair`。四条不得回退：① `apply!==true` 只读计划、**零写入**；② 逐条门前置 = 无 `session.lock` + 不在 `SESSION_REPAIR_QUIESCENT_MS`（30 s）静止期内；③ **每次移动后必须 `reindexSessionHeader` 成功，失败必须把该条搬回原位并如实报 `rolledBack`**；④ 宿主没提供刷新端口就**一条也不执行**（`reindex-unavailable`）。面板相对 CLI 的**有意差异**（必须写进文案，不能当成实现漂移）：面板在 **DSH 运行时**执行（CLI 要求先停 DSH）、不暴露路径映射 ⇒ `rewrite` 恒缺席、**只搬目录不改写首帧**；另加两道 CLI 没有的护栏 —— 重复 id 未点名 keep **拒绝执行**（CLI 只是跳过）、keep 必须指向**已扫描副本**（否则 `keep-not-a-candidate`；CLI 把 `--keep` 指错路径会隔离**所有**副本）。隔离目录与 CLI 同名同形 `.cm-repair-quarantine-<stamp>/<fromProjectKey>/<sessionId>`，响应与文案**零绝对路径**。护栏：`tests/route/session-layout-routes.test.ts` + 服务单测 + 独立探针（`.tmp/m2/e3/probe.mjs`，21 断言）。
- **「两侧诚实」是硬要求：UI 文案的每一句都要能被代码逐条证明**（M2 的 A/C 链路）：① 面板说明与救急台页面文案里的每个能力主张都必须有对应代码事实（严重级档位 ↔ `sessions.severity.*`、应用内可修类别 ↔ `SESSION_REPAIRABLE_ISSUE_CODES`、离线命令 ↔ `src/cli/sessions-repair.ts` 的 `action.kind` 只覆盖 `duplicate-id` / `location-mismatch`）；**含糊的「本页不提供」禁止**（要么指向真实页内入口、要么点名页面）。② **断言宽于覆盖同样是缺陷**：用例名写「各页正文无字面 `**`」却只渲染 7 页，真机就漏掉了导出页的 `**`（现在按 `page.ts` 导出的全部 **12 个** `render*Page` 做集合相等 + 每页**非空证明**）。③ 渲染文本里的 `**`：**`esc()` 上下文去标记**（写 `<strong>` 会被转义、写 `**` 会显示星号）、非 esc 上下文才用 `<strong>`。④ **「未知」与「确知为空」必须分开**：`?? new Set()` 把未知伪造成「确知为空集」⇒ 真机 801 条里 **798 条**被误报 `subagent-without-parent`（现在 `knownSessionIds` 缺省 = 不判、显式空集才判；复算误报 **0**，显式空集仍判 801 —— 证明不是靠放宽判据换来的）；⑤ **条件渲染的功能入口必须在「扫过之后」始终可见**：入口只在「有候选行」时渲染 ⇒ 本机没有这一档的用户**根本找不到它**（真机 1218 个会话单元全 `already-placed`，用户就是因此报「没看到入口」）；空态必须自己说明白（zh/en 双键齐），**可见性判定放 `src/ui` 并加单测**（`sessionLayoutSectionState`），别让「没有候选」变成「没有功能」；⑥ **用户可见的修复必须与代码同轮进 CHANGELOG**（按 `changelog-writing` skill 落位 + §4 自检）：实测漏过 —— M2 的四个 UI 修复（入口可见性、卡片布局、字面 `**`、回滚措辞）只提交了代码与守卫，条目是用户问起才补的；「代码+守卫已提交」不等于「这轮交付已收口」。

- **真 codec 复验门的锚点链与 asar 抽取（known-gaps G-24 ⑤）**：官方 catalog 只在 DSH 安装树里（桌面端在 \`app.asar\` 内），所以「能不能验」取决于**锚点**，而锚点必须由外部**显式**给出 —— 四条候选按真伪顺序：install-anchor（宿主 \`profileContext.installAnchor\`）→ env-anchor（\`DSH_CM_DSH_INSTALL\` = **安装根**，即含 \`resources/app.asar\` 的那一层，**不是 asar 本身**）→ runtime-anchor（拉起本进程的 runtime，即 \`process.resourcesPath\`）→ profiles 树。三条不得回退：① **版本解析与 catalog 候选规划必须共用同一条锚点链**，否则两者从不同锚点互相自证；② asar 抽取出的树是**临时物**（缓存根可选注入），绝不动安装树；③ 拿不到锚点时如实 \`unavailable\`（**不是失败、也不是已验证**）；裸 node 进程（无任何锚）对同一份真机 v4 日志就是 \`unavailable(children-required)\` —— 这不是 codec 缺陷。实测（2026-10-07）：设 \`process.resourcesPath=D:/Apps/DSH/resources\` 后真机 v4 **10/10 → {verified:true, strong:true, equivalentToReadPath:true, via:'asar-extract'}**（含 6,022,151 B / events=3683 的大日志，零绝对路径泄漏）；同一份日志清掉唯一锚点即 \`unavailable\`。**覆盖边界如实写**：\`equivalentToReadPath\` 仅在 \`header.version === 当前代际\` 时为真（本机 v4），pre-v4 走迁移链 ⇒ 可 \`verified\` 但**不等价于 DSH 读盘路径**；本机最新代际分布 v0/v3 占多数，故这门是**低覆盖护栏**而非全库体检。

## ⛔ 技术限制（勿突破）
凭据值无法回滚(DSH 不回读)、插件安装需重启、MCP 无管理 API(组合 patch 行导入)、localStorage UI 状态不迁移
