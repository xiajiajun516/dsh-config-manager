# 同步通道快照格式 v1（sync-channel）

> 性质：**对外契约**（写给第三方实现者）。本文件描述 `/sync/*` 通道在**远端**存放快照的
> 布局与载荷扩展；`bundle-format-v1.md` 描述的是导入/导出用的 ZIP 包，两者共用分区语义，
> 但传输形态不同。改本文件描述的行为必须同时改 `src/sync/` 并重跑 `npm test`。
>
> 实现锚点：`src/sync/layout.ts`（散文件布局）、`src/sync/snapshot-json.ts`（JSON 载荷）、
> `src/sync/blob-store.ts`（内容寻址外置）、`src/sync/session-tombstones.ts`（删除墓碑）、
> `src/sync/git/git-transport.ts` / `src/sync/webdav/webdav-transport.ts` / `src/sync/s3/s3-transport.ts` / `src/sync/gist/gist-transport.ts`。

## 1. 各通道的落地形态

| 通道 | 快照位置 | 形态 |
|---|---|---|
| git | `snapshots/<snapshotId>/`（加密快照：`snapshots-encrypted/<snapshotId>.json`） | 散文件目录（`manifest.json` + 按分区平铺） |
| webdav | `<base>/dsh-config-manager/<snapshotId>.json` + 集合索引 `index.json` | 单文件 JSON 载荷 |
| s3（含 oss / cos / minio / kodo） | `<prefix>/<snapshotId>.json` + 总索引 `<prefix>/index.json`（blob：`<prefix>/blobs/<sha256>` + `<prefix>/blobs-index.json`；`prefix` 缺省 `dsh-config-manager`） | 单文件 JSON 载荷（与 WebDAV 同构，便于跨通道迁移与排障） |
| gist | `<filePrefix>-<snapshotId>.json` + 索引 `<filePrefix>-index.json`（`filePrefix` 缺省 `dsh-sync`） | 单文件 JSON 载荷（gist 是**扁平文件名**命名空间，故用前缀隔离；**不外置 blob**，见 §3） |

散文件目录布局与 `layout.ts` 一致：JSON 分区按 `SECTION_JSON_PATHS` 平铺，
文件类分区按 `SECTION_FILE_PREFIXES` 建目录放真实文件，`manifest.json` 记录
`{ id, createdAt, manifest, sectionHashes }`。

## 2. `manifest` 扩展字段（相对 `bundle-format-v1`）

同步快照的 `manifest` 是 `ManifestSummary`（`src/sync/transport.ts`），除通用字段外还有：

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `transport` | `string?` | 无 | 产生该快照的通道（`git` / `webdav` / `s3` / `gist`）；仅供同步历史展示 |
| `encrypted` | `boolean?` | false | `sections` 为 `EncryptedSections` 密文载荷 |
| `sourceHome` | `string?` | 无 | **导出机的 DSH home**。拉取侧与**本机** home 比较后由 Importer 生成自动重定基规则（工作区 `path` + 会话日志首帧 cwd 一并改写）。缺字段 = 不猜（行为与改造前一致） |
| `deletedSessions` | `string[]?` | 无 | **会话删除墓碑**（见 §4）。缺字段 = 旧快照，无墓碑信息 |
| `deviceId` | `string?` | 无 | 产生该快照的**设备稳定标识**（UUID）。首次推送时生成并持久化在推送机的设备侧状态里；换主机名 / 改机器名都不变。供同步历史展示「哪台设备推的」。缺字段 = 旧快照 / 未记录（读侧不猜） |
| `deviceName` | `string?` | 无 | 该设备的人类可读名（缺省取主机名；取不到时由实现回落到本地化兜底文案）。与 `deviceId` 同源，**仅供展示**，不参与任何判定 |

## 3. 内容寻址外置（大文件分区）

**目的**：会话日志是「大且多数 push 不变」的内容。内联进每份快照会让 WebDAV 通道
每次复制一遍整份字节（保留 10 份 = 最多 10 份），git 通道每次也要重写工作树。

**布局**：与快照同根共享一个内容寻址仓。

| 通道 | blob 位置 | 索引 |
|---|---|---|
| git | `blobs/<sha256>`（与 `snapshots/` 同级，同一次 commit） | 无（目录即索引） |
| webdav | `<col>/blobs/<sha256>` | `<col>/blobs-index.json`（`{ "<sha256>": <mtimeMs> }`） |
| s3（五家兼容商） | `<prefix>/blobs/<sha256>` | `<prefix>/blobs-index.json`（`{ "<sha256>": <mtimeMs> }`） |

> **gist 通道刻意不做外置**：GitHub Gist 一次 GET 返回**全部文件内容**、单文件内容超限会被**截断**、文件数有上限 —— 三条都会撞上「逐文件外置大分区」的做法。因此 gist 定位是「**配置类分区的低门槛远端**」，会话这类大分区请走 git / webdav / s3（能力边界登记于 `known-gaps.md` **G-34**）。

**载荷形态**：走外置的分区（当前只有 `sessions`）在快照里不再是
`{ version: 1, files: [{ relativePath, data }] }`，而是引用形态：

```json
{ "version": 1, "blobRefs": [ { "relativePath": "--p--/u1/session.jsonl.zstd", "blobHash": "<sha256>", "sizeBytes": 12345 } ] }
```

- 散文件布局下，该分区**不建** `<prefix>/` 目录，改写 `<section>.blobs.json`（同形状）。
- WebDAV 单文件载荷下，该分区直接以引用形态内联在 `sections` 里。

**读写规则（实现方必须遵守）**：

1. 写：按 `contentHash`（缺省现算 sha256）落仓，命中已有 blob 则**跳过传输**；
2. 读：按引用取回字节；**任一 blob 取不到必须硬失败**，绝不降级成空分区
   （静默降级会让用户看到「同步成功但对话没了」）；
3. `sectionHashes` / 索引里的 `sections` hash 一律按**明文分区**计算（不是引用形态），
   这样拉取侧不解仓也能比较变更；
4. 加密快照**永不外置**（整份 `sections` 是密文，没有可拆的文件分区）。

**并发写入（通道实现必须遵守）**：快照索引（`index.json` / `<prefix>/index.json` / gist 索引文件）是读改写形态，
通道**必须**用条件写（WebDAV / S3 的 `If-Match`，索引本不存在则 `If-None-Match: *`）保护它：读到的 ETag 与实际写入之间
若远端被其它设备改过（HTTP 412，S3 兼容端点可能是 409），**必须中止本次写入并如实报错**，绝不覆盖别人的索引条目。
服务端不返回 ETag / 不实现条件写时退化为无条件写（行为与本条引入前一致），但**不得**把「拿不到 ETag」判成本次同步失败。
gist 的 `ETag` 是**弱** ETag（`W/"…"`），HTTP 禁止用它做 `If-Match` —— 弱 ETag 一律不采用。

**GC**：删除快照后回收无人引用的 blob。

- 保护窗口 `BLOB_GC_MIN_AGE_MS = 10 分钟`：窗口内的 blob 一律不删（防与并发 push 竞态）；
- 任一引用文件/快照读不出来 → **本轮直接放弃**（宁可留垃圾，不可删在用的）；
- 失败只记日志，不影响删除快照本身的结果。

> ⚠️ **跨版本不兼容（登记于 `known-gaps.md` G-19）**：本格式不做协议协商。旧版插件读到
> `<section>.blobs.json` / `blobRefs` 认不出来 —— git 通道会因 `missingFileDir='empty'`
> 降级成空分区（丢内容但不崩），WebDAV 通道会得到空分区。**同步通道两端应使用同一插件版本**。

## 4. 会话删除墓碑（`deletedSessions`）

**问题**：会话按快照整体搬运。机器 A 删掉对话 X 后 push，B 拉最新快照不会拿到它；但 B 若
之后**显式拉一次更旧的快照**（UI 有历史快照下拉），X 就回来了，B 下次 push 又把它带回 A。

**格式**：`manifest.deletedSessions` = **累积**的会话单元 id 列表
（`sessions:<projectKey>/<sessionId>`，与分区选择/单元 id 同一命名空间）。

**产生（push 侧）**：

```
本机现存集合 = adapter.listAllUnitIds(ctx)      // 全量枚举，不是本次勾选
新删 = 上次推送记录集合 − 本机现存集合
墓碑 = union(此前墓碑, 新删) − 本机现存集合     // 本机又有实体 → 撤销墓碑
```

- 上次推送记录集合存于 `sync-state.json` 的 `sessionUnits`；
- 三情形一律**不动**既有记录：本次没推 `sessions` / 适配器不支持全量枚举 / 本机枚举为空或失败
  （把「读不到」当「全删了」会一次性标错几百条）；
- 上限 `MAX_SESSION_TOMBSTONES = 5000`（FIFO 保留最新）。

**消费（pull / preview / merge 侧）**：把墓碑命中的会话单元从**将要导入的载荷**里剔除
（按 relativePath 的前两段，整目录一起踢）。这**不删除本机已有数据** —— 删除是不可回滚的
用户动作，本实现只阻止「复活」。

**边界（不谎报能力）**：

- 墓碑随快照传播，因此**只拉过旧快照**的机器看不到更新的墓碑；
- **不代本机删除**（登记于 `known-gaps.md` G-20）。

## 5. 分区选择（宿主侧持久化，不在远端格式内）

`sync-selection.json`（按通道独立）决定推什么：

| 字段 | 语义 |
|---|---|
| `mode` / `sections` | 恒 `advanced` + 勾选分区（勾选集合就是同步范围） |
| `sessionsLimit` | `sessions` 勾选时只带「最新 N 个」（按会话日志 mtime 倒序；0 = 不带） |
| `sessionsInclude` | **显式点名的会话单元**；非空时**优先于 `sessionsLimit`**（用户点名的必须赢） |
| `retention`（远端保留） | 来自 `backup-schedule.json`：远端快照裁剪走 GFS（keepLast/keepMonthly/keepYearly），缺省 = 最近 10 个（与旧硬编码 FIFO 逐字等价） |

## 6. 云端点通道（s3 / gist）的配置形状与密钥纪律

> **性质**：本节描述**通道配置**（不是远端快照载荷）。git / webdav 的配置住在 `sync-config.json`；
> 云端点通道的**非密字段**住在独立文件 `sync-cloud-config.json`（`CLOUD_SYNC_CONFIG_FILE`，`schemaVersion: 1`；
> `active` 记录每条通道当前选用的 provider —— 缺省时读侧按「唯一已保存者」推断，**多家并存不猜**）。
> 通道枚举 = `SYNC_CHANNELS = ['git', 'webdav', 's3', 'gist']`（声明处 = 零依赖 `src/utils/shared-constants.ts`，
> 宿主 `sync-config.ts` re-export，客户端运行时 import 同一常量）。

**非密字段（会落盘、可回显）**：

| 通道 | 字段 | 语义 |
|---|---|---|
| s3 | `provider` | `s3` / `oss` / `cos` / `minio` / `kodo`（五家共用同一份 SigV4 实现，差异在 endpoint / region / 寻址风格 / 签名方言） |
| s3 | `endpoint` | 对象存储端点（http(s)，**不含凭据、不含桶名**），如 `https://s3.us-east-1.amazonaws.com` |
| s3 | `region` | 签名作用域里的 region（如 `us-east-1` / `cn-hangzhou` / `ap-guangzhou`） |
| s3 | `bucket` | 桶名 |
| s3 | `prefix` | 对象键前缀（缺省 `dsh-config-manager`） |
| s3 | `accessKeyId` | AccessKey **ID**（标识符，可回显；**不是**密钥） |
| s3 | `pathStyle` | path-style 寻址开关（缺省取变体默认：MinIO `true`，其余 `false`） |
| s3 | `dialectId` | 可选：显式覆盖签名方言（`aws4` / `oss4`）；非法值在解析期被忽略（回落变体默认） |
| gist | `gistId` | 目标 gist id（十六进制串） |
| gist | `apiBaseUrl` | GitHub API 根（缺省 `https://api.github.com`；GitHub Enterprise 可改） |
| gist | `filePrefix` | gist 内文件名前缀（缺省 `dsh-sync`；改前缀 = 同一 gist 里换一套互不干扰的同步数据） |
| 两者 | `secretStored` | **布尔标记**：密钥是否已在 DSH 凭据槽位。**只回标记，绝不回值** |

**密钥纪律（硬约束，第三方实现者请照抄）**：

1. **值只在 DSH 凭据槽位**：AccessKey **Secret** / Gist **Token 的值**绝不写进 `sync-cloud-config.json`、快照、日志或任何响应。槽位引用 = `cloudSecretRef(provider)`：`DSH_CONFIG_MANAGER_SYNC_S3_SECRET_ACCESS_KEY` / `..._OSS_...` / `..._COS_...` / `..._MINIO_...` / `..._KODO_...` / `DSH_CONFIG_MANAGER_SYNC_GIST_TOKEN`。
2. **只写不回读**：写入经 `CloudSecretWriter` 的 `set(ref, value)` / `has(ref)` —— 该端口**故意没有 `get()`**（结构性保证，不靠纪律）；回传 UI 的 `CloudChannelView` 只带 `secretStored` 布尔。
3. **读侧丢弃手写密钥字段**：即使有人把 secret / token 直接写进 `sync-cloud-config.json`，读侧也一律**丢弃**（绝不回读、绝不回传）。
4. **加解密密码同族**：`syncPasswordRef('ENCRYPT'|'DECRYPT', 's3'|'gist')` → `DSH_CONFIG_MANAGER_SYNC_{ENCRYPT|DECRYPT}_PASSWORD_{S3|GIST}`，值只在进程内存 / DSH 凭据槽位，**永不落盘**。
5. **断开通道即清槽位**：`/sync/config` 的 clear 分支 unset 该通道的密钥槽位（s3 → 五家全清）与加解密密码槽位，并关 autosync。
6. **gist 不做内容寻址外置**（§3 的例外）：会话这类大分区请走 git / webdav / s3（能力边界见 `known-gaps.md` G-34）。

## 7. 三方合并与冲突裁决（应用侧契约）

> **性质**：本节描述**同步引擎在下行/合并时**的判定与基线纪律，供第三方实现者对齐；
> 实现锚点 = `src/sync/merge.ts`（纯函数合并）、`src/sync/text-merge.ts`（行级/JSON 合并）、
> `src/sync/sync-engine.ts`（`merge` / `previewMerge` / `applyMergeResolutions`）、
> `src/routes/sync.ts`（`/sync/merge-preview`、`/sync/apply-merge`）。

### 7.1 三方输入与分区决策

合并输入是**三个**分区视图（不是两方 diff）：

| 位置 | 来源 | 说明 |
|---|---|---|
| `local` | 本机此刻的真实导出（密钥已过 scanner 剥离） | 与 push 同口径 |
| `remote` | 下载的远端快照 `sections` | 墓碑命中的会话单元先剔除 |
| `ancestor` | 本机保存的**共同祖先副本**（`sync-state.ancestorId` 指向的目录） | 副本缺失/被裁剪 → 退化为无祖先 |

分区决策是**闭集 5 值**（`MergeDecision` + `'conflict'`）：

| 决策 | 判据 | `merged` |
|---|---|---|
| `skip` | localHash == remoteHash（或无实质变化） | 无 |
| `useRemote` | 仅远端相对祖先改动 | 远端整分区原值 |
| `keepLocal` | 仅本地相对祖先改动 | 本地整分区原值 |
| `merge` | 双侧都改且**精细合并成功、无残留冲突** | 合并结果（+ `autoMerged` 变更点数） |
| `conflict` | 双侧都改且无法安全自动合并（含无祖先） | **无**（绝不返回半成品） |

**`merge` 绝不等于 `useRemote`**：把自动合并报成「用了远端」会让界面/日志谎报数据来源。
精细合并规则：JSON 分区按**递归对象键**合并（数组**绝不按索引合并**，双侧都改即冲突）；
文件类分区（`{version:1, files:[...]}`）按 `relativePath` 逐文件合并，双侧都改的**文本**文件再做行级三方合并
（CRLF/LF 逐字保留；> 1 MiB 或二进制不做文本合并）。
**形状闸门**先于一切取舍：任一侧分区值不是普通对象（例如被破坏成字符串）→ `conflict`，绝不原样采用；
一侧为文件类、另一侧为 JSON 分区 → `conflict`。

### 7.2 冲突成因（`reason` 闭集）

| reason | 含义 |
|---|---|
| `both-modified` | 双侧改同一处（含文本行重叠） |
| `overlap` | 文本/JSON 值级重叠（底层成因，界面按 both-modified 措辞） |
| `modify-delete` | 本机改、远端删 |
| `delete-modify` | 本机删、远端改 |
| `no-ancestor` | 无共同祖先 → 差异一律待裁决（拒绝猜测） |
| `binary` | 二进制文件，未做文本合并 |
| `too-large` | 超过文本合并字节上限 |
| `array` | 数组双侧都改（不按索引合并） |
| `format` | 分区值形状不合法（不可信载荷） |
| `section` | 分区形态不一致（文件类 vs JSON） |

冲突条目携带 `path`（JSON 分区为**点号路径**、文件类为 `relativePath`、整分区为 `$`）、`kind`（key/file）、
`autoMergeAttempted`，以及 `local`/`remote`/`ancestor` 原始值（只读预览接口只下发**截断并脱敏**后的文本预览）。

### 7.3 基线推进规则（硬约束）

| 情形 | `lastSnapshotId`（远端指针） | 说明 |
|---|---|---|
| push 成功 | → 本次快照 id | 同时写 `ancestorId`（未加密时）与各分区 hash |
| push 被前置检查拒绝 | **不动** | 不 upload、不改 `sections`/`lastSyncAt` |
| apply/合并**失败**（含整体回滚） | **不动** | 失败不是「部分成功」 |
| apply/合并成功但**仍有未裁决冲突**（或用户 `action='skip'`） | **不动**，并写 `pendingMerge` | 未裁决冲突下一轮必须重新出现，绝不静默丢一侧改动 |
| 全部裁决完且应用成功 | → 本次远端快照 id，清空 `pendingMerge` | |

- **基线以「实际落地的本地导出」为准**（不是 merged 载荷）：适配器写回时可能自增
  revision 这类派生字段（真机 settings 即如此），拿 merged 载荷记基线会让下一轮把「只有派生字段不同」
  判成双侧改动 → 每轮重复冲突、无法收敛。重新导出失败时**不推进基线**并如实告警
  （引擎消息键 `sync.baselineRexportFailed`）。
- `ancestor` 目录（本地祖先副本）是**可缺失**的：加密快照不发明文副本、副本会被裁剪 —— 缺失时退化为
  两方合并（所有双侧差异呈现为 `conflict`），**绝不上抛成整轮失败**。
- `pendingMerge` 记录 `{ remoteSnapshotId, sections, since }`（同一远端快照上的连续待裁决保留首次时间）。

### 7.4 push 前置：远端推进检测与 `force`

- 判据：本机已有基线（`lastSnapshotId !== ''`）且远端最新快照 id ≠ 基线 id → **拒绝本次 push**：
  返回 `{ ok:false, snapshotId:'', sections:[], conflict:true, warnings, message }`（**不抛错**），
  零远端写入、基线字段零变化；界面据此引导「先同步远端」。
- 首次同步（无基线）与远端为空**不拦**；`list()` 读不到时**不把「读不到」当「没变」**：照常继续但如实告警。
- `force: true` 是**显式覆盖意图**：跳过该检查直接推送（用户确认要覆盖远端时使用）。
- 通道自身的条件写（§3 索引 `If-Match`）是**另一道**防线：两者互补，不互相替代。

### 7.5 通道能力边界（如实）

| 能力 | git | webdav | s3（五家兼容） | gist |
|---|---|---|---|---|
| 索引条件写（`If-Match` / `If-None-Match`） | 不适用：git 通道的并发保护来自**快进/非快进语义**（工作副本侧 `pull/fetch` + `push`；`push` 被远端拒绝（`! [rejected] ... (fetch first)`）→ `SyncTransportError(kind='conflict')`），**不是** ETag 条件写 | ✅（服务端支持时） | ✅（412/409 视为冲突） | ❌ **弱 ETag 不做 `If-Match`**，退化为无条件 PATCH |
| 大分区内容寻址外置（§3） | ✅ | ✅ | ✅ | ❌（刻意不做，G-34） |
| 加密快照 | ✅ | ✅ | ✅ | ✅（但不外置） |
| 远端推进检测（§7.4） | ✅ | ✅ | ✅ | ✅（依赖 `list` 能读全索引） |

### 7.6 push 失败时的写入面（有意如此）

push 被前置检查拒绝或上传失败时，**基线字段与远端都零变化**；但**设备身份**（`deviceId`/`deviceName`）
可能在本次调用中已落盘一次 —— 它是**本机身份**而不是同步进度，首次生成后幂等（下次不再写），
不会造成「部分同步状态」。实现方不要把它当成失败回滚的一部分。

