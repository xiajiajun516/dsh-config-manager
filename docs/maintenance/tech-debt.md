# 技术债台账

**怎么用**：这不是抱怨清单，而是**排期清单**。每条都必须能被代码或测试证明；修完把状态改成「已修」并写提交/测试名，
不要删行 —— 删行会让下一个人重新踩一遍。改代码时顺手把行号同步一下。

- 最后核对：2026-10-22（核对方式 = 逐条 grep/读实现/跑相关测试）
- 置信度：**高** = 直接读到代码/复现；**中** = 代码结构推断，未跑针对性实验；**待验证** = 有线索但未证实
- 严重度：**P1** 有明确数据/安全风险或阻断维护；**P2** 维护成本/一致性风险；**P3** 整洁度

---

## P1

| # | 状态 | 问题 | 证据 | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| 1 | 已修 | 入口 ↔ 路由组有运行时 import 环 | 原 9 个组文件反向 `import ... from '../index.ts'`（consult/import/market/me/prefs/profiles/recovery/snapshots/sync）；现共享工具在 `src/routes/route-support.ts`，组文件只依赖它 + kit，`src/index.ts` 单向 import `buildRoutes()` | 单测 import 任一这类组文件都会拖进整个宿主入口；拆分/裁剪入口的每一步都被它拖住 | 已按「共享 helper 下沉」执行（见 F6）；守卫 `tests/route/route-support-cycle.test.ts` 防回退 | 高 |
| 2 | 未修 | gist 通道无并发写保护，双机会静默覆盖索引 | `src/sync/gist/gist-transport.ts`（不做条件写的注释与落点）；`src/sync/gist/gist-overwrite-semantics.test.ts` 钉住现状 | 两台机器同时同步时后写者整体覆盖索引，前者条目消失（载荷不丢） | 需产品决策：单写者承诺 vs read-merge-write（都只能缩小窗口，gist 无 CAS）。决策前**不得**假装已安全 | 高 |
| 3 | 未修 | 回滚点载荷没有缺省敏感排除 | `src/core/rollback-ignore-rules.ts` 的内置排除段只有依赖目录（`node_modules` 一类），没有 `.env`/密钥文件 | 自动留点会把工作区里的明文密钥写进回滚点载荷（本地磁盘，仍属泄露面扩大） | 加内置敏感模式表 + 明确「这是排除不是加密」；需要产品确认默认集合 | 高 |
| 4 | 未修 | 恢复没有整笔自动回滚 | `src/core/restore.ts` 逐动作 try/catch；唯一兜底是恢复前副本 | 中途失败会留下「部分已恢复」的混合态，需要人工判断 | 先补「恢复中途进程崩溃」的回归测试（可在 journal 上续跑），再评估整笔回滚；不要在没有测试前改补偿逻辑 | 高 |
| 5 | 未修 | 档案复制失败后回滚失败只留注释、无补救 | `src/profiles/dsh-profile-manager.ts`（catch 内 rm 失败的分支） | 失败复制可能留下半棵树，用户只看到泛化错误且没有启动入口 | 失败标记 + 可重试的清理入口（「删除残留副本」按钮），而不是启发式自动删 | 中 |

## P2

| # | 状态 | 问题 | 证据 | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| 6 | 未修 | 巨型文件无体量棘轮 | `src/core/rollback-point.ts`（约 5.9k 行）、`src/index.ts`（约 4.4k，原 5.0k）、`src/client/recovery/RecoveryPanel.tsx`（约 1.9k）、`src/core/analyzer.ts`（约 1.8k） | 阅读与 merge 成本高；改动易漏 | 先给「不得继续增长」的软棘轮（行数上限测试），再按域拆分；拆前必须先有该域回归测试 | 高 |
| 7 | 未修 | `RecoveryPanel` 承载 8 类职责且写盘只有组件内 busy | `src/client/recovery/RecoveryPanel.tsx`；长写盘未进 `run-store` 的「进行中操作」状态 | 切页丢视图、用户不知道还在写 | 写盘动作登记到 `run-store`（与 export/import 同口径），再拆组件 | 高 |
| 8 | 未修 | 同一个概念多份实现 | 日期戳 3 份（`src/index.ts`、`core/model-tools.ts`、`sync/backup-scheduler.ts`）；脱敏流水线 2 份（`security/redaction.ts` 内两条同构路径）；越界判定 2 份（`core/restore.ts` 的 `startsWith` vs `utils/paths.ts` 的 `path.relative`，大小写/realpath 语义不同） | 修一处漏一处；跨平台差异在这里最容易出 | 抽单一实现并加一条跨平台用例；越界判定优先用 `path.relative` 版本（已处理分隔符与大小写） | 高 |
| 9 | 未修 | `/restore` 自拼 mutation gate 并复制 423 映射 | `src/routes/snapshots.ts` 与 `src/index.ts` 里的其它 gate 用法不一致 | 新增 gate 行为（例如新错误码）时容易漏改一处 | 收敛到同一个 helper；先补一条对比测试 | 中 |
| 10 | 未修 | 第二套徽章 `.kindTag` 族仍在用 | `src/client/config-manager.module.css` 的 `.kindTag` 系列；消费点 `ConflictList`/`ArtifactRow`/`BackupInspectView`/`RestorePlanView` 等 | 视觉一致性风险；样式守卫的注释声称已收敛（**文档与代码相反**） | 迁移到 `Badge kind=...`，或把注释改成事实；两者都行，但不能继续各说各话 | 高 |
| 11 | 未修 | inline style 绕过样式守卫 | `MarketPanel.tsx`、`ReleaseBody.tsx`、`ReleaseNotesDialog.tsx`、`SyncLogList.tsx` 里的 `style={{...}}`（含 `--dsw-*` 与硬编码字号） | `css-token-guard`/`css-scale-guard` 只读 `*.module.css` ⇒ 这些行不受约束 | 要么迁到 module.css，要么把守卫扩到 TSX（后者成本高、误报多，建议前者） | 高 |
| 12 | 未修 | `AGENTS.md` 预算顶死 | 约 28.5 KiB / 硬上限 28672 B（`scripts/check-agents-budget.mjs`） | 再加一条规则就红；当前已过警戒线 | 把长规则证据/流程下移到 `docs/lessons/`，AGENTS 只留一行规则 + 指针（本批正在做） | 高 |
| 13 | 未修 | 多个路由组零专用测试 | `src/routes/profiles.ts`（9 个端点，仅被路由计数/parity 与个别测试引用路径）、`me.ts`（仅源码扫描）、`history.ts` | 端点行为回归只能靠端到端或人工 | 优先补 profiles（隔离实例是高风险面）与 history（数据读取）；用直接 handler + fake req/res 的低成本范式 | 高 |
| 14 | 部分（测试已补） | 恢复中途崩溃后**续跑语义**未定，且没有任何进度登记 | `src/core/restore.ts` 逐动作执行、全程不写 journal step；崩溃后靠 journal + reconcile 判 `needs-attention` / SAFE MODE 兜底（不会误判完成）。用例：`src/core/restore-crash-injection.test.ts` A-1/A-2 钉住现状（journal 停 `APPLYING`、零 step、重跑被 `TransactionRecoveryRequiredError` 阻断） | 崩溃本身安全，但「重跑 = 从头再来」，没有断点续跑；用户不知道哪些动作已生效 | 先决定产品语义（从头再来 / 断点续跑），再决定是否补 step 登记；不要在没测试前改补偿逻辑 | 高 |
| 15 | 未修（已确认逃逸） | 目标侧 junction / symlink 可写穿到 home 外 | `src/core/restore.ts` 的 `homeAbs`/`isWithinHome` 是**纯字符串前缀**（约 :191-201），计划期不 realpath；写回走 `atomicCopyFile`，其 `resolveTarget` 只对**叶子路径**做 lstat/symlink 判定（`src/utils/atomic-write.ts:200-206`、`:305`），中间段目录链接不解析。用例：`src/core/restore-target-symlink.test.ts` B-2（junction 写穿 + 外部内容被复制进 pre-restore）、B-3（叶子 symlink `follow` 写穿） | 只要 home 内存在指向树外的 junction/symlink，restore 会写到 home 外真实文件，并把外部内容当本机文件备份进快照（反向信息流）。触发面 = 显式恢复含该 relPath 的快照，非自动路径 | 计划期对每个 target 做 realpath 前缀复核（逐段 lstat 或 `realpath(parent)` 后再判）；或在写回处传 `symlink:'reject'` 并把失败计入 report。两侧强度应对称（快照侧已有 `validateSnapshotForRestore`） | 高（本机实测） |
| 16 | 未修 | 崩溃后重跑 restore 会覆盖**唯一** pre-restore 反悔副本 | `src/core/restore.ts` 每次 `restore()` 的 pre-restore 序号从 0 重数（`:713`、`:723`，配合 `copyToPreRestore` :234-238）；用例 `src/core/restore-crash-injection.test.ts` A-3 实测 `0001-settings.yaml` 从 `CURRENT-settings` 被改写成 `SNAP-settings` | 用户原本可以「反悔回崩溃前」，重跑一次后这份唯一副本没了 | pre-restore 目录按 journal `opId` 分桶，或序号取「已有最大序号 + 1」；先加一条「两次 restore 不覆盖对方副本」的用例再改 | 高（本机实测） |
| 17 | 未修 | `publish.yml` 与 `ci.yml` 的检查集已对齐但仍是两处维护 | `.github/workflows/ci.yml`、`.github/workflows/publish.yml` | 新增检查要改两处，容易漏 | 抽 composite action 或让 publish 复用 ci；成本低但需验证 GitHub 行为 | 中 |

## P3

| # | 状态 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| 18 | 未修 | `CHANGELOG` 历史缺口 | 约 20 个版本段 vs 约 78 个 `v*` tag | 历史缺口是否有意，需要确认（缺失段不要补编，宁可写一句「历史段未逐版记录」） |
| 19 | 未修 | 部分测试文件含 `.skip` | `npm test` 里的 skipped 计数（当前 2 项） | 逐条确认是平台条件跳过还是长期忽略；长期忽略的应删除或转成显式 TODO |
| 20 | 未修 | CI 无 lint/format/覆盖率/依赖审计 | `ci.yml` 只有 typecheck / typecheck:tests / test / build / bundle 自包含 / 预算守卫 / 文档守卫 / pack | 明确「不引入 lint/format」是一种选择，要写进 ADR 或 AGENTS，避免反复讨论；覆盖率与审计按需再加 |
| 21 | 未修 | `docs/spec/` 与 `DEVELOPERS.md` 的计数/版本散文会漂移 | 历史上出现过「79 vs 82 条路由」「最新 v0.1.58」 | 已加 `scripts/check-doc-versions.mjs` + `scripts/check-doc-paths.mjs`；计数类散文仍靠人，建议把关键计数改成「由测试断言，文档不写死」 |

---

## 已修（留档，避免重复讨论）

| # | 修复 | 证据 |
|---|---|---|
| F1 | 自动同步「待补跑触发」由单槽改为按通道 Map，收尾逐通道串行补跑 | `src/sync/autosync-scheduler.ts`；回归用例在 `src/sync/autosync-scheduler.test.ts` |
| F2 | CLI `sessions repair --fix` 接入与救急台相同的写入门（SAFE MODE → 残留锁 → DSH 未运行） | `src/cli/index.ts`；用例 `src/cli/index-guards.test.ts` G-09/G-10/G-11 |
| F3 | 文档路径/版本守卫接进 CI 与发布流程 | `scripts/check-doc-paths.mjs`、`scripts/check-doc-versions.mjs`、`.github/workflows/ci.yml`、`publish.yml` |
| F4 | 文档事实漂移（路由 82、13 组、页面四页、白名单 133、版本声明去写死） | `AGENTS.md`、`DEVELOPERS.md`、`docs/spec/compat-matrix.md`、`docs/spec/known-gaps.md` |
| F5 | 未解锁容器闸门与 `plan-changed` 409 的回归测试 | `tests/route/encrypted-container-gate.test.ts`、`tests/route/restore-plan-changed.test.ts` |
| F6 | 拆掉「入口 ↔ 路由组」运行时 import 环：共享工具下沉 `src/routes/route-support.ts`，`src/index.ts` 5003 → 4379 行；`pluginVersion`/`starPromptRepoUrl` 改经 `makeRouteEnv()` 注入 | `src/routes/route-support.ts`、`src/index.ts`、9 个组文件；守卫 `tests/route/route-support-cycle.test.ts`、`tests/architecture-boundaries.test.ts` |