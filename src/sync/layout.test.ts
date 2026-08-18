/**
 * m-sync-transport：散文件目录布局测试。
 * - writeSnapshotToDir / readSnapshotFromDir 往返（JSON 分区平铺 + 文件类分区目录）
 * - manifest.json 内容正确性
 * - 安全：路径穿越拒绝、不支持分区拒绝、缺 manifest 拒绝、缺文件拒绝
 * - 注入验证：内存 SnapshotFs 驱动同一逻辑
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readSnapshotFromDir, writeSnapshotToDir, SNAPSHOT_MANIFEST_FILE, isSafeRelPath, listSnapshotFiles } from './layout.ts';
import { createSnapshotFs } from './fs.ts';
import { hashSection } from './sync-state.ts';
import type { SnapshotFs } from './fs.ts';
import type { SectionData, SectionId } from '../schema/types.ts';
import type { SyncSnapshot } from './transport.ts';

/** 测试用「明文快照」类型：sections 恒为普通分区 Record（layout 测试不涉及加密载荷）。 */
type PlainSnapshot = SyncSnapshot & { sections: Record<string, SectionData> };

function sampleSnapshot(): PlainSnapshot {
  return {
    id: 'snap-001',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers', 'skills', 'pluginFiles'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
      skills: {
        version: 1,
        files: [
          { relativePath: 'coding.md', data: new TextEncoder().encode('# Coding\n'), contentHash: 'x' },
          { relativePath: 'nested/tool.md', data: new TextEncoder().encode('# Tool\n'), contentHash: 'y' },
        ],
      },
      pluginFiles: { version: 1, files: [{ relativePath: 'dsh-ssh/main.js', data: new TextEncoder().encode('module.exports = 1\n'), contentHash: 'z' }] },
    },
  };
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, msg?: string) {
  assert.equal(Buffer.from(actual).equals(Buffer.from(expected)), true, msg ?? `字节不一致: ${Buffer.from(expected).toString('utf8')}`);
}

test('isSafeRelPath: 拒绝穿越/绝对路径/反斜杠，接受常规相对路径', () => {
  assert.equal(isSafeRelPath('a/b/c.md'), true);
  assert.equal(isSafeRelPath('编码.md'), true);
  assert.equal(isSafeRelPath('../evil.md'), false);
  assert.equal(isSafeRelPath('a/../../evil.md'), false);
  assert.equal(isSafeRelPath('/abs/path.md'), false);
  assert.equal(isSafeRelPath('C:\\evil.md'), false);
  assert.equal(isSafeRelPath('a\\b.md'), false);
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isSafeRelPath('.'), false);
});

test('writeSnapshotToDir + readSnapshotFromDir: 完整往返（JSON 平铺 + 文件目录）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-'));
  try {
    const snap = sampleSnapshot();
    const manifest = await writeSnapshotToDir(snap, tmp);

    // 布局：manifest.json + config/settings.json + ai/providers.json + custom/skills/… + plugin-files/…
    assert.equal(manifest.id, snap.id);
    assert.ok((await fs.stat(path.join(tmp, SNAPSHOT_MANIFEST_FILE))).isFile());
    assert.ok((await fs.stat(path.join(tmp, 'config', 'settings.json'))).isFile());
    assert.ok((await fs.stat(path.join(tmp, 'ai', 'providers.json'))).isFile());
    assert.equal((await fs.readFile(path.join(tmp, 'custom', 'skills', 'coding.md'), 'utf8')), '# Coding\n');
    assert.equal((await fs.readFile(path.join(tmp, 'custom', 'skills', 'nested', 'tool.md'), 'utf8')), '# Tool\n');
    assert.equal((await fs.readFile(path.join(tmp, 'plugin-files', 'dsh-ssh', 'main.js'), 'utf8')), 'module.exports = 1\n');

    const back = (await readSnapshotFromDir(tmp)) as unknown as PlainSnapshot;
    assert.equal(back.id, snap.id);
    assert.equal(back.createdAt, snap.createdAt);
    assert.deepEqual(back.manifest, snap.manifest);
    assert.deepEqual(back.sections['settings'], snap.sections['settings']);
    assert.deepEqual(back.sections['providers'], snap.sections['providers']);
    const skills = back.sections['skills'] as { files: { relativePath: string; data: Uint8Array; contentHash: string }[] };
    const skillsOrig = snap.sections['skills'] as { files: { relativePath: string; data: Uint8Array; contentHash: string }[] };
    assert.equal(skills.files.length, 2);
    assert.deepEqual(skills.files.map((f) => f.relativePath).sort(), ['coding.md', 'nested/tool.md']);
    assertBytesEqual(skills.files.find((f) => f.relativePath === 'coding.md')!.data, skillsOrig.files[0]!.data);
    // 读回内容 hash 与写入时 manifest 记录一致（完整性自洽）
    assert.equal(hashSection(back.sections['skills']!), manifest.sectionHashes['skills']);
    assert.equal(hashSection(back.sections['settings']!), manifest.sectionHashes['settings']);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('writeSnapshotToDir: manifest.sectionHashes 覆盖全部包含分区', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-hash-'));
  try {
    const snap = sampleSnapshot();
    const manifest = await writeSnapshotToDir(snap, tmp);
    assert.deepEqual(Object.keys(manifest.sectionHashes).sort(), ['pluginFiles', 'providers', 'settings', 'skills']);
    for (const [id, data] of Object.entries(snap.sections)) {
      assert.equal(manifest.sectionHashes[id as SectionId], hashSection(data));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('writeSnapshotToDir: 空文件类分区也保留（目录存在 → 读回含空 files）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-empty-'));
  try {
    const snap = sampleSnapshot();
    snap.sections['skills'] = { version: 1, files: [] };
    await writeSnapshotToDir(snap, tmp);
    const back = (await readSnapshotFromDir(tmp)) as unknown as PlainSnapshot;
    assert.deepEqual(back.sections['skills'], { version: 1, files: [] });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('writeSnapshotToDir: 拒绝路径穿越的文件相对路径', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-evil-'));
  try {
    const snap = sampleSnapshot();
    snap.sections['skills'] = { version: 1, files: [{ relativePath: '../../evil.md', data: new TextEncoder().encode('x'), contentHash: '' }] };
    await assert.rejects(() => writeSnapshotToDir(snap, tmp), /非法路径|relativePath|路径/);
    // 绝对路径同样拒绝
    snap.sections['skills'] = { version: 1, files: [{ relativePath: 'C:\\evil.md', data: new TextEncoder().encode('x'), contentHash: '' }] };
    await assert.rejects(() => writeSnapshotToDir(snap, tmp));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('writeSnapshotToDir: 拒绝布局不支持的子分区（如 secrets）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-nosec-'));
  try {
    const snap = sampleSnapshot();
    (snap.sections as Record<string, unknown>)['secrets'] = { version: 1, values: [] };
    await assert.rejects(() => writeSnapshotToDir(snap, tmp), /不支持|secrets|布局/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('readSnapshotFromDir: 目录缺 manifest.json → 拒绝', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-nomani-'));
  try {
    await assert.rejects(() => readSnapshotFromDir(tmp), /manifest/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('readSnapshotFromDir: manifest 声明了分区但文件缺失 → 拒绝（不静默降级）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-missing-'));
  try {
    await writeSnapshotToDir(sampleSnapshot(), tmp);
    await fs.rm(path.join(tmp, 'config', 'settings.json'));
    await assert.rejects(() => readSnapshotFromDir(tmp), /settings/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('注入验证：内存 SnapshotFs 驱动同一往返逻辑', async () => {
  const mem: Map<string, Uint8Array> = new Map();
  const snap = sampleSnapshot();
  const memFs: SnapshotFs = {
    async readFile(p) {
      const v = mem.get(p);
      if (!v) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, d) { mem.set(p, new Uint8Array(d)); },
    async mkdir(p) { mem.set(p + '/.dir', new Uint8Array()); }, // 目录哨兵
    async readdir(p) {
      const prefix = p.endsWith('/') ? p : p + '/';
      const out = new Set<string>();
      for (const k of mem.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest === '' || rest === '.dir') continue;
        out.add(rest.split('/')[0]!);
      }
      return [...out];
    },
    async isDir(p) {
      if (mem.has(p + '/.dir')) return true;
      for (const k of mem.keys()) if (k.startsWith(p + '/')) return true;
      return false;
    },
    async exists(p) { return mem.has(p) || mem.has(p + '/.dir'); },
    async remove(p) {
      const prefix = p.endsWith('/') ? p : p + '/';
      for (const k of [...mem.keys()]) if (k === p || k.startsWith(prefix)) mem.delete(k);
    },
  };
  const manifest = await writeSnapshotToDir(snap, 'snap/001', memFs);
  const back = await readSnapshotFromDir('snap/001', memFs);
  assert.equal(back.id, snap.id);
  const backPlain = back.sections as Partial<Record<SectionId, SectionData>>;
  const snapPlain = snap.sections as Partial<Record<SectionId, SectionData>>;
  assert.deepEqual(backPlain['settings'], snapPlain['settings']);
  const skills = backPlain['skills'] as { files: { relativePath: string; data: Uint8Array; contentHash: string }[] };
  assert.equal(skills.files.length, 2);
  assert.equal(hashSection(backPlain['skills']!), manifest.sectionHashes['skills']);
});

test('createSnapshotFs: 默认 node:fs 适配器可用（真实临时目录）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-layout-adapter-'));
  try {
    const fsx = createSnapshotFs();
    await fsx.mkdir(path.join(tmp, 'a/b'));
    await fsx.writeFile(path.join(tmp, 'a/b/x.md'), new TextEncoder().encode('hi'));
    assert.equal(await fsx.exists(path.join(tmp, 'a/b/x.md')), true);
    assert.equal(await fsx.isDir(path.join(tmp, 'a/b')), true);
    assert.deepEqual(await fsx.readdir(path.join(tmp, 'a')), ['b']);
    assert.equal(new TextDecoder().decode(await fsx.readFile(path.join(tmp, 'a/b/x.md'))), 'hi');
    assert.deepEqual(await listSnapshotFiles(fsx, path.join(tmp, 'a')), ['b/x.md']);
    await fsx.remove(path.join(tmp, 'a'));
    assert.equal(await fsx.exists(path.join(tmp, 'a')), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
