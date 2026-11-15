# dsh-config-manager 竞品交互与信息架构评审报告

> **评审日期**：2026-11-15
> **评审对象**：`dsh-config-manager`（DSH 双面插件：宿主 `src/index.ts` + 浏览器 `src/client/`，挂载于 DSH 设置弹窗 `564×720` 画布，辅以会话节点槽位与 `dcm web` 离线救急台）
> **方法论**：先基于 `DESIGN.md` 与 `src/client/`、`src/ui/`、`src/cli/web/` 真实代码建立本仓快照（第 0 步），再界定 L1/L2/L3 三层同赛道候选并自证搜索覆盖（第 1–2 步），按 A/B/C 三级证据建立 6 个深读对手的八维对比矩阵（第 3–4 步），最后进行强制反向论证与按性价比排序的「保留 / 该改 / 存疑」裁定（第 5–6 步）。

---

## ① 我的实现快照（Step 0）

以下结论全部取自本仓 `DESIGN.md` 与 `src/client/`、`src/ui/`、`src/cli/web/` 源码，无代码依据的判断一律不列：

| 页面 / 关键流程 | 信息架构（区块与主操作） | 导航模型 | 状态归属（`run-store` / 切片 / 内存） | 危险操作确认方式 | 错误呈现路径 | 证据（`文件路径:行号`） |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **顶层壳与状态栏**<br>(`ConfigManagerSection` / `CommandPalette` / `TaskShell`) | 1. 顶栏 `.topBar`（4 个一级页 Tab + 溢出 `MoreMenu` + 右侧 4 个紧凑图标按钮 `⌘K`/`runs`/`history`/`about`）<br>2. 全局 SAFE MODE 红色横幅（一键直跳 `maintenance`）<br>3. `.main` 主工作区 + `.taskShell` 全屏任务遮罩层（`z-index: 90`）<br>4. 28px 底栏 `.statusBar`（左侧状态点/文案，右侧进行中任务徽标） | 4 个一级页 Tab（`ResizeObserver` + `navLayout` 动态测宽溢出收进 `MoreMenu`）；`⌘K`/`Ctrl+K` 调起 `CommandPalette`（支持中英双语 `aliases` 与模糊匹配）；点顶栏当前激活 Tab 自动关闭 `TaskShell` | 持久化：`activeTab`、`envSubView`、`library`、`sync`（脱敏）经 `toPersistedState()` 白名单写 `sessionStorage['dsh-cm-ui-v2']`<br>仅内存：`task`（打开的任务流刷新即回一级页）、凭据/密码、定时器 | 顶层壳本身无写操作；SAFE MODE 横幅提供「前往恢复中心」跳转出口 | 各面板局部 `ErrorBanner`（统一经 `toActionableError()` + `redact()` 脱敏）+ 底栏状态文本 | `src/client/ConfigManagerSection.tsx:77-82,106-146,288-300,336-338,500-758`<br>`src/ui/nav-model.ts:47-82`<br>`src/ui/commands.ts:18-195`<br>`src/client/common/CommandPalette.tsx:37-175`<br>`src/client/run-store.ts:36-41,389-424` |
| **一级页 1：`home`**<br>(`HomePanel`) | 1. 顶部健康行 + 4 段式指标卡（备份文件数、快照数、定时备份开关、同步状态）<br>2. `.toolRow` 快捷动作条：**主操作 `[立即备份]`**（primary），次操作 `[导出 ZIP]`、`[导入]`、`[从其它 agent 导入]`<br>3. 首次使用 3 步引导 `Stepper`（当 `snapshots===0 && backups===0 && !syncConfigured` 时显示）<br>4. 最近动态表（最多 30 条，失败行带内联重试/跳转；`jumpTo === 'sync'` 时直接拉起 `requestMergeDecision`）<br>5. 定时备份配置 `Modal` | 一级页默认首屏；快捷按钮分别拉起 `TaskShell`（`export`/`import`/`foreign`）或切换至 `library`/`sync`/`environment` | 组件局部 `useState`（`snapshots`、`backups`、`schedule`、`syncStatus`、`history`）+ `runStore.recovery.status` + `runStore.snapshots.backupDraft` | 首页仅触发创建快照或打开任务流，不直接执行破坏性删除/覆盖 | `toActionableError()` → 顶部 `ErrorBanner`（带 `[重试]`）+ 最近动态表内联失败徽标与一键修复入口 | `src/client/home/HomePanel.tsx:123-129,155-671`<br>`DESIGN.md:1079-1114` |
| **一级页 2：`library`**<br>(`LibraryPanel` + `LibraryActions`) | 1. 4 来源合一扁平列表（本地 `snapshot`、导出 `backup-file`、云端 `remote-snapshot`、市场 `market`）<br>2. 顶部来源筛选胶囊（Pills）+ 搜索框 + 排序下拉 + 刷新按钮<br>3. 行内单行展开详情（`expandedKey`）+ 行级操作（还原、导出、删除、校验）<br>4. Sticky 底栏：**主操作 `[导出]`**（primary），次操作 `[导入]`、`[逛市场]`、`[发布到市场]` | 一级页 Tab；底栏按钮拉起 `export` / `import` / `market` 任务流；发布到市场在页内弹出 `PublishModal` | `runStore.library` 切片（`sourceFilter`、`query`、`sortBy`、`expandedKey` 持久化进 `sessionStorage`；`pendingZip` 仅内存）+ 组件局部 `useState`（实现 `stale-while-revalidate` 静默刷新不闪骨架） | 1. **快照还原**：先走 Dry-Run `RestorePlanView` 弹窗（支持按需懒加载 `/snapshots/file-diff`，校验 `planFingerprint`）→ 再弹 `ConfirmDialog`（`danger`）<br>2. **删除快照/备份**：`ConfirmDialog`（`danger`，若为 `current` 基线快照则追加断链警告） | 页内顶部 `ErrorBanner`（`redact()` 脱敏）+ 弹窗内局部错误横幅 | `src/client/library/LibraryPanel.tsx:75-354`<br>`src/client/library/LibraryActions.tsx:118-610`<br>`src/client/run-store.ts:399-412` |
| **一级页 3：`sync`**<br>(`SyncPanel` + `MergeModal` + `SyncConfirmView`) | 1. 已配置通道折叠卡片 `SyncChannelEntryCard`（`git`/`webdav`/`s3`/`gist`，主操作为一键同步/推送/拉取）<br>2. 未配置通道添加区 `AddChannelCard`<br>3. Git 工作副本状态卡 `WorkDirCard`（自检、修复、重置）<br>4. 同步历史日志 `SyncLogList`<br>5. 弹窗群：`ChannelConfigDialog`（失焦/防抖自动保存 + GitHub OAuth 设备流）、Push 预览、`MergeModal`、`SyncConfirmView` | 一级页 Tab；冲突或远端差异通过两级 Modal 承载（`MergeModal` 三路合并、`SyncConfirmView` 逐项确认与采纳） | `runStore.sync` 切片持久化非敏感状态（通道列表、选中通道、状态摘要）；同步密码/Token 走 `patchSyncPasswords()` 仅存内存，宿主侧走 DSH `credentials` 槽位 | 1. **远端索引冲突 / 强制推送**：Push 预览弹窗须显式勾选 `forcePush` 复选框<br>2. **三路合并 (`MergeModal`)**：按分区选 `useLocal`/`useRemote`/`useMerged`，叶级 `Conflict` 逐项单选，禁止全局 `replace` 静默吞冲突<br>3. **拉取确认 (`SyncConfirmView`)**：逐项勾选采纳 + `keepLocal`/`useRemote` 单选（批量按钮 `isBulkDecidable` 排除 `Error`）+ 脱敏空值保护 + 回滚入口<br>4. **清除通道**：`ChannelClearConfirmDialog`（`danger`） | 面板顶部 `ErrorBanner` + 通道卡片内联状态徽标 + `SyncConfirmView` 顶部 `ConsultCard` 风险摘要与逐行 `redactedPaths` 告警 | `src/client/sync/SyncPanel.tsx:323-1579`<br>`src/client/sync/MergeModal.tsx:73-222`<br>`src/client/sync/SyncConfirmView.tsx:80-505`<br>`src/ui/sync-view.ts:45-190` |
| **一级页 4：`environment`（`list` 实例列表）**<br>(`EnvironmentPanel`) | 1. 顶部子视图切换 `Segmented`（`实例列表` vs `恢复与维护`）<br>2. 运行中实例状态卡 + 启动/复制结果反馈横幅（含一次性访问 Token URL 展示与复制）<br>3. 新建 Profile 卡片（名称输入 + 创建按钮）<br>4. Profile 列表行：**主操作 `[启动]` / `[停止]`**，次操作 `[详情]`（只读 `Modal` 展示脱敏 `package.json` 与 `cordis.patch.yml`）、`[复制]`（可选跳过 `node_modules`）、改名、删除 | 一级页 Tab 下的默认子视图（`envSubView === 'list'`） | `runStore.profiles` 切片 + 组件局部 `useState`（注：复制档案 `copying` 等状态在组件局部 state，切页丢失进度提示） | 1. **停止运行中实例**：`ConfirmDialog`（`danger`）<br>2. **删除 Profile**：`ConfirmDialog`（`danger`；若 `isCurrent` 则强制要求额外勾选确认 `Checkbox`；`desktop` 保留档案硬拒绝；注：删前未自动拍快照 `PW-01`） | 页内顶部 `ErrorBanner` + 启动子进程失败时展示退出码与尾部日志诊断 | `src/client/environment/EnvironmentPanel.tsx:112-924` |
| **一级页 4：`environment`（`maintenance` 恢复与维护）**<br>(`RecoveryPanel` + `DiskUsageCard` + `SessionHealthCard` + `RollbackCard`) | 1. 崩溃归因横幅 + SAFE MODE 解除卡（含未解决 incident 硬拦截）<br>2. 残留环境锁回收卡（区分可证自动回收与显式人工回收）+ 活跃操作列表 + 未解决故障卡（`[查看详情]` → `[执行恢复]`/`[重试]`/`[放弃]`）<br>3. 救援模式（`FoldToggle` 折叠，进入时剥离依赖、退出逐字节还原）+ 未完成档案复制清理<br>4. `DiskUsageCard`（13 个区域单行紧凑列表 + `includeExpired` 勾选 + 一键清理）<br>5. `SessionHealthCard`（点击打开 `SessionHealthDialog`：体检、布局归位、重复 ID 隔离）<br>6. `RollbackCard`（自动留点开关 + 按会话分组的回滚点台账 `Modal` + 路径级选择性恢复预览） | 一级页 Tab 下的维护子视图（`envSubView === 'maintenance'`），亦是顶栏 SAFE MODE 横幅的直跳落点 | `runStore.recovery` 切片存基础状态，但恢复、会话修复、磁盘清理、回滚点捕获开关等操作 busy 态在组件局部 `useState`（切页再回无法感知后台仍在进行） | 1. **故障恢复 / 放弃**：详情弹窗内二次确认<br>2. **进入救援模式**：折叠区展开 + `ConfirmDialog`（`danger`）<br>3. **磁盘清理**：仅限可重建缓存区 + 显式勾选的过期导出（`snapshots`/`sync` 永不进候选）+ `ConfirmDialog`<br>4. **会话布局归位 / 隔离**：先只读预览（`apply !== true` 零写入），确认后执行且失败自动 `rolledBack`<br>5. **回滚点恢复 / 删除**：路径级勾选预览 + `ConfirmDialog`（`danger`；`guard` 救援点用户不可删） | 各卡片独立 `ErrorBanner` + `SessionHealthDialog` 三态复核输出（`verified`/`unavailable`/`failed` 明确区分） | `src/client/recovery/RecoveryPanel.tsx:213-942`<br>`src/client/environment/maintenance/DiskUsageCard.tsx:39-266`<br>`src/client/recovery/SessionHealthCard.tsx:41-134`<br>`src/client/recovery/RollbackCard.tsx:104-987` |
| **任务流 1：`export`**<br>(`ExportView`) | 1. 顶部工具栏（返回按钮 + 标题）<br>2. 加密与脱敏选项区（`encrypt` 密码输入、`includeSecrets` 显式警告；密码仅内存）<br>3. `SectionComposition` 分区概览与体积统计<br>4. 双栏级联 `ContentPicker` 弹窗（左栏分区、右栏具体会话/插件勾选，带 1000 项渲染上限提示）<br>5. 底栏**主操作 `[生成导出包]`** → 完成后展示下载与校验信息 | `TaskShell` 全屏覆盖主区（`task.kind === 'export'`） | `runStore.export` 切片（运行状态走 `runStore.watchRunning('export', 500)`；加密密码仅存内存，绝不进 `sessionStorage`） | 勾选 `includeSecrets`（导出明文凭据）时展示显式高危警告横幅；加密导出强制校验密码非空 | 任务流内 `ErrorBanner` + `ReportView`（渲染前经 `redact()` 二次脱敏） | `src/client/export/ExportView.tsx:45-500`<br>`src/client/run-store.ts:390-415` |
| **任务流 2：`import` 与 `foreign`**<br>(`ImportWizardView` + `ConflictList` + `ForeignImportView`) | 1. `ForeignImportView`（外部来源预选页）：扫描 30 个外部 Agent 来源（未检出来源置灰展示，顶部前置列出 3 条有损转换提示），选中后转入导入向导<br>2. `ImportWizardView`：6 阶段 `Stepper`（映射底层 9 个 step：选择文件/来源 → 解密解锁 → 兼容性评分与 `compatibilityReasons` 字典解释 → 分区与冲突裁决 `ConflictList` → Dry-Run 演练 / 快照确认 → 执行与报告 `ReportView`） | `TaskShell` 全屏覆盖主区（`task.kind === 'import'` 或 `'foreign'`） | `runStore.import` 切片（`step`、预览摘要持久化；解密密码与上传 `File` 引用仅存内存；切换外部来源自动清空旧 preview 防串味） | 1. 导入前强制自动创建本机快照<br>2. `ConflictList` 冲突项默认不覆盖（须逐项或批量选择策略）<br>3. 携带 `planId` 与锁内重比指纹（防预览与执行之间盘面漂移）<br>4. 支持纯 Dry-Run 零写入演练 | 向导内 `ErrorBanner` + 外部来源跳过原因码经 `foreignSkipReasonLabel` 翻译为人类可读中文 + `ReportView` | `src/client/import/ImportWizardView.tsx:65-788`<br>`src/client/import/ConflictList.tsx:28-185`<br>`src/client/import/ForeignImportView.tsx:42-337`<br>`src/ui/foreign-view.ts:30-195` |
| **任务流 3：`market`**<br>(`MarketPanel`) | 1. 顶部 `browse`（浏览市场）与 `myconfigs`（我的发布）`Segmented` 切换<br>2. 2×2 筛选网格（关键词、分类、排序、兼容度）<br>3. 配置包卡片列表（含兼容度徽标与内容摘要）<br>4. 页内 5 步 `MarketImportReview` 审阅流 | 从 `library` 底栏或 `⌘K` 调起，运行于 `TaskShell`（`task.kind === 'market'`），**市场不是一级页** | 组件局部 `useState` + 导入阶段复用 `MarketImportReview` 局部状态 | 含插件/MCP/脚本的配置包触发供应链风险 `ConfirmDialog`；导入前先过只读预览与冲突确认 | 页内 `ErrorBanner` + 索引拉取失败重试按钮 | `src/client/market/MarketPanel.tsx:55-700`<br>`DESIGN.md:99-112` |
| **任务流 4–6：`runs` / `history` / `about`**<br>(`RunsCenter` / `HistoryPanel` / `AboutPanel`) | 1. `RunsCenter`：1.5s 轮询运行中任务 + 环境锁状态卡 + 超过 2 分钟卡住告警 + 取消任务弹窗 `RunCancelDialog`<br>2. `HistoryPanel`：统计徽标 + 损坏记录告警 + 保留策略设置 + 3 维筛选/搜索 + JSON/MD 导出 + 按日分组列表<br>3. `AboutPanel`：运行时徽标 + 诊断信息一键复制 Markdown + npm 更新检查与 `PluginUpdateDialog`（钉精确版本、成功后提示手动重启）+ CLI 救急台说明 + 权限范围说明 | 顶栏右侧紧凑图标按钮或 `⌘K` 调起，运行于 `TaskShell` | 各面板局部 `useState` + `runStore` 任务计数联动 | 1. **取消运行中任务 (`RunCancelDialog`)**：单选卡片明确区分 `rollback`（回滚已写改动）与 `keep`（保留半途状态）<br>2. **插件自更新 (`PluginUpdateDialog`)**：展示精确目标版本与 Release Notes，确认后过 mutation gate，绝不自动重启宿主 | 各面板独立 `ErrorBanner` + 历史日志损坏条数显式黄条提示 | `src/client/common/RunsCenter.tsx:45-458`<br>`src/client/history/HistoryPanel.tsx:48-400`<br>`src/client/about/AboutPanel.tsx:40-296` |
| **会话槽位接管**<br>(`ChatEntryView` + `RollbackReviewDialog`) | 1. 以 `priority: -1` 接管 `conversation.chat.node`（仅限 `user` 节点且自动留点开启时），正文委托宿主 `renderFactorySlot('conversation.chat.user.content', ...)` 渲染，自绘气泡仅作 `fallback`<br>2. 消息旁挂载回滚点胶囊按钮（收尾后按 `0.5/1.5/3/6/12s` 有界重试 30s 应对落盘延迟）<br>3. 点击弹出单步 `RollbackReviewDialog`：展示变更文件列表、`[连文件一起退]` 勾选框，点击文件联动宿主右侧栏 `sidebarRight` 展示 Diff（失败回落内联 Diff） | 嵌入 DSH 聊天流每条用户消息气泡旁 + 宿主右侧栏 Diff 标签页 | 组件局部 `useState`（每次挂载只跑一轮有界重试；窗口关闭且仍为空才显示「无回滚点」） | 单步弹窗确认：在 `RollbackReviewDialog` 内勾选是否连带还原工作区文件，点击 `[回退]` 即携带 `userConfirmed: true` 执行 `sessionController.fork` + 归档原会话（先拍 `guard` 保护点） | 弹窗内 `ErrorBanner` + 归位 `cwd` 失败时写诊断并提示用户 | `src/client/chat/ChatEntryView.tsx:52-541`<br>`src/client/chat/RollbackReviewDialog.tsx:60-608`<br>`docs/adr/0004-rollback-point-fork-archive.md:1-120` |
| **离线救急台 (`dcm web`)**<br>(`src/cli/web/page.ts`) | 1. 宿主无法启动时的独立进程外单页（零前端框架依赖，服务端直出 HTML + CSS）<br>2. 复用 IBM Carbon 亮色 / Raycast 暗色语义 Token，2.4s 纯 CSS 骨架屏兜底<br>3. 区块：SAFE MODE 解除、残留锁回收、本机快照恢复、会话体检与修复 | 独立回环 Web 服务（命令行打印一次性 Token URL → 浏览器访问兑换 `HttpOnly` Cookie） | 服务端无状态直出 + `HttpOnly` 会话 Cookie（非兑换请求一律 `403`） | 与 CLI 共用同一道写入门（SAFE MODE → 环境锁 → DSH 未运行检测）；恢复前强制校验快照完整性 | 页面顶部服务端渲染错误横幅与结构化退出码说明 | `src/cli/web/page.ts:1-250`<br>`docs/evidence/recovery-console.md:1-180` |

---

## ② 候选清单表与搜索覆盖自证（Step 1 & Step 2）

### 2.1 搜索覆盖自证（实际执行的查询串与渠道）

1. **GitHub 关键词 × Topic 检索**（访问日期：2026-11-15）：
   - `site:github.com "dsh" plugin backup OR sync OR profile OR checkpoint OR mcp`
   - `site:github.com "remotely-save" OR "obsidian-git" OR "obsidian-livesync" stars commit sync conflict UI`
   - `site:github.com "twpayne/chezmoi" OR "lra/mackup" OR "kopia/kopia" stars latest commit`
   - `site:github.com "syncthing/syncthing" OR "LazyVim/LazyVim" OR "folke/lazy.nvim" stars latest commit UI`
2. **npm Registry 检索**（访问日期：2026-11-15）：
   - `site:npmjs.com "dsh-" backup OR sync OR mcp OR config OR plugin-console`
3. **DSH 插件市场 / 官方与社区列表排查**（访问日期：2026-11-15）：
   - 遍历 `awesome-dsh-plugin` / `dsh-market` 归档清单及本仓前期拉取的完整社区插件源码镜像（`.tmp/research/meta.json` 55 个 DSH 插件仓、`.tmp/research/reports/groupC-backup-migration.md` 12 个备份/迁移仓、`.tmp/audit/raw/` 5 个直接竞品源码、`.tmp/ref-plugins/` 与 `.tmp/refs/` 外部会话导入与检查点源码）。
4. **`awesome-*` 清单与宿主文档检索**（访问日期：2026-11-15）：
   - `site:github.com "awesome-dotfiles" OR "awesome-mcp-servers" GUI OR manager OR sync OR panel`
   - `"VS Code" "Settings Sync" conflict resolution UI merge preview activity views`
5. **未覆盖方向与原因说明**：
   - **闭源商业客户端的私有云同步后台**（如 Raycast Cloud Sync 内部实现、JetBrains Settings Sync 专有服务端、Cursor 闭源 Composer Checkpoint 内部存储层）：仅能通过公开文档或界面行为观察（C 级证据），无法获取前端状态机与冲突合并源码，故不作为源码级（A 级）对比对象。
   - **纯 TUI / 纯 CLI 且无任何 Web/GUI 交互层的 dotfiles 工具**（如 `yadm`、`stow`、`dotbot`）：因缺乏可视化页面、弹窗与冲突裁决交互，仅在候选表中说明排除理由，不纳入八维 UI 矩阵深读。

### 2.2 三层同赛道候选清单表（共 20 个候选，纳入深读 6 个）

> **层定义**：
> - **L1 功能重叠**：DSH 生态内做配置 / Profiles / 插件 / MCP / 会话的查看、备份、恢复、同步、迁移、回滚的插件。
> - **L2 相邻生态参照**：其他宿主的同类工具（VS Code Settings Sync、chezmoi、mackup、lazy.nvim、跨端 MCP 管理面板）。
> - **L3 形态参照**：任何把「备份 / 恢复 / 多端同步 / 冲突解决」做成完整带 UI 流程的工具或插件（Obsidian 同步插件群、Kopia UI、Syncthing GUI）。

| # | 名称 | 链接（访问日期均为 2026-11-15） | 最近提交 / 活动时间 | 体量（Star / 下载） | 归属层 | 决策 | 纳入或排除的一行理由 |
| :-: | :--- | :--- | :--- | :--- | :-: | :-: | :--- |
| 1 | **`xiaoyuyu6420/dsh-backup`** | https://github.com/xiaoyuyu6420/dsh-backup | 2026-10-03（v0.13.3） | Star 未验证（本地源码镜像无 `.git` 元数据） | **L1** | **纳入深读 (A 级)** | DSH 生态内功能重叠度最高的全栈对手（覆盖备份/恢复/GitHub 同步/Profiles/市场/外部导入/Rewind/离线 `rescue.mjs`），且有完整 `src/tab.jsx` 源码。 |
| 2 | **`minghuo/dsh-github-sync`** | https://github.com/minghuo/dsh-github-sync | 2026-10（v0.4.3） | Star 未验证 | **L1** | **纳入深读 (A 级)** | DSH 生态内把「多机 GitHub 同步 + 远端工作区自动重映射 + 插件清单差异一键补装 + 本机快照」做成 5-Tab 完整 Web 面板的代表作。 |
| 3 | **`Nwflower/dsh-chat-import`** | https://github.com/Nwflower/dsh-chat-import | 2026-10（v0.26.1） | Star 未验证（已上架 npm 与 `dsh.so`） | **L1** | **纳入深读 (A 级)** | DSH 生态内外部 Agent 导入标杆（支持 25+ 来源、流式游标扫描、固定行高虚拟滚动窗口、整行勾选、解析失败一键生成 Agent 转换任务模板）。 |
| 4 | **`PerryLink/dsh-checkpoint-rewind`** | https://github.com/PerryLink/dsh-checkpoint-rewind | 2026-10（v0.6.24） | Star 未验证 | **L1** | **纳入深读 (A 级)** | DSH 生态内把「会话 + 工作区 + 配置」三态统一检查点做成时间线面板 + 任意两点（A/B）逐行/并排 Diff + 选择性文件恢复的代表作。 |
| 5 | **`mienfong/dsh-session-mgr`** | https://github.com/mienfong/dsh-session-mgr | 2026-10-04（v0.6.8） | Star 未验证 | **L1** | 排除（局部引用） | 会话单域管理插件（移动/归档/可携式导出/跨机重设 `cwd` 导入），无配置/插件/云同步，其会话导入交互已由 #2/#3 覆盖，故仅在反向论证中引用其帧级最小重压与三语切换细节。 |
| 6 | **`kinyokun/dsh-session-import`** | https://github.com/kinyokun/dsh-session-import | 2026-09-11（v2.0.0） | Star 未验证 | **L1** | 排除（局部引用） | 专注单对话框导入 DSH `/export` 包（含 `expectedHash` 校验、`restamp` 时间平移与导入后自动打开会话），功能面较窄，作为单点交互参照融入反向论证。 |
| 7 | **`Arlenman/dsh-backup-sync`** | https://github.com/Arlenman/dsh-backup-sync | 2026-09/10（社区早期版） | Star 未验证 | **L1** | 排除 | 早期备份与 Git 同步实现，存在命令拼接与路径校验缺陷（见 `.tmp/audit/competitors.md`），UI 形态已被 `xiaoyuyu6420/dsh-backup` 完全超集覆盖。 |
| 8 | **`dickpy/dsh-cloud-sync`** | https://github.com/dickpy/dsh-cloud-sync | 2026-09/10 | Star 未验证 | **L1** | 排除 | 仅聚焦云端同步且恢复链路缺乏恢复前自动快照与回滚保护（见 `.tmp/audit/competitors.md`），交互深度弱于 `minghuo/dsh-github-sync`。 |
| 9 | **`PerryLink/dsh-session-sync`** | https://github.com/PerryLink/dsh-session-sync | 2026-10 | Star 未验证 | **L1** | 排除 | 仅做会话目录的 Git 镜像与 append-only keep-both 合并，几乎无复杂前端界面，其「消除冲突」思路与 #2 同源。 |
| 10 | **`luoxin10086/dsh-session-backup`** | https://github.com/luoxin10086/dsh-session-backup | 2026-09-06（v0.1.0） | Star 未验证 | **L1** | 排除 | 纯 CLI 冷备份工具（`dsh-session-backup backup\|restore\|list`），无 Web GUI 界面。 |
| 11 | **`PolitaryMonicy/dsh-subagent-clean`** | https://github.com/PolitaryMonicy/dsh-subagent-clean | 2026-10-06（v1.0.0） | Star 未验证 | **L1** | 排除 | 纯 CLI 子代理日志清理与孤儿缓存回收脚本（`clean.mjs`），无 Web GUI 界面。 |
| 12 | **`dsh-mcp-panel` / `hxlog/dsh-mcp-tools`** | https://www.npmjs.com/package/dsh-mcp-panel | 2026-10 | 下载量未验证 | **L1** | 排除 | 专注运行时 MCP Server 启停、Header 配置与 Pipeline 试调；本仓受限于「DSH 无 MCP 管理 API，仅做配置行导入导出」的技术边界，赛道目标不同。 |
| 13 | **`@noob-stupid/dsh-plugin-console`** | https://www.npmjs.com/package/@noob-stupid/dsh-plugin-console | 2026-10 | 下载量未验证 | **L1** | 排除 | 专注已安装插件的启停、热重载与日志查看（插件管理器形态），不做跨机备份、加密导出与多通道云同步。 |
| 14 | **`VS Code Settings Sync`** | https://code.visualstudio.com/docs/editor/settings-sync | 持续活跃（VS Code 主仓日常提交） | 主仓 >160k Stars | **L2** | **纳入深读 (B 级)** | 桌面 IDE/Agent 宿主内置配置同步的行业黄金标杆，其「Activity Views + 3 选 1 冲突横幅（Accept Local / Accept Remote / Show Conflicts 并排 Diff 编辑器）」极具参照价值。 |
| 15 | **`twpayne/chezmoi`** | https://github.com/twpayne/chezmoi | 2026-11（日常活跃提交） | ~22.3k Stars | **L2** | 排除 | Dotfiles 管理领域体量最大的标杆，但以 CLI（`chezmoi diff`/`apply`/`doctor`）为核心，无内置图形化设置面板。 |
| 16 | **`lra/mackup`** | https://github.com/lra/mackup | 2026-10/11（v0.11.3） | ~15.4k Stars | **L2** | 排除 | 纯 CLI 应用配置同步工具（基于符号链接/拷贝到云盘），无 GUI 冲突裁决与状态面板。 |
| 17 | **`vlazic/mcp-server-manager`** | https://github.com/vlazic/mcp-server-manager | 2026-10/11 | Star 未验证 | **L2** | 排除 | 独立 Go + HTMX 本地 Web 面板，聚焦单 YAML 分发到 Claude Code / Gemini CLI，不含快照恢复与会话级数据管理。 |
| 18 | **`remotely-save` / `obsidian-livesync`** | https://github.com/remotely-save/remotely-save<br>https://github.com/vrtmrz/obsidian-livesync | 2026-10/11（持续活跃） | ~7.9k Stars (`remotely-save`)<br>~12.6k Stars (`obsidian-livesync`) | **L3** | **纳入深读 (B/C 级)** | 插件宿主内做「多云存储通道（S3/WebDAV）+ 端到端加密 + 嵌入式可视冲突解决器」最成熟的宿主插件双标杆，与本仓 `sync` 页场景高度同构。 |
| 19 | **`kopia/kopia` (Kopia UI)** | https://github.com/kopia/kopia | 2026-11（日常活跃提交） | ~14.6k–15k Stars | **L3** | 排除 | 专业跨平台加密快照备份工具（含 Electron/Web GUI），但其核心是通用文件系统 Repository 挂载与策略继承，重于宿主插件级配置管理。 |
| 20 | **`syncthing/syncthing`** | https://github.com/syncthing/syncthing | 2026-11（日常活跃提交） | >65k Stars | **L3** | 排除 | P2P 连续文件同步守护进程，冲突处理依赖生成 `.sync-conflict-*` 副本文件，与配置/会话的语义级合并交互差异较大。 |

---

## ③ 八维对比矩阵（Step 3 & Step 4）

> **证据分级定义**：
> - **A 级**：直接精读本地克隆的真实源码（附文件路径与行号）。
> - **B 级**：官方文档、仓库 `README.md`、`CHANGELOG.md`、架构说明文档。
> - **C 级**：社区评测、对比文章、Issue 讨论或截图（**严格遵守表述约束：只写「从 X 看疑似如此」，绝不写「他们是这样实现的」**）。

### 维度 1：信息架构与页数取舍

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | 顶部 3 个一级 Tab（`备份` / `恢复` / `设置`），但把 GitHub 同步、分类型备份、导出/导入、外部 Agent 导入、会话 Rewind、市场、磁盘清理、更新、Profiles、关于 **共 11 张卡片全部纵向堆叠在 `设置` Tab 内**（`src/tab.jsx:748-752, 885-1402`）。 | **A** | 4 个一级页（`home` / `library` / `sync` / `environment`）+ 6 个按需覆盖的 `TaskShell` 任务流，市场作为 `library` 的子任务流而非一级页（`ConfigManagerSection.tsx:77-82, 500-758`）。 | **我优** | 对手的 `设置` Tab 沦为 11 个异构功能的超长滚动垃圾桶，心智负担极重；我方按「概览 / 静态归档库 / 动态多端同步 / 运行时环境与恢复」四域切分，高频浏览与低频向导解耦清晰。 |
| **`minghuo/dsh-github-sync`** | 单一 `settings.section` 页面下设 5 个平铺子 Tab：`概览`（仓库配置+开关+状态）、`会话备份`（本机与云端会话浏览/恢复/重映射）、`插件`（清单对比与一键补装）、`本地快照`、`高级`（`client/index.js:73-76, 176, 1000-1298`）。 | **A** | `sync` 页负责 4 种云通道配置与推送/拉取，远端快照浏览与本地快照放在 `library` 页，插件清单查看放在 `environment` 页详情弹窗（`SyncPanel.tsx:323-1579`）。 | **平** | 对手仅聚焦 GitHub 单一链路，5 个 Tab 围绕「本机 vs 云端实例」展开非常紧凑；我方需同时承载 4 种同步协议、外部导入与 Profile 进程启停，分拆到多页合理，但跨机「只对比/补装缺失插件」的路径不如对手单 Tab 直观。 |
| **`Nwflower/dsh-chat-import`** | 主界面不在设置弹窗，而是挂载在**宿主右侧栏 `sidebar.right.pane.tab`**（内设 `导入` / `历史` 两个子视图，`导入` 顶部含可折叠的 `从文件导入` 区），设置弹窗内仅放 3 个低频偏好开关（`lib/client.js:222-235, 4180-4252`）。 | **A** | 外部 Agent 导入作为 `home` 工具栏或 `library` 触发的全屏 `TaskShell` 子页面（`ForeignImportView.tsx` → `ImportWizardView.tsx`），全在 `564×720` 设置弹窗内完成。 | **对手优** | 导入外部会话的最终目的是「在聊天主界面继续对话」，对手挂在右侧栏可边看对话边选会话导入，且不阻塞主聊天区；我方深埋在设置弹窗的全屏 `TaskShell` 中，导入后还得手动关设置弹窗去找会话。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 在 `settings.plugins.tab` 注册单一只读标签页 `检查点`（顶部配额统计 + 检查点时间线列表 + 下方内联 A/B Diff 对比面板与选择性恢复文件勾选面板，`client/index.js:647-769`）。 | **A** | 回滚点分成两半：日常回退嵌入聊天用户消息旁（`ChatEntryView.tsx`），全局台账与开关深埋在 `environment` → `maintenance` 子视图底部的 `RollbackCard` 弹窗中（`RollbackCard.tsx:104-987`）。 | **平** | 我方在聊天流消息气泡旁直接提供回退胶囊，比对手「在设置页复制 `/rewind <id>` 再回聊天框粘贴执行」更符合直觉；但对手的全局时间线是一级可见页，而我方的全局台账藏在三级深度（`环境 → 恢复与维护 → 查看台账 Modal`）。 |
| **`VS Code Settings Sync`** | 不设笨重的配置管理主页，通过左下角齿轮菜单开关，状态拆分为侧栏/面板内的 3 个轻量 Activity Views：`Synced Data`（远端各机器快照）、`Sync Activity (Local/Remote)`、`Troubleshooting`（官方文档）。 | **B** | 独立 4 页 + `TaskShell` 的重型设置分节（`ConfigManagerSection.tsx`）。 | **不可比** | **场景差异**：VS Code 的 Settings/Extensions/UI State 全部由宿主内核原生托管，同步只是透明后台管道；DSH 插件无宿主内置云账号体系，且必须兼管进程外崩溃救援、多 Profile 隔离实例启停与数百 MB 会话归档，无法退化为无界面后台管道。 |
| **`Obsidian Remotely Save / LiveSync`** | 从官方文档与社区评测看，两者均采用「左侧 Ribbon/状态栏一键触发同步 + 设置页单长表单配置存储后端与加密口令」的架构，冲突解决通过独立 Modal 弹出（`obsidian-livesync` README 及社区对比，2026-11-15）。 | **B/C** | `sync` 一级页将各通道收进折叠卡片 `SyncChannelEntryCard`，配置收进独立 `ChannelConfigDialog` 弹窗，日志收进底部 `SyncLogList`（`SyncPanel.tsx:323-680`）。 | **我优** | 从社区反馈看，Obsidian 同步插件的设置页疑似存在几十个配置项一镜到底堆叠的问题；我方将通道运行态（卡片）与通道编辑态（弹窗）分离，支持多通道并存且首屏清爽。 |

---

### 维度 2：导航模型（一级页 vs 命令面板 vs 抽屉/侧栏）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | 纯 3-Tab 切换 + 聊天 `/backup` 命令 + 1 个恢复确认 Modal；无命令面板、无侧栏联动、无跨区块快捷跳转（`src/tab.jsx:748-752, 1404-1441`）。 | **A** | 4 个一级页 Tab（带窄画布 `MoreMenu` 自适应折叠）+ `⌘K` `CommandPalette`（支持双语别名模糊跳转任意页/子视图/任务流）+ `TaskShell` 全屏层 + 右侧栏 Diff 联动（`nav-model.ts:47-82`, `CommandPalette.tsx:37-175`）。 | **我优** | 当功能超过 10 个子模块时，对手靠用户在单页内肉眼滚屏寻找卡片；我方通过 `⌘K` 命令面板实现零滚动直达任意深层动作（如「清理磁盘」「解锁 SAFE MODE」）。 |
| **`minghuo/dsh-github-sync`** | 单页内 5 个水平 Tab（`.dgs-tabs`）+ 会话原文查看器覆盖层（`.dgs-overlay` Modal，`client/index.js:1300-1310, 1415-1418`）。 | **A** | 一级页 Tab + `environment` 内部 `Segmented` 二级切换 + `TaskShell` 覆盖层 + `Modal`（`ConfigManagerSection.tsx:500-758`）。 | **平** | 对手功能域集中，单层 5-Tab 足以扁平承载；我方存在「一级 Tab → `Segmented` 子视图 → 卡片内按钮 → `Modal`」的四级叠加（如 `environment → maintenance → RollbackCard → 台账 Modal`），虽然有 `⌘K` 弥补，但鼠标点击层级偏深。 |
| **`Nwflower/dsh-chat-import`** | **三处宿主原生入口联动**：① 左侧栏底栏自适应按钮 `sidebar.footer.action`（实测可用宽度自动在 `share` 文字 / `icon` 36px 圆钮 / `row` 换行间切换，绝不挤坏宿主侧栏）→ ② 点击直接唤起宿主原生右侧栏 `sidebarRight.openTab('chat-import')` → ③ 顶部 `shell.overlay` 全局 Toast（`lib/client.js:3970-4227`）。 | **A** | 设置弹窗内 `settings.section` 主入口 + 聊天用户消息气泡旁 `conversation.chat.node` 回滚点胶囊 + 查看 Diff 时联动 `sidebarRight`（`ChatEntryView.tsx:52-180`）。 | **对手优** | 对手对 DSH 宿主槽位生态的利用极其精妙：通过左侧栏底栏自适应按钮 + 右侧栏常驻面板 + 顶部全局 Toast，让高频操作彻底摆脱了「先点开设置弹窗」的束缚；我方除聊天回滚点外，其余入口全困在设置弹窗内。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 挂在 `settings.plugins.tab`（设置 → 插件 → 检查点），页内采用「上下分栏内联展开」（上方时间线列表，点选 A/B 或点「恢复文件…」在列表下方直接展开 `.dcr-diff` 面板），不弹二级 Modal（`client/index.js:684-766`）。 | **A** | 全局回滚点台账采用「卡片摘要 → 点击弹出全屏列表 Modal → 再展开路径预览 → 再弹 `ConfirmDialog`」的多层弹窗模型（`RollbackCard.tsx:310-890`）。 | **对手优** | 在 `564×720` 的局促设置弹窗内，对手在时间线列表下方直接内联展开 A/B Diff 与文件勾选面板，避免了「弹窗套弹窗」的空间压迫感。 |
| **`VS Code Settings Sync`** | 深度融入宿主全局 `Command Palette`（`Settings Sync: Show Synced Data` / `Sync Now` / `Configure...`），辅以侧边栏专属 Activity View 树状视图（官方文档，2026-11-15）。 | **B** | 在插件内部自建了一套局部的 `⌘K` `CommandPalette`（仅在打开本插件设置页且聚焦时可用，`ConfigManagerSection.tsx:288-300`）。 | **平** | 我方把 VS Code 的 Command Palette 范式成功移植到了插件内部，体验极佳；但受限于未向宿主全局命令中心注册所有子动作，用户必须先进入插件页面才能按 `⌘K`。 |
| **`Obsidian Remotely Save / LiveSync`** | 注册到 Obsidian 全局 Command Palette + 左侧 Ribbon 图标 + 状态栏实时同步指示器（`remotely-save` / `obsidian-livesync` README，2026-11-15）。 | **B** | 插件页内 28px 底栏 `.statusBar` 展示同步与任务状态，但离开设置弹窗后主界面无常驻同步状态指示器（`ConfigManagerSection.tsx:715-755`）。 | **对手优** | 自动同步是后台周期行为，对手在宿主主界面状态栏常驻显示上次同步/冲突状态；我方的 28px 状态栏仅活在设置弹窗内部，关掉设置弹窗后后台同步失败无法在主界面第一时间感知。 |

---

### 维度 3：长列表与大数据量处理

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | `备份` Tab 仅截取最近 3 条（`snap.backups.slice(0, 3)`），`恢复` Tab、外部会话列表、市场列表全部直接 `.map()` 全量渲染，**无搜索、无分页、无虚拟滚动、无限高内滚容器**（`src/tab.jsx:850, 869, 1126, 1166, 1216`）。 | **A** | 严格执行 `DESIGN.md` 的 `*Scroll` 限高内滚容器规范（`listScroll` `360px`、`tableScroll` `280px`、`conflictScroll` `240px`），`home` 动态表限 30 条，`ExportView` `ContentPicker` 设 1000 项渲染上限（`DESIGN.md:380-420`, `ExportView.tsx:310-360`）。 | **我优** | 对手在会话数或备份数上百时会直接把整个 `设置` 页无限撑长甚至卡死 DOM；我方所有长列表均有显式 `max-height` 内滚与渲染上限保护，绝不撑破 `564×720` 画布。 |
| **`minghuo/dsh-github-sync`** | 本机会话按工作区折叠分组（`expanded[workspace.key]`），默认收起子列表，展开后全量 `.map()`；会话原文查看器硬截断前 200,000 字符（`viewer.text.slice(0, 200000)`，`client/index.js:1004-1024, 1308`）。 | **A** | `LibraryPanel` 支持关键词搜索、来源胶囊过滤与单行手风琴展开（`expandedKey`）；`RollbackCard` 台账按会话分组折叠（`LibraryPanel.tsx:160-310`, `RollbackCard.tsx:480-620`）。 | **平** | 双方都采用「按组折叠 + 单项按需展开 + 大文本截断」来规避首屏海量 DOM 挂载，在百级规模下表现相当，但双方均未实现虚拟滚动。 |
| **`Nwflower/dsh-chat-import`** | **教科书级大数据量方案**：① `useSessionScan` 后台流式扫描 + `after` 游标增量拉取，每块处理后 `await sleep(0)` 让出主线程防滚轮卡死，刷新时保留旧列表防闪烁；② `useListWindow` + `windowRange` **纯算术固定行高虚拟滚动窗口**（只挂载可视区及上下一屏 overscan 行，其余用 `padTop`/`padBottom` 等高占位块撑住，10 万行亦不卡）；③ `PageBar` 底栏分页（默认 500/页 + `PageJump` 页码网格跳页）+ `SessionRow` `React.memo` 标量比对（`lib/client.js:2106-2131, 2231-2496`）。 | **A** | `ForeignImportView` 一次性等待 `/foreign/sources` 阻塞扫盘返回，列表在 `max-height` 容器内直接 `.map()` 全量渲染，无流式游标、无虚拟滚动窗口、无分页；`ExportView` `ContentPicker` 超过 1000 项直接硬截断不渲染（`ForeignImportView.tsx:75-280`, `ExportView.tsx:320-355`）。 | **对手优** | 这是我方最明显的短板：面对重度用户成千上万条历史会话，对手用「游标流式增量渲染 + 固定行高虚拟窗口 + `React.memo`」做到了首屏秒出且零截断流畅滚动，而我方要么全量阻塞等待，要么到 1000 条硬截断。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 服务端 `timeline(limit)` 限制返回条数，顶部显示 `共 {total} 个检查点，显示 {shown} 个`；当变更文件过多时服务端返回 `files.truncated = true`，前端末尾追加一行 `… 以及更多文件`（`client/index.js:408-412, 550, 674-680`）。 | **A** | `RollbackCard` 与 `RollbackReviewDialog` 加载完整文件变更列表，通过限高滚动容器承载，并提供路径过滤与全选/反选（`RollbackReviewDialog.tsx:220-410`）。 | **我优** | 对手在文件数超限时直接 `truncated` 截断并隐藏超出文件，导致用户在「选择性恢复」面板里根本勾选不到被截断的文件；我方完整展示变更集以保证恢复范围 100% 可知可控。 |
| **`VS Code Settings Sync`** | Activity View 树组件原生采用 VS Code 核心的 `List/Tree Virtualizer`（按像素高度虚拟滚动），点击单条记录按需异步打开 Monaco Diff Editor（官方文档，2026-11-15）。 | **B** | `LibraryPanel` 与 `HistoryPanel` 采用限高 DOM 列表 + 按需懒加载单文件 Diff（`/snapshots/file-diff`，`LibraryActions.tsx:210-290`）。 | **对手优** | 我方虽已做到「Diff 内容按需懒加载」（不在列表接口里塞全量 Diff），但列表容器本身仍是全量 DOM 挂载，未做虚拟化。 |
| **`Obsidian Remotely Save / LiveSync`** | 从 `remotely-save` 与 `obsidian-livesync` 文档看，同步计划与日志在设置页或 Modal 内以普通滚动列表呈现，移动端大 Vault（上万笔记）扫描时主要靠后台异步队列 + Notice 进度提示避免阻塞 UI（B/C 级，2026-11-15）。 | **B/C** | `SyncLogList` 与 `SyncConfirmView` 差异列表在限高容器内渲染，后台同步通过 `runStore.watchRunning` 轮询状态（`SyncPanel.tsx:410-520`）。 | **平** | 在配置与常规同步差异（数十至数百项）量级下，双方的限高滚动列表均能胜任。 |

---

### 维度 4：状态归属与恢复（切页 / 刷新 / 崩溃后还在不在）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | **全部状态（30+ 个 `useState`）纯内存驻留于 `BackupTab` 组件内**（`src/tab.jsx:53-120`）：切走设置页或刷新浏览器后，当前 `tab`、未保存输入、正在查看的 `importPlan` / `foreignPlan` / `marketPreview` 全部清零；后台任务正在跑时切走再切回，`busy` 状态丢失，无法感知任务仍在进行。 | **A** | 三层状态归属：① `run-store.ts` 显式白名单 `toPersistedState()` 持久化 `activeTab`、`envSubView`、`library` 筛选排序、`import.step`、`sync` 通道摘要到 `sessionStorage`；② `runStore.watchRunning(kind, 500)` + `RunsCenter` 1.5s 轮询跨刷新恢复进行中任务进度；③ 宿主进程崩溃后重启由 `RecoveryPanel` 归因横幅 + `judgeRestoreResume` 续跑（`run-store.ts:389-424`, `RecoveryPanel.tsx:213-380`）。 | **我优** | 对手完全没有跨切页/跨刷新的前端状态恢复与后台任务重连机制；我方在导出/导入/同步主链路与崩溃后恢复续跑上建立了完整的状态闭环（惟 `RecoveryPanel`/`EnvironmentPanel` 局部动作仍存 `useState` 缺口 `UI-02`）。 |
| **`minghuo/dsh-github-sync`** | 前端 `tab`、`draft`、`restore`、`preview` 全在组件局部 `useState`（刷新即丢），但**服务端持久化了同步进度与上次结果**，且 `visibleSettings(status, draft)` 专门剥离了 `hasToken` 防止本地草稿遮蔽服务端最新凭据状态（`client/index.js:1327-1339`）。 | **A** | `SyncPanel` 将通道配置草稿（防抖自动保存）与选中态同步至 `runStore.sync`（持久化进 `sessionStorage`），密码经 `patchSyncPasswords()` 严格隔离在内存（`SyncPanel.tsx:340-460`, `run-store.ts:415-424`）。 | **我优** | 我方不仅同样做到了凭据布尔态与密码内存态的严格分离，还通过 `sessionStorage` 保留了用户的切页上下文与防抖自动保存。 |
| **`Nwflower/dsh-chat-import`** | 「从文件导入」折叠态存 `localStorage`（`chat-import.fileArea.collapsed`）；扫描流由服务端 `scan-cache` 与 `epoch` 驱动，同来源刷新时保留旧列表在屏直至新批次到达（零白屏闪烁）；批量导入时即便切走 Tab 或收起右侧栏，完成后仍通过 `shell.overlay` 全局 Toast 浮出结果与动作按钮（`lib/client.js:2238-2277, 2670-2690, 3031-3044`）。 | **A** | `LibraryPanel` 实现了 `stale-while-revalidate` 静默刷新不闪骨架，但 `ForeignImportView` 切页或切换来源会清空重扫，且任务完成反馈仅在设置弹窗内部呈现（`LibraryPanel.tsx:110-155`, `ForeignImportView.tsx:65-120`）。 | **平** | 我方在全局 `sessionStorage` 恢复与任务中心（`RunsCenter`）上更系统；对手在「列表刷新零闪烁保持」与「收起面板后通过宿主全局 Toast 异步送达结果」上更细腻。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 纯只读面板，`selectedA`、`selectedB`、`diffView`、`restoreTarget` 全在 `CheckpointTab` 局部 `useState`（`client/index.js:567-589`），切走即重置。 | **A** | `RollbackCard` 台账弹窗内的选中态同样在组件局部 `useState`，但回滚点开关与台账持久落盘，且 `ChatEntryView` 挂载时带 30 秒有界重试窗口应对回合收尾异步落盘（`ChatEntryView.tsx:110-165`）。 | **我优** | 我方针对「回合刚结束时回滚点尚在异步捕获」的真实竞态设计了 `0.5/1.5/3/6/12s` 有界重试，避免了假空态。 |
| **`VS Code Settings Sync`** | 同步队列、冲突挂起状态与远端 Activity 历史完全持久化在宿主 IndexedDB / 磁盘状态库中，重启 IDE 后未解决的冲突通知与 Diff 视图状态完整保留（官方文档，2026-11-15）。 | **B** | 宿主侧将 `SAFE MODE`、未解决 `incidents`、环境锁与 `SyncConfirmView` 待确认差异持久化在磁盘，重启 DSH 后 `HomePanel` / `RecoveryPanel` / `SyncPanel` 仍会持续提示（`RecoveryPanel.tsx:240-410`）。 | **平** | 双方均将关键异常与待裁决状态落盘到宿主侧，跨重启不丢。 |
| **`Obsidian Remotely Save / LiveSync`** | 从文档看，同步状态与队列落盘在插件 `data.json` / 本地 IndexedDB 中，运行中切出设置页不会中断后台同步任务（B 级，2026-11-15）。 | **B** | 导出/导入/同步在宿主侧异步执行，前端切页或关闭弹窗均不中断宿主任务，重开后由 `watchRunning` / `RunsCenter` 接回。 | **平** | 双方均实现了「宿主后台执行 + UI 可随时离开与重连」。 |

---

### 维度 5：危险操作交互（预览、确认粒度、回滚点）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | 1. **删除备份/Profile**：行内按钮变为红色「确认删除」，**6 秒不点或按 `Escape` 自动复位回普通按钮**（`src/tab.jsx:68-76, 685-696`）；<br>2. **恢复归档**：先跑 `restore(name, true)` dry-run，弹出 `alertdialog` 列出将覆盖文件数、预检警告与「同步重装依赖」勾选框；恢复前自动创建**正式入库的 `dsh-pre-restore-<ts>.tar.gz` 快照**并把原 `~/.dsh` `renameBeside` 挪旁，失败自动回滚（`src/tab.jsx:511-555, 1404-1441`；`lib/index.js:2082-2113`）；<br>3. **短板**：`importApply` 冲突固定传 `decisions: {}`（静默保留现有，无逐项裁决 UI，`src/tab.jsx:255-261`），且磁盘清理 `doCleanup('cache'\|'expired')` **点击即直接删除，无预览无二次确认**（`src/tab.jsx:286, 1265-1270`）。 | **A** | 1. 恢复/导入均强制「只读预览（带 `planId`/`planFingerprint` 锁内重比指纹）→ 逐项冲突裁决 → 自动前置快照 → 执行」；<br>2. 磁盘清理有 13 区域明细列表 + `ConfirmDialog` 确认；<br>3. `RunsCenter` 取消运行中任务时弹窗让用户选择 `rollback`（回滚已写改动）或 `keep`；<br>4. **但我方存在两处短板**：`EnvironmentPanel` 删除 Profile 虽有 `ConfirmDialog`（当前 Profile 加勾选框），但**删前未自动拍快照（`PW-01`）**；且恢复前生成的 `preRestoreDir` 孤立在磁盘，**无 UI 入口可一键回退到恢复前状态（`BK-01`）**。 | **平（各有胜负）** | 我方在「导入冲突逐项裁决 + `planFingerprint` 防漂移 + 磁盘清理确认 + 任务取消回滚选择」上远比对手严密；但对手「恢复前生成的 `dsh-pre-restore-*` 直接进备份列表可随时一键还原」以及「行内删除二次确认 6 秒自动复位」比我方的孤立 `preRestoreDir` 更闭环。 |
| **`minghuo/dsh-github-sync`** | 1. 恢复会话支持 `dryRun` 预览（「将写入 N 个文件」）、`overwrite` 开关与目标工作区下拉重映射，恢复前自动拍本地快照 `pre-restore-*`（可在 `本地快照` Tab 一键还原，`client/index.js:1085-1138, 1257-1278`）；<br>2. **危险短板**：`deleteSnapshot(name)` 点按钮直接发 `POST /snapshots/delete` **无任何二次确认**（`client/index.js:1277`）；且本机删除会话后同步推送会静默用 `sha: null` 删掉云端对应文件，无墓碑确认（`src/sync.js:503-515`）。 | **A** | 快照删除必过 `ConfirmDialog`（`danger`），若删 `current` 基线快照还有断链警告；云同步采用墓碑机制且**墓碑绝不自动删除本机数据**（`LibraryActions.tsx:310-390`, `AGENTS.md` 同步不变量）。 | **我优** | 对手在删除本地快照与同步传导删除上缺乏确认护栏；我方对所有删除动作强制 `ConfirmDialog` 并遵守「墓碑不删本机数据」的安全不变量。 |
| **`Nwflower/dsh-chat-import`** | 1. 导入会话始终「只新建或续写、不覆盖用户已改动的对话」；<br>2. `历史` 页提供「撤回导入」（单条删除或 `清空全部导入`），点击弹出确认框明确写出将删除的会话数与工件，且通过 `OWN_ID` / 导入记录边界严格限制**只删本插件创建的会话，绝不误伤原生会话**（`lib/client.js:126-142`）。 | **A** | `ImportWizardView` 导入前自动拍全量快照，冲突文件由 `ConflictList` 逐项决定覆盖或跳过；`RollbackReviewDialog` 会话回退采用 `sessionController.fork` + 归档原会话，绝不就地截断毁损原日志（`ImportWizardView.tsx:410-580`, `RollbackReviewDialog.tsx:180-310`）。 | **平** | 双方都恪守「不毁损用户既有会话」的底线；对手专门提供「按导入批次一键撤回并清理空工作区」的逆向管理页，我方则提供全量快照回滚与 `fork` 保护点。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 设置面板完全只读（连回滚按钮都不放，只提供 `[复制 /rewind]` 与 `[复制 /rewind --files]` 按钮）；真正的回滚强制用户回到会话内输入 `/rewind`，由宿主会话审批门（Approval Gate）先展示 Diff 摘要并拦截确认，且执行前先拍 `guard` 保护检查点（`client/index.js:183-196, 505-515`）。 | **A** | 在聊天消息旁点击回滚胶囊直接弹出 `RollbackReviewDialog`，同屏展示将删除的新建文件（`planCreatedRemovals`）与修改文件 Diff，勾选 `[连文件一起退]` 后点 `[回退]` 直接在 GUI 完成 `guard` 留点 + 工作区还原 + 会话 `fork`（`RollbackReviewDialog.tsx:120-520`）。 | **我优** | 对手为了复用会话内审批门，强迫用户在 GUI 选完文件后「复制 CLI 命令 → 关设置 → 贴进聊天框发送」，链路割裂；我方直接在 GUI 弹窗内完成 Diff 审阅、`planCreatedRemovals` 分子树安全判定、`guard` 留点与一键执行。 |
| **`VS Code Settings Sync`** | 开启同步或首次合并时弹出「Merge or Replace」向导；危险的「重置云端数据」要求在弹窗内显式勾选确认；每次覆盖本地配置前自动写入本地 Backup 文件夹，可从 `Sync Activity (Local)` 随时查看与还原单文件历史版本（官方文档，2026-11-15）。 | **B** | 同步拉取提供 `SyncConfirmView` 逐项预览与回滚按钮，恢复提供 `RestorePlanView` 单文件 Diff 懒加载预览（`SyncConfirmView.tsx:80-505`, `LibraryActions.tsx:190-310`）。 | **平** | 双方都具备「写入前本地留底 + 单文件级 Diff 预览 + 事后一键还原」的完整防呆体系。 |
| **`Obsidian Remotely Save / LiveSync`** | `remotely-save` 提供同步计划预览与空目录/大量删除保护阈值（超过阈值中止自动同步并要求人工确认）；`obsidian-livesync` 提供交互式冲突合并面板与修订历史回退（B 级，2026-11-15）。 | **B** | `SyncConfirmView` 针对「脱敏剥空的远端叶子」设有专门的防覆盖保护（远端为空且本机非空时，未逐行确认则保留本机并告警，`SyncConfirmView.tsx:210-340`）。 | **我优** | 针对 AI Agent 配置中特有的「API Key / 凭据被脱敏剥空后推上云端」场景，我方独创了 `redactedPaths` 叶级防误抹保护，防止空密文把本机有效凭据冲掉。 |

---

### 维度 6：错误呈现与可行动性（Actionable Error）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | 1. 通用动作错误仅靠 `String(err.message)` 塞进单行 `<p className="dsb-banner">`（无错误码分类、无脱敏、无修复动作按钮，`src/tab.jsx:177-179, 754-756`）；<br>2. **两处亮点**：① `BackupTabFallback` 在 `remote` 命名空间挂载失败时渲染降级卡片，明确告知「命令行 `/backup` 与定时备份仍可用」并展示 `mountError`（`src/tab.jsx:37-49`）；② 设置保存客户端校验失败时直接在按钮下方列出原因列表，绝不让按钮静默变灰（`src/tab.jsx:655-665, 935-939`）。 | **A** | 全仓统一走 `toActionableError()` → `ErrorBanner`（标题 + 原因 + 建议动作 + `[重试]`/`[前往处理]` 按钮），且所有错误与报告在 UI 渲染前强制过 `redact()` 脱敏掩码；SAFE MODE 与锁冲突均有专属引导卡片（`ErrorBanner.tsx:1-77`, `RecoveryPanel.tsx:240-450`）。 | **我优** | 对手的通用错误只是裸打 `err.message` 字符串且未做前端二次脱敏；我方实现了全链路脱敏 + 结构化可行动建议按钮，惟对手「保存按钮禁用时必在旁侧列出校验原因」的细节值得保持对齐。 |
| **`minghuo/dsh-github-sync`** | **三处高可行动性设计**：① `hostOutdated` 检测：当宿主 `status.api < REQUIRED_API` 时顶部横幅明确提示「宿主半边是旧版本，刷新页面不会更新，需重启 `dsh web`」并提供一键 `[重启 dsh]` 按钮（`client/index.js:211, 1348-1351`）；② `plugins.blocked` 专门把 `desktop` Electron 独占 Profile 分离成独立解释卡片，说明为何 CLI 无法安装，而不是给一个必败按钮（`client/index.js:201-202, 1218-1228`）；③ 恢复时因未开覆盖导致全部跳过时，内联给出 `[仍然恢复（本机自己的备份）]` 一键重试按钮（`client/index.js:150-151, 1123-1131`）。 | **A** | 同样对 `desktop` 保留档案与非 registry 插件带码拒绝并解释原因，且兼容性评分由 `compatibilityReasons()` 映射为字典人类语言（`EnvironmentPanel.tsx:410-490`）；但我方缺少「插件自身热更新/升级后前后端 API 版本失配」的显式检测横幅。 | **平** | 双方都非常重视「解释为什么不能做而非给死按钮」；对手的 `hostOutdated` 前后端版本失配检测与失败横幅内嵌「一键带 `force` 重试」按钮非常实用。 |
| **`Nwflower/dsh-chat-import`** | **极致的可行动错误闭环**：① 当外部文件所有解析器均失败时，不仅可展开查看每个解析器的具体报错，还提供 **`[复制失败摘要]` 按钮——一键复制一段可直接发给 AI Agent 的结构化转换任务 Prompt**（内含源文件地址、Interchange v1 JSON 规范 6 条硬要求、各解析器报错原因及 `dsh-chat-import-convert` Skill 指引，`lib/client.js:285-295`）；② 被幂等跳过或忽略墓碑挡下时，Toast 直接附带 `[重新导入为新会话]` / `[仍然导入]` 一键越权按钮（`lib/client.js:2673-2690`）；③ 扫描部分目录失败时顶部单行黄条点名失败来源，悬停看明细，不阻断其余来源展示（`lib/client.js:2208-2220`）。 | **A** | `ForeignImportView` 将机器码（如 `unsupported-format`、`empty-session`）经 `foreignSkipReasonLabel` 翻译为可读中文并在预览中列出（`ForeignImportView.tsx:180-260`, `foreign-view.ts:90-175`），但遇到不支持的未知格式时仅终止于「跳过/报错」，没有给用户提供「让 Agent 帮忙转换成可导入格式」的自愈出路。 | **对手优** | 身处 AI Coding Agent 宿主内，对手把「解析失败」变成了一段「一键复制给 Agent 让它写转换器/转格式」的闭环 Prompt，这是极具原生 Agent 思维的交互创新。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 错误呈现较为简陋：`unwrap()` 失败直接抛 `code: message`，页面渲染单行红色 `<p className="dcr-error">` 加一个 `[重试]` 按钮（`client/index.js:664-671, 772-776`）。 | **A** | `RollbackCard` 与 `RollbackReviewDialog` 接入统一的 `ErrorBanner`（含脱敏与分类提示），并在回退后若 `cwd` 归位失败时写入结构化诊断信息（`RollbackReviewDialog.tsx:280-360`）。 | **我优** | 我方在错误脱敏、分类诊断与恢复引导上明显更完善。 |
| **`VS Code Settings Sync`** | 冲突或认证过期时在右下角弹出带明确动作按钮的 Notification Toast（如 `Sign in` / `Show Conflicts` / `Accept Remote`），并提供 `Settings Sync: Show Log` 一键打开底层传输日志（官方文档，2026-11-15）。 | **B** | `HomePanel` 最近动态表对失败的同步/备份行提供内联动作（如 `jumpTo === 'sync'` 直接打开合并裁决），`HistoryPanel` 与 `AboutPanel` 提供诊断复制（`HomePanel.tsx:420-540`）。 | **平** | 双方都做到了「从错误提示一键跳转到对应的冲突裁决或诊断视图」。 |
| **`Obsidian Remotely Save / LiveSync`** | 从文档与 Issue 反馈看，`remotely-save` 在 WebDAV/S3 跨域（CORS）或认证失败时主要通过右上角短暂浮出的 Obsidian `Notice` 报错，详细堆栈需用户打开开发者控制台或导出调试日志查看（B/C 级，2026-11-15）。 | **B/C** | `SyncPanel` 将通道连接/认证/锁冲突错误固定渲染在面板顶部 `ErrorBanner` 及通道卡片状态栏，不会像短暂 Toast 那样一闪而过。 | **我优** | 配置与同步错误通常需要用户核对 URL/凭据或处理冲突，常驻且带动作按钮的 `ErrorBanner` 比转瞬即逝的 `Notice` 更好排查。 |

---

### 维度 7：首次使用路径（零配置到完成第一次备份的步数）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | 当 `snap.backups.length === 0` 时，首屏渲染专属 `.dsb-hero` 引导卡：展示大号主按钮 **`[立即备份]`** + 底部 3 步静态说明（`1 · 先备份一次` → `2 · 了解如何恢复` → `3 · 开启自动备份`），无需填写任何路径（默认 `~/Desktop/dsh-backups/`），**打开设置页 → 点 1 下 `[立即备份]` 即完成首次全量备份**（`src/tab.jsx:760-776`）。 | **A** | 当 `snapshots === 0 && backups === 0 && !syncConfigured` 时，`HomePanel` 首屏展示 3 步引导 `Stepper`（第 1 步创建快照、第 2 步配置定时或导出、第 3 步配置云同步），且首屏 `.toolRow` 第一个按钮即为 primary **`[立即备份]`**，同样 **打开设置页 → 点 1 下 `[立即备份]` 即完成首次快照**（`HomePanel.tsx:280-415`）。 | **平** | 双方都把「零配置 1 次点击完成首次本地备份 + 首屏 3 步渐进引导」做到了极致。 |
| **`minghuo/dsh-github-sync`** | 本地快照需切到第 4 个 Tab `本地快照` 再点 `[立即快照]`（2 步）；云端首次备份需先在 GitHub 手工建私有仓 + 生成 Fine-grained PAT → 填表点 `[保存]` → 点 `[验证仓库]` → 点 `[立即备份]`（共 5 步，`README.md:46-50`, `client/index.js:1257-1266`）。 | **A** | 本地备份在 `home` 首屏 1 步完成；云同步在 `sync` 页支持 **GitHub OAuth 设备流一键登录授权**（无需手工去 GitHub 翻找权限建 PAT），也支持 Gist / WebDAV / S3（`SyncPanel.tsx:720-910`）。 | **我优** | 本地首备我方在首屏（1 步 vs 对手 2 步）；云端首次配置我方提供 GitHub OAuth Device Flow 引导，免去了新手配置 Fine-grained PAT 权限的门槛。 |
| **`Nwflower/dsh-chat-import`** | 首次使用：点击宿主左侧栏底部的 `[导入会话]` 按钮（1 步）→ 右侧栏自动展开并立即流式扫出本机所有 Claude Code / Codex / Cursor 等会话 → 勾选会话点 `[导入所选]`（2 步即完成首次跨工具会话迁移，`lib/client.js:2606-2898, 4133-4146`）。 | **A** | 首次导入外部会话：打开设置弹窗 → 选本插件 → 在 `home` 点 `[从其它 agent 导入]` → 在 `ForeignImportView` 点选来源 → 进入 `ImportWizardView` 走完预览与确认（共 5–6 步，`ForeignImportView.tsx:42-337`）。 | **对手优** | 针对「首次把外部 Agent 会话迁入 DSH」这一高频破冰场景，对手从左侧栏一键呼出右侧栏、2 步即达；我方需要穿过设置弹窗 + 来源预选页 + 6 阶段向导，步数多一倍以上。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 首次进入 `检查点` 设置页时只显示空态文案 `还没有检查点。用 /checkpoint 或 checkpoint 工具捕获一个`，**面板上甚至没有「立即创建检查点」按钮**，也不是自动开启（需去设置开 interval 或回聊天打命令，`client/index.js:157, 209, 681-683`）。 | **A** | `RollbackCard` 提供显式的「自动捕获回滚点」开关（含工作原理说明），且 `home` 首屏提供 1 键快照备份（`RollbackCard.tsx:160-260`）。 | **我优** | 对手的设置面板在空态下完全没有可执行按钮，把用户推回命令行；我方在面板内直接提供开关与操作闭环。 |
| **`VS Code Settings Sync`** | 点击左下角齿轮 → `Turn On Settings Sync...` → 勾选同步项并选择 GitHub/Microsoft 账号 OAuth 登录 → 自动完成首次备份与合并（3 步，零路径/存储配置，官方文档，2026-11-15）。 | **B** | 本地快照零配置 1 步；但云同步仍需用户提供自己的 Git 仓库 URL、Gist、WebDAV 或 S3 Bucket（`SyncPanel.tsx`）。 | **不可比** | **场景差异**：VS Code 由微软官方提供免费托管云存储后端，故可做到「仅登录账号即同步」；DSH 插件遵循去中心化 BYO-Storage（自带存储）架构，无官方免费云存储可挂靠。 |
| **`Obsidian Remotely Save / LiveSync`** | 从文档看，首次使用必须先在长表单中填妥 S3/WebDAV/CouchDB 连接参数与加密口令、点测试连接、保存后才能点左侧 Ribbon 触发首次同步（约 5–6 步，无本地零配置一键快照，B 级，2026-11-15）。 | **B** | 将「零配置本地快照（1 步）」与「进阶多端云同步（按需配置）」分层解耦，新用户无需任何云账号即可在 3 秒内获得首份本地安全兜底（`HomePanel.tsx:280-415`）。 | **我优** | 我方不把云存储配置作为首次备份的前置门槛，新用户首屏 1 次点击即可建立本地安全感。 |

---

### 维度 8：冲突解决（多端同步与导入时给人看什么）

| 深读对手 | 对手做法 | 证据级别 | 我的做法（`dsh-config-manager`） | 判定 | 一句原因 |
| :--- | :--- | :-: | :--- | :-: | :--- |
| **`xiaoyuyu6420/dsh-backup`** | **几乎无可视化冲突裁决**：① GitHub 同步仅做整包 `.tar.gz` 上传/拉取（无字段级或文件级合并）；② 分类型恢复（`merge`）在确认框里只显示一句总数 `将覆盖 {n} 个文件`，不展示具体冲突文件 Diff；③ 配置包导入 `doImportApply` 硬编码传 `decisions: {}`（静默保留本地现有项，用户在 UI 上无法对单个冲突项改选「用导入覆盖」，`src/tab.jsx:255-261, 1412-1414`）。 | **A** | 提供三套精细冲突视图：① 导入向导 `ConflictList`（逐文件/逐项展示冲突，支持单选保留本地或覆盖 + 批量动作）；② 云同步 `MergeModal`（按分区 `useLocal`/`useRemote`/`useMerged` + 叶级 JSON 路径冲突逐项单选，禁止全局 `replace` 吞未决冲突）；③ `SyncConfirmView`（拉取差异逐行勾选采纳 + `redactedPaths` 空值防误抹告警，`MergeModal.tsx:73-222`, `SyncConfirmView.tsx:80-505`）。 | **我优** | 对手在导入时把冲突决策硬编码为 `{}` 剥夺了用户的选择权，在恢复时只给数字不给明细；我方实现了从分区级、文件级到 JSON 叶级路径的完整可视化裁决。 |
| **`minghuo/dsh-github-sync`** | **通过架构设计消除了云端写冲突**：每台机器只写 GitHub 仓库下的 `instances/<instanceId>/` 独立命名空间，因此推送永不冲突；另有 `与云端比较` 视图列出 `可推送` 与 `可拉取` 文件数；跨机恢复到本机时提供 1 个全局 `覆盖本机同名文件` 开关 + 工作区目录重映射下拉框（`README.md:5-27`, `client/index.js:158-165, 1090-1105`）。 | **A** | 多机共享同一远端基准（`index.json` 条件写 + `latest/` 派生视图），当两台机器并发修改同一配置分区时，触发 `MergeModal` 三路合并与 `SyncConfirmView` 逐项裁决（`SyncPanel.tsx:950-1420`）。 | **平（路线取舍不同）** | 对手的「按机器实例分目录」对**纯会话归档**极聪明（天然零冲突，无需复杂合并 UI）；但对于「希望多台机器自动保持同一套 `settings`/Skills/MCP 同步演进」的场景，按实例隔离会导致配置分叉，仍需我方的共享基准 + 三路合并机制。 |
| **`Nwflower/dsh-chat-import`** | 专注会话导入，通过幂等键识别 `already-imported`（已导入未变）、`appended`（安全续写）与 `reimported`（若本机已对该会话续聊过，则**自动另建新会话副本，绝不覆盖或污染用户本机对话**），并在顶部 Toast 给出「重新导入为新会话」按钮（`lib/client.js:175, 2668-2690`）。 | **A** | 外部会话导入合成新会话或进入导入计划，通过 `ConflictList` 展示冲突项（`ForeignImportView.tsx`, `ImportWizardView.tsx`）。 | **对手优** | 针对「同一外部会话二次导入」的冲突场景，对手区分了「未动过则增量续写 (`appended`)」与「本机已聊过则自动分叉建新副本 (`reimported`)」，比传统文件级「覆盖/跳过」二选一更懂会话语义。 |
| **`PerryLink/dsh-checkpoint-rewind`** | 提供检查点之间的 **Pairwise（逐行 `+/-`）与 Side-by-Side（左右并排 `.dcr-ss-row`）双模式 Diff 渲染器**，同时展示工作区文件增删改、配置行级 Diff（`sideBySideConfigRows`）与会话游标回退丢弃的事件数（`dropped`，`client/index.js:347-461`）。 | **A** | `LibraryActions`（`RestorePlanView`）与 `RollbackReviewDialog` 提供变更文件列表，点击文件调用宿主右侧栏 Diff 或内联展示单文件前后对比，并明确列出将删除的新建文件（`RollbackReviewDialog.tsx:240-460`）。 | **平** | 对手的「A/B 任意两检查点并排 Diff + 会话游标丢弃事件数直观公式（`cursor A → B; rewinding drops N events`）」在信息密度上很出彩；我方则在「与宿主右侧栏原生 Diff 联动」及「新建文件删除集安全证明」上更扎实。 |
| **`VS Code Settings Sync`** | 冲突时提供清晰的 **3 选 1 入口（`Accept Local` / `Accept Remote` / `Show Conflicts`）**；点 `Show Conflicts` 直接调起宿主内置的 **左右分栏 Diff / Merge Editor**，允许用户在预览窗格中**直接手改 JSON 文本**挑选具体行，保存即完成合并（官方文档，2026-11-15）。 | **B** | `MergeModal` 与 `SyncConfirmView` 提供结构化表单控件（分区三选一按钮 + 叶级路径 Radio 单选 `keepLocal`/`useRemote` + 勾选框），不支持在弹窗内直接手改原始 JSON/YAML 文本（`MergeModal.tsx:73-222`, `SyncConfirmView.tsx:80-505`）。 | **对手优** | 我方的 Radio 表单虽能防用户手改写坏 YAML 语法，但当遇到几十行配置差异或用户想「把两边的数组元素手动拼在一起」时，VS Code 的左右并排可编辑 Diff 视图比单选表单直观且灵活得多。 |
| **`Obsidian Remotely Save / LiveSync`** | `remotely-save` 基础版仅按时间戳覆盖或生成旁路冲突文件（智能合并在付费 PRO 版）；`obsidian-livesync` 内置专用可视化冲突解决面板（展示修订块差异供用户点选 A 或 B 合并，B/C 级，2026-11-15）。 | **B/C** | 免费内置完整的三路合并 `MergeModal`、逐行确认 `SyncConfirmView` 与脱敏空值保护。 | **我优** | 相比 `remotely-save` 基础版仅靠时间戳覆盖，我方在开源插件内完整提供了叶级三路合并与防脱敏空值误抹保护。 |

---

## ④ 反向论证（Step 5）

### 4.1 至少 3 处「我方明确不如对手」（附对手实现与我方改动代价）

1. **大数据量列表缺乏「游标流式增量加载 + 固定行高虚拟滚动窗口 + 整行热区勾选」**（对手：**`Nwflower/dsh-chat-import`**，A 级证据 `.tmp/refs/dsh-chat-import/lib/client.js:2106-2131, 2231-2496`）
   - **对手怎么做**：
     - 扫描外部会话时，`useSessionScan` 采用后台扫描 + `after` 游标增量拉取，每处理完一块显式 `await sleep(0)` 让出主线程，首屏几百毫秒即出第一批结果，且同源刷新时保留旧列表在屏直至新首批到达（零闪烁）；
     - 渲染列表时，`useListWindow` + `windowRange` 用纯算术（固定行高 `LIST_ROW_H`、组头高 `LIST_HEAD_H`）计算可视区切片，DOM 中永远只挂载几十行，其余用 `padTop`/`padBottom` 空白块撑高，配合 `SessionRow` `React.memo` 标量比对，10 万条会话也不卡顿；
     - 勾选交互将**整行容器设为 `role="checkbox"` 点击热区**，不再强迫用户瞄准 16–22px 的微小复选框。
   - **我方现状与差距**：`ForeignImportView` 全量阻塞等待 `/foreign/sources` 返回且直接 `.map()` 渲染；`ExportView` 的 `ContentPicker` 面对超量条目只能在 1000 条处硬截断（`ExportView.tsx:320-355`）。
   - **我方改动代价**：**低–中**。纯前端改动（`src/client/import/ForeignImportView.tsx`、`src/client/export/ExportView.tsx`、`src/client/library/LibraryPanel.tsx`），无需改后端路由契约，无需动 `DESIGN.md` 色板，仅需引入 ~45 行纯算术 `useListWindow`/`windowRange` hook 并扩大行点击热区。

2. **外部导入遇到未知/损坏格式时，缺乏「一键复制给 Agent 的自愈转换任务模板」与跳过项一键越权 Toast**（对手：**`Nwflower/dsh-chat-import`**，A 级证据 `.tmp/refs/dsh-chat-import/lib/client.js:285-295, 2673-2690`）
   - **对手怎么做**：
     - 当外部文件无法被现有解析器识别时，卡片不仅允许展开查看各解析器失败原因，还提供 **`[复制失败摘要]`** 按钮——点一下即生成一段结构化 Prompt（含源文件路径、目标转换格式 6 条硬约束及转换指南链接），用户直接粘贴给 DSH 聊天框里的 Agent 就能让 Agent 把奇异格式转成标准可导入文件；
     - 当导入条目因幂等或忽略记录被跳过时，结果通知直接附带 `[重新导入为新会话]` / `[仍然导入]` 一键 force 重试按钮。
   - **我方现状与差距**：`ForeignImportView` 虽把跳过码翻译成了中文（`foreignSkipReasonLabel`），但报错即终点，用户拿不可识别的外部配置或会话毫无办法。
   - **我方改动代价**：**极低**。仅需在 `src/ui/foreign-view.ts`、`src/client/import/ForeignImportView.tsx` 与双语字典中增加一段结构化诊断/转换 Prompt 拼接函数与 `CopyButton`，完全不碰后端路由与 `DESIGN.md`。

3. **高频会话/配置导入困在设置弹窗全屏 `TaskShell` 中，且跨机导入会话缺少「同名工作区智能推荐 + `restamp` 置顶时间平移 + 导入后一键打开」**（对手：**`Nwflower/dsh-chat-import`** + **`minghuo/dsh-github-sync`** + **`kinyokun/dsh-session-import`**，A 级证据）
   - **对手怎么做**：
     - `dsh-chat-import` 通过 `sidebar.right.pane.tab` 把导入面板挂在宿主右侧栏，边看对话边导入；
     - `dsh-github-sync` 的 `suggestWorkspace()`（`client/index.js:1388-1395`）自动比对路径末段文件夹名，在跨机恢复时自动预选本机同名工作区；
     - `dsh-session-import`（`client.js:280, 319-328, 474-480`）提供 `restamp` 复选框（把旧会话事件时间戳等距平移到当前，使其在侧栏置顶易找）并在导入成功后立即调用 `sessions.open(data.sessionId)` 打开该会话。
   - **我方现状与差距**：我方已在 `RollbackReviewDialog` 中熟练使用了宿主右侧栏 `sidebarRight` 展示 Diff，但外部导入和快照恢复后用户必须自己关闭设置弹窗、去左侧栏翻找刚导入的旧时间戳会话。
   - **我方改动代价**：**中**。「同名工作区自动推荐」与「导入完成后提供 `[立即打开会话]` 按钮」仅需改前端 `ImportWizardView.tsx` 与宿主返回的新 `sessionId`；若增加 `restamp` 则需微调 `src/core/` 会话导入改写逻辑。

4. **检查点/回滚点缺少「任意两点（A/B）对比」与「会话游标回退丢弃事件数公式」，且全局台账入口藏得过深**（对手：**`PerryLink/dsh-checkpoint-rewind`**，A 级证据 `.tmp/ref-plugins/dsh-checkpoint-rewind/client/index.js:179, 231, 347-461, 684-755`）
   - **对手怎么做**：在时间线每一行提供 `[选为 A（较早）]` 与 `[选为 B（较新）]`，点选任意两点即在下方内联展示两检查点之间的工作区文件增删改、配置并排 Diff 以及会话游标变化公式：`游标 {fromSeq}（turn {fromTurn}）→ {toSeq}（turn {toTurn}）；回退将丢弃 {dropped} 条事件`。
   - **我方现状与差距**：我方 `RollbackReviewDialog` 与 `RollbackCard` 只能看「某个回滚点 vs 当前盘面」的差异，无法对比历史上的两个回滚点（或两个快照），也没有明确写出「此次回退将丢弃多少条后续对话事件」；且全局台账藏在 `environment → maintenance → RollbackCard → 查看台账 Modal` 第 4 层。
   - **我方改动代价**：**中**。在 `RollbackReviewDialog.tsx` 增加「回退将分叉并归档后续 N 个回合/事件」的提示仅需动前端与预览摘要（低成本）；若支持任意两快照/回滚点 A/B Diff 则需扩展后端 `/snapshots/file-diff` 接口接收 `baseId`。

5. **恢复前安全兜底与进程内长耗时状态归属存在闭环缺口**（对手：**`xiaoyuyu6420/dsh-backup`**，A 级证据 `.tmp/audit/raw/dsh-backup/lib/index.js:2082-2085` & `src/tab.jsx:68-76`）
   - **对手怎么做**：恢复归档前自动调用 `doBackup` 生成一份带 `dsh-pre-restore-<ts>.tar.gz` 前缀的**标准备份包**，直接出现在备份列表中，一旦恢复后对结果不满意，可在 UI 列表里一键把 `dsh-pre-restore-*` 再还原回来；同时列表行内删除采用「点一下变确认删除、6 秒无操作或按 Esc 自动复位」的轻量防误触。
   - **我方现状与差距**：我方恢复失败虽会自动回滚，但恢复**成功**后留下的 `preRestoreDir` 孤立在磁盘上，UI 既不展示也无一键还原入口（见 `docs/known-issues/known-gaps.md` `BK-01`）；此外 `EnvironmentPanel` 删除 Profile 前未自动留快照（`PW-01`），且 `RecoveryPanel` / `EnvironmentPanel` 的恢复、修复、清理、复制操作状态存在组件局部 `useState` 中，切页再切回即丢失进行中反馈（`UI-02`）。
   - **我方改动代价**：**低–中**。将 `RecoveryPanel`/`EnvironmentPanel` 的长耗时操作接入 `runStore.watchRunning` 纯属前端状态收敛；在 `RecoveryPanel` 暴露最近一次 `preRestoreDir` 的「撤销上次恢复」入口需补一条轻量路由或复快照列表。

---

### 4.2 至少 2 处我方的「伪优势」（看起来更强，实则是对方场景不需要那种复杂度）

1. **伪优势 1：四通道通用三路合并 + 叶级 JSON 路径冲突单选器（`MergeModal` + `SyncConfirmView`）**
   - **表面看**：相比 `minghuo/dsh-github-sync` 和 `PerryLink/dsh-session-sync` 根本没有冲突裁决弹窗，我方的分区三选一 + 叶级 Radio 裁决器显得技术含量极高。
   - **真相**：如果用户的核心诉求只是「在多台电脑间备份和拉取会话与插件清单」，`minghuo/dsh-github-sync` 用 **`instances/<instanceId>/` 按机器分目录**、或者 `PerryLink/dsh-session-sync` 用 **append-only keep-both**，在数据结构层就让写冲突概率归零了——**最好的冲突解决 UI 是不需要冲突解决 UI**。我方之所以必须维护如此复杂的 `MergeModal` 与 `SyncConfirmView`（含 `redactedPaths` 防脱敏空值回写），是因为我方承诺了「多机共享覆写同一份 `settings.yaml` / `cordis.patch.yml` 且支持将凭据脱敏剥空后推到 WebDAV/S3/Gist」。这是我方自己选择的共享写架构带来的衍生负担，面对只做会话/实例级同步的对手时，不能算作纯粹的交互领先。

2. **伪优势 2：3235 行 CSS + 4 一级页 + 6 个 `TaskShell` + `⌘K` 命令面板的「微缩桌面 OS」壳层**
   - **表面看**：相比 `kinyokun/dsh-session-import`（总共 610 行代码、1 个拖拽上传对话框）或 `PerryLink/dsh-checkpoint-rewind`（809 行代码、1 个时间线标签页），我方的自适应导航栏、28px 底部状态栏、`CommandPalette` 与 5 层语义 Token 守卫显得无比正规、工业化。
   - **真相**：Unix 哲学下的单域插件（只做会话导入，或只做检查点）天然不需要二级导航、不需要命令面板、也不需要全局任务中心——用户点开按钮就是唯一的工作面，2 次点击必达结果。我方的重型壳层与 `⌘K` 面板，本质上是为了把「备份 + 市场 + 4 通道云同步 + 30 源外部导入 + 多 Profile 进程管理 + 崩溃救援 + 会话体检 + 聊天回滚点」8 个子产品塞进同一个 `564×720` 画布而不得不支付的**「全能巨石插件导航税（Monolith Navigation Tax）」**。

3. **伪优势 3：导出流程的双栏级联 `ContentPicker`（左分区 + 右会话/插件细粒度勾选 Modal）**
   - **表面看**：比 `xiaoyuyu6420/dsh-backup` 的 6 个分类型胶囊（`dsb-chip`）细粒度得多，能精确勾选导出哪几条会话、哪几个插件。
   - **真相**：在 90% 的日常本地备份与跨机整机迁移场景中，用户要的是「一键全量」或最多「按大类勾掉 `sessions`」；双栏级联 `ContentPicker` 只在「向配置市场发布公开包、需要剔除私人会话」这一低频场景下才真正刚需。对于日常备份而言，对手的 6 个平铺胶囊反而少一次弹窗层级。

---

### 4.3 全优维度自省：是否因采样不足导致虚高？

在八维矩阵中，**没有任何一个维度被判定为「6 个对手全部是我优」**；我方得分最集中的是 **维度 1（信息架构）**、**维度 4（状态归属）**、**维度 5（危险操作）** 与 **维度 6（错误呈现）**（各取得 3–4 个「我优」）。即便在这四个优势维度，我们也必须做如下反采样自省：

- **为何在 L1 备份类对手（`dsh-backup` / `dsh-backup-sync` / `dsh-cloud-sync`）面前显得全面占优？**
  因为早期 L1 备份插件多为单人快速交付的脚本型面板（如 `dsh-backup` 将 11 张卡片全部塞进 `设置` Tab、全组件 `useState` 零持久化、错误直接 `String(err.message)`）。如果只跟这三个对手比，会得出「我方交互已无可挑剔」的假象。
- **引入专项强手（`Nwflower/dsh-chat-import`、`PerryLink/dsh-checkpoint-rewind`、`VS Code Settings Sync`）后暴露了什么？**
  一旦把采样扩大到 L1 专项标杆与 L2 宿主标杆，我方在 **维度 2（宿主右侧栏与主界面状态栏利用）**、**维度 3（流式游标与虚拟滚动窗口）**、**维度 6（解析失败一键生成 Agent 自愈 Prompt）** 与 **维度 8（可编辑并排 Diff 视图 & 会话自动分叉续写语义）** 上立刻暴露出明显短板。因此，我方在状态持久化与安全围栏上的领先是真实的工程积累，但在「宿主原生槽位融合度」与「大数据量/AI 原生自愈交互」上绝非全面领先。

---

## ⑤ 结论口径：保留 / 该改 / 存疑（Step 6）

> **说明**：不打总分、不排名。其中 **「该改」严格按性价比（ROI = 用户体验收益 ÷ 改动成本）从高到低排序**，不按严重程度排序；本轮仅列落地条目，不改任何代码。

### 5.1 【保留】（有明确代码与场景依据，继续维持现状）

1. **4 一级页（`home` / `library` / `sync` / `environment`）+ `⌘K` 命令面板 + 市场归入 `library` 任务流的信息架构**
   - **依据**：对比 `xiaoyuyu6420/dsh-backup` 将 11 张卡片堆进单一 `设置` Tab 的反面教材（`src/tab.jsx:885-1402`），我方在承载 8 个子域的前提下，靠 4 页切分守住了 `564×720` 首屏呼吸感，并用 `CommandPalette`（`src/ui/commands.ts`）消除了深层功能的寻找成本；市场属低频获取渠道，不占一级导航完全正确。
2. **聊天流用户消息旁的回滚点胶囊 + 单步 `RollbackReviewDialog`（联动宿主右侧栏 Diff + `fork` 归档）**
   - **依据**：对比 `PerryLink/dsh-checkpoint-rewind` 强迫用户在设置页复制 `/rewind` 命令再贴回聊天框执行的割裂链路（`client/index.js:183-196`），我方在对话发生地直接提供单步预览与 `sessionController.fork` 执行，且带收尾后 30 秒有界重试（`ChatEntryView.tsx:110-165`），是全生态最顺畅的回合级回退交互。
3. **云同步的 `redactedPaths` 脱敏空值防误抹保护与叶级冲突显式裁决**
   - **依据**：AI Agent 配置含大量 API Key 与 Token，导出/同步默认脱敏剥空；我方在 `SyncConfirmView` 中对「导入为空而本机非空」的叶子默认保留本机并高亮告警（`SyncConfirmView.tsx:210-340`），防止了同类工具常见的「拉取一次云端配置把本机 Key 全冲空」事故。
4. **`run-store.ts` 的 `toPersistedState()` 显式白名单持久化 + 凭据/口令纯内存隔离**
   - **依据**：兼顾了切页/刷新后的上下文恢复与安全不变量（密码永不进 `sessionStorage`/日志/响应），显著优于 `dsh-backup` 的全内存丢失模型。
5. **离线救急台（`dcm web`）的零 JS 框架、单次 Token 兑 `HttpOnly` Cookie、与 CLI 同源写入门设计**
   - **依据**：当宿主因坏插件或坏会话无法启动时，零外部前端依赖的 SSR 单页（`src/cli/web/page.ts`）是唯一可靠的图形化逃生通道。

---

### 5.2 【该改】（按性价比 ROI 从高到低排序）

| 优先级 (ROI) | 改进项 | 借鉴对手与具体实现 | 改动成本评估（动哪层 / 是否动路由 / 是否动 `DESIGN.md`） |
| :-: | :--- | :--- | :--- |
| **#1（最高性价比）** | **外部导入失败时提供「一键复制 Agent 转换任务 Prompt」** | **对手**：`Nwflower/dsh-chat-import`（`lib/client.js:285-295`）。<br>**做法**：在 `ForeignImportView` / `ImportWizardView` 遇到无法识别或解析失败的文件时，除展示 `foreignSkipReasonLabel` 外，增加 `[复制转换任务给 Agent]` 按钮，一键生成包含源文件路径、跳过原因与目标格式要求的 Prompt。 | - **改动层**：仅 `src/ui/foreign-view.ts` + `src/client/import/ForeignImportView.tsx` + 双语词典（~40 行代码）<br>- **动路由**：否<br>- **动 `DESIGN.md`**：否（复用现有 `CopyButton` 原语） |
| **#2** | **`RollbackReviewDialog` 与快照恢复预览补齐「会话游标丢弃回合/事件数」直观提示，并在一级可见处提供回滚点台账快捷入口** | **对手**：`PerryLink/dsh-checkpoint-rewind`（`client/index.js:179, 231`）。<br>**做法**：① 在 `RollbackReviewDialog` 顶部明确写出「回退至第 X 回合前，后续 N 条对话事件将保留在归档原会话中」；② 在 `home` 页指标卡或工具栏增加直达「回滚点台账」的轻入口，免去 `environment → maintenance → RollbackCard` 三层下钻。 | - **改动层**：`src/client/chat/RollbackReviewDialog.tsx` + `src/client/home/HomePanel.tsx` + 词典<br>- **动路由**：否<br>- **动 `DESIGN.md`**：否 |
| **#3** | **跨机导入/恢复会话时支持「同名工作区自动匹配推荐」与「导入完成后一键打开会话」** | **对手**：`minghuo/dsh-github-sync`（`suggestWorkspace`，`client/index.js:1388-1395`）+ `kinyokun/dsh-session-import`（`sessions.open`，`client.js:319-328`）。<br>**做法**：① 跨机恢复或外部导入会话时，按路径末段项目名自动匹配并默认高亮本机同名工作区；② 导入完成报告页（`ReportView`）对新导入会话提供 `[立即打开对话]` 按钮。 | - **改动层**：`src/ui/` 纯函数 + `src/client/import/ImportWizardView.tsx`<br>- **动路由**：否（利用已有工作区与结果字段）<br>- **动 `DESIGN.md`**：否 |
| **#4** | **将 `RecoveryPanel` / `EnvironmentPanel` 的局部 `useState(busy)` 收敛进 `runStore.watchRunning`，消除切页丢进度（修 `UI-02`）** | **对手**：参照本仓自身 `ExportView`/`ImportWizardView` 已验证的 `runStore` 模式，消除向 `dsh-backup` 式的局部易失 state 退化。<br>**做法**：恢复快照、会话修复、磁盘清理、档案复制统一走 `runStore` 任务状态跟踪，切页再回或打开 `RunsCenter` 均可看到进行中状态。 | - **改动层**：`src/client/run-store.ts` + `src/client/recovery/RecoveryPanel.tsx` + `src/client/environment/EnvironmentPanel.tsx`<br>- **动路由**：否<br>- **动 `DESIGN.md`**：否 |
| **#5** | **为长列表（`ForeignImportView` / `ExportView` `ContentPicker` / `LibraryPanel`）引入固定行高算术虚拟窗口与整行点击勾选热区** | **对手**：`Nwflower/dsh-chat-import`（`useListWindow` + `windowRange` + `SessionRow` 整行 `role="checkbox"`，`lib/client.js:2116-2131, 2310-2333, 2392-2417`）。<br>**做法**：抽出零依赖的 `useVirtualWindow` hook（固定行高算术切片 + `padTop`/`padBottom`），解除 `ContentPicker` 1000 项硬截断，并将多选行点击热区扩大至整行。 | - **改动层**：新增 `src/client/common/useVirtualWindow.ts` + 接入 `ExportView.tsx` / `ForeignImportView.tsx` / `LibraryPanel.tsx`<br>- **动路由**：否<br>- **动 `DESIGN.md`**：小幅补充（在 `DESIGN.md` 记录虚拟列表行高与整行勾选交互规范） |
| **#6** | **前后端版本失配显式检测横幅（`hostOutdated`）** | **对手**：`minghuo/dsh-github-sync`（`hostSupportsApi`，`client/index.js:211, 1348-1351`）。<br>**做法**：当插件热更新或 npm 升级后用户仅刷新了浏览器而未重启 `dsh web` 导致 host/client 版本号不一致时，顶栏展示明确提示「宿主进程仍运行旧版代码，请重启 DSH 生效」，避免报出晦涩的 404/400 错误。 | - **改动层**：`src/client/ConfigManagerSection.tsx` 比对 `/about` 或 `/status` 返回的 `pluginVersion` 与前端编译期常量<br>- **动路由**：否<br>- **动 `DESIGN.md`**：否 |
| **#7（高价值但跨层）** | **补齐恢复前备份（`preRestoreDir`）的 UI 一键回退出口（修 `BK-01`）与删除 Profile 前自动快照（修 `PW-01`）** | **对手**：`xiaoyuyu6420/dsh-backup`（恢复前自动生成 `dsh-pre-restore-<ts>` 标准快照入库，随时可从列表还原，`lib/index.js:2082-2085`）。<br>**做法**：① 在 `RecoveryPanel` 或 `LibraryPanel` 暴露 `preRestoreDir` 的「撤销上次恢复」入口；② 删除 Profile 前自动拍一份轻量归档或提供「备份后再删」默认勾选项。 | - **改动层**：`src/core/restore.ts` + `src/routes/` + `src/client/recovery/RecoveryPanel.tsx` + `src/client/environment/EnvironmentPanel.tsx`<br>- **动路由**：**是**（需新增或扩展恢复前备份查询/还原端点）<br>- **动 `DESIGN.md`**：否 |

---

### 5.3 【存疑】（当前缺乏充分证据，需补齐实测后再裁定）

1. **是否应将「外部 Agent 导入（`ForeignImportView`）」或「配置管理快捷入口」像 `dsh-chat-import` 一样挂进宿主左侧栏底栏（`sidebar.footer.action`）与右侧栏（`sidebar.right.pane.tab`）？**
   - **缺什么证据**：`dsh-chat-import` 之所以挂左侧栏底栏 + 右侧栏极受欢迎，是因为它的用户 100% 冲着「找会话续聊」而来；而 `dsh-config-manager` 是低频系统级配置/备份工具，若常驻抢占 `sidebar.footer.action`（280px 窄侧栏底栏），可能与其他插件（如 Token 统计、远程访问）争抢宝贵的底栏槽位。
   - **如何补齐证据**：需在真机环境下同时挂载 `dsh-chat-import`、`dsh-web-all` 等热门插件，实测 `sidebar.footer.action` 多插件并存时的折行与挤压表现，并统计用户触发外部导入 vs 常规备份的真实频次比。
2. **云同步的 JSON/YAML 冲突裁决是否应从当前的「叶级 Radio 表单（`MergeModal`）」改为或增加「左右并排可编辑文本 Diff 视图（如 VS Code Settings Sync）」？**
   - **缺什么证据**：VS Code 拥有内置的重量级 Monaco Editor 支撑语法高亮与实时 JSON Schema 校验；而本仓受限于「零第三方重型 UI/编辑器依赖」（`AGENTS.md` 硬约束）且运行在 `564×720` 窄画布中，若用纯 `<textarea>` 让用户手改 `cordis.patch.yml`（含 `!!js` 方言标签），极易因缩进或引号错误把配置文件改坏。
   - **如何补齐证据**：需收集真实用户在多机同步冲突时遇到「叶级 Radio 无法满足合并需求（例如需要手动拼接两个数组）」的真实案例占比，并评估在不引入第三方编辑器库的前提下，只读并排 Diff（如 `dsh-checkpoint-rewind` 的 `.dcr-ss-row`）是否已足够辅助决策。
3. **外部会话扫描接口（`/foreign/sources`）在超大规模本地历史（>5,000 个 Claude Code / Cursor 会话）下的真实首字节延迟（TTFB）**
   - **缺什么证据**：我们在代码层面证实了 `Nwflower/dsh-chat-import` 采用了 `after` 游标流式扫描而本仓采用单次请求返回，但尚未在同一台含 5,000+ 历史会话的基准机器上对比两者的实际耗时曲线。
   - **如何补齐证据**：构造含 5,000 个跨 Agent 会话样本的基准测试目录，实测本仓 `/foreign/sources` 的响应耗时是否触及前端超时上限，再决定是否将后端路由改造为游标流式接口。
