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
  - **gist 通道完全不做条件写**（issue #110，2026-10 实测，推翻本条的早期假设）：早期实现以为「弱 ETag 不能用、
    强 ETag 可以用」，于是 `conditionalPatchHeaders()` 在拿到强 ETag 时注入 `If-Match`。实测（临时 secret gist，
    `gh auth token` + curl）：
    - `PATCH /gists/{id}` 带 `If-Match: "<strong etag>"` → **400**，
      `{"message":"Bad Request","errors":["Conditional request headers are not allowed in unsafe requests unless supported by the endpoint"]}`；
    - 同一 PATCH 去掉 `If-Match` → **200**；随后 `DELETE`（无条件头）→ **204**。

    ⇒ 该端点**不接受任何条件请求头**，与强弱无关；用户侧表现是首次推送就 400、配置完全写不上去。
    现在 gist 的 `upload` / `delete` 恒不带条件头，代价是**失去写前并发保护**（个人配置同步到自己的 secret gist
    这一场景可接受）；412 分支与 `sync.gist.concurrentWrite` 文案一并移除。回归测试：
    `src/sync/gist/gist-conditional-write.test.ts`（强/弱 ETag 与删除路径都断言「零条件头」）。
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


## S3 兼容系签名：OSS4 授权头必须照官方 SDK 逐字序列化（issue #109，2026-10）

- **用户侧表现**：阿里云 OSS（`provider: 'oss'`，签名方言 `oss4`）配置填完、点同步即失败，报
  `GET https://<bucket>.oss-cn-hangzhou.aliyuncs.com/<prefix>/index.json 失败 (HTTP 400): InvalidArgument - Authorization header value is empty.`，
  响应 XML 里回显的授权头与我们拼出的串逐字一致（含空格与空的 `AdditionalHeaders=`）。
- **根因**：`src/sync/s3/sigv4.ts` 的授权头装配曾套用 AWS 风格：
  `OSS4-HMAC-SHA256 Credential=<ak>/<scope>, AdditionalHeaders=, Signature=<sig>` —— **逗号后带空格**、**空头清单也照写**。
  阿里云官方 SDK（Go `oss/signer/v4.go`、PHP `src/Signer/SignerV4.php`，2026-10 读码确证）的格式是：
  - 逗号后**不带空格**；
  - `AdditionalHeaders` **非空时才写**（`,AdditionalHeaders=<头名;头名>`），为空时**整段省略**。
- **实证（不需要真凭据）**：对真实端点 `https://oss-cn-hangzhou.aliyuncs.com/` 发两个只差授权头格式的假 AK 请求：
  - 我们那串（空格 + 空 `AdditionalHeaders`）→ `400 InvalidArgument / Authorization header value is empty.`（EC `0002-00000209`）；
  - 官方格式（紧凑逗号、省略空 `AdditionalHeaders`）→ `403 InvalidAccessKeyId` —— **已进入鉴权**，说明格式被接受。
  ⇒ 400 与「签名算错」无关，纯粹是授权头**解析**失败（错误码文档把该 EC 归到 Authorization 格式错误）。
- **修法**：`signRequest()` 按方言分两套序列化 —— AWS 保持 `, SignedHeaders=…, Signature=…`（带空格），
  OSS4 走紧凑格式且空清单省略。**规范化请求不变**（与 SDK 逐行对齐：OSS4 的 CanonicalHeaders 只含
  `content-type`/`content-md5`/`x-oss-*`；规范化请求在头块之后多一行 AdditionalHeaders、载荷取 `UNSIGNED-PAYLOAD`；
  派生密钥 `aliyun_v4`→date→region→oss→`aliyun_v4_request`）。
- **回归测试**：`src/sync/s3/sigv4.test.ts`（OSS4 授权头正则 + 断言不含 `', '`、不含空的 `AdditionalHeaders=`）、
  `src/sync/s3/s3-transport.test.ts`（通道层同一断言）。
- **未做**：本机无阿里云 AK/SK，端到端仍待报告者复测。

## OSS4 规范请求：规范 URI 恒含 bucket、空值查询参数写裸键（issue #109 第二轮，2026-10）

- **现象**：v0.1.80 只改了授权头格式后，报告者在 v0.1.81 复测仍是失败，但错误从 `InvalidArgument / Authorization header value is empty.` 变成
  `SignatureDoesNotMatch`（`The request signature we calculated does not match the signature you provided.`），**且只在未勾选 path-style 时复现**。
- **根因一（决定性）**：阿里云 OSS4 的规范 URI 是 `/<bucket>/<object>`，**与 URL 寻址风格无关**（官方 Go SDK `conn.go` 的 `getResourceV4()` 恒拼 `"/"+bucket`）。
  虚拟主机风格（`https://<bucket>.oss-cn-hangzhou.aliyuncs.com/<prefix>/index.json`）下 `url.pathname` 只有 `/<prefix>/index.json`，
  缺 bucket ⇒ 规范请求哈希不同 ⇒ 签名不匹配。勾 path-style 时 path 里恰好带 bucket，所以能对上 —— 这就是「只有一种配置能连」的原因。
- **根因二（次要）**：空值查询参数官方只写**裸键**（`acl`，见 `getSubResource()`），我们写成 `acl=`；键值先 `QueryEscape` 再按键排序。
- **实证**：把官方 Go 测试的**金标向量**搬成单测（`oss/conn_test.go` 的 `TestAuthV4Header` / `TestAuthV4HeaderWithAdditionalHeaders`，AK=ak/SK=sk/region=cn-hangzhou），
  两条期望签名 `e21d18da…4afe` / `4a4183c1…212f` **逐字符相同**；向量里还覆盖 `+`/`|` 前缀参数、空值参数与 `AdditionalHeaders=abc;zabc` 形态。
- **修法**：`sigv4.ts` 的 `SigV4Dialect` 增 `emptyQueryValue: 'equals' | 'bare'`，`SigV4RequestInput` 增可选 `canonicalPath`；
  `s3-providers.ts` 新增 `canonicalObjectPath(target, key)`（= endpoint 基路径 + `/<bucket>` + 转义后的 key，两种寻址风格同源），
  `s3-transport.ts` 只在 `dialect.id === 'oss4'` 时传入。AWS 系不传（其规范 URI 就是请求路径）。
- **判据（别退回）**：**OSSSigV4 的规范 URI 带 bucket 这件事与寻址风格无关**，别用 `url.pathname` 直接当规范路径；空值参数写法随方言走，不能一套通吃。
- **自证方式（不必等报告者复测）**：签名正确性有两道独立证据 ——
  ① **金标向量**（上述两条官方 Go 测试的期望签名逐字相同）证明「我们的算法 = 官方算法」；
  ② **服务端视角验签**（`src/sync/s3/oss4-verify.ts`，照官方 `conn.go`/`auth.go` **独立重写**的服务端：只吃收到的 method/url/头/body，
  自己判寻址风格、自己重建规范请求、验不过就按 OSS 真实错误回 403 + 回显 StringToSign/CanonicalRequest）证明「发出去的每个请求都能被重建出来并验过」。
  `src/sync/s3/s3-transport.oss4-server.test.ts` 把 `S3Transport` 的真实出站请求（**不勾 path-style**，即现场失败的那条）逐个喂给它，
  覆盖探桶 → PUT 索引/快照（含条件写头）→ 列表 → 下载逐值比对 → 删除 → 再列表，共 14 个请求零验签失败。
  ③ **真桶联调脚本** `scripts/oss-live-check.mjs`（`npm run oss:check`）：默认**本地模式**用同一验签器起 `node:http` 服务端、走真实网络栈与真实出站实现
  （能抓到注入 mock 看不到的头大小写/Host/追加头差异），不需密钥、不碰任何桶；`--live` 才连真桶（读操作默认、写操作要 `--write`），
  密钥只从 `OSS_ACCESS_KEY_ID`/`OSS_ACCESS_KEY_SECRET` 环境变量读，不落盘不打印。真桶那次才是阿里云服务端盖章，其余两者保证「算法与报文形状」。
- **教训**：客户端单测只能覆盖「我算得对」，覆盖不到「服务端会怎么理解我发的东西」。凡是签名/协议类问题，**把服务端校验独立实现一遍**（不共用客户端中间量）
  才是能自证的最小闭环；能起本地服务就走真实网络栈，不要只喂内存对象。

## 加密快照也落密文祖先副本（issue #107，2026-10）

- **用户侧表现**：开启「加密快照」后每轮合并都退化成两方比较，界面 `previewMerge().hasAncestor === false`，
  合法改动被判冲突、被迫反复人工裁决（每轮都要点一遍）。
- **根因**：push 成功后 `recordBaseline` 曾以 `writeAncestor: !encrypted` 跳过祖先副本写盘，`state.ancestorId`
  因此被清空；而祖先目录 `src/sync/ancestor.ts` 只认明文布局（`writeSnapshotToDir`/`readSnapshotFromDir` 散文件），
  根本没有存密文副本的形态。
- **修法（方案 A：加密祖先副本）**：
  - `writeEncryptedAncestor()` 写的目录里只有 `manifest.json`（`manifest.encrypted === true`、`sectionHashes` 空）
    与单文件 `sections.encrypted.json`（密文载荷）；`readAncestorSnapshot()` 按 `manifest.encrypted` 分流，
    密文先过 `isEncryptedSections` 校验；`loadAncestor`/`tryLoadAncestor` 共用这一入口。
  - push 成功后 `recordBaseline(..., { ancestorPassword: opts.password })`；`recordBaseline` 的 `sections` 参数
    收窄为**明文**（基线 hash 恒按明文算），只在写盘时加密。
  - merge：祖先为密文时用**本次请求的密码**解密；密码缺失/不匹配/载荷损坏一律回落 `undefined`
    （沿用 P0-7「祖先读不出就两方合并」契约，**绝不抛错打断合并**）。
  - `applyMergePlan` / `applyMergeResolutions` 透传 `ancestorPassword`（仅当本次远端快照加密且拿到了密码）。
- **第二条落地路径同样只落密文（issue #107 补漏，2026-10-22 独立复核发现）**：`applyItems`（pull / 一键同步落地）
  原先把 `recordBaseline` 的 `writeAncestor` 留在缺省值 ⇒ 加密快照走这条路时祖先副本仍是**明文散文件**。
  现在 `preview()` 先把「远端快照本身是否加密」记成 `SyncPreviewResult.encrypted`，同步会话只存这个**布尔**
  （绝不存密码）；`/sync/apply-items` 按「请求体 > 已存凭据」取密码（客户端此时手里没有密码：一键同步前已落库、
  请求后立刻清空内存），有密码传 `ancestorPassword`（写密文副本），没密码传 `suppressAncestor: true`
  （`writeAncestor: false`，`ancestorId` 置 ''），**宁可不留基线也绝不落明文**。
- **回归测试（补漏那条）**：`src/sync/sync-engine.test.ts`「issue #107 补漏: applyItems 带 ancestorPassword → 祖先副本落密文；
  suppressAncestor → 不落副本」，以及源码守卫「issue #107 源码守卫：/sync/apply-items 的祖先副本按会话加密标记决定
  「密文 / 不落」」（防止路由接线被改回去）。
- **不做**：`src/sync/layout.ts` 里「加密快照不写散文件目录」的结构性拒绝保持不变（git 通道依赖它）；
  自动同步路径本就不涉及加密快照，不需要额外密码来源。
- **回归测试**：`src/sync/sync-engine.test.ts`「P0-7 + issue #107: 加密快照 push 落密文祖先副本 →
  无密码时降级两方合并、带密码恢复三方合并」（断言祖先目录只有两个文件、载荷不含明文、带密码时判 `useRemote`）。
- **未验证**：没有真实远端两机端到端跑过（本机单测覆盖 push → `previewMerge()` 全链）。
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


## 并发驱动同一个同步工作副本 → `git pull` 自己 fatal → durable SAFE MODE

**规则判据（已回写 `AGENTS.md`）**：同一个 `sync/work` 上的 git 操作必须串行；拉取只能用
「显式 refspec `fetch` + `merge --ff-only origin/<branch>`」，**禁止回到 `git pull --ff-only`**。

**真机形态（2026-10-23，issue #112 现场）**：环境 → 维护与诊断 一直停在「已进入安全模式」，
incident 行 = `autosync-push / 需要人工处理`，而 `transactions/active/*.json` 的 `error` 是**空串**
（面板因此只显示「需要人工处理」，没有任何原因）；`sync/sync-autosync.json` 的
`lastRunMessage` = `git pull 失败: fatal: Cannot fast-forward to multiple branches.`。
同一 `~/.dsh/dsh-config-manager/running/` 下同时有 desktop(24252) 与 web(2320) 两个实例，
`sync/work/.git/FETCH_HEAD` 里有**两行 SHA 完全相同**的 for-merge 记录（手工 `git pull --ff-only` 成功、
只剩一行）。

**根因（已复现，非推断）**：拉取走的是 `git pull --ff-only` = 「fetch 写 `FETCH_HEAD` + 读 `FETCH_HEAD` 合并」两步。
并发时 `FETCH_HEAD` 被写成多行 for-merge；`git pull` 的 ff-only 前置检查看到多个 for-merge head，
直接 `die("Cannot fast-forward to multiple branches.")`（exit 128）。
复现实验（`.tmp/ffrepro`，本地 bare 远端 + 5 个进程同时 `git pull --ff-only`）：
5/5 全部 exit 128 且同一条 fatal，`FETCH_HEAD` 留下 5 行相同 SHA；顺序 pull（1/2/3 次）恒为 1 行
⇒ 是并发写坏，不是累积。同一实验里 `git fetch -q origin +refs/heads/main:refs/remotes/origin/main`
+ `git merge --ff-only -q origin/main` 在 5 并发下 **5/5 成功**、无 fatal（不读 `FETCH_HEAD` 就绕开污染面）。

**是谁在并发**（代码事实）：
- 自动同步整轮持 `withMutationLock`，但 `POST /sync/snapshots-list`（以及 `/sync/pull`、
  `/sync/download`、`/sync/sync`、`/sync/merge-preview`）**不带任何锁**，各自 `makeSyncEngine()`
  后直接 `transport.list()`/`download()` → `pullFromRemote()`；GUI 打开或刷新同步页就会触发。
- 多开 DSH 实例共用同一 `sync/work`：跨进程的 `GLOBAL` 锁只覆盖自动同步，覆盖不到上面的只读路由。
- 并发 `add/commit` 还会撞 `index.lock` —— 同一类「莫名其妙的失败」，同样会落进 SAFE MODE。

**为什么一次 git 报错会被放大成「锁死全部配置写入」**：`engine.push()` 在 Phase C 里被
`runExternalIntent({operationType:'autosync-push'})` 包住；`src/core/phase3-host.ts` 的 catch 分支
**无条件** `writeSafeMode(true)` 并把 journal 推到 `NEEDS_ATTENTION`；
`resolveSafeModeMarker` 对 active 里任何非终态/NEEDS_ATTENTION **fail-closed** ⇒ durable SAFE MODE，
用户所有会改配置的操作被阻断，只能人工处理。

**修复（本次）**：
1. `src/sync/git/workdir-lock.ts`：工作副本级互斥锁 = `os.tmpdir()` 下按目录绝对路径哈希命名的
   `open('wx')` 文件锁（不写进工作副本：clone 前也能先锁住、不脏 `git status`）+ 进程内 Promise 链
   + 陈旧锁按 mtime 回收（缺省 15 min；等待上限缺省 5 min）。
2. `GitTransport` 加 `private withWorkdir()`（`workdirLockDepth` 可重入），包住
   `list/upload/download/delete/inspectWorkDir/rebuildWorkDir` 六个工作副本入口；
   `ensureRepo/pullFromRemote/adoptRemoteHistory` 假定已持锁（避免嵌套死锁）。
3. `pullFromRemote` 改为显式 `fetch origin +refs/heads/<b>:refs/remotes/origin/<b>` +
   `merge --ff-only origin/<b>`；detached HEAD、远端无同名分支（`couldn't find remote ref`）静默跳过，
   SSH 主机密钥 / 历史分叉 / 网络分类逻辑逐条沿用。
4. `runExternalIntent` 的 NEEDS_ATTENTION 分支补写 `journal.error`（过 `redactJournalText`）——
   面板的 `reason` 是 `j.error || j.recovery.reason`，此前恒为空。

**证据 / 实测**：
- `src/sync/git/workdir-lock.test.ts`（6 项）：同目录并发串行（maxActive=1）、不同目录并行、等锁超时抛
  `WorkdirLockError` 且**不删别人的锁**、陈旧锁回收、fn 抛错后锁必释放、`path.resolve` 归一后共用一把锁。
- `src/sync/git/git-transport.test.ts` 新增 3 项：命令序列里**不再出现 `pull`**（显式 fetch + merge）、
  远端无同名分支静默跳过且不 merge、两个 transport 实例共享同一 workDir 时 git 调用 `maxActive=1`。
- 全量 `npm test`：5129 项、fail 0；`npm run typecheck` 0 错。

**未覆盖**：`market` 通道（`src/market/reader.ts`、`src/market/git-file-writer.ts`）仍用
`git pull --ff-only` 驱动自己的市场工作副本 —— 同一类并发风险存在，但它不经过 intent journal，
失败不会升级成 SAFE MODE，故本次未改（要一并修就复用 `withWorkdirLock` + 同样的 fetch/merge 写法）。
