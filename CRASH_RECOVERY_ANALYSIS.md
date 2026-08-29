# CRASH_RECOVERY_ANALYSIS — Phase 3：Crash Journal + Startup Reconciliation（Analysis）

> 状态：**Analysis 完成**（尚未实现）。
> 前置：Phase 1 Atomic Write = PASS；Phase 2 Cross-process Lock = PASS。
> 本文件依据 **最终源码**（`src/**`）+ `PHASE2_HANDOFF.md` + `CROSS_PROCESS_LOCK_IMPLEMENTATION_REPORT.md`
> + `src/utils/env-lock.ts` + `src/utils/env-lock.test.ts` 逐项核对，凡与旧设计冲突一律以最终源码为准。
> 所有行号以本次 Analysis 的工作区（Phase 2 已提交 768a8f97 / 6a687e9，package 0.1.54）为准。
>
> **结论摘要**：当前所有 destructive mutation 都是「单文件原子 + 跨进程互斥」的叠层，但**没有任何一个 operation 具备跨步骤的 durable transaction 边界**。
> crash 恢复目前完全依赖「导入/切换前快照 / pre-restore 副本 / 重算计划」，**没有 journal、没有 step 级完成标记、没有恢复证据一致性探测器**。
> Phase 3 的职责不是重写 atomic/lock，而是补上「durable operation state machine + startup reconciliation」这缺失一层。

---

## 0. Phase 2 干净基线（本轮已建立）

| 项 | 值 |
|---|---|
| Phase 2 implementation commit | `768a8f97fac3f1aac6dfa64b729ebae86a771f2b`（8 个源码文件，2152 insertions） |
| Phase 2 docs commit | `6a687e9`（4 份 CROSS_PROCESS_LOCK_*/PHASE2_HANDOFF） |
| package version | `0.1.54` |
| working tree | 干净（仅剩 Phase 1 遗留 audit 产物未跟踪：`competitor-research/`、`COMPETITOR_SOURCE_AUDIT.md`、`ATOMIC_*.md`、`PHASE1_HANDOFF.md`，按不变量不混入） |
| typecheck | PASS（strict + verbatimModuleSyntax + noUncheckedIndexedAccess） |
| `npm test` | **1176/1176 PASS**，0 fail，0 skip（与 handoff 基线一致） |
| `npm run build` | PASS（tsc host + tsdown client bundle） |

---

## 1. Current Mutation Architecture（当前 mutation 架构）

三层独立性已确立（见 `CROSS_PROCESS_LOCK_DESIGN.md:22`）：

```
Atomic file write（Phase 1）→ Cross-process lock（Phase 2）→ Transaction recovery（Phase 3，本阶段设计）
```

**关键事实**：三个原始语独立，但当前**并没有**「整个 operation 是 transaction」这一层。

### 1.1 各 destructive 入口的形态

| 入口 | 引擎 | 锁 | 快照 | journal | 说明 |
|---|---|---|---|---|---|
| M1 Import apply | `Analyzer.executeImportPlan`（`src/core/analyzer.ts:396`） | `withMutationGate('import-apply')`（index.ts:2122） | ✅ 强制 `createSnapshot`（analyzer.ts:443） | ❌ 无 | 逐计划项 applyOne（analyzer.ts:481），每项独立原子写/插件外部进程 |
| M2 Restore | `restore()`（`src/core/restore.ts:484`） | `runWithMutationLock`（index.ts:2283 + CLI:595） | ✅ pre-restore 副本（restore.ts:201） | ❌ 无 | 逐 action；整文件还原 + 插件卸载 + file 补偿 |
| M3 Rollback | `rollback()`（`src/core/rollback.ts:116`） | 继承父 lock（nested） | 基于 snapshot | ❌ 无 | 逆序补偿，尽力而为 |
| M4 Profile switch | `ProfileManager.executeSwitch`（profile-manager.ts:325） | `withMutationGate('profile-switch')` | ✅ 强制 createSnapshot（profile-manager.ts:363） | ❌ 无 | 逐 adapter applyOne，rollbackOnError |
| M5 Profile delete/rename/import | profile-manager.ts | gate | ❌（delete/rename 无快照） | ❌ 无 | delete/rename 是 fs.rm recursive / 两阶段 |
| M6 Sync apply | `SyncEngine.applyMergePlan`（sync-engine.ts:729）→ executeImportPlan | `withMutationGate('sync-apply')` | ✅ createSnapshot 兜底（sync-engine.ts:771） | ❌ 无 | 复用 importer 执行引擎 |
| M7 AutoSync | `AutoSyncScheduler.runOnce`（autosync-scheduler.ts:242） | `withMutationLock`（跨进程持锁，runOnce 全程） | ✅ apply 前 createSnapshot | ❌ 无 | Phase A merge → B apply → C push |
| M8 Manual Sync push | `SyncEngine.push`（sync-engine.ts:341） | `withMutationGate('sync-push')` | ❌（本地散文件副本非回滚快照） | ❌ 无 | 本地副本 → 远端 upload → recordBaseline |
| M9 Snapshot delete | `deleteSnapshot`（restore.ts:665） | gate | — | ❌ 无 | fs.rm recursive |
| M10 Snapshot prune | `FileSnapshotStore.prune`（backup.ts:315） | 继承父 lock | — | ❌ 无 | fs.rm recursive 删最旧 |
| M11 Backup | `BackupScheduler.runOnce`（backup-scheduler.ts:181） | `runWithMutationLock` | — | ❌ 无 | Exporter→atomicWrite ZIP→writeConfig→prune |
| M13 CLI restore | `restore()` | `runWithMutationLock`（cli/index.ts:595） | — | ❌ 无 | 同上 M2 |
| M13 CLI reinstall | `buildReinstallPlan` + 逐 shell 命令 | `runWithMutationLock`（cli/index.ts:463） | `.reinstall-backup`（reinstall.ts:262） | ❌ 无 | 外部 shell 命令队列，单步失败继续 |
| M13 CLI recover-stale-lock | `recoverStaleLock` | 独立（不持锁，操作锁本身） | — | — | 只影响 lock 文件 |
| M14 ModelTools config_restore/sync_push | `model-tools.ts` | `runWithMutationLock` | — | ❌ 无 | 委托 restore / engine.push |

### 1.2 核心缺失：没有「operation state machine」

每个 operation 在源码里都只是一次函数调用：`await executeImportPlan(...)` / `await restore(...)` / `await engine.push(...)`。
- **没有** durable operationId 贯穿整个 mutation。
- **没有** step 级 planned/completed 记录。
- **没有** commit 点（除极少数例外，见 §8 现有恢复信号——且都不是真正 journal commit）。
- crash 后唯一可用的恢复证据是 **副作用本身在磁盘上的残留**（snapshot 目录、pre-restore 副本、半装 node_modules、远端滞留 commit/孤儿文件）。

这正是 Phase 3 要补的层。

---

## 2. Crash Surface Inventory（Crash 面清单）

> 本清单是对最终源码的重新扫描，非机械复制 Phase 2 inventory。逐项标注「是否经 GLOBAL 锁」「是否创建回滚快照」「是否有 journal」「crash 判定难度」。

### 2.1 本地文件类 mutation（原子写 / 原子删）

| ID | 操作 | 位置 | 锁 | 快照 | journal | crash 判定 |
|---|---|---|---|---|---|---|
| L1 | 导入逐计划项写文件（settings/ui/providers/skills/agentPresets/...）| analyzer.ts:481 → adapter.applyItem | ✅ | ✅ 导入前快照 | ❌ | 每文件原子；但「哪些 item 已做」不可知 |
| L2 | 快照 blobs + snapshot.json 落盘 | backup.ts:298-310 | 继承 | — | ❌ | blobs 写一半 → 无 snapshot.json → listSnapshots 跳过 |
| L3 | snapshot prune 删最旧 | backup.ts:333 | 继承 | — | ❌ | fs.rm recursive 非原子 |
| L4 | deleteSnapshot | restore.ts:678 | ✅ gate | — | ❌ | fs.rm recursive 非原子 |
| L5 | setSnapshotPinned | restore.ts:684 | ✅ gate | — | ❌ | 原子写 snapshot.json |
| L6 | profile saveCurrent / 写 profile.json | profile-manager.ts:221 | 仅 loopback | — | ❌ | 原子写 |
| L7 | profile rename | profile-manager.ts:274-285 | ✅ | — | ❌ | 两阶段：mkdir+写新 → rm 旧，crash 出重复 |
| L8 | profile delete | profile-manager.ts:288-292 | ✅ | — | ❌ | fs.rm recursive |
| L9 | backup ZIP 写入 | zip.ts:157（atomicWriteFile） | ✅ | — | ❌ | 原子；tmp 孤儿 |
| L10 | backup-schedule.json + writeConfig | backup-schedule-config.ts:203 | ✅ | — | ❌ | 原子 |
| L11 | backup pruneAutoBackups | backup-files.ts:191 | ✅ | — | ❌ | fs.rm force |
| L12 | restore: pre-restore 副本 + 写回 / 删除 | restore.ts:510-543 | ✅ | ✅ | ❌ | 每 action 原子 + pre-restore |
| L13 | rollback 逆序补偿 | rollback.ts:116 | 继承 | 基于 snapshot | ❌ | 尽力而为 |

### 2.2 外部进程 / 远端类 mutation（非本地原子）

| ID | 操作 | 位置 | 锁 | 可查状态 | journal | crash 判定 |
|---|---|---|---|---|---|---|
| E1 | 插件安装 `dsh plugin add` | plugin-cli.ts:357 / index.ts:561 | ✅（import gate） | `readInstalled` vs `readInstalledVersion`（清单有依赖 vs node_modules 有包）→ **可探测半装态** | ❌ | 半装态可探测但需手动/脚本恢复 |
| E2 | 插件卸载 `dsh plugin remove` | restore.ts:208 / index.ts:1349 | ✅ | 无可靠查询 | ❌ | 半删残留，计划级幂等 |
| E3 | reinstall 各 shell 命令 | cli/index.ts:356 + reinstall.ts | ✅ | 无（DSH 是否可用可探测） | ❌ | 任意两步之间 crash |
| E4 | Sync push 远端上传（Git commit+push） | sync-engine.ts:406 + git-transport.ts:211-256 | ✅ | git push exit 0 / 工作副本 | ❌ | commit 后 push 前 crash → 滞留本地未推 commit |
| E5 | Sync push 远端上传（WebDAV PUT） | webdav-transport.ts:161-191 | ✅ | PUT 2xx / index.json | ❌ | 快照 PUT 与 index PUT 之间 crash → 远端孤儿；PUT 半写 → 截断文件 |
| E6 | autosync 两段（apply + push） | autosync-scheduler.ts:242-510 | ✅（跨进程持锁） | 无 | ❌ | Phase B 与 C 之间 crash → 本地基线指向从未 push 的合成 id → 远端静默滞后 |
| E7 | profile switch 的插件安装 | profile-manager.ts applyOne → plugins | ✅ | 同 E1 | ❌ | 同 E1 |

### 2.3 新增/遗漏项（Phase 2 后重扫发现）

- **pnpm-workspace.yaml 非原子写**（plugins-adapter.ts:201，`ctx.target.fs.writeFile` 普通写）——Phase 1 未覆盖此文件，crash 可留半文件。**新发现缺口**。
- **profile delete/rename 无回滚快照**（仅 gate 持锁，不建快照）——删除类操作不可从快照回滚，属 NEEDS_ATTENTION 范畴。**值得强调**。
- **autosync Phase B/C 之间的静默分叉** 是 Phase 2 报告未点名的最高风险窗口之一。**本轮新增识别**。
- **WebDAV 孤儿文件泄漏**（快照 PUT 成功、index PUT 未达）与 **Git 滞留本地 commit**：远端侧没有 journal 可回放，只能 NEEDS_ATTENTION。

---

## 3. Crash Window Matrix（Crash 窗口矩阵）

> 每个 mutation 的 crash 边界。列含义：disk durable（crash 时已落盘）、判定（能否判断完成）、幂等（重放是否安全）、恢复路径。

### 3.1 M1 Import apply（executeImportPlan）

```
acquire lock → createSnapshot → [applyOne × N] → postValidate → markSnapshotStatus(done) → release
```

| crash 位置 | disk 已 durable | journal 状态 | snapshot | 插件已装? | rollback 安全 | 幂等 | resume 安全 | 结论 |
|---|---|---|---|---|---|---|---|---|
| createSnapshot 中 | 部分 blobs / snapshot.json | 无 | 半写 | 未装 | — | 部分 | — | listSnapshots 跳过孤儿；重跑 import |
| createSnapshot 后、首个 applyOne 前 | 快照完整 | 无 | ✅ | 未装 | ✅ 可回滚到导入前 | ✅ | — | 重跑 import（快照会被保留上限覆盖） |
| 第 k 个 applyOne 中（写文件） | 部分 item 写 | 无 | ✅ | 部分 | ✅（快照逆序补偿） | 逐文件 yes/整体 no | ✗（不知哪些完成） | **需 rollback 或人工判断**；无 step 记录 |
| 第 k 个 applyOne 中（插件安装 spawn） | 可能半装态 | 无 | ✅ | 半装 | ⚠️ 插件非事务 | ✗ | ✗ | **NEEDS_ATTENTION**（半装态，启动风险） |
| postValidate 中 | 全部 item 已 apply | 无 | ✅ | 全装 | ✅ | — | — | markSnapshotStatus 未写 → 快照仍 pending，但导入实际完成 |
| markSnapshotStatus 前 | 全部 item done | 无 | ✅ | 全装 | ✅ | — | ✅ | crash → 快照 pending；重跑会重复（非幂等）→ **需确认** |
| release 前 | 全部 done + 状态 done | 无 | ✅ done | 全装 | ✅ | — | ✅ | 锁未释放 → 下次启动 stale | 

### 3.2 M2 Restore（restore()）

```
acquire → [per action: copyToPreRestore → atomicWrite/rm / pluginRemove] → sweepSessions → release
```

| crash 位置 | disk durable | 判定 | 幂等 | 恢复路径 |
|---|---|---|---|---|
| 某 action 的 copyToPreRestore 后、写回前 | 目标旧完整；pre-restore 副本落盘 | 可 | ✅ | 重跑 restore（重算计划） |
| 某 action 的 atomicWriteFile 中 | 目标旧或新完整 | 可 | ✅ | 重跑 restore |
| 某 action 的 fs.rm 中（hostFileRemove/fileRemove） | 文件已删；pre-restore 在 | 可 | ✅ | 从 pre-restore 人工恢复或重跑 |
| pluginRemove 的 dsh 子进程（killTree/超时/宿主死） | 插件可能半删 | 难 | 计划级 ✅ | 重跑 restore（重算计划） |
| 中途（任意 action 间） | 部分 action 已做，部分未 | 部分 | 计划级 ✅ | 重跑 restore 收敛；pre-restore 可反悔 |

> **restore 是当前 crash-robust 度最高的 mutation**：因「plan 每次由当前状态重算」+「每 action pre-restore」。但仍无 journal 记录已完成 action，重跑会重复执行已完成的幂等写（副作用是额外的 pre-restore 副本累积）。

### 3.3 M6/M7 Sync apply 与 M8 push

**apply**（= executeImportPlan 流程）：同 M1 矩阵（createSnapshot → 逐 target 写 → rollbackOnError / recordBaseline）。crash 中间 → 部分本地配置已改、有兜底快照可 rollback；**无自动续跑**。

**push**（sync-engine.ts:341）：
| crash 位置 | 本地 durable | 远端 durable | 判定 | 幂等 | 结论 |
|---|---|---|---|---|---|
| 本地副本写后、upload 前 | 快照目录 | 未变 | 否 | 下次 push 新 id | 自愈 |
| upload 后、recordBaseline 前 | sync-state 旧 | 快照已上传 | 否 | 新 id 会重传，旧滞留 | **NEEDS_ATTENTION**（远端累积，≤10 被裁剪） |
| git commit 后、push 前 | 本地 commit 未推 | 未变 | 否 | 下次 push diff --cached 为空 → 跳过 | **NEEDS_ATTENTION**（滞留 commit 阻塞） |
| webdav PUT 快照后、index 前 | sync-state 旧 | 孤儿 <id>.json | 否 | 同 id 重传可覆盖 | **NEEDS_ATTENTION**（孤儿泄漏） |
| webdav PUT 半写 | 未变 | 截断文件 | 否 | 同 id 重传修复 | **NEEDS_ATTENTION** |

**autosync runOnce**（Phase A merge → B apply → C push）：
| crash 位置 | 判定 | 结论 |
|---|---|---|
| Phase B apply 后、Phase C push 前 | 本地基线已置为合成 id | **NEEDS_ATTENTION**（本地与远端静默分叉，远端永久滞后） |

### 3.4 M13 reinstall（shell 命令队列）

```
acquire → [npm uninstall -g] → [rm global dir] → [npm install -g] → [verify] [备份 .reinstall-backup] → release
```
| crash 位置 | 判定 | 结论 |
|---|---|---|
| 任意两步之间 | 无中间状态可查 | **NEEDS_ATTENTION**（DSH 可能缺失；.reinstall-backup 兜底） |

### 3.5 M5 profile rename/delete

| crash 位置 | 判定 | 结论 |
|---|---|---|
| rename 写新成功后、rm 旧前 | 新旧并存 | **NEEDS_ATTENTION**（重复，手动清理） |
| delete fs.rm 中 / rename rm 旧中 | 目录部分删 | **NEEDS_ATTENTION**（无回滚点） |

---

## 4. Idempotency Matrix（幂等矩阵）

> 分类依据=实际源码实现，非函数名猜测。

| 操作 | 分类 | 依据 |
|---|---|---|
| `atomicWriteFile` / `atomicCopyFile` / 同步版 | **IDEMPOTENT**（幂等写） | tmp→写→fsync→rename（atomic-write.ts:259,306,344）；重放得到 same target content |
| `fs.rm(p,{force,recursive})` + 存在守卫 | **IDEMPOTENT**（幂等删） | force/不存在视为成功（restore.ts:520,537；deleteSnapshot:673；prune:333） |
| snapshot blobs + snapshot.json | **IDEMPOTENT**（save 重放收敛） | atomicWrite 整文件；blobs 半写被 listSnapshots 跳过判为孤儿 |
| snapshot prune / deleteSnapshot / pruneAutoBackups | **IDEMPOTENT** | 每次重算候选（selectPruneCandidates / 重扫目录） |
| restore 整文件/删类 action | **计划级 IDEMPOTENT** | planRestore 每次从当前状态重算 + 写类原子 + 删类守卫 |
| rollback（值恢复） | **CONDITIONALLY IDEMPOTENT** | settings 走 expectedRevision 乐观锁（rollback.ts:48）；file 写回收敛；**凭据 existed=true 无法自动恢复值** → failed+manualHint（rollback.ts:55） |
| `dsh plugin add`（安装） | **CONDITIONALLY IDEMPOTENT** | 重跑通常收敛，但中途 crash 留半装态；fetch-404 幽灵依赖会卡死后续所有安装（plugin-cli.ts:492） |
| `dsh plugin remove`（卸载） | **CONDITIONALLY IDEMPOTENT** | 重跑收敛；对已卸载报失败；crash 半删残留 |
| `ensureActivationRow` | **IDEMPOTENT** | 已存在同 name 行则跳过（index.ts:516） |
| `cleanupAbortedInstall` | **IDEMPOTENT** | 删不存在依赖行是 no-op；rmSync force 对缺失 no-op（plugin-cli.ts:184-201） |
| `writeProfileManifest` | **IDEMPOTENT** | atomicWriteFileSync（plugin-cli.ts:96） |
| **pnpm-workspace.yaml 写入**（adapter） | **NON_IDEMPOTENT（非原子）** | plugins-adapter.ts:201 普通 writeFile，crash 留半文件 |
| sync push 远端上传 | **CONDITIONALLY IDEMPOTENT** | git 同 id upload 内容不变不 commit（幂等）；但每次 push 生成新 id → 重放留远端孤儿，靠 MAX=10 裁剪；webdav 同 id equal 跳过 PUT |
| Git commit / push | **IDEMPOTENT**（单次 push 幂等） | 退出码判定；`diff --cached` 空则跳过（git-transport.ts:252-254） |
| WebDAV 快照+index 两段 upload | **CONDITIONALLY IDEMPOTENT** | 同 id overwrite；两段之间 crash 留孤儿（webdav-transport.ts:177-190） |
| autosync apply 后基线 | **NON_IDEMPOTENT**（状态分叉） | 本地基线指向从未 push 的合成 id → 远端永久滞后 |
| reinstall shell 命令 | **NON_IDEMPOTENT** | `npm uninstall -g` 后 crash → DSH 缺失；`rm -rf` 后 crash → 数据已删（reinstall.ts:215-292） |
| `dsh plugin add` 半装态探测 | **CONDITIONALLY** | `readInstalled`（package.json 依赖）vs `readInstalledVersion`（node_modules 包）对比 = 可探测半装态（plugin-cli.ts:100-119） |

### 4.1 幂等结论汇总

- **本地单文件写/删全部可安全重放**（IDEMPOTENT）。
- **多文件 operation 无整体幂等**——重放会部分重复 / 产生孤儿 / 状态分叉。
- **插件与远端是最大不确定性源**：无法证明可安全重放，也无法证明已正确完成。
- `UNKNOWN` 项：Git 滞留 commit 被跳过后的实际远端状态、WebDAV 截断文件、reinstall 半程——**都无法从代码证明当前状态**，必须 NEEDS_ATTENTION。

---

## 5. Existing Snapshot / Rollback Capabilities（现有快照/回滚能力）

### 5.1 快照体系（backup.ts / restore.ts）

- `createSnapshot`（backup.ts:200）：只保存本次将被修改的目标原值（`collectTargets`，含 EXECUTABLE_KINDS）。adapter.snapshot 优先，engineSnapshotEntry 兜底，加 hostFileBackups（settings.yaml/cordis.patch.yml/profile patch + pnpm-workspace.yaml）。
- `FileSnapshotStore.save`（backup.ts:298）：blobs 逐 atomicWrite → snapshot.json atomicWrite → prune。
- `FileSnapshotStore.load` / `readBlob` / `updateStatus`（status: pending→done/rolled-back）。
- 保留上限 `SNAPSHOT_RETENTION_LIMIT=10`，置顶豁免。
- **快照状态机已存在**：pending → done / rolled-back（`SnapshotStatus`）。这是现成的「pre-state 记录」，Phase 3 可扩展/引用。

### 5.2 回滚两条路径

1. **rollback.ts（在线补偿）**：逆序补偿 snapshot entries。settings 走 DSH storages + expectedRevision；credential 不回读值→只能 `unset` 或 manualHint；file 写回/删除。
2. **restore.ts（离线整文件还原）**：整文件 blob 写回 + pre-restore 双保险 + 插件基线对比卸载 + file 补偿。**用户主动**恢复到导入前。

### 5.3 对 Phase 3 的意义

- **pre-operation snapshot 可作为 crash recovery primitive 直接复用**（任务 §10 允许，且 Phase 3 不扩展成 Phase 4 的预升级快照）。
- 关键缺口：**createSnapshot 本身不是「已成功建立回滚点」的 durable 信号**——它没有写入任何 journal 宣告「本次 operation 的回滚点是 <snapshotId>」。crash 后无法区分「快照存在但我还没开始 apply」vs「apply 到一半」。

---

## 6. External Side-Effect Classification（外部副作用分类）

| 外部副作用 | 有 transaction id? | 可查询最终状态? | 可重复执行? | 可 rollback? | crash 后判断 | 是否只能 NEEDS_ATTENTION |
|---|---|---|---|---|---|---|
| 插件 install（dsh plugin add → pnpm） | ❌ | ⚠️ 半装态可探测（清单 vs node_modules） | ⚠️ 重跑收敛但可能留痕 | ⚠️ 半装可 cleanup；已装难撤销 | 半装态可探测 | **部分**（半装态需要处理；已完成且一致则可不介入） |
| 插件 uninstall | ❌ | ❌ 无可靠 | ⚠️ 重跑收敛 | ❌ | 半删残留 | **是** |
| reinstall shell（npm -g / rm -rf / cp） | ❌ | ❌ | ❌ | 部分（.reinstall-backup） | 无 | **是** |
| Git commit/push | ❌ | ✅ work copy + push 退出码 | ✅ 单次幂等 | ❌ | commit 后 push 前 crash → 滞留 | 部分（可探测本地 work copy ahead） |
| WebDAV PUT（快照 + index） | ❌ | ⚠️ index 可见性 | ⚠️ 同 id 幂等 | ❌ | 孤儿文件 / 截断 | **是**（孤儿/截断需人工/重推） |
| autosync push | ❌ | ❌ | ❌ | ❌ | 状态分叉 | **是** |

> **Phase 3 不得假装远程/外部操作是本地 ACID**。对无法证明的外部副作用，策略是**保守记录 intent + 事后一致性探测 + 无法证明则 NEEDS_ATTENTION**，而非尝试自动回滚外部操作。

---

## 7. Startup Entry Points（启动入口）

| 入口 | 位置 | 对 reconciliation 的意义 |
|---|---|---|
| DSH Host 插件初始化 `apply()` | index.ts:3912 | **主入口**。构造 `ConfigManagerHostContext` → `EnvironmentLockManager`（index.ts:3934）→ AutoSync `scheduler.start()`（1583）→ Backup `backupScheduler.start()`（4038）。reconciliation 需挂在 lock 构造之后、任何 mutation 之前 |
| CLI 入口 `runCli` | cli/index.ts:503 | 离线路径。reconcile 需在 restore/reinstall 前（若 CLI 也要处理 journal） |
| ModelTools | model-tools.ts | 经 host.mutationLock，由宿主启动即已初始化 |

**约束（§11 关键）**：
- reconciliation 若会写环境 → 必须 `acquire GLOBAL lock`。
- 若 lock 被活进程占用 → 禁止 reconciliation（等待或用保守只读）。
- 若发现 stale environment.lock → 遵守 Phase 2 显式 recovery 语义，**不得偷偷自动 takeover**。
- `EnvironmentLockManager.recoverStaleLock()` 已存在（env-lock.ts:806），可作为 reconciliation 前置步骤的一部分（仅 definitely-stale）。

---

## 8. Existing Recovery Signals（现有恢复信号）

> 当前源码中已有的、可被 Phase 3 用作恢复证据的信号：

| 信号 | 位置 | 语义 |
|---|---|---|
| snapshot.json 的 `status`（pending/done/rolled-back） | backup.ts:350 / analyzer.ts:582 | 现有最接近「operation 完成标记」的信号，但只标记导入/restore，非通用 journal |
| `LockOwnershipRecord.journalId`（预留 null） | env-lock.ts:120 | Phase 2 显式为 Phase 3 预留的 journal 挂载点 |
| `MutationContext` 预留 `operationId/journalId/snapshotId` | CROSS_PROCESS_LOCK_DESIGN.md:196 | 显式 context propagation 的扩展接缝 |
| RunRegistry（单进程并发防重 + /runs） | run-registry.ts / index.ts | 记录 running run，但**非 durable journal**（只在内存/宿主进程） |
| pre-restore 副本目录 | restore.ts:201 | 覆盖/删除前的双保险 |
| 插件半装态可探测 | plugin-cli.ts readInstalled vs readInstalledVersion | 安装一致性探测器（现仅用于诊断，未接入恢复决策） |
| Heartbeat sidecar（lock 存活） | env-lock.ts:668-683 | stale 判定用，不是 operation 进度 |

---

## 9. Phase 1 / Phase 2 Reusable Primitives（可复用原语）

Phase 3 必须建立在以下已有原语之上，**不得重写**：

### Phase 1 — Atomic Write（atomic-write.ts）
- `atomicWriteFile` / `atomicCopyFile` / `atomicWriteFileSync`：tmp→写→fsync→rename（POSIX 父目录 fsync 强 durability，Windows 跳过）。
- **错误语义（§17 关键）**：`atomicWriteFile` 抛错时 target **未被 rename**（保持旧完整）；fsyncDir 失败被吞（best-effort）。→ **throw = disk 未变（crash-consistency 保证）**，但 **Windows 下 rename 后不 fsync 父目录 → 可能 power-loss 丢失 rename**（crash-consistency 强于 power-loss）。
- 有 `AtomicIo` 可注入门面（故障注入测试范式，env-lock.test.ts 复用同一模式）。

### Phase 2 — Environment Lock（env-lock.ts）
- `EnvironmentLockManager`：acquire（open 'wx'）/ heartbeat / validate / release（ownership 校验）/ inspectLockState / recoverStaleLock。
- `MutationLockPort`（acquire/validate/release）：core/CLI/ModelTools 依赖的最小契约。
- `withMutationLock` / `runWithMutationLock`：nested reuse，无自死锁。
- **journal 必须与 lock 的关系**（§16）：acquire → create journal；release 必须在 journal 进入 durable terminal state 之后。
- `journalId` 预留字段：journal 创建后应回填到 ownership record（Phase 2 已预留）。

---

## 10. Unknown / Unprovable States（未知/不可证明状态）

> 这些状态下系统**无法从代码证明磁盘/远端状态**，Phase 3 必须保守处理（§12 SAFE MODE）：

1. **插件安装/卸载中途 crash 的 node_modules 与 package.json 一致性** —— 半装态可探测，但「pnpm 当前是否还有残留子进程在跑」不可知（detached）。
2. **reinstall 半程** —— DSH program 是否缺失、数据是否被 rm 掉，无法从 journal 证明（无 journal）。
3. **Git commit 后 push 前 crash 的远端实际状态** —— 本地 work copy ahead 可探测，但远端 commit 是否最终到达不可知。
4. **WebDAV 截断文件 / 孤儿文件** —— download/parse 会失败，但「是半写还是全写」不可知。
5. **autosync 状态分叉** —— 本地基线指向从未 push 的 id，远端真实状态不可知。
6. **rollback 部分失败** —— credential 值永不可读回；`full`/`partial` 只反映当次补偿结果。
7. **recover 二次验证失败后 quarantine** —— 锁已捕获但未删，环境锁仍占位。
8. **journal 文件本身损坏**（将来）—— 无法解析则不能猜，需 NEEDS_ATTENTION。

---

## 11. Security Considerations（安全考量）

基于现有安全不变量（AGENTS.md 安全章 + 源码）：
- **journal 不得包含**：API keys、decrypted credentials、密码、secret 值。只能存 paths/逻辑 section 名、hashes、ids、operation 元数据。
- journal 是**可信本地文件**，但必须防御：**symlink 攻击**（journal 目录被替换）、**路径穿越**（journal 内伪造相对路径引到别处）、**journal 篡改**（恶意/冲突进程改写 journal 诱使错误恢复）、**权限**（journal 应为 0600）、**未信任元数据**（不把 journal 内容当绝对权威执行，只作恢复提示）。
- Phase 3 设计须复用现有 `redact()`、路径越界校验（如 restore.ts:158-175 的 isWithinHome/blobAbs）、`sanitizeTmpBase`、ZIP 安全校验等。
- lock ownership 校验（env-lock.ts validate）确保只有所有权人才可信地写 journal。

---

## 12. Windows / POSIX Considerations（平台考量）

### 现有已确立事实
- **Windows**：`open('wx')` 独占创建、close→unlink、EBUSY 有界重试均已实跑（env-lock.test.ts）。**Windows 目录 fsync 不可用** → 原子写只保证 crash-consistency，**不保证 power-loss rename durability**（atomic-write.ts:27,297）。
- **POSIX**：父目录 fsync 提供 strong power-loss durability（atomic-write.ts:296-299）。
- Windows `osProcessStartIdentity` 默认不可得 → stale+alive+PID 存活时保守 UNKNOWN_STATE（env-lock.ts:785-790）。

### Phase 3 必须明确
> **crash consistency stronger than power-loss durability**。不把 journal 宣传为绝对 power-loss-safe transaction。
- Journal 自身更新复用 atomicWriteFile：POSIX 得 strong durability，Windows 得 crash-consistency。
- 若 Windows 需要更强 power-loss 保证，需额外机制（如目录替换 + 显式 flush 策略），属于可选增强，**默认不承诺**。
- 外部进程（detached）行为在 Windows 与 POSIX 不同（无 job object → 子进程存活行为差异），recovery 探测须平台无关。

---

## 13. Candidate Journal Architecture（候选 journal 架构）

> 详细设计见 `CRASH_JOURNAL_DESIGN.md`。此处仅列 Analysis 得出的候选方向与约束。

### 13.1 存储布局候选
```
<dataDir>/transactions/                    # 或 journal/
  active/<operationId>.json                # 进行中 operation 的可变 journal（atomicWriteFile 原子更新）
  completed/<operationId>.json             # 已达 commit 的 operation（只读存档 / retention）
  recovery-history/<operationId>.json      # 恢复事件记录（reconcile 结果，供审计）
locks/environment.lock, environment.heartbeat.*   # Phase 2 已存在
snapshots/<snapshotId>/                    # 现有快照体系（复用）
```

### 13.2 状态机候选
```
CREATED → SNAPSHOT_CREATED → APPLYING → VALIDATING → COMMITTED → (release)
                                       ↘ ROLLING_BACK → ROLLED_BACK
crash 后: INCOMPLETE → (启动) → RECONCILING → RECOVERED / ROLLED_BACK / NEEDS_ATTENTION
```
- **状态写发生在 side effect 前**（WAL intent-before-effect）才可证明 step 是否已执行。
- 具体状态名与字段由 Design 依据真实 step 粒度确定。

### 13.3 必须回答的问题（已明确方向）
- journal 记录 planned steps + completed steps（WAL），不是仅 append-only log。
- 记录 checksum/fingerprint（文件 hash），用于「crash 后判断某 step 是否已应用」。
- 记录 pre-state（snapshotId）+ operationId + lock journalId + owner + packageVersion + environmentFingerprint。
- intent-before-effect：`STEP_X_INTENT` durable → side effect → `STEP_X_DONE` durable。
- **对外部/插件/远端口径**：记录 intent，做一致性探测，无法证明 → NEEDS_ATTENTION（不自动回滚外部）。

---

## 14. Open Questions（开放问题）

> 需在 Design 中决策或标注：

1. **journal 覆盖范围**：是覆盖所有 M1–M14（全量），还是只覆盖「多文件本地 mutation + 可 rollback 的」（import/restore/profile-switch/sync-apply），把 reinstall/远端/插件标记为 NEEDS_ATTENTION-only？——倾向：**分层**，本地可回滚走全 journal，外部只记录 intent。
2. **reconciliation 触发**：仅 host 启动？还是 CLI 也触发？若 lock 被活进程占，怎么排队？——倾向：host apply() 在持有 lock 后触发；CLI 仅当持有 lock 时才 reconcile。
3. **SAFE MODE / mutation blocking**：发现 NEEDS_ATTENTION 时如何阻断？阻断到用户显式确认？
4. **journal 与 snapshot 的关系**：journal 引用 snapshotId，还是 journal 内嵌 pre-state？——倾向引用（快照已存在）。
5. **幂等 step identity**：step id 怎么稳定（防止重排变更后误判）？用 planned/完成 两组集合对比。
6. **retention**：completed journal 保留多久？recovery-history 保留多久？
7. **Power-loss 承诺**：默认只承诺 crash-consistency；是否需要可选强 durability？
8. **`atomicWriteFile` 对 journal 的适用性**：journal 更新频繁，atomicWrite 每次整文件重写，性能可接受？（journal 极小，可接受。）

---

## 15. Recommended Phase 3 Scope（建议范围）

### 纳入（In scope）
1. **Durable operation journal**：为「可证明恢复」的本地多文件 mutation 建立 journal 状态机（import/restore/profile-switch/sync-apply 及复用的引擎路径）。
2. **Startup reconciliation**：host apply() 持锁后扫描不完整 journal，根据证据（snapshot、step 完成标记、文件 hash）决定 RECOVERED / ROLLED_BACK / NEEDS_ATTENTION。
3. **SAFE MODE / mutation blocking**：NEEDS_ATTENTION 时阻止后续 destructive mutation（只读允许）。
4. **外部副作用 policy**：插件 / 远端 / reinstall 记录 intent + 一致性探测，无法证明 → NEEDS_ATTENTION。
5. **failure injection**：真实 child-process 模拟 process death（复用 env-lock.test.ts 范式）。
6. 修复已识别的非原子缺口（**pnpm-workspace.yaml 普通 writeFile**）——但仅以 journal 化 / 原子化修复，属 Phase 3 scope 边缘（明确标注为 Design 决策）。

### 排除（Out of scope，§26 禁止项 + Phase 4 边界）
- **不**重新实现 atomic 或 lock。
- **不**实现 Phase 4（pre-upgrade 自动快照 / 版本迁移产品功能）。
- **不**做 orphan `.dshcm.*.tmp` sweep（Phase 1 follow-up，PHASE2_HANDOFF §6 已列，非 Phase 3 强制）。
- **不**做增量备份 / 会话迁移 / 无关重构。

### 目标架构（Design 细化后将收敛到）
```
Acquire Environment Lock
  → Create Durable Journal (operationId)
  → Create/Reference Pre-operation Snapshot
  → Apply Atomic Operations (per-step: INTENT → side-effect → DONE)
  → Validate
  → Commit Journal
  → Release Environment Lock

crash 后:
  Startup → Acquire Lock → Discover incomplete journal
  → Inspect durable evidence → Reconcile (Recovered / RolledBack / NeedsAttention)
  → Mark → Release Lock
```

> 依据 §27：本 Analysis 完成。下一步产出 `CRASH_JOURNAL_DESIGN.md` → 独立 Design Review → Implementation Gate。
