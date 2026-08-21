/**
 * 安全模块测试（m4-security 验收）：
 *  encryption（往返/错密/篡改/格式）、zip-security（Zip Slip/symlink/重复名/限额/清理）、
 *  integrity（checksum 生成/校验/危险键）、secret-scanner（字段捕获/引用豁免/值形状/深度/循环）、
 *  redaction（两模式/幂等/JSON 合法）、core 注入点集成（Exporter scanner+encryption / Importer parseZipOverride）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Exporter } from '../core/exporter.ts';
import { Importer } from '../core/importer.ts';
import { createLogger, type Logger } from '../utils/logger.ts';
import { zipToBuffer, parseZip, crc32, ZipSafetyError, type ZipWriteEntry } from '../utils/zip.ts';
import { normalizePath } from '../utils/paths.ts';
import { sha256Hex } from '../utils/hashing.ts';
import { CredentialsAdapter } from '../adapters/credentials.ts';
import { parseManifest } from '../schema/manifest.ts';
import type {
  ConfigAdapter, CredentialsFacade, ExportSection, FileSystemFacade, HostContext,
  NamespaceInfo, PatchFileFacade, PluginsFacade, SettingsFacade, SnapshotStore,
  WorkspaceFacade,
} from '../core/types.ts';
import type { NamespaceRecord, SettingsSection, WorkspaceRecord } from '../schema/types.ts';
import type { Snapshot } from '../core/types.ts';

import {
  createSecretScanner, scanAndRedact, scanText, isSensitiveFieldName,
  matchSecretValuePattern, REDACTED_PLACEHOLDER, DEFAULT_SECRET_FIELD_NAMES,
} from './secret-scanner.ts';
import {
  encryptCredentials, decryptCredentials, createEncryptionProvider,
  SecurityError, SCHEMA_MAGIC, SCHEMA_VERSION, HEADER_LENGTH, SALT_LENGTH, IV_LENGTH,
  validatePasswordStrength, SCRYPT_PARAMS,
  encryptArchive, decryptArchive, verifyEncryptedBlob, isArchiveBlob, ARCHIVE_MAGIC,
} from './encryption.ts';
import {
  buildChecksums, parseChecksumsTable, verifyChecksums, verifyChecksumsJson, describeMismatches,
} from './integrity.ts';
import {
  parseZipHardened, createHardenedZipParser, safeExtractHardened, isExecutableName,
} from './zip-security.ts';
import { redact, redactValue, createRedactor, REDACTED } from './redaction.ts';

/* ================= 工具 ================= */

/** 手工构造原始 ZIP（任意条目名 / externalAttrs，绕过写侧校验，用于读侧攻击测试） */
function buildRawZip(entryName: string, data: Uint8Array, externalAttrs = 0): Uint8Array {
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
  cen.writeUInt32LE(0, 34);
  cen.writeUInt32LE(externalAttrs, 38);
  cen.writeUInt32LE(30 + nameBuf.length, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([local, nameBuf, data, cen, nameBuf, eocd]);
}

interface RawEntry { name: string; data: Uint8Array; externalAttrs?: number }
function buildRawZipMany(entries: RawEntry[]): Uint8Array {
  const localBlocks: Buffer[] = [];
  const centralBlocks: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localBlocks.push(local, nameBuf, Buffer.from(e.data));
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 34);
    cen.writeUInt32LE(e.externalAttrs ?? 0, 38);
    cen.writeUInt32LE(offset, 42);
    centralBlocks.push(cen, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(centralBlocks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localBlocks, cd, eocd]);
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sec-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/* ================= 内存 mock（core 注入点集成测试用，精简自 smoke.test.ts） ================= */

class MemFs implements FileSystemFacade {
  files = new Map<string, Uint8Array>();
  private readonly homeDir: string;
  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }
  private key(p: string): string {
    return normalizePath(path.resolve(this.homeDir, p));
  }
  async readFile(relPath: string): Promise<Uint8Array> {
    const v = this.files.get(this.key(relPath));
    if (v === undefined) throw new Error(`ENOENT: ${relPath}`);
    return v;
  }
  async writeFile(relPath: string, data: Uint8Array): Promise<void> {
    this.files.set(this.key(relPath), data);
  }
  async exists(relPath: string): Promise<boolean> {
    return this.files.has(this.key(relPath));
  }
  async copy(from: string, to: string): Promise<void> {
    const v = this.files.get(this.key(from));
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(this.key(to), v);
  }
  async remove(relPath: string): Promise<void> {
    this.files.delete(this.key(relPath));
  }
  async listRecursive(): Promise<string[]> { return []; }
  async mkdir(): Promise<void> {}
}

class MemSettings implements SettingsFacade {
  ns = new Map<string, NamespaceInfo>();
  async describe(namespace: string): Promise<NamespaceInfo> {
    const r = this.ns.get(namespace);
    if (!r) throw new Error(`namespace not found: ${namespace}`);
    return r;
  }
  async replace(namespace: string, value: unknown): Promise<void> {
    const r = this.ns.get(namespace);
    this.ns.set(namespace, { value, revision: (r?.revision ?? 0) + 1, secrets: r?.secrets ?? [] });
  }
}

class MemCredentials implements CredentialsFacade {
  values = new Map<string, string>();
  async describe(ref: string) {
    const v = this.values.get(ref);
    return { configured: v !== undefined, source: v !== undefined ? 'file' : 'env', writable: true };
  }
  async set(ref: string, value: string) { this.values.set(ref, value); }
  async unset(ref: string) { this.values.delete(ref); }
}

class MemPlugins implements PluginsFacade {
  async listInstalled() { return []; }
  async install(_pkg: string, _spec?: string) { return { needsRestart: true }; }
}

class MemWorkspace implements WorkspaceFacade {
  records = new Map<string, WorkspaceRecord>();
  async listRecords() { return [...this.records.values()]; }
  async writeRecord(r: WorkspaceRecord) { this.records.set(r.id, r); }
}

class MemPatch implements PatchFileFacade {
  async readPatchLines() { return []; }
  async applyPatchChanges() {}
}

class MemSnapshotStore implements SnapshotStore {
  snapshots = new Map<string, Snapshot>();
  async save(s: Snapshot) { this.snapshots.set(s.id, s); return s.id; }
  async load(id: string) {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`snapshot not found: ${id}`);
    return s;
  }
  async readBlob() { return new Uint8Array(); }
  async updateStatus(id: string, status: Snapshot['status']) {
    const s = this.snapshots.get(id);
    if (!s) throw new Error(`snapshot not found: ${id}`);
    s.status = status;
  }
}

class MockHostContext implements HostContext {
  platform = 'win32';
  arch = 'x64';
  homeDir: string;
  dshVersion = '0.1.0-rc.6';
  log: Logger;
  settings = new MemSettings();
  credentials = new MemCredentials();
  plugins = new MemPlugins();
  workspace = new MemWorkspace();
  patchFile = new MemPatch();
  fs: MemFs;
  constructor(homeDir: string) {
    this.homeDir = homeDir;
    this.fs = new MemFs(homeDir);
    this.log = createLogger({ level: 'error', sink: () => {} });
  }
}

class MiniSettingsAdapter implements ConfigAdapter<SettingsSection> {
  readonly id = 'settings' as const;
  readonly displayName = 'Settings';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;

  async export(ctx: HostContext): Promise<ExportSection<SettingsSection>> {
    const namespaces: Record<string, NamespaceRecord> = {};
    try {
      const info = await ctx.settings.describe('general');
      namespaces['general'] = { value: info.value, base: info.base, revision: info.revision, applies: info.applies, secrets: info.secrets };
    } catch { /* 不存在则跳过 */ }
    return { sectionId: 'settings', data: { version: 1, namespaces }, counts: { namespaces: Object.keys(namespaces).length }, warnings: [] };
  }
  async analyzeImport() { return []; }
  async applyItem() { return { ok: true }; }
  async validate() { return { valid: true, issues: [] }; }
}

/* ================= encryption ================= */

test('encryption: 往返加密解密一致（scrypt + AES-256-GCM）', async () => {
  const plaintext = 'DEEPSEEK_API_KEY: sk-super-secret-123\nGITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz\n';
  const { blob, info } = await encryptCredentials(plaintext, 'correct horse battery');
  // blob 布局
  assert.equal(Buffer.from(blob.subarray(0, 4)).toString('ascii'), SCHEMA_MAGIC);
  assert.equal(blob[4], SCHEMA_VERSION);
  assert.equal(blob.length, HEADER_LENGTH + Buffer.byteLength(plaintext, 'utf8'));
  assert.equal(info.algorithm, 'aes-256-gcm');
  assert.equal(info.kdf, 'scrypt');
  assert.deepEqual(info.kdfParams, { ...SCRYPT_PARAMS });
  assert.equal(info.version, 1);
  // 解密往返
  const decrypted = await decryptCredentials(blob, info, 'correct horse battery');
  assert.equal(decrypted, plaintext);
});

test('encryption: 错误密码 → BAD_PASSWORD（认证失败，不泄明文）', async () => {
  const { blob, info } = await encryptCredentials('sk-super-secret', 'right-password');
  await assert.rejects(
    () => decryptCredentials(blob, info, 'wrong-password'),
    (err: unknown) => err instanceof SecurityError && err.code === 'BAD_PASSWORD',
  );
});

test('encryption: 篡改 manifest 加密参数 → TAMPERED', async () => {
  const { blob, info } = await encryptCredentials('sk-super-secret', 'pw-12345678');
  // 篡改 info.authTag（元数据不一致）
  const tampered = { ...info, authTag: Buffer.from('tampered').toString('base64') };
  await assert.rejects(
    () => decryptCredentials(blob, tampered, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'TAMPERED',
  );
  // 篡改 info.salt
  await assert.rejects(
    () => decryptCredentials(blob, { ...info, salt: Buffer.alloc(SALT_LENGTH, 1).toString('base64') }, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'TAMPERED',
  );
  // 篡改密文字节 → GCM 认证失败（归为 BAD_PASSWORD：密码错误或密文被改）
  const flipped = Buffer.from(blob);
  flipped[HEADER_LENGTH] = flipped[HEADER_LENGTH]! ^ 0xff;
  await assert.rejects(
    () => decryptCredentials(flipped, info, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'BAD_PASSWORD',
  );
});

test('encryption: 截断 blob → TAMPERED；坏 magic → UNSUPPORTED_FORMAT', async () => {
  const { blob, info } = await encryptCredentials('secret', 'pw-12345678');
  await assert.rejects(
    () => decryptCredentials(blob.subarray(0, 10), info, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'TAMPERED',
  );
  const badMagic = Buffer.from(blob);
  badMagic.write('XXXX', 0, 'ascii');
  await assert.rejects(
    () => decryptCredentials(badMagic, info, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'UNSUPPORTED_FORMAT',
  );
  // kdfParams 被篡改成超大 N（DoS 向量）→ 拒绝
  await assert.rejects(
    () => decryptCredentials(blob, { ...info, kdfParams: { N: 2 ** 24, r: 8, p: 1, keyLength: 32 } }, 'pw-12345678'),
    (err: unknown) => err instanceof SecurityError && err.code === 'UNSUPPORTED_FORMAT',
  );
});

test('encryption: 每次导出 salt/iv 随机；密码绝不出现在 info 与 blob 头', async () => {
  const password = 'my-secret-password-123';
  const r1 = await encryptCredentials('value', password);
  const r2 = await encryptCredentials('value', password);
  assert.notEqual(r1.info.salt, r2.info.salt);
  assert.notEqual(r1.info.iv, r2.info.iv);
  const infoJson = JSON.stringify(r1.info);
  const infoKeys = Object.keys(r1.info);
  assert.ok(!infoKeys.some((k) => k.toLowerCase().includes('password')), 'info 不得含 password 字段');
  assert.ok(!infoJson.includes(password), '密码值不得进入 info');
  assert.ok(!Buffer.from(r1.blob.subarray(0, HEADER_LENGTH)).toString('utf8').includes(password));
});

test('encryption: createEncryptionProvider 对齐 core EncryptionProvider 契约', async () => {
  const provider = createEncryptionProvider('provider-pw-123');
  const plaintext = 'REF: value';
  const { blob, info } = await provider.encrypt(plaintext); // encrypt 无密码参数（闭包持有）
  const decrypted = await provider.decrypt(blob, info, 'provider-pw-123');
  assert.equal(decrypted, plaintext);
  // decrypt 用调用方传入的密码（换密码解密支持）
  await assert.rejects(
    () => provider.decrypt(blob, info, 'another-pw-123'),
    (err: unknown) => err instanceof SecurityError && err.code === 'BAD_PASSWORD',
  );
});

test('encryption: 密码强度校验', () => {
  assert.equal(validatePasswordStrength('short').ok, false);
  assert.equal(validatePasswordStrength('12345678').ok, true);
  assert.ok(validatePasswordStrength('abcdefghijkL1!').ok);
});

/* ---------------- 整体备份容器加密（encryptArchive / verifyEncryptedBlob / decryptArchive） ---------------- */

test('archive: 往返加解密一致（任意二进制 ZIP 字节无损）', async () => {
  const zipBytes = Buffer.from('PK\x03\x04this-is-a-real-zip-binary-content\u0000\x01\x02', 'binary');
  const password = 'archive-password-123';
  const { blob } = await encryptArchive(zipBytes, password);
  assert.ok(isArchiveBlob(blob), 'magic DCA1 可探测');
  assert.equal(Buffer.from(blob.subarray(0, 4)).toString('ascii'), ARCHIVE_MAGIC);

  const verified = await verifyEncryptedBlob(blob, password);
  assert.equal(verified.valid, true);
  assert.equal(verified.ok, true);
  assert.ok(verified.info && verified.kdf, '应返回解密参数');

  const decrypted = await decryptArchive(blob, verified.info!, verified.kdf!, password);
  assert.deepEqual(Buffer.from(decrypted), zipBytes, '解出的明文 ZIP 字节必须无损一致');
});

test('archive: 密码错误 → BAD_PASSWORD（verify 与 decrypt 都拒绝，不泄明文）', async () => {
  const zipBytes = Buffer.from('PK\x03\x04dsh-config-plaintext');
  const password = 'right-password';
  const { blob } = await encryptArchive(zipBytes, password);
  const verified = await verifyEncryptedBlob(blob, 'wrong-password');
  assert.equal(verified.valid, true);
  assert.equal(verified.ok, false);
  assert.equal(verified.code, 'BAD_PASSWORD');
  await assert.rejects(
    () => decryptArchive(blob, verified.info!, verified.kdf!, 'wrong-password'),
    (err: unknown) => err instanceof SecurityError && err.code === 'BAD_PASSWORD',
  );
});

test('archive: 非容器字节 → valid=false（体积不足判 TAMPERED；magic 不符判 UNSUPPORTED_FORMAT）', async () => {
  const tooShort = Buffer.from('PK\x03\x04plain-zip-not-encrypted');
  assert.equal(isArchiveBlob(tooShort), false);
  const v = await verifyEncryptedBlob(tooShort, 'pw');
  assert.equal(v.valid, false);
  assert.equal(v.code, 'TAMPERED', '体积不足 → TAMPERED');

  // 长度足够的非容器字节 → magic 不符 → UNSUPPORTED_FORMAT
  const fullLen = Buffer.alloc(64);
  fullLen.write('PK\x03\x04', 0, 'binary');
  const v2 = await verifyEncryptedBlob(fullLen, 'pw');
  assert.equal(v2.valid, false);
  assert.equal(v2.code, 'UNSUPPORTED_FORMAT');
});

test('archive: 篡改密文 → verify ok=false（GCM 认证失败）', async () => {
  const { blob } = await encryptArchive(Buffer.from('sensitive-archive'), 'archive-pw-123');
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
  const verified = await verifyEncryptedBlob(tampered, 'archive-pw-123');
  assert.equal(verified.valid, true);
  assert.equal(verified.ok, false, '篡改后密码验证必失败');
});

/* ================= zip-security ================= */

test('zip-security: parseZipHardened 兼容 core 正常 ZIP', () => {
  const buf = zipToBuffer([
    { name: 'a/b.txt', data: Buffer.from('hello') },
    { name: 'c.json', data: Buffer.from('{"x":1}') },
  ]);
  const archive = parseZipHardened(buf);
  assert.deepEqual(archive.names(), ['a/b.txt', 'c.json']);
  assert.equal(Buffer.from(archive.readEntry('a/b.txt')).toString(), 'hello');
});

test('zip-security: Zip Slip / 绝对路径 / 盘符 / UNC / NUL 拒绝', () => {
  const evil = [
    ['../evil.txt', '目录穿越'],
    ['..\\evil.txt', '反斜杠穿越'],
    ['a/../../evil.txt', '深层穿越'],
    ['/abs/path', '绝对路径'],
    ['C:/evil.txt', '盘符'],
    ['C:\\evil.txt', '盘符反斜杠'],
    ['\\\\server\\share', 'UNC'],
    ['a\0b.txt', 'NUL'],
  ] as const;
  for (const [name, label] of evil) {
    assert.throws(() => parseZipHardened(buildRawZip(name, Buffer.from('x'))), ZipSafetyError, `应拒绝 ${label}: ${name}`);
  }
});

test('zip-security: symlink 条目（external attrs S_IFLNK）拒绝', () => {
  const symlinkAttrs = (0xa1ff << 16) >>> 0; // S_IFLNK | 0777
  assert.throws(
    () => parseZipHardened(buildRawZip('link', Buffer.from('target'), symlinkAttrs)),
    /符号链接/,
  );
  // 普通文件 mode 不误伤
  const normalAttrs = (0x81a4 << 16) >>> 0; // S_IFREG | 0644
  const ok = parseZipHardened(buildRawZip('file.txt', Buffer.from('x'), normalAttrs));
  assert.deepEqual(ok.names(), ['file.txt']);
});

test('zip-security: 重复条目名拒绝', () => {
  const buf = buildRawZipMany([
    { name: 'a.txt', data: Buffer.from('first') },
    { name: 'a.txt', data: Buffer.from('second') },
  ]);
  assert.throws(() => parseZipHardened(buf), /重复/);
});

test('zip-security: 条目数超限 / 压缩体积超限拒绝', () => {
  const two = buildRawZipMany([
    { name: 'a.txt', data: Buffer.from('a') },
    { name: 'b.txt', data: Buffer.from('b') },
  ]);
  assert.throws(() => parseZipHardened(two, { maxEntries: 1 }), /条目数/);
  // 压缩体积上限（store 条目 compSize = 数据长度；2 条各 1B，上限 1 则第二条触发）
  assert.throws(() => parseZipHardened(two, { maxCompressedBytes: 1 }), /压缩数据总量/);
});

test('zip-security: safeExtractHardened 正常解压 + 可执行文件告警', async () => {
  await withTmp(async (dir) => {
    const zipPath = path.join(dir, 'x.zip');
    const destDir = path.join(dir, 'out');
    await fs.writeFile(zipPath, zipToBuffer([
      { name: 'custom/skills/a.md', data: Buffer.from('# skill') },
      { name: 'plugin-files/x.sh', data: Buffer.from('#!/bin/sh') },
    ]));
    const result = await safeExtractHardened(zipPath, destDir);
    assert.deepEqual(result.files.sort(), ['custom/skills/a.md', 'plugin-files/x.sh']);
    assert.ok(result.warnings.some((w) => w.includes('x.sh')), '可执行文件应产生告警');
    const content = await fs.readFile(path.join(destDir, 'custom', 'skills', 'a.md'), 'utf8');
    assert.equal(content, '# skill');
  });
});

test('zip-security: 解压中途失败 → 中止并完整清理目标目录', async () => {
  await withTmp(async (dir) => {
    const zipPath = path.join(dir, 'bomb.zip');
    const destDir = path.join(dir, 'out');
    // 条目 1 正常写入，条目 2 高压缩比（zip bomb 模拟）→ readEntry 触发 ratio 上限
    await fs.writeFile(zipPath, zipToBuffer([
      { name: 'ok.txt', data: Buffer.from('written-first') },
      { name: 'bomb.txt', data: Buffer.from('a'.repeat(50_000)) },
    ]));
    await assert.rejects(
      () => safeExtractHardened(zipPath, destDir, { maxRatio: 5 }),
      ZipSafetyError,
    );
    await assert.rejects(() => fs.access(destDir), /ENOENT/, '失败后目标目录应被完整清理');
  });
});

test('zip-security: createHardenedZipParser 签名对齐 parseZipOverride', () => {
  const parser = createHardenedZipParser({ maxEntries: 100 });
  const archive = parser(zipToBuffer([{ name: 'a.txt', data: Buffer.from('x') }]), { maxEntries: 50 });
  assert.deepEqual(archive.names(), ['a.txt']);
  assert.equal(isExecutableName('run.sh'), true);
  assert.equal(isExecutableName('readme.md'), false);
});

/* ================= integrity ================= */

test('integrity: checksums 生成与校验（匹配/不符/缺失）', () => {
  const entries = [
    { name: 'config/settings.json', data: Buffer.from('{"a":1}') },
    { name: 'custom/skills/a.md', data: Buffer.from('# hi') },
  ];
  const table = buildChecksums(entries);
  assert.equal(table['config/settings.json'], sha256Hex(Buffer.from('{"a":1}')));
  assert.equal(Object.keys(table).length, 2);

  const map = new Map(entries.map((e) => [e.name, e.data]));
  assert.deepEqual(verifyChecksums(map, table), { ok: true, mismatches: [], missing: [] });
  // 内容被改 → mismatches
  const tampered = new Map(map);
  tampered.set('config/settings.json', Buffer.from('{"a":2}'));
  const r1 = verifyChecksums(tampered, table);
  assert.equal(r1.ok, false);
  assert.deepEqual(r1.mismatches, ['config/settings.json']);
  // 缺文件 → missing
  const missing = new Map<string, Uint8Array>();
  missing.set('config/settings.json', map.get('config/settings.json')!);
  const r2 = verifyChecksums(missing, table);
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.missing, ['custom/skills/a.md']);
  assert.ok(describeMismatches(r2).includes('custom/skills/a.md'));
});

test('integrity: parseChecksumsTable 结构校验（hex/危险键/非法路径/非对象）', () => {
  const table = parseChecksumsTable(JSON.stringify({ 'a/b.txt': sha256Hex(Buffer.from('x')) }));
  assert.equal(table['a/b.txt'], sha256Hex(Buffer.from('x')));
  // 非 hex 值
  assert.throws(() => parseChecksumsTable(JSON.stringify({ 'a/b.txt': 'zzz' })), /SHA-256/);
  // 危险键（原型污染；注意对象字面量 '__proto__' 会被当原型设置，须用字符串构造 JSON）
  assert.throws(() => parseChecksumsTable(`{"__proto__": "${sha256Hex(Buffer.from('x'))}"}`), /危险键/);
  assert.throws(() => parseChecksumsTable(`{"constructor": "${sha256Hex(Buffer.from('x'))}"}`), /危险键/);
  // 反斜杠路径（非 ZIP 正斜杠形态）
  assert.throws(() => parseChecksumsTable(JSON.stringify({ 'a\\b.txt': sha256Hex(Buffer.from('x')) })), /非法相对路径/);
  // 非对象 / 值非 hex
  assert.throws(() => parseChecksumsTable('[1,2]'), /必须是 JSON 对象/);
  assert.throws(() => parseChecksumsTable(JSON.stringify({ 'a/b.txt': 'not-a-hash' })), /SHA-256/);
});

test('integrity: verifyChecksumsJson 一步到位（不匹配 → ok:false）', () => {
  const entries = new Map<string, Uint8Array>([['a.txt', Buffer.from('x')]]);
  const raw = JSON.stringify({ 'a.txt': sha256Hex(Buffer.from('y')) });
  const result = verifyChecksumsJson(entries, raw);
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatches, ['a.txt']);
});

/* ================= secret-scanner ================= */

test('scanner: 捕获敏感字段并剥离（多形态/大小写不敏感），不改原对象', () => {
  const original = {
    apiKey: 'sk-abc123',
    API_KEY: 'v1',
    'api-key': 'v2',
    GithubToken: 'ghp_abcdefghijklmnopqrstuvwxyz',
    client_secret: 'cs1',
    privateKey: 'pk1',
    Authorization: 'Bearer xyz',
    passwd: 'p1',
    theme: 'dark', // 不敏感
    monkey: 'banana', // key 后缀不误伤
    sessionIds: ['s1'], // session 不误伤
    nested: { credential: 'c1', ok: true },
    list: [{ token: 't1' }, { title: 'ok' }],
  };
  const before = structuredClone(original);
  const { sanitized, hits } = scanAndRedact(original);
  // 原对象未被修改
  assert.deepEqual(original, before);
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['apiKey'], REDACTED_PLACEHOLDER);
  assert.equal(s['API_KEY'], REDACTED_PLACEHOLDER);
  assert.equal(s['api-key'], REDACTED_PLACEHOLDER);
  assert.equal(s['GithubToken'], REDACTED_PLACEHOLDER);
  assert.equal(s['client_secret'], REDACTED_PLACEHOLDER);
  assert.equal(s['privateKey'], REDACTED_PLACEHOLDER);
  assert.equal(s['Authorization'], REDACTED_PLACEHOLDER);
  assert.equal(s['passwd'], REDACTED_PLACEHOLDER);
  assert.equal(s['theme'], 'dark');
  assert.equal(s['monkey'], 'banana');
  assert.deepEqual(s['sessionIds'], ['s1']);
  assert.equal((s['nested'] as Record<string, unknown>)['credential'], REDACTED_PLACEHOLDER);
  assert.equal((s['nested'] as Record<string, unknown>)['ok'], true);
  assert.equal(((s['list'] as unknown[])[0] as Record<string, unknown>)['token'], REDACTED_PLACEHOLDER);
  // hits 记录路径
  const paths = hits.map((h) => h.path).sort();
  assert.ok(paths.includes('apiKey'));
  assert.ok(paths.includes('list[0].token'));
  assert.ok(paths.includes('nested.credential'));
  assert.ok(hits.every((h) => !JSON.stringify(h).includes('sk-abc123')), 'hits 不得含值');
});

test('scanner: 引用豁免（apiKeyEnv 等只存名字的字段、env 名形态值）', () => {
  const input = {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    api_key_env: 'GITHUB_TOKEN',
    apiKey: 'DEEPSEEK_API_KEY', // 值是 env 变量名形态 → 视为引用
    realKey: 'sk-proj-9f8e7d6c5b4a3210abcdef', // 真实形态密钥 → 仍拦截
    tokenRef: 'MY_TOKEN_REF',
  };
  const { sanitized } = scanAndRedact(input);
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['apiKeyEnv'], 'DEEPSEEK_API_KEY');
  assert.equal(s['api_key_env'], 'GITHUB_TOKEN');
  assert.equal(s['apiKey'], 'DEEPSEEK_API_KEY');
  assert.equal(s['realKey'], REDACTED_PLACEHOLDER);
  assert.equal(s['tokenRef'], 'MY_TOKEN_REF');
});

test('scanner: 值形状启发式（字段名无关的 secret 形状也剥离）', () => {
  const input = {
    note: 'use sk-abc1234567890abc for api',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    aws: 'AKIAIOSFODNN7A1B2C3D4',
    github: 'ghp_abcdefghijklmnopqrstuvwxyz',
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...',
    fine: 'just a note',
  };
  const { sanitized, hits } = scanAndRedact(input);
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['note'], REDACTED_PLACEHOLDER, 'sk- 形状应剥离');
  assert.equal(s['jwt'], REDACTED_PLACEHOLDER, 'JWT 应剥离');
  assert.equal(s['aws'], REDACTED_PLACEHOLDER, 'AKIA 应剥离');
  assert.equal(s['github'], REDACTED_PLACEHOLDER, 'ghp_ 应剥离');
  assert.equal(s['pem'], REDACTED_PLACEHOLDER, 'PEM 私钥应剥离');
  assert.equal(s['fine'], 'just a note');
  assert.ok(hits.length >= 5);
  assert.equal(matchSecretValuePattern('sk-abc1234567890abc'), 'openai-style-key');
  assert.equal(matchSecretValuePattern('plain text'), null);
});

test('scanner: 值形状示例/占位形态放行（sk-your-*、AKIA...EXAMPLE、JWT 教学串）', () => {
  const input = {
    yourKey: 'sk-your-api-key-here',            // 占位词 your
    exampleKey: 'sk-example-key-12345',          // 占位词 example
    testKey: 'sk-test-key-1234567890',           // 占位词 test
    awsSample: 'AKIAIOSFODNN7EXAMPLE',           // AWS 官方文档示例 key
    jwtSample: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature', // 教学串第三段 signature
    note: 'use sk-your-demo-key for api',        // 文本叙述中的示例
  };
  const { sanitized, hits } = scanAndRedact(input);
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['yourKey'], 'sk-your-api-key-here', 'sk-your-* 示例应放行');
  assert.equal(s['exampleKey'], 'sk-example-key-12345', 'sk-example-* 示例应放行');
  assert.equal(s['testKey'], 'sk-test-key-1234567890', 'sk-test-* 示例应放行');
  assert.equal(s['awsSample'], 'AKIAIOSFODNN7EXAMPLE', 'AWS 官方示例应放行');
  assert.equal(s['jwtSample'], 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature', 'JWT 教学串应放行');
  assert.equal(s['note'], 'use sk-your-demo-key for api', '叙述中的示例应放行');
  assert.equal(hits.length, 0);
});

test('scanner: 深层嵌套上限（≤64 通过，超限抛错）与循环引用防护', () => {
  const deep = (n: number): unknown => {
    let v: unknown = 'leaf';
    for (let i = 0; i < n; i++) v = { x: v };
    return v;
  };
  assert.doesNotThrow(() => scanAndRedact({ a: deep(60) }));
  assert.throws(() => scanAndRedact({ a: deep(70) }), /深度/);
  // 循环引用：不挂死，明确抛错
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic['self'] = cyclic;
  assert.throws(() => scanAndRedact(cyclic), /循环引用/);
});

test('scanner: Uint8Array 跳过、数组根、空字符串不报 hit、extra 名单扩展', () => {
  const bin = new Uint8Array([1, 2, 3]);
  const input = { data: bin, empty: '', clientSecret2: 'x', normal: 42 };
  const { sanitized, hits } = scanAndRedact(input, { extraFieldNames: ['clientsecret2'] });
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['data'], bin);
  assert.equal(s['empty'], '');
  assert.equal(s['clientSecret2'], REDACTED_PLACEHOLDER, 'extra 名单生效');
  assert.equal(s['normal'], 42);
  assert.equal(hits.length, 1);
  // 数组根
  const arr = scanAndRedact([{ token: 'x' }]);
  assert.equal(((arr.sanitized as { token: string }[])[0] as { token: string }).token, REDACTED_PLACEHOLDER);
});

test('scanner: isSensitiveFieldName / createSecretScanner（core 契约）', () => {
  assert.equal(isSensitiveFieldName('apiKey'), true);
  assert.equal(isSensitiveFieldName('API_KEY'), true);
  assert.equal(isSensitiveFieldName('github_token'), true);
  assert.equal(isSensitiveFieldName('theme'), false);
  assert.equal(isSensitiveFieldName('sessionIds'), false);
  assert.equal(isSensitiveFieldName('monkey'), false);
  assert.ok(DEFAULT_SECRET_FIELD_NAMES.includes('apikey'));

  const scanner = createSecretScanner({ valuePatterns: true });
  const r = scanner.scanAndRedact({ token: 'sk-abc1234567890abc' });
  assert.equal((r.sanitized as Record<string, unknown>)['token'], REDACTED_PLACEHOLDER);
  // scanText 可选方法存在（文件类分区文本扫描）
  const textHits = scanner.scanText!('apiKey = sk-abc1234567890abc\nBearer xyz1234567890abcdef\nplain line');
  assert.ok(textHits.length >= 2, `应命中字段形态与值形状，实际 ${textHits.length}`);
  assert.ok(textHits.some((h) => h.path.startsWith('line:')));
});

test('scanText: 技能/代码文档中的示例命名不再误报（2026-08-20 优化）', () => {
  // 真实技能文件（api-tester.md / frontend-developer.md 等）里出现过的代码示例形态 —— 全部应放行
  const skillDoc = [
    'let authToken: string;',                       // 类型声明（值=string 类型词）
    'password: process.env.TEST_USER_PASSWORD',      // 代码引用（含 . 与 (）—— 注意 field: value 正则截取 value 为 process.env.TEST_USER_PASSWORD
    'authToken = data.token;',                       // 赋值 + 成员访问
    'const token = loginResponse.json(\'token\');',  // 方法调用
    'key={virtualItem.key}',                         // React key prop（key 不入敏感名单）
    'queryKey: [\'products\'],',                     // 数组字面量
    'token: your-token-here',                        // 占位符
    'api_key: <your-key>',                           // 占位符
    'max_tokens: 100',                               // 值=数字…… 但正则只匹配 \w+；"100" 是短标识符？100 长3 <20 → 放行 ✓
  ].join('\n');
  const hits = scanText(skillDoc);
  assert.equal(hits.length, 0, `技能文档示例不应误报，实际: ${JSON.stringify(hits)}`);
});

test('scanText: 真实字面量密钥仍然拦截（优化不回退安全）', () => {
  // 字段名敏感 + 真正的字面量长串 → 报
  const real = [
    'password: s3cretP@ssw0rdXyZ2024',              // 字段 password + 混合字面量长串
    'client_secret: abcdef1234567890abcdef12345678', // 字段敏感 + 长混合串
    '"apiKey": "sk-proj-abcdef1234567890"',          // JSON 形态 + sk- 值形状（强信号）
    'token=ghp_abcdefghijklmnopqrstuvwxyzABCDEF',    // GitHub PAT 值形状
  ].join('\n');
  const hits = scanText(real);
  assert.ok(hits.length >= 4, `真实密钥应全部拦截，实际: ${JSON.stringify(hits)} (${hits.length})`);
});

test('scanText: 占位/示例/模板引用/普通示例值放行（2026-08-21 优化）', () => {
  const doc = [
    'token: ${OPENAI_API_KEY}',                    // 模板引用
    'api_key: {{MY_KEY}}',                          // 模板引用（双花括号）
    'secret: $ENV_SECRET',                          // $VAR 引用
    'password: your-token-here',                    // 占位符
    'token: abc-def-ghi-jkl',                       // 纯小写字母+连字符示例值（无数字/符号/大小写混合）
    'Bearer example-token-here',                    // 值形状示例形态
    'sk-your-api-key-here',                         // 值形状示例形态
    'use sk-demo-key-1234567890 in this doc',       // 叙述中的示例
  ].join('\n');
  const hits = scanText(doc);
  assert.equal(hits.length, 0, `示例文档不应误报，实际: ${JSON.stringify(hits)}`);
});

test('scanText: 含数字/符号的混合串仍是真实凭据特征 → 拦截（不回退）', () => {
  const real = [
    'token: abc123-def456',                         // 含数字的混合串
    'password: AbCdEfGh-1234',                      // 大小写混合 + 数字 + 连字符（非纯字母数字，不落短标识符豁免）
    'apiKey: sk-proj-9f8e7d6c5b4a3210abcdef',       // 真实形态 sk-（无占位词）
  ].join('\n');
  const hits = scanText(real);
  assert.ok(hits.length >= 3, `真实凭据特征应拦截，实际: ${JSON.stringify(hits)} (${hits.length})`);
});

test('scanAndRedact: 宽松档（literalValueOnly，市场发布）占位/模板/代码引用放行，真凭据仍拦', () => {
  // 宽松档：字段名敏感但值不是秘密 → 全部放行（市场发布场景，消除误报）
  const benign = {
    token: 'your-token',
    apiKey: '${OPENAI_API_KEY}',
    secret: '{{MY_SECRET}}',
    password: 'process.env.PASSWORD',
    Authorization: 'Bearer <token>',
    clientSecret: 'client-secret-value', // 混合字符但纯小写+连字符（无数字/符号/大小写混合）→ 非凭据
    max_tokens: 100,
    note: 'just a note',
  };
  const r = scanAndRedact(benign, { literalValueOnly: true });
  assert.equal(r.hits.length, 0, `宽松档不应误报，实际: ${JSON.stringify(r.hits)}`);
  assert.deepEqual(r.sanitized, benign);

  // 宽松档：真实凭据仍然拦截（安全不回退）
  const real = {
    token: 'sk-proj-9f8e7d6c5b4a3210abcdef',
    Authorization: 'Bearer xyz1234567890abcdef',
    clientSecret: 's3cretP@ssw0rdXyZ2024',
  };
  const rr = scanAndRedact(real, { literalValueOnly: true });
  assert.equal(rr.hits.length, 3, `宽松档真凭据仍应拦截，实际: ${JSON.stringify(rr.hits)}`);
});

test('scanAndRedact: 保守档（默认，导出/同步）字段名敏感即剥，不受宽松档影响', () => {
  // 默认模式：字段名敏感 + 任意值 → 剥离（导出脱敏保持保守，行为不变）
  const input = { token: 'your-token', apiKey: '${OPENAI_API_KEY}' };
  const { sanitized } = scanAndRedact(input);
  const s = sanitized as Record<string, unknown>;
  assert.equal(s['token'], REDACTED_PLACEHOLDER, '保守档字段名敏感即剥（占位符值也剥）');
  assert.equal(s['apiKey'], REDACTED_PLACEHOLDER, '保守档模板引用值也剥');
});

/* ================= redaction ================= */

test('redaction: 结构化字段三形态 + 值形状 + URL query', () => {
  const json = redact('{"apiKey": "sk-abc1234567890abc", "theme": "dark", "client_secret": "cs-value-1"}');
  assert.ok(!json.includes('sk-abc1234567890abc'));
  assert.ok(json.includes('"apiKey": "***REDACTED***"'));
  assert.ok(json.includes('"client_secret": "***REDACTED***"'));
  assert.ok(json.includes('"theme": "dark"'));
  assert.doesNotThrow(() => JSON.parse(json), '输出仍是合法 JSON');

  const kv = redact('token=abc123def456 theme=dark');
  assert.ok(kv.includes('token=***REDACTED***'));
  assert.ok(kv.includes('theme=dark'));

  const colon = redact('Authorization: Bearer xyz1234567890abcdef');
  assert.ok(colon.includes('Authorization: ***REDACTED***'));

  const shape = redact('please use sk-abc1234567890abc now, aws key AKIAIOSFODNN7EXAMPLE');
  assert.ok(!shape.includes('sk-abc1234567890abc'));
  assert.ok(!shape.includes('AKIAIOSFODNN7EXAMPLE'));

  const url = redact('https://x.com/api?token=secret-token-1&theme=dark&api_key=another-secret');
  assert.ok(!url.includes('secret-token-1'));
  assert.ok(!url.includes('another-secret'));
  assert.ok(url.includes('theme=dark'));
});

test('redaction: 幂等（重复脱敏结果不变）+ createRedactor 与 redact 一致', () => {
  const samples = [
    '{"apiKey": "sk-abc1234567890abc", "theme": "dark"}',
    'token=abc123def456 theme=dark',
    'Authorization: Bearer xyz1234567890abcdef',
    'url?token=secret-token-1&api_key=another-secret',
    'plain text no secrets',
  ];
  for (const s of samples) {
    const once = redact(s);
    const twice = redact(once);
    assert.equal(twice, once, `应幂等: ${s}`);
    assert.equal(createRedactor()(s), once);
  }
});

test('redaction: redactValue 对象级掩码 + 大小写 + 自定义附加名单', () => {
  const masked = redactValue({ apiKey: 'sk-abc', nested: { clientSecret: 'cs', ok: 1 }, list: [{ token: 't' }] });
  const m = masked as Record<string, unknown>;
  assert.equal(m['apiKey'], REDACTED);
  assert.equal((m['nested'] as Record<string, unknown>)['clientSecret'], REDACTED);
  assert.equal((m['nested'] as Record<string, unknown>)['ok'], 1);
  assert.equal(((m['list'] as unknown[])[0] as Record<string, unknown>)['token'], REDACTED);

  assert.ok(redact('API_KEY=xyz123').includes('API_KEY=***REDACTED***'));
  assert.ok(redact('monkey=banana').includes('monkey=banana'), '不敏感字段不受影响');
  // 附加名单（规范化名）
  const custom = createRedactor(['customfield']);
  assert.ok(custom('customField=value123').includes('customField=***REDACTED***'));
});

/* ================= core 注入点集成 ================= */

test('集成: Exporter + createSecretScanner 剥离自定义敏感字段（第二道防线）', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const ctx = new MockHostContext(homeDir);
    ctx.settings.ns.set('general', {
      value: { theme: 'dark', apiKey: 'sk-super-secret-value', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      revision: 3,
      secrets: [],
    });
    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter()];
    const zipPath = path.join(dir, 'x.zip');
    await new Exporter({
      ctx,
      adapters,
      scanner: createSecretScanner(), // 注入强化 scanner
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: false, outPath: zipPath });

    const archive = parseZip(await fs.readFile(zipPath));
    const settingsJson = archive.readEntryText('config/settings.json');
    assert.ok(!settingsJson.includes('sk-super-secret-value'), 'secret 值不得写入导出');
    assert.ok(settingsJson.includes('"apiKey": ""'), 'apiKey 应剥离为空串占位');
    assert.ok(settingsJson.includes('"apiKeyEnv": "DEEPSEEK_API_KEY"'), '引用字段应保留');
    assert.ok(settingsJson.includes('"theme": "dark"'));
  });
});

test('集成: Exporter + EncryptionProvider 加密备份（secrets.enc + manifest + 解密恢复）', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const ctx = new MockHostContext(homeDir);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const credentialsYaml = 'DEEPSEEK_API_KEY: sk-super-secret-value\nGITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz\n';
    await ctx.fs.writeFile(path.join(homeDir, '.credentials.yaml'), Buffer.from(credentialsYaml, 'utf8'));

    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter()];
    const zipPath = path.join(dir, 'enc.zip');
    const password = 'backup-password-123';
    const exporter = new Exporter({
      ctx,
      adapters,
      scanner: createSecretScanner(),
      encryption: createEncryptionProvider(password),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    });
    const { manifest } = await exporter.export({ includeSecrets: true, outPath: zipPath });

    assert.equal(manifest.security.containsSecrets, true);
    assert.equal(manifest.security.encrypted, true);
    assert.ok(manifest.security.encryption, '应记录加密参数');
    assert.equal(manifest.security.encryption!.kdf, 'scrypt');

    const archive = parseZip(await fs.readFile(zipPath));
    assert.ok(archive.has('security/secrets.enc'), 'secrets.enc 应写入 ZIP');
    // 密码绝不出现在 manifest 文本
    const manifestText = archive.readEntryText('manifest.json');
    assert.ok(!manifestText.includes(password), '密码不得出现在 manifest');
    assert.ok(!manifestText.includes('sk-super-secret-value'), '明文秘密不得出现在 manifest');

    // 解密恢复
    const blob = archive.readEntry('security/secrets.enc');
    const decrypted = await decryptCredentials(blob, manifest.security.encryption!, password);
    assert.equal(decrypted, credentialsYaml);
  });
});

test('集成: 加密备份导入强制密码——无解密结果拒绝，正确解密恢复凭据', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const src = new MockHostContext(homeDir);
    src.settings.ns.set('general', { value: { theme: 'dark', apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
    src.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value');
    await src.fs.writeFile(
      path.join(homeDir, '.credentials.yaml'),
      Buffer.from('DEEPSEEK_API_KEY: sk-super-secret-value\n', 'utf8'),
    );
    const credentialsAdapter = new CredentialsAdapter({ refs: async () => ['DEEPSEEK_API_KEY'] });
    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter(), credentialsAdapter];
    const zipPath = path.join(dir, 'enc.zip');
    const password = 'backup-password-123';
    await new Exporter({
      ctx: src,
      adapters,
      scanner: createSecretScanner(),
      encryption: createEncryptionProvider(password),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    }).export({ includeSecrets: true, outPath: zipPath });

    const dst = new MockHostContext(path.join(dir, 'dst-home'));
    const importer = new Importer({ ctx: dst, adapters, snapshotStore: new MemSnapshotStore() });

    // 分析层必须暴露加密标志（UI 据此要求输入解密密码）
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.encrypted, true);
    assert.equal(analysis.secretCount, 1);

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] });
    assert.ok(plan.missingSecrets.some((s) => s.ref === 'DEEPSEEK_API_KEY'));

    // 1) 无解密结果：加密备份拒绝执行（不允许「无密码照样导入」）
    await assert.rejects(
      () => importer.executeImportPlan(zipPath, plan, { confirm: true }),
      /解密密码才能导入/,
    );
    assert.equal(dst.credentials.values.has('DEEPSEEK_API_KEY'), false, '拒绝时不得写入任何凭据');

    // 2) 正确解密结果（宿主用备份密码解开 secrets.enc 注入）：凭据恢复，不再要求补录
    const archive = parseZip(await fs.readFile(zipPath));
    const manifest = parseManifest(archive.readEntryText('manifest.json'));
    const blob = archive.readEntry('security/secrets.enc');
    const plaintext = await decryptCredentials(blob, manifest.security.encryption!, password);
    const map = new Map<string, string>();
    for (const line of plaintext.split('\n')) {
      const m = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(line.trim());
      if (m) map.set(m[1]!, m[2]!);
    }
    const result = await importer.executeImportPlan(zipPath, plan, { confirm: true, decryptedCredentials: map });
    assert.equal(result.ok, true);
    assert.equal(result.missingSecrets.length, 0, '解密覆盖的凭据不再计入缺失');
    assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-super-secret-value');
  });
});

test('集成: includeSecrets 无加密提供者 → 拒绝（绝不明文导出秘密）', async () => {
  await withTmp(async (dir) => {
    const ctx = new MockHostContext(path.join(dir, 'home'));
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const exporter = new Exporter({ ctx, adapters: [new MiniSettingsAdapter()], now: () => new Date() });
    await assert.rejects(
      () => exporter.export({ includeSecrets: true, outPath: path.join(dir, 'x.zip') }),
      /EncryptionProvider/,
    );
  });
});

test('集成: 只加密不导出密钥（encryption 提供但 includeSecrets=false）→ 备份仍标记加密，但不含任何凭据值', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const ctx = new MockHostContext(homeDir);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    // 存在真实凭据文件，但用户只勾了「加密备份」、未勾「导出密钥」—— 凭据值绝不能进备份
    const credentialsYaml = 'DEEPSEEK_API_KEY: sk-super-secret-value\n';
    await ctx.fs.writeFile(path.join(homeDir, '.credentials.yaml'), Buffer.from(credentialsYaml, 'utf8'));

    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter()];
    const zipPath = path.join(dir, 'enc-only.zip');
    const password = 'backup-password-123';
    const exporter = new Exporter({
      ctx,
      adapters,
      scanner: createSecretScanner(),
      encryption: createEncryptionProvider(password),
      now: () => new Date('2026-08-14T12:00:00.000Z'),
    });
    const { manifest } = await exporter.export({ includeSecrets: false, outPath: zipPath });

    assert.equal(manifest.security.encrypted, true, '加密是独立选项：不含密钥也应标记加密');
    assert.equal(manifest.security.containsSecrets, false, '未导出密钥：不得声称包含秘密');
    assert.ok(manifest.security.encryption, '应记录加密参数');

    const archive = parseZip(await fs.readFile(zipPath));
    assert.ok(archive.has('security/secrets.enc'), 'secrets.enc 应写入 ZIP');
    const blob = archive.readEntry('security/secrets.enc');
    const decrypted = await decryptCredentials(blob, manifest.security.encryption!, password);
    assert.equal(decrypted, '', '未导出密钥时 secrets.enc 解密内容必须为空');
    for (const name of archive.names()) {
      if (name === 'security/secrets.enc') continue // secrets.enc 为二进制加密内容，单独断言解密结果
      assert.ok(
        !archive.readEntryText(name).includes('sk-super-secret-value'),
        `凭据值绝不得出现在备份条目 ${name} 中`,
      )
    }
  });
});

test('集成: 整体加密备份容器——导出→容器→解锁→明文 ZIP→分析（完整链路）', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const ctx = new MockHostContext(homeDir);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    await ctx.fs.writeFile(
      path.join(homeDir, '.credentials.yaml'),
      Buffer.from('DEEPSEEK_API_KEY: sk-super-secret-value\n', 'utf8'),
    );
    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter()];
    const password = 'archive-whole-backup-pw';

    // 1) Exporter 生成明文 ZIP（注入 EncryptionProvider 以便 includeSecrets 在 ZIP 内产出 secrets.enc；
    //    最终整体加密由外层容器完成）
    const plainZip = path.join(dir, 'plain.zip');
    await new Exporter({
      ctx,
      adapters,
      encryption: createEncryptionProvider(password),
      now: () => new Date(),
    }).export({ includeSecrets: true, outPath: plainZip });

    // 2) 整体加密为容器
    const rawZip = await fs.readFile(plainZip);
    const { blob } = await encryptArchive(rawZip, password);
    const containerPath = path.join(dir, 'backup.zip');
    await fs.writeFile(containerPath, blob);
    assert.ok(isArchiveBlob(await fs.readFile(containerPath)), '落盘文件是加密容器（magic DCA1）');

    // 3) 解锁（只读校验 + 解密）→ 明文 ZIP
    const containerBytes = await fs.readFile(containerPath);
    const verified = await verifyEncryptedBlob(containerBytes, password);
    assert.equal(verified.valid, true);
    assert.equal(verified.ok, true, '正确密码应通过验证');
    const plain = await decryptArchive(containerBytes, verified.info!, verified.kdf!, password);
    const unlockedPath = path.join(dir, 'unlocked.zip');
    await fs.writeFile(unlockedPath, plain);

    // 4) 明文 ZIP 可被 Importer 正常分析
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() });
    const analysis = await importer.analyzeImport(unlockedPath);
    assert.equal(analysis.valid, true);
    assert.deepEqual(analysis.sectionsInZip, ['settings']);

    // 5) 明文 ZIP 中确实包含完整凭据（includeSecrets=true 时 Exporter 在 ZIP 内写入 secrets.enc）
    const archive = parseZip(plain);
    assert.ok(archive.has('security/secrets.enc'), '容器解出的 ZIP 含 secrets.enc（凭据受容器整体保护）');
    // 错误密码：verify 拒绝
    const wrong = await verifyEncryptedBlob(containerBytes, 'wrong-password');
    assert.equal(wrong.ok, false);
  });
});

test('集成: Importer + parseZipOverride=createHardenedZipParser 正常解析备份', async () => {
  await withTmp(async (dir) => {
    const homeDir = path.join(dir, 'home');
    const ctx = new MockHostContext(homeDir);
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    const adapters: ConfigAdapter[] = [new MiniSettingsAdapter()];
    const zipPath = path.join(dir, 'x.zip');
    await new Exporter({ ctx, adapters, now: () => new Date() }).export({ includeSecrets: false, outPath: zipPath });

    const importer = new Importer({
      ctx,
      adapters,
      snapshotStore: new MemSnapshotStore(),
      parseZipOverride: createHardenedZipParser(), // 注入强化 ZIP 安全解析
    });
    const analysis = await importer.analyzeImport(zipPath);
    assert.equal(analysis.valid, true);
    assert.deepEqual(analysis.sectionsInZip, ['settings']);
  });
});
