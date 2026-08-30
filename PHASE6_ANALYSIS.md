# PHASE6_ANALYSIS — Phase 6 Analysis（Migration History & Auditability Engine）

> 阶段：**ANALYSIS**（Phase 6 — Migration History & Auditability）
> 前置：Phase 1–5 全部 PASS；HEAD = `b96d4f5`；全量测试 1370/1370 PASS；typecheck / build PASS。
> 本文档只做分析，**不含任何 Phase 6 实现**。Design 需在 Analysis Gate 通过后另行进行。
> 依据：`run-registry.ts`、`journal.ts`、`sync-history.ts`、`sync/backup-scheduler.ts`、`sync/autosync-scheduler.ts`、`utils/paths.ts`、`security/redaction.ts`、`security/secret-scanner.ts`、`index.ts`（真实源码，非凭函数名猜测）。

---

## 1. Executive Summary

Phase 1–5 建立了「迁移前咨询（Manifest + 健康评分）→ 迁移中事务（Durable Operation Journal / Crash Journal）→ 迁移后…」。**迁移后可审计**仍是空白：

- `run-registry` 是**内存态**（30 分钟保留，重启即失），不能作为历史源。
- `journal` 的 `recovery-history/` 只审计 recovery/rollback 事件，不覆盖全量操作。
- `sync-history.json` 只记录自动同步 / 一键同步执行。
- **没有统一、持久、append-only、可查询、可导出的全操作迁移历史**。

**Phase 6 应解决**：实现统一历史引擎 `src/core/migration-history.ts`，让用户回答「何时 / 哪个操作 / 改了哪些分区 / 结果如何 / 能否审计」，并覆盖全部 destructive/migration 操作。

---

## 2. 现状历史碎片（真实枚举，非猜测）

| 碎片 | 位置 / 形态 | 持久 | append-only | 覆盖范围 | 用途 |
|---|---|---|---|---|---|
| `RunRegistry` | `src/core/run-registry.ts`（内存 Map） | ✗（30 min 惰性清理） | 只读快照返回，可被 retention 删 | export/import/autosync/sync-apply/backup-schedule/restore/profile-switch/recovery | /progress 轮询 + 刷新恢复的实时状态 |
| `recovery-history/` | `journal.ts` `appendRecoveryHistory`，per-file `${Date.now()}-${hex}.${marker}.json` | ✓ | ✓（retention 200 删最旧） | 仅 recovery/rollback 规整事件 | 审计恢复过程 |
| `sync-history.json` | `sync/sync-history.ts`（append + 裁剪 200，atomicWrite） | ✓ | ✓（裁剪最旧） | 仅 autosync 执行记录 | 自动同步历史 |
| `sync` 内置 apply 行 | `sync-engine.ts`（RunState.log） | 内存 | — | sync apply 逐项 | 执行期间展示 |

**结论**：现有碎片各自覆盖单一领域、互不统一、无统一查询/导出/过滤能力。它们**都**是 Phase 6 的「输入历史」或「现有模式」，而非可替代的新引擎。

---

## 3. 写入口全量枚举（需接入历史的 destructive/migration 操作）

> 依据 `index.ts` 路由 + `backup-scheduler.ts` + `autosync-scheduler.ts` 真实接线。

| # | 操作（kind） | 触发入口 | 现有 run kind / gate | 结果来源 |
|---|---|---|---|---|
| 1 | **import apply** | `index.ts` `/execute`（`withMutationGate('import-apply')`，`runs.register('import')`） | import；deferredSnapshot journalCtx | `ImportResult`（含 sections/applied/skipped/failed） |
| 2 | **restore** | `/restore`（`runs.register('restore')`，runWithMutationLock） | restore | `RestoreReport`（snapshotId） |
| 3 | **rollback** | `core/rollback.ts` `rollback()`（recovery 编排）/ `sync/rollback` 路由 | recovery / sync-rollback | `RollbackReport`（snapshotId + full） |
| 4 | **profile switch** | `/profiles/execute-switch`（`withMutationGate('profile-switch')`，deferredSnapshot） | profile-switch | `result`（snapshotBinding） |
| 5 | **profile delete** | `/profiles/delete`（`withMutationGate('profile-delete')`） | profile-delete | ok |
| 6 | **profile rename** | `/profiles/rename`（`withMutationGate('profile-rename')`） | profile-rename | ok |
| 7 | **sync apply** | `/sync/apply-items`（`withMutationGate('sync-apply')`，deferredSnapshot） | sync-apply | `ApplyItemsReport`（applied/skipped） |
| 8 | **autosync** | `autosync-scheduler.ts` `runOnce` → apply/push | autosync | `AutosyncHistoryEntry`（status） |
| 9 | **recovery** | `recovery-orchestrator.ts`（execute/retry/rollback/verify） | recovery | decisionKind + state |
| 10 | **backup** | `backup-scheduler.ts` `runOnce`（定时备份 + `runExternalIntent` journal） | backup-schedule | `BackupRunResult`（zip/sections） |
| 11 | **snapshot delete** | `/snapshots/delete`（`withMutationGate('snapshot-delete')`） | snapshot-delete | removed 快照 id |
| 12 | **snapshot prune** | `core/backup.ts` `FileSnapshotStore.prune()`（自动保留清理，删最旧+置顶豁免） | 无 run | 被清 id 列表 |
| 13 | **profile save** | `/profiles/save`（无 gate，复用 adapter.export） | 无 run | `meta`（name/sections） |
| 14 | **profile import** | `/profiles/import`（`withMutationGate('profile-import')`，destructive） | profile-import | `meta.sections` |

> 注意：`export`（备份导出）**不在** §5 清单（非 destructive/migration，属备份产物）。autosync 中若实际发生 apply（写本地）也属 migration；**历史须覆盖 autosync 本身**（§5 明确列出），与 `sync-history.json` 并存而非重复。

---

## 4. 数据模型（拟定边界，供 Design 验证）

每条历史记录至少含（§5 硬性要求）：

| 字段 | 类型 | 说明 | Redaction |
|---|---|---|---|
| `entryId` / `at` | string / ISO time | 排序可追溯键 | 无敏感 |
| `kind` | `MigrationKind` 枚举（§5 13 项） | 操作类别 | 常量 |
| `result` | `success` | `failed` | `skipped` | 结果 | 常量 |
| `sections` | `string[]` | 涉及分区（adapter id） | 常量/枚举 |
| `operationId?` | string | 关联 Journal op（BOUND） | UUID（安全） |
| `snapshotId?` | string | 关联快照（BOUND） | UUID（安全） |
| `summary` | string | 非敏感摘要（redact 后） | **必 redact** |
| `error?` | string | 失败原因（redact + high-entropy） | **必 redact** |
| `source` | string | 触发来源（api/autosync/backup-scheduler/cli） | 常量 |

**Redaction 边界**：写入前过 `scanAndRedact(sanitized, { highEntropy: true })`（对象级）+ `redactJournalText`（文本级，高熵长 token 掩码）双保险。**绝不**写入 secret / 凭据 / 密码 / 秘密补录值。历史引擎是「白名单字段」——`sections`/`kind`/结果 都是枚举常量，天然安全；唯一自由文本是 `summary`/`error`。

---

## 5. 存储布局（拟定，供 Design 验证）

复用 journal `recovery-history/` 的 **per-file append-only** 模式（每个条目独立 `<dataDir>/migration-history/<sortable>.json`，原子写，retention 删最旧），而非一个大 JSON 整体重写——这天然满足 append-only 不变量：

```
$DSH_HOME/dsh-config-manager/migration-history/
  ├── 2026-08-30T12-00-00.123Z-abc123.import.json
  ├── 2026-08-30T12-05-11.456Z-def456.restore.json
  └── ...
```

优点：
- 新目录须加入 `paths.ts RESERVED_INTERNAL_PREFIXES`（防 F23 投毒链——`self` 分区等不可信导入不能映射到该目录）。
- 文件名含时间戳可排序 → 天然按时间查询；条目不可变（写入后不改不删，除 retention）。
- 与既有 recovery-history 模式同构，**不建第二套写入框架**。

（若 Design Review 倾向单文件 append（同 sync-history），会在 Design 阶段裁决；本 Analysis 倾向 per-file，理由见 §7。）

---

## 6. 查询 / 导出（拟定）

- **过滤**：`kind` / 时间范围 / `result` / `sections`（子集匹配）。
- **导出**：JSON（全量结构化）/ Markdown（人类可读报告），均须 `redact()` 兜底。
- **API**：`GET /api/dsh-config-manager/history`（列表+过滤）、`GET /api/dsh-config-manager/history/export`（JSON/MD），**loopback fence** 与全仓一致。

---

## 7. 关键架构决策（待 Review 裁决的开放点）

| # | 决策 | 倾向 | 理由 |
|---|---|---|---|
| D1 | 存储形态 | **per-file append-only**（同 recovery-history） | 天然不可变；单文件整体重写有竞态/部分写风险 |
| D2 | 写历史时机 | **与操作结果一致**：成功/失败结果确定时，在 mutation lock 内（或紧随其结果）写入 | 避免记录与真实结果不一致 |
| D3 | best-effort | **写失败不阻断操作**，但必须记录/降级（日志 + 返回体告警字段），不静默丢 | §3 Architecture 硬规则 |
| D4 | run 状态来源 | 历史**不替代** run-registry（内存实时态）；历史是持久审计，run 是实时进度 | 分层职责 |
| D5 | 与 sync-history 关系 | 并存：autosync 既写 sync-history.json（既有语义）也写 migration-history（统一审计） | COMPLETE 不变量要求覆盖 autosync |
| D6 | export 是否入史 | **不入史**（非 §5 清单；备份产物本身可审计） | COMPLETE 以 §5 为准 |

---

## 8. 非目标（Non-Goals，防止 scope drift）

- **不重写 Phase 1–5**：不新增第二套 journal / transaction / lock / snapshot-trust。复用 `atomicWriteFile`、`env-lock`、`redact`、`scanAndRedact`、`paths.isReservedInternalRel`。
- **不做 fine-grained WAL / 精确逐项审计**（Phase 5 non-goal 延续）——历史记录 operation 级摘要，非逐文件变更。
- **不作为运行状态源**（实时进度仍走 run-registry /progress）。
- **不自动进入下一阶段**。

---

## 9. Analysis Gate 结论

现状确认：历史碎片不统一、不持久覆盖全量、无统一查询/导出。Phase 6 需求成立，方案可复用既有模式、不引入第二套 framework。**Analysis PASS → 进入 Design。**
