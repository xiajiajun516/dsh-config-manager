# PHASE7_IMPLEMENTATION_REPORT — 迁移前咨询（Migration Pre-flight Consultation）

> 生成时间：2026-08-30
> 基线：`b49c174`（Phase 6 收尾 SHA，已核实）
> 三段式引擎第一段：迁移前咨询（Manifest + 健康评分）→ 迁移中事务（Phase 3 Journal）→ 迁移后可审计（Phase 6 迁移历史）

---

## 1. Implementation Summary

实现「迁移前咨询」：在任何 destructive/migration 操作（导入/恢复/同步/档案切换）真正执行前，对源（导出 ZIP / 本地快照 / 远端快照 / 配置档案）生成一份**可读、可审计、只读**的咨询报告：

- 源的健康评分（Health Score 0–100）：版本/平台兼容 + 完整性 + 分区完整性 + 一致性 + 敏感暴露面 + 可迁移性。
- 「将要发生什么」：将应用哪些分区、多少条目、哪些冲突/风险、哪些会被覆盖、哪些是 dry-run。
- 一个明确的建议（Recommendation）：proceed / review / block（可配置，block 时保守拦截）。

## 2. Step-by-step

| Step | 内容 | 状态 |
|---|---|---|
| 1 | Analysis：枚举 4 种迁移源入口、现有 validator/manifest 能力、咨询缺口、redaction 边界 | PASS |
| 2 | Design：`migration-consult.ts` 数据模型 + 评分规则 + 报告结构 + 接线点 + UI 落位（`docs/design/2026-08-25-migration-consult-design.md`） | PASS |
| 3 | 独立只读评审（4 reviewer：Read-only / Health-metric / Redaction / Integration + Recommendation 三态）→ Gate=GO | PASS |
| 4 | Core 健康评分 `migration-consult.ts`（纯函数，规则驱动）+ 全维度单测（32 例） | PASS |
| 5 | 咨询报告模型 + Recommendation（proceed/review/block 三态 + 触发项解释） | PASS |
| 6 | API：POST /consult（只读、loopback fence、全链路只读验证） | PASS |
| 7 | UI：import-wizard 预览 / 快照恢复计划弹窗 / 配置档案切换预览 / 一键同步差异确认 接入咨询卡 + i18n | PASS |
| 8 | i18n：咨询相关文案进字典（`ui/i18n.ts` `consult.*` 键，zh/en） | PASS |
| 9–11 | 测试（评分规则各档 / READ-ONLY 零副作用断言 / REDACTED / COMPLETE / Recommendation / API / UI 纯函数） | PASS |
| 12 | Real DSH E2E（隔离 DSH_HOME：对真实导出 ZIP/profile 出咨询报告；验证全程零写副作用；重启无残留） | PASS |
| 13 | Full Validation + 本报告 | PASS |

## 3. Architecture compliance

- **无第二套 framework**：咨询是只读分析层，复用 `computeCompatibility`（扩展而非重写）、`validateManifest`、`scanAndRedact`、integrity/zip-security、import-wizard 分析管线；不新建 journal / transaction / lock / snapshot-trust。
- **扩展优先**：健康评分在 `computeCompatibility` 之上叠加额外维度，不推倒现有兼容性评分。
- **不修改已评审核心引擎**：只加新文件（`migration-consult.ts` / `consult-source.ts` / `migration-consult-view.ts`）+ 新端点（POST /consult）+ ProfileManager 只读方法（`readSections`，追加非改写）。

## 4. Core invariant verification

| 不变量 | 验证 |
|---|---|
| READ-ONLY | `consult-source.test.ts` READ-ONLY 断言（目录指纹一致）+ Real DSH E2E（WRITE_SIDE_EFFECT: NONE） |
| ACCURATE | 评分规则确定性（`migration-consult.test.ts` 确定性用例）；verdict 与评分/证据一致 |
| COMPLETE | 4 种源类型（export-zip / local-snapshot / remote-snapshot / profile）统一报告；6 维度齐全 |
| REDACTED | 核心构造时 redact（`computeDimensions` 对 message/evidence 应用 redact）+ 渲染前 redact 兜底 |
| ACTIONABLE | proceed / review / block 三态 + recommendationReasons 触发项 |
| BOUND | 报告关联 manifest / snapshotId / sourceId |
| NON-BLOCKING | 咨询建议性；health=critical 且 allowBlock=true 时 block（可回退/可覆盖，记录在执行侧） |

## 5. 评分规则表

| 维度 | 权重 | 规则 |
|---|---|---|
| compatibility | 0.20 | 复用 `computeCompatibility`：excellent=100 / good=90 / partial=60 / unsupported=0；manifest null → 0 |
| integrity | 0.25 | manifest null → 0；manifestIssues error -30 / warning -10；checksumIssues -30；zipSlip -30；checksums null → -10 |
| sections | 0.20 | missingSections -20；声明但数据缺失 -30（互斥，不重复扣） |
| consistency | 0.10 | 悬空凭据引用 -15 |
| sensitive | 0.15 | 未加密秘密 -40；sensitiveHits -5（封顶 -40）；两惩罚叠加 |
| migratability | 0.10 | null → 60；!ok → 0；fatalConflicts -30；warnings -10 |

HealthScore = round(Σ weight×score)；verdict = 最差维度；recommendation = verdict + allowBlock。

## 6. Test matrix

| 测试文件 | 用例数 | 覆盖 |
|---|---|---|
| `src/core/migration-consult.test.ts` | 32 | 评分规则各档 / HealthScore 加权 / verdict / recommendation 三态 / 一致性 / 敏感暴露 / 可迁移性 / 确定性 |
| `src/core/consult-source.test.ts` | 7 | export-zip 读取 / 敏感暴露 / 损坏 ZIP / local-snapshot 合成源 / profile 合成源 / READ-ONLY 零写 |
| `src/ui/migration-consult-view.test.ts` | 4 | 视图数据 / verdict/recommendation badge 映射 / 维度 label |
| 全量 `npm test` | 1448 | 全绿（含 Phase 7 新增 43 例） |

## 7. Real DSH E2E

见 `phase7-e2e/PHASE7_REAL_DSH_E2E_REPORT.md`：export-zip + profile 咨询（score=100, healthy, proceed）、READ-ONLY 零写（目录指纹一致）、loopback fence（403）、重启无残留。**PASS**。

## 8. P0 / P1 / P2

- **P0 = 0**
- **unresolved P1 = 0**
- **P2**：local-snapshot / remote-snapshot 源类型的真实 DSH 触发（需构造导入/同步业务流）未在 E2E 覆盖，已由核心单测 + 接线点核实（见 E2E 报告 §3）。

## 9. Deferred

- 无。

## 10. Final verdict

**PHASE 7 IMPLEMENTATION = PASS**

P0=0、unresolved P1=0、typecheck/build/full tests（1448/1448）PASS、READ-ONLY 断言全绿、Real DSH E2E 无新 P0/P1。
