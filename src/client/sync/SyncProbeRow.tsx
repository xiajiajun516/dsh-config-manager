/**
 * cloud-sync 借鉴项 ②：**测试连接**行（只读连通性自检）。
 *
 * 为什么要它：同步失败时用户此前只能靠「push/pull 报错」反推通道是否可达 —— 端点写错、
 * 桶不存在、凭据没配、目标目录不存在，症状都是同一句失败。这里给一个**非破坏性**自检入口，
 * 并把通道层本地化好的结论直接展示（S3 兼容端点该填哪个 region 这类信息只有通道层知道）。
 *
 * 三条纪律：
 *  1. **失败是正常结论**（HTTP 200 + ok:false）→ 绝不落进 catch 当成崩溃；
 *  2. 自检**可能写远端**（webdav 幂等 MKCOL 补齐上级目录）→ createdCollections 必须逐条说明，
 *     绝不静默（「测试连接」把远端目录建出来是用户有权知道的事实）；
 *  3. hint 是「需要注意但没失败」的信息 → 与主结论分开展示（card 形态用 warn 横幅；
 *     action 形态追加在同一句 toast 里），不和成功文案混成一句。
 *
 * 两种展示形态（presentation）：
 *  - 'card'（缺省）：动作行 + **内联结果**（Banner / ErrorBanner）—— 独立入口用；
 *  - 'action'：**只渲染按钮 + ⓘ**（供并入别的动作行），结果改走 toast：主结论 + hint +
 *    自动创建的目录 + 快照数一句讲完，一条都不省。
 *
 * 文案全部走 config-manager-sync 字典；本组件不写任何样式（复用既有原语与卡片内类名）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncApi, SyncProbeResult, SyncPushPayload } from './sync-api.ts'
import { Banner, Button, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { projectProbeResult } from './probe-view.ts'
import { toast } from '../common/toast-store.ts'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface SyncProbeRowProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 与 push/pull 同一份通道请求体（由 SyncPanel 组装） */
  body: SyncPushPayload
  /** 该通道远端地址是否就绪（未就绪时按钮禁用） */
  remoteReady: boolean
  /** 页面忙（同步/推送在途）时不发请求 */
  busy: boolean
  /**
   * 展示形态（缺省 'card' = 既有行为，向后兼容）：
   *  - 'card'：动作行 + 内联结果横幅；
   *  - 'action'：只渲染按钮 + ⓘ（嵌进别的动作行），结果走 toast。
   */
  presentation?: 'card' | 'action'
}

export function SyncProbeRow({ api, t, body, remoteReady, busy, presentation = 'card' }: SyncProbeRowProps): ReactNode {
  const actionMode = presentation === 'action'
  const [result, setResult] = useState<SyncProbeResult | null>(null)
  const [loading, setLoading] = useState(false)
  const /** 传输层异常（与「自检结论 = 失败」分开：前者是宿主/网络没走通，后者是通道层给出的结论） */
    [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  /**
   * action 形态的结果通道：**一句 toast 讲完**（主结论 + hint + 自动创建的目录 + 快照数）。
   * createdCollections 绝不省 —— 这是本动作唯一可能写远端的路径，用户有权知道。
   * 中性态（该通道不提供自检）走 ok 通道 + 同一句里的能力边界说明，绝不渲染成「操作失败」。
   */
  const toastResult = useCallback((res: SyncProbeResult): void => {
    const v = projectProbeResult(res, t('probe.unsupported'))
    const parts = [redact(v.message)]
    if (v.hint !== undefined) parts.push(redact(v.hint))
    if (v.unsupported) parts.push(t('probe.unsupportedHint'))
    if (v.createdCollections.length > 0) {
      parts.push(t('probe.createdCollections', { list: v.createdCollections.map((c) => redact(c)).join(t('common.listSeparator')) }))
    }
    if (v.snapshotCount !== undefined) parts.push(t('probe.snapshotCount', { count: String(v.snapshotCount) }))
    const text = parts.join(t('common.labelSeparator'))
    if (v.tone === 'error') toast.error(text)
    else toast.ok(text)
  }, [t])

  const run = useCallback(async (): Promise<void> => {
    if (!remoteReady) return
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const res = await api.probe(body)
      if (!mountedRef.current || seq !== seqRef.current) return
      setResult(res)
      setError(null)
      if (actionMode) toastResult(res)
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (actionMode) toast.error(redact(message))
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [api, body, remoteReady, actionMode, toastResult])

  /**
   * 渲染规则全在纯函数里（可单测）：成功 / hint / 自动创建的目录 / 不支持自检 / 真失败**五态分开**。
   * 兜底文案只在这里解析（纯模块不碰字典）：宿主没给 error 时用字典键的本地化文案。
   */
  const view = result === null ? null : projectProbeResult(result, t('probe.unsupported'))

  const button = (
    <Button onClick={() => { void run() }} disabled={busy || loading || !remoteReady}>
      {loading ? <Spinner label={t('probe.running')} /> : t('probe.run')}
    </Button>
  )
  const hintNode = <InfoHint text={t('probe.hint')} label={t('common.infoHint')} />

  return (
    <>
      {/* action 形态：直接摊进调用方自己的动作行（不再套一层 .actionRow），结果走 toast */}
      {actionMode
        ? <>{button}{hintNode}</>
        : <div className={css.actionRow}>{button}{hintNode}</div>}
      {!actionMode && error !== null && (
        <ErrorBanner
          error={redact(error)}
          onRetry={() => { void run() }}
          retrying={loading}
          t={api.t}
        />
      )}
      {/* 能力边界**不是**故障：中性 info 横幅 + 一句解释，绝不显示「操作失败」 */}
      {!actionMode && view !== null && view.tone === 'info' && (
        <>
          <Banner kind="info">{redact(view.message)}</Banner>
          <div className={css.hint}>{t('probe.unsupportedHint')}</div>
        </>
      )}
      {!actionMode && view !== null && (view.tone === 'ok' || view.tone === 'warn') && (
        <>
          <Banner kind="ok">{redact(view.message)}</Banner>
          {view.hint !== undefined && <Banner kind="warn">{redact(view.hint)}</Banner>}
          {/* 自检期间自动创建了远端目录：逐条列出（这是唯一可能有写副作用的路径，绝不静默） */}
          {view.createdCollections.length > 0 && (
            <div className={css.hint}>
              {t('probe.createdCollections', {
                list: view.createdCollections.map((c) => redact(c)).join(t('common.listSeparator')),
              })}
            </div>
          )}
          {view.snapshotCount !== undefined && (
            <div className={css.hint}>{t('probe.snapshotCount', { count: String(view.snapshotCount) })}</div>
          )}
        </>
      )}
      {/* 失败 = 诊断结论：ok:false 是**预期结果**，必须当结论展示（绝不是崩溃/未知错误） */}
      {!actionMode && view !== null && view.tone === 'error' && (
        <ErrorBanner
          error={redact(view.message)}
          onRetry={() => { void run() }}
          retrying={loading}
          t={api.t}
        />
      )}
    </>
  )
}
