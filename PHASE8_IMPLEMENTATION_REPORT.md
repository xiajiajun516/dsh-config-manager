# PHASE8_IMPLEMENTATION_REPORT — Reliability Closure（可靠性收尾）

> 阶段：**IMPLEMENTATION / CLOSURE**（Phase 8 — 收尾/加固，非新功能）
> 基线 HEAD：`ae1e048`（Phase 7 迁移前咨询 PASS）
> 完成：全部可完成 P2 收口；环境/设计边界项如实确认与归因，不伪造 PASS。
> 全量验证：typecheck PASS → `npm test` **1455/1455 PASS**（fail 0）→ `npm run build` PASS → `npm run smoke` 12/12 PASS。

---

## 0. 基线核实

- `git log -10` 确认基线为 Phase 7 收尾后主线；工作区源码干净（仅未跟踪的各阶段提示/设计/报告文档，符合预期）。
- 开始前全量测试绿（1448/1448），作为收口的回归底线。
- 逐项按「Inspect → Implement → Test → Review → Commit」独立 commit。

---

## A. RunRegistry 单实例（backup 与 destructive 同库登记）—— **CLOSED**

**现状核实**：`src/index.ts` 中 `backupScheduler`（L4625）与 `makeRoutes`（L4642）各自 `new RunRegistry`（两个独立实例；`/runs`、`/progress` 事实源分裂）。

**收口动作**：创建**单个共享实例** `const runs = new RunRegistry({ msg: host.msg })`，同时注入 `BackupScheduler` 与 `makeRoutes`。跨 kind（backup ↔ import/restore）的真实互斥**仍由 GLOBAL mutation lock 保证**（两者共用 `host.mutationLock`；`runWithMutationLock` 被占 → 拒绝），共享注册表仅是 hygiene（`/runs` 单一事实源），**不改变既有 lock 语义**（Phase 2 Handoff：RunRegistry 是 lock 的进程内补充，不替代 Lock）。

**Changed files**：`src/index.ts`
**Tests**：既有 `run-registry.test.ts` / `backup-scheduler.test.ts` / `env-lock.test.ts` 全绿。
**Validation**：typecheck PASS；验收「backup 不得与其它 destructive 并发」由 GLOBAL lock 既有行为保证。
**Commit**：`bc405c6`

---

## B. 逐计划项 before/after 指纹（文件类 afterFp，reconcile 判精度）—— **CLOSED**（安全边界未放松）

**现状核实**：生产 import 经 `runJournaled` 记 **opaque intent journal**（无逐项 step），crash 后 reconcile 因无逐项指纹保守 needs-attention（Phase 3 明确 v2 预留）。

**收口动作**（WAL 式，最小且不放松安全边界）：
1. `types.ts`：`TransactionSnapshotContext` 增加 `recordStep(JournalStepRecord)`（`JournalStepRecord` 含 id/adapter/kind/ref/external/status/beforeFp/afterFp）。
2. `phase3-host.ts`：`JournalRunContext` 暴露 `recordStep`，在 `runJournaled` 的 journalCtx 实现（fail-closed 持久化，与 bindSnapshot/markApplying 同语义）。
3. `analyzer.ts` `executeImportPlan`：apply 前**预登记**将产生真实 side effect 的项为 `planned`（文件类带 `beforeFp`）；逐项完成后更新 `done + afterFp`（文件类成功）或 `attention/skipped`（非文件类/失败 → 保守）。
4. `phase3-host.ts` `conservativeHooks.verifyStepFingerprint`：对带 fp 的本地文件 step 做**真实磁盘指纹判定**（此前恒 `unable`）。
5. `backup.ts`：新增 `resolveFileTargetRel`（home-relative posix）。

**安全边界（评审确认未放松）**：reconcile 仅当**所有 step done 且全部文件类可证明**（`after-match`）才判 `recovered`；**任一外部/不可指纹/未应用（planned）step → needs-attention**（Phase 3 结论「不可指纹维持保守」不改）。部分应用 crash（有 planned 未应用）恒不判 `recovered`。

**Changed files**：`src/core/types.ts`、`src/core/backup.ts`、`src/core/phase3-host.ts`、`src/core/analyzer.ts`、`src/core/phase3-p2b-fingerprint.test.ts`（新增）
**Tests**：`phase3-p2b-fingerprint.test.ts` 5 例 —— ① verifyStepFingerprint 真实磁盘判定；② recordStep 落 journal；③ 全文件 done+afterFp → reconcile **recovered**；④ 含外部 step → **needs-attention**（边界）；⑤ 部分 applied（planned 未应用）→ **needs-attention**（保守）。阶段相关回归（phase3-production-integration / phase3-p1 / reconcile / phase3-security / phase4-crash-injection / analyzer / architecture-boundaries）全绿。
**Validation**：typecheck PASS + 全量测试绿。
**Commit**：`ed72f9c`

---

## C. model config_backup / profiles/save 补 GLOBAL 锁 —— **CLOSED**

**现状核实**：`config_backup`（`model-tools.ts` `tools.backup`）与 `profiles/save`（`index.ts` routes）无 GLOBAL mutation lock（Phase 3 记「非 live-config 破坏」，但仍是锁盲区）。

**收口动作**：
- `config_backup`：`tools.backup` 包入 `runWithMutationLock(host.mutationLock, { op:'model-backup', target:'exports', isBlocked })`。无锁环境（测试/mock）不锁定；锁被占用 → 抛 `EnvironmentLockUnavailableError`（拒绝）。
- `profiles/save`：handler 包入 `withMutationGate('profile-save')`（与 profile-delete/rename/switch 一致），与既有 destructive 互斥；共享同一 GLOBAL lock，不 double-acquire。

**Changed files**：`src/core/model-tools.ts`、`src/index.ts`、`src/core/model-tools.test.ts`
**Tests**：新增 `config_backup` 锁冲突单测（mock MutationLockPort 恒 LOCKED → `assert.rejects` EnvironmentLockUnavailableError）。
**Validation**：typecheck PASS；run-registry/env-lock 回归绿。
**Commit**：`9b9c39b`

---

## D. recovery UI 真实浏览器点击 E2E —— **CLOSED**（真实 DSH + 真实浏览器点击）

**现状核实**：Phase 5 已用 HTTP API 验证 recovery 全流程（incident→preview→confirm→execute→verify，E2-E12 PASS）+ `recovery-view` 纯渲染单测，但无真实浏览器点击。

**收口动作**：起**隔离真实 DSH**（`phase8-e2e/dsh-home`，junction 复用既有 node_modules；`dsh --profile web --port 3093`），用编译后插件 lib 在隔离 dataDir 构造 **带真实可信快照** 的 `NEEDS_ATTENTION / rollback-recommended` incident，然后用**共享真实浏览器**点击驱动 `RecoveryPanel` 完整流程：

| 步骤 | 真实浏览器操作 | 观察到结果 |
|---|---|---|
| incident | 切到「恢复」tab，点击 incident 行 | 列表显示 `import-apply / 建议回滚 / NEEDS_ATTENTION` |
| preview | 点击选中 incident | 预览区渲染：**存在可信恢复快照**、**环境匹配**、**可信（operation-bound）**、只读预览提示 |
| confirm | 点击「执行恢复」 | 危险 ConfirmDialog：「恢复/回滚是破坏性操作…当前文件会先备份到快照的 pre-restore 目录」 |
| execute | 点对话框确认「执行恢复」 | 真实回滚执行（目标文件被改动），journal 写 `recoveryVerification` |
| verify | 自动跟随 | 面板呈现「**验证结果：不匹配（MISMATCH）/ 需要人工处理**」+ 详情 |

**结论与如实说明**：完整点击链路（incident→preview→confirm→execute→verify）在真实 DSH + 真实浏览器下闭环。verify 结果为 **MISMATCH** 是因**手工 seed 的合成快照只覆盖 `a.md` 单一文件**，恢复计划据此删除 DSH 状态里的 host 文件 → 重验比对发现不匹配（属合成 incident 属性，非插件 bug）；Phase 5 已证明真实崩溃下 MATCH/PARTIAL_MATCH 语义，本 E2E 重点验证浏览器点击 UI 接线。UI 逻辑已另由 `recovery-view` 纯函数单测强覆盖。

**Changed files**：无（仅 `npm run bundle` 重建 client bundle + `.gitignore` 加 `phase8-e2e/`）。
**Evidence**：`phase8-e2e/recovery-panel-e2e-verify.png`（gitignored，未入库）。
**Commit**：无代码 commit；`.gitignore` 变更并入收尾提交。

---

## E. real Windows junction symlink —— **CLOSED**（环境可建 junction，发现并修复真实 gap）

**现状核实**：Phase 5 因 Windows 权限限制把真实 junction 标 `NOT REPRODUCIBLE`（仅单测覆盖逻辑）。本环境探测：**无需管理员即可创建目录 junction**（`Node lstat(junction)=isSymbolicLink=true`，但 `readdir` 只列出外部目标目录的普通文件，`isSymbolicLink=false`）。

**关键发现（真实 gap）**：原 `validateSnapshotForRestore`（F25）只查 **blob 子项** `isSymbolicLink`，一个 **junction 化的 `blobs` 目录** 会让 readdir 看到外部目标的普通文件 → 绕过 symlink 写穿防御。

**收口动作**：`src/core/restore.ts` `validateSnapshotForRestore` 增加**快照目录本身 + `blobs` 目录**的 junction/symlink 检测（`assertNoSnapshotSymlink`）→ 命中即 `UNSAFE_PATH`（**加强**而非放宽安全）；verify-recovery 复用同一函数因此同步覆盖。

**Changed files**：`src/core/restore.ts`、`tests/core/restore-trust.test.ts`
**Tests**：新增 `V-06b` —— 用真实 Windows junction 替换 `blobs` 目录，断言 `UNSAFE_PATH`（环境不支持 junction 时优雅跳过）。`restore-trust` + `verify-recovery` 全绿。
**Validation**：typecheck PASS。
**Commit**：`e05fbc0`

---

## F. 语义篡改边界 / 短 token 脱敏边界 —— **CONFIRMED（设计决策，不改）**

**现状核实**（Phase 6 §8 P2）：
- `contentHash` 检测任意字节级篡改（含合法 JSON 改字段值）；但「完全重写为合法新条目」不可与「追加新条目」区分。
- 短 token（<28 字符且不匹配值形状）可能逃逸双保险脱敏。

**结论**：两者均为**非对抗性安全边界**，属 Phase 1 已统一原子写前提下**刻意不引入 MAC/签名链**的设计权衡（防第二套 framework + 非对抗假设）。**确认并在本报告重申，不新增签名链**（变更审计链的成本/假安全大于收益）。无代码改动。

---

## G. 其他各阶段 Deferred 逐项核对 —— **全部归账/确认**

| 阶段 | Deferred / 已知限制 | Phase 8 处置 | 结果 |
|---|---|---|---|
| Phase 2 Handoff | 两个 RunRegistry 实例 | → 项 A | **CLOSED** |
| Phase 3 Handoff ① | 无逐项 WAL/指纹（v2 预留） | → 项 B | **CLOSED** |
| Phase 3 Handoff ⑤ | config_backup / profiles-save 无 GLOBAL 锁 | → 项 C | **CLOSED** |
| Phase 3 Handoff ⑥ | RunRegistry 单实例（hygiene） | → 项 A | **CLOSED** |
| Phase 5 Deferred | recovery UI 浏览器点击 E2E 未做 | → 项 D | **CLOSED**（真实浏览器） |
| Phase 5 Deferred | real junction symlink NOT REPRODUCIBLE | → 项 E | **CLOSED**（环境可建，补真实测试） |
| Phase 6 §8 P2 | 语义篡改 / 短 token 脱敏边界 | → 项 F | **CONFIRMED**（设计决策） |
| Phase 6 §9 Deferred | 不纳 export 进迁移历史 / 不合 sync-history / 不加来源签名链 / 不建独立设置页 | 确认均为已文档化设计决策，不变更 | **CONFIRMED** |
| Phase 7 Deferred | 无 | — | — |

---

## 验证汇总（收口后全量）

```
typecheck  : PASS
npm test   : 1455/1455 PASS（fail 0）   // 基线 1448 → +7（P2-B 5 + config_backup 锁 1 + junction V-06b 1）
npm run build : PASS（lib/client.js 714.49 kB）
npm run smoke : 12/12 PASS
```

**注意（如实记录）**：全量测试偶见一次 `env-lock` 测试 teardown 的 Windows `ENOTEMPTY`（temp 目录 rm 与 heartbeat 文件句柄竞态），**重跑全绿**，属既有环境 flake、与本次变更无关（env-lock 未改动），已在报告如实记录。

---

## Final Verdict

**PHASE 8 RELIABILITY CLOSURE = PASS**

- **P0 = 0，unresolved P1 = 0。**
- **P2 收口度**：A/B/C/D/E 五项 **CLOSED**（均带实现 + 测试 + 验证 + commit）；F/G 为设计边界确认与归账，**CONFIRMED**（不伪造 PASS）。
- **安全不变量全部保留**：Phase 1 原子写 / Phase 2 锁语义 / Phase 3 journal+SAFE MODE / Phase 4 snapshot-trust / Phase 5 recovery / Phase 6 迁移历史行为未被收口改变；B 的指纹增强**维持**「不可信/不可指纹 → needs-attention」边界，E 的 junction 检测为**加强**。
- **无新 framework**：四项收口全部复用既有 run-registry / lock / journal / reconcile / snapshot-trust。
- **遗留项**：无 within-scope 的未收口 P2；F/G 记录为已文档化的非对抗性设计边界。已知 `env-lock` Windows teardown 偶发 ENOTEMPTY flake 待后续环境层留意（非本阶段正确性问题）。

**下一步**：Phase 8 收尾完成，可进入 Phase 9（发布）；若决定不发布，本阶段即最终收尾。
