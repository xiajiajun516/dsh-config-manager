/**
 * 附件引用面持久化缓存的单测：命中条件、坏文件降级、写失败的静默。
 *
 * 这套缓存的唯一职责是「别重复解压 230 MB」，因此测试只钉两件事：
 * 采信条件必须严格（mtime + size 同时相等），读不到就退回重扫（绝不拿旧结果冒充当前）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_CACHE_REL,
  loadAttachmentRefCache,
  saveAttachmentRefCache,
} from './attachment-index-cache.ts';
import { makeContext } from './test-helpers.ts';

const HEX_A = 'a'.repeat(64);

function entry(refs: Record<string, { mediaType?: string; bytes?: number }>, mtimeMs = 1_000, size = 10) {
  return { mtimeMs, size, refs };
}

test('C-1 写后读回：条目、mtime、size 与元数据逐项一致', async () => {
  const ctx = makeContext('linux', '/home/alice');
  const merged = new Map([
    ['sessions/proj-1/sess-1/session.jsonl', entry({ ['sha256:' + HEX_A]: { mediaType: 'image/png', bytes: 42 } })],
  ]);
  await saveAttachmentRefCache(ctx, merged);
  const back = await loadAttachmentRefCache(ctx);
  assert.equal(back.size, 1);
  const got = back.get('sessions/proj-1/sess-1/session.jsonl');
  assert.equal(got?.mtimeMs, 1_000);
  assert.equal(got?.size, 10);
  assert.deepEqual(got?.refs['sha256:' + HEX_A], { mediaType: 'image/png', bytes: 42 });
});

test('C-2 缓存文件缺失 ⇒ 空表（等同没有缓存，不是错误）', async () => {
  const ctx = makeContext('linux', '/home/alice');
  assert.equal((await loadAttachmentRefCache(ctx)).size, 0);
});

test('C-3 版本不符 / JSON 坏 / 结构不对 ⇒ 整份丢弃', async () => {
  const ctx = makeContext('linux', '/home/alice');
  const cases = [
    'not json at all',
    JSON.stringify({ version: 2, logs: { 'a.jsonl': entry({}) } }),
    JSON.stringify({ version: 1, logs: [] }),
    JSON.stringify({ version: 1, logs: { 'a.jsonl': { mtimeMs: 'x', size: 1, refs: {} } } }),
    JSON.stringify({ version: 1, logs: { 'a.jsonl': { mtimeMs: 1, size: -1, refs: {} } } }),
  ];
  for (const body of cases) {
    await ctx.fs.writeFile(ATTACHMENT_CACHE_REL, Buffer.from(body, 'utf8'));
    assert.equal((await loadAttachmentRefCache(ctx)).size, 0, '不可信内容不得部分采信：' + body.slice(0, 40));
  }
});

test('C-4 元数据逐项校验：畸形 mediaType / 负数 bytes 不采信，引用本身保留', async () => {
  const ctx = makeContext('linux', '/home/alice');
  const body = JSON.stringify({
    version: 1,
    logs: {
      'sessions/p/s/session.jsonl': {
        mtimeMs: 5,
        size: 7,
        refs: {
          ['sha256:' + HEX_A]: { mediaType: 42, bytes: -3 },
          ['sha256:' + 'b'.repeat(64)]: { mediaType: 'image/jpeg', bytes: 8 },
        },
      },
    },
  });
  await ctx.fs.writeFile(ATTACHMENT_CACHE_REL, Buffer.from(body, 'utf8'));
  const back = await loadAttachmentRefCache(ctx);
  const got = back.get('sessions/p/s/session.jsonl');
  assert.deepEqual(got?.refs['sha256:' + HEX_A], {}, '畸形元数据丢掉，但 id 仍在（否则会少带附件）');
  assert.deepEqual(got?.refs['sha256:' + 'b'.repeat(64)], { mediaType: 'image/jpeg', bytes: 8 });
});

test('C-5 写失败静默：fs.writeFile 抛错不影响调用方', async () => {
  const ctx = makeContext('linux', '/home/alice');
  ctx.fs.writeFile = async () => { throw new Error('EACCES'); };
  await saveAttachmentRefCache(ctx, new Map([['x.jsonl', entry({})]]));
});

test('C-6 合并语义：save 传入的是合并后的表，未扫到的旧条目不会被写丢', async () => {
  const ctx = makeContext('linux', '/home/alice');
  await saveAttachmentRefCache(ctx, new Map([
    ['old.jsonl', entry({}, 1, 1)],
    ['new.jsonl', entry({}, 2, 2)],
  ]));
  const back = await loadAttachmentRefCache(ctx);
  assert.deepEqual([...back.keys()].sort(), ['new.jsonl', 'old.jsonl']);
});
