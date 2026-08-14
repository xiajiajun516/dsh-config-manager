/**
 * 导入安全拒绝测试（m7-tests-docs；规范 §33 Security 组 / §36 场景 F）。
 *
 * 覆盖：畸形 ZIP / 超大条目数 / checksum 不匹配（篡改与缺失）/ Zip Slip 与绝对路径条目
 * 在 Importer 端到端（analyzeImport）层面的拒绝行为。
 * 与 src/security/security.test.ts 的单元层（parseZipHardened 等）互补。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../../src/core/exporter.ts';
import { Importer } from '../../src/core/importer.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { zipToBuffer, parseZip, crc32, ZipSafetyError, type ZipWriteEntry } from '../../src/utils/zip.ts';
import { makeContext, MemSnapshotStore, type MockHostContext } from '../../src/adapters/test-helpers.ts';

const NS = ['general'];

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sec-imp-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 构造合法备份 ZIP */
async function buildValidZip(src: MockHostContext, outPath: string): Promise<void> {
  src.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
  const adapters = createAdapters({ namespaces: NS });
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath });
}

function makeImporter(dst: MockHostContext) {
  return new Importer({ ctx: dst, adapters: createAdapters({ namespaces: NS }), snapshotStore: new MemSnapshotStore() });
}

/** 手工构造原始 ZIP（任意条目名，绕过写侧校验，用于读侧攻击测试） */
function buildRawZip(entryName: string, data: Uint8Array): Uint8Array {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8); // store
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(0, 10);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(30 + nameBuf.length, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, cen, nameBuf, eocd]);
}

test('S-01 畸形 ZIP：非 ZIP 字节 → analyzeImport 拒绝', async () => {
  await withTmp(async (dir) => {
    const evil = path.join(dir, 'evil.zip');
    await fs.writeFile(evil, Buffer.from('this is not a zip file at all', 'utf8'));
    const importer = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer.analyzeImport(evil), /ZIP|manifest/);
  });
});

test('S-02 畸形 ZIP：合法但损坏的中央目录 → 拒绝', async () => {
  await withTmp(async (dir) => {
    const evil = path.join(dir, 'truncated.zip');
    const buf = zipToBuffer([{ name: 'a.txt', data: Buffer.from('hello') }]);
    await fs.writeFile(evil, buf.subarray(0, buf.length - 10)); // 截断 EOCD
    const importer = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer.analyzeImport(evil), ZipSafetyError);
  });
});

test('S-03 超大条目数：超出 maxEntries 上限 → analyzeImport 拒绝（zip bomb 条目数向量）', async () => {
  await withTmp(async (dir) => {
    const evil = path.join(dir, 'many.zip');
    // 用「有效备份」改造成大量条目：直接构造合法 ZIP 但条目数超限由 parseZip 拒绝
    const src = makeContext('win32', 'C:\\Users\\alice');
    const validZip = path.join(dir, 'valid.zip');
    await buildValidZip(src, validZip);
    const buf = await fs.readFile(validZip);

    const importer = new Importer({
      ctx: makeContext('win32', 'C:\\Users\\bob'),
      adapters: createAdapters({ namespaces: NS }),
      snapshotStore: new MemSnapshotStore(),
      limits: { maxEntries: 1 }, // 合法备份条目数 > 1 → 触发上限
    });
    await assert.rejects(() => importer.analyzeImport(validZip), /条目数/);
    assert.ok(buf.length > 0);
  });
});

test('S-04 checksum 不匹配：篡改条目内容但保留 checksums.json → 完整性失败拒绝', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await src.fs.writeFile('skills/coding.md', Buffer.from('# coding\n', 'utf8'));
    const zipPath = path.join(dir, 'valid.zip');
    await buildValidZip(src, zipPath);

    // 篡改：解包 → 改 skills 文件内容 → 原样重打包（checksums.json 未更新）
    const archive = parseZip(await fs.readFile(zipPath));
    const entries: ZipWriteEntry[] = [];
    for (const name of archive.names()) {
      if (name === 'custom/skills/coding.md') {
        entries.push({ name, data: Buffer.from('# HACKED\n', 'utf8') });
      } else {
        entries.push({ name, data: archive.readEntry(name) });
      }
    }
    const tampered = path.join(dir, 'tampered.zip');
    await fs.writeFile(tampered, zipToBuffer(entries));

    const importer = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer.analyzeImport(tampered), /完整性校验失败/);
  });
});

test('S-05 checksum 缺失条目：删除条目但 checksums.json 仍引用 → 完整性失败', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice');
    await src.fs.writeFile('skills/coding.md', Buffer.from('# coding\n', 'utf8'));
    const zipPath = path.join(dir, 'valid.zip');
    await buildValidZip(src, zipPath);

    const archive = parseZip(await fs.readFile(zipPath));
    const entries: ZipWriteEntry[] = [];
    for (const name of archive.names()) {
      if (name === 'custom/skills/coding.md') continue; // 删除该条目
      entries.push({ name, data: archive.readEntry(name) });
    }
    const missing = path.join(dir, 'missing-entry.zip');
    await fs.writeFile(missing, zipToBuffer(entries));

    const importer = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer.analyzeImport(missing), /完整性校验失败/);
  });
});

test('S-06 Zip Slip：../ 与绝对路径条目 → analyzeImport 拒绝（场景 F）', async () => {
  await withTmp(async (dir) => {
    // ../ 穿越
    const slip = path.join(dir, 'slip.zip');
    await fs.writeFile(slip, buildRawZip('../evil.txt', Buffer.from('pwned')));
    const importer1 = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer1.analyzeImport(slip), ZipSafetyError);

    // 绝对路径（win 盘符）
    const abs = path.join(dir, 'abs.zip');
    await fs.writeFile(abs, buildRawZip('C:/evil.txt', Buffer.from('pwned')));
    const importer2 = makeImporter(makeContext('win32', 'C:\\Users\\bob'));
    await assert.rejects(() => importer2.analyzeImport(abs), ZipSafetyError);
  });
});
