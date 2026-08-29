# CRASH_JOURNAL_DESIGN_REVIEW — Phase 3：Crash Journal 设计评审

> 状态：**Review Rev 3 完成（READ-ONLY）**。评审对象：`CRASH_JOURNAL_DESIGN.md` Rev 3（Rev 2 经一致性修正后的最终版）。
> 评审方式：5 位独立 READ-ONLY 评审（Transaction / Crash-window Adversary / Recovery / Windows / Security）+ captain 交叉复核；随后 **Rev 3 定向再评审**（Transaction+Phase2-invariant / Recovery+Terminal / Phase2-compliance 三视角）。全部只读，未修改 Phase 3 源码。
> **最终结论：`DESIGN / REVIEW CONSISTENCY: PASS`，P0 = 0，unresolved P1 = 0，`Implementation Gate = GO`**（详见 §5 Rev 3 门禁判定）。

---

## 5. Rev 3 一致性修正与最终门禁判定

### 5.1 Rev 3 新增 findings（用户交叉检查发现 + 再评审）
| # | 严重度 | Finding | Rev 3 修订 |
|---|---|---|---|
| P0-NEW-1 | P0 | 原 Design 回填 `LockOwnershipRecord.journalId` 违反 Phase 2 L-INV-2（`environment.lock` immutable） | §2/§5/§11：删除回填；改为 **Journal→Lock 单向绑定**（scan `active/*.json` + 校验 ownerInstanceId/lockId）；`journalId` 保持 null/reserved/unused |
| P1-NEW-1 | P1 | 原 Design 让 `runWithMutationLock finally` 自行决定/写 terminal = Lock 承担 transaction recovery 职责 | §7/§11：引入 **`MutationTransactionCoordinator`**；Lock 只 acquire/validate/heartbeat/release；guard 只验证 isTerminal 不决定 outcome；coordinator 无法 durable terminal → 报 fatal recovery-required 而非伪造终态 |
| P1-NEW-2 | P1 | 原 Design startup `STALE → 自动 recoverStaleLock → continue` = 把显式 recovery 变成自动接管 | §8.3/§12：startup 只读检测 → STALE 置 RECOVERY_REQUIRED/SAFE MODE → 不自动 recover → 用户显式确认 → prove stale → recover → acquire → reconcile；UNKNOWN_STATE 不 recover |
| P1-NEW-3 | P1（Phase2-compliance 再评审） | §12 SAFE MODE 门禁「挂进 withMutationLock(env-lock.ts:197)」与「env-lock.ts 不得 import recovery policy」张力 | §12 改为**注入谓词**（`isBlocked?: () => boolean` 由 coordinator 注入），env-lock.ts 保持零 recovery-policy 引用 |
| 观察（非阻塞） | — | Recovery 再评审建议显式声明尾操作在 COMMITTED 前 | §7 明确「尾操作属 execute 步、须在 engine 整体返回写 COMMITTED 之前完成」；§18.1 补测试 13 |

### 5.2 Rev 3 定向再评审结论（三视角）
| Reviewer | 聚焦点 | 结论 |
|---|---|---|
| Transaction + Phase2-invariant | 5 聚焦点（immutable ownership / Coordinator 职责分离 / startup 显式 stale / terminal-before-release / scheduler ordering） | **5/5 PASS，GO**；全文档 grep 无残留回填/自动 recover 写法 |
| Recovery + Terminal consistency | 同 5 点 + 尾操作时序 + 缺 COMMIT 决策 | **5/5 PASS，GO**；额外检查自洽 |
| Phase2-compliance | L-INV-1~8 + Phase1 atomic 语义 + MutationLockPort 兼容 + env-lock.ts 清洁 | **8 条 L-INV 全 PASS，GO**（唯一张力已由 5.1 P1-NEW-3 修复） |

### 5.3 最终门禁判定
- **P0 = 0**（P0-NEW-1 及 Rev 1 的 6 项 P0 全部在 Rev 3 文本闭环）
- **unresolved P1 = 0**（Rev 1 的 14 项 P1 + Rev 3 的 P1-NEW-1/2/3 全部在 Rev 3 文本闭环）
- **`DESIGN / REVIEW CONSISTENCY: PASS`**（Design 与 Review 结论一致，无未关闭 finding）
- 剩余项均为 P2 / 实现期定稿（§20/§21），不阻塞门禁。

```
Implementation Gate = GO   （对 CRASH_JOURNAL_DESIGN.md Rev 3）
```

> 依 §27：**Gate=GO 后先停止**，向用户报告并等待确认，才进入 Phase 3 Implementation（本轮不实现，未改任何 Phase 3 源码）。

---

## 0. 评审参与者与视角

| Reviewer | 视角 | 原始结论 |
|---|---|---|
| Transaction Architecture | commit 点/双 transaction/原子性 | NO-GO（P0=2, P1=6） |
| Crash-window Adversary | 每个 journal↔side-effect 边界插 crash | NO-GO（P0=2, P1=5） |
| Recovery & Startup | 启动时序/锁/reconcile 循环 | NO-GO（P0=2, P1=5） |
| Windows / Durability | Windows fs 语义/power-loss | NO-GO（P0=0, P1=3） |
| Security | secret/symlink/路径穿越/篡改 | GO（有条件）（P0=0, P1=4） |

> 所有 P0/P1 均已在 `CRASH_JOURNAL_DESIGN.md` Rev 2 **写入 Design 文本**（标注「已并入」），故按 §25「unresolved P1=0」标准对修订后 Design 判 GO。下表 findings 是对**初始设计**的发现，修订状态在每项标注。

---

## 1. P0 Findings（可导致错误自动恢复 / 数据破坏 / 双 transaction）

| # | Reviewer | Finding | 修订状态 |
|---|---|---|---|
| P0-1 | Transaction (TX-P0-1) | `runWithMutationLock` 的 release 无条件在 `finally`（env-lock.ts:242-246）；COMMITTED 写/尾操作抛错时 fn 抛→finally release，journal 以非 terminal 残留 active/——**进程内「release 时 journal 未 commit」**。 | **已修订**：§7 加 release terminal gate（release 前校验/落定 journal terminal；尾操作严格先于 COMMITTED+move）；§11 每次 acquire 前置 reconcile + active 清扫 |
| P0-2 | Transaction (TX-P0-2) | reconcile 只在启动跑（§8.3）+ 新 op 创建不检查 active/，P0-1 残留使 active/ ≥2 journal，违反 §16「active≤1 op」，§8.2 无多 journal 决策行 → 双 op/跨 op 覆盖。 | **已修订**：§11 每次 acquire 后、创建新 op 前先检查 active/ 非空并 reconcile；§8.2 补「无 step 应用」与多 journal 决策 |
| P0-3 | Recovery (P0-1) | reconcile 与 autosync/backup scheduler 启动时序竞态未定义：scheduler.start()（index.ts:1583/4038）的 startup runOnce 可能抢在 reconcile 前 destructive apply，改写磁盘→指纹判定失真。 | **已修订**：§8.3 step1 reconcile 必须先于 scheduler.start()；scheduler 启动触发被 SAFE MODE 门禁拦截（§12） |
| P0-4 | Recovery (P0-2) / Windows (P1-1) | crash 后锁为 stale，env-lock 硬不变量「绝不自动接管」，reconcile 无法 acquire → 恢复流程根本启动不了。 | **已修订**：§8.3 step2 遇 STALE 以 journal 为 crash 证据显式 `recoverStaleLock()`（prove dead+quarantine）后再 acquire；UNKNOWN_STATE → NEEDS_ATTENTION |
| P0-5 | Adversary (P0) | 插件外部副作用被当「本地 ACID 可回滚」：`cleanupAbortedInstall` 无条件 `rmSync(node_modules/<pkg>)`（plugin-cli.ts:197），反向半装态（node_modules 有/manifest 无）会**删掉完整安装**；Update（v1→v2）被回滚成「未装」而非 v1，**丢失可用插件**。 | **已修订**：§9/§10 插件外部 step crash 一律 NEEDS_ATTENTION（**绝不自动 cleanup/回滚**）；双向半装态四态全定义；Update 回滚目标是 v1（beforePlugins） |

---

## 2. P1 Findings（recovery 卡死 / 无法判断 / journal inconsistency）

| # | Reviewer | Finding | 修订状态 |
|---|---|---|---|
| P1-1 | Adversary | 不可指纹 step（settings/patchLine）的「保守整 op 回滚」会把**已完成 op 误回滚**（sync-apply 恒 rollbackOnError）；与 §9「resume 而非重做」自相矛盾。 | **已修订**：§8.1/§9 不可指纹 step → NEEDS_ATTENTION，绝不自动整 op 回滚 |
| P1-2 | Adversary/Transaction | `snapshotId=null`（快照已建但 journal 未回填）一律判 NEEDS_ATTENTION，未区分「无 step 应用（可安全丢弃）」；且 createSnapshot 非原子、SNAPSHOT_CREATED 写失败误判。 | **已修订**：§8.2 加「无 step 应用 → RECOVERED(no-op)」；§11 加 snapshot-integrity 跨检 |
| P1-3 | Adversary/Transaction | reconcile 自身 crash → 决策漂移 + attempts 烧尽（瞬时 IO 错误混淆）；对条件幂等 rollback 双 unset。 | **已修订**：§8.4 区分「真 crash」与「瞬时错误」（瞬时不耗 attempts）；§11/§3.2 回滚 WAL（entryDone） |
| P1-4 | Adversary | reconcile 持锁后 rollback 中锁被别进程接管 → 并发 destructive（未定义 rollback 与锁所有权绑定）。 | **已修订**：§8.3 step5 rollback 复用 reconcile 已持 token（nested）+ 前/中重验 ownership，丢失即中止 |
| P1-5 | Adversary | terminal journal 遗留 active/ 永不到 completed/（违反 §11「active≤1」）。 | **已修订**：§8.3 step3 reconcile 也 move 遗留 terminal journal |
| P1-6 | Recovery | SAFE MODE 门禁漏 autosync 直调 `withMutationLock`；且 SAFE MODE 会阻断 reconcile 自身回滚（循环）。 | **已修订**：§12 门禁挂 `withMutationLock` 原语（覆盖 autosync）；reconcile 内部 recovery 豁免 SAFE MODE |
| P1-7 | Recovery/Transaction | `ownerInstanceId` 校验与 crash 矛盾（journal owner 是已死进程，≠ 当前 reconcile 锁 instanceId）；environmentFingerprint 未定义组成。 | **已修订**：§12/§15 校验语义 =「journal owner 非活跃别进程」（probe）；指纹 = hash(hostname+per-install token) |
| P1-8 | Recovery | corrupt journal 无法写 terminal 也无法 move → attempts 无法持久化 → 跨重启无限重处理。 | **已修订**：§13 quarantine（move 到独立目录 + sidecar NEEDS_ATTENTION），不原地改 state；attempts 不被 corrupt 烧掉 |
| P1-9 | Windows | 无目录 fsync 下「journal done 落盘 + target 旧内容」的 rename 顺序翻转，reconcile 对 done step 不重验 afterFp → 静默 RECOVERED。 | **已修订**：§8.1/§16 done 文件 step 一律重验 afterFp |
| P1-10 | Windows | `active/` 扫描未过滤 `.dshcm.*.tmp` 残留 → 误判损坏 journal → 假 NEEDS_ATTENTION。 | **已修订**：§8.3/§16 只认 `<uuid>.json`，忽略 tmp |
| P1-11 | Security | `redact()` 不覆盖任意 high-entropy secret（错误文本/recovery.reason 泄漏）。 | **已修订**：§15 用 `scanAndRedact`/`redactValue`（含 high-entropy 档）；recovery.reason 不强设「非敏感」 |
| P1-12 | Security | reconcile/rollback 目标解析未强制继承 `isWithinHome`（`resolveFileTarget` 自身无校验，backup.ts:90），恶意 journal ref `../..` 可越界写/删。 | **已修订**：§15 reconcile/rollback 一律经 `isWithinHome` 守卫的 `homeAbs`/`resolveFileAbs` |
| P1-13 | Security | symlink 防护标「可选」，journal 写默认 follow 可被重定向（atomic-write.ts:266）。 | **已修订**：§15 symlink 强制 reject（写）+ 读前 lstat 校验 + 目录校验 |
| P1-14 | Security | 伪造 journal（合法态 + 指向真实快照 + fingerprint 正确）可触发**自动破坏性 rollback**（§13 只对损坏要确认）。 | **已修订**：§15 reconcile 触发的 ROLLED_BACK 一律要求用户确认；journal.snapshotId 必须校验为本 op 创建 |

---

## 3. P2 / 实现期待定（不阻塞门禁）

1. resume 盲信 `step.done` 不验指纹（TX-P2-1）——已由「done 文件 step 一律重验 afterFp」缓解（§8.1）。
2. recovery-history 写失败未定义（Recovery P2-3）——已并入 §8.3 step5「best-effort」。
3. move 失败窗口（Recovery P2-2/Windows P2-1）——已并入 `renameWithRetry` + 不强制 NEEDS_ATTENTION。
4. §0.1 措辞「crash-consistency 强于 power-loss」语义颠倒（Windows P2-3）——已修正为「弱于」。
5. child-process Windows kill 语义 + 孤儿孙进程清理（Windows P2-2）——已并入 §16/§17。
6. backup 重复 ZIP / sync-push 假 NEEDS_ATTENTION / profile-switch step 定义 / afterFp 获取——已并入 §20（实现期定稿）。
7. SAFE MODE 逃生通道（Security P2-1）——已并入 §12/§15/§13。

---

## 4. Implementation Gate 判定

### 判定对象：`CRASH_JOURNAL_DESIGN.md` **Rev 2（修订后）**

- **P0 = 0**（初始 6 项 P0 全部在 Rev 2 文本修订）
- **unresolved P1 = 0**（初始 14 项 P1 全部在 Rev 2 文本修订，无遗留未决）

### 判定依据（§25 门禁）
- 唯一 commit 点 + release terminal gate（§7）——闭合 TX-P0-1 双 op 根因。
- 每次 acquire 前置 reconcile + active≤1（§11）——闭合 TX-P0-2 双 journal。
- reconcile 先于 scheduler.start() + SAFE MODE 门禁挂 withMutationLock（§8.3/§12）——闭合启动竞态。
- stale-lock 显式 recoverStaleLock 前置 + UNKNOWN_STATE 保守（§8.3）——闭合恢复启动不了。
- 插件/外部副作用一律 NEEDS_ATTENTION、绝不自动 cleanup（§9/§10）——闭合数据破坏 P0。
- 其余 P1 均已在 §8/§9/§12/§13/§15/§16 明确。

### 结论
```
Implementation Gate = GO   （对 CRASH_JOURNAL_DESIGN.md Rev 2）
```
- 初始设计存在真实缺陷（评审正确捕获），经修订全部闭环。
- 修订后的 Design 满足「P0=0 且 unresolved P1=0」。
- 剩余项均为 P2 / 实现期定稿，不阻塞门禁。
- 依 §27：**Gate=GO 后先停止，向用户报告，等待确认后才进入 Phase 3 Implementation**（本轮不实现）。

---

## 5. 给 Implementation 阶段的关键红线（评审汇总结论）

1. **release 必须经 terminal gate**——绝不携带「journal 未 commit」释放锁（§7）。
2. **每次 acquire 都 reconcile/清扫 active/**，非仅启动（§11）。
3. **插件/远端/不可指纹 step 一律 NEEDS_ATTENTION**，绝不自动 cleanup/rollback 外部副作用（§9/§10）。
4. **reconcile 触发任何破坏性回滚前必须用户确认**（§9/§13/§15）。
5. **stale lock 显式 recoverStaleLock**，不与 env-lock「不自动接管」冲突（§8.3）。
6. **journal 不存 secret**、symlink reject、`isWithinHome` 强制（§15）。
7. 新文件：`src/core/journal.ts`、`src/core/reconcile.ts`（+ 对应 .test.ts），接入 `withMutationGate`/`runWithMutationLock`，不破坏 Phase 1/2 不变量，不提前 Phase 4。
