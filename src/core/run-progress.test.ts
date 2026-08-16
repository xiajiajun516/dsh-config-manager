/**
 * m4 测试补齐（任务 t4）：m1 真实进度埋点 —— Exporter onSection / Analyzer onItem。
 *
 * 背景：m1 在 core 侧加入进度埋点（exporter.ts onSection、analyzer.ts onItem，
 * importer.ts 透传），Host 路由用它们更新 RunRegistry（/progress 轮询数据源，
 * m2 store / m3 ProgressBar 徽章消费）。既有 tests/core/exporter.test.ts 与
 * tests/core/importer.test.ts 未覆盖埋点的参数语义与「埋点失败不影响业务」的
 * 容错保证，本文件补齐（仅新增测试，不改业务代码）。
 *
 * 覆盖（验收 m4-green）：
 *  - Exporter.onSection：每导出一个选中分区前调用一次；index 从 1 起严格递增、
 *    total=选中分区总数、section=adapter id；only 过滤时只对选中分区触发；
 *    回调抛错不得中断导出（进度是尽力而为）；
 *  - Analyzer.executeImportPlan onItem（经 Importer 透传）：每个计划项完成后调用；
 *    index 1-based 递增、total=将执行计划项总数（含 skip 类信息项）、
 *    status=该项实际状态（ok/skipped…）、detail=计划项 id；
 *    冲突未解决（skipped）与缺失秘密（skipped）同样计数；
 *    回调抛错不得中断导入执行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Exporter, type SectionProgress } from './exporter.ts'
import { Importer } from './importer.ts'
import type { PlanItemProgress } from './analyzer.ts'
import { createAdapters } from '../adapters/index.ts'
import { makeContext, MemSnapshotStore, type MockHostContext } from '../adapters/test-helpers.ts'
import type { ImportPlan } from './types.ts'

const NS = ['general', 'llm-deepseek']

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-run-progress-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** 最小源：settings(general + llm-deepseek 带 apiKeyEnv/secret 标记) + credentials
 * （llm-deepseek 的 secret 标记使 credentialsStatus 分区产生 configured 凭据，
 * 导入时成为 MissingSecret 补录占位 —— 与 tests/core/importer.test.ts 的 I-01 同款） */
async function seedSource(ctx: MockHostContext): Promise<void> {
  ctx.settings.ns.set('general', { value: { theme: 'dark', language: 'zh-CN' }, revision: 3, secrets: [] })
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  })
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-value-123')
}

async function exportFixture(src: MockHostContext, outPath: string): Promise<void> {
  const adapters = createAdapters({ namespaces: NS })
  await new Exporter({ ctx: src, adapters, now: () => new Date('2026-08-14T12:00:00.000Z') })
    .export({ includeSecrets: false, outPath })
}

/** 与 Importer 默认参数一致的目标侧 importer */
function makeImporter(dst: MockHostContext): Importer {
  return new Importer({
    ctx: dst,
    adapters: createAdapters({ namespaces: NS }),
    snapshotStore: new MemSnapshotStore(),
  })
}

/* ================================================= Exporter onSection 埋点 */

test('m1 埋点: onSection 每导出一个选中分区前调用（index 1-based 递增、total=选中数、section=adapter id）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice')
    await seedSource(src)
    const adapters = createAdapters({ namespaces: NS })
    const selected = adapters.filter((a) => a.defaultIncluded).map((a) => a.id)
    assert.ok(selected.length >= 2, '默认选中分区应 ≥2（本最小源至少 settings+credentialsStatus）')

    const calls: SectionProgress[] = []
    await new Exporter({
      ctx: src,
      adapters,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      onSection: (info) => { calls.push(info) },
    }).export({ includeSecrets: false, outPath: path.join(dir, 'sections.zip') })

    assert.equal(calls.length, selected.length, '每个选中分区都应触发一次 onSection')
    calls.forEach((c, i) => {
      assert.equal(c.index, i + 1, `index 从 1 起严格递增（第 ${i} 次调用）`)
      assert.equal(c.total, selected.length, 'total=选中分区总数')
      assert.equal(c.section, selected[i], 'section=当前 adapter id，顺序与导出顺序一致')
    })
  })
})

test('m1 埋点: only 过滤时只对选中分区触发（index/total 按选中集计算）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('linux', '/home/alice')
    await seedSource(src)
    const adapters = createAdapters({ namespaces: NS })
    const only = ['settings', 'plugins'] as const

    const calls: SectionProgress[] = []
    await new Exporter({
      ctx: src,
      adapters,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      onSection: (info) => { calls.push(info) },
    }).export({ includeSecrets: false, only: [...only], outPath: path.join(dir, 'only.zip') })

    assert.equal(calls.length, only.length, '只对 only 中选中的分区触发')
    assert.deepEqual(calls.map((c) => c.section), [...only], '触发顺序与 adapters 注册顺序一致')
    for (const c of calls) {
      assert.equal(c.total, only.length, 'total=only 过滤后的选中分区数')
    }
    assert.equal(calls[0]?.index, 1, 'only 集内 index 从 1 起')
  })
})

test('m1 埋点: onSection 抛错不影响导出（进度是尽力而为）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice')
    await seedSource(src)
    const adapters = createAdapters({ namespaces: NS })
    let calls = 0

    const result = await new Exporter({
      ctx: src,
      adapters,
      now: () => new Date('2026-08-14T12:00:00.000Z'),
      onSection: (info) => {
        calls += 1
        if (calls === 1) throw new Error('埋点回调故障')
      },
    }).export({ includeSecrets: false, outPath: path.join(dir, 'resilient.zip') })

    assert.ok(calls > 0, '埋点被触发过')
    assert.ok(result.zipPath.endsWith('.zip'), '导出仍成功完成')
    const stat = await fs.stat(result.zipPath)
    assert.ok(stat.size > 0, 'ZIP 正常落盘')
  })
})

/* ================================================= Analyzer onItem 埋点 */

test('m1 埋点: onItem 每个计划项完成后调用（index 递增、total=计划项数、status/detail 正确）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice')
    await seedSource(src)
    const zipPath = path.join(dir, 'items.zip')
    await exportFixture(src, zipPath)

    const dst = makeContext('win32', 'C:\\Users\\bob')
    dst.settings.registered.add('general')
    dst.settings.registered.add('llm-deepseek')
    const importer = makeImporter(dst)

    const plan: ImportPlan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })
    assert.ok(plan.items.length > 0, '计划应包含待执行项')

    const calls: PlanItemProgress[] = []
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      onItem: (info) => { calls.push(info) },
    })

    assert.equal(result.ok, true, '导入成功')
    assert.equal(calls.length, plan.items.length, '每个计划项都应触发一次 onItem')
    calls.forEach((c, i) => {
      assert.equal(c.index, i + 1, 'index 从 1 起严格递增')
      assert.equal(c.total, calls.length, 'total=将执行计划项总数（含 skip 类信息项）')
      assert.ok(
        c.status === 'ok' || c.status === 'skipped' || c.status === 'warning' || c.status === 'failed',
        `status 应为合法值，实际 ${c.status}`,
      )
      assert.ok(typeof c.detail === 'string' && c.detail !== '', 'detail=计划项 id（非敏感）')
    })
  })
})

test('m1 埋点: 冲突未解决（skipped）与缺失秘密（skipped）同样计数', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice')
    await seedSource(src)
    const zipPath = path.join(dir, 'conflict.zip')
    await exportFixture(src, zipPath)

    const dst = makeContext('win32', 'C:\\Users\\bob')
    // 目标已有同名 general → merge 无决策 → Conflict → skipped
    dst.settings.ns.set('general', { value: { theme: 'light' }, revision: 7, secrets: [] })
    const importer = makeImporter(dst)

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })
    assert.ok(plan.items.some((i) => i.id === 'settings:general' && i.kind === 'Conflict'), '应有未决策冲突项')
    assert.ok(plan.items.some((i) => i.kind === 'MissingSecret'), '应有缺失秘密补录占位')

    const calls: PlanItemProgress[] = []
    await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      onItem: (info) => { calls.push(info) },
    })

    const conflict = calls.find((c) => c.detail === 'settings:general')
    assert.equal(conflict?.status, 'skipped', '冲突未解决 → skipped 且上报')
    const secret = calls.find((c) => c.detail === 'secret:DEEPSEEK_API_KEY')
    assert.equal(secret?.status, 'skipped', '秘密未补录 → skipped 且上报（不泄露值）')
    // skipped 项同样占用 index/total 计数（进度条整体推进）
    assert.ok(conflict !== undefined && conflict.index > 0, '冲突项计入进度计数')
    assert.ok(secret !== undefined && secret.index > conflict!.index, '秘密项在冲突项之后计数')
  })
})

test('m1 埋点: onItem 抛错不影响导入执行（进度是尽力而为）', async () => {
  await withTmp(async (dir) => {
    const src = makeContext('win32', 'C:\\Users\\alice')
    await seedSource(src)
    const zipPath = path.join(dir, 'resilient.zip')
    await exportFixture(src, zipPath)

    const dst = makeContext('win32', 'C:\\Users\\bob')
    dst.settings.registered.add('general')
    dst.settings.registered.add('llm-deepseek')
    const importer = makeImporter(dst)

    const plan = await importer.createImportPlan(zipPath, { strategy: 'merge', resolutions: {}, pathMappings: [] })
    const result = await importer.executeImportPlan(zipPath, plan, {
      confirm: true,
      onItem: () => { throw new Error('埋点回调故障') },
    })

    assert.equal(result.ok, true, '导入不受埋点故障影响')
    assert.deepEqual(dst.settings.ns.get('general')?.value, { theme: 'dark', language: 'zh-CN' }, '数据正常写入')
  })
})
