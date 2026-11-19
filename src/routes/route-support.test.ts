/**
 * 路由辅助状态映射单测（P0-2：buildAutosyncStatus / buildAutosyncStatusByChannel）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildAutosyncStatus, buildAutosyncStatusByChannel } from './route-support.ts'
import { writeAutosyncConfig, type AutosyncConfig } from '../sync/autosync-config.ts'

test('buildAutosyncStatus：回传最近检查组（lastRunAt/lastCheckStatus）与最近结论组（lastSyncAt/lastRunStatus/consecutiveFailures）', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-route-support-'))
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  const cfg: AutosyncConfig = {
    enabled: true,
    interval: '30m',
    startupMinIntervalMs: 300_000,
    consecutiveFailures: 2,
    lastRunAt: '2026-11-18T10:05:00.000Z',
    lastCheckStatus: 'upToDate',
    lastSyncAt: '2026-11-18T10:00:00.000Z',
    lastSuccessAt: '2026-11-18T09:00:00.000Z',
    lastRunStatus: 'failed',
    lastRunMessage: '502 Bad Gateway',
    lastRunHistoryId: 'autosync-h1',
    lastRunNextRetryAt: '2026-11-18T10:20:00.000Z',
  }
  await writeAutosyncConfig(dir, 'git', cfg)

  const single = await buildAutosyncStatus(dir, 'git')
  assert.equal(single.lastRunAt, '2026-11-18T10:05:00.000Z')
  assert.equal(single.lastCheckStatus, 'upToDate')
  assert.equal(single.lastSyncAt, '2026-11-18T10:00:00.000Z')
  assert.equal(single.lastRunStatus, 'failed')
  assert.equal(single.lastRunMessage, '502 Bad Gateway')
  assert.equal(single.consecutiveFailures, 2)
  assert.equal(single.lastRunHistoryId, 'autosync-h1')
  assert.equal(single.lastRunNextRetryAt, '2026-11-18T10:20:00.000Z')

  const byChannel = await buildAutosyncStatusByChannel(dir)
  assert.equal(byChannel.git.lastRunStatus, 'failed')
  assert.equal(byChannel.git.lastCheckStatus, 'upToDate')
  assert.equal(byChannel.git.lastSyncAt, '2026-11-18T10:00:00.000Z')
  assert.equal(byChannel.webdav.lastRunStatus, undefined)
  assert.equal(byChannel.webdav.lastCheckStatus, undefined)
})
