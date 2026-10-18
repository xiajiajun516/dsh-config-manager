/**
 * 客户端路由常量 —— **唯一来源**（W4「路由常量单点化」）。
 *
 * 为什么单独一个模块：此前 7 个 api 文件各自手写路由字面量（`CONFIG_MANAGER_API` /
 * `SYNC_API` / `MARKET_API` / `MY_CONFIGS_API` / `INCIDENT_API` / `RECOVERY_API` /
 * `HISTORY_API`），src 里还有散落的硬编码路径（如 sync-api 的 consult）——拼错即 404，
 * 而 404 会被 `readJson` 映射成「插件未挂载」，把配置错误伪装成部署问题。
 * 现在：**客户端代码里只允许出现本模块的路由常量**（源码守卫：
 * `src/client/common/route-parity.test.ts`），并与宿主 `src/index.ts` 的路由字面量对账。
 *
 * 维护约定：新增客户端端点 → 在这里加一条常量（或挂到对应路由族），并保证宿主侧有同名字面量；
 * `route-parity.test.ts` 会点名缺失的那条。宿主 **prefix 路由**（recovery / lifecycle，
 * 由宿主内部按 path 分发，无逐条字面量）在该测试里单独登记。
 *
 * 边界：纯字符串模块，无任何 import（client bundle 自包含）。
 */

/** API 前缀（与宿主 `src/index.ts` 的 `API` 常量完全一致）。 */
export const API_BASE = '/api/dsh-config-manager';

/** 主 API 路由族（导出 / 导入 / 快照 / 档案 / 备份文件 / 咨询 / 弹窗偏好）。 */
export const CONFIG_MANAGER_API = {
  base: API_BASE,
  status: `${API_BASE}/status`,
  export: `${API_BASE}/export`,
  exportPreview: `${API_BASE}/export-preview`,
  download: `${API_BASE}/download`,
  upload: `${API_BASE}/upload`,
  analyze: `${API_BASE}/analyze`,
  plan: `${API_BASE}/plan`,
  execute: `${API_BASE}/execute`,
  skipExecute: `${API_BASE}/execute/skip`,
  decryptArchive: `${API_BASE}/decrypt-archive`,
  progress: `${API_BASE}/progress`,
  runs: `${API_BASE}/runs`,
  runsCancel: `${API_BASE}/runs/cancel`,
  runsCancelDecision: `${API_BASE}/runs/cancel/decision`,
  snapshots: `${API_BASE}/snapshots`,
  restore: `${API_BASE}/restore`,
  snapshotDelete: `${API_BASE}/snapshots/delete`,
  snapshotPin: `${API_BASE}/snapshots/pin`,
  snapshotFileDiff: `${API_BASE}/snapshots/file-diff`,
  backupSchedule: `${API_BASE}/backup-schedule`,
  backupScheduleRun: `${API_BASE}/backup-schedule/run`,
  backupFiles: `${API_BASE}/backup-files`,
  backupFilesDelete: `${API_BASE}/backup-files/delete`,
  diskUsage: `${API_BASE}/disk-usage`,
  diskUsageCleanup: `${API_BASE}/disk-usage/cleanup`,
  consult: `${API_BASE}/consult`,
  profiles: `${API_BASE}/profiles`,
  profilesDetail: `${API_BASE}/profiles/detail`,
  profilesCreate: `${API_BASE}/profiles/create`,
  profilesCopy: `${API_BASE}/profiles/copy`,
  profilesDelete: `${API_BASE}/profiles/delete`,
  profilesRename: `${API_BASE}/profiles/rename`,
  profilesLaunch: `${API_BASE}/profiles/launch`,
  profilesStop: `${API_BASE}/profiles/stop`,
  starPrompt: `${API_BASE}/star-prompt`,
  releaseNotesPrompt: `${API_BASE}/release-notes-prompt`,
  updateCheck: `${API_BASE}/update-check`,
  /** 用户显式点「立即更新」后的写动作（官方 dsh plugin 通道，钉住精确版本；见 routes/prefs.ts）。 */
  updateApply: `${API_BASE}/update-apply`,
  /**
   * 外部 agent 来源发现（**只读**：只 stat、不回传绝对路径）。
   * 见 src/routes/foreign.ts。
   */
  foreignSources: `${API_BASE}/foreign-sources`,
  /** 外部来源 → 标准 bundle v1 ZIP（受控临时目录）→ zipPath，供导入向导消费。 */
  foreignImport: `${API_BASE}/foreign-import`,
  /**
   * F-2：官方 session.export 通道（**只读**）。缺 `sessionId` = 探测可用性（回结构化三态），
   * 带 `sessionId` = 流式代理 DSH 自己的 `/api/session.export`（原始日志 ZIP，含子会话与附件）。
   */
  sessionExport: `${API_BASE}/session-export`,
} as const;

/** 远程同步路由族（git / webdav 通道、GitHub device flow、历史快照、自动同步、分区选择）。 */
export const SYNC_API = {
  base: `${API_BASE}/sync`,
  status: `${API_BASE}/sync/status`,
  push: `${API_BASE}/sync/push`,
  pull: `${API_BASE}/sync/pull`,
  githubStart: `${API_BASE}/sync/github/start`,
  githubPoll: `${API_BASE}/sync/github/poll`,
  githubCancel: `${API_BASE}/sync/github/cancel`,
  githubValidate: `${API_BASE}/sync/github/validate`,
  githubRepositories: `${API_BASE}/sync/github/repositories`,
  history: `${API_BASE}/sync/history`,
  snapshotsList: `${API_BASE}/sync/snapshots-list`,
  download: `${API_BASE}/sync/download`,
  snapshotDelete: `${API_BASE}/sync/snapshot-delete`,
  sync: `${API_BASE}/sync/sync`,
  applyItems: `${API_BASE}/sync/apply-items`,
  cancel: `${API_BASE}/sync/cancel`,
  autosync: `${API_BASE}/sync/autosync`,
  selection: `${API_BASE}/sync/selection`,
  config: `${API_BASE}/sync/config`,
  uiPrefs: `${API_BASE}/sync/ui-prefs`,
  /** issue #79：工作副本显式重建（relink 非破坏 / reclone 需 confirm；写动作过 mutation gate） */
  workdirReset: `${API_BASE}/sync/workdir/reset`,
  rollback: `${API_BASE}/sync/rollback`,
  /** T-ui-merge：远程合并**只读**预览（三方合并 + 冲突清单，零写入）。 */
  mergePreview: `${API_BASE}/sync/merge-preview`,
  /** T-ui-merge：按逐项裁决执行合并（写动作过 mutation gate）。 */
  applyMerge: `${API_BASE}/sync/apply-merge`,
  /**
   * cloud-sync 借鉴项 ②：**只读**连通性自检（凭据 / 端点 / 目标容器 / 目录可达）。
   * 失败回 200 + ok:false —— 「测试连接」是预期会失败的诊断动作（→ routes/sync.ts 的 sync/probe）。
   */
  probe: `${API_BASE}/sync/probe`,
} as const;

/** 配置市场路由族（内置单市场：浏览 / 下载 / 发布向导；无 add/remove）。 */
export const MARKET_API = {
  base: `${API_BASE}/market`,
  status: `${API_BASE}/market/status`,
  refresh: `${API_BASE}/market/refresh`,
  browse: `${API_BASE}/market/browse`,
  download: `${API_BASE}/market/download`,
  prepare: `${API_BASE}/market/prepare`,
  /** 受控临时区文件下载端点（发布包 zip 下载复用；GET ?path=，无凭据） */
  fileDownload: `${API_BASE}/download`,
} as const;

/** 「我的配置」路由族（一键上传 / 查看 / 更新 / 收录状态）。 */
export const MY_CONFIGS_API = {
  base: `${API_BASE}/me`,
  status: `${API_BASE}/me/status`,
  upload: `${API_BASE}/me/upload`,
  items: `${API_BASE}/me/items`,
  update: `${API_BASE}/me/update`,
  listing: `${API_BASE}/me/listing`,
  relist: `${API_BASE}/me/relist`,
  delete: `${API_BASE}/me/delete`,
} as const;

/**
 * 事故恢复路由族（crash / rescue 两条 exact 路由）。
 *
 * 灾备快照线（自动快照 / 撤销重做 / 快照库）已按产品定位收敛下线，/lifecycle prefix 路由
 * 随之删除；保留的这两条服务「上次没起来 / 插件把 DSH 搞挂」的处置，浏览器半入口 =
 * recovery/incident-api.ts 的 IncidentApi。
 */
export const INCIDENT_API = {
  crash: `${API_BASE}/crash`,
  rescue: `${API_BASE}/rescue`,
} as const;

/** Recovery 路由族（宿主以 `API.recovery` prefix 路由注册，operationId 在 path 里）。 */
export const RECOVERY_API = {
  base: `${API_BASE}/recovery`,
  status: `${API_BASE}/recovery/status`,
  /** issue #31：残留锁显式回收（非 operationId 路径；'lock' 不是 UUID）。 */
  lockRecover: `${API_BASE}/recovery/lock/recover`,
  /** issue #56：显式解除 SAFE MODE（非 operationId 路径；'safe-mode' 不是 UUID）。 */
  safeModeClear: `${API_BASE}/recovery/safe-mode/clear`,
  /**
   * T5：**只读**会话体检（本机存量会话的损坏/可见性分类）。
   *
   * 路径形态与 'status' / 'lock/recover' 同族（都是 recovery prefix 路由下的子路径）——
   * 不新增注册路由条目，只多一个逻辑端点（见 tests/route/route-parity.test.ts 的说明）。
   */
  sessions: `${API_BASE}/recovery/sessions`,
  /** T8：应用内会话修复（写路径；同样由 recovery prefix 路由内部按 path 分发，不新增注册路由条目）。 */
  sessionsRepair: `${API_BASE}/recovery/sessions/repair`,
  /** T8：按 repairId 回滚一次修复（同上）。 */
  sessionsRollback: `${API_BASE}/recovery/sessions/rollback`,
  /**
   * S7：`/recovery/checkpoints/*` → `/recovery/rollback-points/*`（**工作区 + 会话回滚**，两态；
   * 旧的 checkpoints 常量已随旧检查点代码一起删除）。
   * 挂在 recovery prefix 路由内部按 path 分发，**不新增注册路由条目**（宿主注册路由条目数仍为 79）。
   * `<id>` 段由调用方拼接（宿主侧校验 id 形态，越界一律 404 `record-not-found`）。
   */
  rollbackPoints: `${API_BASE}/recovery/rollback-points`,
  rollbackPointsStorage: `${API_BASE}/recovery/rollback-points/storage`,
  /**
   * issue #88 / #89：回合自动留点的总开关（GET 读 / POST 写；同样由 recovery prefix 路由内部
   * 按 path 分发，不新增注册路由条目）。存在 dataDir/sync/ui-prefs.json，与 /sync/ui-prefs 同一份。
   */
  rollbackPointsPrefs: `${API_BASE}/recovery/rollback-points/prefs`,
  /**
   * issue #89：台账清理（POST，过 mutation gate）—— 只删自动点，guard 与 protected 保留。
   * 用来把「已经涨上去的占用」收回来（改写入原语不会让现有字节自动变小）。
   */
  rollbackPointsCleanup: `${API_BASE}/recovery/rollback-points/cleanup`,
} as const;

/**
 * rollback-points 族的 7 条端点 ↔ RecoveryApi 方法名（**唯一来源**）。
 *
 * 为什么不并进 `RECOVERY_API`：`<id>` 是**占位符**，不是可直接请求的路径 —— 并进去会被
 * `client-route-parity` 当成真实路由去与宿主字面量对账（假红/假绿各一半）。
 * 这里显式登记，`client-route-parity` 逐条对账「路由 ↔ 方法」两个方向。
 */
export const ROLLBACK_POINT_ROUTES = {
  list: { path: RECOVERY_API.rollbackPoints, method: 'rollbackPoints' },
  storage: { path: RECOVERY_API.rollbackPointsStorage, method: 'rollbackPointStorage' },
  detail: { path: `${RECOVERY_API.rollbackPoints}/<id>`, method: 'rollbackPoint' },
  preview: { path: `${RECOVERY_API.rollbackPoints}/<id>/preview`, method: 'rollbackPointPreview' },
  // 单文件前后对照（只读）：预览弹窗里「查看」的数据源（`?path=` 携带记录在案的绝对路径）
  fileDiff: { path: `${RECOVERY_API.rollbackPoints}/<id>/file-diff`, method: 'rollbackPointFileDiff' },
  rewind: { path: `${RECOVERY_API.rollbackPoints}/<id>/rewind`, method: 'restoreRollbackPoint' },
  delete: { path: `${RECOVERY_API.rollbackPoints}/<id>/delete`, method: 'removeRollbackPoint' },
} as const;

/** 迁移历史审计路由族（只读列表 + 导出）。 */
export const HISTORY_API = {
  list: `${API_BASE}/history`,
  export: `${API_BASE}/history/export`,
} as const;
