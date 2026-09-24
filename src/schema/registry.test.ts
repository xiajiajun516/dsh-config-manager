/**
 * 分区注册表测试（t29）。
 *
 * 覆盖四类硬性质：
 *  1. **行为等价**：SECTION_IDS / SECTION_JSON_PATHS / SECTION_FILE_PREFIXES 与历史字面量
 *     （顺序 + 内容）逐项一致 —— 这些对象被 Object.keys/entries 迭代（sync/layout、git-transport、
 *     exporter、backup-verify），顺序变化会改变落盘/遍历顺序，因此必须钉死；
 *  2. **编译期穷举**的运行时可见面：注册表键集合 === SECTION_IDS，且每个已注册 id 的 id 字段自洽；
 *     （「漏注册 → tsc 报错」由 tsc 实证，见任务 output）
 *  3. **零 node 依赖**：静态扫描 section-registry.ts 的 import 清单（client bundle 自包含铁律）；
 *  4. **未注册分区不静默**：sectionMetaOf / requireSectionMeta / validateSectionData 三处都要显式失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_INCLUDED_SECTION_IDS,
  OPT_IN_SYNC_SECTION_IDS,
  PORTABLE_SECTION_IDS,
  SECTION_DATA_VERSION,
  SECTION_FILE_PREFIXES,
  SECTION_IDS,
  SECTION_JSON_PATHS,
  SECTION_REGISTRY,
  filePrefixOf,
  isFileSection,
  isSectionId,
  jsonPathOf,
  requireSectionMeta,
  sectionMeta,
  sectionMetaOf,
  type SectionMeta,
  type SectionRiskTier,
} from './section-registry.ts';
import type { SectionId } from './types.ts';
import { validateSectionData } from './config.ts';
import {
  isSupportedSectionDataVersion,
  sectionDataVersion,
  sectionDataVersionIssue,
} from './versions.ts';

/** 历史字面量快照（t29 改动前的 config.ts 内容）——用于钉住行为等价 */
const HISTORICAL_SECTION_IDS: readonly SectionId[] = [
  'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts',
  'skills', 'agentPresets', 'agentInstructions', 'workspaces', 'pluginFiles',
  'credentialsStatus', 'secrets', 'sessions', 'self',
];
const HISTORICAL_JSON_PATHS: ReadonlyArray<readonly [SectionId, string]> = [
  ['settings', 'config/settings.json'],
  ['ui', 'config/ui.json'],
  ['providers', 'ai/providers.json'],
  ['plugins', 'plugins/plugins.json'],
  ['mcp', 'mcp/servers.json'],
  ['prompts', 'custom/prompts.json'],
  ['workspaces', 'workspaces/workspaces.json'],
  ['credentialsStatus', 'security/credentials.json'],
];
const HISTORICAL_FILE_PREFIXES: ReadonlyArray<readonly [SectionId, string]> = [
  ['skills', 'custom/skills/'],
  ['agentPresets', 'agents/presets/'],
  ['agentInstructions', 'custom/agent-instructions/'],
  ['pluginFiles', 'plugin-files/'],
  ['sessions', 'sessions/'],
  ['self', 'self/'],
];

/* ---------------- 行为等价（顺序 + 内容） ---------------- */

test('registry: SECTION_IDS 与历史数组逐项一致（顺序 = applyOrder 升序）', () => {
  assert.deepEqual([...SECTION_IDS], [...HISTORICAL_SECTION_IDS]);
  assert.equal(SECTION_IDS.length, 15);
  const orders = SECTION_IDS.map((id) => SECTION_REGISTRY[id].applyOrder);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'applyOrder 必须与 SECTION_IDS 顺序一致');
  assert.deepEqual(orders, Array.from({ length: 15 }, (_, i) => i + 1), 'applyOrder 连续且从 1 起');
});

test('registry: SECTION_JSON_PATHS / SECTION_FILE_PREFIXES 与历史字面量逐项一致（含键顺序）', () => {
  assert.deepEqual(Object.entries(SECTION_JSON_PATHS), HISTORICAL_JSON_PATHS.map(([k, v]) => [k, v]));
  assert.deepEqual(Object.entries(SECTION_FILE_PREFIXES), HISTORICAL_FILE_PREFIXES.map(([k, v]) => [k, v]));
  // 键集合必须等于「声明了 zipPath / filePrefix 的分区」
  assert.deepEqual(
    Object.keys(SECTION_JSON_PATHS).sort(),
    SECTION_IDS.filter((id) => SECTION_REGISTRY[id].payload.kind !== 'files' && SECTION_REGISTRY[id].payload.kind !== 'none').sort(),
  );
  assert.deepEqual(
    Object.keys(SECTION_FILE_PREFIXES).sort(),
    SECTION_IDS.filter((id) => SECTION_REGISTRY[id].payload.kind === 'files').sort(),
  );
});

test('registry: 派生的可移植性 / 可选分区 / 默认勾选与既有声明一致', () => {
  assert.deepEqual([...PORTABLE_SECTION_IDS], [
    'settings', 'ui', 'providers', 'plugins', 'prompts', 'skills',
    'agentPresets', 'agentInstructions', 'self',
  ]);
  assert.deepEqual([...OPT_IN_SYNC_SECTION_IDS], ['sessions'], '可选分区当前仅 sessions（sync/selection 既有断言一致）');
  assert.deepEqual([...DEFAULT_INCLUDED_SECTION_IDS], [
    'settings', 'ui', 'providers', 'plugins', 'mcp', 'prompts', 'skills',
    'agentPresets', 'agentInstructions', 'workspaces', 'credentialsStatus', 'self',
  ]);
  assert.equal(SECTION_REGISTRY.secrets.portability, 'deviceSpecific');
  assert.equal(SECTION_REGISTRY.secrets.defaultIncluded, false, 'secrets 无 adapter，且不在快速导出目录内');
});

test('registry: 每个条目的 id 字段自洽，且访问器与 payload 判别一致', () => {
  for (const id of SECTION_IDS) {
    const meta = SECTION_REGISTRY[id];
    assert.equal(meta.id, id, `${id} 的 id 字段必须与键一致`);
    assert.equal(sectionMeta(id), meta);
    assert.equal(sectionMetaOf(id), meta);
    assert.equal(isSectionId(id), true);
    assert.equal(isFileSection(id), meta.payload.kind === 'files');
    assert.equal(jsonPathOf(id), meta.payload.kind === 'files' || meta.payload.kind === 'none' ? null : (meta.payload as { zipPath: string }).zipPath);
    assert.equal(filePrefixOf(id), meta.payload.kind === 'files' ? (meta.payload as { filePrefix: string }).filePrefix : null);
  }
  // 文件类分区与 JSON 分区互斥且覆盖全部 id
  const files = SECTION_IDS.filter((id) => isFileSection(id));
  const json = SECTION_IDS.filter((id) => jsonPathOf(id) !== null);
  const none = SECTION_IDS.filter((id) => jsonPathOf(id) === null && !isFileSection(id));
  assert.deepEqual([...none], ['secrets']);
  assert.equal(files.length + json.length + none.length, SECTION_IDS.length);
});

/* ---------------- 零 node 依赖 ---------------- */

test('registry: section-registry.ts 零 node 内置依赖（client bundle 自包含铁律）', () => {
  const src = readFileSync(new URL('./section-registry.ts', import.meta.url), 'utf8');
  const importSpecifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(importSpecifiers, ['./types.ts'], '唯一 import 必须是 ./types.ts');
  assert.ok(!/\bnode:/.test(src), '不得出现 node: 前缀说明符');
  assert.ok(!/\brequire\s*\(/.test(src), '不得出现 require(');
  // 唯一 import 还必须是 type-only（运行时零依赖）
  assert.match(src, /^import type \{ SectionId \} from '\.\/types\.ts';$/m, 'import 必须为 import type');
});

/* ---------------- 未注册分区不静默 ---------------- */

test('registry: 未注册 / 非字符串 id 一律安全拒绝（含原型链键）', () => {
  assert.equal(sectionMetaOf('not-a-section'), null);
  assert.equal(sectionMetaOf('toString'), null, 'Object.prototype 上的键不得被当成分区');
  assert.equal(sectionMetaOf(123), null);
  assert.equal(sectionMetaOf(null), null);
  assert.equal(sectionMetaOf(undefined), null);
  assert.equal(isSectionId('__proto__'), false);
  assert.throws(() => requireSectionMeta('nope'), /未注册分区/);
  assert.equal(requireSectionMeta('sessions').id, 'sessions');
});

test('registry: validateSectionData 对未注册 id 显式报错（不静默按其它分区语义处理）', () => {
  const issues = validateSectionData('ghost' as SectionId, { version: 1 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'error');
  assert.match(issues[0]!.message, /未注册分区 ghost/);
});

test('registry: validateSectionData 对 secrets（无 JSON 载荷）给出明确错误而非「未知分区」', () => {
  const issues = validateSectionData('secrets', { version: 1 });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /secrets 无 JSON 载荷/);
});

/* ---------------- 分区载荷版本（第二条版本轴） ---------------- */

test('registry: 分区载荷版本唯一来源 = 注册表 dataVersion（当前全部为 SECTION_DATA_VERSION）', () => {
  assert.equal(SECTION_DATA_VERSION, 1, '读侧/写侧的载荷版本仍是 1（不得在这个任务里改版本号）');
  for (const id of SECTION_IDS) {
    assert.equal(sectionDataVersion(id), SECTION_DATA_VERSION);
    assert.equal(SECTION_REGISTRY[id].dataVersion, SECTION_DATA_VERSION);
  }
  assert.equal(isSupportedSectionDataVersion('settings', 1), true);
  assert.equal(isSupportedSectionDataVersion('settings', 2), false);
  assert.equal(isSupportedSectionDataVersion('settings', '1'), false, '字符串 1 不是合法版本');
  assert.equal(isSupportedSectionDataVersion('settings', undefined), false);
  assert.equal(sectionDataVersionIssue('plugins', 1), null);
  // 文案与历史 validateSectionData 逐字一致（行为等价）
  assert.equal(sectionDataVersionIssue('plugins', 2), '分区 plugins 的 version 必须为 1（收到 2）');
  assert.equal(sectionDataVersionIssue('sessions', undefined), '分区 sessions 的 version 必须为 1（收到 undefined）');
});

test('registry: validateSectionData 的版本错误形状与历史一致（只报 version 并提前返回）', () => {
  const issues = validateSectionData('settings', { version: 2, namespaces: 'wrong' });
  assert.deepEqual(issues, [{
    path: 'version',
    message: '分区 settings 的 version 必须为 1（收到 2）',
    severity: 'error',
  }]);
});

test('registry: 形状校验（注册表驱动的载荷判别）逐分区生效', () => {
  // namespaces 分区
  assert.match(validateSectionData('settings', { version: 1 })[0]!.message, /缺少 namespaces 对象/);
  assert.deepEqual(validateSectionData('settings', { version: 1, namespaces: {} }), []);
  // object 分区
  assert.match(validateSectionData('providers', { version: 1 })[0]!.message, /缺少 providers 对象/);
  assert.deepEqual(validateSectionData('providers', { version: 1, providers: {} }), []);
  // array 分区（含额外数组字段与 patchFiles 校验）
  assert.match(validateSectionData('mcp', { version: 1 })[0]!.message, /servers 必须是数组/);
  assert.deepEqual(validateSectionData('mcp', { version: 1, servers: [] }), []);
  const pluginsIssues = validateSectionData('plugins', { version: 1, plugins: [], patch: 'nope' });
  assert.deepEqual(pluginsIssues.map((i) => i.path), ['patch']);
  const patchIssues = validateSectionData('plugins', {
    version: 1, plugins: [], patchFiles: [{ relativePath: '../evil', base64: 1 }],
  });
  assert.deepEqual(patchIssues.map((i) => i.path), ['patchFiles[0].relativePath', 'patchFiles[0].base64']);
  // files 分区
  assert.match(validateSectionData('skills', { version: 1 })[0]!.message, /files 必须是数组/);
  assert.deepEqual(validateSectionData('skills', { version: 1, files: [] }), []);
});

/* ---------------- t34：风险分级并入注册表（sync/risk.ts 的 SECTION_RISK_TIER 改为派生视图） ---------------- */

/** 历史字面量快照（t34 改动前 sync/risk.ts 的 SECTION_RISK_TIER）——钉住分级值不变 */
const HISTORICAL_RISK_TIERS: Readonly<Record<string, SectionRiskTier>> = {
  settings: 'low', ui: 'low', providers: 'low', prompts: 'low',
  workspaces: 'medium', plugins: 'medium', mcp: 'medium',
  skills: 'low', agentPresets: 'low', agentInstructions: 'low',
  pluginFiles: 'high', sessions: 'high', self: 'low',
  credentialsStatus: 'high', secrets: 'high',
};

test('registry: 每个分区都声明 riskTier，且与改造前的分级逐项一致（行为等价）', () => {
  const fromRegistry = Object.fromEntries(SECTION_IDS.map((id) => [id, SECTION_REGISTRY[id].riskTier]));
  assert.deepEqual(fromRegistry, HISTORICAL_RISK_TIERS);
  assert.deepEqual(Object.keys(fromRegistry).sort(), Object.keys(HISTORICAL_RISK_TIERS).sort());
  for (const id of SECTION_IDS) {
    assert.ok(['low', 'medium', 'high'].includes(SECTION_REGISTRY[id].riskTier), `${id} 的 riskTier 值域非法`);
  }
});

test('registry: riskTier 是 SectionMeta 的必填字段（类型层强制，缺项编译失败）', () => {
  // 运行时锚点：全部条目都有值、且能被 SectionRiskTier 类型接收
  for (const id of SECTION_IDS) {
    const tier: SectionRiskTier = sectionMeta(id).riskTier;
    assert.equal(tier, SECTION_REGISTRY[id].riskTier);
  }
  // 类型层探针 1：注册表全量覆盖 SectionId（少一个 id 即编译失败）
  type RegCoversAll = Exclude<SectionId, keyof typeof SECTION_REGISTRY> extends never ? true : never;
  const regCovers: RegCoversAll = true;
  assert.equal(regCovers, true);
  // 类型层探针 2：SectionMeta 的字面量缺 riskTier 会编译失败（见 output 的临时实验证据：
  //   删除 settings 条目的 `riskTier: 'low',` 一行 → TS2741 Property 'riskTier' is missing）
  const probe: SectionMeta = {
    id: 'settings',
    displayName: 'Probe',
    group: 'general',
    payload: { kind: 'none' },
    dataVersion: SECTION_DATA_VERSION,
    applyOrder: 99,
    portability: 'portable',
    optInSync: false,
    defaultIncluded: true,
    riskTier: 'low',
  };
  assert.equal(probe.riskTier, 'low');
});
