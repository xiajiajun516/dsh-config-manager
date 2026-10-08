/**
 * 救急台路由（阶段 2）：**只读页面 + 一组显式写动作**（写路由不在此处计数 —— 清单以
 * `GET /healthz` 的 `writeRoutes` 为准：它由路由声明派生，与实现同源、不会漂移）。
 *
 * 每条路由都经 `src/routes/kit.ts` 的 `endpoint()` 声明（围栏 / 方法白名单 / 统一错误映射一份实现）。
 *
 * 写动作的 CSR(F) 防线是**两段式**：
 *  ① 围栏（loopback + 同源）—— 由 kit 在每个 endpoint 上统一执行；
 *  ② **本页专属 token**：每次渲染的写表单都带一个随机 token，且该 token 只能被使用**一次**
 *     （用过即从集合里移除）。页面里没有任何脚本，跨站页面既读不到 token 也伪造不出来 ——
 *     这比单纯依赖 SameSite cookie 更稳，同时顺带挡住「重复提交」。
 * 副作用描述与确认文案都在服务端渲染，前端 JS 不参与决策（原本也没有前端 JS）。
 */
import { randomUUID } from 'node:crypto'
import { endpoint, routeSpecOf, RouteError, writeJson } from '../../routes/kit.ts'
import type { ServerResponse } from 'node:http'
import type { WebRoute } from '../../routes/kit.ts'
import {
  checkWriteGates, cleanupDisk, collectVerifyResults, exportOfflineBackup,
  repairSessionLogInline,
  launchProfile, planDshReinstall, planSnapshotRestore, readBackups, readDiskUsage, readProfiles,
  readRescueStatus, readSessionsHealth, recoverStaleEnvironmentLock, repairSessions,
  runDshReinstall, runSnapshotRestore, stopProfile, unlockEncryptedBackup, type RescuePaths,
} from '../actions.ts'
import { REINSTALL_ITEMS } from '../../core/reinstall.ts'
import type { SessionHealthScanResult } from '../../utils/session-health-scan.ts'
import { createExec } from './exec.ts'
import { writeHtml } from './http.ts'
import {
  consolePagesHint,
  escCapability,
  renderDiskPage, renderExportPage, renderHomePage, renderLockPage, renderMessagePage,
  renderProfilesPage, renderReinstallPage, renderRestorePage, renderResultPage, renderSessionsPage,
  renderUnlockPage, renderVerifyPage, verifyIdOf,
  type ActionCard, type GateView, type InlineRepairView,
} from './page.ts'

export interface ConsoleContext {
  paths: RescuePaths
  version: string
  startedAt: string
  /** 一次性 action token（POST 时消费；无状态前端靠它拿不到也不需要 cookie 里的额外秘密） */
  actionTokens: Set<string>
  /** 高危动作的终端确认码（重装用；只在终端打印，绝不渲染进页面） */
  dangerPhrase: string
}

/**
 * 救急台的错误渲染器：把 RouteError 渲染成 **HTML 错误页**（而不是插件 API 形状的裸 JSON）。
 * 页面是给人看的，用户在浏览器里收到 `{"error":"…"}` 只会以为坏了（验收 F3）。
 */
function renderConsoleError(res: ServerResponse, status: number, message: string): void {
  writeHtml(res, status, renderMessagePage(
    status === 404 ? '目标不存在' : status === 400 ? '请求无法处理' : '操作未完成',
    message,
    status === 404 ? consolePagesHint() : '',
  ))
}

/**
 * 把页面上的不透明 id 解析回**真实文件名**（文件名可能夹带密钥，绝不写回 URL —— 验收 F7）。
 * 前端只拿得到 id；服务端在导出目录列表里按 sha256 匹配。
 */
async function resolveBackupName(paths: RescuePaths, id: string): Promise<string | null> {
  if (id === '') return null
  const backups = await readBackups(paths.exportsDir)
  return backups.find((backup) => verifyIdOf(backup.name) === id)?.name ?? null
}

/** 生成一个一次性动作 token（用完即从集合移除）。 */
function issueActionToken(context: ConsoleContext): string {
  const token = randomUUID()
  context.actionTokens.add(token)
  return token
}

function consumeActionToken(context: ConsoleContext, token: unknown): void {
  if (typeof token !== 'string' || token === '' || !context.actionTokens.has(token)) {
    throw new RouteError('动作确认已失效，请刷新页面重试 / stale action token', 400, 'stale-action-token')
  }
  context.actionTokens.delete(token)
}

/** 读取 application/x-www-form-urlencoded 请求体（页面表单唯一形态；有大小上限）。 */
async function readFormBody(req: NodeJS.ReadableStream): Promise<Record<string, string>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 64 * 1024) throw new RouteError('请求体过大 / body too large', 413)
    chunks.push(buffer)
  }
  const out: Record<string, string> = {}
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  for (const [key, value] of params) out[key] = value
  return out
}

/** 一次预览最多探测多少条会话（行档贵；与页面呈现的分母一致）。 */
const INLINE_PREVIEW_LIMIT = 40

/**
 * 就地修复（重放族）的**只读预览**：只挑体检里报出深档问题的会话去试，
 * 不扫全库（解压每一份日志太贵，救急台要秒开）。
 *
 * 为什么只挑「报出深档问题」的：预览本身就是一次 `apply=false` 的真实执行器调用，
 * 对健康会话跑它恒返回 `nothing-to-fix`（仍要解压整份日志）。用体检结论当索引，
 * 既省时间，也让页面上的「探测了 N 条 / 其中 M 条可修」有明确分母。
 */
async function buildInlineRepairView(paths: RescuePaths, result: SessionHealthScanResult): Promise<InlineRepairView> {
  const candidates = result.rows
    .filter((row) => row.issues.some((issue) => issue.code === 'replay-duplicate-rows'))
    .map((row) => row.unitId)
    .slice(0, INLINE_PREVIEW_LIMIT)
  const outcome = await repairSessionLogInline(
    { home: paths.homeDir, dataDir: paths.dataDir, unitIds: candidates, apply: false },
    paths.controlRoots,
  )
  const fixable: Array<{ unitId: string; droppedRows: number }> = []
  const blockedCount = new Map<string, number>()
  for (const row of outcome.rows) {
    if (row.ok) fixable.push({ unitId: row.unitId, droppedRows: row.droppedRows ?? 0 })
    else blockedCount.set(row.reason ?? 'unknown', (blockedCount.get(row.reason ?? 'unknown') ?? 0) + 1)
  }
  const blocked = [...blockedCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
  return { fixable, probed: outcome.rows.length, blocked }
}

/** 构造救急台的全部路由（唯一声明处）。 */
export function buildConsoleRoutes(context: ConsoleContext): WebRoute[] {
  const { paths, version } = context
  const token = (): string => issueActionToken(context)
  // 本地别名：救急台的每条路由都带上 HTML 错误渲染器（kit 的统一出口仍在，只是形状换成页面）
  const consoleEndpoint: typeof endpoint = (spec, handler) =>
    endpoint({ ...spec, errorRenderer: renderConsoleError }, handler)
  /**
   * /healthz 的写路由自述：**由已声明的路由派生**（数组构造完再赋值），杜绝手写清单漂移（cli-F6：
   * 此前只列 3 项能力名，与真实 11 条写路由不符）。
   */
  let writeRoutes: string[] = []

  const routes: WebRoute[] = [
    // ---------------------------------------------------------------- 只读
    consoleEndpoint({ path: '/healthz', methods: ['GET'] }, (_req, res) => {
      writeJson(res, 200, {
        ok: true, service: 'dcm-rescue-console', readOnly: false, version, startedAt: context.startedAt,
        // 写能力与只读页的区分：脚本/自检据此判断这台服务能做什么
        writes: ['sessions-repair', 'disk-cleanup', 'recover-stale-lock'],
        // 全部写路由（由声明派生，cli-F6）
        writeRoutes,
      })
    }),

    consoleEndpoint({ path: '/', methods: ['GET'] }, async (_req, res) => {
      const status = await readRescueStatus(paths)
      const actions: ActionCard[] = [
        {
          id: 'recover-lock',
          title: '环境锁 / 回收残留锁',
          description: '查看锁状态；仅当持有进程被确证不存在时才允许回收（活锁一律拒绝）。',
          href: '/lock',
          disabled: false,
        },
        {
          id: 'session-repair',
          title: '会话布局修复',
          description: '位置与 header cwd 不一致的会话按计划归位（前置：DSH 已停、无 SAFE MODE、无残留锁）。',
          href: '/sessions',
          disabled: false,
        },
        {
          id: 'disk-cleanup',
          title: '清理磁盘',
          description: '可重建缓存与过期导出产物；导入前快照与同步数据永不在候选集内。',
          href: '/disk',
          disabled: false,
        },
        {
          id: 'profiles',
          title: '档案与实例',
          description: '查看本机档案与在跑的实例，并把某个档案作为独立实例启动（DSH 起不来时最有用的一条路）。',
          href: '/profiles',
          disabled: false,
        },
        { id: 'restore', title: '恢复快照', description: '先看逐项恢复计划（零写入），确认后覆盖回滚到某个导入前快照。', href: '/restore', disabled: false },
        { id: 'export', title: '离线导出', description: '把离线可读的文件类分区导出成与 GUI 同结构的 ZIP（落盘后自检）。', href: '/export', disabled: false },
        { id: 'unlock', title: '解锁加密备份', description: '用密码在内存里解出明文并查看条目清单；不写盘、不回传内容。', href: '/unlock', disabled: false },
        { id: 'reinstall', title: '重装 DSH', description: '最危险的动作：卸载并重装全局 DSH。需要终端里打印的 6 位确认码。', href: '/reinstall', disabled: false },
      ]
      writeHtml(res, 200, renderHomePage({ status, version, actions }))
    }),

    consoleEndpoint({ path: '/disk', methods: ['GET'] }, async (req, res) => {
      const report = await readDiskUsage(paths.dataDir, paths.exportsDir)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const done = url.searchParams.get('done') ?? ''
      writeHtml(res, 200, renderDiskPage(report, version, paths, token(), done))
    }),

    consoleEndpoint({ path: '/sessions', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const outcome = await readSessionsHealth(paths.homeDir)
      // 写动作需要「计划 → 确认 → 执行」三段，因此页面渲染计划（默认 dry-run，零写入）
      const plan = await repairSessions({ home: paths.homeDir, fix: false }, paths.controlRoots)
      if (!outcome.ok) {
        writeHtml(res, 200, renderSessionsPage(null, outcome.error, version, paths, null, '', ''))
        return
      }
      // 写入门现状（只读）：把「为什么现在写不了」提前到页面上，而不是只在提交后给 409
      const gate = await checkWriteGates(paths.controlRoots, { needsDshStopped: true, locksDir: paths.locksDir })
      const gateView: GateView = gate.ok
        ? { ok: true, code: 'open', reason: '三道门都开着：现在可以执行写动作。' }
        : {
          ok: false, code: gate.code, reason: gate.reason,
          ...(gate.detail?.instances !== undefined ? { instances: gate.detail.instances } : {}),
          ...(gate.detail?.commands !== undefined ? { commands: gate.detail.commands } : {}),
        }
      const inline = await buildInlineRepairView(paths, outcome.result)
      writeHtml(res, 200, renderSessionsPage(
        outcome.result, undefined, version, paths, plan, token(),
        url.searchParams.get('done') ?? '', gateView, inline,
      ))
    }),

    consoleEndpoint({ path: '/verify', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const file = url.searchParams.get('file') ?? ''
      const id = url.searchParams.get('id') ?? ''
      // 只接受「导出目录列表里确实存在的那个名字」：不拼路径、不解析用户给的路径 → 无目录穿越。
      // 页面链接用不透明摘要（id）传参 —— 文件名可能夹带密钥，不能把它写回 URL（验收 F7）。
      const backups = await readBackups(paths.exportsDir)
      const meta = id !== ''
        ? backups.find((backup) => verifyIdOf(backup.name) === id)
        : backups.find((backup) => backup.name === file)
      if (meta === undefined) {
        throw new RouteError('备份不在导出目录内 / backup not found in exports dir: ' + file, 404, 'backup-not-found')
      }
      const outcome = await collectVerifyResults(paths.exportsDir, meta.name)
      if (!outcome.ok) throw new RouteError(outcome.error, 500, 'verify-failed')
      const first = outcome.results[0]
      if (first === undefined) throw new RouteError('自检没有返回结果 / verify produced no result', 500, 'verify-empty')
      writeHtml(res, 200, renderVerifyPage(first, version, paths))
    }),

    consoleEndpoint({ path: '/lock', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const status = await readRescueStatus(paths)
      writeHtml(res, 200, renderLockPage(status.lock, version, paths, token(), url.searchParams.get('done') ?? ''))
    }),

    // ---------------------------------------------------------------- 写：会话布局修复
    consoleEndpoint({ path: '/sessions/repair', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const gate = await checkWriteGates(paths.controlRoots, { needsDshStopped: true, locksDir: paths.locksDir })
      if (!gate.ok) {
        writeHtml(res, 409, renderResultPage('修复未执行（安全门拒绝）', [gate.reason], version, paths, gate.code, '/sessions'))
        return
      }
      const result = await repairSessions({ home: paths.homeDir, fix: true, locksDir: paths.locksDir }, paths.controlRoots)
      const lines = [
        result.done.length > 0 ? '已执行 ' + String(result.done.length) + ' 项：' + result.done.join('；') : '没有需要执行的步骤。',
        ...result.errors.map((e) => '失败：' + e),
        ...result.notices.map((n) => '说明：' + n),
      ]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '会话布局修复已完成' : '会话布局修复有失败项',
        lines, version, paths, result.ok ? 'ok' : 'bad', '/sessions',
      ))
    }),

    // ---------------------------------------------------------------- 写：就地修复重放重复行
    consoleEndpoint({ path: '/sessions/inline-repair', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const picked = Object.entries(form)
        .filter(([key, value]) => key.startsWith('unit:') && value === 'on')
        .map(([key]) => key.slice('unit:'.length))
      // 门与 token 的先后：token 先（证明调用者拿到过本页确认），门在后 —— 与既有写路由同序
      const result = await repairSessionLogInline(
        { home: paths.homeDir, dataDir: paths.dataDir, unitIds: picked, apply: true },
        paths.controlRoots,
      )
      const lines = result.rows.length === 0
        ? [result.error ?? '没有选中任何会话。']
        : result.rows.map((row) => (row.ok ? '✔ ' : '✘ ') + row.unitId + '：' + row.message)
      const allOk = result.ok && result.rows.every((row) => row.ok)
      writeHtml(res, allOk ? 200 : 409, renderResultPage(
        allOk ? '就地修复完成（零损失）' : (result.error !== undefined ? '就地修复未执行（写入门拒绝）' : '就地修复有未完成项'),
        lines.concat(result.error === undefined ? [] : [result.error]), version, paths,
        allOk ? 'ok' : 'bad', '/sessions',
      ))
    }),

    // ---------------------------------------------------------------- 写：磁盘清理
    consoleEndpoint({ path: '/disk/cleanup', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const caches = form['caches'] === 'on'
      const expiredExports = form['expired-exports'] === 'on'
      const result = await cleanupDisk(paths.dataDir, paths.exportsDir, { caches, expiredExports })
      const lines = [
        result.error !== undefined ? result.error : '删除 ' + String(result.removed) + ' 项，释放 ' + String(result.freedBytes) + ' 字节。',
        ...result.detail.slice(0, 40).map((d) => '· ' + d),
        ...(result.detail.length > 40 ? ['（另有 ' + String(result.detail.length - 40) + ' 条明细未展开）'] : []),
        ...(result.errors > 0 ? ['有 ' + String(result.errors) + ' 项删除失败（其余已按勾选执行）。'] : []),
      ]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '清理完成' : '清理未完全成功', lines, version, paths, result.ok ? 'ok' : 'bad', '/disk',
      ))
    }),

    // ---------------------------------------------------------------- 写：回收残留环境锁
    consoleEndpoint({ path: '/lock/recover', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const result = await recoverStaleEnvironmentLock(paths.locksDir, paths.dataDir)
      const lines = [
        result.ok ? '已回收残留锁。' : '未回收：锁未被判定为残留（活锁或无法判定一律保留）。',
        '状态：' + result.state,
        '详情：' + result.detail,
        '等价命令：dsh-config-manager recover-stale-lock',
      ]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '残留锁已回收' : '未回收（如实报告）', lines, version, paths, result.ok ? 'ok' : 'bad', '/lock',
      ))
    }),

    // ---------------------------------------------------------------- 档案与实例（阶段 3）
    consoleEndpoint({ path: '/profiles', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const outcome = readProfiles(paths)
      writeHtml(res, 200, renderProfilesPage(
        outcome, version, paths, token(),
        url.searchParams.get('done') ?? '',
        url.searchParams.get('result') ?? '',
      ))
    }),

    // 启动：**不过 SAFE MODE / DSH 在跑 两道门**（它不写配置、不碰会话字节，且正是「DSH 起不来」时的出口）；
    // 但复用启动器自身的守卫：desktop 独占档案 / 非 web 形态 / 同名已在跑 / 找不到 CLI —— 全部带原因拒绝。
    consoleEndpoint({ path: '/profiles/launch', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const name = form['name'] ?? ''
      const result = await launchProfile(paths, name)
      const lines = result.ok
        ? [
          result.message,
          // 能力 URL：必须原样（含 token）—— 过 esc() 会被 redact 抹掉，链接点开必然 401（cli-F1）
          ...(result.url === undefined ? [] : [{ html: '认证 URL：<code>' + escCapability(result.url) + '</code>' }]),
          ...(result.port === undefined ? [] : ['端口：' + String(result.port)]),
          ...(result.pid === undefined ? [] : ['PID：' + String(result.pid)]),
          ...(result.logFile === undefined ? [] : ['日志：' + result.logFile]),
          ...result.warnings.map((w) => '告警：' + w),
          '打开实例后，若这个救急台不再需要，可以 Ctrl+C 关掉它。',
        ]
        : ['失败码：' + result.code, result.message]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '实例已启动' : '启动失败（原因见下）',
        lines, version, paths, result.ok ? 'ok' : 'bad', '/profiles',
      ))
    }),

    // 停止：先台账（本插件启动的），再心跳（手动/外部实例）；都找不到 → 如实 notRunning。
    consoleEndpoint({ path: '/profiles/stop', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const result = await stopProfile(paths, form['name'] ?? '')
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '实例已停止' : '停止未完成（原因见下）',
        ['失败码：' + result.code, result.message], version, paths, result.ok ? 'ok' : 'bad', '/profiles',
      ))
    }),


    // ---------------------------------------------------------------- 解锁加密备份（阶段 4a）
    consoleEndpoint({ path: '/unlock', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const backups = await readBackups(paths.exportsDir)
      const encrypted = backups.filter((b) => b.containerType === 'encrypted')
      writeHtml(res, 200, renderUnlockPage(encrypted, version, paths, token(), url.searchParams.get('ok') ?? ''))
    }),

    consoleEndpoint({ path: '/unlock/run', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const name = await resolveBackupName(paths, form['id'] ?? '')
      if (name === null) {
        writeHtml(res, 404, renderResultPage('备份不存在', ['导出目录里找不到该项（可能刚被清理）。'], version, paths, 'bad', '/unlock'))
        return
      }
      const result = await unlockEncryptedBackup(paths.exportsDir, name, form['password'] ?? '')
      const lines2 = result.ok
        ? [result.message, '条目数：' + String(result.entryCount ?? 0) + '，解出总量：' + String(result.totalBytes ?? 0) + ' 字节']
          .concat((result.entries ?? []).slice(0, 200).map((e) => '· ' + e.path + '（' + String(e.sizeBytes) + ' B）'))
        : ['失败码：' + result.code, result.message]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '解锁成功（明文只在内存，未落盘）' : '解锁失败',
        lines2, version, paths, result.ok ? 'ok' : 'bad', '/unlock',
      ))
    }),

    // ---------------------------------------------------------------- 快照恢复（阶段 4b）
    consoleEndpoint({ path: '/restore', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const status = await readRescueStatus(paths)
      const id = url.searchParams.get('id') ?? ''
      const plan = id === '' ? null : await planSnapshotRestore(paths, id)
      writeHtml(res, 200, renderRestorePage(status.snapshots, plan, version, paths, token()))
    }),

    consoleEndpoint({ path: '/restore/run', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const outcome = await runSnapshotRestore(paths, form['id'] ?? '')
      const gated = outcome.code === 'safe-mode' || outcome.code === 'stale-lock' || outcome.code === 'dsh-running'
      const lines2 = outcome.ok
        ? [outcome.message,
           '已还原 ' + String(outcome.restored?.length ?? 0) + ' 项，卸载插件 ' + String(outcome.removedPlugins?.length ?? 0) + ' 个。',
           '覆盖前已把当前文件复制到 <快照>/pre-restore/，可人工反悔。']
          .concat((outcome.restored ?? []).slice(0, 100).map((r) => '· 还原 ' + r))
          .concat((outcome.removedPlugins ?? []).map((p) => '· 卸载插件 ' + p))
          .concat((outcome.manualHints ?? []).map((h) => '· 需人工处理 ' + h))
          .concat((outcome.failed ?? []).map((f) => '✘ ' + f.item + '：' + f.reason))
        : (gated ? ['安全门拒绝：' + outcome.message]
                 : ['失败码：' + outcome.code, outcome.message].concat((outcome.failed ?? []).map((f) => '✘ ' + f.item + '：' + f.reason)))
      writeHtml(res, outcome.ok ? 200 : 409, renderResultPage(
        outcome.ok ? '恢复完成' : (gated ? '恢复未执行（安全门拒绝）' : '恢复未完成'),
        lines2, version, paths, outcome.ok ? 'ok' : 'bad', '/restore',
      ))
    }),

    // ---------------------------------------------------------------- 离线导出（阶段 4c）
    consoleEndpoint({ path: '/export', methods: ['GET'] }, async (_req, res) => {
      const { DEFAULT_BACKUP_SECTIONS, OFFLINE_UNAVAILABLE_SECTIONS } = await import('../../core/backup-plan.ts')
      writeHtml(res, 200, renderExportPage([...DEFAULT_BACKUP_SECTIONS], [...OFFLINE_UNAVAILABLE_SECTIONS], version, paths, token()))
    }),

    consoleEndpoint({ path: '/export/run', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const picked = Object.entries(form).filter(([k, v]) => k.startsWith('section:') && v === 'on').map(([k]) => k.slice('section:'.length))
      const result = await exportOfflineBackup(paths, picked)
      const lines2 = result.ok
        ? [result.message, '产物：' + String(result.outPath), '条目数：' + String(result.entryCount ?? 0)]
          .concat((result.sections ?? []).map((s) => '· ' + s.label + '（' + s.sectionId + '）：' + String(s.entryCount) + ' 个文件'))
          .concat(['离线不可收集（未进归档）：' + (result.unavailableSections ?? []).join('、')])
          .concat((result.warnings ?? []).map((w) => '告警：' + w))
        : ['失败码：' + result.code, result.message]
      writeHtml(res, result.ok ? 200 : 409, renderResultPage(
        result.ok ? '导出完成（已自检）' : '导出未完成', lines2, version, paths, result.ok ? 'ok' : 'bad', '/export',
      ))
    }),

    // ---------------------------------------------------------------- 重装 DSH（阶段 4d，最高危）
    consoleEndpoint({ path: '/reinstall', methods: ['GET'] }, async (_req, res) => {
      writeHtml(res, 200, renderReinstallPage([...REINSTALL_ITEMS], version, paths, token()))
    }),

    consoleEndpoint({ path: '/reinstall/plan', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const picked = Object.entries(form).filter(([k, v]) => k.startsWith('item:') && v === 'on').map(([k]) => k.slice('item:'.length))
      const exec = createExec()
      const plan = await planDshReinstall(picked, form['version'] ?? 'latest', exec)
      const lines2 = plan.ok
        ? [plan.message, '目标版本：' + String(plan.version),
           plan.wipeConfig === true ? '⚠ 该计划会清空 ~/.dsh 数据（settings / plugins / 会话与凭据）。' : '不会清空 ~/.dsh 数据。',
           '当前已装版本：' + (plan.currentVersion === null || plan.currentVersion === undefined ? '探测不到（执行会被 fail-closed 拒绝）' : String(plan.currentVersion))]
          .concat((plan.steps ?? []).map((s) => (s.dangerous ? '[危险] ' : '') + s.label + '  →  ' + s.command))
        : ['失败码：' + plan.code, plan.message]
      writeHtml(res, plan.ok ? 200 : 409, renderResultPage(
        plan.ok ? '重装计划（尚未执行任何命令）' : '生成计划失败', lines2, version, paths, plan.ok ? 'ok' : 'bad', '/reinstall',
      ))
    }),

    consoleEndpoint({ path: '/reinstall/run', methods: ['POST'] }, async (req, res) => {
      const form = await readFormBody(req)
      consumeActionToken(context, form['token'])
      const phrase = (form['phrase'] ?? '').trim().toUpperCase()
      if (phrase !== context.dangerPhrase) {
        writeHtml(res, 409, renderResultPage('重装未执行（终端确认码不正确）', [
          '确认码只在启动救急台的那个终端窗口里打印过（页面里看不到它）。',
          '这是刻意的摩擦：重装会卸载全局 DSH，勾选数据类还会清空 ~/.dsh —— 不能由一次误点触发。',
        ], version, paths, 'bad', '/reinstall'))
        return
      }
      const picked = Object.entries(form).filter(([k, v]) => k.startsWith('item:') && v === 'on').map(([k]) => k.slice('item:'.length))
      const outcome = await runDshReinstall(paths, picked, form['version'] ?? 'latest', createExec())
      const lines2 = outcome.ok
        ? [outcome.message,
           outcome.recoveryPointWritten === true ? '已写 recovery point（可据此回到旧版本）。' : '未涉及 program 步（无 recovery point）。']
          .concat((outcome.executed ?? []).map((e) => '✔ ' + e))
          .concat((outcome.failed ?? []).map((f) => '✘ ' + f.label + '：' + f.reason))
        : ['失败码：' + outcome.code, outcome.message].concat((outcome.failed ?? []).map((f) => '✘ ' + f.label + '：' + f.reason))
      writeHtml(res, outcome.ok ? 200 : 409, renderResultPage(
        outcome.ok ? '重装完成' : '重装未完成（原因见下）', lines2, version, paths, outcome.ok ? 'ok' : 'bad', '/reinstall',
      ))
    }),
    // ---------------------------------------------------------------- 其余一律 404
    consoleEndpoint({ path: '/favicon.ico', methods: ['GET'] }, (_req, res) => {
      // 浏览器会自动请求：给它一个空 204，避免污染 404 日志（无图标 = 不谎报资源存在）
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
    }),
  ]
  // 自述与实现同源：从已声明的路由读回（routeSpecOf），非 GET 方法按声明原样列出
  writeRoutes = routes
    .flatMap((route) => {
      const spec = routeSpecOf(route)
      if (spec === undefined) return []
      return spec.methods.filter((method) => method !== 'GET').map((method) => method + ' ' + spec.path)
    })
    .sort()
  return routes
}

export { renderMessagePage }
