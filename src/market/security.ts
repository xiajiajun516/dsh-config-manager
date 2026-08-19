/**
 * m-market：市场条目安全校验管线（docs/design/marketplace.md §6）。
 * 下载条目（config.zip）后、生成 ImportPlan 之前依次执行，全部纯函数、node 可测。
 *
 * 复用现有「不可信输入」全部能力：parseZipHardened（Zip Slip / zip bomb / 路径安全）、
 * parseManifest + validateSectionData（内部 manifest/分区）、verifyChecksums（内部完整性）、
 * sha256Hex（L2↔L3 一致）。
 *
 * 零写入原则：本模块不做任何磁盘写入（zipBytes 由调用方传入内存）；校验失败 → invalid +
 * errors[]，不进入导入预览，不落配置。
 */
import { createHardenedZipParser } from '../security/zip-security.ts';
import type { ZipSafetyLimits } from '../utils/zip.ts';
import { verifyChecksums, sha256Hex } from '../utils/hashing.ts';
import { parseManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import { validateSectionData, SECTION_JSON_PATHS, SECTION_FILE_PREFIXES, isFileSection } from '../schema/config.ts';
import type { Manifest, SectionId } from '../schema/types.ts';
import { parseMarketItemManifest } from './index-parser.ts';
import { MAX_MARKET_ZIP_BYTES, BANNED_MARKET_SECTIONS } from './types.ts';
import type { MarketItemManifest } from './types.ts';

export interface MarketItemValidationResult {
  status: 'valid' | 'invalid';
  /** 校验失败原因（invalid 时非空；valid 时为空） */
  errors: string[];
  /** 供应链警示（恒生成，URCE/时间/非官方审核）—— 由调用方投影为 MarketItemDetail.warnings */
  warnings: string[];
  /** 校验通过的清单（L2；valid 时非空） */
  manifest: MarketItemManifest | null;
  /** 从 config.zip 内部解析出的标准 Manifest（valid 时非空） */
  internalManifest: Manifest | null;
  /** L2 声明与 zip 内部 sections 的交集（valid 时非空） */
  sections: SectionId[];
  /** 内部 checksums.json 校验是否通过 */
  checksumsOk: boolean;
}

const SAFE_ZIP_LIMITS: ZipSafetyLimits = {
  maxEntries: 10_000,
  maxTotalBytes: 500 * 1024 * 1024,
  maxCompressedBytes: 200 * 1024 * 1024,
  maxSingleBytes: 100 * 1024 * 1024,
  maxRatio: 200,
};

const parseZipHardened = createHardenedZipParser(SAFE_ZIP_LIMITS);

/**
 * 校验市场条目（§6 全管线，零写入）。
 *
 * @param itemId   请求的条目 id（与目录名一致）
 * @param manifestRaw items/<id>/manifest.json 原文（L2）
 * @param zipBytes   items/<id>/config.zip 字节（L3）
 * @returns MarketItemValidationResult（恒不抛错；异常全部收敛进 errors）
 */
export function validateMarketItem(
  itemId: string,
  manifestRaw: string,
  zipBytes: Uint8Array,
): MarketItemValidationResult {
  const errors: string[] = [];
  const warnings: string[] = generateSupplyChainWarnings(itemId);

  // 1. 来源一致：manifest.json.id === itemId
  const parsedManifest = parseMarketItemManifest(manifestRaw);
  if (!parsedManifest.ok) {
    return { status: 'invalid', errors: parsedManifest.errors, warnings, manifest: null, internalManifest: null, sections: [], checksumsOk: false };
  }
  const manifest = parsedManifest.manifest!;
  if (manifest.id !== itemId) {
    return { status: 'invalid', errors: [`清单 id 与请求条目不一致: ${manifest.id} ≠ ${itemId}`], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }

  const buf = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes);

  // 2. 字节体积上限（zip bomb 首道闸）
  if (buf.length > MAX_MARKET_ZIP_BYTES) {
    return { status: 'invalid', errors: [`config.zip 体积 ${buf.length} 超过上限 ${MAX_MARKET_ZIP_BYTES} 字节`], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }

  // 3. L2↔L3 一致性：清单声明的 config.zip SHA-256 与实际一致
  const actualSha = sha256Hex(buf);
  if (manifest.checksums.zip !== actualSha) {
    return { status: 'invalid', errors: [`清单声明的 config.zip SHA-256 与实际不符`], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }

  // 4. Zip 加固解包（Zip Slip / 绝对路径 / 恶意条目 / 重复 / symlink；异常 → 拒绝整包）
  let archive;
  try {
    archive = parseZipHardened(buf);
  } catch (err) {
    return { status: 'invalid', errors: [`config.zip 安全解析失败: ${err instanceof Error ? err.message : String(err)}`], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }

  // 5. 内部 manifest + 分区校验
  if (!archive.has(MANIFEST_FILE)) {
    return { status: 'invalid', errors: ['config.zip 缺少内部 manifest.json'], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }
  let internalManifest: Manifest;
  try {
    internalManifest = parseManifest(archive.readEntryText(MANIFEST_FILE));
  } catch (err) {
    return { status: 'invalid', errors: [`config.zip 内部 manifest 无效: ${err instanceof Error ? err.message : String(err)}`], warnings, manifest, internalManifest: null, sections: [], checksumsOk: false };
  }
  if (internalManifest.security.containsSecrets) {
    return { status: 'invalid', errors: ['config.zip 声明 containsSecrets=true，市场通道永不携带秘密，拒绝'], warnings, manifest, internalManifest, sections: [], checksumsOk: false };
  }

  // 6. 内部 checksum 校验（integrity/checksums.json ↔ 实际条目）
  let checksumsOk = false;
  if (archive.has(CHECKSUMS_FILE)) {
    try {
      const table = JSON.parse(archive.readEntryText(CHECKSUMS_FILE)) as Record<string, string>;
      const entries = new Map<string, Uint8Array>();
      for (const name of archive.names()) {
        if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
        try {
          entries.set(name, archive.readEntry(name));
        } catch {
          // 损坏条目 → 完整性阶段失败
        }
      }
      const result = verifyChecksums(entries, table);
      checksumsOk = result.ok;
      if (!checksumsOk) {
        return { status: 'invalid', errors: [`config.zip 内部完整性校验失败: ${[...result.mismatches, ...result.missing].join(', ')}`], warnings, manifest, internalManifest, sections: [], checksumsOk: false };
      }
    } catch (err) {
      return { status: 'invalid', errors: [`config.zip 内部 checksums 解析失败: ${err instanceof Error ? err.message : String(err)}`], warnings, manifest, internalManifest, sections: [], checksumsOk: false };
    }
  }

  // 7. 内部分区数据校验（JSON 分区逐一 validateSectionData）
  for (const [sectionId, enabled] of Object.entries(internalManifest.sections) as [SectionId, boolean][]) {
    if (!enabled) continue;
    // 市场条目禁止分区（BANNED_MARKET_SECTIONS：sessions 历史会话 / pluginFiles 任意文件 / self 本地环境）：
    // 与 secrets 同级硬约束（产品决策 2026-08-19，guide docs/design/2026-08-19-market-repo-setup-guide.md）。
    if (BANNED_MARKET_SECTIONS.includes(sectionId)) {
      return { status: 'invalid', errors: [`config.zip 包含禁止分区 ${sectionId}（sessions=历史会话 / pluginFiles=任意文件 / self=本地环境），市场条目禁止携带`], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
    }
    if (isFileSection(sectionId)) {
      // 文件类分区：以文件形式进入 ZIP，结构校验由 security/safeExtract 在导入期做；
      // 这里只需确认前缀目录有内容（非空目录即视为有内容）。
      if (!archive.names().some((n) => n.startsWith(SECTION_FILE_PREFIXES[sectionId]!))) {
        return { status: 'invalid', errors: [`config.zip 缺少文件分区 ${sectionId}`], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
      }
      continue;
    }
    const jsonPath = SECTION_JSON_PATHS[sectionId];
    if (jsonPath === undefined) continue;
    if (!archive.has(jsonPath)) {
      return { status: 'invalid', errors: [`config.zip 缺少分区文件 ${jsonPath}（${sectionId}）`], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
    }
    let data: unknown;
    try {
      data = archive.readEntryJson(jsonPath);
    } catch (err) {
      return { status: 'invalid', errors: [`分区 ${sectionId} 数据解析失败: ${err instanceof Error ? err.message : String(err)}`], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
    }
    const issues = validateSectionData(sectionId, data);
    const hardErrors = issues.filter((i) => i.severity === 'error');
    if (hardErrors.length > 0) {
      return { status: 'invalid', errors: [`分区 ${sectionId} 数据无效: ${hardErrors.map((e) => e.message).join('; ')}`], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
    }
  }

  // 8. L2↔L3 一致性：manifest.sections 与 zip 内部 manifest.sections 取交集后至少非空（空 → 拒绝）
  const l2Sections = new Set(manifest.sections);
  const l3Sections = (Object.entries(internalManifest.sections) as [SectionId, boolean][])
    .filter(([, on]) => on)
    .map(([id]) => id);
  const intersection = l3Sections.filter((id) => l2Sections.has(id));
  if (intersection.length === 0) {
    return { status: 'invalid', errors: ['清单 sections 与 config.zip 内部 sections 无交集'], warnings, manifest, internalManifest, sections: [], checksumsOk: true };
  }

  return { status: 'valid', errors: [], warnings, manifest, internalManifest, sections: intersection, checksumsOk };
}

/**
 * 恒生成供应链警示（UI 确认前恒展示；文档 §6.7 硬不变式）。
 * 不依赖任何具体 manifest 字段 —— 只要是从市场网络下载的条目即生成。
 */
export function generateSupplyChainWarnings(itemId: string): string[] {
  return [
    `条目 ${itemId} 来自公共网络市场，未经官方审核（供应链警示）`,
    '下载内容为不可信输入，导入前请逐项核对',
  ];
}
