/**
 * model-tools 编排测试：5 个 Agent 模型工具的纯编排函数（createModelTools）+ 注册层（registerModelTools）。
 * - config_backup：导出真实 ZIP + 非敏感摘要（无凭据值）
 * - config_list_snapshots：非敏感 meta，按 createdAt 倒序
 * - config_restore：confirm:false 只预览（零写入）；快照不存在拒绝；非法 id 拒绝
 * - config_sync_push：复用 SyncEngine.push（内存 transport），返回 snapshotId
 * - config_sync_pull：空远端 → 零写入空差异（不改本地配置）
 * - registerModelTools：tools 存在注册 5 工具；tools 缺失静默跳过
 * 对齐 sync-engine.test.ts：真实 tmp 目录 + makeContext + createAdapters + 内存 transport。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import { createModelTools, registerModelTools, type ModelToolsDeps } from './model-tools.ts'
import { makeContext, MemSnapshotStore } from '../adapters/test-helpers.ts'
import { createAdapters } from '../adapters/index.ts'
import { SyncEngine } from '../sync/sync-engine.ts'
import { Importer } from './importer.ts'
import { writeSyncConfig } from '../sync/sync-config.ts'
import type { SyncConfig } from '../sync/sync-config.ts'
import type { SyncTransport, SyncSnapshot, SyncSnapshotMeta } from '../sync/transport.ts'
import { computeSnapshotMeta } from '../sync/transport.ts'
import { EnvironmentLockUnavailableError } from '../utils/env-lock.ts'
import type { MutationLockPort } from '../utils/env-lock.ts'
import { createSecretScanner } from '../security/secret-scanner.ts'
import type { SecretScanner } from './types.ts'

/** 内存 SyncTransport（spy：记录方法调用，供断言「pull 不写远端」）。 */
class MemSyncTransport implements SyncTransport {
  readonly type = 'memory'
  snapshots = new Map<string, SyncSnapshot>()
  metas: SyncSnapshotMeta[] = []
  calls: string[] = []
  async list(): Promise<SyncSnapshotMeta[]> {
    this.calls.push('list')
    return [...this.metas].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  }
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.calls.push('upload')
    this.snapshots.set(snapshot.id, snapshot)
    this.metas.push(computeSnapshotMeta(snapshot))
    return computeSnapshotMeta(snapshot)
  }
  async download(id: string): Promise<SyncSnapshot> {
    this.calls.push('download')
    const s = this.snapshots.get(id)
    if (!s) throw new Error(`快照不存在: ${id}`)
    return s
  }
  async delete(id: string): Promise<void> {
    this.calls.push('delete')
    this.snapshots.delete(id)
    this.metas = this.metas.filter((m) => m.id !== id)
  }
}

const NS = ['general', 'theme']

function seedSettings(ctx: ReturnType<typeof makeContext>): void {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] })
  ctx.settings.ns.set('theme', { value: { mode: 'dark' }, revision: 1, secrets: [] })
}

/** 构造 model-tools deps：真实 tmp 目录 + 内存 SyncTransport。 */
async function makeDeps(opts: {
  transport?: MemSyncTransport
  /** M1：可选注入强化 secret 扫描器（含 scanText）——验证 config_backup 文件类分区凭据告警 */
  scanner?: SecretScanner
} = {}): Promise<{ deps: ModelToolsDeps; tmp: string; transport: MemSyncTransport; ctx: ReturnType<typeof makeContext> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-model-tools-'))
  const ctx = makeContext('win32', path.join(tmp, 'home'))
  seedSettings(ctx)
  const adapters = createAdapters({ namespaces: NS })
  const syncDir = path.join(tmp, 'sync')
  const transport = opts.transport ?? new MemSyncTransport()
  const makeSyncEngine = (cfg: SyncConfig): SyncEngine => {
    const importer = new Importer({ ctx, adapters, snapshotStore: new MemSnapshotStore() })
    return new SyncEngine({
      ctx,
      transport,
      stateDir: syncDir,
      localSnapshotsDir: path.join(syncDir, 'snapshots'),
      zipDir: path.join(tmp, 'tmp'),
      adapters,
      importer,
      now: () => new Date('2026-08-16T12:00:00.000Z'),
    })
  }
  return {
    deps: {
      host: ctx,
      adapters,
      exportsDir: path.join(tmp, 'exports'),
      snapshotsDir: path.join(tmp, 'snapshots'),
      syncDir,
      makeSyncEngine,
      exporterVersion: '0.1.45',
      // M1：缺省不传 scanner（保持旧行为：Exporter 落回 defaultSecretScanner，无 scanText）
      ...(opts.scanner === undefined ? {} : { scanner: opts.scanner }),
    },
    tmp,
    transport,
    ctx,
  }
}

test('config_backup：导出真实 ZIP 到 exports 目录，返回非敏感摘要（无凭据值）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const tools = createModelTools(deps)
    const out = (await tools.backup({})) as {
      ok: boolean; zip: string; sections: string[]; sizeBytes: number; containsSecrets: boolean; encrypted: boolean
    }
    assert.equal(out.ok, true)
    assert.match(out.zip, /^dsh-config-.*\.zip$/)
    assert.ok(out.sections.includes('settings'), 'settings 分区进入备份')
    assert.equal(out.containsSecrets, false, '默认不含 secret')
    assert.equal(out.encrypted, false)
    assert.ok(out.sizeBytes > 0)
    // ZIP 确实落盘
    const stat = await fs.stat(path.join(deps.exportsDir, out.zip))
    assert.ok(stat.size > 0)
    // 摘要不含任何配置内容/凭据值（只含文件名/分区/布尔/计数）
    const serialized = JSON.stringify(out)
    assert.ok(!serialized.includes('dark'), '摘要不泄漏配置值')
    assert.ok(!serialized.includes('DEEPSEEK'), '摘要不泄漏凭据/环境变量值')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})


/* ---------------- M1（G-09）：config_backup 模型工具路径必须与 HTTP 导出路由同档扫描 ---------------- */

test('M1 config_backup：注入含 scanText 的 scanner → 文件类分区凭据产生告警；未注入 → 不告警（旧行为）', async () => {
  // 1) 提供 scanner（与 HTTP 导出路由同一 createConfiguredSecretScanner 档位，含 scanText）：
  //    技能文件里的 sk-... 必须产生 export.fileSectionSecrets 告警 + 计入 redactedHits。
  const withScanner = await makeDeps({ scanner: createSecretScanner() })
  try {
    const secretValue = 'sk-live-m1-model-tool-9f3a2b7c'
    await withScanner.ctx.fs.writeFile('skills/deploy.md', Buffer.from(`# Deploy skill\napiKey: "${secretValue}"\n`, 'utf8'))
    const out = (await createModelTools(withScanner.deps).backup({})) as {
      ok: boolean; sections: string[]; redactedHits: number; warnings: string[]
    }
    assert.equal(out.ok, true)
    assert.ok(out.sections.includes('skills'), 'skills 分区进入备份')
    const warn = out.warnings.find((w) => w.includes('skills') && w.includes('deploy.md'))
    assert.ok(
      warn !== undefined,
      `注入 scanner 后文件类分区必须告警，实际 warnings=${JSON.stringify(out.warnings)}`,
    )
    assert.ok(warn!.includes('疑似凭据'), '告警文案应说明检测到疑似凭据')
    assert.ok(!warn!.includes(secretValue), '告警绝不能带凭据值')
    assert.ok(out.redactedHits >= 1, `文件类分区命中应计入 redactedHits，实际 ${out.redactedHits}`)
    assert.ok(!JSON.stringify(out).includes(secretValue), '工具出参不得泄漏凭据值')
  } finally {
    await fs.rm(withScanner.tmp, { recursive: true, force: true })
  }

  // 2) 未注入 scanner（向后兼容缺省）→ Exporter 落回 defaultSecretScanner()（无 scanText）：
  //    文件类分区不扫描、不告警，与修复前行为一致。
  const noScanner = await makeDeps()
  try {
    await noScanner.ctx.fs.writeFile('skills/plain.md', Buffer.from('apiKey: "sk-live-m1-no-scanner-111"\n', 'utf8'))
    const out = (await createModelTools(noScanner.deps).backup({})) as {
      ok: boolean; redactedHits: number; warnings: string[]
    }
    assert.equal(out.ok, true)
    assert.equal(out.redactedHits, 0, '缺省扫描器无 scanText → 文件类分区不计命中（旧行为）')
    assert.ok(!out.warnings.some((w) => w.includes('疑似凭据')), '未注入 scanner 时文件类分区不告警（旧行为）')
  } finally {
    await fs.rm(noScanner.tmp, { recursive: true, force: true })
  }
})

test('M1 源码守卫：index.ts 把同一个 scanner 实例注入 HTTP 导出路由与 config_backup', async () => {
  const source = await fs.readFile(new URL('../../src/index.ts', import.meta.url), 'utf8')

  // 1) 单一实例来源：createConfiguredSecretScanner 在 index.ts 里只构造一次
  const ctorCall = 'createConfiguredSecretScanner(config?.personalPatterns)'
  const ctorCount = source.split(ctorCall).length - 1
  assert.equal(ctorCount, 1, `scanner 必须只构造一次（单一实例来源），实际 ${ctorCount} 次`)

  // 2) 捕获该实例的标识符
  const decl = source.match(/const ([A-Za-z_$][\w$]*) = createConfiguredSecretScanner\(/)
  assert.ok(decl !== null, '应能找到 scanner 实例构造（const <name> = createConfiguredSecretScanner(...)）')
  const name = decl![1] as string

  // 3) HTTP 导出路由（makeRoutes 注入 RoutesDeps.scanner）
  const routesStart = source.indexOf('makeRoutes({')
  assert.ok(routesStart > 0, '应能找到 makeRoutes 调用')
  const routesEnd = source.indexOf('\r\n  })', routesStart)
  assert.ok(routesEnd > routesStart, '应能找到 makeRoutes 调用结尾')
  const routesBody = source.slice(routesStart, routesEnd)
  assert.ok(routesBody.includes(`scanner: ${name},`), `makeRoutes 必须注入同一个 scanner 实例（scanner: ${name},）`)

  // 4) config_backup 模型工具（registerModelTools 注入 ModelToolsDeps.scanner）
  const toolsStart = source.indexOf('registerModelTools(ctx, {')
  assert.ok(toolsStart > 0, '应能找到 registerModelTools 调用')
  const toolsEnd = source.indexOf('\r\n  })', toolsStart)
  assert.ok(toolsEnd > toolsStart, '应能找到 registerModelTools 调用结尾')
  const toolsBody = source.slice(toolsStart, toolsEnd)
  assert.ok(toolsBody.includes(`scanner: ${name},`), `registerModelTools 必须注入同一个 scanner 实例（scanner: ${name},）`)

  // 5) 路由内部确实把它交给 Exporter（防「注入了 deps 却没接上」）
  const exportRouteStart = source.indexOf('path: API.export,')
  assert.ok(exportRouteStart > 0, '应能找到导出路由（API.export）')
  const exportRouteEnd = source.indexOf('path: API.exportPreview,', exportRouteStart)
  assert.ok(exportRouteEnd > exportRouteStart, '应能找到紧随其后的 export-preview 路由')
  const exportRouteBody = source.slice(exportRouteStart, exportRouteEnd)
  assert.ok(exportRouteBody.includes('scanner: deps.scanner,'), '导出路由的 Exporter 必须使用 RoutesDeps.scanner')
})

test('config_backup：GLOBAL mutation lock 被其它任务占用时拒绝（EnvironmentLockUnavailableError）', async () => {  const { deps, tmp } = await makeDeps()
  try {
    // 模拟另一项 destructive 任务已持有 GLOBAL 锁：acquire 恒返回 LOCKED（token=null）
    const lockedPort: MutationLockPort = {
      async acquire() {
        return { state: 'LOCKED', token: null, detail: '另一项任务持有锁' }
      },
      validate(token: unknown): token is never { return false },
      async release() {},
    }
    deps.host.mutationLock = lockedPort
    const tools = createModelTools(deps)
    await assert.rejects(
      () => tools.backup({}),
      (err: unknown) => {
        assert.ok(err instanceof EnvironmentLockUnavailableError, `期望锁拒绝，得到 ${err instanceof Error ? err.message : String(err)}`)
        return true
      },
    )
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_list_snapshots：非敏感 meta，按 createdAt 倒序，损坏目录跳过', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const snapshotsDir = deps.snapshotsDir
    await fs.mkdir(snapshotsDir, { recursive: true })
    const snap = (id: string, createdAt: string) => ({
      id, createdAt, sourceZip: `${id}.zip`, entries: [], beforePlugins: [], hostFileBackups: [],
    })
    // 两个有效快照 + 一个损坏目录 + 一个非快照目录
    await fs.mkdir(path.join(snapshotsDir, 's1'), { recursive: true })
    await fs.mkdir(path.join(snapshotsDir, 's2'), { recursive: true })
    await fs.mkdir(path.join(snapshotsDir, 'corrupt'), { recursive: true })
    await fs.mkdir(path.join(snapshotsDir, 'notes'), { recursive: true })
    await fs.writeFile(path.join(snapshotsDir, 's1', 'snapshot.json'), JSON.stringify(snap('s1', '2026-08-16T10:00:00.000Z')))
    await fs.writeFile(path.join(snapshotsDir, 's2', 'snapshot.json'), JSON.stringify(snap('s2', '2026-08-16T12:00:00.000Z')))
    await fs.writeFile(path.join(snapshotsDir, 'corrupt', 'snapshot.json'), '{ not json')

    const tools = createModelTools(deps)
    const metas = (await tools.listSnapshots()) as { id: string; createdAt: string; status?: string }[]
    assert.deepEqual(metas.map((m) => m.id), ['s2', 's1'], '按 createdAt 倒序')
    assert.equal(metas[0]!.createdAt, '2026-08-16T12:00:00.000Z')
    assert.ok(!('status' in metas[0]!), '无 status 时不回显该字段（JsonValue 无 undefined）')
    // 损坏/非快照目录被跳过
    assert.ok(!metas.some((m) => m.id === 'corrupt' || m.id === 'notes'))
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_restore：confirm:false 只预览（零写入）；confirm:true 执行空快照（无副作用）', async () => {
  const { deps, tmp, ctx } = await makeDeps()
  try {
    const snapshotsDir = deps.snapshotsDir
    await fs.mkdir(snapshotsDir, { recursive: true })
    await fs.mkdir(path.join(snapshotsDir, 'snap1'), { recursive: true })
    await fs.writeFile(
      path.join(snapshotsDir, 'snap1', 'snapshot.json'),
      JSON.stringify({ id: 'snap1', createdAt: '2026-08-16T12:00:00.000Z', sourceZip: 'x.zip', entries: [], beforePlugins: [], hostFileBackups: [] }),
    )
    // homeDir 里放一个文件，验证预览不写、执行不删
    await ctx.fs.writeFile('settings.yaml', Buffer.from('foo: bar', 'utf8'))

    const tools = createModelTools(deps)
    const plan = (await tools.restore({ snapshotId: 'snap1', confirm: false })) as { dryRun: boolean; actions: { kind: string }[] }
    assert.equal(plan.dryRun, true)
    const WRITE_KINDS = new Set(['hostFileRestore', 'hostFileRemove', 'pluginRemove', 'fileRestore', 'fileRemove'])
    assert.ok(plan.actions.every((a) => !WRITE_KINDS.has(a.kind)), '预览无任何写/删/卸载动作（只有 skip）')
    assert.ok(await ctx.fs.exists('settings.yaml'), '预览不写不删')

    const exec = (await tools.restore({ snapshotId: 'snap1', confirm: true })) as { dryRun: boolean; restored: string[] }
    assert.equal(exec.dryRun, false)
    assert.deepEqual(exec.restored, [])
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_restore：快照不存在 → 拒绝（不预览不执行）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const tools = createModelTools(deps)
    await assert.rejects(() => tools.restore({ snapshotId: 'nope', confirm: false }), /快照不存在/)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_restore：非法快照 id（路径分隔符）→ 拒绝（防 join 越界）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const tools = createModelTools(deps)
    await assert.rejects(() => tools.restore({ snapshotId: '../evil', confirm: false }), /非法快照 id/)
    await assert.rejects(() => tools.restore({ snapshotId: 'a/b', confirm: false }), /非法快照 id/)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_sync_push：复用 SyncEngine.push（内存 transport），返回 snapshotId', async () => {
  const { deps, tmp, transport } = await makeDeps()
  try {
    await writeSyncConfig(deps.syncDir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } })
    const tools = createModelTools(deps)
    const out = (await tools.syncPush({ channel: 'git' })) as { ok: boolean; snapshotId: string; sections: string[] }
    assert.equal(out.ok, true)
    assert.ok(out.snapshotId !== '')
    assert.ok(out.sections.length > 0, 'portable 分区进入同步')
    assert.ok(transport.calls.includes('upload'), 'push 写远端')
    const uploadedSections = transport.snapshots.get(out.snapshotId)!.sections as Record<string, unknown>
    assert.ok(!('secrets' in uploadedSections), '不含 secrets 分区')
    assert.ok(!('credentialsStatus' in uploadedSections), '不含 credentialsStatus 分区')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('config_sync_pull：空远端 → 零写入空差异', async () => {
  const { deps, tmp, transport, ctx } = await makeDeps()
  try {
    await writeSyncConfig(deps.syncDir, { schemaVersion: 2, transport: 'git', git: { repoUrl: 'https://github.com/u/r.git' } })
    await ctx.fs.writeFile('settings.yaml', Buffer.from('foo: bar', 'utf8'))
    const before = await ctx.fs.listRecursive('')
    const tools = createModelTools(deps)
    const out = (await tools.syncPull({ channel: 'git' })) as { ok: boolean; snapshotId: string; changes: unknown[]; needsReview: boolean }
    assert.equal(out.ok, true)
    assert.equal(out.snapshotId, '')
    assert.deepEqual(out.changes, [], '空远端 → 无差异')
    // pull 零写入：本地文件集合不变
    assert.deepEqual(await ctx.fs.listRecursive(''), before)
    assert.ok(!transport.calls.includes('upload'), 'pull 不写远端')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

// ------------------------------------------------ 注册层（registerModelTools）

/** 最小 mock Cordis ctx：tools 服务可选 + effect 收集 disposer（不跑副作用）。 */
function mockCtx(toolsSvc: unknown): { ctx: Context; registered: string[]; effects: (() => void)[] } {
  const registered: string[] = []
  const effects: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'tools' ? toolsSvc : undefined),
    tools: toolsSvc === null || toolsSvc === undefined
      ? undefined
      : { register: (def: { name: string }) => { registered.push(def.name); return () => {} } },
    effect: (cb: () => void) => { effects.push(cb) },
  } as unknown as Context
  return { ctx, registered, effects }
}

test('registerModelTools：tools 服务存在 → 注册 5 个工具（走 ctx.get 结果，属性访问守卫不崩）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const names: string[] = []
    const toolsSvc = { register: (def: { name: string }) => { names.push(def.name); return () => {} } }
    // 模拟真实 Cordis ctx：ctx.get('tools') 返回服务，但 ctx.tools 属性访问因插件未声明
    // inject: ['tools'] 而抛 "cannot get property without inject"（回归：注册必须走 get
    // 结果而非属性——旧实现 ctx.tools.register 在这里会崩溃）。
    const wrapped = {
      get: (name: string) => (name === 'tools' ? toolsSvc : undefined),
      effect: () => {},
    } as unknown as Context
    Object.defineProperty(wrapped, 'tools', {
      get() { throw new Error('cannot get property "tools" without inject') },
    })
    // 不抛错 = 注册走 toolsSvc + defineTool schema 全部可编译（无效 schema 会在定义时抛错）
    registerModelTools(wrapped, deps)
    assert.deepEqual(names.sort(), [
      'config_backup', 'config_list_snapshots', 'config_restore',
      'config_sync_pull', 'config_sync_push',
    ].sort())
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test('registerModelTools：tools 服务缺失 → 静默跳过（不抛错、不注册）', async () => {
  const { deps, tmp } = await makeDeps()
  try {
    const wrapped = {
      get: () => null,
      effect: () => {},
    } as unknown as Context
    registerModelTools(wrapped, deps)
    assert.ok(true, '不抛错即通过')
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
})
