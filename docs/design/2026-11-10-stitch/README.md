# DSH Config Manager — UI v4 探索稿（Stitch，2026-11-10）

用 Google Stitch 生成的一套**界面探索稿**，目的是给 UI v4 重构找方向，不是现状还原，也不是可直接落地的规范。
权威规范仍是 [DESIGN.md](../../../DESIGN.md)（UI v3，2026-10-06）；本目录只提供「长什么样」的参考，落地时一切数值以 DESIGN.md 为准。

- Stitch 项目：`projects/3562749276376933419`（标题「DSH Config Manager — UI v4 探索」，PROJECT_DESIGN，DESKTOP）
- 画布口径：1440×900 稿面，内含 800×800 宿主设置弹窗，插件内容区 564×720（与 DESIGN.md §画布一致）
- 7 屏：首页 / 产物库 / 同步 / 环境·档案 / 环境·维护与诊断 / ⌘K 命令面板 / 恢复计划弹窗
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

HTML 是 Stitch 导出的单文件静态稿（内联样式、无 JS），只能看结构，**不要**当实现基线抄进 `config-manager.module.css`。
色板与尺度见 [tokens.md](tokens.md)（取自真实 DSH 主题变量，不是 Stitch 自选色）。

## 设计稿 ↔ 真实实现 对照

真实实现位置以仓库现状为准；「设计稿变化」列写的是这一稿相对 v3 的探索性改动。

### 01 首页

| 设计稿区域 | 真实实现 | 设计稿变化 |
| --- | --- | --- |
| 顶部状态行（备份文件 / 安全快照 / 定时备份 / 远程同步） | `src/client/home/HomePanel.tsx` 状态行；指标模型 `src/ui/overview-view.ts` 的 `buildOverviewMetrics` | 无（段可点击直达的行为沿用） |
| 动作工具栏（新建备份 / 导出 ZIP / 导入 / 恢复快照） | `HomePanel.tsx` 动作工具栏 | 真实为 5 个动作（含「从其它 agent 导入」与「一键同步」），稿里收敛成 4 个 + 右侧「活动」入口；主按钮文案稿为「新建备份」，真实为「立即备份」 |
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

## 与 DESIGN.md 的偏差（落地前必须消解）

1. **外壳是示意**：稿里的 macOS 红绿灯、居中「设置」标题、左侧 6 项宿主导航都属宿主设置弹窗，不归本插件；插件只负责右侧 564×720 内容区。
2. **字体**：Stitch 输出用 Inter 代替系统栈（`-apple-system / Segoe UI / PingFang SC`），只作观感示意；真实字号仍只有 11 / 12 / 12.5 / 13 四档，稿面未逐像素核对（**未验证**）。
3. **新增卡**：环境·档案的「本机概况」「数据目录」两张卡在真实实现里没有对应组件，属探索性结构提案。
4. **同步页密度**：四卡统一 108px 与真实「未配置矮态 56px」不一致；若采纳需同步改 `SyncChannelEntryCard` 与 DESIGN.md §同步。
5. **文案**：首页主按钮「新建备份」与真实「立即备份」不同；命令面板快捷键提示尚未在 `src/ui/commands.ts` 定义。
6. **只覆盖亮色**：暗色主题、错误 / 空 / 骨架态、超长文案截断、导入向导、导出流程、市场、任务面板、通道配置弹窗均未覆盖。

## 复现与迭代

- 项目地址：`https://stitch.withgoogle.com`（项目 `3562749276376933419`）
- 生成方式：每屏 prompt = 「外壳 + 视觉规范」固定块 + 该屏结构描述；设计规范没有做成 Stitch design-system 对象（`create_design_system` 对该项目持续返回 invalid argument），所以规范随 prompt 内联。
- `edit_screens` 会**新建**一屏而不是原地改，因此下面的旧 id 已废弃，以新 id 为准：

| 屏 | 首版 screen id | 修版 screen id |
| --- | --- | --- |
| 01 首页 | `3f9a17ad1ac74405a742605a64ef51ae` | `babdf10f3cab4f44aee71818710210de` |
| 02 产物库 | `e272c6f0b718409ea2380925258dc518` | —（未修） |
| 03 同步 | `33ecb4ab6d944ed79d35ce8bb61e2e96` | `9ac2b7e4c5fb4510b227b0778e279f8e` |
| 04 环境·档案 | `7d7a521fe2cf4f1eb3a158c97794c2c5` | `c6a908356cac4596a11a2885f2b13c93` |
| 05 环境·维护 | `4bb52983a9264e898731c5ea1e3c2888` | —（未修） |
| 06 命令面板 | `06437178a2a8441c861c43b127c24206` | —（未修） |
| 07 恢复计划 | `3e100b41ee984f539bdf972ee5bc410d` | `001a42d9f5ee4573ae6e44242112744d` |

- 项目里另有一屏 `595702238658715519`（780×1768，DESIGN.md 上传渲染产物），与设计稿无关，忽略即可。
- 修版只修了 4 处明确缺陷：首页活动表填满高度、同步页卡内空白与第四卡裁切、档案页大片空区、恢复弹窗折叠行被按钮行压住。
