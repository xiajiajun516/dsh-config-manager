# Issue tracker: GitHub

本仓库的 issue 与 spec 都放在 GitHub Issues：`xiajiajun516/dsh-config-manager`。所有操作走 `gh` CLI（仓库内执行，`gh` 自动推断 repo）。

## Conventions

- **建 issue**：`gh issue create --title "..." --body "..."`；多行 body 用 heredoc。优先套用 `.github/ISSUE_TEMPLATE/` 下的模板（`bug_report.yml` / `feature_request.yml` / `ui_bug.yml`）。
- **读 issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配 `--label` / `--state` 过滤。
- **子 issue**：`gh issue create --parent <parent> ...`，或事后 `gh issue edit <parent> --add-sub-issue <child>`（`gh` 2.94+；本机 2.96）。老版本回落 `gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`；没有子 issue 能力时在子 issue 正文首行写 `Part of #<parent>`。
- **阻塞**：用 GitHub 原生 issue 依赖。`gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>`（2.94+）。老版本：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞者的**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`），不是 `#number` 或 `node_id`。不支持依赖时在子 issue 正文首行写 `Blocked by: #<n>, #<n>`。所有阻塞者关闭才算解除。
- **数未关闭阻塞**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（只算 open，0 = 可开工）。`gh issue view <n> --json blockedBy` 会把已关闭的也列出来，要自己过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论**：`gh issue comment <number> --body "..."`。
- **打/摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。标签词汇见 `docs/agents/triage-labels.md`。
- **关闭**：先 `gh issue comment <number> --body "..."` 写原因，再 `gh issue close <number>`。已关闭的 issue 用 `gh issue close --comment` 会丢评论但仍退出 0，别用。

只往本仓库自己的 issue 里写。一个 session 第一次 `gh issue create` 前，用 `gh repo view --json nameWithOwner` 确认目标是 `xiajiajun516/dsh-config-manager`（fork 场景 `gh` 可能默认指向上游）。

## Pull requests as a triage surface

**PRs as a request surface: no.** _(设为 `yes` 表示本仓库把外部 PR 当 feature request 排队；`/triage` 读这一行。)_

设为 `yes` 时，PR 与 issue 走同一套标签与状态，命令换成 `gh pr` 对应项：

- **读 PR**：`gh pr view <number>`，再看 `gh pr view <number> --comments`（非 TTY 下只打印评论，不含正文），diff 用 `gh pr diff <number>`。
- **列待分类的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，裸 `#42` 可能是任意一种：先 `gh pr view 42`，失败再 `gh issue view 42`。

## When a skill says "publish to the issue tracker"

建一条 GitHub issue。

## When a skill says "fetch the relevant ticket"

按上面 **读 issue** 执行。

## Wayfinding operations

`/wayfinder` 用。**地图**是一条 issue，**工单**是它的子 issue。

- **地图**：一条打了 `wayfinder:map` 的 issue，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子工单**：挂成地图的 GitHub 子 issue（见 **子 issue**）。不支持子 issue 时，把子工单加进地图正文的 task list，并在子工单正文首行写 `Part of #<map>`。标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后 assign 给执行的人。
- **阻塞**：见 **Conventions** 的 **阻塞**。
- **Frontier 查询**：列出地图的 open 子工单（`gh issue list --state open`，范围限地图的子 issue / task list），剔掉有未关闭阻塞者（见 **数未关闭阻塞**）或已有 assignee 的；地图顺序最靠前的先做。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本 session 第一次写操作。
- **结题**：`gh issue comment <n> --body "<结论>"` → `gh issue close <n>` → 往地图的 Decisions-so-far 追加一行上下文指针（gist + 链接）。

## 本仓库附加约定

- **issue 台账**：收到的 issue 记进 `.dsh/issue-ledger.md`（`issue-intake-response` 技能）；发版后按台账逐条回「已在 vX.Y.Z 修复」并标 `fixed`。
- **用户可见的修复要进 `CHANGELOG.md` 的 `## [Unreleased]`**，否则发版门禁会失败。
