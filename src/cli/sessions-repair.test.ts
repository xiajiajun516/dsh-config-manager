/**
 * CLI 会话修复（`sessions repair`）的「读不到 ≠ 没有会话」回归。
 *
 * 修前：会话根**存在但读不出来**（ENOTDIR / EACCES…）时 scanSessions 只返回空列表，
 * 于是打印「无需修复」+ exit 0 —— 把扫描失败说成了「没问题」，--json 还会回 ok:true。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runSessionsRepair } from './sessions-repair.ts';

interface Collected {
  lines: string[];
  errors: string[];
  io: { log: (line: string) => void; error: (line: string) => void };
}

function collect(): Collected {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { log: (l) => lines.push(l), error: (l) => errors.push(l) } };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cli-repair-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const base = { fix: false, maps: [] as string[], json: false };

test('RP-01 会话根存在但读不出来 → exit 1，明说「读不到 ≠ 没有会话」，绝不打印「无需修复」', async () => {
  await withTmp(async (home) => {
    // 用普通文件占住 <home>/sessions：exists() 为真，readdir 必失败（ENOTDIR）。
    await fs.writeFile(path.join(home, 'sessions'), 'not a directory', 'utf8');
    const { lines, errors, io } = collect();
    const code = await runSessionsRepair({ home, ...base }, io);
    assert.equal(code, 1, '读不出来必须非 0');
    const text = lines.join('\n') + '\n' + errors.join('\n');
    assert.match(text, /读不到/, '必须明说读不到');
    assert.match(text, /读不到 ≠ 没有会话/);
    assert.doesNotMatch(lines.join('\n'), /无需修复/, '不得把扫描失败说成「无需修复」');
  });
});

test('RP-02 同一情形下 --json 不得回 ok:true', async () => {
  await withTmp(async (home) => {
    await fs.writeFile(path.join(home, 'sessions'), 'not a directory', 'utf8');
    const { lines, io } = collect();
    const code = await runSessionsRepair({ home, ...base, json: true }, io);
    assert.equal(code, 1);
    assert.equal(lines.length, 1, '--json 必须给出唯一一段机器可读输出');
    const parsed = JSON.parse(lines[0]!) as { ok: boolean; rootReadable: boolean; error?: string };
    assert.equal(parsed.ok, false, '读不出来时 ok 必须为 false');
    assert.equal(parsed.rootReadable, false);
    assert.equal(typeof parsed.error, 'string');
    assert.doesNotMatch(lines[0]!, /"ok": true/);
  });
});

test('RP-03 会话根存在且可读但为空 → 仍照旧「无需修复」+ exit 0（不误伤正常路径）', async () => {
  await withTmp(async (home) => {
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
    const { lines, io } = collect();
    const code = await runSessionsRepair({ home, ...base }, io);
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /无需修复/);
  });
});

test('RP-04 会话根不存在 → exit 1 且提示用 --home 指对位置（既有语义不变）', async () => {
  await withTmp(async (home) => {
    const { errors, io } = collect();
    const code = await runSessionsRepair({ home, ...base }, io);
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /找不到会话根目录/);
  });
});
