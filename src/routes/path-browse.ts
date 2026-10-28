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
 * - POST 形态只**弹系统对话框**（core/native-path-picker.ts），同样不碰盘面；不可用时回
 *   `reason:'unsupported'|'failed'`，客户端回落 GET 的内置浏览器 —— 对话框不是用户的操作死路；
 * - 空 `path` = 「此电脑」根列表（Windows 盘符探测，见 core/path-browse.ts）；
 * - 失败用枚举码回报（`error: 'not-found'|'denied'|'failed'|'not-absolute'`，成功为 null），
 *   用户可见句子由客户端按字典解析 —— 引擎不写中文；
 * - 有界：单次列举 500 条上限 + truncated 标记；整体套 withTimeout，不让一个 panic 盘符拖住请求。
 */
import { endpoint, errorMessage, queryParam, readJsonBody, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import { browseDirectory } from '../core/path-browse.ts'
import { pickNativeDirectory } from '../core/native-path-picker.ts'
import { withTimeout } from './route-support.ts'

/** 单次列举的整体时限：正常目录远快于此；网络盘悬挂时宁可报错也不让请求挂着。 */
const BROWSE_TIMEOUT_MS = 10_000

/** POST 可透传文本的长度上限：只用来当对话框的**起点**与**标题**，都不该是长文本。 */
const PICK_TEXT_MAX = 512

/** 取请求体里的短文本字段：非字符串/空串/超长一律视为未提供（对话框走缺省值，不报错）。 */
function pickText(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' || trimmed.length > PICK_TEXT_MAX ? undefined : trimmed
}

export function pathBrowseRoutes(_env: RoutesEnv): WebRoute[] {
  return [
    // ---------------------------------------------------- path-browse
    // GET  ?path=<绝对路径>：列一层目录（目录在前）。path 缺省 = 根列表。
    // POST { startPath?, title? }：弹**系统原生**目录选择器（Windows IFileOpenDialog / macOS
    //      choose folder / Linux zenity·kdialog）。回 `{ ok:false, reason:'unsupported'|'failed' }`
    //      时客户端回落到 GET 的内置浏览器 —— 同一条路径承载两种能力，避免为一个对话框新开一条路由。
    //      标题由客户端按当前语言传进来（引擎不产中文）。
    endpoint({ path: '/api/dsh-config-manager/path-browse', methods: ['GET', 'POST'] }, async (req, res) => {
      if (req.method === 'POST') {
        // 用户可能在系统对话框里逛几分钟 —— 时限由 core 的口子兜（10 分钟），此处不再叠加。
        const body = await readJsonBody(req)
        writeJson(res, 200, await pickNativeDirectory({
          startPath: pickText(body, 'startPath'),
          title: pickText(body, 'title'),
        }))
        return
      }
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
