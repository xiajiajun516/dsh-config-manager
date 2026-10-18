/**
 * 会话活跃时间窗（2026-10-18 定案：写入归属的**时间维度**）单元测试。
 *
 * 八条判据逐条钉住：合并/切分、乱序、多会话交错、落盘往返与原子写、跨进程并集、
 * 损坏只 warn、上限与 fail-closed 输入、flush 幂等与 dispose。
 * 所有用例只碰 os.tmpdir() 下的临时目录，绝不写真实用户数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  ROLLBACK_ACTIVITY_DEFAULT_GAP_MS,
  ROLLBACK_ACTIVITY_FILE_NAME,
  ROLLBACK_ACTIVITY_MAX_INTERVALS,
  RollbackSessionActivity,
  type RollbackActivityInterval,
} from './rollback-activity.ts'

interface ActivityPayload {
  version: number
  intervals: RollbackActivityInterval[]
}

/** 只在临时目录里建实例（文件可能被写到，绝不指向真实数据） */
async function withTempDir<T>(run: (dir: string, file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-'))
  try {
    return await run(dir, path.join(dir, 'activity.json'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** 读落盘载荷（测试里要逐字段核对，文件里才是真相） */
async function readPayload(file: string): Promise<ActivityPayload> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as ActivityPayload
}

/** 等定时落盘：轮询到文件出现为止（有上限，绝不死等） */
async function waitForFile(file: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT' || Date.now() > deadline) throw error
      await delay(10)
    }
  }
}

test('A-1 同一会话：间隔 <= gapMs 合并成一条，超过就新开；from/to 单调', async () => {
  await withTempDir(async (_dir, file) => {
    const activity = new RollbackSessionActivity({ file, gapMs: 1000, flushDelayMs: 0 })
    activity.noteActivity('s', 0)
    activity.noteActivity('s', 500)
    activity.noteActivity('s', 1500) // 1500 - 500 = 1000 === gapMs ⇒ 并入（判据是「<=」）
    assert.equal(activity.size, 1, '间隔恰好等于 gapMs 必须合并')
    assert.equal(activity.lastActivityAt('s'), 1500)
    assert.deepEqual(activity.sessionsActiveAt(800), ['s'])

    activity.noteActivity('s', 2501) // 2501 - 1500 = 1001 > gapMs ⇒ 新开一条
    assert.equal(activity.size, 2, '超过 gapMs 必须新开一条窗口')
    assert.deepEqual(activity.sessionsActiveAt(2500), [], '两条窗口之间的空档不算活跃')

    await activity.flush()
    const payload = await readPayload(file)
    assert.equal(payload.version, 1)
    assert.deepEqual(payload.intervals, [
      { sessionId: 's', from: 0, to: 1500 },
      { sessionId: 's', from: 2501, to: 2501 },
    ])
  })
})

test('A-2 乱序到达（时钟回拨）：插入后仍按 from 升序、互不相接', async () => {
  await withTempDir(async (_dir, file) => {
    const activity = new RollbackSessionActivity({ file, gapMs: 100, flushDelayMs: 0 })
    activity.noteActivity('s', 5000)
    activity.noteActivity('s', 100) // 早于已有窗口 ⇒ 新开一条且排在前
    activity.noteActivity('s', 950) // 与 5000 的缝 4050 > 100 ⇒ 独立；与 100 的缝 850 > 100 ⇒ 独立
    await activity.flush()
    assert.deepEqual((await readPayload(file)).intervals, [
      { sessionId: 's', from: 100, to: 100 },
      { sessionId: 's', from: 950, to: 950 },
      { sessionId: 's', from: 5000, to: 5000 },
    ])
    // 乱序不能把缝隙填上（填上就等于凭空多出一段「活跃」）
    assert.deepEqual(activity.sessionsActiveAt(3000), [])
  })
})

test('A-3 多会话交错：只返回窗口覆盖该时刻的会话，按 id 升序去重', async () => {
  const activity = new RollbackSessionActivity({ file: path.join(os.tmpdir(), 'activity-never-written.json'), gapMs: 100, flushDelayMs: 0 })
  activity.noteActivity('s-b', 50)
  activity.noteActivity('s-b', 60)
  activity.noteActivity('s-a', 0)
  activity.noteActivity('s-a', 100) // 100 - 0 === gapMs ⇒ 并成 [0, 100]

  assert.deepEqual(activity.sessionsActiveAt(55), ['s-a', 's-b'])
  assert.deepEqual(activity.sessionsActiveAt(70), ['s-a'], '窗口之外的会话绝不能被返回')
  assert.deepEqual(activity.sessionsActiveAt(200), [])
  assert.deepEqual(activity.sessionsActiveAt(105, 5), ['s-a'], '容忍度只放宽边界，不虚构窗口')
  assert.deepEqual(activity.sessionsActiveAt(111, 5), [])
  assert.deepEqual(activity.sessionsActiveAt(Number.NaN), [])

  assert.equal(activity.isActiveAt('s-b', 55), true)
  assert.equal(activity.isActiveAt('s-b', 100), false)
  assert.equal(activity.isActiveAt('missing', 55), false)
  assert.equal(activity.lastActivityAt('s-a'), 100)
  assert.equal(activity.lastActivityAt('missing'), null, '没记过 = null，绝不是 0')
  assert.equal(activity.hasDataFor('s-b'), true)
  assert.equal(activity.hasDataFor('s-c'), false, '未采集 ≠ 无活动，必须能区分')
})

test('A-4 落盘 / 回读往返逐字段一致，且原子写不留 .tmp', async () => {
  await withTempDir(async (_dir, file) => {
    const activity = new RollbackSessionActivity({ file, gapMs: 100, flushDelayMs: 0 })
    activity.noteActivity('x', 10)
    activity.noteActivity('x', 50)
    activity.noteActivity('y', 120)
    await activity.flush()

    const reread = new RollbackSessionActivity({ file, gapMs: 100 })
    await reread.load()
    assert.equal(reread.size, activity.size)
    assert.equal(reread.lastActivityAt('x'), 50)
    assert.equal(reread.lastActivityAt('y'), 120)
    assert.deepEqual(reread.sessionsActiveAt(30), ['x'])
    assert.deepEqual(reread.sessionsActiveAt(25), ['x'])
    assert.deepEqual(reread.sessionsActiveAt(200), [])
    await assert.rejects(fs.stat(file + '.tmp'), '原子写不得留下临时文件')
  })
})

test('A-5 写前先读：两个实例各写同一个文件，谁的记录都不能被抹掉', async () => {
  await withTempDir(async (_dir, file) => {
    const one = new RollbackSessionActivity({ file, gapMs: 1000, flushDelayMs: 0 })
    one.noteActivity('s-1', 1000)
    one.noteActivity('m', 0)
    await one.flush()

    // 第二个实例**故意不 load**：它只知道自己见过的活动
    const two = new RollbackSessionActivity({ file, gapMs: 1000, flushDelayMs: 0 })
    two.noteActivity('s-2', 2000)
    two.noteActivity('m', 500) // 与磁盘上 m 的 [0,0] 缝 500 <= gapMs ⇒ 并集后应合成一条
    await two.flush()

    const three = new RollbackSessionActivity({ file, gapMs: 1000, flushDelayMs: 0 })
    await three.load()
    assert.equal(three.hasDataFor('s-1'), true, '先写者的记录必须还在')
    assert.equal(three.hasDataFor('s-2'), true, '后写者也不得覆盖式丢掉对方的窗口')
    assert.deepEqual(three.sessionsActiveAt(1000), ['s-1'])
    assert.deepEqual(three.sessionsActiveAt(2000), ['s-2'])
    assert.deepEqual(three.sessionsActiveAt(250), ['m'], '两个进程各自的 m 窗口应并成一条')
    assert.deepEqual((await readPayload(file)).intervals, [
      { sessionId: 'm', from: 0, to: 500 },
      { sessionId: 's-1', from: 1000, to: 1000 },
      { sessionId: 's-2', from: 2000, to: 2000 },
    ])
  })
})

test('A-6 损坏 / 形状不符 / 写失败 ⇒ 只 warn，内存数据仍可用，绝不抛', async () => {
  await withTempDir(async (dir, file) => {
    const warnings: string[] = []
    // ① 非法 JSON
    await fs.writeFile(file, '{not json', 'utf8')
    const a = new RollbackSessionActivity({ file, flushDelayMs: 0, warn: (line) => warnings.push(line) })
    a.noteActivity('live', 5) // 读盘之前先记一条 ⇒ 内存数据必须活下来
    await a.load()
    assert.equal(a.size, 1, '读盘失败不得清空内存')
    assert.deepEqual(a.sessionsActiveAt(5), ['live'])
    assert.equal(warnings.length, 1)

    // ② 版本 / 形状不符 = 空表（绝不猜字段含义）
    await fs.writeFile(file, JSON.stringify({ version: 2, intervals: [{ sessionId: 'x', from: 1, to: 2 }] }), 'utf8')
    const b = new RollbackSessionActivity({ file, flushDelayMs: 0, warn: (line) => warnings.push(line) })
    await b.load()
    assert.equal(b.size, 0)

    await fs.writeFile(file, JSON.stringify({ version: 1, intervals: 'nope' }), 'utf8')
    const b2 = new RollbackSessionActivity({ file, flushDelayMs: 0 })
    await b2.load()
    assert.equal(b2.size, 0)

    // ③ 单条字段形状不符 ⇒ 跳过该条，其余照收
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      intervals: [
        { sessionId: 'ok', from: 1, to: 2 },
        { sessionId: '', from: 1, to: 2 },
        { sessionId: 'bad', from: '1', to: 2 },
        { sessionId: 'bad', from: 5, to: 2 },
        { sessionId: 'bad', from: -1, to: 2 },
        null,
      ],
    }), 'utf8')
    const c = new RollbackSessionActivity({ file, flushDelayMs: 0 })
    await c.load()
    assert.equal(c.size, 1)
    assert.deepEqual(c.sessionsActiveAt(1), ['ok'])

    // ④ 文件不存在 = 正常（不 warn）
    const quiet: string[] = []
    const d = new RollbackSessionActivity({ file: path.join(dir, 'missing.json'), flushDelayMs: 0, warn: (line) => quiet.push(line) })
    await d.load()
    assert.equal(d.size, 0)
    assert.deepEqual(quiet, [], 'ENOENT 是「还没写过」，不是错误')

    // ⑤ 落盘失败（目标路径上是个目录）⇒ warn，不上抛，内存照旧
    const blocked = path.join(dir, 'as-file')
    await fs.mkdir(path.join(blocked, 'activity.json'), { recursive: true })
    const failed: string[] = []
    const e = new RollbackSessionActivity({ file: path.join(blocked, 'activity.json'), flushDelayMs: 0, warn: (line) => failed.push(line) })
    e.noteActivity('s', 1)
    await e.flush()
    assert.equal(failed.some((line) => line.includes('write failed')), true, '写不进去必须留痕')
    assert.deepEqual(e.sessionsActiveAt(1), ['s'])
  })
})

test('A-7 条目上限淘汰最旧；空 id / 非有限 / 负数时间一律忽略（fail-closed）', async () => {
  const activity = new RollbackSessionActivity({
    file: path.join(os.tmpdir(), 'activity-never-written.json'),
    gapMs: 10,
    maxIntervals: 2,
    flushDelayMs: 0,
  })
  activity.noteActivity('old', 100)
  activity.noteActivity('mid', 200)
  activity.noteActivity('new', 300)
  assert.equal(activity.size, 2, '超出上限必须淘汰')
  assert.equal(activity.hasDataFor('old'), false, '最旧的先走')
  assert.equal(activity.hasDataFor('mid'), true)
  assert.equal(activity.hasDataFor('new'), true)

  const before = activity.size
  activity.noteActivity('', 400)
  activity.noteActivity('   ', 400)
  activity.noteActivity('s', Number.NaN)
  activity.noteActivity('s', Number.POSITIVE_INFINITY)
  activity.noteActivity('s', Number.NEGATIVE_INFINITY)
  activity.noteActivity('s', -1)
  assert.equal(activity.size, before, '非法输入一律不得进表')
  assert.equal(activity.hasDataFor('s'), false)
  assert.equal(activity.lastActivityAt('s'), null)
})

test('A-8 flush 幂等：无未落盘数据时不重复写；dispose 只写还没落盘的部分', async () => {
  await withTempDir(async (_dir, file) => {
    const activity = new RollbackSessionActivity({ file, gapMs: 10, flushDelayMs: 0 })
    await activity.flush()
    await assert.rejects(fs.stat(file), '没有数据就不该建文件')

    activity.noteActivity('s', 1)
    await Promise.all([activity.flush(), activity.flush()]) // 并发调用共用同一个在飞写入
    assert.deepEqual((await readPayload(file)).intervals, [{ sessionId: 's', from: 1, to: 1 }])

    // 落盘后再无新数据 ⇒ 删掉文件也不会被重建（证明 flush 没有重复写）
    await fs.rm(file)
    await activity.flush()
    await assert.rejects(fs.stat(file), '没有未落盘数据时 flush 绝不写盘')

    // dispose：还有没落盘的活动 ⇒ 关停时写下去
    activity.noteActivity('s', 2)
    await activity.dispose()
    assert.deepEqual((await readPayload(file)).intervals, [{ sessionId: 's', from: 1, to: 2 }])

    // 再 dispose 一次：无新数据 ⇒ 不重复写（删掉文件后依然不会被重建）
    await fs.rm(file)
    await activity.dispose()
    await assert.rejects(fs.stat(file), 'dispose 无未落盘数据时不得重复写')
  })
})

test('A-9 debounce：多次 noteActivity 只落一次盘（定时器触发）', async () => {
  await withTempDir(async (_dir, file) => {
    const activity = new RollbackSessionActivity({ file, gapMs: 10, flushDelayMs: 20 })
    activity.noteActivity('s', 7)
    activity.noteActivity('s', 9)
    activity.scheduleFlush()
    activity.scheduleFlush()
    const text = await waitForFile(file) // 只能由定时器写出来（测试从未调用 flush）
    const payload = JSON.parse(text) as ActivityPayload
    assert.deepEqual(payload.intervals, [{ sessionId: 's', from: 7, to: 9 }])
    await activity.dispose()
  })
})

test('A-10 缺省口径：gapMs 缺省 10 分钟、时间戳缺省取注入时钟、上限常量有限', () => {
  assert.equal(ROLLBACK_ACTIVITY_FILE_NAME, 'activity.json')
  assert.equal(ROLLBACK_ACTIVITY_DEFAULT_GAP_MS, 10 * 60 * 1000)
  assert.equal(Number.isFinite(ROLLBACK_ACTIVITY_MAX_INTERVALS) && ROLLBACK_ACTIVITY_MAX_INTERVALS > 0, true)

  const activity = new RollbackSessionActivity({
    file: path.join(os.tmpdir(), 'activity-never-written.json'),
    now: () => 12345,
    flushDelayMs: 0,
  })
  activity.noteActivity('s') // 不传 at ⇒ 用注入时钟
  assert.equal(activity.lastActivityAt('s'), 12345)
  activity.noteActivity('s', 12345 + ROLLBACK_ACTIVITY_DEFAULT_GAP_MS) // 恰好等于缺省缝 ⇒ 合并
  assert.equal(activity.size, 1)
  activity.noteActivity('s', 12345 + ROLLBACK_ACTIVITY_DEFAULT_GAP_MS * 2 + 1) // 超出 ⇒ 新开
  assert.equal(activity.size, 2)
})
