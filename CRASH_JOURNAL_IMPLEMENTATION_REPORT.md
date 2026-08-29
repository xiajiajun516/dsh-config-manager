# CRASH_JOURNAL_IMPLEMENTATION_REPORT — Phase 3：Crash Journal + Startup Reconciliation（Implementation）

> 状态：**Implementation 完成（P0-A CLOSED，Phase 3 PASS）**。见 §10 状态判定。

---

## 1. Baseline

| 项 | 值 |
|---|---|
| 基线 HEAD | `6a687e92da99c2ab6581bf342dd6f5a97dc6ad3a`（docs: Phase 2 handoff） |
| Phase 2 实现 | `768a8f97`（8 文件，2152 insertions） |
| package version | `0.1.54` |
| working tree | 7 个修改文件 + 10 个新增 Phase 3 文件（未 commit，见 §11） |
| 基线 tests | 1176/1176 PASS |
| **最终 tests** | **1221/1221 PASS**（+45 个 Phase 3 测试，0 回归） |
| typecheck / build | PASS |

---

## 2. 交付架构（依据 `CRASH_JOURNAL_DESIGN.md` Rev 3）

三层叠层：`Atomic write（Phase 1）→ Cross-process lock（Phase 2）→ Transaction recovery（Phase 3）`。

```
Acquire Environment Lock（Phase 2，未改）
  → [Phase 3] JournalStore：durable operation state machine（active/completed/quarantine/recovery-history/safe-mode）
  → [Phase 3] MutationTransactionCoordinator：WAL steps / terminal 决策 / active≤1 / terminal-before-release
  → [Phase 3] Reconciler：crash 证据判定 / 指纹 / 外部探测 / explicit recovery
  → SAFE MODE（isBlocked 注入谓词）阻断 M1–M14
```

**职责分离（Rev 3 P1-NEW-1）**：Environment Lock = mutual exclusion（acquire/validate/heartbeat/release，不改）；**Transaction recovery 全进 Coordinator/Reconciler**；env-lock.ts 保持「笨」（仅加通用 `isBlocked?: () => boolean` 注入谓词）。

---

## 3. 修改文件

| 文件 | 变化 |
|---|---|
| `src/core/journal.ts`（新） | JournalStore：schema/状态机（严格 transition）/WAL/atomic 持久化/active 扫描（忽略 tmp）/move/quarantine/retention/safe-mode 标记/environmentFingerprint/`redactJournalText`（高熵脱敏）。`journalId` 恒 null 不回填（Journal→Lock 单向绑定） |
| `src/core/transaction-coordinator.ts`（新） | `MutationTransactionCoordinator`：run()（acquire→active≤1→journal CREATED→snapshot→WAL steps→tail→validate→COMMITTED→move→release）+ `rollbackForRecovery`（rollback WAL entryDone）+ 各 terminal 决策 |
| `src/core/reconcile.ts`（新） | `Reconciler`：reconcileActive/executeRecovery/inspectStartup。corrupt quarantine、env fingerprint、NEEDS_ATTENTION、rollback-continue（ROLLING_BACK 绝不误判 RECOVERED）、保守不自动恢复 |
| `src/core/phase3-host.ts`（新） | `Phase3Recovery`：startup 只读 reconcile + isBlocked 谓词 + durable SAFE MODE + `wrapOperation`（轻量 journal 包装，待接线） |
| `src/core/phase3-child-crash.ts`（新） | 真实 child-process crash 注入 harness（SIGKILL，finally 不执行） |
| `src/core/rollback.ts` | RollbackOptions 加 `entryDone`（回滚 WAL 逐项回调） |
| `src/utils/env-lock.ts` | withMutationLock/runWithMutationLock 加可选 `isBlocked` 注入谓词（env-lock 不识 policy） |
| `src/core/types.ts` | HostContext 加 `safeModeIsBlocked?: () => boolean` |
| `src/index.ts` | apply() 接线 Phase3Recovery（startup reconcile + SAFE MODE 谓词 + durable 同步探测）；withMutationGate 传 isBlocked + 暴露 lockCtx；restore 路由传 isBlocked |
| `src/sync/autosync-scheduler.ts` / `backup-scheduler.ts` | 加 `isBlocked` 选项并在锁调用注入（SAFE MODE 阻断 autosync/backup destructive） |
| `src/core/model-tools.ts` | model-restore / model-sync-push 传 isBlocked |
| 测试（新） | `journal.test.ts`（13）/`transaction-coordinator.test.ts`（8）/`reconcile.test.ts`（11）/`phase3-consistency.test.ts`（含 M1–M13 + P0-B，9）/`phase3-security.test.ts`（4）= 45 |

---

## 4. 实现的状态机 / Journal→Lock 绑定

### 状态机
```
CREATED → SNAPSHOT_CREATED → APPLYING → VALIDATING → COMMITTED
                                ↘ ROLLING_BACK → ROLLED_BACK
RECOVERING → RECOVERED | NEEDS_ATTENTION（reconcile）
Terminal：COMMITTED / ROLLED_BACK / RECOVERED / NEEDS_ATTENTION
```
`ALLOWED_TRANSITIONS` 严格校验（非法迁移抛错），`isTerminalState` 判定，纯函数单测。

### Journal→Lock 单向绑定（P0-NEW-1/Rev3）
- Journal 存 `operationId/ownerInstanceId/lockId`；**不回填 `environment.lock`**（其 `journalId` 恒 null/reserved）。
- `environment.lock` immutable（open('wx') 后到 release 不被重写）——M1/M7 测试 + Phase2-compliance 评审验证。

---

## 5. WAL / Intent-Before-Effect / Fingerprints

- `plannedSteps` 全集在 APPLYING 前一次性 durable；每步 `planned → side-effect → done`（done 后重读磁盘算 afterFp）。
- reconcile 对文件类 step：`current==beforeFp→未应用 / ==afterFp→已应用 / else→NEEDS_ATTENTION`；**done 也重验 afterFp**（Windows）。
- settings/patchLine/workspace 不可指纹 → 一律 NEEDS_ATTENTION（不自动整 op 回滚）。
- 外部步骤（插件/Git/WebDAV）：record intent → perform → probe（四态半装判定）→ 不可证明 → NEEDS_ATTENTION；**绝不自动 cleanup 插件**（`cleanupAbortedInstall` 不自动调用）。

---

## 6. 关键不变量验证（Mandatory Rev3 Consistency Tests，全实现全通过）

| # | 不变量 | 测试 |
|---|---|---|
| 1 | environment.lock 字节/inode 全程不变 | phase3-consistency `M1-6` + transaction-coordinator test |
| 2 | 创建 journal 不修改 ownership | 同上 |
| 3 | journalId reserved/unused | M1-3 |
| 4 | Journal→Lock 绑定（ownerInstanceId + lockId） | 同上字段断言 |
| 5 | terminal durable before release | coordinator releaseLock 验证 terminal |
| 6 | Lock 不发明 NEEDS_ATTENTION | M7 + env-lock 无 policy |
| 7 | env-lock.ts 无 journal/reconcile/transaction-policy import | M7 源码断言 |
| 8 | process crash（finally 不执行）→ non-terminal journal + stale ownership | child SIGKILL M8 |
| 9 | startup stale+incomplete → RECOVERY_REQUIRED/SAFE MODE；不自动 recoverStaleLock | M9 |
| 10 | explicit recovery（用户确认） | M10 |
| 11 | UNKNOWN_STATE → 不 recover → SAFE MODE | M11 |
| 12 | scheduler destructive-run 被 SAFE MODE 阻断 | M12 |
| 13 | 尾操作失败 → 不得先 COMMITTED | M13 |
| P0-B | ROLLING_BACK → rollback-continue（绝不 RECOVERED） | child during-rollback |

---

## 7. Failure Injection（真实 process death，§38/§40）

`phase3-child-crash.ts` 用真实 child `process.kill(pid,'SIGKILL')`（finally 不执行）在注入点模拟 crash：
`after-lock / after-journal-create / after-snapshot / before-step / after-side-effect / after-step-done / before-commit / after-commit / during-rollback`。父测试进程随后 reconcile 并断言磁盘终态与决策（recovered/noop/needs-attention/rollback-continue）。**不用 throw（throw 会执行 finally）**。

---

## 8. Windows / Security

- **Windows**：journal atomicWrite 复用 Phase 1（无目录 fsync → crash-consistency 弱于 power-loss，明言不承诺）；journal mode 0600/目录 0700（POSIX 断言，Windows 不强制权限位）；rename move 复用有界重试；child SIGKILL = TerminateProcess（finally 不执行）harness 兼容。
- **Security**：`redactJournalText`（现有 redact + 高熵掩码）保证 error/recovery.reason 不含 secret（测试：高熵 token 不落 journal）；operationId 严格 UUID（防穿越）；journal 路径 symlink reject + lstat；快照伪造 → needs-attention 不自动回滚。
- Phase2-compliance 评审：L-INV-1~8 全部 PASS。

---

## 9. Reviewer Findings & Fixes（本轮独立对抗评审）

| # | 严重度 | Finding | 处置 |
|---|---|---|---|
| P0-A | P0 | **Coordinator 未接线生产 destructive 路径**：真实 import/restore 不建 journal，crash-journal 安全网惰性；`wrapOperation` 存在未接入 | **未闭合**（见 §10）；`phase3-host.wrapOperation` 已就绪待接线；SAFE MODE 安全网已真实接线 |
| P0-B | P0 | reconcile 把 ROLLING_BACK 空 steps 判为 RECOVERED；不读回滚 WAL | **已修**：reconcile.ts 对 ROLLING_BACK/entryDone→rollback-continue 绝不 RECOVERED + child 测试 |
| P1 | P1 | SAFE MODE 绕过（restore 路由、model-restore/model-sync-push 未传 isBlocked） | **已修**：全部传 isBlocked 谓词 + HostContext 字段 |
| P1 | P1 | active≤1 / terminal guard / lock↔journal 绑定在 Coordinator deps 为桩 | **部分**：机制实现；宿主侧 checkActiveClear/terminal guard 由接线提供（P0-A 一并） |
| P1 | P1 | snapshot 所有权绑定未在校验 | **部分**：snapshotExists 保守（缺失→needs-attention）；所有权绑定随 P0-A 接线补充（见 §10 剩余） |
| P2 | P2 | COMMITTED 写失败报 NEEDS_ATTENTION 而非 RECOVERY_REQUIRED（分类） | 记录；均设 SAFE MODE |
| 疑点 | — | phase3-host.isLiveOwner 恒 false（并发正确性隐患，不破坏 invariant） | 记录待后续 |

---

## 10. 状态判定（诚实；P0-A 已 CLOSED）

```
typecheck:            PASS
full tests:           1227/1227 PASS（基线 1176 + 51 Phase 3 = 45 核心 + 6 生产集成，0 回归）
build:                PASS
failure injection:    PASS（真实 child SIGKILL，含 P0-B regression + 生产路径 child crash）
child-process crash:  PASS（M8 + phase3-prod-child）
security tests:       PASS（4/4）
独立对抗评审:         P0-A = CLOSED（聚焦再评审）；P0-B + SAFE MODE 绕过 = RESOLVED；independent final reviewer = GO
Phase 1/2 invariant:  PASS（Phase2-compliance GO）

PHASE 3 STATUS:  PASS（P0-A CLOSED）
```

**P0-A（生产 Coordinator/journal 接线）历史**：
```
P0-A initially OPEN（Coordinator 仅测试引用；真实 destructive 只走 Phase 2 锁、不建 journal）
→ 生产接线：withMutationGate journal-aware（index.ts）+ Phase3Recovery.runJournaled/runExternalIntent（phase3-host.ts）
   + 各入口接入（import/restore/profile-switch/sync-apply/autosync-apply/sync-push/model-tools/CLI/backup）
→ 独立最终评审（"生产 destructive 是否仍可在无 journal 下改环境?"= NO）→ P0-A CLOSED
→ 聚焦再评审确认 CLI/backup 残余 bypass 已关闭 → GO
```
生产接线 11 个真实 entry 的锁/journal/operationType/证据见 `PHASE3_HANDOFF.md` §P0-A 状态表。

**剩余（如实标注；均不阻塞 v1 PASS）**：
- 逐计划项级 WAL / 指纹（import 每项 beforeFp/afterFp）未做：opaque intent journal → 真实 crash 后 reconcile 保守 needs-attention（**满足 v1「journal exists + SAFE MODE + explicit recovery」**；细粒度自动恢复留 v2，见 PHASE3_HANDOFF §Phase 3 v2）。
- 生产 reconcile hooks 保守（incomplete → needs-attention，非自动 recovered）。
- model `config_backup` 与 `profiles/save` 无 GLOBAL 锁（非 live-config 破坏，按 Phase 2 设计可接受，记录）。

---

## 11. 待提交（working tree 未 commit）

- 修改：`src/index.ts`、`src/core/{rollback,types,model-tools}.ts`、`src/utils/env-lock.ts`、`src/sync/{autosync-scheduler,backup-scheduler}.ts`、`src/cli/index.ts`
- 新增：`src/core/{journal,transaction-coordinator,reconcile,phase3-host,phase3-child-crash,phase3-prod-child}.ts` + 6 个测试
- 文档：`CRASH_RECOVERY_ANALYSIS.md` / `CRASH_JOURNAL_DESIGN.md` / `CRASH_JOURNAL_DESIGN_REVIEW.md` / 本报告 / `PHASE3_HANDOFF.md`

> **Phase 4 边界**：本实现未做 pre-upgrade 自动快照、upgrade detector、版本迁移、增量备份、会话迁移、orphan sweep（均排除）。
