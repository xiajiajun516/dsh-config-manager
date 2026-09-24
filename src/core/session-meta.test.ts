/**
 * DSH 会话元数据（导出选择器的「工作区标题 + 会话标题」数据源）。
 *
 * 重点覆盖：projectKey 算法与真实目录名一致（决定工作区分组归不归得对）、storages 缓存
 * 读取的宽容性（缺文件 / 坏 JSON / 陌生形状一律退化成空索引，绝不抛错）、以及单元富化
 * 的边界（无标题 / 无工作区 / 非 sessions 单元原样透传）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeContext } from '../adapters/test-helpers.ts';
import type { ExportUnit } from './types.ts';
import { applySessionMeta, applySessionMetaToPlanItems, applySessionParentLinks, projectKeyOf, readSessionMeta, subagentParentMap } from './session-meta.ts';

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
