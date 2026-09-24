/**
 * issue #39 Feature 1：sessions 分区的「最新 N 个」筛选（适配器层，走 HostContext.fs）。
 *
 * 覆盖：单位 = 会话目录（同一会话的多份日志 + 附件一起带走）、0/负数/正数三档、
 * 宿主不提供 mtime 时退回全量 + 告警、时间全读不到时同样退回全量、与 includeItems 白名单取交集。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionsAdapter } from './sessions.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import { projectKeyOf } from '../core/session-meta.ts';
import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import type { SessionMoveResult } from '../core/types.ts';

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

/* ---------------- issue #45 ④：导入期位置护栏（finalizeApply） ---------------- */

/** 造一个「会话文件已写入目标机」的 section（bytes 里带首帧 cwd 的真实压缩帧）。 */
function layoutSection(cwd: string, projectKeyDir: string, id = 'session-a'): { version: number; files: { relativePath: string; data: Uint8Array; contentHash: string }[] } {
  const header = JSON.stringify({ type: 'session', version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0, cwd }) + '\n';
  return {
    version: 1,
    files: [{
      relativePath: projectKeyDir + '/' + id + '/session.v3.jsonl.zstd',
      data: Buffer.from(encodeZstdFrame(Buffer.from(header, 'utf8'))),
      contentHash: 'h',
    }],
  };
}

interface LayoutCalls { cwd: number; moves: [string, string][]; rewrites: [string, string][] }

function ctxWithLayout(
  target: ReturnType<typeof makeContext>,
  opts: { cwd?: string | undefined; move?: () => SessionMoveResult; rewrite?: boolean },
): LayoutCalls {
  const calls: LayoutCalls = { cwd: 0, moves: [], rewrites: [] };
  target.sessions = {
    readLogCwd: () => { calls.cwd += 1; return opts.cwd; },
    relocateDir: async (rel: string, key: string): Promise<SessionMoveResult> => {
      calls.moves.push([rel, key]);
      return opts.move !== undefined ? opts.move() : { moved: true, to: '/root/' + key + '/' + rel.split('/')[1] };
    },
    ...(opts.rewrite === false
      ? {}
      : {
        rewriteLogDir: async (rel: string, next: string) => {
          calls.rewrites.push([rel, next]);
          return { ok: true as const, rewritten: [rel] };
        },
      }),
  };
  return calls;
}

test('issue #45 ④：位置与首帧 cwd 不一致 → 自动归位到推导目录（只移动，不改内容）', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const calls = ctxWithLayout(dst, { cwd: 'C:\\Users\\bob\\proj' });
  const section = layoutSection('C:\\Users\\bob\\proj', '--D-Old-proj--');
  const ctx = makeImportContext(dst, new Map([['sessions', section]]));
  const results = await adapter.finalizeApply(ctx);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]?.message ?? '', /已自动归位/);
  assert.deepEqual(calls.moves, [['--D-Old-proj--/session-a', projectKeyOf('C:\\Users\\bob\\proj')]]);
});

test('issue #45 ④：位置已自洽（含跨机 cwd）→ 零动作；读不出 cwd → 跳过（不猜）', async () => {
  const okDst = makeContext('win32', 'C:\\Users\\bob');
  const okCalls = ctxWithLayout(okDst, { cwd: 'C:\\Users\\bob\\proj' });
  await adapter.finalizeApply(makeImportContext(okDst, new Map([['sessions', layoutSection('C:\\Users\\bob\\proj', projectKeyOf('C:\\Users\\bob\\proj'))]])));
  assert.deepEqual(okCalls.moves, [], '位置对了就不动');

  // 跨机：cwd 在本机不存在，但位置正是从该 cwd 推导出来的 → 自洽，零动作、也不会让 DSH 起不来
  const crossDst = makeContext('win32', 'C:\\Users\\bob');
  const crossCalls = ctxWithLayout(crossDst, { cwd: 'D:\\Ghost\\proj' });
  await adapter.finalizeApply(makeImportContext(crossDst, new Map([['sessions', layoutSection('D:\\Ghost\\proj', projectKeyOf('D:\\Ghost\\proj'))]])));
  assert.deepEqual(crossCalls.moves, [], '跨机会话位置自洽，不应被搬');

  const unknownDst = makeContext('win32', 'C:\\Users\\bob');
  const unknownCalls = ctxWithLayout(unknownDst, { cwd: undefined });
  const results = await adapter.finalizeApply(makeImportContext(unknownDst, new Map([['sessions', layoutSection('C:\\Users\\bob\\proj', '--X--')]])));
  assert.deepEqual(unknownCalls.moves, [], '解不出 cwd 就不动');
  assert.deepEqual(results, [], '也不谎报通过（不产出结果）');
});

test('issue #45 ④：归位失败（目标已存在等）→ 记失败并给出可执行指引', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const calls = ctxWithLayout(dst, { cwd: 'C:\\Users\\bob\\proj', move: () => ({ moved: false, reason: 'conflict' }) });
  const results = await adapter.finalizeApply(makeImportContext(dst, new Map([['sessions', layoutSection('C:\\Users\\bob\\proj', '--D-Old-proj--')]])));
  assert.equal(calls.moves.length, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.warning, undefined, '位置坏掉是硬问题（默认不吞）');
  assert.match(results[0]?.message ?? '', /corrupt session log/);
});

test('issue #45 ④：宿主未提供归位能力 → 直接不做（不猜、不谎报）', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  dst.sessions = undefined;
  const results = await adapter.finalizeApply(makeImportContext(dst, new Map([['sessions', layoutSection('C:\\Users\\bob\\proj', '--D-Old-proj--')]])));
  assert.deepEqual(results, []);
});


test('issue #45 + 映射：命中路径映射 → 先改写首帧、再按映射后的 cwd 归位（同一条映射两处生效）', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const calls = ctxWithLayout(dst, { cwd: 'D:\\Ghost\\proj' });
  const ctx = makeImportContext(dst, new Map([['sessions', layoutSection('D:\\Ghost\\proj', projectKeyOf('D:\\Ghost\\proj'))]]));
  ctx.pathMappings = [{ oldPrefix: 'D:\\Ghost', newPrefix: 'C:\\Users\\bob\\work', appliesTo: [] }];
  const results = await adapter.finalizeApply(ctx);
  // 写进首帧的必须是**目标平台原生形态**：DSH 工作区记录里的 path 是 realpath 落库的原生形
  // （Windows 反斜杠），而映射函数输出统一是正斜杠 —— 不转换就会出现「首帧 cwd 与 workspace.path
  // 只差分隔符」，违反 issue #45 的逐字一致不变量（真机实测能靠 realpath 兜住，但不再依赖它）。
  assert.deepEqual(calls.rewrites, [['--D-Ghost-proj--/session-a', 'C:\\Users\\bob\\work\\proj']], '改写用的是映射后的路径（原生分隔符）');
  assert.deepEqual(calls.moves, [['--D-Ghost-proj--/session-a', projectKeyOf('C:\\Users\\bob\\work\\proj')]], '目录跟着 header 一起归位');
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]?.message ?? '', /首帧 cwd 已按路径映射改写/);
});

test('issue #45 + 映射：改写成功但目录搬不动 → 回滚首帧（绝不留半套），如实记 warning', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const calls = ctxWithLayout(dst, { cwd: 'D:\\Ghost\\proj', move: () => ({ moved: false, reason: 'conflict' }) });
  const ctx = makeImportContext(dst, new Map([['sessions', layoutSection('D:\\Ghost\\proj', projectKeyOf('D:\\Ghost\\proj'))]]));
  ctx.pathMappings = [{ oldPrefix: 'D:\\Ghost', newPrefix: 'C:\\Users\\bob\\work', appliesTo: [] }];
  const results = await adapter.finalizeApply(ctx);
  assert.deepEqual(calls.rewrites, [
    ['--D-Ghost-proj--/session-a', 'C:\\Users\\bob\\work\\proj'],
    ['--D-Ghost-proj--/session-a', 'D:\\Ghost\\proj'],
  ], '第二次改写是回滚到原 cwd');
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.warning, true, '位置已恢复自洽 → 非致命');
  assert.match(results[0]?.message ?? '', /已把首帧改回原值/);
});

/* ---------------- 字节闸门（审计 core-flow F-12 / sync#F-12）：单元 = 会话目录，整块剔除 ---------------- */

/** 探针：把闸门降到 limit 字节（真实阈值 256 MiB 无法在单测里构造） */
class TinySessions extends SessionsAdapter {
  private readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  protected override sectionByteLimit(): number {
    return this.limit;
  }
}

test('字节闸门（sessions）：超限时整个会话目录（日志 + 附件）一起剔除，并写进告警', async () => {
  const ctx = makeContext('win32', HOME);
  await ctx.fs.writeFile('sessions/--p--/a/session.jsonl.zstd', new Uint8Array(200));
  await ctx.fs.writeFile('sessions/--p--/a/attachments/blob.bin', new Uint8Array(200)); // 单元 a 共 400
  await ctx.fs.writeFile('sessions/--p--/b/session.jsonl.zstd', new Uint8Array(300));   // 单元 b 共 300
  ctx.fs.setMtime('sessions/--p--/a/session.jsonl.zstd', 2000);
  ctx.fs.setMtime('sessions/--p--/b/session.jsonl.zstd', 1000);

  const section = await new TinySessions(500).export(ctx, { includeSecrets: false, sessions: { limit: 2 } });

  assert.deepEqual(relPaths(section), ['--p--/a/attachments/blob.bin', '--p--/a/session.jsonl.zstd'],
    '整个会话 b（含只有它的日志）一个文件都不留；会话 a 的日志与附件一起走');
  const gate = section.warnings.filter((w) => w.includes('单分区上限'));
  assert.equal(gate.length, 1, `应有一条闸门告警，实际: ${section.warnings.join(' | ')}`);
  assert.match(gate[0] ?? '', /—— --p--\/b$/, '告警点名被整块剔除的会话目录');
  assert.ok(section.warnings.some((w) => w.includes('只带最新')), '数量筛选告警与闸门告警并存（两条都可见）');
});

test('字节闸门（sessions）：未超限时（默认 256 MiB）行为与改造前一致，不产生闸门告警', async () => {
  const ctx = await fixture();
  const section = await new SessionsAdapter().export(ctx, { includeSecrets: false, sessions: { limit: -1 } });
  assert.equal(section.data.files.length, 7);
  assert.equal(section.warnings.some((w) => w.includes('单分区上限')), false);
});

test('issue #45 + 映射：宿主不支持按路径改写 → 只报告（warning），不动文件与目录', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const calls = ctxWithLayout(dst, { cwd: 'D:\\Ghost\\proj', rewrite: false });
  const ctx = makeImportContext(dst, new Map([['sessions', layoutSection('D:\\Ghost\\proj', projectKeyOf('D:\\Ghost\\proj'))]]));
  ctx.pathMappings = [{ oldPrefix: 'D:\\Ghost', newPrefix: 'C:\\Users\\bob\\work', appliesTo: [] }];
  const results = await adapter.finalizeApply(ctx);
  assert.deepEqual(calls.moves, [], '不搬目录');
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.warning, true);
  assert.match(results[0]?.message ?? '', /首帧 cwd 改写失败/);
});
/* ---------------- 子代理会话：导出连带父对话 / 导入如实告警（真机「导入成功却看不见」） ---------------- */

/** 造一份带 origin / parentSessionId 的真实压缩会话日志（首帧 = header 行）。 */
function sessionLogBytes(header: Record<string, unknown>): Uint8Array {
  return Buffer.from(encodeZstdFrame(Buffer.from(JSON.stringify({ type: 'session', version: 3, createdAt: 1, isSeeded: false, delegationDepth: 0, ...header }) + '\n', 'utf8')));
}

function sessionFile(projectKeyDir: string, dir: string, header: Record<string, unknown>) {
  return { relativePath: projectKeyDir + '/' + dir + '/session.jsonl.zstd', data: sessionLogBytes(header), contentHash: 'h' };
}

test('子代理会话：只勾子会话 → 导出自动连带父对话（DSH 工作区只显示在父对话之下）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/child-a/session.jsonl.zstd', sessionLogBytes({ id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' }));
  await ctx.fs.writeFile('sessions/--p--/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));
  await ctx.fs.writeFile('sessions/--p--/other/session.jsonl.zstd', sessionLogBytes({ id: 'other', cwd }));

  const section = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/child-a'] } });

  assert.deepEqual(relPaths(section), [
    '--p--/child-a/session.jsonl.zstd',
    '--p--/session-parent/session.jsonl.zstd',
  ], '父对话必须一起走（否则导入后在工作区里看不到这条会话）');
  assert.ok(section.warnings.some((w) => w.includes('已连带导出 1 个父对话')), section.warnings.join(' | '));
  assert.equal(section.counts['files'], 2, '计数跟着更新');
});

test('子代理会话：父对话在本机找不到 → 如实告警（绝不静默）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/child-a/session.jsonl.zstd', sessionLogBytes({ id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-gone' }));

  const section = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/child-a'] } });

  assert.deepEqual(relPaths(section), ['--p--/child-a/session.jsonl.zstd']);
  assert.ok(
    section.warnings.some((w) => w.includes('未能连带其父对话') && w.includes('session-gone')),
    section.warnings.join(' | '),
  );
});

test('子代理会话：顶层会话不触发连带；父对话已在包内 → 不重复带、不告警', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/plain/session.jsonl.zstd', sessionLogBytes({ id: 'plain', cwd }));
  await ctx.fs.writeFile('sessions/--p--/child-a/session.jsonl.zstd', sessionLogBytes({ id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' }));
  await ctx.fs.writeFile('sessions/--p--/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));

  const plain = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/plain'] } });
  assert.deepEqual(relPaths(plain), ['--p--/plain/session.jsonl.zstd'], '顶层会话不带别人');
  assert.deepEqual(plain.warnings, []);

  const both = await adapter.export(ctx, {
    includeSecrets: false,
    includeItems: { sessions: ['sessions:--p--/child-a', 'sessions:--p--/session-parent'] },
  });
  assert.deepEqual(relPaths(both), ['--p--/child-a/session.jsonl.zstd', '--p--/session-parent/session.jsonl.zstd']);
  assert.deepEqual(both.warnings, [], '父对话已在包内 → 不产生连带告警');
});

test('子代理会话：导入时父对话缺席 → 如实告警（把「导入成功却看不见」变成可读的告警）', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const cwd = 'D:\\Ghost\\proj';
  const key = projectKeyOf(cwd);
  ctxWithLayout(dst, { cwd });
  const ctx = makeImportContext(dst, new Map([['sessions', {
    version: 1,
    files: [sessionFile(key, 'child-a', { id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' })],
  }]]));

  const results = await adapter.finalizeApply(ctx);
  const orphan = results.find((r) => (r.message ?? '').includes('父对话不在包内'));
  assert.ok(orphan !== undefined, results.map((r) => r.message).join(' | '));
  assert.equal(orphan?.warning, true, '数据仍在导入 → 非致命（warning 而非硬失败）');
  assert.match(orphan?.message ?? '', /1 个子代理会话/);
});

test('子代理会话：父对话不在包内但本机已有 → 不告警（把旧包导回同机是正常情况）', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const cwd = 'D:\\Ghost\\proj';
  const key = projectKeyOf(cwd);
  ctxWithLayout(dst, { cwd });
  await dst.fs.writeFile('sessions/' + key + '/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));
  const ctx = makeImportContext(dst, new Map([['sessions', {
    version: 1,
    files: [sessionFile(key, 'child-a', { id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' })],
  }]]));

  const results = await adapter.finalizeApply(ctx);
  assert.equal(
    results.some((r) => (r.message ?? '').includes('父对话不在包内')),
    false,
    '本机已有父对话 → 子会话会正常挂在它之下，不该告警: ' + results.map((r) => r.message).join(' | '),
  );
});

test('子代理会话：父对话在包内 → 导入侧不告警', async () => {
  const dst = makeContext('win32', 'C:\\Users\\bob');
  const cwd = 'D:\\Ghost\\proj';
  const key = projectKeyOf(cwd);
  ctxWithLayout(dst, { cwd });
  const ctx = makeImportContext(dst, new Map([['sessions', {
    version: 1,
    files: [
      sessionFile(key, 'child-a', { id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' }),
      sessionFile(key, 'session-parent', { id: 'session-parent', cwd }),
    ],
  }]]));

  const results = await adapter.finalizeApply(ctx);
  assert.equal(
    results.some((r) => (r.message ?? '').includes('父对话不在包内')),
    false,
    results.map((r) => r.message).join(' | '),
  );
});

test('子代理会话：只勾父对话 → 引擎只带父对话（「勾父带子」由界面联动完成：白名单即用户意图）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));
  await ctx.fs.writeFile('sessions/--p--/child-a/session.jsonl.zstd', sessionLogBytes({ id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' }));
  await ctx.fs.writeFile('sessions/--p--/child-b/session.jsonl.zstd', sessionLogBytes({ id: 'child-b', cwd, origin: 'subagent', parentSession: 'session-parent' }));
  ctx.sessions = { parentRelations: async () => new Map([['child-a', { parent: 'session-parent', subagent: true }], ['child-b', { parent: 'session-parent', subagent: true }]]) };

  const section = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/session-parent'] } });

  assert.deepEqual(relPaths(section), ['--p--/session-parent/session.jsonl.zstd'],
    '引擎不再向下展开：用户没勾的子代理会话不得被打包（界面勾父时会用 applySessionParentCoupling 先把子会话勾上）');
  assert.deepEqual(section.warnings, []);
});

test('子代理会话：被选中的会话既是别人的子会话、又有自己的子代理 → 向上追父链（向下交给界面联动）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/session-top/session.jsonl.zstd', sessionLogBytes({ id: 'session-top', cwd }));
  await ctx.fs.writeFile('sessions/--p--/session-mid/session.jsonl.zstd', sessionLogBytes({ id: 'session-mid', cwd, origin: 'subagent', parentSession: 'session-top' }));
  await ctx.fs.writeFile('sessions/--p--/child-deep/session.jsonl.zstd', sessionLogBytes({ id: 'child-deep', cwd, origin: 'subagent', parentSession: 'session-mid' }));
  ctx.sessions = { parentRelations: async () => new Map([
    ['session-mid', { parent: 'session-top', subagent: true }],
    ['child-deep', { parent: 'session-mid', subagent: true }],
  ]) };

  // 只勾 session-mid（它自己也是子代理会话）→ 必须连带 session-top；child-deep 由界面联动负责（引擎不猜）
  const section = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/session-mid'] } });

  assert.deepEqual(relPaths(section), [
    '--p--/session-mid/session.jsonl.zstd',
    '--p--/session-top/session.jsonl.zstd',
  ]);
  assert.ok(section.warnings.some((w) => w.includes('已连带导出 1 个父对话')), section.warnings.join(' | '));
  assert.equal(section.warnings.some((w) => w.includes('个子代理会话')), false, '引擎不再向下连带');
});

test('子代理会话：宿主不提供父子关系 → 只带勾选的会话（不崩、不谎报）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));
  await ctx.fs.writeFile('sessions/--p--/child-a/session.jsonl.zstd', sessionLogBytes({ id: 'child-a', cwd, origin: 'subagent', parentSession: 'session-parent' }));

  const section = await adapter.export(ctx, { includeSecrets: false, includeItems: { sessions: ['sessions:--p--/session-parent'] } });

  assert.deepEqual(relPaths(section), ['--p--/session-parent/session.jsonl.zstd']);
  assert.deepEqual(section.warnings, []);
});

test('子代理会话：只勾子会话 → 连带父对话，但**不**把用户没勾的兄弟会话一起打包（真机事故：勾 4 条 → 包里 41 个会话目录）', async () => {
  const ctx = makeContext('win32', HOME);
  const cwd = 'D:\\Ghost\\proj';
  await ctx.fs.writeFile('sessions/--p--/session-parent/session.jsonl.zstd', sessionLogBytes({ id: 'session-parent', cwd }));
  await ctx.fs.writeFile('sessions/--p--/sibling/session.jsonl.zstd', sessionLogBytes({ id: 'sibling', cwd, origin: 'subagent', parentSession: 'session-parent' }));
  for (const id of ['child-a', 'child-b']) {
    await ctx.fs.writeFile('sessions/--p--/' + id + '/session.jsonl.zstd', sessionLogBytes({ id, cwd, origin: 'subagent', parentSession: 'session-parent' }));
  }
  ctx.sessions = {
    parentRelations: async () => new Map([
      ['child-a', { parent: 'session-parent', subagent: true }],
      ['child-b', { parent: 'session-parent', subagent: true }],
      ['sibling', { parent: 'session-parent', subagent: true }],
    ]),
  };

  const section = await adapter.export(ctx, {
    includeSecrets: false,
    includeItems: { sessions: ['sessions:--p--/child-a', 'sessions:--p--/child-b'] },
  });

  assert.deepEqual(relPaths(section), [
    '--p--/child-a/session.jsonl.zstd',
    '--p--/child-b/session.jsonl.zstd',
    '--p--/session-parent/session.jsonl.zstd',
  ], '只补父对话；父对话的其它子代理会话（sibling）绝不能被顺带带走');
  assert.ok(section.warnings.some((w) => w.includes('已连带导出 1 个父对话')), section.warnings.join(' | '));
  assert.equal(section.warnings.some((w) => w.includes('个子代理会话')), false, '这不是向下连带，不该报「连带子代理会话」');
});

/* ---------------- 历史对话排序：单元级活跃时间（会话日志 mtime） ---------------- */

test('历史对话排序：unitActivityTimes 取每个会话**最新一份**日志的 mtime（两种目录名形态归一成一个会话）', async () => {
  const ctx = makeContext('win32', HOME);
  await ctx.fs.writeFile('sessions/--p--/a/session.jsonl.zstd', bytes('x'));
  await ctx.fs.writeFile('sessions/--p--/a/session.v3.jsonl.zstd', bytes('x'));
  await ctx.fs.writeFile('sessions/--p--/a/attachments/blob.bin', bytes('x'));
  await ctx.fs.writeFile('sessions/--p--/session-b/session.jsonl.zstd', bytes('x'));
  ctx.fs.setMtime('sessions/--p--/a/session.jsonl.zstd', 1000);
  ctx.fs.setMtime('sessions/--p--/a/session.v3.jsonl.zstd', 3000);
  ctx.fs.setMtime('sessions/--p--/a/attachments/blob.bin', 9999);
  ctx.fs.setMtime('sessions/--p--/session-b/session.jsonl.zstd', 2000);

  const section = await adapter.export(ctx, { includeSecrets: false });
  const at = await adapter.unitActivityTimes(ctx, section);

  assert.deepEqual([...at.entries()].sort(), [['a', 3000], ['b', 2000]],
    '多份 generation 取最新；附件不算会话日志；session- 前缀归一成裸键');
});

test('历史对话排序：宿主不提供 mtimeMs 门面 → 空 Map（调用方退回元数据缓存时间，不猜 0）', async () => {
  const ctx = makeContext('win32', HOME);
  await ctx.fs.writeFile('sessions/--p--/a/session.jsonl.zstd', bytes('x'));
  (ctx.fs as { mtimeMs?: unknown }).mtimeMs = undefined;
  const section = await adapter.export(ctx, { includeSecrets: false });
  const at = await adapter.unitActivityTimes(ctx, section);
  assert.equal(at.size, 0);
});
