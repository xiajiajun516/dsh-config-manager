/**
 * cordis.patch.yml 的 YAML 方言单测（issue #75）。
 *
 * 钉住的语义：
 *  - 「!!js」必须能读写往返（顶层行 / 嵌套 config / 块标量 / 正则形态）；
 *  - 存进 bundle 的 raw 必须是普通 JSON（过一遍 JSON.stringify/parse 不掉东西）；
 *  - 载入用 DSH 的 JSON_SCHEMA（例：「~」是字符串而不是 null）—— 读法必须与 DSH 一致；
 *  - 解析失败要抛错，且摘要只取首行（js-yaml 的 message 会附带出错处源码片段，
 *    而 patch 文件里可能内联字面量密钥，片段绝不得外流）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import * as yaml4 from 'js-yaml4';

import { describePatchYamlError, dumpPatchDocument, findPatchKeyHazards, isPatchJsExpr, loadPatchDocument } from './patch-yaml.ts';

/** 真机形态（issue #75 报告的那一行）：顶层行 + 行内 JS 表达式 + 嵌套 config。 */
const SAMPLE = [
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  disabled: !!js (function(){ return true })()',
  '  config:',
  '    pattern: !!js /^abc$/',
  '    script: !!js |',
  '      var a = 1',
  '      return a',
  '    plain: hello',
  '',
].join('\n');

test('loadPatchDocument：!!js 变成 {__jsExpr}，普通值不受影响', () => {
  const doc = loadPatchDocument(SAMPLE);
  assert.ok(Array.isArray(doc));
  const row = doc[0] as Record<string, unknown>;
  assert.equal(row['id'], 'llm-pi-ai');
  assert.deepEqual(row['disabled'], { __jsExpr: '(function(){ return true })()' });
  const config = row['config'] as Record<string, unknown>;
  assert.deepEqual(config['pattern'], { __jsExpr: '/^abc$/' });
  assert.deepEqual(config['script'], { __jsExpr: 'var a = 1\nreturn a\n' }, '块标量保留源码与换行');
  assert.equal(config['plain'], 'hello');
  assert.equal(isPatchJsExpr(row['disabled']), true);
  assert.equal(isPatchJsExpr(row['id']), false);
});

test('写回保真：!!js 原样输出（含块标量形态），再次载入等价', () => {
  const doc = loadPatchDocument(SAMPLE);
  const text = dumpPatchDocument(doc);
  assert.ok(text.includes('!!js '), '必须重新写出 !!js 标签');
  assert.ok(text.includes('!!js |'), '块标量形态要保留');
  assert.deepEqual(loadPatchDocument(text), doc, '写回→载入必须等价');
});

test('raw 是普通 JSON：JSON.stringify/parse 之后仍然等价（bundle 分区 JSON 的前提）', () => {
  const doc = loadPatchDocument(SAMPLE);
  const viaJson: unknown = JSON.parse(JSON.stringify(doc));
  assert.deepEqual(viaJson, doc);
  assert.deepEqual(loadPatchDocument(dumpPatchDocument(viaJson)), doc);
});

test('载入走 DSH 的 JSON_SCHEMA：~ 是字符串（缺省 schema 读成 null）', () => {
  const text = '- id: a\n  disabled: ~\n';
  const doc = loadPatchDocument(text) as Array<Record<string, unknown>>;
  assert.equal(doc[0]?.['disabled'], '~', '与 DSH 读到的值一致：JSON_SCHEMA 下 ~ 不是 null');
  const plain = yaml.load(text) as Array<Record<string, unknown>>;
  assert.equal(plain[0]?.['disabled'], null, '缺省 schema 会给 null —— 这正是不能直接用 yaml.load 的原因');
});

test('读不出来的方言必须抛错（绝不吞成空文档）', () => {
  assert.throws(() => loadPatchDocument('- id: a\n  x: !!python/foo bar\n'), /unknown/);
});

test('describePatchYamlError：只取首行，源码片段（可能含内联密钥）绝不外流', () => {
  const fake = new Error('bad indentation of a mapping entry (3:5)\n\n 1 | - id: a\n 2 |   token: sk-live-abcdefghijklmnop\n');
  const safe = describePatchYamlError(fake);
  assert.equal(safe, 'bad indentation of a mapping entry (3:5)');
  assert.equal(safe.includes('sk-live'), false, '不得把源码片段带出去');

  let real: unknown;
  try {
    loadPatchDocument('- id: a\n   x: [1,\n');
  } catch (err) {
    real = err;
  }
  assert.notEqual(real, undefined, '非法 YAML 必须抛错');
  const realSafe = describePatchYamlError(real);
  assert.equal(realSafe.includes('\n'), false, '真实解析错误的摘要同样只有一行: ' + realSafe);
  assert.ok(realSafe.length > 0);
});

/* ------------------------------ 跨大版本读回（issue #135） ------------------------------ */

/**
 * DSH 侧的读端：桌面版随包 js-yaml 4.3.2（`app.asar` 内的 `/dsh/node_modules/js-yaml`）。
 * 它装成 devDependency 别名 `js-yaml4`（运行时依赖仍只有 5.x 的 `js-yaml`）。
 *
 * 为什么必须真读 4.x：既有那条「写回保真」是 `load(dump(x))` 自环 —— 5.x 自己读自己恒等，
 * 于是「空标量 / 裸标量关键字」这类跨版本分歧在自环里根本看不见（#135 就是这么漏掉的）。
 * 而 DSH 才是这份文件的真实读者：它是 4.x，按 YAML 1.1 隐式解析。
 */
const JsExpr4 = new yaml4.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: String(data) }),
});
const DSH_READER_SCHEMA = yaml4.JSON_SCHEMA.extend([JsExpr4]);

/** 完全按 DSH 的口径读回一份 patch 文本。 */
function loadAsDsh(text: string): unknown {
  return yaml4.load(text, { schema: DSH_READER_SCHEMA });
}

/**
 * 会被 4.x 改判类型的字符串：空串 + YAML 1.1 的 null / 布尔 / 进制 / 浮点特例。
 *
 * 这是**回归样本**，不是完备性证明 —— 完备性来自 `forceQuotes` 对每个字符串值都生效
 * （见下一条「输出必须是带引号标量」的结构性断言）。清单实测来源：24 种串 × map/list
 * 共 48 处发散，判据与明细在 `docs/evidence/profiles-and-instances.md`。
 */
const AMBIGUOUS_STRINGS = [
  '',
  'Null',
  'NULL',
  '~',
  'True',
  'TRUE',
  'False',
  'FALSE',
  '007',
  '-007',
  '+7',
  '012',
  '-012',
  '+1',
  '0x10',
  '0x1F',
  '0o17',
  '0b101',
  '0b1010',
  '.5',
  '-.5',
  '.inf',
  '.Inf',
  '-.inf',
  '.nan',
  '.NaN',
];

test('#135 写回空字符串是显式空串，4.x 不会读成 null', () => {
  const text = dumpPatchDocument({ config: { constraints: '' } });
  assert.match(text, /constraints: (''|"")/, '空串必须带引号，实际输出:\n' + text);
  assert.deepEqual(loadAsDsh(text), { config: { constraints: '' } });
});

test('#135 每种歧义字符串在 map / list 两个位置都能被 4.x 读回（' + AMBIGUOUS_STRINGS.length * 2 + '/' + AMBIGUOUS_STRINGS.length * 2 + '）', () => {
  const inMap: Record<string, string> = {};
  const inList: Record<string, string[]> = {};
  AMBIGUOUS_STRINGS.forEach((value, index) => {
    inMap['k' + index] = value;
    inList['k' + index] = [value];
  });
  const total = AMBIGUOUS_STRINGS.length;
  assert.deepEqual(loadAsDsh(dumpPatchDocument(inMap)), inMap, `map 位置必须 ${total}/${total}`);
  assert.deepEqual(loadAsDsh(dumpPatchDocument(inList)), inList, `list 位置必须 ${total}/${total}`);
});

/**
 * 完备性断言（不依赖清单）：写出去的**每个字符串值**都必须是带引号标量。
 * 带引号的标量在任何 schema 下都是 string，这正是 forceQuotes 能盖住未知怪串的原因；
 * 一旦有人「优化掉引号」，这条先红 —— 与 4.x 清单无关。
 */
test('#135 输出里的字符串值一律是带引号标量（完备性不靠清单）', () => {
  const samples = [...AMBIGUOUS_STRINGS, 'hello', 'a b', 'x:y', '- z', '#tag', '@deepseek-ai/dsh-mcp-client', '  ', '多行\n第二行'];
  for (const value of samples) {
    const text = dumpPatchDocument({ k: value });
    assert.match(text, /^k: ['"]/, '字符串值必须带引号，实际: ' + JSON.stringify(value) + ' -> ' + JSON.stringify(text));
  }
});

test('#135 两个读端读到同一份值（行为锁定：dump 里不得留 4.x 歧义标量）', () => {
  const doc = {
    constraints: '',
    reserved: null,
    count: 3,
    enabled: true,
    pkg: '@deepseek-ai/dsh-mcp-client',
    spaced: ' ',
    wordIsNull: 'null',
    expr: { __jsExpr: '(function(){ return true })()' },
  };
  const text = dumpPatchDocument(doc);
  assert.deepEqual(loadAsDsh(text), loadPatchDocument(text), 'DSH 读到的值必须与插件读到的相同:\n' + text);
  assert.deepEqual(loadPatchDocument(text), doc, '5.x 侧仍要保真');
});

test('#135 forceQuotes 不改变 !!js：短标签与块标量照旧往返，4.x 侧同样读到 {__jsExpr}', () => {
  const doc = loadPatchDocument(SAMPLE);
  const text = dumpPatchDocument(doc);
  assert.ok(text.includes('!!js '), '短标签保留');
  assert.ok(text.includes('!!js |'), '块标量形态保持（带标签的标量不加引号）');
  assert.deepEqual(loadAsDsh(text), doc, '4.x 必须读到同样的 {__jsExpr}');
  assert.deepEqual(loadPatchDocument(text), doc);
});

/**
 * 已知识别缺口（**记录，不是达标**）：js-yaml 5 的 `forceQuotes` 只作用于**值**，键名不在范围内。
 * 于是数值样式的键名在 DSH 的 4.x 侧会被解析成数字/布尔/null 再被 JS 强制回字符串，键名变形。
 * 真机 patch 的键名都是插件名/配置字段名（普通标识符），不受影响；哪天 js-yaml 也给键加引号，
 * 这条会变红 —— 届时删掉它并更新 docs/evidence/profiles-and-instances.md 的相邻缺口一节。
 */
test('#135 已知缺口：键名不受 forceQuotes 保护（数值样式键名会被 4.x 改名）', () => {
  const text = dumpPatchDocument({ '012': 'v' });
  assert.equal(text, "012: 'v'\n", '当前行为：键名裸写（这是缺口，不是期望）');
  assert.deepEqual(loadAsDsh(text), { '12': 'v' }, '4.x 侧键名变形：012 -> 12');
});

/* ---------------------------------- 接线守卫（源码级） ---------------------------------- */

/**
 * 只把方言修进本模块不够：**用它解析 patch 文件的地方**也必须接线，否则换个入口
 * `!!js` 依旧被读成「空层」。这里做源码级断言（行为测试在 index.facade.test.ts）；
 * 与 incident-wiring.test.ts 同一手法 —— 守的是「接线是否存在」。
 */
test('接线守卫：patch 门面与 boot-safety 的 YAML 解析都必须走本方言', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const index = fs.readFileSync(root + 'src/index.ts', 'utf8');
  // #144 起「读既有 patch 文件」与「读整条生效链」下沉到 utils/patch-chain-read.ts（src/index.ts 触体量棘轮），
  // 方言接线随之搬家：两处载入都必须是 loadPatchDocument。
  const chainIo = fs.readFileSync(root + 'src/utils/patch-chain-read.ts', 'utf8');

  assert.ok(index.includes('doc = loadPatchDocument(text)'), 'readPatchLines 必须用方言载入');
  assert.ok(chainIo.includes('return loadPatchDocument(text)'), 'applyPatchChanges 的既有文件必须用方言载入');
  assert.ok(chainIo.includes("loadPatchDocument(await fs.readFile(resolve(homeDir, file), 'utf8'))"), '生效链各层必须用方言载入');
  assert.equal(chainIo.includes('yaml.load('), false, '生效链读取不得用裸 yaml.load');
  assert.match(index, /\+ dumpPatchDocument\((out|plan\.items)\)/, '写回 patch 文件必须用方言（yaml.dump 会把 {__jsExpr} 写成普通 map）');
  assert.match(
    index,
    /parseYaml:\s*\(text\)\s*=>\s*loadPatchDocument\(text\)/,
    'boot-safety 的 parseYaml 必须是方言：启动关键 yaml 含两层 cordis.patch.yml',
  );
  assert.equal(index.includes('yaml.dump('), false, 'src/index.ts 不得再用裸 yaml.dump 写 patch 文件');
});

/* ------------------------ 键名跨大版本守卫（issue #137） ------------------------ */

test('#137 空键名 → parse-fail（顶层 / 数组元素 / 嵌套 map 都要定位到）', () => {
  assert.deepEqual(findPatchKeyHazards({ '': 'v' }), [{ path: '', key: '', effect: 'parse-fail' }]);
  assert.deepEqual(findPatchKeyHazards({ items: [{ '': 'v' }] }), [{ path: 'items[0]', key: '', effect: 'parse-fail' }]);
  assert.deepEqual(findPatchKeyHazards({ config: { env: { '': 'v' } } }), [{ path: 'config.env', key: '', effect: 'parse-fail' }]);
});

test('#137 4.x 会改判的键名 → rename（全部实测命中）', () => {
  const keys = [
    '~', 'Null', 'NULL', 'True', 'TRUE', 'False', 'FALSE',
    '007', '-007', '+7', '012', '-012', '+1', '00', '000', '0007',
    '0x10', '0x1F', '0o17', '0b101', '0b1010',
    '.5', '.5e2', '00.5', '.inf', '.Inf', '.INF', '-.inf', '.nan', '.NaN', '.NAN',
  ];
  for (const key of keys) {
    assert.deepEqual(findPatchKeyHazards({ [key]: 'v' }), [{ path: '', key, effect: 'rename' }], '键 ' + JSON.stringify(key) + ' 必须命中');
  }
});

test('#137 安全键名一个都不许拦（误伤比漏拦更贵：用户改不动自己的配置）', () => {
  const safe = [
    'docs', 'a b', 'k:v', 'k#v', 'k #v', '@scope/pkg', '.cjs', 'yes', 'no', 'on', 'off',
    '1_000', '1:20', '12:34:56', '2020-01-01', '2020-01-01T00:00:00Z', '1.2', '1.2.3', '1.0', '0.',
    '0', '-0', '7', '-7', '80', '1e3', '1E3', '1.0e+3', '1.5E-3', 'e3', '1e',
    '0X10', '0O17', '0B101', '+.5', '-.5', '-0.5', 'Infinity', 'NaN', 'inf', 'nan',
    'null', 'true', 'false', '...', '...x',
  ];
  for (const key of safe) {
    assert.deepEqual(findPatchKeyHazards({ [key]: 'v' }), [], '键 ' + JSON.stringify(key) + ' 不该被拦');
  }
});

/**
 * 语料 = 手写边角 + 生成式数字形态。断言的是「检测器判据 === 真 4.x 判据」：
 * 只有两边完全一致，规则表（AMBIGUOUS_KEYS）才不会悄悄漂移成误伤或漏拦。
 */
const KEY_CORPUS: string[] = (() => {
  const keys = new Set<string>([
    '~', 'null', 'Null', 'NULL', 'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
    '...', '---', '--- x', '...x', 'docs', 'a b', 'k:v', 'k#v', 'k #v', '@scope/pkg', '.cjs',
    'yes', 'no', 'on', 'off', '1_000', '1:20', '12:34:56', '2020-01-01', '2020-01-01T00:00:00Z',
    '1.2', '1.2.3', '1.0', '0.', '0', '-0', '7', '-7', '80', '1e3', '1E3', '1.0e+3', '1.5E-3',
    '0X10', '0O17', '0B101', '+.5', '-.5', '-0.5', '+.5e2', 'Infinity', 'NaN', 'inf', 'nan', 'e3', '1e',
    ':', 'x:', ':x', 'x :y', '<x>', '[x]', '{x}', '&x', '*', '|', '1 2', 'a:b:c',
  ]);
  for (const body of ['7', '007', '012', '0x10', '0o17', '0b101', '.5', '00.5', '.5e2', '1.0', '1e3', '.inf', '.NaN']) {
    for (const sign of ['', '-', '+']) keys.add(sign + body);
  }
  // 空键名单独断言：4.x 的报错文案随位置变化，混进语料只会让失败信息更吵
  keys.delete('');
  return [...keys];
})();

test('#137 检测器判据与真 4.x 完全一致（' + KEY_CORPUS.length + ' 项语料，防规则表漂移）', () => {
  const mismatched: { key: string; realRisk: boolean; guarded: boolean }[] = [];
  for (const key of KEY_CORPUS) {
    const text = dumpPatchDocument({ [key]: 'v' });
    let realRisk: boolean;
    try {
      const read = loadAsDsh(text);
      const keys = read !== null && typeof read === 'object' ? Object.keys(read as Record<string, unknown>) : [];
      realRisk = keys.length !== 1 || keys[0] !== key;
    } catch {
      // 4.x 整份读不了：比改判更糟，同样算风险（空键名 / 文档分隔符形态）
      realRisk = true;
    }
    const guarded = findPatchKeyHazards({ [key]: 'v' }).length > 0;
    if (realRisk !== guarded) mismatched.push({ key, realRisk, guarded });
  }
  assert.deepEqual(mismatched, [], '检测器与 4.x 不一致的键：AMBIGUOUS_KEYS 需要更新');
});

test('#137 跳过 {__jsExpr} 子树，且不怕 YAML 锚点造出的环', () => {
  assert.deepEqual(findPatchKeyHazards({ a: [{ __jsExpr: '007' }] }), [], '{__jsExpr} 是我们的内存形态，不是用户键名');
  const cyclic: Record<string, unknown> = { ok: 'v' };
  cyclic['self'] = cyclic;
  assert.deepEqual(findPatchKeyHazards(cyclic), [], '环必须只走一次（否则守卫自己会爆栈）');
});
