/**
 * 中断的回退（2026-10-18）：进程在「回退写到一半」时没了。
 *
 * 纪律：真实临时目录 + 真实读写；**不 mock 文件系统** —— 本组用例要证的正是「磁盘上留下了什么」。
 *
 * 现场形状：<dataDir>/rollback-points/undo/<pid>-<ts36>-<8hex>/ 里有 journal.jsonl（逐条前像 +
 * after 镜像 + 路径），**没有 done**，且目录名里的 pid 已经死了。
 *
 * 三件事各自成文：
 *  · I-1：这种目录**不得**被 cleanupOrphanTempFiles 当垃圾删掉（它还可能救命）；落 done 之后照旧清。
 *  · I-2：恢复只在「当前内容仍等于 after 镜像」时写回 ⇒ 之后被改过的文件**跳过**、绝不覆盖。
 *  · I-3：全部条目都自证成立 ⇒ 恢复成功、现场清掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RollbackPointEngine } from './rollback-point.ts'
import { cleanupOrphanTempFiles } from './rollback-ledger.ts'
import { UNDO_DONE_FILE_NAME, UndoJournalWriter } from './rollback-undo-journal.ts'
import { sha256Hex } from '../utils/hashing.ts'

/** 目录名里的 pid 必须「已死」：取一个超出常见 pid 上限的值（Windows/Linux 都会 ESRCH） */
const DEAD_PID = 4294967

interface Fixture { root: string; dataDir: string; homeDir: string; ws: string; cleanup: () => Promise<void>; undoDir: (name: string) => string }

async function makeFixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-interrupted-')))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const ws = path.join(root, 'ws')
  await fs.mkdir(ws, { recursive: true })
  const storeDir = path.join(dataDir, 'rollback-points')
  return {
    root, dataDir, homeDir, ws,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
    undoDir: (name: string) => path.join(storeDir, 'undo', name),
  }
}

function makeEngine(fx: Fixture): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0 })
}

/** 造一个「回退写到一半」的现场：逐条前像 + after 镜像，**不落 done** */
async function makeInterrupted(
  fx: Fixture,
  name: string,
  entries: { target: string; before: Uint8Array | null; after: { sha256: string } | { deleted: true } }[],
): Promise<string> {
  const dir = fx.undoDir(name)
  await fs.mkdir(dir, { recursive: true })
  const journal = await UndoJournalWriter.create(dir, { now: () => 5_000_000 })
  for (const entry of entries) await journal.record(entry.target, entry.before, entry.after)
  // **有意不调用 finish()** —— 这一行就是「崩在写入中途」
  return dir
}

async function exists(target: string): Promise<boolean> {
  try { await fs.access(target); return true } catch { return false }
}

test('I-1 中断的回退现场：不得被孤儿清理删掉；落 done 之后照旧清', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const file = path.join(fx.ws, 'a.txt')
  await fs.writeFile(file, 'AFTER')
  const dir = await makeInterrupted(fx, DEAD_PID + '-abc1234-0123abcd', [
    { target: file, before: Buffer.from('BEFORE'), after: { sha256: sha256Hex(Buffer.from('AFTER')) } },
  ])

  const cleaned = await cleanupOrphanTempFiles(path.join(fx.dataDir, 'rollback-points'))
  assert.equal(await exists(dir), true,
    '有 journal 但没有 done ⇒ 那是「回退写到一半」的现场，绝不能被当垃圾删掉（removed=' + String(cleaned.removed) + '）')

  const engine = makeEngine(fx)
  const list = await engine.interruptedRollbacks()
  assert.equal(list.length, 1, '必须能被认出来：' + JSON.stringify(list.map((item) => item.dir)))
  assert.equal(list[0]?.entries.length, 1)
  assert.equal(list[0]?.entries[0]?.path, file)

  // 落 done 之后它就不再是现场了 ⇒ 照旧按残留清掉（判据是 done，不是「永不删除」）
  await fs.writeFile(path.join(dir, UNDO_DONE_FILE_NAME), JSON.stringify({ pid: DEAD_PID, finishedAt: 5_000_000 }))
  const cleaned2 = await cleanupOrphanTempFiles(path.join(fx.dataDir, 'rollback-points'))
  assert.equal(await exists(dir), false, 'done 已落 ⇒ 可以清（removed=' + String(cleaned2.removed) + '）')
  assert.equal((await engine.interruptedRollbacks()).length, 0, '清掉之后不再有现场')
})

test('I-2 恢复只在「当前内容仍等于 after 镜像」时写回：后来被改过的文件一律跳过', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const mine = path.join(fx.ws, 'mine.txt')
  const touched = path.join(fx.ws, 'touched.txt')
  await fs.writeFile(mine, 'AFTER')
  await fs.writeFile(touched, 'AFTER')
  const dir = await makeInterrupted(fx, DEAD_PID + '-def5678-fedcba98', [
    { target: mine, before: Buffer.from('BEFORE'), after: { sha256: sha256Hex(Buffer.from('AFTER')) } },
    { target: touched, before: Buffer.from('BEFORE'), after: { sha256: sha256Hex(Buffer.from('AFTER')) } },
  ])
  // 崩溃之后、恢复之前：这条被外部改过 ⇒ 它的当前内容不再等于 after 镜像
  await fs.writeFile(touched, 'AFTER-BUT-EDITED-LATER')

  const engine = makeEngine(fx)
  const result = await engine.recoverInterruptedRollback(dir)
  assert.equal(await fs.readFile(mine, 'utf8'), 'BEFORE', '自证成立的条目必须被写回（退回回退前）')
  assert.equal(await fs.readFile(touched, 'utf8'), 'AFTER-BUT-EDITED-LATER',
    '**绝不覆盖**比我们新的内容：observed=' + JSON.stringify(await fs.readFile(touched, 'utf8')))
  assert.equal(result.restored, 1)
  assert.equal(result.skipped.length, 1, '跳过的条目必须逐条报出来：' + JSON.stringify(result.skipped))
  assert.equal(result.ok, false)
  assert.equal(await exists(dir), true, '没全成功 ⇒ 现场留着（可以再看、再试）')
})

test('I-3 全部条目都自证成立 ⇒ 恢复成功并清掉现场', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const file = path.join(fx.ws, 'a.txt')
  await fs.writeFile(file, 'AFTER')
  const gone = path.join(fx.ws, 'created-by-rewind.txt')
  await fs.writeFile(gone, 'x')  // 回退动作当时**删除**了它 ⇒ after = deleted；恢复时它必须不存在
  await fs.rm(gone)
  const dir = await makeInterrupted(fx, DEAD_PID + '-aaa1111-1111aaaa', [
    { target: file, before: Buffer.from('BEFORE'), after: { sha256: sha256Hex(Buffer.from('AFTER')) } },
    { target: gone, before: Buffer.from('CAME-BACK'), after: { deleted: true } },
  ])

  const engine = makeEngine(fx)
  const result = await engine.recoverInterruptedRollback(dir)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.restored, 2)
  assert.equal(await fs.readFile(file, 'utf8'), 'BEFORE')
  assert.equal(await fs.readFile(gone, 'utf8'), 'CAME-BACK', '被回退删掉的路径必须被写回')
  assert.equal(await exists(dir), false, '全部成功 ⇒ 现场清掉')
})
