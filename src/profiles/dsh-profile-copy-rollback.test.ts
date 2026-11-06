/**
 * tech-debt #5 回归：**复制失败后的回滚也失败时，残留目录必须仍然可被发现、可被删除**。
 *
 * 现场（docs/known-issues/tech-debt.md:20 的窄缝）：copy() 的 catch 里是一把 `rm(recursive)` 加一句注释。
 * 若那次 rm 先删掉了标记（`.dcm-copy-in-progress.json`）再失败 —— 例如某个只读子目录让它中途放弃，
 * 或 rm 自身部分生效 —— 残留目录就退回「没有 package.json、也没有标记」的形态：
 *   - listIncompleteCopies() / listIncompleteCopiesScan() 扫不到（渲染面板里看不见）；
 *   - remove() → requireManagedDir → notFound（删不掉）；
 * 正是 cross-F3 花一整轮才消掉的孤儿。
 *
 * 修复口径（src/profiles/dsh-profile-manager.ts 的 rollbackCopiedProfileDir）：先删内容、标记留到最后；
 * 收尾时若目录仍在而标记没了，按原样**重写标记**。本文件钉住这两条不变式，
 * 并注入「部分失败」的删除实现来复现最难的那一种顺序（rm 先删标记再失败）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DshProfileManager, rollbackCopiedProfileDir } from './dsh-profile-manager.ts'
import type { DshProfileCopyMarker } from './dsh-profile-shared.ts'

/** 磁盘契约字面量：改名即等于把旧版本留下的残留重新变成「查不到」（与 dsh-profile-incomplete-copy.test.ts 同口径）。 */
const MARKER = '.dcm-copy-in-progress.json'
const STARTED_AT = '2026-10-05T12:00:00.000Z'

const MARKER_OBJ: DshProfileCopyMarker = {
  sourceName: 'work',
  newName: 'work-copy',
  startedAt: STARTED_AT,
  includeNodeModules: true,
  pid: 4242,
}

function makeManager(): { mgr: DshProfileManager; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-copy-rollback-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const mgr = new DshProfileManager({ homeDir: home, currentProfile: () => 'web' })
  return { mgr, home, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

/** 造一个「复制中途失败」的目标目录：部分内容 + 标记，**没有 package.json**。 */
function writeHalfCopy(home: string, name = 'work-copy'): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'partial', 'utf8')
  writeFileSync(join(dir, 'cordis.patch.yml'), '# partial patch layer\n', 'utf8')
  writeFileSync(join(dir, MARKER), `${JSON.stringify(MARKER_OBJ, null, 2)}\n`, 'utf8')
  return dir
}

test('#5-A：rm 先删标记再失败 → 回滚必须补写标记，残留仍可被扫到并删除', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home)
    const markerPath = join(dir, MARKER)
    // 复现最难的那一种失败顺序：删除根目录时**先删标记**，然后抛错（内容已经删光）。
    const remove = async (target: string): Promise<void> => {
      if (target === dir) {
        rmSync(markerPath, { force: true })
        throw new Error('EBUSY: simulated partial rm')
      }
      rmSync(target, { recursive: true, force: true })
    }
    const outcome = await rollbackCopiedProfileDir(dir, MARKER_OBJ, remove)

    assert.equal(outcome.removed, false, '目录还在 ⇒ removed=false（绝不假装回滚成功）')
    assert.equal(outcome.markerRestored, true, '标记被 rm 顺带删掉后必须按原样补写')
    assert.equal(existsSync(markerPath), true, '标记必须回到盘上（扫得到的唯一凭据）')

    // ① 恢复面板 / CLI 的清单必须看得到它
    const copies = mgr.listIncompleteCopies()
    assert.equal(copies.length, 1)
    assert.equal(copies[0]?.name, 'work-copy')
    assert.equal(copies[0]?.markerReadable, true, '补写的标记内容必须仍可读（不是空壳）')
    assert.equal(copies[0]?.sourceName, 'work')
    assert.equal(mgr.listIncompleteCopiesScan().unreadable, false)

    // ② UI 的「删除残留副本」必须删得掉
    mgr.remove('work-copy')
    assert.equal(existsSync(dir), false)
    assert.deepEqual(mgr.listIncompleteCopies(), [])
  } finally {
    cleanup()
  }
})

test('#5-B：某个子项删不掉 → 标记留到最后（不参与删除批次），仍可被扫到并删除', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home)
    const remove = async (target: string): Promise<void> => {
      if (target.endsWith(join('node_modules')) || target.includes(`node_modules`)) {
        throw new Error('EPERM: simulated read-only subtree')
      }
      rmSync(target, { recursive: true, force: true })
    }
    const outcome = await rollbackCopiedProfileDir(dir, MARKER_OBJ, remove)

    assert.equal(outcome.removed, false)
    assert.deepEqual(outcome.failedEntries, ['node_modules'], '失败项如实回报（诊断用）')
    assert.equal(existsSync(join(dir, MARKER)), true, '内容删不完时标记必须还在')
    assert.equal(existsSync(join(dir, 'cordis.patch.yml')), false, '能删的照删（不留半套内容）')

    const copies = mgr.listIncompleteCopies()
    assert.equal(copies.length, 1)
    assert.equal(copies[0]?.name, 'work-copy')
    mgr.remove('work-copy')
    assert.equal(existsSync(dir), false)
  } finally {
    cleanup()
  }
})

test('#5-C：回滚完全成功 → 目录与标记一并消失，列举里不留鬼影', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = writeHalfCopy(home)
    assert.equal(mgr.listIncompleteCopies().length, 1, '前置：回滚前它就在列举里')

    const outcome = await rollbackCopiedProfileDir(dir, MARKER_OBJ)

    assert.equal(outcome.removed, true)
    assert.equal(outcome.markerRestored, false)
    assert.equal(existsSync(dir), false)
    assert.deepEqual(mgr.listIncompleteCopies(), [])
  } finally {
    cleanup()
  }
})

test('#5-D：copy() 失败路径确实走回滚（整体接线）—— 目标目录被清掉、列举为空、源档案零改动', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const src = join(home, 'profiles', 'work')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'dsh-profile-work', dependencies: {} }), 'utf8')
    writeFileSync(join(src, 'cordis.patch.yml'), '# patch\n', 'utf8')
    writeFileSync(join(src, 'sub', 'note.txt'), 'x', 'utf8')

    // 注入「复制中途失败」：copy() 搬完文件后必调 relinkCopiedTree，让它抛错等同复制半途炸掉。
    // （「回滚**也**失败」的最难顺序由 A/B 用注入的删除实现覆盖；这里只钉接线：catch 确实走回滚。）
    const seam = mgr as unknown as { relinkCopiedTree: () => Promise<void> }
    seam.relinkCopiedTree = async () => { throw new Error('simulated mid-copy failure') }

    await assert.rejects(mgr.copy('work', 'work-copy'), (err: unknown) => err instanceof Error && /copyFailed/.test(err.message))

    assert.equal(existsSync(join(home, 'profiles', 'work-copy')), false, '回滚成功时目标目录必须消失')
    assert.deepEqual(mgr.listIncompleteCopies(), [], '成功回滚 ⇒ 不留残留（也不会被当成残留）')
    assert.equal(readFileSync(join(src, 'sub', 'note.txt'), 'utf8'), 'x', '源档案零改动')
  } finally {
    cleanup()
  }
})
