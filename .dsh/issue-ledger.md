<!-- repo: xiajiajun516/dsh-config-manager —— 本文件的 gh 命令统一带 --repo 这段 -->
# Issue 回复清单

> 一行一条 issue。状态定义与用法见 skill `issue-intake-response`；发版时清空 `awaiting-release`。
> 只记需要「回版本号」的 issue；`done` 行保留用于追溯，不再每次发版重扫。

| issue | 症状 | 状态 | 修复提交 | 版本 | 更新 |
|---|---|---|---|---|---|
| 117 | 「使用 GitHub 登录」授权是整个账号，无法收窄到单仓库（真收窄被 #118 判 NOT_PLANNED；v0.1.85 只发了授权范围说明 + 细粒度 PAT 引导，故仍 open 等报告者接受说明） | open | 62049df | v0.1.85 | 2026-10-28 |
| 116 | 新建空仓库第一次一键同步就报「同步失败：远端无快照」 | done | 62049df | v0.1.85 | 2026-10-27 |
| 115 | 细粒度 PAT 没勾 Contents，同步只甩 git 原始 403；报告者已确认修复生效，另提「同步页两个按钮分不清该按哪个」 | done | 62049df | v0.2.0 | 2026-10-29 |
| 109 | 阿里云 OSS 同步 SigV4 签名不匹配（规范路径缺 bucket） | done | bf1642f | v0.1.82 | 2026-10-23 |
| 118 | 用 GitHub App（installation token）把授权收窄到单仓库 | dropped | — | — | 2026-10-27 |
| 119 | 配置一字未改，远端每分钟多 1~2 个 commit（自动同步每轮误判「本地有改动」而真推快照） | done | 39f1208 | v0.2.1 | 2026-10-29 |

- `2026-10-29` **#119 修复 + 发版收尾**：回确认评论（comment 6508108922）+ 加 `confirmed` / `sync`，去 `needs-triage`；
  修复提交 `39f1208`（跳过码进剔除表 + 编译期穷尽断言 + 回归测试），发版提交 `950bfd5`（tag `v0.2.1`）。
  回版本号评论 comment 6508671619 + 加 `fixed`，行转 `done`。对账证据：`git log -1 v0.2.1` = `950bfd5`；Publish 工作流 success（npm publish + GitHub Release 已建）。
  报告者附带的两个观察（同机往返仍报 3 个 Conflict / detail 截断 200 字符、apply-items 的 applied 与 skipped 口径）与本次 bug 无关，需另开 issue。
  仍 `awaiting-release` 的行：0 条。
- `2026-10-29` **v0.2.0 发版收尾**：#115 回版本号评论（issue comment 6483667536）+ 加 `fixed`，行转 `done`。
  对账证据：`git merge-base --is-ancestor 62049df v0.2.0` = 0；`npm view dsh-config-manager@0.2.0 version` = 0.2.0；dist-tags latest = 0.2.0。
  更正：那版行为实际随 `v0.1.86` 发布（CHANGELOG `[0.1.86]` 第 70 行「同步页只强调当前该按的那一个方向」），本行原填的 `v0.1.85` 是错的；回复里如实写成「v0.1.86 首发，当前版本 v0.2.0」。
  仍 `awaiting-release` 的行：0 条。

## 说明

- `v0.1.85` 三行的证据：`62049df` 已在 `v0.1.85` 的祖先里（`git merge-base --is-ancestor 62049df v0.1.85` = 0）；
  CHANGELOG `[0.1.85]` 段有对应行为描述但**没有** `（issue #117）` 这类标注 —— 所以对账靠 commit 祖先关系，不靠 changelog 文字。
- `109` 已在 `v0.1.82` 回复并要求报告者复测；issue 仍未关闭是等对方确认，不是欠回复。
- 收到新 issue 时追加 `open` 行；修完后 `修复提交` 填 `git log -1 --format=%h` 的值。
- `v0.1.85` 收尾（2026-10-27）：115/116 已回版本号 + 加 `fixed` + **重新打开**（按 skill「不替报告者关」）等对方确认；117 回了版本号但没加 `fixed`（scope 没真收窄），保持 `open`。
- `118` 判 `dropped`（NOT_PLANNED）：理由与三条重开条件写在 issue 关闭评论里；若「多个用户拒绝建 PAT」「需要组织内多仓自动化」「GitHub 限制 PAT」任一成立即重开。
- `2026-10-28` #115 报告者回「it worked」并提 UX 建议（不要 push/sync 之分，通道内改成 Export/Import）：已在 issue 用英文回复（comment 6480024127）说明两个词已被一级导航占用、两个方向不对称（同步=先拉再三方合并逐项确认，推送=产生新快照），并把「按远端事实只强调一个方向」实现在 `## [Unreleased]`（`pickSyncPrimary`）；因此该行转 `awaiting-release`，下个版本发布时回版本号并关闭。
- `2026-10-28` #117 追问「有没有 GitHub repo/gist 之外的存储、让 OAuth 权限最小」已在 issue 回复（comment 6479732607：GitHub 只有 repo/gist 两种存储面、gist 的细粒度 PAT 不支持只能经典 `gist` scope、单仓最小权限 = 细粒度 PAT、真最小权限走 WebDAV/S3 兼容通道的目录或桶前缀）；状态仍 `open`，等报告者接受说明，未加 `fixed`。
