# 文档总索引

本仓库文档按**读者要解决的问题**分区，不按文件类型。两跳到达任意一份：本页 → 分区 README → 文件。

> 维护规则（要不要写、写哪份）→ `docs/contributing/doc-maintenance.md`。
> 本页与分区 README 的完整性由脚本强制：`node scripts/check-doc-paths.mjs` 会检查
> ① 每个分区下的每份 md 是否在该分区 `README.md` 里有条目行；② 每个分区 `README.md` 是否在本页有条目行。
> 路径漂移由同一脚本校验；写死的版本号由 `node scripts/check-doc-versions.mjs` 校验。

---

## 30 秒：我该读哪份？

| 我想… | 读这个 |
|---|---|
| 30 秒认识这个仓库（用途、目录、常用命令、本机注意） | `docs/overview.md` |
| 改代码前先弄清分层、路由清单、改哪里会炸 | `docs/architecture/core.md` |
| 改备份 / 导出 / 导入 / 恢复 / 加密 | `docs/architecture/backup-restore.md` + `docs/contracts/` |
| 改同步通道、合并、自动同步 | `docs/architecture/sync.md` |
| 改 agent 工具面 / 判断某能力该不该给模型 | `docs/architecture/agent-tools.md` |
| 改回退、回滚点、救援台、CLI 写入门 | `docs/architecture/recovery.md` |
| 改外部来源导入（30 个来源） | `docs/architecture/foreign-import.md` |
| 改 React 壳、页面、状态、i18n、样式 | `docs/architecture/client-ui.md` + `docs/architecture/client-dependencies.md` + `DESIGN.md` |
| 改离线救急台（`dcm web`） | `docs/architecture/cli-rescue-console.md` + `DESIGN.md` |
| 照着实现一个兼容本仓格式的第三方工具 | `docs/contracts/` |
| 知道「为什么当初这么定」 | `docs/adr/` |
| 判断「这能力能不能做 / 还欠什么」 | `docs/known-issues/` |
| 找某条规则的真机证据、量化数据、复现脚本 | `docs/evidence/`（规则本身在 `AGENTS.md`） |
| 决定这次改动要不要写文档、写哪份 | `docs/contributing/doc-maintenance.md` |
| 决定下一个版本号 | `docs/contributing/versioning.md` |
| 处理 issue、wayfinder 地图、领域词表 | `docs/agents/` |
| 查当时的审计与设计稿（**只读历史**） | `docs/archive/` |

## 1. 分区

| 分区 | 回答的问题 | 索引 | 性质 |
|---|---|---|---|
| `docs/overview.md` | 这是什么仓库 | — | 参考材料，随代码更新 |
| `docs/architecture/` | 我要改这块代码 | `docs/architecture/README.md` | 活文档（当前实现） |
| `docs/contracts/` | 外部要照着实现什么 | `docs/contracts/README.md` | 活文档（对外契约） |
| `docs/adr/` | 当初为什么这么定 | `docs/adr/README.md` | 只追加，不改历史判断 |
| `docs/known-issues/` | 能不能做 / 还欠什么 | `docs/known-issues/README.md` | 活台账 |
| `docs/evidence/` | 这条规则凭什么 | `docs/evidence/README.md` | 活证据库 |
| `docs/contributing/` | 怎么写文档 / 怎么定版本 | `docs/contributing/README.md` | 规则 |
| `docs/archive/` | 当时看到了什么 | `docs/archive/README.md` | **只读冻结** |
| `docs/agents/` | 技能与协作配置 | `docs/agents/README.md` | 配置 |

## 2. 归位约定（新文档放哪）

1. 对外文档（`README*` / `CHANGELOG` / `SECURITY` / `LICENSE`）与协作规范（`AGENTS` / `DEVELOPERS` / `DESIGN`）留在仓库根。
2. 「代码现在是什么样」→ `docs/architecture/`。「外部要照着实现」→ `docs/contracts/`。
3. 「为什么」→ docs/adr/ 下新建 NNNN-短横线标题（.md 后缀，不带 adr- 前缀；一次性取舍）或 `docs/evidence/`（可复用经验与证据）。
4. 「做不到 / 还欠」→ `docs/known-issues/`。「怎么维护文档与版本号」→ `docs/contributing/`。
5. 「一次性审计、竞品研究、过期设计稿」→ `docs/archive/`，文件名 `YYYY-MM-DD-主题.md` 或 `YYYY-MM-主题.md`，日期在前以便排序。
6. 新增任何文件后回所在分区 `README.md` 加一行；新增分区还要回本页加行（漏了守卫会红）。

## 3. 旧路径 → 新路径（2026-11-06 一次性迁移）

历史提交里的旧路径不改（`CHANGELOG.md` 是历史记录，守卫本来就不扫它）。

> 旧路径一律**不加反引号**：它们是历史位置、如今不存在，加了会被 `check-doc-paths` 当失效引用。

| 旧路径 | 新路径 |
|---|---|
| docs/spec/*.md（含 bundle-manifest.schema.json） | `docs/contracts/` 同名 |
| docs/modules/architecture.md | `docs/architecture/core.md` |
| docs/modules/{backup-restore,sync,recovery,foreign-import}.md | `docs/architecture/` 同名 |
| docs/components/{client-ui,cli-rescue-console}.md | `docs/architecture/` 同名 |
| src/client/CLIENT_DEPENDENCIES.md | `docs/architecture/client-dependencies.md` |
| docs/decisions/0N-*.md | `docs/adr/0N-*.md`（文件名不变） |
| docs/maintenance/{known-limits,known-gaps,tech-debt}.md | `docs/known-issues/` 同名 |
| docs/maintenance/{doc-maintenance,versioning}.md | `docs/contributing/` 同名 |
| docs/lessons/README.md | `docs/evidence/README.md` |
| docs/lessons/域.md | `docs/evidence/` 同名 |
| docs/lessons/repo-overview.md | `docs/overview.md` |
| docs/lessons/known-pitfalls.md | `docs/archive/2026-10-known-pitfalls.md` |
| docs/design/YYYY-MM-DD-*.md | `docs/archive/` 同名（v1.1 → v1-1） |
| docs/design/info-hint-migration.md | `docs/archive/2026-10-info-hint-migration.md` |
| docs/design/reference/{ibm,raycast}-DESIGN.md | `docs/archive/reference-{ibm,raycast}-design.md` |
| docs/design/reference/README.md、docs/research/README.md | 内容并入 `docs/archive/README.md` |
| docs/research/dsh-config-manager-technical-audit.md | `docs/archive/2026-11-01-technical-audit.md` |

## 4. 已移出仓库的材料

需要时按路径从 git 历史取回（`git log --diff-filter=D --oneline -- docs` 找删除提交）：阶段交接记录（原 handoff 目录 2 份，全部失效）、曝光与收录记录（原 seo 目录 3 份，与功能无关）、设计存档里 7 份零引用的过期稿（面板状态持久化、self 分区、生态清单、迁移咨询、会话日志压缩、会话格式处置、2026-09 UI 审计）。

## 5. 守卫

```
node scripts/check-doc-paths.mjs      # 路径漂移 + 分区 README 收录 + 本页收录
node scripts/check-doc-versions.mjs   # 三处版本一致 + 活文档里的「适用/当前版本」声明
node scripts/check-agents-budget.mjs  # AGENTS.md 预算与指针存在性
```
