/**
 * 产物库的动作层（UI v2 §6.4 / §6.5）—— 产物库面板的**兄弟节点**，不是子节点。
 *
 * 为什么必须在面板外面：**动作会开 Modal，而 Modal 必须留在面板外面**。
 * 已经踩过一次：`ConsultCard` 一开始挂在「导入向导」这个 task 面板**内部**，于是它的提示气泡
 * 经 Portal 进了 #dsh-config-manager-root ——气泡相对 root 定位，而向导又渲染在相对 root
 * 定位的侧滑面板里，实时位置算出来是 service 斜的，只好临时把浮层容器从 root 改到面板。
 * 弹窗挂进面板也会遇到同一类「定位基准不是你以为的那个」问题。
 * 结论：面板只负责**排版**，弹窗与动作归本组件（渲染在 `.shellContent` 里、`.taskPanel` 之外）。
 *
 * 另一条纪律：**动作实现只有一份**。恢复的 dry-run 计划 / 执行 / 报告、备份的查看与对比、
 * 删除与置顶——这些逻辑在 v1 的 snapshots 面板里已经过真机验证，本组件只做**分派**，
 * 不重新实现（同 §6.3「动作由 capabilities 分派，不由 kind 分派」）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RestoreReport } from '../../core/restore.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import type { ArtifactCapability, ArtifactRow } from '../../ui/artifact-view.ts'
import { remoteSnapshotFileName } from '../../ui/artifact-view.ts'
import { planHasExecutableActions } from '../../ui/snapshots-view.ts'
import { runStore } from '../run-store.ts'
import type { ConfigManagerApi, BackupInspectResult } from '../api.ts'
import type { SyncApi } from '../sync/sync-api.ts'
import { formatDateTimeFull } from '../sync/history-model.ts'
import type { TranslateNS } from '../client-types.ts'
import { Banner, Button, Empty, Spinner } from '../common/ui.tsx'
import { Skeleton, SkeletonList, SkeletonTable } from '../common/Skeleton.tsx'
import { InfoHint } from '../common/InfoHint.tsx'
import { ConfirmDialog } from '../common/ConfirmDialog.tsx'
import { Modal } from '../common/Modal.tsx'
import { toast } from '../common/toast-store.ts'
import { ConsultCard } from '../consult/ConsultCard.tsx'
import { RestorePlanView } from './RestorePlanView.tsx'
import { BackupInspectView } from './BackupInspectView.tsx'
import { redact } from '../../security/redaction.ts'
import css from '../config-manager.module.css'

/**
 * 宿主/错误文本渲染前统一过 redact（AGENTS.md §UI 硬性规则 7；client-F4）。
 * 单列成一行：plan-text-redaction.test.ts 的「按渲染点」登记表需要一个唯一锚点。
 */
const redactErrorText = (err: unknown): string => redact(err instanceof Error ? err.message : String(err))

/**
 * 删除快照的失败文案：宿主用**码**区分两种拒绝（被事故恢复引用 / 引用清单读不出来），
 * 界面必须映射成本地化文案 —— 裸码上屏等于「用户看不懂为什么删不掉」。
 * 未知错误仍走 redactErrorText（脱敏不放松）。
 */
const snapshotDeleteErrorText = (err: unknown, t: TranslateNS<'config-manager'>): string => {
  const raw = err instanceof Error ? err.message : String(err)
  if (raw.includes('snapshot-referenced-by-recovery')) return t('library.snapshotReferencedByRecovery')
  if (raw.includes('recovery-reference-unreadable')) return t('library.snapshotReferenceUnreadable')
  return redactErrorText(err)
}

/** 一次待执行的行内动作（由 LibraryPanel 冒泡上来）。 */
export interface LibraryActionTarget {
  capability: ArtifactCapability
  row: ArtifactRow
}

export interface LibraryActionsProps {
  api: ConfigManagerApi
  /** 远端快照的「拉取」与咨询都要通道地址 → 需要 SyncApi（与同步页同源） */
  syncApi: SyncApi
  t: TranslateNS<'config-manager'>
  /** 哪一行触发了动作（null = 没有在进行的动作） */
  target: { capability: ArtifactCapability; row: ArtifactRow } | null
  /** 动作收尾（关闭弹窗 + 刷新列表 + 清忙态） */
  onDone: () => void
  /** 「这里是快照的恢复流程」不是「一次性的删除」——执行完成后要刷新产物列表 */
  onChanged: () => void
  /**
   * 导入 / 逛市场是**多阶段流程** → 交给壳层的 Task 面板，不在本组件里开 Modal。
   * marketId：市场条目的「安装」要**直达该条目**（面板就绪后自动进入它的下载/审阅），
   * 经壳层转成 Task 入参；其余入口不带（= 打开市场列表）。
   */
  onOpenTask: (kind: 'import' | 'market', marketId?: string) => void
}

/** 恢复计划弹窗的本地态（dry-run 结果 + 咨询报告） */
interface PlanState {
  snapshotId: string
  loading: boolean
  plan: Awaited<ReturnType<ConfigManagerApi['restoreSnapshot']>>['plan'] | null
  changeSummary: Awaited<ReturnType<ConfigManagerApi['restoreSnapshot']>>['changeSummary'] | undefined
  /** 预览时宿主给的计划指纹：执行时回传，让宿主发现「确认后磁盘又变了」（旧宿主不返回 → undefined） */
  planFingerprint: string | undefined
  error: string | null
}

/**
 * 「先拉取再做事」的进行中态（远端快照的两种动作共用）。
 * `mode` 决定标题与进度文案：pull = 落地后进导入向导（拉取即导入）；download = 落地后交浏览器下载。
 */
interface PullState {
  row: ArtifactRow
  mode: 'pull' | 'download'
  phase: 'running' | 'failed'
  error: string | null
}

export function LibraryActions({ api, syncApi, t, target, onDone, onChanged, onOpenTask }: LibraryActionsProps) {
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const [plan, setPlan] = useState<PlanState | null>(null)
  /**
   * 迁移前咨询：`null` = 弹窗关闭。
   * 带 row 是为了在标题里点名「咨询的是哪一份」——用户可能连点几行，不能只有一个孤零零的报告。
   */
  const [consult, setConsult] = useState<{ row: ArtifactRow; loading: boolean; error: string | null; report: ConsultReport | null } | null>(null)
  /**
   * 远端快照的**需要先拉取**的动作进行中态（拉取即导入 / 下载）。`null` = 弹窗关闭。
   * 用 Modal 而不是 Toast：拉取可能持续数秒，用户需要**看得见的进度**，
   * 且期间必须不能操作别处（Modal 的遮罩 + focus trap 正好提供了这一点）。
   * `mode` 只影响标题与进度文案 —— 两条路的差别在成功之后（进导入向导 / 交浏览器下载）。
   */
  const [pull, setPull] = useState<PullState | null>(null)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<RestoreReport | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<ArtifactRow | null>(null)
  const [inspect, setInspect] = useState<{ name: string; loading: boolean; error: string | null; result: BackupInspectResult | null } | null>(null)
  // 忙态总开关：下载 / 置顶 / 咨询是**无弹窗**的即时动作，正在跑时不该再接受第二次点击。
  // 它的读点在 LibraryPanel（行内按钮 disabled）——这里只负责写。
  const [busy, setBusy] = useState(false)
  void busy

  /** 每次触发动作递增：快速连点时作废在途的 dry-run 响应（防晚到结果覆盖新选择）。 */
  const generation = useRef(0)

  /** 用户点了某个动作（由 LibraryPanel 向上冒泡过来）。 */
  const dispatch = useCallback(async (capability: ArtifactCapability, row: ArtifactRow): Promise<void> => {
    const gen = generation.current + 1
    generation.current = gen
    switch (capability) {
      case 'restore': {
        setPlan({ snapshotId: row.ref.snapshotId ?? '', loading: true, plan: null, changeSummary: undefined, planFingerprint: undefined, error: null })
        // v3（用户要求）：恢复计划弹窗**不再内嵌「迁移前咨询」卡** —— 那个弹窗的职责是
        // 「这次恢复会改什么 + 确认执行」；咨询报告有自己的入口（产物库行 ⋯ 菜单 →「迁移前咨询」），
        // 想看报告的人可以单独打开。顺带省掉一次重量级请求（consult 要读快照内容做评分）。
        api.restoreSnapshot(row.ref.snapshotId ?? '', true).then(
          (res) => {
            if (!mounted.current || gen !== generation.current) return
            setPlan({ snapshotId: row.ref.snapshotId ?? '', loading: false, plan: res.plan ?? null, changeSummary: res.changeSummary, planFingerprint: res.planFingerprint, error: null })
          },
          (err) => {
            if (!mounted.current || gen !== generation.current) return
            setPlan({ snapshotId: row.ref.snapshotId ?? '', loading: false, plan: null, changeSummary: undefined, planFingerprint: undefined, error: err instanceof Error ? err.message : String(err) })
          },
        )
        return
      }
      /** 执行恢复（确认后）。宿主侧 RunRegistry 才是防重的权威，前端 running 只是 UX 镜像。 */
      case 'import': {
        // 加密备份必须先解锁 → 由导入向导的 decrypt 阶段承担；这里只把 zipPath 与形态带过去
        runStorePatchImport(row)
        onOpenTask('import')
        onDone()
        return
      }
      /**
       * 远端快照「拉取」= **拉取即导入**（用户定案）：
       * 宿主把该快照落地成本机 ZIP → 直接交给导入向导。
       *
       * 为什么走导入向导而不是「直接写配置」：导入向导已有解锁加密备份、选内容、
       * 冲突决策、执行前快照与回滚 —— 另造一条写入通道等于把这五件事重做一遍且更难回滚。
       *
       * 进度可见性：整个拉取期间是一个**阻塞式 Modal**（Radix 的遮罩 + focus trap
       * 天然禁用页面其余部分），按钮进加载态；成功后自动进入导入侧拉面板。
       */
      case 'pull': {
        setPull({ row, mode: 'pull', phase: 'running', error: null })
        void runRemoteDownload(row, syncApi).then(
          (result) => {
            if (!mounted.current) return
            // 把落地好的 ZIP 交给导入向导（与产物库行「导入」同一份载荷形态）
            runStorePatchImport({ ...row, ref: { ...row.ref, path: result.zipPath } } as ArtifactRow)
            setPull(null)
            onChanged()
            onOpenTask('import')
            onDone()
          },
          (err) => {
            const message = redactErrorText(err)
            if (mounted.current) setPull({ row, mode: 'pull', phase: 'failed', error: message })
            toast.error(message)
          },
        )
        return
      }
      /**
       * 市场条目的安装 = **打开「逛市场」流程并直达该条目**（下载 + 校验 + 免责 + 分步审阅）。
       * 为什么不在这里自己调 marketApi.download：那条路要重做解锁/免责/冲突决策/回滚四件事，
       * 而市场面板里已经有一份完整实现（MarketImportReview）；此处只负责把 itemId 带过去。
       */
      case 'install': {
        onOpenTask('market', row.ref.marketId)
        onDone()
        return
      }
      case 'inspect': {
        // 市场条目不再有这个动作（只有「安装」，见 ui/artifact-view.ts 的 marketRow）：
        // 原先它和安装同入口（都是开市场流程），是重复项。
        if (row.badges.includes('encrypted')) {
          setInspect({ name: fileNameOf(row), loading: false, error: t('backupFiles.inspectEncrypted'), result: null })
          return
        }
        // 展示名 = **实际文件名**：备份文件是磁盘上的名字，远端快照是本步即将落地成的名字
        const name = fileNameOf(row)
        setInspect({ name, loading: true, error: null, result: null })
        void (async () => {
          try {
            // 远端快照本机没有文件：先落地成本机 ZIP（与「拉取」同一条 /sync/download），
            // 再走备份文件那条只读分析 —— 「查看与对比」在两种来源上是**同一份实现**（§6.8 ②）。
            const zipPath = row.kind === 'remote-snapshot'
              ? (await runRemoteDownload(row, syncApi)).zipPath
              : (row.ref.path ?? '')
            const result = await api.inspectBackup(zipPath)
            if (mounted.current && gen === generation.current) setInspect({ name, loading: false, error: null, result })
          } catch (err) {
            if (mounted.current && gen === generation.current) {
              setInspect({ name, loading: false, error: err instanceof Error ? err.message : String(err), result: null })
            }
          }
        })()
        return
      }
      case 'download': {
        if (row.kind === 'remote-snapshot') {
          // 远端快照本机没有文件：先拉取落地（阻塞式 Modal 给进度，与「拉取」同一份体验），
          // 再把落地的 ZIP 交给**备份文件那条**下载通道 —— 两种来源的「下载」只有一份实现。
          // 落地文件名按快照时间生成（宿主默认叫 snapshot.zip，落进「下载」目录会分不清哪一份）。
          setPull({ row, mode: 'download', phase: 'running', error: null })
          void runRemoteDownload(row, syncApi).then(
            (staged) => {
              if (!mounted.current) return
              setPull(null)
              void api.download(staged.zipPath)
                .catch((err) => { toast.error(redactErrorText(err)) })
                .finally(() => { if (mounted.current) onDone() })
            },
            (err) => {
              const message = redactErrorText(err)
              if (mounted.current) setPull({ row, mode: 'download', phase: 'failed', error: message })
              toast.error(message)
            },
          )
          return
        }
        setBusy(true)
        // 用户要求：直接走浏览器下载（落到「下载」目录），不弹系统保存对话框 ——
        // 备份文件是**可再生成的产物**，多一步选路径没有收益。
        // api.download 缺省即此语义（Blob + <a download>）；不要传 saveDialog: true。
        void api.download(row.ref.path ?? '')
          .catch((err) => { toast.error(redactErrorText(err)) })
          .finally(() => { if (mounted.current) { setBusy(false); onDone() } })
        return
      }
      case 'delete': {
        setConfirmDelete(row)
        return
      }
      case 'consult': {
        setBusy(true)
        // 四种可迁移源共用一个入口（§6.8 ②）：咨询永远进 ⋯，不按来源造分叉
        // 远端快照的咨询要带通道地址（宿主 consult 的远端分支需要 repoUrl/url，只给 id 会 400）
        const input = await consultInput(row, syncApi)
        if (!mounted.current) return
        // 报告要**有自己的弹窗**：此前只 setConsult 而不开弹窗，而 ConsultCard 挂在
        // 「恢复计划预览」弹窗内部（由 plan !== null 控制）⇒ 点 ⋯ 完全没反应。
        setConsult({ row, loading: true, error: null, report: null })
        api.consult(input).then(
          (rep) => { if (mounted.current) setConsult({ row, loading: false, error: null, report: rep }) },
          (err) => {
            const message = redactErrorText(err)
            if (mounted.current) setConsult({ row, loading: false, error: message, report: null })
            // Toast 与弹窗内错误都给：弹窗可能被立刻关掉，Toast 保证反馈不丢
            toast.error(message)
          },
        ).finally(() => { if (mounted.current) { setBusy(false); onDone() } })
        return
      }
      default:
        onDone()
    }
  }, [api, t, onDone, onChanged, onOpenTask])

  /**
   * 供 LibraryPanel 调用：把点击转进来。用 ref 暴露，避免面板每次渲染重建回调。
   *
   * **必须只消费一次**：此前的守卫把 `Date.now()` 拼进 key，而 `target` 对象在父层被复用，
   * 面板任何一次重渲染（例如**展开某一行**）都会让 key 变化 ⇒ 守卫失效 ⇒ 同一个动作被重复派发
   * （真机表现：点开「查看与对比」后再点行展开，弹窗又弹一次）。
   * 现在按 **`target` 的引用身份**记账：同一个对象只派发一次，父层把它置回 null 才允许下一次。
   */
  const consumed = useRef<LibraryActionTarget | null>(null)
  useEffect(() => {
    if (target === null) { consumed.current = null; return }
    if (consumed.current === target) return
    consumed.current = target
    void dispatch(target.capability, target.row)
  }, [target, dispatch])

  const execute = (): void => {
    const snapshotId = plan?.snapshotId
    if (snapshotId === undefined || running) return
    setRunning(true)
    setConfirmRestore(false)
    runStoreWatch()
    // 带上预览时的计划指纹：磁盘在这中间变了 → 宿主 409 plan-changed（绝不静默执行另一套动作）
    api.restoreSnapshot(snapshotId, false, plan?.planFingerprint).then(
      (res) => { if (mounted.current) { setRunning(false); setReport(res.report ?? null); setPlan(null); onChanged() } },
      (err) => {
        if (mounted.current) { setRunning(false); setPlan(null) }
        const raw = err instanceof Error ? err.message : String(err)
        if (raw.includes('plan-changed')) {
          // 环境已变化：说清并让用户重新预览（比执行一套没确认过的动作安全）
          toast.error(t('snapshots.planChanged'))
          return
        }
        toast.error(redactErrorText(err))
      },
    ).finally(() => { runStoreStopWatch() })
  }

  const doDelete = (): void => {
    const row = confirmDelete
    if (row === null) return
    const done = (): void => { if (mounted.current) { setConfirmDelete(null); onChanged(); onDone() } }
    if (row.kind === 'snapshot') {
      api.deleteSnapshot(row.ref.snapshotId ?? '').then(
        () => { toast.ok(t('snapshots.deleted')); done() },
        (err) => { if (mounted.current) setConfirmDelete(null); toast.error(snapshotDeleteErrorText(err, t)) },
      )
      return
    }
    if (row.kind === 'backup-file') {
      api.deleteBackupFile(fileNameOf(row)).then(
        () => { toast.ok(t('backupFiles.deleted', { name: fileNameOf(row) })); done() },
        (err) => { if (mounted.current) setConfirmDelete(null); toast.error(redactErrorText(err)) },
      )
      return
    }
    if (row.kind === 'remote-snapshot') {
      // 删的是**远端那一份**（只动远端，见宿主 SyncEngine.deleteSnapshot）：需要通道 + 地址，
      // 与拉取/咨询同源取（prepareSync 只认 repoUrl/url）。
      void (async () => {
        try {
          const payload = await remotePayload(syncApi)
          await syncApi.deleteSnapshot({ ...payload, snapshotId: row.ref.remoteId ?? '' })
          toast.ok(t('library.remoteDeleted'))
          done()
        } catch (err) {
          if (mounted.current) setConfirmDelete(null)
          toast.error(redactErrorText(err))
        }
      })()
    }
  }

  return (
    <>
      {/* 迁移前咨询：单次决策 + 报告（§1 容器判据）→ Modal。
          与「恢复计划预览」分开：来源与时机都不同，混在一个弹窗里会让人以为咨询是恢复的前置步骤。 */}
      <Modal
        open={consult !== null}
        onClose={() => { if (consult?.loading !== true) setConsult(null) }}
        title={api.t('consult.title')}
        wide
        busy={consult?.loading === true}
      >
        <Modal.Header
          title={api.t('consult.title')}
          closeLabel={t('common.close')}
          onClose={() => { setConsult(null) }}
          closeDisabled={consult?.loading === true}
        />
        <Modal.Body scroll>
          {consult !== null && (
            <>
              <div className={css.hint}>{fileNameOf(consult.row)}</div>
              {/* 迁移前咨询：正文块（多段报告）→ 按行铺骨架 */}
              {consult.loading && <Skeleton shape="line" count={5} label={api.t('consult.loading')} />}
              {consult.error !== null && <Banner kind="error">{consult.error}</Banner>}
              {consult.report !== null && <ConsultCard report={consult.report} t={api.t} />}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button disabled={consult?.loading === true} onClick={() => { setConsult(null) }}>{t('common.close')}</Button>
        </Modal.Footer>
      </Modal>

      {/* 远端快照的「先拉取」动作（拉取即导入 / 下载）：进行中 / 失败。
          用 Modal 是因为拉取可能数秒，用户需要看得见的进度，且期间必须不能操作别处
          （遮罩 + focus trap 天然满足）。标题与进度文案按 mode 分（见 pullTitle / pullProgressLabel）。 */}
      <Modal
        open={pull !== null}
        onClose={() => { if (pull?.phase !== 'running') setPull(null) }}
        title={pullTitle(pull, t)}
        busy={pull?.phase === 'running'}
      >
        <Modal.Header
          title={pullTitle(pull, t)}
          closeLabel={t('common.close')}
          onClose={() => { setPull(null) }}
          closeDisabled={pull?.phase === 'running'}
        />
        <Modal.Body scroll>
          {pull !== null && (
            <>
              <div className={css.hint}>{fileNameOf(pull.row)}</div>
              {pull.phase === 'running' && (
                <div className={css.statRow}>
                  <Spinner label={pullProgressLabel(pull.mode, t)} />
                  <span>{pullProgressLabel(pull.mode, t)}</span>
                </div>
              )}
              {pull.phase === 'failed' && pull.error !== null && <Banner kind="error">{pull.error}</Banner>}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button disabled={pull?.phase === 'running'} onClick={() => { setPull(null) }}>{t('common.close')}</Button>
        </Modal.Footer>
      </Modal>

      {/* 恢复计划预览：dry-run 结果（只读）。v3：不再内嵌迁移前咨询卡（用户要求）。 */}
      <Modal
        open={plan !== null}
        onClose={() => { if (!running) setPlan(null) }}
        title={t('snapshots.planTitle')}
        wide
        busy={running}
      >
        <Modal.Header
          title={t('snapshots.planTitle')}
          closeLabel={t('common.close')}
          onClose={() => { setPlan(null) }}
          closeDisabled={running}
          trailing={<InfoHint text={t('snapshots.selectHint')} label={t('common.infoHint')} />}
        />
        <Modal.Body scroll>
          {/* 恢复计划预览：结果是一张「文件 → 动作」表 → 按表格铺骨架 */}
          {plan?.loading === true && <SkeletonTable rows={6} label={t('common.loading')} />}
          {plan?.error !== null && plan?.error !== undefined && <Banner kind="error">{plan.error}</Banner>}
          {plan?.plan != null && plan.plan.actions.length === 0 && <Empty>{t('snapshots.noActions')}</Empty>}
          {plan?.plan != null && plan.plan.actions.length > 0 && (
            <RestorePlanView
              key={plan.snapshotId}
              api={api}
              t={t}
              snapshotId={plan.snapshotId}
              plan={plan.plan}
              changeSummary={plan.changeSummary}
            />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button disabled={running} onClick={() => { setPlan(null) }}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            disabled={running || !planHasExecutableActions(plan?.plan ?? null)}
            loading={running}
            onClick={() => { setConfirmRestore(true) }}
          >
            {running ? t('snapshots.executing') : t('snapshots.execute')}
          </Button>
        </Modal.Footer>
      </Modal>

      {/* 执行恢复二次确认 */}
      <ConfirmDialog
        open={confirmRestore}
        title={t('snapshots.confirmTitle')}
        message={t('snapshots.confirmRestore')}
        confirmLabel={t('snapshots.execute')}
        cancelLabel={t('common.cancel')}
        danger
        busy={running}
        onConfirm={execute}
        onCancel={() => { setConfirmRestore(false) }}
      />

      {/* 删除二次确认（快照 / 备份文件 / **远端快照**；三者都不可恢复）
          —— 远端那条多两句：删的是**远端仓库里的文件**，命中当前基线时如实提示后果。 */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === null ? t('snapshots.deleteConfirmTitle')
          : confirmDelete.kind === 'backup-file' ? t('backupFiles.deleteConfirmTitle')
            : confirmDelete.kind === 'remote-snapshot' ? t('library.remoteDeleteTitle')
              : t('snapshots.deleteConfirmTitle')}
        message={confirmDelete === null ? undefined
          : confirmDelete.kind === 'backup-file'
            ? t('backupFiles.deleteConfirm', { name: fileNameOf(confirmDelete) })
            : confirmDelete.kind === 'remote-snapshot'
              ? t('library.remoteDeleteConfirm', { time: timeText(confirmDelete) })
                + (confirmDelete.badges.includes('current') ? ' ' + t('library.remoteDeleteBaseline') : '')
              : t('snapshots.deleteConfirm', { time: confirmDelete.title.kind === 'time' ? confirmDelete.title.iso : '' })}
        confirmLabel={confirmDelete === null ? t('snapshots.delete')
          : confirmDelete.kind === 'backup-file' ? t('backupFiles.delete')
            : confirmDelete.kind === 'remote-snapshot' ? t('library.delete')
              : t('snapshots.delete')}
        cancelLabel={t('common.cancel')}
        danger
        onConfirm={doDelete}
        onCancel={() => { setConfirmDelete(null) }}
      />

      {/* 查看与对比（只读，零写入） */}
      <Modal open={inspect !== null} onClose={() => { setInspect(null) }} title={t('backupFiles.inspect')} wide>
        <Modal.Header title={t('backupFiles.inspect')} closeLabel={t('common.close')} onClose={() => { setInspect(null) }} />
        <Modal.Body scroll>
          {inspect !== null && <div className={css.hint} data-testid="inspect-backup-name">{inspect.name}</div>}
          {inspect?.loading === true && <SkeletonList count={3} label={t('backupFiles.inspectLoading')} />}
          {inspect?.error != null && <Banner kind="error">{inspect.error}</Banner>}
          {inspect !== null && !inspect.loading && inspect.result === null && inspect.error === null && <Empty>{t('backupFiles.inspectEmpty')}</Empty>}
          {inspect?.result != null && <BackupInspectView result={inspect.result} t={t} />}
        </Modal.Body>
      </Modal>

      {/* 执行恢复的报告（一次性回执，必须给显式退出入口） */}
      <Modal open={report !== null} onClose={() => { setReport(null) }} title={t('snapshots.reportTitle')} wide>
        <Modal.Header title={t('snapshots.reportTitle')} closeLabel={t('common.close')} onClose={() => { setReport(null) }} />
        <Modal.Body scroll>
          {report !== null && (
            <>
              {reportLine(t('snapshots.restored'), report.restored, t)}
              {reportLine(t('snapshots.removedPlugins'), report.removedPlugins, t)}
              {reportLine(t('snapshots.manualHints'), report.manualHints, t, true)}
              {reportLine(t('snapshots.failed'), report.failed.map((f) => `${f.item}: ${f.reason}`), t, true)}
              {reportLine(t('snapshots.skipped'), report.skipped, t)}
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="primary" onClick={() => { setReport(null) }}>{t('snapshots.reportDone')}</Button>
        </Modal.Footer>
      </Modal>

    </>
  )
}

/* ------------------------------------------------------------------ 内部工具 */

/** 行的可读名字（弹窗标题 / 确认文案里用它，不重复拼 kind 标签） */
function titleText(row: ArtifactRow): string {
  return row.title.kind === 'text' ? row.title.value : row.title.iso
}

/**
 * 行的**文件名**（弹窗标题行 / 删除确认 / 落地名都用它）。
 *  - 备份文件 = 磁盘上的名字（删除接口按**文件名**而不是路径收 · 宿主侧只认 exports 目录内的 .zip）；
 *  - 远端快照 = 本机即将产出的落地名（由快照时间生成，见 remoteSnapshotFileName）；
 *  - 其余（本机快照）退回行标识。
 */
function fileNameOf(row: ArtifactRow): string {
  if (row.kind === 'remote-snapshot') return remoteSnapshotFileName(row.at ?? '', row.ref.remoteId ?? '')
  const text = titleText(row)
  return text.split(/[\\/]/).pop() ?? text
}

/** 弹窗文案里的时间：走与列表行同一份格式化（绝不把裸 ISO 甩给用户）。 */
function timeText(row: ArtifactRow): string {
  return row.title.kind === 'time' ? formatDateTimeFull(row.title.iso) : ''
}

/** 拉取/下载弹窗的标题（同一个 Modal 承载两条路，只有文案分叉）。 */
function pullTitle(pull: PullState | null, t: TranslateNS<'config-manager'>): string {
  return pull?.mode === 'download' ? t('library.downloadTitle') : t('library.pullTitle')
}

/** 进行中的一句话：说清后半程（拉取之后是**导入**还是**下载**），别让用户以为只是比对差异。 */
function pullProgressLabel(mode: PullState['mode'], t: TranslateNS<'config-manager'>): string {
  return mode === 'download' ? t('library.downloading') : t('library.pulling')
}

/**
 * 远端动作所需的**通道载荷**（transport + 地址）：宿主 `prepareSync` 要地址，
 * 只给快照 id 会被 400 `repoUrl is required` 挡回（真机反馈）。
 * 咨询 / 拉取 / 下载 / 删除四条远端动作共用这一份判定，避免各写一份而分叉。
 * 地址从 /sync/status 现取，与产物库加载远端列表同源。
 */
async function remotePayload(syncApi: SyncApi): Promise<{ transport: 'git'; repoUrl: string } | { transport: 'webdav'; url: string }> {
  const status = await syncApi.status()
  const isWebdav = status.lastSyncChannel === 'webdav'
  const webdavUrl = (status.webdav?.url ?? '').trim()
  const repoUrl = (status.repoUrl ?? '').trim()
  const payload = isWebdav
    ? (webdavUrl !== '' ? { transport: 'webdav' as const, url: webdavUrl } : null)
    : (repoUrl !== '' ? { transport: 'git' as const, repoUrl } : null)
  if (payload === null) throw new Error('sync channel address is unavailable')
  return payload
}

/**
 * 「迁移前咨询」的输入：**四种可迁移源统一走这一个入口**（§6.8 ②）。
 * 每种的 id 语义不同（快照 id / 备份路径 / 远端快照 id），照 consult 路由的契约给。
 */
async function consultInput(row: ArtifactRow, syncApi: SyncApi): Promise<{ type: 'export-zip' | 'local-snapshot' | 'remote-snapshot'; id: string; snapshotId?: string; transport?: 'git' | 'webdav'; repoUrl?: string; url?: string }> {
  if (row.kind === 'snapshot') return { type: 'local-snapshot', id: row.ref.snapshotId ?? '', snapshotId: row.ref.snapshotId }
  if (row.kind === 'remote-snapshot') {
    // 远端来源**必须**带通道与地址（与拉取/下载/删除共用 remotePayload 那一份判定）
    return { type: 'remote-snapshot', id: row.ref.remoteId ?? '', ...(await remotePayload(syncApi)) }
  }
  return { type: 'export-zip', id: row.ref.path ?? '' }
}

/**
 * 远端快照「拉取即导入」：取通道与地址 → 调 /sync/download 让宿主**落地成本机 ZIP**。
 *
 * 为什么不能只传 id：宿主 `prepareSync` 需要 transport + 地址（repoUrl / url），
 * 只传 id 会被 400 `repoUrl is required` 挡回 —— 远端咨询踩的是同一个坑。
 * 地址从 /sync/status 现取，与产物库加载远端列表同源（同一份判定，不分叉）。
 *
 * 为什么用 /sync/download 而不是 /sync/pull：pull 只回**差异预览**（临时 ZIP 用完即删），
 * 拿不到可导入的文件；download 把 ZIP 留在宿主的 incoming 目录并回传路径。
 */
async function runRemoteDownload(row: ArtifactRow, syncApi: SyncApi): Promise<{ ok: boolean; zipPath: string; snapshotId: string }> {
  const payload = await remotePayload(syncApi)
  // name：宿主的落地默认名是 snapshot.zip，落进「下载」目录会分不清是哪一份快照
  // （见 remoteSnapshotFileName）；导入向导显示的也是这同一个名字。
  return await syncApi.download({ ...payload, snapshotId: row.ref.remoteId ?? '', name: fileNameOf(row) })
}

/** 把备份交给导入向导：它消费 runStore.library.pendingZip，连容器形态一起带过去（issue #55）。 */
function runStorePatchImport(row: ArtifactRow): void {
  const path = row.ref.path ?? ''
  const name = fileNameOf(row)
  // 不再写 panel：导入不是页面（导航里已无该项）。写 panel='import' 会把页面区切到
  // 一个不存在的页（真机：闪一下 + tab 高亮全灭），并把随后 openTask 的 origin 记成 'import'。
  runStore.patch({
    library: {
      pendingZip: {
        zipPath: path,
        name,
        ...(row.badges.includes('encrypted') ? { containerType: 'encrypted' as const } : {}),
      },
    },
  })
}

function runStoreWatch(): void { runStore.watchRunning('restore', 500) }
function runStoreStopWatch(): void { runStore.stopRunWatch('restore') }

function reportLine(title: string, items: string[], t: TranslateNS<'config-manager'>, warn = false) {
  if (items.length === 0) return null
  return (
    <div className={css.inspectGroup} key={title}>
      <div className={css.groupHeader}>
        <strong className={warn ? css.warnText : undefined}>{title}{t('common.parens', { text: String(items.length) })}</strong>
      </div>
      <div className={css.reportScroll}>
        <ul className={css.reportList}>
          {items.map((item, i) => <li key={`${title}-${i}`}>{item}</li>)}
        </ul>
      </div>
    </div>
  )
}
