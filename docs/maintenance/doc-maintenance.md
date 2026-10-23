# 文档维护规则（doc-maintenance）

判定「这次改动要不要写文档、写到哪」的唯一出处。写法上只做**能当场判定的判据**，
不追求覆盖率与形式完整；文档的价值是让下一个改这块的人（含 AI）少读错东西。

> 与其它文档的分工：规则判据在 `AGENTS.md`（预算 28 KiB，只放一行 + 指针）；机制细则在 `DEVELOPERS.md`；
> UI/视觉数值在 `DESIGN.md`（唯一权威）；本页只管「文档本身怎么维护」。

---

## 1. 30 秒判定

1. 这次改动是否改变了其中任一：**对外格式/契约**、**用户可见行为**、**分层与目录约定**、**某条已写下的规则判据**、**某段「为什么」的结论**？
2. 是 → 找到承载它的**那一份**文档（§2 地图），只改那一段。
3. 否 → 不写文档，改动由代码、类型与测试表达。
4. 任何时候都**不新建「实现讲解」类文档**：先看现有域文档能否多一节。

三条硬口径：

- 一条事实只写一处，另一处写指针（重复 = 两处都会漂移）。
- 未验证的架构/接口/数据格式写「待确认」，不写推测。
- 计划不能写成已实现。

## 2. 载体与唯一归属

| 事实类型 | 唯一落点 | 不该出现在 |
|---|---|---|
| 项目介绍、安装、使用、开发入口 | `README.md` / `README.zh-CN.md` | `AGENTS.md` |
| AI/人开发时必须遵守的硬规则（判据一行） | `AGENTS.md` | 各域文档的规则段（那里只放证据/细节） |
| 机制细则、命令全表、发布与 CI 流程 | `DEVELOPERS.md` | `docs/modules/` |
| UI/视觉/token/组件视觉规范 | `DESIGN.md` | `docs/components/client-ui.md`（那里只写代码落点与守卫） |
| 分层、依赖方向、路由全景、关键数据流、结构性债 | `docs/architecture.md` | 域文档（域文档只指向它） |
| 某域的当前实现（入口/调用链/上限/失败语义） | `docs/modules/<域>.md` | `AGENTS.md` 的坑段 |
| 客户端装配、页面、状态、i18n、原语清单 | `docs/components/client-ui.md` | `DEVELOPERS.md` |
| 对外契约（第三方能照着实现） | `docs/spec/` | 域文档（改写链接指向 spec） |
| 一次性取舍的「为什么」 | `docs/decisions/NNNN-*.md` | `docs/lessons/`（那里是可复用经验与证据） |
| 真机事故、量化数据、复现脚本 | `docs/lessons/<域>.md` | `AGENTS.md`（只留一行判据 + 指针） |
| 已知债、硬限制 | `docs/maintenance/tech-debt.md`、`known-limits.md` | 域文档（域文档指过来） |
| 用户可见的功能/行为/修复 | `CHANGELOG.md` 的 `## [Unreleased]` | 域文档（域文档写行为，不写「本次更新」） |

## 3. 新增功能

**必须更新**（任一成立即触发，且同轮完成）：

| 改动性质 | 落点 |
|---|---|
| 对外可观察的数据格式、协议、错误码 | `docs/spec/` + `tests/conformance/`（契约在前） |
| 用户能看见的行为、文案、交互 | `CHANGELOG.md`（按 `changelog-writing` skill 落位） |
| 新目录、新分层、新守卫脚本、新 CI 步骤 | `docs/architecture.md`（+ `AGENTS.md` 若属硬规则） |
| 新的长期约束（上限、不可逆操作、失败语义） | `docs/modules/<域>.md` 或 `docs/maintenance/known-limits.md` |
| 非显然的坑（踩过一次、下次还会踩） | 先 `docs/lessons/<域>.md` 写证据 → 再 `AGENTS.md` 补一行判据 |

**不需要更新**：纯内部实现与命名调整；能被类型、测试、函数签名直接表达的行为；
性能优化（行为不变）；为目录里每个文件写说明；为普通组件/工具函数写 md。

**新建文档的门槛**（四条全满足才建，否则扩现有文档）：

1. 它覆盖一个**域**，不是一份文件、一个组件、一次改动；
2. 现有域文档塞不进去，或塞进去会破坏那份文档的主题；
3. 预计会被查阅 3 次以上（同一问题反复解释过）；
4. 能写出可验证断言（代码位置、测试名、错误码、上限值）。

## 4. 修改现有功能

文档里的**断言句**是可验证的：凡带 `file:line`、路由路径、错误码、上限数值、测试名的句子，
改完代码后按下面两步核对：

```bash
node scripts/check-doc-paths.mjs            # 路径/文件是否还存在
rg -n "<改动的符号名|路由|错误码>" docs AGENTS.md DEVELOPERS.md DESIGN.md
```

- **行号漂移不算失修**：本仓库约定「行号是写作时快照，符号名才是锚」，重构后只要符号名与路径仍在，行号可以不动；顺手改更好。
- **接口/数据格式变化**：先改 `docs/spec/`，再跑 `tests/conformance/`；`compat-matrix.md` 需要时加版本行。
- **默认值/上限变化**：域文档的上限表 + 客户端常量（如 `src/ui/rollback-view.ts`）+ CHANGELOG 一起改。
- **行为语义变化**：改域文档的「失败语义」段，并在 `docs/lessons/` 记一句为什么（避免下次被人当 bug 改回去）。

## 5. 重构

| 重构类型 | 文档动作 |
|---|---|
| 模块搬家、函数拆合、文件改名（对外行为不变） | 不写新文档；改受影响文档里的路径；必跑 `check-doc-paths` |
| 分层/依赖方向变化 | 同轮改 `docs/architecture.md` §2 与 `tests/architecture-boundaries.test.ts`，并在 `docs/decisions/` 留一条 |
| 对外行为变化（哪怕只是「顺手」） | 按 §4 当作功能变更处理，不能只写「重构」 |
| 发现文档描述的行为其实是错的 | **以代码为准改文档**；若是当初的取舍，把「为什么」补进 ADR；若只是笔误，commit message 说明即可 |

区分口径：**外部观察不到的变化**（内部结构）不写文档；**可观察到的变化**（输出、错误码、上限、页面行为）必须写。
重构期间不要顺手重写整份文档——只修被这次重构证伪的句子。

## 6. AI 开发流程

**改前读什么**（按任务域，禁止整库读）：

| 任务 | 先读 |
|---|---|
| 备份/导出/导入/恢复/加密 | `docs/modules/backup-restore.md` + `docs/spec/bundle-format-v1.md` |
| 同步/合并/自动同步/配置档案 | `docs/modules/sync.md` + `docs/spec/sync-channel-v1.md` |
| 对话回退/回滚点/救援台/CLI 写入门 | `docs/modules/recovery.md` |
| 客户端/页面/样式/i18n | `docs/components/client-ui.md` + `DESIGN.md` |
| 加路由/改分层/改入口 | `docs/architecture.md` + `AGENTS.md` §结构与分层 |
| 发布/版本/CI | `DEVELOPERS.md` + `AGENTS.md` §发布 |

**怎么找文档**：`docs/index.md` §1「我想做什么」是唯一起点；不要 grep 整个 `docs/` 猜。
找不到对应文档 = 这块是空白 → 按 §3 判据决定扩写还是新建，不要默认「没文档就不用写」。

**改前**：确认要改的这段事实在 §2 表里的**唯一**落点，别顺着「README 里也有一句」去重复维护。

**完成前自检三项**：

1. 被我改动的行为，文档里是否还留有与之矛盾的句子（`rg` 关键词，含 `AGENTS.md` 与 `DEVELOPERS.md`）；
2. 用户可见 → `CHANGELOG.md` 同轮写了没；
3. `node scripts/check-doc-paths.mjs && node scripts/check-doc-versions.mjs`（改过 `AGENTS.md` 再加 `node scripts/check-agents-budget.mjs`）。

**禁止**：为「完成任务」批量新建 md；把设计计划写成已实现；把代码贴进文档；写没有代码/测试支撑的架构描述；删掉仍有价值的历史决策（应标「已废弃」并说明）。

## 7. 长期维护

| 时机 | 做什么 | 谁做 |
|---|---|---|
| 每次发版 | 两个文档守卫（CI 已接）+ CHANGELOG 顶部亮点段 | 自动化 + 发版者 |
| 每次真机事故/线上问题 | 先写 `docs/lessons/<域>.md` 证据，再回 `AGENTS.md` 补一行判据 | 当事人 |
| 每季度，或「连续两次发现文档说法被代码证伪」 | 跑 §7.2 清单人工审一遍活文档 | 维护负责人 |

### 7.1 能自动化的（只有这三类，不再增加）

- **路径存在性**：`node scripts/check-doc-paths.mjs`（反引号路径与相对链接；不含 docs/design、docs/handoff、docs/seo、docs/lessons 等历史区）。
- **版本声明一致性**：`node scripts/check-doc-versions.mjs`（三处版本号 + 活文档里标注适用版本的句子）。
- **行为锚点**：现有测试（`tests/route/`、`tests/architecture-boundaries.test.ts`、`tests/conformance/`、各 `*.test.ts`）。文档断言与测试冲突时，以测试为准改文档。

### 7.2 必须人工判断的（季度清单，约 10 分钟）

1. `docs/index.md` 的表格是否覆盖全部活文档（新增的 md 有没有进表）。
2. 每份 `docs/modules/*.md` 的「入口 / 上限 / 失败语义」是否仍与代码一致。
3. `docs/maintenance/tech-debt.md` 里「已修」条目是否都带提交或测试名。
4. `docs/maintenance/known-limits.md` 是否有已经解禁的条目。
5. `docs/decisions/` 是否有技术前提已失效的 ADR（标「已废弃」，不删）。
6. `node scripts/check-agents-budget.mjs` 是否超过 26 KiB 警戒线（超了就把细节下移 `docs/`）。

### 7.3 怎么识别过时 / 重复 / 无价值

- **过时**：文档句子与代码矛盾，且代码有测试背书 → 改文档（不是改测试）。
- **重复**：同一事实出现在两份活文档 → 保留 §2 表规定的唯一落点，另一处改成一句指针。
- **无价值**：删掉后，下一个改这块的人**不会因此犯错** → 合并进域文档或删除；删除要在 commit message 写明内容去了哪里，不要静默消失。

## 8. 明确不做

- 不按固定模板重建 `docs/` 目录结构；目录服务于检索，不服务于整齐。
- 不为每个源文件生成索引或说明（源码索引会立刻腐烂）。
- 不引入文档生成器、frontmatter 校验、覆盖率指标等新系统。
- 不把 `CHANGELOG.md` 当架构说明，不把 `docs/lessons/` 当规则清单。
- 不在 `AGENTS.md` 里存证据（28 KiB 硬上限，只放判据与指针）。
