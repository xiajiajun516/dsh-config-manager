/**
 * 本机路径选择弹窗（导入 → 路径映射 → 每条「新路径」右侧的文件夹按钮）。
 *
 * 为什么需要它
 * ------------
 * 路径映射要求用户给一堆**绝对路径**指定本机新位置，而浏览器拿不到真实路径
 * （File System Access API 只给 handle，`<input type="file">` 只给文件名）。此前用户只能凭记忆
 * 手打 `D:\\Apps\\nodejs\\node_global\\gitnexus.cmd` 这类字符串 —— 打错一位就等于「导不进」。
 * 目录列举由宿主 `GET /path-browse` 提供（src/core/path-browse.ts，只读、有界），本组件只画界面。
 *
 * 交互约定
 * --------
 * - 点目录 = 进入；点文件 = 直接选中（原路径可能指向文件，如 .cmd / .json）；
 * - 「使用当前目录」回填当前目录；「上一层」「主目录」是导航快捷入口；
 * - 起点 `startPath` 若是文件或不存在，宿主会同时给出 `parent`，这里上浮一层再列（只自动上浮一次，
 *   免得用户在空目录里被反复弹走）。
 *
 * 边界：组件不发请求做判断，不创建/改名/删除任何东西；错误码由字典翻译（引擎不产文案）。
 */
import { useEffect, useRef, useState } from 'react'
import type { BrowseErrorCode, BrowseResult } from '../../core/path-browse.ts'
import type { ConfigManagerApi } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { Modal } from '../common/Modal.tsx'
import { Banner, Button, Spinner } from '../common/ui.tsx'
import { FileIcon, FolderIcon } from '../common/Icon.tsx'
import css from '../config-manager.module.css'

/** 列举失败原因码 → 字典键（与 core 的 `BrowseErrorCode` 一一对应）。 */
const BROWSE_ERROR_LABEL: Record<BrowseErrorCode, Parameters<TranslateNS<'config-manager'>>[0]> = {
  'not-found': 'import.paths.picker.notFound',
  denied: 'import.paths.picker.denied',
  failed: 'import.paths.picker.failed',
  'not-absolute': 'import.paths.picker.notAbsolute',
}

/** 列举状态机（加载中 / 有结果 / 传输失败）。 */
type BrowseState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: BrowseResult }
  | { kind: 'failed'; detail: string }

/**
 * 只需要两个方法：内置浏览器列举 + 原生选择器（两者是**同一条**宿主端点的 GET / POST 形态）。
 * 这样测试替身只碰这两个方法，其余 API 一概不进入组件视野。
 */
export type PathBrowsePort = Pick<ConfigManagerApi, 'browsePath' | 'pickNativePath'>

export interface PathPickerDialogProps {
  open: boolean
  api: PathBrowsePort
  t: TranslateNS<'config-manager'>
  /** 起点：输入框现值（可能是文件、可能是别的机器的路径、可能为空） */
  startPath: string
  /** 选中（目录或文件）—— 由调用方回填输入框；本组件不自行关闭弹窗 */
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * 目录浏览弹窗：列一层目录，点目录进入、点文件选中。
 */
export function PathPickerDialog({ open, api, t, startPath, onPick, onClose }: PathPickerDialogProps) {
  const [current, setCurrent] = useState<string | null>(null)
  const [state, setState] = useState<BrowseState>({ kind: 'loading' })
  // 自动上浮只做一次：记录已经为哪个起点上浮过（避免空目录/不存在路径来回弹）
  const risenFor = useRef<string | null>(null)

  const trimmedStart = startPath.trim()

  // 打开时把起点落到当前目录（关闭状态下不动，避免清掉上次浏览位置造成闪烁）
  useEffect(() => {
    if (!open) return
    risenFor.current = null
    setCurrent(trimmedStart === '' ? null : trimmedStart)
  }, [open, trimmedStart])

  useEffect(() => {
    if (!open) return
    let alive = true
    setState({ kind: 'loading' })
    api.browsePath(current ?? undefined).then(
      (data) => {
        if (!alive) return
        // 起点是文件或不存在：宿主给出的 parent 就是「该去哪」，上浮一层再列（一次性）
        if (
          data.error === 'not-found'
          && data.path === trimmedStart
          && data.parent !== null
          && risenFor.current !== data.path
        ) {
          risenFor.current = data.path
          setCurrent(data.parent)
          return
        }
        setState({ kind: 'ready', data })
      },
      (error: unknown) => {
        if (!alive) return
        setState({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { alive = false }
  }, [open, current, trimmedStart, api])

  const data = state.kind === 'ready' ? state.data : null
  const atRoots = data !== null && data.path === ''
  const canGoUp = data !== null && data.parent !== null
  const pathLabel = atRoots ? t('import.paths.picker.thisPc') : (data?.path ?? trimmedStart)

  return (
    <Modal open={open} onClose={onClose} title={t('import.paths.picker.title')} wide>
      <Modal.Header title={t('import.paths.picker.title')} onClose={onClose} closeLabel={t('common.close')} />
      <Modal.Body scroll style={{ maxHeight: '56vh' }}>
        <div className={css.pickerPath} title={pathLabel}>{pathLabel}</div>
        {state.kind === 'loading' && <Spinner label={t('common.loading')} />}
        {state.kind === 'failed' && <Banner kind="error">{state.detail}</Banner>}
        {state.kind === 'ready' && (
          <>
            {state.data.error !== null && <Banner kind="warn">{t(BROWSE_ERROR_LABEL[state.data.error])}</Banner>}
            {state.data.error === null && state.data.truncated && (
              <Banner kind="info">{t('import.paths.picker.truncated', { count: String(state.data.entries.length) })}</Banner>
            )}
            {state.data.error === null && state.data.entries.length === 0 && (
              <div className={css.empty}>{t('import.paths.picker.empty')}</div>
            )}
            {state.data.entries.length > 0 && (
              <div className={css.pickerList}>
                {state.data.entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={css.pickerRow}
                    data-kind={entry.kind}
                    title={entry.path}
                    onClick={() => {
                      if (entry.kind === 'dir') setCurrent(entry.path)
                      else onPick(entry.path)
                    }}
                  >
                    {entry.kind === 'dir' ? <FolderIcon size={14} /> : <FileIcon size={14} />}
                    <span className={css.pickerName}>{entry.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={() => { if (data?.parent != null) setCurrent(data.parent) }} disabled={!canGoUp}>
          {t('import.paths.picker.up')}
        </Button>
        <Button onClick={() => { if (data !== null) setCurrent(data.home) }} disabled={data === null}>
          {t('import.paths.picker.home')}
        </Button>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        {/* 根列表（「此电脑」）本身不是可映射目录：没有「当前目录」可回填 */}
        <Button
          variant="primary"
          disabled={data === null || atRoots}
          onClick={() => { if (data !== null) onPick(data.path) }}
        >
          {t('import.paths.picker.useCurrent')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
