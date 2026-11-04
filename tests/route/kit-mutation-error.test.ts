/**
 * kit 的 423 家族唯一映射点（tech-debt #9）直接单测。
 *
 * 为什么必须有：改造前「两行日志 + 两行 423 写回」被抄了 12 处（组合根 withMutationGate、
 * snapshots /restore 的自拼包壳、prefs、sync、recovery 的 8 个写路由）。收敛到
 * `src/routes/kit.ts:writeMutationError` 之后，它的两种命中形态与「未命中不写响应」的护栏
 * 只被各路由的老测试**间接**覆盖：某次改错成「未命中就写 400」，各路由自己的兜底会掩盖它，
 * 于是没有任何一条测试会红。这里直接钉住契约：
 *  - 命中 → 423 + {error, code}（字段数恰好 2、content-type/referrer-policy 与 writeJson 一致）；
 *  - 未命中 → 返回 false 且 **一个字节都不写**（调用方必须 rethrow / 用自己路由的兜底口径）；
 *  - 命中必有一条 host.log.warn（内部 op/reason/detail 只进日志，不进用户文案）。
 *
 * 手法：fake res 记录 writeHead/end 的入参与次数 + 可数 fake log，进程内跑真函数，不起 http server。
 * 最后一条用真 /restore 路由打两次（锁端口 LOCKED → 423；锁端口抛普通 Error → 400）钉住调用点，
 * 因为「kit 返回 false 之后调用方到底怎么兜」才是这条重构真正的风险面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeMutationError } from '../../src/routes/kit.ts'
import type { MutationLogSink } from '../../src/routes/kit.ts'
import { snapshotRoutes } from '../../src/routes/snapshots.ts'
import { EnvironmentLockUnavailableError } from '../../src/utils/env-lock.ts'
import { TransactionRecoveryRequiredError } from '../../src/core/phase3-host.ts'

interface Recorded {
  status: number
  headers: Record<string, string>
  body: string
  writeHeadCalls: number
  endCalls: number
}

/** 只实现 kit 的 writeJson 会碰的两个方法，并记录次数（未命中时必须是 0）。 */
function fakeResponse(): { res: ServerResponse; seen: Recorded } {
  const seen: Recorded = { status: 0, headers: {}, body: '', writeHeadCalls: 0, endCalls: 0 }
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      seen.writeHeadCalls += 1
      seen.status = status
      seen.headers = headers ?? {}
      return res
    },
    end(payload?: string) {
      seen.endCalls += 1
      seen.body = payload ?? ''
      return res
    },
  }
  return { res: res as unknown as ServerResponse, seen }
}

function countingHost(): { host: MutationLogSink; warns: string[] } {
  const warns: string[] = []
  return { host: { log: { warn: (message: string) => { warns.push(message) } } }, warns }
}

function parse(seen: Recorded): Record<string, unknown> {
  return JSON.parse(seen.body) as Record<string, unknown>
}

test('K-01 环境锁被占：423 + code=mutation-locked，字段恰好 {error, code}，日志一条', () => {
  const { res, seen } = fakeResponse()
  const { host, warns } = countingHost()
  // detail 是内部诊断，只该出现在日志里
  const error = new EnvironmentLockUnavailableError('restore', 'locked', 'holder=other-instance')
  assert.equal(writeMutationError(res, host, error), true, '命中必须返回 true（调用方据此不再兜底）')
  assert.equal(seen.status, 423)
  assert.equal(seen.writeHeadCalls, 1)
  assert.equal(seen.endCalls, 1)
  assert.equal(seen.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(seen.headers['referrer-policy'], 'no-referrer')
  const body = parse(seen)
  assert.deepEqual(Object.keys(body), ['error', 'code'], '响应体形态必须是 {error, code}，不多不少')
  assert.equal(body['code'], 'mutation-locked')
  assert.equal(body['error'], error.message, '用户看到的是错误自带的友好文案')
  assert.equal(warns.length, 1, '命中有且只有一条 warn')
  assert.ok(warns[0]?.includes('op=restore'), '日志带内部 op 诊断: ' + warns[0])
  assert.ok(warns[0]?.includes('reason=locked'), '日志带内部 reason 诊断: ' + warns[0])
  assert.ok(warns[0]?.includes('detail=holder=other-instance'), '日志带 detail 诊断: ' + warns[0])
  assert.equal(seen.body.includes('holder=other-instance'), false, '内部诊断绝不能进响应体')
})

test('K-02 未收敛事务：423 + code=transaction-recovery-required，日志一条', () => {
  const { res, seen } = fakeResponse()
  const { host, warns } = countingHost()
  const error = new TransactionRecoveryRequiredError('op-7')
  assert.equal(writeMutationError(res, host, error), true)
  assert.equal(seen.status, 423)
  const body = parse(seen)
  assert.deepEqual(Object.keys(body), ['error', 'code'])
  assert.equal(body['code'], 'transaction-recovery-required')
  assert.equal(body['error'], error.message)
  assert.equal(warns.length, 1)
  assert.ok(warns[0]?.includes(error.message), '日志必须带上同一条消息: ' + warns[0])
})

test('K-03 护栏：非 423 家族的 error 返回 false 且不写响应（不得静默降级成 400/500）', () => {
  const { res, seen } = fakeResponse()
  const { host } = countingHost()
  for (const error of [new Error('boom'), 'not-an-error', undefined, null, { message: 'shape-alike' }]) {
    assert.equal(writeMutationError(res, host, error), false, '未命中必须返回 false: ' + String(error))
  }
  assert.equal(seen.writeHeadCalls, 0, '未命中时 res.writeHead 必须零调用（写响应是调用方的责任）')
  assert.equal(seen.endCalls, 0, '未命中时 res.end 必须零调用')
  assert.equal(seen.body, '')
})

/** 只喂 /restore 需要的 env；锁端口决定这一次走 423 还是走「非 423 兜底」。 */
function restoreEnv(lock: unknown): never {
  return {
    snapshotsDir: path.join('/nonexistent-snapshots-root'),
    host: {
      homeDir: '/nonexistent-home',
      profile: 'web',
      mutationLock: lock,
      safeModeIsBlocked: () => false,
      log: { warn: () => {}, error: () => {} },
    },
    msg: (key: string) => key,
    runs: { register: () => ({ runId: 'r1', kind: 'restore', status: 'running', log: [] }), update: () => {}, finish: () => {}, fail: () => {}, appendLog: () => {} },
    tryAppendHistory: async () => undefined,
    snapshotEntrySections: async () => [],
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

async function callRestore(env: never): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = snapshotRoutes(env).find((r) => r.path === '/api/dsh-config-manager/restore')
  assert.ok(route !== undefined, '缺少 /restore 路由')
  const { res, seen } = fakeResponse()
  const req = {
    method: 'POST',
    url: '/api/dsh-config-manager/restore',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ snapshotId: 'snap-1', dryRun: false }), 'utf8')
    },
  } as unknown as IncomingMessage
  await route.handler(req, res)
  return { status: seen.status, body: seen.writeHeadCalls === 0 ? {} : parse(seen) }
}

test('K-04 /restore 调用点：锁被占 → 423 由 kit 写；锁端口抛普通错误 → 仍回落 400', async () => {
  const locked = await callRestore(restoreEnv({
    acquire: async () => ({ state: 'LOCKED' as const, token: null }),
    validate: () => false,
    release: async () => {},
  }))
  assert.equal(locked.status, 423, JSON.stringify(locked.body))
  assert.equal(locked.body['code'], 'mutation-locked')

  const broken = await callRestore(restoreEnv({
    acquire: async () => { throw new Error('lock port exploded') },
    validate: () => false,
    release: async () => {},
  }))
  assert.equal(broken.status, 400, '非 423 错误必须走本路由既有的 400 兜底，不能被吞掉或变成 500: ' + JSON.stringify(broken.body))
  assert.equal(broken.body['error'], 'lock port exploded')
  assert.equal('code' in broken.body, false, '400 兜底不带 code（只有 423 家族带）')
})
