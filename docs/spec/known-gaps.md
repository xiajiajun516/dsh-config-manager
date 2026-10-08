# 已知缺口登记（known-gaps）

> 本文件登记 bundle 格式 v1 规格化过程中**实测确证**的实现缺口，并逐条给出**当前状态**。
> 每条缺口都有可执行的证据来源，不是推测。
>
> **性质说明**：这些是「现有实现」与「基础设施应有的行为」之间的真实差距。它们**不是**待办清单，而是两类读者的风险提示：
> - 对**第三方实现者**：照抄**已发布版本**的行为会继承这些缺陷；
> - 对**本项目维护者**：这些是需要按状态决策修复/复核的项。
>
> 权威来源：
> - `docs/spec/bundle-format-v1.md` §10（规格侧缺口表，含逐条取证与「基线 vs 当前工作区」双栏）
> - `tests/conformance/README.md` §3.1（特征化测试断言表）
>
> **修复流程**：见 `tests/conformance/README.md` §4。修好缺口时，特征化测试（`FC-01` / `VER-03` 等）会红灯提醒，需同步更新断言、规格 §10 缺口表与本文件。
>
> **状态口径（必读）**：本文件的「已修复」指**当前仓库工作区**的源码已不再具备该缺陷，且**有可复现的验证方式**（测试或隔离安装）。npm 上**最新已发布**的版本是 `v0.1.58`，它**仍带全部基线缺陷**；当前工作区已修复它们，并将以 `v0.1.59` 发布（原计划的 `v0.1.60` 已并入 `v0.1.59`，因为 `0.1.59` 从未发布）。行号是写作时逐条读源码核对的快照，源码仍在并行修改，检索时请以**符号名 / 消息 key** 为主锚点。
>
> **B1–L4 的性质**：这九条**不在** `0.1.59` 基线里，而是**本轮修复过程中由独立对抗性审计发现的新缺陷**（其中 B1 与 B2 是**本轮修复自身引入**的：新增告警第一次把包内可控字符串送进 UI 通道，而新写的源码守卫只测了符号存在性）。列出它们是为了留下完整记录——**修 bug 的过程本身也会造 bug，这需要被登记而不是被抹掉**。

---

## 0. 状态总览

| 缺口 | 主题 | 当前状态 |
|---|---|---|
| G-01 | 未知分区被静默丢弃 | ✅ 已修复 |
| G-02 | 未知分区告警文案误导 | ✅ 已修复 |
| G-03 | 无「不支持分区」的报告通道 | ✅ 已修复 |
| G-04 | checksums 单向（不检查多余条目） | ✅ 已修复（含表缺失分支，见 G-12） |
| G-05 | 分区 version 无兼容余地 | ⚠️ 部分修复（不对称，见 §1.5） |
| G-06 | 迁移链未接入导入路径 | ✅ 已修复 |
| G-07 | `needsMigration` 分支不可达 | ⚠️ 仍然成立（版本区间的必然结果，非缺陷） |
| G-08 | 密码强度校验（基线形同虚设 → 一度接通 → 按产品决策整体移除） | ➖ 已按产品决策**整体移除**（加密不做密码强度校验，任何非空密码可用） |
| G-09 | 文件类分区内容不扫描 secret | ✅ 已修复（只报告不改写） |
| G-10 | `sections.secrets` 恒 `false` 但语义被复用 | ✅ 已收口（规格侧澄清） |
| G-11 | 条目名侧不拒绝中段反斜杠 | ❌ **仍未修复** |
| G-12 | G-04 残留：表缺失/为空时漏报 | ✅ 已修复（`import.checksumsMissing`） |
| G-13 | G-09 残留：告警按 hit 不去重 → 真凭据文件零告警 | ✅ 已修复（按文件去重 + 截断补汇总） |
| P-1 | peerDependencies 体积（headless 为 UI 付费） | ✅ 已修复 |
| P-2 | `lib/**/*.map` 随包发布 | ✅ 已修复 |
| **B1** | 新增告警未经 `redact()` 渲染到 UI（本轮修复自身引入） | ✅ 已修复 |
| **B2** | VER-03 源码守卫恒绿（只测符号存在，不测接线） | ✅ 已修复（改为钉「受控调用」） |
| **M1** | `config_backup` 未传 scanner → 文件类扫描静默失效 | ✅ 已修复 |
| **M1b** | **定时自动备份**路径同样未传 scanner（第三条导出路径） | ✅ 已修复（三路同一实例） |
| **L1** | P-1/P-2 无自动化回归护栏 | ✅ 已修复（`tests/packaging-contract.test.ts`） |
| **L2** | `exports["./schema"]` 指向纯类型产物（运行时 0 导出） | ✅ 已修复（运行时入口 `lib/schema/index.js`：24 个运行时导出） |
| **L3** | `env-lock` heartbeat 在途写残留 `.tmp` → `rmSync` ENOTEMPTY | ✅ 已修复（写串行化 + release 前 drain） |
| **L4** | `run-store` 测试固定 `sleep` 竞态（全量并发时偶发） | ✅ 已修复（改 `waitFor` 条件等待） |
| G-14 | 同步只搬 `pnpmWorkspace` 声明、不搬 `patches/**` → 目标机 pnpm 拒绝一切安装（issue #35） | ✅ 已修复（`patchFiles` 同进同出 + 导入端剔除不可满足声明 + 市场双端拒收 + journal 状态可辨 + 计划项可回滚 + 工具链变更可见可取消） |
| G-15 | Windows 无 OS process identity → 阈值内的 PID 复用残留锁仍判 UNKNOWN_STATE（issue #36） | ✅ **已修复**（win32 `Get-Process` / macOS `ps` 精确 PID 复用判定 + `recover-stale-lock` 锁目录候选；拿不到 identity 时仍退回长过期启发式，见 §3） |
| G-16 | 文件类分区静默跳过 junction/符号链接（issue #37） | ✅ 已修复（GUI 与 CLI 同一跟随内核 + 跳过/不可读均留痕；home 外目标仍拒绝且留痕） |
| G-17 | 同步页「导出密钥」无数据源：勾选后不导出任何凭据，只跳过载荷的二次脱敏（issue #38） | ✅ 已修复（凭据作为独立密文载荷随加密快照迁移；拉取侧解密 → 逐条确认 → `credentials.set` 写回） |
| G-18 | `.credentials.yaml` 的 `refs:` 块未被识别：包里带着凭据原文，导入后仍要求人工重填（issue #39） | ✅ 已修复（两处解析共用同一口径，v1 `refs:` 块与预发布扁平布局都认；误导性的「需人工重填」只在确实还缺 ref 时出现） |
| G-19 | 同步快照格式（内容寻址外置）**不做协议协商**：旧版插件读新版快照会把 `sessions` 当成缺失分区 | ⚠️ **有意不修**（契约登记，见 §3.1；要求两端同版本） |
| G-20 | 会话删除墓碑**不代本机删除**数据：对端删掉的对话只被「阻止复活」，本机副本仍在 | ⚠️ **有意不修**（删除是不可回滚的用户动作，见 §3.2） |
| G-21 | 路径映射页把内部枚举当文案渲染：源路径「永远是 missing」（真机反馈） | ✅ 已修复（改用真实判定，见 §1） |
| G-22 | 加密备份里的凭据「有值却不进计划」+ 本机已配置就被跳过（真机反馈） | ✅ 已修复（判据「值的有无」优先于本机状态，见 §1） |
| G-23 | 会话日志格式版本跨 DSH 版本**单向**不兼容，且 DSH 对读不出的格式**静默跳过**（不报错、不在工作区列表里 → 「对话消失」） | ✅ 已修复（导入/同步分析期体检 + 档案页版本可见 + **导入/同步的三选一处置开关**，见 §1） |
| G-24 | 本机**存量**会话损坏（重放族 / 撕裂帧 / 位置错位 / 缺工作区 / 缺父对话）此前既无诊断入口、也无安全修复通道 | ✅ 已修复（只读体检路由 + 事故恢复面板 + 离线 CLI 安全修复 + **应用内零损失修复（T8，重放重复行）**）；**M1 加固（2026-10-06）**：v0 打包行误判修复 + 真 codec 复验门 + 只读检测扩展 + 有损预览可见 + 引用闭包闸门 + CLI/救急台 verify 三态（**剩余未做项见 §3「G-24 剩余未做项」**，见 §1） |
| G-25 | `file:` 指向**已打包 tarball** 的本地插件被打包环节当目录 spawn（`spawn ENOTDIR`），代码静默不进备份而备份仍报成功（issue #57） | ✅ 已修复（stat 判形态 → 文件直读收编 / 目录走 npm pack / 判不出回落并告警，见 §1） |
| G-26 | 包缺少 git 安装所需的构建入口：`dsh plugin add git+https://...` 必失败（issue #58） | ✅ 已修复（补 `scripts.prepare` + 三条 G-21 打包门禁；**pnpm 11 的 `allowBuilds` 仍须用户逐字授权一次**，见 §3.3） |
| G-27 | 加密同步快照 >64 MiB 时远端列表恒为空、拉取报「快照损坏」、自动同步恒 `upToDate`，而 push 报成功（issue #59） | ✅ 已修复（读取侧改用自产载荷专用上限 + 读不出来的一律回传可见，见 §1） |
| G-28 | WebDAV 密码输入框被无关状态更新自动清空（issue #60） | ✅ 已修复（`commit()` 经 `patchSyncPasswords` 把在途输入写回内存；持久化白名单不变，见 §1） |
| G-29 | 会话在应用内**读不出来**：官方 `session.export` 通道（原样 ZIP，含子会话与附件）此前**从未接入** | ✅ 已修复（只读探测/流式代理路由 + 体检弹窗逐行下载入口；判据按 **500** 而非过时的 501，见 §1） |
| G-30 | checkpoint（会话 / 工作区 / 配置三态同点检查点）：宿主能力已交付（引擎 + 7 条子路径），**界面已于 2026-10-08 接线** | ✅ **已接线可用**（GUI：环境 → 维护与诊断「检查点」卡 + ⌘K 命令；CLI 入口与「单条详情」子路径仍无消费者，见 §3） |
| G-31 | 云端点同步通道（S3 兼容系 ×5 / GitHub Gist）：**已接线可用**（通道枚举 / 路由 / UI / 引擎全路径） | ✅ 已交付（`SYNC_CHANNELS = ['git','webdav','s3','gist']`，声明处 = 零依赖 `src/utils/shared-constants.ts`；s3/oss/cos/minio/kodo/gist 六类端点可用。**未对真实云端点做端到端验证**（本批无真实凭据）；gist 刻意不外置 blob 见 **G-34**） |
| G-32 | SQLite 只读探测的**写副作用**（WAL 库被就地打开会新建 `<db>-shm`/`<db>-wal`）与 `immutable=1` 在 `-wal` 非空时**静默丢数据** | ✅ 已处置（`sqlite.ts` 三态打开计划 direct / immutable / copy + 1 GiB 上限 + **绝不退回就地打开**；四条残余风险见 §3） |
| G-33 | 备份不到外壳的 MCP 与技能：patch 只读 home 层、技能不落目录（issue #71） | ✅ 已修复（patch 行按层读取并写回原层、技能经 `ctx.skills` 服务收编、快照与回滚记录层，见 §1） |
| G-34 | GitHub Gist 通道**刻意不外置 blob**（一次 GET 全量返回 / 单文件超限截断 / 文件数上限三条限制）→ 大分区（会话）不适合走 gist | ⚠️ **刻意设计的能力边界，不是缺陷**（gist 定位 = 配置类分区的低门槛远端）；**界面提示已补（2026-10-08）**：gist 表单常驻 `cloud.gistLargeSectionHint`，且「通道=gist 且勾选 sessions」时出 `mode.gistSessionsWarn` 风险横幅（判定纯函数 `gistSessionsRiskKey`，护栏 `sync-view-v2.test.ts`） |
| G-35 | 同步通道对**远端 404 的可靠性假设**：blob GC 只按索引条目收集引用 → ① **索引可读但陈旧**（孤儿快照文件在索引外）、② **引用者文件这一读 404 而远端其实仍在**，两种形态都会把**仍在用的 blob** 回收 → **内容不可恢复** | ⚠️ **未修复（已核实残余，非原任务引入）**：t42 已堵住 `delete()` 侧的「索引 404 真缺失」；`upload()` 侧仍待 **t66/t67**（登记时 pending）；根治需通道侧补列举原语（WebDAV PROPFIND / S3 ListObjectsV2），见 §3 |
| G-37 | 宿主整文件快照把「存在但读不出来」记成 `existed:false`（恢复时删掉用户真实文件）+ 保留清理在「recovery 引用集合读不出来」时按空集合继续删（可能删掉 SAFE MODE 唯一回滚点） | ✅ **已修复**（2026-10-08 UX 审查：`existed:true` + `unreadable:true` + 计划只跳过；引用扫描失败即放弃本轮 prune + `onWarn` 可见，见 §3） |
| G-36 | **值形状判定的大小写边界**：auth-scheme `bearer` 原为大小写敏感（`bearer` / `BEARER` 明文进包且 refs/skipped 皆空）；厂商前缀 `sk-` / `AKIA` / `ghp_` / `github_pat_` 的大小写变体（`SK-` / `akia` / `GHP_` …）**按决策不剥离** | ⚠️ **部分修复（t72）**：`bearer` 已按 RFC 7235 / 6750 大小写不敏感剥离（含过剥控制）；厂商前缀**刻意保持敏感**、登记为已知边界（见 §3 G-36） |

---

## 1. 本轮已修复的缺口（含修复位置与验证方式）

> 下列缺口在 `0.1.59` 基线中**真实存在**，当前工作区**已不再成立**。
>
> **编号更正（2026-09）**：路径映射页与「加密备份凭据进计划」两条此前误用了 `G-20` / `G-19`
> ——「同步快照不做协议协商」与「会话删除墓碑不代本机删除」在 §0 / §3 已占用这两个编号
> （`AGENTS.md`、`docs/spec/sync-channel-v1.md`、`CHANGELOG.md` 都按后者引用）。现改编号为
> `G-21` / `G-22`；对应测试名 `tests/security/credentials-refs-import.test.ts` 的 `G-19：…` 已同步改为 `G-22：…`。
> **合并更正（2026-10，T0 统一基线）**：`origin/main` 侧新增的「patch 层 / 外壳 MCP 与技能」（issue #71）条目与本地 `G-29`
> （官方 `session.export` 通道）撞号；合并时把上游那条改编号为 **`G-33`**，两条语义都保留（本节已同步其标题与 §4 引用）。
> 「验证方式」列给出**可复现**的证据（测试用例名或命令），不是「读代码觉得对」。
>
> **G-08 是本节的特例**：它不是「被修好」，而是**该能力被产品决策整体取消**（加密不再做任何密码强度校验）。它保留在本节只为记录完整历史，**不要**读作「闸门已接通」。

### G-01 未知分区被静默丢弃

| 项 | 内容 |
|---|---|
| 基线问题 | 未知 id 的 `sections` 键进不了 `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES`，`extractSections` 直接 `continue`；ZIP 内该分区数据从未被读取，也从未被告知（基线 `src/core/analyzer.ts:204-205`）。 |
| 修复位置 | `src/core/analyzer.ts` 的 `extractSections`（`if (!knownIds.has(sectionId)) { unsupportedSections.push(...); continue; }`）；汇总告警在 `src/core/analyzer.ts` 的 `extractSections`（消息键 `import.unsupportedSections`，文案「备份包含本版本不支持的分区: X（已跳过，未导入）」）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `FC-01`（断言 `analysis.unsupportedSections` 含 `keybindings`，且告警文案为「不支持/已跳过」）；`FC-04`（语义回归）。 |
| 残留边界 | 未知分区的**数据本身仍不被保留**（格式 v1 无「原样保留未知分区」能力）。修复只解决「告知」，不解决「保留」。 |

### G-02 未知分区告警文案误导

| 项 | 内容 |
|---|---|
| 基线问题 | 未知分区落进 `missingSections`，用户看到「备份声明了但缺少的分区: keybindings」——但文件其实在 ZIP 里（基线 `src/core/analyzer.ts:275-280`）。 |
| 修复位置 | `src/core/analyzer.ts` 的 `analyzeImport`（`skippedSections` 从 `missingSections` 剔除），告警在 `src/core/analyzer.ts` 的 `analyzeImport`（`missingSections` 告警）。 |
| 验证方式 | `FC-01`（断言 `missingSections` 不含未知分区、`compatibility === 'excellent'`）；`FC-04`（未知分区与「已知分区文件缺失」互不串味）。 |

### G-03 无「不支持分区」的报告通道

| 项 | 内容 |
|---|---|
| 基线问题 | 全仓库没有 unsupported-section 的报告通道；`ImportAnalysis` 只有 `sectionsInZip`（只含已知分区）与 `warnings`/`errors`（基线 `src/core/types.ts:201-213`）。 |
| 修复位置 | `src/core/types.ts`（`ImportAnalysis.unsupportedSections: string[]`；同文件另有对称的 `unsupportedVersions`）；填充点 `src/core/analyzer.ts` 的 `analyzeImport`（`unsupportedSections` 填充点）。 |
| 验证方式 | `FC-01` / `FC-03`（`FC-03` 断言 `unsupportedVersions` 结构化暴露，且与 `unsupportedSections` 不串味）。 |

### G-04 checksums 单向

| 项 | 内容 |
|---|---|
| 基线问题 | `verifyAgainstTable` 只遍历**表里的键**，不检查「ZIP 里在、表里不在」的条目；普通导入路径对此零告警。 |
| 修复位置 | `src/core/analyzer.ts` 的 `loadBundle`（反向检查，排除 `manifest.json` / `checksums.json` 自身与目录条目），告警消息键 `import.extraEntries`（`src/core/messages.ts`）。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `INT-01`（断言未登记条目被点名列出、`valid=true`、`errors=[]`、Dry Run 零写入）；`CORPUS-02`（篡改数据条目不重算 checksums → 必须被拒）。 |
| 关联 | 「表缺失/为空」这一半是 G-12，**单独登记**。 |

### G-05 分区 version 无兼容余地

| 项 | 内容 |
|---|---|
| 基线问题 | 分区文档 `version` 采用精确 `=== 1` 判定（`src/schema/versions.ts` 的 `sectionDataVersionIssue`（`version === 1` 判定））；任何已知分区 JSON 的 `version != 1` 会让**整个 bundle** 无法导入，而不是跳过该分区。 |
| 修复位置 | `src/core/analyzer.ts` 的 `extractSections`（`import.unsupportedSectionVersion` 跳过该分区并收集 `unsupportedVersions`）`：只有「数字且 `> 1`」才**跳过该分区并告警**（消息键 `import.unsupportedSectionVersion）。 |
| 验证方式 | `FC-03`（`version > 1` → 跳过 + 告警 + 不阻断 + 不进 `sectionsInZip` + 不产生计划项）；同测试的后半段钉住 `version < 1` / 非数字 / 缺失仍**硬失败**。 |
| **仍未修复的不对称** | `version > 1` 跳过、`version < 1` / 非数字 / 缺失**硬失败整个 bundle**。这是**有意保留**的数据损坏语义，但对外部实现者是一个不对称契约，必须在 v2 设计时决策（规格 §3.3 已写明三档实测）。 |

### G-06 迁移链未接入导入路径

| 项 | 内容 |
|---|---|
| 基线问题 | `migrateToCurrent`（`src/migrations/index.ts`）已实现且有单测，但**导入路径从不调用它**——`analyzer.loadBundle` 只用 `isSupported` 判定后直接继续（基线 `src/core/analyzer.ts:165-168`）。一旦 `CURRENT > MIN`，旧备份会被「判定为可迁移」却**不会真的被迁移**。 |
| 修复位置 | `src/core/analyzer.ts` 的 `loadBundle`（`needsMigration` 守卫 + `runSchemaMigration`；`needsMigration` 为真时调用 `runSchemaMigration`，迁移结果重新过 `validateManifest` 才作为后续 manifest）；实现 `src/core/analyzer.ts` 的 `runSchemaMigration`。 |
| 验证方式 | `tests/conformance/roundtrip.test.ts` → `VER-03`（源码级守卫：断言 `loadBundle` **方法体内**存在 `needsMigration` 守卫且 `runSchemaMigration(` 调用**在守卫块内**、未被注释；并断言 v1 包不触发迁移、迁移告警只在真实迁移时出现）。 |
| 残留工作 | 发布 schema v2 前仍应补一条**端到端**「v1 → v2 真实迁移」测试（当前 `MIN = CURRENT = 1`，路径结构上不可达，只能靠 `VER-03` 的源码守卫 + `runSchemaMigration` 的直接单测）。 |

### G-07 `needsMigration` / `describeVersion` 的「将迁移」分支不可达

| 项 | 内容 |
|---|---|
| 问题 | `MIN_SUPPORTED_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION = 1`，不存在 `1 < v < 1` 的整数，该分支当前不可达。 |
| **性质澄清** | 这**不是待修缺陷**，而是「当前版本区间」的**必然结果**。G-06 修复后接线已就绪，一旦上移 `CURRENT` 即会真实执行。 |
| 验证方式 | `tests/schema-compat.test.ts:17-18`、`:154`（测试文件自身已注明该档位不可达）；`VER-03` 的源码守卫保证接线不会悄悄断掉。 |
| 待办（随 v2） | 与 G-06 一并在发布 schema v2 前补端到端迁移测试。 |

### G-08 密码强度校验（基线形同虚设 → 一度接通 → **按产品决策整体移除**）

> **最终状态（当前工作区，也是本条的结论）**：**加密路径不做任何密码强度校验**。任何密码都可用于加密——`1`、`12345678`、`password` 一律被接受。**唯一约束是非空**：空字符串密码抛 `SecurityError('BAD_PASSWORD', '加密密码不能为空')`。
>
> **这不是缺口，也不再是「修复」**——这是产品负责人（用户）的明确决策：加密备份的密码策略由用户自己掌握，插件不施加强度约束。G-08 因此**从缺口登记中退出**，保留此条只为记录历史。

| 项 | 内容 |
|---|---|
| 基线 `0.1.59` | 强度校验函数（**该符号现已从源码移除，此处仅为历史记录**；发布版 `0.1.59` 的 `src/security/encryption.ts:165-174` 即其定义）已实现且有单测，但在 `src/index.ts` 中**零调用**——导出端只要求 `password` 是非空字符串。**形同虚设**：有一个「看起来在守、实际不跑」的强度函数。 |
| 中间态（本轮一度接通） | 三层闸门一度被接通：导出路由入口（400 拒绝 + 可操作文案，在任何文件写入之前）、`config_backup` 模型工具（结构化拒绝）、加密层兜底。当时的判定档位是「< 8 拒绝 / 8–11 且无大小写数字混合仅提示 / ≥12 通过」。 |
| **最终态（产品决策，2026-09-13）** | **上述闸门被整体移除**，而非保留或收紧。用户原话：「我需要加密备份时无需校验，无论是什么密码都可以使用。」**当前加密入口只拒绝空字符串**。 |
| 移除物（全库零残留） | 强度校验函数与断言函数（`src/security/encryption.ts`）、导出路由的密码守卫（`src/index.ts`）、导出路由的 400 弱密码拒绝块、`config_backup` 的弱密码结构化拒绝（`src/core/model-tools.ts`）、消息键 `export.passwordTooWeak`（zh + en，`src/core/messages.ts`），以及 5 个对应的测试用例。**以上符号在当前工作区均已不存在，不得再被引用。** |
| 为什么移除而非接通 | 避免留下「看起来在守、实际不跑」的死代码。若产品不要求强度闸门，正确做法是**删掉**，而不是接通它再放宽到形同虚设。 |
| 验证方式 | 加密入口只对空字符串抛 `BAD_PASSWORD`，其余任何密码均被接受；`src/security/encryption.ts` 的两个加密函数内各留有**刻意注释**（「产品决策（2026-09-13）：加密不做任何密码强度校验……请勿在此重新加入强度闸门」）。全库检索被移除符号**零命中**。 |
| 残留边界（**仍然成立，且现在覆盖整个校验面**） | **解密路径不校验**密码强度——历史备份可能用弱密码加密，任何校验都会让它们**永久打不开**。由于强度校验已整体移除，这条边界现在描述的是**整个密码处理面**的行为：加密与解密两侧都不做强度判定。 |

### G-09 文件类分区内容不扫描 secret

| 项 | 内容 |
|---|---|
| 基线问题 | `skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的文件内容**完全不进扫描器**，也不计入 `redactedHits`。 |
| 修复位置 | `src/core/exporter.ts:135-161`（`scanFileSectionText` 定义）、`src/core/exporter.ts`（`else` 分支调用 `scanFileSectionText`：命中计入 `redactedHits`、产出 `export.fileSectionSecrets` 告警）。消息键 `src/core/messages.ts`。 |
| 验证方式 | `tests/core/exporter.test.ts:298`（凭据文件 → 告警 + 计入 `redactedHits`，且内容**原样不改写**）、`:332`（二进制跳过；无 `scanText` 的扫描器不扫）、`src/core/model-tools.test.ts`（模型工具路径与 HTTP 路由同档扫描）。 |
| **仍然成立的边界（勿过度承诺）** | ① **只报告不改写**：命中的文件内容**不剥离**，明文仍在包里——「默认不含秘密」对文件类分区**仍不成立**，缓解手段仍是 `pluginFiles` 默认 `false` + 市场 BANNED，用户显式勾选即可带出明文；② 只走 `scanner.scanText`，core 内置 `defaultSecretScanner` 未实现该方法 → 该分支**返回空**（行为与修复前一致），生产路径注入的是含 `scanText` 的强化扫描器；③ 二进制文件（前 4 KiB 含 NUL）跳过；④ 单文件 1 MiB / 累计 16 MiB 预算超限即停止扫描（不中断导出）；⑤ `redactedHits > 0` **不再**意味着「包里没有明文」（见规格 §5.3.4 / §5.3.5 的修正说明）。 |
| 关联 | 告警去重问题曾作为独立发现登记为 G-13，**修复已落地**（见 §2）。 |

### G-10 `sections.secrets` 恒 `false` 但语义被复用

| 项 | 内容 |
|---|---|
| 问题 | `sections.secrets` 永远是 `false`（无 adapter）；加密事实由 `security.encrypted` 承载。第三方若按「`sections.secrets === true` 表示含凭据」实现，会判断错误。 |
| 收口方式（**规格侧，实现刻意未变**） | `buildSectionFlags` 里 `flags['secrets'] = false` 仍在（当前工作区 `src/core/exporter.ts`）——这不是实现缺陷，而是「键集合恒全量」的**语义设计**。规格 §2.5 已加显式警告块；§9 步骤 4 的验收判据明确「判断『含秘密/需密码』只看 `security.containsSecrets` / `security.encrypted`，不看 `sections.secrets`」。 |
| 验证方式 | 规格 §2.5 / §9 步骤 4 的判据本身（文档级修复）；`FC-*` 系列未覆盖此语义，故不声称有测试护栏。 |

### G-14 同步/备份只搬运 `pnpmWorkspace` 声明，不搬 `patches/**` 文件（issue #35）

| 项 | 内容 |
|---|---|
| 基线问题（0.1.59） | plugins 分区导出时整段读取 `profiles/<profile>/pnpm-workspace.yaml`（含 `patchedDependencies`），但 patch 文件本身不在任何被同步的分区里；全仓对 `patchedDependencies` 零解析、零校验。 |
| 后果 | 目标机拿到「声明存在、文件不存在」的组合后，**任何** `pnpm add`（含 `dsh plugin add`）都失败于 `Failed to read patch file ... (os error 2)`——实测一次「一键同步 → 确认导入」13/13 插件安装全灭，而同步仍报成功。 |
| 修复位置 | ① 导出：`src/adapters/plugins.ts` 解析 `patchedDependencies`，把 `patches/**` 作为 `plugins.patchFiles`（base64）随分区携带（源机缺文件 → 显式告警）；② 导入：`src/adapters/plugins.ts` 先落 patch 文件，再写**剔除不可满足声明**后的 `pnpm-workspace.yaml`（剔除在 `analyzeImport` 以 Warning 计划项显式可见）；③ 纯函数内核 `src/adapters/pnpm-workspace.ts`（按行改写，保留注释/CRLF，不整文件重写）；④ 供应链：`patchFiles` 非空在**发布侧与导入侧**双端拒收（与 `localTarballs` 同级）；⑤ 安装失败分类 `patch-file-missing`（`src/core/plugin-cli.ts`），给出可操作修复路径而不是 13 条「插件装不上」。 |
| 关联缺陷（同轮修复） | journal step 把 `warning`（如安装失败但非致命）记为 `skipped` 且不落 message → 事后审计误判为「用户跳过了这些插件、同步成功」。现在 `warning` → `attention`、`skipped` 只留给真正的跳过，并持久化 `message`（`src/core/analyzer.ts`、`src/core/journal.ts`）。 |
| 验证方式 | `src/adapters/pnpm-workspace.test.ts`（8 例：逐字节不变 / 只删缺失条目 / 全删连键删 / 越界路径 / flow 形态不改写 / CRLF / 无声明零改动）；`src/adapters/plugins.test.ts` → 「issue #35：patch 文件随分区迁移；目标缺失的 patchedDependencies 声明导入时剔除」；`tests/core/import-journal-status.test.ts`（四种结局的 journal 状态）；`src/market/{prepare,market}.test.ts`（双端拒收 + 路径穿越拒绝）。 |
| 规格同步 | `docs/spec/bundle-format-v1.md` §3.2 / §3.4 / §3.5 / §10（`patchFiles` 字段与「声明与文件必须同进同出」的实现者注意）。 |

### G-15 Windows/macOS 缺少 OS process identity → PID 复用残留锁判 UNKNOWN_STATE（issue #36，**已修复**）

| 项 | 内容 |
|---|---|
| 基线问题（0.1.59 实测） | `canGetOsIdentity()` 只在 Linux 为 true，win32/macOS 的 `probe()` 恒返回 `osProcessStartIdentity: null`；Windows 又会复用 PID，于是「心跳过期 + pid 存活」永远停在 `UNKNOWN_STATE` —— `recover-stale-lock` 与 GUI「回收残留锁」**都拒绝**，用户只能手工删锁文件（报告者的心跳停更 9 天仍无法回收）。 |
| 修复位置 | `src/utils/env-lock.ts` 的 `createPlatformProcessIdentityProbe`（`defaultProbe` 即其默认实例）：win32 用 `Get-Process -Id <pid>` 的 `StartTime.ToFileTimeUtc()`（100ns FileTime），darwin 用 `ps -o lstart=`，linux 仍读 `/proc/<pid>/stat`（不 spawn）。identity 与记录**一致** → `LOCKED`（活着的 owner，心跳降级保护）；**不一致** → `STALE_LOCK_DETECTED`（PID 复用，**精确**判定，不再依赖心跳长过期阈值）。 |
| 代价控制（原「每次 acquire 都要 spawn，代价不可接受」的症结） | ① **自身 pid 的 identity 在进程内缓存**（进程创建时间不变）→ 每次 acquire 不再 spawn shell，只有本进程第一次 acquire 付一次查询；② 对**其它** pid 的查询只发生在「锁文件已存在且心跳已过期」的少数路径（心跳新鲜时先返回 `LOCKED`，根本不探测）；③ 查询超时 3s + `windowsHide: true`；④ 查询失败/超时/命令缺失 → `identity = null` 且**不抛错**（抛错会把分类推成 `UNKNOWN_STATE`，反而让长过期回收失效）。 |
| 保留的启发式（兜底，未删除） | 「心跳长过期」（阈值 `max(30 × staleAfterMs, 30 分钟)`，可注入 `longExpiredAfterMs`）仍用于**拿不到 identity** 的所有情形：平台不支持、查询失败、以及**旧版本写出的记录**（`osProcessStartIdentity: null`）。`acquire` 侧始终**绝不自动摘锁**（只分类）。 |
| 关联修复（同轮，同一用户故事「残留锁只能手工删」） | ① `recover-stale-lock` 的锁目录不再写死 `$DSH_HOME/dsh-config-manager/locks`：改为在 `resolveControlRoots` 候选根（`--data-dir` 派生 + 缺省根）里挑第一个**真的存在 `environment.lock`** 的 `<root>/locks`（`resolveRecoverLocksDir`，`src/cli/index.ts`）——宿主配置了自定义 `dataDir` 时此前根本定位不到锁；② `recover-stale-lock --data-dir <dir>` 的**空格写法此前必然失败**（前置校验把「值」也当成非法 token，只有 `--data-dir=<dir>` 能过），该冗余校验已删除。 |
| 剩余边界（诚实登记） | ① 平台查询失败（企业策略禁用 powershell 等）或不支持的平台 → 退回长过期启发式，阈值内（< 30 分钟无心跳）的 PID 复用锁仍需等阈值过去；② 「别的 pid」的 identity 查询各付一次 shell 启动（本机实测约 0.25 s），只发生在上锁冲突的罕见路径；③ 时钟被极端调整时 `StartTime` 比对可能失配，方向是判成「PID 复用」→（若原 owner 其实还活着）会允许一次显式回收，这仍是**人工触发**的显式动作，不放松自动侧。 |
| 验证方式 | 单测：`src/utils/env-lock.test.ts` 的 `§11.1-c11b`（9 天长过期 → 可识别 + 可显式回收 + acquire 仍不自动摘锁）、`§11.1-c11c`（未达阈值仍保守 `UNKNOWN_STATE`；heartbeat 缺失不放宽；阈值可注入）、`§11.5-p1…p5`（win32/darwin 解析与缓存、失败降级不抛错、**真实平台**上「identity 相符 → LOCKED / 不符 → 未达长过期阈值也判 STALE 并可回收」）；CLI 锁目录：`tests/cli/lock-recover-dir.test.ts`（R-01…R-06）。真机 E2E：`outputs/issue36-verify/verify.mjs`（8/8：强杀持锁进程 → 长过期后 CLI 回收成功；PID 复用锁「修复前 UNKNOWN_STATE 拒绝 / 修复后 CLI 立即回收」；identity 相符的活锁仍拒绝回收；自定义 `--data-dir` 根可定位）。 |

### G-17 同步通道的「导出密钥」没有数据源（issue #38）

| 项 | 内容 |
|---|---|
| 基线问题 | `includeSecrets=true` 在同步通道里**没有任何数据源**：没有任何 adapter 读取 `ExportOptions.includeSecrets`（结构化分区在源头就已 `redactSecrets`，凭据分区被 `FORBIDDEN_SECTIONS` 结构性排除，`.credentials.yaml` 在 `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` 里没有映射）。它唯一真实生效的效果是**跳过同步载荷的第二道 SecretScanner 脱敏**。 |
| 后果 | 用户勾选「导出密钥」后推送载荷与不勾时**逐字节相同**（唯一差异是 `manifest.containsSecrets` 由 `false` 变 `true`），却以为密钥已随同步迁移到另一台机器——文案与实现不符，且勾选动作实际**降低了防护**（结构化分区里的字面量凭据原样进快照）。 |
| 修复位置 | ① 数据源：`SyncEngine.buildCredentialsPayload`（`src/sync/sync-engine.ts`）在 `includeSecrets` 时经 `ctx.fs.readFile` 读 `$DSH_HOME/.credentials.yaml` 原文，用本次调用的密码加密为**独立载荷** `SyncSnapshot.credentials`（`src/sync/transport.ts` 的 `EncryptedCredentials`；不进 `sections`，否则被 `FORBIDDEN_SECTIONS` 断言拒绝）；读不到 / 解析不出凭据 → **显式告警且不带载荷**，不静默成功。② 编解码：`src/sync/snapshot-crypto.ts` 的 `encryptCredentialsPayload` / `decryptCredentialsPayload` / `credentialsMapFromYaml`（与宿主导入路径 `tryDecryptCredentials` 同口径）；`src/sync/snapshot-json.ts` 透传（git 密文单文件 / WebDAV 通道）；`src/sync/layout.ts` 对散文件布局显式拒绝（绝不静默丢弃）。③ 拉取接线：`pull`/`preview` 解密出 `Map<ref, value>` 并生成 `MissingSecret` 计划项（`appendCredentialPlanItems`）；`applyItems` 把该 Map 作为 `executeImportPlan.decryptedCredentials`（此前硬编码 `undefined`）交给 credentials adapter → `credentials.set(ref, value)`。④ 会话：`SyncSessionStore` 仅内存保管该 Map（存值不存密码——能力更窄），apply-items 消费 / cancel / TTL 即消失。⑤ 可见性：推送预览新增「本次推送包含真实凭据值」提示（`SyncPushPreview.credentialsIncluded`）。 |
| 不变量（未放宽） | `includeSecrets ⇒ encrypt` 仍强制；凭据载荷**只**存在于加密快照；非加密快照声明 `containsSecrets=true` 仍拒绝拉取；自动同步恒 `includeSecrets=false`（无密码，遇到加密快照跳过）；密码仅内存，绝不落盘 / 落日志 / 进响应体。 |
| 验证方式 | `src/sync/sync-credentials.test.ts`（8 例：push 密文载荷 + 明文不入载荷 / v1 `refs:` 布局同口径 / 只加密不导密钥不带载荷 / 无凭据文件明确告警 / pull+preview 生成迁移项且报告不含值 / applyItems 带 Map 写回、不带则跳过 / 未加密快照携带凭据载荷被拒 / 散文件布局拒绝）；`src/client/sync/sync-push-preview.test.ts`（含凭据提示）。 |
| 已知有损点 | 只搬运 `.credentials.yaml` 的**凭据字符串值**（v1 布局的 `refs:` 块 + 预发布扁平布局的顶层键，解析口径见 G-18；与导出路径 `security/secrets.enc` 同口径）；`records` 等嵌套结构 / 非字符串值不迁移。凭据写回**不可回滚**（DSH 不回读凭据值，属既有的技术限制）。 |

### G-21 路径映射页把内部枚举当文案渲染：源路径「永远是 missing」（真机反馈，本轮修复）

| 项 | 内容 |
|---|---|
| 基线问题 | `PathMappingForm` 直接渲染 `{issue.kind}`（core 的内部枚举字面量）。core 只做**形态**判定（`judgePath`）：跨平台盘符冲突 → `platformMismatch`，**其余绝对路径一律 `missing`**（确切语义 = 「需为本机指定新位置」，**不做存在性探测**）。于是同平台导入时每一条都显示 `missing`，用户读成「源路径不存在 / 坏了」，且该文本未走 i18n（英文界面下也是中文环境之外的裸字面量）。 |
| 修复位置 | `src/client/import/PathMappingForm.tsx` 增 `PATH_ISSUE_LABEL: Record<PathIssue['kind'], 字典键>`（`missing` → 「需指定新位置」/「Set a new location」；`platformMismatch` → 「跨平台路径」/「Cross-platform path」；`homeMismatch` 目前 core 不产出，仍补键以保持穷尽）；`src/client/locales.ts` 新增 `import.paths.kind.*`（zh/en）。 |
| 验证方式 | `npm run typecheck`（`Record<PathIssue['kind'], ...>` 穷尽性由编译期保证）+ 构建后 grep `lib/client.js` 确认新文案已进产物。 |
| 未改变 | 路径映射阶段本身仍对**所有**绝对路径列一行（留空 = 跳过，合法），只是不再用误导性的 `missing` 字面量；跨机基础路径仍由 `rebaseMapping` 自动重定基（见 G-18 之后的条目）。 |

### G-22 加密备份里的凭据「有值却不进计划」+ 本机已配置就被跳过（真机反馈，本轮修复）

| 项 | 内容 |
|---|---|
| 基线问题 | 导入路径的凭据计划项只由 `credentialsStatus` 分区（`configured=true` 的 ref）反推，而 `createImportPlan` **拿不到**宿主解出的 `decryptedCredentials`。可 `includeSecrets=true` 加密的是 `.credentials.yaml` **原文**（`security/secrets.enc`），其中可能含**未被任何 settings namespace 引用**的 ref。同时凭据适配器的 ref 收集（`defaultCredentialRefs`）只认 `apiKeyEnv` / `providers[].apiKeyEnv` / secrets 引用字段，收不全。 |
| 后果 | ① 这些 ref 的值**永远不进计划** → 执行期没有对应计划项 → `credentials.set` 从不被调用，密钥「静默丢失」；UI 却在确认页写着「已随加密备份恢复 N 个凭据」（`decryptRefs` 来自 secrets.enc 的全部 ref）——**承诺大于实现**。② 中途引入的「本机已配置 → Skip」规则按**本机状态**判定，把「归档带值」的凭据也跳过了 → 用户勾了「导出密钥」导入后密钥一个都没写回（真机反馈：导入密钥没生效）。 |
| 修复位置 | ① `Analyzer.createImportPlan(zipPath, decisions, opts?)` 新增 `opts.decryptedCredentials`；计划项生成改为 `buildCredentialPlanItems`（原 `ensureMissingSecrets`）：ref 取**并集**（credentialsStatus ∪ 解密出的 ref），**值的有无优先于本机状态** —— 有值 → `MissingSecret`（`import.secretFromArchive`，执行期写回）；无值 → 本机已配置 ? `Skip`（`import.secretAlreadyConfigured`）: `MissingSecret`（`import.secretMissingDesc`）。② 宿主 `POST /plan` 接受 `decryptPassword`（与 `/analyze`、`/execute` 同源）并交给计划生成；`ImportPort.createImportPlan` 增可选 `opts`，客户端 `api.createImportPlan` / `ImportWizard.planOpts()` 传同一个仅内存密码。③ 同步侧 `appendCredentialPlanItems` 只处理有值 ref，并把先前按「无值」判成 `Skip` 的同 id 项**升级**为 `MissingSecret`，同时刷新 `plan.missingSecrets`（与 items 同源）。④ 前端：确认列表的批量按钮覆盖**全部确认项**（`sync-view.isBulkDecidable`，只排除 Error）——此前只认 Conflict，含 N 条凭据迁移项（`缺密钥`）时按钮恒灰。 |
| 不变量（未放宽） | 凭据值只在加密载荷里；只在进程内存流转，绝不进计划文本 / 响应 / 日志；`hasValue` 恒 false；无值分支**绝不覆盖**本机已有值。 |
| 验证方式 | `src/security/security.test.ts`「归档携带的凭据必须全部进计划并写回」：6 类分支（未传解密结果 → 只有被引用的 ref 进计划＝复现 / 传了 → 未经引用的 ref 也进计划且写回 / 本机已配置 + 归档有值 → 仍写回并覆盖 / 结果 `credentialsRestored=2` / 无值未配置 → 要求补录 / 无值已配置 → Skip）；`src/sync/sync-credentials.test.ts`（有值一律进计划 + 写回；无载荷快照不含 credentialsStatus 的成因说明）；`src/adapters/roundtrip.test.ts`（普通备份 + 本机已配置 → Skip）；`src/ui/import-wizard.test.ts`（计划期也带解密密码）。**修复前实测**：①②两条集成用例失败（`OTHER_PLUGIN_KEY` 缺失、本机已有值未被覆盖）。 |
| 真机证据（用户报告） | 用户机器 `$DSH_HOME/.credentials.yaml`（5 个 ref：DEEPSEEK / A6API / OPENCODE_GO / 两个同步槽位）mtime 停在导入前，且 `settings.yaml` 只引用其中 2 个（`llm-pi-ai.providers.*.apiKeyEnv`）→ 未被引用的 3 个 ref 无论怎么导入都不会被写回；导出的 `dsh-config-*.zip` 实测是 `DCA1` 容器（走解锁 → secrets.enc 全量 ref）。 |
| 校验方式的边界 | 计划期解密失败（错密码 / 密文被篡改）时 `/plan` 返回 400（与 `/analyze` 同口径），**不**静默降级为「没有凭据」。 |

### G-23 会话日志格式版本跨 DSH 版本单向不兼容（DSH 静默跳过读不出的会话）

| 项 | 内容 |
|---|---|
| 基线问题 | DSH 的会话日志首帧带 `header.version`（= `SESSION_FORMAT_VERSION`）。读会话时 `refuseForeignFormatVersion` 对**非本 build 的版本直接拒绝**（`SessionFormatUnsupportedError`），而会话列表 `listArtifacts()` 对这种错误是 **`catch (e) { if (e instanceof SessionFormatUnsupportedError) continue }`** —— 不报错、不显示。高版本能读低版本（DSH 自带 V0→V4 迁移链），**反向不可读**。 |
| 实测版本 | 桌面端内置运行时 `@deepseek-ai/dsh` 0.2.0-rc.2 → `SESSION_FORMAT_VERSION = 4`；磁盘 CLI 档案（hoisted）`0.1.5-rc.1` → `3`。本机 `$DSH_HOME/sessions` 抽样 401 个日志的版本分布 `{v0:200, v3:201}` —— 多版本共存是常态，不是边缘情况。 |
| 后果 | 导出/导入/同步是**逐字节搬运** `.jsonl.zstd`：把 v4 会话搬进 v3 目标机后，文件落盘成功、工作区记录也登记了，但 DSH 不会显示这些会话（真机语义 = 「导入全部成功，对话却没了」）。旧实现只在 semver 维度给出笼统的 `partial` 兼容性分，没有任何一条告警指向会话。 |
| 修复位置 | ① 宿主侧探针 `src/utils/session-format.ts`：`parseSessionFormatVersion`（从 DSH 源码文本解常量）、`readSessionFormatVersionAt` / `resolveSessionFormatVersion`（候选根与 `resolveDshVersion` 同源同序）、`probeSessionFormats`（每会话只解**首帧**，上限 200 条，读不出如实计入 `unreadable`，未检查计入 `skipped`）。② core 只消费数字：`HostContext.sessionFormatVersion` + `AnalyzerOptions.sessionFormatProbe`（`ImporterOptions` 同名透传），`Analyzer.sessionFormatWarnings` 在「包内版本 > 本机支持版本」时产出 `import.sessionsFormatUnsupported`，抽查有截断时追加 `import.sessionsFormatSampled`。③ 宿主 `src/index.ts` 启动时 best-effort 解析（解析不到 `log.warn`，**绝不猜**），`makeImporter()` 注入探针（导入向导与同步引擎共用同一份）。④ 同步 `pull()` 把 `analysis.warnings` 并进差异报告 message（那条链路只有一个 message 通道，不并入就是静默）。⑤ 档案页展示每个档案的 DSH 版本与会话格式版本，并对「本实例 VS 该档案」的错配给出提示（`profileVersionFacts` / `sessionFormatRisk`）。 |
| 不变量（未放宽） | 不替 DSH 做格式迁移（多 generation 迁移链与 verifier 在 DSH 内部；AGENTS.md 明令 core 禁止 import 会话日志存储格式）。目标版本解析不到时**既告警也不谎报兼容**：整条体检跳过，只在宿主日志留一行 warn。`readLogHeaderFromBytes` 对非法 `version`（字符串/负数/浮点）一律 `undefined`。 |
| 验证方式 | `src/utils/session-format.test.ts`（常量解析的正负例 / 候选根含 pnpm 嵌套布局 / 探针去重与截断计数）；`src/utils/session-log.test.ts`（`version` 解析 + 非法值不猜）；`src/core/import-sessions-visibility.test.ts` 三条（v4→v3 必告警 / v3→v4 不告警 / 本机版本未知不猜）；`src/ui/dsh-profiles-view.test.ts`（`profileVersionFacts` / `sessionFormatRisk` 各分支）；`src/profiles/dsh-profile-manager.test.ts`（未装依赖 → null、装了 → 真实版本号）。 |
| 后续（**已全部落地**） | 「不可读会话的处置开关（中止 / 跳过 / 引导升级）」——设计稿 `docs/design/2026-09-30-session-format-disposition-design.md`。**已落地**：① core 地基（探针 `units[{unitId,version}]`、`Analyzer.resolveSessionFormats` 每份归档只算一次、`PlanItem.formatUnsupported`、`ImportAnalysis.sessionFormats`）；② 判定与展示共用一份纯函数 `src/ui/session-format-disposition.ts`；③ 宿主 `src/routes/session-format.ts`（请求体 > 插件配置项 ui-prefs > 缺省 `abort`）接入 `/plan`、`/execute`、同步 `/sync/sync`、`/sync/apply-items` —— `abort` 时返回 **409 + code=sessionFormatUnsupported**（附 unreadable/target），**零写入**；④ 向导确认页与预览页的三选一（`SessionFormatDispositionField`）+ 阻断态 + 结果回显；⑤ `skip` 复用既有 `Selection`/includeItems 机制（这些单元默认不勾选，用户可手动勾回）。**关键修正**：探针的单元键（`projectKey/会话目录`）与计划项 unitId（带 `sessions:` 前缀）此前**键空间失配**，`formatUnsupported` 一条都打不上 —— 已由 `sessionUnitVersion()` 两种形态都试修掉，并由测试桩改为真实前缀形态钉住。处置只在**计划项层**取舍，仍**不改写会话字节**（下行转换不做，理由见上）。 |

### G-24 本机存量会话损坏既无诊断入口、也无安全修复通道

| 项 | 内容 |
|---|---|
| 基线问题 | G-23 解决的是「**导入/同步**时格式版本超前」，但用户机器上**已经躺着**的会话也可能是坏的：重放族（崩溃/强杀/第二个写入者 → 已提交 seq 被重写）、撕裂尾帧、容器非法帧、位置与 `projectKey(header.cwd)` 不一致、缺工作区记录、子代理会话缺父对话。此前插件**没有**任何一个入口能回答「我这台机器上现在哪些对话看不见、为什么」；而写会话字节只能离线（应用内写会让 DSH 起不来），用户更没有安全的修复通道。 |
| 后果 | ① 用户只能看到「对话消失」，无从判断是格式、损坏、还是工作区问题；② 唯一能碰字节的时机（DSH 起不来时）没有任何工具，只能手工删文件；③ 生态里已经出现「朴素修复把 50 万事件的会话永久毁掉」的事故（社区 postmortem #2257）—— 缺的不只是工具，是**带校验的**工具。 |
| 修复位置 | **只读侧（应用内）**：① 纯分类器 `src/core/session-health.ts`（严重级 `blocksStartup > unloadable > nextRequestFails > invisible > ok`；「会让 DSH 起不来」最高，因为工作区插件启动期枚举到坏会话时 Web 永远到不了工作区选择页）；② 宿主只读采集器 `src/utils/session-health-scan.ts`（结构档恒做：帧扫描 + 首帧 header；行档限额内做：解压逐行，只做**能从字节证明**的判定 —— 不可解析行 / 字节相同且 seq 相同的重复行 / seq 空洞 / 合成 closer 块）；③ 只读路由 `GET /api/dsh-config-manager/recovery/sessions`（挂在既有 recovery prefix 下，**不新增注册路由条目**，故 71 条快照不变）；④ 事故恢复子 tab 的「会话体检」区块（`src/ui/session-inventory-view.ts` 纯展示模型 + `RecoveryPanel` 装配）。**离线侧（唯一允许写字节的地方）**：⑤ `src/utils/session-log-repair.ts` 的**安全序列** —— 写前重跑「连续性 + 引用完整性」校验（不过即拒绝）→ 时间戳备份（绝不覆盖已有备份）→ 临时文件 + `rename` 原子换入 → 写后复验（不过则用备份还原）；⑥ CLI `sessions list / doctor`（只读）与 `sessions repair [--apply]`（写），写操作前**强制检测 DSH 是否在跑**（`<dataDir>/running/*.json` 心跳，pid 存活且未过期），在跑就拒绝并提示先关 DSH。**应用内修复（T8，2026-10）**：⑦ `src/utils/session-repair-service.ts`（目标解析 / 写入门 / 台账 / 回滚）+ `src/utils/session-log-repair.ts` 的 `rollbackSessionLogFile`；路由 `POST /recovery/sessions/repair`（dry-run 与 apply）与 `/rollback` 挂既有 recovery prefix（**不新增注册路由条目**），修三类：重放重复行 / 可证明的合成收尾块（零损失）与 seq 空洞、不可解析行的**截断**（有损，需显式放行）——dry-run → 确认 → 时间戳备份 → 原子换入 → 复验，回滚只认台账 `repairId`。 |
| 不变量（未放宽） | ① **应用内只做能从字节证明的修复、且必须过写入门**（T8/T9：core 仍不 import 会话字节工具；写路径只经 `utils/session-repair-service.ts` 的三道写入门 + 预览指纹；有损截断必须显式放行；证明不了怎么修的类别一律零写入）；② **绝不猜**：读不到 = 事实缺省，未做深度校验一律记 `verified: false` 并在界面/CLI 里**显示「未检查 N 条」**（把「没检查」说成「没问题」是本轮明确要消灭的谎报）；③ **检测 ≠ 发明**：缺 message id / 悬空 tool-call / settlement 非法这类需要 DSH codec 才能判定的**本轮不产出结论**（没有真凭实据就不下结论）；④ 修不了的走 `export`（转写保内容）与 `quarantine`（移出 DSH 视野，**不删除**）——本轮 CLI 保留了既有的重复 id 隔离目录语义（`.cm-repair-quarantine-<时间戳>/`）。 |
| 验证方式 | `src/core/session-health.test.ts`（13 例：每类问题一条 + 严重级排序 + 「读不到一律 unknown」+ 未验证不下结论）；`src/utils/session-health-scan.test.ts`（10 例：结构档四形态 / 行档四类 / 限额与 `untested` 计数 / 非 projectKey 目录跳过 / **只读**：扫描前后字节与 mtime 逐字节不变）；`src/ui/session-inventory-view.test.ts`（7 例：徽章语义、摘要口径、空态/截断/相位、体积格式化、离线命令恒三条）；`src/utils/session-log-repair.test.ts`（7 例：自我校验四形态、重复行判定、预览零写入、**apply 全序列**（备份=原件、原子换入、写后复验、临时文件清理）、**拒绝路径零写入零备份**、备份名冲突加序号）；`src/routes/session-format.test.ts`（处置解析优先级与损坏配置回退）。 |
| 生态对照 | 只读体检的检查清单采用 `dsh-backup`「零依赖结构体检、明确不修复」的路线；「深度解码作为可选增强」采用 `dsh-chatsync` 的路线（能力探测 + 失败即回退「未验证」）；安全姿态照抄 `dsh-session-rescue` / `dsh-session-surgeon`（先备份、原子换入、要求先关 DSH）。**本轮只实现「能从字节证明」的那部分，DSH codec 深度解码留作后续**（见下方「后续」）。 |
| M1 落地（2026-10-06，本轮） | ① **v0 打包行误判修复**：真机 1194 份日志里 **407 份**被判「需要损失性修复」，按 `allowLossy` 计划会丢 **865,098/876,680 行 = 98.7%**；成因是打包行（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`）**没有 `seq` 成员**（官方 `decodePackedRun`：`firstSeq = seq0`、`eventCount = payload.length`），旧判据跳过它却保留 `lastSeq`；判据改为**两层**（形状不可判定 → opaque/refuse；形状可判定但 `seq0` 不衔接 → 真实 seq 空洞，与标量行同待遇），并加**帧粒度规则**（`≤200 行/帧` 只约束重编码帧；未触及帧逐字节复用，真机有 **226 个事件帧 >200 行、最大 8654 行**）。复核脚本 `.tmp/probe-session-repair.mjs`。 ② **真 codec 复验门**（`src/utils/session-verify.ts`）：官方 `createSessionFormatCatalogWithChildren` + 逐行 `decodeRow` + `finish`；能力不可用 → `unavailable`（unverified）且绝不宣称成功；确定性失败 → 备份自动回滚；`unavailable` 不写成功台账、不触发回滚，但**仍写台账**以保可回滚。 ③ **只读检测扩展**：新增 `empty-tool-call-id` / `duplicate-tool-call-id` / `tool-result-id-mismatch`，并让 `missing-message-id` / `dangling-tool-call` 真正产出；严重级按**代际 + 载体**分级（v4 与 pre-v4 下缺 message id、空 tool-call id、重复通告同一 advertised tool call 都被**前台读盘管线拒读** → `unloadable`；版本读不出 → `nextRequestFails` + `codec-uncalibrated`）；**只报不修**。 ④ **有损计划预览可见**：`lossy-required` 必须给出真实 `truncate-tail` 条目与丢弃行数（旧实现给空动作清单）。 ⑤ **引用闭包闸门**：closer-drop 候选被保留行引用 → 不计划该动作；截断造成「引用目标由存在变不存在」→ 在 planner 内整体 refuse。 ⑥ **CLI / 离线救急台的 verify 三态**（现役可读 / 迁移链可还原 / 未验证）进用户可见输出。 |
| M1 口径（不得夸大，同批证据） | ① **修掉 packed 误判 ≠ 这些 v0 日志变得可读**：真 codec 对 407 份复验 = **405 失败 / 2 通过**；失败原因是 v0→v1 迁移拒绝（`summary requires notice form` / `unsupported descriptor version 2` / `unclassified message source`），与 seq 无关；那 2 份的正确表述是「**可被迁移链还原**」，不是「DSH 能直接读」（官方 `resolveCurrentLog` 对 `sourceVersion < SESSION_FORMAT_VERSION` 返回 `undefined`）。 ② 其中 `session-66add64c-…`（1160 行，**真 codec 可读**）正是会被旧有损路径毁掉的那一份（现状只留 **23 行**、丢 **1137 行**）—— 本轮最强动机。 ③ **收益为零的三件事要如实说**：修复执行覆盖 **0**（真机修复计划恒为 `nothing-to-fix`）；新增只读检测真机命中 **0**（120 个静止单元行档全扫 + 实时抽样 100 单元）；真 codec 门真机覆盖有限（本机最新代际 < v4 占 **80.67%**）。 ④ 数字口径（2026-10-06 快照）：units **1195**（日志 **1194**）、最新代际 {v0: **442** / v3: **522** / v4: **231**}、`KNOWN_SESSION_EVENT_TYPES.size = **59**`、`SESSION_FORMAT_VERSION = **4**`。 |
| 后续（未做，如实登记） | ⓪ **已落地（T8，2026-10）**：应用内修复「重放重复行」（见「修复位置」⑦）。以下仍未做：① DSH codec 深度校验（动态 import 已装 DSH 同树的 `@deepseek-ai/dsh-session-format-catalog`）——本轮的「行档」用零依赖方式覆盖了其中一部分，剩下的类（缺 message id / 悬空 tool-call / settlement 非法）需要真 codec；② header 重建（首帧不可读时按目录名 + 最早可解事件重建）——设计稿 §10.2 列为「低损失」，但**重建 header 等于发明数据**，需要先确定不会与「绝不猜」冲突再落地；③ CLI `sessions export`（转写 Markdown）与 `quarantine` 动作的网络化（目前 quarantine 只在重复 id 场景生效）；④ **同步通道的 UI 三选一**：一键同步的两条路径已**服务端**支持三态并显式传 `guide`（预览发生时尚无决策界面），但同步确认弹窗里还没有三选一控件。 |

### G-25 `file:*.tgz` 的本地插件在导出打包时被跳过（issue #57）

| 项 | 内容 |
|---|---|
| 基线问题 | `src/core/local-plugin-pack.ts` 的打包主循环对全部 `isLocalPluginSpec()` 候选一律 `npm pack . --pack-destination <abs>` 且 `cwd = resolveLocalPluginPath(spec)`。而 `file:` 的两种合法形态（目录 / **已打包 tarball**）中，后者会让 `cwd` 落在一个**普通文件**上 → `spawn ENOTDIR`。`classifyPluginSpec` 的注释早已写明「file → 本地 tarball / 目录」，即 tarball 那一半是**声明了但没实现**。 |
| 后果 | 真机 9 个 `file:/abs/x.tgz` 声明的插件**全部**打包失败（`打包失败：spawn ENOTDIR`），代码不进备份；而打包失败按设计只记 warning、不中断导出 → **备份仍报 ok:true**，用户以为「备份成功 = 备份完整」，恢复时装不回这批插件。同时因导出侧没有 tarball，导入侧「用解包后的绝对路径重写 spec」也无从发生 —— 本模块「让本地源插件真正跨机器迁移」的设计目标对这类 spec 完全没生效。 |
| 修复位置 | `src/core/local-plugin-pack.ts`：新增 `statKind` 注入（file / dir / unknown，**判不出来必须回落 unknown**）与 `safeTarballFileNameFor`（保留源文件名，只做文件名净化）；打包循环在 `resolveLocalPluginPath` 之后先判形态 —— `file` → **读文件直接收编、跳过 npm pack**（含体积上限校验）、`dir`/`unknown` → 原路径。宿主接线 `src/core/local-plugin-host.ts` 注入 `fsp.stat`，并把 profile 目录改用 `HostContext.profileDir`（不再按 `<home>/profiles/<name>` 硬拼；`src/core/types.ts` 新增可选字段、`src/index.ts` 的 `ConfigManagerHostContext` 提供）。 |
| 不变量（未放宽） | ① **判不出形态绝不猜成文件**（`stat` 失败/未注入 → `unknown` → 走既有目录流程，产出可读告警）；② 归档内相对路径恒为 `local-plugins/<文件名>`，**不含任何路径分隔符**（`safeTarballFileNameFor` 丢目录 + 折叠非法字符，防穿越）；③ 超上限一律跳过并告警，绝不塞进备份。 |
| 验证方式 | `src/core/local-plugin-pack.test.ts` 的 5 条 issue #57 用例（`.tgz` 直读收编且 `npm pack` 零调用 / 判不出形态回落目录流程 / 超上限告警 / 目录与 `.tgz` 混合各走各的 / `safeTarballFileNameFor` 的穿越与回退）。 |

### G-26 从 git 源安装必然失败（issue #58）

| 项 | 内容 |
|---|---|
| 基线问题 | 本包以 `files: ["lib", ...]` 发布**预构建产物**，npm 安装不需要任何构建步骤；而 `dsh plugin add git+https://...` 拿到的是源码树，pnpm 需要在 clone 里跑一个**构建入口**才能得到 `lib/`。`package.json` 的 `scripts` 里此前**没有任何 pnpm 认的构建入口**（`prepare` 只在 `npm publish` 前校验、不参与安装），于是 git 安装 100% 失败于 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。 |
| 后果 | 插件市场把 `dsh plugin --profile web add git+https://github.com/xiajiajun516/dsh-config-manager.git` 这条路径标为不可用；用户看到的是 `dsh: plugin command failed`（真实原因埋在 pnpm.log 里）。 |
| 修复位置 | ① `package.json` 新增 `prepare: npm run build`；② README（中英）新增「从 GitHub 源码安装」段，写明 pnpm 11 的 `allowBuilds` 白名单必须**逐字照抄 pnpm 打印的那一行**（含完整 git URL + commit sha；只写包名不生效），并给出更省事的替代路径（装 npm 预构建版）；③ `tests/packaging-contract.test.ts` 新增 G-21 三条门禁（`prepare` 存在且真的调 build/bundle、`files` 含 `lib`、`lib` 仍被 gitignore）。 |
| 剩余边界（诚实登记） | **pnpm 11 默认拦截 git 依赖的构建脚本，这一步无法由包作者免除** —— 用户必须在 profile 的 `pnpm-workspace.yaml` 里授权一次（见 §3.3）。这是 pnpm 的供应链策略，不是本包的缺陷；本包能做的是把构建入口补齐并让失败原因可读。 |
| 验证方式 | `tests/packaging-contract.test.ts` 的三条 G-21 用例；真机复核（本轮）：把 `prepare` 注入本地 clone 后 `pnpm add git+file:///<repo>` → 首轮按预期报 allowBuilds 且**打印可直接粘贴的键**，加白名单后第二轮 exit 0、`node_modules/dsh-config-manager/lib/index.js` 与 `lib/client.js` **均产出**。 |

### G-27 加密快照 >64 MiB 时远端列表恒为空（issue #59）

| 项 | 内容 |
|---|---|
| 基线问题 | 加密单文件布局把整份快照写成一个 JSON（`snapshots-encrypted/<id>.json`），**写入侧没有体积守卫**；读取侧 `deserializeSnapshot()` 走 `parseJsonSafe()` 的**缺省** 64 MiB 上限（`src/utils/json.ts` 的 `DEFAULT_MAX_JSON_BYTES`，那是防**不可信输入**的闸门）。加密载荷经「JSON → base64 → 加密 → 再 base64」约 ×1.78 膨胀，勾上 `sessions` 分区后单文件轻松越界（真机 4 个快照均 ≈66 MiB）。 |
| 后果 | `list()` 解析失败被静默吞掉（catch 返回 null + continue）→ 远端列表恒为空，而同一响应里 `currentSnapshotId` 却指着那条快照（自相矛盾）；`download()` 报「快照损坏」→ 拉取/一键同步彻底不可用；`hasNewRemoteSnapshot()` 因 `metas.length === 0` 恒 false → 自动同步永远 `skipReason: upToDate`，**永远不拉任何东西**。 |
| 修复位置 | ① 新增 `src/utils/json.ts` 的 `MAX_OWN_PAYLOAD_JSON_BYTES`（512 MiB，**自产载荷**专用）并让 `deserializeSnapshot` 显式传入 —— 读写两侧口径从此一致（WebDAV 与 git 密文单文件共用同一份解码器，一处修复两处生效）；② 「绝不静默」：`GitTransport` 新增 `unreadableSnapshots`（`readEncryptedSnapshotFile` 的失败原因入账）、`WebDavTransport` 同名字段（index 读取失败入账），`SyncEngine.unreadableSnapshots()` 透出，`POST /sync/snapshots-list` 以 `unreadable[]` 回传，客户端 `SyncApi` 类型 + `ChannelSyncState.unreadableSnapshots` + 同步页常驻 Banner 与 Toast。 |
| 不变量（未放宽） | ① `DEFAULT_MAX_JSON_BYTES`（64 MiB）仍是**不可信输入**的闸门，未被抬高 —— 抬高的只是「本插件自己写出去、又自己读回来」的那条链路；② 快照读取仍受 `maxDepth` 与形状校验约束；③ 读失败诊断是**远端当下状态**，**不落 sessionStorage**（`PersistedChannelSyncState` 显式剔除，刷新后重新 list）。 |
| 验证方式 | `src/sync/snapshot-json.test.ts` 两条 issue #59 用例（自产上限 > 缺省上限、>64 MiB 载荷可反序列化且缺省上限仍拒它）；`src/sync/git/git-transport.test.ts` 与 webdav 通道既有用例回归。 |

### G-29 会话在应用内**读不出来**：插件此前从未接入 DSH 官方的 `session.export` 通道（F-2）

| 项 | 内容 |
|---|---|
| 基线问题 | DSH 自带插件 `@deepseek-ai/dsh-session-log-export` 早就提供 `GET|HEAD /api/session.export?sessionId=<非空>&includeDescendants=<true\|false 字面>`：由 DSH 自己 flush 内存会话、解码多帧 zstd、按「会话 + 子会话 + 附件」打**有界流式 ZIP**。本仓库全量 grep `session.export` / `includeDescendants` **0 命中** —— 我们既没有用它，也没有任何等价的「把一条对话原样拿走」的入口（既有的会话能力全是**逐字节搬运**，服务于导出/导入，不服务于「读出来」）。 |
| 后果 | ① 用户想备份/取证/交给同事一条具体对话时，唯一的路径是「导出整个 sessions 分区」或自己进 `$DSH_HOME/sessions` 翻目录，而多帧 zstd 与代次命名让手工取用几乎不可行；② 生态同类插件（`dsh-sessions-manager`）已把这条通道做成主入口，我们的相对缺口是可见的。 |
| 修复位置 | **宿主**：① 新路由组 `src/routes/session-export.ts`（经 `kit.endpoint()` 注册，**只读**）—— 同一条路径两种形态：缺 `sessionId` = **探测**（HEAD 打 DSH 自己的端点，回结构化三态），带 `sessionId` = **流式代理**（GET 原样回传 ZIP / 逐 chunk 转发，绝不整本缓冲）；② 判定纯函数 `classifySessionExportStatus(status, body)` 与探测 `probeSessionExport(fetch, port)` 导出给单测；③ 宿主能力 `HostContext.fetch` / `HostContext.webPort`（`src/core/types.ts` + `src/index.ts` 的 `ConfigManagerHostContext` 取 Cordis `ctx.fetch`、apply() 里 webServer 就绪后写端口），路由依赖在 `makeRouteEnv()` 里以**活 getter** 暴露（构造发生在 webServer 之前）。**浏览器**：④ `ConfigManagerApi.sessionExportProbe()` / `downloadSessionExport()`（复用既有 `openStream` + 流式落盘链路）；⑤ 纯展示模型 `src/client/session-export/session-export-view.ts`（三态 → 可用/原因/交互）；⑥ 事故恢复页「会话体检」弹窗逐行新增「下载原始日志 (ZIP)」按钮（`RecoveryPanel`）。 |
| 不变量（未放宽） | ① **绝不照抄竞品的 `res.status !== 501` 判据**：本机 DSH 0.2.0-rc.2 的 app.asar 全量搜 `status: 501` **零命中**，服务缺失实际返 **500**，照抄会让入口**几乎恒显示**；② **三态而非二值**：`available`（200/400/404，含「会话不存在」这种业务结果）显示可用、`unavailable`（500 + `unavailable: missing`）**禁用并说明原因**、`unknown`（401/403、连不上、超时、读日志失败的 500）**保守显示为可用** —— 拿不到状态码绝不猜成「不支持」（那会藏掉本可用的功能）；③ 路由只读、**零写盘**，凭据/路径不进日志；④ 自请求必须带正确的 `Host: 127.0.0.1:<port>`（端口未知时**一个请求都不发**）—— 端口写错会被 DSH 的围栏判成 403，而 403 在本模块代表「被认证挡在门外」，拿注定 403 的请求当真话就是「恒隐藏」；⑤ 上游状态码**原样透传**（不把 404 改写成 200+ok:false）。 |
| 验证方式 | `tests/route/session-export-routes.test.ts`（15 例：400/404/500-缺服务/500-读失败/200/401/403/501/未知状态的**四态映射**与反例护栏、探测请求形状（HEAD + Host/Origin 带端口）、**端口未知时不发请求**、上游状态码原样透传、ZIP **逐块转发**（2 chunk → 2 write）、缺 fetch/端口时 503、`includeDescendants` 只认字面值、路由只声明一条且经 `endpoint()`）；`src/client/session-export/session-export-view.test.ts`（8 例：pending ≠ unavailable、available 不打扰、unavailable 禁用 + 原因 + 状态码插值、unknown 保守可用、原因映射五类不重不漏、竞品判据反例、缺省原因兜底）；路由计数同步见 `tests/route/route-parity.test.ts` / `route-fence.test.ts`（75 → **76**；buildRoutes 68 → **69**）。 |
| 生态对照 | 竞品 `dsh-sessions-manager` v3.7.6 用一个裸 `<a href="/api/session.export?..." download>` + 一次 `status !== 501` 预检；本仓库**不照抄**：探测放宿主侧（浏览器分不开 401/404/网络失败）、判据按 500 重写、并复用自己的流式下载链路（大 ZIP 不整本驻留内存）。 |
### G-28 WebDAV 密码输入框被无关状态更新清空（issue #60）

| 项 | 内容 |
|---|---|
| 基线问题 | `runStore.patch()` 每次调用都跑持久化白名单（`toPersistedState` → `pickChannel`），而白名单**把密码字段写成空串**（安全不变量：token / webdav 密码 / 加密与解密密码不落盘）。于是任何一次 patch —— 包括与密码**完全无关**的（远端快照列表到货、GitHub 授权轮询结束、自动同步状态刷新）—— 都会把 `state.sync.webdavPassword` 清空，下一次 `toSyncStoreSlice()` 镜像回来时输入框就空了。 |
| 后果 | 真机表现：在「密码（凭据已配置）」框里**输入几个字符就被自动清空**，**粘贴同样被清空**，输入过程中「保存配置」按钮闪一下（防抖自动保存被反复取消），且**没有任何保存成功提示** —— 用户完全无法修改 WebDAV 密码。 |
| 修复位置 | `src/client/run-store.ts` 新增 `RunStore.patchSyncPasswords({ token?, webdavPassword? })`：只写**内存**切片（不触发 `save()`）；`src/client/sync/SyncPanel.tsx` 的 `commit()` 在 `runStore.patch(...)` 之后立即用它把**在途输入**写回。 |
| 不变量（未放宽） | 密码仍**绝不**进 sessionStorage / 磁盘 / 日志（`toPersistedState` 白名单一行未改，回归用例仍断言落盘文本不含密码）；刷新后仍清空（`applyPersisted` 的硬性归零也没动）。 |
| 验证方式 | `src/client/run-store.test.ts` 的 issue #60 用例：在途密码经「无关 patch」后仍在内存、且落盘文本不含密码、未给出的字段部分更新语义正确；既有的「同步凭据绝不写入 sessionStorage」用例继续绿。 |

### G-33 备份不到外壳的 MCP 与技能：patch 只读 home 层、技能不落目录（issue #71）

| 项 | 内容 |
|---|---|
| 基线问题 | ① MCP / prompts / 插件激活行只读 `$DSH_HOME/cordis.patch.yml`（home 层），而外壳把激活行与 MCP 行写进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（档案层）—— `src/core/patch-layers.ts` 落地前，`src/adapters/mcp.ts`、`src/adapters/prompts.ts`、`src/adapters/plugins.ts` 都只调 `readPatchLines(USER_PATCH_FILE)`。② `skills` 分区只扫 `$DSH_HOME/skills` 目录，而外壳的技能来自插件注册表（`ctx.skills`），该目录在真机上根本不存在。③ 快照与回滚把 patch 行硬编码成 `'cordis.patch.yml'`（home 层），档案层的行回滚会写错文件。 |
| 后果 | 真机（`DSH_HOME=D:\DSHHome`、`DSH_PROFILE=tauri`）：`only=[mcp]` 预览 9 ms、**0 条**、26 B；`[skills]` 6 ms、0 条、0 B；导出包 `mcp/servers.json` = `{version:1,servers:[]}`，`custom/skills/` 无条目 —— 而界面报「成功」。用户拿到的备份里没有外壳真正在用的 MCP 与技能，**恢复后等于没备份**。 |
| 修复位置 | 新增零依赖 `src/core/patch-layers.ts`：层身份 = **相对 homeDir 的 POSIX 路径**（`cordis.patch.yml` / `profiles/<name>/cordis.patch.yml`，与 `src/core/backup.ts` 的 `HOST_FILE_CANDIDATES` 同口径），提供 `patchLayerRels`（home 优先，与 DSH 合并序一致）/ `readEffectivePatchLines` / `resolveWriteLayer` / `locatePatchLineLayer`；`src/adapters/mcp.ts`、`src/adapters/prompts.ts`、`src/adapters/plugins.ts` 改读两层并在条目上记 `sourceFile`，导入按来源层写回（档案层 → **目标机当前档案**）；`src/adapters/skills.ts` 覆写 `listRelPaths` / `readMember`，把 `ctx.skills.list()` / `get(name)` 的技能按 `<name>/SKILL.md` 虚拟路径并入，frontmatter 只写 DSH 认的键；`src/core/types.ts` 新增 `SkillStoreFacade` 与 `SnapshotTarget.file` / `SnapshotEntry.file`；`src/index.ts` 经 `readService(ctx, 'skills')` 惰取技能服务（**不进 `inject`**，避免阻塞 fiber），`DshPatchFileFacade` 的 `file` 参数改按 homeDir 相对路径解析并做包含性校验。 |
| 不变量（未放宽） | 技能名仍过 `isPathSafe` 且不得含 `/`（不许逃出 `skills/`）；同名路径**磁盘原文优先**（服务只补磁盘没有的）；技能服务缺失或抛错只 `log.warn`，**不编造告警**、不阻断导出；旧备份包 / 旧快照没有层字段一律按**用户层**处理（改造前行为，不猜）；`PatchFileFacade` 的方法签名与 `phase4-crash-child` 的只读实现未改。 |
| 验证方式 | `src/core/patch-layers.test.ts`（层优先级 / 写回层解析 / 单层读失败不阻塞）；`src/adapters/files.test.ts` 的 issue #71 四例（服务合并、磁盘优先、服务缺失不告警、非法技能名路径安全）；`src/adapters/mcp.test.ts`、`src/adapters/prompts.test.ts`、`src/adapters/plugins.test.ts` 的档案层读写例；`tests/core/patch-file-snapshot.test.ts`（快照记层 + 回滚写回原层、旧计划项回落用户层）；`src/index.facade.test.ts`（激活行写进**档案层**）。 |

### G-18 含 vault 的备份里带着凭据原文，导入后仍要求人工重填（issue #39）

| 项 | 内容 |
|---|---|
| 基线问题 | 宿主导入路径 `tryDecryptCredentials`（`src/index.ts`）与同步引擎 `credentialsMapFromYaml`（`src/sync/snapshot-crypto.ts`）解析 `.credentials.yaml` 时**只认顶层字符串项**（DSH 预发布扁平布局）。DSH v1 布局把凭据值放在顶层 `refs:` 块下（文档形状：`version: 1` / `refs:` / `records:`，见 `dsh-credentials-local` 的 `parseCredentialsDocument`），而 `refs` 是对象 → 被 `typeof v === 'string'` **整段**过滤 → 解出的 Map 为空。 |
| 后果 | `includeSecrets=true` 的加密备份里明明带着凭据原文（`security/secrets.enc` 可用导出密码解开），导入时 `/decrypt` 回传的 `refs` 恒为 `[]` → 导入向导的 `!decryptRefs.includes(s.ref)` 过滤失效（`ImportWizardView.tsx`）→ 所有 ref 进「待补录」清单；`/execute` 拿到的 `decryptedCredentials` 为空 → `result.missingSecrets` 非空。用户无从判断是「包里没有」还是「插件没认出来」。 |
| 修复位置 | ① 新增唯一解析口径 `src/security/credentials-yaml.ts` 的 `collectCredentialRefs`：顶层字符串项（扁平布局）**与**顶层 `refs:` 块下的字符串项（v1 布局）都收，`records` / `payload` 等嵌套结构忽略（会话秘密不是凭据 ref）；两处调用点（`src/index.ts`、`src/sync/snapshot-crypto.ts`）改为共用它，杜绝「同一文件格式两处口径漂移」。② 收窄 `import.vaultMissing` 的误导：`includeSecrets=true` 时导出侧**不**镜像明文 vault（`src/core/exporter.ts` 的 4b），跨机 vault 必然为空；值已由包内密文回填（plan 的 ref 全部被 `decryptedCredentials` 满足）时改用新消息 `import.vaultCredentialsFromArchive` 如实说明，确实还缺 ref 时才保留「人工重填」。 |
| 验证方式 | `src/security/credentials-yaml.test.ts`（8 例：v1 `refs:` 块 / 扁平布局 / 混排取并集且同名以 refs 为准 / 非字符串与空值丢弃 / 顶层非对象 / `refs` 块非对象 / 空 `refs`）；`tests/security/credentials-refs-import.test.ts`（2 例，走宿主真实路径 Exporter→`tryDecryptCredentials`→`executeImportPlan`：refs 块被认出 → `missingSecrets` 为空 + `credentials.set` 写回 + 不出现「需人工重填」；只覆盖部分 ref 时仍如实列出缺口）；`src/sync/sync-credentials.test.ts` 新增 v1 布局用例。**修复前实测**：两条集成用例失败（`decrypted.get('DEEPSEEK_API_KEY')` = `undefined`，`missingSecrets` = 两个 ref）。 |
| 附带改动 | `tryDecryptCredentials` 由模块私有改为具名导出（供集成测试走宿主真实路径）；新增消息 key `import.vaultCredentialsFromArchive`（zh/en 同步，`src/core/messages.ts`）。 |
| 未覆盖 | `src/adapters/workspaces.ts` 的 `applyItem` 是否会「整条覆盖丢本机键」（报告人描述）：**本轮核实后不成立** —— 真实宿主的 `DshWorkspaceFacade.writeRecord` 只 `setTitle`（必要时 `create`），从不写 `path` / `sessionIds`，本机独有键不可能被它覆盖。真正缺的是**会话归属**通道，已由本轮的 `attachSession`（见下）补齐。 |
| 真机验证（本轮 E2E） | 隔离 `DSH_HOME` + 独立 profile（`cmtest`，插件以 junction + `dsh.profile.bundles` 挂载）跑真实 DSH 实例：造两个真实会话（`session.v3.jsonl.zstd`，header `version: 3`）——① cwd 指向真实项目目录 ② cwd 为跨机路径 `D:/Ghost/proj`。**实测结果**：无映射 dry-run → `already-grouped`×2 + `ungrouped/cwd-unresolvable`×1；带映射 dry-run → `rewrite`（含 from/to 与目标工作区）；执行 → `status=ok`、`movedTo=…/--C-…-proj--/session-e2e0002`（目录已按映射后 cwd 的 projectKey 归位）、`note=restart-required`；**重启后**再跑 → 变为 `attach`，执行后 DSH 的 `storages/workspace.json` 中 `sessionIds` 出现 `session-e2e0002`（会话真正被登记）。**观察到的回退**：本轮 DSH 版本下改写后的注册表刷新（`indexHeader`）未返回成功（`typeof` 探测为 function，但整条路径最终 false，**根因未定位**），因此每个跨机改写会话需要「重启 DSH 后重跑一次归位」才能完成登记——该行为已如实体现在报告的 `note` 与 UI 文案里，未伪装成已完成。 |
| 浏览器真机验证（本轮，Agent Window 驱动真实 DSH Web） | 在隔离实例上走完整 UI 流程：导入页「会话归位」卡片 → 「检查（只读）」→ 报告（扫描 4 / 已归位 2 / 无法归位 1 / 使用中 1，并列出逐条计划）→ 「执行归位」→ ConfirmDialog → 执行 → 横幅变为**「本次已执行 2 条」**、行尾出现「已执行」→ 再点「重新检查」→ 变为**「已归位 2」**；DSH 侧 `storages/workspace.json` 的 `sessionIds` 同步出现 `session-e2e0001` / `session-e2e0002`，**左侧会话列表从 1 条 proj 变为 3 条**（恢复的会话真的显示出来了）。网络面板：`POST /api/dsh-config-manager/sessions/group` ×2 = 200；控制台除「我手动重启实例」造成的 SSE/WS 断连外**无插件报错**。 |
| 导入期位置护栏（本轮，Fix 1/2/5） | ① **前缀映射不再碰文件集合分区**（`ConfigAdapter.fileCollection` + `analyzer.applyMappingsToSections` 白名单）：`relativePath` 是身份不是配置，改写它等于把会话文件搬到 DSH 期望之外（诚实说明：真实命中形态是「映射 oldPrefix 恰好匹配 projectKey 段」或外来归档本来就错位，绝对路径前缀映射本来就匹配不到 `--…--` 开头的相对路径，所以这条是**防线**而非主因）。② **导入收尾自动归位**（新增 `ConfigAdapter.finalizeApply` + `SessionStoreFacade.readLogCwd/relocateDir`）：写完 sessions 分区后逐会话比对「目录段 == `projectKeyOf(首帧 cwd)`」，不一致就归位到推导目录（同根内、不覆盖、有锁不搬、搬后自检）；读不出 cwd（非 zstd/首帧不完整）→ 跳过并如实报告，绝不猜；归位失败记 failed（默认硬问题）。③ **缺工作区可一键补齐**（`provision` 动作 + `provisionWorkspace` 开关）：目录在本机存在但没有工作区指向它时，报告里给「添加工作区并登记 N 条」按钮，用户点了才用 DSH 官方 `workspaceRegistry.create` 建/复用工作区再 `attachSession`（**默认不自动执行**：工作区列表是用户自己的组织方式）。 |
| 相关单测/真机验证 | 单测：`src/core/analyzer-mapping.test.ts`（文件集合分区不被改写，含「不传白名单就会改写」的反证）、`src/adapters/sessions.test.ts`（收尾归位的 4 类分支）、`src/core/session-group.test.ts`（provision 的 4 类分支：默认只报告 / 显式执行 / 中途已在 GUI 建好则复用 / 目录不存在则失败）、`tests/route/sessions-group-store.test.ts`（`relocateDir` 真机文件系统：搬迁 + 拒绝越界）。**实测踩点**：会话日志**位置与 header cwd 不一致**会让 `dsh web` 直接拒绝启动（`corrupt session log … header id and cwd identify …`；同一 id 落在两个 projectKey 目录则 `duplicate JSONL session id …`），而那时插件也加载不了 —— 所以护栏**必须**在导入期或离线做，事后进不去。 |
| 真机测试发现并修掉的两个缺陷 | ① **UI 谎报**：执行成功后横幅仍写「可归位 N 条（尚未写入）」——新增执行态结论码 `SessionGroupVerdictCode`（`applied` / `ready` 分离）+ 行级「已执行」提示 + `sessionsGroup.verdict.applied` 文案（含单测）。② **半套改写会炸下次启动**：DSH 启动时硬校验「会话日志位置 == `projectKey(header.cwd)/id`」，实测只改 header 不搬目录会直接报 `corrupt session log ... header id ... and cwd identify ...`（同一 id 出现在两个 projectKey 目录则报 `duplicate JSONL session id ... in multiple project directories`，两者都让 `dsh web` 起不来）。因此改写类会话现在**必须**连目录一起归位，搬不动（conflict/locked 等）就**回滚首帧改写**并记 `note=rewrite-rolled-back`，绝不留半套（含单测）。 |
| 浏览器真机复验（本轮，Fix 5「缺工作区一键补齐」） | 在隔离实例（空注册表：storages/workspace.json = initialized:true + workspaceIds:[]）里放 3 个会话：2 条 cwd 指向本机真实目录、1 条 D:/Ghost/proj3（跨机）。Agent Window 走完整 UI：「检查（只读）」→ 扫描 4 / 使用中 1 / **缺工作区 2** / 无法归位 1，按钮**「添加工作区并登记 2 条」**；点击 → 横幅**「本次已执行 2 条」**、徽章变**「已建工作区 2」**、两行变**「已归入工作区 · 已创建工作区并登记」**、按钮消失；DSH 侧 storages/workspace.json 新增工作区（path=…cm-e2e-45\home\proj、title=proj、sessionIds=[session-e2e0001, session-e2e0002]）；再点「重新检查」→ **已归位 2** / 无法归位 1 / 使用中 1，吐司「检查完成：待处理 0 条」。 |
| 同一轮修掉的第 3 个 UI 谎报（Fix 5 后续） | **提示数字取自「计划」而不是「实况」**：点完「添加工作区并登记」后，工作区确实建了、2 条会话也确实登记了，吐司却说**「登记 0 条、搬迁 0 条」**，横幅还从 applied 退化成「缺工作区…可一键添加」——因为 sessionGroupCounts.actionable 按定义不含 provision（它本就不属于默认「执行归位」按钮）。修法：① src/ui/session-group-view.ts 新增 sessionGroupOutcome(report)（**只统计 status === 'ok' 的真实写入**：registered / moved（按 movedTo）/ rewritten / created（按 workspaceId 去重）），吐司改用它；② 新增计数 provisioned（outcome==='provision' && status==='ok'）与行类别 provisioned（语义色 ok），徽章只显示「还没补上的缺工作区」（provision - provisioned）；③ 结论码 applied 的判定提前到 provisionable 之前（建工作区 + 登记也是写入）；④ 「检查」吐司口径与卡片一致（actionable + provision - provisioned，实测**「待处理 2 条」**，旧文案是自相矛盾的「可归位 0 条」）。单测 src/ui/session-group-view.test.ts 16 例（新增 provision 执行后语义翻转 / 执行实况统计 / 零写入不虚报 3 例）。 |
| 本轮实测踩点（给后来者） | 插件**运行中**时 $DSH_HOME/storages/workspace.json **不是**权威：宿主 registry 的内存状态才是，插件 listRecords() 读的是内存 → 想复位隔离实例必须**先停宿主再改文件**（本轮第一次复位没停宿主，规划读到的还是旧记录；手改文件与内存不一致还会让 dsh web 启动报 workspace domain is inconsistent: registry order references missing workspace，修法是让 workspaceIds 与 tables.workspaces 保持一致或同时清空）。 |
| Fix 3：离线 CLI `sessions repair`（本轮落地） | DSH 起不来时插件也加载不了，在线路径全部失效，因此新增唯一可用的离线通道：`dsh-config-manager sessions repair [--home <dir>] [--fix] [--keep <dir>] [--map old=new]...`。语义：读每条会话首帧 cwd → 目录归位到 `projectKeyOf(cwd)`（与在线 planner 同一个实现，**不用映射也能修**：位置与 header 一致后 DSH 就能启动）→ `--map` 命中则先改写首帧 cwd（其余帧逐字节保留）再搬 → 默认 dry-run 零写入；目标已存在拒绝覆盖；session.lock / 缺 cwd / 多 generation cwd 不一致只报告；重复 id 只在 `--keep` 点名保留谁时把其它副本移进 `sessions/.cm-repair-quarantine-<时间戳>/`（**只搬不删**）；改写后搬不动则回滚改写，绝不留半套。实现：纯规划 `src/core/session-repair.ts`（零 IO）；读盘/改写/搬迁在 `src/cli/sessions-repair.ts`（不 import 任何 DSH 运行时）。单测：`src/core/session-repair.test.ts`（8 例）、`tests/cli/sessions-repair.test.ts`（8 例，真实临时目录：dry-run 零写入 / --fix 归位 / --map 改写+搬 / --keep 隔离 / 冲突退出 1 / 缺 sessions 目录 / --map 形状非法 / --json）。 |
| Fix 3 的顺带重构（单一来源） | 会话日志的字节级读写原本只存在于 `src/index.ts` 的 DshSessionStoreFacade 内；CLI 需要同一套语义，于是抽出 `src/utils/session-log.ts`（readLogCwdFromBytes / readLogFileCwd / rewriteSessionLogFile / rewriteSessionLogDir / PROJECT_KEY_RE / sessionLogNames），宿主适配器与 CLI 共用同一份改写序列（只换第 1 帧 + 尾部流式拷贝 + 发布前自检 + 多 generation 回滚）。回归证据：`tests/route/sessions-group-store.test.ts` 12/12 通过（真实文件系统的 moveSession / rewriteCwd / relocateDir），新增 `src/utils/session-log.test.ts`（8 例）。 |
| Fix 4：路径映射接进「会话归位」卡片（本轮落地） | 此前 UI 没有映射来源，跨机会话在界面上永远只报「无法归位」（只有 headless API 能带 mappings），卡片文案也如实写着「本面板暂未提供映射来源」。现在：① 卡片订阅 run store，自动复用导入计划里的 pathMappings（用户改过就以用户的为准）；② 报告里 reason=cwd-unresolvable / mapped-unresolvable 的会话由 `src/ui/session-group-view.ts` 的 sessionGroupPathIssues 转成可填的映射条目（按 cwd 去重、带当前映射作建议值、已有映射一并列出）；③ 复用 PathMappingForm 收集输入；④ 输入改动即标记 stale（横幅提示「请重新检查」）并禁用执行按钮 —— 保证**执行用的映射与规划用的是同一份**；⑤ 重新检查时把生效映射写进报告。i18n 新增 sessionsGroup.mapping.*（zh/en），并改掉 hint 里「本面板暂未提供映射来源」。单测：`src/ui/session-group-view.test.ts` 18 例（新增 2 例）。 |
| Fix 3 真机验证（本轮） | 隔离实例上把 `session-e2e0001` 的目录挪到错误的 projectKey 段 → `dsh web` **直接拒绝启动**（实测报 `corrupt session log … header id … and cwd identify …`，并指出该日志「应该」在哪个项目目录下）→ `dsh-config-manager sessions repair --home <home>` 先给出零写入计划（扫描 4 / 位置正确 3 / 待搬家 1，exit 0）→ `--fix` 搬回 → 再启动 DSH 成功（打印 token，exit 0）。另用 `--map <本机 proj 目录>=D:/Ghost/proj3 --fix` 反向把 5 个会话一次性改写+搬回跨机状态（5/5 成功、无失败；每条都只换第 1 帧），随后 DSH 仍正常启动 —— 证明「只换首帧 + 连目录一起归位」这条不变量在真实 DSH 上成立。 |
| 同一轮真机发现并修掉的第 5 处谎报（Fix 4 后续） | 执行确认弹窗写着「不修改任何会话日志内容」，但带映射执行时**确实会改写首帧**：真机测试里弹窗这么写、执行后 5 个会话的首帧 cwd 被改写、目录也被搬走。修法：新增 `sessionsGroup.confirm.messageRewrite` 与 `sessionsGroup.action.executeTitleRewrite`（zh/en），判定提成纯函数 `src/ui/session-group-view.ts` 的 sessionGroupRewritesPlanned(report)（计划里存在 rewrite 即视为会改写），卡片按它二选一。真机复验：改写计划 → 弹窗「…其中跨机会话会先只替换会话日志第 1 帧 header 的 cwd（其余帧逐字节保留）…」；重启 DSH 后变成纯登记计划 → 弹窗回到「不修改任何会话日志内容」。单测：`src/ui/session-group-view.test.ts` 19 例（新增 1 例）。 |
| 「重启 DSH 后再跑一次归位」这条 workaround 的真机闭环（本轮） | 跨机改写在真机上仍拿不到注册表索引刷新（`note=restart-required`，根因未定位）；本轮把这条 workaround 走完：改写+归位 5 条 → 停 DSH 重启 → 重新「检查」→ 5 条全部变成「登记」（不再需要改写）→「执行归位」→ `storages/workspace.json` 的 `sessionIds` 真的出现这 5 个会话（含此前缺席的 `session-e2e0003`）。即 note 里的指引是可执行的，不是托词。 |
| 会话恢复流程重构（本轮，用户拍板）：**彻底移除「会话归位」**，改为「导出连带工作区 + 导入期一条映射改两处」 | 用户不喜欢独立的归位面板；新流程把归属关系交给导出/导入这对动作本身：① **导出耦合**：只要导出含 sessions 分区，`exporter.coupleSessionWorkspaces` 就把拥有这些会话的工作区记录（含 `sessionIds`）一并纳入 `workspaces`，并在报告里给一行 `export.sessionsWorkspacesCoupled`（条目级选择按 sessionIds 精确匹配；只给 `sessions.limit` 时按「凡声明了 sessionIds 的工作区都带上」宽进）。② **导入期一条映射改两处**：`SessionsAdapter.finalizeApply` 用 `ctx.pathMappings` 命中后先 `rewriteLogDir` 只换首帧、再 `relocateDir` 归位到 `projectKeyOf(映射后 cwd)`、搬不动就回滚首帧（回滚失败按硬失败上报）；未命中退回原有位置护栏。③ **登记挪到收尾之后**：`ConfigAdapter.finalizeImport`（新增钩子，APPLY_ORDER 全部跑完再执行）让 `WorkspacesAdapter` 用 DSH `attachSession` 逐个登记 `sessionIds` —— 旧实现在 `applyItem` 里登记时会话文件还没写完/首帧还没改写，必然失败（正是「数据恢复了却显示不出来」的旧症结）。④ **移除物**：`core/session-group.ts`、`core/session-relocate.ts`（拆出 `core/path-mapping.ts`）、`ui/session-group-view.ts`、`client/sessions/`、`POST /sessions/group` 路由与 `groupSessions` 导出、宿主门面 `listStored/liveSessionIds/moveSession/rewriteCwd` 与 `StoredSessionInfo`、会话归位的界面文案（zh/en 共 208 行）、三处卡片样式。⑤ **保留**：离线 CLI `sessions repair`（DSH 起不来时唯一通道）、`utils/session-log.ts` 字节改写、导入期位置护栏、`reindexSessionHeader` 尽力刷新。单测：`src/core/export-coupling.test.ts`（3：精确连带 / limit 宽进 / 不导会话不连带）、`src/core/finalize-order.test.ts`（1：finalizeImport 必须在所有 finalizeApply 之后）、`src/adapters/sessions.test.ts`（+3：改写+归位 / 搬不动回滚 / 无改写能力只报告）、`src/adapters/workspaces.test.ts`（3 改为 finalizeImport 语义）。 |
| 导出耦合加固（本轮，真机事故复盘）：**绝不产出「有会话、没工作区」的包** | 事故现场：用户在运行中的 DSH 实例里导出「历史会话」（未勾工作区），得到的包 `sections.sessions=true` / `sections.workspaces=false`，目标机导入后会话在工作区列表里看不见，被理解成「对话丢了」。取证：① 该包 manifest 写着 `exporter.version=0.1.63`，但导出那一刻的运行进程**早于**耦合逻辑那次构建（宿主半只在 DSH 启动时加载，构建产物换了进程没重启）；② 本机 7 条工作区记录**全部**声明了 `sessionIds`，只要耦合生效就一定会被带上；③ 对运行中的 3080 实例直接 `POST /api/dsh-config-manager/export`（`only:['sessions']`、`sessions:{limit:1}`）实测返回 `sections.workspaces=true` + 「已连带导出 7 条与会话相关的工作区记录」+ `report.included` 含 workspaces —— 证明**当前构建**的耦合是好的，问题只出在未重启的旧进程。加固：① `exporter.coupleSessionWorkspaces` 改为回报 `{ ids, total, matched, unreadable }`：匹配不到归属时**整分区带上全部工作区记录**（多带纯元数据无害，漏带 = 用户以为丢数据）；② 分区选定的第二道 `includeItems` 过滤改用**连带后的**白名单（`src/core/exporter.ts`）——此前用户「把工作区全部取消勾选」下发的 `includeItems.workspaces = []` 会把刚被强制选中的分区再挡掉；③ 四种结果各有一条报告文案（`export.sessionsWorkspacesCoupled` / `sessionsWorkspacesCarriedAll` / `sessionsWithoutWorkspaces` / `sessionsWorkspacesUnreadable`），绝不静默；④ 导入侧 `analyzer.analyzeBundle` 在「有 sessions 分区、无 workspaces 分区」时给出 `import.sessionsWithoutWorkspaces`（分析阶段即可见，历史包会被自动指出来）。单测：`src/core/export-coupling.test.ts`（+4：整分区带上 / 本机无记录告警 / 空工作区白名单不得挡掉连带 / 注册表不可读时导出照常+告警）、`src/core/import-sessions-visibility.test.ts`（+2：有会话无工作区必告警、有工作区不误报）。**残余**：运行中的 DSH 实例必须重启才会加载新构建（宿主半无热重载），这正是本次事故的直接原因。 |
| 选择器层会话↔工作区联动（本轮，用户要求） | 规则：**勾了会话 → 自动勾上拥有它的工作区；取消工作区 → 它的会话一起取消**（导出页与导入向导同规则，因为共用 `ContentPicker`）。实现：`SelectionUnit.sessionIds`（`WorkspacesAdapter.listUnits` 给导出清单、`analyzeImport` 给计划项带上；新增 `PlanItem.sessionIds`）→ `src/ui/selection-model.ts` 的 `applySessionWorkspaceCoupling(sel, nodes, focus)`；`ContentPicker` 用一个 `commit()` 出口统一调用，`focus` 由本次动作所在分区决定（`sessions` / `workspaces` / `both`）—— 两条规则在「会话勾着、工作区被取消」时会互相抵消，必须按方向定夺；配对只认 sessionIds，不按路径（跨机路径不可靠）。另加提示文案 `picker.sessionWorkspaceLinked`（仅当会话与工作区单元同时存在时显示）。单测：`src/ui/selection-model.test.ts` 新增 4 例。**真机 GUI 复验**（隔离实例，导入后 7 条会话 + 1 个工作区）：起态 工作区 1/1、历史会话 7/7 → 取消工作区 → **工作区 0/1、历史会话 6/7（部分）**（只撤销了该工作区自己的会话）→ 重新勾上会话分区 → **历史会话 7/7、工作区自动回到 1/1**；提示行同时可见。导入侧数据面已实测：`/plan` 返回的工作区项带 `sessionIds`（6 条）、会话项 `unitId` 为 `sessions:<projectKey>/<sessionId>`，与导出侧同命名空间。
**真机补漏（本轮，用户复验「链式选择还是不动」）**：三处缺陷，均在真机复现并修掉 —— ① **清单未读 = 联动空转**：导出页单元清单逐分区惰性拉取，用户先取消「工作区」再勾一个对话时，
`sessionIds` 的数据源（工作区单元）根本不在选择器里，联动只能 no-op（真机复现：勾一条对话 → workspaces 分区 none、0/7 工作区被勾）。修法：`couplingInventorySections`（勾了 sessions 必须连 `workspaces` 清单一起读）
+ `ExportView` 清单到货后补一次联动（方向固定 `sessions`，`sameSelection` 幂等防自激）。② **id 形态失配**：本机 806 个会话目录里 **158 个是 `session-<uuid>`、648 个是裸 `<uuid>`**，而注册表 `sessionIds` 一律是全量 `session-<uuid>`；
会话单元末段是**目录名**，直接比较对不上（新增零依赖 `sessionIdKey` 归一化，core 与 UI 共用；`projectKeyOf` 同时下移到零依赖 `core/session-select.ts`，`session-meta.ts` 继续 re-export）。③ **判据不足**：`sessionIds` 覆盖率极低（真机实测一次可选择 **570 条会话里只有 23 条**在内），
而 DSH 自己按「会话 cwd 的目录键 == 工作区 path 的目录键」把会话显示在工作区下。修法：新增第二判据 `projectKey`（宿主 `listUnits` / `analyzeImport` 直出；旧宿主未回传时客户端用单元 `detail`=绝对路径现算），core 连带匹配同口径（`exporter.coupleSessionWorkspaces`）。
**真机数据复验（现行运行的宿主，未重启）**：`/export-preview` 实测 payload 不带 `projectKey`，客户端由 `detail` 现算后 **570/570** 会话都能认到工作区（此前 23/570）；勾一条新形态（裸 uuid）会话 → workspaces 分区 partial、**恰好 1/7** 工作区被勾上；
反向取消该工作区 → 这条会话被取消、其它目录的会话不动。单测：`src/ui/selection-model.test.ts`（+4）、`src/core/export-coupling.test.ts`（+2）。**残余**：导出页**刷新页面**即可生效（客户端半）；导入页链式选择依赖宿主回传 `PlanItem.projectKey`，需**重启 DSH**（宿主半无热重载）。 |
| 跨机基础路径自动重定基（本轮，用户补充） | 问题：DSH 基础路径（`$DSH_HOME`）在不同设备上可能不同（如 `/opt/dsh/.dsh` vs Windows 盘符形态），而备份里的路径是绝对路径 —— 目标机即使把目录建出来，路径语义依旧是源机的，会话/工作区仍然对不上。做法：① 导出时把本机 home 写进 `manifest.sourceHome`（可选字段；旧包无此字段 → 行为与改造前逐字一致）；② 导入时 `analyzer.rebaseMapping(sourceHome, 本机home)` 生成一条 `{oldPrefix, newPrefix, appliesTo: []}`，**插到用户映射之前**并入 `plan.pathMappings`（`createImportPlan` 与 `executeImportPlan` 都读它 → 结构化分区路径叶值 + 会话首帧 cwd + 目录归位一起生效），计划里用 `ImportPlan.automaticMappings` 如实暴露；③ 安全边界：只处理**绝对路径**、前缀必须落在**段边界**（`applyPrefixMappings` 语义，`/opt/.dsh` 不会误伤 `/opt/.dsh-extra`），相对路径 / 两边相同 / 缺字段一律不猜；用户映射排在后面可覆盖。单测：`src/core/base-path-rebase.test.ts`（3 例：规则生成边界 + 不同 home 时规则排在用户映射之前并写进 `automaticMappings` + 相同 home 时零自动改写）。**UI 展示（本轮补齐）**：`src/ui/import-wizard.ts` 的 `importBasePathNotices(plan)` 从 `plan.automaticMappings` 取出规则 → 导入向导「内容选择」阶段渲染一条信息 Banner（`import.preview.rebase`，zh/en），文案为「已自动重定基：源机基础路径 → 本机基础路径」；单测覆盖 `importBasePathNotices`。**未验证**：向导的备份选择是原生系统文件对话框，浏览器自动化无法驱动，故未做像素级真机复验（`npm run typecheck` / `npm test` 通过 / `npm run build` + 产物 grep 已过）。 |
| 后续已补（本轮） | 报告人列的 API 三项已落地（同一 issue 的 Feature 1–3，语义见 `docs/spec/headless-consumption.md` §4.5）：① `/export` / `ExportOptions.sessions: { limit }` —— 0 = 不带 / 负数 = 全带 / 正数 = 最新 N 个；单位 = 会话目录（同一会话的新旧日志一起走），文件名判据 `^session(\.[A-Za-z0-9]+)*\.jsonl(\.zstd)?$` 不写死（`session.lock` 不算会话），排序用会话日志的最新 mtime（`FileSystemFacade.mtimeMs`；未实现则退回全量 + 告警，绝不把未知当最旧）；核心 `src/core/session-select.ts` + `SessionsAdapter.restrictUnits` + `Exporter` 的显式选中。② `/analyze` 可选 `decryptPassword` → `ImportAnalysis.credentials: { inArchive, refs, satisfied }`（只回传 ref 名，永不回传值）。③ `/execute` → `ImportResult.credentialsRestored`（从加密归档内解出并回填的条数，只增不改）。**本轮已落地 P1+P2**：`POST /api/dsh-config-manager/sessions/group`（缺省 dry-run）+ 引擎 `groupSessions`（`src/core/session-group.ts` 编排 + `src/core/session-relocate.ts` 纯规划）：按 header cwd 的 realpath 认到本机工作区 → 走 DSH registry 的 `attachSession` 原子登记（插件**不**直写 `workspace.json`：那是内存权威域，直写会被后续 workspace 写覆盖）→ 在同一会话根内把目录归位到 `projectKeyOf(cwd)`（目标已存在不覆盖 / 目录内有 `session.lock` 不搬 / 搬后自检失败回滚）；活跃会话跳过，读不到活跃列表则只报告不落盘。**P3 已落地（本轮）**：跨机 cwd 变化（源机路径在本机 realpath 不解析）的会话，在调用方提供导入时用过的 `mappings` 时按四档判定 —— 映射目标不解析 / 目标机无对应工作区 / 宿主无改写能力 → 只报告 `rewrite-required`；三者齐备 → `rewrite`（**只替换会话日志第 1 帧 header**、其余帧逐字节保留、同 id 的全部 generation 一起改、失败回滚、发布前自检；随后刷新注册表索引 → 登记进工作区 → 目录归位）。宿主无法刷新注册表索引时如实给出 `note: restart-required`（重启 DSH 后重跑一次归位即走 P2 路径完成登记）。**唯一越界点**：依赖 DSH `WorkspaceRegistry.indexHeader`（d.ts 标 private，已能力探测，不整体重建索引）；该实现全部隔离在宿主适配器内、可整体删除。判定与规划口径（含 `report.actions[]` 形状与写入边界）见 `docs/spec/headless-consumption.md` §4.6。 |

| 会话导入后仍看不见（本轮真机，issue #45 ③） | 真机复现（隔离 home + 真实 DSH 实例）：用户导出 3 次对话 + 7 条工作区记录，导入后**这 3 次对话在工作区里全都看不见**，报告反倒刷出 7 行「0 个会话已登记，126/5/7/6/1/9/2 个未能登记（cwd 在本机不存在或未映射）」。取证两条根因：① **包不自洽** —— 注册表 `sessionIds` 覆盖率极低（真机实测 570 条会话里只有 23 条），用户勾选的这 3 个 id **根本不在**任何工作区记录里，而记录里那 156 个 id 又**一个都没被导出**（sessions 分区只有 3 个文件）→ 导入侧只按记录的 `sessionIds` 登记 = 「该登记的没登记、不该登记的 156 个全失败」，且失败文案把原因猜成「cwd 未映射」，用户照它改映射永远无效。② **id 形态失配** —— DSH 只认会话日志首帧 header 里的 `id`，而它 `session-<uuid>` / 裸 `<uuid>` 两种形态并存（实测目录名与 header id 逐字相同）；照目录名推成 `session-<uuid>` 后 `attachSession` 被 `session persistence holds no such session` 拒掉。修复位置：① 导出侧新增 `declareBundledSessionsInWorkspaces`（`src/core/session-select.ts`）：按 cwd 目录键把**本次真正带走的会话**声明进所属工作区记录（按裸键去重、只增不减、写日志侧原名），报告新增 `export.sessionsDeclaredInWorkspaces` 行（`src/core/exporter.ts`）；② 导入侧 `WorkspacesAdapter.finalizeImport`（`src/adapters/workspaces.ts`）登记目标 = 记录声明的 ∪ 包内带数据的，失败**按「这次有没有带它的数据」分类**（带数据的失败 = warning + 真实原因；包外会话 = 不计失败的信息行 `adapter.workspaceSessionsOutsideBundle`），并对每个会话先试声明形态、再试另一种命名形态。 |
| 会话导入后仍看不见：复核路径与单测 | 复核：`outputs/e2e-45b/run.ps1` 在隔离实例（`DSH_HOME=D:\dsh-cm-home`，profile `cmtest`，插件 junction 到本仓库）真导入该包，直接看 `storages/workspace.json` 的 `sessionIds` 与 `/execute` 返回的逐项结果。单测：`src/adapters/workspaces.test.ts`（包内未声明会话也登记 / 声明与 header 形态不同时自动兜底 / 带数据失败报真实原因 / 包外会话不计失败）、`src/core/session-select.test.ts`（bundledSessionDirs 两种形态原名 + 不可信输入 + 按裸键去重）、`src/core/export-coupling.test.ts`（从产物 zip 读回 `workspaces/workspaces.json` 断言声明结果）。 |

### P-1 peerDependencies 体积：headless 消费者为浏览器半付费

| 项 | 内容 |
|---|---|
| 基线问题 | `react` / `react-dom` 在 `peerDependencies`（16 个 peer 中的 2 个），且 **`peerDependenciesMeta` 字段完全不存在** → headless 消费者 `npm i` 时被自动安装约 4.7 MB，而 host 半（`lib/index.js`）完全不引用 react。 |
| 修复位置 | `package.json` 新增 `peerDependenciesMeta`，16 个 peer **全部** `optional: true`（`package.json:108-157`）；`lucide-react` / `@radix-ui/react-dialog` 已在 `devDependencies`（经 `tsdown.config.ts` 的 `deps.alwaysBundle` 内联进 `lib/client.js`）。 |
| 验证方式 | **隔离安装实测**：`npm pack` → 空目录 `npm install <tarball>`（**不加任何 flag**）→ `node_modules` 顶层仅 `argparse` / `dsh-config-manager` / `js-yaml`，**无** `@deepseek-ai/*`、`react`、`react-dom`、`lucide-react`、`@radix-ui/*`。**回归护栏**：`tests/packaging-contract.test.ts`（`P-1` 两条断言：peer ↔ meta 一一对应且 `optional === true`；`dependencies` 仅含 `js-yaml`）。 |
| 未验证边界 | 其他包管理器（pnpm / yarn）对 `peerDependenciesMeta.optional` 的处理**未实测**；本结论只覆盖 npm。 |

### P-2 `lib/**/*.map` 随包发布

| 项 | 内容 |
|---|---|
| 基线问题 | `package.json` 的 `files` 会带上 `lib/client.js.map`（1.81 MB）与 host 侧 `.map`，每个消费者为体积付费。 |
| 修复位置 | `package.json` 的 `files` 含排除项 `!lib/**/*.map`（且排在 `lib` 之后，否则 npm 的 `files` 求值顺序会让排除失效）。 |
| 验证方式 | `npm pack` 产物文件清单中不含 `*.map`；**回归护栏**：`tests/packaging-contract.test.ts`（`P-2` 两条断言：`files` 含 `!lib/**/*.map` 且顺序正确；`files` 仍含 `lib` / `src` / `cordis.patch.yml`）。 |
| 附带说明 | `src/` 仍随包发布（约 3.9 MB）。这是**有意的可审计性取舍**，未改；如未来要减小体积需单独决策。 |

---

## 2. 本轮审计新发现的缺陷（**均已修复并收口验收**）

> 这两条**不在** `0.1.59` 基线的登记范围内，是本轮审计发现的**收窄残留**——即「修 A 时留下的 A 的边缘」。
> **收口状态**：修复已落地，且已由独立验收确认（回归测试可复现、变异验证证明测试有牙）。

### G-12 G-04 的收窄残留：checksums 表缺失/为空时「未登记条目」漏报

| 项 | 内容 |
|---|---|
| 问题 | 反向完整性检查（「ZIP 里在、校验表里不在」的条目）原本整段嵌在「表存在」分支内：剥掉 `integrity/checksums.json` 或把它置为 `{}` ⇒ 一个条目都不校验、也零告警，却 `valid=true`。 |
| 工作区现状 | `src/core/analyzer.ts` 的 `loadBundle`（表缺失/为空 → `import.checksumsMissing`）：`table` 为 `null`（表缺失）**或**键数为 0（表为空）时，统一产出 `import.checksumsMissing` 告警（文案「备份未提供完整性校验表，全部条目未被校验」）。此时反向检查（同一 `loadBundle`）不再运行——无表可对照。 |
| 回归测试（已存在于工作区） | `tests/conformance/roundtrip.test.ts` → `INT-02`（表缺失）、`INT-03`（表为空）、`INT-04`（非空表语义不变，防误报回归）。 |
| 收口状态 | ✅ 已修复并验收。变异验证：去掉新告警 → `INT-02`/`INT-03` 红灯；还原后逐字节一致。 |

### G-13 G-09 的告警去重

| 项 | 内容 |
|---|---|
| 问题 | 文件类分区的 secret 命中告警原本按 **hit** 计数且不去重：同一行同时命中「字段名」与「值形状」会产出两条**同路径**告警，少数文件就吃满 `MAX_FILE_SECTION_WARNINGS_PER_SECTION` 上限，导致含真实明文凭据的其它文件被静默淹没。 |
| 工作区现状 | `src/core/exporter.ts`：先按**文件路径**去重，再截断到 `MAX_FILE_SECTION_WARNINGS_PER_SECTION`（语义 = 不同**文件**数），并对被截断的文件数补一条**汇总告警**（截断不得静默）。`redactedHits` 仍计**全量命中**（报告统计通道 ≠ 告警通道）。常量与语义注释见 `:107-108`。 |
| 回归测试（已存在于工作区） | `tests/core/exporter.test.ts:381`（按文件去重 + 真有凭据的文件不被淹没）、`:436`（同一文件多形态命中只一条告警）、`:456`（超上限按文件截断 + 汇总告警）。 |
| 收口状态 | ✅ 已修复并验收。变异验证：回退为逐 hit 告警 → 3 个用例红灯（含「含真实凭据的文件必须被告警」）；去掉汇总告警 → 1 个红灯；还原后逐字节一致。 |

---

## 2b. 审计发现、且**由本轮修复自身引入**的两条（已修复）

> 这两条是**修 bug 的过程造出来的 bug**，单独登记。它们的价值不在于「又多修了两个」，而在于说明**为什么修复必须配独立对抗性审计**：两次都是「新写的防线看起来在守，实际没守住」。

### B1 新增告警把包内可控字符串送进未经 `redact()` 的 UI 通道

| 项 | 内容 |
|---|---|
| 问题 | `ImportWizardView` 渲染 `analysis.warnings` 时**没有**过 `redact()`（同一文件渲染日志行时**是**过的）。而本轮新增的三条告警文案恰好插值**包内/攻击者可控字符串**：ZIP 条目名（`import.extraEntries`）、`manifest.sections` 的键（`import.unsupportedSections` / `import.unsupportedSectionVersion`）。实测条目名 `rogue/sk-A1b2C3d4…txt` 会被**原样显示**。 |
| 为什么是本轮新引入 | 修复前 `analysis.warnings` 的内容全是**固定枚举**（分区 id、已知常量），没有可控输入，因此该渲染点从不需要 redact。**是修复本身创造了这个暴露面。** |
| 修复 | `src/client/import/ImportWizardView.tsx` 渲染点改为 `{redact(w)}`（与同文件日志行同档）。 |
| 回归测试 | `tests/client/import-wizard-redaction.test.ts`（源码守卫：定位 `analysis.warnings.map` 回调体，断言必须调用 `redact(`）。变异验证：改回 `{w}` → 红灯。 |

### B2 VER-03 源码守卫恒绿：只测「符号存在」，不测「接线」

| 项 | 内容 |
|---|---|
| 问题 | G-06 的守卫只 grep `src/core/*.ts` 中是否存在 `migrateToCurrent` 符号。而该符号的**唯一代码行在 `runSchemaMigration` 函数体内**（恒存在）——**把 `loadBundle` 的 `needsMigration` 接线删掉，守卫照样全绿**。这是「只测了实现所做的事」的循环论证：断言的是「文件里有这个符号」，而缺陷是「这个符号在导入路径上从未被调用」。 |
| 修复 | 守卫改为按花括号配平**解析 `loadBundle` 方法体边界**，断言方法体内存在 `needsMigration` 守卫，且 `runSchemaMigration(` 调用点**落在该守卫的受控块内**。 |
| 验证 | 独立复跑审计当初判定恒绿的突变（`if (needsMigration(...))` → `if (false)`）→ 守卫**红灯**，报「loadBundle 方法体内必须存在 needsMigration 守卫」；还原后逐字节一致。 |
| 已知代价 | 守卫是源码级：若将来有人改成等价间接形式（`const g = needsMigration(...); if (g) {...}`）会**误报红灯**（偏严，需人工判断）。`CURRENT > MIN` 真正发生时，建议补一条端到端迁移测试。 |

---

## 2c. 审计发现的其余缺陷（已修复）

| 编号 | 问题 | 修复 | 验证 |
|---|---|---|---|
| **M1** | `config_backup` 构造 `Exporter` 时未传 `scanner` → 落回无 `scanText` 的默认扫描器 → 文件类分区扫描**静默失效**（HTTP 导出会报、Agent 工具不报） | `ModelToolsDeps` 新增可选 `scanner`，注入与 HTTP 路由同一个实例 | 行为测试（注入时告警 / 未注入零告警）+ 源码守卫；变异验证红灯 |
| **M1b** | **定时自动备份**（第三条导出路径）同样未传 `scanner`，且它是**无人值守**的——用户更不可能自己发现 | `BackupSchedulerOptions` 新增可选 `scanner`；`src/index.ts` 把 `createConfiguredSecretScanner(...)` 提为**单一实例**并注入三处 | 三处同一标识符（独立复核：`createConfiguredSecretScanner` 仅 1 处调用、3 处 `scanner: secretScanner`）；变异验证红灯 |
| **L1** | P-1/P-2 无自动化回归护栏（回归时不会报警） | 新增 `tests/packaging-contract.test.ts`（5 个断言：peer 全 optional、`dependencies` 仅 `js-yaml`、`files` 含 map 排除且顺序正确、`./schema` 指向运行时入口） | 6 种变异逐个红灯后还原（SHA-256 一致） |
| **L2** | `exports["./schema"]` 指向纯类型产物 `types.js` → 第三方 `import` 得到**空对象**；且 `CURRENT_SCHEMA_VERSION` 等版本工具**包外无法导入** | 新增 `src/schema/index.ts`（零 DSH / 零 `node:` 依赖）导出运行时值 + 类型：版本判定 9 + 分区表 4 + 分区注册表 11 = **24 个运行时导出**；`exports["./schema"]` 改指它（修复时该出口只有 13 个，后来分区注册表并入该出口才成 24 个） | 隔离默认安装后 `import('dsh-config-manager/schema')` 返回 **24 个运行时导出**（修复前 `{}`）；`SECTION_IDS.length === 15`。**回归测试位置**：`tests/packaging-contract.test.ts`（断言 `exports["./schema"]` 指向 `lib/schema/index.{js,d.ts}`，而非纯类型产物 `types.js`）+ `src/schema/registry.test.ts`（注册表零 node 依赖 / 分区集合一致） |
| **L3** | `env-lock` 的 heartbeat 走 `atomicWriteFile`（同目录 tmp 写 → rename）；`release()` 不等在途写 ⇒ `.dshcm.*.tmp` 残留在 locks 目录 → after-hook `rmSync` **ENOTEMPTY**（Windows 偶发） | heartbeat 写**串行化** + `release()` 前 `drainHeartbeat()`（顺带修掉 interval 写之间的并发 rename 竞态） | 连续 10 次单文件全绿；变异（移除 drain）→ 红灯。**拒绝用 `maxRetries` 掩盖**——那会留下真实缺陷 |
| **L4** | `run-store` 测试用固定 `sleep` 等轮询收敛，全量套件并发时定时器被拖慢 → 偶发 `actual: 'importing', expected: 'result'` | 改为 `waitFor(predicate, timeout)` 条件等待（**不削弱断言语义**，超时仍抛错） | 连续 10 次全绿；变异（破坏收敛）→ `waitFor` 超时抛错 |

---

## 3. 仍未修复的缺口

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

### G-30 checkpoint（会话 / 工作区 / 配置三态同点检查点）：**已接线可用**（2026-10-08）

| 项 | 内容 |
|---|---|
| 背景 | C-1 Q4 交付了 checkpoint 引擎（`src/core/checkpoint.ts`：三态捕获 + 内容指纹 + `samePointVerdictOf` 同点判定 + fail-closed 确认门 + 对象仓 / 台账降级）与 recovery prefix 下的 **7 条子路径**：`GET /recovery/checkpoints`、`GET /recovery/checkpoints/storage`、`POST /recovery/checkpoints/capture`、`GET /recovery/checkpoints/<id>`、`GET /recovery/checkpoints/<id>/preview`、`POST /recovery/checkpoints/<id>/rewind`、`POST /recovery/checkpoints/<id>/delete`（挂在既有 prefix 路由内分发，**不新增 `endpoint()` 条目**，因此 76 条路由快照不变）。宿主侧语义完整：预览零写入、未确认回滚 → 409 `denied` 且**零字节写入**、保护点 / guard 点不可删、存储栈不可用 → 503 + 结构化 guidance、SAFE MODE 下回滚/删除 423 而只读列表/预览不受影响。 |
| **当前状态** | ✅ **已接线可用（2026-10-08）**：环境 → 维护与诊断新增 `src/client/recovery/CheckpointCard.tsx`（紧跟会话体检卡：捕获表单的「关联会话」直接复用会话体检扫出来的 rows），⌘K 新增 `checkpoint.open`（与「事故恢复 / 救援模式」同族、同落点）。卡片覆盖 list / storage / capture / preview / rewind / delete 六条子路径：拍点（分块逐行填 + 「用该会话的 cwd 填充」+ 点名会话 + 可选备注 + 可选保护）、台账列表（三态徽章 / 同点跨度 / 手动点 vs 回滚前保护点）、只读预览（逐段 planned/changed/missing/leftovers + 会话游标 now→target + 同点判定）、逐段勾选回滚（默认只勾可回滚段；三态不全需显式勾「允许部分」）、删除（保护点与 guard 点禁用）。**判定全在 `src/ui/checkpoint-view.ts`**（框架无关、7 条单测），组件只装配。 |
| 仍未做（如实登记） | ① **CLI 入口**（`dcm checkpoint list/capture/rewind`）本轮未做 —— 用户明确只授权 GUI；② **「单条详情」子路径（`GET /recovery/checkpoints/<id>`）仍无消费者**，故未进客户端端口（预览已带回 `summary` 与同点判定，界面不需要额外一次往返）；③ **工作区分块仍是「手填 + cwd 一键填充」**，没有工作区选择器（引擎只接受显式绝对路径，这是刻意的：分块即回滚边界，不做隐式推断）；④ 界面侧**无真机点击验证**（本会话无浏览器交互）—— 证据是 typecheck + 单测 + 路由/命令守卫，不是「点过了」。 |
| 验证方式 | 引擎：`src/core/checkpoint.test.ts`（**18** 条：真实磁盘三态捕获、同点/跨度判定、保护点与 guard 点、分叉门、篡改记录、存储降级）；路由接口面：`tests/route/recovery-checkpoints.test.ts`（**5** 条，真 http server：七形态可达 / 409+denied+零写入 / 404/405/400 / 503+guidance / 保护点 / SAFE MODE）；**界面侧（2026-10-08 起有证据）**：`src/ui/checkpoint-view.test.ts`（**7** 条：未知码/未知态回落 unknown、note 与技术细节渲染前脱敏、可回滚与可删除判定、默认只勾可回滚段、会话候选按活跃倒序且 cwd 缺失不猜、分块解析 trim+去重）、`src/client/common/client-route-parity.test.ts`（三条新客户端路径登记为 prefix 路由，宿主路由快照仍 78 条）、`src/ui/commands.test.ts`（命令表 ↔ 壳层 `runCommand` 双向一致）。 |
| 已知限制 | 见 §4.1（T14-F3 / T14-F4）。 |

### G-31 云端点同步通道（S3 兼容系 ×5 / GitHub Gist）：**已接线可用**

| 项 | 内容 |
|---|---|
| 背景 | 批次 3 交付了两个完整的 `SyncTransport` 实现：`src/sync/s3/`（AWS S3 以及 oss / cos / minio / kodo 五家兼容商，共用 `sigv4.ts` 签名 + `s3-providers.ts` 变体表）与 `src/sync/gist/`（GitHub Gist REST）。两者自带通道枚举与配置读取（`src/sync/sync-config.ts` 的 `S3_COMPAT_PROVIDERS` / `CLOUD_SYNC_PROVIDERS`，非密字段存独立的 `sync-cloud-config.json`），密钥纪律与既有通道同档：文件里只有非密字段 + `secretStored` 标记，AccessKey Secret / Gist Token 的**值**只在 DSH credentials 槽位（`cloudSecretRef()`），回传 UI 只走 `CloudChannelView`（带标记不带值）。 |
| **当前状态（t11 + t12 后，2026-10-05）** | ✅ **已交付**：`SYNC_CHANNELS = ['git', 'webdav', 's3', 'gist']`（**声明处 = 零依赖 `src/utils/shared-constants.ts`**，宿主 `src/sync/sync-config.ts` re-export，客户端运行时 import 同一常量）；host 侧 `SyncConfig` 增 s3/gist 变体、`/sync/*` 读/写/清、`makeSyncEngine` 走**同一条引擎路径**（GFS 远端保留 / 会话删除墓碑 / 内容寻址 blob 仓 / `includeOptInSections`「会话绝不悄悄下行」/ `includeSecrets ⇒ encrypt` 全部继承，无旁路），autosync 对未配置的云端点**安静跳过**（不抛错、不构造引擎）；UI 侧 4 张通道卡 + 云端点表单（provider / endpoint / region / bucket / pathStyle / prefix / gistId / apiBaseUrl / filePrefix）+ zh/en 字典齐全。 |
| 六类端点 | **s3 / oss / cos / minio / kodo / gist** —— 前五家走同一份 SigV4 实现（方言表区分 `aws4` / `oss4`），gist 走 GitHub REST。配置形状与密钥纪律见 `docs/spec/sync-channel-v1.md` §6。 |
| **残余边界（如实登记，不得夸大）** | ① **未对真实云端点做端到端验证**：本批**没有真实云端凭据**，全部证据是模块单测 + 路由单测 + 客户端单测 + 全量 `npm test`；**没有**任何「对着真实 S3 / OSS / COS / MinIO / Kodo / Gist 跑通一次 push → pull」的记录 —— 不得声称端到端通过。② **gist 通道刻意不外置 blob**（能力边界见 **G-34**，是刻意设计不是缺陷）。③ 跨版本仍不做协议协商（G-19）、墓碑不代本机删除（G-20），两条边界对云端点通道同等适用。 |
| 验证方式 | `src/sync/s3/{s3-transport,sigv4,cloud-config}.test.ts` + `src/sync/gist/gist-transport.test.ts`（52 条）+ `src/sync/sync-config.test.ts` 云端点往返 4 条 + `src/sync/autosync-scheduler.test.ts` 2 条（未配置安静跳过 / `syncIsConfigured` 口径）+ `src/ui/sync-settings-view.test.ts` 与 `src/client/sync/*.test.ts`（四通道表单 / 就绪判据 / 凭据只写端口）+ 本批全量 `npm test`。 |
| 不变量（不得放宽） | 凭据值绝不进日志 / 产物 / 回传；S3 Secret / Gist Token 只经注入的 credentials 端口（`cloudSecretRef()` 槽位，**只写不回读**）；加解密密码仍只在进程内存 / DSH 凭据槽位（`syncPasswordRef` → `..._PASSWORD_S3` / `..._PASSWORD_GIST`）；非密配置只落 `sync-cloud-config.json`；`includeSecrets ⇒ encrypt`、非加密快照声明 `containsSecrets` 即拒绝等既有同步不变量对每个通道同等适用。 |

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
| 影响与现状 | ① 这是**能力边界不是缺陷**：不外置不会让 gist 通道坏掉，只是推送体积 / 文件数受 GitHub 限制，超限时的表现是**截断**（不是静默成功）。② **UI 目前没有「gist 不适合大分区 / 会话」的提示**（表单只做字段校验与「密钥只写凭据槽位」说明）—— **建议**在 gist 表单加一条提示（zh/en 字典），并在「通道 = gist 且勾选 `sessions`」时给出风险提示；**本条目只登记建议，表单改动不在本任务的 inScope（未动 `src/**`）**。 |
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
| 证据 | 来源 = `outputs/bug-audit/review-foreign-envhdr/REVIEW-t58-t40-report.md`（t58 §1/§2 的 payload 原文与谓词对照）+ `t58-verify-probe.mjs` / `t58-pipeline-check.mjs`；修复与本条登记 = t72。 |

### G-37 宿主整文件快照的「存在但读不出来」与保留清理的 fail-open（2026-10-08 UX 审查）

| 项 | 内容 |
|---|---|
| 现象 | ① `backupHostFiles`（`src/core/backup.ts`）在 `ctx.fs.readFile` 失败时落 `existed:false` —— 恢复侧 `planRestore` 把「快照里没有、现在有」判成 `hostFileRemove`，于是一次回滚**删掉用户真实的 settings.yaml** 并计入 restored（Windows 上文件被别的进程占用即触发）。② `prune` 的 recovery 引用豁免是 `.catch(() => new Set())` —— journal 扫描一次瞬时失败（EACCES / IO）被当成「无人引用」，可能删掉 SAFE MODE 恢复唯一的回滚点。 |
| 修法 | ① 读失败 / 存在性探测失败一律登记 `existed:true` + `unreadable:true`（无 blob）；`planRestore` 对这类条目只 `skip` 并说明「拍快照时存在但读不出来（占用/权限）」（`restore.hostUnreadable`），**绝不进入删除分支**。② 引用集合读不到即**放弃本轮清理**（宁可少删），并新增 `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`）让「这轮为什么没清理 / 清理为什么失败」可见。 |
| 护栏 | `src/core/backup.test.ts`（存在但读不出来 → existed/unreadable/blobPath 三字段 + durable+verified 不破；引用扫描抛错 → 两个快照都留着 + 有告警）、`tests/core/restore.test.ts` 的 `R-host-unreadable`（计划里零 `hostFileRemove`，说明含「读不出来」）。 |
| 未做 | 宿主整文件与**文件类分区**仍是两条读失败口径（后者「存在但读不到」会抛错、经分区级告警可见）；把宿主文件的 unreadable 也接进导出报告告警面属另一条线，本轮未做。 |
### G-24 剩余未做项（M1 复核，2026-10-06）

> 本轮（M1）落地清单与口径见 §1 的「M1 落地」「M1 口径」两行。以下是**仍未做**的部分，逐条登记：

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
## 4. 不是缺口、但已知的有损点

来自 `tests/conformance/README.md` §3.2 与规格 §7.3：

- **`prompts` 的 `systemPrompt` 形态**：源 namespace / patch 行里是字符串 `systemPrompt: "…"`，导入落盘形态为对象 `{ persona: "…" }`。persona **文本**无损，但字段**形状**改变（`RT-01` 已注明）。
- **已知分区内的未知字段不写回目标（分区相关，勿一句话概括）**：导入不是 round-trip 复制，而是把已知语义落到目标。规格 §7.3 实测结论是**分区相关**的：`settings` / `ui` / `mcp` / `prompts` / `credentialsStatus` → 未知字段不写回；`workspaces[]` 记录、`plugins.patch[].raw`、`providers.raw` → 会随「整体搬运」落到目标。因此**不要声称「未知字段会被保留到目标」，也不要声称「一律被丢弃」**。
- **文件类分区的 secret 命中不剥离内容**：G-09 修复后只「报告 + 告警」，命中的文件内容**原样进包**（见 §1 G-09 的边界）。
- **离线 CLI `backup` 收不到插件注册表里的技能**：GUI 导出经 `ctx.skills` 收编外壳技能（见 §1 G-33），而 CLI 有「绝不 import `@deepseek-ai/*`」的硬约束（`src/core/backup-plan.ts:6-10`），只能扫 `$DSH_HOME/skills` 目录；真机上该目录可能**根本不存在**，此时 CLI 备份的 `skills` 分区为空，并在报告里如实列为空分区（`分区无内容，未写入 / section empty, skipped: skills`）。这是**有意的能力边界**（不是静默丢失，也不是 G-33 的残留）：要完整的技能备份请在 DSH 健康时用 GUI 导出。

### 4.1 checkpoint 的两条已知限制（T14-F3 / T14-F4）

> 它们不是缺陷，而是**被有意保留的设计边界**；登记在这里是为了不让它们只活在验证报告里。

- **T14-F3 — workspace 段的 `restored` 不按 chunk（分块）递减**：`CheckpointSegmentResult.restored` 的语义是「**成功写回的文件条数**」（`src/core/checkpoint.ts` 的 `restoreWorkspace` 逐文件 `restored += 1`），**没有分块级计数**：记录里的某一条分块整段不可用 / 被跳过时，这个数字不会为它单独扣减，`detail` 里也只给 `restored=` / `failed=` / `leftovers=` 三个聚合值与逐条 reasonCode，不按分块标注。因此界面上的 `restored=N` 只能读成「N 个文件写回成功」，**不能**读成「N 个分块都恢复了」；逐条是否失败仍可从 `failed` / `reasonCode` / `leftovers` 核验。
- **T14-F4 — `capturedAt` 只保证 per-instance 单调**：三态的 `capturedAt` 取自引擎注入的时钟（`CheckpointEngineOptions.now`，缺省 `Date.now`），在**同一个实例内**非回退；它**不是**跨实例 / 跨机全局有序的时间戳（时钟回拨或两台机器时间不一致时不能据此排序检查点）。模块头已写明「**不假装原子**」（DSH 不提供跨态原子性）：`samePointVerdictOf` 只按 `spreadMs ≤ toleranceMs` + 三态可指纹判定 `samePoint`，不承诺三态真的落在同一瞬间。

---

## 5. 明确未验证的空白（不是「已验证」）

以下区域本轮**未被测试覆盖**，列为空白而非通过：

| 空白 | 原因 |
|---|---|
| `plugins` / `mcp` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的往返 | 需要 `npm install` 或更多 mock 编排 |
| 整体加密容器 `DCA1`（`encryptArchive` / `verifyEncryptedBlob`） | 本轮一致性套件只覆盖 `secrets.enc`（`DSC1`）路径 |
| 规格可独立实现性的 4 处缺规格 | 见 `docs/spec/bundle-format-v1.md` §11 与 T6 审计结论：压缩方法容错边界、`relativePath` 归一化、5 个分区的未知字段写回行为、`redactedHits` 的持久化语义 |
| `tests/**` 未被根 `tsconfig` 的 `include` 覆盖 | 根 tsconfig 只 include `src/**`，`tests/**`（228 个文件）曾长期处于类型检查范围之外——这正是下面那条 43 条错误得以积压的原因。**更正**：早期记录里写的「本轮用临时 tsconfig 单独验证通过」与实测矛盾，同口径复测（`tsc -p tsconfig.tests.json --noEmit`）得 **43 条错误**，真实结论是**未通过** |
| `tests/**` 的类型错误（曾实测 **43 条**，0 条在 `src/**`） | **已收口**：43 条全部修完（只改 `tests/**`，未放宽任何编译选项），`tsc -p tsconfig.tests.json --noEmit` → **exit 0**；工程配置 `tsconfig.tests.json` + `npm run typecheck:tests` 已落地，并在 `.github/workflows/ci.yml` 的 `Typecheck` 之后接入 `Typecheck (tests)` step。**历史信息（保留）**：接 CI 之前，`tests/**` 是类型检查盲区，43 条错误按码分布为 `TS2345`×15、`TS6133`×8、`TS2339`×7、`TS2740`×6、`TS2739`×2、`TS7006`×2，其余各 1 |
| 非 npm 包管理器对 `peerDependenciesMeta.optional` 的处理 | P-1 的隔离安装结论只覆盖 npm（见 §1 P-1 的「未验证边界」） |
| 普通导入（GUI 向导）是否恒使用 `parseZipHardened` | 需追宿主注入链，超出取证范围（规格 §11 已登记） |
| `source.platform` 取值是否被严格校验为枚举 | 源码只校验 `typeof === 'string'`（规格 §11 已登记） |
| `sessions` 分区（`includeSessions: true`）内未知字段的行为 | 结构上不可能承载未知字段，未单独跑一次实测（规格 §11 已登记） |
| 离线 CLI `backup` 在真机（`$DSH_HOME/skills` 不存在、技能全在插件注册表）上的技能覆盖范围 | CLI 只扫 `$DSH_HOME/skills`（§4 已列该边界）；「注册表技能在 GUI 导出侧确实被收编」有单测与真机导出取证，但 CLI 侧的空分区行为只有源码级推理，**未跑真机 CLI 验收** |

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
