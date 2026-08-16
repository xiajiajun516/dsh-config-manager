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
  DEFAULT_RUN_RETENTION_MS, RunConflictError, RunRegistry,
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
