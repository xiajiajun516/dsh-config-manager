<!-- deep-ptc:project-cards v1 next=R4,F4,Q1 -->
# Project cards

> Maintained by Deep PTC in DeepSeek Harness: edit in a Deep PTC conversation, view 特点卡片 / Project cards.
> User-approved settings guide this project. Features and requirements are records that can be checked and corrected.




## 已实现功能
<!-- card id=features kind=features rev=3 updated=2026-11-21T21:38:01.943Z -->

- **F1** v0.11.0（2026-11-21）已发布：保留策略新增 keepDays 年龄档，默认 0=关闭、缺省行为与改造前逐字节一致；远端快照 prune 与定时备份清理同用 selectPruneCandidatesByPolicy。#142 已回版本号，issue 保持 open 由报告者关闭（曾误关已重开）；已向其说明「先答应 review 他的 PR、后自行发版」的时间线与偏差（命名 keepDays≠keepWithinDays；全 0 语义仍只在 src/sync/backup-files.ts:270，远端侧未统一）。
- **F2** v0.11.0 已修 #149：心跳原子写 5 次退避重试；写/删失败只记日志不抛（20s 后下次心跳自愈）；启动首扫清理 1 小时前 .dshcm.*.tmp；新增三条回归测试（issue 保持 open + fixed，等报告者确认）。
- **F3** 导出/导入选择器（0.12.0 未发布，本地提交 1d5903e）：对话行可展开为「子代理会话」「附件」两组，组行缩进一级并可整组勾选（部分选中显示 indeterminate）；勾子行连带勾父对话、取消不反向。附件显示真实文件名（日志无 name 时退回 mediaType，实测 463/600 有真名）。导入侧由包内 sessions 日志还原归属，孤儿附件单独一行才可取消；「全选」经批量联动自动带上被引用附件。源码：src/adapters/attachments.ts、src/client/common/ContentPicker.tsx、src/ui/selection-model.ts、src/core/session-meta.ts。
