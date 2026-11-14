# dsh-Go 原生插件（配置管家）— 侦察结论与取舍

> 载体：`integrations/dsh-go/config-manager/`（包名 `local-dsh-config-manager-go`）。
> 基线：dsh-Go **v1.0.16**（2026-11-13，tag `v1.0.16` = `ddaff42`）。协议 v1（清单 `v:1`），视图 v2 组件在 1.0.16 已可用。
> 所有行号对 .tmp/dsh-go 的 v1.0.16 或本仓库当前提交负责；协议侧引用在 `docs/plugins/*.md` 与 `runtime/bridge/dsh-go-bridge/lib/native/limits.js`。

## 阶段 0：六个问题

### Q1 「点设置被推去网页版」由哪个分支产生

入口不是插件能改的，它是 App 侧 seat 规划的默认兜底：

- 设置页「插件」组的行来自 `pluginSettingsSlots = [Slots.settingsSection, Slots.generalItem]`（`app/lib/ui/plugins/seats/plugin_settings_tiles.dart:22,37-40`）。
- 行是原生还是网页，由 seat plan 决定：只有 `item.mode == SeatMode.native` 走原生分支（`plugin_settings_tiles.dart:64`），否则 `seatRowEntry(...)`（`:82`）→ `web = entry.web` → 行尾值显示 `l10n.commonWeb`（`commonWeb` = 「网页版」，`app/lib/l10n/parts/common_zh.arb:51`）（`plugin_settings_tiles.dart:88-95`）。
- `seatRowEntry` 在没有 native/island 页面时直接 `return SeatRowEntry(web: true, open: ctx => seatWebOpener(target))`（`app/lib/ui/plugins/seats/seat_links.dart:139-158`）⇒ 点行跳 DSH Web。空态按钮同样是 `commonOpenInWeb`（`seat_links.dart:158-182`）。
- 原生面板只映射到三个槽位：`Slots.rightPaneTab => DshGoPanel.sessionTab`、`Slots.main => DshGoPanel.features`、`Slots.dshGoPanel => ''`，其余（含 `settingsSection`/`bundleConfig`/`rowConfig`）一律 null（`app/lib/plugins/seams/seat_inventory.dart:152-166`）⇒ **设置页那一行永远没有 native occupant**。
- `Slots.dshGoPanel = 'dsh-go.panel'`（`app/lib/plugins/seams/slot_catalog.dart:190,205`）全仓没有 UI 消费者（只出现在 `seat_inventory.dart:157` 与 `dsh_ui_panel_adapter.dart:25`）⇒ 死槽位，靠它把设置行变原生也不成立。
- 规划器只用「有 adapter 的 slot」生成 native 项（`app/lib/ui/plugins/seats/seat_planner.dart:179-183`），native 项没有 web 侧（`:197-200`）。

**结论**：不改 dsh-Go 源码时，插件清单怎么配都无法让设置页那一行变原生。可达的原生落点只有 `features`（全部功能）、`session.tab`（对话详情·插件页签）、`chat.panel`（聊天页弹层）、`plugin`（插件详情页）。因此本插件的原生入口是
**设置 → 全部功能 → 配置管家**（一步之差），其余入口放在加号工具、对话操作与输入框状态条。
这条缺口按「给 issue 标题 + 复现要点、不擅改 dsh-Go」处理，见文末。

### Q2 原生视图是否支持文本输入？密文备份密码怎么办

支持文本输入，但**没有密码类型**：

- v2 输入组件（1.0.16 已有）：textField（缺省 256 字、最多 2000 个 Unicode 标量、multiline 4–8 行）、number、stepper、toggle、slider、select、segmented、chips、date、time、rating；结构组件 tabs/collapsible/accordion/carousel/grid/timeline/badge/avatar/codeBlock/divider/spacer（`docs/plugins/inputs.md:3,39-53,109-121`）。
- 表单 `form`+`submit`：`bind` 必须以 `data.` 开头，`event.value` ≤ 4 KiB，onChange 250 ms 合并，单面板串行；校验支持 required/min/max/minLength/maxLength/pattern(email|integer|decimal|alphanumeric|slug)（`inputs.md:7-33,68-89`）。
- **没有 password 组件，也不接受 obscureText/密码键盘**；审批卡、授权按钮、密码框「永远没有密码类型」（`inputs.md:62`、`design-rules.md:15`）。onChange 恒 `userGesture=false`（`inputs.md:97`）。

**处置**：加密备份容器（`DCA1`）在手机上不导入。宿主返回 400 `encrypted-container` 时，插件显示「加密备份请到电脑端解锁后导入」，不弹明文密码框——
明文密码进视图既违反不变量（密码不进视图），也会被视图数据推送给 App 缓存。这是**功能降级里唯一被明确接受的一条**，代价写进限制表。

### Q3 files 能力的真实边界

- 清单声明 `capabilities:['files']`（顶层，不在 contributes 里，`schema/manifest.schema.json`），按钮加 `requires:['files']`，视图用 `caps.features?.includes('files')` 判断（`docs/plugins/files.md:7`）。
- 效果：`{type:'pickFile', action, maxFiles}` / `pickImage`；`maxFiles` 1–4，缺省 1。回调 `event.value = {status:'selected'|'cancelled'|'error', files:[{handle,name,bytes,mediaType,access}]}`；`handle` 只在本次被等待的回调内有效，用 `ctx.dshGo.readPickedFile(handle)` 取 `Uint8Array` 副本（`files.md:35-52`）。
- 预算（`files.md:84-99`、`runtime/bridge/dsh-go-bridge/lib/native/capabilities.js:13-17`）：**单文件 8 MiB**、单次 16 MiB、全主机缓冲 64 MiB、未结束请求全主机 8/每连接 1、请求生命周期 **5 分钟**、每次上传 30 秒、读取 10 秒无进展即取消、文件名 128 字。
- 必须 `userGesture=true`（App 当场点按）且 3 秒内到达；failure 回调只允许 `patch`/`refresh`/`toast`，不能再次选文件（`files.md:74-78`）。
- 只有 Android 本机引擎可用：DSH Remote 中继不转发 `/dsh-go/*` ⇒ `canReachDshGo=false`，不得假装能选文件（`files.md:101-107`）。
- 取消/失败形状：`{status:'cancelled'}`（用户返回）与 `{status:'error', message?}`（读取超时/超预算），都走同一个回调 action。

**处置**：导入第一步在 `caps` 含 files 时给「选文件」主按钮；否则显示一行说明并提供「从产物库选」与「到电脑端导入」两条降级路径。

### Q4 导出产物怎么到手机

插件侧没有下载/分享/保存到相册的效果：效果白名单只有 insert/command/open/link/toast/copy/refresh/patch（`docs/plugins/actions.md:11-24`），`link` 只收 https。gallery 的保存/分享是 App 看图页的动作，插件拿不到（`components.md:60`）。App 自带「导出对话日志 → 存到下载」不是插件 API。

真实通道 = **挂载手机存储**：App 设置项 `phoneStorage`（`app/lib/state/settings_state.dart:49-50`）把手机共享存储挂到引擎的 `/sdcard`（`app/lib/state/artifacts.dart:166-169`），约定产物目录 `/sdcard/Download/DSH-Go`（`artifacts.dart:166-182`），App 会把该目录里新出现的文件列为产物（`origin: phoneOutput`，`artifacts.dart:341-424`）。

**处置**：导出成功后插件（与引擎同进程，有 `node:fs`）把 ZIP 复制到 `/sdcard/Download/DSH-Go/`，成功显示「已存到手机的 DSH-Go 下载目录」，失败显示失败原因 + 宿主绝对路径 + 一键复制。不开挂载就只能拿 host 路径，文案明说。

### Q5 placement 三个落点在窄屏下的可用行为

- `session.tab`：对话详情里的插件页签，带 `sessionId`；`features`：全部功能列表，`scope` 为空；`chat.panel`：聊天页插件弹层，带 `sessionId`；`plugin`：插件详情页（老 App 退回 `session.tab`）（`docs/plugins/slots.md:101-113,147-149`）。
- `presentation:'sheet'` 让弹层形态打开（状态条/open/composer.tools 生效）。
- 面板内容宽度就是手机屏宽（无并排约束），视图自身限 32 KiB/120 组件/8 层/每容器 32 孩子，长内容必须靠 `list` 内滚 + 分页，不能靠多级页面硬塞（`components.md:128-137`）。
- 多级视图可行：面板视图无导航栈，本插件用「同一面板换数据」（`lib.* detail`）做二级，避免用户在多页签间迷路；返回 = 面板内「返回」按钮回到列表。

### Q6 长任务：pending 上限、断线、两个 pending 的竞争

- pending：`timeoutMs` 1–60 秒（缺省 30），结果最多 60 秒后到；**同一插件同时最多 2 个未兑现 pending**，第 3 个 429 `too-many-pending`；完成/超时/取消/断开四者先到先算、后到丢弃、**不可续**（`docs/plugins/actions.md:64-91`、`limits.js: pendingPerPlugin=2`）。
- 数据推送 emit 完整对象、限 4 Hz、≤32 KiB（`slots.md:86`）；handler 3 秒，连续 5 次违规本次运行降级成网页版（`slots.md:88`）。
- 断线后不能续：面板重开等于新会话，视图重新读 store。

**处置**：**不用 pending 扛长任务**。`/execute`、`/export`、`/restore`、`/sync/sync`、`/sync/apply-items` 都是同步长调用：插件起后台 promise（fire-and-forget）+ 每 1.2 s 轮询 `/runs?scope=recent` 推 `patch`，handler 立即返回。同一时刻只允许一个写任务（单飞行槽），既避免两个 pending 抢额度，也避免宿主 mutation gate 409。pending 只用于点按级的短反馈。

## 阶段 1：信息架构（4 个面板预算内的取舍）

| 槽位 | 面板 | 装什么 | 为什么放这里 |
| --- | --- | --- | --- |
| P1 | `overview` 概览 | 版本/档案/引擎与同步健康/数量/诊断入口 | 打开第一眼看「现在能不能用」，只读，失败也不该拖垮其它页 |
| P2 | `library` 产物库 | 快照 + 导出备份混排，按 capabilities 分派（预览/恢复/删除） | 恢复与删除共用「选一个产物」的心智；同步快照不进这里（要联网、要凭据，放 P3） |
| P3 | `sync` 同步 | 传输/仓库/基线、拉差异、逐项+批量裁决、应用、回滚 | 裁决必须在能看见全量差异的地方做，单独成页 |
| P4 | `flow` 导入导出 | 导入向导（选文件→上传→Plan→裁决→执行→结果）+ 导出 | 唯一有「多步向导」的流程，独占一页 |

其余高频入口（不开第 5 个面板）：
- `composer.tools` 2/2：`open-hub`（打开概览）、`quick-export`（直接导出，用上次的会话数）
- `session.actions` 2/2：`export-now`、`open-library`
- `composer.strip` 1/1：`sync-line`（输入框上方一行同步状态，≤24 字，点开进 P3）
- `turn.note` 不用（会占每轮 2 个插件名额，收益低）

**被砍掉的**：市场（My Configs）、历史迁移、档案管理、路径浏览、更新检查、磁盘清理、会话导出——这些在手机上要么是纯配置（改完还得回电脑看结果），要么需要长文本输入（路径），要么与手机价值不匹配。全部保留在网页版，面板里只给一个「在网页版打开」的说明，不假装能做。
**降级到 WebView 的**：诊断报告全文（超 32 KiB 限制且需要滚动长文）、加密备份解锁（无密码组件）。
**本期不做**：多实例/多档案切换（`profile-switch` 要重启引擎，手机上重启体验不可控）。

## 协议缺口清单

| # | 缺口 | 影响 | 处置 |
| --- | --- | --- | --- |
| G-1 | `settingsSection` 槽位无 native occupant（`seat_inventory.dart:152-166`） | 设置页行恒为「网页版」，原生入口差一步 | 写 issue（见文末），不擅改 dsh-Go |
| G-2 | 视图组件无 password 类型（`inputs.md:62`） | 加密备份不能在手机上导入 | 降级：提示到电脑端；不弹明文密码 |
| G-3 | `Slots.dshGoPanel` 是死槽位（`slot_catalog.dart:190`） | 不能用自定义槽位接管设置行 | 记录，不做 |
| G-4 | files 只在本机引擎；远程中继不转发 `/dsh-go/*` | 远程主机模式不能选文件 | 面板按 `caps` 隐藏选文件按钮，文案说明 |
| G-5 | 插件无下载/分享效果 | 导出只能落 `/sdcard/Download/DSH-Go`（需用户开挂载） | 复制 + 失败给 host 路径 |
| G-6 | pending 不可续、每插件 2 个 | 长任务不能靠 pending 扛 | 后台 promise + `/runs` 轮询 |

## 验收表

| # | 验收项 | 判定 |
| --- | --- | --- |
| 1 | 真机 v1.0.16：点设置进插件、全程无「需要网页版」 | **FAIL（协议限制）**：设置行恒网页版，原生入口 = 设置→全部功能→配置管家。见 G-1 |
| 2 | 四个面板数据与电脑端一致 | **NOT VERIFIED**：无真机；视图数据源与 web 同端点同字段（`/status`、`/sync/status`、`/snapshots`、`/backup-files`） |
| 3 | 导出全链路（手机上触发→落地→拿得到） | **NOT VERIFIED**：链路实现+单测覆盖，未在真机跑 |
| 4 | 导入全链路（选 ZIP→上传→Dry Run→裁决→执行→结果） | **NOT VERIFIED**：同上；取消回滚路径有单测（`resolveAll` 排除 Error、未裁决即拒） |
| 5 | 同步全链路（拉差异→批量→应用→基线） | **NOT VERIFIED**：同上；批量口径与 web `isBulkDecidable` 有单测钉住 |
| 6 | 恢复链路（摘要+二次确认；未真执行要写原因） | **PASS（只到预览）/ NOT VERIFIED（真执行）**：dry-run 与 `planFingerprint` 回传实现并有单测，真执行未跑 |
| 7 | 远程主机模式降级文案命中 | **NOT VERIFIED**：按 `caps.features` 分支实现，无远程环境可测 |
| 8 | `check.mjs --load --lang zh` 退出码 0 | **PASS**：EXIT 0，四面板 × 两落点 × 两语言全部「能显示」 |
| 9 | 本仓库 typecheck / test / build / i18n 守卫 | **PASS（typecheck 0、test 5726 项 5724 pass 0 fail、i18n 守卫 17/17）/ FAIL（build）**：build 挂在**他人未提交改动** `src/client/recovery/RollbackCard.tsx:735`（JSX 属性位里插了 `{/* … */}`，HEAD 版本正常），与本插件无关 |
| 10 | web 四页手点无回归 | **NOT VERIFIED**：本插件不改 `src/`，但工作区有他人在途改动，未手点 |
| 11 | 报告记录 minApp、实测 App 版本、协议缺口 | **PASS**：minApp=1.0.16（`test/manifest.test.mjs` 钉住）；实测 App 版本**未测**（无真机）；缺口见上表 G-1..G-6 |

## 安装与重启

```bash
dsh plugin --profile web add integrations/dsh-go/config-manager
# App：设置 › 插件 › 已安装 › 重启内核以重载
```

## 给 dsh-Go 的 issue（不擅自改源码）

**标题**：`feat(plugins): 让 settingsSection 槽位也能被原生面板接管，避免插件「设置」行恒跳网页版`

复现要点：
1. 装任一提供 `contributes.panels`（`placement:['features']`）的插件，且该插件包内声明了 bundle/row/settings 配置段。
2. 设置 › 插件 › 该插件行尾显示「网页版」，点按跳 DSH Web（`app/lib/ui/plugins/seats/seat_links.dart:139-158`）。
3. 期望：`SeatMode.native` 可覆盖 `settingsSection`，或 `Slots.dshGoPanel` 给出消费者（`seat_inventory.dart:152-166` 目前返回 null、`slot_catalog.dart:190` 无 UI 消费）。
