/**
 * RunRegistry 基础单测（m1 自测，m4 会补全埋点/路由/轮询测试）：
 *  - register：不可猜 runId、running 初始态、同 kind 并发拒绝（不同 kind 互不阻塞）
 *  - update：进度字段落账并刷新 updatedAt；完成/失败后晚到更新被忽略
 *  - finish/fail：状态与 result/error 落账
 *  - get/listActive：过滤语义与不存在处理
 *  - 保留期清理：超过 retentionMs 后不可见（含长期 running 僵死任务）
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RUN_RETENTION_MS, MAX_RUN_LOG_LINES, RunConflictError, RunRegistry,
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

test('保留期清理: 超过 retentionMs 后不可见（含长期 running 僵死任务）', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 1000, now: () => now })
  const run = reg.register('export')
  now = 500
  reg.finish(run.runId, { ok: true })
  assert.ok(reg.get(run.runId), '保留期内可见')
  now = 1501
  assert.equal(reg.get(run.runId), undefined, '超过保留期清理')
  assert.equal(reg.listActive().length, 0)
})

test('保留期清理: 长时间不 settle 的 running run 同样被清理', () => {
  let now = 0
  const reg = new RunRegistry({ retentionMs: 60000, now: () => now })
  reg.register('import')
  now = 60001
  assert.equal(reg.listActive().length, 0, '僵死 running run 也要清理')
})

test('默认保留期常量为 30 分钟', () => {
  assert.equal(DEFAULT_RUN_RETENTION_MS, 30 * 60 * 1000)
})
