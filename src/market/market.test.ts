/**
 * m-market 单元测试。
 * 覆盖：解析（L1/L2）、安全校验、只读 reader、市场配置持久化、纯渲染模型。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { zipToBuffer, DEFAULT_ZIP_SAFETY_LIMITS, type ZipWriteEntry } from '../utils/zip.ts';
import { sha256Hex } from '../utils/hashing.ts';
import type { SnapshotFs } from '../sync/fs.ts';
import { validateRepoUrl } from '../sync/sync-config.ts';
import { parseMarketIndex, parseMarketItemManifest } from './index-parser.ts';
import { validateMarketItem } from './security.ts';
import { prepareMarketItem } from './prepare.ts';
import { GitMarketReader } from './reader.ts';
import {
  addMarket, emptyMarketConfig, readMarketConfig, removeMarket, writeMarketConfig,
} from './market-config.ts';
import {
  computeItemBadge, marketItemWarnings, marketListSummary, marketStatusText, needsReview,
} from './view.ts';
import { zhUiT } from '../ui/i18n.ts';

/* ---------------- fixtures ---------------- */

/** 构造一个合法的 Export config.zip（settings 分区），返回字节。 */
function makeValidZip(): Uint8Array {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} }, null, 2);
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
  ];
  const checksums = { 'config/settings.json': sha256Hex(Buffer.from(settingsJson)) };
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify(checksums)) });
  const manifest = {
    schemaVersion: 1,
    exporter: { name: 'DSH Config Manager', version: 'test' },
    source: { dshVersion: '1.0.0', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(),
    sections: { settings: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  return Buffer.from(zipToBuffer(entries));
}

/** 构造合法 L2 manifest，sections 对齐 zip。 */
function makeItemManifest(id: string, zip: Uint8Array, sections = ['settings']): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: 'Test Item',
    version: '1.0.0',
    sections,
    checksums: { zip: sha256Hex(zip) },
  });
}

/* ---------------- 解析（L1/L2） ---------------- */

test('解析：合法 index.json', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    name: 'My Market',
    items: [{ id: 'hello-world', name: 'Hello World', version: '1.0' }],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.index?.items.length, 1);
  assert.equal(res.index?.items[0]?.id, 'hello-world');
});

test('解析：未知字段拒绝（不忽略）', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    items: [{ id: 'a', name: 'A', extraField: 'x' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /未知字段/);
});

test('解析：schemaVersion 不符拒绝', () => {
  const res = parseMarketIndex(JSON.stringify({ schemaVersion: 2, items: [] }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /schemaVersion/);
});

test('解析：id 越界字符拒绝', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    items: [{ id: '../evil', name: 'Evil' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /id/);
});

test('解析：条目 repo 合法 → 保留并透出（来源仓库路由依据）', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    items: [{ id: 'a', name: 'A', repo: 'https://github.com/x/items.git' }],
  }));
  assert.equal(res.ok, true);
  assert.equal(res.index?.items.length, 1);
  assert.equal(res.index?.items[0]?.repo, 'https://github.com/x/items.git');
});

test('解析：条目 repo 非法 → 仅丢弃该条目，不整体拒绝 index', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    items: [
      { id: 'good', name: 'Good' },
      { id: 'bad-userinfo', name: 'Bad', repo: 'https://user:token@github.com/x' },
      { id: 'bad-whitespace', name: 'Bad2', repo: 'https://github.com/x/a b.git' },
      { id: 'bad-ssh', name: 'Bad3', repo: 'git@github.com:xiaojun/items.git' },
      { id: 'bad-type', name: 'Bad4', repo: 123 },
    ],
  }));
  assert.equal(res.ok, true, '非法 repo 条目不应弄垮整个 index');
  assert.equal(res.index?.items.length, 1, '仅保留合法条目');
  assert.equal(res.index?.items[0]?.id, 'good');
  assert.equal(res.dropped, 4, '丢弃计数透出（含 git@/ssh 形态拒绝）');
});

test('解析：未知字段拒绝仍然整体拒绝（repo 白名单之外不变式保持）', () => {
  const res = parseMarketIndex(JSON.stringify({
    schemaVersion: 1,
    items: [{ id: 'a', name: 'A', repo: 'https://github.com/x/items.git', evil: 'x' }],
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /未知字段/);
});

test('解析：L2 manifest 合法', () => {
  const res = parseMarketItemManifest(makeItemManifest('foo', makeValidZip()));
  assert.equal(res.ok, true);
  assert.equal(res.manifest?.id, 'foo');
  assert.deepEqual(res.manifest?.sections, ['settings']);
});

test('解析：L2 manifest 未知分区拒绝', () => {
  const res = parseMarketItemManifest(JSON.stringify({
    schemaVersion: 1, id: 'foo', name: 'n', version: '1',
    sections: ['not-a-section'], checksums: { zip: 'aaa' },
  }));
  assert.equal(res.ok, false);
});

/**
 * P0 回归：share 模式发布契约漂移。
 * prepare 在 share 模式把 `mode: 'share'` 写进 L2 manifest（prepare.ts），
 * 而消费侧 MANIFEST_ALLOWED 曾不含 mode → 解析 ok:false「含未知字段: mode」，
 * 于是上传侧抛 internal、市场端把分享条目判 invalid。
 * 本用例用**真实 prepare 产物**（不是 stub）走完「发布 → 解析 → 消费侧校验」全链路。
 */
test('round-trip：share 模式真实 prepare 产物必须被解析器与消费侧接受（契约漂移回归）', () => {
  const zip = makeValidZip();
  const prepared = prepareMarketItem({ itemId: 'share-one', name: 'Share One', mode: 'share', zipBytes: zip });
  const manifestObj = JSON.parse(prepared.manifestText) as Record<string, unknown>;
  assert.equal(manifestObj['mode'], 'share', '前置条件：prepare 在 share 模式必须落 mode 标记');

  const parsed = parseMarketItemManifest(prepared.manifestText);
  assert.equal(parsed.ok, true, `prepare 产物必须可被自家解析器接受，errors=${parsed.errors.join('; ')}`);
  assert.equal(parsed.manifest?.mode, 'share', 'mode 应被解析器透出（消费侧可见发布模式）');

  const validated = validateMarketItem('share-one', prepared.manifestText, zip);
  assert.equal(validated.status, 'valid', `分享条目在市场端必须 valid，errors=${validated.errors.join('; ')}`);
  assert.equal(validated.manifest?.mode, 'share');
});

test('round-trip：migrate 模式（不含 mode）既有行为不变', () => {
  const zip = makeValidZip();
  const prepared = prepareMarketItem({ itemId: 'migrate-one', name: 'Migrate One', zipBytes: zip });
  assert.equal('mode' in (JSON.parse(prepared.manifestText) as Record<string, unknown>), false, 'migrate 缺省不写 mode');

  const parsed = parseMarketItemManifest(prepared.manifestText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.manifest?.mode, undefined, '无 mode 时不应凭空造出该字段');
  assert.equal(validateMarketItem('migrate-one', prepared.manifestText, zip).status, 'valid');
});

test('解析：L2 manifest mode 取值非法 → 进入 errors 并拒绝（只接受 migrate | share）', () => {
  for (const bad of ['evil', 'SHARE', '', 1, null, {}]) {
    const res = parseMarketItemManifest(JSON.stringify({
      schemaVersion: 1, id: 'foo', name: 'n', version: '1',
      sections: ['settings'], checksums: { zip: 'aaa' }, mode: bad,
    }));
    assert.equal(res.ok, false, `mode=${JSON.stringify(bad)} 必须被拒绝`);
    assert.match(res.errors.join(), /mode/, `mode=${JSON.stringify(bad)} 的错误必须点名 mode`);
  }
  // 合法取值放行
  for (const good of ['migrate', 'share']) {
    const res = parseMarketItemManifest(JSON.stringify({
      schemaVersion: 1, id: 'foo', name: 'n', version: '1',
      sections: ['settings'], checksums: { zip: 'aaa' }, mode: good,
    }));
    assert.equal(res.ok, true, `mode=${good} 必须放行`);
    assert.equal(res.manifest?.mode, good);
  }
});

test('解析：L2 manifest 未知字段仍整体拒绝（mode 白名单不得放宽其它字段）', () => {
  const res = parseMarketItemManifest(JSON.stringify({
    schemaVersion: 1, id: 'foo', name: 'n', version: '1',
    sections: ['settings'], checksums: { zip: 'aaa' }, mode: 'share', evil: 'x',
  }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(), /未知字段/);
});

/**
 * 回归：author / description / updatedAt / categories 的类型校验此前位于
 * `if (errors.length > 0) return ...` **之后**（它们在返回对象字面量里调用），
 * errors 恒为空 → optString / optStringArray 推入的错误被静默丢弃，
 * `author: 123` 这类非法类型被当成「字段不存在」接受。
 */
test('解析：L2 manifest 可选字段类型非法 → 进入 errors 并拒绝（此前被静默接受）', () => {
  const base = { schemaVersion: 1, id: 'foo', name: 'n', version: '1', sections: ['settings'], checksums: { zip: 'aaa' } };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['author', { author: 123 }],
    ['author', { author: null }],
    ['description', { description: 5 }],
    ['updatedAt', { updatedAt: {} }],
    ['categories', { categories: 'nope' }],
    ['categories', { categories: ['ok', 1] }],
  ];
  for (const [field, extra] of cases) {
    const res = parseMarketItemManifest(JSON.stringify({ ...base, ...extra }));
    assert.equal(res.ok, false, `${field}=${JSON.stringify(extra[field])} 必须被拒绝`);
    assert.match(res.errors.join(), new RegExp(field), `错误必须点名 ${field}`);
  }
  // 多字段同时非法 → 全部进入 errors（不因首个错误短路）
  const multi = parseMarketItemManifest(JSON.stringify({ ...base, author: 1, description: 2, updatedAt: 3, categories: 4 }));
  assert.equal(multi.ok, false);
  for (const f of ['author', 'description', 'updatedAt', 'categories']) {
    assert.match(multi.errors.join(), new RegExp(f), `多字段非法时 ${f} 也必须出现在 errors`);
  }
});

test('解析：L2 manifest 可选字段合法（含空串/空数组）→ 解析结果与既有行为逐字段一致', () => {
  const base = { schemaVersion: 1, id: 'foo', name: 'n', version: '1', sections: ['settings'], checksums: { zip: 'aaa' } };
  const expectations: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{}, {}],
    [
      { author: 'me', description: 'd', updatedAt: '2026-01-01T00:00:00.000Z', categories: ['a', 'b'] },
      { author: 'me', description: 'd', updatedAt: '2026-01-01T00:00:00.000Z', categories: ['a', 'b'] },
    ],
    [{ author: '', description: '', updatedAt: '' }, { author: '', description: '', updatedAt: '' }],
    [{ categories: [] }, { categories: [] }],
    [{ mode: 'migrate' }, { mode: 'migrate' }],
  ];
  for (const [extra, expected] of expectations) {
    const res = parseMarketItemManifest(JSON.stringify({ ...base, ...extra }));
    assert.equal(res.ok, true, `合法输入 ${JSON.stringify(extra)} 不得被拒绝`);
    assert.deepEqual(res.errors, []);
    // 消费侧可见的投影（JSON，undefined 键被丢弃）必须与既有行为逐字段一致
    assert.deepEqual(JSON.parse(JSON.stringify(res.manifest)), { ...base, ...expected }, '合法输入的解析结果必须与既有行为一致');
  }
  // 对象形状不变：author/description/updatedAt/categories 始终是自有键（值可为 undefined），
  // 与既有实现一致 —— 避免消费侧 `in` / Object.keys 语义变化。
  assert.deepEqual(
    Object.keys(parseMarketItemManifest(JSON.stringify(base)).manifest!).sort(),
    ['schemaVersion', 'id', 'name', 'version', 'author', 'description', 'updatedAt', 'categories', 'sections', 'checksums'].sort(),
  );
});

/* ---------------- 安全校验（§6） ---------------- */

test('校验：正常条目 valid', () => {
  const zip = makeValidZip();
  const res = validateMarketItem('foo', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'valid');
  assert.equal(res.errors.length, 0);
  assert.deepEqual(res.sections, ['settings']);
  assert.equal(res.warnings.length > 0, true, '供应链警示恒生成');
});

test('校验：清单 id 与请求不一致拒绝', () => {
  const zip = makeValidZip();
  const res = validateMarketItem('other', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /不一致/);
});

test('校验：checksum 与 zip 实际不符拒绝（L2↔L3 不一致）', () => {
  const zip = makeValidZip();
  const manifest = makeItemManifest('foo', Buffer.from('tampered-bytes-that-fail-hash'));
  const res = validateMarketItem('foo', manifest, zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /SHA-256/);
});

test('校验：sections 无交集拒绝', () => {
  const zip = makeValidZip();
  // L2 声明与 zip 内部不相干的 sections
  const manifest = JSON.stringify({
    schemaVersion: 1, id: 'foo', name: 'n', version: '1',
    sections: ['skills'], checksums: { zip: sha256Hex(zip) },
  });
  const res = validateMarketItem('foo', manifest, zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /无交集/);
});

test('校验：文件分区 enabled 但 ZIP 无前缀条目 → valid（空分区合法，仅 warning）', () => {
  // 模拟空 skills 分区导出：内部 manifest 声明 skills=true，但 ZIP 无任何 custom/skills/ 条目
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [{ name: 'config/settings.json', data: Buffer.from(settingsJson) }];
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify({ 'config/settings.json': sha256Hex(Buffer.from(settingsJson)) })) });
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true, skills: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['settings', 'skills']), zip);
  assert.equal(res.status, 'valid', '空文件分区不应拒绝条目（导入侧对空分区零操作）');
  assert.ok(res.warnings.some((w) => w.includes('skills') && w.includes('为空')), `应提示空分区 warning: ${res.warnings.join(' | ')}`);
});

test('校验：内部 manifest 无效拒绝', () => {
  // zipToBuffer 自身已拒绝路径穿越条目，故此处验证 validateMarketItem 对「内容级恶意
  // 载荷」的防线：结构合法但内部 manifest 无效的 zip 必须被拒（parseManifest → parseZipHardened 委托）。
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(JSON.stringify({ version: 1, namespaces: {} })) },
    { name: 'manifest.json', data: Buffer.from('{"broken":', 'utf8') }, // 非法 JSON
  ];
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /manifest/);
});

test('校验：zip bomb（超大压缩比/条目）拒绝', () => {
  // 单条目解压后远超压缩小体积 → parseZipHardened 的 maxRatio / maxSingleBytes 触发
  const big = Buffer.alloc(200 * 1024 * 1024, 0); // 200MB 压缩后很小 → 高压缩比
  const entries: ZipWriteEntry[] = [{ name: 'big.bin', data: big }];
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'invalid');
});

/** EOCD 签名（与 utils/zip.ts 的 EOCD_SIG 同值；该常量未导出，故此处内联）。 */
const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * 构造「EOCD 声明条目数 = n」的 ZIP（实际只含 1 条）。
 * 默认解析器在遍历中央目录**之前**先读 EOCD 的 16 位条目数字段判上限（utils/zip.ts:298/304），
 * 因此这个样本足以驱动读侧防线，且**不需要写侧放宽限额** —— t36 之后那条路径已关闭
 * （zipToBuffer 会把 maxEntries 钳到读侧上限，写不出「读不回来」的 ZIP）。
 */
function zipDeclaringEntries(n: number): Buffer {
  const zip = Buffer.from(zipToBuffer([{ name: 'self/f0.json', data: Buffer.from('{}') }]));
  const eocdIdx = zip.lastIndexOf(EOCD_SIG);
  assert.ok(eocdIdx > 0, '样本 ZIP 必须含 EOCD');
  zip.writeUInt16LE(n, eocdIdx + 10);
  return zip;
}

test('校验：条目数超过读侧上限（10000）的 config.zip 拒绝 —— 限额收敛到唯一来源后市场通道仍按默认限额', () => {
  // t36：不再借「写侧放宽限额」造样本（该不对称缺口已关闭）；改为直接声明 EOCD 条目数，
  // 断言口径（条目数 10001 超过上限 10000）与改动前逐字一致。
  const zip = zipDeclaringEntries(DEFAULT_ZIP_SAFETY_LIMITS.maxEntries + 1);
  const res = validateMarketItem('big-item', makeItemManifest('big-item', zip), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /条目数 10001 超过上限 10000/);
});

test('校验：内部 checksum 不匹配拒绝', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [{ name: 'config/settings.json', data: Buffer.from(settingsJson) }];
  // 故意写错 checksums.json
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify({ 'config/settings.json': 'deadbeef' })) });
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /完整性/);
});

test('校验：containsSecrets=true 拒绝（市场通道永不携带秘密，无 secret 不变式）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [{ name: 'config/settings.json', data: Buffer.from(settingsJson) }];
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify({ 'config/settings.json': sha256Hex(Buffer.from(settingsJson)) })) });
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true },
    security: { containsSecrets: true, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /containsSecrets/);
});

test('校验：sessions 分区拒绝（历史会话禁止进入市场条目）', () => {
  // 文件类分区 sessions：目录前缀须有内容才通过第 7 步 —— 但 sessions 属禁止分区，应在此之前拒绝
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'sessions/abc.json', data: Buffer.from('{"id":"abc"}') },
  ];
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify({
    'config/settings.json': sha256Hex(Buffer.from(settingsJson)),
    'sessions/abc.json': sha256Hex(Buffer.from('{"id":"abc"}')),
  })) });
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true, sessions: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['settings', 'sessions']), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /sessions|历史会话/);
});

test('校验：pluginFiles 分区拒绝（任意文件直通，禁止进入市场）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'plugin-files/secret.txt', data: Buffer.from('token=xxx') },
  ];
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true, pluginFiles: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['settings', 'pluginFiles']), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /pluginFiles/);
});

test('校验：self 分区拒绝（本地环境专属，禁止进入市场）', () => {
  const settingsJson = JSON.stringify({ version: 1, namespaces: {} });
  const entries: ZipWriteEntry[] = [
    { name: 'config/settings.json', data: Buffer.from(settingsJson) },
    { name: 'self/ui-prefs.json', data: Buffer.from('{"syncChannel":"webdav"}') },
  ];
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { settings: true, self: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  const zip = Buffer.from(zipToBuffer(entries));
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['settings', 'self']), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /self/);
});

/* ---------------- issue #35：patchFiles 供应链防线（导入侧） ---------------- */

/** 造一个 plugins 分区为 JSON 的 market zip（含或不含 patchFiles）。 */
function makePluginsMarketZip(patchFiles: unknown[] | undefined): Uint8Array {
  const pluginsJson = JSON.stringify({
    version: 1,
    plugins: [{ name: 'p', version: '1.0.0', isBundle: false, inBundles: [], enabled: true }],
    patch: [],
    pnpmWorkspace: 'patchedDependencies:\n  p: patches/p.patch\n',
    ...(patchFiles !== undefined ? { patchFiles } : {}),
  }, null, 2);
  const entries: ZipWriteEntry[] = [{ name: 'plugins/plugins.json', data: Buffer.from(pluginsJson) }];
  entries.push({ name: 'integrity/checksums.json', data: Buffer.from(JSON.stringify({ 'plugins/plugins.json': sha256Hex(Buffer.from(pluginsJson)) })) });
  const manifest = {
    schemaVersion: 1, exporter: { name: 'X', version: '1' },
    source: { dshVersion: '1', platform: 'linux', arch: 'x64' },
    exportedAt: new Date().toISOString(), sections: { plugins: true },
    security: { containsSecrets: false, encrypted: false, encryption: null },
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  return Buffer.from(zipToBuffer(entries));
}

test('issue #35 校验：plugins 分区携带 patchFiles → 市场条目拒收（与 localTarballs 同级）', () => {
  const zip = makePluginsMarketZip([{ relativePath: 'patches/p.patch', base64: 'ZGlmZg==' }]);
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['plugins']), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /patchFiles|patch/);
});

test('issue #35 校验：patchFiles 为空数组 / 未携带 → 放行（不误伤普通插件清单）', () => {
  const empty = makePluginsMarketZip([]);
  assert.equal(validateMarketItem('foo', makeItemManifest('foo', empty, ['plugins']), empty).status, 'valid');
  const none = makePluginsMarketZip(undefined);
  assert.equal(validateMarketItem('foo', makeItemManifest('foo', none, ['plugins']), none).status, 'valid');
});

test('issue #35 校验：patchFiles 路径穿越（绝对路径/..）→ 结构校验直接拒绝', () => {
  const zip = makePluginsMarketZip([{ relativePath: '../../evil.patch', base64: 'ZGlmZg==' }]);
  const res = validateMarketItem('foo', makeItemManifest('foo', zip, ['plugins']), zip);
  assert.equal(res.status, 'invalid');
  assert.match(res.errors.join(), /patchFiles|相对路径/);
});

/* ---------------- reader（只读 git） ---------------- */

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('reader：首次 clone，复用副本 pull（只读不 push）', async () => {
  const work = await tmpDir('dsh-mkt-work-');
  const calls: string[][] = [];
  const mem: SnapshotFsLike = {
    store: new Map<string, Uint8Array>(),
    async readFile(p) { const d = this.store.get(p); if (!d) throw new Error('no'); return d; },
    async writeFile(p, d) { this.store.set(p, d); },
    async mkdir() {},
    async readdir() { return []; },
    async isDir(p) { return this.store.has(p); },
    async exists(p) { return this.store.has(p); },
    async remove() {},
  };

  const reader = new GitMarketReader({
    exec: async (cmd, args, opts) => {
      calls.push(args);
      // clone 分支：执行后写入 .git 标记（第二/三次调用即可走 pull 分支）
      if (args[0] === 'clone' && opts.cwd) {
        mem.store.set(path.join(opts.cwd, '.git'), new Uint8Array());
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    },
    fsx: mem as unknown as SnapshotFs,
  });
  // 预备：工作区已有 index.json（模拟 clone 拉下来的文件）
  mem.store.set(`${work}/index.json`, new TextEncoder().encode('{}'));
  // 第一次调用：.git 不存在 → clone 分支
  const r1 = await reader.readIndex({ url: 'https://github.com/example/market', workDir: work });
  assert.equal(r1.text, '{}');
  // 第二次调用：.git 已存在 → pull 分支
  const r2 = await reader.readIndex({ url: 'https://github.com/example/market', workDir: work });
  assert.equal(r2.text, '{}');
  // 断言：clone + pull，绝无 push
  const flat = calls.map((c) => c.join(' ')).join('\n');
  assert.match(flat, /clone/);
  assert.match(flat, /pull/);
  assert.doesNotMatch(flat, /push/);
  await fs.rm(work, { recursive: true, force: true });
});

/** 内存 SnapshotFs mock（reader 测试用）：clone 分支写入 .git 标记以进入 pull 分支。 */
function makeMemFs(initial: Array<[string, string]> = []): SnapshotFsLike {
  const store = new Map<string, Uint8Array>(
    initial.map(([p, content]) => [p, new TextEncoder().encode(content)]),
  );
  return {
    store,
    async readFile(p) { const d = this.store.get(p); if (!d) throw new Error('no'); return d; },
    async writeFile(p, d) { this.store.set(p, d); },
    async mkdir() {},
    async readdir() { return []; },
    async isDir(p) { return this.store.has(p); },
    async exists(p) { return this.store.has(p); },
    async remove() {},
  };
}

test('reader：条目级 repo 多仓库读取（clone 条目仓库到调用方 workDir，读 items/<id>/）', async () => {
  const work = await tmpDir('dsh-mkt-work-item-');
  const calls: string[][] = [];
  const mem = makeMemFs([
    [`${work}/items/foo/manifest.json`, '{"id":"foo"}'],
    [`${work}/items/foo/config.zip`, 'PK-bytes'],
  ]);
  const reader = new GitMarketReader({
    exec: async (_cmd, args, opts) => {
      calls.push(args);
      if (args[0] === 'clone' && opts.cwd) {
        mem.store.set(path.join(opts.cwd, '.git'), new Uint8Array());
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    },
    fsx: mem as unknown as SnapshotFs,
  });
  // 无 .git → clone 分支：断言 clone 目标是条目仓库（repo），而非市场仓库
  const m = await reader.readItemManifest({
    url: 'https://github.com/example/market',
    workDir: work,
    itemId: 'foo',
    repo: 'https://github.com/example/items-repo',
  });
  assert.equal(m.text, '{"id":"foo"}');
  const cloneCall = calls.find((c) => c[0] === 'clone');
  assert.ok(cloneCall, '应走 clone 分支');
  assert.ok(cloneCall.includes('https://github.com/example/items-repo'), 'clone 目标是条目仓库');
  assert.ok(!cloneCall.includes('https://github.com/example/market'), '不 clone 市场仓库');

  // 二次调用（.git 已存在 → pull 分支）读取 zip
  const z = await reader.readItemZip({
    url: 'https://github.com/example/market',
    workDir: work,
    itemId: 'foo',
    repo: 'https://github.com/example/items-repo',
  });
  assert.equal(new TextDecoder().decode(z.data), 'PK-bytes');
  const flat = calls.map((c) => c.join(' ')).join('\n');
  assert.match(flat, /pull/);
  assert.doesNotMatch(flat, /push/);
  await fs.rm(work, { recursive: true, force: true });
});

test('reader：repo 缺省时仍从市场仓库读取（现状兼容）', async () => {
  const work = await tmpDir('dsh-mkt-work-item-');
  const calls: string[][] = [];
  const mem = makeMemFs([[`${work}/items/foo/manifest.json`, '{"id":"foo"}']]);
  const reader = new GitMarketReader({
    exec: async (_cmd, args, opts) => {
      calls.push(args);
      if (args[0] === 'clone' && opts.cwd) {
        mem.store.set(path.join(opts.cwd, '.git'), new Uint8Array());
      }
      return { stdout: 'ok', stderr: '', code: 0 };
    },
    fsx: mem as unknown as SnapshotFs,
  });
  const m = await reader.readItemManifest({
    url: 'https://github.com/example/market',
    workDir: work,
    itemId: 'foo',
  });
  assert.equal(m.text, '{"id":"foo"}');
  const cloneCall = calls.find((c) => c[0] === 'clone');
  assert.ok(cloneCall?.includes('https://github.com/example/market'), '缺省 clone 市场仓库');
  await fs.rm(work, { recursive: true, force: true });
});

test('reader：非法 repo（含 userinfo）拒绝，不发起任何 clone', async () => {
  const work = await tmpDir('dsh-mkt-work-item-');
  const calls: string[][] = [];
  const reader = new GitMarketReader({
    exec: async (_cmd, args) => { calls.push(args); return { stdout: '', stderr: '', code: 0 }; },
    fsx: makeMemFs() as unknown as SnapshotFs,
  });
  await assert.rejects(
    () => reader.readItemManifest({
      url: 'https://github.com/example/market',
      workDir: work,
      itemId: 'foo',
      repo: 'https://user:token@github.com/x',
    }),
    /userinfo|用户名\/密码/,
    '含 userinfo 的 repo 必须拒绝',
  );
  assert.equal(calls.length, 0, '拒绝发生在 git 执行之前');
  await fs.rm(work, { recursive: true, force: true });
});

test('validateRepoUrl：合法 https 通过；userinfo / 空白 / 空串拒绝', () => {
  assert.equal(validateRepoUrl('https://github.com/example/items-repo.git'), null, '合法 https 通过');
  assert.notEqual(validateRepoUrl('https://user:token@github.com/x'), null, 'userinfo 拒绝');
  assert.notEqual(validateRepoUrl('https://github.com/x/a b.git'), null, '空白拒绝');
  assert.notEqual(validateRepoUrl(''), null, '空串拒绝');
});

interface SnapshotFsLike {
  store: Map<string, Uint8Array>;
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, d: Uint8Array): Promise<void>;
  mkdir(p: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  isDir(p: string): Promise<boolean>;
  exists(p: string): Promise<boolean>;
  remove(p: string): Promise<void>;
}

/* ---------------- 市场配置持久化 ---------------- */

test('market-config：add 幂等 + 去重；remove 删除', async () => {
  const dir = await tmpDir('dsh-mkt-cfg-');
  try {
    const a = await addMarket(dir, 'https://github.com/example/market');
    assert.equal(a.added, true);
    const b = await addMarket(dir, 'https://github.com/example/market');
    assert.equal(b.added, false, '同 url 幂等');
    assert.equal((await readMarketConfig(dir)).markets.length, 1);
    await removeMarket(dir, 'https://github.com/example/market');
    assert.equal((await readMarketConfig(dir)).markets.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('market-config：userinfo url 拒绝', async () => {
  const dir = await tmpDir('dsh-mkt-cfg-');
  try {
    await assert.rejects(() => addMarket(dir, 'https://user:token@github.com/x'));
    // 未写入
    assert.deepEqual((await readMarketConfig(dir)).markets, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('market-config：损坏文件读取 → 空配置', async () => {
  const dir = await tmpDir('dsh-mkt-cfg-');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'market-config.json'), '{broken', 'utf8');
    assert.deepEqual((await readMarketConfig(dir)).markets, []);
    // 写入后再读回
    await writeMarketConfig(dir, { schemaVersion: 1, markets: [{ url: 'https://g.com/m', addedAt: '2020-01-01T00:00:00.000Z' }] });
    assert.deepEqual(emptyMarketConfig().markets, []);
    assert.equal((await readMarketConfig(dir)).markets.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ---------------- 纯渲染模型 ---------------- */

test('view：市场状态行', () => {
  assert.equal(marketStatusText({ count: 0 }, zhUiT).length > 0, true);
  assert.match(marketStatusText([{ url: 'u', addedAt: 't' }], zhUiT), /1/);
});

test('view：列表摘要计数', () => {
  const s = marketListSummary([
    { id: 'a', name: 'A', cacheState: 'fresh' },
    { id: 'b', name: 'B', cacheState: 'cached' },
    { id: 'c', name: 'C', cacheState: 'none' },
  ], zhUiT);
  assert.deepEqual(s, { total: 3, fresh: 1, cached: 1, none: 1 });
});

test('view：条目徽章 valid/invalid', () => {
  const valid = computeItemBadge({ id: 'a', name: 'A', version: '1', sections: ['settings'], downloadedAt: 't', status: 'valid', warnings: [] }, zhUiT);
  assert.equal(valid.valid, true);
  assert.match(valid.statusText, /通过/);
  const invalid = computeItemBadge({ id: 'a', name: 'A', version: '1', sections: [], downloadedAt: 't', status: 'invalid', errors: ['x'], warnings: [] }, zhUiT);
  assert.equal(invalid.valid, false);
});

test('view：供应链警示恒生成（含来源/时间/非官方）', () => {
  const w = marketItemWarnings({ name: 'A', author: 'me', provenance: { source: 'https://x' } }, 'https://g.com/m', '2026-01-01T00:00:00.000Z', zhUiT);
  assert.ok(w.some((x) => x.includes('非官方')), '非官方审核警示');
  assert.ok(w.some((x) => x.includes('https://g.com/m')), '来源 URL');
  assert.ok(w.some((x) => x.includes('2026-01-01')), '下载时间');
  assert.ok(w.some((x) => x.includes('me')), '作者');
});

test('view：needsReview 恒 true（不允许默认信任来源）', () => {
  assert.equal(needsReview({} as never), true);
});
