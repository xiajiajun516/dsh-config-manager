/**
 * import-file-reselection：导入文件选择的纯逻辑单测（node --test，无 DOM）。
 *
 * 覆盖验收：
 *  - import-reselect-works：选文件 A → 取消选择 → 换选文件 B → 最终提交的是 B；
 *  - 选择/换选时清空 input value → 同一文件再次选择也会触发 onChange；
 *  - 未选文件（关闭对话框）保持原选择；取消选择回 idle。
 *
 * 与 src/client/sync/sync-view.test.ts 同模式：被测对象是 import-file-select.ts
 * 的无副作用纯函数；「选 A → 取消 → 换选 B → 提交 B」的接线用 RunStore +
 * ImportWizard + mock api 模拟组件驱动的真实流程（纯逻辑可测，无需浏览器）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { RunStore } from '../run-store.ts'
import type { ConfigManagerApi, UploadResponse } from '../api.ts'
import type { RunState } from '../../core/run-registry.ts'
import type { ImportWizard } from '../../ui/import-wizard.ts'
import { makeAnalysis, makeImportResult, makePlan } from '../../ui/test-helpers.ts'
import {
  applyPickedFile,
  browseLabelKey,
  cancelSelection,
  consumePickedFile,
  fileSelectModel,
  type FileSelectModel,
} from './import-file-select.ts'

/* ------------------------------------------------------------- fixtures */

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

/**
 * 模拟 ImportWizardView 中 onPickFile 对一次文件选择的驱动流程
 * （含 onChange 入口的 consumePickedFile 与选中状态的 applyPickedFile）：
 * 清空 input → 上传 → selectZip → 镜像回 store → 复位 uploading。
 * 返回更新后的选择模型（busy 已回落 false）。
 */
async function pickFile(
  store: RunStore,
  wizard: ImportWizard,
  api: ConfigManagerApi,
  model: FileSelectModel,
  file: File,
  input: { value: string } | null,
): Promise<FileSelectModel> {
  const picked = consumePickedFile(file, input)
  if (picked === undefined) return model
  const next = applyPickedFile(model, picked)
  store.patch({ import: { selectedFileName: next.selectedName, uploading: next.busy, error: null } })
  try {
    const uploaded: UploadResponse = await api.upload(picked)
    await wizard.selectZip(uploaded.zipPath)
    store.syncWizard()
  } catch (err) {
    store.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
    store.syncWizard()
  } finally {
    store.patch({ import: { uploading: false } })
  }
  return { selectedName: next.selectedName, busy: false }
}

const zip = (name: string): File => new File(['x'], name, { type: 'application/zip' })

/* ------------------------------------------- 核心修复：input value 恒清空 */

test('import-file-select: 选择文件后恒清空 input value（同一文件再次选择也会触发 onChange）', () => {
  const input = { value: 'C:\\fakepath\\a.zip' }
  const file = zip('a.zip')
  const picked = consumePickedFile(file, input)
  assert.equal(picked, file, '返回选中的文件')
  assert.equal(input.value, '', '选择后 input value 清空')
  // 同文件再次选择（模拟第二次 onChange）：不依赖 value，仍返回文件
  const again = consumePickedFile(file, input)
  assert.equal(again, file, '同一文件可再次触发选择')
})

test('import-file-select: 用户关闭文件对话框（无文件）→ 不返回文件，value 仍清空', () => {
  const input = { value: 'C:\\fakepath\\a.zip' }
  assert.equal(consumePickedFile(undefined, input), undefined)
  assert.equal(input.value, '', '对话框取消后 value 也清空')
})

/* ------------------------------------------------- 选择/换选/取消状态机 */

test('import-file-select: fileSelectModel 由 store 的 selectedFileName/uploading 推导', () => {
  assert.deepEqual(fileSelectModel(null, false), { selectedName: null, busy: false })
  assert.deepEqual(fileSelectModel('a.zip', true), { selectedName: 'a.zip', busy: true })
})

test('import-file-select: 换选文件 B 替换 A（提交的永远是最新选中的文件）', () => {
  let model: FileSelectModel = applyPickedFile(fileSelectModel(null, false), zip('a.zip'))
  assert.equal(model.selectedName, 'a.zip')
  assert.equal(model.busy, true, '选中后进入 busy（上传/分析）')
  model = applyPickedFile(model, zip('b.zip'))
  assert.equal(model.selectedName, 'b.zip', 'B 替换 A')
  // 未选文件（对话框取消）保持原选择
  model = applyPickedFile(model, undefined)
  assert.equal(model.selectedName, 'b.zip', '无文件时不改变选择')
})

test('import-file-select: 取消选择回 idle（可重新选择）', () => {
  assert.deepEqual(cancelSelection({ selectedName: 'a.zip', busy: true }), { selectedName: null, busy: false })
})

test('import-file-select: 浏览按钮文案随选择状态切换（重新选择 / 选择 ZIP 文件）', () => {
  assert.equal(browseLabelKey(false), 'import.select.browse')
  assert.equal(browseLabelKey(true), 'import.select.reselect')
})

/* --------------------------- 接线验收：选 A → 取消 → 换选 B → 提交的是 B */

test('import-reselect-works: 选 A → 取消选择 → 换选 B → 提交的是 B', async () => {
  const executedZip: string[] = []
  const api = makeApi({
    upload: async (file: File): Promise<UploadResponse> =>
      ({ zipPath: `/tmp/${file.name}`, name: file.name, sizeBytes: file.size }),
    analyzeImport: async (zipPath: string) => {
      assert.equal(zipPath, '/tmp/b.zip', '换选后只分析最新文件 B')
      return makeAnalysis()
    },
    createImportPlan: async (zipPath: string) => {
      assert.equal(zipPath, '/tmp/b.zip', '预览/执行计划基于最新文件 B')
      return makePlan()
    },
    executeImportPlan: async (zipPath: string) => {
      executedZip.push(zipPath)
      return { ...makeImportResult(), runId: 'run-1' }
    },
  })
  const store = new RunStore({ storage: null })
  const wizard = store.importWizard(api)
  const input = { value: '' }

  // 选 A
  let model: FileSelectModel = fileSelectModel(null, false)
  input.value = 'C:\\fakepath\\a.zip'
  model = await pickFile(store, wizard, api, model, zip('a.zip'), input)
  assert.equal(input.value, '', '选择 A 后 input 清空')
  assert.equal(store.getSnapshot().import.selectedFileName, 'a.zip')
  assert.equal(wizard.snapshot().zipPath, '/tmp/a.zip')

  // 取消选择 → 回 idle
  model = cancelSelection(model)
  store.patch({ import: { selectedFileName: model.selectedName, uploading: model.busy, error: null } })
  assert.equal(store.getSnapshot().import.selectedFileName, null, '取消后无已选文件')

  // 换选 B（同一 input 再次选择）
  model = await pickFile(store, wizard, api, model, zip('b.zip'), input)
  assert.equal(store.getSnapshot().import.selectedFileName, 'b.zip')
  assert.equal(wizard.snapshot().zipPath, '/tmp/b.zip', '控制器持有最新文件 B')

  // 提交 → 执行的是 B
  await wizard.confirmCompatibility()
  await wizard.execute({ confirm: true })
  assert.deepEqual(executedZip, ['/tmp/b.zip'], '提交的是 B 而非 A')
})

test('import-reselect-works: 取消后重新选择同一文件也生效（input value 已清空）', async () => {
  const uploaded: string[] = []
  const executedZip: string[] = []
  const api = makeApi({
    upload: async (file: File): Promise<UploadResponse> => {
      uploaded.push(file.name)
      return { zipPath: `/tmp/${file.name}`, name: file.name, sizeBytes: file.size }
    },
    analyzeImport: async () => makeAnalysis(),
    createImportPlan: async (zipPath: string) => {
      assert.equal(zipPath, '/tmp/a.zip')
      return makePlan()
    },
    executeImportPlan: async (zipPath: string) => {
      executedZip.push(zipPath)
      return { ...makeImportResult(), runId: 'run-1' }
    },
  })
  const store = new RunStore({ storage: null })
  const wizard = store.importWizard(api)
  const input = { value: '' }

  let model: FileSelectModel = fileSelectModel(null, false)
  input.value = 'C:\\fakepath\\a.zip'
  model = await pickFile(store, wizard, api, model, zip('a.zip'), input)
  model = cancelSelection(model)
  store.patch({ import: { selectedFileName: null, uploading: false, error: null } })

  // 同一文件 a.zip 再次选择 → onChange 仍触发（value 已清空）→ 上传再次发生
  model = await pickFile(store, wizard, api, model, zip('a.zip'), input)
  assert.deepEqual(uploaded, ['a.zip', 'a.zip'], '同一文件可被再次选择并上传')
  assert.equal(store.getSnapshot().import.selectedFileName, 'a.zip')

  await wizard.confirmCompatibility()
  await wizard.execute({ confirm: true })
  assert.deepEqual(executedZip, ['/tmp/a.zip'], '再次提交的是 a.zip')
})
