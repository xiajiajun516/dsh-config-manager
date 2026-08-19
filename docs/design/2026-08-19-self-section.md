# self 分区：插件自身配置备份设计

> 日期：2026-08-19 · 状态：已实现（v0.1.34 工作区）
> 上游依据：本设计为实现规格；代码为最终事实（`src/adapters/self.ts`、`src/sync/ui-prefs.ts`）。

## 背景与动机

dsh-config-manager 自身有两类"浏览器存储"数据：

1. **localStorage**：`dsh.configManager.syncChannel`（用户上次选择的同步通道 git/webdav）——真实偏好，但换浏览器/换机器即丢失，且 Host 侧 Node 进程读不到（自动同步在浏览器关闭时也运行）；
2. **sessionStorage**：`dsh.cfgMgr.state.v1`（当前 tab / 向导进度 / 面板状态）——运行时 UI 状态，非配置，**保持现状不进备份**（跨机器恢复无意义，且白名单机制已成熟）。

同时发现真实缺口：12 个既有 adapter 均不覆盖**插件自身配置**（`$DSH_HOME/dsh-config-manager/` 下的 `sync-config.json` / `sync-autosync.json` / `sync-selection.json` / `market-config.json`）。用户在 A 机器配置好的同步通道与自动同步，导出备份迁移到 B 机器后不会跟随（凭据走 credentials 槽位能迁移，通道配置本身不能）。

## 决策

### 1. 新增 `self` 分区（文件类分区）

- 分区 id：`self`；ZIP 内前缀 `self/`；`portability='portable'`、`defaultIncluded=true`（Quick Export 与远程同步默认携带）。
- **文件类分区**而非 JSON 分区：与 pluginFiles/skills 同机制（整文件进 ZIP，导入时按相对路径写回），天然保留各配置文件自身的 schema（sync-config 是 v3、market-config 是 v1），免去解析/合并/演进维护。
- **白名单收集**（非递归）：只导出
  `sync/sync-config.json`、`sync/sync-autosync.json`、`sync/sync-selection.json`、`sync/ui-prefs.json`、`market/market-config.json`；
  显式排除 `sync/sync-history.json`（执行记录，属数据非配置）、`market/cache/`（缓存）、`snapshots/`（快照）、`tmp/` `exports/`（临时/导出产物）。
- 复用 `FileCollectionAdapter` 基类（`analyzeImport`/`applyItem`/`validate`），仅覆写 `export` 为白名单收集；基准目录 `dsh-config-manager`（相对 `~/.dsh` 根），与 `core/backup.ts` 的 `FILE_BASES['self']` 一致，快照/回滚路径自动正确。
- **挂载边界**：宿主按 `dataDir` 计算相对 `~/.dsh` 的目录；自定义 `dataDir` 位于 `~/.dsh` 之外时（Host fs 门面 confined to home root）**不挂载** self adapter 并告警，其余分区不受影响。

### 2. `ui-prefs.json`（syncChannel 迁入磁盘）

- 新增 `sync/ui-prefs.json`（schemaVersion=1，`{ lastSyncChannel?: 'git' | 'webdav' }`），原子写 + 损坏回退缺省（仿 `sync-selection.ts`）。
- 前端回填优先级：`status.lastSyncChannel`（磁盘）→ localStorage（升级前遗留兼容）→ `sync-config.transport`；切通道时同步写 localStorage（即时）+ POST `/sync/ui-prefs`（持久化，失败静默降级）。
- localStorage 保留为降级通道，不破坏既有测试与旧版本行为。

### 3. 安全不变量（未破坏）

- 配置文件本身不含凭据值（同步凭据走 DSH credentials 槽位引用，`passwordConfigured` 仅布尔）；文件类分区不进 SecretScanner（与 pluginFiles/skills 同语义）。
- `sync-selection.json` 的 `includeSecrets` 安全兜底（未加密强制关闭）在文件内，随文件原样迁移，逻辑不变。
- `ui-prefs` 仅存非敏感偏好，无 secret。

## 影响面

| 层 | 改动 |
|---|---|
| schema | `SectionId` 增 `self`；`SECTION_FILE_PREFIXES['self']`；`validateSectionData` files 类 |
| core | `backup.ts` `FILE_BASES` + 引擎快照 case |
| adapters | `self.ts`（新）+ registry 挂载（`selfDir` 可关） |
| host | `index.ts`：`selfDir` 计算、`status.lastSyncChannel`、POST `/sync/ui-prefs` |
| sync | `risk.ts` `self: 'low'`（无冲突自动应用）；SyncEngine 经 portable 过滤自动纳入 |
| UI | Export 分类目录加 "Plugin Self Config"（extensions 组）；Sync 通道回填/保存 |
| 测试 | `adapters/self.test.ts`、`sync/ui-prefs.test.ts`（11 用例） |

## 边界与已知限制

- 自定义 `dataDir` 在 `~/.dsh` 之外 → self 分区不挂载（文档化告警）。
- `sync-history.json` 与 market cache 属数据非配置，不备份（与 sessions 分区同哲学：数据不进备份）。
- 版本迁移：本分区为 v1 新增分区，旧备份无 `self` 分区，导入时自然跳过（manifest.sections 判定），无兼容性问题。
