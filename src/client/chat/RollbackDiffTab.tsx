/**
 * DSH 右侧栏「回滚差异」标签页的正文（只读；内容 = 该回退点里一个记录在案文件的前后对照）。
 *
 * 目标来自标签页自己的**资源地址**（`dsh-resource://cm-rollback-diff/<pointId>/<path>`）——
 * 地址由 seat 通过 `useTabInfo` 给出，所以同一个文件开两个标签、或从历史布局恢复标签都能各自取到
 * 自己的目标；**拿不到地址**时如实说「读不出来」，绝不用全局变量猜一个文件给用户看。
 *
 * 地址解析与打开动作在 `rollback-diff-tab.ts`（纯函数、node 单测）；本文件只做取数与装配。
 */
import { useEffect, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { RollbackFileDiffResult, RollbackPointPort } from '../../ui/rollback-view.ts'
import { Empty } from '../common/ui.tsx'
import { parseRollbackDiffAddress } from './rollback-diff-tab.ts'
import { RollbackDiffPane, type RollbackDiffState } from '../recovery/RollbackDiffPane.tsx'

/** 装配点注入面（端口的读差异方法 + recovery 字典）。 */
export interface RollbackDiffTabInjected {
  port: RollbackPointPort
  rt: TranslateNS<'config-manager-recovery'>
}

/** 完整 props：注入面 + 侧栏 seat 提供的 tab 信息钩子（可能不存在）。 */
export type RollbackDiffTabProps = RollbackDiffTabInjected & {
  useTabInfo?: () => { tab?: { contentId?: unknown } }
}

/** 从 seat 的 tab 信息钩子里读资源地址（钩子缺失 / 抛错一律当「读不到」，不猜）。 */
function readContentId(useTabInfo: RollbackDiffTabProps['useTabInfo']): unknown {
  if (typeof useTabInfo !== 'function') return undefined
  try {
    return useTabInfo()?.tab?.contentId
  } catch {
    return undefined
  }
}

export function RollbackDiffTab({ port, rt, useTabInfo }: RollbackDiffTabProps) {
  const contentId = readContentId(useTabInfo)
  const target = parseRollbackDiffAddress(contentId)
  const [state, setState] = useState<RollbackDiffState>({ status: 'loading' })
  useEffect(() => {
    if (target === null) return
    const read = port.rollbackPointFileDiff
    if (typeof read !== 'function') {
      // 端口没实现这条能力（旧宿主）：如实说读不出来，绝不显示空白装成「没有差异」
      setState({ status: 'error', message: null })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    const pending: Promise<RollbackFileDiffResult> = read.call(port, target.pointId, target.path)
    pending.then(
      (diff) => { if (alive) setState({ status: 'ready', diff }) },
      (error: unknown) => { if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
    return () => { alive = false }
  }, [port, contentId])
  if (target === null) return <Empty>{rt('rollback.diff.failed')}</Empty>
  // 侧栏标签页的空间里没有别处写路径（标签标题会被截断），文件头由差异表自己画
  return <RollbackDiffPane state={state} rt={rt} title={target.path} />
}
