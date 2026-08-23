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
import { MAX_RUN_LOG_LINES, type RunState } from '../core/run-registry.ts'
import type { RestoreReport } from '../core/restore.ts'
import type { ImportDecisions } from '../core/types.ts'
import type { ConfigManagerApi } from './api.ts'
import {
  makeAnalysis, makeExportReport, makeImportResult, makeManifest, makePlan,
  makePlanItem,
} from '../ui/test-helpers.ts'
import type { SyncConfirmItem, SyncStartResponse } from './sync/sync-api.ts'
import type { MarketListItem, MarketDownloadResult } from '../market/types.ts'

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
    log: [],
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

test('m2-refresh: skipRequested 为内存瞬态——不写入 sessionStorage、刷新后复位', () => {
  const { storage, raw } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({ import: { skipRequested: true, running: true } })
  const text = raw()
  assert.ok(text !== null)
  const parsed = JSON.parse(text) as Record<string, unknown>
  const imp = parsed['import'] as Record<string, unknown>
  assert.ok(!('skipRequested' in imp), 'skipRequested 为瞬态，不得落盘')
  // 新实例（模拟刷新）：skipRequested 复位为 false
  const second = new RunStore({ storage })
  assert.equal(second.getSnapshot().import.skipRequested, false, '刷新后跳过标记复位')
})

test('m2-refresh: 非敏感表单状态往返恢复，敏感字段与导出结果瞬态刷新后清空', () => {
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    view: 'import',
    export: {
      mode: 'custom',
      selection: ['settings', 'plugins'],
      includeSecrets: true,
      encrypt: true,
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
  assert.equal(st.export.encrypt, true, 'encrypt 为非敏感选项，刷新后恢复')
  assert.equal(st.export.downloaded, false, '导出完成提示（downloaded）为瞬态，刷新后清空')
  assert.equal(st.export.password, '', '密码刷新后清空')
  assert.equal(st.export.passwordConfirm, '', '确认密码刷新后清空')
  assert.equal(st.import.step, 'preview')
  assert.equal(st.import.phase, 'secrets')
  assert.deepEqual(st.import.analysis, makeAnalysis())
  assert.deepEqual(st.import.plan, makePlan())
  assert.deepEqual(st.import.secretInputs, {}, '秘密补录值刷新后清空')
})

test('m2-refresh: 导出结果/进度/进行中为内存切片瞬态——不写入 sessionStorage、刷新后清空', () => {
  const { storage, raw } = makeStorage()
  const store = new RunStore({ storage })
  store.patch({
    export: {
      result: {
        zipPath: 'export-result-x.zip',
        manifest: makeManifest(),
        report: makeExportReport(),
        text: '备份已创建\n已包含：\n  ✓ settings (21 namespaces)',
      },
      downloaded: true,
      running: true,
      progress: { stage: 'exporting', step: 1, total: 3, section: 'settings', item: 1, itemTotal: 3 },
      runId: RUN_ID,
    },
  })
  const text = raw()
  assert.ok(text !== null, 'patch 后已同步持久化')
  assert.ok(!text.includes('export-result-x.zip'), '导出结果文件名不得落入 sessionStorage')
  assert.ok(!text.includes('备份已创建'), '报告文本不得落入 sessionStorage')
  const parsed = JSON.parse(text) as { export: Record<string, unknown> }
  assert.ok(!('result' in parsed['export']), 'export 切片不含 result（瞬态不落盘）')
  assert.ok(!('downloaded' in parsed['export']), 'export 切片不含 downloaded（瞬态不落盘）')
  assert.ok(!('running' in parsed['export']), 'export 切片不含 running（瞬态不落盘）')
  assert.ok(!('progress' in parsed['export']), 'export 切片不含 progress（瞬态不落盘）')
  assert.ok(!('runId' in parsed['export']), 'export 切片不含 runId（瞬态不落盘）')

  // 新实例 + 同一存储 = 模拟页面刷新 → 导出结果清空，回到干净导出页
  const second = new RunStore({ storage })
  const st = second.getSnapshot()
  assert.equal(st.export.result, null, '导出报告刷新后清空（不残留展示）')
  assert.equal(st.export.downloaded, false, '已保存提示刷新后清空')
  assert.equal(st.export.running, false, '进行中为瞬态，刷新后回复空闲')
  assert.equal(st.export.progress, null, '进度刷新后清空')
  assert.equal(st.export.runId, null, 'runId 刷新后清空')
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
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
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

test('m2-resume: 进行中 import run 恢复时带回执行日志（刷新页面 log 不丢）', async () => {
  const initialLog = ['▶ settings:general', '$ dsh plugin --profile web add @scope/pkg', '✓ settings:general']
  const progressResponses: RunState[] = [
    runningRun('import', {
      section: 'plugins', item: 3, itemTotal: 5, detail: 'plugin:@scope/pkg',
      log: [...initialLog],
    }),
    runningRun('import', {
      section: 'plugins', item: 4, itemTotal: 5, detail: 'plugin:@scope/pkg',
      log: [...initialLog, '▶ plugin:@scope/pkg'],
    }),
    {
      runId: RUN_ID, kind: 'import', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
      result: makeImportResult(), createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    // 刷新后 /runs 仍返回进行中 run（Host 侧导入继续执行），快照即带已累积日志
    runs: async () => [runningRun('import', { log: [...initialLog] })],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  // 订阅捕获轮询期间的进度快照（完成态 progress 不含 log，故在轮询中断言）
  const seenLogs: (string[] | undefined)[] = []
  const unsub = store.subscribe(() => {
    const p = store.getSnapshot().import.progress
    if (p !== null) seenLogs.push(p.log)
  })
  const resumed = await store.resume(api)
  assert.equal(resumed, true, '发现活跃 import run')
  assert.equal(store.getSnapshot().import.step, 'importing')
  // 恢复瞬间：/runs 快照即带回已累积的日志行（刷新不丢）
  assert.deepEqual(store.getSnapshot().import.progress?.log, initialLog, '刷新后立即恢复已累积日志')
  // 轮询 /progress：日志持续追加
  await sleep(40)
  unsub()
  assert.ok(
    seenLogs.some((l) => (l ?? []).includes('▶ plugin:@scope/pkg')),
    '轮询带回新增日志行',
  )
  assert.equal(store.getSnapshot().import.step, 'result')
})

test('m2-resume: 进行中 export run 轮询到完成，导出结果（含报告文本）恢复', async () => {
  const report = makeExportReport()
  const manifest = makeManifest()
  const progressResponses: RunState[] = [
    runningRun('export', { section: 'settings', item: 1, itemTotal: 3, detail: 'settings' }),
    {
      runId: RUN_ID, kind: 'export', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
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
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
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
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
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
  // 发现活跃 run 时 runId 同步写入 store（fresh run 期间「跳过当前插件」有正确目标，
  // 不会用上一次导入的陈旧 runId —— run-store patchProgress 同步 runId）
  assert.equal(imp.runId, RUN_ID, 'watchRunning 发现 run 后 store.runId 立即填充')
})

test('m3-poll: watchRunning 轮询回填分区/内部计数进度（ProgressBar 徽章数据源）', async () => {
  const progressResponses: RunState[] = [
    runningRun('export', { section: 'settings', sectionTotal: 12, item: 3, itemTotal: 12, detail: 'settings' }),
    runningRun('export', { section: 'plugins', sectionTotal: 12, item: 4, itemTotal: 12, detail: 'plugins' }),
    {
      runId: RUN_ID, kind: 'export', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
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

test('m3-poll: 导入日志超过 MAX_RUN_LOG_LINES 后 store progress.log 仍持续更新（P1-3 封顶不冻结）', async () => {
  // 模拟导入日志已满 500 行封顶：后续轮询长度恒为 500，但每次 append 都换新数组引用
  // （run-registry appendLog 不可变写入）。store 的 progress.log 必须持续拿到新引用，
  // 否则 ImportLogPanel 的 memo 按引用比较会判定「无变化」→ 日志面板冻结。
  let log: string[] = []
  for (let i = 0; i < MAX_RUN_LOG_LINES; i++) log = [...log, `line-${i}`]
  const progressResponses: RunState[] = []
  for (let i = 0; i < 4; i++) {
    log = [...log.slice(-(MAX_RUN_LOG_LINES - 1)), `cap-${i}`]
    progressResponses.push(runningRun('import', { section: 'plugins', item: i + 1, itemTotal: 8, detail: 'plugin:pkg', log }))
  }
  progressResponses.push({
    runId: RUN_ID, kind: 'import', status: 'done',
    section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
    result: makeImportResult(), createdAt: 1, updatedAt: 3,
  })
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('import')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  await store.resume(api)
  // 订阅捕获轮询期间的 progress.log 引用
  const seenRefs = new Set<string[]>()
  const seenTails = new Set<string>()
  const unsub = store.subscribe(() => {
    const p = store.getSnapshot().import.progress
    const log = p?.log ?? []
    if (log.length === MAX_RUN_LOG_LINES) {
      seenRefs.add(log)
      seenTails.add(log[log.length - 1]!)
    }
  })
  await sleep(150)
  unsub()
  assert.equal(store.getSnapshot().import.step, 'result', '轮询收敛到完成')
  assert.ok(seenRefs.size >= 3, `封顶后轮询仍拿到新数组引用（实际 ${seenRefs.size} 个不同引用）`)
  assert.ok(seenTails.has('cap-3'), '最新行 cap-3 已到达 store（日志没有冻结在旧行）')
  assert.ok(!seenTails.has('line-499'), '截断保留最新行（cap-* 覆盖 line-* 尾部）')
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

test('回归: subscribe/getSnapshot 以裸引用调用时 this 绑定实例（useSyncExternalStore 的调用方式）', () => {
  const store = new RunStore({ storage: null })
  // React 内部以无接收者方式调用 getSnapshot()/subscribe(listener) ——
  // 若为原型方法则 this 为 undefined 直接崩溃（备份与迁移页空白根因）。
  const bareGet = store.getSnapshot
  const bareSub = store.subscribe
  assert.equal(bareGet().view, 'export', '裸引用 getSnapshot 不崩（this 绑定实例）')
  let notified = 0
  const unsub = bareSub(() => { notified += 1 })
  store.patch({ view: 'import' })
  assert.equal(notified, 1, '裸引用 subscribe 不崩且能退订')
  unsub()
  store.patch({ view: 'export' })
  assert.equal(notified, 1, '退订后不再通知')
})

/* ----------------------------------------- 低频面板切片持久化（切 tab / 刷新恢复） */

/** SyncConfirmItem 最小夹具。 */
function makeConfirmItem(id: string): SyncConfirmItem {
  return {
    itemId: id,
    adapter: 'settings',
    kind: 'Update',
    description: `更新 ${id}`,
    severity: 'info',
    defaultAdopt: true,
    adopt: true,
  }
}

/** 一键同步差异确认会话夹具（items 非敏感，可安全持久化）。 */
function makeConfirmSession(): SyncStartResponse {
  return {
    ok: true,
    syncSessionId: 'sync-session-test-0001',
    snapshotId: 'snap-abc',
    items: [makeConfirmItem('settings:key'), makeConfirmItem('plugins:pkg')],
    needsReview: false,
    compatibility: 'excellent',
  }
}

/** 同步切片夹具（含敏感字段；token/webdav/加密与解密密码必须被白名单剔除）。 */
function makeSyncPatch(): Parameters<RunStore['patch']>[0]['sync'] {
  return {
    channel: 'webdav',
    repoUrl: 'https://github.com/u/repo.git',
    token: 'GIT-TOKEN-SECRET',
    webdavUrl: 'https://dav.example.com/dav',
    webdavUsername: 'alice',
    webdavPassword: 'WEBDAV-PASS-SECRET',
    // 瞬态：进行中推送 + 保存中 —— 切 tab 由模块级单例保留，刷新时白名单剔除
    busy: 'push',
    savingConfig: true,
    byChannel: {
      git: {
        syncMode: 'default',
        syncSections: [],
        encrypt: false,
        includeSecrets: false,
        encryptPassword: '',
        encryptPasswordConfirm: '',
        decryptPassword: '',
        selectedSnapshotId: '',
        snapshots: [],
        autosync: null,
        autosyncEnabled: false,
        autosyncInterval: '30m',
      },
      webdav: {
        syncMode: 'advanced',
        syncSections: ['settings', 'plugins'],
        encrypt: true,
        includeSecrets: true,
        encryptPassword: 'ENC-PASS-SECRET',
        encryptPasswordConfirm: 'ENC-PASS-SECRET',
        decryptPassword: 'DEC-PASS-SECRET',
        selectedSnapshotId: 'snap-xyz',
        snapshots: [],
        autosync: null,
        autosyncEnabled: false,
        autosyncInterval: '30m',
      },
    },
    pushReport: null,
    pullReport: null,
    confirmSession: makeConfirmSession(),
    lastRestoreId: null,
    error: 'sync error text',
    loadError: null,
  }
}

test('低频面板: 同步凭据（token/webdav/加密与解密密码）绝不写入 sessionStorage', () => {
  const { storage, raw } = makeStorage()
  const store = new RunStore({ storage })
  store.patch({ sync: makeSyncPatch() })
  const text = raw()
  assert.ok(text !== null, 'patch 后已同步持久化')
  assert.ok(!text.includes('GIT-TOKEN-SECRET'), 'git token 不得落入 sessionStorage')
  assert.ok(!text.includes('WEBDAV-PASS-SECRET'), 'webdav 密码不得落入 sessionStorage')
  assert.ok(!text.includes('ENC-PASS-SECRET'), '加密密码不得落入 sessionStorage')
  assert.ok(!text.includes('DEC-PASS-SECRET'), '解密密码不得落入 sessionStorage')
  assert.ok(text.includes('https://github.com/u/repo.git'), '非敏感表单值可持久化')
  assert.ok(text.includes('sync-session-test-0001'), '确认会话 id 可持久化（宿主侧 30 分钟内存登记）')
  const parsed = JSON.parse(text) as {
    sync: {
      byChannel: { git: Record<string, unknown>; webdav: Record<string, unknown> }
      [k: string]: unknown
    }
  }
  assert.ok(!('token' in parsed['sync']), 'sync 切片不含 token')
  assert.ok(!('webdavPassword' in parsed['sync']), 'sync 切片不含 webdav 密码')
  assert.ok(!('busy' in parsed['sync']), 'sync 切片不含 busy（瞬态不落盘）')
  assert.ok(!('savingConfig' in parsed['sync']), 'sync 切片不含 savingConfig（瞬态不落盘）')
  assert.ok(!('encryptPassword' in parsed['sync']), 'sync 切片顶层不含加密密码')
  assert.ok(!('encryptPasswordConfirm' in parsed['sync']), 'sync 切片顶层不含加密密码确认')
  assert.ok(!('decryptPassword' in parsed['sync']), 'sync 切片顶层不含解密密码')
  assert.ok(!('encryptPassword' in parsed['sync'].byChannel.git), 'byChannel.git 不含加密密码')
  assert.ok(!('encryptPasswordConfirm' in parsed['sync'].byChannel.git), 'byChannel.git 不含加密密码确认')
  assert.ok(!('decryptPassword' in parsed['sync'].byChannel.git), 'byChannel.git 不含解密密码')
  assert.ok(!('encryptPassword' in parsed['sync'].byChannel.webdav), 'byChannel.webdav 不含加密密码')
  assert.ok(!('decryptPassword' in parsed['sync'].byChannel.webdav), 'byChannel.webdav 不含解密密码')
  assert.equal(parsed['sync'].byChannel.webdav.syncMode, 'advanced', '非敏感通道设置可持久化')
  assert.deepEqual(parsed['sync'].byChannel.webdav.syncSections, ['settings', 'plugins'])
})

test('低频面板: 同步/市场/快照切片与当前面板刷新往返恢复（敏感字段清空）', () => {
  const { storage } = makeStorage()
  const first = new RunStore({ storage })
  const confirmSession = makeConfirmSession()
  const plan = makePlan()
  const analysis = makeAnalysis()
  first.patch({ panel: 'sync', sync: makeSyncPatch() })
  const marketDetail: MarketDownloadResult = {
    id: 'm1',
    name: 'Market A',
    version: '1.0.0',
    sections: ['settings'],
    downloadedAt: '2026-01-01T00:00:00Z',
    status: 'valid',
    warnings: ['第三方来源'],
    zipPath: '/tmp/market-m1-abc.zip',
    analysis,
    plan,
  }
  first.patch({
    panel: 'market',
    market: {
      search: 'deepseek',
      category: 'sync',
      items: [{ id: 'm1', name: 'Market A', cacheState: 'cached' } as MarketListItem],
      detail: marketDetail,
      approvals: { plugins: true },
      importResult: null,
      error: 'market error',
      loadError: null,
    },
  })
  first.patch({
    panel: 'snapshots',
    snapshots: {
      selectedId: 'snap-1',
      plan: {
        snapshotId: 'snap-1',
        createdAt: '2026-01-01T00:00:00Z',
        sourceZip: 'x.zip',
        actions: [],
        summary: { hostFileRestores: 0, hostFileRemoves: 0, pluginRemoves: 0, fileRestores: 0, fileRemoves: 0, credentialHints: 0, skips: 1 },
        pluginBaselineConfirmed: true,
      },
      report: {
        snapshotId: 'snap-1',
        restored: ['settings.yaml'],
        removedPlugins: [],
        manualHints: [],
        failed: [],
        skipped: [],
      },
      actionError: null,
      error: null,
    },
  })

  // 新实例 + 同一存储 = 模拟页面刷新
  const second = new RunStore({ storage })
  const st = second.getSnapshot()
  assert.equal(st.panel, 'snapshots', '刷新后回到原低频面板')
  assert.equal(st.sync.channel, 'webdav')
  assert.equal(st.sync.byChannel.webdav.syncMode, 'advanced', 'webdav 通道模式恢复')
  assert.deepEqual(st.sync.byChannel.webdav.syncSections, ['settings', 'plugins'], 'webdav 通道勾选恢复')
  assert.equal(st.sync.byChannel.webdav.selectedSnapshotId, 'snap-xyz')
  assert.equal(st.sync.byChannel.git.syncMode, 'default', 'git 通道独立（未配置保持缺省）')
  assert.deepEqual(st.sync.confirmSession, confirmSession, '确认会话刷新后恢复（宿主侧会话仍有效）')
  assert.equal(st.sync.error, 'sync error text')
  assert.equal(st.sync.token, '', 'git token 刷新后清空')
  assert.equal(st.sync.webdavPassword, '', 'webdav 密码刷新后清空')
  assert.equal(st.sync.byChannel.webdav.encryptPassword, '', '加密密码刷新后清空')
  assert.equal(st.sync.byChannel.webdav.decryptPassword, '', '解密密码刷新后清空')
  assert.equal(st.sync.busy, null, '进行中操作（busy）为瞬态，刷新后清空回复空闲')
  assert.equal(st.sync.savingConfig, false, '保存中（savingConfig）为瞬态，刷新后清空')
  assert.equal(st.market.search, 'deepseek')
  assert.equal(st.market.category, 'sync')
  assert.equal(st.market.items.length, 1)
  assert.deepEqual(st.market.detail, marketDetail, '详情（含 zipPath/plan）往返恢复')
  assert.deepEqual(st.market.approvals, { plugins: true })
  assert.equal(st.market.error, 'market error')
  assert.equal(st.snapshots.selectedId, 'snap-1')
  assert.equal(st.snapshots.plan?.snapshotId, 'snap-1')
  assert.deepEqual(st.snapshots.report?.restored, ['settings.yaml'])
})

test('低频面板: 旧版 v1 载荷（无 panel/sync/market/snapshots 字段）兼容解析 → 默认切片', () => {
  const { storage } = makeStorage()
  storage.setItem(STATE_KEY, JSON.stringify({
    v: 1,
    view: 'import',
    export: {
      mode: 'quick', selection: [], includeSecrets: false, encrypt: false,
      running: false, progress: null, result: null, error: null, downloaded: false, runId: null,
    },
    import: {
      step: 'select', zipPath: null, selectedFileName: null, containerEncrypted: false,
      analysis: null, plan: null, result: null, rollbackOnError: true, errors: [],
      phase: 'preview', conflictStrategy: 'merge', conflictResolutions: {}, pathMappings: [],
      uploading: false, running: false, progress: null, error: null, runId: null,
    },
  }))
  const store = new RunStore({ storage })
  const st = store.getSnapshot()
  assert.equal(st.view, 'import')
  assert.equal(st.panel, null, '旧载荷无 panel → 主视图')
  assert.equal(st.sync.channel, 'git')
  assert.equal(st.sync.byChannel.git.syncSections.length, 0)
  assert.equal(st.sync.byChannel.webdav.syncMode, 'default', 'webdav 通道缺省')
  assert.deepEqual(st.market.items, [])
  assert.equal(st.snapshots.selectedId, null)
})

test('低频面板: 旧版顶层 syncMode 载荷 → 迁移为 git 通道的 byChannel 状态', () => {
  const { storage } = makeStorage()
  storage.setItem(STATE_KEY, JSON.stringify({
    v: 1,
    view: 'export',
    export: {
      mode: 'quick', selection: [], includeSecrets: false, encrypt: false,
      running: false, progress: null, result: null, error: null, downloaded: false, runId: null,
    },
    import: {
      step: 'select', zipPath: null, selectedFileName: null, containerEncrypted: false,
      analysis: null, plan: null, result: null, rollbackOnError: true, errors: [],
      phase: 'preview', conflictStrategy: 'merge', conflictResolutions: {}, pathMappings: [],
      uploading: false, running: false, progress: null, error: null, runId: null,
    },
    sync: {
      channel: 'git', repoUrl: '', token: '', webdavUrl: '', webdavUsername: '', webdavPassword: '',
      syncMode: 'advanced', syncSections: ['settings'], encrypt: true, includeSecrets: false,
      encryptPassword: 'SHOULD-NOT-PERSIST', encryptPasswordConfirm: '', decryptPassword: '',
      selectedSnapshotId: 'snap-old', pushReport: null, pullReport: null, confirmSession: null,
      lastRestoreId: null, error: null, loadError: null,
    },
  }))
  const store = new RunStore({ storage })
  const st = store.getSnapshot()
  assert.equal(st.sync.byChannel.git.syncMode, 'advanced', '旧顶层模式迁移到 git 通道')
  assert.deepEqual(st.sync.byChannel.git.syncSections, ['settings'], '旧顶层勾选迁移到 git 通道')
  assert.equal(st.sync.byChannel.git.encrypt, true)
  assert.equal(st.sync.byChannel.git.encryptPassword, '', '迁移后加密密码仍强制清空')
  assert.equal(st.sync.byChannel.git.selectedSnapshotId, 'snap-old')
  assert.equal(st.sync.byChannel.webdav.syncMode, 'default', 'webdav 通道保持缺省')
})

/* -------------------------------------------------- restore（P1-1）权威状态 */

test('低频面板: 快照恢复 running 为瞬态——不写入 sessionStorage、刷新后复位（以宿主 /runs 为权威）', () => {
  const { storage, raw } = makeStorage()
  const first = new RunStore({ storage })
  first.patch({
    panel: 'snapshots',
    snapshots: {
      selectedId: 'snap-1', running: true,
      importBackup: { zipPath: '/exports/x.zip', name: 'x.zip' },
    },
  })
  const persisted = JSON.parse(raw() ?? '{}') as { snapshots?: { running?: boolean; importBackup?: unknown } }
  assert.equal(persisted.snapshots?.running, false, 'running 恒不落盘（白名单剔除）')
  assert.equal(persisted.snapshots?.importBackup, null, 'importBackup 恒不落盘（一次性瞬态剔除）')

  // 即便旧载荷携带 running=true / importBackup，applyPersisted 也硬性归零——绝不把浏览器
  // 陈旧状态当成「恢复仍在执行」的依据（宿主 /runs 是唯一权威，resume() 负责重新置位）
  storage.setItem(STATE_KEY, JSON.stringify({
    ...persisted,
    snapshots: {
      ...persisted.snapshots,
      running: true,
      importBackup: { zipPath: '/exports/stale.zip', name: 'stale.zip' },
    },
  }))
  const second = new RunStore({ storage })
  assert.equal(second.getSnapshot().snapshots.running, false, '刷新后 running 复位（不读存储）')
  assert.equal(second.getSnapshot().snapshots.importBackup, null, '刷新后 importBackup 复位（不读存储）')
  assert.equal(second.getSnapshot().snapshots.selectedId, 'snap-1', '非瞬态字段仍恢复')
})

test('m2-resume: 活跃 restore run 经 /runs 恢复 running 并轮询到完成回填报告（宿主为权威）', async () => {
  const report: RestoreReport = {
    snapshotId: 'snap-1',
    restored: ['settings.yaml'],
    removedPlugins: ['@scope/pkg'],
    manualHints: [],
    failed: [],
    skipped: [],
  }
  const progressResponses: RunState[] = [
    runningRun('restore', { section: 'restore', item: 1, itemTotal: 3, detail: '整文件还原 settings.yaml' }),
    {
      runId: RUN_ID, kind: 'restore', status: 'done',
      section: null, sectionTotal: null, item: null, itemTotal: null, detail: null, log: [],
      result: report, createdAt: 1, updatedAt: 3,
    },
  ]
  let progressCalls = 0
  const api = makeApi({
    runs: async () => [runningRun('restore')],
    progress: async () => progressResponses[Math.min(progressCalls++, progressResponses.length - 1)]!,
  })
  const store = new RunStore({ storage: null, pollIntervalMs: 5 })
  const resumed = await store.resume(api)
  assert.equal(resumed, true, '发现活跃 restore run')
  assert.equal(store.getSnapshot().snapshots.running, true, 'running 镜像置位（宿主 /runs 为权威）')

  await sleep(80)
  const snap = store.getSnapshot().snapshots
  assert.equal(snap.running, false, '完成后 running 复位')
  assert.deepEqual(snap.report?.restored, ['settings.yaml'], '恢复报告回填 store')
  assert.equal(snap.actionError, null)
})

test('m2-resume: store 镜像显示恢复中但 host 无活跃 restore run → 复位并提示不可恢复', async () => {
  const api = makeApi({ runs: async () => [] })
  const store = new RunStore({ storage: null })
  store.patch({ snapshots: { running: true } })
  const resumed = await store.resume(api)
  assert.equal(resumed, false)
  const snap = store.getSnapshot().snapshots
  assert.equal(snap.running, false, '无宿主 run 时 running 复位（不残留 UI 假状态）')
  assert.ok(snap.actionError !== null, '如实提示结果不可恢复')
})
