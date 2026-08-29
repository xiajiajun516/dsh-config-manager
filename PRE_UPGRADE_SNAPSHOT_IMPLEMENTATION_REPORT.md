# PRE_UPGRADE_SNAPSHOT_IMPLEMENTATION_REPORT — Phase 4

> 阶段：**IMPLEMENTATION**（Phase 4 — Pre-upgrade Automatic Snapshot）
> 基线 SHA：`661dd79`（Phase 3 handoff closure）
> Analysis: `PRE_UPGRADE_SNAPSHOT_ANALYSIS.md`（Analysis Gate = PASS）
> Design: `PRE_UPGRADE_SNAPSHOT_DESIGN.md`
> 本文如实记录：已实现 + 已验证项、剩余未完成项（NOT VERIFIED）。**不把未验证项描述为 PASS。**

---

## 1. 本会话完成的工作

本仓库在接手时已有 Phase 4 Analysis + Design + 部分工作区实现（未提交）。本会话完成了：
① 审计既有工作区实现 ② 修复 F23 回归 ③ 补齐 i18n ④ 补测试 ⑤ 实现 F3/F13 ⑥ 全量回归。

### 1.1 已实现 + 已验证（PASS）

| 项目 | 源码 | 测试 | 验证 |
|---|---|---|---|
| **F20 空 steps 恢复安全**（空 steps APPLYING → NEEDS_ATTENTION / rollback-recommended，绝不以 `[].every()` 判 RECOVERED；CREATED 空 steps → 安全 noop） | `src/core/reconcile.ts`（既有工作区 + 本会话确认） | `src/core/reconcile.test.ts`（3 条 F20 test） | typecheck + node test PASS |
| **F23 import→snapshot 投毒防护**（reserved namespace write-isolation） | `src/utils/paths.ts` `isReservedInternalRel` + `src/adapters/plugin-files.ts` + `src/adapters/file-collection.ts` | `src/adapters/files.test.ts`（2 条：pluginFiles + self） | PASS |
| **F1 快照信任模型**（manifest + verifySnapshot 磁盘重读 + READY 原子发布 + metadataHash 稳定） | `src/core/backup.ts` + `src/core/types.ts`（既有工作区 + 本会话测试） | `tests/core/snapshot-trust.test.ts`（T-01..T-08） | PASS |
| **F3 prune 引用保护**（active/quarantine 未收敛 journal 引用的 snapshot 豁免清理） | `src/core/journal.ts` `listReferencedSnapshotIds` + `src/core/backup.ts` `FileSnapshotStore` + `src/index.ts` 接线 | `tests/core/snapshot-trust.test.ts`（F3 x3 + JournalStore 集成） | PASS |
| **F13 prune 失败不阻断 save**（已 READY + verified 的快照不被 EBUSY/EPERM 判为 unusable） | `src/core/backup.ts` `save()` try/catch | `tests/core/snapshot-trust.test.ts`（F13） | PASS |

### 1.2 修复的既有实现缺陷（本会话）

- **F23 回归修复**：初版 reserved namespace 前缀含 `dsh-config-manager/sync/`（整段），误伤 self 分区合法 `sync/*.json` 白名单配置。修正为仅保留 `sync/snapshots/` 与 `sync/work/`（真实 recovery-critical 路径）。原 self 导入往返测试因此回归失败 → 已修复。
- **i18n 补齐**：新增 `adapter.fileReserved` / `adapter.pluginFileReserved` 键（zh + en 镜像），消除缺失键导致的键名回退显示。

### 1.3 测试增量

- 新增 `tests/core/snapshot-trust.test.ts`（12 条 + snapshot.test/retention 共享）。
- 新增 `src/adapters/files.test.ts` 2 条 F23。
- 新增 `src/core/reconcile.test.ts` 3 条 F20（既有工作区）。

---

## 2. 全量验证结果

```bash
npm run typecheck   # PASS (exit 0)
npm test            # 1258/1258 pass, 0 fail  (baseline 1241 → +17)
npm run build       # PASS (tsc + tsdown client bundle)
```

> 注：`npm test` 单次全量跑曾出现 1 条 `env-lock.test.ts` 失败（`§11.1-c21` / `§11-c26`），为 **Windows 临时目录回收的既有 flaky**（该文件在隔离运行下 2/2 PASS，且不受本会话改动影响——本会话未触碰 env-lock）。复跑全量为 0 fail。

---

## 3. 剩余未完成项（NOT VERIFIED / FAIL / 明确不做）

以下为核心不变量相关的剩余工作，**本会话未完成**，如实列出：

| 项 | 状态 | 说明 |
|---|---|---|
| **F20 生产 `snapshotProvider` 接线**（把 `createSnapshot` 上移到 journal 阶段，使 production import/profile-switch/sync-apply 的 journal 真正记录 `snapshotId` + SNAPSHOT_CREATED 状态） | **NOT VERIFIED** | 当前生产 `withMutationGate` 仍不传 `snapshotProvider`；快照由业务引擎内部创建。F20 的**恢复安全**已修（reconcile 空 steps 保守化），但 journal↔snapshot 的**正向绑定**在 production 尚未接线。这是 Design §8/§40 的核心目标。 |
| **F8/F9/F10/F25 restore 统一验证**（`validateSnapshotForRestore` 统一校验 + blob hash 比对 + env binding + symlink 规则） | **NOT VERIFIED** | restore 仍是「parse-and-trust」；manifest hash 仅在创建时 verify，restore 消费前未重验。 |
| **F21 production `snapshotExists` 正向接线** | **NOT VERIFIED** | reconcile 的 `snapshotExists` 生产仍保守 `false`（`phase3-host.ts conservativeHooks`），rollback-recommended 生产不可达。 |
| **F4 double-snapshot 消除**（sync-engine 复用父 snapshot context） | **NOT VERIFIED** | sync-apply 仍两次 createSnapshot。 |
| **F29/F30 reinstall recovery point**（program 变更前 durable previousVersion + recovery metadata） | **NOT VERIFIED** | `.reinstall-backup` 仅在 program 变更后创建且只覆盖配置。 |
| **完整 5-reviewer Design Review** | **NOT VERIFIED** | 本会话仅做实现前自检，未并行跑独立 reviewer 轮。 |
| **真实子进程 fault-injection**（child process kill + startup reconcile 断言） | **NOT VERIFIED** | 需要额外运行脚本（kill 各窗口）。 |
| **Windows 特有 EPERM/EBUSY prune 失败 + case-insensitive + junction 集成测试** | **NOT VERIFIED** | 部分由 F13 单测覆盖（provider 抛错），未做真实 Windows 占用集成。 |

**明确不做（Design/默认决策）**：NO node_modules snapshot、NO automatic rollback without explicit policy、NO cloud/export、NO force-no-snapshot bypass、NO fine-grained WAL v2、NO 新 transaction framework。

---

## 4. 风险与建议

- 生产 `snapshotProvider` 接线是 Phase 4 剩余的最核心项 → 建议作为下一轮独立工作，覆盖 index.ts（`withMutationGate`）+ analyzer/ProfileManager/SyncEngine 的 `createSnapshot` 上移，并补 production 级 crash 测试。
- restore 统一 validator 应作为独立 security 项完成（F8/F9/F10/F25），统一三入口（Host API / ModelTools / CLI）。
- 提交前已确认核心不变量相关项（F20 恢复安全 / F23 / F1 / F3 / F13）全部 PASS + 测试覆盖。

---

*本实现会话结束。剩余项与独立评审见 `PHASE4_HANDOFF.md`。*
