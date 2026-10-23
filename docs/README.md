# docs/ — 从这里开始

**唯一入口：`docs/index.md`**（按「我想做什么」分流：架构 / 模块 / 契约 / 决策 / 维护 / 证据 / 历史存档）。

本文件不再重复任何规则正文，避免与权威文档漂移。三类常被问到的内容各自只有一个家：

- **文档该写什么、写在哪、要不要写** → `docs/maintenance/doc-maintenance.md`（载体归属表 §2、新增/修改/重构的判定 §3–§5）。
- **AI 开发必须遵守的硬规则** → 根目录 `AGENTS.md`（只写规则，预算 28 KiB，守卫 `node scripts/check-agents-budget.mjs`）。
- **代码路径 / 版本声明是否与文档一致** → `scripts/check-doc-paths.mjs`（含 `[doc-index]` 活跃文档收录检查）与 `scripts/check-doc-versions.mjs`。

新增文档后必须回 `docs/index.md` 的表格加一行；漏了 `check-doc-paths` 的 `[doc-index]` 段会直接红。
