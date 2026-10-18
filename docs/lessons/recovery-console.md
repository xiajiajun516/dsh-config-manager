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
- **救援点留存（t14，F-3 → 2026-10-12 追加全局上限）**：不占自动点的 20/50 预算、不被其淘汰、用户删不掉 ⇒ **必须有自身上限**，且**一道不够**：先每会话 `ROLLBACK_MAX_GUARDS_PER_SESSION = 20`（`:87`），再全局 `ROLLBACK_MAX_GUARDS = 50`（`:97`），两轮都只淘汰最旧 guard（R-24）。单会话上限只挡住一个会话 —— 本机 1300+ 会话时，跨会话的 guard（连同其内容对象）会一直留在磁盘上，这才是真正的无界来源；这也是「先每会话、再全局」两轮裁剪的由来（两类预算互相独立，谁也不吃谁额度）。**界面文案校正归属 t17**（`rollback.retention.hint` 原写「超出只淘汰最旧的非保护点」—— 会让用户以为受保护的点永不淘汰，不实）。
- **capture 侧跳过信息已到可见层（t18 落地，2026-10-10）**：t13 的 `skippedCount` / `skippedTruncated` 经 t18 接进视图（段级 / 预览行 `noticeKeys` + `rollbackPreviewWarnings()` → warn 徽章与行内提示；时间线文件数只算已收录文件）。**实证**：真机引擎产出的截断点驱动视图层，`.tmp/probe-t8-skip.ts` fail=0（`noticeKeys=[rollback.row.notice.skipped, rollback.row.notice.truncated]`）。定稿口径：**不再**写「界面未展示」。
- **聊天入口的版本边界（t20，2026-10-10）**：子会话导航 = `ctx.uiWorkspace.openSession(id)`（0.2.x；shipped ui-chat 的 fork 流程同款）→ 退化到 `ctx.sessions.open`（0.1.x，**存在才用**）→ 都没有则 `unavailable`（显示 childSessionId，不假装打开）。槽位**探测后才注册**：声明确为 `list` 才注册，0.1.5-rc.2 是 `chain`（按 list 注册会抛）⇒ `skip/slot-kind-mismatch`；跳过/异常只丢这一个入口。**不得**写成「任意版本可用」。
- **救援点可作回退目标（t22/t23，2026-10-10）**：`canRestore = !protected && !incomplete && 有可恢复段`，`canRemove = !protected && kind !== 'guard'` —— 两者**互相独立**；guard 不可删但**可回退**（「回到回退前那一刻」的唯一路径）。文案与判定必须同步（t23 已把 `rollback.code.protected-point` 的旧句改正）。

- **「没有可恢复的内容」不是失败，绝不能映射成 5xx（2026-10-10 三修；用户原话「回滚失败并提示错误500」）**：`nothing-to-restore` 曾被 `src/routes/recovery.ts` 与真失败同级映射成 **HTTP 500**，用户看到的就是「回滚失败」。修法：`nothing-to-restore` → **200**；引擎侧「无事可做」的段是 `status='restored'` + `restored=0`（**不是** `skipped`，故不进 `skippedSegments`），整体 `outcome='restored'` + 该 code；**只要还有一段真能回退，会话段照常 fork 并返回 `childSessionId`**。配套：**0 变更 = 真的 0 次写入**（记录在案的文件全部一致时不再重写；反例断言字节与 mtime 都不变）。护栏 = R8-7（真 http）+ R-26–R-28 + qa 自造反例 `.tmp/qa/t3-counterexamples.ts`（88 条断言）。
- **聊天回退入口：icon-only + 两档互斥（2026-10-10）**：两个入口都只画 `RefreshIcon`（`.chatActionBtn` 24px 无边框位，与时间戳 / 复制图标同一行），可见文案只走 `aria-label` / `title`；`per-message` 档下 turnTail **一次都不注册**（`planChatEntryRegistrationForMode` 直接 skip）⇒ 同屏只有一颗 icon。**不得**再写「两档并存」。
- **聊天预览弹窗的有意替换（2026-10-10）**：三选一 mode / 二次确认勾选 / `allowPartial` 勾选 / 计数面板 / 救援点说明 / 逐段结果 / notice 面板**全部删除**；范围固定 `files+session`、救援点恒 `require`、**点「回退」即 `userConfirmed=true`**。fail-closed **未松**（`defaultDraft` 恒 false、唯一置位入口 `confirmOnSubmit()`、`buildRewindOptions` 要求恰好 true、引擎侧同规）；设置页 `RollbackCard` 仍保留完整能力。行级统计触限 / 非文本 / 读不出 → `null` + `truncated`，界面说「行数未统计」，**绝不写 0**。详见 `docs/spec/known-gaps.md` §3「G-30 / G-39 增量」。
- **成败判据必须是「真的写进去了」，不是「拿到了内存对象」（t10，2026-10-10 安全链）**：`capturePoint` 曾无论 `appendRecord` 成败都把内存 record 一起返回，消费方（`rewind` 的救援点 / `RollbackAutoTracker.captureFor`）拿 `point.id` 当「留点成功」⇒ 对外报出**台账里查不到的幽灵 `guardPointId`**。现在判据只有一条 = `appendRecord` 真的成功：写失败返回 `{ ok:false, code:'ledger-write-failed' }`（不返回 record）；`require` 档留不下救援点即**整体中止**（`guard-failed`、**零写入、不返回 `childSessionId`**），`warn` 档只告警继续但**同样不报 `guardPointId`**。同轮把 `fs.stat` 失败语义收紧：**只有 `ENOENT`** 才算「确实不存在」（→ `create` + 快照行数），其它 errno = 存在性**未知** ⇒ `status` 照给但 `added/removed=null` + `truncated=true`（判据只看 errno `code`、不看 message）。护栏 = `src/core/rollback-point.test.ts`。
- **「无需恢复」是假尾句的高危句（t11 + t15，2026-10-10）**：同一句曾盖住三种**不同**事实 —— 该点没记录任何文件 / 工作区态没有可用记录 / 真的「一致」但**会话仍会回退**（fork）。**结果态**按 `segments[].status / reasonCode` 分派三句（`rollback.preview.result.noop / noRecord / noFiles`）；**预览态**由 `rollbackPreviewNote()` 按 preview 字段分派**四态**（不可用 / 无文件 / 一致但会话仍回退 / 一致且无事可做），**判据禁止解析 `detail`**。**假尾句禁令**：`changesSomething === true`（会写文件 or 会 fork）时，**要么不上屏任何「一致 / 无需恢复」句，要么该句不含「无需恢复」**。护栏 = `src/ui/rollback-view.test.ts` 四态矩阵 + `recovery-locales.test.ts`。
- **互斥关系必须由同一次订阅驱动；槽位声明顺序要用有界补试兜住（t13 / t17，2026-10-10）**：一侧订阅、另一侧装配期读一次 ⇒ 切档后活 cell 变 **0**（入口消失，要刷新）或 **2**（同屏两个按钮）。修法 = `mountChatEntries()` 同一次订阅驱动、先全退再注册恰好一个（切档 trace 恒 **`[1,1,1,1]`**、事件级峰值 **1**）。**槽位声明顺序无关**由**有界补试**（最多 `maxRetries=4`、声明一到位即停）达成，**是异步的**：声明到位 + **一个排程 tick** 后恰好 1 入口，**同步瞬间可为 0 是设计而非缺陷**；`reapply()` 幂等钩子已备但**未接线**（装配点仍是一次 hold）。护栏 = `src/client/chat/chat-entry-mount.test.ts`。
- **两份拷贝必须有对照守卫（t11 防漂移，2026-10-10）**：引擎 `RollbackCode` union 与客户端 `ROLLBACK_CODES` 镜像的漂移是**静默的** —— t10 新增 `no-recorded-files` 时镜像漏一格，界面直接显示 unknown。现在有**源码级双向集合相等**用例 + **反自检**（注入「引擎有、镜像没有」的码必须被抓到；注释里的假码不得被当真码）+ 两侧解析结果 ≥30 条（防「空集对空集」的假绿）。**任何「同一份事实写两处」的地方（码表 / 枚举 / 白名单）都照此办**。护栏 = `src/ui/rollback-view.test.ts`。
- **每条用户消息一个回退入口 = 接管 `conversation.chat.node` 的 `user` 渲染器（2026-10-10）**：宿主该 key **没有 children 表**（只对 turn-tail 声明了子位）⇒ 想让按钮与原文同时出现**只能**用 `priority -1` 遮蔽 shipped `UserMessageNodeView` 并**复刻**气泡（宿主组件 / CSS Modules 私有不可导入；图片走 owner 的 `renderMessageImages`）。**同 key 同 priority 再注册会抛**，-1 是与宿主并存的唯一合法值；`steering` 是另一个 key，一律不接管（单测钉住注册面只有 `user`）。
- **缺省档 = `per-message`，偏好存 localStorage `dcm.chat-entry-mode`**（读不到 / 非法值回缺省；storage 不可用不抛）；`subscribeChatEntryMode` 做**热切换**（退旧登记 → 按新档重评估）。**绕过 `writeChatEntryMode` 直接改 localStorage 只有下次加载生效**。面板入口 = 「工作区与会话回滚」卡上的两档开关（**T2 已交付**，写入只走 `writeChatEntryMode`）。**边界（如实）**：偏好按**浏览器**存、**同一页面内即时**，**没有 `storage` 事件监听 ⇒ 跨标签页不即时**（另一页要下次加载才跟上）—— 面板文案「切换立即生效（无需重启 / 刷新）」只承诺**当前页面**。
- **接管渲染器 = 我们的 bug 可能吃掉用户消息**：`ChatEntryErrorBoundary`（**class 组件 —— React 18 唯一形态，本仓「无 class」规范的唯一显式例外**）抛错即降级为**纯文本气泡**（`data-chat-entry-fallback` + ASCII `console.warn`；**该路径只保留正文**，附件 / rest 结构会丢 —— 已知差距）。连它也没兜住时 ui-renderer 的 per-entry 边界会让登记 `abdicate`、退回宿主渲染器；**这条 abdicate 是一次性且不可复活**（宿主 SlotCore 用 `WeakSet` 记录已 abdicate 的条目，只有 `has` / `add`、**无任何 revoke 路径**，`entriesOfSlot` 对该条目永久跳过）⇒ **同一条消息在那次登记的生命周期内永久交回宿主渲染器**（消息仍在，fail-soft 正确）；`dispose → register` 创建的是**新**条目 ⇒ 切档 / 重挂可重新接管 —— **不得**写成「刷新即恢复」或「可撤销」。证据：`.tmp/r1-probe/t5.bundle.js:18911-18918,19140,19306-19316` + 语义探针 `.tmp/r1-probe/slotcore.mjs` 10/10（qa 复跑复现）。形态不是 `keyed` 就跳过注册、回合号取不到就如实禁用（**不猜**）。
- **剩余已追认差距（不修，登记在 `docs/spec/known-gaps.md` G-39）**：① **技能 chip 与引用 chip 的「可点开」外观未做** —— 引用摘要行与正文会话线格式**已复刻**（2026-10-10 t9），`skillNames` 仍未接线（不渲染也不编造）；② 文件类型图标仍用**扩展名徽标**（`FileTypeIcon` 不在 ui-primitives 导出表），但扩展名口径已对齐宿主（dotfile 前导点算后缀 + 8 字符截断，`.gitignore` → `GITIGNOR`）；③ 时间**固定 24h 补零 `HH:mm`**、仍**不做「今天 / 昨天」**；④ 动作行**常显**、**无宿主同款 tooltip**；⑤ **崩溃降级只保留正文**；⑥ ~~底色近似~~（**2026-10-15 收回**：底色不是近似而是功能级不可见，已改为跟随宿主 `--dsw-specific-bubble`）、~~字号近似 12.5px（宿主 14px）~~（**2026-10-17 收回，issue #93**：字号不是近似而是**用户设置失效**），均见下文对应小节；仍保留：圆角（8px vs 宿主 14px）。
- **复刻对齐的 5 处（2026-10-10 t4 复核 → t9 修复，全部按宿主复刻、不是登记差距）**：D1 compact = 附件总数（图片 + 文件）> 1；D2 附件按 content 原始顺序渲染；D3 体积文案逐字（无空格；单位值 < 10 才一位小数，否则取整）；D4 时钟固定 24h 补零（不再 `toLocaleTimeString`，en-US 下不再出现 `05:04 PM`）；D5 正文会话线格式 `@[label](dsh-session:…)` → label + 引用摘要行（气泡与崩溃降级两条路径都投影）。护栏 = `chat-entry-view.test.ts` **31** 条 + 复核探针前后对照（真浏览器 DOM 32/32）。
- **bytes 缺失时的有意差异**：宿主 `fileSizeText` 读不到字节数会渲染 `NaNGB`，我们**不渲染**（`fileSizeTextOf` 回 null → 整段不显示）—— 有意更诚实，**不是缺陷**。

- **留点发生在回合收尾之后：任何一次即时查询都可能早于它（2026-10-10 真机，聊天回退入口「捕获晚于查询」竞态）**：用户报「回退按钮点不开、显示『这个回合还没有回滚点』，可那个点其实已经创建」。量化证据（本机真机）：该回合会话日志 `~/.dsh/sessions/--D-Projects-personal-dsh-settings-tidy--/session-e3a7953c-068c-48aa-8e87-7f5c230806da/session.v4.jsonl.zstd` 的**创建时间 = 该回合 `turn/end`** 20:03:38.6496444Z、最后一次写入 20:03:46.4211472Z；台账 `~/.dsh/dsh-config-manager/rollback-points/index.json` 里那个点 `rb-mv2to29u-ae62bd7b`（`kind=auto`、`turnSeq=1`、记录 **355 个文件**）的 `createdAt` = 20:03:46.434Z ⇒ **引擎在收尾之后 7.77 秒**才写完这个回合的点（355 文件的捕获耗时就是这 7.8 秒的来源）。客户端旧实现只在挂载后**查一次**、空结果又被 **30 秒**列表缓存锁住、**从不重试** ⇒ 首查撞上这个空窗就永久禁用（点其实已创建）。**口径**：留点发生在回合收尾**之后**，任何一次即时查询都可能早于它；「读到空列表」在窗口内是**暂态**、不是结论。修法 = 收尾后**有界重试**（窗口 30 秒；退避 0.5 / 1.5 / 3 / 6 / 12 秒，累计 23 秒；最多 6 次列表读取 = 1 首读 + 5 重试；**命中即停**；**每个挂载只跑一轮窗口**，重新进入视图再开一轮 —— 不是无限轮询；重试轮用 `force` 跳过那 30 秒缓存去宿主再读一遍并写回），窗口内如实说「正在读取回滚点…」、**只有窗口关掉且仍为空**才说「这个回合还没有回滚点」。护栏 = `src/client/chat/chat-entry-view.test.ts`（R1 六条）+ qa 独立复核 `.tmp/verify-r1/` **26 / 26 pass**（虚拟时钟复现「首查空 → 1–8 秒后点出现」：修复前 1 次读取 ⇒ 永久 `noPoint`/禁用 ↔ 修复后 5 次读取 ⇒ 可点；空会话恰好 6 次读取且窗口后零请求；失败保持 `resolved:false` 乐观口径；卸载后退掉定时器且宿主不再被打）。**NOT VERIFIED**：真机浏览器点击、真实 7.8 秒挂载窗口的端到端取证（时序在虚拟时钟上按同形序列复现）、组件级 effect 重跑次数（`.tsx` 在 node 下不能 type-strip）。登记见 `docs/spec/known-gaps.md` G-30 / G-39 增量（三）。**StrictMode 双调用（dev）**：窗口状态机改为「每次 effect 调用新建实例」后，`start → dispose → start` 不再让窗口永久 `open`（旧形态实测 reads=1、state 恒 `{lookup:null, open:true}`、按钮永久停在「正在读取回滚点…」）；StrictMode 全程宿主读取仍为 **6 次**（被 dispose 的在途读被同会话去重吸收），并顺带修掉「首读在途显示可点」的诚实缺口（在途 = `pointsPending`）。

- **enablement 判据与确认判据必须分层：同一个标志既当可用性前置、又只能由该可用性动作置位时就是死锁（2026-10-11，用户截图：回退预览主按钮永久灰）**：症状 = 聊天「↺ 回退」的预览弹窗**打得开、文案正常**，主按钮「回退」**灰色不可点** ⇒ 整条回退路径不可用。根因 = `submitEnabled = canSubmitRewind(draft, preview) && !busy`，而 `canSubmitRewind` 要求 `draft.confirmed === true`；`confirmed` 初值恒 `false`（`defaultDraft`），**唯一置位入口** `confirmOnSubmit()` 只在 `submit()` 里被调用，而 `submit()` **只能由这个按钮触发** ⇒ **循环依赖**。修法 = 新增 `rewindSubmittable(draft, preview)`（= 固定段集合非空 + `rollbackPreviewVerdict().canRestore`，**不看 `confirmed`**）作为**可点性**判据（对话框实际接线走 `submitButtonEnabled({ draft, preview, pointId, busy })`，t6 复核后并入 `pointId` 与忙态）；`canSubmitRewind` = enablement + **恰好** `confirmed === true`；两者共用私有 `rewindViable`（单一真相）。**确认门未松**（`defaultDraft` 恒 `false` / 唯一置位点 `confirmOnSubmit()` / `buildRewindOptions` 恰好 `true` / 宿主 `userConfirmed !== true` → `confirmation-required` 逐字未动）。**夹具教训（本条最可复用的部分）**：断言用**已确认 draft**（`confirmedDraft()`）当夹具会**掩盖真实初始态缺陷** —— 凡涉及「初始态可点性 / 可提交性」的断言，夹具必须是**用户真实看到的初始态**（`defaultDraft(preview)`）。参考实现 `https://github.com/Anionex/dsh-turn-rewind` 把确认定位在「点击那一刻」（exact two-step confirmation），**确认不得反向成为按钮可用性的前置条件**。护栏 = `src/client/chat/rollback-entry-view.test.ts` 新增 5 条 R1 + t6 复核追加的 R2（F2 源码级绑定守卫含反向自检 / F4 同步 single-flight 锁）+ qa 独立验证 `.tmp/v1-verify/verify-v1.mjs` **100 PASS / 0 FAIL**（`git archive HEAD` 修复前真代码并列求值：修复前 `false` ↔ 修复后 `true`；差分 13×8×16 = 0 差异；6 种 `canRestore=false` 仍禁用；端到端 seam 替身 200 + `childSessionId` + 真导航一次）。**NOT VERIFIED**：真机浏览器 / DOM 的 `disabled` 取证（本仓无组件测试框架；bundle 依赖 DSH 运行时）、真机点击端到端。登记见 `docs/spec/known-gaps.md` G-30 / G-39 增量（四）。

## 用户消息气泡在浅色主题下与页面同色 = 看不见（2026-10-15 用户反馈）

- **症状**：对话回退相关改动上线后，**浅色主题**下聊天里的用户消息**没有气泡**（文字直接浮在页面底色上）；深色主题正常。
- **根因（令牌取错层，不是「观感近似」）**：我们接管 `conversation.chat.node` / `user` 后自复刻那条气泡，底色写的是 `--cm-surface-2`（= `--dsw-alias-bg-layer-2`）。宿主真机令牌链（`dsh-client-ui-theme/lib/client.js` 的 `design-platform.css` 内联块）：`body{--dsw-alias-bg-layer-2:var(--dsw-static-neutral-bluish-00)}` + `body{--dsw-static-neutral-bluish-00:#fff}` ⇒ 浅色 = `#fff`；页面底 `--dsw-alias-bg-base` = 同一个 `neutral-bluish-00` = `#fff`（**无色差**）；宿主自己的气泡底 = `--dsw-specific-bubble` = `--dsw-static-deepseek-50` = **`#edf3fe`**。深色下 `--dsw-alias-bg-layer-2` 与 `--dsw-specific-bubble` **恰好同值**（`--dsw-static-neutral-bluish-850`）⇒ **只在浅色暴露**。这条差距当时被登记成「附加观感差异（已追认，不修）」—— 定性错了：不是差一点点，是**不可见**。
- **改法**：新增语义色 `--cm-chat-bubble`（§1 的 `body` 与 `.chatEntryScope` 各声明一次），`.chatBubble` 只消费它。**不硬编码 `#edf3fe`**（宿主主题可换，跟随 token 才能自动同步）；**兜底不可省、且必须是可见色**：无兜底的 `var()` 在宿主删档时会让整条声明失效 → 退回 `transparent`；兜成 `--dsw-alias-bg-layer-2` 也没用（浅色下它**同样**是 `#fff`，气泡照样消失）—— 现为 `color-mix(in srgb, var(--cm-text-1) 12%, transparent)`（两个主题都可见；对照 XSJUSTC/dsh-rewind 的 `rgba(127,127,127,.14)`）。
- **可复用判据**：复刻宿主外观时，凡「我们的近似 token 与宿主 token 在**某一个主题**下取值相同」的巧合，都要在**两个主题下各算一遍**再判定差距是否可接受 —— 本缺陷正是被「深色恰好同值」掩盖成「只是浅一点的差异」。定案前先做一张「浅色宿主值 vs 浅色我们值」的对比表。
- **护栏**：`src/client/chat/chat-entry-view.test.ts` 的源码级用例（宿主 token + 兜底 + `.chatEntryScope` 重声明 + `.chatBubble` 不裸写 `--dsw-*`）；产物核对 = `npm run build` 后 `lib/client.js` 含该 token 声明。登记见 `docs/spec/known-gaps.md` G-39 增量（五）。

## 用户消息气泡的字号不跟随「内容字号」（2026-10-17 issue #93）

- **症状**：宿主「设置 → 外观 → 内容字号」（10–22，默认 14）对**用户自己发出的消息完全无效** —— 调到 21 时助手正文 ≈21px、气泡仍是 12.5px（报告者同一张截图的字形高 19 vs 11，比例 0.58），换行位置也与原生气泡不一致。
- **根因（写死 + 遮蔽，不是「观感近似」）**：`.chatEntryScope` 把正文基准写死 `--cm-fs-base: 12.5px`（那是 §1 的**插件面板**基准）+ `line-height: 1.5` + 固定限宽 `min(620px, 82%)`；而 `priority -1` 遮蔽了宿主 `user` cell ⇒ 宿主自己那条 `font-size: var(--dsh-content-font-size,14px)` 根本不参与。**这是同一组件上第二次把「近似档」误判为可接受**（上一次是底色）：共同判据 = 只要那条差异让**某个用户设置失去作用**，它就不是近似，是缺陷。
- **宿主口径（本机 `app.asar` 抽出的 `dsh-client-ui-chat/lib/client.js`，逐字）**：`.cJsG2q_bubble{font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}`、`.cJsG2q_userStack{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)}`。
- **变量可继承性（决定修法只需写 `var()`，不必自建 JS 同步）**：`--dsh-content-font-size` 由 `dsh-client-ui-layout` 的 `ThemePresenter` 写在 **body** 上；`--dsh-content-font-delta` 由 `dsh-client-ui-theme` 定义在 body；`--dsh-chat-content-width` 定义在 `dsh-client-ui-conversation` 的聊天 body（`.Dc7zOa_body` / `.embeddedBody`）—— 三者都在气泡祖先链上。**抽取过程的一个坑**：asar 头里的 `offset` 是**字符串**，探针若按 `typeof offset === 'number'` 过滤会把 7559 个文件全部跳过（表现为「扫描 0 个文件」而不是报错）。
- **改法（只改一处）**：`--cm-fs-base: var(--dsh-content-font-size, 14px)`、新增 `--cm-lh-base: calc(22px + var(--dsh-content-font-delta, 0px))`、`.chatEntryStack` / `.chatEntryNotice` 的限宽换宿主同式；**兜底必须与宿主同值**（14px / 0px / 748px —— 兜回 12.5px 等于重新脱钩）。§1 `body` 的面板基准 `--cm-fs-base: 12.5px` 与 `--cm-fs-meta: 11px`（时间戳 / 动作标签 / 文件卡）**不动**；后者是**有意保留**，不是遗留。
- **护栏**：`src/client/chat/chat-entry-view.test.ts` 的「气泡字号/行高/限宽跟随宿主内容字号」（跟随变量 + 兜底 + §1 面板基准仍 12.5px + 不得再出现 `min(620px, 82%)` + 定位不到规则块即失败）；产物核对 = `npm run build` 后 `lib/client.js` 逐字含三条新值，且 `bundle-selfcontained` 通过。登记见 `docs/spec/known-gaps.md` G-39 增量（七）。
- **NOT VERIFIED**：本仓没有独立的真机计算样式 / 像素取证（本机 Edge 未开 CDP 端口 9222 / 9333，browser-skill daemon 未运行，React 无组件测试框架）⇒ 真机那半只有**报告者**的像素测量（他打的是一行等价补丁）；行高与限宽两条他未改，真机视觉只有「与宿主逐字同式」作为依据。

## 其他回退插件怎么解决「每条用户消息一个入口」，以及我们抄了什么（2026-10-15）

- **问题**：本插件要「每条用户消息一颗 ↺」，而宿主 `conversation.chat.node` 的 user key 是 keyed 遮蔽位且**没有 children 表** ⇒ 只能接管。接管有两个代价：① 自绘气泡（颜色 / 图标 / 正文都得自己复刻）；② user cell **单占**（与别的接管者不能共存）。
- **对照（三家源码克隆到 `.tmp/ext/` 逐字读；第四家 clone 失败）**：
  - `Anionex/dsh-turn-rewind`：**不接管**。portals 组件挂在 `conversation.session.header.actions`（list 槽位、id 唯一），再 `createPortal` 进宿主自己的动作行 —— 锚点 `[data-chat-flow-kind="user"][data-chat-anchor-key]` → `[class*="actions"]`，用 `MutationObserver(document.body, {childList,subtree})` + 微任务合并刷新；`[data-time-hover-root="true"]` 只作老客户端兜底。**本机实测（0.2.0-rc.2）**：`data-chat-anchor-key` 5 处、`data-chat-flow-kind` 19 处、动作行类名 `xD_KDq_actions` 命中 `[class*="actions"]`，`data-time-hover-root` 已消失 ⇒ 这条路在本机可用。代价 = 依赖宿主 DOM 结构与类名后缀，宿主改版即断（它的 CHANGELOG 有适配 0.1.2-alpha 客户端的记录）。
  - `XSJUSTC/dsh-rewind`：**与我们同构** —— `slots.register({ name:'conversation.chat.node', key:'user', priority:-1 })`，**并且也接管 `steering`**；每个注册各自 `tryRegister` try/catch，注释逐字「Keyed slots throw on a duplicate same-key/same-priority registration (e.g. a client HMR rebuild racing its own teardown)」。气泡底 `var(--dsw-specific-bubble, rgba(127,127,127,.14))` —— **宿主 token + 可见兜底，没有我们那个白底白背景 bug**（反向验证了 2026-10-15 的修法方向）。
  - `Arbeiter-bit/dsh-reedit`：**同样接管**（注释：「the shipped renderer keeps its action row internal and exposes no hook」），但正文用**运行时** `require('@deepseek-ai/dsh-client-ui-primitives').projectUserText` 渲染（拿不到退纯文本），并用 `props.openFile` / `props.openSkill` 让 chip 可点开。
  - `DDDonzy/dsh-history-rewind`：仓库 404（搜索命中、clone 失败）⇒ **无证据，不猜**。
- **可复用结论**：① 框架层**不存在**「两个插件共占同一 keyed cell」的机制（同 key + 同 priority 再注册抛错，**最低 priority 渲染**）⇒ 要么一起抢（靠 try/catch 不打挂自己 + 跟宿主 token 保颜色），要么改走 DOM Portal；② 「ui-primitives 包私有、不可导入」**只对构建期 import 成立** —— 运行期插件工厂的 `require` 能命中 shell 的 static module seed（本仓 `RollbackFileIcon` 自 2026-10-12 就在用，只是气泡没用）⇒ 这才是 G-39 差距①②一直没关的真正原因。
- **本轮落地**：`src/client/common/host-primitives.ts`（帧内惰取门，RollbackFileIcon 改为复用它）+ 正文走宿主 `projectUserText` + 文件卡走宿主 `FileTypeIcon` + user cell **让位探测**（`ctx.slots.entriesOfSlot`）+ 气泡兜底色改**可见** `color-mix`。登记 = `docs/spec/known-gaps.md` 增量（六）、规则 = `DESIGN.md` 聊天入口节。

## DSH 0.2.1 换掉了用户消息的图片位：接管方必须把正文委托回宿主的 content factory（2026-10-17，issue #92）

- **症状**：升级到 DSH 0.2.1-rc.1（本机复核用 0.2.1-rc.2）后，聊天里**每条用户消息的图片附件全部消失**，只剩一行灰字「宿主没有提供图片渲染位，这条消息里的图片无法显示」（`chat.entry.noImageRenderer`）；文本、文件卡、引用、↺ 按钮都正常，同一张图在助手消息 / trajectory / tool call 里也都正常 ⇒ 只坏在本插件接管的那条气泡。停用插件即恢复。
- **契约换代（本机解包实测，不是推测）**：把 `@deepseek-ai/dsh-client-ui-chat` 的 `lib/client.js` 与 `lib/types/client/contract/slots.d.ts` 新旧两版都摊开数出现次数 —— 本机已装 **0.2.0-rc.2（旧）**：`renderMessageImages` **21** 次、`conversation.message.images` 在 ui-chat 的 `conversation.view` children 里有声明；npm 拉 **0.2.1-rc.2（新）**：`renderMessageImages` **0** 次、`conversation.message.images` **0** 次，新增 `conversation.chat.user.content`（**Factory**，children = `conversation.chat.user.images` **single/session**）与 `conversation.chat.message.images` / `conversation.images.content`。`ChatNodeOwnerProps` 里 `renderMessageImages` 与 `openSkill` **整行删除**，只留 `loadImage`。
- **失效链恰好落在「探测通过、注册成功、但 props 里没有那个函数」这一格**：`conversation.chat.node` 仍是 keyed、我们 priority -1 仍低于宿主默认 0 ⇒ 接管成功；但 `typeof renderMessageImages === 'function'` 为 false ⇒ 每张图位置走**设计好的静默降级**（一行灰字，无报错无告警）。**形态探测门挡不住这种换代** —— 探测的是槽位形态，换代换的是 owner props 上的能力席位。
- **判据不能写成「`renderFactorySlot` 是不是函数」**：ui-renderer 的 `standardKit()` **无条件**给每个渲染组件发 `renderFactorySlot`（实测源码：`const kit = { ...standard, renderFactorySlot: boundRenderFactorySlot(entry) }`），所以新旧宿主上它都是函数 —— 单判它会把 0.2.0 也误送进新路径。真正的裁决点是**那条 factory 注册没注册**：`FactoryOutlet` 在定义缺失时渲染调用方给的 `fallback ?? null`（同一份实测源码）。于是「老宿主 / 新宿主 / 宿主中途撤掉 factory」三格都有确定行为，不需要开两条发布线。
- **改法（双栈，一个版本同时兼容 ≤0.2.0 与 ≥0.2.1）**：接管 `user` 之后**不再自绘正文**，改为 `renderFactorySlot('conversation.chat.user.content', { content, loadImage, facts, interactive: true })`（入参逐字对齐宿主 `UserStyleBubble`：`content` = 正文/附件/rest/引用，`facts` = `{ sessionLabels?, skillNames? }`；正文必须是**未投影**原文，chip 由 factory 内的 `conversation.user.text` 投影），并把**原自绘气泡**作为这次调用的 `options.fallback`。图片由 ui-attachment 在新槽位上 `renderSlot` ⇒ 与宿主原生气泡同构；宿主以后再改图片实现也不用跟。
- **为什么没加「既无 renderMessageImages 也无 renderFactorySlot 就不接管」的注册期兜底门**（issue #92 给的另一档）：注册发生在渲染之前，那时拿不到组件 props，只能靠声明探测；而「factory 的 children 槽位能不能被声明探测读到」在**本机（0.2.0-rc.2）无法自证**（没有 0.2.1 真机），写一条无法证伪的门风险大于收益。改用 fallback 之后，该格会安全回落到自绘气泡 + 如实提示，不会出空白气泡。
- **同名数据必须同趟走查**：宿主 content 走查产出的附件与我们的 `ChatEntryAttachment` **不是同一形状**（宿主是 `{type:'image',image:{attachment}}` 与 `{type:'file',file:原始 FileAttachmentRef}`；我们的 file 只留 name/ext/bytes，**拼不回 FileAttachmentRef**）⇒ 在 `buildChatEntryBubble` 同一次走查里并出 `hostAttachments`（保留原始载荷、同序），交给 `buildHostUserContentInput` 组装。另注：宿主用**字段是否存在**区分「没带」与「空」，所以 `referenceLabels/sessionLabels/skillNames` 在没带时**不得**补空数组。
- **护栏**：`src/client/chat/chat-entry-view.test.ts` 新增 3 条（hostAttachments 原始载荷与同序；content factory 入参 = prepared/facts 且字段存在性语义；组件源码级绑定：委托 + `fallback: ownContent` + `interactive: true` + 转发 `loadImage`）。全量 `npm test` 4537 pass（另 1 条红灯在 `src/core/rollback-point.ts` 的硬编码中文，属他人作用域的在途改动，非本轮引入）。
- **NOT VERIFIED（如实）**：本机装的是 DSH 0.2.0-rc.2，**没有 0.2.1 真机** ⇒ 新路径的端到端取证（真机气泡与宿主逐像素对照、`conversation.chat.user.images` 实际渲染出图）只做到**包级静态证据 + 源码级判据**：契约形状来自 npm 解包 diff，回落语义来自 ui-renderer 源码，未在 0.2.1 上点过一次。用户侧验证路径 = 装 0.2.1 后发一条带图消息，图片应与宿主原生气泡一致；若仍出现灰字，说明 factory 名或入参面还需按该版本的类型声明对齐。

## 回退成功但子会话打不开：抽方法丢 receiver（2026-10-11 真机）

- **症状**：真机 0.2.0-rc.2 web 实例，点「↺ 回退」→ 预览 → 「回退」：回退**本身成功**（徽章「全部恢复」、「恢复 1 项 / 失败 0 项」、子会话已创建），但弹窗立刻挂黄字「会话导航调用失败，子会话 session-N 没有自动打开（子会话已创建）：请手动打开它」——用户被留在原会话，观感就是「回退没用」。
- **现场证据**（临时把诊断渲染进弹窗取现场，取完即回退）：`entry=uiWorkspace list=77 hasChild=true openThrow=TypeError: Cannot read properties of undefined (reading 'signal')` —— 列表里**已经有**这个子会话、入口也是对的，**只有 receiver 是错的**。
- **根因**：`navigationSourcesOf()` 把宿主服务上的方法抄进**新字面量对象**（`{ openSession }` / `{ open, refresh, list }`），`buildSessionNavigator` 再 `.call(那个字面量, id)`；而 DSH 的实现读 `this` —— `uiWorkspace.openSession(target) { this.replaceMain(target, this.lifetime.signal, "reveal") }`（`dsh-client-ui-workspace/lib/client.js` ≈34009）、`ClientSessions.refresh() { return this.manager.refreshList() }`（`dsh-api-session-controller/lib/client.js` ≈126446）。换了 receiver，`this.lifetime`/`this.manager` 即 undefined；`refresh` 的失败还会被 `catch` 吞成「刷新无效」。同一 bug 类在宿主侧不存在（`readService(ctx,'sessions')` 返回的就是服务对象本身）。
- **改法**：抽出来的每个方法 `.bind(record)` 绑回宿主服务对象（`openSession` / `open` / `refresh` 三处）；此后 `.call(...)` 的 this 自动失效 —— 正是要的语义。三档降级判据（列表是否已有该 id → 是否 refresh → `degraded`/`failed`/`unavailable` 文案）逐字未动。
- **真机复验（同实例、修复前后各一次）**：修复前 = 黄字 + 停在本会话；修复后同一路径点下去**直接切入子会话视图**（标题栏切换、显示新会话的「预览版说明」），无降级提示。
- **护栏**：`src/client/chat/rollback-entry-view.test.ts` 两条真机形状用例（方法体真的读 `this.lifetime` / `this.manager`，旧夹具是纯字面量方法体所以抓不到）；变异校验：只撤 `.bind(record)`，前者立刻红（66 pass / 1 fail），加回 67/67。
- **同域教训（构建口径，排查顺序相关）**：「入口看不到」要先核对 `lib/` 产物与当前分支是否同源 —— 本仓实测过一份从**另一条分支树**构建的 `lib/`（`lib/client.js` 里连 `conversation.chat.node` 都没有），任何 `link:` 到本仓库的实例都因此看不到回退入口，而源码与测试全绿。核对一行：`node -e "const s=require('fs').readFileSync('lib/client.js','utf8');console.log(s.split('conversation.chat.node').length-1)"`（0 = 产物不含入口）。

## 会话日志「就地截断」在运行中的 DSH 里不可能生效（2026-10-11 定案）

- **用户目标**：不要 fork，直接改当前这条对话（真·就地截断）。
- **做到了什么**：字节级截断**跑通了，并用 DSH 自己的 codec 验过**（实现当时落在 `src/utils/session-log-repair.ts`；定案后按「不留未接线的死代码」撤下，补丁停在 `.tmp/e2e/truncate-inplace.patch`）：
  `planSessionLogTruncate(bytes, boundarySeq)` 保留 `seq <= boundarySeq` 的前缀（**未触及帧逐字节复用**；packed 跨度跨边界 / 前缀不干净 / 保留行引用被丢弃 seq ⇒ refuse），
  `truncateSessionLogFile()` 走修复链同一条安全序列（临时文件 + fsync → 时间戳备份 → 原子换入 → 写后 `sessionLogSelfCheck` → 失败用备份还原）。
  真机数据（隔离 QA 档 25283 B 的 v4 日志）：截到 `seq<=4` ⇒ `keptRows=5 / droppedRows=16`、25283 B → 569 B；官方 catalog 复验前后都 `{verified:true,strong:true,equivalentToReadPath:true}` ⇒ **文件合法、DSH 现役读盘路径能读它**。
- **做不到什么**：**运行中的宿主不会重读它**（同一实例三步实测）：① 打开该会话 → 侧栏切「新会话」离开 → 外部把日志截到 1 行（备份齐全）→ 重新打开：**界面仍是老内容**；
  ② 重复一次并**整页刷新 F5**：**仍是老内容**（客户端缓存连同 JS 全清 ⇒ 老内容是从宿主喂回来的）；③ 实验后日志已逐字节还原。
- **根因（源码级）**：① `dsh-session` 的 SessionStore 只有 `create/fork/prepare/enter/detachEntered/announce/emitDisposed/flush/liveEntryFor/get/list/_forkBoundary`，**没有 truncate/removeEvents/drop**；
  ② `dsh-api-session-controller` 的 dispose/detach 只挂在宿主持有的会话工厂上，**不对插件开放**；③ `dsh-session-persistence-jsonl` 对活动会话持有独占写租约 + 累积 cursor。
  对照插件（dsh-turn-rewind）README 亦自述 "DSH Session logs are append-only…"。
- **定案（无感替换）**：回退 = 官方 fork + 自动切到新会话 + **原会话收进「已归档」**（官方 `workspaces.archiveSession`）+ 标题随日志前缀继承；归档失败**三态如实**回报。

## 回退四类真机缺陷与修法（2026-10-11 用户截图反馈）

- **① 弹窗主按钮变裸文字（黑字、无边框）**：设计 token `--cm-*` 只定义在 `.section` 上，而回退弹窗走 `Dialog.Portal` 渲染进 `body` —— 自定义属性继承不到 ⇒
  `background: var(--cm-accent-fill)` 解析失败（无底色）、`color: var(--dsw-alias-label-primary-foreground)` 也拿不到（字色继承成黑）；同排 ghost 按钮边框走 DSH 根上的
  `--dsw-alias-border-l2` 所以照常显示 —— 「一个有框一个没有」正是作用域指纹。**第一次改法（不够）**：搬到 `:root` —— 用户回「背景还是不生效」。
  **真因**：DSH 的设计 token 定义在 **`body`** 上（`dsh-client-ui-theme/lib/client.js`：`body{--dsw-static-…;--dsw-alias-button-info-fill:var(--dsw-static-deepseek-500);…}`），
  而自定义属性是在**声明它的那个元素**上做 var() 替换：`html` 上没有 `--dsw-*` ⇒ 挂在 `:root` 的 `--cm-*` 链在 html 阶段就变成无效值，子元素继承到的仍是无效值。
  **最终改法**：token 块挂 **`body`**（与 DSH 同层 ⇒ 替换成功；settings 区与聊天槽位（含 Portal 进 body 的弹窗）全能继承）。`css-token-guard`/`css-scale-guard` 11 条守卫全绿。
  **同时踩到的第二个坑**：改完 CSS **忘了 `npm run build`** ⇒ 用户拿到的 `lib/client.js` 里主按钮仍是旧声明（`color: var(--dsw-alias-label-primary-foreground)`）。
  验证口径：`node -e "…readFileSync('lib/client.js')…"` 查 `body{--cm-`、`--cm-accent-fill:var(--dsw-alias-button-info-fill)`、`background:var(--cm-accent-fill);color:var(--cm-text-on-accent)` 三个字符串。
- **② 回退后的会话落到「未分组」**：DSH 自己的 fork（宿主 `SessionCommandController.fork`，`dsh-api-session-controller/lib/index.js`≈34971）在拿到 childId 之后还有一步
  `workspace.attachSession(childId)`；我们为钉边界走的是底层 `SessionStore.fork`，缺这一步。**改法**：`DshSessionStoreFacade.forkSession` 补 `attachChildToParentWorkspace`
  （只认 `sessionIds` 含原会话的记录，方法 `.call(record, childId)` 保 receiver；拿不到/写失败降级成 `warning: workspace-attach-failed`）。
- **③ 回退后的对话变成「排队发送」一条消息**：用户在上回合还在跑时排队发的消息，日志顺序是 `… turn/end → user/message(surfaceOp='append') → agent/inbox/spliced → turn/start …`；
  边界取 `startSeq-1` 就把这段**尚未被消费的输入**切进子会话。**改法**：留点器记录「未收尾回合期间出现的待消费输入」的首个 seq，用它当边界来源
  （与 DSH 自己的 `latestCompletedPrefixBoundary` 同口径）；`RollbackTrackedEvent` 因此多带 `surfaceOp`。测试 R-02b。
- **④ 「工作区的文件没有被成功回退」→ 定案 A 并已实现（`removeCreated`，回退路由默认开启）**：回退时先算**全量**「该点未记录」清单（与 `scanLeftovers` 同一套 walk 口径），
  顺序刻死「记录在案的路径先写并复核通过 → 才删新建的」，每条删除先读前像、任一失败整体回滚；超过 `ROLLBACK_MAX_CREATED_REMOVALS`（5000）整套拒绝，
  **绝不删一半**。拒删判据（如实进 `createdSkipped`）：分块外 / 插件数据区 / 路径含 `.git`、`node_modules` / 非绝对路径 / 单文件超 `maxFileBytes`。
  **注意**：这是**破坏性**动作、由用户显式定案；渲染成「不会被删除」的老文案已同步改成「回退会删除它们」。测试 R-05b（真删 + `.git` 拒删）、R-05（不给 `removeCreated` 时仍只报告不删）。

## 「工作区被修改的文件没被撤回」的真正根因：留点时机（2026-10-11 定性并修复）

- **症状**（用户连续两轮反馈）：回退后对话退回去了，但**这一回合改过的文件内容没变**；预览那句是「工作区与该回退点一致」。
- **诊断**：留点器在 `turn/end` 才 `capturePoint`，而那一刻的工作区已经是**这一回合改完之后**的样子 ⇒ 点的「工作区态」= 现状 ⇒ 回退时逐文件比对全部「已一致」，一条都不写；
  被这一回合改过的文件当然也退不回去。`removeCreated`（删该点未记录的新建文件）只治了「新建」那一半，「改过」那一半必须靠**把点拍在回合之前**。
- **参照实现**（用户点名要看的 Anionex/dsh-turn-rewind，其 README 自述 "Message-anchored project-file recovery" / Change Ledger）：
  `create restore point ↓ agent/user/external tools modify the worktree ↓ preview exact path-level drift ↓ review a full or selective restore plan` —— 即**先把工作区拍在消息那一刻，再让 agent 去改**；
  它也说明「never commits, stashes, resets, switches branches, edits the Git index」，普通目录快照默认排除 `.git`/`node_modules`（+ 可选 `.dsh-rewindignore`），与我们 `createdRemovalRefusal` 的拒删集合同构。
- **修法**：`RollbackAutoTracker.noteEvent` 把留点从 `turn/end` 移到 **`turn/start`**（工作区 = 这条消息之前的状态，会话边界同口径）；`turn/end` 只 `lastBoundary.set(seq)`（轮询/无边界回退用）；
  幂等判据（同回合只留一次）随之搬到 `turn/start`。旧口径下「先 turn/end 再补点」的测试（R-02、台账写失败、no-chunks）已同步翻面。
- **回归测试**：`R-05c` —— 回合内写 `a.txt`（改）+ `in-turn.txt`（新建）→ 回退后 `a.txt` 必须回到 `A1`、`in-turn.txt` 必须消失。
  实测段结果：`{"state":"workspace","status":"restored","detail":["restored=1 verified=1 unchanged=1 leftovers=1 removed=1 createdSkipped=0"]}`。
- **注意**：留点提前到回合开始后，「留点在收尾之后（≈7.8 s）」那条客户端有界重试的理由变了 —— 窗口逻辑保留（它对轮询/缺事件的情形仍然必要），但不再是唯一路径。

## 回退子会话必须挂回原工作区：三档匹配 + 失败不静默（2026-10-12 用户反馈）

- **症状**（用户 2026-10-12 反馈「有时候会把对话放到未分类工作区」）：回退本身成功（子会话已建、客户端已切过去），但新对话有时出现在侧栏**「未分组」**下，且界面**一个字都没说**。
- **根因一：匹配只有一档**。上一版只认「工作区的 `sessionIds` 里含**原会话**」（= DSH `forkWorkspace` 的第一档）。对照 DSH 官方（`dsh-api-session-controller/lib/index.js` 的 `forkWorkspace`）可见还差一档：源会话 `origin==='subagent'` 时它沿 `sessionQuery.traceSession` 的**祖先**找工作区。
  离线复核本机（`~/.dsh/storages/workspace.json` + 各会话 header 首帧）：全仓 1320 个会话目录里 52 个 `isSeeded=true`，其中除 2 个 depth=0（DSH 自己的分叉）**全部 depth=1 且 owner=NONE** —— 子代理会话本来就不直接属于工作区；同时存在**原会话自己就不属于任何工作区**的普通会话（如 `session-ea09e0f5` / `session-b93d39b9`，cwd 与既有工作区一致但不在任何 `sessionIds` 里）⇒ 这两种形状下唯一那档必然落空。
- **根因二：warning 在边界被丢**。宿主 `DshSessionStoreFacade.forkSession` 早已返回 `warning: 'workspace-attach-failed'`，但 `RollbackForkOutcome` / `RollbackForkCarrier` 的类型与两条接线（`src/index.ts` 的引擎端口、`src/routes/recovery.ts` 的 `forkSeamOf`）都只读 `childSessionId` ⇒ 引擎没有指引、界面没有提示。
- **改法**：`attachChildToParentWorkspace` 三档 —— ① 直接命中 → ② `parentSession` 血缘上溯（环保护 + `ANCESTOR_LOOKUP_MAX_DEPTH`=8）→ ③ **子会话 cwd 与工作区 `path` 一致**。第 ③ 档不是「硬塞」：DSH 的成员判据本身就是 「canonical cwd === workspace.path」，`attachSession` 落盘前会再复核 cwd 与 `stat`，对不上直接抛 ⇒ 只可能挂到合法工作区。任一档抛错**换下一档继续找**（`attachChildTo` 内部 catch），三档都拿不到才回报 warning。
- **不静默**：warning 一路带到回退结果 → 段落 `guidance` 多一条 `rollback.guidance.sessionNotAttached`（zh/en），聊天弹窗（`chatRewindNotices`，过滤掉已由子会话行表达的 `sessionForked`、按 key+detail 去重）与设置页回滚卡都会如实渲染「会出现在侧栏「未分组」下；回退本身已生效」。
- **护栏**：`src/index.facade.test.ts` 3 条（cwd 归位 / 第一档抛错后同目录兜底 / 子代理血缘）；`src/core/rollback-point.test.ts` R-12 两组断言（归位成功无多余指引 + `workspaceAttached=true`；带 warning 时回退仍 `restored` 且指引含未归位码 + `workspaceAttached=false`）；`src/client/chat/rollback-entry-view.test.ts` 的 `chatRewindNotices` 用例。
- **未验证（如实）**：本机没有运行「带该修复的构建」的实例（`~\.dsh\profiles\desktop\node_modules\dsh-config-manager` 是 0.1.71 发布版，`/recovery/rollback-points` 在该实例上 404，即**不含**本插件回滚族）—— 真机端到端「回退后子会话出现在正确工作区」未复验，证据止于单元/引擎/客户端判定三层测试与离线数据复核。

## 归位失败的唯一真机原因是「cwd 只有活会话一个来源」（2026-10-17 真机取证）

- **症状**（用户 2026-10-17 反馈）: 用「↺ 回退」回退对话后，新对话有时出现在侧栏**「未分组」**下。
- **现场（本机 2026-10-17 全量扫描）**: `~/.dsh/sessions` 下 1452 条会话里，「有 `parentSession` 且 `isSeeded`」的回退 fork 共 **255** 条，其中不在任何工作区 `sessionIds` 里的 **241** 条 —— 而这 241 条的 `header.cwd` **全部**能对应上一个**已注册工作区**的 `path`（折叠比较），也就是第 ③ 档「同目录」本该把它们全部收回。回退台账 `rollback-points/index.json` 里能找到同刻的 `kind=guard` 救援点（比子会话创建早 355 ms），可确认这些子会话确实由本插件回退产生（不是 DSH 原生分叉）。
- **根因**: 第 ③ 档的 cwd 只读**活会话** `ctx.get(sessions).get(id).header.cwd`，拿不到就直接 `cwd-unavailable` —— 而 DSH 自己的读法（`dsh-workspace` 的 `readSessionHeader`，`lib/index.js:911`）有**磁盘回落**（`sessionPersistence.list()` 的 header 缓存，同上 `listStoredHeaders()`）。
- **真机取证（同源实现，直接跑）**: 对已有历史会话调 `POST /api/dsh-config-manager/recovery/fork-reconcile`（t17 复用的正是 t10 那份三档实现）—— `scanned 918 / candidates 918 / attached 619 / already 14 / refused 285`，且 285 条拒绝理由**全部是 `cwd-unavailable`**（285/285）。同一批数据同时**排除**了另外两支：DSH 的 `attachSession` 与我们的 `list()` 复核在真机上都工作正常（619 次写入全部复核通过），所以「挂不上」不是 attach 被拒、也不是复核假红。
- **改法（本仓已落地）**: ① cwd 多源候选 —— 子会话（活 header → 落盘 `sessionPersistence.list()` header）+ 父会话（DSH 的 fork 逐字继承父 cwd：`dsh-api-session-controller` 的 `SessionCommandController.fork` 写 `meta.cwd = source.header.cwd`；同处 `agents.create` 的 meta 里就带着它）；② 归位失败自动**重试一次**（fork 刚落地时索引/持久化可能未就绪，属时序性失败；三档判定与 `attachSession` 幂等，重试零副作用）；③ 失败时把 `{at,parentId,childId,reason,detail}` 追加到 `<插件数据根>/logs/rewind-workspace-attach.jsonl`（桌面版拿不到宿主 stdout，旧实现只留界面一句 warning）。
- **护栏**: `src/index.facade.test.ts` 新增 3 条 —— 活会话读不到但落盘 header 有 cwd ⇒ 仍归位；子会话 header 无 cwd 但父会话有 ⇒ 仍归位；两条都拿不到 ⇒ 如实返回 `workspace-attach-failed:cwd-unavailable` 且诊断文件落一行可查记录。
- **仍未验证（如实）**: 修复后的**真机端到端**（需重启 DSH 载入新构建后再跑一次 `POST /recovery/fork-reconcile`，那 285 条应被收回去）；证据目前止于真机现场数据 + 单元测试。
## 回退 fork 必须走官方 sessionController.fork：底层 SessionStore.fork 造出的会话不落盘、没有 agent（2026-10-12 用户截图）

- **症状**（用户 2026-10-12 截图）：回退之后想继续对话，界面报 `resume failed for session "session-1": SessionPersistenceNotFoundError: session "session-1" not found (gateway/internal)`。
- **根因**：`DshSessionStoreFacade.forkSession` 此前直接调底层 `ctx.get('sessions').fork(source, boundary)`（宿主 `dsh-session` 的 `SessionStore.fork`）。它只在**内存 store** 里造一条会话记录（`prepare()` 用进程内计数铸 id，第一个就是 `session-1`），**不经过 `ctx.agents.create`** ⇒ 没有 agent、没有持久化句柄。用户发下一条消息时，宿主 `SessionCommandController.resolve → resume → ctx.sessionQuery.observeSession` 去**磁盘**上找它 ⇒ `SessionPersistenceNotFoundError`。DSH 自己的 fork（`SessionCommandController.fork`）走的是 `ctx.agents.create({sessionId: uuid, seed, ...})`，顺带完成落盘与 `workspace.attachSession`。
- **离线取证（本机 2026-10-12）**：`~/.dsh/sessions/**` 下 **0 个** `session-<数字>` 目录，而 `~/.dsh/storages/workspace.json` 的工作区成员里**确实有** `session-1`（= 我们的归位确实挂上了，但那个会话在磁盘上不存在）。同族证据：会话目录里 52 个 `isSeeded=true` 全部来自 `agents.create` 路径，且都带 `parentSession`。
- **改法**：`forkSession` 改为惰取 `ctx.get('sessionController')` 并调 `fork({ sessionId, atSeq })`（`SessionController.fork` → `SessionCommandController.fork`；`Remote` 只是标记装饰器，进程内直调执行的就是原实现）。返回 `{ sessionId }` 作为子会话 id。宿主没有该服务时**结构化失败**（`session-controller-unavailable`），**不再退回**底层 store fork —— 宁可如实报「会话段未回退」，也不造一个不能继续对话的会话。归位三档保留为兜底（官方路径已挂过，幂等）。
- **护栏**：`src/index.facade.test.ts` —— ①「必须走 sessionController.fork」用例里给底层 store 放一个**一调就炸**的 `fork`，真走底层必红，并断言 `{sessionId, atSeq}` 逐字透传；② 无 `sessionController` ⇒ `{ error: 'session-controller-unavailable' }`（不得产出子会话 id）；③ 三档归位的三条用例改为 mock `sessionController`。
- **未验证（如实）**：真机「回退后能继续对话」未复验（本机运行实例装的是发布版 0.1.71，不含回滚族）；证据止于源码级取证（DSH 两处实现 + 本机磁盘/注册表数据）+ 单元测试。

## 「查看」把单文件差异开进 DSH 右侧栏：tab 注册契约与三个坑（2026-10-12 源码核实）

- **需求**：回退预览弹窗里点「查看」要看到该文件「当前 → 回退后」的逐行差异（Cursor 的 View Diff 位），并且要开在 DSH 的右侧栏里，而不是自己再造一个面板。
- **DSH 侧栏契约**（真机 `app.asar` 内 `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`，0.2.0-rc.2）：
  - 服务由该包 `provide` 两个面：`sidebarRight`（controller）与 `sidebarRightTabs`（类型注册表）；controller 有 `openResource(address, options)` / `openTab(kind, options)` / `openResourceIn` / `focus(tabId)`。
  - 资源地址方案固定为 `dsh-resource://<type>/…`（`placeResource` 里 `address.startsWith(RESOURCE_SCHEME)`，否则抛）；地址由某个已注册类型的 `patterns` 认领。
  - 类型定义形状：`{ id, kind, patterns, title(address), canOpen?(address), priority?, multiple?, guide? }`；**`id` 同时是正文注册用的 key**（自带文本预览的 id 就是它的包名 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）。
  - 正文：`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id>, locale, inject }, Body)`（keyed / session 位）；body 由 seat 注入 `useTabInfo()`，`tab.contentId` = 打开时用的那个地址 ⇒「同一文件开两个标签各看各的」不需要全局变量。
- **三个坑**：
  1. `openResource` / `register` 都读 `this`（`this.require()` / `this.ids` / `this.kinds`）—— 抽出来的方法**必须 `.bind(record)`**，否则「打开」与「注册」必然抛（与 `uiWorkspace.openSession` 丢 receiver 是同一类事故）。
  2. 服务可能比本插件晚挂载：类型注册要在装配期做一次，再用 `ctx.inject(['sidebarRightTabs'], cb)` 补一次；`register` 对重复 id **会抛**，所以补试必须幂等（自己记「已经成功过」）。
  3. 正文位要先探形态（`ctx.slots.spec('sidebar.right.pane.tab')` 的 `kind === 'keyed'`）：0.1.x 没有这个槽位，硬注册会把 `slots.inject` 回调打挂。
- **本插件落点**：地址 `dsh-resource://cm-rollback-diff/<pointId>/<encodeURIComponent(绝对路径)>`（id 与路径**都编码** ⇒ Windows 盘符/反斜杠不进地址正文）；类型与正文注册在 `src/client/index.ts`，纯逻辑 + 收窄在 `src/client/chat/rollback-diff-tab.ts`（bind 与形态探测都有单测）；拿不到侧栏能力时**降级为弹窗内展示**同一份差异并说明原因 —— 绝不假装打开过。
- **未验证（如实）**：本机没有运行「带本次改动的构建」的实例（`~\.dsh\profiles\desktop` 装的是发布版 0.1.71，不含回滚族），所以「点查看 → 右侧栏真的出现标签页」**未经真机复核**；证据止于源码级契约核实 + 纯函数单测 + typecheck/全量测试/构建。
## 「崩溃前根本没写过」的残留永久占 SAFE MODE（2026-10-12，issue #87 源码核实）

- **触发**：宿主被**强制结束**（TerminateProcess 级，非 Ctrl+C / 非优雅退出）后，下次启动常驻 SAFE MODE。真机残留 4 条（用户侧 `transactions/quarantine/`）全部 `snapshotId: null` ⇒「执行恢复」永远灰着，唯一出路是语义为「放弃」的那颗按钮。
- **三段根因（源码逐条核实）**：
  1. `src/core/phase3-host.ts` 的 `probeExternal: async () => 'unknown'` 是常量 ⇒ `reconcile` 里每个 external step 必落「不可证明」；`ReconcileProbeHooks` 接口本身完备（5 种取值），只是宿主侧没实现。
  2. 同一文件 `runExternalIntent` 写 external step 时固定 `status:'planned'` / `beforeFp: null` / `afterFp: null` / `appliedAt: null`，成功路径只把 journal 推到 `COMMITTED`，**从不回写 step** ⇒ 即使它跑完了也无从判定。
  3. `runExternalIntent` 的 catch 无条件 `writeSafeMode(true)`；与上面两条叠加 ⇒ 一次「备份刚开始就被杀」= `snapshotId:null` + planned external step + durable 标记。
- **第四段（容易漏）**：`src/index.ts` 的启动分类处置是 `safeModeActive = safeModeActive || kind ∈ {RECOVERY_REQUIRED, NEEDS_ATTENTION, UNKNOWN_STATE}` —— **只会置真**。分类判 NORMAL、durable 标记仍在时，本会话写操作继续被 423 挡着（界面却说「无待处理事项」），且下次启动复发。
- **修法（只放行可自证的形状）**：`reconcile` 的新自证门**只对 `backup-schedule`** 生效（`doExport` 只写 `exports/` 归档与插件调度状态，从不改用户配置）；形状门 = state ∈ {APPLYING, NEEDS_ATTENTION} + 无 snapshotId + `commit.at` 空 + rollback 未尝试且无 entryDone + recovery 未尝试 + 全部 step `planned`/`appliedAt` 空；位置在 live-owner / ownership-binding / env-fingerprint 三道信任门**之后**。
- **刻意不做**：`autosync-apply` / `import-apply` 这类**会改用户配置**的通道永远保守；`probeExternal` 只在 journal 真有指纹时才做真实只读探测（无指纹仍 `unknown`）；零步骤的 `sync-push` 老残留仍判 opaque NEEDS_ATTENTION —— 当前 `runExternalIntent` 先落 step 再调 `fn`，但 `runJournaled` 的非 deferred 分支是先转 APPLYING 再调 `fn`，**零 step 不等于零副作用**，不能按形状普放。
- **启动复位判据**：`resolveStartupSafeMode`（`src/core/startup-barrier.ts`）：`NORMAL` + 环境锁 `FREE` + 标记确为 `blocked` → 内存标志与 durable 标记一起清；`LOCKED`（别人持锁）/ 残留锁 / `unknown` 标记一律不动。
- **测试**：`src/core/reconcile.test.ts`（2 放行 + 6 对照）、`src/core/startup-barrier.test.ts`（7 条判据矩阵）、`src/core/phase3-p2b-fingerprint.test.ts`（probeExternal 6 种形状）。
- **未验证（如实）**：issue 报告者用真实数据目录副本跑过 11 例判定矩阵；本次修复**未**回放真实 quarantine 残留（本机无真实样本），证据止于源码核实 + 单测矩阵 + typecheck / 全量测试。

## 非相邻回退：预览的删除集与执行的删除集曾经是两份口径（2026-10-12 用户实测）

- **症状**（用户原话）：同一对话里**跳过中间若干回合、直接回退到更早的回合**时，① 工作区文件没按预期撤回（该恢复的没回来），或**删过头**（不该删的被删）；② 实际改动与**预览清单对不上**（预览只列了几个文件，实际改动 / 删除远超预览）。相邻回退（只退一轮）基本看不出来。
- **根因一（预览 ≠ 执行，文件:行）**：删除候选被**两处各算一次** ——
  预览走 `scanLeftovers`（当时 `src/core/rollback-point.ts:1669`，只按「不在 `captured` 里 + 在 chunks 内」，**不过滤拒删项**，且只取前 `ROLLBACK_LEFTOVER_LIST_LIMIT`(20) 条）；
  执行走 `planCreatedRemovals` + `createdRemovalRefusal`（当时 `:2173`/`:2206`，**全量 + 过安全判据**）。
  两者都叫「leftovers」，但一个只是「未记录」、另一个才是「会删」。
- **为什么随跳过的回合数放大**（这就是「相邻不暴露、非相邻才暴露」的那一行判据）：候选数 = 该点未记录的路径数，它随**跳过的回合数**线性增长。只要候选数越过 20 条上限、或前 20 条里混进拒删项，两个集合就分叉。
  本机实测（探针 `.tmp/probe-nonadjacent.ts`，6 个回合 / 中间 3 个回合各新建 8 个文件 + 各在 `.git` 里塞 1 条 / 从第 6 回合直退第 2 回合）：
  `PREVIEW leftovers.length=20, leftoversTruncated=false, createdAfter=28`；前 20 条 = **3 条 `.git/*`（永不删除）** + 17 条会删；`REWIND removed=25 createdSkipped=3`（`detail=["restored=0 verified=0 unchanged=2 leftovers=28 removed=25 createdSkipped=3"]`）
  ⇒ **8 条「真的会删」的路径根本没被列出**，用户看到的就是「预览只列几个，实际删一大堆」。
- **根因二（删过头 = 删掉回退点之前就存在的文件，不可恢复）**：`captured` 来自 `payload.files`，而捕获受预算约束 —— `payload.truncated`（`maxFiles` / `maxBytes` / `maxFileBytes` 任一命中，`src/core/rollback-point.ts:1374/1378/1400/1405`）或 `unreadableFiles` 非空时，**既有文件**根本没进记录。它们当然「不在 `captured` 里」⇒ 被判成「回退点之后新建」⇒ 删掉，而对象仓里**没有它们的副本**，删了就回不来。
  本机实测（`.tmp/probe-h2h3h4.ts` H3 段，`maxFiles=3` + 6 个既有文件）：修复前 `removed=5`，其中 `pre-5.txt` **在回退点之前就已存在**，回退后 `仍在 = false`。
- **修法（不重写架构、不动 schema 版本）**：
  ① 把「未记录路径的规划」收敛成**一个函数** `planCreatedRemovals(payload, captured, sink)`（返回 `{all, paths, skipped, truncated, refused}`），预览与执行**共用**；`preview.workspace.removals` 与 `segments[].removedPaths` 因此逐条同源同序（旧 `scanLeftovers` 已删）。
  ② 单文件上限判据（先 `stat`）搬进这份规划 —— 预览与执行不再各判一次；读不出大小且非 ENOENT 一律拒删（「不知道多大」≠「可以删」）。
  ③ **捕获不完整的点一条都不删**（`refused='capture-incomplete'`）：`payload.truncated || payload.unreadableFiles.length > 0` 时，「未记录」不能证明「新建」，宁可少删。
  **【2026-10-12 同日后续已推翻这一条】**：`payload.truncated` 在大工作区里恒为真 ⇒ 删除集恒为空（用户第二例的根因）。判据已改为**证明名单**（见本节末尾「删除集的可证性」），「预算截断」本身不再拒删；仍 fail-closed 的只有「证明名单不完整」三种情形。
  ④ 逐条清单仍保留 20 条上限，但**总数与截断如实**：新增 `removalsCount` / `removalsTruncated` / `createdSkippedCount` / `createdSkippedTruncated` / `createdRefusedReason`；界面把「会删的 / 拒删的 / 一条都不删」分成三句说。
  ⑤ 超上限的顶层码从泛化的 `invalid-input` 改成 `created-removals-limit`（HTTP 400、零写入）；文案说清「因为待删路径超过上限，一条都没动」。实测 `removalsCount=5001`：`outcome=failed`、段 `reasonCode=created-removals-limit`、`detail=["created-removals=5001 limit=5000 zeroWrites=true"]`，记录在案的 `a.txt` **一个字节都没被写**（仍是 `A-CHANGED`）。
- **H2（chunks 之外）如实结论**：中间回合在**分块之外**新建 / 改动的文件，回退时**既不恢复也不删除** —— 这是**有意设计**（领土 = 留点时记录在案的 chunks）。实测：`chunks=[<ws>]`，`outside/outside.txt` 回退后仍在、`ws/inside.txt` 被删。此前界面**没有**说清这个范围（`preview.workspace.chunks` 已回传但无人渲染）。**2026-10-12 同日后续（两轮）**：先补了一句 `rollback.preview.chunksHint`（「回退范围 = 留点时记录的 N 个目录…」），用户看到截图后要求删掉 ——「不需要这些没用的描述，我需要页面的整洁」；随后**弹窗里所有说明句**都被要求删掉（第二轮原话：「另有 37 项不会删除（安全判据拒删）这种描述我不需要!!!移除所有描述，我需要弹窗的简洁」）⇒ `chunksHint` / `removalsTruncated` / `createdSkipped` / `createdRefused` 四个键与两处渲染**已整体删除**（聊天预览 + 设置页回滚卡），弹窗只剩「这次回退会做以下改动」+ 选择框 + 文件行。
  **代价与补偿**：删掉「（清单只列前若干条…）」就等于放弃了「清单可能不完整」的告警 ⇒ 同一轮把删除清单改成**全量**（`preview.workspace.removals` 不再切 20 条；`segments[].removedPaths` 同步改成全量、只记真的删掉的），于是**数据本身**保证了「预览列出的 = 实际删的」——不需要任何句子。超 `ROLLBACK_MAX_CREATED_REMOVALS`(5000) 时执行端整套拒绝（一条都不删）⇒ 预览如实给**空集**（这条不变式在任何输入下成立）。
  **有意保留但不渲染**：`createdSkipped` / `createdSkippedCount` / `createdRefusedReason` / `removalsTruncated` 仍在**引擎与 ui 投影层**回传（引擎事实不丢，将来放进 ⓘ 或工具提示可直接用），只是正文不再有对应句子。规则写进 `DESIGN.md §7` 与 `AGENTS.md`（预览/弹窗只留能改变决定的信息，机制与范围解释进 ⓘ 或文档）。
- **假注释（H5，已修）**：`RollbackPreviewFileStatus` 的 `delete` 与 `RollbackPreviewWorkspace.createdAfter` 都写着「绝不删除 / 永远不会出现」—— 与实现（`removeCreated` 缺省为真）相反，会直接误导后续排查；连同 `rollback.desc` / `rollback.rewind.confirm` / `rollback.preview.leftoversTitle` 的「不删除未记录文件」一起改正（旧守卫 `recovery-locales.test.ts` 曾把这条不实表述钉死，本轮翻面 + 加反向断言）。
- **H6（台账链路）**：设置页 / 台账弹窗那条 `RollbackCard` 链路此前**列了**路径，但用的是「未记录」清单 + 标题「（不会被删除）」，而它的 rewind 请求**不带** `removeCreated` ⇒ 路由缺省为真 ⇒ 真的会删。现已改为渲染 `removals`（与执行同源）+ 拒删条数 + 范围说明。
- **护栏**：`src/core/rollback-point.test.ts` 的 **R-05d**（6 回合 / 中间 3 回合各新建文件 / 从最后一回合直退第 2 回合；断言 ①中间回合新建路径被删且 `createdSkipped` 如实 ②目标点记录在案的路径写回且 `restored=1 verified=1` ③预览删除集 = 实际删除集逐条一致 ④拒删项出现在报告里且不在删除清单里）。
  **变异校验**：把预览的 `removals` 换回旧口径（`plan.all`）后 R-05d 立刻变红，失败信息正是上面那份「3 条 `.git` + 漏 8 条」的对照。
- **未验证（如实）**：本机没有运行「带本次改动的构建」的实例（`~/.dsh/profiles/desktop/node_modules/dsh-config-manager` 是发布版，不含回滚族）⇒ **真机浏览器点击端到端未复验**；证据止于引擎/客户端判定两层测试 + 两个探针的真实磁盘数据 + typecheck / 全量测试 / 构建。
## 删除集的可证性：留点被预算截断时，「中间回合新建的文件」为什么一条都删不掉（2026-10-12 定性并修复）

- **症状**（用户原话，第二例）：同一会话里点更早那条用户消息的「↺ 回退」，**只有选中那一回合涉及的文件被改回去**，中间那些回合产生的改动留在工作区里（最明显的是中间回合**新建**的文件，一个都没被删）。
- **根因（文件:行）**：删除候选的「证明」只有一份 `payload.files`，而「留点时它还不存在」这件事**一旦留点被上限截断就无法证明** —— `planCreatedRemovals` 当时把 `payload.truncated || payload.unreadableFiles.length > 0` 当作「捕获不完整」⇒ `refused='capture-incomplete'` ⇒ `paths=[]`（一条都不删）。`payload.truncated` 在工作区文件数 > `maxFiles`(2000) 时**必然为真**，于是大工作区里**每个点都拒删**。
- **为什么「相邻回退不暴露、跳过回合才暴露」**：候选数 = 该点未记录的路径数，随跳过的回合数线性增长；但只要工作区越过 2000 文件，这个判据就已经把删除整体关掉了 —— 相邻回退在**小工作区**里看不出问题（记录完整、候选也少），一旦工作区够大（本仓库 `.tmp/` + `outputs/` + `.git`）就与跳过的回合数无关地全灭。
- **真机取证（本机 `~/.dsh/dsh-config-manager/rollback-points/index.json`，4.15 MB / 23 条记录，最新 2026-10-12 00:40 本地）**：**所有**点的 `truncated=false`、`skippedCount=0`、`skippedTruncated=false`、`files=353..397`、`chunks=["D:\\Projects\\personal\\dsh-settings-tidy"]` ⇒ 那份台账**证伪**了「每个点都截断」（那个工作区只有 ~400 文件）。台账里能看到的具体事实：`hello-world*.md` 8 个文件在 auto 点（`rb-mv4ebzw8`，397 条）里**有记录**，112 秒后的 guard 点（`rb-mv4eeerb`，389 条）没有 —— 它们是**用户/agent 自己**先删掉的（同名 git 检查点 `before-delete-hello-files` 在场），不是回退删的。回退结果**没有落任何历史记录**（`grep rollbackPointRewind` 全数据目录 0 命中）⇒ 那一轮真机 `removed` 计数**无法从磁盘复原**（NOT VERIFIED）。
- **可复现的真机规模证据（本仓库 = 用户报障的工作区，`node .tmp/probe-r05-real.mjs`，生产默认上限）**：
  - A 段（真实仓库树，88 138 个文件，capture+preview **只读**）：`files=2000, truncated=true, skippedCount=86218, skippedRecorded=5000, skippedTruncated=true, reasons={budget-files:4999, link:1}, pathIndex={count:88207, bytes:758280}, reasonDetail="files=2000 skipped=86218(list-capped) ..."`；
    新建一个探针文件后 preview：`removalsCount=1`、`removals=["…\\.tmp\\r05-repo-mid.md"]`、`createdRefusedReason=null`（`createdAfter=1752` 是同一秒里引擎自己写进数据区的对象 + 临时文件，它们全部被 `inside-data-dir` 拒删、不进删除集）。
  - B 段（合成 7 500 文件真实工作区，> maxFiles+maxSkippedEntries）：capture `files=2000, skippedCount=5500, skippedTruncated=true, pathIndex={count:7500, bytes:19707}`；中间回合新建 2 个文件 + 改 1 个**既没进 files 也没进 skipped 的既有文件**；rewind 结果 `removed=2`、`removedPaths=[created-a.txt, created-b.txt]`、`createdSkippedCount=0`、`detail=["restored=0 verified=0 unchanged=2000 leftovers=2 removed=2 createdSkipped=0"]`；复核：两个新建文件消失、被改的那个**仍在且内容未变**（`CHANGED-IN-LATER-TURN`）、既有文件 `7500/7500` 全部存活。
- **修法（方向 A+B，不动 `ROLLBACK_SCHEMA_VERSION`、不动路由计数）**：
  ① 捕获侧把**走查过的全部路径**写进**内容寻址的 gzip 路径索引对象** `payload.pathIndex={object,count,bytes}`（**只在 `skippedTruncated` 时写** ⇒ 小工作区零额外成本；本仓库 88 207 条 / 758 KB，不进台账、由 `gcObjects` 随点回收）。
  ② 判据改成**证明**：候选 = 当前存在、在分块内、且**不在** `files` ∪ `skipped` ∪ `unreadableFiles` ∪ `excludedDirs` ∪ 路径索引 里 —— 留点时被预算挡下的既有文件都在名单里（`skipped` 或索引），**不再**被当成新建。
  ③ **证明不了就一条都不删**（三条 fail-closed 门）：`skippedTruncated` 且索引缺失（老台账）/ 索引读不出（对象丢失 / gzip 坏 / count 对不上）/ `unreadableDirs` 非空（目录内容在留点时刻未知，索引也补不上）。
  ④ 走查上限从 `maxFiles*4` 改成全树：旧上限会在巨型工作区静默漏掉真正的新建文件（那是「删一半」，安全该由**证明**负责，不是由条数上限负责）。
  ⑤ 顺带修掉一个**假尾句**：段的 `restored=0` 只表示「没写回记录在案的路径」，删了文件时顶层 `allNoop` 仍会把整次回退说成 `nothing-to-restore` ⇒ 现在 `restored===0 && (removed??0)===0` 才算无事可做（真机端到端复现：`removed=2` 曾配 `code=nothing-to-restore`）。
- **护栏**：`src/core/rollback-point.test.ts` **R-05e**（`maxFiles=4, maxSkippedEntries=2` 的截断点：中间回合新建的 a/b 被删、`removed=2`、顶层 `code='ok'`；**被预算挡下、既没进 files 也没进 skipped 的既有文件一条都不删**，改过的内容也不许被凭空还原）与 **R-05f**（把索引对象从对象仓删掉 ⇒ `removed=0` + `createdRefusedReason='capture-incomplete'` + 候选全部进拒删清单）；R-05 / R-05b / R-05c / R-05d / R-26 / R-27 保持通过（预览=执行、`.git` 拒删、0 变更语义未回归）。
- **老台账兼容**：索引字段诞生前写下的点没有 `pathIndex` ⇒ 与「索引丢失」同一条 fail-closed 路径（只报告、不删），**不迁移、不改 schema 版本**。
- **未验证（如实）**：真机浏览器里点「↺ 回退」的端到端点击取证（本机运行实例的插件构建与源码不同源：desktop 档案装的是发布版 0.1.71，不含回滚族）—— 证据止于引擎端到端（真实文件系统 + 真实台账/对象仓 + 生产默认上限）、两个探针的真实磁盘数据、typecheck / 全量测试 / 构建。

## 运行中的对话不得动工作区段：两处硬拒 + 判据只读引擎信号（2026-10-13）

**规则**：`preview.session.active === true`（会话日志 mtime 落在引擎静默窗内，缺省 30 s）且这次回退**要动工作区**
（显式 `segments` 优先，否则 `mode !== 'session'`，**缺省 files+session 也算**）⇒ 409 `session-active`、`segments` 恒空（零写入）。
两处都判：路由预检（进锁前）+ 锁内写任何字节之前（TOCTOU）。`mode=session`（只回溯消息）不受影响。

**为什么两处**：预检挡住 UI 默认档与直接打 HTTP 的调用；锁内的第二道挡「预检与执行之间对话又跑起来了」。
**判据只有一份**：路由读 `engine.preview()` 已算出的 `session.active`，**绝不自己 stat 会话日志**（源码级断言：路由源码不含 `logPath`/没有 `fs.stat`）。

**判定链位置（2026-10-13 定案）**：既有护栏**优先** —— 未确认（`confirmation-required`）、该点本就不可回退
（`preview.ok !== true || canRestore !== true` ⇒ `protected-point` / `record-incomplete` / `record-not-found` /
`storage-unavailable`）、SAFE MODE（423）时，把结论让给引擎自己的结构化码；只有「本来能退、只因正在运行而不能动工作区」
才回 `session-active`。否则用户会白等一轮，等到最后拿到 `protected-point`。

**UI 选择**：运行中**禁用**「回退文件的更改」而不是加二次确认 —— 路由已硬拒，给一个「点得动但必然 409」的开关
等于假承诺（与 F3 同一条纪律）；默认档改成 `session`（只回溯消息），弹窗加一句说明。

**连带影响（踩过）**：新不变量会让「会话日志 mtime 是刚才写的」的既有路由用例集体变成 409 ——
`tests/route/recovery-rollback.test.ts` 的 R8-1/4/5/6/7/8 统一报 `409 session-active`（期望 `confirmation-required` /
`protected-point` / 423）。修法：夹具把日志 mtime 拨到静默窗外（那些用例本就该代表「对话不在运行」，它们测的是别的守卫），
并新增一条「运行中带文件段 ⇒ 409 零写入 + session-only 照常 fork」的对照用例。

## 回退的忽略规则、路径身份缓存与容量缺省（2026-10-13）

**规则**：`.dsh-rollback-ignore`（分块根，gitignore 常用子集：`#` 注释、`!` 反向取消、尾 `/` 只匹配目录、
`*`/`?` 不跨段、`**` 跨段）。两条硬边界**不得放宽**：① 内置运行时依赖目录（`node_modules`）不可被反向取消；
② **整个目录被忽略 ⇒ 证明名单不完整 ⇒ 该点的删除集整体拒绝（fail-closed）**；被忽略的**文件**仍逐条进 `skipped`，名单照样完整。

**计数口径**：`skippedCount` **不含** `excludedDirs`（内置依赖目录，另有列表）与 `ignoredDirs`（用户忽略的目录，
总数见 `ignoredDirCount`，恒增计数器）；`recordSkip` 只对 `skipped` 桶 +1。三者的逐条列表都受 `maxSkippedEntries` 约束
（否则台账 payload 随忽略目录数无界增长），但计数绝不跟着缩水。

**路径身份缓存**：路径身份 = `BigInt dev:ino:size:mtimeNs:ctimeNs:mode`，落盘 `rollback-points/path-cache.json`，
**随台账引用 gc**（不被任何点引用的条目会被清掉）；命中即复用 sha256，不重读不重算。缺省容量由 2000 文件 / 64 MiB
放宽到 **20000 文件 / 512 MiB**（同一处改，避免「上限太紧导致留点降级」的误报）。

**未验证（如实）**：未采集大仓库的实测性能数字（只有「命中即不重算」的确定性用例与语义断言）。

## 磁盘体检只报告：回滚点库与遗留检查点（2026-10-13）

**规则**：磁盘体检新增 `rollback-points` 子区（`dataDir/rollback-points`）与「遗留数据」区块
（当前一条 = 升级前的 `checkpoints/`），两者 `policy = 'protected'`、**只报告、永不进清理候选**
（`IMMEDIATE_CLEAN_CATEGORIES` 与清理入口的 `categories` 白名单一字未动，有源码级 + HTTP 双层断言）。
遗留区块**不计入 `totalBytes`**（与子区分列，避免把「不算可清理的东西」混进合计口径）；说明文案走字典键
（core 不内嵌用户可见文案）；读不到 ⇒ `unreadable = true` 且 `sizeBytes = 0`（「不存在」与「被非目录占住」两态都测）。

**真机数据（2026-10-12，只读）**：回滚点库 **7,124,295 B / 385 文件**；遗留 `checkpoints/` **59,705,801 B / 1757 文件**
（后者是前者的 8 倍 —— 这正是「用户看不见的占用」里最大的一块）。

## 历史 fork 归位：`origin='subagent'` 不是 fork 筛选器（2026-10-13）

**规则**：归位对象 = 「有 `parentSession` 的子会话」，**默认全部处理（含 subagent）**；`origin='subagent'` **不得**
当成「回退 fork」的筛选器。理由是真机分布：887 条有父会话的子会话里 `isSeeded` 的 fork 有 **58** 条，而这 58 条里
**50 条自己就带 `origin='subagent'`**（DSH 的 fork 用 `agents.create` 造，标记就是 subagent）⇒ 按 origin 窄化会把
50/58 个目标跳掉。窄化只作为**显式开关**存在（默认关），跳过条数如实回传（不静默）。

**判据只有一份**：逐条归位复用 t10 已落地的 `DshSessionStoreFacade.attachChildToParentWorkspace`（成员 / 血缘 /
cwd 同目录三档 + 写后 `list()` 复核）；路由按结构窄化取用（index.ts 不在任务 scope），形状不符 ⇒ 逐条
`refused('reconcile-seam-missing')`，**绝不假装已归位**。core 只编排（不 import node:*、不碰文件系统、不碰会话日志字节）。

**真机数据（2026-10-13，只读盘点 + 真代码路径 + 影子注册表）**：8 工作区 / 1370 会话头 / 887 有父会话的子会话；
盘点时生效成员 10 条，其中**回退 fork 只有 3 条**。归位：attached **877** / already **10** / refused **0**；
**回退 fork 58 条：attached 55 / already 3 / refused 0**。零写入复核：`workspace.json` sha256 不变 +
1381 个会话日志的 `(path,size,mtime)` 清单不变 —— 写全部落在真实账的**内存深拷贝**上（归位是用户显式触发的一次性动作，
取证脚本不写用户数据）。

**踩过**：`POST /recovery/fork-reconcile` 分支最初放在 `lock` 分支**之后**，把 `runWithMutationLock` 带进了
「lock 分支不得经 acquire」那条源码守卫的窗口（`source.slice(lockBranch, idParse)` 里不得出现锁调用）⇒ 全量测试红。
分支必须排在 `lock` 之前（或该守卫窗口之外）。

---

## issue #88 / #89：回滚点占用失控与总开关（2026-10-14）

**用户侧证据（issue #89，两个人两台机）**：Windows 桌面机 `rollback-points/index.json` = **473,285,138 B**
（50 条记录、950,862 条文件条目、去重后 57,396 条路径），4 份 host 崩溃日志同一句
`FATAL ERROR: ... JavaScript heap out of memory`，退出码 134；崩溃残留 `.dshcm.*.tmp` 累计 **430,682,982 B**。
Linux（web profile）同版本：index.json = **311,521,007 B**（50 条，单条均值 ≈6 MiB），`objects/` ≈1.1 GiB，
残留 tmp 180,914,249 B；高 CPU 相位（主线程 87%）采样 45 s / 31,147 样本，
`rollback-point.js` 家族自耗时 **≈23%**（`readLedger` 5.13%、`gcObjects` 2.27%、`pathKey` 1.00%），
而同机低相位采样里这几个函数**一次都不出现**。移除插件后该文件占比 0.00%。

**机制（0.1.72 源码核对）**：`appendRecord` 在写锁内 `readFile` 整份 → `JSON.parse` → 合并 →
`JSON.stringify(..., null, 2)` → `atomicWriteFile`；`ROLLBACK_MAX_RECORDS = 50` **只限条数、不限字节**，
所以 50 条也能到几百 MiB；触发点是 `turn/start`（工作区态必须是该回合开始**之前**，这条口径不能动）；
一份账本被所有工作区共用（`ledgerPath` 只由 `dataDir` 决定）。

**本机对照**：修前 `index.json` = 8,220,317 B / 44 条（同一数据结构在较小工作区里的规模）。

**改法（已落地）**：v3 台账 = 小清单 `index.json`（只剩元数据 + 载荷哈希引用）+ `records/<id>.json`（单条完整记录）
+ `payloads/<sha256>.json`（内容寻址的工作区载荷，未变化的工作区**只落一份**）；写一条 = 写一个记录文件 + 一个载荷
（哈希相同则复用）+ 重写小清单；对象回收改为「扫清单 → 逐个读引用到的载荷 → 删无引用对象」，
**峰值内存 ∝ 单份载荷 + 对象键集合，不再 ∝ 账本总字节**；旧 v2 单文件用**流式**切分迁移
（`createReadStream` + 逐字符状态机逐个切出 records 元素；451 MiB 的文件整份 `readFile`+parse 必然再次 OOM），
迁移失败保持原文件不动、下次启动重试；新增 `ROLLBACK_DEFAULT_LEDGER_BYTES = 256 MiB` 字节预算，
超预算只淘汰最旧的 auto 点（guard / protected 不淘汰）；启动期清理**形状可自证**的孤儿 `.dshcm.*.tmp`。

**总开关（issue #88）**：缺省**关闭**（`ui-prefs.json` 的 `rollbackEnabled`，只认字面 `true`，fail-closed）。
关闭 = **真的解绑** `session/event` 订阅（不是「订阅了回调里 return」）；开关可在不重载插件的前提下活切换
（写偏好的一方通知进程内 gate → attach/detach）。聊天内入口**收起**而非置灰：入口是遮蔽
`conversation.chat.node` 的 user key 注册的（无常），可见性由客户端信号驱动；老宿主（响应里没有该字段）
按「默认开」处理 —— 那一版语义就是默认启用，藏掉入口等于「有点但没有入口」。

**2026-10-17 追加（用户要求）**：关闭时不只是「收起按钮」，而是**根本不接管**那条用户消息 ——
`registerChatNodeEntryWhenEnabled` 只在信号为真时登记，关掉即撤销（`entriesOfSlot` 回到宿主的
`UserMessageNodeView`，priority 0），打开时当场补登记。原实现（登记常驻 + 组件内 `entryEnabled` 隐藏按钮）
在关闭后仍替宿主画气泡（外层壳与动作行都是我们的），用户看到的就是「关掉了还在接管」。组件里那两道
`entryEnabled` 门因此降级为**兜底**（信号翻转与组件卸载之间那一帧），不再是唯一机制；
纯逻辑闸门 = `src/client/chat/chat-node-registration.ts` 的 `registerChatNodeEntryWhenEnabled`。

**没做（别误读成已完成）**：**增量基线**（记录存「相对上一份的差分」）没做 —— 现在只做到**未变化时零额外字节**，
工作区真的变了仍会写一份完整载荷（由字节预算兜住）。「本回合确有文件改动才留点」也没做成：留点必须在
`turn/start` 拍（见上），改成回合结束拍会把工作区态固定成「改完之后」，正好是这条坑里被禁掉的做法。

## 竞品对照后的五项修复：采集预算 / 子代理判定 / 前像落盘 / 预算兜底 / 注释（2026-10-14）

**来源**：对标 `PerryLink/dsh-checkpoint-rewind`、`SiriLee/dsh-rewind`、`Anionex/dsh-turn-rewind`
三款插件的全部 issue/PR 与源码后，逐条比对本插件回滚实现（26 条对照表见 `.tmp/rewind-competitor-audit.md`）。
结论：竞品最惨的四类 bug（就地改写会话日志、采集阻塞工具调用、台账整份读改写、二进制写坏）在本插件
**结构上不成立**；据此落地五项改动。

**① 采集时间预算与取消信号**（对标 turn-rewind 的 `deadline.ts`、checkpoint-rewind 至今**未合并**的 PR #25）：
捕获此前只有 maxFiles / maxBytes / maxFileBytes 三个**规模**上限，没有**时间**上限 —— 「文件数很多但总量不大」
的工作区能让 walk + stat + sha256 跑很久。新增 `ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS = 30_000`（引擎选项
`captureBudgetMs`）与 `RollbackPointInput.signal`（tracker 在 `stop()` 时 abort、重新 `start()` 时换新 controller）。
超时 / 取消**不是失败**：已收条目照常成点，未走查部分按 `budget-time` 逐条进 skipped 且 `truncated` 置真
⇒ 结尾 reasonCode 自动落成 `capture-truncated`。**删除集是否 fail-closed 取决于中断发生在哪一段**
（原稿写「自动 fail-closed」过宽，2026-10-15 修正：只有走查本身被打断才拒删；见文末「采集预算落在走查之后的误报」）。
**连带修正**：`truncated` 为真时不得判 `chunk-not-found` —— 否则「分块确实存在、只是没跑完」会被报成
「工作区配错了」。截止用 `stamp()`（单调）比较：系统时钟回拨不会让预算永不触发。

**安全判据（必须成对改，2026-10-14 自查发现）**：中断会让剩余子树**一条都没进任何名单**
（不在 files / skipped / walked）⇒ 新增 `walkIncomplete` 标志并接成删除集的**第四道** fail-closed 判据
（`refused = 'capture-incomplete'`）。漏掉它，超时点回退时会把「留点时刻存在、只是没来得及走查」的文件
当成「留点后新建」**删掉**（`/rollback <id>` 命令固定 `removeCreated: true`，这条路真实可达）。
这也正是 `walkIncomplete` 必须与 `truncated` **分开**的原因：后者的三种成因（文件数 / 总字节 / 单文件超限）
都是「继续遍历 + 逐条留痕」，名单完整、**不**拒删。护栏：R-31（超时置标志）+ R-36（标志 ⇒ 一条都不删）。

**② 子代理会话不参与自动留点**（对标 dsh-rewind #26 的 `isSubagentSession`）：
`rollbackSessionBindingOf` 此前只读 `id` / `header.cwd` / `parentSession`，**不读 `origin`** ⇒ 每个子代理会话
都会留点；而它与父会话同工作区、回合号是自己的，实际效果只是挤占用户自己会话的预算。
**判据只在 `header.origin === 'subagent'` 逐字命中时生效**，读不到（老宿主 / 形状不符）**不加判定** ——
绝不因为读不到就少留点；宿主日志每个会话只 warn 一次。注意 `src/routes/recovery.ts` 里
「`origin='subagent'` 不得当 fork 筛选器」是**归位**口径，与留点口径不是一回事，两处并不冲突。

**③ 回退前像字节落盘**（自研发现：回退路径的内存峰值与 #89 同族）：
旧实现把「待写文件的旧内容」与「待删文件的内容」全放内存数组，峰值 ∝ 待写总字节（可达数百 MB）。
新增 `UndoStager`（`<root>/undo/<pid>-<ts36>-<8hex>/`，**字节落盘、索引随栈**），成功与失败路径都 `dispose()`；
**暂存目录建不出来 = 零写入失败**（fail-closed：回退没有安全网就不该开始）。崩溃残留由
`cleanupOrphanTempFiles` 按与 tmp 文件同一套 pid 判据（不是本进程 + 进程已不存在）整目录回收。

**④ 预算兜不住单条点时如实上报**（对标 checkpoint-rewind #35「软配额 bound 不住单条」）：
`applyByteBudget` 在「一条都淘汰不了却仍超预算」时只 warn、界面无从得知。新增
`RollbackLedgerStatus.overBudget`（`bytes > budget` 就等于「已淘汰到极限」）+ 面板一行如实提示；
**记录仍然保留** —— 绝不因为超预算把用户刚留的点丢掉。

**⑤ 注释修正**：`src/index.ts` 的订阅注释此前写「每见到一个 `turn/end` 就留点」，与实现
（`turn/start` 拍、`turn/end` 只记缺省边界）相反，属过时注释，已按实现改写。

**明确没做 / 已核实不需要做**：dsh-rewind #51（compact 后目标不可回退）在本插件**不成立** —— 本插件 fork
用的是**日志事件 seq 切片**（`atSeq`），不按 surface 消息索引，被 compact 遮蔽的回合仍可从日志前缀分叉；
checkpoint-rewind #24（未引用 git 对象被 gc）同样不适用（自管对象仓，不产 git 对象）。
护栏：`src/core/rollback-point.test.ts` 的 R-30..R-35（子代理判定 / 时间预算 / 取消信号 / overBudget /
前像落盘与零写入失败 / 残留清理）。

## 第三轮：4 条取舍按「推荐组合」落地（2026-10-14）

护栏已扩到 R-30..R-43（新增：走查中断 fail-closed R-36 / 台账重建 R-37 / `.GIT` 保护 R-40 / 回退期走查预算 R-41 / `.git` 不进捕获面 R-42）。

**① 跨进程乐观并发（推荐 B）**：`dataDir` 由 `$DSH_HOME` 决定、**不随 profile 分家**，而本插件的实例锁（instanceId + heartbeat + ownership）本就按多实例设计 ⇒「另一个 DSH 实例写同一份清单」是设计内场景，而 `withLedgerWriteLock` 只串行本进程。落地：`RollbackLedger.manifestStamp()`（mtime+size）+ `appendRecord` 拆成「最多三次尝试」的 `appendRecordOnce`：读清单前后各取一次戳，被改过就不写、重读重试；三次都变 ⇒ **放弃本次留点并 warn**（宁可少一条点，也不覆盖别人的清单）。**诚实边界**：检测与写入之间仍有极小窗口，无跨进程锁时无法彻底消除 —— 这里保证的是「不静默覆盖 + 尽量合并」，不是原子性。

**② `.git` 不进捕获面（推荐 A）**：此前只有删除侧拒 `.git`、捕获侧照样记录并会在回退时写回 ⇒ 跑过 `git commit` 的回合回退后 `git log` 可能少一次提交；且 `.git` 常达数百 MB，会挤掉 `maxBytes`（512 MiB）里的源码文件。落地：`listChunkFiles` 里 `.git` 与 `node_modules` 同档整棵排除（折大小写比较，Windows 的 `.GIT` 同一条），进 `excludedDirs` 留痕并因此进证明名单（不会被当成「留点后新建」）。**连带更新**：R-05d / T2-B 原先钉的是「`.git` 进候选后被拒删」，现在断言更强的事实 —— `.git` 子树**一个字节都没被动过**（`createdSkippedCount` 从 1/3 变 0）。

**③ `/rollback` 文案说实话（推荐 A）**：A 无感替换（打开子会话 + 归档原会话）只在**客户端**，命令在 host 侧没有切换会话的能力 ⇒ 文案追加「当前对话不会切换：新会话在左侧栏（未分组时排在末尾）」。**成本比预期低**：`engine-locale.test.ts` 的冻结指纹只覆盖 372 个**基线键**，`command.rollback.*` 是后加的、不在基线里，改值不会红（也不必改指纹）。

**④ ui-prefs 三个写端点统一门（推荐 A）**：`updateUiPrefs` 虽是 read→merge→write，但两个端点**并发**时仍会互相覆盖字段（典型：刚打开的 `rollbackEnabled` 被另一个端点的旧快照抹掉 ⇒ 重启后功能自己关掉）。落地：`sync.ts` 的 `sync/ui-prefs` 与 `prefs.ts` 的 `star-prompt` / `release-notes-prompt` 都过 `runWithMutationLock`（`prefs.ts` 抽了 `writePrefsOrBlocked`，被 SAFE MODE / 环境锁挡住时回 423、零写入）。

**同批落地的其余项**：预览改用 `lstat`（符号链接一律按不可写报，与写入侧 `symlink:'reject'` 同口径）；继承视图按 `pickedTurns` 去重（多代链同一回合只取最近祖先）；开关三态（`prefsEnabled: boolean | null`，未读到不显示成「关」）；偏好与本进程状态分歧如实上屏；`ChatPointWindowController.dispose()` 清掉默认排程器的定时器；宿主 fork 返回形状加固（`in` 对 null 会抛 TypeError ⇒ 先判对象）。

**仍未落地（下一批，附正确修法）**：C3「结果屏不渲染被跳过的段」与 C4「复选框已勾选且禁用」是**同一根因**的两个面，而 C4 与既有设计冲突（`rollback-entry-view.test.ts:111` 明确钉「档位与预览里的可用段无关」）⇒ 正确修法是在**提交路径**按 `workspace.available` 收窄 `mode`（给 `buildRewindOptions` 补 preview 参数并同步调用点），而不是改 `defaultDraft`（本轮的尝试已回退）；C7 聊天入口 30 s 缓存需要跨模块失效通道；C5 需要 client http 层识别 409 的机器码；H5 命令服务惰取需要换用 `injectServices` 式的就绪回调。

## 第四轮：C3/C4/C7 落地 + 两条「二手结论被推翻」的核实（2026-10-14）

**C3 + C4（同一根因的两个面）**：工作区段不可用时（捕获无 cwd / 分块不存在 / 只记了会话态），聊天侧此前表现为「复选框勾着且禁用」+ 结果屏只说「部分恢复 / 恢复 0 项」。落地两处**纯渲染**改动（不动 mode 语义）：复选框 `checked = revertFiles && revertFilesEnabled`；结果屏在失败块之后新增「未执行的段」一行（复用设置页同一个键 `rollback.rewind.result.skipped`，判据同源 `rollbackSkippedSegments`）。**为什么不动 mode**：`rollback-entry-view.test.ts:111` 明确钉住「档位与预览里的可用段无关」（聊天侧刻意只做一种形态），改 `defaultDraft` 会破坏该设计；正确做法是在**提交路径**收窄 mode，成本更高，留给下一轮。

**C7**：`RollbackCard` 的删除成功与清理成功（`removed > 0`）后调用 `resetChatPointCache()` —— 此前 30 s 内聊天入口仍按旧列表判「可点」。`chat-entry-view` 不 import recovery 模块，无循环依赖（已 grep 确认）。

**C5 的二手结论被推翻**（重要教训）：审计报告称「409 走泛化错误、专门文案永不出现、界面显示裸 HTTP 409」。核实源码后不成立 —— `readJson`（`common/http.ts`）**早已**把响应体里的 `code` 透传进 `ConfigManagerApiError.code`，而 `requestRewind` 的 catch 用 `codeKeyOfError` 读它 ⇒ 409 时界面显示的是 `rollback.code.session-active`（文案可操作：等本轮结束 / 只回溯消息）。真实缺陷只是 `chatRewindFailure` 里那个 `session-active` 分支**永不命中**（该码只经 409 从 HTTP 层来）⇒ 按「防御性分支」保留并如实注明，未改行为。**教训：审计报告的行号级结论也必须回源码复核，尤其是「某条路径永远走不到」这类判断。**

**H5 的调查结论（不改代码）**：Cordis 的 `ctx.get` 在 apply 期只能拿到**已 apply** 的服务，而 `registerRollbackCommand` 在装配期读一次并缓存 ⇒ `commands` 行晚于本插件时 `/rollback` 不注册（只 warn）。**本机无法坐实** DSH 内置插件与本插件的 apply 顺序（`app.asar` 不可直接读，本机 profile 的 `cordis.patch.yml` 里没有 commands 行）。处置：**修正注释**（原文声称「调用期惰取」与实现不符 —— 这是本轮实际修掉的东西），保留 warn，不引入 `ctx.inject(['commands'])`（改装配时机的风险大于该缺口）。

## 采集预算落在「走查之后」的误报：`walkIncomplete` 语义修正（2026-10-15）

**真机现象**（用户截图）：回退预览同时给两条警告 —— 段级 `capture-truncated`（「有一态留得不完整（回退可能不完整）」）
与 `createdRefused` 成因 `walk-incomplete`（「本次不删除任何『留点后新建』的路径」）。

**实测取证**（本机 `~/.dsh/dsh-config-manager/rollback-points/`，工作区分块 = `D:\Projects\personal\dsh-config-manager`）：
- 最近 5 个自动点**全部**耗时 30.1–30.2 s（判据 = 载荷文件 mtime − 点创建时刻），即每个点都撞满
  `ROLLBACK_DEFAULT_CAPTURE_BUDGET_MS`（30 s）；最新点 `files=19297`（`maxFiles` 上限 20000）、
  `skippedCount=14360(list-capped)`（逐条名单上限 5000）、`bytes≈228 MB`（总量预算 512 MiB 未触）。
- 该点写在载荷里的路径索引 `count=34350`；**独立数一遍**该工作区真实文件数 = 34352、符号链接 = 10
  ⇒ 34350 + 9 条 `link` 留痕与真实树完全吻合 ⇒ **走查其实走完了**（`walkIncomplete` 是被误置的）。
- 走查量的 94% 来自三个目录：`outputs/` 21379、`.tmp/` 8983、`.qa/` 1842（都不是 `node_modules`/`.git` —— 两者整棵排除，
  另有 52 个 dep-dir + 7 个 git-dir 进 `excludedDirs`）；`listChunkFiles` 是 LIFO 栈，**收进快照的 19297 条里
  19052 条来自 `outputs/`**，`.tmp/`、`.qa/` 一条都没进（额度被先走到的目录吃光）。

**根因**：`captureWorkspace` 在读文件循环里撞预算时**无条件**置 `walkIncomplete` —— 而该断点可能发生在
`listChunkFiles` **正常返回之后**。`walkIncomplete` 的语义应是「栈里还有没进去的子树」（那些路径一条都没进任何名单），
与「走查走完了、只是没读完」是两件事：后者的路径**全在 `walked` 里**，本来可以进证明名单。

**修法**（两处判据必须成对改，缺第二处就是把老文件当新建删）：
1. `listChunkFiles` 增回传 `walkAborted`（只在 `shouldStop` 早退时置真）；`captureWorkspace` 只据此置 `walkIncomplete`，
   读文件循环的 break 不再置它；
2. 路径索引的写入条件从「`skippedTruncated`」推广为**覆盖自检**（`walked` 里有路径既不在 `files`、也不在
   `skipped`/`unreadableFiles`）—— 否则读文件阶段被打断时，走查过却没进名单的路径既没索引也没标记，会被当成
   「留点后新建」删掉；索引写失败则退回 `walkIncomplete`（安全方向）。`planCreatedRemovals` 相应改为
   「索引存在即并入证明名单」（原先只在 `skippedTruncated` 时读它，会漏读索引）。`truncated` 语义不变（照旧如实标截断）。

**护栏**（`src/core/rollback-point.test.ts`）：R-43（预算落在走查之后 ⇒ 不置 `walkIncomplete`、写路径索引、
新建文件照常被删、没读到的老文件绝不被删）、R-44（走查被打断 ⇒ 仍报 `walk-incomplete`、全局一条都不删，
且不写一份「看起来完整」的索引）；R-31 / R-36 / R-41 原样通过（超时 / 标志 ⇒ 拒删 / 回退期预算）。
## 大仓库捕获的根治：并发 I/O + 缺口优先 + 分子树拒删（2026-10-15）

**真机取证**（本仓 = 34,35x 文件 / 581 MiB，临时库全量捕获，`captureBudgetMs` 放到 300 s）：

| 口径 | 改前 | 改后 |
|---|---|---|
| 全量捕获（临时库、预算放到 300 s） | **175 s**（30 s 预算只覆盖 19,297/34,350 = 56%，`src/` 仅 27%） | **18.5 s**，`truncated=false`，34,361 文件全覆盖 |
| **出厂缺省**第 1 个点（30 s / `maxFiles` 20,000） | ~30 s 且只覆盖 19,297（56%） | **10.9 s**，记录 20,000 条（读预算用尽，`truncated=true` 如实标注） |
| **出厂缺省**第 2 个点（缺口优先 + 已知内容不占槽位） | 仍 ~30 s / 56%，且每回合重复同前缀 | **10.8 s**，记录 **34,368 条 = 全覆盖**，`truncated=false` |
| **出厂缺省**第 3 个点（稳态、无变化） | — | **3.8 s**，34,368 条，全覆盖 |
| 阶段耗时（串行统计口径） | `writeObjectWithHash` **148 s / 31,702 次**（4.7 ms/次） | 见上（并发后不再是瓶颈） |
| 并发上限实验 | — | 16 与 32 worker 无差别（18.5 vs 18.9 s）⇒ 瓶颈是 libuv 默认 4 线程 + Windows 每文件写入，不是 JS 并发度 |

**四个根因与修法**（缺任何一条都还是慢到截断）：
1. **对象写用了强原子写**（`atomicWriteFile` = 同目录 tmp + fsync + rename，真机 4.7 ms/次）。内容寻址对象改成
   `writeFile(target, bytes, { flag: 'wx' })` **直接独占建最终名**：名字即内容哈希 ⇒ 并发幂等（EEXIST 即成功）、
   半截内容必被读取侧哈希校验拒绝；**不做 fsync**（回滚点是本地尽力快照，不为掉电持久性付每文件一次 fsync）。
2. **每文件两次 stat**（`fs.stat` + `pathIdentityOf` 的 bigint stat）⇒ 合成一次 `fs.stat(..., {bigint: true})`
   （`fileStatOf`），阶段①按 `ROLLBACK_CAPTURE_STAT_BATCH=128` 条**有序批**并发取 stat。
3. **每个候选一次 `fs.access`**（F-2 的对象存在性自检，34k 次 ≈ 3.7 s）⇒ 每回合一次 `readdir` 取**对象名单快照**，
   写入时同步登记；读不到名单才回落逐条 access（F-2 语义不变：不在名单 ⇒ 当真未命中，重读 + 重写、缓存自愈）。
4. **读/写全串行** ⇒ 两阶段：① **顺序判定**（文件数/时间预算、stat、单文件与总量上限、身份、缓存，
   **判定严格按顺序**、字节预算按 `stat.size` **在准入时预留**、`slots` 预分配）保证与串行实现逐条一致；
   ② **并发读 + 哈希 + 落仓**（16 worker，`ByteGate` 把「在飞内容字节」钉在 `maxFileBytes` 以内）。
   输出仍按路径排序 ⇒ 指纹 / 预览 / 台账契约不变。

5. **「记录多少条」被读预算卡住**：旧口径下 `maxFiles` 同时限制「读新内容」和「写进记录的条目数」⇒ 大仓库每个点都只记下前 N 条，
   而**回退只认该点自己记录在案的路径** ⇒ 早先的点永远缺尾部文件。现在解耦：**缓存已知（身份未变 + 对象在仓）的条目一律进记录、不占读预算**，
   `maxFiles` / `maxBytes` 只约束「这一回合新读进来的内容」。因此第二个点起记录就是全量（R-49 钉死）。


**清单增量化（2026-10-15 深夜，用户问「工作区记录全部是不是磁盘开销太大」→ 选定「清单增量化」）**：
- **账单（本机实测 705.9 MB）**：`objects` 511.7 MB / 25,631 份（内容寻址，633,542 条引用 ⇒ 去重 **24.7×**；朴素「每点一份全量」× 31 点 = 17.6 GiB）、
  `payloads` **179.3 MB / 25 份**（每点一份路径清单，平均 7.7 MB、最大 12.1 MB）、path-cache 6.8 MB、index+records 0.2 MB。
  结论：**贵的是每点的清单，不是内容** —— 内容已经去重，再改「只记改动」也省不掉那 512 MB（要能回退到任一历史点就得留着那份内容）。
- **修法**：每点只存「相对**上一份**载荷的增量」（新增/改写条目 + 被删路径），基准由清单条目的 `payloadChain` 保活；
  读路径由 ledger 的 `resolvePayload` **物化**成完整清单 —— 预览/回退/回收看到的永远是完整 `files`。
  同时落盘时省掉 `object`（`object ≡ sha256`，读时按 sha 补回）⇒ 全量锚点也小约 1/5。
- **三条硬边界（都有测试钉住）**：
  ① **一次留点只读清单**（L-08 / issue #89 那条被消灭的路）⇒ 基准必须来自**本进程内存摘要**（`deltaBase`），绝不读上一份载荷；进程重启后第一次留点落全量锚点，随后继续链。
  ② **链长上限 `ROLLBACK_DELTA_CHAIN_LIMIT` = 8**：到顶落一个新锚点 ⇒ 物化最多读 1 份全量 + 几份小增量（重建代价有界）。
  ③ **基准读不出来 ⇒ 该点如实失败**（`record-incomplete`），**绝不返回半份清单** —— 半份清单会被「留点后新建」判据当成绝大多数文件是新建的，回退就会删掉它们（R-54 钉住）。
  另：工作区与基准**逐条相同**时直接**复用**基准载荷哈希 ⇒ 零额外字节（L-02 的既有不变量不破）。
- **实测（真机 34,774 条的工作区，每次捕获后读回校验）**：首点全量 **9.56 MB**（旧口径约 12.1 MB，省掉 object）；
  第二点（其间有大量改写）**1.21 MB**；稳定后第三点 **11.1 KB**、第四点 **11.1 KB 且复用同一份载荷（零写入）**；四点合计 **10.8 MB vs 旧口径约 48.4 MB**。
  摊薄后每点清单 ≈ 9.6 MB ÷ 8 + 增量（几 KB~几十 KB）⇒ 台账里那 179 MB 的清单预计降到 **20~30 MB** 量级。
  读回校验：物化后条数与捕获一致（30,629 / 34,774）、`object` 字段全部补回、预览 `overwrite` = 全量条数。
- **仍未做**：对象仓打包（25,631 个小文件）；遗留 `checkpoints/` 56.9 MB（v3 已不读、需手工清）。

**预览 / 回退的「把整个工作区读两遍」（2026-10-15 晚，用户报「点回退加载太慢」）**：
- **症状与实测**：对 34,477 条记录的点调 `preview` —— 真机 **14.2 s**，其中约 13 s 全在「逐条 `fs.readFile` 当前内容 + 算 SHA-256」；`previewFileCounts`（行级 diff）只有 34 ms、`planCreatedRemovals` 1.1 s。回退执行同理：阶段 1 先把**每个**对象读出来校验（34k 对象 / 609 MiB），阶段 2 再读一遍当前内容判「是否已一致」——整个工作区读两遍。
- **修法：身份快路径（预览与执行共用同一条判据）** `unchangedByIdentity`：路径身份（dev:ino:size:mtimeNs:ctimeNs:mode）命中**身份缓存**、且缓存里的 sha/bytes 与记录一致 ⇒ 内容就是留点那一刻那份 ⇒ **不读盘、不算哈希**；预览直接跳过，回退连对象都不读（它本来就不会被写）。身份含 mtimeNs/ctimeNs/ino，改内容必动它们（Windows 上 user 代码改不了 ctime）；**记录指纹被篡改时该判据必然不成立**（缓存 sha 是真算出来的）⇒ 仍走真读+哈希，护栏不退化。
  同时把预览的逐条判定（bigint `lstat`）并发化（16 路）：34k 条 lstat 从 ~4.4 s（串行）降到 ~1.5 s；行级 diff 仍在**顺序**阶段跑，列表顺序与共享预算保持完全确定。
- **实测（同一台账、同一台机）**：① 身份被上一轮回退**改写过**的点（34,477 条）：14.2 s → **7.4 s**（其中 14,526 条仍必须真读 —— 身份变了就不能信任缓存）；② **稳态**点（留点后没被批量改写，20,002 条）：**2.08 s**，只读了 239 条 ⇒ 34k 规模约 2.5~3 s。
- **有意的语义变化**：阶段 1 的对象校验只对**真要写**的条目做 —— 一个「反正用不到」的对象坏掉不再中止整次回退；该文件确实变了、真要用它时照样 `object-missing` / `object-hash-mismatch` 硬失败（R-52 钉住）。
- **仍未做**：走查（`listChunkFiles` 3,948 次 readdir ≈ 0.6~1.4 s）仍是第二大项；对象仓打包（多 blob 一文件）也仍未做。

**覆盖率收敛（「任何大小都能用」的关键）**：走查顺序改为「**身份缓存里没有的路径排前面**」。身份
（dev:ino:size:mtimeNs:ctimeNs:mode）未变 ⇒ 后一回合补到的内容**就等于**前一点时刻的内容，所以「跨回合补缺口」
是**安全**的（不是补一份不准的前像）；稳态成本只与「这回合变化的文件数」成正比。R-46 用「每回合只放行 3 次读」
把单调性与 100% 收敛钉死。

**预算自适应**：被截断 ⇒ ×2（上限 120 s）；用掉 < 1/4 ⇒ ÷2（下限 10 s）；回退期走查预算独立
（`rewindBudgetMs`），不随捕获自适应起舞。

**分子树 fail-closed**：走查中断时把栈里**没进去的子树**带出来（`unwalkedDirs`，≤200 条），与 `ignoredDirs` /
`unreadableDirs` 一起构成「拒删范围」；**范围说得清才分子树拒删**（忽略目录逐条列表被记录上限截断、
或拿不到子树列表 ⇒ 退回全局）。旧口径「忽略一个 `outputs/` ⇒ 全工作区一条都不删」代价过大且不必要：
被忽略的子树在回退期同样走查不到 ⇒ 里面的路径根本不进候选。

**捕获竞态**：读完再 stat 一次身份；变了 ⇒ 不进前像（避免把最新内容当旧内容写回），只进 `unreadableFiles`
—— 它本身是证明名单成员，因此绝不被当成「新建」删掉。


**真机验收回执后的两条口径修正（2026-10-15 晚，独立验收会话的真机报告）**：
- **降级口径收窄**：26 个真机点里，覆盖完整的那些（files=34,477、truncated=false）仍被标 capture-degraded，
  唯一成因是 skippedCount=10，而那 10 条全是**设计内**跳过（符号链接 / fixture 的 outside-link）。degraded 改为只看
  「真的缺内容」：`truncated || unreadableDirs || unreadableFiles`。**为什么能去掉 skippedCount**：文件数 / 总字节 / 单文件上限 /
  时间预算挡下的每一条都同时置 `truncated`（且逐条留痕），读不出与捕获竞态进 `unreadableFiles`；剩下的 reason
  （`link` / `not-a-file` / `ignored` / `self-store` / `missing`）都是「不跟随 / 不收录」的设计内跳过，
  既缺不了内容也不该回退它们。护栏 R-50（文件级忽略 ⇒ 不降级但必须逐条留痕；对照超单文件上限 ⇒ 降级 +
  `capture-truncated`），R-19 末段同步改为「链接跳过 ⇒ 不降级」；文案 `rollback.code.capture-degraded` 不再提「链接」。
- **回退的 60 s 超时是验收脚本自己的**：客户端 recovery 族早就是 `LONG_REQUEST_TIMEOUT_MS`（5 分钟，与宿主
  `ROUTE_TIMEOUT_MS` 对齐），E2E 里的 60 s 来自 PowerShell/curl 的默认值；服务端在客户端超时后完成属正常。
  仍补了一处诚实性：`error.recoveryTimeout` 文案从「恢复过程未完成，请重试」改为「过程可能仍在后台进行，
  请先刷新预览确认」——**客户端超时不等于服务端没做完**。

**仍未做（如实登记）**：① 对象仓打包（多 blob 一个文件）以继续压冷启；② `UV_THREADPOOL_SIZE`
（进程级、插件内设置不可靠）；③ 「哪些目录没有前像」的逐范围 UI（当前只有计数 + 逐条拒删清单）。

## 回退文件预览的侧栏高度：同特异性 CSS 的顺序决胜（2026-10-15 用户反馈 + headless 实测）

**症状**：聊天里「↺ 回退 → 查看」开进 DSH 右侧栏的差异标签页，高度不跟侧栏走 —— 差异区停在一个固定高度，
侧栏更高时底部留白（用户原话：「不能自适应侧边栏的高度」，期望「回退文件预览高度 === 侧边栏的高度」）。

**根因**：`.diffPaneFill .diffScroll`（fill 档，写给侧栏标签页的限高）与 `.diffPane .diffScroll`（列表量级的
`min(80vh, 800px)`）**特异性都是 (0,2,0)**，而后者写在文件后面 ⇒ **顺序决胜**，fill 档的 `max-height` 被盖掉；
于是无论侧栏多高，滚动内容最多长到 min(80vh, 800px)。注意**面板根元素本身没坏**：`.diffPaneFill{height:100%}`
在宿主定高链上仍然撑满（headless 实测 pane = tabBody = 800px），坏的是它**里面那一条**（表格区）。

**宿主高度链（源码核实，`D:/Apps/DSH/resources/app.asar` 0.2.0-rc.2）**：
`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` → `.panel{position:absolute;top:0;bottom:0;display:flex;flex-direction:column}`
→ `.panelBody{flex:auto;min-height:0;display:flex}` →（dockkit DockLayout）→ `TabSlot` 渲染的
`div.tabBody{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}`（带 `data-sidebar-right-tab`），
我们的组件就是它的直接子节点（`renderSlot` 不额外包一层 DOM）。宿主自带的侧栏面板（如 `ui-sidebar-files` 的 `.root`）
写的是 `height:100% + flex:auto + min-height:0`（**没照抄 flex:auto，因为实测这条不改变结果**：tabBody 定高时
`height:100%` 已经够，定高链断掉时 flex:auto 也撑不起来）。

**修法**：把 `.diffPaneFill .diffScroll` 那条**移到 `.diffPane .diffScroll` 与 `.dialogCard .diffPane .diffScroll`
之后**（保持 (0,2,0) 靠顺序赢；`.dialogCard` 那条 (0,3,0) 仍只作用于弹窗，fill 档不进弹窗），只留
`max-height: calc(100vh - 90px)` 作为「宿主没给高度」的视口兜底；同时 `RollbackDiffPane` 的撑满档改成
**五种出口（加载 / 读失败 / 结构化拒绝 / 看不了 / 一致 / 有差异）都套同一个整块容器** —— 只让「有差异」撑满时，
其余状态会缩成一行、一屏高度来回跳。

**验证（headless Edge，直接跑仓库真实 CSS 的两种顺序）**：`msedge --headless=new --dump-dom`，宿主链复刻成
`.panel/.panelBody/.dockPane/.tabBody`，侧栏 800px、视口 908px：
- 修前顺序：`tabBody=800 pane=800 scroll=726`（726 = 80vh，底部空 74px）；
- 修后顺序：`tabBody=800 pane=800 scroll=778`（778 = 800 − 文件头，刚好那一屏）。
生成脚本 `/tmp` 级的探针页面留在 `.tmp/sidebar-height-probe.html`、`.tmp/gen2.cjs`（临时目录，不进仓库）。
**真机侧栏未复测**（桌面 app 装的是 npm 上的 0.1.73，本地 lib 产物要重新安装才会被宿主加载）—— 如实登记。

**守卫**：`src/client/recovery/rollback-file-changes.test.ts` 新增源级断言 —— fill 档限高必须排在列表量级之后、
fill 档不得再出现 `min(80vh, 800px)`、撑满档五个出口都经 `shell(...)`。

## 差异预览的两条「假信号」：400 行渲染上限 + 400 编辑距离预算（2026-10-15 用户反馈 + 真机数据实测）

**症状**：聊天「↺ 回退 → 查看」的差异里同时出现两行提示 ——
「只画了前 400 行（共 4187 行），数据本身是完整的」与「差异规模较大，已按整块替换展示（仍是完整结果，只是不是最小的编辑脚本）」。
用户问：「为什么最多只能加载 400 行？我需要能完整的加载」。

**两条根因（互不相干）**：
1. **渲染上限** `DIFF_ROW_CAP = 400`（`common/DiffTable.tsx`）：数据本身完整，只是画了前 400 行对。
   宿主侧早就有单文件体积门（回滚预览 `maxFileBytes = 1 MiB`、恢复计划 `maxSideBytes`），到渲染层的数据就是「要画的全部」；
   渲染层再砍一刀只会让同一份数据少半截，而用户没有任何办法看到剩下的。
2. **算法预算** `DEFAULT_MAX_D = 400`（`utils/line-diff.ts`）：几千行文件里改几十处就可能超过 D=400 ⇒ 退化成
   「整块替换」（全删 + 全增）。提示文案本身没错，但它在**普通大文件**上频繁触发 ⇒ 用户读到的是一条假信号。

**取证（真实数据，不是合成样例）**：从台账 `~/.dsh/dsh-config-manager/rollback-points/`（payloads/ 里 `files[].object` → 
`objects/<sha256>`）取出同一文件 `src/core/rollback-point.ts` 的 6 个历史版本，直接跑 `diffLines`：

| 版本对（行数） | maxD | degraded | +A/−R | 耗时 | RSS 增量 |
|---|---|---|---|---|---|
| 4983 × 4341 | ≤1600 | false | +153/−795 | 14 ms | ~3 MB |
| 4983 × 4774 | 2000 | false | +2/−211 | 7 ms | ~3 MB |
| 4983 × 4361 | 2000 | false | +136/−758 | 24 ms | ~5 MB |
| 4983 × 2492（近乎重写） | 2000 | **true** | +2467/−4958 | 32 ms | +3 MB |
| 同上 | 3000 | true | +2467/−4958 | 55 ms | +74 MB |
| 同上 | **4000** | false | **+255/−2746** | 70 ms | +98 MB |
| 同上 | 8000 | false | +255/−2746 | 115 ms | +175 MB |

⇒ 真实数据的 D 多在 2000 以内；连「近乎整份重写」的那一对也只落在 **3000~4000**。
**内存是 O(D²)·4B**（回溯逐轮留 V 快照；Int32Array 的底层 buffer 计入 **RSS/external 而非 heapUsed** —— 
只看 `process.memoryUsage().heapUsed` 会误判成「只涨了几 MB」）。所以预算按「RSS ≤ 百 MB 量级」定：
缺省 2000、回滚单文件按需查看 4000；再往上不该加预算，要换线性空间 Myers（分治求 middle snake）。

**改法**：删掉渲染上限（连同 `truncatedNotice` 管道与 `rollback.diff.truncated` / `snapshots.plan.diffTruncated` 两条字典键）；
`DEFAULT_MAX_D` 400→2000、`DEFAULT_MAX_LINES` 6000→20000；`ROLLBACK_FILE_DIFF_LIMITS` 增 `maxD: 4000` 并在调用点传入。
**保留** `rollback.diff.degraded` / `snapshots.plan.diffDegraded`：那是算法保真度的事实陈述（且现在只在真·整份重写时出现），
把它一起删掉才是撒谎。

**守卫**：`src/utils/line-diff.test.ts` D-14（同一份输入：旧口径 400 必降级、缺省口径必须给出最小脚本且可回放重建）；
`src/client/recovery/rollback-file-changes.test.ts` 新增源级断言（渲染层不得再出现 rowCap/truncatedNotice、两个调用点都不传截断文案、
字典里不得再有截断话术、degraded 提示必须保留）。

## 留点捕获的「在飞内容」闸门接错对象 ⇒ DSH Desktop 发消息后 1–2 s 闪退（2026-10-16 真机事故，0.1.74）

**症状**（用户原话）：「发消息后 1–2 秒就会闪退」「正在等回复时闪退」。桌面没有任何报错、插件零错误日志。

**取证**：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` 里
`dsh desktop host exited with 4294930435`（同日两次），`phase: running`，host stderr 只有 `DEP0180`、
Electron 的 asar 报错、crashpad `not connected`。对照 09-30 / 10-01 / 10-03 / 10-06 / 10-07 的同类记录
（退出码 1073807364 / 3758096392）—— **全是「被外部终止」形状，没有 JS 栈**。
（host stderr 里那两行 asar 报错指向 `.tmp/m2/asar/fake-resources/app.asar` = 仓库里的 64 B 测试残留：
用同一颗 Electron 二进制以 node 模式读它 5 种方式（readFileSync / utf8 / bigint / open+read / stream）
**全部是可捕获错误、退出码 0** ⇒ 与闪退无关，属子进程 stderr 噪音，别被它带偏。）

**根因**：`turn/start`（= 发出消息后 0~1 s）拍留点 → `captureWorkspace` 的并发读阶段
`new ByteGate(this.maxFileBytes)`，而 `maxFileBytes` 的缺省是 `maxBytes`（**512 MiB**）——
`ROLLBACK_DEFAULT_MAX_FILE_BYTES`（64 MiB）那个常量当时根本没接上。于是「同时在飞的内容」上界 = 整点预算，
16 个 worker 可以把几百 MB 文件内容同时驻留（Buffer / sha256 / 对象写副本另计）；大工作区
（本仓 630 MB / 25k 文件，`.tmp` 366 MB 已被忽略）在 1~2 s 内就把闸门填满 ⇒ 宿主被系统杀掉。

**量化**（真机级对照 `.tmp/repro-inflight.mjs`，16 × 8 MiB 工作区，readFile seam 记录在飞字节 + RSS 峰值）：

| 配置 | 在飞峰值 | RSS 峰值 | 耗时 |
|---|---|---|---|
| 0.1.74（闸门 = maxFileBytes = 512 MiB） | **128.0 MiB**（该工作区全量） | 194 MiB | 200 ms |
| 修复后（闸门 = captureInFlightBytes = 32 MiB） | **32.0 MiB** | 139 MiB | 308 ms |

工作区越大差距越大：旧闸门允许一路上到 512 MiB。

**改法**：新增 `ROLLBACK_DEFAULT_CAPTURE_INFLIGHT_BYTES = 32 MiB` 与选项 `captureInFlightBytes`
（被 `maxBytes` 夹住），`ByteGate` 改接它；`maxFileBytes` 保持原语义（单文件「要不要读」的判据，t13 冻结）。

**教训**：串行实现的内存上界是「一份文件」，并发实现的上界是「闸门限额」——**两者不是同一个量级**，
不能拿同一个常量同时当「单文件判据」和「并发闸门」。

**守卫**：`src/core/rollback-point.test.ts` R-45b（`maxFileBytes` 远大于闸门时，在飞字节仍必须 ≤ `captureInFlightBytes`；
缺省闸门必须 < 总量预算 / 8）+ R-45 改判据 + T2-E 显式注入 `captureInFlightBytes`。

## 更正（0.1.76，2026-10-16）：上面那段「在飞内容闸门」不是闪退根因

上一段把 2026-10-16 的桌面闪退归因给「ByteGate 接在 maxFileBytes 上」。**那个结论是错的** —— 闸门接错确实
是个真实缺陷（并发时在飞内容可达 ~512 MiB，已在 0.1.75 修好并保留），但它**不是**闪退原因：0.1.75 把它
改成 32 MiB 之后桌面**照样闪退**（2026-10-16T23:54:04Z，同一退出码 4294930435、同一行 asar 报错）。

**真正的根因（0.1.76 修复）**：留点捕获会**读取工作区里的每个文件**，而 `.tmp` 这类 scratch 目录**不在**忽略面内
（`loadIgnoreRules` 只读 `.dsh-rollback-ignore`，**不读 `.gitignore`**；实测本仓一趟捕获 = 20,000 文件 / 404 MB /
9–12 s，其中 9,880 条来自 `.tmp`，含 **19 枚 `.asar` 测试夹具**）。名字里含 `.asar` 段的路径在 **Electron 宿主**里
被 asar 虚拟化接管 —— `fs.stat`/`readdir`/`read` 都会去当容器解析。单个调用失败是**可捕获**的
（实测 5 种调用都抛 `Invalid package`、退出码 0），但**放在整趟捕获里会让宿主进程原生消失**：
`crashpad not connected` + 退出码 **4294930435**（Electron 原生崩溃码；Stack Overflow 上的同类问题也是这个码）。

**A/B 实测（同一份输入、同一趟真机捕获、都在 Electron 里跑）**：

| 条件 | 结果 |
|---|---|
| `.tmp` 下 19 枚 `.asar` 夹具在场 | 进程死（`crashpad not connected`，JSON 一行都没来得及打） |
| 把它们全部改名成 `.asar.bak` | 同趟跑完：20,000 文件 / 404 MB / 9 s / **退出码 0** |
| 只改 `app.asar` 两枚（t4/t6 的 `*.asar` 夹具仍在） | **仍然死** ⇒ 触发面是**所有**含 `.asar` 段的路径 |
| 修复后（夹具全部在场、不再碰该类路径） | 跑完：**退出码 0**，`archive.cc` 报错行 = **0** |

**改法**：新增 `hasAsarSegment()`，在 `listChunkFiles` 的走查回调里（以及分块根）**在任何 fs 调用之前**把含
`.asar` 段的路径记成 `skipped('asar-container')` 并跳过。它在**证明名单**里 ⇒ 不会被当成「留点后新建」删掉。

**教训**：① **宿主 fs 的 `.asar` 虚拟化按「路径段」生效，与文件真假无关** —— 不能拿「读文件本身是安全的」当理由；
② **归因必须 A/B**：第一次只做了源码阅读 + 单调用实测就下结论，错过了一整个「改个名就能证伪」的机会。

## 回退的会话隔离：写入归属台账 + 路径级选择性恢复（2026-10-17）

**问题（用户实测反馈）**：工作区里对话 A 改了文件，**已经结束的**对话 B 回退时把 A 的改动一起撤销了。
根因不是缺陷而是粒度：回滚点的「工作区态」是**整棵树**的捕获（`chunks = [会话 cwd]`），回退也按整棵树执行 ——
与「谁改的」无关。同一工作区实测：3 个对话 5 个点，`chunks` 全部逐字相同；单点记录 7,269 ~ 38,138 条文件。

**为什么做不到「按会话自动分文件」**：捕获只存内容（path + sha256），没有任何「哪个会话写的」字段；
唯一可替代的信号「两点之间的内容差异」会把窗口内**别的**对话的改动一起算进来（半隔离，仍会误伤），
而 tool-call 参数归属对 bash / 脚本 / 外部编辑器写的路径拿不到 —— 拿不准的归属用在破坏性写操作上比不隔离更危险。

**修法（互相配合的三条）**：
1. **写入归属台账**（`src/core/rollback-attribution.ts`）：`session/event` 的 `tool/call` 事件带
   `callId`/`name`/`arguments`（JSON 字符串）⇒ 对**写类工具白名单**（write / edit / ops_replace…）
   抽出 `file_path`/`path`，记「路径 → {sessionId, tool, callId, at, turn}」。落盘
   `dataDir/rollback-points/attribution.json`（debounce 1 s、原子写、条目上限 20,000 淘汰最旧、读写失败只 warn）。
   **未判定绝不当作「别的会话写的」**：读工具（read/grep）里的 path 不入表（否则回退会误跳过文件）。
2. **回退时自动跳过**（未显式点名时）：`writer.sessionId !== record.sessionId && writer.at > track.capturedAt`
   ⇒ 该记录条目不写，计入 `foreignSkipped` 并进 detail；**显式 `onlyPaths` 压过归属隔离**（用户明确要它）。
3. **路径级选择性恢复**（`onlyPaths`）：面板预览逐文件勾选（默认只勾非 foreign 的行）；点名一个
   「既未记录、也不在删除候选」的路径 ⇒ `invalid-input` **零写入**；全选 ⇒ 不传字段（走既有全量口径）。

**判据 / 不变量**：foreign 只在**确知**时才标（有归属 + 不是本会话 + 时间晚于留点）；三条都是「少做」的安全方向；
顶层 `code` 仍是既有口径（工作区段失败 = `restore-failed`），具体原因在**段**的 `reasonCode`/`detail` 里逐字可查。

**测试**：`src/core/rollback-attribution.test.ts`（9 条：白名单 / 解析 / 去重 / 落盘回读 / 淘汰 / 落盘失败只 warn）、
`rollback-point.test.ts` 的 A-1 / A-2 / B-1 / B-2 / B-3（选择、fail-closed、隔离、未判定、点名压过）、
`rollback-view.test.ts` 的选择模型（默认勾选 / 全选不传 / 空选拦住）。全量 `npm test` = 4555 项、0 失败。

**AGENTS.md 未加行（如实）**：`node scripts/check-agents-budget.mjs` 报 28650 B / 硬上限 28672 B（余 22 B），
本轮规则只落在本文件；要进 AGENTS.md 需先腾出约 150 B。

## 跨对话安全回退：三方合并取代「整文件跳过」（2026-10-17）

**上一版（同日早先）**：发现某文件在留点后被别的会话写过就**整文件跳过**（保留对方版本）。
问题很明显：那等于**完全不撤销本会话的改动** —— 少了该撤销的那一半。

**这一版 = 三方合并**，三方各自是什么：
- `ours`   = 回滚点里记录的内容（= 本会话改动**之前**的版本，对象仓直取）；
- `base`   = 目标点之后**最早**那份仍含该路径的中间版本（= 别的会话那个回合的点 ——
  回滚点是「回合开始前」拍的，所以它正好是共同祖先）；
- `theirs` = 当前磁盘。
结果 = ours + (theirs - base)：撤销本会话、保留对方。**取最早而不是最近**是刻意选安全方向。

**四条硬判据（`src/core/rollback-merge.ts`）**：
① 任一方向的 diff 被规模预算降级（`degraded`）⇒ **拒绝合并**（绝不拿「整块替换」的近似脚本算合并）；
② 两侧改到同一处（含同一插入点）⇒ **冲突**：返回 theirs + `ok:false`，调用方**零写入**并交给用户；
③ 含 NUL = 二进制 ⇒ 不合并；
④ 依赖风险只做**启发式提示**（被撤销行里的标识符仍出现在结果中，最多 8 条）——
   它不构成「删除不安全」的证明，也绝不因此声称合并正确。

**引擎侧配套（`restoreWorkspace`）**：
- `base` 找不到（没有中间点）/ 对方删了文件（theirs-missing）/ 二进制 / 降级 ⇒ `unavailable`：**不写**、如实计数；
- **两道并发闸门**：needed 阶段一遍、前像暂存之后紧邻写入再一遍（`expectedCurrent` 哈希）——
  不符即放弃该条（绝不覆盖比我们更新的内容）；
- **删除集同受归属保护**：留点后被别的会话写过/建过的路径不删（进 createdSkipped；预览与执行同源）；
- 复核用「这次真正写进去的那份内容」的哈希 —— 合并结果 ≠ 记录原文，拿记录哈希复核会误判成整体回滚；
- 救援点（guard）**不得**当 base：它在执行回退那一刻拍、内容≈当前磁盘，用它会让结果直接等于 ours = 整文件覆盖。

**测试**：`src/core/rollback-merge.test.ts`（11 条：区域合并 / 同行冲突 / 同插入点冲突 / 同改动不冲突 /
二进制 / 尾换行 / 风险提示）、`rollback-point.test.ts` C-1..C-7（不同区域、同行冲突、对方删除、
删除集保护、并发（包装 `openUndoStager` 模拟窗口期外部写入）、无中间版本、对方没改）。
全部按**最终文件内容**断言。全量 `npm test` = 4580 项、0 失败。

**已知限制（如实）**：预览不预先计算冲突（冲突在回退执行时判定并如实报告）；
`base` 依赖「别的会话在自己的回合留过点」，没有就只能按 unable 处理；合并正确性只在**文本**层面成立，
依赖关系只给启发式提示，不保证程序语义正确。

## 真机复盘：为什么「两个对话各加一行描述，回退后两行都没了」（2026-10-17）

**症状**：同一项目里对话 A 给 README 加了「A对话」，对话 B 又加了「B对话」；回退对话 A 之后**两行都没了**。

**现场数据（可复核，全部在当时的回滚点台账里）**：
- 目标点 `rb-mvci8whe`（A 的回合 2，14:41:45）—— 它的内容 = 只有标题（A 改动之前）；
- B 的回合点 `rb-mvci95u7`（14:41:57）—— 内容 = 含「A对话」（= 三方合并的共同祖先）；
- 回退时自动留下的救援点 `rb-mvciamwz`（14:43:05）—— 内容 = **含「A对话」+「B对话」**（= 回退前的完整状态）；
- 归属台账 `attribution.json` 里该文件只有**一条**记录，写入者是 **A 自己**那次 edit（14:41:46）。

**根因**：合并的**触发条件依赖归属**。归属里没有 B 的写入 ⇒ 代码认为「没有第三方改过它」⇒ 直接走**整文件覆盖** ⇒ 把 B 的描述一起抹掉。
（归属为什么缺 B 那次写入：两种可能都存在 —— 写入工具不在白名单，或另一个 DSH 进程把单文件归属台账**整体覆盖写**。二者都不该、也无法被当作安全判据。）

**四条修复**：
1. **触发不再看归属**：只要目标点之后存在**别的会话的回合点**（那它就是共同祖先），就走三方合并；
2. **base 必须有信息量**：`base === ours` 时它提供不了「本会话改了什么」⇒ 按「无祖先」处理（有旁证 ⇒ 不动它并报告；无旁证 ⇒ 退回旧口径整文件覆盖）。
   这一条是既有测试 R-25 抓出来的：guard 之后那个点的内容与目标点相同，拿它当 base 会让「回退到该点」变成「什么都不做」；
3. **删除集保护加第二证据**：除归属外，「别的会话的回合点里记录过该路径」也足以拒删（同样不依赖归属）；
4. **归属落盘改为「写前先读、同键取较新」**：多进程各自「整体覆盖」会把对方记录抹掉。

**数据恢复**：救援点里就有回退前的完整字节 ⇒ 已原字节写回 `README.md`（恢复前的内容与 guard 内容都备份在 `.tmp/restore-*`）。

**教训（可复用）**：
- **旁证不能当安全判据的触发条件**：归属是"尽力而为"的旁证；判据必须落在**台账/快照本身**（点存在、内容可取证）。
- **三方合并的 base 必须真的有信息量**：`base === ours` 的"祖先"等于没有祖先。
- 回归测试要**按最终文件内容**断言，并且**刻意不给归属**（C-8 就是这么复现的）。

**第二轮（同日稍后）：预览与执行不同口径 + 冲突判据过严**
- 现场：README 已含两行描述，但台账里**没有新的 guard 点** ⇒ 用户看的是**回退预览**，并未真的执行回退。
- 两个独立缺陷：① **预览与执行不同口径** —— 预览按「覆盖回 record 版本」算差异，而执行端先做三方合并，
  于是预览把对方那一行也标成「会被删」（用户据此以为还会丢别人的改动）；② **冲突判据过严** ——
  「删掉 `[s,e)`」与「在 `e` 处插入」被判成冲突（真机形状正是：A 删掉尾部一行、B 在其后追加一行），
  于是合并结论变成「什么都不做」。
- 修法：`touches()` 里纯插入点只与区间**内部**冲突（端点不算）；预览接入与执行**同一份** `mergeForeignRecord`
  判定，并新增 `skipped`（不会改动）+ `mergeReason`，行级统计一律 null（「不改动」≠「0 行变化」）。
- 真机验证方式（可复用）：注入 `writeFile` seam 跑真的 `rewind`，只记录「引擎打算写什么」；
  以及直接 `preview()` 看 `workspace.files` 的差异计数。实测：执行打算写 `# DSH\nB对话`、预览显示 `−2 +0`（一致）。
- 教训：**「预览与执行同口径」不是文案要求，是判据要求** —— 只改一侧的判定会让用户看到假差异，
  而他会据此对数据安全下结论。

**第三轮：合并结论「等于现状」会让回退静默失效（同日发现）**
- 真机形状：回退对话 B（目标点 = B 回合开始前，ours = 「标题+A对话」），当前磁盘 = 「标题+B对话」，
  而 base 取到了目标点**之后**另一份快照（15:14，内容已包含两个描述）⇒ `mergeThreeWay` 得出
  **clean 且结果 === theirs** ⇒ 旧实现把它当「无需改动」⇒ **预览报 0 个文件、执行返回 nothing-to-restore**，
  用户看到的是「点了回退，什么也没发生，界面还说没有东西可退」。
- 修法：`result.text === theirsText`（且 ours ≠ theirs）**不再返回 unchanged**，改为 `blocked('ambiguous')`
  ⇒ 预览列出该文件并标「不会改动」，执行零写入并计入 `unavailableCount`。
  真正 `ours === theirs`（内容本来就一致）仍走 unchanged。
- 为什么不能给出「只撤销 B 那一个改动」：B 的**改动后**状态没有任何快照 —— 只有「回到某点」或「拒绝」两种可靠选择。
  想要后者生效，读者可在改动之后再发一条消息（那会留下「改动后」的点），三方合并立刻就能算出最小撤销。→ 报告里已说明。
- 教训：**「合并结论 = 现状」必须与「真的不需要改动」区分**；前者是「我们不知道该怎么退」，后者是「已经一致」。
  把前者当后者 = 静默失效，比报错更糟。

---

## 用户消息气泡与宿主**逐值对齐**（2026-10-17，用户要求「完全一致」）

**来源**：用户 2026-10-17 明确要求「本插件绘制的消息气泡与 DSH 原生气泡完全一致」。上一版把三处差距登记为
「近似档、本任务不做」（见 DESIGN.md §15b 旧注与 `docs/spec/known-gaps.md` G-39 增量（五）③），本轮全部收回。

**取证方法（可复现，零依赖）**：DSH 桌面把实现整套放在 `D:/Apps/DSH/resources/app.asar` 里（系统提示里的
`app.asar/dsh/` 是**虚拟路径**，rg/glob 读不到）。asar 头 = `u32@0 = 4`、`u32@4 = headerSize`、
JSON 起于 `buf.indexOf('{"files"}')`、文件数据基址 = `8 + headerSize`（**注意 JSON 不在 `8` 处起**，
从 8 开始还有 8 字节 pickle 包装 —— 直接 `JSON.parse(buf.slice(8, 8+headerSize))` 会报
`Unexpected non-whitespace character after JSON`）。抽出两个产物：
`dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js`（MessageItem / MessageIconActions 的 CSS Modules
内联字符串 + 组件 JSX）与 `…/dsh-client-ui-theme/lib/client.js`（`--dsw-radius-*` 等 token 真值）。

**宿主真值（逐字，2026-10-17 抽出；DSH 桌面运行时 0.2.0-rc.2）**：
- `.userRow{flex-direction:column;align-items:flex-end;gap:6px;display:flex}`
- `.userStack{min-width:0;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);flex-direction:column;align-items:flex-end;gap:8px;display:flex}`
- `.bubble{background:var(--dsw-specific-bubble);border-radius:var(--dsw-radius-xl);max-width:100%;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;padding:10px 16px}`
  —— **是块级**（没有 `display:flex`）：我们此前自绘的 `display:flex;flex-direction:column;gap:6px` 会把
  正文里由宿主 `projectUserText` 渲染的**技能 / 引用 chip** 逐个挤成独立一行（一带技能就明显变形）。
- `.attachmentRow{flex-wrap:wrap;justify-content:flex-end;gap:8px;max-width:100%;display:flex}`
- `.fileCard{…;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-input-major,transparent);flex:0 0 240px;width:240px;min-height:64px;padding:8px 12px;gap:10px;border:.5px solid var(--dsw-alias-border-l2)}` +
  `.fileIcon{width:28px;height:28px}` + `.fileContent{flex-direction:column;flex:1;min-width:0;display:flex}` +
  `.fileName{font-size:14px;font-weight:500;line-height:22px}` + `.fileMeta{font-size:12px;line-height:15px}`
  —— 元信息是「扩展名大写（≤8 字符）+ 体积」一行，**不是**我们此前「徽标 + 名字 + 体积」的横排小 chip。
- `.referenceSummary{color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}`
- MessageIconActions：`.actions{height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:8px;display:flex}`、
  `.timeStart{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}`、
  `.action{width/height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);padding:6px;display:inline-flex}` +
  `.action svg{width/height:calc(15px + var(--dsh-content-font-delta,0px))}` + `:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`；
  用户消息那一行还额外套 MessageItem 的 `.actions{margin-top:4px;margin-left:-6px}`（负外边距把图标行与气泡右缘对齐）。
- **显现语义**：`@media (hover:hover)` 下，`[data-actions-reveal=hover] .actions` 与
  `:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering]):has(~:is([data-chat-flow-kind=user],[data-chat-flow-kind=steering])) .actions`
  默认 `opacity:0;transition:opacity 80ms`，`:hover`/`:focus-within` 才 `opacity:1` ⇒
  **「后面还有用户/steering 消息」的那几条默认收起、最后一条常亮**。我们照抄这条规则（用宿主自己的
  `data-chat-flow-kind` 祖先属性，不自己数 DOM 节点）；退路是规则不命中 ⇒ 动作行常显（不会消失）。
- **宿主用户消息没有分支按钮**：`UserMessageNodeView` 给 `MessageIconActions` 只传 `text/time/clock:'start'/className`，
  **不传 `onBranch`**（`extraActions` 只接 `conversation.chat.assistant-actions`，用户消息没有 actions 子位）——
  这也是「入口只能靠 priority -1 接管 user cell」的又一条旁证。

**radius 档真值（修正旧注释的错值）**：`@deepseek-ai/dsh-client-ui-theme/lib/client.js` 里
`--dsw-radius-xs:4px / sm:8px / md:12px / lg:16px / **xl:20px**`（全 asar 只有这一处定义 `--dsw-radius-xl`）。
DESIGN.md §15b 旧注与 G-39 增量（五）③ 写的「宿主 14px」**是错的** —— 因此气泡圆角差距是 8px vs **20px**，
不是 8 vs 14。修法不是抄数字，而是 `--cm-r-chat: var(--dsw-radius-xl, 20px)`（宿主换档自动跟随）。

**动作行图标也换成宿主的（2026-10-17 第二问「复制 icon 和 icon 动画也使用 DSH 原生的」）**：
ui-chat 的复制按钮 = `<Tooltip label><button class=action>{copied ? IconCheckOutlineRegular : IconCopyOutlineRegular}</button></Tooltip>`，
三颗图标都从 ui-primitives 取（`lib/index.js` 里 `…OutlineRegular` = Artwork + `strokeWidth: 1`，16×16 viewBox、size 缺省 16、
`currentColor`；整包共 328 个 `Icon*` 名字，我们只闭集取三颗）。**宿主没有形变动画** —— `.action svg` 只声明宽高，
复制成功就是换图；所以我们把 morphicons 的 `CopyStateIcon` 降级成「拿不到宿主图标时的回落」，宿主路径只换图。
闸门 = `common/host-primitives.ts` 的 `hostIcon()`（与 `hostFileTypeIcon` / `hostUserTextProjector` 同一条惰取纪律：
ESM 单测里没有 `require` ⇒ 恒回 null，因此**单测只能验回落路径**，真机路径证据是 app.asar 抽出的源码）。

**遗留（如实登记，未做）**：① 时间只显示时刻，不做宿主那种「今天 / 昨天」自动切换（要宿主 `clock.*` 词典）；
② rest 块仍是我们的 `<details>`（宿主是 JsonBlock）；③ 无宿主同款 tooltip；④ 崩溃降级只保留正文。
---

## 跨对话回退的三处真缺陷与修法（2026-10-18，对标 Claude Code checkpointing / OpenCode snapshots）

**取证方式（可复现）**：`.tmp/ab-experiment.ts`（已删）直接驱动 `RollbackPointEngine`，打印回退后的**最终字节**。
三个工作区形状各自独立：A 加一段 / B 再加一段（经典）、A 与 B 改同一函数、CRLF 文件、Latin-1 文件、会话外手改。

**真机/实验证实的缺陷（改前实测值）**：

| 形状 | 改前实测 | 为什么错 |
|---|---|---|
| A 加 `function A`、B 再加 `function B`；回退 A | ✅ `original + B` | 上一轮的三方合并是对的（`foreign-merged=1`） |
| A 与 B 改**同一函数** | ✅ 零写入、B 的版本原样 | 冲突判据正确；但结果报成 `nothing-to-restore`（见 X-3） |
| CRLF 文件（B 在 A 之后追加一行） | ❌ `line1\nline2\nlineB\n`（**CRLF 全丢了**） | `mergeThreeWay` 内部按 `\n` 归一化后 `join('\n')` ⇒ 整份改写成 LF |
| Latin-1（`caf\xE9`）文件，B 追加一行 | ❌ `caf\xEF\xBF\xBD`（**内容真的被写坏**） | `Buffer.toString('utf8')` 把 0xE9 换成 U+FFFD 再 encode 写回 |
| 会话之外手工 append 一行（无归属、无中间点） | ❌ 整文件覆盖回记录版本，`restored=1`，**手改被静默抹掉** | `base=null && !foreignEvidence` ⇒ `fallback`（旧口径整文件覆盖） |

**改法（四块，互相独立）**：

1. **字节保真**（`src/core/text-fidelity.ts` + `rollback-merge.ts` + `rollback-point.ts` 的 `mergeForeignRecord`）：
   `decodeTextBytes` 走 fatal UTF-8 解码 + **逐字节往返自证**；三方只要有一侧不能无损往返，整个合并就退到
   **latin1 视图** —— latin1 是字节的双射，「字符串相等」= 「字节相等」，行级 diff 因此等价于**按字节**做，
   非法字节逐字保留。落盘按 `result.shape`（主导行尾 + BOM）还原；`encodeTextBytes` 只补 BOM、**不改行尾**。
2. **归属证据从「参数」扩到「时间窗」**（`src/core/rollback-activity.ts` + tracker）：归属台账只从 `tool/call`
   的参数里抽 `file_path`，bash / 脚本 / 外部编辑器写的路径**拿不到** —— 这正是 2026-10-17 真机「B 加了描述、
   回退 A 把 B 那行也抹掉」的根因之一。现在 tracker 对**每个** session/event 记一次活跃窗口，
   回退时按「文件 mtime 落在谁的窗口内」判定：命中本会话 ⇒ 照旧撤销；命中别的会话 ⇒ 合并或拒绝；
   **有覆盖却谁都不活跃** ⇒ `unclaimed`，零写入并逐条列出（手改 / 外部工具 / 另一个进程）。
   `hasDataFor` 是「有没有覆盖」的自证：**没有覆盖一律 `unknown`**（不拦），绝不凭空多拦。
3. **没有祖先 ≠ 可以整文件覆盖**（`mergeForeignRecord` 的决策重写）：
   · `base===ours`（本会话相对 base 没改动）**且无证据** ⇒ `unclaimed`（X-1：B 改的 b.txt 不再被覆盖回 B0）；
   · 别的会话回合点里**没有**这条路径（`absentAtForeignPoint`，且该点未被截断）⇒ 当前内容是那个点之后才出现的
   ⇒ 拒绝覆盖（X-7：A 删文件、B 重建，B 的内容保住）；
   · `theirs` 缺失（ENOENT）时，判据只有两条：有祖先 ⇒ `theirs-missing` 不复活（B 删掉的别救回来）；
     归属/时间窗表明是别人写的 ⇒ 同样不复活；**其余照旧重建**（改名、单会话删除的正常回退不受影响）。
     ⚠️ 这里**不能**用 `absentAtForeignPoint`：本会话自己改名 / 删除时，文件在别人的回合点里本来就不存在
     （T6-3 的形状），拿它当「别人删的」会让改名回退直接失效 —— 第一版就是这么写错的，被 T6-3 抓住。
   · **救援点（guard）作为回退目标时一律关掉隔离与合并**（R-25 冻结口径）：它的语义是「回到回退前那一刻」的
     **精确恢复**，让它走三方合并会变成「什么都不做」（guard 内容 ≈ 当前磁盘）。
4. **连续回退可用**：`baseVersionFor` 分两档 —— 先找**别的会话的回合点**（正统共同祖先），
   找不到再允许**救援点**当 base，且只在「救援点内容 ≠ 当前磁盘」时才算数（否则拿它当祖先会把对方已经
   改进去的内容当成基线 ⇒ 合并结论 = ours ⇒ 整文件覆盖）。X-10 的「先退 A 再退 B」由此得到
   共同起点 `l1..l5`，而不是「A 复活 + B5 丢失」。

**崩溃/中断的事务性（2026-10-18 新增）**：`UndoStager` 此前把前像写成 `0.bin/1.bin…`，**没有索引、没有完成标记**；
进程崩在写入中途后，`cleanupOrphanTempFiles` 会按「pid 已死」把整个 undo 目录**删掉** ⇒ 工作区留在半回退状态，
无人知晓也无法恢复（任务明确禁止「留下未记录的部分修改」）。现在：
- `src/core/rollback-undo-journal.ts`：`journal.jsonl`（路径 + 前像 bin + **after 镜像** + seq + at），先落 bin 再 append + fsync，
  全部写完才 `finish()` 落 `done`；
- `cleanupOrphanTempFiles` 新增例外：**有 journal 却没有 done ⇒ 不删**（那还能救命）；判据与 journal 模块共用常量；
- 引擎 `interruptedRollbacks()` / `recoverInterruptedRollback(dir)`：只读列出中断现场；重放时**只有当前内容仍等于
  after 镜像**的条目才写回 —— 崩溃之后发生的任何人工 / 外部 / 别的会话的改动一律跳过并逐条回报，且**没全成功就不清现场**。
- 测试 `src/core/rollback-interrupted.test.ts` I-1/I-2/I-3（真实目录：清理不得删现场、落 done 后可清、只自证成立才写回）。

**竞品对标（口径：【文】官方文档 /【码】源码 /【推】推断）**：
- **Claude Code**【文】：每轮 prompt 前建 checkpoint；恢复三档（code / conversation / both）；**bash 改的文件、子代理编辑、
  外部与并发会话编辑、符号链接与硬链接路径都不（能）恢复**，并显式告警 `Restored the code, but skipped N files`；
  每会话留最近 100 个 checkpoint，快照随 retention sweep 默认约 30 天清理。闭源，**没有任何官方证据**表明它用 git/shadow repo。
- **OpenCode v2**【文+码】：独立 gitdir（`<data>/snapshot/<projectID>/<hash(worktree)>`）+ `alternates` 复用源仓对象 +
  `write-tree` 得**内容寻址** tree id 作快照；assistant message 持久化 `snapshot.start/end/files`；
  `/undo` 是**暂存式**（先 capture 当前态作 original，再恢复 + prompt 回填），`/redo` 用 original 撤销暂存；
  restore 只动映射内的路径、树中缺失即删除；**从不 prune**，已知 `~/.local/share/opencode/snapshot` 可涨到 566.7 MB（issue #36093 仍 open）。
- **同一文件被多个对话先后修改**：【无】任何一方有跨会话冲突检测 / 三方合并 / 锁定 —— Claude 只说「除非命中同一批文件，
  否则并发编辑不被捕获」，OpenCode 的快照库按 project/worktree 共享、restore 不校验来源。本仓的
  「归属台账 + 活跃时间窗 + 三方合并 + 无法判定即零写入」在这一维度上确实领先，**但它只在文本层面正确**：
  依赖关系只给启发式提示（被撤销行里的标识符仍出现在结果中），不构成语义安全的证明。

**测试**：`src/core/rollback-cross-session.test.ts`（22 条：T1-1/X-1/T2-1/X-3/T4-1/X-5/T6-1..3/T7-1..2/X-7/X-8/T8-2/T9-1/
X-10/T10-2/T11-1..2/X-12a..c，全部按**最终文件内容/字节**断言）、`rollback-merge.test.ts`（M-1..M-24）、
`text-fidelity.test.ts`（F-01..F-18）、`rollback-activity.test.ts`（A-1..A-10）、`rollback-undo-journal.test.ts`（J-01..J-12）、
`rollback-interrupted.test.ts`（I-1..I-3）。

**已知限制（如实）**：① 依赖关系只做启发式提示；② 「同一插入点两侧各插一行」判冲突、不猜顺序（X-5 已按 [SAFE] 改写并写明理由）；
③ 无任何证据（未接时间窗 / 老数据）时仍按旧口径整文件覆盖 —— 判据只允许「少做」，不允许凭空多拦；
④ 中断回退的**恢复入口目前只有引擎 API**，尚未接路由 / 界面（后续）；
⑤ 连续回退的第二刀依赖第一次回退留下的**救援点**（生产缺省会留；显式 `guardPolicy:'off'` 时没有）。


