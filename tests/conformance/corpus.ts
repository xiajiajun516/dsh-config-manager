/**
 * Bundle 一致性语料构造器（conformance corpus builder）。
 *
 * 目的：让「DSH 配置 bundle 格式 v1」可以被外部实现用同一批语料验证。
 * 这里**不重新实现导出器**——所有基线语料都由仓库真实的 Exporter 产出，
 * 只在字节层面注入畸形/未知结构，并**重算 checksums**，从而精确打到
 * `analyzeImport` 里被测的那条路径（不重算会被完整性校验先拦下，测不到目标行为）。
 *
 * 关键约定（与 `docs/spec/bundle-format-v1.md` §3 对齐）：
 *   - `integrity/checksums.json` 覆盖除 `manifest.json` 与自身之外的全部 ZIP 条目；
 *   - 改动任一数据条目后必须重算该表，否则第 4 步完整性校验直接抛错；
 *   - 每个重建后的 bundle 必须写到**独立路径**：Analyzer 有 `zipPath → Bundle`
 *     会话级缓存（`src/core/analyzer.ts` bundleCache），同路径覆写会读到旧解析结果。
 *
 * 语料只含合成数据，不含任何真实凭据/真实个人路径。
 */
import fs from 'node:fs/promises';
import { buildChecksums } from '../../src/utils/hashing.ts';
import { stringifyJsonSafe } from '../../src/utils/json.ts';
import { CHECKSUMS_FILE, MANIFEST_FILE, parseManifest } from '../../src/schema/manifest.ts';
import { parseZip, writeZip } from '../../src/utils/zip.ts';
import type { Manifest } from '../../src/schema/types.ts';

export interface BundleMutation {
  /** 修改已解析的 manifest（例如追加未知分区键、改 schemaVersion、加未知顶层字段） */
  manifest?: (m: Manifest) => Manifest | void;
  /** 追加/覆盖 ZIP 条目（例如未知分区自己的数据文件） */
  extraEntries?: { name: string; data: Uint8Array }[];
  /**
   * 是否重算 `integrity/checksums.json`，缺省 `true`。
   * 只有刻意构造「被篡改的 bundle」时才传 `false`（见 CORPUS-02）。
   */
  recomputeChecksums?: boolean;
}

/**
 * 读入 baseline bundle → 改 manifest → 追加/覆盖条目 → **重算 checksums** → 写出新 bundle。
 * 返回新 bundle 的绝对路径（调用方负责给它独立文件名）。
 */
export async function rebuildBundle(
  srcZipPath: string,
  outZipPath: string,
  mutation: BundleMutation,
): Promise<string> {
  const archive = parseZip(await readFileBytes(srcZipPath));
  const recompute = mutation.recomputeChecksums ?? true;

  // 1. 原样取出全部数据条目（不含 manifest / checksums，二者最后写）
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const name of archive.names()) {
    if (name === MANIFEST_FILE || name === CHECKSUMS_FILE) continue;
    entries.push({ name, data: archive.readEntry(name) });
  }

  // 2. 注入额外条目（同名则覆盖）
  for (const extra of mutation.extraEntries ?? []) {
    const at = entries.findIndex((e) => e.name === extra.name);
    if (at >= 0) entries[at] = { name: extra.name, data: extra.data };
    else entries.push({ name: extra.name, data: extra.data });
  }

  // 3. manifest 变更（默认原样透传）
  const base = parseManifest(archive.readEntryText(MANIFEST_FILE));
  const mutated = mutation.manifest?.(base) ?? base;

  // 4. 重算完整性表：覆盖「除 manifest 与 checksums 自身之外」的全部条目
  entries.push({
    name: CHECKSUMS_FILE,
    data: recompute
      ? Buffer.from(stringifyJsonSafe(buildChecksums(entries), { space: 2 }), 'utf8')
      : archive.readEntry(CHECKSUMS_FILE),
  });
  entries.push({
    name: MANIFEST_FILE,
    data: Buffer.from(stringifyJsonSafe(mutated, { space: 2 }), 'utf8'),
  });

  await writeZip(outZipPath, entries);
  return outZipPath;
}

/** 读 bundle 内单个条目的文本（语料断言用） */
export async function readEntryText(zipPath: string, entryName: string): Promise<string> {
  return parseZip(await readFileBytes(zipPath)).readEntryText(entryName);
}

/** 列出 bundle 内全部条目名（保持 ZIP 内顺序） */
export async function listEntries(zipPath: string): Promise<string[]> {
  return parseZip(await readFileBytes(zipPath)).names();
}

async function readFileBytes(p: string): Promise<Uint8Array> {
  return fs.readFile(p);
}
