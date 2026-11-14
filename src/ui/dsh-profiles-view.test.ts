/**
 * 「档案」页视图模型单测（纯函数，无 IO）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  bundleLines, canLaunchProfile, copyWarningKey, dependencyLines, formatBytes, formatProfileTime,
  isProfileRunning, issueLabelKey, launchBlockReason, launchState, launchWarningKey, profileInstallCommand, profileRowAction,
  profileRowFacts, profileVersionFacts, profilesPanelPhase, restartCommand, runningRecordFor, sessionFormatRisk,
  shapeLabelKey, sortProfilesForDisplay, stopResultKey, suggestCopyName, summarizeProfiles, validateProfileNameInput,
} from './dsh-profiles-view.ts'
import type { DshProfileLaunchResult, DshProfileMeta, DshProfileRunningView } from '../profiles/dsh-profile-shared.ts'

function meta(name: string, over: Partial<DshProfileMeta> = {}): DshProfileMeta {
  return {
    name,
    dir: `/home/.dsh/profiles/${name}`,
    bundles: ['@deepseek-ai/dsh-base'],
    dependencies: {},
    shape: 'generic',
    patchReload: 'live',
    hasNodeModules: false,
    patchEntryCount: 0,
    patchBytes: 0,
    isCurrent: false,
    issues: [],
    updatedAtMs: null,
    ...over,
  }
}

test('profileVersionFacts：读不到的版本一律 null（绝不显示假版本号）', () => {
  assert.deepEqual(profileVersionFacts(meta('a')), { dshVersion: null, sessionFormatVersion: null });
  assert.deepEqual(
    profileVersionFacts(meta('a', { dshVersion: '0.1.5-rc.1', sessionFormatVersion: 3 })),
    { dshVersion: '0.1.5-rc.1', sessionFormatVersion: 3 },
  );
  assert.deepEqual(profileVersionFacts(meta('a', { dshVersion: '', sessionFormatVersion: null })), { dshVersion: null, sessionFormatVersion: null });
});

test('sessionFormatRisk：只对「确定更高/更低」报风险，任一侧读不到一律 none（不猜）', () => {
  const v = (n: number | null) => meta('p', { sessionFormatVersion: n });
  assert.equal(sessionFormatRisk(v(4), 3), 'newer', '档案更新 → 它的对话在本实例看不见');
  assert.equal(sessionFormatRisk(v(3), 4), 'older', '档案更旧 → 本实例的对话在该档案看不见');
  assert.equal(sessionFormatRisk(v(3), 3), 'none');
  assert.equal(sessionFormatRisk(v(null), 3), 'none', '读不到该档案版本 → 不提示');
  assert.equal(sessionFormatRisk(v(4), null), 'none', '读不到本实例版本 → 不提示');
  assert.equal(sessionFormatRisk(v(4), undefined), 'none', '旧宿主不回传 → 不提示');
});

test('profilesPanelPhase：无数据 = loading、有数据 = ready、失败优先 error', () => {
  assert.equal(profilesPanelPhase(null, null), 'loading')
  assert.equal(profilesPanelPhase([], null), 'ready', '空列表也是就绪（渲染空态，不是转圈）')
  assert.equal(profilesPanelPhase([meta('web')], null), 'ready')
  assert.equal(profilesPanelPhase(null, 'boom'), 'error')
  assert.equal(profilesPanelPhase([meta('web')], 'boom'), 'error', '失败必须可见，不用陈旧列表掩盖')
})

test('validateProfileNameInput：空 / 过长 / 非法字符 / 保留名 / 合法', () => {
  assert.equal(validateProfileNameInput(''), 'required')
  assert.equal(validateProfileNameInput('   '), 'required')
  assert.equal(validateProfileNameInput('x'.repeat(65)), 'tooLong')
  assert.equal(validateProfileNameInput('../x'), 'illegal')
  assert.equal(validateProfileNameInput('a/b'), 'illegal')
  assert.equal(validateProfileNameInput('a\\b'), 'illegal')
  assert.equal(validateProfileNameInput('..'), 'illegal')
  assert.equal(validateProfileNameInput('node_modules'), 'illegal')
  assert.equal(validateProfileNameInput('web'), 'reserved')
  assert.equal(validateProfileNameInput('desktop'), 'reserved')
  assert.equal(validateProfileNameInput('work'), null)
  assert.equal(validateProfileNameInput('  work  '), null)
})

test('sortProfilesForDisplay：当前运行置顶 → 有实例在跑的接着 → 其余按名', () => {
  const list = [meta('zeta'), meta('alpha'), meta('work'), meta('beta')]
  const sorted = sortProfilesForDisplay(list, { currentName: 'work', runningNames: ['beta'] })
  assert.deepEqual(sorted.map((p) => p.name), ['work', 'beta', 'alpha', 'zeta'])
  assert.deepEqual(sortProfilesForDisplay(list).map((p) => p.name), ['alpha', 'beta', 'work', 'zeta'])
})

// 「启动 ↔ 停止」的判据：唯一来源是 host 回传的合并视图（台账 ∪ 心跳），UI 不猜
test('isProfileRunning / runningRecordFor：只认记录里有的档案名', () => {
  const running: DshProfileRunningView[] = [
    { name: 'work', port: 3081, pid: 4242, url: 'http://127.0.0.1:3081/?token=t', startedAt: '2026-09-26T00:00:00.000Z', owned: true, current: false },
  ]
  assert.equal(isProfileRunning(running, 'work'), true)
  assert.equal(isProfileRunning(running, 'other'), false)
  assert.equal(isProfileRunning([], 'work'), false)
  assert.equal(runningRecordFor(running, 'work')?.port, 3081)
  assert.equal(runningRecordFor(running, 'other'), undefined)
})

/** 运行中实例的三种来源（本插件启动 / 别的实例或手动启动 / 就是自己）。 */
function view(name: string, over: Partial<DshProfileRunningView> = {}): DshProfileRunningView {
  return { name, port: 3081, pid: 4242, url: null, startedAt: '2026-09-26T00:00:00.000Z', owned: false, current: false, ...over }
}

// 用户实测的 bug（从 web 启动 cmtest 后，在 cmtest 里还能再启动 web）靠这个判据挡住：
// 任何「已经在跑」的档案都不再给启动按钮。
test('profileRowAction：没在跑 → launch；别人在跑 → stop；自己在跑 → current（不给启动）', () => {
  assert.equal(profileRowAction('work', []), 'launch')
  assert.equal(profileRowAction('work', [view('other', { owned: true })]), 'launch', '别的档案在跑不影响这一行')
  assert.equal(profileRowAction('work', [view('work', { owned: true })]), 'stop')
  assert.equal(profileRowAction('web', [view('web')]), 'stop', '手动/别的实例启动的 web 同样不能再启动，但可以停')
  assert.equal(profileRowAction('work', [view('work', { owned: true, current: true })]), 'current')
  assert.equal(profileRowAction('work', [view('work', { current: true })]), 'current', '当前实例优先于 owned')
})

test('stopResultKey：优雅退出 / 强制终止 / 早已不在 分开说（不许把强杀说成优雅）', () => {
  assert.equal(stopResultKey('graceful'), 'profiles.stop.done')
  assert.equal(stopResultKey('killed'), 'profiles.stop.forced')
  assert.equal(stopResultKey('already-stopped'), 'profiles.stop.gone')
})

test('summarizeProfiles：形态 / 损坏 / node_modules / patch 条目统计', () => {
  const summary = summarizeProfiles([
    meta('web1', { shape: 'web', hasNodeModules: true, patchEntryCount: 2 }),
    meta('h1', { shape: 'headless' }),
    meta('g1', { shape: 'generic', patchEntryCount: 1 }),
    meta('broken', { issues: ['manifestInvalid'] }),
  ])
  assert.deepEqual(summary, { total: 4, web: 1, headless: 1, generic: 2, broken: 1, withNodeModules: 1, patchEntries: 3 })
  assert.deepEqual(summarizeProfiles([]), { total: 0, web: 0, headless: 0, generic: 0, broken: 0, withNodeModules: 0, patchEntries: 0 })
})

test('profileRowFacts：行内只给计数（不铺开包名清单）', () => {
  const facts = profileRowFacts(meta('web', {
    bundles: ['a', 'b', 'c'],
    dependencies: { x: '^1.0.0', y: '^2.0.0' },
    patchEntryCount: 4,
    hasNodeModules: true,
  }))
  assert.deepEqual(facts, { bundles: 3, patchEntries: 4, deps: 2, hasNodeModules: true })
})

test('bundleLines：保持声明顺序（= patch 应用顺序，不可排序）', () => {
  assert.deepEqual(bundleLines(meta('p', { bundles: ['zeta', 'alpha', 'dsh-base'] })), ['zeta', 'alpha', 'dsh-base'])
  assert.deepEqual(bundleLines(meta('empty', { bundles: [] })), [])
})

test('dependencyLines：按包名排序；spec 为空只给包名', () => {
  assert.deepEqual(
    dependencyLines(meta('p', { dependencies: { zeta: '^3.0.0', alpha: '^1.0.0', bare: '' } })),
    ['alpha ^1.0.0', 'bare', 'zeta ^3.0.0'],
  )
  assert.deepEqual(dependencyLines(meta('none')), [])
})

test('restartCommand / shapeLabelKey / issueLabelKey', () => {
  assert.equal(restartCommand('work'), 'dsh --profile work')
  assert.equal(shapeLabelKey('web'), 'profiles.shape.web')
  assert.equal(shapeLabelKey('headless'), 'profiles.shape.headless')
  assert.equal(shapeLabelKey('generic'), 'profiles.shape.generic')
  assert.equal(issueLabelKey('manifestInvalid'), 'profiles.issue.manifestInvalid')
  assert.equal(issueLabelKey('patchTooLarge'), 'profiles.issue.patchTooLarge')
})

test('canLaunchProfile：「用该档案启动」只对 web 形态开放（其余形态没有浏览器界面）', () => {
  assert.equal(canLaunchProfile({ name: 'work', shape: 'web' }), true)
  assert.equal(canLaunchProfile({ name: 'work', shape: 'headless' }), false)
  assert.equal(canLaunchProfile({ name: 'work', shape: 'generic' }), false)
  // Desktop 独占档案：桌面端 profile 的 bundles 里确实有 dsh-web-app（形态确实是 web），
  // 但普通 dsh CLI 对 --profile desktop 硬性拒绝 → 一律不可启动（真机：点「启动」只会拿到
  // 'profile "desktop" is managed exclusively by the Electron application'）。
  assert.equal(canLaunchProfile({ name: 'desktop', shape: 'web' }), false, 'desktop 档案不可启动');
  assert.equal(canLaunchProfile({ name: 'DESKTOP', shape: 'web' }), false, '大小写不敏感（与 dsh CLI 同口径）');
})

test('launchBlockReason：managed 档案不能给 dsh --profile desktop 那条命令（它本身就是被拒的那条）', () => {
  assert.equal(launchBlockReason({ name: 'desktop', shape: 'web' }), 'managed')
  assert.equal(launchBlockReason({ name: 'desktop', shape: 'generic' }), 'managed')
  assert.equal(launchBlockReason({ name: 'work', shape: 'headless' }), 'notWeb')
})

test('launchState / launchWarningKey：就绪判据必须「已探通且有 URL」，告警逐条可本地化', () => {
  const base: DshProfileLaunchResult = {
    name: 'work', mode: 'web', port: 3099, url: 'http://127.0.0.1:3099/?token=t', pid: 1,
    logFile: '/tmp/launch-work-3099.log', ready: true, warnings: [],
  }
  assert.equal(launchState(base), 'ready')
  // 进程起来了但没探通 → pending（不能因为 pid 存在就说成功）
  assert.equal(launchState({ ...base, ready: false }), 'pending')
  // 探通了但没抓到带 token 的 URL → 仍是 pending（裸 URL 打开只会 401）
  assert.equal(launchState({ ...base, url: null }), 'pending')
  assert.equal(launchWarningKey('notReady'), 'profiles.launch.warn.notReady')
  assert.equal(launchWarningKey('urlNotFound'), 'profiles.launch.warn.urlNotFound')
})

test('formatProfileTime：合法时间戳本地格式 / null 与非法值空串', () => {
  const ms = new Date(2026, 0, 2, 3, 4).getTime()
  assert.equal(formatProfileTime(ms), '2026-01-02 03:04')
  assert.equal(formatProfileTime(null), '')
  assert.equal(formatProfileTime(Number.NaN), '')
})

test('suggestCopyName：默认 -copy，冲突顺延 -copy-2/-copy-3，且结果永远通过名字校验', () => {
  assert.equal(suggestCopyName('cmtest', []), 'cmtest-copy')
  assert.equal(suggestCopyName('cmtest', ['cmtest']), 'cmtest-copy')
  assert.equal(suggestCopyName('cmtest', ['cmtest-copy']), 'cmtest-copy-2')
  assert.equal(suggestCopyName('cmtest', ['cmtest-copy', 'cmtest-copy-2']), 'cmtest-copy-3')
  // 64 字上限：超长源名只截断前缀，不能让用户一打开弹窗就吃 tooLong
  const long = 'x'.repeat(64)
  const suggested = suggestCopyName(long, ['x'.repeat(59) + '-copy'])
  assert.ok(suggested.length <= 64, `建议名不得超过 64：${suggested}`)
  assert.equal(validateProfileNameInput(suggested), null, '建议名必须是合法档案名')
  assert.equal(long.length, 64)
})

test('profileInstallCommand / copyWarningKey：副本缺 node_modules 的自救路径', () => {
  assert.equal(profileInstallCommand('cmtest-copy'), 'dsh plugin --profile cmtest-copy install')
  assert.notEqual(profileInstallCommand('a'), restartCommand('a'), '安装命令与启动命令不是同一条')
  assert.equal(copyWarningKey('depsNotInstalled'), 'profiles.duplicate.warn.depsNotInstalled')
})

test('copyWarningKey：未映射的告警码暴露为 undefined，不再套用 depsNotInstalled 文案（P10-4）', () => {
  // 修复前 if + 兜底 return 同一字面量：任何入参都返回「缺 node_modules」文案，
  // 于是新增告警码会被静默显示成错误原因。这里用类型逃逸模拟「未来新增的码」。
  assert.equal(copyWarningKey('futureCode' as never), undefined, '未映射的码必须留白，而不是伪造原因')
  // 穷尽性由 Record 的键类型保证（新增 DshProfileCopyWarning 而漏配 ⇒ typecheck 失败），
  // 这里再锁一次机制本身：函数体只能是查表，不能退回手写兜底。
  const src = readFileSync(new URL('./dsh-profiles-view.ts', import.meta.url), 'utf8')
  assert.match(src, /const COPY_WARNING_KEY: Record<DshProfileCopyWarning, /, '映射表必须用 Record<告警码, …> 声明（穷尽性检查的来源）')
  assert.match(
    src,
    /export function copyWarningKey[^}]*\{\s*return COPY_WARNING_KEY\[warning\]\s*\}/,
    'copyWarningKey 只能是查表：任何 return 字面量兜底都会重新引入「所有码都说缺 node_modules」',
  )
})
test('formatBytes：B / KB / MB 与非法输入', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})
