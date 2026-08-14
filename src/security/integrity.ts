/**
 * 配置完整性（规范 §18 / 设计 §9.7 / core utils/hashing.ts 的强化层）。
 *
 * checksums.json 实际格式由 core exporter 定死（`src/core/exporter.ts`）：
 * 扁平对象 `{ "<ZIP 内相对路径>": "<sha256 hex>" }`，覆盖除 manifest.json 与自身外的全部条目；
 * core analyzer 导入时按此解析（`as Record<string, string>`）。本模块**对齐该格式**，不擅自改结构。
 *
 * 强化点（在 core hashing 之上）：
 *  - 解析防线：结构校验（对象、值必须 64 位 hex）、条目数上限、拒绝 `__proto__`/`constructor`/`prototype`
 *    危险键（防 prototype pollution）；解析失败抛错 → 导入方归为「Backup integrity check failed」。
 *  - 一步到位 `verifyChecksumsJson`：解析 + 校验合并，供 m5/导入管线直接调用。
 *  - 校验语义：表内每个路径必须在条目集合中存在且 SHA-256 一致；缺失与不符均计入 mismatches。
 */
import { parseJsonSafe } from '../utils/json.ts';
import {
  buildChecksums as coreBuildChecksums,
  verifyChecksums as coreVerifyChecksums,
} from '../utils/hashing.ts';
import type { ChecksumVerifyResult } from '../utils/hashing.ts';

export const CHECKSUMS_ALGORITHM = 'sha256' as const;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
/** 与 core ZIP 条目数上限一致的默认表大小上限 */
export const DEFAULT_MAX_CHECKSUM_ENTRIES = 10_000;

/** 危险键（原型污染向量）：解析时拒绝 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ChecksumsTableOptions {
  maxEntries?: number;
}

/**
 * 生成 checksums 表（对齐 core 扁平格式；内部复用 core buildChecksums）。
 * entries.name 必须是 ZIP 内正斜杠相对路径。
 */
export function buildChecksums(entries: { name: string; data: Uint8Array }[]): Record<string, string> {
  return coreBuildChecksums(entries);
}

/**
 * 解析并结构校验 checksums.json 原文。
 * 非法结构 / 危险键 / 值非 SHA-256 hex / 条目数超限 → 抛错（不可信输入，宁可拒绝）。
 */
export function parseChecksumsTable(
  raw: string,
  opts: ChecksumsTableOptions = {},
): Record<string, string> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_CHECKSUM_ENTRIES;
  const parsed = parseJsonSafe(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('checksums.json 必须是 JSON 对象');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > maxEntries) {
    throw new Error(`checksums.json 条目数 ${entries.length} 超过上限 ${maxEntries}`);
  }
  const table: Record<string, string> = {};
  for (const [relPath, hash] of entries) {
    if (DANGEROUS_KEYS.has(relPath)) {
      throw new Error(`checksums.json 含危险键 "${relPath}"，已拒绝`);
    }
    if (relPath === '' || relPath.includes('\\') || relPath.startsWith('/')) {
      throw new Error(`checksums.json 含非法相对路径 "${relPath}"`);
    }
    if (typeof hash !== 'string' || !SHA256_HEX_RE.test(hash)) {
      throw new Error(`checksums.json["${relPath}"] 不是合法的 SHA-256 hex`);
    }
    table[relPath] = hash;
  }
  return table;
}

/**
 * 校验：表内每个路径必须在 entries 中存在且 SHA-256 一致；entries 多余文件（manifest/自身）不参与。
 * 返回 { ok, mismatches, missing }（缺失与不符统一列入 mismatches 的展开视图，mismatches 只含不符）。
 */
export function verifyChecksums(
  entries: ReadonlyMap<string, Uint8Array>,
  table: Record<string, string>,
): ChecksumVerifyResult {
  return coreVerifyChecksums(entries, table);
}

/** 一步到位：解析 checksums.json 原文并校验（解析失败抛错；不符返回 {ok:false,...}） */
export function verifyChecksumsJson(
  entries: ReadonlyMap<string, Uint8Array>,
  raw: string,
  opts: ChecksumsTableOptions = {},
): ChecksumVerifyResult {
  const table = parseChecksumsTable(raw, opts);
  return verifyChecksums(entries, table);
}

/** 人类可读的不匹配摘要（给「Backup integrity check failed」错误消息用） */
export function describeMismatches(result: ChecksumVerifyResult): string {
  const parts = [
    ...result.mismatches.map((m) => `"${m}" (hash 不符)`),
    ...result.missing.map((m) => `"${m}" (缺失)`),
  ];
  return parts.join(', ');
}
