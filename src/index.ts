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
 *   ~/.dsh/cordis.patch.yml-> PatchFileFacade     (js-yaml; home 层 + profiles/<p>/ 层)
 *   ctx.skills             -> SkillStoreFacade    (@deepseek-ai/dsh-skill 注册表，技能备份用)
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
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type { SettingsDescriptor, SettingsProvider } from '@deepseek-ai/dsh-settings'
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
import { DshProfileError, DshProfileLauncher, DshProfileManager, DshProfileRuntimeRegistry } from './profiles/index.ts'
import { cleanupCaches } from './core/cache-cleaner.ts'
import { isValidSnapshotId, planRestore, type RestoreActionKind, type RestorePlan, type RestoreReport } from './core/restore.ts'
import { rollback as performRollback } from './core/rollback.ts'
// Phase 1 P0-1/P0-2：配置生命周期（自动快照 / 撤销 / 重做）与 P0-5 崩溃归因。
// 监听工厂用真 fs.watch 注入（core 侧只依赖抽象，便于测试驱动时序）。
import { BOOT_STATE_DIR_NAME, LEGACY_BOOT_STATE_DIR_NAME, adoptLegacyBootState, adviceFor, beginBoot, computeBootAlert, listCandidateLogs, markBootOk, readBootState, readCrashLogTail, writeBootState } from './core/crash-report.ts'
// Phase 1 P0-3：启动救援模式（备份 patch/package.json → 写最小 patch → 中和 bundles）
import { enterRescueMode, exitRescueMode, rescueAppliedInThisProcess, rescueModeStatus } from './core/boot-rescue.ts'
import { auditBootSafety } from './core/boot-safety.ts'
import type { BootSafetyReport } from './core/boot-safety.ts'
import { createRecoveryOrchestrator, type RecoveryExecutorFns } from './core/recovery-orchestrator.ts'
import { JournalStore } from './core/journal.ts'
import { RunRegistry, type RunState } from './core/run-registry.ts'
import { registerModelTools } from './core/model-tools.ts'
import { msgOf, zhMsg } from './core/messages.ts'
import { engineMsg, getEngineLocale, setEngineLanguageSource, setEngineLocale } from './core/engine-locale.ts'
import { RollbackAutoTracker, RollbackPointEngine, ROLLBACK_POINTS_DIR_NAME, rollbackSessionBindingOf, rollbackTrackedEventOf } from './core/rollback-point.ts'
import { ROLLBACK_ATTRIBUTION_FILE_NAME, RollbackWriteAttribution } from './core/rollback-attribution.ts'
import { ROLLBACK_ACTIVITY_FILE_NAME, RollbackSessionActivity } from './core/rollback-activity.ts'
import { isRollbackEnabled, onRollbackEnabledChange, setRollbackEnabled } from './core/rollback-gate.ts'
import type { RollbackForkCarrier, RollbackRewindResult } from './core/rollback-point.ts'
// t3：宿主斜杠命令 /rollback（与 HTTP 路由同一道写入门；命令服务惰取，未组合时安静跳过）。
import { agentSessionFactsOf, registerRollbackCommand } from './core/command-rollback.ts'
import type { CommandServiceLike, RollbackCommandHost } from './core/command-rollback.ts'
import type { MsgFunc } from './core/messages.ts'
import { cleanupAbortedInstall, hasDshBundlePatch, installAnchorFromProfileContext, installErrorFor, readInstalledVersion, listInstalledPlugins, profileNameFromProfileContext, resolveProcessProfileName, resolveProfileDir, readProfileManifest, runDshPlugin, validateProfileName } from './core/plugin-cli.ts'
import type { ConfigAdapter, CredentialsFacade, ExportUnit, FileSystemFacade, HostContext, ImportDecisions, ImportPlan, NamedNamespaceInfo, NamespaceInfo, PatchFileFacade, PlanItemKind, PluginInfo, PluginsFacade, SessionMoveResult, SessionParentRelation, SessionRewriteResult, SessionStoreFacade, SettingsFacade, SkillDefinitionView, SkillStoreFacade, SkillSummaryView, WorkspaceFacade } from './core/types.ts'
import { ImportUserSkippedError } from './core/types.ts'
import { PLUGIN_NPM_PACKAGE } from './core/update-check.ts'
import { planSelfUpdate, runSelfUpdate } from './core/self-update.ts'
import type { SelfUpdateOutcome } from './core/self-update.ts'
import { createAdapters } from './adapters/index.ts'
import { isPatchLayerRel, profilePatchRel, readEffectivePatchLines, USER_PATCH_FILE } from './core/patch-layers.ts'
import { createLocalPluginPackHook } from './core/local-plugin-host.ts'
import { ENCRYPTED_CONTAINER_CODE, createEncryptionProvider, decryptCredentials, readContainerKind, SecurityError, encryptArchive } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { collectCredentialRefs } from './security/credentials-yaml.ts'
import { applySessionMeta, applySessionMetaToPlanItems, applySessionParentLinks, readSessionMeta, readSessionMetaWithTitles, subagentParentMap } from './core/session-meta.ts'
import type { SessionMetaIndex } from './core/session-meta.ts'
import { projectKeyOf, sessionIdKey } from './core/session-select.ts'
import { PROJECT_KEY_RE, readLogCwdFromBytes, rewriteSessionLogDir } from './utils/session-log.ts'
import { probeSessionFormats, resolveSessionFormatVersion } from './utils/session-format.ts'
import { describePatchYamlError, dumpPatchDocument, loadPatchDocument } from './utils/patch-yaml.ts'
import { atomicCopyFile, atomicWriteFile } from './utils/atomic-write.ts'
import { isENOENT } from './utils/guards.ts'
import { EnvironmentLockManager, runWithMutationLock, EnvironmentLockUnavailableError, type MutationLockContext } from './utils/env-lock.ts'
import { activeProxySummary } from './utils/proxy.ts'
import { listRecursiveFollowingLinks } from './utils/recursive-walk.ts'
import { Phase3Recovery, TransactionRecoveryRequiredError, mapLockStateForStartup } from './core/phase3-host.ts'
import type { JournalRunContext } from './core/phase3-host.ts'
import { classifyStartup, FAIL_CLOSED_STARTUP, resolveStartupSafeMode } from './core/startup-barrier.ts'
import type { MutationLockPort } from './utils/env-lock.ts'
import type { RecursiveListing } from './utils/recursive-walk.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import type { GitWorkDirFacts } from './sync/git/git-transport.ts'
import { WebDavTransport } from './sync/webdav/webdav-transport.ts'
import { S3Transport } from './sync/s3/s3-transport.ts'
import { GistTransport } from './sync/gist/gist-transport.ts'
import { DeviceFlowStore, GitHubAuthClient } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { BackupScheduler } from './sync/backup-scheduler.ts'
import { readBackupSchedule } from './sync/backup-schedule-config.ts'
import { readRollbackEnabledSync } from './sync/ui-prefs.ts'
import { AUTO_BACKUP_PREFIX, isValidExportFileName, resolveNonCollidingExportName, writeBackupNote } from './sync/backup-files.ts'
import { DEFAULT_RETENTION_POLICY, selectPruneCandidatesByPolicy } from './sync/retention-policy.ts'
import type { RetentionPolicy } from './sync/retention-policy.ts'
import type { PruneSelector } from './core/backup.ts'
import { selectPruneCandidates } from './core/backup.ts'
import {
  readAllAutosyncConfigs, readAutosyncConfig, DEFAULT_AUTOSYNC_REALTIME, DEFAULT_AUTOSYNC_REMOTE_CHECK_MS,
  DEFAULT_AUTOSYNC_AUTO_APPLY_TIER, DEFAULT_AUTOSYNC_CONFLICT_POLICY, lastRunFailureMessage,
} from './sync/autosync-config.ts'
import type {
  AutosyncInterval, AutosyncRunStatus, AutosyncAutoApplyTier, AutosyncConflictPolicy,
} from './sync/autosync-config.ts'
import { appendAutosyncEntry } from './sync/sync-history.ts'
import { MigrationStore, type MigrationKind, type MigrationResult, MIGRATION_HISTORY_DIR } from './core/migration-history.ts'
import { readSyncConfig, validateRepoUrl, validateWebDavUrl, isWebDavConfig, isS3Config, isGistConfig, channelOf, parseSyncChannel, SYNC_CHANNELS, GIST_PROVIDER, isS3CompatProvider, validateCloudChannelInput, cloudSecretRef } from './sync/sync-config.ts'
import {
  resolveSessionFormatDisposition,
  sessionFormatAbortResponse,
  type SessionFormatAbortBody,
} from './routes/session-format.ts'
import type { SessionFormatDisposition } from './core/types.ts'
import type { SyncConfig, SyncTransportType } from './sync/sync-config.ts'
import { AUTO_SYNC_OPT_IN_SECTIONS, defaultSyncSelection, effectiveSections, normalizeSessionsInclude, OPT_IN_SYNC_SECTIONS, readAllSyncSelections, readSyncSelection } from './sync/sync-selection.ts'
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
import { createTtlAsyncCache } from './utils/ttl-cache.ts'
import { MANIFEST_FILE, parseManifest } from './schema/manifest.ts'
import { isFileSection, SECTION_IDS } from './schema/config.ts'
import { stringifyJsonSafe } from './utils/json.ts'
import type { Manifest, SectionId, WorkspaceRecord } from './schema/types.ts'
import { parseZip } from './utils/zip.ts'
import { isSameOrChild } from './utils/paths.ts'
import { isRecord } from './utils/guards.ts'
import { createLogger, parseLogLevel, type Logger } from './utils/logger.ts'
// 与 HTTP 路径**同一份**「运行中对话」判据（命令入口绝不能各写一套）
import { sessionActiveDenied, sessionActiveGateApplies } from './routes/recovery.ts'

/* ---------------------------------------------------------------- identity */

/** Stable cordis plugin name — must match the cordis.patch.yml row id. */
export const name = 'config-manager'

/** Services required before the engine can mount (present in every profile). */
export const inject = ['settings', 'credentials']

/** Plugin version, kept in sync with package.json ("version"). */
export const PLUGIN_VERSION = '0.1.80'

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
 * 本文件保留的 7 条路由的路径（被源码级守卫按文件窗口钉住，见下方 routesList 注释）。
 *
 * 其余 75 条路由的路径**声明在各自的组文件里**（src/routes/*.ts 的 endpoint({ path, methods })）——
 * 新增一条 API 只需那一条声明，不再有「常量表 + 路由对象」两处要同步。
 */
export const API = {
  status: '/api/dsh-config-manager/status',
  export: '/api/dsh-config-manager/export',
  exportPreview: '/api/dsh-config-manager/export-preview',
  analyze: '/api/dsh-config-manager/analyze',
  plan: '/api/dsh-config-manager/plan',
  crash: '/api/dsh-config-manager/crash',
  rescue: '/api/dsh-config-manager/rescue',
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

/** 读一个 package.json 的 version；不可读 / 不是非空字符串 → null。 */
function readPackageVersion(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * 定位「本机 DSH」的候选 `@deepseek-ai/dsh/package.json`（只读，**顺序就是真伪顺序**）。
 *
 *  ① `profileContext.installAnchor` —— 拉起本宿主的那份 `@deepseek-ai/dsh/package.json`。
 *     Desktop 从 `app.asar` 内加载运行时（0.2.0-rc.2），**磁盘上其它任何位置都没有它**；
 *  ② 当前档案自己的依赖树 `<home>/profiles/<profile>/node_modules/...`；
 *  ③ `<home>/profiles/node_modules/...`（pnpm hoisted 树）与 <home>/profiles/web/...。
 *
 * 为什么不能用 ③ 打头（原实现的 bug）：那棵树是 web 档案装出来的 **hoisted 副本**，
 * 真机上它是 0.1.5-rc.1，而 Desktop 实际跑的是 0.2.0-rc.2 —— 「关于」页与导出 manifest
 * 的 DSH 版本因此整个报错版本号。会话格式版本（`resolveSessionFormatVersion`）共用同一份候选。
 */
export function dshPackageJsonCandidates(home: string, profile?: string, installAnchor?: string | null): string[] {
  const candidates: string[] = []
  if (typeof installAnchor === 'string' && installAnchor !== '') candidates.push(installAnchor)
  if (profile !== undefined && profile !== '') {
    candidates.push(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  candidates.push(
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  )
  return candidates
}

/** 当前真正在跑的 DSH 版本（只读；候选顺序见 `dshPackageJsonCandidates`）。 */
export function resolveDshVersion(home: string, profile?: string, installAnchor?: string | null): string {
  for (const p of dshPackageJsonCandidates(home, profile, installAnchor)) {
    const version = readPackageVersion(p)
    if (version !== null) return version
  }
  return 'unknown'
}

/* ------------------------------------------------------------ profile name */

/**
 * 解析管理的 profile（优先级从上到下）：
 *   ① `config.profile`（显式配置，运维覆盖入口）
 *   ② 宿主 `profileContext` 服务（DSH ≥ 0.1.7 在 boot 时 provide；见
 *      `profileNameFromProfileContext`）—— Desktop 外壳不传 `--profile`，
 *      只有它知道真正启动的是哪个档案（issue #52）
 *   ③ `--profile` 启动参数 → `DSH_PROFILE` / `DSH_PROFILE_DIR` → 'web'
 * 全程不抛错：任一来源非法即继续回退（启动期绝不允许因 profile 名崩掉 apply）。
 */
function resolveProfileName(config: Config | undefined, ctx: Context): string {
  const configured = config?.profile
  if (configured !== undefined && configured !== '') return validateProfileName(configured)
  const booted = profileNameFromProfileContext(readService<unknown>(ctx, 'profileContext'))
  if (booted !== null) return booted
  return resolveProcessProfileName()
}

/* ------------------------------------------------------- HostContext facades */

/** Optional Cordis service reader (never injected → never blocks the fiber). */
function readService<T>(ctx: Context, serviceName: string): T | undefined {
  const candidate = ctx.get(serviceName)
  return candidate === null || typeof candidate !== 'object' ? undefined : candidate as T
}

/**
 * 把 DSH 的 `skills` 服务（@deepseek-ai/dsh-skill 的 SkillRegistry）适配成引擎的
 * `SkillStoreFacade`（issue #71）。
 *
 * 为什么在这里做适配而不是让 adapter 直接调服务：架构边界测试禁止 core / adapters import
 * `@deepseek-ai/*`（只有 src/index.ts 与 src/client/ 允许），所以适配层只能是宿主入口。
 *
 * 服务缺失（旧外壳）或形状不符 → 返回 undefined（skills 分区退回纯目录扫描，不报错）；
 * 单个方法的异常不在这里吞 —— 由 adapter 决定「这一个技能跳过」还是「整路跳过」。
 */
function resolveSkillStore(ctx: Context): SkillStoreFacade | undefined {
  const service = readService<{
    list?: (options?: unknown) => Promise<unknown>
    get?: (name: string, options?: unknown) => Promise<unknown>
  }>(ctx, 'skills')
  if (service === undefined || typeof service.list !== 'function' || typeof service.get !== 'function') {
    return undefined
  }
  return {
    // 不传 scope：外壳自身的技能 provider 都在 global 层（插件 apply 时注册、无 scope），
    // 传 scope 反而会丢掉它们。范围参数只在调用方明确要「某次会话/某个 preset 的视图」时才需要。
    async list(): Promise<SkillSummaryView[]> {
      const raw = await service.list?.({})
      if (!Array.isArray(raw)) return []
      const out: SkillSummaryView[] = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const summary = item as Record<string, unknown>
        if (typeof summary['name'] !== 'string') continue
        out.push(toSkillSummaryView(summary))
      }
      return out
    },
    async get(name: string): Promise<SkillDefinitionView | undefined> {
      const raw = await service.get?.(name, {})
      if (raw === null || typeof raw !== 'object') return undefined
      const definition = raw as Record<string, unknown>
      if (typeof definition['name'] !== 'string' || typeof definition['content'] !== 'string') return undefined
      return { ...toSkillSummaryView(definition), content: definition['content'] }
    },
  }
}

/** 技能摘要的结构适配（只取引擎声明过的字段；多余字段不落地，避免快照体积被未知字段撑大）。 */
function toSkillSummaryView(source: Record<string, unknown>): SkillSummaryView {
  const out: SkillSummaryView = {
    name: source['name'] as string,
    description: typeof source['description'] === 'string' ? source['description'] : '',
  }
  if (typeof source['whenToUse'] === 'string') out.whenToUse = source['whenToUse']
  if (typeof source['source'] === 'string') out.source = source['source']
  if (typeof source['provider'] === 'string') out.provider = source['provider']
  const invocation = source['invocation']
  if (invocation !== null && typeof invocation === 'object') {
    const policy = invocation as Record<string, unknown>
    const view: { modelInvocable?: boolean; userInvocable?: boolean } = {}
    if (typeof policy['modelInvocable'] === 'boolean') view.modelInvocable = policy['modelInvocable']
    if (typeof policy['userInvocable'] === 'boolean') view.userInvocable = policy['userInvocable']
    out.invocation = view
  }
  return out
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

  /** DSH 描述符 → 核心 NamespaceInfo（describe/describeAll 共用，保证两条路径逐字段同口径） */
  private toNamespaceInfo(descriptor: SettingsDescriptor): NamespaceInfo {
    return {
      value: descriptor.value,
      base: descriptor.base,
      revision: descriptor.revision,
      // Real service reports a single applies value; the core contract is an array.
      applies: descriptor.applies === undefined ? undefined : [descriptor.applies],
      secrets: descriptor.secrets ?? [],
    }
  }

  async describe(namespace: string, opts?: { redactSecrets?: boolean }): Promise<NamespaceInfo> {
    const found = (await this.describeAll(opts)).find((d) => d.ns === namespace)
    if (!found) throw new Error(`namespace not found: ${namespace}`)
    return found.info
  }

  /**
   * 一次读回全部已注册 namespace。
   *
   * 真实服务侧 describe() 是「无参 = 全量」的：每次调用都对全部注册项重跑
   * schema.toJSON + structuredClone + redactSecrets。逐名调用因此是 O(N²)
   * （真机 24 个 namespace ≈1.7 s），调用方改用本方法后只需一次全量（≈70 ms）。
   */
  async describeAll(opts?: { redactSecrets?: boolean }): Promise<NamedNamespaceInfo[]> {
    return this.provider()
      .describe({ redactSecrets: opts?.redactSecrets ?? true })
      .map((descriptor) => ({ ns: String(descriptor.ns), info: this.toNamespaceInfo(descriptor) }))
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
 *
 * 第 4 参 `profile`（issue #71）：patch 的层身份是**相对 homeDir 的路径**，
 * 目标层 = `profiles/<profile>/cordis.patch.yml`。省略时按缺省档案名（web）—— 兼容旧调用方。
 */
export async function ensureActivationRow(
  patchFile: PatchFileFacade,
  pkgDir: string,
  pkg: string,
  profile?: string,
): Promise<void> {
  if (hasDshBundlePatch(pkgDir)) return
  const file = profilePatchRel(profile)
  // 幂等判定要看**两层**：home 层里的激活行同样会让 DSH 加载这个包（home 层合并在后、优先级更高），
  // 只看目标层会在「用户已手工激活过」时多写一行重复激活。
  const effective = await readEffectivePatchLines(patchFile, profile)
  if (effective.lines.some((l) => patchRowActivates(l.raw, pkg))) return
  const id = `pm-${slugOf(pkg)}`
  await patchFile.applyPatchChanges(file, [
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

  async install(pkg: string, target?: string, signal?: AbortSignal): Promise<{ needsRestart: boolean; installedVersion?: string | null }> {
    const profileDir = resolveProfileDir(this.homeDir, this.profile)
    // target 由调用方（adapters/plugins.ts 的 pluginInstallTarget）推导完毕，这里只执行：
    // registry 包带精确版本或「包名@spec」，pnpm 才不会静默沿用目标机既有 spec（issue #101）。
    // 缺省退化为裸包名（旧调用方）→ pnpm fetch-404，由 installErrorFor 给出可操作诊断。
    const spec = target !== undefined && target !== '' ? target : pkg
    const result = await this.runner(profileDir, this.profile, ['add', spec], undefined, signal)
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
      await ensureActivationRow(this.patchFile, join(profileDir, 'node_modules', pkg), pkg, this.profile)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(this.msg('host.activationRowFailed', { pkg, reason }))
    }
    // 回读实际落盘版本：调用方据此校验升级是否真的生效（issue #101），而不是只看子进程退出码。
    return { needsRestart: true, installedVersion: readInstalledVersion(profileDir, pkg) }
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

/* --------------------------------------------- 会话存储读侧兼容（F-1） */

/**
 * 宿主 `sessionPersistence` 的 API 形状（**按 API 形状探测，绝不按 DSH 版本号猜**）。
 *
 * 为什么必须探测：DSH 的会话存储换过基线 —— 新基线有 `open()`（handle 形态，`list()` 的元素是
 * 带 `header` 的 snapshot 对象），旧基线只有服务级的 `readFrom()` / `append()`（header 字段
 * **平铺在元素上**）。本插件只读 `list()` 的结果，而两种形状里 header 的位置不同。
 *
 * 真机事故级的后果（F-1）：按写死的形状读，在另一种宿主上「一个都匹配不上」——
 * `reindexSessionHeader` 恒 false、`parentRelations` 退化成**空 Map**（而空 Map 还会进 5 s 的
 * TTL 缓存），于是「导出子代理会话时连带父对话」这条已经修好的能力在旧宿主上**静默失效**。
 * 参照竞品 dsh-claude-move 的 isSessionHandle / storedSessionIdOf（index.mjs:88-154）。
 */
export type SessionPersistenceShape = 'handle' | 'legacy' | 'unknown'

/** 会话存储**列举**接口的最小形状（两种基线都有 `list()`；本插件只读它，不写会话）。 */
export interface SessionListService {
  list(): Promise<readonly unknown[]>
}

/** 按 API 形状探测会话存储基线：有 `open` → handle；只有 `readFrom`/`append` → legacy；都没有 → unknown。 */
export function sessionPersistenceShapeOf(service: unknown): SessionPersistenceShape {
  if (!isRecord(service)) return 'unknown'
  if (typeof service['open'] === 'function') return 'handle'
  if (typeof service['readFrom'] === 'function' || typeof service['append'] === 'function') return 'legacy'
  return 'unknown'
}

/** 归一后的列举元素 header 视图（只含本插件用到的字段）。 */
export interface ListedSessionView {
  id: string
  /** 父会话 id（磁盘 header 名 `parentSession`；DSH 的 RPC 投影名 `parentSessionId` 一并认） */
  parent?: string
  /** header.origin（'subagent' = 子代理会话）——原样保留，不在这里做筛选 */
  origin: unknown
  /**
   * **原样的 header 对象**（handle 形态 = `element.header`；legacy 形态 = 元素自身）。
   * 回传给 DSH `WorkspaceRegistry.indexHeader()` 时必须用它 —— 绝不自己造一个 header。
   */
  raw: unknown
}

/**
 * 把一个列举元素归一成 header 视图（**两种基线形状都认**）。
 *
 * 认不出 id → undefined：这是「读侧兼容失败」的唯一信号，调用方必须**响亮处理**
 * （记日志 / 抛错），绝不当成「本机没有会话」。
 */
export function normalizeListedSession(element: unknown): ListedSessionView | undefined {
  if (!isRecord(element)) return undefined
  const nested = isRecord(element['header']) ? element['header'] : undefined
  // handle 形态 = header 在 element.header；legacy 形态 = header 字段平铺在元素上。
  // header 存在但取不出 id 时回落元素自身（两种都取不到才算解析失败 —— 不猜）。
  const source = nested !== undefined && typeof nested['id'] === 'string' && nested['id'] !== '' ? nested : element
  const id = source['id']
  if (typeof id !== 'string' || id === '') return undefined
  const rawParent = source['parentSession'] ?? source['parentSessionId']
  const parent = typeof rawParent === 'string' && rawParent !== '' ? rawParent : undefined
  return { id, origin: source['origin'], raw: source, ...(parent !== undefined ? { parent } : {}) }
}

/** 会话存储列举的结果（失败必须可区分，绝不与「本机没有会话」混淆）。 */
type ListedSessions =
  | { ok: true; items: readonly ListedSessionView[] }
  /** unavailable = 服务/接口不可用（list 抛错或返回非数组）；shape-unknown = 元素形状一个都认不出 */
  | { ok: false; reason: 'unavailable' | 'shape-unknown'; detail: string }

/** 列举会话存储的用途（内部枚举；渲染时必须经字典键映射 —— **绝不把裸枚举塞进文案**）。 */
type SessionStorePurpose = 'reindexSessionHeader' | 'parentRelations' | 'rewindWorkspaceAttach'

/** 用途 → 字典键（本仓纪律：文案只做「原因 → 字典键」映射，禁止渲染裸枚举）。 */
const SESSION_STORE_PURPOSE_KEY: Record<SessionStorePurpose, string> = {
  reindexSessionHeader: 'host.sessionStorePurposeReindex',
  parentRelations: 'host.sessionStorePurposeParentRelations',
  rewindWorkspaceAttach: 'host.sessionStorePurposeRewindAttach',
}

/**
 * 父子关系缓存的 TTL（毫秒）。
 *
 * 取值依据：`sessionPersistence.list()` 在真机上约 **0.7 s**，而 `/export-preview` 每次都要它；
 * 父子关系只在「有新子代理会话」时变化，几秒陈旧对选择器的「勾父带子 / 勾子带父」联动毫无影响。
 * 取 5 s：连续打开/刷新选择器都在同一窗口内命中，同时保证新会话最多 5 s 后就能被联动识别。
 *
 * F-1：缓存里只放**成功结果** —— 列举失败/形状识别失败走 `parentRelations()` 的抛错路径，
 * 由 ttl-cache 的「失败不缓存」语义保证下一次调用立刻重试；
 * 不再把失败吞成空 Map（那会被缓存整整 5 s，正是「静默失效」的放大器）。
 */
const PARENT_RELATIONS_CACHE_TTL_MS = 5_000

/**
 * `ancestorSessionIds` 的上溯深度上限。
 *
 * 取 8：DSH 的子代理树实际深度是个位数（`delegationDepth`），8 层足够覆盖「子代理的子代理」；
 * 上限 + 环保护一道，保证异常数据（自指 / 环）不会把回退路径卡死。
 */
const ANCESTOR_LOOKUP_MAX_DEPTH = 8

/**
 * 宿主会话管理面（`SessionController`）的结构窄化 —— 本仓 core 不 import `@deepseek-ai/*`。
 *
 * `fork(request)` = DSH 自己的「从某条事件前缀分叉」命令（内部 `SessionCommandController.fork`）：
 * 建 agent + 落盘 + 挂回原工作区一次到位，返回新子会话 id。**这是回退唯一可用的 fork 路径**
 * （底层 `SessionStore.fork` 造的会话没有 agent、不落盘，见 forkSession 注释）。
 */
interface SessionForkController {
  fork?: (request: { sessionId: string; atSeq: number }) => Promise<unknown>
}

/** `ctx.get('workspaceRegistry')` 的结构窄化（本仓 core 不 import @deepseek-ai/*）。 */
interface WorkspaceRegistryLike {
  list?: () => unknown
  /** DSH 的「按规范目录路径解析工作区」：目录不存在时在 realpath 阶段拒绝；目录存在但无人认领返回 undefined。 */
  resolveByPath?: (path: string) => Promise<unknown>
}

/** 归位成功的两种情形（都经 `list()` 复核过）。 */
export type WorkspaceAttachSuccessReason =
  /** 官方 fork 已经归位（能按成员/血缘解析到工作区）——本兜底只补复核，不重复写。 */
  | 'already-attached'
  /** 本兜底真的写成功且复核通过。 */
  | 'attached'

/**
 * 归位失败的具体理由（机器码）。
 *
 * 为什么必须区分而不是一个笼统的 `false`：真机现场「回退后子会话进未分组」长期不可见，
 * 根因之一就是 attach 失败被吞成布尔（无日志、无理由）。每一档都能单独定位：
 *  · registry-unavailable / registry-list-unavailable / registry-list-failed —— 服务缺失或形状不符；
 *  · attach-session-missing —— 工作区记录上**没有** `attachSession`（形状不符，未发起任何写）；
 *  · attach-rejected —— `attachSession` 真的抛错（目录不存在 / cwd 对不上 / 域未就绪）；
 *  · directory-missing —— `resolveByPath` 在 realpath 阶段拒绝，或回落档 realpath 失败（目录不存在）；
 *  · no-workspace-for-cwd —— 目录存在但不属于任何已注册工作区；
 *  · cwd-unavailable —— 读不到子会话 cwd（绝不猜路径）；
 *  · verify-failed —— 写调用没抛错，但 `list()` 复核不含该子会话（最终判据不通过，**不许报成功**）；
 *  · unexpected-error —— 其它未预期异常。
 */
export type WorkspaceAttachFailureReason =
  | 'registry-unavailable'
  | 'registry-list-unavailable'
  | 'registry-list-failed'
  | 'attach-session-missing'
  | 'attach-rejected'
  | 'directory-missing'
  | 'no-workspace-for-cwd'
  | 'cwd-unavailable'
  | 'verify-failed'
  | 'unexpected-error'

/** 归位失败（`detail` 是技术细节：errno / 路径 / 形状码，供日志与排查，不是用户文案）。 */
export interface WorkspaceAttachFailure {
  ok: false
  reason: WorkspaceAttachFailureReason
  detail?: string
}

/** 一次 `attachSession` 尝试（只表达「写调用是否成功」，最终判据在 {@link DshSessionStoreFacade} 的复核里）。 */
type AttachAttempt = { ok: true } | { ok: false; reason: 'attach-session-missing' | 'attach-rejected'; detail?: string }

/**
 * 会话 cwd 的读取结果（**多源**：活会话 → 宿主会话存储列举）。
 *
 * `source` 只用于诊断与日志（live = `ctx.get('sessions').get(id).header`；stored = `sessionPersistence.list()`），
 * 调用方**不得**据此改变归位判据 —— 两个来源读的都是 DSH 自己写下的同一个 header.cwd。
 */
type SessionCwdLookup =
  | { ok: true; cwd: string; source: 'live' | 'stored' }
  | { ok: false; detail: string }

/** 一次工作区归位的结果（成功/失败都带**具体**理由）。 */
export type WorkspaceAttachOutcome =
  | { ok: true; reason: WorkspaceAttachSuccessReason; workspaceId?: string }
  | WorkspaceAttachFailure

/** 归位失败时给调用方的 warning 串（稳定前缀 + 具体理由码）。 */
export const WORKSPACE_ATTACH_FAILED_PREFIX = 'workspace-attach-failed'

/**
 * 归位失败后的重试次数与间隔（毫秒）。
 *
 * 为什么需要（真机 2026-10-17/10-12）：fork 返回时子会话刚由 `agents.create` 建好，
 * DSH 侧的会话索引 / 持久化列举可能还没就绪 —— 与「目录根本不存在」这类终结性失败不同，
 * 这是**时序性**失败。归位本身幂等（`attachSession` 自查成员名单、`mutate` 空操作即不改写），
 * 因此重试零副作用；不重试则子会话永久停在侧栏「未分组」。
 */
const WORKSPACE_ATTACH_ATTEMPTS = 2
const WORKSPACE_ATTACH_RETRY_DELAY_MS = 200

/** 归位诊断文件的相对路径（相对插件数据根；只在**失败**时追加一行 JSON）。 */
const WORKSPACE_ATTACH_DIAGNOSTIC_REL = 'logs/rewind-workspace-attach.jsonl'

/**
 * DSH 官方 fork 在「子会话已创建、但 `workspace.attachSession` 失败」时抛的错误码。
 *
 * 依据 DSH 源码：`dsh-api-session-controller/lib/index.js` L829-836 抛
 * `new RemoteError('session/workspace-attach-failed', …, { sessionId: childId, workspaceId })`。
 */
export const WORKSPACE_ATTACH_FAILED_ERROR_CODE = 'session/workspace-attach-failed'

/**
 * 从官方 fork 的 `session/workspace-attach-failed` 错误里取回**已经创建好的子会话 id**。
 *
 * 字段名**不是猜的** —— DSH 自己的客户端就是这么取的（同款姿势）：
 * `dsh-api-session-controller/lib/client.js` L3013-3015 的 `workspaceAttachSessionId(error)`：
 *   `error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined`
 * 错误类是 `dsh-typert-protocol/lib/index.js` L11-28 的 `RemoteError`（`code` + `details`；
 * DSH 明文规定「判别只按 code，never by instanceof」，故这里也只按 `code`，不 import 那门包）。
 *
 * 形状不符（不是对象 / code 不是这个 / 没有 details.sessionId / 空串）一律 undefined ——
 * 调用方据此**保持现状**报 fork-failed，绝不假装成功、也绝不猜别的字段名。
 */
export function workspaceAttachFailureChildId(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  if (code !== WORKSPACE_ATTACH_FAILED_ERROR_CODE) return undefined
  const details = (error as { details?: unknown }).details
  if (details === null || typeof details !== 'object') return undefined
  const sessionId = (details as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

/**
 * 归位失败 → warning 串；成功 → undefined。
 *
 * 为什么是「前缀:理由码」而不是新字段：`RollbackForkSeam`（core/types.ts，本任务 scope 外）的返回
 * 形状只有 `{ childSessionId, warning? }`，warning 是**唯一**能把具体理由带到调用方的通道；
 * core 只判「非空」并落成 `rollback.guidance.sessionNotAttached`（界面如实上屏），
 * 前缀保持稳定以便既有 grep / 诊断脚本继续命中。
 */
export function workspaceAttachWarningOf(outcome: WorkspaceAttachOutcome): string | undefined {
  return outcome.ok ? undefined : WORKSPACE_ATTACH_FAILED_PREFIX + ':' + outcome.reason
}

/**
 * 目录同一性比较用的折叠（**只在 `resolveByPath` 拿不到时的回落档**使用）。
 *
 * 分隔符统一为 `/`；win32 大小写不敏感（Windows 路径大小写等价）。
 * 注意：本函数只比较**两侧都经 realpath 规范化**过的路径 —— 绝不拿「原样 cwd」与「规范 path」直接比，
 * 那正是真机 2026-10-12 的根因（工作区 path 经 `realpathNormalize`、会话头 cwd 是原样字符串）。
 */
export function foldWorkspacePath(value: string): string {
  const unified = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/** 工作区记录的稳定 id（形状不符 → undefined；只作诊断/日志，不参与判定）。 */
function workspaceRecordIdOf(record: Record<string, unknown>): string | undefined {
  const id = record['id']
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 该记录是否把某会话算作成员（`sessionIds` 非数组 = 形状不符，不算成员）。 */
function recordHasMember(record: Record<string, unknown>, sessionId: string): boolean {
  const sessionIds = record['sessionIds']
  return Array.isArray(sessionIds) && sessionIds.includes(sessionId)
}

export class DshSessionStoreFacade implements SessionStoreFacade {
  private readonly ctx: Context
  /** DSH 缺省会话根（配置改过时只影响快路径命中率，慢路径仍正确） */
  private readonly root: string
  /**
   * 插件数据根（`<DSH_HOME>/dsh-config-manager`）—— **只**用于归位失败的诊断落盘。
   * 权威状态仍在 DSH（工作区注册表 / 会话存储），这里绝不旁路写任何 DSH 数据。
   */
  private readonly dataDir: string
  /**
   * 父子关系的短 TTL 缓存（见 `PARENT_RELATIONS_CACHE_TTL_MS`；同 key 并发合并成一次列举）。
   * F-1 后**只缓存成功结果**：列举失败/形状识别失败会让 `parentRelations()` 抛错，
   * 而 ttl-cache 的语义是「失败不缓存」→ 下一次调用立刻重试（行为见 utils/ttl-cache.ts）。
   */
  private readonly parentRelationsCache = createTtlAsyncCache<Map<string, SessionParentRelation>>({
    ttlMs: PARENT_RELATIONS_CACHE_TTL_MS,
  })
  /**
   * 宿主日志（F-1）：会话存储的形状异常/列举异常必须**响亮**（绝不退化成空结果），
   * 缺省不注入时用一个只输出 warn/error 的本地记录器（测试构造三参即可，行为不变）。
   */
  private readonly log: Logger
  /** 文案翻译器（F-1 的形状异常诊断走字典，禁止硬编码用户可见字符串） */
  private readonly msgFunc: MsgFunc
  /**
   * 目录规范化（t10）：工作区归位第 ③ 档的**回落**比较用。
   *
   * 缺省 = `node:fs/promises` 的 `realpath`（与 DSH 的 `realpathNormalize` 同一套系统调用）；
   * 可注入是为了让「大小写/短名/分隔符不同」这条判定能被**确定性**单测覆盖（不依赖真实盘符/短名）。
   */
  private readonly realpath: (path: string) => Promise<string>

  constructor(ctx: Context, homeDir: string, msg: MsgFunc = zhMsg, log?: Logger, realpath?: (path: string) => Promise<string>) {
    this.ctx = ctx
    this.root = join(homeDir, 'sessions')
    this.dataDir = join(homeDir, 'dsh-config-manager')
    this.log = log ?? createLogger({ level: 'warn' })
    this.msgFunc = msg
    this.realpath = realpath ?? (async (value: string): Promise<string> => await fs.realpath(value))
  }

  /**
   * 回退到稳定边界的**子会话**（S3：工作区 + 会话回滚）。
   *
   * 走 **DSH 自己的 fork 路径**：`ctx.get('sessionController').fork({ sessionId, atSeq })`
   * （宿主 `SessionController.fork` → `SessionCommandController.fork`；惰取服务，**绝不**属性访问
   * `ctx.sessionController` —— 未声明 inject 时属性访问会抛错并致宿主启动崩溃）。
   *
   * 为什么**必须**走它、而不能直接调底层 `SessionStore.fork`（真机 2026-10-12 定案）：
   *  · 官方路径用 `ctx.agents.create(...)` 建子会话 ⇒ 子会话有 agent、**会落盘**、id 是 uuid；
   *    它**会尝试**挂回工作区，但只按「成员/血缘」两档解析（见 `attachChildToParentWorkspace` 的
   *    事实锁定）——解析不到就**不归位**；
   *  · 底层 `SessionStore.fork` 只在内存 store 里造一条会话记录（id 还是进程内计数 `session-1`），
   *    没有 agent、没有持久化 ⇒ 用户回退后想继续对话时，宿主 `resolve → resume →
   *    sessionQuery.observeSession` 在磁盘上找不到它，界面直接报
   *    `resume failed for session "session-1": SessionPersistenceNotFoundError`（用户截图 2026-10-12）。
   *
   * 契约：**任何异常与任何形状不符都收成 `{ error }`**，调用方必须如实结构化降级
   * （`fork-failed` 等），绝不静默假装成功。
   *
   * **唯一的例外（t16）：官方 fork 的 attach 失败不算 fork 失败。** 那时 `SessionCommandController.fork`
   * 已经建好子会话（uuid + 落盘），只是 `workspace.attachSession` 抛了错 —— 它把整件事报成
   * `session/workspace-attach-failed`（细节带 childId）。旧实现把它整体收成 `{ error }` ⇒ 引擎报
   * fork-failed ⇒ 用户看到「回退失败」，而磁盘上却多出一条「未分组」的子会话。现在：
   * 从错误里**按 DSH 客户端同款字段**取回 childId（见 workspaceAttachFailureChildId），
   * 取到 ⇒ 不再报失败，改由 attachChildToParentWorkspace 兜底归位；取不到 ⇒ 保持现状报失败。
   *
   * 工作区归位：官方能解析到工作区时它已经写过（本方法只复核）；解析不到（官方缺同目录档）才由
   * attachChildToParentWorkspace 兜底写。**归位失败一定带具体理由**：日志留痕 + warning 串
   * 形如 `workspace-attach-failed:<reason>`（core 落成 `rollback.guidance.sessionNotAttached` 如实上屏）。
   */
  async forkSession(sessionId: string, boundarySeq: number): Promise<{ childSessionId: string; warning?: string } | { error: string }> {
    let childId: string | undefined
    try {
      const controller = readService<SessionForkController>(this.ctx, 'sessionController')
      const fork = controller?.fork
      if (typeof fork !== 'function') return { error: 'session-controller-unavailable' }
      const child = await fork.call(controller, { sessionId, atSeq: boundarySeq })
      const id = child !== null && typeof child === 'object' ? (child as { sessionId?: unknown }).sessionId : undefined
      if (typeof id !== 'string' || id === '') return { error: 'fork-returned-no-id' }
      childId = id
    } catch (error) {
      // t16：官方 fork 在 attach 失败时抛 session/workspace-attach-failed —— 子会话**已经建好**，
      // 只是没归位。把它整体报成 fork-failed 会让用户以为回退失败，而盘上多出一条「未分组」的子会话。
      // 字段名按 DSH 自己的客户端同款姿势取（见 workspaceAttachFailureChildId 的注释），**不猜**。
      const recovered = workspaceAttachFailureChildId(error)
      if (recovered === undefined) return { error: errorMessage(error) }
      this.log.warn(
        'rewind: fork reported ' + WORKSPACE_ATTACH_FAILED_ERROR_CODE + '; keeping child session ' + recovered
        + ' (the session was created, only the workspace attach failed)',
      )
      childId = recovered
    }
    // 工作区归位：官方已归位 → 只复核；官方没归位（或 attach 抛错被上面救回）→ 本兜底写；写后一律复核。
    //
    // 失败要重试（真机 2026-10-17）：fork 返回时子会话刚建好，DSH 侧的索引/持久化列举可能还没就绪，
    // 属**时序性**失败；三档判定与 attach 本身幂等，重试零副作用。不重试的代价是子会话永久停在
    // 侧栏「未分组」（用户 2026-10-11 起的反馈）。
    let outcome = await this.attachChildToParentWorkspace(sessionId, childId)
    for (let attempt = 1; attempt < WORKSPACE_ATTACH_ATTEMPTS && !outcome.ok; attempt += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, WORKSPACE_ATTACH_RETRY_DELAY_MS) })
      outcome = await this.attachChildToParentWorkspace(sessionId, childId)
    }
    if (outcome.ok) {
      this.log.info(
        'rewind: child session filed into workspace: ' + childId + ' (' + outcome.reason + (outcome.workspaceId !== undefined ? ' ' + outcome.workspaceId : '') + ')',
      )
      return { childSessionId: childId }
    }
    // 归位失败**带具体理由**（绝不静默）：日志留痕 + warning 串交给调用方如实上屏。
    //
    // 桌面版 DSH 拿不到宿主 stdout ⇒ 只有理由码还不够排查「为什么进未分组」，故再落一行诊断。
    await this.recordAttachDiagnostic({ parentId: sessionId, childId, outcome })
    const warning = workspaceAttachWarningOf(outcome)
    return warning === undefined ? { childSessionId: childId } : { childSessionId: childId, warning }
  }

  /**
   * 把 fork 出来的子会话挂回**原会话所属工作区**（只读匹配 + 官方写 + 复核）。
   *
   * 三档判定，每一档都只相信 DSH 自己的成员语义（真正的成员判据是
   * “子会话 header 的 canonical cwd === 工作区 path”，`attachSession` 落盘前会再复核一次）：
   *  ① **直接命中**：某工作区的 `sessionIds` 含原会话 —— 与 DSH `forkWorkspace` 第一档同口径；
   *  ② **血缘**：原会话是子代理会话时，它的**祖先**才在某个工作区里 —— DSH `forkWorkspace`
   *     对 `origin === 'subagent'` 正是沿 `parentSession` 链上溯（有环保护 + 深度上限）；
   *  ③ **同目录**：子会话 header 的 cwd 与某工作区的 `path` 指向**同一个目录** —— 这正是 DSH 的成员判据本身。
   *     目录同一性**由 DSH 判定**：优先 `workspaceRegistry.resolveByPath(cwd)`（异步、按注册表同一套
   *     realpath 规范化、目录不存在直接在 realpath 阶段拒绝）；拿不到该方法才回落「双端 realpath +
   *     win32 大小写折叠」。**绝不**用未归一化的裸字符串比较 —— 真机 2026-10-12 的根因正是它：
   *     工作区 path 经 `realpathNormalize`、会话头 cwd 是原样字符串，Windows 上大小写 / 短名 / 分隔符任一
   *     不同即判不相等 ⇒ 三档全落空 ⇒ 子会话永久停在「未分组」，且失败被吞成布尔、一直不可见。
   *
   * **官方 fork 是否已自带归位（要求 D 的事实锁定，依据 DSH 源码）**：
   *  · `dsh-api-session-controller/lib/index.js` 的 `SessionCommandController.fork` 会先调
   *    `forkWorkspace(source.header)`（L802）再 `workspace.attachSession(childId)`（L829-836），
   *    attach 失败时抛 `session/workspace-attach-failed`（错误细节带 childId）；
   *  · 但 `forkWorkspace`（L1036-1045）**只有两档**：`sessionIds` 直接命中、`origin==='subagent'` 时沿
   *    祖先上溯 —— **没有同目录档**；两档都落空就返回 undefined ⇒ 官方**不归位**（本机现场：
   *    父会话不属于那 8 个工作区中的任何一个，于是每次回退都留下「未分组」的子会话）。
   *  结论：官方能解析到工作区时**它已经写了**，本兜底只补最后一道复核（`already-attached`）；
   *  官方解析不到（缺同目录档）才由本兜底的 ③ 档写 —— **不重复写、也不两处都写**。
   *
   * 任一档写失败（工作区目录已不存在 / cwd 对不上 / 形状不符）**只换下一档继续找**；三档都拿不到才返回带
   * **具体理由**的失败（调用方经 warning 通道如实上屏 + 日志留痕）—— **绝不猜、也绝不假装已归位**。
   */
  private async attachChildToParentWorkspace(parentId: string, childId: string): Promise<WorkspaceAttachOutcome> {
    try {
      const registry = readService<WorkspaceRegistryLike>(this.ctx, 'workspaceRegistry')
      if (registry === undefined) return { ok: false, reason: 'registry-unavailable' }
      const listed = this.registryRecordsOf(registry)
      if (!listed.ok) return listed.failure
      const records = listed.records

      // 要求 D：官方 fork 已归位（能按成员/血缘解析到工作区）⇒ 这里**只补最后一道复核**，绝不重复写。
      const already = this.workspaceRecordWithMember(records, childId)
      if (already !== undefined) {
        const workspaceId = workspaceRecordIdOf(already)
        return workspaceId === undefined ? { ok: true, reason: 'already-attached' } : { ok: true, reason: 'already-attached', workspaceId }
      }

      /** 找到工作区但写失败的第一条理由（比「没找到工作区」更可操作，优先回报）。 */
      let attachFailure: WorkspaceAttachFailure | undefined
      /** ③ 档「找不到同目录工作区 / 目录不存在 / 读不到 cwd」的理由。 */
      let cwdFailure: WorkspaceAttachFailure | undefined

      // ① 直接命中（DSH forkWorkspace 的第一档）
      const direct = this.workspaceRecordWithMember(records, parentId)
      if (direct !== undefined) {
        const attempt = await this.attachChildTo(direct, childId)
        if (attempt.ok) return await this.verifyChildAttached(registry, childId)
        attachFailure = attempt
      }
      // ② 血缘：子代理会话的祖先所属工作区（DSH forkWorkspace 对 subagent 的同款上溯）
      for (const ancestorId of this.ancestorSessionIds(parentId)) {
        const record = this.workspaceRecordWithMember(records, ancestorId)
        if (record === undefined) continue
        const attempt = await this.attachChildTo(record, childId)
        if (attempt.ok) return await this.verifyChildAttached(registry, childId)
        attachFailure ??= attempt
      }
      // ③ 同目录：cwd 与某工作区 path 指向同一目录（目录同一性由 DSH 判定，见方法注释）
      //
      // cwd 取**多源候选**（真机 2026-10-17）：旧实现只看子会话的活 header，拿不到就直接
      // `cwd-unavailable` ⇒ 三档全落空 ⇒ 子会话停在「未分组」。两条候选都来自 DSH 自己写下的 header，
      // 不是猜测：① 子会话（活 / 落盘 header）；② 父会话 —— DSH 的 fork 逐字继承父 cwd
      // （`SessionCommandController.fork`：`meta.cwd = source.header.cwd`，见 dsh-api-session-controller）。
      const candidates: { cwd: string; source: string }[] = []
      const missing: string[] = []
      const childLookup = await this.sessionCwdOf(childId)
      if (childLookup.ok) candidates.push({ cwd: childLookup.cwd, source: 'child:' + childLookup.source })
      else missing.push('child(' + childLookup.detail + ')')
      const parentLookup = await this.sessionCwdOf(parentId)
      if (parentLookup.ok) {
        // 与已入列候选同目录时不重复（同目录再 attach 一次只是白跑一次 list()）
        if (!candidates.some((c) => foldWorkspacePath(c.cwd) === foldWorkspacePath(parentLookup.cwd))) {
          candidates.push({ cwd: parentLookup.cwd, source: 'parent:' + parentLookup.source })
        }
      } else missing.push('parent(' + parentLookup.detail + ')')
      for (const candidate of candidates) {
        const resolution = await this.resolveWorkspaceByCwd(registry, records, candidate.cwd)
        if (resolution.records !== undefined && resolution.records.length > 0) {
          for (const record of resolution.records) {
            const attempt = await this.attachChildTo(record, childId)
            if (attempt.ok) return await this.verifyChildAttached(registry, childId)
            attachFailure ??= attempt
          }
        } else {
          // 目录不存在 / 不属于任何工作区：按候选来源标注，便于诊断区分「读到的是谁」
          const failure = resolution.failure
          if (failure !== undefined) {
            cwdFailure ??= { ok: false, reason: failure.reason, detail: candidate.source + ':' + (failure.detail ?? '') }
          }
        }
      }
      if (candidates.length === 0) cwdFailure = { ok: false, reason: 'cwd-unavailable', detail: missing.join(';') }
      return attachFailure ?? cwdFailure ?? { ok: false, reason: 'no-workspace-for-cwd' }
    } catch (error) {
      const detail = errorMessage(error)
      this.log.warn('rewind: workspace attach failed: ' + detail)
      return { ok: false, reason: 'unexpected-error', detail }
    }
  }

  /**
   * 读一次注册表列举：形状不符（没有 list / 返回非数组）与抛错**分开**报，绝不吞成一个 false。
   */
  private registryRecordsOf(
    registry: WorkspaceRegistryLike,
  ): { ok: true; records: readonly unknown[] } | { ok: false; failure: WorkspaceAttachFailure } {
    const list = registry.list
    if (typeof list !== 'function') return { ok: false, failure: { ok: false, reason: 'registry-list-unavailable', detail: 'list-not-a-function' } }
    let raw: unknown
    try {
      raw = list.call(registry)
    } catch (error) {
      return { ok: false, failure: { ok: false, reason: 'registry-list-failed', detail: errorMessage(error) } }
    }
    if (!Array.isArray(raw)) return { ok: false, failure: { ok: false, reason: 'registry-list-unavailable', detail: 'list-not-array' } }
    return { ok: true, records: raw }
  }

  /** 列举里第一个 `sessionIds` 含该会话的工作区记录（形状不符一律跳过，绝不猜）。 */
  private workspaceRecordWithMember(records: readonly unknown[], sessionId: string): Record<string, unknown> | undefined {
    for (const raw of records) {
      if (raw === null || typeof raw !== 'object') continue
      const record = raw as Record<string, unknown>
      if (recordHasMember(record, sessionId)) return record
    }
    return undefined
  }

  /**
   * 对一条工作区记录调官方 `attachSession(childId)`，并返回**具体理由**（绝不静默返回 false）。
   *
   * `attach` 必须 `.call(record, ...)` 保留 receiver（实体方法内部用 `this.host` / `this.record`）。
   * 两种失败**分开**：记录上根本没有 `attachSession`（形状不符，未发起任何写）vs 真的抛错（写被拒）。
   */
  private async attachChildTo(record: Record<string, unknown>, childId: string): Promise<AttachAttempt> {
    const attach = record['attachSession']
    if (typeof attach !== 'function') {
      const detail = 'workspace-record-has-no-attachSession'
      this.log.warn('rewind: workspace attach skipped for ' + childId + ': ' + detail)
      return { ok: false, reason: 'attach-session-missing', detail }
    }
    try {
      await (attach as (this: unknown, id: string) => Promise<void>).call(record, childId)
      return { ok: true }
    } catch (error) {
      const detail = errorMessage(error)
      this.log.warn('rewind: workspace attach rejected for ' + childId + ': ' + detail)
      return { ok: false, reason: 'attach-rejected', detail }
    }
  }

  /**
   * ③ 档：cwd 指向的**已注册工作区**记录（目录同一性由 DSH 判定，绝不裸字符串比较）。
   *
   * 优先 DSH 自己的 `resolveByPath(cwd)`：
   *  · 它按注册表同一套 realpath 规范化（Windows 大小写 / 短名 / 分隔符差异都能对上）；
   *  · **目录不存在时它在 realpath 阶段拒绝** —— 那正是「目录不存在」的判定，如实转成 `directory-missing`；
   *  · 目录存在但不属于任何工作区 → 返回 undefined（`no-workspace-for-cwd`）；
   *  · 返回的工作区实体自带 `attachSession`，直接用它（就是 DSH 判定的那一个目录，不需要再按字符串回查）。
   * 拿不到该方法（老宿主 / 形状不符）才回落 {@link resolveWorkspaceByCwdFallback}。
   */
  private async resolveWorkspaceByCwd(
    registry: WorkspaceRegistryLike,
    records: readonly unknown[],
    cwd: string,
  ): Promise<{ records: readonly Record<string, unknown>[]; failure?: undefined } | { records?: undefined; failure: WorkspaceAttachFailure }> {
    const resolveByPath = registry.resolveByPath
    if (typeof resolveByPath !== 'function') return await this.resolveWorkspaceByCwdFallback(records, cwd)
    let resolved: unknown
    try {
      resolved = await resolveByPath.call(registry, cwd)
    } catch (error) {
      const detail = errorMessage(error)
      this.log.warn('rewind: resolveByPath rejected for ' + cwd + ': ' + detail)
      return { failure: { ok: false, reason: 'directory-missing', detail } }
    }
    if (resolved === undefined || resolved === null) return { failure: { ok: false, reason: 'no-workspace-for-cwd', detail: cwd } }
    if (typeof resolved !== 'object') {
      return { failure: { ok: false, reason: 'registry-list-unavailable', detail: 'resolveByPath-returned-non-object' } }
    }
    const entity = resolved as Record<string, unknown>
    if (typeof entity['attachSession'] !== 'function') {
      return { failure: { ok: false, reason: 'attach-session-missing', detail: 'resolveByPath-result-has-no-attachSession' } }
    }
    return { records: [entity] }
  }

  /**
   * ③ 档回落（`resolveByPath` 不可用）：**双端** realpath + win32 大小写折叠比较。
   *
   * 两侧都必须 realpath 过才比：cwd 侧失败 = 目录不存在（`directory-missing`）；工作区侧失败 =
   * 该工作区目录已不在（**跳过它**，不猜「像同一个」）。
   */
  private async resolveWorkspaceByCwdFallback(
    records: readonly unknown[],
    cwd: string,
  ): Promise<{ records: readonly Record<string, unknown>[]; failure?: undefined } | { records?: undefined; failure: WorkspaceAttachFailure }> {
    let cwdCanonical: string
    try {
      cwdCanonical = await this.realpath(cwd)
    } catch (error) {
      const detail = errorMessage(error)
      this.log.warn('rewind: realpath failed for ' + cwd + ': ' + detail)
      return { failure: { ok: false, reason: 'directory-missing', detail } }
    }
    const folded = foldWorkspacePath(cwdCanonical)
    const matches: Record<string, unknown>[] = []
    for (const raw of records) {
      if (raw === null || typeof raw !== 'object') continue
      const record = raw as Record<string, unknown>
      const path = record['path']
      if (typeof path !== 'string' || path === '') continue
      let candidate: string
      try {
        candidate = await this.realpath(path)
      } catch {
        continue
      }
      if (foldWorkspacePath(candidate) === folded) matches.push(record)
    }
    // 同一目录理论上只有一条记录（DSH 的 createCanonical 保证）；仍逐条返回，让调用方对失败的那条换下一条试。
    return matches.length === 0 ? { failure: { ok: false, reason: 'no-workspace-for-cwd', detail: cwd } } : { records: matches }
  }

  /**
   * 归位后的**复核**（要求 C）：`list()` 里该工作区的 `sessionIds` 是否真的包含子会话。
   *
   * 为什么必须复核：`sessionIds` 由 DSH 按 `sessionPath(id) === record.path` 过滤（dsh-workspace
   * 实体 getter），是「这个会话到底归没归位」的**最终判据**；attach 返回成功只代表那次写调用没抛错。
   * 复核不通过一律按失败处理并给出理由 —— **不许报成功**。
   */
  private async verifyChildAttached(registry: WorkspaceRegistryLike, childId: string): Promise<WorkspaceAttachOutcome> {
    const listed = this.registryRecordsOf(registry)
    if (!listed.ok) {
      const detail = listed.failure.reason + (listed.failure.detail !== undefined ? ':' + listed.failure.detail : '')
      this.log.warn('rewind: workspace attach verify could not list workspaces for ' + childId + ': ' + detail)
      return { ok: false, reason: 'verify-failed', detail }
    }
    const record = this.workspaceRecordWithMember(listed.records, childId)
    if (record === undefined) {
      const detail = 'child-not-in-any-workspace-sessionIds'
      this.log.warn('rewind: workspace attach verify failed for ' + childId + ': ' + detail)
      return { ok: false, reason: 'verify-failed', detail }
    }
    const workspaceId = workspaceRecordIdOf(record)
    return workspaceId === undefined ? { ok: true, reason: 'attached' } : { ok: true, reason: 'attached', workspaceId }
  }

  /**
   * 从**活的**会话存储沿 `parentSession` 上溯祖先 id（不含起点；有环保护与深度上限）。
   *
   * 读不到会话 / 读不到 header / 形状不符一律停在这一层返回已收集的祖先 —— 这是只读探测，
   * 宁少不猜（DSH 官方用 `sessionQuery.traceSession`；这里只依赖 `sessions.get(id).header`）。
   */
  private ancestorSessionIds(sessionId: string): string[] {
    const out: string[] = []
    const seen = new Set<string>([sessionId])
    let current = sessionId
    for (let depth = 0; depth < ANCESTOR_LOOKUP_MAX_DEPTH; depth += 1) {
      const header = this.liveSessionHeader(current)
      const parent = header?.['parentSession']
      if (typeof parent !== 'string' || parent === '' || seen.has(parent)) break
      seen.add(parent)
      out.push(parent)
      current = parent
    }
    return out
  }

  /**
   * 会话 cwd 的**多源**读取（活会话 → 宿主会话存储列举）。
   *
   * 为什么不能只读活会话（真机 2026-10-17 根因之一）：旧实现只看 `ctx.get('sessions').get(id)`，
   * 拿不到就整体放弃归位 ⇒ fork 出来的子会话停在侧栏「未分组」。而 DSH 自己的读法有**磁盘回落**
   * （`dsh-workspace` 的 `readSessionHeader`：活会话 → `sessionPersistence.list()` 的 header 缓存），
   * 本方法与该回落同源，绝不猜路径、绝不拿父会话目录以外的任何东西凑数。
   *
   * 失败时返回**具体细节**（哪个来源、为什么），由调用方拼进诊断；绝不静默成 undefined。
   */
  private async sessionCwdOf(sessionId: string): Promise<SessionCwdLookup> {
    const live = this.liveSessionHeader(sessionId)?.['cwd']
    if (typeof live === 'string' && live !== '') return { ok: true, cwd: live, source: 'live' }
    const store = readService<SessionListService>(this.ctx, 'sessionPersistence')
    if (store === undefined) return { ok: false, detail: 'no-live-cwd;session-persistence-unavailable' }
    const listed = await this.listSessionElements(store, 'rewindWorkspaceAttach')
    if (!listed.ok) return { ok: false, detail: 'no-live-cwd;' + listed.reason }
    const view = listed.items.find((item) => item.id === sessionId)
    if (view === undefined) return { ok: false, detail: 'no-live-cwd;not-in-stored-sessions' }
    const raw = isRecord(view.raw) ? view.raw['cwd'] : undefined
    if (typeof raw === 'string' && raw !== '') return { ok: true, cwd: raw, source: 'stored' }
    return { ok: false, detail: 'no-live-cwd;stored-header-has-no-cwd' }
  }

  /**
   * 归位失败的**诊断落盘**（一行 JSON，追加写）。
   *
   * 为什么需要：桌面版 DSH 的宿主 stdout 不落盘 ⇒ 用户界面上只有「未挂回原工作区」这句，
   * 具体理由（registry 拿不到 / attach 被拒 / cwd 读不到 / 复核不过）谁都看不到，
   * 「为什么会进未分组」于是长期不可排查。这里只记 id、理由码与路径来源，**不含任何凭据**。
   * 落盘失败绝不升级成回退失败（诊断是旁路，不是回退的一部分）。
   */
  private async recordAttachDiagnostic(entry: { parentId: string; childId: string; outcome: WorkspaceAttachFailure }): Promise<void> {
    try {
      const target = join(this.dataDir, WORKSPACE_ATTACH_DIAGNOSTIC_REL)
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.appendFile(target, JSON.stringify({
        at: new Date().toISOString(),
        parentId: entry.parentId,
        childId: entry.childId,
        reason: entry.outcome.reason,
        ...(entry.outcome.detail !== undefined ? { detail: entry.outcome.detail } : {}),
      }) + '\n')
    } catch {
      // 诊断写不进去（只读盘 / 权限 / 配额）：静默 —— 回退本身的结论不受影响。
    }
  }

  /**
   * 活会话 header（`ctx.get('sessions').get(id).header`）。
   *
   * 形状不符（服务未挂载 / 会话不活）返回 undefined —— 与 DSH 的 `readSessionHeader` 第一优先
   * 同源（它也是先看活会话，再看落盘列举）；这里不做落盘回落，避免把「文件系统上的旧 header」
   * 当成「这次 fork 的孩子」。
   */
  private liveSessionHeader(sessionId: string): Record<string, unknown> | undefined {
    const service = readService<{ get?: (id: string) => unknown }>(this.ctx, 'sessions')
    const get = service?.get
    if (typeof get !== 'function') return undefined
    let session: unknown
    try {
      session = get.call(service, sessionId)
    } catch {
      return undefined
    }
    if (session === null || typeof session !== 'object') return undefined
    const header = (session as { header?: unknown }).header
    return header !== null && typeof header === 'object' ? header as Record<string, unknown> : undefined
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
    const store = readService<SessionListService>(this.ctx, 'sessionPersistence')
    if (registry === undefined || typeof registry.indexHeader !== 'function' || store === undefined) return false
    // F-1：按**形状**归一列举元素（handle / legacy 两种基线都认），不写死 element.header.id
    const listed = await this.listSessionElements(store, 'reindexSessionHeader')
    if (!listed.ok) {
      // T8（F-1 收尾）：失败原因必须**可观测** —— 只返回 false 时它与「注册表不可用」无法区分，
      // 排查只能看到「需重启 DSH 后再执行一次归位」，看不到「为什么」。
      this.log.warn(listed.detail)
      return false
    }
    const fresh = listed.items.find((item) => item.id === sessionId)
    if (fresh === undefined) return false
    try {
      // 必须回传**原样的 header 对象**（handle = element.header；legacy = 元素自身）
      await registry.indexHeader(fresh.raw)
      return true
    } catch (err) {
      this.log.warn(`会话 header 重新索引失败（${sessionId}）：${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * 列举宿主会话存储并**把两种元素形状归一**（F-1 唯一入口）。
   *
   * 返回 `ok:false` 的两种情形必须被调用方**响亮处理**（记日志 + 抛错/明确失败返回）：
   *  - `unavailable`：服务或 `list()` 不可用（抛错 / 返回非数组）；
   *  - `shape-unknown`：有元素、但**一个都解析不出 id**（宿主形状既不是 handle 也不是 legacy）。
   * 这两种**绝不**降级成「本机没有会话 / 没有父子关系」的空结果 —— 那正是 F-1 的真机事故。
   * 元素**部分**认不出时保留已认出的并记一条警告（部分可用比全丢好，但必须可见）。
   */
  private async listSessionElements(
    store: SessionListService,
    purpose: SessionStorePurpose,
  ): Promise<ListedSessions> {
    // T8-F1：purpose 是内部枚举 → 先经字典键映射成人类可读用途，**绝不渲染裸枚举**；
    // 三条 detail/warn 一律走 this.msgFunc（本文件里唯一的用户可见文案出口），不硬编码中文。
    const purposeLabel = this.msgFunc(SESSION_STORE_PURPOSE_KEY[purpose])
    let elements: readonly unknown[]
    try {
      elements = await store.list()
    } catch (err) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: this.msgFunc('host.sessionStoreListFailed', { purpose: purposeLabel, reason: errorMessage(err) }),
      }
    }
    if (!Array.isArray(elements)) {
      return {
        ok: false,
        reason: 'unavailable',
        detail: this.msgFunc('host.sessionStoreListNotArray', { purpose: purposeLabel }),
      }
    }
    const items: ListedSessionView[] = []
    let unresolved = 0
    for (const element of elements) {
      const view = normalizeListedSession(element)
      if (view === undefined) unresolved += 1
      else items.push(view)
    }
    if (items.length === 0 && elements.length > 0) {
      const detail = this.msgFunc('host.sessionStoreShapeUnknown', {
        shape: sessionPersistenceShapeOf(store),
        count: String(elements.length),
      })
      this.log.error(detail)
      return { ok: false, reason: 'shape-unknown', detail }
    }
    if (unresolved > 0) {
      this.log.warn(
        this.msgFunc('host.sessionStorePartialUnresolved', {
          count: String(unresolved),
          total: String(elements.length),
          purpose: purposeLabel,
        }),
      )
    }
    return { ok: true, items }
  }

  /**
   * 本机会话的父子关系（子会话 id → 父会话 id）。
   *
   * 实现走 DSH 会话存储的列举（与 `session/list` 同一数据源）：只取 header 的 `parentSession`，
   * 不解析任何日志字节 —— 让「导出父对话时连带子代理会话」不为此读一遍整棵会话树。
   * 字段名以磁盘 header 为准（`parentSession`，两种写法都认；DSH 的 RPC 投影才改名为 `parentSessionId`）。
   * 元素形状按 **API 形状探测**归一（handle 的 `element.header` 与 legacy 的平铺字段都认，F-1）。
   *
   * 失败语义（F-1，**不得放宽**）：
   *  - 服务**未接线** → 空 Map（确定性事实：宿主没有会话存储，不是读失败）；
   *  - 列举失败 / 元素形状一个都认不出 → **抛错**（带明确原因）。绝不返回空 Map ——
   *    空 Map 会进 5 s TTL 缓存，且让「本机一条父子关系都没有」与「读不出来」无法区分，
   *    「导出子代理会话连带父对话」就会再次静默失效。调用方各自有回退路径（见 `loadParentRelations`）。
   */
  async parentRelations(): Promise<Map<string, SessionParentRelation>> {
    return this.parentRelationsCache.resolve('local', () => this.loadParentRelations())
  }

  /** 真正列举一次 DSH 会话存储（语义见 `parentRelations()`；本方法不做缓存） */
  private async loadParentRelations(): Promise<Map<string, SessionParentRelation>> {
    const store = readService<SessionListService>(this.ctx, 'sessionPersistence')
    // 服务**未接线**（宿主不提供 sessionPersistence）→ 不猜，空 Map（与改造前一致，属确定性事实）
    if (store === undefined) return new Map<string, SessionParentRelation>()
    // F-1：形状归一（handle 的 element.header / legacy 的元素自身都认）
    const listed = await this.listSessionElements(store, 'parentRelations')
    if (!listed.ok) {
      // 读不到 / 形状认不出 → **响亮抛错**，绝不退化成「本机没有父子关系」的空 Map
      // （空 Map 既会被 5 s TTL 缓存放大，也让「导出少带父对话」没有任何提示）。
      // 调用方各自有回退路径：/export-preview 只是不标父链接（预览照常），
      // 会话体检退回 storages 缓存枚举。
      throw new Error(listed.detail)
    }
    const out = new Map<string, SessionParentRelation>()
    for (const item of listed.items) {
      if (item.parent === undefined) continue
      out.set(item.id, { parent: item.parent, subagent: item.origin === 'subagent' })
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

/**
 * Patch-file facade：patch 的**两层**都在 home 根内 ——
 *   - 用户（home）层：`$DSH_HOME/cordis.patch.yml`
 *   - profile 层：`$DSH_HOME/profiles/<name>/cordis.patch.yml`
 *
 * `file` 参数是**相对 homeDir 的 POSIX 路径**（issue #71；层身份的定义见 core/patch-layers.ts）。
 * 改造前这里是「拿文件名字符串当枚举」的两个分支，而两个分支比较的是同一个字面量
 * `'cordis.patch.yml'` —— profile 分支永远不可达，于是 profile 层的 MCP / prompts 行
 * 在备份里凭空消失（用户报告的「备份不到外壳 mcp」）。现在按路径解析，两层都能读写。
 *
 * YAML 侧一律走 `utils/patch-yaml.ts` 的 **DSH 方言**（issue #75）：`!!js` 必须能读写往返，
 * 且原文件解析不了时**拒绝覆盖**（读不出来 ≠ 空文档）。
 */
export class DshPatchFileFacade implements PatchFileFacade {
  private readonly homeDir: string
  private readonly profile: string
  private readonly msg: MsgFunc

  constructor(homeDir: string, profile: string, msg: MsgFunc = zhMsg) {
    this.homeDir = homeDir
    this.profile = profile
    this.msg = msg
  }

  /**
   * 层路径 → 绝对路径。
   *
   * 只接受**已知的层路径**（用户层 / 本 profile 的 profile 层），且解析结果必须落在 home 根内：
   * 调用方传进来的是快照里存的字符串，跨机器恢复时不能让它变成任意路径写。
   * 本 profile 之外的 profile 层同样拒绝 —— 一个档案的备份不该写另一个档案的 patch。
   */
  private patchPath(file: string): string {
    const rel = file.replace(/\\/g, '/')
    const allowed = rel === USER_PATCH_FILE || (isPatchLayerRel(rel) && rel === profilePatchRel(this.profile))
    if (!allowed) {
      throw new Error(this.msg('host.patchUnsupported', {
        user: USER_PATCH_FILE,
        profile: profilePatchRel(this.profile),
        file,
      }))
    }
    const abs = resolve(this.homeDir, rel)
    if (!isSameOrChild(abs, this.homeDir)) {
      throw new Error(this.msg('host.patchUnsupported', {
        user: USER_PATCH_FILE,
        profile: profilePatchRel(this.profile),
        file,
      }))
    }
    return abs
  }

  async readPatchLines(file: string): Promise<{ lineId: string; raw: unknown }[]> {
    const p = this.patchPath(file)
    let text: string
    try {
      text = await fs.readFile(p, 'utf8')
    } catch (err) {
      // 真不存在 = 「按需创建、本来就没有」→ 空层（既有语义）。
      // 其余 errno（EACCES / EBUSY / …）**必须上抛**：读不到 ≠ 没有；静默返回空会让这一层的
      // patch 行在导出/同步里无声消失（t23 口径；readEffectivePatchLines 的 failures 通道会转成
      // 可见告警，三个适配器都会展示）。
      if (isENOENT(err)) return []
      throw new Error(this.msg('host.patchUnreadable', { file, reason: describePatchYamlError(err) }), { cause: err })
    }
    let doc: unknown
    try {
      doc = loadPatchDocument(text)
    } catch (err) {
      // 解析失败同样上抛（issue #75）：`!!js` 这类 DSH 方言一旦读不出来，返回 [] 就等于把用户
      // 手写的整层配置从导出/同步里抹掉（比「报错」糟得多）。
      throw new Error(this.msg('host.patchUnreadable', { file, reason: describePatchYamlError(err) }), { cause: err })
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
    //
    // 读不出来的既有内容**绝不能当作空文档**（issue #75 的数据丢失点）：重建后的文件只包含
    // 本次写入的行，等于把用户手写的其余行整段删掉。三种情况分开处理：
    //   - 真不存在（ENOENT）→ 空文档（首次创建，既有语义）；
    //   - 存在但读不到（EACCES/EBUSY/…）→ 抛错，不改写；
    //   - 存在但解析不了（含未知方言 / YAML 本身有错）→ 抛错，不改写。
    const rows = new Map<string, unknown>()
    const order: string[] = []
    let existing: string | null = null
    try {
      existing = await fs.readFile(p, 'utf8')
    } catch (err) {
      if (!isENOENT(err)) {
        throw new Error(this.msg('host.patchRefuseClobber', { file, reason: describePatchYamlError(err) }), { cause: err })
      }
    }
    let doc: unknown
    if (existing !== null && existing.trim() !== '') {
      try {
        doc = loadPatchDocument(existing)
      } catch (err) {
        throw new Error(this.msg('host.patchRefuseClobber', { file, reason: describePatchYamlError(err) }), { cause: err })
      }
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
      + dumpPatchDocument(out)
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
    } catch (err) {
      // t85 / t23 口径：**读不到 ≠ 没有**。只有 ENOENT 才是「按需创建、本来就没有」；
      // EACCES / EPERM / EBUSY / EMFILE / ENOTDIR… 一律**按「存在」处理**（返回 true）。
      //
      // 为什么选「按存在处理」而不是上抛：本方法是 FileSystemFacade 的**布尔端口**，全部消费点
      // 都按「exists() 恒返回布尔、不抛」来写（消费点清单见 t85 交付物），其中多处处于只读/预览
      // 路径（backup / market / sync-ancestor / plugin-files）—— 上抛会把「探测失败」变成这些调用点
      // 未预期的错误面；而 t23 立的规矩正是「判定『不存在』的探测自身失败时按『存在』处理」。
      // 保守方向也是安全方向：true ⇒ 调用方不创建 / 不删除 / 不剔除声明，绝不造成有损副作用。
      // ENOENT 必须仍为 false，否则会破坏「按需创建 / 本来就没有」的既有语义。
      return !isENOENT(err)
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
   * 一次 stat 同时取「字节数 + mtime」（只读预览用；不存在 / 读不到 / 非普通文件 → null）。
   *
   * 为什么合并：`/export-preview` 对同一个文件既要体积（`statSize`）又要时间（`mtimeMs`，
   * sessions 的排序兜底）—— 分两次调用就是两次 `fs.stat`（实测会话树 983 个文件，第二趟是净开销）。
   * 与 `mtimeMs`/`statSize` 同一条安全约定：`this.abs()` 的越界错误向上抛。
   */
  async statInfo(relPath: string): Promise<{ size: number; mtimeMs: number } | null> {
    const target = this.abs(relPath)
    try {
      const st = await fs.stat(target)
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch {
      return null
    }
  }

  /**
   * 文件字节数（只读预览用；不存在 / 读不到 → null）。
   *
   * 与 mtimeMs 同一条安全约定：`this.abs()` 的越界错误向上抛（被 catch 吞成 null 会让
   * 「越界」看起来像「正常缺文件」）。非普通文件返回 null —— 交给调用方退回 readFile，
   * 由那条路径给出真实错误，而不是返回一个毫无意义的目录 size。
   *
   * 为什么需要它：`/export-preview` 只需要「N 个文件 / X MiB」，实测本机会话树 941 个文件
   * / 528 MB，走 readFile 取长度要 2.27 s、常驻内存 +306 MiB；stat 只取元数据。
   */
  async statSize(relPath: string): Promise<number | null> {
    const target = this.abs(relPath)
    try {
      const st = await fs.stat(target)
      return st.isFile() ? st.size : null
    } catch {
      return null
    }
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
   * 目录体积上界（只读预览：本地源插件的 `link:` 目录）。
   *
   * 与 realpathDir 同族的「绝对路径」方法：入参只可能是本机插件 spec 推导出的绝对路径
   * （`link:` 常指向 $DSH_HOME 之外的桌面端 resources 目录），因此**不受 home 边界限制**。
   *
   * 约束（宁可低估，不可卡住预览）：
   *  - 不跟随符号链接 / junction：`readdir(withFileTypes)` 对链接目录的 isDirectory() 恒 false，
   *    按「既不是文件也不是目录」跳过，既不会绕圈也不会跑出该目录；
   *  - 跳过 node_modules：`npm pack` 自身也排除它，数进去只会把量级抬高一个数量级；
   *  - `maxEntries` 兜底（默认 20000）：超出即停并返回已累计值；
   *  - 不是目录 / 读不到 → null（调用方对这类目录退回「体积按 0」）。
   */
  async dirSizeBytes(absPath: string, opts: { maxEntries?: number } = {}): Promise<number | null> {
    const maxEntries = opts.maxEntries !== undefined && opts.maxEntries > 0 ? opts.maxEntries : 20000
    const readEntries = async (dir: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> => {
      try {
        return await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return []
      }
    }
    try {
      const target = resolve(absPath)
      const st = await fs.stat(target)
      if (!st.isDirectory()) return null
      const stack: string[] = [target]
      let total = 0
      let counted = 0
      while (stack.length > 0) {
        const dir = stack.pop()
        if (dir === undefined) break
        for (const ent of await readEntries(dir)) {
          if (ent.name === 'node_modules') continue
          const full = join(dir, ent.name)
          if (ent.isDirectory()) {
            stack.push(full)
            continue
          }
          if (!ent.isFile()) continue
          if (counted >= maxEntries) return total
          counted += 1
          try {
            const fileStat = await fs.stat(full)
            if (fileStat.isFile()) total += fileStat.size
          } catch {
            // 单个文件读不到就跳过：预览要的是量级，不值得为它失败
          }
        }
      }
      return total
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
  /** profile 目录绝对路径（profiles/<name>；宿主解析，避免拼接布局猜错） */
  readonly profileDir: string
  readonly log: Logger
  readonly msg: MsgFunc
  /** 应用语言（**调用期解析**：resolveAppLanguage 的活源；导出历史报告 locale 用） */
  get language(): 'zh' | 'en' {
    return getEngineLocale()
  }
  readonly settings: SettingsFacade
  readonly credentials: CredentialsFacade
  readonly plugins: PluginsFacade
  readonly workspace: WorkspaceFacade
  readonly patchFile: PatchFileFacade
  readonly fs: FileSystemFacade
  /** 系统 home（第三方插件数据分区 pluginData / pluginAssets 的根；见 HostContext 的说明） */
  readonly osHomeDir: string
  /** 以系统 home 为根的文件门面（同样越界即抛；只有上面两个分区能用） */
  readonly homeFs: FileSystemFacade
  /** 会话存储端口（issue #45 会话归位；对 ctx.sessionPersistence 的薄适配） */
  readonly sessions: SessionStoreFacade
  /**
   * 技能服务端口（issue #71；对 ctx.skills 的薄适配）。
   *
   * 为什么需要：真机上 89 个 SKILL.md 全在 `profiles/<p>/node_modules` 里（技能 provider 由
   * 插件注册），`$DSH_HOME/skills` 根本不存在 —— 只扫目录的分区必然是空的。
   *
   * 可选：宿主没有 skills 服务时（旧外壳）缺省 undefined，skills 分区退回纯目录扫描。
   */
  readonly skills: SkillStoreFacade | undefined
  /**
   * 本机 DSH 支持的**会话日志格式版本**（`SESSION_FORMAT_VERSION`；解析不到 = undefined）。
   *
   * 用于导入/同步的「这条对话目标机读不读得了」体检：DSH 对读不出的格式是**静默跳过**的
   * （不报错、不出现在工作区列表里）。解析不到时**不猜** —— 体检整体跳过，绝谎报兼容。
   */
  readonly sessionFormatVersion: number | undefined
  /** Phase 2 跨进程环境锁端口（宿主注入；测试 mock 不注入 → 无锁环境） */
  mutationLock?: MutationLockPort
  /** Phase 3 SAFE MODE：注入同步谓词（读内存标志，供 withMutationLock isBlocked 用；env-lock 不识 policy） */
  safeModeIsBlocked?: () => boolean
  /** Phase 3 恢复/事务（JournalStore + reconcile + SAFE MODE + runJournaled）。apply() 注入。 */
  phase3Recovery?: import('./core/phase3-host.ts').Phase3Recovery
  /**
   * 本机自请求能力（F-2：官方 session.export 通道的探测与代理）。
   *
   * 只有「让 DSH 自己的 /api/session.export 说一遍它自己的状态」这一种用法 ——
   * 绝不拿它去访问外部网络（插件对外的网络调用有各自的既有通道）。
   */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  /** 本实例 web 监听端口（webServer 就绪前为 undefined → 探测不发请求、如实降级）。 */
  webPort?: number

  constructor(ctx: Context, homeDir: string, profile: string) {
    this.homeDir = homeDir
    // 「当前 DSH 版本」= 拉起本宿主的那份 runtime（profileContext.installAnchor），
    // 而不是磁盘上可能早已过期的 hoisted 副本（Desktop 实测：0.2.0-rc.2 vs 0.1.5-rc.1）。
    const installAnchor = installAnchorFromProfileContext(readService<unknown>(ctx, 'profileContext'))
    this.dshVersion = resolveDshVersion(homeDir, profile, installAnchor)
    // 会话格式版本与 DSH 版本同源同候选（桌面端的运行时在 app.asar 内）。
    // tried 收集**所有尝试过的路径**：解析失败时写进日志 —— 「解析不到」这句话本身对排查没有价值
    // （issue #74 的直接诉求），真机要的是「都试了哪几处」。
    const sessionFormatTried: string[] = []
    this.sessionFormatVersion = resolveSessionFormatVersion(
      dshPackageJsonCandidates(homeDir, profile, installAnchor), sessionFormatTried)
    this.profile = profile
    this.profileDir = resolveProfileDir(homeDir, profile)
    // 引擎语言运行时（t2）：语言必须在「取文案那一刻」解析，而不是在装配那一刻 ——
    // 原先 this.msg = makeMsg(resolveAppLanguage(ctx)) 只在 apply() 时求值一次，用户切到
    // English 后宿主产出的报告/计划/错误文本永远停在加载时语言。
    // 构造期先按当前语言设定一次（未设定时行为等于 zh），再注册「调用期解析」的活源：
    // 之后每次取文案都跟随用户语言（resolveAppLanguage 走 ctx.settings.describe，
    // 非请求路径由 LANGUAGE_TTL_MS 兜底缓存）。
    setEngineLocale(resolveAppLanguage(ctx))
    setEngineLanguageSource(() => resolveAppLanguage(ctx))
    this.msg = engineMsg
    // 日志级别缺省 warn：启动 dsh web 后控制台只留 warn/error —— 挂载横幅、调度器跳过、
    // 导出/备份完成等常规 info 不再刷屏（用户要求移除启动后的日志噪音）；
    // 排查时 DSH_CONFIG_MANAGER_LOG_LEVEL=info|debug 恢复逐条输出。
    this.log = createLogger({ level: parseLogLevel(process.env.DSH_CONFIG_MANAGER_LOG_LEVEL) })
    if (this.sessionFormatVersion === undefined) {
      // 绝不静默：解析不到就明说体检不可用（用户仍能导出/导入，只是拿不到格式告警），
      // 并把已尝试的路径一并给出。
      const separator = this.msg('host.sessionFormatPathSeparator')
      const triedText = sessionFormatTried.length > 6
        ? this.msg('host.sessionFormatPathsTruncated', { paths: sessionFormatTried.slice(0, 6).join(separator) })
        : sessionFormatTried.join(separator)
      this.log.warn('无法解析本机 DSH 的会话格式版本：导入/同步不做「会话格式是否可读」体检'
        + `（已尝试 ${sessionFormatTried.length} 处：${triedText}）`)
    }
    this.settings = new DshSettingsFacade(ctx)
    this.credentials = new DshCredentialsFacade(ctx)
    this.patchFile = new DshPatchFileFacade(homeDir, profile, this.msg)
    this.plugins = new DshPluginsFacade(homeDir, profile, this.patchFile, undefined, this.msg)
    this.workspace = new DshWorkspaceFacade(ctx, this.msg)
    this.fs = new DshFileSystemFacade(homeDir, this.msg)
    // 系统 home：一部分第三方插件把数据放在 $DSH_HOME 之外（~/.dsh-wallpaper-engine、~/.mnemon …），
    // 那两个分区必须换根读写；门面本身与 $DSH_HOME 门面同一实现、同样被限制在它自己的根内。
    this.osHomeDir = homedir()
    this.homeFs = new DshFileSystemFacade(this.osHomeDir, this.msg)
    this.sessions = new DshSessionStoreFacade(ctx, homeDir, this.msg, this.log)
    // F-2：Cordis 的 fetch 服务（DSH 自己在用它转发 /api）。缺省回落进程全局 fetch（Node ≥18 恒有）。
    const fetchService = readService<unknown>(ctx, 'fetch')
    const fetchImpl = typeof fetchService === 'function' ? fetchService : globalThis.fetch
    if (typeof fetchImpl === 'function') {
      this.fetch = (input, init) => fetchImpl(input, init) as Promise<Response>
    }
    this.skills = resolveSkillStore(ctx)
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
  // e2e-F1：**解密成功**（GCM 已认证）之后的「没有可识别 ref」必须回**空 Map**，而不是 undefined ——
  // undefined 是「没有解密 / 不适用」的语义，会被 analyzer 的安全阀判成「未提供密码」而拒绝导入
  // （真机：导出机没有可导出的凭据值 → secrets.enc 明文 0 字节 → yaml.load('') 抛错 → undefined → 400）。
  // 与同步侧 `fromYaml`（src/security/credentials-yaml.ts，其测试断言 fromYaml('').size === 0）同口径。
  let parsed: unknown
  try {
    parsed = plaintext.trim() === '' ? null : yaml.load(plaintext)
  } catch {
    parsed = null
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
export type RouteEnvInferred = { sessionExportFetch: ((input: string, init: RequestInit) => Promise<Response>) | undefined; sessionExportPort: number | undefined; adapters: ConfigAdapter<unknown>[]; sessionHealth: { homeDir: string; targetFormatVersion: () => number | undefined; workspaceKeys: () => Promise<ReadonlySet<string>>; knownSessionIds: () => Promise<ReadonlySet<string>>; sessionMeta: (ids: readonly string[]) => Promise<SessionMetaIndex>; }; backupScheduler: BackupScheduler; bootSafetyAudit: () => Promise<BootSafetyReport>; cancelDecisionTimeoutMs: number; buildMarketSummary: (e: { url: string; addedAt: string; }) => Promise<MarketSummary>; credentials: CredentialProvider; dataDir: string; exportsDir: string; githubAuth: GitHubAuthClient; githubClientId: string | undefined; githubClientSecret: string | undefined; githubFlows: DeviceFlowStore; history: MigrationStore; host: ConfigManagerHostContext; itemCached: (url: string, itemId: string) => Promise<boolean>; knownSyncSectionIds: Set<SectionId>; makeImporter: () => Importer; makeMarketReader: () => GitMarketReader; makeRecoveryExecutors: (runId: string) => RecoveryExecutorFns; makeSyncEngine: (cfg: SyncConfig, engineOpts?: { optInSections?: readonly SectionId[]; }) => SyncEngine; marketBootAutoRefreshed: { value: boolean; }; marketCacheIndex: (url: string) => string; marketDir: string; marketCacheItemDir: (url: string) => string; marketStarCache: StarCache; marketWorkDir: (url: string) => string; meGitHubRest: GitHubAuthRest; meService: MyRepoService; meTokenProvider: () => Promise<string>; msg: MsgFunc; prepareSync: (body: Record<string, unknown>) => Promise<SyncConfig>; profileLauncher: DshProfileLauncher; profileRuntime: DshProfileRuntimeRegistry; profiles: DshProfileManager; pruneStagedMarketZips: () => Promise<void>; readCachedIndexObj: (url: string) => Promise<MarketIndex | null>; recoveryOrchestrator: RecoveryOrchestrator; resolveSyncPassword: (ref: string) => Promise<string | undefined>; roots: string[]; runAbortControllers: Map<string, AbortController>; runCancels: Map<string, { signal: AbortController; settle: (d: 'rollback' | 'keep') => void; decided: boolean }>; runs: RunRegistry; scheduler: AutoSyncScheduler; selectionCache: Partial<Record<SyncTransportType, SyncSelection>>; selectionOptInSections: (channel: SyncTransportType, onlyAuto?: boolean) => SectionId[]; selectionView: (channel: SyncTransportType) => Promise<SelectionView>; selectionViewByChannel: () => Promise<Record<SyncTransportType, SelectionView>>; snapshotEntrySections: (snapshotDir: string) => Promise<string[]>; snapshotsDir: string; syncCredentialsByChannelView: () => Promise<Record<SyncTransportType, { encryptPasswordConfigured: boolean; decryptPasswordConfigured: boolean; }>>; syncDir: string; syncPasswordConfigured: (ref: string) => Promise<boolean>; syncWorkDir: { inspect: (repoUrl: string) => Promise<{ facts: GitWorkDirFacts; } | { error: string; }>; rebuild: (repoUrl: string, mode: 'relink' | 'adopt' | 'reclone') => Promise<GitWorkDirFacts>; }; syncSectionCatalog: { id: SectionId; displayName: string; portability: Portability; defaultIncluded: boolean; }[]; syncSessions: SyncSessionStore; tmpDir: string; tryAppendHistory: (raw: { kind: MigrationKind; result: MigrationResult; sections: string[]; operationId?: string; snapshotId?: string; runId?: string; source: 'api' | 'autosync' | 'backup-scheduler' | 'recovery' | 'cli' | 'internal'; summary: string; error?: string; }) => Promise<string | undefined>; withMutationGate: (op: string, handler: (req: IncomingMessage, res: ServerResponse, lockCtx?: MutationLockContext, journalCtx?: JournalRunContext) => Promise<void>, opts?: { journaled?: boolean; deferredSnapshot?: boolean; }) => ((req: IncomingMessage, res: ServerResponse) => Promise<void>); selfUpdate: (targetVersion: string) => Promise<SelfUpdateOutcome>; writeItemCache: (url: string, itemId: string, manifestRaw: string, zipBytes: Uint8Array) => Promise<void>; }

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
  /** 本实例的 web 端口（惰性；webServer 就绪前为 null）——运行注册表的心跳要带上它 */
  runtimePort?: () => number | null
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
  /** code：稳定机器码（如 cloud.endpointRequired），由 UI 映射进字典；缺省 = 无码。 */
  constructor(message: string, status: number = 400, code?: string) {
    super(message, status, code)
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
  const rawTransport = body['transport']
  // 通道值解析：接受通道名（s3/gist）；也接受**具体兼容商**（oss/cos/minio/kodo）直接落到 s3 通道
  const transport = parseSyncChannel(rawTransport) ?? (isS3CompatProvider(rawTransport) ? 's3' : 'git')
  if (transport === 's3') return parseCloudS3Body(body, rawTransport, deps)
  if (transport === 'gist') return parseCloudGistBody(body, deps)
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
          engineMsg('host.syncWebdavPasswordWriteFailed', { reason, ref: SYNC_WEBDAV_CREDENTIAL_REF }),
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
        engineMsg('host.syncTokenWriteFailed', { reason, ref: SYNC_CREDENTIAL_REF }),
      )
    }
  }
  return {
    schemaVersion: 2,
    transport: 'git',
    git: { repoUrl },
  }
}

/** 请求体字段 → 去空白字符串（非字符串 = 空）。 */
function syncStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 云端点密钥写入失败 → 可操作错误（**含 ref 名、绝不含密钥值**）。 */
function cloudCredentialWriteError(ref: string, kind: string, error: unknown): SyncRouteError {
  const reason = error instanceof Error ? error.message : String(error)
  return new SyncRouteError(
    engineMsg('host.syncCredentialWriteFailed', { kind, reason, ref }),
    400,
    'cloud.credentialsWriteFailed',
  )
}

/**
 * s3 通道请求体 → SyncConfig（provider 必填或由 transport 直接给出）。
 * 非密字段按 validateCloudChannelInput 校验（错误码 = HTTP body.code，由 UI 映射字典）；
 * 密钥**只写**进 DSH credentials 的 cloudSecretRef(provider) 槽位，绝不进返回值 / 文件 / 日志。
 */
async function parseCloudS3Body(
  body: Record<string, unknown>,
  rawTransport: unknown,
  deps: ParseSyncBodyDeps,
): Promise<SyncConfig> {
  const provider = isS3CompatProvider(body['provider'])
    ? body['provider']
    : (isS3CompatProvider(rawTransport) ? rawTransport : null)
  if (provider === null) {
    throw new SyncRouteError('provider is required for s3 (s3/oss/cos/minio/kodo)', 400, 'cloud.providerUnknown')
  }
  const endpoint = syncStr(body['endpoint']).replace(/\/+$/, '')
  const region = syncStr(body['region'])
  const bucket = syncStr(body['bucket'])
  const accessKeyId = syncStr(body['accessKeyId'])
  const prefix = syncStr(body['prefix'])
  const pathStyle = typeof body['pathStyle'] === 'boolean' ? body['pathStyle'] : undefined
  const dialectId = body['dialectId'] === 'aws4' || body['dialectId'] === 'oss4' ? body['dialectId'] : undefined
  const issue = validateCloudChannelInput(provider, {
    endpoint,
    region,
    bucket,
    accessKeyId,
    ...(prefix === '' ? {} : { prefix }),
    ...(pathStyle === undefined ? {} : { pathStyle }),
    ...(dialectId === undefined ? {} : { dialectId }),
  })
  if (issue !== null) throw new SyncRouteError(issue, 400, issue)
  const secret = typeof body['secret'] === 'string' && body['secret'] !== '' ? body['secret'] : undefined
  if (secret !== undefined) {
    const ref = cloudSecretRef(provider)
    try {
      await deps.credentials.set(credentialRef(ref), secret)
    } catch (error) {
      throw cloudCredentialWriteError(ref, engineMsg('host.syncKindS3Secret'), error)
    }
  }
  return {
    schemaVersion: 2,
    transport: 's3',
    s3: {
      provider,
      endpoint,
      region,
      bucket,
      accessKeyId,
      ...(prefix === '' ? {} : { prefix }),
      ...(pathStyle === undefined ? {} : { pathStyle }),
      ...(dialectId === undefined ? {} : { dialectId }),
    },
  }
}

/**
 * gist 通道请求体 → SyncConfig。token 只写进 cloudSecretRef('gist') 槽位
 * （请求体字段名 token 或 secret 都接受；值绝不进返回值 / 文件 / 日志）。
 */
async function parseCloudGistBody(body: Record<string, unknown>, deps: ParseSyncBodyDeps): Promise<SyncConfig> {
  const gistId = syncStr(body['gistId'])
  const apiBaseUrl = syncStr(body['apiBaseUrl'])
  const filePrefix = syncStr(body['filePrefix'])
  const issue = validateCloudChannelInput(GIST_PROVIDER, {
    gistId,
    ...(apiBaseUrl === '' ? {} : { apiBaseUrl }),
    ...(filePrefix === '' ? {} : { filePrefix }),
  })
  if (issue !== null) throw new SyncRouteError(issue, 400, issue)
  const token = typeof body['token'] === 'string' && body['token'] !== ''
    ? body['token']
    : (typeof body['secret'] === 'string' && body['secret'] !== '' ? body['secret'] : undefined)
  if (token !== undefined) {
    const ref = cloudSecretRef(GIST_PROVIDER)
    try {
      await deps.credentials.set(credentialRef(ref), token)
    } catch (error) {
      throw cloudCredentialWriteError(ref, 'Gist token', error)
    }
  }
  return {
    schemaVersion: 2,
    transport: 'gist',
    gist: {
      gistId,
      ...(apiBaseUrl === '' ? {} : { apiBaseUrl }),
      ...(filePrefix === '' ? {} : { filePrefix }),
    },
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
  // issue #105：只有本轮真的失败才回传错误原文（success/skipped/partial 不得带上一轮的旧错误）
  const failureMessage = lastRunFailureMessage(cfg)
  return {
    enabled: cfg.enabled,
    interval: cfg.interval,
    // 真·自动同步三件套（缺省值在读取层已补齐，这里回传「生效中的值」）
    realtime: cfg.realtime ?? DEFAULT_AUTOSYNC_REALTIME,
    remoteCheckMs: cfg.remoteCheckMs ?? DEFAULT_AUTOSYNC_REMOTE_CHECK_MS,
    autoApplyTier: cfg.autoApplyTier ?? DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
    conflictPolicy: cfg.conflictPolicy ?? DEFAULT_AUTOSYNC_CONFLICT_POLICY,
    ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
    ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
    ...(failureMessage !== undefined ? { lastRunMessage: failureMessage } : {}),
    // issue #79：跳过原因以**码**回传（界面本地化）；不再只留在 info 级日志里
    ...(cfg.lastRunSkipReason !== undefined ? { lastRunSkipReason: cfg.lastRunSkipReason } : {}),
    ...(cfg.lastRunSkipCount !== undefined ? { lastRunSkipCount: cfg.lastRunSkipCount } : {}),
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
    // issue #105：同 buildAutosyncStatus —— 只有本轮失败才带错误原文
    const failureMessage = lastRunFailureMessage(cfg)
    return {
      enabled: cfg.enabled,
      interval: cfg.interval,
      realtime: cfg.realtime ?? DEFAULT_AUTOSYNC_REALTIME,
      remoteCheckMs: cfg.remoteCheckMs ?? DEFAULT_AUTOSYNC_REMOTE_CHECK_MS,
      autoApplyTier: cfg.autoApplyTier ?? DEFAULT_AUTOSYNC_AUTO_APPLY_TIER,
      conflictPolicy: cfg.conflictPolicy ?? DEFAULT_AUTOSYNC_CONFLICT_POLICY,
      ...(cfg.lastRunAt !== undefined ? { lastRunAt: cfg.lastRunAt } : {}),
      ...(cfg.lastRunStatus !== undefined ? { lastRunStatus: cfg.lastRunStatus } : {}),
      ...(failureMessage !== undefined ? { lastRunMessage: failureMessage } : {}),
      ...(cfg.lastRunSkipReason !== undefined ? { lastRunSkipReason: cfg.lastRunSkipReason } : {}),
      ...(cfg.lastRunSkipCount !== undefined ? { lastRunSkipCount: cfg.lastRunSkipCount } : {}),
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
  /** 真·自动同步：本地改动即时触发（缺省 true） */
  realtime: boolean
  /** realtime 下的远端轮询间隔（ms） */
  remoteCheckMs: number
  /** 自动应用的最高风险等级（缺省 medium：plugins/mcp 也自动落盘） */
  autoApplyTier: AutosyncAutoApplyTier
  /** 双侧都改时的策略（缺省 local：保留本机并推上去） */
  conflictPolicy: AutosyncConflictPolicy
  lastRunAt?: string
  lastRunStatus?: AutosyncRunStatus
  lastRunMessage?: string
  /** issue #79：本轮跳过的**结构化原因码**（界面按码取字典；语言在渲染那一刻解析） */
  lastRunSkipReason?: string
  /** 跳过涉及的分区数（当前仅 conflict：远端另有 N 个分区待确认） */
  lastRunSkipCount?: number
  consecutiveFailures: number
  elapsedMs: number
  lastRunHistoryId?: string
}

/* -------------------------------------------------- restore 路由（M4） */

/** POST /restore 请求体校验（纯函数；snapshotId 拒绝路径分隔符防 join 越界）。 */
export type BuildRestoreBodyResult =
  | { ok: true; value: { snapshotId: string; dryRun: boolean; planFingerprint?: string } }
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
  // 预览-执行一致性（P3）：客户端把预览时拿到的计划指纹带回来；缺省 = 旧客户端，行为不变。
  const planFingerprint = record['planFingerprint']
  return {
    ok: true,
    value: {
      snapshotId,
      dryRun: record['dryRun'] === true,
      ...(typeof planFingerprint === 'string' && planFingerprint !== '' ? { planFingerprint } : {}),
    },
  }
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
            throw new Error(engineMsg('restore.missingTargetBlob'))
          }
          if (await exec.existsHome(action.target)) await exec.savePreRestore(action.target)
          await exec.writeHome(action.target, await exec.readBlob(action.blobPath))
          report.restored.push(action.target)
          break
        }
        case 'hostFileRemove':
        case 'fileRemove': {
          if (action.target === undefined) throw new Error(engineMsg('restore.missingTarget'))
          if (await exec.existsHome(action.target)) {
            await exec.savePreRestore(action.target)
            await exec.removeHome(action.target)
          }
          report.restored.push(action.target)
          break
        }
        case 'pluginRemove': {
          if (action.pluginName === undefined) throw new Error(engineMsg('restore.missingPluginName'))
          const result = await exec.uninstallPlugin(action.pluginName)
          if (result.ok) {
            report.removedPlugins.push(action.pluginName)
          } else {
            report.failed.push({ item: `plugin:${action.pluginName}`, reason: result.message ?? engineMsg('restore.pluginRemoveFailed') })
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
          report.skipped.push(engineMsg('restore.unknownAction', { kind: String(action.kind), description: action.description }))
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

/**
 * 会话体检的「下一步」建议（**可复制命令**；给应用内修不了的那些损坏类别）。
 *
 * 为什么仍然需要这条出路：应用内修复（T8）只覆盖「重放重复行」这一**能从字节证明**的零损失类；
 * 其余类别（seq 空洞 / 不可解析行 / 容器非法 / 格式超前）必须离线进行（DSH 运行中改写会话会让
 * 它下次启动直接报 corrupt session log）。
 * 界面给不出的动作，就用可复制命令如实交代。
 */
function sessionHealthNextSteps(rowCount: number, summary: { bySeverity: Record<string, number>; deepUnverified: number }): {
  commands: { command: string; reason: string }[]
  notes: string[]
} {
  const commands: { command: string; reason: string }[] = []
  const notes: string[] = []
  const blocking = (summary.bySeverity['blocksStartup'] ?? 0) + (summary.bySeverity['unloadable'] ?? 0)
  if (blocking > 0) {
    commands.push({ command: 'dsh-config-manager sessions repair', reason: 'preview-repair-plan' })
  }
  if (rowCount > 0) {
    // 修复必须在 DSH **停止**时进行（两个同类生态工具同结论；运行中改写会让它下次启动报 corrupt）
    commands.push({ command: 'dsh-config-manager sessions doctor --json', reason: 'offline-inspection' })
  }
  if (summary.deepUnverified > 0) notes.push('deep-unverified')
  return { commands, notes }
}

export { sessionHealthNextSteps };

/**
 * 会话体检（T4）的两个**只读**事实来源：本机工作区记录的 cwd 目录键、本机全部已知会话 id。
 *
 * 都在 index.ts（宿主侧）实现：它们要读 DSH 自己的存储（workspace.json / session_projcache.json），
 * 而路由组不许自己读盘（kit 只负责围栏与错误映射）。两者**都只读、都不抛错**
 * （读不到 = 空集合，体检据此不下「未登记 / 缺父」这类结论 —— 见 core/session-health 的口径）。
 */
async function sessionHealthWorkspaceKeys(host: HostContext): Promise<ReadonlySet<string>> {
  const keys = new Set<string>()
  try {
    // WorkspaceFacade 是 DSH 的权威注册表视图（与 adapters/workspaces 同源）
    for (const record of await host.workspace.listRecords()) {
      const p = (record as { path?: unknown }).path
      if (typeof p === 'string' && p !== '') keys.add(projectKeyOf(p))
    }
  } catch {
    // 读不到工作区注册表 → 空集合（调用方不据此下结论）
  }
  if (keys.size > 0) return keys
  // 回退：直接读 DSH 的 workspace.json（facade 读不到时的兜底）
  try {
    const meta = await readSessionMeta(host)
    for (const key of meta.workspacePathByProjectKey.keys()) keys.add(key)
  } catch {
    /* 尽力而为 */
  }
  return keys
}

/** 本机全部已知会话 id 的**归一化键**（子代理会话的「父对话是否存在」判定用）。 */
async function sessionHealthKnownIds(host: HostContext): Promise<ReadonlySet<string>> {
  const ids = new Set<string>()
  // 父对话存在性判定的权威来源 = DSH 自己的会话存储列举（它同时给出 origin='subagent' 的
  // 会话与它们的父 id），插件不重复解析日志字节。
  const facade = host.sessions
  if (facade?.parentRelations !== undefined) {
    try {
      for (const [childId, relation] of await facade.parentRelations()) {
        ids.add(sessionIdKey(childId))
        if (typeof relation.parent === 'string' && relation.parent !== '') ids.add(sessionIdKey(relation.parent))
      }
    } catch (err) {
      // T8-F2：**不许静默**。port 层刚刚改成「认不出形状就抛错」（F-1），调用点若把声响整吞，
      // 用户看到的仍是「父子联动无缘无故不生效」。行为不变（不猜、落回下面的 storages 缓存），
      // 但必须留下一条带机器可读 code 的 warn —— 这是本仓那条教训的正面形态：
      // 注释承诺的防线，必须在运行时真的发生（可观测）。
      host.log.warn(msgOf(host)('host.parentRelationsUnavailable', { reason: errorMessage(err) }), {
        code: 'parent-relations-unavailable',
        source: 'sessionHealthKnownIds',
      })
    }
  }
  if (ids.size > 0) return ids
  try {
    const meta = await readSessionMeta(host)
    for (const key of meta.bySessionId.keys()) ids.add(sessionIdKey(key))
  } catch {
    /* 尽力而为 */
  }
  return ids
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): { routes: WebRoute[]; scheduler: AutoSyncScheduler; makeSyncEngine: (cfg: SyncConfig) => SyncEngine; profileRuntime: DshProfileRuntimeRegistry } {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, marketDir, dataDir, credentials, githubClientId, githubClientSecret, backupScheduler, history } = deps
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
   * 会话格式处置（T1）：解析与阻断判定统一走 src/routes/session-format.ts（与 /execute、
   * 同步 preview/apply 共用同一条口径）。此处只做本地绑定，避免每个 handler 重复写路径。
   */
  const resolveDisposition = (raw: unknown): Promise<SessionFormatDisposition> =>
    resolveSessionFormatDisposition(syncDir, raw)
  const dispositionAbort = (plan: ImportPlan, disposition: SessionFormatDisposition): SessionFormatAbortBody | null =>
    sessionFormatAbortResponse(plan, disposition, msg)

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
        summary: engineMsg('host.snapshotPruneSummary', { count: removedIds.length }),
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
    // 启动关键 yaml 里包含**两层 cordis.patch.yml**（BOOT_CRITICAL_RELS），它们是 DSH 的专用方言
    // （`!!js`）。用缺省 schema 解析会把用户的 patch 层误报成「启动关键文件无法解析」——
    // 与 issue #75 同一个根因，只是症状换成了假警报。其余设置类 yaml 用同一 schema 只会更宽松。
    parseYaml: (text) => loadPatchDocument(text),
    msg,
  })

  /** 已知 adapter id 集合（push 请求体 sections 校验用）。 */
  const knownSyncSectionIds = new Set(adapters.map((a) => a.id))
  /** 可同步分区目录（status 回填 UI「同步分区」勾选列表）。
   *  只含 portable + 显式可选项（OPT_IN_SYNC_SECTIONS，当前 mcp / sessions）——
   *  后者是 deviceSpecific，UI 必须显示设备相关徽章，且只有用户主动勾选才进同步通道。 */
  const syncSectionCatalog = adapters
    .filter((a) => a.portability === 'portable' || OPT_IN_SYNC_SECTIONS.includes(a.id))
    .map((a) => ({ id: a.id, displayName: a.displayName, portability: a.portability, defaultIncluded: a.defaultIncluded }))

  const makeImporter = (): Importer => new Importer({
    ctx: host,
    adapters,
    // 会话格式体检：宿主探针只解**首帧**，成本与分区大小无关（core 只消费数字，不碰存储格式）。
    sessionFormatProbe: (files) => probeSessionFormats(files),
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
      // 保留清理被放弃/失败的唯一可见线索（core 不持 logger，由宿主接 host.log）
      onWarn: (message) => { host.log.warn(message) },
    }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
    msg,
  })

  /**
   * m-profiles：档案管理器（DSH 自带 profile：$DSH_HOME/profiles/<name>）。
   * currentProfile 惰性读取（config.profile / --profile / 缺省 web），列表里据此标注「当前运行」。
   * 只做目录级读写（列表/详情/新建/重命名/物理删）；进程操作全在下面的启动器里。
   */
  const profiles = new DshProfileManager({
    homeDir: host.homeDir,
    currentProfile: () => host.profile ?? 'web',
  })
  /**
   * m-profiles：**运行注册表**（心跳）—— 「这台机器上哪些 profile 正跑着」。
   * 每个加载本插件的实例往 `<dataDir>/running/<profile>.json` 自报 pid/端口（**不含 token**），
   * 20s 刷新、60s 判死。为什么必须有：只认启动方的台账时，手动 `dsh web` 起来的实例对插件不可见，
   * 于是从 cmtest 里还能把 web 再启动一次（用户实测的同名多开）。
   */
  const profileRuntime = new DshProfileRuntimeRegistry({
    dataDir,
    name: host.profile ?? 'web',
    port: deps.runtimePort ?? (() => null),
  })
  /**
   * m-profiles：档案启动器（DSH 无「默认 profile」，切换只能靠另起实例）。
   * launch / stop / listRunning 共用 `<dataDir>/launches.json`（**本插件启动的**实例台账）；
   * 「能不能启动」还要过运行注册表的心跳（别处/手动启动的实例同样不许重复启动）。
   */
  const profileLauncher = new DshProfileLauncher({
    homeDir: host.homeDir,
    dataDir,
    deps: { isProfileRunning: (name) => profileRuntime.listActive().some((r) => r.name === name) },
  })
  // 自报心跳（启动即有；apply() 在 webServer 就绪后会再报一次带上端口，并在 dispose 时撤回）。
  profileRuntime.announce()


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
    for (const channel of SYNC_CHANNELS) selectionCache[channel] = all[channel]
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
    const view = (sel: SyncSelection): SelectionView =>
      ({ mode: sel.mode, sections: sel.sections, sessionsLimit: sel.sessionsLimit, sessionsInclude: sel.sessionsInclude, encrypt: sel.encrypt, includeSecrets: sel.includeSecrets })
    // 通道集合来自唯一枚举（SYNC_CHANNELS）；不得穷举字面量（漏一处即该通道状态静默缺失）
    const out = {} as Record<SyncTransportType, SelectionView>
    for (const channel of SYNC_CHANNELS) {
      selectionCache[channel] = all[channel]
      out[channel] = view(all[channel])
    }
    return out
  }

  /**
   * 该通道持久化选择里**显式勾选**的可选分区（与注册表白名单取交集；缺省 / 默认模式 → 空集）。
   *
   * onlyAuto=true 时只保留 'auto' 档（AUTO_SYNC_OPT_IN_SECTIONS）—— 自动同步调用点的口径：
   * mcp 跟着走，sessions（'manual'）绝不悄悄下行/上行。
   */
  const selectionOptInSections = (channel: SyncTransportType, onlyAuto = false): SectionId[] => {
    const sel = selectionCache[channel]
    if (sel === undefined) return []
    const sections = effectiveSections(sel)
    if (sections === undefined) return []
    const allowed = onlyAuto ? AUTO_SYNC_OPT_IN_SECTIONS : OPT_IN_SYNC_SECTIONS
    return sections.filter((id) => allowed.includes(id))
  }

  /** 构造 SyncEngine：按 transport 分支构造对应传输（git → GitTransport；webdav → WebDavTransport）。
   *  同步范围（sections）来自持久化分区选择：advanced 模式 → 只处理勾选分区，
   *  自动同步（merge/apply/push 全链路）与手动 push 共用此配置。
   *  opts.optInSections：本次显式放行的可选分区集合 —— 用户驱动的手动 push/pull 传
   *  「选择里勾的全部可选分区」，自动同步只传 'auto' 档（sessions 绝不悄悄下行/上行）。 */
  /**
   * git 通道的工作副本根（`<dataDir>/sync/work`）——**唯一**决定路径的地方：
   * 同步引擎与「工作副本自检/重建」（issue #79）必须指向同一个目录，否则用户重建了 A 而同步在跑 B。
   */
  const gitWorkDir = join(syncDir, 'work')
  /**
   * 构造 git 通道实例（同步引擎与 issue #79 的工作副本自检/重建共用同一份地址与凭据口径）。
   * token 只经 credentials 端口现取（值永不落盘/日志/回传）。
   */
  const makeGitTransport = (repoUrl: string): GitTransport => new GitTransport({
    repoUrl,
    workDir: gitWorkDir,
    credentials: {
      getToken: async () => {
        const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
        return resolved?.value ?? ''
      },
    },
    msg,
  })

  const makeSyncEngine = (cfg: SyncConfig, engineOpts: { optInSections?: readonly SectionId[] } = {}): SyncEngine => {
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
    } else if (isS3Config(cfg)) {
      // S3 兼容系（s3/oss/cos/minio/kodo 共用同一实现 + 变体表）：AccessKey Secret 只经
      // credentials 端口现取（永不落盘 / 永不出宿主）；endpoint/region 空串由变体模板兜底。
      const provider = cfg.s3.provider
      transport = new S3Transport({
        provider,
        bucket: cfg.s3.bucket,
        accessKeyId: cfg.s3.accessKeyId,
        credentials: {
          getSecretAccessKey: async () => {
            const resolved = await credentials.resolve(credentialRef(cloudSecretRef(provider)))
            return resolved?.value ?? ''
          },
        },
        ...(cfg.s3.endpoint === '' ? {} : { endpoint: cfg.s3.endpoint }),
        ...(cfg.s3.region === '' ? {} : { region: cfg.s3.region }),
        ...(cfg.s3.prefix === undefined ? {} : { prefix: cfg.s3.prefix }),
        ...(cfg.s3.pathStyle === undefined ? {} : { pathStyle: cfg.s3.pathStyle }),
        ...(cfg.s3.dialectId === undefined ? {} : { dialectId: cfg.s3.dialectId }),
        msg,
      })
    } else if (isGistConfig(cfg)) {
      // GitHub Gist：token 只经 credentials 端口现取（只写不回读）
      transport = new GistTransport({
        gistId: cfg.gist.gistId,
        credentials: {
          getToken: async () => {
            const resolved = await credentials.resolve(credentialRef(cloudSecretRef(GIST_PROVIDER)))
            return resolved?.value ?? ''
          },
        },
        ...(cfg.gist.apiBaseUrl === undefined ? {} : { apiBaseUrl: cfg.gist.apiBaseUrl }),
        ...(cfg.gist.filePrefix === undefined ? {} : { filePrefix: cfg.gist.filePrefix }),
        msg,
      })
    } else {
      transport = makeGitTransport(cfg.git.repoUrl)
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
      ...(engineOpts.optInSections === undefined || engineOpts.optInSections.length === 0
        ? {}
        : { optInSections: engineOpts.optInSections }),
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
    // 自动同步只放行 'auto' 档可选分区（当前 = mcp）：sessions（'manual'）绝不悄悄下行/上行。
    // 口径钉在**注入处**而不是调度器内部 —— 调度器只负责「用哪个引擎」，准入由宿主决定。
    makeSyncEngine: (cfg: SyncConfig) => makeSyncEngine(cfg, { optInSections: selectionOptInSections(channelOf(cfg), true) }),
    msg,
    runs,
    mutationLock: host.mutationLock,
    isBlocked: () => host.safeModeIsBlocked?.() ?? false,
    phase3Recovery: host.phase3Recovery,
    // 真·自动同步：本地配置文件监听（realtime 通道）以 $DSH_HOME 为基准；
    // 监听清单由 sync/watch-scope.ts 静态派生，已排除 sessions/ 与调度器自写文件（避免自激）。
    homeDir: host.homeDir,
    ...(host.profile === undefined ? {} : { profile: host.profile }),
    // Phase 6：autosync 既写 sync-history.json（既有语义），也写统一迁移历史（COMPLETE 不变量）。
    appendHistoryFn: async (entry) => {
      await appendAutosyncEntry(syncDir, entry).catch(() => undefined)
      await history.append({
        kind: 'autosync',
        result: entry.status === 'success' ? 'success' : entry.status === 'skipped' ? 'skipped' : 'failed',
        sections: entry.appliedSections ?? [],
        source: 'autosync',
        summary: engineMsg('host.autosyncSummary', {
          direction: entry.direction,
          transportSuffix: entry.transport !== undefined ? engineMsg('host.autosyncTransportSuffix', { transport: entry.transport }) : '',
        }),
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
    // 仅当无其他未解决 incident 时由编排器调用（§5.3 / §10.2；判据为单一实现 resolveSafeMode）。
    clearSafeMode: async () => {
      if (host.phase3Recovery !== undefined) await host.phase3Recovery.clearSafeMode()
    },
    // issue #56：SAFE MODE 阻断态的**动态**探测。必须动态读（不能创建期捕获）：durable 标记由
    // 启动分类阶段落盘，且运行期 mutation gate 用的就是 phase3Recovery.safeModeActive 这个内存标志，
    // 两侧同源才能保证「界面说保护开着 ⟺ 写操作真的被 423 挡着」。
    safeModeBlocked: () => host.phase3Recovery?.safeModeActive === true,
    // issue #31：环境锁只读探测 + 显式回收，供「事故恢复」面板显示/处理**残留锁**。
    // 残留锁不是 journal（journalId 恒 null、transactions/active 为空），旧面板因此恒空。
    inspectLockState: async () => {
      const port = host.mutationLock as EnvironmentLockManager | undefined
      if (port === undefined) return { state: 'FREE' }
      const insp = await port.inspectLockState()
      // ownerInstanceId 只给编排器做 journal↔锁归属匹配（判定「正在跑」vs「残留事故」），
      // 不进任何 HTTP 响应体（编排器只消费不回传）。
      return {
        state: insp.state,
        ...(insp.detail !== undefined ? { detail: insp.detail } : {}),
        ...(insp.ownerInstanceId !== undefined ? { ownerInstanceId: insp.ownerInstanceId } : {}),
      }
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
        // F-4：本机**权威**版本（拉起本宿主的运行时 = profileContext.installAnchor 解析出的 dshVersion）——
        // 与快照记录的来源版本不同时产出一条可见告警动作（不阻断恢复）。
        currentDshVersion: host.dshVersion,
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
      marketDir,
      marketCacheItemDir,
      marketStarCache,
      marketWorkDir,
      meGitHubRest,
      meService,
      meTokenProvider,
      msg,
      prepareSync,
      profileLauncher,
      profileRuntime,
      profiles,
      // F-2：官方 session.export 通道只需要「宿主自己能不能发一次本机请求」与「web 端口」。
      // 后者在 apply() 里 webServer 就绪时才赋值，而本构造发生在它之前 —— 因此这里不能直接
      // 抓 host.webPort 的值（那一刻恒 undefined）。改成读一个**活盒子**：apply() 往盒子里写，
      // 路由表在请求期从同一个盒子取值（见 apply() 的 webServer 就绪段）。
      get sessionExportFetch() { return host.fetch },
      get sessionExportPort(): number | undefined { return host.webPort },
      // T4：会话体检（只读）。宿主侧注入「本机会话库扫描」的依赖来源 —— 路由不许自己读盘。
      sessionHealth: {
        // profileDir/dataDir 不在本作用域（apply() 的局部量），体检只认 homeDir 与两个事实来源
        homeDir: host.homeDir,
        targetFormatVersion: () => host.sessionFormatVersion,
        workspaceKeys: async () => await sessionHealthWorkspaceKeys(host),
        knownSessionIds: async () => await sessionHealthKnownIds(host),
        // T4+：体检行要显示**对话标题**（此前只有 `session-<uuid>` 目录名，认不出哪条是自己的对话）。
        // 标题住在 DSH 自己的会话缓存里，读取口径与导出选择器**同一份实现**（core/session-meta.ts：
        // 只读、mtime 失效缓存、读不到退化成空索引）。这里只把索引交给路由 —— 路由不自己读盘。
        // ids = 本次要展示的会话（单元 id / 目录名都行）：只给这些补标题，逐会话投影文件按需读（不再只吃聚合缓存）
        sessionMeta: async (ids: readonly string[]) => await readSessionMetaWithTitles(host, ids),
      },
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
      selectionOptInSections,
      selectionView,
      selectionViewByChannel,
      snapshotEntrySections,
      snapshotsDir,
      syncCredentialsByChannelView,
      syncDir,
      // issue #79：工作副本自检（只读，挂在 /sync/status）与显式重建（写动作，走 mutation gate）。
      // 路由只传 repoUrl/mode —— 路径、凭据与 git 调用口径都留在宿主这一处。
      syncWorkDir: {
        // 自检失败（git 不可用 / 工作副本异常）→ 返回 { error }，**不让整个状态接口 500**，
        // 也不伪装成「工作副本不存在」。
        inspect: async (repoUrl: string): Promise<{ facts: GitWorkDirFacts } | { error: string }> => {
          try {
            // issue #104 建议 3：`/sync/status` 要回传「领先远端提交数 / 远端快照数」，
            // 用户看不见积压，就会在「以为在备份」的状态下一直失败。detail 多出的几条命令
            // 都是本地只读（rev-list / status / ls-tree），不发网络请求。
            return { facts: await makeGitTransport(repoUrl).inspectWorkDir({ detail: true }) }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
        // 重建：relink 非破坏；adopt 合并远端历史（不改写本地提交，issue #104）；
        // reclone 删目录重克隆（调用方必须先取得用户确认）
        rebuild: async (repoUrl: string, mode: 'relink' | 'adopt' | 'reclone'): Promise<GitWorkDirFacts> => {
          const transport = makeGitTransport(repoUrl)
          await transport.rebuildWorkDir(mode)
          return await transport.inspectWorkDir()
        },
      },
      syncPasswordConfigured,
      syncSectionCatalog,
      // 关于页「立即更新」：用户显式点击后的写动作（官方 dsh plugin 通道，钉住精确版本）。
      // 为什么经 env 注入而不是路由里直接 spawn：路由不持 profileDir/profile，也不该自己起
      // 子进程（与 sessionHealth 同一条纪律：宿主注入依赖来源）。
      selfUpdate: async (targetVersion: string): Promise<SelfUpdateOutcome> => {
        const installedSpec = readProfileManifest(host.profileDir)?.dependencies?.[PLUGIN_NPM_PACKAGE]
        const plan = planSelfUpdate({
          current: PLUGIN_VERSION,
          target: targetVersion,
          profile: host.profile,
          installedSpec,
        })
        if (!plan.ok) return plan
        return await runSelfUpdate(plan, { runner: runDshPlugin, profileDir: host.profileDir, profile: host.profile })
      },
      syncSessions,
      tmpDir,
      tryAppendHistory,
      withMutationGate,
      writeItemCache,
    }
  }

  /**
   * 路由表：本文件只保留被源码级守卫按**文件窗口**钉住的 7 条（host-entry 审计 F-04 记录的
   * tests/host/**、src/core/model-tools.test.ts、src/core/phase1-wiring.test.ts 的窗口断言）。
   * 其余 75 条已按域拆到 src/routes/*.ts，由 buildRoutes 组装。
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
        // 临时明文 ZIP 的路径必须在 try **之外**声明：失败分支也要能清理（见 finally）。
        const plainZipPath = join(tmpDir, `export-plain-${randomBytes(4).toString('hex')}.zip`)
        try {
          // 先由 Exporter 产出标准明文 ZIP（含 manifest/checksums；若 includeSecrets 需要
          // 加密提供者来生成 secrets.enc —— 整体容器的外层加密再保护整个文件）。core 不感知外层容器。
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
            // 原子落盘：直接 writeFile 中途失败会留下一个**名字正常**的半截 .zip（会出现在产物库里）。
            // 临时明文 ZIP 的清理统一由 finally 负责（成功 / 失败都清）。
            await atomicWriteFile(outPath, blob)
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
        } finally {
          // 明文临时 ZIP 必须在这里清：失败分支（加密失败 / 磁盘满 / 超时）此前**不清理**，
          // 含全部非敏感配置的明文会留在 <dataDir>/tmp 直到 24h 缓存清理 —— 与「磁盘不残留明文备份」
          // 的承诺不符。成功路径已 rename 或已原子写入，这里对不存在的路径是 no-op（force: true）。
          await fs.rm(plainZipPath, { force: true }).catch(() => undefined)
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
              // includeSecrets=false：与真实导出同口径（值剥离），只统计不落盘。
              // 分区实现了 preview() 时走它：选择器只要「单元 / 条目数 / 体积」，不需要文件内容
              // —— 实测本机会话树 941 个文件 / 528 MB，走 export() 要 2.27 s、+306 MiB 常驻。
              const summary = adapter.preview !== undefined
                ? await adapter.preview(host, { includeSecrets: false })
                : undefined
              const section = summary?.section ?? await adapter.export(host, { includeSecrets: false })
              // 文件类分区：大小按文件字节合计；JSON 分区：stringify 估算
              let size = summary?.sizeBytes ?? 0
              if (summary === undefined) {
                if (isFileSection(adapter.id)) {
                  const files = (section.data as { files?: { data: Uint8Array }[] }).files ?? []
                  size = files.reduce((acc, f) => acc + f.data.length, 0)
                } else {
                  size = Buffer.byteLength(stringifyJsonSafe(section.data), 'utf8')
                }
              }
              const count = section.counts ? Object.values(section.counts).reduce((a, b) => a + b, 0) : 0
              // Phase 1：可单独勾选的单元。listUnits 是**零 I/O** 纯函数（输入即本次 export 的产物），
              // 因此枚举明细不额外读盘；未实现 listUnits 的分区 items = [] = 不可细分（整体开关）。
              // preview() 的 items 与 listUnits 同口径，但体积来自 stat（不读内容）。
              let items: ExportUnit[] = summary?.items ?? []
              if (summary === undefined) {
                try {
                  items = adapter.listUnits?.(section) ?? []
                } catch {
                  // 单元枚举失败不拖垮预览：退化为「不可细分」，用户仍可整分区导出
                  items = []
                }
              }
              // sessions：单元级活跃时间（会话日志 mtime）—— 元数据缓存没覆盖的会话靠它排序
              if (adapter.id === 'sessions' && items.length > 0 && adapter.unitActivityTimes !== undefined) {
                try {
                  // 预览本趟已 stat 过（statInfo 同时给体积与 mtime）→ 把时间顺带传下去，
                  // 省掉第二趟逐文件 stat；旧宿主没有 statTimes 时退回原有逐文件 mtimeMs。
                  sessionActivityTimes = await adapter.unitActivityTimes(host, section, summary?.statTimes)
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
              // 标题要**尽量全**（用户 2026-10-12：始终用对话标题，而不是只取聚合缓存里的）：
              // 聚合缓存缺的那些按需读逐会话投影文件（只读、定向、mtime 缓存）
              sessionsEntry.items = applySessionMeta(
                sessionsEntry.items,
                await readSessionMetaWithTitles(host, sessionsEntry.items.map((u) => u.id)),
                'sessions',
                sessionActivityTimes,
              )
            } catch {
              /* 保持目录名（旧行为） */
            }
            // 子代理会话标出「父对话」：选择器据此做「勾父带子 / 勾子带父」联动。宿主不下发这份关系，
            // 界面就无从联动（用户实测：勾 2 条、包里 41 条）。尽力而为：读不到就不标（预览照常）。
            const facade = host.sessions
            if (facade?.parentRelations !== undefined) {
              try {
                sessionsEntry.items = applySessionParentLinks(sessionsEntry.items, subagentParentMap(await facade.parentRelations()))
              } catch (err) {
                // T8-F2：行为不变（不标父对话、不猜、预览绝不打挂），但**必须记 warn**：
                // 否则「选择器勾父带子静默不联动」对用户完全不可见（正是 F-1 想消除的那种失败形态）。
                host.log.warn(msgOf(host)('host.parentRelationsUnavailable', { reason: errorMessage(err) }), {
                  code: 'parent-relations-unavailable',
                  source: 'exportPreview',
                })
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
        // 防御纵深（issue #55）：整体加密容器必须先经 /decrypt-archive 解锁再分析。
        // 正常客户端到不了这里（备份文件列表带 containerType，向导会先进解锁阶段）；
        // 但「按宿主路径直进分析」的入口（查看 / 对比、旧客户端、脚本）必须得到一句
        // 可行动的话，而不是 ZIP 解析器的「缺少中央目录结束记录」（会把用户引向「备份坏了」）。
        if ((await readContainerKind(zipPath)) === 'encrypted') {
          writeJson(res, 400, { error: msg('import.encryptedContainerNeedsUnlock'), code: ENCRYPTED_CONTAINER_CODE })
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
        // 防御纵深（issue #55，与 /analyze、/execute 同一道闸门）：加密容器未解锁不得生成计划，
        // 否则会以「ZIP 损坏」的形态暴露给用户。
        if ((await readContainerKind(zipPath)) === 'encrypted') {
          writeJson(res, 400, { error: msg('import.encryptedContainerNeedsUnlock'), code: ENCRYPTED_CONTAINER_CODE })
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
          // T1：abort 处置下「本机读不了的会话」在**计划阶段**就阻断（零写入，HTTP 409 +
          // code=sessionFormatUnsupported）。放在补会话标题之前：阻断态既不需要标题，
          // 也不该为一个注定被拒的计划多读一次 storages。
          const disposition = await resolveDisposition(body?.['sessionFormatDisposition'])
          const blocked = dispositionAbort(plan, disposition)
          if (blocked !== null) {
            writeJson(res, 409, blocked)
            return
          }
          // sessions 计划项：补「会话标题 + 工作区分组」（用户实测：导入页此前只显示会话目录名）。
          // 只在计划真的含该分区时才读 storages；读不到就保持目录名，绝不让计划生成失败。
          if (plan.items.some((i) => i.adapter === 'sessions')) {
            try {
              plan.items = applySessionMetaToPlanItems(
                plan.items,
                await readSessionMetaWithTitles(host, plan.items.filter((item) => item.adapter === 'sessions').map((item) => item.unitId ?? item.id)),
              )
            } catch {
              /* 保持目录名（旧行为） */
            }
          }
          writeJson(res, 200, plan)
        } catch (error) {
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
    }),
    // 崩溃归因（P0-5）：只读。上次启动是否异常 + 归因 + 建议动作。
    // 「最后正常快照 + 一键回退」随灾备快照库一起下线（定位收敛为迁移/同步/市场）：
    // 崩溃后的处置入口 = 事故恢复页的救援模式 + 备份页从最近备份恢复，不自建第二条恢复通道。
    endpoint({ path: API.crash, methods: ['GET'] }, async (req, res) => {
        try {
          const bootStateDir = join(dataDir, BOOT_STATE_DIR_NAME)
          await adoptLegacyBootState(join(dataDir, LEGACY_BOOT_STATE_DIR_NAME), bootStateDir)
          const prev = await readBootState(bootStateDir)
          const alert = computeBootAlert(prev, null)
          writeJson(res, 200, {
            crashed: alert.crashed,
            crashReason: alert.crashReason,
            lastGoodAt: alert.lastGoodAt,
            advice: adviceFor(alert.crashReason, alert.crashed),
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
        const homeDir = host.homeDir
        const profile = host.profile ?? 'web'
        try {
          if (req.method === 'GET') {
            const status = await rescueModeStatus({ homeDir, profile })
            // applied = 本进程的启动时刻晚于进入救援的时刻（= 用户已经重启过，救援真的生效了）。
            // 界面据此换文案：没重启时是「请重启 DSH 使其生效」，重启后不该再要求重启（真机反馈）。
            const applied = status.state !== null
              && rescueAppliedInThisProcess(status.state.enteredAt, Date.now() - Math.round(process.uptime() * 1000))
            writeJson(res, 200, {
              active: status.active, stale: status.stale, enteredAt: status.state?.enteredAt ?? null, applied,
            })
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
  return { routes: routesList, scheduler, makeSyncEngine, profileRuntime: routeEnv.profileRuntime }
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
  /**
   * issue #88 / #89：回合自动留点（回滚点）**缺省关闭**。
   *
   * 同步读一次偏好（几百字节），因为「关闭」必须在**注册 `session/event` 订阅之前**就定下来 ——
   * 晚一步注册就等于「订阅了什么都做」（见 src/core/rollback-gate.ts 的三条设计）。
   * 关闭后本进程不再留点、不再写台账；台账与回退路由本身仍可用（已有回滚点仍能查看 / 回退 / 清理）。
   */
  setRollbackEnabled(readRollbackEnabledSync(syncDir))
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
  // 崩溃归因的观测文件目录。独立于任何快照库：boot-state 曾寄生在
  // <dataDir>/config-snapshots/（灾备快照库目录），灾备线收敛下线后搬到独立目录；
  // 老用户那份状态由 adoptLegacyBootState 一次性搬迁（幂等、best-effort）。
  const bootStateDir = join(dataDir, 'boot-state')
  const legacyBootStateDir = join(dataDir, 'config-snapshots')
  const bootBegin = async (): Promise<void> => {
    try {
      // 老位置（灾备快照库目录）里的状态搬过来，避免换目录丢掉「上次是否正常」。
      await adoptLegacyBootState(legacyBootStateDir, bootStateDir)
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
  void bootBegin()
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })
  mkdirSync(marketDir, { recursive: true })
  mkdirSync(historyDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config, ctx))
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
      // issue #87：分类结论才是本轮权威。NORMAL 且没有活锁者 ⇒ 上一轮留下的 durable SAFE MODE 是**陈旧标记**
      // （没有任何未决 journal 能解释它），必须连内存标志一起复位：只复位内存会让本会话写操作继续被 423 挡着
      // （界面却说「无待处理事项」），只复位标记又会在下一次 probe 时重新置起（标记跨重启生效）。
      const safeModeVerdict = resolveStartupSafeMode({
        kind: state.kind,
        lockState: mapLockStateForStartup(lockInsp.state),
        currentlyBlocked: phase3Recovery.safeModeActive,
      })
      phase3Recovery.safeModeActive = safeModeVerdict.blocked
      if (safeModeVerdict.clearStaleMarker) {
        await phase3Recovery.clearSafeMode().catch(() => undefined)
        host.log.info('Phase 3 启动分类 NORMAL：上一轮遗留的 SAFE MODE 标记已复位（无未决事务、无活锁者）')
      }
      shouldStartSchedulers = (state.kind === 'NORMAL')
      if (state.kind === 'RECOVERY_REQUIRED' || state.kind === 'NEEDS_ATTENTION') {
        host.log.warn(`Phase 3 ${state.kind}：上次 destructive operation 崩溃残留，需显式恢复；destructive 调度器未启动（read-only host 存活）`)
      } else if (shouldStartSchedulers && schedulerGate.start !== null) {
        schedulerGate.start()
      }
      // Phase 1 P0-5：启动分类已得出结论 → 本次启动判定为成功（推进 lastGoodAt）。
      // 灾备总开关关闭时不写 boot-state。
      try {
        await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
      } catch (error) {
        host.log.warn('boot-state 标记成功失败', { error: error instanceof Error ? error.message : String(error) })
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
      try {
        await writeBootState(bootStateDir, markBootOk((await readBootState(bootStateDir)) ?? beginBoot(process.pid, null)))
      } catch { /* best-effort */ }
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
  // 本实例的 web 端口在 webServer 就绪前未知（心跳先报 null，就绪后再报一次）。
  const webPort: { value: number | null } = { value: null }
  const { routes, scheduler, makeSyncEngine, profileRuntime } = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs,
    syncDir,
    marketDir,
    dataDir,
    runtimePort: () => webPort.value,
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
  }
  // 若启动分类已在此构造完成前解析为 NORMAL（罕见竞态），立即补启动。
  if (startupStateResolved && shouldStartSchedulers && schedulerGate.start !== null) { schedulerGate.start(); }
  ctx.effect(() => () => backupScheduler.stop(), 'config-manager: backup scheduler')
  // 自动同步调度器随插件生命周期停止：插件重载/卸载时清理定时器，
  // 避免旧调度器残留导致重复后台同步。
  ctx.effect(() => () => scheduler.stop(), 'config-manager: autosync scheduler')
  // m-profiles：实例心跳（自报 + 定期刷新）；dispose 时撤回自己的心跳文件，别让别人把死实例当成活的。
  ctx.effect(() => {
    const stopHeartbeat = profileRuntime.startHeartbeat()
    return () => {
      stopHeartbeat()
      profileRuntime.withdraw()
    }
  }, 'config-manager: profile runtime heartbeat')
  // ------------------------------------------- S1：回合自动留点（宿主真接线）
  //
  // 订阅 `session/event`（@deepseek-ai/dsh-session 的 post-commit fire-and-forget feed）。
  // **留点在 `turn/start` 拍**（点的「工作区态」必须是该回合开始**之前**的样子 —— 这条口径不能动，
  // 见 rollback-point.ts RollbackAutoTracker.noteEvent）；`turn/end` 只更新「缺省边界」，不再拍点。
  // 没有手动「拍点」入口 —— 留点完全由回合驱动。
  //
  // 纪律（AGENTS.md 铁律 + captain 要求）：**订阅与每个回调都 try/catch 包裹**，任何异常
  // 只记 warn：改坏宿主启动 = blocker。事件回调用一条串行链喂给留点器，保证同一会话的
  // turn/start 与 turn/end **按到达顺序**处理（留点本身是异步 IO）。
  // fork 端口用**结构性窄化**读取：`SessionStoreFacade`（src/core/types.ts）不在本任务 scope 内，
  // 不为了这一处调用去改公共接口；端口上确实有 forkSession（DshSessionStoreFacade 实现）才走
  // 真 fork，否则如实结构化 `session-fork-unavailable`（绝不静默降级）。
  const forkPort = host.sessions as unknown as RollbackForkCarrier
  // 写入归属台账（2026-10-17 定案 B）：只记「哪个会话的哪次**写类**工具调用写了哪个路径」。
  // 惰性读盘 + best-effort 落盘：读不到 / 写不进只让归属退化成「未判定」——
  // 既不影响留点与回退，也绝不会把「不知道」当成「别的会话写的」（见 rollback-attribution.ts）。
  const rollbackAttribution = new RollbackWriteAttribution({
    file: path.join(dataDir, ROLLBACK_POINTS_DIR_NAME, ROLLBACK_ATTRIBUTION_FILE_NAME),
    warn: (line) => host.log.warn(line),
  })
  void rollbackAttribution.load()
  // 会话活跃时间窗（2026-10-18）：**每个 session/event 都记一次**活跃 —— 与工具参数无关，
  // 因此 bash / 脚本 / 外部编辑器写出的路径也能按「文件 mtime 落在谁的活跃窗口内」判定归属；
  // 落在**谁都不活跃**的时刻 = 手改 / 外部工具 ⇒ 回退零写入并如实报 unclaimed（绝不静默覆盖）。
  // 同样是 best-effort：读写失败只 warn，退化成「没有时间证据」（回退行为与加它之前逐字一致）。
  const rollbackActivity = new RollbackSessionActivity({
    file: path.join(dataDir, ROLLBACK_POINTS_DIR_NAME, ROLLBACK_ACTIVITY_FILE_NAME),
    warn: (line) => host.log.warn(line),
  })
  void rollbackActivity.load()
  const rollbackEngine = new RollbackPointEngine({
    dataDir,
    homeDir,
    log: (line) => host.log.warn(line),
    attribution: rollbackAttribution,
    activity: rollbackActivity,
    fork: async ({ sessionId, boundarySeq }) => {
      const forkSession = forkPort.forkSession
      if (typeof forkSession !== 'function') {
        return { ok: false as const, code: 'session-fork-unavailable' as const, detail: 'facade has no forkSession' }
      }
      const result = await forkSession.call(forkPort, sessionId, boundarySeq)
      // 形状加固：`in` 对 null / 原始值会抛 TypeError —— 端口漂移时应当是**结构化失败**，
      // 而不是一个没人接的异常（宿主版本换形状时这条最先生效）。
      if (result !== null && typeof result === 'object' && 'childSessionId' in result) {
        // warning 一路带到回退结果（引擎落成 rollback.guidance.sessionNotAttached）：
        // 归位失败**不静默** —— 会话确实回退了，但它会出现在侧栏「未分组」。
        return result.warning !== undefined
          ? { ok: true as const, childSessionId: result.childSessionId, warning: result.warning }
          : { ok: true as const, childSessionId: result.childSessionId }
      }
      return { ok: false as const, code: 'fork-failed' as const, detail: result.error }
    },
  })
  const rollbackTracker = new RollbackAutoTracker({
    engine: rollbackEngine,
    log: (line) => host.log.warn(line),
    attribution: rollbackAttribution,
    activity: rollbackActivity,
  })
  ctx.effect(() => {
    let chain: Promise<unknown> = Promise.resolve()
    // 「会话没有 cwd」这类**形状合法但信息不全**的情况只记一次日志（避免每回合刷屏）；
    // 该点本身仍带 incomplete=true + workspace.reasonCode='no-chunks'，界面能如实展示。
    const chunklessLogged = new Set<string>()
    /** 子代理会话只 warn 一次（见下面 'subagent-session' 分支） */
    const inertSessionsLogged = new Set<string>()
    const listener = (session: unknown, event: unknown): void => {
      // issue #88/#89 第一道门：关闭时回调什么都不做。正常路径下关闭时压根没有订阅
      //（detach 已解绑），这里是「解绑与已派发事件之间」的竞态兜底。
      if (!isRollbackEnabled()) return
      try {
        const bindingResult = rollbackSessionBindingOf(session)
        if (!bindingResult.ok) {
          if (bindingResult.code === 'subagent-session') {
            // 子代理会话按设计不留点：**每个会话只记一次**（否则每个事件刷一行 warn），
            // 但仍然留痕 —— 不让「这个会话为什么没有点」变成无解释的沉默。
            if (!inertSessionsLogged.has(bindingResult.detail)) {
              inertSessionsLogged.add(bindingResult.detail)
              host.log.warn('rollback auto point skipped: ' + bindingResult.code + ' ' + bindingResult.detail)
            }
            return
          }
          // 形状不匹配**不静默**：给显式机器码，宿主日志留痕
          host.log.warn('rollback auto point skipped: ' + bindingResult.code + ' ' + bindingResult.detail)
          return
        }
        const binding = bindingResult.binding
        if (bindingResult.chunkless !== null && !chunklessLogged.has(binding.sessionId)) {
          chunklessLogged.add(binding.sessionId)
          host.log.warn('rollback auto point: session ' + binding.sessionId + ' ' + bindingResult.chunkless + ' → 该点只留会话态（incomplete）')
        }
        const eventResult = rollbackTrackedEventOf(binding.sessionId, event)
        if (!eventResult.ok) {
          host.log.warn('rollback auto point skipped: ' + eventResult.code + ' ' + eventResult.detail)
          return
        }
        rollbackTracker.registerSession(binding)
        const tracked = eventResult.event
        chain = chain.then(async () => { await rollbackTracker.noteEvent(tracked) }).catch((error: unknown) => {
          host.log.warn('rollback auto point failed: ' + (error instanceof Error ? error.message : String(error)))
        })
      } catch (error) {
        host.log.warn('rollback auto point listener failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    let off: (() => boolean) | null = null
    /**
     * 订阅 / 解绑成对：开关关闭时**真的解绑**（不是「订阅了什么都不做」—— issue #88 明确要求
     * 「关闭后不再订阅 session/event」）。attach 幂等；订阅抛错只丢这一个入口，不打断宿主启动。
     */
    const attach = (): void => {
      if (off !== null) return
      try {
        off = ctx.on('session/event', listener)
      } catch (error) {
        off = null
        host.log.warn('rollback auto point subscribe failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    const detach = (): void => {
      const current = off
      off = null
      if (current === null) return
      try { current() } catch { /* 解绑失败不影响卸载 */ }
    }
    if (isRollbackEnabled()) attach()
    // 活切换：写偏好的一方改开关，这里即时 attach / detach。事件回调**不读文件** ——
    // 每回合读一次磁盘正是本 issue 要消灭的开销形态。
    const unlisten = onRollbackEnabledChange((on) => { if (on) attach(); else detach() })
    return () => {
      unlisten()
      detach()
      rollbackTracker.stop()
      // 卸载时把**未落盘**的活跃窗口刷下去（debounce 里可能还有几条）：丢了它，
      // 下次启动就少一段「谁在什么时候活跃」的证据 —— 归属会因此退回「未判定」。
      void rollbackActivity.dispose()
    }
  }, 'config-manager: rollback auto points')
  // ------------------------------------------- 宿主斜杠命令 /rollback（t3）
  //
  // 与 HTTP 路由 /recovery/rollback-points/<id>/rewind **同源的那道写入门**：
  //   runWithMutationLock（= SAFE MODE 门 + 跨进程/跨 kind 环境锁）→ 引擎 preview（零写入）→ 引擎 rewind。
  // 顺序与路由**逐条一致**（预检在锁内、一切拒绝都发生在写入之前）；引擎回 confirmation-required /
  // protected-point / record-incomplete 时命令只回可读错误结果，**绝不绕过**（preview 已把
  // protected / incomplete 提前拦下，这里再挡一次 API 误用）。
  //
  // 命令服务**惰取**（调用期 ctx.get('commands')，绝不属性访问、绝不进 inject）+ 注册失败只 warn：
  // 未组合 commands 的部署照常启动。注册点在 webServer 早退**之前** —— 没有 web 端的部署一样能用 /rollback。
  const commandHost: RollbackCommandHost = {
    // 会话事实只服务于「列出本会话的点」：回退的写入面由回退点自己的记录决定，不在这里临时指定。
    agentSession: agentSessionFactsOf,
    // 只读列表：引擎的 RollbackListResult 天然满足命令层的子集形状（storage/points/error）。
    list: (sessionId) => rollbackEngine.list(),
    rewind: async ({ id }) => {
      // 与路由同一 op 名（审计/锁归属可对照）；target = 目标点 id。
      // ⚠️ 这道门必须与 HTTP 路由同源：runWithMutationLock(host.mutationLock, {op:'rollback-rewind'}, …)。
      // 绕过它 = 绕过 SAFE MODE 与环境锁（本文件的 route-fence/parity 守卫之外没有第二道兜底）。
      return await runWithMutationLock(
        host.mutationLock,
        { op: 'rollback-rewind', target: id, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
        async () => {
          // ① 预检（零写入）：先拦住 protected / incomplete / 存储缺失，再动任何字节。
          const preview = await rollbackEngine.preview(id)
          if (!preview.ok || !preview.canRestore) {
            return {
              ok: false,
              outcome: 'denied',
              code: preview.code,
              id,
              ...(preview.detail !== undefined ? { detail: preview.detail } : {}),
              segments: [],
              skippedSegments: [],
              storage: preview.storage,
              guidance: preview.guidance,
              warnings: preview.warnings,
            } satisfies RollbackRewindResult
          }
          // ①b 与 HTTP 路径**同一道**「运行中对话」门：命令由会话循环派发、日志刚被 append，
          //     `session.active` 通常为真；缺这道门就会出现「HTTP 会 409 拒绝的『运行中改工作区』
          //     被命令入口放行」—— 写回的文件随即被运行中的步骤覆盖（撕裂态）。
          if (preview.session.active === true && sessionActiveGateApplies(preview, true, host.safeModeIsBlocked?.() ?? false)) {
            return sessionActiveDenied(id, preview)
          }
          // ② 真执行：userConfirmed **恒 true** —— 用户敲下 /rollback <id> 就是那次确认
          //    （命令入口没有第二个确认按钮；其余门全量生效）。
          return await rollbackEngine.rewind({
            id,
            userConfirmed: true,
            removeCreated: true,
          })
        },
      )
    },
  }
  try {
    const disposeRollbackCommand = registerRollbackCommand({
      readCommands: () => readService<CommandServiceLike>(ctx, 'commands'),
      deps: { host: commandHost, mutationLock: host.mutationLock, isBlocked: () => host.safeModeIsBlocked?.() ?? false },
      log: host.log,
    })
    ctx.effect(() => () => disposeRollbackCommand(), 'config-manager: /rollback command')
  } catch (error) {
    host.log.warn('register /rollback failed: ' + (error instanceof Error ? error.message : String(error)))
  }
  const webServer = readService<WebServer>(ctx, 'webServer')
  if (webServer === undefined) {
    host.log.warn('webServer 服务不可用：跳过 /api/dsh-config-manager 路由注册（引擎能力仍可用）')
    return
  }
  // 端口就绪 → 重新自报一次心跳（其它实例的「运行中」徽章与端口信息靠它；token 永不落盘）。
  webPort.value = webServer.port
  // F-2：宿主自请求走这个端口（探测/代理 DSH 自己的 /api/session.export）——
  // 必须在注册路由**之前**赋值，否则首次探测拿到 undefined 会如实降级成「拿不到状态码」。
  // 注：本插件是 bundle 包、宿主半没有热重载，端口变化只有重启一次才可能发生。
  // routeEnv 的 sessionExportPort 是**活 getter**（读 host.webPort），因此这里赋值对已构造好的
  // 路由表同样生效 —— 不需要重建路由。
  host.webPort = webServer.port
  profileRuntime.announce()
  ctx.effect(() => {
    const disposers = registerRoutes(webServer, routes)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'config-manager: routes')
}
