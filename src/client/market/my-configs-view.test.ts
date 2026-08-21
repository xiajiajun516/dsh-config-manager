/**
 * m-my-configs-view：我的配置客户端纯渲染装配层单测（纯函数，node 可测，无需 DOM）。
 *
 * 覆盖：登录状态推导（未登录 / 已登录 @login / token 失效）、上传表单校验（名称必填 +
 * 类别解析 + 系统自动字段徽章）、条目投影（字段缺失兜底）、收录状态三态推导
 * （未收录 / PR 待审核 / 已收录，已收录 > PR 待审核 > 未收录）、列表装配与摘要、
 * 徽章模板（kind + 文案 + PR 链接）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeUiT, zhUiT } from '../../ui/i18n.ts'
import {
  autoFieldBadges, buildMyItemsView, deriveItemStatus, deriveLoginState, itemStatusBadge,
  itemStatusFromHost, MARKET_SYNC_PR_BRANCH_PREFIX, MY_CONFIG_AUTO_FIELDS, myConfigFormValid,
  parseCategories, prBranchFor, summarizeMyItems, toMyItemView, validateMyConfigForm,
  EMPTY_MY_CONFIG_FORM, EMPTY_MY_WIZARD, initialWizard, restoreMyWizard, toMyWizardSlice,
} from './my-configs-view.ts'
import type { ItemStatus, MeStatusData, MyItemSource, MyUploadResult, MyWizardSlice, MyWizardState, OpenPrInfo } from './my-configs-view.ts'

/* ---------------------------------------------------------------- 登录状态推导 */

function meStatus(overrides: Partial<MeStatusData>): MeStatusData {
  return { loggedIn: false, ...overrides }
}

test('my-configs-view: deriveLoginState loading 优先（即使有 status 也不展示）', () => {
  const v = deriveLoginState({ loading: true, status: meStatus({ loggedIn: true, login: 'alice' }), authFailed: false })
  assert.deepEqual(v, { kind: 'loading' })
})

test('my-configs-view: deriveLoginState 未登录（status.loggedIn=false / null）→ logged-out', () => {
  assert.deepEqual(deriveLoginState({ loading: false, status: meStatus({ loggedIn: false }), authFailed: false }), { kind: 'logged-out' })
  assert.deepEqual(deriveLoginState({ loading: false, status: null, authFailed: false }), { kind: 'logged-out' })
})

test('my-configs-view: deriveLoginState 已登录 → logged-in（带 login/repoUrl/repoExists）', () => {
  const v = deriveLoginState({
    loading: false,
    status: meStatus({ loggedIn: true, login: 'alice', repoUrl: 'https://github.com/alice/dsh-configs', repoExists: true }),
    authFailed: false,
  })
  assert.deepEqual(v, {
    kind: 'logged-in',
    login: 'alice',
    repoUrl: 'https://github.com/alice/dsh-configs',
    repoExists: true,
  })
})

test('my-configs-view: deriveLoginState 已登录但字段缺失 → 空串/false 兜底', () => {
  const v = deriveLoginState({ loading: false, status: meStatus({ loggedIn: true }), authFailed: false })
  assert.deepEqual(v, { kind: 'logged-in', login: '', repoUrl: '', repoExists: false })
})

test('my-configs-view: deriveLoginState authFailed（401）→ token-invalid（优先于已登录/未登录）', () => {
  assert.deepEqual(
    deriveLoginState({ loading: false, status: meStatus({ loggedIn: true, login: 'alice' }), authFailed: true }),
    { kind: 'token-invalid' },
  )
  assert.deepEqual(deriveLoginState({ loading: false, status: null, authFailed: true }), { kind: 'token-invalid' })
})

/* ---------------------------------------------------------------- 上传表单校验 */

test('my-configs-view: validateMyConfigForm 名称必填（空 / 纯空白 → 错误）', () => {
  const t = makeUiT('zh')
  assert.equal(validateMyConfigForm({ ...EMPTY_MY_CONFIG_FORM, name: '' }, t).name, '名称不能为空')
  assert.equal(validateMyConfigForm({ ...EMPTY_MY_CONFIG_FORM, name: '   ' }, t).name, '名称不能为空')
})

test('my-configs-view: validateMyConfigForm 名称合法（trim 后非空）→ 无错误', () => {
  const errs = validateMyConfigForm({ ...EMPTY_MY_CONFIG_FORM, name: ' 我的配置 ' })
  assert.equal(errs.name, null)
})

test('my-configs-view: myConfigFormValid 聚合（name 合法 = 表单合法；描述/类别可选不阻塞）', () => {
  assert.equal(myConfigFormValid({ name: null }), true)
  assert.equal(myConfigFormValid({ name: '名称不能为空' }), false)
})

test('my-configs-view: parseCategories 逗号分隔去空白（空串 → 空数组）', () => {
  assert.deepEqual(parseCategories(''), [])
  assert.deepEqual(parseCategories('  ,  ,  '), [])
  assert.deepEqual(parseCategories('plugins, agents '), ['plugins', 'agents'])
  assert.deepEqual(parseCategories(' a ,b,c '), ['a', 'b', 'c'])
})

test('my-configs-view: autoFieldBadges 覆盖 4 个系统自动字段（id/author/version/updatedAt）', () => {
  assert.deepEqual([...MY_CONFIG_AUTO_FIELDS], ['id', 'author', 'version', 'updatedAt'])
  const t = makeUiT('zh')
  const badges = autoFieldBadges(t)
  assert.deepEqual(badges.map((b) => b.field), ['id', 'author', 'version', 'updatedAt'])
  for (const b of badges) {
    assert.equal(b.autoText, '系统自动')
    assert.ok(b.label.length > 0)
  }
})

test('my-configs-view: autoFieldBadges en 镜像（label 与 autoText 均英文）', () => {
  const t = makeUiT('en')
  const badges = autoFieldBadges(t)
  assert.equal(badges[0]?.autoText, 'Auto')
  const labels = badges.map((b) => b.label)
  assert.deepEqual(labels, ['Item ID', 'Author', 'Version', 'Updated'])
})

/* ---------------------------------------------------------------- 收录状态推导 */

function item(overrides: Partial<MyItemSource> & { id: string }): MyItemSource {
  return { name: overrides.id, ...overrides }
}

function openPr(overrides: Partial<OpenPrInfo> & { number: number }): OpenPrInfo {
  return { url: `https://github.com/xiajiajun516/dsh-config-market/pull/${overrides.number}`, head: `dsh-market-sync/${overrides.number}`, ...overrides }
}

test('my-configs-view: deriveItemStatus 官方已收录 → listed（即便存在 open PR 也以收录为准）', () => {
  const st = deriveItemStatus({
    item: item({ id: 'cfg-a' }),
    officialListed: true,
    openPr: openPr({ number: 12 }),
  })
  assert.deepEqual(st, { kind: 'listed' })
})

test('my-configs-view: deriveItemStatus 未收录但有 open PR（head 匹配）→ pending-pr（带编号与链接）', () => {
  const st = deriveItemStatus({
    item: item({ id: 'cfg-b' }),
    officialListed: false,
    openPr: openPr({ number: 7, head: 'dsh-market-sync/cfg-b', url: 'https://github.com/x/pr/7' }),
  })
  assert.deepEqual(st, { kind: 'pending-pr', prNumber: 7, prUrl: 'https://github.com/x/pr/7' })
})

test('my-configs-view: deriveItemStatus 未收录且无 open PR → not-listed（本地独有）', () => {
  const st = deriveItemStatus({ item: item({ id: 'cfg-c' }), officialListed: false, openPr: null })
  assert.deepEqual(st, { kind: 'not-listed' })
})

test('my-configs-view: PR 固定分支约定（§2.4）prBranchFor = dsh-market-sync/<itemId>', () => {
  assert.equal(MARKET_SYNC_PR_BRANCH_PREFIX, 'dsh-market-sync/')
  assert.equal(prBranchFor('cfg-a'), 'dsh-market-sync/cfg-a')
  assert.equal(prBranchFor('my-config'), 'dsh-market-sync/my-config')
})

/* ---------------------------------------------------------------- Host 侧状态桥 */

test('my-configs-view: itemStatusFromHost 三态映射（Host MyItemStatus 字符串 → 客户端判别联合）', () => {
  assert.deepEqual(itemStatusFromHost({ status: 'listed' }), { kind: 'listed' })
  assert.deepEqual(itemStatusFromHost({ status: 'not-listed' }), { kind: 'not-listed' })
  assert.deepEqual(
    itemStatusFromHost({ status: 'pr-pending', prUrl: 'https://github.com/x/pr/7' }),
    { kind: 'pending-pr', prUrl: 'https://github.com/x/pr/7', prNumber: undefined },
  )
})

test('my-configs-view: itemStatusFromHost pr-pending 无 prUrl → 空串兜底（徽章仍可渲染）', () => {
  const st = itemStatusFromHost({ status: 'pr-pending' })
  assert.deepEqual(st, { kind: 'pending-pr', prUrl: '', prNumber: undefined })
  // 经徽章模板仍出文本（PR 待审核），链接缺省不炸
  const badge = itemStatusBadge(st)
  assert.equal(badge.kind, 'warn')
  assert.equal(badge.text, 'PR 待审核')
})

test('my-configs-view: itemStatusFromHost + toMyItemView 组合投影（Host 条目 → 视图行）', () => {
  const view = toMyItemView(
    { id: 'cfg-a', name: '我的配置', version: '1.0.0', categories: ['plugins'], author: 'alice' },
    itemStatusFromHost({ status: 'pr-pending', prUrl: 'https://github.com/x/pr/3' }),
  )
  assert.equal(view.name, '我的配置')
  assert.deepEqual(view.status, { kind: 'pending-pr', prUrl: 'https://github.com/x/pr/3', prNumber: undefined })
  assert.equal(view.badge.kind, 'warn')
  assert.equal(view.badge.prUrl, 'https://github.com/x/pr/3')
})

/* ---------------------------------------------------------------- 条目投影 */

test('my-configs-view: toMyItemView 全字段透传（name/version/updatedAt/categories/author）', () => {
  const v = toMyItemView(
    item({ id: 'cfg-a', name: '我的配置', version: '1.2.0', updatedAt: '2026-08-20T10:00:00.000Z', categories: ['plugins'], author: 'alice' }),
    { kind: 'listed' },
  )
  assert.equal(v.id, 'cfg-a')
  assert.equal(v.name, '我的配置')
  assert.equal(v.version, '1.2.0')
  assert.equal(v.updatedAt, '2026-08-20T10:00:00.000Z')
  assert.deepEqual(v.categories, ['plugins'])
  assert.equal(v.author, 'alice')
})

test('my-configs-view: toMyItemView 字段缺失兜底（name 回退 id；其余空串/空数组）', () => {
  const v = toMyItemView(item({ id: 'cfg-a' }), { kind: 'not-listed' })
  assert.equal(v.name, 'cfg-a', 'name 缺省回退 id')
  assert.equal(v.version, '')
  assert.equal(v.updatedAt, '')
  assert.deepEqual(v.categories, [])
  assert.equal(v.author, '')
})

test('my-configs-view: toMyItemView name 纯空白也回退 id', () => {
  const v = toMyItemView(item({ id: 'cfg-a', name: '  ' }), { kind: 'not-listed' })
  assert.equal(v.name, 'cfg-a')
})

/* ---------------------------------------------------------------- 徽章模板 */

test('my-configs-view: itemStatusBadge 三态 → 语义 kind（ok=已收录 / warn=PR 待审核 / info=未收录）', () => {
  const listed = itemStatusBadge({ kind: 'listed' })
  assert.equal(listed.kind, 'ok')
  assert.equal(listed.text, '已收录')
  const pending = itemStatusBadge({ kind: 'pending-pr', prNumber: 3, prUrl: 'https://github.com/x/pr/3' })
  assert.equal(pending.kind, 'warn')
  assert.equal(pending.text, 'PR 待审核')
  assert.equal(pending.prUrl, 'https://github.com/x/pr/3')
  assert.equal(pending.prNumber, 3)
  const none = itemStatusBadge({ kind: 'not-listed' })
  assert.equal(none.kind, 'info')
  assert.equal(none.text, '未收录')
})

test('my-configs-view: itemStatusBadge en 镜像（kind 不变，文案英文）', () => {
  const t = makeUiT('en')
  assert.equal(itemStatusBadge({ kind: 'listed' }, t).text, 'Listed')
  assert.equal(itemStatusBadge({ kind: 'pending-pr', prNumber: 1, prUrl: 'https://x/1' }, t).text, 'PR pending review')
  assert.equal(itemStatusBadge({ kind: 'not-listed' }, t).text, 'Not listed')
})

/* ---------------------------------------------------------------- 列表装配与摘要 */

test('my-configs-view: buildMyItemsView 空列表 → 空数组（边界）', () => {
  assert.deepEqual(buildMyItemsView({ items: [], officialListedIds: new Set(), openPrs: [] }), [])
})

test('my-configs-view: buildMyItemsView 混合状态按 officialListedIds + openPr head 分支推导', () => {
  const views = buildMyItemsView({
    items: [
      item({ id: 'a', name: 'A' }),
      item({ id: 'b', name: 'B' }),
      item({ id: 'c', name: 'C' }),
    ],
    officialListedIds: new Set(['a']),
    openPrs: [openPr({ number: 1, head: 'dsh-market-sync/b' })],
  })
  assert.equal(views.length, 3)
  assert.deepEqual(views[0]?.status, { kind: 'listed' })
  assert.deepEqual(views[1]?.status, { kind: 'pending-pr', prNumber: 1, prUrl: 'https://github.com/xiajiajun516/dsh-config-market/pull/1' })
  assert.deepEqual(views[2]?.status, { kind: 'not-listed' })
  // 徽章文本随之
  assert.equal(views[0]?.badge.text, '已收录')
  assert.equal(views[1]?.badge.kind, 'warn')
})

test('my-configs-view: buildMyItemsView open PR head 分支不匹配 → 仍视为未收录', () => {
  const views = buildMyItemsView({
    items: [item({ id: 'x', name: 'X' })],
    officialListedIds: new Set(),
    openPrs: [openPr({ number: 9, head: 'dsh-market-sync/other' })],
  })
  assert.deepEqual(views[0]?.status, { kind: 'not-listed' })
})

test('my-configs-view: summarizeMyItems 统计（空 → 全零；混合 → 分类计数）', () => {
  assert.deepEqual(summarizeMyItems([]), { total: 0, listed: 0, pendingPr: 0, notListed: 0 })
  const views = buildMyItemsView({
    items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })],
    officialListedIds: new Set(['a', 'b']),
    openPrs: [openPr({ number: 1, head: 'dsh-market-sync/c' })],
  })
  assert.deepEqual(summarizeMyItems(views), { total: 4, listed: 2, pendingPr: 1, notListed: 1 })
})

test('my-configs-view: 引用 zhUiT 默认参数路径（makeUiT 之外的同语义断言）', () => {
  // zhUiT 是 makeUiT('zh') 的实例，行为一致；直接经导出函数默认参数走通
  assert.equal(itemStatusBadge({ kind: 'listed' }, zhUiT).text, '已收录')
  assert.equal(validateMyConfigForm({ ...EMPTY_MY_CONFIG_FORM, name: ' ' }, zhUiT).name, '名称不能为空')
})

/* ---------------------------------------------------------------- 判别联合形状（编译期约束） */

function statusKindOf(s: ItemStatus): string {
  return s.kind
}
test('my-configs-view: ItemStatus 判别联合可判别（编译期形状约束）', () => {
  assert.equal(statusKindOf({ kind: 'listed' }), 'listed')
  assert.equal(statusKindOf({ kind: 'pending-pr', prNumber: 1, prUrl: 'u' }), 'pending-pr')
  assert.equal(statusKindOf({ kind: 'not-listed' }), 'not-listed')
})

/* ---------------------------------------------------------------- 向导状态模型 */

/** UploadResult 夹具（对齐 host 半 my-repo.ts 形状；listing 必填）。 */
function uploadResult(overrides: Partial<MyUploadResult> = {}): MyUploadResult {
  return {
    ok: true,
    itemId: 'my-config',
    version: '1.0.0',
    sha256: 'sha256-abc',
    sections: ['settings'],
    repoUrl: 'https://github.com/xiaojun/dsh-configs',
    prNumber: null,
    prUrl: null,
    warnings: ['供应链警示'],
    listing: 'pending',
    ...overrides,
  }
}

function wizard(overrides: Partial<MyWizardState> = {}): MyWizardState {
  return {
    mode: 'upload',
    step: 'select',
    zipPath: null,
    fileName: null,
    validating: false,
    validated: false,
    validationError: null,
    form: { ...EMPTY_MY_CONFIG_FORM },
    formErrors: { name: null },
    running: false,
    result: null,
    error: null,
    ...overrides,
  }
}

test('my-configs-view: toMyWizardSlice 去掉瞬态字段（validating/running/formErrors 不出现）、保留 validated', () => {
  const w = wizard({
    mode: 'update',
    step: 'form',
    zipPath: 'C:\\tmp\\upload-abc.zip',
    fileName: 'cfg.zip',
    validating: true,
    validated: true,
    validationError: null,
    form: { name: 'My Config', description: 'desc', categories: 'a, b', id: 'my-config' },
    formErrors: { name: null },
    running: true,
    result: uploadResult(),
    error: null,
  })
  const s = toMyWizardSlice(w)
  assert.equal(s.mode, 'update')
  assert.equal(s.step, 'form')
  assert.equal(s.zipPath, 'C:\\tmp\\upload-abc.zip')
  assert.equal(s.fileName, 'cfg.zip')
  assert.equal(s.validated, true, 'validated 保留（已校验通过状态值得持久化）')
  assert.equal(s.validationError, null)
  assert.deepEqual(s.form, { name: 'My Config', description: 'desc', categories: 'a, b', id: 'my-config' })
  assert.equal(s.result, w.result, 'result 为纯 JSON 直接引用')
  assert.equal(s.error, null)
  // 瞬态/派生字段不进入切片
  assert.ok(!('validating' in s), 'validating 不得进入切片')
  assert.ok(!('running' in s), 'running 不得进入切片')
  assert.ok(!('formErrors' in s), 'formErrors 不得进入切片（恢复时重算）')
})

test('my-configs-view: restoreMyWizard(null) → EMPTY 语义（step select、瞬态归零、formErrors 无错）', () => {
  const w = restoreMyWizard(null)
  assert.equal(w.mode, 'upload')
  assert.equal(w.step, 'select')
  assert.equal(w.zipPath, null)
  assert.equal(w.fileName, null)
  assert.equal(w.validating, false)
  assert.equal(w.validated, false)
  assert.equal(w.validationError, null)
  assert.deepEqual(w.form, EMPTY_MY_CONFIG_FORM)
  assert.deepEqual(w.formErrors, { name: null })
  assert.equal(w.running, false)
  assert.equal(w.result, null)
  assert.equal(w.error, null)
  // 返回新对象，不共享 EMPTY_MY_WIZARD / EMPTY_MY_CONFIG_FORM 引用
  assert.notEqual(w, EMPTY_MY_WIZARD)
  assert.notEqual(w.form, EMPTY_MY_CONFIG_FORM)
})

test('my-configs-view: restoreMyWizard(slice) → 瞬态归零、formErrors 按 form.name 重算、其余字段一致', () => {
  const slice: MyWizardSlice = {
    mode: 'update',
    step: 'form',
    zipPath: 'C:\\tmp\\upload-abc.zip',
    fileName: 'cfg.zip',
    validated: true,
    validationError: null,
    form: { name: 'My Config', description: '', categories: '', id: 'my-config' },
    result: uploadResult(),
    error: null,
  }
  const w = restoreMyWizard(slice)
  assert.equal(w.mode, 'update')
  assert.equal(w.step, 'form')
  assert.equal(w.zipPath, slice.zipPath)
  assert.equal(w.fileName, 'cfg.zip')
  assert.equal(w.validating, false, 'validating 恢复后恒 false')
  assert.equal(w.running, false, 'running 恢复后恒 false')
  assert.equal(w.validated, true, 'validated 从切片保留')
  assert.deepEqual(w.form, slice.form)
  assert.deepEqual(w.formErrors, { name: null }, 'form.name 合法 → 无错误')
  assert.equal(w.result, slice.result)
  assert.equal(w.error, null)
  assert.notEqual(w.form, slice.form, 'form 为新对象，不共享切片引用')
  // form.name 为空 → formErrors.name 重算为非 null
  const w2 = restoreMyWizard({ ...slice, form: { ...slice.form, name: '   ' } })
  assert.notEqual(w2.formErrors.name, null, '空白名称 → 重算出错误')
  assert.equal(w2.formErrors.name, validateMyConfigForm({ ...slice.form, name: '   ' }).name)
})

test('my-configs-view: initialWizard(mode) → 指定模式、step select、空表单', () => {
  const w = initialWizard('update')
  assert.equal(w.mode, 'update')
  assert.equal(w.step, 'select')
  assert.deepEqual(w.form, EMPTY_MY_CONFIG_FORM)
  assert.deepEqual(w.formErrors, { name: null })
  assert.equal(w.zipPath, null)
  assert.equal(w.result, null)
  assert.equal(w.validating, false)
  assert.equal(w.running, false)
  assert.notEqual(w, EMPTY_MY_WIZARD, '每次返回新对象')
  assert.notEqual(w.form, EMPTY_MY_CONFIG_FORM, 'form 为新对象')
  const u = initialWizard('upload')
  assert.equal(u.mode, 'upload')
  assert.equal(u.step, 'select')
})