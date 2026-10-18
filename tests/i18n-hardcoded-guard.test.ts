/**
 * 「英文界面零中文」静态守卫（契约见 docs/design/2026-10-08-i18n-en-hardcoding.md §3）。
 *
 * 用法：
 *   全量：node --test tests/i18n-hardcoded-guard.test.ts
 *   作用域：$env:DCM_I18N_GUARD_SCOPE='src/client,src/ui'; node --test tests/i18n-hardcoded-guard.test.ts
 *           （作用域只收窄文件列表；E1–E3、白名单过期断言、内核自检始终全局生效）
 *
 * 迁移期口径（§3.8）：t3–t7 各自清零之前，全量红灯是**预期状态**；各作用域用
 * DCM_I18N_GUARD_SCOPE 判定自己（退出码 0）。
 *
 * 对应的验收条件：A1（生效作用域零命中）/ A2（en 目录零 CJK）/ A5（白名单无过期且计数锚定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWLIST_ENTRY_COUNT,
  ALLOWLIST_TOTAL_HITS,
  EN_CATALOG_FILES,
  GUARD_SCOPE_USAGE,
  GUARD_SCOPE_VAR,
  I18N_ALLOWLIST,
  KNOWN_CATALOG_FILES,
  REPO_ROOT,
  checkAllowlist,
  countByFile,
  formatAnomaly,
  formatHit,
  isCatalogOwnerFile,
  parseGuardScope,
  scanAll,
  scanFile,
  scanText,
  scanTextFull,
  scopeMatches,
  summaryLine,
} from './helpers/i18n-scan.ts';

const scopeRaw: string | undefined = process.env[GUARD_SCOPE_VAR];
const parsed = parseGuardScope(scopeRaw);

/** 全量扫描：白名单计数与 en 体检都以「全量」为准（作用域只收窄缺陷判定）。 */
const full = scanAll();
const measured = countByFile(full.hits);
const scannedFiles = new Set(full.files);
const allowlistedFiles = new Set(I18N_ALLOWLIST.map((e) => e.file));
const allowlistedHits = full.hits.filter((h) => allowlistedFiles.has(h.file)).length;
const allowlistIssues = checkAllowlist(I18N_ALLOWLIST, measured, scannedFiles);

/** 生效文件列表（作用域为空 = 全量）。 */
const effectiveFiles = parsed.prefixes.length > 0 ? full.files.filter((f) => scopeMatches(f, parsed.prefixes)) : full.files;
const effectiveSet = new Set(effectiveFiles);
/** 生效作用域内的缺陷（白名单不计入缺陷）。 */
const defects = full.hits.filter((h) => effectiveSet.has(h.file) && !allowlistedFiles.has(h.file));

// §3.1：每次运行都打印一行机器可读摘要，随后逐条打印命中（白名单条目单独标注）。
console.log(summaryLine(parsed.prefixes, effectiveFiles.length, defects.length, allowlistedHits));
for (const e of I18N_ALLOWLIST) {
  console.log('[allowlist] ' + e.file + ' expected=' + e.expectedHits + ' measured=' + (measured.get(e.file) ?? 0));
}
for (const h of defects) console.log(formatHit(h));

/* ------------------------------------------------------------------ A0 */

test('A0 守卫作用域变量合法且非空集', () => {
  assert.equal(parsed.errors.length, 0, GUARD_SCOPE_USAGE + '；非法值：' + parsed.errors.join(' / '));
  assert.ok(effectiveFiles.length > 0, '生效作用域匹配到 0 个扫描文件（空集不能证明任何事）: ' + (scopeRaw ?? ''));
});

/* ------------------------------------------------------------------ A1 */

test('A1 生效作用域内零硬编码中文（缺陷 0）', () => {
  assert.equal(
    defects.length,
    0,
    '发现 ' + defects.length + ' 条硬编码中文（作用域 ' + (parsed.prefixes.length > 0 ? parsed.prefixes.join(',') : 'ALL') + '）：\n'
      + defects.slice(0, 40).map(formatHit).join('\n'),
  );
});

/* ------------------------------------------------------------------ A5 */

test('A5 白名单无过期条目 + 计数锚定（4 条 / 133 命中）+ reason 可核验', () => {
  assert.equal(allowlistIssues.length, 0, allowlistIssues.join('\n'));
  assert.equal(I18N_ALLOWLIST.length, ALLOWLIST_ENTRY_COUNT, '迁移期不得新增豁免（新增条目需走 captain + t2 所有者）');
  assert.equal(allowlistedHits, ALLOWLIST_TOTAL_HITS, '白名单总命中数必须恒为 ' + ALLOWLIST_TOTAL_HITS + '，实测 ' + allowlistedHits);
  for (const e of I18N_ALLOWLIST) {
    const reason = e.reason.trim();
    assert.ok(reason.length >= 20, '白名单理由必须可核验（写明消费方 + 为何不渲染），不得写「内部用」这类空话: ' + e.file);
    assert.ok(reason.includes('src/'), '白名单理由必须给出可核验的消费方路径（src/…）: ' + e.file);
    assert.equal(typeof e.expectedHits, 'number', 'expectedHits 必须是精确数字（§3.5）: ' + e.file);
  }
});

/* ------------------------------------------------------------------ A2 */

test('A2 en 目录值零 CJK（8 本字典 + locale/en.json，取生效作用域内的文件）', () => {
  const files = EN_CATALOG_FILES.filter((f) => effectiveSet.has(f));
  const hits = files.flatMap((f) => scanFile(f));
  assert.equal(hits.length, 0, 'en 目录出现 CJK（en 值必须是纯英文）：\n' + hits.map(formatHit).join('\n'));
});

/* ------------------------------------------------------------------ A3 */

test('A3 扫描区间未闭合即失败（fail-closed，绝不静默零命中）', () => {
  const scoped = full.anomalies.filter((a) => effectiveSet.has(a.file));
  assert.equal(
    scoped.length,
    0,
    '不可判定（扫描区间未闭合）：\n' + scoped.map(formatAnomaly).join('\n'),
  );
});

/* ------------------------------------------------- 内核自检 S1–S11（内存样本） */

const TICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

test('S1 E1：注释里的中文一律不算命中', () => {
  const src = [
    '// 行注释里的中文',
    '/* 块注释里的中文 */',
    '/**',
    ' * JSDoc 里的中文',
    ' */',
    'const a = 1;',
  ].join('\n');
  assert.deepEqual(scanText(src), []);
});

test('S2 E2：log.* 实参豁免，但不过宽（同一文件普通字面量仍命中）', () => {
  const src = "log.info('中文一')\nconst a = '中文二'\n";
  const hits = scanText(src);
  assert.equal(hits.length, 1, '恰好 1 条（E2 不得把普通字面量一起吃掉）');
  assert.equal(hits[0]?.line, 2);
  assert.equal(hits[0]?.kind, 'literal');
});

test('S3 注释剥离不得吃掉代码：字符串里的 //、/*、引号、反斜杠、模板插值后仍必须命中', () => {
  const src = [
    "const a = '// 中文A';",
    'const b = "/* 中文B */";',
    "const c = 'it" + BACKSLASH + "'s 中文C';",
    'const d = "say ' + BACKSLASH + '"hi' + BACKSLASH + '" 中文D";',
    'const e = ' + TICK + 'tpl $' + '{1} 中文E' + TICK + ';',
    "const f = '" + BACKSLASH + BACKSLASH + " 中文F';",
    'const g = "a ' + TICK + ' b 中文G";',
  ].join('\n');
  const hits = scanText(src);
  assert.equal(hits.length, 7, '7 处中文都必须在字符串内命中：' + JSON.stringify(hits));
  assert.ok(hits.every((h) => h.kind === 'literal'));
});

test('S4 E3 精确到目录对象字面量（zh 区豁免 / en 区与普通字面量不豁免）', () => {
  const src = [
    'const zh = {',
    "  'a.b': '目录中文',",
    '};',
    'const en: Record<string, string> = {',
    "  'a.b': 'catalog english',",
    '};',
    "const plain = '普通中文';",
  ].join('\n');
  const hits = scanText(src, { catalogOwner: true });
  assert.equal(hits.length, 1, '恰好 1 条（只有普通字面量）：' + JSON.stringify(hits));
  assert.equal(hits[0]?.line, 7);
  // t16：catalogOwner 缺省 false ⇒ zh 对象不再按标识符名静默豁免
  const ungated = scanText(src);
  assert.equal(ungated.length, 2, '未声明目录归属时 zh 区也计入命中：' + JSON.stringify(ungated));
});

test('S5 broad 字符类：CJK 标点 + 全角形式 + 表意字全命中', () => {
  const chars = ['\u2E80', '\u3001', '\u3400', '\u4E00', '\uF900', '\uFE30', '\uFF01', '\uFF0B', '\uFFE0'];
  const src = 'const a = "' + chars.join('') + '";';
  const broad = scanText(src);
  assert.equal(broad.length, 1);
  assert.equal(broad[0]?.chars, chars.length, 'broad 必须逐个命中（含顿号 U+3001 与全角加号 U+FF0B）');
  const narrow = scanText(src, { classes: 'narrow' });
  assert.equal(narrow.length, 1);
  assert.equal(narrow[0]?.chars, 3, 'narrow 只算表意字（对照口径）');
});

test('S6 白名单：expectedHits 大于 / 小于实测、实测为 0 三种情况都必须失败', () => {
  const file = 'src/sample.ts';
  const base = [{ file, expectedHits: 3, reason: '样本' }];
  const files = new Set([file]);
  assert.equal(checkAllowlist(base, new Map([[file, 3]]), files).length, 0, '对照：精确相等应通过');
  assert.equal(checkAllowlist(base, new Map([[file, 5]]), files).length, 1, '实测偏多 = 新缺陷，必须失败');
  assert.equal(checkAllowlist(base, new Map([[file, 1]]), files).length, 1, '实测偏少 = 条目过期，必须失败');
  assert.equal(checkAllowlist(base, new Map([[file, 0]]), files).length, 1, '实测 0 = 过期，必须失败');
  assert.equal(checkAllowlist(base, new Map(), files).length, 1, '不在扫描集内也必须失败');
});

test('S7 作用域按目录段边界匹配（src/client 不得命中 src/client2）', () => {
  assert.equal(scopeMatches('src/client/a.ts', ['src/client']), true);
  assert.equal(scopeMatches('src/client2/a.ts', ['src/client']), false);
  assert.equal(scopeMatches('src/ui-x/a.ts', ['src/ui']), false);
  assert.equal(scopeMatches('src/index.ts', ['src/index.ts']), true, '写成文件路径时逐字相等');
  assert.equal(scopeMatches('src/index.ts', ['src']), true, '前缀命中其下全部');
  assert.equal(scopeMatches('src/index.tsx', ['src/index.ts']), false);
});

test('S8 作用域变量非法值必须失败（绝不静默当空集）', () => {
  const bads = [
    'C:' + BACKSLASH + 'repo' + BACKSLASH + 'src',
    '/abs/src',
    'src' + BACKSLASH + 'core',
    'src/../etc',
  ];
  for (const bad of bads) {
    assert.equal(parseGuardScope(bad).errors.length > 0, true, '非法作用域必须报错: ' + bad);
  }
  assert.deepEqual(parseGuardScope('src/core').errors, []);
  assert.deepEqual(parseGuardScope('   ').prefixes, [], '全空白 = 全量');
});

/* ------------------------------------------------- 内核自检 S9–S11（t16 加固） */

test('S9 E3 归属门禁：未注册、不在已知清单的 zh 对象不享豁免（t9 F2 加固）', () => {
  const src = "const zh = { a: '中文' }";
  assert.equal(scanTextFull(src, { catalogOwner: false }).hits.length, 1, '未归属 ⇒ 中文计入命中');
  assert.equal(scanTextFull(src, { catalogOwner: true }).hits.length, 0, '已归属 ⇒ zh 区豁免');
  assert.equal(isCatalogOwnerFile('src/ui/__t16_probe.ts', src), false, '新文件 + 仅同名形状 ≠ 归属');
  assert.equal(isCatalogOwnerFile('src/foo/messages.ts', "registerMessageCatalog({ id: 'x', zh, en })"), true);
  assert.equal(isCatalogOwnerFile('src/foo/base.ts', 'registerBaseMessageCatalog({ zh, en })'), true);
  assert.equal(isCatalogOwnerFile('src/sync/s3/messages.ts', "makeCatalogMsg(s3Zh, s3En, 'zh')"), true);
});

test('S10 fail-closed：未闭合字符串/块注释/正则/模板/括号/大括号都产出异常且不豁免', () => {
  const s1 = scanTextFull("const a = '中文");
  assert.ok(s1.anomalies.some((a) => a.kind === 'unclosed-string'), JSON.stringify(s1.anomalies));
  const s2 = scanTextFull('/* 中文');
  assert.ok(s2.anomalies.some((a) => a.kind === 'unclosed-block-comment'), JSON.stringify(s2.anomalies));
  assert.equal(s2.hits.length, 0, '注释中文仍按 E1 不计，但异常必须让守卫红');
  const s3 = scanTextFull('const re = /中文');
  assert.ok(s3.anomalies.some((a) => a.kind === 'unclosed-regex'), JSON.stringify(s3.anomalies));
  const s6 = scanTextFull('const t = ' + TICK + '中文');
  assert.ok(s6.anomalies.some((a) => a.kind === 'unclosed-template'), JSON.stringify(s6.anomalies));
  // E2 括号未闭合：不豁免 ⇒ 中文计入
  const s4 = scanTextFull("log.info('中文'");
  assert.ok(s4.anomalies.some((a) => a.kind === 'unclosed-paren'), JSON.stringify(s4.anomalies));
  assert.equal(s4.hits.length, 1, 'fail-closed：括号未闭合时 E2 不豁免');
  // E3 大括号未闭合：不豁免 ⇒ 中文计入
  const s5 = scanTextFull("const zh = {\n  a: '中文',\n", { catalogOwner: true });
  assert.ok(s5.anomalies.some((a) => a.kind === 'unclosed-brace'), JSON.stringify(s5.anomalies));
  assert.equal(s5.hits.length, 1, 'fail-closed：大括号未闭合时 E3 不豁免');
});

test('S11 合法 zh 形状全部可归属（21 处，逐一声明归属方式）', () => {
  const registered = [
    'src/adapters/messages.ts', 'src/core/messages-core.ts', 'src/foreign/messages.ts',
    'src/market/messages-market.ts', 'src/profiles/messages.ts', 'src/routes/messages.ts',
    'src/schema/messages.ts', 'src/security/messages.ts', 'src/sync/messages.ts', 'src/utils/messages-utils.ts',
  ]; // 通道①：文件自身 registerMessageCatalog(
  const base = ['src/core/messages.ts']; // 通道①：registerBaseMessageCatalog(
  const factory = ['src/sync/s3/messages.ts', 'src/sync/gist/messages.ts']; // 通道①：makeCatalogMsg(
  const knownFiles = [
    'src/ui/i18n.ts', 'src/client/locales.ts', 'src/client/history/history-locales.ts',
    'src/client/market/market-locales.ts', 'src/client/recovery/recovery-locales.ts',
    'src/client/sync/sync-locales.ts', 'src/migrations/messages-migrations.ts',
    'src/client/chat/chat-locales.ts',
  ]; // 通道②：KNOWN_CATALOG_FILES 显式清单
  const all = [...registered, ...base, ...factory, ...knownFiles];
  assert.equal(all.length, 21, '合法 zh 形状共 21 处');
  assert.equal(new Set(all).size, 21, '21 处不得重复');
  for (const f of all) {
    const src = readFileSync(join(REPO_ROOT, f), 'utf8');
    assert.equal(isCatalogOwnerFile(f, src), true, f + ' 必须可归属（register* 调用或 KNOWN_CATALOG_FILES）');
  }
  for (const f of knownFiles) assert.equal(isCatalogOwnerFile(f, ''), true, 'KNOWN_CATALOG_FILES: ' + f);
  for (const f of KNOWN_CATALOG_FILES) assert.ok(all.includes(f), '清单条目必须被 S11 声明: ' + f);
});

test('S12 注释/字符串里的 API 字样不得授予目录归属（t17-F1）', () => {
  // 行注释版：唯一字样在 // 注释里
  const commentOnly = "// registerMessageCatalog({ id: 'x', zh, en })\nconst zh = { a: '中文' };";
  assert.equal(isCatalogOwnerFile('src/foo/comment-only.ts', commentOnly), false, '行注释字样不得授予归属');
  // 块注释版
  const blockOnly = "/* makeCatalogMsg(s3Zh, s3En, 'zh') */\nconst zh = { a: '中文' };";
  assert.equal(isCatalogOwnerFile('src/foo/block-only.ts', blockOnly), false, '块注释字样不得授予归属');
  // 字符串版
  const stringOnly = "const hint = 'registerMessageCatalog(';\nconst zh = { a: '中文' };";
  assert.equal(isCatalogOwnerFile('src/foo/string-only.ts', stringOnly), false, '字符串字样不得授予归属');
  // 与 E3 联动：未授予归属 ⇒ zh 对象里的中文计入命中
  assert.equal(
    scanTextFull(commentOnly, { catalogOwner: isCatalogOwnerFile('src/foo/comment-only.ts', commentOnly) }).hits.length,
    1,
    '注释版未归属 ⇒ E3 不豁免，中文计入命中',
  );
  // 对照：真实 code 位置调用仍授予（即使文件里同时有字符串/注释字样）
  assert.equal(isCatalogOwnerFile('src/foo/real.ts', "registerMessageCatalog({ id: 'x', zh, en });"), true);
  assert.equal(
    isCatalogOwnerFile('src/foo/real2.ts', "const s = 'registerMessageCatalog(';\nregisterMessageCatalog({ id: 'x', zh, en });"),
    true,
    '字符串字样不影响同一文件里真实调用的归属',
  );
  // 掩码不得把被注释隔开的片段拼成假匹配
  assert.equal(isCatalogOwnerFile('src/foo/split.ts', 'register/*x*/MessageCatalog({ id: 1 });'), false);
  // KNOWN_CATALOG_FILES 仍无条件授予（整文件粒度，新增条目走 captain 审批）
  assert.equal(isCatalogOwnerFile('src/client/locales.ts', '// registerMessageCatalog('), true);
});
