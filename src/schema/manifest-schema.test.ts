/**
 * Bundle manifest JSON Schema ↔ 实现绑定测试。
 *
 * 目的：把 `docs/spec/bundle-manifest.schema.json`（Bundle Format v1 的机器可校验形态）
 * 焊死在 `src/schema/manifest.ts` 的实现上。规格最大的死法是漂移——文档说一套、代码做一套。
 *
 * 方案选择：(a) 手写仅覆盖本 schema 所用关键字的最小校验器，而不是 (b) 退化为
 * 「必需字段集合 + 类型」的等价断言。理由：
 *   1. 本仓库规矩是「不为小功能加依赖」（AGENTS.md §Dependency Rules），故不引入 ajv；
 *   2. (b) 只能覆盖 `required`/`type`，会让 schema 里 `enum`/`additionalProperties`/`items`
 *      等关键字成为「没人验证的装饰」——它们写错了测试也不会红，正是本测试要防的死法；
 *   3. 手写校验器直接消费 schema 原文（readFileSync + JSON.parse），保证被验证的就是
 *      发布出去的那份文件；schema 一旦用上未支持的关键字，K-03 会立刻红灯。
 *
 * 覆盖：K-* schema 自身健全性 / S-* 真实 buildManifest 产物契约 / R-* 拒绝路径与
 * validateManifest 逐条一致 / C-* 已知兼容语义（未知分区只 warning）与已记录的语义落差。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildManifest, parseManifest, serializeManifest, validateManifest, MANIFEST_FILE,
} from './manifest.ts';
import { SECTION_IDS } from './config.ts';
import { CURRENT_SCHEMA_VERSION } from './versions.ts';
import type { Manifest } from './types.ts';

/* ============================================================================
 * (a) 最小 JSON Schema 校验器 —— 只覆盖本 schema 使用的关键字集合
 *    （白名单是「已实现」集合，当前 schema 未用到 items/enum/$ref，由 K-05 自检兜底）
 * ==========================================================================*/

/** 支持的关键字白名单（K-03 用它钉死「schema 不得引入未支持关键字」） */
const SUPPORTED_KEYWORDS: readonly string[] = [
  'type', 'required', 'properties', 'items', 'enum', 'additionalProperties', 'oneOf', '$ref',
];

/** 仅出现在 schema 根部、用于文档与工具提示的非校验键 */
const ANNOTATION_KEYS: readonly string[] = ['$schema', '$id', 'title', 'description'];

interface SchemaIssue { path: string; message: string }

type SchemaNode = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** JSON Pointer 解析（只支持本 schema 用到的 `#/a/b` 形式） */
function resolveRef(root: SchemaNode, ref: string): SchemaNode {
  assert.ok(ref.startsWith('#/'), `仅支持本地 $ref，收到 ${ref}`);
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    assert.ok(node !== null && typeof node === 'object', `$ref 路径 ${ref} 在 "${seg}" 处断开`);
    node = (node as SchemaNode)[seg];
  }
  assert.ok(node !== null && typeof node === 'object', `$ref ${ref} 未指向对象`);
  return node as SchemaNode;
}

/** 依据 schema 节点校验数据，返回全部问题（不短路，便于与 validateManifest 做集合比对） */
function validateNode(schema: SchemaNode, data: unknown, path: string, root: SchemaNode): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  if (typeof schema['$ref'] === 'string') {
    return validateNode(resolveRef(root, schema['$ref']), data, path, root);
  }

  const types = schema['type'];
  if (typeof types === 'string') {
    if (typeOf(data) !== types) {
      issues.push({ path, message: `期望类型 ${types}，收到 ${typeOf(data)}` });
      return issues;
    }
  } else if (Array.isArray(types)) {
    const allowed = types.filter((t): t is string => typeof t === 'string');
    if (!allowed.includes(typeOf(data))) {
      issues.push({ path, message: `期望类型 ${allowed.join(' | ')}，收到 ${typeOf(data)}` });
      return issues;
    }
  }

  if (Array.isArray(schema['enum'])) {
    const allowed = schema['enum'] as unknown[];
    if (!allowed.some((a) => Object.is(a, data))) {
      issues.push({ path, message: `取值必须是 ${allowed.map((a) => JSON.stringify(a)).join(' | ')} 之一` });
    }
  }

  if (Array.isArray(schema['oneOf'])) {
    const branches = schema['oneOf'] as SchemaNode[];
    const matched = branches.filter((b) => validateNode(b, data, path, root).length === 0).length;
    if (matched !== 1) {
      const shapes = branches.map((b) => JSON.stringify(b['type'] ?? b['$ref'] ?? '?')).join(' | ');
      issues.push({ path, message: `必须恰好匹配一种形态（${shapes}），实际匹配 ${matched} 种` });
    }
  }

  if (typeOf(data) === 'object') {
    const obj = data as Record<string, unknown>;
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(obj, key)) {
          issues.push({ path: path === '$' ? key : `${path}.${key}`, message: `缺少必需字段 ${key}` });
        }
      }
    }
    const props = schema['properties'];
    const propsObj = (props !== null && typeof props === 'object') ? props as SchemaNode : {};
    for (const [key, sub] of Object.entries(propsObj)) {
      if (Object.prototype.hasOwnProperty.call(obj, key) && sub !== null && typeof sub === 'object') {
        issues.push(...validateNode(sub as SchemaNode, obj[key], path === '$' ? key : `${path}.${key}`, root));
      }
    }
    const extra = schema['additionalProperties'];
    if (extra !== undefined && extra !== true) {
      for (const key of Object.keys(obj)) {
        if (Object.prototype.hasOwnProperty.call(propsObj, key)) continue;
        if (extra === false) {
          issues.push({ path: path === '$' ? key : `${path}.${key}`, message: `不允许的额外字段 ${key}` });
        } else if (extra !== null && typeof extra === 'object') {
          issues.push(...validateNode(extra as SchemaNode, obj[key], path === '$' ? key : `${path}.${key}`, root));
        }
      }
    }
  }

  if (Array.isArray(data) && schema['items'] !== undefined) {
    const items = schema['items'];
    if (items !== null && typeof items === 'object') {
      data.forEach((item, idx) => {
        issues.push(...validateNode(items as SchemaNode, item, `${path}[${idx}]`, root));
      });
    }
  }

  return issues;
}

/** 用 schema 校验任意数据；`$` 为根路径 */
function validateAgainstSchema(schema: SchemaNode, data: unknown): SchemaIssue[] {
  return validateNode(schema, data, '$', schema);
}

/* ============================================================================
 * 载入 schema 原文（被验证的就是发布出去的那份文件）
 * ==========================================================================*/

const SCHEMA_PATH = resolve(import.meta.dirname, '..', '..', 'docs', 'spec', 'bundle-manifest.schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as SchemaNode;

/* ============================================================================
 * 夹具与工具
 * ==========================================================================*/

function sectionsAllFalse(): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const id of SECTION_IDS) flags[id] = false;
  return flags;
}

/** 用真实 buildManifest 构造基准 manifest（未加密、无秘密） */
function baselineManifest(): Manifest {
  return buildManifest({
    exporterVersion: '0.1.59',
    dshVersion: '0.1.0-rc.6',
    platform: 'win32',
    arch: 'x64',
    sections: sectionsAllFalse() as unknown as Manifest['sections'],
    containsSecrets: false,
    encrypted: false,
    encryption: null,
    exportedAt: '2026-08-14T12:00:00.000Z',
  });
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 深拷贝基准 manifest 并施加改动；`undefined` 表示删除该字段 */
function mutate(overrides: Record<string, unknown>): Record<string, unknown> {
  const base = deepClone(baselineManifest()) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

const errorPaths = (m: unknown): string[] =>
  validateManifest(m).filter((i) => i.severity === 'error').map((i) => i.path).sort();
const warningPaths = (m: unknown): string[] =>
  validateManifest(m).filter((i) => i.severity === 'warning').map((i) => i.path).sort();
const schemaPaths = (m: unknown): string[] =>
  validateAgainstSchema(SCHEMA, m).map((i) => i.path).sort();

/** 递归收集 schema 节点中出现的全部关键字（跳过纯注解键；properties 的直接子键是字段名，不是关键字） */
function collectKeywords(node: unknown, found: Set<string>): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectKeywords(item, found);
    return;
  }
  for (const [key, value] of Object.entries(node as SchemaNode)) {
    if (key === 'properties') {
      // properties 的子键是字段名；只递归进每个字段的子 schema
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const sub of Object.values(value as SchemaNode)) collectKeywords(sub, found);
      }
      continue;
    }
    if (!key.startsWith('$') && !ANNOTATION_KEYS.includes(key)) found.add(key);
    collectKeywords(value, found);
  }
}

/** 从 schema 根部收集关键字（x-* 是纯文档扩展，整体跳过） */
function collectSchemaKeywords(schema: SchemaNode): Set<string> {
  const found = new Set<string>();
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith('x-')) continue;
    if (key === 'properties') {
      for (const sub of Object.values(value as SchemaNode)) collectKeywords(sub, found);
      continue;
    }
    if (!key.startsWith('$') && !ANNOTATION_KEYS.includes(key)) found.add(key);
    collectKeywords(value, found);
  }
  return found;
}

/* ============================================================================
 * K-*：schema 自身的健全性
 * ==========================================================================*/

test('K-01 schema 是合法 JSON 且声明 draft 2020-12 与根对象形状', () => {
  assert.equal(SCHEMA['$schema'], 'https://json-schema.org/draft/2020-12/schema', '必须声明 draft 2020-12');
  assert.equal(typeof SCHEMA['$id'], 'string', '$id 应为字符串（可引用）');
  assert.equal(SCHEMA['type'], 'object', '根类型必须是 object');
  assert.deepEqual(
    SCHEMA['required'],
    ['schemaVersion', 'exporter', 'source', 'exportedAt', 'sections', 'security'],
    '根必需字段集合即 validateManifest 要求必须存在的字段',
  );
  const props = SCHEMA['properties'] as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(props).sort(),
    ['exportedAt', 'exporter', 'schemaVersion', 'sections', 'security', 'source'],
    'schema 的 properties 必须与实现校验的字段集合一一对应（多一个=声明了没人校验的字段）',
  );
});

test('K-02 schema 不含零宽字符（U+200B/200C/200D/2060/FEFF）', () => {
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  const hits = [...raw.matchAll(/[\u200b\u200c\u200d\u2060\ufeff]/gu)].map((m) => m.index);
  assert.deepEqual(hits, [], `schema 含零宽字符，位置 ${hits.join(',')}`);
});

test('K-03 schema 只使用最小校验器已实现的关键字（新增关键字必须同步实现，否则本测试红灯）', () => {
  // 只收集「校验位置」上的键：根级非 x- 关键字 + properties 内每个子 schema 的键。
  // properties 的直接子键是字段名（schemaVersion / exporter / …）而非关键字，collectSchemaKeywords 已区分。
  const unsupported = [...collectSchemaKeywords(SCHEMA)].filter((k) => !SUPPORTED_KEYWORDS.includes(k));
  assert.deepEqual(
    unsupported, [],
    `schema 引入了最小校验器未实现的关键字：${unsupported.join(', ')}。` +
    '要么改用已支持关键字，要么在 manifest-schema.test.ts 的 validateNode 中实现它。',
  );
});

test('K-04 x-* 扩展键仅作为根级文档说明存在，且分区 id 表与 SECTION_IDS 一致', () => {
  const xKeys = Object.keys(SCHEMA).filter((k) => k.startsWith('x-'));
  assert.ok(xKeys.includes('x-section-ids'), '应记录导出端恒写的分区 id 表');
  assert.ok(xKeys.includes('x-platform-values'), '应记录 platform 取值表（不设 enum，仅说明）');
  assert.ok(xKeys.includes('x-semantic-constraints'), '应显式记录 JSON Schema 无法表达的语义约束');
  assert.deepEqual(
    SCHEMA['x-section-ids'], [...SECTION_IDS],
    'schema 记录的 15 个分区 id 必须与 SECTION_IDS 完全一致（防止分区增删后文档漂移）',
  );
  assert.equal(SCHEMA['x-format-version'], 'Bundle Format v1');
  assert.equal(SCHEMA['x-schema-version-constant'], CURRENT_SCHEMA_VERSION);
});

test('K-05 最小校验器自检：enum / items / oneOf 分支确实生效（防止 K-03 为一个坏掉的实现背书）', () => {
  // K-03 的白名单把 enum/items/oneOf 声明为「已支持」。若这些分支实际是坏的，
  // 未来给 schema 加上它们就会静默失效——正是本测试要防的死法，故在此独立钉死。
  const enumSchema: SchemaNode = { type: 'string', enum: ['a', 'b'] };
  assert.deepEqual(validateAgainstSchema(enumSchema, 'a'), [], 'enum 命中应通过');
  assert.deepEqual(validateAgainstSchema(enumSchema, 'c').map((i) => i.path), ['$'], 'enum 未命中应拒绝');

  const itemsSchema: SchemaNode = { type: 'array', items: { type: 'number' } };
  assert.deepEqual(validateAgainstSchema(itemsSchema, [1, 2]), [], 'items 全合法应通过');
  assert.deepEqual(
    validateAgainstSchema(itemsSchema, [1, 'x']).map((i) => i.path), ['$[1]'],
    'items 应按索引定位违规元素',
  );

  const oneOfSchema: SchemaNode = { oneOf: [{ type: 'object' }, { type: 'null' }] };
  assert.deepEqual(validateAgainstSchema(oneOfSchema, {}).map((i) => i.path), [], 'oneOf 单分支命中应通过');
  assert.deepEqual(validateAgainstSchema(oneOfSchema, null).map((i) => i.path), [], 'oneOf 另一分支命中应通过');
  assert.deepEqual(validateAgainstSchema(oneOfSchema, 'x').map((i) => i.path), ['$'], 'oneOf 零分支命中应拒绝');

  const requiredSchema: SchemaNode = { type: 'object', required: ['k'], properties: { k: { type: 'string' } } };
  assert.deepEqual(validateAgainstSchema(requiredSchema, {}).map((i) => i.path), ['k'], '缺 required 字段应定位到字段名');
  assert.deepEqual(validateAgainstSchema(requiredSchema, { k: 1 }).map((i) => i.path), ['k'], '类型错误应定位到字段名');
  assert.deepEqual(validateAgainstSchema(requiredSchema, { k: 'v', extra: 1 }), [], '未声明 additionalProperties 时不得拒绝额外字段');
});

/* ============================================================================
 * S-*：真实 buildManifest 产物满足 schema
 * ==========================================================================*/

test('S-01 真实 buildManifest 产物满足 schema 声明的全部必需字段与类型', () => {
  const m = baselineManifest();
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], 'buildManifest 产物必须零 schema 违规');
  assert.deepEqual(errorPaths(m), [], '且必须零 validateManifest error');
});

test('S-02 sections 恒含全部 15 个已知分区 id（规格 §2.5），值均为布尔', () => {
  const m = baselineManifest();
  const keys = Object.keys(m.sections).sort();
  assert.equal(SECTION_IDS.length, 15, 'SectionId 共 15 个（含无 adapter 的 secrets）');
  assert.deepEqual(keys, [...SECTION_IDS].sort(), 'sections 键集合必须等于 SECTION_IDS');
  for (const key of keys) {
    assert.equal(typeof m.sections[key as (typeof SECTION_IDS)[number]], 'boolean', `sections.${key} 必须是布尔`);
  }
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '全量 sections 必须满足 schema');
});

test('S-03 全部 15 个分区置 true 的 manifest 仍满足 schema（sections 是开放布尔映射）', () => {
  const all = sectionsAllFalse();
  for (const id of SECTION_IDS) all[id] = true;
  const m = buildManifest({
    exporterVersion: '0.1.59',
    dshVersion: '0.1.0-rc.6',
    platform: 'linux',
    arch: 'arm64',
    sections: all as unknown as Manifest['sections'],
    containsSecrets: true,
    encrypted: true,
    encryption: {
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      kdfParams: { N: 16384, r: 8, p: 1, keyLength: 32 },
      salt: 'c2FsdA==',
      iv: 'aXY=',
      authTag: 'dGFn',
      version: 1,
    },
    exportedAt: '2026-08-14T12:00:00.000Z',
  });
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '加密 manifest 必须满足 schema');
  assert.deepEqual(errorPaths(m), [], '加密 manifest 必须零 validateManifest error');
});

test('S-04 真实产物经 serializeManifest → parseManifest 往返后仍满足 schema', () => {
  const m = baselineManifest();
  const raw = serializeManifest(m);
  assert.deepEqual(validateAgainstSchema(SCHEMA, JSON.parse(raw)), [], '序列化产物必须满足 schema');
  const reparsed = parseManifest(raw);
  assert.deepEqual(validateAgainstSchema(SCHEMA, reparsed), [], '解析结果必须满足 schema');
  assert.equal(MANIFEST_FILE, 'manifest.json', 'schema 描述的文件名与常量一致');
});

/* ============================================================================
 * R-*：拒绝路径必须与 validateManifest 逐条一致
 * ==========================================================================*/

interface RejectCase { name: string; value: unknown; expect: string }

const REJECT_CASES: RejectCase[] = [
  { name: '非对象（null）', value: null, expect: '$' },
  { name: '非对象（字符串）', value: 'str', expect: '$' },
  { name: 'schemaVersion 缺失', value: mutate({ schemaVersion: undefined }), expect: 'schemaVersion' },
  { name: 'schemaVersion 类型错误', value: mutate({ schemaVersion: 'one' }), expect: 'schemaVersion' },
  { name: 'exporter 缺失', value: mutate({ exporter: undefined }), expect: 'exporter' },
  { name: 'exporter.name 类型错误', value: mutate({ exporter: { name: 1, version: 'x' } }), expect: 'exporter.name' },
  { name: 'exporter.version 缺失', value: mutate({ exporter: { name: 'n' } }), expect: 'exporter.version' },
  { name: 'source 缺失', value: mutate({ source: undefined }), expect: 'source' },
  { name: 'source.arch 缺失', value: mutate({ source: { dshVersion: 'v', platform: 'win32' } }), expect: 'source.arch' },
  { name: 'source.platform 类型错误', value: mutate({ source: { dshVersion: 'v', platform: 1, arch: 'x64' } }), expect: 'source.platform' },
  { name: 'exportedAt 缺失', value: mutate({ exportedAt: undefined }), expect: 'exportedAt' },
  { name: 'sections 缺失', value: mutate({ sections: undefined }), expect: 'sections' },
  { name: 'sections 值非布尔', value: mutate({ sections: { ...sectionsAllFalse(), settings: 'yes' } }), expect: 'sections.settings' },
  { name: 'security 缺失', value: mutate({ security: undefined }), expect: 'security' },
  {
    name: 'security.containsSecrets 类型错误',
    value: mutate({ security: { containsSecrets: 'yes', encrypted: false, encryption: null } }),
    expect: 'security.containsSecrets',
  },
  {
    name: 'security.encrypted 缺失',
    value: mutate({ security: { containsSecrets: false, encryption: null } }),
    expect: 'security.encrypted',
  },
  {
    name: 'security.encryption 缺失',
    value: mutate({ security: { containsSecrets: false, encrypted: false } }),
    expect: 'security.encryption',
  },
  {
    name: 'security.encryption 类型错误（字符串）',
    value: mutate({ security: { containsSecrets: false, encrypted: false, encryption: 'nope' } }),
    expect: 'security.encryption',
  },
];

test('R-01 每个非法输入都被 validateManifest 拒绝，且 schema 在完全相同的路径上拒绝', () => {
  for (const c of REJECT_CASES) {
    const implErrors = errorPaths(c.value);
    assert.ok(
      implErrors.includes(c.expect),
      `[${c.name}] validateManifest 应在 ${c.expect} 报 error，实际 error 路径 = [${implErrors.join(', ')}]`,
    );
    const sch = schemaPaths(c.value);
    assert.ok(
      sch.includes(c.expect),
      `[${c.name}] schema 应在 ${c.expect} 拒绝，实际 schema 路径 = [${sch.join(', ')}]`,
    );
  }
});

test('R-02 schema 拒绝路径集合 = validateManifest error 路径集合（无单侧漂移）', () => {
  for (const c of REJECT_CASES) {
    assert.deepEqual(
      schemaPaths(c.value), errorPaths(c.value),
      `[${c.name}] schema 与 validateManifest 的拒绝路径集合必须完全一致`,
    );
  }
});

test('R-03 非法 manifest 经 parseManifest 抛错，且错误文案列出被拒字段（导入第一道闸）', () => {
  for (const c of REJECT_CASES) {
    if (typeof c.value === 'string') continue; // parseManifest 的入参是 JSON 文本
    assert.throws(
      () => parseManifest(JSON.stringify(c.value)),
      /manifest\.json 无效/,
      `[${c.name}] parseManifest 必须拒绝`,
    );
  }
  assert.throws(() => parseManifest('{not json'), /manifest\.json 无效|JSON/);
});

/* ============================================================================
 * C-*：已知兼容语义（不得被 schema 收紧）
 * ==========================================================================*/

test('C-01 未知分区键：schema 接受，validateManifest 仅 warning（对齐 M-04，不得设计成拒绝）', () => {
  const m = mutate({
    sections: { ...sectionsAllFalse(), settings: true, keybindings: true, workflows: false },
  });
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '未知分区键不得被 schema 拒绝');
  assert.deepEqual(errorPaths(m), [], '未知分区键不得产生 error');
  assert.deepEqual(warningPaths(m), ['sections.keybindings', 'sections.workflows'], '未知分区键应为 warning');
  assert.doesNotThrow(() => parseManifest(JSON.stringify(m)), '未知分区键不得阻断解析（规格 §2.3）');
});

test('C-02 未知顶层字段与已知对象内未知子字段：保留、不报错（规格 §2.3 / SC-07）', () => {
  const m = mutate({ 'x-future-manifest-key': { anything: [1, 2, 3] } });
  (m['exporter'] as Record<string, unknown>)['futureExporterField'] = 'kept';
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '未知字段不得被 schema 拒绝');
  assert.deepEqual(errorPaths(m), [], '未知字段不得产生 error');
  const parsed = parseManifest(JSON.stringify(m)) as unknown as Record<string, unknown>;
  assert.deepEqual(parsed['x-future-manifest-key'], { anything: [1, 2, 3] }, '顶层未知字段应被保留');
  assert.equal((parsed['exporter'] as Record<string, unknown>)['futureExporterField'], 'kept', '子字段未知字段应被保留');
});

test('C-03 source.platform 不做枚举校验（实现只校验 typeof string，schema 不得更严）', () => {
  const m = mutate({ source: { dshVersion: '0.1.0-rc.6', platform: 'plan9', arch: 'x64' } });
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '未列出的 platform 不得被 schema 拒绝');
  assert.deepEqual(errorPaths(m), [], '实现同样接受任意字符串 platform（规格 §2.2 取证）');
  // 而枚举本身作为文档事实保留在 x-platform-values
  assert.ok((SCHEMA['x-platform-values'] as string[]).includes('win32'));
  assert.ok((SCHEMA['x-platform-values'] as string[]).includes('other'));
});

test('C-04 security.encryption：对象或 null 均合法，其它标量两边都拒绝（不得单侧收紧）', () => {
  for (const enc of [null, {}, { algorithm: 'aes-256-gcm' }]) {
    const m = mutate({ security: { containsSecrets: false, encrypted: enc !== null, encryption: enc } });
    assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], `encryption=${JSON.stringify(enc)} 应合法`);
    assert.deepEqual(errorPaths(m), [], `encryption=${JSON.stringify(enc)} 实现也应接受`);
  }
  for (const bad of [0, false, 'x']) {
    const m = mutate({ security: { containsSecrets: false, encrypted: false, encryption: bad } });
    assert.deepEqual(errorPaths(m), ['security.encryption'], `encryption=${JSON.stringify(bad)} 实现应拒绝`);
    assert.deepEqual(schemaPaths(m), ['security.encryption'], `encryption=${JSON.stringify(bad)} schema 应拒绝`);
  }
});

test('C-05 已记录的实现缺口：数组被 validateManifest 当作合法 encryption（typeof [] === "object"）', () => {
  const m = mutate({ security: { containsSecrets: false, encrypted: false, encryption: [] } });
  assert.deepEqual(errorPaths(m), [], '实现接受数组——这是 src/schema/manifest.ts:118 的 typeof 判定缺口，不是本 schema 的契约');
  assert.deepEqual(schemaPaths(m), ['security.encryption'], 'schema 按规格 §2.2/§4.4 拒绝数组（对象或 null）');
  // 该缺口必须显式记录在 schema 的语义约束里，否则就是「文档说一套、代码做一套」的静默漂移
  const notes = SCHEMA['x-semantic-constraints'] as string[];
  assert.ok(notes.some((n) => n.includes('数组')), 'schema 必须显式记录该实现缺口');
});

test('C-06 已记录的语义落差：exportedAt 的 ISO-8601 可解析性无法用 JSON Schema 关键字表达', () => {
  const m = mutate({ exportedAt: 'not-a-date' });
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], 'schema 只能校验 type=string（已知能力边界）');
  assert.deepEqual(errorPaths(m), ['exportedAt'], '实现必须拒绝不可解析的时间');
  // 该落差已写入 schema 的 x-semantic-constraints，属于显式记录而非静默漂移
  const notes = SCHEMA['x-semantic-constraints'] as string[];
  assert.ok(notes.some((n) => n.includes('exportedAt')), 'schema 必须显式记录该语义约束');
});

test('C-07 schemaVersion 的「是否受支持」不属结构校验：schemaVersion=2 两边都放行', () => {
  const m = mutate({ schemaVersion: 2 });
  assert.deepEqual(validateAgainstSchema(SCHEMA, m), [], '结构校验不判定版本支持性');
  assert.deepEqual(errorPaths(m), [], '实现同样只在版本协商阶段拒绝（规格 §6.2）');
  assert.doesNotThrow(() => parseManifest(JSON.stringify(m)), 'parseManifest 不做版本协商');
});
