/**
 * 跨会话回退（回退 A、保留 B）的**真实文件状态**回归测试（task-3）。
 *
 * 与既有 rollback-point.test.ts 的 C-1..C-10 不同：这里每条用例都按**最终文件字节/文本**断言，
 * 并把「12 类复杂场景」逐类钉住：
 *  ① 多会话改不同文件  ② 同一文件不同区域  ③ 同一处重叠冲突  ④ B 改 A 新增的代码
 *  ⑤ A 删除 + B 同点新增  ⑥ 重排 / 行移动 / 重命名  ⑦ 删除 / 重建
 *  ⑧ 无归属的人工手改  ⑨ 三会话交错  ⑩ 顺序回退 / 撤销回退（guard）
 *  ⑪ 中途写入失败 / 并发外部写入  ⑫ 对象仓丢对象 / CRLF / 非 UTF-8
 *
 * 纪律（照抄 rollback-point.test.ts 的 fixture 风格）：
 *  - **真实 os.tmpdir + mkdtemp + 真实读写**，不 mock fs；
 *  - 引擎的 now 用步进时钟，保证「目标点之后最早的其他会话点」顺序确定；
 *  - 每条回退后同时断言三件事：① 该撤销的撤销；② 不该动的逐字未变；③ 冲突/无法判定时零写入且原因可读。
 *
 * 分类约定：
 *  - 预期会失败的用例以 X-<n> [DEFECT] 开头，断言消息里写清 observed / required；
 *  - 当前行为安全但并非理想结果的以 [SAFE] 标注，注释说明为什么可接受。
 *
 * 本文件**只读生产代码**：不修改任何 src 实现，也不依赖其它测试文件的 helper。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RollbackWriteAttribution } from './rollback-attribution.ts'
import { RollbackSessionActivity } from './rollback-activity.ts'
import {
  RollbackPointEngine,
  type RollbackEngineOptions,
  type RollbackPointInput,
  type RollbackRewindResult,
  type RollbackSegmentResult,
} from './rollback-point.ts'
import { atomicWriteFile } from '../utils/atomic-write.ts'

/* --------------------------------------------------------------- fixture */

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  unitDir: string
  workspaceDir: string
  /** 每条用例只捕获这个子目录内的文件（fixture 其它文件不参与，断言面收敛） */
  projDir: string
  logFile: string
  cleanup: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  // os.tmpdir() 在 Windows/macOS 上可能给未规范化的拼写，而引擎内部一律 realpath ⇒ 先 realpath
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cross-session-')))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const unitDir = path.join(homeDir, 'sessions', 'proj-key', 'session-1111')
  const workspaceDir = path.join(root, 'ws')
  const projDir = path.join(workspaceDir, 'proj')
  const logFile = path.join(unitDir, 'session-1111.jsonl.zstd')
  await fs.mkdir(unitDir, { recursive: true })
  await fs.mkdir(projDir, { recursive: true })
  await fs.writeFile(logFile, 'frame-one')
  return {
    root, homeDir, dataDir, unitDir, workspaceDir, projDir, logFile,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) },
  }
}

function makeEngine(fx: Fixture, overrides: Partial<RollbackEngineOptions> = {}): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0, ...overrides })
}

function makeAttribution(fx: Fixture): RollbackWriteAttribution {
  return new RollbackWriteAttribution({
    file: path.join(fx.dataDir, 'rollback-points', 'attribution.json'),
    flushDelayMs: 0,
  })
}

/** 严格递增的引擎时钟：保证「目标点之后最早的其他会话点」不会撞同一毫秒。 */
function steppingClock(start: number, step: number): () => number {
  let value = start - step
  return () => { value += step; return value }
}

/** 留一个点：只捕获 proj 子目录、只挂一条会话日志（与 rollback-point.test.ts 同名 helper 同口径）。 */
async function capture(engine: RollbackPointEngine, fx: Fixture, sessionId = 'session-1111', extra: Partial<RollbackPointInput> = {}) {
  return await engine.capturePoint({
    chunks: [fx.projDir],
    sessionId,
    unitId: 'proj-key/session-1111',
    sessionLogPath: fx.logFile,
    cursorSeq: 3,
    turnSeq: 2,
    boundarySeq: 1,
    boundaryEndSeq: 6,
    ...extra,
  })
}

async function pointIdOf(engine: RollbackPointEngine, fx: Fixture, sessionId: string): Promise<string> {
  const captured = await capture(engine, fx, sessionId)
  const point = captured.point
  assert.ok(point !== undefined, '留点失败：' + captured.code + ' ' + (captured.detail ?? ''))
  return point.id
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8')
}

async function readBytes(file: string): Promise<Buffer> {
  return await fs.readFile(file)
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true } catch { return false }
}

function wsSegment(result: RollbackRewindResult): RollbackSegmentResult {
  const segment = result.segments.find((item) => item.state === 'workspace')
  assert.ok(segment !== undefined, '缺少 workspace 段')
  return segment
}

function samePath(left: string, right: string): boolean {
  const fold = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return fold(left) === fold(right)
}

/* ================================================ ① 多会话改不同文件 */

test('T1-1 多会话改不同文件：回退 A 只影响 A 的文件，B 的文件逐字未变（有归属）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = makeAttribution(fx)
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const fileA = path.join(fx.projDir, 'a.txt')
  const fileB = path.join(fx.projDir, 'b.txt')
  await fs.writeFile(fileA, 'A0')
  await fs.writeFile(fileB, 'B0')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(fileA, 'A1')
  await pointIdOf(engine, fx, 'session-B') // B 的回合点：fileB 此时仍是 B0
  await fs.writeFile(fileB, 'B1')
  attr.noteToolCall('session-B', { name: 'write', callId: 'w1', arguments: JSON.stringify({ file_path: fileB }) })

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(fileA), 'A0', 'A 的改动被撤销')
  assert.equal(await readText(fileB), 'B1', 'B 的文件必须逐字未变')
  const segment = wsSegment(result)
  assert.equal(segment.restored, 1, '只写了 A 那一条')
  assert.equal(segment.mergedCount, 1, 'A 那条走三方合并（对方没动它）')
  assert.equal(segment.unavailableCount, 1, 'B 的文件因「无可用祖先 + 别的会话写过」被如实跳过')
  assert.equal(segment.conflictCount, undefined)
})

test('X-1 [DEFECT] 无归属时多会话改不同文件：回退 A 会覆盖 B 的文件（B1 → B0）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 刻意不给 attribution：真实环境里归属会因工具白名单 / 跨进程整体覆盖 / 采集时机而缺失
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const fileA = path.join(fx.projDir, 'a.txt')
  const fileB = path.join(fx.projDir, 'b.txt')
  await fs.writeFile(fileA, 'A0')
  await fs.writeFile(fileB, 'B0')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(fileA, 'A1')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(fileB, 'B1')

  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const observedB = await readText(fileB)
  assert.equal(observedB, 'B1',
    'observed fileB=' + JSON.stringify(observedB) + '；required=逐字未变（"B1"）：回退 A 绝不能动 A 从未写过的文件。' +
    '根因：baseVersionFor 取到 B 的回合点（内容 = 留点时的 B0）⇒ base===ours，' +
    '在没有归属旁证时 mergeForeignRecord 退回 fallback（整文件覆盖回目标版本），把 B 的改动抹掉。')
})

/* ============================================ ② 同一文件不同区域 */

test('T2-1 同一文件不同函数：撤销 A 的 alpha、保留 B 的 beta（按最终文本断言）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'mod.ts')
  const v0 = 'export function alpha() {\n  return 1\n}\nexport function beta() {\n  return 2\n}\n'
  await fs.writeFile(file, v0)

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'export function alpha() {\n  return 10\n}\nexport function beta() {\n  return 2\n}\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'export function alpha() {\n  return 10\n}\nexport function beta() {\n  return 20\n}\n')

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'export function alpha() {\n  return 1\n}\nexport function beta() {\n  return 20\n}\n',
    'alpha 回到 1、beta 保持 B 的 20')
  const segment = wsSegment(result)
  assert.equal(segment.mergedCount, 1)
  assert.equal(segment.conflictCount, undefined)
  assert.equal(segment.restored, 1)
})

/* ============================================== ③ 同一处重叠修改 */

test('X-3 [DEFECT] 同一函数内重叠修改：零写入正确，但冲突原因被 noop 分支整段丢弃', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.ts')
  const bVersion = 'function f() {\n  const a = 11\n  const b = 2\n}\n'
  await fs.writeFile(file, 'function f() {\n  const a = 1\n  const b = 2\n}\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'function f() {\n  const a = 10\n  const b = 2\n}\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, bVersion)

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const segment = wsSegment(result)
  // 安全性质先断言：冲突时绝不选边、绝不写
  assert.equal(await readText(file), bVersion, '冲突时必须零写入，保持 B 的版本')
  assert.equal(segment.conflictCount, 1, '冲突计数必须如实')
  assert.equal(segment.restored, 0)
  // 可读性：机器码与 detail 必须能说明「是冲突」，而不是「没有可恢复内容」
  const observed = 'code=' + result.code + ' status=' + segment.status + ' detail=' + JSON.stringify(segment.detail)
  assert.notEqual(result.code, 'nothing-to-restore',
    'observed ' + observed + '；required=冲突不得以「没有可恢复内容」收尾（否则用户会以为回退无事可做）。')
  assert.equal(segment.detail.some((line) => line.includes('foreign-conflict')), true,
    'observed ' + observed + '；required=detail 必须带 foreign-conflict（needed 为空走 noopSegment 时把已累积的 detail 整段丢弃了）。')
})

/* ======================================== ④ B 改 A 新增的代码 */

test('T4-1 [SAFE] B 在 A 新增的函数体里继续改：判冲突、零写入，B 的修改完整保留', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.ts')
  await fs.writeFile(file, 'const x = 1\nconst y = 2\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'const x = 1\nconst y = 2\nfunction added() {\n  return 1\n}\n')
  await pointIdOf(engine, fx, 'session-B')
  const bVersion = 'const x = 1\nconst y = 2\nfunction added() {\n  return 42\n}\n'
  await fs.writeFile(file, bVersion)

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const segment = wsSegment(result)
  // 可接受（不是完美结果）：B 改的正是 A 新增的代码，撤销 A 必然要删掉这段代码；
  // 三方合并无法「删掉函数又保留对函数体的编辑」，因此拒绝写入、把选择权交还用户，绝不静默丢弃 B 的 42。
  assert.equal(await readText(file), bVersion, '冲突时零写入，B 的 42 必须还在')
  assert.equal(segment.conflictCount, 1)
  assert.equal(segment.restored, 0)
})

/* ================================== ⑤ A 删除 + B 同点新增 */

/**
 * X-5（Lead 2026-10-18 定案后把期望改成 [SAFE]）：A 删掉 l3、B 在**同一位置**插入 B-new。
 *
 * base→ours = 「在位置 p 插入 l3」，base→theirs = 「在位置 p 插入 B-new」—— 两个**纯插入起点相同**，
 * 先后顺序没有任何依据可判。引擎绝不猜顺序（猜错就是把 B 的代码插到错位置，或让 l3 顶掉 B 的新增）；
 * 按冲突处理：**零写入**、B 的新增原样保留、A 的删除如实报告为「未撤销」，交用户决定。
 * 这与 task 的原则一致：无法安全区分归属/顺序时明确提示冲突，不得擅自覆盖。
 */
test('X-5 [SAFE] A 删一行、B 在同一位置新增：判冲突、零写入，两侧内容都不丢', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'l1\nl2\nl3\nl4\nl5\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'l1\nl2\nl4\nl5\n') // A 删除 l3
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'l1\nl2\nB-new\nl4\nl5\n') // B 在 l3 的位置新增

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const after = await readText(file)
  const finalLines = after.split('\n').filter((line) => line !== '')
  const segment = wsSegment(result)
  const observed = 'file=' + JSON.stringify(finalLines.join('\n')) + ' conflictCount=' + String(segment.conflictCount)
  assert.equal(segment.conflictCount, 1, '必须如实报冲突：' + observed)
  assert.equal(after, 'l1\nl2\nB-new\nl4\nl5\n', '判冲突 ⇒ 一个字节都不写：' + observed)
  assert.equal(segment.detail.some((line) => line.includes('foreign-conflict')), true,
    '冲突必须逐条可读（X-3 已修）：' + JSON.stringify(segment.detail))
})

/* ============================ ⑥ 重排 / 行移动 / 重命名 */

test('T6-1 行移动：A 把首行移到末尾、B 改中间行 ⇒ 行序回到原样且 B 的修改保留', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'one\ntwo\nthree\nfour\nfive\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'two\nthree\nfour\nfive\none\n') // A 把 one 移到末尾
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'two\nthree\nB-three\nfour\nfive\none\n') // B 改 three

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'one\ntwo\nthree\nB-three\nfour\nfive\n',
    'A 的移动被撤销、B 的 B-three 保留')
  const segment = wsSegment(result)
  assert.equal(segment.mergedCount, 1)
  assert.equal(segment.conflictCount, undefined)
})

test('T6-2 [SAFE] 整文件重排 + B 的无关行修改：判冲突、零写入（行级合并无法映射重排）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'a\nb\nc\nd\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'd\nc\nb\na\n') // A 整文件倒序
  await pointIdOf(engine, fx, 'session-B')
  const bVersion = 'd\nc\nB\na\n' // B 改中间一行
  await fs.writeFile(file, bVersion)

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const segment = wsSegment(result)
  // 可接受（不是完美结果）：整文件重排在行级 diff 里等价于「全文删除 + 全文插入」，
  // 任何与它触碰的修改都无法可靠归位；拒绝写入保住 B，不会写坏文件。
  assert.equal(await readText(file), bVersion, '零写入：B 的版本原样保留')
  assert.equal(segment.conflictCount, 1)
  assert.equal(segment.restored, 0)
})

test('T6-3 [SAFE] 重命名：旧名恢复、新名保留（B 已在新名上改过），拒绝删除并如实报告', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const oldFile = path.join(fx.projDir, 'old.txt')
  const newFile = path.join(fx.projDir, 'new.txt')
  await fs.writeFile(oldFile, 'v0\nline2\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.rm(oldFile)
  await fs.writeFile(newFile, 'v0\nline2\n') // A 改名 old → new
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(newFile, 'v0\nB-line\n') // B 改新名

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off', removeCreated: true })
  const segment = wsSegment(result)
  // 可接受（不是完美结果）：撤销改名需要删 new 并把 B 的改动搬回 old —— 逐路径引擎做不到；
  // 它选择「不删别人的文件」，旧名恢复 + 新名保留，并把该路径计入 createdSkipped 供界面解释。
  assert.equal(await readText(oldFile), 'v0\nline2\n', '旧名被恢复')
  assert.equal(await readText(newFile), 'v0\nB-line\n', 'B 改过的新名不被删除')
  assert.equal((segment.createdSkipped ?? []).some((target) => samePath(target, newFile)), true,
    'createdSkipped 必须如实列出被拒删的新名（observed=' + JSON.stringify(segment.createdSkipped) + '）')
})

/* ============================================ ⑦ 删除 / 重新创建 */

test('T7-1 A 删除文件：回退按字节重建（内容逐字一致）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'keep-me\n中文\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.rm(file)
  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await exists(file), true, 'A 删掉的文件必须被重建')
  assert.equal(await readText(file), 'keep-me\n中文\n')
  assert.equal(wsSegment(result).restored, 1)
})

test('T7-2 [SAFE] B 在 A 之后删除文件：回退 A 不复活它（theirs-missing ⇒ 零写入）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'v0\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.rm(file) // B 显式删除

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  // 可接受：复活文件等于撤销 B 的删除；引擎选择「对方改成不存在 ⇒ 无法安全撤销」，一个字节都不写。
  assert.equal(await exists(file), false, '不得凭空复活 B 删除的文件')
  assert.equal(wsSegment(result).unavailableCount, 1)
})

test('X-7 [DEFECT] A 删除文件、B 重新创建它：回退 A 把 B 重建的内容覆盖回旧版本', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'v0\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.rm(file) // A 删除
  await pointIdOf(engine, fx, 'session-B') // B 的回合点里没有这个文件
  await fs.writeFile(file, 'B-recreated\n') // B 重新创建

  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const observed = await readText(file)
  assert.equal(observed, 'B-recreated\n',
    'observed=' + JSON.stringify(observed) + '；required=保留 B 重建的内容（或零写入并报告冲突）。' +
    '根因：B 的回合点里该路径「不存在」⇒ baseVersionFor 返回 null；无归属旁证 ⇒ fallback 整文件覆盖回 v0。')
})

/* ================================== ⑧ 无归属的人工手改 */

/**
 * X-8（Lead 2026-10-18 定案后改写为 [SAFE] 并**补上证据来源**）：会话之外的手改不得被静默覆盖。
 *
 * 为什么必须喂时间窗：没有归属、也没有中间点的情形在**证据层面**是空的。旧口径（无证据 ⇒ 照常覆盖）
 * 被既有 R-05c / R-01 冻结，不能凭空改成「一律拒绝」—— 那会把正常的纯本会话回退也一起拦掉。
 * 真机之所以能判出来，是因为采集器一直在记每个会话的活跃窗口（哪怕这次回退的会话早已静默）：
 * 文件 mtime 落在**谁都不活跃**的时刻 ⇒ 手改 / 外部工具 / 另一个进程 ⇒ 零写入并如实报 unclaimed。
 */
test('X-8 [SAFE] 手改落在「无会话活跃」的时间窗 ⇒ 零写入并如实报 unclaimed', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  // 时间窗：只记一个**远早于**手改时刻的窗口 ⇒ 手改落在窗口之外、且那一刻没有任何会话活跃
  const activity = new RollbackSessionActivity({
    file: path.join(fx.dataDir, 'rollback-points', 'activity.json'),
    flushDelayMs: 0,
  })
  activity.noteActivity('session-A', 1_000_000)
  const engine = makeEngine(fx, { activity, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'v0\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A-line\n') // A 的改动
  await fs.writeFile(file, 'A-line\nmanual-edit\n') // 第三方手工追加（没有任何归属 / 中间点）
  // 把 mtime 钉到「谁都不活跃」的时刻（窗口之外）—— 这就是真机里「会话结束后被手改」的形状
  const handEditAt = new Date(9_000_000)
  await fs.utimes(file, handEditAt, handEditAt)

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const segment = wsSegment(result)
  const observed = await readText(file)
  assert.equal(observed.includes('manual-edit'), true,
    'observed=' + JSON.stringify(observed) + '；required=无人认领的手改不得被覆盖：' + JSON.stringify(segment.detail))
  assert.equal(segment.externalCount, 1, '必须如实计入 externalCount：' + JSON.stringify(segment.detail))
  assert.equal(segment.detail.some((line) => line.includes('foreign-unclaimed')), true,
    '理由必须逐条可读：' + JSON.stringify(segment.detail))
})

test('T8-2 [SAFE] 第三方手改但有归属旁证：没有共同祖先 ⇒ 零写入并如实报 unavailable', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = makeAttribution(fx)
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'v0\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A-line\n')
  await fs.writeFile(file, 'A-line\nmanual-edit\n')
  attr.noteToolCall('session-B', { name: 'write', callId: 'w-manual', arguments: JSON.stringify({ file_path: file }) })

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  // 可接受：有「别人写过」的旁证但没有可用祖先 ⇒ 无法安全撤销，宁可不动，也不整文件覆盖。
  assert.equal(await readText(file), 'A-line\nmanual-edit\n', '零写入')
  assert.equal(wsSegment(result).unavailableCount, 1)
})

/* ============================================ ⑨ 三会话交错 */

test('T9-1 三个会话交错改同一文件：回退 A 只撤销 A 的行，B/C 的行逐字保留', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'A1\nl2\nl3\nl4\nB5\nl6\nl7\nl8\nl9\n')
  await pointIdOf(engine, fx, 'session-C')
  await fs.writeFile(file, 'A1\nl2\nl3\nl4\nB5\nl6\nl7\nl8\nC9\n')

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'l1\nl2\nl3\nl4\nB5\nl6\nl7\nl8\nC9\n',
    'A1 被撤销，B5 与 C9 都保留')
  assert.equal(wsSegment(result).mergedCount, 1)
})

/* ================================ ⑩ 顺序回退 / 撤销回退 */

test('X-10 [DEFECT] 先回退 A 再回退 B：第二次回退把 A 的改动复活、并抹掉 B 的改动', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const attr = makeAttribution(fx)
  const engine = makeEngine(fx, { attribution: attr, now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  const s0 = 'l1\nl2\nl3\nl4\nl5\n'
  await fs.writeFile(file, s0)

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\nl2\nl3\nl4\nl5\n')
  const idB = await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'A1\nl2\nl3\nl4\nB5\n')
  attr.noteToolCall('session-B', { name: 'write', callId: 'w-b', arguments: JSON.stringify({ file_path: file }) })

  // 第一刀按**生产缺省**留救援点（guardPolicy: require）：连续回退的第二刀依赖它 ——
  // 它是「A 已改、B 未改」那一刻的状态，也就是第二刀唯一可用的共同祖先（baseVersionFor 第二档）。
  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'require' })
  assert.equal(await readText(file), 'l1\nl2\nl3\nl4\nB5\n', '第一步：撤销 A、保留 B')

  await engine.rewind({ id: idB, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const observed = await readText(file)
  assert.equal(observed, s0,
    'observed=' + JSON.stringify(observed) + '；required=两个会话都被回退后应回到共同起点 ' + JSON.stringify(s0) +
    '（A 的改动不得复活，B 的 B5 不得丢失）。根因：回退 B 时 B 的目标点 P_B 内容 = A 改后的版本，' +
    '且目标点之后没有别的会话点可当 base ⇒ fallback 整文件覆盖，把已回退的 A 改动写回来。')
})

test('T10-2 撤销回退（回到救援点）再回退：三态逐步可验证', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'l1\nl2\nl3\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\nl2\nl3\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'A1\nl2\nB3\n') // 回退前状态

  const first = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'require' })
  assert.equal(await readText(file), 'l1\nl2\nB3\n', '态 1：撤销 A、保留 B')
  const guardId = first.guardPointId
  assert.ok(guardId !== undefined, 'require 档必须留下救援点')

  await engine.rewind({ id: guardId, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'A1\nl2\nB3\n', '态 2：回到救援点 = 回退前状态，逐字一致')

  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'l1\nl2\nB3\n', '态 3：再次回退 A，结果与态 1 完全一致')
})

/* ============================== ⑪ 中途失败 / 并发写入 */

test('T11-1 写第二个文件时失败：已写文件整体回滚，两个文件都保持回退前内容', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const file1 = path.join(fx.projDir, 'a.txt')
  const file2 = path.join(fx.projDir, 'b.txt')
  await fs.writeFile(file1, 'A0')
  await fs.writeFile(file2, 'B0')
  let injected = false
  const engine = makeEngine(fx, {
    now: steppingClock(1_000_000, 1),
    writeFile: async (target, bytes) => {
      if (!injected && samePath(target, file2)) {
        injected = true
        throw new Error('injected EIO')
      }
      await atomicWriteFile(target, bytes)
    },
  })
  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file1, 'A1')
  await fs.writeFile(file2, 'B1') // 回退前内容

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  // 整体回滚：两条都必须回到回退前内容（绝不出现「写了一半」）
  assert.equal(await readText(file1), 'A1', '已写的文件必须被前像还原')
  assert.equal(await readText(file2), 'B1', '失败的文件保持原样')
  const segment = wsSegment(result)
  assert.equal(segment.status, 'failed')
  assert.equal(segment.restored, 0)
  assert.equal(segment.detail.some((line) => line.includes('rolledBack=')), true,
    'detail 必须说明整体回滚：' + JSON.stringify(segment.detail))
  assert.equal(result.guidance.some((item) => item.code === 'rollback.guidance.workspaceRolledBack'), true)
})

test('T11-2 合并之后、写入之前外部再改一次：放弃写入，绝不覆盖比我们新的内容', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'l1\nl2\nl3\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\nl2\nl3\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'A1\nl2\nB3\n')

  // 引擎现成的 seam：前像暂存刚好发生在「最终并发校验之后、真正写入之前」
  const self = engine as unknown as { openUndoStager: () => Promise<unknown> }
  const original = self.openUndoStager.bind(engine)
  self.openUndoStager = async () => {
    await fs.writeFile(file, 'EXTERNAL-TOUCH\n')
    return await original()
  }

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  assert.equal(await readText(file), 'EXTERNAL-TOUCH\n', '外部新写入的内容绝不被覆盖')
  assert.equal(wsSegment(result).concurrentCount, 1, '并发冲突必须如实计数')
})

/* ======================= ⑫ 对象仓丢对象 / CRLF / 非 UTF-8 */

interface StoredRecordRef { workspace: { payload: string | null } }
interface StoredPayload { files: { path: string; sha256: string }[] }

test('X-12a [DEFECT] 对象仓丢对象：零写入正确，但 reasonCode 被标成 invalid-path 而非 object-missing', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'A0')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1') // 当前内容与目标不同 ⇒ 必须读对象

  const record = JSON.parse(await readText(path.join(engine.storeDir, 'records', idA + '.json'))) as StoredRecordRef
  const payloadHash = record.workspace.payload
  assert.ok(payloadHash !== null, '记录里必须有工作区载荷引用')
  const payload = JSON.parse(await readText(path.join(engine.storeDir, 'payloads', payloadHash + '.json'))) as StoredPayload
  const entry = payload.files.find((item) => samePath(item.path, file))
  assert.ok(entry !== undefined, '载荷里必须有该文件')
  await fs.rm(path.join(engine.storeDir, 'objects', entry.sha256))

  const result = await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const segment = wsSegment(result)
  // 安全性质：对象缺失 ⇒ 零写入（这是对的）
  assert.equal(await readText(file), 'A1', '对象缺失时零写入')
  assert.equal(segment.restored, 0)
  assert.equal(segment.detail.some((line) => line.includes('object-missing')), true,
    'detail 必须说明对象缺失：' + JSON.stringify(segment.detail))
  const observed = 'reasonCode=' + String(segment.reasonCode) + ' detail=' + JSON.stringify(segment.detail)
  assert.equal(segment.reasonCode, 'object-missing',
    'observed ' + observed + '；required=段级 reasonCode 应能区分「对象仓丢对象」与「路径非法」；' +
    '现在统一落成 invalid-path（failed>0 的兜底分支），界面/排障会把对象损坏误读成路径问题。')
})

test('X-12b [DEFECT] CRLF 文件的三方合并：行尾被改成 LF（字节保真失败）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  await fs.writeFile(file, 'l1\r\nl2\r\n')

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, 'A1\r\nl2\r\n')
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, 'A1\r\nB2\r\n')

  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const actual = await readBytes(file)
  const expected = Buffer.from('l1\r\nB2\r\n', 'utf8')
  assert.deepEqual(actual, expected,
    'observed hex=' + actual.toString('hex') + '；required hex=' + expected.toString('hex') +
    '（撤销 A 的 A1、保留 B 的 B2，且原文件的 CRLF 行尾必须逐字保留）。' +
    '根因：mergeThreeWay 的 splitLinesOf 把 \\r\\n 规范化成 \\n，重新 join 时用 \\n。')
})

test('X-12c [DEFECT] 非 UTF-8 字节的文件合并：非法字节被替换成 U+FFFD（内容损坏）', async (t) => {
  const fx = await makeFixture()
  t.after(fx.cleanup)
  const engine = makeEngine(fx, { now: steppingClock(1_000_000, 1) })
  const file = path.join(fx.projDir, 'f.txt')
  const build = (line1: string, line3: string): Buffer => Buffer.concat([
    Buffer.from(line1 + '\n', 'utf8'),
    Buffer.from([0xff, 0xfe, 0x0a]), // 非法 UTF-8 行（不含 NUL ⇒ 引擎不判二进制）
    Buffer.from(line3 + '\n', 'utf8'),
  ])
  await fs.writeFile(file, build('l1', 'l3'))

  const idA = await pointIdOf(engine, fx, 'session-A')
  await fs.writeFile(file, build('A1', 'l3'))
  await pointIdOf(engine, fx, 'session-B')
  await fs.writeFile(file, build('A1', 'B3'))

  await engine.rewind({ id: idA, userConfirmed: true, mode: 'files', guardPolicy: 'off' })
  const actual = await readBytes(file)
  const expected = build('l1', 'B3')
  assert.deepEqual(actual, expected,
    'observed hex=' + actual.toString('hex') + '；required hex=' + expected.toString('hex') +
    '（撤销 A 的 A1、保留 B 的 B3，且第 2 行的非法字节 ff fe 必须逐字保留）。' +
    '根因：mergeForeignRecord 用 Buffer.toString("utf8") 解码并用 Buffer.from(text,"utf8") 编码，' +
    '非 UTF-8 字节被解码成 U+FFFD 后写回。')
})
