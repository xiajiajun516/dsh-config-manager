# 恢复 / 救急台 / 救援模式 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## CLI 与救急台必须同一道写入门，且「机器可读字段」必须与退出码同源

- **CLI 与救急台必须同一道写入门，且「机器可读字段」必须与退出码同源**（2026-10-08 UX 审查）：`dcm restore` 此前只过 SAFE MODE + 环境锁，而救急台传 `checkWriteGates(..., { needsDshStopped: true })` —— 同一个动作在浏览器里被拒、在终端能覆盖 `$DSH_HOME`；现在 CLI 补第三道门（SAFE MODE → 环境锁 → DSH 未运行），`--dry-run` 仍只打印计划。同族三条：① `sessions doctor --json` 的 `ok` 必须 `blocking === 0`（恒 true 会让 CI 把「阻断启动 N 条」读成健康）；② `sessions repair` 在会话根读不出来时必须 exit 1 并说「读不到 ≠ 没有会话」（绝不打印「无需修复」）；③ 救急台 404/405/错误页的「可用页面」清单必须从 `page.ts` 的导航表**派生**（三份硬编码互不一致，还把 JSON 端点 `/healthz` 当页面推荐）。护栏：`src/cli/index-guards.test.ts`、`src/cli/sessions-repair.test.ts`、`src/cli/web/console-route-parity.test.ts`。

## 灾备快照线已收敛下线（2026-09）

- **灾备快照线已收敛下线（2026-09）**：watcher / 撤销重做 / 手动快照 / `/lifecycle` 整体删除；只留 `core/crash-report.ts` + `core/boot-rescue.ts`（并入「事故恢复」子 tab），**不再自建第二条恢复通道**。三条不许回退：`boot-state.json` 移到 `<dataDir>/boot-state/`（`adoptLegacyBootState` 幂等搬迁）；`BOOT_CRITICAL_RELS`/`profileCriticalRels` 搬进 `core/boot-paths.ts`（**导入安全闸门 `boot-safety.ts` 仍在用，删灾备不许连带删**）；`PanelId` 去掉 `'lifecycle'` 并在 `run-store` 迁移到 `snapshots` + `subTab='recovery'`。守卫：`src/core/incident-wiring.test.ts` + `tests/route/route-parity.test.ts` + `src/core/crash-report.test.ts`。

## 救援模式与 `reconcileBundles` 的硬冲突

- **救援模式与 `reconcileBundles` 的硬冲突**：进救援收窄 `dsh.profile.bundles` 后，插件自己的 `reconcileBundles`（`src/core/plugin-cli.ts`，规则 = 声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`）很快（秒级）就会用 `dependencies` 把用户插件全部加回，救援名存实亡。两条修法**不许拆开**：① `enterRescueMode` 必须同时 `stripDependencies`（退出时整份 `package.json` 逐字节还原）；② 救援激活期间 `reconcileBundles` 一律停手（`isRescueActiveSync`）。验证必须真机四阶段（收窄 → 数秒不被改写 → 重启不挂载 → 退出逐字节还原）；走 patch 层的插件**不要**写进 `dependencies`（否则 `duplicate loader entry id`）。复核见 known-pitfalls。

## 离线救急台（`dsh-config-manager web` / `dcm web`）

- **离线救急台（`dsh-config-manager web` / `dcm web`）**：① 服务端复用 `src/routes/kit.ts`（`endpoint()` + `registerRoutes`），页面服务端直出 HTML（零脚本零外链，CSP `default-src 'none'`），因此没有 client bundle 自包含问题；② **token 是这一层的边界**：kit 对无 Origin 头的请求放行，所以必须启动时生成 32 字节随机 token → 只打印到当前终端 → `/?token=…` 换 HttpOnly + SameSite=Strict 会话 cookie（**用过即废**），其余请求一律 403；③ **读路径只读、写路径有门**：GET 打开页面零写入，但**不是只读服务** —— 已有 **11 条 POST 写路由**（清单与行号见 `docs/known-pitfalls.md`「t93 容量腾挪」§2），`GET /healthz` 自报 `readOnly:false` + 由路由声明派生的 `writeRoutes`。真实边界 = 回环围栏（非回环 403）+ 一次性 token→HttpOnly 会话 cookie（**每个请求含写**都要 cookie，缺则 403）+ 方法白名单（405 走 HTML）；写动作各自过 CLI 同源的写入门（SAFE MODE → 残留锁 → DSH 未运行，fail-closed；`/reinstall/*` 另持 `runWithMutationLock`），磁盘清理只碰可重建缓存故不过 SAFE MODE 门、档案启停**刻意不过**那两道门（它正是「DSH 起不来」时的出口）。**绝不等于「插件 API 无认证」**；④ **判定不许重写**（与 CLI 共用 `src/cli/actions.ts`）。两个已修的坑（细节见 `docs/known-pitfalls.md`「t93 容量腾挪」§2）：心跳候选根必须与 SAFE MODE 同一套 `resolveControlRoots`；退出必须真退出（`close().finally(() => process.exit(0))`）。


## 工作区 + 会话回滚（2026-10-10：原「三态同点检查点」整体改写）

- **两态、按回合自动留点（2026-10-10 起）**：引擎 = `src/core/rollback-point.ts`（**`src/core/rollback.ts` 是既有导入失败补偿引擎，与本功能无关，不得混用 / 改名**）。宿主在 `src/index.ts` 订阅 `session/event`，`turn/end` 时留点（边界 = 该回合 `turn/start` 的 seq − 1）；轮询回退（≤5s，日志 size/mtime 变化触发）也已实现但**拿不到回合边界** → 该点 `boundarySeq=null`、会话回退结构化 `no-boundary`（单测 R-18）。手动「拍点」表单与 `POST /recovery/checkpoints/capture` 已删除；**没有** config 第三态、**没有** `samePointVerdictOf`（`spreadMs` 只是两态 capturedAt 的跨度事实）。
- **回退 = fork 子会话，原日志只读**：`ctx.sessions.fork(source, boundary, childId?)`（经 facade `forkSession` 惰取 `ctx.get('sessions')`）；单测 R-12 断言原会话日志**逐字节未变**。旧版的静止期门 / 分叉门 / 字节副本写回全部下线 —— **不得**再引入「原地改写会话日志」的写法。
- **工作区恢复四条硬口径**：只覆盖快照记录在案的路径；**绝不删除**未记录文件与该点之后新建的文件（只进 leftovers 报告）；恢复前留救援点（guard 点不可删、不占自动点预算）；恢复后逐文件核对 SHA-256，任一不符**整体回滚**且 `restored=0`（R-05/R-06/R-07）。确认门 fail-closed：`userConfirmed` 不恰好为 true → 409 `confirmation-required` + 零写入 + **连 guard 点都不留**（R-08；路由级实测 `tests/route/recovery-rollback.test.ts:249-257`）。
- **旧数据与命名**：`<dataDir>/checkpoints/` 不再被读取（新目录名 `rollback-points/`），也**不去删**旧目录；路由族 `/recovery/checkpoints/*` → `/recovery/rollback-points/*`，仍挂在 recovery prefix 内按 path 分发 ⇒ 宿主注册路由条目仍 **79** 条（`tests/route/route-parity.test.ts` 钉住）。
- **未验证（不得当成已验证）**：没有真实宿主进程内的端到端取证、没有浏览器点击取证；fork 边界只在 mock/fixture 上取样。详见 `docs/spec/known-gaps.md` G-30。
- **F1 / F2 已修复（修复单 t13，2026-10-10；qa 独立复核 = `node --test src/core/rollback-point.test.ts` 25/25 pass + 源码 :1051/:1063-1078）**：新增单文件上限 `maxFileBytes` 并**先 `stat` 判大小**（旧实现 `read > 0` 短路 —— 首个文件可整份进内存 —— 已删）；字节 / 文件数预算耗尽时其后每一条都进 `skipped`（`budget-bytes` / `budget-files`），不再 `break` 静默丢弃；`maxSkippedEntries`（缺省 5000）只限记录条数，`skippedCount` 仍是真实总数 + `skippedTruncated`。**可见性（t18 已落地，2026-10-10）**：`payload.skippedCount/.skippedTruncated`、`segments[].skippedCount/.truncated`、`preview.workspace.skippedCount/.truncated` 经 t18 进入视图层（段级 / 预览行 `noticeKeys` + `rollbackPreviewWarnings()` → warn 徽章与行内提示），见本节末条与 `docs/spec/known-gaps.md` G-30。
- **台账写入只有一份序列化实现（t14）**：`withLedgerWriteLock`（`src/core/rollback-point.ts:746`）串行链覆盖 `appendRecord`（`:1276`）与 `remove`（`:1835`），`rewind` 的 guard 点内部同走 `capturePoint`；**只保证进程内** RMW 原子，跨进程仍靠 `runWithMutationLock` / `<dataDir>/locks/environment.lock`，**两者不可互替**。现象级证据：t7 探针 `.tmp/probe-t7-race.ts` 的 RACE_DELETE_THEN_RESURRECT / RACE_CAPTURE_LOST 从 12 / 5 转 0；仓库内护栏 = R-22（两实例交错 20 轮）。
- **窄化必须显式（t14，F-2）**：`rollbackTrackedEventOf`（`:1911`）/ `rollbackSessionBindingOf`（`:1944`）在 core 里导出，形状不符 → `invalid-input` + 细分 detail（`event-not-object` / `event-seq-missing` / `event-type-missing` / `session-not-object` / `session-id-missing`，seq 必须有限数），宿主 `host.log.warn`；cwd 缺失或非绝对 → `chunkless`（不留 chunks）+ 该点 `incomplete=true` + `workspace.reasonCode='no-chunks'`。护栏 R-23 / R-23b / R-23c。
- **救援点留存（t14，F-3）**：不占自动点的 20/50 预算、不被其淘汰、用户删不掉 ⇒ **必须有自身上限** `ROLLBACK_MAX_GUARDS_PER_SESSION = 20`（`:75`，每会话），超出淘汰最旧 guard（R-24）。**界面文案校正归属 t17**（`rollback.retention.hint` 原写「超出只淘汰最旧的非保护点」—— 会让用户以为受保护的点永不淘汰，不实）。
- **capture 侧跳过信息已到可见层（t18 落地，2026-10-10）**：t13 的 `skippedCount` / `skippedTruncated` 经 t18 接进视图（段级 / 预览行 `noticeKeys` + `rollbackPreviewWarnings()` → warn 徽章与行内提示；时间线文件数只算已收录文件）。**实证**：真机引擎产出的截断点驱动视图层，`.tmp/probe-t8-skip.ts` fail=0（`noticeKeys=[rollback.row.notice.skipped, rollback.row.notice.truncated]`）。定稿口径：**不再**写「界面未展示」。
- **聊天入口的版本边界（t20，2026-10-10）**：子会话导航 = `ctx.uiWorkspace.openSession(id)`（0.2.x；shipped ui-chat 的 fork 流程同款）→ 退化到 `ctx.sessions.open`（0.1.x，**存在才用**）→ 都没有则 `unavailable`（显示 childSessionId，不假装打开）。槽位**探测后才注册**：声明确为 `list` 才注册，0.1.5-rc.2 是 `chain`（按 list 注册会抛）⇒ `skip/slot-kind-mismatch`；跳过/异常只丢这一个入口。**不得**写成「任意版本可用」。
- **救援点可作回退目标（t22/t23，2026-10-10）**：`canRestore = !protected && !incomplete && 有可恢复段`，`canRemove = !protected && kind !== 'guard'` —— 两者**互相独立**；guard 不可删但**可回退**（「回到回退前那一刻」的唯一路径）。文案与判定必须同步（t23 已把 `rollback.code.protected-point` 的旧句改正）。