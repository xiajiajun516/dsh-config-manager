/**
 * CLI 会话只读检查（T6）冒烟：list / doctor 的退出码与关键输出。
 * 用真实临时 home + 真实 zstd 会话文件跑（不 mock 字节层）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runSessionsInspect } from './sessions-inspect.ts';
import { encodeZstdFrame, zstdAvailable } from '../utils/zstd-frame.ts';

const CAPABLE = zstdAvailable();
const KEY = '--D-proj--';

function logBytes(rows: readonly unknown[]): Buffer {
  const header = JSON.stringify({ type: 'session', version: 3, id: 'session-a', cwd: 'D:\\proj' });
  const parts: Buffer[] = [encodeZstdFrame(Buffer.from(header + '\n', 'utf8'))];
  for (const row of rows) parts.push(encodeZstdFrame(Buffer.from(JSON.stringify(row) + '\n', 'utf8')));
  return Buffer.concat(parts);
}

function collect(): { lines: string[]; errors: string[]; io: { log: (l: string) => void; error: (l: string) => void } } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { log: (l) => lines.push(l), error: (l) => errors.push(l) } };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cli-inspect-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('T6 CLI：会话根不存在 → 退出码 2 + 明确提示（不是崩溃）', async () => {
  await withTmp(async (home) => {
    const { errors, io } = collect();
    const code = await runSessionsInspect({ home, action: 'doctor', json: false }, io);
    assert.equal(code, 2);
    assert.match(errors.join('\n'), /找不到会话根目录/);
  });
});

test('T6 CLI：健康会话 → 退出码 0，摘要里必须写清「未做深度校验 N 条」', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const dir = path.join(home, 'sessions', KEY, 'session-a');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.jsonl.zstd'), logBytes([{ type: 'turn/start', seq: 0 }]));
    const { lines, io } = collect();
    const code = await runSessionsInspect({ home, action: 'doctor', json: false }, io);
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /共 1 条会话/);
    assert.match(text, /已做深度校验 1 条，未做深度校验 0 条/);
    assert.match(text, /正常 1/);
  });
});

test('T6 CLI：不可加载的会话 → 退出码 1 + 建议先关 DSH（绝不假装没事）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const dir = path.join(home, 'sessions', KEY, 'broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.jsonl.zstd'), Buffer.from('not zstd'));
    const { lines, io } = collect();
    const code = await runSessionsInspect({ home, action: 'doctor', json: false }, io);
    assert.equal(code, 1, '存在不可加载会话必须返回非零');
    const text = lines.join('\n');
    assert.match(text, /unloadable/);
    assert.match(text, /先关掉 DSH/);
  });
});

test('T6 CLI：--json 给机器可读结果（readOnly 声明 + summary + rows）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const dir = path.join(home, 'sessions', KEY, 'session-a');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.jsonl.zstd'), logBytes([{ type: 'turn/start', seq: 0 }]));
    const { lines, io } = collect();
    const code = await runSessionsInspect({ home, action: 'list', json: true }, io);
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join('\n')) as { ok: boolean; readOnly: boolean; rows: unknown[]; summary: { total: number } };
    assert.equal(parsed.readOnly, true, '输出必须声明只读');
    assert.equal(parsed.ok, true, '无阻断问题 → ok 与退出码（0）同源');
    assert.equal(parsed.summary.total, 1);
    assert.equal(parsed.rows.length, 1);
  });
});

test('T6 CLI：--json 的 ok 与退出码同源（有不可加载会话时为 false，不再恒 true）', { skip: !CAPABLE }, async () => {
  await withTmp(async (home) => {
    const dir = path.join(home, 'sessions', KEY, 'broken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.jsonl.zstd'), Buffer.from('not zstd'));
    const { lines, io } = collect();
    const code = await runSessionsInspect({ home, action: 'doctor', json: true }, io);
    assert.equal(code, 1, '存在不可加载会话 → 退出码 1');
    const parsed = JSON.parse(lines.join('\n')) as { ok: boolean };
    assert.equal(parsed.ok, false, 'ok 必须与退出码同源（此前恒 true，机器消费者只会信错一个）');
  });
});
