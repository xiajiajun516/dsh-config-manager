/**
 * 散文件快照 → 临时标准导出 ZIP（从 SyncEngine 拆出以保持引擎精简；行为逐字不变）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isFileSection, SECTION_FILE_PREFIXES, SECTION_JSON_PATHS } from '../schema/config.ts';
import { buildManifest, CHECKSUMS_FILE, MANIFEST_FILE } from '../schema/manifest.ts';
import type { FilesSection, Platform, SectionId } from '../schema/types.ts';
import { buildChecksums } from '../utils/hashing.ts';
import { stringifyJsonSafe } from '../utils/json.ts';
import { writeZip } from '../utils/zip.ts';
import type { ZipWriteEntry } from '../utils/zip.ts';
import { isEncryptedSections } from './transport.ts';
import type { SyncSnapshot } from './transport.ts';

export async function buildSnapshotZip(input: {
  snapshot: SyncSnapshot;
  portableIds: ReadonlySet<SectionId>;
  exporterVersion: string;
  zipDir?: string;
  stillEncryptedMessage: string;
}): Promise<string> {
  const { snapshot, portableIds } = input;
  if (isEncryptedSections(snapshot.sections)) {
    throw new Error(input.stillEncryptedMessage);
  }
  const entries: ZipWriteEntry[] = [];
  const sectionFlags = {} as Record<SectionId, boolean>;
  for (const sid of portableIds) {
    const data = snapshot.sections[sid];
    if (data === undefined) continue;
    sectionFlags[sid] = true;
    if (isFileSection(sid)) {
      const prefix = SECTION_FILE_PREFIXES[sid]!;
      const files = (data as FilesSection).files ?? [];
      for (const f of files) {
        entries.push({ name: `${prefix}${f.relativePath}`, data: f.data });
      }
    } else {
      const jsonPath = SECTION_JSON_PATHS[sid];
      if (jsonPath === undefined) continue;
      entries.push({ name: jsonPath, data: Buffer.from(stringifyJsonSafe(data, { space: 2 }), 'utf8') });
    }
  }
  const manifest = buildManifest({
    exporterVersion: input.exporterVersion,
    dshVersion: snapshot.manifest.dshVersion,
    platform: snapshot.manifest.platform as Platform,
    arch: 'unknown',
    sections: sectionFlags,
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: snapshot.createdAt,
    sourceHome: snapshot.manifest.sourceHome,
  });
  const contentEntries = entries.filter((e) => e.name !== MANIFEST_FILE && e.name !== CHECKSUMS_FILE);
  entries.push({
    name: CHECKSUMS_FILE,
    data: Buffer.from(stringifyJsonSafe(buildChecksums(contentEntries), { space: 2 }), 'utf8'),
  });
  entries.push({ name: MANIFEST_FILE, data: Buffer.from(stringifyJsonSafe(manifest, { space: 2 }), 'utf8') });

  const dir = await fs.mkdtemp(path.join(input.zipDir ?? os.tmpdir(), 'dsh-sync-pull-'));
  const zipPath = path.join(dir, 'snapshot.zip');
  await writeZip(zipPath, entries);
  return zipPath;
}
