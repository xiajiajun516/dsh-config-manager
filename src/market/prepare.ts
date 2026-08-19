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
import type { ZipSafetyLimits } from '../utils/zip.ts'
import { sha256Hex } from '../utils/hashing.ts'
import { parseManifest, MANIFEST_FILE } from '../schema/manifest.ts'
import type { SectionId } from '../schema/types.ts'
import { SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts'
import { scanAndRedact, scanText } from '../security/secret-scanner.ts'
import { validateMarketRepoUrl } from './url.ts'
import {
  assertSafeItemId, BANNED_MARKET_SECTIONS, MARKET_ITEM_SCHEMA_VERSION, MAX_MARKET_ZIP_BYTES,
} from './types.ts'
import type { MarketItemManifest } from './types.ts'

export class MarketPrepareError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketPrepareError'
  }
}

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

const SAFE_ZIP_LIMITS: ZipSafetyLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCompressedBytes: 200 * 1024 * 1024,
  maxSingleBytes: 100 * 1024 * 1024,
  maxRatio: 200,
}

const parseZipHardened = createHardenedZipParser(SAFE_ZIP_LIMITS)

/**
 * 由用户配置 zip 生成市场条目包（纯函数，零写入；异常一律抛 MarketPrepareError）。
 */
export function prepareMarketItem(input: MarketPrepareInput): MarketPrepareResult {
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
  // 6c. 内容级秘密扫描（纵深防御，不依赖导出 containsSecrets 标记）：
  //     JSON 分区走 scanAndRedact（字段名+值形状，空值/env 引用名豁免，低误报）；
  //     文件类分区（skills/agentPresets/agentInstructions）走 scanText（只报告不改写）。
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
        if (hits.length > 0) scanHits.push(`${sid}: ${hits.slice(0, 5).map((h) => h.path).join(', ')}`)
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
      const { hits } = scanAndRedact(data)
      if (hits.length > 0) scanHits.push(`${sid}: ${hits.slice(0, 5).map((h) => h.path).join(', ')}`)
    }
  }
  if (scanHits.length > 0) {
    throw new MarketPrepareError(
      `检测到疑似敏感内容（${scanHits.slice(0, 3).join('；')}…），市场条目禁止携带凭据，请脱敏后重试`,
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
