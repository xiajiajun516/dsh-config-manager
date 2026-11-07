# Triage Labels

技能按 canonical 角色说话；下表是这些角色在本仓库实际用的标签字符串。名字必须逐字一致（插件按名字做环境检查），颜色与描述是本仓库本地化。

## 分类（每条 issue 一个）

| 角色 | 本仓库标签 | 色 | 含义 |
|---|---|---|---|
| `bug` | `bug` | `d73a4a` | 已实现的行为出错、报错、数据不对 |
| `enhancement` | `enhancement` | `a2eeef` | 新功能或行为改进 |

## 状态（每条 issue 一个）

| 角色 | 本仓库标签 | 色 | 含义 |
|---|---|---|---|
| `needs-triage` | `needs-triage` | `fbca04` | 还没人看过；模板默认打，triage 结束前必须摘掉 |
| `needs-info` | `needs-info` | `5319e7` | 等报告者回应：补复现信息，或验证已发布的修复 |
| `ready-for-agent` | `ready-for-agent` | `0e8a16` | 描述完整，可直接交给 AFK agent |
| `ready-for-human` | `ready-for-human` | `b60205` | 需要人来做 |
| `wontfix` | `wontfix` | `ffffff` | 不会处理 |

## 进度标记（可选，不替代状态）

| 标签 | 何时加 | 何时摘 |
|---|---|---|
| `confirmed` | 已核实、正在修 | 修复发布后换成 `fixed` |
| `fixed` | 已随某版本发布 | 报告者确认后关 issue 时摘掉 |

- 进度标记只回答一个问题：「现在该不该回访」。票内细粒度进展写正文 `## 进度`（`deck_issue_patch` 的 `progress`），不为「改到 30%」加标签。
- `needs-repro` **已退役**（并入 `needs-info`）；历史 issue 上若还带它，按 `needs-info` 理解。

## 分区标签（第三层，可选）

`sync` / `backup` / `market` / `security` / `ui` / `accessibility` / `documentation` 表示受影响的分区，与上面两层正交：加了不影响 triage 判断。

## 不参与 triage 的票

`kind=issue` 的普通票与元 issue（例如置顶的 #47「反馈前必读」）不带分类与状态：它们是仓库说明，不是待处理请求。

## 与 wayfinder 的关系

`wayfinder:*` 是地图与工单的**类型**，**绝不与任何 triage 标签同时出现**；子票也不带分类与状态。

## 改词汇

要改本仓库字符串，只改上两表的「本仓库标签」列，并同步 `docs/agents/issue-tracker.md` 的 kind 表与 `AGENTS.md` 的 `## Agent skills` 摘要。**改标签名 = 插件环境检查报「缺 canonical 标签」**；只想换颜色/描述时用 `gh label edit`，名字别动。
