# 同步通道（分区放行与会话管理） — 经验与证据存档

> 本文件是**经验/证据**：真机事故、量化数据、复现与复核脚本；**规则本体在 `AGENTS.md`**（对应小节读取）。
> 条目结构：每个 `###` 是原 `AGENTS.md` 的一条完整条目（逐字搬迁，未改写）。域 → 规则 的对应表见 `docs/evidence/README.md`。

## 同步分区目录含显式可选项（issue #78 起是「逐分区放行」而不是布尔）

- **同步分区目录含显式可选项（issue #78 起是「逐分区放行」而不是布尔）**：`syncSectionCatalog` = portable + `OPT_IN_SYNC_SECTIONS`（**注册表派生** = `SectionMeta.syncOptIn !== 'off'`，当前 `mcp` / `workspaces` / `sessions`）。可选分区**永不默认进入同步通道**，放行只看引擎构造期的 `optInSections: readonly SectionId[]`（`pullSectionIds()` 决定远端快照里哪些分区进临时 ZIP；`pushTargets()` 决定哪些能上榜）——**绝不用布尔**：布尔会退化成「勾了 mcp 连带放行 sessions」（`sync-engine.test.ts` 有推/拉两条回归）。宿主按驱动方决定传什么：**手动** push/pull / 一键同步传「持久化选择 ∩ OPT_IN_SYNC_SECTIONS」，**自动同步**与 model-tools 只传 `'auto'` 档（`AUTO_SYNC_OPT_IN_SECTIONS`，当前 = mcp）—— sessions（`'manual'`）绝不悄悄上行/下行。`opts.sessions = { limit }` 只是 sessions 的**导出参数**（带哪几个对话），不再兼任开关。

## workspaces 为什么是「手动可选分区」而不是固定可选/自动（issue #127）

- **现象**：A 机推送时勾了「工作区」，B 机一键同步后会话写进去了，但工作区列表里一条都看不到、目标目录也没建。
- **机制**：DSH 把会话显示在工作区里靠「首帧 cwd 的 realpath == `workspace.path` 且会话 id 在该记录的 `sessionIds` 里」（`src/adapters/sessions.ts` 的可见性判据）；而这条挂接只在导入计划的 workspaces 分区**有执行项**时才发生 —— `analyzer` 对零计划项的 adapter 直接跳过 `finalizeImport`（`src/core/analyzer.ts:1099-1124`），`workspaces.finalizeImport` 又是唯一登记会话的地方（`src/adapters/workspaces.ts:246-265`）。改造前 workspaces 是 `syncOptIn='off'`（platformSpecific）→ 同步弹窗里压根没有勾选项、同步引擎三处闸门（`syncSectionCatalog` / 保存选择校验 / `pullSectionIds`+`pushTargets`）都不放行 ⇒ 「勾了会话」本身就是一句做不到的承诺（弹窗里那条 `mode.sessionsWorkspaceWarn` 文案正是为此写的，但它建议勾的东西不存在）。
- **结论**：workspaces 改 `syncOptIn='manual'`。仍然**不进自动同步**（路径与本机绑定，自动落盘会跨机瞎建目录），但手动一键同步/预览差异时必须能整分区勾选；档位口径与 mcp/sessions 一致，靠 `optInSections` 逐分区放行。
- **三条配套（缺一条就还是「会话不显示」）**：
  ① **apply 阶段伴随**：`SyncEngine.applyMergePlan` 只应用 sessions 时，把「本机现值 ∪ 远端（或本次 merged）记录」按记录级合并成一份 workspaces 载荷塞进临时 ZIP，并把 `workspaces` 计入 `appliedIds`（否则基线不记它，下一轮又当成新变化）。缺这一步 = 用户只确认「会话」那一行时，`finalizeImport` 永不触发。
  ② **合并必须取并集**：workspaces 的 `sessionIds` 两侧各自增长，通用 JSON 合并对数组一律判冲突（`src/sync/merge.ts` 文件头「数组绝不按索引合并」），且裁决任一侧都会丢掉另一侧的会话归属 → `src/sync/workspace-merge.ts` 按记录 id 做三方合并（sessionIds 并集、其它字段单侧取值/双侧冲突），并且**在 ancestor 闸门之前**调用（首轮两方同步也要能并集）。
  ③ **跨机路径**：`analyzeImport` 对绝对路径恒产出一条 `PathMapping` 计划项、`applyItem` 对可安全创建的路径调 `ensureDir` 建目录（issue #45 既有实现，本票不改）。
- **回归**：`src/sync/workspace-merge.test.ts`（并集/去重/单侧改/双侧冲突/删除语义/畸形形状）+ `sync-engine.test.ts` 的 issue #127 三例（未放行跳过可见、放行后 push 带上、拉取并集、apply 伴随落地）。

## 同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地）

> 对外格式见 `docs/contracts/sync-channel-v1.md`。

- **同步通道的「会话管理」五条语义（m-sync-management，2026-09 落地；对外格式见 `docs/contracts/sync-channel-v1.md`）**：
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
1. `src/utils/workdir-lock.ts`（原在 `src/sync/git/`，market 也要用 ⇒ 移入 `src/utils/`，锁名 `dshcm-workdir-<hash>.lock`）：工作副本级互斥锁 = `os.tmpdir()` 下按目录绝对路径哈希命名的
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
5. `market` 通道同口径：`src/market/reader.ts` 的 `ensureRepo` 与 `src/market/git-file-writer.ts` 的
   `writeFiles` 各自整段包进 `withWorkdirLock`（writer 内层 `ensureRepo` **由调用方持锁、不再取锁**，
   否则同进程自锁），拉取同样换成显式 `fetch` + `merge --ff-only`；这套参数抽成唯一实现
   `src/utils/git-fast-forward.ts`（`fastForwardFetchArgs`/`fastForwardMergeArgs`/
   `isMissingRemoteRefError`/`parseCurrentBranch`），sync 与 market 共用。

**证据 / 实测**：
- `src/utils/workdir-lock.test.ts`（6 项）：同目录并发串行（maxActive=1）、不同目录并行、等锁超时抛
  `WorkdirLockError` 且**不删别人的锁**、陈旧锁回收、fn 抛错后锁必释放、`path.resolve` 归一后共用一把锁。
- `src/sync/git/git-transport.test.ts` 新增 3 项：命令序列里**不再出现 `pull`**（显式 fetch + merge）、
  远端无同名分支静默跳过且不 merge、两个 transport 实例共享同一 workDir 时 git 调用 `maxActive=1`。
- 全量 `npm test`：5136 项（pass 5134 / skipped 2）、fail 0；`npm run typecheck` 0 错。

**market 通道同样受影响（本次一并修）**：`src/market/reader.ts` / `src/market/git-file-writer.ts` 驱动
自己的市场工作副本，原先也是 `git pull --ff-only`；它不经过 intent journal，失败不会升级成 SAFE MODE，
但会直接表现为「市场打不开 / 上传失败」。现在两条路径共用**同一把**工作副本锁与**同一套** fetch/merge 参数：
- `src/utils/git-fast-forward.test.ts`（5 项）：fetch/merge 参数逐字、带斜杠分支名、两种 missing-ref 措辞、
  detached HEAD 解析为空串。
- `src/market/market.test.ts` 新增「reader：并发读取同一个工作副本 → git 调用不重叠」（3 个并发 `readIndex`，
  `maxActive=1`）；`src/market/git-file-writer.test.ts` 新增「并发写入同一个工作副本 → git 调用不重叠」并把旧
  「已存在工作副本 → pull --ff-only」用例改成「显式 fetch + merge、断言全程不出现 `pull`、不读 `FETCH_HEAD`」。

## 自动同步「每分钟都推一次」：运行态混进分区 hash（issue #127，2026-10-25 真机）

**规则判据（已回写 `AGENTS.md` §6）**：`hasLocalChanges` 比的是 `hashSection(export())` ⇒ 子类在比对里
剔除的易变字段必须**同时**从导出载荷剔除；身份字节只有 `file-collection.ts` 的 `comparableContent()` 一处。

**现场**：同步页「最近活动」每 ~60s 一条「自动同步 push (git) 成功」，用户什么都没改；
`~/.dsh/dsh-config-manager/sync/sync-history.json` 共 200 条，2026-10-25 当天 43 条（41 条 success/push，
每条不同 `pushedSnapshotId`），间隔 56–76s；工作副本 `sync/work` 的 `git log` 640 条
（325「sync: add snapshot」+315「sync: delete snapshot」）。

**60s 本身是设计行为**：`src/sync/autosync-scheduler.ts` 的 `scheduleRemoteTimers()` 按 `remoteCheckMs`
（缺省 60000）触发 `trigger(channel, "remote-poll")` —— 那是**远端探测**节奏，不是推送节奏；
`runOnceInternal()` 只有在 `detectRemoteNew || detectLocalChange` 时才进 Phase A/C。真问题在 `detectLocalChange`。

**根因（快照 diff 实证，非推断）**：`SyncEngine.hasLocalChanges()` → `defaultDetectLocalChange()` 对每个
portable 分区 `export()` 后与 `sync-state.sections` 基线比 `hashSection()`；文件类分区的 `hashSection`
（`src/sync/sync-state.ts:128`）按 `relativePath + 分隔符 + sha256(f.data)` 聚合 ⇒ **导出载荷的原始字节**
直接进哈希。而 `self` 分区白名单里的 `sync/sync-autosync.json`、`sync/backup-schedule.json` 由调度器
在每轮收尾 `writeFinalConfig()` 改写 `lastRunAt/lastRunStatus/lastRunMessage/lastRunHistoryId/consecutiveFailures`；
`SelfAdapter.comparableContent()` 只把这批字段从**导入比对**里剔掉（issue #73），载荷没动 ⇒
self 分区 hash 每轮都变 ⇒ 永远 dirty ⇒ 每次远端轮询都真推一个只差 `lastRunAt` 的快照。

证据：相邻两个快照目录（`sync/work/snapshots/sync-*`）共 33 个文件，逐文件 sha256 只有 2 个不同 ——
`manifest.json` 与 `self/sync/sync-autosync.json`（后者只差一个 `lastRunAt`）；manifest 的 `sectionHashes`
每轮只有 `self` 一项变化。`watch-scope.ts` 只在文件监听侧排除了自写回声路径，救不到哈希侧。

**修复**：`FileCollectionAdapter.collect()` 在内容模式下把 `comparableContent(relPath, bytes)` 的结果（「身份字节」）
同时用于 `entry.data` 与 `contentHash`（缺省实现返回同一引用 ⇒ 其余分区字节/哈希逐字节不变）。
效果：运行态只留在本机文件里，不进导出载荷、不进基线；`lastRunAt` 也不再有跨机倒灌路径。

**验证**：`src/adapters/self.test.ts` 新增回归（同一份 `sync-autosync.json` 只推进运行态 → 两次 `export()`
的 `hashSection` 相等；载荷不含 `lastRunAt`/`consecutiveFailures`；改 `repoUrl` → hash 必变）。
`node --test "src/adapters/*.test.ts" "src/sync/*.test.ts"` 720 项全绿；`npm run typecheck` 零错。

**未做**：远端仓库里已积累的 ~325 个「只差 lastRunAt」的历史快照没有自动清理（留给用户决定）；
本次修复需要重建 `lib/` 并重启 DSH 才在真机生效。


## 只读端点也会无界挂起：`/sync/status` 300 秒不回 ⇒ 首页永久骨架（2026-10 真机）

**规则判据（已回写 `AGENTS.md` §1）**：只读端点同样必须「有界返回」—— 碰不可控依赖（DSH credentials
服务、子进程/工作副本自检、外部 HTTP）的取值体一律套总预算并给明确错误码；客户端首屏**不得**让单一慢
请求垄断骨架。判据 = 「这个 await 最长能挂多久」这个问题必须有答案，答案不能是「不知道」。

**现场**：profile=`desktop` 打开插件首页，状态条四段与「最近活动」全是骨架、「加载中…」十余分钟不动
（用户报「首页一直在加载」）。实测 `GET /api/dsh-config-manager/sync/status` **300 秒零响应字节**
（`curl -m 300` → `code=000`，耗时 300.004 s）；同机其余只读端点全在毫秒级：status 0.024 s /
snapshots 0.007 s / backup-files 0.004 s / backup-schedule 0.002 s / history 0.39 s / disk-usage 0.8 s。

**已排除的假设**：git 与锁 —— 探测期间无 `git.exe` 子进程，`/tmp` 无 `sync/work` 的 workdir 锁
（lockKey `8c5748b567c9570910e1729df1b3b5cf`，只有 `dsh-git-test-*` 陈旧锁）；网络 —— 同机
`git ls-remote origin` 在 `sync/work` 下 **2.07 s** 返回 `12d6d5b1…refs/heads/main`。

**症状为何是「整页」而不是「一段」**：旧 `HomePanel.loadFast` 用
`Promise.allSettled([listBackupFiles, snapshots, backupSchedule, syncApi.status(), historyApi.list])`，
全部 settle 才 `setLoading(false)`；而 `syncApi.status()` 走 `SYNC_OPTS`（`timeoutMs =
LONG_REQUEST_TIMEOUT_MS = 5 min`）⇒ 一个点挂住 = 整页骨架 5 分钟，且失败被吞成 `null`
（`overviewHealth` 对 null 不降级 ⇒ 界面上看不出任何异常）。

**修复两半**（缺一不可）：
1. 服务端：`src/routes/sync.ts` 把 handler 取值体抽成 `collectSyncStatus()`，用
   `withTimeout(collectSyncStatus(), SYNC_STATUS_BUDGET_MS = 10_000, msg('host.syncStatusTimeout'))` 包住；
   预算耗尽 → **503**，其余异常仍 500。这是**对任何挂起形态都成立**的围栏 —— 挂在哪一层无法在宿主
   进程内取证（没有 JS 栈可抓），所以修复不能依赖定位到具体那个 await。
2. 客户端：同步状态移出首屏关键路径，独立 30 秒档（`HOME_SYNC_TIMEOUT_MS`）加载，自带
   `loading | ready | failed` 三态；失败时该指标段显示「读取超时」（`overview.meta.syncUnavailable`），
   不留空冒充「未配置」（诚实性硬约束：用户看到「未配置」会去重配一个本来配好的通道）。骨架按段判定
   （`segLoading(seg.key)`），其余四段只看首屏快请求。

**验证**：`npx tsc --noEmit` 零错；`npm test` 5145 pass（唯一红是 locales 体量棘轮 +2，已按
`tests/file-size-ratchet.test.ts` 的规则上调并登记 tech-debt #22）；`npm run build` ✔；
`node --test src/client/bundle-selfcontained.test.ts` ✔；新守卫 `tests/home-load-availability.test.ts`
（L-01 不得退回 `Promise.allSettled` / 不得退回无参 `status()`；L-02 三态与「读取超时」文案；L-03 服务端
预算与 503 判定）钉住两半，防「顺手把 sync 加回首屏」。

**未做/未知**：究竟是哪个 await 永不返回，宿主进程内没有取到栈证据（最可疑是 DSH credentials 服务：
`sync.ts` 里 5 处 `credentials.describe`，且 `cloudChannelViews`/`selectionViewByChannel`/
`syncCredentialsByChannelView` 内部各再调一次）；本次修复不依赖定位到它。真机是否因此恢复健康，
需要重建 `lib/` 并重启 DSH 后由用户确认。


## 死进程残留的工作副本锁把 `/sync/status` 拖成 10 s 超时（2026-10-27 真机，第三轮）

**规则判据（已回写 `AGENTS.md` §1）**：只读端点的「有界返回」必须**覆盖锁等待**。工作副本锁的等待上限
（缺省 300 s）是给写操作定的，只读自检不能继承；同时锁的回收不能只看 mtime —— holder 被强杀后
`finally` 不会执行，只按 mtime 判陈旧要白等满 15 分钟。

**现场**：用户报「远程同步加载太慢」。实测 `GET /api/dsh-config-manager/sync/status` 每次 **10055–10106 ms**
后 503（body = `host.syncStatusTimeout` 文案），`?detail=0` 同样 10 s；同机 `/sync/history` 7 ms（62 KB）、
`/market/status` 24 ms。

**逐层排除（每层都有独立实测）**：

- **接口预算本身**：`collectSyncStatus` 已被 `withTimeout(…, 10_000)` 包住，超时确实是「预算耗尽」而不是别的错。
- **凭据服务**：同脚本直接跑 `readFullSyncConfig` 2.8/1.4 ms、`loadSyncState` 1.3/0.6 ms、`readUiPrefs` 0.5 ms、
  `readAllSyncSelections` 0.6 ms、`readAllAutosyncConfigs` 0.5 ms、`listCloudConfiguredProviders` 0.1–0.2 ms。
- **工作副本自检**：同一脚本 `inspectWorkDir({detail:false})` 与 `{detail:true}` 都 HANG（>20 s 未返回）——
  唯一挂点，且与 detail 无关 ⇒ 不是 git 命令慢，而是取锁慢。
- **锁现场**：`%TEMP%` 下的 `dshcm-workdir-c1827469....lock` 记 `pid:28888`，`Get-CimInstance` 查无该进程；
  锁创建 22:25:15Z，新宿主进程 23:25:19 启动 ⇒ 旧实例重启前 4 秒拿锁后被杀、`finally` 未执行。
  另有 8 个历史锁残留（age 14621 s ~ 296752 s，最长 3.4 天）。

**根因链**：死锁 → `inspectWorkDir` → `withWorkdir` → `withWorkdirLock`（缺省等待 300 s，且只按 mtime 回收）⇒
`collectSyncStatus` 最后一步永不完结 ⇒ 10 s 预算耗尽 ⇒ 503。**正常同步持锁时同样命中**（autosync 每 1–2 分钟
一次 push），所以这不是「偶发」。清掉死锁后端点立刻恢复：首次 735 ms（冷缓存 7 条 git 命令）、之后 50 ms。

**修复三处**（缺一处就还会复发）：

1. `src/utils/workdir-lock.ts` 的 `workdirLockHolderAlive(pid)`：`process.kill(pid, 0)`，`ESRCH` = 确定已死 ⇒
   立即回收；`EPERM` = 存活；其余（含读不出 holder）= 判不了 ⇒ 退回 mtime 规则（钉死「绝不盲抢」）。
2. 等待变成**硬上界**：等锁与进程内链上排队共用同一个 `timeoutMs`（对链头 `Promise.race` + 入口过期检查），
   被放弃的调用轮到时直接抛、**不执行 fn** —— 否则界面早已超时，底层还会偷偷去驱动工作副本。
3. 只读自检单独用 1.5 s 上限（`INSPECT_WORKDIR_LOCK_TIMEOUT_MS`），写路径仍用 300 s（该等）；拿不到锁 →
   `sync.git.workdirBusy`（`kind:'conflict'`、`retryable`），经宿主既有 `{ error }` 通道回到界面。
   另加一次性清扫 `pruneDeadWorkdirLocksOnce()`：只删「pid 确定已死」或「pid 被复用 + 声明的工作目录已不存在
   + 已过 staleMs」的残留锁（本机实测一条测试残留锁的 pid 9704 已被 `NoiseCancelingEngine.exe` 复用）。

**验证**：`node --test src/utils/workdir-lock.test.ts` 10 pass（新增：死 pid 立即回收 / 链上排队计入超时且不执行 fn /
一次性清扫只清死锁）；`node --test src/sync/git/git-transport.test.ts` 53 pass（新增：活锁持有时 1793 ms 返回
`workdirBusy`、零 git spawn）；`npm run typecheck` 零错；现场清死锁后 `GET /sync/status` 200（735 ms → 50 ms）。

**未做/未知**：改动在 `src/`，运行中的 DSH 加载的是已安装的 `lib/` —— 需重建并重装插件后，「重启踩在同步中」
这条路径才真正受保护；单测与端点实测只覆盖代码本身，未覆盖「装到桌面实例后重启」的现场。

## `/sync/status` 的 730 ms 从哪来：7 次 `git.exe` 进程启动（2026-10-27 实测）

**规则判据（已回写 `AGENTS.md` §1）**：只读端点也别在 GET 里 spawn 外部进程；**同一事实被反复索取**
（首页 / 切页 / 轮询）要「按需 detail + 短 TTL 缓存」，别让每次请求都重新付一遍进程创建的钱。

**现象**：修完上一节的「无界挂起」之后，同机实测 `GET /sync/status` 仍要 **0.73–0.77 s**，比同级只读端点
慢两个数量级：`/status` 5 ms、`/sync/autosync` 1–2 ms、`/sync/history` 8 ms（它们都不 spawn 外部进程）。

**归因（逐条实测，cwd = `~/.dsh/dsh-config-manager/sync/work`）**：

| 命令（detail 自检） | 耗时 | 输出 |
|---|---|---|
| `git remote get-url origin` | 89 ms | 地址 |
| `git remote get-url --push origin` | 77 ms | 地址 |
| `git rev-list --count HEAD --not --remotes` | 84 ms | 2 B |
| `git status --porcelain` | 99 ms | **0 B**（工作副本干净） |
| `git rev-parse --abbrev-ref HEAD` | 80 ms | main |
| `git ls-tree --name-only origin/main:snapshots` | 79 ms | 462 B |
| `git ls-tree --name-only origin/main:snapshots-encrypted` | 78 ms | exit 128（目录不存在） |
| **合计** | **585 ms** | |

本地直调 `new GitTransport(...).inspectWorkDir({ detail: true })` = **693–732 ms**（构造 0 ms），与 HTTP 端点
730–774 ms 只差 30–40 ms（HTTP 层）⇒ **耗时 100% 落在自检里**，与仓库大小、输出内容、命令成败都无关 ——
Windows 上每次进程创建固定 ~77–99 ms。

**已排除**：`readFullSyncConfig` 0.18–1.17 ms、`loadSyncState` 0.04–0.33 ms、`readAllSyncSelections`
0.05–0.22 ms、`listCloudConfiguredProviders` 0.04–0.15 ms、读 `.credentials.yaml` 0.12–0.58 ms；
凭据 `describe` 是**纯内存**（`dsh-credentials-local` 只查 `Map.get` + 启动环境表 `Map.get`）。

**修法（两条，一起上）**：
1. **按需 detail**：`GET /sync/status?detail=0` 跳过 ahead / dirty / remoteSnapshots 那 5 条命令（7 → 2 条）。
   只有同步页的 `WorkDirCard` 渲染这三项；首页与产物库只要「工作副本是否跟随配置地址」。缺省仍是完整自检
   （老调用方零改动），宿主 `inspectWorkDir({ detail: opts.detail !== false })` 保证漏传参数不会悄悄丢字段。
2. **10 s TTL 缓存**（`src/sync/git/git-transport.ts` 的 `inspectFactsCache`）：**模块级**，因为
   `makeGitTransport()` 每次请求都新建实例（实例字段等于没缓存）。只把 `detail: true` 的结果当「完整事实」
   —— 完整条目能满足任何请求，默认条目不能满足 detail 请求；写回时 detail 总是覆盖，默认结果只在还没有完整
   条目时写入。**失效靠 `withWorkdir` 的 `readonly` 标记**：除自检外每条路径收尾都删 key（push 改 ahead、
   fetch 改远端引用、重建删目录、失败也可能已留下 commit）—— 宁可多清，也不让「写后读」看到旧事实。

**收益**：detail 关闭时只 spawn 2 条命令（约 170 ms）；缓存命中时 **0 条命令**。首页 / 产物库 / 切页 / 轮询
全走缓存或缺省路径，只有同步页主动要完整事实。

**验收**：`tests/route/sync-status-budget.test.ts` 的「detail=0 → 工作副本自检降级；缺省仍是完整自检」
（断言宿主收到的入参）、`src/sync/git/git-transport.test.ts` 的三条缓存用例（命中不再 spawn / 默认结果不满足
detail 请求且不同 repoUrl 不共用 / TTL 过期后重跑）、`tests/home-load-availability.test.ts` 的 **L-04**
「workDir detail 开关贯通四层」共同钉住。

**未做**：合并命令（7 → 4 条，例如一次 `git status --porcelain=v2 --branch` 拿 ahead/branch/dirty）—— 收益
有限且要重写解析，本次未采纳。


## 远端仓库远大于同步内容 → git 通道卡死（issue #122，2026-11 落地）

**规则判据（已回写 `AGENTS.md`）**：git 通道只 materialize 同步目录（partial clone + sparse-checkout，老 git 回落全量）；
稳态靠 `ls-remote` 单次往返短路（**refs 相同 且 HEAD 已合并**才整段跳过）；网络子命令恒带低速上限；命令超时 kill **整棵进程树**且有界收尾。

**现场（报告者实测，2026-10-31）**：远端仓库 ~1.8 GB，同步内容 ~6 MB。「检查远端变更」跑
`git fetch origin +refs/heads/main:refs/remotes/origin/main` 必须拉完整对象图；UI 永久停在「正在检查远端变更…」；
工作副本累积 `tmp_pack_*` **7.3 GB**；每约 120 s 新起一个 fetch（= `DEFAULT_SYNC_TIMEOUT_MS` + 3 次重试），
旧进程仍在跑 ⇒ 最终 **5 份并发下载同一个 pack**（`--pack_header=2,4633`）。

**根因链（四条叠加，缺一条都不会卡死）**：
1. `git clone` 无 `--filter` / 无 sparse ⇒ 首次就把整库落地；`fetch` 同理（`src/utils/git-fast-forward.ts` 只拼 refspec）。
2. 超时实现是 `execFile` 的 `timeout`，**只对 git.exe 发 SIGTERM**。真正在下包的是它的子进程
   （`git-remote-https` / `git index-pack`）：父进程死了、孙进程继续写 `tmp_pack_*`。
3. `execFile` 的 promise 以 **stdio 管道关闭**为准；孙进程握着管道 ⇒ 连超时错误都不返回 ⇒ 上层无限等待。
4. 重试不是 single-flight：工作副本锁（`src/utils/workdir-lock.ts`）已跨进程串行，但孤儿进程不持锁 ——
   下一轮重试照起新进程 ⇒ 并发下载数 = 重试轮数。

**修复（`src/sync/git/git-transport.ts`）**：
- `cloneIntoWorkDir()`：`clone --filter=blob:none --no-checkout` → `sparse-checkout set --cone snapshots snapshots-encrypted blobs` → `checkout <branch>`。
  sparse 面 = `SYNC_ROOT_DIRS`（`[...ADOPT_ROOT_ALLOW]`，**与「远端顶层只许这三个目录」同一份来源**，不许另写一份）。
  `UNSUPPORTED_GIT_OPTION_RE` 命中 = 老 git（partial clone 需 ≥2.19、cone 需 ≥2.25）⇒ `clearDirContents` 后回落全量 clone，
  行为与修复前逐字一致；sparse 失败同样回落 `checkout` 全量落地，绝不留空工作树。
- `fetchOptionFlags()`：**只有 `remote.origin.promisor=true` 才加 `--filter=blob:none`**（对普通全量副本加过滤会让后续 checkout 拿到缺失 blob），恒带 `--no-tags`。
- `pullFromRemote`：先 `ls-remote --heads origin refs/heads/<b>`（~1 KB）与 `rev-parse refs/remotes/origin/<b>`；
  **两者相等且 `HEAD` 也等于它** ⇒ 直接返回（零 fetch、零 merge）；只相等但 HEAD 落后 ⇒ **跳过 fetch、仍本地 merge**
  （否则漏掉「上次 fetch 成功、merge 没跑完」的副本）。
- `defaultGitExec`（原 `defaultExec`，导出供测试）：`spawn` + POSIX `detached` 独立进程组（超时 `process.kill(-pid,'SIGKILL')`）/ Windows `taskkill /pid <pid> /T /F`；
  kill 后仍挂 `EXEC_KILL_GRACE_MS=5_000` 宽限强制收尾（**绝不把「管道没关」变成上层无限等待**）；累计输出超 16 MiB 即 kill。
  超时文案仍是 `git command timed out after <ms>ms: …` —— `classifyNetworkErrorText` 靠它判 timeout（瞬时、可重试）。
- `runGit`：网络子命令（clone/fetch/push/ls-remote/pull）前置 `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30`
  ——git 默认低速门限极宽松，限速/黑洞链路能安静耗满 120 s；30 s 内平均 <1 KB/s 即明确失败。

**为什么不那么做（各方案被否的具体理由，别再试）**：
- **bare 仓库 + `ls-tree`/`show` 直读**：sparse 之后工作区只有 ~6 MB，收益 <1%，却要重写约 400 行 fs 读写。
- **raw.githubusercontent / GitHub REST 读文件**：第二套认证、非 GitHub 托管不通用，且**写路径仍然要 git**。
- **`--filter=tree:0`**：`list` 要遍历每个 tree ⇒ 往返放大，兼容面更窄。
- **`--depth 1`**：破坏 `merge --ff-only` / adopt / ahead-behind 三项语义（报告者也明确不要）。
- **强制「专用同步仓库」**：不改用户仓库布局，只在 adopt 侧保留 `ADOPT_ROOT_ALLOW` 的只读提示。
- **存量副本静默改造成 partial**：已有全量工作副本不动（`isPartialClone()` 只读判定），它靠短路 + `--no-tags` 受益；
  要瘦身走「重建工作副本」这条显式路径。

**验收**：`src/sync/git/git-transport.test.ts` 8 条（稳态零 fetch/零 merge、refs 最新但 HEAD 落后仍 merge、
有变化时 fetch 带 `--no-tags` 不带 filter、partial 副本保持 `--filter=blob:none`、网络子命令带低速上限而本地不带、
首次 clone 走 partial+sparse 且 sparse 面逐字、老 git 回落全量、**真实进程树 kill**：孙进程 1.5 s 后写标记文件、
超时 200 ms 收尾后标记文件必须不存在）。`src/sync/git/git-probe.test.ts` 的「探针只发一条 ls-remote」按前置 `-c` 剥离后仍逐字断言。
## 自动同步「只看 portable」⇒ 勾了 mcp 也永不单独上行（2026-11-06 实测）

**现象**：用户在同步设置里勾了「MCP 连接器」（mcp 分区）后，只改连接器列表（`storages/mcp_connector.json`）时自动同步一轮判 `upToDate`，一个快照都不上传；必须顺带改一个 portable 分区才被「捎带」上去。

**根因（判定集合 ≠ 载荷集合）**：`hasLocalChanges()` 只遍历 `portableAdapters()`，而 `push()` 的载荷是 `pushTargets()` = portable + `optInAdapters()`（`src/sync/sync-engine.ts:642-664`），`recordBaseline()`（:1795-1851）也只记已推分区 —— 基线里有 mcp 的 hash，判定却从不看它。自动同步只放行 `'auto'` 档（`src/index.ts:2801` 的 `onlyAuto=true`；`src/sync/sync-selection.ts:86`），而 mcp 正是唯一 `syncOptIn='auto'` 的分区（`src/schema/section-registry.ts:244-259`）⇒ 该档位的改动检测整体失效，Phase C 不 push（`src/sync/autosync-scheduler.ts:800-819`）。

**第二处根因（判定字节不可复现）**：mcp 导出载荷带 `exportedAt: new Date().toISOString()`，就算把它纳入比较，每轮都会判「有改动」并真推一次空快照。修法：`src/core/mcp-connector-store.ts` 新增 `connectorBlockStamp(records)`（取 `max(updatedAt, createdAt)`，无时间戳退回 epoch），`exportConnectorBlock(records, exportedAt = connectorBlockStamp(records))`；该字段无读取方（导入只认 `connections`/`oauthConnections`），签名与形状不变。

**复现（先失败后通过，三处）**：
- `src/sync/sync-engine.test.ts` 的 `hasLocalChanges 必须覆盖「已勾选的 mcp」…`：`optInSections:['mcp']` → `push` → `hasLocalChanges()===false`（连判两次防易变字段）→ 只改 connector `args` → 期望 `true`；修复前在该断言处 `false !== true` 失败。
- `src/adapters/mcp.test.ts` 的载荷稳定性用例：同一 ctx 两次 `export` 间隔 25 ms，`deepEqual` 必须相等；修复前 `exportedAt` 相差 40 ms 失败。
- 端到端 `src/sync/autosync-scheduler.test.ts`：真实 `SyncEngine` + 真实调度器 + 内存 transport，`runOnce('git')` 基线 1 次 upload → 只改连接器 → 第二轮必须第 2 次 upload 且快照含新 `args`；把循环临时改回 `portableAdapters()` 时 FAIL（`actual: 1, expected: 2`），改回 `pushTargets(undefined, [])` 后 PASS。第三轮 `skipReason==='upToDate'` 且 upload 仍为 2（不空推）。

**「即时」实测（真实 fs.watch，临时 home）**：一次保存 → 一次 flush，延迟 ≈1500 ms（首事件 307 ms、flush 1823 ms，两次写入合并成一个 `changed` 数组）。参数：去抖 1500 ms 固定窗口（`src/sync/sync-watcher.ts:44`；`scheduleFlush` :214-220 窗口自首事件起算、后续事件不延长 ⇒ 跨窗口的连续改动会分成两次触发）；自写静默 2000 ms（:46）；触发最小间隔 3000 ms（`src/sync/autosync-scheduler.ts:311`，不足则合并）；远端轮询缺省 60 s（`src/sync/autosync-config.ts:41`）；失败无专门退避（靠 interval / 下一次 poll / 下一次 local-change），连续 3 次才 warn（:1028-1034）；历史保留 200 条（`src/sync/sync-history.ts:23`）；运行中按通道串行补跑（:521-528）。

**不变量**：判定集合 == 载荷集合；被比较字节 == 载荷字节（`src/adapters/file-collection.ts:242-258` 的 `identity` 即导出 `data`；`src/sync/sync-state.ts:128-137` 的 hash 口径）。

**C8 已修（2026-11-06，用户选定「只带非 MCP 行」）**：原先 plugins 分区无条件带走 `cordis.patch.yml` 的**全部** patch 行（含 mcp 适配器写的 `dsh-mcp-client` 行与其 `cwd`），未勾选 mcp 时这些行仍随 plugins 上远端。现在 `src/adapters/mcp.ts` 导出 `stripMcpEntries(raw)`（判定与 `extractMcpServers` 同口径：`config.serverName` 为非空字符串），`src/adapters/plugins.ts` 导出时逐行剔除；`insert` 块只剔 MCP 条目、其余保留，整行只剩 MCP 时丢弃。勾了 mcp 时这些行仍由 mcp 分区完整带走（剔除的是重复来源，不是数据）。
验收：`src/adapters/plugins.test.ts` 的 `C8: 未勾选 MCP 时 plugins 载荷不带 MCP patch 行…`（关掉剔除时 FAIL：`MCP 行不得进 plugins 载荷: skill-badge,mixed,mcp-citra`；开启后 PASS，并断言 mcp 分区仍导出 `citra`/`mixed`）。
副作用（预期，一次性）：升级后首轮同步会把 plugins 判为有改动（载荷少了 MCP 行）→ 真推一次；旧快照里的 MCP 行仍可正常导入（导入侧未改）。

## 启动窗口里「用户勾选」曾是空的 ⇒ 首轮同步按全量 portable 跑（C6，2026-11-06 已修）

现象：`apply()` 是同步的，而 `selectionCache` 曾是 fire-and-forget 异步种入（`void readAllSyncSelections(syncDir).then(...)`）。
消费者（`makeSyncEngine`、手动 push 路由、model tool、调度器首轮）都**同步**读缓存 ⇒ 同一 tick 读到 `undefined`，
引擎兜底 `defaultSyncSelection()`（`mode='default'`）⇒ `effectiveSections` 返回 `undefined` = **全部 portable**，
用户 advanced 勾的收窄在那一轮被吞（首轮 `startup:true` 不 push，所以表现是「多拉/多合并」，不是多推）。

复现（`.tmp/probe-c6-race.ts`，真实 `sync-selection.json` = advanced + `['settings']`）：

```
[旧写法·同一 tick] cache.git = undefined ⇒ sections = undefined（全部 portable，用户收窄失效）
[新写法·同一 tick] cache.git = loaded   ⇒ sections = ["settings"]
[异步那一轮迟到]   sections = ["settings"] | 与同步版一致 = true
```

修法：`src/sync/sync-selection.ts` 新增 `readAllSyncSelectionsSync(dir)`（与 `readAllSyncSelections` 共用同一份
`parseSelectionFile`，不是第二套解析口径），`src/index.ts` 在 `apply()` 同步种入全部通道后再构造任何引擎。
守卫：`src/sync/sync-selection.test.ts` 两条 —— 同步/异步在 v2 / v1 / 损坏 / 缺失 四种来源上逐字段一致；
源码守卫断言 `apply()` 用的是同步读取且**不得**再出现 `void readAllSyncSelections(syncDir).then(`（把旧写法改回去即 FAIL：
`AssertionError: apply() 必须同步读取分区选择`）。
第三条守卫钉住另一半：`src/routes/*.ts` 只能在 `endpoint(...)` 的处理函数内构造同步引擎 —— 装配期构造会把勾选冻结在「建路由那一刻」，
之后保存选择也不生效（同一种病，换个时点）。红证：把 `const earlyEngine = makeSyncEngine({} as never)` 塞进 `syncRoutes` 直接体 →
FAIL `同步引擎必须在 endpoint 处理函数内构造: sync.ts:106`；当前 10 处调用点全在处理函数内，PASS。

## 即时同步不覆盖历史会话：不支持（2026-11-06 决策，勿反复讨论）

**结论**：不支持。sessions 分区保持「只出现在手动一键同步的载荷里」。

**现状依据**：`sessions.syncOptIn='manual'`、`portability='deviceSpecific'`、`defaultIncluded=false`（`src/schema/section-registry.ts:365-377`）；自动同步只放行 `'auto'` 档（`src/index.ts:2801` + `src/sync/sync-selection.ts:86`，`src/sync/sync-selection.test.ts:240-243` 断言 `['mcp']` 且不含 sessions）；监听面 `buildWatchTargets` 不含 `sessions/`（`src/sync/watch-scope.ts:15-27`，`src/sync/watch-scope.test.ts:70-75` 钉住）。⇒ 默认关闭时它的改动**已被完全排除**：既不进载荷（push 需显式 `sections` 含 sessions 且带 `sessions` 参数，`src/routes/sync.ts:459-485`），也不参与改动判定（`hasLocalChanges` 的集合里没有它）。

**支持后的代价（否的理由）**：sessions 是 files 分区 ⇒ 原字节直出、**零脱敏**（`src/sync/sync-engine.ts:901-903`），唯一保护是用户可选的加密快照；会话是 zstd jsonl、单会话可达数十 MB 且逐回合追加，接进 realtime 等于「每轮对话都触发一次上传」，1500 ms 去抖挡不住；`sessions/` 不监听还有自激理由（同步写工作副本 → 触发 → 再同步，`watch-scope.ts:16-19`）；真要支持得另做增量（按会话文件 mtime + 尾部追加）、独立节流、脱敏白名单（会话首帧 `cwd` 属设备相关）、墓碑与回滚点/SAFE MODE 的交互，等于新开一条通道。

**用户实际看到什么**：勾了「历史会话」后，会话只在手动「立即同步」里上行；聊完天不会自动上传，定时轮次也不会（`onlyAuto=true`）。替代路径：按回合自动留点的回滚点（`src/core/rollback-point.ts`，只在本机）+ 手动一键同步。

## 第二种「每分钟都在推」：真实链路是 60 s 远端探测，噪音在活动历史（2026-11-08 真机）

现象：首页「最近活动」每分钟一条「自动同步 both（git）· 成功」，用户据此判断同步在不停推送。

**真实链路（实测，profile 级 `sync-profiles/desktop/`）**：
- `sync-history.json` 每 60 s 一条 `{"direction":"both","status":"success","skipReason":"upToDate"}`，与 realtime 通道的 `remoteCheckMs` 缺省 60000 对齐（`src/sync/autosync-config.ts:132`、`src/routes/route-support.ts:468/497`）—— 这是**探测**，`upToDate` 时零读写。
- 同期 git 工作副本 `work/` 的 log 只有 4 次真实 `add snapshot`（每次 8 s 后跟一条 `delete snapshot` 保留淘汰），时间点都对应真实内容变化（档案创建/删除、启用 mcp 分区）。
- 噪音只发生在**统一迁移历史**：`src/index.ts` 的 `appendHistoryFn` 把每一轮（含空检查轮）都 `history.append({kind:'autosync'})` 写进 `migration-history/`。实测该目录 1009 条里 autosync 934 条，其中 688 条正是 `upToDate` 空轮；1000 条保留额度（`src/core/migration-history.ts` 的 `DEFAULT_MIGRATION_RETENTION`）被空轮吃满，备份（22 条）与档案操作（39 条）被最旧淘汰，而 `/history` 是目录全量扫描 ⇒ 首页首屏随空轮线性变慢。

**修法**（`src/core/migration-history.ts`）：`isAutosyncIdleRound(status==='success' && skipReason==='upToDate')` 为真即不写统一历史；`autosyncUnifiedHistoryInput(entry, msg)` 一次组装载荷（方向走字典键 `host.autosyncDirection*`，不再铺裸枚举；`failed` 带 `error`；`partial` → `pending`）。`sync-history.json` 仍逐轮记录，同步页「上次运行 / 跳过原因」不受影响。

**守卫**：`src/core/migration-history.test.ts` 三条（空轮 → `null`；`unchanged`/`conflict`/`failed`/无 `skipReason` 的 success 都要写；未知方向原样回显不猜）+ `src/core/engine-locale.test.ts` 的 t2 清单钉住四个方向键的 zh 逐字与 en 无 CJK。红证：把 `isAutosyncIdleRound` 改成恒 `false` → 空轮用例 FAIL。

**未做（需用户决定）**：历史目录里 934 条旧 autosync 条目属破坏性清理，未自动删除，等 `retention` 自然淘汰。

## 60 s 远端轮询的真实 CPU 代价：每轮重算全量导出（2026-11-09 实测）

现场：realtime 开着时 `remoteCheckMs` 缺省 60 s（`src/sync/autosync-config.ts`），每轮 `detectPhase` 会**同时**做「远端有没有新快照」与「本地有没有改动」，后者 = 全分区导出比基线（`SyncEngine.hasLocalChanges`）。
其中 plugins 分区要为每个本机源（`link:` / `file:`）插件跑一次 `npm pack`：真机 12 个本地源插件 ≈ 12 s（`src/adapters/plugins.ts` 注释），单个 210 MB 插件单轮 44.7 s（`src/sync/autosync-scheduler.ts` 的 Phase 1 注释，正是 2026-11-07「锁被占」事故的起因）。

判定：轮询只需要回答「远端有没有新快照」。本地改动本来就有两条权威来源 —— realtime 文件监听（`local-change` 触发）与 30 分钟兜底 `interval` —— 每分钟再全量导出一次是纯浪费。

改法：`runOnceInternal` 把触发原因带进 `detectPhase(..., { localCheck: false })`，`reason === 'remote-poll'` 时跳过 `detectLocalChange`，`localDirty` 恒 false；远端也没变就立刻 `upToDate`。**口径不变**：需要比对时比的仍是载荷字节，没有任何近似或 mtime 猜测。锁内 Phase 2 的重跑检测不带该开关（有活干时照常全量重判）。

守卫：`src/sync/autosync-scheduler.test.ts` 三条 —— ① `remote-poll` 且远端无新 → `detectLocalChange` 调用次数 0 且结果为 `upToDate`；② `local-change` 触发仍必须比对一次（防止把优化扩成「永不检查本地」）；③ 真有改动时不打 `idle` 标记。

同轮配套：空转轮在运行中心不再留卡片 —— `RunRegistry` 收尾写入 `result.idle`，`/runs?scope=recent` 用 `isIdleAutosyncRun` 过滤（`src/core/run-registry.ts`、`src/routes/import.ts`），与迁移历史的 `isAutosyncIdleRound` 同一判据。

## 省掉剩下的那部分 CPU：远端探测降到 5 分钟 + 打包结果按内容缓存（2026-11-09 用户拍板）

**① 远端探测缺省 60 s → 5 min**（`DEFAULT_AUTOSYNC_REMOTE_CHECK_MS`，`src/sync/autosync-config.ts:41`）。理由是分工：本地改动由 realtime 文件监听即时上行，兜底由 `interval`（30 min）负责，「远端有没有新快照」不需要 1 分钟一问。已写死的旧值不迁移（用户显式选过的优先），本机当前配置经 `POST /sync/autosync` 落到 300000。

**② npm pack 结果按内容缓存**（`src/core/local-plugin-host.ts`）：解析后的源路径 → `{ fingerprint, entry, bytes, usedAt }`，命中即复用上次 tarball 字节、跳过 `npm pack`。

- 指纹用 **deepSourceFingerprint**（递归 `rel\0size\0mtime`，跳过 `node_modules`/`.git`，遇到链接或超 20000 条返回 `null` 即不缓存）。**不能用负缓存那个「目录 mtime + package.json」的粗指纹**：在 `lib/` 改一行不改目录 mtime，positive cache 会把旧 tarball 当当前内容写进备份。成本实测 8810 文件 3.6 s、51502 文件 14.9 s，仍比 44.7 s 的打包便宜一个量级。
- 上限：总字节 128 MiB + 64 条，按「最久未用」淘汰；单条超过上限不入缓存；`packedCacheMaxBytes: 0` 关闭。
- 结果合并保持入参顺序（`orderPacked`），`rewritten` 两侧合并；超限负缓存逻辑不变。

**守卫**（`src/core/local-plugin-host.test.ts`）：源没变 → 第二轮 `calls()` 仍为 1 且字节逐字相同；改 `lib/index.js` 的 mtime → 重新打包；`packedCacheMaxBytes: 0` → 两轮都真打。

## 跟随远端删除插件（issue #132 评估）：删除语义的现状、唯一可行闸门与缺口（2026-11-10，triage 期核实）

**现状（逐条对照源码，非推测）**：

- 导入计划只产三种插件项：未装 → `Install`、同版本 → `Skip`、版本不同 → `Conflict`（`src/adapters/plugins.ts:808-867`）；`applyItem` 只有安装/升级分支，没有卸载入口（`src/adapters/plugins.ts:995-1073`）。计划项种类的定义域是 `src/core/types.ts:652`（`'Create' | 'Update' | 'Skip' | 'Conflict' | 'Install' | …`），新增一个种类要连带改 `src/core/import-planning.ts:345`、`src/core/analyzer.ts:672/803`、`src/ui/backup-inspect.ts:44/69` 与字典键。
- `plugins` 数组走通用 JSON 合并，数组两侧各自改即整分区冲突：`GRANULAR_MERGES` 只有 `workspaces`（`src/sync/merge.ts:299-301`）。workspaces 的先例说明「记录级三方合并」被明确允许在 ancestor 闸门**之前**执行（同文件 ③' 段）。
- 本机卸载能力只有两条，都不是同步路径：① `runDshPlugin(profileDir, profile, ['remove', name])` + 失败分类（`src/core/restore.ts:429-442`，`desktop-profile-reserved` 分类见 `src/core/plugin-cli.ts:704/799`）；② 快照恢复的 `pluginRemove`，判据是「导入前基线没有、当前有 → 卸载」（`src/core/restore.ts:675-706`），**没有**「基线有、当前没有 → 重装」的反向分支。宿主 facade 只有 `ctx.target.plugins.install(name, target, signal)`（`src/adapters/plugins.ts:1029`），没有 `remove`。
- 三方删除的原料齐备：共同祖先 = `sync-state.ancestorId` → `tryLoadAncestor`（`src/sync/ancestor.ts:41-52`；加密通道的祖先是密文单载荷，issue #107），引擎在 `src/sync/sync-engine.ts:1494-1498` 读取；读不到一律回落两方合并，天然满足「没有共同祖先就不删」。
- 应用路径唯一：手动合并与自动同步最终都走「合成临时 ZIP → `analyzeImport` → `createImportPlan` → `executeImportPlan`」（`src/sync/sync-engine.ts:1229/1956/2089`），所以在 adapter 层加计划项种类会同时覆盖两条路径。**但 `analyzeImport` 也被普通「从文件导入」复用**：删除候选必须由调用方作为入参注入（例如 `removalCandidates` 名单），adapter 自己绝不推基线，否则「导入一份旧快照」会开始删本机插件。
- 自动化闸门已经存在，不需要第二个开关：风险分级 = 注册表 `riskTier`（`src/sync/risk.ts:1-25`）+ `autoApplyTier`（缺省 `medium` 会把 plugins 自动落盘，`src/sync/autosync-config.ts:58-61`）；`high` 恒不自动应用。要让「删除永不自动」，把带删除项的合并结果判到阈值之上即可，与既有「high 永不自动」同一机制。
- 产品裁决已有先例且口径很硬：G-20 明确「对端删除不代本机删除」= 有意不修，理由是不可回滚；并把将来要做的前置条件写成三条 —— 适配器删除能力 + 逐项确认 UI（**不得并入自动应用**）+ 与导入前快照的可回滚语义对齐（`docs/known-issues/known-gaps.md:108-115`）。会话不可回滚，故仍不破例；插件可回滚（`beforePlugins` 基线 + 重装通道），第三条对插件可满足 —— 这是插件能破例、会话不能的依据。

**结论**：需求成立、技术可行、范围可控（adapter + merge + 一个计划项种类 + 开关持久化 + 回滚重装 + 字典/UI），不涉及新的同步协议。

**维护者裁决（2026-11-10，回应 triage 三问）**：

1. **做**（不登记为不修）。
2. **范围**：开关开启时**手动合并与自动同步都可以删插件** —— 开关本身即用户显式授权，不再另设「自动同步恒不删」。但这不改变「删除不得静默」：每次删除必须逐项写 undo 记录，自动同步的拉取/合并报告必须列明「已删除：`X@1.2.3`」，开关关闭时一律不删（降级 `Skip` 并写明原因）。
3. **`desktop` 保留档案**：卸载被 CLI 拒（`desktop-profile-reserved`）时按**逐项 warning、不阻断其余项**处理。

这条裁决构成对 G-20 第②条前置（「逐项确认 UI，不得并入自动应用」）的**受控破例**：依据是插件可回滚（`beforePlugins` 基线 + 重装通道）而会话字节不可回滚；破例只覆盖 `plugins` 分区，`sessions` 仍受 G-20 全约束（已回填 `docs/known-issues/known-gaps.md` 的 G-20 行）。

**实现时必须一起改的回滚缺口**：`planRestore` 只算「导入期间新增 → 卸载」，删除项要可回滚必须补「基线有、当前没有 → 用 `name@version/spec` 装回」的 `pluginInstall` 分支；`pluginRemove` 记 `external=true`、不带指纹（`docs/known-issues/known-limits.md:77`），重装结果只能靠回读版本判成功。

**待实现的守卫清单**（做的时候一条一个测试）：A 卸载 → B 删除；B 新装不删；B 改版不删且报冲突；开关关不删（降级 `Skip` 并写明原因）；开关开 → 手动与自动都删且必须落 undo + 报告列明；`bundlesOnly`/本插件自身不删；祖先缺失不删；删除失败逐项 warning 不阻断；`desktop` 档案被拒记 warning 不阻断；回滚能重装被删插件。


