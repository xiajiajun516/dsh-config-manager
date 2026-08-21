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
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pull the Cordis Context augmentations (webServer / workspaceRegistry)
// and the WebRoute contract without any runtime import.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as yaml from 'js-yaml'

import { Exporter, FileSnapshotStore, Importer } from './core/index.ts'
import { cleanupCaches } from './core/cache-cleaner.ts'
import { listSnapshots, planRestore, type RestorePlan, type RestoreReport } from './core/restore.ts'
import { rollback as performRollback } from './core/rollback.ts'
import { RunRegistry, type RunState } from './core/run-registry.ts'
import { makeMsg, msgOf, zhMsg } from './core/messages.ts'
import type { MsgFunc } from './core/messages.ts'
import {
  hasDshBundlePatch, installErrorFor, installSpecFor, listInstalledPlugins,
  resolveProfileDir, resolveProfileNameFromArgv, runDshPlugin, validateProfileName,
} from './core/plugin-cli.ts'
import type {
  ConfigAdapter, CredentialsFacade, FileSystemFacade, HostContext, ImportDecisions,
  ImportPlan, NamespaceInfo, PatchFileFacade, PlanItem, PlanItemKind, PluginInfo, PluginsFacade,
  SettingsFacade, WorkspaceFacade,
} from './core/types.ts'
import { createAdapters, USER_PATCH_FILE } from './adapters/index.ts'
import { createEncryptionProvider, decryptCredentials, decryptArchive, SecurityError, encryptArchive, isArchiveBlob, verifyEncryptedBlob } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import { WebDavTransport } from './sync/webdav/webdav-transport.ts'
import { DeviceFlowStore, GitHubAuthClient } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import type { ApplyItemsReport } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { readAllAutosyncConfigs, readAutosyncConfig, writeAutosyncConfig } from './sync/autosync-config.ts'
import type { AutosyncConfig, AutosyncInterval, AutosyncRunStatus } from './sync/autosync-config.ts'
import { appendAutosyncEntry, readSyncHistory } from './sync/sync-history.ts'
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
import { readUiPrefs, writeUiPrefs, UI_PREFS_SCHEMA_VERSION } from './sync/ui-prefs.ts'
import type { UiPrefsChannel } from './sync/ui-prefs.ts'
import type { SyncTransport } from './sync/transport.ts'
import { GitMarketReader } from './market/reader.ts'
import { parseMarketIndex } from './market/index-parser.ts'
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
import { redact } from './security/redaction.ts'
import { sha256Hex } from './utils/hashing.ts'
import { MANIFEST_FILE, parseManifest } from './schema/manifest.ts'
import { SECTION_IDS } from './schema/config.ts'
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
const PLUGIN_VERSION = '0.1.41'

/** Plugin own package name — excluded from its own exported plugins list. */
const PLUGIN_NAME = 'dsh-config-manager'

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
}

/* ---------------------------------------------------------------- constants */

/** Route family — must match the browser half's CONFIG_MANAGER_API exactly. */
const API = {
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  download: '/api/dsh-config-manager/download',
  upload: '/api/dsh-config-manager/upload',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  execute: '/api/dsh-config-manager/execute',
  decryptArchive: '/api/dsh-config-manager/decrypt-archive',
  progress: '/api/dsh-config-manager/progress',
  runs: '/api/dsh-config-manager/runs',
  snapshots: '/api/dsh-config-manager/snapshots',
  restore: '/api/dsh-config-manager/restore',
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
    await this.provider().replace(settingsNamespace(namespace), value as object, expectedRevision)
  }

  async update(namespace: string, patch: unknown, expectedRevision?: number): Promise<void> {
    await this.provider().update(settingsNamespace(namespace), patch as object, expectedRevision)
  }
}

/** Credentials facade over the real ctx.credentials (values never round-trip). */
class DshCredentialsFacade implements CredentialsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }> {
    const info = await this.ctx.credentials.describe(credentialRef(ref))
    return { configured: info.configured, source: info.source, writable: info.writable }
  }

  async set(ref: string, value: string): Promise<void> {
    await this.ctx.credentials.set(credentialRef(ref), value)
  }

  async unset(ref: string): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(ref))
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

  async install(pkg: string, spec?: string): Promise<{ needsRestart: boolean }> {
    const profileDir = resolveProfileDir(this.homeDir, this.profile)
    // 非 registry 来源（github:/git+/file: 等）按来源 spec 安装；registry 包按裸包名装
    // npm 最新版（官方机制）。spec 丢失（旧备份）时退化为裸包名 → pnpm fetch-404，
    // 由 installErrorFor 给出可操作诊断。
    const result = await this.runner(profileDir, this.profile, ['add', installSpecFor(pkg, spec)])
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
    await fs.mkdir(dirname(p), { recursive: true })
    await fs.writeFile(p, text, 'utf8')
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
    const target = this.abs(relPath)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, data)
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
    const target = this.abs(to)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.copyFile(this.abs(from), target)
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
  readonly settings: SettingsFacade
  readonly credentials: CredentialsFacade
  readonly plugins: PluginsFacade
  readonly workspace: WorkspaceFacade
  readonly patchFile: PatchFileFacade
  readonly fs: FileSystemFacade

  constructor(ctx: Context, homeDir: string, profile: string) {
    this.homeDir = homeDir
    this.dshVersion = resolveDshVersion(homeDir)
    this.profile = profile
    this.msg = makeMsg(resolveAppLanguage(ctx))
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
  /** m-sync-ui：原始 DSH credentials（resolve token / set token / describe 状态） */
  credentials: CredentialProvider
  /** m-github-oauth：GitHub OAuth App 凭据（device flow 必需 client_id；client_secret 可选） */
  githubClientId?: string
  githubClientSecret?: string
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
 */
export async function executeRestorePlan(
  plan: RestorePlan,
  exec: RestoreExecutor,
): Promise<RestoreReport> {
  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  }
  for (const action of plan.actions) {
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
 * 解析「一键上传/我的配置」请求体的 form 字段：仅 { name, description?, categories? }。
 * name 必填（非空字符串，trim 后取）；description 可选字符串；categories 可选字符串数组。
 * 非法 → null（调用方返回 400）。用户可填内容就这三项，其余元数据全自动。
 */
function parseMeForm(raw: unknown): { name: string; id?: string; description?: string; categories?: string[] } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : ''
  if (name === '') return null
  const form: { name: string; id?: string; description?: string; categories?: string[] } = { name }
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
  return form
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): { routes: WebRoute[]; scheduler: AutoSyncScheduler } {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, marketDir, credentials, githubClientId, githubClientSecret } = deps
  const roots = [exportsDir, tmpDir]

  /** m-github-oauth：宿主侧设备码登记表 + auth 客户端（进程生命周期；device_code 只存内存） */
  const githubFlows = new DeviceFlowStore()
  const githubAuth = new GitHubAuthClient()
  const msg = host.msg

  /** 已知 adapter id 集合（push 请求体 sections 校验用）。 */
  const knownSyncSectionIds = new Set(adapters.map((a) => a.id))
  /** 可同步分区目录（status 回填 UI「高级/自定义导出」勾选列表；只含 portable，与 SyncEngine 一致）。 */
  const syncSectionCatalog = adapters
    .filter((a) => a.portability === 'portable')
    .map((a) => ({ id: a.id, displayName: a.displayName, portability: a.portability, defaultIncluded: a.defaultIncluded }))

  const makeImporter = (): Importer => new Importer({
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({ dir: snapshotsDir }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
    msg,
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
  })
  // 启动：读 autosync-config；若 enabled 启动定时器；无条件执行一次「启动触发下载合并」（受阈值约束）
  scheduler.start()

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
        // Encryption password is in-memory only (never persisted / logged).
        // 加密是独立选项：只要提供了密码就注入 EncryptionProvider
        // （includeSecrets=false 时备份仍标记加密，但 secrets.enc 内容为空）。
        const password = typeof body['password'] === 'string' && body['password'] !== '' ? body['password'] : undefined
        const outPath = join(exportsDir, `dsh-config-${dateStamp()}-${randomBytes(3).toString('hex')}.zip`)
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
          writeJson(res, 200, { zipPath: outPath, manifest: result.manifest, report: result.report, runId })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          runs.fail(runId, message)
          host.log.error('导出失败', { error: message })
          writeJson(res, 500, { error: message, runId })
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
          // 解密得到明文 ZIP
          const plain = await decryptArchive(container, verified.info, verified.kdf, password)
          plainZipPath = join(tmpDir, `decrypted-${randomBytes(6).toString('hex')}.zip`)
          await fs.writeFile(plainZipPath, plain)
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
      handler: async (req, res) => {
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
            // m1 埋点：每完成一个计划项实时更新 run 状态（/progress 轮询可见）
            onItem: (info) => {
              runs.update(runId, {
                section: info.adapter,
                item: info.index,
                itemTotal: info.total,
                detail: info.detail ?? info.adapter,
              })
            },
          })
          // 结束写结果：导入结果落账（供 /progress 查询与刷新恢复）
          runs.finish(runId, result)
          writeJson(res, 200, { ...result, runId })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          runs.fail(runId, message)
          host.log.error('导入执行失败', { error: message })
          writeJson(res, 400, { error: message, runId })
        }
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
        }
        try {
          if (dryRun) {
            writeJson(res, 200, { dryRun: true, plan: await planRestore(restoreOpts) })
            return
          }
          const plan = await planRestore(restoreOpts)
          const report = await executeRestorePlan(plan, makeRestoreExecutor(snapshotDir, host, host.profile))
          writeJson(res, 200, { dryRun: false, report })
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
          await writeUiPrefs(syncDir, { schemaVersion: UI_PREFS_SCHEMA_VERSION, ...(channel !== undefined ? { lastSyncChannel: channel } : {}) })
          writeJson(res, 200, { ok: true, lastSyncChannel: channel })
        } catch (error) {
          writeSyncRouteError(res, error)
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
          const report = await withTimeout(
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
      },
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
      handler: async (req, res) => {
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
            })
          } finally {
            // 用完再清理临时 ZIP（此前在 applyItems 读取前就删除 → ENOENT：无法读取备份文件）
            await fs.rm(dirname(session.zipPath), { recursive: true, force: true }).catch(() => { /* 尽力清理临时 ZIP */ })
          }
          writeJson(res, 200, {
            ok: report.ok,
            applied: report.applied,
            skipped: subItems.map((i) => i.id),
            needsRestart: report.needsRestart === true,
            warnings: report.warnings,
            restoreId: report.restoreId,
            rolledBack: report.rolledBack,
            failed: report.failed,
            result: report.result,
          })
        } catch (error) {
          writeSyncRouteError(res, error)
        }
      },
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
      handler: async (req, res) => {
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
          writeJson(res, 200, { ok: true, full: report.full })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
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
            items.push(toMarketListItem(item, cacheState))
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
        try {
          const zipBytes = await fs.readFile(zipPath)
          const result = prepareMarketItem({ itemId, name, version, description, author, repoUrl, categories, zipBytes })
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
  ]
  return { routes: routesList, scheduler }
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
  mkdirSync(exportsDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })
  mkdirSync(marketDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config))
  // 缓存自动清理：启动即清一次 + 每 24h 定时清一次。
  // 只清「可重建/一次性」缓存与临时文件（tmp 暂存、exports 导出副本、market cache/work），
  // 保留期内的文件不删（供刷新恢复导入/下载等窗口继续消费）；snapshots 与 sync 属用户数据/安全网不动。
  // 尽力而为：任何失败仅记日志，不影响插件挂载与其他功能。
  const runCacheCleanup = (): void => {
    void cleanupCaches({
      tmpDir,
      exportsDir,
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

  const { routes, scheduler } = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs: new RunRegistry({ msg: host.msg }),
    syncDir,
    marketDir,
    credentials: ctx.credentials,
    githubClientId: config?.githubClientId ?? DEFAULT_GITHUB_CLIENT_ID,
    githubClientSecret: config?.githubClientSecret,
  })
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
