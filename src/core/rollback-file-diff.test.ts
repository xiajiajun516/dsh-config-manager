/**
 * 回滚点「单文件前后对照」（`RollbackPointEngine.fileDiff`）单测。
 *
 * 纪律与本仓既有 core 测试同款：真实临时目录 + 真实读写，不 mock 文件系统。
 *
 * 覆盖的是这个端点的**收窄与诚实性**（它是新的只读读取面，用户 2026-10-12 的「查看」数据源）：
 *  · 方向必须是 before = **当前磁盘** / after = **回退点快照**（读反了整屏差异都是反的）；
 *  · 只认**记录在案**的路径（未记录 ⇒ file-not-recorded，绝不变成任意路径读取器）；
 *  · 二进制 / 超限 / 读不出一律结构化 reason + 空 hunks（「不知道」不得显示成「没有差异」）；
 *  · 全程**零写入**（工作区字节不变、对象仓不新增）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { RollbackPointEngine } from './rollback-point.ts'

interface Fixture {
  root: string
  homeDir: string
  dataDir: string
  workspaceDir: string
  cleanup: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-rollback-file-diff-'))
  const homeDir = path.join(root, 'home')
  const dataDir = path.join(homeDir, 'dsh-config-manager')
  const workspaceDir = path.join(root, 'ws')
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.writeFile(path.join(workspaceDir, 'a.txt'), 'A1\nA2\n')
  return { root, homeDir, dataDir, workspaceDir, cleanup: async () => { await fs.rm(root, { recursive: true, force: true }) } }
}

function makeEngine(fx: Fixture): RollbackPointEngine {
  return new RollbackPointEngine({ dataDir: fx.dataDir, homeDir: fx.homeDir, sessionQuiescentMs: 0 })
}

/** 留一个点（只带工作区态），返回点 id。 */
async function capture(engine: RollbackPointEngine, fx: Fixture): Promise<string> {
  const captured = await engine.capturePoint({ chunks: [fx.workspaceDir], sessionId: 'session-1111', turnSeq: 1 })
  const id = captured.point?.id
  assert.ok(typeof id === 'string' && id !== '', 'fixture 必须先真的留下一个点：' + JSON.stringify(captured))
  return id as string
}

test('fileDiff：before = 当前磁盘、after = 回退点快照（方向不许读反）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const id = await capture(engine, fx)
    const file = path.join(fx.workspaceDir, 'a.txt')
    // 留点**之后**改文件：回退会把 A2 删掉、把 A3 加回来
    await fs.writeFile(file, 'A1\nA3\n')
    const diff = await engine.fileDiff(id, file)
    assert.equal(diff.ok, true, JSON.stringify(diff))
    assert.equal(diff.status, 'overwrite')
    assert.equal(diff.before.exists, true)
    assert.equal(diff.after.exists, true)
    assert.equal(diff.identical, false)
    // 方向证据：删掉的是当前独有的 A3，新增的是快照里的 A2
    assert.equal(diff.removed, 1)
    assert.equal(diff.added, 1)
    const texts = diff.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind + ':' + line.text))
    assert.ok(texts.includes('del:A3'), '当前独有的行必须是删除：' + JSON.stringify(texts))
    assert.ok(texts.includes('add:A2'), '快照独有的行必须是新增：' + JSON.stringify(texts))
  } finally {
    await fx.cleanup()
  }
})

test('fileDiff：当前文件不存在（ENOENT）→ status=create，新增 = 快照全部行', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const id = await capture(engine, fx)
    const file = path.join(fx.workspaceDir, 'a.txt')
    await fs.rm(file)
    const diff = await engine.fileDiff(id, file)
    assert.equal(diff.ok, true)
    assert.equal(diff.status, 'create')
    assert.equal(diff.before.exists, false)
    assert.equal(diff.after.exists, true)
    assert.equal(diff.removed, 0)
    assert.equal(diff.added, diff.after.lines)
  } finally {
    await fx.cleanup()
  }
})

test('fileDiff：未记录在案的路径 → file-not-recorded（这条端点不是任意路径读取器）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const id = await capture(engine, fx)
    const outside = path.join(fx.root, 'outside.txt')
    await fs.writeFile(outside, 'secret\n')
    const diff = await engine.fileDiff(id, outside)
    assert.equal(diff.ok, false)
    assert.equal(diff.code, 'file-not-recorded')
    assert.deepEqual(diff.hunks, [], '未记录的路径不得给出任何差异内容')
  } finally {
    await fx.cleanup()
  }
})

test('fileDiff：二进制 → reason=binary 且 hunks 空（不把「不知道」说成「没有差异」）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const binary = path.join(fx.workspaceDir, 'blob.bin')
    await fs.writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 9]))
    const id = await capture(engine, fx)
    await fs.writeFile(binary, Buffer.from([0, 5, 6, 7, 0, 9]))
    const diff = await engine.fileDiff(id, binary)
    assert.equal(diff.ok, true)
    assert.equal(diff.reason, 'binary')
    assert.deepEqual(diff.hunks, [])
    assert.equal(diff.identical, false, '无法逐行对比不得被说成「一致」')
  } finally {
    await fx.cleanup()
  }
})

test('fileDiff：未知 id → record-not-found（结构化码，不抛）', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    await capture(engine, fx)
    const diff = await engine.fileDiff('nope', path.join(fx.workspaceDir, 'a.txt'))
    assert.equal(diff.ok, false)
    assert.equal(diff.code, 'record-not-found')
  } finally {
    await fx.cleanup()
  }
})

test('fileDiff：零写入 —— 对照前后工作区字节与对象仓条目都不变', async () => {
  const fx = await makeFixture()
  try {
    const engine = makeEngine(fx)
    const id = await capture(engine, fx)
    const file = path.join(fx.workspaceDir, 'a.txt')
    await fs.writeFile(file, 'A1\nCHANGED\n')
    const before = await fs.readFile(file)
    const objectsDir = path.join(engine.storeDir, 'objects')
    const objectsBefore = await fs.readdir(objectsDir)
    const ledgerBefore = await fs.readFile(path.join(engine.storeDir, 'index.json'), 'utf8')
    await engine.fileDiff(id, file)
    assert.deepEqual(await fs.readFile(file), before, '只读对照不得改动工作区文件')
    assert.deepEqual(await fs.readdir(objectsDir), objectsBefore, '只读对照不得写对象仓')
    assert.equal(await fs.readFile(path.join(engine.storeDir, 'index.json'), 'utf8'), ledgerBefore, '只读对照不得写台账')
  } finally {
    await fx.cleanup()
  }
})
