/**
 * t78：值形状判定**单一来源**的漂移守卫（G-36 残余 ③）。
 *
 * 背景：`src/security/redaction.ts` 曾自持一份值形状表（与 `secret-scanner.ts` 的
 * `SECRET_VALUE_PATTERNS` 平行维护），于是同一个语义有两套实现、必然持续漂移
 * （t58-F1/t72 在 scanner 侧确立的边界没有传到界面/日志的 `redact()` 路径）。
 * t78 把 `redact()` 的表改为**直接派生**自 `SECRET_VALUE_PATTERNS`（唯一本地补充是
 * 一条**只放宽**的通用 PEM 头），本文件是那条「不许再漂移」的守卫：
 *
 *  - t78-a 结构守卫：scanner 表里每一个形状都必须出现在 redaction 的派生表里；
 *  - t78-b 行为守卫（防漏掩）：scanner 判定为 secret 的语料，`redact()` 必须真的掩掉原文；
 *  - t78-c/d 与 t72 的大小写边界一致（bearer scheme 不敏感、厂商前缀敏感）；
 *  - t78-e 正例清单原样保留（不新增过剥）；
 *  - t78-f 已登记差异的 characterization（显示层比 scanner **更宽**：示例/占位形态也掩）——
 *    钉住现状，避免将来被静默改成另一头。（t83 后范围收窄：`sk-` 加了载荷形状守卫 ⇒ `sk-<词>` 两侧一致放行；
 *    `Bearer example-…` 的差异不变。）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { REDACTION_VALUE_PATTERNS, REDACTED, createRedactor, redact } from './redaction.ts';
import { SECRET_VALUE_PATTERNS, matchSecretValuePattern } from './secret-scanner.ts';

/** 真实凭据形态语料（scanner 必须命中；redact 必须掩掉原文） */
const CREDENTIAL_CORPUS: readonly string[] = [
  'sk-abc1234567890abcdef',
  'openai=sk-proj-9f8e7d6c5b4a3210abcdef',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'AKIAIOSFODNN7A1B2C3D4',
  'ghp_abcdefghijklmnopqrstuvwxyz',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'Authorization: Bearer abcdefghijklmnop',
  'curl -H ' + String.fromCharCode(39) + 'authorization: bearer abc12345def' + String.fromCharCode(39),
  'BEARER AbCdEf0123',
  'bearer ' + 'q'.repeat(30),
];

test('t78-a（结构）：redaction 的值形状表派生自 scanner 的单一来源（每个形状都在）', () => {
  const sources = new Set(REDACTION_VALUE_PATTERNS.map((p) => p.re.source));
  for (const p of SECRET_VALUE_PATTERNS) {
    assert.ok(
      sources.has(p.re.source),
      'scanner 的形状必须出现在 redaction 的派生表里（漏 = 漂移）：' + p.name,
    );
  }
  assert.ok(
    REDACTION_VALUE_PATTERNS.some((p) => p.name === 'pem-private-key-generic'),
    '唯一允许的本地补充（只放宽的通用 PEM 头）必须在表里',
  );
});

test('t78-b（行为漂移守卫）：scanner 判 secret 的语料，redact() 必须掩掉原文', () => {
  for (const s of CREDENTIAL_CORPUS) {
    assert.notEqual(matchSecretValuePattern(s), null, 'scanner 必须命中（语料前提）：' + s);
    const out = redact(s);
    for (const secret of secretFragments(s)) {
      assert.ok(!out.includes(secret), 'redact 不得漏掩：' + secret + ' → ' + out);
    }
  }
});

/** 从语料里取出「必须消失的原文片段」（去掉外围的字段名/前缀等非密钥文本） */
function secretFragments(s: string): string[] {
  const out: string[] = [];
  const bearer = /[Bb][Ee][Aa][Rr][Ee][Rr]\s+([A-Za-z0-9._~+/=-]{8,})/.exec(s);
  if (bearer !== null) return [bearer[1]!];
  const pem = /-----BEGIN [A-Za-z0-9 ]*PRIVATE KEY-----/.exec(s);
  if (pem !== null) return [pem[0]];
  for (const p of SECRET_VALUE_PATTERNS) {
    const m = new RegExp(p.re.source).exec(s);
    if (m !== null) { out.push(m[0]); break; }
  }
  return out;
}

test('t78-c（对照表）：规范凭据形态的命中与结果不变（sk-/JWT/AKIA/ghp_/PAT/PEM/Bearer）', () => {
  const cases: readonly { readonly input: string; readonly expectMasked: string }[] = [
    { input: 'sk-abc1234567890abcdef', expectMasked: 'sk-abc1234567890abcdef' },
    { input: 'AKIAIOSFODNN7A1B2C3D4', expectMasked: 'AKIAIOSFODNN7A1B2C3D4' },
    { input: 'ghp_abcdefghijklmnopqrstuvwxyz', expectMasked: 'ghp_abcdefghijklmnopqrstuvwxyz' },
    { input: 'Authorization: Bearer abcdefghijklmnop', expectMasked: 'abcdefghijklmnop' },
    { input: '-----BEGIN EC PRIVATE KEY-----', expectMasked: '-----BEGIN EC PRIVATE KEY-----' },
  ];
  for (const c of cases) {
    const out = redact(c.input);
    assert.ok(!out.includes(c.expectMasked), '必须掩掉：' + c.input + ' → ' + out);
    assert.ok(out.includes(REDACTED), '替换产物必须是 REDACTED：' + out);
  }
  // 幂等：掩过的文本再掩一次不变（既有契约）
  const once = redact('apiKey=sk-abc1234567890abcdef');
  assert.equal(redact(once), once, 'redact 必须幂等');
});

test('t78-d（与 t72 的边界一致）：bearer scheme 不敏感、厂商前缀敏感', () => {
  // ① scheme 大小写不敏感（t72 确立）→ redact 与 scanner 同向
  for (const s of ['bearer abc12345def', 'BEARER AbCdEf0123', 'BeArEr ' + 'q'.repeat(30)]) {
    assert.equal(matchSecretValuePattern(s), 'bearer-token-anycase', 'scanner 侧命中（前提）：' + s);
    assert.ok(redact(s).includes(REDACTED), 'redact 侧必须同向掩掉：' + s);
  }
  // ② 厂商前缀保持大小写敏感（t72 的既有登记边界，不得单方面放宽）
  for (const s of ['SK-abc1234567890abcdef', 'GHP_abcdefghijklmnopqrstuvwxyz', 'akiaIOSFODNN7A1B2C3D4']) {
    assert.equal(matchSecretValuePattern(s), null, 'scanner 侧不命中（t72 边界）：' + s);
    assert.equal(redact(s), s, 'redact 侧同样保留（两侧一致）：' + s);
  }
});

test('t78-e（正例清单 ≥8 组）：散文/字段名/开关/路径必须原样保留', () => {
  const positives: readonly string[] = [
    'bearer credentials are required',
    'BEARER HEADER NOT SET',
    'bearer authentication failed',
    'the bearer scheme is defined by RFC 7235',
    'run with --api-key-required to continue',
    "kind: 'openai-style-key' is an internal enum",
    'path: docs/spec/known-gaps.md',
    'GET /api/health?ready=1',
    'bearer token missing from the header',
    'secrets are never exported by default',
    'ghp_ is a vendor prefix name',
    'disk-usage and cache-cleaner are pm-visible',
  ];
  for (const s of positives) {
    assert.equal(redact(s), s, '正例不得被过剥：' + s + ' → ' + redact(s));
  }
});

test('t78-g（**t83 已修**）：含 sk- 的英文标识符不再被掩 —— 该过剥是 scanner 侧收窄的，两侧同源同步受益', () => {
  // t78 当时的事实：`sk-` 形状无词边界 ⇒ `ta|sk-management` 命中（base 与本仓当时逐字同结果）。
  // **t83 已在 `secret-scanner.ts` 收窄**（`sk-` 载荷若是 1–24 个纯小写字母/连字符 = 词形态 → 放行），
  // 派生表随之同步 ⇒ redact() 不再改写正常内容（证据 `outputs/bug-audit/fix-wordboundary/`）。
  for (const s of ['task-management', 'risk-assessment', 'disk-space-report']) {
    assert.equal(redact(s), s, 't83 后：正常标识符必须原样（此前是 ta***REDACTED***）：' + s);
  }
  assert.equal(redact('disk-usage'), 'disk-usage', 'sk- 后不足 8 字符的标识符不受影响');
  // 反向守卫：真凭据仍必须掩（不许因为收窄过剥而漏掩）
  assert.ok(redact('sk-abc1234567890abcdef').includes(REDACTED), '真密钥仍须掩');
});

test('t78-f（**t83 后范围收窄**）：显示层「更宽」只对未加形状守卫的模式成立', () => {
  // scanner 刻意放行示例/占位形态（防误报）；redact() 是**显示层掩码**，宁可多掩。
  // t83 后：`sk-` 加了**载荷形状守卫**，`sk-your-key-here` 的载荷是词形态 ⇒ 正则本身就不再命中，
  // 显示层也随之放行（两侧一致）；`Bearer example-token-here` 的 bearer 形状未动 ⇒ 显示层依旧更宽。
  assert.equal(matchSecretValuePattern('sk-your-key-here'), null, 'scanner 侧放行（词形态）：sk-your-key-here');
  assert.equal(redact('sk-your-key-here'), 'sk-your-key-here', 't83 后：显示层与 scanner 一致放行');
  assert.equal(matchSecretValuePattern('Bearer example-token-here'), null, 'scanner 侧放行（示例形态）');
  assert.ok(redact('Bearer example-token-here').includes(REDACTED), 'redact 侧仍掩（显示层更宽，未变）');
});

/* ---------------- URL 内嵌凭据（userinfo 形态）必须掩码 ---------------- */

test('redact：scheme://user:password@host 的密码段被掩码（用户名保留），且幂等', () => {
  const out = redact('clone https://oauth2:GLPAT-SECRETVALUE@gitlab.example.com/u/r.git now');
  assert.equal(out.includes('GLPAT-SECRETVALUE'), false, 'URL 内嵌凭据不得明文保留');
  assert.ok(out.includes('oauth2'), '用户名保留可读（与 URL_QUERY_RE 同一取舍）');
  assert.ok(out.includes('gitlab.example.com'), '主机名不受影响');
  assert.equal(redact(out), out, '幂等：重复脱敏结果不变');
  // query 形态的既有行为不变
  assert.equal(redact('https://h/p?token=abc123456').includes('abc123456'), false, 'query token 仍被掩码');
  // 没有 userinfo 的普通 URL 一字不改
  assert.equal(redact('https://gitlab.example.com/u/r.git'), 'https://gitlab.example.com/u/r.git');
  // createRedactor 与 redact 同源（同一份规则）
  assert.equal(createRedactor()('https://u:p4ssword@h/x').includes('p4ssword'), false);
});
