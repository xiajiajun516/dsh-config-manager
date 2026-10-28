/**
 * 路由组：本机路径浏览（导入向导「路径映射」→ 选择本机路径弹窗的唯一数据源）。
 *
 * 为什么需要一条宿主路由：浏览器拿不到用户机器的真实目录树（File System Access API 只给 handle、
 * `<input type="file">` 只给文件名），而路径映射要求为一堆绝对路径逐个指定本机新位置。
 * 没有这条路由，用户只能凭记忆手打，打错就是「导不进」。
 *
 * 语义与边界
 * ----------
 * - **只读**：readdir/stat，绝不创建/改写/删除；不读文件内容；
 * - 空 `path` = 「此电脑」根列表（Windows 盘符探测，见 core/path-browse.ts）；
 * - 失败用枚举码回报（`error: 'not-found'|'denied'|'failed'|'not-absolute'`，成功为 null），
 *   用户可见句子由客户端按字典解析 —— 引擎不写中文；
 * - 有界：单次列举 500 条上限 + truncated 标记；整体套 withTimeout，不让一个 panic 盘符拖住请求。
 */
import { endpoint, errorMessage, queryParam, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { browseDirectory } from '../core/path-browse.ts'
import { withTimeout } from './route-support.ts'

/** 单次列举的整体时限：正常目录远快于此；网络盘悬挂时宁可报错也不让请求挂着。 */
const BROWSE_TIMEOUT_MS = 10_000

export function pathBrowseRoutes(_env: RoutesEnv): WebRoute[] {
  return [
    // ---------------------------------------------------- path-browse
    // GET ?path=<绝对路径>：列一层目录（目录在前）。path 缺省 = 根列表。
    endpoint({ path: '/api/dsh-config-manager/path-browse', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      try {
        const result = await withTimeout(
          browseDirectory(queryParam(url, 'path')),
          BROWSE_TIMEOUT_MS,
          'path browse timed out',
        )
        writeJson(res, 200, result)
      } catch (error) {
        writeJson(res, 500, { error: errorMessage(error) })
      }
    }),
  ]
}
