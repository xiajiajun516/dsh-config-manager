# 会话与导入导出 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## 宿主整文件快照的「存在但读不出来」绝不写 `existed:false`

- **宿主整文件快照的「存在但读不出来」绝不写 `existed:false`**（2026-10-08 UX 审查，数据安全）：`backupHostFiles` 读失败 / 存在性探测失败一律登记 `existed:true` + `unreadable:true`（无 blob），`planRestore` 据此**只跳过并说明、绝不产生 `hostFileRemove`** —— 写成 false 等于「当时不存在」，回滚会删掉用户真实的 settings.yaml。同轮：`prune` 的 recovery 引用集合**读不到即放弃本轮清理**（绝不按空集合继续删），新增 `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`）让放弃/失败可见。护栏：`src/core/backup.test.ts`、`tests/core/restore.test.ts` 的 `R-host-unreadable`；证据见 `docs/known-pitfalls.md`（同序条目）。

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

- **子代理会话（`origin='subagent'`）不是工作区里的对话，导出必须连带父对话**：`SessionsAdapter.export()` 调 `coupleSessionParents` **只向上补父对话**；向下由界面联动（`src/ui/selection-model.ts` 的 `applySessionParentCoupling`，`ContentPicker.commit` 调用）—— **白名单即权威，引擎绝不向下展开**。子会话清单来自 `SessionStoreFacade.parentRelations()`（读 header `parentSession`+`origin`，不读日志字节）；**BFS 的「已排队」与「已展开」必须分成两个集合**；父对话 id 在磁盘 header 叫 `parentSession`、DSH 的 RPC 投影才叫 `parentSessionId`。复核见 known-pitfalls。

## 「历史对话」排序时间有两个来源

- **「历史对话」排序时间有两个来源**：`storages/session_projcache.json` 的 `lastPromptAt`（缺则 `identity.createdAt`）+ `SessionsAdapter.unitActivityTimes()` 现算的日志 mtime（`/export-preview` 注入 `applySessionMeta`）；缓存覆盖不全，**索引键必须用 `sessionIdKey()` 归一化后再查**（缓存键是裸 `<uuid>`）。

## journal step 的 `skipped` 只能表示「用户主动跳过」

- **journal step 的 `skipped` 只能表示「用户主动跳过」**：`warning` 与 `failed` 都必须记 `attention`，否则事后审计会把「安装失败」读成「用户跳过了」（issue #35）。

## 会话日志格式版本跨版本是「单向兼容 + 静默跳过」

- **会话日志格式版本跨版本是「单向兼容 + 静默跳过」**（known-gaps **G-23**）：DSH 对非本 build 版本直接拒绝，而 `listArtifacts()` 对该错误 `continue` → 用户只看到「对话消失」。高版本可读低版本，**反向不可读**。接线：`src/utils/session-format.ts` 宿主探针（只解**首帧**、每会话一条、上限 200，常量从 `installAnchor` 同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 semver 猜**）→ `HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe` → `import.sessionsFormatUnsupported` / `import.sessionsFormatSampled`；档案页用 `profileVersionFacts` / `sessionFormatRisk`。**任一侧读不到版本一律不提示**（不猜）。core 仍禁止 import 会话存储格式。

## `skippedLinks` 的 `too-deep` 不再必然等于「链接」

- **`skippedLinks` 的 `too-deep` 不再必然等于「链接」**（cli-F2 + t37）：递归遍历的深度上限对**普通目录**同样生效并留痕；告警措辞按真实原因分派 —— `too-deep` → 「层级超过上限未进备份」，`loop`/`outside-home`/`broken`/`unreadable` 才写「链接未进备份」。看到 `too-deep` 先按「目录太深」排查，不要再当成链接问题（反之亦然：链接措辞只对应后四种）。

## 文件类分区「存在但读不到」必须显式失败，不得静默跳过

- **文件类分区「存在但读不到」必须显式失败，不得静默跳过**（ui-F2，t23）：只有真不存在（ENOENT）才算「按需创建、本来就没有」；EACCES / EBUSY / IO 错误一律上抛成**分区级可见失败**（`export.sectionFailed` + 一条 warning），与基类同口径。判定「不存在」的探测自身失败时按「存在」处理 —— 读不到 ≠ 没有。

## 只读预览与导出必须同口径

- **只读预览与导出必须同口径**（2026-09）：`/export-preview` 走 `ConfigAdapter.preview?()`（文件类分区由 `FileCollectionAdapter` 实现），它只把「读文件内容 + SHA-256」换成 `ctx.fs.statSize`，**单元分组 / 条目白名单 / 单分区字节闸门 / 告警生成逐字共用**同一个内核（`file-collection.ts` 的 `collect(ctx, options, mode)`）。为什么必须共用：预览是用户勾选的唯一依据，一旦与真实导出分叉，用户会按预览勾选却拿到别的包（`file-collection.test.ts` 断言两者逐项相等）。**`preview()` 产出的 `FilesSection` 是无内容形态**（`data` 长度 0 / `contentHash` 空串），只在内存里流转，**不得**交给 exporter/importer/快照；**收集面靠覆写 `export()` 收窄的分区必须改成覆写 `listRelPaths()`**（覆写 `export()` 不参与预览，否则预览落到基类目录递归；量化数据见 known-pitfalls）。

## 已验证归档跨请求缓存

- **已验证归档跨请求缓存**（`src/core/analyzer.ts` 的 `verifiedBundles`，2026-09）：宿主 `makeImporter()` **每请求新建** Importer/Analyzer，实例级 `bundleCache` 跨请求恒不命中，于是 analyze→plan→execute（每改一次决策还会再 plan）会把同一个 ZIP 读入 + 全量解压 + 逐条 SHA-256 校验 3~4 次。三条硬边界：① 缓存键 = **路径 + 文件大小 + mtimeMs**（stat 失败即不缓存）；② **只有只读入口**（`analyzeImport` / `createImportPlan`）读它，`executeImportPlan` 一律 `refresh` —— 每次都重新读盘 + 重新校验，关掉「校验后、写盘前被换掉」的 TOCTOU 窗口（`src/core/analyzer-cache.test.ts` 用「plan 后篡改归档 → execute 必须被完整性校验拦下」钉住）；③ 只缓存 ≤ 64 MiB 的归档，条目上限 2 + TTL 120 s。配套：逐条完整性校验改走 `ZipArchive.readEntryAsync`（`inflateRaw` 走 libuv 线程池），不再用 `inflateRawSync` 阻塞事件循环（实测见 known-pitfalls）。

## `readSessionMeta` 有 mtime 失效的进程内缓存

## 插件内置技能（source='bundled'）不能备份，导入侧也要拦

- **插件内置技能（source='bundled'）不能备份，导入侧也要拦**（issue #102，2026-10）：`ctx.skills.list()` 合并了**插件 registerProvider 注册的技能**与 `$DSH_HOME/skills` 磁盘技能，但技能端口**只暴露 `SKILL.md` 正文**，插件技能目录里的 `scripts/`、资源文件读不到 ⇒ 把 `source==='bundled'` 的条目按「磁盘技能」写进备份，副本必然残缺（真机：磁盘 20 个技能导出成 21 个 / 228 文件，多出的那个是 `@deepseek-ai/dsh-sandbox-windows-acl` 的 `diagnose-windows-sandbox-acl`，没有 `scripts/`）。三条边界：① 判据只有一个导出函数 `isMigratableSkillSource(source?: string)`（`src/adapters/skills.ts`）—— **只有 `'bundled'` 不可迁移，`undefined` 必须放行**（旧宿主不报 `source`，一律拦会让旧宿主一个技能都备份不到）；② 导出侧在 `listRelPaths()` 的服务合并循环里跳过（`onDisk.has(rel)` 只说明「同路径有磁盘文件」，不说明条目可迁移）；③ 导入侧 `SkillsAdapter.analyzeImport` 覆写：一次性 `ctx.target.skills.list()` 建 Set（**不要逐文件查**: 计划项数 × list 是 O(n²)），命中的计划项改成 `Skip` + `adapter.skillBundledSkipped` 说明，**旧备份里的残缺影子因此不再写进 `$DSH_HOME/skills`**（此前影子与插件自带版本同 rank 抢生效，取决于 provider 注册顺序）。**不要在宿主 façade（`toSkillSummaryView`）过滤 `bundled`** —— 端口语义是「有哪些技能」，过滤会污染未来消费者。

- **`readSessionMeta` 有 mtime 失效的进程内缓存**（量化数据见 known-pitfalls）：键 = homeDir + 两个 storage 文件的 mtime，**任一读不到 mtime 就不缓存**（宁可多读，不可拿陈旧索引猜会话归属）；测试用 `clearSessionMetaCache()` 隔离。
