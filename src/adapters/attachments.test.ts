/**
 * attachments adapter 测试（P1）：只带被会话引用过的附件 + 缺失计数 + 降级方向。
 *
 * 判据全部来自「会话日志文本里的 attachmentId」——因此样本日志必须是真的 zstd 帧，
 * 否则测的就不是真实路径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttachmentsAdapter, resetAttachmentsScanCache } from './attachments.ts';
import { makeContext } from './test-helpers.ts';
import { ATTACHMENT_CACHE_REL } from './attachment-index-cache.ts';
import { zhMsg } from '../core/messages.ts';
import { encodeZstdFrame, zstdAvailable } from '../utils/zstd-frame.ts';

const CAPABLE = zstdAvailable();
const hex = (ch: string): string => ch.repeat(64);
const ID_A = 'sha256:' + hex('a');
const ID_B = 'sha256:' + hex('b');
const ID_C = 'sha256:' + hex('c');
const ID_MISSING = 'sha256:' + hex('d');

/** 一个会话日志帧：内容是真实 DSH 事件形状里的附件引用。 */
function logFrame(ids: readonly string[]): Uint8Array {
  const events = ids.map((id, i) => JSON.stringify({
    seq: i,
    type: 'message',
    data: { type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 10 } },
  }));
  return encodeZstdFrame(Buffer.from(events.join('\n') + '\n', 'utf8'));
}

/** 造一台「本机库 + 两个会话」的宿主：对象 A/B/C 存在，D 被引用但已不在库里。 */
async function makeFixture(): Promise<ReturnType<typeof makeContext>> {
  // 引用面缓存是模块级状态（TTL 60s）：每个用例从干净缓存开始，否则用例之间会互相漏气
  resetAttachmentsScanCache();
  const ctx = makeContext('linux', '/home/alice');
  const put = async (rel: string, data: Uint8Array): Promise<void> => { await ctx.fs.writeFile(rel, data); };
  await put('attachments/v1/objects/aa/' + hex('a'), Buffer.from('A'));
  await put('attachments/v1/objects/bb/' + hex('b'), Buffer.from('BB'));
  await put('attachments/v1/objects/cc/' + hex('c'), Buffer.from('CCC'));
  await put('sessions/proj-1/sess-1/session.jsonl', logFrame([ID_A, ID_C, ID_MISSING]));
  await put('sessions/proj-1/sess-2/session.jsonl', logFrame([ID_B]));
  return ctx;
}

test('P1-1 export：只带被选中会话引用过、且本机存在的附件；缺失额计入告警', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, {
    includeSecrets: false,
    includeItems: { sessions: ['sessions:proj-1/sess-1'] },
  });
  const rels = out.data.files.map((f) => f.relativePath).sort();
  assert.deepEqual(rels, ['v1/objects/aa/' + hex('a'), 'v1/objects/cc/' + hex('c')]);
  assert.equal(out.data.files.length, 2);
  assert.ok(
    out.warnings.includes(zhMsg('export.attachmentsReferenced', {
      count: '2', total: '3', missing: '1',
    })),
    '告警必须同时给出「带走的 / 库内的 / 引用但缺失的」三个数',
  );
});

test('P1-2 单元 id = attachments:<attachmentId>（一个对象一个单元）', async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  const units = adapter.listUnits(out);
  const ids = units.map((u) => u.id).sort();
  assert.deepEqual(ids, ['attachments:' + ID_A, 'attachments:' + ID_B, 'attachments:' + ID_C].sort());
});

test('P1-3 会话分区选空 ⇒ 附件一条都不带（附告警），不静默给出整库', async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: [] } });
  assert.equal(out.data.files.length, 0);
  assert.ok(out.warnings.includes(zhMsg('export.attachmentsNoSessions')));
});

test('P1-4 未指定会话选择 ⇒ 按全部会话收集（只有被引用过的进包）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.files.length, 3, 'A/B/C 三个对象都被某个会话引用过');
});

test('P1-5 sessions.limit 不复刻排序：如实告警且仍按全部会话收集', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: 1 } });
  assert.ok(out.warnings.includes(zhMsg('export.attachmentsLimitIgnored')));
  assert.equal(out.data.files.length, 3);
});

test('P1-6 会话日志帧损坏 ⇒ 退回整库并告警（宁可多带，不静默丢图）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  // 魔数正确、帧体是垃圾：扫描能认出帧头，解压必然失败。
  const corrupt = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(24, 0x41)]);
  await ctx.fs.writeFile('sessions/proj-1/sess-1/session.jsonl', corrupt);
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.files.length, 3, '降级方向 = 整库（3 个对象）');
  assert.ok(out.warnings.some((w) => w.includes(zhMsg('export.attachmentsScanFailed', { count: '1' }))));
});

test('P1-7 未收窄会话范围 ⇒ 如实告警「按全部会话算引用面」，不静默给出整库', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const out = await new AttachmentsAdapter().export(ctx, { includeSecrets: false });
  assert.ok(
    out.warnings.includes(zhMsg('export.attachmentsAllSessions', { count: '3', total: '3', missing: '1' })),
    '未指定会话时必须明说范围是全部会话',
  );
});

test('P1-8 引用面缓存：mtime 未变则复用，mtime 一变即失效', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const log = 'sessions/proj-1/sess-1/session.jsonl';
  ctx.fs.setMtime(log, 1_000);
  ctx.fs.setMtime('sessions/proj-1/sess-2/session.jsonl', 2_000);
  const adapter = new AttachmentsAdapter();
  assert.equal((await adapter.export(ctx, { includeSecrets: false })).data.files.length, 3);

  // 内容改了但 mtime 没变：TTL 内必须继续复用旧引用面（否则缓存没有意义）
  await ctx.fs.writeFile(log, logFrame([ID_C]));
  ctx.fs.setMtime(log, 1_000);
  assert.equal((await adapter.export(ctx, { includeSecrets: false })).data.files.length, 3, '缓存命中：按旧引用面');

  // mtime 变了：缓存必须失效，按新内容重算（A 不再被引用）
  ctx.fs.setMtime(log, 3_000);
  const third = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(third.data.files.length, 2, '只剩 B、C');
});

/* ------------------------------------------------------------------------------------------------
 * G5：预览富化 —— 附件挂到「用过它的会话」下面
 * ---------------------------------------------------------------------------------------------- */

/** 取一次真实导出 + 单元清单，然后按预览路径富化（与 /export-preview 调用顺序一致）。 */
async function enrichedFixture(): Promise<{
  ctx: ReturnType<typeof makeContext>
  units: Awaited<ReturnType<AttachmentsAdapter['enrichUnits']>>
}> {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  return { ctx, units: await adapter.enrichUnits(ctx, adapter.listUnits(out)) };
}

test('G5-1 同一附件被两条会话用过 ⇒ 两个父单元都写上（任一处取消即不带）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  // sess-2 也用了 A：A 成为两条会话共用的附件
  await ctx.fs.writeFile('sessions/proj-1/sess-2/session.jsonl', logFrame([ID_B, ID_A]));
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  const units = await adapter.enrichUnits(ctx, adapter.listUnits(out));
  assert.ok(units !== null);
  const a = units.find((u) => u.id === 'attachments:' + ID_A);
  assert.deepEqual([...(a?.parentUnitIds ?? [])].sort(), ['sessions:proj-1/sess-1', 'sessions:proj-1/sess-2']);
});

test('G5-2 展示名：有 mediaType 用它 + 短哈希作次要信息；没有 mediaType 就用短哈希', { skip: !CAPABLE }, async () => {
  const { units } = await enrichedFixture();
  assert.ok(units !== null);
  const a = units.find((u) => u.id === 'attachments:' + ID_A);
  assert.equal(a?.label, 'image/png', '有 mediaType 时展示名是类型，不是 64 位 sha');
  assert.equal(a?.detail, 'sha256:aaaaaaaa…', '次要信息只留前 8 位，足够分辨不同对象');
});

test('G5-3 本机日志损坏 ⇒ 富化返回 null（界面按扁平渲染），绝不猜归属', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const corrupt = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(24, 0x41)]);
  await ctx.fs.writeFile('sessions/proj-1/sess-1/session.jsonl', corrupt);
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(await adapter.enrichUnits(ctx, adapter.listUnits(out)), null);
});

test('G5-4 没有会话日志 ⇒ 单元原样返回（无归属 ≠ 因故障降级）', async () => {
  // 直接喂单元，绕开导出：没有引用时 export 本来就一条都不带，那是 P1 的正常行为，与富化无关。
  const ctx = makeContext('linux', '/home/alice');
  const adapter = new AttachmentsAdapter();
  const units = await adapter.enrichUnits(ctx, [{ id: 'attachments:' + ID_A, label: ID_A, sizeBytes: 1 }]);
  assert.deepEqual(units?.map((u) => u.id), ['attachments:' + ID_A]);
  assert.equal(units?.[0]?.parentUnitIds, undefined, '没有引用就是不知道，不能写成空数组');
});
test('P1-7 持久化缓存命中：第二次扫描只 stat 不读日志字节（清掉内存缓存也成立）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const put = 'sessions/proj-1/sess-1/session.jsonl';
  const put2 = 'sessions/proj-1/sess-2/session.jsonl';
  // 缓存键是 mtime + size：不登记 mtime 就永远不命中（MemFs 未登记返回 null，与真实门面同语义）
  ctx.fs.setMtime(put, 1_000);
  ctx.fs.setMtime(put2, 2_000);

  let sessionReads = 0;
  const realRead = ctx.fs.readFile.bind(ctx.fs);
  ctx.fs.readFile = async (rel: string) => {
    if (rel.startsWith('sessions/')) sessionReads += 1;
    return realRead(rel);
  };

  const adapter = new AttachmentsAdapter();
  const first = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(sessionReads, 2, '首轮如实读两份日志');
  assert.ok(await ctx.fs.exists(ATTACHMENT_CACHE_REL), '首轮必须把索引落到磁盘');
  assert.equal(first.data.files.length, 3);

  resetAttachmentsScanCache();
  const second = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(sessionReads, 2, '第二轮一次字节都不读（否则 230 MB 的解压又白跑一遍）');
  assert.deepEqual(
    second.data.files.map((f) => f.relativePath).sort(),
    first.data.files.map((f) => f.relativePath).sort(),
    '命中缓存不得改变结果',
  );
});

test('P1-8 缓存文件损坏 ⇒ 照常重扫并重建（缓存坏不许影响正确性）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  ctx.fs.setMtime('sessions/proj-1/sess-1/session.jsonl', 1_000);
  ctx.fs.setMtime('sessions/proj-1/sess-2/session.jsonl', 2_000);
  await ctx.fs.writeFile(ATTACHMENT_CACHE_REL, Buffer.from('{ broken', 'utf8'));

  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.files.length, 3, '损坏的缓存必须被忽略，结果与无缓存一致');
  const rebuilt = await ctx.fs.readFile(ATTACHMENT_CACHE_REL);
  assert.ok(Buffer.from(rebuilt).toString('utf8').includes('"version":1'), '重扫后要把缓存重建出来');
});

test('P1-9 拿不到 mtime ⇒ 不写缓存（不能靠猜的时间做失效键）', { skip: !CAPABLE }, async () => {
  const ctx = await makeFixture();
  const adapter = new AttachmentsAdapter();
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.files.length, 3, '没有 mtime 也要照常扫出结果');
  assert.equal(await ctx.fs.exists(ATTACHMENT_CACHE_REL), false, '时间不可读时宁可不缓存');
});

