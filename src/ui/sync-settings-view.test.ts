/**
 * 同步设置面板纯逻辑单测（t42：从 src/client/sync/SyncSettingsView.tsx 下沉后首次可测）。
 *
 * 覆盖此前**完全没有测试**的关键分支：
 * - sessions（可选分区）必须显式放行才进同步通道；includeSecrets ⇒ encrypt；
 * - 加密推送校验四条分支（没勾 / 填了且一致 / 填了不一致 / 留空且库里没密码）；
 * - 配置保存防重入状态机（在途排新改动 → 结束后补发）；
 * - GitHub device flow 轮询决策（服务端建议延迟 / interval 兜底下限 1 秒 / 终止态）；
 * - /sync/status 回填（缺省值 vs 持久化值；用户主动清空的分区保持为空）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  autosyncIntervalKey, buildSelectionRequest, buildSyncChannelBody, buildSyncConfigBody, buildSyncPushBody,
  channelBackfillFromStatus, computeEncryptInvalid, encryptToggle, formatSyncStatusTimestamp,
  formatSyncUrlPreview, githubPollDecision, hasSelectedSections, includeSecretsToggle,
  initialSessionPicks, pickedSessionIds, sessionPickerSelection,
  isGithubFlowInFlight, resolveInitialChannel, saveQueueOnFlush, saveQueueOnRequest, saveQueueOnSettled,
  toggleSectionSelection, SYNC_CONFIG_SAVE_DEBOUNCE_MS,
  type SaveQueueState, type SyncChannelSettings, type SyncFormSnapshot,
} from './sync-settings-view.ts'

/* ------------------------------------------------------------- 夹具 */

function form(overrides: Partial<SyncFormSnapshot> = {}): SyncFormSnapshot {
  return {
    channel: 'git',
    repoUrl: '  https://github.com/u/repo.git  ',
    token: '  GIT-TOKEN  ',
    webdavUrl: '  https://dav.example.com/dav  ',
    webdavUsername: '  alice  ',
    webdavPassword: 'WEBDAV-PASS',
    ...overrides,
  }
}

function settings(overrides: Partial<SyncChannelSettings> = {}): SyncChannelSettings {
  return {
    syncSections: ['settings', 'plugins'],
    sessionsLimit: 5,
    sessionsInclude: [],
    encrypt: false,
    includeSecrets: false,
    encryptPassword: '',
    encryptPasswordConfirm: '',
    encryptPasswordSaved: false,
    decryptPassword: '',
    ...overrides,
  }
}

/* ------------------------------------------------------- 请求体组装 */

test('sync-settings-view: git 通道请求体 trim 地址、空 token 不携带', () => {
  assert.deepEqual(buildSyncChannelBody(form()), {
    transport: 'git',
    repoUrl: 'https://github.com/u/repo.git',
    token: '  GIT-TOKEN  ',
  })
  assert.deepEqual(buildSyncChannelBody(form({ token: '   ' })), {
    transport: 'git',
    repoUrl: 'https://github.com/u/repo.git',
    token: undefined,
  })
})

test('sync-settings-view: webdav 通道请求体扁平顶层、空 username/password 不携带', () => {
  assert.deepEqual(buildSyncChannelBody(form({ channel: 'webdav' })), {
    transport: 'webdav',
    url: 'https://dav.example.com/dav',
    username: 'alice',
    password: 'WEBDAV-PASS',
  })
  const bare = buildSyncChannelBody(form({ channel: 'webdav', webdavUsername: ' ', webdavPassword: '' }))
  assert.equal(bare.username, undefined)
  assert.equal(bare.password, undefined)
})

test('sync-settings-view: 保存配置在地址未就绪时返回 null（自动保存跳过）', () => {
  assert.equal(buildSyncConfigBody(form({ repoUrl: '   ' })), null)
  assert.equal(buildSyncConfigBody(form({ channel: 'webdav', webdavUrl: ' ' })), null)
  const ok = buildSyncConfigBody(form())
  assert.ok(ok !== null)
  assert.equal(ok.repoUrl, 'https://github.com/u/repo.git')
  // 既有差异：保存配置路径对 token 做 trim（push 路径沿用原值）—— 搬家不改行为
  assert.equal(ok.token, 'GIT-TOKEN')
})

test('sync-settings-view: push 请求体 —— sessions 必须显式放行才携带（安全默认）', () => {
  const withoutSessions = buildSyncPushBody(form(), settings({ syncSections: ['settings'] }))
  assert.equal('sessions' in withoutSessions, false, '未勾选 sessions → 绝不携带该选项')
  assert.deepEqual(withoutSessions.sections, ['settings'])

  const withSessions = buildSyncPushBody(form(), settings({ syncSections: ['settings', 'sessions'], sessionsLimit: 3 }))
  assert.deepEqual(withSessions.sessions, { limit: 3 })
  assert.deepEqual(withSessions.sections, ['settings', 'sessions'])
})

test('P0-3: push 请求体 —— 点名清单（sessionsInclude）随 sessions 一起下发（含 limit 以便回退）', () => {
  const picked = buildSyncPushBody(form(), settings({
    syncSections: ['settings', 'sessions'],
    sessionsLimit: 5,
    sessionsInclude: ['sessions:--p--/a', 'sessions:--p--/b'],
  }))
  assert.deepEqual(picked.sessions, { limit: 5, include: ['sessions:--p--/a', 'sessions:--p--/b'] })

  // 未勾选 sessions → 即使残留点名清单也绝不携带（安全默认优先）
  const off = buildSyncPushBody(form(), settings({ syncSections: ['settings'], sessionsInclude: ['sessions:--p--/a'] }))
  assert.equal('sessions' in off, false)

  // 空清单 = 不下发 include（宿主回退到「最新 N 个」）
  const empty = buildSyncPushBody(form(), settings({ syncSections: ['sessions'], sessionsInclude: [] }))
  assert.deepEqual(empty.sessions, { limit: 5 })
})

test('P0-3: 会话选择器模型 —— 初始预选 / 白名单 ↔ Selection 往返', () => {
  const units = ['sessions:--p--/a', 'sessions:--p--/b', 'sessions:--p--/c']
  // 无语义点名 → 用「最新 N 个」预选（清单已是宿主按最新活动时间倒序）
  assert.deepEqual(initialSessionPicks(units, [], 2), ['sessions:--p--/a', 'sessions:--p--/b'])
  assert.deepEqual(initialSessionPicks(units, [], 0), [])
  // 已有点名 → 原样保留，绝不被 limit 覆盖
  assert.deepEqual(initialSessionPicks(units, ['sessions:--p--/c'], 2), ['sessions:--p--/c'])

  const value = sessionPickerSelection(units, ['sessions:--p--/c'])
  assert.deepEqual(value, { sections: ['sessions'], excluded: ['sessions:--p--/a', 'sessions:--p--/b'] })
  assert.deepEqual(pickedSessionIds(value, units), ['sessions:--p--/c'], '往返一致')
  // 一个都不勾 → 空清单（= 回到「最新 N 个」模式）
  assert.deepEqual(pickedSessionIds({ sections: ['sessions'], excluded: [...units] }, units), [])
  // 未勾选 sessions 分区 → 不产出点名
  assert.deepEqual(pickedSessionIds({ sections: [], excluded: [] }, units), [])
})

test('sync-settings-view: push 请求体 —— 空勾选不带 sections；加密选项按开关携带', () => {
  const empty = buildSyncPushBody(form(), settings({ syncSections: [] }))
  assert.equal('sections' in empty, false, '空勾选 = 不传 sections（Host 侧按默认推荐分区）')
  assert.equal('encrypt' in empty, false)
  assert.equal('encryptPassword' in empty, false)

  const plain = buildSyncPushBody(form(), settings({ encrypt: true, encryptPassword: 'P@ss', includeSecrets: false }))
  assert.deepEqual(
    { encrypt: plain.encrypt, encryptPassword: plain.encryptPassword, includeSecrets: plain.includeSecrets },
    { encrypt: true, encryptPassword: 'P@ss', includeSecrets: false },
  )
})

test('sync-settings-view: includeSecrets ⇒ encrypt（即使没勾加密也强制 true）', () => {
  const body = buildSyncPushBody(form(), settings({ encrypt: false, includeSecrets: true }))
  assert.equal(body.encrypt, true, '导出密钥必须伴随加密（密钥绝不明文上行）')
  assert.equal(body.includeSecrets, true)
})

/* --------------------------------------------------------- 派生计算 */

test('sync-settings-view: 勾选分区增删（不产生重复项）', () => {
  assert.deepEqual(toggleSectionSelection(['settings', 'plugins'], 'prompts', true), ['settings', 'plugins', 'prompts'])
  assert.deepEqual(toggleSectionSelection(['settings', 'plugins'], 'settings', true), ['settings', 'plugins'], '已勾选不重复添加')
  assert.deepEqual(toggleSectionSelection(['settings', 'plugins'], 'settings', false), ['plugins'])
  assert.deepEqual(toggleSectionSelection(['settings', 'plugins'], 'mcp', false), ['settings', 'plugins'], '取消不存在的项不改动集合')
  assert.equal(hasSelectedSections({ syncSections: [] }), false)
  assert.equal(hasSelectedSections({ syncSections: ['settings'] }), true)
})

test('sync-settings-view: 加密推送校验四条分支', () => {
  assert.equal(computeEncryptInvalid(settings()), false, '未勾选加密/密钥 → 不校验')
  assert.equal(
    computeEncryptInvalid(settings({ encrypt: true, encryptPassword: 'P@ss', encryptPasswordConfirm: 'P@ss' })),
    false,
    '填了且一致 → 合法',
  )
  assert.equal(
    computeEncryptInvalid(settings({ encrypt: true, encryptPassword: 'P@ss', encryptPasswordConfirm: 'nope' })),
    true,
    '填了但不一致 → 非法（半截密码不算数）',
  )
  assert.equal(
    computeEncryptInvalid(settings({ encrypt: true, encryptPassword: '', encryptPasswordSaved: false })),
    true,
    '留空且本机凭据库没有密码 → 非法',
  )
  assert.equal(
    computeEncryptInvalid(settings({ encrypt: true, encryptPassword: '', encryptPasswordSaved: true })),
    false,
    '留空但有已保存密码 → 合法（沿用）',
  )
  assert.equal(
    computeEncryptInvalid(settings({ includeSecrets: true, encryptPassword: 'a', encryptPasswordConfirm: 'b' })),
    true,
    '只勾「导出密钥」也走同一校验',
  )
})

test('sync-settings-view: 关闭加密 → 一并取消导出密钥、清空输入并删除已保存密码', () => {
  const off = encryptToggle(false, settings({ encrypt: true, includeSecrets: true, encryptPassword: 'x', encryptPasswordConfirm: 'x', encryptPasswordSaved: true }))
  assert.deepEqual(off.channelPatch, {
    encrypt: false, includeSecrets: false, encryptPassword: '', encryptPasswordConfirm: '', encryptPasswordSaved: false,
  })
  assert.deepEqual(off.selectionPatch, { encrypt: false, includeSecrets: false, clearEncryptPassword: true })

  const on = encryptToggle(true, settings({ includeSecrets: true }))
  assert.deepEqual(on.channelPatch, { encrypt: true, includeSecrets: true }, '打开加密不动「导出密钥」勾选')
  assert.equal('clearEncryptPassword' in on.selectionPatch, false)
})

test('sync-settings-view: 勾选导出密钥 → 自动打开加密', () => {
  const on = includeSecretsToggle(true, settings({ encrypt: false }))
  assert.deepEqual(on.channelPatch, { includeSecrets: true, encrypt: true })
  assert.deepEqual(on.selectionPatch, { includeSecrets: true, encrypt: true })

  const off = includeSecretsToggle(false, settings({ encrypt: true }))
  assert.deepEqual(off.channelPatch, { includeSecrets: false, encrypt: true }, '取消导出密钥不关闭加密')
})

test('sync-settings-view: GitHub 流程进行中判定（禁用 push/pull）', () => {
  for (const phase of ['starting', 'waiting', 'polling']) assert.equal(isGithubFlowInFlight(phase), true)
  for (const phase of ['idle', 'success', 'error']) assert.equal(isGithubFlowInFlight(phase), false)
})

test('sync-settings-view: GitHub 轮询决策（建议延迟 / interval 兜底下限 1 秒 / 终止态）', () => {
  assert.deepEqual(githubPollDecision({ status: 'pending', pollDelayMs: 7000 }, 5), { phase: 'waiting', delayMs: 7000 })
  assert.deepEqual(githubPollDecision({ status: 'pending' }, 5), { phase: 'waiting', delayMs: 5000 }, '无建议延迟 → interval 秒')
  assert.deepEqual(githubPollDecision({ status: 'pending' }, 0), { phase: 'waiting', delayMs: 1000 }, 'interval 下限 1 秒')
  assert.deepEqual(githubPollDecision({ status: 'success' }, 5), { phase: 'success', delayMs: null })
  for (const status of ['denied', 'expired', 'error'] as const) {
    assert.deepEqual(githubPollDecision({ status }, 5), { phase: 'error', delayMs: null })
  }
})

/* -------------------------------------------- /sync/status 回填（派生） */

test('sync-settings-view: 通道回填 —— 无持久化 → 缺省值；密码「已保存」只认布尔', () => {
  const backfill = channelBackfillFromStatus({
    selection: undefined,
    autosync: undefined,
    credentials: undefined,
    persistedSections: ['settings', 'plugins'],
    sessionsLimit: 5,
  })
  assert.deepEqual(backfill, {
    syncMode: 'advanced',
    syncSections: ['settings', 'plugins'],
    sessionsLimit: 5,
    sessionsInclude: [],
    encrypt: false,
    includeSecrets: false,
    encryptPasswordSaved: false,
    decryptPasswordSaved: false,
    autosyncEnabled: false,
    autosyncInterval: '30m',
  })
})

test('sync-settings-view: 通道回填 —— 持久化值优先；用户主动清空的分区保持为空', () => {
  const backfill = channelBackfillFromStatus({
    selection: { sessionsLimit: 12, encrypt: true, includeSecrets: true },
    autosync: { enabled: true, interval: '6h' },
    credentials: { encryptPasswordConfigured: true, decryptPasswordConfigured: true },
    persistedSections: [],
    sessionsLimit: 12,
  })
  assert.deepEqual(backfill.syncSections, [], '用户清空过 → 绝不悄悄填回推荐分区')
  assert.equal(backfill.sessionsLimit, 12)
  assert.equal(backfill.encrypt, true)
  assert.equal(backfill.includeSecrets, true)
  assert.equal(backfill.encryptPasswordSaved, true)
  assert.equal(backfill.decryptPasswordSaved, true)
  assert.equal(backfill.autosyncEnabled, true)
  assert.equal(backfill.autosyncInterval, '6h')
})

/* ------------------------------------ 分区选择请求体 + 配置保存状态机 */

test('sync-settings-view: 分区选择请求体 —— 未给出的字段沿用当前值，空密码不携带', () => {
  const current = settings({ encrypt: true, includeSecrets: true, sessionsLimit: 3 })
  assert.deepEqual(buildSelectionRequest('webdav', current), {
    transport: 'webdav',
    mode: 'advanced',
    sections: ['settings', 'plugins'],
    sessionsLimit: 3,
    sessionsInclude: [],
    encrypt: true,
    includeSecrets: true,
  })

  const patched = buildSelectionRequest('git', current, { sections: ['settings'], encryptPassword: '', decryptPassword: 'D' })
  assert.deepEqual(patched.sections, ['settings'])
  assert.equal('encryptPassword' in patched, false, '空密码 = 沿用本机凭据库，不写空串')
  assert.equal(patched.decryptPassword, 'D')

  const clearing = buildSelectionRequest('git', current, { clearEncryptPassword: true, encryptPassword: 'new' })
  assert.equal(clearing.clearEncryptPassword, true)
  assert.equal(clearing.encryptPassword, 'new', '删除与写入可同时出现（Host 侧删除优先）')
})

test('sync-settings-view: 保存防重入状态机 —— 在途期间的改动结束后补发，flush 优先待发', () => {
  const idle: SaveQueueState = { inFlight: false, pending: null }
  const first = buildSyncConfigBody(form())
  const second = buildSyncConfigBody(form({ repoUrl: 'https://github.com/u/other.git' }))

  const send = saveQueueOnRequest(idle, first)
  assert.equal(send.action, 'send')
  assert.equal(send.state.inFlight, true)
  assert.equal(send.state.pending, null)

  const queue1 = saveQueueOnRequest(send.state, second)
  assert.equal(queue1.action, 'queue', '在途 → 不并发发请求，先排队')
  // 最新一次改动胜出
  const third = buildSyncConfigBody(form({ repoUrl: 'https://github.com/u/third.git' }))
  const queue2 = saveQueueOnRequest(queue1.state, third)
  assert.equal(queue2.state.pending?.repoUrl, 'https://github.com/u/third.git')

  const settled = saveQueueOnSettled(queue2.state)
  assert.equal(settled.state.inFlight, false)
  assert.equal(settled.state.pending, null)
  assert.equal(settled.next?.repoUrl, 'https://github.com/u/third.git', '结束后补发在途期间排入的改动')

  const flushPending = saveQueueOnFlush({ inFlight: false, pending: first }, second)
  assert.equal(flushPending.payload?.repoUrl, first?.repoUrl, 'flush 优先待发改动')
  assert.equal(flushPending.state.pending, null, '待发一次性消费')
  const flushRebuild = saveQueueOnFlush({ inFlight: false, pending: null }, second)
  assert.equal(flushRebuild.payload?.repoUrl, second?.repoUrl, '无待发 → 按当前表单值重建')
  const flushNothing = saveQueueOnFlush({ inFlight: false, pending: null }, null)
  assert.equal(flushNothing.payload, null, '地址未就绪 → 无 payload（手动点保存会提示）')
  assert.equal(SYNC_CONFIG_SAVE_DEBOUNCE_MS, 600)
})

/* ------------------------------------------------------------ 格式化 */

test('sync-settings-view: 间隔文案键与初始通道解析', () => {
  assert.equal(autosyncIntervalKey('5m'), 'autosync.interval5m')
  assert.equal(autosyncIntervalKey('24h'), 'autosync.interval24h')
  assert.equal(autosyncIntervalKey('bogus' as never), null, '未知间隔 → null（组件原样展示）')
  assert.equal(resolveInitialChannel('webdav', null), 'webdav', '持久化的 webdav 优先')
  assert.equal(resolveInitialChannel('git', 'webdav'), 'webdav', '缺省 git 时回退 localStorage 记忆')
  assert.equal(resolveInitialChannel('git', null), 'git')
})

test('sync-settings-view: 上次同步时间格式化与远端地址预览', () => {
  assert.equal(formatSyncStatusTimestamp(undefined), '—')
  // 固定 locale 做确定性断言（组件不传 locale，行为与原文 toLocaleString() 一致）
  const iso = '2026-01-02T03:04:05.000Z'
  assert.equal(formatSyncStatusTimestamp(iso, 'en-US'), new Date(iso).toLocaleString('en-US'))
  assert.ok(formatSyncStatusTimestamp(iso, 'en-US').length > 0)

  assert.equal(formatSyncUrlPreview('https://x.example.com/dav'), 'https://x.example.com/dav')
  assert.equal(formatSyncUrlPreview('a'.repeat(80)).length, 60, '超长地址截断到 60 字符（既有展示）')
  assert.equal(formatSyncUrlPreview('a'.repeat(80), 10), 'a'.repeat(10))
})
