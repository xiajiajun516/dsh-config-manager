# 页面 / 面板 / 弹窗清单（阶段 A 产物）

> 来源：读 `src/client/**` 全量枚举（2026-11-10）。**以代码为准**，不凭记忆。
> 画布：564×720（宿主设置弹窗 800×800 内）。样式唯一权威 `DESIGN.md`。
> status：todo · stitching · reviewing · revising · done · blocked

## 0. 容器概念（只有两种）

| 概念 | 实现 | 说明 |
| --- | --- | --- |
| 页面（PanelId） | `ConfigManagerSection.tsx` `NAV_ITEMS` | 4 个一级页：home / library / sync / environment |
| 流程面板（TaskState.kind） | `task/TaskShell.tsx` + `run-store.ts` task | 全宽覆盖 `.shellContent`；导航条/横幅/状态栏保留；`escToClose` 仅只读视图 |
| 弹窗 | `common/Modal.tsx`（Radix）+ `common/ConfirmDialog.tsx` | Portal 必须指回 `#dsh-config-manager-root` |

## 1. 页面（P）

| id | 标题 | 源码 | 打开入口 | 父 | status | Stitch screen | 修订轮 | 未决缺陷 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-01 | 首页 | `src/client/home/HomePanel.tsx` | 导航「首页」（默认页） | — | revising | `37e943074bd74b1980e25294008c1ff6` | 1 | D-1..D-15（已核实，待重生成） |
| P-02 | 产物库 | `src/client/library/LibraryPanel.tsx` | 导航「产物库」 | — | revising | `975cca8d4e2b4a46b2513934128d1d9a` | 1 | D-1 画布未铺满、D-2 分区截断 |
| P-03 | 同步 | `src/client/sync/SyncPanel.tsx` | 导航「同步」 | — | todo | | 0 | |
| P-04 | 环境·档案 | `src/client/environment/EnvironmentPanel.tsx`（subView=profiles） | 导航「环境」 | — | todo | | 0 | |
| P-05 | 环境·维护与诊断 | `src/client/recovery/RecoveryPanel.tsx` | 环境页 Segmented「维护与诊断」；⌘K `maintenance.open`；SAFE MODE 横幅按钮 | P-04 | todo | | 0 | |

## 2. 流程面板（T，TaskShell）

| id | 标题 | 源码 | 打开入口 | 父 | status | Stitch screen | 修订轮 | 未决缺陷 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 | 导出备份 | `src/client/export/ExportView.tsx` | 首页「手动导出」；⌘K `export.open` | P-01 | todo | | 0 | |
| T-02 | 导入备份（9 步向导） | `src/client/import/ImportWizardView.tsx` + `import-wizard-steps.tsx` | 首页「导入」；产物库行内「导入」；⌘K `import.open` | P-01 | todo | | 0 | |
| T-03 | 导入·外部 agent 来源选择 | `src/client/import/ForeignImportView.tsx` | 首页「从其它 agent 导入」；⌘K `import.foreign` | P-01 | todo | | 0 | |
| T-04 | 配置市场 | `src/client/market/MarketPanel.tsx` | 产物库底栏「逛市场」；⌘K `market.open` | P-02 | todo | | 0 | |
| T-05 | 市场·我的配置 | `src/client/market/MyConfigsView.tsx` | 市场面板页签「我的配置」；⌘K `market.publish.open` | T-04 | todo | | 0 | |
| T-06 | 活动（运行中心） | `src/client/common/RunsCenter.tsx` | 导航右侧「活动」图标；状态栏「N 个任务进行中」；⌘K `activity.open` | 全局 | todo | | 0 | |
| T-07 | 迁移历史 | `src/client/history/HistoryPanel.tsx` | 导航右侧「历史」图标；⌘K `history.open` | 全局 | todo | | 0 | |
| T-08 | 关于 | `src/client/about/AboutPanel.tsx` | 导航右侧「关于」图标；⌘K `about.open` | 全局 | todo | | 0 | |

## 3. 弹窗（D）

### 3.1 首页（P-01）
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-01 | 定时备份设置 | `home/BackupScheduleCard.tsx`（`HomePanel.tsx:576` Modal） | 状态行「定时备份」指标段 | P-01 | todo |

### 3.2 产物库（P-02）
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-02 | 恢复计划预览（双栏 diff） | `library/RestorePlanView.tsx` + `common/DiffTable.tsx` | 行内「恢复」 | P-02 | todo |
| D-03 | 迁移前咨询 | `library/LibraryActions.tsx:396` | 行内「咨询」 | P-02 | todo |
| D-04 | 从远端拉取/装回本地 | `library/LibraryActions.tsx:428` | 行内「拉取」 | P-02 | todo |
| D-05 | 备份内容查看 + 与此备份 diff | `library/BackupInspectView.tsx`（`LibraryActions.tsx:542`） | 行内「查看」 | P-02 | todo |
| D-06 | 操作报告 | `common/ReportView.tsx`（`LibraryActions.tsx:554`） | 行内动作完成后 | P-02 | todo |
| D-07 | 恢复确认 / 删除确认 | `ConfirmDialog`（`LibraryActions.tsx:504/518`） | 行内「恢复」「删除」 | P-02 | todo |

### 3.3 同步（P-03）
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-08 | 通道配置弹窗（git / webdav 子 tab） | `sync/ChannelConfigDialog.tsx` | 通道卡「配置」 | P-03 | todo |
| D-09 | 清空通道配置确认 | `sync/ChannelClearConfirmDialog.tsx` | 通道卡「清空」 | P-03 | todo |
| D-10 | 一键同步差异确认（逐项裁决） | `sync/SyncConfirmView.tsx`（`SyncPanel.tsx:1551`） | 一键同步后 | P-03 | todo |
| D-11 | 推送预览 | `sync/PushPreviewCard.tsx`（`SyncPanel.tsx:1462`） | 「推送」 | P-03 | todo |
| D-12 | 推送报告 | `common/ReportView.tsx`（`SyncPanel.tsx:1497`） | 推送完成后 | P-03 | todo |
| D-13 | 合并预览与裁决 | `sync/MergeModal.tsx` + `MergePreviewView.tsx` | 「拉取并合并」冲突时 | P-03 | todo |
| D-14 | 同步分区 / 会话选择 | `sync/SyncSectionPickerDialog.tsx`（两种变体） | 通道卡「同步内容」 | P-03 | todo |
| D-15 | 工作副本重新克隆确认 | `sync/WorkDirCard.tsx:137` | 工作副本卡「重新克隆」 | P-03 | todo |

### 3.4 环境·档案（P-04）
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-16 | 档案详情（package.json / patch 原文） | `EnvironmentPanel.tsx:742` | 行内「详情」 | P-04 | todo |
| D-17 | 复制档案确认（含目标名输入） | `EnvironmentPanel.tsx:820` | 行内「复制」 | P-04 | todo |
| D-18 | 停止实例确认 | `EnvironmentPanel.tsx:879` | 运行卡「停止」 | P-04 | todo |
| D-19 | 删除档案确认（物理删除 + 勾选） | `EnvironmentPanel.tsx:896` | 行内「删除」 | P-04 | todo |

### 3.5 环境·维护与诊断（P-05）
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-20 | 恢复执行确认（danger） | `RecoveryPanel.tsx:851` | 恢复流程「执行恢复」 | P-05 | todo |
| D-21 | 恢复重试 / 忽略 / 救援 / SAFE MODE 解除 / 锁回收确认（5 个） | `RecoveryPanel.tsx:866/879/894/906/917` | 各自按钮 | P-05 | todo |
| D-22 | 会话体检 | `recovery/SessionHealthDialog.tsx` | 会话体检卡「查看详情」 | P-05 | todo |
| D-23 | 回滚点·回滚弹窗 | `recovery/RollbackCard.tsx:535` | 回滚点卡「回滚到此处」 | P-05 | todo |
| D-24 | 回滚点·预览弹窗 | `recovery/RollbackCard.tsx:692` | 回滚列表行「预览」 | P-05 | todo |
| D-25 | 回滚点·确认/清理/删除（3 个） | `RollbackCard.tsx:889/903/923` | 各自按钮 | P-05 | todo |
| D-26 | 磁盘清理确认 | `environment/maintenance/DiskUsageCard.tsx:280` | 磁盘占用卡「清理」 | P-05 | todo |

### 3.6 关于（T-08）与全局
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-27 | 版本更新 | `about/PluginUpdateDialog.tsx` | 关于页「检查更新 → 更新」 | T-08 | todo |
| D-28 | 版本更新内容 | `about/ReleaseNotesDialog.tsx` | 升级后首次进入 / 关于页 | T-08 | todo |
| D-29 | Star 引导 | `ConfirmDialog`（`ConfigManagerSection.tsx:739`） | 满 3 天首次进入 | 全局 | todo |
| D-30 | ⌘K 命令面板 | `common/CommandPalette.tsx` | ⌘K / 导航「inspect」图标 | 全局 | todo |
| D-31 | 运行取消确认 | `common/RunsCenter.tsx:307` | 活动卡「取消」 | T-06 | todo |

### 3.7 导出 / 导入 / 市场 内部弹窗
| id | 标题 | 源码 | 打开入口 | 父 | status |
| --- | --- | --- | --- | --- | --- |
| D-32 | 内容选择（分区/条目树） | `common/ContentPicker.tsx`（`ExportView.tsx:471`） | 导出「选择要导出的内容」 | T-01 | todo |
| D-33 | 路径选择器 | `import/PathPickerDialog.tsx` | 导入「路径映射」选择目录 | T-02 | todo |
| D-34 | 市场免责确认（下载 / 发布） | `MarketPanel.tsx:727`、`MyConfigsView.tsx:788` | 市场条目「确认导入」 | T-04 | todo |
| D-35 | 市场导入回滚确认 | `market/MarketImportReview.tsx:410` | 市场导入结果「一键回滚」 | T-04 | todo |
| D-36 | 我的配置·上传/更新向导 | `market/MyConfigsWizard.tsx` | 我的配置「上传」/「更新」 | T-05 | todo |
| D-37 | 我的配置·装回本地向导 | `market/MyConfigsInstall.tsx` | 我的配置「装回本地」 | T-05 | todo |
| D-38 | 我的配置·删除确认 | `MyConfigsView.tsx:807` | 已上传条目「删除」 | T-05 | todo |

## 4. DFS 顺序（阶段 B 执行序）

1. P-01 首页 → D-01 → T-01 导出 → D-32
2. T-02 导入向导（含 D-33）→ T-03 外部来源
3. P-02 产物库 → D-02..D-07 → T-04 市场 → D-34/D-35 → T-05 我的配置 → D-36/D-37/D-38
4. P-03 同步 → D-08..D-15
5. P-04 环境·档案 → D-16..D-19
6. P-05 维护与诊断 → D-20..D-26
7. T-06 活动 → D-31；T-07 历史；T-08 关于 → D-27/D-28
8. 全局：D-29 Star、D-30 ⌘K

## 5. 范围外（记录一次，不生成）

- `src/client/chat/*`（ChatEntryView / RollbackReviewDialog / RollbackDiffTab）：挂在宿主会话流里的接管点，不是设置页内的页面或弹窗；其回滚评审弹窗属「聊天节点内自绘」，与 564×720 画布无关。若后续要覆盖，需单独开一轮。
- `common/MoreMenu`、`Select` 下拉、`InfoHint` 气泡、`ToastViewport`：原语级浮层，不单独出稿，由所属页面稿承载其样式。
