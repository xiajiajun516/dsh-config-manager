# 同步通道快照格式 v1（sync-channel）

> 性质：**对外契约**（写给第三方实现者）。本文件描述 `/sync/*` 通道在**远端**存放快照的
> 布局与载荷扩展；`bundle-format-v1.md` 描述的是导入/导出用的 ZIP 包，两者共用分区语义，
> 但传输形态不同。改本文件描述的行为必须同时改 `src/sync/` 并重跑 `npm test`。
>
> 实现锚点：`src/sync/layout.ts`（散文件布局）、`src/sync/snapshot-json.ts`（JSON 载荷）、
> `src/sync/blob-store.ts`（内容寻址外置）、`src/sync/session-tombstones.ts`（删除墓碑）、
> `src/sync/git/git-transport.ts` / `src/sync/webdav/webdav-transport.ts`。

## 1. 两种落地形态

| 通道 | 快照位置 | 形态 |
|---|---|---|
| git | `snapshots/<snapshotId>/`（加密快照：`snapshots-encrypted/<snapshotId>.json`） | 散文件目录（`manifest.json` + 按分区平铺） |
| webdav | `<base>/dsh-config-manager/<snapshotId>.json` + 集合索引 `index.json` | 单文件 JSON 载荷 |

散文件目录布局与 `layout.ts` 一致：JSON 分区按 `SECTION_JSON_PATHS` 平铺，
文件类分区按 `SECTION_FILE_PREFIXES` 建目录放真实文件，`manifest.json` 记录
`{ id, createdAt, manifest, sectionHashes }`。

## 2. `manifest` 扩展字段（相对 `bundle-format-v1`）

同步快照的 `manifest` 是 `ManifestSummary`（`src/sync/transport.ts`），除通用字段外还有：

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `transport` | `string?` | 无 | 产生该快照的通道（`git` / `webdav`）；仅供同步历史展示 |
| `encrypted` | `boolean?` | false | `sections` 为 `EncryptedSections` 密文载荷 |
| `sourceHome` | `string?` | 无 | **导出机的 DSH home**。拉取侧与**本机** home 比较后由 Importer 生成自动重定基规则（工作区 `path` + 会话日志首帧 cwd 一并改写）。缺字段 = 不猜（行为与改造前一致） |
| `deletedSessions` | `string[]?` | 无 | **会话删除墓碑**（见 §4）。缺字段 = 旧快照，无墓碑信息 |

## 3. 内容寻址外置（大文件分区）

**目的**：会话日志是「大且多数 push 不变」的内容。内联进每份快照会让 WebDAV 通道
每次复制一遍整份字节（保留 10 份 = 最多 10 份），git 通道每次也要重写工作树。

**布局**：与快照同根共享一个内容寻址仓。

| 通道 | blob 位置 | 索引 |
|---|---|---|
| git | `blobs/<sha256>`（与 `snapshots/` 同级，同一次 commit） | 无（目录即索引） |
| webdav | `<col>/blobs/<sha256>` | `<col>/blobs-index.json`（`{ "<sha256>": <mtimeMs> }`） |

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
