# 远程同步通道子 tab 面板与按通道独立配置设计（2026-08-19）

## 背景与动机

远程同步面板此前只有一个通道选择下拉（Git/WebDAV），且**自动同步（autosync）、同步模式与分区勾选（sync-selection）、是否加密、远端快照列表全部是全局一份**——切换通道时这些设置共享，无法让 Git 仓库与 WebDAV 服务器各用各的策略（例如 GitHub 自动同步 30 分钟、WebDAV 手动推送加密快照）。

需求：远程同步下增加**子 tab 面板**切换 GitHub / WebDAV，两个选项各自拥有独立的：

1. 自动同步（enabled / 间隔 / 运行状态）
2. 同步模式（默认快速导出 / 高级自定义勾选）
3. 是否加密（encrypt / includeSecrets，密码仅内存）
4. 快照（各自远端历史快照列表与选择）

## 数据模型（Host 侧，schema v2 + v1 迁移）

### sync-autosync.json（`src/sync/autosync-config.ts`）

v1（顶层单通道）→ **v2 按通道命名空间**：

```json
{
  "schemaVersion": 2,
  "channels": {
    "git":    { "enabled": false, "interval": "30m", "startupMinIntervalMs": 300000, "consecutiveFailures": 0, "lastRunAt": "…" },
    "webdav": { "enabled": true,  "interval": "5m",  "startupMinIntervalMs": 300000, "consecutiveFailures": 0 }
  }
}
```

- 读取 v1（顶层字段或缺 schemaVersion）→ 归一为 v2 的 **git 通道**（webdav 回退缺省），首次 v2 写回时持久化迁移。
- API：`readAutosyncConfig(dir, channel)` / `writeAutosyncConfig(dir, channel, cfg)`（写一个通道保留另一通道）/ `readAllAutosyncConfigs(dir)`（status 一次返回两通道）。

### sync-selection.json（`src/sync/sync-selection.ts`）

v1（顶层单通道）→ **v2 按通道命名空间**：

```json
{
  "schemaVersion": 2,
  "channels": {
    "git":    { "mode": "default",   "sections": [], "encrypt": false, "includeSecrets": false },
    "webdav": { "mode": "advanced",  "sections": ["settings", "skills"], "encrypt": true, "includeSecrets": true }
  }
}
```

- v1 迁移同 autosync（→ git 通道）；安全兜底不变（`includeSecrets` 必须伴随 `encrypt`）。
- API：`readSyncSelection(dir, channel)` / `writeSyncSelection(dir, channel, sel)` / `readAllSyncSelections(dir)`。

### AutoSyncScheduler（`src/sync/autosync-scheduler.ts`）

- `runOnce(channel, opts)`：按通道读 autosync 配置与 sync-config（新增 `sync-config.ts#readSyncConfigFor(dir, channel)`，从双命名空间取对应通道构造可辨识联合）。
- 定时器按通道各自排期（`timers: Map<channel, timer>`）；`start()` 对每个 enabled 通道执行启动触发下载合并。
- **全局防重保留**（`runs.register('autosync')` + `this.running`）：同一时刻至多执行一个通道的 runOnce，避免两个引擎并发写本地配置；另一通道的定时触发在本轮结束后自然补跑（事件驱动检测兜底，不丢同步）。

## API 路由（`src/index.ts`）

- `GET /sync/status`：新增 `syncSelectionByChannel` / `autosyncByChannel`（两通道 map，一次拉全，UI 按当前 tab 取）；保留旧 `syncSelection` / `autosync`（当前激活通道，兼容旧调用方）。
- `POST /sync/autosync`：body 新增 `transport`（缺省 git），写指定通道后 `scheduler.reload()` 重排双通道定时器；响应为该通道单个状态。`GET` 返回 `{ git, webdav }` map。
- `POST /sync/selection`：body 新增 `transport`（缺省 git），写指定通道并更新该通道的 `selectionCache`；`makeSyncEngine` 按 `cfg.transport` 取对应通道的分区选择。
- `selectionCache` 由单值改为 `Partial<Record<SyncTransportType, SyncSelection>>`。

## UI（Client 侧）

### 通道子 tab 面板（`SyncSettingsView.tsx`）

- 顶部 `modeTabs` 双子 tab：GitHub / WebDAV（复用「模式切换」现有 Pattern，非新样式；busy 时禁用切换防并发）。
- 每个子 tab 内容 = 该通道的：配置表单（git：repoUrl/token/OAuth；webdav：url/username/password/预设）→ 同步状态卡 → 同步模式（默认/高级）→ 加密与密钥导出 → 解密密码 → 一键同步 + 推送/拉取 → 选择历史快照下拉（该通道远端快照）→ 自动同步（该通道开关/间隔/状态）。
- 私有仓库提示 Banner 仅 git 子 tab 常驻；同步历史（`SyncHistoryView`）保持全局置于底部（记录两通道全部操作）。
- 渲染模型纯函数新增（`sync-view.ts`）：`ChannelSyncState`（每通道状态）、`defaultChannelSyncState()`、`channelTabModels(active, busy)`。

### run-store 切片（`SyncStoreSlice`）

- 顶层保留通道表单字段（repoUrl/token/webdavUrl/username/password），新增 `byChannel: { git: ChannelSyncState, webdav: ChannelSyncState }`。
- **安全白名单深处理**：`toPersistedState` 除剔除顶层 token/webdavPassword 外，对 `byChannel` 内每通道的 `encryptPassword/encryptPasswordConfirm/decryptPassword` 同样硬性剔除（测试断言不落盘）。
- 旧版 sessionStorage（顶层 syncMode 形状）→ 迁移为 git 通道的 byChannel 状态。

## 兼容与迁移

- 磁盘配置 v1 → v2 读取时自动归一（git 通道），不破坏既有用户数据；webdav 通道首次使用回退缺省。
- sessionStorage 旧形状 → git 通道迁移（run-store `applyPersisted`）。
- 旧 API 字段（`syncSelection`/`autosync`）保留返回，避免破坏其他调用方。

## 安全约束（不变量不变）

- 密码/token 仍仅内存：推送成功后清空、`toPersistedState` 白名单剔除（含 byChannel 密码类）、刷新后要求重输。
- `includeSecrets` 必须同时 `encrypt`（读写两侧均强制）。
- autosync 无密码，遇加密快照仍跳过并在历史提示（按通道独立记录）。
