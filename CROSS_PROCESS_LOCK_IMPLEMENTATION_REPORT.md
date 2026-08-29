# CROSS_PROCESS_LOCK_IMPLEMENTATION_REPORT — Phase 2：Cross-process Lock

> 状态：**Implementation 完成（Phase 2）**。全量测试绿 + build 通过 + 独立/对抗性评审通过。
> 前置：设计 `CROSS_PROCESS_LOCK_DESIGN.md`（Rev 3，BLOCKER 1–4 CLOSED）→ 设计评审 `CROSS_PROCESS_LOCK_DESIGN_REVIEW.md`（Gate=GO）。

---

## 1. 交付总结

实现 **GLOBAL EXCLUSIVE MUTATION LOCK**（跨进程环境锁），防止多个 DSH 实例 / Web Host / CLI / AutoSync / Backup Scheduler / Model Tools 同时执行 destructive mutation。所有权获取严格用 `open(lockPath, 'wx')` 独占创建语义；`environment.lock` 为 immutable ownership record；heartbeat 独立 sidecar；operation-scoped `MutationLockToken`（禁止 process-level reentrant）；stale 检测只分类、显式 `--recover-stale-lock` 才回收；destructive 无 `--force` 旁路，必须成功 acquire 才执行。

**核心原则（依 Rev 3 不变量）**：
- 所有权获取 = `open('wx')`；**禁止** exists→write、rm→recreate、用 Phase 1 `atomicWriteFile(environment.lock)` 获取所有权。
- `environment.lock` immutable（创建后到 release 不 rename/replace）；heartbeat 走 `environment.heartbeat.<instanceId>` sidecar（可用 atomicWriteFile）。
- destructive mutation 无有效 parent token → 必须 acquire GLOBAL，否则不执行；nested（rollback）显式传 token reuse，不 reacquire（无自死锁）。

## 2. 修改文件 / 交付

| 文件 | 内容 |
|---|---|
| `src/utils/env-lock.ts`（**新增**） | `EnvironmentLockManager` / `MutationLockToken` / `MutationLockContext` / `MutationLockPort` / `withMutationLock` / `runWithMutationLock` / `recoverStaleLock` / stale detect / release validation / Windows close→unlink / EBUSY 有界重试。零 DSH 依赖（仅 node:fs/path/os/crypto + 复用 atomic-write）。CLI 离线可复用 |
| `src/utils/env-lock.test.ts`（**新增**） | 26 用例全覆盖 Design §11(1–18)+§11.1b(19–25)+额外（26）：exclusive-create、crash、cross-process child、token 模型、stale 六档、recovery quarantine、EPERM/EACCES、heartbeat degraded、withMutationLock 双义 |
| `src/core/types.ts` | `HostContext` 增可选 `mutationLock?: MutationLockPort`（type-only import，测试 mock 缺省无→不锁） |
| `src/index.ts` | `host.mutationLock = new EnvironmentLockManager({dataDir})`；`withMutationGate` 助手；destructive 路由包 gate（import-apply / restore(非dryRun) / snapshot-delete / snapshot-pin / profile delete·rename·switch·import / sync-push / sync-apply / sync-rollback / backup-files-delete）；注入 AutoSync/Backup scheduler + makeRoutes |
| `src/sync/autosync-scheduler.ts` | `AutoSyncSchedulerOptions.mutationLock?`；runOnce 在 runs.register 后 `withMutationLock`（仅当注入）覆盖 apply+push，finally 释放；`mutation-locked` skip |
| `src/sync/backup-scheduler.ts` | `BackupSchedulerOptions.mutationLock?`；runOnce 内 `runWithMutationLock` 包裹 export+writeConfig+prune；锁被占→skipped(mutation-locked) 不增失败计数 |
| `src/cli/index.ts` | restore（非 dry-run）与 reinstall 用 `runWithMutationLock` 包裹；新增 `--recover-stale-lock` 独立命令（inspect→prove stale→recoverStaleLock）；无 `--force` |
| `src/core/model-tools.ts` | `config_restore`（confirm:true 分支）与 `config_sync_push` 用 `runWithMutationLock(deps.host.mutationLock, …)` |

## 3. M1–M14 接入清单（host-boundary gate 实现）

采用「公共 destructive 边界统一 gate」而非 core 引擎注入——公共入口 acquire 后，nested 引擎调用（executeImportPlan/rollback/applyMergePlan/applyItems/restore/performRollback）在已持锁区域内运行、不 reacquire（core 引擎全部 lock-free）。

| # | Inventory 项 | 接入位置 | acquire 在 mutation 前 |
|---|---|---|---|
| M1 | Import apply | `/import/execute` `withMutationGate('import-apply')` | ✅ |
| M2 | Restore | `/restore` dryRun=false `runWithMutationLock({op:'restore'})` | ✅（dryRun 只读不锁） |
| M3 | Rollback | 随父 mutation 持锁；未独立 gate | ✅（继承） |
| M4 | Profile switch | `/profiles/execute-switch` `withMutationGate('profile-switch')` | ✅ |
| M5 | Profile delete/rename/import | `/profiles/delete` `/rename` `/import` gate | ✅ |
| M6 | Sync apply | `/sync/apply-items` `withMutationGate('sync-apply')` | ✅ |
| M7 | AutoSync mutation | `autosync-scheduler.runOnce` withMutationLock | ✅ |
| M8 | Manual Sync push | `/sync/push` `withMutationGate('sync-push')` | ✅ |
| M9 | Snapshot delete | `/snapshots/delete` gate | ✅ |
| M10 | Snapshot prune | `FileSnapshotStore.save` 内嵌，随父持锁 | ✅（继承） |
| M11 | Backup | `BackupScheduler.runOnce` runWithMutationLock | ✅ |
| M13 | CLI restore/reinstall | `src/cli/index.ts` runWithMutationLock + `--recover-stale-lock` | ✅ |
| M14 | ModelTools destructive | `model-tools.ts` restore(confirm)/syncPush | ✅ |

> 补充：`/sync/rollback`（performRollback 真写 $DSH_HOME）与 `/backup-files/delete` 由 Integration Auditor 发现漏锁，已补 `withMutationGate`。`/export` 与 `config_backup` 写新 ZIP（非 destructive、不覆盖配置）按设计可接受不锁。

## 4. Reviewer 发现与修复（env-lock.ts）

| Reviewer | 发现 | 修复 |
|---|---|---|
| lock-correctness (t1) | P1 §8.1 EPERM/EACCES 分类未落地 | ✅ acquire 先 `statLockExists` 存在→inspect / 否则 PERMISSION_ERROR；inspect 捕获 EACCES 不抛 |
| concurrency (t2) | **F1** release 从不清理 heartbeat（死代码） | ✅ cleanupHeartbeat(instanceId) 不再依赖 activeToken |
| concurrency (t2) | **F2** release 错误路径 lock 卡死 | ✅ unlink 失败抛 EnvironmentLockIOError 且保留 activeToken 可重试 |
| concurrency (t2) | **F3** open→write 间隙被杀→0 字节锁永久 LOCKED | ✅ selfOsIdentity 探测前移 open 之前；readOwnershipState 区分 corrupt→UNKNOWN→recover 可回收；二次验证失败 quarantine 不覆盖 successor |
| windows (t3) | P1 §8.1 EPERM 分类；P2 EBUSY 无重试 | ✅ 分类已修 + tryTransientRetry 有界重试 |
| (t1 P2) | validate 未显式校 instanceId | ✅ 三重匹配（managerId+tokenId+instanceId） |

所有 P0/P1 关闭。

## 5. 验证结果

- `npm run typecheck`：**PASS**（strict + verbatimModuleSyntax + noUncheckedIndexedAccess）
- `npm test`（全量）：**1176/1176 PASS**，0 失败（Phase 1 基线 1150 + 新增 26 env-lock 用例，零回归）
- `npm run build`：**PASS**（tsc + tsdown client bundle）
- **env-lock.test.ts：26/26 PASS**（exclusive-create / crash child-process / cross-process child / token 模型 / stale 六档 / recovery / failure injection / Windows close→unlink / EPERM/EACCES）
- **Windows 行为**：本机即 Windows 实跑，close→unlink 语义、wx 独占创建实测通过
- **独立最终审计（t8, captain 接管对抗性）**：12 个攻击点全部 FAILED-TO-PROVE，**PHASE 2 = PASS**

## 6. 已知限制 / 后续项

1. **`--recover-stale-lock` 需显式触发且只对 definitely-stale/corrupt 生效**——活锁/degraded 绝不自动回收（设计使然）。
2. **Windows `osProcessStartIdentity` 默认不可得**（可以GetOsIdentity=false）→ heartbeat 过期+PID 存活时保守 UNKNOWN_STATE（不误删），需宿主注入更强探测或接受保守。
3. **NFS / 多机共享 `$DSH_HOME` 不支持**（open('wx') 在 NFS 语义可能不一致）——按设计 Scope Exclusion。
4. **Backup / Sync push 纳入 GLOBAL 降低并发吞吐**——v1 安全优先，将来有性能证据再放宽。
5. **`/sync/push` 的 preview 只读分支也在 gate 内**——锁被占时只读 preview 会 423（可用性成本，非正确性），可后续移出。
6. 现有 **两个 RunRegistry 实例缺陷**（backup 与 makeRoutes 各自 new）：建议顺手合并为共享单实例（hygiene，不替代 Lock，未在本 Phase 修改）。

## 7. 完成标准对照

- [x] `env-lock.ts`：acquire（open 'wx'）/ immutable ownership / sidecar heartbeat / token / stale detect / explicit recovery / release validation / Windows close→unlink / EBUSY retry
- [x] 接入 M1–M11, M13–M14 全部 destructive 公共入口（host-boundary gate）
- [x] ownership 不被 atomicWriteFile 替换；heartbeat 只更新 sidecar
- [x] stale 只分类；recovery 独立显式、原子捕获、二次失败不覆盖 successor；无自动 takeover；无 `--force`
- [x] release 前 instanceId 校验，mismatch 不 unlink；release 后 token 失效；nested 显式传 token 不 reacquire
- [x] CLI + ModelTools 全覆盖；Backup / Sync push 纳入 GLOBAL
- [x] Windows close→unlink、POSIX kill(pid,0) 有测试
- [x] 全量 1176/1176 ≥ 基线 1150；零回归
- [x] 独立对抗性最终审计 = PASS
- [x] 产出本报告 + PHASE2_HANDOFF

---

*Phase 2 Implementation 完成。PHASE 2 STATUS: PASS。依指令停止，不进入 Phase 3。*
