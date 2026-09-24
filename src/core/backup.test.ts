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

import { FileSnapshotStore, createSnapshot, resolveFileTarget, verifySnapshot } from './backup.ts';
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
