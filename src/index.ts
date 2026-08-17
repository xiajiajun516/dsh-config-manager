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
import { createEncryptionProvider, decryptCredentials } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
import { GitTransport } from './sync/git/git-transport.ts'
import { DeviceFlowStore, GitHubAuthClient } from './sync/github-auth.ts'
import { SyncEngine } from './sync/sync-engine.ts'
import type { ApplyItemsReport } from './sync/sync-engine.ts'
import { SyncSessionStore } from './sync/sync-session.ts'
import { AutoSyncScheduler } from './sync/autosync-scheduler.ts'
import { defaultAutosyncConfig, readAutosyncConfig, writeAutosyncConfig } from './sync/autosync-config.ts'
import type { AutosyncInterval, AutosyncRunStatus } from './sync/autosync-config.ts'
import { appendAutosyncEntry, readSyncHistory } from './sync/sync-history.ts'
import { loadSyncState, saveSyncState } from './sync/sync-state.ts'
import { readSyncConfig, writeSyncConfig, validateRepoUrl } from './sync/sync-config.ts'
import { MANIFEST_FILE, parseManifest } from './schema/manifest.ts'
import { SECTION_IDS } from './schema/config.ts'
import type { Manifest, SectionId, WorkspaceRecord } from './schema/types.ts'
import { parseZip } from './utils/zip.ts'
import { isSameOrChild, normalizePath } from './utils/paths.ts'
import { createLogger, type Logger } from './utils/logger.ts'

/* ---------------------------------------------------------------- identity */

/** Stable cordis plugin name — must match the cordis.patch.yml row id. */
export const name = 'config-manager'

/** Services required before the engine can mount (present in every profile). */
export const inject = ['settings', 'credentials']

/** Plugin version, kept in sync with package.json ("version"). */
const PLUGIN_VERSION = '0.1.24'

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
  // P2：同步历史 / 自动应用 / 一键回滚
  syncHistory: '/api/dsh-config-manager/sync/history',
  syncRollback: '/api/dsh-config-manager/sync/rollback',
  // m-sync-v2：一键同步（差异确认会话）+ 自动同步 + 历史快照
  syncSnapshotsList: '/api/dsh-config-manager/sync/snapshots-list',
  syncSync: '/api/dsh-config-manager/sync/sync',
  syncApplyItems: '/api/dsh-config-manager/sync/apply-items',
  syncCancel: '/api/dsh-config-manager/sync/cancel',
  syncAutosync: '/api/dsh-config-manager/sync/autosync',
} as const

/**
 * 同步 token 的 DSH credentials 引用名（POSIX env-var 形态，满足 CredentialRef 品牌要求）。
 * token 只经 credentialRef 读写（写入由请求体触发，读取在每次 git 网络操作时 resolve），
 * 永不进 repoUrl / argv / commit / 同步文件 / 日志。
 */
const SYNC_CREDENTIAL_REF = 'DSH_CONFIG_MANAGER_SYNC_TOKEN'

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

/** 需要人工决策的 PlanItemKind（一键同步 needsReview 判定 + 逐项确认标记） */
const REVIEW_KINDS: ReadonlySet<PlanItemKind> = new Set([
  'Conflict', 'MissingSecret', 'MissingDependency', 'Install', 'Error', 'PathMapping',
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
async function buildAutosyncStatus(dir: string): Promise<AutosyncStatusResponse> {
  const cfg = await readAutosyncConfig(dir)
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

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): WebRoute[] {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir, runs, syncDir, credentials, githubClientId, githubClientSecret } = deps
  const roots = [exportsDir, tmpDir]

  /** m-github-oauth：宿主侧设备码登记表 + auth 客户端（进程生命周期；device_code 只存内存） */
  const githubFlows = new DeviceFlowStore()
  const githubAuth = new GitHubAuthClient()
  const msg = host.msg

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
  // 请求级装配：每次 push/pull 从请求体取 repoUrl/gitBin，token 非空先写入 DSH
  // credentials（只存值不落盘同步文件/日志），git 网络操作时经 resolve 现取 ——
  // 与 GitTransport「token 只从注入 provider 读取」的安全契约完全对齐。

  /** 解析同步请求体（repoUrl 必填；token 非空则先写入 DSH credentials）。 */
  const prepareSync = async (body: Record<string, unknown>): Promise<{ repoUrl: string; gitBin?: string }> => {
    const repoUrl = typeof body['repoUrl'] === 'string' ? body['repoUrl'].trim() : ''
    if (repoUrl === '') throw new SyncRouteError('repoUrl is required')
    const urlError = validateRepoUrl(repoUrl)
    if (urlError !== null) throw new SyncRouteError(urlError)
    const gitBin = typeof body['gitBin'] === 'string' && body['gitBin'] !== '' ? body['gitBin'] : undefined
    const token = typeof body['token'] === 'string' && body['token'] !== '' ? body['token'] : undefined
    if (token !== undefined) {
      try {
        await credentials.set(credentialRef(SYNC_CREDENTIAL_REF), token)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new SyncRouteError(
          `token 写入 DSH credentials 失败：${reason}（请在 DSH 凭据管理里配置 ${SYNC_CREDENTIAL_REF} 后重试）`,
        )
      }
    }
    return { repoUrl, gitBin }
  }

  /** 构造 SyncEngine（Git 私有仓库通道 + 散文件快照目录 + pull 用 Importer）。 */
  const makeSyncEngine = (repoUrl: string, gitBin: string | undefined): SyncEngine => {
    const transport = new GitTransport({
      repoUrl,
      workDir: join(syncDir, 'work'),
      credentials: {
        getToken: async () => {
          const resolved = await credentials.resolve(credentialRef(SYNC_CREDENTIAL_REF))
          return resolved?.value ?? ''
        },
      },
      gitBin,
      msg,
    })
    return new SyncEngine({
      ctx: host,
      transport,
      stateDir: syncDir,
      adapters,
      importer: makeImporter(),
      localSnapshotsDir: join(syncDir, 'snapshots'),
      zipDir: tmpDir,
      msg,
    });
  }

  /** 一键同步差异确认会话存储（进程内存；/sync/sync 预览 → /sync/apply-items 逐项执行解耦） */
  const syncSessions = new SyncSessionStore()

  /** 自动同步后台调度器（宿主进程生命周期，不依赖浏览器） */
  let scheduler: AutoSyncScheduler | undefined
  scheduler = new AutoSyncScheduler({
    syncDir,
    host,
    makeSyncEngine,
    msg,
    runs,
  })
  // 启动：读 autosync-config；若 enabled 启动定时器；无条件执行一次「启动触发下载合并」（受阈值约束）
  scheduler.start()

  return [
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
          const exporter = new Exporter({
            ctx: host,
            adapters,
            encryption: includeSecrets && password !== undefined ? createEncryptionProvider(password) : null,
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
            exporter.export({ includeSecrets, only, outPath }),
            ROUTE_TIMEOUT_MS,
            msg('host.exportTimeout'),
          )
          // 结束写结果：完成结果落账（供 /progress 查询与刷新恢复后下载）
          runs.finish(runId, { zipPath: result.zipPath, manifest: result.manifest, report: result.report })
          writeJson(res, 200, { zipPath: result.zipPath, manifest: result.manifest, report: result.report, runId })
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
          writeJson(res, 200, { zipPath: tmp, name, sizeBytes })
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
        // decryptPassword is an optional Host extension (the browser contract
        // only carries secretInputs); used to open an encrypted backup.
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
          const decryptedCredentials = await tryDecryptCredentials(zipPath, decryptPassword)
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
    // m-sync-ui：同步状态（仓库配置 / 凭据状态 / 上次同步 / 分区数）。只读，无 secret 值。
    {
      kind: 'exact',
      path: API.syncStatus,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        try {
          const [cfg, state, cred] = await Promise.all([
            readSyncConfig(syncDir),
            loadSyncState(syncDir),
            credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
          ])
          writeJson(res, 200, {
            ok: true,
            configured: cfg !== null,
            repoUrl: cfg?.repoUrl,
            gitBin: cfg?.gitBin,
            credentialConfigured: cred.configured,
            credentialWritable: cred.writable === true,
            lastSyncAt: state.lastSyncAt === '' ? undefined : state.lastSyncAt,
            sectionCount: Object.keys(state.sections).length,
            transport: state.transport,
            autosync: await buildAutosyncStatus(syncDir),
          })
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    // ------------------------------------------------------ sync/push
    // m-sync-ui：推送（导出 portable 分区 → 提交私有仓库 → 更新 sync-state）。
    // token 可选：非空先写入 DSH credentials；成功则记忆仓库配置（回填表单用）。
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
          const { repoUrl, gitBin } = await prepareSync(body)
          const engine = makeSyncEngine(repoUrl, gitBin)
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const report = await withTimeout(
            engine.push(snapshotId === undefined ? {} : { snapshotId }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPushTimeout'),
          )
          await writeSyncConfig(syncDir, { repoUrl, gitBin })
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
          const { repoUrl, gitBin } = await prepareSync(body)
          const engine = makeSyncEngine(repoUrl, gitBin)
          const strategy =
            body['strategy'] === 'replace' || body['strategy'] === 'skipExisting' ? body['strategy'] : 'merge'
          const snapshotId =
            typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const report = await withTimeout(
            engine.pull({ strategy, ...(snapshotId === undefined ? {} : { snapshotId }) }),
            ROUTE_TIMEOUT_MS,
            msg('host.syncPullTimeout'),
          )
          await writeSyncConfig(syncDir, { repoUrl, gitBin })
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
          const rows: Array<{ id: string; createdAt: string; sectionCount: number; reviewCount: number }> = []
          for (const name of entries) {
            const dir = join(localDir, name)
            const stat = await fs.stat(dir).catch(() => null)
            if (!stat?.isDirectory()) continue
            const manifestPath = join(dir, 'manifest.json')
            const raw = await fs.readFile(manifestPath, 'utf8').catch(() => null)
            if (raw === null) continue
            try {
              const m = JSON.parse(raw) as { id?: unknown; createdAt?: unknown; sectionHashes?: unknown }
              if (typeof m.id !== 'string' || typeof m.createdAt !== 'string') continue
              const sectionCount = m.sectionHashes && typeof m.sectionHashes === 'object'
                ? Object.keys(m.sectionHashes as Record<string, unknown>).length
                : 0
              rows.push({ id: m.id, createdAt: m.createdAt, sectionCount, reviewCount: 0 })
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
          const { repoUrl, gitBin } = await prepareSync(body)
          const engine = makeSyncEngine(repoUrl, gitBin)
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
          const { repoUrl, gitBin } = await prepareSync(body)
          const engine = makeSyncEngine(repoUrl, gitBin)
          const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
          const preview = await withTimeout(
            engine.preview(snapshotId === undefined ? {} : { snapshotId }),
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
            repoUrl,
            gitBin,
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
            engine = makeSyncEngine(session.repoUrl, session.gitBin)
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
    // m-sync-v2：自动同步配置读写（总开关 + 间隔 + 启动阈值 + 状态）。
    // GET = 读状态；POST = 写配置。同一路径注册为一个 exact 路由（方法内部分发），
    // 避免 webserver 对重复 exact 路径报错。
    {
      kind: 'exact',
      path: API.syncAutosync,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!guard(req, res, 'GET')) return
          try {
            writeJson(res, 200, await buildAutosyncStatus(syncDir))
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
          const cfg = await readAutosyncConfig(syncDir)
          if (typeof body['enabled'] === 'boolean') cfg.enabled = body['enabled']
          if (typeof body['interval'] === 'string' && isAutosyncInterval(body['interval'])) cfg.interval = body['interval']
          if (typeof body['startupMinIntervalMs'] === 'number' && Number.isFinite(body['startupMinIntervalMs']) && body['startupMinIntervalMs'] > 0) {
            cfg.startupMinIntervalMs = body['startupMinIntervalMs']
          }
          await writeAutosyncConfig(syncDir, cfg)
          if (scheduler) scheduler.reload().catch(() => { /* 尽力而为 */ })
          writeJson(res, 200, await buildAutosyncStatus(syncDir))
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
  ]
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
  mkdirSync(exportsDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })
  mkdirSync(syncDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir, resolveProfileName(config))
  const adapters = createAdapters({
    // Namespace list = everything the settings service has registered.
    namespaces: async () => (await ctx.settings.describe({ redactSecrets: true })).map((d) => String(d.ns)),
  })

  host.log.info('config-manager 已挂载', {
    homeDir,
    dataDir,
    dshVersion: host.dshVersion,
    adapters: adapters.map((a) => a.id),
  })

  const routes = makeRoutes({
    host,
    adapters,
    exportsDir,
    tmpDir,
    snapshotsDir,
    runs: new RunRegistry({ msg: host.msg }),
    syncDir,
    credentials: ctx.credentials,
    githubClientId: config?.githubClientId ?? DEFAULT_GITHUB_CLIENT_ID,
    githubClientSecret: config?.githubClientSecret,
  })
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
