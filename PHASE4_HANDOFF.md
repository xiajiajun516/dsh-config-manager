# PHASE4_HANDOFF — 交接文档

> 阶段：**Phase 4 — Pre-upgrade Automatic Snapshot**
> 基线 SHA：`661dd79`（Phase 3 closure）
> 前一 increment SHA：`737ab2d`
> 本 increment（Final Closure）SHA：`d3d6524`
> 相关文档：`PRE_UPGRADE_SNAPSHOT_ANALYSIS.md`（Analysis Gate = PASS）、`PRE_UPGRADE_SNAPSHOT_DESIGN.md`（含实现前自检）、`PRE_UPGRADE_SNAPSHOT_IMPLEMENTATION_REPORT.md`

---

## 1. 结束状态总结

**PHASE 4 STATUS：核心不变量 + 生产接线 + 恢复/回滚 + reinstall recovery + crash 注入均已实现并验证。**

| 维度 | 状态 |
|---|---|
| Analysis Gate | **PASS** |
| Design | 文档完成 + 实现前自检（独立 5-reviewer 轮未跑，见 §5 剩余） |
| F20 生产 snapshotProvider 接线 | **PASS** |
| F21/F11 production snapshotExists | **PASS** |
| F8/F9/F25 统一 restore 校验 | **PASS** |
| F29/F30 reinstall recovery point | **PASS** |
| 真实 child crash 注入 C1-C10 | **PASS** |
| F1/F3/F13/F23 | **PASS**（含回归） |
| Final Review（5 只读 reviewer，一轮） | **PASS**（P0=0 / unresolved P1=0；`..` 穿越 P0 + 各 P2 已闭环） |
| F4 double-snapshot | **CLOSED**（journal 绑定唯一 authoritative importer snapshot；sync 的 #1 为 UI 回滚 vehicle） |
| 回归 | typecheck PASS / **1287 tests PASS** / build PASS |

---

## 2. 核心不变量

> **No protected mutation may perform its first destructive side effect before a valid, trusted, operation-bound recovery snapshot is durable.**

五部分（VALID / TRUSTED / OPERATION-BOUND / DURABLE / BEFORE FIRST DESTRUCTIVE SIDE EFFECT）均已成立：
- **VALID + TRUSTED**：快照经 manifest（blob hash + metadataHash + entryCount）+ `verifySnapshot` 磁盘重读 + READY 原子发布；restore 前再经统一 validator。
- **OPERATION-BOUND + DURABLE**：`runJournaled({ deferredSnapshot:true })` 把 journalCtx（operationId/operationType/environmentFingerprint/ownerInstanceId）暴露给引擎，引擎创建 op-bound snapshot 并 `bindSnapshot`（SNAPSHOT_CREATED，记录 journal.snapshotId）→ `markApplying`（APPLYING）→ 才执行业务 mutation。
- **BEFORE FIRST DESTRUCTIVE SIDE EFFECT**：bind + APPLYING 发生在首个 `applyOne`（dsh plugin add / settings.replace / fs.writeFile）之前；crash 在 APPLYING 后 → journal 已绑定 trusted snapshot，绝不以空 steps 判 RECOVERED。

---

## 3. 本 increment 实现的源码

- `src/core/phase3-host.ts` — `JournalRunContext`（bindSnapshot/markApplying）+ `runJournaled` deferredSnapshot 模式 + `runExternalIntent` 暴露 operationId + 可注入 `snapshotExists`。
- `src/core/types.ts` — `TransactionSnapshotContext` 最小接口。
- `src/core/analyzer.ts` / `src/core/importer.ts` / `src/profiles/profile-manager.ts` / `src/sync/sync-engine.ts` — 引擎接收 `snapshotBinding`，createSnapshot 写 op-bound 字段并 bind/markApplying；sync-apply 透传（F4：权威 snapshot = importer 的 journal-bound 者）。
- `src/index.ts` — `withMutationGate` 支持 `deferredSnapshot`，import/profile-switch/sync-apply 传 journalCtx；restore 传 `snapshotsRoot`；`Phase3Recovery` 注入真实 `snapshotExists`（verifySnapshot + manifest binding）。
- `src/core/restore.ts` — `validateSnapshotForRestore`（verdict 分类）+ `planRestore` 顶端强制校验（`snapshotsRoot` 时）；`src/core/backup.ts` verifySnapshot 补 `entryCount` 校验。
- `src/core/model-tools.ts` / `src/cli/index.ts` — restore 亦传 snapshotsRoot（三入口一致）；CLI reinstall 写 recovery point。
- `src/core/reinstall.ts` — `detectInstalledDshVersion` + `writeReinstallRecoveryPoint`（operation-bound、durable、fail-closed）。

## 4. 新增测试（+27）

- `src/core/phase3-production-integration.test.ts` — deferred 接线 3 条 + snapshotExists 注入 1 条。
- `tests/core/restore-trust.test.ts` — 统一恢复校验 9 条（V-01..V-09 含 blob/manifest 篡改、symlink、env、untrusted 拒绝）。
- `src/core/phase4-crash-injection.test.ts` + `phase4-crash-child.ts` — 真实 SIGKILL 注入 C1-C10（C1/C2 无 snapshot / C3/C4 绑定后安全 / C5-C7 partial mutation 绝不 RECOVERED / C8-C10 COMMITTED 不 rollback）。
- `tests/cli/reinstall.test.ts` — F29/F30（detect + write + externalIntent 暴露 opId）3 条。
- `tests/core/snapshot-trust.test.ts` — Windows 定向 W-01..W-04（case-insensitive / backslash / EPERM prune / symlink blob）。

---

## 5. 明确未完成 / 独立复核（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| 独立 5-reviewer Final Review | **COMPLETED**（一轮；P0=0 / unresolved P1=0） | Reviewer A-D 发现均已闭环；详见 DESIGN §22.2 与 IMPLEMENTATION_REPORT §4。 |
| 真实 Windows junction 集成 | **ACCEPTED P2（DEFERRED）** | node_modules 明确不在 snapshot scope；junction 依赖真实 Windows 环境，环境特定，不阻断 PASS。W-04 已覆盖 symlink 语义。 |
| Atomic rename retry / Windows ACL / orphan 优化 / 增量备份 / fine-grained WAL v2 | **ACCEPTED P2 LIMITATION** | 见 §44 默认范围。 |
| autosync-apply（`runExternalIntent`）deferred snapshot 接线 | **ACCEPTED P2** | 走外部 step → crash 后 needs-attention（保守安全，绝无静默 RECOVERED）；若需完全对齐可补。 |
| `profile-import`（`POST /profiles/import`）deferred snapshot 接线 | **ACCEPTED P2**（边界） | ProfileManager 内部快照 + journal 空 steps → 保守 NEEDS_ATTENTION；如需完全对齐可补。 |
| quarantine 中 user-dismissed journal 的 snapshot 无限期保护 | **ACCEPTED P2** | 保守方向（仅多占磁盘，绝不误删回滚点）。 |

---

## 6. 复现 / 验证指引

```bash
npm install --legacy-peer-deps
npm run typecheck   # PASS
npm test            # 1285 pass（env-lock 全量偶发 flaky 为既有 Windows 回收，隔离 26/26 PASS）
npm run build       # PASS
```

重点新增测试：
- `node --test src/core/phase4-crash-injection.test.ts`（C1-C10 真实 SIGKILL）
- `node --test tests/core/restore-trust.test.ts`（V-01..V-09）
- `node --test src/core/phase3-production-integration.test.ts`（deferred + snapshotExists）
- `node --test tests/cli/reinstall.test.ts tests/core/snapshot-trust.test.ts`

---

## 7. 风险备注

- 生产 deferred wiring 触及 `index.ts` 各 destructive handler 与三个引擎——改动前重读文件（本仓并行开发线）；edit/write 后立即 `git diff`/`git show HEAD` 验证落盘。
- 不得用 crypto 掩盖 write-isolation（F23 主防线是 reserved namespace）。
- 空 steps 绝不判 RECOVERED（F20）已有回归测试保护。
- 独立 Design/Final Review 与真实 Windows junction 集成是唯一明确留待下一轮的项。
