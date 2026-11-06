# Domain Docs

本仓库的领域文档布局是 **single-context**：一个仓库共用一份根目录的 `GLOSSARY.md`，架构决定放 `docs/adr/`。本目录（`docs/agents/`）是技能读的配置：`issue-tracker.md`、`triage-labels.md`、`domain.md`。

> skill 默认把 ADR 放在 `docs/adr/`；本仓库的编号决策记录也在 `docs/adr/`（`0001-*` … `0006-*`，2026-11 由旧目录 docs/decisions 改名迁入），且 `docs/index.md` 与 `scripts/check-doc-paths.mjs` 钉住该路径 ⇒ 沿用这一个目录，不另建第二处。

## Before exploring, read these

- **`GLOSSARY.md`**（仓库根）：领域词汇。
- **`docs/adr/`**：读与你即将改动区域相关的 ADR（文件名 `NNNN-<标题>.md`）。
- 需要整体导航时先读 **`docs/index.md`**（文档总索引）；规则背后的实测证据在 `docs/evidence/`。

这些文件不存在时**直接继续**：不要提示缺失，也不要在还没有真实词条/决策时提前创建它们。`/domain-modeling`（经 `/grill-with-docs`、`/improve-codebase-architecture`）只在术语或决定真正落地时才懒创建。

## File structure

single-context（本仓库实际布局）：

```
/
├── GLOSSARY.md            ← 领域词汇（尚未创建，第一次写词条时建）
├── AGENTS.md              ← 硬判据（含 ## Agent skills 块）
├── DESIGN.md / DEVELOPERS.md
├── docs/
│   ├── index.md           ← 文档总索引（两跳入口）
│   ├── overview.md        ← 仓库概览（参考材料）
│   ├── architecture/      ← 当前实现与分层
│   ├── contracts/         ← 对外契约
│   ├── adr/               ← ADR：0001-route-fence-and-auth-boundary.md …
│   ├── known-issues/      ← 能力缺口与已知限制
│   ├── evidence/          ← 规则背后的实测证据
│   ├── contributing/      ← 文档维护与版本号规则
│   ├── archive/           ← 只读历史（设计稿、审计、竞品参考）
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
