/**
 * DSH profile 管理引擎单测（真实临时目录；引擎直接读写 `<home>/profiles/<name>`）。
 *
 * 覆盖：list（跳过 node_modules / 未初始化目录 / 损坏 manifest）、create（脚手架与
 * dsh-app-boot 的 initProfile 等价）、rename（含 name 字段与 selection 跟随）、
 * remove（物理删 + selection 清理 + 当前 profile 保护）、selection 读写清、
 * 名字校验与保留名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DshProfileManager, DshProfileError } from './dsh-profile-manager.ts'
import {
  DSH_PROFILE_TEMPLATES, RESERVED_PROFILE_NAMES, checkProfileName, classifyShape,
} from './dsh-profile-shared.ts'

function makeManager(opts: { current?: string } = {}): { mgr: DshProfileManager; home: string; data: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dspm-'))
  const home = join(root, 'home')
  const data = join(root, 'data')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  mkdirSync(data, { recursive: true })
  const mgr = new DshProfileManager({
    homeDir: home,
    dataDir: data,
    currentProfile: () => opts.current ?? 'web',
  })
  return { mgr, home, data, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
}

test('checkProfileName：空名/穿越/保留名一律拒绝，普通名通过', () => {
  assert.equal(checkProfileName(''), 'invalidNameInput')
  assert.equal(checkProfileName('   '), 'invalidNameInput')
  assert.equal(checkProfileName('..'), 'invalidNameInput')
  assert.equal(checkProfileName('a/b'), 'invalidNameInput')
  assert.equal(checkProfileName('a\\b'), 'invalidNameInput')
  assert.equal(checkProfileName('node_modules'), 'invalidNameInput')
  assert.equal(checkProfileName('x'.repeat(65)), 'invalidNameInput')
  assert.equal(checkProfileName('work'), null)
  for (const reserved of RESERVED_PROFILE_NAMES) {
    assert.equal(checkProfileName(reserved), 'reservedName', reserved)
  }
})

test('classifyShape：按 bundles 判定 web / headless / generic', () => {
  assert.equal(classifyShape(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']), 'web')
  assert.equal(classifyShape(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']), 'headless')
  assert.equal(classifyShape(['@deepseek-ai/dsh-base', 'dsh-mnemon']), 'generic')
  assert.equal(classifyShape([]), 'generic')
})

test('list：空 profiles 目录 → []', () => {
  const { mgr, cleanup } = makeManager()
  try {
    assert.deepEqual(mgr.list(), [])
  } finally {
    cleanup()
  }
})

test('create：脚手架三文件 + bundles/patchReload 与模板一致（等价 initProfile）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const meta = mgr.create('work', 'base')
    const dir = join(home, 'profiles', 'work')
    assert.deepEqual(meta.bundles, ['@deepseek-ai/dsh-base'])
    assert.equal(meta.patchReload, 'live')
    assert.equal(meta.shape, 'generic')
    assert.equal(meta.hasNodeModules, false)
    assert.equal(meta.patchEntryCount, 0)
    assert.deepEqual(meta.issues, [])

    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(manifest, {
      name: 'dsh-profile-work',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
    })
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(patch.startsWith('# Your patch layer for this dsh profile'), patch.slice(0, 40))
    assert.ok(patch.trimEnd().endsWith('[]'))
    assert.equal(
      readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    )
  } finally {
    cleanup()
  }
})

test('create：web 模板写入两个 bundle 层', () => {
  const { mgr, cleanup } = makeManager()
  try {
    const meta = mgr.create('rescue', 'web')
    assert.deepEqual(meta.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.equal(meta.shape, 'web')
  } finally {
    cleanup()
  }
})

test('create：重名 / 保留名 / 未知模板 / 非法名拒绝', () => {
  const { mgr, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    assert.throws(() => mgr.create('work', 'base'), (e: unknown) => e instanceof DshProfileError && e.code === 'exists')
    assert.throws(() => mgr.create('web', 'base'), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName')
    assert.throws(() => mgr.create('other', 'nope'), (e: unknown) => e instanceof DshProfileError && e.code === 'unknownTemplate')
    assert.throws(() => mgr.create('../escape', 'base'), (e: unknown) => e instanceof DshProfileError && e.code === 'invalidNameInput')
  } finally {
    cleanup()
  }
})

test('list：跳过 node_modules 与未初始化目录，按名字排序，标注当前 profile', () => {
  const { mgr, home, cleanup } = makeManager({ current: 'web' })
  try {
    mgr.create('zeta', 'base')
    mgr.create('alpha', 'base')
    // 干扰项：共享 fallback 目录 + 无 package.json 的目录
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'empty-dir'), { recursive: true })
    // 当前 profile（模拟已存在的 web）
    const web = mgr.create('web'.replace('web', 'web2'), 'web')
    assert.equal(web.name, 'web2')

    const list = mgr.list()
    assert.deepEqual(list.map((p) => p.name), ['alpha', 'web2', 'zeta'])
    assert.equal(list.every((p) => p.isCurrent === false), true)

    const current = new DshProfileManager({ homeDir: home, dataDir: home, currentProfile: () => 'alpha' })
    assert.equal(current.list().find((p) => p.name === 'alpha')?.isCurrent, true)
  } finally {
    cleanup()
  }
})

test('list：损坏 manifest 不抛，标 manifestInvalid', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = join(home, 'profiles', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8')
    const list = mgr.list()
    assert.equal(list.length, 1)
    assert.deepEqual(list[0]?.issues, ['manifestInvalid'])
    assert.deepEqual(list[0]?.bundles, [])
    if (list[0] === undefined) return
    const detail = mgr.detail('broken')
    assert.equal(detail.manifest, '{ not json')
    assert.equal(detail.patch, null)
  } finally {
    cleanup()
  }
})

test('detail：返回 package.json 与 cordis.patch.yml 原文 + patch 条目数', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    writeFileSync(join(home, 'profiles', 'work', 'cordis.patch.yml'), '- id: a\n  disabled: true\n- id: b\n  disabled: false\n', 'utf8')
    const detail = mgr.detail('work')
    assert.equal(detail.patchEntryCount, 2)
    assert.ok(detail.patch?.includes('id: a'))
    assert.ok(detail.manifest?.includes('"dsh-profile-work"'))
    assert.throws(() => mgr.detail('nope'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound')
  } finally {
    cleanup()
  }
})

test('rename：目录移动 + name 字段更新 + selection 跟随；重名与当前 profile 拒绝', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    mgr.create('other', 'base')
    mgr.writeSelection('work')
    const renamed = mgr.rename('work', 'work2')
    assert.equal(renamed.name, 'work2')
    assert.equal(existsSync(join(home, 'profiles', 'work')), false)
    assert.equal(existsSync(join(home, 'profiles', 'work2', 'package.json')), true)
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'work2', 'package.json'), 'utf8')) as { name?: string }
    assert.equal(manifest.name, 'dsh-profile-work2')
    assert.equal(mgr.readSelection()?.name, 'work2')

    assert.throws(() => mgr.rename('other', 'work2'), (e: unknown) => e instanceof DshProfileError && e.code === 'exists')
    assert.throws(() => mgr.rename('other', 'web'), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName')

    const current = new DshProfileManager({ homeDir: home, dataDir: home, currentProfile: () => 'other' })
    assert.throws(() => current.rename('other', 'other2'), (e: unknown) => e instanceof DshProfileError && e.code === 'currentProfile')
  } finally {
    cleanup()
  }
})

test('remove：物理删除目录 + 清理 selection；当前 profile 需显式确认', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    mkdirSync(join(home, 'profiles', 'work', 'node_modules'), { recursive: true })
    mgr.writeSelection('work')
    mgr.remove('work')
    assert.equal(existsSync(join(home, 'profiles', 'work')), false)
    assert.equal(mgr.readSelection(), null)

    mgr.create('live', 'web')
    const current = new DshProfileManager({ homeDir: home, dataDir: home, currentProfile: () => 'live' })
    assert.throws(() => current.remove('live'), (e: unknown) => e instanceof DshProfileError && e.code === 'currentProfile')
    current.remove('live', { allowCurrent: true })
    assert.equal(existsSync(join(home, 'profiles', 'live')), false)
    assert.throws(() => mgr.remove('gone'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound')
  } finally {
    cleanup()
  }
})

test('selection：写入需目标存在；删除目标后 readSelection 标 exists=false', () => {
  const { mgr, cleanup } = makeManager()
  try {
    assert.equal(mgr.readSelection(), null)
    assert.throws(() => mgr.writeSelection('ghost'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound')
    mgr.create('work', 'base')
    const sel = mgr.writeSelection('work')
    assert.deepEqual(sel, { name: 'work', exists: true, isCurrent: false })
    assert.equal(mgr.readSelection()?.name, 'work')
    mgr.remove('work')
    assert.equal(mgr.readSelection(), null)
  } finally {
    cleanup()
  }
})

test('selection：目标被外部删除后 still readable 且 exists=false', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    mgr.writeSelection('work')
    rmSync(join(home, 'profiles', 'work'), { recursive: true, force: true })
    const sel = mgr.readSelection()
    assert.equal(sel?.name, 'work')
    assert.equal(sel?.exists, false)
  } finally {
    cleanup()
  }
})

test('selection：当前 profile 标记 isCurrent=true', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    const current = new DshProfileManager({ homeDir: home, dataDir: home, currentProfile: () => 'work' })
    current.writeSelection('work')
    assert.equal(current.readSelection()?.isCurrent, true)
  } finally {
    cleanup()
  }
})

test('模板清单：与官方 shipped template 的 bundle 组合一致（含 base 起步）', () => {
  const byId = new Map(DSH_PROFILE_TEMPLATES.map((t) => [t.id, t]))
  assert.deepEqual(byId.get('base')?.bundles, ['@deepseek-ai/dsh-base'])
  assert.deepEqual(byId.get('web')?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(byId.get('headless')?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  assert.deepEqual(byId.get('sdk-minimal')?.bundles, ['@deepseek-ai/dsh-sdk-minimal'])
  assert.equal(byId.get('acp')?.patchReload, 'startup')
  assert.equal(byId.get('web')?.patchReload, 'live')
})
