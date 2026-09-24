/**
 * CLI 离线会话修复端到端单测（issue #45 Fix 3）。
 *
 * 钉住的语义：默认零写入（dry-run）、--fix 才落盘且只搬到 projectKeyOf(header cwd)、
 * --map 命中时先改写首帧再搬、重复 id 只有 --keep 点名才隔离（只搬不删）、
 * 目标已存在时拒绝覆盖并返回退出码 1。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCli, runCli, type CliIo } from '../../src/cli/index.ts';
import { encodeZstdFrame } from '../../src/utils/zstd-frame.ts';
import { readLogCwdFromBytes } from '../../src/utils/session-log.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-sessions-cli-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function captureIo(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const io: CliIo = { log: (s) => out.push(s), error: (s) => out.push(s) };
  return { io, out };
}

function makeLog(id: string, cwd: string): Buffer {
  return Buffer.concat([
    encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id, cwd }) + '\n', 'utf8')),
    encodeZstdFrame(Buffer.from('{"seq":1}\n', 'utf8')),
  ]);
}

/** 在 <home>/sessions/<projectKey>/<sessionId>/ 造一个会话日志；返回会话目录。 */
async function seedSession(home: string, projectKey: string, sessionId: string, cwd: string): Promise<string> {
  const dir = path.join(home, 'sessions', projectKey, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), makeLog(sessionId, cwd));
  return dir;
}

async function logCwdOf(dir: string): Promise<string | undefined> {
  return readLogCwdFromBytes(await fs.readFile(path.join(dir, 'session.v3.jsonl.zstd')));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

test('parseCli：sessions repair 的参数面（--home/--fix/--keep/--map/--json），非法参数一律拒绝', () => {
  const ok = parseCli(['sessions', 'repair', '--home', '/h', '--fix', '--keep', '/h/sessions/--a--/session-a', '--map', 'C:/x=D:/y', '--map', 'C:/x/z=D:/z', '--json']);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.options.command, 'sessions');
  assert.deepEqual(ok.options.positionals, ['repair']);
  assert.equal(ok.options.home, '/h');
  assert.equal(ok.options.fix, true);
  assert.equal(ok.options.keep, '/h/sessions/--a--/session-a');
  assert.deepEqual(ok.options.maps, ['C:/x=D:/y', 'C:/x/z=D:/z']);
  assert.equal(ok.options.json, true);
  const eq = parseCli(['sessions', 'repair', '--home=/hh', '--map=C:/a=D:/b']);
  assert.equal(eq.ok && eq.options.home, '/hh');
  assert.equal(eq.ok && eq.options.maps?.[0], 'C:/a=D:/b');
  assert.equal(parseCli(['sessions']).ok, false, '缺子动作');
  assert.equal(parseCli(['sessions', 'frobnicate']).ok, false, '未知子动作');
  assert.equal(parseCli(['sessions', 'repair', '--bogus']).ok, false, '未知参数');
  assert.equal(parseCli(['sessions', 'repair', '--map']).ok, false, '--map 缺值');
  assert.equal(parseCli(['sessions', 'repair', '--map', 'no-equals']).ok, true, '缺 = 由 runner 报错（解析层只管形状）');
  assert.equal(parseCli(['snapshots', '--home', '/h']).ok, false, '--home 只属于 sessions');
});

test('sessions repair：默认 dry-run 零写入，--fix 才按 projectKeyOf(header cwd) 归位', async () => {
  await withTmp(async (home) => {
    const okDir = await seedSession(home, '--D-Real-proj--', 'session-ok', 'D:/Real/proj');
    const badDir = await seedSession(home, '--D-Ghost-proj--', 'session-bad', 'D:/Real/proj');
    const lockedDir = await seedSession(home, '--D-Ghost-proj--', 'session-locked', 'D:/Real/proj');
    await fs.writeFile(path.join(lockedDir, 'session.lock'), 'lock');

    const dry = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home], dry.io), 0);
    assert.equal(await exists(badDir), true, 'dry-run 不得搬任何目录');
    assert.equal(await exists(okDir), true);
    const dryText = dry.out.join('\n');
    assert.match(dryText, /待搬家 1/);
    assert.match(dryText, /跳过 1/);
    assert.match(dryText, /reason=locked/);

    const fix = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--fix'], fix.io), 0);
    const moved = path.join(home, 'sessions', '--D-Real-proj--', 'session-bad');
    assert.equal(await exists(moved), true, '已搬到 header cwd 对应的 projectKey 段');
    assert.equal(await exists(badDir), false);
    assert.equal(await logCwdOf(moved), 'D:/Real/proj', '未映射时不改 header');
    assert.equal(await exists(lockedDir), true, '加锁目录不动');
  });
});

test('sessions repair --map：命中前缀 → 先改写首帧 cwd 再搬到映射后的 projectKey 段', async () => {
  await withTmp(async (home) => {
    const dir = await seedSession(home, '--C-Users-alice-proj--', 'session-cross', 'C:/Users/alice/proj');
    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--map', 'C:/Users/alice=D:/Work', '--fix'], io.io), 0);
    const moved = path.join(home, 'sessions', '--D-Work-proj--', 'session-cross');
    assert.equal(await exists(moved), true);
    assert.equal(await exists(dir), false);
    assert.equal(await logCwdOf(moved), 'D:/Work/proj', '首帧 cwd 已改写');
  });
});

test('sessions repair：重复 id 只有 --keep 点名才隔离其它副本（只搬不删）', async () => {
  await withTmp(async (home) => {
    const keepDir = await seedSession(home, '--D-Real-proj--', 'session-dup', 'D:/Real/proj');
    const dupDir = await seedSession(home, '--D-Ghost-proj--', 'session-dup', 'D:/Real/proj');

    const report = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home], report.io), 0);
    assert.equal(await exists(dupDir), true, '没点名 keep → 一个都不动');
    assert.match(report.out.join('\n'), /重复 id 1/);

    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--keep', keepDir, '--fix'], io.io), 0);
    assert.equal(await exists(keepDir), true, '被保留的那份不动');
    assert.equal(await exists(dupDir), false);
    const quarantineRoot = path.join(home, 'sessions');
    const entries = await fs.readdir(quarantineRoot);
    const quarantine = entries.find((name) => name.startsWith('.cm-repair-quarantine-'));
    assert.ok(quarantine !== undefined, '副本被移进隔离目录');
    assert.equal(await exists(path.join(quarantineRoot, quarantine!, '--D-Ghost-proj--', 'session-dup')), true);
  });
});

test('sessions repair --fix：目标目录已存在 → 拒绝覆盖并返回 1', async () => {
  await withTmp(async (home) => {
    const fromDir = await seedSession(home, '--D-Ghost-proj--', 'session-c', 'D:/Real/proj');
    // 目标位置有个**没有会话日志**的残留空目录：这不构成重复 id（扫描跳过它），
    // 但搬迁时必须拒绝覆盖（用户的东西一律不删）。
    await fs.mkdir(path.join(home, 'sessions', '--D-Real-proj--', 'session-c'), { recursive: true });
    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--fix'], io.io), 1);
    assert.equal(await exists(fromDir), true, '冲突时原目录保持不动');
    assert.match(io.out.join('\n'), /目标目录已存在/);
  });
});

test('sessions repair：home 下没有 sessions 目录 → 报错退出 1', async () => {
  await withTmp(async (home) => {
    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home], io.io), 1);
    assert.match(io.out.join('\n'), /找不到会话根目录/);
  });
});

test('sessions repair：--map 形状非法（缺 =）→ 报错退出 1，不碰文件', async () => {
  await withTmp(async (home) => {
    const dir = await seedSession(home, '--D-Ghost-proj--', 'session-x', 'D:/Real/proj');
    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--map', 'oops', '--fix'], io.io), 1);
    assert.equal(await exists(dir), true);
  });
});

test('sessions repair --json：机器可读计划（dry-run 时输出 summary+actions）', async () => {
  await withTmp(async (home) => {
    await seedSession(home, '--D-Ghost-proj--', 'session-json', 'D:/Real/proj');
    const io = captureIo();
    assert.equal(await runCli(['sessions', 'repair', '--home', home, '--json'], io.io), 0);
    const payload = JSON.parse(io.out.join('\n')) as { dryRun: boolean; summary: { move: number }; actions: { kind: string }[] };
    assert.equal(payload.dryRun, true);
    assert.equal(payload.summary.move, 1);
    assert.equal(payload.actions.some((a) => a.kind === 'move'), true);
  });
});
