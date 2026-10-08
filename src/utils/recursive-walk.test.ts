/**
 * issue #37 回归：递归遍历必须**跟随**目录 junction / 符号链接（此前静默跳过，备份报成功但缺内容），
 * 并如实报告「跟随了什么 / 跳过了什么」。
 *
 * 用真实临时目录 + 真实链接（Windows 用 junction，无需管理员权限）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRecursiveFollowingLinks } from './recursive-walk.ts';

function tmpDir(prefix: string): string {
  return fssync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建目录链接：win32 用 junction（不需要管理员/开发者模式），其它平台用 dir 符号链接。 */
async function linkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

test('issue #37：跟随目录链接收集内容；越界/断链/自引用链接跳过并留痕', async (t) => {
  const home = tmpDir('dshcm-home-');
  const outside = tmpDir('dshcm-outside-');
  t.after(() => {
    fssync.rmSync(home, { recursive: true, force: true });
    fssync.rmSync(outside, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(home, 'skills', 'real'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'a.md'), 'A');
  await fs.writeFile(path.join(home, 'skills', 'real', 'inner.md'), 'INNER');
  await fs.writeFile(path.join(outside, 'secret.md'), 'OUTSIDE');

  // ① 指向 home 内真实目录的链接（issue #37 的核心场景：技能共享 shared/ scripts/）
  const okLink = await linkDir(path.join(home, 'skills', 'real'), path.join(home, 'skills', 'link-dir'));
  if (!okLink) {
    t.skip('本环境无法创建目录链接（权限受限），跳过 junction 跟随用例');
    return;
  }
  // ② 自引用链接（指向祖先目录）→ 必须终止并记为 loop
  await linkDir(path.join(home, 'skills'), path.join(home, 'skills', 'self'));
  // ③ 断链
  await fs.symlink(path.join(home, 'skills', 'nope'), path.join(home, 'skills', 'broken'));
  // ④ 指向 home 之外
  await linkDir(outside, path.join(home, 'skills', 'outside'));

  const listing = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);

  // 真实内容一个都不能少：真实目录 + 链接目录两条路径都收集（此前 link-dir 整块丢失）
  assert.ok(listing.paths.includes('skills/a.md'), `缺 a.md: ${listing.paths.join(',')}`);
  assert.ok(listing.paths.includes('skills/real/inner.md'), `缺 real/inner.md: ${listing.paths.join(',')}`);
  assert.ok(
    listing.paths.includes('skills/link-dir/inner.md'),
    `链接目录内容必须进备份（issue #37 根因）: ${listing.paths.join(',')}`,
  );
  assert.ok(
    !listing.paths.some((p) => p.includes('outside')),
    'home 之外的目标不得进备份（既有边界不变）',
  );
  assert.ok(!listing.paths.some((p) => p.includes('self')), '自引用链接不得递归展开');

  // 跳过项必须留痕（用户能从报告里知道内容不全）
  const byReason = new Map(listing.skippedLinks.map((s) => [s.path, s.reason]));
  assert.equal(byReason.get('skills/self'), 'loop');
  assert.equal(byReason.get('skills/outside'), 'outside-home');
  assert.equal(byReason.get('skills/broken'), 'broken');
  assert.equal(listing.followedLinks >= 1, true, '至少一个链接被成功跟随');
});

test('issue #37：链接指向同一目标只展开一次（防环 + 防重复）', async (t) => {
  const home = tmpDir('dshcm-home2-');
  t.after(() => fssync.rmSync(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, 'skills', 'target'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'target', 'x.md'), 'X');
  const a = await linkDir(path.join(home, 'skills', 'target'), path.join(home, 'skills', 'l1'));
  const b = await linkDir(path.join(home, 'skills', 'target'), path.join(home, 'skills', 'l2'));
  if (!a || !b) {
    t.skip('本环境无法创建目录链接，跳过用例');
    return;
  }
  const listing = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);
  const hits = listing.paths.filter((p) => p.endsWith('x.md'));
  // target 自身 + 其中一个链接；另一个链接被判为 loop（内容不会重复两遍）
  assert.equal(hits.length, 2, `同一目标只应展开一次（+真实目录）: ${listing.paths.join(',')}`);
  assert.equal(listing.skippedLinks.filter((s) => s.reason === 'loop').length, 1);
});

test('issue #37：指向 home 之外的**文件**链接不得被读入（目录链接与文件链接同一判据）', async (t) => {
  const home = tmpDir('dshcm-home4-');
  const outside = tmpDir('dshcm-out5-');
  t.after(() => {
    fssync.rmSync(home, { recursive: true, force: true });
    fssync.rmSync(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(home, 'skills'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'ok.md'), 'OK');
  await fs.writeFile(path.join(outside, 'secret.md'), 'SECRET');
  // 文件链接（不是目录链接）：目标在 home 外
  try {
    await fs.symlink(path.join(outside, 'secret.md'), path.join(home, 'skills', 'leak.md'), 'file');
  } catch {
    t.skip('本环境无法创建文件符号链接，跳过');
    return;
  }
  const listing = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);
  assert.deepEqual(listing.paths, ['skills/ok.md'], `home 外的文件链接不得进清单: ${listing.paths.join(',')}`);
  assert.equal(listing.skippedLinks.find((s) => s.path === 'skills/leak.md')?.reason, 'outside-home');

  // home 内的文件链接 → 跟随（内容属于配置 home，可安全备份）
  await fs.writeFile(path.join(home, 'skills', 'inside.md'), 'INSIDE');
  try {
    await fs.symlink(path.join(home, 'skills', 'inside.md'), path.join(home, 'skills', 'alias.md'), 'file');
  } catch {
    t.skip('本环境无法创建文件符号链接，跳过');
    return;
  }
  const listing2 = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);
  assert.ok(listing2.paths.includes('skills/alias.md'), `home 内的文件链接应被跟随: ${listing2.paths.join(',')}`);
});

test('issue #37：目录不可读不中断整次遍历；base 不在 home 内返回空', async (t) => {
  const home = tmpDir('dshcm-home3-');
  const elsewhere = tmpDir('dshcm-else-');
  t.after(() => {
    fssync.rmSync(home, { recursive: true, force: true });
    fssync.rmSync(elsewhere, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(home, 'skills'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'ok.md'), 'OK');
  await fs.writeFile(path.join(elsewhere, 'x.md'), 'X');
  // 目录不存在 → 空清单（既有语义：目录不存在视为空）
  const missing = await listRecursiveFollowingLinks(path.join(home, 'nope'), home);
  assert.deepEqual(missing.paths, []);
  // base 越界 → 空清单，绝不把 home 之外的东西列出来
  const escaped = await listRecursiveFollowingLinks(elsewhere, home);
  assert.deepEqual(escaped.paths, []);
  // 正常路径仍可遍历
  const ok = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);
  assert.deepEqual(ok.paths, ['skills/ok.md']);
});

test('cli-F2：超过深度上限的**普通目录**必须留痕，不得静默丢内容', async (t) => {
  const home = tmpDir('dshcm-deep-');
  t.after(() => fssync.rmSync(home, { recursive: true, force: true }));
  let deep = path.join(home, 'skills');
  await fs.mkdir(deep, { recursive: true });
  for (let i = 0; i < 70; i += 1) deep = path.join(deep, 'd');
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, 'leaf.md'), 'LEAF');

  const listing = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);
  // 既有上限不变：超深内容本来就不会进清单（防病态目录树/栈爆炸）
  assert.ok(!listing.paths.some((p) => p.endsWith('leaf.md')), '超深内容不应进清单');
  // 但**必须留痕**：修复前 skippedLinks 与 unreadableDirs 都是空的 → 「备份成功但缺内容」
  assert.ok(
    listing.skippedLinks.some((s) => s.reason === 'too-deep'),
    '普通目录超深必须记 too-deep，实际: ' + JSON.stringify(listing.skippedLinks),
  );
});

test('issue #76：node_modules（任意深度）整棵跳过并留痕；同名文件与相似名不受影响', async (t) => {
  const home = tmpDir('dshcm-deps-');
  t.after(() => fssync.rmSync(home, { recursive: true, force: true }));

  // 技能本体（依赖树之外的每一个文件都必须照常进清单）
  await fs.mkdir(path.join(home, 'skills', 'md2pdf', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'md2pdf', 'SKILL.md'), 'S');
  await fs.writeFile(path.join(home, 'skills', 'md2pdf', 'package.json'), '{}');
  await fs.writeFile(path.join(home, 'skills', 'md2pdf', 'scripts', 'convert.js'), 'C');
  // 自带依赖树（真机现场：11 625 个文件 → skills 分区 11 629 条 → 撞 10 000 条目闸门）
  const deps = path.join(home, 'skills', 'md2pdf', 'node_modules', 'marked', 'lib');
  await fs.mkdir(deps, { recursive: true });
  for (let i = 0; i < 25; i += 1) await fs.writeFile(path.join(deps, 'f' + i + '.js'), 'x');
  // 任意深度同样生效
  await fs.mkdir(path.join(home, 'skills', 'deep', 'a', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'deep', 'a', 'node_modules', 'pkg', 'i.js'), 'x');
  // 判据是「目录名」，不是子串：同名文件与相似名一律保留
  await fs.mkdir(path.join(home, 'skills', 'plain'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'plain', 'node_modules'), 'A REGULAR FILE NAMED node_modules');
  await fs.writeFile(path.join(home, 'skills', 'notes-node_modules'), 'NOT A DEP DIR');
  await fs.writeFile(path.join(home, 'skills', 'node_modules.md'), 'NOT A DEP DIR');

  const listing = await listRecursiveFollowingLinks(path.join(home, 'skills'), home);

  assert.deepEqual(
    listing.paths.filter((p) => p.includes('node_modules/')),
    [],
    '依赖树一个文件都不得进清单: ' + listing.paths.join(','),
  );
  assert.ok(listing.paths.includes('skills/md2pdf/SKILL.md'), '技能本体必须照常进清单');
  assert.ok(listing.paths.includes('skills/md2pdf/package.json'), 'package.json 留在包里（目标机据此重建依赖）');
  assert.ok(listing.paths.includes('skills/md2pdf/scripts/convert.js'));
  assert.ok(listing.paths.includes('skills/plain/node_modules'), '同名**文件**不是依赖目录，不得误丢');
  assert.ok(listing.paths.includes('skills/notes-node_modules'));
  assert.ok(listing.paths.includes('skills/node_modules.md'));

  // 留痕：目录 + 文件数（否则又是「备份成功但缺内容」）
  const skipped = new Map(listing.skippedDepDirs.map((d) => [d.path, d.files]));
  assert.equal(skipped.get('skills/md2pdf/node_modules'), 25, '必须报出依赖目录的文件数');
  assert.equal(skipped.get('skills/deep/a/node_modules'), 1, '任意深度的依赖目录同样留痕');
  assert.equal(listing.skippedLinks.length, 0, '依赖目录不是链接跳过，不得混进 skippedLinks');
});

