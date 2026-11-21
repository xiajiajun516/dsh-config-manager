/**
 * 运行注册表（心跳）单测：真实临时目录 + 注入时钟/存活/终止，不真的杀进程。
 *
 * 为什么值得单测：用户实测的 bug 是「从 web 启动 cmtest 后，在 cmtest 里还能再启动 web」——
 * 修法就是这份心跳：任何实例都能看到「这台机器上哪些 profile 在跑」。判活的边界（pid 死 / 心跳过期 /
 * 坏文件）与「不能停自己」都必须钉死，否则会出现「同一个 profile 被反复拉起」或「把自己停掉」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DshProfileRuntimeRegistry, RUNTIME_REFRESH_MS, RUNTIME_STALE_MS, RUNTIME_TEMP_STALE_MS,
  isRuntimeTempBasename, parseRuntimeRecord, runtimeRecordLive,
} from './dsh-profile-runtime.ts'
import { DshProfileError } from './dsh-profile-manager.ts'
import { runtimeFileName } from './dsh-profile-io.ts'

interface HarnessOptions {
  name?: string
  pid?: number
  port?: (() => number | null) | null
  /** 进程存活剧本：true=一直活 / false=早就没了 / 'die-on-kill'=收到终止就退出 / 'survives'=怎么都杀不掉 */
  alive?: true | false | 'die-on-kill' | 'survives'
  /** 按 pid 精确指定存活（优先级最高；用于「别的 profile 的 pid 已死」这类用例） */
  aliveFor?: (pid: number) => boolean
  schedule?: (fn: () => void, ms: number) => () => void
  /** 注入原子写（默认走真实文件系统） */
  write?: (target: string, data: string, opts: { mode: number; retries: number; retryDelayMs: number }) => void
}

function makeHarness(opts: HarnessOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  let clock = 1_000_000
  let state = opts.alive ?? true
  const killed: string[] = []
  /** 心跳写/删失败的记录（issue #149：失败只许上报，绝不许抛） */
  const failures: unknown[] = []
  const registry = new DshProfileRuntimeRegistry({
    dataDir,
    name: opts.name ?? 'web',
    pid: opts.pid ?? 111,
    port: opts.port === null ? () => null : (opts.port ?? (() => 3080)),
    refreshMs: RUNTIME_REFRESH_MS,
    staleMs: RUNTIME_STALE_MS,
    ...(opts.schedule === undefined ? {} : { schedule: opts.schedule }),
    ...(opts.write === undefined ? {} : { write: opts.write }),
    onWriteFailure: (error) => { failures.push(error) },
    deps: {
      // 按 pid 判定：'die-on-kill' = 该 pid 收到终止后就不再活（别的 pid 不受影响）
      isAlivePid: (pid) => {
        if (opts.aliveFor !== undefined) return opts.aliveFor(pid)
        if (state === false) return false
        if (state === 'survives' || state === true) return true
        return !killed.some((k) => k.startsWith(`${String(pid)}:`))
      },
      killPid: (pid, mode) => {
        killed.push(`${String(pid)}:${mode}`)
      },
      sleep: (ms) => { clock += ms; return Promise.resolve() },
      now: () => clock,
      graceMs: 1_000,
    },
  })
  return {
    registry,
    dataDir,
    killed,
    failures,
    dir: join(dataDir, 'running'),
    setAlive: (next: typeof state): void => { state = next },
    tick: (ms: number): void => { clock += ms },
    cleanup: (): void => { rmSync(dataDir, { recursive: true, force: true }) },
  }
}

test('announce / listActive / withdraw：自报 → 可见 → 自撤', () => {
  const h = makeHarness({ name: 'web', pid: 111, port: () => 3080 })
  try {
    const written = h.registry.announce()
    assert.equal(written.name, 'web')
    assert.equal(written.pid, 111)
    assert.equal(written.port, 3080)
    assert.equal(existsSync(join(h.dir, runtimeFileName('web'))), true)
    const active = h.registry.listActive()
    assert.deepEqual(active.map((r) => r.name), ['web'])
    assert.equal(active[0]?.port, 3080)
    h.registry.withdraw()
    assert.deepEqual(h.registry.listActive(), [])
    assert.equal(existsSync(join(h.dir, runtimeFileName('web'))), false)
  } finally { h.cleanup() }
})

test('parseRuntimeRecord：坏 JSON / 版本不符 / 缺字段一律 null；缺 port 归 null', () => {
  assert.equal(parseRuntimeRecord('not json'), null)
  assert.equal(parseRuntimeRecord('[]'), null)
  assert.equal(parseRuntimeRecord('{"schemaVersion":99,"name":"a","pid":1,"updatedAt":1}'), null)
  assert.equal(parseRuntimeRecord('{"schemaVersion":1,"name":"a","updatedAt":1}'), null, '缺 pid')
  assert.equal(parseRuntimeRecord('{"schemaVersion":1,"name":"a","pid":0,"updatedAt":1}'), null, 'pid 非法')
  const ok = parseRuntimeRecord('{"schemaVersion":1,"name":"a","pid":7,"updatedAt":5}')
  assert.equal(ok?.port, null)
  assert.equal(ok?.startedAt, '')
})

test('runtimeRecordLive：pid 死 或 心跳过期 都算死实例', () => {
  const record = { schemaVersion: 1, name: 'a', pid: 7, port: null, startedAt: '', updatedAt: 1_000 }
  assert.equal(runtimeRecordLive(record, { isAlivePid: () => true, now: 1_000 + RUNTIME_STALE_MS }), true)
  assert.equal(runtimeRecordLive(record, { isAlivePid: () => true, now: 1_000 + RUNTIME_STALE_MS + 1 }), false, '过期')
  assert.equal(runtimeRecordLive(record, { isAlivePid: () => false, now: 1_000 }), false, 'pid 死了')
})

test('listActive：死心跳 / 过期心跳 / 坏文件都会被清掉（进程被硬杀时没人来删文件）', () => {
  const h = makeHarness({ name: 'web', pid: 111, aliveFor: (pid) => pid === 111 })
  try {
    h.registry.announce()
    mkdirSync(h.dir, { recursive: true })
    // 坏的（无法解析）
    writeFileSync(join(h.dir, 'broken.json'), '{oops')
    // 别的 profile 的死心跳：pid 已死
    const dead = { schemaVersion: 1, name: 'dead', pid: 999, port: 3099, startedAt: '', updatedAt: 1_000_000 }
    writeFileSync(join(h.dir, 'dead.json'), JSON.stringify(dead))
    // 过期心跳（进程可能被挂起/硬杀）
    const stale = { schemaVersion: 1, name: 'stale', pid: 111, port: 3098, startedAt: '', updatedAt: 1_000_000 - RUNTIME_STALE_MS - 1 }
    writeFileSync(join(h.dir, 'stale.json'), JSON.stringify(stale))
    const active = h.registry.listActive()
    assert.deepEqual(active.map((r) => r.name), ['web'], '只留活着的自己')
    assert.deepEqual(readdirSync(h.dir).sort(), [runtimeFileName('web')], '死/坏心跳文件已清理')
  } finally { h.cleanup() }
})

test('心跳文件名必须唯一：清洗后同形的两个 profile 不得共用/互删心跳（审计 P11-2 回归）', () => {
  // 旧实现 <sanitizeFilePart(name)>.json：'web' 与 'web!' 都落成 web.json ⇒ 后写的覆盖先写的，
  // listActive 只看得到一个，withdraw 还会删掉别人的心跳（对方从此「不可见」，又能被重复启动）。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  try {
    const mk = (name: string, pid: number) => new DshProfileRuntimeRegistry({
      dataDir: dir, name, pid,
      deps: { isAlivePid: (p) => p === pid, killPid: () => {}, now: () => 1_000_000, sleep: () => Promise.resolve() },
    })
    const a = mk('web', 111)
    const b = mk('web!', 222)
    a.announce()
    b.announce()
    assert.notEqual(a.fileFor('web'), b.fileFor('web!'), '清洗同形的两个名字必须落到不同文件')
    assert.equal(readdirSync(join(dir, 'running')).length, 2, '两个实例各留一份心跳')
    b.withdraw()
    assert.equal(existsSync(a.fileFor('web')), true, 'B 自撤不得删掉 A 的心跳')
    assert.deepEqual(a.listActive().map((r) => r.name), ['web'], 'A 仍可见')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('stopExternal：停**别的**实例（按它的心跳 pid），成功后删除它的心跳', async () => {
  const a = makeHarness({ name: 'web', pid: 111, alive: 'die-on-kill' })
  const b = makeHarness({ name: 'cmtest', pid: 222, alive: 'die-on-kill' })
  try {
    // B 的心跳写在 A 的目录里（同一个 dataDir 才叫「同机同 home」）
    rmSync(b.dataDir, { recursive: true, force: true })
    const other = new DshProfileRuntimeRegistry({
      dataDir: a.dataDir, name: 'cmtest', pid: 222,
      deps: {
        isAlivePid: () => true, killPid: () => {}, sleep: () => Promise.resolve(),
        now: () => 1_000_000, graceMs: 1,
      },
    })
    other.announce()
    a.registry.announce()
    // A 去停 B：B 的心跳 pid=222 会被杀（A 的 killPid 决定其是否退出）
    const stopped = await a.registry.stopExternal('cmtest')
    assert.equal(stopped.name, 'cmtest')
    assert.deepEqual(a.killed, ['222:graceful'])
    assert.deepEqual(a.registry.listActive().map((r) => r.name), ['web'], 'B 的心跳已被删')
    assert.equal(existsSync(join(a.dir, runtimeFileName('cmtest'))), false)
  } finally { a.cleanup(); b.cleanup() }
})

test('stopExternal：没有心跳 → notRunning；停自己 → currentProfile；杀不掉 → stopFailed（记录保留）', async () => {
  const h = makeHarness({ name: 'web', pid: 111, alive: 'survives' })
  try {
    await assert.rejects(() => h.registry.stopExternal('ghost'), (e: unknown) => e instanceof DshProfileError && e.code === 'notRunning')
    h.registry.announce()
    await assert.rejects(() => h.registry.stopExternal('web'), (e: unknown) => e instanceof DshProfileError && e.code === 'currentProfile')
    // 把「别的实例」写进来 + 自己无法被杀 → stopFailed
    const forced = makeHarness({ name: 'cmtest', pid: 222, alive: 'survives' })
    rmSync(forced.dataDir, { recursive: true, force: true })
    const other = new DshProfileRuntimeRegistry({
      dataDir: h.dataDir, name: 'cmtest', pid: 222,
      deps: { isAlivePid: () => true, killPid: () => {}, sleep: () => Promise.resolve(), now: () => 1_000_000, graceMs: 1 },
    })
    other.announce()
    // 注意：这里用 h 的 registry（isAlivePid 恒 true）停 cmtest
    await assert.rejects(
      () => h.registry.stopExternal('cmtest'),
      (e: unknown) => e instanceof DshProfileError && e.code === 'stopFailed' && e.message.includes('222'),
    )
    assert.equal(existsSync(join(h.dir, runtimeFileName('cmtest'))), true, '杀不掉就不删心跳（否则会以为它已经没了）')
    forced.cleanup()
  } finally { h.cleanup() }
})

test('startHeartbeat：按 refreshMs 定期 announce，stop() 之后不再刷', () => {
  // 用一个盒子接住 schedule 注册的回调：闭包赋值不会被 TS 的收窄分析当成调用点，"captured?.()" 会被判成 never
  const box: { fn: (() => void) | null } = { fn: null }
  let cancelled = 0
  let intervalMs = 0
  const h = makeHarness({
    name: 'web', pid: 111,
    schedule: (fn, ms) => { box.fn = fn; intervalMs = ms; return () => { cancelled += 1 } },
  })
  try {
    h.registry.announce()
    const stop = h.registry.startHeartbeat()
    assert.equal(intervalMs, RUNTIME_REFRESH_MS)
    assert.notEqual(box.fn, null)
    const before = JSON.parse(readFileSync(join(h.dir, runtimeFileName('web')), 'utf8')) as { updatedAt: number }
    h.tick(5_000)
    box.fn?.()
    const after = JSON.parse(readFileSync(join(h.dir, runtimeFileName('web')), 'utf8')) as { updatedAt: number }
    assert.equal(after.updatedAt, before.updatedAt + 5_000, '心跳被刷新（判活靠它）')
    stop()
    stop()
    assert.equal(cancelled, 1, 'stop 幂等：只取消一次定时器')
  } finally { h.cleanup() }
})

test('announce：心跳写失败绝不抛（issue #149）——只上报，下一次心跳自愈', () => {
  // 事故原貌：Windows 上 rename 撞 Defender 返回 EPERM，异常穿过 setInterval 回调 = 未捕获 → 整个 DSH 退出。
  let failing = true
  const h = makeHarness({
    name: 'web', pid: 111,
    write: (target, data) => {
      if (failing) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename '.dshcm.web.json.111.aa.tmp' -> 'web.json'"), { code: 'EPERM' })
      }
      writeFileSync(target, data)
    },
  })
  try {
    const record = h.registry.announce()
    assert.equal(record.pid, 111, '写失败仍返回记录（调用方不需要 try/catch）')
    assert.equal(h.failures.length, 1, '失败被上报给宿主日志')
    assert.equal((h.failures[0] as { code?: string }).code, 'EPERM')
    assert.equal(existsSync(join(h.dir, runtimeFileName('web'))), false, '文件确实没写进去')
    // 占用解除后的下一次心跳：写成功，不再报错
    failing = false
    h.registry.announce()
    assert.equal(h.failures.length, 1, '成功的那次不报错')
    assert.equal(existsSync(join(h.dir, runtimeFileName('web'))), true)
    assert.deepEqual(h.registry.listActive().map((r) => r.name), ['web'])
  } finally { h.cleanup() }
})

test('withdraw：心跳删不掉也不许抛（issue #149）——dispose 期间抛出去等于卸不干净还崩一次', () => {
  const h = makeHarness({ name: 'web', pid: 111 })
  try {
    h.registry.announce()
    // 用「占位的非空目录」制造 rmSync 失败（Windows 是 EPERM，POSIX 是 EISDIR/ENOTEMPTY，两者都抛）
    const heartbeat = join(h.dir, runtimeFileName('web'))
    rmSync(heartbeat, { force: true })
    mkdirSync(heartbeat, { recursive: true })
    writeFileSync(join(heartbeat, 'occupied'), '1')
    assert.doesNotThrow(() => { h.registry.withdraw() })
    assert.equal(h.failures.length >= 1, true, '失败被上报')
  } finally { h.cleanup() }
})

test('sweepStaleTemps：只删 1 小时前的 .dshcm.*.tmp 孤儿，新 tmp 与普通文件不动', () => {
  assert.equal(isRuntimeTempBasename('.dshcm.web.json.111.04474fb3.tmp'), true)
  assert.equal(isRuntimeTempBasename('.dshcm.notes.json'), false, '无 .tmp 后缀不算半成品')
  assert.equal(isRuntimeTempBasename('web.json.tmp'), false, '非本插件前缀不动')
  const h = makeHarness({ name: 'web', pid: 111 })
  try {
    mkdirSync(h.dir, { recursive: true })
    const stale = join(h.dir, '.dshcm.web.json.111.04474fb3.tmp')
    const fresh = join(h.dir, '.dshcm.web.json.111.04474fb4.tmp')
    const other = join(h.dir, '.dshcm.notes.json')
    for (const p of [stale, fresh, other]) writeFileSync(p, 'x')
    const ancient = new Date(Date.now() - RUNTIME_TEMP_STALE_MS - 60_000)
    utimesSync(stale, ancient, ancient)
    h.registry.announce()
    assert.equal(existsSync(stale), false, '1 小时前的半成品被清掉')
    assert.equal(existsSync(fresh), true, '刚写下的 tmp 可能正在被用，不动')
    assert.equal(existsSync(other), true, '不匹配判据的文件不动')
    // 每个实例只扫一遍：同进程内第二次心跳不再扫（避免每次 20s 心跳都去 stat 目录）
    const aged = new Date(Date.now() - RUNTIME_TEMP_STALE_MS - 60_000)
    utimesSync(fresh, aged, aged)
    h.registry.announce()
    assert.equal(existsSync(fresh), true, '本次实例已扫过，不重复扫')
  } finally { h.cleanup() }
})

