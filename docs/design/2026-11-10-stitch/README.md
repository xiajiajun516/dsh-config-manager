# DSH Config Manager — UI v4 探索稿（Stitch，2026-11-10）

用 Google Stitch 生成的一套**界面探索稿**，目的是给 UI v4 重构找方向，不是现状还原，也不是可直接落地的规范。
权威规范仍是 [DESIGN.md](../../../DESIGN.md)（UI v3，2026-10-06）；本目录只提供「长什么样」的参考，落地时一切数值以 DESIGN.md 为准。

- Stitch 项目：`projects/3562749276376933419`（标题「DSH Config Manager — UI v4 探索」，PROJECT_DESIGN，DESKTOP）
- 画布口径：1440×900 稿面，内含 800×800 宿主设置弹窗，插件内容区 564×720（与 DESIGN.md §画布一致）
- 9 屏：首页 / 产物库 / 同步 / 环境·档案 / 环境·维护与诊断 / ⌘K 命令面板 / 恢复计划弹窗 / 导出备份流程 / 导入备份流程
- 只做亮色；暗色未覆盖

## 文件

| 屏 | 截图 | HTML |
| --- | --- | --- |
| 01 首页 | [01-home.png](png/01-home.png) | [01-home.html](html/01-home.html) |
| 02 产物库 | [02-library.png](png/02-library.png) | [02-library.html](html/02-library.html) |
| 03 同步 | [03-sync.png](png/03-sync.png) | [03-sync.html](html/03-sync.html) |
| 04 环境·档案 | [04-env-profiles.png](png/04-env-profiles.png) | [04-env-profiles.html](html/04-env-profiles.html) |
| 05 环境·维护与诊断 | [05-env-maintenance.png](png/05-env-maintenance.png) | [05-env-maintenance.html](html/05-env-maintenance.html) |
| 06 ⌘K 命令面板 | [06-command-palette.png](png/06-command-palette.png) | [06-command-palette.html](html/06-command-palette.html) |
| 07 恢复计划弹窗 | [07-restore-plan.png](png/07-restore-plan.png) | [07-restore-plan.html](html/07-restore-plan.html) |
| 08 导出备份流程 | [08-export.png](png/08-export.png) | [08-export.html](html/08-export.html) |
| 09 导入备份流程 | [09-import.png](png/09-import.png) | [09-import.html](html/09-import.html) |

HTML 是 Stitch 导出的单文件静态稿（内联样式、无 JS），只能看结构，**不要**当实现基线抄进 `config-manager.module.css`。
色板与尺度见 [tokens.md](tokens.md)（取自真实 DSH 主题变量，不是 Stitch 自选色）。

## 设计稿 ↔ 真实实现 对照

真实实现位置以仓库现状为准；「设计稿变化」列写的是这一稿相对 v3 的探索性改动。

### 01 首页

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 顶部状态行（备份文件 / 安全快照 / 定时备份 / 远程同步） | `src/client/home/HomePanel.tsx` 状态行；指标模型 `src/ui/overview-view.ts` 的 `buildOverviewMetrics` | 无（段可点击直达的行为沿用） |
| 动作工具栏（新建备份 / 导出 ZIP / 导入 / 从其他 agent 导入 / 一键同步） | `HomePanel.tsx` 动作工具栏 | 与真实 5 个动作一一对应（真实文案「立即备份 / 手动导出 / 导入 / 从其它 agent 导入 / 一键同步」）；主按钮文案稿为「新建备份」，真实为「立即备份」 |
| 最近活动表（时间 / 类型 / 详情 / 结果，吃满剩余高度、自身内滚） | `overviewActivity()` + `SkeletonActivityRows` | 行数按画布填满（14 行），结果列改成状态点 + 「待处理」橙徽章 |
| （未画）定时备份设置卡 | `src/client/home/BackupScheduleCard.tsx` | v3 已收进弹窗，首页不常驻 |
| 底部状态栏（就绪 / 进度 / v0.7.0 · DSH 2.4） | `src/client/ConfigManagerSection.tsx` 状态栏 + `common/ProgressBar.tsx` | 无 |

### 02 产物库

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 源筛选 Segmented（全部 / 本机快照 / 备份文件 / 远端快照 / 市场产物） | `src/client/library/LibraryPanel.tsx` + `countByKind`（`src/ui/artifact-view.ts`） | 计数从段内小字挪到段后数字 |
| 混合平铺列表（来源芯片 + 标题 + 大小/事实 + 时间） | `src/client/library/ArtifactRow.tsx`，行模型 `toArtifactRows()` | 四源芯片改为彩色描边芯片（灰/蓝/紫/绿），便于扫读来源 |
| 行展开详情（路径 / 分区 / SHA-256 + 恢复 / 导入 / 删除） | `src/client/library/ArtifactDetail.tsx` + `LibraryActions.tsx` | 动作收到详情区右侧一行，减少行内按钮噪音 |
| 贴底底栏（共 12 项 · 逛市场 · 发布到市场） | `LibraryPanel.tsx` 底栏 | 无 |

### 03 同步

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 四张通道卡（Git / WebDAV / S3 / GitHub Gist） | `src/client/sync/SyncPanel.tsx` 的 `renderChannelCard('git' \| 'webdav' \| 's3' \| 'gist')` + `SyncChannelEntryCard.tsx` | 稿里四卡统一紧凑高度（≈108px）；真实未配置通道是**矮态 ≈56px**（只有名称 + 未配置徽章 + [配置]），已配置卡约 176px |
| 自动同步行（已开启 · 每 30 分钟） | `src/client/sync/AutosyncCard.tsx` | 压成通道卡里的一行 |
| 同步记录卡（5 行，结果列） | `src/client/sync/SyncLogList.tsx`（本页只有操作日志） | 稿里改名为「同步记录」并补「成功 / 跳过 / 冲突已中止」结果列；真实为纯日志列表 |
| （未画）通道配置弹窗 / 加密与解密 / 一键同步差异确认 | `ChannelConfigDialog.tsx` / `SecurityOptionsCard.tsx` / `DecryptPasswordCard.tsx` / `SyncConfirmView.tsx` | 本轮未覆盖 |

### 04 环境·档案

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 子视图 Segmented（档案 / 维护与诊断） | `src/client/environment/EnvironmentPanel.tsx`（`ProfilesPanel` / `RecoveryPanel`） | 无 |
| 本机概况 2×2（DSH 版本 / 数据目录 / 已装插件 / 磁盘占用） | 无对应组件（数据分散在首页状态行与维护子视图） | **稿新增**，把「这台机器现在是什么状态」抬到档案页首屏 |
| 档案列表（名称 + 运行态徽章 + 数据目录 + 启动 / 复制 / 删除） | `EnvironmentPanel.tsx` 档案行；判定 `src/ui/dsh-profiles-view.ts`（`profileRowAction` / `profileRowCapabilities`） | 行内事实从「形态 / bundle 层 / 依赖数 / patch 条目 / node_modules / 更新时间」压成「状态 + 路径」，其余进详情 |
| 数据目录卡（sessions / exports / snapshots + 最近活动） | 无对应组件（`DiskUsageCard` 在维护子视图） | **稿新增**，作为档案卡下方的高度填充与上下文 |

### 05 环境·维护与诊断

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 崩溃归因条（上次会话异常结束 + 查看详情） | `src/client/recovery/RecoveryPanel.tsx` 的 crash 区（`recovery/incident-api.ts` 的 `CrashReport`） | 抽成一条通栏 tint 条，常驻页首 |
| 待处理事项（残留锁 / 恢复事项 + 行内动作） | `RecoveryPanel.tsx` + `recovery/IncompleteCopiesSection.tsx` | 压成两行清单 + 徽章计数 |
| 救援模式（已关闭 / 进入救援模式） | `recovery/use-recovery-write.ts` + `RescueStatus` | 独立成卡，说明压到一行 |
| 会话体检（会话 128 · 异常 2 + 运行体检） | `recovery/SessionHealthCard.tsx` + `SessionHealthDialog.tsx` | 无 |
| 工作区 + 会话回滚（6 个回滚点 + 查看台账） | `recovery/RollbackCard.tsx` + `RollbackFileChanges.tsx` | 无 |
| 磁盘占用（固定高 140px、卡内自滚、5 行 + 占比条） | `src/client/environment/maintenance/DiskUsageCard.tsx` + `src/ui/disk-usage-view.ts` | 补了 2px 占比条 |

### 06 ⌘K 命令面板

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 搜索行 + esc 键帽 | `src/client/common/CommandPalette.tsx`（Radix Dialog，Portal 到 `#dsh-config-manager-root`） | 键帽为稿新增 |
| 分组（导航 / 备份 / 同步 / 维护） | `src/ui/commands.ts`（21 条命令）+ `COMMAND_GROUP_ORDER` | 分组名以真实 `COMMAND_GROUP_ORDER` 为准，稿里只做示例 |
| 右侧快捷键提示（⌘1–⌘4） | 无 | **稿新增**；落地前需先在 `commands.ts` 定义，否则不要画 |
| 底部提示行（↑↓ 选择 · ↵ 执行 · esc 关闭） | `CommandPalette.tsx` 现有提示 | 无 |

### 07 恢复计划弹窗

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 摘要条（将被还原 / 新增 / 删除 / 卸载插件 / 需人工处理 / 无动作 + 「+312 −47」） | `src/client/library/RestorePlanView.tsx` 摘要条（模型 `src/ui/restore-plan-view.ts`） | 无 |
| 分组清单（变更 → 删除 → 插件 → 人工 → 无动作；跳过默认折叠） | 同上 + `toRestorePlanView()` | 组头带计数与合计行数 |
| 行展开双栏 diff（左当前 / 右快照，行高 20px，块头 `@@ -12,7 +12,9 @@`） | `src/client/common/DiffTable.tsx` + `src/ui/diff-view.ts` | 无（沿用 git 风格） |
| 弹窗容器 | `src/client/common/Modal.tsx`（`.dialogCard` / `.dialogWide`） | 稿里 620px，超过 `.dialogCard` 的 `min(600px, …)`；落地建议直接用 `.dialogWide`（`min(720px, …)`） |

### 08 导出备份流程（Task 面板）

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 面板外壳（← 返回首页 / 标题 / 右侧徽章 / 贴底按钮行） | `src/client/task/TaskShell.tsx`（全宽覆盖 `.shellContent`，导航条与状态栏保留可见） | 无 |
| 选择条（已选分区 · 文件数 · 体积 + 「选择要导出的内容」） | `src/client/export/ExportView.tsx` 工具栏 + `pickerSummary`（`src/ui/selection-model.ts`）；选择器 `common/ContentPicker.tsx` | 选择结果压成一条 32px 选择条，入口收成右侧 ghost 按钮 |
| 安全选项（加密备份 / 导出密钥 + 密码双列） | `ExportView.tsx` 安全选项分组（AES-256-GCM；includeSecrets ⇒ encrypt 联动） | 密码双列内联展示 + 一行「只存在内存」提示；稿里勾选加密态 |
| 文件与备注（文件名 + 备注双列） | `ExportView.tsx` 命名行（`normalizeExportFileName` 自动补 `.zip`） | 无 |
| 进度块（进度条 + 当前阶段 + 正在收集的分区） | `ExportView.tsx` 进度条 + `common/ProgressBar.tsx` | 补了「正在收集 sessions（742 MB）」这一行阶段说明 |
| 页尾「本次将导出」构成卡（吃满剩余高度、卡内滚动） | `ExportView.tsx` 的 `Card.fillViewport` + `common/SectionComposition.tsx` | 每行右侧补「文件数 · 体积」 |
| （未画）结果报告 / 自动下载提示 / 选择器弹窗 | `ExportView.tsx` 结果区 + `ContentPicker.tsx` | 本轮未覆盖 |

### 09 导入备份流程（Task 面板，第 3/9 步）

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 面板头（← 返回首页 / 标题 / 第 N/9 步） | `src/client/task/TaskShell.tsx` | 步数指示从 Stepper 右侧挪到标题右侧 |
| 9 步步骤条（选文件 → 分析 → 兼容性 → 预览 → 冲突 → 路径映射 → 凭据 → 确认 → 结果） | `src/ui/import-stepper.ts` 的 `importStepperModel` / `importStepperSource`，渲染于 `ImportWizardView.tsx` | 横向圆点式步骤条；可能跳过的三步（冲突 / 路径映射 / 凭据）显示为灰色 |
| 文件卡（文件名 · 体积 · 来源） | `ImportWizardView.tsx` 选文件结果 + `api.upload` 回执 | 压成一行卡 |
| 兼容性卡（评分徽章 + 4 项检查 + 说明） | `src/ui/import-wizard.ts` 的 `compatibilityLevel` / `compatibilityNotes` / `compatibilityBadgeKind`，文案 `common/compat-label.ts` | 四项检查各带「通过 / 提示」徽章 |
| 预览卡「将写入的内容」（9 行分区，卡内滚动） | `ImportWizardView.tsx` 预览阶段 + `sectionsFromPlan` | 行右侧「文件数 / 体积」 |
| （未画）冲突裁决 / 路径映射 / 凭据补录 / 确认 / 结果 | `common/ConflictList.tsx` / `import/PathMappingForm.tsx` / 凭据补录 / 确认页 / `common/ReportView.tsx` | 本轮未覆盖 |

## 与 DESIGN.md 的偏差（落地前必须消解）

1. **外壳是示意**：稿里的 macOS 红绿灯、居中「设置」标题、左侧 6 项宿主导航都属宿主设置弹窗，不归本插件；插件只负责右侧 564×720 内容区。
2. **字体**：Stitch 输出用 Inter 代替系统栈（`-apple-system / Segoe UI / PingFang SC`），只作观感示意；真实字号仍只有 11 / 12 / 12.5 / 13 四档，稿面未逐像素核对（**未验证**）。
3. **新增卡**：环境·档案的「本机概况」「数据目录」两张卡在真实实现里没有对应组件，属探索性结构提案。
4. **同步页密度**：四卡统一 108px 与真实「未配置矮态 56px」不一致；若采纳需同步改 `SyncChannelEntryCard` 与 DESIGN.md §同步。
5. **文案**：首页主按钮「新建备份」与真实「立即备份」不同；命令面板快捷键提示尚未在 `src/ui/commands.ts` 定义。
6. **导出/导入面板**：真实 `ExportView` 的工具栏是「选择要导出的内容 + 开始导出」，稿把「开始导出」放到贴底按钮行、把选择入口收成选择条右侧按钮；`ImportWizardView` 真实 Stepper 是分组式的（`importStepperSource`），稿画成 9 点平铺，落地前需先确认步数展示口径。
7. **只覆盖亮色**：暗色主题、错误 / 空 / 骨架态、超长文案截断、导入向导、导出流程、市场、任务面板、通道配置弹窗均未覆盖。

## 复现与迭代

- 项目地址：`https://stitch.withgoogle.com`（项目 `3562749276376933419`）
- 生成方式：每屏 prompt = 「外壳 + 视觉规范」固定块 + 该屏结构描述；设计规范没有做成 Stitch design-system 对象（`create_design_system` 对该项目持续返回 invalid argument），所以规范随 prompt 内联。
- `edit_screens` 会**新建**一屏而不是原地改，因此下面的旧 id 已废弃，以新 id 为准：

| 屏 | 首版 screen id | 修版 screen id |
| --- | --- | --- |
| 01 首页 | `3f9a17ad1ac74405a742605a64ef51ae` | `019e50be3733499ebe8d4679381a911a`（工具栏二次修正） |
| 02 产物库 | `e272c6f0b718409ea2380925258dc518` | —（未修） |
| 03 同步 | `33ecb4ab6d944ed79d35ce8bb61e2e96` | `9ac2b7e4c5fb4510b227b0778e279f8e` |
| 04 环境·档案 | `7d7a521fe2cf4f1eb3a158c97794c2c5` | `c6a908356cac4596a11a2885f2b13c93` |
| 05 环境·维护 | `4bb52983a9264e898731c5ea1e3c2888` | —（未修） |
| 06 命令面板 | `06437178a2a8441c861c43b127c24206` | —（未修） |
| 07 恢复计划 | `3e100b41ee984f539bdf972ee5bc410d` | `001a42d9f5ee4573ae6e44242112744d` |
| 08 导出备份 | `adbbfddf40ce428fb0b9c60435a4bcb0` | `1399e668639c47458262e19cc13d505b` |
| 09 导入备份 | `45d7ff837913450aa2681b7a8974cd76` | `3ec37327e9be4267b6978247aa6324a7` |

- 项目里另有一屏 `595702238658715519`（780×1768，DESIGN.md 上传渲染产物），与设计稿无关，忽略即可。
- 修版修的缺陷：首页活动表填满高度、同步页卡内空白与第四卡裁切、档案页大片空区、恢复弹窗折叠行被按钮行压住、首页工具栏（删掉产品里没有的「恢复快照」，补回「从其他 agent 导入」与「一键同步」）、导入面板页签高亮与左侧导航噪音。
