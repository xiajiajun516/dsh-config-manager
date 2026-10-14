/**
 * 外部来源注册表 / 单元 id 命名空间 / 冲突语义的契约护栏（t12 冻结面）。
 *
 * 这三块是**契约**，不是实现细节：注册表形状冻结后六个来源才能并行实现，
 * 单元 id 命名空间冻结后 GUI/CLI 才能在不改动 DSH 既有 id 的前提下标注来源，
 * 冲突码冻结后「同 id 不覆盖」才有可断言的行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DSH_UNIT_ID_NAMESPACES,
  FOREIGN_CONFLICT_POLICY,
  FOREIGN_SESSION_CONFLICT_CODE,
  FOREIGN_SOURCE_IDS,
  FOREIGN_UNIT_ID_PREFIX,
  ForeignSourceError,
  ForeignSourceRegistry,
  builtinForeignSources,
  createBuiltinForeignSourceRegistry,
  createForeignSourceRegistry,
  detectForeignSources,
  dshUnitIdNamespaceOf,
  foreignUnitId,
  isForeignSourceId,
  isForeignUnitId,
  parseForeignUnitId,
} from './registry.ts';
import type { ForeignSource, ForeignSourceContext } from './registry.ts';
import type { ForeignSourceId } from './types.ts';

const CTX: ForeignSourceContext = { homeDir: '/home/u', env: {} };

/** 测试用假来源：形状合法、零 I/O（注册表不认识任何具体来源，正是契约要求） */
function fakeSource(id: string, labelKey = 'foreign.source.' + id): ForeignSource {
  return {
    id: id as ForeignSourceId,
    labelKey,
    // 假来源没有取证：取最弱的一档（真值表断言只覆盖内置来源，见 truth-table.ts）
    evidence: 'documented',
    probePaths: () => ['.fake/' + id],
    detect: async () => ({ found: true, paths: ['.fake/' + id] }),
    build: async () => ({ source: id as ForeignSourceId, sections: [], skipped: [], credentialRefs: [], counts: {} }),
  };
}

/* ---------------- 1. 来源注册与查找 ---------------- */

test('契约：注册后可按 id 查找，list 保持注册顺序，size/has 自洽', () => {
  const reg = createForeignSourceRegistry();
  assert.equal(reg.size, 0);
  assert.deepEqual(reg.ids(), []);

  reg.register(fakeSource('hermes')).register(fakeSource('claude-code'));
  assert.equal(reg.size, 2);
  assert.ok(reg.has('hermes'));
  assert.ok(!reg.has('cursor'));
  assert.deepEqual(reg.ids(), ['hermes', 'claude-code'], 'ids 必须按注册顺序（UI 列表顺序的单一来源）');
  assert.deepEqual(reg.list().map((s) => s.id), ['hermes', 'claude-code']);
  assert.equal(reg.get('hermes').id, 'hermes');
  assert.equal(reg.get('claude-code').labelKey, 'foreign.source.claude-code');
});

test('契约：构造函数可一次性装入；不装任何具体来源时注册表为空（注册表零副作用）', () => {
  const reg = new ForeignSourceRegistry([fakeSource('codex')]);
  assert.equal(reg.size, 1);
  assert.equal(reg.get('codex').id, 'codex');
  assert.equal(new ForeignSourceRegistry().size, 0);
});

test('契约：假来源的 detect/build 可被调用（接口形状可编译且可执行）', async () => {
  const reg = createForeignSourceRegistry([fakeSource('cursor')]);
  const src = reg.get('cursor');
  const det = await src.detect(CTX);
  assert.equal(det.found, true);
  assert.deepEqual(det.paths, ['.fake/cursor']);
  const built = await src.build(CTX);
  assert.equal(built.source, 'cursor');
  assert.deepEqual(built.sections, []);
});

/* ---------------- 2. 稳定错误 ---------------- */

test('契约：未知 id 抛出稳定错误（code/name/sourceId/available），绝不回退默认来源', () => {
  const reg = createForeignSourceRegistry([fakeSource('hermes'), fakeSource('codex')]);
  let caught: unknown;
  try {
    reg.get('nope');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ForeignSourceError, '未知 id 必须抛 ForeignSourceError');
  const err = caught as ForeignSourceError;
  assert.equal(err.name, 'ForeignSourceError');
  assert.equal(err.code, 'unknown-source');
  assert.equal(err.sourceId, 'nope');
  assert.deepEqual(err.available, ['hermes', 'codex'], '错误必须带可用来源清单（CLI 直接回显）');
  assert.match(err.message, /nope/);
  assert.match(err.message, /hermes, codex/);
  assert.equal(reg.has('nope'), false, '查不到就是查不到，不得顺手注册');
});

test('契约：重复 id 注册是装配期错误，先注册的绝不被覆盖', () => {
  const first = fakeSource('hermes', 'foreign.source.hermes.first');
  const reg = createForeignSourceRegistry([first]);
  let caught: unknown;
  try {
    reg.register(fakeSource('hermes', 'foreign.source.hermes.second'));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ForeignSourceError);
  assert.equal((caught as ForeignSourceError).code, 'duplicate-source');
  assert.equal(reg.size, 1);
  assert.equal(reg.get('hermes').labelKey, 'foreign.source.hermes.first', '先注册的必须原样保留');
});

test('契约：形状非法（未知来源 id / 空 labelKey / 缺 detect 或 build）一律 invalid-source', () => {
  const cases: { why: string; src: unknown }[] = [
    { why: '未知来源 id', src: { ...fakeSource('hermes'), id: 'not-a-source' } },
    { why: '缺 id', src: { ...fakeSource('hermes'), id: undefined } },
    { why: '空 labelKey', src: { ...fakeSource('hermes'), labelKey: '' } },
    { why: 'detect 不是函数', src: { ...fakeSource('hermes'), detect: 'nope' } },
    { why: 'build 不是函数', src: { ...fakeSource('hermes'), build: null } },
  ];
  for (const c of cases) {
    let caught: unknown;
    try {
      createForeignSourceRegistry([c.src as ForeignSource]);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof ForeignSourceError, c.why + ' 必须抛 ForeignSourceError');
    assert.equal((caught as ForeignSourceError).code, 'invalid-source', c.why);
  }
});

/* ---------------- 3. 来源 id 词表 ---------------- */

test('契约：来源 id 词表恰为 30 来源，顺序稳定，未知值不被当成来源', () => {
  assert.deepEqual([...FOREIGN_SOURCE_IDS], [
    'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
    'gemini', 'reasonix', 'opencode', 'mimocode', 'zcode', 'grokbuild', 'openclaw', 'pi',
    'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline',
    'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
  ],
  );
  for (const id of FOREIGN_SOURCE_IDS) assert.ok(isForeignSourceId(id), id);
  // 'gemini' 曾是这里的「非法样本」，档 B 起它是真来源 —— 非法样本必须用真正不存在的 id
  for (const bad of ['claude', 'Claude-Code', '', 'foreign', 'gemini-code', 'no-such-source']) {
    assert.equal(isForeignSourceId(bad), false, bad + ' 不得被当成来源 id');
  }
});

/* ---------------- 4. 单元 id 命名空间（两种形态互不误判） ---------------- */

/** 来自本仓库既有实现的真实 DSH 单元 id 样本（src/adapters/units.ts / sessions.ts） */
const DSH_UNIT_IDS: readonly { id: string; ns: string }[] = [
  { id: 'sessions:--D--proj--x/session-11111111-1111-4111-8111-111111111111', ns: 'sessions' },
  { id: 'sessions:--D--proj--x/a', ns: 'sessions' },
  { id: 'skills:bundle-one/ref.md', ns: 'skills' },
  { id: 'agentInstructions:AGENTS.md', ns: 'agentInstructions' },
  { id: 'agentPresets:default.md', ns: 'agentPresets' },
  { id: 'pluginFiles:foo/bar.txt', ns: 'pluginFiles' },
  { id: 'self:sync-config.json', ns: 'self' },
  { id: 'mcp:gitnexus', ns: 'mcp' },
  { id: 'settings:general', ns: 'settings' },
  { id: 'plugin:left-pad', ns: 'plugin' },
  { id: 'patch:some-line-id', ns: 'patch' },
  { id: 'workspace:ws-1', ns: 'workspace' },
];

test('契约：既有 DSH 单元 id → 分区/插件命名空间；外来源形态一律不认（一字不改）', () => {
  for (const { id, ns } of DSH_UNIT_IDS) {
    assert.equal(dshUnitIdNamespaceOf(id), ns, id);
    assert.equal(isForeignUnitId(id), false, id + ' 不得被当成外来源单元');
    assert.equal(parseForeignUnitId(id), null, id);
  }
});

test('契约：外来源单元 id → foreign:<source>:<section>:<unit>，且不被认成 DSH 命名空间', () => {
  const id = foreignUnitId('hermes', 'sessions', '--D--proj--x/session-a');
  assert.equal(id, 'foreign:hermes:sessions:--D--proj--x/session-a');
  assert.equal(isForeignUnitId(id), true);
  assert.deepEqual(parseForeignUnitId(id), {
    source: 'hermes', section: 'sessions', unit: '--D--proj--x/session-a',
  });
  assert.equal(dshUnitIdNamespaceOf(id), null, '外来源 id 不得落进任何 DSH 命名空间');
  assert.equal(
    dshUnitIdNamespaceOf(foreignUnitId('claude-code', 'skills', 'x/y.md')),
    null,
  );

  // 30 个来源 × 若干分区都必须成立（冻结的是形态，不是个别样例）
  for (const source of FOREIGN_SOURCE_IDS) {
    for (const section of ['mcp', 'skills', 'agentInstructions', 'sessions', 'workspaces'] as const) {
      const one = foreignUnitId(source, section, 'u');
      assert.equal(isForeignUnitId(one), true, one);
      assert.equal(dshUnitIdNamespaceOf(one), null, one);
    }
  }
});

test('契约：外来源前缀与 SectionId 无重叠（按构造互斥，不是靠约定）', () => {
  assert.equal(FOREIGN_UNIT_ID_PREFIX, 'foreign');
  assert.ok(!DSH_UNIT_ID_NAMESPACES.includes(FOREIGN_UNIT_ID_PREFIX));
  // 每个 SectionId 都不能等于 foreign——用真实 DSH 形态反证
  for (const { ns } of DSH_UNIT_IDS) {
    assert.notEqual(ns, FOREIGN_UNIT_ID_PREFIX, ns);
  }
});

test('契约：解析器对未知/畸形形态返回 null（不认识就说不认识，绝不猜）', () => {
  const bad = [
    'foreign:unknown-source:skills:x',
    'foreign:hermes:not-a-section:x',
    'foreign:hermes:skills:',
    'foreign:hermes',
    'foreign-hermes:skills:x',
    'hermes:skills:x',
    '',
  ];
  for (const id of bad) {
    assert.equal(parseForeignUnitId(id), null, id);
    assert.equal(isForeignUnitId(id), false, id);
  }
});

/* ---------------- 5. 冲突语义（不覆盖、跳过并报码） ---------------- */

test('契约：冲突码与冲突策略已冻结，且不存在覆盖分支', () => {
  assert.equal(FOREIGN_SESSION_CONFLICT_CODE, 'session-id-conflict');
  assert.equal(FOREIGN_CONFLICT_POLICY, 'skip-no-overwrite');
  // 类型层不允许第二个取值：这里用字面量比对，防有人把 union 放宽
  const only: 'skip-no-overwrite' = FOREIGN_CONFLICT_POLICY;
  assert.equal(only, 'skip-no-overwrite');
});


/* ---------------- 6. 30 个内置来源的装配（t22 收口；档 B 起含 24 个会话类来源） ---------------- */

/** 已入库的 Cursor fixture（用户级 basic/.cursor + 项目级 basic/project/.cursor） */
const CURSOR_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'cursor', 'basic');

test('装配：30 个内置来源全部注册，id 与冻结词表逐字一致（不靠两份清单各自维护）', () => {
  const reg = createBuiltinForeignSourceRegistry();
  assert.equal(reg.size, 30);
  assert.deepEqual([...reg.ids()], [...FOREIGN_SOURCE_IDS], '注册顺序与 id 必须与 §8.1 词表一致');
  for (const source of reg.list()) {
    assert.equal(source.labelKey, 'foreign.source.' + source.id, source.id);
    assert.equal(typeof source.detect, 'function');
    assert.equal(typeof source.build, 'function');
  }
  assert.deepEqual(builtinForeignSources().map((s) => s.id), [...FOREIGN_SOURCE_IDS]);
});

test('装配：可重复装配且互不共享实例（宿主路由与 CLI 各自独立装配）', () => {
  const a = createBuiltinForeignSourceRegistry();
  const b = createBuiltinForeignSourceRegistry();
  assert.notEqual(a.get('hermes'), b.get('hermes'));
  assert.equal(a.size, b.size);
});

test('装配：未知 id 的稳定错误带全部可用来源（CLI/路由直接回显给用户）', () => {
  const reg = createBuiltinForeignSourceRegistry();
  let caught: unknown;
  try {
    reg.get('nonexistent-source');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ForeignSourceError);
  assert.equal((caught as ForeignSourceError).code, 'unknown-source');
  assert.deepEqual((caught as ForeignSourceError).available, [...FOREIGN_SOURCE_IDS]);
});

test('检测：空 home 下 30 来源一律 found=false、绝不抛，且结果里没有绝对路径', async () => {
  const emptyHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreign-detect-empty-'));
  try {
    const statuses = await detectForeignSources(createBuiltinForeignSourceRegistry(), { homeDir: emptyHome, env: {} });
    assert.equal(statuses.length, 30);
    for (const s of statuses) {
      assert.equal(s.found, false, s.id + ' 在空 home 下不得被判为已安装');
      assert.deepEqual([...s.paths], [], s.id);
    }
    assert.ok(!JSON.stringify(statuses).includes(emptyHome), '检测结果绝不回传绝对路径（机器身份）');
  } finally {
    await fsp.rm(emptyHome, { recursive: true, force: true });
  }
});

test('检测：命中时列出真值表相对位置（含 0 字节如实报）且只 stat、绝不读内容', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreign-detect-hermes-'));
  const hermesHome = path.join(home, 'hermes');
  try {
    await fsp.mkdir(path.join(hermesHome, 'skills'), { recursive: true });
    await fsp.writeFile(path.join(hermesHome, 'config.yaml'), '', 'utf8'); // 0 字节 → source-empty-file
    await fsp.writeFile(path.join(hermesHome, 'SOUL.md'), 'DETECT_SENTINEL_SOUL_DO_NOT_LEAK', 'utf8');
    const statuses = await detectForeignSources(createBuiltinForeignSourceRegistry(), {
      homeDir: home,
      env: { HERMES_HOME: hermesHome },
    });
    const hermes = statuses.find((s) => s.id === 'hermes');
    assert.ok(hermes !== undefined);
    assert.equal(hermes.found, true);
    assert.deepEqual([...hermes.paths], ['config.yaml', 'SOUL.md', 'skills'], '位置相对来源根，按真值表顺序');
    assert.ok(hermes.skipped.some((s) => s.code === 'source-empty-file' && s.origin === 'config.yaml'));
    assert.ok(hermes.skipped.some((s) => s.code === 'source-location-overridden' && s.origin === 'HERMES_HOME'));
    const wire = JSON.stringify(statuses);
    assert.ok(!wire.includes('DETECT_SENTINEL_SOUL_DO_NOT_LEAK'), '检测层只 stat，绝不把内容带出来');
    assert.ok(!wire.includes(hermesHome), '检测结果绝不回传绝对路径');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

/* ---------------- 7. projectDir 接线（契约 §8.2 项目级路径，t22 修订） ---------------- */

function mcpServersOf(result: { sections: readonly { sectionId: string; data?: unknown }[] }): { serverName: string; args?: string[] }[] {
  const section = result.sections.find((s) => s.sectionId === 'mcp');
  assert.ok(section !== undefined, '必须产出 mcp 分区');
  return (section.data as { servers: { serverName: string; args?: string[] }[] }).servers;
}

function agentsMdOf(result: { sections: readonly { sectionId: string; files?: readonly { relativePath: string; data: Uint8Array }[] }[] }): string {
  const section = result.sections.find((s) => s.sectionId === 'agentInstructions');
  const file = section?.files?.find((f) => f.relativePath === 'AGENTS.md');
  assert.ok(file !== undefined, '必须产出唯一一个 AGENTS.md');
  return new TextDecoder().decode(file.data);
}

test('接线：给定 projectDir → 项目级 mcp.json 同名 server 原位覆盖（不出重复 serverName）+ 项目级 rules 读入', async () => {
  const source = createBuiltinForeignSourceRegistry().get('cursor');
  const result = await source.build({
    homeDir: CURSOR_FIXTURE,
    env: {},
    projectDir: path.join(CURSOR_FIXTURE, 'project'),
  });
  const servers = mcpServersOf(result);
  const names = servers.map((s) => s.serverName);
  assert.deepEqual(names, ['svc', 'remote', 'shared', 'project-only'], '同名 shared 原位覆盖，只留一条');
  assert.equal(names.filter((n) => n === 'shared').length, 1, '绝不产生重复 serverName');
  assert.deepEqual(servers.find((s) => s.serverName === 'shared')?.args, ['-y', 'project-level-shared'], '项目级定义胜出');
  assert.equal(result.counts['mcp.projectOverridden'], 1, '覆盖条数必须可见');
  assert.match(agentsMdOf(result), /project-always.mdc/, '项目级 rules 必须被读入');
});

test('接线：不给 projectDir → 行为与接线前逐字一致（只读用户级，不产出项目级内容）', async () => {
  const source = createBuiltinForeignSourceRegistry().get('cursor');
  const result = await source.build({ homeDir: CURSOR_FIXTURE, env: {} });
  const names = mcpServersOf(result).map((s) => s.serverName);
  assert.deepEqual(names, ['svc', 'remote', 'shared'], '只用户级；无 project-only');
  assert.deepEqual(mcpServersOf(result).find((s) => s.serverName === 'shared')?.args, ['-y', 'user-level-shared']);
  assert.equal(result.counts['mcp.projectOverridden'], undefined, '未给 projectDir 就谈不上覆盖');
  assert.ok(!agentsMdOf(result).includes('project-always.mdc'), '项目级规则不得进包');
});

test('检测：projectDir 让 Cursor 的检测面覆盖项目级真值位置；缺省则只报用户级', async () => {
  const reg = createBuiltinForeignSourceRegistry();
  const withoutProject = (await detectForeignSources(reg, { homeDir: CURSOR_FIXTURE, env: {} }))
    .find((s) => s.id === 'cursor');
  assert.ok(withoutProject !== undefined);
  assert.ok(!withoutProject.paths.some((p) => p.startsWith('project/')), '缺省绝不探测项目级');

  const withProject = (await detectForeignSources(reg, {
    homeDir: CURSOR_FIXTURE,
    env: {},
    projectDir: path.join(CURSOR_FIXTURE, 'project'),
  })).find((s) => s.id === 'cursor');
  assert.ok(withProject !== undefined);
  assert.ok(withProject.paths.includes('project/.cursor/mcp.json'), '项目级 mcp.json 必须出现在检测面里');
  assert.ok(withProject.paths.includes('project/.cursor/rules'));
});

