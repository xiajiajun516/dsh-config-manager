/**
 * m-sync-json：SyncSnapshot JSON 安全序列化测试。
 * 核心回归：文件类分区（Uint8Array）经 JSON 往返必须还原成 Uint8Array
 * （此前 JSON.stringify 把 TypedArray 变成数字索引对象，导致
 * 「The "data" argument must be of type string or an instance of Buffer…」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deserializeSnapshot, sectionsFromJsonSafe, sectionsToJsonSafe, serializeSnapshot,
} from './snapshot-json.ts';
import { encryptSectionsPayload, decryptSectionsPayload } from './snapshot-crypto.ts';
import type { SyncSnapshot } from './transport.ts';
import { isEncryptedSections } from './transport.ts';
import type { SectionId } from '../schema/types.ts';

function fileSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    id: 'snap-files',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'skills'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      skills: {
        version: 1,
        files: [
          { relativePath: 'coding.md', data: new Uint8Array(Buffer.from('# Coding\n', 'utf8')), contentHash: 'h1' },
          { relativePath: 'sub/notes.txt', data: new Uint8Array(Buffer.from('hello world', 'utf8')), contentHash: 'h2' },
        ],
      },
    },
    ...overrides,
  } as SyncSnapshot;
}

test('serializeSnapshot：文件分区 data 以 base64 形传输（JSON 往返无损还原 Uint8Array）', () => {
  const raw = serializeSnapshot(fileSnapshot());
  const parsed = JSON.parse(raw) as SyncSnapshot;
  // 传输形态：不是数字索引对象，而是 {$bin: base64}
  const files = (parsed.sections as { skills: { files: Array<{ data: unknown }> } }).skills.files;
  for (const f of files) {
    const d = f.data as { $bin?: string };
    assert.equal(typeof d.$bin, 'string', '文件 data 应为 { $bin: base64 }');
    assert.equal(d.$bin!.length > 0, true);
  }
  // 往返还原：字节必须分毫不差
  const roundtrip = deserializeSnapshot(raw);
  const rfiles = (roundtrip.sections as { skills: { files: Array<{ data: Uint8Array; relativePath: string }> } }).skills.files;
  assert.equal(rfiles.length, 2);
  assert.ok(rfiles[0]!.data instanceof Uint8Array, '还原后 data 必须是 Uint8Array');
  assert.equal(Buffer.from(rfiles[0]!.data).toString('utf8'), '# Coding\n');
  assert.equal(rfiles[1]!.relativePath, 'sub/notes.txt');
  assert.equal(Buffer.from(rfiles[1]!.data).toString('utf8'), 'hello world');
  // JSON 分区原样保留
  const settings = (roundtrip.sections as { settings: { namespaces: Record<string, unknown> } }).settings;
  assert.deepEqual(settings.namespaces['general'], { value: { theme: 'dark' }, revision: 1, secrets: [] });
});

test('serializeSnapshot：加密快照（EncryptedSections）原样透传不破坏', () => {
  const encrypted: SyncSnapshot = {
    id: 'snap-enc',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.2.3', platform: 'win32', sectionIds: ['settings'], containsSecrets: true, encrypted: true },
    sections: { encrypted: { info: { algo: 'aes-256-gcm', kdf: 'scrypt' } as never, data: 'c2VjcmV0IGNpcGhlcnRleHQ=' } },
  };
  const raw = serializeSnapshot(encrypted);
  const roundtrip = deserializeSnapshot(raw);
  assert.ok(isEncryptedSections(roundtrip.sections), '加密载荷必须保持 EncryptedSections 形态');
  assert.deepEqual(roundtrip.sections, encrypted.sections);
  assert.equal(roundtrip.manifest.encrypted, true);
});

test('sectionsToJsonSafe / sectionsFromJsonSafe：明文 sections 往返等价', () => {
  const snap = fileSnapshot();
  const safe = sectionsToJsonSafe(snap.sections);
  const back = sectionsFromJsonSafe(safe);
  assert.deepEqual(back, snap.sections, '明文 sections 往返应深等价（data 还原为 Uint8Array）');
});

test('deserializeSnapshot：形状非法 → 抛错', () => {
  assert.throws(() => deserializeSnapshot('{"not":"snapshot"}'), /形状非法/);
  assert.throws(() => deserializeSnapshot('not-json'), /JSON/);
});

test('加密载荷：含文件分区加密 → 解密还原 Uint8Array（字节无损）', async () => {
  const snap = fileSnapshot();
  const enc = await encryptSectionsPayload(snap.sections as Parameters<typeof encryptSectionsPayload>[0], 'pw-12345678');
  assert.ok(isEncryptedSections({ encrypted: enc.encrypted }));
  const decrypted = await decryptSectionsPayload(enc.encrypted, 'pw-12345678');
  const files = (decrypted as { skills: { files: Array<{ data: Uint8Array; relativePath: string }> } }).skills.files;
  assert.ok(files[0]!.data instanceof Uint8Array, '解密后文件 data 必须是 Uint8Array');
  assert.equal(Buffer.from(files[0]!.data).toString('utf8'), '# Coding\n');
  assert.equal(Buffer.from(files[1]!.data).toString('utf8'), 'hello world');
});

test('回归：webdav 序列化快照含文件分区 → JSON 中无数字索引对象（{0:..,1:..}）', () => {
  const snap = fileSnapshot();
  const raw = serializeSnapshot(snap);
  assert.ok(!/\"0\"\s*:/.test(raw), '序列化不得出现数字索引对象形态');
  // 空 data（零字节文件）也可往返
  const empty = fileSnapshot();
  (empty.sections as unknown as { skills: { files: Array<{ relativePath: string; data: Uint8Array }> } }).skills.files = [
    { relativePath: 'empty.bin', data: new Uint8Array(0) },
  ];
  const rt = deserializeSnapshot(serializeSnapshot(empty));
  const files = (rt.sections as { skills: { files: Array<{ data: Uint8Array }> } }).skills.files;
  assert.equal(files[0]!.data.length, 0);
  assert.ok(files[0]!.data instanceof Uint8Array);
});

// 类型辅助（避免未使用告警）
void ([] as SectionId[]);