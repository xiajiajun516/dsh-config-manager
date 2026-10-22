# ADR-0006：恢复崩溃后自动续跑 —— 逐项证明成立才「接着做」

- 状态：已采纳（Accepted），2026-10-23
- 相关：ADR-0004（回退 = fork + 归档）、ADR-0005（SAFE MODE fail-closed）

## 背景

恢复是多动作破坏性操作（整文件还原 / 文件还原 / 删除 / 插件卸载）。自 F13 起每个动盘动作在**首个写之前**就预登记到
journal（`src/core/restore-wal.ts`），逐动作 settle 成 `done`/`attention` 并写 afterFp，删除类用
`ABSENT_FINGERPRINT` 哨兵表达「应不存在」。于是崩溃后 reconcile 能判出「哪些还原了、哪些没动」。

但在本 ADR 之前，这份进度**只用于报告**：残留 active journal 会让下一次恢复被 `runJournaled` 的 active≤1 门禁挡成
423 `transaction-recovery-required`，用户唯一出路是走恢复面板 reconcile —— 而「再点一次恢复」在语义上明明可以接着做。

## 决策

恢复的**第二次点击**可以接着上一次做，但必须**逐项证明**才允许，且证明不成立就退回 423（绝不「估计着继续」）：

1. **判定独立成一层**：`judgeRestoreResume`（`src/core/restore-resume.ts`）只读 journal 与磁盘。必须同时成立：
   journal 状态 ∈ {CREATED, SNAPSHOT_CREATED, APPLYING}、操作类型在允许集内、`rollback.entryDone` 为空、
   `journal.snapshotId` 等于本次重新规划出的快照 id、**计划与 journal 里 adapter='restore' 的 step 一一对应**、
   每个 step 状态 ∈ {planned, done, skipped}、无 `external`/无 beforeFp 的 step、
   **每个目标的当前盘面指纹只能是 beforeFp 或 afterFp 之一**。
   任一不成立即返回机器码（`terminal` / `wrong-operation` / `rollback-in-flight` / `no-snapshot` /
   `plan-unavailable` / `plan-drift` / `untrusted-step` / `external-unproven` / `step-attention` /
   `fingerprint-drift`），调用方零写入退回原路径。
2. **不跨入口续跑**：GUI `restore`、CLI `cli-restore`、model `model-restore` 各续各的。三个入口的执行器与参数来源不同
   （宿主 `executeRestorePlan` vs core `restore()` vs model-tools 的封装），跨续没有证据支撑。
3. **续跑不重建 WAL**：执行器收到 `resume` hint 时只**复原句柄 + 跳过**已证明完成的动作，**绝不重新 preRegister** ——
   重登记会把已完成动作的 beforeFp 覆盖成「执行后内容」，崩溃证据全部丢失。
4. **journal 收尾走新入口**：`Phase3Recovery.resumeJournaled`（`src/core/phase3-host.ts`）不 `create`、不做 active≤1 门禁，
   但接管 ownerInstanceId/lockId（否则下次崩溃时「锁里的实例」与「journal 的 owner」对不上），并复用与 `runJournaled`
   同一份 `runJournalTail`（终态推进、SAFE MODE、ROLLED_BACK/NEEDS_ATTENTION 分类）。
5. **SAFE MODE 有唯一放行口**：锁前探测只用于「能否放过 SAFE MODE 的 mutation gate」；真正写盘的决定在**持锁之后**再判一次。
   续跑成功后按与手动解除**同一个** `resolveSafeModeMarker` 判据解除（还有别的未解决 incident 时保持），
   绝不因为「这次续跑成功」就无条件清除。

## 取舍（被否掉的选项）

- **无条件接着做**（有 WAL 就续）：被否。目标文件可能已被用户改过（例如崩溃后手动改回一半），
  重做会把用户的新内容覆盖掉，且我们无法证明「盘面属于哪一侧」。
- **整笔重来**（丢弃 WAL，从头再跑）：被否。已完成的动作会被再写一遍，删除类动作还会误删用户在崩溃后新放回的文件。
- **自动续跑到后台/启动时静默进行**：被否。恢复是有感知的破坏性操作，必须由用户再点一次；本 ADR 只改「点了之后做什么」。
- **含插件卸载也续跑**：被否。`dsh plugin remove` 是外部副作用（可能只改 package.json 未 prune node_modules），无指纹可证，
  与 `docs/maintenance/known-limits.md` 的保守口径一致。

## 后果

- 崩溃后用户的操作从「先 reconcile、再重新恢复」变成「再点一次恢复」；不能证明时会看到具体原因码而不是泛化 423。
- `restore()` 与 `executeRestorePlan()` 多了一条 `resume` 输入分支；改恢复语义时**两条路径都要同步**（GUI 与 CLI 各有一套执行器）。
- 三入口的 operationType 常量与允许集是一份（`RESTORE_RESUME_OPERATION_TYPES` 之外的入口必须显式传入），新增恢复入口时要显式决定「续不续自己的」。
- SAFE MODE 的解除仍有唯一判据；本 ADR 不新增第二条解除路径。

## 证据

- 判定与执行：`src/core/restore-resume.ts`、`src/core/restore.ts`、`src/core/restore-wal.ts`、`src/core/phase3-host.ts`
- 三个入口接线：`src/routes/snapshots.ts`、`src/routes/route-support.ts`、`src/cli/restore-resume.ts`、`src/core/model-tools.ts`
- 用例：`src/core/restore-resume.test.ts`（T-01..T-08，含真 SIGKILL 后续跑）、`src/cli/restore-resume.test.ts`（C-01/C-02）、
  `tests/route/restore-route.test.ts`（G-04）、`src/core/restore-crash-injection.test.ts`（A-1/A-4）
