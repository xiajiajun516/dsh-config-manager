# Triage Labels

技能按五个 canonical triage 角色说话；下表是这些角色在本仓库 issue tracker 里实际用的标签字符串。下表五个标签已在本仓库创建，描述用中文，语义不变。

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | 等待维护者分类与确认                     |
| `needs-info`               | `needs-info`         | 等报告者补充信息                         |
| `ready-for-agent`          | `ready-for-agent`    | 描述完整，可直接交给 AFK agent           |
| `ready-for-human`          | `ready-for-human`    | 需要人来实现                             |
| `wontfix`                  | `wontfix`            | 不会处理                                 |

技能提到某个角色（例如「打上 AFK-ready 标签」）时，用上表右列对应字符串；要改本仓库词汇，只改这一列。

## 与仓库既有标签的关系

- 本仓库另有一套 issue 处理标签（`needs-repro` / `confirmed` / `fixed`，见 `.dsh/issue-ledger.md` 与 `issue-intake-response` 技能）。它们是处理进度，不是这五个 triage 角色，两者可以并存，不要互相替代。
- `wayfinder:*`（`wayfinder:map`、`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`）是 `/wayfinder` 的地图与工单类型，**不与任何 triage 标签同时出现**。
