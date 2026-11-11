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

import { describePatchYamlError, dumpPatchDocument, isPatchJsExpr, loadPatchDocument } from './patch-yaml.ts';

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

/* ---------------------------------- 接线守卫（源码级） ---------------------------------- */

/**
 * 只把方言修进本模块不够：**用它解析 patch 文件的地方**也必须接线，否则换个入口
 * `!!js` 依旧被读成「空层」。这里做源码级断言（行为测试在 index.facade.test.ts）；
 * 与 incident-wiring.test.ts 同一手法 —— 守的是「接线是否存在」。
 */
test('接线守卫：patch 门面与 boot-safety 的 YAML 解析都必须走本方言', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const index = fs.readFileSync(root + 'src/index.ts', 'utf8');

  assert.ok(index.includes('doc = loadPatchDocument(text)'), 'readPatchLines 必须用方言载入');
  assert.ok(index.includes('doc = loadPatchDocument(existing)'), 'applyPatchChanges 必须用方言载入既有文件');
  assert.match(index, /\+ dumpPatchDocument\((out|plan\.items)\)/, '写回 patch 文件必须用方言（yaml.dump 会把 {__jsExpr} 写成普通 map）');
  assert.match(
    index,
    /parseYaml:\s*\(text\)\s*=>\s*loadPatchDocument\(text\)/,
    'boot-safety 的 parseYaml 必须是方言：启动关键 yaml 含两层 cordis.patch.yml',
  );
  assert.equal(index.includes('yaml.dump('), false, 'src/index.ts 不得再用裸 yaml.dump 写 patch 文件');
});
