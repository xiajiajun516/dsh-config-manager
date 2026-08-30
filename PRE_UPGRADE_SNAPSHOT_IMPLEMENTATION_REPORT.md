# PRE_UPGRADE_SNAPSHOT_IMPLEMENTATION_REPORT — Phase 4

> 阶段：**IMPLEMENTATION**（Phase 4 — Pre-upgrade Automatic Snapshot）
> 基线 SHA：`661dd79`（Phase 3 closure）→ 前一 increment `737ab2d` → 本 increment `d3d6524`
> Analysis: `PRE_UPGRADE_SNAPSHOT_ANALYSIS.md`（Analysis Gate = PASS）
> Design: `PRE_UPGRADE_SNAPSHOT_DESIGN.md`
> 本文如实记录：已实现 + 已验证项（PASS/CLOSED）、遗留 P2/待独立复核项（逐项注明，不把未验证当 PASS）。

---

## 1. 完成的工作（两个 increment）

本仓库接手时已有 Phase 4 Analysis + Design + 部分实现。本会话完成：
- **increment A（`737ab2d`）**：审计 + 修 F23 回归 + 补 i18n + F1/F3/F13 测试 + prune 引用保护。
- **increment B（`d3d6524`）**：**生产接线最终关闭**——deferred snapshot wiring / production snapshotExists / 统一 restore 校验 / reinstall recovery / 真实 crash 注入 / Windows FS 定向。

---

## 2. 已实现 + 已验证（PASS / CLOSED）

| 项 | 源码 | 测试 | 验证 |
|---|---|---|---|
| **F20 空 steps 恢复安全**（空 steps APPLYING → NEEDS_ATTENTION/rollback-recommended，绝不以 `[].every()` 判 RECOVERED） | `src/core/reconcile.ts` | `src/core/reconcile.test.ts`（3） | PASS |
| **F20 生产 snapshotProvider 接线（deferred）**：journal 记录 snapshotId（SNAPSHOT_CREATED）并 APPLYING 先于 mutation | `src/core/phase3-host.ts` `runJournaled deferredSnapshot` + `JournalRunContext`；`src/core/analyzer.ts`/`importer.ts`/`profiles/profile-manager.ts`/`sync/sync-engine.ts` 接收 snapshotBinding；`src/index.ts` withMutationGate 传 deferredSnapshot | `src/core/phase3-production-integration.test.ts`（deferred x3） | **PASS** |
| **F23 import→snapshot 投毒防护**（reserved namespace write-isolation） | `src/utils/paths.ts` `isReservedInternalRel` + `plugin-files.ts`/`file-collection.ts` | `src/adapters/files.test.ts`（F23 x2） | PASS |
| **F1 快照信任模型**（manifest + verifySnapshot 磁盘重读 + READY 原子发布 + metadataHash + entryCount） | `src/core/backup.ts` + `types.ts` | `tests/core/snapshot-trust.test.ts`（T-01..T-08） | PASS |
| **F3 prune 引用保护**（active/quarantine 未收敛 journal 引用豁免） | `src/core/journal.ts` `listReferencedSnapshotIds` + `backup.ts` `FileSnapshotStore` + `index.ts` 接线 | `tests/core/snapshot-trust.test.ts`（F3 x3 + 集成） | PASS |
| **F13 prune 失败不阻断 save** | `backup.ts` `save()` try/catch | `tests/core/snapshot-trust.test.ts`（F13） | PASS |
| **F21/F11 production snapshotExists 正向校验**（存在+READY+manifest+blob+binding 匹配） | `src/core/phase3-host.ts` 注入 `snapshotExists`；`src/index.ts` 注入真实实现 | `phase3-production-integration.test.ts`（snapshotExists x1） | **PASS** |
| **F8/F9/F25 统一 restore 校验**（provenance verdict 分类 + 拒绝 CORRUPT/INVALID/UNSAFE_PATH/WRONG_ENVIRONMENT + symlink 拒绝） | `src/core/restore.ts` `validateSnapshotForRestore` + `planRestore` 强制 + 三入口传 snapshotsRoot | `tests/core/restore-trust.test.ts`（V-01..V-09） | **PASS** |
| **F29/F30 reinstall recovery point**（program 变更前 durable op-bound recovery evidence + fail-closed） | `src/core/reinstall.ts` `detectInstalledDshVersion`/`writeReinstallRecoveryPoint`；`src/cli/index.ts` 接线 | `tests/cli/reinstall.test.ts`（F29/F30 x3） | **PASS** |
| **真实 child-process crash 注入 C1-C10**（SIGKILL） | `src/core/phase4-crash-child.ts` | `src/core/phase4-crash-injection.test.ts`（C1-C10 x7） | **PASS** |
| **Windows FS 定向**（case-insensitive / backslash / EPERM prune / symlink blob） | — | `tests/core/snapshot-trust.test.ts`（W-01..W-04） | **PASS** |
| **F4 double-snapshot** | sync-apply 透传 snapshotBinding，权威 snapshot = importer 的 journal-bound 者；sync 的 rollback snapshot #1 = UI 回滚 vehicle | `phase3-production-integration.test.ts` | **CLOSED** |

---

## 3. 全量验证结果

```bash
npm run typecheck   # PASS (exit 0)
npm test            # 1287/1287 pass, 0 fail  (baseline 1241 → +46)
npm run build       # PASS (tsc + tsdown client bundle)
```

> env-lock 全量偶发 flaky（`§11.x`，Windows 临时目录回收）为**既有**缺陷：隔离运行 26/26 PASS，本会话未触碰 env-lock。最终全量复跑 0 fail。
>
> **Final Review 后追加硬化**（`d3d6524` 之后未提交部分）：① `isReservedInternalRel` 折叠 `..`/`.`（Reviewer B P0）② `bindSnapshot`/`markApplying` fail-closed（Reviewer A P2①）③ verifySnapshot 要求 snapshot 引用 blob 全覆盖（Reviewer C P2）④ restore 校验检查 blobs 目录 symlink（Reviewer C P2）⑤ reconcile 悬空 step fail-closed（Reviewer D P2）。全部有对应测试。

---

## 4. 遗留项（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| 独立 5-reviewer Final Review | **COMPLETED**（5 个只读 reviewer 一轮，P0=0、unresolved P1=0，见 DESIGN §22.2 / HANDOFF §5） | Reviewer P0（`..` 穿越）与 P1/P2 安全/恢复项均已在 `d3d6524` 后追加修复（`..` 折叠、bind fail-closed、blob 全覆盖、symlink blob、悬空 step）。 |
| 真实 Windows junction 集成 | **ACCEPTED P2（DEFERRED）** | node_modules 明确不在 scope；junction 依赖真实 Windows 环境，环境特定。symlink 语义已由 W-04 覆盖。 |
| atomic rename retry 调优 / Windows ACL / orphan 优化 / 增量备份 / fine-grained WAL v2 | **ACCEPTED P2 LIMITATION**（Design §44 默认边界） | 不影响核心安全不变量。 |
| autosync-apply（`runExternalIntent`）deferred snapshot 接线 | **ACCEPTED P2** | 走外部 step → crash 后 needs-attention（保守安全，绝无静默 RECOVERED）。 |
| `profile-import`（`POST /profiles/import`）deferred snapshot 接线 | **ACCEPTED P2**（边界） | ProfileManager 内部快照 + journal 空 steps → 保守 NEEDS_ATTENTION；如需完全对齐可补。 |

**明确不做（Design/默认决策）**：NO node_modules snapshot、NO automatic rollback without explicit policy、NO cloud/export、NO force-no-snapshot bypass、NO fine-grained WAL v2、NO 新 transaction framework。

---

*Phase 4 Final Closure 实现完成。剩余独立评审（进行中）+ 边界 P2 见 `PHASE4_HANDOFF.md`。*
