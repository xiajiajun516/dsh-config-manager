/**
 * m2 run-store 单测：模块级单例 store + sessionStorage 恢复。
 *
 * 覆盖（验收 m2-state / m2-refresh / m2-resume）：
 *  - 敏感字段（password/passwordConfirm/secretInputs）绝不写入 sessionStorage
 *    （序列化白名单剔除），刷新后自动清空；
 *  - 非敏感状态序列化/反序列化往返（新实例 + 同存储 = 模拟刷新）；
 *  - 损坏/版本不符数据回退默认并清除脏键；
 *  - 控制器实例缓存（切 tab/关面板不重建）；
 *  - ImportWizard 从持久化快照 rehydrate（含 decisions；secretInputs 不恢复）；
 *  - ConflictCollector 由 plan + 持久化决策重建；
 *  - confirm 阶段缺必填 secret → 退回 secrets 阶段要求重输；
 *  - m2-resume：进行中 run 经 /runs + 轮询 /progress 重新订阅，完成后把
 *    RunState.result 回填 store 与控制器；无活跃 run 时如实提示不可恢复；
 *  - subscribe/notify 语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RunStore, STATE_KEY, type StoreStorage } from './run-store.ts'
import type { RunProgress } from './common/progress-view.ts'
import type { RunState } from '../core/run-registry.ts'
import type { ImportDecisions } from '../core/types.ts'
import type { ConfigManagerApi } from './api.ts'
import {
  makeAnalysis, makeExportReport, makeImportResult, makeManifest, makePlan,
  makePlanItem,
} from '../ui/test-helpers.ts'

/* ------------------------------------------------------------- fixtures */

const RUN_ID = '0123456789abcdef0123456789abcdef'

function makeStorage(): { storage: StoreStorage; raw: () => string | null } {
  let value: string | null = null
  return {
    storage: {
      getItem: (key: string) => (key === STATE_KEY ? value : null),
      setItem: (key: string, v: string) => {
        if (key === STATE_KEY) value = v
      },
      removeItem: (key: string) => {
        if (key === STATE_KEY) value = null
      },
    },
    raw: () => value,
  }
}

function makeApi(overrides: Partial<ConfigManagerApi> = {}): ConfigManagerApi {
  const base = {
    exportPassword: null,
    status: async () => { throw new Error('not implemented') },
    export: async () => { throw new Error('not implemented') },
    download: async () => { throw new Error('not implemented') },
    upload: async () => { throw new Error('not implemented') },
    analyzeImport: async () => { throw new Error('not implemented') },
    createImportPlan: async () => { throw new Error('not implemented') },
    executeImportPlan: async () => { throw new Error('not implemented') },
    progress: async () => { throw new Error('not implemented') },
    runs: async () => [] as RunState[],
  }
  return { ...base, ...overrides } as ConfigManagerApi
}

function runningRun(kind: RunState['kind'], patch: Partial<RunState> = {}): RunState {
  return {
    runId: RUN_ID,
    kind,
    status: 'running',
    section: null,
    sectionTotal: null,
    item: null,
    itemTotal: null,
    detail: null,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/* ---------------------------------------------------------- 序列化白名单 */

test('m2-refresh: password/passwordConfirm/secretInputs 绝不写入 sessionStorage', () => {
  const { storage, raw } = makeStorage()
  const store = new RunStore({ storage })
  store.patch({
    export: { password: 'S3CRET!', passwordConfirm: 'S3CRET!', includeSecrets: true },
    import: { secretInputs: { K1: 'TOP-SECRET-VALUE' } },
  })
  const text = raw()
  assert.ok(text !== null, 'patch 后已同步持久化')
  assert.ok(!text.includes('S3CRET!'), '密码值不得落入 sessionStorage')
  assert.ok(!text.includes('TOP-SECRET-VALUE'), '秘密补录值不得落入 sessionStorage')
  const parsed = JSON.parse(text) as Record<string, unknown>
  assert.ok(!('password' in (parsed['export'] as Record<string, unknown>)))
  assert.ok(!('passwordConfirm' in (parsed['export'] as Record<string, unknown>)))
  assert.ok(!('secretInputs' in (parsed['import'] as Record<string, unknown>)))
})

test('m2-refresh: 非敏感状态往返恢复，敏感字段刷新后清空', () => {
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    view: 'import',
    export: {
      mode: 'custom',
      selection: ['settings', 'plugins'],
      includeSecrets: true,
      downloaded: true,
      password: 'pw123',
      passwordConfirm: 'pw123',
    },
    import: {
      step: 'preview',
      phase: 'secrets',
      zipPath: '/tmp/x.zip',
      analysis: makeAnalysis(),
      plan: makePlan(),
      secretInputs: { K1: 'in-memory-only' },
    },
  })

  // 新实例 + 同一存储 = 模拟页面刷新
  const second = new RunStore({ storage })
  const st = second.getSnapshot()
  assert.equal(st.view, 'import')
  assert.equal(st.export.mode, 'custom')
  assert.deepEqual(st.export.selection, ['settings', 'plugins'])
  assert.equal(st.export.includeSecrets, true)
  assert.equal(st.export.downloaded, true)
  assert.equal(st.export.password, '', '密码刷新后清空')
  assert.equal(st.export.passwordConfirm, '', '确认密码刷新后清空')
  assert.equal(st.import.step, 'preview')
  assert.equal(st.import.phase, 'secrets')
  assert.deepEqual(st.import.analysis, makeAnalysis())
  assert.deepEqual(st.import.plan, makePlan())
  assert.deepEqual(st.import.secretInputs, {}, '秘密补录值刷新后清空')
})

test('损坏或版本不符的存储数据回退默认并清除脏键', () => {
  const { storage, raw } = makeStorage()
  raw() // no-op to satisfy lint-like usage
  // 非 JSON
  let s = makeStorage()
  let store = new RunStore({ storage: s.storage })
  store.patch({ view: 'import' })
  s = makeStorage()
  store = new RunStore({ storage: s.storage })
  assert.equal(store.getSnapshot().view, 'export')
  // 损坏 JSON
  const c1 = makeStorage()
  c1.storage.setItem(STATE_KEY, '{not-json')
  const corrupt = new RunStore({ storage: c1.storage })
  assert.equal(corrupt.getSnapshot().export.mode, 'quick')
  assert.equal(c1.raw(), null, '损坏数据被清除')
  // 版本不符
  const c2 = makeStorage()
  c2.storage.setItem(STATE_KEY, JSON.stringify({ v: 999 }))
  const wrongVersion = new RunStore({ storage: c2.storage })
  assert.equal(wrongVersion.getSnapshot().export.mode, 'quick')
  assert.equal(c2.raw(), null)
})

/* --------------------------------------------------------- 控制器实例缓存 */

test('m2-state: 控制器实例由 store 缓存复用（不重建）', () => {
  const api = makeApi()
  const store = new RunStore({ storage: null })
  assert.equal(store.exportFlow(api), store.exportFlow(api))
  assert.equal(store.importWizard(api), store.importWizard(api))
  // 不同 api 引用不换实例（模块内 api 是单例）
  const otherApi = makeApi()
  assert.equal(store.exportFlow(otherApi), store.exportFlow(api))
})

/* ------------------------------------------------------- wizard rehydrate */

test('m2-refresh: ImportWizard 从持久化快照 rehydrate（decisions 恢复，secretInputs 不恢复）', async () => {
  const plan = makePlan()
  const analysis = makeAnalysis()
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    import: {
      step: 'preview',
      phase: 'path-mapping',
      zipPath: '/tmp/x.zip',
      analysis,
      plan,
      rollbackOnError: false,
      conflictResolutions: { 'settings:a': 'useImported' },
      pathMappings: [{ oldPrefix: '/old', newPrefix: '/new', appliesTo: ['workspaces'] }],
      errors: ['prev-error'],
      secretInputs: { K1: 'never-persisted' },
    },
  })

  const second = new RunStore({ storage })
  const decisionsSeen: ImportDecisions[] = []
  const api = makeApi({
    analyzeImport: async () => analysis,
    createImportPlan: async (_zip: string, decisions: ImportDecisions) => {
      decisionsSeen.push(decisions)
      return plan
    },
  })
  const wizard = second.importWizard(api)
  const snap = wizard.snapshot()
  assert.equal(snap.step, 'preview')
  assert.equal(snap.zipPath, '/tmp/x.zip')
  assert.deepEqual(snap.analysis, analysis)
  assert.deepEqual(snap.plan, plan)
  assert.equal(snap.rollbackOnError, false)
  assert.deepEqual(snap.errors, ['prev-error'])
  assert.equal(second.getSnapshot().import.phase, 'path-mapping')

  // decisions 恢复验证：confirmCompatibility 会用恢复的 decisions 重建计划
  await wizard.confirmCompatibility()
  assert.equal(decisionsSeen.length, 1)
  assert.equal(decisionsSeen[0]!.strategy, 'merge')
  assert.deepEqual(decisionsSeen[0]!.resolutions, { 'settings:a': 'useImported' })
  assert.deepEqual(decisionsSeen[0]!.pathMappings, [
    { oldPrefix: '/old', newPrefix: '/new', appliesTo: ['workspaces'] },
  ])
  // secretInputs 不暴露于 snapshot，但 execute 时会以空补录值执行（刷新后要求重输）
})

test('m2-refresh: conflicts 阶段刷新后 ConflictCollector 由 plan + 决策重建', () => {
  const plan = makePlan({
    items: [makePlanItem({ id: 'conf:1', kind: 'Conflict', description: '冲突项' })],
  })
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    import: { step: 'preview', phase: 'conflicts', plan, conflictResolutions: { 'conf:1': 'keepCurrent' } },
  })
  const second = new RunStore({ storage })
  const collector = second.getSnapshot().import.conflictCollector
  assert.ok(collector !== null, '刷新后 collector 重建')
  assert.deepEqual(collector!.toResolutions(), { 'conf:1': 'keepCurrent' })
  assert.equal(collector!.hasUnresolved, false)
})

test('m2-refresh: confirm 阶段仍缺必填 secret → 强制退回 secrets 阶段重输', () => {
  const plan = makePlan() // makePlan 自带 missingSecrets: [{ ref: 'K1', required: true }]
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({ import: { step: 'preview', phase: 'confirm', plan } })
  const second = new RunStore({ storage })
  assert.equal(second.getSnapshot().import.phase, 'secrets')
})

/* ------------------------------------------------------- m2-resume 轮询恢复 */

test('m2-resume: 进行中 import run 经 /runs + 轮询 /progress 重新订阅到完成', async () => {
  const result = makeImportResult()
  const progressResponses: RunState[] = [
    runningRun('import', { section: 'plugins', item: 2, itemTotal: 5, detail: 'plugin:pkg-a' }),
    {
      runId: RUN_ID, kind: 'import', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null,
      result, createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('import')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  const wizard = store.importWizard(api)
  const resumed = await store.resume(api)
  assert.equal(resumed, true, '发现活跃 import run')
  assert.equal(store.getSnapshot().import.step, 'importing', '恢复后立即进入 importing')

  await sleep(80)
  const imp = store.getSnapshot().import
  assert.equal(imp.step, 'result')
  assert.equal(imp.running, false)
  assert.deepEqual(imp.result, result, 'RunState.result 回填 store')
  assert.deepEqual(wizard.snapshot().result, result, '结果同步镜像回控制器')
  assert.ok(progressCalls >= 2, '完成前至少轮询过一次 /progress')
})

test('m2-resume: 进行中 export run 轮询到完成，导出结果（含报告文本）恢复', async () => {
  const report = makeExportReport()
  const manifest = makeManifest()
  const progressResponses: RunState[] = [
    runningRun('export', { section: 'settings', item: 1, itemTotal: 3, detail: 'settings' }),
    {
      runId: RUN_ID, kind: 'export', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null,
      result: { zipPath: 'dsh-config-x.zip', manifest, report },
      createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('export')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  const resumed = await store.resume(api)
  assert.equal(resumed, true)

  await sleep(80)
  const exp = store.getSnapshot().export
  assert.equal(exp.running, false)
  assert.equal(exp.result?.zipPath, 'dsh-config-x.zip')
  assert.deepEqual(exp.result?.manifest, manifest)
  assert.equal(typeof exp.result?.text, 'string')
  assert.ok((exp.result?.text ?? '').length > 0, '报告文本已渲染')
})

test('m2-resume: 持久化 importing 但 host 无活跃 run → 重置并提示不可恢复', async () => {
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({ import: { step: 'importing', runId: RUN_ID, running: true } })
  const second = new RunStore({ storage })
  const api = makeApi({ runs: async () => [] })
  const resumed = await second.resume(api)
  assert.equal(resumed, false)
  const imp = second.getSnapshot().import
  assert.equal(imp.step, 'select')
  assert.equal(imp.running, false)
  assert.ok((imp.error ?? '').includes('无法恢复'), '如实提示任务结果不可恢复')
  // 控制器同样被重置
  assert.equal(second.importWizard(api).snapshot().step, 'select')
})

test('m2-resume: run 404（过保留期）→ 停止轮询并提示不可恢复', async () => {
  const api = makeApi({
    runs: async () => [runningRun('export')],
    progress: async () => { throw new Error('run not found') },
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  await store.resume(api)
  await sleep(40)
  const exp = store.getSnapshot().export
  assert.equal(exp.running, false)
  assert.ok((exp.error ?? '').includes('保留期'), '提示保留期/不可恢复')
})

test('m2-resume: 导出失败 run → 停止轮询并回填错误', async () => {
  const progressResponses: RunState[] = [
    runningRun('export'),
    {
      runId: RUN_ID, kind: 'export', status: 'failed',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null,
      error: '导出超时', createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('export')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  await store.resume(api)
  await sleep(60)
  const exp = store.getSnapshot().export
  assert.equal(exp.running, false)
  assert.equal(exp.error, '导出超时')
  assert.equal(exp.result, null)
})

/* ------------------------------------------------- m3：本次会话内实时轮询 */

test('m3-poll: watchRunning 经 /runs 发现进行中 run 并轮询 /progress 回填真实进度', async () => {
  const result = makeImportResult()
  const progressResponses: RunState[] = [
    runningRun('import', { section: 'plugins', item: 6, itemTotal: 18, detail: 'plugin:pkg-a' }),
    {
      runId: RUN_ID, kind: 'import', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null,
      result, createdAt: 1, updatedAt: 3,
    },
  ]
  // 首次 /runs 尚无 run（请求刚发出，宿主尚未注册）→ 第二次才出现
  let runsCalls = 0
  let progressCalls = 0
  const api = makeApi({
    runs: async () => {
      runsCalls += 1
      return runsCalls === 1 ? [] : [runningRun('import')]
    },
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  store.importWizard(api)
  store.watchRunning('import', 5)

  await sleep(80)
  const imp = store.getSnapshot().import
  assert.ok(runsCalls >= 2, '发现阶段持续轮询 /runs 直到出现活跃 run')
  assert.equal(imp.step, 'result', '完成后结果落账')
  assert.deepEqual(imp.result, result)
  // 发现后转入 /progress 轮询且回填过真实进度（内部计数 + 当前项名）
  assert.ok(progressCalls >= 2, '发现 runId 后轮询 /progress')
  assert.equal(imp.running, false)
})

test('m3-poll: watchRunning 轮询回填分区/内部计数进度（ProgressBar 徽章数据源）', async () => {
  const progressResponses: RunState[] = [
    runningRun('export', { section: 'settings', sectionTotal: 12, item: 3, itemTotal: 12, detail: 'settings' }),
    runningRun('export', { section: 'plugins', sectionTotal: 12, item: 4, itemTotal: 12, detail: 'plugins' }),
    {
      runId: RUN_ID, kind: 'export', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null,
      result: { zipPath: 'x.zip', manifest: makeManifest(), report: makeExportReport() },
      createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('export')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  store.exportFlow(api)
  const seen: RunProgress[] = []
  const unsub = store.subscribe(() => {
    const p = store.getSnapshot().export.progress
    if (p !== null) seen.push(p)
  })
  store.watchRunning('export', 5)

  await sleep(80)
  unsub()
  assert.ok(
    seen.some((p) => p.section === 'settings' && p.item === 3 && p.itemTotal === 12),
    '轮询回填分区进度 settings · 3/12',
  )
  assert.ok(seen.some((p) => p.section === 'plugins' && p.item === 4), '进度推进到下一分区 4/12')
  assert.equal(store.getSnapshot().export.result?.zipPath, 'x.zip', '完成后结果落账')
})

test('m3-poll: stopRunWatch 停止发现阶段轮询（视图请求结束后）', async () => {
  let runsCalls = 0
  const api = makeApi({
    runs: async () => {
      runsCalls += 1
      return [] // 永不出现 run（如请求未注册）
    },
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  store.exportFlow(api)
  store.watchRunning('export', 5)
  await sleep(30)
  const callsBeforeStop = runsCalls
  assert.ok(callsBeforeStop >= 1, '停止前发现阶段在轮询')
  store.stopRunWatch('export')
  const callsAfterStop = runsCalls
  await sleep(40)
  assert.equal(runsCalls, callsAfterStop, 'stop 后不再轮询 /runs')
  // 同一 kind 可再次 watch（新请求）
  store.watchRunning('export', 5)
  await sleep(20)
  assert.ok(runsCalls > callsAfterStop, 'stop 后可重新 watch')
  store.stopRunWatch('export')
})

test('m3-poll: 同一 kind 重复 watchRunning 不重复启动', async () => {
  let runsCalls = 0
  const api = makeApi({
    runs: async () => {
      runsCalls += 1
      return []
    },
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  store.exportFlow(api)
  store.watchRunning('export', 5)
  store.watchRunning('export', 5) // 幂等：不另起发现循环
  await sleep(30)
  store.stopRunWatch('export')
  const calls = runsCalls
  await sleep(30)
  assert.equal(runsCalls, calls, 'stop 后无遗留轮询')
})

/* ------------------------------------------------------------- 订阅语义 */

test('subscribe/notify: patch 触发监听器，退订后不再通知', () => {
  const store = new RunStore({ storage: null })
  let notified = 0
  const unsub = store.subscribe(() => { notified += 1 })
  store.patch({ view: 'import' })
  assert.equal(notified, 1)
  unsub()
  store.patch({ view: 'export' })
  assert.equal(notified, 1)
  // getSnapshot 引用在 patch 后替换（useSyncExternalStore 要求）
  const before = store.getSnapshot()
  store.patch({ view: 'import' })
  assert.notEqual(store.getSnapshot(), before)
})
