<!-- repo: xiajiajun516/dsh-config-manager —— 本文件的 gh 命令统一带 --repo 这段 -->
# Issue 回复清单

> 一行一条 issue。状态定义与用法见 skill `issue-intake-response`；发版时清空 `awaiting-release`。
> 只记需要「回版本号」的 issue；`done` 行保留用于追溯，不再每次发版重扫。

| issue | 症状 | 状态 | 修复提交 | 版本 | 更新 |
|---|---|---|---|---|---|
| 117 | 「使用 GitHub 登录」授权是整个账号，无法收窄到单仓库 | awaiting-reply | 62049df | v0.1.85 | 2026-10-27 |
| 116 | 新建空仓库第一次一键同步就报「同步失败：远端无快照」 | awaiting-reply | 62049df | v0.1.85 | 2026-10-27 |
| 115 | 细粒度 PAT 没勾 Contents，同步只甩 git 原始 403 | awaiting-reply | 62049df | v0.1.85 | 2026-10-27 |
| 109 | 阿里云 OSS 同步 SigV4 签名不匹配（规范路径缺 bucket） | done | bf1642f | v0.1.82 | 2026-10-23 |

## 说明

- `v0.1.85` 三行的证据：`62049df` 已在 `v0.1.85` 的祖先里（`git merge-base --is-ancestor 62049df v0.1.85` = 0）；
  CHANGELOG `[0.1.85]` 段有对应行为描述但**没有** `（issue #117）` 这类标注 —— 所以对账靠 commit 祖先关系，不靠 changelog 文字。
- `109` 已在 `v0.1.82` 回复并要求报告者复测；issue 仍未关闭是等对方确认，不是欠回复。
- 收到新 issue 时追加 `open` 行；修完后 `修复提交` 填 `git log -1 --format=%h` 的值。
