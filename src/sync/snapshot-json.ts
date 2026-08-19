/**
 * m-sync-json：SyncSnapshot 的 JSON 安全序列化 / 反序列化。
 *
 * 问题根因：文件类分区（FilesSection.files[].data）在内存中是 Uint8Array，
 * 而 `JSON.stringify` 对 TypedArray 会序列化成数字索引对象（{"0":0,"1":1,…}），
 * `JSON.parse` 读回的是普通对象而非 Uint8Array。凡是「整份快照走 JSON」的通道都会
 * 破坏文件字节 —— WebDAV（<id>.json 单文件快照）与加密载荷（整体序列化后加密）皆如此，
 * 后续 `Buffer.from(对象)` 直接抛
 * 「The "data" argument must be of type string or an instance of Buffer…」。
 *
 * 修复：序列化前把 Uint8Array 转 { "$bin": <base64> }（二进制安全且紧凑），
 * 反序列化时还原成 Uint8Array。转换只在 FilesSection.files[].data 精确位置发生，
 * 不影响普通 JSON 分区；加密快照（EncryptedSections）本身只含字符串，原样透传。
 */
import type { FilesSection, SectionData, SectionId } from '../schema/types.ts';
import { parseJsonSafe, stringifyJsonSafe } from '../utils/json.ts';
import type { EncryptedSections, SyncSnapshot } from './transport.ts';
import { isEncryptedSections } from './transport.ts';

/** 二进制数据在 JSON 中的标记对象键（base64 载荷）。 */
const BIN_KEY = '$bin';

/** duck-typing：文件类分区（version===1 + files 数组） */
function isFilesSectionLike(v: unknown): v is FilesSection {
  if (v === null || typeof v !== 'object') return false;
  const o = v as { version?: unknown; files?: unknown };
  return o.version === 1 && Array.isArray(o.files);
}

/** 单个文件分区：Uint8Array → { $bin: base64 }（非二进制原样保留）。 */
function encodeFileData(data: unknown): unknown {
  if (data instanceof Uint8Array) {
    return { [BIN_KEY]: Buffer.from(data).toString('base64') };
  }
  return data;
}

/** 单个文件分区：{ $bin: base64 } → Uint8Array（非标记对象原样保留）。 */
function decodeFileData(data: unknown): Uint8Array {
  if (data !== null && typeof data === 'object') {
    const bin = (data as Record<string, unknown>)[BIN_KEY];
    if (typeof bin === 'string') {
      // 普通 Uint8Array（非 Buffer 子类）：与内存中文件分区形态一致，深比较等价
      return new Uint8Array(Buffer.from(bin, 'base64'));
    }
  }
  return data as Uint8Array;
}

/** 单个分区 JSON 化：文件类分区逐文件转 base64；JSON 分区原样。 */
function sectionToJsonSafe(section: SectionData): SectionData {
  if (!isFilesSectionLike(section)) return section;
  return {
    version: 1,
    files: section.files.map((f) => ({
      relativePath: f.relativePath,
      data: encodeFileData(f.data) as Uint8Array,
      ...(f.contentHash !== undefined ? { contentHash: f.contentHash } : {}),
    })),
  } as FilesSection;
}

/** 单个分区从 JSON 还原：文件类分区逐文件还原 Uint8Array。 */
function sectionFromJsonSafe(section: unknown): SectionData {
  if (!isFilesSectionLike(section)) return section as SectionData;
  return {
    version: 1,
    files: section.files.map((f) => ({
      relativePath: f.relativePath,
      data: decodeFileData(f.data),
      ...(f.contentHash !== undefined ? { contentHash: f.contentHash } : {}),
    })),
  } as FilesSection;
}

/** sections 整体 JSON 化（加密密文载荷原样透传）。 */
export function sectionsToJsonSafe(sections: SyncSnapshot['sections']): SyncSnapshot['sections'] {
  if (isEncryptedSections(sections)) return sections;
  const out: Partial<Record<SectionId, SectionData>> = {};
  for (const [id, data] of Object.entries(sections as Partial<Record<SectionId, SectionData>>)) {
    out[id as SectionId] = sectionToJsonSafe(data as SectionData);
  }
  return out;
}

/** sections 从 JSON 还原（加密密文载荷原样透传）。 */
export function sectionsFromJsonSafe(sections: unknown): SyncSnapshot['sections'] {
  if (isEncryptedSections(sections)) return sections as EncryptedSections;
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error('快照 sections 必须是对象');
  }
  const out: Partial<Record<SectionId, SectionData>> = {};
  for (const [id, data] of Object.entries(sections as Record<string, unknown>)) {
    out[id as SectionId] = sectionFromJsonSafe(data);
  }
  return out;
}

/** 整份快照序列化为 JSON 字符串（本地不落盘，仅用于传输/加密载荷）。 */
export function serializeSnapshot(snapshot: SyncSnapshot): string {
  return stringifyJsonSafe({
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    manifest: snapshot.manifest,
    sections: sectionsToJsonSafe(snapshot.sections),
  });
}

/** 从 JSON 字符串还原快照（形状非法抛错；调用方负责包装成通道错误）。 */
export function deserializeSnapshot(raw: string): SyncSnapshot {
  const parsed = parseJsonSafe(raw);
  const snap = parsed as Partial<SyncSnapshot> | null;
  const okShape =
    snap !== null && typeof snap === 'object' && !Array.isArray(snap)
    && typeof snap.id === 'string'
    && typeof snap.createdAt === 'string'
    && typeof snap.manifest === 'object' && snap.manifest !== null
    && typeof snap.sections === 'object' && snap.sections !== null;
  if (!okShape) {
    throw new Error('快照 JSON 形状非法（缺少 id/createdAt/manifest/sections）');
  }
  return {
    id: (snap as { id: string }).id,
    createdAt: (snap as { createdAt: string }).createdAt,
    manifest: (snap as { manifest: SyncSnapshot['manifest'] }).manifest,
    sections: sectionsFromJsonSafe((snap as { sections: unknown }).sections),
  };
}