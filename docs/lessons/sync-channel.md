# 同步通道（分区放行与会话管理） — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/lessons/README.md`。

## 同步分区目录含显式可选项（issue #78 起是「逐分区放行」而不是布尔）

- **同步分区目录含显式可选项（issue #78 起是「逐分区放行」而不是布尔）**：`syncSectionCatalog` = portable + `OPT_IN_SYNC_SECTIONS`（**注册表派生** = `SectionMeta.syncOptIn !== 'off'`，当前 `mcp` / `sessions`）。可选分区**永不默认进入同步通道**，放行只看引擎构造期的 `optInSections: readonly SectionId[]`（`pullSectionIds()` 决定远端快照里哪些分区进临时 ZIP；`pushTargets()` 决定哪些能上榜）——**绝不用布尔**：布尔会退化成「勾了 mcp 连带放行 sessions」（`sync-engine.test.ts` 有推/拉两条回归）。宿主按驱动方决定传什么：**手动** push/pull / 一键同步传「持久化选择 ∩ OPT_IN_SYNC_SECTIONS」，**自动同步**与 model-tools 只传 `'auto'` 档（`AUTO_SYNC_OPT_IN_SECTIONS`，当前 = mcp）—— sessions（`'manual'`）绝不悄悄上行/下行。`opts.sessions = { limit }` 只是 sessions 的**导出参数**（带哪几个对话），不再兼任开关。

## 同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地；对外格式见 `docs/spec/sync-channel-v1.md

- **同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地；对外格式见 `docs/spec/sync-channel-v1.md`）**：
  ① **远端保留接 GFS**：`SyncEngineOptions.retentionPolicy`（宿主注入 `readBackupSchedule().retention`）驱动 `pruneRemoteSnapshots`，与本地备份产物/本地快照共用同一份 `RetentionPolicy`。缺省 `DEFAULT_RETENTION_POLICY`（keepLast=10）走 core 的 `selectPruneCandidates` 快速路径 → 与旧硬编码 `MAX_REMOTE_SNAPSHOTS` **逐字等价**；**刚 push 的快照恒保留**（三层全关时也不删它）。此前「会话寿命 = 最近 10 次 push」由此消除。
  ② **跨机重定基贯通同步链路**：push 把 `ctx.homeDir` 写进 `snapshot.manifest.sourceHome`，`snapshotToZip` 透传进临时 ZIP → Importer 的 `rebaseMapping` 生成「源机 home → 本机 home」；`merge()` 额外**备忘**远端 sourceHome（`lastMergedRemoteSourceHome`）供 `applyMergePlan` 写入临时 ZIP 的 manifest（否则一键同步/自动同步路径永远不重定基）。`SyncPullOptions.pathMappings` 与路由 `extractPathMappings` 承载**用户映射**，排在自动规则之后。**缺 sourceHome 的旧快照不猜**（行为与改造前一致）。
  ③ **逐会话点名**：`sync-selection.json` 的 `sessionsInclude`（非空时**优先于** `sessionsLimit`；空 = 回到「最新 N 个」）。引擎用 `sessionExportOptions` 保证「显式勾选 > 数量上限」——adapter 里 `restrictUnits` 先于 `includeItems` 执行，两者叠加是**交集**（会退化成「最新 N 个里我勾中的那几个」），所以 include 非空时**不施加数量限制**。UI 复用导出侧的 `ContentPicker`（`SyncSectionPickerDialog` 内切换视图，**不嵌套第二个 Modal**），清单来自 `/export-preview`（`SyncApi.exportPreview`），勾选模型在 `ui/sync-settings-view.ts`（`initialSessionPicks`/`sessionPickerSelection`/`pickedSessionIds`）——组件里不得再实现「sessions 显式放行」判定（t42 守卫会红；判定走 `needsSessionInventory`）。
  ④ **内容寻址 blob 仓**（`src/sync/blob-store.ts`）：`sessions` 在**通道侧**外置为 `blobs/<sha256>` + 引用形态（散文件 `<section>.blobs.json` / WebDAV 载荷 `blobRefs`），**只有 transport 传了 BlobSink 才启用**（引擎/导出/导入看到的仍是普通 FilesSection）。命中已有哈希 = 零传输。**读回缺 blob 必须硬失败**（绝不降级为空分区）；**加密快照永不外置**；`sectionHashes` 一律按明文分区算（拉取侧不解仓也能比较变更）。GC：保护窗 10 分钟 + 「任一引用文件读不出来就放弃本轮」。这两条线**不做协议协商**（旧版读新版会把 sessions 当缺失分区）→ 登记为 `known-gaps.md` **G-19**。
  ⑤ **会话删除墓碑**（`src/sync/session-tombstones.ts`）：push 时「`sync-state.sessionUnits`（上次实际带走）− `adapter.listAllUnitIds(ctx)`（本机现存全量）」= 本次新删，累积成 `manifest.deletedSessions` 随每份快照传播（上限 5000；本机又出现实体则**撤销**墓碑）。**三情形一律不动既有记录**：本次没推 sessions / 适配器不支持全量枚举 / 本机枚举为空或失败（把「读不到」当「全删」会一次性标错几百条）。pull/preview/merge 按墓碑把命中的会话单元从**将要导入的载荷**里剔除（整目录，`relativePath` 前两段），**不删除本机数据**（删除是不可回滚的用户动作）→ 登记为 **G-20**。剔除必须可见（`sync.sessionsTombstoned` / `sync.sessionDeletionsRecorded`，绝不静默）。
## 同步写路径：索引条件写 + 机器专属路径不进快照（2026-10，借鉴 dsh-cloud-sync）

- **索引写入必须是条件写（If-Match / If-None-Match）**：WebDAV 的本文档描述的三条通道里，
  `index.json` / `<prefix>/index.json` / gist 索引都是**读改写**形态（先 GET 索引、合并、再 PUT）。
  改造前只有「索引读不出来就不写回」的护栏（不许把可读索引覆盖成空集合），**两台设备同时 push 时仍有一个丢失更新窗口**：
  后写者用自己读到的旧条目集合覆盖索引，先写者的快照条目从列表里消失 —— 数据文件还在，但它会被后续的
  「无引用 blob 回收」当孤儿。落点：webdav / s3 的 `readIndexDetailed` 现在回传 `etag`，写回时带
  `If-Match`（索引本不存在则 `If-None-Match: *`）；412（S3 兼容端点还可能是 409）一律归类为
  `conflict` 并**中止本次写入**，让用户重跑。服务端不给 ETag / 不实现条件写时退化为无条件写（行为与改造前一致），
  **绝不因为拿不到 ETag 把同步判成失败**。
  - **gist 的 ETag 是弱 ETag**（`W/"…"`）：HTTP 禁止用它做 `If-Match`（GitHub 会对这种 PATCH 回 400），
    故 gist 通道只采用**强** ETag，弱 ETag 直接不采用（退回无条件 PATCH）。
  - 范围说明：blob 索引（`blobs-index.json`）**刻意不做条件写** —— 它漏记一条只占空间（该 blob 永不被 GC 删），
    多记一条只是对不存在的 blob 发一次幂等 DELETE，不存在「覆盖别人的快照列表」这类不可恢复后果。

- **首连自动建远端目录（WebDAV 逐级 MKCOL）**：按 WebDAV 规范，MKCOL 的父目录不存在时返回 **409 Conflict**
  —— 这正是「用户填了一个还没建的目录 → 首次同步必失败」的根因。现在：直接 MKCOL 目标集合失败于 409 时，
  沿 baseUrl 路径**逐级 MKCOL** 再重试一次；405/301/302/303/409 都按「已存在」处理，
  只有 401/403/5xx 这类**不是「目录缺失」**的失败才抛出。返回值只记录**本次真建出来**的层级（探针据此如实回报，
  不谎报「已创建」）。

- **机器专属路径不进快照**：profile 的 `pnpm-workspace.yaml` 里可能有 `storeDir` / `globalDir` /
  `cacheDir` / `stateDir` / `configDir`（含 kebab 拼写）这类**机器专属**位置，跟着快照跑到别的机器上会指到
  不存在的地方。现在导出侧按行剥离（缩进块里的同名键不碰；CRLF 逐字保留），写回侧保留目标机自己原有的设置，
  剥离/保留都走既有告警与计划项 detail 通道（用户可见、可取消），不静默改写。
  `.npmrc` **不纳入同步面**（纳入会改 bundle/sync 载荷形态，且本插件从不写它）：来源机的 `.npmrc`
  既不进快照也不被改写。

- **验证状态**：以上三条的**单测**覆盖见 `src/sync/webdav|s3|gist` 与 `src/sync/sync-state` 的用例；
  **未对真实 WebDAV / S3 / Gist 端点做端到端验证**（本批无真实凭据）—— 条件写在服务端不支持时是退化为无条件写，
  因此「真实服务端是否回 ETag / 是否按 412 拒绝」仍属未验证项。


## 自动同步「真·自动」：两条即时通道 + 策略默认值（2026-10）

**规则（硬）**：
1. **监听范围只能覆盖「可同步分区的落盘路径」，绝不含自写路径**：`sync-state.json` / `sync-history.json` /
   `sync-autosync.json` / `backup-schedule.json` 与 `sessions/` 一律不监听 —— 前者会让每轮同步写回自己的状态、
   立刻再触发下一轮（自激）；后者是 GB 级日志且会话恒为 `manual` 档，监听它既无意义又会拖垮宿主。
   监听清单唯一来源 = `src/sync/watch-scope.ts` 的 `buildWatchTargets()`（由 `SECTION_JSON_PATHS` /
   `SECTION_FILE_PREFIXES` 与注册表分区口径派生），不要在调度器里另写一份路径数组。
2. **同步自家写入期间必须挂起监听**：`runOnce` 内部 `watcher.suspend()`、`finally` 里 `resume()`；
   文件目标是「原子写 temp+rename」，句柄不失但会产生事件 ⇒ 不挂起就会自激。
   `resume()` 后另有 2 s 静默窗口（`DEFAULT_WATCH_QUIET_MS`），覆盖宿主侧异步收尾写入。
   **静默窗口只「推迟」不「丢弃」**：窗口内到达的事件照样进 `pending` 并排一枚「窗口剩余 + 去抖」的补跑定时器；
   `flush()` 另有兜底（定时器提前到期 / `clearTimer` 未生效 → 继续推迟，不在窗口内回调）。
   真机实测过反例：旧实现直接 `return` 丢弃，用户刚保存的配置要等一整轮兜底 `interval` 才上行。
   自家回声不靠「丢弃」挡，而由引擎的分区 hash 比对判成「无变化」（多跑一轮零传输）。
3. **触发不丢**：正在跑 → 记 `pendingTrigger`，本轮收尾后立刻补跑；距上轮开始不足 `minTriggerGapMs`（缺省 3 s）
   → 每通道**至多一枚**延迟定时器（连续保存合并成一轮），绝不丢弃。
4. **定时器降级为兜底**：`interval` 仍是兜底节奏（5m…24h），远端探测另有 `remoteCheckMs`（缺省 60 s，
   夹取 15 s–1 h，只在 `realtime` 开启时排期）；两条即时通道都关掉时行为与改造前一致。
5. **风险分级与冲突策略是「按通道」配置**：`autoApplyTier` 缺省 `medium`（`plugins`/`mcp` 也自动落盘，
   `high` 恒不自动）；`conflictPolicy` 缺省 `local`（保留本机并 `push({force:true})`）。
   `'remote'` 档**刻意不存在** —— 它等价于让远端整体覆盖本机，会绕过风险分级。

**证据 / 实测**：
- `src/sync/watch-scope.test.ts`（6 项）：14 个目标逐条存在、`profiles/<p>` 的 `patches/` 递归、`file` 目标只监听父目录非递归；
  负例断言**绝不**监听 `''` / `sessions` / `profiles` 根 / 四个 `sync-*.json`。
- `src/sync/sync-watcher.test.ts`（8 项）：去抖只排一枚定时器、`*.tmp-*` 与 `node_modules`/`.git` 噪声被过滤、
  `suspend` 丢弃在途并屏蔽事件、`resume` 后 2 s 内不回调但**必须排补跑定时器**（窗口结束即补跑，绝不丢用户改动）、
  `stop` 后旧句柄回声不排期、挂载失败只降级（`attachmentCount = n-1`）不抛错。
- `src/sync/autosync-scheduler.test.ts` 四个 realtime 用例：本地改动即触发一轮（期间 `suspend`/`resume` 各 +1）；
  gap 内二次改动只保留一枚定时器、到点后**合并成一轮**；`realtime:false` 不挂监听且只排 interval；
  `remoteCheckMs` 到点触发后立刻重排。
- **真机 `fs.watch` 实测**（临时 home，7/14 目标挂载、其余路径不存在按设计降级）：改 `settings.yaml` → flush `['settings.yaml']`；
  改 `skills/demo/SKILL.md` → flush `['skills/demo','skills/demo/SKILL.md']`；`node_modules` 与 `*.tmp-*` 零触发；
  `suspend` 期间零触发；**静默窗口内的写入不丢**（窗口内无回调，窗口结束立即补跑一次）。
- **未做真机端到端验证**：未在真实 git/webdav 远端上跑「保存 → 立即推送」的完整链路（本轮无远端凭据）；
  「监听 → 触发一轮」之外的下行/上行结论仍来自单测与夹具（假 transport / 假 watchFactory）。
