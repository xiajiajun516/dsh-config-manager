# 会话修复与诊断口径 — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## v0 打包行（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）不得被当成 seq 空洞

- **v0 打包行（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）不得被当成 seq 空洞**（真机 **407/1194** 份被误判为「需要损失性修复」，按该计划会丢 **865,098/876,680 行 = 98.7%**）：打包行**没有 `seq` 成员**，一行按 `seq0` + payload 展开成 N 个事件（官方 `decodePackedRun`：`firstSeq = seq0`、`eventCount = payload.length`）；**连续性判定必须先展开打包跨度**。判据分两层、不得混同：(i) **形状不可判定**（缺 `seq0` / 载荷非数组 / 长度非安全整数 / `dt` 长度 ≠ len-1 / 带严格键集外成员 / 无 `seq0` 的未知非 packed 类型）→ **不透明跨度**，禁止跨越它下连续性/截断结论，计划 **refuse**（不得截断）；(ii) **形状可判定但 `seq0` 与运行计数不衔接** → 这是**真实 seq 空洞**，与标量行空洞**同待遇**（默认 refuse；显式 `allowLossy` 才在首个异常处截断）—— 别把它当 opaque，否则同一种语义会因前一行的物理编码不同而有两种待遇。**帧粒度**：`≤200 行/帧` 只约束**本次重编码**的帧，**未触及帧（帧内无被丢行且全部保留）必须逐字节复用**，即使它原本超过 200 行 —— 真机有 **226 个事件帧 >200 行、最大 8654 行**，那是 DSH 自己写出的形态，**字节保真优先于自定上限**。证据与复核脚本（`.tmp/probe-session-repair.mjs`）见 `docs/known-pitfalls.md` 同序条目。

## 会话检测口径：严重级按「代际 + 载体」分级，且前台读盘管线是分层的

- **会话检测口径：严重级按「代际 + 载体」分级，且前台读盘管线是分层的**（known-gaps **G-24**）：v4 与 pre-v4 下 —— `user/message.data.id` 缺失、`assistant/message.message.id` 缺失、`tool/result.message.id` 缺失或 `toolCallId` 与 `source.callId` 不一致、空 tool-call id、重复通告同一 advertised tool call —— 都会被**前台读盘管线拒读**（`unloadable`）；**版本读不出时一律降为 `nextRequestFails` 并标注 `codec-uncalibrated`**。**口径层次必须写准**：官方前台管线 = ① `parseHeaderRecord` 的 `createRestore(recovery:'strict', validation:'transformed')`（既解首帧 header，**也被 `readZstdPrefix` / `SessionLogScanner` 用来逐行 `decodeRow`**）② `assertV4RowAdmission` / `assertReleasedV4Relationships` ③ `adoptSessionEvent`（如 `assertMessageEventShape`）④ `Session.fromRestore` + `assertCurrentAssistantStreams`；**只有 ① 的 `decodeRow`/`finish` 那一层**会对「user/assistant 缺 id」「空 tool-call id」放行 —— **不要写成「transformed 容忍」**，那会低估前台确实会拒。三条官方错误文本与出处：`seed user|assistant/message at index N lacks an identified message`（`dsh-session` 的 `assertMessageEventShape`）/ `tool call id requires a nonempty string`（`dsh-session-format-v3-to-v4`）/ `assistant/message repeats advertised tool call`（同包 v4 关系校验器与迁移器）。**不得写成「缺 id 一律整份拒载」，也不得写成「v4 的 user/assistant 缺 id 只是下次请求会失败」。**

## 复核门 `unavailable` ≠ 成功验证

- **复核门 `unavailable` ≠ 成功验证**：**操作完成（`ok`）与可加载验证（`verify`）是两件事**。`unavailable` 时结果与台账必须带 `verify.verified=false`、**不得标记为已验证**；`unavailable` **仍写台账**（否则已应用的修复无法回滚）但**不写成功台账、不触发回滚**；**UI（React 面板）、CLI 与离线救急台两侧**都必须把三态（现役可读 / 迁移链可还原 / 未验证）写进**用户可见输出**，不得把「写完了」说成「已可加载」。

## 复验门的 catalog 解析不得只按 root 缓存，等价性用 `equivalentToReadPath` 判定

- **复验门的 catalog 解析不得只按 root 缓存，等价性用 `equivalentToReadPath` 判定**（known-gaps **G-24**）：`createRestore(strict+transformed)` 只在 `header.version === 当前代际`（本机 v4）时可达；pre-v4 走**迁移链**，**不等价于 DSH 读盘路径**（官方 `resolveCurrentLog`：pre-v4 没有「当前日志」）。任何依赖日志 header 的判定（代际闸门 / API 闸门 / `equivalentToReadPath`）**都必须按该日志的 `headerVersion` 重跑**，否则同进程内同一输入会给出不同结论（实测过等价性翻转 + v4 被误判 `decode-failed` 并回滚）。

## 外部来源合成的会话行必须满足 DSH 的 `assertMessageEventShape`

- **外部来源合成的会话行必须满足 DSH 的 `assertMessageEventShape`**（`dsh-session/lib/index.js` 的 `adoptSessionEvent`；真机 2026-10-07 事故：导入 Hermes 后 `历史加载失败：… session event at seq 5 message must have model source`）。四条硬形状，改 `src/foreign/session-ir.ts` 的 `synthesizeDshRows` 时**不得回退**：① `assistant/message` 的 `message.source` 必须是 `{kind:'model', provider, model}` 且 **provider/model 都非空**（写 `kind:'assistant'` 直接拒读）；② 该行的 `data.stream` 必须是**数组**（真实日志必有；正文走 `message.content`，所以 `[]` 安全，但**不能省**）；③ assistant 的 `message.content` **必须含 `tool-call` 块**（`id` 与 `tool/call` 事件 callId 同源；`deriveEventMessage` 对空 content 返回 null，只有工具调用的助手消息会整条消失）；④ `tool/result` 的块是 **`{type:'tool-result', toolCallId, isError, content:[…]}`**（连字符 + camelCase），`source.callId` 必须**非空**且与块内 `toolCallId` 逐字相同 —— Anthropic 那套 `tool_result`/`tool_use_id`/`is_error` 会被直接拒读；源侧结果缺 id 时按「最早未决调用」FIFO 回填，无主结果计数丢弃（**绝不产出空 callId**）。护栏：`src/foreign/session-ir.test.ts`（钉形状）+ `claude-sessions-bytes.test.ts`（字节基线，改形状必须写明理由）；复核 = 用 DSH 自己的 `adoptSessionEvent` 逐行跑真机产物（当前 hermes 71 会话 / 29687 行 → 0 拒绝，见 known-pitfalls 同序条目）。

## 外部来源合成的会话要按目标机的版本写，且 `session/title` 必须满足 `assertTitleSources`

- **外部来源合成的会话要按目标机的版本写，且 `session/title` 必须满足 `assertTitleSources`**（2026-10-08 真机事故：桌面端 0.2.0-rc.2 = **v4**、转码器只认 v3 ⇒ 每条会话 `session-format-unsupported`、包里没有 `sessions` 分区，用户看到「历史对话不见了」）。四条不得回退：① `SUPPORTED_DSH_SESSION_FORMAT_VERSIONS = [3, 4]`，`header.version` 与日志名**按目标机版本**写（反向不可读，**绝不一律写最高版本**；版本读不到仍旧一条都不转）；② 标题行**不能停在 seq 0**：非 user 来源（调用方都给 `{kind:'fallback'}`）的 `messageSeqs` 必须非空、每个 seq **早于**本条、且指向 `source.kind === 'user'` 的 `user/message`（空 ⟺ user 来源）—— 所以标题行插在**首条人类消息之后**并引用它；旧写法（seq 0 + `[]`）会被 **v3→v4 迁移整份拒收**；③ 整场没有人类消息时**不产标题行**（如实 `session-empty`），绝不编指不到人的引用；④ 改形状后必须用**两代真 codec**复跑 `verifySessionLogBytes`（v3 档 = 本机 CLI 档案树、v4 档 = `app.asar` 内 catalog）并要 `verified/strong/equivalentToReadPath` 全 true。见 known-pitfalls 同序条目。

## 面板侧的「布局归位 / 重复 id 隔离」是运行时写路径，安全口径与离线 CLI 不同

- **面板侧的「布局归位 / 重复 id 隔离」是运行时写路径，安全口径与离线 CLI 不同**（M2 的 E 链路，checkpoint `1dc28d8` 宿主 + `807528b` 面板）：入口 = `POST /recovery/sessions/layout`（`/recovery` 前缀端点下的子路由），服务 = `src/utils/session-layout-repair-service.ts`（**禁止 import `src/cli/**`**），规划复用 core 的 `planSessionRepair`。四条不得回退：① `apply!==true` 只读计划、**零写入**；② 逐条门前置 = 无 `session.lock` + 不在 `SESSION_REPAIR_QUIESCENT_MS`（30 s）静止期内；③ **每次移动后必须 `reindexSessionHeader` 成功，失败必须把该条搬回原位并如实报 `rolledBack`**；④ 宿主没提供刷新端口就**一条也不执行**（`reindex-unavailable`）。面板相对 CLI 的**有意差异**（必须写进文案，不能当成实现漂移）：面板在 **DSH 运行时**执行（CLI 要求先停 DSH）、不暴露路径映射 ⇒ `rewrite` 恒缺席、**只搬目录不改写首帧**；另加两道 CLI 没有的护栏 —— 重复 id 未点名 keep **拒绝执行**（CLI 只是跳过）、keep 必须指向**已扫描副本**（否则 `keep-not-a-candidate`；CLI 把 `--keep` 指错路径会隔离**所有**副本）。隔离目录与 CLI 同名同形 `.cm-repair-quarantine-<stamp>/<fromProjectKey>/<sessionId>`，响应与文案**零绝对路径**。护栏：`tests/route/session-layout-routes.test.ts` + 服务单测 + 独立探针（`.tmp/m2/e3/probe.mjs`，21 断言）。

## 「两侧诚实」是硬要求：UI 文案的每一句都要能被代码逐条证明

- **「两侧诚实」是硬要求：UI 文案的每一句都要能被代码逐条证明**（M2 的 A/C 链路）：① 面板说明与救急台页面文案里的每个能力主张都必须有对应代码事实（严重级档位 ↔ `sessions.severity.*`、应用内可修类别 ↔ `SESSION_REPAIRABLE_ISSUE_CODES`、离线命令 ↔ `src/cli/sessions-repair.ts` 的 `action.kind` 只覆盖 `duplicate-id` / `location-mismatch`）；**含糊的「本页不提供」禁止**（要么指向真实页内入口、要么点名页面）。② **断言宽于覆盖同样是缺陷**：用例名写「各页正文无字面 `**`」却只渲染 7 页，真机就漏掉了导出页的 `**`（现在按 `page.ts` 导出的全部 **12 个** `render*Page` 做集合相等 + 每页**非空证明**）。③ 渲染文本里的 `**`：**`esc()` 上下文去标记**（写 `<strong>` 会被转义、写 `**` 会显示星号）、非 esc 上下文才用 `<strong>`。④ **「未知」与「确知为空」必须分开**：`?? new Set()` 把未知伪造成「确知为空集」⇒ 真机 801 条里 **798 条**被误报 `subagent-without-parent`（现在 `knownSessionIds` 缺省 = 不判、显式空集才判；复算误报 **0**，显式空集仍判 801 —— 证明不是靠放宽判据换来的）；⑤ **条件渲染的功能入口必须在「扫过之后」始终可见**：入口只在「有候选行」时渲染 ⇒ 本机没有这一档的用户**根本找不到它**（真机 1218 个会话单元全 `already-placed`，用户就是因此报「没看到入口」）；空态必须自己说明白（zh/en 双键齐），**可见性判定放 `src/ui` 并加单测**（`sessionLayoutSectionState`），别让「没有候选」变成「没有功能」；⑥ **用户可见的修复必须与代码同轮进 CHANGELOG**（按 `changelog-writing` skill 落位 + §4 自检）：实测漏过 —— M2 的四个 UI 修复（入口可见性、卡片布局、字面 `**`、回滚措辞）只提交了代码与守卫，条目是用户问起才补的；「代码+守卫已提交」不等于「这轮交付已收口」。

## 真 codec 复验门的锚点链与 asar 抽取（known-gaps G-24 ⑤）

- **真 codec 复验门的锚点链与 asar 抽取（known-gaps G-24 ⑤）**：官方 catalog 只在 DSH 安装树里（桌面端在 \`app.asar\` 内），所以「能不能验」取决于**锚点**，而锚点必须由外部**显式**给出 —— 四条候选按真伪顺序：install-anchor（宿主 \`profileContext.installAnchor\`）→ env-anchor（\`DSH_CM_DSH_INSTALL\` = **安装根**，即含 \`resources/app.asar\` 的那一层，**不是 asar 本身**）→ runtime-anchor（拉起本进程的 runtime，即 \`process.resourcesPath\`）→ profiles 树。三条不得回退：① **版本解析与 catalog 候选规划必须共用同一条锚点链**，否则两者从不同锚点互相自证；② asar 抽取出的树是**临时物**（缓存根可选注入），绝不动安装树；③ 拿不到锚点时如实 \`unavailable\`（**不是失败、也不是已验证**）；裸 node 进程（无任何锚）对同一份真机 v4 日志就是 \`unavailable(children-required)\` —— 这不是 codec 缺陷。实测（2026-10-07）：设 \`process.resourcesPath=D:/Apps/DSH/resources\` 后真机 v4 **10/10 → {verified:true, strong:true, equivalentToReadPath:true, via:'asar-extract'}**（含 6,022,151 B / events=3683 的大日志，零绝对路径泄漏）；同一份日志清掉唯一锚点即 \`unavailable\`。**覆盖边界如实写**：\`equivalentToReadPath\` 仅在 \`header.version === 当前代际\` 时为真（本机 v4），pre-v4 走迁移链 ⇒ 可 \`verified\` 但**不等价于 DSH 读盘路径**；本机最新代际分布 v0/v3 占多数，故这门是**低覆盖护栏**而非全库体检。
