/**
 * 文件类分区导出的**字节闸门**（审计 core-flow F-12 / sync#F-12）测试。
 *
 * 覆盖：
 *  ① 超限 → 单元**整块**剔除，且被剔除的单元写进 warnings（报告可见，绝不静默）；
 *  ② 未超限 → 与「改造前」的收集逻辑**逐项一致**（自包含对照：legacy 循环逐字内联，不依赖 git 回退）；
 *  ③ 单元不可拆分：只放得下一半时一个文件都不留（宁可少带，不可半带）；
 *  ④ 单元成员在遍历结果里**不连续**也不会被劈开（分组在闸门之前完成）；
 *  ⑤ 放不下的单元跳过后**继续尝试后面的单元**（后面的小单元仍可能入选）；
 *  ⑥ 告警列表有上限（大分区不刷屏），被折叠的数量的确进了文案。
 *  ⑦ validate 的样板收敛：object 守卫并入共享骨架 validateJsonSection（走可选 objectMessageKey）后，
 *     5 个文件类分区的用户可见报错文案与改造前逐字相同（zh / en / 缺省三条路径）。
 *
 * 阈值：测试用探针把闸门降到几十~几百字节 —— 真实阈值 MAX_FILE_SECTION_BYTES = 256 MiB
 * 无法在单测里构造而不吃掉 256 MiB 内存（这正是闸门要防的东西）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { FileCollectionAdapter, MAX_FILE_SECTION_BYTES } from './file-collection.ts';
import { SkillsAdapter } from './skills.ts';
import { listFilesDetailed } from './link-report.ts';
import { makeContext, sha256Hex } from './test-helpers.ts';
import { AgentPresetsAdapter } from './agent-presets.ts';
import { AgentInstructionsAdapter } from './agent-instructions.ts';
import { SessionsAdapter } from './sessions.ts';
import { SelfAdapter } from './self.ts';
import { makeMsg, zhMsg } from '../core/messages.ts';
import { validateJsonSection } from './json-section.ts';
import type { FileEntry } from '../schema/types.ts';
import type { MockHostContext } from './test-helpers.ts';

/** 探针：与 skills 同构，但把闸门降到 `limit` 字节（生产代码不覆写 sectionByteLimit） */
class ProbeAdapter extends FileCollectionAdapter {
  readonly id = 'skills' as const;
  readonly displayName = 'Skills';
  readonly defaultIncluded = true;
  readonly portability = 'portable' as const;
  readonly baseDir = 'skills';
  private readonly limit: number;
  constructor(limit: number) {
    super();
    this.limit = limit;
  }
  protected override sectionByteLimit(): number {
    return this.limit;
  }
}

/** 写入 n 字节的零内容文件（内容无所谓，闸门只看 byteLength） */
async function writeSized(ctx: MockHostContext, rel: string, n: number): Promise<void> {
  await ctx.fs.writeFile(rel, new Uint8Array(n));
}

function paths(section: { data: { files: { relativePath: string }[] } }): string[] {
  return section.data.files.map((f) => f.relativePath);
}

/* ---------------- ② 未超限：与改造前逐项一致（自包含对照） ---------------- */

/**
 * 「改造前」的收集循环（逐字复刻 Gate 落地前的实现）：
 * listFilesDetailed → relPathOf → unitIdOf 白名单 → readFile → push。
 * 用它当参照，验证闸门在**未触发**时不改变任何一项（顺序 / 路径 / 字节 / hash）。
 */
async function legacyCollect(ctx: MockHostContext, baseDir: string, allow: readonly string[] | undefined): Promise<FileEntry[]> {
  const listing = await listFilesDetailed(ctx.fs, baseDir);
  const out: FileEntry[] = [];
  for (const rel of listing.paths) {
    const relPath = rel.replace(new RegExp('^' + baseDir + '[\\\\/]'), '');
    const unit = relPath.includes('/') ? relPath.slice(0, relPath.indexOf('/')) : relPath;
    if (allow !== undefined && !allow.includes('skills:' + unit)) continue;
    const data = await ctx.fs.readFile(rel);
    out.push({ relativePath: relPath, data, contentHash: sha256Hex(data) });
  }
  return out;
}

test('字节闸门：未超限时与改造前的收集逻辑逐项一致（顺序/路径/字节/hash + 零告警）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await writeSized(ctx, 'skills/alpha/a.md', 100);
  await writeSized(ctx, 'skills/alpha/b.md', 50);
  await writeSized(ctx, 'skills/beta/c.md', 70);
  await writeSized(ctx, 'skills/loose.md', 10);

  // 闸门远大于总字节（190）→ 一次都不该触发
  const section = await new ProbeAdapter(10_000).export(ctx, { includeSecrets: false });
  const legacy = await legacyCollect(ctx, 'skills', undefined);

  assert.deepEqual(section.warnings, [], '未超限不得产出任何告警');
  assert.deepEqual(
    section.data.files.map((f) => ({ relativePath: f.relativePath, bytes: f.data.byteLength, contentHash: f.contentHash })),
    legacy.map((f) => ({ relativePath: f.relativePath, bytes: f.data.byteLength, contentHash: f.contentHash })),
    '逐项一致：顺序 + 相对路径 + 字节数 + SHA-256',
  );
  assert.deepEqual(paths(section), ['alpha/a.md', 'alpha/b.md', 'beta/c.md', 'loose.md']);
  assert.equal(section.counts.files, 4);

  // 白名单路径同样逐项一致（闸门不改变 includeItems 语义）
  const allow = ['skills:alpha'];
  const filtered = await new ProbeAdapter(10_000).export(ctx, { includeSecrets: false, includeItems: { skills: allow } });
  const filteredLegacy = await legacyCollect(ctx, 'skills', allow);
  assert.deepEqual(paths(filtered), filteredLegacy.map((f) => f.relativePath));
  assert.deepEqual(filtered.warnings, []);
});

/* ---------------- ① 超限：整块剔除 + 告警可见 ---------------- */

test('字节闸门：超限时按单元整块剔除，并把该单元写进告警（绝不静默）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await writeSized(ctx, 'skills/alpha/a.md', 120);
  await writeSized(ctx, 'skills/alpha/b.md', 80);   // alpha = 200
  await writeSized(ctx, 'skills/beta/c.md', 200);   // beta = 200，room 只剩 100 → 放不下

  const section = await new ProbeAdapter(300).export(ctx, { includeSecrets: false });

  assert.deepEqual(paths(section), ['alpha/a.md', 'alpha/b.md'], 'beta 整块不进备份');
  assert.equal(section.counts.files, 2, 'counts 反映实际带走的文件数');
  const gate = section.warnings.filter((w) => w.includes('单分区上限'));
  assert.equal(gate.length, 1, `应恰有一条闸门告警，实际: ${section.warnings.join(' | ')}`);
  const line = gate[0] ?? '';
  assert.match(line, /1 个单元/, '告警给出被剔除的单元数');
  assert.match(line, /300 B/, '告警给出上限值');
  assert.match(line, /200\.0 B|200 B/, '告警给出实际保留量');
  assert.match(line, /—— beta$/, '告警列出被剔除的单元 id（无折叠后缀）');

  // 内容确实不在产物里（不是「报了警但其实还在」）
  assert.equal(section.data.files.some((f) => f.relativePath.startsWith('beta/')), false);
});

test('字节闸门：单元不可拆分 —— 只放得下一半时，该单元一个文件都不留', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await writeSized(ctx, 'skills/skill-a/one.md', 60);
  await writeSized(ctx, 'skills/skill-a/two.md', 60);   // 单元合计 120 > 上限 100

  const section = await new ProbeAdapter(100).export(ctx, { includeSecrets: false });

  assert.deepEqual(section.data.files, [], '整块剔除：不能只留 60 字节的那一半');
  assert.equal(section.counts.files, 0);
  assert.match(section.warnings.find((w) => w.includes('单分区上限')) ?? '', /—— skill-a$/);
});

/* ---------------- ④ 成员不连续也不会被劈开 ---------------- */

test('字节闸门：单元的成员在遍历结果里不连续时同样整块判定（不会被劈成两半）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await ctx.fs.writeFile('skills/a/1.md', new Uint8Array(60));
  await ctx.fs.writeFile('skills/b/1.md', new Uint8Array(60));
  await ctx.fs.writeFile('skills/a/2.md', new Uint8Array(60));
  // 故意让遍历结果按 a、b、a 交错返回（真实 walk 不保证顺序，mock 直接钉住这条边界）
  ctx.fs.listRecursiveDetailed = async () => ({
    paths: ['skills/a/1.md', 'skills/b/1.md', 'skills/a/2.md'],
    skippedLinks: [],
    followedLinks: 0,
    unreadableDirs: [],
  });

  const section = await new ProbeAdapter(150).export(ctx, { includeSecrets: false });

  // a = 120（两段合计）→ 入选；b = 60（room 只剩 30）→ 整块剔除
  assert.deepEqual(paths(section), ['a/1.md', 'a/2.md'], 'a 的两段一起入选（未按段拆开），b 整体剔除');
  assert.match(section.warnings.find((w) => w.includes('单分区上限')) ?? '', /—— b$/);
});

/* ---------------- ⑤ 跳过后继续尝试后面的单元 ---------------- */

test('字节闸门：一个巨型单元被剔除后，后面的小单元仍可能入选（尽量多带）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  // 遍历顺序是字典序：big < huge < small —— 前 200 入选，huge（200）放不下被整块剔除，
  // 后面 room 仍是 100 的 small 不受牵连（硬停会把 small 一起丢掉）。
  await writeSized(ctx, 'skills/big/a.md', 200);
  await writeSized(ctx, 'skills/huge/a.md', 200);
  await writeSized(ctx, 'skills/small/a.md', 50);

  const section = await new ProbeAdapter(300).export(ctx, { includeSecrets: false });

  assert.deepEqual(paths(section), ['big/a.md', 'small/a.md'], '一个巨型单元不该把它之后的内容一起带走');
  assert.match(section.warnings.find((w) => w.includes('单分区上限')) ?? '', /—— huge$/);
});

/* ---------------- ⑥ 告警列表有上限，折叠数量不丢 ---------------- */

test('字节闸门：被剔除单元很多时告警只列前 5 个，剩余折叠为 (+ N)（不刷屏也不静默）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await writeSized(ctx, 'skills/first/a.md', 100);
  for (let i = 0; i < 7; i += 1) await writeSized(ctx, `skills/u${i}/a.md`, 100);  // 每个 100，room 只剩 0 → 全部剔除

  const section = await new ProbeAdapter(100).export(ctx, { includeSecrets: false });

  const line = section.warnings.find((w) => w.includes('单分区上限')) ?? '';
  assert.deepEqual(paths(section), ['first/a.md']);
  assert.match(line, /7 个单元/);
  assert.match(line, /\(\+ 2\)/, '折叠数量必须出现在文案里（否则截断本身又成了静默丢失）');
  for (const name of ['u0', 'u1', 'u2', 'u3', 'u4']) assert.match(line, new RegExp('\\b' + name + '\\b'));
  assert.equal(line.includes('u5'), false, '第 6 个起折叠');
});

/* ---------------- 默认阈值 ---------------- */

test('字节闸门：默认阈值 = 256 MiB（与导入侧上传硬上限对齐），且普通内容不触发', async () => {
  assert.equal(MAX_FILE_SECTION_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_FILE_SECTION_BYTES, 268435456);

  const ctx = makeContext('win32', 'C:\\Users\\alice');
  await writeSized(ctx, 'skills/big/a.md', 2 * 1024 * 1024);   // 2 MiB：远低于阈值
  const section = await new SkillsAdapter().export(ctx, { includeSecrets: false });
  assert.deepEqual(paths(section), ['big/a.md'], '真实适配器在默认阈值下不做任何剔除');
  assert.deepEqual(section.warnings, []);
});

/* ---------------- ⑦ validate：object 守卫并入共享骨架后文案逐字不变 ---------------- */

test('validateJsonSection：objectMessageKey 可选，缺省即 adapter.validate.object，且不改变其余语义', () => {
  // ① 不传第 6 参 = 既有 9 个调用点的行为（缺省键 + subject 插值）
  assert.deepEqual(validateJsonSection<{ version?: unknown }>('skills', null, zhMsg), {
    valid: false,
    issues: [{ path: '$', message: 'skills 数据必须是对象', severity: 'error' }],
  });
  // ② 自定义键：文案取自该键；文件类分区的专用键不含 {subject}，故第 5 参取值不影响输出
  assert.deepEqual(validateJsonSection<{ version?: unknown }>('skills', null, zhMsg, undefined, 'skills', 'adapter.validate.fileSection'), {
    valid: false,
    issues: [{ path: '$', message: '文件分区数据必须是对象', severity: 'error' }],
  });
  assert.deepEqual(validateJsonSection<{ version?: unknown }>('skills', null, zhMsg, undefined, '别名', 'adapter.validate.fileSection'), {
    valid: false,
    issues: [{ path: '$', message: '文件分区数据必须是对象', severity: 'error' }],
  });
  // ③ en 目录同样走自定义键
  assert.deepEqual(validateJsonSection<{ version?: unknown }>('skills', null, makeMsg('en'), undefined, 'skills', 'adapter.validate.fileSection'), {
    valid: false,
    issues: [{ path: '$', message: 'File-section data must be an object', severity: 'error' }],
  });
  // ④ object 守卫之外的语义与新增参数无关（version 不匹配仍继续做形状检查）
  assert.deepEqual(validateJsonSection<{ version?: unknown }>('skills', { version: 2 }, zhMsg), {
    valid: false,
    issues: [{ path: 'version', message: 'version 必须为 1（收到 2）', severity: 'error' }],
  });
});

test('validate：5 个文件类分区的 object 守卫并入骨架后，用户可见文案与改造前逐字相同', async () => {
  const fileAdapters = [
    new SkillsAdapter(), new AgentPresetsAdapter(), new AgentInstructionsAdapter(),
    new SessionsAdapter(), new SelfAdapter(),
  ];
  const zhExpected = { valid: false, issues: [{ path: '$', message: '文件分区数据必须是对象', severity: 'error' }] };
  const enExpected = { valid: false, issues: [{ path: '$', message: 'File-section data must be an object', severity: 'error' }] };
  for (const adapter of fileAdapters) {
    assert.deepEqual(await adapter.validate(null as never), zhExpected, adapter.id + '：缺省（zh）文案');
    assert.deepEqual(await adapter.validate('x' as never, makeMsg('en')), enExpected, adapter.id + '：en 文案');
    assert.deepEqual(await adapter.validate(42 as never, makeMsg('zh')), zhExpected, adapter.id + '：任何非对象都是同一条');
    // 专用键不含 {subject}：并入骨架后若误用缺省键，文案会变成「<分区 id> 数据必须是对象」
    const message = (await adapter.validate(null as never)).issues[0]?.message ?? '';
    assert.equal(message.includes(adapter.id), false, adapter.id + '：文案不得退化成 <subject> 数据必须是对象');
  }
});

