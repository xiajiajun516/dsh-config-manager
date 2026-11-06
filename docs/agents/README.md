# docs/agents/ — 协作与技能配置

给 agent（和接手的人）的仓库级流程，和 `AGENTS.md` 互补：`AGENTS.md` 放硬判据，这里放**怎么操作**。

| 文档 | 内容 |
|---|---|
| `issue-tracker.md` | issue tracker 选型（GitHub Issues）、`gh` 子 issue 与原生依赖写法的差异、wayfinder 地图/子票/阻塞/frontier/认领操作、本仓附加约定（台账与 CHANGELOG） |
| `triage-labels.md` | 五个 triage 标签角色与默认名、与既有 `needs-repro`/`confirmed`/`fixed` 的分工、`wayfinder:*` 不与 triage 标签同现 |
| `domain.md` | 领域文档布局（single-context：根 `GLOSSARY.md` + `docs/adr/`）、什么时候写词条、什么时候开 ADR |

## 加一条

新增协作流程 → 本区一份独立 md + 本表一行；只有「必须 / 绝不 + 判据」才回 `AGENTS.md`。

## 不变量

- `AGENTS.md` 的 `## Agent skills` 三段（Issue tracker / Triage labels / Domain docs）各留一行摘要 + 指向本区的指针。
- 本区文档不复制 `AGENTS.md` 规则正文，只写流程与命令。
