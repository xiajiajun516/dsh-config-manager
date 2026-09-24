/**
 * 路由组：远程同步（状态 / 配置 / UI 偏好 / 推送 / 拉取 / GitHub device flow / 历史 / 一键同步 / 自动同步 / 分区选择 / 回滚）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { FileSnapshotStore } from '../core/index.ts'
import { rollback as performRollback } from '../core/rollback.ts'
import type { ImportPlan, PathMapping, PlanItem } from '../core/types.ts'

/**
 * 解析请求体里的**用户路径映射**（issue #45 跨机同步）。
 *
 * 形状不符的条目一律丢弃（不可信输入不猜）：oldPrefix 必须非空、newPrefix 必须是字符串；
 * appliesTo 只收四个合法目标，缺省/非法 = 通配（与导入向导同一语义）。
 * 自动重定基（导出机 home → 本机 home）由 Importer 依快照 manifest.sourceHome 自行生成，
 * 排在用户映射之前生效，这里只负责用户手填的那部分。
 */
function extractPathMappings(body: Record<string, unknown>): PathMapping[] {
  const raw = body['pathMappings']
  if (!Array.isArray(raw)) return []
  const out: PathMapping[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const oldPrefix = rec['oldPrefix']
    const newPrefix = rec['newPrefix']
    if (typeof oldPrefix !== 'string' || oldPrefix === '') continue
    if (typeof newPrefix !== 'string') continue
    const targets = Array.isArray(rec['appliesTo']) ? rec['appliesTo'] : []
    const appliesTo = targets.filter(
      (v): v is PathMapping['appliesTo'][number] =>
        v === 'workspaces' || v === 'mcp' || v === 'pluginConfig' || v === 'skills',
    )
    out.push({ oldPrefix, newPrefix, appliesTo })
  }
  return out
}
import { REVIEW_KINDS, ROUTE_TIMEOUT_MS, SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF, SyncRouteError, buildAutosyncStatus, buildAutosyncStatusByChannel, credentialRef, extractSyncSections, extractSyncSessions, isAutosyncInterval, isToolchainChangeItem, planToConfirmItems, syncPasswordRef, withTimeout, writeSyncRouteError } from '../index.ts'
import { GitHubApiError } from '../market/github-repos.ts'
import type { SectionId } from '../schema/types.ts'
import { redact } from '../security/redaction.ts'
import { readAutosyncConfig, writeAutosyncConfig } from '../sync/autosync-config.ts'
import { DeviceFlowStore } from '../sync/github-auth.ts'
import { channelOf, isWebDavConfig, parseSyncChannel, readFullSyncConfig, writeSyncConfig } from '../sync/sync-config.ts'
import type { SyncConfig, SyncTransportType } from '../sync/sync-config.ts'
import { SyncEngine } from '../sync/sync-engine.ts'
import type { ApplyItemsReport } from '../sync/sync-engine.ts'
import { readSyncHistory } from '../sync/sync-history.ts'
import { SYNC_SELECTION_SCHEMA_VERSION, normalizeSessionsInclude, normalizeSessionsLimit, writeSyncSelection } from '../sync/sync-selection.ts'
import type { SyncSelection, SyncSelectionMode } from '../sync/sync-selection.ts'
import { loadSyncState } from '../sync/sync-state.ts'
import { readUiPrefs, updateUiPrefs } from '../sync/ui-prefs.ts'
import type { UiPrefsChannel } from '../sync/ui-prefs.ts'
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * webdav 通道的子对象状态（只有 webdav 通道下发；git → undefined）。
 *
 * 通道判定在**调用点**消费 channelOf（B7 单一来源）；本函数只用类型守卫做可辨识联合的收窄与字段读取
 * —— 原先的写法是 `isWebDavConfig(cfg) ? {...} : undefined`，把「通道判定」与「类型收窄」混成一处。
 */
function describeWebDavSlot(cfg: SyncConfig, passwordConfigured: boolean): { usernameConfigured: boolean; passwordConfigured: boolean } | undefined {
  if (!isWebDavConfig(cfg)) return undefined
  return {
    usernameConfigured: typeof cfg.webdav.username === 'string' && cfg.webdav.username !== '',
    passwordConfigured,
  }
}

export function syncRoutes(env: RoutesEnv): WebRoute[] {
  const {
    adapters,
    credentials,
    githubAuth,
    githubClientId,
    githubClientSecret,
    githubFlows,
    host,
    knownSyncSectionIds,
    makeSyncEngine,
    meGitHubRest,
    meTokenProvider,
    msg,
    prepareSync,
    resolveSyncPassword,
    scheduler,
    selectionCache,
    selectionHasOptInSections,
    selectionView,
    selectionViewByChannel,
    syncCredentialsByChannelView,
    syncDir,
    syncPasswordConfigured,
    syncSectionCatalog,
    syncSessions,
    tryAppendHistory,
    withMutationGate,
  } = env
  return [
    // ------------------------------------------------------ sync/status
    // m-sync-ui：同步状态（通道配置 / 凭据状态 / 上次同步 / 分区数）。只读，无 secret 值。
    endpoint({ path: '/api/dsh-config-manager/sync/status', methods: ['GET'] }, async (req, res) => {
      try {
        // 完整双命名空间配置：repoUrl / webdav.url 无论当前通道都回填，
        // 保证 UI 在 git ↔ webdav 间切换时另一通道的地址不丢失
        const full = await readFullSyncConfig(syncDir)
        const state = await loadSyncState(syncDir)
        const [cred, webdavCred] = await Promise.all([
          credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
          credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
        ])
        const transport: SyncConfig['transport'] = parseSyncChannel(full?.transport) ?? 'git'
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
          // 全部通道的同步密码保存状态（加密/解密；只回布尔，值永不回传浏览器）
          syncCredentialsByChannel: await syncCredentialsByChannelView(),
          // 自动同步当前状态（当前激活通道；供 UI 顶部开关回填；§3.9）
          autosync: await buildAutosyncStatus(syncDir, transport),
          // 全部通道的自动同步状态（git/webdav 各自独立；UI 按当前 tab 取对应通道）
          autosyncByChannel: await buildAutosyncStatusByChannel(syncDir),
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ sync/config
    // m-sync-config：保存同步通道配置（parseSyncBody 校验 + password/token 写 DSH credentials +
    // writeSyncConfig 落盘）。UI 表单自动保存 /「保存配置」按钮调用；响应为轻量状态视图
    // （仅凭据布尔，无 secret 值），供 UI 直接刷新徽章而不必重拉 status 覆盖正在编辑的表单。
    endpoint({ path: '/api/dsh-config-manager/sync/config', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
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
          // 通道判定消费单一来源 channelOf（B7 守卫扩到覆盖该谓词形态；此前是裸 isWebDavConfig 分支）
          webdav: channelOf(syncCfg) === 'webdav' ? describeWebDavSlot(syncCfg, webdavCred.configured) : undefined,
        })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // ------------------------------------------------------ sync/ui-prefs
    // m-self：保存插件 UI 偏好（当前为上次选择的同步通道；ui-prefs.json，随 self 分区进备份）。
    // 纯偏好、无 secret；失败仅提示，不阻断同步主流程。
    // 经 updateUiPrefs 局部合并写：不覆盖其他端点（star-prompt）刚写入的字段。
    endpoint({ path: '/api/dsh-config-manager/sync/ui-prefs', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const channel: UiPrefsChannel | undefined = parseSyncChannel(body['lastSyncChannel'])
        await updateUiPrefs(syncDir, { ...(channel !== undefined ? { lastSyncChannel: channel } : {}) })
        writeJson(res, 200, { ok: true, lastSyncChannel: channel })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // ------------------------------------------------------ sync/push
    // m-sync-ui：推送（导出 portable 分区 → 提交私有仓库 → 更新 sync-state）。
    // token 可选：非空先写入 DSH credentials；成功则记忆仓库配置（回填表单用）。
    // sections 可选（高级/自定义导出）：只推送勾选的分区；缺省 = 默认模式全部推荐分区。
    endpoint({ path: '/api/dsh-config-manager/sync/push', methods: ['POST'] }, withMutationGate('sync-push', async (req, res) => {
      const body = await requireJsonObject(req)
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
        // 已保存的加密密码兜底（DSH credentials；用户不必每次重输）。请求体里的密码优先，
        // 因为那是用户此刻输入的覆盖值；两者都没有 → 交给 engine 报「加密需要密码」。
        const pushChannel: SyncTransportType = channelOf(syncCfg)
        const effectiveEncryptPassword = encryptPassword ?? await resolveSyncPassword(syncPasswordRef('ENCRYPT', pushChannel))
        // 可选分区选项（历史会话「最新 N 个」）：只有显式提供才允许 sessions 进同步通道
        const sessions = extractSyncSessions(body)
        const sessionsOpt = sections !== undefined && sections.includes('sessions') && sessions !== undefined
          ? { sessions }
          : {}
        // P0-②：push 前只读预览（body.preview === true → 不写远端，只返回「将推送什么」）
        const preview = body['preview'] === true
        // 分支调用以保证 withTimeout 的泛型结果类型正确（SyncPushReport | SyncPushPreview）
        const report = preview
          ? await withTimeout(
              engine.previewPush({
                ...(sections === undefined ? {} : { sections }),
                ...sessionsOpt,
                ...(encrypt || includeSecrets ? { encrypt: true, includeSecrets } : {}),
              }),
              ROUTE_TIMEOUT_MS,
              msg('host.syncPushTimeout'),
            )
          : await withTimeout(
              engine.push({
                ...(snapshotId === undefined ? {} : { snapshotId }),
                ...(sections === undefined ? {} : { sections }),
                ...sessionsOpt,
                ...(encrypt || includeSecrets ? { encrypt: true, includeSecrets, password: effectiveEncryptPassword ?? '' } : {}),
              }),
              ROUTE_TIMEOUT_MS,
              msg('host.syncPushTimeout'),
            )
        await writeSyncConfig(syncDir, syncCfg)
        writeJson(res, 200, report)
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    })),
    // ------------------------------------------------------ sync/pull
    // m-sync-ui：拉取差异预览（只读：list/download → 转临时 ZIP → Importer 分析出计划摘要）。
    // 绝不直接写配置、绝不执行导入（executeImportPlan 由上层按用户确认驱动）。
    endpoint({ path: '/api/dsh-config-manager/sync/pull', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        // 用户驱动的拉取：选择里勾了 sessions 时才让会话分区进入差异计划（自动同步不传）
        const engine = makeSyncEngine(syncCfg, { includeOptInSections: selectionHasOptInSections(channelOf(syncCfg)) })
        const strategy =
          body['strategy'] === 'replace' || body['strategy'] === 'skipExisting' ? body['strategy'] : 'merge'
        const snapshotId =
          typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
        // 解密密码：请求体 > 已保存（DSH credentials）。明文快照根本不会被解密
        // （engine.prepareSnapshot 只在 manifest.encrypted 时才用密码），因此「未加密备份
        // 不会误用密码」是引擎层保证，而不是靠这里猜。密码仅内存，绝不落盘/落日志。
        const savedDecryptPassword = await resolveSyncPassword(syncPasswordRef('DECRYPT', channelOf(syncCfg)))
        const decryptPassword =
          typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
            ? body['decryptPassword']
            : savedDecryptPassword
        // 用户路径映射（跨机同步）：与自动重定基叠加，排在自动规则之后生效
        const pathMappings = extractPathMappings(body)
        const report = await withTimeout(
          engine.pull({
            strategy,
            ...(snapshotId === undefined ? {} : { snapshotId }),
            ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
            ...(pathMappings.length === 0 ? {} : { pathMappings }),
          }),
          ROUTE_TIMEOUT_MS,
          msg('host.syncPullTimeout'),
        )
        await writeSyncConfig(syncDir, syncCfg)
        writeJson(res, 200, report)
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // -------------------------------------------------- sync/github/start
    // m-github-oauth：发起 GitHub OAuth device flow。请求 GitHub 取设备码，宿主登记
    // （flowId → device_code 只存内存），返回 UI 展示用的 user_code + 授权页 URL。
    // client_id 来自插件配置；未配置时给出可操作指引（不会凭空认证）。
    endpoint({ path: '/api/dsh-config-manager/sync/github/start', methods: ['POST'] }, async (req, res) => {
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
    }),
    // -------------------------------------------------- sync/github/poll
    // m-github-oauth：轮询授权结果。凭 flowId 取回宿主登记的 device_code → GitHub 换 token
    // → 成功则立即写入 DSH credentials（SYNC_CREDENTIAL_REF，与手动 token 同槽），
    // token 绝不回传浏览器；pending 返回下次轮询延迟；终止态（denied/expired/error）清理登记。
    endpoint({ path: '/api/dsh-config-manager/sync/github/poll', methods: ['POST'] }, async (req, res) => {
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
    }),
    // -------------------------------------------------- sync/github/cancel
    // m-github-oauth：取消登录流程（丢弃宿主侧 device_code 登记，零副作用）。
    endpoint({ path: '/api/dsh-config-manager/sync/github/cancel', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const flowId = typeof body?.['flowId'] === 'string' ? body['flowId'] : ''
      if (flowId === '') {
        writeJson(res, 400, { error: 'flowId is required' })
        return
      }
      githubFlows.delete(flowId)
      writeJson(res, 200, { ok: true })
    }),
    // -------------------------------------------------- sync/github/validate
    // m-sync-github-valid：校验 SYNC_CREDENTIAL_REF 中已存 token 是否有效（GET /user），
    // 供 UI 判定「是否已登录」→ 已登录隐藏 GitHub 登录区块、token 失效则重新展示。
    // 只回布尔 + 登录名（非敏感），token 值绝不回传；仅 401（无效/过期）→ valid:false，
    // 其余错误（网络/限流）向上抛，由 UI 兜底（不误判登出）。
    endpoint({ path: '/api/dsh-config-manager/sync/github/validate', methods: ['POST'] }, async (req, res) => {
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
    }),
    // ------------------------------------------------------ sync/history
    // P2：列出本地祖先快照目录的 manifest.json（id/createdAt/sectionHashes），
    // 同时统计 review-queue 中关联到该 snapshotId 的项数。
    endpoint({ path: '/api/dsh-config-manager/sync/history', methods: ['GET'] }, async (req, res) => {
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
    }),
    // ------------------------------------------------------ sync/snapshots-list
    // m-sync-v2：远端历史快照列表（供「选择历史快照」下拉）。
    endpoint({ path: '/api/dsh-config-manager/sync/snapshots-list', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
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
    }),
    // ------------------------------------------------------ sync/sync
    // m-sync-v2：一键同步第一步 —— 拉取 → 差异确认会话（内存登记临时 ZIP + ImportPlan）。
    endpoint({ path: '/api/dsh-config-manager/sync/sync', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        // 用户驱动的一键同步：选择里勾了 sessions 时才让会话分区进入差异计划（自动同步不传）
        const engine = makeSyncEngine(syncCfg, { includeOptInSections: selectionHasOptInSections(channelOf(syncCfg)) })
        const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
        // 解密密码：请求体 > 已保存（DSH credentials）。明文快照根本不会被解密
        // （engine.prepareSnapshot 只在 manifest.encrypted 时才用密码），因此「未加密备份
        // 不会误用密码」是引擎层保证，而不是靠这里猜。密码仅内存，绝不落盘/落日志。
        const savedDecryptPassword = await resolveSyncPassword(syncPasswordRef('DECRYPT', channelOf(syncCfg)))
        const decryptPassword =
          typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
            ? body['decryptPassword']
            : savedDecryptPassword
        // 用户路径映射（跨机同步）：随 plan 一起进同步会话，apply-items 复用同一份 plan
        const pathMappings = extractPathMappings(body)
        const preview = await withTimeout(
          engine.preview({
            ...(snapshotId === undefined ? {} : { snapshotId }),
            ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
            ...(pathMappings.length === 0 ? {} : { pathMappings }),
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
          // issue #38：随加密快照迁移的凭据（仅内存；apply-items 时写回本机）。
          // 绝不进响应体：下面只回 items/needsReview 等非敏感字段。
          credentials: preview.credentials,
        })
        const items = planToConfirmItems(preview.plan)
        const needsReview = items.some((i) => REVIEW_KINDS.has(i.kind) || isToolchainChangeItem(i))
  || preview.analysis.pathIssues.length > 0
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
    }),
    // ------------------------------------------------------ sync/apply-items
    // m-sync-v2：一键同步第二步 —— 按用户对差异项的逐项决策执行导入。
    endpoint({ path: '/api/dsh-config-manager/sync/apply-items', methods: ['POST'] }, withMutationGate('sync-apply', async (req, res, lockCtx, journalCtx) => {
      const body = await requireJsonObject(req)
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
            // P0-7 收尾：把本会话拉取到的**远端**快照 id 透传下去，作为 sync-state 的远端基线指针
            //（不传则一键同步后 lastSnapshotId 停在空串，自动同步要多跑一轮 list+download+merge 才收敛）
            remoteSnapshotId: session.snapshotId,
            // issue #38：把会话里的凭据 Map 交给 credentials adapter 写回本机（仅内存）
            ...(session.credentials !== undefined ? { credentials: session.credentials } : {}),
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
    }, { deferredSnapshot: true })),
    // ------------------------------------------------------ sync/cancel
    // m-sync-v2：取消 / 清理差异确认会话（丢弃临时 ZIP，零副作用）。
    endpoint({ path: '/api/dsh-config-manager/sync/cancel', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
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
    }),
    // ------------------------------------------------------ sync/autosync
    // m-sync-v2：自动同步配置读写（按通道：git/webdav 各自的开关 + 间隔 + 启动阈值 + 状态）。
    // GET = 读全部通道状态（{ git, webdav }）；POST = 写指定通道（body.transport，缺省 git）。
    // 同一路径注册为一个 exact 路由（方法内部分发），避免 webserver 对重复 exact 路径报错。
    endpoint({ path: '/api/dsh-config-manager/sync/autosync', methods: ['GET', 'POST'] }, async (req, res) => {
      if (req.method === 'GET') {
        try {
          writeJson(res, 200, await buildAutosyncStatusByChannel(syncDir))
        } catch (error) {
          writeSyncRouteError(res, error)
        }
        return
      }
      const body = await requireJsonObject(req)
      try {
        // 按通道读写：git/webdav 各自的自动同步配置与运行状态独立（缺省 git 兜底）
        const channel: SyncTransportType = parseSyncChannel(body['transport']) ?? 'git'
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
    }),
    // ------------------------------------------------------ sync/selection
    // m-sync-selection：保存同步分区选择（按通道：git/webdav 各自的模式 + 勾选分区）。
    // 持久化到 sync-selection.json；自动同步调度器与手动 push 共用（makeSyncEngine 注入）。
    // sections 元素必须是可同步（portable）分区 id；mode 非法 → 回退 default。
    endpoint({ path: '/api/dsh-config-manager/sync/selection', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        // 按通道读写：git/webdav 各自的模式与分区勾选独立（缺省 git 兜底）
        const channel: SyncTransportType = parseSyncChannel(body['transport']) ?? 'git'
        const mode: SyncSelectionMode = body['mode'] === 'advanced' ? 'advanced' : 'default'
        const rawSections = Array.isArray(body['sections']) ? body['sections'] : []
        const allowedIds = new Set(syncSectionCatalog.map((s) => s.id))
        for (const s of rawSections) {
          if (typeof s !== 'string' || s === '') {
            writeJson(res, 400, { error: 'sections must be an array of non-empty strings' })
            return
          }
          if (!allowedIds.has(s as SectionId)) {
            writeJson(res, 400, { error: 'unknown sync section: ' + s })
            return
          }
        }
        const next: SyncSelection = {
          schemaVersion: SYNC_SELECTION_SCHEMA_VERSION,
          mode,
          sections: [...new Set(rawSections as string[])] as SectionId[],
          // sessions（历史会话）「最新 N 个」上限：仅在该分区被勾选时才有意义；归一化钳制
          sessionsLimit: normalizeSessionsLimit(body['sessionsLimit']),
          // 显式勾选的会话单元 id（非空时优先于 sessionsLimit；形状非法一律丢弃）
          sessionsInclude: normalizeSessionsInclude(body['sessionsInclude']),
          encrypt: body['encrypt'] === true,
          // 安全兜底：includeSecrets 必须同时 encrypt（密钥绝不明文进同步通道）
          includeSecrets: body['includeSecrets'] === true && body['encrypt'] === true,
        }
        // 加密/解密密码持久化（用户要求：勾选即记住，取消勾选或主动删除才清）。
        // 值只写进 DSH credentials（绝不进 sync-selection.json / 日志 / 响应）；
        // 清空优先于写入，避免「同一次请求既清又写」产生歧义。
        const encryptRef = syncPasswordRef('ENCRYPT', channel)
        const decryptRef = syncPasswordRef('DECRYPT', channel)
        if (body['clearEncryptPassword'] === true) await credentials.unset(credentialRef(encryptRef))
        else if (typeof body['encryptPassword'] === 'string' && body['encryptPassword'] !== '') {
          await credentials.set(credentialRef(encryptRef), body['encryptPassword'])
        }
        if (body['clearDecryptPassword'] === true) await credentials.unset(credentialRef(decryptRef))
        else if (typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== '') {
          await credentials.set(credentialRef(decryptRef), body['decryptPassword'])
        }
        await writeSyncSelection(syncDir, channel, next)
        selectionCache[channel] = next
        const [encryptPasswordConfigured, decryptPasswordConfigured] = await Promise.all([
          syncPasswordConfigured(encryptRef),
          syncPasswordConfigured(decryptRef),
        ])
        writeJson(res, 200, {
          ok: true,
          transport: channel,
          mode: next.mode,
          sections: next.sections,
          sessionsLimit: next.sessionsLimit,
          encrypt: next.encrypt,
          includeSecrets: next.includeSecrets,
          encryptPasswordConfigured,
          decryptPasswordConfigured,
        })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // ------------------------------------------------------ sync/rollback
    // P2：UI 一键回滚入口（按 apply 返回的 restoreId 调用 backup→rollback）。
    endpoint({ path: '/api/dsh-config-manager/sync/rollback', methods: ['POST'] }, withMutationGate('sync-rollback', async (req, res) => {
      const body = await requireJsonObject(req)
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
    })),
  ]
}
