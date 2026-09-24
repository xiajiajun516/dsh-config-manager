/**
 * 路由组：「我的配置」（固定目标仓库：状态 / 上传 / 列表 / 更新 / 下架 / 重新上架 / 删除）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { isControlledPath, isGitHubAuthMissing, parseMeForm } from '../index.ts'
import { MyRepoError, USER_CONFIGS_REPO, userConfigsRepoUrl } from '../market/my-repo.ts'
import { redact } from '../security/redaction.ts'
import fs from 'node:fs/promises'

export function meRoutes(env: RoutesEnv): WebRoute[] {
  const {
    meGitHubRest,
    meService,
    roots,
  } = env
  return [
    // ---------------------------------------------------- me/status
    // 「一键上传 / 我的配置」登录状态：resolve SYNC_CREDENTIAL_REF token → GET /user。
    // 401 → loggedIn:false（未登录）；token 值不出模块外，只回传 login 用户名。
    endpoint({ path: '/api/dsh-config-manager/me/status', methods: ['POST'] }, async (req, res) => {
      try {
        let loggedIn = false
        let login: string | undefined
        try {
          const user = await meGitHubRest.getUser()
          loggedIn = true
          login = user.login
        } catch (error) {
          // 未配置 token 与 401（token 无效/过期）同属「未登录」→ loggedIn:false；
          // 其余错误（网络/限流/服务端）向上抛，不能被伪装成「未登录」
          if (!isGitHubAuthMissing(error)) throw error
        }
        const repoUrl = login !== undefined ? userConfigsRepoUrl(login) : undefined
        const repoExists = login !== undefined ? await meGitHubRest.repoExists(login, USER_CONFIGS_REPO) : false
        writeJson(res, 200, {
          loggedIn,
          ...(login !== undefined ? { login } : {}),
          ...(repoUrl !== undefined ? { repoUrl } : {}),
          repoExists,
        })
      } catch (error) {
        writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/upload
    // 一键上传：zipPath 必须来自受控上传临时区（复用 /market/prepare 规则）；
    // form 仅 { name, description?, categories? }（name 必填）；元数据全自动由 MyRepoService 生成。
    endpoint({ path: '/api/dsh-config-manager/me/upload', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const zipPath = typeof body['zipPath'] === 'string' ? body['zipPath'] : ''
      if (zipPath === '' || !isControlledPath(zipPath, roots)) {
        writeJson(res, 400, { error: 'zipPath is required and must reference a staged upload' })
        return
      }
      const form = parseMeForm(body['form'])
      if (form === null) {
        writeJson(res, 400, { error: 'form is required and name must be a non-empty string' })
        return
      }
      try {
        const zipBytes = await fs.readFile(zipPath)
        // MyRepoService 内部已做 prepare 8 道校验 + 秘密扫描（失败 → ok:false，零推送）
        const result = await meService.upload({ zipBytes, form })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/items
    // 查看已上传：读用户仓库 index.json + 收录状态（未收录 / PR 待审核 / 已收录）。
    // 401（token 过期）→ 401 + 脱敏错误，UI 引导重新登录。
    endpoint({ path: '/api/dsh-config-manager/me/items', methods: ['POST'] }, async (req, res) => {
      try {
        const items = await meService.listItems()
        writeJson(res, 200, { items })
      } catch (error) {
        const status = isGitHubAuthMissing(error) ? 401 : 500
        writeJson(res, status, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/update
    // 一键更新：同 upload 时序；version 纯自动 +1、id 不变；PR 未合并 force push 更新 / 已合并基于最新 main 重开。
    endpoint({ path: '/api/dsh-config-manager/me/update', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const zipPath = typeof body['zipPath'] === 'string' ? body['zipPath'] : ''
      if (zipPath === '' || !isControlledPath(zipPath, roots)) {
        writeJson(res, 400, { error: 'zipPath is required and must reference a staged upload' })
        return
      }
      const form = parseMeForm(body['form'])
      if (form === null) {
        writeJson(res, 400, { error: 'form is required and name must be a non-empty string' })
        return
      }
      try {
        const zipBytes = await fs.readFile(zipPath)
        const result = await meService.update({ zipBytes, form })
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/listing
    // 查询收录/下架任务状态（结果卡轮询）：任务表命中 → 直接返回；未命中 → 回退 GitHub 实况推导；
    // 无任务且无实况 → 200 null。401（token 过期）→ 401，UI 引导重新登录。
    endpoint({ path: '/api/dsh-config-manager/me/listing', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
      if (itemId === '') {
        writeJson(res, 400, { error: 'itemId is required' })
        return
      }
      try {
        const status = await meService.listingStatus(itemId)
        writeJson(res, 200, status) // null → 200 null
      } catch (error) {
        const status = isGitHubAuthMissing(error) ? 401 : 500
        writeJson(res, status, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/relist
    // 重新提交收录（收录失败 / 进程重启丢失后的一键重试）：幂等复用已存在 fork/open PR。
    endpoint({ path: '/api/dsh-config-manager/me/relist', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
      if (itemId === '') {
        writeJson(res, 400, { error: 'itemId is required' })
        return
      }
      try {
        const status = await meService.relist(itemId)
        writeJson(res, 200, status)
      } catch (error) {
        const code = isGitHubAuthMissing(error) ? 401 : 500
        const message = error instanceof MyRepoError && error.code === 'item_not_found'
          ? 404
          : code
        writeJson(res, message, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
    // ---------------------------------------------------- me/delete
    // 删除条目：同步删用户仓库索引 + items/<id>/ 文件；已收录 → 后台异步提下架 PR；待审核 → 关闭收录 PR。
    endpoint({ path: '/api/dsh-config-manager/me/delete', methods: ['POST'] }, async (req, res) => {
      const body = await readJsonBody(req)
      const itemId = typeof body?.['itemId'] === 'string' ? body['itemId'] : ''
      if (itemId === '') {
        writeJson(res, 400, { error: 'itemId is required' })
        return
      }
      try {
        const result = await meService.deleteItem(itemId)
        writeJson(res, 200, result)
      } catch (error) {
        const code = isGitHubAuthMissing(error) ? 401 : 500
        const message = error instanceof MyRepoError && error.code === 'item_not_found'
          ? 404
          : code
        writeJson(res, message, { error: redact(error instanceof Error ? error.message : String(error)) })
      }
    }),
  ]
}
