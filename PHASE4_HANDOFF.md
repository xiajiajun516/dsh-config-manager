# PHASE4_HANDOFF — 交接文档

> 阶段：**Phase 4 — Pre-upgrade Automatic Snapshot**
> 基线 SHA：`661dd79`（Phase 3 closure）
> 本会话完成的工作区 SHA：见提交记录（`git log` 确认）
> 相关文档：`PRE_UPGRADE_SNAPSHOT_ANALYSIS.md`（Analysis Gate = PASS）、`PRE_UPGRADE_SNAPSHOT_DESIGN.md`（含实现前自检）、`PRE_UPGRADE_SNAPSHOT_IMPLEMENTATION_REPORT.md`

---

## 1. 本会话状态总结

**PHASE 4 STATUS：PARTIAL（核心不变量相关项 PASS，其余 NOT VERIFIED）**

| 维度 | 状态 |
|---|---|
| Analysis Gate | **PASS**（Analysis 文档已定案；本会话确认无遗漏） |
| Design Gate | 文档完成 + 本会话实现前自检（未跑独立 5-reviewer 轮） |
| Implementation（已验证） | F20 恢复安全 / F23 投毒防护 / F1 信任模型 / F3 prune 保护 / F13 prune 失败 = **PASS** |
| Implementation（未完成） | 生产 snapshotProvider 接线 / restore 统一验证 / F21 / F4 / F29/30 = **NOT VERIFIED** |
| 回归 | typecheck PASS / **1258 tests PASS** / build PASS |

---

## 2. 已提交 / 已验证清单

源码（本会话 + 既有工作区合并）：
- `src/core/reconcile.ts` — F20 空 steps 保守恢复
- `src/utils/paths.ts` — `isReservedInternalRel`（F23，修正 sync 前缀）
- `src/adapters/plugin-files.ts`、`src/adapters/file-collection.ts` — F23 apply/analyze 拒绝
- `src/core/backup.ts` — F1 manifest/verify/READY + F3 prune 引用 + F13 prune 失败
- `src/core/journal.ts` — `listReferencedSnapshotIds`（F3）
- `src/core/types.ts` — Snapshot 新增 operationId/readiness/manifest 等 Phase 4 字段
- `src/core/phase3-host.ts` — snapshotProvider null → abort（既有工作区）
- `src/core/messages.ts` — i18n `adapter.fileReserved` / `adapter.pluginFileReserved`
- `src/index.ts` — FileSnapshotStore 接线 `referencedSnapshotIds`（F3）
- 测试：`src/core/reconcile.test.ts`（F20）、`src/adapters/files.test.ts`（F23）、`tests/core/snapshot-trust.test.ts`（F1/F3/F13 + journal 引用）

---

## 3. 剩余工作（交接给下一轮，按优先级）

### P0（核心不变量，未完成）
1. **生产 `snapshotProvider` 接线**：`withMutationGate`/`runJournaled` 传 `snapshotProvider`，把 `createSnapshot` 从 handler 内上移到 journal 阶段，使 journal 记录 `snapshotId` + `SNAPSHOT_CREATED` + APPLYING 顺序化；业务引擎（analyzer/ProfileManager/SyncEngine）不再自行创建 authoritative snapshot。
2. **restore 统一验证**（F8/F9/F10/F25）：一个 `validateSnapshotForRestore` 供 Host API / ModelTools / CLI 复用；restore 前重验 blob hash / manifest / env binding / symlink。
3. **production `snapshotExists` 接线**（F21/F11）：把 reconcile 的 snapshotExists 接到 JournalStore + manifest verify，使 rollback-recommended 生产可达。

### P1
4. **F4 double-snapshot 消除**：sync-engine 显式复用父 transaction snapshot context。
5. **F29/F30 reinstall recovery point**：program 变更前 durable previousVersion + recovery metadata。

### 评审 / 测试（建议独立轮）
6. **完整 5-reviewer Design Review**（A 事务/崩溃 / B 安全 / C restore / D Windows / E 范围）。
7. **最终独立 5 问 Review**（fabricated-snapshot / poisoning / empty-steps RECOVERED / prune ref / Phase1-3 regression）。
8. **真实子进程 fault-injection**：kill 于各 crash window + startup reconcile 断言。
9. **Windows EPERM/EBUSY / case-insensitive / junction 集成测试**。

---

## 4. 复现 / 验证指引

```bash
npm install --legacy-peer-deps
npm run typecheck      # PASS
npm test               # 1258 pass（env-lock 全量偶发 flaky 为既有 Windows 回收，隔离跑 PASS）
npm run build          # PASS
```

新增测试重点：
- `node --test tests/core/snapshot-trust.test.ts`（F1/F3/F13）
- `node --test src/adapters/files.test.ts src/adapters/self.test.ts`（F23）
- `node --test src/core/reconcile.test.ts`（F20）

---

## 5. 风险备注

- 生产 snapshotProvider 接线会触及 `index.ts` 各 destructive handler 与三个业务引擎——改动前先重读文件（本仓存在并行开发线，edit/write 后立即 `git diff`/`git show HEAD` 验证落盘）。
- 不得用 crypto 掩盖 write-isolation bug（F23 主防线是 reserved namespace，manifest 是第二层）。
- 空 steps 绝不判 RECOVERED（F20）为硬约束，已有回归测试保护。
