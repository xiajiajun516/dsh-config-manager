# CROSS_PROCESS_LOCK_DESIGN_REVIEW — Phase 2：Design Review（Rev 3 评审）

```
PHASE 2 STATUS: DESIGN（Rev 3）
PREVIOUS REVIEWS: NO-GO → Rev 2 关闭 BLOCKER 1/2/3 → 本轮关闭 BLOCKER 4
THIS REVIEW: 见 Implementation Gate（§8）
```

- **评审对象**：`CROSS_PROCESS_LOCK_DESIGN.md` Rev 3
- **日期**：`2026-08-29`
- **原则**：只有全部 BLOCKER（1–4）CLOSED 才允许 **Implementation Gate = GO**。GO 后才修改源码。只实施 Phase 2。完成后生成 Implementation Report + PHASE2_HANDOFF，然后停止，不进入 Phase 3。

---

## 1. BLOCKER Closure Report

### 1.1 BLOCKER 1 — ownership lock 禁止被 atomicWriteFile 替换 → **CLOSED**

**原问题**：设计同时声明「FileHandle 是 ownership token」与「heartbeat 用 `atomicWriteFile(lockPath)` 更新 metadata」——二者冲突。`atomicWriteFile` 经 rename 替换 pathname 对应 inode，会破坏句柄=所有权的凭证，且可能覆盖他人重建的新 owner。

**修订内容（Design §3.2, §6.1）**：
- `locks/environment.lock` 定为 **immutable ownership record**：`open('wx')` 一次性写入 owner 后**直到 release 不再 rename/replace**。
- **heartbeat 使用独立 sidecar** `locks/environment.heartbeat.<instanceId>`，可安全用 Phase 1 `atomicWriteFile` 更新（不同文件名，rename 不触碰 ownership path identity）。
- 明确四保证：
  1. ownership path identity 生命周期稳定（同一 inode 直到 release）；
  2. heartbeat replacement 不影响 ownership（不同文件）；
  3. release 只删除自己拥有的 ownership record（§7 校验 instanceId）；
  4. heartbeat cleanup 按 instanceId 匹配，不误删下一 owner 的 metadata。

**BLOCKER 1 判定：CLOSED**（语义冲突已消除，ownership 与 heartbeat 物理分离）。

### 1.2 BLOCKER 2 — stale takeover protocol 现在确定 → **CLOSED**

**原问题**：把 "stale takeover 实现时再设计" 留到 Implementation。

**修订内容（Design §6.3, §6.5）**：
- **stale 检测（detection）与 stale recovery 严格分离**：
  - 程序化 `acquire` 返回三态：`ACQUIRED` / `LOCKED`（owner healthy）/ `STALE_LOCK_DETECTED`（definitely stale）。
  - **检测路径绝不 unlink**。`STALE_LOCK_DETECTED` 不是删除许可。
  - 无法证明 stale（OS identity 缺失/探测失败）→ `UNKNOWN_STATE`，**保守拒绝 recovery**。
- **NO AUTOMATIC STALE TAKEOVER（v1 定稿）**：
  - 默认禁止自动 unlink + takeover。
  - 禁止把 `check → unlink → acquire` 包装成看似安全的自动 takeover。
  - **允许** CLI 显式动作 `--recover-stale-lock`：独立、用户触发、显式确认；只执行 inspect → prove stale → defined recovery。
  - recovery 采用**原子 rename 捕获 + 二次验证**协议（rename 到 `environment.recovering.<myInstanceId>`，验证仍是同一 stale inode 后 unlink），确保不删 rename 之后新 owner 的文件。
  - 若团队坚持自动 takeover：必须在 Design 给出可证明不删新 owner 的 CAS/fencing protocol + 正式并发证明 + 测试计划，评审通过后才启用。**v1 不启用。**

**BLOCKER 2 判定：CLOSED**（protocol 现已在设计中确定，且 v1 采用保守的 no-auto-takeover + 显式原子 recovery）。

### 1.3 BLOCKER 3 — 删除 destructive `--force` → **CLOSED**

**原问题**：设计含 `--force` 可绕过活锁执行 destructive mutation。

**修订内容（Design §4.6, §6.5, §10）**：
- **`--force` 已删除**：不存在 `--force → ignore active lock → destructive mutation`。
- CLI 提供 `--recover-stale-lock`（非 `--force`），只能 inspect / prove stale / defined recovery，**不能绕过活锁**。
- **NON-NEGOTIABLE（§10）**：**destructive mutation 必须成功获得 Environment Lock，否则不得执行。** lock 被占用 → 默认失败 / 跳过 / 409，无绕过路径。

**BLOCKER 3 判定：CLOSED**（`--force` 移除，destructive 强依赖成功 acquire）。

### 1.4 BLOCKER 4 — 禁止 process-level reentrant Environment Lock → **CLOSED**

**原问题**：Design Rev 2 §4.3 提议「同一 instanceId + 同一 lock handle 可 re-enter」。同一 Web Host/CLI Host 内两个并发 destructive operation（import 与 restore）共享同一 `instanceId`，若仅因 process instance 相同就允许 re-entry，Operation B 会绕过锁与 A 同时 mutation。

**修订内容（Design §3.4, §4.2, §4.3）**：
- **改为 operation-scoped `MutationLockToken`**：`EnvironmentLockManager.acquire()` 成功返回 token，**只属于当前 mutation 调用链**。
- 公共 mutation entry **没有 token → 必须 acquire**；内部 nested mutation **显式接受 parent token → validate → reuse held ownership → 不 reacquire**。
- **禁止实现**：`owner.instanceId === myInstanceId → reentrant`、`this.lockHandle != null → reentrant`、进程级 `reenterCount`。
- **进程身份只能用于 diagnostics / stale detection / release ownership validation**，不能判断 async operation 归属。
- **显式 context propagation（非 AsyncLocalStorage）**：可测试、调用关系明确、不把独立 async 误判为 nested；Phase 3 可扩展为 `MutationContext`（lockToken / operationId / journalId / snapshotId，后三者预留）。
- 调用签名：`executeImportPlan(plan, { lockContext? })` / `rollback(..., { lockContext })` / `applyMergePlan(..., { lockContext? })` / `executeRestorePlan(..., { lockContext? })`。
- token 生命周期：只属一次 acquire；release 后失效（test #22）；foreign token 不得绕过（test #21）。

**同步修订**：
- **stale detection 正式状态表**（heartbeat fresh → LOCKED / expired+PID死 → STALE / expired+PID活+identity异 → STALE / expired+PID活+identity同 → LOCKED / probe 不明 → UNKNOWN_STATE：不删、不 recover、destructive 不执行）。
- **IO error 分类**：`EEXIST` → inspect owner；`EPERM/EACCES` → 检查 lock 是否存在，存在则 inspect，否则 `LOCK_IO_ERROR`/`PERMISSION_ERROR`（不当 LOCKED 上报）。
- **recovery 二次验证失败**：禁止无条件 rename 回 `environment.lock`（避免覆盖 successor）；保留 quarantine `environment.recovering.*`、返回 validation failure、人工清理。

**BLOCKER 4 判定：CLOSED**（operation-scoped token 取代进程级 reentrant；状态表 / IO 分类 / recovery quarantine 已定稿）。

---

## 2. Global Lock Scope（最终列表）

**Phase 2 v1 采用单把 GLOBAL EXCLUSIVE MUTATION LOCK（`locks/environment.lock`）**，不做 resource-level concurrency optimization。原则：**Read-only 不锁；Canonical / persistent mutation 默认全部锁。**

**GLOBAL 覆盖**：
- import apply（M1）
- restore（M2）
- parent rollback（M3，**继承父 lock：显式接收 parent `MutationLockToken`，不独立 reacquire**）
- profile switch（M4）
- profile delete（M5）
- profile rename（M5）
- sync apply（M6）
- autosync mutation（M7）
- manual sync push（M8，v1 纳入）
- snapshot delete（M9）
- snapshot prune（M10，共享父 lock）
- backup（M11，v1 纳入）
- CLI restore（M13）
- CLI reinstall（M13）
- Model Tools destructive mutation（M14）

**不含 Environment Lock**：`market/cache` cleanup、`market/work` cleanup（§4.5 拆分）；`exports` cleanup 走 mtime 跳过 recent 兜底（不引入 EXPORTS_LOCK hierarchy）。

**Read-only（不锁）**：全部预览/分析/列出/状态读操作。

---

## 3. Stale Detection vs Stale Recovery（明确区别）

| 维度 | Stale Detection（检测） | Stale Recovery（恢复） |
|---|---|---|
| 触发 | `acquire` 遇 EEXIST 时自动做（程序化） | 用户显式 CLI `--recover-stale-lock` + 确认 |
| 动作 | **只分类，绝不 unlink** | 原子 rename 捕获 + 二次验证后 unlink |
| 输出 | `LOCKED` / `STALE_LOCK_DETECTED` / `UNKNOWN_STATE` | 成功则移除 stale inode + 清 heartbeat |
| 是否破坏安全 | 无副作用 | 仅删「被捕获且二次验证确认 stale」的 inode |
| 自动性 | — | **非自动**（用户触发） |

---

## 4. Ownership File 与 Heartbeat Sidecar 最终结构

```
<dataDir>/locks/
  environment.lock                     # immutable ownership record（open('wx') 一次性写入，到 release 不替换）
  environment.heartbeat.<instanceId>   # heartbeat sidecar（atomicWriteFile 更新，文件名绑定 instanceId）
```

- `environment.lock` 内容：owner（instanceId / instanceStartedAt / pid / hostname / osProcessStartIdentity）+ op / target / acquiredAt / lockVersion / journalId（预留）。
- heartbeat sidecar 内容：ownerInstanceId + heartbeatAt + seq；文件名含 instanceId → 新旧 owner 天然隔离。
- **heartbeat 更新绝不触碰 `environment.lock`**。

---

## 5. Release Ownership Validation

- release 前**读回 `environment.lock` 校验 `owner.instanceId === this.instanceId`**。
- **匹配** → 先 `close()` 再 `unlink(environment.lock)`（Windows 要求），随后清理自己的 heartbeat sidecar。
- **不匹配** → **不 unlink**，返回/记录 `ownership-lost` invariant violation（防御异常恢复/人工修改/未来 stale recovery）。
- 不提供裸 `close() → unlink` 而不验证的路径。

---

## 6. Reviewer 异议 / 处理

| # | Reviewer 异议 | 处理结果 |
|---|---|---|
| R1 | heartbeat 与 ownership 冲突 | BLOCKER 1 关闭：sidecar 分离 |
| R2 | stale takeover 留到实现 | BLOCKER 2 关闭：now 确定，no-auto-takeover + 显式原子 recovery |
| R3 | destructive `--force` | BLOCKER 3 关闭：删除，destructive 强依赖成功 acquire |
| R4 | Backup / Sync push 是否纳入 GLOBAL | v1 直接纳入 GLOBAL（评审定稿），有性能证据再放宽 |
| R5 | cache cleanup 别扩大 Env Lock 职责 | 拆分：market/cache、market/work 不锁；exports 走 mtime 跳过 recent，不引入 hierarchy |
| R6 | processStartTime 命名误导 | 改 instanceStartedAt（应用层时间戳）；PID reuse 只看 osProcessStartIdentity；取不到 → 保守拒 recovery |
| R7 | heartbeat 不能更新 ownership | 已用 sidecar；degraded lease 语义已定义（不中断 mutation、无自动删） |
| R8 | release 需验证 pathname 归属 | 已加 instanceId 校验 + ownership-lost violation |
| R9 | RunRegistry 两实例 | 保留分层；建议共享单实例（hygiene，不替代 Lock） |
| R10 | orphan tmp | 不在 v1 强制；若实现则锁内 + 三证明 |
| R11 | process-level reentrant 不安全 | BLOCKER 4 关闭：operation-scoped `MutationLockToken`，禁止 instanceId/handle/reenterCount 判嵌套 |
| R12 | IO error 分类 | 已加 `EEXIST`→inspect；`EPERM/EACCES`→存在则 inspect / 否则 `LOCK_IO_ERROR`/`PERMISSION_ERROR` |
| R13 | recovery 二次验证失败 | 已加 quarantine：不 rename 回 `environment.lock`、不覆盖 successor |

---

## 7. Implementation Gate

四个 BLOCKER 状态：

- **BLOCKER 1（ownership 不可 replace）：CLOSED**
- **BLOCKER 2（stale takeover 现在确定）：CLOSED**
- **BLOCKER 3（删除 destructive `--force`）：CLOSED**
- **BLOCKER 4（禁止 process-level reentrant / operation-scoped token）：CLOSED**

> 四个 BLOCKER 全部 CLOSED。

### **Implementation Gate = GO**

**Gate 条件**：
- [x] BLOCKER 1–4 全部 CLOSED
- [x] Global Lock Scope 最终列表已定（单 GLOBAL lock，覆盖全部 destructive）
- [x] stale detection 与 stale recovery 严格分离（无自动 takeover；UNKNOWN_STATE 不执行）
- [x] operation-scoped `MutationLockToken`（禁止进程级 reentrant）已定
- [x] ownership file 与 heartbeat sidecar 结构明确（immutable ownership + sidecar lease）
- [x] release ownership validation 已定义（instanceId 校验）
- [x] IO error 分类已定义（EPERM/EACCES 不当 LOCKED）
- [x] recovery 二次验证失败的 quarantine 行为已定义（不覆盖 successor）
- [x] 明确不支持项已列出（multi-host / NFS / lock hierarchy / force / auto-takeover / Journal / fencing）
- [x] 测试计划补齐（§11 含 BLOCKER 4 token 测试 §11.1b + 评审要求的 12 项）

> **GO 后**：实施 Phase 2（`src/utils/env-lock.ts` + 接入 M1–M11, M13–M14 + 测试），完成后生成 Implementation Report + PHASE2_HANDOFF，然后停止，不进入 Phase 3。

---

## 8. Design / Review Consistency Check

| 检查项 | Design | Review | 一致 |
|---|---|---|---|
| ownership 不可被 replace | §3.2 | §1.1 | ✅ |
| stale takeover now 确定（no auto） | §6.3/§6.5 | §1.2 | ✅ |
| 删除 destructive `--force` | §4.6/§6.5/§10 | §1.3 | ✅ |
| operation-scoped token | §3.4/§4.2/§4.3 | §1.4 | ✅ |
| stale 正式状态表 | §6.3 | §1.4 | ✅ |
| IO error 分类（EPERM/EACCES） | §8.1 | §1.4 | ✅ |
| recovery quarantine（不覆盖 successor） | §6.5 | §1.4 | ✅ |
| Global Lock Scope 单锁覆盖全 destructive | §3.3/§1.2 | §2 | ✅ |
| release ownership validation | §7 | §5 | ✅ |
| 测试计划（token + BLOCKER 要求） | §11 | §6 | ✅ |
| Scope Exclusions | §10 | §2 | ✅ |

### **DESIGN / REVIEW CONSISTENCY: PASS**

---

*Rev 3 设计评审确认 BLOCKER 1–4 全部 CLOSED，Design/Review 一致（PASS）。Implementation Gate = GO，可直接进入 Phase 2 Implementation。完成 Implementation 后：full regression + child-process concurrency + failure injection + Windows validation + independent review + `CROSS_PROCESS_LOCK_IMPLEMENTATION_REPORT.md` + `PHASE2_HANDOFF.md`，然后停止。禁止进入 Phase 3。*
