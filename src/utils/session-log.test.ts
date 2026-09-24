/**
 * 会话日志字节工具单测（issue #45 Fix 3：从宿主适配器抽到 utils/session-log.ts）。
 *
 * 钉住的语义：首帧 cwd 读取（读不出 = undefined，绝不猜）、只换第 1 帧（尾部逐字节保留）、
 * 机器可读错误码、多 generation 一起改 + 失败回滚、projectKey 形状白名单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeZstdFrame, firstFrameEnd } from './zstd-frame.ts';
import {
  PROJECT_KEY_RE, isSessionLogName, readLogCwdFromBytes, readLogFileCwd, readLogHeaderFromBytes,
  rewriteSessionLogDir, rewriteSessionLogFile, sessionLogNames,
} from './session-log.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-session-log-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 造一个会话日志：第 1 帧 = header 行，其余帧 = 尾部数据（模拟 DSH 的多帧容器）。 */
function makeLog(id: string, cwd: string | undefined, tailLines: readonly string[] = ['{"seq":1}\n', '{"seq":2}\n']): Buffer {
  const header = cwd === undefined
    ? { version: 3, id }
    : { version: 3, id, cwd };
  const frames: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify(header) + '\n', 'utf8'))];
  for (const line of tailLines) frames.push(encodeZstdFrame(Buffer.from(line, 'utf8')));
  return Buffer.concat(frames);
}

/** 尾部（第 2 帧起）字节；用于断言「原样保留」。 */
function tailBytes(bytes: Buffer): Buffer {
  const end = firstFrameEnd(bytes);
  assert.ok(end !== null, '合成的日志必须有完整的第 1 帧');
  return bytes.subarray(end);
}

test('readLogCwdFromBytes：取首帧 cwd；读不出（垃圾 / 缺 cwd / 空）一律 undefined', () => {
  assert.equal(readLogCwdFromBytes(makeLog('session-a', 'D:/Ghost/proj')), 'D:/Ghost/proj');
  assert.equal(readLogCwdFromBytes(makeLog('session-a', undefined)), undefined);
  assert.equal(readLogCwdFromBytes(Buffer.from('not zstd at all', 'utf8')), undefined);
  assert.equal(readLogCwdFromBytes(Buffer.alloc(0)), undefined);
});

test('readLogHeaderFromBytes：认 origin 与父对话 id（磁盘写 parentSession / RPC 投影写 parentSessionId）', () => {
  const stored = encodeZstdFrame(Buffer.from(JSON.stringify({ id: 'child-a', cwd: 'D:/Ghost/proj', origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 }) + '\n', 'utf8'));
  assert.deepEqual(readLogHeaderFromBytes(Buffer.from(stored)), {
    id: 'child-a', cwd: 'D:/Ghost/proj', origin: 'subagent', parentSessionId: 'session-parent',
  }, '真机磁盘 header 用的是 parentSession（只认 parentSessionId 会一个都认不出来）');

  const wire = encodeZstdFrame(Buffer.from(JSON.stringify({ id: 'child-b', origin: 'subagent', parentSessionId: 'session-parent' }) + '\n', 'utf8'));
  assert.deepEqual(readLogHeaderFromBytes(Buffer.from(wire)), {
    id: 'child-b', origin: 'subagent', parentSessionId: 'session-parent',
  }, 'RPC 投影形态同样要认');

  assert.equal(readLogHeaderFromBytes(Buffer.from('not zstd at all', 'utf8')), undefined, '读不出 → undefined，不猜');
});

test('rewriteSessionLogFile：只换第 1 帧，尾部逐字节保留，并回传原 cwd', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.v3.jsonl.zstd');
    const before = makeLog('session-a', 'D:/Ghost/proj');
    await fs.writeFile(file, before);
    const result = await rewriteSessionLogFile(file, 'E:/Local/proj');
    assert.deepEqual(result, { ok: true, previousCwd: 'D:/Ghost/proj' });
    const after = await fs.readFile(file);
    assert.equal(readLogCwdFromBytes(after), 'E:/Local/proj');
    assert.deepEqual(tailBytes(after), tailBytes(before), '尾部必须逐字节一致');
  });
});

test('rewriteSessionLogFile：cwd 已经是目标值 → 幂等成功（不重写）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.v3.jsonl.zstd');
    await fs.writeFile(file, makeLog('session-a', 'E:/Local/proj'));
    assert.deepEqual(await rewriteSessionLogFile(file, 'E:/Local/proj'), { ok: true, previousCwd: 'E:/Local/proj' });
  });
});

test('rewriteSessionLogFile：机器可读失败码（非 zstd / 缺 cwd / 文件不存在）', async () => {
  await withTmp(async (dir) => {
    const junk = path.join(dir, 'junk.jsonl.zstd');
    await fs.writeFile(junk, Buffer.from('definitely not zstd', 'utf8'));
    assert.deepEqual(await rewriteSessionLogFile(junk, 'E:/x'), { ok: false, reason: 'not-zstd' });
    const noCwd = path.join(dir, 'session.v3.jsonl.zstd');
    await fs.writeFile(noCwd, makeLog('session-a', undefined));
    assert.deepEqual(await rewriteSessionLogFile(noCwd, 'E:/x'), { ok: false, reason: 'cwd-mismatch' });
    assert.deepEqual(await rewriteSessionLogFile(path.join(dir, 'missing.jsonl.zstd'), 'E:/x'), { ok: false, reason: 'no-log' });
  });
});

test('rewriteSessionLogDir：同一会话的多份 generation 一起改（全部回传）', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'session.v3.jsonl.zstd'), makeLog('session-a', 'D:/old'));
    await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), makeLog('session-a', 'D:/old', ['{"seq":9}\n']));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    const result = await rewriteSessionLogDir(dir, 'E:/new');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.rewritten.length, 2, '只改会话日志文件，不看 notes.txt');
    for (const file of result.rewritten) assert.equal(readLogCwdFromBytes(await fs.readFile(file)), 'E:/new');
  });
});

test('rewriteSessionLogDir：目录里没有会话日志 → no-log', async () => {
  await withTmp(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
    assert.deepEqual(await rewriteSessionLogDir(dir, 'E:/new'), { ok: false, reason: 'no-log' });
  });
});

test('readLogFileCwd：从磁盘读首帧 cwd（只读窗口，不整文件进内存）', async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, 'session.v3.jsonl.zstd');
    await fs.writeFile(file, makeLog('session-a', 'D:/Ghost/proj', ['x'.repeat(200)]));
    assert.equal(await readLogFileCwd(file), 'D:/Ghost/proj');
    assert.equal(await readLogFileCwd(path.join(dir, 'nope.jsonl.zstd')), undefined);
  });
});

test('会话日志文件名判据与 projectKey 形状', () => {
  assert.equal(isSessionLogName('session.v3.jsonl.zstd'), true);
  assert.equal(isSessionLogName('session.jsonl'), true);
  assert.equal(isSessionLogName('session.lock'), false);
  assert.deepEqual(sessionLogNames(['session.v4.jsonl.zstd', 'session.lock', 'session.v3.jsonl.zstd']), ['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd']);
  assert.equal(PROJECT_KEY_RE.test('--D-Real-proj--'), true);
  assert.equal(PROJECT_KEY_RE.test('./relative'), false);
  assert.equal(PROJECT_KEY_RE.test('..--'), false);
});
