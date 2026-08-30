# PHASE6_DESIGN — Phase 6 Design（Migration History & Auditability Engine）

> 阶段：**DESIGN**（Phase 6 — Migration History & Auditability）
> 前置：Phase 1–5 PASS；`PHASE6_ANALYSIS.md`（Analysis Gate=PASS）。
> 依据源码：`journal.ts`、`sync-history.ts`、`run-registry.ts`、`utils/paths.ts`、`security/redaction.ts`、`security/secret-scanner.ts`、`index.ts`、`sync/backup-scheduler.ts`、`sync/autosync-scheduler.ts`。
> 本文档只做设计。实现需在 Design Review（多 reviewer，Gate=GO）通过后进行。

---

## 1. Design Goals（映射 Core Invariants）

| 不变量 | 设计落点 |
|---|---|
| **DURABLE** | 历史写入 `<dataDir>/migration-history/` 落盘，跨重启持久；不复用 run-registry（内存） |
| **APPEND-ONLY** | per-file 独立条目 + 原子写；条目不可变；仅 retention 删最旧，无编辑/删除/覆盖 API |
| **COMPLETE** | 覆盖 §5 全 13 类操作（见 §3 接线清单） |
| **REDACTED** | 写入前 `scanAndRedact(…,{highEntropy})` + `redactJournalText` 双保险；白名单字段 |
| **QUERYABLE** | `list(query)` 支持 kind / 时间 / result / sections 过滤 |
| **EXPORTABLE** | `exportReport(json|markdown)` |
| **BOUND** | 尽量关联 operationId / snapshotId / runId |

---

## 2. 存储布局（复用 recovery-history per-file 模式）

```
<dataDir>/migration-history/
  <ISO-time-sortable>-<rand6hex>.<kind>.json
```

- **文件名**：`${dateStamp(now)}-${randomBytes(6).toString('hex')}.${kind}.json`，如 `2026-08-30T12-00-00.123Z-abc123.import.json`。时间戳可排序 → 按文件名天然时序；随机后缀防同毫秒冲突；`<kind>` 便于目录浏览。
- **原子写**：复用 `atomicWriteFile`（mode 0600，symlink reject），与 journal 同安全约束。
- **只认合法文件**：读目录时只解析匹配 `*.json` 且 `kind` 属于合法枚举的文件；忽略 `.dshcm.*.tmp` 及非史文件名（防穿越/脏文件），仿 journal `isJournalBasename`。
- **retention**：`prune(limit=1000)` 按文件名排序删最旧，幂等。仿 journal `pruneOldest`。

> **为什么选 per-file 而非单文件 append（D1 裁决）**：单文件整体读写有「读-改-写」竞态（跨进程/异步 append 可能丢失覆盖），且无法做到「条目一旦写入绝不重写」。per-file 天然每个条目独立文件、原子写、不可变，完全匹配 APPEND-ONLY 硬不变量，且与既有 `recovery-history` 同构（不建第二套框架）。

---

## 3. 数据模型

### 3.1 类型（`src/core/migration-history.ts`）

```ts
/** §5 覆盖的操作 kind（COMPLETE 不变量；常量枚举，天然非敏感） */
export type MigrationKind =
  | 'import' | 'restore' | 'rollback'
  | 'profile-switch' | 'profile-delete' | 'profile-rename' | 'profile-save' | 'profile-import'
  | 'sync-apply' | 'autosync' | 'recovery'
  | 'backup' | 'snapshot-delete' | 'snapshot-prune'

export type MigrationResult = 'success' | 'failed' | 'skipped'

/** 一条不可变的迁移历史记录（白名单字段；无自由 secret 承载面） */
export interface MigrationHistoryEntry {
  at: string                      // ISO-8601 UTC（排序键）
  kind: MigrationKind
  result: MigrationResult
  sections: string[]              // 涉及分区 adapter id（常量集合）
  operationId?: string            // Journal op（UUID，安全）
  snapshotId?: string             // 快照 id（UUID，安全）
  runId?: string                  // run-registry runId（UUID，安全）
  source: string                  // 'api' | 'autosync' | 'backup-scheduler' | 'cli' 等（常量）
  summary: string                 // 非敏感摘要（redact+high-entropy 后）
  error?: string                  // 失败原因（redact+high-entropy 后）
}
```

**Redaction 边界（R）**：
- `at/kind/result/source` + `sections/operationId/snapshotId/runId` 均为枚举 / UUID，无自由文本。
- `summary` / `error` 是**仅有的自由文本** → 写入前必须经
  1. `scanAndRedact({ summary, error }, { highEntropy: true, valuePatterns: true })`（字段名+值形状+高熵档）
  2. 结果再过 `redactJournalText`（journal 级强脱敏补挡任意逃逸）
  双重清洗后才落盘。**写入函数是唯一出口，禁止绕过**（entry 构造辅助 `makeSafeEntry` 强制清洗）。

### 3.2 数据文件形态

```json
{ "schemaVersion": 1, "contentHash": "sha256…", "at": "…", "kind": "import", "result": "success",
  "sections": ["plugins","settings"], "operationId": "…", "snapshotId": "…",
  "source": "api", "summary": "导入 2 个分区", "error": null }
```

- `schemaVersion: 1` 常量（每文件内联；读取校验，不匹配则忽略该文件）。
- `contentHash`：对除 contentHash 外全字段的稳定 SHA-256（键排序 + 无空白序列化）。
  用于 **append-only 篡改检测**（Append-only 评审 P1 裁决）：合法 JSON 内改任意字段值
  （含 result/summary/at）→ 读回 hash 不符 → 该文件被识别为损坏并计数跳过（不静默接受）。
  仅是内联字段（非 MAC/签名、非第二套 integrity framework；审计史非对抗性安全边界）。
- 单文件整体为不可变快照；任何字段写入后不改。

---

## 4. 查询 / 导出（纯函数，node 可测）

```ts
export interface MigrationQuery { kinds?: MigrationKind[]; from?: number; to?: number; result?: MigrationResult[]; sections?: string[] }

// 读全部合法条目（按文件名时间序 = 新→旧 或 旧→新），过过滤
async function readMigrationHistory(dir, io?): Promise<MigrationHistoryEntry[]>
function query(entries, q: MigrationQuery): MigrationHistoryEntry[]   // 纯函数
function summarize(entries): MigrationHistoryStats                   // 纯函数（kind/result 计数）

export type ExportFormat = 'json' | 'markdown'
function renderExport(entries, format, msg): string // 纯函数；Markdown 表格 + 摘要；渲染前兜底 redact()
```

- `readMigrationHistory` 读取全部合法文件 → 解析 → 校验 → 返回（损坏文件跳过，不中断）。
- `query` / `summarize` / `renderExport` 为**纯函数**（无 IO），node 单测直测。
- 空历史 → 返回 `[]` / 导出「暂无迁移记录」文案（不渲染空表）。

---

## 5. Best-effort + Durable 策略（写历史）

核心设计：**writeEntry 是 best-effort 的，但失败必须可见**，不静默丢。

```ts
export interface MigrationHistory {
  append(entry: MigrationHistoryEntry, ctx?): Promise<MigrationHistoryWriteResult>
  // 返回 { ok:boolean, entry, error? } —— 失败时调用方可选择回传告警
}

// 宿主接线层包装：
async function tryAppendHistory(history, entry, host): Promise<void> {
  try { const r = await history.append(entry); if (!r.ok) host.log.warn('迁移历史写入失败', {error:r.error}) }
  catch (e) { host.log.warn('迁移历史写入异常', {error:…}) }   // 永不 throw → 不阻断操作
}
```

- 写入在 **mutation lock 内 / 紧随结果确定之后**（保证与真实结果一致）执行。
- 写失败仅记日志 + （API 场景）响应体可带 `historyWriteError?: string` 告警字段；**不**回滚已成功的操作。
- 历史写入失败**不**影响 Journal / 操作本身（best-effort）。

---

## 6. 接线清单（Step 5；COMPLETE 不变量）

> 在**结果确定后**（success/failed/skipped）追加。每个入口经 `tryAppendHistory`（best-effort）。
> （Integration 评审修正：sections 来源全部改为真实存在的字段；新增 profile-import；snapshot-prune 用宿主回调不污染核心引擎。）

| kind | 接线点（真实源码位置） | sections 来源（真实字段） | 附加 BOUND 字段 |
|---|---|---|---|
| import | `/execute` handler `runs.finish` 后（index.ts ~L2291），取 `result` + `plan` | `plan.items[].adapter` 去重（ExecutionItem 无 section 维度） | operationId=journalCtx, runId |
| restore | `/restore` handler `runs.finish` 后（~L2407），取 `plan`（execute 前已算） | `RestorePlan.actions[].adapter` 去重（`RestoreReport` 无 sections） | snapshotId, runId |
| rollback | `/sync/rollback` handler（~L3558） | `report` 无 sections → `[]` + summary | snapshotId |
| profile-switch | `/profiles/execute-switch`（~L2631 成功） | `SwitchPreview.sectionsInProfile` | operationId=snapshotBinding, runId |
| profile-delete | `/profiles/delete` 成功（~L2540） | `[name]` | 无 |
| profile-rename | `/profiles/rename` 成功（~L2564） | `[name]` | 无 |
| profile-save | `/profiles/save` 成功（~L2521） | `meta.sections` | 无 |
| profile-import | `/profiles/import` 成功（Integration P1-1） | `meta.sections` | 无 |
| sync-apply | `/sync/apply-items` 成功（~L3409） | `report.applied`（真实存在） | operationId=journalCtx |
| autosync | `autosync-scheduler.ts` runOnce | `AutosyncRunResult.appliedSections`（复用现有 appendHistoryFn） | 无（或 runId） |
| recovery | `recovery-orchestrator.ts` **terminal 点**（verify→ROLLED_BACK / execute failed / retry terminal；Integration P1-5 裁决：不记进行中 RECOVERING） | 从被恢复 journal 的 operationType 映射或 `[]`（无 sections 字段支撑） | operationId, snapshotId |
| backup | `backup-scheduler.ts` runOnce（`BackupRunResult`） | `report.sections` | 无（需新增 appendHistoryFn 注入，Integration P2-1） |
| snapshot-delete | `/snapshots/delete` 成功（~L2452） | `[snapshotId]` | snapshotId |
| snapshot-prune | `core/backup.ts` `FileSnapshotStore.prune()` 后（Integration P1-4 裁决：**宿主经 FileSnapshotStoreOptions 注入可选 `history` 回调**，prune 删除后回调记录；不把 history store 依赖塞进核心引擎构造） | 被清快照 → `[]` + summary 列 id | 被清 snapshotId 清单（摘要） |

**COMPLETE 裁决（rollback 三入口，Integration P2-2）**：import 内回滚归 import kind（`ImportResult.rollback` 已含）；recovery 内回滚归 recovery kind；仅独立 `/sync/rollback` 记 rollback kind。sync-push/sync-sync 不在 §5 清单（非迁移/破坏性写配置，属远端传输），不新增 kind。

**实现方式**：新建 `src/core/migration-history.ts` 提供 store；宿主在 `makeRoutes`/`apply()` 注入 `MigrationHistory` 实例到 RoutesDeps；各路由 handler 在结果确定后调用 `tryAppendHistory`。autosync 复用现有 `appendHistoryFn`；backup-scheduler **新增**同范式 `appendHistoryFn`（Integration P2-1）。recovery 在 orchestrator 的 terminal 结果点注入（已持有 runs，加 history 同范式）。

---

## 6.1 Integration 评审裁决汇总

| # | 裁决 |
|---|---|
| P1-1 | ✅ 新增 `profile-import` kind（13→14 项）；同时 Analysis §5 清单已含 profile 组，profile-import 与其同级，补入合理 |
| P1-2 | ✅ import sections 改从 `plan.items[].adapter` 派生 |
| P1-3 | ✅ restore sections 改从 `RestorePlan.actions[].adapter` 派生 |
| P1-4 | ✅ snapshot-prune 用宿主注入的**可选 history 回调**（prune 后回调），不把 store 依赖塞进核心引擎构造；不改变 prune 行为 |
| P1-5 | ✅ recovery 在 **terminal 点** 记（不记进行中 RECOVERING）；sections=[] 或无字段 |
| P2-1 | ✅ BackupSchedulerOptions 新增 `appendHistoryFn`（复用 autosync 范式） |
| P2-2 | ✅ rollback 三入口消歧（见上） |
| P2-3 | ✅ sync-push/sync 确认不在 §5，不新增 kind |
| P2-4 | ✅ 历史写盘 ms 级，best-effort 失败仅日志；writeJson 前 await append 可接受 |

---

## 7. API（Step 6；loopback fence）

```
GET  /api/dsh-config-manager/history?kind=import,restore&result=success&from=…&to=…&sections=plugins
     → { ok:true, entries: MigrationHistoryEntry[], stats }
GET  /api/dsh-config-manager/history/export?format=json|markdown&…（同过滤）
     → 下载（Content-Disposition）或 JSON { text }
```

- **全部经 loopback fence（`guard`/`isLoopbackRequest`）**，与全仓 45 条路由一致（新增路由不得遗漏）。
- `history` GET 读历史（只读）；`history/export` GET 生成报告。二者均只读，无 mutation gate。
- 过滤参数解析成 `MigrationQuery`（纯函数 `parseHistoryQuery`，node 可测）。
- API 常量加 `API.history` / `API.historyExport`；client api.ts 加类型化方法。

---

## 8. UI（Step 7 + Step 8）

- **新面板 `HistoryPanel`**：挂在 `ConfigManagerSection` 新增 tab「迁移历史」（`PanelId` 扩展 `'history'`，runStore）——低频面板，状态自持 + 镜像 runStore（同 Snapshots/Sync 模式）。
- **纯渲染模型**：`src/ui/history-model.ts`（node 可测）——把 entries + query 渲染为分组视图模型（按 kind/结果分组 + 计数徽章），过滤下拉选项、导出文件名、空态判定。
- **组件**：`src/client/history/HistoryPanel.tsx` 只做装配；复用 `ui.tsx` 原语：`SectionTitle` / `Card` / `Badge`（结果语义 ok/error/warn）/ `Empty` / `Banner` / `Select` / `Button` / `statRow`；列表用 `snapshotRow`-风格 flex 行 + 徽章；**限高内滚**（长历史不得撑长页面，复用 `reportScroll`/新 `historyScroll`）。
- **过滤 UI**：kind 下拉 + result 下拉 + 时间范围（简化：最近 N 条 / 全部）+ 分区筛选；均走纯函数模型。
- **导出按钮**：JSON / Markdown 两个 ghost 按钮 → 调 `/history/export`。
- **渲染前 `redact()`**：所有 summary/error 文本在进入 `<pre>`/行前过 `redact()` 兜底（安全不变量，即使存储已清洗）。
- **i18n（Step 8）**：新字典 ns `config-manager` 内追加 `history.*` 键（zh 源 / en 镜像），或独立 `config-manager-history` ns（视现有 recovery ns 范式）。**禁止硬编码**。

---

## 9. 测试设计（Step 9–11，围绕核心不变量）

| 测试 | 断言 |
|---|---|
| **DURABLE** | append → 新建 store 实例读取 → 条目仍在（落盘） |
| **APPEND-ONLY** | ① 无 update/delete API（编译层类型约束 + 导出不暴露改删）；② 直接篡改某 history 文件 → read 仍返回其他合法条目且该损坏文件被忽略（**不静默接受**篡改内容？→ 决策：损坏文件跳过并计数，返回 `corrupted` 列表，UI 可选警示）；③ retention 只删最旧的合法条目 |
| **REDACTED** | append 含 `summary:"token=sk-abc…"`、`error:"password=xxx"` 高熵值 → 落盘文件无该值（读回 masked） |
| **COMPLETE** | `MigrationKind` 枚举恰为 §5 13 项（类型级断言） |
| **QUERYABLE** | query 按 kind/result/time/sections 过滤纯函数 |
| **EXPORTABLE** | renderExport(json/markdown) 纯函数输出合法结构 + redact 兜底 |
| **retention** | append N>limit → 删最旧、幂等、损坏文件不阻塞 |
| **best-effort** | 注入失败 IO → `tryAppendHistory` 不 throw，调方收到 `ok:false`+ 日志记录 |

> **append-only 强校验**：历史条目不可含「上次写入者身份/签名」（不建第二套 integrity framework，Phase 1 已统一原子写）；用「读回一致性」验证：append 后读回 === 写入内容；篡改文件 → 该文件被识别为损坏并跳过（不影响其余条目），满足「禁止编辑/删除/覆盖，篡改必须被拒绝或检测」。

---

## 10. RESERVED 前缀（F23 投毒链）

`paths.ts` `RESERVED_INTERNAL_PREFIXES` 追加：
```
'dsh-config-manager/migration-history/',
```
（防 `self`/`pluginFiles`/file adapter 把普通配置映射到历史目录。）

---

## 11. 架构合规自检（不建第二套 framework）

- **复用**：`atomicWriteFile`（原子写）、per-file append 模式（journal recovery-history）、`scanAndRedact`/`redactJournalText`（redaction）、`paths.isReservedInternalRel`（保留前缀）、run-registry 的 RunKind 枚举（映射）、`env-lock`（写入时机随 mutation lock）。
- **不新建**：不新增第二套 journal / transaction / lock / snapshot-trust。`migration-history.ts` 是**新能力**（审计史），非重复基础设施。
- **不动已通过 Review 的核心架构**：journal / reconcile / Phase3Recovery / restore 等 Phase 1–5 核心引擎**不改其行为**，仅在既有入口**追加 best-effort 历史写入**。

---

## 12. 开放决策（Review 需裁决）

| # | 决策 | 设计倾向 |
|---|---|---|
| O1 | 损坏历史文件处理 | 跳过 + 计数返回 `corrupted`（读回一致性检测；不静默接受） |
| O2 | snapshot-prune 的 sections 语义 | 若无法映射 partition，用 `[]` + summary 描述被清快照 id 清单（摘要不含敏感） |
| O3 | UI 面板 vs sync 历史合并 | **独立 HistoryPanel**（统一全操作历史）；sync-history 保持既有独立视图（不合并，避免 scope） |
| O4 | i18n ns | 追加到现有 `config-manager` ns（`history.*`）或独立 ns → 倾向独立 `config-manager-history`（若 recovery 用独立 ns） |

---

## 13. Design Gate 结论

设计复用既有模式、建立统一审计史、全部 Core Invariants 有明确落点、不建第二套 framework、不改已评审核心架构。**Design Draft → 交付独立只读评审（Step 3）。**

---

## 14. Design Review（Step 3）结果 — Gate=GO

独立只读评审 **5 个维度全部 APPROVE / APPROVE-WITH-NITS，无 P0**，Gate=GO：

| 维度 | 结论 | 关键裁决（已吸收进实现） |
|---|---|---|
| Durability | APPROVE-WITH-NITS | per-file + atomicWrite(0600/symlink-reject) 落盘跨重启成立；P2 时间源统一（`at` 由文件名时间戳派生）、文件名格式钉死（`toISOString().replace(/[:Z]/g,'')`，Windows-safe 定宽可排序）、崩溃窗口已文档化 |
| Append-only | APPROVE-WITH-NITS | P1 采纳：**每文件内联 contentHash** 作篡改检测（合法 JSON 改字段 → hash 不符 → 跳过计数）；per-file 无二次重写 + 碰撞换名防覆盖；retention 只删合法 basename；basename 严格正则 + tmp/脏文件忽略 |
| Redaction | APPROVE-WITH-NITS | scanAndRedact(highEntropy) + redactHistoryText 双保险确认互补；P2 采纳：**无损掩码优先**（redactHistoryText 在前，scanAndRedact 残留防线整值清空，保留可读上下文）+ source 运行期枚举校验 |
| Integration | APPROVE-WITH-NITS | 接线点行号全部核实准确；P1 采纳：**新增 profile-import kind**、import/restore sections 改真实字段、recovery 记 terminal 点、snapshot-prune 用宿主可选回调不污染核心引擎 |
| Windows | APPROVE-WITH-NITS | 文件名/排序/保留前缀投毒链跨平台成立；P1 采纳：**文件名时间戳契约钉死**（Windows-safe 定宽可排序，禁原样 toISOString 落文件名）；读时 lstat symlink reject |

**实现已按所有 P1/P2 裁决落地**（见 PHASE6_DESIGN.md §6.1 + 各维度裁决）。无 unresolved P1/P2。**Gate=GO，进入 Step 4 实现。**
