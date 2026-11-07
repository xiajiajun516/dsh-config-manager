# docs/agents/ — 协作与技能配置

给 agent（和接手的人）的仓库级流程，和 `AGENTS.md` 互补：`AGENTS.md` 放硬判据，这里放**怎么操作**。

| 文档 | 内容 |
|---|---|
| `issue-tracker.md` | issue tracker 选型（GitHub Issues）、六个位置（kind）与各自标签/正文形状、地图五节与 `## 进度`、评论免责声明与关闭三类、`gh` 子 issue/依赖/frontier 操作、本仓附加约定（回复队列与 CHANGELOG） |
| `triage-labels.md` | 分类（`bug`/`enhancement`）与状态（`needs-triage`/`needs-info`/`ready-for-*`/`wontfix`）两层角色、`confirmed`/`fixed` 只作进度标记、`needs-repro` 退役、`wayfinder:*` 不与 triage 同现 |
| `domain.md` | 领域文档布局（single-context：根 `GLOSSARY.md` + `docs/adr/`）、什么时候写词条、什么时候开 ADR |

## 加一条

新增协作流程 → 本区一份独立 md + 本表一行；只有「必须 / 绝不 + 判据」才回 `AGENTS.md`。

## 不变量

- `AGENTS.md` 的 `## Agent skills` 三段（Issue tracker / Triage labels / Domain docs）各留一行摘要 + 指向本区的指针。
- 本区文档不复制 `AGENTS.md` 规则正文，只写流程与命令。
