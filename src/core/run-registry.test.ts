/**
 * RunRegistry 基础单测（m1 自测，m4 会补全埋点/路由/轮询测试）：
 *  - register：不可猜 runId、running 初始态、同 kind 并发拒绝（不同 kind 互不阻塞）
 *  - update：进度字段落账并刷新 updatedAt；完成/失败后晚到更新被忽略
 *  - finish/fail：状态与 result/error 落账
 *  - get/listActive：过滤语义与不存在处理
 *  - 保留期清理：终态 run 超过 retentionMs 后不可见；**running run 不受 retentionMs 影响**
 *    （修 P0-6：两条后台调度器从 register 到 finish 从不写 update，updatedAt 恒为注册时刻，
 *    旧实现会把还在跑的长任务一起删掉 —— 随后 /progress 恒 404、finish() 静默失效）；
 *    长期不 settle 的 running run 另有 stalledRunMs 兜底（缺省远长于 retentionMs）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RUN_RETENTION_MS, DEFAULT_RUN_STALLED_MS, MAX_RUN_LOG_LINES, RunConflictError, RunRegistry,
} from './run-registry.ts'

test('register: 生成不可猜的 32 hex runId 且初始为 running', () => {
  const reg = new RunRegistry()
  const run = reg.register('export')
  assert.match(run.runId, /^[0-9a-f]{32}$/)
  assert.equal(run.status, 'running')
  assert.equal(run.kind, 'export')
  assert.equal(run.section, null)
  assert.equal(run.item, null)
  assert.ok(run.createdAt > 0)
  assert.equal(run.updatedAt, run.createdAt)
})

test('register: 同 kind 进行中拒绝新 run（RunConflictError 携带既有 runId）', () => {
  const reg = new RunRegistry()
  const first = reg.register('export')
  assert.throws(
    () => reg.register('export'),
    (err: unknown) => {
      assert.ok(err instanceof RunConflictError)
      assert.equal((err as RunConflictError).runId, first.runId)
      return true
    },
  )
})

test('register: 不同 kind 互不阻塞（导出进行中可导入）', () => {
  const reg = new RunRegistry()
  reg.register('export')
  const imp = reg.register('import')
  assert.equal(imp.kind, 'import')
  assert.equal(reg.listActive().length, 2)
})

test('register: 完成/失败后的 run 不阻塞同 kind 新 run', () => {
  const reg = new RunRegistry()
  const first = reg.register('export')
  reg.finish(first.runId, { ok: true })
  const second = reg.register('export')
  assert.notEqual(second.runId, first.runId)

  const failed = reg.register('import')
  reg.fail(failed.runId, 'boom')
  const retry = reg.register('import')
  assert.notEqual(retry.runId, failed.runId)
})

test('update: 进度字段落账并刷新 updatedAt', () => {
  let now = 1000
  const reg = new RunRegistry({ now: () => now })
  const run = reg.register('import')
  now = 1200
  reg.update(run.runId, { section: 'plugins', item: 3, itemTotal: 10, detail: 'plugin:pkg-a' })
  const state = reg.get(run.runId)
  assert.equal(state?.section, 'plugins')
  assert.equal(state?.item, 3)
  assert.equal(state?.itemTotal, 10)
  assert.equal(state?.detail, 'plugin:pkg-a')
  assert.equal(state?.updatedAt, 1200, 'update 必须刷新 updatedAt')
})

test('update: 完成/失败后的晚到更新被忽略（异步回调竞态防御）', () => {
  const reg = new RunRegistry()
  const run = reg.register('export')
  reg.update(run.runId, { detail: 'settings' })
  reg.finish(run.runId, { zipPath: 'x.zip' })
  reg.update(run.runId, { detail: 'late-write' })
  const state = reg.get(run.runId)
  assert.equal(state?.status, 'done')
  assert.equal(state?.detail, 'settings', 'finish 后的 update 不得覆盖')
  assert.deepEqual(state?.result, { zipPath: 'x.zip' })
})

test('appendLog: 追加执行日志行并刷新 updatedAt；不存在/已结束的 run 忽略', () => {
  let now = 1000
  const reg = new RunRegistry({ now: () => now })
  const run = reg.register('import')
  assert.deepEqual(run.log, [], '初始 log 为空数组')
  now = 1100
  reg.appendLog(run.runId, '▶ settings:general')
  reg.appendLog(run.runId, '$ dsh plugin --profile web add @scope/pkg')
  const state = reg.get(run.runId)
  assert.deepEqual(state?.log, ['▶ settings:general', '$ dsh plugin --profile web add @scope/pkg'])
  assert.equal(state?.updatedAt, 1100, 'appendLog 必须刷新 updatedAt')

  // 完成后晚到追加被忽略（防御异步回调竞态）
  reg.finish(run.runId, { ok: true })
  reg.appendLog(run.runId, 'late')
  assert.deepEqual(reg.get(run.runId)?.log, ['▶ settings:general', '$ dsh plugin --profile web add @scope/pkg'], 'finish 后的 appendLog 不得写入')

  // 不存在 → undefined
  assert.equal(reg.appendLog('nope', 'x'), undefined)
})

test('appendLog: 日志行数封顶 MAX_RUN_LOG_LINES（超限截断保留最新）', () => {
  const reg = new RunRegistry()
  const run = reg.register('import')
  for (let i = 0; i < MAX_RUN_LOG_LINES + 10; i++) {
    reg.appendLog(run.runId, `line-${i}`)
  }
  const state = reg.get(run.runId)
  assert.equal(state?.log.length, MAX_RUN_LOG_LINES)
  assert.equal(state?.log[0], 'line-10', '截断后保留最新行')
  assert.equal(state?.log[state!.log.length - 1], `line-${MAX_RUN_LOG_LINES + 9}`)
})

test('appendLog: 不可变追加——每次 append 换新数组引用（React memo 感知新行；封顶后长度恒定但引用仍变）', () => {
  const reg = new RunRegistry()
  const run = reg.register('import')
  const initial = reg.get(run.runId)!.log
  reg.appendLog(run.runId, 'line-1')
  const second = reg.get(run.runId)!.log
  assert.notEqual(second, initial, 'append 必须生成新数组引用（不得原地 push）')
  assert.deepEqual(second, ['line-1'])

  // 500 行封顶后：长度恒定（memo 按长度比较会漏），但每次 append 引用必变
  const capRun = reg.register('export')
  const refs = new Set<unknown[]>()
  for (let i = 0; i < MAX_RUN_LOG_LINES + 5; i++) {
    reg.appendLog(capRun.runId, `line-${i}`)
    refs.add(reg.get(capRun.runId)!.log)
  }
  assert.equal(reg.get(capRun.runId)!.log.length, MAX_RUN_LOG_LINES)
  assert.equal(refs.size, MAX_RUN_LOG_LINES + 5, '每次 append 都是新引用（含封顶后）——前端以引用比较不会漏渲染')
})

test('register: 快照恢复（restore）同 kind 进行中拒绝（P1-1 并发恢复防护）', () => {
  const reg = new RunRegistry()
  const first = reg.register('restore')
  assert.throws(
    () => reg.register('restore'),
    (err: unknown) => {
      assert.ok(err instanceof RunConflictError)
      assert.equal((err as RunConflictError).runId, first.runId)
      return true
    },
  )
  // 恢复中允许导出（不同 kind 互不阻塞）
  const exp = reg.register('export')
  assert.equal(exp.kind, 'export')
  // 完成后的 restore 不阻塞新 restore
  reg.finish(first.runId, {})
  const second = reg.register('restore')
  assert.notEqual(second.runId, first.runId)
})

test('register: recovery 同 kind 进行中拒绝（并发 recovery 防护）', () => {
  const reg = new RunRegistry()
  const first = reg.register('recovery')
  assert.throws(
    () => reg.register('recovery'),
    (err: unknown) => {
      assert.ok(err instanceof RunConflictError)
      assert.equal((err as RunConflictError).runId, first.runId)
      return true
    },
  )
  // 恢复中允许导出（不同 kind 互不阻塞）
  const exp = reg.register('export')
  assert.equal(exp.kind, 'export')
  // 完成后的 recovery 不阻塞新 recovery
  reg.finish(first.runId, {})
  const second = reg.register('recovery')
  assert.notEqual(second.runId, first.runId)
})

test('finish/fail: 状态与 result/error 落账', () => {
  const reg = new RunRegistry()
  const done = reg.register('export')
  reg.finish(done.runId, { zipPath: 'dsh-config.zip', manifest: { schemaVersion: 1 } })
  const after = reg.get(done.runId)
  assert.equal(after?.status, 'done')
  assert.deepEqual(after?.result, { zipPath: 'dsh-config.zip', manifest: { schemaVersion: 1 } })

  const failed = reg.register('import')
  reg.fail(failed.runId, '安装插件失败')
  const f = reg.get(failed.runId)
  assert.equal(f?.status, 'failed')
  assert.equal(f?.error, '安装插件失败')
})

test('get/listActive: 只列出 running run；不存在返回 undefined', () => {
  const reg = new RunRegistry()
  assert.equal(reg.get('nope'), undefined)
  const a = reg.register('export')
  const b = reg.register('import')
  reg.finish(a.runId, {})
  const active = reg.listActive()
  assert.equal(active.length, 1)
  assert.equal(active[0]?.runId, b.runId)
  // 返回副本：外部改动不影响内部状态
  active[0]!.detail = 'hacked'
  assert.notEqual(reg.get(b.runId)?.detail, 'hacked')
})

test('保留期清理: 终态 run 超过 retentionMs 后不可见', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 1000, now: () => now })
  const run = reg.register('export')
  now = 500
  reg.finish(run.runId, { ok: true })
  assert.ok(reg.get(run.runId), '保留期内可见')
  now = 1501
  assert.equal(reg.get(run.runId), undefined, '终态 run 超过保留期照旧清理')
  assert.equal(reg.listActive().length, 0)
})

/**
 * P0-6 回归：running run 绝不能因 updatedAt 陈旧被删。
 * 现场：autosync / backup-schedule 从 register 到 finish 从不写 update/appendLog，
 * updatedAt 恒为注册时刻 → 超过默认 30 分钟的后台任务会被下一次 /progress 轮询（内部先
 * prune）删掉，随后 /progress 恒 404、finish() 静默返回 undefined、同 kind 防重失效。
 */
test('保留期清理 P0-6: updatedAt 陈旧的 running run 不被 prune 掉（get/listActive 仍可取得）', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 60000, now: () => now })
  const run = reg.register('autosync')

  now = 60001 // 超过 retentionMs；running run 期间一次 update 都没写（调度器真实形态）
  const got = reg.get(run.runId)
  assert.ok(got, 'running run 不得被 get() 的惰性 prune 掉')
  assert.equal(got?.status, 'running')

  const active = reg.listActive()
  assert.equal(active.length, 1, 'running run 必须仍在活跃列表里（否则前端进度条消失）')
  assert.equal(active[0]?.runId, run.runId)

  // 任务照常收敛：finish 必须能拿到这条 run（旧实现返回 undefined，结果静默丢失）
  const finished = reg.finish(run.runId, { ok: true })
  assert.ok(finished, 'finish 不得因 run 被 prune 而静默返回 undefined')
  assert.equal(finished?.status, 'done')

  // running 期间的陈旧不阻塞同 kind 新 run 的语义不变（仍是 409 防重）
  now = 120002
  assert.equal(reg.get(run.runId), undefined, '转终态后回归 retentionMs 清理')
})

test('保留期清理 P0-6: running 期间不被清理，但同 kind 防重仍生效（不得静默放行并发）', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 1, now: () => now })
  reg.register('backup-schedule')
  now = 1000000
  assert.throws(() => reg.register('backup-schedule'), RunConflictError, 'running run 必须继续挡住同 kind 新 run')
})

test('保留期清理: 长期不 settle 的 running run 由 stalledRunMs 兜底清理（缺省远长于 retentionMs）', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 60000, stalledRunMs: 600000, now: () => now })
  const run = reg.register('import')

  now = 60001
  assert.ok(reg.get(run.runId), '超过 retentionMs 但未到 stalledRunMs：running run 仍在')

  now = 600001
  assert.equal(reg.get(run.runId), undefined, '超过 stalledRunMs：僵死 running run 兜底清理（不永久堵住同 kind）')
  assert.equal(reg.listActive().length, 0)
})

test('stalledRunMs: 缺省值为 6 小时（远长于 30 分钟 retention，避免误杀长任务）', () => {
  assert.equal(DEFAULT_RUN_STALLED_MS, 6 * 60 * 60 * 1000)
  assert.ok(DEFAULT_RUN_STALLED_MS > DEFAULT_RUN_RETENTION_MS, 'stalled 阈值必须显著长于终态保留期')
})

test('默认保留期常量为 30 分钟', () => {
  assert.equal(DEFAULT_RUN_RETENTION_MS, 30 * 60 * 1000)
})
