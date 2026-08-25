/**
 * Profiles 接线端到端冒烟（构建产物验证，不进入测试套件）。
 *
 * 验证「src/profiles/ 接线后真实验证生效」：
 *  - 直接消费构建产物 lib/*.js 的 ProfileManager + adapter/快照引擎（等价于宿主 route 层
 *    消费同一实例——routes 构造函数与 engine 用同一 ProfileManager 类实例化）；
 *  - 真实临时磁盘：saveCurrent → list → analyzeSwitch → executeSwitch（快照/回滚管道）→
 *    rename → delete → export/import 往返；
 *  - 最小 HostContext（内存 settings/fs），与 profile-manager.test.ts 同构但走 lib 产物。
 *
 * 运行：node scripts/profiles-connectivity-smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'node:fs/promises'

const { ProfileManager, isValidProfileName } = await import('../lib/profiles/index.js')
const { createAdapters } = await import('../lib/adapters/index.js')
const { FileSnapshotStore } = await import('../lib/core/index.js')

/** 最小 HostContext：内存 settings/fs，暴露 settingsNs 供测试播种/断言。 */
function makeContext(platform, homeDir) {
  const settingsNs = new Map()
  const fsFiles = new Map()
  const ctx = {
    platform,
    arch: 'x64',
    homeDir,
    dshVersion: '0.1.0-test',
    log: { info: () => {}, warn: () => {}, error: () => {} },
    profile: 'web',
    settingsNs,
    settings: {
      async describe(ns) {
        const rec = settingsNs.get(ns)
        return rec
          ? { value: rec.value, base: undefined, revision: rec.revision, applies: [], secrets: rec.secrets ?? [] }
          : { value: {}, base: undefined, revision: 0, applies: [], secrets: [] }
      },
      async replace(ns, value, expectedRevision) {
        const cur = settingsNs.get(ns)
        if (cur && expectedRevision !== undefined && cur.revision !== expectedRevision) throw new Error('SETTINGS_CONFLICT')
        settingsNs.set(ns, { value, revision: (cur?.revision ?? 0) + 1, secrets: cur?.secrets ?? [] })
      },
    },
    credentials: {
      async describe() { return { configured: false } },
      async set() {},
      async unset() {},
    },
    plugins: {
      async listInstalled() { return [] },
      async install() { return { needsRestart: false } },
    },
    workspace: {
      async listRecords() { return [] },
      async writeRecord() {},
    },
    patchFile: {
      async readPatchLines() { return [] },
      async applyPatchChanges() {},
    },
    fs: {
      async readFile(rel) {
        const b = fsFiles.get(rel)
        if (b === undefined) throw new Error(`ENOENT ${rel}`)
        return b
      },
      async writeFile(rel, data) { fsFiles.set(rel, data) },
      async exists(rel) { return fsFiles.has(rel) },
      async copy(from, to) { fsFiles.set(to, fsFiles.get(from)) },
      async remove(rel) { fsFiles.delete(rel) },
      async listRecursive(dir) {
        return [...fsFiles.keys()].filter((k) => k.startsWith(dir))
      },
      async mkdir() {},
    },
  }
  return ctx
}

const NS = ['general', 'theme']
const snapshotsDir = join(tmpdir(), `dsh-profiles-smoke-snap-${Date.now()}`)
const dataDir = join(tmpdir(), `dsh-profiles-smoke-data-${Date.now()}`)
const importDir = join(tmpdir(), `dsh-profiles-smoke-import-${Date.now()}`)
for (const d of [snapshotsDir, dataDir, importDir]) await fs.mkdir(d, { recursive: true })

let pass = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`✔ ${name}`)
  } else {
    console.error(`✘ FAIL: ${name}${extra ? ` — ${extra}` : ''}`)
    process.exitCode = 1
  }
}

try {
  // —— 源机：保存当前配置为 Profile（settings 2 ns） ——
  const src = makeContext('win32', 'C:\\Users\\src')
  src.settingsNs.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] })
  src.settingsNs.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] })
  const adapters = createAdapters({ namespaces: NS })
  const srcMgr = new ProfileManager({
    dataDir, ctx: src, adapters, snapshotStore: new FileSnapshotStore({ dir: snapshotsDir }),
  })
  await srcMgr.saveCurrent('work')
  check('saveCurrent: Profile 落盘', await fs.stat(join(dataDir, 'profiles', 'work', 'profile.json')).then(() => true).catch(() => false))
  check('isValidProfileName: 合法名通过', isValidProfileName('work') === true)
  check('isValidProfileName: 穿越拒绝', isValidProfileName('../x') === false)

  const list = await srcMgr.list()
  check('list: 包含 work + sections', list.some((m) => m.name === 'work' && m.sections.includes('settings')))

  // —— 目标机：切机到 Profile（Preview → confirm → execute，快照/回滚管道） ——
  const dst = makeContext('linux', '/home/dst')
  for (const n of NS) dst.settingsNs.set(n, { value: {}, revision: 0, secrets: [] }) // 注册但空 → Create
  const dstMgr = new ProfileManager({
    dataDir, ctx: dst, adapters, snapshotStore: new FileSnapshotStore({ dir: snapshotsDir }),
  })

  const preview = await dstMgr.analyzeSwitch('work')
  check('analyzeSwitch: Preview 含 Create 项', preview.items.some((i) => i.id === 'settings:general' && i.kind === 'Create'))
  check('analyzeSwitch: sectionsInProfile', preview.sectionsInProfile.includes('settings'))

  let rejected = false
  try { await dstMgr.executeSwitch('work', {}) } catch { rejected = true }
  check('executeSwitch: 未 confirm 拒绝（安全阀）', rejected)

  const r = await dstMgr.executeSwitch('work', { confirm: true })
  check('executeSwitch: ok', r.ok === true && r.rollback === null)
  check('executeSwitch: 产生快照', typeof r.snapshotId === 'string' && r.snapshotId !== '')
  check('executeSwitch: settings 已应用（theme=dark）', dst.settingsNs.get('theme')?.value?.mode === 'dark')

  const preview2 = await dstMgr.analyzeSwitch('work')
  check('幂等: 再切 Preview 为 Skip', preview2.items.find((i) => i.id === 'settings:general')?.kind === 'Skip')

  // —— 重命名 / 删除 ——
  await srcMgr.rename('work', 'work-renamed')
  check('rename: 目录级移动生效', (await srcMgr.list()).some((m) => m.name === 'work-renamed'))
  await srcMgr.delete('work-renamed')
  check('delete: 删除生效', (await srcMgr.list()).length === 0)

  // —— 导出 / 导入往返 ——
  await srcMgr.saveCurrent('share')
  const outPath = join(importDir, 'exported.json')
  await srcMgr.exportProfile('share', outPath)
  const imported = await srcMgr.importProfile(outPath, { asName: 'imported-copy' })
  check('import: asName 生效 + sections 保留', imported.name === 'imported-copy' && imported.sections.includes('settings'))
  await srcMgr.delete('share')
  await srcMgr.delete('imported-copy')

  console.log(`\nProfiles 接线冒烟：${pass} 项检查全部通过 ✅`)
} finally {
  for (const d of [snapshotsDir, dataDir, importDir]) rmSync(d, { recursive: true, force: true })
}