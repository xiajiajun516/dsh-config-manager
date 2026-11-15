<!-- repo: xiajiajun516/dsh-config-manager —— 本文件的 gh 命令统一带 --repo 这段 -->
# Issue 回复队列

> 只记**还欠一条回复**的 issue；回完就删行 —— 历史在 issue 评论与 `git log -p -- .dsh/issue-ledger.md`。
> 处理状态在 issue 标签上（词汇见 `docs/agents/triage-labels.md`），本文件只记两个状态；用法见 skill `issue-intake-response`。

| issue | 症状 | 状态 | 修复提交 | 更新 |
|---|---|---|---|---|
| 143 | 保留策略埋在「定时备份 → Schedule」里、读起来只讲备份，实际也裁剪快照 | awaiting-release | cec19de | 2026-11-14 |
| 145 | 插件分区「有改动就整段冲突」：合并被删除开关卡住 + 导出侧脱敏让 sameShell 恒假 | awaiting-release | d963f39 | 2026-11-15 |
