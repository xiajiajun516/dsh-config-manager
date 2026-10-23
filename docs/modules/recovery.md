# 对话回退 / 回滚点 / 救援控制台

给要改「对话回退、回滚点采集与台账、离线救援入口」的人读。这里只写**当前代码的真实行为**与调用关系；每条断言都钉到代码位置，未验证的写「待验证」，不写设计愿望。
约定：路径全部相对仓库根；行号是写作时的快照，检索时以符号名（函数/常量名)为锚更可靠。

## 1. 职责边界

| 层 | 落点 | 只负责 |
|---|---|---|
| 回滚点引擎 | `src/core/rollback-point.ts:1916` `RollbackPointEngine` | 采集（工作区 + 会话两态）、预览、删除集规划、回退执行、跨会话/fork 链接 |
| 台账存储 | `src/core/rollback-ledger.ts` | 一条一写、内容寻址载荷、schema 迁移、字节预算与淘汰落盘 |
| 进程内开关 | `src/core/rollback-gate.ts:19` | `enabled` 标志（缺省 false）+ 变更通知；不含任何采集逻辑 |
| 宿主接线 | `src/index.ts:4208` | 注入 fork seam、订阅 `session/event`（`:4221` 起）、注册 `/rollback` 命令（`:4293`）、卸载清理（`:4274-4279`） |
| 会话 fork 与 cwd 归位 | `src/index.ts:4164-4195`（fork seam）、`src/index.ts:1000`（`fork.call`） | 调宿主 `sessionController.fork`、三档归位、写归位诊断 |
| HTTP | `src/routes/recovery.ts:329` | 唯一 prefix 路由 + 子路径分派 + HTTP 码映射 |
| 客户端 | `src/client/recovery/RollbackCard.tsx:102`、`src/client/chat/rollback-entry-view.ts` | 面板/聊天入口、有界重试、归档结果→文案键 |
| 纯函数视图层 | `src/ui/rollback-view.ts` | 行/分组/范围与上限常量（数字必须与引擎一致） |
| 写入门（CLI/救急台） | `src/cli/actions.ts:438` `checkWriteGates` | SAFE MODE → 环境锁 → DSH 未运行 |
| 离线救急台 | `src/cli/web/server.ts:94` | 一次性 token → HttpOnly cookie → 其余 403 |

两个**易混的邻居**，不属于本域：

- `src/core/rollback.ts` 是**导入补偿引擎**（导入失败时回滚已写入的配置），与对话回退无关，名字相近但调用方不同。
- `src/core/restore.ts` 是**快照恢复**（备份恢复域，见 `docs/modules/backup-restore.md`）；回滚点引擎不调用它，两者的失败语义不要互相套用。

## 2. 入口

### 2.1 HTTP：一个 prefix 路由，九个子路径

全部挂在 `endpoint({ kind: 'prefix', path: '/api/dsh-config-manager/recovery', methods: ['GET','POST'] })`（`src/routes/recovery.ts:329`）下，无第二条注册：

| 子路径 | 方法 | 行为 | 门 |
|---|---|---|---|
| 空 | GET | 列点 + storage 状态（带 `rollbackEnabled`/`rollbackActive`）`src/routes/recovery.ts:548` | 只读 |
| `storage` | GET | 存储栈可用性 `src/routes/recovery.ts:581` | 只读 |
| `prefs` | GET/POST | 读/写自动留点开关 `src/routes/recovery.ts:600` | mutation gate `rollback-prefs` |
| `cleanup` | POST | 清理过期点 `src/routes/recovery.ts:640` | `userConfirmed === true` + gate |
| `<id>` | GET | 单点详情 `src/routes/recovery.ts:682` | 只读 |
| `<id>/preview` | GET | 回退预演 `src/routes/recovery.ts:701` | 只读 |
| `<id>/file-diff` | GET | 单文件差异 `src/routes/recovery.ts:709` | 只读 |
| `<id>/rewind` | POST | 真回退 `src/routes/recovery.ts:719` | 预检 + mutation lock |
| `<id>/delete` | POST | 删点 `src/routes/recovery.ts:809` | mutation lock |

`rewind` 是唯一会写工作区的入口，它做**两次**判定：R1 在拿锁之前（`src/routes/recovery.ts:760`），R2 在锁内再用 fresh preview 判一遍（`src/routes/recovery.ts:778`）。R2 针对的是「等锁期间对话又跑起来了」这个窗口。

### 2.2 会话内命令

`/rollback <id>` 走同一套门（`src/index.ts:4293` 起；处理体 `:4303-4348`）：先 `runWithMutationLock({op:'rollback-rewind'})`（`:4312`），再 `preview` 零写入预检（`:4317`），再同一道 `session-active` 门（`:4335`），最后 `rewind`，其中 `userConfirmed` **恒 true**（`:4342`：敲命令就是那次确认）。命令入口没有第二次确认按钮，其余门全量生效。

### 2.3 客户端

- 面板：`src/client/recovery/RollbackCard.tsx:102`，差异面板 `src/client/recovery/RollbackDiffPane.tsx`、变更列表 `src/client/recovery/RollbackFileChanges.tsx`。
- 聊天回退：`src/client/chat/rollback-entry-view.ts`，模式常量 `CHAT_REWIND_MODE = 'files+session'`（`src/client/chat/rollback-entry-view.ts:380`），选项装配 `buildRewindOptions`（`:526`）、可提交判定 `canSubmitRewind`（`:516`）。
- **读点是暂态，必须有界重试**：自动留点发生在回合收尾**之后**，所以即时查询可能早于写入。窗口 `CHAT_POINT_LOOKUP_WINDOW_MS = 30_000`（`src/client/chat/chat-entry-view.ts:679`），退避 0.5/1.5/3/6/12 s（`src/client/chat/ChatEntryView.tsx:270`），窗口到期即结束、不无限轮询（`src/client/chat/chat-point-window.ts:59`）。

### 2.4 离线入口

- CLI **没有** rollback 子命令：`CliCommand` 只有 snapshots/restore/reinstall/recover-stale-lock/verify/backup/import/sessions/web/help（`src/cli/index.ts:59`）。回滚点只能经 GUI/HTTP 与宿主 `/rollback` 命令。
- 离线救急台（`dcm web`）是写路径的另一入口：一次性 token（`src/cli/web/server.ts:94`）换 HttpOnly + SameSite=Strict cookie（`src/cli/web/server.ts:146`），非回环请求 403（`src/cli/web/server.ts:142`），无 cookie 403（`src/cli/web/server.ts:166`）。这份 token 是该层的真实边界——kit 围栏对无 Origin 请求放行，所以不能指望围栏（`src/cli/web/server.ts:6` 起头注释）。

## 3. 关键调用链

### 3.1 自动留点：在 `turn/start` 拍「回合开始前」的工作区态

`session/event` → 宿主监听器（`src/index.ts:4221`）→ 第一道门 `isRollbackEnabled()`（`:4224`）→ 子代理会话只 warn 一次、不留点（`:4228`）→ `RollbackAutoTracker.noteEvent`（`src/core/rollback-point.ts:5837`）→ `turn/start` 分支（`:5850`）→ `captureFor`（`:5801`）→ `capturePoint`（`:3382`）→ `captureWorkspace`（`:2532`）与 `captureSession`（`:2327`）。

三条**时间语义**是这块最容易改错的地方：

- 留点发生在回合**开始前**（`src/core/rollback-point.ts:5869-5877`，注释里记着真机症状：在回合结束拍会固定成「改完之后」，用户看到文件没被撤回）。
- `turn/end` 只更新缺省边界 `lastBoundary`（`:5886-5888`），**不**补采集。
- 已采集过的回合不重采（`:5860-5862`）；继承回合不补点（`:5863-5866`）。

采集本身：候选分块 `captureChunkCandidates`（`src/core/rollback-point.ts:2677`），缺口优先排序 `orderByCoverage`（`:2844`），并发缺省 16、钳在 1..64（`:291`、`:2047`），在飞字节上限 32 MiB（`:303`、`:2021`），时间预算 10–120 s 自适应（`:281`、`:2044`），超预算记 `budget-time`/`budget-files` 跳过（`:2557`、`:2505`）。**含 `.asar` 段的路径一律零 fs 调用**（`:1266` 判定、`:2458` 起的分块入口），否则宿主会把畸形夹具当容器解析、桌面直接闪退。

### 3.2 回退：不是就地截断，是 fork + 归档原会话

调用链（HTTP 与 /rollback 命令同一条引擎路径）：

`rewind`（`src/core/rollback-point.ts:4383`）→ 三道门（`userConfirmed` 必须恰好 `true` `:4403`；保护点 `:4407`；记录不完整 `:4412`，`allowPartial` 才放行）→ 回退前 guard 点（`:4422`）→ `restoreWorkspace`（`:4832`）→ `restoreSession`（`:5319`）→ 引擎 `fork` seam → 路由侧封装 `forkSeamOf`（`src/routes/recovery.ts:220`）→ 宿主注入（`src/index.ts:4814`）→ `forkPort.forkSession`（`src/index.ts:4815`）→ `fork.call(controller, { sessionId, atSeq: boundarySeq })`（`src/index.ts:1086`）。

为什么必须这样：宿主内存里的活动会话不重读磁盘，平台也没有 drop/reload API，所以「就地截断日志」在运行中的 DSH 里不可能生效；能生效的只有「新会话替换旧会话 + 归档旧会话」（决策记录见 `docs/decisions/0004-rollback-point-fork-archive.md`）。客户端把归档结果翻成文案键（`archiveHintKey`，`src/client/chat/rollback-entry-view.ts:894`）。

两个**硬性要求**：

1. 走 `ctx.get('sessionController').fork`，**绝不**直接 `SessionStore.fork`（`src/index.ts:1053` 起注释记录了真机事故：直接调 Store 会留下 `SessionPersistenceNotFoundError`）。
2. cwd 归位失败**不算 fork 失败**，但必须带出去：`workspaceAttachFailureChildId` 取回 `childId`（`src/index.ts:1069`）、warning 前缀 `workspace-attach-failed`（`src/index.ts:927`）、重试 2 次 × 200 ms（`src/index.ts:937`）、失败写 `logs/rewind-workspace-attach.jsonl`（`src/index.ts:941`）。归位本身三档降级：已在同组 → 血缘 → 同目录（child 与 parent 两个 cwd 候选），都失败记 `cwd-unavailable` / `no-workspace-for-cwd`（`src/index.ts:1154` 起，`:1163`/`:1175`/`:1182`/`:1195`）。warning 一路带到引擎结果里的 `guidance.sessionNotAttached`（`src/index.ts:4825`、`src/routes/recovery.ts:232`）——**不静默**：会话确实回退了，但它会出现在侧栏「未分组」。

### 3.3 删除集：只有一份规划

`planCreatedRemovals`（`src/core/rollback-point.ts:3689`）是唯一实现，预览（`:3960`）与执行（`:4383`）共用同一结果。判据是**能证明「留点时不存在」**才删（`:3700` 起）：

- 有索引 → 索引并入证明名单（`:3706`）；
- 索引读不出 → `capture-incomplete`（`:3709`）；
- 列表被记录上限截断且无索引 → `capture-incomplete`（`:3711`）——**范围说不清才全局 fail-closed**；
- 范围清楚的子树问题只拒绝**该子树**（`:3722` 起 `scopesKnown`/`refused`，`:3769`），`truncated` 本身不算拒绝理由（`:3752`）。

拒绝时 `paths` 置空并把 `skipped` 合并进结果（`:3788`），`createdRemovalRefusal`（`:4545`）负责把原因翻成引导文案。

### 3.4 三道写入门

`checkWriteGates`（`src/cli/actions.ts:438`）是这一层的共享实现，顺序固定：① SAFE MODE（`readSafeMode` 三态，blocked 与 unknown 都拒，`src/cli/actions.ts:442`）② 环境锁存在即拒（`:466`，不自动回收陈旧锁）③ `needsDshStopped` 时 DSH 在跑即拒（`:480`，desktop 档案只给「关窗口」通道）。调用点：`sessions repair --fix`（`src/cli/index.ts:995`）、CLI 其他写路径（`src/cli/actions.ts:678`/`:743`/`:1292`）、救急台（`src/cli/web/routes.ts:213`/`:258`）。

**已知不齐**的一处：CLI `restore` 不是调 `checkWriteGates`，而是它的等价组合——先 `checkSafeModeBlocked`、再拿锁、锁内查 `readRunningInstances`（`src/cli/index.ts:1102`–`:1125`，注释自称同源同序）。判据相同但**代码路径不同**，改门时两处都要动。

SAFE MODE 的解除判据只有一份：`resolveSafeMode`（`src/core/recovery-orchestrator.ts:225-226`，内部委托 `resolveSafeModeMarker` `:130`），verify/dismiss 与显式解除都调它（`:265` 读 `clearable`、`:453` 自动解除），`ROLLED_BACK` 后自动解除（`:402`）。宿主把结果注入成 `host.safeModeIsBlocked`（`src/index.ts:3924`），所有写路由用 `isBlocked: () => host.safeModeIsBlocked?.() ?? false` 接（`src/routes/recovery.ts:369`/`:444`/`:616`/`:653`/`:769`/`:818`/`:861`）。

## 4. 数据形态与预算

台账 v3 的落点（`src/core/rollback-ledger.ts:1` 起头注释给了从 v2 单文件迁移的真实原因：473 KB / 285 KB / 138 B 三条点在宿主里解析成 V8 heap OOM，进程 exit 134）：

```text
<dataDir>/rollback-points/
  index.json              # 清单：不含大数组
  index.v2.backup.json    # 迁移前清单备份
  records/<id>.json       # 一条一写
  payloads/<sha256>.json  # 内容寻址载荷
  objects/<sha256>        # 内容寻址对象
  path-cache.json
```

三条硬性质（同处头注释）：清单不含大数组；按条解析；载荷去重。`SCHEMA_VERSION = 3`（`src/core/rollback-ledger.ts:58`）；写入口 `appendRecord`（`src/core/rollback-point.ts:3300`；清单读写 seam 在 `src/core/rollback-ledger.ts:199`）保证**单次 append 不读别人的记录文件**；迁移幂等且崩溃安全，`recoverManifest`（`:1301`）在 records 为空时只落空清单——写坏了就是整批旧点被抹掉。

| 约束 | 值 | 落点 |
|---|---|---|
| 自动点全局上限 | 50 | `src/core/rollback-point.ts:191` |
| 自动点每会话上限 | 20 | `src/core/rollback-point.ts:193` |
| guard 点每会话上限 | 20 | `src/core/rollback-point.ts:203` |
| guard 点全局上限 | 50 | `src/core/rollback-point.ts:213` |
| 台账字节预算 | 256 MiB（与条数两套独立） | `src/core/rollback-ledger.ts:76` |
| 单点会话载荷上限 | 32 MiB | `src/core/rollback-point.ts:266` |
| 采集在飞字节 | 32 MiB | `src/core/rollback-point.ts:309` |
| 采集并发 | 16（钳 1..64） | `src/core/rollback-point.ts:297` |
| 采集时间预算 | 缺省 30 s，钳 10–120 s 自适应 | `src/core/rollback-point.ts:282`（钳位常量 `:287-288`） |

淘汰与预算：`selectPruneEntries`（`:3090`）按会话分组截断，`applyByteBudget`（`:3139`）再按字节淘汰，`gcObjects`（`:3211`）回收无引用对象。guard 点**不占**自动点的 20/50 预算，但有自己的一套 20/50，且用户不可删（`rewind` 的保护点门 `:4407` 不含 guard；`delete` 会拒）。客户端上限常量必须与引擎逐字一致：`src/ui/rollback-view.ts:247`/`:249`/`:251`/`:257`。

## 5. 失败语义

HTTP 码映射集中在一处 `rollbackHttpStatus`（`src/routes/recovery.ts:59`）：`storage-unavailable`→503；`record-not-found`→404；`invalid-input`/`created-removals-limit`→400；`confirmation-required`/`protected-point`/`record-incomplete`/`session-active`→409；`mutation-locked`→423；`method-not-allowed`→405；`partial`/`nothing-to-restore`→200；`failed`/`restore-failed`/`guard-failed`/`ledger-write-failed`→500。

其余关键语义：

- **存储栈不可用**（三条路径）/ **无记录** 各自有独立码，绝不合并成「没有回滚点」。
- `session-active` 只在**要动工作区**时拦（`rewindTouchesWorkspace`，`src/routes/recovery.ts:91`）；纯会话段回退不拦。
- fork 能力缺失 → 会话段结构化 `session-fork-unavailable`（`src/routes/recovery.ts:220`），不静默降级为「只回退了文件」。
- 回退中断有现场日志：`interruptedRollbacks`（`src/core/rollback-point.ts:3908`）/ `recoverInterruptedRollback`（`:3924`）；只有当前内容仍等于回退后镜像时才写回，否则不猜。
- 台账写失败 → `RollbackLedgerRefusedError`（`:5468`），`cleanup` 映射成 503/500（`src/routes/recovery.ts:672`）。

## 6. 已知限制与有意取舍

- **自动留点缺省关闭**（`src/core/rollback-gate.ts:19`）；关闭时宿主**解绑**订阅（`src/index.ts:4898`、`:4904`），活切换经 `onRollbackEnabledChange`（`src/index.ts:4907`）。不是「留着监听只是不写」。
- guard 点可回退、不可删、不占自动预算，但**受两级上限约束**（不是无上限保留）。
- CLI 没有回滚点子命令（`src/cli/index.ts:59`），离线救急台也只做会话/布局/快照类修复。
- CLI `restore` 的写入门与 `checkWriteGates` 是等价组合而非同一函数（见 §3.4）。
- fork 归位失败不回滚 fork，只带 warning + 诊断文件（会话在侧栏「未分组」）。
- 采集有硬上限，回合内改动超过 32 MiB 会话载荷或超时间预算时覆盖率不足，需要用户显式重试或放宽。
- 快照恢复（`src/core/restore.ts`，非本域）自 2026-10-23 起**逐动作写 journal step**（`src/core/restore-wal.ts`：首个写之前预登记全部动盘动作 + beforeFp，逐动作 done/attention + afterFp，删除类用哨兵），崩溃后 reconcile 因此能证明进度（A-4 判 recovered）；并且**能自动续跑**：再点一次恢复先跑 `judgeRestoreResume`（`src/core/restore-resume.ts`，同操作类型 + 同快照 + 计划与 step 一一对应 + 每个目标盘面只能等于 beforeFp/afterFp + 无回滚痕迹/失败项/外部副作用），成立才「接着做」（跳过已完成动作、不重新预登记），不成立才退回 423 让人 reconcile。三个入口只续**自己**的 operationType：GUI `restore`（`src/routes/snapshots.ts`）/ CLI `cli-restore`（`src/cli/restore-resume.ts`）/ model `model-restore`（`src/core/model-tools.ts`）；`phase3-host.ts` 的 `resumeJournaled` 接管 owner、不做 active≤1 门禁；`restore.ts` 的 `resume` hint 只跳过、不重建。三处历史缺口已修：目标侧在计划期做 realpath / 中间段解析，落在 home 外整单拒绝（`assertPlanTargetsSafe`，调用点在 `planRestore` 返回前）；「恢复前副本」改为**按次分目录** `pre-restore/<本地时间戳>[-n]/`，重跑不再覆盖上一次的反悔副本（GUI/HTTP 恢复复用同一布局）。锚点：`src/core/restore-crash-injection.test.ts`、`src/core/restore-resume.test.ts`（T-01..T-08，含真 SIGKILL 后续跑）、`src/cli/restore-resume.test.ts`、`tests/route/restore-route.test.ts`（G-04）、`src/core/restore-target-symlink.test.ts`。**别再当成本域问题**。

## 7. 测试锚点

| 文件 | 钉住什么 | 状态 |
|---|---|---|
| `src/core/rollback-point.test.ts` | 两态采集、删除集判据、预览与回退、fork 链接 | 钉住当前行为 |
| `src/core/rollback-interrupted.test.ts` | 中断回退现场不被孤儿清理删（I-1）、只在内容仍等于 after 镜像时写回（I-2）、全条目自证成立才恢复（I-3） | 钉住当前行为 |
| `src/core/rollback-gate.test.ts` | 缺省关闭、同值不通知、监听器抛错不影响、解绑幂等（G-01…G-04） | 钉住当前行为 |
| `src/core/rollback-ledger.test.ts` | 一条一写、内容寻址、迁移、字节预算 | 钉住当前行为 |
| `tests/route/recovery-rollback.test.ts` | 全子路径可达且未确认零写入（R8-1）、坏 id/未知子路径/405（R8-2）、存储栈不可用全 503（R8-3）、保护点 409（R8-4）、SAFE MODE 423 但只读不受影响（R8-5）、guard 可回退不可删（R8-6）、`nothing-to-restore`（R8-7）、台账只读 rewind 500（R8-8）、运行中带文件段 409（R8-9）、prefs 与 cleanup（R8-11/R8-12） | 钉住当前行为 |
| `src/cli/index-guards.test.ts:120` | CLI `restore` 在本机有 DSH 在跑时拒绝（G-06） | 钉住当前行为 |
| `tests/cli/sessions-repair.test.ts` | `sessions repair` 的门与退出码 | 钉住当前行为 |
| `src/cli/web/web.test.ts` | token 一次性、cookie、403、读路径只读 | 钉住当前行为 |
| `src/client/chat/rollback-entry-view.test.ts` | 预览行/删除集/文案键/可提交判定 | 钉住当前行为 |
| `src/client/chat/chat-entry-view.test.ts:891` | 点查询窗口 30 s 且退避表落在窗内 | 钉住当前行为 |

尚未覆盖的高风险分支（改这块前建议先补）：进程被 kill 时台账半写的端到端断言；`rewind` R1/R2 之间「对话在等锁期间启动」的并发对抗；20/50 上限与 256 MiB 预算的大规模实证（现有用例只用小参数）；救急台与 CLI 同一道门的跨入口对拍。

## 8. 维护提示

- 改上限：引擎四个常量（`src/core/rollback-point.ts:185`/`:187`/`:197`/`:207`）与客户端四个（`src/ui/rollback-view.ts:247`–`:257`）必须同改，否则面板显示与引擎行为分叉。
- 改台账目录名或 undo 目录命名：同步 `UNDO_DIR_RE`（`src/core/rollback-ledger.ts:100`，注释在 `:65`），卡片清理按名字以 pid 开头判定。
- 改 fork 返回形状：三处一起动——`src/routes/recovery.ts:220`（窄化读取）、`src/index.ts:4814`（形状加固）、`src/index.ts:1154`（三档归位）。
- 改回退的门：HTTP 与命令两条入口都要改（`src/routes/recovery.ts:758`/`:778` 与 `src/index.ts:4936`–`:4961`），少一处就是「HTTP 拒绝、命令放行」。
- 采集的 `.asar` 例外**不可放宽**：原因见 §3.1，放宽的后果是宿主进程被畸形路径带崩。
- 本域任何用户可见行为变化都要同轮进 `CHANGELOG.md`；证据与真机复现写 `docs/lessons/recovery-console.md`，本文只留「代码落点 + 当前行为」。