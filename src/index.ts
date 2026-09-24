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
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
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
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as yaml from 'js-yaml'

import { endpoint, registerRoutes, requireJsonObject, writeJson, readJsonBody, writeJsonError, writeRouteError, errorMessage, RouteError } from './routes/kit.ts'
import { buildRoutes } from './routes/index.ts'
import type { RecoveryOrchestrator } from './core/recovery-orchestrator.ts'
import type { Portability } from './core/types.ts'
import { Exporter, FileSnapshotStore, Importer, verifySnapshot } from './core/index.ts'
import { APPLY_ORDER } from './core/analyzer.ts'
import { DshProfileError, DshProfileManager } from './profiles/index.ts'
import { cleanupCaches } from './core/cache-cleaner.ts'
import { isValidSnapshotId, planRestore, type RestoreActionKind, type RestorePlan, type RestoreReport } from './core/restore.ts'
import { rollback as performRollback } from './core/rollback.ts'
// Phase 1 P0-1/P0-2：配置生命周期（自动快照 / 撤销 / 重做）与 P0-5 崩溃归因。
// 监听工厂用真 fs.watch 注入（core 侧只依赖抽象，便于测试驱动时序）。
import { ConfigLifecycle } from './core/config-lifecycle.ts'
import { deleteConfigSnapshot } from './core/config-snapshot.ts'
import { adviceFor, beginBoot, computeBootAlert, listCandidateLogs, markBootOk, readBootState, readCrashLogTail, writeBootState } from './core/crash-report.ts'
// Phase 1 P0-3：启动救援模式（备份 patch/package.json → 写最小 patch → 中和 bundles）
import { enterRescueMode, exitRescueMode, rescueModeStatus } from './core/boot-rescue.ts'
import { auditBootSafety } from './core/boot-safety.ts'
import type { BootSafetyReport } from './core/boot-safety.ts'
import { watch as fsWatch } from 'node:fs'
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from './core/recovery-orchestrator.ts'
import { JournalStore } from './core/journal.ts'
import { RunRegistry, type RunState } from './core/run-registry.ts'
import { registerModelTools } from './core/model-tools.ts'
import { makeMsg, msgOf, zhMsg } from './core/messages.ts'
import type { MsgFunc } from './core/messages.ts'
import { cleanupAbortedInstall, hasDshBundlePatch, installErrorFor, installSpecFor, listInstalledPlugins, resolveProfileDir, resolveProfileNameFromArgv, readProfileManifest, runDshPlugin, validateProfileName } from './core/plugin-cli.ts'
import type { ConfigAdapter, CredentialsFacade, ExportUnit, FileSystemFacade, HostContext, ImportDecisions, ImportPlan, NamespaceInfo, PatchFileFacade, PlanItemKind, PluginInfo, PluginsFacade, SessionMoveResult, SessionParentRelation, SessionRewriteResult, SessionStoreFacade, SettingsFacade, WorkspaceFacade } from './core/types.ts'
import { ImportUserSkippedError } from './core/types.ts'
import { createAdapters, USER_PATCH_FILE } from './adapters/index.ts'
import { createLocalPluginPackHook } from './core/local-plugin-host.ts'
import { createEncryptionProvider, decryptCredentials, SecurityError, encryptArchive } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { collectCredentialRefs } from './security/credentials-yaml.ts'
import { applySessionMeta, applySessionMetaToPlanItems, applySessionParentLinks, readSessionMeta, subagentParentMap } from './core/session-meta.ts'
import { PROJECT_KEY_RE, readLogCwdFromBytes, rewriteSessionLogDir } from './utils/session-log.ts'
import { atomicCopyFile, atomicWriteFile } from './utils/atomic-write.ts'
import { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError, type MutationLockContext } from './utils/env-lock.ts'
import { activeProxySummary } from './utils/proxy.ts'
import { listRecursiveFollowingLinks } from './utils/recursive-walk.ts'
import { Phase3Recovery, TransactionRecoveryRequiredError, mapLockStateForStartup } from './core/phase3-host.ts'
import type { JournalRunContext } from './core/phase3-host.ts'
import { classifyStartup, FAIL_CLOSED_STARTUP } from './core/startup-barrier.ts'
import type { MutationLockPort } from './utils/env-lock.ts'
import type { RecursiveListing } from './utils/recursive-walk.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import { WebDavTransport } from './sync/webdav/webdav-transport.ts'
import { DeviceFlowStore, GitHubAuthClient } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { BackupScheduler } from './sync/backup-scheduler.ts'
import { readBackupSchedule } from './sync/backup-schedule-config.ts'
import { AUTO_BACKUP_PREFIX, isValidExportFileName, resolveNonCollidingExportName, writeBackupNote } from './sync/backup-files.ts'
import { DEFAULT_RETENTION_POLICY, selectPruneCandidatesByPolicy } from './sync/retention-policy.ts'
import type { RetentionPolicy } from './sync/retention-policy.ts'
import type { PruneSelector } from './core/backup.ts'
import { selectPruneCandidates } from './core/backup.ts'
import { readAllAutosyncConfigs, readAutosyncConfig } from './sync/autosync-config.ts'
import type { AutosyncInterval, AutosyncRunStatus } from './sync/autosync-config.ts'
import { appendAutosyncEntry } from './sync/sync-history.ts'
import { MigrationStore, type MigrationKind, type MigrationResult, MIGRATION_HISTORY_DIR } from './core/migration-history.ts'
import { readSyncConfig, validateRepoUrl, validateWebDavUrl, isWebDavConfig, channelOf, parseSyncChannel, SYNC_CHANNELS } from './sync/sync-config.ts'
import type { SyncConfig, SyncTransportType } from './sync/sync-config.ts'
import { defaultSyncSelection, effectiveSections, normalizeSessionsInclude, OPT_IN_SYNC_SECTIONS, readAllSyncSelections, readSyncSelection } from './sync/sync-selection.ts'
import type { SyncSelection, SyncSelectionMode } from './sync/sync-selection.ts'
import type { SyncTransport } from './sync/transport.ts'
import { GitMarketReader } from './market/reader.ts'
import { parseMarketIndex } from './market/index-parser.ts'
import { prepareMarketItem } from './market/prepare.ts'
import type { MarketIndex, MarketSummary } from './market/types.ts'
import { GitHubAuthRest, GitHubApiError } from './market/github-repos.ts'
import { MyRepoService } from './market/my-repo.ts'
import { createGitFileWriter } from './market/git-file-writer.ts'
import { parseGitHubRepoUrl } from './market/repo-url.ts'
import { StarCache } from './market/star-cache.ts'
import { createConfiguredSecretScanner } from './security/secret-scanner.ts'
import type { ConfiguredSecretPatterns } from './security/secret-scanner.ts'
import type { SecretScanner } from './core/types.ts'
import { sha256Hex } from './utils/hashing.ts'
import { MANIFEST_FILE, parseManifest } from './schema/manifest.ts'
import { isFileSection, SECTION_IDS } from './schema/config.ts'
import { stringifyJsonSafe } from './utils/json.ts'
import type { Manifest, SectionId, WorkspaceRecord } from './schema/types.ts'
import { parseZip } from './utils/zip.ts'
import { isSameOrChild } from './utils/paths.ts'
import { createLogger, parseLogLevel, type Logger } from './utils/logger.ts'

/* ---------------------------------------------------------------- identity */

/** Stable cordis plugin name — must match the cordis.patch.yml row id. */
export const name = 'config-manager'

/** Services required before the engine can mount (present in every profile). */
export const inject = ['settings', 'credentials']

/** Plugin version, kept in sync with package.json ("version"). */
export const PLUGIN_VERSION = '0.1.64'

/** Plugin own package name — excluded from its own exported plugins list. */
const PLUGIN_NAME = 'dsh-config-manager'

/**
 * Star 引导弹窗指向的 GitHub 仓库（用户引导点 Star 的目标）。
 * 与 package.json 的 repository 字段保持一致；界面不可改（硬编码，参照
 * 「一键上传」目标仓库先例）。仅在 GET /star-prompt 响应中返回，供弹窗按钮跳转。
 */
export const STAR_PROMPT_REPO_URL = 'https://github.com/xiajiajun516/dsh-config-manager'

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

/**
 * 本文件保留的 8 条路由的路径（被源码级守卫按文件窗口钉住，见下方 routesList 注释）。
 *
 * 其余 57 条路由的路径**声明在各自的组文件里**（src/routes/*.ts 的 endpoint({ path, methods })）——
 * 新增一条 API 只需那一条声明，不再有「常量表 + 路由对象」两处要同步。
 */
export const API = {
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  exportPreview: '/api/dsh-config-manager/export-preview',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  lifecycle: '/api/dsh-config-manager/lifecycle',
  crash: '/api/dsh-config-manager/crash',
  rescue: '/api/dsh-config-manager/rescue',
} as const

/**
 * 灾备子系统（Phase 1）总开关 —— 临时下线，待相关缺陷修复后再放出。
 *
 * 置 false 时整个灾备子系统停摆：
 *  - 不启动配置变更监听 → 不产生自动快照（也不再刷「配置快照超出上限」告警）
 *  - 不写 boot-state → 崩溃归因无观测数据（不影响启动）
 *  - /lifecycle /crash /rescue 三条路由一律 503 feature-disabled
 *
 * 与客户端导航入口开关配套：src/client/ConfigManagerSection.tsx 的 SHOW_LIFECYCLE_NAV。
 * 两者都置 true 才是一套完整的灾备功能。
 *
 * 为什么整体下线而不是只停自动快照：自动快照的采集走**全部 adapter**，其中 sessions
 * 分区（历史会话，本机实测 340 MB）远超快照 64 MiB 上限，必然持续失败并刷告警；
 * 在该缺陷修好前，撤销/重做/救援也没有可信的快照基线可用。
 */
const LIFECYCLE_ENABLED: boolean = false

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

/**
 * 同步快照「加密密码 / 解密密码」的 DSH credentials 引用名前缀（按通道各自独立）。
 *
 * 为什么放 DSH credentials：加密/解密密码跨会话必须可用（否则每次推送都要重新输入），
 * 但**绝不允许**写进 sync-selection.json 一类同步文件（那等于把密码推上远端）。
 * 与本插件既有的 token / WebDAV 口令同一套做法：值只存在于 DSH 凭据库，
 * 宿主内部按需 resolve，**永不回传浏览器**（UI 只拿到 configured 布尔）。
 * 引用名形如 DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_GIT。
 */
export const SYNC_ENCRYPT_PASSWORD_REF_PREFIX = 'DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD'
export const SYNC_DECRYPT_PASSWORD_REF_PREFIX = 'DSH_CONFIG_MANAGER_SYNC_DECRYPT_PASSWORD'

/** ('ENCRYPT'|'DECRYPT', 'git'|'webdav') → 该通道的凭据引用名。 */
export function syncPasswordRef(kind: 'ENCRYPT' | 'DECRYPT', channel: SyncTransportType): string {
  const prefix = kind === 'ENCRYPT' ? SYNC_ENCRYPT_PASSWORD_REF_PREFIX : SYNC_DECRYPT_PASSWORD_REF_PREFIX
  return prefix + '_' + channel.toUpperCase()
}

/* 路由基础设施（loopback 围栏 / writeJson / readJsonBody / queryParam / endpoint / 错误映射）
 * 已收敛到 src/routes/kit.ts —— 全仓只有那一份实现。 */
/**
 * 档案路由的错误响应：engine 的 DshProfileError 带 code（UI 据此映射本地化文案，
 * 不显示裸英文码）；其它异常按 500 处理。
 */
export function writeProfileError(res: ServerResponse, error: unknown): void {
  if (error instanceof DshProfileError) {
    const status = error.code === 'notFound' ? 404 : error.code === 'exists' ? 409 : 400
    writeJsonError(res, status, error.message, error.code)
    return
  }
  writeJsonError(res, 500, errorMessage(error))
}

/** Stream a raw request body to a file, enforcing a byte cap. */
export async function writeRequestBodyToFile(req: IncomingMessage, dest: string, maxBytes: number): Promise<number> {
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
export const credentialRef = safeCredentialRef


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

  private registry(): { list(): { id: unknown; path: string; title: string; sessionIds: readonly unknown[]; createdAt: string; updatedAt: string }[]; get(id: unknown): { title: string; setTitle(title: string): Promise<void>; attachSession(sessionId: string): Promise<void> } | undefined; create(path: string, title?: string): Promise<unknown>; delete(id: unknown): Promise<boolean> } | undefined {
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

  /**
   * 把一个已存储会话登记进工作区（issue #45 会话归位）。
   *
   * 走 DSH `workspaceRegistry` 的实体方法 `attachSession`：
   *  - DSH 自己读会话 header 并用 realpath 校验 cwd 必须等于该工作区 path（不匹配直接拒绝）；
   *  - 写入走 storage domain 的原子 update（内存权威与磁盘同时更新），并按 cwd 剪掉不属于
   *    本工作区的候选 —— 因此**不需要**插件做「注册表合并 / 去重 / 备份回滚」，
   *    更**不得**旁路直写 storages/workspace.json。
   */
  async attachSession(workspaceId: string, sessionId: string): Promise<void> {
    const registry = this.registry()
    if (!registry) throw new Error(this.msg('host.workspaceUnavailable'))
    const existing = registry.get(workspaceId as unknown as WorkspaceId)
    if (!existing) throw new Error(this.msg('host.workspaceMissingTarget', { id: workspaceId }))
    await existing.attachSession(sessionId)
  }
}

// 字节级工具（projectKey 形状 / 首帧 cwd 读写 / 多 generation 改写）已抽到 utils/session-log.ts：
// 宿主在线路径与 CLI 离线修复共用同一份实现（避免两处口径漂移）。

export class DshSessionStoreFacade implements SessionStoreFacade {
  private readonly ctx: Context
  /** DSH 缺省会话根（配置改过时只影响快路径命中率，慢路径仍正确） */
  private readonly root: string

  constructor(ctx: Context, homeDir: string, msg: MsgFunc = zhMsg) {
    this.ctx = ctx
    this.root = join(homeDir, 'sessions')
  }

  /**
   * 按**相对会话根**的目录搬迁会话目录（issue #45 ④ 导入期归位）。
   *
   * 与 `moveSession` 同一套安全约束，区别只在「怎么找到目录」：这条**不依赖会话存储的解析接口** ——
   * 刚导入完、位置还与 header 不一致时，存储的 list/解析会抛错（DSH 的 corrupt session log），
   * 只有按路径搬这一条路可用。
   */
  async relocateDir(sessionDirRel: string, targetProjectKey: string): Promise<SessionMoveResult> {
    if (!PROJECT_KEY_RE.test(targetProjectKey)) return { moved: false, reason: 'unavailable' }
    const dir = this.sessionDirFromRel(sessionDirRel)
    if (dir === undefined) return { moved: false, reason: 'unavailable' }
    return await this.relocateDirAbsolute(dir, targetProjectKey)
  }

  /**
   * 按**路径**改写一个会话目录下全部 generation 的首帧 cwd（导入期跨机映射用，issue #45）。
   *
   * 与 rewriteCwd 的区别：这条不依赖会话存储的解析接口（导入刚写完时那里可能是坏的），只认路径。
   * 安全序列与在线改写完全一致（utils/session-log.ts 的 rewriteSessionLogDir）：只换第 1 帧、
   * 尾部逐字节流式拷贝、发布前自检、失败回滚其它 generation。
   */
  async rewriteLogDir(sessionDirRel: string, newCwd: string): Promise<SessionRewriteResult> {
    const dir = this.sessionDirFromRel(sessionDirRel)
    if (dir === undefined) return { ok: false, reason: 'unavailable' }
    // POSIX：目录内的内核锁文件存在 ⇒ 可能被其它进程持有（Windows 无锁文件，用命名信号量）
    if (process.platform !== 'win32' && await this.exists(join(dir, 'session.lock'))) {
      return { ok: false, reason: 'locked' }
    }
    return await rewriteSessionLogDir(dir, newCwd)
  }

  /** 相对会话根的目录 → 绝对目录（越界 / 含 .. / 空一律 undefined，绝不拼出会话根之外的路径）。 */
  private sessionDirFromRel(sessionDirRel: string): string | undefined {
    const rel = sessionDirRel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (rel === '' || rel.includes('..')) return undefined
    const dir = resolve(join(this.root, rel))
    return isSameOrChild(dir, resolve(this.root)) ? dir : undefined
  }

  /**
   * 只读：从会话日志**字节**里取出首帧 header 的 cwd（issue #45 ④ 导入期校验用）。
   * 解不出来（非 zstd / 首帧不完整 / 非单行 JSON / 无 cwd）→ undefined：调用方按「无法判定」处理，绝不猜。
   */
  readLogCwd(bytes: Uint8Array): string | undefined {
    return readLogCwdFromBytes(bytes)
  }

  /** 搬迁实现（绝对目录；目标段白名单 + 不覆盖 + 锁文件 + 搬后自检失败回滚）。 */
  private async relocateDirAbsolute(dir: string, targetProjectKey: string): Promise<SessionMoveResult> {
    // 目标段白名单：非法/越界一律不搬（绝不拼出根目录之外的路径）
    if (!PROJECT_KEY_RE.test(targetProjectKey)) return { moved: false, reason: 'unavailable' }
    const projectDir = dirname(dir)
    const root = dirname(projectDir)
    const fromProjectKey = basename(projectDir)
    if (fromProjectKey === targetProjectKey) return { moved: false, reason: 'already-there', from: dir }
    const target = join(root, targetProjectKey, basename(dir))
    if (await this.exists(target)) return { moved: false, reason: 'conflict', from: dir, to: target }
    // POSIX：目录内的内核锁文件存在 ⇒ 可能被其它进程持有（Windows 无锁文件，用命名信号量）
    if (process.platform !== 'win32' && await this.exists(join(dir, 'session.lock'))) {
      return { moved: false, reason: 'locked', from: dir, to: target }
    }
    try {
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.rename(dir, target)
    } catch {
      return { moved: false, reason: 'unavailable', from: dir, to: target }
    }
    // 自检：目标存在且原目录已不在；不满足 → 回滚（尽力而为）并报不可用
    if (!(await this.exists(target)) || await this.exists(dir)) {
      try {
        await fs.rename(target, dir)
      } catch {
        // 回滚失败：报告不可用，由调用方展示（绝不谎报成功）
      }
      return { moved: false, reason: 'unavailable', from: dir, to: target }
    }
    return { moved: true, from: dir, to: target }
  }

  /**
   * 让工作区注册表重新索引某个会话的 header（改写后**必须**调用）。
   *
   * 为什么需要：注册表在启动时就把所有已存储会话的 header 缓存进内存，`attachSession`
   * 走的正是这份缓存 —— 改写磁盘后若不刷新，校验用的仍是旧 cwd（在目标机不解析）而必然失败。
   *
   * 实现依赖 DSH `WorkspaceRegistry` 的 `indexHeader`（d.ts 标为 private，运行时可调用）：
   * 这是本功能对 DSH 内部唯一的越界点，**刻意只用一个方法、且永不整体重建索引**
   * （整体重建 replaceHeaderIndex 会清空 sessionPaths，可能连带隐藏本进程的活跃会话）。
   * 不可用/失败 → 返回 false，由调用方如实标注「需重启 DSH 后再执行一次归位」。
   */
  async reindexSessionHeader(sessionId: string): Promise<boolean> {
    const registry = readService<{ indexHeader?: (header: unknown) => unknown }>(this.ctx, 'workspaceRegistry')
    // 会话存储服务：只用来取出该会话的最新 header（注册表内存里的那份可能已被改写作废）
    const store = readService<{ list(): Promise<readonly { header?: { id?: unknown } }[]> }>(this.ctx, 'sessionPersistence')
    if (registry === undefined || typeof registry.indexHeader !== 'function' || store === undefined) return false
    try {
      const snapshots = await store.list()
      const fresh = snapshots.find((snapshot) => snapshot.header?.id === sessionId)?.header
      if (fresh === undefined) return false
      await registry.indexHeader(fresh)
      return true
    } catch {
      return false
    }
  }

  /**
   * 本机会话的父子关系（子会话 id → 父会话 id）。
   *
   * 实现走 DSH 会话存储的列举（与 `session/list` 同一数据源）：只取 header 的 `parentSession`，
   * 不解析任何日志字节 —— 让「导出父对话时连带子代理会话」不为此读一遍整棵会话树。
   * 字段名以磁盘 header 为准（`parentSession`；DSH 的 RPC 投影才改名为 `parentSessionId`）。
   * 服务缺失 / 列举失败 → 空 Map（调用方按「无法连带」处理，绝不假装带全）。
   */
  async parentRelations(): Promise<Map<string, SessionParentRelation>> {
    const out = new Map<string, SessionParentRelation>()
    const store = readService<{ list(): Promise<readonly { header?: { id?: unknown; parentSession?: unknown; origin?: unknown } }[]> }>(this.ctx, 'sessionPersistence')
    if (store === undefined) return out
    try {
      for (const snapshot of await store.list()) {
        const id = snapshot.header?.id
        const parent = snapshot.header?.parentSession
        if (typeof id !== 'string' || id === '' || typeof parent !== 'string' || parent === '') continue
        out.set(id, { parent, subagent: snapshot.header?.origin === 'subagent' })
      }
    } catch {
      return new Map<string, SessionParentRelation>()
    }
    return out
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path)
      return true
    } catch {
      return false
    }
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
export class DshFileSystemFacade implements FileSystemFacade {
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

  /** 仅路径列表（既有契约）：委托 listRecursiveDetailed，丢弃诊断。 */
  async listRecursive(dir: string): Promise<string[]> {
    return (await this.listRecursiveDetailed(dir)).paths
  }

  /**
   * 跟随 junction / 符号链接的遍历 + 被跳过链接清单（issue #37）。
   * 实现下沉到 utils/recursive-walk.ts（可用真实临时目录直接单测）。
   */
  async listRecursiveDetailed(dir: string): Promise<RecursiveListing> {
    return listRecursiveFollowingLinks(this.abs(dir), this.homeDir)
  }

  /**
   * 文件 mtime（毫秒；不存在 / 读不到 → null）。sessions 的「最新 N 个」依赖它：
   * 排序用「最新一份会话日志」的时间，而不是目录 mtime（增量写入时不可靠）。
   */
  async mtimeMs(relPath: string): Promise<number | null> {
    // 路径越界等安全错误必须向上抛（与其它方法一致）：被 catch 吞成 null 会让
    // 「越界 = 读不到时间」看起来像正常缺文件，掩盖真实问题（实测由测试钉住）。
    const target = this.abs(relPath)
    try {
      const st = await fs.stat(target)
      return st.mtimeMs
    } catch {
      return null
    }
  }

  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(this.abs(dir), { recursive: true })
  }

  /**
   * 绝对路径 realpath（issue #45 会话归位）。
   *
   * 与 DSH 的 realpathNormalize 同语义：只接受**已存在**的目录，解析符号链接 / `..` /
   * 结尾斜杠后返回规范化路径；不存在 / 非目录 / 权限不足 → null（**绝不**回退原字符串，
   * 否则「源机不存在的 cwd」会被误判成与某个工作区同一目录）。
   *
   * 注意：本方法走绝对路径，不受 home 目录边界限制——入参只可能来自会话 header 的 cwd
   * 与工作区记录的 path，都已是绝对路径；越界字符串由 realpath 自身失败兜底。
   */
  async realpathDir(absPath: string): Promise<string | null> {
    try {
      const target = await fs.realpath(resolve(absPath))
      const st = await fs.stat(target)
      return st.isDirectory() ? target : null
    } catch {
      return null
    }
  }

  /**
   * 建缺失目录（issue #45：导入工作区记录前把缺失的项目目录建出来）。
   *
   * 安全边界（路径来自备份 = 不可信输入）：
   *  - 必须是完全限定的绝对路径（相对路径拒绝 —— 会跟随进程 cwd）；
   *  - 任何 `..` 段一律拒绝（即便 resolve 会折叠，也说明来源可疑）；
   *  - 已存在的层级不动；返回**实际新建**的目录（由外到内）供报告展示；
   *  - 路径上出现同名文件（非目录）→ 抛错，由调用方按非致命警告处理（绝不静默）。
   */
  async ensureDir(absPath: string): Promise<string[]> {
    if (!isAbsolute(absPath)) throw new Error(this.msg('host.fsPathNotAbsolute', { path: absPath }))
    if (absPath.split(/[\\/]+/).includes('..')) throw new Error(this.msg('host.fsPathDotDot', { path: absPath }))
    const target = resolve(absPath)
    const missing: string[] = []
    let probe = target
    for (;;) {
      try {
        const st = await fs.stat(probe)
        if (!st.isDirectory()) throw new Error(this.msg('host.fsPathNotDirectory', { path: probe }))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(probe)
      }
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    if (missing.length === 0) return []
    await fs.mkdir(target, { recursive: true })
    return missing.reverse()
  }
}

/** The engine's HostContext over real DSH services. */
export class ConfigManagerHostContext implements HostContext {
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
  /** 会话存储端口（issue #45 会话归位；对 ctx.sessionPersistence 的薄适配） */
  readonly sessions: SessionStoreFacade
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
    // 日志级别缺省 warn：启动 dsh web 后控制台只留 warn/error —— 挂载横幅、调度器跳过、
    // 导出/备份完成等常规 info 不再刷屏（用户要求移除启动后的日志噪音）；
    // 排查时 DSH_CONFIG_MANAGER_LOG_LEVEL=info|debug 恢复逐条输出。
    this.log = createLogger({ level: parseLogLevel(process.env.DSH_CONFIG_MANAGER_LOG_LEVEL) })
    this.settings = new DshSettingsFacade(ctx)
    this.credentials = new DshCredentialsFacade(ctx)
    this.patchFile = new DshPatchFileFacade(homeDir, profile, this.msg)
    this.plugins = new DshPluginsFacade(homeDir, profile, this.patchFile, undefined, this.msg)
    this.workspace = new DshWorkspaceFacade(ctx, this.msg)
    this.fs = new DshFileSystemFacade(homeDir, this.msg)
    this.sessions = new DshSessionStoreFacade(ctx, homeDir, this.msg)
  }
}

/* ---------------------------------------------------------------- routes */

/** Controlled staging roots guard. */
export function isControlledPath(target: string, roots: string[]): boolean {
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
export const ROUTE_TIMEOUT_MS = 5 * 60 * 1000

/** WebDAV 单请求超时（ms）：慢速 WebDAV（如坚果云限速）上传大快照/读写索引
 * 需要比 git 通道更宽裕的窗口；错误消息会带上实际 ms，便于用户判断。 */
const WEBDAV_TIMEOUT_MS = 120_000

/** 带超时的 Promise：超时以明确错误拒绝（promise 自身由调用方负责，此处只计时）。 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
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
export async function tryDecryptCredentials(
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
  // 解析口径与同步引擎共用（security/credentials-yaml.ts）：顶层 refs 块（DSH v1 布局）
  // 与预发布扁平布局都认，records 等嵌套结构忽略（issue #39）。
  return collectCredentialRefs(parsed)
}

/**
 * 路由组依赖（src/routes/**）的真值类型。
 *
 * 为什么是「打印出来的字面类型」而不是 ReturnType<typeof makeRouteEnv>：makeRouteEnv 是
 * makeRoutes 内部的闭包构造，TypeScript 不能把函数内的推断类型导出。做法是：临时加一行
 * const probe: number = makeRouteEnv()，用 tsc --noEmit --noErrorTruncation 打印推断类型
 * （见 W1 报告的重测配方），把结果落到这里；makeRoutes 里的 const routeEnv: RouteEnvInferred =
 * 注解保证两侧不漂移（新增依赖漏登记会在构造点报错）。
 */
/**
 * 路由组依赖（src/routes/**）的真值类型。
 *
 * 为什么是「打印出来的字面类型」而不是 ReturnType<typeof makeRouteEnv>：makeRouteEnv 是
 * makeRoutes 内部的闭包构造，TypeScript 不能把函数内的推断类型导出。做法是：临时加一行
 * const probe: number = makeRouteEnv()，用 tsc --noEmit --noErrorTruncation 打印推断类型
 * （见 W1 报告的重测配方），把结果落到这里；makeRoutes 里的 const routeEnv: RouteEnvInferred =
 * 注解保证两侧不漂移（新增依赖漏登记会在构造点报错）。
 */
export type RouteEnvInferred = { adapters: ConfigAdapter<unknown>[]; backupScheduler: BackupScheduler; bootSafetyAudit: () => Promise<BootSafetyReport>; cancelDecisionTimeoutMs: number; buildMarketSummary: (e: { url: string; addedAt: string; }) => Promise<MarketSummary>; credentials: CredentialProvider; dataDir: string; exportsDir: string; githubAuth: GitHubAuthClient; githubClientId: string | undefined; githubClientSecret: string | undefined; githubFlows: DeviceFlowStore; history: MigrationStore; host: ConfigManagerHostContext; itemCached: (url: string, itemId: string) => Promise<boolean>; knownSyncSectionIds: Set<SectionId>; makeImporter: () => Importer; makeMarketReader: () => GitMarketReader; makeRecoveryExecutors: (runId: string) => RecoveryExecutorFns; makeSyncEngine: (cfg: SyncConfig, engineOpts?: { includeOptInSections?: boolean; }) => SyncEngine; marketBootAutoRefreshed: { value: boolean; }; marketCacheIndex: (url: string) => string; marketCacheItemDir: (url: string) => string; marketStarCache: StarCache; marketWorkDir: (url: string) => string; meGitHubRest: GitHubAuthRest; meService: MyRepoService; meTokenProvider: () => Promise<string>; msg: MsgFunc; prepareSync: (body: Record<string, unknown>) => Promise<SyncConfig>; profiles: DshProfileManager; pruneStagedMarketZips: () => Promise<void>; readCachedIndexObj: (url: string) => Promise<MarketIndex | null>; recoveryOrchestrator: RecoveryOrchestrator; resolveSyncPassword: (ref: string) => Promise<string | undefined>; roots: string[]; runAbortControllers: Map<string, AbortController>; runCancels: Map<string, { signal: AbortController; settle: (d: 'rollback' | 'keep') => void; decided: boolean }>; runs: RunRegistry; scheduler: AutoSyncScheduler; selectionCache: Partial<Record<"git" | "webdav", SyncSelection>>; selectionHasOptInSections: (channel: SyncTransportType) => boolean; selectionView: (channel: SyncTransportType) => Promise<SelectionView>; selectionViewByChannel: () => Promise<Record<SyncTransportType, SelectionView>>; snapshotEntrySections: (snapshotDir: string) => Promise<string[]>; snapshotsDir: string; syncCredentialsByChannelView: () => Promise<Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean; }>>; syncDir: string; syncPasswordConfigured: (ref: string) => Promise<boolean>; syncSectionCatalog: { id: SectionId; displayName: string; portability: Portability; defaultIncluded: boolean; }[]; syncSessions: SyncSessionStore; tmpDir: string; tryAppendHistory: (raw: { kind: MigrationKind; result: MigrationResult; sections: string[]; operationId?: string; snapshotId?: string; runId?: string; source: 'api' | 'autosync' | 'backup-scheduler' | 'recovery' | 'cli' | 'internal'; summary: string; error?: string; }) => Promise<string | undefined>; withMutationGate: (op: string, handler: (req: IncomingMessage, res: ServerResponse, lockCtx?: MutationLockContext, journalCtx?: JournalRunContext) => Promise<void>, opts?: { journaled?: boolean; deferredSnapshot?: boolean; }) => ((req: IncomingMessage, res: ServerResponse) => Promise<void>); writeItemCache: (url: string, itemId: string, manifestRaw: string, zipBytes: Uint8Array) => Promise<void>; }

/** 解密错误 → 用户可读文本：BAD_PASSWORD 只报「密码错误」（不泄内部细节），其余原文 */
export function decryptErrorText(error: unknown, msg: MsgFunc): string {
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
  /**
   * m-retention：快照保留策略提供者（GFS 分层；从 sync/backup-schedule.json 实时读取）。
   * 每次 prune 时调用 → 用户在 UI 改完无需重启即生效；读取失败回退缺省（见 FileSnapshotStore）。
   */
  retentionPolicy?: () => RetentionPolicy | Promise<RetentionPolicy>
  /** Phase 6：迁移历史存储（统一审计史；<dataDir>/migration-history） */
  history: MigrationStore
}

/* -------------------------------------------------- sync 路由（m-sync-ui） */

/** 同步路由可预期的请求级错误（status 缺省 400；引擎/传输失败走 500）。
 * 继承 kit 的 RouteError → 错误→HTTP 映射全仓只有 writeRouteError 一份。 */
export class SyncRouteError extends RouteError {
  constructor(message: string, status: number = 400) {
    super(message, status)
    this.name = 'SyncRouteError'
  }
}

/** 同步路由错误出口：等价于 kit 的统一出口（SyncRouteError 是 RouteError 子类，status 保真）。 */
export function writeSyncRouteError(res: ServerResponse, error: unknown): void {
  writeRouteError(res, error)
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
  const transport = parseSyncChannel(body['transport']) ?? 'git'
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

/**
 * push 请求体的 sessions 选项（历史会话「最新 N 个」上限）。
 *
 * 语义：**只有显式提供该对象**，sessions 才被允许进入同步通道（engine 的 opt-in 判定）；
 * 形状非法（数组 / 标量 / 缺对象）→ undefined = 与其它 deviceSpecific 分区一样跳过并告警。
 * limit 非法（非整数 / 负数）→ 归一化为宿主缺省（5）；超大 → 钳制。
 */
export function extractSyncSessions(body: Record<string, unknown>): { limit?: number; include?: string[] } | undefined {
  const raw = body['sessions']
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const limit = rec['limit']
  const out: { limit?: number; include?: string[] } =
    typeof limit === 'number' && Number.isInteger(limit) && limit >= 0
      ? { limit: Math.min(limit, 10000) }
      : {}
  // 显式勾选的会话单元（非空时优先于 limit；形状非法一律丢弃，不猜）
  const include = normalizeSessionsInclude(rec['include'])
  if (include.length > 0) out.include = include
  return out
}

/** 需要人工决策的 PlanItemKind（一键同步 needsReview 判定 + 逐项确认标记）。
 * 注意：'Install'（安装插件）不在此列 —— 同步拉取差异时插件按「自动安装」处理：
 * 默认采纳、不逐项展示、无需手动选择（product requirement）。
 * issue #35：'Warning' 必须**可见**——它承载「本次同步会剔除哪些无法满足的声明」这类
 * 改变配置语义的信息；此前非决策项默认自动采用且不展示，用户只看到「同步成功」。 */
export const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Error', 'PathMapping', 'Warning',
])

/**
 * issue #35：会**改变工具链行为**的项 —— 只有 pnpm-workspace.yaml 在本次同步中
 * 移除了无法满足的 patchedDependencies 声明时，才带 detail。
 * 这类项此前属「非冲突项 → 自动采用且不展示」，用户即使已知风险也无法否决
 * （issue #35 正是这条自动采用把目标机 pnpm 弄坏的）。
 * 现在：进确认列表、可见、可取消；但**默认仍采用**（我们的 sanitize 结果严格更安全，
 * 默认不采用反而会静默丢掉 allowBuilds / 冷静期配置）。
 * 注意：与客户端 sync-view.ts 的同名判定必须保持一致（两侧刻意重复，避免跨端 import）。
 */
export function isToolchainChangeItem(item: { itemId: string; detail?: string | undefined }): boolean {
  return item.itemId === 'plugins:pnpm-workspace' && item.detail !== undefined && item.detail !== ''
}

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
export function planToConfirmItems(plan: ImportPlan): SyncConfirmItem[] {
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
export function isAutosyncInterval(v: unknown): v is AutosyncInterval {
  return v === '5m' || v === '15m' || v === '30m' || v === '60m' || v === '6h' || v === '12h' || v === '24h'
}

/** 自动同步状态响应（GET /sync/autosync 与 POST 回填；读盘计算 elapsedMs）。 */
export async function buildAutosyncStatus(dir: string, channel: SyncTransportType): Promise<AutosyncStatusResponse> {
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
export async function buildAutosyncStatusByChannel(dir: string): Promise<Record<SyncTransportType, AutosyncStatusResponse>> {
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
  const out = {} as Record<SyncTransportType, AutosyncStatusResponse>
  // t32/B7：通道集合来自唯一枚举（顺序与逐个 await 语义不变）
  for (const channel of SYNC_CHANNELS) out[channel] = await build(channel)
  return out
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

/* ------------------------------------------- snapshots/file-diff（git 风格预览） */

/** 只有这四类动作对应「文件内容变更」，可请求逐行差异。 */
const DIFFABLE_RESTORE_KINDS: readonly RestoreActionKind[] = ['hostFileRestore', 'fileRestore', 'hostFileRemove', 'fileRemove'];

export type BuildFileDiffBodyResult =
  | { ok: true; value: { snapshotId: string; kind: RestoreActionKind; target?: string; blobPath?: string } }
  | { ok: false; error: string }

/**
 * POST /snapshots/file-diff 请求体校验（纯函数）。
 * target / blobPath 只是候选路径：真正的越界拦截在 core 的 homeAbs / blobAbs 护栏
 * （本函数不做路径规范化，避免两处规则漂移）。
 */
export function buildFileDiffBody(body: unknown): BuildFileDiffBodyResult {
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
  const kind = record['kind']
  if (typeof kind !== 'string' || !DIFFABLE_RESTORE_KINDS.includes(kind as RestoreActionKind)) {
    return { ok: false, error: 'kind must be one of hostFileRestore/fileRestore/hostFileRemove/fileRemove' }
  }
  const rawTarget = record['target']
  const rawBlob = record['blobPath']
  return {
    ok: true,
    value: {
      snapshotId,
      kind: kind as RestoreActionKind,
      target: typeof rawTarget === 'string' && rawTarget !== '' ? rawTarget : undefined,
      blobPath: typeof rawBlob === 'string' && rawBlob !== '' ? rawBlob : undefined,
    },
  }
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
export function makeRestoreExecutor(snapshotDir: string, host: HostContext, profile: string): RestoreExecutor {
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
export function parseMeForm(raw: unknown): { name: string; id?: string; description?: string; categories?: string[]; mode?: 'migrate' | 'share' } | null {
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

/**
 * GitHub 凭据「缺失或失效」判定（issue #29）：`no_token`（credentials 里从未配置 token）与
 * `unauthorized`（401，token 过期/被撤销）对用户都是同一个「未登录」，必须走同一分支——
 * 否则 `no_token` 会落到 500，UI 把「未登录」渲染成「登录状态读取失败」的误导性横幅。
 * 其余分类（network_error / rate_limited / server_error / validation_failed / fork_timeout…）
 * 是真实故障，仍按 500 暴露，绝不伪装成「未登录」。
 */
export function isGitHubAuthMissing(error: unknown): boolean {
  return error instanceof GitHubApiError && (error.code === 'unauthorized' || error.code === 'no_token')
}

/** /status 的插件诊断位（issue #28）。仅回非敏感元信息：目录、profile 名、计数。 */
export interface PluginDiagnostics {
  homeDir: string
  profile: string
  /** profile 目录的 package.json 是否可读（不可读 → 清单必然为空） */
  profileManifestReadable: boolean
  /** 插件清单来源 = package.json 的 dependencies 里非 in-box 的包 */
  installedPluginCount: number
  installedPluginNames: string[]
  /** dsh.profile.bundles 声明（非空即「替换默认插件栈」） */
  bundles: string[]
}

type SelectionView = { mode: SyncSelectionMode; sections: SectionId[]; sessionsLimit: number; sessionsInclude: string[]; encrypt: boolean; includeSecrets: boolean }


/**
 * 读取插件诊断信息（issue #28）：把「插件到底读了哪个目录 / 哪个 profile / 看到什么」变成
 * 用户可自查的数据——此前只存在于宿主内部，导致「装了插件却识别不到」无从定位。
 * best-effort：失败不抛出（诊断位缺失不应拖垮 /status）。
 */
async function readPluginDiagnostics(host: HostContext): Promise<Partial<PluginDiagnostics>> {
  try {
    const profileDir = resolveProfileDir(host.homeDir, host.profile ?? 'web')
    const manifest = readProfileManifest(profileDir)
    const installed = await host.plugins.listInstalled()
    const bundles = manifest?.dsh?.profile?.bundles
    return {
      homeDir: host.homeDir,
      profile: host.profile ?? 'web',
      profileManifestReadable: manifest !== null,
      installedPluginCount: installed.length,
      installedPluginNames: installed.map((p) => p.name),
      bundles: Array.isArray(bundles) ? bundles : [],
    }
  } catch (err) {
    host.log.warn(`plugin diagnostics unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): { routes: WebRoute[]; scheduler: AutoSyncScheduler; makeSyncEngine: (cfg: SyncConfig) => SyncEngine; lifecycle: ConfigLifecycle } {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, marketDir, dataDir, credentials, githubClientId, githubClientSecret, backupScheduler, history } = deps
  /**
   * Phase 1 P0-1/P0-2：配置生命周期服务（自动快照 / 撤销 / 重做）。
   *
   * 与既有 `snapshotsDir`（导入前快照，plan 驱动）**分目录**：那里的快照只登记
   * 「本次导入将写入的目标」，无法回答「配置整体变没变」；本服务的快照是状态驱动，
   * 供撤销/重做与自动快照使用。两者保留策略与回放方式都不同，混用会产生错误语义。
   *
   * watchFactory 用真 fs.watch 注入（core 侧只依赖抽象 → 测试可完全驱动时序）。
   * 监听不在此处启动：由 apply() 在「启动 recovery 分类完成且 NORMAL」后启动，
   * 避免恢复进行中就开拍。
   */
  const lifecycle = new ConfigLifecycle({
    dir: join(dataDir, 'config-snapshots'),
    adapters,
    ctx: host,
    profile: host.profile ?? 'web',
    applyOrder: APPLY_ORDER,
    onWarn: (message, detail) => {
      host.log.warn(`[lifecycle] ${message}${detail !== undefined ? `: ${detail instanceof Error ? detail.message : String(detail)}` : ''}`)
    },
    watchFactory: (dir, onEvent) => fsWatch(dir, (eventType, filename) => onEvent(eventType, filename)),
  })

  const roots = [exportsDir, tmpDir]
  /**
   * m-retention：快照保留策略提供者（缺省 = 从 sync/backup-schedule.json 实时读取）。
   * 用户改完策略即时生效（每次 prune 都重读）；读取失败 → 缺省策略（引擎侧兜底）。
   */
  const retentionPolicyProvider = deps.retentionPolicy
    ?? (async () => (await readBackupSchedule(syncDir)).retention ?? DEFAULT_RETENTION_POLICY)
  /**
   * m-retention：GFS 分层选择器（sync 层实现）+ 旧路径快速路径绑定。
   * 为什么由宿主注入：架构边界禁止 core → sync 反向依赖；core 只声明 PruneSelector 契约。
   * 绑定 selectPruneCandidates 作为缺省策略快速路径 → 与改造前**逐字等价**。
   */
  const retentionPruneSelector: PruneSelector = (metas, policy) =>
    selectPruneCandidatesByPolicy(metas, policy, selectPruneCandidates)

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

  /**
   * 运行中心：**run 级**终止通道（/runs/cancel → 安全点暂停 → /runs/cancel/decision）。
   * 与 runAbortControllers（**项级**「跳过当前插件」）是两套信号，语义不同，绝不合并：
   *  - 项级 signal：abort 当前项的子进程（kill 进程树 + 清半装），导入继续；
   *  - run 级 signal：只在计划项边界生效，然后由用户选择「回滚」或「保留已应用项」。
   * decided 保证「用户选择」与「等待超时」只有一方生效（超时按安全侧默认回滚）。
   */
  const runCancels = new Map<string, { signal: AbortController; settle: (d: 'rollback' | 'keep') => void; decided: boolean }>()
  /** 等用户选择的超时（缺省 5 分钟）：超时按安全侧默认回滚，绝不让 run 永久卡在安全点。 */
  const CANCEL_DECISION_TIMEOUT_MS = 5 * 60 * 1000

  /**
   * bundle 可解析探测（启动自洽审计用）。**保守优先**：只有「所有探测根都找不到它」才判不可解析。
   * 探测根 = profile 目录 / homeDir / 插件 dataDir / 进程 cwd 下的 node_modules —— DSH 也会从
   * 自己的安装位置解析 bundle，本机探不到核心包属预期，故 core 侧对 @deepseek-ai/* 静默保留。
   * 宁可少剪也不要误剪：误剪一个用户 bundle = 那个插件静默不再加载。
   */
  const bundleResolvable = async (name: string): Promise<boolean> => {
    const probe = (root: string): boolean => {
      try { return existsSync(join(root, 'node_modules', ...name.split('/'), 'package.json')) } catch { return false }
    }
    for (const root of [join(host.homeDir, 'profiles', host.profile ?? 'web'), host.homeDir, dataDir, process.cwd()]) {
      if (probe(root)) return true
    }
    return false
  }

  /**
   * 「保留已应用项」分支的启动自洽审计（core 只出判据，读/写/解析能力全部由宿主注入）。
   * 这是「用户选择保留之后，DSH 还能起来吗」的唯一保证来源；缺了它 core 会如实标注「未审计」。
   */
  const bootSafetyAudit = async (): Promise<BootSafetyReport> => auditBootSafety({
    profile: host.profile ?? 'web',
    readText: async (relPath) => {
      // readFile 的静态类型是 Uint8Array（不是 Buffer）：必须显式走 Buffer 才能给 toString 传编码
      try { return Buffer.from(await host.fs.readFile(relPath)).toString('utf8') } catch { return null }
    },
    writeText: async (relPath, text) => { await host.fs.writeFile(relPath, Buffer.from(text, 'utf8')) },
    resolveBundle: bundleResolvable,
    parseYaml: (text) => yaml.load(text),
    msg,
  })

  /** 已知 adapter id 集合（push 请求体 sections 校验用）。 */
  const knownSyncSectionIds = new Set(adapters.map((a) => a.id))
  /** 可同步分区目录（status 回填 UI「同步分区」勾选列表）。
   *  只含 portable + 显式可选项（OPT_IN_SYNC_SECTIONS，目前只有 sessions）——
   *  后者是 deviceSpecific，UI 必须显示设备相关徽章，且只有用户主动勾选才进同步通道。 */
  const syncSectionCatalog = adapters
    .filter((a) => a.portability === 'portable' || OPT_IN_SYNC_SECTIONS.includes(a.id))
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
      // m-retention：可配置 GFS 保留策略（缺省「最近 10 个」，用户在 UI 可改分层）
      retentionPolicy: () => retentionPolicyProvider(),
      // m-retention：分层选择器由宿主注入（core 不反向依赖 sync）
      pruneSelector: retentionPruneSelector,
    }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
    msg,
  })

  /**
   * m-profiles：档案管理器（DSH 自带 profile：$DSH_HOME/profiles/<name>）。
   * currentProfile 惰性读取（config.profile / --profile / 缺省 web），列表里据此标注「当前运行」。
   * 「切换」= 写 <dataDir>/next-profile 标记（DSH 无法在运行中切换 profile）。
   */
  const profiles = new DshProfileManager({
    homeDir: host.homeDir,
    dataDir,
    currentProfile: () => host.profile ?? 'web',
  })


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
          host.log.warn(`mutation lock blocked: op=${error.op} reason=${error.reason}${error.detail !== undefined ? ` detail=${error.detail}` : ''}`)
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

  /** 读取已保存的同步密码（DSH credentials；值只在宿主内使用，永不回传浏览器 / 日志）。 */
  const resolveSyncPassword = async (ref: string): Promise<string | undefined> => {
    try {
      const resolved = await credentials.resolve(credentialRef(ref))
      const value = resolved?.value
      return typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      return undefined
    }
  }

  /** 某个同步密码槽位是否已配置（只回布尔，永不回值）。 */
  const syncPasswordConfigured = async (ref: string): Promise<boolean> => {
    try {
      const info = await credentials.describe(credentialRef(ref))
      return info.configured
    } catch {
      return false
    }
  }

  /** 全部通道的「同步密码是否已保存」视图（只回布尔；密码值永不进任何响应）。 */
  const syncCredentialsByChannelView = async (): Promise<Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }>> => {
    const describe = async (channel: SyncTransportType): Promise<{ encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }> => ({
      encryptPasswordConfigured: await syncPasswordConfigured(syncPasswordRef('ENCRYPT', channel)),
      decryptPasswordConfigured: await syncPasswordConfigured(syncPasswordRef('DECRYPT', channel)),
    })
    // t32/B7：通道集合来自唯一枚举（保持 Promise.all 并发语义）
    const pairs = await Promise.all(SYNC_CHANNELS.map(async (channel) => [channel, await describe(channel)] as const))
    return Object.fromEntries(pairs) as Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean }>
  }

  /** 分区选择视图形状（无 schemaVersion；密码值永不进视图）。 */

  /** 全部通道的分区选择视图（status 路由一次返回；UI 按当前 tab 取对应通道）。 */
  /** 指定通道的分区选择视图。 */
  const selectionView = async (channel: SyncTransportType): Promise<SelectionView> => {
    const sel = await ensureSelectionLoaded(channel)
    return { mode: sel.mode, sections: sel.sections, sessionsLimit: sel.sessionsLimit, sessionsInclude: sel.sessionsInclude, encrypt: sel.encrypt, includeSecrets: sel.includeSecrets }
  }

  const selectionViewByChannel = async (): Promise<Record<SyncTransportType, SelectionView>> => {
    const all = await readAllSyncSelections(syncDir)
    selectionCache.git = all.git
    selectionCache.webdav = all.webdav
    const view = (sel: SyncSelection): SelectionView =>
      ({ mode: sel.mode, sections: sel.sections, sessionsLimit: sel.sessionsLimit, sessionsInclude: sel.sessionsInclude, encrypt: sel.encrypt, includeSecrets: sel.includeSecrets })
    return { git: view(all.git), webdav: view(all.webdav) }
  }

  /** 该通道的持久化选择是否显式勾选了「可选分区」（sessions）—— 决定用户驱动的拉取侧能否看见它。 */
  const selectionHasOptInSections = (channel: SyncTransportType): boolean => {
    const sel = selectionCache[channel]
    if (sel === undefined) return false
    const sections = effectiveSections(sel)
    return sections !== undefined && sections.some((id) => OPT_IN_SYNC_SECTIONS.includes(id))
  }

  /** 构造 SyncEngine：按 transport 分支构造对应传输（git → GitTransport；webdav → WebDavTransport）。
   *  同步范围（sections）来自持久化分区选择：advanced 模式 → 只处理勾选分区，
   *  自动同步（merge/apply/push 全链路）与手动 push 共用此配置。
   *  opts.includeOptInSections：仅**用户驱动**的拉取/一键同步路由传 true（用户的选择里
   *  确实勾了 sessions 时）—— 自动同步调用点一律不传，会话分区绝不悄悄下行。 */
  const makeSyncEngine = (cfg: SyncConfig, engineOpts: { includeOptInSections?: boolean } = {}): SyncEngine => {
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
    const channel: SyncTransportType = channelOf(cfg)
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
      ...(engineOpts.includeOptInSections === true ? { includeOptInSections: true } : {}),
      // m-retention：远端快照裁剪与本地备份产物共用同一份 GFS 保留策略（缺省 = 最近 10 个，
      // 与改造前逐字等价）；用户改完策略即时生效（每次 prune 都重读）。
      retentionPolicy: () => retentionPolicyProvider(),
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
    // issue #31：环境锁只读探测 + 显式回收，供「事故恢复」面板显示/处理**残留锁**。
    // 残留锁不是 journal（journalId 恒 null、transactions/active 为空），旧面板因此恒空。
    inspectLockState: async () => {
      const port = host.mutationLock as EnvironmentLockManager | undefined
      if (port === undefined) return { state: 'FREE' }
      const insp = await port.inspectLockState()
      return { state: insp.state, ...(insp.detail !== undefined ? { detail: insp.detail } : {}) }
    },
    recoverStaleLock: async () => {
      const port = host.mutationLock as EnvironmentLockManager | undefined
      // 无锁端口（测试/未接线）→ 无可回收对象，诚实拒绝而非谎称成功
      if (port === undefined) return { ok: false, removed: false, state: 'FREE', detail: 'no lock port configured' }
      return port.recoverStaleLock()
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

  /**
   * 路由组的显式依赖（W1）：src/routes/** 只从这里取依赖，不再靠闭包捕获。
   * 类型由本构造推断（RouteEnvInferred）→ 组文件与构造点共用一份真值。
   */
  function makeRouteEnv() {
    return {
      adapters,
      backupScheduler,
      buildMarketSummary,
      credentials,
      dataDir,
      exportsDir,
      githubAuth,
      githubClientId,
      githubClientSecret,
      githubFlows,
      history,
      host,
      itemCached,
      knownSyncSectionIds,
      makeImporter,
      makeMarketReader,
      makeRecoveryExecutors,
      makeSyncEngine,
      marketBootAutoRefreshed: { value: marketBootAutoRefreshed },
      marketCacheIndex,
      marketCacheItemDir,
      marketStarCache,
      marketWorkDir,
      meGitHubRest,
      meService,
      meTokenProvider,
      msg,
      prepareSync,
      profiles,
      pruneStagedMarketZips,
      readCachedIndexObj,
      recoveryOrchestrator,
      resolveSyncPassword,
      bootSafetyAudit,
      cancelDecisionTimeoutMs: CANCEL_DECISION_TIMEOUT_MS,
      roots,
      runAbortControllers,
      runCancels,
      runs,
      scheduler,
      selectionCache,
      selectionHasOptInSections,
      selectionView,
      selectionViewByChannel,
      snapshotEntrySections,
      snapshotsDir,
      syncCredentialsByChannelView,
      syncDir,
      syncPasswordConfigured,
      syncSectionCatalog,
      syncSessions,
      tmpDir,
      tryAppendHistory,
      withMutationGate,
      writeItemCache,
    }
  }

  /**
   * 路由表：本文件只保留被源码级守卫按**文件窗口**钉住的 8 条（host-entry 审计 F-04 记录的
   * tests/host/**、src/core/model-tools.test.ts、src/core/phase1-wiring.test.ts 的窗口断言）。
   * 其余 57 条已按域拆到 src/routes/*.ts，由 buildRoutes 组装。
   * 注册顺序不影响匹配：命名路由必须互不相同（webServer 契约）。
   */
  const routeEnv: RouteEnvInferred = makeRouteEnv()
  const routesList: WebRoute[] = [
    // ------------------------------------------------------------- status
    endpoint({ path: API.status, methods: ['GET'] }, async (req, res) => {
        // issue #28 诊断位：把「插件实际读的是哪个目录 / 哪个 profile / 看到几个插件」暴露出来。
        // 插件清单来自 <homeDir>/profiles/<profile>/package.json 的 dependencies，三处任一
        // 与实际情况不符（Desktop 用了别的 profile / 别的 DSH_HOME，或插件只写在 dsh.profile.bundles
        // 而不在 dependencies），就会出现「明明装了插件、备份里却识别不到」——用户此前无从自查。
        const pluginDiag = await readPluginDiagnostics(host)
        writeJson(res, 200, {
          ready: true,
          pluginVersion: PLUGIN_VERSION,
          dshVersion: host.dshVersion,
          platform: host.platform,
          arch: host.arch,
          ...pluginDiag,
        })
    }),
    // ------------------------------------------------------------- export
    endpoint({ path: API.export, methods: ['POST'] }, async (req, res) => {
        const body = await requireJsonObject(req)
        const includeSecrets = body['includeSecrets'] === true
        const only = Array.isArray(body['only'])
          ? body['only'].filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x))
          : undefined
        // Phase 1 条目级选择：{ '<section>': ['<unitId>', ...] }。
        // 只接受已知分区 + 非空字符串；**过滤后为空的白名单一律忽略**（回落该分区全量）——
        // 脏 body 绝不能静默缩小导出范围（宁可多导，不可静默少导）。
        const includeItems: Partial<Record<SectionId, string[]>> = {}
        const rawItems = body['includeItems']
        if (rawItems !== null && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
          for (const [key, value] of Object.entries(rawItems as Record<string, unknown>)) {
            if (!(SECTION_IDS as readonly string[]).includes(key)) continue
            if (!Array.isArray(value)) continue
            const ids = value.filter((x): x is string => typeof x === 'string' && x !== '')
            if (ids.length > 0) includeItems[key as SectionId] = ids
          }
        }
        // issue #39 Feature 1：会话按数量筛选（0=不带 / 负数=全带 / 正数=最新 N 个）。
        // 只接受对象形状；limit 非数字（含缺省）→ 显式选中 sessions 但不限数量。
        // 形状非法（数组 / 标量）一律忽略 = 现有行为（不显式选中会话）。
        const sessionsBody = body['sessions']
        const sessions = sessionsBody !== null && typeof sessionsBody === 'object' && !Array.isArray(sessionsBody)
          ? (typeof (sessionsBody as Record<string, unknown>)['limit'] === 'number'
              ? { limit: (sessionsBody as Record<string, number>)['limit'] as number }
              : {})
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
            exporter.export({
              includeSecrets,
              only,
              // 条目级选择：键存在才下发（空对象 = 未启用，与改造前完全一致）
              ...(Object.keys(includeItems).length > 0 ? { includeItems } : {}),
              // issue #39 Feature 1：会话按数量筛选（键存在才下发 = 现有行为不变）
              ...(sessions !== undefined ? { sessions } : {}),
              outPath: plainZipPath,
            }),
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
    }),
    // ---------------------------------------------------- export-preview
    // P2-⑫：导出前只读预览（不落盘 ZIP）：对选中分区逐个 adapter.export 收集 counts
    // （与真实导出一致的 secret 剥离，不导出任何值），估算 JSON 载荷大小，返回可展示摘要。
    // 零写入；loopback fence 必备。
    endpoint({ path: API.exportPreview, methods: ['POST'] }, async (req, res) => {
        const body = await requireJsonObject(req)
        const only = Array.isArray(body?.['only'])
          ? body['only'].filter((x): x is SectionId => typeof x === 'string' && (SECTION_IDS as readonly string[]).includes(x))
          : undefined
        try {
          const selected = adapters
            .filter((a) => (only === undefined ? a.defaultIncluded : only.includes(a.id)))
            .map((a) => a.id)
          const preview: { section: SectionId; count: number; sizeBytes: number; items: ExportUnit[] }[] = []
          let totalSize = 0
          let sectionsFailed = 0
          // 失败分区的**精确 id 列表**（t7）：sectionsFailed 只是计数，客户端无法据此标注是哪几个
          // 分区读取失败（只能靠「请求了但没回来」推断）。两个字段同时保留：计数是既有契约（旧客户端
          // 仍按它渲染「N 个分区导出失败已跳过」），id 列表是新增的精确信息。
          const failedSections: SectionId[] = []
          /** sessions 的单元级活跃时间（会话日志 mtime）—— 选择器「历史对话按最新到最旧」的排序兜底 */
          let sessionActivityTimes: Map<string, number> | undefined
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
              // Phase 1：可单独勾选的单元。listUnits 是**零 I/O** 纯函数（输入即本次 export 的产物），
              // 因此枚举明细不额外读盘；未实现 listUnits 的分区 items = [] = 不可细分（整体开关）。
              let items: ExportUnit[] = []
              try {
                items = adapter.listUnits?.(section) ?? []
              } catch {
                // 单元枚举失败不拖垮预览：退化为「不可细分」，用户仍可整分区导出
                items = []
              }
              // sessions：单元级活跃时间（会话日志 mtime）—— 元数据缓存没覆盖的会话靠它排序
              if (adapter.id === 'sessions' && items.length > 0 && adapter.unitActivityTimes !== undefined) {
                try {
                  sessionActivityTimes = await adapter.unitActivityTimes(host, section)
                } catch {
                  sessionActivityTimes = undefined
                }
              }
              preview.push({ section: adapter.id, count, sizeBytes: size, items })
              totalSize += size
            } catch {
              sectionsFailed += 1
              failedSections.push(adapter.id)
              // 单项失败不拖垮预览（与真实导出同语义：分区级失败跳过）
            }
          }
          // sessions 分区：补「界面标题 + 按工作区分组」，并按「工作区 → 最近活跃在前」排序
          // （时间第一口径 = DSH storages 缓存里的 lastPromptAt，缓存没覆盖的会话用上面现算的日志 mtime；
          // 两者都拿不到就排在组尾）。整段只读尽力而为，读不到就保持目录名 —— 绝不因为元数据缺失让预览失败。
          const sessionsEntry = preview.find((p) => p.section === 'sessions')
          if (sessionsEntry !== undefined && sessionsEntry.items.length > 0) {
            try {
              sessionsEntry.items = applySessionMeta(sessionsEntry.items, await readSessionMeta(host), 'sessions', sessionActivityTimes)
            } catch {
              /* 保持目录名（旧行为） */
            }
            // 子代理会话标出「父对话」：选择器据此做「勾父带子 / 勾子带父」联动。宿主不下发这份关系，
            // 界面就无从联动（用户实测：勾 2 条、包里 41 条）。尽力而为：读不到就不标（预览照常）。
            const facade = host.sessions
            if (facade?.parentRelations !== undefined) {
              try {
                sessionsEntry.items = applySessionParentLinks(sessionsEntry.items, subagentParentMap(await facade.parentRelations()))
              } catch {
                /* 关系读不到 → 不标父对话（不猜），联动静默失效但预览不受影响 */
              }
            }
          }
          writeJson(res, 200, {
            ok: true,
            sections: preview,
            totalSections: preview.length,
            totalSizeBytes: totalSize,
            sectionsFailed,
            // 新增可选字段（向后兼容：旧客户端忽略未知字段；旧宿主不回该字段时客户端回退到推断）
            failedSections,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    // ------------------------------------------------------------- analyze
    endpoint({ path: API.analyze, methods: ['POST'] }, async (req, res) => {
        const body = await readJsonBody(req)
        const zipPath = typeof body?.['zipPath'] === 'string' ? body['zipPath'] : ''
        if (zipPath === '' || !isControlledPath(zipPath, roots)) {
          writeJson(res, 400, { error: 'zipPath is required and must reference a staged backup' })
          return
        }
        // issue #39 Feature 2：可选解密密码 —— 提供即解开 secrets.enc，把
        // `credentials: { inArchive, refs, satisfied }` 一并回传（只回传 ref 名，永不回传值），
        // 宿主不必自己解析 .credentials.yaml。未提供 = refs 为空数组，其余分析不变。
        const analyzePassword = typeof body?.['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
          ? body['decryptPassword']
          : undefined
        try {
          let decryptedCredentials: Map<string, string> | undefined
          try {
            decryptedCredentials = await tryDecryptCredentials(zipPath, analyzePassword)
          } catch (error) {
            // 提供了密码却解不开（错密码 / 密文被篡改）：如实报错，不静默降级为「没有凭据」
            writeJson(res, 400, { error: decryptErrorText(error, msg) })
            return
          }
          writeJson(res, 200, await makeImporter().analyzeImport(zipPath, { decryptedCredentials }))
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    // ---------------------------------------------------------------- plan
    endpoint({ path: API.plan, methods: ['POST'] }, async (req, res) => {
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
        // 加密备份的密码（仅内存，与 /analyze、/execute 同源）：计划生成必须知道「归档里有哪些
        // 凭据值」——否则这些值不会进计划，导入时被静默丢掉（真机反馈：导入密钥没生效）。
        const planPassword = typeof body?.['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
          ? body['decryptPassword']
          : undefined
        try {
          let decryptedCredentials: Map<string, string> | undefined
          try {
            decryptedCredentials = await tryDecryptCredentials(zipPath, planPassword)
          } catch (error) {
            // 提供了密码却解不开（错密码 / 密文被篡改）：如实报错，绝不静默降级为「没有凭据」
            writeJson(res, 400, { error: decryptErrorText(error, msg) })
            return
          }
          const plan = await makeImporter().createImportPlan(zipPath, decisions, { decryptedCredentials })
          // sessions 计划项：补「会话标题 + 工作区分组」（用户实测：导入页此前只显示会话目录名）。
          // 只在计划真的含该分区时才读 storages；读不到就保持目录名，绝不让计划生成失败。
          if (plan.items.some((i) => i.adapter === 'sessions')) {
            try {
              plan.items = applySessionMetaToPlanItems(plan.items, await readSessionMeta(host))
            } catch {
              /* 保持目录名（旧行为） */
            }
          }
          writeJson(res, 200, plan)
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    // ------------------------------------------------------------ Phase 1 P0
    // 配置生命周期（自动快照 / 撤销 / 重做）：prefix 路由，内部按 path 分发。
    // mutation 动作经 withMutationGate（GLOBAL 锁 + SAFE MODE 闸门）；status 只读不加锁。
    endpoint({ kind: 'prefix', path: API.lifecycle, methods: ['GET', 'POST'] }, async (req, res) => {
        if (!LIFECYCLE_ENABLED) { writeJson(res, 503, { ok: false, code: 'feature-disabled', message: 'disaster recovery is temporarily disabled' }); return }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rel = url.pathname.slice(API.lifecycle.length).replace(/^\/+/, '')
        const segments = rel.split('/').filter(Boolean)
        if (segments.length === 0) { writeJson(res, 404, { error: 'not found' }); return }
        if (segments[0] === 'status') {
          if (req.method !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
          try {
            const metas = await lifecycle.list()
            const status = await lifecycle.status()
            writeJson(res, 200, {
              ...status,
              snapshots: metas.map((m) => ({
                id: m.id, createdAt: m.createdAt, kind: m.kind, reason: m.reason,
                trigger: m.trigger ?? null, sections: m.sections, totalBytes: m.totalBytes,
                note: m.note ?? null, tags: m.tags ?? [], pinned: m.pinned === true,
              })),
            })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (segments[0] === 'snapshot') {
          await withMutationGate('lifecycle-snapshot', async (rq, rs) => {
            try {
              const body = await readJsonBody(rq)
              const meta = await lifecycle.snapshot({
                kind: 'manual',
                reason: typeof body?.['reason'] === 'string' && body['reason'] !== '' ? body['reason'] : 'manual',
                trigger: 'route',
                ...(typeof body?.['note'] === 'string' ? { note: body['note'] } : {}),
                ...(Array.isArray(body?.['tags']) ? { tags: (body['tags'] as unknown[]).map((t) => String(t)) } : {}),
              })
              writeJson(rs, 200, { ok: true, id: meta.id, kind: meta.kind, totalBytes: meta.totalBytes })
            } catch (error) {
              if (error instanceof EnvironmentLockUnavailableError) { writeJson(rs, 423, { error: error.message, code: 'mutation-locked' }); return }
              writeJson(rs, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          })(req, res)
          return
        }
        if (segments[0] === 'undo' || segments[0] === 'redo') {
          await withMutationGate(`lifecycle-${segments[0]}`, async (rq, rs) => {
            try {
              const outcome = segments[0] === 'undo' ? await lifecycle.undo() : await lifecycle.redo()
              writeJson(rs, 200, {
                ok: outcome.ok,
                targetId: outcome.targetId ?? null,
                reason: outcome.reason ?? null,
                report: outcome.report ?? null,
              })
            } catch (error) {
              if (error instanceof EnvironmentLockUnavailableError) { writeJson(rs, 423, { error: error.message, code: 'mutation-locked' }); return }
              writeJson(rs, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          })(req, res)
          return
        }
        if (segments[0] === 'remove') {
          await withMutationGate('lifecycle-remove', async (rq, rs) => {
            try {
              const body = await readJsonBody(rq)
              const id = typeof body?.['id'] === 'string' ? body['id'] : ''
              const removed = await deleteConfigSnapshot(lifecycle.dir, id)
              writeJson(rs, 200, { ok: true, removed })
            } catch (error) {
              writeJson(rs, 500, { error: error instanceof Error ? error.message : String(error) })
            }
          })(req, res)
          return
        }
        writeJson(res, 404, { error: 'not found' })
    }),
    // 崩溃归因（P0-5）：只读。上次启动是否异常 + 归因 + 建议动作 + last-good 快照。
    endpoint({ path: API.crash, methods: ['GET'] }, async (req, res) => {
        if (!LIFECYCLE_ENABLED) { writeJson(res, 503, { ok: false, code: 'feature-disabled', message: 'disaster recovery is temporarily disabled' }); return }
        try {
          const prev = await readBootState(join(dataDir, 'config-snapshots'))
          const alert = computeBootAlert(prev, null)
          const metas = await lifecycle.list()
          const lastGoodAt = alert.lastGoodAt
          const good = lastGoodAt !== null
            ? metas.find((m) => m.kind !== 'pre-restore' && m.createdAt <= lastGoodAt) ?? null
            : null
          writeJson(res, 200, {
            crashed: alert.crashed,
            crashReason: alert.crashReason,
            lastGoodAt: alert.lastGoodAt,
            advice: adviceFor(alert.crashReason, alert.crashed),
            lastGoodSnapshotId: good?.id ?? null,
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    // 启动救援模式（P0-3）：on = 备份三处原件后，把 profile patch 改写成只挂载本插件的最小内容、
    // 置空 home patch，并把 dsh.profile.bundles 收窄为 DSH 核心（@deepseek-ai/*）与本插件自身
    // —— 其余用户插件本次启动不挂载（这才是「禁用其它插件」，只中和 patch 层救不了
    // 「插件代码自己把 DSH 搞挂」）；off = 从备份完整还原。两侧都只动
    // cordis.patch.yml / package.json / state.json，可完全回退。
    endpoint({ path: API.rescue, methods: ['GET', 'POST'] }, async (req, res) => {
        if (!LIFECYCLE_ENABLED) { writeJson(res, 503, { ok: false, code: 'feature-disabled', message: 'disaster recovery is temporarily disabled' }); return }
        const homeDir = host.homeDir
        const profile = host.profile ?? 'web'
        try {
          if (req.method === 'GET') {
            const status = await rescueModeStatus({ homeDir, profile })
            writeJson(res, 200, { active: status.active, stale: status.stale, enteredAt: status.state?.enteredAt ?? null })
            return
          }
          if (req.method !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
          const body = await readJsonBody(req)
          const action = typeof body?.['action'] === 'string' ? body['action'] : 'status'
          if (action === 'off') {
            const r = await exitRescueMode({ homeDir })
            if (!r.ok) { writeJson(res, 409, { ok: false, code: r.code, message: r.message }); return }
            writeJson(res, 200, { ok: true, active: false, restored: r.restored, needsRestart: true })
            return
          }
          if (action === 'on') {
            if (body?.['confirm'] !== true) {
              writeJson(res, 400, { ok: false, code: 'confirm-required', message: 'rescue mode rewrites cordis.patch.yml; pass confirm:true' })
              return
            }
            // patch 内容由 core 依据 package.json 的 bundles 派生（本插件已由 bundle 层挂载时
            // 只写空列表 —— 再插一行同 id 会让 loader 抛 duplicate id，DSH 直接起不来）
            const r = await enterRescueMode({
              homeDir,
              profile,
              rescueMount: {
                packageName: PLUGIN_NAME,
                row: { id: 'config-manager', name: PLUGIN_NAME },
              },
              // 真正禁用其它用户插件：只中和 patch 层治不了「bundle 能解析但插件代码把启动搞挂」
              // 这一类；收窄 bundles 后 DSH 只挂载核心 + 本插件，退出时按备份逐字节还原。
              disableUserBundles: true,
            })
            if (!r.ok) { writeJson(res, 409, { ok: false, code: r.code, message: r.message }); return }
            writeJson(res, 200, { ok: true, active: true, enteredAt: r.state.enteredAt, needsRestart: true })
            return
          }
          writeJson(res, 400, { error: 'unknown action (expected on|off)' })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    ...buildRoutes(routeEnv),
  ]
  return { routes: routesList, scheduler, makeSyncEngine, lifecycle }
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
  /**
   * Phase 1 P0-5 崩溃归因：启动即写 boot-state（ok:false），待启动分类完成后翻 ok:true。
   * 崩溃瞬间不写文件 —— 靠「下一次启动发现上次 ok!==true」归因。上次若有崩溃且尚无归因，
   * 此处扫一次日志尾部并把 crashReason 持久化（日志会被滚动覆盖，错过就没了）。
   * best-effort：任何失败都不得影响插件挂载。
   */
  const bootStateDir = join(dataDir, 'config-snapshots')
  const bootBegin = async (): Promise<void> => {
    try {
      const prev = await readBootState(bootStateDir)
      const next = beginBoot(process.pid, prev)
      if (prev !== null && prev.ok !== true && next.crashReason === null) {
        try {
          const alert = computeBootAlert(prev, await readCrashLogTail(await listCandidateLogs(homeDir)))
          if (alert.crashReason !== null) next.crashReason = alert.crashReason
        } catch { /* 归因失败不影响启动 */ }
      }
      await writeBootState(bootStateDir, next)
    } catch (error) {
      host.log.warn('boot-state 写入失败（不影响挂载）', { error: error instanceof Error ? error.message : String(error) })
    }
  }
  // 灾备总开关关闭时不写 boot-state（崩溃归因整体下线，也不留观测残留）。
  if (LIFECYCLE_ENABLED) void bootBegin()
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })
  mkdirSync(marketDir, { recursive: true })
  mkdirSync(historyDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config))
  // issue #30：出站代理（插件私有，不改全局）。仅在检测到 HTTP(S)_PROXY 时生效；未配置则完全直连。
  // 打一条脱敏日志，便于用户确认「插件当前到底走没走代理」（凭据不进日志）。
  const proxySummary = activeProxySummary()
  if (proxySummary !== null) {
    host.log.info(
      `出站请求经代理 / outbound requests via proxy: http=${proxySummary.http ?? '(none)'} https=${proxySummary.https ?? '(none)'} noProxyEntries=${proxySummary.noProxyEntries}`,
    )
  }
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
      // Phase 1 P0-5：启动分类已得出结论 → 本次启动判定为成功（推进 lastGoodAt）。
      // 灾备总开关关闭时不写 boot-state。
      if (LIFECYCLE_ENABLED) {
        try {
          await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
        } catch (error) {
          host.log.warn('boot-state 标记成功失败', { error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (err) {
      // fail-closed（审计 P0-10）：inspectStartup 抛错不默认 NORMAL。只置「调度器不启动」是半套
      // fail-open —— 此刻无法证明环境干净，destructive 路由必须一并被阻断：置内存 SAFE MODE
      // （isBlocked 谓词立即生效）+ 写 durable 标记（下次启动不判 NORMAL），与 phase3-host.ts
      // runJournaled 异常分支的姿态一致。清理通道仍是用户显式 recovery（clearSafeMode）。
      startupStateResolved = true
      shouldStartSchedulers = FAIL_CLOSED_STARTUP.startSchedulers
      if (FAIL_CLOSED_STARTUP.safeModeRequired) {
        phase3Recovery.safeModeActive = true
        await phase3Recovery.store.writeSafeMode(true).catch(() => undefined)
      }
      // fail-closed 也是「本次启动成功了」：host 存活（read-only），不该被判为崩溃。
      if (LIFECYCLE_ENABLED) {
        try {
          await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
        } catch { /* best-effort */ }
      }
      host.log.warn('Phase 3 启动 reconcile 失败（fail-closed：SAFE MODE 已置、destructive 路由与调度器均被阻断）', {
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
    // T1：本地源（link:/file:）插件打包 —— 这些 spec 指向本机路径，换机后必然不可达，
    // 曾导致插件被静默丢失。导出时用 npm pack 把源码包一并放进备份，
    // 导入时用解包出的绝对路径重写 spec（见 adapters/plugins.ts 的 applyItem）。
    localPluginPack: createLocalPluginPackHook({ homeDir, dataDir }),
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
  // M1（G-09 接线）：secret 扫描器**单一实例**来源 —— 三条全量导出路径必须共用同一个实例，
  // 否则扫描档位漂移：HTTP 导出路由（makeRoutes）、Agent 模型工具 config_backup
  // （registerModelTools）、定时自动备份（BackupScheduler）。三处都在下方同步构造，故此声明
  // 必须早于三者（对象字面量中的 scanner 是即时求值，声明放在后面会 TDZ ReferenceError）。
  const secretScanner = createConfiguredSecretScanner(config?.personalPatterns)
  const runs = new RunRegistry({ msg: host.msg })
  const backupScheduler = new BackupScheduler({
    syncDir,
    exportsDir,
    host,
    adapters,
    runs,
    msg: host.msg,
    exporterVersion: PLUGIN_VERSION,
    // M1（G-09 接线）：与 HTTP 导出路由 / config_backup 同一 scanner 实例 —— 定时备份是
    // 无人值守路径，文件类分区的凭据告警与 redactedHits 统计必须与手动导出完全一致
    // （缺省不传 = Exporter 落回无 scanText 的 defaultSecretScanner，文件类分区静默不扫描）。
    scanner: secretScanner,
    mutationLock: host.mutationLock,
    isBlocked: () => host.safeModeIsBlocked?.() ?? false,
    phase3Recovery: host.phase3Recovery,
    // Phase 6：定时备份迁移历史（best-effort；COMPLETE 不变量）。
    appendHistoryFn: async (entry) => { await historyStore.append(entry) },
  })
  // Phase 6：迁移历史引擎（统一审计史；per-file append-only 存储于 <dataDir>/migration-history）
  const historyStore = new MigrationStore({ dir: historyDir })
  const { routes, scheduler, makeSyncEngine, lifecycle } = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs,
    syncDir,
    marketDir,
    dataDir,
    retentionPolicy: async () => (await readBackupSchedule(syncDir)).retention ?? DEFAULT_RETENTION_POLICY,
    // F2：部署者 personalPatterns → 强化 secret 扫描器（未配置 = 默认行为）。
    // 该扫描器实现了 scanText（文件类分区文本级扫描，G-09 只告警不改写）——
    // 换成任何没有 scanText 的扫描器都会静默关闭 G-09，改这里务必先看 exporter.ts 的 scanFileSectionText。
    scanner: secretScanner, // M1：与 config_backup 同一实例（见上方 secretScanner 构造）
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
    // M1：与 HTTP 导出路由同一个 scanner（G-09 文件类分区凭据告警在两条路径上一致）。
    scanner: secretScanner,
  })
  // P1-B：backupScheduler 不再同步 start —— 由启动 recovery 分类完成后（仅 NORMAL）启动。
  schedulerGate.start = () => {
    scheduler.start();
    backupScheduler.start();
    // Phase 1 P0-1：配置变更自动快照。放在同一闸门内，确保恢复/事务进行中不开拍。
    // 灾备总开关关闭时不启动监听（否则后台持续采集全部分区并刷「超出上限」告警）。
    if (LIFECYCLE_ENABLED) lifecycle.startAutoSnapshot();
  }
  // 若启动分类已在此构造完成前解析为 NORMAL（罕见竞态），立即补启动。
  if (startupStateResolved && shouldStartSchedulers && schedulerGate.start !== null) { schedulerGate.start(); }
  ctx.effect(() => () => backupScheduler.stop(), 'config-manager: backup scheduler')
  // 自动同步调度器随插件生命周期停止：插件重载/卸载时清理定时器，
  // 避免旧调度器残留导致重复后台同步。
  ctx.effect(() => () => scheduler.stop(), 'config-manager: autosync scheduler')
  // Phase 1 P0-1：停止配置变更监听（dispose 后不再产生自动快照）。
  ctx.effect(() => () => lifecycle.dispose(), 'config-manager: config lifecycle watcher')
  const webServer = readService<WebServer>(ctx, 'webServer')
  if (webServer === undefined) {
    host.log.warn('webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册（引擎能力仍可用）')
    return
  }
  ctx.effect(() => {
    const disposers = registerRoutes(webServer, routes)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'config-manager: routes')
}
