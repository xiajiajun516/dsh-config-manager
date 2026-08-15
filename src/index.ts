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
 *   ctx.pluginInventory +  -> PluginsFacade       (@deepseek-ai/dsh-host-plugin-inventory
 *   ctx.pluginMarketplace                            + @deepseek-ai/dsh-plugin-marketplace, web)
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
 * the engine keeps working in profiles without the web-only marketplace or
 * workspace services; hard dependencies are the core `settings`/`credentials`
 * services present in every profile.
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
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: pull the Cordis Context augmentations (webServer / pluginInventory /
// workspaceRegistry) and the WebRoute contract without any runtime import.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as yaml from 'js-yaml'

import { Exporter, FileSnapshotStore, Importer } from './core/index.ts'
import type {
  ConfigAdapter, CredentialsFacade, FileSystemFacade, HostContext, ImportDecisions,
  ImportPlan, NamespaceInfo, PatchFileFacade, PluginInfo, PluginsFacade,
  SettingsFacade, WorkspaceFacade,
} from './core/types.ts'
import { createAdapters, USER_PATCH_FILE } from './adapters/index.ts'
import { createEncryptionProvider, decryptCredentials } from './security/index.ts'
import { createHardenedZipParser } from './security/zip-security.ts'
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
const PLUGIN_VERSION = '0.1.10'

/** Plugin config (composition entry); the loader applies it as-is. */
export interface Config {
  /** Master switch; defaults to true. */
  enabled?: boolean
  /** Data root override; defaults to $DSH_HOME/dsh-config-manager. */
  dataDir?: string
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
} as const

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

/* ------------------------------------------------------- HostContext facades */

/** Optional Cordis service reader (never injected → never blocks the fiber). */
function readService<T>(ctx: Context, serviceName: string): T | undefined {
  const candidate = ctx.get(serviceName)
  return candidate === null || typeof candidate !== 'object' ? undefined : candidate as T
}

/** Real-plugin marketplace service shape (@deepseek-ai/dsh-plugin-marketplace
 * ships no types; shape verified from its lib/index.js). */
interface MarketplacePlugin { name: string; version: string; isBundle: boolean; isClient: boolean; inBundles: string[] }
interface MarketplaceSnapshot { profileDir: string; bundles: string[]; plugins: MarketplacePlugin[] }
interface MarketplaceService {
  installed(): MarketplaceSnapshot
  installPlugin(packageName: string): Promise<{
    ok: boolean; name: string; version?: string; needsRestart?: boolean; error?: string
  }>
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

/** Plugins facade: inventory (tree) + marketplace (user installs) merged. */
class DshPluginsFacade implements PluginsFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
  }

  async listInstalled(): Promise<PluginInfo[]> {
    const out: PluginInfo[] = []
    const inventory = readService<{ list(): { entries: readonly { moduleName: string; enabled: boolean }[] } }>(
      this.ctx, 'pluginInventory',
    )
    const marketplace = readService<MarketplaceService>(this.ctx, 'pluginMarketplace')
    if (inventory) {
      for (const entry of inventory.list().entries) {
        out.push({ name: entry.moduleName, version: '', enabled: entry.enabled, isBundle: false, inBundles: [] })
      }
    }
    if (marketplace) {
      try {
        for (const p of marketplace.installed().plugins) {
          const existing = out.find((o) => o.name === p.name)
          if (existing) {
            existing.version = p.version
            existing.isBundle = p.isBundle
            existing.inBundles = p.inBundles
          } else {
            out.push({ name: p.name, version: p.version, enabled: true, isBundle: p.isBundle, inBundles: p.inBundles })
          }
        }
      } catch {
        // marketplace hiccup → still return the inventory view
      }
    }
    return out
  }

  async install(pkg: string): Promise<{ needsRestart: boolean }> {
    const marketplace = readService<MarketplaceService>(this.ctx, 'pluginMarketplace')
    if (!marketplace) {
      throw new Error('插件市场服务不可用（仅 web profile 提供），无法安装 ' + pkg)
    }
    const result = await marketplace.installPlugin(pkg)
    if (result.ok !== true) throw new Error(result.error ?? `安装失败: ${pkg}`)
    return { needsRestart: result.needsRestart ?? true }
  }
}

/** Workspace facade over the real ctx.workspaceRegistry. */
class DshWorkspaceFacade implements WorkspaceFacade {
  private readonly ctx: Context

  constructor(ctx: Context) {
    this.ctx = ctx
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
    if (!registry) throw new Error('workspaceRegistry 服务不可用，无法写入工作区')
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

/** Patch-file facade over the user patch layer ($DSH_HOME/cordis.patch.yml). */
class DshPatchFileFacade implements PatchFileFacade {
  private readonly homeDir: string

  constructor(homeDir: string) {
    this.homeDir = homeDir
  }

  private patchPath(file: string): string {
    if (file !== USER_PATCH_FILE) throw new Error(`dsh-config-manager 仅支持管理 ${USER_PATCH_FILE}（收到 ${file}）`)
    return join(this.homeDir, USER_PATCH_FILE)
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

  constructor(homeDir: string) {
    this.homeDir = homeDir
  }

  private abs(relPath: string): string {
    const target = resolve(isAbsolute(relPath) ? relPath : join(this.homeDir, relPath))
    if (!isSameOrChild(target, this.homeDir)) throw new Error(`路径越界: ${relPath}`)
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
  readonly log: Logger
  readonly settings: SettingsFacade
  readonly credentials: CredentialsFacade
  readonly plugins: PluginsFacade
  readonly workspace: WorkspaceFacade
  readonly patchFile: PatchFileFacade
  readonly fs: FileSystemFacade

  constructor(ctx: Context, homeDir: string) {
    this.homeDir = homeDir
    this.dshVersion = resolveDshVersion(homeDir)
    const level = process.env.DSH_CONFIG_MANAGER_LOG_LEVEL
    this.log = createLogger({
      level: level === 'debug' || level === 'info' || level === 'warn' || level === 'error' ? level : 'info',
    })
    this.settings = new DshSettingsFacade(ctx)
    this.credentials = new DshCredentialsFacade(ctx)
    this.plugins = new DshPluginsFacade(ctx)
    this.workspace = new DshWorkspaceFacade(ctx)
    this.patchFile = new DshPatchFileFacade(homeDir)
    this.fs = new DshFileSystemFacade(homeDir)
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
}

/** Build the /api/dsh-config-manager route family. */
function makeRoutes(deps: RoutesDeps): WebRoute[] {
  const { host, adapters, exportsDir, tmpDir, snapshotsDir } = deps
  const roots = [exportsDir, tmpDir]

  const makeImporter = (): Importer => new Importer({
    ctx: host,
    adapters,
    snapshotStore: new FileSnapshotStore({ dir: snapshotsDir }),
    parseZipOverride: createHardenedZipParser(),
    dependencyChecker: dependencyAvailable,
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
        try {
          const exporter = new Exporter({
            ctx: host,
            adapters,
            encryption: includeSecrets && password !== undefined ? createEncryptionProvider(password) : null,
            exporterVersion: PLUGIN_VERSION,
          })
          const result = await withTimeout(
            exporter.export({ includeSecrets, only, outPath }),
            ROUTE_TIMEOUT_MS,
            '导出超时（5 分钟）：导出过程未完成，请重试；若反复超时请检查 profile 依赖状态',
          )
          writeJson(res, 200, { zipPath: result.zipPath, manifest: result.manifest, report: result.report })
        } catch (error) {
          host.log.error('导出失败', { error: error instanceof Error ? error.message : String(error) })
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
          })
          writeJson(res, 200, result)
        } catch (error) {
          host.log.error('导入执行失败', { error: error instanceof Error ? error.message : String(error) })
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
  mkdirSync(exportsDir, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })
  mkdirSync(snapshotsDir, { recursive: true })

  const host = new ConfigManagerHostContext(ctx, homeDir)
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

  const routes = makeRoutes({ host, adapters, exportsDir, tmpDir, snapshotsDir })
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
