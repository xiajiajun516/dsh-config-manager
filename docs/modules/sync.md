# 同步与档案（src/sync、src/profiles）

读者：要改同步通道、合并语义、自动同步、配置档案复制/启动的人。只写「代码现在是什么」，不写路线图。

## 1. 职责与边界

- **同步**：把本机配置按**分区**（section）收集成快照（snapshot），推到四个通道之一（git / webdav / s3 / gist），或拉回来做差异预览、三方合并、逐项应用。
- **自动同步**：宿主进程内的定时器 + 本地文件监听，按通道独立配置（schema v2）；不依赖浏览器。
- **档案**：DSH 的 `$DSH_HOME/profiles/<name>` 目录级复制、重命名、删除、启动独立实例、停止实例。
- **不做的事**（都有代码证据）：
  - pull 不直接写配置：`pull()` 只产出 importPlan，执行由上层确认后走 Importer（`src/sync/sync-engine.ts:1239` 注释）。
  - gist 不做 blob 外置、不做条件写（`src/sync/gist/gist-transport.ts:22`、`:58`）。
  - 凭据值与同步密码不落盘/不进日志/不回传浏览器（见 §6）。

## 2. 入口

### 2.1 HTTP（`src/routes/sync.ts`、`src/routes/profiles.ts`）

同步端点（都是 `endpoint({ path, methods }, …)`）：status `:188`、workdir/reset `:269`、config `:299`、ui-prefs `:373`、push `:400`、pull `:458`、github/start `:498`、github/poll `:531`、github/cancel `:574`、github/validate `:589`、github/repositories `:624`、history `:653`、probe `:720`、download `:755`、snapshot-delete `:793`、snapshots-list `:812`、sync（预览）`:856`、apply-items `:926`、cancel `:1062`、autosync `:1083`、selection `:1141`、rollback `:1207`、merge-preview `:1238`、apply-merge `:1258`。

档案端点：list `src/routes/profiles.ts:70`、launch `:93`、detail `:118`、create `:130`、copy `:156`、rename `:189`、delete `:209`、stop `:232`（写操作全过 mutation gate）。

### 2.2 定时器

`AutoSyncScheduler` 在宿主装配期构造（`src/index.ts:3619`），在 `src/index.ts:4760` 调用 `scheduler.start()`（**不在 makeRoutes**——要等 recovery 分类完成），销毁在 `src/index.ts:4768`。

调度器内部的四类触发面（另加一次启动触发）：

- **启动触发**：`start()` 排完定时器就立刻对每个 enabled 通道跑一轮 `startupRuns()`（受各自 `startupMinIntervalMs` 约束，`src/sync/autosync-scheduler.ts:278`、`:425-432`）——「刚开宿主就同步」来自这里，不是定时器。
- **每通道定时器**：按通道各排各的 interval，改动某通道只重排该通道（`src/sync/autosync-scheduler.ts:336-355`）。
- **本地改动监听**：`realtimeChannels` 驱动 watcher，回调里对每个 realtime 通道 `trigger('local-change')`（`:398-412`、`:417-421`）。
- **远端轮询**：`remoteTimers`（缺省 60 s，见 `src/sync/autosync-config.ts:41`）。
- **收尾补跑**：`running` 期间的新触发按通道记进 `pendingTriggers`（`:233`、`:311-318`），本轮收尾逐通道补跑（`:450-457`）；`stop()` 清三张 timer 表 + `pendingTriggers.clear()` + 断 watcher（`:282-293`）。

### 2.3 宿主工具与 CLI

- Agent 工具经 `registerModelTools`（`src/index.ts:4747`）复用同一 `makeSyncEngine`，只放行 `'auto'` 档分区。
- **CLI 没有同步/档案子命令**：`src/cli/index.ts:59-61` 的子命令枚举只有 snapshots/restore/reinstall/recover-stale-lock/verify/backup/import/sessions/web/help。

### 2.4 配置与选择（按通道独立，schema v2）

- 分区放行：`sync-selection.json`，`schemaVersion:2`，按 git/webdav/s3/gist 各自存 `mode`/`sections`/`sessionsLimit`/`encrypt`/`includeSecrets`（`src/sync/sync-selection.ts:31-32`、`:161`）。`mode='default'` 用全部便携分区；`mode='advanced'` 且非空才用勾选（`:137-138`），空勾选回退全量以避免自动同步卡死。
- 自动同步开关：`sync-autosync.json`，`schemaVersion:2`，同样按通道独立（`src/sync/autosync-config.ts:25-26`、`:181`）；缺 schemaVersion 视为 v1，非 2 回退缺省（`:200`）。
- 引擎构造期只认 `optInSections`（`src/sync/sync-engine.ts:603`）；自动同步与 model-tools 传 `'auto'` 档（`src/index.ts:3624`），所以「界面上勾了」不等于「自动同步会传」。
- 保留策略：GFS 三层（`keepLast`/`keepMonthly`/`keepYearly`，缺省 10/0/0，`src/sync/retention-policy.ts:27-42`），缺省走旧 FIFO 快路径以保持等价（`:254-269`）。
- **为什么按通道独立而不是全局一份**：老形态下 autosync / 模式 / 分区勾选 / 加密 / 远端快照全共享，切换通道就互相踩（GitHub 想 30 分钟自动、WebDAV 只想手动推加密快照这种组合无法表达）⇒ 才把配置改成按通道命名空间；v1 读入归一为 git 通道，旧 API 字段（`syncSelection`/`autosync`）保留返回以免破坏调用方。同一时刻仍**只允许一个通道在跑**（全局防重 `runs.register('autosync')` + `running`），另一通道的触发在收尾后补跑，不丢同步。
- **git 仓库选择器**（用户可见，2026-10 起）：配置弹窗的 git 分支在地址框上方有仓库选择器（`src/client/sync/SyncRepositoryPicker.tsx`；纯逻辑在 `src/ui/sync-repository-picker.ts`，可被 node:test 覆盖）。只列**当前 token 可见的私有仓库**、可内联新建私有仓库（请求体不传 `private`，宿主恒定建私有）；地址框保留给 ssh / 本地路径 / 列表外仓库。宿主端点 `/sync/github/repositories` 的 GET(列) 与 POST(建) **共用同一路径**（围栏按 `(kind, path)` 去重，拆成两条会撞车，同 `/sync/autosync` 先例），REST 能力在 `src/market/github-repos.ts`（`createRepo`/`listRepos`）；两条分支都**不挂 mutation gate**（列举只读、建仓是幂等元操作，挂上会让 SAFE MODE 用户连仓库都选不了）。

## 3. 关键调用链

### 3.1 push

1. 选项校验：`includeSecrets` 必须搭配 `encrypt`、`encrypt` 必须有密码（`src/sync/sync-engine.ts:867-873`）。
2. 远端推进检测 `remoteAdvancedCheck()`（`:1219`）：`base = state.lastSnapshotId`；`base === ''` 视为首次同步直接放行（`:1222`）；否则 `transport.list()` 取最新 id 比较，不一致即 `blocked`（`:1230-1231`）。`push` 在 `:876-881` 调用它；`blocked` 时返回 `ok:false` 并**零写入**（不 upload、不记基线、不改 sync-state）；`force:true` 才跳过。
3. 采集便携分区：`portableAdapters` + 本次放行可选分区（`:621` 附近），`FORBIDDEN_SECTIONS` 永远排除 `credentialsStatus`/`secrets`（`:436`）。
4. 加密：sections 逐分区加密、凭据独立密文载荷（`:921`、`:716`、`:740`），manifest 记 `encrypted:true`（`:962`）。
5. 本地散文件副本：**仅非加密**（`:970`）。
6. `transport.upload(snapshot)`（`:974`）。
7. 远端裁剪 `pruneRemoteSnapshots`（`:1170`；失败只进 warnings）。
8. 记基线 `recordBaseline`（`:1797`）：`snapshotId` = 本地祖先副本目录名 → `ancestorId`，`remoteSnapshotId` → `lastSnapshotId`；加密通道落**密文**祖先副本（`:1822-1839`，issue #107）；无密码不落副本（`:2067`）。

### 3.2 pull

`pull()`（`:1239`）→ `prepareSnapshot`（`:1250`，加密缺密码即抛）→ 解密凭据（`:1254`）→ 转临时标准 ZIP → Importer 预览（`:1257`）→ 清临时 ZIP（`:1294`）。**不写本机配置、不记基线**。

### 3.3 merge（三方）

`merge()`（`:1477`）：

1. 读远端并解密（`prepareSnapshot` `:1492`）。
2. 按墓碑剔除远端已删会话（`:1496`）。
3. **共同祖先 = `state.ancestorId`（本地祖先副本目录名），不是 `lastSnapshotId`**（`:1503-1507`，注释写明混用会导致每轮合并失败）。副本缺失/损坏 → `undefined` 降级两方（`:1509-1512`）。
4. 加密祖先副本用本次密码解密；密码缺失/不符/损坏一律降级为「无祖先」（`:1513-1523`）。
5. 决策表在 `src/sync/merge.ts:4-24`：无祖先 → `conflict(reason='no-ancestor')`，**拒绝猜测**；`local==ancestor` → `useRemote`；`remote==ancestor` → `keepLocal`；双侧改 → 文本行合并，残留冲突仍 `conflict`（`:363-372`）。

### 3.4 apply

`applyMergeResolutions`（`:1611`）→ 重新 `merge()` 取干净计划（`:1624`）→ `applyMergePlan`（`:1880`，逐分区写回，经 Importer 执行）→ `writeMergeBaseline`（`:1740`）：写回成功才推进；**写回成功但再导出失败**记 `baselineRexportFailed` 告警、不记基线（`:2008`、`:2144`）。服务器双向合并走 `applyItems`（`:2042`）。

## 4. 一致性模型

三个事实源，缺一不可：

| 事实 | 存储 | 语义 |
|---|---|---|
| 远端指针 | `sync-state.json` `lastSnapshotId` | **只**存远端快照 id；push 前一致性检查的 `base` |
| 本地祖先指针 | 同文件 `ancestorId` | **只**存本地祖先副本目录名；merge 的三方祖先来源 |
| 分区 hash | 同文件 `sections[].hash` | 与本机现算 hash 比 → 判定「本地有没有改」 |

- 迁移与解析：`src/sync/sync-state.ts:17`（v3 语义）、`:202-217`（v2 及更早原 `lastSnapshotId` 双写为 `ancestorId`；非字符串 `ancestorId` 视为无祖先）。
- `pendingMerge` 非空时刻意不推进远端指针（`src/sync/sync-state.ts:37-48`），避免把「还没裁决的合并」当成已同步。
- 假冲突防护点：`merge.ts:340` `localHash === remoteHash → skip`；`:350-354` 无祖先直接 `conflict('no-ancestor')` 而不是随便挑一边；`:357-358` 单侧改走单侧；`:363-372` 精细合并后再用 hash 回退，避免「行合并产物与被改侧不一致」被记为已合并。
- 设备身份：`resolveDeviceIdentity`（`src/sync/sync-state.ts:241`，调用点 `src/sync/sync-engine.ts:939`），随快照 manifest 上行，用于历史展示与排查。
- 会话记账：`computeSessionBookkeeping`（`src/sync/sync-engine.ts:1108`）产出 `sessionUnits`/`deletedSessions` 墓碑（上限 5000，`src/sync/session-tombstones.ts:26`）。**`tracked=false` 的三种情形一律不动既有墓碑**——没推 sessions / 适配器不支持全量枚举 / 本机枚举抛错或为空（`:1113`、`:1120`、`:1123`）：用「读不到」覆盖成「全删了」会一次标错几百条，绝不猜；`pull` 与 `merge` 都按墓碑剔除已删会话（`stripTombstonedUnits`，`src/sync/session-tombstones.ts:83`），墓碑只删远端条目、不删本机数据。

## 5. 通道能力矩阵

| 能力 | git | webdav | s3 | gist |
|---|---|---|---|---|
| 索引条件写 | push 非快进即拒（`src/sync/git/git-transport.ts:341`、`:400`） | ETag → `If-Match`；无索引 → `If-None-Match: *`；**无 ETag 退化无条件写**（`src/sync/webdav/webdav-transport.ts:90-96`） | `if-match` / `if-none-match: *`（`src/sync/s3/s3-transport.ts:61-66`） | **无**（`src/sync/gist/gist-transport.ts:63-70`：端点对任何条件头回 400，issue #110）→ 改用写后复核 + 有界重做，见 §8 |
| blob 外置（sessions） | 有，与索引同一次 commit（`src/sync/git/git-transport.ts:315-336`） | 有，`blobs/` + `blobs-index.json`（`src/sync/webdav/webdav-transport.ts:63-71`） | 有，`blobs/<sha256>`（`src/sync/s3/s3-transport.ts:53-57`） | **无**（`:22-24`：一次 GET 全量、会截断、文件数上限） |
| 重定向跟随 | git 自身不管 | 自实现，上限 5（`:110`） | 无 | 自实现，上限 3（`:55`） |
| 失败重试 | 读路径可重试，写路径明确不重试（`src/sync/git/git-transport.ts:727-729`） | 共享 `withSyncRetry` | 同左 | 同左 |
| 单次载荷上限 | 无显式上限 | 无显式上限 | 无显式上限 | GitHub gist 文件截断 → 回落 `raw_url`（`src/sync/gist/gist-transport.ts:568-584`） |

写入顺序（防止「索引指向不存在的 blob」）：webdav / s3 先把 blob 与 blob 索引落远端、**最后**写快照索引（`src/sync/webdav/webdav-transport.ts:408-422`、`src/sync/s3/s3-transport.ts:289-309`）；git 把索引与 `blobs/` 放进同一次 commit（`src/sync/git/git-transport.ts:315-336`）；gist 只有一次 PATCH，新载荷与合并后的索引一起写（`src/sync/gist/gist-transport.ts:284`）。

共享契约在 `src/sync/transport.ts:123`（`list/upload/download/delete/probe`）、`:119`（412 判定）、`:355`（`sectionsEqual`：本地 sections 空 = 加密 ⇒ 必上传）。blob 语义统一在 `src/sync/blob-store.ts:31`（只有 `sessions`）、`:98-99`（引用缺失即硬失败）、`:117`（GC 保护窗口 10 分钟）。

## 6. 失败语义

- 条件写失败（412，webdav/s3 的 409 仅在确实带了条件头时）→ `SyncTransportError`，**中止且不覆盖远端**。
- 读不到远端列表（`remoteAdvancedCheck` 的 `reason`）→ **不拦**，继续 push 并如实告警（`:1219-1227`）；不把「读不到」当「没变」。
- 远端索引 404 **且远端已有任何历史内容** → 零写入中止（判据 `remoteHasPriorContent`：`src/sync/webdav/webdav-transport.ts:379`、`:538`；`src/sync/s3/s3-transport.ts:279`、`:592`）；与有无 blob 引用无关。
- 删除/GC 遇到索引 404 → 不写回、不 GC（`src/sync/webdav/webdav-transport.ts:470-471`）。
- 加密通道无密码 → 不落祖先副本、不写明文（`:2067`）。
- 自动同步：`runs.register('autosync')` 冲突 → 记 `skipped('conflict')` 且立刻释放 `running`（`src/sync/autosync-scheduler.ts:483-486`）；注释记录了 2026-09 真机 bug（mutation-locked 早退未 `finishRun` → run 永久 running，之后后台同步静默停摆，`:494-496`）。
- 凭据：同步密码只作为参数透传，存 DSH credentials 专用槽位；保存路径 `src/routes/sync.ts:1174-1183`（清空优先于写入），响应只回 `encryptPasswordConfigured`/`decryptPasswordConfigured` 布尔（`:1186-1195`），client 侧同样只有布尔（`src/client/sync/sync-api.ts:176-198`）。

## 7. 档案：复制与隔离实例

### 7.1 复制（`src/profiles/dsh-profile-manager.ts:213`）

1. 先写标记 `.dcm-copy-in-progress.json` 再拷文件（`:226-235`，常量 `src/profiles/dsh-profile-shared.ts:198`）——进程被强杀时半截副本可被列表辨识并物理删除。
2. 逐顶层条目 `fs.promises.cp`（异步，避免卡死宿主事件循环，`:241`）。
3. `includeNodeModules=false` 时同时跳过 `node_modules` 与 `.dsh-module-fallback`（`:239-240`；派生目录只搬会留悬空链接）。
4. `relinkCopiedTree` 把「指向源档案内部」的 junction 重指向副本自身，**指向源档案之外**的链接原样保留（`:302`）；不做就会出现「删掉源档案，副本缺包」。
5. 改 `package.json` 的 `name`（`:248`），删标记（`:261`）。
6. 失败回滚 = `rm -rf` 目标目录（`:251-257`）；回滚自身失败只记「请手动删」。**这不是原子回滚**：异常前已拷出的内容不会被逐个复原，靠「整目录删掉」达成净效果。
7. `includeNodeModules=false` 且声明了依赖 → 返回 `depsNotInstalled` 告警（`:266-268`），绝不静默。

### 7.2 隔离实例

- 启动：`DshProfileLauncher`（`src/profiles/dsh-profile-launcher.ts:261`）以 `detached` 起子进程、日志重定向到文件，30 秒就绪上限（`src/profiles/dsh-profile-shared.ts:154`）。**能反解出真入口才 `shell:false`**；反解不出退回 `.cmd`/`.bat` 包装脚本时是 `shell: needsShell`（`:179-190`）——此时孙进程 stdio 会被吞、日志抓不到带 token 的 URL（`:228-236`）。
- 运行注册表：`<dataDir>/running/<profile>.json` 心跳（`src/profiles/dsh-profile-runtime.ts:9`），20 s 刷新 / 60 s 判死（`:33-35`），**不写认证 token**（`:13`）；只能停别人（`:17`）。
- 保留限制：`desktop` 是 Electron 独占档案，启动/删除/改名一律以 `managedProfile` 拒绝（`src/profiles/dsh-profile-shared.ts:244`、`src/profiles/dsh-profile-manager.ts:276`、`src/profiles/dsh-profile-launcher.ts:348`）；保留名另见 `src/profiles/dsh-profile-shared.ts:252`。

## 8. 已知限制

- gist 通道**没有条件写**（`src/sync/gist/gist-transport.ts:63-70`，issue #110：PATCH 对任何条件头回 400），改用**写后复核 + 有界重做**：PATCH 之后重新 GET 索引，核对「本次条目在场（非加密快照还要求分区 hash 全等）」且「读前见过的其它条目一个都没少」；任一不成立就重读最新索引、重新合并再写，最多 3 轮（`MAX_INDEX_WRITE_ATTEMPTS`，间隔 200 ms），仍不成立抛 `sync.gist.indexConflict`（`kind:'conflict'`、`code:'index-conflict'`；upload `:263-298`、delete 同源防护 `:385-424`、复核实现 `verifyIndexLanded` `:309`）。**残余窗口仍在**：别人在「我们读索引」与「我们 PATCH」之间写入的条目我们读不到，无条件写发现不了 —— 要并发保护请用 git / webdav / s3。不要在此基础上宣传并发安全。
- webdav 在服务端不给 ETag 时退化为无条件写（`src/sync/webdav/webdav-transport.ts:92`）。
- 四个 transport 各自维护 HTTP 客户端（超时、状态分类、错误类），重复度高；只有重试策略共享（细节易漂移，证据见 `docs/lessons/sync-channel.md`）。
- 快照 JSON 自身载荷上限 512 MiB（`src/utils/json.ts:24`），超大快照仍会整体进内存。
- 自动同步的并发保护是宿主进程内单例（`running` 标志），跨进程多开不互斥。

## 9. 测试锚点

- `src/sync/sync-engine.test.ts`：引擎主流程、推送/拉取/基线。
- `tests/sync-merge/baseline-discipline.test.ts`：场景 11 并发改远端被拒且 state 原文不变（`:71`）、11b 读不到列表不拦（`:114`）、12 中途失败整体回滚（`:134`）。
- `tests/sync-merge/scenarios.test.ts`、`merge-granular.test.ts`、`merge-resolution.test.ts`、`contract.test.ts`、`security.test.ts`、`transport-failures.test.ts`。
- `src/sync/gist/gist-conditional-write.test.ts`：强/弱 ETag 都不注入 `if-match`，删除路径同样不带（三条用例 `:108`/`:119`/`:130`，共同断言 `assertNoConditionalHeaders` `:100-104`）。
- `src/sync/gist/gist-overwrite-semantics.test.ts`：写后复核三轮仍被覆盖 ⇒ 抛 `index-conflict`（用例 `:181`，断言 `code` `:198`）；`src/sync/gist/gist-delete-concurrency.test.ts`：删除路径同源防护（用例 `:187`，断言 `:200`）。
- `src/sync/webdav/webdav-conditional-write.test.ts`、`src/sync/s3/s3-conditional-write.test.ts`：条件写头与 412/409 语义。
- `src/sync/autosync-scheduler.test.ts`、`src/sync/sync-state.test.ts`、`src/sync/merge.test.ts`、`src/sync/sync-selection.test.ts`、`src/sync/blob-store.test.ts`。
- 端到端与路由：`tests/e2e-sync-apply.test.ts`（apply-items 路径）、`tests/e2e/plugin-data-migration.test.ts`、`tests/route/sync-rollback-route.test.ts`、`tests/route/sync-download-route.test.ts`、`tests/route/sync-workdir-reset-route.test.ts`、`tests/route/sync-snapshot-delete-route.test.ts`。
- 档案：`src/profiles/dsh-profile-manager.test.ts`、`src/profiles/dsh-profile-incomplete-copy.test.ts`（标记契约，`:176`）、`src/profiles/dsh-profile-launcher.test.ts`。

## 10. 维护提示

- 改 `sync-state` 结构必须同改 `loadSyncState` 的迁移分支（`src/sync/sync-state.ts:191`），否则老状态会被当成缺省。
- 新增同步通道要同时改：`SYNC_CHANNELS`（`src/utils/shared-constants.ts:58`）、`sync-config.ts` 的 `channelMap`、selection/autosync 的按通道结构、`src/index.ts:3540` 的 transport 分派。
- 改合并决策必须先读 `src/sync/merge.ts:4-24` 的决策表；「无祖先就猜一边」是明确禁止的行为。
- 改档案复制时要维持「标记先行 + 只认自己的标记」（`src/profiles/dsh-profile-manager.ts:226`），不要引入「看着像残留就删」的启发式。
