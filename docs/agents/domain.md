# Domain Docs

本仓库的领域文档布局是 **single-context**：一个仓库共用一份根目录的 `GLOSSARY.md`，架构决定放 `docs/decisions/`。本目录（`docs/agents/`）是技能读的配置：`issue-tracker.md`、`triage-labels.md`、`domain.md`。

> skill 默认把 ADR 放在 `docs/adr/`；本仓库既有的编号决策记录在 `docs/decisions/`（`0001-*` … `0006-*`），且 `docs/index.md` 与 `scripts/check-doc-paths.mjs` 已钉住该路径，故沿用 `docs/decisions/`，不另建 `docs/adr/`。

## Before exploring, read these

- **`GLOSSARY.md`**（仓库根）：领域词汇。
- **`docs/decisions/`**：读与你即将改动区域相关的 ADR（文件名 `NNNN-<标题>.md`）。
- 需要整体导航时先读 **`docs/index.md`**（文档总索引）；规则背后的实测证据在 `docs/lessons/`。

这些文件不存在时**直接继续**：不要提示缺失，也不要在还没有真实词条/决策时提前创建它们。`/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture`）只在术语或决定真正落地时才懒创建。

## File structure

single-context（本仓库实际布局）：

```
/
├── GLOSSARY.md            ← 领域词汇（尚未创建，第一次写词条时建）
├── AGENTS.md              ← 硬判据（含 ## Agent skills 块）
├── DESIGN.md / DEVELOPERS.md
├── docs/
│   ├── index.md           ← 文档总索引
│   ├── decisions/         ← ADR：0001-route-fence-and-auth-boundary.md …
│   ├── modules/           ← 当前实现与分层
│   ├── spec/              ← 对外契约
│   ├── lessons/           ← 规则背后的证据
│   └── agents/            ← 本目录：技能读取的配置
└── src/
```

**不创建 `GLOSSARY-MAP.md`，也不在子项目里各自建 `GLOSSARY.md`**：单上下文布局只有根上一份。只有在仓库真的长出多包/多上下文边界时才改布局。

## Use the glossary's vocabulary

输出里出现领域概念时（issue 标题、重构提案、假设、测试名），用 `GLOSSARY.md` 定义的词，不要漂移到它明确避免的同义词。

需要的概念还不在词表里，是个信号：要么你在发明项目不用的说法（重新考虑），要么确实有缺口（记下来交给 `/domain-modeling`）。

## Flag ADR conflicts

输出与既有 ADR 冲突时显式说出来，不要静默覆盖：

> _Contradicts ADR-0001 (route fence and auth boundary), but worth reopening because…_
