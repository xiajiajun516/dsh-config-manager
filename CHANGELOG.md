# Changelog

本文档记录 dsh-config-manager 的发布亮点（中英双语）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
This file records release highlights of dsh-config-manager (bilingual: 中文 + English). Format: [Keep a Changelog](https://keepachangelog.com/).

> **发布流程**：打 tag 发布时 CI（`.github/workflows/publish.yml`）自动抽取**当前版本段**作为 GitHub Release 描述亮点；
> 如果忘记写当前版本段，CI 会 **fail fast** 拒绝发版，避免漏写。
>
> **Release workflow**: on tag push, CI extracts the current version's section as the release notes highlights;
> the build fails fast if the section is missing, so you cannot forget to update it.
>
> **条目落位（按改动性质分组）**：新条目一律先写进 `## [Unreleased]`，并放进对应分组 ——
> `### 🆕 新增 · Added` / `### 🔧 变更 · Changed` / `### 🐛 修复 · Fixed`（`🗑️ 移除 · Removed` / `🔐 安全 · Security` 同理）；
> 没有内容的分组**不写标题**。已发布的历史版本段保留当时写法，不回改。
>
> **Where new entries go (grouped by change type)**: new entries land under `## [Unreleased]` in the matching group —
> `Added` / `Changed` / `Fixed` (and `Removed` / `Security` when applicable); omit empty groups.
> Released sections keep the style they were written in.
>
> 体例细节、分组表、发版两道门禁与写后自检命令见项目 skill `.dsh/skills/changelog-writing/SKILL.md`（DSH 会自动发现并加载）。

## [Unreleased]

> **本版主题**：把「读不到 ≠ 没有」与「不假装成功」两条口径推到 CLI、同步与回滚三处 —— 恢复预览不再漂移、部分回滚不再说成整体成功、`dcm restore` 补上第三道写入门；
> 同时把早已交付却**点不到**的「检查点（三态同点）」整体改写为 **工作区 + 会话回滚**：按回合自动留点、聊天内「↺ 回退」入口、回退 = fork 子会话 + 只覆盖记录在案的工作区路径。

> **Theme**: push the "unreadable ≠ absent" and "never pretend success" rules through the CLI, sync and rollback — restore previews can no longer drift,
> a partial rollback is no longer reported as full success, `dcm restore` enforces the third write gate, and the long-delivered but **unreachable**
> "checkpoints (three states at one point)" feature is rewritten as **workspace + session rollback**: a point per turn, a ↺ entry inside the chat,
> and rewind = fork a child session while only the recorded workspace paths are overwritten.

### 🆕 新增 · Added

> **工作副本可见 + 可自救：origin 有没有跟上新地址一目了然，一键「重指向 / 重新克隆」**（issue #79）：改仓库地址后同步长期失败时，
> App 内此前**没有任何自救路径** —— 只能手工 `git remote set-url`，或删掉 `<dataDir>/sync/work` 重来。
> - `GET /sync/status` 新增只读 `workDir` 字段（只做 2 条本地只读 git 命令：`remote get-url` 与其 `--push` 变体）；
>   通道卡在「仍指旧地址 / 读不出」时挂 warn 徽章，展开区的「工作副本」卡给出路径、origin 与状态。自检读不出来时回
>   `{ error }` 而**不伪装成「工作副本不存在」**，且不阻断整个状态接口。
> - `POST /sync/workdir/reset`（写动作，过 mutation gate）两种模式：`relink` 只把 origin / push URL 重指向当前地址（非破坏性）；
>   `reclone` 删除工作副本后重新 clone（**丢弃未上行的本地提交** → 必须显式 `confirm: true`，界面走 danger 二次确认）。
>   删除边界：目录非空且无 `.git` 一律拒绝 —— 绝不删来路不明的目录。
> - **护栏**：`src/sync/git/git-transport.test.ts`（7 条：不一致→set-url（fetch + push）/ 一致→零写命令 / 无 origin→`remote add` /
>   空串读取→不改写 / 主机密钥文案 / 真机「改地址后确实写到新远端」 / `rebuildWorkDir` relink + reclone + 非仓库拒绝）、
>   `tests/route/sync-workdir-reset-route.test.ts`（4 条：facts 回传 / error 回传仍 200 / 两种模式 / 四类 400 且不调重建）、
>   `src/ui/sync-settings-view.test.ts`（3 条入口判定）。

> **Working copy is now visible and self-repairable** (issue #79): the read-only `workDir` facts on `GET /sync/status` (two local
> read-only git commands) surface whether the working copy's origin follows the configured address; a warn badge appears when it does not,
> and the expanded "Working copy" card shows path, origin and state. Unreadable self-inspection returns `{ error }` instead of pretending
> the copy is absent, and never 500s the whole status route. `POST /sync/workdir/reset` (behind the mutation gate) offers `relink`
> (re-point origin/push URL, non-destructive) and `reclone` (delete and clone again — discards unpushed local commits, so it requires
> `confirm: true` and a danger confirmation in the UI). A non-empty directory without `.git` is refused. Guards: the git transport tests,
> `tests/route/sync-workdir-reset-route.test.ts`, `src/ui/sync-settings-view.test.ts`.

> **自动同步说清「为什么没同步」**（issue #79）：`lastRunMessage` 此前**从不渲染**，跳过原因只写 `host.log.info`（默认级别 warn）——
> 真机现场连续 16 次 `skipped/mutation-locked` 期间，用户只能去翻 `sync-autosync.json` 猜。
> - `AutosyncConfig` 与状态接口新增结构化 `lastRunSkipReason`（+ 冲突的 `lastRunSkipCount`）：传**码**不传文案
>   （语言在渲染那一刻解析），未知码给字典兜底、**绝不渲染裸枚举**；自动同步卡新增「跳过原因」与「本轮消息」两行。
> - 跳过原因 → 字典键的映射收敛为 `history-model.skipReasonKey`（历史行与状态行共用一份），并补齐 `upToDate` / `unchanged` /
>   `unconfigured` 三个此前会裸透到界面的码。
> - **护栏**：`src/client/sync/sync-view.test.ts`（3 条）、`src/client/sync/history-model.test.ts`（源码守卫 + 2 条映射）、`src/sync/autosync-scheduler.test.ts`。

> **Auto sync now says *why* it did not sync** (issue #79): `lastRunMessage` was never rendered, and skip reasons went only to
> `host.log.info` (the default level is warn) — during the reported 16 consecutive `skipped/mutation-locked` runs the user had to
> dig through `sync-autosync.json`. A structured `lastRunSkipReason` (plus `lastRunSkipCount` for conflicts) now travels as a
> **code**, localized at render time, with a dictionary fallback for unknown codes and no raw enums in the UI; the auto-sync card gained
> "skip reason" and "last message" rows, and the reason→dictionary-key mapping is shared through `history-model.skipReasonKey`.

> **MCP 服务器可以走同步通道了（可选分区，逐分区放行）**（issue #78）：v0.1.69 起同步通道（Git / WebDAV / 对象存储 / Gist）
> **只处理 portable 分区**，而 `mcp` 注册为 `platformSpecific` —— 高级模式勾上它只会得到 `sync.skipNonPortable` 警告，
> 快照里**从来没有这个分区**，换机后只能手写 `dsh-mcp-client` 行。
> - **单一事实源**：分区注册表新增 `syncOptIn: 'off' | 'manual' | 'auto'`（此前 `optInSync: boolean` 是**死字段**，真正的白名单
>   是 `sync-selection.ts` 里手写的 `['sessions']` —— 两份字面量、零护栏）。`mcp='auto'`（勾选后手动与自动同步都带）、
>   `sessions='manual'`（仍只跟随手动 push/pull）、其余 `'off'`；`OPT_IN_SYNC_SECTIONS` 改为注册表派生视图。
> - **放行粒度从布尔改为分区集合**：`SyncEngineOptions.includeOptInSections: boolean` → `optInSections: readonly SectionId[]`。
>   旧布尔是「任一可选分区被勾 → 拉取侧放行**全部**可选分区」，加了 mcp 之后会变成「只勾 mcp 也会把远端会话拉下来」——
>   这条回归在 `sync-engine.test.ts` 有专门用例钉住。自动同步仍只放行 `'auto'` 档，**会话绝不悄悄上行/下行**。
> - **如实说明**：拉取侧 mcp 是 medium 风险 → `classifyMergePlan` 把它放进 **review（差异确认）**，自动同步**不会静默写入** mcp
>   （首次同步更是全量待审）；也就是「自动同步」只保证远端快照带上了它，目标机落盘仍需一次人工确认。
> - **界面**：同步分区弹窗给 `platformSpecific` 补上「平台相关」徽章（此前这类分区只显示「推荐」，看着像可移植），
>   并给 MCP 行加 ⓘ 说明（patch 行按层写回；npx / uvx / pipx 装的可跨机；绝对路径 command / cwd 或目标机缺运行时时以导入分析提示为准）。
> - **护栏**：`src/sync/sync-engine.test.ts`（3 条：未放行跳过并告警 / 放行 mcp 不得连带放行 sessions（推 + 拉）/ 自动同步档 push 携带 mcp）、
>   `src/sync/sync-selection.test.ts`（白名单 = 注册表派生；auto 档 = `['mcp']`）、`src/schema/registry.test.ts`。

> **MCP servers can now travel over the sync channel (opt-in section, per-section granting)** (issue #78): since v0.1.69 the sync channel
> (Git / WebDAV / object storage / Gist) **only handles portable sections**, while `mcp` is registered `platformSpecific` — ticking it in advanced
> mode only produced a `sync.skipNonPortable` warning and the section was **never** in the snapshot, so the target machine had to have its
> `dsh-mcp-client` rows written by hand.
> - **Single source of truth**: the section registry gains `syncOptIn: 'off' | 'manual' | 'auto'` (the old `optInSync: boolean` was a **dead field**;
>   the real whitelist was the hand-written `['sessions']` in `sync-selection.ts` — two literals, zero guards). `mcp='auto'` (carried by both manual
>   and auto sync once ticked), `sessions='manual'` (still manual push/pull only), everything else `'off'`; `OPT_IN_SYNC_SECTIONS` is now derived.
> - **Granting is per section, not a boolean**: `SyncEngineOptions.includeOptInSections: boolean` → `optInSections: readonly SectionId[]`. The old
>   boolean meant "any opt-in section ticked → grant **all** opt-in sections on pull", which with mcp added would have pulled remote sessions down
>   even when only mcp was ticked; `sync-engine.test.ts` pins that regression. Auto sync still grants only the `'auto'` tier, so **sessions are
>   never uploaded or downloaded silently**.
> - **Stated honestly**: on the pull side mcp is `medium` risk, so `classifyMergePlan` puts it in **review (diff confirmation)** — auto sync does
>   **not** apply mcp silently (a first sync reviews everything). Auto sync only guarantees the remote snapshot carries it; writing it locally still
>   needs one human confirmation.
> - **UI**: the sync-section dialog now badges `platformSpecific` sections as "Platform-dependent" (previously such a section only showed
>   "Recommended", looking portable) and adds an ⓘ for MCP rows (patch rows are restored to their own layer; npx / uvx / pipx installs are portable;
>   absolute-path command / cwd or a missing runtime on the target is reported by the import analysis).
> - **Guards**: `src/sync/sync-engine.test.ts` (3 cases: skipped + warned when not granted / granting mcp must not grant sessions (push and pull)
>   / auto-sync push carries mcp), `src/sync/sync-selection.test.ts` (whitelist derived from the registry; auto tier = `['mcp']`),
>   `src/schema/registry.test.ts`.

> **「检查点（三态同点）」整体改写为「工作区 + 会话回滚」，并接进界面与聊天**（**G-30 收口**）：旧三态引擎（`src/core/checkpoint.ts` + `samePointVerdictOf` 同点判定 + 7 条 `checkpoints/*` 子路径）在本批内删除，
> 取而代之的是两态引擎 `src/core/rollback-point.ts`（**注意：`src/core/rollback.ts` 是既有的导入失败补偿引擎，与本功能无关，未动**）。留点改为**按回合自动**：宿主订阅 `session/event`，
> 每见到一个 `turn/end` 就为当前会话留一个点 = 工作区快照（内容寻址入对象仓）+ 会话游标（事件数 / 字节长度 / fork 边界）；手动「拍点」表单与 `capture` 子路径随之删除。
> - **界面**：**环境 → 维护与诊断** 的卡片改为 `RollbackCard` —— 按会话分组的时间线 + 只读预览（覆盖 / 其中不同 / 已不存在 / 该点之后新建「保留不动」四类计数，含回合号与会话边界）；
>   三选一范围 `files+session` / `files` / `session`（不可用组合直接禁用，绝不发注定失败的请求）；两态不齐须显式勾「允许部分回退」；danger 二次确认；逐段结果含 fork 出的子会话 id 与救援点 id。⌘K 同族命令改名「回滚点（回到某个时刻）」。
> - **聊天内「↺ 回退」**：新增槽位 `conversation.chat.turnTail` 上的入口（cell id `config-manager-rollback-entry`），点开即复核对话框，成功后自动打开 fork 出的子会话。该入口现在是**「整回合」档与兜底入口**；**缺省形态已于 2026-10-10 改为「每条用户消息一个」**（见「变更」组条目：接管 `conversation.chat.node` 的 user 渲染器 + 复刻气泡 + 形态偏好开关）。运行中的回合还没有点，故入口主动隐藏。
> - **版本边界（别写成「任意版本都能用」）**：子会话导航面在 0.2.x 是 `ctx.uiWorkspace.openSession(id)`（shipped ui-chat 自己的 fork 流程用的就是它）；没有导航面时**如实降级**为 `unavailable`（显示 childSessionId，绝不假装已打开）。槽位声明**探测后才注册**：只有声明确为 `list` 才注册 —— 0.1.5-rc.2 把同一 key 声明成 `chain`，按 list 形态注册会抛，因此**整条入口跳过**（`slot-kind-mismatch`）；跳过或注册异常只丢这一个入口，不影响本插件其余槽位与宿主启动。
> - **会话回退 = fork，绝不改写日志**：在目标回合**之前的稳定边界**（该回合 `turn/start` 的 seq − 1）调 `ctx.sessions.fork(source, boundary, childId?)`，**原会话日志只读、逐字节不变**
>   （与旧版「逐字节写回日志」相反，旧版的静止期门 / 分叉门 / 字节副本写回全部下线）；读不到前置边界时返回结构化 `no-boundary`，**不猜一个边界**。
> - **工作区恢复的诚实边界**：只覆盖快照记录在案的路径，**绝不删除**未记录的文件与该点之后新建的文件（它们只进 leftovers 报告）；恢复前自动留救援点、恢复后逐文件核对 SHA-256，
>   任一不符即**整体回滚**（`restored=0`，绝不把已写条数当成功）；确认门 fail-closed（`userConfirmed` 必须恰好 `true`，否则 409 `confirmation-required`）。
> - **救援点（guard）的留存口径**：回退前自动留；**不占**自动点的每会话 20 / 全局 50 预算，也**不会被**它们淘汰；用户**不可手动删除**（`remove` → `protected-point`）。但它**不是无上限保留**：有**自己的每会话上限** `ROLLBACK_MAX_GUARDS_PER_SESSION = 20`，超出只淘汰**最旧的救援点**（否则反复回退会让它无界增长）。
> - **范围与计数**：**不新增宿主注册路由**（仍挂在 recovery prefix 内按 path 分发，宿主注册路由条目仍 **79** 条）。**仍未做**：CLI 入口（`dcm rollback …`）。**未验证**：没有真实宿主进程内的端到端取证、没有浏览器点击取证 —— 见 `docs/spec/known-gaps.md` G-30。
> - **护栏**：`src/core/rollback-point.test.ts`（**25** 条，含 t13 的捕获边界 R-21①–⑤）、`tests/route/recovery-rollback.test.ts`（5 条：全子路径可达 + 未确认 409 零写入 / 404·405·400 / 503 + guidance / 保护点 409 / SAFE MODE 423）、
>   `src/ui/rollback-view.test.ts`（12 条，含源码级「不得再有 config 第三态」断言）、`src/client/chat/rollback-entry-view.test.ts`、`src/client/common/client-route-parity.test.ts`（6 条端点双向对账）。

> **Rewritten as "workspace + session rollback": the "checkpoints (three states at one point)" feature is now wired into both the UI and the chat** (**closes G-30**): the old three-state engine
> (`src/core/checkpoint.ts` + the `samePointVerdictOf` same-point verdict + the seven `checkpoints/*` sub-paths) is deleted in this batch and replaced by the two-state engine `src/core/rollback-point.ts`
> (**note: `src/core/rollback.ts` is the pre-existing import-failure compensation engine — unrelated, untouched**). Points are now captured **automatically per turn**: the host subscribes to `session/event`
> and records one point per `turn/end` = a workspace snapshot (content-addressed objects) + a session cursor (event count / byte length / fork boundary); the manual capture form and the `capture` sub-path are gone.
> - **UI**: the card under **Environment → Maintenance & diagnostics** becomes `RollbackCard` — a per-session timeline plus a read-only preview (overwrite / differ / missing / created-after "left untouched" counts,
>   with the turn number and session boundary); a three-way scope (`files+session` / `files` / `session`, unavailable combinations disabled so no request is sent that cannot succeed); an explicit "allow partial" tick
>   when the record is incomplete; a danger confirmation; and per-segment results including the forked child session id and the rescue-point id. The ⌘K command is renamed to "Rollback point (go back to a moment)".
> - **↺ rollback entry inside the chat**: a new contribution to the `conversation.chat.turnTail` slot (cell id `config-manager-rollback-entry`) opens a review dialog and, on success, opens the forked child session.
>   This entry is now the **"one per turn" tier and the fallback**; **the default was changed on 2026-10-10 to one entry per user message** (see the "Changed" group entry: taking over the `conversation.chat.node` user
>   renderer, replicating the bubble, and the mode preference switch). Turns still running have no point yet, so the entry hides itself.
> - **Version boundary (never claim it works on every version)**: on 0.2.x the session navigator is `ctx.uiWorkspace.openSession(id)` (the same API shipped ui-chat uses in its own fork flow); with no navigator the entry **degrades honestly** to `unavailable` (it shows the childSessionId instead of pretending it opened). The slot is **probed before registering**: only a `list` declaration registers — 0.1.5-rc.2 declares the same key as `chain`, and registering it in list form would throw, so the whole entry is **skipped** (`slot-kind-mismatch`); a skip or a registration error only drops this one entry — the plugin's other slots and host start-up are unaffected.
> - **Session rollback = fork, never a log rewrite**: `ctx.sessions.fork(source, boundary, childId?)` at the **stable boundary before the target turn** (that turn’s `turn/start` seq − 1); the **original session log is read-only and byte-identical**
>   (the opposite of the old "write the log back byte by byte"; the old quiescence gate / fork gate / byte-copy write-back are all retired). When no earlier boundary can be read the result is a structured `no-boundary` — **no boundary is guessed**.
> - **Workspace restore, stated honestly**: only paths recorded in the snapshot are overwritten; files that were never recorded and files created after the point are **never deleted** (they only appear in the leftovers report);
>   a rescue point is taken before restoring, every file is re-read and SHA-256 checked afterwards, and any mismatch triggers a **full rollback** (`restored=0` — written files are never counted as success); the confirmation gate is fail-closed
>   (`userConfirmed` must be exactly `true`, otherwise 409 `confirmation-required`).
> - **Rescue (guard) points**: taken automatically before each rewind; they do **not** consume the per-session 20 / global 50 budget for automatic points and are **never evicted** by it; users **cannot delete** them (`remove` → `protected-point`). They are **not kept without bound**: they have **their own per-session cap**, `ROLLBACK_MAX_GUARDS_PER_SESSION = 20`, and exceeding it evicts only the **oldest rescue points** (otherwise repeated rewinds would grow them forever).
> - **Scope and counts**: **no new host routes** (still dispatched by path inside the recovery prefix; the registered-route count stays **79**). **Still missing**: a CLI entry (`dcm rollback …`). **Not verified**: no end-to-end evidence from a
>   real host process and no browser click-through — see `docs/spec/known-gaps.md` G-30.
> - **Guards**: `src/core/rollback-point.test.ts` (25 cases, including t13’s capture-boundary R-21①–⑤), `tests/route/recovery-rollback.test.ts` (5 cases: all sub-paths reachable + unconfirmed 409 with zero writes / 404·405·400 / 503 + guidance / protected point 409 / SAFE MODE 423),
>   `src/ui/rollback-view.test.ts` (12 cases, including a source-level assertion that the config third state no longer exists), `src/client/chat/rollback-entry-view.test.ts` and `src/client/common/client-route-parity.test.ts` (6 endpoints checked in both directions).

### 🔧 变更 · Changed

> **「回退」= 无感替换：回退后会话列表里只剩那条「退回去的对话」**（用户 2026-10-11 定案）：DSH 的会话日志 append-only，
> 且**宿主内存里的活动会话不会重读磁盘**（实测：把日志截断成合法 v4 后「离开会话再打开」与**整页刷新**都仍是老内容），
> 平台也没有 drop / reload 一个活动会话的 API —— 所以「直接改写当前这条对话」在运行中的 DSH 里**没有可用路径**。
> 改为：官方 fork + 自动切到新会话 + 把**原会话收进「已归档」** + 标题随 fork 的日志前缀一并继承 ⇒ 用户看到的是一条对话退回去了，而不是列表里多出一条。
> - 归档走官方 `workspaces.archiveSession`；失败**三态如实**回报（本客户端没有归档入口 / 原会话仍有进行中的工作 / 其它失败），每种各有自己的文案，
>   **绝不假装已归档**。顺序固定「先导航、后归档」（原会话还挂在当前视图上时 DSH 会拒绝归档；代码里有界重试一次，不无限轮询）。
> - 回退结果文案不再说「子会话 / 原会话未被改写」，改为「已回到该消息之前（当前对话：{id}）」+ 一行归档结果。
> - 测试：`src/client/chat/rollback-entry-view.test.ts` 新增归档四态 + 有界重试 + receiver 绑定回归（抽方法必须 bind 回服务）+ 失败码→文案键映射。

> **"Rewind" is now a seamless replace: the session list keeps only the conversation you rewound** (decided 2026-10-11):
> DSH session logs are append-only and a **live session in the host never re-reads the file** (measured: after truncating the log to a valid v4
> file, both "leave the conversation and reopen it" and a **full page reload** still showed the old content), and the platform exposes no API to
> drop or reload a live session — so "rewrite this conversation in place" has **no usable path** in a running DSH. Instead: official fork +
> auto-open the new session + **archive the original** + the title inherited through the forked log prefix, so the user sees the same conversation
> rewound rather than an extra row in the list.
> - Archiving uses the official `workspaces.archiveSession`; failures are reported honestly in three states (no archive entry in this client /
>   the original still has work in progress / other failure), each with its own copy — **never pretending it was archived**. Order is fixed:
>   navigate first, archive second (DSH refuses to archive a session still attached to the current view; one bounded retry, never a poll loop).
> - The rewind result no longer says "child session / the original was not rewritten"; it reads "Rewound to before that message (current
>   conversation: {id})" plus one archive-outcome line.
> - Tests: `src/client/chat/rollback-entry-view.test.ts` adds the four archive states, the bounded retry, a receiver-binding regression
>   (extracted methods must be bound back to the service) and the failure-code → copy-key mapping.

> **聊天内回退入口的缺省形态改为「每条用户消息一个」**（2026-10-10）：此前入口只挂在回合尾（`conversation.chat.turnTail`），回退粒度只有「整回合」。现在缺省**接管宿主 `conversation.chat.node` 的 `user` 渲染器**（`priority -1` 遮蔽 shipped 的 `UserMessageNodeView`）——
> 该 key **没有 children 表**，framework 不提供「往每条用户消息里追加 UI」的位子，要让按钮与原文同时出现**只能**接管并复刻那条气泡（宿主组件与其 CSS Modules 全是 ui-chat 私有、不可导入；图片仍走 owner 给的 `renderMessageImages`）。
> - **两档互斥（2026-10-10 修正）**：偏好为「整回合」时回合尾入口是唯一入口；偏好为「每条消息」时回合尾入口**一次都不注册**（`planChatEntryRegistrationForMode` 在 per-message 档直接 skip）—— 同屏只有一颗 icon，点开的是**同一个**复核对话框（不新造通道）。旧版「两者并存」的写法已作废：那正是用户截图里同时出现宽按钮与「⟳ 回退」文字按钮的来源。
> - **开关与生效方式**：形态偏好经 `src/client/chat/chat-entry-pref.ts` 持久化在浏览器 localStorage（键 `dcm.chat-entry-mode`，两档 `per-message`（缺省）/ `turn`；缺失 / 非法值一律回缺省，storage 不可用不抛），并经 `subscribeChatEntryMode` **热切换**（切换即退掉旧登记、按新档位重新评估；**绕过 `writeChatEntryMode` 直接改 localStorage 则下次加载才生效**）。面板入口 = 「工作区与会话回滚」卡（`RollbackCard`）上的两档开关（**T2 已交付**；写入只走 `writeChatEntryMode`，storage 写失败会回读真实值并提示「这次切换没有生效」）。**边界（如实）**：偏好按**浏览器**存、**同一页面内即时**，**跨标签页不即时**（没有 `storage` 事件监听 —— 另一页要下次加载才跟上；面板文案「切换立即生效」只承诺**当前页面**）。
> - **与宿主气泡的已确认差距（如实登记，不修；2026-10-10 复核后收敛）**：① **技能 chip 与引用 chip 的「可点开」外观未做** —— 宿主把 `referenceLabels` / `skillNames` 交给 ui-primitives 的包私有投影；**引用摘要行与正文会话线格式已复刻**（见「修复」组条目），`skillNames` 仍未接线（不渲染、也不编造文字）；② **文件类型图标仍退化为扩展名徽标**（`FileTypeIcon` 不在 ui-primitives 导出表），但**扩展名口径已对齐宿主**（dotfile 前导点算后缀 + 8 字符截断，`.gitignore` → `GITIGNOR`）；③ 时间**固定 24h 补零 `HH:mm`**（复刻宿主 `formatMessageClock` 首行），仍**不做「今天 / 昨天」**日期归属；④ 动作行**常显**（宿主 hover 才显形；回退入口需要可发现）、**无宿主同款 tooltip**（用原生 `title`）；⑤ **崩溃降级只保留正文纯文本**，rest / 未知块在该路径被丢弃（宿主无此路径）；⑥ 观感近似：气泡底色 `--cm-surface-2`（宿主 `--dsw-specific-bubble`）、圆角与字号各小一档。
> - **风险与降级**：接管渲染器意味着**我们的 bug 可能影响用户消息显示** —— 整条子树包在 `ChatEntryErrorBoundary` 里，抛错即降级为**纯文本气泡**（文本仍可见 + ASCII `console.warn` + `data-chat-entry-fallback` 标记）；即使该边界也失败，ui-renderer 的 per-entry 边界会让我们的登记 `abdicate`、退回宿主渲染器。**这条 abdicate 是一次性、不可复活**（宿主 SlotCore 用 `WeakSet` 记录已 abdicate 的条目，只有 `has` / `add`、**没有任何 revoke 路径**：`entriesOfSlot` 对该条目永久跳过，重复上报直接 `return`）⇒ **同一条消息在那次登记的生命周期内永久交回宿主渲染器**（消息仍在，fail-soft 正确）；`dispose → register` 会创建**新的**条目（不在该集合里），所以切档 / 重挂能重新接管 —— **不得**写成「刷新就能恢复」或「可以撤销」。宿主升级若改动用户消息渲染器 / 槽位契约，复刻会老旧或错位：声明形态不是 `keyed` 时**跳过注册**、回合号取不到时按钮**如实禁用**（失败软化，只丢这一个入口）。完整风险与差距登记见 `docs/spec/known-gaps.md` G-39。
> - **有意例外**：错误边界必须是 **class 组件**（React 18 只有 class 能声明 `getDerivedStateFromError` / `componentDidCatch`），是本仓「函数组件 + hooks，无 class」规范的**唯一显式例外**，已在 `DESIGN.md` §6 与 `AGENTS.md` 的开发规范行写明。
> - **护栏**：`src/client/chat/chat-entry-view.test.ts`（**31** 条：槽位常量 / pref 与热切换 / 登记三道门与失败软化 / steering 不接管 / 按钮状态机六种禁用原因 / 附件有序投影与 compact 旗标 / 体积文案 8 档 / 24h 补零时钟 / 会话线格式与引用摘要 / rest 兜底 / 错误边界降级 / zh+en 键集一致）；复核侧另有 t4 的 SlotCore 探针（10/10）与 t5 的真浏览器 DOM 端到端（32/32）。

> **The default chat rollback entry is now "one per user message"** (2026-10-10): the entry used to live only on the turn tail (`conversation.chat.turnTail`), so the only granularity was "the whole turn". The default now **takes over the host `conversation.chat.node` `user` renderer** (`priority -1`, shadowing the shipped `UserMessageNodeView`) —
> that key has **no children table**, so the framework offers no seat to append UI to a user message; the only way to keep the button next to the text is to take over the cell and replicate the bubble (the host component and its CSS Modules are private to ui-chat and cannot be imported; images still go through the owner-provided `renderMessageImages`).
> - **The two tiers are mutually exclusive (corrected 2026-10-10)**: with the "one per turn" preference the turn-tail entry is the only entry; with "per message" the turn-tail entry is **not registered at all** (`planChatEntryRegistrationForMode` skips it in per-message mode) — a single icon is on screen and both tiers open the **same** review dialog (no new channel). The old "both exist" wording is void: it is exactly what produced the wide button plus the "⟳ Rewind" text button in the user's screenshot.
> - **Switch and how it takes effect**: the mode preference is persisted by `src/client/chat/chat-entry-pref.ts` in browser localStorage (key `dcm.chat-entry-mode`, values `per-message` (default) / `turn`; a missing or invalid value falls back to the default and unavailable storage never throws) and **hot-swaps** through `subscribeChatEntryMode` (the old registration is disposed and re-evaluated immediately; **writing localStorage directly, bypassing `writeChatEntryMode`, only takes effect on the next load**). The panel entry is the two-tier switch on the "Workspace & session rollback" card (`RollbackCard`, **delivered in T2**; it writes only through `writeChatEntryMode`, and a failed storage write re-reads the real value and says "this switch did not take effect"). **Boundaries (stated honestly)**: the preference is per **browser** and takes effect **within the current page** — it is **not immediate across tabs** (no `storage` event listener, so another tab catches up on its next load; the panel copy "takes effect immediately" only promises the current page).
> - **Confirmed gaps against the host bubble (stated honestly, not fixed; converged after the 2026-10-10 review)**: ① **the clickable appearance of reference / skill chips is still missing** — the host hands `referenceLabels` / `skillNames` to a private ui-primitives projection; the **reference summary line and the in-body session wire form have since been replicated** (see the "Fixed" entry), while `skillNames` is still unwired (we neither render it nor invent text); ② the **file-type icon still degrades to an extension badge** (`FileTypeIcon` is not exported by ui-primitives), but the **extension rule now matches the host** (a leading dot counts, 8-character truncation, `.gitignore` → `GITIGNOR`); ③ the clock is now a **fixed zero-padded 24-hour `HH:mm`** (the host `formatMessageClock` first line), with **no today/yesterday** attribution; ④ the action row is **always visible** (the host reveals it on hover; the rewind entry must stay discoverable) and there is **no host-style tooltip** (native `title` instead); ⑤ the **crash fallback keeps plain body text only** — rest / unknown blocks are dropped on that path (the host has no such path); ⑥ visual approximation: bubble background `--cm-surface-2` (host: `--dsw-specific-bubble`), radius and font size each one step smaller.
> - **Risk and degradation**: taking over the renderer means **our bugs can affect how user messages are displayed** — the whole subtree is wrapped in `ChatEntryErrorBoundary`, which degrades to a **plain-text bubble** on any throw (the text stays visible, plus an ASCII `console.warn` and a `data-chat-entry-fallback` marker); even if that boundary fails, ui-renderer's per-entry boundary makes our registration **abdicate** back to the host renderer. **That abdication is one-shot and cannot be undone** (the host SlotCore records abdicated entries in a `WeakSet` with only `has` / `add` and **no revoke path at all**: `entriesOfSlot` skips the entry permanently and a repeat report returns immediately) ⇒ **that message stays with the host renderer for the rest of that registration's life** (the message is never lost — fail-soft works); `dispose → register` creates a **new** entry that is not in the set, so switching the mode or remounting can take over again — never write "a refresh restores it" or "it can be revoked". If a host upgrade changes the user-message renderer or the slot contract, the replica can go stale or misplace: a declaration that is not `keyed` **skips registration** and an unreadable turn number **disables the button honestly** (soft failure — only this one entry is lost). The full risk and gap record is `docs/spec/known-gaps.md` G-39.
> - **Deliberate exception**: the error boundary must be a **class component** (React 18 only lets classes declare `getDerivedStateFromError` / `componentDidCatch`) — the **single explicit exception** to this repo's "function components + hooks, no classes" rule, written down in `DESIGN.md` §6 and on the development-rules line of `AGENTS.md`.
> - **Guards**: `src/client/chat/chat-entry-view.test.ts` (**31** cases: slot constants / preference and hot swap / the three registration gates and soft failure / steering is not taken over / the button state machine with six provable disabled reasons / ordered attachments and the compact flag / eight size-text tiers / the 24-hour zero-padded clock / session wire form and reference summary / rest fallback / error-boundary degradation / identical zh+en key sets); on the review side there are also t4's SlotCore probe (10/10) and t5's real-browser DOM end-to-end run (32/32).

> **两档互斥不再被「切档」打破；入口不再依赖槽位声明顺序**（2026-10-10 t13 / t17）：
> - **症状（真机复核）**：T2 的互斥只在**装配期**成立 —— `chat.node` 侧订阅偏好、`turnTail` 侧是**一次性**注册。于是「每条消息」起点切「整回合」→ 活 cell = **0**（入口消失，要刷新才回来）；「整回合」起点切回「每条消息」→ 活 cell = **2**（同屏两个回退按钮）。
> - **修法（t13）**：新增 `src/client/chat/chat-entry-mount.ts` 的 `mountChatEntries()` —— **同一次偏好订阅**驱动两个入口：每次变化先 `disposeAll()` 再按当前档注册**恰好一个**（`per-message` ⇒ `chat.node`；否则 ⇒ `turnTail`）。恒成立：任意时刻至多一个入口活着，切档过程中**不会出现 0**（dispose 与 register 在同一个同步回调里完成），切档后的状态与「以该档冷启动（刷新）」逐字一致。切档 trace 恒 **`[1,1,1,1]`**、事件级峰值 **1**；装配点 `src/client/index.ts` 改为引用计数持有**同一个**挂载。
> - **顺序硬化（t17）**：装配点只在第一次 hold 创建挂载，后到的槽位声明只把计数 +1 ⇒ 若「当前档要用的槽位」声明**晚于**挂载创建（先 turnTail 后 chat.node，而偏好是 per-message），该档会停在 0 入口。现在 `mountChatEntries` 自带**有界补试**（每次 apply 后若当前档声明还不可用，按注入排程器再试，最多 `maxRetries=4`，声明一到位**立即停** ⇒ 正常路径零补试、零 churn）+ 暴露**幂等 `reapply()`** 钩子（已与当前档一致则什么都不做）。**如实说明：顺序无关是异步达成的** —— 声明到位 + **一个排程 tick** 后恰好 1 入口；**同步瞬间仍可为 0，这是设计而非缺陷**。`src/client/index.ts` **未改**（避免第二套机制）。
> - **护栏**：`src/client/chat/chat-entry-mount.test.ts`（装配期各一处 / trace `[1,1,1,1]` / 事件级 `peak===1` / 顺序固定 dispose→register / 卸载不复活 / 订阅恰好 1 次 / 切档与冷启动逐字一致 / 声明顺序矩阵四格恰好 1 / 有界补试次数 / 幂等 reapply 不 churn）；chat-dev 自建模拟 `.tmp/t13/switch-sim.ts`（trace `[1,1,1,1]`）；评审旧 sim（旧接线）留作对照，其探针 I 的「后到声明不重评估、活 cell 仍 0」描述的是**修复前行为**。

> **Mutual exclusion can no longer be broken by switching modes, and the entry no longer depends on slot declaration order** (2026-10-10, t13 / t17):
> - **Symptom (real-machine review)**: T2's mutual exclusion only held **at assembly time** — `chat.node` subscribed to the preference while `turnTail` registered **once**. So switching from "per message" to "per turn" left live cells = **0** (the entry disappeared until a refresh), and switching back left live cells = **2** (two rollback buttons on screen).
> - **Fix (t13)**: a new `mountChatEntries()` in `src/client/chat/chat-entry-mount.ts` drives both entries from **one preference subscription**: on every change it calls `disposeAll()` and then registers **exactly one** entry for the current tier (`per-message` ⇒ `chat.node`; otherwise ⇒ `turnTail`). Invariants: at most one entry is ever live, **0 never appears** during a switch (dispose and register happen in the same synchronous callback), and the post-switch state is exactly the same as a cold start in that tier. The switch trace is always **`[1,1,1,1]`** with an event-level peak of **1**; `src/client/index.ts` now holds **one** reference-counted mount.
> - **Order hardening (t17)**: the assembly point only creates the mount on the first hold, and a later slot declaration merely bumps the count ⇒ if the slot the current tier needs is declared **after** the mount is created (turnTail first, then chat.node, while the preference is per-message), that tier sits at 0 entries. `mountChatEntries` now performs **bounded retries** (after each apply, if the current tier's declaration is still unusable it retries through the injected scheduler, at most `maxRetries=4`, stopping the moment the declaration arrives ⇒ the normal path has zero retries and zero churn) and exposes an **idempotent `reapply()`** hook (a no-op when already on the current tier). **Stated honestly: order independence is achieved asynchronously** — the declaration arriving plus **one scheduler tick** yields exactly 1 entry; **for a synchronous instant it can still be 0, which is by design, not a defect**. `src/client/index.ts` was **not** changed (to avoid a second mechanism).
> - **Guards**: `src/client/chat/chat-entry-mount.test.ts` (one registration per tier at assembly / trace `[1,1,1,1]` / event-level `peak===1` / fixed dispose→register order / no resurrection after unmount / exactly one subscription / post-switch identical to cold start / the four-cell declaration-order matrix at exactly 1 / bounded retry count / idempotent reapply without churn); chat-dev's own simulation `.tmp/t13/switch-sim.ts` (trace `[1,1,1,1]`); the review's old sim (old wiring) is kept as a control — its probe I ("a late declaration does not re-evaluate, live cell stays 0") describes the **pre-fix** behaviour.

> **聊天回退入口收敛成 icon，预览弹窗改成简洁版（2026-10-10 用户第二条、第三条反馈）**：
> - **入口只留一个 icon**：两个入口（每条用户消息 / 回合尾）都改成**只有图标** —— 复用 `common/Icon.tsx` 的 `RefreshIcon` 与既有的 `.chatActionBtn` 24px 无边框图标位，与时间戳、复制图标同一行；**可见文字标签全部退到 `aria-label` / `title`**（按钮仍有名字，无障碍与悬浮提示都读得到）。回合尾入口在「每条消息」档**一次都不注册**（见上一条的互斥修正）⇒ 同屏只有一颗 icon。
> - **预览弹窗简洁版**：标题固定「回退预览」（`rollback.preview.title`；设置页回滚卡的预览弹窗用的是同一句）；正文**只有会被回退的文件**（`preview.workspace.files`：路径 + 「+N 行」/「−M 行」；只列会被改动的文件，内容已一致的一项都不列 ⇒ 空数组显示「工作区与该回退点一致，无需恢复」）；行数算不出来时显示「行数未统计」而**不是 0**；底部只有主按钮「回退」与「取消」。
> - **有意替换（如实理解，不是功能退化）**：上一版聊天弹窗里的**三选一 mode 单选**、**二次确认勾选**、**两态不全放行勾选（`allowPartial`）**、工作区/会话计数面板、救援点说明段、逐段结果详情面板、留点期 notice 面板**全部删除**。聊天入口的范围固定为 `files+session`（=「回到这条消息之前」）、救援点策略恒 `require`；**「点『回退』即视为 `userConfirmed=true`」** —— 对话框本身就是「预览 + 确认」两步。fail-closed **一个字没动**：`defaultDraft` 恒 `confirmed:false`，唯一置位入口是提交那一刻的 `confirmOnSubmit()`，`buildRewindOptions` 仍要求**恰好 true**，引擎侧确认门同规。**设置页的回滚卡（`RollbackCard`）仍保留完整能力**（三选一 / 部分放行 / 二次确认 / 逐段结果），本条只改聊天入口的对话框。
> - 保留的两处诚实性（与「简洁」的边界）：不可回退时仍留**一行原因文案**（按钮禁用必须说得出为什么）；点级 `warnings` 非空才渲染一行 warn（引擎正常结果恒为空，不占版面）。
> - **护栏**：`src/client/chat/chat-entry-view.test.ts` + `rollback-entry-view.test.ts`（**77** 条，含 icon-only 的源码级断言与 `readRollbackPreviewFiles` 的降级读法）、`src/ui/rollback-view.test.ts`（**17** 条，含类型与引擎逐字同形）、`tests/route/recovery-rollback.test.ts` R8-7、i18n 守卫 17 条、bundle 自包含 1 条；客户端产物 `lib/client.js` 断言剥注释后**无 `require("node:…")`**、含两个槽位登记与 `.chatActionBtn`。

> **The chat rollback entry is now icon-only and the preview dialog is the simple version** (the user's 2nd and 3rd points, 2026-10-10):
> - **One icon only**: both entries (per user message / turn tail) render **an icon alone** — the existing `RefreshIcon` from `common/Icon.tsx` inside the existing 24px borderless `.chatActionBtn` slot shared with the clock and copy icons; every visible label moved into `aria-label` / `title` (the button still has a name for screen readers and hover). In "per message" mode the turn-tail entry is **not registered at all** (see the mutual-exclusion correction above), so a single icon is on screen.
> - **Simple preview dialog**: fixed title "Rewind preview" (`rollback.preview.title`; the settings card's preview dialog uses the same sentence); the body lists **only the files that will be rewound** (`preview.workspace.files`: path plus `+N lines` / `−M lines`; files whose content already matches are not listed, so an empty array shows "the workspace already matches this rollback point, nothing to restore"); when the counts cannot be computed the UI says "line counts not measured" rather than a fabricated `0`; the footer holds only the primary "Rewind" and "Cancel" buttons.
> - **Deliberate replacement (not a regression)**: the previous chat dialog's **three-way mode radio**, **confirmation tick**, **"allow partial" tick (`allowPartial`)**, workspace/session counter panel, rescue-point note, per-segment result panel and capture-time notice panel are all removed. In the chat entry the scope is fixed to `files+session` ("go back to before this message") and the rescue-point policy is always `require`; **clicking "Rewind" is the confirmation** — the dialog itself is the preview + confirm two-step. The fail-closed gate is untouched: `defaultDraft` is always `confirmed:false`, the only place it is set is `confirmOnSubmit()` at submit time, `buildRewindOptions` still requires **exactly** `true`, and the engine-side gate is unchanged. The settings-page `RollbackCard` **keeps the full capability** (three-way scope, allow-partial, confirmation tick, per-segment results); only the chat dialog changed.
> - Two honesty boundaries are kept: when a rewind is not possible a **single reason line** remains (a disabled button must be able to say why), and point-level `warnings` render one warn line only when non-empty (a normal result is always empty, so it costs no space).
> - **Guards**: `chat-entry-view.test.ts` + `rollback-entry-view.test.ts` (**77** cases, including the source-level icon-only assertion and the degrading read of `readRollbackPreviewFiles`), `src/ui/rollback-view.test.ts` (**17** cases, including type/engine field-for-field parity), `tests/route/recovery-rollback.test.ts` R8-7, the 17-case i18n guard and the bundle self-containment case; the built `lib/client.js` is asserted to contain **no `require("node:…")`** after comment stripping while carrying both slot registrations and `.chatActionBtn`.

> **恢复「预览 = 执行」不再漂移**（第二轮审查）：预览后磁盘若发生变化，执行时同一份快照可能多出
> `hostFileRemove` / `fileRemove` 这类**破坏性**动作，而用户确认的是另一套动作 —— 此前无人提示。现在
> 预览回传**计划指纹**（动作 kind + target + blobPath 的 sha256），执行时带回来校验：不一致即
> **409 `plan-changed`**，界面提示「环境在预览后发生了变化，请重新预览」。旧客户端不带指纹 → 行为一字不变。
> - **护栏**：`tests/route/` 既有恢复路由用例全绿（指纹只取三列，内容变化不改变指纹）。
>
> **Restore preview and execution can no longer drift apart**: if the disk changed after the preview, executing the same
> snapshot could add destructive actions (`hostFileRemove` / `fileRemove`) that the user never confirmed. The preview now
> returns a **plan fingerprint** (sha256 over action kind + target + blobPath) and execution verifies it: a mismatch returns
> **409 `plan-changed`** and the UI asks the user to preview again. Old clients that send no fingerprint behave exactly as before.
>
> **一键同步的「回滚」不再把部分回滚说成整体成功**（第二轮审查）：凭据 `existed=true` 时永远回滚不了
> （只产出 reason + manualHint），而 `/sync/rollback` 此前只回 `{ok, full}`，`failed` / `manualHint` 全丢，
> 界面无条件弹「已回滚到应用前」。现在响应带 `failed[]`（含 manualHint），界面在 `full=false` 时改出**未回滚项**
> 与人工提示（不再弹成功、不再收尾）；同步引擎内部的二次回滚同样接收报告、失败项并入 warnings，并新增
> `rollbackFull`（`rolledBack` 旧语义保持不变），「回滚未完成」在面板里单独成态。
> - **护栏**：`tests/route/sync-rollback-route.test.ts`（full=false 必须回传未回滚项 / 干净回滚 full=true 不失真）、
>   `src/sync/sync-engine.test.ts`（两条半回滚用例）、`src/client/sync/sync-view-v2.test.ts`（rollbackIncomplete 分支）。
>
> **One-click sync rollback no longer reports a partial rollback as full success**: credentials with `existed=true` can never
> be rolled back (they only produce a reason + manualHint), yet `/sync/rollback` returned only `{ok, full}` and the UI always
> toasted "rolled back". The response now carries `failed[]` (with manualHint), the UI lists the items that were **not** rolled
> back instead of claiming success, and the engine's internal second rollback reports its failures into `warnings` with a new
> `rollbackFull` flag (`rolledBack` keeps its old meaning).
>
> **「存在但读不出来」的宿主文件不再被记成「当时不存在」（数据安全）**：导入前快照登记
> settings.yaml / cordis.patch.yml / `profiles/<p>/*` 时，只要文件当下读不出来（Windows 上被别的进程占用、
> 权限、IO 错），此前会落 `existed:false`。恢复侧据此判定「快照里没有、现在有 → 删掉」，
> 于是一次回滚**会把用户真实的 settings.yaml 删除**，还会在报告里算作 restored。现在读不出来一律登记
> `existed:true` + `unreadable:true`（无 blob）；恢复计划对这类条目**只跳过并如实说明**
> 「拍快照时存在但读不出来（占用/权限），本次不动它」，**绝不进入删除分支**；连「存在性探测本身失败」
> 也按「存在但不可读」处理（读不到 ≠ 没有）。
> - **护栏**：`src/core/backup.test.ts`（存在但读不出来 → existed/unreadable/blobPath 三个字段 + durable+verified 不破）；
>   `tests/core/restore.test.ts` 的 `R-host-unreadable`（目标机上文件真实存在 → 计划里零 `hostFileRemove`，说明含「读不出来」）。
>
> **Host files that existed but could not be read are no longer recorded as "did not exist" (data safety)**:
> when the pre-import snapshot registered settings.yaml / cordis.patch.yml / `profiles/<p>/*` and the file could not be
> read at that moment (in use on Windows, permissions, IO error), it used to be written as `existed:false`. Restore reads
> that as "absent in the snapshot, present now → delete", so one rollback **deleted the user's real settings.yaml** and
> counted it as restored. Such files are now recorded as `existed:true` + `unreadable:true` (no blob) and the restore plan
> **only skips them with an honest explanation** — it never enters the delete branch. A failed existence probe is treated
> the same way (cannot read ≠ absent).
> - **Guards**: `src/core/backup.test.ts`; `R-host-unreadable` in `tests/core/restore.test.ts`.

> **回退三处真机缺陷**（用户 2026-10-11 截图反馈）：「回退」主按钮变成裸文字（黑字、无边框）、回退后的会话落到「未分组」、回退后的对话变成「排队发送」里的一条消息。
> - **主按钮丢样式**：设计 token（`--cm-*`）此前只定义在 `.section` 上，而聊天的回退弹窗经 `Dialog.Portal` 渲染进 `body`
>   —— 自定义属性继承不到那里，主按钮的 `background: var(--cm-accent-fill)` 解析失败 → 无底色、无边框、字色继承。
>   token 整体提到 `:root`（settings 区与聊天槽位共用同一份值；`css-token-guard`/`css-scale-guard` 两条守卫照旧通过）。
> - **落到「未分组」**：为指定边界我们走的是底层 `SessionStore.fork`，而 DSH 自己的 `SessionCommandController.fork`
>   在 fork 之后还有一步 `workspace.attachSession(childId)`。补上这一步：只认 `sessionIds` 含原会话的那个工作区，
>   拿不到/写失败一律结构化 `warning: workspace-attach-failed`（回退本身仍成功，**绝不假装已归位**，宿主日志留痕）。
> - **变成「排队发送」一条消息**：上一回合还在跑时用户排队发的那条，会先落成 `user/message(surfaceOp='append')` /
>   `agent/inbox/spliced`，**再**出现下一个 `turn/start`。边界取 `startSeq-1` 就把这段**尚未被消费的输入**切进了子会话。
>   现在「未收尾回合期间出现的待消费输入」会把边界压到它之前（与 DSH 自己的 `latestCompletedPrefixBoundary` 同口径）。
> - 测试：`src/core/rollback-point.test.ts` 的 R-02b（边界 = 上一回合的 turn/end）、`src/index.facade.test.ts` 两条（挂回工作区 / 挂不上只降级成 warning）。

> **Three real-machine rewind defects** (reported 2026-10-11 with screenshots): the primary "Rewind" button rendered as bare text
> (black, borderless), the rewound session fell into "Ungrouped", and the rewound conversation turned into an entry in the
> "queued to send" strip.
> - **Unstyled primary button**: design tokens (`--cm-*`) were declared only on `.section`, but the chat rewind dialog renders
>   through `Dialog.Portal` into `body`, where custom properties do not inherit — `background: var(--cm-accent-fill)` failed to
>   resolve (no fill, no border, inherited text colour). Tokens now live on `:root`, shared by the settings surface and the chat slot.
> - **"Ungrouped"**: we fork through the low-level `SessionStore.fork` to pin an exact boundary, while DSH's own
>   `SessionCommandController.fork` performs one more step, `workspace.attachSession(childId)`. That step is now replicated:
>   only the workspace whose `sessionIds` contain the original session is used, and any failure degrades to a structured
>   `warning: workspace-attach-failed` (the rewind itself still succeeds — never pretending the session was re-filed).
> - **"Queued to send"**: a message the user queued while the previous turn was still running is logged first as
>   `user/message(surfaceOp='append')` / `agent/inbox/spliced` and only then does the next `turn/start` appear; a
>   `startSeq-1` boundary therefore cut that **unconsumed input** into the child session. Pending input seen outside any open
>   turn now pushes the boundary before it, matching DSH's own `latestCompletedPrefixBoundary`.
> - Tests: R-02b in `src/core/rollback-point.test.ts` and two cases in `src/index.facade.test.ts`.

> **保留清理遇「引用集合读不出来」不再按空集合继续删**：prune 的 recovery 豁免此前是
> `.catch(() => new Set())` —— journal 扫描一次瞬时失败（EACCES / IO 错）就会被当成「无人引用」，
> 可能删掉 SAFE MODE 恢复唯一的回滚点。现在**读不到就放弃本轮清理**（宁可少删），并新增
> `FileSnapshotStoreOptions.onWarn`（宿主接 `host.log.warn`），让「这轮为什么没清理 / 清理为什么失败」
> 第一次可查（此前是纯静默）。
> - **护栏**：`src/core/backup.test.ts`（引用扫描抛错 → 两个快照都留着 + 有告警）。
>
> **Snapshot pruning no longer proceeds on an unreadable reference set**: the recovery exemption used to be
> `.catch(() => new Set())`, so one transient journal-scan failure (EACCES / IO) was read as "nothing is referenced" and
> could delete the rollback point that SAFE MODE recovery depends on. Pruning now **gives up this round** (rather than
> deleting), and a new `FileSnapshotStoreOptions.onWarn` hook (wired to `host.log.warn`) makes "why was nothing pruned /
> why did pruning fail" visible for the first time.
> - **Guards**: `src/core/backup.test.ts`.

> **「检查点」→「工作区 + 会话回滚」的命名与数据口径整体改名（S7）**：引擎 `src/core/checkpoint.ts` → `src/core/rollback-point.ts`、判定层 `src/ui/checkpoint-view.ts` → `src/ui/rollback-view.ts`、
> 卡片 `CheckpointCard.tsx` → `RollbackCard.tsx`、路由族 `/recovery/checkpoints/*` → `/recovery/rollback-points/*`、i18n 键 `checkpoint.*` → `rollback.*`（含 ⌘K 命令 id `checkpoint.open` → `rollback.open`）。
> **旧数据既不读取也不删除**：`<dataDir>/checkpoints/` 目录不再被读取（升级后旧点不可见），本插件也不会去删它 —— 要保留历史请自行备份该目录。

> **Renamed end to end from "checkpoints" to "workspace + session rollback" (S7)**: engine `src/core/checkpoint.ts` → `src/core/rollback-point.ts`, decision layer `src/ui/checkpoint-view.ts` → `src/ui/rollback-view.ts`,
> card `CheckpointCard.tsx` → `RollbackCard.tsx`, route family `/recovery/checkpoints/*` → `/recovery/rollback-points/*`, i18n keys `checkpoint.*` → `rollback.*` (including the ⌘K command id `checkpoint.open` → `rollback.open`).
> **Old data is neither read nor deleted**: `<dataDir>/checkpoints/` is no longer read (old points are invisible after upgrading) and this plugin never removes it — back up that directory yourself if you want the history.

### 🐛 修复 · Fixed

> **回退成功却打不开子会话的真根因：抽方法时丢了 receiver（2026-10-11 真机实测，0.2.0-rc.2 web 实例）**：
> - **症状**：点「↺ 回退」→ 预览 → 点「回退」，回退**本身成功**（徽章「全部恢复」、「恢复 1 项 / 失败 0 项 / 未删除的记录内容 0 项」、子会话已创建），但弹窗立刻挂一条黄字「会话导航调用失败，子会话 session-N 没有自动打开（子会话已创建）：请手动打开它」——用户被留在原会话，得自己去历史里找那个子会话，观感就是「回退不生效」。
> - **根因（receiver 丢失）**：`navigationSourcesOf()` 把宿主服务上的方法抄进**新字面量对象**（`{ openSession }` / `{ open, refresh, list }`），随后 `buildSessionNavigator` 用 `.call(那个字面量, id)` 调用。而 `uiWorkspace.openSession` 的实现是 `this.replaceMain(target, this.lifetime.signal, 'reveal')` —— receiver 一换，`this.lifetime` 就是 `undefined`，抛 `TypeError: Cannot read properties of undefined (reading 'signal')`；`sessions.refresh()` 同理（实现体读 `this.manager.refreshList()`），且它被 `catch` 吞成「刷新无效」。诊断证据（临时探针把现场渲染进弹窗，已回退）：`entry=uiWorkspace list=77 hasChild=true openThrow=TypeError: … reading 'sign…'` —— 列表里**已经有**这个子会话、入口也是对的，**只有 receiver 是错的**。
> - **改法（最小面）**：`asWorkspaceSource` / `asSessionListSource` 抽出来的方法一律 `.bind(record)` 绑回宿主服务对象（`openSession` / `open` / `refresh` 三处）。三档降级判据（列表是否已有该 id → 是否 refresh → `degraded`/`failed`/`unavailable` 文案）**逐字未动**。
> - **真机复验（同一实例、修复前后各一次）**：修复前 = `chat.open.failed` 黄字 + 停在本会话；修复后同一条路径点下去，界面**直接切到子会话视图**（标题栏切换、显示新会话的「预览版说明」），无任何降级提示。
> - **护栏**：`src/client/chat/rollback-entry-view.test.ts` 新增 2 条真机形状用例（`uiWorkspace.openSession` 依赖 `this` 的服务对象 / `sessions.refresh` 依赖 `this`）；变异校验：只回退 `.bind(record)` 这一处，前者立刻红（`66 pass / 1 fail`），加回即 67/67 绿。

> **The real reason a successful rewind could not open its child session: the extracted method lost its receiver** (2026-10-11, measured on a live 0.2.0-rc.2 web instance):
> - **Symptom**: after 「↺ 回退」 → preview → 「回退」, the rewind itself **succeeds** (badge 「全部恢复」, `1 restored / 0 failed`, the child session is created), yet the dialog immediately shows a warning — "the session navigation call failed, child session session-N was not opened automatically: open it manually". The user stays in the parent session and has to hunt for the child in history, which reads as "rewind did not work".
> - **Root cause (lost receiver)**: `navigationSourcesOf()` copies host-service methods into a **fresh object literal** (`{ openSession }` / `{ open, refresh, list }`) and `buildSessionNavigator` then calls them via `.call(that literal, id)`. `uiWorkspace.openSession` is implemented as `this.replaceMain(target, this.lifetime.signal, 'reveal')`, so with a swapped receiver `this.lifetime` is `undefined` and it throws `TypeError: Cannot read properties of undefined (reading 'signal')`; `sessions.refresh()` has the same shape (it reads `this.manager.refreshList()`) and was swallowed by a `catch` as "refresh did nothing". Diagnostic evidence (temporary on-screen probe, since removed): `entry=uiWorkspace list=77 hasChild=true openThrow=TypeError: … reading 'sign…'` — the child **was** already in the list and the entry **was** correct; only the receiver was wrong.
> - **Fix (minimal)**: every method extracted by `asWorkspaceSource` / `asSessionListSource` is now `.bind(record)`-ed back to its owning service object (`openSession` / `open` / `refresh`). The three honest degradation judgments (is the id listed → refresh once → `degraded`/`failed`/`unavailable` copy) are untouched.
> - **Re-verified live (same instance, before and after)**: before the fix the dialog showed the `chat.open.failed` warning and stayed in the current session; after the fix the same path navigates **straight into the child session view** (header switches, the new-session notice appears) with no degradation hint.
> - **Guards**: two new real-shape cases in `src/client/chat/rollback-entry-view.test.ts` (`uiWorkspace.openSession` needing `this` / `sessions.refresh` needing `this`); mutation check: reverting only the `.bind(record)` change turns the first one red (`66 pass / 1 fail`) and restoring it is 67/67 green.

> **回退预览弹窗的主按钮不再永久灰掉：enablement（能不能提交）与确认（是否已确认）拆成两个判据**（2026-10-11 用户截图反馈）：
> - **症状（用户截图）**：聊天里的「↺ 回退」点开后，预览弹窗**打开正常、文案正常**（「工作区与该回退点一致（会话仍会回退到该点之前）」），但主按钮「回退」是**灰色、永久不可点** ⇒ 整条回退路径**完全不可用**（弹窗开得了，就是退不了）。
> - **根因（循环依赖）**：按钮可用性写的是 `const submitEnabled = canSubmitRewind(draft, preview) && !busy`，而 `canSubmitRewind` 要求 `draft.confirmed === true`；`confirmed` 的**唯一置位入口**是 `confirmOnSubmit()`，它只在 `submit()` 里被调用 —— 而 `submit()` **只能由这个按钮触发**。于是「按钮因未确认而禁用、确认又只能靠点这个按钮」⇒ 死锁。测试没抓到它，是因为断言用的是**已确认**夹具（`confirmedDraft()`），而真实初始态是**未确认**（`defaultDraft(pre)` 恒 `confirmed:false`）。
> - **改法（两个判据分开）**：新增 `rewindSubmittable(draft, preview)` 作为**可点性（enablement）判据** —— 只回答「这次提交本身是否成立」= 固定段集合非空 + 宿主允许回退（`rollbackPreviewVerdict().canRestore`），**绝不看 `confirmed`**；对话框改为 `const submitEnabled = submitButtonEnabled({ draft, preview, pointId, busy })`（t6 复核后把「已有可写目标 `pointId`」与忙态并入 enablement，判据维度与 `submit()` 的执行体同宽）。`canSubmitRewind` 收敛为「enablement + **恰好** `confirmed === true`」，两条判据共用同一个私有 `rewindViable`（单一真相，不会漂移）。**确认门一字未松**：`defaultDraft` 仍恒 `false`、唯一置位入口仍是点击那一刻的 `confirmOnSubmit()`、`buildRewindOptions` 仍要求**恰好 true**（未确认连请求体都不成形、端口零调用），宿主侧 fail-closed 门（`userConfirmed` 必须恰好 `true`，否则 409 `confirmation-required`）与路由的归一化**逐字未动**（本轮改动面只有 3 个 `src/client/chat/*` 文件）。
> - **不放宽**：`canRestore === false` 的点（受保护 / 两态不全 / 两段都不可回退 / 宿主拒绝 / `preview=null`）enablement **仍为 false**，按钮照旧禁用并给出原因；预览四态文案、窗口内「正在读取回滚点…」与窗口后「这个回合还没有回滚点」两态、退避表与 30 秒窗口**均未回归**。
> - **护栏**：`src/client/chat/rollback-entry-view.test.ts` 新增 5 条 R1 用例（真实初始态 `defaultDraft(preview)` 可点 + `confirmed` 取任意值都不影响可点性 / 源级断言 `submitEnabled` 走含 `pointId` 的 `submitButtonEnabled` 且不得读 `draft.confirmed` / 确认门未松（未确认 blocked + 端口零调用 + 点一次后 `userConfirmed===true`）/ `canRestore=false` 仍禁用 / 用户截图那一屏可点且点下去真 fork）；t6 复核后追加 R2 用例（F1 夹具纪律 / F2 源码级绑定守卫含反向自检（M1–M4 注入必须打红）/ F3 `pointId` 维度 / F4 同步 single-flight 幂等锁）；qa 独立验证 `.tmp/v1-verify/verify-v1.mjs` **100 PASS / 0 FAIL** —— 用 `git archive HEAD` 取**修复前的真代码**与工作树并列求值：修复前 `canSubmitRewind(draft, preview) && !busy` 在真实初始态 = `false`（复现灰按钮），修复后 `submitButtonEnabled({ draft, preview, pointId, busy })` = `true`（可点）；差分对比（13 个预览形状 × 8 个结果形状 × 16 组按钮状态）**0 处行为差异**；端到端（同形 seam 替身复刻 `submit()` 调用序列）200 + `childSessionId` + 真导航一次 + 一行摘要，`nothing-to-restore` 按 200 成功呈现。门禁全绿：`typecheck` / `typecheck:tests` / `npm test`（t5 实测 **4284 条 / 4282 pass / 0 fail**；t10 后最终树数字以 t8 复验为准，2 skip = 本机无 `~/.copilot` / `~/.cursor` 的真机取样）/ `smoke` / `build` + bundle 自包含 / i18n 守卫 17 条 / `check-agents-budget`。
> - **NOT VERIFIED（如实）**：没有真机浏览器 / DOM 层的 `disabled` 取证（本仓 React 无组件测试框架，且 client bundle 依赖 DSH 运行时、不能脱离实例挂载）—— 证据止于「源码里那行表达式在真实初始态求值」+「产物 `lib/client.js` 逐字含该绑定行 `const submitEnabled = submitButtonEnabled({ draft, preview, pointId, busy })`」+「`disabled={!submitEnabled}` 全文件唯一绑定」；真机点击端到端（真 200 / 真 fork）同样未做，用的是与生产同形的 seam 替身。

> **The rewind preview dialog primary button is no longer permanently greyed out: "can this be submitted" (enablement) and "has it been confirmed" are now two separate predicates** (2026-10-11, user screenshot):
> - **Symptom (user screenshot)**: after clicking the chat "↺ Rewind" icon the preview dialog **opens fine with correct copy** ("the workspace already matches this rollback point (the session will still be rewound to before this point)"), yet the primary "Rewind" button is **grey and permanently unclickable** ⇒ the whole rewind path is **unusable** (the dialog opens, but nothing can be rewound).
> - **Root cause (circular dependency)**: enablement was `const submitEnabled = canSubmitRewind(draft, preview) && !busy`, and `canSubmitRewind` requires `draft.confirmed === true`; `confirmed` has exactly one setter, `confirmOnSubmit()`, called only inside `submit()` — and `submit()` **can only be triggered by that very button**. So "the button is disabled because it is unconfirmed, while confirming requires clicking this button" ⇒ deadlock. Tests missed it because the assertion used an **already-confirmed** fixture (`confirmedDraft()`) while the real initial state is **unconfirmed** (`defaultDraft(pre)` is always `confirmed:false`).
> - **Fix (two separate predicates)**: a new `rewindSubmittable(draft, preview)` is the **enablement predicate** — it only answers "is this submission itself valid" = a non-empty fixed segment set plus host permission to rewind (`rollbackPreviewVerdict().canRestore`), and **never looks at `confirmed`**; the dialog now uses `const submitEnabled = submitButtonEnabled({ draft, preview, pointId, busy })` (after the t6 review the enablement also covers the writable target `pointId` and the busy state, so its dimensions match the `submit()` body). `canSubmitRewind` collapses to "enablement + **exactly** `confirmed === true`", and both share one private `rewindViable` (single source of truth, no drift). **The confirmation gate is untouched**: `defaultDraft` is still always `false`, the only setter is still `confirmOnSubmit()` at click time, `buildRewindOptions` still requires **exactly** `true` (an unconfirmed request never even takes shape and the port is never called), and the host-side fail-closed gate (`userConfirmed` must be exactly `true`, otherwise 409 `confirmation-required`) plus the route normalization are **byte-for-byte unchanged** (this round touches only 3 `src/client/chat/*` files).
> - **Nothing was loosened**: points with `canRestore === false` (protected / incomplete / neither segment restorable / host refused / `preview=null`) still yield enablement `false` — the button stays disabled with a reason; the four preview-state sentences, the in-window "reading the rollback points…" versus post-window "this turn has no rollback point yet" states, the backoff table and the 30-second window are all **unregressed**.
> - **Guards**: `src/client/chat/rollback-entry-view.test.ts` gains 5 R1 cases (the real initial state `defaultDraft(preview)` is clickable and any `confirmed` value leaves enablement unchanged / a source-level assertion that `submitEnabled` goes through `submitButtonEnabled` (with `pointId`) and never reads `draft.confirmed` / the confirmation gate is intact (unconfirmed ⇒ blocked with zero port calls; one click ⇒ `userConfirmed===true`) / `canRestore=false` still disabled / the exact screen from the user screenshot is clickable and really forks), plus R2 cases added by the t6 review (F1 fixture discipline / F2 the source-level button-binding guard with reverse self-checks / F3 the `pointId` dimension / F4 the synchronous single-flight lock). Independent verification by QA, `.tmp/v1-verify/verify-v1.mjs`, reports **100 PASS / 0 FAIL**: it evaluates the **pre-fix code from `git archive HEAD`** side by side with the working tree — before the fix `canSubmitRewind(draft, preview) && !busy` is `false` in the real initial state (reproducing the grey button) and afterwards `submitButtonEnabled({ draft, preview, pointId, busy })` is `true`; a differential run (13 preview shapes × 8 result shapes × 16 button states) shows **zero behavioural differences**; the end-to-end trace (a production-shaped seam double replaying the `submit()` sequence) returns 200 + `childSessionId` + one real navigation + a one-line summary, with `nothing-to-restore` presented as a 200 success. All gates green: `typecheck` / `typecheck:tests` / `npm test` (**4284 tests / 4282 pass / 0 fail** measured in t5 (the final-tree count is re-measured in t8), 2 skips = the real-machine samples for `~/.copilot` / `~/.cursor`, absent here) / `smoke` / `build` + bundle self-containment / the 17-case i18n guard / `check-agents-budget`.
> - **NOT VERIFIED (stated honestly)**: there is no real-browser / DOM evidence for `disabled` (this repo has no React component test framework, and the client bundle depends on the DSH runtime so it cannot be mounted standalone) — the evidence stops at "the shipped expression evaluated in the real initial state", "the built `lib/client.js` contains that line verbatim" and "`disabled={!submitEnabled}` is the only such binding in the file"; the real-machine click-through (real 200 / real fork) is likewise not done — a production-shaped seam double was used instead.

> **回退按钮不再因「捕获晚于查询」被永久禁用：回合收尾后**有界重试**，窗口内如实说「正在读取回滚点…」**（2026-10-10 真机）：
> - **症状与根因**：回合收尾后按钮一直是**禁用**态、提示「这个回合还没有回滚点」，可那个点其实已经创建。引擎在**回合收尾之后**才写完这个回合的点（真机实测 **7.8 秒**：该回合日志 `turn/end` = 20:03:38.658Z，而台账里那个点的 `createdAt` = 20:03:46.434Z；该点记录 **355 个文件**），而客户端只在挂载后**查一次**：一旦读到空列表就**永不重查**（**从不重试**），且空结果还会被 **30 秒**的列表缓存锁住 ⇒ 用户点不开对话框（对话框本可自己重查）。
> - **改法（收尾后**有界重试**）**：窗口 **30 秒**，退避 **0.5 / 1.5 / 3 / 6 / 12 秒**（累计 23 秒 < 窗口），最多 **6 次列表读取**（1 次首读 + 5 次重试）；**命中即停**（命中后一个请求都不再发）；**每个挂载只跑一轮窗口**（重新进入视图会再开一轮）—— **不是无限轮询**。重试轮绕过那 30 秒缓存去宿主再读一遍（新结果照常写回），**空结果不再被当成长期真值**。
> - **状态诚实**：窗口内按钮禁用但说的是「**正在读取回滚点…**」，只有**窗口关掉且仍为空**才说「这个回合还没有回滚点」。两条都进字典（zh/en），不裸渲染键名。
> - **护栏**：`src/client/chat/chat-entry-view.test.ts`（退避表与窗口常量、空会话恰好 6 次读取、命中即停、真机 7.8 s 时序、`force` 绕过缓存且不破在途去重、组件接线）；qa 独立复核 26 条断言（虚拟时钟复现「首查空 → 1–8 s 后点出现」：修复前 1 次读取 ⇒ 永久 `noPoint`/禁用，修复后 5 次读取 ⇒ 可点）+ 全量 `npm test` **4262 条 / 4260 pass / 0 fail**（2 skip = 真机取样）+ `typecheck` / `typecheck:tests` / `build` + bundle 自包含 / i18n 守卫 17 条 / `check-agents-budget` 全绿。

> **The rewind button is no longer permanently disabled by "capture later than the query": after a turn closes the client retries within a bounded window, and says "reading the rollback point…" while it does** (2026-10-10, real machine):
> - **Symptom and root cause**: after the turn closed, the button stayed **disabled** with "this turn has no rollback point yet", although the point had in fact been created. The engine writes the point for a turn only **after** that turn closes (measured on the real machine: **7.8 seconds** — the turn's log `turn/end` at 20:03:38.658Z, the point's `createdAt` at 20:03:46.434Z; that point records **355 files**), while the client queried **once** after mounting: having read an empty list it **never re-queried** (it was **never retried**), and the empty result was then locked in by the **30-second** list cache ⇒ the dialog could not be opened (the dialog would have re-queried by itself).
> - **Fix (bounded retry after the turn closes)**: a **30-second** window with a **0.5 / 1.5 / 3 / 6 / 12 s** backoff (23 s cumulative, inside the window) and at most **6 list reads** (1 first read + 5 retries); it **stops at the first hit** (not a single further request is sent); **one window per mount** (re-entering the view opens a new one) — **not infinite polling**. Retry rounds bypass that 30-second cache and read the host again (the fresh result is still written back), so **an empty result is no longer treated as long-term truth**.
> - **Honest state**: while the window is open the button is disabled but reads "**Reading the rollback points…**"; only when the **window has closed and the list is still empty** does it say "this turn has no rollback point yet". Both strings live in the dictionary (zh/en), never a raw key.
> - **Guards**: `src/client/chat/chat-entry-view.test.ts` (backoff table and window constants, exactly 6 reads for an empty session, stop-at-first-hit, the real 7.8 s sequence, `force` bypassing the cache without breaking in-flight dedupe, component wiring); QA's independent run reproduced the race with a virtual clock (first query empty → the point appears 1–8 s later: 1 read ⇒ permanent `noPoint`/disabled before the fix, 5 reads ⇒ clickable after it) across 26 assertions, plus a full `npm test` of **4262 tests / 4260 pass / 0 fail** (2 skips = real-machine sampling) with `typecheck` / `typecheck:tests` / `build` + bundle self-containment / the 17-case i18n guard / `check-agents-budget` all green.

> **救援点写不进台账时不再报「幽灵 id」；预览的 stat 失败不再谎报「会新建」**（2026-10-10 安全链修复）：
> - **症状与根因**：留救援点（guard）时 `capturePoint` 曾**无论台账写没写成功**都把内存里的 record 一起返回；消费方（`rewind` 的救援点、`RollbackAutoTracker.captureFor`）拿 `point.id` 当「留点成功」⇒ 对外报出一个**台账里根本查不到的 id**（幽灵 `guardPointId`）：用户拿到 id 却打不开、也回退不了。
> - **改法（三处同类消费者统一判据）**：成败判据只有一条 —— **`appendRecord` 真的成功**。`capturePoint` 写失败即返回 `{ ok:false, code:'ledger-write-failed' }`（**不再返回 record**）；`rewind` 的救援点改用 `guard.ok`，`require` 档留不下即**整体中止**（`guard-failed`、**零写入、不返回 `childSessionId`**），`warn` 档只告警继续但**同样不报 `guardPointId`**（绝不报幽灵点）；tracker 侧同规。
> - **preview 的 stat 失败语义收紧**：`fs.stat` 的结局三分 —— **只有 `ENOENT`** 才算「当前确实不存在」（→ `create`，added = 快照行数）；其它 errno（EACCES / EBUSY / EIO…）是「存在性与可读性**未知**」⇒ 照给 `status` 但 `added/removed = null` + `truncated = true`，**绝不报成 `create` +N/−0**。判据只看 errno 的 `code` 字段，不看 message（message 里出现 `ENOENT` 不算数）。
> - 同时新增工作区段独立码 `no-recorded-files`（「该点没记录任何文件」≠「工作区与该点一致」），HTTP 语义不变（仍 200）。
> - **防漂移守卫（t11）**：引擎 `RollbackCode` union 与客户端 `ROLLBACK_CODES` 镜像现在有**源码级双向对照**用例（`src/ui/rollback-view.test.ts`），含**反自检**（注入「引擎有、镜像没有」的码必须被抓到；注释里的假码不得被当真码）并要求两侧解析结果 ≥30 条 —— 否则「集合相等」是空集对空集的假绿。教训：**两份拷贝必须有对照守卫**（t10 新增 `no-recorded-files` 时客户端镜像静默漏了一格，正是这条守卫生效前的形态）。
> - **护栏**：`src/core/rollback-point.test.ts`（幽灵 id 与 stat 三结局矩阵）、`src/ui/rollback-view.test.ts`（码表镜像双向对照 + 反自检）。

> **A rescue point that could not be written to the ledger no longer reports a "ghost id"; a failed `stat` no longer claims a file will be "created"** (2026-10-10 safety-chain fix):
> - **Symptom and root cause**: when taking a rescue point (guard), `capturePoint` used to return the in-memory record **regardless of whether the ledger write succeeded**; consumers (`rewind`'s rescue point, `RollbackAutoTracker.captureFor`) read `point.id` as "the point was kept" ⇒ they reported an id that **cannot be found in the ledger** (a ghost `guardPointId`): the user gets an id that can be neither opened nor rewound to.
> - **Fix (one criterion for all three consumers)**: the only criterion is that **`appendRecord` really succeeded**. On a failed write `capturePoint` returns `{ ok:false, code:'ledger-write-failed' }` (**no record**); `rewind`'s rescue point switches to `guard.ok`, so under `require` a failed rescue point **aborts the whole rewind** (`guard-failed`, **zero writes, no `childSessionId`**), while `warn` only warns and continues but **never reports a `guardPointId`**; the tracker follows the same rule.
> - **`stat` failure semantics tightened**: `fs.stat` now has three outcomes — **only `ENOENT`** means "it really does not exist" (→ `create`, added = the snapshot's line count); any other errno (EACCES / EBUSY / EIO…) means "existence and readability are **unknown**" ⇒ the `status` is still given but `added/removed = null` + `truncated = true`, **never reported as `create` +N/−0**. The rule looks at the errno `code` only, never the message (an `ENOENT` inside the message does not count).
> - A separate workspace-segment code `no-recorded-files` was added ("this point recorded no files" ≠ "the workspace matches this point"); the HTTP semantics are unchanged (still 200).
> - **Anti-drift guard (t11)**: the engine's `RollbackCode` union and the client's `ROLLBACK_CODES` mirror now have a **source-level two-way set-equality** case (`src/ui/rollback-view.test.ts`) with a **self-check** (an injected "engine has it, mirror does not" code must be caught; fake codes inside comments must not count) and a ≥30-entry requirement on both sides — otherwise "sets are equal" is an empty-vs-empty false green. Lesson: **two copies of one fact need a cross-check guard** (when t10 added `no-recorded-files` the client mirror silently missed it).
> - **Guards**: `src/core/rollback-point.test.ts` (ghost id + the three `stat` outcomes), `src/ui/rollback-view.test.ts` (mirror cross-check + self-check).

> **「无需恢复」不再一句盖住四种事实：结果态与预览态各自分派，并立下「假尾句禁令」**（2026-10-10 文案诚实）：
> - **症状**：同一个「没有可恢复的内容」下，三种**完全不同**的事实被同一句「工作区与该回退点一致，无需恢复」概括 —— ① 该点**压根没记录任何文件**；② 工作区态**没有可用记录**；③ 真的「一致」但**会话仍会回退**（fork 子会话）。①② 是不实陈述（`rollback.code.no-recorded-files` 才是真相），③ 是**假尾句**（点下去真的会 fork，却说「无需恢复」）。
> - **改法（结果态三句 + 预览态四态，各一处实现）**：结果态按 `segments[].status / reasonCode` 分派 `rollback.preview.result.noop / noRecord / noFiles`；预览态由 `src/ui/rollback-view.ts` 的 `rollbackPreviewNote()` 按 **preview 字段**（`available` / `overwrite` / `different` / `missing` / `reasonCode` / `session.restorable` + 宿主的 `canRestore`）分派四态：① 工作区态不可用 → ② 没记录任何文件 → ③a 工作区一致但**会话仍会回退** → ③b 一致且无事可做。**判据禁止解析 `detail`**（技术细节不是接口）。
> - **假尾句禁令（逐字）**：`changesSomething === true`（工作区真会写文件 or 会话真会 fork）时，**要么不上屏任何「一致 / 无需恢复」句，要么该句文案不含「无需恢复」**。落点 = `rollbackPreviewNote()` 的 `changesSomething` 判据 + ③a 的独立文案键（`rollback.preview.files.consistentSession`，**不含**「无需恢复」）。
> - **护栏**：`src/ui/rollback-view.test.ts`（四态矩阵 + 假尾句禁令断言）、`src/client/recovery/recovery-locales.test.ts`（zh/en 键集与码表覆盖）、`src/client/chat/rollback-entry-view.test.ts`（结果态三句分派）。

> **"Nothing to restore" no longer covers four different facts: the result state and the preview state each dispatch their own wording, and the "false trailing sentence" ban is written down** (2026-10-10 wording honesty):
> - **Symptom**: under the same "nothing restorable" condition, three **completely different** facts were all summarised by one sentence ("The workspace already matches this rollback point, nothing to restore") — ① the point **recorded no files at all**; ② the workspace state **has no usable record**; ③ it really does match, but **the session will still be rewound** (a child session is forked). ①② were false statements (`rollback.code.no-recorded-files` is the truth) and ③ was a **false trailing sentence** (clicking really does fork, yet it said "nothing to restore").
> - **Fix (three result sentences + four preview states, one implementation each)**: the result state dispatches `rollback.preview.result.noop / noRecord / noFiles` from `segments[].status / reasonCode`; the preview state dispatches through `rollbackPreviewNote()` in `src/ui/rollback-view.ts` using **preview fields only** (`available` / `overwrite` / `different` / `missing` / `reasonCode` / `session.restorable` plus the host's `canRestore`): ① workspace state unusable → ② no files recorded → ③a workspace matches but **the session still rewinds** → ③b matches and nothing to do. **Parsing `detail` is forbidden** (technical detail is not an interface).
> - **False-trailing-sentence ban (verbatim)**: when `changesSomething === true` (the workspace will really write files or the session will really fork) you must **either show no "matches / nothing to restore" sentence at all, or the sentence must not contain "nothing to restore"**. The landing point is `rollbackPreviewNote()`'s `changesSomething` plus ③a's own key (`rollback.preview.files.consistentSession`, which does **not** contain "nothing to restore").
> - **Guards**: `src/ui/rollback-view.test.ts` (four-state matrix + the ban), `src/client/recovery/recovery-locales.test.ts` (zh/en key sets and code coverage), `src/client/chat/rollback-entry-view.test.ts` (the three result sentences).

> **「工作区与该回退点一致」不再报 500，预览弹窗开始逐文件给新增/删除行数**（2026-10-10 用户第一条反馈）：
> - **症状与根因**：用户看到「回滚失败并提示错误 500」。根因**不是真失败** —— 引擎在「没有可恢复的内容」时给出 `code='nothing-to-restore'`，而 `src/routes/recovery.ts` 把它与真失败同级映射成 HTTP 500。用户实际命中的路径是「被请求的段全部没有可恢复内容」（只回退会话态而该点没有可用会话捕获 / 只回退工作区态而该态记录 0 文件）。
> - **改法**：`nothing-to-restore` → **HTTP 200**（从 500 行删除，并在注释表里写明理由）；引擎侧「无事可做」的段改为 `status='restored'` + `restored=0`（**不是** `skipped`，因此不再进 `skippedSegments`），整体 `outcome='restored'` + `code='nothing-to-restore'`。**只要还有一段真能回退，会话段照常执行并返回 `childSessionId`**（R-26 钉住）。真失败仍 500（`restore-failed` / `guard-failed` / `ledger-write-failed` / `outcome=failed`；R8-7⑥ 用真 HTTP 钉住 `restore-failed`=500）。
> - **0 变更就是真的 0 次写入**：工作区记录在案的文件**全部**已与快照一致时，引擎**不再重写**它们（旧实现会重写全部文件后报 `restored=N`）——「353 项 / 0 项不同」现在是真的零写入、零变更（字节与 mtime 都不变）。
> - **预览逐文件行级统计（新增字段 `preview.workspace.files`）**：`[{ path, status: 'overwrite'|'create'|'delete', added, removed, truncated }]`，**只列会被改动的文件**（内容一致的一项都不列）。`added`/`removed` = 这次回退会对该文件**新增 / 删除**的行数（折公共前后缀 + Myers 最短编辑脚本；0 字节 = 0 行、CRLF/CR/LF 同义、末尾换行不额外计行；当前不存在的文件按 `create` 给「快照行数」）。四条上限（单文件 1 MiB / 单张累计 32 MiB / 单条目步数 8e6 / 单张总步数 32e6）、非文本（前 8 KiB 含 NUL）与「对象仓读不出」一律**只影响行数**：触到即 `added=removed=null` + `truncated=true`，界面说「行数未统计」而**绝不写 0**。`'delete'` 保留在取值集合里，但**当前引擎永不产出**（回退只覆盖、绝不删除文件）。
> - **护栏**：`tests/route/recovery-rollback.test.ts` R8-7（真 http：0 变更 + 会话可回退 → 200 且真 fork / 全段无事可做 → 200 `nothing-to-restore` / 逐文件行数 / 篡改台账 → 500）、`src/core/rollback-point.test.ts` R-26–R-28、`src/ui/rollback-view.test.ts` 与 `src/client/chat/rollback-entry-view.test.ts` 的判定层断言。全量 `npm test` **4216 条 / 4214 pass / 0 fail**（2 条 skip = `src/foreign/copilot.test.ts` t9 与 `src/foreign/cursor.test.ts` t12 的**真机取样**用例，本机没有 `~/.copilot` / `~/.cursor` 目录 —— **不是**「产物相关跳过」），`typecheck` / `typecheck:tests` / `build` + bundle 自包含 / i18n 守卫 17 条 / `check-agents-budget` 全绿。

> **"The workspace already matches this rollback point" no longer returns 500, and the preview dialog reports per-file added/removed line counts** (the user's 1st point, 2026-10-10):
> - **Symptom and root cause**: the user saw "rollback failed with error 500", but the root cause was **not a real failure** — when there is nothing to restore the engine reports `code='nothing-to-restore'`, and `src/routes/recovery.ts` mapped it to HTTP 500 alongside real failures. The paths users actually hit were "every requested segment has nothing restorable" (rewinding only the session state when the point has no usable session capture, or only the workspace state when that state recorded zero files).
> - **Fix**: `nothing-to-restore` is now **HTTP 200** (removed from the 500 line, with the reason written into the comment table); a segment with nothing to do becomes `status='restored'` + `restored=0` (**not** `skipped`, so it no longer lands in `skippedSegments`) and the overall outcome is `outcome='restored'` + `code='nothing-to-restore'`. **If any segment can really be restored, the session segment still runs and returns a `childSessionId`** (pinned by R-26). Real failures still return 500 (`restore-failed` / `guard-failed` / `ledger-write-failed` / `outcome=failed`; R8-7⑥ pins `restore-failed`=500 over real HTTP).
> - **Zero changes now means zero writes**: when every recorded workspace file already matches the snapshot the engine no longer rewrites them (the old code rewrote all of them and reported `restored=N`) — "353 items / 0 differ" is now a real no-op (bytes and mtime both unchanged).
> - **Per-file line statistics (new field `preview.workspace.files`)**: `[{ path, status, added, removed, truncated }]`, listing **only files that will change**. `added`/`removed` are the lines this rewind will add/remove (common-prefix/suffix folding plus a Myers shortest-edit script; 0 bytes = 0 lines, CRLF/CR/LF are equivalent, a trailing newline adds no line; a file that no longer exists is reported as `create` with the snapshot's line count). Four limits (1 MiB per file / 32 MiB per preview / 8e6 steps per entry / 32e6 steps per preview), non-text content (a NUL byte within the first 8 KiB) and an unreadable object store affect the counts only: hitting any of them yields `added=removed=null` + `truncated=true` and the UI says "line counts not measured" — never a fabricated `0`. `'delete'` stays in the value set, but the engine **never produces it** (a rewind only overwrites, never deletes).
> - **Guards**: `tests/route/recovery-rollback.test.ts` R8-7 (real HTTP: zero-change + restorable session → 200 with a real fork / all segments no-op → 200 `nothing-to-restore` / per-file counts / tampered ledger → 500), `src/core/rollback-point.test.ts` R-26–R-28, plus the decision-layer assertions in `src/ui/rollback-view.test.ts` and `src/client/chat/rollback-entry-view.test.ts`. Full `npm test` is **4216 tests / 4214 pass / 0 fail** (the 2 skips are the **real-machine sampling** cases `src/foreign/copilot.test.ts` t9 and `src/foreign/cursor.test.ts` t12 — this machine has no `~/.copilot` / `~/.cursor`, **not** artifact-related skips), with `typecheck` / `typecheck:tests` / `build` + bundle self-containment / the 17-case i18n guard / `check-agents-budget` all green.

> **聊天内用户气泡按宿主逐字对齐（复核发现的 5 处未声明偏差，2026-10-10 t4 复核 → t9 修复）**：接管渲染器后复刻的气泡有 5 处与宿主 `UserStyleBubble` 的实际行为不一致（其中 2 处还与源码注释自相矛盾），复核因此判 needs_revision；现已**全部按宿主复刻**（不是登记差距）：① **compact 旗标** = 附件总数（图片 + 文件）> 1，不再是「图片数 > 1」；② **附件按 content 原始顺序**渲染（此前固定「先图片后文件」）；③ **体积文案**逐字复刻宿主 `fileSizeText`（无空格；单位值 < 10 才一位小数，否则取整 —— `2.0KB` / `20KB`；字节数读不到就不渲染）；④ **时钟** = 固定 **24h 补零 `HH:mm`**（此前 `toLocaleTimeString` 在 en-US 下显示 `05:04 PM`）；⑤ **正文会话线格式** `@[label](dsh-session:…)` 投影成 label，并补上宿主同款**引用摘要行**（`引用会话 · …`，文案进字典；此前把内部语法原样上屏 —— 样本实测本机 0/16536 条，属潜在差距）。
> - **dotfile 附件的扩展名徽标按宿主同款处理**（前导点算后缀 + 8 字符截断，`.gitignore` → `GITIGNOR`）—— 这是「有意镜像宿主怪癖、**一致优先**」的决定，**不是 bug**。
> - **两条已追认差距保持不变**（复核明确保留，勿再当选型问题重开）：技能 chip 仍不渲染（t5 的 DOM 探针拿 `[data-ref-chip]` 当技能 chip 代理，其翻转属**探针侧副作用** —— 该属性现在挂在引用摘要行上，不代表我们渲染了技能 chip）；文件类型图标仍用扩展名徽标。
> - **护栏**：`src/client/chat/chat-entry-view.test.ts` **31** 条（新增「附件有序投影 + compact」「会话线格式与引用摘要」两组）；复核侧探针前后对照：SlotCore 10/10 不变、node 探针的两条偏差断言由 FAIL 转 PASS、真浏览器 DOM 端到端 32/32（t5 复核 pass、0 findings）。

> **The in-chat user bubble is now aligned with the host verbatim (five undeclared deviations found by review, 2026-10-10, t4 review → t9 repair)**: the replicated bubble differed from the host `UserStyleBubble` in five places (two of them contradicting the code's own comments), so review returned needs_revision; all five are now **replicated from the host** rather than logged as gaps: ① the **compact flag** counts **all attachments** (images + files) > 1, not "images > 1"; ② **attachments render in content order** (it used to be "images first, then files"); ③ the **size text** mirrors the host `fileSizeText` verbatim (no space; one decimal only when the unit value is < 10, otherwise rounded — `2.0KB` / `20KB`; an unreadable byte count renders nothing); ④ the **clock** is a fixed zero-padded **24-hour `HH:mm`** (it used to be `toLocaleTimeString`, which shows `05:04 PM` under en-US); ⑤ the **in-body session wire form** `@[label](dsh-session:…)` is projected to its label and the host's **reference summary line** (`Referenced session · …`, copy in the dictionary) is rendered too (the raw internal syntax used to be printed; a local sample scan found 0/16536, so it was a latent gap).
> - **Dotfile attachments follow the host extension rule** (a leading dot counts, 8-character truncation, `.gitignore` → `GITIGNOR`) — a deliberate "mirror the host quirk, **consistency first**" decision, **not a bug**.
> - **Two accepted gaps stay as they are** (review explicitly kept them; do not re-open them as design questions): skill chips still do not render (t5's DOM probe uses `[data-ref-chip]` as a *proxy* for skill chips; its flip is a **probe-side side effect** — that attribute now lives on the reference summary line and does not mean we render skill chips); the file-type icon is still an extension badge.
> - **Guards**: `src/client/chat/chat-entry-view.test.ts` **31** cases (the new "ordered attachments + compact" and "session wire form + reference summary" groups); on the review side, the before/after probe comparison: SlotCore 10/10 unchanged, the node probe's two deviation assertions flipped from FAIL to PASS, and the real-browser DOM end-to-end run 32/32 (t5 review: pass, 0 findings).

> **回滚点台账不再被并发写踩坏、事件 / 会话窄化不再静默丢弃**（t7 复核 → 修复单 t14）：台账的**全部写入口**（自动留点的 `appendRecord`、`remove`、`rewind` 的救援点）现在都走同一个模块级串行链 `withLedgerWriteLock`（**进程内**读-改-写原子）。修掉的现象：两个引擎实例（宿主 tracker 与路由）交错 capture / remove / rewind 时会丢更新、甚至把已删除的点「复活」。
> - **跨进程边界不可互替**：`withLedgerWriteLock` 只保证单进程内串行；跨进程（另一个 DSH 实例、离线 CLI）仍由路由层的 `runWithMutationLock` / 环境锁（`<dataDir>/locks/environment.lock`）负责 —— **env 锁管「谁能写」，本队列管「进程内多个写者别互相踩」，两者都必须在**。
> - **窄化不再静默**：`rollbackTrackedEventOf` / `rollbackSessionBindingOf` 从宿主入口搬进 `src/core/rollback-point.ts` 并导出，形状不符给结构化 `invalid-input`（`event-not-object` / `event-seq-missing` / `event-type-missing` / `session-not-object` / `session-id-missing`，seq 必须有限数）并由宿主 `host.log.warn`；会话缺 cwd 或 cwd 非绝对 → `chunkless`（不留 chunks）且该点 `incomplete=true` + `workspace.reasonCode='no-chunks'`，界面可如实展示。
> - **护栏**：`src/core/rollback-point.test.ts` R-22（两实例交错 20 轮：台账无重复 id / 删除成功的不复活 / 返回 ok 的点确实在台账里）、R-23 / R-23b / R-23c（事件与会话登记矩阵 + chunkless 集成）、R-24（guard 留存与上限）。

> **The rollback ledger can no longer be corrupted by concurrent writes, and event/session narrowing no longer drops input silently** (t7 review → repair ticket t14): every ledger write path (the automatic `appendRecord`, `remove`, and the rewind rescue point) now goes through one module-level serial chain, `withLedgerWriteLock` (**in-process** read-modify-write atomicity). This fixes lost updates and even resurrected deleted points when two engine instances (the host tracker and a route) interleaved capture / remove / rewind.
> - **The cross-process boundary is not interchangeable**: `withLedgerWriteLock` serialises writers inside one process only; across processes (another DSH instance, the offline CLI) the route layer's `runWithMutationLock` / environment lock (`<dataDir>/locks/environment.lock`) still applies — **the env lock decides who may write, this queue keeps writers inside a process from stepping on each other; both are required**.
> - **Narrowing is no longer silent**: `rollbackTrackedEventOf` / `rollbackSessionBindingOf` moved out of the host entry into `src/core/rollback-point.ts` (now exported) and return a structured `invalid-input` (`event-not-object` / `event-seq-missing` / `event-type-missing` / `session-not-object` / `session-id-missing`; seq must be a finite number) while the host logs `host.log.warn`; a session with a missing or non-absolute cwd becomes `chunkless` (no chunks recorded) and its point is `incomplete=true` with `workspace.reasonCode='no-chunks'`, which the UI can show honestly.
> - **Guards**: R-22 / R-23 / R-23b / R-23c / R-24 in `src/core/rollback-point.test.ts`.


> **改了仓库地址后同步静默失效（issue #79 主诉）**：`src/sync/git/git-transport.ts` 的 `ensureRepo()` 见到已有 `.git` 就直接复用，
> `repoUrl` 只在首次 clone 时被使用 —— 此后 pull / push 全走旧 `origin`，失败面却是旧地址的网络超时（很容易被误判成网络或凭据问题）。
> 现在每次同步都核对 origin（含 `--push` 变体）并与配置地址对齐（**一致时一条写命令都不发**；读不出 origin 时先 `remote add`）。
> 另外两类「与网络无关」的失败也有了专用可操作文案：SSH 主机密钥校验失败（给出 `ssh-keyscan` / `known_hosts` 做法，
> **绝不自动信任任何主机**）与「远端与本地工作副本不是同一条历史」（指向重建工作副本）。

> **Change the repository address and sync silently died** (issue #79): `ensureRepo()` reused an existing `.git` and `repoUrl` was only
> used on the first clone, so pull/push kept using the stale `origin` while the failure looked like a network timeout. Every sync now
> reconciles origin (including the `--push` URL) with the configured address — **zero write commands when they already match** — and adds
> `origin` when it is missing. Two non-network failures also got actionable messages: SSH host-key verification (how to use
> `ssh-keyscan`/`known_hosts`; **no host is ever trusted automatically**) and "the remote and the local working copy are not the same history".

> **远端冲突不再连坐「把本机配置推上去」**（issue #79）：merge 计划含冲突时整轮 `skipped/conflict` 直接 return，
> Phase C 的 push 永远到不了 —— 纯上行备份链路被一并封死。现在冲突只挡**下行**（绝不把冲突内容写进本地），
> 仍按 `localDirty` 执行纯上行推送并记 `partial`（上行成功、下行待确认，带冲突分区清单）；本地无改动或启动变体仍是 `skipped/conflict`。
> 护栏：`src/sync/autosync-scheduler.test.ts`（冲突 → partial + 仍 push + 不写本地）。

> **Remote conflicts no longer block the upload-only path** (issue #79): any conflict made the whole run `skipped/conflict` and return
> before the push phase, so "back up this machine" was blocked too. Conflicts now block only the **download** side (nothing is written
> locally); the pure upload still runs when local config changed and is reported as `partial` with the conflicted sections.

> **不再长期挂着几天前的旧错误与旧计数**（issue #79）：`writeFinalConfig` 只在失败时写 `lastRunMessage`，
> 于是旧地址超时文案在连续跳过期间一直驻留；`consecutiveFailures` 又只在成功时归零。现在每轮都用本轮结果覆盖消息与跳过码
> （**成功即清空**），连续失败计数**只在真失败时 +1，success / skipped / partial 一律归零**（跳过不是失败）。

> **Stale errors and failure counts no longer linger** (issue #79): the message is now overwritten every run (cleared on success), and
> `consecutiveFailures` increments only on real failures while success/skipped/partial reset it to zero.

> **环境锁「没有锁文件」不再被报成 LOCKED**（issue #79）：ownership 文件缺失时 `inspectLockState()` 保守归为 LOCKED，
> startup 映射的非 STALE/UNKNOWN 兜底也映射成 LOCKED → `/recovery/status` 会显示一个并不存在的锁（真机：用户自测 acquire/release
> 都正常，面板却一直 LOCKED）。现在缺失态如实为新增分类 `FREE` 并透传 startup 映射；**acquire 侧不据此放行** ——
> 它改为重试独占创建（有界 5 次），把「上一次占用刚释放」的竞态从「另一个任务正在运行」里摘出来。
> 护栏：`src/utils/env-lock.test.ts`（63 条全绿，含 FREE 竞态与既有 stale 语义不变）。

> **The environment lock no longer reports LOCKED when there is no lock file** (issue #79): a missing ownership file classified as
> LOCKED (and the startup mapping did the same), so `/recovery/status` showed a lock that did not exist. A missing file is now the new
> `FREE` state. Acquire does not treat it as permission to proceed — it retries exclusive creation (bounded), so a just-released lock
> is no longer mistaken for "another task is running".

> **备份/导出不再把「共享引用」误判成循环引用**（用户上报 2026-10-09，0.1.66 真机）：敏感扫描器判环用的是
> **全局 visited**（"本次扫描见过的对象"），而 settings 分区的 `value` 与 `base` 在未被用户覆盖的嵌套分组上
> 是**同一个对象**（DAG 共享引用，不是环），于是扫描抛 `检测到循环引用，无法扫描（路径 namespaces.<ns>.value.<key>）`，
> 整次备份失败、导出目录为空；又因为备份跑在 intent journal 内，异常还会写 `NEEDS_ATTENTION` + durable SAFE MODE，
> 把用户连锁顶进「写操作持续 423」的死结（0.1.66 的现场）。现在判环只看**当前路径的祖先链**（`ancestors`）：
> 共享引用放行（输出各写一份独立副本），真环（对象环 / 数组环 / 深层回指）照旧抛错，深度上限与脱敏语义一字未动。
> 影响面不止 settings —— 同一个扫描器被 exporter / sync / market / foreign / consult / migration-history 等 10 处
> 调用点复用，任何分区的共享引用都会踩到。
> - **护栏**：`src/security/security.test.ts`（DAG 放行 + 两个分支各自脱敏 + 真环仍抛）、
>   `src/adapters/settings.test.ts`（value/base 共享的 settings 导出过 scanner 不抛）。
>
> **Backups no longer mistake shared references for cycles** (user report, 2026-10-09): the secret scanner's cycle
> detection used a **global visited set** ("objects seen during this scan"), but a settings section's `value` and `base`
> share the same object for nested groups the user never overrode — a DAG, not a cycle. The scan threw
> `Circular reference detected, cannot scan (path namespaces.<ns>.value.<key>)`, the whole backup failed, and because the
> backup runs inside an intent journal the exception also wrote `NEEDS_ATTENTION` plus a durable SAFE MODE, leaving the
> user with persistent 423 responses on every write (the 0.1.66 scene). Cycle detection now consults only the
> **ancestor chain of the current path**: shared references pass (each occurrence gets its own copy), real cycles
> (object / array / deep back-reference) still throw, and the depth limit and redaction semantics are unchanged. The same
> scanner is reused by exporter / sync / market / foreign / consult / migration-history (10 call sites), so the fix covers
> every section, not just settings.
> - **Guards**: `src/security/security.test.ts` (DAG passes with both branches redacted; real cycles still throw),
>   `src/adapters/settings.test.ts` (a settings export with a shared value/base survives the scanner).

> **首页状态条：英文不再变形、中文不再被裁**（两轮真机截图反馈）：状态条按 32px **单行**设计，而英文标签比
> 中文长约 50%（实测 5 段 688px > 画布可用 ~527px），折行后两行被挤进 32px 的框里、第二行贴着下边框。第一轮
> 只补行距 / 段内上下内边距后，又暴露出第二层根因：`.statStrip` 自身没有 `flex: none`，而 `.viewBody` 是 column
> flex 容器 —— 面板内容一高它就被压回 `min-height`(32px)，折行的第二行于是**溢出到工具栏底下被按钮盖住**
> （中文同样中招；改前折行内容恰好 30px 能塞进 32px，所以只显拥挤不显裁切）。现在三条一起落地：
> ① `flex: none`（页头行永不参与纵向收缩）；② 段内左右内边距 12→8px（中文 547px→491px、英文 481px→441px），
> 中英文**都回到单行**；③ 折行兜底 `row-gap: 6px` + 段内上下 4px，两行有呼吸、不再压框。中文文案一字未动，
> 英文 5 条标签按画布实测收窄（`All healthy` / `Backups` / `Snapshots` / `Auto backup` / `Sync`）。
> - **护栏**：`css-scale-guard`（间距 6/4/8 仍在 9 档内）、`locale-hardcode-guard`、`i18n-hardcoded-guard`；
>   复核口径 = 用 Segoe UI / Microsoft YaHei 11/12px 量文本宽度（与截图像素实测误差 2%）。
>
> **Home status strip: no more deformation in English, no more clipping in Chinese** (two rounds of real-device
> screenshots): the strip is designed as a single 32px row, but English labels run ~50% longer than Chinese (688px of
> content vs ~527px available). After the first round only added row spacing and vertical padding, a second root cause
> surfaced: `.statStrip` itself had no `flex: none`, and `.viewBody` is a column flex container — once the panel grows,
> the strip is forced back to its `min-height` (32px) and the wrapped second row **overflows underneath the toolbar and
> gets covered by the buttons** (Chinese was hit the same way; before, the wrapped content happened to be exactly 30px
> and fit inside 32px, so it looked cramped rather than clipped). Three fixes: ① `flex: none` (a header row never
> shrinks vertically); ② horizontal padding 12→8px per segment (Chinese 547px→491px, English 481px→441px) so **both
> languages are back on one line**; ③ wrap fallback `row-gap: 6px` + 4px vertical padding so a wrapped strip breathes.
> Chinese copy is untouched; the five English labels were trimmed against the measured canvas (`All healthy` /
> `Backups` / `Snapshots` / `Auto backup` / `Sync`).
> - **Guards**: `css-scale-guard` (6/4/8 stay on the 9-step scale), `locale-hardcode-guard`, `i18n-hardcoded-guard`;
>   the width model was calibrated against screenshot pixels with Segoe UI / Microsoft YaHei at 11/12px (2% error).

> **英文界面零中文：切到 English 后界面仍有大量中文（两个一次性语言绑定根因 + 全仓中文硬编码）**：
> ① 客户端 `src/client/index.ts` 在插件加载时**一次性绑定** `uiT`（`makeUiT(ctx.locale.getLocale().active …)` 是快照），
> 用户切到 English 后所有走 `UiT` 的报告 / 错误 / 进度 / 导入向导 / 同步 / 市场文案**永远停在加载时那门语言**；
> ② 宿主 `this.msg = makeMsg(resolveAppLanguage(ctx))` 同样在装配期冻结（宿主产出的报告 / 计划 / 错误经 API 回浏览器渲染，
> `src/routes/kit.ts` 原样回传 `error.message` ⇒ 引擎里的中文会逐字出现在 ErrorBanner）。现在**语言在「取文案那一刻」解析**：
> 客户端 `makeLiveUiT(read)`（`src/ui/i18n.ts`，接线在 `src/client/index.ts`），宿主 / 引擎 `engineMsg` +
> `setEngineLanguageSource(() => resolveAppLanguage(ctx))` + `invalidateEngineLocale()`（`src/core/engine-locale.ts`；路由注册点
> `src/routes/kit.ts` 的 `endpoint()` 每请求失效，`LANGUAGE_TTL_MS = 1000` 只给调度器 / 后台任务兜底），并新增
> `registerMessageCatalog` 让各域目录（core / market / utils / sync / schema / routes / security / adapters / foreign / migrations / profiles / s3 / gist）
> 并入既有 zh/en 目录。**全部用户可见中文已迁入目录**（20 本目录 3446 键：zh 逐字不变、en 一律补齐；迁移前既有 372 键的
> zh/en 指纹冻结在 `src/core/engine-locale.test.ts`，只许追加）。
> - **护栏**：`tests/helpers/i18n-scan.ts` + `tests/i18n-hardcoded-guard.test.ts` 的**静态守卫**（逐字符词法状态机；豁免源码注释、
>   `log.*` / `console.*` 实参、目录 zh 区）。全量 `node --test tests/i18n-hardcoded-guard.test.ts` 退出码 0
>   （`scope=ALL files=<扫描文件数> hits=0 allowlisted=128`）；作用域自检 `DCM_I18N_GUARD_SCOPE=<前缀>` 只收窄文件列表。
>   **实测红→绿：迁移前 1107 + 白名单 73 = 1180 条命中 → 0**（t2 落守卫后 1084+73，t12 落白名单两条后 hits 再减 55）。
>   白名单 4 条 / 128 命中全部是**已登记的非渲染匹配文本**：`src/foreign/truth-table.ts` 61（取证数据）、
>   `src/ui/test-helpers.ts` 12（仅供 `*.test.ts`）、`src/ui/commands.ts` 49（命令面板检索同义词）、
>   `src/ui/errors.ts` 6（把宿主错误消息映射到友好标题的正则字面量）；新增豁免只能走 captain 审批。
> - **刻意保留中文的排除项**：`src/cli/**`（终端 CLI 与离线救急台）、源码注释、`log.*` / `console.*` 实参、`*.test.ts`。
> - **残余（如实登记，详见 `docs/design/2026-10-08-i18n-en-hardcoding.md` §3.9 / §7 与 `docs/known-pitfalls.md`）**：
>   `src/core/model-tools.ts` 的 5 条工具描述在 apply 期解析（DSH「注册即快照」⇒ 会话中途切语言不即时更新）；
>   只有**精确 `'zh'`** 视为中文（`'zh-Hans'` / `'zh-TW'` 回落 en；DSH 内建仅 zh/en）；`src/cli/index.ts:1025` 仍按文案子串判 corrupt 锁（CLI 恒 zh 故当前正确）。
> - **验证口径**：结论来自静态守卫 + `npm test`（**收尾实测 4057 用例 / 4055 pass / 0 fail / 2 skipped**）+ `typecheck` / `typecheck:tests` / `build`；
>   **真机逐页签 DOM 抽查未做**（验证会话无浏览器通道），不当作已通过。

> **Zero Chinese in the English UI: switching to English still showed plenty of Chinese (two one-shot language bindings + repo-wide hardcoded Chinese)**:
> (1) the client bound `uiT` **once** at plugin load (`makeUiT(ctx.locale.getLocale().active …)` is a snapshot), so every report / error /
> progress / import-wizard / sync / market string going through `UiT` **stayed in the load-time language** after the user switched to English;
> (2) the host froze `this.msg = makeMsg(resolveAppLanguage(ctx))` at assembly time (host reports / plans / errors are rendered back in the
> browser and `src/routes/kit.ts` returns `error.message` verbatim, so engine Chinese showed up word-for-word in the ErrorBanner). The language
> is now **resolved at the moment the text is read**: `makeLiveUiT(read)` on the client (`src/ui/i18n.ts`, wired in `src/client/index.ts`),
> `engineMsg` + `setEngineLanguageSource(() => resolveAppLanguage(ctx))` + `invalidateEngineLocale()` on the host / engine
> (`src/core/engine-locale.ts`; the route registration point `endpoint()` in `src/routes/kit.ts` invalidates per request, `LANGUAGE_TTL_MS = 1000`
> only backstops schedulers / background work), plus `registerMessageCatalog` so the per-domain catalogs (core / market / utils / sync / schema /
> routes / security / adapters / foreign / migrations / profiles / s3 / gist) merge into the existing zh/en catalogs. **All user-visible Chinese
> moved into catalogs** (20 catalogs, 3446 keys: zh byte-identical, en filled in; the frozen fingerprint of the pre-existing 372 keys lives in
> `src/core/engine-locale.test.ts` and is append-only).
> - **Guards**: the **static guard** in `tests/helpers/i18n-scan.ts` + `tests/i18n-hardcoded-guard.test.ts` (character-level lexer; exemptions:
>   source comments, `log.*` / `console.*` arguments, catalog zh regions). Full run `node --test tests/i18n-hardcoded-guard.test.ts` exits 0
>   (`scope=ALL files=<scanned file count> hits=0 allowlisted=128`); the scoped self-check `DCM_I18N_GUARD_SCOPE=<prefixes>` only narrows the file list.
>   **Measured red → green: 1107 + 73 allowlisted = 1180 hits before the migration → 0** (1084+73 right after t2 landed the guard; the two
>   whitelist entries from t12 removed another 55). The 4-entry / 128-hit allowlist is entirely **registered non-rendered matching text**:
>   `src/foreign/truth-table.ts` 61 (evidence data), `src/ui/test-helpers.ts` 12 (only used by `*.test.ts`), `src/ui/commands.ts` 49
>   (command-palette search synonyms), `src/ui/errors.ts` 6 (regex literals that map host error messages to friendly titles); new exemptions
>   require captain approval.
> - **Deliberately still Chinese**: `src/cli/**` (terminal CLI + offline rescue console), source comments, `log.*` / `console.*` arguments, `*.test.ts`.
> - **Residuals (recorded, not hidden — see `docs/design/2026-10-08-i18n-en-hardcoding.md` §3.9 / §7 and `docs/known-pitfalls.md`)**: the 5 tool
>   descriptions in `src/core/model-tools.ts` resolve at apply time (DSH "registration is a snapshot" ⇒ mid-session switches are not picked up);
>   only the exact id `'zh'` counts as Chinese (`'zh-Hans'` / `'zh-TW'` fall back to en; DSH ships only zh/en); `src/cli/index.ts:1025` still decides
>   the corrupt lock by a message substring (correct today because the CLI is always zh).
> - **Verification scope**: conclusions come from the static guard + `npm test` (**measured at wrap-up: 4057 tests, 4055 pass / 0 fail / 2 skipped**) + `typecheck` /
>   `typecheck:tests` / `build`; the **real-machine per-tab DOM walk was not done** (no browser channel in the verification session) and is not
>   claimed as passing.

> **技能自带的 node_modules 让定时备份永久失败（issue #76）**：文件类分区的递归收集此前没有依赖目录排除项 ——
> 技能目录里只要装了自己的依赖，`skills` 分区就会被遍历出上万个条目（真机：`~/.dsh/skills/md2pdf` 的
> `node_modules` 11 625 个文件 ⇒ 分区 **11 629** 条、全量备份 **11 681** 条），撞上导出侧的 10 000 条目闸门，
> **定时备份与「立即备份」双双永久失败**，而这两条路径都不接受分区范围、`backup-schedule.json` 也没有排除项
> ⇒ 用户侧无解。现在**任意深度的 `node_modules` 整棵跳过**（依赖树可由包内保留的 `package.json` / lock 重建，
> 与 `plugins` 分区的 `npm pack` 口径一致），并把它**写进导出报告 / 只读预览 / 离线 CLI 的告警**
> （跳过了哪些目录、各多少文件；计数超预算时如实写「未统计」而不猜）—— 绝不静默。排除落在遍历内核，
> 因此宿主门面、预览与离线 CLI 三处口径天然一致。10 000 条目上限**不动**（它是「导出必须能导回」的不变量，
> 有意不加宽）。
> - **行为变化（如实记）**：备份包内**不再包含**技能 / 预设目录下的 `node_modules`；目标机恢复后需在该技能
>   目录重新 `npm install`（包内保留 `package.json` / lock，告警文案已写明）。恰好叫 `node_modules` 的
>   **普通文件**、以及 `notes-node_modules` / `node_modules.md` 这类相似名**照常进包**。
> - **护栏**：`src/utils/recursive-walk.test.ts`（任意深度命中 + 文件计数 + 同名普通文件不误伤 + 不混进
>   `skippedLinks`）、`src/adapters/link-report.test.ts`（文案含路径 / 文件数 /「未统计不猜」）、
>   `src/adapters/files.test.ts`（skills 导出报告里可见）、`src/core/backup-plan.test.ts`
>   （真实临时目录跑离线 `collectBackupEntries`：归档无 `node_modules/`，告警有行）。
> - **顺带修正（如实记）**：离线 CLI 备份（`dcm backup`）的跳过告警此前会把**已是 homeDir 相对**的路径
>   再叠一层分区前缀（真机规模探针里打印成 `skills/skills/md2pdf/node_modules`）——现在只打印一次，
>   与相邻的「目录读取失败」行同口径；`src/core/backup-plan.test.ts` 钉住。
> - **仍未做（如实记）**：定时备份 / 立即备份**依旧不支持分区范围** —— 本轮修掉的是现场成因，
>   issue #76 里「让无人值守路径也能缩小范围」的备选 2/3 未实现。
>
> **A skill shipping its own node_modules permanently broke scheduled backups (issue #76)**: the file-section walker
> had no dependency-directory exclusion, so one skill with local deps pushed the `skills` section past ten thousand
> entries (measured: `~/.dsh/skills/md2pdf`'s `node_modules` = 11,625 files ⇒ **11,629** section entries,
> **11,681** total), tripping the writer's 10,000-entry gate — **both scheduled and "back up now" failed forever**,
> and neither path accepts a section range (`backup-schedule.json` has no exclusion field either), leaving the user
> no way out. `node_modules` at **any depth** is now skipped whole (the dependency tree is rebuildable from the
> bundled `package.json` / lock, matching the `plugins` section's `npm pack` semantics), and the skip is
> **reported in the export report, the read-only preview and the offline CLI warnings** (which directories, how many
> files; when the counting budget runs out it says "not measured" instead of guessing) — never silent. The exclusion
> lives in the walk kernel, so the host facade, the preview and the offline CLI agree by construction. The 10,000-entry
> limit is **unchanged** (it is the "what we export must import back" invariant, deliberately not widened).
> - **Behaviour change (recorded honestly)**: bundles no longer contain `node_modules` under skill/preset directories;
>   after restoring, run `npm install` in that skill directory on the target (the `package.json` / lock stay in the
>   bundle and the warning says so). A **regular file** literally named `node_modules`, and look-alikes such as
>   `notes-node_modules` / `node_modules.md`, are still included.
> - **Guards**: `src/utils/recursive-walk.test.ts` (any-depth hit + file count + same-named regular file untouched +
>   not mixed into `skippedLinks`), `src/adapters/link-report.test.ts` (path / file count / "not measured" never
>   guessed), `src/adapters/files.test.ts` (visible in the skills export report), `src/core/backup-plan.test.ts`
>   (real temp dir through the offline `collectBackupEntries`: no `node_modules/` in the archive, one warning line).
> - **Adjacent fix (recorded honestly)**: the offline CLI (`dcm backup`) skip warnings used to prepend a section
>   prefix to an already **homeDir-relative** path (the real-scale probe printed `skills/skills/md2pdf/node_modules`);
>   it is now printed once, matching the neighbouring "directory unreadable" line. Pinned by
>   `src/core/backup-plan.test.ts`.
> - **Still not done (recorded honestly)**: scheduled and manual backups **still accept no section range** — this
>   round removed the field cause only; alternatives 2/3 in issue #76 are not implemented.

> **本轮 UX 审查的 11 处体验修复（会话体检 / 同步 / 市场 / 首页 / 产物库 / 确认弹窗）**：全部只改既有功能的呈现与状态反馈，不新增功能、不改工作流。
> - **会话体检不再把机器码甩给用户**：19 条问题码（location-mismatch / duplicate-id / missing-message-id …）映射成中英短标签，未知码回落「未识别的问题」——**绝不裸渲染机器码**（映射表 `src/ui/session-issue-labels.ts`，`satisfies Record<SessionHealthIssueCode, string>` 让新增码漏配即编译失败；护栏 `src/ui/session-issue-labels.test.ts`）。
> - **断开通道的确认框不再说错通道**：s3 / gist 卡上点「断开配置」此前一律显示「Git 私有仓库」；改用既有的穷尽映射 `SYNC_CHANNEL_LABEL_KEY`。
> - **通道卡不再自相矛盾**：事实行「同步状态」用的是**全局** `statusInfo.configured`（任一通道配过即为 true），而徽章用本通道判据 —— 只配了 git 时另外三张卡同时显示「未配置」+「已配置」。事实行改与本通道徽章同源。
> - **拉取失败不再弹绿色「拉取完成」**：宿主对校验不通过的快照仍回 HTTP 200 + `ok:false`，此前无条件报成功；现在按 `report.ok` 分流（与推送路径同口径）。
> - **推送预览不再混英文与裸分区 id**：`changed` / `unchanged` 进字典，分区名走同一个 `sectionLabeler`。
> - **同步状态加载失败不再永远显示「加载中…」**：补 `loadError` 分支，显示「加载同步状态失败」，与同屏顶部的红色横幅一致。
> - **市场加载失败不再被渲染成中性空态**：改为红色横幅（`redact` 后）+ 就地重试；错误原文此前被整个丢弃。
> - **首页不再把「读不到」说成「一切正常」**：5 个只读请求的失败此前被 `allSettled` 吞成 null，页面仍显示绿色健康点与「暂无操作记录」；现在有失败横幅（含失败项数与第一条原因，可重试），活动区区分「读取失败」与「没有记录」。
> - **产物库不再先亮「暂无备份文件」**：本机两源已就绪但为空、远端/市场仍在路上时，先给加载态而不是空态结论（已有行照旧原地渲染）。
> - **确认弹窗的后果说明进了无障碍树**：Modal 新增 `describedById` → `aria-describedby`，ConfirmDialog 关联可见正文；此前屏幕阅读器只播报标题（删除/回滚的后果不会被读出）。
> - **停止实例的确认改用 danger 语义**：它会中断该实例里正在跑的会话，此前与「删除不可恢复」在视觉上无法区分。
>
> **Eleven UX fixes from this audit round (session health / sync / market / home / library / confirm dialogs)** — all of them
> only change presentation and state feedback of existing features; no new features, no workflow changes.
> - **Session health stops printing machine codes**: 19 issue codes are mapped to zh/en labels with an "unrecognized issue"
>   fallback (never the bare code); the map is `src/ui/session-issue-labels.ts` and `satisfies Record<SessionHealthIssueCode, string>`
>   makes a missing mapping a compile error (`src/ui/session-issue-labels.test.ts`).
> - **Disconnecting a channel no longer names the wrong channel**: on the s3 / gist cards the confirmation used to say
>   "Git private repo"; it now uses the existing exhaustive `SYNC_CHANNEL_LABEL_KEY` map.
> - **Channel card no longer contradicts itself**: the "sync status" fact row used the **global** `statusInfo.configured`
>   while the badge used per-channel readiness; the fact row now shares the badge's per-channel source.
> - **A failed pull no longer shows a green "pull complete"** toast: the host still answers HTTP 200 with `ok:false` for a
>   snapshot that fails validation; the toast now branches on `report.ok`, matching the push path.
> - **Push preview no longer mixes English literals and raw section ids**: the labels live in the dictionary and section
>   names go through the shared `sectionLabeler`.
> - **A failed sync-status load no longer shows "loading…" forever**: an explicit failure text is rendered instead.
> - **Market load failures are no longer rendered as a neutral empty state**: an error banner (redacted) plus an inline
>   retry replaces it; the original error text used to be discarded.
> - **Home no longer reads "cannot load" as "all fine"**: failures of the five read-only requests were swallowed into null
>   while the page still showed a green health dot and "no activity yet"; there is now a failure banner (count + first
>   reason + retry) and the activity card distinguishes "read failed" from "no records".
> - **Library no longer flashes "no backup files"**: while remote/market sources are still in flight it shows a loading
>   state instead of an empty conclusion (already-loaded rows still render immediately).
> - **Confirm dialog consequences reach the accessibility tree**: Modal gained `describedById` → `aria-describedby` and
>   ConfirmDialog wires its visible message to it; screen readers previously announced only the title.
> - **Stopping a DSH instance now uses danger semantics** in its confirmation (it interrupts that instance's running
>   sessions), matching delete / rollback / disconnect.


> **第二轮审查的其余落地（客户端 / 核心 / 提示）**：
> - **保留清理不再可能删错目录**：快照目录名与 `snapshot.json` 里的 id 不一致时（手工改名 / 半截拷贝残留）**跳过并留痕**，绝不按内部 id 去删另一个目录。护栏：`src/core/backup.test.ts`。
> - **导出失败不再留明文临时 ZIP**：清理移进 `finally`（加密失败 / 磁盘满 / 超时都会清），加密产物改**原子落盘**（不再留一个名字正常的半截 `.zip`）。
> - **快照目录「读不出来」不再显示成「没有快照」**：`/snapshots` 回传 core 的 `out.unreadable`，产物库如实告警（新键 `library.snapshotsUnreadable`）；CLI 侧同一口径见 CLI 条目。
> - **删除被事故恢复引用的回滚点会被拒绝**：与自动保留清理的 F3 豁免同源；引用清单读不出来时**保守拒绝**（fail-closed），两种码在界面映射成本地化文案（绝不裸码上屏）。
> - **`files` 分区的 `relativePath` 逐项过 `isPathSafe`**（与 `patchFiles` 同级防线）：不可信 bundle 的路径穿越向量不再只靠 ZIP 条目名兜住。护栏：`src/schema/registry.test.ts`。
> - **同步 URL 内嵌凭据不再明文落 sessionStorage**：`redact()` 补 URL userinfo 形态（`https://oauth2:<token>@…`），落盘投影覆盖 `repoUrl` / `webdavUrl` / 推送与拉取报告。宿主本来就拒绝带 userinfo 的地址，因此**不改变任何合法输入的行为**。护栏：`src/security/redaction.test.ts`。
> - **会话体检的问题细节可见**：core 的 `issue.detail`（如「3 row(s)」/「seq 12→18」）进展示模型并脱敏，问题行悬停即可看到规模（此前 detail 完全不进 UI）。
> - **首页状态条放不下时换行**，不再隐藏横向滚动条（与导航条「隐藏滚动 = 不可发现」的既有教训一致）。
> - **高频进度落盘合并到 1s**（此前导入/同步轮询每 500ms 整份 `JSON.stringify` + 写 sessionStorage），`pagehide` 前强制 flush；sessionStorage 配额满时**首次失败可见提示一次**（此前静默，刷新即丢）。
> - **无障碍**：导航条补齐 ARIA tabs 语义（tab ↔ tabpanel 互指 `aria-controls` / `aria-labelledby`）；`Segmented` 降级为按钮组（`role=group` + `aria-pressed`）—— 它没有 tabpanel 容器，用 `role=tab` 会让读屏用户听到「标签页」却找不到面板。
> - **G-34 gist 提示落地**：gist 表单常驻说明（一次 GET 全量 / 单文件超限截断 / 文件数上限 ⇒ 大分区不适合），且「通道 = gist 且勾选 sessions」时出风险横幅。
>
> **Second audit round — everything else (client / core / hints)**: snapshot pruning can no longer delete the wrong directory
> (directory name ≠ internal id → skip with a warning); failed exports clean up their plaintext temp ZIP in `finally` and the
> encrypted output is written atomically; an unreadable snapshot directory is reported instead of shown as "no snapshots";
> deleting a snapshot that recovery still references is refused (fail-closed, localized codes); `files[].relativePath` is
> validated with `isPathSafe`; URL-embedded credentials are masked before they reach sessionStorage; session issue details are
> surfaced (redacted) on hover; the home status strip wraps instead of hiding its scrollbar; high-frequency progress persistence
> is coalesced to 1s with a visible first-failure notice; the nav has proper ARIA tabs semantics while `Segmented` is a button
> group; and the G-34 gist hints are visible in the form and as a risk banner.
>

> **CLI 与离线救急台（第二轮审查）**：
> - **`dcm restore` 补第三道写入门「本机没有 DSH 在跑」**：此前浏览器里被明确拒绝的动作，在终端能直接覆盖 `$DSH_HOME`（settings/plugins/workspaces 登记）。现在与救急台 `checkWriteGates` 同源同序（SAFE MODE → 环境锁 → DSH 未运行），拒绝时给出两条出路（先关 DSH，或改用 `dcm web` 救急台）；`--dry-run` 仍只打印计划（门只在真实执行前）。护栏：`src/cli/index-guards.test.ts` 的 G-06/G-07。
> - **`dcm snapshots` / `dcm restore` 不再把「快照目录读不出来」显示成「没有快照」**：传 core 的 `out.unreadable`，读不到时打印事实并让 `snapshots` 以非 0 退出（目录真不存在仍是「无快照」+ 0）。护栏：G-03/G-05。
> - **`dcm sessions doctor --json` 的 `ok` 与退出码同源**（`blocking === 0`）：此前恒 `true`，用 `jq .ok` 判健康的 CI/脚本会把「阻断启动 N 条」读成一切正常。
> - **`dcm sessions repair`：会话根存在但读不出来时明说「读不到 ≠ 没有会话」并 exit 1**（此前打印「无需修复」+ 0；`--json` 不再回 `ok:true`）。护栏：`src/cli/sessions-repair.test.ts` 的 RP-01/02。
> - **参数纪律**：`verify` 不再静默忽略 `--dry-run` / `--profile` / `--settings` —— 改为**按命令白名单**放行（`--dry-run` 只给 restore/reinstall/backup，`--profile` 只给 restore/web，`--id` 给 restore/verify），help 的 verify 段补 `--id` 与真实语义。
> - **`dcm web --data-dir` 的错位修掉**：此前只在 basename 命中 snapshots/exports 时对**那一条**取原值，另一条被拼到 leaf 下面；现在统一先算 root 再派生 snapshots/exports/locks/dataDir，help 补 `--data-dir` 的真实语义。
> - **救急台 404/405/错误页的「可用页面」清单改为从 `page.ts` 导航表派生**（此前三处硬编码互不一致，还把 JSON 端点 `/healthz` 当页面推荐）。
> - **救急台离线导出的 `manifest.exporter.version` 用真实版本**（此前写死 `'rescue-console'`，与 CLI 通路的真实版本口径不一致）。
> - **新增护栏**：`src/cli/web/console-route-parity.test.ts`（路由 `(method,path)` 双向快照 + 导航表 ↔ 路由集合双向一致 + 「可用页面」派生锚点）—— 这条正是上一条能长期存活的原因。
>
> **CLI and offline rescue console (second audit round)**: `dcm restore` now enforces the same "no DSH running" write gate as
> the rescue console (SAFE MODE → env lock → DSH stopped), with `--dry-run` still printing the plan only; `dcm snapshots` /
> `dcm restore` report an unreadable snapshot directory instead of "no snapshots" (non-zero exit); `sessions doctor --json`'s
> `ok` matches its exit code (`blocking === 0`); `sessions repair` says "cannot read ≠ no sessions" and exits 1 when the session
> root is unreadable; `verify` no longer silently ignores `--dry-run` / `--profile` / `--settings` (per-command flag allowlist);
> `dcm web --data-dir` derives all four directories from one root; the console's "available pages" hint is derived from the nav
> table; the offline export records the real exporter version; and a new route-parity guard pins all of it.
>

> **工作区快照的捕获边界不再整份读进内存、也不再静默丢弃**（t5-F1/F2 → 修复单 t13）：旧实现让**首个**文件因 `read > 0` 短路绕过字节上限（可把任意大文件整份 `fs.readFile` 进内存），且预算耗尽时直接 `break`，被丢的文件**不进** `skipped`（只剩一个 `truncated` 标记）。
> 现在：单文件上限 `maxFileBytes`（缺省 = 总量预算）**先 `stat` 判大小**，超限记 `too-large` 跳过；字节 / 文件数预算耗尽时其后**每一条**都进 `skipped`（`budget-bytes` / `budget-files`）；逐条列表另有上限（`maxSkippedEntries`，缺省 5000）但**只限记录条数** —— `skippedCount` 仍是真实总数，另置 `skippedTruncated`。`excludedDirs`（node_modules 等预期忽略）逐条记录、但**不计入** `skippedCount`、也不使点 degraded。
> - **被跳过的条目与计数已经到达用户（t18 已落地，2026-10-10）**：段级与预览行各带 `noticeKeys`，界面渲染 `rollback.row.notice.skipped` / `.truncated`（warn 徽章）与 `rollback.preview.notice.*`（行内提示），`rollbackPreviewWarnings()` 把 `rollback.warn.trackDegraded`（detail = `workspace capture-truncated`）一并带出；时间线的「文件数」只算**已收录**文件（被截断时更小，不再假装全收了）。证据 = **真实引擎产出的截断点驱动视图层**（`.tmp/probe-t8-skip.ts`：`noticeKeys=[rollback.row.notice.skipped, rollback.row.notice.truncated]` / `skippedCount=1` / `truncated=true`，fail=0）。
> - **护栏**：`src/core/rollback-point.test.ts` 的 R-21①–⑤（超限的首个文件 / 字节预算 / 文件数截断 / 标记与计数在列表·详情·预览三处如实回传 / 列表上限）。

> **Workspace capture no longer reads an oversized file into memory, and no longer drops files silently** (t5-F1/F2 → repair ticket t13): previously the **first** file bypassed the byte cap through the `read > 0` short-circuit (any size could be read fully into memory) and exhausting the budget hit a plain `break`, so dropped files never entered `skipped` (only a `truncated` flag remained).
> Now a per-file cap `maxFileBytes` (defaults to the total budget) is checked with `stat` **before** reading — anything larger is recorded as `too-large` and skipped; when the byte or file-count budget runs out, **every subsequent** file is recorded in `skipped` (`budget-bytes` / `budget-files`); the per-entry list has its own cap (`maxSkippedEntries`, default 5000) that limits **recorded entries only** — `skippedCount` stays the true total and `skippedTruncated` is set. `excludedDirs` (expected ignores such as node_modules) are recorded per entry but **not counted** in `skippedCount` and do not mark the point degraded.
> - **Skipped entries and counts now reach the user (t18 landed, 2026-10-10)**: segments and preview rows carry `noticeKeys`, the UI renders `rollback.row.notice.skipped` / `.truncated` (warn badges) and `rollback.preview.notice.*` (inline hints), and `rollbackPreviewWarnings()` surfaces `rollback.warn.trackDegraded` (detail = `workspace capture-truncated`); the timeline file count only counts **recorded** files (smaller when truncated — it no longer pretends everything was captured). Evidence: a **real engine-produced truncated point driving the view layer** (`.tmp/probe-t8-skip.ts`, fail=0).
> - **Guards**: R-21①–⑤ in `src/core/rollback-point.test.ts`.
### 🗑️ 移除 · Removed

> **三态检查点与手动拍点整体下线**：删除 config 第三态与 `samePointVerdictOf` 同点判定（`spreadMs` 只作为两态捕获时间的跨度事实回传，不再有「同点」结论）；删除手动「拍点」表单与
> `POST /recovery/checkpoints/capture` 子路径（留点改为按回合自动）；删除 `src/core/checkpoint.ts`、`src/ui/checkpoint-view.ts`、`src/client/recovery/CheckpointCard.tsx` 及其测试。

> **The three-state checkpoint and manual capture are gone**: the config third state and the `samePointVerdictOf` same-point verdict were removed (`spreadMs` is now only an honest fact about the two capture timestamps, with no verdict attached);
> the manual capture form and the `POST /recovery/checkpoints/capture` sub-path were removed (capture is per turn now); `src/core/checkpoint.ts`, `src/ui/checkpoint-view.ts`, `src/client/recovery/CheckpointCard.tsx` and their tests were deleted.

## [0.1.71] - 2026-10-08

> **本版主题：修「从其它 agent 导入」在 v4 桌面端整批丢会话** —— 外部来源的会话转码器此前只认 DSH 会话格式 v3，
> 而桌面端（0.2.0-rc.2）声明的是 v4，于是每一条历史对话都被 `session-format-unsupported` 跳过、产出的包里
> 根本没有 `sessions` 分区（用户看到的正是「历史对话不见了」）。现在**按目标机格式版本写出**：v3 目标写 v3、
> v4 目标写 v4（反向不可读，所以绝不一律写最高版本），并修掉会让 v3 产物被 v3→v4 迁移整份拒收的
> `session/title` 形状。两代产物均已用 DSH 自己的真 codec 逐条复验（`verified` / `strong` /
> `equivalentToReadPath` 全 true）。
>
> **Theme**: fix "import from other agents" dropping every session on a v4 Desktop build — the foreign-session
> transcoder only knew DSH session format v3 while the Desktop app (0.2.0-rc.2) declares v4, so every historical
> conversation was skipped as `session-format-unsupported` and the produced bundle carried no `sessions` section
> at all (the user-visible symptom was "my history is gone"). It now writes **the target's own format version**
> (v3 target → v3, v4 target → v4; reverse reads are unsupported, so it never blindly writes the highest), and fixes
> the `session/title` shape that made a v3-labelled artifact rejected wholesale by the v3→v4 migration. Both
> generations were verified row-by-row with DSH's own real codec (`verified` / `strong` /
> `equivalentToReadPath` all true).

### 🐛 修复 · Fixed

> **外部来源的历史会话导入在 v4 目标的 DSH 上整批消失（桌面端 0.2.0-rc.2 实测）**：DSH 桌面端声明的会话格式是
> **v4**，而外部来源的会话转码器只实现了 v3，宿主又如实把 v4 透传成 `targetSessionFormatVersion` ⇒ 每一条会话都被
> `session-format-unsupported` 跳过，产出的包里**根本没有 `sessions` 分区**，用户看到的是「历史对话不见了」
> （真机实测：`POST /foreign-import {source:"claude-code"}` → `sections:["mcp","skills"]`、`sessions.transcoded: 0`）。
> 现在支持 `[3, 4]` 并**按目标机版本写出**（v3 目标写 v3、v4 目标写 v4）—— 反向不可读（v3 主机读不了 v4 日志），
> 所以绝不一律写最高版本；读不到目标版本时仍旧**如实报码、一条都不转**（不猜）。
> 同时修掉一条**会让 v3 产物在 v4 主机上被迁移链整份拒收**的形状问题：`session/title` 原先停在 seq 0 且恒写
> `messageSeqs: []`，违反 DSH 的 `assertTitleSources`（空 **⟺** `source.kind === 'user'`；非空时每个 seq 必须
> **早于**本条事件且指向 `source.kind === 'user'` 的 `user/message`）。现在标题行插在首条人类消息**之后**并引用它
> （与真机日志同形：`{"seq":12,"messageSeqs":[7],"source":{"kind":"fallback"}}`）；整场没有人类消息时如实按
> `session-empty` 跳过，而不是编一条指不到人的引用。
> - **复验口径（2026-10-08 本机真 codec）**：逐条跑 `verifySessionLogBytes`，v3 档用本机 CLI 档案树的
>   `@deepseek-ai/dsh-session`、v4 档用桌面端 `app.asar` 内抽出的 `dsh-session-format-catalog` ——
>   两代产物均 `verified` / `strong` / `equivalentToReadPath` 全 true（修前 v4 档 strict 档报
>   `messageSeqs must be empty exactly for a user title`，且 v3→v4 迁移直接 `finish-failed` 拒收）。
> - **护栏**：`src/routes/foreign.test.ts`（路由层 v4 产包 + 「读不到版本仍不猜」并排钉住）、
>   `src/foreign/claude-sessions.test.ts`（v4 文件名/header 同步）、`src/foreign/session-ir.test.ts`（标题行三条规则）、
>   `src/foreign/claude-sessions-bytes.test.ts`（字节基线，变更理由写在 GOLDEN 上方）。
> - **行为变化（如实记）**：只有标题、没有任何消息的会话（如 Claude 只有 summary/attachment）从「产出只有标题行的
>   会话」变为 `skip:session-empty` —— 非 user 来源的标题引用不到任何人类消息，宁可如实跳过。
>
> **Foreign-agent session import silently dropped everything on a v4 DSH build (measured on Desktop 0.2.0-rc.2)**:
> the Desktop app declares session format **v4** while the foreign-session transcoder only implemented v3, and the host
> honestly forwards v4 as `targetSessionFormatVersion` — so every session was skipped as `session-format-unsupported`
> and the produced bundle contained **no `sessions` section at all** (measured: `POST /foreign-import {source:"claude-code"}`
> → `sections:["mcp","skills"]`, `sessions.transcoded: 0`). It now supports `[3, 4]` and writes **the target's own
> version** (v3 target → v3, v4 target → v4); writing the highest version unconditionally would break v3 hosts
> (reverse reads are unsupported), and an unknown target version still reports codes without transcoding anything.
> Also fixed a shape bug that made a v3-labelled artifact **rejected wholesale by the v3→v4 migration**: `session/title`
> sat at seq 0 with `messageSeqs: []`, violating DSH's `assertTitleSources` (empty **iff** `source.kind === 'user'`;
> otherwise every seq must be **earlier** than the event and cite a human `user/message`). The title row is now placed
> after the first human message and cites it (same shape as real logs), and a session with no human message is skipped
> as `session-empty` instead of fabricating an unresolvable reference.
> - **Verification (2026-10-08, real codec on this machine)**: every produced log was run through
>   `verifySessionLogBytes` — v3 against the CLI profile tree's `@deepseek-ai/dsh-session`, v4 against the catalog
>   extracted from the Desktop `app.asar` — `verified` / `strong` / `equivalentToReadPath` all true for both
>   (before the fix the v4 strict pass reported `messageSeqs must be empty exactly for a user title` and the v3→v4
>   migration refused the artifact outright).
> - **Guards**: `src/routes/foreign.test.ts`, `src/foreign/claude-sessions.test.ts`, `src/foreign/session-ir.test.ts`,
>   `src/foreign/claude-sessions-bytes.test.ts` (byte baseline with the reason recorded above it).
> - **Behaviour change (stated honestly)**: a title-only session (e.g. Claude with just a summary/attachment) now
>   reports `skip:session-empty` instead of producing a title-only conversation.

## [0.1.70] - 2026-10-07

> **本版主题：把「来源」与「通道」两头同时拓宽** —— 外部 agent 迁移来源一次从 6 个补齐到 30 个（新增统一会话 IR 层），
> 同步通道从 git / WebDAV 扩到 6 类云端点（S3 / OSS / COS / MinIO / Kodo / Gist）并支持直接选/新建私有仓库；
> 同时修掉本轮上报的 issue #69–#75 —— 其中一个是数据丢失级（`!!js` 方言让整层 patch 行从导出/同步里消失），
> 另有两个属于「报成功但其实没做成」（#71 备份不到外壳的 MCP / Skills、#73 一键同步永不收敛）。
>
> **Theme**: this release widens both ends of the pipe — foreign-agent import sources go from 6 to 30 (on a new
> shared session IR layer), and the sync channel grows from git / WebDAV to six cloud endpoints plus a
> private-repo picker. Reported issues #69–#75 are fixed, including a data-loss one (the `!!js` dialect silently
> dropped whole patch layers from export/sync) and two "reported success while nothing happened" bugs (#71, #73).

### 🆕 新增 · Added

> **外部 agent 迁移来源一次补齐到 30 个（+24）**：此前只认 6 个来源（Claude Code / Hermes / Cursor / Codex /
> Copilot / Antigravity），现在把生态里其余 24 个会话来源一并接进来：Gemini CLI、Reasonix、OpenCode、Mimocode、
> ZCode、Grok Build、OpenClaw、Pi、Kimi、Kilo Code、Qoder、ChatGPT、WorkBuddy、千问办公、Continue、Cline、
> Goose、DSH V4、Zed、Crush、TeleAgent、Trae、Vibe、DSH。新增统一的会话 IR 层（解析 → 中间表示 → 合成 → 编码），
> 每个来源只需写「读盘 + 转成草稿」两件事，不再各拼一遍 DSH 行格式。
> - **取证强度是类型上的必填字段**（`measured` / `fixture` / `documented`）——「只有文档落点却当成已验证列出」
>   在类型层就不可能悄悄发生；来源列表与 CLI 摘要都会说明每个来源凭什么被列出来。本批 24 个多数是 `fixture`
>   （夹具 + 单测端到端跑同一份布局，**真机未逐家验证**），如实标注、不美化。
> - **SQLite 类来源零副作用读取**：只读打开 WAL 模式的库仍会在**库所在目录**新建 `-shm` / `-wal` 伴生文件
>   （实测 32768 B / 0 B，close 后仍在）—— 那会写进**用户其它 agent 的数据目录**。现在按「库头 + 伴生文件大小」
>   分三态（直接读 / `immutable` / 复制到私有临时目录后读），**绝不退回就地打开**；`immutable` 只在能证明主库
>   完整时使用 —— 实测它在 `-wal` 非空时会**整条忽略 WAL（静默丢数据）**。
> - **路径按目标平台显式拼接**（不再读运行平台）；凭据值硬剥离（只留字段名与引用名）；读不到一律如实报码，
>   **绝不静默跳过**。
>
> **Foreign-agent import sources: 6 → 30 (24 added)**: the importer used to know 6 sources (Claude Code /
> Hermes / Cursor / Codex / Copilot / Antigravity); the remaining 24 session sources in the ecosystem are now
> wired in: Gemini CLI, Reasonix, OpenCode, Mimocode, ZCode, Grok Build, OpenClaw, Pi, Kimi, Kilo Code, Qoder,
> ChatGPT, WorkBuddy, Qwen Work, Continue, Cline, Goose, DSH V4, Zed, Crush, TeleAgent, Trae, Vibe, DSH.
> A shared session IR layer (parse → intermediate form → synthesize → encode) means each source only implements
> "read from disk + turn into a draft" instead of hand-assembling the DSH row format again.
> - **Evidence strength is a required, typed field** (`measured` / `fixture` / `documented`), so "listed as
>   supported although only documented" cannot happen silently — the source list and the CLI summary both say
>   what each source is listed on. Most of the 24 are `fixture` (fixture + unit test running the same layout,
>   **not verified per-source on a real machine**), labelled honestly rather than flattered.
> - **SQLite sources read with zero side effects**: opening a WAL-mode database read-only still creates
>   `-shm` / `-wal` companion files **in the database's own directory** (measured: 32768 B / 0 B, still there
>   after close) — which means writing into **another agent's data directory**. The open plan now picks between
>   three states based on the database header and companion-file sizes (read in place / `immutable` / copy to a
>   private temp directory first) and **never falls back to opening in place**; `immutable` is used only when the
>   main database can be proven complete — measured, it **ignores the entire WAL when `-wal` is non-empty
>   (silent data loss)**.
> - **Paths are joined explicitly for the target platform** (never the running one); credential values are
>   stripped to field names and reference names; anything unreadable is reported with a stable code and
>   **never silently skipped**.

> **同步通道新增 6 类云端点（S3 / OSS / COS / MinIO / Kodo / Gist）**：此前远端只有 git 与 WebDAV 两种。
> 通道枚举现在扩到四条（`git` / `webdav` / `s3` / `gist`），S3 一系覆盖 AWS S3、阿里云 OSS、腾讯云 COS、
> MinIO 与七牛 Kodo，外加 GitHub Gist；签名与请求头**手写实现、零新增依赖**（AWS SigV4 与阿里云
> `OSS4-HMAC-SHA256` 是两个不同方言）。界面上可直接选通道并填端点表单。
> - **走同一条同步引擎路径，不是旁路**：远端保留（GFS）、会话删除墓碑、内容寻址 blob 仓、「会话绝不悄悄下行」、
>   「导出密钥必须同时加密」等既有不变量对新通道**一条不放宽**（已用替身 transport 走真引擎逐条验证）。
> - **密钥只进 DSH 凭据槽位**：配置文件里只有非密字段（provider / endpoint / region / bucket / prefix）；
>   密钥值绝不进配置文件、不进响应、不进日志；断开通道时逐个槽位清除。
> - **gist 的能力边界（刻意设计，不是缺陷）**：gist 不外置 blob，且单文件超限会被截断 —— 它的定位是
>   「配置类分区的低门槛远端」；会话请走 git / WebDAV / S3。
> - 如实边界：**未对真实云端点做端到端验证**（本批无真实凭据），证据是单测与全量测试。
>
> **Six cloud endpoints for the sync channel (S3 / OSS / COS / MinIO / Kodo / Gist)**: remote storage used to
> be git and WebDAV only. The channel enum now has four entries (`git` / `webdav` / `s3` / `gist`); the S3 family
> covers AWS S3, Alibaba Cloud OSS, Tencent Cloud COS, MinIO and Qiniu Kodo, plus GitHub Gist. Signing and
> request headers are **hand-written with zero new dependencies** (AWS SigV4 and Alibaba Cloud's
> `OSS4-HMAC-SHA256` are two different dialects). The UI lets you pick the channel and fill in the endpoint form.
> - **Same sync engine path, not a bypass**: remote retention (GFS), session deletion tombstones, the
>   content-addressed blob store, "sessions never travel down silently" and "exporting secrets requires
>   encryption" are **not relaxed by a single one** for the new channels (verified by running the real engine
>   with a stub transport).
> - **Secrets live only in DSH credential slots**: the config file carries non-secret fields only
>   (provider / endpoint / region / bucket / prefix); secret values never enter the config file, a response or a
>   log, and disconnecting a channel clears each slot.
> - **gist's capability boundary (deliberate, not a defect)**: gist does not externalise blobs and truncates
>   files past GitHub's size limit — it is positioned as a low-barrier remote for configuration-class sections;
>   use git / WebDAV / S3 for sessions.
> - Honest boundary: **no end-to-end verification against a real cloud endpoint** (no real credentials this
>   round); the evidence is unit tests plus the full suite.

> **事故恢复新增「检查点」三态同点回滚**：会话游标 / 工作区文件块 / 插件自身配置三者各自留痕，并按同一
> 时点判断「是否同点」；覆盖式恢复**只覆盖记录在案的路径、绝不删除** —— 检查点之后新建的文件原样保留，
> 并列入 `leftovers` 回报。
> - 四道门：未确认不回滚（409 且磁盘一字未改）、保护点不可回滚、guard 记录不可删、会话分叉时拒绝覆盖。
> - **记录不可成为写原语**：台账与校验和不符、或路径越界时，目标与越界路径都**不被写**。
> - 如实边界：三态采集**非原子**（模块头已声明）；`capturedAt` 仅实例内单调，跨进程时间倒退会让「同点」
>   判定偏乐观；`workspace` 段的 `restored` 计数不按块递减。
>
> **Incident recovery gains three-state same-point checkpoints**: the session cursor, workspace file chunks and
> the plugin's own configuration each leave a record, and "same point" is judged across all three. An
> overwriting restore **only overwrites recorded paths and never deletes** — files created after the checkpoint
> are kept verbatim and reported as `leftovers`.
> - Four gates: no restore without confirmation (409 with the disk untouched), protected points cannot be rolled
>   back, guard records cannot be deleted, and a diverged session log refuses to be overwritten.
> - **A record can never become a write primitive**: when the ledger disagrees with the checksum, or a path
>   escapes the recorded set, neither the target nor the escaping path is written.
> - Honest boundaries: the three states are captured **non-atomically** (stated in the module header);
>   `capturedAt` is monotonic per instance only, so a cross-process clock going backwards makes "same point"
>   optimistic; the workspace section's `restored` counter does not decrement per chunk.

> **同步通道新增「选择已有仓库 / 新建仓库」**：git 通道的仓库地址此前只能手填 —— 得先去 GitHub 建好仓库、
> 复制 clone URL、再贴回来，还容易漏掉「必须私有」这条前提。现在配置弹窗可以直接从当前 token 可见的
> **私有**仓库里选（按最近更新排序，带更新时间与 fork 徽章），或就地新建一个私有仓库并自动选中。
> 公开仓库不进列表、也没有「公开」开关 —— 新建请求体根本不带 `private`，宿主恒定以私有建仓
> （同步仓库公开等于把配置内容公开）。地址输入框保留：ssh、本地路径、不在列表里的仓库仍可手填。
>
> **Repository picker for the sync channel**: the git channel's repository URL no longer has to be typed
> by hand (create the repo on GitHub, copy the clone URL, paste it back — and remember that it must be
> private). The channel dialog now lists the **private** repositories the current token can see (sorted by
> most recently updated, with a timestamp and a fork badge), or creates a new private repository inline and
> selects it. Public repositories are never listed and there is no "public" switch — the create request does
> not even carry `private`, because the host always creates private repos (a public sync repo would publish
> your configuration). The URL field stays: ssh remotes, local paths and unlisted repos are still typeable.

> **面板里就能做「布局归位 / 重复 id 隔离」（只做能从字节证明的事）**
> - 会话体检里新增写入口：**布局归位**（会话目录与首帧 cwd 不一致时，把目录搬到 `projectKey(首帧 cwd)` 该在的位置）与 **重复 id 隔离**（同一 id 出现在两个 projectKey 是启动级故障；由你点名保留哪一份，其余移入 `.cm-repair-quarantine-*` 隔离目录，可人工找回，**不删除**）。
> - 宿主走新增的 `POST /recovery/sessions/layout`（前缀 `/recovery` 下的子路由）：`apply!==true` 时**只读计划、零写入**；`apply===true` 时过 SAFE MODE + mutation lock，逐条门前置（无 `session.lock`、不在 30 s 静止期），**每次搬运后必须刷新会话索引，失败则把该条搬回原位并如实报 `rolledBack`**；宿主不提供刷新能力时**一条也不执行**（`reindex-unavailable`）。
> - 与离线 `dcm sessions repair --fix` 的差异**如实写进文案**：面板是**在 DSH 运行时**执行（CLI 要求先停 DSH），且不暴露路径映射 ⇒ 只搬目录、**不改写首帧**；另加两道 CLI 没有的护栏 —— 未点名 keep 的重复项**拒绝执行**（CLI 只是跳过）、keep 必须指向已扫描副本（CLI 把 `--keep` 指错路径会隔离**所有**副本）。
>
> **Layout relocation and duplicate-id quarantine, now from the panel (only what the bytes can prove)**
> - The session check-up gains a write entry: **layout relocation** (move a unit back to the projectKey its first-frame cwd names) and **duplicate-id quarantine** (you pick which copy to keep; the rest go to a `.cm-repair-quarantine-*` directory that can be recovered by hand — nothing is deleted).
> - The host side is a new `POST /recovery/sessions/layout` (a sub-route of the existing `/recovery` prefix): `apply!==true` is a **read-only plan with zero writes**; `apply===true` goes through SAFE MODE + the mutation lock, with per-item preconditions (no `session.lock`, not within the 30 s quiescence window) and **a mandatory index refresh after every move — if it fails the item is moved back and reported as `rolledBack`**; if the host cannot refresh the index, **nothing runs** (`reindex-unavailable`).
> - The differences from the offline `dcm sessions repair --fix` are stated in the UI: the panel runs **while DSH is running** (the CLI asks you to stop it) and does not expose path mappings, so it only moves units and **never rewrites the first frame**. It also adds two guardrails the CLI lacks: a duplicate id without an explicit keep is **refused** (the CLI merely skips it), and keep must name a scanned copy (CLI's `--keep` with a wrong path quarantines **every** copy).

> **复验门（真 codec）在离线场景也能拿到官方 catalog：asar 抽取成为候选锚**
> - 此前复验门的 catalog 只在「DSH 安装树 + 同级/嵌套 node_modules」两种布局里找；桌面端把 `@deepseek-ai/dsh-session` 放在 `app.asar` 内，于是离线 CLI / 救急台的复验恒 `unavailable`（**不是失败，但也不等于已验证**）。现在把 asar 抽取接成**候选锚**，且版本与 catalog 的候选规划共用同一条锚点链（安装锚 → 环境锚 → 运行时锚 → profiles 树），避免「版本从一个锚、catalog 从另一个锚」的自证。
> - 读不出来仍然如实报 `unavailable`（`verify.verified=false`，不写成功台账）；抽出的目录是临时物，不改动安装树。
>
> **The verify gate (real codec) now reaches the official catalog offline, via an asar extraction anchor**
> - The gate used to look for the catalog only in the DSH install tree and its sibling/nested `node_modules`; the desktop build keeps `@deepseek-ai/dsh-session` inside `app.asar`, so offline CLI / rescue-console verification was always `unavailable` (not a failure — but not "verified" either). Asar extraction is now a **candidate anchor**, and version resolution and catalog planning share one anchor chain (install anchor → env anchor → runtime anchor → profiles tree) so they cannot certify each other from different anchors.
> - If it still cannot be read, the result stays an honest `unavailable` (`verify.verified=false`, no success ledger), and the extracted tree is temporary — the installation is never modified.

### 🔧 变更 · Changed

> **两处「静默」改成可见**：① 快照现在记录导出时的 DSH 版本，版本不匹配时恢复计划里多一条**咨询性提示**
> （不阻断、也不猜版本）；② 会话导出探测此前只看状态码，而官方 `GET /api/session.export` 在服务缺失时
> 返回 **500（不是 501）** —— 于是「服务没装」与「服务在但没正文」被混为一谈。现在探测读有限字节正文，
> 三态（可用 / 不可用 / 未知）各自可辨，且**不消耗完整响应体**（有上限 + 主动断开，并有可失败断言钉住）。
>
> **Two silences turned visible**: (1) snapshots now record the DSH version they were exported from, and a
> version mismatch adds an **advisory** entry to the restore plan (non-blocking, and the version is never
> guessed); (2) the session-export probe used to look at the status code only, while the official
> `GET /api/session.export` returns **500 — not 501 — when the service is missing**, conflating "service not
> installed" with "service present but no body". The probe now reads a bounded amount of body, so the three
> states (available / unavailable / unknown) are distinguishable, and it **does not consume the full response**
> (there is a cap plus an active abort, pinned by a failable assertion).

> **面板说明文案不再许诺做不到的事（会话体检那行描述）**
> - old 文案说「其余损坏类别仍只能走离线 CLI」，既漏掉了最严重的「会让 DSH 起不来」档，也不准确：离线 CLI 只做**隔离重复 id**与**归位错位目录**两类，容器/首帧读不出来、格式超前、未登记工作区、子代理缺父**离线也修不了**。现在逐档点名四档严重级（会让 DSH 起不来 / 会话读不出来 / 下次请求会失败 / 看不见），把应用内能力如实分成**两类**（零损失：重放重复行、可证明的合成收尾块；有损：序列空洞、不可解析行，**必须逐条显式确认、绝不批量**），并给出「其余类别」的三条真实出路（面板内已可做的布局归位 / 重复 id 隔离、离线 `dcm sessions repair --fix`、以及**本工具不修**需人工处置）。
> - 离线救急台的页面正文也曾渲染字面 `\*\*`（导出页走 `esc()`，星号原样显示给用户）；该处去标记并写明原因，同时把「各页正文无字面 `\*\*`」的渲染级断言**扩到全部 12 个页面**（此前用例名说「各页」却只覆盖 7 页 —— 断言宽于覆盖同样是缺陷）。
>
> **The panel no longer promises what it cannot do (the session check-up description)**
> - The old line said "the remaining corruption classes are only reachable through the offline CLI". It missed the most severe level (would block DSH startup) and was also wrong: the offline CLI only quarantines duplicate ids and relocates misplaced directories — unreadable containers/first frames, future formats, unregistered workspaces and subagents without a parent **cannot be repaired offline either**. The text now names all four severity levels, splits the in-app ability honestly into **two classes** (lossless: replayed duplicate rows and provable synthetic closers; lossy: seq gaps and unparsable rows, each requiring explicit confirmation and never batched), and gives the three real destinations for everything else (the in-panel layout relocation / duplicate-id quarantine, the offline `dcm sessions repair --fix`, and **not repaired by this tool**).
> - The offline rescue console also rendered literal `\*\*` in a page body (the export page banner goes through `esc()`, so the markers showed up verbatim); that site is de-marked with the reason recorded, and the render-level "no literal `\*\*` in any page body" assertion now covers **all 12 pages** (the case name claimed "every page" while only 7 were covered — an invariant asserted wider than its coverage is a defect too).

> **「布局归位 / 重复 id 隔离」入口不再被藏起来（扫过之后始终可见）**
> 这个入口原先只在**有候选行**时渲染：本机没有这一档问题（真机 1218 个会话单元全为 `already-placed`）的用户打开会话体检只看到「没有要修的东西」，**根本不知道有这个入口** —— 构建产物里明明有它。现在可见性判定收进 `src/ui/session-layout-view.ts` 的 `sessionLayoutSectionState`（`hidden` = 还没扫过 / `empty` = 扫过但本机无此档 / `ready` = 有候选或有计划结果），**扫过之后始终渲染**并显示空态说明；有计划/结果在手时更不会消失（否则刚做完的逐条结果会被吞掉）。空态文案 `sessions.layout.noCandidates` 的 zh/en 两个键是本次补的（此前并不存在）。
>
> **The layout-relocation entry is no longer hidden (always visible once scanned)**
> It used to render only when there were candidate rows, so a machine with none (all 1218 units on the reporting machine are `already-placed`) showed just "nothing to fix" — users **could not tell the entry existed** even though it was in the build. Visibility now lives in `sessionLayoutSectionState` (`hidden` = not scanned yet, `empty` = scanned but nothing in this class, `ready` = candidates or a plan/result in hand); the section **always renders once a scan has run** and explains itself in the empty state, and it never disappears while a plan/result is on screen (otherwise the just-finished per-item results would be swallowed). Both `sessions.layout.noCandidates` strings are new.

### 🐛 修复 · Fixed

> **本轮收尾：平台矩阵三端全绿 + 链接跟随不再按平台丢内容**：三个 PR 合入后补掉的都是
> 「报成功但结果不对」这一类问题 —— 备份在部分平台静默缺内容、CI 在部分平台假红。
>
> - **递归遍历的 realpath 口径混用（issue #69）**：链接目标用 `realpath` 的长形式，而 `homeDir`
>   一直是调用方给的原样字符串 —— 两侧拼写不一致时，「home 内部的链接」会被判成 `outside-home` 并
>   **静默跳过**（macOS 的 `/var` → `/private/var`、Windows 的 `C:\Users\IUUUUU~1\…` 短名都是触发
>   条件），备份照报成功却缺内容（与 issue #37 同一症状）。现在边界比较两侧统一到 realpath 口径，
>   并复用同一次结果做防环去重。
> - **CRLF 检出下 5 条源码字面量守卫假红（issue #70）**：仓库根新增 `.gitattributes`
>   （`* text=auto eol=lf`）把 EOL 钉死，ubuntu / windows / macOS 三端检出同一份字节；三处守卫在
>   **读取入口**折 LF（与仓库既有 11 处先例同法），已有的 CRLF 工作区不重新检出也不再假红。
> - **POSIX 宿主上的预览体积用例**：新增用例把 mock home 固定成 win32 形状，而路径解析走宿主的
>   `path.resolve` —— linux / macOS 上它被解析到 `cwd` 之下，体积断言恒为 0；改为按宿主平台选 home 形状。
>
> **Wrap-up: the platform matrix is green, and linked content is no longer dropped by platform**: every
> defect closed after this batch reported success while being wrong.
>
> - **Directory traversal mixed two path spellings (issue #69)**: link targets were compared as
>   `realpath` long forms while `homeDir` kept the caller's spelling, so in-home links were judged
>   `outside-home` and **silently skipped** (macOS `/var` → `/private/var`; Windows 8.3 short names such
>   as `C:\Users\IUUUUU~1\…`) — backups reported success while missing content, the same symptom as
>   issue #37. Both sides of the boundary check now compare in realpath form, reusing that result for
>   cycle detection.
> - **Five source-literal guards failed on CRLF checkouts (issue #70)**: a new `.gitattributes`
>   (`* text=auto eol=lf`) pins EOL so ubuntu, windows and macOS check out the same bytes; three guards
>   normalise to LF at the read boundary, so an existing CRLF worktree no longer goes red without a
>   re-checkout.
> - **A preview-size test assumed Windows path semantics**: the test pinned its mock home to a win32
>   shape while path resolution uses the host's `path.resolve`, so on linux / macOS it resolved under
>   `cwd` and the size assertion was always 0; the home shape now follows the host platform.

> **导出/同步不再丢 `!!js`，pnpm 隔离安装也能识别会话格式版本（issue #75 / #74）**
> - **`cordis.patch.yml` 的 `!!js` 方言（issue #75，数据丢失级）**：`!!js` 是 DSH 的专用 YAML 标签（`JSON_SCHEMA` + `tag:yaml.org,2002:js`），而插件此前用缺省 schema 读它 —— 遇到 `!!js` 直接抛 unknown tag，被吞成空数组。后果不止「丢一条配置」：解析针对整份文档，**只要该层有一处 `!!js`，这一层全部 patch 行都会从导出 / 同步 / 预览里消失**；导入写回时更会把整份文件重写成「只剩本次导入的行」。现在读写统一走新的方言单一事实源（`raw` 的内存形态是 `{__jsExpr: <源码>}`，普通 JSON、写回还原成 `!!js`），并补两道护栏：**原文件存在却解析不了 / 读不到时拒绝覆盖**、解析失败上抛成可见告警（不再静默）；文件不存在仍按「本来就没有」处理。
> - **pnpm 隔离安装的会话格式版本解析（issue #74）**：pnpm 全局安装 DSH 时 `installAnchor` 落在 `.pnpm` 存储段内，同级没有 `dsh-session`（`dsh` 的依赖里也没有它），旧的「同级 / 嵌套两种布局」必然落空 → 每次启动报 warn、导入与同步的「格式超前」体检整体跳过。现在会向上定位最近的 `.pnpm` 并按 `@deepseek-ai+dsh-session@*` 扫段（多版本取与本机 dsh 同版本者，判不准则不猜），失败时把**已尝试的路径**写进日志；同一份布局推导已收敛为单一实现（复验门与档案列表共用）。
>
> **No more lost `!!js` on export/sync; pnpm-isolated installs resolve the session format version (issues #75 / #74)**
> - **The `!!js` dialect of `cordis.patch.yml` (issue #75, data loss)**: `!!js` is DSH's own YAML tag (`JSON_SCHEMA` + `tag:yaml.org,2002:js`), but the plugin read the file with the default schema — hitting `!!js` threw an unknown-tag error that was swallowed into an empty array. The damage was bigger than one missing config: parsing covers the whole document, so **a single `!!js` anywhere made every patch row of that layer disappear from export / sync / preview**, and importing rewrote the file down to just the imported rows. Read and write now share one dialect source of truth (`raw` keeps the JSON-safe `{__jsExpr: <source>}` shape and is written back as `!!js`), plus two guard rails: **an existing file that cannot be parsed or read is never overwritten**, and parse failures surface as visible warnings instead of silence; a missing file still means "nothing there yet".
> - **Session format version under a pnpm-isolated install (issue #74)**: with a global pnpm install the `installAnchor` sits inside a `.pnpm` store segment whose siblings have no `dsh-session` (and `dsh` does not depend on it), so the old two-layout lookup always missed → a startup warning on every boot and the import/sync "format ahead" check skipped entirely. The resolver now walks up to the nearest `.pnpm` and scans `@deepseek-ai+dsh-session@*` segments (preferring the version matching the local dsh; never guessing when ambiguous), and logs the paths it tried on failure. The same layout derivation is now a single implementation shared with the verify gate and the profile list.

> **M1 会话修复引擎加固：拆掉一个会毁数据的陷阱 + 装上真 codec 复验门与只读检测**
> 一条 v0 打包行的判据错误，让 1194 份真机会话日志里的 **407 份**被判成「需要损失性修复」；按该计划执行会丢弃 **865,098 / 876,680 行（98.7%）**。本轮修掉这个判据，并把「写前复验」「有损预览」「引用闭包」「只读检测」四道护栏补齐。
> - **packed 行假空洞（真机 407 例）**：v0 打包行（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）**没有 `seq` 成员**，一行按 `seq0` + payload 展开成 N 个事件（官方 `decodePackedRun`：`firstSeq = seq0`、`eventCount = payload.length`）。旧判据只读 `seq` → 打包行被当成「无 seq 行」跳过却保留上一个 `lastSeq`，于是打包行之后的第一条标量行被误判为 seq 空洞。真机：**lossy-required 407 / nothing-to-fix 787**；407 份**全部是 v0 代际**日志（`session.jsonl.zstd`，header `version:0`），v3/v4 零误判。复核脚本 `.tmp/probe-session-repair.mjs`。
> - **判据分两层，不得混同**：(i) **形状不可判定**（缺 `seq0` / 载荷非数组 / 长度非安全整数 / `dt` 长度 ≠ len-1 / 带严格键集外成员 / 无 `seq0` 的未知非 packed 类型）→ 视为**不透明跨度**，禁止跨越它下连续性结论，计划 refuse；(ii) **形状可判定但 `seq0` 与运行计数不衔接** → 这是**真实 seq 空洞**，与标量行空洞同待遇（默认 refuse；显式 `allowLossy` 才在首个异常处截断）。把它当 opaque 会让同一种语义因前一行的物理编码不同而有两种待遇。
> - **帧粒度规则**：`≤200 行/帧` 只约束**本次重编码**的帧；**未触及帧（帧内无被丢行且全部保留）必须逐字节复用**，即使它原本超过 200 行 —— 真机有 **226 个事件帧 >200 行、最大 8654 行**，那是 DSH 自己写出的形态，字节保真优先于自定上限。
> - **真 codec 复验门**：写后（以及有损计划应用前）用 DSH 官方 `createSessionFormatCatalogWithChildren` + 逐行 `decodeRow` + `finish` 复验；**能力不可用 → `unavailable`（unverified）且绝不宣称成功**；**确定性失败 → 用备份自动回滚**；`unavailable` **不触发回滚、不写成功台账**、但**仍写台账**以保证已应用的修复可回滚。
> - **有损计划预览可见**：`lossy-required` 的计划必须给出真实的 `truncate-tail` 条目与丢弃行数（旧实现给的是空动作清单 —— 用户被告知「需要损失性修复」却说不出将丢什么）。
> - **引用闭包闸门**：closer-drop 候选若被保留行引用 → **不计划该动作**（零损动作优雅降级）；截断造成「引用目标由存在变不存在」→ **在 planner 内整体 refuse**（不允许「先给 lossy 预览、再在 apply 期拒绝」）。
> - **只读检测扩展**：会话体检新增 `empty-tool-call-id` / `duplicate-tool-call-id` / `tool-result-id-mismatch` 三个码，并让 `missing-message-id` / `dangling-tool-call` 真正产出；严重级按**代际 + 载体**分级（v4 与 pre-v4 下缺 message id、空 tool-call id、重复通告同一 advertised tool call 都是**前台读盘管线拒读** → `unloadable`；版本读不出 → `nextRequestFails` + `codec-uncalibrated`）。**只报不修**。
> - **CLI / 离线救急台如实反映 verify 三态**：现役可读 / 迁移链可还原 / 未验证 —— 不再把「写完了」说成「已可加载」。
> - **口径（不得夸大）**：① 修掉 packed 误判 **≠** 这些 v0 日志变得可读 —— 真 codec 对 407 份复验 = **405 失败 / 2 通过**，失败原因是 v0→v1 迁移拒绝（`summary requires notice form` / `unsupported descriptor version 2` / `unclassified message source`），与 seq 无关；那 2 份的正确表述是「**可被迁移链还原**」，不是「DSH 能直接读」（官方 `resolveCurrentLog`：pre-v4 没有「当前日志」）。② 其中 `session-66add64c-…`（1160 行）**正是会被旧的有损路径毁掉的那一份**（现状 `allowLossy` 只留 23 行、丢 1137 行）—— 这是本轮最强的修复动机。③ **本轮收益为零的事实要如实说**：修复执行覆盖 **0**（真机修复计划恒为 `nothing-to-fix`）、新增只读检测真机命中 **0**、真 codec 门的真机覆盖有限（本机最新代际 < v4 占 **80.67%**，默认解析下多为 `unavailable`）。它是「拆陷阱 + 装护栏与闸门」，**不是**「修好了一批会话」。
> - 数字口径（2026-10-06 真机快照）：units **1195**（日志 **1194**），最新代际 {v0: **442** / v3: **522** / v4: **231**}，`KNOWN_SESSION_EVENT_TYPES.size = **59**`，`SESSION_FORMAT_VERSION = **4**`。
>
> **M1 session-repair hardening: removing a data-destroying trap and adding a real-codec verify gate plus read-only detection**
> One wrong judgement about a v0 packed row made **407 of 1194** real session logs look like "lossy repair required"; executing that plan discards **865,098 / 876,680 rows (98.7%)**. This round fixes the judgement and adds four guard rails: pre-write verification, lossy preview, reference closure, and read-only detection.
> - **Packed-row phantom gaps (407 real cases)**: v0 packed rows (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) carry **no `seq` member**; one row expands into N events via `seq0` + payload (official `decodePackedRun`: `firstSeq = seq0`, `eventCount = payload.length`). The old judgement read only `seq`, skipped packed rows while keeping the previous `lastSeq`, and therefore reported the first scalar row after a packed run as a seq gap. Real machine: **lossy-required 407 / nothing-to-fix 787**, and all 407 are **v0-generation** logs (`session.jsonl.zstd`, header `version:0`); v3/v4 have zero false positives. Probe: `.tmp/probe-session-repair.mjs`.
> - **Two judgement layers, never conflated**: (i) **undecidable shape** (missing `seq0` / payload not an array / non-safe-integer length / `dt` length ≠ len-1 / extra members outside the strict key set / unknown non-packed type without `seq0`) → an **opaque span**; never draw a continuity conclusion across it, and refuse the plan; (ii) **decidable shape whose `seq0` does not line up with the running count** → a **real seq gap**, treated exactly like a scalar-row gap (refuse by default; truncate at the first anomaly only under explicit `allowLossy`). Treating (ii) as opaque would give one semantic two different verdicts depending on how the previous row happened to be encoded.
> - **Frame granularity**: `≤200 rows/frame` constrains only frames **this run re-encodes**; **untouched frames (no dropped row inside, everything kept) must be reused byte-for-byte**, even when they were larger than 200 rows — the real machine has **226 event frames above 200 rows, the largest 8654 rows**, and those are shapes DSH itself wrote. Byte fidelity beats a self-imposed cap.
> - **Real-codec verify gate**: after writing (and before applying a lossy plan) the log is re-verified through the official `createSessionFormatCatalogWithChildren` + per-row `decodeRow` + `finish`; **capability unavailable → `unavailable` (unverified), never reported as success**; **deterministic failure → automatic rollback from the backup**; `unavailable` **does not roll back and does not record a success ledger entry**, but **still writes the ledger** so repairs that were applied remain rollback-able.
> - **Lossy plans are visible before they run**: a `lossy-required` plan must carry the real `truncate-tail` entry and the number of rows it would drop (the old implementation returned an empty action list, telling users a lossy repair was needed without saying what would be lost).
> - **Reference-closure gate**: a closer-drop candidate referenced by a kept row is **not planned** (a zero-loss action degrades gracefully); a truncation that turns a referenced seq from "present" into "missing" makes the planner **refuse outright** (no "show a lossy preview, refuse at apply time").
> - **Read-only detection**: session health gains `empty-tool-call-id` / `duplicate-tool-call-id` / `tool-result-id-mismatch`, and `missing-message-id` / `dangling-tool-call` are actually produced. Severity is classified **per generation and per carrier** (on v4 and pre-v4 a missing message id, an empty tool-call id, or a repeated advertised tool call is rejected by the **foreground read pipeline** → `unloadable`; an unreadable version → `nextRequestFails` + `codec-uncalibrated`). **Reported, never repaired.**
> - **CLI / offline rescue console report the three verify states honestly**: readable-now / restorable-through-the-migration-chain / unverified — "the write finished" is no longer presented as "it loads".
> - **Non-negotiable wording**: ① fixing the packed-row judgement does **not** make those v0 logs readable — the real codec verifies **405 failures / 2 passes** out of 407, and the failures are v0→v1 migration refusals (`summary requires notice form` / `unsupported descriptor version 2` / `unclassified message source`), unrelated to seq; the 2 passes are correctly described as "**restorable through the migration chain**", not "DSH can read them directly" (official `resolveCurrentLog`: pre-v4 has no "current log"). ② One of them, `session-66add64c-…` (1160 rows), **is exactly the file the old lossy path would have destroyed** (it kept 23 rows and dropped 1137) — the strongest motivation for this round. ③ **Say the zero-benefit facts out loud**: repair execution coverage is **0** (real-machine repair plans are always `nothing-to-fix`), the new read-only detection hits **0** real cases, and the real-codec gate has limited real coverage (on this machine **80.67%** of units have a newest generation below v4, which resolves to `unavailable` by default). This round removed a trap and installed guard rails — it did **not** fix a batch of sessions.
> - Number baseline (real-machine snapshot, 2026-10-06): units **1195** (logs **1194**), newest-generation split {v0: **442** / v3: **522** / v4: **231**}, `KNOWN_SESSION_EVENT_TYPES.size = **59**`, `SESSION_FORMAT_VERSION = **4**`.

> **全仓对抗审计修复**：本轮对**整仓**做了一次对抗性审计（七个区域审计 + 三轮横向扫查 + 每个修复配独立验证），
> 收敛出 **44 项缺陷：40 项闭环、5 项部分闭环、2 项等第三方写者落盘后复扫**。修的主要是**静默数据风险**，
> 而不是看得见的报错。
>
> - **同步上传不再把「远端索引 404」当成空集合**（WebDAV + S3）：此前会把远端**仍被引用**的 blob 当成
>   无人引用而回收 —— **不可恢复**。现在写任何字节之前先自证远端有无历史内容：有证据就中止并说明，
>   全新远端首次推送行为逐字不变，探针读不到一律按「有内容」处理（fail-closed）。
> - **「读不到」不等于「没有」**（三处同族）：只有真不存在（ENOENT）才算「本来就没有」，权限 / 占用 / IO
>   错误一律按「存在」处理。此前一次瞬时 EACCES 会让声明的 `patchedDependencies` 被从**将要写入的**
>   `pnpm-workspace.yaml` 里剔除（issue #35 的症状）。
> - **S3 / gist 的错误提示不再显示裸键名**（18 + 16 个键）：传输层的本地文案键与宿主的翻译器互不认识，
>   真机弹的是 `sync.s3.requestFailed` 这类键名。
> - **MCP 的 `args` / `url` / `command` / `cwd` 不再进包**，凭据泄漏面收窄；条数触顶与文件过大的
>   **截断不再静默**，一律计数并回传。
> - **导入时用户取消勾选的会话不再被算作「搬迁失败」** —— 此前会 no-op 地触发整笔导入回滚。
> - **恢复面板把「枚举失败」与「确实没有残留」区分开**：失败可见、可重试，但不再让整页失败。
> - **同 id 工作区记录归并不再抛 `TypeError`**（畸形 `sessionIds` 元素），校验补上元素级检查。
> - **脱敏口径统一**：`bearer` 按 RFC 7235 / 6750 **大小写不敏感**（规范 `Bearer …` 的行为逐字不变），
>   且 `sk-` 不再误剥 `task-management` / `risk-assessment` 这类正常词，同时不削弱对真实密钥形态的检出。
> - **同一语义不再有两套实现**：`redact()` 与扫描器共用同一张值形状表（另加防漂移守卫），
>   宿主与客户端的同构常量收敛到**零依赖单一来源**。
> - **文档与计数不再漂移**：路由计数订正为 **77 = 70 + 7** 并加了散文守卫；`AGENTS.md` 的容量余量
>   从 96 B 提到 2,384 B。
> - 🧪 **验证**：完整树上 `typecheck` / `typecheck:tests` / `build` 全 0；`npm test` **3690 例 / 3688 通过 /
>   0 失败 / 2 跳过**（相对基线 +246 例、零新增失败）；客户端产物自包含守卫 1/1；真机隔离实例
>   **7/7 关键路由 200**、界面数字与磁盘事实逐项一致。
>
> **Repository-wide adversarial audit**: this round audited the **whole repository** (seven area audits plus
> three horizontal sweeps, with an independent verifier for every fix) and converged on **44 defects:
> 40 closed, 5 partially closed, 2 awaiting a third-party writer**. Nearly all of them were **silent data
> risks**, not visible errors.
>
> - **A remote index 404 is no longer treated as an empty set** on sync upload (WebDAV + S3): blobs that were
>   still referenced could be garbage-collected — **irrecoverably**. The upload now proves the remote has no
>   prior content before writing a single byte: with evidence it aborts and says so, a genuinely fresh remote
>   behaves exactly as before, and an unreadable probe counts as "has content" (fail-closed).
> - **"Cannot read it" is not "it is not there"** (three places in one family): only ENOENT means "never
>   existed"; permission, busy and IO errors count as "it exists". A single transient EACCES used to drop a
>   declared `patchedDependencies` entry from the **about-to-be-written** `pnpm-workspace.yaml` (the issue #35 symptom).
> - **S3 and gist error messages no longer show raw keys** (18 + 16 keys): their local catalogs were unknown to
>   the host translator, so users really saw `sync.s3.requestFailed`.
> - **MCP `args` / `url` / `command` / `cwd` no longer reach the bundle**, narrowing credential exposure, and
>   truncation (too many entries, oversized files) is **no longer silent** — it is counted and reported.
> - **Unchecked sessions are no longer reported as a failed relocation**, which used to trigger a full rollback for nothing.
> - **The recovery panel separates "enumeration failed" from "there is genuinely nothing left"**: visible,
>   retryable, and no longer fatal to the page.
> - **Merging duplicate workspace records by id can no longer throw `TypeError`** on malformed `sessionIds`
>   elements, and validation now checks element types.
> - **One redaction rule set**: `bearer` is **case-insensitive** per RFC 7235 / 6750 (canonical `Bearer …` is
>   byte-for-byte unchanged), and `sk-` no longer strips ordinary words such as `task-management` /
>   `risk-assessment` while every real key form stays detectable.
> - **No more two implementations of one rule**: `redact()` and the scanner share one value-shape table (with
>   anti-drift guards), and the host/client duplicate constants collapse into a **zero-dependency single source**.
> - **Documentation and counters no longer drift**: the route count is corrected to **77 = 70 + 7** with a prose
>   guard, and `AGENTS.md` headroom went from 96 B to 2,384 B.
> - 🧪 **Verification**: on the complete tree `typecheck` / `typecheck:tests` / `build` all exit 0; `npm test`
>   **3690 tests / 3688 passing / 0 failing / 2 skipped** (+246 vs baseline, zero new failures); the client
>   bundle self-containment guard passes 1/1; a real isolated instance served **7/7 key routes with HTTP 200**
>   and every UI number matched the on-disk facts.

> **性能修复**：本轮修的是**「总览」页每次都要等十几秒到半分钟**的问题 —— 根因是首屏把只读预览
> 也当成了真实导出，并且一次预览里叠加了三处重复的全量读取。真机（24 个 settings namespace、
> 12 个本地源插件）实测：全量预览 27.6 s → 现在首屏不再等它。
>
> - **预览不再打包本地插件**：`plugins` 分区此前没有 `preview()`，调用方退回 `export()`，
>   于是每次打开「总览」都会为每个 `link:`/`file:` 插件 spawn 一次 `npm pack`
>   （真机 12 个 ≈12 s）。现在 `PluginsAdapter.preview()` 只读清单、patch 行、pnpm-workspace 与
>   patch 文件，**零进程副作用**；本地源体积改为**零 spawn 只读度量**（`file:` 源按一次 `stat`；
>   `link:` 目录走新增的宿主门面 `FileSystemFacade.dirSizeBytes()` —— 跳过 `node_modules`、不跟随
>   链接目录，给出的是 pack 产物的量级上界），单元清单与导出产物逐项同口径（含 `fileCount` 与原子组）。
> - **settings / credentialsStatus 只读一趟**：宿主 `SettingsProvider.describe()` 是「无参 = 全量」，
>   逐个 namespace 调用实际是 O(N²)（真机 24 个 ≈1.7 s，两个分区各来一遍）。新增可选能力
>   `SettingsFacade.describeAll()`，适配器一次读回全部 namespace 再本地取用；宿主未实现或调用
>   抛错时逐字退回原路径，告警文案不变。
> - **总览页首屏不再等预览**：`HomePanel` 拆成「5 个毫秒级只读接口」与「分区构成」两段，
>   首屏不再被最慢分区拖住；分区构成卡改为**始终渲染**，数据未到先显示骨架（`读取中…`），
>   失败显示 `读取失败 · 将整体导出`，合计位在未到货时显示加载态而不是 0。
>
> **Performance**: the Overview page no longer makes you wait. Three separate causes were stacked into
> one first paint: the read-only preview was running the real export path, and two sections re-read every
> settings namespace once per name.
>
> - **Preview no longer packs local plugins**: the `plugins` section had no `preview()`, so the caller fell
>   back to `export()` and spawned one `npm pack` per `link:`/`file:` plugin (~12 s on a real machine with
>   12 local sources) every time the Overview opened. `PluginsAdapter.preview()` is now side-effect free;
>   local source sizes are measured read-only without spawning anything (`file:` sources by a single `stat`;
>   `link:` directories through the new host facade `FileSystemFacade.dirSizeBytes()`, which skips
>   `node_modules` and never follows linked directories and is an order-of-magnitude upper bound on the pack
>   output), and its unit list matches the exported one item for item.
> - **settings / credentialsStatus read once**: the host `describe()` is "no argument = everything", so
>   calling it per namespace is O(N²) (24 namespaces ≈1.7 s, twice per preview). A new optional
>   `SettingsFacade.describeAll()` reads them all in one call; hosts that lack it (or that throw) fall back
>   to the old per-name path with identical warnings.
> - **The Overview first paint no longer awaits the preview**: `HomePanel` now loads the five fast read-only
>   APIs first and the section composition separately. The composition card always renders, showing skeleton
>   rows (`Loading…`) until the data arrives and `Load failed · export everything` on failure.

> **本轮修复**：外壳里配好的 MCP 服务器与技能**备份不到** —— 导出包里 `mcp/servers.json` 恒为空、
> `custom/skills/` 一个条目都没有，而插件报的是「成功」。根因是两处「只看了一个地方」：MCP / prompts /
> 插件激活行的 patch **只读了 home 层**，而外壳真正写进去的是**档案层** `profiles/<name>/cordis.patch.yml`；
> 技能**只扫了 `$DSH_HOME/skills`**，而外壳的技能来自插件注册表。现在 patch 行按层读取、写回原层，
> 技能经外壳的 `skills` 服务收编，备份与回滚都记住每一行属于哪一层。
>
> **Theme**: MCP servers and skills configured in the shell could not be backed up at all (issue #71) —
> the bundle's `mcp/servers.json` was always empty and `custom/skills/` had no entries, while the plugin
> reported success. The plugin read only the home layer of the patch file for MCP / prompts / plugin
> activation rows (the shell writes them into the **profile layer**), and it scanned only
> `$DSH_HOME/skills` for skills while the shell serves them from its plugin registry. Patch rows are now
> read per layer and written back to the layer they came from, skills are collected through the shell's
> `skills` service, and backup/rollback record the layer of every row.

#### 🔌 修复：备份不到外壳的 MCP 与 Skills（issue #71）· MCP / skills not backed up (issue #71)

- 🔌 **MCP 服务器现在从两个 patch 层读出**：`$DSH_HOME/cordis.patch.yml`（用户层）与
  `$DSH_HOME/profiles/<name>/cordis.patch.yml`（档案层）按 **DSH 自己的合并优先级**取有效行（home 层后合并 ⇒
  优先级更高），同名 `lineId` 只保留优先级最高的那一条；每条导出条目记下自己的来源层。
  **MCP servers are now read from both patch layers**, merged in DSH's own precedence order (the home
  layer wins), with the source layer recorded per entry.
- ✍️ **导入写回原层，不再一律写 home 层**：来自档案层的行写回档案层（并且是**目标机当前档案**），来自用户层的
  写回用户层；旧备份包没有层字段 ⇒ 按用户层处理（改造前行为，不猜）。同一根因下 prompts 分区与插件激活行
  一起修好。**Imports write back to the layer a row came from** — profile-layer rows go to the target
  machine's current profile; bundles from older versions have no layer field and keep the old home-layer
  behavior. Prompts and plugin activation rows are fixed by the same change.
- 🧩 **技能经外壳的 `skills` 服务收编**（`ctx.skills.list()` / `get(name)`）：注册表里的技能按
  `<name>/SKILL.md` 虚拟路径并入 `custom/skills/`，frontmatter 只写 DSH 认的键（`name` / `description` /
  `whenToUse`，调用策略写 `disable-model-invocation` / `user-invocable`）；**同名时磁盘原文优先**，
  服务不可用就退回纯目录扫描（只记 warn，不编造告警）。**Skills are collected through the shell's `skills`
  service** as virtual `<name>/SKILL.md` paths; on-disk files win on the same path, and a missing service
  degrades to directory scanning.
- 🛟 **备份与回滚记住 patch 行的层**：快照条目记录 `file`，回滚写回**原层**（旧快照缺该字段 ⇒ 用户层）；
  计划项去重键把层算进去，档案层的行不再被 home 层的同名行吞掉；整文件还原接受**任一层**的
  `cordis.patch.yml` 备份。**Snapshots and rollback now record the layer of every patch row.**
- 🧾 **多行技能字段不再写出非法 YAML**：服务技能的 `description` / `whenToUse` 可能是块标量
  （真机 `dsh-reverse-skill/skills/binary-diff` 是 4 行 211 字符），重建 frontmatter 按三档编码 ——
  以恰好一个换行结尾的多行值写块标量 `|`（尾换行交给 clip chomping 还原）、含换行 / 回车 / 控制字符的
  写双引号 + 转义、其余仍是单引号；解析回来**逐字符相同**。原先只做单引号转义，多行值会跨行 ⇒ 外壳判
  `invalid YAML frontmatter` 并**丢掉整个技能**（比不备份更糟）。**Multi-line skill fields are now encoded
  as valid YAML** (block scalar / double-quoted escapes / single-quoted), so the shell can never drop a skill
  over frontmatter.
- 🧪 **用例**：新增 `src/core/patch-layers.test.ts`（层优先级 / 写回层解析 / 单层读失败不阻塞），
  扩充 `src/adapters/files.test.ts`（技能服务合并、磁盘优先、服务缺失、路径安全、**多行字段的 YAML 合法性**）、`mcp.test.ts`、
  `prompts.test.ts`、`plugins.test.ts`、`tests/core/patch-file-snapshot.test.ts`（快照记层 + 回滚写回原层）。

> **本轮修复**：一键同步**永远收敛不了** —— 4 个空 settings 分区（`permission` / `locale` /
> `ui-settings-general` / `agent-preset-registry`）与 `self:sync/sync-autosync.json` 每同步一次就会
> 重新出现在差异列表里，连续 7 次 `completed` 事务全部命中，界面却报「成功」。根因是两处彼此独立的
> 判定缺陷：settings / providers 把「目标为空 → 新建」排在了「值相等 → 跳过」之前，而两端值都是空的
> `{}` 时，写回 `{}` 是一次空写入，下一轮读回来还是 `{}` ⇒ 永远判「新建」；`self` 分区按**整文件哈希**
> 比对，而自动同步配置里的 `lastRunAt` / `consecutiveFailures` 等运行态字段每轮都被调度器改写 ⇒
> 哈希永远不同、永远判「冲突」（点「应用」还会把远端的陈旧运行态倒灌回本机）。现在两处都按预期判
> 「跳过」，而「目标非空 + 导入为空」仍判「冲突」—— 不借「跳过空值」静默清空本机配置。
>
> **Fix**: one-click sync could never converge. Four empty settings namespaces (`permission` / `locale` /
> `ui-settings-general` / `agent-preset-registry`) and `self:sync/sync-autosync.json` came back in the diff
> list on every single sync — seven consecutive `completed` transactions hit them all — while the UI reported
> success. Two independent judgement bugs: settings / providers tested "target is empty → create" before
> "values are equal → skip", so when both sides held an empty `{}` the "write" was a no-op that left the next
> read identical (create forever); and the `self` section compared **whole-file hashes**, while the autosync
> config's run state (`lastRunAt`, `consecutiveFailures`, …) is rewritten by the scheduler after every run, so
> the hashes never matched (conflict forever — and applying it pushed the remote's stale run state back onto
> this machine). Both now skip as expected, and a non-empty target against an empty import is still a conflict,
> so local configuration is never silently wiped.

#### 🔁 修复：一键同步永不收敛（issue #73）· One-click sync that could never converge (issue #73)

- ⚙️ **settings / providers 判定顺序修正**：`planNamespaceItems` 与 `ProvidersAdapter.analyzeImport` 把
  「值相等 → 跳过」提到「目标为空 → 新建」之前，两端皆 `{}` 时不再反复产生空写入。`ui` 分区与
  `providers` 共用同一判定，同源生效；「目标为空 + 导入非空」仍是新建、「目标非空 + 导入为空」仍是冲突。
  **Equal values are now checked before emptiness in settings, ui and providers**, so two empty `{}` values
  skip instead of creating again on every sync.
- 🧾 **`self` 调度配置剔除运行态后再比对**：`FileCollectionAdapter` 新增可覆写的比对口径钩子，`self` 对
  `sync/sync-autosync.json` 与 `sync/backup-schedule.json` 剔除 `lastRunAt` / `lastRunStatus` /
  `lastRunMessage` / `lastRunHistoryId` / `consecutiveFailures`（含 v2 `channels.git` / `channels.webdav`
  嵌套）后按**键排序**稳定序列化比对；配置本体不同仍判冲突，文件解析不出 JSON 时回落整文件哈希
  （「判不出来」≠「判为相同」）。其余 `self` 白名单文件口径不变。**The self section now compares its two
  scheduler configs without run-state fields**, serialized with sorted keys so a hand-edited key order cannot
  create a phantom conflict; a real configuration change is still a conflict, and an unparsable file falls back
  to the whole-file hash.
- 🧪 **用例**：新增 5 条回归 —— settings / providers「两端皆 `{}` → 跳过」「目标非空 + 导入 `{}` → 冲突」，
  `self`「仅运行态不同 → 跳过（键序不同亦然）」「配置本体不同 → 冲突」「坏 JSON 回落整文件哈希」
  「口径不外溢（`sync-config.json` 仍按字节判）」。**Five regression tests** cover the empty-value skip, the
  non-empty-target conflict, run-state-only skip, a real config change, unparsable JSON, and the scope boundary.

> **会话体检不再整片误报「子代理缺父」（真机 798/801 → 0）**
> 旧实现在调用方没给「已知会话 id」时用 `?? new Set()` 把「未知」当成「确知为空集」，于是「父对话存在性」判据对**每一条**子代理会话都成立 —— 真机 801 条里有 **798 条**被误报 `subagent-without-parent`（`bySeverity.invisible=798`）。现在「未知」与「确知为空」严格分开（`knownSessionIds` 缺省 = 不判、显式空集才判），采集器自己从遍历结果自证集合；复算：默认解析下误报 **0**，显式空集模拟下仍有 801 条（证明不是靠放宽判据换来的）。
>
> **The session check-up no longer reports "subagent without parent" en masse (798/801 on a real machine → 0)**
> The old code turned "unknown" into "known to be empty" with `?? new Set()` whenever the caller supplied no known-session-id set, so the parent-existence predicate held for **every** subagent session — **798 of 801** units on a real machine were flagged `subagent-without-parent`. Unknown and known-empty are now strictly separate (`knownSessionIds` absent = do not judge; an explicit empty set = judge), and the collector derives its own set from the traversal. Re-measured: **0** false positives under the default parse, still 801 under an explicit empty set (proving this was not bought by loosening the predicate).

> **批量修复的失败分支不再丢 `verify` / `rolledBack`（危险态曾对用户不可见）**
> 一键修复在「某条失败」的分支里丢掉了逐条 `verify` 与 `rolledBack` 字段：界面因此可能把**回滚失败（`rolledBack:false`，会话可能处于中间态）**渲染得与成功无异，同时承诺文案与实际状态分叉。现在三态（现役可读 / 迁移链可还原 / 未验证）与回滚结果一律逐条回传并各自有文案键（「未执行 / 已回滚」**绝不显示为成功**，回滚失败单独显红）。
>
> **The batch repair no longer drops `verify` / `rolledBack` on the failure branch (a dangerous state used to be invisible)**
> The one-click repair dropped the per-item `verify` and `rolledBack` fields on its "one item failed" branch, so the UI could render a **failed rollback (`rolledBack:false`, possibly a half-applied session)** as if nothing had happened, while the promise text diverged from reality. The three verification states and the rollback outcome are now always returned per item, each with its own copy key ("not applied / rolled back" **never renders as success**; a failed rollback is shown in red on its own).

> **复验门不再因缓存键与判等口径不一致而翻转结论（真机 v4 曾被判 `decode-failed` 并回滚）**
> 复验门的 catalog 解析曾只按 `plan.root` 缓存、等价性也只按 root 判定，于是**同一进程内同一输入**会因前一次调用改变了缓存而给出不同结论（实测等价性翻转 + 本机 v4 被误判 `decode-failed` 并触发回滚）。现在任何依赖日志 header 的判定都**按该日志的 `headerVersion` 重跑**，等价性用 `equivalentToReadPath` 判定：`createRestore(strict+transformed)` 只在 `header.version ===` 当前代际时可达（本机 v4），pre-v4 走迁移链 ⇒ 可以 `verified` 但**不等于 DSH 读盘路径**。
>
> **The verify gate no longer flips its verdict because its cache key and its equivalence test disagreed (a real v4 log was judged `decode-failed` and rolled back)**
> Its catalog resolution cached by `plan.root` alone and judged equivalence the same way, so **the same input could produce different verdicts inside one process** (observed: equivalence flipped, and a v4 log on this machine was misjudged `decode-failed`, triggering a rollback). Every log-header-dependent decision is now re-run per that log's `headerVersion`, and equivalence is decided by `equivalentToReadPath`: `createRestore(strict+transformed)` is only reachable when `header.version` equals the current generation (v4 here), while pre-v4 goes through the migration chain — verifiable, but **not equivalent to the DSH read path**.

> **面板三处「你看到的与实际不符」（含两条新护栏）**
> - **布局归位卡被挤成一行**：整卡外层误用 `.snapshotRow`（横向 flex 行）、小节标题误用 `.snapshotRowMain`（`flex:1` + `nowrap`）⇒ 标题、三行说明、按钮与计划摘要被排进同一行、文字被挤成竖排（用户截图）。改为 `.card` 容器 + `.groupLabel` 小节标题 + `.snapshotList`/`.reportScroll` 纵向列表 + `.actionRow` 按钮行。
> - **渲染文案里的字面 `\*\*`**：面板是纯文本渲染（无 markdown 解析），`sessions.repair.*` 的四条 zh 文案与布局归位的 `refreshHint` 会把 `\*\*` 原样显示成星号（英文侧用的是大写强调，zh/en 也不对称）。全部去标记。
> - **把「回滚失败」说成「已复原」**：布局归位的 `refreshHint` 原写「失败项已逐条回滚」，但失败项可能是 `rolledBack:false`（回滚自身失败）。改为「已逐条**尝试**回滚，回滚失败的项会单独标红（绝不显示为已复原）」。
> - **两条新护栏**：`src/client/recovery/recovery-panel-layout.test.ts`（源码级断言小节外层必须是 `.card`、标题必须是 `.groupLabel`、行列表必须在 `.snapshotList` 里 —— 这类「容器类选错」类型检查/模型单测/bundle 护栏**都抓不到**）；`src/client/recovery/recovery-locales.test.ts` 的类级守卫（zh/en 任何值含 `\*\*` 即红，含变异验证：注入 → 红并点名键、还原 → 绿）。
>
> **Three "what you see ≠ what is true" fixes in the panel (plus two new guardrails)**
> - **The layout-relocation card was squeezed into one row**: the card wrapper wrongly used `.snapshotRow` (a horizontal flex row) and section titles used `.snapshotRowMain` (`flex:1` + `nowrap`), so the title, three hint lines, buttons and plan summary all landed on one line with vertical-wrapped text (user screenshot). Now: `.card` container, `.groupLabel` section headers, `.snapshotList`/`.reportScroll` vertical lists, `.actionRow` button rows.
> - **Literal `\*\*` in rendered copy**: the panel renders plain text (no markdown), so four zh `sessions.repair.*` strings and the layout `refreshHint` showed asterisks verbatim (the English side used uppercase emphasis instead — also an asymmetry). All markers removed.
> - **"Rollback failed" was reported as "restored"**: the layout `refreshHint` said failed items "were rolled back individually", but an item can be `rolledBack:false` (the rollback itself failed). It now says rollbacks are **attempted** per item and any failed rollback is flagged separately — never shown as restored.
> - **Two new guardrails**: `recovery-panel-layout.test.ts` (source-level assertions that the section wrapper is `.card`, headers are `.groupLabel` and row lists are inside `.snapshotList` — a class of defect that typecheck, model unit tests and the bundle guardrail **cannot** catch) and the class-level guard in `recovery-locales.test.ts` (any `\*\*` in zh/en fails the suite; mutation-verified).

> **致谢 / Thanks**：本轮的同步通道「选择/新建私有仓库」与链接跟随边界修复（[#67](https://github.com/xiajiajun516/dsh-config-manager/pull/67)）、
> 总览首屏性能修复（[#68](https://github.com/xiajiajun516/dsh-config-manager/pull/68)）、MCP / Skills 备份修复
> （[#72](https://github.com/xiajiajun516/dsh-config-manager/pull/72)）均由 **@iuuuuuuuu** 贡献。
>
> **Thanks**: the sync repository picker and the link-traversal boundary fix ([#67](https://github.com/xiajiajun516/dsh-config-manager/pull/67)),
> the Overview first-paint performance fix ([#68](https://github.com/xiajiajun516/dsh-config-manager/pull/68)) and the
> MCP / skills backup fix ([#72](https://github.com/xiajiajun516/dsh-config-manager/pull/72)) were all contributed by **@iuuuuuuuu**.

## [0.1.69] - 2026-10-04

> **本版已发布**：覆盖此前数轮并行落地的工作（会话跨机迁移与体检、UI v2 信息架构、磁盘占用体检、
> 版本更新检查、加密备份恢复入口、SAFE MODE 出口），以及本轮集中修复的六个上报 issue（#55–#60）。
> **Released**: this version ships several rounds of parallel work plus the six reported issues fixed here (#55–#60).
>
> 本轮修的是**「对话消失」的第二类根因**：DSH 的会话日志按 `header.version` 分版本，读不出的（更高的）
> 格式会被 DSH **静默跳过** —— 不报错、不在工作区列表里。高版本能读低版本（V0→V4 迁移链），**反向不可读**，
> 而本插件的导出/导入/同步是逐字节搬运，于是「导入全部成功、对话一个不显示」。现在导入/同步会在**分析阶段**
> 就体检并告警，档案页也会显示每个档案的运行 DSH 版本与会话格式版本、对错配给出提示；**任一侧读不到版本
> 一律不提示**（不猜、不给假结论），也不会替 DSH 做格式迁移。
>
> **Theme**: the second root cause behind "my conversations disappeared" is now visible before it hurts.
> DSH stamps every session log with a `header.version` and **silently skips** logs it cannot read (no error,
> not in the workspace list), while higher builds can read lower ones but not the reverse. Since this plugin
> copies session logs byte-for-byte, imports and syncs now probe the bundle's session format versions during
> **analysis** and warn when the local DSH build cannot read them; the profiles page shows each profile's DSH
> version and session format version plus a mismatch hint. Unknown on either side stays quiet — no guessing,
> and no format migration inside the plugin.
>
> 同一轮还补上了**磁盘占用体检**：备份页现在能回答「我的备份占了多少盘、哪些能清」，并提供只作用于
> 可重建缓存的「立即清理」（快照与同步数据永不在此删除）。
>
> The same round adds a **disk-usage report** on the backups page — how much space the plugin's own
> artifacts take, what is reclaimable, and a one-click cleanup that never touches snapshots or sync data.
>
> 再加上两件「让用户看得懂」的事：**「关于」页可以检查插件更新**（只读探测 npm，给一条可复制的升级命令，
> 绝不自动安装）；**导入前的兼容性评分有了结构化原因**（来源 DSH 版本 / 平台 → 本机 + 逐条判定依据），
> 同步确认页也不再显示 `partial` 这种机器 token。
>
> Plus two things that make the plugin self-explanatory: the **About page can check for updates** (read-only
> npm probe that hands you a copyable upgrade command, never auto-installs), and the **import compatibility
> score now comes with structured reasons** (source DSH version/platform vs local, item by item).
>
> 而**最大的改动是界面本身**：一级信息架构从 7 个功能页签重建为 **4 个对象页 + ⌘K 命令面板**
> （首页 / 产物库 / 同步 / 环境），并在此后的真机自查里逐条修掉了它带出来的问题 ——
> 详见下面两节（`UI v2` 与 `UI v2 落地后的真机修复`）。
>
> **The biggest change is the UI itself**: the top-level IA is rebuilt from seven feature tabs into
> **four object-centric pages plus a ⌘K palette**, with the follow-up real-machine fixes listed in the
> two sections below.

### ✅ 本轮修复的上报 issue（按编号）· Reported issues fixed in this release

> 六条都在真机上复现并定位过，共同点是**失败都不显眼**：其中四个都是「操作报成功、但结果不完整 / 读不回来」，
> 用户只看得到症状（插件丢了、列表空的、密码输不进去），看不到原因。所以修复除了纠正行为，还都**把失败变可见**。
> 均已在 issue 上回帖确认（`confirmed` 标签），修复随本次发版交付。
>
> All six were reproduced and root-caused on a real machine. They share one trait: the failure was never loud —
> four of them reported success while leaving the result incomplete or unreadable. Each fix also makes the failure **visible**.

### 🔓 #55 加密备份的恢复入口 / Restoring encrypted backups

- 🐛 **从「备份文件」列表恢复加密备份不再报「不是合法的 ZIP 文件」**：勾了加密的备份落盘是
  DCA1 整包容器（文件名仍是 `.zip`），而**浏览器选文件**那条入口一直有形态探测 + 解锁阶段，
  **备份列表的一键导入**却把宿主路径直接送去分析 —— 容器被当 ZIP 解析，用户看到的是
  「缺少中央目录结束记录」，像是备份损坏，实际只差一步「解锁」。
  **Restoring an encrypted backup from the backup list no longer fails with "not a valid ZIP"**; the
  one-click import path skipped the unlock stage that the file-picker path already had.
- 🧩 **容器形态探测收敛为单一事实源**（`src/security/container-kind.ts`）：`containerKindOfBytes` /
  `readContainerKind`。文件形态**只读前 4 字节**（上传接口此前为看这 4 个字节把整份备份读进内存），
  读不到一律回落「明文」，绝不猜成加密。备份文件列表新增可选探测（`listBackupFiles(dir, { withContainerKind: true })`
  → `BackupFileMeta.containerType`，默认关闭，保留策略/磁盘体检保持零额外 I/O）。
- 🛡️ **三道防护纵深**：`/analyze`、`/plan`、`/execute` 收到未解锁的容器一律返回
  `code: 'encrypted-container'` + 可行动文案（不再让 ZIP 解析器的话术把用户引向「备份坏了」）；
  客户端据此**自动进入解锁阶段**（旧宿主 / 脚本直调也能兜住）。查看/对比入口对加密备份给出
  「先导入解锁」的说明，列表行加「已加密」徽章。
- ⚠️ **常量与实现分离**：`ENCRYPTED_CONTAINER_CODE` 放在**零依赖**的 `src/utils/shared-constants.ts` ——
  client 半若 import `security/container-kind.ts`，会把 security 桶 → `encryption.ts`（node:crypto/node:util）
  打进 `lib/client.js`，DSH 的 client loader 直接报 missed the module table，**整个插件不加载**（本轮实测
  并已由 `bundle-selfcontained` 护栏复核：bundle 的 require 只剩 react/react-dom/jsx-runtime）。

### 🛟 #56 SAFE MODE 不再是死结 / Safe mode is no longer a dead end

- 🐛 **「放弃恢复」现在会一并解除保护**：dismiss 此前只把事务移进 quarantine，而唯一的清除点挂在
  `verify(ROLLED_BACK)` 上 —— 事务已不在 `active/`，那条分支永远走不到。于是**界面显示「暂无需要
  处理的恢复事项」、写操作却持续 423、重启也无效**，用户只能去磁盘删 `transactions/safe-mode`。
  **Dismiss now clears safe mode** when no other unresolved incident remains (同一份判据，别的
  incident 还在时照旧保守保留保护)。
- 🧭 **状态如实可见**：`GET /recovery/status` 新增 `safeMode: { blocked, clearable }`；投影进渲染模型为
  `safeModeStuck`/ `safeModeBlocked`，「结案但保护仍开着」时计入 `recoveryRequired` 并渲染**显式解除入口**
  （危险按钮 + 二次确认），不再是空面板。
- 🚪 **补显式出口**：`POST /recovery/safe-mode/clear`（recovery prefix 路由下的子路径，不新增注册路由条目）
  + `RecoveryPort.clearSafeMode`。与 `lock/recover` 同处置：**故意不过 withMutationGate**（要解开的正是
  挡住写操作的保护，走 gate 必然 423），但**绝不无条件清标记** —— 还有 NEEDS_ATTENTION / 非终态事务时拒绝
  （`reason: 'unresolved-incidents'`），幂等返回 `not-blocked`。
- 🧪 测试：`tests/core/recovery-api.test.ts` 新增 4 例（dismiss 清标记 / 仍有未解决 incident 时保留 /
  status 的 blocked+clearable / 显式清除的确认与拒绝路径）、`src/client/recovery/recovery-view.test.ts` +3 例、
  `src/security/container-kind.test.ts` 5 例（含「只读 4 字节」的实测断言）、`src/sync/backup-files.test.ts` +2 例、
  `src/client/import/import-file-select.test.ts` +3 例。

### 🟡 #56 同步「部分成功」不再被说成成功 / "Partly successful" is no longer reported as success

- 🐛 **一条真机反馈揭出的第二条线**：webdav 同步时**插件安装失败**（pnpm 的成熟度等待期拦下），
  而插件安装在执行顺序上**排在凭据写入之前**，于是**密钥根本没导进来**；用户只看到「同步完成」，
  是靠事后翻日志才发现。根因不是顺序（顺序本身合理），而是**结果被低估**：插件安装失败是刻意的
  非致命 `warning`（§34.17：一个装不上的插件不该拖垮已成功的其余配置），而 `ok` 与 `warning` 无关，
  界面成功分支还直接弹绿 Toast —— 一串 warnings 被当成噪声。
  **The second root cause behind the same report**: the plugin install step (which fails first and sits
  *before* credentials in apply order) is deliberately non-fatal, so the sync still reported success while
  secrets were never written.
- 🧱 **「未生效项」成为结果的一部分**：`ImportResult.ineffective`（core）+ `ApplyItemsReport.ineffective`
  （sync）把 `status='warning'` 的计划项结构化回传（itemId / 分类 / 可读原因），**不改 ok 语义、不触发回滚**
  （字段只增不改；空数组时不出现 ⇒ 既有调用方逐字节不变）。同步路由透传并把历史记账改成
  「N 项（M 项未生效）」+ 非空 error 摘要，历史里不再是一条干净的成功。
- 🔔 **界面据实降级**：渲染模型新增 `partial` 类型（有未生效项时**不再**是 `ok`），成功 Toast 降级为
  warn 并给出条数，结果卡置顶渲染「部分成功：N 项未生效」+ 逐条列出未生效项（含各 adapter 自带的手动
  修复命令）。措辞与事实同强度：既不说是失败（没有回滚），也不说是成功（确实缺了东西）。
- 🧪 测试：`src/core/smoke.test.ts` 在既有「插件安装失败 → 非致命 warning」用例上补三条断言
  （进 ineffective / 带原因 / 不改变 ok 与 rollback）、`src/client/sync/sync-view-v2.test.ts` +2 例
  （partial 判定与「空/缺字段 → ok」的边界）。

### 📦 #57 `file:*.tgz` 的本地插件不再静默进不了备份 / Local plugins declared as `file:*.tgz`

- 🐛 `link:` / `file:` 的 spec 有两种**合法形态** —— 目录与**已打包的 tarball**。打包路径此前一律当目录
  spawn `npm pack`，真机上 9 个 `file:/abs/x.tgz` 插件**全部** `spawn ENOTDIR` 被跳过，而备份仍报
  `ok:true`（按设计只记 warning）—— 用户以为「备份成功 = 备份完整」，恢复时装不回这批插件。
  **A `file:` spec can point at a directory *or* at a prebuilt tarball**; the pack step only handled the former,
  so every `.tgz`-declared plugin failed with `spawn ENOTDIR` while the backup still reported success.
- 🔧 现在先 `stat` 判形态：**文件即 tarball → 直读收编、跳过 `npm pack`**（保留源文件名，只做文件名净化）；
  目录走原路径；**判不出形态一律回落目录流程**并给出可读告警（绝不猜成文件）。归档名仍恒为
  `local-plugins/<文件名>`、**不含任何路径分隔符**，与目录形态产出同一形态，导入端重写逻辑无需改动。
- 🧭 顺带修正 profile 目录来源：改用 `HostContext.profileDir`，不再按 `<home>/profiles/<name>` 硬拼
  （DSH 的档案目录不保证是默认布局，拼错会让相对 spec 解析到错误位置）。
- 🧪 `src/core/local-plugin-pack.test.ts` 新增 5 例（`.tgz` 直读且 `npm pack` 零调用 / 判不出形态回落 /
  超上限告警 / 目录与 `.tgz` 混合各走各的 / `safeTarballFileNameFor` 的穿越与回退）。

### 🧱 #58 从 git 源安装不再必然失败 / Installing from the GitHub source

- 🐛 本包以 `files: ["lib", ...]` 发布**预构建产物**，npm 安装不需要任何构建步骤；而
  `dsh plugin add git+https://...` 拿到的是**源码树** —— pnpm 需要在 clone 里跑一个构建入口才能得到 `lib/`。
  `scripts` 里此前**没有任何 pnpm 认的构建入口**（`prepare` 只在 `npm publish` 前校验、不参与安装），
  于是 git 安装 100% 失败于 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，用户只看到 `dsh: plugin command failed`。
  **The npm release ships a prebuilt `lib/`, but a git install gets the source tree** and needs a build entry
  point that the package did not declare.
- 🔧 补 `prepare: npm run build`；README（中英）新增「从 GitHub 源码安装」段，写明 pnpm 11 的 `allowBuilds`
  白名单必须**逐字照抄 pnpm 打印的那一行**（含完整 git URL + commit sha；**只写包名不生效**），并给出更省事的
  替代路径（装 npm 预构建版）。真机复核：首轮按预期报错并打印可粘贴的键，加白名单后第二轮 exit 0，
  `lib/index.js` 与 `lib/client.js` **均产出**。
- 🧪 `tests/packaging-contract.test.ts` 新增三条 `G-21` 门禁：`prepare` 存在且真的调 `build`/`bundle`、
  `files` 含 `lib`、`lib` 仍被 `.gitignore`（缺任何一条，git 安装会静默拿到一个没有 `lib/` 的包）。
- ⚠️ **剩余边界（如实登记）**：pnpm 11 默认拦截 git 依赖的构建脚本，**这一步无法由包作者免除** ——
  安装者必须在 profile 的 `pnpm-workspace.yaml` 里授权一次。这是 pnpm 的供应链策略，不是本包的缺陷。

### 💾 #59 加密快照 >64 MiB 时远端列表不再恒为空 / Encrypted snapshots above 64 MiB list correctly again

- 🐛 **读写两侧体积口径不一致**：加密单文件布局把整份快照塞进一个 JSON（写入侧**没有体积守卫**），
  而读取侧走 `parseJsonSafe` 的**缺省** 64 MiB 上限 —— 那是防**不可信输入**的闸门。加密载荷经
  「JSON → base64 → 加密 → 再 base64」约 ×1.78 膨胀，勾上 `sessions` 后单文件轻松越界（真机 4 个快照均 ≈66 MiB）。
  越界的后果**全是静默的**：`list()` 逐条跳过 → 远端列表为空（而同一响应里 `currentSnapshotId` 却指着那条快照）、
  `download()` 报「快照损坏」→ 拉取/一键同步彻底不可用、`hasNewRemoteSnapshot()` 恒 false → 自动同步永远
  `skipReason: upToDate`。**Read and write disagreed about the size limit**, and every consequence was silent.
- 🔧 读取侧改用 `MAX_OWN_PAYLOAD_JSON_BYTES`（512 MiB，**自产载荷**专用），与写出能力对齐 —— git 与 WebDAV
  的密文单文件共用同一份解码器，一处修复两处生效。
- 👁️ **把失败变可见**：读不出来的快照随列表回传（`POST /sync/snapshots-list` 的 `unreadable[]`），
  同步页常驻警告横幅列出**具体文件名**，列表到货时另给一次即时回执 —— 跳过是必要防御，但**绝不静默**。
- 🔒 **不变量（未放宽）**：`DEFAULT_MAX_JSON_BYTES`（64 MiB）仍是不可信输入的闸门，未被抬高；
  快照读取仍受 `maxDepth` 与形状校验约束；读失败诊断属远端**当下**状态，**不落 sessionStorage**。
- 🧪 `src/sync/snapshot-json.test.ts` 新增 2 例（自产上限 > 缺省上限；>64 MiB 载荷可反序列化且缺省上限仍拒它）。

### ⌨️ #60 WebDAV 密码框不再被无关状态更新清空 / The WebDAV password field no longer gets wiped

- 🐛 `runStore.patch()` 每次调用都会跑持久化白名单，而白名单**把密码字段写成空串**（安全不变量）。
  于是任何一次 patch —— 包括与密码**完全无关**的（远端快照列表到货、GitHub 授权轮询结束、自动同步状态刷新）——
  都会把 `state.sync.webdavPassword` 清空，下一次镜像回来时输入框就空了。真机表现：**输入几个字符就被自动清空**、
  **粘贴同样被清空**、输入过程中「保存配置」按钮闪一下（防抖自动保存被反复取消），且**没有任何保存成功提示**。
  **The persistence allowlist blanks password fields on every patch**, so unrelated state updates wiped what the user was typing.
- 🔧 新增 `RunStore.patchSyncPasswords({ token?, webdavPassword? })`：只写**内存**切片（不触发 `save()`）；
  `SyncPanel` 的 `commit()` 在 `runStore.patch(...)` 之后立即用它把**在途输入**写回。
- 🔒 **不变量（未放宽）**：密码仍**绝不**进 sessionStorage / 磁盘 / 日志（`toPersistedState` 白名单一行未改），
  刷新后仍清空（`applyPersisted` 的硬性归零也没动）。
- 🧪 `src/client/run-store.test.ts` 新增回归：在途密码经「无关 patch」后仍在内存、落盘文本不含密码、
  未给出字段保持部分更新语义；既有的「同步凭据绝不写入 sessionStorage」用例继续绿。

### 🔌 同步通道配置可断开（用户上报）· Disconnecting a sync channel

- 🚪 **配置过的通道现在能删掉了**：此前同步通道一旦配置就**没有出口** —— 一条打不通的 WebDAV 通道（如口令失效返回
  401）会永久占位，产物库的远端源与自动同步只能一直报「读取失败」，用户无从自救。
  现在通道入口卡多一个 **danger「断开配置」**（二次确认），宿主 `POST /sync/config { clear:true }` 一处清三项：
  ① `sync-config.json` 里该通道的命名空间（**活动通道自动切到剩下的那条** —— 不切的话，那条**配置过**的通道反而会
  被显示成「未配置」）；② 该通道在 DSH credentials 里的全部凭据（token / WebDAV 口令 / 加密·解密密码）；
  ③ 该通道的自动同步开关，并立即 `scheduler.reload()` 丢掉已排期的定时器。
  **只解除本机绑定**：远端快照、本机备份、同步分区选择一律不动，之后可重新配置。
  **Configured sync channels can now be disconnected** — the channel entry card gains a danger "Disconnect" action
  with confirmation, and the host clears the channel's config namespace, every credential slot and its auto-sync
  switch in one place. Remote snapshots and local backups are untouched.

### 🗂️ 会话迁移 / Session migration

- 🕳️ **「导入成功但对话没显示」现在会在导入前被指出**：新增宿主探针 `src/utils/session-format.ts`（`parseSessionFormatVersion` /
  `readSessionFormatVersionAt` / `resolveSessionFormatVersion` / `probeSessionFormats`）——只解会话日志的**首帧**取版本，
  每个会话只看一条日志，上限 200 条，读不出的如实计入 `unreadable`、未检查的计入 `skipped`。常量从
  `installAnchor`（桌面端在 `app.asar` 内）同树的 `@deepseek-ai/dsh-session` 读，**绝不拿 DSH 的 semver 猜格式版本**。
  **Imports now flag conversations the target DSH cannot read** before anything is written.
- ⚠️ **分析阶段告警**（core 只消费数字，不碰 DSH 存储格式）：`HostContext.sessionFormatVersion` +
  `AnalyzerOptions.sessionFormatProbe`（`ImporterOptions` 同名透传）→ `Analyzer.sessionFormatWarnings` 在
  「包内版本 > 本机支持版本」时产出 `import.sessionsFormatUnsupported`（中英双语），抽查有截断时追加
  `import.sessionsFormatSampled`；本机版本解析不到时**不告警也不谎报兼容**（宿主启动时 `log.warn` 一行）。
  同步的差异报告（`pull()`）把 `analysis.warnings` 并进 message —— 那条链路只有一个 message 通道，不并入就是静默。
- 🧾 **档案页显示版本**：每个档案展示 DSH 版本与会话格式版本（读不到 = 不显示），并对「本实例 VS 该档案」的
  错配给出徽章（`profileVersionFacts` / `sessionFormatRisk`；任一侧读不到一律不提示）。
  **Profiles page** now shows both versions and a mismatch badge per profile.
- 🧪 **测试**：`src/utils/session-format.test.ts`、`src/utils/session-log.test.ts`（`version` 解析 + 非法值不猜）、
  `src/core/import-sessions-visibility.test.ts`（v4→v3 必告警 / v3→v4 不告警 / 无法判定不猜）、
  `src/ui/dsh-profiles-view.test.ts`、`src/profiles/dsh-profile-manager.test.ts`。缺口登记为
  `docs/spec/known-gaps.md` **G-23**，兼容矩阵补一行（`docs/spec/compat-matrix.md` §3.5）。
- 🎛️ **导入/同步的处置开关落地（中止 / 跳过 / 仅提示，缺省中止）**：发现「本机读不了的会话」之后，用户现在能**自己决定**
  怎么办 —— `abort`（**缺省**：计划阶段就拒绝，**零写入**，附升级/离线体检指引）/ `skip`（这些会话单元默认不勾选，
  其余分区照常导入；手动勾回即照常导入）/ `guide`（不改行为，只给指引）。判定与展示**共用一份纯函数**
  （`src/ui/session-format-disposition.ts`），宿主接入 `/plan`、`/execute`、`/sync/sync`、`/sync/apply-items`
  （解析顺序 = 请求体 > 插件配置项 > 缺省 abort；`abort` 回 **409 + code=`sessionFormatUnsupported`**）。
  **只读查看（备份内容查看）与市场/「我的配置」复核页显式走 `guide`** —— 它们没有决策界面，沿用缺省会让用户连
  「看看包里有什么」都被拒。**Disposition switch** (abort / skip / guide) with a zero-write abort at the planning stage.
- 🐛 **修掉一个会让上面所有告警静默失效的键空间缺陷**：探针的会话单元键是 `projectKey/会话目录`（来自分区内相对路径），
  而计划项的 `unitId` 带适配器前缀（`sessions:`）—— 两边直接比较**一条都匹配不上**，于是
  `PlanItem.formatUnsupported` 永远为空、界面永远不提示「这些对话导入了也看不见」。现在两种形态都试
  （`sessionUnitVersion()`），并且**测试桩改用真实的前缀形态**（此前桩不带前缀，掩盖了这个缺陷）。
- 🔁 **导入会话后明确提示「重启 DSH 才会显示」**：DSH 的会话列表与工作区投影都在**启动期**建立，导入的会话不重启就是看不见
  （生态同类插件同结论，桌面端需退出重开）。提示只在**本次真的写入了会话文件**时出现（判定挂在导入上下文上，
  避免适配器实例跨导入累积导致「没勾会话也让你重启」）。**Restart hint** after importing sessions.
- 🩺 **会话体检（只读）**：事故恢复子 tab 新增「会话体检」——一键扫描本机存量会话，按严重级列出问题
  （**会让 DSH 起不来 > 会话不可加载 > 下次请求会失败 > 不可见**）：重放重复行、撕裂尾帧、非法帧、header 不可读、
  seq 空洞、合成 closer 块、格式版本超前、未登记工作区、子代理缺父、位置与 `projectKey(cwd)` 不一致、重复 id。
  **「未检查 N 条」全程可见**（把没检查说成没问题是最严重的谎报）；**应用内零写入**，每行只给可复制的离线命令。
  **Session health check** (read-only) in the incident-recovery tab, with the same severity ladder DSH itself would suffer.
- 🛠️ **离线安全修复（唯一允许写会话字节的通道）**：`dsh-config-manager sessions list / doctor`（只读）与
  `sessions repair [--apply]`。强制序列：**写前重跑「连续性 + 引用完整性」校验（不过即拒绝，绝不修得更狠）→
  时间戳备份（绝不覆盖已有备份）→ 临时文件 + `rename` 原子换入 → 写后复验（不过就用备份还原）**；
  写操作前**强制检测 DSH 是否在跑**（读心跳），在跑就拒绝并提示先关 DSH。本轮只做**能从字节证明的零/低损失修复**
  （重放族的字节相同重复行），需要 DSH codec 才能判定的类（缺 message id / 悬空 tool-call / settlement 非法）
  **一律不产出结论**（检测 ≠ 发明）。缺口登记为 **G-24**，未做的部分（codec 深度解码、header 重建、转写导出）
  如实写在该条目的「后续」。**Offline-safe repair** behind a verify-then-write sequence, only when DSH is stopped.
- 🧪 **测试**：`src/ui/session-format-disposition.test.ts`、`src/routes/session-format.test.ts`、
  `src/ui/import-wizard.test.ts`（三种处置各一条）、`src/core/import-sessions-visibility.test.ts`（abort/skip/guide）、
  `src/core/session-health.test.ts`（13）、`src/utils/session-health-scan.test.ts`（10，含「扫描前后字节与 mtime 不变」）、
  `src/ui/session-inventory-view.test.ts`（7）、`src/utils/session-log-repair.test.ts`（7，含拒绝路径零写入）、
  `src/ui/next-steps.test.ts` / `src/adapters/sessions.test.ts`（重启提示与跨导入隔离）、
  `src/client/common/http.test.ts`（错误透传 status/code）。
- 🧱 **处置开关的地基**：探针升级为**单元级**（`SessionFormatProbeResult.units`），
  `Analyzer.resolveSessionFormats` **每份归档只算一次**并供三方共用（分析告警 / `PlanItem.formatUnsupported` /
  `ImportAnalysis.sessionFormats`）——「本机读不了的会话」现在是**具体计划项上的标记**，向导据此提供三选一；
  纯附加字段，不拦执行、不改 kind/conflict，读不到版本一律不判。
  **Disposition groundwork**: unit-level probe results plus one per-archive resolution shared by warnings,
  plan-item flags and the structured analysis summary.
- 🔧 顺带修一条**环境相关的测试假红**：`src/adapters/plugins.test.ts` 的「安装失败 → 非致命 warning」用例依赖
  `resolveProcessProfileName()`（读 `DSH_PROFILE`），在桌面端会话里会解析成 `desktop` 而断言写的是 `web`；
  改为显式传入 profile，测试不再随运行环境漂移。

### 💾 磁盘占用 / Disk usage

- 🧭 **备份页新增「磁盘占用」卡**：本插件的产物（`exports/` 导出备份、`snapshots/` 导入前快照、`sync/` 同步
  配置与 Git 工作副本、`market/` 缓存与工作副本、`tmp/` 暂存、`logs/`、`boot-state/`、`migration-history/`、
  `transactions/`、`locks/`、`vault/`）此前在界面上**没有任何数字** —— 用户无法回答「我的备份到底占了多少盘、
  哪些能清」。现在逐区列出体积/文件数/回收策略，并区分三档语义：**可随时重建**（缓存与暂存）、
  **有保留期**（导出产物 7 天、定时备份保留最近 N 个）、**用户数据/安全网**（快照与同步，永不在此清）。
- 🧹 **一键释放空间**：缺省只清**可重建**的缓存与暂存（忽略保留期整块清）；回收**过期**备份文件必须显式勾选，
  并走 danger 二次确认。请求里的分区白名单是硬边界 —— 用户没勾 `expired-exports` 时**一个导出文件都不碰**
  （回归测试：`tests/route/disk-usage-routes.test.ts` 的「只清可重建区，备份/快照原样保留」）。
- 🔒 **两条不变量**：① 快照与同步数据**永不在候选集内**（`snapshots` / `sync` 连路由参数都进不去）；
  ② 体检是**只读**且不跟随符号链接/junction（不重复计数、不成环），目录读不到时如实标「未统计」而不是显示 0 字节。
- ⚙️ 与既有自动清理**同一套口径**：`core/cache-cleaner.ts` 抽出 `sections` 白名单与 `includeRecent`（手动），
  保留期仍只有一份实现；新增 `core/disk-usage.ts`（只读扫描 + 超期判定）与 `src/ui/disk-usage-view.ts`
  （纯函数视图模型，界面数字由渲染出的行现算，杜绝「按钮说能释放 600 B、实际释放 0」的漂移）。
- 🧪 **测试**：`src/core/disk-usage.test.ts`（6 例：聚合 / 导出豁免前缀 / 未统计 / 符号链接 / 保留期 / 容错）、
  `src/ui/disk-usage-view.test.ts`（6 例：空报告 / 未统计 / 可回收清单 / 过期提示 / 保留期文案 / en 字典）、
  `src/core/cache-cleaner.test.ts`（+2 例：`includeRecent` 语义、缺省仍只清超期）、
  `tests/route/disk-usage-routes.test.ts`（4 例：只读 GET / 非法请求 400 / 只清缓存 / 只回收过期导出）。
  路由快照 68 → **70**（`GET /disk-usage`、`POST /disk-usage/cleanup`）。

### 🐢 预览性能回退修复 / Preview performance regression

> 真机报告：「总览页与导出页加载变长了」。定位到的根因是 **v0.1.68 引入的 `preview()` 在单文件分区上走错路径**。

- 🐛 **`agentInstructions` 的预览把整个 `$DSH_HOME` 递归了一遍**：`AGENTS.md` 在 home 根（`baseDir = ''`），
  基类 `preview() → collect() → listFilesDetailed(baseDir)` 于是遍历整个 home —— 实测 **4.8 s / 4016 个文件 /
  242 MB**，选择器还把 `profiles/`、`sessions/`、`attachments/` 等无关目录当成该分区的 **21 个假单元**
  （而真实导出只读 `AGENTS.md` 一个文件 = 预览与导出分叉）。总览页调 `/export-preview`（默认分区集合含
  `agentInstructions`）→ 单这一项就占 **5.0 s 中的 4.8 s**；导出页的选择器同理。
- ✅ **修复**：`FileCollectionAdapter` 新增可覆写的清单钩子 `listRelPaths()`（`export`/`preview` 共用一份清单），
  `AgentInstructionsAdapter` 覆写为**单文件白名单**（存在性判定走 `statSize`，旧门面退回读一次文件），
  并删掉冗余的 `export()` 覆写 —— 现在预览与导出经同一个 `collect()` 内核，**逐项一致由构造保证**。
  实测同一台机器：该分区预览 **4.8 s → 1.4 ms**，1 个文件 / 8131 B / 1 个真实单元。
- 🧪 回归护栏 `src/adapters/agent-instructions.test.ts`（5 例）：用「一被调用就抛哨兵」的门面证明**不再递归**、
  预览与导出逐项一致（条目/体积/计数/告警）、home 里的无关文件一个都不进该分区、文件缺失 → 空分区 + dirEmpty 告警。
- ⚡ **后续两项优化（同一轮）**：
  ① **父子关系短 TTL 缓存**：`parentRelations()` 走 DSH `sessionPersistence.list()`（真机 ≈ **0.7 s**），
  而 `/export-preview` 每次都要它（选择器联动用）。新增 `src/utils/ttl-cache.ts`（通用短 TTL 异步缓存：
  **同 key 并发合并成一次执行**、**失败不缓存**、时钟可注入），`DshSessionStoreFacade` 以 **5 s** TTL 缓存
  该 Map —— 连续打开/刷新选择器只付一次；新子代理会话最多 5 s 后即可被联动识别（对选择器无影响）。
  ② **体积与时间合并成一次 stat**：新增 `FileSystemFacade.statInfo`（宿主一次 `fs.stat` 同时给 `{ size, mtimeMs }`），
  预览把顺带取到的时间放进 `SectionPreview.statTimes`，`unitActivityTimes(ctx, section, statTimes)` 直接复用、
  **不再逐文件 stat**。真机实测同一棵会话树：**1361 次 stat（983 size + 378 mtime）→ 983 次**，结果逐项相同；
  两个旧门面（`statSize` / `mtimeMs`）保留为回退路径 —— 旧宿主只慢不坏。
- 🧪 新增测试：`src/utils/ttl-cache.test.ts`（6 例：命中/过期/关闭/并发去重/失败不缓存/容量与 clear）、
  `src/adapters/file-collection.test.ts`（+2：`statInfo` 优先且旧门面一次都不调；`statInfo` 返回 null 时退回 `statSize`）、
  `src/adapters/sessions.test.ts`（+2：给定预览时间时**绝不**发起第二趟 stat 且结果与逐文件路径一致；缺项不进 Map 不猜 0）。
- 📉 顺带记录**剩余**成本（不是本次回归，未改）：`sessions` 预览实测 **1.14 s** = 真实遍历 324 ms（983 文件 / 517 MB）
  + 体积 stat 64 ms + mtime 通道 9 ms + **DSH `parentRelations()` 与元数据 ≈ 0.7 s**（每次预览都重新取）。
  它在 `sessions` 显式放行时才发生（该分区 `defaultIncluded = false`），因此不影响总览页默认加载。
### ⬆️ 版本更新检查 / Update check

- 🔍 **「关于」页新增插件更新检查**：`GET /update-check` 只读探测 npm 的 latest（`core/update-check.ts`），
  命中时显示「已是最新 / 有新版本 vX」并给出**可复制的一条升级命令**（精确版本
  `dsh plugin --profile <档案> add dsh-config-manager@<latest>` —— 用精确版本而不是 `@latest`，
  因为 pnpm 的 `minimumReleaseAge` 会让 `@latest` 解析到旧版）。
- 🔒 **四条硬边界**：① **绝不自动安装/升级**（只探测 + 给命令）；② 进程内缓存 10 分钟（`?force=1` 由
  「重新检查」触发），不把 registry 当轮询端点；③ 网络/超时/非 2xx/响应畸形/体积超限**一律如实报错**
  （绝不「失败当最新」），HTTP 仍回 200（离线不是插件故障，界面给可重试提示而非错误横幅）；
  ④ 版本比较复用 `validator.ts` 的同一份 semver 规则，不另写一套。
- 🖥️ **桌面端档案不误导**：`desktop` 由 Electron 独占管理、未知档案也不猜 —— 这两种情况不给终端命令，
  改为提示去 DSH 插件页更新（不给注定失败的命令）。
- 🧪 测试：`src/core/update-check.test.ts`（9 例：解析 / 失败四态 / 超时 / 严格更新判定 / 缓存与 force /
  失败不缓存 / `force=1` 判定）、`src/client/about/about-view.test.ts`（+5 例）。

### 🧭 兼容性讲清楚 / Compatibility explained

- 📋 **评分有了结构化原因**：`core/validator.ts` 新增 `compatibilityReasons()`，`computeCompatibility()`
  改为**由原因派生**（单一事实源：界面解释与评分不可能漂移）；`ImportAnalysis` 回传
  `compatibilityReasons` + `source` / `target`（来源与本机的 DSH 版本 / 平台 / schema 版本）。
  **评分口径逐条冻结**：`sourceOlder` 仍覆盖跨平台的 `partial`（历史行为，改它需单独决策），已由
  `src/core/compatibility-reasons.test.ts` 显式写下。
- 🪟 **导入向导新增「来源与兼容性」块**：「DSH 版本：源 → 本机」「平台：源 → 本机（跨平台标黄）」
  「备份格式 vX」+ 逐条判定依据（跨平台 / 分区缺失 / 来源更新或更旧 / schema 超范围）。原因里的
  版本与平台字符串来自**包内**，渲染前一律过 `redact()`（B1 教训）。
- 🔧 **同步确认页不再显示机器 token**：此前直接渲染裸枚举（中文界面里出现 `partial`）且 Badge 恒中性色，
  现在走 `src/ui` 的等级/语义色纯函数 + sync 字典文案（`unsupported` 是 error 色）；导入向导与同步页共用
  `client/common/compat-label.ts` 的键映射（源码级守卫禁止再写第二份）。
- 🧪 测试：`src/core/compatibility-reasons.test.ts`（8 例）、`src/ui/import-wizard.test.ts`（+3 例）、
  `src/client/common/compat-label.test.ts`（3 例，含两条源码级防回归）。路由快照 70 → **71**
  （新增 `GET /update-check`）。

### 🖥️ UI v2：一级信息架构重建 / UI v2: rebuilt top-level IA

> 这一轮把「备份与迁移」从 7 个功能页签重做成 **4 个对象页 + ⌘K 命令面板**：首页 / 产物库 / 同步 / 环境。
> 起因是旧界面的三处结构性问题：备份页有 4 个子 tab（其中「磁盘占用」与页面主题无关）、
> 英文下页签溢出要按住 Shift 才能滚、以及「对象」与「日志」混在同一张表里。
> 落地的四条原则：**对象与日志分离**、**每页 ≤3 子视图**、**未知值不显示 0**、
> **两个同步通道卡恒显示**（`autosync` 与 `sync-selection` 本就按通道独立）。
>
> This round rebuilds "Backup & migration" into **four object-centric pages plus a ⌘K command palette**
> (Home / Artifact library / Sync / Environment), replacing seven feature tabs.

- 🧭 **一级导航收敛为 4 页 + 命令面板**（`src/ui/nav-model.ts` 的 `navLayout` 负责溢出判定，
  放不下的项进「更多 ▾」）。导出与导入**不再是页签** —— 它们是 Task Mode 侧滑面板
  （多阶段向导 → 面板；单次决策 + 报告 → Modal，这是选容器的唯一依据）。
  `⌘/Ctrl+K` 打开命令面板（`src/ui/commands.ts`），**增一个功能 = 注册一条命令**，
  不必再往 564px 的导航条里挤一个页签。导航从 7 项降到 5 项，英文下不再溢出。
- 📦 **产物库取代备份页**（`src/client/library/`）：本机快照 / 备份文件 / 远端快照 / 市场产物
  **四源合一扁平列表**，来源只是筛选维度而非分组 —— 用户找「我上周那份」时不该先想它在哪个源里。
  行的动作由 `src/ui/artifact-view.ts` 的能力集合
  （`restore|import|pull|install|inspect|download|consult|pin|unpin|delete`）分派，四种来源共用一份模型。
  同步页的远端快照行搬到这里，那边只留**操作日志**（新增 `SyncLogList.tsx`，去掉「类型」列）。
- 🏠 **首页取代总览页**：状态行 + 动作网格 + 最近产物（3 行）。指标段改为**精确跳转**
  （备份文件 / 安全快照 → 产物库并预置来源筛选；定时备份 → 本页开设置弹窗，因为它是设置不是对象）。
  「立即备份」放在工具栏最左（导出 ZIP 的左边）—— 它与导出是同一件事的两种强度。
- 🗄️ **环境页取代档案页**：档案（含本机概况卡）+ 维护与诊断（恢复面板 + 磁盘占用）两个子视图。
  事故恢复与磁盘占用从备份页移到这里，备份页的 4 个子 tab 随之解散。
- 🔀 **同步页两张通道卡恒显示**：为此把 14 个 handler 从「隐式读当前通道」改为**显式收 channel 参数**
  （`channelStateOf` / `patchChannelOf` / `saveSelection` / `toggleSyncSection` / `setSessionsLimit` /
  `setSessionsInclude` / `setEncrypt` / `setIncludeSecrets` / `persistEncryptPassword` /
  `persistDecryptPassword` / `clearSavedDecryptPassword` / `toggleAutosync` / `updateAutosyncInterval` /
  `remoteReadyOf`）；参数缺省仍取激活通道（弹窗路径沿用），卡内一律显式传自己的。
  同步分区从**页面级一段**移进通道卡 —— 它本就是该通道的设置，做成全局一节会让用户以为两通道共用一份选择。
- 🗑️ **删除 10 个 v1 文件**（全仓零活引用）：`SnapshotsPanel` / `OverviewPanel` / `ProfilesPanel` /
  `SyncSettingsView` / `SyncHistoryView` / `nav-overflow` 及各自专属测试。
- 🧪 测试：`src/ui/nav-model.test.ts`、`src/ui/commands.test.ts`、`src/ui/artifact-view.test.ts`（+18 例）、
  `src/client/library/task-panel-visibility.test.ts`、`src/client/common/floating-units.test.ts`
  （浮层内联 `top/left` 必须带 px 单位）。`DESIGN.md` §1 重写并新增 §1.1（四页构成 + 三条不得回退的结构原则）。

### 🐛 UI v2 落地后的真机修复 / Real-machine fixes after UI v2

- 📏 **Select 弹层不再改变页面高度**：真机反馈「展开下拉页面会变高」。用 Chrome headless 实测确认
  机制是 **CSS 的 scrollable overflow area** —— `position: absolute` 虽不撑高父级，但它的溢出会扩展
  **最近滚动祖先 `.shellMain`** 的可滚动区域（实测 `scrollHeight` 400 → 556）。修法：弹层 portal 到
  插件根容器（`.section`，`position: relative` 且**不在**滚动容器内）+ **根相对坐标**（触发器 rect 减根 rect，
  纯减法），于是既脱离滚动区域、又不必用 `fixed`（`fixed` 会踩 `.dialogContentCenter` 常驻 `transform`
  的包含块，此前几轮反复出错的根源）。
- 🖱️ **产物库的四个真实缺陷**：① 远端快照源恒失败（请求漏了 `transport` + 地址，宿主 `prepareSync`
  需要它）；② 展开某行会重复派发上一次的动作（去重键里混了 `Date.now()`，改用 target 的引用身份）；
  ③ 删除后整页刷新且滚动跳回开头（刷新时把源置回 loading 并清空 items ⇒ 列表被卸载，
  改为 stale-while-revalidate）；④ 底部「N 个加密」统计的是全部来源而非当前筛选。
- 📥 **导入不再残留上一次的数据**：`importBackup` 的消费者只清了 decrypt 那几个字段，
  上一次的 `step` / `analysis` / `plan` / `result` 全部残留 ⇒ **加密备份的密码输入框不出现**。
  改为复用既有的完整 `resetWizard`（不再维护第二份「部分重置」清单 —— 那种清单必然漏字段）。
- 🎞️ **产物库行展开/收回有动画**：外层 `grid-template-rows: 0fr → 1fr`（内容高度未知也能过渡），
  内层 `min-height:0 + overflow:hidden`；组件从条件渲染改为**始终挂载**（条件渲染让收回一侧没有收尾帧）。
  收回时闪一下的根因是 `transition-delay` 只写在展开态，已补齐对称延时。
- 🐛 **「迁移前咨询」对远端快照报 `repoUrl is required`**：宿主 `routes/consult.ts` 的远端分支写的是
  `prepareSync({})` —— 传空对象，而 `prepareSync` 解析的是**请求体**。改为透传 body
  （实测：即使客户端传完整 payload，旧宿主仍报同样的错，因为它根本不看 body）。
- ⬇️ **远端快照「拉取」= 拉取即导入**（用户定案）：新增 `POST /sync/download` +
  `SyncEngine.downloadSnapshot()` 把远端快照**落地成本机 ZIP** 并返回路径 —— `POST /sync/pull` 只回
  只读差异预览（临时 ZIP 用完即删），拿不到可导入的文件。客户端点「拉取」进入**阻塞式 Modal**
  （遮罩 + focus trap 天然禁用页面其余部分）+ 加载态，成功后自动进入导入侧拉面板。
  **走导入向导而不是直接写配置**：向导已有解锁加密备份、选内容、冲突决策、执行前快照与回滚，
  另造写入通道等于把这五件事重做一遍且更难回滚。
- 🌐 路由数 **71 → 72**（新增 `/sync/download`）；`tests/route/` 的三条计数守卫与快照同步更新。

### 会话修复可以**在应用内直接做**了（只做零损失的那一类）

- 🧾 **会话体检的列表更好读了**（T11，用户反馈「文字挤成一团」）：会话名独占一行（长名不再把后面挤没），下面的元信息行按「状态徽章 | 问题码 | 版本·体积·时间」分列——徽章定宽、问题码可伸缩、元信息右对齐等宽数字；动作按钮固定右对齐。
- ⚡ **一键修复全部**（T11/T12）：对当前列表里可修的会话逐条走完整安全序列（预览 → 应用）。**逐条独立**（一条被拒不牵连其余）、**有损不批量**（需要截断的计划一律跳过并计入被拒）；结果**逐条留痕**（已修复 N / 未修复 M + 每条的丢弃行数或被拒原因），修好的行**就地移出列表**——不再整屏重扫让用户白等一次全量体检（要看最新全貌时自己点「开始体检」）。
- 🙈 **默认只显示有问题的对话**（T11）：正常会话不再占据列表（它们在摘要里照常计入总数），被隐藏的条数在卡片上明说（`另有 N 条会话正常`），可修的行即使当前判为正常也仍然显示。
- 🩺 **环境 → 会话体检里直接修**（T8，2026-10 扩展为 T9）：结果与动作整体搬进**独立弹窗**（卡片只留入口与一行摘要）；对「重放重复行」「可证明的合成收尾块」（零损失）与「seq 空洞 / 不可解析行」（**有损截断**，必须显式确认）新增 **dry-run 预览 → 显式确认 → 自动时间戳备份 → 原子换入 → 写后复验**的应用内通道，并在「修复记录」里提供**一键回滚**。
- 🔒 **五道门，一道都不放宽**：① `unitId` 只能解析到 `<home>/sessions` 之内的真实会话目录（路径穿越 / 符号链接逃逸一律 unknown-unit）；② 目录内有 `session.lock` 不修；③ 日志最近 30 秒被写过（可能在活跃使用中）不修；④ 预览与应用之间的**大小 + mtime 指纹**必须一致（TOCTOU：预览后文件被改过就拒绝）；⑤ 写操作过 `withMutationLock` + SAFE MODE 闸门，写入本身照抄离线 CLI 的「写前自校验 → 备份 → 原子换入 → 写后复验」，校验不过绝不「修得更狠」。
- ↩️ **回滚只认台账 repairId**：客户端**拿不到也传不了路径**；目标在修复后又被改过（指纹不一致）时回滚被拒绝，绝不覆盖更新的内容。台账损坏时先留档 `.corrupt-*` 再写新账（不静默丢证据）。
- 🧭 真正**证明不了怎么修**的类别（容器非法 / header 不可读 / 格式超前 / 撕裂尾帧自愈 / 缺工作区与缺父对话）**仍在应用内零写入**，继续只给可复制的离线命令 —— 不猜、不发明、不「修得更狠」。
- 🩺 **修掉会话体检弹窗把整个面板打白**（真机 + 浏览器实测定位）：`SessionHealthDialog` 的 state 声明写在使用点之后，触发 TDZ `ReferenceError: Cannot access 'repairedUnits' before initialization`；DSH 把插槽异常当成 `slot entry crashed in 'settings.section'`，于是「备份与迁移」整页空白。修复 = 把声明提到使用之前；另加源码级守卫（声明必须早于使用、不得重复声明）防回归。**同时**：弹窗改为**只在打开时挂载**、长列表限高内滚。
- 🩺 **又一次体检误报（第二轮，真机 + 浏览器实测）**：`turn/end` 之后紧跟 `workspace/changes`（同属该回合的收尾元数据）曾被判成「合成收尾块撞上真实续写」，导致 4 条**健康**会话既被标红、又在点「修复」时以 `写前校验未通过` 被拒。现在只有**续写事件**（消息 / 流式块 / 工具调用 / 回合与步骤开始）才算续写，元数据行不算；真机复核：可修条数 4 → 0，弹窗不再出现假的修复按钮。
- 🩺 **修掉体检的误报**（本轮真机发现）：`synthetic-closer`（合成收尾块）此前只按**形状**判定（≤8 行收尾类型 + 含 `turn/end`），而每一次正常的「回合结束 → 下个回合开始」都满足这个形状 —— 同一台机器上 **86 条健康会话被误报为「下次请求会失败」**。现在必须**证明**「收尾块之后、下一个 `turn/start` 之前同一个 `turn` 还在继续」才报（回合已结束却还在续写）；证明不了就不报（绝不猜：宁可漏报，也不把健康会话标红）。

> **Theme — session repair now happens in-app, but only for the provably lossless class.**
> The Environments tab's session health check can now fix "replayed duplicate rows" (byte-identical, same-seq duplicates left by a crash, a hard kill or a second writer) in place: dry-run preview, explicit confirmation, a timestamped backup, an atomic swap and a post-write re-check, plus one-click rollback from the repair ledger. Five gates stay in force — the unit must resolve inside `<home>/sessions`, no `session.lock`, the log must be quiet for 30 s, the preview's size+mtime fingerprint must still match, and the write goes through the mutation lock and SAFE MODE gate. Rollback accepts a ledger `repairId` only (the client can never supply a path). Every other corruption class stays read-only in-app and keeps pointing at the offline CLI.

### 🎨 插件图标对齐官方约定（issue #61 / PR #66）· Plugin icon

- 🖼️ **`icon.svg` 换成 36×36 无底框**：宿主图位自带容器（卡片 48px 框内放 36px 图、列表行 40px 框内放 30px 图），
  而旧图标是 512×512 画板 + 自带 `rx="112"` 圆角底框 —— 放进宿主就是**框中套框**，视觉也比官方插件重。
  现在与官方约定一致（已发布官方组合包 `@deepseek-ai/dsh-experimental-schedule-bundle@0.2.0-rc.1` 随包的
  `icon.svg` 实测同为 `width/height=36`、`viewBox="0 0 36 36"`、`fill="none"`）：主体外接框 4→32
  （28/36 ≈ 77.8%，与官方 fixture 的 `r=14` 同口径），纯矢量 1009 B，无 `<script>` / 外部 `href` / `<image>` /
  内嵌位图，保留原有 `role="img" aria-label`；16 / 30 / 36 / 48 四档 × 深浅双主题实况图校验通过。
  **The plugin icon is now a 36×36 frame-less SVG matching the official bundle convention** — contributed by
  @OMSociety in PR #66 (issue #61) and credited in both READMEs.
## [0.1.68] - 2026-09-30

> 本轮把**性能、发版门禁、卫生**三件事一起收口：只读预览不再为了显示几个数字读完整棵会话树
> （真机 941 个文件 / 528 MB：**2271 ms → ~0.4 s、常驻内存 +306 MiB → 近零**）；导入不再把同一份
> 归档重复解压 3~4 次，也不再让同步解压阻塞界面（29 MiB 归档全量同步解压实测阻塞事件循环 108 ms）；
> 两道**写在文档里却从未真正生效**的发版门禁落进 CI；插件的显示元数据（中文名/简介 + 自定义图标）
> 与一批死代码、逐字重复的实现一起清掉。
>
> **Theme**: performance, release gates and hygiene in one pass — the read-only preview no longer reads
> the whole session tree just to show a few numbers (2271 ms → ~0.4 s, +306 MiB RSS → near zero), imports
> no longer re-inflate the same archive 3–4 times or block the event loop while doing it, the two release
> gates that were documented but never enforced are now real CI steps, and the plugin now shows a
> localized name/summary plus a custom icon in the plugin manager.

### ⚡ 性能 / Performance

- 👁️ **只读预览不再读文件内容**：新增 `ConfigAdapter.preview()`（文件类分区由 `FileCollectionAdapter`
  实现）与 `FileSystemFacade.statSize`。它只把「读文件内容 + SHA-256」换成一次 `stat`，**单元分组 /
  条目白名单 / 单分区字节闸门 / 告警生成与真实导出逐字共用**同一个内核（`collect(ctx, options, mode)`）
  —— 预览是用户勾选的唯一依据，一旦与导出口径分叉，用户就会按预览勾选却拿到别的包（已由
  `file-collection.test.ts` 的「逐项相等」断言钉住）。宿主未实现 `statSize` 时自动退回旧行为，只慢不坏。
  **Read-only preview** now takes sizes from `stat` instead of reading every file, sharing the exact same
  unit grouping / byte gate / warnings as the real export.
- 📦 **导入不再重复解压同一份归档**：逐条完整性校验改走 `ZipArchive.readEntryAsync`（`inflateRaw` 交
  libuv 线程池），不再用 `inflateRawSync` 阻塞事件循环；同时加了一层**跨请求**的「已验证归档」缓存
  —— 宿主每次请求都新建 Analyzer（`makeImporter()`），实例级缓存跨请求恒不命中，于是 analyze → plan →
  execute（每改一次决策还会再 plan）会把同一个 ZIP 读入 + 全量解压 + 逐条校验 3~4 次。缓存键 =
  **路径 + 文件大小 + mtime**，且只有只读入口读它；**`executeImportPlan` 一律重新读盘 + 重新校验**
  （把「校验通过之后、写盘之前被换掉」的 TOCTOU 窗口关掉，已由 `analyzer-cache.test.ts` 的篡改用例钉住）。
  **Import de-duplication**: async entry inflation plus a cross-request verified-archive cache; the
  destructive `execute` path always re-reads and re-verifies.
- 🧠 **会话元数据按 mtime 缓存**：1.57 MB 的 `storages/session_projcache.json` 此前每次预览、每次 `/plan`
  都要解析（实测 7.3 ms/次）；现在按两份 storage 文件的 mtime 失效，**任一读不到 mtime 就不缓存**
  （宁可多读，不拿陈旧索引猜会话归属）。

### 🚦 发版门禁 / Release gates

- 🔒 **CHANGELOG 亮点段门禁挪到 `npm publish` 之前**：它原本嵌在 tag-only 的 release 步骤里 —— 漏写
  时流水线会红，**但包已经发到 npm**（同版本号不可重发）；`workflow_dispatch` 路径更是整段跳过门禁、
  照常发布。现在是 publish 之前的独立 step，两条触发路径都跑。
  **The CHANGELOG gate now runs before publishing**, on both tag and manual dispatches.
- 🔢 **「三处版本同步」有了自动化断言**：`tests/packaging-contract.test.ts` 的 `V-1` 四条（源码正则读
  `PLUGIN_VERSION`，不 import 宿主入口）——漏改任一处 `npm test` 直接红灯（变异验证：改成 `0.0.0-test`
  → 红灯）。此前只靠人记得。
- 🧪 **`tests/**` 纳入类型检查**：228 个测试文件长期在根 `tsconfig` 的 `include` 之外，实测积压 **43 条**
  错误（0 条在 `src/**`）。新增 `tsconfig.tests.json` + `npm run typecheck:tests`，43 条全部修完
  （只改 `tests/**`，未放宽任何编译选项），并接进 `ci.yml` 成为真实门禁。
  **`tests/**` is now type-checked** (43 pre-existing errors fixed) and wired into CI.

### 🎨 插件元数据 / Plugin metadata

- 🖼️ **插件管理页显示中文名/简介与自定义图标**：DSH ≥ 0.1.7-rc.1 的 `readPluginMeta` 只读两处声明 ——
  `package.json` 顶层的 `icon`（相对路径、包内、SVG/PNG/JPEG/WebP、≤ 256 KiB）与 `locale/<语言>.json`
  的 `meta.title` / `meta.description`，两者都要经 `exports` 才读得到（`locale/en.json` 是「是否扫描该
  目录」的开关）。本版本补上 `icon.svg`、`locale/{en,zh}.json` 与 `exports["./locale/*.json"]`，
  并用 `tests/packaging/plugin-metadata.test.ts` 把这些规则逐条钉住（改坏任一条都会静默退回包名 + 英文
  简介 + 默认图标）。
  **Localized name/summary + custom icon** in the plugin manager (`icon` + `locale/*.json` `meta.*`).

### 🧹 卫生 / Hygiene

- 🧽 删除 **45 个零引用 CSS class**（`config-manager.module.css` 净 −350 行）与 **17 项全仓零引用导出**
  （`as*Section` ×9、`hashFile`、`isAcquired`/`isTokenValid`、`CHECKSUMS_ALGORITHM`、硬编码中文表
  `HISTORY_KIND_LABELS` 等）。
- ♻️ 收敛逐字重复的实现：`readTextSafe` ×3 与 `sanitizeFileName`/`sanitizeFilePart` 合入宿主专用
  `src/profiles/dsh-profile-io.ts`（返回 `string | null`，调用方 `?? ''` **保住原有的 null / '' 语义差异**）；
  `isENOENT`/`isRecord` 合入**零依赖** `src/utils/guards.ts`（客户端也要 import，带 node 依赖会让整个插件
  加载失败）；`quoteGitValue` 合入 `src/utils/git-quote.ts`；`maskHighEntropy` 合入既有
  `src/security/redaction.ts`（正则保持模块私有，注释写明不得改用 `re.test()`）。
- 🎯 修复会卡住发版的 CI flake 根因：`env-lock.test.ts` 三处**固定 sleep** 改为条件等待（等 sidecar 落盘、
  等在途 `.tmp` 出现）—— 固定 60 ms 在负载下会整段错过 175 ms 退避窗口，让「release 时有在途写」这个
  前提根本不成立却照常变绿。
- 🔗 **dependabot 把 lucide 与 lucide-react 并成一个 group**：两者被
  `morph-icons.test.ts` 钉成「必须同版本」，拆成两个 PR 时先合的那个必然让 main 红灯（本次实测踩到）。

## [0.1.67] - 2026-09-30

> 本轮修 **DSH Desktop（Electron 桌面端）真实可用的最后一公里**：桌面端的保留档案 `desktop`
> 此前**装不上任何插件** —— 普通 `dsh` CLI 对 `--profile desktop` 无条件报
> `profile "desktop" is managed exclusively by the Electron application`（导入页 10 个插件全红）。
> 现在改走桌面端自带的 CLI 载体（`@deepseek-ai/dsh-desktop-host/lib/cli.js`，用桌面端内置 runtime +
> 内置 pnpm）；同时修掉「关于」页把 DSH 版本显示成磁盘上过期副本、手动安装提示写错 profile、
> 档案页对 desktop 的启动/删除/改名三个会伤到桌面端的动作。
>
> **Theme**: the last mile for the DSH Desktop (Electron) app — the reserved `desktop` profile could
> not install any plugin (the plain `dsh` CLI rejects `--profile desktop` unconditionally), so this
> release routes plugin operations through the Desktop-bundled CLI carrier; it also fixes the About
> page reporting a stale on-disk DSH version, the manual-install hint naming the wrong profile, and
> the three profile actions (launch / delete / rename) that would damage the Desktop installation.

### 修复 / Fixed

- 🖥️ **DSH Desktop：`desktop` 保留档案的插件安装/更新/卸载/恢复不再全军覆没**：DSH 把 `desktop` 定为
  Electron 独占保留档案（0.1.5-rc.1 与 0.2.0-rc.2 的 `@deepseek-ai/dsh/lib/bin.js` 里 `rejectElectronProfile`
  都是**无条件**拒绝），而本插件的插件通道恒为「重放当前宿主的 dsh 入口 / PATH 上的 dsh」—— 在桌面端里
  两者都指向普通 CLI，于是导入 10 个插件得到 10 条同样的失败。现在：
  ① 宿主进程识别（`src/utils/desktop-carrier.ts`）—— Desktop 外壳以 Node 模式拉起宿主时，
  `process.argv[1]` 就是 `…/@deepseek-ai/dsh-desktop-host/lib/index.js`，同目录的 **`cli.js`** 正是
  「普通 CLI + 桌面端保留档案例外」的入口（它以 `runCli({ manageDesktopProfile: true, packageManager })`
  启动，用桌面端内置 runtime 与内置 pnpm 跑 `runPlugin`，并在 `--profile desktop` 上跳过那道拒绝）；
  ② 目标是 `desktop` 档案时改用它（`dshArgv(profile)`），子进程补 `ELECTRON_RUN_AS_NODE=1`；
  ③ 检测不到载体时落回原路径，并由新的失败分类 **`desktop-profile-reserved`** 给出可操作说明，
  不再只丢一句英文错误。真机验证：临时 `DSH_HOME` + 空 desktop 档案 → 载体 CLI `add` 成功落盘
  `package.json` 依赖与 `node_modules`（同一命令普通 `dsh` 仍按设计拒绝）。
  **Desktop plugin operations**: when the target profile is the reserved `desktop` one, plugin
  install/update/remove now run through the Desktop-bundled CLI carrier instead of the plain `dsh` CLI.
- 🔢 **「关于」页 / 导出 manifest 的 DSH 版本不再是从磁盘上捡来的过期副本**：`resolveDshVersion` 此前只读
  `<home>/profiles/node_modules/@deepseek-ai/dsh/package.json`（web 档案 hoisted 出来的那份），真机上它是
  **0.1.5-rc.1**，而桌面端实际跑的是 **0.2.0-rc.2**（运行时在 `app.asar` 内，磁盘上别处找不到）。现在优先
  读宿主 boot 时 `provide` 的 `profileContext.installAnchor`（= 拉起本宿主的那份 `@deepseek-ai/dsh/package.json`），
  再退到当前档案的依赖树、hoisted 树。
  **DSH version**: resolved from the running runtime's install anchor first, so the About page and export
  manifests report what is actually running.
- 🧭 **插件安装失败提示里的 profile 与实际安装目标同源**：此前 message 单独调 `resolveProcessProfileName()`
  （只认 argv / 环境变量），桌面端外壳不传 `--profile` → 真机出现「安装用的是 desktop、提示却写
  `dsh plugin --profile web add …`」的自相矛盾。现在与执行日志一样取自 `ctx.target.profile`。
  **Manual-install hint**: the suggested command now names the profile the plugin was actually installed into.
- 🚫 **档案页不再对 `desktop` 做会伤到桌面端的动作**：① 「启动」此前会因为形态是 web（bundles 里确实有
  `@deepseek-ai/dsh-web-app`）而放行，spawn 出去只会拿到上面那条英文拒绝 → 现在以新的 **`managedProfile`**
  错误码在 spawn 之前拒绝，并指路「请直接在桌面端应用里打开」；② 「删除 / 重命名」desktop 档案会让桌面端
  下次启动时按 web 模板重建一个空档案（已装插件全部消失），同样一律拒绝（删除连 `allowCurrent` 也不行）；
  ③ 只装了桌面端（PATH 上没有 `dsh`）的机器，启动器此前恒 `launcherUnavailable` —— 现在回退到桌面端自带的
  CLI 载体；PATH 上的 `dsh` 仍然优先（各档案的 `node_modules` 就是那份装的，避免版本混用）。
  **Profile page**: launch/delete/rename are refused for the reserved `desktop` profile with a clear reason,
  and the launcher falls back to the Desktop carrier when no `dsh` is on PATH.
## [0.1.66] - 2026-09-28

> 本轮修两个上游回报的缺陷：**DSH 0.2.0 线不再被兼容闸静默跳过** —— 14 条 `@deepseek-ai/dsh-*` peer
> 从「带预发布版的 caret」`^0.1.0-rc.6` 改为显式上下界 `>=0.1.0-rc.6 <0.3.0-0`（caret 的真实上界是
> `<0.2.0-0`，把 0.2.0 的任何预发布版都挡在闸外，安装侧直接报 `incompatible-version`）；以及
> **DSH Desktop 的档案不再被认成 web** —— 改从宿主 boot 时 `provide` 的 `profileContext` 服务解析
> 当前档案，再退化到 `--profile` 与 `DSH_PROFILE` / `DSH_PROFILE_DIR` 环境变量。
>
> **Theme**: two upstream-reported bugs — the DSH 0.2.0 line is no longer silently skipped by the
> compatibility gate, and the desktop profile is no longer mistaken for `web`.

### 修复 / Fixed

- 🚪 **兼容闸：DSH 0.2.0 线不再被静默跳过（issue #53）**：DSH ≥ 0.1.7 的加载器会对每一条名字为
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 跑 `semver.satisfies(runtime, range, { includePrerelease: true })`，
  任一不满足即**整份 bundle 被跳过**（stderr 只多一行 `skipping profile bundle`，进程照常起来、功能静默消失）。
  旧声明 `^0.1.0-rc.6` 的真实区间是 `>=0.1.0-rc.6 <0.2.0-0` —— 带预发布版的 caret 会把上界钉在下一个 minor 的
  `-0`，于是 `0.2.0` 的**任何**预发布版（含 `0.2.0-rc.1`）都在区间外。14 条 peer 统一改为显式区间
  **`>=0.1.0-rc.6 <0.3.0-0`**（`-0` 把整条 `0.2.x` 含预发布版锚进区间，同时挡住 `0.3.0-0` 及以上）。
  证据：用 `@deepseek-ai/dsh-app-boot@0.2.0-rc.1` 的 `evaluatePluginCompatibility` 真跑本插件 manifest
  —— 改前 + runtime `0.2.0-rc.1` = INCOMPATIBLE（14 条全中），改后 + `0.1.5-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1`
  全部 COMPATIBLE；回归护栏 = `tests/packaging-contract.test.ts` 的 P-3。
  **Compatibility gate**: all 14 `@deepseek-ai/dsh-*` peers now use the explicit range `>=0.1.0-rc.6 <0.3.0-0`
  instead of the prerelease caret whose real upper bound (`<0.2.0-0`) excluded every 0.2.0 prerelease. Verified
  by running DSH's own `evaluatePluginCompatibility` against this manifest.
- 🖥️ **档案识别：DSH Desktop 的档案不再被认成 web（issue #52）**：Desktop（Electron）外壳拉起宿主时
  **不传 `--profile`**，插件此前只认 argv → 一律回退 `web`，于是「插件清单来源」「档案页当前运行标记」
  「备份/导出/恢复目标」全落到 `profiles/web`（desktop 里装的插件永远看不到）。现在解析链为：
  `config.profile` → 宿主 boot 时 `provide` 的 **`profileContext` 服务**（DSH ≥ 0.1.7，`{ name, dir, … }`，
  唯一权威）→ `--profile` 启动参数（新增支持 `--profile=<name>` 形态）→ `DSH_PROFILE` / `DSH_PROFILE_DIR`
  环境变量 → `web`；任一来源缺失/非法都继续回退、绝不抛错（新纯函数 `profileNameFromProfileContext` /
  `resolveProfileNameFromEnv` / `resolveProcessProfileName`，均有单测）。顺带把「关于 → 插件清单来源」的
  排查提示改为同时点名 profileContext / `--profile` / `DSH_PROFILE`。
  **Profile detection**: the Electron shell never passes `--profile`, so the plugin now resolves the running
  profile from the host-provided `profileContext` service first and only then falls back to argv and the
  `DSH_PROFILE` / `DSH_PROFILE_DIR` environment variables.
## [0.1.65] - 2026-09-27

> 本轮两件大事：**档案终于能真正切换** —— 「启动 / 停止该档案的独立实例」取代了那个写进文件、
> 却没有任何消费者的「下次启动」标记；以及**产品定位收敛为迁移 / 同步 / 市场** —— 灾备快照线
> （自动快照 / 撤销-重做 / 快照库）整体下线，只保留**崩溃归因 + 救援模式**并并入
> 「备份与快照 → 事故恢复」。此外逐条修掉真机实测出来的 UI 缺陷（区块间距、按钮加载反馈、
> 弹窗跳闪、勾选口径、图标符号残留）。
>
> **Theme**: profiles can finally be switched for real — "launch / stop an independent instance"
> replaces the next-launch marker that nothing ever read; and the scope narrows to migration / sync /
> market (the disaster-recovery snapshot line is retired; crash attribution and rescue mode stay,
> merged into "Backups & snapshots → Incident recovery"). A batch of real-machine UI defects is fixed
> along the way.

### 变更 / Changed

- 🧭 **灾备收敛：删除「自动快照 + 撤销/重做 + 快照库」，只保留事故恢复（崩溃归因 + 救援模式）**：
  产品定位收敛为迁移 / 同步 / 市场后，`core/{watcher,undo,config-state,config-snapshot,config-lifecycle}.ts`、
  `client/lifecycle/`、`ui/lifecycle-view.ts` 与 `/lifecycle` 路由整体删除（含 `LIFECYCLE_ENABLED` /
  `SHOW_LIFECYCLE_NAV` 两个开关）；崩溃归因（`/crash`）与救援模式（`/rescue`）原样保留并并入「备份与快照 →
  事故恢复」子 tab —— 崩溃横幅去掉已随快照库下线的「一键回退到最后正常快照」，改为引导「进救援模式」与
  「从最近备份恢复」。`boot-state.json` 搬到独立目录 `<dataDir>/boot-state/`（老位置一次性搬迁）；旧的
  `panel='lifecycle'` 持久化值自动落到事故恢复子 tab；**已有 `config-snapshots/` 数据不删除**，只停止采集与展示。
  **Disaster-recovery line retired**: automatic snapshots / undo-redo / the snapshot store and the `/lifecycle`
  route are removed (scope narrowed to migration / sync / market). Crash attribution and rescue mode stay,
  merged into the Incident recovery sub-tab; boot-state moves to its own directory (legacy location migrated
  once); existing snapshot data is left untouched on disk.
- 🗂️ **档案页去掉「设为下次启动」**：DSH 根本没有「默认 / 下次启动 profile」这种状态 —— profile 只由启动
  参数决定（`dsh <名>` / `--profile <名>`；`dsh web` 是硬编码别名），启动日志与状态文件里没有任何
  「上次用的是哪个」，所以那个标记**一个消费者都没有**。真机定位「设 PROVA 为下次启动 → 重启仍进 web」之后，
  `<dataDir>/next-profile` 标记、「设为下次启动」按钮与 `POST /profiles/select` 路由一并移除
  （它只会让用户以为切换成功了）。真正的切换只有两条：本页的「启动该档案」，或把你的启动命令 /
  快捷方式改成 `dsh --profile <name>`。
  **The "set as next launch" marker is gone**: DSH has no such state (the profile comes only from the launch
  arguments), so the marker had no consumer at all; the file, the button and the `/profiles/select` route are
  removed. Real switching is either "launch this profile" on this page, or pointing your own launch command
  at `dsh --profile <name>`.
- 🎛️ **视觉打磨**：区块间距改由容器统一提供（`.viewBody` 纵向 `gap: 10px` 并归零直接子元素的外边距 ——
  此前「小节标题 → 面板」「说明 → 横幅」恒为 0，视觉上紧贴）；动效值统一到 `--cm-motion-*` 令牌
  （页面 / 弹窗 / 抽屉 / 通知入场、折叠、视图切换、列表入场、骨架 shimmer），
  `prefers-reduced-motion: reduce` 下关掉装饰性动效 —— 旋转与不定态进度**刻意保留**，它们承载「正在进行」本身。
  **Visual polish**: section spacing is owned by the container (`gap` instead of per-block margins) and motion
  values are unified into `--cm-motion-*` tokens; decorative motion is disabled under
  `prefers-reduced-motion`, while spinners and indeterminate progress stay.

### 新增 / Added

- 🗂️ **档案「启动 / 停止」= 另起一个独立实例（真正可用的档案切换）**：档案行的按钮按运行状态换形态 ——
  没有实例 → `启动`（`dsh --profile <名> --port <空闲端口>` detached 拉起，从子进程日志抓带 token 的
  认证 URL 并 HTTP 探活，就绪后给「打开新实例」）；有实例在跑且不是自己 → `停止`（先请求退出、宽限期后
  才终止进程树，如实回报 graceful / killed / already-stopped）；**就是当前这个实例** → `当前运行`
  （禁用，tooltip 指向关窗口 —— 停自己会死在响应途中）。实例台账落 `<dataDir>/launches.json`，
  界面上的「启动 ↔ 停止」就是它的投影，所以插件拉起的进程永远关得掉。**只对 web 形态开放**：
  headless / generic 档案点「启动」给 `Banner kind="warn"` + 等宽终端命令 + 复制，**绝不静默失败**
  （spawn 出去是个用户看不见的进程）；失败一律带码：`notLaunchable` / `launcherUnavailable` /
  `launchFailed`（附子进程日志尾部）/ `alreadyRunning`。launch / stop **刻意不走 mutation gate**
  （它们不写任何配置文件，而 gate 会把环境锁占到 handler 返回 —— 真机实测那 20 秒里导入 / 恢复全被 423 挡住）。
  **Launch / stop any profile as an independent instance**: the row button flips 启动 ⇄ 停止 with the running
  state; web-shaped profiles only (others get the terminal command instead of a silent failure). Instances are
  recorded in `<dataDir>/launches.json`, so whatever the plugin started can always be stopped; every failure
  carries a code. Launch/stop deliberately bypass the mutation gate.
- 💓 **「哪些档案在跑」= 实例台账 ∪ 每个实例自报的心跳**（真机 bug：从 web 启动 cmtest 后，在 cmtest 的
  界面里还能再启动 web —— web 是手动敲起来的，不在任何台账里）：每个加载本插件的实例启动时往
  `<dataDir>/running/<profile>.json` 自报 `{pid, port, startedAt, updatedAt}`（20s 刷新 / 60s 判死，
  pid 死或过期即清理，**绝不写认证 token**）。于是手动 `dsh web` 起来的档案也会被认出来：得到
  「已经有一个实例在跑」而不是再开一个；别的实例也能从这个界面停掉（同一套优雅 → 强杀实现）；
  有实例在跑时**拒绝物理删除**该档案。
  **"Which profiles are running" = the ledger ∪ each instance’s own heartbeat**: a manually started
  `dsh web` is detected too (no duplicate launch), other instances can be stopped from this page, and
  deleting a profile with a running instance is refused. The heartbeat carries pid/port only — never the token.
- 📄 **档案页新增「复制」**：把某个 DSH profile 整份拷成新档案（`POST /profiles/copy`），package.json 的
  `name` 跟随新档案名。**含不含 node_modules 由用户定**：勾选（默认）时副本立刻可用 —— 实测 285 MB /
  1.7 万条目 ≈ 30 秒（真机 cmtest 档案），且走 async `fs.promises.cp`（cpSync 会把宿主事件循环卡住二十多秒、
  整个界面冻结）；不勾选则秒级只搬清单与 patch，副本启动前需要装依赖 —— 回执据此带 `depsNotInstalled`
  告警与 `dsh plugin --profile <副本> install` 命令，绝不静默成功。拷完还会把副本里**指向源档案内部**的链接
  重指向副本自身（实测 cmtest 的 48 个 junction 里 37 个在树内，重指向后删掉源档案副本依然自解）；指向源档案
  之外的链接（`link:` 依赖指向用户仓库）保持原样。中途失败回滚目标目录，不留半套档案。
  **Duplicate any DSH profile** from the Profiles tab (`POST /profiles/copy`): the manifest `name` follows the new
  directory; copying node_modules is opt-in-but-default (285 MB ≈ 30 s on a real profile, async `fs.promises.cp` so
  the host event loop keeps serving), and a dependency-less copy reports `depsNotInstalled` with the exact install
  command instead of pretending to succeed. In-tree junctions are re-pointed at the copy so it survives deleting
  the source, and a failed copy rolls back its target directory.
- 🔁 **救援横幅重启后换文案（真机反馈：重启之后还在要求重启）**：宿主 `/rescue` 新增 `applied` —— 判据是
  「本进程启动时刻晚于进入救援的时刻」（`rescueAppliedInThisProcess`，纯函数、可单测）。未重启 → 仍是
  「请重启 DSH 使其生效」；**已重启 → 改为「救援模式已开启（{time}）—— 本次启动只挂载了 DSH 核心与本插件」**，
  第二行提示同步改为「其它用户插件本次未加载；退出救援模式后同样需要重启 DSH 才会恢复」。旧宿主缺 `applied`
  → 保守回落成「请重启」（不会把未生效说成生效）。
  **Rescue banner now changes after the restart**: the host reports `applied` (this process started after rescue
  was entered) and the banner stops asking for a restart that already happened; a missing field degrades to the
  old wording.
- 🧩 **新共享原语**：`Select`（自绘下拉，替换**全部 15 处**原生 `<select>` —— `appearance: none` 只改触发器，
  展开后的弹层仍是系统控件：深色主题下是亮底系统菜单，且吃不到 `--dsw-*` token；自带完整键盘语义 / ARIA /
  贴边翻转，索引推导放在 `src/ui/select-model.ts` 可单测）、`Skeleton`（整块首屏加载的骨架，与 `Spinner` 的
  分工是硬的：**有布局轮廓 → 骨架，没有 → 转圈**，首屏不再先空一片再整页跳变）、`Collapse` / `ViewSwitch`
  （折叠容器展开与收起**两端**都有高度动画；视图切换入场）、`CopyButton`（复制 → 已复制）。
  **New shared primitives**: a self-drawn `Select` (replaces all 15 native selects, with real keyboard/ARIA
  semantics), `Skeleton` (first-paint placeholders; the split with `Spinner` is: outline available → skeleton),
  `Collapse`/`ViewSwitch` and `CopyButton`.
- 🎞️ **图标形变（morphicons）试点**：折叠展开的 chevron 与「复制 → 已复制」在状态切换时做物理形变
  （`common/Icon.tsx` 的 `ExpandChevron` / `CopyStateIcon`）。**收录判据唯一**：该节点上的图标必须随用户可见的
  状态变化而改变 —— 静态图标套形变是纯体积亏损，因此**不铺到导航与语义图标**。两条硬约定：
  `reducedMotion="user"`（morphicons 缺省会无视系统减弱动效设置）、临界阻尼弹簧（ζ=1.0 无过冲、≈1.6 倍速）。
  体积约 +40KB raw / +13KB gzip（未压缩产物口径）；vanilla `lucide` 与 `lucide-react` **必须同版本**，
  否则静态/形变会呈现两套图形。
  **Icon morphing (morphicons) pilot**: only where the icon genuinely changes with user-visible state (the
  collapse chevron and copy → copied) — never on static or semantic icons. `reducedMotion="user"` plus a
  critically damped spring are hard requirements, and the `lucide`/`lucide-react` versions must match.
- 📣 **反馈入口**：README 新增「反馈」一节（UI 问题 / Bug / 功能建议分别对应 Issue Form，安全问题走私密报告），
  「关于」页的「复制环境信息」把插件版本 / DSH 版本 / 平台一并给到，方便直接粘贴进 Issue；Issue 模板拆成中英两套
  （6 份）并加中英一致性护栏测试。
  **Feedback entry points**: a Feedback section in the README (UI issue / bug / feature forms plus a private
  security advisory), an About-page "copy environment info" button, and bilingual issue forms guarded by a
  consistency test.

### 修复 / Fixed

- 🆘 **救援模式真的会禁用其它插件了（真机复现的致命缺陷）**：救援把 `dsh.profile.bundles` 收窄为
  「DSH 核心 + 本插件」后，**约 1.5 秒就被改回原样** —— 用户重启 DSH，插件一个不少地回来，救援名存实亡。
  根因是插件自己的 `reconcileBundles`（`listInstalledPlugins` 读插件清单时必跑，导出预览 / 自动快照的
  `plugins` 分区 / 插件页都会触发）按「声明 `dsh.bundle.patch` 的依赖必须出现在 `bundles`」把用户插件
  原样加回。修法两条并用：① 进入救援时把这些包**同时从 profile 的 `dependencies` 摘掉**（包本身不卸载，
  退出时整份 `package.json` 从备份逐字节还原），manifest 自洽后任何 reconcile 都无从加回；
  ② `reconcileBundles` 在救援激活期间**一律停手**（新增同步探测 `isRescueActiveSync`），因为救援是操作者
  的显式决定，这段时间 bundle 清单归它所有。四阶段真机验证：救援前两个用户插件都挂载 → 进救援后清单收窄
  且持续 6 秒不再被改写 → 重启后两个插件**都不挂载**（DSH 正常起来，组合树里只剩 `config-manager`）→
  退出救援三处文件逐字节还原 → 重启后两个插件都回来。
  **Rescue mode now actually disables other plugins (fatal real-machine defect)**: narrowing
  `dsh.profile.bundles` to "DSH core + this plugin" was silently undone about 1.5s later by the plugin's
  own `reconcileBundles` (run on every plugin-list read: export preview, the auto-snapshot `plugins`
  section, the plugin page), which re-adds any dependency declaring `dsh.bundle.patch`. Fixed twice over:
  entering rescue also strips those packages from the profile's `dependencies` (nothing is uninstalled;
  `package.json` is restored byte-for-byte on exit), and `reconcileBundles` now stands down entirely while
  rescue is active (new sync probe `isRescueActiveSync`). Verified in four phases on a real isolated instance.
- 🔐 **环境锁的 PID 复用判据（issue #36）**：被强杀 / PID 被复用留下的 `environment.lock` 此前只能靠
  「心跳长过期」启发式判定，于是 `recover-stale-lock` 在真实场景里可能拒不动手。现在优先用**操作系统的进程
  创建时间**做身份比较（linux 读 `/proc/<pid>/stat` 的 starttime，不 spawn 任何进程；win32 取 `Get-Process`
  的 `StartTime.ToFileTimeUtc()`；macOS 用 `ps -o lstart=`），**拿不到才退回**长过期启发式；查询失败 / 超时
  一律按「拿不到身份」处理（绝不抛错把分类推成 UNKNOWN_STATE，那会让「长过期可回收」这条路径失效）；
  自身身份在进程内缓存（成功与失败都缓存），于是每次 acquire 不再 spawn shell。
  **PID-reuse detection for the environment lock (issue #36)**: stale-lock recovery now compares the OS process
  creation time first (linux `/proc`, win32 `Get-Process`, darwin `ps`), falling back to the long-expired
  heartbeat heuristic only when the identity cannot be read; a failed or timed-out query never throws.
- 🪟 **弹窗不再「先闪现在别处、再跳到页面中心」**（真机实测）：Radix `Portal` 在容器为空时会回退
  `document.body`，而该判定发生在它的 layout effect（**首次绘制之前**）—— 用 `useEffect` 查根节点时，
  查询已在绘制之后，于是「弹窗与 `open=true` 同一次 commit 挂载」的路径（档案详情目标跨刷新保留、
  切页签回来面板重挂、宿主重挂 section）会先在 body 里画一帧（此时 `position:fixed` 相对视口居中，
  而不是相对宿主面板），随后才被搬进插件根节点 = 可见的跳闪。修法三条：渲染期同步解析容器
  （惰性 `useState`）→ `useLayoutEffect` 兜底 → **容器未知时不渲染 Portal**（宁可晚一帧，也绝不走 body 回退）。
  **No more dialog flicker before it lands in the panel**: the portal container is resolved synchronously during
  render, with a `useLayoutEffect` fallback, and no portal is rendered at all while the container is unknown —
  never falling back to `document.body`.
- 🗂️ **档案面板的进行中态不再丢**（真机两轮定位）：`launching / stopping / creating / renaming / deleting`
  搬进 run-store 的档案切片（`PanelState = ProfilesStoreSlice`），面板用 `useSyncExternalStore` 订阅读取，
  **不另存 `useState` 副本**。此前留在组件 state 里，切页签（卸载）就归零 → 回来按钮变回「启动」，
  用户以为没点上而重复点；只写 store 不订阅时，上一次挂载遗留的请求（启动最长 20s，必然踩到）回来界面不刷新
  → 「启动中」一直转。进行中态 / 弹窗目标 / 带 token 的启动回执**刻意不落 sessionStorage** ——
  发起请求的页面已随刷新销毁，重放一个等不到回执的转圈只会骗人。
  **In-flight profile states survive a tab switch**: they now live in the run-store profiles slice, and the panel
  subscribes to it with `useSyncExternalStore` instead of keeping a `useState` copy that resets on unmount.
- ☑️ **勾选态只有一个口径**（真机实测：点「全不选」后子项仍然打勾）：渲染层一律走
  `unitChecked(sel, section, unitId)`（先看分区、再看排除集），分组的计数与三态同口径 —— 稀疏表示下
  「不在排除集里」**不等于**已勾选（分区整体没勾时同样成立），直接判 `!excluded.includes(id)` 会渲染出
  「分区已选 0/13、13 个子项却全部打勾」的自相矛盾。
  **A single source of truth for checked state**: rendering goes through the section-aware helper (section first,
  then the exclude set), so "not excluded" no longer renders as checked when the whole section is off.
- 📏 **间距紧贴的三处修复**（用户实测）：区块间距改由 `.viewBody` 的 `gap` 统一提供（见「变更」）；
  `.kvRow + .actionRow` 补 `margin-top: 8px`（档案页「运行状态」里的停止按钮此前贴在横线上）；
  `.historyRow` 补左右 `8px`（时间 / 摘要紧贴滚动容器边框，实测只剩 1px = 边框本身）。
  **Three spacing fixes**: block spacing comes from the container `gap`; the action row after a key/value row
  gets its missing top margin; history rows get horizontal padding.
- ⏳ **加载反馈统一**：`Button loading` 由原语自动前置 `Spinner`（同时 `disabled` + `aria-busy`）——
  此前有没有加载图标取决于每个调用点是否记得写，漏写处只换文案、毫无进行中反馈（用户实测：同一排按钮
  有的转圈有的不转）；`Spinner` 的环改成 **SVG 几何**（两个 `<circle>`：底环 + 实色圆弧）而不是
  `border + border-radius` —— 13px 的盒子上 2px 边框占直径 15%，且只有一条边实色，栅格化后视觉上只剩
  一条亮弧、形状读不出来（用户反馈「加载图标不是圆形」）；着色一律 `currentColor`，否则在主色按钮上
  蓝画蓝、图标「隐形」（只看到按钮莫名变宽）。
- 🚫 **图标层护栏 + 文本符号清理**：`RestorePlanView` 里手写的 `▸/▾` 文本符号换成形变 chevron，
  并新增 `icon-layer-guard.test.ts` 扫全部 UI 源码的**字符串字面量**（注释与测试夹具除外），
  发现形状符号即失败 —— 这条规则此前只是文档里的散文，所以那个残留长期没被发现。

### 测试 / Tests

- 档案线：`dsh-profile-launcher.test.ts`（挑端口 / 抓认证 URL / 探活 / 失败码 / 只对 web 形态开放）、
  `dsh-profile-runtime.test.ts`（心跳写入与过期 / 死 pid 清理 / **绝不写 token**）、
  `run-store.test.ts` 新增「档案切片键集合 + 镜像不漏字段 + 带 token 的回执不落盘」。
  New profile-side regressions: the launcher (port picking, auth URL, readiness, failure codes, web-only),
  the runtime heartbeat (refresh/expiry, dead-pid cleanup, never the token) and the run-store slice shape.
- UI 线：`select-model.test.ts`（键盘索引推导）、`morph-icons.test.ts`（形变必须是纯 90° 旋转、无缩放，
  端点恰好落在两个图标上，且 `lucide` 与 `lucide-react` 版本相等）、`icon-layer-guard.test.ts`、
  `selection-model.test.ts` 的勾选口径回归。
- 锁线：`env-lock.test.ts` 注入平台与命令执行器覆盖 linux / win32 / darwin 三个分支（拿不到身份即退回启发式）、
  `tests/cli/lock-recover-dir.test.ts`（被强杀留下的锁必须真能被 `recover-stale-lock` 回收）。
  New lock regressions: the OS-identity probe across linux/win32/darwin (falling back to the heuristic) and a
  CLI-level test that a kill-left-behind lock is really recovered.
- 接线守卫：`incident-wiring.test.ts`（崩溃归因 / 救援模式 / `boot-paths` 的源码级接线）；
  路由快照更新为 68 条（`+ /profiles/launch`、`+ /profiles/copy`、`− /lifecycle`、`− /profiles/select`）。
- Source-level wiring guards plus the updated 68-route parity snapshot.

## [0.1.64] - 2026-09-24

> 本版主题是**会话跨机可信迁移 + 长任务可观测可终止 + 同步通道的会话管理**：一台机器的备份导到另一台，
> 历史对话要在工作区里**真的看得见**（导出连带工作区、导入按路径映射改写会话首帧 cwd 再归位目录、
> 把本次真正带走的会话声明进工作区记录）；所有长任务收敛到一个「运行」中心，能看进度、能等待你选择、能终止，
> 残留的环境锁也能显式回收；同步通道补齐远端保留（GFS）、逐会话点名、内容寻址外置与删除墓碑，
> 并修掉 issue #38 追加的两条凭据体验问题。
>
> **Theme**: sessions now migrate across machines believably (workspaces travel with them, the session log's
> first-frame cwd is rebased and the directory relocated, and the sessions actually carried are declared in
> their owning workspace records); long-running tasks get one "Runs" center with progress, decisions,
> cancellation and stale-lock recovery; the sync channel gains real session management (GFS retention,
> per-session picking, content-addressed blobs, deletion tombstones), plus issue #38's follow-up credential fixes.

### 新增 / Added

- 🗂️ **会话跨机迁移（issue #45）**：**导出**时自动连带会话所属工作区（勾了会话就把 `workspaces` 清单一起读，并做双向联动勾选），收尾把**本次真正带走的会话**按 cwd 目录键声明进所属工作区记录（`export.sessionsDeclaredInWorkspaces`）；**导入**时先按 `manifest.sourceHome` 自动重定基，再把用户路径映射应用到会话日志**首帧 cwd** 并归位到 `projectKeyOf(映射后 cwd)` 目录（搬不动就回滚首帧），最后把「记录声明的 ∪ 包内带数据的」会话登记进工作区。文件集合分区（sessions / pluginFiles / skills …）的 `relativePath` 是**身份不是配置**，永不参与导入期前缀映射——否则会话会落到 DSH 下次启动直接报错的目录里。DSH 已起不来时走离线 CLI：`dsh-config-manager sessions repair [--fix] [--keep <dir>] [--map old=new]`。
  Sessions migrate across machines (issue #45): export now carries the workspaces owning the selected sessions and declares the sessions it actually took into those records; import rebases on `manifest.sourceHome`, applies your path mappings to the session log's first-frame `cwd`, relocates the directory to `projectKeyOf(mapped cwd)`, and registers "declared ∪ bundled" sessions. File-collection partitions never take part in import-time prefix mapping (their paths are identity, not configuration). When DSH can no longer start, use the offline CLI `dsh-config-manager sessions repair`.
- 🛠️ **「运行」中心**：导出 / 导入 / 自动同步 / 一键同步 / 定时备份 / 快照恢复 / 档案切换 / 事故恢复集中在一处，实时显示进度与「成功 / 警告 / 失败 / 跳过」计数，并区分「进行中」与「等待你选择」；进行中的导入可**终止**，在「回滚到导入前」与「保留已应用项」之间二选一（后者紧接着做一次启动安全审计，并如实说明它只能降低、不能消除 DSH 启动失败的概率）；长时间到不了安全点时给出「跳过当前插件 / 重启 DSH」这类可执行建议；**残留环境锁**（持有进程已确证死亡）可显式回收，活锁只提示、不回收。已结束的任务保留 30 分钟，完整审计仍在「迁移历史」。
  **Runs center**: export / import / autosync / one-click sync / scheduled backup / snapshot restore / profile switch / incident recovery in one place, with live progress, ok-warn-fail-skip counts, and a clear split between "running" and "waiting for your choice". A running import can be cancelled, and you choose between rolling back to the pre-import state and keeping what was already applied (the latter immediately runs a boot-safety audit, which lowers but cannot remove the chance of a DSH boot failure). Stale environment locks (holder proven dead) can be reclaimed explicitly; live locks are only reported. Finished runs stay visible for 30 minutes.
- 🔐 **凭据迁移不再逐项点头（issue #38 追加）**：凭据计划项的判据统一为「**值的有无**优先于本机状态」——**随包 / 随快照带来的真实值**（`security/secrets.enc` 或 `SyncSnapshot.credentials` 解出的 ref）一律进计划并在执行期写回，**不因本机已配置而跳过**（跳过 = 用户以为密钥导入了、其实没写），文案为「随加密备份恢复」；**只有 ref 名而无值**时，本机已配置 → 直接 `Skip` 并说明「保留本机值、不再索要补录」（此前会为已存在的重复密钥反复提示），本机没有 → 才要求补录。同步确认列表的批量按钮改为覆盖**全部待确认项**（含「缺密钥」的凭据迁移项，只排除硬失败项）——此前批量只认冲突项，含 N 条凭据迁移项时按钮恒灰、只能逐条勾选。
  **Credential migration no longer needs item-by-item clicks (issue #38 follow-up)**: credential plan items now follow "value presence beats local state" — a real value carried by the archive or snapshot is always planned and written back (never skipped just because the machine already has that ref, which would silently drop it), while a ref that only has a name becomes a `Skip` when the machine is already configured, and only asks for re-entry when it is not. The sync confirmation list's bulk buttons now cover every pending item (including "missing credential" migration items), leaving only hard failures for individual handling.
- 🧭 **同步通道的会话管理**：① **远端保留接 GFS**——`retentionPolicy` 驱动远端清理，与本地备份共用同一份保留策略（缺省 `keepLast=10`，与旧硬编码上限逐字等价），刚推送的快照恒保留，「会话寿命 = 最近 10 次 push」的问题消除；② **逐会话点名**——「历史对话」既可只带最近 N 个，也可逐个勾选（点名优先于数量上限，一个都不勾 = 回到最近 N 个），只勾会话却没勾工作区时给出明确警告；③ **内容寻址外置**——`sessions` 在通道侧外置为 `blobs/<sha256>` + 引用文件，命中已有哈希即零传输，读回缺 blob **硬失败**（绝不降级为空分区），加密快照永不外置；④ **删除墓碑**——新删的会话累积成 `manifest.deletedSessions` 随快照传播，拉取 / 预览 / 合并按墓碑把命中的会话从**将要导入的载荷**里剔除（不删除本机数据），剔除与登记都写进报告，绝不静默。
  **Sync-channel session management**: remote retention now follows the same GFS policy as local backups (the just-pushed snapshot is always kept); session sections can be picked per conversation, not only "latest N"; session payloads are externalized into a content-addressed `blobs/<sha256>` store (a hash hit means zero transfer, and a missing blob is a hard failure rather than an empty section; encrypted snapshots are never externalized); and deletions travel as tombstones that remove the affected sessions from the payload about to be imported without ever deleting local data — every removal and registration is reported, never silent.
- 📄 **导入过程可读**：「导入向导」拆成步骤组件并新增**导入日志面板**（成功 / 跳过 / 警告 / 失败计数 + 「只看问题」过滤）；路径问题按「需指定新位置 / 跨平台路径 / 基础路径不同」分类提示；自动重定基（备份来自另一台机器的 `$DSH_HOME`）在预览里标注为「无需手工映射」；会话与工作区改为**联动勾选**——勾会话自动带上它所属的工作区、取消工作区连带取消它的会话（方向显式传入，避免两条规则互相抵消）。
  **Readable imports**: the import wizard is split into step components and gains an import log panel (ok / skip / warn / fail counts plus a "problems only" filter); path issues are grouped into "needs a new location", "cross-platform path" and "different base path"; an automatic rebase (backup from another machine's `$DSH_HOME`) is labelled as needing no manual mapping; sessions and workspaces are now coupled in the picker — checking a session checks its workspace, unchecking a workspace unchecks its sessions.

### 修复 / Fixed

- **导入历史对话后在工作区里看不见（issue #45 ③，真机事故）**：导出只搬了注册表原样的 `sessionIds` —— 而它的覆盖率极低（真机实测 **570 条会话里只有 23 条**），用户勾选的对话往往**不在**里面；导入侧却要为记录里那 156 个「一个都没被导出」的 id 逐个登记失败，还把原因误报成「cwd 未映射」（照它改映射永远无效）。现在：**导出侧**按 cwd 目录键把本次真正带走的会话**声明进所属工作区记录**（按裸键去重、只增不减、写日志侧原名，报告出 `export.sessionsDeclaredInWorkspaces`）；**导入侧**登记目标 = 记录声明的 ∪ 包内带数据的，失败按「这次有没有带它的数据」分类（包外会话不再计为失败，改为一条信息行），并对每个会话先试声明形态、再试另一种命名形态（`session-<uuid>` ↔ 裸 `<uuid>` —— DSH 只认会话日志首帧 header 的 `id`）。
  Sessions imported from a backup no longer stay invisible: the exporter now **declares the sessions it actually carries** in their owning workspace records, and the importer registers "declared ∪ bundled" sessions, classifies failures by whether the data was in the backup, and retries the other id spelling (`session-<uuid>` ↔ bare `<uuid>`).

### 其它 / Also

- 🧱 **宿主路由收敛**：全部路由改由 `src/routes/` 的 `endpoint()` kit 声明（回环 + 同源围栏、方法白名单、统一 JSON 解析与错误映射都在注册点统一包装），`src/index.ts` 只保留 8 条路由与装配；新增源码级守卫扫**全部**路由源（围栏 / 一致性 / 通道），避免只扫入口而静默失去覆盖。
  **Host routes**: every route is now declared through the `src/routes/` `endpoint()` kit (loopback + same-origin fence, method whitelist, unified body parsing and error mapping at the registration point), with source-level guards scanning all route sources.
- 📐 **会话日志的字节改写只在宿主侧**：新增 `src/utils/zstd-frame.ts`（多帧 zstd 纯字节工具）与 `src/utils/session-log.ts`（首帧 cwd 读取 / 改写 / 发布前自检 / 失败回滚）；Windows 上 rename 覆盖前先关闭读句柄，否则 EPERM。
  **Session-log byte rewriting stays host-side**: new `zstd-frame.ts` (multi-frame zstd byte tool) and `session-log.ts` (first-frame cwd read / rewrite / pre-publish self-check / rollback); on Windows the read handle is closed before the rename.
- 📄 **对外契约与文档同步**：新增 `docs/spec/sync-channel-v1.md`（同步通道快照格式：远端布局 / 内容寻址外置 / 删除墓碑）；`known-gaps.md` 登记 **G-19**（blob 外置不做协议协商）与 **G-20**（墓碑剔除不删本机数据）；`AGENTS.md` / `DESIGN.md` / `README` 同步更新。
  **Contracts and docs**: new `docs/spec/sync-channel-v1.md` (sync-channel snapshot format: remote layout, content-addressed blobs, deletion tombstones); `known-gaps.md` registers **G-19** and **G-20**; `AGENTS.md` / `DESIGN.md` / the READMEs are updated.

- 报告文案带上**真实失败原因**（此前 `attachSession` 的异常被 `catch {}` 吞掉，只剩一句对原因的猜测）；新增 `export.sessionsDeclaredInWorkspaces` 与 `adapter.workspaceSessionsOutsideBundle` 两条 zh/en 文案。
- Report messages now carry the **real failure reason** instead of a guess; two new bilingual messages were added.

## [0.1.63] - 2026-09-21

> 0.1.62 的**跟进版**：采纳外部贡献者 [PR #44](https://github.com/xiajiajun516/dsh-config-manager/pull/44) 的两点稳健性改进，
> 并加固一个**会卡住发版**的 CI flake。无新增功能、无破坏性变更。

### 🐞 采纳 PR #44（外部贡献者 lux-liang）的两点

- **空错误文本回退**：`failed` 且宿主错误文本为 `undefined` / 空串 / **全空白**时改为回退通用文案。0.1.62 用的
  `run.error ?? null` 只挡 `undefined` / `null`，空串会渲染出「备份失败：」这种半截提示（`src/ui/backup-schedule.ts`）。
- **未知 `skipReason` 不再暴露机器 token**：归一为本地化通用说明（`overview.quick.backupSkippedOther`），
  与仓库既有纪律一致（`describeSkipReason` 对 `mutation-locked` 的同类处理：用户可见文本不留裸 token）。
- 这两条来自 PR #44 的评审（贡献者把状态判定放进 `src/ui/overview-view.ts` 纯函数的做法方向正确，
  但内容已被 0.1.62 覆盖，故该 PR 作为 superseded 关闭）；credit 同时记在 0.1.62 段的「🙏 致谢」与两份 README
  新增的「🙏 贡献者」小节。

### 🧪 修复会卡住发版的 CI flake（`src/utils/env-lock.test.ts`）

- **现象**：`§11.1-c6`「sleep 70ms ×3，再断言 heartbeat `seq` 递增」是**墙钟假设** —— heartbeat 定时器在 CI
  负载下可能整段采样窗口都没触发，实测失败 `heartbeat seq 应递增: 2,2,2`（同一 commit 重跑即过）。
  产品侧 `seq` 用 `++this.heartbeatSeq`，单进程内严格单调，**问题只在测试用固定 sleep 猜定时器何时跑**。
- **修复**：新增 `waitHeartbeatSeqAbove()` —— **有界等待观测到的推进**（20ms 轮询 + 5s 上限），并补「观测样本严格单调」
  与「有界等待内至少推进一次」两条断言；`§11.1-c9` 的同类固定 sleep 一并加固。
- **为什么必须修**：`publish.yml` 会跑全量测试且 fail-fast —— 这类 flake 迟早在某次发版时把 tag 卡红。
- **验证**：6 个 CPU 满载进程下连跑 10 次全绿（加固前该断言依赖负载，无法保证）；
  `typecheck` / 全量 2152 项 / `build` / build 后 bundle 护栏全绿。

### 🎯 亮点 / Highlights (zh)

- 🔧 **社区反馈落地**：外部贡献者指出的两处细节（空错误文本、未知原因裸 token）已修复并发布。
- 🙏 **署名补记**：为让 GitHub 的 Contributors 列表如实计入这次贡献，PR #44 的提交 `1248200` 随后通过一次
  **「保留其提交、树取主线」**的合并（`122317b`）成为 `main` 的祖先 —— 该合并**不取其代码**（合并后的树与
  `v0.1.63` 逐字节一致），只用于记录署名；GitHub API 已确认「these commits are already merged」。
- 🧪 **发版更稳**：修掉一个只在负载下出现、却会阻塞 `publish.yml` 的时序 flake。
- 🙏 **贡献者名单**：两份 README 新增「🙏 贡献者」小节（含本次 PR 与三条 issue 的报告人）。

### Highlights (en)

- 🔧 **Community feedback shipped**: the two details an outside contributor flagged (empty error text rendering a dangling
  "Backup failed:", unknown `skipReason` echoing a raw machine token) are fixed and released.
- 🧪 **More reliable releases**: a load-only timing flake in `env-lock.test.ts` (fixed sleeps assuming timer ticks land) that
  could block `publish.yml` — which runs the full suite and fails fast — is gone.
- 🙏 **Contributors section** added to both READMEs (this PR plus the three issue reporters).

## [0.1.62] - 2026-09-21

> 本版主题是**内容级选择 + 可读性 + 安全收口**：「只能按分区整块勾选」的时代结束——导出、导入、
> 市场三条通道现在共用同一套「分区 → 最小可拆单元」选择内核；恢复计划有了 git 风格的逐行对照；
> 档案页从「插件自建的配置快照」换成**直接管理 DSH 自带 profile**（**行为替换，含破坏性**，见下）；
> 并修复 issue **#39**（凭据 `refs:` 口径 / 会话限额 / 凭据可恢复性 Feature 1–3）与 **#43**（「立即备份」空转却假报成功）。
> 未做项与有损点照旧登记在 `docs/spec/known-gaps.md`（本轮新增 **G-18**）。

### ⚠️ 破坏性 / 不兼容（升级前必读）

- **档案页语义整体替换（用户数据 + API 双重破坏）**：旧的「保存当前配置为档案 / 切换预览 / 执行切换 /
  导入 profile.json」四处交互与 `/profiles/save|analyze-switch|execute-switch|import` 四条端点一起删除，
  `ProfileManager` / `SwitchPreview` / `src/ui/profiles-view.ts` 全部移除，改为**直接管理 DSH 自带 profile**
  （`$DSH_HOME/profiles/<name>`）。此前保存在 `$DSH_HOME/dsh-config-manager/profiles/<name>/profile.json` 的
  插件自有档案**不再被列出或切换，也没有自动迁移代码**（文件仍在磁盘，需人工处理）。
- **「切换档案」不再即时生效**：DSH 无法在运行中更换 profile（bundle 层启动时解析，且 0.1.5-rc.1 /
  0.1.5-rc.2 / 0.1.6-alpha.2 均无 profile 管理路由），因此现在只写「下次启动用哪个」标记并给出
  `dsh --profile <name>` 重启命令；该标记是机器本地状态，不参与备份。
- **迁移前咨询不再接受 `type=profile`**：可迁移源只剩 export-zip / local-snapshot / remote-snapshot，
  宿主对 `type=profile` 返回 400；`buildProfileSource` / `ProfileSourceInput` 已删除（调用方需自行更新）。
- **市场通道取消「高风险分区默认不勾 + 逐分区批准」的严格分层信任默认**：改为与导入页同一套级联树
  （默认全选，含 plugins / mcp / agentPresets / agentInstructions / sessions / pluginFiles），风险改由
  「就地高风险警示 + 免责确认 + 导入前快照 + 导入后一键回滚」承担。相关免责文案与两份 README 已同步改写。
- **导出页 / 同步页的「快速导出 vs 自定义」二选一模式被移除**：勾选集合成为唯一事实（`ExportMode` 类型删除，
  `export.mode.*` 文案删除）；同步页改为「选择同步分区」弹窗，落盘 mode 恒为 advanced。
- **同步加解密密码从「仅内存」改为持久化到本机 DSH 凭据库**（安全策略变更，见 `SECURITY.md` 登记为唯一
  持久化例外）：值仍不写同步文件 / 响应 / 日志 / 备份，浏览器只拿得到 configured 布尔。

### 🐞 issue #39 —— 凭据 `refs:` 口径 / 会话限额 / 凭据可恢复性（Feature 1–3）

- **问题（报告人实测）**：`.credentials.yaml` 的 DSH v1 布局把凭据值放在顶层 `refs:` 之下，而插件两处解析
  （宿主 `tryDecryptCredentials` 与同步 `credentialsMapFromYaml`）只认「顶层字符串项」的预发布扁平布局，
  `refs` 是对象 → **整段被过滤成空 Map** → 备份包里明明带着凭据原文，导入却把全部 ref 送进「待人工重填」。
- **修复（唯一解析口径）**：新增 `src/security/credentials-yaml.ts` 的 `collectCredentialRefs()`——v1 `refs:` 块
  与预发布扁平布局**都认**、同名以 `refs` 为准，`records` / `payload` 等嵌套结构一律忽略（会话秘密不是凭据 ref，
  混进来只会污染补录清单）；零依赖，宿主与同步引擎共用同一份实现，杜绝「同一文件格式两处口径漂移」。
- **修复（误导提示收窄）**：`includeSecrets=true` 的导出按设计**不**镜像明文 vault，跨机 vault 必然为空，
  于是「凭据文件不在本机 vault（需人工重填）」必然出现——现在值已随包内密文回填时改用新消息
  `import.vaultCredentialsFromArchive` 如实说明，**只有确实还缺 ref 时才**保留「需人工重填」。
- **Feature 1：会话按数量筛选** `ExportOptions.sessions: { limit }` —— `0` = 不带该分区 / 负数 = 全带 /
  正数 = 最新 N 个 / 键缺省 = 现有行为。单位是**会话目录**（同一会话的 `session.jsonl.zstd` 与
  `session.v3.jsonl.zstd` 必须一起走），文件名判据不写死（`session.lock` 不算会话、新格式不能整批漏掉），
  排序用**会话日志文件的最新 mtime**；宿主 `FileSystemFacade` 未实现 `mtimeMs()` 或时间全读不到时
  **退回全量 + 告警**，绝不把「时间未知」当成最旧。实测收益：全量会话约 370 MB → 最新 10 个约 7.5 MB。
- **Feature 2：`/analyze` 返回 `credentials: { inArchive, refs, satisfied }`** —— 宿主不必自己解
  `security/secrets.enc` 再解析 YAML（否则上面那个坑每个宿主都要重踩一遍）；**只回传 ref 名，永不回传值**。
- **Feature 3：`/execute` 结果带 `credentialsRestored`**（从加密归档内解出并回填本机的条数；字段只增不改，
  为 0 时省略以保持旧响应逐字节不变）。

### 🐞 issue #43 —— 「立即备份」不再空转、更不再假报成功

- **问题（报告人实测）**：概览页蓝色主按钮「立即备份」在**定时备份未启用**时（`enabled: false` 是缺省值，
  也是「从未配置过定时备份」用户的必然状态）宿主直接返回 `{status:'skipped', skipReason:'disabled'}`、
  一个文件都不产出，而客户端**不看 `run.status`**、无条件 `toast.ok('备份完成')`。
- **修复（手动不再空转）**：`runOnce(opts?: { manual?: boolean })` —— 手动路径（`/backup-schedule/run` 改为
  `runOnce({ manual: true })`）**绕过 `enabled` 开关**：用户点这个按钮的语义就是「现在就给我做一份」，
  与自动调度开没开无关。其余守卫（RunRegistry 防重、环境锁、SAFE MODE、保留策略）一条未放宽；写回配置时
  仍用原 `enabled` 值 —— **绝不偷偷替用户打开自动调度**（已用测试钉住）。
- **修复（不再假报成功）**：新增纯函数 `backupRunOutcome()`，提示通道一律由 `run.status` 决定：
  `success` → 成功；`skipped` → 按原因分档提示「已跳过：定时备份未启用（没有生成任何备份文件）/ 上一次备份
  仍在进行中 / 另一项任务正在执行（防重）/ 环境锁被占用」；`failed` → 「备份失败：{原因}」（过 `redact()`）。
  未知 status 一律落 `error`（fail-safe，绝不宣称成功）。
- **来源词不冒充**：手动触发的日志与迁移历史用「手动备份完成/跳过/失败」，自动路径仍是「定时备份…」；
  迁移史新增 kind `backup-manual`，于是历史面板与概览「最近活动」能把两者分开（旧条目无法追溯，见「已知限制」）。
- **顺带修正文案**：`overview.quick.backupTitle` 由「全量快照，随时可回滚」改为「立即生成一份完整备份文件
  （不受定时备份开关影响；在快照页查看 / 还原）」（原文案说的是快照，实际产物是 `exports/*.zip` 备份文件）。

### 🐞 issue #35 收尾 —— 补丁声明与补丁文件成为**原子单元**

- 条目级选择引入后，`pnpm-workspace.yaml` 的 `patchedDependencies` 声明与 `patches/**` 补丁文件被声明为
  **互相 `lockedWith` 的原子组**，导出侧再用「全或无」兜底：取消其中任一个整组一起取消，**绝不产出
  「有声明、没文件」的半套**（目标机 pnpm 会因此拒绝一切 `add`）。
- 顺带把 `pnpm-workspace` ↔ patch 文件的配对知识下沉到 `src/adapters/units.ts`，供后续新增依赖组复用。

### 🧩 条目级内容选择（Phase 1：导出 / 导入 / 市场共用一套内核）

- 导出可对**分区内的最小可拆单元**逐个勾选，不再只能整块勾选分区：新增可选 `ConfigAdapter.listUnits()`
  （纯函数、输入即 `export()` 产物，预览端点因此**零额外读盘**）。
- 单元粒度按「拆开就失效」的知识定义（`src/adapters/units.ts`）：文件类分区默认 = 首个路径段
  （一个技能目录 bundle / 一次会话 = 一个可勾选整体）；`pluginFiles` / `self` 覆写为逐文件；
  `sessions` = `<projectKey>/<sessionId>` 会话目录；`plugins` = `plugin:<包名>` / `patch:<行id>` /
  `plugins:pnpm-workspace` / `plugins:patch:<rel>`；`workspaces` = `workspace:<记录id>`。
- 白名单三分语义（`ExportOptions.includeItems`）：键缺省 = 该分区全量（向后兼容）；键存在且**空数组**
  = 该分区整体剔除（在选定阶段剔除，不产出空载荷分区，`manifest.sections` 如实为 false）；非空 = 只带
  白名单单元。未实现 `listUnits` 的分区（settings / ui / providers / mcp / prompts / credentialsStatus）
  不可细分，传入白名单一律忽略 = 保持全量。
- 过滤发生在 `readFile` **之前**：未勾选的文件不读盘，取消勾选大分区（会话）后导出耗时明显下降。
- 唯一的选择内核：`src/ui/selection-model.ts` 的 `Selection { sections, excluded }` 稀疏表示 + 三态 /
  原子组 / 请求换算；导出页、导入向导、市场通道**共用**同一套语义（消灭「同样的勾选框不一样的行为」）。
- 唯一的内容勾选组件：`src/client/common/ContentPicker.tsx`（两级树 + 搜索 + 全选/全不选 + 部分选中徽章 +
  分组级联 + 捆绑联动 + 渐进披露 + `unitBadge`）；与只读的 `SectionComposition` 明确分工，禁止合并。
- 新端点 / 字段（只增不改）：`/export-preview` 响应新增可选 `sections[].items`（`ExportUnit[]`）与
  `failedSections`；`/export` 请求新增条目白名单 `includeItems`；`/restore` 响应新增可选 `changeSummary`。

### 📤 导出页

- 工具栏重排：删除「快速导出 / 自定义导出」分段与「预览将导出内容」按钮，改为「开始导出」（primary）+
  「选择要导出的内容」；模式提示改为一行说明。
- 内容选择器：「显示全部（共 N 条）」渐进披露上限由 100 提到 1000（真实 631 项会话库展开即全量）；
  单元名中段省略 + 悬停全文；按工作区分组且默认全折叠，展开一个分组只展开那一棵子树。
- 「设备相关 / 敏感」徽章 + 勾选到这类分区时页面与弹窗内**就地警示**（非阻断，列出分区名）；
  一键「全选」不再静默勾上 sessions / pluginFiles / credentialsStatus；「全不选」时明确提示并禁用导出。
- 页尾新增「本次将导出」构成卡（恒常渲染、内部滚动，合计与选择器 footer 同源）。
- 修复：分区清单读取失败不再显示误导性的「已选 0/0」——逐分区标「读取中…」/「读取失败 · 将整体导出」，
  存在未读分区时合计改口径为「已读取 …（含未读取分区，实际不少于该值）」，并把宿主精确清单与
  「请求了但没回来」的推断取并集。
- 修复：恢复「安全选项」「文件名与备注」两个分组标题；文件名规则与备注说明常驻显示（先规则后报错）；
  弹窗几何稳定（内容区固定高度 + 公告位恒定高度 + 底部动作移入固定底栏，不再随内容跳动 / 关闭按钮滚走）；
  双列字段间距由 5 处内联 style 改为 CSS 类。
- 修复：导出结果报告改为结构化清单（中文分区名 + 中文计数单位「18 个命名空间」），长行折行不再被裁、
  置于限高内滚，徽章全部走 i18n。

### 📥 导入向导

- 预览步拆成两页：第 1 页「迁移前咨询」（只读结论 + 「下一步：选择要导入的内容」，无法生成报告时给
  中性提示且不阻断），第 2 页是内容选择面板；换一份备份自动回到咨询页。
- 条目级内容勾选（与导出一套内核）：不勾选的条目**不导入、也不进快照**；确认页显示「将导入 N 个分区 ·
  M 个条目」与「本次有 N 项被你取消勾选」。
- 修复（UI-05）：**空选择守卫** —— 预览步勾选被清空时提示并禁用「下一步」，确认页「确认导入」同样禁用
  （此前「什么都没勾」会被执行成一次成功导入）。
- 修复（UI-06）：密钥补录页改为受控表单 —— 返回该页仍显示上次输入的值，编辑一个字段不再丢其它 ref 的值；
  且只为仍会导入的凭据索要密钥（被取消的插件不再索要）。
- 修复：确认页提示语跟随「失败时整体回滚」勾选状态（取消勾选后不再承诺回滚）；冲突列表文案走 i18n
  （「当前 / 备份」「错误」「无冲突项」）且 `description` / `detail` 渲染前过 `redact()`；预览统计补上
  此前漏渲染的「提示词」维度；兼容性页分区清单显示中文名；路径映射横幅由 warn 改 info（留空跳过是合法的）；
  结果页显式传 `t`（英文界面不再恒中文）、底部按钮由原始动作 id「done」改为「完成 / 查看失败项 / 查看详情」。
- `PlanItem` 新增可选 `unitId` / `label` / `group`（纯展示与对齐字段，`id`/`kind`/`target` 不变）：
  文件类 adapter 在 `analyzeImport` 用与导出 `listUnits` **同一套** `unitIdOf` 声明单元，导入侧于是也能按
  「一个技能 bundle / 一次会话」勾选，而不是逐个文件。

### 📸 快照恢复 —— git 风格的恢复计划预览

- 恢复计划预览改为三级视图：① 摘要条（将被还原 / 新增 / **将被删除** / 卸载插件 / 需人工处理 / 无动作 +
  行数合计 `+X −Y`）② 固定顺序分组（变更 → 删除 → 插件 → 人工 → 无动作，「无动作」默认折叠）
  ③ 点文件行展开**左右双栏逐行对照**（左 = 当前磁盘、右 = 快照内容，成对修改左红右绿，
  块头 `@@ -a,b +c,d @@`）。
- 新内核：零依赖行级 diff `src/utils/line-diff.ts`（CRLF 归一 + 公共前后缀裁剪 + 超预算降级，保证耗时确定）
  + `src/core/snapshot-diff.ts`（两级读取上限：列表阶段单侧 ≤256 KB / 总预算 8 MB / 最多 80 文件，
  详情阶段单侧 ≤1 MB / 6000 行 / 上下文 3 行；超限如实标 budget / truncated，而不是拖慢预览）。
- 边界态都有说明：二进制 / 文件过大 / 不可读 / 快照内缺该文件 / 路径越界；两侧一致时显示
  「两侧内容一致，无逐行差异」；行号列宽按最宽行号分四档；hunks 由 `POST /snapshots/file-diff`
  **点开才懒加载**。
- 安全：路径一律经恢复引擎的越界护栏（`isWithinHome` / `homeAbs` / `blobAbs` 本轮改为导出以复用**同一份**
  判据），越界拒绝；返回值不含凭据值且 UI 渲染前再过 `redact()`；单项失败只标 unreadable / skip，
  绝不因一个文件读不到就让整个预览失败。
- 修复：恢复报告新增显式「完成」按钮关闭回执（此前执行完恢复就停在报告上找不到返回，且报告随
  sessionStorage 落盘会「复活」）；迁移前咨询卡移到计划预览**之前**并加分割线。
- 澄清：删除动作本身在 0.1.61 就有（`hostFileRemove` / `fileRemove` 未改动），本版增强的是
  「预览里能看到它并逐行对比」；恢复计划的生成逻辑未变。

### 🔄 同步

- **历史会话成为显式可选同步分区**（`OPT_IN_SYNC_SECTIONS`）：推送必须**既勾选 sessions 又在请求体带**
  `sessions.{limit}`，缺一即按非 portable 跳过并**显式告警**；拉取只在用户驱动的 pull / 一键同步上放行
  （引擎 `includeOptInSections`），自动同步与 Agent 工具恒不带 —— **会话绝不悄悄下行**。
- 会话同步上限：缺省 5、`0` = 勾了但不带、非整数回退 5、>10000 钳制（`sync-selection.json` schema v2
  只增字段，旧文件缺省读回 5）。
- **密码持久化**：加密 / 解密密码保存到本机 DSH 凭据库独立槽位
  （`DSH_CONFIG_MANAGER_SYNC_{ENCRYPT,DECRYPT}_PASSWORD_<GIT|WEBDAV>`）；输入框失焦即写（两框一致才写）、
  留空即沿用、取消勾选「加密备份」即删除已存密码、解密密码另有 danger 语义的「删除已保存密码」；
  请求体密码优先于已存密码、`clear*` 优先于写入；`GET /sync/status` 只回 configured 布尔。
- 行为变更：删除「同步模式」分段，改为「选择同步分区」弹窗 —— 勾选集合就是同步范围、改动即时生效并
  持久化，设备相关分区带 warn 徽章，勾选为空时禁止推送。
- 修复：同步确认视图的 `description` / `detail` / `diff` 渲染前过 `redact()`，变更明细由 `<pre>` 改普通块
  （长 JSON 不再横向溢出被裁）；全部弹窗补 `closeLabel`（关闭按钮 aria-label 走字典）。
- 内部：拉取侧「哪些分区进临时 ZIP」的三处口径收敛为 `pullSectionIds()`。

### 🛒 市场

- 条目详情从「列表上的弹窗」改为**页面级分步向导**（预览 → 选择内容 →（有冲突才有）冲突 → 确认 → 结果），
  步骤条复用 Stepper，页头 = 标题 + 「返回列表」；起因是实测「3 分区 / 61 个计划项」导致三重滚动。
- 选择步改用与导入页**同一套**级联树（搜索 / 全选 / 二级分组 / 树上直接标「将改动 / 已一致 / 不导入」），
  筛选 Segmented（全部 / 将改动 / 高风险 / 未勾选，带计数，只影响渲染）。
- 已勾选的高风险分区**就地警示**（列出分区名与后果）；无勾选时禁止导入；逐项摘要降维为**分区级小结**
  （一行一分区：已选 n/m + 将改动/已一致 + 高风险徽章），不再把 61 行铺满。
- 冲突逐项决策（保留本机 / 使用导入）内联在向导里，决策变化由宿主 `createImportPlan` 重算计划
  （不在前端改 `planItem.kind`），未决策一律按「保留本机」不覆盖。
- 导入后新增**「回滚到导入前快照」**入口（danger + 二次确认 + 恢复/卸载/失败/人工计数报告）；
  没有可用快照时如实说明「无法回滚」，不给假入口。
- 「我的配置 → 装回本地」同样改为页面级向导，与「浏览条目详情」**共用同一个** `MarketImportReview`
  （消灭两套勾选语义）；上传 / 更新向导仍是弹窗。
- 勾选与冲突决策进 runStore 市场切片（绑 `zipPath`，换条目自动回落默认全选），切 tab / 刷新不丢；
  步骤与筛选是纯瞬态。
- 安全默认变更见上文「破坏性」；免责文案与两份 README 的「逐分区批准」措辞已同步改写为「逐项内容选择」。
  上传侧的 8 道校验、供应链警示恒展示（`needsReview` 恒 true）、`patchFiles` / `localTarballs` 双端拒收
  均**未改动**（后者是 0.1.60 的既有防线）。

### 🗂️ 档案（Profiles = DSH 自带 profile 管理）

- 新语义：档案 = `$DSH_HOME/profiles/<name>`（`dsh --profile <name>` 启动的那份）。列表每行显示形态徽章
  （Web / Headless / 自定义）、「当前运行」/「下次启动」徽章、损坏徽章（`package.json` 不可解析 / patch 过大）、
  计数摘要（N 个层 · patch M 条 · 依赖 K · 已装未装 node_modules · patch 热生效或仅启动应用 · 更新时间）；
  排序为当前运行 → 待切换 → 按名字。
- 详情弹窗（点整行打开）：bundle 层清单（带序号 = patch 应用顺序）、依赖清单、目录、patch 条目数与体积、
  更新时间，以及 `package.json` 与 `cordis.patch.yml` 原文（渲染前 `redact()`；patch 过大则不加载原文并说明）。
- 新建：名字 + 起步模板下拉（base / web / headless / sdk / sdk-minimal / acp，并显示模板含哪些 bundle 层），
  名称实时校验（空 / 超 64 字 / 非法字符 / DSH 保留名分别提示）；脚手架三文件与官方 `initProfile`
  **逐字节一致**。
- 重命名：目录级 rename + 同步修正 `package.json` 的 name 与「下次启动」标记；**运行中的档案拒绝改名**。
- 删除：**物理删除整个目录（含 node_modules）**，不可恢复；目录内 junction 只删链接本身；目标是当前运行
  档案时需额外勾选确认；删除会一并清掉指向它的「下次启动」标记。
- 「下次启动」卡四态：未设置（规则说明）/ 就是当前（绿 Banner「无需重启」）/ 指向的档案已不存在
  （warn + 清除）/ 待切换（等宽 `dsh --profile` 命令 + 复制 + 取消）。
- 修复：重命名成功给 Toast 回执；错误码（同名已存在 / 不存在 / 不能作用于当前档案 / 名字非法 / 保留名 /
  未知模板）本地化；加载失败横幅过 `redact()`。

### 📋 迁移历史

- 新增两类审计条目文案：「档案新建」「设置下次启动档案」；「备份」细分为**「定时备份」与「手动备份」**
  （issue #43，含 en 镜像与筛选下拉）。
- 行为变更：每条记录改**两行布局** —— 元信息行（时间 · 结果 · 分区）+ 摘要独占一行（此前摘要与元信息
  抢同一行被挤成碎片）。
- 修复：时间由原始 ISO 串（含 `T`/`Z`/毫秒）改为本地 `YYYY-MM-DD HH:mm`，悬停显示完整本地时间
  （复用同步历史的时间格式化，两个历史视图观感一致）；分区列最多显示 3 个、其余折叠为 `+N`；
  筛选下拉「最近」项改为与另两个同构的「最近: 全部」。

### 🧪 迁移前咨询（migration consult）

- 结论改为**由证据决定**而非由分数决定：新增硬阻断白名单（只有「引擎真的不会继续」才算：无 manifest /
  schema 不支持 / checksum 不符 / Zip Slip / dry-run 失败），修复用户实测的「健康评分 89 却建议阻止执行」
  自相矛盾；有硬阻断时把分数压进 critical 区间。
- 冲突降级为「需处理」：致命冲突由 error 降为 warning 并封顶扣分，文案改为「有 N 处冲突需要你决定保留
  哪一边（下一步可逐个选择；默认不覆盖本机）」；悬空凭据引用由「每个 ref 各刷一行」聚合成一条并封顶扣分，
  且永不判 critical。
- 报告新增 `blockerCount` / `attentionCount`，咨询卡在结论徽章旁恒显示「N 项硬阻断（不处理无法安全导入）」
  「N 项需处理」，触发项列表里硬阻断排最前。

### 🎨 UI 审计（26 条）与全局一致性

- 按 `docs/design/ui-audit-2026-09-20.md` 的清单（0 blocker / 9 high / 11 medium / 6 low，共 26 条）逐条修复，
  本版绝大多数 UI 改动都能回溯到 `UI-01` … `UI-26` 编号。用户可见的代表项：
  - 长文本不再被裁：报告 / 错误明细的 `<pre>` 补 `white-space: pre-wrap` + `overflow-wrap: anywhere`
    并统一置于 `.reportScroll` **限高内滚**（UI-01，此前长行横向溢出且被父容器裁掉）；同步变更明细、
    导入结果报告同源修复。
  - **分区显示名单一映射**（15 个分区的中文名，`common/section-labels.ts`）：总览构成、导出选择器、
    导入选择器、兼容性页、同步分区弹窗、导出报告从此只有一种叫法（此前同一个分区有英文 label /
    裸 id / 中文三套）；`Record<SectionId, …>` 全量覆盖 ⇒ 新增分区忘配文案会**编译失败**。
  - **页签溢出提示**（UI-19）：英文界面 7 个页签 + 2 个文字按钮在 564px 画布溢出且滚动条被刻意隐藏时，
    在真实溢出侧画渐隐遮罩；放得下时不画。
  - `ErrorBanner` 改为随 `error` 属性重新解析（此前同屏连续两次失败会一直显示第一次的标题 / 原因 / 建议），
    并把 `t` 传入错误映射 —— 英文界面的错误标题与建议动作不再恒中文。
  - 走 `Modal.Header` 的弹窗：标题不再双重内边距；`closeLabel` 改为**编译器强制必填**，关闭按钮
    aria-label 一律走字典（英文界面屏幕阅读器不再读中文「关闭」）。
  - `ProgressBar` 的阶段文案 / 分区名 / 当前项名渲染前过 `redact()`；`ConflictList` 与 `SyncConfirmView`
    的裸渲染修复（实测 MCP `env` / `headers` 明文凭据会原样回传浏览器），并新增**按渲染点**的源码级守卫
    测试（去掉任一处 `redact()` 即红灯）。
- i18n 收口：删除一批死键（`export.mode.*`、`export.preview*`、`snapshots.hint|viewPlan|kind.*|summary`、
  `error.title|hint`、`about.diag.bundles`、nav 遗留键等），zh / en 同步；7 套字典最终态键数
  506 / 278 / 291 / 51 / 138 / 104 / 198，**zh 与 en 键集合完全相等**（对照表与排查姿势见 `DEVELOPERS.md`）。

### 🔇 日志降噪

- 新增 `parseLogLevel()`：宿主入口**默认日志级别由 info 降为 warn**（大小写与空白不敏感，非法值 / 缺省 → warn）。
  启动 `dsh web` 后控制台只留 warn / error —— 挂载横幅、调度器跳过、导出与备份完成、保留策略清理等常规
  info 不再刷屏。
- 排查时设 `DSH_CONFIG_MANAGER_LOG_LEVEL=info`（或 `debug`）即恢复逐条输出；级别只在入口解析一次，
  勿在调用点再加 `if (debug)` 分支。

### 📄 文档 / 契约 / 测试

- `docs/spec/known-gaps.md`：新增 **G-18**（`.credentials.yaml` 的 `refs:` 块未被识别 → 导入后仍要求人工
  重填，✅ 已修复，写明修复位置、验证方式与**未覆盖项**：`workspaces.applyItem` 整条覆盖会丢本机独有键、
  `POST /sessions/group` 仍未做）；G-17 验证方式扩到 8 例、有损点表述改为「凭据字符串值」。
- `docs/spec/headless-consumption.md`：新增 **§4.5**，把 `sessions.{limit}` 档位语义、
  `analyzeImport(zip, { decryptedCredentials })` → `analysis.credentials`、`credentialsRestored` 写成
  对外契约（只增不改），并列出对应 HTTP 面（`/export` 的 `sessions`、`/analyze` 的 `decryptPassword`、
  `/execute` 的 `credentialsRestored`）。bundle-format / manifest schema / compat-matrix **未改**。
- `docs/design/ui-audit-2026-09-20.md`（新增）：UI-01 … UI-26 逐条审计（现象 + 行号级证据 + 期望 +
  涉及文件 + 三批修复建议 + 「本清单不需要新增第三方依赖」结论 + 复核命令）。
- `docs/design/2026-09-20-session-log-compression.md`（新增，只读实测）：会话日志是多帧 zstd 容器
  （4.4 MB 日志 2642 帧）——保留帧边界重压几乎无收益，合并单流才有；全量 379.8 MB → 210 MB（≈1.79×）、
  跨会话 solid 4.3×、单个长会话 18–20×；结论「只带最新 N 个」性价比最高且不需格式改动
  （默认改走 `sessions.limit` 属行为变更，**本版未改默认**）。
- `DESIGN.md` +338 行：把内容选择器、git 风格恢复预览、市场条目导入审阅、档案页、导出页新结构、
  报告与错误折行规则、计划文本与分区名脱敏规则、两套字典分工与死键纪律写成规范；`DEVELOPERS.md`：
  新增「从 AGENTS.md 下移的细则」（页面落位 / 状态管理 / i18n 七套字典对照表 / Missing Design Rule /
  第三方库准入 7 步）与两条技术限制（DSH 无法运行中切 profile、无 `DSH_PROFILE` 环境变量）。
- `README.md` / `README.zh-CN.md`：Profiles 小节整段重写（= DSH 自带 profile + 无法运行中切换）、
  同步密钥段改写为「密码存本机凭据库、留空即沿用、取消勾选即删除」、首屏备份内容清单移除 Profiles 并加注
  「DSH profile 不随备份迁移」、新增 FAQ「`dsh web` 控制台为什么安静了」、市场小节措辞与「逐项内容选择」对齐。
- `SECURITY.md`：「加密备份」→「加密备份 / 导出」，并新增「同步通道密码（唯一持久化例外）」条目（中英同步）。
- 测试：全量 **2152** 项通过（新增 units / sessions / session-meta / session-select / snapshot-diff /
  line-diff / logger / selection-model / restore-plan-view / diff-view / market-import / nav-overflow /
  dsh-profiles-view / section-labels / plan-text-redaction / credentials-yaml / credentials-refs-import /
  export-item-selection 等套件），`typecheck` / `build` / build 后 `bundle-selfcontained` 护栏全绿。

### ⛔ 本版已知限制（如实登记）

- **旧「配置档案」数据不会被迁移**：`$DSH_HOME/dsh-config-manager/profiles/<name>/profile.json` 仍在磁盘
  但不再被列出 / 切换，仓库内也没有迁移代码 —— 需要时请手动转换为 DSH profile。
- **旧迁移历史条目的来源无法追溯**：修复前写入的备份条目 kind 恒为 `backup`，因此仍显示「定时备份」，
  即使当时是手动点的；只有本版之后的新条目才准确。
- 「默认走最新 N 个会话」**未实现**：导出默认行为仍是「sessions 分区默认不含」（结论见设计文档）。
- `workspaces` 导入仍以备份记录**整条覆盖**、会丢本机独有键（`archivedSessionIds` 等）；导入写记录前也
  不建缺失目录。二者与 `POST /sessions/group` 一起留在 `known-gaps` G-18「未覆盖」。

### 🙏 致谢 / Thanks

- 外部贡献者 **lux-liang (Jialiang Liang)** 在 [PR #44](https://github.com/xiajiajun516/dsh-config-manager/pull/44) 中
  独立修复了同一个 issue #43：诊断与补丁方向完全正确，且其中两点**比本版实现更稳**，已采纳并落地
  （commit `d06dc11`）—— ① `failed` 且宿主错误文本为 `undefined` / 空串 / 全空白时回退通用文案（否则会渲染出
  「备份失败：」这种半截提示）；② 未知 `skipReason` 归一为本地化通用说明，不再把机器 token 原样回传
  （与仓库既有纪律一致：用户可见文本不留裸 token）。该 PR 因内容已被本版覆盖而作为 superseded 关闭。

### 🎯 亮点 / Highlights (zh)

- 🧩 **终于能按「内容」勾选了**：导出 / 导入 / 市场共用一套「分区 → 最小可拆单元」级联树，技能目录、
  插件补丁组、单次会话都是整体单元；未勾选的文件连读都不读。
- 🎬 **恢复计划变成 git 风格对照**：将被删除 / 还原 / 新增一目了然，逐文件左右双栏看改了哪几行
  （hunk 点开才加载）。
- 🗂️ **档案页重做**：直接列表 / 新建 / 重命名 / 物理删除 `$DSH_HOME/profiles/<name>`，并告诉你
  「下次启动用哪个」+ 重启命令（**旧插件自有档案不迁移，见破坏性小节**）。
- 🛒 **市场装回本地走完整向导**：预览 → 选择 → 冲突 → 确认 → 结果，导入后可一键回滚到导入前快照。
- 🔐 **凭据终于认得 DSH 的 `refs:` 布局**：加密备份里的凭据不再被误判为「包里没有」，误导性的
  「需人工重填」也只在真的还缺时出现。
- ⏰ **「立即备份」真的备份**：不再空转、不再假报成功，与定时备份开关解耦；手动与定时在历史里分开记。
- 🔇 **控制台安静了**：默认只留 warn / error，`DSH_CONFIG_MANAGER_LOG_LEVEL=info` 一键恢复。
- 🎨 **26 条 UI 审计逐条修完**：长报告折行 + 限高内滚、分区名统一、页签溢出提示、错误横幅不再失真、
  关闭按钮无障碍标签本地化。

### Highlights (en)

- 🧩 **Content-level selection**: export / import / market now share one section→smallest-unit cascade tree;
  skill bundles, patch groups and single sessions are atomic units, and unchecked files are never even read.
- 🎬 **git-style restore preview**: see what will be restored / added / **deleted**, then open any file for a
  side-by-side line diff (hunks are lazy-loaded).
- 🗂️ **Profiles page rewritten** to manage DSH's own `$DSH_HOME/profiles/<name>` (list / create / rename /
  physical delete, plus "which profile to launch next" with the restart command). **Old plugin-owned profiles
  are not migrated** — see the breaking-changes section.
- 🛒 **Marketplace install is now a full wizard**: preview → select → conflicts → confirm → result, with
  one-click rollback to the pre-import snapshot.
- 🔐 **Credentials finally understand DSH's `refs:` layout**: encrypted backups no longer look "empty", and the
  misleading "re-enter manually" hint appears only when a ref is genuinely missing.
- ⏰ **"Back up now" really backs up**: no more silent no-op and no more false success toast; it is decoupled
  from the schedule switch, and manual vs scheduled runs are recorded separately.
- 🔇 **Quieter console**: warn/error by default; `DSH_CONFIG_MANAGER_LOG_LEVEL=info` restores verbose output.
- 🎨 **All 26 UI-audit items fixed**: wrapping + capped scroll for long reports, one canonical section-name map,
  tab overflow hints, accurate error banners, localized close-button labels.


## [0.1.61] - 2026-09-18

> 单主题版本：修复 **issue #38** —— 同步页「导出密钥」此前**不会导出任何密钥**。
> 本版把它做成真的：凭据以**独立密文载荷**随加密快照迁移，并在目标机按用户确认写回本机凭据。
> 缺口登记见 `docs/spec/known-gaps.md` **G-17**。

### 🐞 issue #38 同步页「导出密钥」未生效

- **问题**：`includeSecrets` 在同步通道内**没有数据源**——没有任何 adapter 读它，结构化分区在源头
  就已 `redactSecrets`，凭据分区被 `FORBIDDEN_SECTIONS` 结构性排除，`.credentials.yaml` 在
  `SECTION_JSON_PATHS` / `SECTION_FILE_PREFIXES` 里没有映射。它唯一真实生效的效果是
  **跳过同步载荷的第二道 `SecretScanner` 脱敏**——方向是**降低防护**，而不是取得凭据。
  推送载荷与不勾时**逐字节相同**（唯一差异是 `manifest.containsSecrets` 由 `false` 变 `true`），
  而 UI hint 承诺「把真实凭据值写入加密快照」，两版 README 也从未提及该选项。
- **修复（push 侧接入数据源）**：`includeSecrets=true` 时经 `ctx.fs.readFile` 读
  `$DSH_HOME/.credentials.yaml` 原文，用本次调用的密码加密为**独立字段**
  `SyncSnapshot.credentials`（新类型 `EncryptedCredentials`）。**刻意不进 `sections`**——
  `credentialsStatus` / `secrets` 是结构性拒绝分区，凭据值必须走分区之外的载荷。
  读不到 / 解析不出凭据 → **显式告警且不带载荷**（不静默成功，也不阻断其余配置同步）。
- **修复（pull / apply 侧接线）**：`pull()` / `preview()` 解密出 `Map<ref, value>`，为每个 ref
  生成一条 `MissingSecret` 计划项（凭据迁移因此进**人工确认**列表、默认不采用）；
  `applyItems()` 把该 Map 作为 `executeImportPlan.decryptedCredentials`（此前**硬编码
  `undefined`**）交给 credentials adapter → `credentials.set(ref, value)` 写回本机。
  一键同步会话**仅内存**保管该 Map（存值不存密码——能力更窄），apply-items 消费 / cancel /
  TTL 30 分钟即消失，绝不落盘。
- **双保险**：未加密快照若携带凭据载荷，一律拒绝拉取（与「非加密快照声明 `containsSecrets`」
  同类，防御篡改 / 旧坏数据）；散文件布局显式拒绝承载凭据载荷，**绝不静默丢弃**。
- **可见性**：推送预览新增 `credentialsIncluded`，确认弹窗明确提示
  「本次推送包含真实凭据值（已随载荷整体加密；远端只见密文）」——勾选后不再是无声的行为变化。
- **安全不变量（均未放宽）**：`includeSecrets ⇒ encrypt` 强制；凭据载荷**只**存在于加密快照；
  自动同步恒 `includeSecrets=false`（无密码可用，遇到加密快照跳过）；密码仅内存，
  不落盘 / 不落日志 / 不进响应体；`manifest.containsSecrets=true` 语义保持。
- **已知有损点（如实登记）**：只搬运 `.credentials.yaml` 的**顶层字符串值**（与导出路径
  `security/secrets.enc` 同口径），嵌套结构 / 非字符串值不迁移；凭据写回**不可回滚**——
  DSH 不回读凭据值，属既有的技术限制。

### 📄 文档与契约同步

- `src/client/sync/sync-locales.ts`：入口描述与「导出密钥」hint 从「密钥永不参与同步」改为
  「**默认**不参与同步；勾选『导出密钥』并加密后可随加密快照迁移」——消除文案与实现不符。
- `README.md` / `README.zh-CN.md`：功能表与同步章节同步修订，写明「密文随快照上行、
  远端只见密文、凭据写回需用户确认」。
- `AGENTS.md`：安全不变量新增「同步『导出密钥』= 独立密文凭据载荷」一条（含两条不放宽的红线）。
- `docs/spec/known-gaps.md`：新增 **G-17**（含修复位置、不变量、验证方式与有损点）。

### 测试

- 新增 `src/sync/sync-credentials.test.ts`（7 例端到端，含负例）：push 密文载荷 + 明文绝不入载荷 /
  只加密不导密钥不带载荷 / 无凭据文件明确告警 / pull+preview 生成迁移项且报告不含凭据值 /
  applyItems 带 Map 写回、不带则跳过 / 未加密快照携带凭据载荷被拒 / 散文件布局拒绝。
- `src/client/sync/sync-push-preview.test.ts`：新增「含凭据推送 → 显式提示」用例。
- 全量套件 **1962** 项通过；`typecheck` / `build` / build 后 `bundle-selfcontained` 护栏全绿。

### 🎯 亮点 / Highlights (zh)

- 🔑 **「导出密钥」终于真的导出密钥**：勾选后 `.credentials.yaml` 会以 scrypt + AES-256-GCM 密文**随加密快照一起走**——换机后凭据能真正落地，而不再是「看起来勾了、其实什么都没带」。修复前该选项的唯一效果是**降低**载荷脱敏强度，用户却以为密钥已经迁移
- 🧭 **凭据迁移走人工确认，不静默写入**：拉取侧为每个 ref 生成一条「凭据迁移」项，你确认采纳才写入本机凭据；凭据值全程只在内存中流转，密码不落盘、不落日志、不进响应体
- 🛡️ **红线一条没松**：仍强制「导出密钥必须加密」，凭据载荷**只**存在于加密快照，未加密快照携带凭据载荷一律拒绝；自动同步恒不带凭据

### Highlights (en)

- 🔑 **"Export secrets" now actually exports secrets**: with it checked, `.credentials.yaml` travels as scrypt + AES-256-GCM ciphertext **inside the encrypted snapshot** — credentials genuinely land on the other machine instead of "looks checked, carries nothing". Before the fix the option's only real effect was to **weaken** payload redaction while users believed their secrets had migrated
- 🧭 **Credential migration is confirmed, never silent**: the receiving side turns each ref into a "credential migration" item that is written to the local credential store only after you accept it; values stay in memory — the password is never persisted, logged, or returned to the browser
- 🛡️ **No guardrail was relaxed**: "export secrets ⇒ encryption" still holds, the credentials payload exists **only** in encrypted snapshots, and an unencrypted snapshot carrying one is rejected outright; auto sync never carries credentials

## [0.1.60] - 2026-09-18

> 本版包含**两块互不重叠**的工作：
> 1. **issue 修复**（第一小节）——仓库中 8 条 open issue（#27–#37）的逐条修复，是本版的发布主题；
> 2. **Phase 1 灾备基线**（第二小节）——由竞品源码审计驱动的能力补齐，**代码随本版发布但默认整体关闭**
>    （两个开关均为 `false`，路由返回 503），不改变本版对外可见的行为。
>
> 本版**没有**修复的、以及只做到一半的，都在 `docs/spec/known-gaps.md` 里如实登记（G-15 明确标为「部分修复」）。

### 🐞 issue 修复（#27 / #28 / #29 / #30 / #31 / #35 / #36 / #37）

- **#37 复检发现的越界读取（本轮自查修复）**：跟随链接时，**文件**符号链接（`skills/link.md`
  → home 外文件）此前只对「目录链接」做了 home 边界检查，内容会被读进备份——CLI 既有回归
  `T2-P3` 当场抓到。现在目录链接与文件链接共用同一 realpath 判据：目标越出 `$DSH_HOME`
  一律跳过并记 `outside-home`（内容绝不读入）。同时把「目录读取失败」也纳入告警
  （此前 ACL/竞态导致的目录读失败被静默吞掉，症状与 #37 同类）。
- **#37 CLI 离线备份路径（`dsh-config-manager backup`）同样静默跳过链接**：issue 点名的
  两条路径里，Web UI 已修而 CLI 未修（`core/backup-plan.ts` 自带的遍历写死「绝不跟随链接」
  且零告警）。现在两条路径共用 `utils/recursive-walk.ts`，CLI 也会跟随 home 内链接并在
  报告 warnings 里写明「跟随了 N 个」「哪些链接/目录没进来及原因」。
- **#35 复检发现的顺序与越权缺陷（本轮自查修复）**：patch 文件项原本排在
  `plugins:pnpm-workspace` **之后**，而配置项的 applyItem 又会替它把 patch 文件写掉——
  ① 会留下「声明在、文件未到」的窗口（中途中断后目标机 pnpm 从此拒绝一切 add）；
  ② 绕过了用户在 patch 文件冲突项上的 `keepCurrent` 选择（正是 issue #35 要消除的静默覆盖）。
  现在 patch 文件项**先于**配置项执行，配置项只按**磁盘真实状态**决定是否剔除声明，不再越权写文件。
- **#35 附带（工具链变更可见可取消）**：`plugins:pnpm-workspace` 在本次同步中**移除了**
  patchedDependencies 声明时（带 detail），进入一键同步的确认列表（默认仍采用，但用户可取消）；
  普通内容变更不进列表，不制造噪音。
- **#31 收口**：autosync 的 `acquire` 抛错分支（锁目录 IO/权限故障）此前同样不写历史——
  现补写，使「自动同步不再更新」这一症状不再有任何静默出口。
- **#36 残留锁在 Windows 上无法回收**（`src/utils/env-lock.ts`）：Windows 拿不到 OS
  process identity，PID 又会被复用，于是「心跳过期 + pid 存活」永远停在 `UNKNOWN_STATE`，
  连官方 `recover-stale-lock` 都拒绝，用户只能手工删锁文件。现在引入**心跳长过期**判据
  （阈值 = `max(30 × staleAfterMs, 30 分钟)`，可注入）：越过阈值即判为残留锁，
  **显式**回收可成功。acquire 侧依旧绝不自动摘锁——放宽的只是「显式回收」这一条人工路径，
  且 `inspectLockState` 与回收二次验证 `reProveStale` 使用**同一**判据（否则首次判定可回收、
  二次验证又判非 stale → quarantine，等于没修）。
- **#37 skills 等文件类分区静默跳过 junction / 符号链接**（`src/utils/recursive-walk.ts`、
  `src/adapters/link-report.ts`）：`readdir` 对目录链接返回 `isSymbolicLink() === true`，
  旧实现只处理 `isDirectory()/isFile()`，链接目录连同其**全部真实内容**被静默排除，备份照样
  报成功（实测 8 个链接目录约 12 MB 内容丢失）。现在**跟随**目录链接收集内容，用 realpath
  去重防环（自引用/重复链接/深度上限），并把「跟随了 N 个链接（导入按普通目录还原，链接结构
  不会重建）」「跳过了 N 个链接且**其内容未进备份**（原因 + 路径）」写进备份报告——
  缺了后半句，用户依然无从察觉缺失。越出 `$DSH_HOME` 的目标仍不进备份（既有边界不变），但会留痕。
- **#35 只搬 `pnpm-workspace.yaml` 的 `patchedDependencies` 声明、不搬 patch 文件**
  （`src/adapters/pnpm-workspace.ts`、`src/adapters/plugins.ts`）：目标机拿到「声明在、
  `patches/*.patch` 不在」的组合后，pnpm 会拒绝**一切** `add`（含与补丁无关的插件），
  实测一次「一键同步 → 确认导入」13/13 插件安装全灭、而同步仍报成功。现在：
  ① 导出时把 `patches/**` 作为 `plugins.patchFiles` 随分区携带（源机缺文件 → 显式告警）；
  ② 导入时先落 patch 文件，再写入**剔除目标机无法满足的声明**后的配置（按行改写，保留注释与
  CRLF，不整文件重写；单行 flow 形态不猜着改，改为告警）；③ 剔除在计划里以 **Warning 项**
  显式可见（一键同步的确认列表现在也渲染 Warning，不再静默自动采用）；
  ④ 安装失败分类新增 `patch-file-missing`，给出可操作修复路径，而不是 13 条「插件装不上」；
  ⑤ 供应链：`patchFiles` 非空在**发布侧与导入侧**双端拒收（与 `localTarballs` 同级），
  `patchFiles[].relativePath` 进结构校验（拒绝绝对路径 / 上跳路径）；
  ⑥ 每个 patch 文件都是**计划项**（Create/Skip/Conflict）并进入**导入前快照**——否则导入覆盖了
  目标机原有 patch 文件后再回滚，原文件会永久丢失（新增 ref 前缀 `patchFile:` 与 patch **行** id
  区分开，`resolveFileTarget`/`captureTarget` 同步支持）。
- **#35 附带（可观测性）**：插件安装失败返回 `{ok:false, warning:true}`（§34.17 非致命语义），
  而 journal 把「非 ok / 非 failed」一律记成 `skipped` 且不落 message → 事后审计（人 / CLI / agent
  读 `transactions` 或 `migration-history`）会得出「用户跳过了这些插件、同步成功」的错误结论。
  现在 `warning` → `attention`（不可证明已应用），`skipped` 只留给真正的跳过，并持久化
  `message`（`src/core/analyzer.ts`、`src/core/journal.ts`）。
- **#28 「装了插件但备份没识别到」的剩余形态**（`src/core/plugin-cli.ts`）：已装清单此前只遍历
  `package.json` 的 `dependencies`，仅通过 `dsh.profile.bundles` 声明的层**完全不可见**——
  而 DSH 启动时确实会挂载它们（`reconcileBundles` 对这类条目是保留的）。现在 bundles 中
  非依赖、非 in-box 的条目也进入清单（版本取 `node_modules` 落盘版本）。
- **#27 / #29 / #30 / #31**：核对并保留已落地的修复（残锁分类文案与 `--help` / README 可见性、
  未配置 token 视为「未登录」而非 500、插件私有出站代理、定时备份与自动同步的锁跳过文案与
  历史、以及 423 文案所指向的「事故恢复 → 回收残留锁」GUI 入口），并补上 #31 遗漏的两处：
  自动同步被挡时**补写 sync-history**（此前连历史都不写，用户只能看到「自动同步不再更新」）、
  客户端 `describeSkipReason` 对 `mutation-locked` 给出可读中文。

### 📄 文档与契约同步

- `docs/spec/bundle-format-v1.md`：登记 `plugins.patchFiles` 字段、市场双端拒收、以及
  **实现者注意**「`pnpmWorkspace` 与 `patchFiles` 必须同进同出」。
- `docs/spec/known-gaps.md`：新增 **G-14**（同步只搬声明不搬 patch 文件）并标记已修复。
- `README.md`：`recover-stale-lock` 症状表补「PID 被复用」一行；插件清单来源补
  `dsh.profile.bundles` 说明。

### Phase 1：灾备基线（P0）—— 代码随本版发布，**功能默认关闭**

> 本节补齐与同类 DSH 撤销/回退插件的**能力基线差距**：自动快照、撤销/重做、
> 启动救援模式、崩溃归因。全部为新增能力，不改动既有分区模型与导入/导出契约。
> 尚无对应 issue（由竞品源码审计驱动）。
>
> **阅读提示**：下面这些能力在本版中**用户不可达**（开关为 false）。列出它们是为了让
> 发布内容可被完整审计，而不是宣称它们已可用。

### ⚠️ 默认关闭（本版不对用户开放）

- **灾备子系统整体下线**：`LIFECYCLE_ENABLED = false`（`src/index.ts`）关闭
  自动快照监听、`boot-state` 写入与 `/lifecycle` / `/crash` / `/rescue` 三条路由
  （一律 `503 feature-disabled`）；客户端导航入口同步关闭
  （`SHOW_LIFECYCLE_NAV = false`）。**两个开关必须同开同关**，否则会出现
  「入口可见但功能 503」的错位。
- **为什么下线**：自动快照的采集覆盖**全部 adapter**，其中 `sessions` 分区（历史会话）
  在本机实测 340 MB，远超快照 64 MiB 上限，必然持续失败并刷
  `[lifecycle] 自动快照失败: 配置快照超出上限（479313046 > 67108864 字节）` 告警。
  在该缺陷修好前，撤销/重做/救援也没有可信的快照基线可用，故整体下线而非只停监听。
- 引擎代码与测试**全部保留**（core 模块、客户端组件、路由实现均未删除），修好缺陷后
  把两个开关改回 `true` 即可恢复。已有守卫测试锁定开关确实挂在启动路径上
  （`src/core/phase1-wiring.test.ts` 的「灾备总开关」三条），防止只改注释不改行为。

### 新增

- **自动快照（P0-1）**：监听 DSH 配置目录与用户插件源码目录，防抖合并文件事件后
  自动落一份配置状态快照。含**两层回声抑制**——写操作窗口内直接丢弃事件，窗口外按
  内容指纹识别「恢复动作自写文件」的延迟投递事件。缺了这层，恢复动作会立刻产生一个
  等于刚写回内容的快照，把重做通道堵死。
- **撤销 / 重做（P0-2）**：撤销 = 回退到与当前状态**内容不同**的最新快照（自动快照在
  变更之后采集，所以「最新快照」通常等于当前状态，必须跳过）；撤销前先落 `pre-restore`
  快照使重做可逆；撤销后若又发生真实变更，重做**被拒**而非覆盖用户新改动。全部相同时
  明确报告「没有可撤销的变化」，不做空操作。
- **启动救援模式（P0-3）**：DSH 因插件/bundle 起不来时，备份 `cordis.patch.yml`（home 与
  profile 两层）与 `package.json`，改写为只挂载本插件自身的最小 patch，并把
  `dsh.profile.bundles` 收窄为 **DSH 核心（`@deepseek-ai/*`）+ 本插件**——其余用户插件本次
  启动不挂载（只中和 patch 层救不了「bundle 能解析但插件代码把 DSH 搞挂」这类）；退出时逐
  字节完整还原。含家目录指纹——换机/重建 home 后残留状态自动降级不激活。**救援路由刻意不
  进入 mutation gate**：否则会被它要解决的那个状态挡住，形成死锁。
- **崩溃归因（P0-5）**：`boot-state.json` 记录每次启动结果，上次未正常结束时按日志尾部
  签名分类（`session-corrupt` / `bundle-check` / `patch-tree` / `unknown`）并给出建议动作与
  「最后正常快照」id。归因在启动时一次性持久化——日志会被滚动覆盖，错过就没了。
- 三条新路由：`GET /api/dsh-config-manager/lifecycle/status`、`POST .../lifecycle/{snapshot,undo,redo,remove}`、
  `GET /api/dsh-config-manager/crash`、`GET|POST /api/dsh-config-manager/rescue`。

### 修复（自审 + 独立审计发现的缺陷）

- **退出救援对路径写法敏感（用户实测卡死）**：家目录指纹原先直接哈希 `homeDir` 原始字符串，
  同一目录换个写法（`C:/…` vs `C:\…`、尾分隔符、`.`/`..`）就判 stale 并**拒绝还原、一个文件
  都不动**。从插件 UI 进出时两次都原样传 `host.homeDir` 所以看不出来，从 CLI / 脚本手动进出
  必踩。现在指纹输入经 `normalizeHomeDir` 归一化（resolve + win32 折叠大小写），并兼容历史
  （归一化前）指纹，使**已处于救援态**的用户升级后仍能正常退出。
- **救援没有真正禁用其它插件**：原先只中和 patch 层 + 剪掉「不可解析」的 bundle，bundle 只要
  能解析就照旧挂载，治不了「插件代码自己把 DSH 搞挂」。现在进入救援会把 `dsh.profile.bundles`
  收窄为 DSH 核心 + 本插件；保留了 `@deepseek-ai/dsh-base` / `dsh-web-app`，否则 DSH 自身
  都起不来。UI 文案与代码注释同步改为如实描述。
- **自动快照会丢失中间状态**：watcher 在回调前已把事件批摘除，而 flush 进行中到来的批次被
  直接丢弃且**不再重排**——实测连写 v2、v3 只落 1 份快照，撤销于是无从回到 v2。现在改为排队
  补拍。
- **恢复通道的回声抑制只覆盖撤销/重做**：导入、备份恢复、Profile 切换、同步应用同样会写配置
  文件，却不在抑制窗口内，恢复完会立刻多出一份「等于刚恢复内容」的快照，把重做通道永久堵死。
  现在按「采集状态是否等于最新快照 / 刚回放的目标状态」兜底，覆盖全部通道。
- **撤销可能「假成功」**：某个分区采集失败时状态会少一个分区，与内容其实相同的快照判为
  「不同」→ 选中它 → 回放写不回任何东西却返回 `ok:true`，且 `canUndo` 永远为真。现在采集
  不完整即拒绝撤销（`capture-incomplete`）并让 `canUndo=false`。
- **回放失败仍消费 pre-restore**：重做通道就此消失，而配置正停在半应用的中间态。现在仅回放
  成功才消费。
- **`pre-restore` 记录的可能不是「撤销前状态」**：原先挑目标与落 pre-restore 是两次独立采集，
  之间的用户改动会溜进去，重做时把用户没见过的内容写回去。现在复用同一次采集。
- **一条损坏快照能让整个灾备面板 500**：`meta.state` 未做形状校验，`statesEqual` 会抛
  `TypeError`。现在读取侧丢弃形状不对的 meta，比较侧改为全函数（缺字段不抛）。
- 救援卡片把「自动快照未开启」当成「救援未开启」显示；启动后新出现的 `skills` /
  `.agent-presets` 目录此前在整个进程生命周期内都不会被监听（与注释承诺不符），现已自愈纳入。

### 说明

- 配置状态快照存放于 `<dataDir>/config-snapshots`，与导入前快照 `<dataDir>/snapshots`
  **分目录**：后者由导入计划驱动（只登记本次将写入的目标），无法回答「配置整体变没变」。
  两者保留策略与回放方式都不同，混用会产生错误语义。
- 快照回放复用 adapter 管线（`validate → analyzeImport → applyItem`），与导入/Profile 切换
  同一条写入路径，因此不引入第二套写入逻辑。
- 监听器与定时器全部依赖注入，自动快照时序在测试中由假定时器驱动——不 sleep、不受机器负载
  影响。

### 测试

- 新增 6 个 core 模块与 7 个测试文件；全量套件 1910+ 项通过。
- 含接线守卫（`src/core/phase1-wiring.test.ts`）：断言路由/闸门/dispose 确实在盘上，
  防止「注释承诺 > 实际防线」；守卫自身已按 LF 与 CRLF 双形态验证。
- 上述缺陷各有对应回归测试（含确定性故障注入：`exportGate` 钉死 flush 竞态、
  `failExport` / `failApply` 注入采集与回放失败）。
## [v0.1.59] - 2026-09-13

> 本版把两个**尚未发布**的版本合并为一次发布，因此只占一个版本号。它包含前后两轮工作：前半是**自驱的能力补齐轮次**，方向来自对同类工具（restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains）的能力对照与差距分析，落点选在「会真正丢东西」与「可靠性无法自证」两类问题上；后半是**格式规格化 + 全量缺陷修复**轮次，方向是把 bundle 格式从「实现细节」变成**可被第三方独立实现的对外契约**，并在此过程中把审计挖出的缺陷**真正修掉**（而非仅登记）。两轮均不针对任何新提交的 issue。

### 🎯 亮点 / Highlights (zh)

- 🧩 **本地开发中的插件不再随换机丢失（能力补齐轮次最重要）**：以 `link:` / `file:` 安装的插件，其依赖 spec 指向的是**本机绝对路径**（例如 `link:D:/Projects/my-plugin`）。导出备份时会原样记下这条路径，而目标机器上它根本不存在——导入时该插件必然安装失败，且**失败是静默的**（备份看起来完好）。现在导出阶段会对这类插件执行 `npm pack`，把打出的 tarball 一并放进备份；导入阶段先解包到 `$DSH_HOME/dsh-config-manager/local-plugins/`，再把 spec 重写为 `file:<绝对路径>` 交给官方安装通道。单个插件打包失败**不会中断导出**（记 warning 跳过，其余继续），超过 100 MB 的 tarball 会被跳过并告警。**密钥排除规则不受影响**——进入备份的是插件代码，不是凭据
- 🔍 **CLI 补上 `verify`：回答「三个月前那个备份现在还能不能用」**（此前无任何入口）。它把备份 ZIP 从磁盘重读一遍、**一个字节都不写**，给出五种互斥裁决：`OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`。逐条目重算 SHA-256 与 `integrity/checksums.json` 比对，不符时**点名具体条目**（而不是只给个总数）；解压全程走既有强化解析器（Zip Slip / 压缩炸弹 / 符号链接 / 重复条目名一律拒绝）。**校验失败绝不降级成"大概没问题"**——`VERIFY_ERROR` 只用于自检自身失败（磁盘 IO 等），明确区别于「备份确实坏了」。退出码语义明确（全 OK → 0，任一非 OK → 1），并支持 `--json` 供 CI 与定时任务断言
- 💾 **CLI 补上 `backup`：DSH 起不来时也能备份**。此前的 CLI 是「能恢复但不能备份」——GUI 与 Agent 工具都能备份，唯独救急通道缺这一半。现在可离线把 `$DSH_HOME` 下**离线可直读**的分区打成与 GUI 同结构的 ZIP（manifest + checksums + 分区目录），并立即自检。**刻意不伪造结构化分区**：`settings` 等必须经 DSH 服务层权威脱敏、离线拿不到，这类分区**不进归档并在输出里列为"离线不可收集"**——宁可如实告知，也不产出一个「声称含设置、实际为空」的假备份（那会让恢复者误以为配置已经保住）
- 🗄️ **保留策略可配置，支持 GFS 分层**：快照与定时备份的保留策略此前是**三处硬编码常量**（快照 10 / 定时备份 10），用户完全不可调；总览页的分母还写死了字符串 `'10'`，改常量会导致 UI 与实际行为不一致。现在策略可配——「最近 N 份 + 每月留 1 份 + 每年留 1 份」（参考 restic `forget` 的分层思路，配置备份这类「体积小、变化频繁」的场景比纯 FIFO 更合用）。**默认值与旧行为逐字节等价**（`keepLast: 10` 且分层关闭时直接走原函数），既存快照的清理结果不会发生任何变化
- 🛡️ **配置市场两端拒绝内嵌插件代码**：本轮给 `plugins` 分区新增的本地插件 tarball 字段（`localTarballs`），在**发布端**（`prepareMarketItem`）与**导入端**（市场条目校验）**同时硬拒绝**。原因：tarball 是不可经公开仓库审阅的不透明二进制，安装时可能执行 `postinstall`——若允许它经市场分发，等于给「分享配置」开了一条携带任意代码、绕过既有 BANNED 分区防线的通道。本地插件迁移只应发生在**自己的备份**里。该字段也因此**不会**成为新的供应链入口

- 🚦 **CI 有了 PR 门禁**：此前 `.github/workflows/` 只有发布流水线（仅 `tag v*` 触发），dependabot 与外部贡献的 PR **全绿与否无人校验**即可合并。现在新增 `ci.yml`：`pull_request` → `main` 与 `push` → `main` 跑完整的 typecheck → test（全量 1600+ 项）→ build → pack，**零发布副作用**（不含 publish、不申请 OIDC 凭据、权限仅 `contents: read`），并带并发取消（同分支新提交自动取消旧运行）与超时兜底

- 📜 **bundle 格式 v1 有了对外规格**（`docs/spec/bundle-format-v1.md`，1312 行）：逐条 `file:line` 取证 + 显式「未验证」清单，配 manifest 的 JSON Schema（`bundle-manifest.schema.json`）与可执行一致性语料（`tests/conformance/`）。规格的核心章节是**向前兼容规则**——导入端遇到「未知分区」「未知顶层字段」「已知分区内的未知字段」时分别保留还是忽略，逐条实测写明。**同时诚实登记了尚存的空白**：各 adapter 的冲突判定规则、`PlanItem.id` 命名约定、对外返回类型契约仍未规格化，第三方据此仍**无法**完整实现兼容 importer
- ⛓️ **迁移链从「死代码」变成真实接入（缺陷修复轮次最重要）**：`migrateToCurrent` 此前**全库零 import**——有定义、有注册、有单测，却**从未被导入路径调用**。叠加 `MIN_SUPPORTED = CURRENT = 1`，整条迁移链**一次都没真正执行过**。这意味着发布 schema v2 那天，旧备份会被判定「可迁移」却**不迁移**，用户拿到静默的错误数据。现在导入路径在 `needsMigration` 为真时真实调用迁移链、用迁移结果替换 manifest，并重新校验结果合法性
- 🔍 **「不认识」与「文件缺失」不再混为一谈**：此前未知分区被**静默丢弃**，而唯一的相关告警还把原因说反了——报「备份声明了但**缺少**的分区: X」，**而文件其实就在 ZIP 里**。用户无法判断该升级插件还是备份坏了。现在未知分区走独立的 `unsupportedSections` 通道与专属告警文案；分区数据版本高于本版本时**跳过该分区并告警**，而不是让**整个 bundle** 无法导入（数据损坏类的非法版本号仍硬失败）
- 🧾 **完整性校验补上反向检查**：此前 checksums 只保证「表内条目未被篡改」，不保证「ZIP 内没有多余条目」，且**剥掉校验表即可无提示通过**。现在未登记条目会明确告警，校验表缺失或为空时也会显式告知「全部条目未被校验」——**不再有静默通过路径**
- 🔐 **加密备份不做任何密码强度校验（刻意的产品决策）**：加密备份的密码策略**完全由用户自己掌握**，插件不施加任何强度约束——`1`、`12345678`、`password` 一律可用。**唯一约束是密码非空**（空字符串会被拒），加密入口除此之外不再做任何判定。这项决策同时**删除**了此前那个强度校验函数：它在上一版（`v0.1.58`）中虽已实现且有单测，却在宿主入口**从未被调用**——一个「看起来在守、实际不跑」的死代码。本版选择**直接移除**而不是把它接通，因为留着一个永不生效的闸门比没有闸门更危险：它会让维护者和审计者误以为防线存在。**解密方向同样不校验**（且现在整个校验面都不存在）——否则历史弱密码备份会**永久打不开**
- 🕵️ **文件类分区纳入凭据扫描**：`skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` 的内容此前**完全不进扫描器**，也不计入 `redactedHits`——「默认不含秘密」这条不变量对它们**不成立**。现在导出时做文本级扫描并告警（**只报告、绝不改写**——那是用户的真实文件），且三条导出路径（HTTP 路由 / `config_backup` / 定时自动备份）注入**同一个** scanner 实例，避免档位漂移
- 📦 **引擎可被 headless 环境零成本消费**：`@radix-ui/*` 与 `lucide-react` 已被内联进 `lib/client.js`，却仍挂在 runtime `dependencies`，迫使只想复用引擎的消费者安装整套 React UI 栈。现在它们归入 `devDependencies`，且全部 16 个 peer 标记 `peerDependenciesMeta.optional`（它们由 DSH 宿主提供）。**默认安装从 74 个包 / 32.25 MB 降到 3 个包 / 8.84 MB**；同时 `files` 排除 140 个 `.map`，发布包从 2.48 MB 降到 1.88 MB。`./schema` 导出位此前指向纯类型产物（运行时 **0 导出**），现在是真实的运行时入口

### Highlights (en)

> This release merges two **as-yet-unpublished** versions into a single release, so it occupies only one version number. It spans two rounds of work. The first is a self-driven **capability-gap round**, scoped by comparing against peer tools (restic / kopia / Borg / rclone / Duplicati / Syncthing / chezmoi / yadm / mackup / VS Code / JetBrains) and targeting two classes of problem: things that **actually lose data**, and reliability that **cannot be self-proven**. The second is a **format-specification and defect-remediation round** that turns the bundle format from an implementation detail into a contract **a third party can implement independently**, and **actually fixes** — rather than merely logs — the defects the audit surfaced. Neither round addresses a newly filed issue.

- 🧩 **Locally developed plugins no longer vanish when you change machines (the capability round's headline fix)**: plugins installed via `link:` / `file:` carry a dependency spec that points at a **machine-local absolute path** (e.g. `link:D:/Projects/my-plugin`). The backup used to record that path verbatim, but it does not exist on the target machine, so the plugin inevitably failed to install — **and failed silently** (the backup looked perfectly fine). Export now runs `npm pack` for such plugins and bundles the resulting tarball; import unpacks it under `$DSH_HOME/dsh-config-manager/local-plugins/` and rewrites the spec to `file:<absolute path>` for the official install path. A single plugin failing to pack **never aborts the export** (recorded as a warning, the rest continue), and tarballs above 100 MB are skipped with a warning. **Secret-exclusion rules are unaffected** — what enters the backup is plugin code, not credentials
- 🔍 **New CLI `verify`: "is that backup from three months ago still usable?"** There was previously no way to ask. It re-reads the backup ZIP from disk and **writes not a single byte**, returning five mutually exclusive verdicts: `OK` / `MISSING` / `CORRUPT` / `UNSUPPORTED` / `VERIFY_ERROR`. It recomputes SHA-256 per entry against `integrity/checksums.json` and **names the offending entries** rather than reporting a bare count; extraction goes through the existing hardened parser (Zip Slip / zip bombs / symlinks / duplicate names all rejected). **A failed check is never downgraded to "probably fine"** — `VERIFY_ERROR` is reserved for failures of the check itself (disk I/O), which is explicitly distinct from "the backup is genuinely broken". Exit codes are unambiguous (all OK → 0, any non-OK → 1) and `--json` is available for CI and scheduled assertions
- 💾 **New CLI `backup`: back up even when DSH cannot start.** The CLI could previously restore but not back up — the GUI and the agent tools could both back up, yet the emergency path was missing exactly that half. It now builds, fully offline, a ZIP with the same structure the GUI produces (manifest + checksums + section directories) from the parts of `$DSH_HOME` that are **directly readable offline**, then self-verifies it. It **deliberately does not fabricate structured sections**: `settings` and friends must be authoritatively redacted through the DSH service layer and are unobtainable offline, so those sections **stay out of the archive and are reported as "not collectable offline"** — honest disclosure rather than a bogus backup that claims to contain your settings while being empty (which would leave a restorer believing the configuration was saved)
- 🗄️ **Configurable retention with GFS tiers**: snapshot and scheduled-backup retention used to be **three hard-coded constants** (10 snapshots, 10 scheduled backups) that users could not change at all, and the overview page hard-coded the string `'10'` as its denominator, so changing a constant would silently desync the UI from real behaviour. Retention is now configurable — "the last N + one per month + one per year" (modelled on restic `forget`'s tiered thinking; a better fit for config backups, which are small and change often, than pure FIFO). **Defaults are byte-for-byte equivalent to the old behaviour** (`keepLast: 10` with tiers disabled calls the original function directly), so pruning results for existing snapshots do not change at all
- 🛡️ **The marketplace rejects embedded plugin code at both ends**: the local-plugin tarball field (`localTarballs`) added to the `plugins` section this round is **hard-rejected on both the publish side** (`prepareMarketItem`) **and the install side** (market item validation). The reason: a tarball is an opaque binary that cannot be reviewed through a public repository and may run `postinstall` on install — allowing it through the marketplace would open a channel for shipping arbitrary code via "shared config", bypassing the existing BANNED-section defenses. Migrating locally developed plugins belongs in **your own backup**, not in a public marketplace item. The field therefore does **not** become a new supply-chain entry point

- 🚦 **CI now has a PR gate**: `.github/workflows/` previously held only the release pipeline (triggered solely by `tag v*`), so dependabot and external-contribution PRs **could be merged with nobody checking whether they passed**. The new `ci.yml` runs the full typecheck → test (1600+ tests) → build → pack on `pull_request` → `main` and `push` → `main`, with **zero release side effects** (no publish step, no OIDC credentials requested, `permissions: contents: read` only), plus concurrency cancellation (a newer push to the same branch cancels the stale run) and a timeout guard

- 📜 **Bundle Format v1 now has a public specification** (`docs/spec/bundle-format-v1.md`, 1312 lines): per-claim `file:line` evidence plus an explicit "unverified" list, alongside a JSON Schema for the manifest and an executable conformance corpus (`tests/conformance/`). Its central chapter is **forward-compatibility**: whether an importer preserves or ignores an unknown section, an unknown top-level field, and an unknown field inside a known section — each determined by measurement, not assumption. It **also honestly records what is still missing**: per-adapter conflict rules, the `PlanItem.id` convention, and the return-type contracts are not yet specified, so a third party still **cannot** fully implement a compatible importer
- ⛓️ **The migration chain went from dead code to genuinely wired in (the defect-remediation round's most important reliability fix)**: `migrateToCurrent` had **zero importers anywhere** — defined, registered, unit-tested, and **never called by the import path**. Combined with `MIN_SUPPORTED = CURRENT = 1`, the entire chain had **never once executed for real**. The consequence: on the day schema v2 ships, an old backup would be judged "migratable" and then **not migrated**, handing the user silently wrong data. The import path now genuinely invokes the chain when `needsMigration` holds, replaces the manifest with the migrated result, and re-validates it
- 🔍 **"I don't recognise this" is no longer conflated with "the file is missing"**: unknown sections used to be **silently dropped**, and the only related warning stated the cause backwards — "sections declared by the backup but **missing**: X" — **while the file was in fact inside the ZIP**. Users could not tell whether to upgrade the plugin or distrust the backup. Unknown sections now travel a dedicated `unsupportedSections` channel with their own message; a section whose data version is newer than this build is **skipped with a warning** instead of making the **whole bundle** unimportable (genuinely invalid version numbers still fail hard)
- 🧾 **Integrity checking gained its reverse direction**: checksums used to guarantee only that "entries in the table were not tampered with", never that "the ZIP contains nothing extra" — and **removing the checksum table made everything pass silently**. Unregistered entries now warn, and a missing or empty table explicitly reports that **no entry was verified**. There is **no longer a silent-pass path**
- 🔐 **Encrypted backups apply no password-strength validation at all (a deliberate product decision)**: the password policy for an encrypted backup belongs **entirely to the user** — the plugin imposes no strength requirement, so `1`, `12345678` and `password` are all accepted. **The only constraint is that the password is non-empty** (an empty string is rejected); beyond that the encryption entry point makes no judgement. This decision also **deleted** the strength-checking function: it existed in the previous release (`v0.1.58`) with unit tests, yet had **zero call sites** in the host entry — dead code that looked like a guard but never ran. This release **removes** it outright instead of wiring it up, because a gate that never fires is more dangerous than no gate: it leads maintainers and auditors to believe a defence exists. **Decryption is likewise never validated** (and no validation surface exists at all now) — doing so would make **historical weak-password backups permanently unopenable**
- 🕵️ **File-type sections are now scanned for credentials**: the contents of `skills` / `agentPresets` / `agentInstructions` / `pluginFiles` / `sessions` / `self` previously **never entered the scanner** and were excluded from `redactedHits` — so "no secrets by default" **did not hold** for them. Export now scans their text and warns (**report only, never rewrite** — these are the user's real files), and all three export paths (HTTP route / `config_backup` / scheduled auto-backup) inject **the same** scanner instance so their strictness cannot drift apart
- 📦 **The engine is now consumable from a headless environment at zero cost**: `@radix-ui/*` and `lucide-react` are already inlined into `lib/client.js` yet still sat in runtime `dependencies`, forcing anyone who wanted only the engine to install a whole React UI stack. They now live in `devDependencies`, and all 16 peers are marked `peerDependenciesMeta.optional` (they are supplied by the DSH host). **A default install drops from 74 packages / 32.25 MB to 3 packages / 8.84 MB**, while `files` now excludes 140 `.map` files, shrinking the published tarball from 2.48 MB to 1.88 MB. The `./schema` export used to point at a types-only artifact (**0 runtime exports**); it is now a real runtime entry point

## [v0.1.58] - 2026-09-12

> 本版为自驱的 UI 打磨与缺陷修复轮次，**不针对任何新提交的 issue**（#27-#30 的修复随 v0.1.57 发布）。

### 🎯 亮点 / Highlights (zh)

- 🧭 **历史页「分类筛选」首次真正生效**：此前后端查询契约（`filterToQuery`）已实现、单测全绿，但历史面板从未把筛选条件传给后端（`list()` 不带参），于是「分类 / 结果」下拉**可点却纹丝不动**——纯函数已写、组件从未接线的空接线缺陷。现改为前端收敛（`filterByKindResult`）：下拉只列出**当前数据里真实出现过**的分类与结果（全部 14 类中多数在本机永远不会出现，列出来只会让人选中"永远为空"的选项），并强制保留当前选中项，避免「选中了却在下拉里找不到」；统计徽章与分组随之反映筛选结果
- 📊 **同步历史改用设计系统数据表 + 顶部统计摘要**：该表此前用字符串 class `sync-history-table`（全仓唯一字面量，且**无任何 CSS 规则**，等同于裸表格）。现改用 `.dataTable/.tableFixed/.tableCompact`（限高内滚 + 固定列宽），并在表头新增统计摘要徽章行（总数 / 快照 / 自动同步 / 失败 / 跳过，**失败与跳过仅在存在时出现**并给语义色）；快照 UUID 中段省略、保留头尾区分信息（悬停仍给全文），时间列等宽 11px 单行显示、悬停给出**含秒**的完整本地时间；自动同步的跳过原因独立成第二行小字，状态徽章带语义色
- 🧹 **「建议依据」去重**：迁移前咨询卡的建议依据是各维度问题文案的直接拼接，同一句可能被重复 push 多次（如「存在需注意的迁移项」按迁移项逐条 push）。现按**原文**去重并保持首次出现顺序，重复项以「×N」标注，空串与纯空白条目丢弃（刻意不做 trim 合并、不做大小写折叠，避免把不同内容误并）
- 📄 **长配置明细不再横向溢出**：导入冲突的「配置更改明细」原用 `<pre>`（`white-space: pre` 不换行），长 JSON 会把卡片撑出左右滚动条。现拆成 `current` / `imported` 两段各自独占一行、中间以 1px 分割线区隔，长值任意位置折行
- 🪟 **导出预览改为弹窗 + 分区构成共用组件**：预览结果由行内横幅改为宽弹窗（加载 / 合计 / 分区构成 / 错误都在弹窗内呈现，点击立即打开不再等待），并与总览页共用新的 `SectionComposition` 分区构成网格，两处视觉与文案完全一致
- 📋 **备份计划卡信息分层**：改为「头部（标题 / 结果徽章 / 动作）→ 事实行（开关状态 / 备份间隔 / 上次运行）→ 说明 → 设置行」。事实行统一取**宿主权威值**，未保存的草稿不再改写它，避免把尚未生效的档位显示成已生效；关闭定时备份时隐藏间隔与时刻下拉，减少无关噪音
- 📐 **布局回归修复（含暗色主题下的突兀色块）**：`.input/.select` 移除全局 `width:100%`（市场筛选、同步快照下拉等**行内**控件曾被撑成各自独占一整行），满宽只在纵向字段内按需生效；`.shellNav` 不再铺底色（暗色下其底色比宿主设置面板底色更暗，会形成一条通栏色块）；弹窗尺寸放大以容纳长内容；新增 `.actionRowTop/.tabRow/.headRow/.authorRow` 行原语，把「行」的语义与间距集中到 CSS，不再各处内联 margin；市场筛选改为 2 列网格
- 🐛 **修复备份页选中行高亮丢失**：快照列表行原本带 `data-selected` 提供选中淡底，随本轮重构被误删，导致 listbox 选中态**只剩语义（`aria-selected`）没有视觉反馈**。已恢复

### Highlights (en)

> This release is a self-driven UI polish and defect-fix round and **does not address any newly filed issue** (the #27-#30 fixes shipped in v0.1.57).

- 🧭 **History category filtering works for the first time**: the backend query contract (`filterToQuery`) was implemented and fully unit-tested, but the history panel never passed the filter to the backend (`list()` took no arguments), so the kind / result dropdowns **could be changed without affecting the list at all** — a pure function written and tested, yet never wired up. Filtering is now applied on the client (`filterByKindResult`); the dropdowns list only the kinds and results that **actually occur in the current data** (most of the 14 kinds never occur on a given machine, and offering them only lets you pick an option that is always empty), the current selection is always kept in the list, and the summary badges and grouping follow the filtered set
- 📊 **Sync history now uses the design-system data table, with a header summary**: the table previously used the string class `sync-history-table` (the only such literal in the repo, and it had **no CSS rules at all** — effectively a bare table). It now uses `.dataTable/.tableFixed/.tableCompact` (height-capped inner scroll with fixed column widths), and gains a summary badge row in the header (total / snapshots / auto sync / failed / skipped, where **failed and skipped appear only when non-zero** and carry semantic colours); snapshot UUIDs are middle-ellipsized so the distinguishing tail survives (the full value stays in the tooltip), timestamps render as a single line of 11px monospace with the **second-precision** local time on hover, and the auto-sync skip reason moves to its own second line with a colour-coded status badge
- 🧹 **"Reasons" de-duplication**: the pre-migration consult card builds its reasons by concatenating dimension issue messages, so the same sentence could be pushed repeatedly (e.g. "there are migration items to review", pushed once per item). Reasons are now de-duplicated **literally**, keeping first-appearance order, with repeats labelled "×N" and empty or whitespace-only entries dropped (deliberately no trim-merging and no case folding, which would merge genuinely different content)
- 📄 **Long conflict details no longer overflow horizontally**: the import conflict "configuration change detail" used a `<pre>` (`white-space: pre`, no wrapping), so a long JSON blob forced a horizontal scrollbar. It is now split into `current` and `imported` lines separated by a 1px rule, wrapping anywhere
- 🪟 **Export preview is now a dialog, sharing the section-composition component**: the preview moved from an inline banner to a wide dialog (loading / totals / section breakdown / errors all render inside it, opening immediately instead of waiting), and it now shares the new `SectionComposition` grid with the overview page so both render identically
- 📋 **Backup schedule card re-layered**: header (title / result badge / actions) → fact rows (enabled state / interval / last run) → notes → settings. The fact rows always read the **host-authoritative** values, so unsaved drafts no longer rewrite them (previously an unsaved interval could appear to be in effect); interval and time dropdowns are hidden while scheduled backup is off
- 📐 **Layout regression fixes (including a dark-theme colour block)**: `.input/.select` no longer default to `width: 100%` (inline controls such as the market filters and the sync snapshot picker were each being stretched onto their own full-width row) — full width now applies only inside vertical field containers; `.shellNav` no longer paints a background (in dark themes its colour is *darker* than the host settings panel, producing a full-width slab); dialogs were enlarged for long content; new row primitives `.actionRowTop/.tabRow/.headRow/.authorRow` centralise row semantics and spacing in CSS instead of scattered inline margins; the market filters became a two-column grid
- 🐛 **Fixed the lost selected-row highlight on the backup page**: snapshot rows carried `data-selected` for their selected tint, which was dropped during this refactor, leaving the listbox selection with **semantics (`aria-selected`) but no visual feedback**. Restored

## [v0.1.57] - 2026-09-11

### 🎯 亮点 / Highlights (zh)

- 🌐 **出站请求现支持代理**（issue #30）：GitHub 登录与市场/同步请求不再受「必须经代理访问 GitHub」的网络限制。插件现在自行读取 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 并让**自身**出站经代理（`https` 目标走 `CONNECT` 隧道 + TLS，`http` 目标走 absolute-form），覆盖 GitHub API、device flow 登录与 WebDAV 同步三条路径 —— 此前 Node 内置 fetch 默认不读代理变量，导致 device flow 报 `fetch failed`、`/me/status` 返回 500。**未配置代理时行为完全不变**；代理凭据绝不进日志；可用 `DSH_CONFIG_MANAGER_PROXY=off` 强制直连。相比 `NODE_USE_ENV_PROXY` 的进程级开关，本实现**只影响插件自身**，不会改变宿主（含模型 API）的出站行为，也不要求 Node ≥ 24.14
- 🔓 **未配置 token 不再报「登录状态读取失败」**（issue #29）：首次使用（credentials 中尚无同步 token）时「我的配置」会误报错误横幅。现在「未配置 token」与「token 失效（401）」统一视为**未登录**，正常显示「未登录 + 使用 GitHub 登录」；而网络/限流等**真实故障仍如实报错**，不会被伪装成未登录
- 🔧 **残留环境锁可识别、可恢复**（issue #27）：进程被强制结束（任务管理器 / `kill -9`）后留下的环境锁此前与「另一任务运行中」共用同一句「请稍后重试」，但残留锁**永远不会自愈**，导致上传/同步持续失败且无从下手。现在残留锁单独提示「重试或重启 DSH 均无效」并给出恢复方式；`recover-stale-lock` 命令补进 `--help` 与 README（此前是隐藏命令）；自动同步被挡时也会写出同样的可操作指引。**恢复策略不变**：仍只在持有者被确证死亡时回收，绝不自动摘活锁
- 🩺 **插件清单来源可自查**（issue #28）：在「关于」页新增「插件清单来源」诊断位，显示清单**实际读取的目录 / profile 名 / 识别到的插件数量**；当该目录读不到 `package.json` 时会明确告警。用于定位「明明装了插件、备份里却识别不到」（profile 或 `DSH_HOME` 与实际不符）
- ✨ **界面全面翻新（Visual Polish）**：统一图标（Lucide）与弹窗（Radix Dialog，含完整 focus trap / Esc / 焦点还原）、新增 Toast 通知；顶部页签条与底部状态栏改为圆角分段条；概览页指标可**精确跳转**到对应子视图，健康段在存在待处理恢复事项时直达「事故恢复」；移除常驻冗余绿灯提示。视觉仍 100% 走 DSH `--dsw-*` token，不引入第二套视觉体系

### Highlights (en)

- 🌐 **Proxy support for outbound requests** (issue #30): GitHub sign-in and market/sync requests no longer break on networks where GitHub is reachable only through a proxy. The plugin now reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` for **its own** egress (`https` via `CONNECT` tunnelling + TLS, `http` via absolute-form), covering the GitHub API, the device-flow login and WebDAV sync — Node's built-in `fetch` ignores proxy variables, which previously produced `fetch failed` on device flow and HTTP 500 on `/me/status`. **No behaviour change when no proxy is configured**; proxy credentials are never logged; `DSH_CONFIG_MANAGER_PROXY=off` forces direct connections. Unlike the process-wide `NODE_USE_ENV_PROXY`, this affects **only the plugin**, leaving host egress (including model API calls) untouched, and does not require Node ≥ 24.14
- 🔓 **Missing token no longer shows "failed to read sign-in status"** (issue #29): on a fresh setup (no sync token in credentials) "My Configs" wrongly rendered an error banner. "No token" and "token rejected (401)" are now treated alike as **not signed in**, showing "Not signed in + Sign in with GitHub", while genuine failures (network / rate limit) still surface as real errors instead of being disguised as a sign-out
- 🔧 **Leftover environment locks are now identifiable and recoverable** (issue #27): after a force-killed process (Task Manager / `kill -9`) the leftover lock shared the generic "please retry later" message with a genuinely busy lock — yet a leftover lock **never clears by itself**, so uploads/syncs kept failing with no way forward. It now reports that retrying or restarting won't help and points at the fix; `recover-stale-lock` is documented in `--help` and the README (it used to be a hidden command); autosync logs the same actionable hint. **Recovery policy is unchanged**: a lock is still reclaimed only when its owner is proven dead — a live lock is never taken over
- 🩺 **Self-service diagnostics for the plugin list** (issue #28): the About page now shows which directory / profile the plugin list was actually read from and how many plugins were detected, with an explicit warning when `package.json` cannot be read — pinpointing "plugins installed but missing from the backup" (a mismatched profile or `DSH_HOME`)
- ✨ **Full UI refresh (Visual Polish)**: unified icons (Lucide) and dialogs (Radix Dialog with proper focus trap / Esc / focus restore), new toast notifications; the top tab strip and bottom status bar became rounded segmented bars; overview metrics now deep-link to the matching sub-view and the health segment jumps straight to "Incident recovery" when recovery items are pending; the redundant always-on green banner was removed. Styling still uses DSH `--dsw-*` tokens exclusively — no second visual system

## [v0.1.56] - 2026-09-03

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 自动跟随重定向**：同步通道现可自动跟随 301/302/303/307/308 跳转（上限 5 跳）——修复 123pan 等网盘 WebDAV 把下载 GET 302 到带时效签名 CDN 直链导致 list/push/pull 全部失败的问题（issue #25）；跨域跳转自动剥离 Authorization（Basic 凭据不会转发给 CDN 第三方域名），303 且非 GET 时按语义降级为 GET；跳转循环给出清晰报错
- ✏️ **WebDAV 配置弹窗文案修正**：服务器地址帮助文案由过时的 `snapshots/` 子目录更新为实际的 `dsh-config-manager/` 子目录，与 v0.1.55 起的远端存储路径一致

### Highlights (en)

- 🔄 **WebDAV redirect following**: the sync channel now follows 301/302/303/307/308 redirects (up to 5 hops) — fixing syncs that fail entirely on pan-drive WebDAV servers (e.g. 123pan) which redirect download GETs to time-signed CDN direct links (issue #25); cross-origin hops strip `Authorization` so Basic credentials never leak to third-party CDN domains, 303 downgrades non-GET methods to GET per spec, and redirect loops now surface a clear error
- ✏️ **WebDAV setup copy fix**: the server-URL help text now mentions the actual `dsh-config-manager/` subdirectory instead of the stale `snapshots/`, matching the remote storage layout since v0.1.55

## [v0.1.55] - 2026-09-02

### 🎯 亮点 / Highlights (zh)

- 🔄 **WebDAV 同步存储路径变更**：远程快照目录由 `snapshots` 改为 `dsh-config-manager`。**升级注意**：如需保留坚果云（WebDAV）上之前的历史同步数据，请登录坚果云网页版，将原有的 `snapshots` 文件夹重命名为 `dsh-config-manager`，升级新版本后即可直接读取；如无需保留旧历史，新版本会自动在 `dsh-config-manager` 路径下重建索引与快照
- 🌐 **WebDAV 请求改用原生 `node:http/https`**：更可靠地支持 MKCOL/PROPFIND 等全部 WebDAV 方法，并携带准确的 `Content-Length` 与 `User-Agent`，解决部分 WebDAV 服务器对 fetch 兼容性问题导致的同步失败
- 📘 **新增「版本更新内容」弹窗**：打开插件时自动检查 GitHub Releases，检测到新版本即弹出更新说明，支持「永不提示」；也可在「关于」页手动查看全部版本记录
- 🧹 **仓库整理**：移除历史 Phase 设计文档与冗余重复文件（`dsh.bundle.patch` / `dsh.client`），源码与既有功能不变
- 🆕 **兼容 DSH Alpha 版本**：插件现可运行于 DSH 稳定版（`0.1.1`）与 Alpha 版（`0.1.2-alpha.x`）——Settings 命名空间与凭据引用 API 的转换器同时适配两种 DSH 接口，DSH 版本解析亦支持 `-rc` / `-alpha` 预发布后缀

### Highlights (en)

- 🔄 **WebDAV sync storage path changed**: the remote snapshot directory is now `dsh-config-manager` (previously `snapshots`). **Upgrade note**: to keep your existing Nutstore (WebDAV) history, sign in to the Nutstore web app and rename the old `snapshots` folder to `dsh-config-manager`; the new version reads it directly after upgrading. If you do not need the old history, the new version will rebuild the index and snapshots under `dsh-config-manager` automatically
- 🌐 **WebDAV requests now use native `node:http/https`**: full WebDAV method support (MKCOL / PROPFIND / …) with accurate `Content-Length` and `User-Agent`, fixing sync failures on servers that have fetch-compatibility issues
- 📘 **New "Release Notes" dialog**: on opening the plugin it checks GitHub Releases and shows the update notes when a new version is available, with a "Don't show again" option; all versions can still be reviewed manually on the About page
- 🧹 **Repo cleanup**: removed old phase design documents and redundant duplicate files (`dsh.bundle.patch` / `dsh.client`); source code and existing behavior are unchanged
- 🆕 **Compatible with DSH Alpha releases**: the plugin now runs on both DSH stable (`0.1.1`) and alpha (`0.1.2-alpha.x`) — the settings namespace and credential ref API converters adapt to both DSH interfaces, and DSH version parsing handles `-rc` / `-alpha` prerelease suffixes

## [v0.1.54] - 2026-08-25

### 🎯 亮点 / Highlights (zh)

- 🗂️ **导出与导入合并为单一 tab**：顶层 tab 由「导出备份 / 导入恢复」两个合并为「**导出与导入**」，内部用子 tab 切换——导航更紧凑，切 tab/刷新状态照常保留；同时「配置文件」tab 移到「关于」之前
- ✏️ **自定义文件名自动补全 `.zip`**：导出时无需手动输入 `.zip` 后缀（失焦/提交自动补全），校验只针对文件名本体；若与已有备份同名则**自动追加数字后缀**（`foo.zip` → `foo-1.zip` → `foo-2.zip`），不再覆盖之前的备份文件
- 🔍 **备份查看/对比变更明细分组 + 颜色**：冲突（红）/ 变更（蓝）/ 路径映射（黄）/ 已一致（绿）/ 其他 分组展示，组内 kindTag 同色——一眼区分「需决策 / 将写入 / 需处理 / 无需处理」；配置档案切换预览同步为同结构（差异摘要 + 分区清单 + 变更明细分组）
- 🪟 **快照恢复计划预览改为弹窗**：点击快照行 → dry-run 完成后自动弹出恢复计划（与备份文件「查看/对比」同弹窗体系），弹窗内执行恢复仍走二次确认；关闭后可随时重开
- 🖱️ **修复多处横向滚动条**：备份备注过长自动换行不再撑破行；快照列可收缩 + 单元格 ellipsis（置顶/长文件名不再撑宽）；配置档案列表列数据与表头对齐
- 📘 **关于页 CLI 卡补充 `dsh-config-manager help`** 命令（离线列出全部 CLI 用法）

### Highlights (en)

- 🗂️ **Export & Import merged into one tab**: the top-level tabs "Export" and "Import" are merged into a single **Export & Import** tab with inner sub-tabs — tighter navigation, tab/refresh state preserved as before; the Profiles tab also moves before About
- ✏️ **Custom file name auto-appends `.zip`**: no need to type `.zip` on export (auto-appended on blur/submit; validation targets the bare name); if a backup with the same name exists the export **auto-appends a numeric suffix** (`foo.zip` → `foo-1.zip` → `foo-2.zip`) instead of overwriting
- 🔍 **Backup inspect change list grouped + color-coded**: conflicts (red) / changes (blue) / path mappings (amber) / identical skipped (green) / others, with matching kindTag colors per group — see at a glance what needs a decision / will apply / needs handling / needs nothing; the profile-switch preview now mirrors the same structure (diff summary + section list + grouped changes)
- 🪟 **Snapshot restore plan preview in a dialog**: clicking a snapshot row opens the restore plan in the same dialog system as "Inspect / Compare" after dry-run; executing still goes through a second confirm; reopen anytime after closing
- 🖱️ **Various horizontal-scrollbar fixes**: long backup notes wrap instead of widening rows; snapshot columns shrink with cell ellipsis (pin/long filenames no longer widen); profile list columns align with their headers
- 📘 **About CLI card adds `dsh-config-manager help`** (offline command overview)

## [v0.1.53] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- ✨ **「我的配置」上传/更新免手动点「校验」**：选完 zip 即**自动**执行本地校验（analyzeImport dry-run，无密钥 + 内容合法才放行），通过后直接进入表单页——不再需要先点一次「校验」按钮再点「一键上传」；校验失败停留在校验步骤展示错误并可重新选择 zip（上传与更新两种模式行为一致）

### Highlights (en)

- ✨ **"My Configs" upload/update validates automatically**: after picking a zip, validation (analyzeImport dry-run; no secrets + valid content required) runs automatically and jumps straight to the form on success — no more clicking a separate "validate" button before the one-click publish; on failure it stays on the validate step showing the error with a reselect option (same behavior for both upload and update modes)

## [v0.1.52] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复 git 通道空文件分区同步失败**：当某文件类分区（skills / agentPresets / agentInstructions 等）为空时，`git` 不跟踪空目录导致上传后 `custom/skills/` 等目录在远端仓库丢失，另一台机器全新 clone 后一键同步报「快照缺少文件分区目录 custom/skills/（skills）」——现在上传方（`GitTransport.upload`）给空文件类分区目录写入 `.gitkeep` 占位文件保证远端保留目录，读回时按「文件名 + 内容」双重匹配过滤（不吞用户真实同名文件）；同时 `GitTransport.download` 对旧版插件上传的无占位快照宽容降级（目录缺失 = 空分区，git 提交原子性保证非空目录不会缺失），历史快照也能正常拉取
- 🧩 **市场校验放行空文件分区**：`validateMarketItem` 此前把「manifest 声明 skills=true 但 ZIP 无 `custom/skills/` 条目」判为 invalid（「config.zip 缺少文件分区 skills」），导致未安装 skills 的机器「一键上传」被拒——空文件分区是合法状态（导入侧 `analyzer.extractSections` 对空分区收集空 files、零操作零报错，与 sync 空分区语义一致），现改为仅追加「分区为空」warning 不拒绝；JSON 分区与禁止分区（sessions/pluginFiles/self）仍严格校验

### Highlights (en)

- 🐛 **Fix git-channel sync failure on empty file sections**: when a file section (skills / agentPresets / agentInstructions / …) is empty, git does not track empty directories, so `custom/skills/` etc. vanished from the remote repo after upload and a fresh clone on another machine failed one-click sync with "快照缺少文件分区目录 custom/skills/（skills）" — the uploader (`GitTransport.upload`) now writes a `.gitkeep` placeholder into empty file-section dirs so the remote keeps them, and reads filter it out by name + content (real same-named user files survive); `GitTransport.download` also degrades gracefully for legacy snapshots uploaded without placeholders (a missing dir means an empty section, since git commits are atomic, a non-empty dir can never be missing), so historical snapshots pull fine
- 🧩 **Market validation now accepts empty file sections**: `validateMarketItem` used to reject "manifest declares skills=true but the ZIP has no `custom/skills/` entries" as invalid ("config.zip 缺少文件分区 skills"), which blocked one-click publishing from machines without skills installed — an empty file section is a legitimate state (the importer's `analyzer.extractSections` collects empty files and does nothing, matching the sync channel's empty-section semantics), so it now only appends an "empty section" warning instead of rejecting; JSON sections and banned sections (sessions/pluginFiles/self) stay strictly validated

## [v0.1.51] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🗂️ **快照面板拆分为二级 tab + 一级 tab 更名「备份与快照」**：原先「快照恢复」面板把三类功能挤在一页（快照深度恢复 / 备份文件管理 / 定时备份设置），概念易混淆——现拆为两个清晰的二级 tab：**「快照恢复」**（导入前回滚点列表 → dry-run 计划 → 执行恢复 → 报告，功能原样保留）与**「备份文件」**（导出产物列表：下载 / 一键导入 / 删除 + 定时全量备份设置，联动「立即备份」自动刷新）；一级 tab 由「快照」更名「备份与快照」提示双功能域
- 🔄 **二级 tab 状态持久化**：`SnapshotsStoreSlice.subTab`（restore / files）镜像 runStore——切一级 tab / 刷新均保留上次选择，旧版载荷自动回退「快照恢复」；复用既有 `modeTabs` 模式，零新增样式、零 host 路由改动（纯 UI 重组）

### Highlights (en)

- 🗂️ **Snapshots panel split into sub-tabs, top-level tab renamed "Backup & Snapshots"**: the old "Snapshot Restore" panel crammed three feature areas onto one page (deep snapshot restore / backup-file management / scheduled-backup settings), which blurred their concepts — it is now two clear sub-tabs: **Snapshot Restore** (pre-import rollback points → dry-run plan → execute → report, unchanged) and **Backup Files** (export artifacts: download / one-click import / delete + scheduled full-backup settings, with the list auto-refreshing after "Back up now"); the top-level tab was renamed from "Snapshots" to "Backup & Snapshots" to signal both domains
- 🔄 **Sub-tab state persists**: `SnapshotsStoreSlice.subTab` (restore / files) is mirrored into runStore — the last selection survives tab switches and refresh, and legacy payloads fall back to "Snapshot Restore"; it reuses the existing `modeTabs` pattern with zero new styles and zero host-route changes (pure UI reorganization)

## [v0.1.50] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 📁 **快照面板新增「备份文件」管理**：此前定时备份与手动导出的 ZIP 都躺在 `exports/` 目录、GUI 无任何入口可见——现在快照恢复面板统一列出全部导出产物（文件名 + 来源徽章「定时备份 / 手动导出」+ 大小 + 时间），支持**下载**（复用 `/download`）、**一键导入**（切到导入向导直接分析该备份，跳过上传）、**删除**（二次确认弹窗）；顺带修复了「手动导出的文件也无处查看」的老缺口
- 🧹 **定时备份保留最近 10 个**：定时备份产物改用独立前缀 `dsh-config-auto-`（来源标识 + 清理依据），每次成功备份后自动清理超出 10 个的旧文件；cache-cleaner 的 exports 7 天回收**豁免 auto 前缀**——定时备份生命周期由保留策略管理，不再与「按天回收」相互截断；手动导出文件不自动删（仍按 7 天回收）
- 🛡️ **新路由全过 loopback fence**：新增 `GET /backup-files`（列表）与 `POST /backup-files/delete`（删除，服务端文件名防穿越校验），与全仓一致每个方法分支都过 guard
- 🔁 **一键导入状态为一次性瞬态**：`SnapshotsStoreSlice.importBackup`（zipPath + 文件名）随 `view` 切换传给导入向导，消费后立即清空、sessionStorage 白名单剔除、刷新不重放

### Highlights (en)

- 📁 **"Backup Files" management in the snapshot panel**: scheduled backups and manual exports used to sit in `exports/` with no GUI entry — the snapshot restore panel now lists every export artifact (file name + source badge "Scheduled / Manual" + size + time) with **download** (reuses `/download`), **one-click import** (jumps into the import wizard and analyzes that backup directly, no re-upload) and **delete** (confirmed via dialog); this also closes the old gap where manually exported files had no UI to view them
- 🧹 **Scheduled backups keep the latest 10**: scheduled artifacts now use a dedicated `dsh-config-auto-` prefix (source marker + cleanup key), pruning older files past 10 after every successful run; the cache-cleaner's 7-day exports sweep **exempts the auto prefix** so scheduled-backup lifecycle is owned by the retention policy instead of fighting the day-based sweep; manual exports are never auto-deleted (still recycled after 7 days)
- 🛡️ **New routes pass the loopback fence**: `GET /backup-files` (list) and `POST /backup-files/delete` (delete with server-side filename traversal guard) both go through `guard` on every method branch, like the rest of the codebase
- 🔁 **One-click import is a one-shot transient**: `SnapshotsStoreSlice.importBackup` (zipPath + name) is passed to the import wizard along with the view switch, cleared right after consumption, stripped from the sessionStorage whitelist, and never replayed on refresh

## [v0.1.49] - 2026-08-24

### 🎯 亮点 / Highlights (zh)

- 🛟 **快照恢复进度可视化 + 宿主侧权威防重**：`/restore` 真实执行（dryRun=false）经 RunRegistry 登记 `restore` run —— 同 kind 已有 running 时返回 409 拒绝重复恢复（前端 loading 只是 UX，宿主锁才是正确性保障；不同快照并发恢复会交错写文件、同快照并发会互相覆盖 pre-restore 双保险备份，都是真实数据风险）；每执行一个恢复动作经 `onAction` 埋点更新 `/progress`，前端 `watchRunning('restore')` 轮询 + `/runs` 刷新恢复，刷新期间恢复仍在进行则自动回到 running 并回填报告；`SnapshotsStoreSlice.running` 为瞬态镜像——白名单剔除、applyPersisted 硬性归零、以宿主 `/runs` 为权威，不把浏览器陈旧状态当成恢复执行中的依据
- 📜 **导入执行日志冻结修复（500 行封顶不再冻结）**：`RunRegistry.appendLog` 改为**不可变追加**（每次换新数组引用，行数封顶后长度恒定但引用必变），`ImportLogPanel` memo 改以「数组引用 + t 引用」比较——引用未变跳过重渲染、引用已变（含封顶后）必重渲染，杜绝「优化导致日志冻结」；新增**智能自动滚动**：仅当用户贴近底部时跟随最新行，用户上滚查看历史时不强制拉回，改在 `logHeader` 显示「↓ 新输出」胶囊按钮（`logJumpButton`，ghost 语义），点击跳回底部并恢复跟随
- 🏷️ **导入 runId 即时同步**：`watchRunning` 发现活跃 import run 时立即把 runId 写入 store（此前 `/execute` 响应在整段导入完成后才带 runId，fresh run 期间「跳过当前插件」会打到上一次导入的陈旧 runId）
- 🔒 **backup-schedule 路由补全 loopback fence**：GET/PUT `/backup-schedule` 与 POST `/backup-schedule/run` 此前漏 `guard`（loopback 守卫），本次统一补齐——远程调用方不得触发宿主写盘操作，全仓 45+ 路由均过 fence
- 🧹 附带：`BackupScheduleCard` 增加挂载守卫（切 tab 卸载后异步回调只更新 store 草稿，不再 setState）；`restore` 完成/失败回填报告或错误到 `SnapshotsStoreSlice`（切 tab 回来可见结果）

### Highlights (en)

- 🛟 **Snapshot-restore progress + host-side dedup**: real `/restore` execution is now registered in the RunRegistry as a `restore` run — a second restore of the same kind while one is running is rejected with 409 (frontend `running` is just UX; the host lock is the correctness guarantee; concurrent restores of different snapshots interleave file writes and concurrent restores of the same snapshot clobber the pre-restore double-backup). Each action emits progress via `onAction` (`/progress` polling + `/runs` refresh-resume); `SnapshotsStoreSlice.running` is a transient mirror — stripped from persistence by the whitelist, never used as the authority for whether a restore is executing
- 📜 **Import log panel no longer freezes at the 500-line cap**: `RunRegistry.appendLog` now writes immutably (a fresh array reference per append), so `ImportLogPanel`'s memo compares array references — unchanged = skip, changed (incl. post-cap) = must re-render; plus smart auto-scroll: it only follows the latest line when you're near the bottom, otherwise shows a "↓ New output" jump button instead of yanking you down
- 🏷 **Import runId synced immediately**: `watchRunning` now writes the discovered runId into the store the moment an active import run is found (previously the `/execute` response only carried it after the whole import finished, so "skip current plugin" could target a stale runId)
- 📷 **loopback fence added to backup-schedule routes**: GET/PUT `/backup-schedule` and POST `/backup-schedule/run` were missing the `guard` (loopback-only) check; now added so remote callers cannot trigger host write operations
- 🧹 **Also**: `BackupScheduleCard` got a mount guard (callbacks after unmount only update the store draft, no `setState`), and restore completion/failure now writes the report/error back into the store slice

## [v0.1.48] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时全量备份 GUI（快照 tab）**：快照恢复面板新增「定时全量备份」设置卡——总开关 + 间隔档位（6h/12h/24h/7d）+ 上次运行状态（成功/跳过/失败 + 时间或 ZIP 名）+「保存设置」「立即备份」按钮；配置仍存 sync/backup-schedule.json（随 self 分区备份/同步迁移），保存即重排调度器、立即备份复用 runOnce（同一时刻防重）；新增 GET/PUT /backup-schedule 与 POST /backup-schedule/run 三个 host 路由 + src/ui/backup-schedule.ts 纯函数层（校验 / 状态映射 / 脏判定，node 单测 6 例）；草稿镜像 runStore（切 tab / 刷新保留未保存修改）

### Highlights (en)

- ⏰ **Scheduled full backups GUI (snapshots tab)**: the snapshot restore panel now has a "Scheduled Full Backups" settings card — enable toggle + interval (6h/12h/24h/7d) + last-run status (success/skipped/failed with time or zip name) + "Save settings" / "Back up now" buttons; config stays in sync/backup-schedule.json (migrates with the self section); saving re-schedules the scheduler and "back up now" reuses runOnce with a re-entrancy guard; three new host routes (GET/PUT /backup-schedule, POST /backup-schedule/run) plus a pure-function layer src/ui/backup-schedule.ts (validation / status mapping / dirty check, 6 node tests); draft mirrored into runStore (unsaved edits survive tab switches / refresh)

## [v0.1.47] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- 🛠️ **修复模型工具注册崩溃（v0.1.46 回归）**：安装后启动 DSH 报 `cannot get property "tools" without inject` 导致插件树加载失败——5 个 Agent 模型工具（config_backup 等）改为经 `ctx.get('tools')` 结果注册，不再做 `ctx.tools` 属性访问（Cordis 属性访问要求显式 inject，而 tools 是可选服务不应进 inject）；新增模拟真实 Cordis 守卫的回归测试

### Highlights (en)

- 🛠️ **Fix model-tool registration crash (v0.1.46 regression)**: DSH failed to boot with `cannot get property "tools" without inject` — the 5 agent tools (config_backup etc.) are now registered via the `ctx.get('tools')` result instead of `ctx.tools` property access (Cordis property access requires explicit inject; tools is an optional service and must not be injected); regression test simulating the real Cordis guard added

## [v0.1.46] - 2026-08-23

### 🎯 亮点 / Highlights (zh)

- ⏰ **定时备份调度器**：设置 6 小时 / 12 小时 / 24 小时 / 7 天的固定节奏，DSH 在后台静默产出完整备份——secrets 从不包含，磁盘上无需密码也安全；README 双语宣传同步
- 🔒 **Vault 文件级脱敏**：导出（不含 secrets 模式）时把 `.credentials.yaml` 等敏感文件移入 `dataDir/vault` 并在报告标注刷新动作——备份文件里不再残留凭据明文
- 🧹 **Ghost-sweep 幽灵清扫**：检测备份中「已不存在于宿主」的幽灵条目并提示清理；宿主无归档 API 时降级为本地校验
- 🗑️ **Tombstone 删除记录**：删除动作以 tombstone 记录进同步流，导入时按记录跳过已删除项，报告标注「已按删除记录跳过 N 项」
- ☁️ **WebDAV 快照级跳过**：内容未变的快照自动跳过（`sectionsEqual` 比对），不再重复传输整包；加密快照始终上传（密文不可比对）
- 🕵️ **Secret-scanner 个人化扩展**：新增 `extraValuePatterns` 与 `createConfiguredSecretScanner`，可从插件配置注入自定义敏感值模式
- 🛒 **市场共享模式**：prepare 增加保守档拦截与 deviceSpecific 分区拒绝（机型相关配置不共享），服务端 / UI 全程透传 mode
- 🧪 **架构与 schema 兼容测试**：`architecture-boundaries` 固化分层边界（KNOWN_VIOLATIONS 例外表）；`schema-compat` 固化 manifest 兼容策略（拒绝未来版本、未知字段保留）
- 🚀 **导入体验**：进度条下方实时命令日志面板（RunRegistry 轮询、刷新不丢）；导入中可跳过当前插件（彻底清理半装状态）；结果页支持重试失败 / 跳过的子集

### Highlights (en)

- ⏰ **Scheduled full backups**: pick a fixed cadence (6h / 12h / 24h / 7d) and DSH quietly keeps a fresh full backup in the background — secrets are never included, so it stays safe on disk without a password; bilingual README updated
- 🔒 **File-level vault redaction**: exporting without secrets moves sensitive files (e.g. `.credentials.yaml`) into `dataDir/vault` and flags the refresh in the report — no plaintext credentials left in backup archives
- 🧹 **Ghost-sweep**: detects and flags backup entries that no longer exist on the host (local-validation fallback when the host exposes no archive API)
- 🗑️ **Tombstone deletions**: deletes are recorded as tombstones in the sync stream; import skips deleted items and reports "skipped N items per delete records"
- ☁️ **WebDAV snapshot-level skip**: unchanged snapshots are skipped via `sectionsEqual` — no more re-uploading whole archives; encrypted snapshots always upload (ciphertext cannot be compared)
- 🕵️ **Personalized secret scanning**: `extraValuePatterns` + `createConfiguredSecretScanner` let you inject custom sensitive-value patterns from plugin config
- 🛒 **Market share mode**: prepare adds a conservative-mode gate and rejects device-specific sections (no machine-bound config sharing); mode is threaded through server & UI
- 🧪 **Architecture & schema-compat tests**: `architecture-boundaries` locks layer boundaries (KNOWN_VIOLATIONS exception table); `schema-compat` locks manifest compatibility (future versions rejected, unknown fields preserved)
- 🚀 **Import experience**: live command-log panel under the progress bar (RunRegistry polling, survives refresh); skip the current plugin mid-import (half-installed state fully cleaned); retry failed/skipped subsets from the results page

## [v0.1.45] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **安装命令简化**：README / DEVELOPERS 的安装命令统一为 `dsh plugin --profile web add dsh-config-manager@latest`，移除 `--config.auto-install-peers=false` 后缀——照着复制即可，无需再关心 peer 解析参数
- 🛒 **README 配置市场描述上线**：两个 README（中英镜像）新增配置市场完整描述——首屏亮点 + Use Cases + 核心亮点表格 + 功能详解小节（内置官方市场 / 搜索筛选排序 / 供应链警示恒展示 + 逐分区批准 / 安装复用安全导入管道 / 「我的配置」一键上传到自有仓库 + 自动收录 PR）；功能截图新增 `assets/screenshot-market.png`
- 🎨 **市场「我的配置」上传向导打磨**：改为三步式（选文件 → 本地校验 → 精简表单，仅 name / description / categories，其余系统自动）；更新模式支持页内换新 ZIP 并自动校验；详情视图 JSX 结构调整

### Highlights (en)

- 🧹 **Simplified install command**: README / DEVELOPERS now use `dsh plugin --profile web add dsh-config-manager@latest` — the `--config.auto-install-peers=false` suffix is gone, so users can just copy-paste
- 🛒 **Marketplace docs shipped**: both READMEs (en + zh mirror) now fully describe the config marketplace — hero bullet, Use Cases, highlights table and a dedicated feature section (built-in official market / search, filter & sort / always-on supply-chain warnings + per-section approval / install reuses the safe import pipeline / "My Configs" one-click upload to your own repo with auto listing PR); new `assets/screenshot-market.png` added to the screenshots
- 🎨 **Marketplace "My Configs" upload wizard polished**: now a three-step flow (pick file → local dry-run validation → slim form with only name / description / categories, the rest auto-filled); update mode lets you swap in a new ZIP inline with auto-validation; detail view JSX restructured

## [v0.1.44] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🔍 **AI 搜索曝光优化（SEO/AEO）**：README 首屏副标题改为「DeepSeek Harness Backup, Restore & Migration Plugin」，一句话价值主张覆盖 backup / restore / export / import / migrate / sync / plugins / MCP / skills 等全部高频搜索词；新增「Use Cases」小节（Backup / Restore / Migrate / Sync 四组自然语言场景，中文版同步镜像「典型使用场景」），让 AI 搜索直接命中句子即可召回
- 🧹 **npm description 修复**：清除双重编码乱码（`â€”`）与残留内部备注，重写为关键词密集的自然描述，末尾补充中文简介；keywords 由 7 个扩至 17 个（新增 dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration）
- 📄 **新增 AI 搜索曝光审计文档**：`docs/seo/2026-08-21-ai-search-exposure-audit.md`——生态收录现状盘点（DSH Get / dshplugins.cc / DSH 插件商店 / awesome-dsh-plugins 全部收录）+ GitHub Description / Topics 建议值 + 后续优化清单

### Highlights (en)

- 🔍 **AI search exposure optimization (SEO/AEO)**: README opening now reads "DeepSeek Harness Backup, Restore & Migration Plugin" with a value proposition covering backup / restore / export / import / migrate / sync / plugins / MCP / skills and more; a new "Use Cases" section (Backup / Restore / Migrate / Sync natural-language scenarios; Chinese mirror added) lets AI search hit the exact sentences
- 🧹 **npm description fixed**: removed a double-encoded mojibake (`â€”`) and a leftover internal note; rewrote a keyword-rich, natural description with a short Chinese intro; keywords expanded from 7 to 17 (added dsh-plugin / restore / export / import / migrate / sync / webdav / mcp / skills / configuration)
- 📄 **AI search exposure audit doc added**: `docs/seo/2026-08-21-ai-search-exposure-audit.md` — ecosystem listing review (indexed by DSH Get / dshplugins.cc / DSH plugin store / awesome-dsh-plugins) + recommended GitHub Description / Topics + follow-up checklist

## [v0.1.43] - 2026-08-22

### 🎯 亮点 / Highlights (zh)

- 📐 **弹窗正文间距统一**：确认弹窗（`dialogBody`）与同步通道配置弹窗（`dialogBodyScroll`）的正文改为 flex 纵向排布 + 统一 10px 间距——message 与自定义内容、表单内的 tab/Banner/字段/操作行不再紧贴，视觉节奏与页面视图一致；纯视觉微调，无行为 / 交互 / API 变化，`DESIGN.md` 同步更新

### Highlights (en)

- 📐 **Unified dialog body spacing**: confirm dialog (`dialogBody`) and sync channel config dialog (`dialogBodyScroll`) bodies now use a flex column layout with a consistent 10px gap — messages, custom content, and form blocks (tabs/banners/fields/actions/hints) no longer collide, matching the page views' vertical rhythm; purely visual, no behavioral / API change; `DESIGN.md` updated accordingly

## [v0.1.42] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- ⭐ **市场页仓库级 Star 展示**：市场浏览列表每个条目新增「⭐ N」徽章，显示其**来源仓库**的 star 数（官方条目 = 官方市场仓库统一数字；第三方条目 = 作者自托管 `dsh-configs` 仓库），并标注「来源仓库」避免误解；「我的配置」页同步显示自己配置仓库的 star
- 🔍 **来源筛选下拉框**：市场工具栏新增「全部来源 / 官方配置 / 个人配置」筛选，selected 状态随 store 持久化（切 tab / 刷新不丢）
- 🔃 **排序下拉框**：新增「默认 / 最新更新 / ⭐ 最多 / 名称 A–Z」四种排序（升/降与 undefined 值规则确定且稳定）
- 🔒 **零凭据 star 查询**：浏览端点一律**匿名**查询 GitHub（`/repos/{owner}/{repo}`），按仓库 URL 去重 + 1 小时 TTL 内存缓存 + 单仓库失败降级显示「—」，不触碰任何 token，保持市场端点「无凭据」硬不变式
- 📜 **MIT 许可证 + Issue 模板**：仓库新增 MIT `LICENSE` 与中英双语 **Bug 报告 / 功能建议** Issue 模板；npm 包 metadata 同步补齐 `license` 字段

### Highlights (en)

- ⭐ **Repo-level stars in the market**: each market item now shows a "⭐ N" badge with its **source repo** star count (official items share the official market repo's single count; community items show the author's self-hosted `dsh-configs` repo), labeled as "source repo" to avoid confusion; "My Configs" shows your own config repo's stars too
- 🔍 **Source filter dropdown**: new market filter "All / Official / Community", persisted in the store (survives tab switches / refresh)
- 🔃 **Sort dropdown**: "Default / Recently updated / Most starred / Name A–Z" with deterministic, stable ordering (missing values sort last)
- 🔒 **Credential-free star lookup**: browsing queries GitHub **anonymously** (`/repos/{owner}/{repo}`), deduped per repo URL with a 1h in-memory TTL cache and per-repo failure fallback ("—"); no token is ever touched, keeping the market endpoints' credential-free invariant
- 📜 **MIT license + issue templates**: added the MIT `LICENSE` and bilingual **bug report / feature request** issue templates; npm metadata now carries the `license` field

## [v0.1.41] - 2026-08-21

### 🎯 亮点 / Highlights (zh)

- 🧹 **缓存自动清理**：`~/.dsh/dsh-config-manager/` 下的临时文件（`tmp/` 导入/解密/同步暂存）、导出副本（`exports/`，导出时已下载到本地）、市场缓存与 git 工作副本（`market/cache/`、`market/work/`）由插件**自动清理**——DSH 启动时清理一次、此后每 24 小时清理一次，只删除超过保留期（临时文件 24 小时、导出产物与市场缓存 7 天）的条目；导入回滚快照（`snapshots/`）与同步数据（`sync/`）属用户数据/安全网，**不自动清理**
- 🗑️ **「我的配置」删除条目**：列表新增删除入口，点删除弹**确认弹窗**（遮罩/Esc/取消三途径关闭，危险操作默认焦点落取消）——已收录条目自动提交**下架 PR**（独立分支 `dsh-market-delist/<id>`），待审核条目直接关闭收录 PR；收录/下架任务**后台执行 + 状态轮询**，进程重启后仍可一键**重试**（幂等复用已有 fork/PR）
- 📢 **市场操作免责弹窗**：上传 / 下载 / 装回本地三处操作前置免责声明，支持「不再提示」（三操作**分开记忆**，localStorage 持久化；存储不可用时静默降级为每次提示）
- 🪟 **同步设置改弹窗驱动**：远程同步页改为「同步通道」入口卡 + **通道配置弹窗**（Git/WebDAV 子 tab 与登录块移入弹窗，关闭弹窗 = 放弃本次操作含 GitHub 登录流程）；新增 **GitHub 登录态真实校验**（`/sync/github/validate`：token 有效则隐藏登录块，失效自动重新展示）
- 💾 **一键同步差异确认决策持久化**：逐项「采纳/解决」决策镜像进 store，切 tab / 刷新不丢，恢复会话可继续决策
- 🚀 **市场首次打开自动刷新**：本次 DSH 启动后首次打开市场页自动拉取一次最新条目（手动刷新成功即置位，失败可重试）
- 🔒 **秘密扫描宽松档**：市场发布扫描新增 `literalValueOnly` 档位——字段名敏感**且**值像真实字面量凭据才命中（占位符/示例形态/代码表达式/环境引用一律放行），真实密钥形状仍硬拦

### Highlights (en)

- 🧹 **Automatic cache cleanup**: transient files under `~/.dsh/dsh-config-manager/` (`tmp/` import/decrypt/sync staging), export copies (`exports/` — already downloaded to your machine on export), and marketplace cache/git worktrees (`market/cache/`, `market/work/`) are now **cleaned automatically** — once at DSH startup and then every 24 hours, removing only entries older than their retention (24 h for tmp, 7 days for exports and market cache); import rollback snapshots (`snapshots/`) and sync data (`sync/`) are user data / safety nets and are **never auto-removed**
- 🗑️ **"My Configs" item deletion**: each listed item gains a delete action guarded by a **confirm dialog** (mask / Esc / Cancel close paths; focus lands on Cancel for destructive ops) — listed items automatically open a **de-listing PR** (dedicated branch `dsh-market-delist/<id>`), pending-review items just close the listing PR; listing/de-listing jobs run **in background with status polling**, and a failed/lost job can be **retried in one click** (idempotent, reuses the existing fork/PR)
- 📢 **Market operation disclaimers**: upload / download / install-back-local now show a disclaimer first, with a per-operation **"don't ask again"** toggle (remembered independently in localStorage; silently degrades to always-ask when storage is unavailable)
- 🪟 **Sync settings moved to a dialog**: the sync page is now an entry card that opens a **channel-config dialog** (Git/WebDAV tabs and the GitHub login block live inside; closing the dialog abandons the operation, including an in-flight GitHub login); new **real GitHub sign-in validation** (`/sync/github/validate`: valid token hides the login block, an invalid one re-shows it)
- 💾 **One-click-sync confirm decisions persisted**: per-item adopt/resolve choices are mirrored into the store, surviving tab switches / refresh so a session can be resumed
- 🚀 **Market auto-refresh on first open**: the market page auto-fetches once per DSH startup (a successful manual refresh also arms it; failures can be retried)
- 🔒 **Lenient secret-scan tier**: market publishing gains a `literalValueOnly` mode — a sensitive field name only hits when the value looks like a real literal credential (placeholders / example shapes / code expressions / env references always pass); real key shapes are still hard-blocked

## [v0.1.40] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧭 **「我的配置」体验修复**：移除标题上方的「返回市场」按钮（子视图切换已在顶部，无需重复返回）；update 更新改为**显式按条目 id 定位**（不再靠名称转 id 猜测，中文名/改名场景不再误建新条目，目标条目不存在时明确报错）；秘密扫描**消除技能文档误报**（`token:`/`password:` 等代码示例、类型声明、占位符、环境引用不再误判，真实密钥 sk-/ghp_/JWT/PEM/Bearer 仍强制拦截）

### Highlights (en)

- 🧭 **"My Configs" UX fixes**: removed the "back to market" button above the title (the sub-view tabs already switch back); update now targets the item by its **explicit id** (no more name→slug guessing — Chinese names / renames no longer create a duplicate item, and a missing target id errors clearly); secret scan **no longer false-positives on skill docs** (code samples like `token:`/`password:`, type declarations, placeholders, env references are allowed; real key shapes sk-/ghp_/JWT/PEM/Bearer are still hard-blocked)

## [v0.1.39] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🧹 **上传入口收敛**：移除「配置市场」浏览视图中的旧「发布到市场」向导（PublishView）及其入口按钮，上传配置统一收敛到「我的配置」子视图（一键上传 → 自动建仓 → 自动收录 PR）；fork 创建轮询超时 60s → 180s（GitHub 首次 fork 复制仓库内容可能超过 1 分钟）

### Highlights (en)

- 🧹 **Upload entry consolidated**: the legacy "Publish to Market" wizard (PublishView) and its entry button are removed from the browse view; uploading configs now lives solely in the "My Configs" sub-view (one-click upload → auto repo → auto listing PR); fork creation polling timeout raised 60s → 180s (GitHub's first fork copies the whole repo and can take over a minute)

## [v0.1.38] - 2026-08-20

### 🎯 亮点 / Highlights (zh)

- 🚀 **「一键上传 / 我的配置」**：配置市场新增「我的配置」子视图——GitHub device flow 登录（token 只存本机凭据槽）后，选择配置 zip → 本地 8 道校验 + 秘密扫描 → 一键上传到**你自己的公开仓库**（自动创建 `<login>/dsh-configs`）→ 自动 fork 官方市场仓库、改 `index.json` 收录**自托管引用**并提交自动 PR（固定分支 `dsh-market-sync/<itemId>`：未合并自动更新、已合并基于最新 main 重开）；支持查看已上传（收录状态徽章：未收录 / PR 待审核 / 已收录）、一键更新（元数据全自动：id / author / version / updatedAt / sha256 系统生成，版本纯自动 +1）、装回本地（复用市场下载 + 逐分区批准 + 回滚管道）。目标收录仓库固定 `xiajiajun516/dsh-config-market`，界面不可修改

### Highlights (en)

- 🚀 **One-click upload / "My configs"**: the Market panel gains a "My Configs" sub-view — after GitHub sign-in (device flow; token stays in the local credential slot), pick a config ZIP → local 8-step validation + secret scan → upload in one click to **your own public repo** (auto-created as `<login>/dsh-configs`) → auto-fork the official market repo, add a **self-hosted reference** to `index.json`, and open the listing PR automatically (fixed branch `dsh-market-sync/<itemId>`: auto-updated while unmerged, reopened from latest main after merge); view uploads with listing-status badges (not listed / PR pending / listed), update in one click (all metadata auto-generated — id / author / version / updatedAt / sha256; version bumps automatically), and install back locally (reusing the market download + per-section approval + rollback pipeline). The listing target repo is fixed to `xiajiajun516/dsh-config-market` and not editable in the UI

## [v0.1.37] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复异步操作切 tab 丢失状态**：远程同步的推送/拉取/一键同步、市场下载与确认导入、快照恢复等异步操作，在请求进行中切换 tab 再切回时不再丢状态——结果（推送/拉取报告、差异确认会话、导入结果、恢复计划与报告）在组件卸载期间完成也能落库，切回即恢复；进行中的 busy spinner 也随模块级 store 保留（刷新后清空，凭据仍仅内存白名单剔除）

### Highlights (en)

- 🐛 **Fix state loss for async operations on tab switch**: pushing/pulling/one-click sync, market download & confirmed import, and snapshot restore no longer lose their result when you switch tabs mid-request — results (push/pull reports, diff-confirm session, import outcome, restore plan & report) are persisted into the store even when the request settles after the view unmounted, and restore on return; in-flight busy spinners survive tab switches too (cleared on refresh; credentials stay memory-only behind the whitelist)

## [v0.1.36] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🐛 **修复同步快照二进制损坏（文件分区丢字节）**：文件类分区（技能/插件文件等）在内存为 Uint8Array，整份快照走 JSON 的通道（WebDAV 单文件快照、加密载荷）会把字节序列化成数字索引对象，拉取/解密后 `Buffer.from(对象)` 直接抛错；新增二进制安全序列化（文件字节 ↔ `{ $bin: base64 }`）——三个通道全部接入，往返字节无损
- 🔐 **Git 加密快照改「密文单文件」布局**：加密快照（密文载荷无法平铺为明文 JSON 分区）改走 `snapshots-encrypted/<id>.json` 整体 JSON 提交，与明文散文件目录并存——远端只存密文、本地不产生额外明文审计副本
- 🛡️ **市场条目禁止分区**：sessions（历史会话）/ pluginFiles（任意文件直通）/ self（本地环境）永久禁止进入市场条目——安全校验与条目生成两端强制拒绝（产品决策，详见市场仓库搭建规格书）
- 🏷️ **同步历史标记触发通道**：快照 manifest 与自动同步历史记录各自 transport（git/webdav），快照/历史列表显示通道徽章——多通道同步一次看清哪个通道做了什么
- 📖 **官方市场仓库搭建规格书**：新增 docs/design/2026-08-19-market-repo-setup-guide.md——索引格式、8 道安全校验、条目结构整份规格，可直接复制发给搭建 AI

### Highlights (en)

- 🐛 **Fix binary corruption in synced snapshots (file-section bytes)**: file-based sections (skills/plugin files…) hold `Uint8Array` in memory; any channel that JSON-serializes the whole snapshot (WebDAV single-file snapshots, encrypted payloads) mangled the bytes into numeric-index objects, making `Buffer.from(obj)` throw on pull/decrypt. A binary-safe serializer (bytes ↔ `{ $bin: base64 }`) is now wired into all three channels — lossless round-trips
- 🔐 **Git encrypted snapshots move to a ciphertext-single-file layout**: encrypted snapshots (ciphertext cannot be flattened into plaintext JSON sections) are now committed as a whole `snapshots-encrypted/<id>.json`, coexisting with the plaintext scatter-dir layout — remote keeps only ciphertext, no extra plaintext audit copy locally
- 🛡️ **Banned market sections**: `sessions` (chat history) / `pluginFiles` (arbitrary passthrough files) / `self` (local environment) are permanently forbidden in market items — enforced at both validation and item-generation (product decision, see the market repo setup spec)
- 🏷️ **Sync history records the triggering channel**: each snapshot manifest and autosync history entry now carries its `transport` (git/webdav), shown as a channel badge in the snapshot/history lists — multi-channel sync is now readable at a glance
- 📖 **Official market repo setup spec**: new docs/design/2026-08-19-market-repo-setup-guide.md — index format, 8-step security validation, item structure as a single spec, copy-paste ready for a setup AI

## [v0.1.35] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🛒 **配置市场发布向导（去中心化方案 B）**：配置市场新增「发布到市场」五步向导——选择配置 zip → 本地 dry-run 校验（内容合法且不含密钥）→ 生成条目包（L2 manifest + SHA-256 + sections）→ 推送作者仓库（生成 git 命令模板，插件不做任何 git 写操作、不持有凭据）→ 提交收录申请（index.json 片段 + PR 指引）；官方 index 只收录引用、保持只读零凭据，条目由作者自托管公开 git 仓库
- 🧩 **self 分区：插件自身配置纳入备份/迁移**：新增 self 适配器——导出/同步自动收集 `$DSH_HOME/dsh-config-manager/` 下的 sync-config / sync-autosync / sync-selection / ui-prefs / market-config 白名单配置（不含凭据值），换机器一键恢复
- 🔀 **同步通道独立子 tab**：远程同步面板 Git / WebDAV 改为子 tab 各自持有独立配置——自动同步（启用/间隔/状态）、同步模式与分区勾选、是否加密、远端快照列表均按通道独立（autosync / sync-selection schema v2 按通道命名空间 + v1 自动迁移）
- 💾 **UI 偏好落盘**：上次选择的同步通道从浏览器 localStorage 迁入磁盘 ui-prefs.json——换浏览器/换机器不丢，Host 可读写（浏览器关闭时自动同步也能读到）

- 🐛 **加密备份导入只输一次密码**：导入整体加密备份（DCA1 容器）时不再需要第二个「解密备份」页面——选完 ZIP 输入一次解锁密码即可，Host 解锁时顺带解出内部凭据覆盖清单（refs），该密码同时作为解密密码完成凭据恢复（导出时两者同源）
- 🐛 **修复切 tab / 刷新丢失面板状态**：快照恢复、远程同步、配置市场三个低频面板的非敏感 UI 状态（选中快照 / dry-run 计划 / 执行报告、通道表单 / 同步模式与分区勾选 / 一键同步差异确认会话、搜索词 / 类别筛选 / 条目详情与逐分区批准）现经模块级 runStore + sessionStorage 白名单持久化——切 tab 不丢、刷新后回到原 tab 并恢复现场；同步凭据（token / webdav 密码 / 加密与解密密码）仍仅内存，刷新后清空要求重输

### Highlights (en)

- 🛒 **Marketplace publish wizard (decentralized)**: a five-step "Publish to Marketplace" wizard — pick a config ZIP → local dry-run validation (valid content, no secrets) → generate the item package (L2 manifest + SHA-256 + sections) → push to your own repo (git command template generated; the plugin never performs git writes or holds credentials) → submit an index entry (index.json snippet + PR guidance); the official index stays read-only with zero credentials and only references author self-hosted public repos
- 🧩 **`self` section: the plugin's own config joins backup/migration**: a new `self` adapter collects the plugin's own config files under `$DSH_HOME/dsh-config-manager/` (sync-config / sync-autosync / sync-selection / ui-prefs / market-config whitelist, credential-free) for export & sync — restore everything on a new machine in one shot
- 🔀 **Per-channel sync sub-tabs**: the Sync panel now has Git / WebDAV sub-tabs, each owning independent settings — autosync (enabled / interval / status), sync mode & section selection, encryption toggle, and remote snapshot list are all per-channel (autosync / sync-selection schema v2 with namespaced channels + v1 auto-migration)
- 💾 **UI prefs on disk**: the last-selected sync channel moved from browser localStorage to `sync/ui-prefs.json` — survives browser/device changes and is readable by the Host process (autosync keeps working while the browser is closed)
- 🐛 **Encrypted backup import now asks for the password once**: the separate "decrypt backup" step is gone for fully-encrypted (DCA1) archives — enter the unlock password right after picking the ZIP; the Host returns the covered credential refs with the unlock response and reuses the same password (both layers derive from it at export time) to restore credentials
- 🐛 **Fix state loss on tab switch / page refresh**: non-sensitive UI state of the Snapshots / Sync / Market panels (selected snapshot + dry-run plan + restore report; channel form + sync mode & section selection + one-click sync confirm session; search / category filter / item detail + per-section approvals) is now mirrored into the module-level runStore and persisted via the sessionStorage whitelist — surviving tab switches and restoring after refresh, with the current panel re-opened; sync credentials (token / WebDAV password / encrypt & decrypt passwords) stay memory-only and are cleared after refresh

## [v0.1.34] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🆕 **关于（About）面板**：设置页新增第六个 tab——展示插件元数据（名称/仓库/作者）、当前插件版本与 DSH 版本/平台，并提供 Star / 文档 / Issues 快捷链接；链接恒等派生自仓库 URL，杜绝拼接错误
- ⬇️ **导出下载静默化**：导出 ZIP 完成后默认以 Blob + `<a download>` 静默下载到浏览器「下载」目录（无需另存为对话框）；需要选择保存位置时可走系统保存对话框（saveDialog 模式）
- 🔀 **同步配置 schema v3**：git 与 WebDAV 双命名空间共存——切换通道不再丢失另一通道的 repoUrl/url 配置，status 路由可回填另一通道配置
- 🐛 **修复加密备份解锁后 zipPath 丢失**：导入解锁加密备份时保留已记录的容器路径，避免 store 中已 patch 的 zipPath 被覆盖回 null
- ⚙️ **发布流程改进**：GitHub Release 亮点改为从 CHANGELOG.md 自动抽取（未写当前版本段则 fail fast），发版不再需要手动维护亮点列表

### Highlights (en)

- 🆕 **About panel**: new sixth tab in the settings page showing plugin metadata (name / repo / author), plugin version, DSH version and platform, with Star / Docs / Issues quick links derived from the repo URL (single source, no concatenation bugs)
- ⬇️ **Silent export download**: exported ZIPs now download straight to the browser's download directory via Blob + `<a download>` (no save dialog); opt into the system save dialog with saveDialog mode when a location choice is needed
- 🔀 **Sync config schema v3**: git and WebDAV namespaces now coexist — switching channels no longer drops the other channel's repoUrl/url, and the status route can backfill the inactive channel config
- 🐛 **Fix zipPath loss after unlocking encrypted backups**: the import wizard keeps the recorded container path when unlocking an encrypted archive, so the patched zipPath in the store is no longer overwritten to null
- ⚙️ **Release workflow improvement**: GitHub Release highlights are now auto-extracted from CHANGELOG.md (fail fast when the current version section is missing), no more hand-maintained highlight lists

## [v0.1.33] - 2026-08-19

### 🎯 亮点 / Highlights (zh)

- 🔐 **加密快照同步**：手动推送时可将整个同步快照的 sections 载荷用 AES-256-GCM **整体加密**后上传远端（`manifest.encrypted=true`），拉取/一键同步时输入密码解密——密码仅内存使用，绝不落盘/落日志
- 🛡️ **凭据随同步通道携带（可选）**：手动推送可导出真实凭据值（`includeSecrets`），但**强制要求同时加密**（安全不变量：密钥绝不明文进入同步通道）；自动同步恒不携带凭据
- 🚫 **自动同步智能跳过加密快照**：远端最新快照为加密 → 自动同步无密码无法解密，记录 `skipReason='encrypted'` 整体跳过（不误判失败），提示走手动输入密码同步
- ⚙️ **同步配置保存路由（sync/config）**：UI 表单自动保存 /「保存配置」按钮落盘同步通道配置，凭据走 DSH credentials 槽位；WebDAV `username` 留空时从持久化配置自动回填（挂载/刷新后不再因空用户名失败）
- ⏱️ **WebDAV 通道独立超时**：单请求放宽至 120s（适配坚果云等慢速 WebDAV 上传大快照/读写索引），错误消息携带实际毫秒数便于判断
- 🐛 **修复导入「解锁加密备份」阶段渲染让位**：decrypt-archive 阶段发生时不再停留在文件选择页，正确显示密码输入界面（import-decrypt-archive-render 回归）

### Highlights (en)

- 🔐 **Encrypted snapshot sync**: on manual push, the whole sync snapshot payload can be **encrypted with AES-256-GCM** before upload (`manifest.encrypted=true`); a password is asked on pull / one-click sync to decrypt — kept in memory only, never persisted or logged
- 🛡️ **Credentials may travel with the sync channel (opt-in)**: manual push can export real credential values (`includeSecrets`) but **requires encryption at the same time** (security invariant: secrets never enter the sync channel in plaintext); auto-sync never carries credentials
- 🚫 **Auto-sync skips encrypted snapshots**: when the remote latest snapshot is encrypted and no password is available, the sync records `skipReason='encrypted'` and skips the whole run (not a failure), prompting manual password-based sync
- ⚙️ **Sync config save route (`sync/config`)**: the UI autosaves / the "Save config" button persists channel config; credentials go to DSH credential slots; empty WebDAV `username` is backfilled from persisted config after mount/refresh
- ⏱️ **WebDAV channel timeout**: per-request timeout widened to 120s (for slow WebDAV like Jianguoyun uploading large snapshots / index I/O); error messages carry the actual milliseconds
- 🐛 **Fix import "unlock encrypted backup" step rendering**: the decrypt-archive stage now correctly shows the password input instead of staying on the file-selection page (import-decrypt-archive-render regression)