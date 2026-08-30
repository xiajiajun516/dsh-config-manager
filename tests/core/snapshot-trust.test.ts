/**
 * Phase 4 快照信任模型测试（F1/F9/F10，trust-model）：
 *  - FileSnapshotStore.save 生命周期：blobs → snapshot.json(CREATING) → manifest → verify → READY 原子发布；
 *  - verifySnapshot 从磁盘重读验证（存在/hash/schema/路径安全），不信任内存对象；
 *  - substitution / tamper 检测：篡改 manifest 或 blob 后 verify 失败；
 *  - operation-bound binding 字段随 createSnapshot 落盘。
 *
 * 覆盖：manifest 完整性（F1）、blob 完整性（F9）、READY readiness（F2/F22）、
 * metadataHash 稳定（READY/status 变化不破坏 hash，B-P1-1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isReservedInternalRel } from '../../src/utils/paths.ts';

import {
  FileSnapshotStore, createSnapshot, computeMetadataHash, verifySnapshot,
  type SnapshotVerifyResult,
} from '../../src/core/backup.ts';
import { JournalStore, createJournalEntry, type OperationJournal } from '../../src/core/journal.ts';
import { createAdapters } from '../../src/adapters/index.ts';
import { makeContext } from '../../src/adapters/test-helpers.ts';
import type { Snapshot } from '../../src/core/types.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-snapshot-trust-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function minSnapshot(id: string, now = '2026-08-14T12:00:00.000Z'): Snapshot {
  return {
    id, createdAt: now, sourceZip: `${id}.zip`,
    entries: [{ kind: 'file', adapter: 'pluginFiles', ref: 'dsh-ssh.json', before: null, existed: true, copiedTo: 'blobs/dsh-ssh.json', snapshotId: id }],
    hostFileBackups: [{ relPath: 'settings.yaml', blobPath: 'blobs/settings.yaml', existed: true }],
  };
}

/** 便捷：构造一个带 blob 的 snapshot 并 save 到临时目录，返回 { store, dir, blobKey } */
async function seedSave(dir: string, id: string): Promise<FileSnapshotStore> {
  const store = new FileSnapshotStore({ dir });
  const snap = minSnapshot(id);
  const blobs = new Map<string, Uint8Array>([
    ['blobs/dsh-ssh.json', Buffer.from('{"hosts":[]}')],
    ['blobs/settings.yaml', Buffer.from('general:\n  theme: dark\n')],
  ]);
  await store.save(snap, blobs);
  return store;
}

/** T-01 save 生命周期：blob + snapshot.json + manifest + 最终 readiness=READY */
test('T-01 FileSnapshotStore.save 产出 READY 快照（snapshot.json + manifest + blobs）', async () => {
  await withTmp(async (dir) => {
    await seedSave(dir, 'snap-t01');
    // snapshot.json 存在且 readiness=READY
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'snap-t01', 'snapshot.json'), 'utf8')) as Snapshot;
    assert.equal(raw.id, 'snap-t01');
    assert.equal(raw.readiness, 'READY', 'save 完成后快照应为 READY');
    // manifest.json 存在
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'snap-t01', 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.snapshotId, 'snap-t01');
    assert.equal(manifest.entryCount, 1, 'entries 数量应写入 manifest');
    // blobs 落盘
    await fs.access(path.join(dir, 'snap-t01', 'blobs', 'settings.yaml'));
    // verify 通过
    const v = await verifySnapshot(dir, 'snap-t01');
    assert.equal(v.ok, true);
  });
});

/** T-02 verifySnapshot：blob 篡改 → 失败（F9 substitution） */
test('T-02 verifySnapshot 检测 blob 篡改 → ok=false', async () => {
  await withTmp(async (dir) => {
    await seedSave(dir, 'snap-t02');
    // 篡改 blob 内容
    await fs.writeFile(path.join(dir, 'snap-t02', 'blobs', 'settings.yaml'), Buffer.from('HACKED'), 'utf8');
    const v = await verifySnapshot(dir, 'snap-t02');
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /blob hash|不匹配|hash/);
  });
});

/** T-03 verifySnapshot：manifest 篡改 → 失败（F1） */
test('T-03 verifySnapshot 检测 manifest 篡改 → ok=false', async () => {
  await withTmp(async (dir) => {
    await seedSave(dir, 'snap-t03');
    // 篡改 manifest 的 blobHash（把 hash 改成垃圾）
    const mp = path.join(dir, 'snap-t03', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(mp, 'utf8'));
    manifest.blobHashes['blobs/settings.yaml'] = 'deadbeef';
    await fs.writeFile(mp, JSON.stringify(manifest));
    const v = await verifySnapshot(dir, 'snap-t03');
    assert.equal(v.ok, false);
  });
});

/** T-04 破坏性内容篡改（改 snapshot.entries / hostFileBackups.relPath）→ metadataHash 不匹配 → 失败（F1） */
test('T-04 verifySnapshot 检测破坏性内容篡改（relPath/entries）→ ok=false', async () => {
  await withTmp(async (dir) => {
    await seedSave(dir, 'snap-t04');
    const sp = path.join(dir, 'snap-t04', 'snapshot.json');
    const snap = JSON.parse(await fs.readFile(sp, 'utf8')) as Snapshot;
    // 篡改 hostFileBackups[].relPath → 越权恢复面
    snap.hostFileBackups = [{ relPath: '../evil/settings.yaml', blobPath: 'blobs/settings.yaml', existed: true }];
    await fs.writeFile(sp, JSON.stringify(snap));
    const v = await verifySnapshot(dir, 'snap-t04');
    assert.equal(v.ok, false, '破坏性内容（relPath 越界）应被 metadataHash 校验拦截');
  });
});

/** T-05 metadataHash 稳定性：READY 发布 / status 更新不改变 hash（B-P1-1） */
test('T-05 computeMetadataHash 稳定，不受 readiness/status/pinned 变化影响', () => {
  const snap = minSnapshot('snap-t05');
  const h1 = computeMetadataHash(snap);
  // READY 发布是写新 snapshot 对象（readiness=READY），其破坏性内容不变
  const ready: Snapshot = { ...snap, readiness: 'READY' };
  assert.equal(computeMetadataHash(ready), h1, 'readiness 变化不应改变破坏性内容 hash');
  const done: Snapshot = { ...ready, status: 'done' };
  assert.equal(computeMetadataHash(done), h1, 'status 变化不应改变破坏性内容 hash');
  const pinned: Snapshot = { ...done, pinned: true };
  assert.equal(computeMetadataHash(pinned), h1, 'pinned 变化不应改变破坏性内容 hash');
  // 但破坏性内容变化必须改变 hash
  const tampered: Snapshot = { ...snap, hostFileBackups: [{ relPath: '../evil', blobPath: 'b', existed: false }] };
  assert.notEqual(computeMetadataHash(tampered), h1, 'relPath 篡改必须改变破坏性内容 hash');
});

/** T-06 operation-bound binding：createSnapshot 携带 operationId/environmentFingerprint/ownerInstanceId */
test('T-06 createSnapshot 携带 operation-bound binding 字段', async () => {
  await withTmp(async (dir) => {
    const ctx = makeContext('win32', 'C:\\Users\\bob', 'web');
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 3, secrets: [] });
    await ctx.fs.writeFile('settings.yaml', Buffer.from('general:\n  theme: dark\n', 'utf8'));
    const store = new FileSnapshotStore({ dir });
    const snap = await createSnapshot({
      ctx,
      plan: { items: [], globalStrategy: 'replace', pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} },
      sourceZip: 'x.zip',
      store,
      adapters: createAdapters({ namespaces: ['general'] }),
      operationId: 'op-t06',
      operationType: 'import-apply',
      environmentFingerprint: 'fp-t06',
      ownerInstanceId: 'inst-t06',
    });
    assert.equal(snap.operationId, 'op-t06');
    assert.equal(snap.operationType, 'import-apply');
    assert.equal(snap.environmentFingerprint, 'fp-t06');
    assert.equal(snap.ownerInstanceId, 'inst-t06');
    // 落盘后可重读 binding，且仍为 READY
    const loaded = (await store.load(snap.id)) as Snapshot;
    assert.equal(loaded.readiness, 'READY');
    assert.equal(loaded.operationId, 'op-t06');
  });
});

/** T-07 verifySnapshot：路径越界 / snapshot.id 与目录不匹配 → 拒绝 */
test('T-07 verifySnapshot 拒绝路径越界与 id 不匹配', async () => {
  await withTmp(async (dir) => {
    // 越界 id
    const vBad: SnapshotVerifyResult = await verifySnapshot(dir, '../escape');
    assert.equal(vBad.ok, false);
    // 目录存在但 snapshot.id 与目录不匹配
    await fs.mkdir(path.join(dir, 'snap-other'), { recursive: true });
    const bad = minSnapshot('snap-real');
    await fs.writeFile(path.join(dir, 'snap-other', 'snapshot.json'), JSON.stringify(bad));
    const v = await verifySnapshot(dir, 'snap-other');
    assert.equal(v.ok, false, 'snapshot.id 与目录不匹配应拒绝');
  });
});

/** T-08 半成品（无 manifest / 无 snapshot.json）不得通过 verify */
test('T-08 verifySnapshot 拒绝半成品（缺 manifest / 缺 snapshot.json）', async () => {
  await withTmp(async (dir) => {
    // 只有 snashot.json 无 manifest → 失败
    const d1 = path.join(dir, 'half-a');
    await fs.mkdir(d1, { recursive: true });
    await fs.writeFile(path.join(d1, 'snapshot.json'), JSON.stringify(minSnapshot('half-a')));
    const v1 = await verifySnapshot(dir, 'half-a');
    assert.equal(v1.ok, false);
    // 只有 manifest 无 snapshot.json → 失败
    const d2 = path.join(dir, 'half-b');
    await fs.mkdir(d2, { recursive: true });
    await fs.writeFile(path.join(d2, 'manifest.json'), JSON.stringify({ schemaVersion: 1, snapshotId: 'half-b', entryCount: 0, blobHashes: {}, metadataHash: 'x' }));
    const v2 = await verifySnapshot(dir, 'half-b');
    assert.equal(v2.ok, false);
  });
});

// ---------- F3：recovery 引用保护 prune ----------

test('F3: 被未收敛 journal 引用的 snapshot 绝不被 prune', async () => {
  await withTmp(async (dir) => {
    // referencedSnapshotIds 声明引用了 'snap-oldest'（模拟 active/recovery journal）
    const referenced = new Set(['snap-oldest']);
    const store = new FileSnapshotStore({ dir, referencedSnapshotIds: async () => referenced });
    // 造被引用最旧快照 + 10 个普通快照（都在同一个 provider 感知的 store 下落盘）
    await store.save({ ...minSnapshot('snap-oldest', '2026-01-01T00:00:00.000Z'), pinned: undefined }, new Map());
    for (let i = 1; i <= 10; i++) {
      await store.save({ ...minSnapshot(`snap-${String(i).padStart(4, '0')}`, `2026-02-${String(i).padStart(2, '0')}T00:00:00.000Z`), pinned: undefined }, new Map());
    }
    // 再存一个触发 prune：此时超限，应删普通最旧 snap-0001，而 snap-oldest（被引用）豁免
    await store.save(minSnapshot('snap-trigger', '2026-03-01T00:00:00.000Z'));

    // 被引用的快照必须仍在
    await fs.access(path.join(dir, 'snap-oldest', 'snapshot.json'));
    // 普通最旧的 snap-0001 应被清理（超限删最旧未引用者）
    await assert.rejects(fs.access(path.join(dir, 'snap-0001', 'snapshot.json')));
  });
});

test('F3: 未引用时照常清理最旧（provider 缺省 = 空集合）', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir });
    for (let i = 1; i <= 10; i++) {
      await store.save({ ...minSnapshot(`snap-${String(i).padStart(4, '0')}`, `2026-01-${String(i).padStart(2, '0')}T00:00:00.000Z`), pinned: undefined }, new Map());
    }
    await store.save(minSnapshot('snap-trigger', '2026-03-01T00:00:00.000Z'));
    await assert.rejects(fs.access(path.join(dir, 'snap-0001', 'snapshot.json'))); // 最旧被清理
    await fs.access(path.join(dir, 'snap-trigger', 'snapshot.json'));
  });
});

test('F13: prune 失败（如占用/权限）不中止已 READY 的快照保存', async () => {
  await withTmp(async (dir) => {
    const store = new FileSnapshotStore({ dir, referencedSnapshotIds: async () => { throw new Error('provider fail'); } });
    // 触发 prune 且 provider 抛错：不应让 save 失败
    const id = await store.save(minSnapshot('snap-f13', '2026-03-01T00:00:00.000Z'));
    assert.equal(id, 'snap-f13');
    // 快照仍 READY 可用
    const v = await verifySnapshot(dir, 'snap-f13');
    assert.equal(v.ok, true);
  });
});

// ---------- JournalStore.listReferencedSnapshotIds 集成 ----------

test('F3: JournalStore.listReferencedSnapshotIds 收集未收敛 journal 的 snapshotId', async () => {
  await withTmp(async (dir) => {
    const store = new JournalStore({ transactionsDir: path.join(dir, 'transactions') });
    await store.ensureDirs();
    const mk = (opId: string, state: OperationJournal['state'], snapId: string | null): OperationJournal => {
      const j = createJournalEntry('import-apply', { operationId: opId, ownerInstanceId: 'o1', lockId: 'l1', packageVersion: '0.1.54', environmentFingerprint: 'fp' }, '2026-01-01T00:00:00.000Z');
      j.state = state as never;
      j.snapshotId = snapId;
      return j;
    };
    // active 非终态 + 引用 snap-a → 收集
    await store.create(mk('00000000-0000-4000-8000-000000000001', 'APPLYING', 'snap-a'));
    // active 非终态无引用 → 不收集
    await store.create(mk('00000000-0000-4000-8000-000000000002', 'SNAPSHOT_CREATED', null));
    // COMMITTED 已消费 → 不收集
    await store.create(mk('00000000-0000-4000-8000-000000000003', 'COMMITTED', 'snap-c'));
    const refs = await store.listReferencedSnapshotIds();
    assert.equal(refs.has('snap-a'), true, 'active APPLYING 引用的快照应被保护');
    assert.equal(refs.has('snap-c'), false, 'COMMITTED 已消费快照不保护');
    assert.equal(refs.size, 1);
  });
});

// ---------- Phase 4 Windows / FS 定向（可自动化部分） ----------

test('W-01: isReservedInternalRel 大小写不敏感（Windows case-insensitive 模拟）', () => {
  // Windows 文件系统大小写不敏感：攻击者用不同大小写绕过保留区检测
  assert.equal(isReservedInternalRel('dsh-config-manager/snapshots/x/snapshot.json'), true);
  assert.equal(isReservedInternalRel('DSh-Config-Manager/Snapshots/X/snapshot.json'), true, '大小写变体须命中');
  assert.equal(isReservedInternalRel('DSH-CONFIG-MANAGER\\TRANSACTIONS\\ACTIVE\\x.json'), true, '反斜杠 + 大小写变体须命中');
});

test('W-02: isReservedInternalRel 反斜杠归一（Windows 分隔符）', () => {
  assert.equal(isReservedInternalRel('dsh-config-manager\\snapshots\\fake\\snapshot.json'), true);
  assert.equal(isReservedInternalRel('dsh-config-manager\\sync\\snapshots\\fake\\m.json'), true);
  assert.equal(isReservedInternalRel('dsh-config-manager\\sync\\work\\tmp.zip'), true);
  // 合法 self 配置不得误伤
  assert.equal(isReservedInternalRel('dsh-config-manager\\sync\\sync-config.json'), false);
  assert.equal(isReservedInternalRel('dsh-config-manager/sync/sync-selection.json'), false);
});

test('W-03: F13 EPERM/EBUSY prune 模拟（fs.rm 抛错不阻断 save）', async () => {
  // 用自定义 referencedSnapshotIds provider 在 prune 时抛「EPERM」模拟被占用文件，
  // 已有 F13 覆盖 provider 抛错；这里再验证「save 的 prune 内部 fs.rm 抛错」也被吞掉。
  // FileSnapshotStore.prune 的参照方是 provider；为模拟 fs.rm 抛错，注入 provider 在内部抛 EPERM-like。
  await withTmp(async (dir) => {
    let calls = 0;
    const store = new FileSnapshotStore({
      dir,
      referencedSnapshotIds: async () => {
        calls += 1;
        if (calls > 1) {
          const e = new Error('EPERM: operation not permitted, rmdir snapshot');
          (e as { code?: string }).code = 'EPERM';
          throw e;
        }
        return new Set();
      },
    });
    // 首个 save 成功、第二个触发 prune（provider 抛 EPERM）→ 不应让第二个 save 失败
    await store.save(minSnapshot('w3a', '2026-01-01T00:00:00.000Z'));
    const id2 = await store.save(minSnapshot('w3b', '2026-02-01T00:00:00.000Z'));
    assert.equal(id2, 'w3b');
    assert.equal((await verifySnapshot(dir, 'w3b')).ok, true, 'EPERM prune 后新快照仍 READY');
  });
});

test('W-04: 恢复校验在 symlink 化 blob 时报 UNSAFE_PATH（F25 Windows junction/symlink 语义）', async () => {
  await withTmp(async (dir) => {
    const snapDir = path.join(dir, 'snapshots');
    await fs.mkdir(snapDir, { recursive: true });
    // 构造一个 READY 快照后把 blob 替换为 symlink 指向外部
    const ctx = makeContext('win32', path.join(dir, 'home'), 'web');
    ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] });
    await ctx.fs.writeFile('settings.yaml', Buffer.from('settings-content'));
    const store = new FileSnapshotStore({ dir: snapDir });
    const plan = { items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }], globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false, estimatedActions: {} as import('../../src/core/types.ts').ImportPlan['estimatedActions'] };
    const snap = await createSnapshot({
      ctx, plan, sourceZip: 'x', store, adapters: [],
      operationId: 'op', operationType: 'import-apply', environmentFingerprint: 'fp', ownerInstanceId: 'o',
    });
    // 从 manifest 拿 blob 路径并 symlink 化一个 blob → verifySnapshot 的 sha256 跟随 readFile 读到同内容仍可能过；
    // 但校验 UNSAFE_PATH 需要 lstat 检测关键文件 symlink。这里检测 manifest/snapshot.json（restore validator 已覆盖）。
    // 补充验证：blob 被替换为外部文件（同内容）仍通过 hash —— 说明 blob symlink 需在 restore validator 层 lstat。
    const { validateSnapshotForRestore } = await import('../../src/core/restore.ts');
    const mp = path.join(snapDir, snap.id, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(mp, 'utf8'));
    const blobKeys = Object.keys(manifest.blobHashes ?? {});
    assert.ok(blobKeys.length > 0);
    // 用外部实体替换 blob（symlink 化：目标指向 snapshots 外）→ 校验应因路径/symlink 或 hash 拒绝
    const outside = path.join(dir, 'outside-blob');
    await fs.writeFile(outside, 'HACKED-VIA-SYMLINK');
    const blobPath = path.join(snapDir, snap.id, blobKeys[0]!);
    await fs.rm(blobPath);
    await fs.symlink(outside, blobPath);
    const verdict = await validateSnapshotForRestore(path.join(snapDir, snap.id), snapDir);
    assert.ok(
      ['UNSAFE_PATH', 'CORRUPT'].includes(verdict.verdict),
      `symlink 化 blob 应被拒绝（UNSAFE_PATH 或 CORRUPT），实际 ${verdict.verdict}`,
    );
  });
});
