# 低频面板状态持久化设计（切 tab / 刷新不丢）

> 日期：2026-08-19 · 状态：已实现（m2 扩展）· 关联：`src/client/run-store.ts`、`ConfigManagerSection.tsx`、`SyncSettingsView.tsx`、`MarketPanel.tsx`、`SnapshotsPanel.tsx`

## 问题

原设计（见 AGENTS.md 旧「状态管理」）：Export / Import 高频流程经模块级 `runStore` + sessionStorage 白名单持久化；Snapshots / Sync / Market 是「低频显式操作」，状态组件内自持、不进 sessionStorage。后果：

- **切 tab**：`ConfigManagerSection` 条件渲染子视图 → 切走即卸载 → 组件内 `useState` 全部丢失（一键同步的差异确认会话、市场逐分区批准、快照 dry-run 计划等一并消失）；
- **刷新**：连模块级内存都清空，仅 Export / Import 可恢复；当前打开的 tab 也回到主视图。

## 方案：低频面板切片镜像进 runStore

复用既有状态中枢，不另造 store，保持 sessionStorage 白名单的单一安全出口。

### run-store 扩展（`src/client/run-store.ts`）

- 顶层新增 `panel: PanelId | null`（`'snapshots' | 'sync' | 'market' | 'about'`）：当前打开的低频面板，刷新后回到原 tab；
- 新增三个切片：
  - `SyncStoreSlice`：通道表单 / 双通道 byChannel 设置（同步模式与分区勾选 / 加密与密钥开关 / 历史快照选中）/ push·pull 报告 / **一键同步差异确认会话** / 回滚入口 / 错误文本；含仅内存的敏感字段（token / webdav 密码 / byChannel 加密与解密密码）+ 瞬态字段（busy / savingConfig）；
  - `MarketStoreSlice`：搜索词 / 类别筛选 / 条目列表 / 详情（含 zipPath 与 dry-run plan）/ 逐分区批准 / 导入结果 / 错误文本（无敏感字段）；
  - `SnapshotsStoreSlice`：选中快照 / dry-run 计划 / 执行报告 / 错误文本（无敏感字段；快照列表本身可随时重载，不持久化）；
- 切片提取纯函数 `toSyncStoreSlice` / `toMarketStoreSlice` / `toSnapshotsStoreSlice`（结构兼容，组件状态可直接传入）——枚举字段，保证 github 流程态、loading 等瞬态不进切片；`busy`/`savingConfig` 为「内存切片」瞬态（切 tab 由模块级单例保留、刷新清空）；
- **白名单**：`toPersistedState()` 解构剔除同步凭据（`token/webdavPassword/encryptPassword/encryptPasswordConfirm/decryptPassword`，含 byChannel 密码类）**与瞬态**（`busy/savingConfig`），`applyPersisted()` 强制归零——刷新后凭据清空要求重输、进行中状态回复空闲（与 Export/Import 的密码语义一致）；
- 版本兼容：`v1` 载荷缺 `panel/sync/market/snapshots` 字段时回退默认切片；旧版顶层 `syncMode` 形状迁移为 git 通道的 byChannel 状态，不破坏旧 sessionStorage 数据。

### 视图接入（commit 同步镜像）

三个视图保持 `useState` 为渲染源，所有状态变更统一走组件的 `commit(next)`：

```ts
const commit = (next: XxxUiState): void => {
  stateRef.current = next
  if (mountedRef.current) setState(next)
  runStore.patch({ sync|market|snapshots: toXxxStoreSlice(next) })  // 总是执行
}
```

1. **挂载恢复**：`useState(initFromStore)` —— 从 `runStore.getSnapshot()` 的切片重建初始状态（敏感字段：切 tab 保留内存值；刷新后已被清空；busy/savingConfig 切 tab 保留）；
2. **同步镜像**：`commit` **不依赖 effect flush**——镜像与 setState 同批执行；**关键收益：异步操作（push/pull/sync/下载/确认导入/执行恢复）完成回调在组件已卸载（切走 tab）时仍能把结果写进 store**，`mountedRef` 只守卫 setState（卸载后跳过），store 写照常 → 切回 tab 时 `initFromStore` 恢复结果；
3. **卸载 flush**：卸载清理 effect 置 `mountedRef=false` 并最后镜像一次（兜底「最后一次改动后立即切 tab」的瞬间）。

### 生命周期前提（宿主侧）

- 一键同步差异确认会话：宿主内存登记（`SyncSessionStore`），TTL 30 分钟，apply/cancel 后删除——刷新不失效，持久化 `confirmSession`（含 items 供 UI 重新渲染）安全；
- 市场下载的暂存 zip：宿主 `tmpDir/market-*.zip`，懒 GC 10 分钟——`detail.zipPath` 刷新后可能已过期，确认导入会得到明确错误 → 重新下载即可（可接受，提示清晰）。

## 安全不变量

- 同步凭据仍**仅内存**：切 tab 由模块级单例保留（等价组件内存），刷新后清空；
- `busy`/`savingConfig` 等瞬态为**内存切片**：切 tab 保留（切回仍显示进行中），刷新时白名单剔除（回复空闲，异步进行中由宿主 `/runs` 等机制恢复，不依赖 UI 瞬态）；
- sessionStorage 唯一写入路径 `toPersistedState()` 白名单剔除所有敏感字段与瞬态字段，新增字段不显式放行即自动不落盘；
- 不新增任何敏感字段进入切片（市场/快照无 secret 输入；同步报告与会话 items 均已是引擎脱敏后的展示文本）。

## 测试

`src/client/run-store.test.ts` 覆盖：

- 同步凭据（token / webdav / 加密 / 解密密码）与瞬态（busy/savingConfig）绝不写入 sessionStorage（白名单键级断言）；
- 同步/市场/快照切片 + 当前面板刷新往返恢复（敏感字段清空、瞬态清空，confirmSession / market detail / restore plan·report 恢复）；
- 旧版 v1 载荷（无新字段）兼容解析 → 默认切片；旧版顶层 syncMode 载荷 → 迁移为 git 通道 byChannel 状态。

## 验证

```bash
npm run typecheck   # tsc --noEmit
npm test            # 847 用例全过（含新增）
npm run bundle      # client bundle 重建成功
```

## 边界与取舍

- SyncConfirmView 的**逐项采纳/冲突决策**是子组件内自持，恢复会话时重置为默认采纳（避免把用户决策序列化进 sessionStorage 的复杂度）；会话本身与 items 列表恢复，用户重新做决策即可；
- GitHub OAuth device flow（userCode / verificationUri）不进切片：一次性授权码短生命周期，切 tab 重置为 idle 可接受；
- 自动同步开关与间隔由宿主持久化并在 `loadStatus` 回填，不进切片（避免双源漂移）；
- **异步操作（push/pull/sync/下载/确认导入/执行恢复）在组件卸载期间的完成回调**：`commit` 的 store 写照常执行（`mountedRef` 只守卫 setState）——切走 tab 后完成的结果（pushReport / pullReport / confirmSession / detail / importResult / plan / report）仍落库，切回恢复；请求永不完成（网络挂起）时 busy 保留为进行中，刷新则清空。
