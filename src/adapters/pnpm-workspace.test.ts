/**
 * issue #35 回归：patchedDependencies 的解析与「目标机没有 patch 文件」条目的剔除。
 * 目标：绝不把「声明存在、文件不存在」的组合写到目标机（否则 pnpm 拒绝一切 add）。
 *
 * 跨机可移植性回归（④）：机器相关 pnpm 路径键的行级剥离与「本机设置保留」的回接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePnpmPatchedDependencies, restorePnpmMachinePaths, sanitizePnpmWorkspacePatches, stripPnpmMachinePaths,
} from './pnpm-workspace.ts';

const SOURCE = [
  'packages:',
  "  - 'plugins/*'",
  'allowBuilds:',
  '  ssh2: true',
  'patchedDependencies:',
  '  dsh-approval-gate: patches/dsh-approval-gate.patch',
  '  dsh-whale-galgame: patches/dsh-whale-galgame.patch',
  'minimumReleaseAgeExclude:',
  '  - dsh-config-manager',
  '',
].join('\n');

test('parse：读出全部声明（含引号/行尾注释）', () => {
  const r = parsePnpmPatchedDependencies(SOURCE);
  assert.equal(r.unsupported, null);
  assert.deepEqual(r.declared, [
    { name: 'dsh-approval-gate', path: 'patches/dsh-approval-gate.patch' },
    { name: 'dsh-whale-galgame', path: 'patches/dsh-whale-galgame.patch' },
  ]);
  const quoted = parsePnpmPatchedDependencies("patchedDependencies:\n  a: 'p/a.patch' # 说明\n");
  assert.deepEqual(quoted.declared, [{ name: 'a', path: 'p/a.patch' }]);
});

test('sanitize：patch 文件都在 → 逐字节不变（保留注释与格式）', () => {
  const r = sanitizePnpmWorkspacePatches(SOURCE, () => true);
  assert.equal(r.text, SOURCE, '无需修改时必须原样返回');
  assert.deepEqual(r.dropped, []);
});

test('sanitize：目标机缺文件 → 只删那一条（issue #35 的复现路径）', () => {
  const r = sanitizePnpmWorkspacePatches(SOURCE, (rel) => rel === 'patches/dsh-approval-gate.patch');
  assert.deepEqual(r.dropped.map((d) => d.name), ['dsh-whale-galgame']);
  assert.ok(r.text.includes('dsh-approval-gate: patches/dsh-approval-gate.patch'), '可用的条目必须保留');
  assert.ok(!r.text.includes('dsh-whale-galgame'), '缺文件的条目必须整行消失');
  // 其余配置一字不动
  assert.ok(r.text.includes('allowBuilds:\n  ssh2: true'));
  assert.ok(r.text.includes('minimumReleaseAgeExclude:\n  - dsh-config-manager'));
});

test('sanitize：全部条目都缺 → 连 patchedDependencies 键一起删（不留空键）', () => {
  const r = sanitizePnpmWorkspacePatches(SOURCE, () => false);
  assert.equal(r.dropped.length, 2);
  assert.ok(!r.text.includes('patchedDependencies'), '空键也必须删掉');
  assert.ok(r.text.includes('packages:'), '其它键不受影响');
  assert.ok(r.text.includes('minimumReleaseAgeExclude:'), '键之后的块不得被误删');
});

test('sanitize：越界/绝对路径的声明同样移除（目标机不可读，pnpm 亦拒绝）', () => {
  const text = "patchedDependencies:\n  a: ../outside/a.patch\n  b: C:/abs/b.patch\n  c: p/c.patch\n";
  const r = sanitizePnpmWorkspacePatches(text, () => true);
  assert.deepEqual(r.dropped.map((d) => d.name).sort(), ['a', 'b']);
  assert.ok(r.text.includes('c: p/c.patch'));
});

test('sanitize：单行 flow 形态不猜着改，返回 unsupported 供上层告警', () => {
  const text = 'patchedDependencies: {a: p/a.patch}\nallowBuilds:\n  ssh2: true\n';
  const r = sanitizePnpmWorkspacePatches(text, () => false);
  assert.equal(r.text, text, '不支持的形态必须原样返回，绝不半改');
  assert.ok(r.unsupported !== null);
});

test('sanitize：CRLF 文本保留 CRLF；块内注释随被删条目一起消失', () => {
  const text = 'patchedDependencies:\r\n  # 旧补丁\r\n  a: p/a.patch\r\n  b: p/b.patch\r\nother: 1\r\n';
  const r = sanitizePnpmWorkspacePatches(text, (rel) => rel === 'p/b.patch');
  assert.equal(r.text.includes('\r\n'), true, 'CRLF 不得被改成 LF');
  assert.ok(!r.text.includes('a: p/a.patch'));
  assert.ok(!r.text.includes('旧补丁'), '被删条目的注释一并移除');
  assert.ok(r.text.includes('b: p/b.patch'));
  assert.ok(r.text.includes('other: 1'));
});

test('sanitize：没有 patchedDependencies 时不产生任何改动', () => {
  const text = 'allowBuilds:\n  ssh2: true\n';
  const r = sanitizePnpmWorkspacePatches(text, () => false);
  assert.equal(r.text, text);
  assert.deepEqual(r.declared, []);
  assert.equal(r.unsupported, null);
});

/* ---------------- 可移植性净化：机器相关路径键（④） ---------------- */

test('strip：剥离根层机器路径键（含 kebab 方言），其余内容与注释逐字不变', () => {
  const text = [
    'storeDir: D:/pnpm-store',
    'packages:',
    "  - 'plugins/*'",
    'cache-dir: C:/pnpm-cache  # 注释也一起走',
    'allowBuilds:',
    '  ssh2: true',
    'minimumReleaseAge: 1440',
    '',
  ].join('\n');
  const r = stripPnpmMachinePaths(text);
  assert.deepEqual(r.stripped, ['storeDir', 'cache-dir']);
  assert.equal(r.text, [
    'packages:',
    "  - 'plugins/*'",
    'allowBuilds:',
    '  ssh2: true',
    'minimumReleaseAge: 1440',
    '',
  ].join('\n'));
});

test('strip：不含机器路径键 → 逐字节不变（含缩进块 / 行尾注释 / 行尾缺换行）', () => {
  const text = "# 本机配置\nallowBuilds:\n  ssh2: true  # 说明\npatchedDependencies:\n  a: patches/a.patch";
  const r = stripPnpmMachinePaths(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.stripped, []);
  const empty = stripPnpmMachinePaths('');
  assert.equal(empty.text, '');
  assert.deepEqual(empty.stripped, []);
});

test('strip：只有根层才算设置 —— 缩进块里的同名键一律不碰', () => {
  const text = 'pluginFoo:\n  storeDir: /nested/path\nstoreDir: /root/path\n';
  const r = stripPnpmMachinePaths(text);
  assert.deepEqual(r.stripped, ['storeDir']);
  assert.equal(r.text, 'pluginFoo:\n  storeDir: /nested/path\n');
});

test('strip：CRLF 输入不引入 LF 漂移（被删行之外逐字保留 CRLF）', () => {
  const text = 'storeDir: D:/pnpm-store\r\nallowBuilds:\r\n  ssh2: true\r\n';
  const r = stripPnpmMachinePaths(text);
  assert.equal(r.text, 'allowBuilds:\r\n  ssh2: true\r\n');
  assert.ok(!r.text.includes('\n\n'), '不得产生空行');
});

test('strip：块标量形态连缩进续行一起删（不留孤儿缩进行 → 不产出坏 YAML）', () => {
  const text = 'storeDir: |\n  D:/pnpm-store\nallowBuilds:\n  ssh2: true\n';
  const r = stripPnpmMachinePaths(text);
  assert.equal(r.text, 'allowBuilds:\n  ssh2: true\n');
});

test('strip：整份文件只有机器路径键 → 结果为空（上层据此不再携带该单元）', () => {
  const r = stripPnpmMachinePaths('storeDir: D:/pnpm-store\n');
  assert.equal(r.text, '');
  assert.deepEqual(r.stripped, ['storeDir']);
});

test('restore：接回本机原有的机器路径行（来源机的路径早已被剥离）', () => {
  const local = 'storeDir: D:/pnpm-store\nallowBuilds:\n  ssh2: true\n';
  const incoming = 'allowBuilds:\n  ssh2: false\n';
  const r = restorePnpmMachinePaths(incoming, local);
  assert.deepEqual(r.restored, ['storeDir']);
  assert.equal(r.text, 'allowBuilds:\n  ssh2: false\nstoreDir: D:/pnpm-store\n');
});

test('restore：本机没有这些键 / 本机没有该文件 / incoming 为空 → 原样返回', () => {
  const incoming = 'allowBuilds:\n  ssh2: false\n';
  assert.deepEqual(restorePnpmMachinePaths(incoming, null), { text: incoming, restored: [] });
  assert.deepEqual(restorePnpmMachinePaths(incoming, ''), { text: incoming, restored: [] });
  assert.deepEqual(restorePnpmMachinePaths(incoming, 'packages:\n  - "*"\n'), { text: incoming, restored: [] });
  assert.deepEqual(restorePnpmMachinePaths('', 'storeDir: /x\n'), { text: '', restored: [] });
});

test('restore：接回行沿用 incoming 的 EOL；incoming 无尾换行时先补齐', () => {
  const crlf = restorePnpmMachinePaths('allowBuilds:\r\n  ssh2: false\r\n', 'storeDir: D:/s\r\n');
  assert.equal(crlf.text, 'allowBuilds:\r\n  ssh2: false\r\nstoreDir: D:/s\r\n');
  const noTail = restorePnpmMachinePaths('allowBuilds:', 'storeDir: D:/s\n');
  assert.equal(noTail.text, 'allowBuilds:\nstoreDir: D:/s\n');
});
