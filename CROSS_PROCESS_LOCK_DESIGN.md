# CROSS_PROCESS_LOCK_DESIGN — Phase 2：Cross-process Lock（设计文档 · Rev 2）

```
PHASE 2 STATUS: DESIGN（Rev 3 未进入 Implementation）
DESIGN REVIEW: NO-GO（先前）→ 全部 BLOCKER（1–4）CLOSED
```

- **上一阶段**：Phase 1 — Atomic Write（PASS，commit `351e235`）
- **当前工作区版本（package.json）**：`0.1.54`
- **日期**：`2026-08-29`
- **原则**：本阶段**只产出设计 + destructive-mutation inventory**，**不修改 Phase 2 源码**。设计评审通过后才进入实现。

> 事实来源：当前源码 + PHASE1_HANDOFF.md + ATOMIC_WRITE_IMPLEMENTATION_REPORT.md。本设计与 Phase 1 冲突处以最终源码为准。
> 本 Rev 3 在 Rev 2 基础上关闭 BLOCKER 4（operation-scoped Lock Token，禁止 process-level reentrant），并修正 stale detection 状态表、Windows/IO error 分类、recovery 二次验证失败的 quarantine 行为，新增对应测试。详见 `CROSS_PROCESS_LOCK_DESIGN_REVIEW.md`。

---

## 0. 一句话结论

Phase 2 提出一个 **GLOBAL EXCLUSIVE MUTATION LOCK**。所有权获取**必须**基于 `open(lockPath, 'wx')` 独占创建语义；**所有权记录文件 `environment.lock` 在持有期间是不可变（immutable）的 ownership record，创建后直到 release 绝不 rename/replace**；heartbeat 使用**独立的 sidecar 文件**（`environment.heartbeat.<instanceId>`），可安全复用 Phase 1 `atomicWriteFile`。**stale 检测与 stale recovery 严格分离**：程序化路径在检测到 `STALE_LOCK_DETECTED` 后**绝不自动 unlink/takeover**，只返回分类；recovery 是 CLI 上的**独立显式动作** `--recover-stale-lock`。**destructive mutation 必须成功获得 Environment Lock，否则不得执行（无 `--force` 旁路）**。

**Lock 只做 process coordination（谁持锁、谁被挡、检测 stale、显式 recover）。Lock 不解决**：atomic file writing（Phase 1）、multi-file transaction / crash recovery（Phase 3）、run 进度（RunRegistry，单进程）。

---

## 1. Destructive Mutation Inventory（调用链审计）

### 1.1 审计方法

按「**操作 → 真正的 mutation entry point → 它写什么 / 删除什么 → 由哪个进程触发 → 是否有 RunRegistry 防重**」逐条审计，覆盖 `src/core`、`src/sync`、`src/profiles`、`src/index.ts`（宿主路由）、`src/cli`、`src/core/model-tools.ts`。依据是最终源码（grep `fs.rm / .remove / executeImportPlan / restore / rollback / applyMergePlan / applyItems / runs.register` 全仓遍历 + 逐文件读）。

### 1.2 Inventory 表

> **锁定规则（Rev 2 定稿）**：**Read-only operations 不锁。Canonical / persistent mutation 默认全部锁**（GLOBAL EXCLUSIVE MUTATION LOCK）。不引入 resource-level concurrency optimization。

| # | 操作（Operation） | Mutation entry point | 触碰的持久状态 | 触发进程 | 现有防重 | Phase 2 v1 锁 |
|---|---|---|---|---|---|---|
| M1 | **Import apply**（导入确认执行） | `POST /import/execute` → `executeImportPlan` | `$DSH_HOME` 配置（13 分区）+ 快照 + 插件 node_modules | Web Host | `runs.register('import')`（单进程） | **GLOBAL** |
| M2 | **Restore**（快照恢复执行） | `POST /restore` (dryRun=false) → `planRestore` + `executeRestorePlan`；CLI `restore` → `restore()`；ModelTools `config_restore` | `$DSH_HOME` 文件覆盖/删除 + pre-restore + 插件卸载 | Web + **CLI** + **ModelTools** | `runs.register('restore')`（仅 Web）；CLI/ModelTools 无 | **GLOBAL** |
| M3 | **Rollback**（导入/同步失败补偿） | `rollback()`（`executeImportPlan` / `applyMergePlan` / `applyItems` 内部） | `$DSH_HOME` 逆序恢复 | 随 M1/M6 同进程运行 | 随父 run | **继承父 lock，不 reacquire**（防 self-deadlock） |
| M4 | **Profile switch** | `POST /profiles/execute-switch` → `profileManager.executeSwitch` | `$DSH_HOME` 分区 apply | Web | `runs.register('profile-switch')` | **GLOBAL** |
| M5 | **Profile delete / rename** | `POST /profiles/delete` → `profiles.delete`（`fs.rm`）；`/profiles/rename` | `profiles/<name>/` 目录删除/移动 | Web | 无 | **GLOBAL** |
| M6 | **Sync apply**（自动/一键应用） | `engine.applyMergePlan`（autosync）/ `engine.applyItems`（`POST /sync/apply-items`）→ `executeImportPlan` | `$DSH_HOME` 分区 + 快照 + rollback | AutoSync + Web | `sync-apply` RunKind 存在但从未 register；autosync 走 `runs.register('autosync')` | **GLOBAL** |
| M7 | **Auto Sync mutation**（双向，含 apply） | `autosync-scheduler.runOnce` → `applyMergePlan` + `push` | 本地分区 apply + sync-state | AutoSync 后台 | `runs.register('autosync')` | **GLOBAL** |
| M8 | **Manual Sync push** | `POST /sync/push` → `engine.push` | sync-state + 本地散文件副本 + 远端 | Web | 无 runs 登记 | **GLOBAL**（v1 直接纳入，见 §4.4） |
| M9 | **Snapshot delete**（手动删快照） | `POST /snapshots/delete` → `deleteSnapshot`（`fs.rm`） | `snapshots/<id>/` 目录 | Web | 无 | **GLOBAL** |
| M10 | **Snapshot prune**（自动保留清理） | `FileSnapshotStore.save` → `prune()`（`fs.rm`） | `snapshots/<id>/` 目录 | 随 M1/M6 同进程 | 随父 run | 共享父 lock（不独立抢） |
| M11 | **Backup**（定时/手动全量备份） | `BackupScheduler.runOnce` → `exporter.export` + `pruneAutoBackups` | `exports/` ZIP 写入/删除 | Backup + Web | `runs.register('backup-schedule')`（单进程） | **GLOBAL**（v1 直接纳入） |
| M12 | **Cache cleanup**（缓存清理） | `cleanupCaches()`（宿主后台） | `tmp/` zip、`exports/` 过期 zip、`market/cache`、`market/work` | Web 后台 | 无 | **不含 Environment Lock**（见 §4.5 拆分策略） |
| M13 | **CLI restore / reinstall** | `src/cli/index.ts` `runCli` → `restore` / `reinstall` | `$DSH_HOME` 文件 + 插件 + pnpm store/npm cache | **CLI 独立进程** | **无** | **GLOBAL**（最高优先级盲区） |
| M14 | **Model Tools**（agent 会话内） | `registerModelTools`：`config_restore`（confirm:true → `restore()`）/ `config_sync_push` / `config_sync_apply` 等 | `$DSH_HOME` 文件 + 导出 ZIP + 同步 | **Agent 会话 / 其它进程** | **`ModelToolsDeps` 不含 `runs`** → 完全无 | **GLOBAL**（关键盲区） |

### 1.3 Read-only（无需 Lock，可安全并发）

`exportPreview` / `analyzeImport` / `createImportPlan`（内存解析零写入）、`planRestore` dryRun、`profiles.analyzeSwitch`、`listSnapshots` / `listBackupFiles` / `SyncEngine.listSnapshots` / `syncHistory`、`SyncEngine.pull` / `preview` / `merge` / `hasNewRemoteSnapshot` / `hasLocalChanges`、全部 `GET` 状态/配置读路由、`market/cache` 与 `market/work` 的 cache cleanup（见 §4.5）。

### 1.4 调用链图（destructive 汇聚点）

```
                              ┌──────────────────────────────────────────────┐
                              │   GLOBAL EXCLUSIVE MUTATION LOCK             │
                              │   locks/environment.lock (immutable owner)   │
                              └──────────────────────────────────────────────┘
   Web Host (HTTP)                     AutoSyncScheduler        BackupScheduler
   ├ /import/execute ─────────┐              │                        │
   ├ /restore ────────────────┤              │ (autosync)             │ (backup-schedule)
   ├ /profiles/execute-switch─┼───┐          │                        │
   ├ /profiles/delete/rename ─┼───┤          │                        │
   ├ /snapshots/delete ───────┼───┼──────────┼────────────────────────┼
   ├ /sync/apply-items ───────┼───┼──────────┘                        │
   ├ /sync/push * ────────────┤   └─► core 引擎入口（统一注入 withLock） │
   └ /backup-schedule/run * ──┼───► executeImportPlan / restore /     │
                              │       profiles.delete / executeSwitch /│
   CLI 独立进程 (src/cli)      │       deleteSnapshot / engine.apply* / │
   └ restore / reinstall ─────┤       exporter.export → rollback（继承）│
                              │                                        │
   Model Tools (agent 会话)   │                                        │
   └ config_restore / config_sync_* ───► (同一批 core 引擎)              │
                              └──────────────────────────────────────────┘
   (M8/M11 经 GLOBAL；M12 cache 不含 Env Lock，见 §4.5)
```

**关键洞察**：所有 destructive mutation 最终汇聚到**同一批 `src/core/*` 引擎函数**（`executeImportPlan` / `restore` / `rollback` / `profiles.delete|executeSwitch` / `deleteSnapshot` / `engine.applyMergePlan|applyItems` / `exporter.export`）。因此 lock 应放在**引擎入口层（core facade）通过可选 `lock?` 参数统一注入**，一次性覆盖所有调用方（Web/CLI/ModelTools/调度器），避免在路由层散点埋点。

---

## 2. 进程场景分析（谁和谁竞争）

### 2.1 当前真实架构

- **一个 DSH 宿主进程**内跑：Web 路由（`makeRoutes` 的 `runs = new RunRegistry`）、`AutoSyncScheduler`、`BackupScheduler`。**注意：`src/index.ts` L3961 backupScheduler 与 L3971 makeRoutes 各自 `new RunRegistry`，是两个独立实例**（backup 与 export/import/restore 互不防重）。
- **CLI 是独立进程**：`src/cli/index.ts` `#!/usr/bin/env node`，无 RunRegistry。
- **Model Tools**：`ModelToolsDeps` 不含 `runs`，可能来自其它 DSH 会话/进程。

### 2.2 竞争矩阵

| 竞争对 | 场景 | 危险 |
|---|---|---|
| Web import ↔ Web restore | 两个 tab 并发（跨 kind） | RunRegistry 只挡同 kind；跨 kind 未挡 → 交错写 `$DSH_HOME` |
| Web Host ↔ CLI | 网页导入中，终端跑 `dsh-config-manager restore` | **无防护** → 交错覆盖/删除 |
| AutoSync ↔ 手动导入 | 后台 autosync apply 同时用户 import | **`autosync` 与 `import` 两个 RunRegistry 实例** → 可并发 |
| Backup ↔ Sync push | 定时备份写 exports 同时手动 push | 目录并发写 + 保留策略互删（低危） |
| ModelTools restore ↔ Web import | agent 会话恢复同时网页导入 | **无防护** |
| CLI reinstall ↔ AutoSync | CLI 卸载/重装同时后台 sync apply | **无防护** → 半装插件 + 配置交错 |

### 2.3 结论

单进程内存 `RunRegistry` 只能：① 同 kind 内防重、② 同进程内防重。**无法**挡跨 kind、跨进程、或两个 RunRegistry 实例之间的并发。**Cross-process Lock 是必需的。**

**修复建议（hygiene/correctness，低风险，不替代 Lock）**：一个宿主进程**共享一个 RunRegistry**（合并 L3961 与 L3971 的两个实例）。这属于 cleanup，不改变 Lock 设计；但 Lock 能兜底该缺陷（详见 §5）。

---

## 3. 锁语义（Lock Semantics）

### 3.1 所有权获取 primitive（NON-NEGOTIABLE）

> **获取锁所有权必须用 `open(lockPath, 'wx')`（exclusive create）语义，原子获得。**
> - **禁止** `exists(lock) → write(lock)`（TOCTOU 竞态）。
> - **禁止**用 Phase 1 的 `atomicWriteFile` 获取所有权——它是 `rename` 替换语义，会替换 ownership pathname 对应的 inode/file object，破坏互斥。
> - **禁止** `rm(lock) → recreate`。
> - **禁止** `check → unlink → acquire` 被包装成「自动 takeover」（见 §6.5）。

**实现建议**：新增 `src/utils/env-lock.ts`，导出 `acquireExclusive(path)` primitive（与 atomic-write 并列的**新 primitive**，不混入 `atomic-write.ts`）。

```ts
// 伪代码：exclusive create —— 所有权凭证 = 打开的句柄；创建后 lock 文件不再被 rename/replace
async function acquireExclusive(path: string): Promise<LockHandle> {
  const h = await fs.open(path, 'wx', 0o600) // 'wx'：不存在则创建并独占；已存在则抛 EEXIST
  try { await h.writeFile(ownerJson); await h.sync() } // 一次性写入不可变 owner，绝不再次替换
  catch (e) { await h.close(); try { await fs.unlink(path); } catch {} ; throw e }
  return h // 持有打开句柄 = 持有锁
}
```

### 3.2 BLOCKER 1 — ownership 不可被替换（immutable ownership record）

> **OWNERSHIP FILE INODE/文件对象 生命周期必须稳定：创建后直到 release，`environment.lock` 绝不被 rename/replace。**

- ownership 记录文件：`locks/environment.lock` —— **immutable ownership record**。创建（`open('wx')` + 一次性写 owner）后不再写、不再替换，直到 release 删除。
- **heartbeat 独立 sidecar**（§6），**绝不写入 ownership record**。故不存在「用 atomicWriteFile 替换 ownership」的冲突。
- **为什么 sidecar 而不是同一文件**：若 heartbeat 用 `atomicWriteFile(environment.lock)`，rename 会替换 ownership pathname 对应的 inode → 破坏「句柄=所有权」的凭证关系，且可能覆盖他人重建的新 owner。sidecar 用**不同文件名**，其 atomic replacement 不触碰 ownership path identity。
- **四保证**：
  1. ownership path identity 生命周期稳定（同一 inode 直到 release）；
  2. heartbeat replacement 不影响 ownership（不同文件）；
  3. release 只删除**自己拥有**的 ownership record（§7 校验 instanceId）；
  4. heartbeat cleanup 不能误删下一 owner 的 metadata（sidecar 文件名含 `instanceId`，cleanup 按 instanceId 匹配）。

### 3.3 锁类型（Rev 3 定稿）

**Phase 2 v1 只采用一把 GLOBAL EXCLUSIVE MUTATION LOCK**（`locks/environment.lock`），覆盖 §1.2 全部 M1–M11, M13–M14。**不做 resource-level lock hierarchy / concurrency optimization，不引入 EXPORTS_LOCK / 细粒度锁。** 未来有真实性能证据再放宽（写入开放决策 R4）。

### 3.4 Operation-scoped Lock Token（BLOCKER 4 — 禁止 process-level reentrant）

> **process-level reentrant lock 不安全，禁止。** 同一 Web Host / CLI Host 内可能有两个并发 destructive operation（如 `import` 与 `restore`）拥有相同 `instanceId`。若仅因 process instance 相同就允许 re-entry，Operation B 会绕过 Environment Lock，与 Operation A 同时 mutation —— 违反 GLOBAL EXCLUSIVE MUTATION LOCK 核心不变量。

**必须改为 operation-scoped Lock Context / Token：**

```
EnvironmentLockManager
  → acquire()                 → 成功获得环境锁，返回 MutationLockToken（或 LockContext）
  → release(token)            → 释放该 token 持有的锁
  → validate(token)           → 校验 token 是否有效且属于当前 manager/owner
```

- 成功 `acquire` 返回一个 **`MutationLockToken`**，**只属于当前 mutation 调用链**。
- 公共 mutation entry **没有 token** → 必须 `acquire`。
- 内部 nested mutation **显式接受 parent token** → `validate(token)` → *reuse held ownership* → **不 reacquire**。
- **其它并发 operation**（即使同 pid、同 instanceId、同 EnvLock manager、同 Web Host）只要**没有当前 parent token** → **必须重新 acquire**；若 lock 已存在 → 返回 `LOCKED`（被挡）。

```
executeImportPlan(plan, { lockContext? })          // 无 token → acquire → token X
  → snapshot
  → apply
  → rollback(..., { lockContext: X })              // 只有显式收到有效 token X 才允许 reuse
executeRestorePlan(..., { lockContext? })
applyMergePlan(..., { lockContext? })
```

**禁止实现**：
- `owner.instanceId === myInstanceId → reentrant`
- `this.lockHandle != null → reentrant`
- 进程级 `reenterCount` 判断 nested ownership

**进程身份（instanceId / pid / OS identity）只能用于**：
- diagnostics
- stale detection
- release ownership validation

**不能用于判断 async operation 是否属于当前 owner 调用链。**

**显式 context propagation（而非 AsyncLocalStorage）**：因可测试、调用关系明确、不会把独立 async operation 误认为 nested、Phase 3 可扩展为 `Transaction/MutationContext`。

> **Phase 3 预留（仅字段位，本阶段不实现）**：
> ```ts
> interface MutationContext {
>   lockToken: MutationLockToken   // 本阶段实现
>   operationId?: string           // 预留
>   journalId?: string             // 预留 Phase 3
>   snapshotId?: string            // 预留 Phase 3
> }
> ```

**token 生命周期规则**：
- token 只属于一次 `acquire`（一个 ownership 持有周期）；
- token 在 `release` 后**失效**（已释放的 token 不得再授权 nested mutation，test#4）；
- 来自其它 manager / owner 的 token（foreign）**不得**绕过 acquire（test#3）；
- `validate(token)` 校验：token 未被 release、归属于当前 manager 的当前 ownership、且未过期。

---

## 4. Acquisition / Release 边界

### 4.1 锁定范围

- **获取时机**：在 destructive mutation **实际开始写磁盘之前**获取，覆盖整段（含 `createSnapshot` 前置快照写）。在 core 引擎函数入口 `withLock()`。

### 4.2 锁注入点（一次性覆盖全部调用方）

| 函数（core 引擎） | 加锁模式 |
|---|---|
| `executeImportPlan` | 入口 `withLock()` |
| `restore`（非 dryRun） | 入口 `withLock()` |
| `profiles.executeSwitch` | 入口 `withLock()` |
| `profiles.delete` / `profiles.rename` | 入口 `withLock()` |
| `deleteSnapshot`（手动） | 入口 `withLock()` |
| `engine.applyMergePlan` / `engine.applyItems` | 入口 `withLock()` |
| `exporter.export`（backup 用） | 入口 `withLock()` |
| CLI `restore` / `reinstall` 实际执行分支 | 入口 `withLock()` |
| ModelTools `config_restore` 等 destructive 分支 | 入口 `withLock()` |

这些函数增加**可选 `lockContext?: MutationLockContext` 参数**（内含 `MutationLockToken`），各调用方在构造时注入同一 `dataDir` / `EnvironmentLockManager`。core 引擎保持可测（注入 mock token 与 mock io）。

**入口分两类**：
- **公共 mutation entry（无 token）**：`executeImportPlan` / `restore` / `executeSwitch` / `profiles.delete|rename` / `deleteSnapshot` / `applyMergePlan` / `applyItems` / `exporter.export` / CLI / ModelTools —— 内部 `acquire()` 获取 token。
- **内部 nested mutation（显式接受 parent token）**：`rollback` —— 由父操作传入 `{ lockContext }`，`validate` 后 reuse，不 reacquire。

### 4.3 Rollback 不独立 reacquire（operation-scoped token 传递）

- `rollback()` **是父 mutation（import / sync apply）的子阶段**，**不会独立 reacquire**。实现为：parent 把其 `MutationLockToken` 显式传入 `rollback(..., { lockContext })`；rollback 校验 token 有效后 **reuse held ownership**，不 reacquire（防 self-deadlock）。
- **绝不**用进程级 reentrancy（instanceId/handle/reenterCount）判断 nested —— 见 §3.4。
- **并发独立操作**（如另一进程/另一无 token 调用链的 restore）仍需 acquire，被 `LOCKED` 挡。
- 测试：nested rollback 收到有效 token 不 reacquire / 不死锁；无 parent token 的并发操作仍被挡（§11.2）。

### 4.4 Exceptions（Rev 2 定稿：GLOBAL 覆盖，不例外）

- **Sync push（M8）与 Backup（M11）Phase 2 v1 直接纳入 GLOBAL lock**（评审定稿：不做局部优化，将来有性能证据再放宽）。它们虽不修改 `$DSH_HOME`，但纳入全局锁代价低、语义统一、杜绝「备份写 exports 与同步/清理并发」的一切隐患。
- **Snapshot prune（M10）内嵌于 save**：不独立抢锁，随父操作在同一把锁内完成。

### 4.5 Cache Cleanup（M12）—— 拆分，不扩大 Env Lock 职责

> 评审定稿：不要为了 cache cleanup 扩大 Environment Lock 职责。

| cleanup 分区 | 是否需要 Environment Lock | 策略 |
|---|---|---|
| `market/cache` cleanup | **否** | 可重建（index/条目缓存），无需锁 |
| `market/work` cleanup | **否** | 只读 git 工作副本，读时自动重建 |
| `exports` cleanup | **分析**：会与 Backup 输出 / pruneAutoBackups 竞争 | Phase 2 v1 三种策略任选其一，**不引入 EXPORTS_LOCK hierarchy**：① 在相关 mutation 已持 GLOBAL lock 时执行；② 跳过 active/recent export；③ 后续再考虑 EXPORTS_LOCK。默认采用**策略②（按 mtime 跳过最近写过的 export）**，最简单安全。 |

> **决定**：`cleanupCaches` 对 `market/cache`、`market/work` **不抢 Environment Lock**；对 `exports` 段**按 mtime 跳过 24h 内写过的 ZIP**（避免误删 backup/push 刚产出），不与 Backup 竞争。若将来需要，另行评估 EXPORTS_LOCK（当前不引入）。

### 4.6 Lock 获取失败（被他人占用）时的行为

- **Web / AutoSync / Backup**：返回「另一项 DSH 任务正在进行」（跳过/409），不阻塞、不强等。
- **CLI**：默认失败退出，提示「检测到其它 DSH 任务正在进行（lock owner instanceId=… 见 locks/environment.lock）。可用 `--recover-stale-lock`（仅限确实 stale）或稍后重试」。
- **Model Tools**：返回「环境锁被占用，请稍后重试」。

---

## 5. RunRegistry 交互（Lock 与已有防重的分工）

| 维度 | RunRegistry（单进程已有） | Environment Lock（跨进程新增） |
|---|---|---|
| 进程内同 kind | ✅ 友好防重（import vs import → 409） | ✅ 更强的同 kind 挡 |
| 跨进程 | ❌ 不感知 | ✅ 唯一防线 |
| 跨 kind | ❌ import vs restore 不互斥 | ✅ 全部互斥 |
| 进度/恢复 | ✅ /runs 轮询、刷新恢复、log | ❌ 无进度语义 |
| 权限 | 全仓 loopback guard 前置 | 不涉及 |
| 生命周期 | 进程内内存 Map | 文件级、跨进程持久 |

**分工结论**：
1. **RunRegistry 保持现状**：同 kind、同进程的「友好」防重 + 进度展示。
2. **Environment Lock 是 correctness boundary**：挡 RunRegistry 覆盖不了的（跨 kind、跨进程、两实例间）并发。lock 获取失败与 RunConflictError 并存（Web 上都返回 409/跳过，前端 UX 统一）。
3. **不把 lock 塞进 RunRegistry**：RunRegistry 是内存 Map，无跨进程语义；lock 是文件级原语。二者互补、独立。
4. **建议修复**：一个宿主进程**共享一个 RunRegistry**（合并 index.ts 中 backup 与 makeRoutes 的两个实例）。低风险 hygiene/correctness cleanup，不替代 Environment Lock。

---

## 6. Heartbeat / Process Identity / Stale（BLOCKER 2 相关）

### 6.1 文件结构（Rev 2 定稿 — ownership 与 heartbeat 分离）

```
<dataDir>/locks/
  environment.lock                     # immutable ownership record（一次性写入，直到 release 不再替换）
  environment.heartbeat.<instanceId>   # heartbeat sidecar（用 Phase 1 atomicWriteFile 更新）
```

**ownership record `environment.lock` 内容（写入后不可变）**：

```jsonc
{
  "schemaVersion": 1,
  "owner": {
    "instanceId": "uuid",              // 本进程实例唯一 id（随机 UUID，进程级锚点）
    "instanceStartedAt": 172...,        // 本实例启动时刻（Date.now()，进程级，只描述「何时启动」）
    "pid": 12345,
    "hostname": "myhost",
    "osProcessStartIdentity": null      // 仅 OS 可验证的进程创建身份（见 §6.2）；null = 无法可靠取得
  },
  "op": "import",
  "target": "executeImportPlan",
  "acquiredAt": 172...,
  "lockVersion": "1.0.0",
  "journalId": null                     // 预留 Phase 3，本阶段不实现
}
```

**heartbeat sidecar `environment.heartbeat.<instanceId>` 内容**：

```jsonc
{
  "ownerInstanceId": "<此 heartbeat 属于哪个 instanceId>",
  "heartbeatAt": 172...,               // 最近续期
  "seq": 12                             // 递增序号，检测写入撕裂/旧文件
}
```

- **heartbeat 文件名含 `instanceId`** → 下一 owner 的 heartbeat sidecar 文件名不同，天然区分；cleanup 只删 `environment.heartbeat.<自己的 instanceId>`，**不误删下一 owner**。
- **heartbeat 更新 = 对 sidecar 做 Phase 1 `atomicWriteFile`**（安全：不同文件名，rename 替换的是 sidecar，不触碰 ownership path identity）。

### 6.2 Process Identity 修订（区分「instance 时间戳」与「OS 验证的进程创建身份」）

> 不要把 `Date.now()` captured at startup 直接命名为 `processStartTime`。区分：

| 字段 | 语义 | 可否用于 PID reuse 判断 |
|---|---|---|
| `instanceId` | 本进程随机 UUID 实例锚点 | 否（随机标识，非 OS 验证） |
| `instanceStartedAt` | 进程启动 `Date.now()`；识别「同 pid 多次启动的时间差」的弱信号 | **否**（应用层时间戳，可被伪造/偏移） |
| `pid` | 进程 id | 仅配合 OS identity |
| `hostname` | 诊断（标识机器） | 否 |
| `osProcessStartIdentity` | **仅 OS 能验证**的进程创建身份（如 Linux `/proc/<pid>/stat` starttime、macOS `ps -o lstart`、Windows `wmic/Get-Process` creation date） | **是**（PID reuse 判断的唯一可靠依据） |

- **只有 `osProcessStartIdentity` 能用于 PID reuse 判断。**
- **无法可靠取得 OS process identity 时 → 保守拒绝 recovery**（§6.5）：**不能因为 heartbeat timeout 就假定可以安全删除 lock**。若 owner 的 `osProcessStartIdentity` 无法取得，则即使在 heartbeat 超时后仍**只能判定为 `UNKNOWN_STATE`，拒绝自动/显式 recovery**，需人工介入。

### 6.3 Stale 检测（detection）—— 明确区分于 recovery

**检测（仅分类，不删除）**。`acquire` 遇已有 lock 时按下方正式状态表判定：

```
open(lockPath, 'wx')
  ├─ 成功                              → ACQUIRED（写入 owner，持句柄 → 返回 MutationLockToken）
  └─ EEXIST（existing lock collision）
       ├─ 读 ownership + heartbeat sidecar，按状态表判定
       └─ EPERM/EACCES → 见 §8（绝不直接误报「另一任务在运行」）
```

**stale 检测正式状态表**：

| 信号组合 | 判定 |
|---|---|
| heartbeat fresh（未超时） | **LOCKED**（owner healthy） |
| heartbeat expired AND PID 不存在 | **STALE_LOCK_DETECTED** |
| heartbeat expired AND PID 存在 AND OS process identity ≠ recorded | **STALE_LOCK_DETECTED**（PID reuse） |
| heartbeat expired AND PID 存在 AND OS process identity 相同 | **LOCKED**（owner alive / heartbeat degraded） |
| identity/liveness probe 无法可靠确定 | **UNKNOWN_STATE** |

**`UNKNOWN_STATE` 语义（严格）**：
- **不删除**
- **不 recover**
- **destructive operation 不执行**（返回拒绝/跳过）

**判定细则**：
1. `STALE_AFTER_MS`（≥ 10×heartbeatInterval，默认 10s）为 heartbeat 超时阈值。
2. PID 存在性：`kill(pid,0)` 抛 `ESRCH` → 不存在；`EPERM` → 存在但无权信号（视为 alive）。
3. PID reuse 判断**只看 OS process identity**（`osProcessStartIdentity`）；无法取得 → 不判 stale。
4. heartbeat degraded（写 fail）但 PID 存在且 identity 相同 → **LOCKED**（owner 活着，不得恢复）。

> **NON-NEGOTIABLE：STALE_LOCK_DETECTED / UNKNOWN_STATE 都不是删除许可。检测绝不 unlink；recovery 是独立显式动作（§6.5）。**

### 6.4 Heartbeat 语义（sidecar lease）

| 项 | 设计 |
|---|---|
| filename | `locks/environment.heartbeat.<instanceId>` |
| owner binding | 内容含 `ownerInstanceId`，文件名含 `instanceId`，双绑定 |
| interval | 建议 ≤1.0s（长操作如装插件数十秒靠它防误判） |
| 更新方式 | 对 sidecar 做 Phase 1 `atomicWriteFile`（原子替换 sidecar 内容，不影响 ownership） |
| stale threshold | `STALE_AFTER_MS` ≥ 10×interval（默认 10s） |
| cleanup | 释放锁时删自己的 sidecar；崩溃残留按 instanceId + age 判定（§6.5 的 recovery 或人工） |
| crash residue | `environment.heartbeat.<deadInstance>.lease` 残留 → 由 stale 判定识别，但不自动删（除非 recovery 证明 dead） |
| 下一 owner 区分旧 heartbeat | 新 owner 的 `instanceId` 不同 → 文件名不同 → 绝不混淆 |
| heartbeat write failure | **记录 degraded lease 状态**（内存 flag + 日志）；**不立即中断当前 mutation**；因 v1 禁止 automatic takeover，另一进程不会因此自动删除本 ownership lock（安全边界由此保证） |

> degraded lease 说明：心跳写失败只是「stale 保护窗口」缩短，不改变「无自动 takeover」这一安全事实；当前 mutation 继续。

### 6.5 Stale Recovery（独立显式动作，非自动）—— BLOCKER 2 CLOSED

> **Phase 2 v1：NO AUTOMATIC STALE TAKEOVER。默认禁止自动 unlink + takeover。**
> 原因：`read stale → 其它 contender 创建新 owner → 当前 contender unlink` 存在删除新 owner 的 TOCTOU。
> **禁止**把 `check → unlink → acquire` 包装成看似安全的自动 takeover。

**允许的 recovery（Phase 2 v1）**：CLI 显式动作 `dsh-config-manager --recover-stale-lock`，**独立、用户触发、必须显式确认**。它只能：
1. **inspect**：读 `environment.lock` + heartbeat + OS process identity；
2. **prove stale**：按 §6.3 完整判定，**必须**得到 `definitely stale`（heartbeat 超时 + OS 验证进程不存在）；无法证明 → 拒绝 recovery；
3. **perform defined recovery**：用**原子捕获**删除（非裸 unlink）：

```
--recover-stale-lock 协议：
  1. 读取 ownership + heartbeat，判定 definitely stale（否则 ABORT，不动作）
  2. 原子 rename environment.lock → environment.recovering.<myInstanceId>（一次性捕获当前 inode）
     - 若 rename 失败（lock 已被他人接管/消失）→ ABORT，无副作用
  3. rename 成功后，读回 environment.recovering.<myInstanceId>，验证：
     - instanceId === 步骤 1 判定 stale 的那个 owner？
     - osProcessStartIdentity 仍证明进程不存在？
     - 若验证失败 → 见步骤 4b（禁止 rename 回退）
  4. 验证通过 → unlink(environment.recovering.<myInstanceId>)
  4b. 二次验证失败 → **禁止无条件 rename 回 environment.lock**（新的 owner 可能已在步骤 3 期间
      创建了新的 environment.lock，rename 回会覆盖 successor）。安全行为：
      - 不碰当前 environment.lock（不动 successor）
      - 保留 captured environment.recovering.*  quarantine 文件供诊断
      - 返回 recovery validation failure
      - 后续人工清理
  5. 清理该 owner 的 heartbeat sidecar（按 stale instanceId 匹配）
  6. 返回；调用方随后可重新 acquire
```

> 该协议**只删除「被原子 rename 捕获且再次验证确认 stale」的那个 inode**，不会删除 rename 之后新 owner 创建的 inode（新 owner 的文件不是被 rename 捕获的那一个）。**二次验证失败绝不覆盖 successor owner。** **它仍不是自动的**：仅在用户显式 `--recover-stale-lock` + 确认后触发。

**若团队坚持自动 takeover（不在 v1）**：必须先在 Design 给出可证明「不会删除新 owner」的 CAS/fencing protocol + 正式并发证明 + 测试计划，评审通过后才能启用。**在证明前，v1 保持 NO AUTOMATIC STALE TAKEOVER。**

### 6.6 Heartbeat / Identity 汇总不变式

1. ownership 文件 immutable；heartbeat 走 sidecar；二者 path identity 分离。
2. stale 检测只分类、不删除；DELETE 仅发生于显式 recovery 的原子捕获 + 二次验证。
3. PID reuse 判定只看 `osProcessStartIdentity`；取不到 → 保守拒绝 recovery。
4. 无法证明 orphan（含 stale lock / 残留 heartbeat）→ 不删除。

---

## 7. Release Ownership Safety（BLOCKER 3 相关）

> Release **不能**简单 `close() → unlink(environment.lock)` 而不验证 pathname 仍属于自己。

**Release 前置验证**：
1. 读当前 `environment.lock` 的 owner 内容；
2. **校验 `owner.instanceId === this.instanceId`**；
3. **仅匹配才删除**（先 `close()` 再 `unlink(environment.lock)`——Windows 必须先 close 再 unlink 才能删被占用文件）；
4. **不匹配 → 不 unlink，返回/记录 `ownership-lost` invariant violation**（防御异常恢复 / 人工修改 / 未来 stale recovery）；
5. 释放后 `cleanupSync()`：删除自己的 `environment.heartbeat.<instanceId>`（按 instanceId 匹配）。

---

## 8. Windows / POSIX 差异

### 8.1 IO error 分类（BLOCKER 4 补充）
**不要把所有 `EEXIST`/`EPERM`/`EACCES` 一律解释成 LOCKED**：

- **`EEXIST`** → existing lock collision → inspect owner → 按 §6.3 状态表判定。
- **`EPERM` / `EACCES`** → **不得直接当 LOCKED 上报**：
  1. 检查 `environment.lock` 是否确实存在且可读取；
  2. **存在** → 按 existing lock inspect（§6.3）；
  3. **不存在 / 无法确认** → 返回 **`LOCK_IO_ERROR` / `PERMISSION_ERROR`**（lock 目录权限 / ACL / 文件系统错误）。

> **不得向用户错误报告「另一个任务正在运行」当真实原因是 lock 目录权限 / ACL / 文件系统错误。**

### 8.2 平台差异表

| 维度 | POSIX (Linux/macOS) | Windows | 处理 |
|---|---|---|---|
| `open('wx')` | EEXIST | EEXIST/EPERM（同样失败） | `EEXIST` → inspect owner；`EPERM/EACCES` → 按 §8.1 分类，不直接当 LOCKED |
| 持句柄 + unlink | 可 unlink 打开中的文件 | **不能 unlink 被占用文件**（EBUSY/EPERM） | **统一 close → unlink 顺序** |
| 进程 liveness | `kill(pid,0)` + `/proc/<pid>/stat` starttime 可靠 | `kill(pid,0)` Node 支持 ESRCH；creation date 需 `wmic/Get-Process` | 抽象 `probeProcessIdentity` 可注入；Windows 提供兜底 + 测试 mock |
| 权限 0600 | 有效 | 权限位弱（ACL），仅记录不强断言 | 与 Phase 1 sensitive 同语义 |
| 文件名安全 | 无限制 | 保留字符 | owner 在文件内容，不进文件名（hostname 不编码进路径） |
| crash 后 OS 释放句柄 | ✅ | ✅ | 残留文件由显式 recovery 接管（无自动） |

---

## 9. Orphan `.dshcm.*.tmp` 与 Lock 的关系

- **Phase 2 不要求必须实现 orphan sweep**（可留 Phase 1.5 / Phase 后续）。
- **若实现**：必须在**成功获取 GLOBAL lock 之后**执行（写操作 = mutation，需在锁内）；且仍需 **age + pid + instance/process identity** 三条保守证明。**无法证明 orphan → 不删除。**
- 锁文件 `locks/environment.lock` 命名不含 `.dshcm.` 前缀 → 不被 orphan sweep 误伤。
- lock 文件本身不参与 orphan sweep；orphan sweep 以 lock 为「安全窗」。

---

## 10. Phase 2 v1 明确不支持（Scope Exclusions）

- multi-host shared `$DSH_HOME`
- NFS distributed locking
- resource-level lock hierarchy
- lock bypass / `--force` 绕过活锁的 destructive mutation
- automatic unsafe stale takeover
- Phase 3 Journal
- fencing-token-based distributed transaction

> **NON-NEGOTIABLE：destructive mutation 必须成功获得 Environment Lock，否则不得执行。** 不存在 `--force → ignore active lock → destructive mutation`。

---

## 11. 测试 / 故障注入计划（Phase 2 实现阶段）

### 11.1 单元测试（`src/utils/env-lock.test.ts`）

1. `open('wx')` exclusive-create：并发 acquire 只有一个成功。
2. 不存在 `exists→write` 竞态（源码不含）。
3. 持句柄 = 持锁（child process 验证）。
4. 释放顺序 close→unlink；unlink 失败返回明确错误、不泄句柄。
5. **owner metadata 写入 / 读回一致（pid/instanceId/hostname/instanceStartedAt/osProcessStartIdentity）**。
6. **heartbeat sidecar 更新不替换 `environment.lock`**（inode 不变断言）。
7. **old heartbeat sidecar 不影响新 owner**（不同 instanceId 文件名隔离）。
8. **release instanceId mismatch → 不 unlink + ownership-lost violation**。
9. heartbeat 续期（可注入时钟）。
10. heartbeat write failure → degraded lease 标记 + 不中断 + 无自动删除。
11. stale 判定：心跳超时+进程不存在 → definite stale；心跳超时+进程存活 → 非 stale；PID 复用 → stale；心跳未超时 → 非 stale；OS identity 取不到 → UNKNOWN_STATE。
12. **definitely stale → 返回 STALE_LOCK_DETECTED（不自动删除）**。
13. **两 contender 同时发现 stale → 两者都不得自动 destructive takeover**。
14. **recovery 只删被 rename 捕获且二次验证的 inode；新 owner 文件不被删**（并发注入）。
15. **CLI 不存在 bypass-active-lock 的 `--force`**（断言 CLI 无该 flag）。
16. 崩溃模拟（child process）：持锁后 exit → 残留 lock，恢复需显式 `--recover-stale-lock`。
17. 跨进程互斥集成（child process）：A 持锁 sleep → B acquire 失败 → A 释放 → B 成功。
18. Windows close→unlink 语义。

### 11.1b Operation-scoped Token 专用测试（BLOCKER 4 新增）

19. **同进程同 instanceId 并发**：Import 持锁（token X），并发 Restore **无 parent token** → Restore 必须被拒（即使同 pid / 同 instanceId / 同 manager）。
20. **nested rollback**：Import 持 token X → rollback 收到 token X → 不 reacquire → 无 self-deadlock。
21. **invalid / foreign token**：来自另一 manager / owner 的 token → 不得绕过 acquire。
22. **released token**：release 后的 token → 不得授权 nested mutation。
23. **同 EnvLockManager 两个并发 async**：只有一个进入 mutation（另一个 LOCKED）。
24. **`EPERM`/`EACCES` 且无既有 lock** → 报 `LOCK_IO_ERROR`/`PERMISSION_ERROR`，**不是** LOCKED。
25. **recovery 二次验证失败且 successor environment.lock 已存在** → successor 保留不动、quarantined recovering 文件不 rename 覆盖 successor。

### 11.2 引擎集成测试

26. **nested rollback 不 reacquire / self-deadlock**（导入失败自动回滚不死锁，token 传递）。
27. **Backup ↔ Import global exclusion**。
28. **Sync push ↔ Restore global exclusion**。
29. **Model Tools ↔ CLI global exclusion**。
30. 导入与恢复互斥；导入与 autosync 互斥；backup 与 import 互斥（lock 兜底两 RunRegistry 缺陷）。
31. CLI 持锁时 Web 路由 409；ModelTools `config_restore` 持锁/被锁。
32. **cache cleanup 不抢 Env Lock；exports 段按 mtime 跳过 recent**。

### 11.3 故障注入

- `open('wx')` 抛错 → 明确「无法获取环境锁」，不静默继续。
- heartbeat 写失败 → 记录 degraded（§6.4）。
- unlink 失败 → 尽力清理 + 留痕（复用 Phase 1 `onCleanupFailure` 语义）。
- OS process identity 探测失败 → 拒绝 recovery。

---

## 12. 未解决风险 / 开放决策（需评审）

| # | 风险 / 开放项 | 影响 | 建议 |
|---|---|---|---|
| R1 | NFS / 多机共享 `$DSH_HOME` | stale 误判 / 双持锁 | 明确不支持（Scope Exclusion）；hostname 仅诊断 |
| R2 | Windows `osProcessStartIdentity` 可靠性 | stale 判定受限 | heartbeat 为主 + OS identity 兜底；取不到 → UNKNOWN_STATE 保守拒 recovery |
| R3 | 长操作 vs heartbeat interval | 误判 / 锁被占久 | STALE_AFTER ≥ 10×interval；插件安装必须续期 |
| R4 | Backup / Sync push 纳入 GLOBAL 降低并发度 | 并发吞吐 | v1 直接纳入（评审定稿），有性能证据再放宽 |
| R5 | cache exports cleanup 跳过 recent window 是否够 | 备份清理延迟 | 默认策略②（mtime 跳过 24h）；后续可引入 EXPORTS_LOCK |
| R6 | lock 与 RunRegistry 双 409 UX | 两套「进行中」来源 | 前端统一文案 + lock 消息并入 |
| R7 | 共享 RunRegistry 修复是否本 Phase 做 | 现状缺陷 | 低风险 hygiene，建议顺手修；不与 Lock 耦合 |
| R8 | orphan tmp sweep 范围 | 清扫 vs 范围 | 不在 v1 强制；若做则在锁内 + 三证明 |
| R9 | recovery（rename 捕获）的剩余窗口 | 极端并发 | 已用原子 rename 捕获 + 二次验证最小化；非自动 |
| R10 | `--recover-stale-lock` 确认 UX | 误触发 | 需显式确认 + 只对 definite stale 生效 |

---

## 13. 完成标准（Phase 2 实现阶段对照）

- [ ] `src/utils/env-lock.ts`：`acquireExclusive`（open 'wx'）/ immutable ownership / sidecar heartbeat / release 校验 / stale 检测 / 显式 recovery。
- [ ] 接入 M1–M11, M13–M14 全部 destructive entry point（core 引擎统一注入）。
- [ ] **operation-scoped `MutationLockToken`**：公共 entry 无 token 即 acquire；nested 显式传 token reuse；禁止进程级 reentrant（§3.4）。
- [ ] **ownership 文件不被 atomicWriteFile 替换**；heartbeat 只更新 sidecar。
- [ ] stale 检测只分类（含 UNKNOWN_STATE 不执行）；recovery 独立显式、原子捕获、二次验证失败不覆盖 successor；无自动 takeover；无 `--force`。
- [ ] `EPERM`/`EACCES` 无既有 lock → `LOCK_IO_ERROR`/`PERMISSION_ERROR`，不当 LOCKED（§8.1）。
- [ ] release 前 instanceId 校验 + 当前 ownership 校验，mismatch 不 unlink；release 后 token 失效。
- [ ] CLI + Model Tools 全覆盖；Backup / Sync push 纳入 GLOBAL。
- [ ] Windows close→unlink、POSIX kill(pid,0) 有测试；BLOCKER 4 的 token 测试（§11.1b）全过。
- [ ] 全量测试 ≥ 基线（1150）+ Phase 2 新增；现有测试零回归。
- [ ] 产出实现报告 + PHASE2_HANDOFF，然后停止（不进入 Phase 3）。

---

## 14. 与 AGENTS.md / 现有代码约定的一致性

- **不破坏 Phase 1 不变量**：不修改 `atomic-write.ts` 所有权语义；新增独立的 `utils/env-lock.ts`。
- **不引入新依赖**：node:fs/promises + node:os + node:crypto 零第三方。
- **core 可测**：lock 经可选参数注入；EnvLock 的 io / 时钟 / 进程探测可注入（对齐 `AtomicIo` 模式）。
- **文档同步**：实现变更时同步 AGENTS.md。

---

*Phase 2 设计 Rev 3 完成（BLOCKER 1–4 全部 CLOSED）。暂停 Implementation，等待评审确认 GO。在 GO 前不修改 Phase 2 源码。*
