/**
 * 预览-执行一致性（plan-changed 409）路由级回归测试（P2-T3-2）。
 *
 * 背景（审计报告 §6.2 T3）：`/restore` 的指纹闸门此前**零测试**（全仓 0 处 'plan-changed'）。
 * 为什么必须有：用户确认的是「还原这份快照的 A/B 动作」，若确认之后磁盘又变了（新文件出现、
 * 文件被删），同一份快照会多出 hostFileRemove / fileRemove 这类**破坏性**动作 ——
 * 确认内容与实际执行内容不一致且无人提示。闸门是这条数据风险的唯一拦截点。
 *
 * 手法：真 http server + 真 fetch + 真快照夹具（createSnapshot 全链路）：
 *  1. dryRun 拿 planFingerprint；
 *  2. 在 home 下**新造**一个快照里 existed:false 的 boot-critical 文件（BOOT_CRITICAL_RELS 含
 *     cordis.patch.yml）⇒ 计划多出 hostFileRemove；
 *  3. 用第 1 步的旧指纹执行 → 必须 409 plan-changed 且**零写入**（新文件还在、settings.yaml 未变）；
 *  4. 再 dryRun → 新指纹必须 ≠ 旧指纹（证明是「计划确实变了」而不是闸门恒拒）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { snapshotRoutes } from '../../src/routes/snapshots.ts'
import type { WebRoute } from '../../src/routes/kit.ts'
import { FileSnapshotStore, createSnapshot } from '../../src/core/backup.ts'
import { makeContext } from '../../src/adapters/test-helpers.ts'

const RESTORE_PATH = '/api/dsh-config-manager/restore'

interface Harness {
  root: string
  homeDir: string
  snapshotsDir: string
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-plan-changed-')))
  const homeDir = path.join(root, 'home')
  const snapshotsDir = path.join(root, 'snapshots')
  await fs.mkdir(homeDir, { recursive: true })
  await fs.mkdir(snapshotsDir, { recursive: true })
  return { root, homeDir, snapshotsDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

function minPlan() {
  return {
    items: [{ id: 'settings:general', kind: 'Update' as const, adapter: 'settings' as const, description: 'u', severity: 'info' as const, target: { adapter: 'settings' as const, ref: 'general' } }],
    globalStrategy: 'replace' as const, pathMappings: [], missingSecrets: [], needsRestart: false,
    estimatedActions: {} as Record<string, never>,
  }
}

/** 完整 READY + manifest 快照（TRUSTED_MANUAL_LOCAL 档，planRestore 的 snapshotsRoot 校验需要通过）。 */
async function seedSnapshot(h: Harness): Promise<string> {
  const ctx = makeContext('win32', h.homeDir, 'web')
  ctx.settings.ns.set('general', { value: { theme: 'dark' }, revision: 1, secrets: [] })
  const settingsText = 'general:\n  theme: dark\n'
  // 两份：ctx.fs（快照捕获来源）+ 真实磁盘（断言「零写入」的字节基准）
  await ctx.fs.writeFile('settings.yaml', Buffer.from(settingsText, 'utf8'))
  await fs.writeFile(path.join(h.homeDir, 'settings.yaml'), settingsText, 'utf8')
  const store = new FileSnapshotStore({ dir: h.snapshotsDir })
  const snap = await createSnapshot({ ctx, plan: minPlan(), sourceZip: 'x.zip', store, adapters: [] })
  return snap.id
}

function lockPort(): unknown {
  return {
    acquire: async () => ({ state: 'ACQUIRED' as const, token: { tokenId: 't1', managerId: 'm1', instanceId: 'i1', acquiredAt: Date.now() } }),
    validate: () => true,
    release: async () => {},
  }
}

function envFor(h: Harness): never {
  return {
    snapshotsDir: h.snapshotsDir,
    host: {
      homeDir: h.homeDir,
      profile: 'web',
      mutationLock: lockPort(),
      safeModeIsBlocked: () => false,
      log: { warn: () => {}, error: () => {} },
    },
    msg: (key: string) => key,
    runs: {
      register: () => ({ runId: 'run-restore-1', kind: 'restore', status: 'running', log: [] }),
      update: () => {}, finish: () => {}, fail: () => {}, appendLog: () => {},
    },
    tryAppendHistory: async () => undefined,
    snapshotEntrySections: async () => [],
    withMutationGate: (_op: string, handler: unknown) => handler,
  } as never
}

async function startServer(h: Harness): Promise<{ call: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>; close: () => Promise<void> }> {
  const route: WebRoute | undefined = snapshotRoutes(envFor(h)).find((r) => r.path === RESTORE_PATH)
  assert.ok(route !== undefined, '缺少 ' + RESTORE_PATH)
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'server 必须拿到端口')
  const base = 'http://127.0.0.1:' + String(address.port) + RESTORE_PATH
  return {
    call: async (body) => {
      const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      let json: Record<string, unknown> = {}
      try { json = await res.json() as Record<string, unknown> } catch { /* 无体 */ }
      return { status: res.status, json }
    },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()) }) },
  }
}

test('P2-T3-2: 预览后磁盘变化 → /restore 用旧指纹执行必须 409 plan-changed 且零写入', async () => {
  const h = await makeHarness()
  try {
    const snapshotId = await seedSnapshot(h)
    const before = await fs.readFile(path.join(h.homeDir, 'settings.yaml'), 'utf8')
    const server = await startServer(h)
    try {
      // 1) 预览：拿到指纹
      const preview = await server.call({ snapshotId, dryRun: true })
      assert.equal(preview.status, 200, '预览必须成功：' + JSON.stringify(preview.json))
      const fingerprint = preview.json.planFingerprint
      assert.equal(typeof fingerprint, 'string', '预览必须下发 planFingerprint（否则闸门永远无法触发）')

      // 2) 确认之后磁盘又变了：新建一个拍快照时并不存在的 boot-critical 文件
      const added = path.join(h.homeDir, 'cordis.patch.yml')
      await fs.writeFile(added, '- insert:\n    - id: late-entry\n', 'utf8')

      // 3) 用旧指纹执行 → 必须拒绝，且一个字节都不写
      const executed = await server.call({ snapshotId, dryRun: false, planFingerprint: fingerprint })
      assert.equal(executed.status, 409, '计划已变仍执行必须被拒：' + JSON.stringify(executed.json))
      assert.equal(executed.json.code, 'plan-changed', '机器码必须可判别（客户端据此提示重新预览）')
      assert.equal(await fs.readFile(path.join(h.homeDir, 'settings.yaml'), 'utf8'), before, '被拒的恢复不得写任何文件')
      await fs.access(added)
      const names = await fs.readdir(h.homeDir)
      assert.deepEqual(names.sort(), ['cordis.patch.yml', 'settings.yaml'], '被拒的恢复不得删除/新增任何文件')

      // 4) 再预览：新指纹必须不同（证明是「计划真的变了」，不是闸门恒拒）
      const again = await server.call({ snapshotId, dryRun: true })
      assert.equal(again.status, 200)
      assert.notEqual(again.json.planFingerprint, fingerprint, '新增 boot-critical 文件必须改变计划指纹')
      const actions = JSON.stringify(again.json.plan)
      assert.ok(actions.includes('hostFileRemove') || actions.includes('cordis.patch.yml'), '新指纹的成因必须是新增文件带来的动作')
    } finally {
      await server.close()
    }
  } finally {
    await h.cleanup()
  }
})
