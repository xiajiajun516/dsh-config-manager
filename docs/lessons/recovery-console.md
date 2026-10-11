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
- **剩余已追认差距（不修，登记在 `docs/spec/known-gaps.md` G-39）**：① **技能 chip 与引用 chip 的「可点开」外观未做** —— 引用摘要行与正文会话线格式**已复刻**（2026-10-10 t9），`skillNames` 仍未接线（不渲染也不编造）；② 文件类型图标仍用**扩展名徽标**（`FileTypeIcon` 不在 ui-primitives 导出表），但扩展名口径已对齐宿主（dotfile 前导点算后缀 + 8 字符截断，`.gitignore` → `GITIGNOR`）；③ 时间**固定 24h 补零 `HH:mm`**、仍**不做「今天 / 昨天」**；④ 动作行**常显**、**无宿主同款 tooltip**；⑤ **崩溃降级只保留正文**；⑥ 底色 / 圆角 / 字号近似（`--cm-surface-2` / 8px / 12.5px vs 宿主 `--dsw-specific-bubble` / 14px / 14px）。
- **复刻对齐的 5 处（2026-10-10 t4 复核 → t9 修复，全部按宿主复刻、不是登记差距）**：D1 compact = 附件总数（图片 + 文件）> 1；D2 附件按 content 原始顺序渲染；D3 体积文案逐字（无空格；单位值 < 10 才一位小数，否则取整）；D4 时钟固定 24h 补零（不再 `toLocaleTimeString`，en-US 下不再出现 `05:04 PM`）；D5 正文会话线格式 `@[label](dsh-session:…)` → label + 引用摘要行（气泡与崩溃降级两条路径都投影）。护栏 = `chat-entry-view.test.ts` **31** 条 + 复核探针前后对照（真浏览器 DOM 32/32）。
- **bytes 缺失时的有意差异**：宿主 `fileSizeText` 读不到字节数会渲染 `NaNGB`，我们**不渲染**（`fileSizeTextOf` 回 null → 整段不显示）—— 有意更诚实，**不是缺陷**。

- **留点发生在回合收尾之后：任何一次即时查询都可能早于它（2026-10-10 真机，聊天回退入口「捕获晚于查询」竞态）**：用户报「回退按钮点不开、显示『这个回合还没有回滚点』，可那个点其实已经创建」。量化证据（本机真机）：该回合会话日志 `~/.dsh/sessions/--D-Projects-personal-dsh-settings-tidy--/session-e3a7953c-068c-48aa-8e87-7f5c230806da/session.v4.jsonl.zstd` 的**创建时间 = 该回合 `turn/end`** 20:03:38.6496444Z、最后一次写入 20:03:46.4211472Z；台账 `~/.dsh/dsh-config-manager/rollback-points/index.json` 里那个点 `rb-mv2to29u-ae62bd7b`（`kind=auto`、`turnSeq=1`、记录 **355 个文件**）的 `createdAt` = 20:03:46.434Z ⇒ **引擎在收尾之后 7.77 秒**才写完这个回合的点（355 文件的捕获耗时就是这 7.8 秒的来源）。客户端旧实现只在挂载后**查一次**、空结果又被 **30 秒**列表缓存锁住、**从不重试** ⇒ 首查撞上这个空窗就永久禁用（点其实已创建）。**口径**：留点发生在回合收尾**之后**，任何一次即时查询都可能早于它；「读到空列表」在窗口内是**暂态**、不是结论。修法 = 收尾后**有界重试**（窗口 30 秒；退避 0.5 / 1.5 / 3 / 6 / 12 秒，累计 23 秒；最多 6 次列表读取 = 1 首读 + 5 重试；**命中即停**；**每个挂载只跑一轮窗口**，重新进入视图再开一轮 —— 不是无限轮询；重试轮用 `force` 跳过那 30 秒缓存去宿主再读一遍并写回），窗口内如实说「正在读取回滚点…」、**只有窗口关掉且仍为空**才说「这个回合还没有回滚点」。护栏 = `src/client/chat/chat-entry-view.test.ts`（R1 六条）+ qa 独立复核 `.tmp/verify-r1/` **26 / 26 pass**（虚拟时钟复现「首查空 → 1–8 秒后点出现」：修复前 1 次读取 ⇒ 永久 `noPoint`/禁用 ↔ 修复后 5 次读取 ⇒ 可点；空会话恰好 6 次读取且窗口后零请求；失败保持 `resolved:false` 乐观口径；卸载后退掉定时器且宿主不再被打）。**NOT VERIFIED**：真机浏览器点击、真实 7.8 秒挂载窗口的端到端取证（时序在虚拟时钟上按同形序列复现）、组件级 effect 重跑次数（`.tsx` 在 node 下不能 type-strip）。登记见 `docs/spec/known-gaps.md` G-30 / G-39 增量（三）。**StrictMode 双调用（dev）**：窗口状态机改为「每次 effect 调用新建实例」后，`start → dispose → start` 不再让窗口永久 `open`（旧形态实测 reads=1、state 恒 `{lookup:null, open:true}`、按钮永久停在「正在读取回滚点…」）；StrictMode 全程宿主读取仍为 **6 次**（被 dispose 的在途读被同会话去重吸收），并顺带修掉「首读在途显示可点」的诚实缺口（在途 = `pointsPending`）。

- **enablement 判据与确认判据必须分层：同一个标志既当可用性前置、又只能由该可用性动作置位时就是死锁（2026-10-11，用户截图：回退预览主按钮永久灰）**：症状 = 聊天「↺ 回退」的预览弹窗**打得开、文案正常**，主按钮「回退」**灰色不可点** ⇒ 整条回退路径不可用。根因 = `submitEnabled = canSubmitRewind(draft, preview) && !busy`，而 `canSubmitRewind` 要求 `draft.confirmed === true`；`confirmed` 初值恒 `false`（`defaultDraft`），**唯一置位入口** `confirmOnSubmit()` 只在 `submit()` 里被调用，而 `submit()` **只能由这个按钮触发** ⇒ **循环依赖**。修法 = 新增 `rewindSubmittable(draft, preview)`（= 固定段集合非空 + `rollbackPreviewVerdict().canRestore`，**不看 `confirmed`**）作为**可点性**判据（对话框实际接线走 `submitButtonEnabled({ draft, preview, pointId, busy })`，t6 复核后并入 `pointId` 与忙态）；`canSubmitRewind` = enablement + **恰好** `confirmed === true`；两者共用私有 `rewindViable`（单一真相）。**确认门未松**（`defaultDraft` 恒 `false` / 唯一置位点 `confirmOnSubmit()` / `buildRewindOptions` 恰好 `true` / 宿主 `userConfirmed !== true` → `confirmation-required` 逐字未动）。**夹具教训（本条最可复用的部分）**：断言用**已确认 draft**（`confirmedDraft()`）当夹具会**掩盖真实初始态缺陷** —— 凡涉及「初始态可点性 / 可提交性」的断言，夹具必须是**用户真实看到的初始态**（`defaultDraft(preview)`）。参考实现 `https://github.com/Anionex/dsh-turn-rewind` 把确认定位在「点击那一刻」（exact two-step confirmation），**确认不得反向成为按钮可用性的前置条件**。护栏 = `src/client/chat/rollback-entry-view.test.ts` 新增 5 条 R1 + t6 复核追加的 R2（F2 源码级绑定守卫含反向自检 / F4 同步 single-flight 锁）+ qa 独立验证 `.tmp/v1-verify/verify-v1.mjs` **100 PASS / 0 FAIL**（`git archive HEAD` 修复前真代码并列求值：修复前 `false` ↔ 修复后 `true`；差分 13×8×16 = 0 差异；6 种 `canRestore=false` 仍禁用；端到端 seam 替身 200 + `childSessionId` + 真导航一次）。**NOT VERIFIED**：真机浏览器 / DOM 的 `disabled` 取证（本仓无组件测试框架；bundle 依赖 DSH 运行时）、真机点击端到端。登记见 `docs/spec/known-gaps.md` G-30 / G-39 增量（四）。

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
