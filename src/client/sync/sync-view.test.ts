/**
 * m-sync-ui：远程同步区块渲染模型单测（纯函数，node 可测，无需 DOM）。
 * 覆盖验收：报告渲染（push/pull）、按钮状态、私有仓库提示、状态行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import type { PullChange, SyncPullReport, SyncPushReport } from '../../sync/sync-engine.ts'
import type { GithubPollResponse, SyncStatusResponse } from './sync-api.ts'
import {
  autosyncIntervalMs, computeAutosyncCountdown, computeGithubLoginView, computeRemoteReady, computeSyncButtons, computeSyncStatus,
  formatDateTime, formatIntervalDuration, formatLastSync, githubPollMessage, kindLabel, privateRepoHint,
  pullReportView, pushReportView, severityLabel, summarizePullChanges,
} from './sync-view.ts'

/* ---------------------------------------------------------------- 私有仓库提示 */

test('sync-view: 私有仓库强制提示文案存在且强调私有', () => {
  const hint = privateRepoHint()
  assert.match(hint, /私有/)
  assert.match(hint, /public/)
  assert.match(hint, /token/)
})

/* ---------------------------------------------------------------- 按钮状态 */

test('sync-view: 空闲 + 活动通道地址未就绪 → 两个按钮都禁用', () => {
  const b = computeSyncButtons(null, false)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pushLabel, '推送到远端')
  assert.equal(b.pullLabel, '拉取差异预览')
})

test('sync-view: 空闲 + 活动通道地址就绪 → 两个按钮可用', () => {
  const b = computeSyncButtons(null, true)
  assert.equal(b.canPush, true)
  assert.equal(b.canPull, true)
})

test('sync-view: push 进行中 → 按钮禁用且文案切换为正在推送（防并发）', () => {
  const b = computeSyncButtons('push', true)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pushLabel, '正在推送…')
  assert.equal(b.pullLabel, '拉取差异预览')
})

test('sync-view: pull 进行中 → 两个按钮都禁用，pull 文案切换', () => {
  const b = computeSyncButtons('pull', true)
  assert.equal(b.canPush, false)
  assert.equal(b.canPull, false)
  assert.equal(b.pullLabel, '正在拉取…')
})

test('sync-view: computeRemoteReady 按活动通道判断地址就绪（git=repoUrl，webdav=url）', () => {
  assert.equal(computeRemoteReady('git', 'https://github.com/u/r.git', ''), true)
  assert.equal(computeRemoteReady('git', '  ', 'https://dav.example.com/dav'), false, 'git 通道不看 webdav 地址')
  assert.equal(computeRemoteReady('webdav', '', 'https://dav.example.com/dav'), true)
  assert.equal(computeRemoteReady('webdav', 'https://github.com/u/r.git', ''), false, 'webdav 通道不看 git 地址')
  assert.equal(computeRemoteReady('webdav', '', '   '), false)
})

/* ---------------------------------------------------------------- 变更摘要 */

function change(overrides: Partial<PullChange>): PullChange {
  return { id: 'x', adapter: 'settings', kind: 'Update', description: 'd', severity: 'info', ...overrides }
}

test('sync-view: summarizePullChanges 按 severity 计数', () => {
  const summary = summarizePullChanges([
    change({ severity: 'info' }),
    change({ severity: 'info' }),
    change({ severity: 'warning' }),
    change({ severity: 'error' }),
  ])
  assert.equal(summary.total, 4)
  assert.equal(summary.info, 2)
  assert.equal(summary.warning, 1)
  assert.equal(summary.error, 1)
  assert.equal(summary.needsReview, false)
})

test('sync-view: summarizePullChanges 对冲突/安装/密钥/依赖项标记 needsReview', () => {
  const summary = summarizePullChanges([
    change({ kind: 'Conflict' }),
    change({ kind: 'Install' }),
  ])
  assert.equal(summary.needsReview, true)
})

test('sync-view: summarizePullChanges 空数组 → total 0 且不需决策', () => {
  const summary = summarizePullChanges([])
  assert.equal(summary.total, 0)
  assert.equal(summary.needsReview, false)
})

test('sync-view: kindLabel / severityLabel 覆盖关键类型', () => {
  assert.equal(kindLabel('Conflict'), '冲突')
  assert.equal(kindLabel('Install'), '安装')
  assert.equal(kindLabel('MissingSecret'), '缺密钥')
  assert.equal(severityLabel('error'), '错误')
  assert.equal(severityLabel('warning'), '警告')
  assert.equal(severityLabel('info'), '信息')
})

/* ---------------------------------------------------------------- push 报告渲染 */

test('sync-view: push 成功报告 → ok 头部含快照 id + 分区透传', () => {
  const report: SyncPushReport = { ok: true, snapshotId: 'sync-1', sections: ['settings', 'plugins'], warnings: [] }
  const view = pushReportView(report)
  assert.notEqual(view, null)
  assert.equal(view?.kind, 'ok')
  assert.match(view?.headline ?? '', /sync-1/)
  assert.deepEqual(view?.sections, ['settings', 'plugins'])
})

test('sync-view: push 失败报告 → error 显示引擎 message', () => {
  const report: SyncPushReport = { ok: false, snapshotId: '', sections: [], warnings: [], message: '全部导出失败' }
  const view = pushReportView(report)
  assert.equal(view?.kind, 'error')
  assert.equal(view?.headline, '全部导出失败')
})

test('sync-view: null 报告 → null（不渲染卡片）', () => {
  assert.equal(pushReportView(null), null)
  assert.equal(pullReportView(null), null)
})

/* ---------------------------------------------------------------- pull 报告渲染 */

test('sync-view: pull 无变更 → empty 渲染（无差异列表）', () => {
  const report: SyncPullReport = { ok: true, snapshotId: 'sync-1', changes: [], needsReview: false }
  const view = pullReportView(report)
  assert.equal(view?.kind, 'empty')
  assert.equal(view?.summary, null)
})

test('sync-view: pull 差异报告 → ok + 摘要计数 + needsReview + 只读预览提示', () => {
  const report: SyncPullReport = {
    ok: true,
    snapshotId: 'sync-9',
    changes: [
      change({ id: 'settings:a', kind: 'Update', description: '更新设置 a', severity: 'info' }),
      change({ id: 'plugin:x', kind: 'Conflict', adapter: 'plugins', description: '插件 x 冲突', severity: 'warning' }),
    ],
    needsReview: true,
  }
  const view = pullReportView(report)
  assert.equal(view?.kind, 'ok')
  assert.match(view?.headline ?? '', /sync-9/)
  assert.equal(view?.summary?.total, 2)
  assert.equal(view?.summary?.needsReview, true)
  assert.equal(view?.summary?.items[0]?.description, '更新设置 a')
  assert.equal(view?.summary?.items[1]?.kind, 'Conflict')
  assert.notEqual(view?.previewHint, '')
  assert.match(view?.previewHint, /不会执行导入/)
})

test('sync-view: pull 失败 → error 渲染', () => {
  const report: SyncPullReport = { ok: false, snapshotId: '', changes: [], needsReview: false, message: '认证失败' }
  const view = pullReportView(report)
  assert.equal(view?.kind, 'error')
  assert.equal(view?.headline, '认证失败')
})

/* ---------------------------------------------------------------- 状态行 */

test('sync-view: 加载中 → loading 状态', () => {
  const s = computeSyncStatus(null, true, null)
  assert.equal(s.kind, 'loading')
})

test('sync-view: 加载失败 → error 状态带消息', () => {
  const s = computeSyncStatus(null, false, '网络错误')
  assert.equal(s.kind, 'error')
  assert.equal(s.text, '网络错误')
})

test('sync-view: 未配置仓库 → unconfigured 提示', () => {
  const s = computeSyncStatus(null, false, null)
  assert.equal(s.kind, 'unconfigured')
  assert.match(s.text, /尚未配置/)
})

test('sync-view: 已配置但缺凭据 → ready 文案提示未配置凭据', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: false, credentialWritable: true, lastSyncAt: undefined, sectionCount: 0,
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /未配置凭据/)
})

test('sync-view: 已配置 + 凭据就绪 + 上次同步 → ready 文案含日期与通道', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: true, credentialWritable: true,
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 3,
    transport: { type: 'git', ref: 'main' },
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /凭据已配置/)
  assert.match(s.text, /上次同步/)
  assert.match(s.text, /git\/main/)
})

test('sync-view: webdav 通道 → ready 文案回显通道类型（webdav + 服务器地址 ref）', () => {
  const info: SyncStatusResponse = {
    ok: true, configured: true, repoUrl: undefined,
    credentialConfigured: false, credentialWritable: true,
    webdav: { url: 'https://dav.example.com/dav/config', usernameConfigured: true, passwordConfigured: true },
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 2,
    transport: { type: 'webdav', ref: 'https://dav.example.com/dav/config' },
  }
  const s = computeSyncStatus(info, false, null)
  assert.equal(s.kind, 'ready')
  assert.match(s.text, /凭据已配置/)
  assert.match(s.text, /webdav/)
  assert.match(s.text, /https:\/\/dav\.example\.com\/dav\/config/)
})

/* ---------------------------------------------------------------- 时间格式化 */

test('sync-view: formatLastSync 空值 → 从未同步', () => {
  assert.equal(formatLastSync(undefined), '从未同步')
  assert.equal(formatLastSync(''), '从未同步')
})

test('sync-view: formatLastSync / formatDateTime 合法 ISO → 本地可读格式', () => {
  const text = formatLastSync('2026-08-16T10:30:00.000Z')
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatDateTime('not-a-date'), 'not-a-date')
})

/* ------------------------------------------------ GitHub 登录视图模型 */

test('sync-view: github 登录 idle → 可开始、不展示代码区块、无错误', () => {
  const v = computeGithubLoginView('idle', '', '', null)
  assert.equal(v.phase, 'idle')
  assert.equal(v.canStart, true)
  assert.equal(v.canCancel, false)
  assert.equal(v.showCode, false)
  assert.match(v.startLabel, /GitHub/)
})

test('sync-view: github 登录 starting → 不可重复发起、显示进行中文案', () => {
  const v = computeGithubLoginView('starting', '', '', null)
  assert.equal(v.canStart, false)
  assert.equal(v.canCancel, true)
  assert.match(v.statusText, /发起/)
})

test('sync-view: github 登录 waiting → 展示设备码与授权链接、可取消', () => {
  const v = computeGithubLoginView('waiting', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, true)
  assert.equal(v.canCancel, true)
  assert.equal(v.userCode, 'ABCD-EFGH')
  assert.equal(v.verificationUri, 'https://github.com/login/device')
  assert.match(v.statusText, /ABCD-EFGH/)
})

test('sync-view: github 登录 polling → 仍展示代码区块且可取消', () => {
  const v = computeGithubLoginView('polling', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, true)
  assert.equal(v.canCancel, true)
  assert.equal(v.canStart, false)
  assert.match(v.statusText, /确认 GitHub 授权状态/)
})

test('sync-view: github 登录 success → 成功文案、代码区块隐藏', () => {
  const v = computeGithubLoginView('success', 'ABCD-EFGH', 'https://github.com/login/device', null)
  assert.equal(v.showCode, false)
  assert.equal(v.canStart, false)
  assert.match(v.statusText, /已安全写入/)
})

test('sync-view: github 登录 error → 展示错误 + 重新登录入口', () => {
  const v = computeGithubLoginView('error', '', '', '授权被拒绝')
  assert.equal(v.canStart, true)
  assert.equal(v.canCancel, false)
  assert.equal(v.error, '授权被拒绝')
  assert.match(v.statusText, /授权被拒绝/)
  assert.match(v.startLabel, /重新登录/)
})

test('sync-view: githubPollMessage 映射轮询终止态（denied/expired/error/success）', () => {
  const denied: GithubPollResponse = { status: 'denied' }
  assert.match(githubPollMessage(denied), /拒绝/)
  const expired: GithubPollResponse = { status: 'expired' }
  assert.match(githubPollMessage(expired), /过期/)
  const error: GithubPollResponse = { status: 'error', errorCode: 'incorrect_device_code', message: '设备码不匹配' }
  assert.match(githubPollMessage(error), /设备码不匹配/)
  const success: GithubPollResponse = { status: 'success', credentialConfigured: true }
  assert.match(githubPollMessage(success), /已安全写入/)
  const pending: GithubPollResponse = { status: 'pending', pollDelayMs: 5000 }
  assert.equal(githubPollMessage(pending), '', 'pending 不是终止态，不应产生消息')
})

/* ---------------------------------------------------------------- 自动同步倒计时 */

test('sync-view: autosyncIntervalMs 各档位换算正确', () => {
  assert.equal(autosyncIntervalMs('5m'), 5 * 60 * 1000)
  assert.equal(autosyncIntervalMs('15m'), 15 * 60 * 1000)
  assert.equal(autosyncIntervalMs('30m'), 30 * 60 * 1000)
  assert.equal(autosyncIntervalMs('60m'), 60 * 60 * 1000)
  assert.equal(autosyncIntervalMs('6h'), 6 * 60 * 60 * 1000)
  assert.equal(autosyncIntervalMs('12h'), 12 * 60 * 60 * 1000)
  assert.equal(autosyncIntervalMs('24h'), 24 * 60 * 60 * 1000)
})

test('sync-view: computeAutosyncCountdown 已到期 → 0；未到 → interval - elapsed；从未运行 → -1', () => {
  assert.equal(computeAutosyncCountdown(0, 5 * 60 * 1000), 5 * 60 * 1000)
  assert.equal(computeAutosyncCountdown(60 * 1000, 5 * 60 * 1000), 4 * 60 * 1000)
  assert.equal(computeAutosyncCountdown(5 * 60 * 1000, 5 * 60 * 1000), 0)
  assert.equal(computeAutosyncCountdown(6 * 60 * 1000, 5 * 60 * 1000), 0)
  assert.equal(computeAutosyncCountdown(-1, 5 * 60 * 1000), -1)
})

test('sync-view: formatIntervalDuration 输出真实剩余时长（不再把 <1 小时一律显示成 30 分钟）', () => {
  // 回归：旧实现 `if (minutes < 60) return '30 分钟'` 导致 5m 间隔永远显示「约 30 分钟后」
  assert.equal(formatIntervalDuration(4 * 60 * 1000), '4 分钟')
  assert.equal(formatIntervalDuration(5 * 60 * 1000), '5 分钟')
  assert.equal(formatIntervalDuration(30 * 60 * 1000), '30 分钟')
  // 整 60 分钟进位为 1 小时
  assert.equal(formatIntervalDuration(60 * 60 * 1000), '1 小时')
  // 向上取整：90 分钟 → 2 小时；6 小时整 → 6 小时
  assert.equal(formatIntervalDuration(90 * 60 * 1000), '2 小时')
  assert.equal(formatIntervalDuration(6 * 60 * 60 * 1000), '6 小时')
  // 跨天：24 小时 → 1 天；48 小时 → 2 天
  assert.equal(formatIntervalDuration(24 * 60 * 60 * 1000), '1 天')
  assert.equal(formatIntervalDuration(48 * 60 * 60 * 1000), '2 天')
  // 已到期/异常值兜底为 1 分钟，不出现 0 分钟
  assert.equal(formatIntervalDuration(0), '1 分钟')
})
