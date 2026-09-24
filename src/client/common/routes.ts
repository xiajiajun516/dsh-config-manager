/**
 * 客户端路由常量 —— **唯一来源**（W4「路由常量单点化」）。
 *
 * 为什么单独一个模块：此前 7 个 api 文件各自手写路由字面量（`CONFIG_MANAGER_API` /
 * `SYNC_API` / `MARKET_API` / `MY_CONFIGS_API` / `LIFECYCLE_API` / `RECOVERY_API` /
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
  consult: `${API_BASE}/consult`,
  profiles: `${API_BASE}/profiles`,
  profilesDetail: `${API_BASE}/profiles/detail`,
  profilesCreate: `${API_BASE}/profiles/create`,
  profilesDelete: `${API_BASE}/profiles/delete`,
  profilesRename: `${API_BASE}/profiles/rename`,
  profilesSelect: `${API_BASE}/profiles/select`,
  starPrompt: `${API_BASE}/star-prompt`,
  releaseNotesPrompt: `${API_BASE}/release-notes-prompt`,
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
  history: `${API_BASE}/sync/history`,
  snapshotsList: `${API_BASE}/sync/snapshots-list`,
  sync: `${API_BASE}/sync/sync`,
  applyItems: `${API_BASE}/sync/apply-items`,
  cancel: `${API_BASE}/sync/cancel`,
  autosync: `${API_BASE}/sync/autosync`,
  selection: `${API_BASE}/sync/selection`,
  config: `${API_BASE}/sync/config`,
  uiPrefs: `${API_BASE}/sync/ui-prefs`,
  rollback: `${API_BASE}/sync/rollback`,
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
 * 灾备路由族。宿主以 **prefix 路由**注册 `API.lifecycle` / `API.crash` / `API.rescue`，
 * 子路径由宿主内部按 path 分发 —— 因此 `lifecycle/status` 一类没有独立宿主字面量，
 * route-parity 测试按前缀覆盖校验（见该测试的 `PREFIX_ROUTED`）。
 */
export const LIFECYCLE_API = {
  base: `${API_BASE}/lifecycle`,
  status: `${API_BASE}/lifecycle/status`,
  snapshot: `${API_BASE}/lifecycle/snapshot`,
  undo: `${API_BASE}/lifecycle/undo`,
  redo: `${API_BASE}/lifecycle/redo`,
  remove: `${API_BASE}/lifecycle/remove`,
  crash: `${API_BASE}/crash`,
  rescue: `${API_BASE}/rescue`,
} as const;

/** Recovery 路由族（宿主以 `API.recovery` prefix 路由注册，operationId 在 path 里）。 */
export const RECOVERY_API = {
  base: `${API_BASE}/recovery`,
  status: `${API_BASE}/recovery/status`,
  /** issue #31：残留锁显式回收（非 operationId 路径；'lock' 不是 UUID）。 */
  lockRecover: `${API_BASE}/recovery/lock/recover`,
} as const;

/** 迁移历史审计路由族（只读列表 + 导出）。 */
export const HISTORY_API = {
  list: `${API_BASE}/history`,
  export: `${API_BASE}/history/export`,
} as const;
