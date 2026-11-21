<!-- deep-ptc:project-cards v1 next=R4,F3,Q1 -->
# Project cards

> Maintained by Deep PTC in DeepSeek Harness: edit in a Deep PTC conversation, view 特点卡片 / Project cards.
> User-approved settings guide this project. Features and requirements are records that can be checked and corrected.

## 下一段主线（代码侧已无待修 issue）
<!-- card id=issue kind=setting category=product rev=1 updated=2026-11-21T13:17:22.629Z -->

- **R1** 先做管理收口：11 条带 fixed 的 issue 逐条回「已在 v0.10.0 修复」并关闭，走 issue-intake-response；本轮不写代码。
- **R2** 主线接 #142：retention 增加年龄档（保留最近 N 天全部，再按 GFS 稀释），与现有 keepLast/月度/年度并存。
- **R3** 验收：retention-policy 单测 + 远端快照 prune 与自动备份导出两处同口径生效，默认值不变。


## Implemented features / 已实现功能
<!-- card id=features kind=features rev=1 updated=2026-11-21T13:55:46.017Z -->

- **F1** v0.11.0（2026-11-21）已发布：保留策略新增 keepDays 年龄档，默认 0=关闭、缺省行为与改造前逐字节一致；远端快照 prune 与定时备份清理同用 selectPruneCandidatesByPolicy；#142 已回版本号并关闭。
- **F2** v0.11.0 已修 #149：心跳原子写 5 次退避重试；写/删失败只记日志不抛（20s 后下次心跳自愈）；启动首扫清理 1 小时前 .dshcm.*.tmp；新增三条回归测试（issue 保持 open + fixed，等报告者确认）。
