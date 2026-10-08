/**
 * 路由组：档案（DSH 自带 profile：列表 / 详情 / 新建 / 重命名 / 删除 / 启动实例 / 停止实例）。
 *
 * W1（host-entry#F-02/#F-03）：路由只在这里声明一次 —— endpoint({ path, methods }, handler) 的
 * path/methods 就是唯一声明处；围栏、方法判定与顶层异常处理由 src/routes/kit.ts 在注册点统一提供。
 */

import { endpoint, requireJsonObject, writeJson, queryParam } from './kit.ts'
// t6：「英文界面零中文」——迁移历史 summary 一律由目录键产生（engineMsg 与宿主 msg 同源，且是活翻译器）。
import { engineMsg } from './messages.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { writeProfileError } from '../index.ts'
import { DSH_PROFILE_TEMPLATES, DshProfileError } from '../profiles/index.ts'
import type { DshProfileCopyResult, DshProfileRunningView, DshProfilesSnapshot } from '../profiles/index.ts'

export function profileRoutes(env: RoutesEnv): WebRoute[] {
  const {
    host,
    profileLauncher,
    profileRuntime,
    profiles,
    tryAppendHistory,
    withMutationGate,
  } = env

  /**
   * 「在跑的实例」合并视图 = 台账（本插件启动的，带认证 URL，可停） ∪ 心跳（任何在跑的实例，含手动启动的）。
   *
   * 为什么必须合并（用户实测的真 bug）：只认台账时，手动 `dsh web` 起来的实例对插件不可见，
   * 于是在 cmtest 的界面里还能把 web 再启动一次（同名多开）。心跳让「哪个档案在跑」对所有实例可见。
   * 同名以台账为准（它更权威：有 url/日志，且确实由本插件启动）。
   */
  const runningView = (): DshProfileRunningView[] => {
    const current = host.profile ?? 'web'
    const byName = new Map<string, DshProfileRunningView>()
    for (const record of profileRuntime.listActive()) {
      byName.set(record.name, {
        name: record.name,
        pid: record.pid,
        port: record.port,
        // 别人的 token 绝不回传（心跳里本来就不存）
        url: null,
        startedAt: record.startedAt,
        owned: false,
        current: record.name === current,
      })
    }
    for (const record of profileLauncher.listRunning()) {
      byName.set(record.name, {
        name: record.name,
        pid: record.pid,
        port: record.port,
        url: record.url,
        startedAt: record.startedAt,
        owned: true,
        current: record.name === current,
      })
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  return [
    // -------------------------------------------------- m-profiles（档案 = DSH 自带 profile）
    // 「档案」= DSH 的 profile（`$DSH_HOME/profiles/<name>`）：list / detail / create / rename /
    // delete（物理删除）/ launch（另起独立实例）/ stop（停掉自己启动的实例）。
    // DSH **无法在运行中切换 profile**（profile 只由 --profile / `dsh <名>` 决定），所以「切换」
    // 的唯一形态是另起实例；「哪个档案正跑着」也由启动器自己记录（DSH 不认识插件启动的进程）。
    // 安全：profile 名在 engine（+ core/plugin-cli.validateProfileName）里校验，防路径穿越/保留名；
    // 读路由过 loopback fence，写路由再叠加 mutation gate（与 destructive 操作互斥 + SAFE MODE 阻断）。
    endpoint({ path: '/api/dsh-config-manager/profiles', methods: ['GET'] }, async (req, res) => {
      try {
        writeJson(res, 200, {
          ok: true,
          profiles: profiles.list(),
          current: host.profile ?? 'web',
          running: runningView(),
          templates: [...DSH_PROFILE_TEMPLATES],
          // 会话格式体检的基准：UI 用它提示「这个档案产生的对话在本实例里看不到」（解析不到 = null）。
          currentSessionFormatVersion: host.sessionFormatVersion ?? null,
        } satisfies DshProfilesSnapshot & { ok: true })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }),
    // 「用该档案启动」= **真正可用**的档案切换：DSH 自身没有「默认/下次启动 profile」状态
    // （profile 只由 --profile / `dsh <名>` 决定），所以切换的唯一形态是另起一个**独立实例**。
    // 只支持 web 形态（有浏览器 GUI）：其余形态 spawn 出去只会得到用户看不见的进程，
    // 直接以 notLaunchable 拒绝（UI 给出终端命令）。
    // 失败码：notLaunchable / launcherUnavailable / launchFailed（附子进程日志尾部）/ alreadyRunning。
    // 回执里带上 running：UI 立刻把该行按钮换成「停止」，不依赖额外一次 GET。
    // **不过 mutation gate**：它不写任何配置文件，只是起进程 + 写插件自己的实例台账；而 gate 会占着
    // 环境锁直到 handler 返回（本路由最长等 20s 就绪）→ 那 20s 里导入/恢复/删除全被 423 挡住。
    endpoint({ path: '/api/dsh-config-manager/profiles/launch', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        writeJson(res, 400, { error: 'name is required' })
        return
      }
      try {
        // 「在本档案里启动自己」= 同名多开；直接拒绝（UI 上这一行根本不显示启动按钮）。
        if ((host.profile ?? 'web') === name) throw new DshProfileError('currentProfile')
        const meta = profiles.detail(name)
        const launch = await profileLauncher.launch({ name, shape: meta.shape })
        const historyError = await tryAppendHistory({
          kind: 'profile-switch',
          result: 'success',
          sections: [name],
          source: 'api',
          summary: engineMsg('route.profileLaunchSummary', { name, port: String(launch.port) }),
        })
        const running = runningView()
        writeJson(res, 200, historyError === undefined ? { ok: true, launch, running } : { ok: true, launch, running, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
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
          summary: engineMsg('route.profileCreateSummary', { name: meta.name, template }),
        })
        writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    // 复制档案：整份拷贝 `<home>/profiles/<name>` → `<newName>`（package.json 的 name 跟随改写）。
    // 为什么需要它：档案的全部差异（bundles 声明 / patch 层 / pnpm 锁文件 / 树外插件依赖）只在磁盘目录里，
    // 「按模板新建」建不出等价副本；用户要的是「拿一份可改的等价档案」。
    // body.includeNodeModules（缺省 true）决定是否连 node_modules 一起拷：true = 副本立刻可用，
    // 但体积与原档案相同且耗时（实测 285 MB ≈ 30 s）；false = 秒级完成、副本启动时会解析不到树外 bundle
    // → 回执带 warnings: ['depsNotInstalled']，UI 据此给出 `dsh plugin --profile <名> install`。
    // 过 mutation gate：它写 $DSH_HOME/profiles（与 create/rename/delete 同类）；拷贝走 async fs，
    // 期间宿主事件循环不被卡住，但环境锁会持有到 handler 返回（大档案数十秒）。
    endpoint({ path: '/api/dsh-config-manager/profiles/copy', methods: ['POST'] }, withMutationGate('profile-copy', async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const newName = typeof body['newName'] === 'string' ? body['newName'].trim() : ''
      if (name === '' || newName === '') {
        writeJson(res, 400, { error: 'name and newName are required' })
        return
      }
      try {
        const { meta, warnings, durationMs } = await profiles.copy(name, newName, {
          includeNodeModules: body['includeNodeModules'] !== false,
        })
        const copy: DshProfileCopyResult = {
          name: meta.name,
          sourceName: name,
          includeNodeModules: meta.hasNodeModules,
          durationMs,
          warnings,
        }
        const historyError = await tryAppendHistory({
          kind: 'profile-create',
          result: 'success',
          sections: [meta.name],
          source: 'api',
          summary: engineMsg('route.profileCopySummary', { from: name, to: meta.name, suffix: meta.hasNodeModules ? '' : engineMsg('route.profileCopyNoNodeModules') }),
        })
        writeJson(res, 200, historyError === undefined
          ? { ok: true, profile: meta, copy }
          : { ok: true, profile: meta, copy, historyWriteError: historyError })
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
          summary: engineMsg('route.profileRenameSummary', { from: name, to: newName }),
        })
        writeJson(res, 200, historyError === undefined ? { ok: true, profile: meta } : { ok: true, profile: meta, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    // 物理删除整个 profile 目录（含 node_modules），不可恢复；当前运行中的档案需显式 allowCurrent。
    // 额外护栏：本插件启动的实例还在跑 → instanceRunning（删掉目录会让那个实例当场失去自己的文件）。
    endpoint({ path: '/api/dsh-config-manager/profiles/delete', methods: ['POST'] }, withMutationGate('profile-delete', async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      const allowCurrent = body['allowCurrent'] === true
      try {
        if (runningView().some((r) => r.name === name)) throw new DshProfileError('instanceRunning')
        profiles.remove(name, { allowCurrent })
        const historyError = await tryAppendHistory({
          kind: 'profile-delete',
          result: 'success',
          sections: [name],
          source: 'api',
          summary: engineMsg('route.profileDeleteSummary', { name }),
        })
        writeJson(res, 200, historyError === undefined ? { ok: true } : { ok: true, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    })),
    // 「停止实例」：台账里有 → 停本插件启动的那个；否则（心跳表明是**别的**实例/手动启动的）→ 停它。
    // 都没有 → notRunning（多半已经关掉了）；停的是自己 → currentProfile（停自己会死在响应途中）；
    // 杀不掉 → stopFailed（附 pid，绝不假装成功）。
    // **不过 mutation gate**：停实例不是配置写入；何况「停止」必须在任何情况下都点得动。
    endpoint({ path: '/api/dsh-config-manager/profiles/stop', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        writeJson(res, 400, { error: 'name is required' })
        return
      }
      try {
        const owned = profileLauncher.listRunning().some((r) => r.name === name)
        const stopped = owned ? await profileLauncher.stop(name) : await profileRuntime.stopExternal(name)
        const historyError = await tryAppendHistory({
          kind: 'profile-switch',
          result: 'success',
          sections: [name],
          source: 'api',
          summary: engineMsg('route.profileStopSummary', {
            name,
            kind: owned ? engineMsg('route.profileStopOwned') : engineMsg('route.profileStopExternal'),
            port: stopped.port !== undefined ? ` :${String(stopped.port)}` : '',
          }),
        })
        const running = runningView()
        writeJson(res, 200, historyError === undefined ? { ok: true, stopped, running } : { ok: true, stopped, running, historyWriteError: historyError })
      } catch (error) {
        writeProfileError(res, error)
      }
    }),
  ]
}
