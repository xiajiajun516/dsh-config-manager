/**
 * 路由组：插件自身信息（Star 引导 / 版本更新内容弹窗状态；复用 ui-prefs.json）
 * 与**版本更新检查 / 自更新**（检查只读探测 npm registry，见 `core/update-check.ts` 的四条硬边界；
 * 自更新 = 用户显式点「立即更新」后的 `POST /update-apply`，见 `core/self-update.ts` 的六条硬边界）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import type { ServerResponse } from 'node:http'
import { endpoint, requireJsonObject, writeJson } from './kit.ts'
import { EnvironmentLockUnavailableError, runWithMutationLock } from '../utils/env-lock.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { PLUGIN_VERSION, STAR_PROMPT_REPO_URL } from '../index.ts'
import { readUiPrefs, updateUiPrefs } from '../sync/ui-prefs.ts'
import { UpdateChecker, wantsForcedUpdateCheck } from '../core/update-check.ts'

export function prefsRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    syncDir,
    selfUpdate,
    withMutationGate,
  } = env
  /**
   * 偏好写必须与其它写路径**同门**（④A）：ui-prefs.json 由 star-prompt / release-notes-prompt /
   * 回滚开关三个端点共写。`updateUiPrefs` 虽是 read→merge→write，但两个端点**并发**时仍会互相覆盖
   * 字段（典型：刚打开的 rollbackEnabled 被另一个端点的旧快照抹掉 ⇒ 重启后功能自己关掉，fail-closed）。
   * 被 SAFE MODE / 环境锁挡住时直接回 423 并返回 null（调用方 return，零写入）。
   */
  const writePrefsOrBlocked = async (
    res: ServerResponse,
    patch: Parameters<typeof updateUiPrefs>[1],
  ): Promise<Awaited<ReturnType<typeof updateUiPrefs>> | null> => {
    try {
      return await runWithMutationLock(
        host.mutationLock,
        { op: 'ui-prefs', target: 'star/release-notes', isBlocked: () => host.safeModeIsBlocked?.() ?? false },
        async () => await updateUiPrefs(syncDir, patch),
      )
    } catch (error) {
      if (error instanceof EnvironmentLockUnavailableError) {
        writeJson(res, 423, { error: error.message, code: 'mutation-locked' })
        return null
      }
      throw error
    }
  }
  // 版本更新检查器：每进程一个（进程内缓存 10 分钟；用户点「重新检查」走 ?force=1）。
  // 网络失败/超时/响应畸形一律结构化回传（ok:false + 原因），绝不「失败当最新」。
  const updateChecker = new UpdateChecker(PLUGIN_VERSION)
  return [
    // ------------------------------------------------------ star-prompt
    // m-star-prompt：Star 引导弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回仓库地址 + 弹窗状态（UI 挂载时判定是否展示 / 是否补记首次使用时间）；
    // POST → 局部更新（firstSeenAt / dismissed / clicked 白名单），经 updateUiPrefs
    // 合并写，不覆盖 sync/ui-prefs 的 lastSyncChannel。纯偏好、无 secret。
    endpoint({ path: '/api/dsh-config-manager/star-prompt', methods: ['GET', 'POST'] }, async (req, res) => {
      if (req.method === 'GET') {
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
      const body = await requireJsonObject(req)
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
        const next = await writePrefsOrBlocked(res, patch)
        if (next === null) return
        writeJson(res, 200, {
          ok: true,
          firstSeenAt: next.starPromptFirstSeenAt,
          dismissed: next.starPromptDismissed === true,
          clicked: next.starPromptClicked === true,
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ release-notes-prompt
    // 版本更新内容弹窗状态（复用 ui-prefs.json；随 self 分区进备份）。
    // GET → 返回当前插件版本 + 上次已读版本 + 是否永不提示；
    // POST → 局部更新（lastSeenVersion / dismissed 白名单），经 updateUiPrefs 合并写。
    endpoint({ path: '/api/dsh-config-manager/release-notes-prompt', methods: ['GET', 'POST'] }, async (req, res) => {
      if (req.method === 'GET') {
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
      const body = await requireJsonObject(req)
      try {
        const patch: Record<string, unknown> = {}
        const lastSeenVersion = body['lastSeenVersion']
        if (typeof lastSeenVersion === 'string' && lastSeenVersion.trim().length > 0) {
          patch['releaseNotesLastSeenVersion'] = lastSeenVersion.trim()
        }
        if (body['dismissed'] === true) {
          patch['releaseNotesDismissed'] = true
        }
        const next = await writePrefsOrBlocked(res, patch)
        if (next === null) return
        writeJson(res, 200, {
          ok: true,
          lastSeenVersion: next.releaseNotesLastSeenVersion,
          dismissed: next.releaseNotesDismissed === true,
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ update-check
    // 只读探测 npm 上的 latest（GET；无写操作、无凭据、不自动安装）。
    // 响应：成功 { ok:true, current, latest, updateAvailable, checkedAt, cached }；
    //       失败 { ok:false, current, error }（HTTP 仍为 200 —— 离线/registry 不可达不是插件故障，
    //       界面据 error 显示可重试的提示，不弹「插件出错」）。
    // ?force=1 绕过进程内缓存（用户显式点「重新检查」）。
    endpoint({ path: '/api/dsh-config-manager/update-check', methods: ['GET'] }, async (req, res) => {
      const force = wantsForcedUpdateCheck(req.url)
      try {
        const result = await updateChecker.check({ force })
        writeJson(res, 200, result.ok
          ? {
              ok: true,
              current: result.info.current,
              latest: result.info.latest,
              updateAvailable: result.info.updateAvailable,
              checkedAt: result.info.checkedAt,
              cached: result.cached,
            }
          : result)
      } catch (error) {
        // update-check 内部已把全部异常收成结构化结果；这里只是最后一道兜底（与全仓路由同形）。
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // ------------------------------------------------------ update-apply
    // 用户显式点「立即更新」后的**唯一写动作**：经官方 `dsh plugin` 通道把本插件升级到
    // 钉住的精确版本（校验与执行语义见 core/self-update.ts 的六条硬边界）。检查更新本身仍只读。
    // 过 withMutationGate（SAFE MODE + 环境锁；**不 journal** —— 插件安装失败是普通用户错误，
    // 不该因此记成 NEEDS_ATTENTION 事故）。预期失败以 HTTP 200 + ok:false 回传（与 update-check 同口径）。
    endpoint({ path: '/api/dsh-config-manager/update-apply', methods: ['POST'] }, withMutationGate('plugin-update', async (req, res) => {
      const body = await requireJsonObject(req)
      const version = typeof body['version'] === 'string' ? body['version'] : ''
      const result = await selfUpdate(version)
      writeJson(res, 200, result)
    }, { journaled: false })),
  ]
}
