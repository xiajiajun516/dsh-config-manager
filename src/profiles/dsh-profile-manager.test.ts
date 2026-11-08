/**
 * DSH profile 管理引擎单测（真实临时目录；引擎直接读写 `<home>/profiles/<name>`）。
 *
 * 覆盖：list（跳过 node_modules / 未初始化目录 / 损坏 manifest）、create（脚手架与
 * dsh-app-boot 的 initProfile 等价）、rename（目录级移动 + name 字段跟随）、
 * remove（物理删 + 当前 profile 保护）、名字校验与保留名。
 *
 * 注意：引擎**不做任何进程操作**，也不再有「下次启动」标记（2026-09 连同前端按钮移除，
 * 详见 dsh-profile-manager.ts 的文件头）；实例的启动/停止在 dsh-profile-launcher.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DshProfileManager, DshProfileError } from './dsh-profile-manager.ts'
import {
  DSH_PROFILE_TEMPLATES, RESERVED_PROFILE_NAMES, checkProfileName, classifyShape,
} from './dsh-profile-shared.ts'

function makeManager(opts: { current?: string } = {}): { mgr: DshProfileManager; home: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dspm-'))
  const home = join(root, 'home')
  mkdirSync(join(home, 'profiles'), { recursive: true })
  const mgr = new DshProfileManager({
    homeDir: home,
    currentProfile: () => opts.current ?? 'web',
  })
  return { mgr, home, cleanup: () => { rmSync(root, { recursive: true, force: true }) } }
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

test('readMeta：读取档案依赖树里的 DSH 版本与会话格式版本；读不到 = null（绝不猜）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const dir = join(home, 'profiles', 'work')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-work' }), 'utf8')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const before = mgr.list().find((p) => p.name === 'work')
    assert.equal(before?.dshVersion, null, '没装 DSH → null（不猜）')
    assert.equal(before?.sessionFormatVersion, null)

    const dshDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.1' }), 'utf8')
    const sessionLib = join(dir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib')
    mkdirSync(sessionLib, { recursive: true })
    writeFileSync(join(sessionLib, 'index.js'), 'const SESSION_FORMAT_VERSION = 3;\n', 'utf8')

    const after = mgr.list().find((p) => p.name === 'work')
    assert.equal(after?.dshVersion, '0.1.5-rc.1')
    assert.equal(after?.sessionFormatVersion, 3)
  } finally {
    cleanup()
  }
})

test('list：空 profiles 目录 → []', () => {
  const { mgr, cleanup } = makeManager()
  try {
    assert.deepEqual(mgr.list(), [])
  } finally {
    cleanup()
  }
})

/* --------------------------------------------------------------- 复制档案（copy） */

test('copy：整份拷贝（含 node_modules）+ package.json 的 name 跟随新档案名', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    const origin = mgr.create('origin', 'web')
    const srcDir = join(home, 'profiles', 'origin')
    writeFileSync(join(srcDir, 'cordis.patch.yml'), '- id: a\n  config: 1\n')
    writeFileSync(join(srcDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    mkdirSync(join(srcDir, 'node_modules', 'dsh-fake'), { recursive: true })
    writeFileSync(join(srcDir, 'node_modules', 'dsh-fake', 'index.js'), 'export const x = 1\n')

    const { meta, warnings, durationMs } = await mgr.copy('origin', 'origin-copy')
    assert.deepEqual(warnings, [], '带 node_modules 的副本没有告警')
    assert.ok(durationMs >= 0)
    assert.equal(meta.name, 'origin-copy')
    assert.equal(meta.hasNodeModules, true)
    assert.deepEqual(meta.bundles, origin.bundles, 'bundle 层原样带走（顺序即 patch 应用顺序）')
    assert.equal(meta.patchEntryCount, 1)

    const destDir = join(home, 'profiles', 'origin-copy')
    const manifest = JSON.parse(readFileSync(join(destDir, 'package.json'), 'utf8')) as { name: string }
    assert.equal(manifest.name, 'dsh-profile-origin-copy', 'name 跟随目录名（与 create/rename 同一约定）')
    assert.equal(readFileSync(join(destDir, 'cordis.patch.yml'), 'utf8'), '- id: a\n  config: 1\n')
    assert.equal(readFileSync(join(destDir, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9\n', 'pnpm 锁文件一并带走（副本可复现装依赖）')
    assert.ok(existsSync(join(destDir, 'node_modules', 'dsh-fake', 'index.js')))
    assert.ok(existsSync(join(srcDir, 'package.json')), '源档案原地不动')
  } finally {
    cleanup()
  }
})

test('copy：不拷 node_modules 时声明了依赖 → depsNotInstalled 告警（副本不能直接启动）', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('origin')
    const srcDir = join(home, 'profiles', 'origin')
    const manifest = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest['dependencies'] = { 'dsh-fake': '^1.0.0' }
    writeFileSync(join(srcDir, 'package.json'), JSON.stringify(manifest, null, 2))
    mkdirSync(join(srcDir, 'node_modules'), { recursive: true })

    const { meta, warnings } = await mgr.copy('origin', 'slim', { includeNodeModules: false })
    assert.deepEqual(warnings, ['depsNotInstalled'], '没装依赖却声明了依赖 → 必须显式告警，绝不静默')
    assert.equal(meta.dependencies['dsh-fake'], '^1.0.0', '依赖声明照旧（只是没装）')
    assert.equal(meta.hasNodeModules, false)
    assert.ok(existsSync(join(home, 'profiles', 'slim', 'package.json')))
    assert.ok(!existsSync(join(home, 'profiles', 'slim', 'node_modules')), 'includeNodeModules=false 不拷 node_modules')
  } finally {
    cleanup()
  }
})

test('copy：没有依赖声明时不报 depsNotInstalled（不制造噪音）', async () => {
  const { mgr, cleanup } = makeManager()
  try {
    mgr.create('plain')
    const { warnings } = await mgr.copy('plain', 'plain-copy', { includeNodeModules: false })
    assert.deepEqual(warnings, [])
  } finally {
    cleanup()
  }
})

test('copy：目标已存在 / 名字非法 / 保留名 / 源不存在 → 对应错误码', async () => {
  const { mgr, cleanup } = makeManager()
  const codeOf = (expected: string) => (error: unknown): boolean => {
    assert.ok(error instanceof DshProfileError, `应为 DshProfileError，实际 ${String(error)}`)
    assert.equal(error.code, expected)
    return true
  }
  try {
    mgr.create('origin')
    await assert.rejects(() => mgr.copy('origin', 'origin'), codeOf('exists'))
    await assert.rejects(() => mgr.copy('origin', 'a/b'), codeOf('invalidNameInput'))
    await assert.rejects(() => mgr.copy('origin', 'web'), codeOf('reservedName'))
    await assert.rejects(() => mgr.copy('origin', '   '), codeOf('invalidNameInput'))
    await assert.rejects(() => mgr.copy('ghost', 'ghost-copy'), codeOf('notFound'))
  } finally {
    cleanup()
  }
})

test('copy：副本自包含 —— 删掉源档案后副本里被链接的包仍可读（链接被重指向副本自身）', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('origin')
    const srcDir = join(home, 'profiles', 'origin')
    const pkgDir = join(srcDir, 'node_modules', 'dsh-fake')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'index.js'), 'export const fake = 1\n')
    // DSH 会在 profile 的 node_modules 里放 junction（.dsh-module-fallback 投影）：
    // 副本必须把「源档案内部」的链接重指向自己，而不是留一个指回源档案的链接（否则删掉源档案副本就崩）
    symlinkSync(pkgDir, join(srcDir, 'node_modules', 'dsh-linked'), 'junction')

    await mgr.copy('origin', 'origin-copy')
    rmSync(srcDir, { recursive: true, force: true })

    const destDir = join(home, 'profiles', 'origin-copy')
    assert.equal(readFileSync(join(destDir, 'node_modules', 'dsh-fake', 'index.js'), 'utf8'), 'export const fake = 1\n')
    assert.equal(
      readFileSync(join(destDir, 'node_modules', 'dsh-linked', 'index.js'), 'utf8'),
      'export const fake = 1\n',
      '指向源档案内部的链接被重指向副本自身（源档案删除后仍可读）',
    )
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

    const current = new DshProfileManager({ homeDir: home, currentProfile: () => 'alpha' })
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

test('rename：目录移动 + name 字段更新；重名与当前 profile 拒绝', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    mgr.create('other', 'base')
    const renamed = mgr.rename('work', 'work2')
    assert.equal(renamed.name, 'work2')
    assert.equal(existsSync(join(home, 'profiles', 'work')), false)
    assert.equal(existsSync(join(home, 'profiles', 'work2', 'package.json')), true)
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'work2', 'package.json'), 'utf8')) as { name?: string }
    assert.equal(manifest.name, 'dsh-profile-work2')

    assert.throws(() => mgr.rename('other', 'work2'), (e: unknown) => e instanceof DshProfileError && e.code === 'exists')
    assert.throws(() => mgr.rename('other', 'web'), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName')

    const current = new DshProfileManager({ homeDir: home, currentProfile: () => 'other' })
    assert.throws(() => current.rename('other', 'other2'), (e: unknown) => e instanceof DshProfileError && e.code === 'currentProfile')
  } finally {
    cleanup()
  }
})

test('remove：物理删除目录；当前 profile 需显式确认', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    mkdirSync(join(home, 'profiles', 'work', 'node_modules'), { recursive: true })
    mgr.remove('work')
    assert.equal(existsSync(join(home, 'profiles', 'work')), false)

    mgr.create('live', 'web')
    const current = new DshProfileManager({ homeDir: home, currentProfile: () => 'live' })
    assert.throws(() => current.remove('live'), (e: unknown) => e instanceof DshProfileError && e.code === 'currentProfile')
    current.remove('live', { allowCurrent: true })
    assert.equal(existsSync(join(home, 'profiles', 'live')), false)
    assert.throws(() => mgr.remove('gone'), (e: unknown) => e instanceof DshProfileError && e.code === 'notFound')
  } finally {
    cleanup()
  }
})

test('remove：含悬空 junction 的档案也能删净（fs.rm 静默失效的回归）', () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    const dir = join(home, 'profiles', 'work')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    // DSH 的真实形态：node_modules/<pkg> → 已消失的 .dsh-module-fallback/node_modules/<pkg>
    symlinkSync(
      join(dir, '.dsh-module-fallback', 'node_modules', 'immer'),
      join(dir, 'node_modules', 'immer'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    mgr.remove('work')
    // 曾经：fs.rmSync 遇到悬空链接「不抛错也不删」，路由回 200 + 台账 success，档案留在磁盘上
    assert.equal(existsSync(dir), false, '悬空 junction 不得让删除静默失败')
  } finally {
    cleanup()
  }
})

test('desktop 保留档案：删除与改名一律拒绝（managedProfile），只读操作照常', async () => {
  const { mgr, home, cleanup } = makeManager()
  try {
    // Desktop 档案由 Electron 外壳自己初始化（不是本插件 create 出来的），这里按真实形态落盘
    const dir = join(home, 'profiles', 'desktop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop', private: true,
      dependencies: { 'dsh-config-manager': '^0.1.66' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-config-manager'] } },
    }, null, 2) + '\n')

    // 只读路径必须照常工作（否则用户连自己的桌面端档案都看不到）
    assert.equal(mgr.list().some((p) => p.name === 'desktop'), true)
    assert.equal(mgr.detail('desktop').shape, 'web')

    assert.throws(() => mgr.remove('desktop'), (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile')
    // 连 allowCurrent 也不行：删掉之后桌面端要么起不来、要么按 web 模板重建一个空档案（插件全丢）
    assert.throws(() => mgr.remove('desktop', { allowCurrent: true }), (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile')
    assert.throws(() => mgr.rename('desktop', 'desktop2'), (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile')
    assert.equal(existsSync(join(dir, 'package.json')), true, '被拒后目录必须原样保留')

    // 反向：把别的档案改名成 desktop 走的是保留名校验，不是这条
    mgr.create('work', 'base')
    assert.throws(() => mgr.rename('work', 'desktop'), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName')
    // 从桌面端档案复制出来是合法的（复制是「拿一份可改的等价副本」，不动源档案）
    const { meta } = await mgr.copy('desktop', 'desktop-copy')
    assert.equal(meta.name, 'desktop-copy')
    assert.equal(existsSync(join(home, 'profiles', 'desktop', 'package.json')), true, '源档案不受影响')
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

/**
 * routes-F2 回归：保留名/独占名的**大小写变体**必须与原名同罪。
 *
 * 现场：Windows / macOS 默认文件系统大小写不敏感，而 checkProfileName 原先用
 * \`RESERVED_PROFILE_NAMES.includes(trimmed)\` 做**精确**比较 —— \`Desktop\` / \`Web\` 直接绕过
 * 保留名校验建出目录；随后 remove / rename 又按大小写不敏感的 isManagedProfileName 以
 * managedProfile 拒绝同一个名字 → **建得出来、删不掉**，甚至占用 Electron desktop 的目录名。
 */
test('routes-F2 回归：保留名大小写不敏感（大小写变体一律 reservedName，不得建出删不掉的档案）', async () => {
  for (const reserved of RESERVED_PROFILE_NAMES) {
    const variants = [reserved.toUpperCase(), reserved.charAt(0).toUpperCase() + reserved.slice(1)]
    for (const variant of variants) {
      assert.equal(checkProfileName(variant), 'reservedName', '大小写变体必须按保留名拒绝: ' + variant)
    }
  }
  // 反向控制：以保留名为前缀的普通名不得被误伤
  assert.equal(checkProfileName('desktop-prod'), null)
  assert.equal(checkProfileName('webapp'), null)
  assert.equal(checkProfileName('Headless2'), null)

  const { mgr, home, cleanup } = makeManager()
  try {
    mgr.create('work', 'base')
    for (const bad of ['Desktop', 'DESKTOP', 'Web', 'Headless']) {
      assert.throws(() => mgr.create(bad, 'base'), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName', 'create(' + bad + ') 必须按保留名拒绝')
      assert.throws(() => mgr.rename('work', bad), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName', 'rename(work -> ' + bad + ') 必须按保留名拒绝')
      await assert.rejects(mgr.copy('work', bad), (e: unknown) => e instanceof DshProfileError && e.code === 'reservedName', 'copy(work -> ' + bad + ') 必须按保留名拒绝')
    }
    assert.deepEqual(mgr.list().map((p) => p.name), ['work'], '被拒的名字不得在磁盘上留下目录（大小写不敏感 FS 上 Desktop 就是 profiles/desktop）')
    assert.equal(existsSync(join(home, 'profiles', 'desktop')), false, '不得建出 Electron 独占档案的目录')
    // 同一条不变量：已被拒绝的名字不可能成为「删不掉的档案」
    assert.throws(() => mgr.remove('Desktop'), (e: unknown) => e instanceof DshProfileError && e.code === 'managedProfile')
  } finally {
    cleanup()
  }
})
