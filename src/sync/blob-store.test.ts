/**
 * P1-4 内容寻址 blob 仓测试：
 * - 纯函数：FilesSection ⇄ 引用形态往返、缺 blob 硬失败、引用收集、GC 保护窗口；
 * - 布局集成：走外置时快照目录只写 <section>.blobs.json，不带字节；读回需仓；
 * - WebDAV 端到端：同一份会话内容二次上传**零 blob 传输**（P1-4 的核心收益）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BLOB_SECTIONS, gcBlobs, isBlobRefsSection, referencedBlobHashes, refsToSection, sectionToBlobRefs,
} from './blob-store.ts';
import type { BlobSink } from './blob-store.ts';
import { blobRefsFile, readSnapshotFromDir, writeSnapshotToDir } from './layout.ts';
import { createSnapshotFs } from './fs.ts';
import type { FilesSection } from '../schema/types.ts';
import type { SyncSnapshot } from './transport.ts';
import { WebDavTransport } from './webdav/webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse } from './webdav/webdav-transport.ts';
import { sha256Hex } from '../utils/hashing.ts';

/** 内存 blob 仓：只统计**真实新写入**次数（去重收益的度量口径）。 */
class MemBlobSink implements BlobSink {
  readonly blobs = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
  writes = 0;
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    if (this.blobs.has(hash)) return;
    this.writes += 1;
    this.blobs.set(hash, { bytes, mtimeMs: Date.now() });
  }
  async get(hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(hash)?.bytes ?? null;
  }
  async delete(hash: string): Promise<void> {
    this.blobs.delete(hash);
  }
  async list(): Promise<{ hash: string; mtimeMs: number }[]> {
    return [...this.blobs].map(([hash, v]) => ({ hash, mtimeMs: v.mtimeMs }));
  }
}

function filesSection(entries: [string, string][]): FilesSection {
  return {
    version: 1,
    files: entries.map(([relativePath, text]) => {
      const data = Buffer.from(text, 'utf8');
      return { relativePath, data: new Uint8Array(data), contentHash: sha256Hex(data) };
    }),
  };
}

test('blob-store: sectionToBlobRefs ⇄ refsToSection 往返（引用带路径/哈希/字节数）', async () => {
  const sink = new MemBlobSink();
  const section = filesSection([['--p--/a/session.jsonl.zstd', 'AAAA'], ['--p--/b/session.jsonl.zstd', 'BBBB']]);
  const refs = await sectionToBlobRefs(section, sink);
  assert.equal(refs.version, 1);
  assert.deepEqual(refs.blobRefs.map((r) => r.relativePath), ['--p--/a/session.jsonl.zstd', '--p--/b/session.jsonl.zstd']);
  assert.deepEqual(refs.blobRefs.map((r) => r.sizeBytes), [4, 4]);
  assert.deepEqual(refs.blobRefs.map((r) => r.blobHash), section.files.map((f) => f.contentHash));
  assert.equal(sink.writes, 2);

  const back = await refsToSection(refs, sink);
  assert.deepEqual(back.files.map((f) => Buffer.from(f.data).toString('utf8')), ['AAAA', 'BBBB']);
  assert.deepEqual(back.files.map((f) => f.contentHash), section.files.map((f) => f.contentHash));
});

test('blob-store: 重复内容零重写（同哈希幂等）', async () => {
  const sink = new MemBlobSink();
  const section = filesSection([['--p--/a/session.jsonl.zstd', 'SAME']]);
  await sectionToBlobRefs(section, sink);
  await sectionToBlobRefs(section, sink);
  assert.equal(sink.writes, 1, '同内容只写一次');
});

test('blob-store: 缺 blob → 硬失败（绝不静默降级成空分区）', async () => {
  const sink = new MemBlobSink();
  const refs = await sectionToBlobRefs(filesSection([['--p--/a/session.jsonl.zstd', 'X']]), sink);
  sink.blobs.clear();
  await assert.rejects(() => refsToSection(refs, sink), /blob 缺失/);
});

test('blob-store: referencedBlobHashes 只认引用形态', () => {
  assert.equal(referencedBlobHashes(filesSection([['a', 'B']])).size, 0, '普通 FilesSection（含 data）不算引用');
  assert.deepEqual([...referencedBlobHashes({ version: 1, blobRefs: [{ relativePath: 'a', blobHash: 'h1', sizeBytes: 1 }] })], ['h1']);
  assert.equal(isBlobRefsSection({ version: 1, files: [] }), false);
  assert.equal(isBlobRefsSection({ version: 1, blobRefs: [] }), true);
});

test('blob-store: GC 只删「无引用且超出保护窗口」的 blob', async () => {
  const sink = new MemBlobSink();
  const now = 1_000_000_000;
  sink.blobs.set('kept', { bytes: new Uint8Array(), mtimeMs: 0 });
  sink.blobs.set('fresh', { bytes: new Uint8Array(), mtimeMs: now - 1000 });
  sink.blobs.set('stale', { bytes: new Uint8Array(), mtimeMs: now - 60 * 60 * 1000 });
  const deleted = await gcBlobs({ sink, referenced: new Set(['kept']), nowMs: now });
  assert.deepEqual(deleted, ['stale']);
  assert.ok(sink.blobs.has('kept'), '有引用 → 永不删');
  assert.ok(sink.blobs.has('fresh'), '保护窗口内 → 不删（并发上传安全阀）');
});

test('layout: 走外置的分区只写 <section>.blobs.json（快照目录内无会话字节）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-blob-layout-'));
  try {
    const fsx = createSnapshotFs();
    const sink = new MemBlobSink();
    const snapshot: SyncSnapshot = {
      id: 'sync-1',
      createdAt: '2026-08-16T12:00:00.000Z',
      manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
      sections: { sessions: filesSection([['--p--/a/session.jsonl.zstd', 'SESSION-BYTES']]) },
    };
    const dir = path.join(tmp, 'snap');
    await writeSnapshotToDir(snapshot, dir, fsx, { blobs: sink, sections: BLOB_SECTIONS });

    assert.ok(await fsx.exists(path.join(dir, blobRefsFile('sessions'))), '必须写引用文件');
    assert.equal(await fsx.exists(path.join(dir, 'sessions')), false, '不得写 sessions/ 目录（字节在仓里）');
    assert.equal(sink.writes, 1);

    // 读回：提供仓 → 字节还原
    const back = await readSnapshotFromDir(dir, fsx, { blobs: sink });
    const files = (back.sections as Record<string, FilesSection>)['sessions']!.files;
    assert.equal(Buffer.from(files[0]!.data).toString('utf8'), 'SESSION-BYTES');

    // 读回：不提供仓 → 硬失败（绝不降级为空分区）
    await assert.rejects(() => readSnapshotFromDir(dir, fsx), /外置形态|blob 仓/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

/* ---------------- WebDAV 端到端：未变会话零重传 ---------------- */

function davResponse(status: number, body = ''): WebDavResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => body };
}

test('webdav: 同一份会话内容二次上传 → 零 blob 传输；快照 JSON 只存引用', async () => {
  const store = new Map<string, string>();
  const blobPuts: string[] = [];
  const request: WebDavRequestFn = async (method, url, options) => {
    const p = new URL(url).pathname;
    if (method === 'MKCOL') return davResponse(store.has(p) ? 405 : 201);
    if (method === 'GET') return store.has(p) ? davResponse(200, store.get(p)!) : davResponse(404);
    if (method === 'PUT') {
      if (p.includes('/blobs/')) blobPuts.push(p);
      store.set(p, options?.body ?? '');
      return davResponse(201);
    }
    if (method === 'DELETE') { store.delete(p); return davResponse(204); }
    return davResponse(405);
  };
  const transport = new WebDavTransport({
    baseUrl: 'https://dav.example.com/dav',
    username: 'u',
    credentials: { getPassword: async () => 'p' },
    request,
  });

  const bytes = Buffer.from('SESSION-BYTES-' + 'x'.repeat(64), 'utf8');
  const section: FilesSection = {
    version: 1,
    files: [{ relativePath: '--p--/a/session.jsonl.zstd', data: new Uint8Array(bytes), contentHash: sha256Hex(bytes) }],
  };
  const mk = (id: string): SyncSnapshot => ({
    id,
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: { schemaVersion: 1, dshVersion: '1.0.0', platform: 'win32', sectionIds: ['sessions'], containsSecrets: false },
    sections: { sessions: section },
  });

  await transport.upload(mk('sync-a'));
  assert.equal(blobPuts.length, 1, '首次上传写一个 blob');

  // 第二份快照内容完全相同 → 走索引跳过，零 blob PUT
  await transport.upload(mk('sync-b'));
  assert.equal(blobPuts.length, 1, '内容未变 → 绝不重传（P1-4 核心收益）');

  // 快照 JSON 里不得再内联会话字节，只留引用
  const rawA = [...store].find(([k]) => k.endsWith('/sync-a.json'))?.[1] ?? '';
  assert.ok(rawA.includes('blobRefs'), '快照载荷必须是引用形态');
  assert.ok(!rawA.includes('SESSION-BYTES'), '快照载荷不得内联会话字节');

  // 下载：从 blob 仓回填字节
  const back = await transport.download('sync-a');
  const files = (back.sections as Record<string, FilesSection>)['sessions']!.files;
  assert.equal(Buffer.from(files[0]!.data).toString('utf8'), bytes.toString('utf8'));
  assert.equal(files[0]!.contentHash, sha256Hex(bytes));
});
