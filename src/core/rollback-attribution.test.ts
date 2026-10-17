/**
 * 写入归属台账（2026-10-17 定案 B）的单元测试。
 *
 * 三条不变量逐条钉住：① 只有写类工具才算写入（读工具里的 path 不算）；
 * ② 解析不出来 = **未判定**（空数组，不抛）；③ 落盘失败只 warn，绝不影响调用方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  ROLLBACK_ATTRIBUTION_MAX_ENTRIES,
  RollbackWriteAttribution,
  toolCallWritePaths,
} from './rollback-attribution.ts'

test('B-1 只有写类工具才算写入：读工具的 path 绝不进归属', () => {
  // 白名单之外一律空数组 —— 否则 read/grep 会把「读」记成「写」，回退就会误跳过文件
  assert.deepEqual(toolCallWritePaths('read', '{"file_path":"a.txt"}'), [])
  assert.deepEqual(toolCallWritePaths('grep', '{"path":"a.txt"}'), [])
  assert.deepEqual(toolCallWritePaths('ops_inspect_local_file', '{"path":"a.txt"}'), [])
  assert.deepEqual(toolCallWritePaths('write', '{"file_path":"a.txt"}'), ['a.txt'])
  assert.deepEqual(toolCallWritePaths('edit', { path: 'b.txt' }), ['b.txt'])
  assert.deepEqual(toolCallWritePaths('ops_replace', JSON.stringify({ path: 'c.txt', find: 'x' })), ['c.txt'])
})

test('B-2 参数字符串解不出来 = 未判定（空数组，绝不抛）', () => {
  assert.deepEqual(toolCallWritePaths('write', '{not json'), [])
  assert.deepEqual(toolCallWritePaths('write', null), [])
  assert.deepEqual(toolCallWritePaths('write', '[1,2]'), [])
  assert.deepEqual(toolCallWritePaths('write', '{"file_path":""}'), [])
  assert.deepEqual(toolCallWritePaths(undefined, '{"file_path":"a.txt"}'), [])
})

test('B-3 同一调用里两个路径键指向同一路径 ⇒ 去重', () => {
  assert.deepEqual(toolCallWritePaths('write', '{"file_path":"x.txt","path":"x.txt"}'), ['x.txt'])
})

test('B-4 noteToolCall 记录归属：写类工具进表，非写类工具返回 0 且不进表', () => {
  const attr = new RollbackWriteAttribution({ file: path.join(os.tmpdir(), 'attr-never-written.json'), flushDelayMs: 0 })
  assert.equal(attr.noteToolCall('session-a', { name: 'read', arguments: '{"file_path":"r.txt"}' }), 0)
  assert.equal(attr.writerOf(path.resolve('r.txt')), undefined)
  assert.equal(attr.noteToolCall('session-a', { name: 'write', callId: 'call-1', turn: 3, arguments: '{"file_path":"w.txt"}' }), 1)
  const fact = attr.writerOf(path.resolve('w.txt'))
  assert.equal(fact?.sessionId, 'session-a')
  assert.equal(fact?.callId, 'call-1')
  assert.equal(fact?.tool, 'write')
  assert.equal(fact?.turn, 3)
  // 后写者覆盖前写者（台账只关心「最后一次是谁写的」）
  attr.noteToolCall('session-b', { name: 'edit', callId: 'call-2', arguments: '{"path":"w.txt"}' })
  assert.equal(attr.writerOf(path.resolve('w.txt'))?.sessionId, 'session-b')
})

test('B-5 读盘：形状不符当空表；本进程新记录优先于磁盘旧值', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attr-'))
  const file = path.join(dir, 'attribution.json')
  try {
    await fs.writeFile(file, JSON.stringify({ version: 2, entries: { [path.resolve('old.txt')]: { sessionId: 'x', at: 1 } } }), 'utf8')
    const wrong = new RollbackWriteAttribution({ file, flushDelayMs: 0 })
    await wrong.load()
    assert.equal(wrong.size, 0, '未知版本必须当空表，绝不猜字段含义')

    await fs.writeFile(file, JSON.stringify({
      version: 1,
      entries: { [path.resolve('old.txt')]: { sessionId: 'disk', at: 5, tool: 'write', callId: 'c', turn: null } },
    }), 'utf8')
    const attr = new RollbackWriteAttribution({ file, flushDelayMs: 0 })
    // 读盘之前先记一条同路径的新事实 ⇒ 读盘**不得**把它覆盖回磁盘旧值
    attr.noteToolCall('session-new', { name: 'write', arguments: '{"file_path":"' + path.resolve('old.txt').replace(/\\/g, '\\\\') + '"}' })
    await attr.load()
    assert.equal(attr.writerOf(path.resolve('old.txt'))?.sessionId, 'session-new')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('B-6 落盘 + 回读：flush 原子写，写完能读回来', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attr-'))
  const file = path.join(dir, 'attribution.json')
  try {
    const attr = new RollbackWriteAttribution({ file, flushDelayMs: 0 })
    attr.noteToolCall('session-x', { name: 'write', callId: 'c9', arguments: '{"file_path":"' + path.join(dir, 'z.txt').replace(/\\/g, '\\\\') + '"}' })
    await attr.flush()
    const reread = new RollbackWriteAttribution({ file })
    await reread.load()
    assert.equal(reread.writerOf(path.join(dir, 'z.txt'))?.callId, 'c9')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('B-7 超过上限淘汰最旧（台账不得无界增长）', () => {
  const attr = new RollbackWriteAttribution({ file: path.join(os.tmpdir(), 'attr-unused.json'), flushDelayMs: 0, maxEntries: 2 })
  for (const name of ['a', 'b', 'c']) {
    attr.noteToolCall('s', { name: 'write', arguments: '{"file_path":"' + name + '.txt"}' })
  }
  assert.equal(attr.size, 2)
  assert.equal(attr.writerOf(path.resolve('a.txt')), undefined, '最旧的被淘汰')
  assert.equal(attr.writerOf(path.resolve('c.txt'))?.sessionId, 's')
})

test('B-8 落盘失败只 warn，不上抛（台账坏掉绝不能拖垮留点/回退）', async () => {
  const warnings: string[] = []
  // 目录名当成文件路径 ⇒ mkdir/写必然失败
  const attr = new RollbackWriteAttribution({ file: path.join(os.tmpdir(), 'attr-dir-as-file', 'attribution.json'), flushDelayMs: 0, warn: (line) => warnings.push(line) })
  await fs.mkdir(path.join(os.tmpdir(), 'attr-dir-as-file', 'attribution.json'), { recursive: true })
  try {
    attr.noteToolCall('s', { name: 'write', arguments: '{"file_path":"q.txt"}' })
    await attr.flush()
    assert.equal(warnings.length > 0, true, '写不进去必须留痕')
  } finally {
    await fs.rm(path.join(os.tmpdir(), 'attr-dir-as-file'), { recursive: true, force: true })
  }
})

test('B-9 条目上限常量是有限值（0/Infinity 会让台账无界）', () => {
  assert.equal(Number.isFinite(ROLLBACK_ATTRIBUTION_MAX_ENTRIES) && ROLLBACK_ATTRIBUTION_MAX_ENTRIES > 0, true)
})
