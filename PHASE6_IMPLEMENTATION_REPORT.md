# PHASE6_IMPLEMENTATION_REPORT — Phase 6 Migration History & Auditability Engine

> 阶段：**Phase 6（Migration History & Auditability）**
> 基线：HEAD `b96d4f5`（Phase 5 收尾）；Phase 1–5 全 PASS；全量测试基线 1370/1370。
> 结论：**PASS（P0=0 / unresolved P1=0 / typecheck·build·full tests 全绿）**

---

## 1. Implementation Summary

Phase 6 建立了「迁移后可审计」的统一引擎：**append-only、持久、可查询、可导出的迁移历史**，覆盖全部 §5 destructive/migration 操作，作为三段式引擎（迁移前咨询 → 迁移中 Journal → 迁移后审计）的收尾。

新增核心实现：
- **`src/core/migration-history.ts`**：per-file append-only 存储（`<dataDir>/migration-history/`），原子写（0600 + symlink-reject），白名单字段模型，内联 `contentHash` 篡改检测，查询 / 统计 / 导出（JSON/Markdown）纯函数，retention（删最旧 / 幂等），双重 redaction（`redactHistoryText` 无损掩码 + `scanAndRedact` 高熵残留防线）。
- **`src/ui/history-model.ts`**：框架无关纯渲染模型（node 可测）。
- **`src/client/history/`**：`HistoryPanel.tsx`（过滤 + 统计 + 分组列表 + 导出）+ `history-api.ts`（类型化 fetch）+ `history-locales.ts`（ns `config-manager-history`，zh 源/en 镜像）。
- **接线**：13→14 类操作全部在结果确定后 best-effort 写入历史（见 §3）。
- **API**：`GET /history`、`GET /history/export`（过滤 + loopback fence）。

---

## 2. Step-by-step

| Step | 内容 | 状态 | 交付 |
|---|---|---|---|
| 1 | Analysis（枚举写入口/历史碎片/数据模型/redaction 边界） | PASS | `PHASE6_ANALYSIS.md`（commit 74181a2） |
| 2 | Design（数据模型 + 存储 + 查询 + 导出 + 接线 + RESERVED） | PASS | `PHASE6_DESIGN.md`（commit 8de5d52） |
| 3 | 独立只读评审（Durability/Append-only/Redaction/Integration/Windows 5 reviewer） | PASS → Gate=GO | 全部 APPROVE，无 P0；所有 P1/P2 裁决吸收 |
| 4 | Core store `migration-history.ts` + 测试 | PASS | commit 3bb959d（+24 用例） |
| 5 | 接线全部 §5 操作（best-effort + durable） | PASS | commit 977a2fa |
| 6 | API：/history + /history/export + 过滤 + loopback fence | PASS | commit 977a2fa |
| 7 | UI：HistoryPanel + 纯渲染模型 + 过滤 + 导出 | PASS | commit 85bd2c2 |
| 8 | i18n：history-locales（zh/en，独立 ns） | PASS | commit 85bd2c2 |
| 9–11 | 测试（core / redaction / append-only / retention / UI 纯函数） | PASS | 新增 35 用例（24 core + 10 model + reserved prefix 1） |
| 12 | Real DSH E2E（隔离 DSH_HOME） | PASS | `phase6-e2e/PHASE6_REAL_DSH_E2E_REPORT.md` |
| 13 | Full Validation + 本报告 | PASS | 本文件 |

---

## 3. COMPLETE 接线清单（§5 全 14 类）

| kind | 接线点 | best-effort | BOUND |
|---|---|---|---|
| import | `/execute` runs.finish 后 | ✓ | operationId(journalCtx) + snapshotId + runId |
| restore | `/restore` runs.finish 后 | ✓ | snapshotId + runId |
| rollback | `/sync/rollback` 成功 | ✓ | snapshotId |
| profile-switch | `/profiles/execute-switch` | ✓ | operationId + runId |
| profile-delete | `/profiles/delete` | ✓ | — |
| profile-rename | `/profiles/rename` | ✓ | — |
| profile-save | `/profiles/save` | ✓ | — |
| profile-import | `/profiles/import`（Integration 评审补） | ✓ | — |
| sync-apply | `/sync/apply-items` | ✓ | operationId + snapshotId(restoreId) |
| autosync | `autosync-scheduler.runOnce`（经 appendHistoryFn 合成） | ✓ | — |
| recovery | `/recovery` execute/retry/verify/dismiss（terminal 点） | ✓ | operationId |
| backup | `backup-scheduler.runOnce`（新增 appendHistoryFn） | ✓ | — |
| snapshot-delete | `/snapshots/delete` | ✓ | snapshotId |
| snapshot-prune | `FileSnapshotStore.prune()` 经宿主 `onPrune` 回调 | ✓ | — |

> `export`（备份）非 §5 清单 → **不写历史**（E2E 负向控制证实无越界）。
> 每个入口均经 `tryAppendHistory`：写失败仅 `host.log.warn` + 响应体 `historyWriteError` 字段，**绝不阻断操作、绝不静默丢**。

---

## 4. Architecture Compliance（无第二套 framework）

| 复用 | 用途 |
|---|---|
| `atomicWriteFile`（Phase 1） | 历史 per-file 原子写（0600 + symlink-reject） |
| `journal.ts` per-file append 模式 | migration-history 存储形态同构 |
| `scanAndRedact` + `redact`（security） | 双重 redaction |
| `paths.ts RESERVED_INTERNAL_PREFIXES` | 新增 `dsh-config-manager/migration-history/` 防 F23 投毒链 |
| `run-registry.ts RunKind` 枚举 | MigrationKind 语义映射 |
| `env-lock` | 写入时机随 mutation lock（后台路径由 per-file 原子性保障并发） |

**未新建**：不新增第二套 journal / transaction / lock / snapshot-trust framework。`migration-history.ts` 是**新能力**（审计史），非重复基础设施。**未修改**已评审的 Phase 1–5 核心引擎行为（仅追加可选回调 / 结果点写入）。

---

## 5. Core Invariant Verification

| 不变量 | 验证 |
|---|---|
| **DURABLE** | 单测「append→新实例读回」（migration-history.test）+ **E2E 重启持久**（杀 DSH 重启 3 条目保留） |
| **APPEND-ONLY** | per-file 独立文件 + 原子写 + 无 update/delete API（架构断言）；**contentHash 篡改检测**（篡改合法 JSON 字段 → hash 不符 → corrupted 跳过）；retention 只删最旧合法条目、幂等、脏文件忽略 |
| **COMPLETE** | MigrationKind 枚举断言 = §5 全 14 类；全部接线点；export 负向控制 |
| **REDACTED** | summary/error 双重清洗（value-shape + 高熵 28+ token）→ 落盘读回 masked 无原值；错误文本保留非敏感上下文；白名单字段（枚举/UUID）；渲染前 redact() 兜底 |
| **QUERYABLE** | query（kind/result/时间/sections）纯函数 + API `?kind=&result=` 过滤 |
| **EXPORTABLE** | renderExport(json/markdown) 纯函数 + API 导出（E2E 验证合法输出） |
| **BOUND** | operationId / snapshotId / runId 关联（sanitizeEntry 校验 UUID 后保留） |

---

## 6. Test Matrix

- **新增 35 用例**（全绿）：
  - `src/core/migration-history.test.ts`（24）：DURABLE / APPEND-ONLY（独立文件、篡改检测、损坏 JSON、basename 校验、retention 删最旧/幂等/脏文件、无改删 API）/ REDACTED（value-shape、高熵、无损掩码、source 校验、UUID 剥离）/ QUERYABLE / EXPORTABLE / best-effort / BOUND。
  - `src/ui/history-model.test.ts`（10）：徽章语义 / 分组 / 统计 / 过滤 / 最近 N / 文本子串 / FILTER 映射 / COMPLETE 枚举。
  - `tests/core/snapshot-trust.test.ts`（1）：migration-history 保留前缀（F23 投毒链闭合，含大小写/反斜杠/.. 变体）。
- **全量回归**：`npm test` **1405/1405 PASS**（≥ 基线 1370）；typecheck PASS；build PASS；smoke 12/12 PASS。
- **Real DSH E2E PASS**（隔离 DSH_HOME，E2E 报告见 §7）。

---

## 7. Real DSH E2E

隔离 `DSH_HOME=phase6-e2e/dsh-home` + web profile 端口 3091。验证：
- 插件挂载、空历史、profile save/rename/delete + snapshot-delete 写历史、**重启持久（3 条目保留）**、过滤、导出（json/markdown）、loopback fence 403、export 不写历史。
- 完整场景矩阵与证据见 `phase6-e2e/PHASE6_REAL_DSH_E2E_REPORT.md`。

---

## 8. P0 / P1 / P2

### P0（0 个）
无。

### P1（0 个 unresolved）
无。Integration 评审提出的 P1（profile-import 缺失、sections 来源不实、snapshot-prune 污染核心引擎、recovery 结果点）**全部在实现中解决**（见 PHASE6_DESIGN.md §6.1 裁决汇总）。

### P2（已记录，非本阶段阻塞）
- **语义篡改边界**：contentHash 检测覆盖**任意字节级篡改**（含合法 JSON 改字段值）；但「完全重写为合法新条目」不可与「追加新条目」区分（审计史非对抗性安全边界，Phase 1 已统一原子写，不为历史引入 MAC/签名链）。已文档化。
- **短 token（<28 字符且不匹配值形状）**：可能逃逸双保险脱敏——与既有 journal 边界同构的已知权衡，已文档化。
- **后台路径（autosync/backup/recovery）写失败仅日志，UI 无即时感知**（历史本身可重载验证）；非静默（有日志）。
- **backup-scheduler 历史写失败不阻断备份**（best-effort 设计使然）。

---

## 9. Deferred（未纳入 Phase 6 Scope）

- 不把 export（备份产物）纳入迁移历史（产物本身可审计；§5 不清单）。
- 不合并 sync-history 到统一历史（保持既有独立视图；统一历史与 sync-history 并存）。
- 不在历史条目上加来源签名/密钥链（防第二套 framework + 非对抗性边界）。
- 不为历史新建独立设置页（复用「迁移历史」低频面板 tab）。

---

## 10. Final Verdict

```
typecheck  : PASS
build      : PASS
npm test   : 1405/1405 PASS
smoke      : 12/12 PASS
Real DSH E2E : PASS
P0 = 0
unresolved P1 = 0
Core Invariants: DURABLE / APPEND-ONLY / COMPLETE / REDACTED / QUERYABLE / EXPORTABLE / BOUND 全部成立
Architecture: 复用既有模式，无第二套 framework，未改已评审核心引擎行为
```

**PHASE6 IMPLEMENTATION = PASS。** 已停止等待阶段确认，不自动进入下一阶段。
