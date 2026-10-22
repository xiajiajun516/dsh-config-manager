# 技术债台账

**怎么用**：这不是抱怨清单，而是**排期清单**。每条都必须能被代码或测试证明；修完把状态改成「已修」并写提交/测试名，
不要删行 —— 删行会让下一个人重新踩一遍。改代码时顺手把行号同步一下。

- 最后核对：2026-10-23（核对方式 = 逐条 grep/读实现/跑相关测试）；此前修掉 #2/#3/#15/#16（F8–F11）；本轮补 #14 的进度登记与自动续跑（F13/F14）
- 置信度：**高** = 直接读到代码/复现；**中** = 代码结构推断，未跑针对性实验；**待验证** = 有线索但未证实
- 严重度：**P1** 有明确数据/安全风险或阻断维护；**P2** 维护成本/一致性风险；**P3** 整洁度

---

## P1

| # | 状态 | 问题 | 证据 | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| 1 | 已修 | 入口 ↔ 路由组有运行时 import 环 | 原 9 个组文件反向 `import ... from '../index.ts'`（consult/import/market/me/prefs/profiles/recovery/snapshots/sync）；现共享工具在 `src/routes/route-support.ts`，组文件只依赖它 + kit，`src/index.ts` 单向 import `buildRoutes()` | 单测 import 任一这类组文件都会拖进整个宿主入口；拆分/裁剪入口的每一步都被它拖住 | 已按「共享 helper 下沉」执行（见 F6）；守卫 `tests/route/route-support-cycle.test.ts` 防回退 | 高 |
| 2 | 已修（缩小窗口） | gist 通道无并发写保护 | 该端点对任何条件头回 400（ADR-0003），改为**写后复核 + 有界重做**：`src/sync/gist/gist-transport.ts` 的 `upload`/`delete` 在 PATCH 后重读索引，校验「本次条目落盘/目标已消失」且「读前条目一个不少」，不成立整轮重做 ≤3 轮，仍失败抛 `index-conflict`（文案键 `sync.gist.indexConflict`，`src/sync/gist/messages.ts`） | 被他人整体覆盖的条目现在会**报冲突**而不是静默消失；载荷不受影响 | 残余窗口仍在（别人在「我们读取」与「PATCH」之间写入的条目救不回）—— 无条件协议的物理边界，已写进 ADR-0003 与 `docs/spec/sync-channel-v1.md`；要彻底堵住只能用 git/webdav/s3（索引写是条件写） | 高 |
| 3 | 已修 | 回滚点载荷没有缺省敏感排除 | `src/core/rollback-ignore-rules.ts` 新增内置敏感表 `SENSITIVE_BASENAMES`/`SENSITIVE_KEY_SUFFIXES` + `builtinSensitiveReason()`（`.env`、`.env.*`（三个模板除外）、`.npmrc`/`.netrc`/`.git-credentials`/`.htpasswd`、`id_rsa` 系列、`*.pem/*.key/*.p12/*.pfx/*.jks/*.keystore/*.ppk`），**不可被 `!` 反向取消**；命中在 `src/core/rollback-point.ts` 记 `skipped`（reason `sensitive`）但仍进走查名单（删除集不受影响） | 自动留点不再把明文密钥物化进内容寻址载荷 | 仍是「排除不是加密」：显式把 `.env` 当 chunk 根声明时照样采集（`listChunkFiles`），历史回滚点里的既有明文不清理 | 高 |
| 4 | 未修 | 恢复没有整笔自动回滚 | `src/core/restore.ts` 逐动作 try/catch；唯一兜底是恢复前副本 | 中途失败会留下「部分已恢复」的混合态，需要人工判断 | 先补「恢复中途进程崩溃」的回归测试（可在 journal 上续跑），再评估整笔回滚；不要在没有测试前改补偿逻辑 | 高 |
| 5 | 未修 | 档案复制失败后回滚失败只留注释、无补救 | `src/profiles/dsh-profile-manager.ts`（catch 内 rm 失败的分支） | 失败复制可能留下半棵树，用户只看到泛化错误且没有启动入口 | 失败标记 + 可重试的清理入口（「删除残留副本」按钮），而不是启发式自动删 | 中 |

## P2

| # | 状态 | 问题 | 证据 | 影响 | 建议 | 置信度 |
|---|---|---|---|---|---|---|
| 6 | 部分（已加棘轮） | 巨型文件无体量棘轮 | `src/core/rollback-point.ts`（约 6.0k 行）、`src/index.ts`（4.4k，原 5.0k）、`src/client/recovery/RecoveryPanel.tsx`（约 1.9k）、`src/core/analyzer.ts`（1500 行，原 1824，拆分见 F12） | 阅读与 merge 成本高；改动易漏 | 已加「只许降不许涨」的行数棘轮（见 F7）；拆分仍按域进行，拆前必须先有该域回归测试 | 高 |
| 7 | 未修 | `RecoveryPanel` 承载 8 类职责且写盘只有组件内 busy | `src/client/recovery/RecoveryPanel.tsx`；长写盘未进 `run-store` 的「进行中操作」状态 | 切页丢视图、用户不知道还在写 | 写盘动作登记到 `run-store`（与 export/import 同口径），再拆组件 | 高 |
| 8 | 未修 | 同一个概念多份实现 | 日期戳 3 份（`src/index.ts`、`core/model-tools.ts`、`sync/backup-scheduler.ts`）；脱敏流水线 2 份（`security/redaction.ts` 内两条同构路径）；越界判定 2 份（`core/restore.ts` 的 `startsWith` vs `utils/paths.ts` 的 `path.relative`，大小写/realpath 语义不同） | 修一处漏一处；跨平台差异在这里最容易出 | 抽单一实现并加一条跨平台用例；越界判定优先用 `path.relative` 版本（已处理分隔符与大小写） | 高 |
| 9 | 未修 | `/restore` 自拼 mutation gate 并复制 423 映射 | `src/routes/snapshots.ts` 与 `src/index.ts` 里的其它 gate 用法不一致 | 新增 gate 行为（例如新错误码）时容易漏改一处 | 收敛到同一个 helper；先补一条对比测试 | 中 |
| 10 | 未修 | 第二套徽章 `.kindTag` 族仍在用 | `src/client/config-manager.module.css` 的 `.kindTag` 系列；消费点 `ConflictList`/`ArtifactRow`/`BackupInspectView`/`RestorePlanView` 等 | 视觉一致性风险；样式守卫的注释声称已收敛（**文档与代码相反**） | 迁移到 `Badge kind=...`，或把注释改成事实；两者都行，但不能继续各说各话 | 高 |
| 11 | 未修 | inline style 绕过样式守卫 | `MarketPanel.tsx`、`ReleaseBody.tsx`、`ReleaseNotesDialog.tsx`、`SyncLogList.tsx` 里的 `style={{...}}`（含 `--dsw-*` 与硬编码字号） | `css-token-guard`/`css-scale-guard` 只读 `*.module.css` ⇒ 这些行不受约束 | 要么迁到 module.css，要么把守卫扩到 TSX（后者成本高、误报多，建议前者） | 高 |
| 12 | 未修 | `AGENTS.md` 预算顶死 | 约 28.5 KiB / 硬上限 28672 B（`scripts/check-agents-budget.mjs`） | 再加一条规则就红；当前已过警戒线 | 把长规则证据/流程下移到 `docs/lessons/`，AGENTS 只留一行规则 + 指针（本批正在做） | 高 |
| 13 | 未修 | 多个路由组零专用测试 | `src/routes/profiles.ts`（9 个端点，仅被路由计数/parity 与个别测试引用路径）、`me.ts`（仅源码扫描）、`history.ts` | 端点行为回归只能靠端到端或人工 | 优先补 profiles（隔离实例是高风险面）与 history（数据读取）；用直接 handler + fake req/res 的低成本范式 | 高 |
| 14 | 已修 | 恢复中途崩溃后不能接着做（只能整笔重来或人工 reconcile） | 已补进度登记（F13）：`src/core/restore-wal.ts` 在首个写之前预登记全部动盘动作（planned + beforeFp）、逐动作 settle（done/attention + afterFp），删除类用 `ABSENT_FINGERPRINT` 哨兵；HTTP/CLI/model-tools 三条入口都把 journal ctx 传进执行器。用例：`src/core/restore-wal.test.ts` R-01..R-07、`src/core/restore-crash-injection.test.ts` A-1（1 done + 2 planned）/ A-4（真实 hooks 判 recovered） | 崩溃后能看出「哪些还原了、哪些没动」；再点一次「恢复」会**逐项证明后接着做**（F14），证明不成立才退回 423 `transaction-recovery-required` | 已按「先证明再续跑」执行：`core/restore-resume.ts` 的 `judgeRestoreResume` 逐条判定（同操作类型/同快照/计划与 step 一一对应/每个目标盘面只能是 beforeFp 或 afterFp/无回滚痕迹/无失败项/无外部副作用），任一不成立即拒绝并给机器码；续跑时**不重新预登记**（保住崩溃证据） | 高 |
| 15 | 已修 | 目标侧 junction / symlink 可写穿到 home 外 | `src/core/restore.ts` 的 `homeAbs`/`isWithinHome` 是**纯字符串前缀**（约 :191-201），计划期不 realpath；写回走 `atomicCopyFile`，其 `resolveTarget` 只对**叶子路径**做 lstat/symlink 判定（`src/utils/atomic-write.ts:200-206`、`:305`），中间段目录链接不解析。用例：`src/core/restore-target-symlink.test.ts` B-2（junction 写穿 + 外部内容被复制进 pre-restore）、B-3（叶子 symlink `follow` 写穿） | 只要 home 内存在指向树外的 junction/symlink，restore 会写到 home 外真实文件，并把外部内容当本机文件备份进快照（反向信息流）。触发面 = 显式恢复含该 relPath 的快照，非自动路径 | 已按前者执行：`planRestore` 返回前跑 `assertPlanTargetsSafe`（`realpathOrNull` + 中间段解析，落到 home 外整单拒绝，错误码 `restore.pathEscape`）；B-2/B-3 现在期望被拒、零写入 | 高（本机实测） |
| 16 | 已修 | 崩溃后重跑 restore 会覆盖**唯一** pre-restore 反悔副本 | `src/core/restore.ts` 每次 `restore()` 的 pre-restore 序号从 0 重数（`:713`、`:723`，配合 `copyToPreRestore` :234-238）；用例 `src/core/restore-crash-injection.test.ts` A-3 实测 `0001-settings.yaml` 从 `CURRENT-settings` 被改写成 `SNAP-settings` | 用户原本可以「反悔回崩溃前」，重跑一次后这份唯一副本没了 | pre-restore 目录按 journal `opId` 分桶，或序号取「已有最大序号 + 1」；先加一条「两次 restore 不覆盖对方副本」的用例再改 | 高（本机实测） |
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
| F7 | 巨型文件行数棘轮（12 个 ≥1400 行文件的当前行数即为上限，只许下调） | `tests/file-size-ratchet.test.ts`（F-01/F-02）；登记表含 `src/core/rollback-point.ts` 5980、`src/index.ts` 4379 等 |
| F8 | gist 通道的写改走**写后复核 + 有界重做**（upload 与 delete 都做，最多 3 轮，仍失败抛 `index-conflict`）—— 无条件协议下能做到的最大值，残余窗口如实登记 | `src/sync/gist/gist-transport.ts`、`src/sync/gist/messages.ts`；用例 `src/sync/gist/gist-overwrite-semantics.test.ts`、`src/sync/gist/gist-delete-concurrency.test.ts` |
| F9 | 回滚点载荷内置敏感文件排除（`.env` 族 / 私钥 / 证书 / 凭据文件），不可用 `!` 取消，记 `skipped(reason='sensitive')` 但仍进走查名单 | `src/core/rollback-ignore-rules.ts`、`src/core/rollback-point.ts`；用例 `src/core/rollback-sensitive-exclusion.test.ts` |
| F10 | 快照恢复目标侧防写穿：计划期对每个写回目标做 realpath / 中间段解析，落在 home 外即整单拒绝（此前只有纯字符串前缀判定） | `src/core/restore.ts`（`assertPlanTargetsSafe`，调用点在 `planRestore` 返回前）；用例 `src/core/restore-target-symlink.test.ts` B-1..B-4 |
| F11 | 「恢复前副本」改为**按次分目录**（`pre-restore/<本地时间戳>[-n]/`），重跑不再覆盖上一次的反悔副本；GUI/HTTP 恢复复用同一布局 | `src/core/restore.ts`、`src/routes/route-support.ts`；用例 `src/core/restore-crash-injection.test.ts` A-1/A-3、`tests/route/restore-route.test.ts` G-02b |
| F13 | 恢复逐动作 WAL：首个写之前预登记全部动盘动作（planned + beforeFp）、逐动作 done/attention（+ afterFp），删除类用 `ABSENT_FINGERPRINT` 哨兵表达「应不存在」；三入口（HTTP/CLI/model-tools）接线。崩溃后 reconcile 能判 recovered / needs-attention，但**仍不自动续跑** | `src/core/restore-wal.ts`、`src/core/journal.ts`（哨兵）、`src/core/phase3-host.ts`（verifyStepFingerprint 认哨兵）、`src/core/restore.ts`、`src/routes/route-support.ts`；用例 `src/core/restore-wal.test.ts`、`src/core/restore-crash-injection.test.ts` A-1/A-4 |
| F14 | 恢复**自动续跑**：崩溃后再点一次恢复 = 接着做（逐项指纹证明成立才续；三个入口只续各自 operationType；成功后按同一 `resolveSafeModeMarker` 解除 SAFE MODE）。判定拒绝码 11 个，含 `fingerprint-drift` / `external-unproven` / `plan-drift` | `src/core/restore-resume.ts`、`src/core/restore.ts`（`resume` hint）、`src/core/phase3-host.ts`（`resumeJournaled`）、`src/routes/snapshots.ts`、`src/routes/route-support.ts`、`src/cli/restore-resume.ts`、`src/core/model-tools.ts`；用例 `src/core/restore-resume.test.ts` T-01..T-08（含真 SIGKILL 后续跑）、`src/cli/restore-resume.test.ts` C-01/C-02、`tests/route/restore-route.test.ts` G-04 |
| F12 | 拆出 `src/core/import-planning.ts`（356 行）：把 `analyzer.ts` 尾部的导入计划纯函数整体外提，`analyzer.ts` 1824 → 1500 行，行为零改动（analyzer 保留 re-export，import 面不变） | `src/core/analyzer.ts`、`src/core/import-planning.ts`；棘轮上限同步下调（`tests/file-size-ratchet.test.ts`） |
