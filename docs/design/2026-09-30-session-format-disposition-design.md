# 会话格式「处置开关」设计（下一轮）

> **状态**：**已全部落地**（core + UI + 路由；`docs/maintenance/known-gaps.md` 的 G-23 已标「已全部落地」）。§9 与文中「UI/路由待做」仅作历史进度记录。
> 前置 = known-gaps **G-23** 的会话格式体检与告警
> （工作区已落地：宿主探针 `src/utils/session-format.ts`、core 的 `sessionFormatWarnings`、
> 档案页版本展示；见 `CHANGELOG.md` 的「未发布」段）。
>
> **读者**：本仓库维护者。对外契约不受影响（不改 bundle 格式、不改同步快照格式）。

## 1. 要解决的问题

现在导入/同步**能发现**「包内会话格式高于本机 DSH 支持」并告警，但用户只有一条路：
**看见了，然后继续导入**。导入完成后这些会话文件落盘、工作区记录也登记了，可是 DSH 会静默跳过它们
（读不出的 `header.version` → `listArtifacts()` catch-continue）——盘上多了几百 MB，列表里一条不显示。

缺的不是检测，是**决策权**：用户既不能选择「不要带它们」，也不能选择「先升级再导」。

> 为什么不做「导入时自动降级转换」：DSH 只提供**相邻且向上**的迁移 API
> （`defineSessionFormatMigration` 断言 `toVersion === fromVersion + 1`，catalog 只暴露 `currentEncoder`），
> 而 v3→v4 的边是**多对一的语义变换**（producer 归并 + message 形状改写），不可逆；
> 手写降级器只会得到 strict 校验下的「corrupt session log」。结论与证据见 `docs/maintenance/known-gaps.md` G-23。

## 2. 本轮范围（目标）

在导入向导与一键同步的**确认页**，对「本机读不了的会话」给出三选一处置，并让选择落到计划项与报告：

| 处置 | 行为 | 用户可见结果 |
|---|---|---|
| `abort`（推荐默认） | 在**计划阶段**阻断，零写入 | 最前面显示「有 N 条会话本机读不了（v{newer} > v{target}）」+ 升级/重导出指引，用户必须先处理 |
| `skip` | 跳过这些**会话单元**（其余分区照常导入） | 计划里这些单元默认不勾选；报告写「跳过 N 条（格式 v{newer} > 本机 v{target}）」 |
| `guide` | 不改变导入行为，只把修复动作摆出来 | 沿用当前告警 + 一条可复制的升级/重导出指引（不阻塞） |

## 3. 非目标

- **不改写会话字节**（不做下行转换）——理由见 §1 引注。
- **不替用户升级 DSH**：升级换的是运行时，必须用户确认；本轮只给指引（可复制的命令 / 桌面端入口说明）。
- 不改 G-23 的「任一侧读不到版本就一律不提示」口径（不猜）。

## 4. 接线与落点

- **core（只消费数字，仍不碰存储格式）**
  - 探针产物从「纯计数」升级为**单元级**：`SessionFormatProbeResult` 增 `unreadableUnits?: { unitId: string; version: number }[]`
    （上限内才完整；超限仍用 `skipped` 如实说明）。宿主探针按会话单元（`projectKey/会话目录`）返回。
  - `Analyzer.sessionFormatWarnings` 保持现状；新增：命中的 sessions 计划项打 `severity: 'warning'` +
    `formatUnsupported?: { version: number; target: number }`（UI 不必自己解析文案）。
- **host（`src/index.ts` + `src/routes/import.ts` / `src/routes/sync.ts`）**
  - 新增决策参数 `sessionFormatDisposition: 'abort' | 'skip' | 'guide'`（`/plan`、`/analyze`、同步 `preview` 的 opts）；
    缺省 = 插件配置项 `sessionFormatDisposition`（见 §6 默认值）。
  - `abort`：`/plan` 阶段返回带 code 的拒绝（如 `sessionFormatUnsupported`），**不落任何写入**；
  - `skip`：优先走**既有机制**——计划期把这些单元放进「默认不勾选」，执行期靠已有的 includeItems 生效
    （不新增第二套过滤），但**必须显式回显**（绝不静默少带）。
- **ui（框架无关，`src/ui/`）**
  - 新增 `session-format-disposition.ts`：由探针结果 + 用户选择推导「阻断理由 / 待跳过单元 / 指引文案」的纯函数 + 单测。
- **client**
  - `ImportWizardView` / 同步确认页加三选一（radio），报告里回显选择与实际跳过数。
- **i18n**：zh/en 各约 4 条键（阻断标题/说明/跳过计数/指引）。

## 5. 风险与必须钉住的语义

- **跳过必须整单元**：会话单元 = `projectKey/会话目录`（半条会话没有意义），与父链连带、墓碑剔除共用同一套 unitId。
- **顺序**：处置是**最后一道过滤** —— 跳过的单元不得被「父链连带」「墓碑剔除」等规则重新加回。
- **同步的 `skip` 要更新基线**（`sync-state.sessionUnits`），否则下一轮又把它当作新变化，用户会看到「永远在拉同一批」。
- 超限场景（>200 条）：`skipped` 的会话**不能**被当作「可读」；处置只对这些已被体检的单元生效，
  报告必须写明「抽查 N 条，另有 M 条未检查」。

## 6. 默认值（需维护者拍板；本文档按 A 记录）

- **A（推荐，本文档采纳）**：默认 `abort` —— 把「你会丢一批对话」变成必须显式决定的动作。
- B：默认 `skip` —— 不阻塞，但用户可能在没看清的情况下少导一批对话。
- C：按数量自适应（≤5 条 abort、>5 条 skip）—— 规则复杂、可预期性差，不建议。

## 7. 验收

- 单测：core 的处置判定（三种选择 × 命中/未命中）、`src/ui/` 纯函数、wizard 的阻断/跳过分支。
- 集成：沿用 `src/core/import-sessions-visibility.test.ts` 的夹具各加一条 ——
  `abort` 后零写入且返回明确 code；`skip` 只写其余分区且报告计数一致；`guide` 写入行为不变但带指引。
- 真机（隔离 `DSH_HOME`）：导入 v4→v3 包三种选择各跑一次 —— `abort` 后 `sessions/` 无新增；
  `skip` 后新增数与报告逐条一致；`guide` 后新增=全部（用户已知情）。

## 8. 与 P1「会话体检入口」的关系

P1 是**本机存量**的诊断（不涉及任何包），共享同一套「读首帧版本 + 判定可读性」的探针；
本设计里的**单元级分类结果**正是 P1 表格要显示的数据。两者可同轮实现，但**独立交付**：
处置开关解决「导入时怎么办」，体检入口解决「我这台机器上现在哪些对话看不见、为什么、能不能修」。

## 9. 落地进度与生态调研（2026-09-30）

### 9.1 已落地（第一批，core 地基；测试与全量套件均绿）

- 探针产物升级为**单元级**：`SessionFormatProbeResult.units = [{ unitId, version }]`（`src/utils/session-format.ts`）。
- `Analyzer.resolveSessionFormats()` **每份归档只跑一次**，结果供三方共用：分析告警 / 计划项标记 / `ImportAnalysis.sessionFormats`；
  不可判定（无探针、无 sessions、本机版本解析不到、探针抛错）一律返回 null —— 不猜。
- `PlanItem.formatUnsupported = { version, target }`：读不了的会话**落到具体计划项**（unitId = `projectKey/会话目录`），
  为「中止 / 跳过 / 引导升级」提供落点；**纯附加字段**，不拦执行、不改 kind/conflict。
- 回归：`src/core/import-sessions-visibility.test.ts` 新增「读不了的会话必须落到具体计划项 + 结构化摘要」一条；
  `src/utils/session-format.test.ts` 覆盖探针计数与上限。

### 9.1b 第二批落地（2026-10，T1–T6 全量；测试全绿）

- **处置开关**（T1）：`src/ui/session-format-disposition.ts`（判定/跳过集/指引共用一份纯函数）+ `src/routes/session-format.ts`（宿主解析：请求体 > `ui-prefs.json` 的 `sessionFormatDisposition` > 缺省 `abort`；`abort` 返回 **409 + code=`sessionFormatUnsupported`**，零写入）接入 `/plan`、`/execute`、`/sync/sync`、`/sync/apply-items`；导入向导预览页/确认页的三选一（`SessionFormatDispositionField`）+ 阻断态 + 回显。**只读路径与市场复核页显式传 `guide`**（它们没有决策界面）。**修掉一个真机级缺陷**：探针单元键与计划项 `unitId` 的键空间失配（`projectKey/会话目录` vs `sessions:projectKey/会话目录`）→ `formatUnsupported` 一条都打不上，界面永不提示（已由 `sessionUnitVersion()` 修掉并钉住）。
- **导入后重启提示**（T2）：`SessionsAdapter.finalizeApply` 在**本次真的写入过会话**时回 `needsRestart` 收尾结果（计数挂 `WeakMap<ImportContext, number>` —— 适配器实例是进程级复用的，实例字段会跨导入累积），analyzer 收尾循环消费该字段，`ui/next-steps.ts` 的 `sessionsRestartOf()` 反推并在结果页单独分组。
- **会话体检数据层**（T3）：`src/core/session-health.ts`（纯分类器：严重级 `blocksStartup > unloadable > nextRequestFails > invisible > ok`）+ `src/utils/session-health-scan.ts`（宿主只读采集：结构档恒做，行档限额内做；**未验证一律记 `verified:false`**）。
- **只读路由**（T4）：`GET /recovery/sessions`（挂既有 recovery prefix，**不新增注册路由条目** → 71 条快照不变；已在 `PREFIX_ROUTED` 登记）。
- **体检面板**（T5）：`src/ui/session-inventory-view.ts` 纯展示模型 + 事故恢复子 tab 区块（严重级分组 / 未检查计数 / 截断 / 只读提示 / 可复制离线命令）。
- **离线安全修复**（T6）：`src/utils/session-log-repair.ts`（写前「连续性 + 引用完整性」校验 → 时间戳备份 → 临时文件 + rename 原子换入 → 写后复验；不过即拒绝）+ CLI `sessions list / doctor`（只读）与 `sessions repair [--apply]`（写前强制检测 DSH 心跳，在跑就拒绝）。
- **未做**（如实登记在 known-gaps G-24 的「后续」）：DSH codec 深度解码、header 重建、`sessions export` 转写、同步确认弹窗内的三选一控件。

### 9.2 生态同类插件的做法（已下载源码核对，源码在 `%TEMP%\dsheco\`，未进本仓库）

| 项目 | 会话相关的做法 | 对本项目的结论 |
|---|---|---|
| **dsh-backup**（having5548） | 「会话 doctor」只做**结构体检**：目录可读 / 文件非 0 字节 / zstd 魔数 / 明文首字节 `{`；明确**不修复**。导出/恢复对会话**全程不解包、不改写**；跨版本策略 = 「旧代际交给 harness 迁移链」+「未来新版的会话也能装进当前备份」——**没有降级转换** | 与我们的结论一致；**P1 的检查清单直接采用这条零依赖路线**（不请 DSH 内部 API） |
| **dsh-chatsync**（dpskk2） | 用**已安装 DSH 的 codec** 做深度校验：动态 import `<dsh-pkg>/node_modules/@deepseek-ai/dsh-session-format-catalog` → `createRestore(header, {recovery:'strict', validation:'current'})` 逐行 `decodeRow` + `finish()`；版本 ≠ 当前时改用 `historicalSessionFormatCatalog`。它自己注明「V3→V4 是否迁移完整不由这一步断言」。拉取会话后**必须重启 DSH 才刷新会话列表**（桌面端要求退出重开；可选自动重启走 `schtasks` 独立进程树） | **深度解码作为 P1 的可选增强**：能动态 import 到 catalog 才做，失败即回退「未验证」，绝不宣称已验证；**「导入会话后需要刷新/重启才可见」要写进 UI 文案**（我们目前只在插件安装项上提示重启） |
| **dshm**（dsh-profile-manager，maque2333） | 档案切换 = `startService/stopService` + 独立 state 记录 instances（profile → port）；另有 `/profile-manager` 面板、`profile_*` 工具与导入导出档案文件 | 与我们的「另起实例 + 台账」同路线；**生态里没有任何原地切换**，这条不再投入 |
| **Whale Isle**（ChisaAlter/Deepseek-Harness-Desktop） | 第三方桌面壳：**会话/设置存在桌面专用 `dsh-home`，与 CLI 的 `~/.dsh` 分开** | 这是「对话消失」的另一类成因（不同壳用不同 home）→ **P1 增加一条诊断**：列出本机发现的其它 DSH home（读不到就不列），只报告、不自动搬移 |

### 9.3 由调研确定的三条

1. **不做降级转换**（生态无人做；dsh-backup 明确「不解包不改写」）—— 与 G-23 的结论一致。
2. **P1 走「零依赖结构体检」为默认、DSH codec 深度解码为可选增强**（能力探测 + 失败即回退）。
3. **新增「多 home/异 home」诊断**（Whale Isle 类壳的成因），只报告不搬移。

## 10. 会话「修复」域调研（2026-09-30，源码核对）

> 本轮真正要找的是**会话修复插件**。生态里已经有三类成熟实现，且都带明确的失败分类与安全姿态；
> 源码已下载到 `%TEMP%\dsheco\`（`dsh-session-rescue` / `dsh-session-surgeon`），未进本仓库。

### 10.1 同类项目

| 项目 | 形态 | 一句话 |
|---|---|---|
| **po-et/dsh-session-rescue** | `npx` CLI（零依赖） | 列出坏会话（只读）→ `doctor` 深诊 → `repair`（先预览）→ `repair --apply`（**带时间戳备份 + 要求先关 DSH**）；修不了就 `export`（把对话导出成 Markdown，保内容）或 `quarantine`（移出 DSH 视野） |
| **xiaoshenming/dsh-session-surgeon** | DSH 插件（装进 profile） | 按**已安装 runtime** 的 catalog 巡检/修复 v0…v4；还提供「复制会话 ID」让新会话接着聊、`session_inspect` 工具 |
| **sandbaseai/deepseek-harness-handbook** | 排障 runbook | 按**签名**定位失败边界，先停写者、复制、哈希、只在副本上作业 |
| **chensl139-ok/dsh-archived-panel** | 插件（含 host 补丁） | 归档会话面板：搜索/打开/取消归档/彻底删除；删除必须等句柄释放 + 写入排空，故它要打 host 补丁 |
| **HanLoney/CodexShift** | CLI | 跨工具历史索引修复（Codex ↔ DSH 互导） |

### 10.2 失败分类（rescued 的实际实现，直接可用于我们的体检）

```text
重放族（主导，社区 #420/#1497/#2627/#2649）：崩溃/强杀/第二个写入者 → 已提交 seq 被重写
  ├─ 字节相同的重复行        → 丢弃重复（零损失）
  └─ 合成 closer 块撞上真实续写 → 丢 closer、保留真实内容（零损失）
    （closer 形状判据：≤8 个事件且全部落在 tool/result、step/end、turn/end、session/end-seed，且含 turn/end）
撕裂的末尾 zstd 帧        → DSH 自愈，报「无需修复」
header 不可读/乱码        → 重建 header（id 取自目录名，createdAt 取最早可解事件或 mtime）
真实 seq 空洞             → 只有在显式允许时才「从空洞起截断」；否则导出转写
不可解析的已提交事件       → 计划里丢弃并逐行说明
缺 message id（user/assistant/tool-result 必须非空）→ loader 拒整份日志（检测，不发明）
空/悬空 tool-call id（#5182/#4908；缺 tool/result）→ 能加载，但下一个模型请求 400（检测，不发明）
assistant/message|attempt 的 settlement 字段非法（#8084）→ 用日志里已打开的 turn/step 对 + 空 stream 修复
步进继续了已关闭的 turn（#7824）→ 告警
孤立代理字符（lone surrogates）/ 手工编辑 → 编码修复
```

### 10.3 必须照抄的安全姿态

1. **任何修复前先重跑一遍「连续性 + 引用完整性」校验；校验不过就拒绝，绝不「修得更狠」**
   （社区 postmortem #2257：一次朴素的修复造出悬空 `sourceEventSeqs`，把 50 万事件的会话**永久**毁掉）。
2. **永远先备份、原子换入**（写临时文件 + rename），原件留在旁边。
3. **检测 ≠ 发明**：悬空 tool-call、缺 message id 这类只报不造（与我们的「绝不猜」同一条原则）。
4. **修复必须在 DSH 停止时进行**（两个工具都明确要求先关 DSH）；我们的插件**运行在 DSH 内部**，
   所以应用内只能做**只读体检**，写操作只能走**离线 CLI**。
   > **2026-10 更新（T8）**：这条界线被**收窄但未取消** —— 应用内新增了一条只修「重放重复行」
   > （字节相同 + seq 相同的重复事件，零损失类）的通道，前置是三道可证明的写入门（路径必须在
   > 会话根内 / 无 `session.lock` / 文件不在 30s 静止期内）+ 预览-应用指纹一致 + SAFE MODE 与
   > mutation lock，写入照抄本条的安全序列，回滚只认台账 `repairId`（见 known-gaps G-24）。
   > 其余类别（seq 空洞 / 不可解析行 / 容器非法 / header 不可读）仍然只报告、只给离线命令。
5. **一个坏会话能让 DSH 起不来**（handbook #4855：workspace 插件启动期枚举到一份坏 zstd → Web 永远到不了工作区选择）
   → 体检里「会让 DSH 起不来」必须是最高严重级。

### 10.4 对 P1 / 处置开关的落地含义

- **P1（应用内）**：只读。检查项 = 10.2 的分类 + 我们已有的（格式版本可读性 / 工作区归属 / 父对话 / 位置一致性 / 多 home），
  按严重级排序：**阻断启动 > 会话不可加载 > 下次请求 400 > 不可见（未登记/缺父/格式超前）**。
  深度解码校验按 dsh-chatsync 的路线做成**可选**（能力探测 → 失败即「未验证」）。
- **修复（离线 CLI）**：扩展现有 `dsh-config-manager sessions repair`（它已做「位置归位 + 只报告/--fix」），
  加上 10.2 的**重放族**与**header 重建**两类零/低损失修复，并强制：先校验计划 → 备份 → 原子换入 → 事后复验。
  修不了的走 `export`（转写成 Markdown 保内容）+ `quarantine`（移出 DSH 视野，不删除）。
- **应用内的「引导」**：向导/体检给出的动作只能是「关掉 DSH 后运行 `dsh-config-manager sessions repair …`」这种
  可复制命令。**2026-10 更新（T8）**：唯一例外是「重放重复行」——它可由体检卡直接修（dry-run → 确认 →
  自动备份 → 可回滚），其余类别沿用 G-23 的界限，绝不扩张。
