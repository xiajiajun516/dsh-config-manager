/**
 * m-market-publish：发布向导纯渲染/校验模型单测（node 可测，零依赖）。
 *
 * 覆盖：5 步模型、repoUrl 轻量校验（可选字段 + http(s) + 无 userinfo）、
 * 表单校验（itemId 过 SAFE_ITEM_ID_RE / name 必填）、git 命令模板渲染、
 * index.json 收录片段（JSON.parse 可过）、步骤状态机（canProceed/nextStepId/prevStepId）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { zhUiT, makeUiT } from './i18n.ts'
import {
  buildGitPushCommands, buildIndexEntrySnippet, canProceed, EMPTY_PUBLISH_FORM,
  INITIAL_PUBLISH_STATE, nextStepId, prevStepId, PUBLISH_STEP_IDS, publishFormValid,
  publishSteps, validatePublishForm, validatePublishRepoUrl,
} from './market-publish.ts'
import type { PublishFormFields, PublishProgressState } from './market-publish.ts'

/* ---------------------------------------------------------------- 步骤模型 */

test('market-publish: publishSteps 5 步且顺序为 select→validate→prepare→push→submit', () => {
  const steps = publishSteps(zhUiT)
  assert.deepEqual(
    steps.map((s) => s.id),
    ['select', 'validate', 'prepare', 'push', 'submit'],
  )
  assert.equal(steps.length, 5)
  assert.deepEqual(PUBLISH_STEP_IDS, ['select', 'validate', 'prepare', 'push', 'submit'])
})

test('market-publish: publishSteps 标题走 i18n 字典（zh/en 均渲染，不硬编码）', () => {
  const zh = publishSteps(zhUiT)
  assert.match(zh[0]?.title ?? '', /选择配置包/)
  assert.match(zh[4]?.title ?? '', /提交收录申请/)
  const en = publishSteps(makeUiT('en'))
  assert.match(en[0]?.title ?? '', /Select config package/)
  assert.match(en[4]?.title ?? '', /Submit listing request/)
})

/* ---------------------------------------------------------------- repoUrl 校验 */

test('market-publish: validatePublishRepoUrl 可选字段 —— 空串/空白视为未填（合法）', () => {
  assert.equal(validatePublishRepoUrl('', zhUiT), null)
  assert.equal(validatePublishRepoUrl('   ', zhUiT), null)
})

test('market-publish: validatePublishRepoUrl 合法 https/http 通过', () => {
  assert.equal(validatePublishRepoUrl('https://github.com/alice/dsh-items.git', zhUiT), null)
  assert.equal(validatePublishRepoUrl('http://example.com/items.git', zhUiT), null)
})

test('market-publish: validatePublishRepoUrl 非 http(s) 拒绝（git@/ftp 等形态）', () => {
  assert.match(validatePublishRepoUrl('git@github.com:alice/items.git', zhUiT) ?? '', /http\(s\)/)
  assert.match(validatePublishRepoUrl('ftp://example.com/items.git', zhUiT) ?? '', /http\(s\)/)
  assert.match(validatePublishRepoUrl('ssh://git@example.com/items.git', zhUiT) ?? '', /http\(s\)/)
})

test('market-publish: validatePublishRepoUrl 拒绝 userinfo（username:pass@ 与 username@）', () => {
  assert.match(
    validatePublishRepoUrl('https://user:token@github.com/alice/items.git', zhUiT) ?? '',
    /userinfo/,
  )
  assert.match(
    validatePublishRepoUrl('https://user@github.com/alice/items.git', zhUiT) ?? '',
    /userinfo/,
  )
})

test('market-publish: validatePublishRepoUrl 拒绝空白字符', () => {
  assert.match(
    validatePublishRepoUrl('https://github.com/alice/a b.git', zhUiT) ?? '',
    /空白/,
  )
})

/* ---------------------------------------------------------------- 表单校验 */

function form(overrides: Partial<PublishFormFields>): PublishFormFields {
  return { ...EMPTY_PUBLISH_FORM, ...overrides }
}

test('market-publish: validatePublishForm 空表单 → itemId/name 错误、repoUrl 合法（可选）', () => {
  const errs = validatePublishForm(EMPTY_PUBLISH_FORM, zhUiT)
  assert.notEqual(errs.itemId, null)
  assert.notEqual(errs.name, null)
  assert.equal(errs.repoUrl, null, 'repoUrl 为空 = 未填 = 合法（可选字段）')
  assert.equal(publishFormValid(errs), false)
})

test('market-publish: validatePublishForm 合法表单 → 全 null、publishFormValid=true', () => {
  const errs = validatePublishForm(
    form({
      itemId: 'my-settings',
      name: '我的设置包',
      repoUrl: 'https://github.com/alice/dsh-items.git',
    }),
    zhUiT,
  )
  assert.deepEqual(errs, { itemId: null, name: null, repoUrl: null })
  assert.equal(publishFormValid(errs), true)
})

test('market-publish: validatePublishForm itemId 过 SAFE_ITEM_ID_RE（合法形态通过）', () => {
  for (const id of ['my-settings', 'My_Settings.1', 'a1', 'settings-v2']) {
    assert.equal(validatePublishForm(form({ itemId: id, name: 'x' }), zhUiT).itemId, null, `${id} 应合法`)
  }
})

test('market-publish: validatePublishForm itemId 非法形态拒绝（路径穿越/空白/斜杠/非 ASCII）', () => {
  for (const id of ['../evil', 'a b', 'a/b', '中文id', '-lead', '.dot', '']) {
    assert.notEqual(validatePublishForm(form({ itemId: id, name: 'x' }), zhUiT).itemId, null, `${JSON.stringify(id)} 应拒绝`)
  }
})

test('market-publish: validatePublishForm name 空白拒绝', () => {
  assert.notEqual(validatePublishForm(form({ itemId: 'ok', name: '  ' }), zhUiT).name, null)
})

/* ---------------------------------------------------------------- git 命令模板 */

test('market-publish: buildGitPushCommands 命令序列（clone→cd→mkdir→复制→add→commit→push）', () => {
  const cmds = buildGitPushCommands({
    repoUrl: 'https://github.com/alice/dsh-items.git',
    itemId: 'my-settings',
    dir: 'dsh-items',
  })
  assert.equal(cmds.length, 7)
  assert.equal(cmds[0], 'git clone https://github.com/alice/dsh-items.git dsh-items')
  assert.equal(cmds[1], 'cd dsh-items')
  assert.equal(cmds[2], 'mkdir -p items/my-settings')
  assert.equal(cmds[3], 'cp -r ../dist/items/my-settings/. items/my-settings/')
  assert.equal(cmds[4], 'git add items/my-settings')
  assert.equal(cmds[5], 'git commit -m "publish my-settings"')
  assert.equal(cmds[6], 'git push origin HEAD')
})

test('market-publish: buildGitPushCommands 注入 repoUrl/itemId/dir 且不携带凭据字段', () => {
  const cmds = buildGitPushCommands({
    repoUrl: 'https://github.com/bob/items.git',
    itemId: 'bob-pack',
    dir: 'repo',
  })
  const joined = cmds.join('\n')
  assert.match(joined, /https:\/\/github\.com\/bob\/items\.git/)
  assert.match(joined, /bob-pack/)
  assert.ok(!joined.includes('token') && !joined.includes('@'), '命令模板不应包含任何凭据/用户名')
})

/* ---------------------------------------------------------------- index 收录片段 */

test('market-publish: buildIndexEntrySnippet 输出合法 JSON（JSON.parse 可过）且含必填字段', () => {
  const text = buildIndexEntrySnippet({
    id: 'my-settings',
    name: '我的设置包',
    repo: 'https://github.com/alice/dsh-items.git',
  })
  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.equal(parsed['id'], 'my-settings')
  assert.equal(parsed['name'], '我的设置包')
  assert.equal(parsed['repo'], 'https://github.com/alice/dsh-items.git')
})

test('market-publish: buildIndexEntrySnippet 可选字段按填入选入、空白省略', () => {
  const text = buildIndexEntrySnippet({
    id: 'a',
    name: 'x',
    author: 'alice',
    version: '2.0.0',
    updatedAt: '2026-08-19T00:00:00.000Z',
    categories: ['settings', 'plugins'],
    repo: 'https://github.com/alice/items.git',
    description: '  描述  ',
  })
  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.deepEqual(parsed['categories'], ['settings', 'plugins'])
  assert.equal(parsed['author'], 'alice')
  assert.equal(parsed['description'], '描述', 'description 应 trim')
  assert.equal(parsed['version'], '2.0.0')
  assert.equal(parsed['updatedAt'], '2026-08-19T00:00:00.000Z')
  const minimal = JSON.parse(
    buildIndexEntrySnippet({
      id: 'b',
      name: 'y',
      description: '   ',
      version: '',
      repo: 'https://github.com/alice/items.git',
    }),
  ) as Record<string, unknown>
  assert.equal(minimal['description'], undefined, '空白 description 不写入')
  assert.equal(minimal['version'], undefined, '空 version 不写入')
})

/* ---------------------------------------------------------------- 步骤状态机 */

test('market-publish: nextStepId/prevStepId 线性导航（端点返回 null）', () => {
  assert.equal(nextStepId('select'), 'validate')
  assert.equal(nextStepId('validate'), 'prepare')
  assert.equal(nextStepId('prepare'), 'push')
  assert.equal(nextStepId('push'), 'submit')
  assert.equal(nextStepId('submit'), null)
  assert.equal(prevStepId('submit'), 'push')
  assert.equal(prevStepId('select'), null)
})

test('market-publish: canProceed 按进度标记门控（select 须选 zip / validate 须过校验 / prepare 须已生成）', () => {
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'select', zipSelected: false }), false)
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'select', zipSelected: true }), true)
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'validate', validated: false }), false)
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'validate', validated: true }), true)
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'prepare', prepared: false }), false)
  assert.equal(canProceed({ ...INITIAL_PUBLISH_STATE, step: 'prepare', prepared: true }), true)
})

test('market-publish: canProceed push 默认可前进（引导页无硬性前置）、submit 恒 false', () => {
  const push: PublishProgressState = { ...INITIAL_PUBLISH_STATE, step: 'push' }
  assert.equal(canProceed(push), true)
  const submit: PublishProgressState = { ...INITIAL_PUBLISH_STATE, step: 'submit' }
  assert.equal(canProceed(submit), false)
})
