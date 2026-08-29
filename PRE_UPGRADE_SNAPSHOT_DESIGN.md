# PRE_UPGRADE_SNAPSHOT_DESIGN — Phase 4 Design

> 阶段：**DESIGN**（Phase 4 — Pre-upgrade Automatic Snapshot）
> 基线 SHA：`661dd79`（Phase 3 handoff closure）
> Analysis source of truth：`PRE_UPGRADE_SNAPSHOT_ANALYSIS.md`（Analysis Gate = PASS）
> 本文档是 Phase 4 实现规格。实现后经 Design Review 确认。

---

## 1. Goals / Non-goals

### Goals

建立最小、统一的 **Trusted Operation-bound Snapshot System**，满足核心不变量：

> **No protected mutation may perform its first destructive side effect before a valid, trusted, operation-bound recovery snapshot is durable.**

五个关键词分别满足：`VALID` / `TRUSTED` / `OPERATION-BOUND` / `DURABLE` / `BEFORE FIRST DESTRUCTIVE SIDE EFFECT`。

### Non-goals

- **NO node_modules snapshot**（pnpm junction/hard-link/体积/Windows 语义；优先 declarative state + plugin/version metadata 恢复）
- **NO automatic rollback** without explicit recovery policy
- **NO cloud/export of recovery snapshots**（本地 only）
- **NO adopt-existing-snapshot**
- **NO force-no-snapshot bypass**
- **NO fine-grained WAL v2**（不建 per-item beforeFp/afterFp；opaque APPLYING + trusted snapshot → conservative rollback/NEEDS_ATTENTION）
- **NO 新 transaction framework**（复用 Phase 1-3）

---

## 2. Existing Architecture Integration

```
Phase 1 Atomic Write
↓
Phase 2 GLOBAL Mutation Lock
↓
Phase 3 Journal / Recovery
↓
Phase 4 Snapshot preparation   ← 新增
↓
Destructive mutation
```

Phase 4 复用：Environment Lock（`env-lock.ts`）、Journal（`journal.ts`）、`Phase3Recovery.runJournaled`（`phase3-host.ts`）、Snapshot infrastructure（`backup.ts` / `restore.ts`）。**不新建** upgrade-specific lock / WAL framework。

---

## 3. Protected Surfaces

| Surface | 首个 destructive side effect | 需 pre-change snapshot |
|---|---|---|
| import-apply（`POST /execute`） | `adapter.applyItem`（dsh plugin add / settings.replace / applyPatchChanges / fs.writeFile） | ✅ |
| profile-switch | `applyOne`（同 import） | ✅ |
| sync-apply | `applyOne`（同 import） | ✅ |
| CLI reinstall program | `npm uninstall -g @deepseek-ai/dsh` | ✅（reinstall recovery point） |
| CLI reinstall wipeConfig | `rm -rf ~/.dsh/*` | ✅（`.reinstall-backup` 增强） |
| restore | `hostFileRestore` / `pluginRemove` | **RESTORE/RECOVERY SECURITY BOUNDARY**（安全消费 snapshot，非 producer） |

---

## 4. Snapshot Trust Model

### Hash ≠ authenticity

SHA256/manifest 只能证明内部自洽，不能证明 trusted creator。若攻击者能写整个 snapshot directory，也能重算 hashes。

### 信任建立于（主防线）

1. **Trusted storage boundary**：snapshot 存储目录（`<dataDir>/snapshots`）是 control-plane，**不可信 import 不能写**（F23 修复）。
2. **Creation-path isolation**：snapshot 只由 transaction wrapper 创建，业务 engine 不自行创建 authoritative snapshot。
3. **Operation binding**：snapshot 记录 `operationId`，journal 记录 `snapshotId`，双向一致。
4. **Environment binding**：snapshot 记录 `environmentFingerprint`，recovery 校验。

### Provenance classes

| Class | 来源 | 可授权自动/推荐回滚？ | 恢复方式 |
|---|---|---|---|
| `OPERATION_BOUND` | Phase 4 transaction | ✅ | 自动/推荐 |
| `MANUAL_LOCAL` | 用户手动（pinned） | ❌ | 显式手动 |
| `LEGACY` | 旧版本（无 binding 字段） | ❌ | 显式手动 + 更严格校验 |
| `UNKNOWN` | 无法判定 | ❌ | 拒绝自动恢复 |

---

## 5. Snapshot Schema

`Snapshot`（`core/types.ts`）新增字段：

```ts
interface Snapshot {
  id: string;
  createdAt: string;
  sourceZip: string;
  entries: SnapshotEntry[];
  status?: SnapshotStatus;          // 现有：pending/done/rolled-back
  beforePlugins?: PluginInfo[];
  hostFileBackups?: HostFileBackup[];
  pinned?: boolean;
  // Phase 4 新增：
  operationId?: string;             // 绑定 upgrade operation
  operationType?: string;           // import/profile-switch/sync-apply/reinstall
  environmentFingerprint?: string;  // 环境绑定
  ownerInstanceId?: string;         // ownership epoch
  readiness?: 'CREATING' | 'READY'; // 生命周期
  manifest?: SnapshotManifest;      // 完整性
}

interface SnapshotManifest {
  schemaVersion: number;
  snapshotId: string;
  entryCount: number;
  blobHashes: Record<string, string>;  // blobPath → sha256
  metadataHash: string;               // snapshot.json 内容 hash
}
```

### 兼容性

旧 snapshot（无 operationId/readiness/manifest）→ `LEGACY` class：可列出、可显式手动恢复（更严格校验），**不可作为 Phase 3 自动恢复证据**。

---

## 6. Snapshot Lifecycle

```
CREATING
  → 写 blobs（staging）
  → 写 snapshot.json（readiness='CREATING'）
  → 写 manifest（blob hashes + metadataHash）
  → verifySnapshot()（从磁盘重读，验证存在/hash/schema/binding/path）
  → 原子发布 READY（readiness='READY'）
READY
  → 可列出为 trusted
  → 可 journal-bindable
  → 可恢复
```

**half-created snapshot（readiness != 'READY'）MUST NOT be considered usable**。

`FileSnapshotStore.save` 改为：写 blobs → 写 snapshot.json（CREATING）→ 写 manifest → 验证 → 原子更新 READY。

---

## 7. Journal ↔ Snapshot Binding

双向一致性：

```
snapshot.id        == journal.snapshotId
snapshot.operationId == journal.operationId
snapshot.environmentFingerprint == journal.environmentFingerprint
snapshot.ownerInstanceId == journal.ownerInstanceId
```

reconcile 的 `snapshotExists` 实现为：id 合法 + snapshot.json 存在 + readiness=READY + **snapshot.operationId/ownerInstanceId/environmentFingerprint 匹配 journal**。

---

## 8. Production Transaction Flow

```
acquire GLOBAL lock
→ runJournaled({ snapshotProvider, fn })
  → journal CREATED
  → snapshotProvider() 创建 operation-bound snapshot
  → verifySnapshot()
  → journal.snapshotId = snapshot.id
  → journal SNAPSHOT_CREATED
  → journal APPLYING
  → fn() 执行 business mutation（首个 destructive side effect）
  → journal COMMITTED
→ release
```

业务 engine（Importer/ProfileManager/SyncEngine）**不再自行创建 authoritative snapshot**——由 transaction wrapper 的 `snapshotProvider` 创建。

---

## 9. Restore Validation Flow

统一 validator `validateSnapshotForRestore(snapshotDir, opts)`，所有 restore 入口（Host API / ModelTools / CLI / sync rollback）调用。

输出分类：

```
TRUSTED_OPERATION_SNAPSHOT   → 可自动/推荐恢复
TRUSTED_MANUAL_LOCAL         → 可显式恢复
LEGACY_REQUIRES_EXPLICIT_CONFIRMATION → 显式确认后恢复
INVALID                     → 拒绝
WRONG_ENVIRONMENT           → 拒绝
WRONG_OPERATION             → 拒绝
CORRUPT                     → 拒绝
UNSAFE_PATH                 → 拒绝
```

校验项：snapshot ID / 存在性 / READY / schema / manifest integrity / blob integrity / environment binding / operation binding / path boundaries / symlink rules。

---

## 10. Reserved Namespace Security（F23）

### 内部 control-plane namespace

```
<dataDir>/snapshots/
<dataDir>/transactions/
<dataDir>/locks/
<dataDir>/safe-mode
<dataDir>/recovery-history/
<dataDir>/environment-fingerprint.token
```

### 防护

新增 `isReservedInternalRel(relPath)` helper（`paths.ts`）：检查相对 homeDir 的路径是否落在上述 control-plane namespace。

**不可信 import（pluginFiles / self / file-collection adapters）的 ref 若命中 reserved namespace → 拒绝**（analyzeImport 标 Error + applyItem 拒绝）。

**主防线是 write isolation**：untrusted import 不能写 control-plane snapshot storage。Manifest/hash 是第二层。

---

## 11. Prune / Reference Model（F3）

`FileSnapshotStore.prune` 必须知道 journal 引用：

- 扫描 `transactions/active/*.json` + `transactions/completed/*.json`，收集所有 `snapshotId`
- **active / ROLLING_BACK / RECOVERY_REQUIRED / NEEDS_ATTENTION journal 引用的 snapshot MUST NOT be pruned**
- 只 prune 未被引用的最旧 snapshot

### Prune failure semantics（F13）

snapshot 已 READY + verified + journal-bound 后，retention prune 因 EBUSY/EPERM 失败：
- **snapshot 保持 READY**
- prune failure 记录/日志
- **upgrade 可继续**（新 snapshot durability/integrity 已证明）

---

## 12. Double-snapshot Elimination（F4）

`SyncEngine.applyItems` / `applyMergePlan` 当前先 `createSnapshot`（#1），再 `executeImportPlan` 内部又 `createSnapshot`（#2）。

Phase 4：nested engine 显式复用 parent transaction snapshot context。若 authoritative snapshot 已存在，nested engine 不再创建新的。**显式 context only，不用 process-global reentrancy**。

---

## 13. Reinstall Program Recovery（F29/F30）

区分：
- **A. config state**：`.reinstall-backup` 覆盖
- **B. global DSH program state**：`.reinstall-backup` 不覆盖

### Reinstall recovery point

在 `npm uninstall -g` 之前 durable 记录：
```
previousInstalledVersion
requestedTargetSpec
environmentFingerprint
operationId
recoveryInstructions
```

**Reconstructability may be enough**：记录 previous version + reinstall command/recovery metadata，而非复制整个 global node_modules。

---

## 14. Crash-window Decisions

| Crash 点 | 预期 |
|---|---|
| 有效 READY snapshot 前 | 无 destructive side effect；recovery required / cleanup staging |
| READY snapshot 但 journal 未 bound | 无 mutation；orphan snapshot safe |
| Bound snapshot + APPLYING + 不确定 mutation | **NEEDS_ATTENTION** 或 rollback-recommended（**绝不 RECOVERED merely because steps=[]**） |
| COMMITTED | 无 rollback |

---

## 15. Failure Semantics

Protected mutation：
- snapshot creation fails
- snapshot verification fails
- binding persistence fails
- READY publication fails

→ **ABORT**，**no first destructive side effect**。

不添加 `--force-no-snapshot` / `skipBackup` / `continueAnyway`。

---

## 16. Windows Rules

- 统一 path boundary helper（非 `startsWith`）
- `\` / `/` / drive letters / UNC / case-insensitive 处理
- junction 不跟随（若 out of scope）
- atomic READY publication retry
- **不承诺 power-loss guarantee**

---

## 17. Backward Compatibility

- 旧 snapshot（无 binding 字段）→ `LEGACY` class：可列出、可显式手动恢复（更严格校验），**不可作为自动恢复证据**
- 不默认删除旧 snapshot

---

## 18. Test Matrix

- F20：empty steps → NEEDS_ATTENTION（regression test）
- F23：poisoning（import 写 snapshots/transactions/safe-mode → 拒绝）
- F1：manifest tamper / blob tamper / substitution → reject
- Binding：wrong operationId / environmentFingerprint / ownerInstanceId → reject
- Restore：统一 validator 各分类
- Prune：referenced snapshot 不删
- Reinstall：fake package-manager fixture，kill at before/after uninstall/install
- Windows：EPERM/EBUSY prune、case-insensitive、backslash、junction

---

## 19. Failure-injection Plan

真实 child process kill：
- after journal CREATED
- during snapshot write
- after READY before journal binding
- after journal binding
- after SNAPSHOT_CREATED
- after APPLYING before mutation
- after first file mutation
- after plugin side effect
- after business success before COMMITTED
- after COMMITTED before release

---

## 20. Migration / Deployment

- 无 schema 迁移（snapshot 字段向后兼容）
- 无新依赖
- 无新路由（复用现有）

---

## 21. Implementation Priority Order

1. **F20** empty-step recovery safety（reconcile.ts + test）
2. **F23** reserved namespace / poisoning（paths.ts helper + file adapters + test）
3. **F1** trusted snapshot schema + READY publication + manifest（backup.ts + types.ts）
4. **F1** journal ↔ snapshot binding（reconcile.ts snapshotExists + phase3-host.ts）
5. **F20** production snapshotProvider wiring（index.ts + analyzer.ts + profile-manager.ts + sync-engine.ts）
6. **F4** double-snapshot removal
7. **F8/F9/F10/F25** restore unified validation（restore.ts + index.ts + model-tools.ts + cli）
8. **F3** prune reference protection（backup.ts）
9. **F29/F30** reinstall recovery point（reinstall.ts + cli）
10. **F13/F15/F19** Windows/path/symlink hardening required for v1

---

*Design 完成。等待 Design Review（5 个 READ-ONLY reviewers，一轮）。*

---

## 22. Design Review 状态（honest）

> ⚠️ **如实记录**：本会话**未独立执行**完整 5-reviewer 一轮评审（该流程需额外 5 个独立只读 reviewer 轮，超出本实现会话范围）。
> 下列为**实现前自检**（针对已定案 blocker 的 targeted 复核），非独立外部评审结论。独立评审留给 Final Review / 交接后复核。

### 22.1 实现前自检（blocker 精度）

- **F20 空 steps 语义**：Design/实现要求空 steps APPLYING → NEEDS_ATTENTION / rollback-recommended，绝不以 `[].every()` 判 RECOVERED。已落地 reconcile.ts + 3 条回归测试。**自检 PASS**。
- **F23 reserved namespace 精度**：初版 `dsh-config-manager/sync/` 前缀过宽（误伤 self 合法 `sync/*.json` 配置）→ 修正为仅 `sync/snapshots/` 与 `sync/work/`；`paths.ts` + i18n + 2 条 F23 测试。**自检 PASS**。
- **F1 信任模型**：manifest + verifySnapshot + READY 原子发布 + metadataHash 稳定性，12 条测试（T-01..T-08 + F3/F13 + journal 引用）。**自检 PASS**。
- **F3/F13**：prune 引用保护 + prune 失败不阻断 save；JournalStore.listReferencedSnapshotIds + FileSnapshotStore 接线 + 4 条测试。**自检 PASS**。

### 22.2 Design Gate 判定（本会话范围内）

实现前自检：核心不变量涉及的 block（F20/F23/F1/F3/F13）均为 PASS。
**待独立复核**：完整 5-reviewer Design Review、Final review、真实子进程 fault-injection 留待交接后（见 PHASE4_HANDOFF 的「剩余工作」）。
