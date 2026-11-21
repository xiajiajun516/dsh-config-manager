# 会话与导入导出 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/evidence/README.md`。

## 宿主整文件快照的「存在但读不出来」绝不写 `existed:false`

- **宿主整文件快照的「存在但读不出来」绝不写 `existed:false`**（2026-10-08 UX 审查，数据安全）：`backupHostFiles` 读失败 / 存在性探测失败一律登记 `existed:true` + `unreadable:true`（无 blob），`planRestore` 据此**只跳过并说明、绝不产生 `hostFileRemove`** —— 写成 false 等于「当时不存在」，回滚会删掉用户真实的 settings.yaml。同轮：`prune` 的 recovery 引用集合**读不到即放弃本轮清理**（绝不按空集合继续删），新增 `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`）让放弃/失败可见。护栏：`src/core/backup.test.ts`、`tests/core/restore.test.ts` 的 `R-host-unreadable`；证据见 `docs/archive/2026-10-known-pitfalls.md`（同序条目）。
- **宿主整文件与文件类分区仍是两条读失败口径（如实记录，未统一）**：宿主整文件走 `existed:true` + `unreadable:true` 后**只跳过并说明**；文件类分区则上抛成**分区级可见失败**（`export.sectionFailed` + 一条 warning，见下节）。把「宿主文件 unreadable」也接进导出报告的告警面属另一条线，改动要同时过 `planRestore` 与报告文案两处。

## 文件类分区收集一律走 `utils/recursive-walk.ts`

- **文件类分区收集一律走 `utils/recursive-walk.ts`**：`readdir` 对目录 junction/符号链接返回 `isSymbolicLink()===true`（`isDirectory()` 为 false），自写分支会**静默丢整块内容且备份仍报成功**（issue #37 丢 12 MB）；新文件类 adapter 用 `adapters/link-report.ts` 的 `listFilesDetailed` + `linkWarnings`，别直接调 `ctx.fs.listRecursive`。内核同时**整棵跳过 `node_modules`**（任意深度，issue #76：技能自带依赖会把单个分区顶到上万条目、撞 10000 条目闸门使定时备份永久失败），跳过项经 `RecursiveListing.skippedDepDirs` 进告警（导出报告 / 预览 / 离线 CLI 三处同源），**绝不静默**。

## `pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出

- **`pnpmWorkspace` 与 `plugins.patchFiles` 必须同进同出**（issue #35）：只搬 `pnpm-workspace.yaml` 文本会让目标机 pnpm 拒绝**一切** `add`（`Failed to read patch file`）；导入端写入前剔除目标机无法满足的 `patchedDependencies`（`adapters/pnpm-workspace.ts`）并让剔除在计划里可见；市场通道对 `patchFiles` 与 `localTarballs` 同级双端拒收。

## 只在 `dsh.profile.bundles` 里声明的层绝不能被 npm 安装

- **只在 `dsh.profile.bundles` 里声明、`dependencies` 与 profile `node_modules` 里都没有的层，是 DSH 从自己的安装位置解析的**（issue #95）：与 `boot-safety.ts` 的「`@deepseek-ai/*` 由 DSH 从它自己的安装位置解析，本机探测不到属预期」、`RESCUE_KEEP_BUNDLE_PREFIXES = ['@deepseek-ai/']` 同一口径。导入端对这类条目**只把名字声明回目标机的 `dsh.profile.bundles`**（该写入是 `plugins` 的文件类目标，进导入前快照、可回滚），**绝不走 `dsh plugin add`** —— 按裸包名安装拿到的是 npm `dist-tags.latest` 的副本，与 host 版本线脱节。**真机证据（2026-10-17，报告者为第三方用户）**：host 升到 `0.2.1-rc.2` 后同步/恢复旧配置，`@deepseek-ai/dsh-experimental-session-search` 被装成 `0.2.1-alpha.2`（该 dist-tag `latest` 至今指向 10-09 的 alpha），alpha 的 bundle patch 把 `sessionQuery` 放进隔离组 → rc.2 host 的 `session-controller` 注入不到它 → 一直 pending → 网关对 session/create 一律 service-unavailable（「新建会话报错」）。**本机复核**：`~/.dsh/profiles/desktop/package.json` 的 bundles 里有 3 个 `@deepseek-ai/dsh-experimental-*`，`dependencies` 与 `profiles/desktop/node_modules/@deepseek-ai/` 里都没有它们；而 `D:\Apps\DSH\resources\app.asar` 的头部字节扫描能直接找到 `dsh-experimental-auto-review` / `dsh-experimental-agent-team-profile`（包确实在 DSH 自己的安装目录里）。**边界**：本地**有**落盘副本的手工层（无依赖行但有 `node_modules` 副本）不在此列 —— 那种层得靠安装通道才能在目标机存在，保持旧行为（本次不改）。**失败语义**：目标 profile 清单缺失 / JSON 坏 / `bundles` 非字符串数组 → 只在计划里记非致命 warning，**绝不重建清单**（`bundles` 非空即替换默认插件栈，凭空造 = 悄悄改装配语义）。**护栏**：`src/core/plugin-cli.fs.test.ts`（`bundlesOnly` 标记 / `isBundlesOnlyEntry` / `mergeBundleDeclaration`）、`src/adapters/plugins.test.ts`（只声明不安装 / 旧包形状推断 / 三态告警）、`tests/core/patch-file-snapshot.test.ts`（清单 ref 进快照 + 回滚逐字还原）。

## 会话日志的字节改写只允许在宿主侧

- **会话日志的字节改写只允许在宿主侧**（issue #45）：多帧 zstd 容器，改写 cwd 只换第 1 帧 + 尾部流式拷贝 + 发布前自检，**Windows 上 rename 覆盖前必须关闭读句柄**。`src/utils/zstd-frame.ts` 纯字节帧工具；`src/utils/session-log.ts` 是宿主适配器与 CLI 的唯一实现（core 禁止 import）。**头等硬约束**：DSH 校验「日志位置 == `projectKey(header.cwd)/id`」，**改写 header 必须连目录一起归位**，搬不动就回滚（否则 `dsh web` 报 `corrupt session log`，同 id 出现在两个 projectKey 则报 `duplicate JSONL session id`）。索引刷新用 `reindexSessionHeader`（**不要用会清空 sessionPaths 的 `replaceHeaderIndex`**），刷不了如实汇报。**应用内修复（T8）**：`utils/session-repair-service.ts` + `POST /recovery/sessions/{repair,rollback}` 只做**能从字节证明的修复**（有损需显式 `allowLossy`）：三道写入门（unitId 只解析到会话根内 / 无 `session.lock` / 不在 30s 静止期）+ 预览-应用指纹一致 + SAFE MODE 与 mutation lock + 写前自校验 / 时间戳备份 / 原子换入 / 写后复验；**回滚只认台账 `repairId`**（`<dataDir>/session-repairs.json`）。一键修复必须逐条独立、**有损不批量**、结果如实计数。

## 文件集合分区永不参与导入期前缀映射

- **文件集合分区永不参与导入期前缀映射**（issue #45）：`ConfigAdapter.fileCollection` 分区里 `relativePath` 是**身份**不是配置（命中 `--projectKey--` 会让目标机下次启动失败），`analyzer.applyMappingsToSections` 整段跳过；会话走专用通道（`SessionsAdapter.finalizeApply` 把 `ctx.pathMappings` 应用到**首帧 cwd** 再归位到 `projectKeyOf(映射后 cwd)`，`rewriteLogDir` 只换第 1 帧）。**导出会话必须连带所属工作区**（`exporter.coupleSessionWorkspaces`）：匹配不上就带上全部工作区、读不到就告警、连带白名单与分区选定**共用同一份 includeItems**、四种结果各有报告文案、导入侧对「有会话没工作区」的包在分析阶段告警。宿主半**无热重载**（改导出/导入必须重启 DSH）；`sessionIds` 由 `WorkspacesAdapter.finalizeImport` 在全部分区收尾后逐个 `attachSession` 登记。**选择器联动**：`applySessionWorkspaceCoupling`（方向必须显式传 `focus: 'sessions' | 'workspaces' | 'both'`）；配对两套判据 = 注册表 `sessionIds`（经 `sessionIdKey` 归一化）+ cwd 目录键（`projectKeyOf(path)`），**绝不按会话路径做前缀匹配**。**跨机重定基**：导出写 `manifest.sourceHome`，导入时 `analyzer.rebaseMapping` 插到用户映射之前，只对绝对路径、段边界生效，计划里见 `ImportPlan.automaticMappings`。

## 会话可见性必须由「包内实际带走的会话」驱动

- **会话可见性必须由「包内实际带走的会话」驱动**（issue #45 ③）：导出侧 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`）按 cwd 目录键声明进工作区记录；导入侧登记 = 记录声明的 ∪ 包内带数据的，失败按「这次有没有带它的数据」分类；每个 id 先试声明形态再试另一种命名形态（DSH 只认 header 的 `id`）。

## 子代理会话（`origin='subagent'`）不是工作区里的对话，导出必须连带父对话

- **子代理会话（`origin='subagent'`）不是工作区里的对话，导出必须连带父对话**：`SessionsAdapter.export()` 调 `coupleSessionParents` **只向上补父对话**；向下由界面联动（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，`ContentPicker.commit` 调用）—— **白名单即权威，引擎绝不向下展开**。子会话清单来自 `SessionStoreFacade.parentRelations()`（读 header `parentSession`+`origin`，不读日志字节）；**BFS 的「已排队」与「已展开」必须分成两个集合**；父对话 id 在磁盘 header 叫 `parentSession`、DSH 的 RPC 投影才叫 `parentSessionId`。复核见 known-pitfalls.md。

## 「历史对话」排序时间有两个来源

- **「历史对话」排序时间有两个来源**：`storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`）+ `SessionsAdapter.unitActivityTimes()` 现算的日志 mtime（`/export-preview` 注入 `applySessionMeta`）；缓存覆盖不全，**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`）。

## journal step 的 `skipped` 只能表示「用户主动跳过」

- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning` 与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35）。

## 导出/导入侧的格式版本体检：不体检就会「导入全部成功、对话一个不显示」

- **量级先记住**：本机 401 个会话日志分布 `{v0:200, v3:201}`（桌面端内置 0.2.0-rc.2 = **v4**，磁盘 CLI 档案 0.1.5-rc.1 = **v3**）—— 多版本共存是常态，而本插件的导出/导入/同步是**逐字节搬运** `.jsonl.zstd`；DSH 对非本 build 版本直接拒绝（`refuseForeignFormatVersion` → `SessionFormatUnsupportedError`）、列表 `listArtifacts()` 对该错误 `continue` ⇒ 不体检的后果不是报错，是「对话消失」。**跨版本可读性与「按目标机版本写」的口径归 `sessions-repair-diagnostics.md`；本节只留体检落点。**
- **落点**：`src/utils/session-format.ts` 宿主探针（只解**首帧**、每会话一条、上限 200，常量从 `installAnchor` 同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 semver 猜**）→ `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe` → `Analyzer.sessionFormatWarnings` 产出 `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`；档案页用 `profileVersionFacts` / `sessionFormatRisk`。**任一侧读不到版本一律不提示**（不猜、不给假结论）；core 仍禁止 import 会话存储格式（只消费数字）。登记 known-gaps **G-23**。

## `skippedLinks` 的 `too-deep` 不再必然等于「链接」

- **`skippedLinks` 的 `too-deep` 不再必然等于「链接」**（cli-F2 + t37）：递归遍历的深度上限对**普通目录**同样生效并留痕；告警措辞按真实原因分派 —— `too-deep` → 「层级超过上限未进备份」，`loop`/`outside-home`/`broken`/`unreadable` 才写「链接未进备份」。看到 `too-deep` 先按「目录太深」排查，不要再当成链接问题（反之亦然：链接措辞只对应后四种）。

## 文件类分区「存在但读不到」必须显式失败，不得静默跳过

- **文件类分区「存在但读不到」必须显式失败，不得静默跳过**（ui-F2，t23）：只有真不存在（ENOENT）才算「按需创建、本来就没有」；EACCES / EBUSY / IO 错误一律上抛成**分区级可见失败**（`export.sectionFailed` + 一条 warning），与基类同口径。判定「不存在」的探测自身失败时按「存在」处理 —— 读不到 ≠ 没有。

## 只读预览与导出必须同口径

- **只读预览与导出必须同口径**（2026-09）：`/export-preview` 走 `ConfigAdapter.preview?()`（文件类分区由 `FileCollectionAdapter` 实现），它只把「读文件内容 + SHA-256」换成 `ctx.fs.statSize`，**单元分组 / 条目白名单 / 单分区字节闸门 / 告警生成逐字共用**同一个内核（`file-collection.ts` 的 `collect(ctx, options, mode)`）。为什么必须共用：预览是用户勾选的唯一依据，一旦与真实导出分叉，用户会按预览勾选却拿到别的包（`file-collection.test.ts` 断言两者逐项相等）。**`preview()` 产出的 `FilesSection` 是无内容形态**（`data` 长度 0 / `contentHash` 空串），只在内存里流转，**不得**交给 exporter/importer/快照；**收集面靠覆写 `export()` 收窄的分区必须改成覆写 `listRelPaths()`**（覆写 `export()` 不参与预览，否则预览落到基类目录递归；量化数据见 known-pitfalls.md）。

## 已验证归档跨请求缓存

- **已验证归档跨请求缓存**（`src/core/analyzer.ts` 的 `verifiedBundles`，2026-09）：宿主 `makeImporter()` **每请求新建** Importer/Analyzer，实例级 `bundleCache` 跨请求恒不命中，于是 analyze→plan→execute（每改一次决策还会再 plan）会把同一个 ZIP 读入 + 全量解压 + 逐条 SHA-256 校验 3~4 次。三条硬边界：① 缓存键 = **路径 + 文件大小 + mtimeMs**（stat 失败即不缓存）；② **只有只读入口**（`analyzeImport` / `createImportPlan`）读它，`executeImportPlan` 一律 `refresh` —— 每次都重新读盘 + 重新校验，关掉「校验后、写盘前被换掉」的 TOCTOU 窗口（`src/core/analyzer-cache.test.ts` 用「plan 后篡改归档 → execute 必须被完整性校验拦下」钉住）；③ 只缓存 ≤ 64 MiB 的归档，条目上限 2 + TTL 120 s。配套：逐条完整性校验改走 `ZipArchive.readEntryAsync`（`inflateRaw` 走 libuv 线程池），不再用 `inflateRawSync` 阻塞事件循环（实测见 known-pitfalls.md）。

## `readSessionMeta` 有 mtime 失效的进程内缓存

- **`readSessionMeta` 有 mtime 失效的进程内缓存**（量化数据见 known-pitfalls.md）：键 = homeDir + 两个 storage 文件的 mtime，**任一读不到 mtime 就不缓存**（宁可多读，不可拿陈旧索引猜会话归属）；测试用 `clearSessionMetaCache()` 隔离。

## 插件内置技能（source='bundled'）不能备份，导入侧也要拦

- **插件内置技能（source='bundled'）不能备份，导入侧也要拦**（issue #102，2026-10）：`ctx.skills.list()` 合并了**插件 registerProvider 注册的技能**与 `$DSH_HOME/skills` 磁盘技能，但技能端口**只暴露 `SKILL.md` 正文**，插件技能目录里的 `scripts/`、资源文件读不到 ⇒ 把 `source==='bundled'` 的条目按「磁盘技能」写进备份，副本必然残缺（真机：磁盘 20 个技能导出成 21 个 / 228 文件，多出的那个是 `@deepseek-ai/dsh-sandbox-windows-acl` 的 `diagnose-windows-sandbox-acl`，没有 `scripts/`）。三条边界：① 判据只有一个导出函数 `isMigratableSkillSource(source?: string)`（`src/adapters/skills.ts`）—— **只有 `'bundled'` 不可迁移，`undefined` 必须放行**（旧宿主不报 `source`，一律拦会让旧宿主一个技能都备份不到）；② 导出侧在 `listRelPaths()` 的服务合并循环里跳过（`onDisk.has(rel)` 只说明「同路径有磁盘文件」，不说明条目可迁移）；③ 导入侧 `SkillsAdapter.analyzeImport` 覆写：一次性 `ctx.target.skills.list()` 建 Set（**不要逐文件查**: 计划项数 × list 是 O(n²)），命中的计划项改成 `Skip` + `adapter.skillBundledSkipped` 说明，**旧备份里的残缺影子因此不再写进 `$DSH_HOME/skills`**（此前影子与插件自带版本同 rank 抢生效，取决于 provider 注册顺序）。**不要在宿主 façade（`toSkillSummaryView`）过滤 `bundled`** —— 端口语义是「有哪些技能」，过滤会污染未来消费者。

## 会话附件的引用面 = 会话日志里的 `"attachmentId":"sha256:<hex>"`

- **附件分区的收集面由引用决定，不由目录决定**（P1，2026-11-21 真机量化）：`~/.dsh/attachments` 全库 **233 MB = 1374 个对象（228.4 MB）+ request-images 1.5 MB + tmp 0**，而本机 336 个会话日志只引用 **595 个 id**，物理存在且被引用 **590 个 / 159.9 MB**，**68.4 MB（约 30%）是从未被任何对话引用的孤儿**。所以「整目录搬」= 每次备份多背 30% 垃圾，还把这些孤儿带到目标机。判据只有一条正则：`"attachmentId"\s*:\s*"sha256:[a-f0-9]{64}"`（`src/utils/attachment-refs.ts`）；**不能**用裸 `/sha256:[a-f0-9]{64}/` —— 会话里粘贴的源码会命中 `x-oss-content-sha256` 这类文本，实测会误收。图片与文件附件同一 id 形状（`@deepseek-ai/dsh-attachment-local` 的 `FILE_ID_PATTERN`），物理布局三种（`v1/objects/<2>/<sha>`、`v1/file-objects/<2>/<sha>`、`v1/files/<2>/<sha>/<name>`）用「路径里首个 64 位 hex 段」反推 id 即可，不硬编码深度。**降级方向只有一个：宁可多带，不可静默丢图** —— zstd 不可用 / 日志读失败 / 帧头坏（有魔数解不开）一律退回整库并告警，绝不当作「零引用」；只有 `includeItems.sessions=[]`（用户明确一条会话都不要）才产出空集。适配器必须挂在 `sessions` **之后**（`src/adapters/index.ts`），顺序反了会静默当成未收窄全集。

## 导入前逐条比对：六态，且 cwd 必须先归一

- **同名会话必须先比对再覆盖**（P3，2026-11-21）：本插件是**备份恢复**口径（以包为准覆盖），所以「导入会把本机新消息冲掉」这件事必须在点执行之前就报数。六态：`new`（本机无同名会话）/ `identical`（含只差 bookkeeping 行）/ `packAhead` / `localAhead`（本机是包的超集 → **导入会覆盖掉本机多出的 N 条**）/ `diverged` / `unreadable`（本机那份读不出，不猜）。**事件行比对前必须做两件归一**：① JSON 键排序（同一条消息的键序在不同 DSH 版本可能不同）；② **键名为 `cwd` 的值一律归一成 `<cwd>`** —— 包内首帧 cwd 是导出机路径、导入会按映射改写（`SessionsAdapter.finalizeApply` 只改首帧），不归一的话**任何跨机恢复都会误判 diverged**。bookkeeping 行（`session-log-*` 前缀与 `session/end-seed`）不参与判等，前缀一致但尾部全是它 → `identical`。**解不出就不出结论**：包内日志解不开 → 计入 `skipped`（报告必须写「另有 N 条未比对」），本机目录在但没有可配对日志 → `unreadable`，只有「目录形态都探不到」才是 `new`。附件缺口在同一趟解码里收集（`attachmentsReferenced` / `attachmentsMissing`），再由 analyzer 与包内 `attachments` 分区对账 —— **缺口数不能因比对预算被截断而少报**。

## 归档集与工作区顺序托管给宿主，缺能力只告警

- **归档状态与显示顺序都随备份恢复，但两者都不是「记录上的字段」**（P2，2026-11-21，宿主 0.1.0-rc.8 实查）：归档集是**注册表级** `workspaceRegistry.archivedSessionIds`（`node_modules/@deepseek-ai/dsh-workspace/lib/types/index.d.ts:116`）+ `archiveSession()`；显示顺序是 `workspaceIds` 的权威序，客户端只能用 `insertBefore(id, beforeId)` 逐对还原（`registry.list()` 的顺序即导出顺序）。**该版本宿主没有 pin/unpin**（全树 grep `pinnedSessionIds|pinSession` 零命中），所以置顶不做，也不写进包里冒充支持。三条硬口径：① 归档集导出时**按被选中工作区声明的 sessionIds 收窄**（全局归档集若带上未勾选工作区的会话，导入会去动本机不该被碰的会话）；② 包里**缺** `archivedSessionIds` = 老包，导入侧**绝不做任何归档动作**，绝不「对齐成空集」反归档；③ 宿主没暴露能力时只产一条 warning（`host.workspaceArchiveUnavailable`），不阻断导入、不谎报成功。

## P1–P4 复审后的六条硬口径（2026-11-21）

- **顺序恢复必须按 path 对齐真实记录，对齐不上就告警**：宿主 `workspaceRegistry.create(path, title)` **不接受 id**，新机记录必然是新 id ⇒ 包内 id 一条都对不上（旧实现直接拿包内 id 调 `insertBefore`，失败被吞，顺序在真机上静默没恢复）。现在先 `listRecords()`，用「已过映射的 path」优先、title 兜底把包内记录映射到真实 id，全部对不上时产 `adapter.workspaceReorderSkipped` 并**一次都不调**宿主。
- **未配对的会话日志必须参与判定**：本机多出一份代际日志（`session.jsonl.zstd` + `session.v3.jsonl.zstd`）而包内只有一份时，只比同名那份会把「本机整份日志都是新增」误判成 `identical`；现在份数不等一律 `unreadable`（`src/adapters/sessions.ts`）。
- **空 diffs ≠ 本机没有该会话**：`aggregateSessionRows([])` 返回 `unreadable`（没有可比数据就出不了结论）；`new` 只由「目录形态都探不到」这一条路径直接产出。
- **引用面缓存必须可证伪**：键 = 每个日志的 `路径:mtime`，**任一条拿不到 mtime 就整批不缓存**，TTL 60 s（导出预览与真实导出各扫一遍 225 MB 日志的代价）；测试用 `resetAttachmentsScanCache()` 隔离，生产失效不依赖它。
- **Error 项不降级：severity 只许改显示级别，不得撤销阻断**：`markSessionVerdicts`（`src/core/session-verdict-plan.ts`）的降级条件必须同时满足「`row.verdict` 是 `localAhead` 或 `diverged`」与「计划项 `kind !== 'Error'`」才置 `severity: 'warning'`。`kind==='Error'` 的项**一个字都不写** —— SEC-05 的红标正是「为什么不导」，被降成 warning 会让用户以为只是提醒，而 `sessionVerdict` 仍照写（展示事实与决定去留是两回事）。旧实现无条件覆盖 `severity`，连 `severity: 'error'` 的错误项也会被降级；`src/core/session-verdict-plan.test.ts` 的 P3-P1（`kind:'Error'` + `severity:'error'` + `localAhead` ⇒ 仍是 `'error'`）钉住它。
## 导出树里的跨分区子行，以及引用面为什么要落盘（G5，2026-11-21）

- **跨分区子行只做展示，勾选仍走同一份 `excluded`**：附件单元带 `parentUnitIds: string[]`（完整单元 id，如 `sessions:<projectKey>/<sessionId>`），选择器按它把附件行渲染到会话行下面；`childUnitsOf()` / `nestedChildUnitIds()` 只读这份字段，**不引入第二套勾选状态** —— 勾会话时 `applySessionAttachmentCoupling()` 用同一个 `toggleUnit()` 把子附件同步成同一状态，导出侧照旧只收到 `includeItems`，所以「导出结果不变」是可验证的（不是靠文案保证）。两条边界：① 同一附件被多条会话引用时**在每处都出现**（`shared=each`），任一处取消即整条不带走；② 批量动作（`change` 缺省）**不联动** —— 一次「全选会话」静默带上几百 MB 附件是用户没同意的事。附件分区自己那一排会滤掉已嵌套的单元（同一对象列两次会被读成两份），并留一行「N 个附件已挂在各自会话行下面」。
- **归属关系只有宿主能算，所以 `listUnits()` 不许去算它**：`FileCollectionAdapter.listUnits()` 是零 I/O 纯函数，读日志算归属会让它在每次切换分区时扫 230 MB。因此新增可选钩子 `enrichUnits(ctx, units)`，**唯一调用点**是 `/export-preview`；返回 `null`（日志读不出 / 超过 2000 份 / 引用面不可用）时界面退回扁平渲染 —— 算不出归属不等于「这些会话没有附件」。
- **引用面必须落盘，否则每次导出都重付 7 秒**：本机实测 339 份日志 / 230 MB / 108517 个 zstd 帧，**逐帧解压 6.96 s**（切帧 0.01 s、抽正则 0.27 s —— 成本全在逐帧调用开销），并发 8/16/32 实测无改善（纯 CPU）。落盘缓存 `dsh-config-manager/cache/attachment-refs.v1.json`，键 = 日志相对路径，采信条件是 **`mtime` 与 `size` 同时相等**；任一读不到就整条不用缓存（重扫），`merged.size === 0` 时**不写空文件**（空缓存对下次无用，却会让「有没有缓存」变成误导性观测）。读写失败一律静默降级 —— 缓存只影响速度，不许影响「带哪些附件」。
- **告警要在算完数字之后再推**：`export.attachmentsAllSessions` 曾把带占位符的文案直接推到 `warnings` 里（`{total}`、`{count}` 原样出现在界面上）。凡带参数的文案，push 点必须在所有参数确定之后；`attachments.test.ts` 的 P1-7 用完整句子钉住它。
