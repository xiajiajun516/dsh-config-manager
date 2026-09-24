/**
 * 路由组：档案（DSH 自带 profile：列表 / 详情 / 新建 / 重命名 / 删除 / 记录下次启动）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, writeJson, queryParam } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { writeProfileError } from '../index.ts'
import { DSH_PROFILE_TEMPLATES } from '../profiles/index.ts'
import type { DshProfilesSnapshot } from '../profiles/index.ts'

export function profileRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    profiles,
    tryAppendHistory,
    withMutationGate,
  } = env
  return [
    // -------------------------------------------------- m-profiles（档案 = DSH 自带 profile）
    // 「档案」= DSH 的 profile（`$DSH_HOME/profiles/<name>`）：list / detail / create / rename /
    // delete（物理删除）/ select（记录「下次启动」）。DSH **无法在运行中切换 profile** —— select
    // 只写 <dataDir>/next-profile 标记并提示用户手动重启（`dsh --profile <name>`），不做任何进程操作。
    // 安全：profile 名在 engine（+ core/plugin-cli.validateProfileName）里校验，防路径穿越/保留名；
    // 读路由过 loopback fence，写路由再叠加 mutation gate（与 destructive 操作互斥 + SAFE MODE 阻断）。
    endpoint({ path: '/api/dsh-config-manager/profiles', methods: ['GET'] }, async (req, res) => {
      try {
        writeJson(res, 200, {
          ok: true,
          profiles: profiles.list(),
          current: host.profile ?? 'web',
          selection: profiles.readSelection(),
          templates: [...DSH_PROFILE_TEMPLATES],
        } satisfies DshProfilesSnapshot & { ok: true })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    endpoint({ path: '/api/dsh-config-manager/profiles/detail', methods: ['GET'] }, async (req, res) => {
      const name = queryParam(new URL(req.url ?? '/', 'http://localhost'), 'name')
      if (name === undefined || name === '') {
        writeJson(res, 400, { error: 'name is required' })
        return
      }
      try {
        writeJson(res, 200, { ok: true, profile: profiles.detail(name) })
      } catch (error) {
        writeProfileError(res, error)
      }
    }),
    endpoint({ path: '/api/dsh-config-manager/profiles/create', methods: ['POST'] }, withMutationGate('profile-create', async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const template = typeof body['template'] === 'string' && body['template'] !== '' ? body['template'] : 'base'
      try {
        const meta = profiles.create(name, template)
        const historyError = await tryAppendHistory({
          kind: 'profile-create',
          result: 'success',
          sections: [meta.name],
          source: 'api',
          summary: `新建档案 ${meta.name}（模板 ${template}）`,
        })
        writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    endpoint({ path: '/api/dsh-config-manager/profiles/rename', methods: ['POST'] }, withMutationGate('profile-rename', async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const newName = typeof body['newName'] === 'string' ? body['newName'].trim() : ''
      try {
        const meta = profiles.rename(name, newName)
        const historyError = await tryAppendHistory({
          kind: 'profile-rename',
          result: 'success',
          sections: [name],
          source: 'api',
          summary: `重命名档案 ${name} → ${newName}`,
        })
        writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    // 物理删除整个 profile 目录（含 node_modules），不可恢复；当前运行中的档案需显式 allowCurrent。
    endpoint({ path: '/api/dsh-config-manager/profiles/delete', methods: ['POST'] }, withMutationGate('profile-delete', async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const allowCurrent = body['allowCurrent'] === true
      try {
        profiles.remove(name, { allowCurrent })
        const historyError = await tryAppendHistory({
          kind: 'profile-delete',
          result: 'success',
          sections: [name],
          source: 'api',
          summary: `删除档案 ${name}（物理删除目录）`,
        })
        writeJson(res, 200, historyError === undefined ? { ok: true } : { ok: true, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    // 「下次启动」标记（<dataDir>/next-profile）：非破坏性，但仍是写操作 → 过 mutation gate 保持一致语义。
    endpoint({ path: '/api/dsh-config-manager/profiles/select', methods: ['POST'] }, withMutationGate('profile-select', async (req, res) => {
      const body = await requireJsonObject(req)
      const raw = body['name']
      const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
      try {
        if (name === null) profiles.clearSelection()
        else profiles.writeSelection(name)
        const historyError = await tryAppendHistory({
          kind: 'profile-select',
          result: 'success',
          sections: name === null ? [] : [name],
          source: 'api',
          summary: name === null ? '取消下次启动档案设置' : `设置下次启动档案 ${name}`,
        })
        const selection = profiles.readSelection()
        writeJson(res, 200, historyError === undefined ? { ok: true, selection } : { ok: true, selection, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
  ]
}
