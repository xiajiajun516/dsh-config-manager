# 已知缺口登记（known-gaps）

> **只登记「现在仍未关闭」的东西。** 已关闭条目的修复方式、取证与验证命令留在 git 历史，本文件只保留编号 + 一句话主题，保证别处的 `G-xx` 引用仍能对上：
> `git show 6f2864b:docs/maintenance/known-gaps.md`（2026-10-28 精简前的完整版，235 KB）。取某条原文时按编号 grep 即可。

> - 编号**不复用**。看到别处引用 `G-xx` / `F-xx`，先查 §0 的状态，再决定去 git 历史还是看对应正式契约文档。
> - 「已修复」= **当前仓库工作区**源码已无该缺陷，且有可复现的验证方式（测试或隔离安装）；npm 上已发布版本以 `npm view dsh-config-manager dist-tags.latest` 现查为准（刻意不写死版本号，写死会变成假陈述）。
> - 行号是写作时读源码的快照，源码并行修改必然漂移；检索以**符号名 / 消息 key** 为主锚点。
> - 本文件被 `scripts/check-doc-paths.mjs` 与 `scripts/check-doc-versions.mjs` 显式跳过（体量大且不随版本走），因此不参与活文档的路径与版本校验。
> - 分工：**对外契约行为**以 `docs/spec/` 为准；**无法由本仓库证明的平台/外部事实**以 `docs/maintenance/known-limits.md` 为准；本文件只记「本仓库实现与应有行为之间的差距」。

## 0. 编号索引

### 0.1 仍未关闭 / 仍需承担的项

| 编号 | 主题 | 当前状态 |
|---|---|---|
| G-05 | 分区 version 无兼容余地 | ⚠️ 部分修复（不对称，见本节 G-05） |
| G-07 | `needsMigration` 分支不可达 | ⚠️ 仍然成立（版本区间的必然结果，非缺陷） |
| G-11 | 条目名侧不拒绝中段反斜杠 | ❌ **仍未修复** |
| G-19 | 同步快照格式（内容寻址外置）不做协议协商：旧版插件读新版快照会把 `sessions` 当成缺失分区 | ⚠️ **有意不修**（契约登记，见本节 G-19；要求两端同版本） |
| G-20 | 会话删除墓碑不代本机删除数据：对端删掉的对话只被「阻止复活」，本机副本仍在 | ⚠️ **有意不修**（删除是不可回滚的用户动作，见本节 G-20） |
| G-24 | 本机存量会话损坏（重放族 / 撕裂帧 / 位置错位 / 缺工作区 / 缺父对话… | ✅ 已修复（只读体检路由 + 事故恢复面板 + 离线 CLI 安全修复 + **应用内零损失修复（T8，重放重复行）**）；**M1 加固（2026-10-06）**：v0 打包行误判修复 + 真 codec 复验门 + 只读检测扩展 + 有损预览可见 + 引用闭包闸门 + CLI/救急台 verify 三态（**剩余未做项见 §3「G-24 剩余未做项」**） |
| G-30 | 工作区 + 会话回滚（原「checkpoint 三态同点」在本批内被整体改写… | ✅ **已交付可用**（GUI：环境 → 维护与诊断「工作区与会话回滚」卡 + ⌘K 命令；聊天内「↺ 回退」入口。旧 `checkpoints/` 目录不再读取、CLI 入口仍未做、capture 侧「跳过了什么」**已可见（t18，2026-10-10）**；**2026-10-10 三修**：`nothing-to-restore` 由 500 → **200**（成功、0 变更，会话段仍执行）+ 预览逐文件行级统计，见本节） |
| G-31 | 云端点同步通道（S3 兼容系 ×5 / GitHub Gist… | ✅ 已交付（`SYNC_CHANNELS = ['git','webdav','s3','gist']`，声明处 = 零依赖 `src/utils/shared-constants.ts`；s3/oss/cos/minio/kodo/gist 六类端点可用。**未对真实云端点做端到端验证**（本批无真实凭据）；gist 刻意不外置 blob 见 **G-34**） |
| G-32 | SQLite 只读探测的写副作用（WAL 库被就地打开会新建 `<db>-shm`/`<db>-wal`… | ✅ 已处置（`sqlite.ts` 三态打开计划 direct / immutable / copy + 1 GiB 上限 + **绝不退回就地打开**；四条残余风险见 §3） |
| G-34 | GitHub Gist 通道刻意不外置 blob（一次 GET 全量返回 / 单文件超限截断 / 文件数上限… | ⚠️ **刻意设计的能力边界，不是缺陷**（gist 定位 = 配置类分区的低门槛远端）；**界面提示已补（2026-10-08）**：gist 表单常驻 `cloud.gistLargeSectionHint`，且「通道=gist 且勾选 sessions」时出 `mode.gistSessionsWarn` 风险横幅（判定纯函数 `gistSessionsRiskKey`，护栏 `sync-view-v2.test.ts`） |
| G-35 | 同步通道对远端 404 的可靠性假设：blob GC 只按索引条目收集引用 → ① 索引可读但陈旧（孤儿快照… | ⚠️ **未修复（已核实残余，非原任务引入）**：t42 已堵住 `delete()` 侧的「索引 404 真缺失」；`upload()` 侧仍待 **t66/t67**（登记时 pending）；根治需通道侧补列举原语（WebDAV PROPFIND / S3 ListObjectsV2），见 §3 |
| G-36 | 值形状判定的大小写边界：auth-scheme `bearer` 原为大小写敏感（`bearer` / `BEARER` 明文进包且 re… | ⚠️ **部分修复（t72）**：`bearer` 已按 RFC 7235 / 6750 大小写不敏感剥离（含过剥控制）；厂商前缀**刻意保持敏感**、登记为已知边界（见本节 G-36） |
| G-38 | 渲染点脱敏登记表（`src/client/common/plan-text-redaction.test.ts`）覆盖不到「上游已脱敏」型渲染点：RollbackCard 有 5 处宿主文本在… |
| G-39 | 聊天 user 消息渲染器被本插件接管：剩余已追认差距（技能 chip 与引用 chip 的可点开外观未做、… | ⚠️ **已知边界 / 有意承担**（缺省形态「每条用户消息一个」；「整回合」档仍可切；复核发现的 5 处复刻偏差已于 2026-10-10 按宿主修齐；**2026-10-10 三修**：入口 icon-only、两档**互斥**（per-message 档回合尾入口一次都不注册）、聊天预览弹窗改简洁版（含「点回退即确认」的有意替换），见本节） |

### 0.2 已关闭（逐条取证与修复史见 git 历史）

| 编号 | 主题 | 结论 |
|---|---|---|
| G-01 | 未知分区被静默丢弃 | ✅ 已修复 |
| G-02 | 未知分区告警文案误导 | ✅ 已修复 |
| G-03 | 无「不支持分区」的报告通道 | ✅ 已修复 |
| G-04 | checksums 单向（不检查多余条目） | ✅ 已修复（含表缺失分支，见 G-12） |
| G-06 | 迁移链未接入导入路径 | ✅ 已修复 |
| G-08 | 密码强度校验（基线形同虚设 → 一度接通 → 按产品决策整体移除） | ➖ 已按产品决策整体移除（加密不做密码强度校验… |
| G-09 | 文件类分区内容不扫描 secret | ✅ 已修复（只报告不改写） |
| G-10 | `sections.secrets` 恒 `false` 但语义被复用 | ✅ 已收口（规格侧澄清） |
| G-12 | G-04 残留：表缺失/为空时漏报 | ✅ 已修复（`import.checksumsMissing`） |
| G-13 | G-09 残留：告警按 hit 不去重 → 真凭据文件零告警 | ✅ 已修复（按文件去重 + 截断补汇总） |
| P-1 | peerDependencies 体积（headless 为 UI 付费） | ✅ 已修复 |
| P-2 | `lib/**/*.map` 随包发布 | ✅ 已修复 |
| G-14 | 同步只搬 `pnpmWorkspace` 声明、不搬 `patches/**` → 目标机 pnpm 拒绝一切安装（issue #35… | ✅ 已修复（`patchFiles` 同进同出 + 导入端剔除不可… |
| G-15 | Windows 无 OS process identity → 阈值内的 PID 复用残留锁… | ✅ 已修复（win32 `Get-Process` / macOS … |
| G-16 | 文件类分区静默跳过 junction/符号链接（issue #37） | ✅ 已修复（GUI 与 CLI 同一跟随内核 +… |
| G-17 | 同步页「导出密钥」无数据源：勾选后不导出任何凭据，只跳过载荷的二次脱敏（issue #38） | ✅ 已修复（凭据作为独立密文载荷随加密快照迁移… |
| G-18 | `.credentials.yaml` 的 `refs:` 块未被识别：包里带着凭据原文，导入后仍要求人工重填（issue #39） | ✅ 已修复（两处解析共用同一口径… |
| G-21 | 路径映射页把内部枚举当文案渲染：源路径「永远是 missing」（真机反馈） | ✅ 已修复（改用真实判定 |
| G-22 | 加密备份里的凭据「有值却不进计划」+ 本机已配置就被跳过（真机反馈） | ✅ 已修复（判据「值的有无」优先于本机状态… |
| G-23 | 会话日志格式版本跨 DSH 版本单向不兼容… | ✅ 已修复（导入/同步分析期体检 + 档案页版本… |
| G-25 | `file:` 指向已打包 tarball 的本地插件被打包环节当目录 spawn（`spawn ENOTDIR`）… | ✅ 已修复（stat 判形态 → 文件直读收编 … |
| G-26 | 包缺少 git 安装所需的构建入口：`dsh plugin add git+https://...` 必失败（issue #58） | ✅ 已修复（补 `scripts.prepare` + 三条 G-21 打包… |
| G-27 | 加密同步快照 >64 MiB 时远端列表恒为空、拉取报「快照损坏」、自动同步恒 `upToDate`… | ✅ 已修复（读取侧改用自产载荷专用上限 + 读不… |
| G-28 | WebDAV 密码输入框被无关状态更新自动清空（issue #60） | ✅ 已修复（`commit()` 经 `patchSyncPasswords` 把在途输入写回内… |
| G-29 | 会话在应用内读不出来：官方 `session.export` 通道（原样 ZIP，含子会话与附件）此前从未接入 | ✅ 已修复（只读探测/流式代理路由 + 体检弹窗… |
| G-33 | 备份不到外壳的 MCP 与技能：patch 只读 home 层、技能不落目录（issue #… | ✅ 已修复（patch 行按层读取并写回原层、技… |
| G-37 | 宿主整文件快照把「存在但读不出来」记成 `existed:false`（恢复时删掉用户真实文件… | ✅ 已修复（2026-10-08 UX 审查：… |

## 3. 未关闭项与契约边界（详情）

> 三类混排在同一编号序列里，性质写在条目内部：
> ① **仍然成立的真缺陷** —— G-11（条目名中段 `\`）、G-45（`applyItems` 不消费 `pendingMerge`）；
> ② **刻意的契约 / 能力边界** —— G-19、G-20、G-34、G-40、G-41、G-43、G-44：修它反而是退化；
> ③ **已交付能力 + 其剩余差距** —— G-05、G-07、G-24（剩余未做项）、G-30、G-31、G-32、G-35、G-36、G-38、G-39。
>
> 某条到底算不算缺陷，只看 §0 的状态列；标题里的「仍未做 / 剩余」是当时点的历史记录。

### G-05 分区 version 无兼容余地

| 项 | 内容 |
|---|---|
| 基线问题 | 分区文档 `version` 采用精确 `=== 1` 判定（`src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定））；任何已知分区 JSON 的 `version != 1` 会让**整个 bundle** 无法导入，而不是跳过该分区。 |
| 修复位置 | `src/core/analyzer.ts` 的 `extractSections`（`import.unsupportedSectionVersion` 跳过该分区并收集 `unsupportedVersions`）`：只有「数字且 `> 1`」才**跳过该分区并告警**（消息键 `import.unsupportedSectionVersion）。 |
| 验证方式 | `FC-03`（`version > 1` → 跳过 + 告警 + 不阻断 + 不进 `sectionsInZip` + 不产生计划项）；同测试的后半段钉住 `version < 1` / 非数字 / 缺失仍**硬失败**。 |
| **仍未修复的不对称** | `version > 1` 跳过、`version < 1` / 非数字 / 缺失**硬失败整个 bundle**。这是**有意保留**的数据损坏语义，但对外部实现者是一个不对称契约，必须在 v2 设计时决策（规格 §3.3 已写明三档实测）。 |
### G-07 `needsMigration` / `describeVersion` 的「将迁移」分支不可达

| 项 | 内容 |
|---|---|
| 问题 | `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，不存在 `1 < v < 1` 的整数，该分支当前不可达。 |
| **性质澄清** | 这**不是待修缺陷**，而是「当前版本区间」的**必然结果**。G-06 修复后接线已就绪，一旦上移 `CURRENT` 即会真实执行。 |
| 验证方式 | `tests/schema-compat.test.ts:17-18`、`:154`（测试文件自身已注明该档位不可达）；`VER-03` 的源码守卫保证接线不会悄悄断掉。 |
| 待办（随 v2） | 与 G-06 一并在发布 schema v2 前补端到端迁移测试。 |
### G-11 条目名侧不拒绝中段反斜杠（与 checksums 侧不一致）

| 项 | 内容 |
|---|---|
| 问题 | `isPathSafe`（`src/utils/paths.ts:45-54`）只拒绝「以 `/` 或 `\` 开头」与「含 `..` 段」的名字，**中段 `\` 被接受**：`isPathSafe('custom/skills/back\\slash.md') === true`；写侧 `zipToBuffer`（`src/utils/zip.ts` 的 `zipToBuffer`（条目名 `isPathSafe` 闸））与读侧 `parseZip`（`src/utils/zip.ts` 的条目名 `isPathSafe` 闸）也接受。 |
| 后果 | ① **跨平台路径语义不一致**：同一份 bundle 在 Windows 目标上把 `\` 当分隔符（`skills/probe/back/slash.md`），在 POSIX 目标上当普通字符（`skills/probe/back\slash.md`）；② 与 `checksums.json` 的键侧规则**不对齐**——后者明确拒绝含 `\` 的路径（`src/security/integrity.ts:63`）。 |
| 可利用性 | **有限**：`\` 不是 `..`，无法越出 baseDir 之外，且 L3 的 `isReservedInternalRel` 会在折叠后拦截保留命名空间。但它是**真实的行为不一致**，且会让跨平台幂等比对出错。 |
| 验证方式 | 规格 §3.3.2 实测 C10（12 例条目名注入）。 |
| 建议动作 | 在写侧与读侧统一拒绝中段 `\`（比现状更严格），并同步 `checksums` 侧规则；这属**格式行为变更**，需与版本策略一起决策。 |
### G-19 同步快照格式不做协议协商（内容寻址外置的跨版本后果）

| 项 | 内容 |
|---|---|
| 背景 | P1-4 起，`sessions` 分区在同步通道上以**内容寻址引用**形态存放（`blobs/<sha256>` + `<section>.blobs.json` / `blobRefs`），格式见 `docs/spec/sync-channel-v1.md`。 |
| 后果 | **旧版插件**读新版快照：git 通道因 `missingFileDir='empty'` 把该分区降级为**空分区**（丢会话内容但不崩），WebDAV 通道同样得到空分区；反向（新版读旧版）无问题 —— 旧快照没有引用形态，按内联文件读即可。 |
| 为什么有意不修 | 同步通道从设计起就不做协议协商（也没有版本握手字段）；引入协商要改远端格式 + 两端状态机，收益仅是「跨版本混用」这一非目标场景。 |
| 缓解 | 两端插件版本应一致（与「本插件是 bundle 包、升级需重启 DSH」同一条运维约束）。 |
| 验证方式 | `src/sync/blob-store.test.ts` 的 layout 集成用例（散文件布局只写引用文件）+ `src/sync/webdav/webdav-transport.test.ts`（旧格式快照仍按内联文件读回）。 |
### G-20 会话删除墓碑不代本机删除（只阻止复活）

| 项 | 内容 |
|---|---|
| 背景 | P1-5 的墓碑（`manifest.deletedSessions`）解决的是「旧快照把已删除的对话带回来」（见 `docs/spec/sync-channel-v1.md` §4）。 |
| 未做的部分 | 对端删除的会话**不会**在本机被删掉：本机那份副本仍然存在，界面也不会出现「删除」计划项。 |
| 为什么有意不修 | 删除会话是**不可回滚**的破坏性动作（DSH 无回收站、快照回滚不覆盖会话字节）。把它做成同步的自动副作用，会在「对端误删 / 对端只是没勾选」时静默毁掉本机数据。当前实现把它降级为**信息**（墓碑在拉取报告里可见），把删除留给用户显式动作。 |
| 若将来要做 | 需要：① 适配器侧的会话删除能力（宿主 `sessionPersistence` 支持 + 审计）；② 新的计划项种类 + 逐项确认 UI（不得并入自动应用）；③ 与「导入前强制快照」的可回滚语义对齐（会话字节当前不可回滚）。 |
### G-30 工作区 + 会话回滚（原「checkpoint 三态同点」在本批内整体改写：T1–T4 + t13）

| 项 | 内容 |
|---|---|
| 背景 | 旧实现是 checkpoint「会话 / 工作区 / 插件配置 三态同点」：引擎 `src/core/checkpoint.ts`（三态捕获 + 内容指纹 + `samePointVerdictOf` 同点判定 + fail-closed 确认门 + 对象仓 / 台账降级）+ recovery prefix 下的 7 条 `checkpoints/*` 子路径。产品决策把「同点」与 config 第三态整体取消：留点单位改成**回合**、会话回退改成**不改写原日志的 fork**、工作区恢复只覆盖记录在案的路径。 |
| **当前状态** | ✅ **已交付可用（2026-10-10）**：引擎 `src/core/rollback-point.ts`（**`src/core/rollback.ts` 是既有的导入失败补偿引擎，与本功能无关，未动**）；宿主订阅 `session/event`，`turn/end` 时按回合留点（边界 = 该回合 `turn/start` 的 seq − 1）；轮询回退（≤5 s）也已实现，但拿不到回合边界 → 该点 `boundarySeq=null`、会话回退结构化 `no-boundary`。GUI：**环境 → 维护与诊断**「工作区与会话回滚」卡（`src/client/recovery/RollbackCard.tsx`：按会话分组时间线 + 只读预览 + 三选一范围 + 二次确认 + 逐段结果）、⌘K 命令 `rollback.open`；**聊天内「↺ 回退」**入口（槽位 `conversation.chat.turnTail`，cell id `config-manager-rollback-entry`）成功后自动打开 fork 出的子会话。 |
| **NOT VERIFIED（不得读成已验证）** | ① 没有在**真实 DSH 进程**内订阅真实 `session/event` 并调真实 `ctx.sessions.fork` 的端到端取证（证据 = `src/index.ts` 装配源码 + 引擎单测 R-02/R-03/R-12/R-18）；② 回滚卡与聊天入口**没有浏览器点击取证**（本仓 React 无组件测试框架，只有 `src/ui/`、`src/client/chat/` 纯函数单测 + 静态守卫）；③ fork 边界只在 mock / fixture 上取样，未在真实会话日志上抽样。 |
| t5-F1 / F2 的处置（修复单 t13，2026-10-10 **已完成**） | **F1 已修**：新增单文件上限 `maxFileBytes`（缺省 = 总量预算 `maxBytes`）并**先 `stat` 判大小**，超限记 `too-large` 跳过、**绝不整份读进内存**（旧实现让首个文件绕过上限的 `read > 0` 短路已删）；字节 / 文件数预算耗尽时其后**每一条**都进 `skipped`（`budget-bytes` / `budget-files`），不再 `break` 静默丢弃；`maxSkippedEntries`（缺省 5000）只限**记录条数**，`skippedCount` 仍是真实总数并置 `skippedTruncated`，`excludedDirs` 逐条记录但不计入计数、不使点 degraded。**F2 已补测**：R-21①–⑤（超限的首个文件 / 字节预算 / 文件数截断 / 标记与计数在列表·详情·预览三处如实回传 / 列表上限）。qa 独立复核：`node --test src/core/rollback-point.test.ts` → **25 / 25 pass**、exit 0；源码复核 `src/core/rollback-point.ts:1051,1063-1078` 与文件头 :19-23（旧注释那句模糊表述已重写）。 |
| 救援点（guard）的留存口径（t7 复核 → t14 定稿 → 2026-10-12 追加全局上限） | **不占**自动点的每会话 20 / 全局 50 预算、**不被其淘汰**（`selectPrune`，`src/core/rollback-point.ts:1589`），用户**不可删**（`remove` → `protected-point`，`:2664`）；但有**自己的两道上限**：每会话 `ROLLBACK_MAX_GUARDS_PER_SESSION = 20`（`:87`）→ 全局 `ROLLBACK_MAX_GUARDS = 50`（`:97`），两轮都只淘汰**最旧的 guard**、各受 `maxGuardsPerSession` / `maxGuards` 可注入选项约束，列表结果回传 `maxGuards`；**可作为回退目标**（t22 把 `canRestore` 与 `canRemove` 解耦：guard 不可删、但正是「回到回退前那一刻」的唯一路径）。**不得**写成「无上限保留」「跨会话无界」，也不得写成「受保护的点永不淘汰」。 |
| 台账写入的并发口径（t14，F-1） | 全部写入口（`appendRecord` / `remove` / `rewind` 的救援点）走同一个**模块级串行链** `withLedgerWriteLock`（`src/core/rollback-point.ts:746`，进程内 RMW 原子）；**读路径不进队列**（最多读到稍旧快照，不破坏台账）。跨进程仍归路由层 `runWithMutationLock` / 环境锁 —— **二者不可互替**：env 锁管「谁能写」，串行链管「进程内写者别互相踩」。护栏 R-22（两实例交错 20 轮）。 |
| 聊天内「↺ 回退」入口的**版本边界**（t20，2026-10-10） | 子会话导航面：0.2.x = `ctx.uiWorkspace.openSession(id)`（shipped ui-chat 自己的 fork 流程同款）；0.1.x 的 `ctx.sessions` 面**没有** `open`（存在才用，绝不包一个必然抛的包装）；无导航面 → 结构化 `unavailable`（显示 childSessionId，**不假装已打开**，与「还没出现在列表里」分开）。槽位**探测后才注册**：只有声明确为 `list` 才注册；0.1.5-rc.2 声明成 `chain`（按 list 注册会抛）⇒ 整条入口 `skip`（`slot-kind-mismatch`），跳过 / 注册异常只丢这一个入口。**不得**写成「聊天内回退入口在任意版本可用」。 |
| 仍未做（如实登记） | ① **CLI 入口**（`dcm rollback list/preview/rewind`）本轮未做 —— 用户只授权 GUI；② **旧 `<dataDir>/checkpoints/` 目录不再被读取**（新目录名 `rollback-points/`），本插件**也不去删它** —— 升级后旧点不可见，要保留历史请自行备份该目录；③ 聊天入口形态**已更新（2026-10-10）**：缺省 = **每条用户消息一个**（接管宿主 `conversation.chat.node` 的 `user` 渲染器并复刻气泡，`priority -1`），本回合尾入口保留为「整回合」档与兜底；与宿主气泡的三条已确认差距、宿主升级错位风险与 class 组件例外登记在 **G-39**；④ **capture 侧「跳过了什么」已到用户可见层（t18 已落地，2026-10-10）**：t13 的 `payload.skippedCount` / `.skippedTruncated`、`summary.segments[].skippedCount` / `.truncated`、`preview.workspace.skippedCount` / `.truncated` 经 t18 接进视图 —— `rollback-view.ts` 的段级 / 预览行 `noticeKeys`（`rollback.row.notice.skipped` / `.truncated`、`rollback.preview.notice.*`）+ `rollbackPreviewWarnings()`（带出 `rollback.warn.trackDegraded`，detail = `workspace capture-truncated`），`RollbackCard.tsx` 渲染为 warn 徽章与行内提示；时间线「文件数」只算已收录文件。证据（真机引擎产出的截断点驱动视图层）= `.tmp/probe-t8-skip.ts`，fail=0。 |
| 验证方式 | 引擎 `src/core/rollback-point.test.ts`（**30** 条：含 t13 的 R-21①–⑤ 捕获边界与 t14 的 R-22 / R-23 / R-23b / R-23c / R-24）；路由 `tests/route/recovery-rollback.test.ts`（**5** 条，真 http server：全子路径可达 + 未确认 409 零写入 + 历史留痕 / 404·405·400 / 503 + guidance / 保护点 409 / SAFE MODE 423）；判定层 `src/ui/rollback-view.test.ts`（**12** 条，含源码级「不得再有 config 第三态」断言）；客户端 `src/client/chat/rollback-entry-view.test.ts`、`src/client/common/client-route-parity.test.ts`（6 条端点双向对账）；全量 `npm test` + `typecheck` + `typecheck:tests` + `build`（bundle 自包含）+ i18n 守卫 + `route-parity`（**79** 条不变）全绿（t5 原始证据；t13/t14 之后引擎单测另跑 30/30）。 |
| 已知限制 | 见 §4.1（T14-F3 / T14-F4）。 |
### G-32 SQLite 只读探测的写副作用与 `immutable` 前提（t9，2026-10）

| 项 | 内容 |
|---|---|
| 背景 | 外部 agent 的多个来源把会话存在 SQLite 库里（opencode 家族 / goose / zed / crush，以及 trae 的 VS Code `state.vscdb`）。「只读打开」看起来无害，实测不然。 |
| 实测（本机 Node v24.13.0） | ① `new DatabaseSync(db, { readOnly: true })` 就地在 **WAL 模式**的库上会新建 `<db>-shm`（32768 B）与 `<db>-wal`（0 B），close 后仍在 —— 也就是说**只读探测会往用户的 agent 数据目录写文件**；DELETE 日志模式的库则前后目录 / size / mtime 逐字不变（零伴生文件）。② `file:<db>?immutable=1` 在 `-wal` 非空时**忽略整条 WAL**（实测 `no such table`）= **静默丢数据**。 |
| 处置 | `src/foreign/sqlite.ts` 的 `planSqliteOpen` 三态计划，判据是**只读库头 + 伴生文件大小**（header[18]/[19]==2 即 WAL）：**direct**（回滚日志库且无热 `-journal`，实测零副作用）/ **immutable**（WAL 且 `-wal`/`-journal` 都为空或不存在 = 主库完整）/ **copy**（其余：有 pending `-wal` 或热 `-journal` → 把 db + `-wal`/`-shm`/`-journal` 拷到**私有临时目录**读副本，close 时删）。**copy 上限 1 GiB**（`DEFAULT_MAX_COPY_BYTES`，超限报 `copy-too-large`），**绝不退回就地打开**；immutable 一旦前提不满足（URI 打不开）就改走 copy，**绝不拿陈旧数据充数**。 |
| 残余风险（四条，如实登记） | ① **源库正被写入时 copy 是某一时刻的近似快照**，撕裂的副本会让该库整体读不到（报 `source-unreadable`，绝不静默）；② **`immutable` 不加锁**，并发写入者存在时读到的是主库的固定快照，可能**少最后几条已提交**；③ **>1 GiB 且带 pending `-wal` 的库会被拒绝读取**（可见码 `copy-too-large`，不静默、不降级）；④ `--user-data-dir` 改写 `data_dir` 的 zed 安装仍**只能由用户显式给路径**（自动探测按缺省 XDG 路径，猜不到改写后的位置）。 |
| 判负层次（同一处收口） | 非 SQLite 文本文件的**构造是「惰性成功」**（`new DatabaseSync(垃圾文本, {readOnly:true})` 不抛），**判负必须落在表探测处**：`sqlite.ts` 的签名判定（表 + 关键列，`PRAGMA table_info` 自适应）不符 → 关闭句柄返回 null，8 个来源的 `readFindings` 报 `shape-mismatch`（**不是** `open-failed`）。 |
| 验证方式 | `src/foreign/sqlite.test.ts`（9 条）：direct / copy-WAL / immutable-干净 WAL 三组形态对「读一遍后的源目录」按**名字 + 大小 + mtime 逐字比较**，全部断言**零新增零改动**（干净 WAL 那条正是旧实现会红的用例）；另有 `copy-too-large` 用例断言「拒绝复制时也**绝不**就地打开」；8 个 SQLite 家族来源逐源注入垃圾库断言 `shape-mismatch`。 |
| 关联 | trae 的 VS Code `state.vscdb` 走同一个 `openSqliteIfShape` → 自动获得零写入。`file-budget.test.ts` 的 fs 白名单已据此登记 `sqlite.ts`（它现在 import `node:fs`/`node:os`/`node:path`，复制路线必需）。 |
### G-34 GitHub Gist 通道**刻意不外置 blob**：大分区（会话）不适合走 gist

| 项 | 内容 |
|---|---|
| 事实 | `GistTransport`（`src/sync/gist/gist-transport.ts` 文件头明写）**不做**内容寻址外置 —— 与 git / webdav / s3 三条通道的差别是**刻意为之**，三条理由：① gist 一次 GET 就把**全部文件内容**吐回来（没有按文件取）；② **单文件内容超限会被 GitHub 截断**（截断时才回落 `raw_url`）；③ gist 的**文件数有上限**。把会话这类「大且数量多」的分区逐文件外置到 gist 会同时撞上这三条。 |
| 定位 | gist 通道 = 「**配置类分区的低门槛远端**」（一个 token + 一个 `gistId` 即可用，适合本机没有 git 二进制 / 只有一个 GitHub 账号的用户）。**会话这类大分区请走 git / webdav / s3**。 |
| 影响与现状 | ① 这是**能力边界不是缺陷**：不外置不会让 gist 通道坏掉，只是推送体积 / 文件数受 GitHub 限制，超限时的表现是**截断**（不是静默成功）。② **界面提示已补（2026-10-08）**：gist 表单常驻 `cloud.gistLargeSectionHint`（常量 `GIST_LARGE_SECTION_HINT_KEY`，`src/client/sync/sync-view.ts`；zh/en 在 `src/client/sync/sync-locales.ts`）。**仍未做**的是「勾了 `sessions` 就二次确认」这类更强阻断 —— 登记为待办，不改变本条「能力边界」的定性。 |
| 验证方式 | `src/sync/gist/gist-transport.test.ts`（含 `truncated: true` 回落 `raw_url` 的用例）；`src/sync/blob-store.test.ts`（外置只在 transport 传了 BlobSink 时启用 —— gist 不传，引擎看到的仍是普通 `FilesSection`）。 |
### G-35 同步通道对**远端 404 的可靠性假设**：GC 把「读不到」当「没引用」（两种形态，**均不可恢复**）

| 项 | 内容 |
|---|---|
| 现象 | 同步通道的 blob GC（`gcBlobStore`，WebDAV / S3 两侧同型）**只按索引条目收集引用**：遍历 `index.json` 里每个快照文件、汇总 `blobRefs`，再回收保护窗（`BLOB_GC_MIN_AGE_MS = 10 分钟`）之外的「无人引用」blob。**两种形态都会让仍在用的 blob 被判成无人引用并真的删除**：① **索引可读但陈旧**：集合里存在**不在索引中的孤儿快照文件**（`upload()` 先 PUT 快照文件、后 PUT 索引，两步之间失败留下，见下），它引用的 blob 不进引用集；② **引用者文件这一读返回 404**（索引里明明列着它）：被判成「文件不存在 ⇒ 自然没有引用」而跳过。两种形态后果相同：**blob 被删、快照文件仍在** → 该快照再被读回时缺 blob，**内容不可恢复**（DSH 无回收站；快照回滚不覆盖 blob 字节）。形态 ② 的额外隐患：这个 404 **可能只是这一轮读失败**（后端瞬时异常 / 最终一致性 / 对象被外部改动），远端其实还有这份快照 —— 被删掉的却是它引用的 blob。 |
| 触发路径 | ① 孤儿：`upload()` 的写序是**先 PUT 快照文件、再 PUT 索引**（保证索引永不引用不存在的文件），两步之间失败（进程被杀 / 网络中断 / 后端 5xx / 重试耗尽）即留下孤儿快照文件；此后任意一次删除触发的 GC 都可能回收它引用的 blob。② 假 404：GC 那一轮里某个引用者 GET 恰好 404，而远端仍有该对象。两条路径都**不产生告警**（索引可读、非空、看起来正常）。 |
| 当前缓解 | t42（N1）已把 **`delete()` 路径**纳入三态：索引 **404 真缺失** → 不写回索引、不触发 GC（目标快照仍按用户意图删除）；索引读失败（非 404 / 非法 JSON / 逐条非法）→ **显式抛错**；索引有条目但某快照文件读不出来（非 404）→ **本轮放弃 GC**。`gcBlobStore` 读引用时也分了岔（t20/t42）：**引用者非 404 失败 → 放弃本轮 GC**（t22 C4 实测零 blob DELETE），**引用者 404 → 按「文件不存在」安全跳过**（t22 C3 实测 blob 被删 ⇒ 就是形态 ②）。**同族的「读不到 ≠ 没有」在本地快照 prune 侧已于 2026-10-08 收口（引用集合读不到即放弃本轮清理，见 G-37）；本条是通道侧 blob GC，仍未修。** |
| `upload()` 现状（本行会随 t66 收窄） | **尚未纳入三态语义**（登记时核对工作区：`readIndexDetailed` / `indexMissing` 只出现在 `delete()`；`upload()` 仍只调 `readIndex()`，即索引 404 仍被当空集合，随后用合并结果覆盖 PUT 权威索引）。t22 的实测（`outputs/bug-audit/review-sync-t22/t22-upload.out.txt`：`索引被抹掉其它快照 = true ; 引用者文件仍在却删了 blob = true`）即这条路径。**修它的是 t66（sync-audit）/ t67（cli-audit，独立验证），登记时两者均为 pending** ⇒ 本行按「**仍待 t66**」记录；t66 落地后本条**只收窄、不消失**：`upload()` 抹掉索引条目那一半被堵住，但「先 PUT 快照、后 PUT 索引之间失败留下的孤儿」（形态 ①）与「假 404」（形态 ②）仍在 GC 侧未堵。**t66 完成后请把本行改为「`upload()` 已纳入三态（t66）」并复核形态 ①/② 是否仍复现。** |
| 为什么现在不修 | 形态 ① 的根治必须在 GC 前**枚举集合内的全部快照文件**（不能只信索引），而两条通道都**没有**这个协议原语：WebDAV 侧本客户端**未实现 PROPFIND**（`src/sync/webdav/webdav-transport.ts` 文件头明写），S3 侧也**没有 ListObjectsV2 封装**（transport 只有单键 GET/PUT/DELETE）。补原语 = 改两条 transport 的读模型 + 夹具与真机复验，属独立工作项；t42 按「最小修复、不放大风险」只堵了 404 那条不可恢复路径。形态 ② 另有一条**更便宜的半边修法**（见根治方向 ④），是否接受其代价属产品取舍。 |
| 根治方向 | ① 通道侧补「列举」原语：WebDAV `PROPFIND`（`Depth: 1`）+ S3 `ListObjectsV2`（前缀 `<col>/`，取 `*.json`，排除 `index.json` / `blobs-index.json` / `blobs/`）；② GC 的引用集改为**索引条目 ∪ 列举结果**（**列举失败即本轮放弃 GC**，与既有「读不出来就放弃」同口径）；③ 列举结果与索引的**差集必须可见**（告警：集合里有 N 个未登记的孤儿快照文件），否则孤儿永远只是「碰巧没被这轮 GC 掉」；④ 形态 ② 可先行单独收口：把「引用者 404」也升级成「本轮放弃 GC」（与 500 同口径，fail-closed），代价是索引里残留的已删快照会让 GC 多轮空转，直到下一次 `delete()` / `upload()` 修好索引。 |
| 影响面 | **只在上述两条触发路径下发生**：正常 push / pull / 自动同步不会产生孤儿（索引与快照文件在同一次 `upload()` 里写完），形态 ② 需要一次假 404，因此触发概率低；但后果是**不可恢复的内容丢失**。与 G-19（跨版本把 blob 分区读成空）、G-20（墓碑不代本机删除）同属「同步通道的有损边界」，三条互不重叠。 |
| 证据 | ① 残余的来源、代价与方案取舍：`outputs/bug-audit/sync-fix-n1/REPAIR-t42-report.md` §0「为什么不选 ②（GC 前枚举集合内全部快照文件）」+ §3 第 1 条。② **独立验证复现，修复树与 base 树逐字相同**（⇒ 既有行为、非 t42 引入）：`outputs/bug-audit/verify-sync-r2/attacks-FIXED.out.txt` 与 `attacks-BASE.out.txt` 的 `RESIDUAL/INFO A6`（WebDAV）与 `RESIDUAL/INFO A8b`（S3）两行，实测 `blob 还在=false 孤儿快照还在=true`；判定见 `outputs/bug-audit/verify-sync-r2/VERIFY-t44-report.md` §4 表（A6 / A8b）+ §7 O2。③ **形态 ② 与 fail-closed 对照**：`outputs/bug-audit/review-sync-t22/t22-attack.out.txt` 的 `观察 C3（索引说 ccc 存在、其文件却 404）` blobDEL 非空、`PASS C4`（引用者 GET 500 → blobDEL=[]）；同族打穿路径（`upload()`）见 `outputs/bug-audit/review-sync-t22/t22-upload.out.txt`；t22 的判定原文在团队任务 t22 的 output 字段（verdict = needs_revision）。 |
| 验证方式 | 形态 ①：`node outputs/bug-audit/verify-sync-r2/VERIFY-t44-attacks.mjs`（构造「索引可读 + 孤儿快照在索引外 + blob 超保护窗」，两棵树对照即上一条证据的 `attacks-{FIXED,BASE}.out.txt`）。形态 ②：`node outputs/bug-audit/review-sync-t22/t22-counterexamples.mjs`（C3/C4 对照）；`upload()` 路径：`node outputs/bug-audit/review-sync-t22/t22-upload-residue.mjs`。 |
### G-36 值形状判定的**大小写边界**：`bearer` 已按 RFC 收口，厂商前缀按决策保留（t58-F1 / t72，2026-10-05）

| 项 | 内容 |
|---|---|
| 现象 | `src/security/secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS` 全为大小写敏感正则。对脱敏面影响最大的是 `Bearer [A-Za-z0-9._~+/=-]{8,}`：**auth-scheme 名在 RFC 7235 / 6750 里是大小写不敏感的**，`Authorization: bearer <token>` / `BEARER <token>` 都是合法写法，但改动前既不命中值形状判定、也不被字段名通道兜住（键名不敏感时，如 MCP 的 `headers: {'X-Custom': 'bearer …'}`）⇒ **明文进包且完全不可见**（`refs=[]`、`skipped=[]`）。厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）的大小写变体（`SK-…` / `Sk-…` / `akia…` / `GHP_…` / `GITHUB_PAT_…`）同样不命中。 |
| 归属（**非 t40 引入**） | 模式表在 `src/security/**`；t40（env/headers 值形状通道）只是**复用**同一条判定 —— 依据：`git diff --stat -- src/security/` 为空，且 BASE 与 FIXED 对同一输入的判定**逐字相同**（`sk-`→`openai-style-key` / `SK-`→`null`；`Bearer …`→`bearer-token` / `bearer`、`BEARER`→`null`；`ghp_…`→`github-token` / `GHP_…`→`null`；`AKIA…`→`aws-access-key` / `akia…`→`null`）。 |
| 本轮处置（t72） | ① **`bearer` 收口**：新增 `bearer-token-anycase`（`bearer` 逐位大小写类；**不加 `i` flag**，否则 token 侧两个大小写 lookahead 会互相等价而失效）。为防英文散文过剥，token 需至少满足其一：含非字母字符 / 大小写混排 / 长度 ≥ 24 ⇒ `bearer credentials are required`、`BEARER HEADER NOT SET` 不命中。规范形态 `Bearer …` 仍由原条目命中（**命中名 `bearer-token` 与行为逐字不变**）。② **厂商前缀保持敏感**并按本条登记 + 在用例里**钉成事实**（`src/security/secret-scanner.test.ts` 的 `t72-d`）。 |
| 为什么厂商前缀不一起改 `i` | 判定是**全仓共用**的单一事实源：日志脱敏（`src/utils/logger.ts`）、导出/导入的字段值扫描（core 的 `defaultSecretScanner`）、界面渲染前的 `redact()` 都吃它。给 `sk-` / `AKIA` / `ghp_` 加 `i` 会连带放宽这三条通道的**全部**判定（`sk-` 出现在普通文本里的概率远高于 `Bearer `），而收益有限（`SK-…` 不是真实厂商形态：OpenAI 恒为小写 `sk-`、AWS 恒为大写 `AKIA`、GitHub 恒为小写 `ghp_`）。**要收必须先单独决策**，不能顺手改。 |
| 已知残余（如实登记） | ① scheme 用非规范大小写**且** token 是 8–23 个**纯字母、单一大小写**时，`bearer-token-anycase` 不命中（例如 `bearer abcdefgh`）；规范 `Bearer abcdefgh` 不受此限（原条目只要求 8+ 字符）。② 大小写变体的厂商前缀（`SK-…` 等）**仍会明文进包** —— 这是本条登记的核心边界。③ **已订正（t78，2026-10-05）**：`src/security/redaction.ts` **不再有第二份独立实现**—— `REDACTION_VALUE_PATTERNS` 现**派生自** `secret-scanner.ts` 的 `SECRET_VALUE_PATTERNS`（同一份，仅补 `g` flag），界面/日志侧 `redact()` 路径**已跟随单一来源**；防漂移守卫 = `src/security/redaction.test.ts` 的 `t78-a`（结构）/ `t78-b`（行为）。**仍存的差异（如实保留，不得写成「已彻底一致」）**：显示层比 scanner **更宽** —— 示例/占位形态（`sk-your-key-here` / `Bearer example-token-here`）scanner **放行**、`redact()` **仍掩**；base 与现状同结果，属显示层**既有产品取舍**，由 `t78-f` 钉成 characterization（t83 后范围收窄）。 |
| 影响面 | ② 的暴露面 = 「第三方 agent 配置 / 用户设置里恰好用大写前缀写密钥」，概率低但**一旦发生即明文落盘**；① 的暴露面更小（纯字母小写 token）。两者都用 `refs`/`skipped` 为空证明**不可见**（用户侧零提示）。 |
| 验证方式 | `node --test src/security/secret-scanner.test.ts`（`t72-a` 大小写变体命中 / `t72-b` 规范形态不变 / `t72-c` 过剥控制 / `t72-d` 厂商前缀边界钉事实）；真实管道：`node --test src/foreign/mcp-value-shape.test.ts` 的 `t72-e`（env/headers/args 三通道零残留 + 引用名/码可见）。 |
| 证据 | 来源 = `outputs/bug-audit/review-foreign-envhdr/REVIEW-t58-t40-report.md`（t58 的 payload 原文与谓词对照）+ `t58-verify-probe.mjs` / `t58-pipeline-check.mjs`；修复与本条登记 = t72。 |
### G-39 聊天 user 消息渲染器被本插件接管（2026-10-10：五处复刻已对齐 + 剩余差距 + abdicate 一次性 + bytes 缺失口径）

| 项 | 内容 |
|---|---|
| 背景 / 必要性 | 产品要求回退入口从「整回合一个」改为「**每条用户消息一个**」。宿主 `conversation.chat.node` 的 `user` key 是 keyed 遮蔽位、**没有 children 表**（宿主只对 turn-tail 声明了子位）⇒ framework 没有「往每条用户消息里追加 UI」的位子。唯一合法路径 = 用 `priority -1` **接管该 key 的渲染器**（遮蔽 shipped `UserMessageNodeView`）并**复刻**宿主 `UserStyleBubble` 的外观（宿主组件与其 CSS Modules 全是 ui-chat 私有、不可导入；图片仍走 owner 的 `renderMessageImages`）。实现 = `src/client/chat/ChatEntryView.tsx`（渲染壳 + 错误边界）、`src/client/chat/chat-entry-view.ts`（判定层纯函数）、`src/client/chat/chat-node-registration.ts`（登记 + 失败软化）、`src/client/chat/chat-entry-pref.ts`（形态偏好）；装配点 = `src/client/index.ts` 的 `ctx.slots.inject(CHAT_NODE_SLOT, …)`。 |
| ~~差距 ①：技能 chip 与引用 chip 的**可点开外观未做**~~ —— **2026-10-15 收回**：正文交给宿主 @@projectUserText@@（chip 与可点开一并到位），见「G-30 / G-39 增量（六）」；本行以下的排查结论保留为当时证据 | 宿主把 `node.data.referenceLabels` / `skillNames` 交给 ui-primitives 的**包私有**投影、在正文内部渲染 chip 并支持点开文件 / 技能；本仓库拿不到那个投影。**2026-10-10（t9）已复刻两项纯文本能力**：正文会话线格式 `@[label](dsh-session:…)` → label（`CHAT_SESSION_WIRE_RE` + `projectChatEntryText`，**气泡与崩溃降级两条路径都投影**），以及 `referenceLabels` 非空时的**引用摘要行**（`chat.entry.referenceSummary`，元素带 `data-ref-chip`）。**仍未做**：`skillNames` 不接线（不渲染、不编造文字）、chip 外观不可点开。**注意**：t5 的 DOM 探针拿 `[data-ref-chip]` 当技能 chip 的**代理**，其翻转属**探针侧副作用**，**不得**据此声称我们渲染了技能 chip。 |
| ~~差距 ②：文件类型图标**仍是扩展名徽标**~~ —— **2026-10-15 收回**：优先用宿主 @@FileTypeIcon@@，扩展名徽标降为回落，见增量（六） | 宿主文件卡 = ui-primitives 的 `FileTypeIcon` + `fileExtension` + `fileSizeText`；`FileTypeIcon` **不在其导出表**，不可复用 ⇒ 我们仍用**扩展名徽标**（`.chatFileExt`）。**2026-10-10（t9）已把扩展名口径按宿主对齐**：取最后一个 `.` 之后、**前导点算后缀**（`.gitignore` → `GITIGNOR`）、8 字符截断；体积走 `fileSizeTextOf`（无空格；单位值 < 10 才一位小数，否则取整；读不到不渲染）。**形状不同，不是等价替代**（图标本身这件事未解决）。 |
| 差距 ③：时间固定 **24h 补零 `HH:mm`**、仍**不做「今天 / 昨天」** | 宿主 `MessageIconActions` = `formatMessageClock(time, t, day)`（首行固定 24h 补零，非当天再带日期归属，含非公历日历）。**2026-10-10（t9）已把格式对齐首行**：`pad2(getHours()) + ':' + pad2(getMinutes())`（本地时区不变；此前 `toLocaleTimeString` 在 en-US 下会显示 `05:04 PM`）。**仍未做**：今天 / 昨天等日期归属。时间戳非数字毫秒一律不显示，**绝不编造当前时刻**。 |
| 附加观感差异（已追认，不修） | ~~气泡底色 `--cm-surface-2`（宿主 `--dsw-specific-bubble`，本仓库 token 层无此档）~~ —— **2026-10-15 收回：它不是「近似」而是功能级不可见（浅色主题下与页面同色），已修为跟随宿主 token，见「G-39 增量（五）」**；~~正文 12.5px（宿主 14px）~~ —— **2026-10-17 收回：它不是「近似」而是用户设置失效**（DSH 的「内容字号」对用户自己的消息没有作用），已改为跟随宿主活值（字号 / 行高 / 限宽三条），见「G-39 增量（七）」；仍保留：圆角 `--cm-r-3` = 8px（宿主 14px）；**动作行常显**（宿主 hover 才显形 —— 回退入口需要可发现）；**无宿主同款 tooltip**（用原生 `title`）。逐像素一致必须先扩 `DESIGN.md` §3–§5，本任务明确不做。 |
| 复核发现的 5 处复刻偏差（**均已按宿主修齐**，2026-10-10 t9） | D1 compact = 附件总数 > 1（此前是图片数）；D2 附件按 content 原始顺序（此前固定「先图片后文件」）；D3 体积文案逐字复刻（无空格；单位值 < 10 才一位小数，否则取整）；D4 时钟固定 24h 补零（此前 `toLocaleTimeString`）；D5 正文会话线格式 + 引用摘要行（此前把内部语法原样上屏）。另附带把 dotfile 扩展名口径按宿主对齐（前导点算后缀 + 8 字符截断）。护栏：`chat-entry-view.test.ts` **31** 条；复核探针前后对照（node 探针两条偏差断言 FAIL→PASS、真浏览器 DOM 32/32）。 |
| 崩溃降级只保留正文（**已知差距**） | 我们这条路径 = **只保留正文纯文本**（`buildChatEntrySafeRow` + `plainTextOf`：文本块；rest 块以 JSON 短表示兜底；附件只留文件名）；**宿主没有等价路径**。**2026-10-10（t9）**已把会话线格式投影接进降级文本（`dsh-session:` 不会在降级气泡里原样露出）。如实登记：该路径下附件 / rest 结构信息会丢，只保证「消息不消失、正文可读」。 |
| bytes 缺失时的**有意差异** | 宿主 `fileSizeText` 在字节数读不到时会渲染 `NaNGB`；我们**不渲染**（`fileSizeTextOf` 读不到回 null → 整段不显示）。这是**有意更诚实**、不是缺陷；「宿主有我们没有」的清单里不再包含它。 |
| 宿主级 **abdicate 是一次性、不可复活**（用户可观察） | ui-renderer 的 per-entry 边界崩溃时调 SlotCore 的 `reportEntryError({ abdicate: true })`：宿主把已 abdicate 的条目记进 `WeakSet`，**只有 `has` / `add`、没有任何 revoke 路径**（`if (this.abdicated.has(entry)) return; this.abdicated.add(entry)`），`entriesOfSlot` 对该条目**永久跳过**（登记行仍在台账、dispose 权仍归登记者）。证据（独立复核，与真机 app.asar 副本逐字节相同）：`.tmp/r1-probe/t5.bundle.js:18911-18918, 19140, 19306-19316`；语义探针 `.tmp/r1-probe/slotcore.mjs` **10/10**（S8「abdicate 后宿主条目成为幸存者」、S9「台账行保留、投影跳过」）。**推论（必须如实写）**：我们渲染器崩溃一次后，**同一条消息在那次登记的生命周期内永久交回宿主渲染器**（消息仍在 —— fail-soft 正确）；`dispose → register` 会创建**新的**条目（不在该集合里）⇒ **切档 / 重挂可以重新接管**。**不得**写成「刷新就能恢复」或「可以撤销」。 |
| 形态偏好：**同一页面内即时，跨标签页不即时** | 偏好按**浏览器**存 localStorage（键 `dcm.chat-entry-mode`），热切换靠 `subscribeChatEntryMode` 的**进程内订阅**；**没有 `storage` 事件监听** ⇒ 同时开两个 DSH 标签页时，另一页要**下次加载**才跟上。面板文案「切换立即生效（无需重启、也无需刷新）」指的是**当前页面**；两处口径必须一致 —— **不得**写成跨标签页即时。 |
| 升级错位风险（**本条目存在的主要理由**） | 接管渲染器 = **我们的 bug 可能影响用户消息显示**；且宿主升级若改动用户消息渲染器 / 槽位契约，我们的复刻会**老旧或错位**。已落地的三道软失败：① 整条子树包在 `ChatEntryErrorBoundary` 里，抛错即降级为**纯文本气泡**（文本仍可见 + `data-chat-entry-fallback` 标记 + ASCII `console.warn`）；② 该边界也失败时，ui-renderer 的 per-entry 边界会让本登记 `abdicate`、退回宿主渲染器（**一次性、不可复活** —— 后果与证据见上一行）；③ 声明形态不是 `keyed`（0.1.x 契约不同）就**跳过注册**，回合号取不到（`node.location` 形状漂移）就**如实禁用按钮**（每个禁用原因有自己的字典键）。**不承诺**「宿主升级后外观不变」。 |
| 有意例外：错误边界是 **class 组件** | React 18 只有 class 能声明 `getDerivedStateFromError` / `componentDidCatch` —— 这是本仓「函数组件 + hooks，无 class」规范的**唯一显式例外**（例外点只有 `ChatEntryErrorBoundary` 一处），已写进 `DESIGN.md` §6、`docs/lessons/recovery-console.md` 与 `AGENTS.md` 的开发规范行。**不得**据此类推引入其它 class 组件。 |
| 开关与生效（**T2 已交付**） | 面板入口 = 「工作区与会话回滚」卡（`RollbackCard`）上的两档开关（`per-message` 缺省 / `turn`），写入只走 `writeChatEntryMode`（值真变才通知；storage 写失败则回读真实值 + 显示「这次切换没有生效」，**界面不停留在假状态**）。**同一页面内即时生效；跨标签页不即时**（无 `storage` 事件监听，见上一行）。**绕过 `writeChatEntryMode` 直接改 localStorage 只有下次加载生效**；偏好为 `turn` 时**一次都不注册**（宿主渲染器原样工作）。 |
| 验证方式 | `src/client/chat/chat-entry-view.test.ts`（**31** 条：槽位常量与 priority -1 / pref 缺省·非法值·storage 缺失 / 热切换 / 登记三道门与抛错被吞 / steering 不接管 / 回合号与相位判定 / 按钮状态机六种禁用原因各自可证 / 回滚点列表每会话只读一次 / **附件有序投影与 compact 旗标** / 文件卡与体积 8 档 / **24h 补零时钟** / **会话线格式与引用摘要** / rest 兜底不丢块 / 错误边界降级 / zh+en 键集一致）。复核侧另有：t4 的 SlotCore 真机副本探针 `.tmp/r1-probe/slotcore.mjs` **10/10**（本文件由 qa 复跑复现）、t4 的 node 探针 `.tmp/r1-probe/probe.bundle.cjs` 与真浏览器 DOM 探针（t5 复核：**pass、0 findings、DOM 端到端 32/32**）。**NOT VERIFIED**：没有在**真实 DSH 聊天流**里的渲染与点击取证（本仓 React 无组件测试框架；探针是自建 harness）—— 见 §5。 |
### G-24 剩余未做项（M1 复核，2026-10-06）

> 本轮（M1）落地清单与口径见 git 历史（2026-10-28 精简前版本）的「M1 落地」「M1 口径」两行。以下是**仍未做**的部分，逐条登记：

| 项 | 内容 | 现状 |
|---|---|---|
| ① | **header 重建**（首帧不可读时按目录名 + 最早可解事件重建）——设计稿 §10.2 视为「低损失」，但**重建 header 等于发明数据**，需先确定不与「绝不猜」冲突 | ❌ 未做 |
| ② | **跨版本转码**（把 pre-v4 代际真正升级成当前代际并发布新 generation） | ❌ 未做（真 codec 门只**验证**，不改写代际） |
| ③ | ~~**issue code 的 UI 本地化**~~：**✅ 已修复（2026-10-08 UX 审查）**——新增 `src/ui/session-issue-labels.ts`（19 条码 → `sessions.issue.*` 词典键，`satisfies Record<SessionHealthIssueCode, string>` 让 core 新增码漏配即编译失败；未知码回落 `sessions.issue.unknown`，**绝不裸渲染**），`RecoveryPanel.tsx` 的两处渲染点（会话体检行 + 布局归位候选行）改走它；zh/en 词典各补 20 键。护栏 `src/ui/session-issue-labels.test.ts`。**仍保留**：issue `detail` 不进 UI 模型（`SessionHealthDisplayRow` 只有 `issueCodes`）—— 本轮不动 | ✅ 已修复（detail 仍未上屏） |
| ④ | **磁盘级恢复**（会话目录/索引层面的重建与修复） | ❌ 未做 |
| ⑤ | **真 codec 门是低覆盖护栏**：官方 catalog 只在 DSH 安装树（桌面端在 `app.asar` 内），磁盘副本可能是旧代际且没有 children 版 API；本机 1195 units 中最新代际 v0=**442** / v3=**522** / v4=**231**（< v4 占 **80.67%**）。细化：默认解析下 **v0 与 v4 均 `unavailable`**（v4 因 catalog.currentVersion 3 ≠ 4），**v3 是例外**（`header.version === 该 catalog 的 currentVersion`，静态版按 API 闸门放行并 `verified`）；**asar 抽取已作为产品路径（M2，2026-10-07）**：`src/utils/asar-read.ts` 把安装树里的 `app.asar` 抽取成临时候选根，且**版本解析与 catalog 候选规划共用同一条锚点链**（安装锚 → 环境锚 → 运行时锚 → profiles 树），避免两者从不同锚点互相自证；仍读不出来时如实 `unavailable`（`verify.verified=false`、不写成功台账） | ⚠️ 已知（护栏而非全库体检；M2 已把 asar 接成候选锚） |
| ⑥ | ~~**React 面板仍把 `unavailable` 的修复呈现为成功**，且**未映射** `verify-failed` / `target-changed` 两个新 reason~~ | ✅ 已落地（M2，2026-10-07；checkpoint `45c34f2`）：面板改走 `src/ui/session-verify.ts` 的同源判定 —— `verify.verified=false` 一律渲染为「未验证」而不是成功，新增 `verify-failed` / `target-changed` 两个 reason 的文案键（未知 reason 回落 `unknown`，**绝不渲染裸码**），并补了「结果不被无关操作清空」的回归断言。**另一条同源缺陷也已修（M2，`506f767`）**：批量修复的失败分支曾丢 `verify`/`rolledBack`，导致 `rolledBack:false`（可能处于中间态）在面板上与成功无异 |
| ⑦ | （后续建议，未实现）体检按**文件名**取「最新一份日志」，而官方 `resolveCurrentLog` 对 pre-v4 视为「没有当前日志」——建议把「本机 DSH 不直接读该代际（pre-v4，需迁移）」做成**可见告警**，否则体检会对 DSH 根本不会打开的代际下结论 | 💡 建议 |
| ⑧ | **新增检测的 client 渲染未验证**（契约明确本轮不改渲染路径；新码会以英文 token 上屏） | ❌ 未做 |
| ⑨ | **两条低危观察（只登记，不改代码）**：<br>· **空事件日志（仅 header）**当前返回 `verification-refused` 而非 `nothing-to-fix`（真机无此形状）。<br>· **`buildFramePlan` 的 `reliable` 兜底按构造不可达**（防御性代码）。<br>· 另两条**刻意更宽的检测判据**：结果缺 `surfaceOp="append"`、或仅有 `tool/call` 行而无内容块声明 —— 全语料 1201 份实测 **0 命中**（89,489 条 `tool/result` 中 381 条非 append，但同一次遍历里官方 pending 与实现判据的 dangling 计数 **2 vs 2、delta 0**；`tool/call` 的 callId **89110 条全部有内容块声明**），登记为已知差异，**改窄需先有真机证据** | ⚠️ 登记 |
### G-24 之后：M2 的三条非阻塞观察（2026-10-07，captain 裁决：O2 已修，O1/O3 登记不改）

> 来源 = E4 第三方评审（`.tmp/m2/e4/E4.md`）在 verdict=pass 之外给出的观察。**O2 与「两侧诚实」直接冲突，当轮修复**；O1/O3 涉及刚通过 E3 探针与 E4 评审的写路径，**本轮只登记、不改代码**（改动会使既有验证结论失效，应单独走一轮修复+复验）。

| 项 | 内容 | 裁决 |
|---|---|---|
| O2 | `sessions.layout.refreshHint`（zh/en）原写「失败项已逐条回滚」，但失败项可能是 **`rolledBack:false`（回滚自身失败）** —— 该句会把「回滚失败」说成「已复原」，与 `src/ui/session-layout-view.ts` 的「回滚绝不给 ok」判定矛盾 | ✅ **已修**（M2）：改为「已逐条**尝试**回滚，回滚失败的项会单独标红（绝不显示为已复原）」/ 英文对应句；键位与其它文案不变 |
| O1 | `src/utils/session-layout-repair-service.ts:181-185` / `:192-194` 对**子目录读失败静默跳过**，与同一页体检（`scanSessionHealth` 的 `unreadableEntries`）口径不一致：读不到 projectKey 目录时用户看到的是「没有要修的东西」 | ⚠️ **登记不改**：建议后续把不可读子目录计数进计划（`needsAttention` 或专用告警行），并补反向断言（造 EACCES 目录 → 计划必须显式报告而非静默） |
| O3 | 计划**不预演静止期门**（`busy` 只在 apply 侧判定）⇒ 预览的「将搬运 N 条」偏乐观；apply 侧如实记为 `busy` 且零写入（E3 探针 §1/§6 已覆盖 apply 侧） | ⚠️ **登记不改**：建议后续在计划里标注「N 条疑似活跃使用，应用时可能被拒」，或让计划也做一次只读静止期探测 |

---
### G-40 合并裁决只到**分区级**：一个分区里的多条冲突不能分别裁决

| 项 | 内容 |
|---|---|
| 事实（冻结口径） | 裁决粒度 = **分区**：`MergeResolution.id` 就是 `SectionId`，四动作（保留本机 / 采用远端 / 采用自动合并 / 暂不处理）整分区生效；界面冲突明细行**只做展示**，并常驻写明「冲突按分区整体裁决（本版不做逐条裁决）」。 |
| 能力缺口 | 同一分区里若有多条冲突且用户想「这条保留本机、那条采用远端」，当前无法表达：任一选择都会整分区生效。JSON 分区的多条键冲突 / 文件类分区的多个文件冲突都在此列。 |
| 影响 | **无数据损坏**（选择语义是整分区，界面对此有明示；未裁决分区计入待裁决且基线不推进）。缺的是更细的表达力，不是安全护栏。 |
| 为什么不做 | 文件类分区的「半文件」语义不存在（无法只采纳一个文件冲突的本地侧而把另一个文件冲突按远端合成出确定的 merged）；JSON 点号路径合成可行但与文件类语义不对称，需单独定义。 |
| 建议 | 需要更细粒度时，按「一次只留一条冲突」拆轮（先整分区采用一侧 → 下一轮再处理剩余），或引入路径级裁决 + JSON 专属语义（文件类明确拒绝）。 |
| 验证方式 | `node --test "tests/sync-merge/merge-resolution.test.ts"`（分区级四动作与基线纪律）；`node --test src/client/sync/merge-view.test.ts`（草稿/批量/请求体构造）；界面文案见 `src/client/sync/sync-locales.ts` 的 `merge.*`。 |
### G-41 文本合并是**行级**、不做行内字符级：同一行双方各改一半 → 整行冲突

| 项 | 内容 |
|---|---|
| 现象 | 行级三方合并以「行」为最小单位；同一行内两侧各自改动不同位置（例如同一行的不同片段）会被判成重叠 → 冲突。 |
| 影响 | 只在「同一行被双方同时修改」时命中；用户需手工二选一，可能放下另一侧的一半改动（**不静默**：冲突可见且携带两侧原文）。 |
| 边界 | 超过文本合并字节上限 / 二进制文件根本不尝试文本合并（分别以 `too-large` / `binary` 如实登记）。行级是**有意的保守取舍**：行内字符级合并的定位猜测风险更高。 |
| 验证方式 | `node --test "tests/sync-merge/merge-granular.test.ts"`（不同行合并成功 / 同一行冲突 / CRLF 保留 / 二进制拒绝 / 数组拒绝）。 |
### G-42 gist 通道**无条件写**且不外置：索引并发保护弱于其余三条通道

| 项 | 内容 |
|---|---|
| 现象 | **端点拒绝一切条件请求头**：`PATCH /gists/{id}` 对任何 `If-Match`/`If-None-Match` 都回 400（与 ETag 强弱无关，issue #110，`src/sync/gist/gist-transport.ts:63-72`）⇒ gist 的索引写只能无条件写，改用**写后复核 + 最多 3 轮重做**（`:263-298`、`verifyIndexLanded` `:309`），仍被覆盖则抛 `sync.gist.indexConflict`；同时 gist 刻意不做内容寻址外置（G-34）。**残余窗口**：别人在「我们读索引」与「我们 PATCH」之间的写入发现不了，两台设备同时 push 仍可能丢条目（git / webdav / s3 已由条件写挡住）。 |
| 影响 | 丢失的是**索引条目**（快照文件本身仍在 gist 里），该快照从列表消失；gist 不外置 blob，故无 blob 连带损伤。 |
| 现状 | 属已登记的**能力边界**（spec §7.5），不是遗漏；读不到/被截断时的保守行为见 G-34。**文本服务端事实与残余窗口的唯一权威是 `docs/maintenance/known-limits.md` 第 6 条**（平台行为、仓内不可证），本表只记「同步通道怎么应对」。 |
| 验证方式 | `node --test src/sync/gist/*.test.ts`；spec §7.5 能力边界表。 |
### G-43 合并相关的新状态/新字段**不做协议协商**：旧版插件读到时的行为边界

| 项 | 内容 |
|---|---|
| 现象 | ① 设备侧状态新增待裁决记录与设备身份字段：旧版插件读取时按「未知字段忽略」处理（不会报错），但会丢掉待裁决记录 —— 下一轮重新合并、冲突重现，**不丢数据**；② 旧版插件不认识合并预览语义，仍按两方差异整分区裁决；③ 快照 manifest 的设备身份 / 源机 home / 会话墓碑同理：旧读侧忽略未知字段。 |
| 边界 | **同步通道两端应使用同一插件版本**（与 G-19 同一口径）；本格式不做版本协商。 |
| 影响 | 混合版本不是数据损坏路径（未知字段忽略 + 冲突始终可见），但「逐项裁决 / 设备识别 / 跨机重定基」在旧侧不生效。 |
| 验证方式 | `src/sync/sync-state.test.ts`（未知字段忽略与版本迁移）；`node --test "tests/sync-merge/contract.test.ts"`（字段集合闭集）。 |
### G-44 「保留本地」裁决的传播窗口：第三方设备的后续推送会被静默采用

| 项 | 内容 |
|---|---|
| 现象 | 在合并裁决里对某分区选「保留本地」后，引擎把**该分区的本地值**记为新的共同基线（祖先副本 + 各分区 hash）。若此后**第三台设备**推送了该分区的新版本，本机相对基线未变 → 三方判定为 `useRemote` → 下一轮同步**静默采用远端**，用户刚才明确保留的本地值被替换。窗口 = 「本次保留本地」到「本机把该分区推上去」之间。 |
| 根因 | `recordBaseline` 的「祖先副本」与 `state.sections` hash **一参两用**：既表示「共同祖先内容」，又表示「本机已同步内容」。保留本地后两者合流成「本机值」，引擎无法再区分「本机刚选的值」与「双方早已一致的值」，于是第三方推送被当成单侧改动。根治需要把「共同祖先」与「本机基线」拆成两份状态（接口级改动）。 |
| 影响 | 用户显式裁决可能被后续同步覆盖（不是静默丢数据 —— 远端值成为新的本机值，但用户并不知道自己保留的值被换掉了）。只影响「保留本地」且**有多台设备继续推送**的场景。 |
| 现状 | **本批有意不修**（拆接口超出本轮范围）。缓解（窗口内可选）：选「保留本地」后**立即 push 一次**（把本地值变成远端最新），或开启自动同步让本机版本尽快上行；在完成之前不要让第三方设备推同一分区。 |
| 验证方式 | 源码路径：`src/sync/sync-engine.ts` 的 `applyMergeResolutions`（keepLocal → `merged = inputs.local[section.id]`）→ `applyMergePlan` → `recordBaseline`（按实际落地本地导出记基线）；三方判定见 `src/sync/merge.ts` 的「localHash == ancestorHash → useRemote」。复现思路：A 与 B 冲突 → A 选 keepLocal → 第三台设备 C 推送该分区新值 → A 再次 merge，决策应为 `useRemote` 且 `merged` = C 的值。 |
### G-45 `applyItems` 不消费 `pendingMerge`：一键同步不会清掉 apply-merge 留下的待裁决记录

| 项 | 内容 |
|---|---|
| 现象 | 合并路径（`/sync/apply-merge`）留下的 `pendingMerge`（还有哪些分区未裁决）只由合并路径自己收口（再次 apply-merge 时清除或更新）。**一键同步**（`/sync/apply-items`）走 `applyItems` → `recordBaseline`，既不读也不清 `pendingMerge`（该参数缺省 = 不动）。于是用户「先合并、后一键同步」时，旧待裁决记录会继续留在状态里，界面可能继续提示「仍有冲突待裁决」，与实际状态不一致。 |
| 影响 | 状态展示层面的不一致（不会写坏配置：待裁决记录只是提示与基线纪律的辅助状态，不参与合并判定）。两条写路径的状态收敛只保证在 apply-merge 一侧。 |
| 现状 | **本批有意不修**：applyItems 的历史语义（一键同步）与合并裁决是两条独立入口，让 applyItems 消费 pendingMerge 需要先定义「一键同步覆盖了冲突分区时 pendingMerge 如何折算」，属产品决策。 |
| 建议 | 二选一：① 一键同步成功后按「本次实际应用的分区」从 pendingMerge 中剔除；② 界面在 apply-items 路径下明确忽略 pendingMerge（并在文案里说明「待裁决状态只由合并裁决维护」）。 |
| 验证方式 | 源码：`src/sync/sync-engine.ts` 的 `recordBaseline` 参数 `pendingMerge`（缺省不动，line ~1761/1799）与 `applyItems`（line ~1983，不传该参数）；复现思路：apply-merge 留一条 pendingMerge → 跑 apply-items → 再读 `sync-state.json`，pendingMerge 仍在。 |

## 4. 不是缺口、但已知的有损点

来自 `tests/conformance/README.md` §3.2 与规格 §7.3：

- **`prompts` 的 `systemPrompt` 形态**：源 namespace / patch 行里是字符串 `systemPrompt: "…"`，导入落盘形态为对象 `{ persona: "…" }`。persona **文本**无损，但字段**形状**改变（`RT-01` 已注明）。
- **已知分区内的未知字段不写回目标（分区相关，勿一句话概括）**：导入不是 round-trip 复制，而是把已知语义落到目标。规格 §7.3 实测结论是**分区相关**的：`settings` / `ui` / `mcp` / `prompts` / `credentialsStatus` → 未知字段不写回；`workspaces[]` 记录、`plugins.patch[].raw`、`providers.raw` → 会随「整体搬运」落到目标。因此**不要声称「未知字段会被保留到目标」，也不要声称「一律被丢弃」**。
- **文件类分区的 secret 命中不剥离内容**：G-09 修复后只「报告 + 告警」，命中的文件内容**原样进包**（见 git 历史 G-09 的边界）。
- **`mcp` 分区的同步语义（issue #78，2026-10-09 起）**：`mcp` 是**可选分区**（`syncOptIn='auto'`），不勾就不进同步通道；勾选后手动与自动同步都带。三条已知边界：① 内容里 `command` / `args` / `cwd` 是**机器相关**的 —— 绝对路径或目标机缺 `npx` / `uvx` 运行时，配置照样写入，但服务器在目标机可能起不来（靠导入分析期告警，不是拒收）；② 拉取侧 `mcp` 是 `medium` 风险 → 落**差异确认（review）**，自动同步不静默写入；③ HTTP 型 server 的 `env` / `headers` 会随包走，未经 `includeSecrets` 时经 `SecretScanner` 脱敏（与普通备份同口径）。
- **离线 CLI `backup` 收不到插件注册表里的技能**：GUI 导出经 `ctx.skills` 收编外壳技能（见 git 历史 G-33），而 CLI 有「绝不 import `@deepseek-ai/*`」的硬约束（`src/core/backup-plan.ts:6-10`），只能扫 `$DSH_HOME/skills` 目录；真机上该目录可能**根本不存在**，此时 CLI 备份的 `skills` 分区为空，并在报告里如实列为空分区（`分区无内容，未写入 / section empty, skipped: skills`）。这是**有意的能力边界**（不是静默丢失，也不是 G-33 的残留）：要完整的技能备份请在 DSH 健康时用 GUI 导出。

## 5. 明确未验证的空白（不是「已验证」）

以下区域本轮**未被测试覆盖**，列为空白而非通过：

| 空白 | 原因 |
|---|---|
| `plugins` / `mcp` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的往返 | 需要 `npm install` 或更多 mock 编排 |
| 整体加密容器 `DCA1`（`encryptArchive` / `verifyEncryptedBlob`） | 本轮一致性套件只覆盖 `secrets.enc`（`DSC1`）路径 |
| 规格可独立实现性的 4 处缺规格 | 见 `docs/spec/bundle-format-v1.md` §11 与 T6 审计结论：压缩方法容错边界、`relativePath` 归一化、5 个分区的未知字段写回行为、`redactedHits` 的持久化语义 |
| `tests/**` 未被根 `tsconfig` 的 `include` 覆盖 | 根 tsconfig 只 include `src/**`，`tests/**`（228 个文件）曾长期处于类型检查范围之外——这正是下面那条 43 条错误得以积压的原因。**更正**：早期记录里写的「本轮用临时 tsconfig 单独验证通过」与实测矛盾，同口径复测（`tsc -p tsconfig.tests.json --noEmit`）得 **43 条错误**，真实结论是**未通过** |
| `tests/**` 的类型错误（曾实测 **43 条**，0 条在 `src/**`） | **已收口**：43 条全部修完（只改 `tests/**`，未放宽任何编译选项），`tsc -p tsconfig.tests.json --noEmit` → **exit 0**；工程配置 `tsconfig.tests.json` + `npm run typecheck:tests` 已落地，并在 `.github/workflows/ci.yml` 的 `Typecheck` 之后接入 `Typecheck (tests)` step。**历史信息（保留）**：接 CI 之前，`tests/**` 是类型检查盲区，43 条错误按码分布为 `TS2345`×15、`TS6133`×8、`TS2339`×7、`TS2740`×6、`TS2739`×2、`TS7006`×2，其余各 1 |
| 非 npm 包管理器对 `peerDependenciesMeta.optional` 的处理 | P-1 的隔离安装结论只覆盖 npm（见 git 历史 P-1 的「未验证边界」） |
| 普通导入（GUI 向导）是否恒使用 `parseZipHardened` | 需追宿主注入链，超出取证范围（规格 §11 已登记） |
| `source.platform` 取值是否被严格校验为枚举 | 源码只校验 `typeof === 'string'`（规格 §11 已登记） |
| `sessions` 分区（`includeSessions: true`）内未知字段的行为 | 结构上不可能承载未知字段，未单独跑一次实测（规格 §11 已登记） |
| 离线 CLI `backup` 在真机（`$DSH_HOME/skills` 不存在、技能全在插件注册表）上的技能覆盖范围 | CLI 只扫 `$DSH_HOME/skills`（§4 已列该边界）；「注册表技能在 GUI 导出侧确实被收编」有单测与真机导出取证，但 CLI 侧的空分区行为只有源码级推理，**未跑真机 CLI 验收** |
| 工作区 + 会话回滚的**真机端到端** | 未在真实 DSH 进程内订阅 `session/event` 并调真实 `ctx.sessions.fork`；证据 = `src/index.ts` 装配源码 + 引擎单测（R-02/R-03/R-12/R-18），不是「跑通了」 |
| 回滚卡与聊天入口的**浏览器点击** | 本仓 React 无组件测试框架；验证止于 `src/ui/rollback-view.ts`、`src/client/chat/rollback-entry-view.ts` 的纯函数单测与静态守卫。**2026-10-10 三修同样没有真机点击取证**（证据 = qa 的自造反例 + 源码 / 产物断言，见 本节）。用户可 2 分钟自验：① 刷新设置页 →「工作区与会话回滚」卡 → 形态开关选「每条用户消息」；② 发一条消息并等该回合结束 → 动作行应只有**一颗** ⟳ 图标；③ 点它 → 标题「回退预览」，正文只有文件行（+N 行 / −M 行）或一行「工作区与该回退点一致，无需恢复」，底部只有「回退」/「取消」；④ 不改文件直接点「回退」→ 应出现**成功**徽章而不是「错误 500」；⑤ 切到「整回合」档 → 该消息上应没有图标、回合尾出现一颗。 |
| 每条用户消息入口的**真实 DSH 聊天流**渲染与点击（接管 `user` 渲染器后） | 本仓 React 无组件测试框架；验证止于 `src/client/chat/chat-entry-view.ts`（判定层纯函数）、`chat-entry-view.test.ts`（**31** 条）与复核自建的探针 harness（node 探针 + **真浏览器 DOM 端到端 32/32**、SlotCore 语义 10/10）—— **探针 harness ≠ 真实 DSH 聊天流**。与宿主气泡的剩余差距（技能 chip / 文件类型图标 / 日期归属 / 动作行常显 / 无 tooltip / 崩溃降级只保留正文）**只做过源码级对照**，没有真机截图对照；`priority -1` 遮蔽在真实聊天流里的表现（多 cell 并存、分页重挂）、以及 **abdicate 一次性的真机复现**未取证 |
| capture 侧跳过清单的**可见性**（**已落地：t18，2026-10-10**） | t13 的三个字段经 `rollback-view.ts` 的 `noticeKeys` + `rollbackPreviewWarnings()` 到了视图层，`RollbackCard.tsx` 渲染 warn 徽章 / 行内提示；实证 = 真机引擎产出的截断点驱动视图（`.tmp/probe-t8-skip.ts`：`skippedCount=1` / `truncated=true` / `noticeKeys` 两条，fail=0）。**不再是空白**。 |

---

## 6. 外部 Agent 会话导入的能力缺口（2026-10-06 全量审计）

> 本节记录 2026-10-06「所有外部 Agent 会话导入」全量排查（8 个只读/实施审计，对照 dsh-chat-import `main`）后**仍然存在**的缺口。
> 每条都已做到「**逐类计数可见、绝不静默丢弃**」，但正文/语义没有真正迁移。状态口径：⚠️ = 能力缺口（非本轮范围内可闭环）。

| 缺口 | 说明 | 当前状态 |
|---|---|---|
| F-01 | **IR 无 reasoning 承载块**：外部来源的 thinking / reasoning 正文（qwen `thinking`、continue `thinking`/`reasoning`、workbuddy `reasoning`、grokbuild/reasonix `reasoning_content`、kimi `ThinkPart`/`content.part(think)`、goose/crush/zed `thinking`、pi/openclaw `thinking`、opencode `reasoning`）只能落 `unsupported-session-record` 计数 | ⚠️ 需共享层：`session-ir.ts` 的 `IrBlock` 增 reasoning 变体 + `synthesizeDshRows` 支持（并确认 DSH codec 接受该块） |
| F-02 | **无会话级摘要 / 压缩检查点通道**：zcode `part.summary.body`、opencode compaction、grokbuild `compaction_meta`、crush `is_summary_message`、zed `Compaction`、kimi `context.apply_compaction`、mimocode 后台任务等只计数 | ⚠️ 需共享层：合成器原生压缩检查点（`session-ir.ts` 自述「压缩属于待办能力」） |
| F-03 | **无 image / 附件块**：opencode `file` part、vibe `images`、kimi 媒体、codex `input_image`/data URL 等只落文本占位（`[image: …]`）或计数 | ⚠️ 需共享层：IR 增 image 块 + 宿主附件落盘 |
| F-04 | **Copilot CLI 会话未实现**：配置目录表列有 `session-state/` 与 `session-store.db`，但**官方未给格式**、参考实现 dsh-chat-import 的 FORMATS 里也没有 copilot | ⚠️ **只有位置、没有格式取证** → 不按猜的 schema 读库；拿到真实样本/官方格式说明后再实现 |
| F-05 | **Cursor 会话的 posix slug 不解码**：`<slug>` 有损编码，仅对 Windows 盘符形态做「逐段存在性贪心解码」；macOS/Linux 未取证 → 该平台 cursor 会话全部按 `session-missing-cwd` 诚实跳过 | ⚠️ 拿到真机 posix slug 后再扩展 |
| F-06 | **Codex 分页 rollout 不归并**：同一 thread 的多页（文件名 `_<pageId>` 后缀）各自成会话；同 `payload.id` 时报 `session-id-conflict`（可见） | ⚠️ 需 `groupCodexThreads` 级实现 |
| F-07 | **Cursor / Codex 会话层只到 fixture 取证**：本机无 `~/.cursor` / `~/.codex`，truth-table 的 evidence 保持 fixture/documented，**未经真机验证** | ⚠️ 真机取样后才能升级 |
| F-08 | **reasonix-lineage（恢复分支折叠）未实现**：祖先/分支文件被当独立会话导入 | ⚠️ 参考 `lib/convert/reasonix-lineage.mjs` 全未搬 |
| F-09 | **`dsh` / `dsh4` 跨代次不做重编码**：保持**逐字节直通**，且要求 `header.version` 严格等于目标机版本；v0–v2 与 V3↔V4 迁移会整批 `session-format-unsupported` | ⚠️ 有意设计（字节直通优先），跨代重编码是独立特性 |
| F-10 | **`$TELEAGENT_HOME` 只认绝对路径**（参考直接采信该值，本仓走 `absoluteEnvPath`） | ⚠️ 口径差异（更保守），对齐需同时改 `read-teleagent.ts` / `teleagent.test.ts` / 真值表 |

---

## 已关闭项去哪找

```bash
git show 6f2864b:docs/maintenance/known-gaps.md | less        # 精简前完整版（含 §1 已修清单、§2 审计发现、B1/B2、L1–L4、G-18 取证）
git show 6f2864b:docs/maintenance/known-gaps.md | grep -n 'G-18'   # 取单条原文
```

精简前被移出本文件的内容：§1「本轮已修复的缺口」21 条逐条取证、§2 / 2b / 2c 审计发现（G-12、G-13、B1、B2 与其余缺陷）、G-30 与 G-39 的 15 条「增量」修复日志（均为已完成的一次性修复记录）。