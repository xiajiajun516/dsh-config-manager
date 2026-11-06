# docs/archive/ — 只读存档

> **只读冻结**：这里是一次性审计、竞品研究、已冻结的设计稿与事故记录。**判断当前行为一律以代码 + 测试为准**；
> 与 `docs/architecture/`、`docs/evidence/` 冲突时以它们为准。除补「失效说明」外不再改写正文。

## 1. 设计稿与冻结记录

| 文件 | 内容 |
|---|---|
| `2026-08-19-about-tab-design.md` | 关于页签设计 |
| `2026-08-19-market-publish-design.md` | 市场发布流程设计 |
| `2026-08-20-my-configs-design.md` | 「我的配置」页设计 |
| `2026-08-21-market-star-filter-sort-design.md` | 市场星标 / 筛选 / 排序 |
| `2026-10-02-ui-rebuild-v2-skeleton.md` | UI v2 骨架施工图（4 页 + ⌘K 命令面板） |
| `2026-10-04-foreign-import-v1.md` | 外部来源导入 v1 |
| `2026-10-05-ui-redesign-v3.md` | UI 重设计 v3 |
| `2026-10-08-i18n-en-hardcoding.md` | i18n 英文硬编码治理 |
| `2026-10-18-claude-code-migration-v1-1.md` | Claude Code 迁移 v1.1 |
| `2026-10-28-native-directory-picker.md` | 原生目录选择器 |
| `2026-10-info-hint-migration.md` | 说明性文案收敛台账（InfoHint ⓘ） |
| `2026-11-01-visual-pass.md` | 视觉走查 |
| `2026-10-known-pitfalls.md` | 常见坑与事故记录（2026-10-05 从 `AGENTS.md` 逐字下移，2026-10-23 起只读冻结） |
| `2026-11-01-technical-audit.md` | 全仓专项技术审计 + 技术升级路线图（20 章，基线 v0.2.4 / HEAD `c671c98`） |

## 2. 外部参考（第三方 DESIGN 逐字副本）

这里保存第三方 DESIGN.md 分析的**逐字副本**，作为 `docs/architecture/cli-rescue-console.md` 的出处依据。
它们**不是**本仓库的规范：本仓库的 UI 规范是根目录 `DESIGN.md`。

| 文件 | 来源 | 用途 |
|---|---|---|
| `reference-ibm-design.md` | https://github.com/VoltAgent/awesome-design-md 的 `design-md/ibm/DESIGN.md` | 救急台亮色：语义四色、surface 画布、12–18px 字阶、按钮/表单/卡片状态、间距阶 |
| `reference-raycast-design.md` | 同上，`design-md/raycast/DESIGN.md` | 救急台暗色：surface 阶梯与四个语义 accent |

原仓库 MIT 许可。这些文件描述的是**公开可见的 CSS 值**，不代表对任何品牌视觉资产的所有权；
本项目只从中提取通用设计令牌，不使用任何品牌标识、字体文件或图片资源。

更新方式（如需升级版本，逐字替换并重跑 `npm test`；在仓库根执行）：

```bash
curl -fsSL "https://raw.githubusercontent.com/voltagent/awesome-design-md/main/design-md/ibm/DESIGN.md" -o docs/archive/reference-ibm-design.md
curl -fsSL "https://raw.githubusercontent.com/voltagent/awesome-design-md/main/design-md/raycast/DESIGN.md" -o docs/archive/reference-raycast-design.md
```

## 3. 专项研究与审计

| 你的目的 | 直接跳到（`2026-11-01-technical-audit.md` 内） |
|---|---|
| 5 分钟知道结论与优先项 | §1 Executive Summary + §19 Final Recommendations |
| 复核某个问题的证据 | §13 差距矩阵（每条带 `文件:行`）→ 对应专项章 §5–§11 |
| 决定要不要改架构 | §14 Recommended Architecture（含「不做」的判定与理由） |
| 排期与验收 | §15 Roadmap + §17 Testing Strategy |
| 评估改动风险 | §16 Compatibility & Migration Risks |
| 看竞品到底怎么实现的 | §12 Competitor Source Analysis（5 个仓库的源码机制） |
| 想知道哪些没法验证 | §17.1（NOT RUN）+ §17.5（UNKNOWN） |

**审计报告是快照，不做增量维护**：代码往前走之后不要回头改旧报告的正常内容。结论失效就在文首加一行
`> 失效说明（YYYY-MM-DD）：…，被 <新文档> 取代`，然后写新文档并在 `docs/index.md` 登记。
报告里的「建议」一旦落地，正确的位置是 `docs/architecture/`（当前实现）/ `docs/adr/`（取舍）/ `docs/evidence/`（证据）。

## 4. 收录口径

**收进来**：一次性、有基线、有证据的横向分析（专项审计、竞品源码研究、技术方案对比、已冻结的设计稿）。
必须写明基线（版本 + HEAD）与证据口径，结论要能按 `文件:行` 在同一基线上复核。文件名 `YYYY-MM-DD-主题.md`。

**不收进来**：

| 类型 | 该放哪 |
|---|---|
| 当前实现是什么样 | `docs/architecture/` |
| 为什么当初这么设计（一次性取舍） | `docs/adr/` |
| 可复用的经验与证据 | `docs/evidence/` |
| 已知债 / 硬限制 / 已知缺口 | `docs/known-issues/` |
| 对外契约 | `docs/contracts/` |

**不要在存档里记录真实凭据、token、私有主机名**：证据只写仓库相对路径与被脱敏的片段。
