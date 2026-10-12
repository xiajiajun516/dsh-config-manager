/**
 * DSH 会话元数据（导出选择器的「工作区标题 + 会话标题」数据源）。
 *
 * 重点覆盖：projectKey 算法与真实目录名一致（决定工作区分组归不归得对）、storages 缓存
 * 读取的宽容性（缺文件 / 坏 JSON / 陌生形状一律退化成空索引，绝不抛错）、以及单元富化
 * 的边界（无标题 / 无工作区 / 非 sessions 单元原样透传）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext, MemFs } from '../adapters/test-helpers.ts';
import type { ExportUnit } from './types.ts';
import { applySessionMeta, applySessionMetaToPlanItems, applySessionParentLinks, applySessionTitles, clearSessionMetaCache, projectKeyOf, readSessionMeta, readSessionMetaWithTitles, sessionBareKeyOf, subagentParentMap } from './session-meta.ts';

const HOME = 'C:\\Users\\alice';
const UUID_A = '19495390-402b-463d-a4cc-882287c1f04e';
const UUID_B = '1ae717f9-0b3a-47d2-bf5c-3e347b893273';
const PROJECT = '--D-Projects-personal-dsh-config-manager--';
const OTHER_PROJECT = '--D-Projects-personal-DeepSeekHarness--';

test('projectKeyOf 与 DSH 实际目录名一致（分隔符折叠 / 转义 / 边界）', () => {
  // 前三条是在真机上核对过的对照（~/.dsh/sessions 下的真实目录名）
  assert.equal(projectKeyOf('D:\\Projects\\personal\\dsh-config-manager'), PROJECT);
  assert.equal(projectKeyOf('D:\\Projects\\personal\\DeepSeekHarness'), OTHER_PROJECT);
  assert.equal(projectKeyOf('D:\\Tools'), '--D-Tools--');
  assert.equal(projectKeyOf('/home/alice/projects'), '--home-alice-projects--');
  assert.equal(projectKeyOf('a//b:\\\\c'), '--a-b-c--', '连续分隔符折叠成一个 -');
  assert.equal(projectKeyOf('C:\\用户'), '--C-~7528~6237--', '非 [A-Za-z0-9._-] 字符转 ~XXXX 大写十六进制');
  assert.equal(projectKeyOf('a~b'), '--a~007Eb--', '~ 自身也要转义（否则与转义序列冲突）');
  assert.equal(projectKeyOf(''), '--root--');
  // 尾部分隔符同样折叠成 '-'（不清理尾部 —— 与 DSH 原实现逐字一致，不要为了好看而偏离）
  assert.equal(projectKeyOf('D:\\'), '--D---');
  const long = projectKeyOf('D:\\' + 'x'.repeat(400));
  assert.equal(long.length, 255, '2 + 251 + 2，防文件系统组件长度超限');
  assert.ok(long.startsWith('--D-') && long.endsWith('--'));
});

/** 写入一份与真机同形状的 storages 缓存（键同时覆盖带前缀与裸 id 两种形态） */
async function seedStorages(home: string): Promise<ReturnType<typeof makeContext>> {
  const ctx = makeContext('win32', home);
  const projcache = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        [`session-${UUID_A}`]: {
          identity: { createdAt: 1789245896989, cwd: 'D:\\Projects\\personal\\dsh-config-manager' },
          rows: {
            title: { ver: 1, seq: 42608, val: '推送更新到 GitHub 并发布新版本' },
            sessionListMetadata: { ver: 1, seq: 42608, val: { blank: false, lastPromptAt: 1789245897999 } },
          },
        },
        [UUID_B]: {
          identity: { createdAt: 1787520788261, cwd: 'D:\\Projects\\personal\\DeepSeekHarness' },
          rows: { sessionListMetadata: { ver: 1, val: { blank: true } } },
        },
      },
    },
  };
  const workspaces = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true },
    tables: {
      workspaces: {
        ws1: {
          path: 'D:\\Projects\\personal\\dsh-config-manager',
          title: 'dsh-config-manager',
          sessionIds: [`session-${UUID_A}`],
        },
        ws2: { path: 'D:\\Projects\\personal\\DeepSeekHarness', title: 'DeepSeekHarness', sessionIds: [UUID_B] },
      },
    },
  };
  await ctx.fs.writeFile('storages/session_projcache.json', Buffer.from(JSON.stringify(projcache), 'utf8'));
  await ctx.fs.writeFile('storages/workspace.json', Buffer.from(JSON.stringify(workspaces), 'utf8'));
  return ctx;
}

test('readSessionMeta：读标题 / cwd / 活跃时间，并把工作区路径映射成项目键', async () => {
  const ctx = await seedStorages(HOME);
  const meta = await readSessionMeta(ctx);
  assert.equal(meta.bySessionId.size, 2);
  const a = meta.bySessionId.get(UUID_A)!;
  assert.equal(a.title, '推送更新到 GitHub 并发布新版本', '两种键形态（带/不带 session- 前缀）都要能命中');
  assert.equal(a.cwd, 'D:\\Projects\\personal\\dsh-config-manager');
  assert.equal(a.lastActivityAt, 1789245897999);
  assert.equal(meta.bySessionId.get(UUID_B)!.title, undefined, '缓存里没有标题就不编造');
  assert.equal(meta.bySessionId.get(UUID_B)!.blank, true);
  assert.equal(meta.workspaceTitleByProjectKey.get(PROJECT), 'dsh-config-manager');
  assert.equal(meta.workspacePathByProjectKey.get(OTHER_PROJECT), 'D:\\Projects\\personal\\DeepSeekHarness');
});

test('readSessionMeta：缺文件 / 坏 JSON / 陌生形状 → 空索引，绝不抛错', async () => {
  const missing = makeContext('win32', HOME);
  assert.equal((await readSessionMeta(missing)).bySessionId.size, 0);

  const broken = makeContext('win32', HOME);
  await broken.fs.writeFile('storages/session_projcache.json', Buffer.from('{ not json', 'utf8'));
  await broken.fs.writeFile('storages/workspace.json', Buffer.from('[]', 'utf8'));
  const meta = await readSessionMeta(broken);
  assert.equal(meta.bySessionId.size, 0);
  assert.equal(meta.workspaceTitleByProjectKey.size, 0);

  const alien = makeContext('win32', HOME);
  await alien.fs.writeFile('storages/session_projcache.json', Buffer.from(JSON.stringify({ version: 99, sessions: 'nope' }), 'utf8'));
  assert.equal((await readSessionMeta(alien)).bySessionId.size, 0, '来自未来版本的形状一律忽略，不猜');
});

function unit(unitId: string, extra: Partial<ExportUnit> = {}): ExportUnit {
  return { id: `sessions:${unitId}`, label: unitId, fileCount: 1, sizeBytes: 10, ...extra };
}

test('applySessionMeta：补界面标题 + 工作区分组 + 工作区路径，非 sessions 单元原样透传', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  const units: ExportUnit[] = [
    unit(`${PROJECT}/${UUID_A}`),
    unit(`${PROJECT}/ffffffff-0000-0000-0000-000000000000`),
    unit(`${OTHER_PROJECT}/${UUID_B}`),
    { id: 'skills:coding', label: 'coding', sizeBytes: 5 },
  ];
  const out = applySessionMeta(units, meta);
  const byId = new Map(out.map((u) => [u.id, u]));

  const titled = byId.get(`sessions:${PROJECT}/${UUID_A}`)!;
  assert.equal(titled.label, '推送更新到 GitHub 并发布新版本', 'label = 用户界面上的会话标题');
  assert.equal(titled.group, 'dsh-config-manager', 'group = 工作区标题');
  assert.equal(titled.detail, 'D:\\Projects\\personal\\dsh-config-manager');

  const unknown = byId.get(`sessions:${PROJECT}/ffffffff-0000-0000-0000-000000000000`)!;
  assert.equal(unknown.label, `${PROJECT}/ffffffff-0000-0000-0000-000000000000`, '没有标题 → 保留目录名，不编造');
  assert.equal(unknown.group, 'dsh-config-manager', '但仍有工作区归属（按项目键反查）');

  const blankTitled = byId.get(`sessions:${OTHER_PROJECT}/${UUID_B}`)!;
  assert.equal(blankTitled.label, `${OTHER_PROJECT}/${UUID_B}`);
  assert.equal(blankTitled.group, 'DeepSeekHarness');

  const skill = byId.get('skills:coding')!;
  assert.equal(skill.label, 'coding');
  assert.equal(skill.group, undefined, '非 sessions 分区不得被分组');
  assert.equal(skill.detail, undefined);
});

test('导入体验：applySessionMetaToPlanItems 给计划项补会话标题 + 工作区分组（只写展示字段）', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  const items: { id: string; unitId?: string; adapter: string; kind: string; description: string; label?: string; group?: string }[] = [
    { id: `sessions:${PROJECT}/${UUID_A}`, unitId: `sessions:${PROJECT}/${UUID_A}`, adapter: 'sessions', kind: 'Create', description: 'd' },
    { id: 'sessions:--D-Elsewhere--/abcdef00-0000-0000-0000-000000000000', adapter: 'sessions', kind: 'Create', description: 'd' },
    { id: 'skills:coding', adapter: 'skills', kind: 'Create', description: 'd' },
  ];
  const out = applySessionMetaToPlanItems(items, meta);
  assert.equal(out[0]!.label, '推送更新到 GitHub 并发布新版本', '导入页要用界面标题，而不是会话目录名');
  assert.equal(out[0]!.group, 'dsh-config-manager');
  assert.equal(out[0]!.kind, 'Create', '执行契约字段一个都不动');
  assert.equal(out[0]!.id, items[0]!.id);
  assert.equal(out[1]!.label, undefined, '缓存里没有标题 → 不编造（UI 回退目录名）');
  assert.equal(out[1]!.group, '--D-Elsewhere--', '未知工作区用项目键兜底成组');
  assert.equal(out[2]!.label, undefined);
  assert.equal(out[2]!.group, undefined, '非 sessions 分区不得被分组');
});

test('applySessionMeta：组内按最近活跃倒序；未知工作区用项目键兜底成组', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  const old = '11111111-1111-1111-1111-111111111111';
  meta.bySessionId.set(old, { title: '旧会话', lastActivityAt: 1000 });
  meta.bySessionId.set(UUID_A, { title: '新会话', lastActivityAt: 9000 });
  const units = [unit(`${PROJECT}/${old}`), unit(`${PROJECT}/${UUID_A}`), unit('--D-Elsewhere--/abcdef00-0000-0000-0000-000000000000')];
  const out = applySessionMeta(units, meta);
  const inProject = out.filter((u) => u.group === 'dsh-config-manager').map((u) => u.label);
  assert.deepEqual(inProject, ['新会话', '旧会话'], '组内最近活跃在前');
  const elsewhere = out.find((u) => u.id.includes('Elsewhere'))!;
  assert.equal(elsewhere.group, '--D-Elsewhere--', '工作区注册表里没有 → 用项目键兜底，不留「未归类」坟场');
});

test('applySessionMeta：session- 前缀目录名同样拿到标题与活跃时间（真机：查表未归一化 → 丢标题 + 掉到组尾）', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  // 单元 id 末段是**目录名**：真机同一台机器上 `session-<uuid>` 与裸 `<uuid>` 两种形态并存。
  // 输入刻意把带前缀的那条放在后面：修好之前它查不到缓存（无标题、时间为 -1）→ 一定被排到最后。
  const units = [unit(`${PROJECT}/${UUID_B}`), unit(`${PROJECT}/session-${UUID_A}`)];
  const out = applySessionMeta(units, meta);

  assert.equal(out[0]!.id, `sessions:${PROJECT}/session-${UUID_A}`, '带前缀目录名按缓存里的活跃时间排在前面');
  assert.equal(out[0]!.label, '推送更新到 GitHub 并发布新版本', '带前缀目录名也要命中缓存（裸键归一化）');
  assert.equal(out[0]!.group, 'dsh-config-manager');
});

test('applySessionMeta：缓存没覆盖的会话用宿主现算的 mtime 兜底排序（缓存时间仍是第一口径）', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  const inCache = UUID_A; // 缓存里有 lastPromptAt = 1789245897999
  const noCacheOld = 'aaaaaaaa-0000-0000-0000-000000000001';
  const noCacheNew = 'bbbbbbbb-0000-0000-0000-000000000002';
  const activityAt = new Map<string, number>([
    [noCacheOld, 5000],
    [noCacheNew, 9000],
    [inCache, 9999999999999], // 再新也不该盖过缓存里的 lastPromptAt
  ]);
  const units = [unit(`${PROJECT}/${noCacheOld}`), unit(`${PROJECT}/${inCache}`), unit(`${PROJECT}/${noCacheNew}`)];
  const out = applySessionMeta(units, meta, 'sessions', activityAt);

  assert.deepEqual(out.map((u) => u.id), [
    `sessions:${PROJECT}/${inCache}`,
    `sessions:${PROJECT}/${noCacheNew}`,
    `sessions:${PROJECT}/${noCacheOld}`,
  ], '缓存时间优先，其余按日志 mtime 倒序 —— 缺时间的会话不再成堆掉到组尾按 uuid 排');
});

test('subagentParentMap：只收 origin=subagent 的关系，键值都归一化成裸键', () => {
  const map = subagentParentMap(new Map([
    ['session-c1', { parent: 'session-P', subagent: true }],
    ['c2', { parent: 'P', subagent: true }],
    ['x', { parent: 'P', subagent: false }], // 非 subagent 的会话即使带 parentSession 也是顶层行 → 不收
  ]));
  assert.deepEqual([...map.entries()].sort(), [['c1', 'P'], ['c2', 'P']]);
  assert.equal(subagentParentMap(undefined).size, 0, '宿主不提供关系 → 空映射（联动静默失效，不猜）');
  assert.equal(subagentParentMap(new Map([['a', { parent: '', subagent: true }]])).size, 0, '空父 id 忽略');
});

test('applySessionParentLinks：子代理会话标出父对话（两种目录名形态都认得出），其它单元原样', () => {
  const parentOf = new Map([['c1', 'P']]);
  const units: ExportUnit[] = [
    { id: `sessions:${PROJECT}/session-c1`, label: 'c1', sizeBytes: 1 },
    { id: `sessions:${PROJECT}/session-P`, label: 'P', sizeBytes: 1 },
    { id: 'skills:coding', label: 'coding', sizeBytes: 1 },
  ];
  const out = applySessionParentLinks(units, parentOf);
  assert.equal(out[0]!.parentSessionId, 'P', 'session-<uuid> 形态的目录名也认得出（裸键归一化）');
  assert.equal(out[1]!.parentSessionId, undefined, '父对话本身没有父字段（不编造）');
  assert.equal(out[2]!.parentSessionId, undefined, '非 sessions 分区原样透传');
  assert.equal(units[0]!.parentSessionId, undefined, '纯函数：不改原对象');
  assert.deepEqual(applySessionParentLinks(units, new Map()), units, '空映射 → 原样返回');
});

/* ---------------- 进程内缓存（mtime 失效）----------------
 * 为什么要有这些用例：`/export-preview`（sessions 有单元时）与 `/plan` 会各调一次
 * `readSessionMeta`，每次都要解析 1.57 MB 的 `session_projcache.json`（本机实测 7.3 ms）。
 * 缓存能命中、也能**及时失效**这两件事都必须被钉住：只测「命中」会掩盖「永远用陈旧数据」。
 */

/** 统计 readFile 次数的 MemFs：缓存命中必须体现为「一次都不读」。 */
class CountingFs extends MemFs {
  readonly reads: string[] = [];
  override async readFile(rel: string): Promise<Uint8Array> {
    this.reads.push(rel);
    return super.readFile(rel);
  }
}

/** 把 seedStorages 的文件表接到计数门面上，并登记两份 storage 的 mtime。 */
async function seededCounting(home: string, mtime: number): Promise<{ ctx: ReturnType<typeof makeContext>; fs: CountingFs }> {
  const seeded = await seedStorages(home);
  const fs = new CountingFs(home);
  fs.files = seeded.fs.files;
  fs.setMtime('storages/session_projcache.json', mtime);
  fs.setMtime('storages/workspace.json', mtime);
  const ctx = makeContext('win32', home);
  ctx.fs = fs;
  return { ctx, fs };
}

test('readSessionMeta：mtime 未变 → 命中进程内缓存（第二次一次都不读盘）', async () => {
  clearSessionMetaCache();
  const { ctx, fs } = await seededCounting('C:\\Users\\cache-hit', 1000);
  const first = await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 2, '首次要读 projcache + workspace 两份');
  const second = await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 2, '缓存命中不得再读盘');
  assert.equal(second.bySessionId.get(UUID_A)?.title, first.bySessionId.get(UUID_A)?.title);
});

test('readSessionMeta：任一存储文件 mtime 变化 → 缓存立即失效并读到新内容', async () => {
  clearSessionMetaCache();
  const { ctx, fs } = await seededCounting('C:\\Users\\cache-invalidate', 2000);
  assert.equal((await readSessionMeta(ctx)).bySessionId.get(UUID_B)?.title, undefined, '初始缓存里没有 B 的标题');
  await ctx.fs.writeFile('storages/session_projcache.json', Buffer.from(JSON.stringify({
    tables: { sessions: { [`session-${UUID_B}`]: { rows: { title: { val: '改过标题' } } } } },
  }), 'utf8'));
  fs.setMtime('storages/session_projcache.json', 2001);
  assert.equal((await readSessionMeta(ctx)).bySessionId.get(UUID_B)?.title, '改过标题', 'mtime 变了必须重新解析');
});

test('readSessionMeta：读不到 mtime（未登记）→ 不缓存，每次重读', async () => {
  clearSessionMetaCache();
  const seeded = await seedStorages('C:\\Users\\cache-nomtime');
  const fs = new CountingFs('C:\\Users\\cache-nomtime');
  fs.files = seeded.fs.files;
  const ctx = makeContext('win32', 'C:\\Users\\cache-nomtime');
  ctx.fs = fs;
  await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 2);
  await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 4, '无法判定新鲜度时不得用缓存（宁可多读，不可陈旧）');
});

test('readSessionMeta：门面完全没有 mtimeMs 能力（老宿主）→ 同样不缓存', async () => {
  clearSessionMetaCache();
  const seeded = await seedStorages('C:\\Users\\cache-nocap');
  const fs = new CountingFs('C:\\Users\\cache-nocap');
  fs.files = seeded.fs.files;
  Object.defineProperty(fs, 'mtimeMs', { value: undefined, configurable: true });
  const ctx = makeContext('win32', 'C:\\Users\\cache-nocap');
  ctx.fs = fs;
  await readSessionMeta(ctx);
  await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 4, '老宿主（无 mtimeMs）每次都要重新解析');
});

test('clearSessionMetaCache：清空后下一次调用重新读盘', async () => {
  clearSessionMetaCache();
  const { ctx, fs } = await seededCounting('C:\\Users\\cache-clear', 3000);
  await readSessionMeta(ctx);
  await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 2, '命中缓存');
  clearSessionMetaCache();
  await readSessionMeta(ctx);
  assert.equal(fs.reads.length, 4, '清空后必须重读（宿主可在存储重载信号上调用）');
  clearSessionMetaCache();
});

/**
 * 体检行补标题（2026-10-12 用户反馈：会话体检列表只有 `session-<uuid>`，同屏十几条里认不出
 * 哪条是自己的对话）。查表口径必须与导出选择器**逐字同一套**（裸键归一化）。
 */
test('applySessionTitles：体检行补对话标题（两种目录名形态都命中；没有标题绝不编造）', async () => {
  const meta = await readSessionMeta(await seedStorages(HOME));
  const rows = [
    { unitId: `${PROJECT}/session-${UUID_A}`, sessionId: `session-${UUID_A}`, severity: 'invisible' },
    { unitId: `${PROJECT}/${UUID_A}`, sessionId: UUID_A, severity: 'invisible' },
    { unitId: `${OTHER_PROJECT}/${UUID_B}`, sessionId: UUID_B, severity: 'invisible' },
  ];
  const out = applySessionTitles(rows, meta);
  assert.equal(out[0]?.title, '推送更新到 GitHub 并发布新版本', '带 session- 前缀的目录名同样要命中（查表前归一化）');
  assert.equal(out[1]?.title, '推送更新到 GitHub 并发布新版本', '裸 uuid 形态同样命中');
  assert.equal(out[2]?.title, undefined, '缓存里没有标题 → 不加字段（界面回落目录名，不编造）');
  assert.deepEqual(out.map((r) => r.unitId), rows.map((r) => r.unitId), '只加展示字段，不动行上的任何既有字段');
  assert.deepEqual(out.map((r) => r.severity), rows.map((r) => r.severity), '严重级等事实字段逐字不变');

  // 读不到 DSH 缓存（空索引）→ 原样返回，绝不抛错（体检本身仍然可用）
  const empty = { bySessionId: new Map(), workspaceTitleByProjectKey: new Map(), workspacePathByProjectKey: new Map() };
  assert.deepEqual(applySessionTitles(rows, empty).map((r) => r.title), [undefined, undefined, undefined]);
});
/* ---------------- 逐会话投影文件（全量标题来源）----------------
 * 用户要求（2026-10-12）：「历史对话的文本**始终**用对话标题，而不是只取缓存里的标题」。
 * 本机实测（2026-10-12，1347 个会话目录）：聚合缓存只覆盖 445 条，而逐会话投影文件覆盖**每一条**
 * —— 1150 份带标题，其余 197 份是 blank=true 的空白会话（DSH 自己给它们显示「新会话」）。
 */

/** 写一份逐会话投影文件（真机形状：`{ version, record: { identity, rows } }`）。 */
async function seedProjection(
  ctx: ReturnType<typeof makeContext>,
  fileName: string,
  rows: Record<string, unknown>,
): Promise<void> {
  const body = { version: 7, record: { identity: { cwd: 'D:\\Projects' }, rows } };
  // 文件名 = 会话目录名 + `.json`（真机形态）；调用方可以省掉后缀
  const name = fileName.endsWith('.json') ? fileName : fileName + '.json';
  await ctx.fs.writeFile('storages/session_projcache/sessions/' + name, Buffer.from(JSON.stringify(body), 'utf8'));
}

test('readSessionMetaWithTitles：聚合缓存缺标题时读逐会话投影文件补上（两种文件名形态都认）', async () => {
  clearSessionMetaCache();
  const ctx = await seedStorages(HOME); // 聚合里：A 有标题、B 没有
  // B 的投影文件（真机：文件名 = 会话目录名，两种形态并存）
  await seedProjection(ctx, 'session-' + UUID_B, {
    title: { ver: 1, seq: 3, val: '投影里的标题' },
    sessionListMetadata: { val: { blank: false } },
  });
  // 另一条只有裸 uuid 形态的投影文件
  const bareId = 'ffffffff-0000-0000-0000-000000000000';
  await seedProjection(ctx, bareId + '.json', { title: { ver: 1, seq: 2, val: '裸文件名形态的标题' } });

  const index = await readSessionMetaWithTitles(ctx, ['sessions:' + PROJECT + '/session-' + UUID_A, 'sessions:' + PROJECT + '/' + UUID_B, bareId, 'nonexistent-id']);
  assert.equal(index.bySessionId.get(UUID_A)?.title, '推送更新到 GitHub 并发布新版本', '聚合缓存里的标题原样保留（不被投影覆盖）');
  assert.equal(index.bySessionId.get(UUID_B)?.title, '投影里的标题', '聚合缺标题 → 用逐会话投影补上');
  assert.equal(index.bySessionId.get(bareId)?.title, '裸文件名形态的标题', '两种投影文件名形态都要认');
  assert.equal(index.bySessionId.get('nonexistent-id')?.title, undefined, '两边都没有 → 不编造');

  // 只读、纯：不改原索引对象
  const plain = await readSessionMeta(ctx);
  assert.equal(plain.bySessionId.get(UUID_B)?.title, undefined, 'readSessionMetaWithTitles 不得污染 readSessionMeta 的缓存索引');
});

test('readSessionMetaWithTitles：空白会话下发 blank 事实（没有标题可显示，界面显示「新会话」）', async () => {
  clearSessionMetaCache();
  const ctx = await seedStorages(HOME);
  await seedProjection(ctx, UUID_B + '.json', { sessionListMetadata: { val: { blank: true, lastPromptAt: null } } });
  const index = await readSessionMetaWithTitles(ctx, [UUID_B]);
  assert.equal(index.bySessionId.get(UUID_B)?.blank, true, '空白事实必须下发（界面据此显示本地化的「新会话」）');
  assert.equal(index.bySessionId.get(UUID_B)?.title, undefined, '空白会话没有标题 —— 绝不编造一个');
});

test('readSessionMetaWithTitles：只读「聚合里缺标题」的那些，且 mtime 未变时第二次不再读盘', async () => {
  clearSessionMetaCache();
  const { ctx, fs } = await seededCounting('C:\\Users\\proj-cache', 4000);
  await seedProjection(ctx, 'session-' + UUID_B, { title: { ver: 1, seq: 2, val: '投影标题 B' } });
  fs.setMtime('storages/session_projcache/sessions/session-' + UUID_B + '.json', 4100);
  const first = await readSessionMetaWithTitles(ctx, [UUID_A, UUID_B]);
  assert.equal(first.bySessionId.get(UUID_B)?.title, '投影标题 B');
  const after = fs.reads.length;
  const second = await readSessionMetaWithTitles(ctx, [UUID_A, UUID_B]);
  assert.equal(second.bySessionId.get(UUID_B)?.title, '投影标题 B');
  assert.equal(fs.reads.length, after, '同一批会话重复查询不得重复读盘（投影文件走 mtime 缓存）');
  // A 在聚合里已有标题 → 不该去读它的投影文件
  assert.equal(fs.reads.filter((rel) => rel.includes('session-' + UUID_A + '.json')).length, 0, '已有标题的会话不得多读一份文件');
});

test('sessionBareKeyOf：单元 id / 目录名两种入参都归一化到裸键', () => {
  assert.equal(sessionBareKeyOf('sessions:' + PROJECT + '/session-' + UUID_A), UUID_A);
  assert.equal(sessionBareKeyOf('session-' + UUID_A), UUID_A);
  assert.equal(sessionBareKeyOf(UUID_A), UUID_A);
});


test('blank 事实：导出单元与体检行都透传（界面据此显示本地化「新会话」而不是 uuid）', async () => {
  clearSessionMetaCache();
  const ctx = await seedStorages(HOME);
  await seedProjection(ctx, UUID_B + '.json', { sessionListMetadata: { val: { blank: true } } });
  const index = await readSessionMetaWithTitles(ctx, [UUID_B]);

  const units = applySessionMeta([unit(OTHER_PROJECT + '/' + UUID_B)], index);
  assert.equal(units[0]?.blank, true, '空白会话的导出单元必须带 blank（ContentPicker 显示「新会话」）');
  assert.equal(units[0]?.label, OTHER_PROJECT + '/' + UUID_B, '没有标题 → label 仍是目录名（界面按 blank 显示占位名）');

  const rows = applySessionTitles([{ unitId: OTHER_PROJECT + '/' + UUID_B, sessionId: UUID_B }], index);
  assert.equal(rows[0]?.blank, true, '体检行同样要带 blank');
  assert.equal(rows[0]?.title, undefined, '空白会话没有标题');

  const plan = applySessionMetaToPlanItems(
    [{ id: 'sessions:' + OTHER_PROJECT + '/' + UUID_B, unitId: 'sessions:' + OTHER_PROJECT + '/' + UUID_B, adapter: 'sessions', kind: 'Create', description: 'x' }],
    index,
  );
  assert.equal(plan[0]?.blank, true, '导入计划项同样要带 blank');
});

