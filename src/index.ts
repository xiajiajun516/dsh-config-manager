/**
 * dsh-config-manager — host half.
 *
 * Mounts the backup / export / import engine (src/core Exporter + Importer
 * three-stage flow) behind the `/api/dsh-config-manager/*` route family that
 * the browser half (`./client`) calls, and wraps the real DSH host services
 * into the engine's `HostContext` facade (src/core/types.ts):
 *
 *   ctx.settings           -> SettingsFacade      (@deepseek-ai/dsh-settings)
 *   ctx.credentials        -> CredentialsFacade   (@deepseek-ai/dsh-credentials)
 *   ctx.plugins            -> PluginsFacade       (官方 dsh plugin CLI 通道 + profile 文件，
 *                                                  见 src/core/plugin-cli.ts)
 *   ctx.workspaceRegistry  -> WorkspaceFacade     (@deepseek-ai/dsh-workspace)
 *   ~/.dsh/cordis.patch.yml-> PatchFileFacade     (js-yaml)
 *   $DSH_HOME files        -> FileSystemFacade    (node:fs, home-relative)
 *   resolveDshHome()       -> homeDir             (@deepseek-ai/dsh-home-paths)
 *
 * Security posture (mirrors the verified @linxin666/dsh-ssh@0.1.12 routes):
 *  - every route carries the loopback-only + same-origin trust fence
 *    (isLoopbackRequest); LAN-exposed deployments never serve these endpoints;
 *  - uploads/exported ZIPs are staged under $DSH_HOME/dsh-config-manager/{tmp,exports}
 *    and every `path`/`zipPath` reference is confined to those roots;
 *  - the encryption password is in-memory only: used to derive the AES-256-GCM
 *    key for secrets.enc, never written to any file, manifest, or log;
 *  - the import execute endpoint refuses to run without `confirm: true`
 *    (core ImportNotConfirmedError safety valve).
 *
 * Optional services are read with ctx.get() at call time (never injected), so
 * the engine keeps working in profiles without the web-only workspace
 * service; hard dependencies are the core `settings`/`credentials` services
 * present in every profile. Plugin install/list no longer depend on the
 * web-only pluginMarketplace/pluginInventory services: both go through the
 * official `dsh plugin --profile <name>` CLI (pnpm forwarder) and read the
 * profile's package.json / node_modules directly.
 */

import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as dshCredentials from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pull the Cordis Context augmentations (webServer / workspaceRegistry)
// and the WebRoute contract without any runtime import.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as yaml from 'js-yaml'

import { Exporter, FileSnapshotStore, Importer, verifySnapshot } from './core/index.ts'
import { ProfileManager, isValidProfileName } from './profiles/index.ts'
import { cleanupCaches } from './core/cache-cleaner.ts'
import { deleteSnapshot, isValidSnapshotId, listSnapshots, planRestore, setSnapshotPinned, validateSnapshotForRestore, type RestorePlan, type RestoreReport, type RestoreSnapshotVerdict } from './core/restore.ts'
import { rollback as performRollback } from './core/rollback.ts'
import { recomputeRecoveryDecision, executeRecovery } from './core/reconcile.ts'
import { verifyRecovery, recoveryTerminalState } from './core/verify-recovery.ts'
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from './core/recovery-orchestrator.ts'
import { redactJournalText, isValidOperationId, isTerminalState, transitionJournalState, JournalStore, type OperationJournal } from './core/journal.ts'
import { RunRegistry, type RunState } from './core/run-registry.ts'
import { registerModelTools } from './core/model-tools.ts'
import { computeConsultReport, type ConsultSourceRef, type ConsultSourceData, type MigratabilityResult } from './core/migration-consult.ts'
import { readExportZipSource, buildLocalSnapshotSource, buildProfileSource } from './core/consult-source.ts'
import { makeMsg, msgOf, zhMsg } from './core/messages.ts'
import type { MsgFunc } from './core/messages.ts'
import {
  cleanupAbortedInstall, hasDshBundlePatch, installErrorFor, installSpecFor, listInstalledPlugins,
  resolveProfileDir, resolveProfileNameFromArgv, runDshPlugin, validateProfileName,
} from './core/plugin-cli.ts'
import type {
  ConfigAdapter, CredentialsFacade, FileSystemFacade, HostContext, ImportDecisions,
  ImportPlan, NamespaceInfo, PatchFileFacade, PlanItem, PlanItemKind, PluginInfo, PluginsFacade,
  SettingsFacade, Snapshot, WorkspaceFacade,
} from './core/types.ts'
import { ImportNotConfirmedError, ImportUserSkippedError } from './core/types.ts'
import { createAdapters, USER_PATCH_FILE } from './adapters/index.ts'
import { createEncryptionProvider, decryptCredentials, decryptArchive, SecurityError, encryptArchive, isArchiveBlob, verifyEncryptedBlob } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { atomicCopyFile, atomicWriteFile } from './utils/atomic-write.ts'
import { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError, type MutationLockContext } from './utils/env-lock.ts'
import { Phase3Recovery, TransactionRecoveryRequiredError, mapLockStateForStartup } from './core/phase3-host.ts'
import type { JournalRunContext } from './core/phase3-host.ts'
import { classifyStartup } from './core/startup-barrier.ts'
import type { MutationLockPort } from './utils/env-lock.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import { WebDavTransport } from './sync/webdav/webdav-transport.ts'
import { DeviceFlowStore, GitHubAuthClient } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import type { ApplyItemsReport } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { BackupScheduler } from './sync/backup-scheduler.ts'
import { readBackupSchedule, writeBackupSchedule } from './sync/backup-schedule-config.ts'
import type { BackupScheduleConfig } from './sync/backup-schedule-config.ts'
import { AUTO_BACKUP_PREFIX, deleteBackupFile, isValidBackupFileName, isValidExportFileName, listBackupFiles, resolveNonCollidingExportName, writeBackupNote } from './sync/backup-files.ts'
import { validateBackupScheduleDraft } from './ui/backup-schedule.ts'
import { readAllAutosyncConfigs, readAutosyncConfig, writeAutosyncConfig } from './sync/autosync-config.ts'
import type { AutosyncConfig, AutosyncInterval, AutosyncRunStatus } from './sync/autosync-config.ts'
import { appendAutosyncEntry, readSyncHistory } from './sync/sync-history.ts'
import {
  MigrationStore, queryHistory, summarizeHistory, renderExport, parseHistoryQuery,
  type MigrationKind, type MigrationResult, type ReadMigrationResult,
  type StoredMigrationHistoryEntry, MIGRATION_HISTORY_DIR,
} from './core/migration-history.ts'
import { loadSyncState, saveSyncState } from './sync/sync-state.ts'
import {
  readSyncConfig, readSyncConfigFor, readFullSyncConfig, writeSyncConfig, validateRepoUrl, validateWebDavUrl,
  isGitConfig, isWebDavConfig,
} from './sync/sync-config.ts'
import type { SyncConfig, FullSyncConfig, SyncTransportType } from './sync/sync-config.ts'
import {
  defaultSyncSelection, effectiveSections, readAllSyncSelections, readSyncSelection, writeSyncSelection,
  SYNC_SELECTION_SCHEMA_VERSION,
} from './sync/sync-selection.ts'
import type { SyncSelection, SyncSelectionMode } from './sync/sync-selection.ts'
import { readUiPrefs, updateUiPrefs } from './sync/ui-prefs.ts'
import type { UiPrefsChannel } from './sync/ui-prefs.ts'
import type { SyncTransport } from './sync/transport.ts'
import { GitMarketReader } from './market/reader.ts'
import { parseMarketIndex, parseMarketItemManifest } from './market/index-parser.ts'
import { BUILTIN_MARKET_URL, isOfficialMarket } from './market/builtin.ts'
import { validateMarketItem } from './market/security.ts'
import { prepareMarketItem } from './market/prepare.ts'
import { validateMarketRepoUrl } from './market/url.ts'
import { marketItemWarnings, toMarketListItem } from './market/view.ts'
import type {
  MarketDownloadResult, MarketIndex, MarketItemDetail, MarketListItem, MarketSummary,
} from './market/types.ts'
import { GitHubAuthRest, GitHubApiError } from './market/github-repos.ts'
import { MyRepoError, MyRepoService, USER_CONFIGS_REPO, userConfigsRepoUrl } from './market/my-repo.ts'
import { createGitFileWriter } from './market/git-file-writer.ts'
import { parseGitHubRepoUrl } from './market/repo-url.ts'
import { StarCache } from './market/star-cache.ts'
import { redact } from './security/redaction.ts'
import { createConfiguredSecretScanner } from './security/secret-scanner.ts'
import type { ConfiguredSecretPatterns } from './security/secret-scanner.ts'
import type { SecretScanner } from './core/types.ts'
import { sha256Hex } from './utils/hashing.ts'
import { MANIFEST_FILE, parseManifest } from './schema/manifest.ts'
import { isFileSection, SECTION_IDS } from './schema/config.ts'
import { stringifyJsonSafe } from './utils/json.ts'
import type { Manifest, SectionId, WorkspaceRecord } from './schema/types.ts'
import { parseZip, zipToBuffer } from './utils/zip.ts'
import { isSameOrChild, normalizePath } from './utils/paths.ts'
import { createLogger, type Logger } from './utils/logger.ts'

/* ---------------------------------------------------------------- identity */

/** Stable cordis plugin name — must match the cordis.patch.yml row id. */
export const name = 'config-manager'

/** Services required before the engine can mount (present in every profile). */
export const inject = ['settings', 'credentials']

/** Plugin version, kept in sync with package.json ("version"). */
const PLUGIN_VERSION = '0.1.55'

/** Plugin own package name — excluded from its own exported plugins list. */
const PLUGIN_NAME = 'dsh-config-manager'

/**
 * Star 引导弹窗指向的 GitHub 仓库（用户引导点 Star 的目标）。
 * 与 package.json 的 repository 字段保持一致；界面不可改（硬编码，参照
 * 「一键上传」目标仓库先例）。仅在 GET /star-prompt 响应中返回，供弹窗按钮跳转。
 */
const STAR_PROMPT_REPO_URL = 'https://github.com/xiajiajun516/dsh-config-manager'

/** 缓存自动清理周期：24 小时（启动即清一次 + 此后每日一次；与 cache-cleaner 保留期独立） */
const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * 内置 GitHub OAuth App 的 client_id（「使用 GitHub 登录」device flow 缺省值）。
 * Client ID 是公开标识（GitHub 官方明确非机密）：内置后所有安装者开箱即用，
 * 无需各自注册/配置 OAuth App；token 仍按用户私有（各自授权、各自存 credentials）。
 * 插件配置的 githubClientId 优先于本默认值（换自有 App 时覆盖）。
 */
export const DEFAULT_GITHUB_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'

/** Plugin config (composition entry); the loader applies it as-is. */
export interface Config {
  /** Master switch; defaults to true. */
  enabled?: boolean
  /** Data root override; defaults to $DSH_HOME/dsh-config-manager. */
  dataDir?: string
  /** 管理的 profile 名（插件依赖读写/安装目标）；缺省取启动参数 --profile，再缺省 'web'。 */
  profile?: string
  /**
   * GitHub OAuth App 的 client_id（「使用 GitHub 登录」device flow）。
   * 缺省使用内置 DEFAULT_GITHUB_CLIENT_ID（公开标识，开箱即用）；
   * 显式配置可覆盖（换自有 OAuth App 时）。
   */
  githubClientId?: string
  /**
   * GitHub OAuth App 的 client_secret（confidential app 必需；public app 可省略）。
   * 只存在于宿主进程：device flow 轮询时由宿主直接发送给 GitHub，绝不回传浏览器/日志。
   */
  githubClientSecret?: string
  /**
   * pluginFiles 分区：额外白名单文件（相对 ~/.dsh 根的单文件名或子路径）。
   * 与默认白名单（dsh-ssh.json、pet.json）合并；用于精确指定要随导出携带的插件配置文件。
   */
  pluginFiles?: string[]
  /**
   * pluginFiles 分区：约定的插件配置目录（相对 ~/.dsh 根，如 'plugin-config'）。
   * 导出时递归收集该目录下所有文件（按相对 ~/.dsh 根的路径写回），实现「往目录放文件即自动随备份携带」。
   */
  pluginFilesDir?: string
  /**
   * F2 个人隐私规则（对齐 dsh-packer config.personalPatterns）：个人化敏感字段名 /
   * 引用字段 / 值形状模式，由部署者注入（个人昵称、本机用户名等），不进开源代码。
   * 未配置时扫描器行为与默认完全一致。
   */
  personalPatterns?: ConfiguredSecretPatterns
}

/* ---------------------------------------------------------------- constants */

/** Route family — must match the browser half's CONFIG_MANAGER_API exactly. */
const API = {
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  // P2-⑫：导出前只读预览（不落盘 ZIP；返回各分区 counts + 估算大小）
  exportPreview: '/api/dsh-config-manager/export-preview',
  download: '/api/dsh-config-manager/download',
  upload: '/api/dsh-config-manager/upload',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  execute: '/api/dsh-config-manager/execute',
  skipExecute: '/api/dsh-config-manager/execute/skip',
  decryptArchive: '/api/dsh-config-manager/decrypt-archive',
  progress: '/api/dsh-config-manager/progress',
  runs: '/api/dsh-config-manager/runs',
  snapshots: '/api/dsh-config-manager/snapshots',
  restore: '/api/dsh-config-manager/restore',
  // P1-⑧：快照管理（手动删除 + 置顶豁免自动清理）
  snapshotDelete: '/api/dsh-config-manager/snapshots/delete',
  snapshotPin: '/api/dsh-config-manager/snapshots/pin',
  // m-backup-schedule：定时全量备份（读/存 backup-schedule.json + 立即执行一次）
  backupSchedule: '/api/dsh-config-manager/backup-schedule',
  backupScheduleRun: '/api/dsh-config-manager/backup-schedule/run',
  // m-backup-files：导出产物管理（列出 exports/*.zip + 删除；下载复用 /download）
  backupFiles: '/api/dsh-config-manager/backup-files',
  backupFilesDelete: '/api/dsh-config-manager/backup-files/delete',
  // Phase 7：迁移前咨询（只读健康评分 + 建议；POST，loopback fence）
  consult: '/api/dsh-config-manager/consult',
  // m-sync-ui：远程同步（Git 私有仓库通道）
  syncStatus: '/api/dsh-config-manager/sync/status',
  syncPush: '/api/dsh-config-manager/sync/push',
  syncPull: '/api/dsh-config-manager/sync/pull',
  // m-github-oauth：GitHub OAuth device flow 登录（start → 展示授权码 → poll → token 入库）
  syncGithubStart: '/api/dsh-config-manager/sync/github/start',
  syncGithubPoll: '/api/dsh-config-manager/sync/github/poll',
  syncGithubCancel: '/api/dsh-config-manager/sync/github/cancel',
  // m-sync-github-valid：校验已存 token 是否有效（决定「已登录」→ 隐藏登录区块）
  syncGithubValidate: '/api/dsh-config-manager/sync/github/validate',
  // P2：同步历史 / 自动应用 / 一键回滚
  syncHistory: '/api/dsh-config-manager/sync/history',
  syncRollback: '/api/dsh-config-manager/sync/rollback',
  // m-sync-v2：一键同步（差异确认会话）+ 自动同步 + 历史快照
  syncSnapshotsList: '/api/dsh-config-manager/sync/snapshots-list',
  syncSync: '/api/dsh-config-manager/sync/sync',
  syncApplyItems: '/api/dsh-config-manager/sync/apply-items',
  syncCancel: '/api/dsh-config-manager/sync/cancel',
  syncAutosync: '/api/dsh-config-manager/sync/autosync',
  // m-sync-selection：同步分区选择持久化（默认/高级模式 + 勾选分区；自动同步共用）
  syncSelection: '/api/dsh-config-manager/sync/selection',
  // m-sync-config：同步通道配置保存（UI 表单自动保存 /「保存配置」按钮；凭据写 DSH credentials）
  syncConfig: '/api/dsh-config-manager/sync/config',
  // m-self：插件 UI 偏好（如上次选择的同步通道；ui-prefs.json，随 self 分区进备份）
  syncUiPrefs: '/api/dsh-config-manager/sync/ui-prefs',
  // m-star-prompt：Star 引导弹窗状态（复用 ui-prefs.json；GET 读 + POST 局部更新）
  starPrompt: '/api/dsh-config-manager/star-prompt',
  // 版本更新内容弹窗状态（复用 ui-prefs.json；GET 读 + POST 局部更新）
  releaseNotesPrompt: '/api/dsh-config-manager/release-notes-prompt',
  // m-market：配置市场（内置单仓库，只读公开仓库：浏览 + 下载 + 安全校验；apply 复用 execute）
  marketStatus: '/api/dsh-config-manager/market/status',
  marketRefresh: '/api/dsh-config-manager/market/refresh',
  marketBrowse: '/api/dsh-config-manager/market/browse',
  marketDownload: '/api/dsh-config-manager/market/download',
  marketPrepare: '/api/dsh-config-manager/market/prepare',
  // m-my-configs：「一键上传 / 我的配置」（目标仓库固定 xiajiajun516/dsh-config-market；
  // 登录复用 sync/github/start|poll|cancel，不重复实现；/me/items 401 → 未登录）
  meStatus: '/api/dsh-config-manager/me/status',
  meUpload: '/api/dsh-config-manager/me/upload',
  meItems: '/api/dsh-config-manager/me/items',
  meUpdate: '/api/dsh-config-manager/me/update',
  meListing: '/api/dsh-config-manager/me/listing',
  meRelist: '/api/dsh-config-manager/me/relist',
  meDelete: '/api/dsh-config-manager/me/delete',
  // m-profiles：配置档案（Profile = 一组可切换的配置快照；Save/List/Delete/Rename/Switch/Import）
  profiles: '/api/dsh-config-manager/profiles',
  profilesSave: '/api/dsh-config-manager/profiles/save',
  profilesDelete: '/api/dsh-config-manager/profiles/delete',
  profilesRename: '/api/dsh-config-manager/profiles/rename',
  profilesAnalyzeSwitch: '/api/dsh-config-manager/profiles/analyze-switch',
  profilesExecuteSwitch: '/api/dsh-config-manager/profiles/execute-switch',
  profilesImport: '/api/dsh-config-manager/profiles/import',
  // Phase 5：recovery 编排（prefix 路由，内部按 path 分发：status / <opId>/preview|confirm|execute|verify|retry|dismiss）
  recovery: '/api/dsh-config-manager/recovery',
  // Phase 6：迁移历史审计（统一历史引擎；只读 GET + 导出）
  history: '/api/dsh-config-manager/history',
  historyExport: '/api/dsh-config-manager/history/export',
} as const

/**
 * 同步 token 的 DSH credentials 引用名（POSIX env-var 形态，满足 CredentialRef 品牌要求）。
 * token 只经 credentialRef 读写（写入由请求体触发，读取在每次 git 网络操作时 resolve），
 * 永不进 repoUrl / argv / commit / 同步文件 / 日志。
 */
export const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN'

/**
 * WebDAV 通道口令的独立 DSH credentials 引用（与 git token 槽位分离）。
 * 口令只经 credentialRef 读写（写入由请求体触发，读取在每次 WebDAV 网络操作时
 * by WebDavTransport 经注入的 getPassword() resolve），永不进 URL / 请求头 / 日志。
 */
export const SYNC_WEBDAV_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD'

/** Cap on JSON request bodies (import plans can be large: 4 MB). */
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

/** Cap on raw upload bodies (staged to the controlled tmp dir). */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024

/* ---------------------------------------------------------- loopback fence */

/** Loopback literal check plus browser same-origin markers (dsh-ssh's fence). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- responses */

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Stream a raw request body to a file, enforcing a byte cap. */
async function writeRequestBodyToFile(req: IncomingMessage, dest: string, maxBytes: number): Promise<number> {
  const sink = createWriteStream(dest)
  let size = 0
  await new Promise<void>((resolvePromise, reject) => {
    req.on('error', reject)
    sink.on('error', reject)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        sink.destroy()
        req.destroy()
        reject(new Error(`upload body exceeds ${maxBytes} bytes`))
      }
    })
    req.pipe(sink)
    sink.on('finish', () => resolvePromise())
  })
  return size
}

/* -------------------------------------------------------------- dsh version */

/** 当前 DSH 应用语言（settings `locale` 命名空间的 preference；缺省 zh）。 */
function resolveAppLanguage(ctx: Context): 'zh' | 'en' {
  try {
    const descriptors = ctx.settings.describe({ redactSecrets: true })
    const locale = descriptors.find((d) => String(d.ns) === 'locale')
    const pref = (locale?.value as { preference?: unknown } | undefined)?.preference
    return pref === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** Resolve the real DSH version from the profile dependency tree (read-only). */
function resolveDshVersion(home: string): string {
  const candidates = [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
    } catch {
      // try the next candidate
    }
  }
  return 'unknown'
}

/* ------------------------------------------------------------ profile name */

/** 解析管理的 profile：config.profile → 启动参数 --profile → 'web'。 */
function resolveProfileName(config?: Config): string {
  const configured = config?.profile
  if (configured !== undefined && configured !== '') return validateProfileName(configured)
  return resolveProfileNameFromArgv()
}

/* ------------------------------------------------------- HostContext facades */

/** Optional Cordis service reader (never injected → never blocks the fiber). */
function readService<T>(ctx: Context, serviceName: string): T | undefined {
  const candidate = ctx.get(serviceName)
  return candidate === null || typeof candidate !== 'object' ? undefined : candidate as T
}

/** Safe settings namespace converter compatible across DSH 0.1.1 and 0.1.2-alpha.x */
const SETTINGS_NAMESPACE_REGEX = /^[a-z][a-z0-9-]*$/
function safeSettingsNamespace(namespace: string): any {
  const fn = (dshSettings as Record<string, unknown>).settingsNamespace
  if (typeof fn === 'function') {
    return (fn as (ns: string) => any)(namespace)
  }
  if (!SETTINGS_NAMESPACE_REGEX.test(namespace)) {
    throw new TypeError(`settings namespace "${namespace}" must match ${String(SETTINGS_NAMESPACE_REGEX)}`)
  }
  return namespace
}

/** Safe credential ref converter compatible across DSH 0.1.1 and 0.1.2-alpha.x */
const CREDENTIAL_REF_REGEX = /^[A-Z_][A-Z0-9_]*$/
function safeCredentialRef(ref: string): any {
  const fn = (dshCredentials as Record<string, unknown>).credentialRef
  if (typeof fn === 'function') {
    return (fn as (r: string) => any)(ref)
  }
  if (!CREDENTIAL_REF_REGEX.test(ref)) {
    throw new TypeError(`credential ref "${ref}" must match ${String(CREDENTIAL_REF_REGEX)}`)
  }
  return ref
}
const credentialRef = safeCredentialRef


/** Settings facade over the real ctx.settings (describe() is namespace-less). */
class DshSettingsFacade implements SettingsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  private provider(): SettingsProvider {
    return this.ctx.settings
  }

  async describe(namespace: string, opts?: { redactSecrets?: boolean }): Promise<NamespaceInfo> {
    const all = this.provider().describe({ redactSecrets: opts?.redactSecrets ?? true })
    const descriptor = all.find((d) => String(d.ns) === namespace)
    if (!descriptor) throw new Error(`namespace not found: ${namespace}`)
    return {
      value: descriptor.value,
      base: descriptor.base,
      revision: descriptor.revision,
      // Real service reports a single applies value; the core contract is an array.
      applies: descriptor.applies === undefined ? undefined : [descriptor.applies],
      secrets: descriptor.secrets ?? [],
    }
  }

  async replace(namespace: string, value: unknown, expectedRevision?: number): Promise<void> {
    await this.provider().replace(safeSettingsNamespace(namespace), value as object, expectedRevision)
  }

  async update(namespace: string, patch: unknown, expectedRevision?: number): Promise<void> {
    await this.provider().update(safeSettingsNamespace(namespace), patch as object, expectedRevision)
  }
}

/** Credentials facade over the real ctx.credentials (values never round-trip). */
class DshCredentialsFacade implements CredentialsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }> {
    const info = await this.ctx.credentials.describe(safeCredentialRef(ref))
    return { configured: info.configured, source: info.source, writable: info.writable }
  }

  async set(ref: string, value: string): Promise<void> {
    await this.ctx.credentials.set(safeCredentialRef(ref), value)
  }

  async unset(ref: string): Promise<void> {
    await this.ctx.credentials.unset(safeCredentialRef(ref))
  }
}

/** 包名 → patch 行 id slug（仿 marketplace ensureRow）：去 @、非法字符→-、连续-合并、去首尾-。 */
export function slugOf(name: string): string {
  return name.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '')
}

/** 某 patch 行（raw）是否激活了指定包名（兼容单行与 insert 块成员）。 */
export function patchRowActivates(raw: unknown, name: string): boolean {
  if (raw === null || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  const entries = Array.isArray(obj['insert']) ? obj['insert'] : [obj]
  return entries.some((e) => e !== null && typeof e === 'object' && (e as Record<string, unknown>)['name'] === name)
}

/**
 * 非 bundle 插件安装成功后，幂等补 profile cordis.patch.yml 激活行
 * （{id: pm-<slug>, name: <pkg>}，仿 marketplace ensureRow）。bundle 包不写行
 * （CLI 的 reconcile 已维护 dsh.profile.bundles）。
 */
export async function ensureActivationRow(patchFile: PatchFileFacade, pkgDir: string, pkg: string): Promise<void> {
  if (hasDshBundlePatch(pkgDir)) return
  const lines = await patchFile.readPatchLines(PROFILE_PATCH_FILE)
  if (lines.some((l) => patchRowActivates(l.raw, pkg))) return
  const id = `pm-${slugOf(pkg)}`
  await patchFile.applyPatchChanges(PROFILE_PATCH_FILE, [
    { lineId: id, raw: { id, name: pkg }, action: 'insert' },
  ])
}

/**
 * Plugins facade：官方 dsh plugin CLI 通道（任何 profile 可用）+ profile 文件
 * 实时清单 + 非 bundle 插件激活行幂等补写。不再依赖 web 专用
 * pluginMarketplace / pluginInventory 服务。
 *
 * 导出 + runner 可注入：M5 单测用 mock runner 验证「无 marketplace 时 install
 * 走 CLI 通道」的行为契约，不触发真实子进程；生产路径默认参数不变。
 */
export class DshPluginsFacade implements PluginsFacade {
  private readonly homeDir: string
  private readonly profile: string
  private readonly patchFile: PatchFileFacade
  private readonly msg: MsgFunc
  private readonly runner: typeof runDshPlugin

  constructor(
    homeDir: string,
    profile: string,
    patchFile: PatchFileFacade,
    runner: typeof runDshPlugin = runDshPlugin,
    msg: MsgFunc = zhMsg,
  ) {
    this.homeDir = homeDir
    this.profile = profile
    this.patchFile = patchFile
    this.runner = runner
    this.msg = msg
  }

  async listInstalled(): Promise<PluginInfo[]> {
    return listInstalledPlugins(this.homeDir, this.profile)
  }

  async install(pkg: string, spec?: string, signal?: AbortSignal): Promise<{ needsRestart: boolean }> {
    const profileDir = resolveProfileDir(this.homeDir, this.profile)
    // 非 registry 来源（github:/git+/file: 等）按来源 spec 安装；registry 包按裸包名装
    // npm 最新版（官方机制）。spec 丢失（旧备份）时退化为裸包名 → pnpm fetch-404，
    // 由 installErrorFor 给出可操作诊断。
    const result = await this.runner(profileDir, this.profile, ['add', installSpecFor(pkg, spec)], undefined, signal)
    // 用户「跳过当前插件」：宿主 kill 了子进程 → 清理半装状态（删依赖行 + 删 node_modules/<pkg>，
    // 防止「package.json 声明了依赖但没装全」导致 DSH 启动失败），再以跳过语义抛错。
    if (result.aborted || (signal !== undefined && signal.aborted)) {
      cleanupAbortedInstall(profileDir, pkg)
      throw new ImportUserSkippedError(this.msg)
    }
    if (result.exitCode !== 0 || result.timedOut) throw installErrorFor(pkg, result)
    // 非 bundle 插件：CLI 只维护 bundles，需补 profile patch 激活行才能加载。
    // 补写失败不吞：包已装但未激活，明确报错并允许重试（幂等补行）。
    try {
      await ensureActivationRow(this.patchFile, join(profileDir, 'node_modules', pkg), pkg)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(this.msg('host.activationRowFailed', { pkg, reason }))
    }
    return { needsRestart: true }
  }
}

/** Workspace facade over the real ctx.workspaceRegistry. */
class DshWorkspaceFacade implements WorkspaceFacade {
  private readonly ctx: Context
  private readonly msg: MsgFunc

  constructor(ctx: Context, msg: MsgFunc = zhMsg) {
    this.ctx = ctx
    this.msg = msg
  }

  private registry(): { list(): { id: unknown; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string; updatedAt: string }[]; get(id: unknown): { title: string; setTitle(title: string): Promise<void> } | undefined; create(path: string, title?: string): Promise<unknown>; delete(id: unknown): Promise<boolean> } | undefined {
    return readService(this.ctx, 'workspaceRegistry')
  }

  async listRecords(): Promise<WorkspaceRecord[]> {
    const registry = this.registry()
    if (!registry) return []
    return registry.list().map((w) => ({
      id: String(w.id),
      path: w.path,
      title: w.title,
      sessionIds: [...w.sessionIds].map(String),
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }))
  }

  async writeRecord(record: WorkspaceRecord): Promise<void> {
    const registry = this.registry()
    if (!registry) throw new Error(this.msg('host.workspaceUnavailable'))
    const existing = registry.get(record.id as unknown as WorkspaceId)
    if (existing) {
      // DSH API 没有「整体覆盖」写通道：标题可更新；path/会话由 registry 依真实目录维护
      if (record.title !== undefined && existing.title !== record.title) await existing.setTitle(record.title)
      return
    }
    await registry.create(record.path, record.title)
  }

  async removeRecord(id: string): Promise<void> {
    const registry = this.registry()
    if (!registry) return
    await registry.delete(id as unknown as WorkspaceId)
  }
}

/** Profile 目录内的 patch 文件（非 bundle 插件激活行写入处，marketplace 同款路径）。 */
const PROFILE_PATCH_FILE = 'cordis.patch.yml'

/** Patch-file facade：用户 patch 层（$DSH_HOME/cordis.patch.yml）+ profile patch 层
 * （$DSH_HOME/profiles/<name>/cordis.patch.yml），两者都在 home 根内。 */
class DshPatchFileFacade implements PatchFileFacade {
  private readonly homeDir: string
  private readonly profile: string
  private readonly msg: MsgFunc

  constructor(homeDir: string, profile: string, msg: MsgFunc = zhMsg) {
    this.homeDir = homeDir
    this.profile = profile
    this.msg = msg
  }

  private patchPath(file: string): string {
    if (file === USER_PATCH_FILE) return join(this.homeDir, USER_PATCH_FILE)
    if (file === PROFILE_PATCH_FILE) return join(this.homeDir, 'profiles', this.profile, PROFILE_PATCH_FILE)
    throw new Error(this.msg('host.patchUnsupported', { user: USER_PATCH_FILE, profile: PROFILE_PATCH_FILE, file }))
  }

  async readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]> {
    const p = this.patchPath(file)
    let text: string
    try {
      text = await fs.readFile(p, 'utf8')
    } catch {
      return []
    }
    let doc: unknown
    try {
      doc = yaml.load(text)
    } catch {
      return []
    }
    if (!Array.isArray(doc)) return []
    const lines: { lineId: string; raw: unknown }[] = []
    for (const item of doc) {
      if (item === null || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const insert = obj['insert']
      if (Array.isArray(insert)) {
        for (const entry of insert) {
          if (entry === null || typeof entry !== 'object') continue
          const id = (entry as Record<string, unknown>)['id']
          if (typeof id === 'string' && id !== '') lines.push({ lineId: id, raw: entry })
        }
        continue
      }
      const id = obj['id']
      if (typeof id === 'string' && id !== '') lines.push({ lineId: id, raw: obj })
    }
    return lines
  }

  async applyPatchChanges(
    file: string,
    changes: { lineId: string; raw: unknown; action: 'insert' | 'update' | 'remove' }[],
  ): Promise<void> {
    const p = this.patchPath(file)

    // 1. Load the current document into an ordered lineId → raw table.
    const rows = new Map<string, unknown>()
    const order: string[] = []
    let doc: unknown
    try {
      doc = yaml.load(await fs.readFile(p, 'utf8'))
    } catch {
      doc = undefined
    }
    if (Array.isArray(doc)) {
      for (const item of doc) {
        if (item === null || typeof item !== 'object') continue
        const obj = item as Record<string, unknown>
        const insert = obj['insert']
        if (Array.isArray(insert)) {
          for (const entry of insert) {
            if (entry === null || typeof entry !== 'object') continue
            const id = (entry as Record<string, unknown>)['id']
            if (typeof id === 'string' && id !== '' && !rows.has(id)) {
              rows.set(id, entry)
              order.push(id)
            }
          }
          continue
        }
        const id = obj['id']
        if (typeof id === 'string' && id !== '' && !rows.has(id)) {
          rows.set(id, obj)
          order.push(id)
        }
      }
    }

    // 2. Apply the changes.
    for (const change of changes) {
      if (change.action === 'remove') {
        if (rows.delete(change.lineId)) {
          const at = order.indexOf(change.lineId)
          if (at >= 0) order.splice(at, 1)
        }
      } else if (change.action === 'insert' || change.action === 'update') {
        if (!rows.has(change.lineId)) order.push(change.lineId)
        rows.set(change.lineId, change.raw)
      }
    }

    // 3. Rebuild: every id row is emitted as a top-level row. The loader treats
    //    a top-level { id, name } row exactly like an `- insert:` block member
    //    (dsh-base patch precedent), so the document stays semantically equal.
    const out: unknown[] = []
    for (const id of order) {
      const raw = rows.get(id)
      if (raw !== undefined) out.push(raw)
    }
    const text = '# rewritten by dsh-config-manager import (original comments not preserved)\n'
      + yaml.dump(out)
    await atomicWriteFile(p, text)
  }
}

/** File facade over $DSH_HOME, confined to the home root. */
class DshFileSystemFacade implements FileSystemFacade {
  private readonly homeDir: string
  private readonly msg: MsgFunc

  constructor(homeDir: string, msg: MsgFunc = zhMsg) {
    this.homeDir = homeDir
    this.msg = msg
  }

  private abs(relPath: string): string {
    const target = resolve(isAbsolute(relPath) ? relPath : join(this.homeDir, relPath))
    if (!isSameOrChild(target, this.homeDir)) throw new Error(this.msg('host.fsPathEscape', { path: relPath }))
    return target
  }

  async readFile(relPath: string): Promise<Uint8Array> {
    return fs.readFile(this.abs(relPath))
  }

  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    // 原子写（Phase 1）：同目录 tmp + fsync + rename，覆盖所有经 HostContext.fs 的配置写
    await atomicWriteFile(this.abs(relPath), data)
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.abs(relPath))
      return true
    } catch {
      return false
    }
  }

  async copy(from: string, to: string): Promise<void> {
    await atomicCopyFile(this.abs(from), this.abs(to))
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(this.abs(relPath), { recursive: true, force: true })
  }

  async listRecursive(dir: string): Promise<string[]> {
    const base = this.abs(dir)
    const out: string[] = []
    const walk = async (current: string): Promise<void> => {
      if (!isSameOrChild(current, this.homeDir)) return
      let entries
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const p = join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(p)
        } else if (entry.isFile()) {
          out.push(normalizePath(relative(this.homeDir, p)))
        }
      }
    }
    await walk(base)
    return out.sort()
  }

  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(this.abs(dir), { recursive: true })
  }
}

/** The engine's HostContext over real DSH services. */
class ConfigManagerHostContext implements HostContext {
  readonly platform: string = process.platform
  readonly arch: string = process.arch
  readonly homeDir: string
  readonly dshVersion: string
  readonly profile: string
  readonly log: Logger
  readonly msg: MsgFunc
  /** 应用语言（resolveAppLanguage；导出历史报告 locale 用） */
  readonly language: 'zh' | 'en'
  readonly settings: SettingsFacade
  readonly credentials: CredentialsFacade
  readonly plugins: PluginsFacade
  readonly workspace: WorkspaceFacade
  readonly patchFile: PatchFileFacade
  readonly fs: FileSystemFacade
  /** Phase 2 跨进程环境锁端口（宿主注入；测试 mock 不注入 → 无锁环境） */
  mutationLock?: MutationLockPort
  /** Phase 3 SAFE MODE：注入同步谓词（读内存标志，供 withMutationLock isBlocked 用；env-lock 不识 policy） */
  safeModeIsBlocked?: () => boolean
  /** Phase 3 恢复/事务（JournalStore + reconcile + SAFE MODE + runJournaled）。apply() 注入。 */
  phase3Recovery?: import('./core/phase3-host.ts').Phase3Recovery

  constructor(ctx: Context, homeDir: string, profile: string) {
    this.homeDir = homeDir
    this.dshVersion = resolveDshVersion(homeDir)
    this.profile = profile
    this.language = resolveAppLanguage(ctx)
    this.msg = makeMsg(this.language)
    const level = process.env.DSH_CONFIG_MANAGER_LOG_LEVEL
    this.log = createLogger({
      level: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
    })
    this.settings = new DshSettingsFacade(ctx)
    this.credentials = new DshCredentialsFacade(ctx)
    this.patchFile = new DshPatchFileFacade(homeDir, profile, this.msg)
    this.plugins = new DshPluginsFacade(homeDir, profile, this.patchFile, undefined, this.msg)
    this.workspace = new DshWorkspaceFacade(ctx, this.msg)
    this.fs = new DshFileSystemFacade(homeDir, this.msg)
  }
}

/* ---------------------------------------------------------------- routes */

/** Controlled staging roots guard. */
function isControlledPath(target: string, roots: string[]): boolean {
  const t = resolve(target)
  return roots.some((root) => isSameOrChild(t, resolve(root)))
}

function dateStamp(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Minimal real dependency check (MCP §15): `which`/`where` probe. */
async function dependencyAvailable(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    await promisify(execFile)(probe, [command], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** 导出/导入执行超时（ms）。正常导出秒级完成；此上限只兜底「宿主卡死」场景，
 * 让客户端拿到明确错误而不是永远停在进度条。 */
const ROUTE_TIMEOUT_MS = 5 * 60 * 1000

/** WebDAV 单请求超时（ms）：慢速 WebDAV（如坚果云限速）上传大快照/读写索引
 * 需要比 git 通道更宽裕的窗口；错误消息会带上实际 ms，便于用户判断。 */
const WEBDAV_TIMEOUT_MS = 120_000

/** 带超时的 Promise：超时以明确错误拒绝（promise 自身由调用方负责，此处只计时）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Decrypt an encrypted backup's credentials (in-memory only; undefined when not applicable). */
async function tryDecryptCredentials(
  zipPath: string,
  password: string | undefined,
): Promise<Map<string, string> | undefined> {
  if (password === undefined || password === '') return undefined
  const raw = await fs.readFile(zipPath)
  const archive = parseZip(raw)
  if (!archive.has(MANIFEST_FILE)) return undefined
  let manifest: Manifest
  try {
    manifest = parseManifest(archive.readEntryText(MANIFEST_FILE))
  } catch {
    return undefined
  }
  if (!manifest.security.encrypted || manifest.security.encryption === null) return undefined
  if (!archive.has('security/secrets.enc')) return undefined
  const blob = archive.readEntry('security/secrets.enc')
  const plaintext = await decryptCredentials(blob, manifest.security.encryption, password)
  let parsed: unknown
  try {
    parsed = yaml.load(plaintext)
  } catch {
    return undefined
  }
  const map = new Map<string, string>()
  if (parsed !== null && typeof parsed === 'object') {
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') map.set(k, v)
    }
  }
  return map
}

/** 解密错误 → 用户可读文本：BAD_PASSWORD 只报「密码错误」（不泄内部细节），其余原文 */
function decryptErrorText(error: unknown, msg: MsgFunc): string {
  if (error instanceof SecurityError && error.code === 'BAD_PASSWORD') {
    return msg('import.encryptedPasswordWrong')
  }
  return error instanceof Error ? error.message : String(error)
}

interface RoutesDeps {
  host: ConfigManagerHostContext
  adapters: ConfigAdapter[]
  exportsDir: string
  tmpDir: string
  snapshotsDir: string
  /** m1：导出/导入 run 注册表（跨请求共享，/progress 与 /runs 的单一事实源） */
  runs: RunRegistry
  /** m-sync-ui：同步状态/配置目录（$DSH_HOME/dsh-config-manager/sync） */
  syncDir: string
  /** m-market：市场目录（$DSH_HOME/dsh-config-manager/market；其下 config/ 与 cache/） */
  marketDir: string
  /** 插件数据根目录（$DSH_HOME/dsh-config-manager；F1 vault 镜像目录 = <dataDir>/vault） */
  dataDir: string
  /** F2 强化 Secret 扫描器（含部署者 personalPatterns）；缺省 = 默认扫描器 */
  scanner?: SecretScanner
  /** m-sync-ui：原始 DSH credentials（resolve token / set token / describe 状态） */
  credentials: CredentialProvider
  /** m-github-oauth：GitHub OAuth App 凭据（device flow 必需 client_id；client_secret 可选） */
  githubClientId?: string
  githubClientSecret?: string
  /** m-backup-schedule：定时全量备份调度器（保存重排 reload / 立即执行 runOnce） */
  backupScheduler: BackupScheduler
  /** Phase 6：迁移历史存储（统一审计史；<dataDir>/migration-history） */
  history: MigrationStore
}

/* -------------------------------------------------- sync 路由（m-sync-ui） */

/** 同步路由可预期的请求级错误（status 缺省 400；引擎/传输失败走 500） */
export class SyncRouteError extends Error {
  readonly status: number

  constructor(message: string, status: number = 400) {
    super(message)
    this.name = 'SyncRouteError'
    this.status = status
  }
}

/** 同步路由错误统一出口：SyncRouteError 用其 status，其余 500（GitTransport 错误消息已脱敏） */
export function writeSyncRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof SyncRouteError) {
    writeJson(res, error.status, { error: error.message })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { error: message })
}

/** parseSyncBody 的凭据写入依赖（只用到 set；测试可注入内存 mock）。 */
export interface ParseSyncBodyDeps {
  credentials: Pick<CredentialProvider, 'set'>
}

/**
 * 解析同步请求体，按 transport 分支返回归一化的 SyncConfig（可辨识联合，schemaVersion=2）。
 * 请求体形状（flat，M4 契约）：
 * - git:    { transport:'git', repoUrl, token? } —— token 非空写 SYNC_CREDENTIAL_REF；
 *   git 可执行文件固定使用系统 PATH 中的 git（不再接受自定义 gitBin）。
 * - webdav: { transport:'webdav', url, username?, password? } —— password 非空写 SYNC_WEBDAV_CREDENTIAL_REF。
 * 返回值不含任何 secret（password/token 只进 credentials，永不回传/落同步文件）。
 */
export async function parseSyncBody(
  body: Record<string, unknown>,
  deps: ParseSyncBodyDeps,
): Promise<SyncConfig> {
  const transport = body['transport'] === 'webdav' ? 'webdav' : 'git'
  if (transport === 'webdav') {
    const url = typeof body['url'] === 'string' ? body['url'].trim() : ''
    if (url === '') throw new SyncRouteError('url is required for webdav')
    const urlError = validateWebDavUrl(url)
    if (urlError !== null) throw new SyncRouteError(urlError)
    const username = typeof body['username'] === 'string' && body['username'] !== '' ? body['username'] : undefined
    const password = typeof body['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
    if (password !== undefined) {
      try {
        await deps.credentials.set(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF), password)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new SyncRouteError(
          `WebDAV 口令写入 DSH credentials 失败：${reason}（请在 DSH 凭据管理里配置 ${SYNC_WEBDAV_CREDENTIAL_REF} 后重试）`,
        )
      }
    }
    return {
      schemaVersion: 2,
      transport: 'webdav',
      webdav: { url, ...(username !== undefined ? { username } : {}) },
    }
  }
  // git 通道（沿用现有逻辑）
  const repoUrl = typeof body['repoUrl'] === 'string' ? body['repoUrl'].trim() : ''
  if (repoUrl === '') throw new SyncRouteError('repoUrl is required')
  const urlError = validateRepoUrl(repoUrl)
  if (urlError !== null) throw new SyncRouteError(urlError)
  const token = typeof body['token'] === 'string' && body['token'] !== '' ? body['token'] : undefined
  if (token !== undefined) {
    try {
      await deps.credentials.set(credentialRef(SYNC_CREDENTIAL_REF), token)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new SyncRouteError(
        `token 写入 DSH credentials 失败：${reason}（请在 DSH 凭据管理里配置 ${SYNC_CREDENTIAL_REF} 后重试）`,
      )
    }
  }
  return {
    schemaVersion: 2,
    transport: 'git',
    git: { repoUrl },
  }
}

/** 由 SyncConfig 合成 WebDAV 通道 baseUrl（webdav.url，尾部规范化带 '/'；git 通道返回 ''）。 */
export function webdavBaseUrl(cfg: SyncConfig): string {
  if (!isWebDavConfig(cfg)) return ''
  return cfg.webdav.url.replace(/\/+$/, '') + '/'
}

/**
 * 补全 webdav 配置缺失的 username（从持久化配置回填；纯函数，不修改入参）。
 * 语义与 password 一致：请求未带 username（表单留空/挂载自动加载）→ 沿用已保存的值；
 * 请求显式带 username → 原样保留（用户新输入优先）。非 webdav / 无持久化 → 原样返回。
 */
export function mergePersistedWebDavUsername(cfg: SyncConfig, persisted: SyncConfig | null): SyncConfig {
  if (!isWebDavConfig(cfg) || (cfg.webdav.username !== undefined && cfg.webdav.username !== '')) return cfg
  if (persisted !== null && isWebDavConfig(persisted)
    && typeof persisted.webdav.username === 'string' && persisted.webdav.username !== '') {
    return { ...cfg, webdav: { ...cfg.webdav, username: persisted.webdav.username } }
  }
  return cfg
}

/**
 * 解析 push 请求体的分区选择（sections）——「高级/自定义导出」模式负载。
 * - 缺省 / 非数组 / 空数组 → undefined（= 全部 portable 推荐分区，即「默认/快速导出」模式）；
 * - 元素必须是 knownIds（已知 adapter id）中的非空字符串，非法 → SyncRouteError（不静默吞错）；
 * - 返回去重后的数组（保持原顺序；重复分区不做重复导出）。
 */
export function extractSyncSections(
  body: Record<string, unknown>,
  knownIds: ReadonlySet<string>,
): SectionId[] | undefined {
  const raw = body['sections']
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: SectionId[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') {
      throw new SyncRouteError('sections must be an array of non-empty strings')
    }
    if (!knownIds.has(item)) {
      throw new SyncRouteError(`unknown sync section: ${item}`)
    }
    if (!seen.has(item)) {
      seen.add(item)
      out.push(item as SectionId)
    }
  }
  return out
}

/** 需要人工决策的 PlanItemKind（一键同步 needsReview 判定 + 逐项确认标记）。
 * 注意：'Install'（安装插件）不在此列 —— 同步拉取差异时插件按「自动安装」处理：
 * 默认采纳、不逐项展示、无需手动选择（product requirement）。 */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error', 'PathMapping',
])

/** 一键同步差异项（client 逐项确认的最小契约；与 sync-api.ts SyncConfirmItem 对齐） */
interface SyncConfirmItem {
  itemId: string
  adapter: SectionId
  kind: PlanItemKind
  description: string
  /** 变更详情（如插件「当前 1.1 vs 导入 1.6」），与导入恢复向导展示一致 */
  detail?: string
  severity: 'info' | 'warning' | 'error'
  defaultAdopt: boolean
  adopt: boolean
  conflict?: { path: string; kind: 'key' | 'file' | 'section'; local?: unknown; remote?: unknown; ancestor?: unknown; diff?: string }
  target?: { adapter: SectionId; ref: string }
}

/** 把 ImportPlan 投影为逐项可确认的差异项（默认采用 Create/Update/Install；人工项默认不采用）。 */
function planToConfirmItems(plan: ImportPlan): SyncConfirmItem[] {
  return plan.items.map((item) => {
    const manual = REVIEW_KINDS.has(item.kind)
    let conflict: SyncConfirmItem['conflict']
    if (item.kind === 'Conflict') {
      const c = (item as { conflict?: { path?: string; kind?: string; local?: unknown; remote?: unknown; ancestor?: unknown } }).conflict
      conflict = {
        path: c?.path ?? '$',
        kind: c?.kind === 'file' ? 'file' : c?.kind === 'section' ? 'section' : 'key',
        ...(c?.local !== undefined ? { local: c.local } : {}),
        ...(c?.remote !== undefined ? { remote: c.remote } : {}),
        ...(c?.ancestor !== undefined ? { ancestor: c.ancestor } : {}),
      }
    }
    return {
      itemId: item.id,
      adapter: item.adapter,
      kind: item.kind,
      description: item.description,
      detail: item.detail,
      severity: item.severity,
      defaultAdopt: !manual,
      adopt: !manual,
      ...(conflict !== undefined ? { conflict } : {}),
      ...(item.target !== undefined ? { target: item.target } : {}),
    }
  })
}

/** autosync interval 类型守卫 */
function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h'
}

/** 自动同步状态响应（GET /sync/autosync 与 POST 回填；读盘计算 elapsedMs）。 */
async function buildAutosyncStatus(dir: string, channel: SyncTransportType): Promise<AutosyncStatusResponse> {
  const cfg = await readAutosyncConfig(dir, channel)
  const elapsedMs = cfg.lastRunAt === undefined || cfg.lastRunAt === ''
    ? -1
    : Math.max(0, Date.now() - Date.parse(cfg.lastRunAt))
  return {
    enabled: cfg.enabled,
    interval: cfg.interval,
    ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
    ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
    ...(cfg.lastRunMessage !== undefined ? { lastRunMessage: cfg.lastRunMessage } : {}),
    consecutiveFailures: cfg.consecutiveFailures,
    elapsedMs,
    ...(cfg.lastRunHistoryId !== undefined ? { lastRunHistoryId: cfg.lastRunHistoryId } : {}),
  }
}

/** 全部通道的自动同步状态（status 路由一次返回；UI 按当前 tab 取对应通道）。 */
async function buildAutosyncStatusByChannel(dir: string): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
  const all = await readAllAutosyncConfigs(dir)
  const build = async (channel: SyncTransportType): Promise<AutosyncStatusResponse> => {
    const cfg = all[channel]
    const elapsedMs = cfg.lastRunAt === undefined || cfg.lastRunAt === ''
      ? -1
      : Math.max(0, Date.now() - Date.parse(cfg.lastRunAt))
    return {
      enabled: cfg.enabled,
      interval: cfg.interval,
      ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
      ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
      ...(cfg.lastRunMessage !== undefined ? { lastRunMessage: cfg.lastRunMessage } : {}),
      consecutiveFailures: cfg.consecutiveFailures,
      elapsedMs,
      ...(cfg.lastRunHistoryId !== undefined ? { lastRunHistoryId: cfg.lastRunHistoryId } : {}),
    }
  }
  return { git: await build('git'), webdav: await build('webdav') }
}

/** GET /sync/autosync 响应类型（与 sync-api.ts AutosyncStatusResponse 对齐） */
interface AutosyncStatusResponse {
  enabled: boolean
  interval: AutosyncInterval
  lastRunAt?: string
  lastRunStatus?: AutosyncRunStatus
  lastRunMessage?: string
  consecutiveFailures: number
  elapsedMs: number
  lastRunHistoryId?: string
}

/* -------------------------------------------------- restore 路由（M4） */

/** POST /restore 请求体校验（纯函数；snapshotId 拒绝路径分隔符防 join 越界）。 */
export type BuildRestoreBodyResult =
  | { ok: true; value: { snapshotId: string; dryRun: boolean } }
  | { ok: false; error: string }

export function buildRestoreBody(body: unknown): BuildRestoreBodyResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid JSON body' }
  }
  const record = body as Record<string, unknown>
  const snapshotId = record['snapshotId']
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    return { ok: false, error: 'snapshotId is required' }
  }
  if (snapshotId === '.' || snapshotId === '..' || snapshotId.includes('/') || snapshotId.includes('\\')) {
    return { ok: false, error: zhMsg('restore.invalidSnapshotId') }
  }
  return { ok: true, value: { snapshotId, dryRun: record['dryRun'] === true } }
}

/**
 * 宿主侧恢复动作执行器（真实执行 restore 计划）：
 * 整文件/文件还原与删除走 ctx.fs（home-relative facade，越界由 facade 再拦一道），
 * blob 读取与 pre-restore 副本走快照目录（node fs），插件卸载走官方 dsh plugin CLI。
 */
export interface RestoreExecutor {
  /** 读快照目录内 blob（相对 snapshotDir） */
  readBlob(blobPath: string): Promise<Uint8Array>
  /** 把当前 home 文件内容复制到 <snapshotDir>/pre-restore/（覆盖/删除前的双保险） */
  savePreRestore(relPath: string): Promise<void>
  existsHome(relPath: string): Promise<boolean>
  writeHome(relPath: string, data: Uint8Array): Promise<void>
  removeHome(relPath: string): Promise<void>
  /** 卸载插件（官方通道）；失败返回 { ok:false, message } */
  uninstallPlugin(name: string): Promise<{ ok: boolean; message?: string }>
}

/**
 * 按计划执行恢复动作（纯执行器；逐项 try/catch 不拖垮其余），
 * 返回与 CLI 一致的诚实报告。顺序 = 计划顺序（整文件 → 插件 → file 补偿）。
 * @param onAction - 每项动作执行回调（宿主路由埋点：更新 RunRegistry 进度；
 *   index/1-based、total=计划动作数、detail=动作描述）
 */
export async function executeRestorePlan(
  plan: RestorePlan,
  exec: RestoreExecutor,
  onAction?: (info: { index: number; total: number; detail: string }) => void,
): Promise<RestoreReport> {
  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  }
  const total = plan.actions.length
  let index = 0
  for (const action of plan.actions) {
    index += 1
    onAction?.({ index, total, detail: action.description })
    try {
      switch (action.kind) {
        case 'hostFileRestore':
        case 'fileRestore': {
          if (action.target === undefined || action.blobPath === undefined) {
            throw new Error('恢复动作缺少 target/blobPath')
          }
          if (await exec.existsHome(action.target)) await exec.savePreRestore(action.target)
          await exec.writeHome(action.target, await exec.readBlob(action.blobPath))
          report.restored.push(action.target)
          break
        }
        case 'hostFileRemove':
        case 'fileRemove': {
          if (action.target === undefined) throw new Error('恢复动作缺少 target')
          if (await exec.existsHome(action.target)) {
            await exec.savePreRestore(action.target)
            await exec.removeHome(action.target)
          }
          report.restored.push(action.target)
          break
        }
        case 'pluginRemove': {
          if (action.pluginName === undefined) throw new Error('恢复动作缺少插件名')
          const result = await exec.uninstallPlugin(action.pluginName)
          if (result.ok) {
            report.removedPlugins.push(action.pluginName)
          } else {
            report.failed.push({ item: `plugin:${action.pluginName}`, reason: result.message ?? '卸载失败' })
          }
          break
        }
        case 'credentialHint':
          report.manualHints.push(action.manualHint ?? action.description)
          break
        case 'skip':
          report.skipped.push(action.description)
          break
        default:
          report.skipped.push(`未知动作 ${String(action.kind)}: ${action.description}`)
      }
    } catch (err) {
      report.failed.push({
        item: action.target ?? action.pluginName ?? action.description,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return report
}

/** 宿主 restore 执行器装配：ctx.fs（home-relative）+ 快照目录（node fs）+ runDshPlugin。 */
function makeRestoreExecutor(snapshotDir: string, host: HostContext, profile: string): RestoreExecutor {
  const profileDir = resolveProfileDir(host.homeDir, profile)
  let seq = 0
  return {
    readBlob: async (blobPath) => {
      const target = resolve(snapshotDir, blobPath)
      if (!isSameOrChild(target, snapshotDir)) throw new Error(msgOf(host)('host.restoreBlobEscape', { blob: blobPath }))
      return fs.readFile(target)
    },
    savePreRestore: async (relPath) => {
      const data = await host.fs.readFile(relPath)
      seq += 1
      const safe = relPath.replace(/[\\/:*?"<>|]/g, '_')
      await fs.mkdir(join(snapshotDir, 'pre-restore'), { recursive: true })
      await fs.writeFile(join(snapshotDir, 'pre-restore', `${String(seq).padStart(4, '0')}-${safe}`), data)
    },
    existsHome: (relPath) => host.fs.exists(relPath),
    writeHome: (relPath, data) => host.fs.writeFile(relPath, data),
    removeHome: (relPath) => host.fs.remove(relPath),
    uninstallPlugin: async (name) => {
      const result = await runDshPlugin(profileDir, profile, ['remove', name])
      if (result.exitCode === 0) return { ok: true }
      const output = `${result.stderr}\n${result.stdout}`.trim()
      const tail = output.split('\n').slice(-8).join('\n') || msgOf(host)('host.restoreNoOutput')
      return { ok: false, message: msgOf(host)('host.restoreUninstallFailed', { name, code: String(result.exitCode), tail }) }
    },
  }
}

/**
 * 解析「一键上传/我的配置」请求体的 form 字段：仅 { name, description?, categories?, mode? }。
 * name 必填（非空字符串，trim 后取）；description 可选字符串；categories 可选字符串数组；
 * mode 可选 'migrate' | 'share'（F6 分享模式，非法值忽略→缺省 migrate）。非法 → null（调用方返回 400）。
 */
function parseMeForm(raw: unknown): { name: string; id?: string; description?: string; categories?: string[]; mode?: 'migrate' | 'share' } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
  if (name === '') return null
  const form: { name: string; id?: string; description?: string; categories?: string[]; mode?: 'migrate' | 'share' } = { name }
  // update 模式的可选显式 id（「更新」按钮预填；upload 时省略）
  const idRaw = obj['id']
  if (typeof idRaw === 'string' && idRaw.trim() !== '') form.id = idRaw.trim()
  const description = obj['description']
  if (typeof description === 'string' && description.trim() !== '') form.description = description.trim()
  const categoriesRaw = obj['categories']
  if (Array.isArray(categoriesRaw)) {
    const categories = categoriesRaw.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    if (categories.length > 0) form.categories = categories
  }
  // F6 分享模式：仅接受字面量 'share' / 'migrate'（其余忽略 → 缺省 migrate），随 form 透传 MyRepoService
  if (obj['mode'] === 'share' || obj['mode'] === 'migrate') form.mode = obj['mode']
  return form
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): { routes: WebRoute[]; scheduler: AutoSyncScheduler; makeSyncEngine: (cfg: SyncConfig) => SyncEngine } {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, marketDir, dataDir, credentials, githubClientId, githubClientSecret, backupScheduler, history } = deps
  const roots = [exportsDir, tmpDir]

  /**
   * Phase 6：迁移历史 best-effort 追加（写失败不阻断操作，但记录/降级，不静默丢）。
   * 所有 destructive/migration 结果确定后调用。历史写盘 ms 级，失败仅日志 + 可选告警字段。
   */
  const tryAppendHistory = async (
    raw: { kind: MigrationKind; result: MigrationResult; sections: string[]; operationId?: string; snapshotId?: string; runId?: string; source: 'api' | 'autosync' | 'backup-scheduler' | 'recovery' | 'cli' | 'internal'; summary: string; error?: string },
  ): Promise<string | undefined> => {
    try {
      const res = await history.append(raw)
      if (!res.ok) {
        host.log.warn('迁移历史写入失败', { kind: raw.kind, error: res.error })
        return res.error
      }
      return undefined
    } catch (error) {
      host.log.warn('迁移历史写入异常', { kind: raw.kind, error: error instanceof Error ? error.message : String(error) })
      return error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 从快照目录读取 entries 的 adapter id 集（用于 restore / snapshot-prune 历史 sections）。
   * 读取失败 → 空数组（best-effort；sections 仅用于审计摘要，不影响功能）。
   */
  const snapshotEntrySections = async (snapshotDir: string): Promise<string[]> => {
    try {
      const raw = await fs.readFile(join(snapshotDir, 'snapshot.json'), 'utf8')
      const parsed = JSON.parse(raw) as { entries?: Array<{ adapter?: string }> } | null
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return []
      return Array.from(new Set(parsed.entries.map((e) => e.adapter).filter((s): s is string => typeof s === 'string' && s !== '')))
    } catch {
      return []
    }
  }

  /**
   * Phase 6：自动快照保留清理（snapshot-prune）迁移历史（best-effort）。
   * 由 FileSnapshotStore.prune 经 onPrune 回调触发；fire-and-forget 不阻塞保存。
   */
  const tryAppendSnapshotPrune = async (removedIds: string[]): Promise<void> => {
    if (removedIds.length === 0) return
    try {
      await history.append({
        kind: 'snapshot-prune',
        result: 'success',
        sections: [],
        source: 'api',
        summary: `自动保留清理删除 ${removedIds.length} 个旧快照`,
      })
    } catch (error) {
      host.log.warn('快照保留清理历史写入失败（best-effort）', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** m-github-oauth：宿主侧设备码登记表 + auth 客户端（进程生命周期；device_code 只存内存） */
  const githubFlows = new DeviceFlowStore()
  const githubAuth = new GitHubAuthClient()
  const msg = host.msg

  /** 导入 run 的「当前计划项」中止控制器（/execute 登记，/execute/skip 定位 abort）。
   * 进程生命周期内存登记；同 kind 并发被 RunRegistry 拒绝，单 run 恒只有一个当前项。 */
  const runAbortControllers = new Map<string, AbortController>()

  /** 已知 adapter id 集合（push 请求体 sections 校验用）。 */
  const knownSyncSectionIds = new Set(adapters.map((a) => a.id))
  /** 可同步分区目录（status 回填 UI「高级/自定义导出」勾选列表；只含 portable，与 SyncEngine 一致）。 */
  const syncSectionCatalog = adapters
    .filter((a) => a.portability === 'portable')
    .map((a) => ({ id: a.id, displayName: a.displayName, portability: a.portability, defaultIncluded: a.defaultIncluded }))

  const makeImporter = (): Importer => new Importer({
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({
      dir: snapshotsDir,
      // Phase 4 F3：active/quarantine 未收敛 journal 引用的 snapshot 绝不自动 prune
      referencedSnapshotIds: () => host.phase3Recovery?.store.listReferencedSnapshotIds() ?? Promise.resolve(new Set<string>()),
      // Phase 6：自动保留清理 → snapshot-prune 迁移历史（best-effort）
      onPrune: (removedIds) => { void tryAppendSnapshotPrune(removedIds) },
    }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
    msg,
  })

  /** m-profiles：配置档案管理器（<dataDir>/profiles/<name>/profile.json；切换复用同一快照/回滚管道） */
  const profiles = new ProfileManager({
    dataDir,
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({
      dir: snapshotsDir,
      // Phase 4 F3：recovery 引用保护
      referencedSnapshotIds: () => host.phase3Recovery?.store.listReferencedSnapshotIds() ?? Promise.resolve(new Set<string>()),
      // Phase 6：自动保留清理 → snapshot-prune 迁移历史（best-effort）
      onPrune: (removedIds) => { void tryAppendSnapshotPrune(removedIds) },
    }),
  })

  /** Fence + method guard (mirrors dsh-ssh). */
  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /**
   * Phase 2 跨进程锁路由门（destructive 公共入口）。
   * 包裹一个 mutation handler：进入前 acquire GLOBAL 环境锁（无 lock 配置 → 直接放行），
   * 被另一进程/操作持有（含同进程另一操作）→ 409/423 拒绝；执行后 finally 释放。
   * 嵌套调用（rollback / applyItems 内部 executeImportPlan）在外层已持锁区域内运行，绝不 reacquire。
   * Phase 3 SAFE MODE：isBlocked 注入谓词（host.safeModeIsBlocked）被挡 → 423（不执行 destructive）。
   */
  const withMutationGate = (
    op: string,
    handler: (req: IncomingMessage, res: ServerResponse, lockCtx?: MutationLockContext, journalCtx?: JournalRunContext) => Promise<void>,
    opts?: { journaled?: boolean; deferredSnapshot?: boolean },
  ): ((req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    return async (req, res) => {
      try {
        await runWithMutationLock(host.mutationLock, { op, isBlocked: () => host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
          // Step 3 P0-A：所有被 gate 覆盖的 destructive 路由在已持锁下创建 durable journal
          // （runJournaled 不 double-acquire、不 release；锁由本 gate 的 finally 释放）。
          if (host.phase3Recovery !== undefined && (opts?.journaled ?? true) && lockCtx !== null) {
            await host.phase3Recovery.runJournaled({
              operationType: op,
              lockCtx,
              // Phase 4：生产 snapshot 接线。deferredSnapshot = plan 在 handler 内解析后，
              // 引擎创建 op-bound snapshot 并 bindSnapshot + markApplying（首个 destructive side effect 前）。
              deferredSnapshot: opts?.deferredSnapshot ?? false,
              fn: async (journalCtx) => { await handler(req, res, lockCtx, journalCtx) },
            })
          } else {
            await handler(req, res, lockCtx ?? undefined, undefined)
          }
        })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          // 内部诊断（op/reason）进日志；用户只看到友好文案（error.message 恒为中文友好版，
          // 不暴露环境锁/op/路径等技术细节）。
          host.log.warn(`mutation lock blocked: op=${error.op}`)
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          return
        }
        // 非 423：若已由 runJournaled 置 SAFE MODE/失败，保持既有错误语义（400/500）
        if (error instanceof TransactionRecoveryRequiredError) {
          writeJson(res, 423, { error: error.message, code: 'transaction-recovery-required' })
          return
        }
        throw error
      }
    }
  }

  // ------------------------------------------------- sync 路由装配（m-sync-ui）
  // 请求级装配：每次 push/pull 从请求体取 repoUrl，token 非空先写入 DSH
  // credentials（只存值不落盘同步文件/日志），git 网络操作时经 resolve 现取 ——
  // 与 GitTransport「token 只从注入 provider 读取」的安全契约完全对齐。

  /**
   * 解析同步请求体并补全缺失字段（委托给导出的 parseSyncBody，便于单测）。
   * username 回退：webdav 请求体未带 username（如挂载时 snapshotsList 自动加载、
   * 表单留空后直接同步）时，从持久化 sync-config 回填已保存的 username——
   * 否则 WebDavTransport 构造会因空 username 抛错，导致「保存过配置仍无法列出快照」。
   * 语义与 password 一致：留空 = 沿用已保存凭据。
   */
  const prepareSync = async (body: Record<string, unknown>): Promise<SyncConfig> => {
    const cfg = await parseSyncBody(body, { credentials })
    if (isWebDavConfig(cfg) && (cfg.webdav.username === undefined || cfg.webdav.username === '')) {
      try {
        const persisted = await readSyncConfig(syncDir)
        return mergePersistedWebDavUsername(cfg, persisted)
      } catch {
        return cfg // 读失败保持原值（空 username 由 WebDavTransport 构造校验兜底报错）
      }
    }
    return cfg
  }

  /** 同步分区选择缓存（按通道；sync-selection.json；makeSyncEngine 同步读取用，保存路由更新）。
   *  缺失通道 = 尚未加载（启动竞态窗口）；读取/使用处兜底 defaultSyncSelection。 */
  const selectionCache: Partial<Record<SyncTransportType, SyncSelection>> = {}
  void readAllSyncSelections(syncDir).then((all) => {
    selectionCache.git = all.git
    selectionCache.webdav = all.webdav
  }).catch(() => { /* 读失败保持缺省 */ })

  /** 确保指定通道缓存已加载（status/save 路由调用；启动竞态兜底）。 */
  const ensureSelectionLoaded = async (channel: SyncTransportType): Promise<SyncSelection> => {
    const cached = selectionCache[channel]
    if (cached !== undefined) return cached
    try {
      const sel = await readSyncSelection(syncDir, channel)
      selectionCache[channel] = sel
      return sel
    } catch {
      const fallback = defaultSyncSelection()
      selectionCache[channel] = fallback
      return fallback
    }
  }

  /** 指定通道的分区选择视图（{ mode, sections, encrypt, includeSecrets }，无 schemaVersion/密码）。 */
  const selectionView = async (channel: SyncTransportType): Promise<{ mode: SyncSelectionMode; sections: SectionId[]; encrypt: boolean; includeSecrets: boolean }> => {
    const sel = await ensureSelectionLoaded(channel)
    return { mode: sel.mode, sections: sel.sections, encrypt: sel.encrypt, includeSecrets: sel.includeSecrets }
  }

  /** 全部通道的分区选择视图（status 路由一次返回；UI 按当前 tab 取对应通道）。 */
  const selectionViewByChannel = async (): Promise<Record<SyncTransportType, { mode: SyncSelectionMode; sections: SectionId[]; encrypt: boolean; includeSecrets: boolean }>> => {
    const all = await readAllSyncSelections(syncDir)
    selectionCache.git = all.git
    selectionCache.webdav = all.webdav
    const view = (sel: SyncSelection): { mode: SyncSelectionMode; sections: SectionId[]; encrypt: boolean; includeSecrets: boolean } =>
      ({ mode: sel.mode, sections: sel.sections, encrypt: sel.encrypt, includeSecrets: sel.includeSecrets })
    return { git: view(all.git), webdav: view(all.webdav) }
  }

  /** 构造 SyncEngine：按 transport 分支构造对应传输（git → GitTransport；webdav → WebDavTransport）。
   *  同步范围（sections）来自持久化分区选择：advanced 模式 → 只处理勾选分区，
   *  自动同步（merge/apply/push 全链路）与手动 push 共用此配置。 */
  const makeSyncEngine = (cfg: SyncConfig): SyncEngine => {
    let transport: SyncTransport
    if (isWebDavConfig(cfg)) {
      transport = new WebDavTransport({
        baseUrl: webdavBaseUrl(cfg),
        username: cfg.webdav.username ?? '',
        credentials: {
          getPassword: async () => {
            const resolved = await credentials.resolve(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF))
            return resolved?.value ?? ''
          },
        },
        // 显式传超时：不依赖默认值，慢速 WebDAV 上传大快照有足够窗口
        timeoutMs: WEBDAV_TIMEOUT_MS,
        msg,
      })
    } else {
      transport = new GitTransport({
        repoUrl: cfg.git.repoUrl,
        workDir: join(syncDir, 'work'),
        credentials: {
          getToken: async () => {
            const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
            return resolved?.value ?? ''
          },
        },
        msg,
      })
    }
    const channel: SyncTransportType = isWebDavConfig(cfg) ? 'webdav' : 'git'
    const sections = effectiveSections(selectionCache[channel] ?? defaultSyncSelection())
    return new SyncEngine({
      ctx: host,
      transport,
      stateDir: syncDir,
      adapters,
      importer: makeImporter(),
      localSnapshotsDir: join(syncDir, 'snapshots'),
      zipDir: tmpDir,
      msg,
      ...(sections === undefined ? {} : { sections }),
    })
  }

  /** 一键同步差异确认会话存储（进程内存；/sync/sync 预览 → /sync/apply-items 逐项执行解耦） */
  const syncSessions = new SyncSessionStore()

  /** 自动同步后台调度器（宿主进程生命周期，不依赖浏览器） */
  const scheduler = new AutoSyncScheduler({
    syncDir,
    host,
    makeSyncEngine,
    msg,
    runs,
    mutationLock: host.mutationLock,
    isBlocked: () => host.safeModeIsBlocked?.() ?? false,
    phase3Recovery: host.phase3Recovery,
    // Phase 6：autosync 既写 sync-history.json（既有语义），也写统一迁移历史（COMPLETE 不变量）。
    appendHistoryFn: async (entry) => {
      await appendAutosyncEntry(syncDir, entry).catch(() => undefined)
      await history.append({
        kind: 'autosync',
        result: entry.status === 'success' ? 'success' : entry.status === 'skipped' ? 'skipped' : 'failed',
        sections: entry.appliedSections ?? [],
        source: 'autosync',
        summary: `自动同步 ${entry.direction}${entry.transport !== undefined ? `（${entry.transport}）` : ''}`,
        error: entry.status === 'failed' ? (entry.error ?? entry.skipReason) : undefined,
      }).catch(() => undefined)
    },
  })
  // P1-B：调度器不再在 makeRoutes 内同步 start —— 由 apply() 在「启动 recovery 分类完成后、仅 NORMAL」时启动。

  // ------------------------------------------------ market 辅助（m-market）
  // 目录：<marketDir>/cache/<url-hash>/（index/条目缓存）
  //       + <marketDir>/work/<url-hash>/（git 只读工作副本，--depth 1）。无任何凭据。
  const marketCacheRoot = join(marketDir, 'cache')
  const marketWorkRoot = join(marketDir, 'work')
  const urlHash = (url: string) => sha256Hex(url).slice(0, 32)
  const marketCacheIndex = (url: string) => join(marketCacheRoot, urlHash(url), 'index.json')
  const marketCacheItemDir = (url: string) => join(marketCacheRoot, urlHash(url), 'items')
  const marketWorkDir = (url: string) => join(marketWorkRoot, urlHash(url))

  /**
   * 进程生命周期标记：本次 dsh 启动后市场是否已成功刷新过一次（内存态，dsh 重启后自动归零）。
   * 供「首次打开市场页自动更新一次市场」：MarketPanel 挂载时读 status 返回的
   * bootAutoRefreshed 判断是否要自动拉取；refresh（含手动「拉取最新」）成功后置位。
   */
  let marketBootAutoRefreshed = false

  /** 请求级装配只读 GitMarketReader（公开市场无凭据；url = BUILTIN_MARKET_URL，已由 validateRepoUrl 拒绝 userinfo）。 */
  const makeMarketReader = (): GitMarketReader => new GitMarketReader({ msg, timeoutMs: 60_000 })

  /**
   * 市场条目来源仓库 star 缓存（docs/design/2026-08-21-market-star-filter-sort-design.md §3.1.3）。
   * - **匿名查询**（getRepoStarsPublic，不注入 token）——守住「市场端点零凭据」安全不变式；
   * - 按仓库 URL 去重 + 1 小时 TTL + 失败降级（单仓失败显示「—」，不影响整体浏览）；
   * - tokenProvider 给空函数（requestPublic 不调用它，仅满足构造签名）。
   */
  const marketStarCache = new StarCache({
    query: async (url: string): Promise<number | null> => {
      const ref = parseGitHubRepoUrl(url)
      if (ref === null) return null // 非 github.com 仓库 → 无 star 数据（显示「—」）
      return new GitHubAuthRest({ tokenProvider: async () => '' }).getRepoStarsPublic(ref.owner, ref.repo)
    },
  })

  /** 读缓存的 index.json（结构校验通过才返回，否则 null）。 */
  async function readCachedIndexObj(url: string): Promise<MarketIndex | null> {
    try {
      const raw = await fs.readFile(marketCacheIndex(url), 'utf8')
      const res = parseMarketIndex(raw)
      return res.ok ? res.index : null
    } catch {
      return null
    }
  }

  /** 由配置条目构建市场摘要（name/itemCount/lastFetchedAt 来自缓存 index，可空）。 */
  async function buildMarketSummary(e: { url: string; addedAt: string }): Promise<MarketSummary> {
    const s: MarketSummary = { url: e.url, addedAt: e.addedAt }
    const idx = await readCachedIndexObj(e.url)
    if (idx) {
      if (idx.name) s.name = idx.name
      s.itemCount = idx.items.length
      try {
        const st = await fs.stat(marketCacheIndex(e.url))
        s.lastFetchedAt = st.mtime.toISOString()
      } catch { /* 无缓存/读取失败 → 省略 lastFetchedAt */ }
    }
    return s
  }

  /** 条目是否已有完整缓存（manifest + config.zip）。 */
  async function itemCached(url: string, itemId: string): Promise<boolean> {
    try {
      await fs.access(join(marketCacheItemDir(url), itemId, 'config.zip'))
      await fs.access(join(marketCacheItemDir(url), itemId, 'manifest.json'))
      return true
    } catch {
      return false
    }
  }

  /** 写条目缓存（manifest + config.zip）供离线重复查看。内容始终视为不可信。 */
  async function writeItemCache(url: string, itemId: string, manifestRaw: string, zipBytes: Uint8Array): Promise<void> {
    const dir = join(marketCacheItemDir(url), itemId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), manifestRaw, 'utf8')
    await fs.writeFile(join(dir, 'config.zip'), zipBytes)
  }

  /**
   * 清理滞留在 tmpDir 的过期市场暂存 zip（market-*.zip）。
   * market/download 每次暂存新 zip 前调用（懒 GC）：保留最近 RETENTION_MS 内的（供刚下载
   * 后立即执行的 /execute 消费），清理更旧的 —— 防止未确认导入的暂存文件无限堆积。
   * 一次性尽力而为：任何读取/删除失败不影响主流程。
   */
  const MARKET_TMP_RETENTION_MS = 10 * 60 * 1000
  async function pruneStagedMarketZips(): Promise<void> {
    try {
      const names = await fs.readdir(tmpDir)
      const now = Date.now()
      for (const name of names) {
        // market-*.zip（未确认导入的暂存）与 publish-*.zip（发布向导产物）都纳入保留策略
        if ((!name.startsWith('market-') && !name.startsWith('publish-')) || !name.endsWith('.zip')) continue
        const p = join(tmpDir, name)
        try {
          const st = await fs.stat(p)
          if (now - st.mtimeMs > MARKET_TMP_RETENTION_MS) await fs.rm(p, { force: true, recursive: true })
        } catch {
          // 单文件 stat/删除失败 → 跳过（尽力而为）
        }
      }
    } catch {
      // tmpDir 读取失败 → 跳过（尽力而为）
    }
  }

  // -------------------------------------------------- me 装配（m-my-configs）
  // 「一键上传 / 我的配置」：GitHub REST 客户端 + 上传编排。
  // token 只经 credentials.resolve(SYNC_CREDENTIAL_REF) 在宿主内部读取（与 git 同步共用
  // 同一凭据槽），值绝不落盘 / 进日志 / 回传浏览器；gitWriter 写用户仓库与 fork 分支，
  // 安全模式与 GitTransport 一致（credential helper store 临时文件 0600 用后即删）。
  const meTokenProvider = async (): Promise<string> => {
    const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
    return resolved?.value ?? ''
  }
  const meGitHubRest = new GitHubAuthRest({ tokenProvider: meTokenProvider })
  const meService = new MyRepoService({
    prepare: prepareMarketItem,
    rest: meGitHubRest,
    gitWriter: createGitFileWriter({ credentials: { getToken: meTokenProvider } }),
    tokenProvider: meTokenProvider,
    now: () => new Date(),
  })

  // ============================================================ Phase 5 recovery orchestration
  // Recovery 路由**禁用 withMutationGate**（避免 double-journal：recovery 复用被恢复 operation 的
  // 现有 journal，不新建）。mutation 路由只经 withMutationLock（Phase 2 GLOBAL 锁）+ loopback fence，
  // **不传 isBlocked**（recovery 是解决 SAFE MODE 的机制，若被 SAFE MODE 阻断会死锁）。
  // 只读路由（status/preview）不持锁。权威 snapshotId 只来自 j.snapshotId（不接受请求体覆盖）。
  // 编排逻辑在 src/core/recovery-orchestrator.ts（可测纯编排层）。
  const recoveryOrchestrator = createRecoveryOrchestrator({
    store: host.phase3Recovery?.store ?? new JournalStore({ transactionsDir: join(dataDir, 'transactions') }),
    runs,
    snapshotsDir,
    host,
    msg,
    snapshotExists: async (snapshotId, binding) => {
      if (host.phase3Recovery === undefined) return false
      return host.phase3Recovery.recoveryHooks.snapshotExists(snapshotId, binding)
    },
    // 动态 getter：环境指纹在 fire-and-forget 启动分类块（initFingerprint）完成后才就绪，
    // 创建期捕获会拿到 'unknown' 初值 → 后续 recovery API 误判 WRONG_ENVIRONMENT。
    // 改动态读取保证 API 调用时取到真实指纹（recovery-orchestrator 已改为 getter 语义）。
    getEnvironmentFingerprint: () => host.phase3Recovery?.recoveryEnvFingerprint ?? 'unknown',
    // 清除 SAFE MODE：同时重置内存标志（isBlocked 读它）与 durable 标记。
    // 仅当 recovery 成功且无其他未解决 incident 时由编排器调用（§5.3 / §10.2）。
    clearSafeMode: async () => {
      if (host.phase3Recovery !== undefined) await host.phase3Recovery.clearSafeMode()
    },
  })
  /** 构造 recovery 执行器（restore / rollback），供 execute/retry 注入（runId 用于进度埋点）。 */
  const makeRecoveryExecutors = (runId: string): RecoveryExecutorFns => ({
    performRestore: async (snapshotId) => {
      const dir = join(snapshotsDir, snapshotId)
      const restoreOpts = {
        snapshotDir: dir, homeDir: host.homeDir, profile: host.profile, settingsPath: undefined, msg,
        snapshotsRoot: snapshotsDir, environmentFingerprint: host.phase3Recovery?.recoveryEnvFingerprint ?? 'unknown', requireOperationBound: true,
      }
      const plan = await planRestore(restoreOpts)
      const report = await executeRestorePlan(plan, makeRestoreExecutor(dir, host, host.profile), (info) => {
        runs.update(runId, { section: 'recovery', item: info.index, itemTotal: info.total, detail: info.detail })
      })
      return { full: report.failed.length === 0, failed: report.failed.map((f) => f.item) }
    },
    performRollback: async (snapshotId) => {
      const store = new FileSnapshotStore({ dir: snapshotsDir })
      const snap = await store.load(snapshotId)
      const report = await performRollback({ ctx: host, snapshot: snap, store, adapters })
      return { full: report.full, failed: report.failed.map((f) => f.item) }
    },
  })

  const routesList: WebRoute[] = [
    // ------------------------------------------------------------- status
    {
      kind: 'exact',
      path: API.status,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, {
          ready: true,
          pluginVersion: PLUGIN_VERSION,
          dshVersion: host.dshVersion,
          platform: host.platform,
          arch: host.arch,
        })
      },
    },
    // ------------------------------------------------------------- export
    {
      kind: 'exact',
      path: API.export,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const includeSecrets = body['includeSecrets'] === true
        const only = Array.isArray(body['only'])
          ? body['only'].filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x))
          : undefined
        // P0-④：自定义导出文件名（可选；缺省自动命名）。安全：合法 zip 文件名才接受
        // （isValidExportFileName 拒绝路径分隔符/非法字符）；输出恒在 exportsDir 内。
        // 兼容两种 key：outPath（ExportFlow 透传，语义=文件名）与 fileName（显式自定义名）。
        const fileNameRaw = typeof body['outPath'] === 'string' && body['outPath'] !== ''
          ? body['outPath']
          : body['fileName']
        const customFileName = isValidExportFileName(fileNameRaw) ? fileNameRaw : null
        // P0-④：导出备注（可选；写入 exports/.backup-notes.json，随 self 分区迁移）
        const note = typeof body['note'] === 'string' && body['note'].trim() !== ''
          ? body['note'].trim().slice(0, 200)
          : null
        // Encryption password is in-memory only (never persisted / logged).
        // 加密是独立选项：只要提供了密码就注入 EncryptionProvider
        // （includeSecrets=false 时备份仍标记加密，但 secrets.enc 内容为空）。
        const password = typeof body['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
        // 同名去重（用户决策 2026-08-25）：自定义文件名若已存在，自动追加数字
        // （foo.zip → foo-1.zip → foo-2.zip）而非覆盖已有备份；自动命名自带随机
        // 后缀几乎不会撞名，同样走此逻辑（撞名时也递进而非覆盖）。
        // 读目录在 run 注册前做：exportsDir 缺失时 readdir 返回 []（自动命名原样）。
        let existingExportNames: string[] = []
        try {
          const entries = await fs.readdir(exportsDir, { withFileTypes: true })
          existingExportNames = entries.filter((e) => e.isFile() && e.name.endsWith('.zip')).map((e) => e.name)
        } catch {
          existingExportNames = [] // 目录尚不存在：自动命名，无需去重
        }
        const desiredName = customFileName !== null
          ? customFileName
          : `dsh-config-${dateStamp()}-${randomBytes(3).toString('hex')}.zip`
        const finalFileName = resolveNonCollidingExportName(desiredName, existingExportNames)
        const outPath = join(exportsDir, finalFileName)
        // m1：执行开始注册 run（同 kind 已有进行中任务 → 409 拒绝，防止重复导出）
        let run: RunState
        try {
          run = runs.register('export')
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const runId = run.runId
        try {
          // 先由 Exporter 产出标准明文 ZIP（含 manifest/checksums；若 includeSecrets 需要
          // 加密提供者来生成 secrets.enc —— 整体容器的外层加密再保护整个文件）。core 不感知外层容器。
          const plainZipPath = join(tmpDir, `export-plain-${randomBytes(4).toString('hex')}.zip`)
          const exporter = new Exporter({
            ctx: host,
            adapters,
            // includeSecrets=true 必须注入 EncryptionProvider（core 不变量：绝不明文写凭据）。
            // includeSecrets=false 时也注入，使 exporter 生成空的 secrets.enc、manifest.security.encrypted=true，
            // 与外层容器语义一致（备份打开需密码但不含凭据值）。
            encryption: password !== undefined ? createEncryptionProvider(password) : null,
            exporterVersion: PLUGIN_VERSION,
            // F1 文件级 vault：敏感文件（.credentials.yaml 等）镜像目录（<dataDir>/vault），
            // includeSecrets=false 导出时由 Exporter 自动刷新镜像（凭据明文只存本机）。
            vaultDataDir: deps.dataDir,
            // F2 强化扫描器（含部署者 personalPatterns 个人规则）
            scanner: deps.scanner,
            // m1 埋点：每导出一个分区实时更新 run 状态（/progress 轮询可见）
            onSection: (info) => {
              runs.update(runId, {
                section: info.section,
                sectionTotal: info.total,
                item: info.index,
                itemTotal: info.total,
                detail: info.section,
              })
            },
          })
          const result = await withTimeout(
            exporter.export({ includeSecrets, only, outPath: plainZipPath }),
            ROUTE_TIMEOUT_MS,
            msg('host.exportTimeout'),
          )
          // 若设置了密码 → 用外层容器加密整个明文 ZIP（AES-256-GCM，DCA1 容器）
          if (password !== undefined) {
            const plainZip = await fs.readFile(plainZipPath)
            const { blob } = await encryptArchive(plainZip, password)
            await fs.writeFile(outPath, blob)
            // 临时明文 ZIP 立即清理，磁盘不残留明文备份
            await fs.rm(plainZipPath, { force: true }).catch(() => undefined)
          } else {
            await fs.rename(plainZipPath, outPath)
          }
          // 结束写结果：完成结果落账（供 /progress 查询与刷新恢复后下载）。
          // 注意必须回报实际落盘的 outPath 而非 result.zipPath（后者是 plainZipPath：
          // 加密分支已删除、无加密分支已 rename 成 outPath，此时已不存在，下载会 404）。
          runs.finish(runId, { zipPath: outPath, manifest: result.manifest, report: result.report })
          // P0-④：导出备注写入 exports/.backup-notes.json（尽力而为：失败不影响导出结果）
          if (note !== null) {
            try {
              await writeBackupNote(exportsDir, basename(outPath), note)
            } catch (err) {
              host.log.warn('导出备注写入失败', { error: err instanceof Error ? err.message : String(err) })
            }
          }
          writeJson(res, 200, { zipPath: outPath, manifest: result.manifest, report: result.report, runId })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          runs.fail(runId, message)
          host.log.error('导出失败', { error: message })
          writeJson(res, 500, { error: message, runId })
        }
      },
    },
    // ---------------------------------------------------- export-preview
    // P2-⑫：导出前只读预览（不落盘 ZIP）：对选中分区逐个 adapter.export 收集 counts
    // （与真实导出一致的 secret 剥离，不导出任何值），估算 JSON 载荷大小，返回可展示摘要。
    // 零写入；loopback fence 必备。
    {
      kind: 'exact',
      path: API.exportPreview,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const only = Array.isArray(body?.['only'])
          ? body['only'].filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x))
          : undefined
        try {
          const selected = adapters
            .filter((a) => (only === undefined ? a.defaultIncluded : only.includes(a.id)))
            .map((a) => a.id)
          const preview: { section: SectionId; count: number; sizeBytes: number }[] = []
          let totalSize = 0
          let sectionsFailed = 0
          for (const adapter of adapters) {
            if (!selected.includes(adapter.id)) continue
            try {
              // includeSecrets=false：与真实导出同口径（值剥离），只统计不落盘
              const section = await adapter.export(host, { includeSecrets: false })
              // 文件类分区：大小按文件字节合计；JSON 分区：stringify 估算
              let size = 0
              if (isFileSection(adapter.id)) {
                const files = (section.data as { files?: { data: Uint8Array }[] }).files ?? []
                size = files.reduce((acc, f) => acc + f.data.length, 0)
              } else {
                size = Buffer.byteLength(stringifyJsonSafe(section.data), 'utf8')
              }
              const count = section.counts ? Object.values(section.counts).reduce((a, b) => a + b, 0) : 0
              preview.push({ section: adapter.id, count, sizeBytes: size })
              totalSize += size
            } catch {
              sectionsFailed += 1
              // 单项失败不拖垮预览（与真实导出同语义：分区级失败跳过）
            }
          }
          writeJson(res, 200, {
            ok: true,
            sections: preview,
            totalSections: preview.length,
            totalSizeBytes: totalSize,
            sectionsFailed,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ download
    {
      kind: 'exact',
      path: API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const p = queryParam(url, 'path')
        if (p === undefined || p === '') {
          writeJson(res, 400, { error: 'path query parameter is required' })
          return
        }
        const target = resolve(p)
        if (!isControlledPath(target, roots)) {
          writeJson(res, 403, { error: 'path outside controlled staging area' })
          return
        }
        let stat
        try {
          stat = await fs.stat(target)
        } catch {
          writeJson(res, 404, { error: 'file not found' })
          return
        }
        if (!stat.isFile()) {
          writeJson(res, 400, { error: 'not a file' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
          'content-disposition': `attachment; filename="${basename(target).replace(/"/g, '')}"`,
          'referrer-policy': 'no-referrer',
        })
        await new Promise<void>((resolvePromise, reject) => {
          const source = createReadStream(target)
          source.on('error', reject)
          res.on('error', reject)
          source.pipe(res)
          source.on('end', resolvePromise)
        })
      },
    },
    // -------------------------------------------------------------- upload
    {
      kind: 'exact',
      path: API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const name = queryParam(url, 'name') ?? 'backup.zip'
        const declared = Number(req.headers['content-length'])
        if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
          writeJson(res, 413, { error: 'upload body too large' })
          return
        }
        const tmp = join(tmpDir, `upload-${randomBytes(6).toString('hex')}.zip`)
        try {
          const sizeBytes = await writeRequestBodyToFile(req, tmp, MAX_UPLOAD_BYTES)
          // 探测上传文件是否为整体加密备份容器（DCA1 magic）：加密容器不能直接当作 ZIP 解析，
          // UI 据此插入「解锁加密备份」阶段（decrypt-archive），解出明文 ZIP 后再走导入。
          let containerType: 'zip' | 'encrypted' = 'zip'
          try {
            const first = await fs.readFile(tmp)
            containerType = isArchiveBlob(first) ? 'encrypted' : 'zip'
          } catch {
            containerType = 'zip'
          }
          writeJson(res, 200, { zipPath: tmp, name, sizeBytes, containerType })
        } catch (error) {
          await fs.rm(tmp, { force: true }).catch(() => undefined)
          if (!res.headersSent) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          } else {
            res.destroy()
          }
        }
      },
    },
    // ------------------------------------------------------ decrypt-archive
    // 整体加密备份容器的解锁（只读，零写入到任何配置）：用备份密码解密上传的加密容器，
    // 得到明文 ZIP 写入受控临时目录并返回新 zipPath，供 analyze/plan/execute 引用。
    // 导出时容器密码与内部 secrets.enc 密码同源（同一 password 派生两层加密），
    // 因此顺带在明文 ZIP 上解出内部凭据覆盖清单（refs，非值）一并返回——
    // 导入全程只需输入这一次密码，无需第二个密码校验页面。
    // 密码仅内存随请求体传入，绝不落盘/落日志；解出的明文 ZIP 亦为临时文件，导入结束后清理。
    {
      kind: 'exact',
      path: API.decryptArchive,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const encryptedPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (encryptedPath === '' || !isControlledPath(encryptedPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
          return
        }
        const password =
          typeof body?.['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
        if (password === undefined) {
          writeJson(res, 400, { error: msg('import.encryptedPasswordRequired') })
          return
        }
        let plainZipPath: string | null = null
        try {
          const container = await fs.readFile(encryptedPath)
          if (!isArchiveBlob(container)) {
            writeJson(res, 400, { error: msg('import.notEncryptedContainer') })
            return
          }
          // 校验密码（只读）+ 取真实解密参数
          const verified = await verifyEncryptedBlob(container, password)
          if (!verified.valid) {
            writeJson(res, 400, { error: msg('import.notEncryptedContainer') })
            return
          }
          if (!verified.ok || verified.info === null || verified.kdf === null) {
            writeJson(res, 400, { error: decryptErrorText(new SecurityError('BAD_PASSWORD', '解密认证失败'), msg) })
            return
          }
          // 解密得到明文 ZIP（Security-sensitive transient：随机独占名 + 0600 + 先权限后写，用后即删）
          const plain = await decryptArchive(container, verified.info, verified.kdf, password)
          plainZipPath = join(tmpDir, `decrypted-${randomBytes(6).toString('hex')}.zip`)
          await atomicWriteFile(plainZipPath, plain, { mode: 0o600, symlink: 'reject' })
          // 顺带解出内部凭据覆盖清单（同一密码；旧版 DSC1-only 备份无 secrets.enc → 空）
          let refs: string[] = []
          try {
            const decrypted = await tryDecryptCredentials(plainZipPath, password)
            if (decrypted !== undefined) refs = [...decrypted.keys()]
          } catch {
            // 内部凭据解密失败不影响容器解锁结果（密码已通过容器 GCM 认证）
          }
          writeJson(res, 200, { zipPath: plainZipPath, refs })
        } catch (error) {
          if (plainZipPath !== null) await fs.rm(plainZipPath, { force: true }).catch(() => undefined)
          writeJson(res, 400, { error: decryptErrorText(error, msg) })
        }
      },
    },
    // ------------------------------------------------------------- analyze
    {
      kind: 'exact',
      path: API.analyze,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
          return
        }
        try {
          writeJson(res, 200, await makeImporter().analyzeImport(zipPath))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------------------- plan
    {
      kind: 'exact',
      path: API.plan,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
          return
        }
        const decisions = body?.['decisions'] as ImportDecisions | undefined
        if (decisions === undefined || typeof decisions !== 'object') {
          writeJson(res, 400, { error: 'decisions is required' })
          return
        }
        try {
          writeJson(res, 200, await makeImporter().createImportPlan(zipPath, decisions))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ progress
    // m1：查询单个 run 的实时状态（轮询 / 刷新恢复用；runId 不可猜，走 loopback-only 守卫）
    {
      kind: 'exact',
      path: API.progress,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const runId = queryParam(url, 'runId')
        if (runId === undefined || runId === '') {
          writeJson(res, 400, { error: 'runId query parameter is required' })
          return
        }
        const state = runs.get(runId)
        if (state === undefined) {
          writeJson(res, 404, { error: msg('run.notFound', { runId }) })
          return
        }
        writeJson(res, 200, state)
      },
    },
    // ----------------------------------------------------------------- runs
    // m1：列出当前活跃（running）的 run（刷新恢复时重新订阅进度用）
    {
      kind: 'exact',
      path: API.runs,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, runs.listActive())
      },
    },
    // ------------------------------------------------------------- execute
    {
      kind: 'exact',
      path: API.execute,
      handler: withMutationGate('import-apply', async (req, res, lockCtx, journalCtx) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
          return
        }
        const plan = body?.['plan'] as ImportPlan | undefined
        if (plan === undefined || typeof plan !== 'object' || !Array.isArray(plan['items'])) {
          writeJson(res, 400, { error: 'plan is required and must be an ImportPlan' })
          return
        }
        const opts = (body?.['opts'] ?? {}) as Record<string, unknown>
        // 加密备份的解密密码（仅内存，来自导入向导 decrypt 阶段；绝不落盘/落日志）。
        // core 层强制：加密备份必须成功解密后才允许执行（import.encryptedPasswordRequired）。
        const decryptPassword =
          typeof opts['decryptPassword'] === 'string' && opts['decryptPassword'] !== ''
            ? opts['decryptPassword']
            : undefined
        // m1：执行开始注册 run（同 kind 已有进行中任务 → 409 拒绝，防止重复导入）
        let run: RunState
        try {
          run = runs.register('import')
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const runId = run.runId
        // 用户「跳过当前插件」通道：登记本 run 的当前项中止控制器（/execute/skip abort 它）
        const abortController = new AbortController()
        runAbortControllers.set(runId, abortController)
        try {
          let decryptedCredentials: Map<string, string> | undefined
          try {
            decryptedCredentials = await tryDecryptCredentials(zipPath, decryptPassword)
          } catch (error) {
            // 解密失败（密码错误/篡改）：转用户可读错误，不落 run 账（未开始执行）
            throw new Error(decryptErrorText(error, msg))
          }
          const result = await makeImporter().executeImportPlan(zipPath, plan, {
            confirm: opts['confirm'] === true,
            secretInputs:
              opts['secretInputs'] !== null && typeof opts['secretInputs'] === 'object'
                ? opts['secretInputs'] as Record<string, string>
                : {},
            rollbackOnError: opts['rollbackOnError'] === true,
            decryptedCredentials,
            // Phase 4 生产 snapshot 接线：deferred journal 绑定的 ctx 透传给引擎，
            // 使快照创建后立即 bindSnapshot（SNAPSHOT_CREATED）→ markApplying（APPLYING）再执行。
            snapshotBinding: journalCtx,
            // m1 埋点：每开始一个计划项实时更新 run 状态（detail=当前执行项，
            // 供 UI 显示「正在安装插件 X」/ 判定跳过按钮；/progress 轮询可见）
            onItemStart: (info) => {
              runs.update(runId, {
                section: info.adapter,
                item: info.index,
                itemTotal: info.total,
                detail: info.detail,
              })
            },
            // m1 埋点：每完成一个计划项实时更新 run 状态（/progress 轮询可见）
            onItem: (info) => {
              runs.update(runId, {
                section: info.adapter,
                item: info.index,
                itemTotal: info.total,
                detail: info.detail ?? info.adapter,
              })
            },
            // 执行日志：逐计划项操作 + 子进程命令行。宿主侧先 redact 再落账，
            // 保证 RunState.log 恒为非敏感（/progress 轮询回传浏览器）。
            onLog: (line) => {
              runs.appendLog(runId, redact(line))
            },
          })
          // 结束写结果：导入结果落账（供 /progress 查询与刷新恢复）
          runs.finish(runId, result)
          // Phase 6：迁移历史（best-effort）。sections 从导入计划的 items[].adapter 去重派生。
          const importSections = Array.from(
            new Set(plan.items.map((i) => (i as { adapter?: string }).adapter).filter((s): s is string => typeof s === 'string' && s !== '')),
          )
          const historyError = await tryAppendHistory({
            kind: 'import',
            result: result.ok ? 'success' : 'failed',
            sections: importSections,
            operationId: journalCtx?.operationId,
            snapshotId: result.snapshotId ?? undefined,
            runId,
            source: 'api',
            summary: `导入完成：${importSections.join(', ') || '无分区'}（执行 ${result.executed.length} 项）`,
            error: result.ok ? undefined : '导入未完全成功',
          })
          writeJson(res, 200, historyError === undefined ? { ...result, runId } : { ...result, runId, historyWriteError: historyError })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          runs.fail(runId, message)
          host.log.error('导入执行失败', { error: message })
          writeJson(res, 400, { error: message, runId })
        } finally {
          runAbortControllers.delete(runId)
        }
      }, { deferredSnapshot: true }),
    },
    // -------------------------------------------------- execute/skip
    // 用户跳过当前计划项（导入中，目前仅插件安装）：abort 当前项的中止控制器 → 引擎
    // 捕获 ImportUserSkippedError 记为 user-skipped，导入继续执行其余项。
    {
      kind: 'exact',
      path: API.skipExecute,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const runId = typeof body?.['runId'] === 'string' ? body['runId'] : ''
        if (runId === '') {
          writeJson(res, 400, { error: 'runId is required' })
          return
        }
        const controller = runAbortControllers.get(runId)
        if (controller === undefined) {
          writeJson(res, 404, { error: 'no running import found for this runId' })
          return
        }
        controller.abort()
        writeJson(res, 200, { skipped: true })
      },
    },
    // ---------------------------------------------------------- snapshots
    // M4：列出快照元信息（id/createdAt/sourceZip/status/计数，createdAt 倒序）
    {
      kind: 'exact',
      path: API.snapshots,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { snapshots: await listSnapshots(snapshotsDir) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ restore
    // M4：快照恢复。dryRun=true 只返回动作计划（planRestore，零写入）；
    // 真实执行 = 计划 → 宿主执行器（ctx.fs 整文件/文件还原 + runDshPlugin 卸载插件）
    // → 与 CLI 一致的诚实报告 { restored/removedPlugins/manualHints/failed/skipped }。
    //
    // **并发防护（P1-1）**：真实执行（dryRun=false）经 runs.register('restore') 登记——
    // 同 kind 已有 running 时抛 RunConflictError → 409 拒绝。这是宿主侧的权威防重
    // （前端 loading 只是 UX）：即使两个 tab / 刷新后重复点击，同一时刻至多一个
    // restore 在执行（不同快照并发恢复会交错写文件，同快照并发会互相覆盖
    // pre-restore 双保险备份，都是真实数据风险）。进度经 onAction 埋点更新
    // RunRegistry（/progress 轮询 + /runs 刷新恢复可见）；响应含 runId。
    {
      kind: 'exact',
      path: API.restore,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const parsed = buildRestoreBody(body)
        if (!parsed.ok) {
          writeJson(res, 400, { error: parsed.error })
          return
        }
        const { snapshotId, dryRun } = parsed.value
        const snapshotDir = join(snapshotsDir, snapshotId)
        const restoreOpts = {
          snapshotDir,
          homeDir: host.homeDir,
          profile: host.profile,
          settingsPath: undefined,
          msg,
          // Phase 4 统一恢复校验：所有 restore 入口传 snapshotsRoot → 同一验证强度（存在/READY/manifest/blob-hash/symlink/provenance）
          snapshotsRoot: snapshotsDir,
          environmentFingerprint: host.phase3Recovery?.recoveryEnvFingerprint ?? undefined,
        }
        try {
          if (dryRun) {
            // dry-run 零写入、只读探测：不登记 run（并发 dry-run 无害）
            writeJson(res, 200, { dryRun: true, plan: await planRestore(restoreOpts) })
            return
          }
          // 真实执行（Phase 2 锁：destructive 必须先获取 GLOBAL 环境锁；被挡 → 423）
          await runWithMutationLock(host.mutationLock, { op: 'restore', target: snapshotId, isBlocked: () => host.safeModeIsBlocked?.() ?? false }, async (lockCtx) => {
            const executeRestore = async (): Promise<void> => {
              // 先登记 run（同 kind running → 409 拒绝重复恢复）
              let run: RunState
              try {
                run = runs.register('restore')
              } catch (error) {
                writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
                return
              }
              const runId = run.runId
              try {
                const plan = await planRestore(restoreOpts)
                const report = await executeRestorePlan(
                  plan,
                  makeRestoreExecutor(snapshotDir, host, host.profile),
                  // m1 埋点：每执行一个恢复动作实时更新 run 状态（/progress 轮询可见）
                  (info) => {
                    runs.update(runId, {
                      section: 'restore',
                      item: info.index,
                      itemTotal: info.total,
                      detail: info.detail,
                    })
                  },
                )
                runs.finish(runId, report)
                // Phase 6：迁移历史（best-effort）。sections 从快照 entries 的 adapter 去重派生。
                const restoreSections = await snapshotEntrySections(snapshotDir)
                const historyError = await tryAppendHistory({
                  kind: 'restore',
                  result: 'success',
                  sections: restoreSections,
                  snapshotId: snapshotId,
                  runId,
                  source: 'api',
                  summary: `恢复快照 ${snapshotId}：还原 ${report.restored.length} 项${report.removedPlugins.length > 0 ? `，卸载插件 ${report.removedPlugins.length}` : ''}`,
                })
                writeJson(res, 200, historyError === undefined ? { dryRun: false, report, runId } : { dryRun: false, report, runId, historyWriteError: historyError })
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                runs.fail(runId, message)
                writeJson(res, 400, { error: message, runId })
              }
            }
            // Step 3 P0-A：真实 restore 在已持锁下创建 journal（不 double-acquire；release 由本 gate）
            if (host.phase3Recovery !== undefined && lockCtx !== null) {
              await host.phase3Recovery.runJournaled({ operationType: 'restore', lockCtx, fn: executeRestore })
            } else {
              await executeRestore()
            }
          })
        } catch (error) {
          if (error instanceof EnvironmentLockUnavailableError) {
            host.log.warn(`mutation lock blocked: op=${error.op}`)
            writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          } else if (error instanceof TransactionRecoveryRequiredError) {
            writeJson(res, 423, { error: error.message, code: 'transaction-recovery-required' })
          } else {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
      },
    },
    // ------------------------------------------- snapshots/delete（P1-⑧）
    // 手动删除单个快照（危险操作：该导入前回滚点不可恢复）。loopback fence（guard）；
    // 只接受合法快照 id（deleteSnapshot 内防穿越）。与自动保留清理不同：置顶快照
    // 只能在这里被用户手动删除。
    {
      kind: 'exact',
      path: API.snapshotDelete,
      handler: withMutationGate('snapshot-delete', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const id = typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)['snapshotId']
            : undefined
          if (!isValidSnapshotId(id)) {
            writeJson(res, 400, { error: 'snapshotId is required and must be a valid snapshot id' })
            return
          }
          const removed = await deleteSnapshot(snapshotsDir, id)
          const historyError = await tryAppendHistory({
            kind: 'snapshot-delete',
            result: 'success',
            sections: [id],
            snapshotId: id,
            source: 'api',
            summary: `删除快照 ${id}`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, removed } : { ok: true, removed, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    // --------------------------------------------- snapshots/pin（P1-⑧）
    // 置顶/取消置顶快照：置顶快照豁免「最多保留 N 个」的自动清理（只能手动删除）。
    // 纯元数据写（重写 snapshot.json 的 pinned 字段）；loopback fence 必备。
    {
      kind: 'exact',
      path: API.snapshotPin,
      handler: withMutationGate('snapshot-pin', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const id = typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)['snapshotId']
            : undefined
          const pinned = (body as Record<string, unknown> | undefined)?.['pinned'] === true
          if (!isValidSnapshotId(id)) {
            writeJson(res, 400, { error: 'snapshotId is required and must be a valid snapshot id' })
            return
          }
          await setSnapshotPinned(snapshotsDir, id, pinned)
          writeJson(res, 200, { ok: true, pinned })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          writeJson(res, 404, { error: message })
        }
      }),
    },
    // -------------------------------------------------- m-profiles
    // 配置档案（Profile）：保存当前 DSH 配置为多套可切换快照（Work/Personal…）。
    // 安全：Profile 名严格校验（ProfileManager 内部 isValidProfileName 防穿越）；
    // 切换走「预览 → confirm → 快照 → 分阶段 apply → 失败回滚」与导入同一语义；
    // Save 复用 adapter.export（天然不含秘密值）；全部路由 loopback fence。
    {
      kind: 'exact',
      path: API.profiles,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { ok: true, profiles: await profiles.list() })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API.profilesSave,
      // P2-C（Phase 8）：profiles/save 接入 GLOBAL mutation lock（与 destructive 操作互斥；
      // 保存档案期间确保 live config 不被并发改动，档案快照一致）。
      handler: withMutationGate('profile-save', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
        if (!isValidProfileName(name)) {
          writeJson(res, 400, { error: 'name is required and must be a valid profile name' })
          return
        }
        const sections = Array.isArray(body['sections'])
          ? body['sections'].filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x))
          : undefined
        try {
          const meta = await profiles.saveCurrent(name, sections === undefined ? {} : { sections })
          const historyError = await tryAppendHistory({
            kind: 'profile-save',
            result: 'success',
            sections: Array.isArray(meta?.sections) ? (meta.sections.filter((s) => typeof s === 'string') as string[]) : [],
            source: 'api',
            summary: `保存配置档案 ${name}`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    {
      kind: 'exact',
      path: API.profilesDelete,
      handler: withMutationGate('profile-delete', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['name'] : undefined
        if (typeof name !== 'string' || !isValidProfileName(name)) {
          writeJson(res, 400, { error: 'name is required and must be a valid profile name' })
          return
        }
        try {
          await profiles.delete(name)
          const historyError = await tryAppendHistory({
            kind: 'profile-delete',
            result: 'success',
            sections: [name],
            source: 'api',
            summary: `删除配置档案 ${name}`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true } : { ok: true, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    {
      kind: 'exact',
      path: API.profilesRename,
      handler: withMutationGate('profile-rename', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
        const newName = typeof body['newName'] === 'string' ? body['newName'].trim() : ''
        if (!isValidProfileName(name) || !isValidProfileName(newName)) {
          writeJson(res, 400, { error: 'name and newName must be valid profile names' })
          return
        }
        try {
          const meta = await profiles.rename(name, newName)
          const historyError = await tryAppendHistory({
            kind: 'profile-rename',
            result: 'success',
            sections: [name],
            source: 'api',
            summary: `重命名配置档案 ${name} → ${newName}`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    {
      kind: 'exact',
      path: API.profilesAnalyzeSwitch,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const name = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['name'] : undefined
        if (typeof name !== 'string' || !isValidProfileName(name)) {
          writeJson(res, 400, { error: 'name is required and must be a valid profile name' })
          return
        }
        try {
          const preview = await profiles.analyzeSwitch(name)
          writeJson(res, 200, { ok: true, preview })
        } catch (error) {
          writeJson(res, 404, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API.profilesExecuteSwitch,
      handler: withMutationGate('profile-switch', async (req, res, lockCtx, journalCtx) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
        if (!isValidProfileName(name)) {
          writeJson(res, 400, { error: 'name is required and must be a valid profile name' })
          return
        }
        const secretInputs =
          body['secretInputs'] !== null && typeof body['secretInputs'] === 'object'
            ? body['secretInputs'] as Record<string, string>
            : {}
        const resolutions =
          body['resolutions'] !== null && typeof body['resolutions'] === 'object'
            ? body['resolutions'] as Record<string, 'keepCurrent' | 'useImported' | 'review'>
            : {}
        const strategy = body['strategy'] === 'replace' || body['strategy'] === 'skipExisting' ? body['strategy'] as 'replace' | 'skipExisting' : 'merge'
        // 执行开始登记 run（同 kind 已有进行中任务 → 409，与 /restore、/execute 同防重语义）
        let run: RunState
        try {
          run = runs.register('profile-switch')
        } catch (error) {
          writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        const runId = run.runId
        try {
          const result = await profiles.executeSwitch(name, {
            confirm: body['confirm'] === true,
            strategy,
            resolutions,
            secretInputs,
            rollbackOnError: body['rollbackOnError'] !== false,
            snapshotBinding: journalCtx,
          })
          runs.finish(runId, result)
          // Phase 6：迁移历史（best-effort）。sections 从切换 preview 的分区。
          const switchSections = (result as { sections?: string[] }).sections ?? []
          const historyError = await tryAppendHistory({
            kind: 'profile-switch',
            result: 'success',
            sections: switchSections,
            operationId: journalCtx?.operationId,
            runId,
            source: 'api',
            summary: `切换到配置档案 ${name}`,
          })
          writeJson(res, 200, historyError === undefined ? { ...result, runId } : { ...result, runId, historyWriteError: historyError })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (error instanceof ImportNotConfirmedError) {
            runs.fail(runId, message)
            writeJson(res, 400, { error: message, runId })
          } else {
            runs.fail(runId, message)
            writeJson(res, 400, { error: message, runId })
          }
        }
      }, { deferredSnapshot: true }),
    },
    {
      kind: 'exact',
      path: API.profilesImport,
      handler: withMutationGate('profile-import', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const asName = typeof body['asName'] === 'string' && body['asName'].trim() !== '' ? body['asName'].trim() : undefined
        const raw = typeof body['content'] === 'string' ? body['content'] : undefined
        if (raw === undefined || raw === '') {
          writeJson(res, 400, { error: 'content (profile.json string) is required' })
          return
        }
        // 落盘到受控 tmpDir，再走 ProfileManager.importProfile（内部校验 version/sections/name）
        const staged = join(tmpDir, `profile-import-${randomBytes(6).toString('hex')}.json`)
        try {
          await fs.writeFile(staged, raw, 'utf8')
          const meta = await profiles.importProfile(staged, asName === undefined ? {} : { asName })
          const historyError = await tryAppendHistory({
            kind: 'profile-import',
            result: 'success',
            sections: Array.isArray(meta?.sections) ? (meta.sections.filter((s) => typeof s === 'string') as string[]) : [],
            source: 'api',
            summary: `导入配置档案${asName !== undefined ? ` ${asName}` : ''}`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        } finally {
          await fs.rm(staged, { force: true }).catch(() => undefined)
        }
      }),
    },
    // -------------------------------------------------- backup-schedule
    // 定时全量备份设置（GET 读 / PUT 存 sync/backup-schedule.json；无敏感字段）：
    // 保存后重排调度器（reload）；恒不含 secret、不加密（与自动同步同语义）。
    // 与全仓一致：每个方法分支都过 loopback fence（guard）——其他 /api/dsh-config-manager/*
    // 路由全部首行 guard，新增路由不得遗漏（安全不变量：仅 loopback + 同源可访问）。
    {
      kind: 'exact',
      path: API.backupSchedule,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            writeJson(res, 200, { schedule: await readBackupSchedule(syncDir) })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method === 'PUT') {
          if (!guard(req, res, 'PUT')) return
          try {
            const body = await readJsonBody(req)
            const parsed = validateBackupScheduleDraft(body)
            if (!parsed.ok) {
              writeJson(res, 400, { error: parsed.error })
              return
            }
            const current = await readBackupSchedule(syncDir)
            const next: BackupScheduleConfig = { ...current, ...parsed.value }
            await writeBackupSchedule(syncDir, next)
            await backupScheduler.reload()
            writeJson(res, 200, { ok: true, schedule: next })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method ${req.method} not allowed` })
      },
    },
    // ------------------------------------------------- backup-schedule/run
    // 立即执行一次全量备份（复用 BackupScheduler.runOnce，同一时刻防重）：
    // 返回执行结果（status/zip/skipReason/error）+ 最新配置（含 lastRun 状态）。
    // 同全仓：loopback fence（guard）——远程调用方不得触发宿主写盘操作。
    {
      kind: 'exact',
      path: API.backupScheduleRun,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const run = await backupScheduler.runOnce()
          const schedule = await readBackupSchedule(syncDir)
          writeJson(res, 200, { ok: true, run, schedule })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ backup-files
    // 导出产物管理（m-backup-files）：列出 exports/*.zip（名称/大小/时间/来源，
    // 时间倒序）+ 删除单个备份文件。下载复用 /download（roots 已含 exportsDir）。
    // 安全：删除只接受文件名（服务端 basename 校验防路径穿越）；恒 loopback guard。
    {
      kind: 'exact',
      path: API.backupFiles,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          writeJson(res, 200, { ok: true, files: await listBackupFiles(exportsDir) })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API.backupFilesDelete,
      handler: withMutationGate('backup-file-delete', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const name = typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>)['name']
            : undefined
          if (!isValidBackupFileName(name)) {
            writeJson(res, 400, { error: 'name must be a .zip file name (no path separators)' })
            return
          }
          const removed = await deleteBackupFile(exportsDir, name)
          writeJson(res, 200, { ok: true, removed })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    // ------------------------------------------------------ consult
    // Phase 7：迁移前咨询（只读健康评分 + 建议）。POST，loopback fence。
    // 对 4 种可迁移源（export-zip / local-snapshot / remote-snapshot / profile）生成
    // 统一咨询报告。**只读**：不写配置/快照/journal；临时 ZIP 用 try/finally 立即清理。
    {
      kind: 'exact',
      path: API.consult,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const body = await readJsonBody(req)
          const type = body?.['type']
          const id = body?.['id']
          const snapshotId = body?.['snapshotId']
          if (typeof type !== 'string' || typeof id !== 'string' || id === '') {
            writeJson(res, 400, { error: 'type and id are required' })
            return
          }
          if (!['export-zip', 'local-snapshot', 'remote-snapshot', 'profile'].includes(type)) {
            writeJson(res, 400, { error: `unknown consult type: ${type}` })
            return
          }
          const ref: ConsultSourceRef = {
            type: type as ConsultSourceRef['type'],
            id,
            snapshotId: typeof snapshotId === 'string' ? snapshotId : undefined,
          }
          const target = { targetDsh: host.dshVersion, targetPlatform: host.platform }
          const computeMigratability = async (zipPath: string): Promise<MigratabilityResult> => {
            try {
              const importer = makeImporter()
              const analysis = await importer.analyzeImport(zipPath)
              const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })
              return {
                ok: analysis.valid,
                itemCount: plan.items.length,
                fatalConflicts: plan.items.filter((i) => i.kind === 'Conflict').length,
                warnings: plan.items.filter((i) => i.severity === 'warning').length,
                sections: analysis.sectionsInZip,
                errors: analysis.errors,
              }
            } catch (err) {
              return { ok: false, itemCount: 0, fatalConflicts: 0, warnings: 0, sections: [], errors: [err instanceof Error ? err.message : String(err)] }
            }
          }

          let data: ConsultSourceData
          if (type === 'export-zip') {
            data = await readExportZipSource(ref, id, { computeMigratability })
          } else if (type === 'remote-snapshot') {
            // 用持久化 sync 配置构建引擎，下载快照 → 临时 ZIP → 读取（try/finally 清理）
            const syncCfg = await prepareSync({})
            const engine = makeSyncEngine(syncCfg)
            const preview = await engine.preview({ snapshotId: ref.snapshotId ?? id })
            if (!preview.ok || preview.zipPath === '') {
              writeJson(res, 400, { error: preview.message ?? '远端快照不可用' })
              return
            }
            try {
              data = await readExportZipSource(ref, preview.zipPath, { computeMigratability })
            } finally {
              await fs.rm(dirname(preview.zipPath), { recursive: true, force: true }).catch(() => undefined)
            }
          } else if (type === 'local-snapshot') {
            if (!isValidSnapshotId(id)) {
              writeJson(res, 400, { error: 'invalid snapshot id' })
              return
            }
            const verify = await verifySnapshot(snapshotsDir, id)
            const snapshotDir = join(snapshotsDir, id)
            // 从快照条目推导将恢复的分区（entries[].adapter）
            const snapshot = await new FileSnapshotStore({ dir: snapshotsDir }).load(id).catch(() => null)
            const snapshotSections = new Map<SectionId, unknown>()
            for (const e of snapshot?.entries ?? []) {
              if (e.adapter !== undefined) snapshotSections.set(e.adapter, {})
            }
            let restorePlan = { itemCount: 0, conflicts: 0, warnings: 0, sections: [] as SectionId[], errors: [] as string[] }
            try {
              const plan = await planRestore({
                snapshotDir,
                homeDir: host.homeDir,
                profile: host.profile ?? 'web',
                snapshotsRoot: snapshotsDir,
              })
              restorePlan = {
                itemCount: plan.actions.length,
                conflicts: plan.actions.filter((a) => a.kind === 'skip').length,
                warnings: plan.actions.filter((a) => a.kind === 'skip').length,
                sections: [...snapshotSections.keys()],
                errors: [],
              }
            } catch (err) {
              restorePlan.errors = [err instanceof Error ? err.message : String(err)]
            }
            data = buildLocalSnapshotSource(ref, {
              sections: snapshotSections,
              verify,
              restorePlan,
              sourceDsh: host.dshVersion,
              sourcePlatform: host.platform,
            })
          } else {
            // profile
            const sections = await profiles.readSections(id)
            let switchPreview = { itemCount: 0, conflicts: 0, warnings: 0, sections: [] as SectionId[], errors: [] as string[] }
            try {
              const preview = await profiles.analyzeSwitch(id)
              switchPreview = {
                itemCount: preview.items.length,
                conflicts: preview.items.filter((i) => i.kind === 'Conflict').length,
                warnings: preview.items.filter((i) => i.severity === 'warning').length,
                sections: preview.sectionsInProfile,
                errors: [],
              }
            } catch (err) {
              switchPreview.errors = [err instanceof Error ? err.message : String(err)]
            }
            data = buildProfileSource(ref, {
              sections,
              switchPreview,
              sourceDsh: host.dshVersion,
              sourcePlatform: host.platform,
            })
          }

          const report = computeConsultReport(data, target, { allowBlock: true })
          writeJson(res, 200, report)
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/status
    // m-sync-ui：同步状态（通道配置 / 凭据状态 / 上次同步 / 分区数）。只读，无 secret 值。
    {
      kind: 'exact',
      path: API.syncStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          // 完整双命名空间配置：repoUrl / webdav.url 无论当前通道都回填，
          // 保证 UI 在 git ↔ webdav 间切换时另一通道的地址不丢失
          const full = await readFullSyncConfig(syncDir)
          const state = await loadSyncState(syncDir)
          const [cred, webdavCred] = await Promise.all([
            credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
            credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
          ])
          const transport: SyncConfig['transport'] = full !== null && full.transport === 'webdav' ? 'webdav' : 'git'
          // m-self：插件 UI 偏好（上次选择的同步通道；ui-prefs.json，随 self 分区进备份）
          const uiPrefs = await readUiPrefs(syncDir)
          // webdav 配置视图（配置过即返回，与当前通道无关：供表单在 git ↔ webdav 切换时回填）
          const webdav = full?.webdav !== undefined
            ? {
                url: full.webdav.url,
                // username 非敏感可回显，供表单回填
                username: full.webdav.username,
                usernameConfigured: typeof full.webdav.username === 'string' && full.webdav.username !== '',
                passwordConfigured: webdavCred.configured,
              }
            : undefined
          writeJson(res, 200, {
            ok: true,
            configured: full !== null,
            transport,
            repoUrl: full?.git?.repoUrl,
            credentialConfigured: cred.configured,
            credentialWritable: cred.writable === true,
            // webdav 配置状态（无 secret 值：口令用 passwordConfigured 布尔标记）
            ...(webdav !== undefined ? { webdav } : {}),
            lastSyncAt: state.lastSyncAt === '' ? undefined : state.lastSyncAt,
            sectionCount: Object.keys(state.sections).length,
            lastTransport: state.transport,
            // 上次选择的同步通道（磁盘 ui-prefs；UI 回填优先于此，localStorage 仅兜底）
            lastSyncChannel: uiPrefs.lastSyncChannel,
            // 可同步分区目录（「高级/自定义导出」勾选列表；只含 portable，无 secret 值）
            syncSections: syncSectionCatalog,
            // 当前分区选择（默认/高级模式 + 勾选分区；当前激活通道；UI 回填用，自动同步共用）
            syncSelection: await selectionView(transport),
            // 全部通道的分区选择（git/webdav 各自独立；UI 按当前 tab 取对应通道）
            syncSelectionByChannel: await selectionViewByChannel(),
            // 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9）
            autosync: await buildAutosyncStatus(syncDir, transport),
            // 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道）
            autosyncByChannel: await buildAutosyncStatusByChannel(syncDir),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/config
    // m-sync-config：保存同步通道配置（parseSyncBody 校验 + password/token 写 DSH credentials +
    // writeSyncConfig 落盘）。UI 表单自动保存 /「保存配置」按钮调用；响应为轻量状态视图
    // （仅凭据布尔，无 secret 值），供 UI 直接刷新徽章而不必重拉 status 覆盖正在编辑的表单。
    {
      kind: 'exact',
      path: API.syncConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          await writeSyncConfig(syncDir, syncCfg)
          const [cred, webdavCred] = await Promise.all([
            credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
            credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
          ])
          writeJson(res, 200, {
            ok: true,
            configured: true,
            transport: syncCfg.transport,
            credentialConfigured: cred.configured,
            webdav: isWebDavConfig(syncCfg)
              ? {
                  usernameConfigured: typeof syncCfg.webdav.username === 'string' && syncCfg.webdav.username !== '',
                  passwordConfigured: webdavCred.configured,
                }
              : undefined,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/ui-prefs
    // m-self：保存插件 UI 偏好（当前为上次选择的同步通道；ui-prefs.json，随 self 分区进备份）。
    // 纯偏好、无 secret；失败仅提示，不阻断同步主流程。
    // 经 updateUiPrefs 局部合并写：不覆盖其他端点（star-prompt）刚写入的字段。
    {
      kind: 'exact',
      path: API.syncUiPrefs,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const channel: UiPrefsChannel | undefined = body['lastSyncChannel'] === 'webdav' ? 'webdav' : body['lastSyncChannel'] === 'git' ? 'git' : undefined
          await updateUiPrefs(syncDir, { ...(channel !== undefined ? { lastSyncChannel: channel } : {}) })
          writeJson(res, 200, { ok: true, lastSyncChannel: channel })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ star-prompt
    // m-star-prompt：Star 引导弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回仓库地址 + 弹窗状态（UI 挂载时判定是否展示 / 是否补记首次使用时间）；
    // POST → 局部更新（firstSeenAt / dismissed / clicked 白名单），经 updateUiPrefs
    // 合并写，不覆盖 sync/ui-prefs 的 lastSyncChannel。纯偏好、无 secret。
    {
      kind: 'exact',
      path: API.starPrompt,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            const prefs = await readUiPrefs(syncDir)
            writeJson(res, 200, {
              ok: true,
              repoUrl: STAR_PROMPT_REPO_URL,
              firstSeenAt: prefs.starPromptFirstSeenAt,
              dismissed: prefs.starPromptDismissed === true,
              clicked: prefs.starPromptClicked === true,
            })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const patch: Record<string, unknown> = {}
          const firstSeenAt = body['firstSeenAt']
          if (typeof firstSeenAt === 'number' && Number.isFinite(firstSeenAt)) {
            patch['starPromptFirstSeenAt'] = firstSeenAt
          }
          if (body['dismissed'] === true) {
            patch['starPromptDismissed'] = true
          }
          if (body['clicked'] === true) {
            patch['starPromptClicked'] = true
          }
          const next = await updateUiPrefs(syncDir, patch)
          writeJson(res, 200, {
            ok: true,
            firstSeenAt: next.starPromptFirstSeenAt,
            dismissed: next.starPromptDismissed === true,
            clicked: next.starPromptClicked === true,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ release-notes-prompt
    // 版本更新内容弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回当前插件版本 + 上次已读版本 + 是否永不提示；
    // POST → 局部更新（lastSeenVersion / dismissed 白名单），经 updateUiPrefs 合并写。
    {
      kind: 'exact',
      path: API.releaseNotesPrompt,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            const prefs = await readUiPrefs(syncDir)
            writeJson(res, 200, {
              ok: true,
              lastSeenVersion: prefs.releaseNotesLastSeenVersion,
              dismissed: prefs.releaseNotesDismissed === true,
              currentVersion: PLUGIN_VERSION,
            })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const patch: Record<string, unknown> = {}
          const lastSeenVersion = body['lastSeenVersion']
          if (typeof lastSeenVersion === 'string' && lastSeenVersion.trim().length > 0) {
            patch['releaseNotesLastSeenVersion'] = lastSeenVersion.trim()
          }
          if (body['dismissed'] === true) {
            patch['releaseNotesDismissed'] = true
          }
          const next = await updateUiPrefs(syncDir, patch)
          writeJson(res, 200, {
            ok: true,
            lastSeenVersion: next.releaseNotesLastSeenVersion,
            dismissed: next.releaseNotesDismissed === true,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/push
    // m-sync-ui：推送（导出 portable 分区 → 提交私有仓库 → 更新 sync-state）。
    // token 可选：非空先写入 DSH credentials；成功则记忆仓库配置（回填表单用）。
    // sections 可选（高级/自定义导出）：只推送勾选的分区；缺省 = 默认模式全部推荐分区。
    {
      kind: 'exact',
      path: API.syncPush,
      handler: withMutationGate('sync-push', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const sections = extractSyncSections(body, knownSyncSectionIds)
          // 加密快照选项：encrypt=true 时携带密码（仅内存传输，绝不落盘/落日志）；
          // includeSecrets=true 由 engine 强制要求 encrypt（密钥绝不明文进同步通道）
          const encrypt = body['encrypt'] === true
          const includeSecrets = body['includeSecrets'] === true
          const encryptPassword =
            typeof body['encryptPassword'] === 'string' && body['encryptPassword'] !== ''
              ? body['encryptPassword']
              : undefined
          // P0-②：push 前只读预览（body.preview === true → 不写远端，只返回「将推送什么」）
          const preview = body['preview'] === true
          // 分支调用以保证 withTimeout 的泛型结果类型正确（SyncPushReport | SyncPushPreview）
          const report = preview
            ? await withTimeout(
                engine.previewPush({
                  ...(sections === undefined ? {} : { sections }),
                  ...(encrypt || includeSecrets ? { encrypt: true, includeSecrets } : {}),
                }),
                ROUTE_TIMEOUT_MS,
                msg('host.syncPushTimeout'),
              )
            : await withTimeout(
                engine.push({
                  ...(snapshotId === undefined ? {} : { snapshotId }),
                  ...(sections === undefined ? {} : { sections }),
                  ...(encrypt || includeSecrets ? { encrypt: true, includeSecrets, password: encryptPassword ?? '' } : {}),
                }),
                ROUTE_TIMEOUT_MS,
                msg('host.syncPushTimeout'),
              )
          await writeSyncConfig(syncDir, syncCfg)
          writeJson(res, 200, report)
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      }),
    },
    // ------------------------------------------------------ sync/pull
    // m-sync-ui：拉取差异预览（只读：list/download → 转临时 ZIP → Importer 分析出计划摘要）。
    // 绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
    {
      kind: 'exact',
      path: API.syncPull,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const strategy =
            body['strategy'] === 'replace' || body['strategy'] === 'skipExisting' ? body['strategy'] : 'merge'
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          // 解密密码（加密快照拉取时提供；仅内存传输，绝不落盘/落日志）
          const decryptPassword =
            typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
              ? body['decryptPassword']
              : undefined
          const report = await withTimeout(
            engine.pull({
              strategy,
              ...(snapshotId === undefined ? {} : { snapshotId }),
              ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
            }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          await writeSyncConfig(syncDir, syncCfg)
          writeJson(res, 200, report)
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/start
    // m-github-oauth：发起 GitHub OAuth device flow。请求 GitHub 取设备码，宿主登记
    // （flowId → device_code 只存内存），返回 UI 展示用的 user_code + 授权页 URL。
    // client_id 来自插件配置；未配置时给出可操作指引（不会凭空认证）。
    {
      kind: 'exact',
      path: API.syncGithubStart,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        if (githubClientId === undefined || githubClientId === '') {
          writeJson(res, 400, {
            error: msg('host.githubMissingClientId'),
          })
          return
        }
        try {
          const started = await githubAuth.startDeviceFlow(githubClientId)
          const flowId = DeviceFlowStore.newFlowId()
          githubFlows.set(flowId, {
            deviceCode: started.deviceCode,
            clientId: githubClientId,
            clientSecret: githubClientSecret,
            interval: started.interval,
            expiresAt: Date.now() + started.expiresIn * 1000,
          })
          // device_code 绝不回传；只回 UI 需要的展示信息
          writeJson(res, 200, {
            flowId,
            userCode: started.userCode,
            verificationUri: started.verificationUri,
            expiresIn: started.expiresIn,
            interval: started.interval,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/poll
    // m-github-oauth：轮询授权结果。凭 flowId 取回宿主登记的 device_code → GitHub 换 token
    // → 成功则立即写入 DSH credentials（SYNC_CREDENTIAL_REF，与手动 token 同槽），
    // token 绝不回传浏览器；pending 返回下次轮询延迟；终止态（denied/expired/error）清理登记。
    {
      kind: 'exact',
      path: API.syncGithubPoll,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const flowId = typeof body?.['flowId'] === 'string' ? body['flowId'] : ''
        if (flowId === '') {
          writeJson(res, 400, { error: 'flowId is required' })
          return
        }
        const flow = githubFlows.get(flowId)
        if (flow === undefined) {
          writeJson(res, 400, { error: msg('host.githubFlowGone') })
          return
        }
        try {
          const result = await githubAuth.pollForToken({
            clientId: flow.clientId,
            deviceCode: flow.deviceCode,
            clientSecret: flow.clientSecret,
            interval: flow.interval,
          })
          if (result.status === 'success' && result.accessToken !== undefined) {
            await credentials.set(credentialRef(SYNC_CREDENTIAL_REF), result.accessToken)
            githubFlows.delete(flowId)
            host.log.info('GitHub OAuth 登录成功（token 已写入 DSH credentials）')
            writeJson(res, 200, { status: 'success', credentialConfigured: true })
            return
          }
          if (result.status === 'pending') {
            writeJson(res, 200, { status: 'pending', pollDelayMs: result.pollDelayMs })
            return
          }
          // 终止态：清理登记，把状态 + 可展示消息回给 UI（不含任何秘密）
          githubFlows.delete(flowId)
          writeJson(res, 200, {
            status: result.status,
            ...(result.message !== undefined ? { message: result.message } : {}),
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // -------------------------------------------------- sync/github/cancel
    // m-github-oauth：取消登录流程（丢弃宿主侧 device_code 登记，零副作用）。
    {
      kind: 'exact',
      path: API.syncGithubCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const flowId = typeof body?.['flowId'] === 'string' ? body['flowId'] : ''
        if (flowId === '') {
          writeJson(res, 400, { error: 'flowId is required' })
          return
        }
        githubFlows.delete(flowId)
        writeJson(res, 200, { ok: true })
      },
    },
    // -------------------------------------------------- sync/github/validate
    // m-sync-github-valid：校验 SYNC_CREDENTIAL_REF 中已存 token 是否有效（GET /user），
    // 供 UI 判定「是否已登录」→ 已登录隐藏 GitHub 登录区块、token 失效则重新展示。
    // 只回布尔 + 登录名（非敏感），token 值绝不回传；仅 401（无效/过期）→ valid:false，
    // 其余错误（网络/限流）向上抛，由 UI 兜底（不误判登出）。
    {
      kind: 'exact',
      path: API.syncGithubValidate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          let configured = false
          let valid = false
          let login: string | undefined
          const resolved = await meTokenProvider()
          configured = resolved !== ''
          if (configured) {
            try {
              const user = await meGitHubRest.getUser()
              valid = true
              login = user.login
            } catch (error) {
              // 仅 401（token 无效/过期）→ 视为未登录；其余错误（网络/限流）向上抛
              if (!(error instanceof GitHubApiError && error.code === 'unauthorized')) throw error
            }
          }
          writeJson(res, 200, {
            ok: true,
            configured,
            valid,
            ...(login !== undefined ? { login } : {}),
          })
        } catch (error) {
          writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ------------------------------------------------------ sync/history
    // P2：列出本地祖先快照目录的 manifest.json（id/createdAt/sectionHashes），
    // 同时统计 review-queue 中关联到该 snapshotId 的项数。
    {
      kind: 'exact',
      path: API.syncHistory,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const localDir = join(syncDir, 'snapshots')
          const entries = await fs.readdir(localDir).catch(() => [])
          const rows: Array<{ id: string; createdAt: string; sectionCount: number; reviewCount: number; transport?: string }> = []
          for (const name of entries) {
            const dir = join(localDir, name)
            const stat = await fs.stat(dir).catch(() => null)
            if (!stat?.isDirectory()) continue
            const manifestPath = join(dir, 'manifest.json')
            const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null)
            if (raw === null) continue
            try {
              const m = JSON.parse(raw) as { id?: unknown; createdAt?: unknown; sectionHashes?: unknown; manifest?: { transport?: unknown } }
              if (typeof m.id !== 'string' || typeof m.createdAt !== 'string') continue
              const sectionCount = m.sectionHashes && typeof m.sectionHashes === 'object'
                ? Object.keys(m.sectionHashes as Record<string, unknown>).length
                : 0
              // 触发通道（push/apply 落盘时写入各快照 manifest.transport；旧快照为 undefined）
              const transport = m.manifest && typeof m.manifest === 'object' && typeof m.manifest.transport === 'string'
                ? m.manifest.transport
                : undefined
              rows.push({ id: m.id, createdAt: m.createdAt, sectionCount, reviewCount: 0, ...(transport !== undefined ? { transport } : {}) })
            } catch { /* skip malformed */ }
          }
          // 关联 review-queue 计数
          const rqPath = join(syncDir, 'sync-review-queue.json')
          const rqRaw = await fs.readFile(rqPath, 'utf8').catch(() => null)
          if (rqRaw !== null) {
            try {
              const rq = JSON.parse(rqRaw) as { items?: Array<{ snapshotId?: string }> }
              const byId = new Map<string, number>()
              for (const it of rq.items ?? []) {
                if (typeof it.snapshotId === 'string') {
                  byId.set(it.snapshotId, (byId.get(it.snapshotId) ?? 0) + 1)
                }
              }
              for (const r of rows) {
                const c = byId.get(r.id)
                if (c !== undefined) r.reviewCount = c
              }
            } catch { /* skip */ }
          }
          rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          // 合并自动同步执行记录（sync-history.json）
          const hist = await readSyncHistory(syncDir)
          const merged = [
            ...rows.map((r) => ({ ...r, kind: 'apply' as const })),
            ...hist.autosyncEntries.map((e) => ({
              id: e.createdAt,
              createdAt: e.createdAt,
              kind: 'autosync' as const,
              autosync: e,
            })),
          ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          writeJson(res, 200, { entries: merged })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/snapshots-list
    // m-sync-v2：远端历史快照列表（供「选择历史快照」下拉）。
    {
      kind: 'exact',
      path: API.syncSnapshotsList,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const metas = await withTimeout(
            engine.listSnapshots(),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          const snapshots = [...metas]
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
            .map((m) => ({
              id: m.id,
              createdAt: m.createdAt,
              sectionCount: m.manifest.sectionIds.length,
              platform: m.manifest.platform,
              dshVersion: m.manifest.dshVersion,
            }))
          const state = await loadSyncState(syncDir)
          writeJson(res, 200, { ok: true, snapshots, currentSnapshotId: state.lastSnapshotId === '' ? undefined : state.lastSnapshotId })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/sync
    // m-sync-v2：一键同步第一步 —— 拉取 → 差异确认会话（内存登记临时 ZIP + ImportPlan）。
    {
      kind: 'exact',
      path: API.syncSync,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncCfg = await prepareSync(body)
          const engine = makeSyncEngine(syncCfg)
          const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          // 解密密码（一键同步拉取加密快照时提供；仅内存传输，绝不落盘/落日志）
          const decryptPassword =
            typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
              ? body['decryptPassword']
              : undefined
          const preview = await withTimeout(
            engine.preview({
              ...(snapshotId === undefined ? {} : { snapshotId }),
              ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
            }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          if (!preview.ok || preview.plan === null || preview.analysis === null) {
            writeJson(res, 200, { ok: false, syncSessionId: '', snapshotId: preview.snapshotId, items: [], needsReview: false, compatibility: 'unsupported', message: preview.message ?? '同步预览失败' })
            return
          }
          const syncSessionId = syncSessions.set({
            zipPath: preview.zipPath,
            plan: preview.plan,
            analysis: preview.analysis,
            snapshotId: preview.snapshotId,
            config: syncCfg,
          })
          const items = planToConfirmItems(preview.plan)
          const needsReview = items.some((i) => REVIEW_KINDS.has(i.kind)) || preview.analysis.pathIssues.length > 0
          writeJson(res, 200, {
            ok: true,
            syncSessionId,
            snapshotId: preview.snapshotId,
            items,
            needsReview,
            compatibility: preview.analysis.compatibility,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/apply-items
    // m-sync-v2：一键同步第二步 —— 按用户对差异项的逐项决策执行导入。
    {
      kind: 'exact',
      path: API.syncApplyItems,
      handler: withMutationGate('sync-apply', async (req, res, lockCtx, journalCtx) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncSessionId = typeof body['syncSessionId'] === 'string' ? body['syncSessionId'] : ''
          const session = syncSessions.get(syncSessionId)
          if (session === undefined) {
            writeJson(res, 400, { error: '同步会话不存在或已过期，请重新拉取预览' })
            return
          }
          const adoptions = Array.isArray(body['adoptions']) ? body['adoptions'] : []
          // 构造子计划（仅含采纳项）
          const byId = new Map<string, { adopt: boolean; resolution?: string }>()
          for (const a of adoptions as Array<Record<string, unknown>>) {
            if (typeof a?.['itemId'] !== 'string') continue
            byId.set(a['itemId'], { adopt: a['adopt'] === true, resolution: typeof a['resolution'] === 'string' ? a['resolution'] : undefined })
          }
          // 构造子计划（仅含采纳项）。同步冲突决策 useRemote → 核心 importer 的
          // useImported（item 转成 Update，applyOne 才会真正写远端值），
          // keepLocal/skip 从子计划剔除（keepCurrent/skip 语义：不写）。
          // 与导入恢复向导（ConflictList keepCurrent/useImported）的决策语义完全一致。
          const subItems: PlanItem[] = session.plan.items.flatMap((item) => {
            const d = byId.get(item.id)
            if (d === undefined || !d.adopt) return []
            // Conflict 项必须有 resolution；keepLocal/skip 不写入本地 → 剔除
            if (item.kind === 'Conflict') {
              if (d.resolution === undefined) throw new SyncRouteError(`冲突项 ${item.id} 必须提供 resolution（useRemote/keepLocal/skip）`)
              if (d.resolution === 'keepLocal' || d.resolution === 'skip') return []
              // useRemote → 转成 Update 计划项（镜像 analyzer.applyItemResolution 的
              // useImported 分支），applyOne 才会把远端值真正写进本地。
              const c = (item as { conflict?: { itemId?: string } }).conflict
              return [{
                ...item,
                kind: 'Update' as const,
                severity: 'info' as const,
                conflict: { itemId: c?.itemId ?? item.id, resolution: 'useImported' as const },
              } as PlanItem]
            }
            return [item]
          })
          const subPlan: ImportPlan = {
            ...session.plan,
            items: subItems,
          }
          // 消费会话（同一 session 只允许一次 apply-items）
          syncSessions.delete(syncSessionId)
          let engine: SyncEngine
          let report: ApplyItemsReport
          try {
            engine = makeSyncEngine(session.config)
            report = await engine.applyItems(session.zipPath, subPlan, {
              onItem: (info) => { /* 进度可选：runs 已由 applyItems 内部处理 */ },
              snapshotBinding: journalCtx,
            })
          } finally {
            // 用完再清理临时 ZIP（此前在 applyItems 读取前就删除 → ENOENT：无法读取备份文件）
            await fs.rm(dirname(session.zipPath), { recursive: true, force: true }).catch(() => { /* 尽力清理临时 ZIP */ })
          }
          const historyError = await tryAppendHistory({
            kind: 'sync-apply',
            result: report.ok ? 'success' : 'failed',
            sections: Array.isArray(report.applied) ? report.applied.filter((s): s is string => typeof s === 'string') : subItems.map((i) => (i as { adapter?: string }).adapter).filter((s): s is string => typeof s === 'string' && s !== ''),
            operationId: journalCtx?.operationId,
            snapshotId: report.restoreId ?? undefined,
            source: 'api',
            summary: `一键同步应用：${(Array.isArray(report.applied) ? report.applied.length : subItems.length)} 项${report.rolledBack === true ? '（已回滚）' : ''}`,
            error: report.ok ? undefined : '同步应用未完全成功',
          })
          writeJson(res, 200, historyError === undefined ? {
            ok: report.ok,
            applied: report.applied,
            skipped: subItems.map((i) => i.id),
            needsRestart: report.needsRestart === true,
            warnings: report.warnings,
            restoreId: report.restoreId,
            rolledBack: report.rolledBack,
            failed: report.failed,
            result: report.result,
          } : {
            ok: report.ok,
            applied: report.applied,
            skipped: subItems.map((i) => i.id),
            needsRestart: report.needsRestart === true,
            warnings: report.warnings,
            restoreId: report.restoreId,
            rolledBack: report.rolledBack,
            failed: report.failed,
            result: report.result,
            historyWriteError: historyError,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      }, { deferredSnapshot: true }),
    },
    // ------------------------------------------------------ sync/cancel
    // m-sync-v2：取消 / 清理差异确认会话（丢弃临时 ZIP，零副作用）。
    {
      kind: 'exact',
      path: API.syncCancel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const syncSessionId = typeof body['syncSessionId'] === 'string' ? body['syncSessionId'] : ''
          if (syncSessionId !== '') {
            const session = syncSessions.get(syncSessionId)
            if (session !== undefined) {
              await fs.rm(dirname(session.zipPath), { recursive: true, force: true }).catch(() => { /* 尽力清理临时 ZIP */ })
            }
            syncSessions.delete(syncSessionId)
          }
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/autosync
    // m-sync-v2：自动同步配置读写（按通道：git/webdav 各自的开关 + 间隔 + 启动阈值 + 状态）。
    // GET = 读全部通道状态（{ git, webdav }）；POST = 写指定通道（body.transport，缺省 git）。
    // 同一路径注册为一个 exact 路由（方法内部分发），避免 webserver 对重复 exact 路径报错。
    {
      kind: 'exact',
      path: API.syncAutosync,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            writeJson(res, 200, await buildAutosyncStatusByChannel(syncDir))
          } catch (error) {
            writeSyncRouteError(res, error)
          }
          return
        }
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          // 按通道读写：git/webdav 各自的自动同步配置与运行状态独立（缺省 git 兜底）
          const channel: SyncTransportType = body['transport'] === 'webdav' ? 'webdav' : 'git'
          const cfg = await readAutosyncConfig(syncDir, channel)
          if (typeof body['enabled'] === 'boolean') cfg.enabled = body['enabled']
          if (typeof body['interval'] === 'string' && isAutosyncInterval(body['interval'])) cfg.interval = body['interval']
          if (typeof body['startupMinIntervalMs'] === 'number' && Number.isFinite(body['startupMinIntervalMs']) && body['startupMinIntervalMs'] > 0) {
            cfg.startupMinIntervalMs = body['startupMinIntervalMs']
          }
          await writeAutosyncConfig(syncDir, channel, cfg)
          if (scheduler) scheduler.reload().catch(() => { /* 尽力而为 */ })
          writeJson(res, 200, await buildAutosyncStatus(syncDir, channel))
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/selection
    // m-sync-selection：保存同步分区选择（按通道：git/webdav 各自的模式 + 勾选分区）。
    // 持久化到 sync-selection.json；自动同步调度器与手动 push 共用（makeSyncEngine 注入）。
    // sections 元素必须是可同步（portable）分区 id；mode 非法 → 回退 default。
    {
      kind: 'exact',
      path: API.syncSelection,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          // 按通道读写：git/webdav 各自的模式与分区勾选独立（缺省 git 兜底）
          const channel: SyncTransportType = body['transport'] === 'webdav' ? 'webdav' : 'git'
          const mode: SyncSelectionMode = body['mode'] === 'advanced' ? 'advanced' : 'default'
          const rawSections = Array.isArray(body['sections']) ? body['sections'] : []
          const portableIds = new Set(syncSectionCatalog.map((s) => s.id))
          for (const s of rawSections) {
            if (typeof s !== 'string' || s === '') {
              writeJson(res, 400, { error: 'sections must be an array of non-empty strings' })
              return
            }
            if (!portableIds.has(s as SectionId)) {
              writeJson(res, 400, { error: `unknown sync section: ${s}` })
              return
            }
          }
          const next: SyncSelection = {
            schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
            mode,
            sections: [...new Set(rawSections as string[])] as SectionId[],
            encrypt: body['encrypt'] === true,
            // 安全兜底：includeSecrets 必须同时 encrypt（密钥绝不明文进同步通道）
            includeSecrets: body['includeSecrets'] === true && body['encrypt'] === true,
          }
          await writeSyncSelection(syncDir, channel, next)
          selectionCache[channel] = next
          writeJson(res, 200, { ok: true, transport: channel, mode: next.mode, sections: next.sections, encrypt: next.encrypt, includeSecrets: next.includeSecrets })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
    },
    // ------------------------------------------------------ sync/rollback
    // P2：UI 一键回滚入口（按 apply 返回的 restoreId 调用 backup→rollback）。
    {
      kind: 'exact',
      path: API.syncRollback,
      handler: withMutationGate('sync-rollback', async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        try {
          const restoreId = typeof body['restoreId'] === 'string' ? body['restoreId'] : ''
          if (restoreId === '') {
            writeJson(res, 400, { error: 'restoreId required' })
            return
          }
          const store = new FileSnapshotStore({ dir: join(syncDir, 'snapshots') })
          const snap = await store.load(restoreId)
          const report = await performRollback({ ctx: host, snapshot: snap, store, adapters })
          const historyError = await tryAppendHistory({
            kind: 'rollback',
            result: 'success',
            sections: [],
            snapshotId: restoreId,
            source: 'api',
            summary: `一键同步回滚（${restoreId}）`,
          })
          writeJson(res, 200, historyError === undefined ? { ok: true, full: report.full } : { ok: true, full: report.full, historyWriteError: historyError })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      }),
    },
    // ---------------------------------------------------- market/status
    // 内置单市场（只读、不可编辑）：恒返回内置仓库摘要。无 add/remove —— 市场绑定内置仓库。
    {
      kind: 'exact',
      path: API.marketStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const summary = await buildMarketSummary({ url: BUILTIN_MARKET_URL, addedAt: '' })
          writeJson(res, 200, {
            ok: true,
            configured: true,
            markets: [summary],
            // 首次打开市场页自动更新一次的判据：本次 dsh 启动后是否已刷新过（进程内存，重启重置）
            bootAutoRefreshed: marketBootAutoRefreshed,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------- market/refresh
    {
      kind: 'exact',
      path: API.marketRefresh,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        // 内置单市场：url 可省略，缺省用 BUILTIN_MARKET_URL（保留接受 url 以兼容旧调用方与 env 覆盖）
        const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
          ? body['url']
          : BUILTIN_MARKET_URL
        try {
          const reader = makeMarketReader()
          const { text, fetchedAt } = await reader.readIndex({ url, workDir: marketWorkDir(url) })
          const parsed = parseMarketIndex(text)
          if (!parsed.ok) {
            writeJson(res, 400, { error: `market index invalid: ${parsed.errors.join('; ')}` })
            return
          }
          // 写缓存 index（供离线重复浏览）。内容始终视为不可信，读取时再结构校验。
          await fs.mkdir(dirname(marketCacheIndex(url)), { recursive: true })
          await fs.writeFile(marketCacheIndex(url), text, 'utf8')
          // 刷新成功 → 置位「本次启动已刷新」标记（手动「拉取最新」同样生效；失败不置位，下次打开可重试）
          marketBootAutoRefreshed = true
          const summary = await buildMarketSummary({ url, addedAt: new Date().toISOString() })
          writeJson(res, 200, { ok: true, items: parsed.index!.items, market: { ...summary, lastFetchedAt: fetchedAt } })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------- market/browse
    {
      kind: 'exact',
      path: API.marketBrowse,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        // 内置单市场：url 缺省用 BUILTIN_MARKET_URL（兼容旧调用方与 env 覆盖）
        const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
          ? body['url']
          : BUILTIN_MARKET_URL
        try {
          // 缓存 index 缺失 → 先拉取（refresh 语义）；已存在则直接用缓存。
          let index: MarketIndex | null = await readCachedIndexObj(url)
          if (index === null) {
            const reader = makeMarketReader()
            const { text } = await reader.readIndex({ url, workDir: marketWorkDir(url) })
            const parsed = parseMarketIndex(text)
            if (!parsed.ok) {
              writeJson(res, 400, { error: `market index invalid: ${parsed.errors.join('; ')}` })
              return
            }
            index = parsed.index!
            await fs.mkdir(dirname(marketCacheIndex(url)), { recursive: true })
            await fs.writeFile(marketCacheIndex(url), text, 'utf8')
          }
          const items: MarketListItem[] = []
          for (const item of index.items) {
            const cacheState = await itemCached(url, item.id) ? 'cached' : 'none'
            // P2-⑭：已缓存条目从 L2 manifest 合并 sections（供列表分区筛选）；未缓存条目
            // sections 缺省（= 未知，筛选时排除并提示需先「查看详情」下载）。
            let sections: SectionId[] | undefined
            if (cacheState === 'cached') {
              try {
                const manifestRaw = await fs.readFile(join(marketCacheItemDir(url), item.id, 'manifest.json'), 'utf8')
                const parsed = parseMarketItemManifest(manifestRaw)
                if (parsed.ok && parsed.manifest !== null) sections = parsed.manifest.sections
              } catch {
                // 缓存 manifest 读取失败：sections 保持 undefined（筛选降级为未知）
              }
            }
            items.push({ ...toMarketListItem(item, cacheState), ...(sections !== undefined ? { sections } : {}) })
          }
          // star 数据（仓库级）：收集条目来源仓库 URL（repo ?? 市场 URL）去重后批量查缓存，
          // 并入浏览列表。查询失败/非 GitHub 仓库 → 该项 stars 缺省（undefined），UI 显示「—」。
          if (items.length > 0) {
            const repoUrls = [...new Set(items.map((it) => it.repo ?? url))]
            const starsByUrl = await marketStarCache.getMany(repoUrls)
            for (const it of items) {
              const stars = starsByUrl.get(it.repo ?? url)
              if (stars !== undefined) it.stars = stars
            }
          }
          writeJson(res, 200, { ok: true, items })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------- market/download
    // 拉取 manifest + config.zip → 安全校验（§6）→ valid 则落受控临时区 + dry-run 分析/计划。
    // 真正落盘由用户确认后走既有 POST /execute（zipPath + plan）。零写入到确认。
    {
      kind: 'exact',
      path: API.marketDownload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        // 内置单市场：url 缺省用 BUILTIN_MARKET_URL；itemId 必填；repo 可选（条目来源仓库，发布者自托管）
        const url = (body !== undefined && typeof body['url'] === 'string' && body['url'] !== '')
          ? body['url']
          : BUILTIN_MARKET_URL
        const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
        if (itemId === '') {
          writeJson(res, 400, { error: 'itemId required' })
          return
        }
        // repo 可选：条目来源仓库。非法（含 userinfo / 空白 / 非 http(s) 形态）→ 400，永不注入凭据。
        const repo = (typeof body?.['repo'] === 'string' && body['repo'] !== '') ? body['repo'] : undefined
        if (repo !== undefined) {
          const repoErr = validateMarketRepoUrl(repo)
          if (repoErr !== null) {
            writeJson(res, 400, { error: `repo invalid: ${repoErr}` })
            return
          }
        }
        try {
          const reader = makeMarketReader()
          // 条目仓库与市场仓库分离时，workDir 按来源仓库 url-hash 分目录（天然隔离）
          const sourceRepo = repo ?? url
          const workDir = marketWorkDir(sourceRepo)
          const { text: manifestRaw } = await reader.readItemManifest({ url, workDir, itemId, repo })
          const { data: zipBytes } = await reader.readItemZip({ url, workDir, itemId, repo })

          const validation = validateMarketItem(itemId, manifestRaw, zipBytes)
          const manifest = validation.manifest
          // 供应链警示恒生成（marketItemWarnings 模型层）；download 时间；来源 URL 带条目仓库
          const downloadedAt = new Date().toISOString()
          const warnings = manifest !== null
            ? marketItemWarnings(manifest, sourceRepo, downloadedAt, msg)
            : [`条目 ${itemId} 来自公共网络市场，未经官方审核（供应链警示）`]

          const base: MarketItemDetail = {
            id: itemId,
            name: manifest?.name ?? itemId,
            version: manifest?.version ?? '',
            author: manifest?.author,
            description: manifest?.description,
            updatedAt: manifest?.updatedAt,
            sections: validation.sections,
            repo: sourceRepo,
            provenance: manifest?.provenance,
            downloadedAt,
            status: validation.status,
            errors: validation.errors,
            warnings,
          }

          if (validation.status === 'invalid') {
            // 校验失败 → 返回 MarketItemDetail（status:'invalid' + errors/warnings），不进入导入预览。
            writeJson(res, 200, base)
            return
          }

          // valid：落受控临时区（tmpDir 已是 /execute 的 controlled root）
          // 先懒 GC 清理过期市场暂存 zip，避免未确认导入的暂存文件堆积
          await pruneStagedMarketZips()
          const zipPath = join(tmpDir, `market-${itemId}-${randomBytes(6).toString('hex')}.zip`)
          await fs.writeFile(zipPath, zipBytes)
          // 写条目缓存（manifest + config.zip）供离线重复查看
          await writeItemCache(url, itemId, manifestRaw, zipBytes)

          // dry-run 分析 + 计划（零写入）：复用现有 importer
          const importer = makeImporter()
          const analysis = await importer.analyzeImport(zipPath)
          const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })

          const download: MarketDownloadResult = { ...base, zipPath, analysis, plan }
          writeJson(res, 200, download)
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------- market/prepare
    // 发布向导：由「用户上传的配置 zip + 用户填写元数据」生成市场条目包
    // （L2 manifest + config.zip SHA-256 + sections），供 UI 展示/复制与引导推送。
    // 零写入配置：只在受控临时区生成发布目录；插件不做任何 git 写操作、不持有凭据。
    {
      kind: 'exact',
      path: API.marketPrepare,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged upload' })
          return
        }
        const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
        const name = typeof body?.['name'] === 'string' ? body['name'] : ''
        const version = typeof body?.['version'] === 'string' ? body['version'] : undefined
        const description = typeof body?.['description'] === 'string' ? body['description'] : undefined
        const author = typeof body?.['author'] === 'string' ? body['author'] : undefined
        const repoUrl = typeof body?.['repoUrl'] === 'string' && body['repoUrl'] !== '' ? body['repoUrl'] : undefined
        const categoriesRaw = body?.['categories']
        const categories = Array.isArray(categoriesRaw)
          ? categoriesRaw.filter((c): c is string => typeof c === 'string')
          : undefined
        // F6 分享模式：share 强制排除 deviceSpecific/platformSpecific 分区 + 保守档内容扫描拦截
        // （prepare.ts 内实现）；migrate 缺省。非法值一律回退 migrate。
        const mode = body?.['mode'] === 'share' ? 'share' : 'migrate'
        try {
          const zipBytes = await fs.readFile(zipPath)
          const result = prepareMarketItem({ itemId, name, version, description, author, repoUrl, categories, zipBytes, mode })
          // 发布目录落到受控临时区（供 UI 展示目录结构；不写任何配置）
          const dir = join(tmpDir, `publish-${itemId}-${randomBytes(6).toString('hex')}`)
          const itemDir = join(dir, 'items', itemId)
          await fs.mkdir(itemDir, { recursive: true })
          await fs.writeFile(join(itemDir, 'manifest.json'), result.manifestText, 'utf8')
          await fs.writeFile(join(itemDir, 'config.zip'), zipBytes)
          // 打包发布目录为 zip（供 /download 端点下载；zip 由懒 GC 清理），
          // 打包后删除中间目录，避免 publish-* 目录在 tmpDir 无限累积
          const publishZip = join(tmpDir, `publish-${itemId}-${randomBytes(6).toString('hex')}.zip`)
          await fs.writeFile(publishZip, Buffer.from(zipToBuffer([
            { name: `items/${itemId}/manifest.json`, data: Buffer.from(result.manifestText, 'utf8') },
            { name: `items/${itemId}/config.zip`, data: Buffer.from(zipBytes) },
          ])))
          await fs.rm(dir, { force: true, recursive: true }).catch(() => undefined)
          writeJson(res, 200, {
            ok: true,
            dir,
            zipPath: publishZip,
            manifestText: result.manifestText,
            sha256: result.sha256,
            sections: result.sections,
            warnings: result.warnings,
          })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ---------------------------------------------------- me/status
    // 「一键上传 / 我的配置」登录状态：resolve SYNC_CREDENTIAL_REF token → GET /user。
    // 401 → loggedIn:false（未登录）；token 值不出模块外，只回传 login 用户名。
    {
      kind: 'exact',
      path: API.meStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          let loggedIn = false
          let login: string | undefined
          try {
            const user = await meGitHubRest.getUser()
            loggedIn = true
            login = user.login
          } catch (error) {
            // 仅 401（token 无效/过期）→ 未登录；其余错误（网络/限流）向上抛
            if (!(error instanceof GitHubApiError && error.code === 'unauthorized')) throw error
          }
          const repoUrl = login !== undefined ? userConfigsRepoUrl(login) : undefined
          const repoExists = login !== undefined ? await meGitHubRest.repoExists(login, USER_CONFIGS_REPO) : false
          writeJson(res, 200, {
            loggedIn,
            ...(login !== undefined ? { login } : {}),
            ...(repoUrl !== undefined ? { repoUrl } : {}),
            repoExists,
          })
        } catch (error) {
          writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/upload
    // 一键上传：zipPath 必须来自受控上传临时区（复用 /market/prepare 规则）；
    // form 仅 { name, description?, categories? }（name 必填）；元数据全自动由 MyRepoService 生成。
    {
      kind: 'exact',
      path: API.meUpload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const zipPath = typeof body['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged upload' })
          return
        }
        const form = parseMeForm(body['form'])
        if (form === null) {
          writeJson(res, 400, { error: 'form is required and name must be a non-empty string' })
          return
        }
        try {
          const zipBytes = await fs.readFile(zipPath)
          // MyRepoService 内部已做 prepare 8 道校验 + 秘密扫描（失败 → ok:false，零推送）
          const result = await meService.upload({ zipBytes, form })
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/items
    // 查看已上传：读用户仓库 index.json + 收录状态（未收录 / PR 待审核 / 已收录）。
    // 401（token 过期）→ 401 + 脱敏错误，UI 引导重新登录。
    {
      kind: 'exact',
      path: API.meItems,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const items = await meService.listItems()
          writeJson(res, 200, { items })
        } catch (error) {
          const status = error instanceof GitHubApiError && error.code === 'unauthorized' ? 401 : 500
          writeJson(res, status, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/update
    // 一键更新：同 upload 时序；version 纯自动 +1、id 不变；PR 未合并 force push 更新 / 已合并基于最新 main 重开。
    {
      kind: 'exact',
      path: API.meUpdate,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        const zipPath = typeof body['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged upload' })
          return
        }
        const form = parseMeForm(body['form'])
        if (form === null) {
          writeJson(res, 400, { error: 'form is required and name must be a non-empty string' })
          return
        }
        try {
          const zipBytes = await fs.readFile(zipPath)
          const result = await meService.update({ zipBytes, form })
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/listing
    // 查询收录/下架任务状态（结果卡轮询）：任务表命中 → 直接返回；未命中 → 回退 GitHub 实况推导；
    // 无任务且无实况 → 200 null。401（token 过期）→ 401，UI 引导重新登录。
    {
      kind: 'exact',
      path: API.meListing,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
        if (itemId === '') {
          writeJson(res, 400, { error: 'itemId is required' })
          return
        }
        try {
          const status = await meService.listingStatus(itemId)
          writeJson(res, 200, status) // null → 200 null
        } catch (error) {
          const status = error instanceof GitHubApiError && error.code === 'unauthorized' ? 401 : 500
          writeJson(res, status, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/relist
    // 重新提交收录（收录失败 / 进程重启丢失后的一键重试）：幂等复用已存在 fork/open PR。
    {
      kind: 'exact',
      path: API.meRelist,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
        if (itemId === '') {
          writeJson(res, 400, { error: 'itemId is required' })
          return
        }
        try {
          const status = await meService.relist(itemId)
          writeJson(res, 200, status)
        } catch (error) {
          const code = error instanceof GitHubApiError && error.code === 'unauthorized' ? 401 : 500
          const message = error instanceof MyRepoError && error.code === 'item_not_found'
            ? 404
            : code
          writeJson(res, message, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ---------------------------------------------------- me/delete
    // 删除条目：同步删用户仓库索引 + items/<id>/ 文件；已收录 → 后台异步提下架 PR；待审核 → 关闭收录 PR。
    {
      kind: 'exact',
      path: API.meDelete,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
        if (itemId === '') {
          writeJson(res, 400, { error: 'itemId is required' })
          return
        }
        try {
          const result = await meService.deleteItem(itemId)
          writeJson(res, 200, result)
        } catch (error) {
          const code = error instanceof GitHubApiError && error.code === 'unauthorized' ? 401 : 500
          const message = error instanceof MyRepoError && error.code === 'item_not_found'
            ? 404
            : code
          writeJson(res, message, { error: redact(error instanceof Error ? error.message : String(error)) })
        }
      },
    },
    // ------------------------------------------------------------ history
    // Phase 6：迁移历史审计（统一历史引擎）。只读 GET：列表（过滤）+ 导出。
    // loopback fence（guard）与全仓一致——仅同源 + loopback 可访问。
    {
      kind: 'exact',
      path: API.history,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const q = parseHistoryQuery(Object.fromEntries(url.searchParams))
          const { entries, corrupted } = await history.read()
          const filtered = queryHistory(entries, q)
          const stats = summarizeHistory(filtered)
          writeJson(res, 200, { ok: true, entries: filtered, stats, corrupted })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: API.historyExport,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const format = url.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
          const q = parseHistoryQuery(Object.fromEntries(url.searchParams))
          const { entries } = await history.read()
          const filtered = queryHistory(entries, q)
          const text = renderExport(filtered, format, host.language)
          if (format === 'markdown') {
            res.writeHead(200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': 'attachment; filename="migration-history.md"',
            })
            res.end(text)
          } else {
            writeJson(res, 200, { ok: true, generatedAt: new Date().toISOString(), text })
          }
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------------ recovery
    // Phase 5：recovery 编排（prefix 路由，内部按 path 分发）。
    // 禁用 withMutationGate（避免 double-journal）；mutation 路由经 withMutationLock + loopback fence。
    {
      kind: 'prefix',
      path: API.recovery,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) { writeJson(res, 403, { error: 'forbidden: loopback-only' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rel = url.pathname.slice(API.recovery.length).replace(/^\/+/, '')
        const segments = rel.split('/').filter(Boolean)
        if (segments.length === 0) { writeJson(res, 404, { error: 'not found' }); return }
        if (segments[0] === 'status') {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const r = await recoveryOrchestrator.status()
          writeJson(res, r.status, r.body)
          return
        }
        if (segments.length !== 2) { writeJson(res, 404, { error: 'not found' }); return }
        const operationId = segments[0]!
        const action = segments[1]!
        if (!isValidOperationId(operationId)) { writeJson(res, 400, { error: 'invalid operationId' }); return }
        const methodFor: Record<string, 'GET' | 'POST'> = { preview: 'GET', confirm: 'POST', execute: 'POST', verify: 'POST', retry: 'POST', dismiss: 'POST' }
        const expected = methodFor[action]
        if (expected === undefined) { writeJson(res, 404, { error: 'not found' }); return }
        if (req.method !== expected) { writeJson(res, 405, { error: 'method not allowed' }); return }
        try {
          if (action === 'preview') {
            const r = await recoveryOrchestrator.preview(operationId)
            writeJson(res, r.status, r.body)
            return
          }
          // mutation 路由：withMutationLock（Phase 2 GLOBAL 锁）+ loopback fence；不 double-journal。
          // 不传 isBlocked：recovery 是解决 SAFE MODE 的机制，若被 SAFE MODE 阻断会死锁。
          await runWithMutationLock(host.mutationLock, { op: `recovery-${action}`, target: operationId }, async () => {
            const body = await readJsonBody(req)
            const userConfirmed = body?.['userConfirmed'] === true
            let r
            if (action === 'confirm') r = await recoveryOrchestrator.confirm(operationId, userConfirmed)
            else if (action === 'execute') r = await recoveryOrchestrator.execute(operationId, userConfirmed, makeRecoveryExecutors)
            else if (action === 'verify') r = await recoveryOrchestrator.verify(operationId)
            else if (action === 'retry') r = await recoveryOrchestrator.retry(operationId, userConfirmed, makeRecoveryExecutors)
            else if (action === 'dismiss') r = await recoveryOrchestrator.dismiss(operationId, userConfirmed)
            else r = { status: 404, body: { error: 'not found' } } as const
            // Phase 6：recovery 迁移历史（best-effort）。在 mutation 结果（execute/retry/verify/dismiss）后记。
            if (action === 'execute' || action === 'retry' || action === 'verify' || action === 'dismiss') {
              await tryAppendHistory({
                kind: 'recovery',
                result: r.status === 200 ? 'success' : r.status >= 500 ? 'failed' : 'skipped',
                sections: [],
                operationId,
                source: 'recovery',
                summary: `恢复操作 ${action}`,
                error: r.status >= 400 && typeof r.body?.['error'] === 'string' ? String(r.body['error']) : undefined,
              })
            }
            writeJson(res, r.status, r.body)
          })
        } catch (error) {
          if (error instanceof EnvironmentLockUnavailableError) {
            host.log.warn(`mutation lock blocked: op=${error.op}`)
            writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
            return
          }
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
  return { routes: routesList, scheduler, makeSyncEngine }
}

/* ------------------------------------------------------------------ apply */

/**
 * Mount the config-manager engine: host context, adapters, and the
 * /api/dsh-config-manager routes (when a webServer is present).
 * @param ctx - host plugin context carrying settings/credentials/webServer.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  if (config?.enabled === false) return

  const homeDir = resolveDshHome()
  const dataDir = config?.dataDir !== undefined && config.dataDir !== ''
    ? resolve(config.dataDir)
    : dshHomePath('dsh-config-manager')
  const exportsDir = join(dataDir, 'exports')
  const tmpDir = join(dataDir, 'tmp')
  const snapshotsDir = join(dataDir, 'snapshots')
  const syncDir = join(dataDir, 'sync')
  const marketDir = join(dataDir, 'market')
  // Phase 6：迁移历史审计目录（统一历史引擎；加入 RESERVED_INTERNAL_PREFIXES 防 F23 投毒链）
  const historyDir = join(dataDir, MIGRATION_HISTORY_DIR)
  mkdirSync(exportsDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })
  mkdirSync(marketDir, { recursive: true })
  mkdirSync(historyDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config))
  // Phase 2 跨进程环境锁：全局唯一 GLOBAL EXCLUSIVE MUTATION LOCK（<dataDir>/locks/environment.lock）。
  // 所有 destructive mutation 入口经 runWithMutationLock(host.mutationLock, …) 获取；跨进程/跨 kind 互斥。
  // 随插件生命周期停止：停止 heartbeat 并清除本进程持有（release 由各入口 finally 保证；这里无需额外清理）。
  host.mutationLock = new EnvironmentLockManager({
    dataDir,
    op: 'config-manager',
    target: 'global-mutation',
    lockVersion: PLUGIN_VERSION,
  })
  const envLockManager = host.mutationLock as EnvironmentLockManager
  // Phase 3：启动 reconcile（只读）+ SAFE MODE。宿主 apply() 为同步 →
  // ① 先同步探测 durable SAFE MODE 标记（scheduler.start() 前即被阻断），
  // ② 再异步跑完整只读 reconcile，刷新标志与 durable 标记。不自动 recover stale lock（Rev 3 P1-NEW-2）。
  // Phase 4 F21/F11：注入真实 snapshotExists 正向校验——journal 引用的 snapshot 存在 + READY +
  // verified（manifest/blob hash）+ op/env/owner binding 匹配 journal，才视为可回滚的有效 recovery 证据。
  const phase3Recovery = new Phase3Recovery({
    dataDir,
    packageVersion: PLUGIN_VERSION,
    snapshotExists: async (snapshotId, binding) => {
      if (snapshotId === null || snapshotId === '') return false
      if (!isValidSnapshotId(snapshotId)) return false
      const v = await verifySnapshot(snapshotsDir, snapshotId)
      if (!v.ok) return false
      // binding 校验：journal 引用必须与快照双向一致（operationId/ownerInstanceId/environmentFingerprint）
      const snap = await new FileSnapshotStore({ dir: snapshotsDir }).load(snapshotId).catch(() => null)
      if (snap === null) return false
      if (snap.readiness !== 'READY') return false
      if (binding?.operationId !== undefined && snap.operationId !== binding.operationId) return false
      if (binding?.ownerInstanceId !== undefined && snap.ownerInstanceId !== binding.ownerInstanceId) return false
      if (binding?.environmentFingerprint !== undefined && snap.environmentFingerprint !== binding.environmentFingerprint) return false
      return true
    },
  })
  host.safeModeIsBlocked = () => phase3Recovery.safeModeActive
  host.phase3Recovery = phase3Recovery
  phase3Recovery.probeSafeModeSync()
  if (phase3Recovery.safeModeActive) {
    host.log.warn('Phase 3 SAFE MODE 激活：存在未恢复的 transaction，destructive 操作被阻断（如需恢复请先显式处理）')
  }
  // P1-B：启动 recovery 分类 barrier。调度器（AutoSync/Backup）只在分类完成且 state=NORMAL 时启动。
  // schedulerGate.start 由 makeRoutes 返回 scheduler + apply 构造 backupScheduler 后赋值；apply 为同步，
  // 故在该异步分类块 await 完成前，schedulerGate.start 通常已就绪。fail-closed：分类抛错 → 不启动调度器。
  const schedulerGate = { start: null as (() => void) | null }
  let startupStateResolved = false
  let shouldStartSchedulers = false
  void (async () => {
    try {
      await phase3Recovery.initFingerprint()
      const lockInsp = await envLockManager.inspectLockState()
      // P1-A：启动 barrier 前捕获 crashed stale ownership 证据（environment.lock owner.instanceId），
      // 并将其作为 expectedOwnershipInstanceId 传入分类 env → 激活 journal↔ownership binding 校验。
      const staleOwnerId = lockInsp.state === 'STALE_LOCK_DETECTED' || lockInsp.state === 'UNKNOWN_STATE'
        ? await phase3Recovery.captureStaleOwnershipInstanceId()
        : null
      const startupState = classifyStartup({
        store: phase3Recovery.store,
        hooks: phase3Recovery.recoveryHooks,
        env: {
          environmentFingerprint: phase3Recovery.recoveryEnvFingerprint,
          isLiveOwner: async () => false,
          ...(staleOwnerId ? { expectedOwnershipInstanceId: staleOwnerId } : {}),
        },
        lockState: mapLockStateForStartup(lockInsp.state),
      })
      const { state } = await startupState.classify()
      startupStateResolved = true
      phase3Recovery.safeModeActive = phase3Recovery.safeModeActive || ['RECOVERY_REQUIRED', 'NEEDS_ATTENTION', 'UNKNOWN_STATE'].includes(state.kind)
      shouldStartSchedulers = (state.kind === 'NORMAL')
      if (state.kind === 'RECOVERY_REQUIRED' || state.kind === 'NEEDS_ATTENTION') {
        host.log.warn(`Phase 3 ${state.kind}：上次 destructive operation 崩溃残留，需显式恢复；destructive 调度器未启动（read-only host 存活）`)
      } else if (shouldStartSchedulers && schedulerGate.start !== null) {
        schedulerGate.start()
      }
    } catch (err) {
      // fail-closed：inspectStartup 抛错不默认 NORMAL → 不启动调度器（read-only host 存活）
      startupStateResolved = true
      shouldStartSchedulers = false
      host.log.warn('Phase 3 启动 reconcile 失败（fail-closed：destructive 调度器不启动）', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })()
  // 缓存自动清理：启动即清一次 + 每 24h 定时清一次。
  // 只清「可重建/一次性」缓存与临时文件（tmp 暂存、exports 导出副本、market cache/work），
  // 保留期内的文件不删（供刷新恢复导入/下载等窗口继续消费）；snapshots 与 sync 属用户数据/安全网不动。
  // 尽力而为：任何失败仅记日志，不影响插件挂载与其他功能。
  const runCacheCleanup = (): void => {
    void cleanupCaches({
      tmpDir,
      exportsDir,
      // 定时备份产物（dsh-config-auto-*）豁免按天回收：保留策略归 BackupScheduler
      // （保留最近 N 个），避免 7 天回收与「保留 10 个」相互截断。
      exportsExemptPrefix: AUTO_BACKUP_PREFIX,
      marketCacheRoot: join(marketDir, 'cache'),
      marketWorkRoot: join(marketDir, 'work'),
    })
      .then((report) => {
        if (report.removed > 0) {
          host.log.info('缓存自动清理完成', { removed: report.removed, freedBytes: report.freedBytes })
        }
      })
      .catch((error) => {
        host.log.warn('缓存自动清理失败', { error: error instanceof Error ? error.message : String(error) })
      })
  }
  runCacheCleanup()
  const cacheCleanupTimer = setInterval(runCacheCleanup, CACHE_CLEANUP_INTERVAL_MS)
  ctx.effect(() => () => clearInterval(cacheCleanupTimer), 'config-manager: cache cleanup scheduler')
  // self 分区目录（相对 ~/.dsh 根）：dataDir 在 homeDir 下 → 用相对路径挂载 self adapter；
  // 自定义 dataDir 位于 ~/.dsh 之外时 Host fs 门面无法覆盖（confined to home root），
  // 不挂 self 分区并告警（其余分区不受影响）。
  const selfRel = relative(homeDir, dataDir)
  const selfDir = !selfRel.startsWith('..') && !isAbsolute(selfRel) && selfRel !== '' ? selfRel : ''
  if (selfDir === '') {
    host.log.warn(`dataDir 不在 ~/.dsh 之下（${dataDir}），self 分区（插件自身配置备份）不挂载`)
  }
  const adapters = createAdapters({
    // Namespace list = everything the settings service has registered.
    namespaces: async () => (await ctx.settings.describe({ redactSecrets: true })).map((d) => String(d.ns)),
    // Sessions 分区默认关（含敏感内容）：挂载 adapter 供 Custom Export 显式勾选（§3.3/§15）。
    includeSessions: true,
    // 导出 plugins 分区时不列本插件自身，避免备份中的自引用条目。
    selfPluginName: PLUGIN_NAME,
    // pluginFiles 扩展：额外白名单文件 + 约定配置目录（都相对 ~/.dsh 根），支持导出更多插件配置。
    pluginFiles: config?.pluginFiles,
    pluginFilesDir: config?.pluginFilesDir,
    // self 分区：插件自身配置（sync-*.json / market-config.json / ui-prefs.json）；'' = 不挂载
    selfDir,
  })

  host.log.info('config-manager 已挂载', {
    homeDir,
    dataDir,
    dshVersion: host.dshVersion,
    adapters: adapters.map((a) => a.id),
  })

  // 定时全量备份调度器（P0-3）：宿主后台按固定间隔导出全量备份 ZIP（恒不含 secret、
  // 不加密——加密密码仅内存且不能持久化，与自动同步同语义）。配置存
  // sync/backup-schedule.json（随 self 分区备份迁移）；enabled 缺省 false。
  // 路由（PUT /backup-schedule 保存重排 / POST run 立即执行）经 RoutesDeps 注入；
  // 随插件生命周期停止（见下方 effect），避免旧调度器残留导致重复备份。
  // P2-A（Phase 8）：run 注册表单实例 —— 定时备份调度器与路由层共享同一实例
  // （/progress 与 /runs 的单一事实源；backup-schedule 与 import/restore 等 run 同库登记）。
  // 注意：跨 kind 的真实互斥由 GLOBAL mutation lock 保证（backup-schedule 与 destructive
  // 路由共用 host.mutationLock），共享注册表是 hygiene，不替代 Lock（见 Phase 2 Handoff）。
  const runs = new RunRegistry({ msg: host.msg })
  const backupScheduler = new BackupScheduler({
    syncDir,
    exportsDir,
    host,
    adapters,
    runs,
    msg: host.msg,
    exporterVersion: PLUGIN_VERSION,
    mutationLock: host.mutationLock,
    isBlocked: () => host.safeModeIsBlocked?.() ?? false,
    phase3Recovery: host.phase3Recovery,
    // Phase 6：定时备份迁移历史（best-effort；COMPLETE 不变量）。
    appendHistoryFn: async (entry) => { await historyStore.append(entry) },
  })
  // Phase 6：迁移历史引擎（统一审计史；per-file append-only 存储于 <dataDir>/migration-history）
  const historyStore = new MigrationStore({ dir: historyDir })
  const { routes, scheduler, makeSyncEngine } = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs,
    syncDir,
    marketDir,
    dataDir,
    // F2：部署者 personalPatterns → 强化 Secret 扫描器（未配置 = 默认行为）
    scanner: createConfiguredSecretScanner(config?.personalPatterns),
    credentials: ctx.credentials,
    githubClientId: config?.githubClientId ?? DEFAULT_GITHUB_CLIENT_ID,
    githubClientSecret: config?.githubClientSecret,
    backupScheduler,
    history: historyStore,
  })
  // Agent 可调用的模型工具（P0-1）：复用 src/core 引擎与同一 makeSyncEngine 来源。
  // 不依赖 webServer：host 侧能力在无 Web 部署时仍可用；tools 服务未组合时内部守卫跳过。
  registerModelTools(ctx, {
    host,
    adapters,
    exportsDir,
    snapshotsDir,
    syncDir,
    makeSyncEngine,
    exporterVersion: PLUGIN_VERSION,
  })
  // P1-B：backupScheduler 不再同步 start —— 由启动 recovery 分类完成后（仅 NORMAL）启动。
  schedulerGate.start = () => { scheduler.start(); backupScheduler.start(); }
  // 若启动分类已在此构造完成前解析为 NORMAL（罕见竞态），立即补启动。
  if (startupStateResolved && shouldStartSchedulers && schedulerGate.start !== null) { schedulerGate.start(); }
  ctx.effect(() => () => backupScheduler.stop(), 'config-manager: backup scheduler')
  // 自动同步调度器随插件生命周期停止：插件重载/卸载时清理定时器，
  // 避免旧调度器残留导致重复后台同步。
  ctx.effect(() => () => scheduler.stop(), 'config-manager: autosync scheduler')
  const webServer = readService<WebServer>(ctx, 'webServer')
  if (webServer === undefined) {
    host.log.warn('webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册（引擎能力仍可用）')
    return
  }
  ctx.effect(() => {
    const disposers = routes.map((route) => webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'config-manager: routes')
}
