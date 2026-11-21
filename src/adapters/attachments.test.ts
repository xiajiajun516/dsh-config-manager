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
