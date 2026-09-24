/**
 * 路由组：插件 UI 提示状态（Star 引导 / 版本更新内容弹窗；复用 ui-prefs.json）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { PLUGIN_VERSION, STAR_PROMPT_REPO_URL } from '../index.ts'
import { readUiPrefs, updateUiPrefs } from '../sync/ui-prefs.ts'

export function prefsRoutes(env: RoutesEnv): WebRoute[] {
  const {
    syncDir,
  } = env
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
        const next = await updateUiPrefs(syncDir, patch)
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
        const next = await updateUiPrefs(syncDir, patch)
        writeJson(res, 200, {
          ok: true,
          lastSeenVersion: next.releaseNotesLastSeenVersion,
          dismissed: next.releaseNotesDismissed === true,
        })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
  ]
}
