<!-- repo: xiajiajun516/dsh-config-manager —— 本文件的 gh 命令统一带 --repo 这段 -->
# Issue 回复清单

> 一行一条 issue。状态定义与用法见 skill `issue-intake-response`；发版时清空 `awaiting-release`。
> 只记需要「回版本号」的 issue；`done` 行保留用于追溯，不再每次发版重扫。

| issue | 症状 | 状态 | 修复提交 | 版本 | 更新 |
|---|---|---|---|---|---|
| 126 | 宿主以非回环地址（`--host 10.0.0.10`）提供服务时内嵌面板全 403 `forbidden: loopback-only`：kit 的 `isLoopbackRequest()` 要求 socket 回环 + Host 回环字面量，比宿主 /api 的 Host/trustedHosts + 浏览器会话认证更严 ⇒ 首页 5 路只读请求（backup-files/snapshots/backup-schedule/history/sync-status）全降级、活动记录报读取失败 | open | — | — | 2026-11-06 |
| 117 | 「使用 GitHub 登录」授权是整个账号，无法收窄到单仓库（真收窄被 #118 判 NOT_PLANNED；v0.1.85 只发了授权范围说明 + 细粒度 PAT 引导，故仍 open 等报告者接受说明） | open | 62049df | v0.1.85 | 2026-10-28 |
| 116 | 新建空仓库第一次一键同步就报「同步失败：远端无快照」 | done | 62049df | v0.1.85 | 2026-10-27 |
| 115 | 细粒度 PAT 没勾 Contents，同步只甩 git 原始 403；报告者已确认修复生效，另提「同步页两个按钮分不清该按哪个」 | done | 62049df | v0.2.0 | 2026-10-29 |
| 109 | 阿里云 OSS 同步：① 规范路径缺 bucket（v0.1.82 已修）② 真推报 400 InvalidArgument 0017-00000245（If-None-Match 被拒，OSS 不支持 If-\*） → 条件写按方言能力位选头 | done | 71a93ca | v0.3.1 | 2026-11-02 |
| 118 | 用 GitHub App（installation token）把授权收窄到单仓库 | dropped | — | — | 2026-10-27 |
| 119 | 配置一字未改，远端每分钟多 1~2 个 commit（自动同步每轮误判「本地有改动」而真推快照） | done | 39f1208 | v0.2.1 | 2026-10-29 |
| 121 | 「一键同步」这个名字让人以为是双向补齐，实际手动同步只下行；自动同步却是真双向 ⇒ 同一个词两种方向（修复：改名为「从远端合并到本机」，运行记录/历史/回滚文案同步；不改「恢复到本机」——三方合并会保留本机单边改动，「快照恢复」已占用该词） | done | 1cf8538 | v0.2.3 | 2026-10-31 |
| 122 | 远端仓库远大于同步内容时 git 通道卡死：全量 clone/fetch 拉完整对象图（1.8 GB 仓库 / 6 MB 同步内容），超时只杀 git.exe 使 git-remote-https/index-pack 成孤儿继续写 tmp_pack_*（累积 7.3 GB），UI 永久停在「正在检查远端变更…」 | done | aafc93f | v0.2.4 | 2026-11-01 |
| 120 | Android（App 内嵌 dsh web，Termux 构建的 git 2.55.0）上 Git 同步恒失败：git 编译期写死的 `GIT_SHELL_PATH` 不存在，而 credential helper 必走 `sh -c` ⇒ `cannot exec 'git credential-store … get'`（修复：helper 失败时改用 env 注入 `Authorization: basic` 重试一次，仍失败则点名平台原因） | done | 73b6fe4 | v0.2.2 | 2026-10-30 |

- `2026-11-05` **发版 v0.4.2（0.4.1 → 0.4.2，PATCH：两条用户可见修复）**：发版提交 `07015f2`（`chore(release): v0.4.2`，含 §9 七项判断）→ tag `v0.4.2`；
  `main` 推到 `origin/main`（`8a7fafb..074a8d3f` 区间内的 `07015f2` → `4418f14` → `74a8d3f`）。`publish` 流水线 `41932247409` success（typecheck → typecheck:tests → test 5404 pass / fail 0 / skip 2 → build → bundle 自包含 → AGENTS 预算 → 文档路径 → 文档版本 → Tag guard → pack → 亮点段门禁 → npm publish(OIDC) → GitHub Release），`main` 上的 CI `41932243014` success（含 windows-latest）。
  Release `v0.4.2` 已建（双语亮点在位）；registry 侧 `dsh-config-manager@0.4.2` 可查、`dist-tags.latest = 0.4.2`（发布后约 7 分钟可见）。
  **本版无需回 issue 版本号**：清单里 `awaiting-release` 行 0 条（`#117` 仍 `open` 等报告者接受授权范围说明；`#118` dropped）。
  发版中途两次 publish 红在**新写的 core-F1 回归测试**（不是产品代码）：① `41930090187` 用「目标父路径是普通文件」注入执行期失败，POSIX 上计划期目标安全闸先判 `路径越界: blocked/x.yaml`；② `41931060395` 改成「计划后破坏父路径」仍红 —— `restore()` 进来会内部重新 `planRestore`，注入点落在内部规划之前，又被同一道闸拦下。
  最终修法 `74a8d3f`：不动目标侧，改把该动作的**源 blob** 换成目录（目标路径全程合法，两端安全闸都不介入；执行期 `copyFile(源=目录)` 在 POSIX 抛 EISDIR、Windows 抛 EPERM）。因 v0.4.2 从未出现在 registry 也没有 Release（versioning §8.1「未完成发布」），按「当轮补完」处理：删 tag（本地 + 远端）→ 在新提交上重建附注 tag → 重推。


- `2026-11-04` **发版 v0.4.1（0.4.0 → 0.4.1，PATCH：自动同步自愈 + 「待裁决」语义）**：提交 `cac4272` → tag `v0.4.1` push；
  `main` 同步推到 `origin/main`（`3b69baa..cac4272`）。`publish` 流水线 `41920564745` success（typecheck → typecheck:tests → test 5322 项 pass 5320 / fail 0 / skip 2 → build → bundle 自包含 → AGENTS 预算 → 文档路径 → 文档版本 → Tag guard → pack → 亮点段门禁 → npm publish(OIDC) → GitHub Release），`main` 上的 CI `41920557295` success；
  Release `v0.4.1` 已建（双语亮点在位）；registry 侧 `dsh-config-manager@0.4.1` 可查、`dist-tags.latest = 0.4.1`（发布后约 3 分钟可见）。
  **本版无需回 issue 版本号**：清单里 `awaiting-release` 行 0 条（`#117` 仍 `open` 等报告者接受授权范围说明；`#118` dropped）。
- `2026-11-04` **发版 v0.4.0（0.3.1 → 0.4.0，MINOR：新增「迁移历史上限/自动清理」+ 一批界面与体验修补）**：提交 `0f15702`（`chore(release): v0.4.0`）→ tag `v0.4.0` push；
  `main` 同步推到 `origin/main`（此前 8 个未推提交随本版一次性公开）。`publish` 流水线 `41908109199` 全绿（typecheck → typecheck:tests → test 5316 项 pass 5314 / fail 0 / skip 2 → build → bundle 自包含 → AGENTS 预算 → 文档路径 → 文档版本 → Tag guard → pack → 亮点段门禁 → npm publish(OIDC) → GitHub Release），`main` 上的 CI `41908102715` success；
  Release `v0.4.0` 已建（asset `dsh-config-manager-0.4.0.tgz`，双语亮点在位）；registry 侧 `dsh-config-manager@0.4.0` 可查、`dist-tags.latest = 0.4.0`（发布后约 5 分钟才可见，期间 `npm view` 404 属正常）。
  **本版无需回 issue 版本号**：清单里 `awaiting-release` 行 0 条（#109/#115/#116/#119/#120/#121/#122 均 done；#117 仍 open 等报告者接受授权范围说明；#118 dropped）。
  另修一处发版闸门阻断：`docs/maintenance/tech-debt.md` 第 23 行的「拟新增 `src/core/host-schedulers.ts`」被文档路径守卫判为失效路径（`130f36c` 引入，该文件尚未创建），改成「`src/core/` 下拟新增的 `host-schedulers` 工厂（尚未创建，故此处不写成路径）」——否则 publish 的 Doc path guard 必红。
- `2026-11-02` **#109 第二层修复（待发版）**：提交 `71a93ca`。报告者升到 v0.1.82 后「测试连接」通过但真推报 HTTP 400 `InvalidArgument`
  「A header you provided implies functionality that is not implemented.」（`Header: If-None-Match`，错误码 0017-00000245）——
  签名早已正确，**是条件写头本身**：阿里云 OSS 的 PutObject 不支持 `If-Match`/`If-None-Match`，而我们首推发 `if-none-match: *`（`src/sync/s3/s3-transport.ts` 的 `conditionalHeaders`），索引已存在时还会发 `if-match`。
  修法：`S3ProviderVariant.conditionalWrite` 能力位（`src/sync/s3/s3-providers.ts`，s3/minio/cos/kodo=`etag`，oss=`forbid-overwrite`）→ OSS 首推改发 `x-oss-forbid-overwrite: true`（409 FileAlreadyExists 判冲突，语义等价且原子）；
  索引已存在时 OSS 无原子条件写，退化为写前 `HEAD` 复核 ETag（`S3Transport.reassertIndexEtag`，非原子，残余窗口登记在 ADR-0003）。
  **根因里的自证盲点一并修掉**：`src/sync/s3/oss4-verify.ts` 之前自己实现了 `if-none-match`，于是「14 个请求零验签失败」证明不了真机 —— 现在验签器照真机拒 `If-*`（回同样的 400 + 0017-00000245）并支持 `x-oss-forbid-overwrite`，另加回归用例（注入 `If-None-Match` 必须被拒、索引不落盘）。
  测试：`s3-conditional-write.test.ts` 新增 4 例（OSS 首推头、ETag 复核顺序、复核发现 ETag 变化 → conflict 零写入、forbid-overwrite 409 → conflict）+ `s3-transport.oss4-server.test.ts` 新增 2 例（首推全程不发 If-*、验签器拒 If-*）。全量 `npm test` 5281 项 pass 5279 / fail 0 / skip 2，`npm run typecheck` 通过。
  未做：发版后回版本号评论（本行 `awaiting-release`）；真桶连通性仍需报告者用 `npm run oss:check` 或正式版复核。
- `2026-11-02` **#109 第二层复核（提交 `f505837`，仍待发版）**：按官方文档逐条核对后补两处，不改变主修法。
  ① 阿里云 PutObject 文档确认请求头清单里**没有** `If-Match`/`If-None-Match`，`x-oss-forbid-overwrite`（默认 false、值为 `true` 时禁止覆盖、
  已存在回 **409 FileAlreadyExists**）与错误码表逐条对上；V4 签名文档确认 `x-oss-*` **自动参与**规范化头（不必进 `AdditionalHeaders`），
  故该头已被正确签名。② 409 在 OSS 上**有两种**：`FileImmutable`（Bucket 数据被保护）与 `FileAlreadyExists` —— 原先一律报「别的设备改过索引」是假话，
  改按报文 `Code` 分辨（`S3Transport.conditionalFailure`），`etag` 方言维持原判（各家 409 语义自定，报文不作判据）。
  另如实登记两条边界：**开启/暂停版本控制的桶上 `x-oss-forbid-overwrite` 无效**（官方文档原文，首推保护降级为无条件写）；OSS 上「索引已存在」只能写前复核（非原子）。
  测试：新增 2 例（409 FileImmutable 不冒充并发写、OSS 删除路径同样写前复核），全量 `npm test` 5283 项 pass 5281 / fail 0 / skip 2，`npm run typecheck` 通过，
  `node scripts/oss-live-check.mjs` 本地模式 15 个请求全部验签通过（该脚本用的就是更新后的严格验签器）。
- `2026-11-02` **v0.3.1 已发布并回 #109 版本号**：提交 `19146db`（`chore(release): v0.3.1`）→ tag `v0.3.1` push；
  `publish` 流水线 `41507561153` 全绿（typecheck → test → build → 五道守卫 → pack → 亮点段门禁 → npm publish(OIDC) → GitHub Release）；
  registry 侧 `dsh-config-manager@0.3.1` 可查、`dist-tags.latest = 0.3.1`（发布后约 9 分钟才可见，期间 `npm view` 一直 404 —— 延迟属正常，不宜据此判失败）。
  已回评论 `issuecomment-6586193650`（含升级命令 + 三步自证 + 版本控制桶上 `x-oss-forbid-overwrite` 失效的说明），标签 `bug/confirmed/fixed` 已在位，未关闭 issue（等报告者确认）。
- `2026-11-01` **发版 v0.3.0（0.2.4 → 0.3.0，MINOR）**：tag `v0.3.0`（提交 `b9d5c0e`，CHANGELOG 收口 `docs(changelog): 0.3.0` 先于打 tag）→ Publish 工作流 `41351472143` success：Tag guard / Doc version guard / CHANGELOG 门禁 / bundle 自包含护栏 / pack 全绿，OIDC 可信发布 `+ dsh-config-manager@0.3.0`（provenance logIndex 3636150594），GitHub Release `v0.3.0` 已建（asset `dsh-config-manager-0.3.0.tgz`，双语亮点在位）。
  核对：`git merge-base --is-ancestor b9d5c0e v0.3.0` = 0；registry `dist-tags.latest` = 0.3.0（发布后约 5 分钟才可解析，前几次本地 `npm view` 仍是 0.2.4 —— 本地缓存 + CDN，实测 `curl registry.npmjs.org/-/package/dsh-config-manager/dist-tags` 才准）。
  仍 `awaiting-release` 的行：0 条（`#117` 仍 `open`：等报告者接受授权范围说明，非本版范围；本版无 issue 修复条目）。
- `2026-11-01` **#122 已发版 v0.2.4**：CI 发布成功（run 41310464902，OIDC 可信发布 + GitHub Release），registry 上 `dsh-config-manager@0.2.4` 可装（`dist-tags.latest` = 0.2.4）；已回版本号评论（issue #122 comment 6558551306）并加 `fixed` 标签，issue 保持 open 等报告者真机确认。
- `2026-11-01` **#122 修复（待发版）**：提交 `aafc93f`。clone 改 partial + sparse（sparse 面 = `SYNC_ROOT_DIRS` ← `ADOPT_ROOT_ALLOW` 同源），老 git 按 `unknown option` 回落全量；
  `pullFromRemote` 先 `ls-remote --heads` 比 sha，**refs 相同且 HEAD 已合并**才整段跳过（只比 refs 会漏「fetch 完没 merge」的副本）；
  `--filter` 只给 `remote.origin.promisor=true` 的副本（对全量副本加过滤会让后续 checkout 缺 blob）；网络子命令前置 `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30`；
  `execFile` → `spawn` + 进程树 kill（POSIX `kill(-pid)` / Windows `taskkill /T /F`）+ 5 s 宽限强制收尾，超时文案保持 `timed out after …ms` 让分类器仍判 timeout。
  测试：git-transport 新增 8 例（含真实孙进程 kill 验收），git-probe 的「只发一条 ls-remote」按前置 `-c` 剥离后仍逐字；全量 `npm test` 5207 项 pass 5205 / fail 0 / skip 2，typecheck 与 build 均通过。
  明确不做：bare 仓库直读、GitHub REST、`--filter=tree:0`、`--depth 1`（理由见 issue 评论与 `docs/lessons/sync-channel.md`）。
- `2026-11-01` **#122 受理**：回确认评论（comment 6558142935）+ 加 `confirmed` / `sync`，去 `needs-triage`。
  代码核实（`src/sync/git/git-transport.ts`）：clone 无 `--filter`（:587）、fetch 无 filter（`src/utils/git-fast-forward.ts:14`）、超时 `execFile` 只杀 `git.exe`（:208，`DEFAULT_SYNC_TIMEOUT_MS=120_000` @ `src/sync/transport.ts:281` + 3 次重试）。
  并发不是缺 single-flight：`src/utils/workdir-lock.ts` 已跨进程串行，5 份并发 = 孤儿 + 新起。修复方向：clone `--filter=blob:none --no-checkout` + `sparse-checkout set --cone snapshots snapshots-encrypted blobs` + `checkout`（服务端不支持则回落全量）、fetch 仅在 `remote.origin.promisor` 为真时补 filter、超时改杀进程树（Windows `taskkill /T /F`）且以定时器为准不等 stdio 管道、存量副本走「重建工作副本」不静默改造、不采用 `--depth 1`。状态 `open`（未改代码）。
- `2026-10-31` **#121 发版收尾**：tag `v0.2.3`（提交 `babd759`）→ Publish 工作流 success（npm publish + GitHub Release 已建，release 正文双语亮点在位）。
  对账：`git merge-base --is-ancestor 1cf8538 v0.2.3` = 0；`npm view dsh-config-manager@0.2.3 version` = 0.2.3；dist-tags latest = 0.2.3。
  回版本号评论 comment 6544459250 + 加 `fixed`，行转 `done`。仍 `awaiting-release` 的行：0 条（`#117` 仍 `open`：等报告者接受授权范围说明，非本版范围）。
- `2026-10-31` **#121 受理 + 修复（待发版）**：回确认评论（comment 6544199390）+ 加 `confirmed` / `sync` / `ui`，去 `needs-triage`。
  修复提交 `408be6a`（改名「从远端合并到本机」+ 运行记录/历史/回滚文案）与 `1cf8538`（按报告者要求移除动作行两处 ⓘ）。
  未采纳「恢复到本机」的两条理由（三方合并保留本机单边改动、与已有「快照恢复」撞名）已写进 issue 评论。状态 `awaiting-release`。
- `2026-10-30` **#120 发版收尾**：tag `v0.2.2`（提交 `d391779`）→ Publish 工作流 41058412334 success（npm publish + GitHub Release 已建）。
  核对：`git merge-base --is-ancestor 73b6fe4 v0.2.2` = 0；`npm view dsh-config-manager@0.2.2 version` = 0.2.2（发布后约 2 分钟才在 registry 可解析，前 4 次 404）；`gh release view v0.2.2` 双语亮点在位。
  回版本号评论 comment 6523386907 + 加 `fixed`，行转 `done`。仍 `awaiting-release` 的行：0 条。
- `2026-10-30` **#120 修复（待发版）**：不以 askpass 为主路径（它同样需要从应用目录 exec 脚本；Android 10+ targetSdk≥29 禁 exec 应用 home，报告者给的 TS 片段正是这个坑），
  改成「helper 注入失败 ⇒ 自动重试一次，凭据经 `GIT_CONFIG_*` 环境变量注入 `http.<origin>.extraheader`」（本机实测该通道零 sh、零临时凭据文件、token 不进 argv）。
  两处注入点共用新模块 `src/sync/git/credential-auth.ts`；新增 i18n 键 `sync.git.credentialHelperBlocked`；单测 git-transport 3 例 + market 2 例。状态转 `awaiting-release`。
- `2026-10-30` **#120 受理**：回确认评论（comment 6522239454）+ 加 `confirmed` / `sync`，去 `needs-triage`。
  核对到两处注入点（`src/sync/git/git-transport.ts:1011`、`src/market/git-file-writer.ts:282`）；本机 git 实测**裸 `credential.helper=store` 同样走 `sh -c 'git credential-store get'`** ⇒ helper 这条路上不存在避开 shell 的写法，只能 helper→askpass 切换。
  已向报告者提两个实现修正（shebang 探测 `/system/bin/sh`、Windows 保持 helper）与一项真机待确认（`os.tmpdir()` 是否 noexec）。状态 `open`，未修。
- `2026-10-29` **#119 修复 + 发版收尾**：回确认评论（comment 6508108922）+ 加 `confirmed` / `sync`，去 `needs-triage`；
  修复提交 `39f1208`（跳过码进剔除表 + 编译期穷尽断言 + 回归测试），发版提交 `950bfd5`（tag `v0.2.1`）。
  回版本号评论 comment 6508671619 + 加 `fixed`，行转 `done`。对账证据：`git log -1 v0.2.1` = `950bfd5`；Publish 工作流 success（npm publish + GitHub Release 已建）。
  报告者附带的两个观察（同机往返仍报 3 个 Conflict / detail 截断 200 字符、apply-items 的 applied 与 skipped 口径）与本次 bug 无关，需另开 issue。
  仍 `awaiting-release` 的行：0 条。
- `2026-10-29` **v0.2.0 发版收尾**：#115 回版本号评论（issue comment 6483667536）+ 加 `fixed`，行转 `done`。
  对账证据：`git merge-base --is-ancestor 62049df v0.2.0` = 0；`npm view dsh-config-manager@0.2.0 version` = 0.2.0；dist-tags latest = 0.2.0。
  更正：那版行为实际随 `v0.1.86` 发布（CHANGELOG `[0.1.86]` 第 70 行「同步页只强调当前该按的那一个方向」），本行原填的 `v0.1.85` 是错的；回复里如实写成「v0.1.86 首发，当前版本 v0.2.0」。
  仍 `awaiting-release` 的行：0 条。

## 说明

- `v0.1.85` 三行的证据：`62049df` 已在 `v0.1.85` 的祖先里（`git merge-base --is-ancestor 62049df v0.1.85` = 0）；
  CHANGELOG `[0.1.85]` 段有对应行为描述但**没有** `（issue #117）` 这类标注 —— 所以对账靠 commit 祖先关系，不靠 changelog 文字。
- `109` 已在 `v0.1.82` 回复并要求报告者复测；issue 仍未关闭是等对方确认，不是欠回复。
- 收到新 issue 时追加 `open` 行；修完后 `修复提交` 填 `git log -1 --format=%h` 的值。
- `v0.1.85` 收尾（2026-10-27）：115/116 已回版本号 + 加 `fixed` + **重新打开**（按 skill「不替报告者关」）等对方确认；117 回了版本号但没加 `fixed`（scope 没真收窄），保持 `open`。
- `118` 判 `dropped`（NOT_PLANNED）：理由与三条重开条件写在 issue 关闭评论里；若「多个用户拒绝建 PAT」「需要组织内多仓自动化」「GitHub 限制 PAT」任一成立即重开。
- `2026-10-28` #115 报告者回「it worked」并提 UX 建议（不要 push/sync 之分，通道内改成 Export/Import）：已在 issue 用英文回复（comment 6480024127）说明两个词已被一级导航占用、两个方向不对称（同步=先拉再三方合并逐项确认，推送=产生新快照），并把「按远端事实只强调一个方向」实现在 `## [Unreleased]`（`pickSyncPrimary`）；因此该行转 `awaiting-release`，下个版本发布时回版本号并关闭。
- `2026-10-28` #117 追问「有没有 GitHub repo/gist 之外的存储、让 OAuth 权限最小」已在 issue 回复（comment 6479732607：GitHub 只有 repo/gist 两种存储面、gist 的细粒度 PAT 不支持只能经典 `gist` scope、单仓最小权限 = 细粒度 PAT、真最小权限走 WebDAV/S3 兼容通道的目录或桶前缀）；状态仍 `open`，等报告者接受说明，未加 `fixed`。
