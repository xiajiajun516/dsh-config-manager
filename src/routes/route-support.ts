/**
 * 路由组共享的纯工具与请求体校验（route support）。
 *
 * 为什么单独一层：这些函数原先定义在 `src/index.ts`（宿主组合根），而
 * `src/routes/*.ts` 的组文件反向 import 组合根取值 —— 形成「入口 → routes → 组文件 → 入口」
 * 的运行时 import 环（13 文件 SCC）。把**不依赖组合根状态**的纯函数下沉到本模块后，
 * 依赖方向变成单向：`index.ts → routes/route-support.ts` 与 `routes/*.ts → route-support.ts`，
 * 组文件不再 import 组合根（`tests/architecture-boundaries.test.ts` 有对应断言）。
 *
 * 新增约定：只放**纯函数 / 常量 / 小型执行器装配**，绝不放需要 ctx/host 装配时序的东西；
 * 本模块不得 import `../index.ts`（否则环又回来了）。
 */

import * as dshCredentials from '@deepseek-ai/dsh-credentials'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import * as yaml from 'js-yaml'

import { RouteError, errorMessage, writeJsonError, writeRouteError } from './kit.ts'
import { msgOf, zhMsg } from '../core/messages.ts'
import type { MsgFunc } from '../core/messages.ts'
import { DshProfileError } from '../profiles/index.ts'
import { GitHubApiError } from '../market/github-repos.ts'
import { MANIFEST_FILE, parseManifest } from '../schema/manifest.ts'
import { collectCredentialRefs } from '../security/credentials-yaml.ts'
import { decryptCredentials, SecurityError } from '../security/index.ts'
import type { Manifest, SectionId } from '../schema/types.ts'
import type { HostContext, ImportPlan, PlanItemKind } from '../core/types.ts'
import { engineMsg } from '../core/engine-locale.ts'
import { createPreRestoreAttemptDir } from '../core/restore.ts'
import type { RestoreActionKind, RestorePlan, RestoreReport } from '../core/restore.ts'
import { createRestoreWal, isWalActionKind } from '../core/restore-wal.ts'
import type { RestoreJournalPort, RestoreWalHandle, RestoreWalSettleStatus } from '../core/restore-wal.ts'
import type { SyncTransportType } from '../sync/sync-config.ts'
import { DEFAULT_AUTOSYNC_AUTO_APPLY_TIER, DEFAULT_AUTOSYNC_CONFLICT_POLICY, DEFAULT_AUTOSYNC_REALTIME, DEFAULT_AUTOSYNC_REMOTE_CHECK_MS, lastRunFailureMessage, readAllAutosyncConfigs, readAutosyncConfig } from '../sync/autosync-config.ts'
import type { AutosyncAutoApplyTier, AutosyncConflictPolicy, AutosyncInterval, AutosyncRunStatus } from '../sync/autosync-config.ts'
import { SYNC_CHANNELS } from '../sync/sync-config.ts'
import { normalizeSessionsInclude } from '../sync/sync-selection.ts'
import { resolveProfileDir, runDshPlugin } from '../core/plugin-cli.ts'
import { isSameOrChild } from '../utils/paths.ts'
import { parseZip } from '../utils/zip.ts'

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

/** Safe credential ref converter compatible across DSH 0.1.1 and 0.1.2-alpha.x */
const CREDENTIAL_REF_REGEX = /^[A-Z_][A-Z0-9_]*$/
export function safeCredentialRef(ref: string): any {
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

/** Controlled staging roots guard. */
export function isControlledPath(target: string, roots: string[]): boolean {
  const t = resolve(target)
  return roots.some((root) => isSameOrChild(t, resolve(root)))
}

/** 导出/导入执行超时（ms）。正常导出秒级完成；此上限只兜底「宿主卡死」场景，
 * 让客户端拿到明确错误而不是永远停在进度条。 */
export const ROUTE_TIMEOUT_MS = 5 * 60 * 1000

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

/** 解密错误 → 用户可读文本：BAD_PASSWORD 只报「密码错误」（不泄内部细节），其余原文 */
export function decryptErrorText(error: unknown, msg: MsgFunc): string {
  if (error instanceof SecurityError && error.code === 'BAD_PASSWORD') {
    return msg('import.encryptedPasswordWrong')
  }
  return error instanceof Error ? error.message : String(error)
}

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

/**
 * 会话体检的「下一步」建议（**可复制命令**；给应用内修不了的那些损坏类别）。
 *
 * 为什么仍然需要这条出路：应用内修复（T8）只覆盖「重放重复行」这一**能从字节证明**的零损失类；
 * 其余类别（seq 空洞 / 不可解析行 / 容器非法 / 格式超前）必须离线进行（DSH 运行中改写会话会让
 * 它下次启动直接报 corrupt session log）。
 * 界面给不出的动作，就用可复制命令如实交代。
 */
export function sessionHealthNextSteps(rowCount: number, summary: { bySeverity: Record<string, number>; deepUnverified: number }): {
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
export interface SyncConfirmItem {
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
export interface AutosyncStatusResponse {
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

/**
 * 宿主侧恢复动作执行器（真实执行 restore 计划）：
 * 整文件/文件还原与删除走 ctx.fs（home-relative facade，越界由 facade 再拦一道），
 * blob 读取与 pre-restore 副本走快照目录（node fs），插件卸载走官方 dsh plugin CLI。
 */
export interface RestoreExecutor {
  /** 读快照目录内 blob（相对 snapshotDir） */
  readBlob(blobPath: string): Promise<Uint8Array>
  /** 把当前 home 文件内容复制到 <snapshotDir>/pre-restore/<本次 attempt>/（覆盖/删除前的双保险） */
  savePreRestore(relPath: string): Promise<void>
  /** 本次执行的 pre-restore attempt 目录（未发生任何备份 → null）；用于报告如实回填 */
  preRestoreDir?(): Promise<string | null>
  existsHome(relPath: string): Promise<boolean>
  writeHome(relPath: string, data: Uint8Array): Promise<void>
  removeHome(relPath: string): Promise<void>
  /** 卸载插件（官方通道）；失败返回 { ok:false, message } */
  uninstallPlugin(name: string): Promise<{ ok: boolean; message?: string }>
  /**
   * home 相对路径 → 磁盘绝对路径（逐动作 WAL 用：journal 的 ref 必须是绝对路径，
   * reconcile 的 verifyStepFingerprint 直接拿它读盘算指纹）。缺省 = 不登记 WAL。
   */
  absPath?(relPath: string): string
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
  journal?: RestoreJournalPort,
): Promise<RestoreReport> {
  const report: RestoreReport = {
    snapshotId: plan.snapshotId,
    restored: [],
    removedPlugins: [],
    manualHints: [],
    failed: [],
    skipped: [],
  }
  // 逐动作 WAL（与 core/restore.ts 同一实现，见 core/restore-wal.ts）：**首个写之前**预登记全部
  // 动盘动作（planned + beforeFp），执行完逐项 done/attention（+ afterFp）。崩溃后 reconcile 才能
  // 判出「哪些还原了、哪些没动」，而不是整笔不透明。没有 absPath = 不登记（旧行为）。
  const wal = createRestoreWal(journal)
  const walByAction = new Map<(typeof plan.actions)[number], RestoreWalHandle | undefined>()
  if (wal !== null && exec.absPath !== undefined) {
    const bindSnapshot = journal?.bindSnapshot
    if (bindSnapshot !== undefined) await bindSnapshot(plan.snapshotId)
    const markApplying = journal?.markApplying
    if (markApplying !== undefined) await markApplying()
    const mutating = plan.actions.filter((a) => isWalActionKind(a.kind))
    const absPath = exec.absPath
    const handles = await wal.preRegister(mutating.map((a) => ({
      kind: a.kind,
      ...(a.target !== undefined ? { target: a.target } : {}),
      ...(a.pluginName !== undefined ? { pluginName: a.pluginName } : {}),
      abs: a.kind === 'pluginRemove' || a.target === undefined ? null : absPath(a.target),
    })))
    mutating.forEach((a, i) => { walByAction.set(a, handles[i]) })
  }
  const total = plan.actions.length
  let index = 0
  for (const action of plan.actions) {
    index += 1
    onAction?.({ index, total, detail: action.description })
    const walHandle = walByAction.get(action)
    let settleStatus: RestoreWalSettleStatus = 'done'
    let settleMessage: string | null = null
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
            const reason = result.message ?? engineMsg('restore.pluginRemoveFailed')
            report.failed.push({ item: `plugin:${action.pluginName}`, reason })
            // 外部副作用没做成 → attention（绝不记 done）
            settleStatus = 'attention'
            settleMessage = reason
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
      const reason = err instanceof Error ? err.message : String(err)
      report.failed.push({ item: action.target ?? action.pluginName ?? action.description, reason })
      settleStatus = 'attention'
      settleMessage = reason
    }
    // WAL 终态：持久化失败向上抛（fail-closed，与 core/restore.ts 同口径）
    if (wal !== null && walHandle !== undefined) await wal.settle(walHandle, settleStatus, settleMessage)
  }
  if (exec.preRestoreDir !== undefined) {
    const dir = await exec.preRestoreDir()
    if (dir !== null) report.preRestoreDir = dir
  }
  return report
}

/** 宿主 restore 执行器装配：ctx.fs（home-relative）+ 快照目录（node fs）+ runDshPlugin。 */
export function makeRestoreExecutor(snapshotDir: string, host: HostContext, profile: string): RestoreExecutor {
  const profileDir = resolveProfileDir(host.homeDir, profile)
  let seq = 0
  // D5：本次执行的 attempt 目录（惰性创建；与 core/restore.ts 同一命名实现，绝不另写一套）
  let preDir: string | null = null
  const ensurePreDir = async (): Promise<string> => {
    if (preDir === null) preDir = await createPreRestoreAttemptDir(join(snapshotDir, 'pre-restore'))
    return preDir
  }
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
      const dir = await ensurePreDir()
      // 反悔副本必须一次落盘成功：先写旁路再 rename，避免半写文件被当成可用副本
      const target = join(dir, `${String(seq).padStart(4, '0')}-${safe}`)
      const tmp = `${target}.tmp-${process.pid}-${seq}`
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, target)
    },
    preRestoreDir: async () => preDir,
    absPath: (relPath) => join(host.homeDir, relPath),
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
