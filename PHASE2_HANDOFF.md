# PHASE2_HANDOFF — Cross-process Lock（跨对话交接文档）

```
PHASE 2 STATUS: PASS
```

- **Phase 2 名称**：Cross-process Lock（跨进程互斥）
- **当前 git commit SHA（HEAD）**：`351e235`（即 Phase 1 基线 commit；Phase 2 源码**尚未 commit**，见下）
- **当前工作区版本（package.json）**：`0.1.54`
- **日期**：`2026-08-29`
- **下一阶段**：Phase 3 — Crash Journal + Reconciliation

### Working tree 状态：**DIRTY（Phase 2 未提交）**

> ⚠️ Phase 2 改动**尚未 commit**。下一位 AI 接手后应先提交（仅源码：`src/utils/env-lock.ts`、`src/utils/env-lock.test.ts`、`src/core/types.ts`、`src/index.ts`、`src/sync/autosync-scheduler.ts`、`src/sync/backup-scheduler.ts`、`src/cli/index.ts`、`src/core/model-tools.ts` + 本项目文档）。`CROSS_PROCESS_LOCK_*.md` 3 份为设计/评审/实现文档，可与源码分开 commit 或同 commit；`competitor-research/` 与 `ATOMIC_*.md`、`COMPETITOR_SOURCE_AUDIT.md` 为 Phase 1 遗留审计产物，不应混入本 Phase 源码 commit。

**已修改（Phase 2 源码）**：
`src/cli/index.ts` `src/core/model-tools.ts` `src/core/types.ts` `src/index.ts`
`src/sync/autosync-scheduler.ts` `src/sync/backup-scheduler.ts`

**未跟踪（新增源码）**：`src/utils/env-lock.ts` `src/utils/env-lock.test.ts`

**未跟踪（文档）**：`CROSS_PROCESS_LOCK_DESIGN.md`（Rev 3）`CROSS_PROCESS_LOCK_DESIGN_REVIEW.md` `CROSS_PROCESS_LOCK_IMPLEMENTATION_REPORT.md`（本 Phase）

---

## 1. Phase 2 最终架构

新增 `src/utils/env-lock.ts`（零 DSH 依赖：仅 node:fs/path/os/crypto + 复用 Phase 1 atomicWriteFile；CLI 离线可复用）。

### 导出

| 符号 | 签名 | 用途 |
|---|---|---|
| `EnvironmentLockManager` | `new EnvironmentLockManager({ dataDir?, locksDir?, io?, probe?, now?, heartbeatIntervalMs?, staleAfterMs?, acquireTimeoutMs?, lockVersion?, … })` | 跨进程环境锁管理器 |
| `MutationLockToken` | `{ tokenId, managerId, instanceId, acquiredAt }` | operation-scoped token（只属一次 acquire 调用链） |
| `MutationLockContext` | `{ token }` | nested operation 显式传递的锁上下文 |
| `MutationLockPort` | `{ acquire, validate, release }` | core/CLI/ModelTools 依赖的最小锁契约（测试 mock） |
| `withMutationLock(port, opts)` | → `{ context, release }` | 无父 token→acquire；有有效父 token→reuse（不 reacquire） |
| `runWithMutationLock(port, opts, fn)` | `Promise<T>` | acquire→fn→release；锁不可得抛 `EnvironmentLockUnavailableError`；port undefined→直放行 |
| `recoverStaleLock()` | → `RecoverResult` | 显式 stale/corrupt 回收（原子 rename 捕获+二次验证；不自动） |
| `inspectLockState()` | → `{ state, detail }` | 只分类（LOCKED/STALE/UNKNOWN/LOCK_IO/PERMISSION） |
| `EnvironmentLockUnavailableError` / `EnvironmentLockIOError` / `EnvironmentLockOwnedByAnotherError` | — | 错误类型 |

### 存储布局

```
<dataDir>/locks/
  environment.lock                    # immutable ownership record（open('wx') 一次性写入，到 release 不替换）
  environment.heartbeat.<instanceId>  # heartbeat sidecar（atomicWriteFile 更新；文件名含 instanceId 隔离新旧 owner）
  environment.recovering.<rand>       # recovery 原子-rename 捕获的 quarantine 文件（二次验证失败时留存供诊断）
```

`dataDir` 缺省 `~/.dsh/dsh-config-manager`；CLI 与 host 的 locksDir 解析一致（`$DSH_HOME/dsh-config-manager/locks`）。

## 2. NON-NEGOTIABLE INVARIANTS（Phase 2 不变量）

- **L-INV-1**：所有权获取**必须** `open(lockPath, 'wx')` 独占创建；**禁止** exists→write、rm→recreate、用 `atomicWriteFile(environment.lock)` 获取所有权。
- **L-INV-2**：`environment.lock` **immutable**（创建后直到 release 不再 rename/replace）；heartbeat 走独立 sidecar，绝不影响 ownership path identity。
- **L-INV-3**：**operation-scoped `MutationLockToken`**；禁止进程级 reentrant（`owner.instanceId===myInstanceId→reentrant`、`lockHandle!=null→reentrant`、进程级 `reenterCount`）。
- **L-INV-4**：stale 检测只分类（LOCKED/STALE/UNKNOWN）；`STALE_LOCK_DETECTED`/`UNKNOWN_STATE` **都不是删除许可**；detect 绝不 unlink。
- **L-INV-5**：recover 是独立显式动作（CLI `--recover-stale-lock`），原子 rename 捕获 + 二次验证；二次验证失败 → quarantine，**绝不覆盖 successor**。
- **L-INV-6**：release 前校验磁盘 ownership `instanceId === token.instanceId`，不匹配不 unlink（ownership-lost violation）。
- **L-INV-7**：desructive mutation **无 `--force`**；必须成功 acquire，否则不执行（被占→409/423/skip）。
- **L-INV-8**：nested（rollback）显式传 `lockContext` reuse，不 reacquire（无 self-deadlock）。

> 层次：`Atomic file write（Phase 1）→ Cross-process lock（Phase 2 本阶段）→ Transaction recovery（Phase 3 journal）`。三层独立。Lock 只做 process coordination，不承担 atomic writing / transaction recovery / rollback operation semantics。

## 3. 已接入的 destructive 公共入口（M1–M14，host-boundary gate）

| 入口 | 位置 |
|---|---|
| Import apply | `src/index.ts` `/import/execute` `withMutationGate('import-apply')` |
| Restore | `/restore` dryRun=false `runWithMutationLock({op:'restore'})`（dryRun 只读不锁） |
| Profile switch/delete/rename/import | `/profiles/*` `withMutationGate` |
| Sync apply | `/sync/apply-items` `withMutationGate('sync-apply')` |
| Sync rollback | `/sync/rollback` `withMutationGate('sync-rollback')` |
| Manual Sync push | `/sync/push` `withMutationGate('sync-push')` |
| Snapshot delete / pin | `/snapshots/delete` `/snapshots/pin` gate |
| Backup-files delete | `/backup-files/delete` gate |
| AutoSync | `src/sync/autosync-scheduler.ts` runOnce `withMutationLock`（仅当注入 mutationLock） |
| Backup | `src/sync/backup-scheduler.ts` runOnce `runWithMutationLock`（锁被占→skipped(mutation-locked)） |
| CLI restore / reinstall / --recover-stale-lock | `src/cli/index.ts` runWithMutationLock + 显式 recover |
| ModelTools config_restore / config_sync_push | `src/core/model-tools.ts` runWithMutationLock |

> **接入方式**：host-boundary gate（公共入口 acquire，nested core 调用在已持锁区运行、不 reacquire），非设计 §4.2 的 core 引擎注入。Integration Auditor（t6）确认 14 项 12 正确 + 2 判断项；captain 接管补修 sync-rollback/backup-files-delete 漏锁。

## 4. 关键实现要点（改动前必读）

- **互斥来自 fs `open('wx')` 磁盘 EEXIST**，与 instanceId 无关 → 同进程并发正确被挡（符合 operation-scoped，非 process-level reentrant）。
- **autosync 的 gate 必须 `if (this.mutationLock !== undefined)` 守卫**：`withMutationLock(undefined)` 返回 `context:null` 表示「无锁环境放行」而非「被挡」——若不加守卫，旧测试（未注 lock）会全部挂（曾实测 16 失败，加守卫后全绿）。backup/model-tools/CLI 用 `runWithMutationLock`（undefined→直放行、被占→抛错）无需守卫。
- **release 顺序**：acquire 成功后句柄已 close；release 只 unlink（无开句柄 unlink，Windows 安全）；unlink 失败抛 `EnvironmentLockIOError` 且**保留 activeToken** 可重试。
- **heartbeat sidecar 更新走 atomicWriteFile**（Phase 1）；所有权获取绝不用它。
- **`--recover-stale-lock`**：CLI 独立命令，只对 inspectLockState 返回 `STALE_LOCK_DETECTED` 或 corrupt（`UNKNOWN_STATE` + detail 含 '无有效 owner'）生效；活锁/degraded/UNKNOWN 拒绝。

## 5. 验证基线（Phase 3 baseline）

- `npm run typecheck`：**PASS**
- `npm test`：**1176/1176 PASS**（Phase 1 基线 1150 + 新增 26 env-lock 用例，零回归）
- `npm run build`：**PASS**（tsc + tsdown client bundle）
- **env-lock.test.ts：26/26 PASS**，覆盖：exclusive-create / crash child-process / cross-process child / token 模型（非 reentrant/nested reuse/foreign/released）/ stale 六档状态表 / recovery quarantine / failure injection / Windows close→unlink / EPERM/EACCES / EBUSY retry / withMutationLock 双义。
- **Windows**：本机即 Windows 实跑（wx 独占创建、close→unlink、cross-process child-process 实测通过）。
- **独立最终审计（t8，captain 接管对抗性，门控）**：12 个攻击点全部 FAILED-TO-PROVE → **PHASE 2 = PASS**。

> **Phase 3 完成后：不允许测试数量低于 1176，除非明确说明删除原因。**（1176 + Phase 3 新增 ≥ 1176；不得静默删既有用例。）

## 6. 已知限制（原样保留，勿混淆概念）

| # | 限制 | 说明 |
|---|---|---|
| 1 | Windows `osProcessStartIdentity` 默认不可得 | heartbeat 过期+PID 存活 → 保守 `UNKNOWN_STATE`（不误删、不执行）；需宿主注入更强 OS identity 探测或接受保守 |
| 2 | NFS / 多机共享 `$DSH_HOME` 不支持 | open('wx') 在 NFS 可能不一致；Scope Exclusion |
| 3 | Backup / Sync push 纳入 GLOBAL 降低并发吞吐 | v1 安全优先，将来有性能证据再放宽（R4） |
| 4 | `/sync/push` preview 只读分支在 gate 内 | 锁被占时只读 preview 会 423（可用性成本非正确性），可后续移出 |
| 5 | 现有两个 RunRegistry 实例缺陷 | backup 与 makeRoutes 各自 `new RunRegistry`，建议合并共享单实例（hygiene，不替代 Lock） |
| 6 | orphan `.dshcm.*.tmp` sweep 仍未实现（Phase 1 follow-up） | 需结合 lock ownership + identity + age；不在 Phase 2 强制 |

## 7. Phase 3 预留（只记录边界，**现在不要实现**）

Phase 3 — Crash Journal + Reconciliation，依赖 Phase 1（Atomic）+ Phase 2（Lock，已完成）。预期层次：

```
Acquire mutation lock（Phase 2 完成）
  → Create durable journal
  → Create pre-operation snapshot
  → Apply atomic file operations
  → Validate
  → Commit journal
  → Release lock
```

`LockOwnershipRecord.journalId` 字段已**预留为 null**（Phase 3 登记 journal 用）。Lock 只做 coordination；journal/reconcile/自动 resume 属 Phase 3。

## 8. Recommended Context for New Conversation

本仓库：`D:\Projects\personal\dsh-config-manager`（Phase 2 working tree 未提交）

### REQUIRED（必读）
1. `PHASE2_HANDOFF.md`（本文档）
2. `CROSS_PROCESS_LOCK_IMPLEMENTATION_REPORT.md`（Phase 2 实现报告）
3. `CROSS_PROCESS_LOCK_DESIGN.md`（Rev 3 设计基线）
4. `src/utils/env-lock.ts` + `src/utils/env-lock.test.ts`

### WHEN DESIGNING PHASE 3（对照这些源码）
- `src/utils/env-lock.ts`（Lock：EnvironmentLockManager/MutationLockToken/withMutationLock）
- `src/core/backup.ts`（snapshot create/prune）
- `src/core/analyzer.ts`（executeImportPlan 入口）
- `src/core/restore.ts` / `src/core/rollback.ts`（回滚语义）

### 新对话原则
> 优先相信最终源码 + Implementation Report + HANDOFF。旧设计若与最终实现冲突 → **最终源码为准**。

---

## 9. 完成后：下一对话应执行的第一个动作

1. **先 `git add src/`（Phase 2 全部源码：env-lock.ts / env-lock.test.ts / types.ts / index.ts / autosync-scheduler.ts / backup-scheduler.ts / cli/index.ts / model-tools.ts）并 commit**（建议 `feat: Phase 2 cross-process lock`）。`CROSS_PROCESS_LOCK_*.md` 3 份文档可与源码同 commit 或另 commit；**不要**把 `competitor-research/` / `COMPETITOR_SOURCE_AUDIT.md` / `ATOMIC_*.md` 混入。
2. 确认基线 `npm test`=1176、typecheck、build 绿。
3. 再开始 Phase 3 inventory（journal 事务边界、reconciliation、crash recovery）。
