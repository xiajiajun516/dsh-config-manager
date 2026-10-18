/**
 * foreign-view 测试：检测结果 → 界面行的纯函数映射（t17）。
 *
 * 钉住四条最容易悄悄坏掉的纪律：
 *  ① **码全量映射**：冻结 ForeignSkipCode 逐个有字典键，且键在 uiZh 里真实存在
 *     （缺一个 = 界面上冒出一个裸机器码，而用户不知道那是什么）；
 *  ② **未检测到不是错误**：badge 必须是 info（写成 error 会让用户以为自己的机器坏了）；
 *  ③ **未知来源不编造**：非冻结词表 id 显示「未识别的来源」+ 保留原始 id；
 *  ④ **未检测到 ≠ 空**：empty 只对 found=true 成立（否则「没装」会被读成「装了但读不出来」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOREIGN_LOSSY_KINDS,
  FOREIGN_SKIP_KEY,
  foreignLossyRows,
  foreignPathsText,
  foreignSkipLine,
  foreignSourceRow,
  foreignSourcesViewModel,
  isKnownForeignSource,
} from './foreign-view.ts';
import { makeUiT, uiZh } from './i18n.ts';
import type { ForeignSkipCode } from '../foreign/types.ts';
import type { ForeignLossyKind, ForeignLossyRow, ForeignSourceStatusInput } from './foreign-view.ts';
import type { UiTextKey } from './i18n.ts';

const zh = makeUiT('zh');
const en = makeUiT('en');

/**
 * 冻结码全量 —— **从真实来源派生，绝不手抄**。
 *
 * `FOREIGN_SKIP_KEY` 的类型是 `Record<ForeignSkipCode, UiTextKey>`（不是 Partial）：
 * 新增码而忘了配键 = **编译失败**，所以 `Object.keys()` 就是 `ForeignSkipCode` 的运行期全量。
 * 此前这里手抄 27 个码并断言 `length === 27`，types.ts 加到 29 码后**不会红**（断言的只是
 * 它自己抄的那份）—— 那正是本仓库一路在防的「假绿」。
 */
const ALL_CODES: readonly ForeignSkipCode[] = Object.keys(FOREIGN_SKIP_KEY) as ForeignSkipCode[];

function src(overrides: Partial<ForeignSourceStatusInput> = {}): ForeignSourceStatusInput {
  return { id: 'claude-code', found: true, paths: ['.claude/settings.json'], skipped: [], ...overrides };
}

test('foreign-view：冻结码逐个有字典键，且键在字典里真实存在（缺一个即裸机器码）', () => {
  assert.ok(ALL_CODES.length > 0, '码集不能为空（否则本用例形同虚设）');
  // 正向核对：字典里以 foreign.skip. 开头的键必须与码集**一一对应**
  // （少一个 = 界面显示裸机器码；多一个 = 删了码却没删文案）。
  const dictCodes = Object.keys(uiZh).filter((k) => k.startsWith('foreign.skip.')).sort();
  assert.deepEqual(ALL_CODES.map((c) => 'foreign.skip.' + c).sort(), dictCodes, '字典里的 foreign.skip.* 键必须与冻结码集逐项一致');
  for (const code of ALL_CODES) {
    const key = FOREIGN_SKIP_KEY[code];
    assert.equal(key, 'foreign.skip.' + code, code + ' 的键形必须是 foreign.skip.<code>');
    assert.ok(
      Object.prototype.hasOwnProperty.call(uiZh, key),
      code + ' 的字典键 ' + key + ' 在 uiZh 里不存在 —— 界面会显示裸机器码',
    );
    // 文案必须真的被翻译（不是回退成键名）
    assert.notEqual(zh(key), key, code + ' 的 zh 文案缺失（回退成了键名）');
    assert.notEqual(en(key), key, code + ' 的 en 文案缺失（回退成了键名）');
  }
});

/**
 * 本轮（2026-10-18）新增的 8 个冻结码 —— **显式列出**（不从 Object.keys 派生）：
 * 全量映射测试只保证「键存在」，本用例额外钉住这几条的 zh/en **都是真文案**（非空、不等于键名、
 * 且中英不同文）。某一条被删或退回键名时，这里会单独变红，而不是被其它码的表绿掩盖。
 */
const NEW_CODES_2026_10_18: readonly ForeignSkipCode[] = [
  'unsupported-permissions',
  'unsupported-settings-keys',
  'unsupported-agents',
  'unsupported-rules',
  'unsupported-plugins',
  'session-id-mismatch',
  'mcp-server-id-conflict',
  'project-scan-truncated',
];

test('foreign-view：8 个新码在中英两套字典里都有非空文案（缺一即裸机器码）', () => {
  assert.equal(NEW_CODES_2026_10_18.length, 8, '本用例只覆盖本轮那 8 个码（数量变了就必须同步改这里）');
  for (const code of NEW_CODES_2026_10_18) {
    const key = FOREIGN_SKIP_KEY[code];
    assert.equal(key, 'foreign.skip.' + code, code + ' 的键形必须是 foreign.skip.<code>');
    assert.ok(
      Object.prototype.hasOwnProperty.call(uiZh, key),
      code + ' 的字典键 ' + key + ' 在 uiZh 里不存在 —— 界面会显示裸机器码',
    );
    for (const [lang, t] of [['zh', zh], ['en', en]] as const) {
      const text = t(key);
      assert.ok(text.trim().length > 0, code + ' 的 ' + lang + ' 文案为空');
      assert.notEqual(text, key, code + ' 的 ' + lang + ' 文案缺失（回退成了键名）');
    }
    assert.notEqual(zh(key), en(key), code + ' 的 zh/en 不得同文');
  }
});

test('foreign-view：foreignSkipKey 的未知码回退为可搜索的稳定标识（绝不 undefined）', () => {
  const line = foreignSkipLine({ code: 'brand-new-code-from-third-party' as ForeignSkipCode }, zh);
  assert.equal(line.code, 'brand-new-code-from-third-party');
  // UiT 对未注册键**原样返回键名** → 界面显示 'foreign.skip.brand-new-code-from-third-party'
  assert.equal(line.text, 'foreign.skip.brand-new-code-from-third-party');
});

test('foreign-view：skip 行保留 origin 与 count（有值才带，零/空不占位）', () => {
  const withMeta = foreignSkipLine({ code: 'skill-id-conflict', origin: 'dogfood', count: 3 }, zh);
  assert.equal(withMeta.origin, 'dogfood');
  assert.equal(withMeta.count, 3);
  const bare = foreignSkipLine({ code: 'source-empty-file', origin: '', count: 0 }, zh);
  assert.equal(bare.origin, undefined, '空 origin 不占位');
  assert.equal(bare.count, undefined, 'count=0 不占位（不谎报有 0 项）');
});

test('foreign-view：30 来源显示名走字典，未知 id 不编造（保留原始 id）', () => {
  // 这个 30 项字面量清单是**故意的**：source-registry.test.ts 拿它当单一事实源的反查锚点，
  // 不是手抄漂移（顺序与 source-modules.ts 的形状表逐项一致）。
  const ids = [
    'claude-code', 'hermes', 'cursor', 'codex', 'copilot', 'antigravity',
    'gemini', 'reasonix', 'opencode', 'mimocode', 'zcode', 'grokbuild', 'openclaw', 'pi',
    'kimi', 'kilocode', 'qoder', 'chatgpt', 'workbuddy', 'qwen', 'continue', 'cline',
    'goose', 'dsh4', 'zed', 'crush', 'teleagent', 'trae', 'vibe', 'dsh',
  ];
  for (const id of ids) {
    assert.ok(isKnownForeignSource(id), id + ' 必须属于冻结词表');
    const row = foreignSourceRow(src({ id }), zh);
    assert.equal(row.known, true);
    assert.notEqual(row.label, zh('foreign.source.unknown'), id + ' 不该走「未识别」分支');
  }
  assert.equal(isKnownForeignSource('some-future-agent'), false);
  const unknown = foreignSourceRow(src({ id: 'some-future-agent' }), zh);
  assert.equal(unknown.known, false);
  assert.ok(unknown.label.includes('some-future-agent'), '未知来源必须保留原始 id（否则用户无从上报）');
  assert.ok(unknown.label.includes(zh('foreign.source.unknown')));
});

test('foreign-view：未检测到 = info 徽章（不是错误），检测到且有未迁移项 = warn', () => {
  const missing = foreignSourceRow(src({ found: false, paths: [] }), zh);
  assert.equal(missing.badge, 'info', '「本机没装这个工具」是正常状态，不得标红');
  assert.equal(missing.statusText, zh('foreign.found.no'));
  assert.equal(missing.empty, false, '未检测到 ≠ 空来源（那是「装了但读不到」）');

  const clean = foreignSourceRow(src(), zh);
  assert.equal(clean.badge, 'ok');
  assert.equal(clean.statusText, zh('foreign.found.yes'));

  const withSkips = foreignSourceRow(src({ skipped: [{ code: 'memory-report-only' }] }), zh);
  assert.equal(withSkips.badge, 'warn', '有未迁移项必须升到 warn（用户需要知道有东西没搬）');
});

test('foreign-view：empty 只对 found=true 且零命中路径成立（界面据此禁用导入）', () => {
  const foundButNothing = foreignSourceRow(src({ found: true, paths: [] }), zh);
  assert.equal(foundButNothing.empty, true, '装了却读不到任何位置 → 界面禁用「导入」');
  assert.equal(foreignSourceRow(src({ found: true, paths: ['.claude'] }), zh).empty, false);
});

test('foreign-view：命中路径文本 —— 无命中给明确的说明而不是空白', () => {
  const row = foreignSourceRow(src({ paths: ['.claude', '.claude.json'] }), zh);
  const text = foreignPathsText(row, zh);
  assert.ok(text.includes('.claude'), '路径必须逐条出现');
  assert.ok(text.includes('.claude.json'));
  const none = foreignPathsText(foreignSourceRow(src({ found: false, paths: [] }), zh), zh);
  assert.equal(none, zh('foreign.pathsNone'), '无命中时必须明说，不能留空白');
});

test('foreign-view：null 响应 → null（界面走加载态），不编造空表', () => {
  assert.equal(foreignSourcesViewModel(null, zh), null);
});

test('foreign-view：整表模型 —— 六来源齐全、anyFound、冲突策略透传', () => {
  const vm = foreignSourcesViewModel({
    conflictPolicy: 'skip-no-overwrite',
    projectScoped: false,
    sources: [
      src({ id: 'claude-code', found: true }),
      src({ id: 'hermes', found: false, paths: [] }),
      src({ id: 'cursor', found: false, paths: [] }),
      src({ id: 'codex', found: false, paths: [] }),
      src({ id: 'copilot', found: false, paths: [] }),
      src({ id: 'antigravity', found: false, paths: [] }),
    ],
  }, zh);
  assert.ok(vm !== null);
  assert.equal(vm.rows.length, 6, '六来源一条都不能少（未装的也要列出来）');
  assert.equal(vm.anyFound, true);
  assert.equal(vm.conflictPolicy, 'skip-no-overwrite');

  const allMissing = foreignSourcesViewModel({
    sources: [src({ id: 'hermes', found: false, paths: [] })],
  }, zh);
  assert.equal(allMissing?.anyFound, false, '全未检测到 → 界面据此提示「没有可导入的来源」');
  assert.equal(allMissing?.conflictPolicy, null, '宿主未回策略 → null（界面不渲染该行，绝不编造）');
});

test('foreign-view：整表顺序 —— 命中的整组在前，同组内按显示名升序；全未命中即纯名称序', () => {
  // 顺序刻意打乱：宿主按注册表顺序回，界面必须自己排。
  // 这条用例同时证明**排序键是显示名而不是 id** —— antigravity 的 id 排在最前，
  // 显示名却是「Google Antigravity」，按 id 排会把它顶到 Cursor 前面。
  const mixed: ForeignSourceStatusInput[] = [
    src({ id: 'zed', found: false, paths: [] }),
    src({ id: 'antigravity', found: true }),
    src({ id: 'cursor', found: false, paths: [] }),
    src({ id: 'trae', found: true }),
  ]
  const vm = foreignSourcesViewModel({ sources: mixed }, zh)
  assert.ok(vm !== null)
  assert.deepEqual(
    vm.rows.map((r) => r.label),
    ['Google Antigravity', 'Trae', 'Cursor', 'Zed'],
    '命中组必须整体在前（组内按名称），未命中组在后（组内按名称）',
  )
  assert.deepEqual(
    mixed.map((s) => s.id),
    ['zed', 'antigravity', 'cursor', 'trae'],
    '排序只动新数组：宿主回传的 sources 不得被就地重排',
  )
  assert.equal(vm.anyFound, true);

  // 一个都没命中 → 退化成**纯名称序**（用户要的「默认按名称排序」）
  const none = foreignSourcesViewModel({
    sources: [
      src({ id: 'zed', found: false, paths: [] }),
      src({ id: 'antigravity', found: false, paths: [] }),
      src({ id: 'cursor', found: false, paths: [] }),
    ],
  }, zh)
  assert.deepEqual(
    none?.rows.map((r) => r.label),
    ['Cursor', 'Google Antigravity', 'Zed'],
    '全未命中时就是按显示名排序（按 id 排会得到 Google Antigravity / Cursor / Zed）',
  );

  // 全都命中 → 同样只在「命中组」内部按名称排
  const all = foreignSourcesViewModel({ sources: [src({ id: 'zed' }), src({ id: 'hermes' })] }, zh)
  assert.deepEqual(all?.rows.map((r) => r.label), ['Hermes', 'Zed']);
});

test('foreign-view：shapes 与既有 UiT 对齐（en 也有全部新键，无回退）', () => {
  for (const code of ALL_CODES) {
    assert.notEqual(en(FOREIGN_SKIP_KEY[code]), zh(FOREIGN_SKIP_KEY[code]), code + ' 的 en 与 zh 不得同文');
  }
  for (const key of ['foreign.source.unknown', 'foreign.found.yes', 'foreign.found.no', 'foreign.pathsNone'] as const) {
    assert.notEqual(en(key), key);
    assert.notEqual(zh(key), key);
  }
});

/* ------------------------------------------------ F-5：三类已知有损的展示行 */

/** 按 kind 取一条（找不到即断言失败，顺带完成窄化）。 */
function lossyRowOf(rows: readonly ForeignLossyRow[], kind: ForeignLossyKind): ForeignLossyRow {
  const row = rows.find((r) => r.kind === kind);
  assert.ok(row !== undefined, kind + ' 必须出现在展示行里');
  return row;
}

test('foreign-view：三类有损的键在 zh/en 两本字典里都真实存在且不同文（缺键即回退键名）', () => {
  assert.deepEqual(
    [...FOREIGN_LOSSY_KINDS],
    ['file-section-secrets', 'entry-backslash', 'prompt-persona-reshape'],
    '三类有损的标识与顺序是固定的（界面按此顺序渲染）',
  );
  for (const kind of FOREIGN_LOSSY_KINDS) {
    for (const suffix of ['title', 'detail'] as const) {
      const key = ('foreign.lossy.' + kind + '.' + suffix) as UiTextKey;
      assert.ok(
        Object.prototype.hasOwnProperty.call(uiZh, key),
        key + ' 在 uiZh 里不存在 —— 界面会显示裸键名',
      );
      assert.notEqual(zh(key), key, key + ' 的 zh 文案缺失');
      assert.notEqual(en(key), key, key + ' 的 en 文案缺失');
      assert.notEqual(zh(key), en(key), key + ' 的 zh/en 不得同文');
    }
  }
  // 卡片 chrome 的 4 个键属客户端外壳，在 src/client/locales.ts（由
  // src/client/import/foreign-import-view-guard.test.ts 按源码守卫覆盖），此处不重复断言。
});

test('foreign-view：尚未产包 → 三条 applicable 全为 null（界面不给徽章，绝不写「不适用」）', () => {
  const rows = foreignLossyRows(null, zh);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.applicable, null, row.kind + ' 在未产包时不得声称适用或不适用');
    assert.equal(row.title, zh(('foreign.lossy.' + row.kind + '.title') as UiTextKey));
    assert.equal(row.detail, zh(('foreign.lossy.' + row.kind + '.detail') as UiTextKey));
  }
  assert.equal(lossyRowOf(rows, 'file-section-secrets').severity, 'warn');
  assert.equal(lossyRowOf(rows, 'entry-backslash').severity, 'warn');
  assert.equal(lossyRowOf(rows, 'prompt-persona-reshape').severity, 'info', '形状变化、文本无损 → 中性语义');
});

test('foreign-view：包内只有结构化分区 → 秘密不剥离与 prompts 形状两条「不涉及」，反斜杠仍如实提示', () => {
  const rows = foreignLossyRows(['mcp', 'settings'], zh);
  assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, false, '无文件类分区 → 该条不适用');
  assert.equal(lossyRowOf(rows, 'prompt-persona-reshape').applicable, false, '无 prompts 分区 → 该条不适用');
  assert.equal(
    lossyRowOf(rows, 'entry-backslash').applicable,
    true,
    '条目名在浏览器里看不到 → 只要产了包就如实提示（不得谎称不涉及）',
  );
});

test('foreign-view：文件类分区的判定取注册表（skills/agentPresets/.../self 六个），不另抄清单', () => {
  for (const id of ['skills', 'agentPresets', 'agentInstructions', 'pluginFiles', 'sessions', 'self']) {
    const rows = foreignLossyRows([id], zh);
    assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, true, id + ' 是文件类分区');
  }
  // 未注册 / 结构化分区一律不算文件类（未知 id 不得被当成文件类而误报）
  for (const id of ['settings', 'providers', 'workspaces', 'credentialsStatus', 'some-future-section']) {
    const rows = foreignLossyRows([id], zh);
    assert.equal(lossyRowOf(rows, 'file-section-secrets').applicable, false, id + ' 不是文件类分区');
  }
});

test('foreign-view：prompts 分区 / 六文件类分区同时命中 → 三条全「适用」', () => {
  const rows = foreignLossyRows(['skills', 'prompts'], zh);
  for (const row of rows) assert.equal(row.applicable, true, row.kind + ' 在本包里应当适用');
});
