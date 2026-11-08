/**
 * 仓库选择器纯逻辑测试（node:test，零依赖）。
 *
 * 覆盖：私有过滤与排序、地址归一化与「当前选中项」判定、选项组装、仓库名校验、
 * 建仓请求体（**不得带 private** —— 安全口径）、更新时间格式化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatRepoUpdatedAt, normalizeRepoUrl, repoCreateBody, repoNameError, repoPickerOptions,
  repoPickerRepos, repoPickerValueFor, repoShortName, shouldAutoLoadRepos, REPO_NAME_MAX_LENGTH,
  REPO_PICKER_CREATE_VALUE, type RepoPickerRepo,
} from './sync-repository-picker.ts'

function repo(fullName: string, over: Partial<RepoPickerRepo> = {}): RepoPickerRepo {
  return {
    fullName,
    cloneUrl: 'https://github.com/' + fullName + '.git',
    private: true,
    fork: false,
    pushedAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  }
}

test('repoPickerRepos：只留私有仓库（公开仓库绝不进选择器）', () => {
  const all = [repo('u/pub', { private: false }), repo('u/priv')]
  assert.deepEqual(repoPickerRepos(all).map((r) => r.fullName), ['u/priv'])
  assert.deepEqual(repoPickerRepos([]), [])
  assert.deepEqual(repoPickerRepos([repo('u/pub', { private: false })]), [])
})

test('repoPickerRepos：按 updatedAt 降序；时间未知排最后；不改动入参', () => {
  const all = [
    repo('u/old', { updatedAt: '2026-01-01T00:00:00Z' }),
    repo('u/unknown', { updatedAt: '' }),
    repo('u/new', { updatedAt: '2026-09-30T12:00:00Z' }),
    repo('u/bad', { updatedAt: '不是时间' }),
  ]
  assert.deepEqual(
    repoPickerRepos(all).map((r) => r.fullName),
    ['u/new', 'u/old', 'u/unknown', 'u/bad'],
  )
  // 原数组顺序不变（纯函数，不就地排序调用方的数组）
  assert.deepEqual(all.map((r) => r.fullName), ['u/old', 'u/unknown', 'u/new', 'u/bad'])
})

test('repoPickerRepos：时间相同的仓库保持原顺序（稳定排序）', () => {
  const all = [repo('u/a'), repo('u/b'), repo('u/c')]
  assert.deepEqual(repoPickerRepos(all).map((r) => r.fullName), ['u/a', 'u/b', 'u/c'])
})

test('repoShortName：去掉 owner 前缀；无斜杠时原样返回', () => {
  assert.equal(repoShortName('xiaojun/dsh-configs'), 'dsh-configs')
  assert.equal(repoShortName('bare'), 'bare')
})

test('normalizeRepoUrl：去空白/尾斜杠/.git 后缀，协议与主机小写，路径大小写保留', () => {
  assert.equal(normalizeRepoUrl('  https://github.com/u/r.git  '), 'https://github.com/u/r')
  assert.equal(normalizeRepoUrl('https://github.com/u/r/'), 'https://github.com/u/r')
  assert.equal(normalizeRepoUrl('https://github.com/u/r.git//'), 'https://github.com/u/r')
  assert.equal(normalizeRepoUrl('HTTPS://GitHub.com/u/MyRepo'), 'https://github.com/u/MyRepo')
  assert.equal(normalizeRepoUrl(''), '')
  // 非 https 形态（ssh / 本地路径）不猜、不破坏，原样返回
  assert.equal(normalizeRepoUrl('git@github.com:u/r.git'), 'git@github.com:u/r')
  assert.equal(normalizeRepoUrl('D:/backup/repo'), 'D:/backup/repo')
})

test('repoPickerValueFor：等价写法命中同一个 cloneUrl；未命中返回空串（显示为自定义地址）', () => {
  const repos = [repo('u/a'), repo('u/b')]
  const b = 'https://github.com/u/b.git'
  assert.equal(repoPickerValueFor(b, repos), b)
  assert.equal(repoPickerValueFor('https://github.com/u/b', repos), b)
  assert.equal(repoPickerValueFor('https://github.com/u/b/', repos), b)
  assert.equal(repoPickerValueFor('  https://GitHub.com/u/b.git  ', repos), b)
  assert.equal(repoPickerValueFor('https://github.com/u/other.git', repos), '')
  assert.equal(repoPickerValueFor('', repos), '')
  // 公开仓库不在选择器里 → 手填地址也不会被认成已选中项
  assert.equal(repoPickerValueFor('https://github.com/u/pub.git', [repo('u/pub', { private: false })]), '')
})

test('repoPickerOptions：私有仓库在前 + 末尾「新建」哨兵项，标签由调用方本地化', () => {
  const all = [repo('u/a', { updatedAt: '2026-09-02T00:00:00Z' }), repo('u/b', { updatedAt: '2026-09-03T00:00:00Z' })]
  const options = repoPickerOptions(all, (r, short) => short + '@' + r.updatedAt, '＋ 新建私有仓库…')
  assert.deepEqual(options.map((o) => o.value), [
    'https://github.com/u/b.git',
    'https://github.com/u/a.git',
    REPO_PICKER_CREATE_VALUE,
  ])
  assert.equal(options[0]?.label, 'b@2026-09-03T00:00:00Z')
  assert.equal(options[2]?.label, '＋ 新建私有仓库…')
  // 没有可用仓库时仍然能新建
  assert.deepEqual(repoPickerOptions([], () => 'x', '新建'), [{ value: REPO_PICKER_CREATE_VALUE, label: '新建' }])
})

test('repoNameError：空 / 超长 / 点开头 / 非法字符都被挡下，合法名放行', () => {
  assert.equal(repoNameError(''), 'empty')
  assert.equal(repoNameError('   '), 'empty')
  assert.equal(repoNameError('dsh-configs'), null)
  assert.equal(repoNameError('  dsh-configs  '), null)
  assert.equal(repoNameError('My.Repo_1-2'), null)
  assert.equal(repoNameError('.hidden'), 'invalid')
  assert.equal(repoNameError('has space'), 'invalid')
  assert.equal(repoNameError('中文仓库'), 'invalid')
  assert.equal(repoNameError('a/b'), 'invalid')
  assert.equal(repoNameError('x'.repeat(REPO_NAME_MAX_LENGTH)), null)
  assert.equal(repoNameError('x'.repeat(REPO_NAME_MAX_LENGTH + 1)), 'invalid')
})

test('repoCreateBody：trim 后组装；描述为空则整个字段不传；**不带 private**（安全口径）', () => {
  const bare = repoCreateBody('  my-repo  ', '   ')
  assert.deepEqual(bare, { name: 'my-repo' })
  assert.ok(!('description' in bare))
  // 宿主恒定以 private:true 建仓；客户端连「公开」这个意图都不该能表达
  assert.ok(!('private' in bare))

  const withDesc = repoCreateBody('my-repo', '  我的配置仓库  ')
  assert.deepEqual(withDesc, { name: 'my-repo', description: '我的配置仓库' })
  assert.ok(!('private' in withDesc))
})

test('formatRepoUpdatedAt：空串→空串，非法→原样，合法→本地时间串', () => {
  assert.equal(formatRepoUpdatedAt(''), '')
  assert.equal(formatRepoUpdatedAt('不是时间'), '不是时间')
  const shown = formatRepoUpdatedAt('2026-09-30T10:00:00Z', 'en-US')
  assert.ok(shown.includes('2026'), '应包含年份，实际：' + shown)
  assert.ok(!shown.includes('Invalid'), '绝不显示 Invalid Date，实际：' + shown)
})

/* ---------- 仓库列表的自动加载判定（2026-11-08 用户反馈：登录成功后列表不出现、必须手点下拉） */

/** 基线：弹窗打开、未登录、地址为空、什么都没加载过 */
const autoBase = {
  open: true,
  signedIn: null as boolean | null,
  loaded: false,
  loading: false,
  failed: false,
  repoUrl: '',
}

test('shouldAutoLoadRepos：登录成功（signedIn true）即自动加载 —— 用户不必再点开下拉', () => {
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true }), true)
  // 已登录 + 表单里已有地址同样自动加载（保持既有行为）
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true, repoUrl: 'https://github.com/u/r.git' }), true)
})

test('shouldAutoLoadRepos：未登录且地址为空 → 不加载（必然 401，白跑网络）', () => {
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: null }), false)
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: false }), false)
  // 未登录但地址已填：照旧自动拉（既有行为，可能与手填的 token 一起生效）
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: false, repoUrl: '  https://github.com/u/r.git ' }), true)
})

test('shouldAutoLoadRepos：弹窗关闭 / 已加载 / 加载中 / 失败后 → 一律不重复发请求', () => {
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true, open: false }), false)
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true, loaded: true }), false)
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true, loading: true }), false)
  // 失败不自动重试：否则每次重渲染都会打一次必然失败的请求（重试走「刷新列表」或登录态复位）
  assert.equal(shouldAutoLoadRepos({ ...autoBase, signedIn: true, failed: true }), false)
})
