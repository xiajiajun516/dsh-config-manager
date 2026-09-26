# docs/ — 文档索引

> 仓库根目录只保留对外文档（`README.md` / `README.zh-CN.md` / `CHANGELOG.md` / `SECURITY.md` / `LICENSE`）
> 与协作规范（`AGENTS.md` / `DEVELOPERS.md` / `DESIGN.md`）；其余文档一律按用途放进本目录，不再散落在仓库根目录。

| 目录 | 性质 | 读者 |
| --- | --- | --- |
| `docs/design/` | 上游设计依据（各特性的设计稿与评审记录） | 本仓库维护者 |
| `docs/spec/` | 对外契约（格式规格 / schema / 兼容矩阵 / 已知缺口） | 第三方实现者 |
| `docs/seo/` | 搜索曝光与召回基线记录 | 维护者 |
| `docs/handoff/` | 阶段交接 / Agent 交接文档（**历史归档，非当前状态**） | 接手者 |

## 约定

- 改动导出/导入格式行为必须同步 `docs/spec/` 并重跑 `tests/conformance/`（详见 `AGENTS.md`）。
- `docs/handoff/` 中的文档写于当时的版本与工作区状态，结论可能已过时；当前状态以 `CHANGELOG.md` + `git log` 为准。
- 新增文档请按上表归位；根目录新增 `.md` 需先确认它是否属于「对外文档」。
