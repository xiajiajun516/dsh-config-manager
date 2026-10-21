/**
 * 快照落盘路径（backup.ts）回归测试（t51）。
 *
 * 背景：快照把「本次导入会写的目标文件」逐份读进内存 Map 再交给 store.save —— 大 home 下
 * 整块分区载荷同时驻留。t51 用方案 A 消除该驻留：FileSnapshotStore 新增 **saveStreaming**
 * （写盘与算 hash **同遍**完成），createSnapshot 改用**异步生成器按需读盘**（任一时刻只驻留
 * 一条），并以**能力探测**回退到既有 save(snapshot, eagerMap)。
 *
 * 为什么不是「惰性 Map」：Map 的迭代协议与 get 都是**同步**的（for...of 的 next() 必须同步
 * 返回 Uint8Array，get 返回 Uint8Array 而非 Promise），因此「迭代时按需读盘」若走 Map 契约
 * 只能用 readFileSync —— 那会把 t46 刚从压缩路径消除的同步 I/O 引回快照路径。故新增**接口之外**
 * 的可选能力（SnapshotStore 契约一字不改，见 src/core/types.ts:617）。
 *
 * 本文件先于实现写出（覆盖先行）：
 *  - P1 **宿主文件** blob 源只被读取一次、且确实走流式（不回退全量 Map）——实现前应为红；
 *    ⚠ 口径限制（t53 纠正）：P1 只覆盖宿主整文件备份（settings.yaml / cordis.patch.yml /
 *    profiles/<p>/*）。**文件类分区（skills 等）每条文件仍被读两次**：engineSnapshotEntry 为算
 *    `before.contentHash` 读一次 + 惰性 blob 源被消费时再读一次取字节。这是 HEAD 既有行为
 *    （t51 只把第二次读从「落盘前一次性读」改成「按需读」，**次数不变**），也不影响驻留指标 ——
 *    流式的价值是「任一时刻只驻留一条」，与「同一文件被读几次」是两件事。见下方 t53 用例。
 *    （t54：该用例改为**零磁盘**运行 —— 断言一字未改，只是不再让它在 %TEMP% 里做真实磁盘 I/O；理由见该用例前的 t54 说明。）
 *  - P2 流式与非流式落盘的 manifest.blobHashes 逐条一致 —— 实现前应为红；
 *  - P3 能力探测回退（不支持 saveStreaming 的 store 走既有 save 且行为不变）—— 既有行为守卫；
 *  - P4 durable+verified 不变量（verifySnapshot 从磁盘独立校验）—— 既有行为守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileSnapshotStore, createSnapshot, normalizeDshVersion, resolveFileTarget, verifySnapshot } from './backup.ts';
import { rollback } from './rollback.ts';
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts';
import type { ImportPlan, Snapshot, SnapshotStore } from './types.ts';
import type { SectionId } from '../schema/types.ts';

/** 空计划即可：宿主整文件备份（settings.yaml / cordis.patch.yml / profiles/<p>/*）无条件执行，
 *  用它造出多个「来源文件不同」的 blob，正是本文件要计数的对象。 */
function emptyPlan(): ImportPlan {
  return {
    items: [], globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as Record<SectionId, number>,
  };
}

const HOST_FILES: ReadonlyArray<[string, string]> = [
  ['settings.yaml', 'settings: v1'],
  ['cordis.patch.yml', '- insert: []'],
  ['profiles/web/cordis.patch.yml', 'profile: patch'],
];

/** 可计数的 ctx：记录每一次 ctx.fs.readFile(rel)。用于证明「**宿主文件** blob 源只读一次」（P1）；
 *  文件类分区的读次数口径不同（每条两次），见 t53 用例。 */
function countingCtx(): { ctx: ReturnType<typeof makeContext>; reads: string[] } {
  const ctx = makeContext('win32', 'C:/home/.dsh', 'web');
  const reads: string[] = [];
  const fsFacade = ctx.fs as { readFile: (rel: string) => Promise<Uint8Array> };
  const original = fsFacade.readFile.bind(ctx.fs);
  fsFacade.readFile = async (rel: string) => { reads.push(rel); return original(rel); };
  return { ctx, reads };
}

async function seedHostFiles(ctx: ReturnType<typeof makeContext>): Promise<void> {
  for (const [rel, text] of HOST_FILES) await ctx.fs.writeFile(rel, Buffer.from(text, 'utf8'));
}

/** 只实现 SnapshotStore 接口的 store（**刻意不暴露 saveStreaming**）→ 必须走能力探测回退。
 *  参数取接口本身（t54）：既可包真实磁盘的 FileSnapshotStore（P2/P3），也可包内存实现（t53 用例）。 */
function interfaceOnlyStore(inner: SnapshotStore, onSave: () => void): SnapshotStore {
  return {
    save: async (snapshot, blobs) => { onSave(); return inner.save(snapshot, blobs); },
    load: (id) => inner.load(id),
    readBlob: (id, blobPath) => inner.readBlob(id, blobPath),
    updateStatus: (id, status) => inner.updateStatus(id, status),
  };
}

/** 内存版「带 saveStreaming 的 store」（t54）：供文件类分区读数用例使用，使它**零磁盘**。
 *  消费契约与 FileSnapshotStore.saveStreaming 一致（拿到异步 blob 源 → 逐条取值 → 落库）；
 *  真实磁盘的「写盘 + hash 同遍」路径由 P1/P2/P3 覆盖，不因本用例而失去覆盖。 */
function memStreamingStore(onStream: () => void): SnapshotStore & {
  saveStreaming: (snapshot: Snapshot, blobs: AsyncIterable<readonly [string, Uint8Array]>) => Promise<string>;
} {
  const inner = new MemSnapshotStore();
  return {
    save: (snapshot, blobs) => inner.save(snapshot, blobs),
    load: (id) => inner.load(id),
    readBlob: (id, blobPath) => inner.readBlob(id, blobPath),
    updateStatus: (id, status) => inner.updateStatus(id, status),
    saveStreaming: async (snapshot, blobs) => {
      onStream();
      const all = new Map<string, Uint8Array>();
      for await (const [blobPath, data] of blobs) all.set(blobPath, data);
      return inner.save(snapshot, all);
    },
  };
}

async function tmpDir(t: { after: (fn: () => Promise<void> | void) => void }, label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-backup-${label}-`));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/* ---------------- P1：每条 blob 只被读取一次（且走流式） ---------------- */

test('P1(t51): 快照落盘走流式路径，且**宿主文件** blob 源只被读取一次', async (t) => {
  const dir = await tmpDir(t, 'p1');
  const { ctx, reads } = countingCtx();
  await seedHostFiles(ctx);
  const store = new FileSnapshotStore({ dir });

  // 实现前：FileSnapshotStore 上没有 saveStreaming → 本断言红（这正是「先写探针」的目的）
  assert.equal(
    typeof (store as unknown as { saveStreaming?: unknown }).saveStreaming, 'function',
    'FileSnapshotStore 必须提供 saveStreaming（t51 方案 A：接口之外的可选能力）',
  );
  let streamingCalls = 0;
  const streaming = store as unknown as {
    saveStreaming: (s: unknown, b: AsyncIterable<readonly [string, Uint8Array]>) => Promise<string>;
  };
  const originalStreaming = streaming.saveStreaming.bind(store);
  streaming.saveStreaming = async (snapshot, blobs) => { streamingCalls += 1; return originalStreaming(snapshot, blobs); };

  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });

  assert.equal(streamingCalls, 1, 'createSnapshot 必须走 saveStreaming（否则驻留消除失效）');
  const counted = reads.filter((r) => HOST_FILES.some(([rel]) => rel === r));
  assert.deepEqual(
    [...counted].sort(), HOST_FILES.map(([rel]) => rel).sort(),
    '每个**宿主文件** blob 源必须恰好被读一次（重复读意味着生成器被迭代两次）；'
    + '文件类分区（skills 等）是每条两次，见下方 t53 用例',
  );
  // 落盘完整性：blob 文件与 manifest 都在
  const manifest = JSON.parse(await fs.readFile(path.join(dir, snapshot.id, 'manifest.json'), 'utf8')) as {
    blobHashes: Record<string, string>;
  };
  assert.equal(Object.keys(manifest.blobHashes).length, HOST_FILES.length, '每条源都应有对应 blob 与 hash');
});

/* ---------------- P2：hash 逐条与既有行为一致 ---------------- */

test('P2(t51): 流式落盘与既有（全量 Map）落盘产出的 manifest.blobHashes 逐条一致', async (t) => {
  const dirStream = await tmpDir(t, 'p2s');
  const dirEager = await tmpDir(t, 'p2e');

  const streamCtx = countingCtx();
  await seedHostFiles(streamCtx.ctx);
  const streamStore = new FileSnapshotStore({ dir: dirStream });
  let streamingCalls = 0;
  const streaming = streamStore as unknown as {
    saveStreaming: (s: unknown, b: AsyncIterable<readonly [string, Uint8Array]>) => Promise<string>;
  };
  const originalStreaming = streaming.saveStreaming.bind(streamStore);
  streaming.saveStreaming = async (snapshot, blobs) => { streamingCalls += 1; return originalStreaming(snapshot, blobs); };
  const streamed = await createSnapshot({
    ctx: streamCtx.ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store: streamStore, adapters: [],
  });
  assert.equal(streamingCalls, 1, 'P2 要在**流式**路径上比对 —— 未走流式则本断言红（实现前）');

  // 同一夹具走「只实现接口」的 store（无 saveStreaming）→ 既有全量 Map 路径
  const eagerCtx = countingCtx();
  await seedHostFiles(eagerCtx.ctx);
  let eagerSaves = 0;
  const eagerStore = interfaceOnlyStore(new FileSnapshotStore({ dir: dirEager }), () => { eagerSaves += 1; });
  const eager = await createSnapshot({
    ctx: eagerCtx.ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store: eagerStore, adapters: [],
  });
  assert.equal(eagerSaves, 1, '不支持 saveStreaming 的 store 必须仍经 save() 落盘');

  const readHashes = async (dir: string, id: string): Promise<Record<string, string>> => {
    const raw = await fs.readFile(path.join(dir, id, 'manifest.json'), 'utf8');
    return (JSON.parse(raw) as { blobHashes: Record<string, string> }).blobHashes;
  };
  const streamHashes = await readHashes(dirStream, streamed.id);
  const eagerHashes = await readHashes(dirEager, eager.id);
  // blobPath 含随机 UUID（blobs/host/<uuid>），故按「排序后的 hash 多重集」比对，断言逐条 hash 一致
  assert.deepEqual(
    Object.values(streamHashes).sort(), Object.values(eagerHashes).sort(),
    '同一夹具在流式与非流式路径下的 blob hash 必须逐条一致',
  );
  assert.equal(Object.keys(streamHashes).length, HOST_FILES.length);
});

/* ---------------- P3：能力探测回退（既有行为守卫） ---------------- */

test('P3(t51): 不支持 saveStreaming 的 store 走既有 save(snapshot, eagerMap) 且行为不变', async (t) => {
  const dir = await tmpDir(t, 'p3');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  // (a) 只实现接口的对象
  let saves = 0;
  const inner = new FileSnapshotStore({ dir });
  const snapshot = await createSnapshot({
    ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store: interfaceOnlyStore(inner, () => { saves += 1; }), adapters: [],
  });
  assert.equal(saves, 1, '接口 store（无 saveStreaming）必须走 save()');
  assert.equal((await verifySnapshot(dir, snapshot.id)).ok, true, '回退路径产物必须通过磁盘校验');

  // (b) MemSnapshotStore（内存实现，同样没有 saveStreaming）
  const memCtx = countingCtx();
  await seedHostFiles(memCtx.ctx);
  const mem = new MemSnapshotStore();
  const memSnap = await createSnapshot({
    ctx: memCtx.ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store: mem, adapters: [],
  });
  assert.equal(mem.snapshots.has(memSnap.id), true, 'MemSnapshotStore 行为不变（快照已登记）');
  assert.equal(mem.blobs.size, HOST_FILES.length, 'MemSnapshotStore 的 blob 数量不变');
});

/* ---------------- P4：durable+verified 不变量（既有行为守卫） ---------------- */

test('P4(t51): verifySnapshot 从磁盘独立校验 —— 篡改 blob 后必须失败', async (t) => {
  const dir = await tmpDir(t, 'p4');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  const store = new FileSnapshotStore({ dir });
  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  assert.equal((await verifySnapshot(dir, snapshot.id)).ok, true, '刚落盘的快照必须 verified');

  // 篡改一个 blob（内存里那份 Map 早已不存在，只能从磁盘改写）→ 校验必须发现
  const blobDir = path.join(dir, snapshot.id, 'blobs', 'host');
  const [firstBlob] = await fs.readdir(blobDir);
  assert.ok(firstBlob !== undefined);
  await fs.writeFile(path.join(blobDir, firstBlob), Buffer.from('tampered'), 'utf8');
  const after = await verifySnapshot(dir, snapshot.id);
  assert.equal(after.ok, false, 'verifySnapshot 必须从磁盘重读并发现篡改（不信任内存对象）');
});

/* ---------------- 空 blob 集合不得退化 ---------------- */

test('t51: 没有任何 blob 时（宿主文件都不存在）两条路径都能正常落盘并 verified', async (t) => {
  const dir = await tmpDir(t, 'empty');
  const { ctx, reads } = countingCtx(); // 不 seed 任何宿主文件
  const store = new FileSnapshotStore({ dir });
  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  assert.deepEqual(reads, [], '没有可读取的 blob 源时不应发生读取');
  assert.equal((await verifySnapshot(dir, snapshot.id)).ok, true);
});

/* ---------------- 文件类分区（skills）：读次数口径（t53 纠正 P1 的范围） ---------------- */

/**
 * 口径纠正（t53，Wave 2 验证者 t50 的独立发现）：P1 的「每条 blob 源只读一次」**只覆盖宿主文件**。
 * 文件类分区（skills / agentPresets / …）**每条文件仍读两次**：
 *  ① `engineSnapshotEntry` 为算 `before.contentHash` 读一次（backup.ts 的文件类分支）；
 *  ② 惰性 blob 源被消费时再读一次取字节（streaming 的 `for await` / eager 建 Map）。
 *
 * 两条事实必须钉住：
 *  a. 这是 HEAD 既有行为 —— t51 只把 ② 从「落盘前一次性读」改成「按需读」，**读次数不变**；
 *  b. 它不影响驻留指标 —— 流式的价值是「任一时刻只驻留一条」，与「同一文件被读几次」是两件事。
 *
 * 因此本用例断言「两种模式读数完全一致且都是每条两次」：将来若有人把它误当 t51 的回归修掉，这里会红；
 * 若将来真的要减少这次重复读，应作为独立优化立项，并同步更新本用例与 P1 的口径说明。
 *
 * t54（负载脆弱性加固 —— 修因不修相）：本用例的**断言只数 ctx.fs 读数**（纯内存、确定性），但它原先为了
 * 拿一个「带 saveStreaming 的 store」而引入真实磁盘 I/O：每个模式在 %TEMP% 建目录、逐 blob 原子写、从盘校验、
 * prune 扫描、after-hook 递归 rm。这些磁盘动作对断言零贡献，却是**唯一的负载敏感面**：
 *  · Windows 上对**已存在**文件做 replace 式 rename（finalizeSnapshot 的 READY 重写 snapshot.json），只要该文件
 *    被任何外部读句柄持有就必失败 EPERM（本机实测：连续 5 次 replace-rename 全部 EPERM）；
 *  · 而 atomicWriteFile 对瞬时占用只有 3 次 / 25→50→100ms 的**有界重试**（src/utils/atomic-write.ts:232-253），
 *    并发负载（杀软/索引器/其它进程扫描 %TEMP%）下重试被耗尽 → createSnapshot 抛 fs 错误码，
 *    这条用例就以 **rename EPERM**（而非断言差异）在声明行变红（注入实测：并发持有读句柄时 12 次红 1 次）。
 * 修法：store 全换内存实现 —— 断言一字未改（仍是「两种模式读数一致且每条两次」），并新增「确实走了预期
 * 路径」的断言；真实磁盘的流式落盘路径继续由 P1/P2/P3 覆盖，不因本用例失去覆盖。
 */
test('t53(fixture): 文件类分区（skills）每条读两次，且 streaming 与 eager 读数一致（非本次改造引入）', async () => {
  const SKILL_RELS = ['bar/SKILL.md', 'bar/ref.md', 'baz/SKILL.md'];
  const skillsPlan: ImportPlan = {
    items: SKILL_RELS.map((ref) => ({
      id: `skills:${ref}`, kind: 'Update' as const, adapter: 'skills' as const,
      description: ref, severity: 'info' as const, target: { adapter: 'skills' as const, ref },
    })),
    globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as Record<SectionId, number>,
  };

  /** 文件类目标走绝对路径读（resolveFileTarget），统一归一成 skills/... 便于比对 */
  const canon = (p: string): string => p.replace(/\\/g, '/').replace(/^.*?\/skills\//, 'skills/');

  /** 两种模式各跑一遍：**全部内存 store**（零磁盘）—— 断言只看 ctx.fs 读数，与 %TEMP% 无关。 */
  const runReads = async (mode: 'streaming' | 'eager'): Promise<{ reads: string[]; streamed: number; saved: number }> => {
    const { ctx, reads } = countingCtx();
    // 用**引擎将要读的那个绝对路径**播种（文件类目标由 resolveFileTarget 拼绝对路径；MemFs 的 key 由此可比对）
    for (const rel of SKILL_RELS) {
      await ctx.fs.writeFile(resolveFileTarget(ctx, 'skills', rel), Buffer.from(`# ${rel}\n`, 'utf8'));
    }
    let streamed = 0;
    let saved = 0;
    // streaming：store 带 saveStreaming（能力探测命中）；eager：接口-only 包装 → 走既有 save(snapshot, Map)
    const store: SnapshotStore = mode === 'streaming'
      ? memStreamingStore(() => { streamed += 1; })
      : interfaceOnlyStore(new MemSnapshotStore(), () => { saved += 1; });
    await createSnapshot({ ctx, plan: skillsPlan, sourceZip: 'unit.zip', store, adapters: [] });
    return { reads: reads.filter((r) => canon(r).startsWith('skills/')).map(canon).sort(), streamed, saved };
  };

  const streaming = await runReads('streaming');
  const eager = await runReads('eager');
  const expected = [...SKILL_RELS, ...SKILL_RELS].map((rel) => `skills/${rel}`).sort();

  assert.deepEqual(streaming.reads, expected, 'streaming：每条 skills 文件恰好读两次（contentHash + 惰性 blob）');
  assert.deepEqual(eager.reads, expected, 'eager：每条 skills 文件同样读两次（与 HEAD 一致）');
  assert.deepEqual(streaming.reads, eager.reads, '两种模式读数必须一致 —— 差异不会是 t51 引入的回归');
  // t54：两条路径必须**各自走对**。原用例只看读数，无法区分「两条都被回退到 eager」（那样读数也会一致）。
  assert.equal(streaming.streamed, 1, 'streaming 模式必须走 store.saveStreaming（能力探测命中）');
  assert.equal(streaming.saved, 0, 'streaming 模式不得回退到 save(snapshot, eagerMap)');
  assert.equal(eager.streamed, 0, 'eager 模式不得走 saveStreaming');
  assert.equal(eager.saved, 1, 'eager 模式必须走既有 save(snapshot, eagerMap)');
});

/* ---------------- F-4：快照记录来源 DSH 版本（可选字段） ---------------- */

test('F-4: 快照记录拍快照那一刻的本机 DSH 版本，并经 snapshot.json 往返（恢复读的就是这份）', async (t) => {
  const dir = await tmpDir(t, 'f4');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  const store = new FileSnapshotStore({ dir });

  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  assert.equal(snapshot.dshVersion, '0.1.0-rc.6', '必须记录 HostContext.dshVersion')
  const loaded = await store.load(snapshot.id);
  assert.equal(loaded.dshVersion, '0.1.0-rc.6', '必须经 snapshot.json 往返落盘')
  assert.equal((await verifySnapshot(dir, snapshot.id)).ok, true, '新增字段不得破坏 durable+verified（metadataHash 口径不变）');
});

test('F-4: 版本无法判定（unknown/空白）→ 不写该字段（绝不拿占位值当已知版本）', async (t) => {
  const dir = await tmpDir(t, 'f4u');
  const { ctx } = countingCtx();
  ctx.dshVersion = 'unknown';
  await seedHostFiles(ctx);
  const store = new FileSnapshotStore({ dir });

  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  assert.equal(snapshot.dshVersion, undefined);
  const raw = JSON.parse(await fs.readFile(path.join(dir, snapshot.id, 'snapshot.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('dshVersion' in raw, false, '占位值绝不落盘（否则恢复时会误报「版本不同」）');
});

test('F-4: normalizeDshVersion 归一（去空白 / unknown 丢弃 / 非字符串不猜）', () => {
  assert.equal(normalizeDshVersion(' 0.1.5-rc.1 '), '0.1.5-rc.1');
  assert.equal(normalizeDshVersion('unknown'), undefined);
  assert.equal(normalizeDshVersion('   '), undefined);
  assert.equal(normalizeDshVersion(undefined), undefined);
  assert.equal(normalizeDshVersion(42), undefined);
});

/* ---------------- 宿主文件「存在但读不出来」不得记成 existed:false（数据安全） ---------------- */

test('备份：宿主文件存在但读不出来 → existed=true + unreadable=true（绝不写 existed:false）', async (t) => {
  const dir = await tmpDir(t, 'unreadable');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  // 让 settings.yaml 这一次读不出来（占用 / 权限 / IO 错的等价物）
  const fsFacade = ctx.fs as { readFile: (rel: string) => Promise<Uint8Array> };
  const original = fsFacade.readFile.bind(ctx.fs);
  fsFacade.readFile = async (rel: string) => {
    if (rel === 'settings.yaml') throw new Error('EBUSY: resource busy or locked');
    return original(rel);
  };
  const store = new FileSnapshotStore({ dir });
  const snapshot = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });

  const settings = (snapshot.hostFileBackups ?? []).find((b) => b.relPath === 'settings.yaml');
  assert.ok(settings, 'settings.yaml 必须仍被登记（绝不因读失败而消失）');
  assert.equal(settings.existed, true, '存在但读不到 → existed 必须为 true（写成 false 会在恢复时删掉用户真实文件）');
  assert.equal(settings.unreadable, true, '必须显式标注 unreadable');
  assert.equal(settings.blobPath, '', '读不到 → 没有 blob');
  const patch = (snapshot.hostFileBackups ?? []).find((b) => b.relPath === 'cordis.patch.yml');
  assert.equal(patch?.existed, true, '其余宿主文件照常读');
  assert.equal(patch?.unreadable, undefined, '读得到的条目不得被标 unreadable');
  assert.equal((await verifySnapshot(dir, snapshot.id)).ok, true, 'unreadable 条目不得破坏 durable+verified');
});

/* ---------------- 保留清理 fail-closed：引用集合读不出来时本轮绝不删（数据安全） ---------------- */

test('保留清理：recovery 引用集合读不出来 → 本轮放弃清理，绝不按空集合删（F3 不可回退）', async (t) => {
  const dir = await tmpDir(t, 'prune-ref');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  let scans = 0;
  const warned: string[] = [];
  const store = new FileSnapshotStore({
    dir,
    // 引用扫描一次瞬时失败（EACCES / IO 错）—— 此前会被 .catch 成空集合，随即按「无人引用」继续删
    referencedSnapshotIds: async () => { scans += 1; throw new Error('EACCES: permission denied'); },
    retentionPolicy: () => ({ keepLast: 1, keepMonthly: 0, keepYearly: 0 }),
    onWarn: (message) => { warned.push(message) },
  });

  const first = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  const second = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });

  assert.ok(scans >= 1, 'prune 必须真的问过 recovery 引用集合（否则本用例不成立）');
  const remaining = (await fs.readdir(dir)).sort();
  assert.deepEqual(remaining, [first.id, second.id].sort(), '读不到引用集合时本轮必须放弃清理 —— 两个快照都得留着');
  assert.ok(warned.some((m) => m.includes('放弃')), '放弃必须留痕（绝不静默）：' + JSON.stringify(warned));
});

/* ---------------- 保留清理：目录名 ≠ 内部 id 时跳过并留痕（数据安全） ---------------- */

test('保留清理：快照目录名与内部 id 不一致时跳过并留痕（绝不按内部 id 删另一个目录）', async (t) => {
  const dir = await tmpDir(t, 'prune-name');
  const { ctx } = countingCtx();
  await seedHostFiles(ctx);
  const warned: string[] = [];
  const store = new FileSnapshotStore({
    dir,
    retentionPolicy: () => ({ keepLast: 1, keepMonthly: 0, keepYearly: 0 }),
    onWarn: (message) => { warned.push(message) },
  });
  const first = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });
  // 手工制造「目录名 ≠ 内部 id」（改名目录 / 半截拷贝残留的真机形态）
  const renamed = path.join(dir, 'zzz-renamed-dir');
  await fs.rename(path.join(dir, first.id), renamed);
  const second = await createSnapshot({ ctx, plan: emptyPlan(), sourceZip: 'unit.zip', store, adapters: [] });

  const remaining = (await fs.readdir(dir)).sort();
  assert.ok(remaining.includes('zzz-renamed-dir'), '目录名与内部 id 不一致的目录绝不能被当成候选删掉');
  assert.ok(remaining.includes(second.id), '新建的快照当然还在');
  assert.ok(warned.some((m) => m.includes('不一致')), '跳过必须留痕（绝不静默）：' + JSON.stringify(warned));
});

/* ---------------- 方案 C：MCP 连接器存储文件（整文件快照 / 回滚） ---------------- */

test('mcp 连接器：storages/mcp_connector.json 进快照为整文件条目，回滚按原字节还原', async () => {
  const { ctx } = countingCtx();
  const rel = 'storages/mcp_connector.json';
  // 用引擎真正会读的那个路径播种（file 类目标由 resolveFileTarget 拼绝对路径）
  const abs = resolveFileTarget(ctx, 'mcp', rel);
  const original = JSON.stringify({
    unit: { name: 'mcp_connector', version: 1 },
    global: null,
    tables: { connections: { 'a-a': { key: 'a-a', serverName: 'a' } }, grants: { g1: { key: 'g1' } }, tool_catalog: { t: 1 } },
  });
  await ctx.fs.writeFile(abs, Buffer.from(original, 'utf8'));

  const plan: ImportPlan = {
    items: [{
      id: 'mcp-connector:a-a', kind: 'Create' as const, adapter: 'mcp' as const,
      description: 'a', severity: 'info' as const, target: { adapter: 'mcp' as const, ref: rel },
    }],
    globalStrategy: 'merge', pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as Record<SectionId, number>,
  };
  const store = new MemSnapshotStore();
  const snapshot = await createSnapshot({ ctx, plan, sourceZip: 'unit.zip', store, adapters: [] });

  const entry = snapshot.entries.find((e) => e.adapter === 'mcp' && e.ref === rel);
  assert.equal(entry?.kind, 'file', '连接器存储必须走整文件快照（patchLine 语义撤不回它）');
  assert.equal(entry?.existed, true);
  assert.ok(entry?.copiedTo, '必须真的拷出一份 blob，否则回滚无字节可写回');
  const blob = new TextDecoder().decode(await store.readBlob(snapshot.id, entry!.copiedTo!));
  assert.equal(blob, original, '快照必须逐字节含全部表（grants/tool_catalog 不能被裁掉）');

  // 模拟导入改写（只留 connections）→ 回滚必须回到原字节
  await ctx.fs.writeFile(abs, Buffer.from('{"tables":{"connections":{}}}', 'utf8'));
  const report = await rollback({ ctx, snapshot, store });
  assert.equal(report.full, true, JSON.stringify(report.failed));
  assert.deepEqual(report.restored, ['mcp:' + rel], '回滚必须报告真正被还原的那一条');
  assert.equal(new TextDecoder().decode(await ctx.fs.readFile(abs)), original);
});
