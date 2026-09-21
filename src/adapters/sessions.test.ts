/**
 * issue #39 Feature 1：sessions 分区的「最新 N 个」筛选（适配器层，走 HostContext.fs）。
 *
 * 覆盖：单位 = 会话目录（同一会话的多份日志 + 附件一起带走）、0/负数/正数三档、
 * 宿主不提供 mtime 时退回全量 + 告警、时间全读不到时同样退回全量、与 includeItems 白名单取交集。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionsAdapter } from './sessions.ts';
import { makeContext } from './test-helpers.ts';

const HOME = 'C:\\Users\\alice';
const adapter = new SessionsAdapter();

function bytes(s: string): Uint8Array {
  return Buffer.from(s, 'utf8');
}

/** 三个会话 + 一个只有 session.lock 的目录 + 一个散落文件 */
async function fixture() {
  const ctx = makeContext('win32', HOME);
  const write = async (rel: string, mtimeMs: number | null): Promise<void> => {
    await ctx.fs.writeFile(`sessions/${rel}`, bytes('x'));
    ctx.fs.setMtime(`sessions/${rel}`, mtimeMs);
  };
  await write('--p--/old/session.jsonl.zstd', 1000);
  await write('--p--/mid/session.jsonl.zstd', 2000);
  await write('--p--/new/session.jsonl.zstd', 4000);
  await write('--p--/new/session.v3.jsonl.zstd', 3000);
  await write('--p--/new/attachments/blob.bin', 3500);
  await write('--p--/lockonly/session.lock', 5000);
  await write('--p--/loose.jsonl', 6000);
  return ctx;
}

function relPaths(section: { data: { files: { relativePath: string }[] } }): string[] {
  return section.data.files.map((f) => f.relativePath).sort();
}

test('issue #39：limit=1 → 只带最新会话的整个目录（多份日志 + 附件一起走）', async () => {
  const ctx = await fixture();
  const section = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: 1 } });
  assert.deepEqual(relPaths(section), [
    '--p--/new/attachments/blob.bin',
    '--p--/new/session.jsonl.zstd',
    '--p--/new/session.v3.jsonl.zstd',
  ]);
  assert.ok(
    section.warnings.some((w) => w.includes('只带最新 1 个')),
    `应说明筛选结果，实际: ${section.warnings.join(' | ')}`,
  );
});

test('issue #39：limit=0 → 一个都不带；limit<0 → 全带（含 session.lock 与散落文件）', async () => {
  const ctx = await fixture();
  const none = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: 0 } });
  assert.deepEqual(relPaths(none), []);
  assert.ok(none.warnings.some((w) => w.includes('一个都不带')), none.warnings.join(' | '));

  const all = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: -1 } });
  assert.deepEqual(relPaths(all), [
    '--p--/lockonly/session.lock',
    '--p--/loose.jsonl',
    '--p--/mid/session.jsonl.zstd',
    '--p--/new/attachments/blob.bin',
    '--p--/new/session.jsonl.zstd',
    '--p--/new/session.v3.jsonl.zstd',
    '--p--/old/session.jsonl.zstd',
  ]);
  assert.deepEqual(all.warnings, [], '负数 = 不施加筛选，不产生会话相关告警');
});

test('issue #39：宿主门面不提供 mtimeMs → 退回全量 + 告警（绝不把未知当最旧）', async () => {
  const ctx = await fixture();
  (ctx.fs as { mtimeMs?: unknown }).mtimeMs = undefined;
  const section = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: 1 } });
  assert.equal(section.data.files.length, 7, '时间未知时宁可多带，不可静默少带');
  assert.ok(
    section.warnings.some((w) => w.includes('无法读取会话日志的修改时间')),
    section.warnings.join(' | '),
  );
});

test('issue #39：所有会话时间都读不到 → 同样退回全量 + 告警', async () => {
  const ctx = makeContext('win32', HOME);
  await ctx.fs.writeFile('sessions/--p--/a/session.jsonl.zstd', bytes('x'));
  await ctx.fs.writeFile('sessions/--p--/b/session.jsonl.zstd', bytes('y'));
  const section = await adapter.export(ctx, { includeSecrets: false, sessions: { limit: 1 } });
  assert.equal(section.data.files.length, 2);
  assert.ok(section.warnings.some((w) => w.includes('无法读取会话日志的修改时间')));
});

test('issue #39：与 includeItems 白名单取交集（两个筛选都要满足）', async () => {
  const ctx = await fixture();
  const keepNew = await adapter.export(ctx, {
    includeSecrets: false,
    sessions: { limit: 1 },
    includeItems: { sessions: ['sessions:--p--/new'] },
  });
  assert.equal(keepNew.data.files.length, 3);
  const keepOld = await adapter.export(ctx, {
    includeSecrets: false,
    sessions: { limit: 1 },
    includeItems: { sessions: ['sessions:--p--/old'] },
  });
  assert.deepEqual(relPaths(keepOld), [], '最新 1 个之外的白名单单元不得被带进来');
});
