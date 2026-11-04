import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHistoryPruner } from './history-prune.ts'

/** 记录调用的假 store：默认删除「多余」条目，返回被删数量。 */
function fakeHistory(behaviour: 'ok' | 'throw' = 'ok') {
  const calls: number[] = []
  return {
    calls,
    async retention(limit: number): Promise<string[]> {
      calls.push(limit)
      if (behaviour === 'throw') throw new Error('EACCES')
      return ['a.json', 'b.json'].slice(0, Math.max(0, limit - 1))
    },
  }
}

function fakeLog() {
  const info: Array<{ message: string; meta?: Record<string, unknown> }> = []
  const warn: Array<{ message: string; meta?: Record<string, unknown> }> = []
  return {
    info,
    warn,
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => { info.push({ message, ...(meta ? { meta } : {}) }) },
      warn: (message: string, meta?: Record<string, unknown>) => { warn.push({ message, ...(meta ? { meta } : {}) }) },
    },
  }
}

test('启动触发：按配置上限清理一次并写日志；0 = 不限制时一次都不删', async () => {
  const history = fakeHistory()
  const { logger, info } = fakeLog()
  const prune = createHistoryPruner({ history, log: logger, readRetentionLimit: async () => 3 })
  await prune('startup')
  assert.deepEqual(history.calls, [3], '启动应清一次，且用配置值')
  assert.equal(info.length, 1, '删掉了条目就要留一条日志')
  assert.equal(info[0]?.message, '迁移历史自动清理')
  assert.deepEqual(info[0]?.meta, { maxEntries: 3, removed: 2 })

  const unlimited = fakeHistory()
  const second = fakeLog()
  const pruneUnlimited = createHistoryPruner({ history: unlimited, log: second.logger, readRetentionLimit: async () => 0 })
  await pruneUnlimited('startup')
  assert.deepEqual(unlimited.calls, [], '0 = 不限制 ⇒ 绝不批量删')
  assert.equal(second.info.length, 0)
})

test('非法配置回落缺省 1000（不因手改 ui-prefs 把历史全删）', async () => {
  const history = fakeHistory()
  const { logger } = fakeLog()
  const prune = createHistoryPruner({ history, log: logger, readRetentionLimit: async () => '1000' })
  await prune('startup')
  assert.deepEqual(history.calls, [1000], '字符串等非法值必须回落 DEFAULT_MIGRATION_RETENTION')
})

test('写入触发按 60 s 节流：紧接着的第二次 append 跳过，窗口过后再放行', async () => {
  const history = fakeHistory()
  const { logger } = fakeLog()
  let clock = 1_000_000
  const prune = createHistoryPruner({ history, log: logger, readRetentionLimit: async () => 5, now: () => clock })
  await prune('startup')
  await prune('append')
  assert.deepEqual(history.calls, [5], '刚启动清理过 ⇒ 紧随的 append 落在节流窗口内');
  clock += 61_000
  await prune('append')
  assert.deepEqual(history.calls, [5, 5], '窗口过后 append 应执行')
})

test('防重入：并发调用只有一次真正执行', async () => {
  const calls: number[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const history = {
    calls,
    async retention(limit: number): Promise<string[]> {
      calls.push(limit)
      await gate
      return []
    },
  }
  const prune = createHistoryPruner({ history, log: fakeLog().logger, readRetentionLimit: async () => 2, now: () => 0 })
  const first = prune('startup')
  const second = prune('append')
  await second
  assert.deepEqual(calls, [2], '在飞期间不得并发再删一遍')
  release()
  await first
})

test('失败只进日志、绝不抛错（清理失败不能拖垮历史写入）', async () => {
  const history = fakeHistory('throw')
  const { logger, warn, info } = fakeLog()
  const prune = createHistoryPruner({ history, log: logger, readRetentionLimit: async () => 10 })
  await prune('startup')
  assert.equal(info.length, 0)
  assert.equal(warn.length, 1)
  assert.equal(warn[0]?.message, '迁移历史自动清理失败')
  assert.match(String(warn[0]?.meta?.['error']), /EACCES/)
})

test('读配置本身失败也走 warn 分支（ui-prefs 读不出不阻塞后续触发）', async () => {
  const history = fakeHistory()
  const { logger, warn } = fakeLog()
  let attempts = 0
  const prune = createHistoryPruner({
    history,
    log: logger,
    readRetentionLimit: async () => { attempts += 1; if (attempts === 1) throw new Error('boom'); return 4 },
  })
  await prune('startup')
  assert.equal(warn.length, 1)
  await prune('startup')
  assert.deepEqual(history.calls, [4], '下一次触发应恢复正常（inFlight 已复位）')
})
