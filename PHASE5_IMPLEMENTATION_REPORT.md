# PHASE5_IMPLEMENTATION_REPORT — Phase 5 Recovery & Rollback Engine

> 阶段：**IMPLEMENTATION**（Phase 5 — Recovery & Rollback Engine）
> 依据：`RECOVERY_ROLLBACK_DESIGN.md`（Design Review = GO）、`PHASE5_ANALYSIS.md`（Analysis = COMPLETE）、`PHASE5_DESIGN_REVIEW.md`、当前源码。
> 基线：Step 2/3/4 已完成（commit `9b1c752` / `5441c86` / `6862fff`），`1339/1339` tests PASS。
> 本报告如实记录 Step 5–15 的实现、验证、发现与新问题，不把未验证项标为 PASS。

---

## 1. Implementation summary

Phase 5 完成 **Recovery & Rollback Engine** 的完整实现闭环：

- **Step 2–4（既有）**：recovery 核心（journal 校验 + 决策引擎）、post-recovery verification、recovery API 编排。
- **Step 5**：集成加固 —— 审查验证 recovery 路由接线（无 double-journal / 不被 SAFE MODE 阻断 / 权威 snapshotId / operation-bound / RECOVERING 不自动 RECOVERED）。
- **Step 6–8（本阶段新增）**：引导式 Recovery UI（RecoveryPanel + recovery-view 纯渲染模型 + RecoveryPort 契约 + recovery-api）、client 状态集成（run-store `PanelId='recovery'` + RecoveryStoreSlice）、i18n（recovery-locales，zh 源 / en 镜像）。
- **Step 9–12（本阶段新增）**：recovery 核心测试扩充（hard gate PARTIAL_MATCH/VERIFICATION_ERROR）、crash-window 测试（C1–C7）、API 边界测试（400/404/缺失快照等）。
- **Step 13**：**真实 DSH E2E（E1–E13 全 PASS）** —— 过程中发现并修复 2 个 Step 4 接线 P1。
- **Step 14**：真实 tamper 安全 E2E（篡改快照 → CORRUPT 拒绝）。
- **Step 15**：最终验证（typecheck / test / build 全绿）+ 本报告。

---

## 2. Step-by-step changes

### Step 5 — Integration Hardening（接线审查，无生产代码改动）
验证 recovery 路由接线（index.ts / recovery-orchestrator.ts / reconcile.ts 协同）：
- **无 double-journal**：recovery 路由用 `runWithMutationLock`（Phase 2 锁），**禁用 `withMutationGate`**，复用被恢复 operation 的现有 journal，不新建 journal（源码 `index.ts:4034-4047`）。
- **不被 SAFE MODE 阻断**：recovery 路由**不传 `isBlocked`**（recovery 是解除 SAFE MODE 的机制，被阻断会死锁；`index.ts:4035` 注释明示）。
- **权威 snapshotId 只来自 `journal.snapshotId`**：orchestrator 全程 `j.snapshotId`，路由不读 `request.snapshotId`/`body.snapshotId`/`query.snapshotId`。
- **operation-bound**：confirm/execute/verify/retry 强制 `validateSnapshotForRestore` + `requireOperationBound=true`。
- **RECOVERING 不自动 RECOVERED**：reconcile `§6.5` 硬门控（`RECOVERING` + 无 `recoveryVerification` 或 verdict 非 MATCH/PARTIAL_MATCH → `needs-attention`）。
- 现有 orchestrator 级集成测试已覆盖上述属性（`tests/core/recovery-api.test.ts`）。

### Step 6 — Recovery UI
新增（`src/client/recovery/`）：
- `recovery-api.ts`：实现 `RecoveryPort` 契约（status/preview/confirm/execute/verify/retry/dismiss），POST 恒带 `userConfirmed`。
- `recovery-view.ts`：纯渲染模型（UI 状态分类 NORMAL/RECOVERY_REQUIRED/ROLLBACK_RECOMMENDED/ROLLBACK_CONTINUE/RECOVERING/MATCH/PARTIAL_MATCH/MISMATCH/VERIFICATION_ERROR/NEEDS_ATTENTION；verdict 映射；snapshot 可信判定；incident/preview 渲染模型）。
- `RecoveryPanel.tsx`：引导式工作流（incident 列表 → preview → 显式确认 ConfirmDialog(danger) → execute → verify → 最终状态；验证失败后 retry/dismiss）。**不自动 execute/rollback、不隐藏确认、不把 PARTIAL_MATCH 当完全成功、不把 NEEDS_ATTENTION 当 recovered**。
- `ConfigManagerSection.tsx` 新增「恢复」tab；`client/index.ts` 注册 `config-manager-recovery` locale + 注入 `recoveryApi`/`recoveryT`；`client-types.ts` 扩展注入面。

### Step 7 — Client State Integration
`run-store.ts`：
- `PanelId` 增加 `'recovery'`；新增 `RecoveryStoreSlice`（status/preview/verifyResult/selectedOperationId/error/actionError + `running`）。
- `running` 为**内存切片瞬态**：`toPersistedState` 白名单剔除、`applyPersisted` 硬性归零 —— 刷新后 running=false，**不得因 UI reload 重复执行 recovery**（权威 = 宿主 `/runs`，`resume()` 重新发现）。
- `resume()`/`patchProgress()`/`applySettled()`/`applyGone()` 接入 `kind='recovery'`。

### Step 8 — i18n
新增 `recovery-locales.ts`（`config-manager-recovery` ns，zh 源 / en 镜像）：
覆盖 Recovery Required / Rollback Recommended / Recovery In Progress / Verification / Verified / Partial Match / Mismatch / Verification Error / Needs Attention / Preview / Confirm / Execute / Verify / Retry / Dismiss / Quarantine / Snapshot / Operation / Environment / Manual Action Required 等全部 state/verdict/action/error 文案，**无硬编码 recovery 文案**。

### Step 9 — Recovery Core Tests
- `reconcile.test.ts` 扩充：hard gate `PARTIAL_MATCH → proceed`、`VERIFICATION_ERROR → needs-attention`。
-（既有覆盖：state machine illegal transition、recomputeRecoveryDecision、authority。）

### Step 10 — Verification Security Tests
既有 `verify-recovery.test.ts` 综合覆盖：MATCH/PARTIAL_MATCH/MISMATCH/VERIFICATION_ERROR、blob/manifest substitution、corruption、wrong env/op、unsafe path、host target mismatch（内容/缺失/应删仍存在/plugin/settings）、非 operation-bound 拒绝。

### Step 11 — Crash Window Tests
新增 `tests/core/recovery-crash-window.test.ts`（C1–C7 + 补充）：
- C1 journal CREATED→crash→noop 不假成功；C2 snapshot durable→rollback-recommended / RECOVERING→needs-attention；C3 partial rollback→rollback-continue；C4 restore 完成未验证→needs-attention；C5 验证失败→NEEDS_ATTENTION 不 ROLLED_BACK；C6 验证成功→单次原子 update→ROLLED_BACK+recoveryVerification；C7 crash between calc & persist→fail-closed。
- 补充 C6b/C6c（SAFE MODE 清除/保留）+ C7b（execute 后 crash→retry/verify 可继续）。

### Step 12 — Recovery API Tests
`recovery-api.test.ts` 扩充：invalid operationId→400（全路由）、operation not found→404（全路由）、missing snapshot→400。

### Step 13 — Real DSH E2E（见 §6 单独章节）
**E1–E13 全 PASS**。过程中发现并修复 2 个 **P1**（见 §7）：
- **P1（环境指纹竞态）**：orchestrator 在 `makeRoutes` 时捕获 `recoveryEnvFingerprint`，而宿主在 fire-and-forget 异步块跑 `initFingerprint()`，未在路由创建前完成 → 捕获 'unknown' 初值 → 所有 recovery API 判 `WRONG_ENVIRONMENT`。**修复**：改动态 getter `getEnvironmentFingerprint: () => string`，API 调用时现取。
- **P1（SAFE MODE 未清除）**：verify 成功后只 `moveToCompleted`，未清除 durable SAFE MODE 标记与内存 `safeModeActive` → 破坏性操作持续被阻断（E12/E13 失败）。**修复**：verify 成功且无其他未解决 incident（NEEDS_ATTENTION 视为未解决）时，调用注入的 `phase3Recovery.clearSafeMode()`（同时重置内存标志 + durable 标记）。

### Step 14 — Real Crash/Security E2E（见 §6 单独章节）
真实篡改快照 → recovery preview 返回 `CORRUPT`，confirm 返回 400（fail-closed 拒绝）。

### Step 15 — Full Validation + Final Closure
见 §4/§9。

---

## 3. Architecture compliance（无第二套 framework）

| 约束 | 结果 | 证据 |
|---|---|---|
| **NO second lock** | ✅ 只使用 `withMutationLock`/`runWithMutationLock`（Phase 2） | `index.ts:4036`；无 recovery 专用 lock |
| **NO second journal** | ✅ 复用 `JournalStore` + 被恢复 operation 的现有 journal | `index.ts:1754`（禁 `withMutationGate`）；无 RecoveryJournal |
| **NO second transaction framework** | ✅ 复用 `runJournaled`/`runExternalIntent`/`executeRecovery`（reconcile.ts） | 无新 transaction coordinator |
| **NO second snapshot-trust** | ✅ 复用 `validateSnapshotForRestore` + `verifySnapshot` | `recovery-orchestrator.ts` / `verify-recovery.ts` |
| `requireOperationBound=true` | ✅ confirm/execute/verify/retry 强制 `TRUSTED_OPERATION_SNAPSHOT` | `recovery-orchestrator.ts` |
| 禁用 `withMutationGate`（avoid double-journal） | ✅ | `index.ts:4034` |
| 权威 snapshotId = `journal.snapshotId` | ✅ 客户端无法覆盖（API 结构上不接受 snapshotId） | `recovery-orchestrator.ts` |
| 不传 `isBlocked`（不被 SAFE MODE 阻断） | ✅ | `index.ts:4035` |

---

## 4. Core invariant verification

> **No recovery/rollback may be considered complete until the target state is verified to match the trusted snapshot, and every recovery action is journaled and fail-closed.**

五部分证明：

1. **VERIFIED**：`verifyRecovery`（`verify-recovery.ts`）在 verify 时刻重跑完整 `validateSnapshotForRestore`（TOCTOU 防护），磁盘重读 snapshot.json 为权威；verdict 映射 terminal 状态（`recoveryTerminalState`）。**reconcile `§6.5` 硬门控**：`RECOVERING` +（无 verification 或 verdict 非 MATCH/PARTIAL_MATCH）→ `needs-attention`，**绝不自动 RECOVERED**。测试：crash-window C2b/C4/C5/C7 + reconcile §6.5。
2. **JOURNALED**：每个 recovery 动作复用现有 `OperationJournal`（`RECOVERING` → `ROLLED_BACK`/`RECOVERED`/`NEEDS_ATTENTION`）；verify 的 `recoveryVerification` 写入 + 终态迁移为**单次原子 store.update**（`recovery-orchestrator.ts` verify 路由）。测试：C6 原子性。
3. **FAIL-CLOSED**：snapshot 不可信（CORRUPT/INVALID/UNSAFE_PATH/WRONG_ENVIRONMENT/WRONG_OPERATION）→ confirm/execute 400 拒绝；verify MISMATCH/VERIFICATION_ERROR → NEEDS_ATTENTION；crash 于 atomic update 前 → journal 保持 RECOVERING → reconcile needs-attention。测试：C5/C7、Step 14 tamper。
4. **TRUSTED**：只消费 Phase 4 trusted operation-bound snapshot；execute/verify 时重验 `requireOperationBound=true`，verify 重跑 `validateSnapshotForRestore`。测试：verify-recovery（substitution/corrupt/unsafe/legacy）。
5. **BEFORE DESTRUCTIVE SIDE EFFECT**：execute 真正开始时才 `NEEDS_ATTENTION → RECOVERING`，且执行器只收到 `j.snapshotId`（authority）。测试：recovery-api authority + 无 double-journal。

---

## 5. Test matrix

| 类别 | 文件 | 覆盖 |
|---|---|---|
| Recovery core（state machine / decision / authority） | `src/core/reconcile.test.ts`、`journal.test.ts` | NEEDS_ATTENTION→RECOVERING→ROLLED_BACK；illegal transition 失败；recomputeRecoveryDecision；hard gate |
| Post-recovery verification（security） | `tests/core/verify-recovery.test.ts` | MATCH/PARTIAL/MISMATCH/ERROR；blob/manifest substitution；wrong env/op；unsafe path；host target mismatch；legacy |
| Crash window（C1–C7） | `tests/core/recovery-crash-window.test.ts` | 各 crash 点 reconcile decision + 不假成功 + SAFE MODE 清除/保留 |
| Recovery API | `tests/core/recovery-api.test.ts` | 全路由 200/400/404/409；invalid op；missing journal/snapshot；authority；并发；no double-journal；dismiss |
| UI 纯渲染模型 | `src/client/recovery/recovery-view.test.ts` | 状态分类 / verdict 映射 / snapshot 可信 / actionable |
| Client 状态持久化 | `src/client/run-store.test.ts` | recovery running transient / status/preview/verifyResult 持久化 / resume |

**Test count**：基线 `1339` → 最终 `1370`，**delta +31**（+15 Step 6-8 客户端/recovery-view、+2 hard gate、+9 crash-window、+3 API 边界、+2 SAFE MODE 清除）。

---

## 6. Real DSH E2E（单独章节）

环境：隔离 `DSH_HOME=phase5-e2e/dsh-home`，web profile（端口 3082），插件 0.1.54（打包 0.1.55 tgz 部署），DSH 0.1.1-rc.2，Windows，Node v24。**绝对未污染真实用户 DSH_HOME**。

| 步骤 | 内容 | 结果 |
|---|---|---|
| **E1** | 安装当前插件（隔离 web profile） | ✅ 插件挂载，status ready:true/pluginVersion 0.1.54 |
| **E2** | 制造真实 destructive operation crash（构造 op-bound READY 快照 + 崩溃 journal NEEDS_ATTENTION + SAFE MODE） | ✅ crash 状态构造成功 |
| **E3** | 重启 DSH | ✅ 重启成功 |
| **E4** | 确认 RECOVERY_REQUIRED + SAFE MODE | ✅ SAFE MODE 激活；恢复 status 显示 incident |
| **E5** | 打开 Recovery UI（recovery API 可达） | ✅ `/recovery/status` 返回 incidents |
| **E6** | 确认 incident/operationId/snapshotId/environment | ✅ operationId=`aaaaaaaa-…-0003`、snapshotId=`a7c55708-…`、environmentFingerprint 匹配 |
| **E7** | Preview | ✅ snapshotVerdict=`TRUSTED_OPERATION_SNAPSHOT`、environmentCompatible=true |
| **E8** | 显式 Confirm | ✅ `{ok:true, verdict:TRUSTED_OPERATION_SNAPSHOT}` |
| **E9** | Execute | ✅ decision=rollback-recommended、state=RECOVERING、runId 返回 |
| **E10** | Verify | ✅ verdict=MATCH、terminal=ROLLED_BACK、details=[快照重验通过, host file 匹配, 插件状态匹配] |
| **E11** | 确认 MATCH → ROLLED_BACK | ✅ journal ROLLED_BACK + recoveryVerification=MATCH |
| **E12** | 确认 SAFE MODE 清除 | ✅ 无 incidents、durable safe-mode 标记移除 |
| **E13** | 正常 destructive operation 再次可用 | ✅ restore dry-run 正常返回计划 |

**Step 14 — 真实安全 E2E（独立）**：
- **Snapshot tamper**：篡改快照 blob → `/recovery/:op/preview` 返回 `snapshotVerdict=CORRUPT`、decision=needs-attention；`/confirm` 返回 HTTP 400。✅ 正确拒绝，无破坏性副作用。
- **Path traversal / Symlink**：由单元测试覆盖（`tests/core/restore-trust.test.ts`、`tests/core/verify-recovery.test.ts`）。真实 Windows **junction symlink** 受当前环境权限限制，标记 **NOT REPRODUCIBLE**（不作 PASS）。

---

## 7. Reviewer findings

### P0（0 个）
无。

### P1（2 个，均已在 Step 13 E2E 中修复）
1. **环境指纹竞态**（Step 4 遗留）：orchestrator 创建时捕获 `recoveryEnvFingerprint` 的 'unknown' 初值（宿主 `initFingerprint()` 在 fire-and-forget 异步块中，未在 `makeRoutes` 前 await）→ 所有 recovery API 判 `WRONG_ENVIRONMENT`。**修复**：`getEnvironmentFingerprint` 动态 getter。commit `e1f700e`。
2. **SAFE MODE 未清除**（Step 4 遗留）：verify 成功后未清除 durable SAFE MODE 标记与内存 `safeModeActive` → 破坏性操作持续阻断。**修复**：verify 成功且无其他未解决 incident 时调用注入的 `phase3Recovery.clearSafeMode()`。commit `e1f700e`。

### P2
- **Step 14 real symlink（junction）**：Windows 环境权限受限，未在真实 DSH 复现；单元测试已覆盖 symlink 拒绝逻辑（`validateSnapshotForRestore` / `verifyRecovery`）。标记 **NOT REPRODUCIBLE**，非 PASS 也非 FAIL。
- **recovery UI 的 E2E（浏览器交互）**：通过 recovery API 全流程验证 + UI 纯渲染模型单测覆盖；未做真实浏览器点击自动化（无组件测试框架，见 AGENTS.md「React 组件本身无组件测试框架，逻辑提炼到 src/ui/」）。UI 逻辑已在 `recovery-view.ts` 纯函数单测覆盖。

---

## 8. Deferred / limitations

- **recovery UI 真实浏览器点击 E2E**：未执行（项目无组件测试框架；逻辑沉淀至 `recovery-view` 纯函数并已单测）。
- **Step 14 真实 junction symlink**：`NOT REPRODUCIBLE`（Windows 环境限制；单元测试覆盖逻辑）。
- **Step 13 隔离环境部署波动**：pnpm 对同文件名 `file:` tgz 的缓存导致 E2E 环境重装时偶发 package.json/node_modules 异常，属测试环境脆弱性（非产品缺陷），最终通过更换 tgz 文件名解决。
- **recovery UI 的视觉**：复用现有 CSS 类（viewBody/card/groupLabel/statRow/snapshotList/…）与公共原语（Banner/Badge/Button/Card/Empty/SectionTitle/Spinner/ConfirmDialog），无新增视觉模式，故未改 DESIGN.md（符合 AGENTS.md「Missing Design Rule」）。

---

## 9. Final validation & verdict

```
npm run typecheck  → 0 errors (PASS)
npm test           → 1370/1370 PASS (PASS)
npm run build      → PASS
```

| 检查项 | 结果 |
|---|---|
| typecheck | ✅ PASS（0 error） |
| build | ✅ PASS |
| 全量 tests | ✅ PASS（1370/1370，delta +31） |
| 核心不变量（VERIFIED / JOURNALED / FAIL-CLOSED / TRUSTED / BEFORE SIDE EFFECT） | ✅ PASS |
| Real DSH E2E（Step 13 E1–E13 + Step 14 tamper） | ✅ PASS（无新 P0/P1；发现并修复 2 个既有 P1） |
| 架构合规（无第二套 lock/journal/transaction/snapshot-trust） | ✅ PASS |
| P0 | 0 |
| unresolved P1 | 0 |
| P2 | recovery UI 浏览器点击 E2E 未做、real junction symlink = NOT REPRODUCIBLE（非 PASS 项，已如实记录） |

**Final verdict：**

```
PHASE 5 IMPLEMENTATION = PASS
```

---

*完成时间：Phase 5 Step 5–15。Commit：`46e1a98`（UI/client/i18n）、`7711523`（tests）、`e1f700e`（E2E P1 fixes），承接 Step 2/3/4 `9b1c752`/`5441c86`/`6862fff`。*
