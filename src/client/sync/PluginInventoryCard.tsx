/**
 * ⑤ cloud-sync 借鉴项：**远端依赖清单**卡（只读对照表）。
 *
 * 与既有「同步差异」的区别：它**不绑定本次同步操作** —— 用户在同步页随时点一次就能看到
 * 「远端快照声明的插件 vs 本机现状」，并把既有视图含糊掉的一处补上：
 * installed（包在 node_modules 里）与 enabled（名字在 dsh.profile.bundles 里）分开判定，
 * 半装（装了但没挂载）单独标出。
 *
 * 三条诚实性纪律（判定在 \`plugin-inventory-view.ts\` / 宿主 \`src/core/plugin-inventory.ts\`）：
 *  1. 远端不可达时**绝不**写成「远端没有声明」—— 宿主回 \`available:false\` + 脱敏原因，
 *     卡内先给一条 warn 横幅，且「远端声明」行一律不显示；本机事实照常列出；
 *  2. 状态一律走 \`inventoryStatusView\` 的字典键映射（**禁止渲染裸枚举**）；
 *  3. 渲染前所有错误再过一次 \`redact()\`（宿主已脱敏，这里是纵深防御）。
 *
 * 只读：本卡只有「加载 / 刷新」一个动作，没有卸载、没有收养、不写任何配置。
 * 长列表复用既有 \`.tableScroll\`（限高 420px 内滚），不撑长整页。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '../client-types.ts'
import type { SyncApi, SyncInventoryResponse, SyncPushPayload } from './sync-api.ts'
import { Badge, Banner, Button, Card, SectionTitle, Spinner } from '../common/ui.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ErrorBanner } from '../common/ErrorBanner.tsx'
import {
  inventoryChips,
  inventorySourceLines,
  inventoryStatusView,
  summarizeInventory,
} from './plugin-inventory-view.ts'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

export interface PluginInventoryCardProps {
  api: SyncApi
  t: TranslateNS<'config-manager-sync'>
  /** 与 push/pull 同一份通道请求体（由 SyncPanel 组装，本卡不改它） */
  body: SyncPushPayload
  /** 当前通道的远端地址是否就绪：未就绪时不发请求（只留「先配置通道」的指引） */
  remoteReady: boolean
  /** 当前选中的远端快照 id（缺省 = 最新） */
  snapshotId?: string | undefined
  /** 内存中的解密密码（加密快照需要；与 runPull 同口径：仅当用户真的输入了才带） */
  decryptPassword?: string | undefined
  /** 页面忙（同步 / 推送在途）时不发请求 */
  busy: boolean
}

export function PluginInventoryCard({ api, t, body, remoteReady, snapshotId, decryptPassword, busy }: PluginInventoryCardProps): ReactNode {
  const [result, setResult] = useState<SyncInventoryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 请求序号：切通道 / 连点刷新时，只接受最后一次发起的响应（过期响应不得覆盖新结果） */
  const seqRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!remoteReady) return
    const seq = ++seqRef.current
    setLoading(true)
    try {
      const res = await api.inventory({
        ...body,
        ...(snapshotId !== undefined && snapshotId !== '' ? { snapshotId } : {}),
        ...(decryptPassword !== undefined && decryptPassword !== '' ? { decryptPassword } : {}),
      })
      if (!mountedRef.current || seq !== seqRef.current) return
      setResult(res)
      setError(null)
    } catch (err) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && seq === seqRef.current) setLoading(false)
    }
  }, [api, body, remoteReady, snapshotId, decryptPassword])

  const summary = result === null ? null : summarizeInventory(result)
  const snapshotLabel = result !== null && result.snapshotId !== undefined && result.snapshotId !== ''
    ? result.snapshotId
    : t('inventory.remoteLatest')

  return (
    <Card>
      <SectionTitle
        title={t('inventory.title')}
        info={<InfoHint text={t('inventory.hint')} label={t('common.infoHint')} />}
      />
      <div className={css.actionRow}>
        <Button
          onClick={() => { void load() }}
          disabled={busy || loading || !remoteReady}
          title={t('inventory.loadHint')}
        >
          {loading
            ? <Spinner label={t('inventory.loading')} />
            : (result === null ? t('inventory.load') : t('inventory.reload'))}
        </Button>
        <span className={css.hint}>{remoteReady ? t('inventory.loadHint') : t('inventory.needChannel')}</span>
      </div>
      {error !== null && (
        <ErrorBanner
          error={t('inventory.loadFailed') + t('common.labelSeparator') + redact(error)}
          onRetry={() => { void load() }}
          retrying={loading}
          t={api.t}
        />
      )}
      {result !== null && (
        <>
          {/* 远端不可达：三态中的第一态。**先声明「远端未知」，再列本机事实** ——
              顺序反了用户会先读到一堆行、再看横幅，容易把 missing 当成结论。 */}
          {!result.available && (
            <>
              <Banner kind="warn">
                {t('inventory.remoteUnavailable', { reason: redact(result.error ?? '') })}
              </Banner>
              <div className={css.hint}>{t('inventory.remoteUnavailableHint')}</div>
            </>
          )}
          {result.available && <div className={css.hint}>{t('inventory.remoteOk', { snapshot: snapshotLabel })}</div>}
          {summary !== null && (
            <div className={css.statRow} aria-label={t('inventory.colStatus')}>
              <Badge kind="info">{t('inventory.stats.total', { count: String(summary.total) })}</Badge>
              {summary.enabled > 0 && <Badge kind="ok">{t('inventory.stats.enabled', { count: String(summary.enabled) })}</Badge>}
              {summary.halfInstalled > 0 && <Badge kind="warn">{t('inventory.stats.halfInstalled', { count: String(summary.halfInstalled) })}</Badge>}
              {summary.missing > 0 && <Badge kind="warn">{t('inventory.stats.missing', { count: String(summary.missing) })}</Badge>}
              {summary.configurationOnly > 0 && <Badge kind="info">{t('inventory.stats.configurationOnly', { count: String(summary.configurationOnly) })}</Badge>}
            </div>
          )}
          {result.entries.length === 0
            ? (
              <div className={css.hint}>
                <strong>{t('inventory.empty')}</strong>
                {' '}
                {t('inventory.emptyHint')}
              </div>
            )
            : (
              <div className={css.tableWrap}>
                <div className={css.tableScroll}>
                  <table className={css.dataTable + ' ' + css.tableFixed + ' ' + css.tableCompact}>
                    <thead>
                      <tr>
                        <th>{t('inventory.colName')}</th>
                        <th style={{ width: 150 }}>{t('inventory.colStatus')}</th>
                        <th style={{ width: 260 }}>{t('inventory.colDetail')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.entries.map((entry) => {
                        const view = inventoryStatusView(entry.status)
                        const lines = inventorySourceLines(entry, result.available)
                        const chips = inventoryChips(entry)
                        return (
                          <tr key={entry.name}>
                            <td>
                              <div className={css.cellMain}>
                                <span className={css.cellTitle + ' ' + css.mono} title={entry.name}>{entry.name}</span>
                              </div>
                            </td>
                            <td>
                              <Badge kind={view.kind} title={t(view.hintKey)}>{t(view.labelKey)}</Badge>
                            </td>
                            <td>
                              <div className={css.cellMain}>
                                {lines.map((line) => (
                                  <span
                                    key={line.key}
                                    className={css.cellMeta + ' ' + css.mono}
                                    title={t(line.key, { spec: line.spec !== '' ? line.spec : t('inventory.src.remoteNoSpec') })}
                                  >
                                    {t(line.key, { spec: line.spec !== '' ? line.spec : t('inventory.src.remoteNoSpec') })}
                                  </span>
                                ))}
                                <span className={css.cellMeta}>
                                  {chips.map((chipKey) => {
                                    const archived = chipKey === 'inventory.chip.sourceArchived'
                                    return (
                                      <Badge
                                        key={chipKey}
                                        kind={archived ? 'warn' : 'info'}
                                        {...(archived ? { title: t('inventory.chip.sourceArchivedHint') } : {})}
                                      >
                                        {t(chipKey)}
                                      </Badge>
                                    )
                                  })}
                                  {entry.version !== '' && <span className={css.mono}>{entry.version}</span>}
                                </span>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
        </>
      )}
    </Card>
  )
}
