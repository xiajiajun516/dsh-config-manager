# 文档总索引

本仓库的文档按**读者要解决的问题**分区，不按文件类型。找不到时先看这里，再看 `docs/lessons/README.md`（证据库索引）。

> 维护规则：文档怎么写、写到哪、什么时候不必写 → `docs/maintenance/doc-maintenance.md`。新增文档必须回本页表格加一行；
> 这条**由脚本强制**：`node scripts/check-doc-paths.mjs` 的 `[doc-index]` 段会检查 `docs/{spec,modules,maintenance,decisions,components}/`
> 下的每份 md 是否在本页以明确路径收录（`lessons`/`design`/`handoff`/`seo` 与冻结存档不在范围内）。
> 路径与版本声明同样由 `check-doc-paths.mjs`、`node scripts/check-doc-versions.mjs` 在 CI 里校验。

---

## 1. 我该读哪份？

| 我想… | 读这个 |
|---|---|
| 快速知道仓库怎么分层、82 条路由怎么来的、改哪里会炸 | `docs/modules/architecture.md` |
| 改备份/导出/导入/恢复/加密 | `docs/modules/backup-restore.md` + `docs/spec/` |
| 改同步通道、合并、自动同步、配置档案 | `docs/modules/sync.md` |
| 改对话回退、回滚点、救援台、CLI 写入门 | `docs/modules/recovery.md` |
| 改外部来源导入（Claude Code / Codex / Cursor… 共 30 个来源） | `docs/modules/foreign-import.md` |
| 改 React 壳、页面、状态、i18n、样式 | `docs/components/client-ui.md` + `DESIGN.md`（视觉唯一权威） |
| 改离线救急台（`dcm web`）的页面结构与视觉 | `docs/components/cli-rescue-console.md` + `DESIGN.md` |
| 实现一个兼容本仓备份格式的第三方工具 | `docs/spec/`（对外契约 + 兼容矩阵） |
| 给第三方市场仓库写 `index.json`（收录本插件） | `docs/spec/market-index-v1.md` |
| 知道「为什么当初这么设计」 | `docs/decisions/` |
| 看已知债与排期依据 | `docs/maintenance/tech-debt.md` |
| 看「这个方向别再试了」的硬限制 | `docs/maintenance/known-limits.md` |
| 找某条规则的证据（真机事故、量化数据、复现脚本） | `docs/lessons/`（规则本身在 `AGENTS.md`） |
| 查开发/测试/发布的具体命令 | `DEVELOPERS.md` |
| 决定下一个版本号（PATCH/MINOR/MAJOR、预发布命名、历史版本能不能动） | `docs/maintenance/versioning.md` |
| 查 UI 视觉与 token 决策 | `DESIGN.md` |
| 决定这次改动要不要写文档、写在哪 | `docs/maintenance/doc-maintenance.md` |
| 决定下一个版本号（PATCH/MINOR/MAJOR、预发布命名、历史版本能不能动） | `docs/maintenance/versioning.md` |

## 2. 当前实现（代码是什么样）

| 文档 | 内容范围 | 何时更新 |
|---|---|---|
| `docs/modules/architecture.md` | 分层与依赖方向、路由层与围栏、领域模块表、五条关键数据流、结构性债 | 分层/路由/模块边界变化时；行号漂移时顺手修 |
| `docs/modules/backup-restore.md` | 导出、快照、恢复、导入、加密、ZIP 安全边界、失败与回退语义 | 上述链路的实现或语义变化时 |
| `docs/modules/sync.md` | 同步状态机、四传输能力差异、自动同步、sessions/optInSections、档案复制 | 同步行为/通道能力变化时 |
| `docs/modules/recovery.md` | 回滚点两态采集、台账与预算、删除集判据、回退=fork+归档、SAFE MODE、三道写入门 | 回退或救援语义变化时 |
| `docs/modules/foreign-import.md` | 30 个外部来源的读盘/解析/合成流水线、三入口同源、IR 硬形状、体积守卫、加来源清单 | 新增来源或合成形状变化时 |
| `docs/components/client-ui.md` | client 装配、四页与加页五处、原语清单、样式/token 守卫、状态归属、i18n、测试口径 | 组件体系或页面结构变化时 |
| `docs/components/cli-rescue-console.md` | 离线救急台（`dcm web`）的页面结构、样式契约与状态口径 | CLI 页面结构或样式体系变化时 |

## 3. 对外契约（第三方要能照着实现）

| 文档 | 内容范围 |
|---|---|
| `docs/spec/bundle-format-v1.md` | 备份包（config.zip）v1 的 ZIP 布局、manifest 字段、分区语义、加密与向前兼容（取证基线 0.1.59；缺口权威在 `docs/maintenance/known-gaps.md`） |
| `docs/spec/bundle-manifest.schema.json` | manifest 的**机器可读 schema**（`bundle-format-v1.md` §manifest 一节的配套文件；非 md，`[doc-index]` 不扫，靠人记着） |
| `docs/spec/sync-channel-v1.md` | 同步通道的索引/快照/能力矩阵 |
| `docs/spec/compat-matrix.md` | DSH 版本兼容矩阵：host 服务/client 包/peer（18 = 16 官方 + react·react-dom）/engines 实测与升级风险 R1–R15、M1–M8 |
| `docs/spec/headless-consumption.md` | 无 UI 消费契约：`/core` `/schema` `/client` 导出面、宿主注入要求；§7 是示例快照，不是契约 |
| `docs/spec/plugin-data-declaration.md` | 插件通过 `dsh.dataDirs` 自述数据目录的声明格式 |
| `docs/spec/market-index-v1.md` | 第三方市场仓库 `index.json` 的字段、校验规则与安全边界 |

改格式行为必须同步 `docs/spec/` 并重跑 `tests/conformance/`（规则在 `AGENTS.md`）。

## 4. 决策记录（ADR）

短、少、只记「当初为什么这样」。新增 ADR 用 `NNNN-短横线标题.md`，状态写「已采纳 / 待决策 / 已废弃」。

- `docs/decisions/0001-route-fence-and-auth-boundary.md` — 路由只经 kit 声明；围栏即认证边界
- `docs/decisions/0002-encrypted-container-unlock-gate.md` — 未解锁容器不得进解析器
- `docs/decisions/0003-sync-conditional-write-and-gist-exception.md` — 条件写；gist 是明确例外（不做条件头，改「写后复核 + 有界重做」；**已采纳并收口**，残余窗口见 `docs/maintenance/known-limits.md`）
- `docs/decisions/0004-rollback-point-fork-archive.md` — 回退 = fork + 归档；回滚点 = 两态 + 内容寻址台账
- `docs/decisions/0005-safe-mode-fail-closed.md` — SAFE MODE fail-closed，解除判据只有一份
- `docs/decisions/0006-restore-auto-resume.md` — 恢复崩溃后自动续跑：逐项证明成立才续，三个入口不跨续

## 5. 维护与债

- `docs/maintenance/tech-debt.md` — 按 P1/P2/P3 编号的债务清单 + 已修留档；每条带证据/影响/建议/置信度
- `docs/maintenance/known-limits.md` — 「当前做不到 / 做了会出事」的硬限制（平台/外部事实，仓内不可证）
- `docs/maintenance/known-gaps.md` — 已知实现缺口台账（**历史证据 + 当前状态**，不是路线图，也**不是**对外契约）；查「现在还没关的」只看 §0 状态表。体积大且不随版本走，两个守卫显式跳过它
- `docs/maintenance/doc-maintenance.md` — **文档维护规则**：改动要不要写文档、写哪份、AI 流程、季度人工清单
- `docs/maintenance/versioning.md` — **版本管理规范**：三数字语义与 0.x 本地约定、预发布命名、历史版本保留与审计记录、「已发布」的四项定义、发布前检查清单、版本变更判断模板

更新时机：修完一条把状态改为「已修」并写提交/测试名（**不要删行**）；发现新债先加行再决定排期。

## 6. 证据库与历史存档

| 位置 | 性质 | 说明 |
|---|---|---|
| `docs/lessons/` | 证据库（当前有效） | `AGENTS.md` 只写规则，**为什么**写在这里；索引进 `docs/lessons/README.md` |
| `docs/design/` | 上游设计存档 | 可能早于实现；判断行为以代码 + 测试为准 |
| `docs/handoff/` | 阶段交接（已失效历史归档） | 写于当时的版本且描述的代码多已删除，**不要按它施工** |
| `docs/seo/` | 曝光与收录记录（历史，不再维护） | 与功能无关；只在查历史搜索表现时看 |
| `docs/lessons/known-pitfalls.md` | 冻结存档 | 2026-09/10 一次下移的记录，**只读**、不再追加；与 `docs/lessons/` 冲突时**以 lessons 与代码为准** |

## 7. 归位约定（新文档放哪）

1. 对外文档（`README*` / `CHANGELOG` / `SECURITY` / `LICENSE`）与协作规范（`AGENTS` / `DEVELOPERS` / `DESIGN`）留在仓库根。
2. 「代码现在是什么样」→ `docs/modules/architecture.md` 或 `docs/modules/`、`docs/components/`。
3. 「外部要照着实现」→ `docs/spec/`。
4. 「为什么」→ `docs/decisions/`（一次性取舍）或 `docs/lessons/<域>.md`（可复用经验与证据）。
5. 「已知债 / 硬限制」→ `docs/maintenance/`。
6. 新增任何文件后回本页表格加一行（漏了 `check-doc-paths` 会直接红），并跑两个守卫。