/**
 * 回退前像 journal 单测（T2：中断回退的崩溃可检测 / 可重放）。
 *
 * 纪律：真实临时目录（os.tmpdir）里真读真写，**不 mock 文件系统**；绝不触碰任何真实用户数据目录。
 * 覆盖：
 *  - J-01 record 先落 bin 再记索引（含 0 字节前像与 null 前像）
 *  - J-02 尾行被截断 ⇒ 前序行照读 + truncatedTail、绝不抛异常（含切在多字节字符中间）
 *  - J-03 没有 journal ⇒ null
 *  - J-04 finish 写 done（原子）；有 done 就不是中断残留
 *  - J-05 findInterruptedUndos 判据：形态 + 有 journal + 无 done + pid 已死（两种 root 口径）
 *  - J-06 replay 逆序（同路径两次 ⇒ 最后写的是最早状态）+ bin===null ⇒ 删除
 *  - J-07 当前状态 != after 镜像 ⇒ skipped 且**绝不写盘**（用户后来的修改不被覆盖）
 *  - J-08 前像缺失 / 损坏 / 写失败 / 读当前态失败 ⇒ 逐条进 failed，绝不静默
 *  - J-09 相对路径 / NUL / 越权 bin ⇒ failed 且不写盘
 *  - J-10 record 写盘失败 ⇒ 抛错且 journal 不留半行；create 建不出目录 ⇒ 拒绝；dispose 后 record ⇒ 抛错
 *  - J-11 create 续写：截掉残缺尾行 + 序号接续（bin 不重号、旧前像不被覆盖）
 *  - J-12 静态：只 import node: 内置与仓内 .ts（零运行时依赖）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sha256Hex } from '../utils/hashing.ts'
import {
  findInterruptedUndos,
  readUndoJournal,
  replayUndoJournal,
  UndoJournalWriter,
  UNDO_DONE_FILE_NAME,
  UNDO_JOURNAL_FILE_NAME,
  type InterruptedUndo,
} from './rollback-undo-journal.ts'

/* ------------------------------------------------------------------ 工具 */

const REAL_NOW = 1_700_000_000_000
const enc = new TextEncoder()

function text(value: string): Uint8Array {
  return enc.encode(value)
}

function asText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

async function makeRoot(tag: string): Promise<string> {
  // realpath：os.tmpdir() 的拼写可能未规范化，而 path.resolve/join 的结果要逐字比较
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-undo-journal-' + tag + '-')))
}

function journalPath(dir: string): string {
  return path.join(dir, UNDO_JOURNAL_FILE_NAME)
}

async function readLines(dir: string): Promise<string[]> {
  const raw = await fs.readFile(journalPath(dir), 'utf8')
  return raw.split('\n').filter((line) => line !== '')
}

/** 形态合法的 undo 目录名：<pid>-<ts36>-<8hex>（与 rollback-ledger.ts 的 UNDO_DIR_RE 同形） */
function undoDirName(pid: number, seed: number): string {
  const stamp = (REAL_NOW + seed).toString(36)
  return String(pid) + '-' + stamp + '-' + sha256Hex('undo-dir-seed:' + String(seed)).slice(0, 8)
}

async function interruptedOnly(dir: string): Promise<InterruptedUndo> {
  const found = await findInterruptedUndos(dir, () => false)
  assert.equal(found.length, 1)
  const first = found[0]
  if (first === undefined) throw new Error('expected exactly one interrupted undo in ' + dir)
  return first
}

/** 手写一条 JSONL（可故意缺字段，验证读取端对损坏行的归一化） */
function rawLine(entry: Record<string, unknown>): string {
  return JSON.stringify({ at: REAL_NOW, bin: null, bytes: 0, sha256: null, ...entry }) + '\n'
}

/* ------------------------------------------------------------------ 用例 */

test('J-01 record 先落前像 bin 再记索引：索引逐字段可读，bin 内容 = 前像', async () => {
  const root = await makeRoot('j01')
  try {
    const dir = path.join(root, 'undo', undoDirName(process.pid, 1))
    const target = path.join(root, 'ws', 'a.txt')
    const empty = path.join(root, 'ws', 'empty.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(target, text('A0'), { sha256: sha256Hex('A1') })
    await writer.record(target, null, { deleted: true })
    await writer.record(empty, new Uint8Array(0), { sha256: sha256Hex('') })
    await writer.dispose()

    const snapshot = await readUndoJournal(dir)
    assert.ok(snapshot !== null)
    assert.equal(snapshot.truncatedTail, false)
    assert.deepEqual(snapshot.entries, [
      {
        seq: 0,
        path: target,
        bin: '0.bin',
        bytes: 2,
        sha256: sha256Hex('A0'),
        afterSha256: sha256Hex('A1'),
        afterDeleted: false,
        at: REAL_NOW,
      },
      {
        seq: 1,
        path: target,
        bin: null,
        bytes: 0,
        sha256: null,
        afterSha256: null,
        afterDeleted: true,
        at: REAL_NOW,
      },
      {
        seq: 2,
        path: empty,
        bin: '2.bin',
        bytes: 0,
        sha256: sha256Hex(''),
        afterSha256: sha256Hex(''),
        afterDeleted: false,
        at: REAL_NOW,
      },
    ])
    assert.equal(await fs.readFile(path.join(dir, '0.bin'), 'utf8'), 'A0')
    assert.equal((await fs.stat(path.join(dir, '2.bin'))).size, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-02 尾行被截断（崩在 append 中途）⇒ 前序行照读 + truncatedTail + 绝不抛异常', async () => {
  const root = await makeRoot('j02')
  try {
    const dir = path.join(root, 'undo', undoDirName(process.pid, 2))
    const first = path.join(root, '工作区', '一.txt')
    const second = path.join(root, 'ws', 'b.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(first, text('A0'), { sha256: sha256Hex('A1') })
    await writer.record(second, null, { deleted: true })
    await writer.dispose()

    const full = await fs.readFile(journalPath(dir))
    await fs.writeFile(journalPath(dir), full.subarray(0, full.length - 12))
    const torn = await readUndoJournal(dir)
    assert.ok(torn !== null)
    assert.equal(torn.truncatedTail, true)
    assert.equal(torn.entries.length, 1)
    assert.equal(torn.entries[0]?.path, first)
    assert.equal(torn.entries[0]?.bin, '0.bin')

    // 第二轮：把切点放在多字节字符**中间** —— utf8 解出替换字符，JSON.parse 必然失败，同样不抛
    const chinesePath = path.join(root, '工作区', '一.txt')
    const raw = Buffer.from(
      rawLine({ seq: 0, path: chinesePath, bin: null, bytes: 0, sha256: null, afterSha256: null, afterDeleted: true }),
      'utf8',
    )
    const cut = raw.indexOf(Buffer.from('工作区', 'utf8')) + 1
    assert.ok(cut > 1)
    await fs.writeFile(journalPath(dir), raw.subarray(0, cut))
    const halfChar = await readUndoJournal(dir)
    assert.deepEqual(halfChar, { entries: [], truncatedTail: true })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-03 本来就没有 journal ⇒ readUndoJournal 返回 null（而不是抛错）', async () => {
  const root = await makeRoot('j03')
  try {
    const dir = path.join(root, 'undo', undoDirName(process.pid, 3))
    assert.equal(await readUndoJournal(dir), null)
    await fs.mkdir(dir, { recursive: true })
    assert.equal(await readUndoJournal(dir), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-04 finish 写 done 标记（原子）；已完成的目录不是中断残留', async () => {
  const root = await makeRoot('j04')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(4242, 4))
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(path.join(root, 'a.txt'), null, { deleted: true })
    await writer.finish()
    await writer.dispose()

    const marker = await fs.readFile(path.join(dir, UNDO_DONE_FILE_NAME), 'utf8')
    assert.equal(JSON.parse(marker).finishedAt, REAL_NOW)
    assert.deepEqual(await findInterruptedUndos(undoRoot, () => false), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-05 findInterruptedUndos 只认「形态 + 有 journal + 无 done + pid 已死」（两种 root 口径）', async () => {
  const root = await makeRoot('j05')
  try {
    const undoRoot = path.join(root, 'undo')
    await fs.mkdir(undoRoot, { recursive: true })

    // ① 真中断：有 journal、无 done、pid 已死
    const dead = path.join(undoRoot, undoDirName(900001, 5))
    const w1 = await UndoJournalWriter.create(dead, { now: () => REAL_NOW })
    await w1.record(path.join(root, 'x.txt'), text('X0'), { sha256: sha256Hex('X1') })
    await w1.dispose()

    // ② 已完成（有 done）
    const finished = path.join(undoRoot, undoDirName(900002, 6))
    const w2 = await UndoJournalWriter.create(finished, { now: () => REAL_NOW })
    await w2.record(path.join(root, 'y.txt'), null, { deleted: true })
    await w2.finish()
    await w2.dispose()

    // ③ 目录名形态不符
    await fs.mkdir(path.join(undoRoot, 'not-an-undo-dir'), { recursive: true })
    // ④ 形态相符但没有 journal
    await fs.mkdir(path.join(undoRoot, undoDirName(900003, 7)), { recursive: true })
    // ⑤ pid 还活着
    const alive = path.join(undoRoot, undoDirName(900004, 8))
    const w3 = await UndoJournalWriter.create(alive, { now: () => REAL_NOW })
    await w3.record(path.join(root, 'z.txt'), null, { deleted: true })
    await w3.dispose()

    const isAlive = (pid: number): boolean => pid === 900004
    const fromUndoRoot = await findInterruptedUndos(undoRoot, isAlive)
    assert.deepEqual(fromUndoRoot.map((undo) => undo.dir), [dead])
    assert.equal(fromUndoRoot[0]?.pid, 900001)
    assert.equal(fromUndoRoot[0]?.entries.length, 1)
    assert.equal(fromUndoRoot[0]?.truncatedTail, false)

    // root 传上层 dataRoot 也同样认（自动再看 <root>/undo）
    const fromDataRoot = await findInterruptedUndos(root, isAlive)
    assert.deepEqual(fromDataRoot.map((undo) => undo.dir), [dead])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-06 replay 逆序写回：同一路径记两次时最后写的是最早状态；bin===null ⇒ 删除', async () => {
  const root = await makeRoot('j06')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(900011, 9))
    const target = path.join(root, 'ws', 'a.txt')
    const gone = path.join(root, 'ws', 'gone.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(target, text('A'), { sha256: sha256Hex('B') })
    await writer.record(target, text('B'), { sha256: sha256Hex('C') })
    await writer.record(gone, null, { sha256: sha256Hex('created') })
    await writer.dispose()

    // 目标当前处于「回退动作之后」的状态：a.txt = C，gone.txt = created
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, 'C')
    await fs.writeFile(gone, 'created')

    const undo = await interruptedOnly(undoRoot)
    const order: string[] = []
    const result = await replayUndoJournal(undo, {
      write: async (p, bytes) => {
        order.push(path.basename(p) + '=' + asText(bytes))
        await fs.writeFile(p, bytes)
      },
    })

    assert.deepEqual(order, ['a.txt=B', 'a.txt=A'])
    assert.equal(await fs.readFile(target, 'utf8'), 'A')
    assert.equal(result.restored, 3)
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(result.failed, [])
    await assert.rejects(fs.stat(gone))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-07 当前状态 != after 镜像 ⇒ skipped 且绝不写盘（用户后来的修改不被覆盖）', async () => {
  const root = await makeRoot('j07')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(900021, 10))
    const changed = path.join(root, 'ws', 'changed.txt')
    const recreated = path.join(root, 'ws', 'recreated.txt')
    const missing = path.join(root, 'ws', 'missing.txt')
    const unknown = path.join(root, 'ws', 'unknown.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(changed, text('A1'), { sha256: sha256Hex('C') })
    await writer.record(recreated, null, { deleted: true })
    await writer.record(missing, text('A3'), { sha256: sha256Hex('X') })
    await writer.dispose()
    // 手写一条「after 信息缺失」的损坏行：重放必须判定为无证明，绝不写盘
    await fs.appendFile(journalPath(dir), rawLine({ seq: 9, path: unknown, afterSha256: null }))

    await fs.mkdir(path.dirname(changed), { recursive: true })
    await fs.writeFile(changed, 'D')          // 用户后来又改了
    await fs.writeFile(recreated, 'again')    // 用户又建回来了
    await fs.writeFile(unknown, 'keep')

    const undo = await interruptedOnly(undoRoot)
    let wrote = 0
    const result = await replayUndoJournal(undo, {
      write: async (p, bytes) => {
        wrote += 1
        await fs.writeFile(p, bytes)
      },
    })

    assert.equal(result.restored, 0)
    assert.equal(wrote, 0)
    assert.equal(result.failed.length, 0)
    assert.equal(result.skipped.length, 4)
    const reasons = result.skipped.join('\n')
    assert.ok(reasons.includes(path.resolve(changed) + ': after-state-changed: sha256-mismatch'), reasons)
    assert.ok(reasons.includes(path.resolve(recreated) + ': after-state-changed: expected-absent'), reasons)
    assert.ok(reasons.includes(path.resolve(missing) + ': after-state-changed: missing'), reasons)
    assert.ok(reasons.includes(path.resolve(unknown) + ': after-state-unknown'), reasons)
    assert.equal(await fs.readFile(changed, 'utf8'), 'D')
    assert.equal(await fs.readFile(recreated, 'utf8'), 'again')
    await assert.rejects(fs.stat(missing))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-08 前像缺失 / 损坏 / 写失败 / 读当前态失败 ⇒ 逐条进 failed，绝不静默', async () => {
  const root = await makeRoot('j08')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(900031, 11))
    const t1 = path.join(root, 'ws', 'f1.txt')
    const t2 = path.join(root, 'ws', 'f2.txt')
    const t3 = path.join(root, 'ws', 'f3.txt')
    const t4 = path.join(root, 'ws', 'f4.txt')
    const t5 = path.join(root, 'ws', 'f5.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(t1, text('A1'), { sha256: sha256Hex('AFTER1') })
    await writer.record(t2, text('A2'), { sha256: sha256Hex('AFTER2') })
    await writer.record(t3, text('A3'), { sha256: sha256Hex('AFTER3') })
    await writer.record(t4, text('A4'), { sha256: sha256Hex('AFTER4') })
    await writer.record(t5, text('A5'), { sha256: sha256Hex('AFTER5') })
    await writer.dispose()
    await fs.rm(path.join(dir, '0.bin'))                       // 前像丢失
    await fs.writeFile(path.join(dir, '1.bin'), 'TAMPERED')     // 前像损坏

    await fs.mkdir(path.dirname(t1), { recursive: true })
    const afterImages: [string, string][] = [
      [t1, 'AFTER1'],
      [t2, 'AFTER2'],
      [t3, 'AFTER3'],
      [t4, 'AFTER4'],
      [t5, 'AFTER5'],
    ]
    for (const [target, content] of afterImages) await fs.writeFile(target, content)

    const undo = await interruptedOnly(undoRoot)
    const result = await replayUndoJournal(undo, {
      readCurrent: async (target) => {
        if (target === path.resolve(t4)) throw new Error('read-boom')
        return await fs.readFile(target)
      },
      write: async (target, bytes) => {
        if (target === path.resolve(t3)) throw new Error('write-boom')
        await fs.writeFile(target, bytes)
      },
    })

    assert.equal(result.restored, 1)
    assert.equal(result.skipped.length, 0)
    assert.equal(result.failed.length, 4)
    const failuresFor = (target: string): string[] =>
      result.failed.filter((line) => line.startsWith(path.resolve(target) + ': '))
    assert.equal(failuresFor(t1).length, 1)
    assert.match(failuresFor(t1)[0] ?? '', /ENOENT|no such file/i)
    assert.ok((failuresFor(t2)[0] ?? '').includes('before-checksum-mismatch'))
    assert.ok((failuresFor(t3)[0] ?? '').includes('write-boom'))
    assert.ok((failuresFor(t4)[0] ?? '').includes('read-current-failed'))
    assert.equal(await fs.readFile(t5, 'utf8'), 'A5')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-09 相对路径 / NUL / 越权 bin ⇒ failed 且绝不写盘', async () => {
  const root = await makeRoot('j09')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(900041, 12))
    await fs.mkdir(dir, { recursive: true })
    const absolute = path.join(root, 'ws', 'c.txt')
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, 'AFTERC')

    const lines = [
      rawLine({ seq: 0, path: 'relative/file.txt', afterDeleted: true }),
      rawLine({ seq: 1, path: path.join(root, 'ws', 'nul\0.txt'), afterDeleted: true }),
      rawLine({ seq: 2, path: absolute, bin: '../evil.bin', afterSha256: sha256Hex('AFTERC') }),
      rawLine({ seq: 3, path: absolute, bin: 'evil.bin', afterSha256: sha256Hex('AFTERC') }),
    ]
    await fs.writeFile(journalPath(dir), lines.join(''))

    const undo = await interruptedOnly(undoRoot)
    let wrote = false
    const result = await replayUndoJournal(undo, {
      write: async (p, bytes) => {
        wrote = true
        await fs.writeFile(p, bytes)
      },
    })

    assert.equal(result.restored, 0)
    assert.equal(result.skipped.length, 0)
    assert.equal(result.failed.length, 4)
    assert.ok(
      result.failed.every((line) => line.includes('unsafe-path') || line.includes('unsafe-bin')),
      result.failed.join('\n'),
    )
    assert.equal(wrote, false)
    assert.equal(await fs.readFile(absolute, 'utf8'), 'AFTERC')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-10 record 写盘失败 ⇒ 抛错且 journal 不留半行；create 建不出目录 ⇒ 拒绝', async () => {
  const root = await makeRoot('j10')
  try {
    const dir = path.join(root, 'undo', undoDirName(900051, 13))
    const target = path.join(root, 'ws', 'a.txt')
    const writer = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await writer.record(target, text('A0'), { sha256: sha256Hex('A1') })

    // 让下一条的前像写不进去：bin 目标路径先占成目录（磁盘满/EACCES 的可复现替身）
    await fs.mkdir(path.join(dir, '1.bin'))
    await assert.rejects(writer.record(target, text('A1'), { sha256: sha256Hex('A2') }))
    assert.equal((await readLines(dir)).length, 1)
    assert.equal((await fs.readFile(journalPath(dir), 'utf8')).endsWith('\n'), true)
    const snapshot = await readUndoJournal(dir)
    assert.equal(snapshot?.truncatedTail, false)
    assert.equal(snapshot?.entries.length, 1)
    assert.equal(snapshot?.entries[0]?.seq, 0)
    assert.equal(await fs.readFile(path.join(dir, '0.bin'), 'utf8'), 'A0')

    await writer.dispose()
    await assert.rejects(writer.record(target, text('A9'), { sha256: sha256Hex('A9') }))
    assert.equal((await readLines(dir)).length, 1)

    const asFile = path.join(root, 'not-a-dir')
    await fs.writeFile(asFile, 'x')
    await assert.rejects(UndoJournalWriter.create(asFile))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-11 create 续写：截掉残缺尾行 + 序号接续（旧前像不被覆盖）', async () => {
  const root = await makeRoot('j11')
  try {
    const undoRoot = path.join(root, 'undo')
    const dir = path.join(undoRoot, undoDirName(900061, 14))
    const t1 = path.join(root, 'ws', 'a.txt')
    const t2 = path.join(root, 'ws', 'b.txt')
    const first = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await first.record(t1, text('A0'), { sha256: sha256Hex('A1') })
    await first.record(t2, text('B0'), { sha256: sha256Hex('B1') })
    await first.dispose()

    const full = await fs.readFile(journalPath(dir))
    await fs.writeFile(journalPath(dir), full.subarray(0, full.length - 20))  // 第二行只写了一半

    const second = await UndoJournalWriter.create(dir, { now: () => REAL_NOW })
    await second.record(t2, text('B0b'), { sha256: sha256Hex('B1') })
    await second.dispose()

    const snapshot = await readUndoJournal(dir)
    assert.ok(snapshot !== null)
    assert.equal(snapshot.truncatedTail, false)
    assert.deepEqual(
      snapshot.entries.map((entry) => [entry.seq, entry.path, entry.bin]),
      [
        [0, t1, '0.bin'],
        [1, t2, '1.bin'],
      ],
    )
    assert.equal(await fs.readFile(path.join(dir, '0.bin'), 'utf8'), 'A0')
    assert.equal(await fs.readFile(path.join(dir, '1.bin'), 'utf8'), 'B0b')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('J-12 静态：只 import node: 内置与仓内 .ts（零运行时依赖）', async () => {
  const source = await fs.readFile(new URL('./rollback-undo-journal.ts', import.meta.url), 'utf8')
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '')
  assert.ok(specifiers.length > 0)
  for (const specifier of specifiers) {
    const ok = specifier.startsWith('node:') || (specifier.startsWith('.') && specifier.endsWith('.ts'))
    assert.ok(ok, '非法 import（必须 node: 内置或仓内 .ts）：' + specifier)
  }
})
