# CRASH_JOURNAL_DESIGN — Phase 3：Crash Journal + Startup Reconciliation（Design）

> 状态：**Design 完成**（尚未实现）。依据 `CRASH_RECOVERY_ANALYSIS.md`（Analysis）+ 最终源码 + Phase 1/2 不变量。
> Design 目标：为「可证明恢复」的本地多文件 destructive mutation 建立 **durable operation state machine + deterministic startup reconciliation**，不重写 atomic/lock，不提前实现 Phase 4。
>
> **非目标（§26）**：不实现 Phase 3 源码；本文件是 Design，等待 Design Review GO 后才进入 Implementation。不自动 rollback / resume（只定策略，实现阶段做）。不实现 SAFE MODE（只定策略）。不实现 orphan sweep、Phase 4 预升级快照、增量备份、会话迁移、无关重构。

---

## 0. Design 前提（从 Analysis 提取的不变量）

1. **Phase 1 atomic write** 提供单文件 old-or-new 一致性；`atomicWriteFile` 抛错 = rename 未发生（target 旧完整）；Windows 无目录 fsync → **crash-consistency 是弱于 power-loss durability 的保证**（Windows 只承诺 process-crash 一致性，不承诺断电 rename 持久）。（措辞修正，Windows Review P2-3 并入。）
2. **Phase 2 env-lock** 提供跨进程互斥；destructive 必须成功 acquire 才执行；`LockOwnershipRecord.journalId` 为 Phase 2 **预留字段（保持 null/reserved，Phase 3 v1 不回填，immutable ownership，P0-NEW-1）**。
3. **共同形态**：可恢复 mutation（import/sync-apply/profile-switch/restore）全部 = `createSnapshot`（回滚点）+ `applyItem` 单步（逐文件原子写 / 插件外部进程 / patch line）。单步原子，**整体非事务**。
4. **不可证明的外部/远端副作用**（插件、Git/WebDAV push、reinstall）——记录 intent + 一致性探测，无法证明 → NEEDS_ATTENTION，**绝不假装外部 ACID**。

---

## 1. Journal 是什么 / 不是什么

- **是**：一次 operation 的 durable 状态机记录（operationId + planned steps + completed steps + pre-state 引用 + commit 点）。
- **是**：恢复证据（crash 后判断「到哪一步、哪些已 durable、是否 commit、能否 rollback/resume」）。
- **不是**：append-only debug log（不记录每次心跳/进度噪声）。
- **不是**：外部/远端操作的 ACID 保证（远端仍可能状态未知 → NEEDS_ATTENTION）。

### 职责划分（明确不越界）
| 概念 | 归属 |
|---|---|
| 单文件 old-or-new | Phase 1 atomic write |
| 一次一个 destructive | Phase 2 env-lock |
| 跨文件/目录/插件/快照的 operation crash 恢复 | **Phase 3 本设计** |

> 禁止把「用了 atomicWriteFile」解释为「整个 import 是 transaction」；禁止把「拿到 Environment Lock」解释为「crash 后状态自动恢复」。三者独立。

---

## 2. Journal Storage Layout（存储布局）

```
<dataDir>/transactions/                    # 根目录（缺省 <dataDir>=~/.dsh/dsh-config-manager，与 locks/ snapshots/ 同级）
  active/<operationId>.json                # 进行中（CREATED→COMMITTED/ROLLED_BACK/RECOVERED/NEEDS_ATTENTION 前）的可变 journal
  completed/<operationId>.json             # 已达 terminal state 的存档（只读；retention 后删除）
  quarantine/<operationId>.json            # corrupt/无法 parse 的 journal 隔离（+ <op>.needs-attention sidecar，见 §13）
  recovery-history/<operationId>.json      # 每次 reconciliation 事件记录（RECOVER/ROLLBACK/NEEDS_ATTENTION 及证据）
  safe-mode                               # SAFE MODE durable 标记（§12）
  # 注：recovery-history 以「追加」方式按操作记录，供审计；active/ completed/ quarantine/ 各持唯一 <operationId>.json
```

- **active 目录**应只有 ≤1 个有效 operation（与 GLOBAL lock 一一对应，§11 强制）。
- **目录创建**：`mkdir recursive`；目录权限 0700，journal 文件 0600（敏感面，防同机他账户读取）。
- **文件名** = `operationId`（UUID v4），天然防碰撞；`completed/` 与 `active/` 同名区分生命周期。
- **原子更新**：journal 内容每次全量覆盖重写（journal 极小，几百字节），复用 Phase 1 `atomicWriteFile`（mode 0o600）。

### 生命周期
```
active/<op>.json (CREATED)
  → active/<op>.json ... → (COMMITTED) → move到 completed/<op>.json (rename)
  → 或 (ROLLED_BACK)     → move到 completed/<op>.json
  → crash 后 startup reconcile → RECOVERED/ROLLED_BACK → move到 completed/<op>.json
  → NEEDS_ATTENTION → move到 completed/<op>.json（state=needs-attention，禁止新 mutation，见 §12）
```

- **`environment.lock` 绝对不可变（Rev 3，P0-NEW-1 已并入）**：Phase 2 不变量 L-INV-2 要求 ownership record 在 `open('wx')` 成功后直到 release **绝不被 rewrite / atomicWriteFile / rename 替换 / 元数据更新**。**Phase 3 不回填 `journalId`，不修改 ownership file 任何字节**。`LockOwnershipRecord.journalId`（Phase 2 曾预留字段，env-lock.ts:120）保持 `null` / reserved / **Phase 3 v1 不使用**。
- **Journal → Lock 单向绑定（Rev 3，P0-NEW-1 已并入）**：Journal 保存 `operationId` + `ownerInstanceId` + `lockId`；Environment Lock **不保存/更新 journalId**。需要从当前 lock 找 transaction 时：**scan `transactions/active/*.json`** 并验证 `journal.ownerInstanceId === currentLock.owner.instanceId` **AND** `journal.lockId === currentLock identity`。**禁止为了双向引用修改 ownership record。**

**`move` 语义**：用 `rename(active/<op>.json, completed/<op>.json)`（同目录树内，原子）；corrupt journal 移到 `quarantine/`。均不是复制+删；均复用 `renameWithRetry`（Windows EBUSY，§16）。

---

## 3. Journal State Machine（状态机）

> 状态名由最终源码的 operation 生命周期推导，非机械照抄示例。

### 3.1 正常路径
```
CREATED                       # acquire lock 后立即创建（intent 已存）
  → SNAPSHOT_CREATED          # pre-operation snapshot 已建（snapshotId 写入，回滚点就绪）
  → APPLYING                   # 开始逐 step apply
  → VALIDATING                 # 全部 step done，进入校验
  → COMMITTED                  # 校验通过，operation 宣告完成（terminal；此后才允许 release lock）
```

### 3.2 异常路径（含回滚 WAL）
```
APPLYING / VALIDATING
  → ROLLING_BACK               # 检测到失败（rollbackOnError）或 reconciliation 决定回滚
      # 回滚 WAL（TX-P1-4 已并入）：每补偿一项记 rollback.entryDone；crash 在回滚中 → 从 WAL 判定已补偿/未补偿
  → ROLLED_BACK                # rollback 完成（terminal）
```

### 3.3 Crash 后（startup reconciliation）
```
INCOMPLETE                     # 启动发现 active/<op>.json 且非 terminal —— 由任意非 terminal state 推导
  → RECONCILING                # reconcile 进行中（journal 更新）
  → RECOVERED                  # 依据证据：resume 已完成（各 done step afterFp 重验通过）或已安全回滚 —— terminal
  → NEEDS_ATTENTION            # 无法从证据证明（外部副作用/不可指纹 step/未知状态/journal 损坏）—— terminal，禁止新 mutation
```

**状态 durable 性**：`state` 字段必须在对应 side effect **之前**写入 journal（WAL：intent-before-effect）。例如：
- 进入 APPLYING 前先 journal `state: APPLYING` + 登记 plannedSteps，再开始 apply。
- 每步：journal `stepX planned`（在 acquire 时就已全量登记）→ side effect → journal `stepX done`。
- **回滚 WAL**：进入 ROLLING_BACK 前记 state + 计划补偿项；每补偿一项记 `rollback.entryDone`；全部完成记 ROLLED_BACK（TX-P1-4 已并入）。
- `COMMITTED` 写入 + move 到 completed/ 后，锁才能经 terminal gate release（§7）。

---

## 4. Journal Schema（字段）

```jsonc
{
  "schemaVersion": 1,
  "operationId": "uuid-v4",
  "operationType": "import-apply | restore | profile-switch | sync-apply | autosync-apply | backup | sync-push | ...",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "state": "CREATED|SNAPSHOT_CREATED|APPLYING|VALIDATING|COMMITTED|ROLLING_BACK|ROLLED_BACK|RECOVERING|RECOVERED|NEEDS_ATTENTION",
  "ownerInstanceId": "环境锁 owner instanceId（env-lock）",
  "lockId": "lock 所有权文件标识（journal 与 lock 绑定）",
  "packageVersion": "PLUGIN_VERSION，0.1.x",
  "environmentFingerprint": "本机/DSH 环境指纹（§15），防跨机误恢复",
  "snapshotId": "createSnapshot 返回的快照 id（回滚点），可为 null（无快照的 op 如 backup）",
  "plannedSteps": ["stepId1", "stepId2", "..."],
  "steps": {
    "stepId1": { "adapter": "plugins", "ref": "plugin:@x", "kind": "Install",
                 "beforeFp": "sha256 前的文件指纹或 null", "afterFp": "期望写入后的指纹或 null",
                 "external": true, "status": "planned|done|failed|skipped|attention",
                 "appliedAt": "ISO 或 null" },
    ...
  },
  "commit": { "at": "ISO 或 null", "validated": true|false, "validationWarnings": [] },
  "rollback": { "attemptedAt": "ISO 或 null", "full": true|false, "failed": [] },
  "recovery": { "attemptedAt": "ISO 或 null", "outcome": "RECOVERED|ROLLED_BACK|NEEDS_ATTENTION" | null,
                 "reason": "文本（非敏感）", "attempts": 0 },
  "error": "最后错误文本（已 redact，非秘密）"
}
```

**不保存**：API keys / decrypted credentials / 密码 / secret 值。只存 paths / 逻辑 section / ref / hashes / ids / 元数据。（复用现有 `redact()`；credentials 相关 step 只记 ref，不记值。）

**每个 step 必须回答**（§7）：是否记录 planned steps？— `plannedSteps` + `steps[].status`。是否记录 completed steps？— `steps[].status==='done'`。是否记录 fingerprint？— `beforeFp/afterFp`（用于恢复证据）。是否记录 pre-state？— `snapshotId` + `beforeFp`。是否记录 operationId？— 是。是否记录 lock owner/lockId？— 是。是否记录 app/package version？— 是。是否记录 environmentFingerprint？— 是。

---

## 5. OperationId & Step Identity

- **operationId**：UUID v4，在 acquire lock 成功后立即生成（journal 文件名）。**不回填 `LockOwnershipRecord.journalId`**（Phase 2 ownership record immutable，P0-NEW-1）——Journal→Lock 绑定经 `scan active/*.json` + 校验 `ownerInstanceId`/`lockId`（§2）。
- **step identity / stepId**：`<operationId>:<stepIndex>`，stepIndex 为 APPLY 顺序内的稳定序号。**planned 在 acquire 时就全量登记**（不是执行中动态追加）→ 保证 crash 后 step 集合完整、不因重排变化而误判。
- **step 的恢复指纹**：`beforeFp`（side effect 前目标内容 hash，来自快照/探测器）+ `afterFp`（期望写入后的内容 hash，可由 adapter 计算）。用于「crash 后判断该 step 是否已应用」（§8.1）。

---

## 6. Intent / Completion Semantics（WAL intent-before-effect）

对**本地可指纹**的 step（settings/ui/skills/agentPresets/... 文件类 + patch line）：

```
[journal] stepX.status = planned   （acquire 时已登记；beforeFp 已存）
   ↓
[side effect] adapter.applyItem → atomicWriteFile 写目标
   ↓
[journal] stepX.status = done；appliedAt 写入
```

对**外部可探测**的 step（插件 Install）：

```
[journal] stepX.status = planned；external = true
   ↓
[side effect] runDshPlugin（spawn 子进程）
   ↓
[探测] readInstalled vs readInstalledVersion（半装态探测，plugin-cli.ts 已有）
   ↓
[成功] journal stepX.status = done   [半装] → 记 attention（不自动回滚，见 §10.3）
```

**crash 在 journal 更新前怎么办**：
- crash 在 `stepX done` 写入**前**（side effect 可能发生或未发生）→ reconcile 用 `beforeFp/afterFp` 判定（§8.1）：匹配 before → 未应用；匹配 after → 已应用（补写 done）；都不匹配 → NEEDS_ATTENTION。
- crash 在 `stepX done` 写入**后** → 该步已确认完成，继续下一未完成步。

**intent durable 的时机**：整个 `plannedSteps` + `steps[].planned` 在 APPLYING 前一次性写入并 atomicWrite（一次 durable）→ 之后每步只更新单步状态。这样「planned 全集」永不丢失。

---

## 7. Commit Point（提交点）

> **职责分离（Rev 3，P1-NEW-1 已并入）**：Environment Lock 是 **mutual exclusion primitive**，**不是 transaction recovery engine**。它不得理解 journal steps / snapshot / fingerprints / rollback policy / recovery policy / NEEDS_ATTENTION decision。终结态由 **`MutationTransactionCoordinator`（§11）** 决定，Lock 只需 acquire / validate / heartbeat / release。

- **COMMITTED 是唯一 commit 点**：coordinator 写 `state=COMMITTED` + `commit.at` atomicWrite 成功后，该 operation 才视为「已成功完成」。
- **尾操作先于 COMMITTED（Recovery 再评审已并入为显式不变量）**：所有可能抛错的尾操作（`markSnapshotStatus`、vault 回填，analyzer.ts:551-567）**属于 execute 步、必须在 engine 整体返回、写 COMMITTED 之前完成**；engine 整体返回后才写 COMMITTED。当前源码尾操作即 best-effort（只告警不抛）；实现阶段 coordinator 接线不得把任何尾操作挪到 COMMITTED 之后（防「已 commit 但尾操作失败」缺口）。
- **release 的 terminal guard（验证-only，不决定）**：Environment Lock 可对外提供 `beforeRelease / terminalGuard(operationId) => { isTerminal: boolean }` 钩子，**只验证** `isTerminal(operationId) === true`：
  - `false` → **拒绝正常 release / surface invariant violation**（`EnvironmentLockReleaseViolationError`），由上层 coordinator 处理；
  - **guard 绝不自行选择 COMMITTED / ROLLED_BACK / NEEDS_ATTENTION**（那些是 recovery 决策，不是锁的职责）。
- **Coordinator 正常路径**：acquire → reconcile existing active → create journal → execute（WAL）→ validate → **写 durable terminal（COMMITTED / ROLLED_BACK / NEEDS_ATTENTION）** → 请求 lock release → guard 通过。
- **Coordinator 异常路径**：coordinator `catch` → persist error（redact）→ 执行策略 → **写 durable terminal** → 请求 release。
- **Coordinator 无法 durable terminal**：**不把「猜一个 terminal」当解决办法** → 报 **fatal recovery-required condition**（`RECOVERY_REQUIRED`，§12），不释放锁语义上的「干净终结」（宁可留 stale + non-terminal journal 由下次显式 recovery 处理，也绝不伪造终结态）。
- **Process crash** 不依赖 guard：finally 不执行 → OS 关闭 handle → ownership record 保持 stale → non-terminal journal → **由下一次显式 recovery 处理**（§8.3）。
- 禁止：`release lock → 再写 COMMITTED`（另一 mutation 可能已开始）。
- crash 在 commit 写入前、全部 step done 后：reconcile 判定所有 step done + 无未决 → 视同可安全标记 RECOVERED（或用户显式确认 commit），不得自动当「未完成」重做（否则非幂等重复）。

### 7.1 Release Invariant（终态优先于释放，Rev 3 明确化）
- **正常路径**：`durable terminal journal` **BEFORE** `Environment Lock release`。Coordinator 保证 `COMMITTED | ROLLED_BACK | NEEDS_ATTENTION` 已 durable。
- **Environment Lock release guard 只验证** `isTerminal(operationId) === true`；`false` → refuse normal release / surface invariant violation（**不自行选 COMMITTED/ROLLED_BACK/NEEDS_ATTENTION**）。
- **Coordinator 无法 durable terminal** → 报 fatal recovery-required（不伪造终结态）。
- **Process crash**：OS release handle + stale ownership + non-terminal journal → 下一次显式 recovery 处理（不依赖 guard，也不指望 finally）。

---

## 8. Reconciliation Algorithm（startup reconciliation 确定性算法）

### 8.1 单步恢复证据判定（本地可指纹 step）
```
currentFp = hash(target 当前内容)   # 读磁盘
if currentFp == beforeFp:   step 未应用 → 判未执行（可安全 redo / 保留）
if currentFp == afterFp:    step 已应用 → 判完成
else:                       混合/未知 → step 记 attention
```
> **仅对文件类 step 可做指纹判定**。且为覆盖 Windows 无目录 fsync 的 rename 顺序失效（§16），**对标注 `done` 的文件类 step 也一律重验 afterFp**（若与磁盘不符 → 视为未可靠完成，回退为未 done 处理），不得因 journal 写 done 而跳过磁盘验证（Recovery/Windows Review P1 已并入）。
>
> settingsNamespace / patchLine / workspaceRecord **不可指纹**（非文件原子写）。**对这类不可指纹 step：一律视为「无法证明」→ 不自动整 op 回滚（否则会把已完成 op 误回滚，与 §9 resume 冲突）**；reconcile 将其判为 `attention`，最终走 NEEDS_ATTENTION 由用户确认（Crash-Adversary P1 已并入）。设计**v1 不给 adapter 补指纹能力**——避免扩大实现面，宁可 NEEDS_ATTENTION 保守。
> `afterFp` 准确性依赖 adapter 能精确复现写入结果（merge/normalize/path mapping 会影响）；若 adapter 无法稳定提供 → 该 step 归为不可指纹。（Crash-Adversary P2 已并入。）

### 8.2 整体 reconcile 决策表（operation 级）
| 状态组合 | 决策 |
|---|---|
| 无任何 step 应用（`steps[].status` 全部 planned + 磁盘无变化 + snapshotId 可为 null） | → **RECOVERED（no-op）**，安全丢弃，不进入 SAFE MODE（Crash-Adversary P1「snapshotId=null 假 NEEDS_ATTENTION」已并入） |
| 所有文件类 step done（含 afterFp 重验通过）且无 external 未决 | → RECOVERED（补写 done + 视同 commit） |
| 有未完成 step，但快照有效 + **所有未完成 step 均为可指纹本地 step** | → ROLLED_BACK（调用 rollback(snapshot)；**此动作需用户确认，见 §9/§13——不自动执行破坏性回滚**，Security P1-4 已并入） |
| 有不可指纹 step（settings/patchLine/workspace）未决 | → **NEEDS_ATTENTION**（无法证明，需用户确认；**绝不自动整 op 回滚**，Crash-Adversary P1 已并入） |
| 有 external step（插件/远端）未决 | → **NEEDS_ATTENTION**（**绝不自动 cleanup/回滚外部**，§10/§9，Crash-Adversary P0 已并入） |
| 快照缺失（真不存在）/ journal 损坏 / reconciliation 反复失败 | → NEEDS_ATTENTION |

### 8.3 reconcile 顺序（由 `MutationTransactionCoordinator`，§11 驱动）
1. **启动时序**（Recovery Review P0-1 已并入）：coordinator 的启动 reconcile **必须在任何 scheduler.start()/backupScheduler.start() 之前完成**（宿主 apply() 中，coordinator 挂在与 lock 构造同处、makeRoutes 之前；两 scheduler 的启动触发 runOnce 由 SAFE MODE/RECOVERY_REQUIRED 门禁拦截，见 §12）。
2. **只读事务状态 + 锁状态扫描（不自动 recover，Rev 3 P1-NEW-2 已并入）**：启动**只读地** scan `transactions/active/*.json`（读 metadata）检测 incomplete journal，并 `inspectLockState()`：
   - `LOCKED`（fresh heartbeat，活跃 owner）→ 不 reconcile（只读报告 / 等待；不自锁）。
   - **`STALE_LOCK_DETECTED`**（crash 后 owner 已死）→ 置 `RECOVERY_REQUIRED` + **SAFE MODE**（§12）；**不自动 recover stale lock、不执行 destructive mutation**。向用户展示：previous destructive operation crashed、stale owner identity、operation type、journal operationId、snapshot availability、recovery recommendation。**用户显式确认**（GUI「Recover previous operation」/ CLI `--recover-stale-lock` / 专用 `recover-transaction <operationId>`）后：**prove stale → `recoverStaleLock()`（显式动作，prove dead + quarantine）→ acquire → reconcile**。
   - **`UNKNOWN_STATE`**（heartbeat 过期 + PID 存活但无法取 OS identity，Windows 常见）→ **SAFE MODE + 不 recover + manual diagnostics**（用户显式 `--recover-stale-lock` 或人工确认才可继续）。
   - > 这**保持 Phase 2 的 explicit stale ownership policy**（L-INV-4/L-INV-5：detect 只分类、recover 是独立显式动作）。Phase 3 **不把「有 journal 证据」当作「仍是 explicit」** 来偷偷 automatic takeover。（Rev 3 P1-NEW-2 已并入。）
3. scan `active/` 下 **仅 `<uuid>.json`**（忽略 `.dshcm.*.tmp` 残留，Windows Review P1-3）non-terminal journal；**terminal journal 也 move 到 `completed/`**（Crash-Adversary P1）。
4. 对每个 INCOMPLETE op：更新 `state=RECOVERING` + `recovery.attemptedAt`。
5. 逐 step 判定（§8.1）→ 汇总 → 按 §8.2 决策。**reconcile 内执行的 ROLLED_BACK 必须复用 reconcile 已持 token（nested，parentContext，不 reacquire）**，且 rollback 前/中重验锁所有权（`validate(token)` / 磁盘 ownership instanceId）——若 ownership 被别进程接管 → 立即中止 rollback（Crash-Adversary P1）。
6. 写 terminal state（RECOVERED / ROLLED_BACK / NEEDS_ATTENTION）+ `recovery-history/` 事件（**best-effort：写失败仅记日志，不阻断 reconcile 收敛**，Recovery P2-3）。
7. move 到 `completed/`（复用 `renameWithRetry` 有界重试；move 失败不得对已 terminal op 强制 NEEDS_ATTENTION，Windows/Recovery P2）。
8. **NEEDS_ATTENTION** → 禁止后续 destructive（§12）；否则 release lock，并解除 SAFE MODE / RECOVERY_REQUIRED（若曾因本 op 置位）。scheduler 才可启动。

### 8.4 recover 循环防护
- **区分「真 reconcile crash」与「瞬时 IO 错误」**：瞬时错误（磁盘满写失败、EACCES、move 失败）**不消耗 `recovery.attempts`**，重试；只有「reconcile 自身被 kill/crash 进程中断」才计数（Crash-Adversary P1 已并入）。
- `recovery.attempts` 上限（如 3）：超过仍未到 terminal → 强制 NEEDS_ATTENTION，**不无限重试**（防止 reconcile 与外部进程相互卡死）。
- **corrupt journal 不消耗 attempts**：走 §13 quarantine。
- 每次 reconcile 前重读磁盘（不依赖上次缓存）。

---

## 9. Resume vs Rollback Policy（§13）

> 默认：**能证明 → 可自动（恢复/回滚都先经用户确认破坏性动作）；不能证明 → 保守阻断 mutation，NEEDS_ATTENTION**。

| 场景 | 策略 |
|---|---|
| 所有文件类 step 可判 done（afterFp 重验通过），缺 commit | **Resume**（补 done + RECOVERED；不重做已完成副作用，防非幂等重复） |
| 有未完成 step，快照完整 + **全部未完成为可指纹本地 step** | **Rollback**（回滚到导入前；**破坏性动作需用户确认**——不因 journal「看起来合法」而自动 rollback，Security P1-4 并入） |
| 有不可指纹 step（settings/patchLine/workspace）未决 | **NEEDS_ATTENTION**（无法证明；**绝不自动整 op 回滚**——避免把已完成 op 误回滚，Crash-Adversary P1 并入） |
| 插件外部 half-install（`readInstalled` 有 / `readInstalledVersion` 缺） | **NEEDS_ATTENTION**（**绝不自动 cleanup**——`cleanupAbortedInstall` 会无条件 `rmSync(node_modules/<pkg>)`，可能删掉完整安装）
| 插件外部反向/Update 场景（node_modules 有 manifest 无；或 v1→v2） | **NEEDS_ATTENTION**（**绝不自动 cleanup/回滚到未装**——会丢失可用 v1；需用户决策：重跑 install / 保留 / 人工处理，Crash-Adversary P0 并入） |
| 远端 push（Git/WebDAV）crash | **NEEDS_ATTENTION**（远端无 journal 可回放，绝不自动重推覆盖） |
| reinstall crash | **NEEDS_ATTENTION**（DSH 可探测，人工决定；.reinstall-backup 兜底） |
| 快照缺失 / journal 损坏 / 证据互相矛盾 | **NEEDS_ATTENTION**（绝不猜） |

> **不要默认所有 crash 都 rollback**：已确认完成且一致的 op 应 resume 而非重做；**插件/远端/不可指纹 step 一律 NEEDS_ATTENTION**（绝不自动清理/回滚外部副作用——`cleanupAbortedInstall` 与外部 ACID 假设已被 Crash-Adversary 实证为数据破坏源）。

---

## 10. External Side-Effect Policy（§18 外部副作用策略）

对插件 / Git / WebDAV / reinstall：
1. **记录 intent**（journal 登记 planned step，external=true），但不把「intent 存在」当「完成」。
2. **事后一致性探测**（平台无关）：
   - 插件安装一致性：**双向判定，四态全定义**（Crash-Adversary P0 已并入）：
     - `readInstalled`（manifest 声明）有 ∧ `readInstalledVersion`（node_modules 落盘）有 → **已装完成**（判 done）
     - manifest 有 ∧ node_modules 缺 → **半装态（真启动风险）** → 记 attention，**不自动 cleanup**
     - manifest 无 ∧ node_modules 有 → **反向残留**（可能完整安装但未注册）→ 记 attention，**不自动 cleanup（绝不删 node_modules）**
     - manifest 无 ∧ node_modules 无 → **未安装**（无副作用，安全丢弃该 step）
     - Update（v1→v2）半装 → **回滚目标是 v1（`snapshot.beforePlugins` 证据），不是「未装」**；无法恢复 v1 → NEEDS_ATTENTION
   - Git 滞留 commit：`git status`/`diff` 检查 work copy ahead。
   - WebDAV 孤儿/截断：`list index` 检查 `<id>.json` 是否被引用 + parse 校验。
   - DSH program：`dsh --version` 可探测。
3. **无法证明 → NEEDS_ATTENTION**，**绝不做自动回滚/自动 cleanup 外部/远端**（无事务 id 不可回滚；`cleanupAbortedInstall` 无条件 rm 会删完整安装，已实证）。
4. 可安全重放的外部分支（如 reinstall 的某个幂等 install 命令）**不自动重放**——仍 NEEDS_ATTENTION 由用户显式决定，避免无人值守触发网络/全局副作用。

---

## 11. MutationTransactionCoordinator（Rev 3，P1-NEW-1 已并入）

> **职责分离铁律**：Environment Lock = mutual exclusion primitive（acquire / validate token / heartbeat / release）。**Transaction recovery 全部进 `MutationTransactionCoordinator`**（或等价 abstraction）。**禁止把 recovery policy / NEEDS_ATTENTION decision / fingerprints 塞进 `env-lock.ts`。**

### 11.1 Coordinator 职责链
```
coordinator.acquire(GLOBAL lock)          # 经 EnvironmentLockPort.acquire（不碰 journal）
  → reconcileActive()                     # 每次 acquire 前置：scan active/ + 有残留先 reconcile（TX-P0-2）
  → createJournal(operationId)            # 写 CREATED（Journal→Lock 单向绑定：存 ownerInstanceId + lockId，不回填 ownership）
  → createSnapshot → state SNAPSHOT_CREATED（snapshotId 写 journal）
  → 跨检 snapshot-integrity（TX-P1-5）
  → execute operation（WAL，§6）          # engine 逐 step：INTENT → side-effect → DONE
  → validate
  → writeDurableTerminal()                # COMMITTED / ROLLED_BACK / NEEDS_ATTENTION（recovery 决策在此层）
  → moveJournal(active→completed)
  → requestLockRelease()                  # Environment Lock 的 guard 只验证 isTerminal（§7）
```

### 11.2 Lock ↔ Journal 关系（单向）
- **Environment Lock**：`ownerInstanceId`、`lockId`、**immutable ownership record**（不存/不改 journalId）。
- **Journal**：`operationId`、`ownerInstanceId`、`lockId`。
- **关系：Journal → Environment Lock**（不是双向）。active transaction uniqueness 由 **GLOBAL lock + `transactions/active/*.json` scan** 共同保证（单 op）。

### 11.3 active≤1 强制执行（TX-P0-2/TX-P2-2）
- **每次 acquire 锁成功后、创建新 op 前**，先检查 `active/` 是否已有非 terminal journal——有则先 reconcile（进程内残留也在 acquire 前置扫掉），确保任何时候 `active/` 至多一个有效 op。

### 11.4 注入面
- Coordinator 依赖最小 `MutationLockPort`（acquire/validate/release，env-lock.ts:160）+ 可注入 `EnvironmentLockManager` 提供的**验证-only `terminalGuard`**（§7）。Coordinator 不修改 lock 内部。
- engine（`executeImportPlan` / `restore()` / profile-switch）由 coordinator 包装，engine 自身 lock-free（与 Phase 2 host-boundary gate 一致）。

### 11.5 rollback 线程 operationId + 回滚 WAL（TX-P1-4）
- `rollback()` 接收显式 `operationId`/`lockContext`（复用同一 op 的 journal + token，nested）；在线回滚也走 journal（ROLLING_BACK → 每补偿一项记 `rollback.entryDone` → ROLLED_BACK）；crash 在回滚中 → reconcile 从回滚 WAL 判定已补偿/未补偿，避免对条件幂等 rollback 双 unset/重复。
- `MutationContext` 携带 `operationId`（Phase 2 预留，CROSS_PROCESS_LOCK_DESIGN.md:196）——nested rollback 复用同一 operationId。

---

## 12. SAFE MODE / RECOVERY_REQUIRED / Mutation Blocking（§12）

> **Rev 3 启动模型（P1-NEW-2 已并入）**：
> ```
> Host initialize → init EnvironmentLockManager → coordinator read transaction state
>   → 无 incomplete transaction → start normal host → scheduler.start
>   → 有 incomplete transaction：
>       → RECOVERY_REQUIRED / SAFE MODE
>       → scheduler destructive run BLOCKED
>       → expose recovery UI / CLI
>       → 用户显式确认 recovery（GUI / --recover-stale-lock / recover-transaction <opId>）
>       → 若 provably stale → recover stale ownership（显式）
>       → acquire → reconcile → terminal → clear SAFE MODE → scheduler may start
> 不得：scheduler.start → reconcile；
> 也不得：startup silently recover stale owner → continue。
> ```

- **`RECOVERY_REQUIRED`**：发现 incomplete journal + `STALE_LOCK_DETECTED`/`UNKNOWN_STATE` 时置位（§8.3 step 2）——**进入 SAFE MODE，不自动 recover stale lock，不执行 destructive**。展示恢复推荐、等用户显式确认。
- **`NEEDS_ATTENTION`**：reconcile 无法证明终态时置位（§8.2）——阻断新 destructive，需用户显式处理。
- 任一置位 → **SAFE MODE**：
  - 允许只读：inspect / 导出诊断 / list snapshots / preview / reconcile 查看。
  - **阻止**：任何新的 destructive mutation（M1–M14 全部），**直到用户显式确认**（GUI 弹窗 / CLI 显式 flag）。
- **阻断实现（注入谓词，不污染 env-lock，Phase2-compliance 再评审已并入）**：`isSafeMode()`/`isRecoveryRequired()` 门禁**经依赖注入谓词**挂入 `withMutationLock`/`runWithMutationLock`（如 `withMutationLock(port, opts, { isBlocked?: () => boolean })`，由 coordinator 注入），**而不是在 env-lock.ts 内 import journal/reconcile/recovery policy**——这样 env-lock.ts 保持零 recovery-policy 引用（符合 §11/§18.1 铁律）。该谓词覆盖 `runWithMutationLock`（内部走它）与 **autosync runOnce 直调 `withMutationLock`（autosync-scheduler.ts:269）**，从而阻断含 autosync 的全部 destructive（Recovery Review P1-1）。
- **门禁豁免**：coordinator 内部的 recovery 动作（reconcile / ROLLED_BACK 回滚）**豁免于 SAFE MODE**——recovery 非「新的 destructive mutation」，否则 coordinator 会被自己的 SAFE MODE 卡死（Recovery Review P1-2）。
- **durable 标记**：写 `transactions/safe-mode`（atomicWrite）跨重启保持阻断（§20.2）。
- **逃生通道**：SAFE MODE 提供「view diagnostics / quarantine & dismiss / 用户显式确认恢复」动作，避免单个坏 journal 永久锁死（Security P2-1，§14）。
- **不为 UX 自动猜结果继续**。

---

## 13. Corrupt Journal Handling（journal 损坏）

- journal 文件 parse 失败 / schema 不符 / **与当前 lock 的 Journal→Lock 绑定不匹配**（`journal.ownerInstanceId/lockId` 无法对到任意 active lock，见 §2/§11）→ **不猜**：
  - **quarantine（隔离）**：把 corrupt journal **move 到独立 `transactions/quarantine/<op>.json`** + 写 sidecar `quarantine/<op>.needs-attention` 标记（Recovery Review P1-5 已并入）——**不尝试原地改写 state**（corrupt 无法 parse，也无法以合法 terminal 状态 move 到 completed/）；由此 `active/` 不残留反复重扫的 corrupt 文件，`recovery.attempts` 计数也不被 corrupt 烧掉。
  - 保守按 NEEDS_ATTENTION（SAFE MODE）并提示用户检查 `transactions/quarantine/<op>.json`。
  - 若 quarantine 的 journal 对应**真实存在且完整的快照**，可向用户提议「用快照整 op 回滚」（破坏性动作）——**需显式用户确认，不自动**（Security P1-4 并入）。
- **不做自动「丢弃损坏 journal 继续」**；SAFE MODE 提供「quarantine & dismiss」逃生通道（§12/§15）。
- 每个 corrupt journal 只 quarantine 一次（幂等：已存在的 quarantine 目标不重复 move）。

---

## 14. Retention（保留策略）

| 目录 | 策略 |
|---|---|
| `active/` | reconciliation 后清空（move 到 completed）；遗留（crash 未 reconcile）由下次 startup 处理 |
| `completed/` | 保留 N（如 50）个最近 terminal journal；超限删最旧（atomic，fs.rm force） |
| `recovery-history/` | 保留 M（如 200）条，超限删最旧（审计用，append-only） |

---

## 15. Security（§14 / AGENTS.md 安全章）

> 威胁模型：同机同用户恶意进程 / 恶意导入内容（与 Design §0「本地可信进程写、非安全边界」一致）跨用户/远程不纳入（0600/0700 已覆盖他 OS 用户）。以下为**强制要求**（Security Review P1-1~P1-4 已并入，非可选）：

- journal 权限 0600 / 目录 0700。
- **不存 secret**：只存 hash/ref/path/ids/元数据。错误文本 `error` 与 `recovery.reason` **过更强的 `scanAndRedact`/`redactValue`（含 high-entropy 档）而非仅 `redact()`** —— 因 `redact()` 只覆盖敏感字段名形态 + 已知值形状（sk-/JWT/AKIA/ghp_/PEM/Bearer），普通随机 hex/字母数字 secret 会漏；`recovery.reason` 不得假设「非敏感」。（Security P1-1 已并入本行。）
- **路径防御**：operationId 只允许 UUID 形态（防穿越作为文件名）；active/completed 内路径不做 join 越界。**reconcile/rollback 的目标解析一律经 `isWithinHome` 守卫的 `homeAbs`/`resolveFileAbs`（restore.ts:158-168,184-186），绝不直接信任 `journal`/`step.ref` 拼路径**（`resolveFileTarget` 自身无含性校验，backup.ts:90）；step ref 仅作恢复提示，恢复以快照 blob + 磁盘探测为准。（Security P1-2 已并入本行。）
- **篡改防御（防自动破坏性 rollback）**：journal 非安全边界。reconcile 校验 `ownerInstanceId` 与 lock 一致、`environmentFingerprint` 匹配本机；**且 reconcile 触发的 ROLLED_BACK（破坏性动作）一律要求显式用户确认**（与 §13 corrupt journal 对齐，不因 journal「看起来合法」而自动回滚）；journal 的 `snapshotId` **必须校验为该 operation 自己创建的快照**（status/所有权绑定），杜绝指向任意历史快照。（Security P1-4 已并入本行。）
- **symlink（强制）**：journal 写强制 `atomicWriteFile(…, { symlink:'reject' })`（sensitive 语义）；reconcile 读 journal 前 **lstat 校验非 symlink（非可选）**；并校验 `transactions/`、`active/` 目录本身非 symlink。（Security P1-3 已并入本行。）
- **SAFE MODE 逃生通道**：被隔离/损坏 journal 提供「quarantine & dismiss」动作移出 `active/`（避免单个坏文件永久锁死用户，见 §12/§14）。（Security P2-1。）
- **environmentFingerprint 组成**：`hash(hostname + 持久化 per-install 随机 token)`；token 存 dataDir 0600，重启稳定、跨机不同（避免本机重启误 NEEDS_ATTENTION）。（Security P2-2。）
- **边界上界**：同用户篡改残余风险的上界取决于 P1-2 的 `isWithinHome` 守卫；该守卫必须在 reconcile/rollback 边界**强制**（不能只在 restore 实现）。

---

## 16. Windows / POSIX Behavior（§20）

- **承诺等级**：crash-consistency（process crash / kill -9 后 journal 与目标均为 old-or-new 完整）。**Windows 不承诺 power-loss rename durability**（无目录 fsync）——与 Phase 1 一致。
- journal 更新复用 atomicWriteFile：POSIX 得父目录 fsync 强 durability；Windows 跳过（crash-consistency）。
- recover 探测与指纹计算平台无关（读文件 + sha256）。
- **done 文件 step 也重验 afterFp（Windows Review P1-2 已并入）**：Windows 无目录 fsync 下「journal-done 落盘 + target 仍是旧内容」的 rename 顺序可能翻转；reconcile 对 done 文件 step 一律重验 afterFp，避免断电后目标停在旧内容却报告 RECOVERED。
- `active/` 扫描**只认 `<uuid>.json`，忽略 `.dshcm.*.tmp` 残留**（Windows Review P1-3 已并入）——tmp 永不是完整 journal，扫描不得把残留 tmp 当损坏 journal。
- journal 写/读复用 atomicWriteFile（POSIX 父目录 fsync 强 durability；Windows 跳过 crash-consistency）；symlink 强制 reject（§15）。
- journal move（active→completed/quarantine）**复用 `renameWithRetry` 的有界重试**（Windows EBUSY/EPERM；Windows Review/Recovery P2 已并入）。
- 失败注入测试用**真实 child process** 模拟 process death（复用 env-lock.test.ts 的 spawn 范式，§17）。**Windows kill 语义**：无 SIGKILL（TerminateProcess，exit code 非信号），且 kill 引擎 child 后其 spawn 的插件孙进程（runDshPlugin）在 Windows 无进程组默认下**存活为孤儿**——测试必须显式清理/断言孤儿孙进程，避免污染后续测试或真实环境（Windows Review P2-2 已并入）。

---

## 17. Failure Injection Plan（§19）

> 复用 env-lock.test.ts 的「可注入 io + 真实 child-process」范式（env-lock.test.ts:81-120 + spawn 跨进程用例）。

**Crash injection points（真实 child process 模拟 kill，不用 throw）**：
```
CRASH_AFTER_LOCK_ACQUIRE
CRASH_AFTER_JOURNAL_CREATE
CRASH_AFTER_SNAPSHOT
CRASH_BEFORE_STEP            # stepN 副作用前
CRASH_AFTER_SIDE_EFFECT_BEFORE_STEP_DONE   # 关键：磁盘已改、journal 未标 done
CRASH_AFTER_STEP_DONE
CRASH_DURING_VALIDATION
CRASH_BEFORE_COMMIT
CRASH_AFTER_COMMIT_BEFORE_RELEASE
CRASH_DURING_ROLLBACK
CRASH_AFTER_ROLLBACK_BEFORE_TERMINAL
```
**测试方法**：child process 在指定注入点（经环境变量 / 注入钩子）`process.kill(process.pid, 'SIGKILL')` 或 `process.exit(1)` 自杀/被杀；父测试进程随后**重新初始化 engine → run reconcile**，断言 reconcile 决策（RECOVERED / ROLLED_BACK / NEEDS_ATTENTION）与磁盘终态。**必须用 child-process（kill 不执行 finally）**，不能只 `throw`。

---

## 18. Test Plan（§19/§21）

- **unit**：journal schema 读写 / 状态机迁移 / reconcile 单步判定（beforeFp/afterFp）/ retention / SAFE MODE 门禁。
- **failure injection**：§17 每个节点，child-process 真实 kill 后 verify reconcile。
- **idempotency 回归**：reconcile 幂等（重跑 reconcile 不重复副作用）；rollback 幂等。
- **external**：插件半装态探测（readInstalled vs version）、WebDAV 孤儿、Git 滞留（mock transport 探测）。
- **Windows**：journal atomicWrite（mode/权限/无 dir fsync）+ 有界重试；child-process kill（Windows 强制结束）验证。
- **security**：journal 无 secret；路径穿越；symlink；篡改（改 ownerInstanceId/指纹 → 拒恢复）。
- **regression**：全量 `npm test` ≥ 1176 + Phase 3 新增用例；typecheck；build。
- 新增文件建议：`src/core/journal.ts`（+`journal.test.ts`）、`src/core/reconcile.ts`（+`reconcile.test.ts`）、`src/core/transaction-coordinator.ts`（+`.test.ts`）、可能 `src/ui/errors.ts` 扩展（NEEDS_ATTENTION/RECOVERY_REQUIRED 展示，可选）。

### 18.1 Rev 3 Mandatory Consistency Tests（强制，P0-NEW-1 / P1-NEW-1 / P1-NEW-2）
1. **environment.lock bytes/inode 在整个 Phase 3 transaction 生命周期不变**（immutable ownership）。
2. **创建 journal 不修改 ownership record**（无回填写）。
3. **`journalId` reserved field 保持 unused/null**（Phase 3 v1 不写）。
4. **Journal→Lock 绑定校验**：`journal.ownerInstanceId === currentLock.owner.instanceId` AND `journal.lockId === currentLock identity`。
5. **transaction exception**：coordinator 先写 durable terminal 再请求 release（异常路径 terminal-before-release）。
6. **terminal persistence failure**：lock 层 / guard **不自行发明 NEEDS_ATTENTION**（只报 invariant violation / fatal recovery-required）。
7. **env-lock.ts 不 import journal / reconcile / transaction policy**（职责分离，编译层验证）。
8. **process crash**：finally 未执行 → non-terminal journal + stale ownership 保持，不被自动终结。
9. **startup stale + incomplete journal** → SAFE MODE / RECOVERY_REQUIRED；**`recoverStaleLock()` 不被自动调用**。
10. **explicit user recovery**：用户确认后 prove stale → recover → acquire → reconcile。
11. **UNKNOWN_STATE** → 不 recover → SAFE MODE。
12. **scheduler 在 RECOVERY_REQUIRED 期间不能 destructive-run**。

> 补充（Recovery 再评审）：13. **尾操作（快照状态标记 / vault 回填）必须先在 execute 步完成、engine 整体返回后才写 COMMITTED**——实现阶段禁止把任何可抛错尾操作挪到 COMMITTED 之后，杜绝「已 commit 但尾操作失败」。（§7 不变量。）

---

## 19. Scope Exclusions & Phase 4 Boundary（§10/§26/§27）

### In scope（本 Phase）
- 可证明恢复的本地 mutation：import-apply / restore / profile-switch / sync-apply / autosync-apply（这些共用 createSnapshot + applyItem 引擎）。
- journal + reconcile + SAFE MODE + 外部 intent/探测 + failure injection。

### Out of scope（明确不做）
| 禁止项（§26） | 理由 |
|---|---|
| 不创建 Phase 3 源码 | 本文件是 Design，等 Review GO |
| 不自动 rollback / resume（仅在 reconcile 内实现，属实现阶段） | Design 只定策略 |
| 不实现 SAFE MODE（只定策略） | 同上 |
| orphan `.dshcm.*.tmp` sweep | Phase 1 follow-up（PHASE2_HANDOFF §6），非本 Phase |
| **Phase 4：pre-upgrade 自动 snapshot / 版本迁移产品功能** | 独立阶段，Phase 3 不得扩展成 upgrade detector / package upgrade hook / version migration |
| 增量备份 / 会话迁移 / 无关重构 | 非本 Phase |
| 远端事务化（Git/WebDAV 真事务） | 无事务 id，不可能；只记录 intent + NEEDS_ATTENTION |

**Phase 4 边界红线**：journal 内的 `snapshotId` 仅用于「本 op 的回滚点」，**不用于**「升级前自动快照」；reconcile 只处理「destructive op crash」，**不处理**「DSH 升级前」事件。

---

## 20. Open Design Decisions（实现前待定）

> 以下原属 Open 项，经 Design Review 已定稿（标注「已定稿」）；剩余为真正待定项。

1. **不可指纹 step 的指纹能力**（原 Open）→ **已定稿**：v1 **不给 adapter 补指纹能力**；settings/patchLine/workspace 一律视为「无法证明」→ reconcile 判 NEEDS_ATTENTION（**不自动整 op 回滚**）。（并入 §8.1/§9。）
2. **`isSafeMode()` 存储**（原 Open）→ **已定稿**：**durable** 到 `transactions/safe-mode`（atomicWrite），跨重启保持阻断（并入 §12/§15）。
3. **operationType 覆盖范围**：本期 journal 覆盖 M1/M2/M4/M6/M7-apply；**backup 也可 journal**（低成本，产物 durable 判定，Crash-Adversary P2 backup 重复 ZIP 由此解决）；push/reinstall 记 intent。**待实现时确认 backup 产物的存在性/指纹判定机制**（ZIP 存在 + writeConfig lastRun 一致性）。
4. **`afterFp` 的获取方式**（新）：文件类 step 的 afterFp 由 engine 在 applyItem **之后从磁盘重读一次**计算（不依赖 adapter 确定性复现）；若读不到/无法稳定 → 该 step 归为不可指纹。（并入 §8.1 TX-P1-2。）
5. **profile-switch 的 step 集合/活动 profile 判定**（Crash-Adversary P2）**待实现时细化**：switch 的「活动 profile」由 profile 激活文件/目录探测，需在实现前再确认其可探测性。
6. **terminal journal 的 active/→completed move 时机**（Crash-Adversary P1）：reconcile 每次也 move 遗留 terminal；正常 release 前由 engine move。**待实现定稿**（不阻塞门禁）。

---

## 21. 实现顺序建议（Design Review 通过后的实施次序）

1. `journal.ts`：schema + storage（active/completed/quarantine/recovery-history）+ state machine 纯函数（node 可测）。
2. **`MutationTransactionCoordinator`（P1-NEW-1）**：`transaction-coordinator.ts` 职责链（acquire → reconcileActive → createJournal → WAL → terminal → move → request release）。**env-lock.ts 保持只做 acquire/validate/heartbeat/release + 验证-only terminalGuard，不 import journal/reconcile policy。**
3. `reconcile.ts`：单步指纹判定（含 done 重验 afterFp）+ 整体决策 + corrupt quarantine + SAFE MODE/RECOVERY_REQUIRED 门禁 + **stale 显式 recovery 流程（不自动 recover）**。
4. **active≤1 前置 reconcile + active 清扫**（TX-P0-2）：新 op 创建前检查 active/ 非空。
5. **release 验证-only terminal guard**（TX-P0-1 / P1-NEW-1）：协调层保证 terminal-before-release；lock guard 只验证。
6. **rollback 线程 operationId + 回滚 WAL**（TX-P1-4）：`rollback()` 接收 operationId/context，回滚逐项记 entryDone。
7. 引擎接线：`executeImportPlan` / `restore()` / profile-switch 由 coordinator 包装（WAL）+ snapshot-integrity 跨检。
8. host `apply()` 挂钩 coordinator 启动 reconcile（持锁后、scheduler.start() 前）。
9. `atomic write` 补强（若需）：pnpm-workspace.yaml 原子化（plugins-adapter.ts:201，非原子缺口）。
10. **Rev 3 mandatory consistency tests**（§18.1 全 12 项）+ failure injection + 全量回归（≥1176 基线 + 新增）。
11. UI（可选）：NEEDS_ATTENTION / RECOVERY_REQUIRED / SAFE MODE 提示。

---

## 22. 自检：Design 必须回答的问题清单（逐条覆盖）

- 哪些状态必须 durable？— CREATED→…→COMMITTED/ROLLED_BACK/RECOVERED/NEEDS_ATTENTION（§3）
- 状态写在 side effect 前还是后？— **前**（WAL intent-before-effect，§6）
- crash 在 journal update 前怎么办？— 指纹判定单步（§8.1）
- crash 在 side effect 后、journal update 前怎么办？— 指纹判 done（§8.1）
- 判断 step 是否执行？— beforeFp/afterFp 对比（§8.1）
- 记录 planned steps？— `plannedSteps` + acquire 时全量登记（§5/§6）
- 记录 completed steps？— `steps[].status`（§4）
- 记录 checksum/fingerprint？— `beforeFp/afterFp`（§4/§8.1）
- 记录 pre-state？— `snapshotId` + `beforeFp`（§4）
- 记录 snapshotId？— 是（§4）
- 记录 operationId？— 是（§4）
- 记录 lock owner/lockId？— ownerInstanceId + lockId（§4）
- 记录 app/package version？— packageVersion（§4）
- 记录 environment identity？— environmentFingerprint（§4/§15）
- WAL → 外部/插件/远端分别需要什么 recovery evidence？— 本地=指纹；插件=半装态探测；远端=探测+NEEDS_ATTENTION（§8/§10）
- atomicWriteFile 返回错误语义？— throw = target 未变（crash-consistency），Windows 无 dir fsync（§0/§16）
- 启动入口 / lock / stale / incomplete journal / corrupt journal 处理？— §7/§8/§13
- SAFE MODE / mutation blocking？— §12
- Resume vs Rollback policy？— §9
- journal↔lock 关系？— §11
- **release 是否保证 terminal？** — 是：Coordinator 保证 terminal-before-release；lock guard 只验证（§7/§7.1/§11）
- **是否每次 acquire 前置 reconcile/active 清扫？** — 是（Coordinator 每次 acquire 前置，非仅启动）（§11）
- **插件外部 step 是否自动 cleanup？** — 否，一律 NEEDS_ATTENTION（§9/§10）
- **stale lock 如何 reconcile？** — **显式 recoverStaleLock（不自动接管）**；startup 只读检测→RECOVERY_REQUIRED/SAFE MODE→用户确认→显式 recover（§8.3/§12）
- **破坏性回滚是否需用户确认？** — 是（§9/§13/§15）
- **能否回填 environment.lock.journalId？** — **禁止**（immutable ownership，Journal→Lock 单向绑定）（§2/§5/§11）
- **Environment Lock 是否负责 transaction terminal 决策？** — **否**（MutationTransactionCoordinator 独立；guard 只验证）（§7/§11）
- Phase 4 边界？— §19

---

> 依 §25：本 Design 完成。下一步进行**独立 Design Review**（Transaction / Crash-adversary / Recovery / Windows / Security reviewer，READ-ONLY），产出 `CRASH_JOURNAL_DESIGN_REVIEW.md`，分类 P0/P1/P2，仅当 P0=0 且 unresolved P1=0 才 Implementation Gate=GO。
