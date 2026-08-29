# PHASE3_HANDOFF — Crash Journal + Startup Reconciliation（跨对话交接文档）

```
PHASE 3 STATUS: PASS（P0-A CLOSED）
```

- **Phase 3 名称**：Crash Journal + Startup Reconciliation
- **设计基线**：`CRASH_JOURNAL_DESIGN.md` Rev 3 + `CRASH_JOURNAL_DESIGN_REVIEW.md` Rev 3（DESIGN/REVIEW CONSISTENCY PASS）
- **Phase 3 implementation baseline commit**：`f22effb6ad452938b37541e440450575f59f86e1`（25 文件，4330 insertions）
- **Phase 3 final consistency audit / P1 fix commit**：`72d7e70fb5cd343781ee24fbf0e368632a3d19a4`（isLiveOwner LOCKED-live `||` 修复 + 文档一致化：§9 findings history、测试数 1228、P0-A closed）
- **Phase 2 基线（前置）**：`6a687e9`（docs）/ `768a8f9`（feat）
- **当前 HEAD**：`72d7e70`
- **package version**：`0.1.54`
- **日期**：2026-08-29
- **下一阶段**：Phase 4（Pre-upgrade Automatic Snapshot）——**禁止提前实现**

---

## §P0-A 状态（P0-A = CLOSED）

先前 P0-A「Coordinator 未接入生产 destructive」已关闭。经 `withMutationGate` journal-aware（index.ts）+ `Phase3Recovery.runJournaled`/`runExternalIntent`（phase3-host.ts）+ 各引擎入口接线，**所有 in-scope 生产 destructive mutation 均在正确 GLOBAL lock 下创建 durable journal**。独立最终评审（单一问题：生产 destructive 是否仍可在无 journal 下改环境？）= **NO（P0-A CLOSED）**，聚焦再评审确认 CLI/backup 残余 bypass 已关闭。

### 真实生产 operation 接线表（P0-A）
| Entry | 锁 | journal 类型 | journal operationType | 证据 |
|---|---|---|---|---|
| import-apply | withMutationGate | runJournaled | `import-apply` | index.ts:1458 (gate) |
| restore (dryRun=false) | runWithMutationLock | runJournaled | `restore` | index.ts:2344 |
| profile-switch | withMutationGate | runJournaled | `profile-switch` | index.ts:1458 |
| sync-apply | withMutationGate | runJournaled | `sync-apply` | index.ts:1458 |
| autosync-apply | withMutationLock | runExternalIntent | `autosync-apply` | autosync-scheduler.ts:417-422 |
| sync-push | withMutationGate | runJournaled | `sync-push` | index.ts:1458 |
| model-tools restore | runWithMutationLock | runJournaled | `model-restore` | model-tools.ts:200 |
| model-tools sync-push | runWithMutationLock | runExternalIntent | `model-sync-push` | model-tools.ts:239 |
| CLI restore | runWithMutationLock | runJournaled | `cli-restore` | cli/index.ts:644 |
| CLI reinstall | runWithMutationLock | runExternalIntent | `cli-reinstall` | cli/index.ts:513 |
| backup export | runWithMutationLock | runExternalIntent | `backup-schedule` | backup-scheduler.ts:269 |
| 其它 gate 路由（snapshot-delete/pin、backup-file-delete、profiles delete/rename/import、sync-rollback） | withMutationGate | runJournaled | 对应 op | index.ts:1458 |

> 只读分支（restore dryRun、CLI `--dry-run`、model confirm:false、sync previewPush、profiles analyze-switch）**零写入、不建 journal / 不锁**（正确行为）。
> dryRun=true 且 SAFE MODE：CLI/restore 在 dry-run return 后、建锁前 `checkSafeModeBlocked` 拦截 destructive。

---

## §Baseline

- 基线 HEAD：`6a687e92da99c2ab6581bf342dd6f5a97dc6ad3a`
- package：0.1.54
- working tree：8 修改 + 新增 Phase 3 文件（待 commit，见 §Commit）
- tests：基线 1176 → 最终 **1228**（+52 Phase 3：45 核心 + 6 生产集成 + 1 isLiveOwner，0 回归）

---

## §Non-Negotiable Invariants（本 Phase 保持，勿破坏）

- **Phase 1**：单文件 old-or-new（journal 复用 atomicWriteFile 不改语义）；journal sensitive 0600、symlink reject；transactions 目录 0700。
- **Phase 2**：`environment.lock` 从 open('wx') 成功后到 release **immutable**，禁止 rewrite/append/atomicWriteFile/rename/metadata/回填 journalId（`journalId` 恒 null/reserved/unused）。
- **Journal→Lock 单向绑定**：journal 存 operationId/ownerInstanceId/lockId；从锁找 transaction = scan `transactions/active/*.json` + 校验，**禁止为双向引用改 ownership**。
- **Terminal-before-release**：durable terminal（COMMITTED/ROLLED_BACK/NEEDS_ATTENTION）BEFORE Environment Lock release；guard 只验证 isTerminal，不决定 outcome。
- **Startup 不自动 recover stale lock**（Rev 3 P1-NEW-2）：startup 只读检测 → RECOVERY_REQUIRED/SAFE MODE → 用户显式确认后才 prove stale → recoverStaleLock → acquire → reconcile；UNKNOWN_STATE 不 recover。
- **env-lock.ts 保持「笨」**：只做 acquire/validate/heartbeat/stale 分类/显式 recover/release + 通用注入 `isBlocked` 谓词；不 import journal/reconcile/coordinator/recovery-policy。
- **外部副作用**：插件/Git/WebDAV/reinstall 记录 intent + 探测，不可证明 → NEEDS_ATTENTION；**绝不自动 cleanup 插件 / 自动回滚外部**。
- **破坏性 recovery 需用户确认**。

---

## §Known Limitations（原样保留）

1. ~~**P0-A（首要）**：Coordinator/wrapOperation 未接入真实 destructive 操作~~ —— **已 CLOSED（本轮）**：全部 in-scope 生产 destructive 入口已 journaled（§P0-A 状态表）。
2. `phase3-host.ts` 的 `runJournaled`/`runExternalIntent` 为「意图 journal」（记录 operationType/intent step，opaque）；**逐计划项级 WAL / 指纹插桩**（import 每项 beforeFp/afterFp）仍未做——真实 crash 后 reconcile 对 opaque journal 保守 needs-attention（安全，不自动恢复）；细粒度自动恢复留 v2。production `reconcile` 的 hooks 仍保守（phase3-host 生产 reconcile 用 conservativeHooks → 对 incomplete journal 判 needs-attention，不自动 recovered）。**这满足 v1「journal exists + SAFE MODE + explicit recovery」**，但「自动 resume 到 done」需 v2 的逐项指纹。
3. SAFE MODE 与「锁被占用」在 `runWithMutationLock` 上统一折叠为 `mutation-locked` / 423（功能正确，诊断信号不足）。
4. Windows `osProcessStartIdentity` 默认不可得 → stale+alive+PID 存活时保守 UNKNOWN_STATE（继承 Phase 2）；journal 无目录 fsync → crash-consistency 弱于 power-loss。
5. model `config_backup`（`model-tools.ts:108`）与 `profiles/save`（`index.ts:2401`）无 GLOBAL 锁（前者写新 ZIP 非 live-config 破坏，后者写 profiles 目录非 live-config；按 Phase 2 设计可接受，记录）。
6. 现有两个 RunRegistry 实例缺陷（Phase 2 遗留，hygiene）。

---

## §Phase 3 v2（已 CLOSED P0-A；v2 = 细粒度自动恢复）

> P0-A（生产 destructive 接线）已关闭（本轮）。v2 剩余（非阻塞 PASS，均为增强）：
1. **逐计划项级 WAL / 指纹插桩**：import/restore 每项记 beforeFp/afterFp（side effect 后重读磁盘），使 reconcile 可自动判 done → 细粒度 recovery（当前 opaque intent journal → 保守 needs-attention）。
2. 生产 `reconcile` 提供真实 `verifyStepFingerprint`/`probeExternal`/`snapshotExists`（替代 phase3-host conservativeHooks）→ `recovered`/`noop` 自动恢复路径真实可达。
3. `isLiveOwner` 增强为 per-journal owner 探测（当前 `inspectStartup` 已用 lockState LOCKED → 强制 live 跳过，`||` 修复 + 测试）；可进一步按每个 journal 的真实 owner 存活做细粒度判定。
4. `COMMITTED` 写失败 → 显式 `RECOVERY_REQUIRED` 信号透传到 UI（当前内部分类 + SAFE MODE，信号未独立暴露）。
5. 快照所有权绑定（snapshotId 属于 operationId）的显式元数据校验（当前靠 snapshotExists 保守 + 用户确认）。

---

## §Phase 4 Prerequisites（进入 Phase 4 前须满足）

- [x] P0-A（生产 destructive journal 接线）= CLOSED（本轮）。
- [ ] 维持 1228 tests 基线（不得删旧）。
- [ ] Phase 4 为**独立阶段**：pre-upgrade 自动 snapshot / upgrade detector / 版本迁移，**不并入 Phase 3**（Phase 3 只处理 destructive op crash recovery，不处理 upgrade）。

---

## §Recommended Context for New Conversation

本仓库：`D:\Projects\personal\dsh-config-manager`（Phase 3 实现未提交）
必读：
1. `CRASH_JOURNAL_IMPLEMENTATION_REPORT.md`（本 Phase 实现报告）
2. `CRASH_JOURNAL_DESIGN.md`（Rev 3）
3. `CRASH_JOURNAL_DESIGN_REVIEW.md`（Rev 3）
4. `PHASE2_HANDOFF.md` + `src/utils/env-lock.ts`
5. Phase 3 源码：`src/core/{journal.ts, transaction-coordinator.ts, reconcile.ts, phase3-host.ts, phase3-child-crash.ts}` + 5 个测试

> 优先相信最终源码 + Implementation Report。旧设计/评审冲突 → 最终源码为准。
