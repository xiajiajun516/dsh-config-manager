/**
 * 路由组：远程同步（状态 / 配置 / UI 偏好 / 推送 / 拉取 / GitHub device flow / 历史 / 一键同步 / 自动同步 / 分区选择 / 回滚）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, readJsonBody, writeJson } from './kit.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
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
import { REVIEW_KINDS, ROUTE_TIMEOUT_MS, SYNC_CREDENTIAL_REF, SYNC_WEBDAV_CREDENTIAL_REF, SyncRouteError, buildAutosyncStatus, buildAutosyncStatusByChannel, credentialRef, extractSyncSections, extractSyncSessions, isAutosyncInterval, isGitHubAuthMissing, isToolchainChangeItem, planToConfirmItems, syncPasswordRef, withTimeout, writeSyncRouteError } from '../index.ts'
import { GitHubApiError } from '../market/github-repos.ts'
import type { SectionId } from '../schema/types.ts'
import { redact } from '../security/redaction.ts'
import { shouldRunOnEnable, readAutosyncConfig, writeAutosyncConfig, clampRemoteCheckMs, clearLastRunResult } from '../sync/autosync-config.ts'
import { isValidExportFileName } from '../sync/backup-files.ts'
import { DeviceFlowStore } from '../sync/github-auth.ts'
import { channelOf, clearSyncChannel, isWebDavConfig, listCloudConfiguredProviders, parseSyncChannel, readFullSyncConfig, writeSyncConfig, gistChannelView, s3ChannelView, cloudSecretRef, S3_COMPAT_PROVIDERS, GIST_PROVIDER } from '../sync/sync-config.ts'
import type { CloudS3ChannelView, CloudGistChannelView, CloudSecretWriter, FullSyncConfig, SyncConfig, SyncTransportType } from '../sync/sync-config.ts'
import { SyncEngine } from '../sync/sync-engine.ts'
import { isProbeUnsupported } from '../sync/transport.ts'
import type { ApplyItemsReport } from '../sync/sync-engine.ts'
import { readSyncHistory } from '../sync/sync-history.ts'
import { SYNC_SELECTION_SCHEMA_VERSION, normalizeSessionsInclude, normalizeSessionsLimit, writeSyncSelection } from '../sync/sync-selection.ts'
import type { SyncSelection, SyncSelectionMode } from '../sync/sync-selection.ts'
import { loadSyncState } from '../sync/sync-state.ts'
import { resolveSessionFormatDisposition, sessionFormatAbortResponse } from './session-format.ts'
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
/** 凭据只读面（结构类型：只用到 describe，避免 routes 依赖 DSH 具体类型）。 */
interface CredentialDescriber {
  describe(ref: string): Promise<{ configured: boolean }>
}

/**
 * 云端点通道回传视图（s3 / gist）：**只带 secretStored 布尔，绝不带任何密钥值**。
 * 配置过即返回（与当前活动通道无关），供表单在各通道间切换时回填。
 */
async function cloudChannelViews(
  full: FullSyncConfig | null,
  credentials: CredentialDescriber,
): Promise<{ s3?: CloudS3ChannelView; gist?: CloudGistChannelView }> {
  const out: { s3?: CloudS3ChannelView; gist?: CloudGistChannelView } = {}
  if (full?.s3 !== undefined) {
    const info = await credentials.describe(credentialRef(cloudSecretRef(full.s3.provider)))
    out.s3 = s3ChannelView(full.s3.provider, full.s3, info.configured)
  }
  if (full?.gist !== undefined) {
    const info = await credentials.describe(credentialRef(cloudSecretRef(GIST_PROVIDER)))
    out.gist = gistChannelView(full.gist, info.configured)
  }
  return out
}

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
    selectionOptInSections,
    selectionView,
    selectionViewByChannel,
    syncCredentialsByChannelView,
    syncDir,
    syncPasswordConfigured,
    syncSectionCatalog,
    syncSessions,
    syncWorkDir,
    tmpDir,
    tryAppendHistory,
    withMutationGate,
  } = env
  /** 云端点密钥「只写」端口：值只进 DSH credentials，绝不落盘 / 日志 / 回传（cloudSecretRef 槽位）。 */
  const cloudSecrets: CloudSecretWriter = {
    set: async (ref, value) => { await credentials.set(credentialRef(ref), value) },
    has: async (ref) => (await credentials.describe(credentialRef(ref))).configured,
  }
  /**
   * T-ui-merge：合并预览 / 合并执行共用的引擎选项。
   *
   * 解密密码口径与 /sync/sync 完全一致：请求体优先，其次已保存的 DECRYPT 凭据
   * （syncPasswordRef('DECRYPT', channel)）。密码只存在于内存，绝不写进响应 / 日志 / 同步文件；
   * 明文快照根本不会被解密（引擎只在 manifest.encrypted 时才用密码）。
   */
  const mergeEngineOptions = async (
    body: Record<string, unknown>,
    syncCfg: SyncConfig,
  ): Promise<{ snapshotId?: string; password?: string; pathMappings?: PathMapping[] }> => {
    const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
    const savedDecryptPassword = await resolveSyncPassword(syncPasswordRef('DECRYPT', channelOf(syncCfg)))
    const decryptPassword = typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
      ? body['decryptPassword']
      : savedDecryptPassword
    const pathMappings = extractPathMappings(body)
    return {
      ...(snapshotId === undefined ? {} : { snapshotId }),
      ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
      ...(pathMappings.length === 0 ? {} : { pathMappings }),
    }
  }
  /**
   * 合并裁决清单解析（T-ui-merge）。**粒度 = 分区 id**（冻结口径，不做 'id::path' 复合 id）。
   *
   * 非法条目直接丢弃 —— 引擎按「未裁决」处理，该分区进 pendingConflicts，界面会如实显示；
   * 这样既不需要新增宿主文案键，也不会因为客户端字段拼错而静默写坏别的分区。
   */
  const extractMergeResolutions = (body: Record<string, unknown>): Array<{ id: SectionId; action: 'keepLocal' | 'useRemote' | 'useMerged' | 'skip' }> => {
    const raw = body['resolutions']
    if (!Array.isArray(raw)) return []
    const out: Array<{ id: SectionId; action: 'keepLocal' | 'useRemote' | 'useMerged' | 'skip' }> = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const rec = entry as Record<string, unknown>
      const id = rec['id']
      const action = rec['action']
      if (typeof id !== 'string' || id === '') continue
      if (action !== 'keepLocal' && action !== 'useRemote' && action !== 'useMerged' && action !== 'skip') continue
      out.push({ id: id as SectionId, action })
    }
    return out
  }
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
        // 云端点配置视图（只回 secretStored 布尔；与当前通道无关，配置过即回填）
        const cloud = await cloudChannelViews(full, credentials)
        // issue #79 / #104 建议 3：git 工作副本是否已跟随 repoUrl，外加「领先远端提交数 /
        // 远端快照数」（只读自检；后者是「本地一直没真正备份」的预警依据）。
        // 读不出来时**如实回传错误**（workDirError），不让状态接口静默少一块信息。
        const gitRepoUrl = full?.git?.repoUrl ?? ''
        let workDir: Awaited<ReturnType<typeof syncWorkDir.inspect>> | null = null
        if (gitRepoUrl !== '') workDir = await syncWorkDir.inspect(gitRepoUrl)
        writeJson(res, 200, {
          ok: true,
          configured: full !== null,
          transport,
          repoUrl: full?.git?.repoUrl,
          credentialConfigured: cred.configured,
          credentialWritable: cred.writable === true,
          // webdav 配置状态（无 secret 值：口令用 passwordConfigured 布尔标记）
          ...(webdav !== undefined ? { webdav } : {}),
          // 云端点：当前活动 s3 兼容商 / gist 的非密配置（无任何密钥值）
          ...(cloud.s3 === undefined ? {} : { s3: cloud.s3 }),
          ...(cloud.gist === undefined ? {} : { gist: cloud.gist }),
          // 已保存的云端点 provider 清单（切换 provider 时回填用；只有名字，无任何值）
          cloudSavedProviders: await listCloudConfiguredProviders(syncDir),
          lastSyncAt: state.lastSyncAt === '' ? undefined : state.lastSyncAt,
          // 方案 A（同步页按钮瘦身）：是否存在同步基线（本地祖先指针）。**只回布尔，绝不回快照 id** ——
          // 界面据此在「有基线 → 三方裁决视图 / 无基线 → 导入确认」之间分派；缺省 undefined 按无基线处理。
          hasBaseline: state.lastSnapshotId !== '',
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
          // 工作副本事实（仅 git 且配置了地址时返回；'facts' = 自检成功，'error' = 自检读不出来）
          ...(workDir === null ? {} : { workDir }),
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ sync/workdir/reset
    // issue #79 / #104：工作副本的自救入口（改造前 App 内完全没有 —— 改了仓库地址只能手工
    // git remote set-url，或删掉 <dataDir>/sync/work 重来）。三种模式，破坏性清清楚楚：
    //   relink  = 只把 origin / push URL 重指向当前配置地址（非破坏性：不碰工作树与本地提交）；
    //   adopt   = 把远端分支合并进现有工作副本（issue #104：换成另一个仓库、或远端历史被重写后
    //             两条历史不相交，pull --ff-only 永远失败）；不改写任何本地提交，可 revert；
    //   reclone = 删除工作副本目录后重新 clone（**丢弃未上行的本地提交**）→ 必须显式 confirm。
    // 写动作 → 过 mutation gate（SAFE MODE / 环境锁）；删除边界见 GitTransport.rebuildWorkDir
    // （目录非空且无 .git 一律拒绝，绝不删来路不明的目录）。
    endpoint({ path: '/api/dsh-config-manager/sync/workdir/reset', methods: ['POST'] }, withMutationGate('sync-workdir-reset', async (req, res) => {
      try {
        const body = await requireJsonObject(req)
        const mode = body['mode'] === undefined ? 'relink' : body['mode']
        if (mode !== 'relink' && mode !== 'adopt' && mode !== 'reclone') {
          // 用追加键（含三种模式）而不是既有的 sync.workdirModeInvalid：后者有冻结指纹，
          // 只列出了两种模式，继续用会把「adopt 也合法」说反。
          writeJson(res, 400, { error: msg('sync.workdirModeInvalidFull', { mode: JSON.stringify(body['mode']) }) })
          return
        }
        if (mode === 'reclone' && body['confirm'] !== true) {
          writeJson(res, 400, { error: msg('sync.workdirRecloneNeedsConfirm') })
          return
        }
        const full = await readFullSyncConfig(syncDir)
        const repoUrl = full?.git?.repoUrl ?? ''
        if (repoUrl === '') {
          writeJson(res, 400, { error: msg('sync.workdirNotConfigured') })
          return
        }
        const rebuilt = await syncWorkDir.rebuild(repoUrl, mode)
        writeJson(res, 200, { ok: true, mode, workDir: { facts: rebuilt } })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    })),
    // ------------------------------------------------------ sync/config
    // m-sync-config：保存同步通道配置（parseSyncBody 校验 + password/token 写 DSH credentials +
    // writeSyncConfig 落盘）。UI 表单自动保存 /「保存配置」按钮调用；响应为轻量状态视图
    // （仅凭据布尔，无 secret 值），供 UI 直接刷新徽章而不必重拉 status 覆盖正在编辑的表单。
    endpoint({ path: '/api/dsh-config-manager/sync/config', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        // -------------------------------------------------- 断开通道（用户要求：配置过就必须能删掉）
        // 一条打不通的通道若没有出口，产物库的远端源与自动同步只会一直报读取失败。
        // 这里一处清三项：sync-config 命名空间（活动通道自动回落到剩下的那条）、该通道在
        // DSH credentials 里的全部凭据（token / WebDAV 口令 / 加密·解密密码）、该通道的
        // 自动同步开关（对已删通道排期只会持续报错）。**只解除本机绑定**：远端快照与本机
        // 备份一律不动（删除远端数据是另一个动作）。
        // 排在 prepareSync 之前：清空请求不带地址，prepareSync 会直接 400。
        if (body['clear'] === true) {
          const channel = parseSyncChannel(body['transport'])
          if (channel === undefined) {
            writeJson(res, 400, { error: 'transport is required' })
            return
          }
          const cleared = await clearSyncChannel(syncDir, channel)
          // 凭据值永不回传；unset 幂等（本来就没配也不报错）
          if (channel === 's3') {
            // s3 通道断开 → 清掉**全部**兼容商的密钥槽位（该通道不再指向任何一家；幂等）
            for (const provider of S3_COMPAT_PROVIDERS) {
              await credentials.unset(credentialRef(cloudSecretRef(provider)))
            }
          } else if (channel === 'gist') {
            await credentials.unset(credentialRef(cloudSecretRef(GIST_PROVIDER)))
          } else {
            await credentials.unset(credentialRef(channel === 'git' ? SYNC_CREDENTIAL_REF : SYNC_WEBDAV_CREDENTIAL_REF))
          }
          await credentials.unset(credentialRef(syncPasswordRef('ENCRYPT', channel)))
          await credentials.unset(credentialRef(syncPasswordRef('DECRYPT', channel)))
          const auto = await readAutosyncConfig(syncDir, channel)
          await writeAutosyncConfig(syncDir, channel, { ...auto, enabled: false, consecutiveFailures: 0 })
          // 立即让调度器丢掉该通道的定时器（否则内存里的旧排期会继续对已删通道发请求）
          if (scheduler) scheduler.reload().catch(() => { /* 尽力而为 */ })
          // 「记住的通道」指向被删通道 → 改指剩下的那条：否则产物库/页面回填会继续拿它去请求
          const prefs = await readUiPrefs(syncDir)
          if (cleared.hasRemaining && prefs.lastSyncChannel === channel) {
            await updateUiPrefs(syncDir, { lastSyncChannel: cleared.transport })
          }
          writeJson(res, 200, {
            ok: true,
            cleared: channel,
            removed: cleared.removed,
            configured: cleared.hasRemaining,
            transport: cleared.transport,
          })
          return
        }
        const syncCfg = await prepareSync(body)
        // 云端点通道经 CloudSecretWriter 只写端口落库（值绝不进 sync-cloud-config.json / 日志 / 回传）
        await writeSyncConfig(syncDir, syncCfg, cloudSecrets)
        const [cred, webdavCred] = await Promise.all([
          credentials.describe(credentialRef(SYNC_CREDENTIAL_REF)),
          credentials.describe(credentialRef(SYNC_WEBDAV_CREDENTIAL_REF)),
        ])
        const cloud = await cloudChannelViews(await readFullSyncConfig(syncDir), credentials)
        writeJson(res, 200, {
          ok: true,
          configured: true,
          transport: syncCfg.transport,
          credentialConfigured: cred.configured,
          // 通道判定消费单一来源 channelOf（B7 守卫扩到覆盖该谓词形态；此前是裸 isWebDavConfig 分支）
          webdav: channelOf(syncCfg) === 'webdav' ? describeWebDavSlot(syncCfg, webdavCred.configured) : undefined,
          ...(cloud.s3 === undefined ? {} : { s3: cloud.s3 }),
          ...(cloud.gist === undefined ? {} : { gist: cloud.gist }),
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
        // ④A：与回滚开关端点**同一道写入门**。ui-prefs.json 由三个端点共写，`updateUiPrefs` 虽是
        // read→merge→write，但两个不同端点并发时仍会互相覆盖字段（例如把刚打开的 rollbackEnabled 抹掉，
        // 重启后功能自己关掉）。同类写串行是既有架构口径。
        await runWithMutationLock(
          host.mutationLock,
          { op: 'ui-prefs', target: 'lastSyncChannel', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
          async () => {
            await updateUiPrefs(syncDir, { ...(channel !== undefined ? { lastSyncChannel: channel } : {}) })
          },
        )
        writeJson(res, 200, { ok: true, lastSyncChannel: channel })
      } catch (error) {
        if (error instanceof EnvironmentLockUnavailableError) {
          writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
          return
        }
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
        // 用户驱动的推送：放行持久化选择里勾选的可选分区（mcp / sessions），否则它们按非 portable 跳过
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
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
        // sessions 的导出参数（「最新 N 个」/ 逐会话点名）；**放行**由引擎的 optInSections 决定
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
        await writeSyncConfig(syncDir, syncCfg, cloudSecrets)
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
        // 用户驱动的拉取：放行持久化选择里勾选的**全部**可选分区（自动同步只放行 'auto' 档）
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
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
        await writeSyncConfig(syncDir, syncCfg, cloudSecrets)
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
    // ------------------------------------------ sync/github/repositories
    // 仓库选择器（issue：同步通道支持「选择已有仓库 / 新建仓库」）：
    //   GET  → 列出当前用户可见仓库（按最近更新排序），供 UI 下拉选择；
    //   POST → 新建**私有**仓库（body: { name, description? }），返回仓库信息供回填 repoUrl。
    // token 来源与 /sync/github/validate 完全一致（DSH credentials 的 SYNC_CREDENTIAL_REF），
    // 401（未登录 / token 失效）单独映射，其余错误走通用 500 —— 与 me 路由同一口径。
    // 不进 mutation gate：两步都不写本地文件（只读列举 + 幂等元操作），
    // 而 gate 在 SAFE MODE 下会直接拒绝，会把「选仓库」变成不可用功能。
    endpoint({ path: '/api/dsh-config-manager/sync/github/repositories', methods: ['GET', 'POST'] }, async (req, res) => {
      try {
        if (req.method === 'GET') {
          const repos = await meGitHubRest.listRepos()
          writeJson(res, 200, { ok: true, repos })
          return
        }
        const body = await readJsonBody(req)
        const name = typeof body?.['name'] === 'string' ? body['name'].trim() : ''
        if (name === '') {
          writeJson(res, 400, { error: 'name is required' })
          return
        }
        const description = typeof body?.['description'] === 'string' ? body['description'].trim() : ''
        // private 恒为 true（宿主强制）：同步仓库必须私有，public 会把配置内容公开。
        // 客户端**不能**通过 body 把它改成公开 —— 安全约束落在宿主侧，不依赖 UI。
        const repo = await meGitHubRest.createRepo(name, {
          private: true,
          ...(description !== '' ? { description } : {}),
        })
        writeJson(res, 200, { ok: true, repo })
      } catch (error) {
        const status = isGitHubAuthMissing(error) ? 401 : 500
        writeJson(res, status, { error: redact(error instanceof Error ? error.message : String(error)) })
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
    // ------------------------------------------------------ sync/probe
    // cloud-sync 借鉴项 ②：**只读**连通性自检（凭据 / 端点 / 目标容器 / 目录可达），
    // 供 UI「测试连接」按钮拿到可直接展示的结论（例如 S3 兼容端点该把 region 填成哪个值）。
    // 只探**已保存**的通道配置（走与 push/pull 同一条配置路径，绝不拿表单里未保存的值去发请求）。
    // 远端唯一写副作用 = webdav 幂等 MKCOL 补齐上级目录（那正是它要修的故障：目录不存在）。
    // 失败一律 200 + ok:false —— 「测试连接」是**预期会失败**的诊断动作，用 5xx 表达会被 UI
    // 当成基础设施故障；文案由通道层本地化并脱敏后原样带回。
    endpoint({ path: '/api/dsh-config-manager/sync/probe', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
        const result = await engine.probe()
        writeJson(res, 200, {
          ok: true,
          transport: channelOf(syncCfg),
          message: result.message,
          ...(result.hint !== undefined ? { hint: result.hint } : {}),
          ...(result.snapshotCount !== undefined ? { snapshotCount: result.snapshotCount } : {}),
          ...(result.createdCollections !== undefined && result.createdCollections.length > 0
            ? { createdCollections: result.createdCollections }
            : {}),
        })
      } catch (error) {
        // 「该通道不提供自检」是**能力边界**（git 通道按 fast-forward 语义自证），不是故障：
        // 用稳定错误码标记，界面据此按中性提示渲染，绝不显示成「操作失败」。
        writeJson(res, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          ...(isProbeUnsupported(error) ? { unsupported: true } : {}),
        })
      }
    }),
    // ------------------------------------------------------ sync/download
    // 「拉取即导入」：把远端快照**落地成本机 ZIP** 并返回路径，供导入向导消费。
    // 与 /sync/pull 的分工：pull 只做只读差异预览（临时 ZIP 用完即删）；
    // 本路由把 ZIP 留在**受控暂存区 tmpDir**（与 /upload 同区；导入向导按既有约定消费它）。
    // **必须落在 isControlledPath 认得的根里**：/analyze、/plan、/execute 都按 roots 校验 zipPath，
    // 落到 syncDir 下会被 400 挡回（真机 bug：产物库「拉取」进导入页报
    // 'zipPath is required and must reference a staged backup'）。
    // 同步目录本身也**刻意**不是暂存根 —— 那里放的是同步配置 / 状态 / 历史，不对外暴露。
    // 只读远端：不改远端、不动同步基线（基线只在 apply 之后推进）。
    endpoint({ path: '/api/dsh-config-manager/sync/download', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
        const snapshotId = typeof body['snapshotId'] === 'string' && body['snapshotId'] !== '' ? body['snapshotId'] : undefined
        // 可选落地文件名（产物库「下载」要给用户一个可辨识的名字，而不是固定的 snapshot.zip）。
        // 不安全的名字直接 400 而不是「静默换名」：它会进 path.join(dir, name)，白名单是唯一防线。
        const name = typeof body['name'] === 'string' ? body['name'] : undefined
        if (name !== undefined && !isValidExportFileName(name)) {
          writeJson(res, 400, { error: 'name must be a .zip file name (no path separators)' })
          return
        }
        const savedDecryptPassword = await resolveSyncPassword(syncPasswordRef('DECRYPT', channelOf(syncCfg)))
        const decryptPassword =
          typeof body['decryptPassword'] === 'string' && body['decryptPassword'] !== ''
            ? body['decryptPassword']
            : savedDecryptPassword
        const result = await withTimeout(
          engine.downloadSnapshot({
            dir: tmpDir,
            ...(snapshotId === undefined ? {} : { snapshotId }),
            ...(name === undefined ? {} : { name }),
            ...(decryptPassword === undefined ? {} : { password: decryptPassword }),
          }),
          ROUTE_TIMEOUT_MS,
          msg('host.syncPullTimeout'),
        )
        writeJson(res, 200, { ok: true, zipPath: result.path, snapshotId: result.snapshotId })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // ------------------------------------------------------ sync/snapshot-delete
    // 产物库「远端快照 → 删除」（2026-10-04 用户要求）：**只删远端这一份**，不动本机配置与同步基线
    // （语义与边界见 SyncEngine.deleteSnapshot）。与 /backup-files/delete、/snapshots/delete 同类，
    // 是破坏性写动作 → 过 mutation gate：并发写入被明确挡成 423，而不是两次写入互相踩。
    // 远端不存在视为成功（transport 契约），所以重复点删除不会报错。
    endpoint({ path: '/api/dsh-config-manager/sync/snapshot-delete', methods: ['POST'] }, withMutationGate('sync-snapshot-delete', async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const rawId = body['snapshotId']
        const snapshotId = typeof rawId === 'string' ? rawId.trim() : ''
        if (snapshotId === '') {
          writeJson(res, 400, { error: 'snapshotId is required' })
          return
        }
        const syncCfg = await prepareSync(body)
        const engine = makeSyncEngine(syncCfg)
        await withTimeout(engine.deleteSnapshot(snapshotId), ROUTE_TIMEOUT_MS, msg('host.syncPullTimeout'))
        writeJson(res, 200, { ok: true, snapshotId })
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    })),
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
            // cloud-sync 借鉴项 ⑥：**推送方设备身份**（写在快照 manifest 里；旧快照没有 → 字段不出现）。
            // 只回名字与稳定 id（都是本机自己写上去的展示信息，非秘密）；缺字段时绝不回空串占位，
            // 让界面能如实区分「旧快照没有这个字段」与「设备名是空的」。
            ...(typeof m.manifest.deviceName === 'string' && m.manifest.deviceName !== ''
              ? { deviceName: m.manifest.deviceName }
              : {}),
            ...(typeof m.manifest.deviceId === 'string' && m.manifest.deviceId !== ''
              ? { deviceId: m.manifest.deviceId }
              : {}),
          }))
        const state = await loadSyncState(syncDir)
        // issue #59：把「远端有但读不出来」的快照如实回传（绝不静默跳过）——
        // 否则用户看到的是「push 报成功但列表为空」这种矛盾状态，无从自查。
        const unreadable = engine.unreadableSnapshots()
        writeJson(res, 200, {
          ok: true,
          snapshots,
          currentSnapshotId: state.lastSnapshotId === '' ? undefined : state.lastSnapshotId,
          ...(unreadable.length === 0 ? {} : { unreadable: unreadable.map((u) => ({ file: u.file, reason: u.reason })) }),
        })
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
        // 用户驱动的一键同步：放行持久化选择里勾选的**全部**可选分区（自动同步只放行 'auto' 档）
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
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
          writeJson(res, 200, { ok: false, syncSessionId: '', snapshotId: preview.snapshotId, items: [], needsReview: false, compatibility: 'unsupported', message: preview.message ?? msg('route.syncPreviewFailed') })
          return
        }
        // T1：abort 处置在**预览阶段**就阻断（此刻仍零写入：临时 ZIP 与内存会话都还没登记）。
        const disposition = await resolveSessionFormatDisposition(syncDir, body['sessionFormatDisposition'])
        const blocked = sessionFormatAbortResponse(preview.plan, disposition, msg)
        if (blocked !== null) {
          writeJson(res, 409, blocked)
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
          // T1：把「读不了的会话」结构化回传（缺省 = 本机版本无法判定/没有这类会话）——
          // 同步确认页据此渲染三选一，并把这些单元默认不勾选。可选字段：旧客户端忽略。
          sessionFormats: preview.analysis.sessionFormats ?? null,
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
          writeJson(res, 400, { error: msg('route.syncSessionExpired') })
          return
        }
        // T1：abort 处置在**应用前**再判一次（客户端可能绕过 preview 直接 apply，或预览后改了处置）。
        // 此刻仍在 mutation gate 内但**尚未写任何东西**，提前 return 保证 abort 的零写入语义。
        const applyDisposition = await resolveSessionFormatDisposition(syncDir, body['sessionFormatDisposition'])
        const applyBlocked = sessionFormatAbortResponse(session.plan, applyDisposition, msg)
        if (applyBlocked !== null) {
          writeJson(res, 409, applyBlocked)
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
            if (d.resolution === undefined) throw new SyncRouteError(msg('route.syncConflictResolutionRequired', { id: item.id }))
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
          // issue #56：历史如实区分「全部成功 / 部分成功（N 项未生效）」——
          // 此前 ok:true 一律写「N 项」+ 无 error，用户在历史里看到的就是一次干净的成功。
          summary: msg('route.syncApplySummary', {
            count: Array.isArray(report.applied) ? report.applied.length : subItems.length,
            status: report.rolledBack === true ? (report.rollbackFull === false ? msg('route.syncRollbackIncomplete') : msg('route.syncRolledBack')) : '',
            ineffective: report.ineffective.length > 0 ? msg('route.syncIneffectiveSuffix', { count: report.ineffective.length }) : '',
          }),
          error: report.ok
            ? (report.ineffective.length > 0 ? msg('route.syncApplyPartial') : undefined)
            : msg('route.syncApplyFailed'),
        })
        writeJson(res, 200, historyError === undefined ? {
          ok: report.ok,
          applied: report.applied,
          skipped: subItems.map((i) => i.id),
          needsRestart: report.needsRestart === true,
          warnings: report.warnings,
          restoreId: report.restoreId,
          rolledBack: report.rolledBack,
          // 诚实性（2026-10）：整体回滚是否完整（false = 有项没恢复，失败项已并入 warnings）
          ...(report.rollbackFull === undefined ? {} : { rollbackFull: report.rollbackFull }),
          failed: report.failed,
          // issue #56：未生效项（warning）单独回传，界面据此把「成功」降级为「部分成功」
          ineffective: report.ineffective,
          result: report.result,
        } : {
          ok: report.ok,
          applied: report.applied,
          skipped: subItems.map((i) => i.id),
          needsRestart: report.needsRestart === true,
          warnings: report.warnings,
          restoreId: report.restoreId,
          rolledBack: report.rolledBack,
          // 诚实性（2026-10）：整体回滚是否完整（false = 有项没恢复，失败项已并入 warnings）
          ...(report.rollbackFull === undefined ? {} : { rollbackFull: report.rollbackFull }),
          failed: report.failed,
          ineffective: report.ineffective,
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
    // m-sync-v2：自动同步配置读写（按通道：开关 + 兜底间隔 + 启动阈值 + realtime 监听/远端轮询
    // + 自动应用等级 + 冲突策略 + 运行状态）。
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
        // 「这次 POST 是不是把开关从关拨到开」必须在覆盖字段之前拍下来（issue #105 建议 4）
        const wasEnabled = cfg.enabled
        if (typeof body['enabled'] === 'boolean') cfg.enabled = body['enabled']
        if (typeof body['interval'] === 'string' && isAutosyncInterval(body['interval'])) cfg.interval = body['interval']
        if (typeof body['startupMinIntervalMs'] === 'number' && Number.isFinite(body['startupMinIntervalMs']) && body['startupMinIntervalMs'] > 0) {
          cfg.startupMinIntervalMs = body['startupMinIntervalMs']
        }
        // 真·自动同步：本地改动即时触发开关 + 远端轮询节奏（非法值一律忽略，绝不写 NaN）
        if (typeof body['realtime'] === 'boolean') cfg.realtime = body['realtime']
        if (typeof body['remoteCheckMs'] === 'number' && Number.isFinite(body['remoteCheckMs'])) {
          cfg.remoteCheckMs = clampRemoteCheckMs(body['remoteCheckMs'])
        }
        // 自动应用等级：low = 只自动落低风险分区；medium = plugins/mcp 也自动落盘
        if (body['autoApplyTier'] === 'low' || body['autoApplyTier'] === 'medium') {
          cfg.autoApplyTier = body['autoApplyTier']
        }
        // 冲突策略：ask = 保留冲突待人工裁决；local = 保留本机并推上去（缺省）
        if (body['conflictPolicy'] === 'ask' || body['conflictPolicy'] === 'local') {
          cfg.conflictPolicy = body['conflictPolicy']
        }
        // issue #105：这里写的是**配置**，不是一轮运行结果。此前 readAutosyncConfig 读到的
        // 上一轮 lastRunMessage/lastRunSkipReason 会被原样写回（"坐实"），于是十天前那次失败的
        // 错误原文会被一次纯改间隔的保存续命，卡片上继续挂着早已不成立的故障。
        // 现在：配置落盘前清空上一轮结论 —— 配置变更 ≠ 本轮结论。
        // issue #105 建议 4：勾选开关是「用户刚刚要求它开始工作」，不该只重排定时器、让卡片
        // 继续显示上一轮（甚至是十天前）的结论。若距上次运行已超过启动阈值，立刻跑一轮。
        const runNow = shouldRunOnEnable({ enabled: wasEnabled }, cfg)
        await writeAutosyncConfig(syncDir, channel, clearLastRunResult(cfg))
        if (scheduler) {
          scheduler.reload().catch(() => { /* 尽力而为 */ })
          // 不 await：POST 是配置保存，不能让页面等一次网络同步；结果由调度器自己写进
          // sync-autosync.json / sync-history.json。并发由 runOnce 的 running 与 runs 全局防重
          // 挡住（在跑时返回 skipped 而不是排队），所以这里不需要额外门控。
          if (runNow) void scheduler.runOnce(channel, { reason: 'enable-toggle' }).catch(() => { /* 结果已落状态 */ })
        }
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
          summary: msg('route.syncRollbackSummary', { id: restoreId }),
        })
        // 诚实回传：full=false 时把 failed（含 manualHint）一并给出，界面据此列出「哪些项没回滚、
        // 需要人工补录」而不是无条件报「已回滚」。CLI 侧同口径见 src/cli/actions.ts 的 rollback 文案。
        const payload = { ok: true, full: report.full, failed: report.failed }
        writeJson(res, 200, historyError === undefined ? payload : { ...payload, historyWriteError: historyError })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    })),
    // ------------------------------------------------------ sync/merge-preview
    // T-ui-merge：远程合并**只读**预览（三方合并 + 冲突清单 + 摘要）。
    // 零写入 ⇒ 不过 mutation gate、也不登记同步会话（临时 ZIP 由引擎内部用完即清）；
    // 解密密码只走内存，响应体不含任何凭据值。
    endpoint({ path: '/api/dsh-config-manager/sync/merge-preview', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
        const opts = await mergeEngineOptions(body, syncCfg)
        const preview = await withTimeout(
          engine.previewMerge(opts),
          ROUTE_TIMEOUT_MS,
          msg('host.syncPullTimeout'),
        )
        writeJson(res, 200, preview)
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    }),
    // ------------------------------------------------------ sync/apply-merge
    // T-ui-merge：按**分区级**裁决执行合并（写动作 ⇒ mutation gate 'sync-merge-apply'）。
    // 响应直接透传引擎报告（字段与 /sync/apply-items 同风格）：其中 pendingConflicts =
    // 执行后仍待裁决的分区 —— skip 不推进同步基线，界面必须如实说明「下次同步仍会出现」。
    endpoint({ path: '/api/dsh-config-manager/sync/apply-merge', methods: ['POST'] }, withMutationGate('sync-merge-apply', async (req, res, _lockCtx, journalCtx) => {
      const body = await requireJsonObject(req)
      try {
        const syncCfg = await prepareSync(body)
        const engine = makeSyncEngine(syncCfg, { optInSections: selectionOptInSections(channelOf(syncCfg)) })
        const resolutions = extractMergeResolutions(body)
        const opts = await mergeEngineOptions(body, syncCfg)
        // snapshotBinding：与 /sync/apply-items 同口径把 journal 绑定面交给引擎（审计 P0-23），
        // restoreId 与事务日志因此同源，异常路径下回滚入口拿到的也是同一份快照。
        const report = await withTimeout(
          engine.applyMergeResolutions(resolutions, { ...opts, ...(journalCtx !== undefined ? { snapshotBinding: journalCtx } : {}) }),
          ROUTE_TIMEOUT_MS,
          msg('host.syncPullTimeout'),
        )
        writeJson(res, 200, report)
      } catch (error) {
        writeSyncRouteError(res, error)
      }
    })),
  ]
}
