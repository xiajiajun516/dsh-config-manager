/**
 * 回归护栏（audit-sync **sync-F6**，base sha 3f42a8b13a01c891bf5a21feb2742aaf0521c104）。
 *
 * sync-F6（P3）：downloadSnapshot() 此前把墓碑剔除结果丢弃 —— 产物里少了哪些会话，调用方与用户
 * 都看不到（pull/preview 同一剔除都会写 sync.sessionsTombstoned）。铁律「剔除必须可见」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SyncEngine } from './sync-engine.ts';
import { parseZip } from '../utils/zip.ts';
import { sessionUnitIdOfPath } from './session-tombstones.ts';
import type { SyncSnapshot, SyncSnapshotMeta } from './transport.ts';
import type { ConfigAdapter } from '../core/types.ts';

const DEAD = 'p-dead/u-dead/session.jsonl.zstd';
const ALIVE = 'p-alive/u-alive/session.jsonl.zstd';

test('sync-F6：downloadSnapshot 必须把墓碑剔除数量回传（可见，不静默）', async () => {
  const deadUnit = sessionUnitIdOfPath(DEAD)!;
  const file = (rel: string) => ({ relativePath: rel, data: new Uint8Array([1, 2, 3]), contentHash: '' });
  const snapshot: SyncSnapshot = {
    id: 'sync-remote-9',
    createdAt: '2026-10-05T00:00:00.000Z',
    manifest: {
      schemaVersion: 1, dshVersion: '0.1.0', platform: 'win32',
      sectionIds: ['sessions'], containsSecrets: false, deletedSessions: [deadUnit],
    },
    sections: { sessions: { version: 1, files: [file(DEAD), file(ALIVE)] } },
  };
  const metas: SyncSnapshotMeta[] = [{ id: snapshot.id, createdAt: snapshot.createdAt, sections: {}, manifest: snapshot.manifest }];
  const transport = {
    type: 'mock',
    list: async () => metas,
    upload: async () => { throw new Error('unused'); },
    download: async () => structuredClone(snapshot),
    delete: async () => undefined,
  };
  const sessionsAdapter: ConfigAdapter = {
    id: 'sessions', portability: 'deviceSpecific', title: 'sessions',
    export: async () => ({ data: { version: 1, files: [] }, counts: {}, warnings: [] }),
    import: async () => ({ ok: true }),
  } as unknown as ConfigAdapter;

  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-f6-state-'));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm-f6-out-'));
  try {
    const engine = new SyncEngine({
      ctx: {
        homeDir: path.join(os.tmpdir(), 'dcm-f6-home'), dshVersion: '0.1.0', platform: 'win32',
        fs: { readFile: async () => { throw new Error('ENOENT'); } },
      } as never,
      transport,
      stateDir,
      adapters: [sessionsAdapter],
      msg: (k: string) => k,
      optInSections: ['sessions'],
      snapshotId: () => 'sync-local-9',
    });
    const ret = await engine.downloadSnapshot({ dir: outDir, name: 'remote.zip' });

    assert.equal(ret.tombstonedSessions, 1, '剔除数量必须随返回值可见（base 上该字段不存在 = 静默）');
    const names = parseZip(await fs.readFile(ret.path)).entries().map((e) => e.name);
    assert.ok(!names.some((n) => n.includes('u-dead')), '墓碑会话必须被剔除');
    assert.ok(names.some((n) => n.includes('u-alive')), '未命中墓碑的会话必须保留');
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
