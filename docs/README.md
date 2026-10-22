# docs/ — 从这里开始

**总索引：`docs/index.md`**（按「我想做什么」组织：架构 / 模块 / 契约 / 决策 / 维护 / 证据 / 历史存档）。

本文件只保留三条最容易被违反的约定：

1. 仓库根只放对外文档（`README*` / `CHANGELOG` / `SECURITY` / `LICENSE`）与协作规范（`AGENTS.md` / `DEVELOPERS.md` / `DESIGN.md`）；其余进本目录并挂到 `docs/index.md`。
2. `AGENTS.md` **只写规则**（硬上限 28 KiB，守卫 `node scripts/check-agents-budget.mjs`）；证据与叙事进 `docs/lessons/<域>.md`，新增坑两处同步：先写证据，再补一行规则 + 指针。
3. 改导出/导入格式行为必须同步 `docs/spec/` 并重跑 `tests/conformance/`；文档里的路径与版本声明由 `scripts/check-doc-paths.mjs` / `scripts/check-doc-versions.mjs` 校验。
