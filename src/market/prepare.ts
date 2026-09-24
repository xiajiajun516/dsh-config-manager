/**
 * m-market：市场条目包生成（发布向导核心，docs/design/2026-08-19-market-publish-design.md §3.4）。
 *
 * 职责：把「用户配置 zip + 用户填写元数据」转换为市场条目（L2 manifest + config.zip 的
 * SHA-256 + sections），供发布向导展示与引导推送。纯函数、零磁盘写入（zipBytes 内存传入，
 * 落盘由调用方 handler 在受控临时区完成），node 可测。
 *
 * 安全硬约束（与 security.ts 同款不变量）：
 *  - id 过 assertSafeItemId（防 items/<id>/ 越界）；
 *  - repoUrl 可选但若填必须过 validateRepoUrl（拒绝 userinfo / 空白，永不注入凭据）；
 *  - zip 内 manifest 声明 containsSecrets=true → 拒绝（市场通道永不携带秘密）；
 *  - zip 走 parseZipHardened（Zip Slip / zip bomb / 路径安全）+ 体积上限。
 */
import { createHardenedZipParser } from '../security/zip-security.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { parseManifest, MANIFEST_FILE } from '../schema/manifest.ts'
import type { SectionId } from '../schema/types.ts'
import { SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts'
import { sectionMeta } from '../schema/section-registry.ts'
import { scanAndRedact, scanText } from '../security/secret-scanner.ts'
import { validateMarketRepoUrl } from './url.ts'
import {
  assertSafeItemId, BANNED_MARKET_SECTIONS, MARKET_ITEM_SCHEMA_VERSION, MAX_MARKET_ZIP_BYTES,
} from './types.ts'
import type { MarketItemManifest, MarketPublishMode } from './types.ts'

export class MarketPrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketPrepareError'
  }
}

/**
 * 分区可移植性判定（F6 share 模式排除依据）——**唯一来源 = 分区注册表**（t31）。
 *
 * 改动前这里内联了一份 15 项静态表，与 `src/adapters/*` 的 `portability` 属性、
 * `ui/export-flow.ts` 的内置目录三处并行维护（同一事实三份）。现在直接读注册表，
 * 且 `sectionMeta` 对未注册 id 会抛错（不静默按 portable 放行）。
 *
 * 读侧纪律不变：本模块仍是纯函数（注册表零 node 依赖、无副作用），不引入任何运行时状态。
 */
/** 发布输入：用户填写的条目元数据 + 配置 zip 字节。 */
export interface MarketPrepareInput {
  itemId: string
  name: string
  /** 条目版本（缺省 '1.0.0'） */
  version?: string
  description?: string
  author?: string
  categories?: string[]
  /** 作者托管仓库 URL（可选；留空表示未来与官方市场同仓，provenance.source 省略） */
  repoUrl?: string
  /** 发布模式：'migrate'（缺省，迁移全带）| 'share'（分享：排除设备/平台分区 + 强制隐私拦截） */
  mode?: MarketPublishMode
  /** 用户配置 zip 的字节（来自受控临时区） */
  zipBytes: Uint8Array
  /** 测试可注入固定时间（updatedAt）；缺省 now */
  now?: string
}

/** 发布产物：manifest 文本 + 校验摘要（供 UI 展示/复制）。 */
export interface MarketPrepareResult {
  /** items/<id>/manifest.json 内容（pretty JSON，可直接写入发布目录） */
  manifestText: string
  /** config.zip 的 SHA-256（与 manifest.checksums.zip 一致，供 UI 展示） */
  sha256: string
  /** zip 内启用的分区（与 manifest.sections 一致） */
  sections: SectionId[]
  /** 供应链警示（恒生成：发布即公开，未审核） */
  warnings: string[]
}

// 限额唯一来源 = utils/zip.ts 的 DEFAULT_ZIP_SAFETY_LIMITS（此处曾复制一份字面量，纯冗余）：
// 不传 defaultLimits → 与默认解析路径、读侧上限逐项一致。
const parseZipHardened = createHardenedZipParser()

/**
 * 由用户配置 zip 生成市场条目包（纯函数，零写入；异常一律抛 MarketPrepareError）。
 */
export function prepareMarketItem(input: MarketPrepareInput): MarketPrepareResult {
  // 0. 发布模式：缺省 migrate（迁移全带，行为与历史完全一致）
  const mode: MarketPublishMode = input.mode === 'share' ? 'share' : 'migrate'
  const isShare = mode === 'share'
  // 1. id / name 基础校验
  assertSafeItemId(input.itemId)
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new MarketPrepareError('name 必填')
  }
  // 2. repoUrl 可选校验（强制 http(s)，拒绝 userinfo / git@/ssh；非法即拒绝发布）
  const repoUrl = typeof input.repoUrl === 'string' && input.repoUrl.trim() !== '' ? input.repoUrl.trim() : undefined
  if (repoUrl !== undefined) {
    const err = validateMarketRepoUrl(repoUrl)
    if (err !== null) throw new MarketPrepareError(`repoUrl 非法: ${err}`)
  }
  // 3. zip 体积上限（zip bomb 首道闸，与 security.ts 一致）
  const buf = Buffer.isBuffer(input.zipBytes) ? input.zipBytes : Buffer.from(input.zipBytes)
  if (buf.length > MAX_MARKET_ZIP_BYTES) {
    throw new MarketPrepareError(`config.zip 体积 ${buf.length} 超过上限 ${MAX_MARKET_ZIP_BYTES} 字节`)
  }
  // 4. 加固解包（Zip Slip / 绝对路径 / 恶意条目；异常 → 拒绝）
  let archive
  try {
    archive = parseZipHardened(buf)
  } catch (err) {
    throw new MarketPrepareError(`config.zip 安全解析失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  // 5. 内部 manifest + secrets 硬约束
  if (!archive.has(MANIFEST_FILE)) {
    throw new MarketPrepareError('config.zip 缺少内部 manifest.json（须为导出/备份格式）')
  }
  let internalManifest
  try {
    internalManifest = parseManifest(archive.readEntryText(MANIFEST_FILE))
  } catch (err) {
    throw new MarketPrepareError(`config.zip 内部 manifest 无效: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (internalManifest.security.containsSecrets) {
    throw new MarketPrepareError('zip 声明 containsSecrets=true，市场通道永不携带秘密，拒绝发布')
  }
  // 6. sections = 内部 manifest 启用的分区（空 → 无可发布内容）
  const sections = (Object.entries(internalManifest.sections) as [SectionId, boolean][])
    .filter(([, on]) => on)
    .map(([id]) => id)
  if (sections.length === 0) {
    throw new MarketPrepareError('zip 无启用分区，无可发布内容')
  }
  // 6b. 市场条目禁止分区（BANNED_MARKET_SECTIONS：sessions 历史会话 / pluginFiles 任意文件 / self 本地环境）
  const bannedHit = sections.filter((s) => BANNED_MARKET_SECTIONS.includes(s))
  if (bannedHit.length > 0) {
    throw new MarketPrepareError(
      `zip 包含禁止分区 ${bannedHit.join(', ')}（sessions=历史会话 / pluginFiles=任意文件 / self=本地环境），市场条目禁止携带`,
    )
  }
  // 6b2. 分享模式额外排除：deviceSpecific/platformSpecific 分区（比 BANNED 更严，与 BANNED 同语义——直接拒绝）
  if (isShare) {
    const nonPortable = sections.filter((s) => sectionMeta(s).portability !== 'portable')
    if (nonPortable.length > 0) {
      throw new MarketPrepareError(
        `分享模式禁止携带设备/平台相关分区 ${nonPortable.join(', ')}（含凭据状态 / 会话 / MCP / 工作区等），请仅导出通用可移植分区`,
      )
    }
  }
  // 6b3. T1：plugins 分区禁止携带本地插件 tarball（localTarballs）。
  //      发布侧同样拒绝（与 market/security.ts 的导入侧检查双保险）：内嵌 tarball 是不可经公开
  //      仓库审阅的不透明二进制，安装时可能执行 postinstall —— 不得经公共市场分发去绕过
  //      BANNED 分区与逐分区批准的既有供应链防线。本地插件迁移只应发生在自己的备份里。
  if (sections.includes('plugins')) {
    const pluginsJson = archive.has(SECTION_JSON_PATHS.plugins!)
      ? (archive.readEntryJson(SECTION_JSON_PATHS.plugins!) as { localTarballs?: unknown; patchFiles?: unknown })
      : null
    const tb = pluginsJson?.localTarballs
    if (Array.isArray(tb) && tb.length > 0) {
      throw new MarketPrepareError(
        `zip 的 plugins 分区携带 ${tb.length} 个本地插件 tarball（localTarballs），禁止发布到市场（内嵌插件代码不可经公开仓库审阅；本地插件迁移请用自己的备份）`,
      )
    }
    // issue #35：patchFiles 同类拒绝（patch 在安装时改写依赖代码，同样不可经公开仓库审阅）
    const pfs = pluginsJson?.patchFiles
    if (Array.isArray(pfs) && pfs.length > 0) {
      throw new MarketPrepareError(
        `zip 的 plugins 分区携带 ${pfs.length} 个 pnpm patch 文件（patchFiles），禁止发布到市场（会在安装时改写依赖代码；请用自己的备份迁移）`,
      )
    }
  }
  // 6c. 内容级秘密扫描（纵深防御，不依赖导出 containsSecrets 标记）：
  //     migrate 模式：JSON 分区走 scanAndRedact 宽松档（literalValueOnly：占位符/模板引用/代码表达式/
  //     短标识符放行，只有值像真实字面量凭据才拦截——消除 `"token": "${ENV}"`、`Bearer <token>` 等误报）；
  //     share 模式：升级为保守档（字段名敏感即拦截，值形状优先）——分享即公开，任何敏感字段痕迹都拒绝；
  //     文件类分区（skills/agentPresets/agentInstructions）两档均走 scanText（只报告不改写）。
  const scanHits: string[] = []
  for (const sid of sections) {
    if (isFileSection(sid)) {
      const prefix = SECTION_FILE_PREFIXES[sid]!
      for (const name of archive.names().filter((n) => n.startsWith(prefix))) {
        let text: string
        try {
          text = new TextDecoder('utf-8').decode(archive.readEntry(name))
        } catch {
          continue
        }
        const hits = scanText(text)
        if (hits.length > 0) scanHits.push(`${sid}: ${hits.slice(0, isShare ? 10 : 5).map((h) => h.path).join(', ')}`)
      }
    } else {
      const jsonPath = SECTION_JSON_PATHS[sid]
      if (jsonPath === undefined || !archive.has(jsonPath)) continue
      let data: unknown
      try {
        data = archive.readEntryJson(jsonPath)
      } catch {
        continue
      }
      const { hits } = scanAndRedact(data, isShare ? {} : { literalValueOnly: true })
      if (hits.length > 0) scanHits.push(`${sid}: ${hits.slice(0, isShare ? 10 : 5).map((h) => h.path).join(', ')}`)
    }
  }
  if (scanHits.length > 0) {
    const limit = isShare ? 10 : 3
    const suffix = scanHits.length > limit ? '…' : ''
    throw new MarketPrepareError(
      `检测到疑似敏感内容（${scanHits.slice(0, limit).join('；')}${suffix}），市场条目禁止携带凭据，请脱敏后重试`,
    )
  }
  // 7. SHA-256 + 生成 L2 manifest
  const sha256 = sha256Hex(buf)
  const manifest: MarketItemManifest = {
    schemaVersion: MARKET_ITEM_SCHEMA_VERSION,
    id: input.itemId,
    name: input.name.trim(),
    version: (typeof input.version === 'string' && input.version.trim() !== '' ? input.version.trim() : '1.0.0'),
    ...(input.description !== undefined && input.description.trim() !== '' ? { description: input.description.trim() } : {}),
    ...(input.author !== undefined && input.author.trim() !== '' ? { author: input.author.trim() } : {}),
    updatedAt: input.now ?? new Date().toISOString(),
    ...(input.categories !== undefined && input.categories.length > 0
      ? { categories: input.categories.map((c) => c.trim()).filter((c) => c !== '') }
      : {}),
    // 分享模式显式落 mode 标记（下载方据此感知内容已按分享规则过滤）；migrate 缺省不写字段（向后兼容）
    ...(isShare ? { mode: 'share' as const } : {}),
    sections,
    ...(repoUrl !== undefined ? { provenance: { source: repoUrl } } : {}),
    checksums: { zip: sha256 },
  }
  return {
    manifestText: JSON.stringify(manifest, null, 2),
    sha256,
    sections,
    warnings: [
      '条目将发布至公共网络市场，未经官方审核（供应链警示）',
      '发布内容为不可信输入，下载方导入前会逐项核对',
    ],
  }
}
