/**
 * T2 单测：CLI 层接线回归（`verify` / `backup` 的参数解析与退出码语义）。
 *
 * 与 backup-verify.test.ts 的分工：
 *  - 该文件测**引擎层**（verifyBackupZip / collectBackupEntries 的裁决与收集语义）；
 *  - 本文件测**CLI 接线**：parseCli 的接受/拒绝矩阵，以及 runCli 在错误路径上的
 *    退出码与 `--json` 可解析性（CI 断言依赖这一点）。
 *
 * 刻意只覆盖不依赖真实 $DSH_HOME 的路径：真实打包/校验的端到端矩阵由验收脚本执行，
 * 单测绝不写盘到用户 home。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCli, runCli, resolveExportsDir, resolveDataDir, type CliIo } from '../../src/cli/index.ts';

const captureIo = (): { io: CliIo; out: string[] } => {
  const out: string[] = [];
  return { io: { log: (s) => out.push(s), error: (s) => out.push(s) }, out };
};

test('T2-C1 parseCli：接受 verify / backup，并正确拒绝错误参数组合', () => {
  const v = parseCli(['verify']);
  assert.equal(v.ok, true);
  assert.equal(v.ok === true ? v.options.command : '', 'verify');
  assert.equal(v.ok === true ? v.options.json : true, false, '--json 缺省 false');
  assert.deepEqual(v.ok === true ? v.options.positionals : [], []);

  const vj = parseCli(['verify', '--json']);
  assert.equal(vj.ok === true ? vj.options.json : false, true);

  const vp = parseCli(['verify', 'some-backup.zip']);
  assert.equal(vp.ok === true ? vp.options.positionals[0] : '', 'some-backup.zip', '位置参数应被接受');

  const vi = parseCli(['verify', '--id', 'one.zip']);
  assert.equal(vi.ok === true ? vi.options.id : '', 'one.zip', '--id 与位置参数同义');

  const b = parseCli(['backup', '--sections', 'skills,self', '--out', 'x.zip', '--dry-run']);
  assert.equal(b.ok, true);
  assert.equal(b.ok === true ? b.options.sections : '', 'skills,self');
  assert.equal(b.ok === true ? b.options.out : '', 'x.zip');
  assert.equal(b.ok === true ? b.options.dryRun : false, true, 'backup 支持 --dry-run');

  // 拒绝矩阵：每条都必须 ok:false（由 runCli 转为退出码 1）
  for (const args of [
    ['verify', '--sections', 'skills'],      // verify 不支持 --sections
    ['backup', '--id', 'x'],                 // backup 不支持 --id
    ['backup', '--sections', 'settings'],    // 离线不可收集分区（需 DSH Service）
    ['backup', '--sections', 'frobnicate'],  // 未知分区
    ['verify', 'a.zip', 'b.zip'],            // verify 只接受一个目标
    ['verify', '--bogus'],
    ['backup', '--sections'],                // 缺值
    ['backup', '--json'],                    // --json 仅 verify 有效，避免误以为 backup 输出 JSON
  ]) {
    const r = parseCli(args);
    assert.equal(r.ok, false, `应拒绝: ${args.join(' ')}`);
  }
});

test('T2-C2 parseCli：既有子命令的约束未被破坏（回归保护）', () => {
  // 老约束仍在：snapshots/restore/reinstall/recover-stale-lock 的行为不变
  assert.equal(parseCli(['snapshots', '--id', 'x']).ok, false, 'snapshots 仍不允许 --id');
  assert.equal(parseCli(['snapshots', '--dry-run']).ok, false, 'snapshots 仍不允许 --dry-run');
  assert.equal(parseCli(['restore', '--yes']).ok, false, 'restore 仍不允许 --yes');
  assert.equal(parseCli(['restore', '--bogus']).ok, false, '未知参数仍拒绝');
  // 未知子命令仍拒绝
  assert.equal(parseCli(['frobnicate']).ok, false);
  // help 仍可用
  for (const a of [['--help'], ['-h'], ['help']]) {
    const r = parseCli(a);
    assert.equal(r.ok === true ? r.options.command : '', 'help');
  }
});

test('T2-C3 resolveExportsDir：--data-dir 覆盖优先，缺省 $DSH_HOME/dsh-config-manager/exports', () => {
  const home = path.join('/custom', 'home');
  assert.equal(
    resolveExportsDir(undefined, { DSH_HOME: home }),
    path.join(home, 'dsh-config-manager', 'exports'),
  );
  assert.equal(resolveExportsDir('/flag/dir', { DSH_HOME: home }), '/flag/dir', '--data-dir 覆盖');
  // 与快照目录同源（同一次调用只差末级目录名），保证两命令默认指向同一 dataDir
  assert.equal(
    path.dirname(resolveExportsDir(undefined, { DSH_HOME: home })),
    path.dirname(resolveDataDir(undefined, { DSH_HOME: home })),
  );
});

test('T2-C4 runCli verify --json：无目标时输出可解析 JSON 且 exit 1（CI 不能拿到空 stdout）', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-absent-${process.pid}-${Date.now()}`);
  const { io, out } = captureIo();
  const code = await runCli(
    ['verify', '--json', '--data-dir', path.join(home, 'definitely-missing-exports')],
    io,
    { DSH_HOME: home },
  );
  assert.equal(code, 1, '无目标必须 exit 1');
  const parsed = JSON.parse(out.join('\n')) as { error?: unknown };
  assert.equal(typeof parsed.error, 'string', '错误路径也必须给出 error 字符串（CI 用 jq 断言）');
});

test('T2-C5 runCli verify（人读）：无目标时给出可读错误且 exit 1', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-absent2-${process.pid}-${Date.now()}`);
  const { io, out } = captureIo();
  const code = await runCli(
    ['verify', '--data-dir', path.join(home, 'nope-exports')],
    io,
    { DSH_HOME: home },
  );
  assert.equal(code, 1);
  const text = out.join('\n');
  assert.match(text, /导出目录|export directory/, '应给出可读原因');
});

test('T2-C6 runCli verify（显式不存在的文件）→ MISSING 且 exit 1', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-absent3-${process.pid}-${Date.now()}`);
  const { io, out } = captureIo();
  const code = await runCli(
    ['verify', 'no-such-backup.zip', '--data-dir', path.join(home, 'exports')],
    io,
    { DSH_HOME: home },
  );
  assert.equal(code, 1, 'MISSING 也是非 OK → exit 1');
  assert.match(out.join('\n'), /MISSING/, '应输出 MISSING 裁决');
});

test('T2-C7 runCli backup：空 home → exit 1 且不写任何文件（如实报「没有可打包的内容」）', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-empty-${process.pid}-${Date.now()}`);
  const { io, out } = captureIo();
  const code = await runCli(['backup', '--data-dir', path.join(home, 'exports')], io, { DSH_HOME: home });
  assert.equal(code, 1, '无内容应 exit 1 而不是产出一个空备份');
  assert.match(out.join('\n'), /没有可打包的内容|nothing to back up/);
});

test('T2-C8 runCli backup --dry-run：空 home 也不写文件（零写入）', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-empty2-${process.pid}-${Date.now()}`);
  const exportsDir = path.join(home, 'exports');
  const { io } = captureIo();
  const code = await runCli(['backup', '--dry-run', '--data-dir', exportsDir], io, { DSH_HOME: home });
  assert.equal(code, 1, '空内容同样拒绝（不在 dry-run 里假装能备份）');
  // dry-run 必须零写入：导出目录不得被创建（用 stat 判定，避免 assert.rejects 的重载歧义）
  let created = false;
  try {
    await fs.stat(exportsDir);
    created = true;
  } catch {
    created = false;
  }
  assert.equal(created, false, 'dry-run 不得创建导出目录');
});

test('T2-C9 runCli backup --dry-run：**有内容时**也必须零写入（真实缺陷回归）', async () => {
  // 回归背景：T2-C8 只覆盖「空 home → 提前 return」，
  // 因而漏掉了「有内容时 dry-run 仍会 mkdir 导出目录」的零写入违约。
  const home = path.join(os.tmpdir(), `dsh-cm-t2-dry-${process.pid}-${Date.now()}`);
  await fs.mkdir(path.join(home, 'skills'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'a.md'), '# a\n', 'utf8');
  const exportsDir = path.join(home, 'exports');

  const { io, out } = captureIo();
  const code = await runCli(['backup', '--dry-run', '--data-dir', exportsDir], io, { DSH_HOME: home });
  assert.equal(code, 0, '有内容时 dry-run 应 exit 0');
  assert.match(out.join('\n'), /备份计划/, '应打印计划');
  assert.match(out.join('\n'), /custom\/skills|skills/, '计划应含将被打包的分区');

  let created = false;
  try {
    await fs.stat(exportsDir);
    created = true;
  } catch {
    created = false;
  }
  assert.equal(created, false, 'dry-run 有内容时同样不得创建导出目录（零写入）');

  await fs.rm(home, { recursive: true, force: true });
});

test('T2-C10 runCli backup：有内容时真实落盘 + 自检 OK（dry-run 修复不得破坏写入路径）', async () => {
  const home = path.join(os.tmpdir(), `dsh-cm-t2-real-${process.pid}-${Date.now()}`);
  await fs.mkdir(path.join(home, 'skills'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'a.md'), '# a\n', 'utf8');
  await fs.writeFile(path.join(home, '.credentials.yaml'), 'API_KEY: must-not-leak\n', 'utf8');
  const exportsDir = path.join(home, 'exports');

  const { io, out } = captureIo();
  const code = await runCli(['backup', '--data-dir', exportsDir], io, { DSH_HOME: home });
  assert.equal(code, 0, `应成功：${out.join('\n')}`);
  assert.match(out.join('\n'), /自检通过|self-verification OK/, '落盘后必须自检通过');

  const written = (await fs.readdir(exportsDir)).filter((f) => f.endsWith('.zip'));
  assert.equal(written.length, 1, '应写出 1 个 zip');

  // 凭据文件内容不得进入归档字节
  const buf = await fs.readFile(path.join(exportsDir, written[0]!));
  assert.ok(!buf.toString('utf8').includes('must-not-leak'), '凭据明文不得进归档');

  await fs.rm(home, { recursive: true, force: true });
});

test('T2-C11 backup 产出的 manifest.exporter.version 必须与 package.json 一致（无版本漂移点）', async () => {
  // 回归背景：曾把版本写成硬编码常量，插件升到 0.1.59 后该常量仍停在 0.1.58，
  // 导致新产出的备份被标成旧版本。本用例锁定「运行时读取 package.json」。
  const home = path.join(os.tmpdir(), 'dsh-cm-t2-ver-' + process.pid + '-' + Date.now());
  await fs.mkdir(path.join(home, 'skills'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'a.md'), '# a\n', 'utf8');
  const exportsDir = path.join(home, 'exports');
  const { io } = captureIo();
  const code = await runCli(['backup', '--data-dir', exportsDir], io, { DSH_HOME: home });
  assert.equal(code, 0, 'backup 应成功');

  const zip = (await fs.readdir(exportsDir)).find((f) => f.endsWith('.zip'));
  assert.ok(zip !== undefined, '应产出 zip');
  const { parseZipHardened } = await import('../../src/security/zip-security.ts');
  const { MANIFEST_FILE } = await import('../../src/schema/manifest.ts');
  const archive = parseZipHardened(new Uint8Array(await fs.readFile(path.join(exportsDir, zip!))));
  const manifest = JSON.parse(archive.readEntryText(MANIFEST_FILE)) as { exporter?: { version?: string } };

  const pkg = JSON.parse(await fs.readFile(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
  assert.equal(manifest.exporter?.version, pkg.version, 'manifest.exporter.version 必须等于 package.json.version');
  assert.notEqual(manifest.exporter?.version, '0.0.0-unknown', '不得回退到中性占位（说明 package.json 解析失败）');

  await fs.rm(home, { recursive: true, force: true });
});
