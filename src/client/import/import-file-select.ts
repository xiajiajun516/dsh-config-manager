/**
 * 导入文件选择（select 步骤）的纯渲染/流转模型（import-file-reselection）。
 *
 * 修复的 bug：导入向导选择文件后无法取消/换选 —— 没有入口，且文件 input 的
 * value 未清空（同一文件再次选择不触发 onChange）。
 *
 * 与 src/client/sync/sync-view.ts 同模式：无副作用纯函数，node --test 直接测，
 * React 组件只做装配与 DOM 副作用（input value 的读写经 consumePickedFile
 * 收敛，传入真实 e.target 即可）。换选不变式：每次 onChange 都以最新选中的
 * 文件为准 —— 提交的永远是最新选中的文件。
 */
import type { ConfigManagerKey } from '../locales.ts'

/** select 步骤的展示/流转模型。 */
export interface FileSelectModel {
  /** 已选备份文件名（null = 尚未选择） */
  selectedName: string | null
  /** 上传/分析进行中（浏览按钮禁用；仍可取消） */
  busy: boolean
}

/** 由 store 状态推导 select 步骤的展示模型（selectedFileName + uploading）。 */
export function fileSelectModel(selectedName: string | null, busy: boolean): FileSelectModel {
  return { selectedName, busy }
}

/**
 * 处理文件选择（input onChange 入口）：
 * - **恒清空 input 的 value** —— 同一文件再次选择也会触发 onChange（同文件换选）；
 * - 返回选中的文件；用户关闭文件对话框（无文件）返回 undefined。
 * input 以最小接口 `{ value: string }` 传入，纯逻辑可测；React 侧传真实 e.target。
 */
export function consumePickedFile(file: File | undefined, input: { value: string } | null): File | undefined {
  if (input !== null) input.value = ''
  return file
}

/**
 * 选中/换选后的状态：以新文件替换旧选择（提交的永远是最新选中的文件）；
 * 未选文件（对话框取消）保持原状态不变。
 */
export function applyPickedFile(current: FileSelectModel, file: File | undefined): FileSelectModel {
  if (file === undefined) return current
  return { selectedName: file.name, busy: true }
}

/** 取消选择：清空选择与忙碌态（回 idle；UI 同时清空 input value 保证同文件可重选）。 */
export function cancelSelection(current: FileSelectModel): FileSelectModel {
  return { selectedName: null, busy: false }
}

/** 浏览按钮文案键：已选文件 → 重新选择；否则 → 选择 ZIP 文件。 */
export function browseLabelKey(hasSelection: boolean): ConfigManagerKey {
  return hasSelection ? 'import.select.reselect' : 'import.select.browse'
}
