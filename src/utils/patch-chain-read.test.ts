/**
 * 生效 patch 链的读取与写前判据（#144）：缓存失效语义、越界 bundle 名、pnpm hoisted 候选位置。
 *
 * 这三条都是「静默失败会变成错误事实」的点：缓存不失效 ⇒ 刚写的行对自己不可见；
 * 名字不校验 ⇒ 链读取变成 $DSH_HOME 外的路径探针；候选漏一个 ⇒ 已安装的 bundle 被判成未安装。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  PatchChainCache, downgradeProvidedInserts, readExistingPatchDocument, readPatchChainFromProfile,
  type PatchChangeLike,
} from './patch-chain-read.ts'
import { USER_PATCH_FILE, profilePatchRel } from '../core/patch-layers.ts'

function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cm-chain-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

/* ------------------------------- 缓存 ------------------------------- */

test('#144 PatchChainCache：TTL 内只读一次，过期后重读', async () => {
  const cache = new PatchChainCache(2000)
  let calls = 0
  const load = async (): Promise<{ sources: never[]; failures: never[] }> => {
    calls += 1
    return { sources: [], failures: [] }
  }
  await cache.get(load, 1000)
  await cache.get(load, 2999)
  assert.equal(calls, 1, 'TTL 内必须命中缓存')
  await cache.get(load, 3000)
  assert.equal(calls, 2, '到期必须重读')
})

test('#144 PatchChainCache：invalidate 立即失效，并发首读只读一遍', async () => {
  const cache = new PatchChainCache(60_000)
  let calls = 0
  const gate: { open: (() => void) | null } = { open: null }
  const load = async (): Promise<{ sources: never[]; failures: never[] }> => {
    calls += 1
    await new Promise<void>((r) => { gate.open = r })
    return { sources: [], failures: [] }
  }
  const a = cache.get(load, 0)
  const b = cache.get(load, 0)
  await new Promise((r) => setImmediate(r))
  gate.open?.()
  await Promise.all([a, b])
  assert.equal(calls, 1, '同批次并发只读一遍（一次导入逐行写 patch）')
  cache.invalidate()
  const afterInvalidate = await cache.get(async () => ({ sources: [{ file: 'x', doc: [] }], failures: [] }), 0)
  assert.equal(afterInvalidate.sources.length, 1, 'invalidate 之后必须重新加载，不能拿写前快照')
  assert.equal(calls, 1, '重新加载走新 loader（老的不会被再调）')
  const cachedAgain = await cache.get(async () => ({ sources: [], failures: [] }), 10)
  assert.equal(cachedAgain.sources.length, 1, '随后同一 TTL 内仍命中缓存')
})

test('#144 PatchChainCache：load 抛错不缓存（下次还会试）', async () => {
  const cache = new PatchChainCache(60_000)
  let calls = 0
  await assert.rejects(cache.get(async () => { calls += 1; throw new Error('boom') }, 0))
  const read = await cache.get(async () => { calls += 1; return { sources: [], failures: [] } }, 1)
  assert.deepEqual(read, { sources: [], failures: [] })
  assert.equal(calls, 2)
})

/* --------------------------- 写前降级判据 --------------------------- */

const CHAIN = {
  sources: [
    { file: 'bundles:demo/cordis.patch.yml', doc: [{ insert: [{ id: 'remote-ssh', name: '@zhangfengshun/dsh-remote-ssh' }] }] },
    { file: 'profiles/web/cordis.patch.yml', doc: [{ id: 'local-only' }] },
  ],
  failures: [],
}

test('#144 downgradeProvidedInserts：别的层 insert 提供 ⇒ 降级成顶层覆盖行并强制搬位', () => {
  const changes: PatchChangeLike[] = [
    { lineId: 'remote-ssh', raw: { id: 'remote-ssh' }, action: 'insert' },
    { lineId: 'local-only', raw: { id: 'local-only' }, action: 'update' },
    { lineId: 'fresh', raw: { id: 'fresh' }, action: 'insert' },
  ]
  const { effective, downgraded } = downgradeProvidedInserts(CHAIN, 'profiles/web/cordis.patch.yml', changes)
  assert.deepEqual(downgraded, ['remote-ssh'], '只有 insert→update 才算降级（要告诉用户）')
  assert.equal(effective[0]?.action, 'update')
  assert.equal(effective[0]?.forceTopLevel, true, '必须强制落到顶层（存量 insert 成员会原地留着）')
  assert.equal(effective[1]?.forceTopLevel, undefined, '本层自己的覆盖行不动')
  assert.equal(effective[2]?.action, 'insert', '没人提供的 id 仍走新增')
})

test('#144 downgradeProvidedInserts：remove 不改写，链为 null 时原样返回', () => {
  const { effective, downgraded } = downgradeProvidedInserts(CHAIN, 'profiles/web/cordis.patch.yml', [
    { lineId: 'remote-ssh', raw: { id: 'remote-ssh' }, action: 'remove' },
  ])
  assert.deepEqual(downgraded, [])
  assert.equal(effective[0]?.action, 'remove')
  const none = downgradeProvidedInserts(null, 'profiles/web/cordis.patch.yml', [{ lineId: 'a', raw: {}, action: 'insert' }] as PatchChangeLike[])
  assert.equal(none.effective[0]?.action, 'insert')
  assert.deepEqual(none.downgraded, [])
})

/* ------------------------------ 链读取 ------------------------------ */

test('#144 readPatchChainFromProfile：hoisted 的 profiles/node_modules 也能命中', async () => {
  const { home, cleanup } = tempHome()
  try {
    writeJson(join(home, 'profiles', 'web', 'package.json'), { name: 'web', dsh: { profile: { bundles: ['demo-bundle'] } } })
    // 真实布局：pnpm hoisted 把包装在 profiles/node_modules 下，profile 自己的 node_modules 是空的
    writeJson(join(home, 'profiles', 'node_modules', 'demo-bundle', 'package.json'), { name: 'demo-bundle', dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    writeFileSync(join(home, 'profiles', 'node_modules', 'demo-bundle', 'cordis.patch.yml'), '- insert:\n    - id: remote-ssh\n', 'utf8')
    const chain = await readPatchChainFromProfile(home, 'web')
    assert.deepEqual(chain.sources.map((s) => s.file), ['bundles:demo-bundle/cordis.patch.yml', profilePatchRel('web'), USER_PATCH_FILE])
    assert.deepEqual(chain.failures, [])
  } finally {
    cleanup()
  }
})

test('#144 readPatchChainFromProfile：越界 bundle 名登记失败、绝不读 $DSH_HOME 外的文件', async () => {
  const { home, cleanup } = tempHome()
  try {
    const outside = resolve(home, '..', 'outside-bundle')
    writeJson(join(outside, 'package.json'), { name: 'outside', dsh: { bundle: { patch: 'cordis.patch.yml' } } })
    writeFileSync(join(outside, 'cordis.patch.yml'), '- insert:\n    - id: stolen\n', 'utf8')
    writeJson(join(home, 'profiles', 'web', 'package.json'), { name: 'web', dsh: { profile: { bundles: ['../../outside-bundle'] } } })
    const chain = await readPatchChainFromProfile(home, 'web')
    assert.equal(chain.sources.some((s) => JSON.stringify(s.doc).includes('stolen')), false, '不得把越界包读进链')
    assert.ok(chain.failures.some((f) => f.reason.includes('illegal bundle name')), '必须登记：' + JSON.stringify(chain.failures))
    rmSync(outside, { recursive: true, force: true })
  } finally {
    cleanup()
  }
})

test('#144 readPatchChainFromProfile：补丁路径越界只登记该文件', async () => {
  const { home, cleanup } = tempHome()
  try {
    writeJson(join(home, 'profiles', 'web', 'package.json'), { name: 'web', dsh: { profile: { bundles: ['demo-bundle'] } } })
    const pkg = join(home, 'profiles', 'web', 'node_modules', 'demo-bundle')
    writeJson(join(pkg, 'package.json'), { name: 'demo-bundle', dsh: { bundle: { patch: ['ok.yml', '../../../escape.yml'] } } })
    writeFileSync(join(pkg, 'ok.yml'), '- insert:\n    - id: good\n', 'utf8')
    const chain = await readPatchChainFromProfile(home, 'web')
    assert.deepEqual(chain.sources.filter((s) => s.file.startsWith('bundles:')).map((s) => s.file), ['bundles:demo-bundle/ok.yml'])
    assert.ok(chain.failures.some((f) => f.reason.includes('escapes the bundle directory')))
  } finally {
    cleanup()
  }
})

test('#144 readExistingPatchDocument：ENOENT → undefined，解析不了必须抛', async () => {
  const { home, cleanup } = tempHome()
  try {
    assert.equal(await readExistingPatchDocument(join(home, 'nope.yml')), undefined)
    const broken = join(home, 'broken.yml')
    writeFileSync(broken, '- insert: [\n', 'utf8')
    await assert.rejects(readExistingPatchDocument(broken), '坏文件绝不能被当成空文档重建（issue #75）')
    assert.equal(readFileSync(broken, 'utf8'), '- insert: [\n', '不得改动原文件')
  } finally {
    cleanup()
  }
})
