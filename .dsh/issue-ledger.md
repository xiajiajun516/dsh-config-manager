<!-- repo: xiajiajun516/dsh-config-manager —— 本文件的 gh 命令统一带 --repo 这段 -->
# Issue 回复清单

> 一行一条 issue。状态定义与用法见 skill `issue-intake-response`；发版时清空 `awaiting-release`。
> 只记需要「回版本号」的 issue；`done` 行保留用于追溯，不再每次发版重扫。

| issue | 症状 | 状态 | 修复提交 | 版本 | 更新 |
|---|---|---|---|---|---|
| 117 | 「使用 GitHub 登录」授权是整个账号，无法收窄到单仓库（真收窄被 #118 判 NOT_PLANNED；v0.1.85 只发了授权范围说明 + 细粒度 PAT 引导，故仍 open 等报告者接受说明） | open | 62049df | v0.1.85 | 2026-10-28 |
| 116 | 新建空仓库第一次一键同步就报「同步失败：远端无快照」 | done | 62049df | v0.1.85 | 2026-10-27 |
| 115 | 细粒度 PAT 没勾 Contents，同步只甩 git 原始 403 | done | 62049df | v0.1.85 | 2026-10-27 |
| 109 | 阿里云 OSS 同步 SigV4 签名不匹配（规范路径缺 bucket） | done | bf1642f | v0.1.82 | 2026-10-23 |
| 118 | 用 GitHub App（installation token）把授权收窄到单仓库 | dropped | — | — | 2026-10-27 |

## 说明

- `v0.1.85` 三行的证据：`62049df` 已在 `v0.1.85` 的祖先里（`git merge-base --is-ancestor 62049df v0.1.85` = 0）；
  CHANGELOG `[0.1.85]` 段有对应行为描述但**没有** `（issue #117）` 这类标注 —— 所以对账靠 commit 祖先关系，不靠 changelog 文字。
- `109` 已在 `v0.1.82` 回复并要求报告者复测；issue 仍未关闭是等对方确认，不是欠回复。
- 收到新 issue 时追加 `open` 行；修完后 `修复提交` 填 `git log -1 --format=%h` 的值。
- `v0.1.85` 收尾（2026-10-27）：115/116 已回版本号 + 加 `fixed` + **重新打开**（按 skill「不替报告者关」）等对方确认；117 回了版本号但没加 `fixed`（scope 没真收窄），保持 `open`。
- `118` 判 `dropped`（NOT_PLANNED）：理由与三条重开条件写在 issue 关闭评论里；若「多个用户拒绝建 PAT」「需要组织内多仓自动化」「GitHub 限制 PAT」任一成立即重开。
- `2026-10-28` #117 追问「有没有 GitHub repo/gist 之外的存储、让 OAuth 权限最小」已在 issue 回复（comment 6479732607：GitHub 只有 repo/gist 两种存储面、gist 的细粒度 PAT 不支持只能经典 `gist` scope、单仓最小权限 = 细粒度 PAT、真最小权限走 WebDAV/S3 兼容通道的目录或桶前缀）；状态仍 `open`，等报告者接受说明，未加 `fixed`。
