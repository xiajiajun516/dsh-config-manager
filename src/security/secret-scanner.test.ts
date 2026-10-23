/**
 * 值形状判定（`SECRET_VALUE_PATTERNS` / `matchSecretValuePattern`）的**大小写边界**回归护栏（t72）。
 *
 * 来源：t58（对 t40 的对抗性评审）F1 —— 模式表原先全无 `i` flag，于是 `bearer <token>` / `BEARER <token>`
 * 这类**合法**（RFC 7235 / 6750：auth-scheme 名大小写不敏感）的授权头在 env / headers / url 通道上
 * 明文进包且**完全不可见**（refs / skipped 皆空）。
 *
 * 两条口径（改这条判定的任何人先读 `docs/spec/known-gaps.md` **G-36**）：
 *  ① 规范形态 `Bearer …` 的**行为与历史逐字一致**（命中名仍是 `bearer-token`）：本模块只**补**非规范大小写；
 *  ② 厂商前缀（`sk-` / `AKIA` / `ghp_` / `github_pat_`）**刻意保持大小写敏感** —— `SK-…` 不是真实厂商形态，
 *     全改 `i` 会连带放宽整个脱敏面（日志 / 导出 / 界面渲染前 redact），代价大于收益 ⇒ 登记为**已知边界**
 *     并在 `t72-d` 里钉成事实（未来有人「顺手改成 i」会被这条用例拦下）。
 *
 * t83（本文件后五段）补第二条边界：**`sk-` 的载荷形状守卫** —— `sk-` 后若是「1–24 个纯小写字母/连字符」
 * （英文词/标识符形态）则放行。**不用左边界** `(?<![A-Za-z0-9])`：那会漏剥 t18/t40-b 实测的真实形态
 * `'p'.repeat(10000) + 'sk-…'`（漏剥 = 明文进包）。`AKIA`/`ghp_`/`github_pat_`/`jwt`/`pem`/`bearer` **有意不加**（逐条理由见 `secret-scanner.ts` 表前注释）。
 * 现象：`sk-` 这类短前缀会出现在正常内容里（`task-management` 命中 `sk-management`、`risk-assessment` 命中
 * `sk-assessment`、base64 串内部的 `…vcGVuAKIA…`），而 `src/utils/logger.ts` / core 导出导入扫描 / 界面
 * `redact()` 三条通道共用本表 ⇒ 误剥 = **静默改写用户内容**。只对四个字面前缀模式加（`jwt` / `pem-…` /
 * `bearer-*` 不加，逐条理由见 `secret-scanner.ts` 的表前注释）；真检测不削弱：所有真实出现都由非字母数字界定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchSecretValuePattern } from './secret-scanner.ts';

test('t72-a：Bearer 形态按 RFC 大小写不敏感剥离（bearer / BEARER / BeArEr 全部命中）', () => {
  const cases = [
    'bearer abc12345def',
    'BEARER AbCdEf0123',
    'BeArEr a.b_c-d/e+f=g',
    'bearer ' + 'q'.repeat(30), // ③ 长度 ≥ 24 分支（刻意避开占位词 xxxx）
    'BEARER ' + 'Zq7'.repeat(9), // ② 大小写混排分支
    'bearer AbCdEfGhIj',
    // 值里嵌在别处（真实配置常见：`-H 'authorization: bearer …'`）
    "curl -H 'authorization: bearer abc12345def'",
  ];
  for (const v of cases) assert.equal(matchSecretValuePattern(v), 'bearer-token-anycase', '必须命中：' + v);
});

test('t72-b：规范形态 `Bearer …` 行为不变（命中名仍是 bearer-token；示例 / 占位照旧放行）', () => {
  assert.equal(matchSecretValuePattern('Bearer abcdefghijklmnop'), 'bearer-token');
  assert.equal(matchSecretValuePattern('Authorization: Bearer xyz1234567890abcdef'), 'bearer-token');
  assert.equal(matchSecretValuePattern('Bearer example-token-here'), null, '示例形态沿用降噪口径');
  assert.equal(matchSecretValuePattern('Bearer <token>'), null, '占位符形态不命中（< 不在 token 字符集里）');
  assert.equal(matchSecretValuePattern('Bearer xyz'), null, 'token < 8 字符照旧不命中');
});

test('t72-c：过剥控制 —— 含 bearer 字样的普通文本与普通标识符都不得被剥', () => {
  const prose = [
    'bearer credentials are required',
    'bearer authentication failed',
    'bearer tokens must be rotated',
    'BEARER HEADER NOT SET',
    'the bearer of good news arrived',
    'bearer configuration is missing',
    'bearer uncharacteristically verbose',
    'Bearer of good news',
  ];
  for (const v of prose) assert.equal(matchSecretValuePattern(v), null, '普通文本不得被剥：' + v);
  const ordinary = [
    '550e8400-e29b-41d4-a716-446655440000',
    'a1b2c3d4e5f6a7b8c9d0e1f2',
    'abcdefghijklmnopqrstuvwxyz0123456789abcd',
    '/usr/local/lib/node_modules/@deepseek/very-long-name/bin',
    'npx -y @scope/pkg --out=/tmp/some-file --verbose',
  ];
  for (const v of ordinary) assert.equal(matchSecretValuePattern(v), null, '普通值不得被剥：' + v);
});

test('t72-d：厂商前缀的大小写边界钉成事实（SK- / GHP_ / akia 是**已知边界**，见 known-gaps G-36）', () => {
  // 命中侧：真实厂商形态（小写 sk- / 大写 AKIA / 小写 ghp_）
  assert.equal(matchSecretValuePattern('sk-abcdefghijklmnop0123456789XYZ'), 'openai-style-key');
  assert.equal(matchSecretValuePattern('AKIAIOSFODNN7A1B2C3D4'), 'aws-access-key');
  assert.equal(matchSecretValuePattern('ghp_' + 'AbCdEf0123456789aBcDeF0123456789aB'), 'github-token');
  // 不命中侧：**刻意保留**的大小写边界。改这里 = 改整个脱敏面（日志/导出/界面），需单独决策 ——
  // 若确要收，请连同 known-gaps G-36 与 docs/lessons/security-and-credentials.md 一起改，不要只改死这条断言。
  const boundary = [
    'SK-ABCDEFGHIJKLMNOP0123456789XYZ',
    'Sk-abcdefghijklmnop0123456789XYZ',
    'GHP_AbCdEf0123456789aBcDeF0123456789aB',
    'GITHUB_PAT_' + 'A'.repeat(30),
    'akiaIOSFODNN7EXAMPLE',
  ];
  for (const v of boundary) assert.equal(matchSecretValuePattern(v), null, '大小写变体不在判定内（已知边界）：' + v);
});

/** 前缀型模式的**误剥**输入（前邻字母数字）—— 必须原样保留（t83） */
const PREFIX_FALSE_POSITIVES = [
  'ask-management', 'task-management', 'risk-assessment', 'disk-space-report', 'mosk-abcdefgh',
  'xsk-abcdefgh', 'ask-anything-here', 'risk-assessment-report.md', '/disk-space-report/index',
  '{"task-management": true}', 'a-task-manager', 'my-risk-assessment',
  'ABCsk-abcdefghijk',
]

test('t83-a：前缀型模式的左边界 —— 前邻字母数字的普通内容绝不被误剥（t75 报的 5 例 + 自造同类）', () => {
  for (const v of PREFIX_FALSE_POSITIVES) {
    assert.equal(matchSecretValuePattern(v), null, '不得误剥（前邻字母数字）：' + v);
  }
});

test('t83-b：被剥侧不削弱 —— 每种前缀模式 ≥3 个真实形态仍剥离（含紧贴 = / : / 引号）', () => {
  const SK = 'sk-abcdefghijklmnop0123456789XYZ';
  const cases: readonly (readonly [string, string])[] = [
    ['openai-style-key', SK],
    ['openai-style-key', 'sk-proj-AbCdEf0123456789aBcDeF0123456789'],
    ['openai-style-key', 'sk-ant-api03-AbCdEf0123456789aBcDeF'],
    ['openai-style-key', 'token=' + SK],
    ['openai-style-key', '{"key":"' + SK + '"}'],
    ['openai-style-key', 'apikey=' + SK],
    ['openai-style-key', 'MY_' + SK],
    ['openai-style-key', 'x-' + SK],
    ['aws-access-key', 'AKIA0123456789ABCDEF'],
    ['aws-access-key', 'AKIAIOSFODNN7A1B2C3D4'],
    ['aws-access-key', 'AWS_KEY=AKIA0123456789ABCDEF'],
    ['aws-access-key', '"AKIA0123456789ABCDEF"'],
    ['github-token', 'ghp_AbCdEf0123456789aBcDeF0123456789aB'],
    ['github-token', 'gho_AbCdEf0123456789aBcDeF0123456789aB'],
    ['github-token', 'x-access-token:ghp_AbCdEf0123456789aBcDeF0123456789aB'],
    ['github-pat', 'github_pat_AbCdEf0123456789aBcDeF'],
    ['github-pat', 'Authorization: github_pat_AbCdEf0123456789aBcDeF'],
    ['github-pat', '{"t":"github_pat_AbCdEf0123456789aBcDeF"}'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'],
    ['pem-private-key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['pem-private-key', '"-----BEGIN EC PRIVATE KEY-----"'],
  ];
  for (const [want, v] of cases) {
    assert.equal(matchSecretValuePattern(v), want, '真实形态必须仍剥离（want=' + want + '）：' + v);
  }
});

test('t83-c：t72 的两条边界未回退（大小写敏感前缀 + bearer scheme 不敏感）', () => {
  assert.equal(matchSecretValuePattern('SK-ABCDEFGHIJKLMNOP0123456789XYZ'), null, 'SK- 仍不剥（G-36 已登记边界）');
  assert.equal(matchSecretValuePattern('GHP_AbCdEf0123456789aBcDeF0123456789aB'), null, 'GHP_ 仍不剥');
  assert.equal(matchSecretValuePattern('akiaIOSFODNN7EXAMPLE'), null, 'akia 仍不剥');
  for (const c of ['bearer', 'BEARER', 'BeArEr']) {
    assert.equal(matchSecretValuePattern(c + ' abc12345def'), 'bearer-token-anycase', 'bearer 仍大小写不敏感：' + c);
  }
  assert.equal(matchSecretValuePattern('Bearer abc12345def'), 'bearer-token', '规范形态命中名逐字不变');
  assert.equal(matchSecretValuePattern('the bearer of this token'), null, '散文仍不剥');
  assert.equal(matchSecretValuePattern('BEARER HEADER NOT SET'), null, '全大写散文仍不剥');
});

test('t83-d：加边界只排「左侧紧邻字母数字」一种形态 —— 未被加边界的模式行为逐字不变', () => {
  // jwt / pem / bearer 的 glued 形态仍按原判据命中（证明本任务没有动它们的判定）
  assert.equal(
    matchSecretValuePattern('blobeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c'),
    'jwt',
    'jwt 判据未改（不含左边界）',
  );
  assert.equal(matchSecretValuePattern('xxBearer abc12345def'), 'bearer-token', '规范 Bearer 判据未改');
  // 行首 / 空白 / 分隔符后仍命中（负向断言不影响任何非字母数字左侧）
  const SK = 'sk-abcdefghijklmnop0123456789XYZ';
  for (const v of [SK, ' ' + SK, '\t' + SK, '\n' + SK, '\"' + SK, '(' + SK + ')', '[' + SK + ']', '=' + SK]) {
    assert.equal(matchSecretValuePattern(v), 'openai-style-key', '非字母数字左侧必须仍命中：' + JSON.stringify(v));
  }
});

test('t83-e：redact() 通道（派生自同一张表）同步受益：正常词不再被打码、真密钥仍打码', async () => {
  const { redact } = await import('./redaction.ts');
  assert.equal(redact('risk-assessment'), 'risk-assessment', '正常词不得被改写');
  assert.equal(redact('/disk-space-report/index'), '/disk-space-report/index', '路径不得被改写');
  assert.equal(redact('task-management'), 'task-management', '正常词不得被改写');
  assert.notEqual(redact('sk-abcdefghijklmnop0123456789XYZ'), 'sk-abcdefghijklmnop0123456789XYZ', '真密钥仍须打码');
});

test('t83-f：不得削弱真检测 —— t18 实测的「1 万字符内嵌」形态仍被剥（载荷守卫的关键取舍）', () => {
  const SK = 'sk-abcdefghijklmnop0123456789XYZ';
  const GH = 'ghp_AbCdEf0123456789aBcDeF0123456789aB';
  const AKIA = 'AKIA0123456789ABCDEF';
  // t40-b/t40-c 的真实形态：密钥紧贴 1 万个 p 之后（左边界方案会在这里漏剥）
  assert.equal(matchSecretValuePattern('p'.repeat(10000) + SK), 'openai-style-key', '长串内嵌 sk- 必须仍命中');
  assert.equal(matchSecretValuePattern('p'.repeat(10000) + GH), 'github-token', '长串内嵌 ghp_ 必须仍命中');
  assert.equal(matchSecretValuePattern('p'.repeat(10000) + AKIA), 'aws-access-key', '长串内嵌 AKIA 必须仍命中');
});

test('t83-g：逐模式判断的登记 —— 未加边界的模式行为**逐字不变**、sk- 残余边界钉成事实', () => {
  // ① 未加边界的四条：前邻字母数字仍命中（人为拼接形态，非正常内容；加边界会削弱长串内嵌检出）
  assert.equal(matchSecretValuePattern('xAKIA0123456789ABCDEF'), 'aws-access-key', 'AKIA 有意不加边界');
  assert.equal(matchSecretValuePattern('xghp_AbCdEf0123456789aBcDeF0123456789aB'), 'github-token', 'ghp_ 有意不加边界');
  assert.equal(matchSecretValuePattern('xgithub_pat_AbCdEf0123456789aBcDeF'), 'github-pat', 'github_pat_ 有意不加边界');
  assert.equal(matchSecretValuePattern('xxBearer abc12345def'), 'bearer-token', 'bearer 判据未改');
  // ② 已登记残余：`sk-` + ≤24 个纯小写字母/连字符（无数字无大写）不再命中；≥25 位仍命中
  assert.equal(matchSecretValuePattern('sk-' + 'a'.repeat(20)), null, '残余边界：短纯小写载荷不命中（有意）');
  assert.equal(matchSecretValuePattern('sk-' + 'a'.repeat(25)), 'openai-style-key', '长纯小写载荷仍命中');
});
