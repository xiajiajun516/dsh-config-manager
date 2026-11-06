/**
 * 回归护栏（audit-sync **sync-F1** / **sync-F3**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * sync-F1（P0）：\`GET index.json\` 读不出来时，delete() 此前按「一条快照都没有」继续执行 ——
 *   把 index.json 覆盖成 []（其余快照从列表整体消失），并让 gcBlobStore 以空引用集回收，
 *   删掉仍被其它快照引用的会话 blob（不可恢复）。
 *   → 索引读不出来必须**中止删除**，绝不重写 index.json、绝不触发 blob GC。
 * sync-F3（P1）：blob 仓 URL 此前多一个斜杠（…/dsh-config-manager//blobs/…），与
 *   docs/contracts/sync-channel-v1.md §3 的 \`<col>/blobs/<sha256>\` 及其它通道不一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WebDavTransport } from './webdav-transport.ts';
import type { WebDavRequestFn, WebDavResponse } from './webdav-transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta } from '../transport.ts';

const COL = 'https://dav.example.com/dav/dsh-config-manager';
const OLD_BLOB_MS = Date.now() - 11 * 60 * 1000; // 早于 10 分钟 GC 保护窗
const BLOB_HASH = 'a'.repeat(64);

function mkRes(status: number, text = ''): WebDavResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: async () => text };
}

function meta(id: string, day: string): SyncSnapshotMeta {
  return {
    id,
    createdAt: '2026-10-0' + day + 'T00:00:00.000Z',
    sections: { settings: 'h' + id },
    manifest: {
      schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
      sectionIds: ['settings'], containsSecrets: false,
    },
  };
}

function snapshotOf(id: string, sections: SyncSnapshot['sections']): SyncSnapshot {
  return {
    id,
    createdAt: '2026-10-03T00:00:00.000Z',
    manifest: {
      schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
      sectionIds: ['sessions'], containsSecrets: false,
    },
    sections,
  };
}

/** 远端 3 份快照 + 1 个被 snap-3 引用的旧 blob；\`GET index.json\` 一律 500。 */
function makeRemoteWithUnreadableIndex() {
  const state = {
    index: [meta('sync-aaa-111', '1'), meta('sync-bbb-222', '2'), meta('sync-ccc-333', '3')],
    snapshotFiles: new Map<string, string>(),
    blobsIndex: { [BLOB_HASH]: OLD_BLOB_MS } as Record<string, number>,
    blobs: new Map<string, string>([[BLOB_HASH, 'AAAA']]),
  };
  for (const m of state.index) {
    state.snapshotFiles.set(m.id + '.json', JSON.stringify(snapshotOf(m.id, { settings: { version: 1, namespaces: {} } })));
  }
  state.snapshotFiles.set('sync-ccc-333.json', JSON.stringify(snapshotOf('sync-ccc-333', {
    // 外置引用形态（BlobRefsSection）不是 SectionData 的成员，测试里显式断言
    sessions: { version: 1, blobRefs: [{ relativePath: 'p/1.jsonl', blobHash: BLOB_HASH, sizeBytes: 4 }] },
  } as unknown as SyncSnapshot['sections'])));

  const seen = { putIndex: [] as string[], deletedBlobs: [] as string[], all: [] as string[] };
  const request: WebDavRequestFn = async (method, url, options) => {
    seen.all.push(method + ' ' + url);
    if (url === COL + '/index.json') {
      if (method === 'GET') return mkRes(500, 'Internal Server Error');
      if (method === 'PUT') { seen.putIndex.push(options?.body ?? ''); return mkRes(201); }
    }
    if (url.includes('/blobs-index.json')) {
      if (method === 'GET') return mkRes(200, JSON.stringify(state.blobsIndex));
      if (method === 'PUT') { state.blobsIndex = JSON.parse(options?.body ?? '{}'); return mkRes(201); }
    }
    if (url.includes('/blobs/')) {
      const hash = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'DELETE') { seen.deletedBlobs.push(hash); state.blobs.delete(hash); return mkRes(204); }
      if (method === 'GET') return state.blobs.has(hash) ? mkRes(200, state.blobs.get(hash)) : mkRes(404);
    }
    const m = /\/([^/]+)\.json$/.exec(url);
    if (m) {
      const id = m[1]!;
      if (method === 'DELETE') { const had = state.snapshotFiles.delete(id + '.json'); return mkRes(had ? 204 : 404); }
      if (method === 'GET') return state.snapshotFiles.has(id + '.json') ? mkRes(200, state.snapshotFiles.get(id + '.json')!) : mkRes(404);
    }
    if (method === 'MKCOL') return mkRes(201);
    return mkRes(404);
  };
  return { state, seen, request };
}

function transportWith(request: WebDavRequestFn): WebDavTransport {
  return new WebDavTransport({
    baseUrl: 'https://dav.example.com/dav',
    username: 'alice',
    credentials: { getPassword: async () => 'pw' },
    request,
  });
}

test('sync-F1：GET index.json 失败 → delete() 必须中止（绝不按空索引删快照）', async () => {
  const { request } = makeRemoteWithUnreadableIndex();
  const t = transportWith(request);
  await assert.rejects(
    () => t.delete('sync-aaa-111'),
    (err: unknown) => err instanceof Error && /index\.json/.test(err.message),
    '索引读不出来时删除必须显式失败，而不是按「远端没有快照」继续',
  );
});

test('sync-F1：索引读不出来时绝不重写 index.json、绝不删除被引用的 blob', async () => {
  const { state, seen, request } = makeRemoteWithUnreadableIndex();
  const t = transportWith(request);
  await t.delete('sync-aaa-111').catch(() => undefined); // base 上不抛错（这正是缺陷）

  assert.equal(seen.putIndex.length, 0, '禁止在索引不可读时写回 index.json（base 上写入 [] = 其余快照从列表消失）');
  assert.deepEqual(seen.deletedBlobs, [], '禁止触发 blob GC（base 上会删掉仍被 sync-ccc-333 引用的 blob）');
  assert.equal(state.snapshotFiles.has('sync-bbb-222.json'), true, '其余快照文件不得被本次删除波及');
  assert.deepEqual(Object.keys(state.blobsIndex), [BLOB_HASH], 'blobs-index 不得被清空');
  assert.equal(state.blobs.has(BLOB_HASH), true, '被引用的 blob 必须仍在仓里');
});

test('sync-F3：blob 仓 URL 不得含空路径段（<col>/blobs/…，与 docs/contracts/sync-channel-v1.md §3 一致）', async () => {
  const urls: string[] = [];
  const request: WebDavRequestFn = async (method, url) => {
    urls.push(url);
    if (method === 'GET') return mkRes(404);
    return mkRes(201);
  };
  const t = transportWith(request);
  await t.upload(snapshotOf('sync-aaa-111', {
    sessions: { version: 1, files: [{ relativePath: 'p/s1.jsonl', data: new Uint8Array([1, 2, 3, 4]), contentHash: '' }] },
  }));

  const blobUrls = urls.filter((u) => u.includes('blobs'));
  assert.ok(blobUrls.length > 0, '含 sessions 的上传必须走 blob 仓');
  const withEmptySegment = blobUrls.filter((u) => u.replace(/^https?:\/\/[^/]+/, '').includes('//'));
  assert.deepEqual(withEmptySegment, [], 'blob URL 不得含空路径段（此前 …/dsh-config-manager//blobs/…）');
  assert.ok(blobUrls.includes(COL + '/blobs-index.json'), 'blob 索引 URL 必须是 <col>/blobs-index.json');
  assert.ok(blobUrls.some((u) => u.startsWith(COL + '/blobs/')), 'blob 对象 URL 必须是 <col>/blobs/<sha256>');
});
