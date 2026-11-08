/**
 * 同步作用域（src/sync/sync-scope.ts）单测。
 *
 * 钉住的判据：
 *  1. 默认档案（web）路径与槽位名**逐字不变** —— 这是「老用户零迁移」的全部依据；
 *  2. 其它档案的目录与槽位后缀互相一致（同一份档案名只有一个作用域）；
 *  3. 非法档案名回落默认档案 —— 绝不拼出 \`..\` 之类的越界目录段；
 *  4. 采纳（adopt）只搬「怎么同步」的配置，且幂等（目录一存在就跳过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLOUD_SECRET_REFS, CLOUD_SYNC_PROVIDERS, SYNC_CHANNELS } from '../utils/shared-constants.ts'
import {
  SYNC_CREDENTIAL_REF,
  SYNC_DEFAULT_PROFILE,
  SYNC_SCOPE_ADOPT_FILES,
  SYNC_WEBDAV_CREDENTIAL_REF,
  adoptLegacySyncScope,
  normalizeSyncProfile,
  scopedSyncRef,
  syncPasswordRef,
  syncScopeFor,
  syncScopeLegacyCredentialRefs,
  syncScopeSuffix,
} from './sync-scope.ts'

async function tempDataDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dcm-sync-scope-'))
}

test('默认档案：作用域 = 历史 sync/，槽位名不加后缀（零迁移）', () => {
  const dataDir = join(tmpdir(), 'home', 'dsh-config-manager')
  for (const raw of [SYNC_DEFAULT_PROFILE, undefined, '', '  ']) {
    const scope = syncScopeFor(dataDir, raw)
    assert.equal(scope.profile, 'web')
    assert.equal(scope.isDefault, true)
    assert.equal(scope.rootDir, join(dataDir, 'sync'))
    assert.equal(scope.dir, join(dataDir, 'sync'))
    assert.equal(scope.tokenRef, SYNC_CREDENTIAL_REF)
    assert.equal(scope.webdavPasswordRef, SYNC_WEBDAV_CREDENTIAL_REF)
    assert.equal(scope.scopeRef('DSH_CONFIG_MANAGER_S3_SECRET_KEY'), 'DSH_CONFIG_MANAGER_S3_SECRET_KEY')
    assert.equal(scope.passwordRef('ENCRYPT', 'git'), syncPasswordRef('ENCRYPT', 'git'))
  }
})

test('其它档案：目录 = sync-profiles/<name>，槽位追加 __<PROFILE>', () => {
  const dataDir = join(tmpdir(), 'home', 'dsh-config-manager')
  const scope = syncScopeFor(dataDir, 'Test1')
  assert.equal(scope.profile, 'Test1')
  assert.equal(scope.isDefault, false)
  // 共享根不变：定时备份配置仍在历史 sync/ 下
  assert.equal(scope.rootDir, join(dataDir, 'sync'))
  assert.equal(scope.dir, join(dataDir, 'sync-profiles', 'Test1'))
  assert.equal(scope.tokenRef, SYNC_CREDENTIAL_REF + '__TEST1')
  assert.equal(scope.webdavPasswordRef, SYNC_WEBDAV_CREDENTIAL_REF + '__TEST1')
  assert.equal(scope.scopeRef('FOO'), 'FOO__TEST1')
  assert.equal(scope.passwordRef('DECRYPT', 'webdav'), 'DSH_CONFIG_MANAGER_SYNC_DECRYPT_PASSWORD_WEBDAV__TEST1')
  // 槽位名必须满足 credentials 的 POSIX env-var 形态（否则写入被拒）
  for (const ref of [scope.tokenRef, scope.webdavPasswordRef, scope.passwordRef('ENCRYPT', 's3')]) {
    assert.match(ref, /^[A-Z_][A-Z0-9_]*$/)
  }
})

test('档案名归一：非法名 / 空名 / 带路径分隔符一律回落默认档案', () => {
  assert.equal(normalizeSyncProfile('desktop'), 'desktop')
  assert.equal(normalizeSyncProfile(' my-prof_1.2 '), 'my-prof_1.2')
  for (const bad of ['..', '../etc', 'a/b', 'a\\b', '-lead', '.hidden', '', 123, null, undefined]) {
    assert.equal(normalizeSyncProfile(bad), SYNC_DEFAULT_PROFILE)
  }
  // 越界名不会拼出上级目录：仍是默认作用域
  assert.equal(syncScopeFor('/data', '..').dir, join('/data', 'sync'))
  assert.equal(syncScopeSuffix('..'), '')
})

test('后缀只由归档名决定：大小写不同 = 不同档案；非字母数字折成下划线', () => {
  assert.equal(syncScopeSuffix('web'), '')
  assert.equal(syncScopeSuffix('Web'), '__WEB')
  assert.equal(syncScopeSuffix('a-b.c_d'), '__A_B_C_D')
  assert.equal(scopedSyncRef('X', 'web'), 'X')
  assert.equal(scopedSyncRef('X', 'a-b'), 'X__A_B')
})

test('legacy 槽位表：默认档案为空；其它档案覆盖 token / WebDAV / 各通道加解密 / 云端密钥', () => {
  assert.deepEqual(syncScopeLegacyCredentialRefs(syncScopeFor('/data', 'web')), [])
  const pairs = syncScopeLegacyCredentialRefs(syncScopeFor('/data', 'desktop'))
  const from = pairs.map((p) => p.from)
  assert.ok(from.includes(SYNC_CREDENTIAL_REF))
  assert.ok(from.includes(SYNC_WEBDAV_CREDENTIAL_REF))
  for (const channel of SYNC_CHANNELS) {
    assert.ok(from.includes('DSH_CONFIG_MANAGER_SYNC_ENCRYPT_PASSWORD_' + channel.toUpperCase()))
    assert.ok(from.includes('DSH_CONFIG_MANAGER_SYNC_DECRYPT_PASSWORD_' + channel.toUpperCase()))
  }
  for (const provider of CLOUD_SYNC_PROVIDERS) {
    assert.ok(from.includes(CLOUD_SECRET_REFS[provider]))
  }
  // 每条都指向同一档案的带后缀槽位，且没有自映射（自映射 = 白搬一次）
  for (const pair of pairs) {
    assert.notEqual(pair.from, pair.to)
    assert.ok(pair.to.endsWith('__DESKTOP'))
  }
  assert.equal(new Set(from).size, from.length)
})

test('采纳历史根：默认档案不动；首次只搬白名单配置；第二次幂等', async () => {
  const dataDir = await tempDataDir()
  try {
    const rootDir = join(dataDir, 'sync')
    await mkdir(join(rootDir, 'work'), { recursive: true })
    await writeFile(join(rootDir, 'sync-config.json'), '{"transport":"git"}', 'utf8')
    await writeFile(join(rootDir, 'sync-selection.json'), '{"git":["settings"]}', 'utf8')
    // 不该被继承的三类：工作副本 / 同步流水 / 运行态
    await writeFile(join(rootDir, 'sync-state.json'), '{"remote":1}', 'utf8')
    await writeFile(join(rootDir, 'sync-history.json'), '[]', 'utf8')
    await writeFile(join(rootDir, 'work', 'HEAD'), 'ref: x', 'utf8')

    // 默认档案：连目录都不碰（它的作用域就是历史根）
    assert.deepEqual(await adoptLegacySyncScope(syncScopeFor(dataDir, 'web')), [])
    assert.equal(existsSync(join(rootDir, 'sync-profiles')), false)

    const scope = syncScopeFor(dataDir, 'desktop')
    const copied = await adoptLegacySyncScope(scope)
    assert.deepEqual(copied.sort(), ['sync-config.json', 'sync-selection.json'])
    assert.equal(await readFile(join(scope.dir, 'sync-config.json'), 'utf8'), '{"transport":"git"}')
    for (const skipped of ['sync-state.json', 'sync-history.json']) {
      assert.equal(existsSync(join(scope.dir, skipped)), false)
    }
    assert.equal(existsSync(join(scope.dir, 'work')), false)

    // 幂等：目录已存在 → 空表，且不覆盖用户后来改过的内容
    await writeFile(join(scope.dir, 'sync-config.json'), '{"transport":"webdav"}', 'utf8')
    assert.deepEqual(await adoptLegacySyncScope(scope), [])
    assert.equal(await readFile(join(scope.dir, 'sync-config.json'), 'utf8'), '{"transport":"webdav"}')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('采纳历史根：历史根不存在时建目录但不搬文件（不因缺文件抛错）', async () => {
  const dataDir = await tempDataDir()
  try {
    const scope = syncScopeFor(dataDir, 'open-design')
    assert.deepEqual(await adoptLegacySyncScope(scope), [])
    assert.equal(existsSync(scope.dir), true)
    // 白名单常量与实现同源：每个名字都应被尝试（此处只校验表本身非空且全是 basename）
    assert.ok(SYNC_SCOPE_ADOPT_FILES.length > 0)
    for (const name of SYNC_SCOPE_ADOPT_FILES) assert.ok(!name.includes('/'))
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
