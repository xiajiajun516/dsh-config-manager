/**
 * issue #39：`.credentials.yaml` 的解析口径（`collectCredentialRefs`）。
 *
 * 该函数是宿主导入路径（src/index.ts 的 tryDecryptCredentials）与同步引擎
 * （src/sync/snapshot-crypto.ts 的 credentialsMapFromYaml）**唯一**的解析实现。
 *
 * 修复前两处都只认「顶层字符串项」（DSH 预发布扁平布局）；DSH v1 把凭据值放在顶层
 * `refs:` 块下 → 整段被 `typeof v === 'string'` 过滤掉 → decryptedCredentials 为空
 * → 包里明明带着值却报「需人工重填」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as yaml from 'js-yaml';

import { collectCredentialRefs } from './credentials-yaml.ts';

/**
 * 与宿主/同步两处同款入口：yaml.load（解析失败兜底为空）→ 解析口径。
 * js-yaml 对空文档 / 纯注释输入直接抛「expected a document」→ 两处生产入口都 catch 成空 Map。
 */
function fromYaml(text: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch {
    return new Map<string, string>();
  }
  return collectCredentialRefs(parsed);
}

test('issue #39：v1 布局收 refs 块下的键值，忽略 records/payload 嵌套', () => {
  const map = fromYaml([
    'version: 1',
    'refs:',
    '  RJK66_API_KEY: sk-rjk66-value',
    '  DEEPSEEK_API_KEY: sk-deepseek-value',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: session-secret-value',
    '',
  ].join('\n'));
  assert.equal(map.size, 2, '只收 refs 块下的两个 key');
  assert.equal(map.get('RJK66_API_KEY'), 'sk-rjk66-value');
  assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-deepseek-value');
  assert.equal(map.has('records'), false, 'records 是嵌套结构，不是凭据 ref');
  assert.equal(map.has('client-connection/browser-session'), false);
  assert.equal(map.has('version'), false, 'version 是数字，不是凭据');
  assert.ok(![...map.values()].includes('session-secret-value'), '会话秘密不得混进凭据清单');
});

test('issue #39：预发布扁平布局（顶层键即 ref）仍然兼容', () => {
  const map = fromYaml('DEEPSEEK_API_KEY: sk-flat-value\nGITHUB_TOKEN: ghp_flat_value\n');
  assert.equal(map.size, 2);
  assert.equal(map.get('DEEPSEEK_API_KEY'), 'sk-flat-value');
  assert.equal(map.get('GITHUB_TOKEN'), 'ghp_flat_value');
});

test('issue #39：两种布局混排时取并集，同名以 refs 块为权威', () => {
  const map = fromYaml('LEGACY_KEY: legacy-value\nSHARED_KEY: flat-value\nversion: 1\nrefs:\n  SHARED_KEY: refs-value\n  V1_KEY: v1-value\n');
  assert.deepEqual([...map.entries()].sort(), [
    ['LEGACY_KEY', 'legacy-value'],
    ['SHARED_KEY', 'refs-value'],
    ['V1_KEY', 'v1-value'],
  ]);
});

test('issue #39：非字符串 / 空值一律丢弃（null、数字、布尔、嵌套对象、数组）', () => {
  const map = fromYaml([
    'EMPTY_KEY: ""',
    'NULL_KEY:',
    'NUMBER_KEY: 42',
    'BOOL_KEY: true',
    'OBJECT_KEY: { a: 1 }',
    'LIST_KEY: [a, b]',
    'refs:',
    '  EMPTY_REF: ""',
    '  NULL_REF:',
    '  NUMBER_REF: 7',
    '  OK_REF: real-value',
    '',
  ].join('\n'));
  assert.deepEqual([...map.keys()], ['OK_REF'], '只有非空字符串是真凭据值');
});

test('issue #39：顶层不是对象（空文档 / null / 数组 / 标量）→ 空 Map', () => {
  assert.equal(collectCredentialRefs(undefined).size, 0);
  assert.equal(collectCredentialRefs(null).size, 0);
  assert.equal(collectCredentialRefs([]).size, 0);
  assert.equal(collectCredentialRefs('sk-scalar').size, 0);
  assert.equal(fromYaml('').size, 0, '空文件 = 空凭据库（js-yaml 抛错 → 入口兜底为空 Map）');
  assert.equal(fromYaml('# 只有注释\n').size, 0);
});

test('issue #39：refs 块本身不是对象（数组 / null）→ 忽略该块，其余照收', () => {
  assert.equal(fromYaml('version: 1\nrefs: [a, b]\n').size, 0, '数组不是凭据映射');
  assert.equal(fromYaml('version: 1\nrefs: null\n').size, 0);
  const map = fromYaml('version: 1\nrefs: null\nTOP_KEY: top-value\n');
  assert.deepEqual([...map.entries()], [['TOP_KEY', 'top-value']]);
});

test('issue #39：扁平布局里名为 refs 的字符串键按普通 ref 处理（两种布局不可能同时成立）', () => {
  // 预发布扁平布局下 `refs` 只是一个普通 ref 名；v1 下它是对象块。字符串 → 前者，合法。
  assert.deepEqual([...fromYaml('version: 1\nrefs: nope\n').entries()], [['refs', 'nope']]);
});

test('issue #39：v1 文档 refs 块为空 → 空 Map（调用方据此告警，不静默写入）', () => {
  assert.equal(fromYaml('version: 1\nrefs: {}\nrecords: {}\n').size, 0);
});
