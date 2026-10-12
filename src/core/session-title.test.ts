/**
 * 「会话标题」的**日志兜底**单测（2026-10-12 用户要求：缓存里没有这条会话，就自动读这条会话自己的名字）。
 *
 * 钉住的语义：`session/title` 事件 → 标题（多条取最后一条 = 用户改名压过自动标题）；读不到一律 null
 * （界面回落显示会话 id，**绝不从首条消息编造**）；越界 / 形状不符的 unitId 不拼路径；
 * 缓存按 mtime+size 失效；一次请求的读盘有界（同 unitId 只读一次）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { encodeZstdFrame } from '../utils/zstd-frame.ts';
import {
  applySessionLogTitles,
  clearSessionTitleCache,
  readSessionTitleFromLog,
} from './session-title.ts';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-session-title-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** 造一个会话日志：第 1 帧 = header 行，其余每行一帧（与 DSH 的多帧容器同形）。 */
function logBytes(id: string, lines: readonly string[]): Buffer {
  const frames: Buffer[] = [encodeZstdFrame(Buffer.from(JSON.stringify({ version: 3, id, cwd: 'D:/P' }) + '\n', 'utf8'))];
  for (const line of lines) frames.push(encodeZstdFrame(Buffer.from(line, 'utf8')));
  return Buffer.concat(frames);
}

/** `session/title` 事件行（DSH 的形状：data = { title, messageSeqs, source }）。 */
function titleLine(title: string, source = 'auto'): string {
  return JSON.stringify({ seq: 9, type: 'session/title', data: { title, messageSeqs: [1], source } }) + '\n';
}

const PROJECT_KEY = '--D--Projects-personal-demo--';
const UNIT = PROJECT_KEY + '/session-0b46a72f-d25e-423f-af4b-ef768938292e';

async function writeUnit(sessionsDir: string, unitId: string, bytes: Buffer, name = 'session.jsonl'): Promise<string> {
  const dir = path.join(sessionsDir, ...unitId.split('/'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}

test('session/title 事件 → 标题；多条取最后一条（用户改名压过自动标题）', async () => {
  await withTmp(async (dir) => {
    clearSessionTitleCache();
    await writeUnit(dir, UNIT, logBytes('session-a', [titleLine('自动生成的标题'), titleLine('用户改的名字', 'user')]));
    assert.equal(await readSessionTitleFromLog(dir, UNIT), '用户改的名字');
  });
});

test('没有标题事件 / 空标题 / 形状不符 → null（绝不编造）', async () => {
  await withTmp(async (dir) => {
    clearSessionTitleCache();
    await writeUnit(dir, UNIT, logBytes('session-a', ['{"seq":1,"type":"message"}\n']));
    assert.equal(await readSessionTitleFromLog(dir, UNIT), null, '没有 session/title 事件 → null');

    const emptyTitle = UNIT + '-empty';
    await writeUnit(dir, emptyTitle, logBytes('session-b', [titleLine('   ')]));
    assert.equal(await readSessionTitleFromLog(dir, emptyTitle), null, '空白标题不算标题');

    const wrongShape = UNIT + '-shape';
    await writeUnit(dir, wrongShape, logBytes('session-c', ['{"seq":2,"type":"session/title","data":null}\n']));
    assert.equal(await readSessionTitleFromLog(dir, wrongShape), null, 'data 形状不符 → null');
  });
});

test('目录 / 文件缺失、unitId 形状不符（单段 / 越界）→ null（不拼可疑路径）', async () => {
  await withTmp(async (dir) => {
    clearSessionTitleCache();
    assert.equal(await readSessionTitleFromLog(dir, UNIT), null, '目录不存在 → null');
    assert.equal(await readSessionTitleFromLog(dir, 'session-only'), null, '单段 unitId → null');
    assert.equal(await readSessionTitleFromLog(dir, PROJECT_KEY + '/../..'), null, '越界段 → null');
    const dirOnly = PROJECT_KEY + '/session-no-log';
    await fs.mkdir(path.join(dir, ...dirOnly.split('/')), { recursive: true });
    await fs.writeFile(path.join(dir, ...dirOnly.split('/'), 'notes.txt'), 'not a log');
    assert.equal(await readSessionTitleFromLog(dir, dirOnly), null, '目录里没有会话日志 → null');
  });
});

test('缓存按 mtime+size 失效：日志增长后能读到新落盘的标题', async () => {
  await withTmp(async (dir) => {
    clearSessionTitleCache();
    const file = await writeUnit(dir, UNIT, logBytes('session-a', ['{"seq":1}\n']));
    assert.equal(await readSessionTitleFromLog(dir, UNIT), null, '第一次：还没有标题');
    // 追加一帧（保留原字节）⇒ 文件变大 ⇒ 缓存必须失效，下次读得到刚落盘的标题
    await fs.appendFile(file, encodeZstdFrame(Buffer.from(titleLine('刚生成的标题'), 'utf8')));
    assert.equal(await readSessionTitleFromLog(dir, UNIT), '刚生成的标题');
  });
});

test('applySessionLogTitles：已有标题不动、同 unitId 只读一次、读盘次数有上界', async () => {
  await withTmp(async (dir) => {
    clearSessionTitleCache();
    const unitB = PROJECT_KEY + '/session-b';
    await writeUnit(dir, UNIT, logBytes('session-a', [titleLine('A 的标题')]));
    await writeUnit(dir, unitB, logBytes('session-b', [titleLine('B 的标题')]));

    const rows = await applySessionLogTitles([
      { sessionId: 'a1', unitId: UNIT },
      { sessionId: 'a1', unitId: UNIT },
      { sessionId: 'b1', unitId: unitB, title: '缓存里已有' },
      { sessionId: 'c1', unitId: null },
    ], dir);
    assert.equal(rows[0]?.title, 'A 的标题');
    assert.equal(rows[1]?.title, 'A 的标题', '同 unitId 的其余行复用同一次读取');
    assert.equal(rows[2]?.title, '缓存里已有', '已有标题的行原样保留（不覆盖缓存结论）');
    assert.equal(rows[3]?.title, undefined, '没有 unitId 的行不猜归属');

    // 上界：maxReads=1 时，第二个**不同**会话不再读盘（保持无标题，界面回落显示 id）
    const capped = await applySessionLogTitles([
      { sessionId: 'a1', unitId: UNIT },
      { sessionId: 'b1', unitId: unitB },
    ], dir, { maxReads: 1 });
    assert.equal(capped[0]?.title, 'A 的标题');
    assert.equal(capped[1]?.title, undefined, '超过上界的会话不再读盘（绝不把盘读穿）');
  });
});
