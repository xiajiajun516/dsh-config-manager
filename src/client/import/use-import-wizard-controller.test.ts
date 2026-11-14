/**
 * 导入向导控制器的两处事务语义（审计 P9-7 / P9-8）。
 *
 * 为什么测纯函数而不是 hook：仓库没有组件测试环境（AGENTS.md：逻辑提炼到可 node 跑的函数）。
 * 于是把「解锁 → 继续分析」写成注入端口的异步事务、把「咨询失败 → 文案」写成纯函数，
 * 这里直接跑它们；再用一条源码断言锁住 hook 里**确实调用了**这两处（纯函数测绿但没接线 = 白测）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ConfigManagerApiError } from '../common/http.ts'
import {
  consultFailureError,
  unlockArchiveThenAnalyze,
  type ArchiveUnlockFlow,
} from './use-import-wizard-controller.ts'

/** 被实测的接线源码（断言 hook 里确实调用了下面两个纯函数） */
const CONTROLLER = fileURLToPath(new URL('./use-import-wizard-controller.ts', import.meta.url))

/* ---------------------------------------------------------------- P9-7 ---- */

test('P9-7 consultFailureError：404 = 宿主不支持（null），其余失败 = 可读消息', () => {
  // 404：老宿主没有 /consult 路由 —— 界面继续按「宿主不支持」渲染 info 横幅，不制造错误
  assert.equal(consultFailureError(new ConfigManagerApiError('Not Found', 404)), null)
  assert.equal(
    consultFailureError(new ConfigManagerApiError('404 no route', 404, 'not-found')),
    null,
    '带 code 的 404 同样是「不支持」',
  )
  // 其它状态码：必须变成可见错误（此前 catch 只 setConsultReport(null) ⇒ 用户看到「没有结论」）
  assert.equal(consultFailureError(new ConfigManagerApiError('boom', 500)), 'boom')
  assert.equal(consultFailureError(new ConfigManagerApiError('timeout', 504)), 'timeout')
  // 无 status（网络层 / 解析失败）
  assert.equal(consultFailureError(new Error('fetch failed')), 'fetch failed')
  // 非 Error 值兜底为字符串，不能变成 undefined / [object Object]
  assert.equal(consultFailureError('plain text'), 'plain text')
  assert.equal(consultFailureError(undefined), 'undefined')
})

test('P9-7 接线：consult 失败时把消息写进 import.error（而不是只清空报告）', () => {
  const src = fs.readFileSync(CONTROLLER, 'utf8')
  assert.match(src, /const message = consultFailureError\(err\)/, 'catch 必须经 consultFailureError 分档')
  assert.match(src, /if \(message !== null\) \{\s*runStore\.patch\(\{ import: \{ error: message \} \}\)/, '非 404 失败必须写 import.error 供 ErrorBanner 渲染')
})

/* ---------------------------------------------------------------- P9-8 ---- */

interface Trace {
  calls: string[]
}

function flow(
  trace: Trace,
  opts: {
    unlockFails?: boolean
    analyzeFails?: boolean
    /** 第 n 次调用 cancelled() 的返回值（默认恒 false） */
    cancelledAt?: (call: number) => boolean
  } = {},
): ArchiveUnlockFlow<string> {
  let cancelledCalls = 0
  return {
    unlock: async () => {
      trace.calls.push('unlock')
      if (opts.unlockFails === true) throw new Error('密码错误')
      return { refs: ['a', 'b'] }
    },
    commitUnlocked: (refs) => { trace.calls.push('commit:' + refs.join(',')) },
    analyze: async () => {
      trace.calls.push('analyze')
      if (opts.analyzeFails === true) throw new Error('ZIP 解析失败')
      return null
    },
    rollbackUnlocked: () => { trace.calls.push('rollback') },
    cancelled: () => {
      cancelledCalls += 1
      return opts.cancelledAt === undefined ? false : opts.cancelledAt(cancelledCalls)
    },
  }
}

test('P9-8 unlockArchiveThenAnalyze：成功路径按 解锁 → 提交 → 分析 顺序进行，不回滚', async () => {
  const trace: Trace = { calls: [] }
  const outcome = await unlockArchiveThenAnalyze(flow(trace))
  assert.deepEqual(outcome, { status: 'ok' })
  assert.deepEqual(trace.calls, ['unlock', 'commit:a,b', 'analyze'])
})

test('P9-8 unlockArchiveThenAnalyze：解锁成功但 selectZip 抛错 ⇒ 回滚已提交的解锁态', async () => {
  const trace: Trace = { calls: [] }
  const outcome = await unlockArchiveThenAnalyze(flow(trace, { analyzeFails: true }))
  // 这就是审计的根因场景：archiveUnlocked 已 true 而 phase 停在 decrypt-archive
  assert.deepEqual(outcome, { status: 'failed', message: 'ZIP 解析失败', unlocked: true })
  assert.deepEqual(trace.calls, ['unlock', 'commit:a,b', 'analyze', 'rollback'], '提交过就必须回滚，且只回滚一次')
})

test('P9-8 unlockArchiveThenAnalyze：解锁本身失败 ⇒ 不提交、不回滚', async () => {
  const trace: Trace = { calls: [] }
  const outcome = await unlockArchiveThenAnalyze(flow(trace, { unlockFails: true }))
  assert.deepEqual(outcome, { status: 'failed', message: '密码错误', unlocked: false })
  assert.deepEqual(trace.calls, ['unlock'], '没提交过的解锁态没有可回滚的东西')
})

test('P9-8 unlockArchiveThenAnalyze：解锁期间向导被重置 ⇒ 丢弃结果，不提交', async () => {
  const trace: Trace = { calls: [] }
  const outcome = await unlockArchiveThenAnalyze(flow(trace, { cancelledAt: (n) => n === 1 }))
  assert.deepEqual(outcome, { status: 'cancelled' })
  assert.deepEqual(trace.calls, ['unlock'], 'reset 已清空状态，再提交会污染新一轮导入')
})

test('P9-8 unlockArchiveThenAnalyze：分析失败时若向导已被重置 ⇒ 不回滚（不覆盖新一轮）', async () => {
  const trace: Trace = { calls: [] }
  // 第 1 次（提交前）false，第 2 次（catch 里）true —— 用户恰在 analyze 期间点了重新选择
  const outcome = await unlockArchiveThenAnalyze(flow(trace, { analyzeFails: true, cancelledAt: (n) => n === 2 }))
  assert.deepEqual(outcome, { status: 'cancelled' })
  assert.deepEqual(trace.calls, ['unlock', 'commit:a,b', 'analyze'], '回滚会把已重置的向导再拽回 decrypt-archive')
})

test('P9-8 接线：onUnlockArchive 使用事务，且回滚同时写 wizard 与 store 两份状态', () => {
  const src = fs.readFileSync(CONTROLLER, 'utf8')
  assert.match(src, /const outcome = await unlockArchiveThenAnalyze\(\{/, 'onUnlockArchive 必须走事务，而不是 try 里直接 patch')
  // 回滚块：wizard 侧（setDecryptPassword('') / setArchiveEncrypted(true, …)）+ store 侧四个字段
  assert.match(src, /wizard\.setArchiveEncrypted\(true, encryptedPath\)/, '回滚必须把 wizard 恢复成「加密未解锁」')
  assert.match(src, /archiveUnlocked: false,[\s\S]{0,120}phase: 'decrypt-archive'/, '回滚必须把 phase 退回 decrypt-archive（与 archiveUnlocked 一致）')
  assert.match(src, /if \(outcome\.status === 'failed'\) \{/, '失败必须走可见错误（archiveUnlockError）')
})
