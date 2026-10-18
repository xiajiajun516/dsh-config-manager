/**
 * 路由组：外部 agent 来源（foreign）。
 *
 * 两条路由，职责严格分开：
 *  ① `GET  /foreign-sources` —— **只读**的本机来源发现（本机装了哪几个来源；没装的也列出来，
 *     只是 found=false）。检测与导入共用 src/foreign/registry.ts 的同一份装配，绝不各写一套路径表。
 *  ② `POST /foreign-import` —— 把一个外部来源**翻译成标准 bundle v1 ZIP**，落到受控临时目录并
 *     返回 zipPath，供既有导入向导（analyze → plan → execute）消费。
 *
 * 为什么必须由宿主做②：`source.build()` 与 `writeForeignBundle()` 要读本机文件系统、
 * 写 ZIP —— 浏览器半做不了。此前这条能力**只存在于 CLI**（`dcm import --from`），
 * 于是 GUI 能选来源、能看检测结果，却在「点导入」之后拿不到 zipPath 而断链。
 *
 * 四条硬边界：
 *  ① **只写受控临时目录**：产物落在 `env.tmpDir`（与 /upload、/decrypt-archive 同一套暂存约定），
 *     响应里的 zipPath 必须过 `isControlledPath` 自检 —— 绝不写到任何配置位置；
 *  ② **不做导入**：本路由只产包，**绝不**触碰 $DSH_HOME 下的配置。导入仍由既有
 *     /analyze → /plan → /execute 完成（导入前快照、冲突判定、dry-run 全部自动生效）；
 *  ③ **凭据值绝不进响应**：只回 skipped 机器码 + 凭据**引用名**（值在转换层就已被剥离，
 *     见 src/foreign/types.ts 的不变量①）；溯源块（origin：来源标识 / 位置 / 项目根 / 插件元数据 /
 *     跳过聚合 / 凭据引用名）同样**只含标识与计数**，绝无任何配置值；
 *  ④ **空结果不静默成功**：一个分区都产不出来 → 400 + 稳定码（与 CLI 的退出码 1 同口径），
 *     否则用户会拿到一个自检通过却什么都没有的包。
 *
 * W1（host-entry#F-02/#F-03）：围栏 / 方法白名单 / 顶层异常处理由 src/routes/kit.ts 的 endpoint() 统一提供。
 */
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import { writeForeignBundle } from '../foreign/bundle.ts'
import {
  FOREIGN_CONFLICT_POLICY,
  ForeignSourceError,
  createBuiltinForeignSourceRegistry,
  detectForeignSources,
} from '../foreign/registry.ts'
import { redact } from '../security/redaction.ts'
import type { Platform } from '../schema/types.ts'
import { endpoint, requireJsonObject, writeJson } from './kit.ts'
import type { WebRoute } from './kit.ts'
import type { RoutesEnv } from './context.ts'
import {
  FOREIGN_IMPORT_EMPTY_CODE,
  FOREIGN_IMPORT_MISSING_SOURCE_CODE,
  foreignSourceContext,
  isInsideStaging,
} from './foreign-context.ts'

/**
 * 写进 `manifest.exporter.version` 的插件版本。
 *
 * **运行时从 package.json 读取，不 import `../index.ts`** —— 这是本文件的关键约束：
 * `src/index.ts` 顶部 import 了 `@deepseek-ai/*` 运行时包，一旦本模块（路由实现）把它拉进来，
 * 任何**直接 import 本模块的单测**都会在纯单测环境 ERR_MODULE_NOT_FOUND 而根本跑不起来。
 * 既有先例：`src/cli/index.ts` 的 resolveCliVersion 用同一套解法（只依赖 node:fs）。
 *
 * 也不硬编码版本：本仓库铁律是「版本必须同步多处」，再加一个常量就等于多一个会漂移的同步点
 * （CLI 那边实测漂移过：插件升到 0.1.59 后常量仍停在 0.1.58）。读不到时回退中性占位，绝不谎报。
 */
function resolvePluginVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url)
    const parsed = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    // 包结构不可解析（被裁剪 / 单文件打包）：回退中性占位
  }
  return '0.0.0-unknown'
}

/** 进程内缓存（每个宿主进程只读一次 package.json） */
const PLUGIN_VERSION = resolvePluginVersion()

/**
 * 该来源当前版本读不了会话（不猜版本）时的稳定提示。
 *
 * 为什么宿主侧要显式传 `targetSessionFormatVersion`：会话转码必须知道目标机的格式版本，
 * 缺省时内核逐条报 session-format-version-unknown 且**不产出 sessions 分区**（绝不猜）。
 * 宿主能读到真实版本（`host.sessionFormatVersion`），所以 GUI 路径用它 —— 这与离线 CLI
 * 不同：CLI 拿不到版本，只能如实报码。
 */
export function foreignRoutes(env: RoutesEnv): WebRoute[] {
  const { host, roots, tmpDir } = env
  return [
    // ---------------------------------------------------- foreign-sources
    // 六个来源的本机检测结果（found / 命中的相对位置 / 机器码）；未安装是正常状态，不是错误。
    endpoint({ path: '/api/dsh-config-manager/foreign-sources', methods: ['GET'] }, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const projectDir = url.searchParams.get('projectDir')
      const projectScoped = projectDir !== null && projectDir !== ''
      // 与 POST / CLI 共用同一份构造（见 foreign-context.ts 的缺陷记录：三处必须同源）
      const ctx = foreignSourceContext({ projectDir: projectScoped ? (projectDir as string) : undefined })
      const sources = await detectForeignSources(createBuiltinForeignSourceRegistry(), ctx)
      writeJson(res, 200, { conflictPolicy: FOREIGN_CONFLICT_POLICY, projectScoped, sources })
    }),

    // ----------------------------------------------------- foreign-import
    // 外部来源 → 标准 bundle v1 ZIP（受控临时目录）→ zipPath。见文件头的四条硬边界。
    endpoint({ path: '/api/dsh-config-manager/foreign-import', methods: ['POST'] }, async (req, res) => {
      const body = await requireJsonObject(req)
      const sourceId = typeof body?.['source'] === 'string' ? body['source'] : ''
      if (sourceId === '') {
        writeJson(res, 400, { error: 'source is required', code: FOREIGN_IMPORT_MISSING_SOURCE_CODE })
        return
      }
      /**
       * 未知来源**最先判定**（在接触任何宿主依赖之前）。
       *
       * 为什么顺序要紧：来源 id 非法是**与运行环境无关**的请求错误，必须稳定回 400。
       * 若把它排在读取宿主环境之后，宿主状态异常时会把它淹没成 500 —— 用户从
       * 「你填错了来源」变成「插件坏了」，排查方向整个跑偏。
       */
      const registry = createBuiltinForeignSourceRegistry()
      let source
      try {
        source = registry.get(sourceId)
      } catch (error) {
        if (error instanceof ForeignSourceError) {
          // 未知来源**绝不回退**到某个默认来源（回退会让用户以为导的是 A、实际导的是 B）
          writeJson(res, 400, {
            error: error.message,
            code: error.code,
            available: error.available,
          })
          return
        }
        throw error
      }

      /**
       * projectDir 语义（与 GET 一致）：**只在请求显式给出时传入**。
       * 宿主进程的 cwd 不是用户的项目 —— 绝不猜（猜错会把 A 项目的规则导成 B 项目的）。
       */
      const rawProject = body?.['projectDir']
      const projectDir = typeof rawProject === 'string' && rawProject !== '' ? rawProject : undefined
      /**
       * 与 GET / CLI **共用同一份构造**（缺陷修复，见 foreign-context.ts 文件头）。
       *
       * 这里的 `homeDir` 必须是**用户 home**，不能用 `host.homeDir` —— 后者是 \$DSH_HOME（≈ ~/.dsh），
       * 而六来源真值表全部相对用户 home。此前写错会让 POST 去找 ~/.dsh/.claude（全部读不到 →
       * 稳定回 400 nothing-to-import），而 GET 显示 found=true，两个接口自相矛盾。
       */
      const ctx = foreignSourceContext({
        projectDir,
        // 本机能读到会话格式版本时必须传（否则会话整批不转码）；读不到就不传，内核如实报码。
        targetSessionFormatVersion: host.sessionFormatVersion,
      })

      let result
      let detection
      try {
        detection = await source.detect(ctx)
        result = await source.build(ctx)
      } catch (error) {
        writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        return
      }

      // 空结果**绝不静默成功**：自检能过，但用户拿到的是一个什么都没有的包（与 CLI 同口径）。
      if (result.sections.length === 0) {
        writeJson(res, 400, {
          error: 'nothing to import: the source has no convertible configuration on this machine',
          code: FOREIGN_IMPORT_EMPTY_CODE,
          skipped: result.skipped,
        })
        return
      }

      const outPath = path.join(tmpDir, `foreign-${source.id}-${randomBytes(6).toString('hex')}.zip`)
      try {
        await fs.mkdir(tmpDir, { recursive: true })
        await writeForeignBundle({
          result,
          outPath,
          exporterVersion: PLUGIN_VERSION,
          // 包是为「现在导入到本机」合成的 → 目标机 DSH 版本；读不到就如实标注，绝不谎报
          dshVersion: host.dshVersion ?? 'unknown',
          platform: process.platform as Platform,
          arch: process.arch,
        })
      } catch (error) {
        // 失败即清理半成品（不留孤儿 ZIP 占着 tmp）
        await fs.rm(outPath, { force: true }).catch(() => undefined)
        writeJson(res, 500, { error: redact(error instanceof Error ? error.message : String(error)) })
        return
      }

      /**
       * 自检：产物必须落在受控暂存根内。**写出去之前就多一道判定** ——
       * 这条断言的价值不是「防注入」（tmpDir 是我们自己拼的），而是把
       * 「受控目录约定」变成**运行期不变量**：将来有人改成别的目录，这里立刻红。
       */
      if (!isInsideStaging(outPath, roots)) {
        await fs.rm(outPath, { force: true }).catch(() => undefined)
        writeJson(res, 500, { error: 'bundle path escaped the controlled staging area' })
        return
      }

      let sizeBytes = 0
      try {
        sizeBytes = (await fs.stat(outPath)).size
      } catch {
        // 体积只是展示信息，读不到不影响导入（不谎报 0：留给客户端按「未知」处理）
      }

      writeJson(res, 200, {
        zipPath: outPath,
        name: path.basename(outPath),
        source: source.id,
        labelKey: source.labelKey,
        sizeBytes,
        // 分区与计数：GUI 据此显示「将导入什么」（全部是机器可读的计数，不含任何配置值）
        sections: result.sections.map((s) => s.sectionId),
        counts: result.counts,
        // 未迁移项：只有机器码 + 位置名 + 条数（**没有任何配置值**）
        skipped: result.skipped,
        // 凭据只给**引用名**（形如 mcp:gitnexus:GITHUB_TOKEN）：导入后由用户在 DSH 里补录
        credentialRefs: result.credentialRefs,
        /**
         * 溯源块（**additive**）：来源标识 / 读取位置 / 项目根 / 插件元数据 / 跳过聚合 /
         * 凭据引用名 —— 界面据此让用户核对「这包从哪来」（同一位也写进 manifest.foreign）。
         * 翻译层没给 origin 时该键**不出现**（JSON.stringify 丢弃 undefined）⇒ 旧响应逐字不变。
         */
        origin: result.origin,
        /** 检测到的本机位置（相对 home），供界面显示「从哪儿读的」 */
        detectedPaths: detection.paths,
        conflictPolicy: FOREIGN_CONFLICT_POLICY,
      })
    }),
  ]
}
