/**
 * 「会话体检」入口卡（T5/T10）—— 从 RecoveryPanel.tsx 拆出的独立文件（tech-debt #7）。
 *
 * 职责边界：卡片只留入口与一行摘要，整屏结果与全部动作都在 SessionHealthDialog。
 * 弹窗**只在打开时挂载**是刻意的：常驻会让卡片每次重渲染都拖着整屏内容一起走（真机反馈是整个设置页变空白）。
 * 本卡片不做业务判断：严重级 / 摘要 / 空态 / 截断全在 `ui/session-inventory-view.ts` 的纯函数里，
 * 拆分前后渲染分支逐字未改。
 */
import { useEffect, useRef, useState } from 'react'
import type { TranslateNS } from '../client-types.ts'
import { Badge, Button, Card } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { sessionHealthSummaryView, sessionRepairEntries, type SessionHealthResponse } from '../../ui/session-inventory-view.ts'
import type { SessionExportProbe } from '../session-export/session-export-view.ts'
import type { LayoutRecoveryApi } from './recovery-api.ts'
import { SessionHealthDialog } from './SessionHealthDialog.tsx'
import css from '../config-manager.module.css'

/** 卡片 props：与拆分前 `Pick<RecoveryPanelProps, ...>` 等价（面板只透传这四项）。 */
export interface SessionHealthCardProps {
  recoveryApi: LayoutRecoveryApi
  t: TranslateNS<'config-manager-recovery'>
  copyT?: TranslateNS<'config-manager'>
  diskApi: import('../api.ts').ConfigManagerApi
}

/**
 * 「会话体检」区块（T5）—— 事故恢复子 tab 的只读扫描。
 *
 * 数据流：`recoveryApi.sessions()`（只读路由）→ `ui/session-inventory-view.ts` 的展示模型 → 渲染。
 * **本组件不做任何业务判断**（严重级/摘要/空态/截断全在纯函数里），只装配 + 交互状态。
 *
 * 硬约束（known-gaps G-24 / T8 / T9）：应用内只做**能从字节证明**的修复 —— 零损失（重放重复行 /
 * 可证明的合成收尾块）与**有损截断**（seq 空洞 / 不可解析行，必须用户显式确认）；
 * 每一条都过服务层的写入门与预览-应用指纹，另有备份可一键回滚。其余类别只提供「复制离线命令」。
 */
/**
 * 缺省剪贴板翻译器：本区块只用到「复制成功/失败」两条通用反馈，且**绝不**编造主字典之外的键。
 * 返回键名本身（与字典缺键时的回退语义一致），保证缺省路径也不会抛错或渲染出空文案。
 */
const EMPTY_COPY_T: TranslateNS<'config-manager'> = ((key: string) => key) as TranslateNS<'config-manager'>
export function SessionHealthCard({ recoveryApi, t, copyT, diskApi }: SessionHealthCardProps) {
  /**
   * 剪贴板反馈的翻译器（config-manager 命名空间）。缺省 = `EMPTY_COPY_T`（**返回键名本身**，
   * 与字典缺键的回退语义一致）—— 不传 copyT 时渲染的是键名，缺省路径不会出现中文。
   */
  const clipboardT = copyT ?? EMPTY_COPY_T
  /** 体检结果住**卡片**里：弹窗每次打开重新扫一遍（scanVersion 变化即重扫），关掉不留一屏陈旧数据。 */
  const [response, setResponse] = useState<SessionHealthResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [scanVersion, setScanVersion] = useState(0)
  const scan = (): void => { setScanVersion((v) => v + 1) }
  /**
   * F-2：官方 session.export 端的可用性探测（一次；打开弹窗时顺带探）。
   *
   * 为什么**只在打开弹窗时**探：探测要走一次宿主自请求，用户没进这个界面时毫无意义；
   * 而进程内缓存（setState 在卡片上）保证同一次对话里只探一次 —— 后端能力不会中途变化。
   * 探测失败（网络/宿主异常）**不写 error**：它是「下载入口的可用性未知」，不是体检失败。
   */
  const [zipProbe, setZipProbe] = useState<SessionExportProbe | null>(null)
  const zipChecked = useRef(false)
  useEffect(() => {
    if (!open || zipChecked.current) return
    zipChecked.current = true
    let alive = true
    diskApi.sessionExportProbe()
      .then((probe) => { if (alive) setZipProbe(probe) })
      // 探测本身失败（宿主不可达等）→ 落到保守三态：**绝不**改判成不可用而把入口藏掉。
      .catch(() => { if (alive) setZipProbe({ availability: 'unknown', reason: 'network-error', status: 0, path: '', checkedAt: new Date().toISOString() }) })
    return () => { alive = false }
  }, [open, diskApi])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError(null)
    recoveryApi.sessions()
      .then((next) => { if (alive) { setResponse(next); setLoading(false) } })
      .catch((err) => { if (alive) { setError(err instanceof Error ? err.message : String(err)); setLoading(false) } })
    return () => { alive = false }
  }, [open, scanVersion, recoveryApi])

  const summary = sessionHealthSummaryView(response)
  const repairEntries = sessionRepairEntries(response)

  return (
    <Card className={css.card}>
      <div className={css.statRow}>
        <strong>{t('sessions.title')}</strong>
        {/* 徽章语义：扫描只读；修复是显式动作（预览 → 确认 → 自动备份 → 可回滚） */}
        <Badge kind="info">{t('sessions.readOnly')}</Badge>
        <InfoHint text={t('sessions.desc')} label={t('common.infoHint')} />
        <span className={css.statusSpacer} />
      </div>
      {/* T10：结果全部搬进独立弹窗 —— 卡片只留入口与一行摘要，绝不把上千行塞进设置页。
          2026-10-12 用户要求：本卡**退出折叠**，入口与摘要常驻可见（不再有 chevron）。 */}
      {/* 2026-10-12 用户要求：预扫描说明文案已删（点按钮即扫，屏上只留真正的摘要）。 */}
      {summary !== null && response !== null && (
        <div className={css.statRow}>
          <Badge kind="info">{t('sessions.dialog.lastScan.total', { count: String(summary.total) })}</Badge>
          <Badge kind={summary.needsAttention > 0 ? 'warn' : 'ok'}>{t('sessions.dialog.lastScan.issues', { count: String(summary.needsAttention) })}</Badge>
          {repairEntries.length > 0 && <Badge kind="info">{t('sessions.dialog.lastScan.repairs', { count: String(repairEntries.length) })}</Badge>}
        </div>
      )}
      <div className={css.actionRow}>
        <Button variant="ghost" loading={loading} onClick={() => { setOpen(true) }}>
          {loading ? t('sessions.scanning') : t('sessions.dialog.open')}
        </Button>
      </div>
      {/*
        弹窗**只在打开时挂载**：它是整屏内容的组件，常驻会让卡片每次重渲染都带着它一起走
        （真机反馈：弹窗加载一会儿后整个设置页变空白）。关闭即卸载，状态随之释放。
      */}
      {open && (
        <SessionHealthDialog
          open={open}
          onClose={() => { setOpen(false) }}
          recoveryApi={recoveryApi}
          t={t}
          clipboardT={clipboardT}
          response={response}
          loading={loading}
          error={error}
          onScan={scan}
          zipProbe={zipProbe}
          api={diskApi}
        />
      )}
    </Card>
  )
}
