import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { browseDirectory, listRoots } from './path-browse.ts'

/** 建一棵一次性目录树：b-dir/ a-dir/ b.txt a.txt（故意让名字序与目录序相反）。 */
async function withTree(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dcm-browse-'))
  try {
    await mkdir(join(root, 'a-dir'))
    await mkdir(join(root, 'b-dir'))
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('browseDirectory: 目录在前、同类按名字排序，并回填父目录', async () => {
  await withTree(async (root) => {
    const result = await browseDirectory(root)
    assert.equal(result.error, null)
    assert.equal(result.path, root)
    assert.equal(result.parent, dirname(root))
    assert.equal(result.truncated, false)
    assert.deepEqual(result.entries.map((entry) => entry.name), ['a-dir', 'b-dir', 'a.txt', 'b.txt'])
    assert.deepEqual(result.entries.map((entry) => entry.kind), ['dir', 'dir', 'file', 'file'])
    // 条目路径必须是可直接回填输入框的绝对路径
    assert.equal(result.entries[0]?.path, join(root, 'a-dir'))
  })
})

test('browseDirectory: 非绝对路径不猜基准目录', async () => {
  const result = await browseDirectory('relative/path')
  assert.equal(result.error, 'not-absolute')
  assert.deepEqual(result.entries, [])
  assert.equal(result.parent, null)
})

test('browseDirectory: 不存在的目录是 not-found（不是 failed）', async () => {
  await withTree(async (root) => {
    const result = await browseDirectory(join(root, 'nope'))
    assert.equal(result.error, 'not-found')
    assert.deepEqual(result.entries, [])
    assert.equal(result.parent, root)
  })
})

test('browseDirectory: 末尾分隔符被归一化，与无分隔符结果一致', async () => {
  await withTree(async (root) => {
    const withSlash = await browseDirectory(root + (process.platform === 'win32' ? '\\' : '/'))
    const plain = await browseDirectory(root)
    assert.equal(withSlash.path, plain.path)
    assert.deepEqual(withSlash.entries, plain.entries)
  })
})

test('browseDirectory: 命中上限即截断并回报 truncated', async () => {
  await withTree(async (root) => {
    const result = await browseDirectory(root, { limit: 2 })
    assert.equal(result.entries.length, 2)
    assert.equal(result.truncated, true)
    assert.deepEqual(result.entries.map((entry) => entry.name), ['a-dir', 'b-dir'])
  })
})

test('browseDirectory: 空路径返回根列表（path 为空、无可进入的父级）', async () => {
  const result = await browseDirectory(undefined)
  assert.equal(result.error, null)
  assert.equal(result.path, '')
  assert.equal(result.parent, null)
  assert.equal(result.truncated, false)
  assert.ok(result.entries.length > 0)
  assert.ok(result.entries.every((entry) => entry.kind === 'dir'))
})

test('listRoots: 至少给一条可用的根，且都在本机绝对路径形态', async () => {
  const roots = await listRoots()
  assert.ok(roots.length > 0)
  for (const root of roots) {
    assert.equal(root.kind, 'dir')
    assert.equal(root.path, root.name)
  }
  if (process.platform !== 'win32') assert.deepEqual(roots.map((root) => root.path), ['/'])
})
