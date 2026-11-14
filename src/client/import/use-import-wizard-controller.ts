/**
 * 导入向导控制器（状态 + 动作 + 派生接线）
 *
 * t45 物理拆分：从 client/import/ImportWizardView.tsx 抽出。
 * 职责：runStore 接线、文件选择/上传/分析/冲突/路径映射/补录/执行/重试等动作；
 * 渲染链只消费本 hook 的返回值（名与既有 body 局部变量逐字一致，便于搬运渲染链）。
 * 行为与视觉保持不变（JSX 逐字搬运，仅参数化）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ConflictCollector } from '../../ui/conflict-view.ts'
import type { FlowPhase } from '../../ui/flow.ts'
import { applicablePathIssues, importFlowFlags, importPreviewStageAfter, nextImportPhase, type ImportFlowInputs } from '../../ui/import-wizard.ts'
import {
  DEFAULT_SESSION_FORMAT_DISPOSITION,
  sessionFormatFactsFromAnalysis,
  sessionFormatSkipUnits,
  type SessionFormatDisposition,
} from '../../ui/session-format-disposition.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import type { ConfigManagerApi, UploadResponse } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore } from '../run-store.ts'
import {
  buildSelectedPlan, defaultSelectionFromPlan, effectiveImportPlan, effectiveImportSelection, excludedPlanItems,
  planWriteSections, sectionsFromPlan, selectionHasItems, type Selection,
} from '../../ui/selection-model.ts'
import { applyPickedFile, cancelSelection, fileSelectModel } from './import-file-select.ts'
import { ConfigManagerApiError } from '../common/http.ts'
// 只 import 零依赖常量模块（utils/shared-constants）：这里若 import security/container-kind.ts，
// 会把 security 桶 → encryption.ts（node:crypto/node:util）打进 lib/client.js，DSH 的 client loader
// 直接报 "missed the module table"，整个插件不加载（仓库既有铁律 + 本轮实测）。
import { ENCRYPTED_CONTAINER_CODE } from '../../utils/shared-constants.ts'

/**
 * 迁移前咨询失败 → 界面文案（纯函数，node 可测）。
 *
 * 两种「没有报告」必须分开（审计 P9-7）：
 *  - 404 = 宿主没有 `/consult` 路由（老宿主/老插件）→ null，界面继续按「宿主不支持」渲染
 *    info 横幅，不制造错误；
 *  - 其它失败（5xx / 超时 / 断网 / 响应解析失败）→ 返回可读消息，交给 ErrorBanner。
 *    此前 catch 只 setConsultReport(null)，用户看到的是「没有结论」而不是「咨询失败」。
 */
export function consultFailureError(err: unknown): string | null {
  if (err instanceof ConfigManagerApiError && err.status === 404) return null
  return err instanceof Error ? err.message : String(err)
}

/** 解锁加密容器的端口（注入以便 node 直接测事务语义，不依赖 React / store）。 */
export interface ArchiveUnlockFlow<Ref> {
  /** 解密容器 → 明文 ZIP + 被解出的凭据覆盖清单 refs */
  unlock: () => Promise<{ refs: readonly Ref[] }>
  /** 解锁成功后的中间态写回（archiveUnlocked / decryptPassword / decryptRefs） */
  commitUnlocked: (refs: readonly Ref[]) => void
  /** 解锁成功后的下一步（selectZip → analyze → 兼容性） */
  analyze: () => Promise<unknown>
  /** 回滚已提交的解锁态（只会在「已提交」之后被调用） */
  rollbackUnlocked: () => void
  /** 向导已被用户重置：在途结果整体丢弃，不写任何状态 */
  cancelled: () => boolean
}

export type ArchiveUnlockOutcome =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; unlocked: boolean }

/**
 * 「解锁 → 继续分析」事务（审计 P9-8）。
 *
 * 根因：解锁成功后先写 archiveUnlocked=true，再调 selectZip；后者抛错时 catch 只写 error，
 * 于是 archiveUnlocked=true 而 phase 仍停在 decrypt-archive —— 界面判定「已解锁」，
 * 用户却停在解锁页，重输密码也不会重新解锁（wizard 里解锁已经成功过一次）。
 * 这里把「已提交 → 后续失败必须回滚」写成事务，回滚内容由调用方给出（store 与 wizard 两份状态）。
 */
export async function unlockArchiveThenAnalyze<Ref>(
  flow: ArchiveUnlockFlow<Ref>,
): Promise<ArchiveUnlockOutcome> {
  let unlocked = false
  try {
    const { refs } = await flow.unlock()
    if (flow.cancelled()) return { status: 'cancelled' }
    flow.commitUnlocked(refs)
    unlocked = true
    await flow.analyze()
    if (flow.cancelled()) return { status: 'cancelled' }
    return { status: 'ok' }
  } catch (err) {
    // 用户已重置向导：resetWizard 已清空两份状态，再回滚只会覆盖新一轮导入
    if (flow.cancelled()) return { status: 'cancelled' }
    if (unlocked) flow.rollbackUnlocked()
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
      unlocked,
    }
  }
}

export function useImportWizardController(api: ConfigManagerApi, t: TranslateNS<'config-manager'>) {

  // m2：状态统一来自模块级 store；控制器实例由 store 缓存复用（不重建）
  const state = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot)
  const imp = state.import
  const wizard = runStore.importWizard(api)

  const step = imp.step
  const phase = imp.phase
  const progress = imp.progress
  const error = imp.error
  const uploading = imp.uploading
  const running = imp.running
  const rollbackOnError = imp.rollbackOnError
  const conflictCollector = imp.conflictCollector
  const pathMappings = imp.pathMappings
  const secretInputs = imp.secretInputs
  const decryptRefs = imp.decryptRefs
  const isEncrypted = imp.analysis?.encrypted === true

  /* ---------- Phase 2：导入内容选择（分区 → 最小单元） ---------- */
  // 生效选择：未选择 / 换了 ZIP（陈旧）→ 默认全选。陈旧选择若被沿用，会因分区 id 不在新计划里
  // 而把导入静默变成「什么都没做」——所以选择与 zipPath 绑定，这里做失效回落。
  const effectiveSelection = effectiveImportSelection(imp.plan, imp.zipPath, imp.importSelection)
  /** 裁剪后的子计划：冲突列表 / 密钥补录 / 执行**全部**以它为准（唯一定义处见 selection-model） */
  const selectedPlan = effectiveImportPlan(imp.plan, imp.zipPath, imp.importSelection)
  const selectionNodes = imp.plan === null ? [] : sectionsFromPlan(imp.plan)
  const selectionValue: Selection = effectiveSelection ?? { sections: [], excluded: [] }
  /** 用户主动取消的项数：结果页据此把「你取消的」与「引擎跳过的」分开说，不被混为一谈 */
  const excludedCount = imp.plan === null ? 0 : excludedPlanItems(imp.plan, selectionValue).length
  /**
   * 「全不选」守卫（UI-05）：勾选被清空时，执行这次导入不会写入任何东西 —— 但引擎仍会
   * 建安全快照并返回成功，界面会显示「导入完成」。与导出侧同一套空选择语义：预览步
   * 就地提示 + 禁用「下一步」；确认页的「确认导入」同样禁用（防御性，防止从别处推进）。
   */
  const nothingSelected = imp.plan !== null && !selectionHasItems(imp.plan, selectionValue)
  const applyImportSelection = (next: Selection): void => {
    if (imp.zipPath === null) return
    runStore.patch({ import: { importSelection: { zipPath: imp.zipPath, selection: next } } })
  }
  // 上传备份是否整体加密容器（需先解锁才可分析）；非敏感、刷新恢复
  const containerEncrypted = imp.containerEncrypted
  // 容器是否已解锁（仅内存；刷新后要求重输密码重新解锁）
  const archiveUnlocked = imp.archiveUnlocked
  const fileInput = useRef<HTMLInputElement | null>(null)
  /**
   * 选择代数（取消选择时递增）：作废在途的选择上传/分析，
   * 防止「取消后旧请求仍把向导推进/写错误」的竞态。
   */
  const pickGeneration = useRef(0)
  /** decrypt-archive 阶段（解锁加密容器）的本地状态（不持久化） */
  const [unlocking, setUnlocking] = useState(false)
  const [archiveUnlockError, setArchiveUnlockError] = useState<string | null>(null)
  /** 解锁阶段密码输入（本地 state，不上报 store 的敏感持久化键） */
  const [archivePassword, setArchivePassword] = useState('')
  /** Phase 7 迁移前咨询：预览步的咨询报告（本地 state，非敏感） */
  const [consultReport, setConsultReport] = useState<ConsultReport | null>(null)
  const [consultLoading, setConsultLoading] = useState(false)
  /**
   * 预览步的两页：先「迁移前咨询」（只读结论 + 依据），点下一步才是「选择要导入的内容」。
   * 本地 state（不持久化）：换备份或重走流程时回到咨询页（见下方 zipPath effect）。
   */
  const [previewStage, setPreviewStage] = useState<'consult' | 'select'>('consult')
  /**
   * 会话格式处置的**阻断态**（T1）：宿主在 /plan 阶段返回 409 + code=sessionFormatUnsupported
   * 时为 true —— 此刻没有任何计划，预览页改为渲染「三选一 + 可复制指引」，而不是一屏错误。
   * 本地 state（非持久化）：它描述的是「这一次 /plan 被拒了」，刷新后按当前选择重新请求即可。
   */
  const [sessionFormatBlocked, setSessionFormatBlocked] = useState(false)
  /** 当前处置（持久化在 run 切片里：切页签/刷新都必须保留用户的这个决定） */
  const sessionFormatDisposition: SessionFormatDisposition = imp.sessionFormatDisposition
  const setSessionFormatDisposition = (next: SessionFormatDisposition): void => {
    wizard.setSessionFormatDisposition(next)
    runStore.patch({ import: { sessionFormatDisposition: next } })
  }
  /** 本机读不了的会话（来自 /analyze 的单元级结论；没有/无法判定 → null，界面据此不渲染控件） */
  const sessionFormatFacts = sessionFormatFactsFromAnalysis(imp.analysis)

  const setPhase = (next: FlowPhase): void => {
    runStore.patch({ import: { phase: next } })
  }

  /* ---------- 阶段判定（纯逻辑在 src/ui/import-wizard.ts，node 可测） ---------- */

  /**
   * 与本次选择相关的路径问题：只保留「这次真的会写盘的分区」的路径。
   *
   * 真机反馈：用户没勾工作区，向导仍列出 7 条工作区路径要他逐条指定新位置。
   * 数据源是整包的探测结果（analysis.pathIssues），必须按 selectedPlan 裁剪 ——
   * 没有计划时（分析尚未完成）不裁剪。
   */
  const applicableIssues = applicablePathIssues(
    imp.analysis?.pathIssues ?? [],
    selectedPlan === null ? null : planWriteSections(selectedPlan),
  )

  // 加密备份：解密已覆盖的凭据（decryptRefs）不需用户补录，仅剩余项进入 secrets 阶段。
  // 三个标志一律基于**裁剪后的选择**：用户取消的分区不该再把他拖进冲突/路径/补录阶段
  // （与 enterConflicts 用 selectedPlan、SecretsStage 用 selectedPlan 同一口径）。
  const { hasConflicts, hasSecrets } = importFlowFlags({
    plan: selectedPlan, analysis: imp.analysis, decryptRefs, pathIssues: applicableIssues,
  })
  const hasPathIssues = applicableIssues.length > 0

  /**
   * 适用阶段的有序列表（仅含需要用户处理 + 确认页）。
   * hasConflicts/hasPathIssues/hasSecrets 基于**裁剪后的计划**（Dry Run 产物 ∩ 用户本次选择）：
   * 计数在流程中不会因「用户已解决某项」而重算——所以导航必须只前进（见 nextFlowPhase），
   * 而不是靠"当前阶段 != X"判定（那会让已完成阶段被重新命中、跳回上一步）。
   * 整体加密容器（containerEncrypted && !archiveUnlocked）恒先插入 decrypt-archive：
   * 不解锁不得分析/继续导入。解密密码只在解锁时输入一次（导出时容器密码与
   * 内部 secrets.enc 密码同源），不再有独立的 decrypt 阶段。
   */
  const flowInputs: ImportFlowInputs = {
    containerEncrypted, archiveUnlocked, hasConflicts, hasPathIssues, hasSecrets,
  }

  /** 从某阶段完成后进入的下一个阶段：只前进（from 不在列表时取第一项） */
  const nextPhase = (from: FlowPhase): FlowPhase => nextImportPhase(flowInputs, from)

  /* ---------- 动作 ---------- */

  /** 选择并上传 ZIP → wizard.selectZip（analyzing → compatibility）。
   * 换选不变式：每次选择都以最新文件为准（applyPickedFile 替换旧选择）；
   * pickGeneration 守卫作废取消后在途的旧请求。
   * 整体加密容器（upload.containerType === 'encrypted'）：不能直接按 ZIP 分析，
   * 先进入「解锁加密备份」（decrypt-archive）阶段，解锁成功后再走 selectZip。 */
  const onPickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    const generation = pickGeneration.current
    const next = applyPickedFile(fileSelectModel(imp.selectedFileName, uploading), file)
    // 换文件：清空上一份备份的仅内存解密状态（密码/凭据覆盖清单/容器解锁）
    runStore.patch({
      import: {
        uploading: next.busy,
        error: null,
        selectedFileName: next.selectedName,
        decryptPassword: '',
        decryptRefs: [],
        archiveUnlocked: false,
        containerEncrypted: false,
      },
    })
    try {
      const uploaded: UploadResponse = await api.upload(file)
      if (generation !== pickGeneration.current) return // 用户已取消本次选择
      if (uploaded.containerType === 'encrypted') {
        // 加密容器：告知向导（含容器路径，syncWizard 不会把 zipPath 覆盖回 null）
        // + 进入解锁阶段；analysis 留待解锁后
        wizard.setArchiveEncrypted(true, uploaded.zipPath)
        runStore.patch({
          import: {
            containerEncrypted: true,
            archiveUnlocked: false,
            zipPath: uploaded.zipPath,
            phase: 'decrypt-archive',
          },
        })
        runStore.syncWizard()
        return
      }
      const analysis = await wizard.selectZip(uploaded.zipPath)
      void analysis
      if (generation !== pickGeneration.current) return
      runStore.syncWizard()
    } catch (err) {
      if (generation !== pickGeneration.current) return
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    } finally {
      if (generation === pickGeneration.current) {
        runStore.patch({ import: { uploading: false } })
      }
    }
  }

  /** 取消当前选择：回 idle 并清空 input value（同一文件可再次选择触发 onChange）。 */
  const cancelPick = (): void => {
    pickGeneration.current += 1
    const idle = cancelSelection(fileSelectModel(imp.selectedFileName, uploading))
    runStore.patch({ import: { selectedFileName: idle.selectedName, uploading: idle.busy, error: null } })
    if (fileInput.current !== null) fileInput.current.value = ''
  }

  /**
   * 一键导入（产物库「备份文件 → 导入」）：消费 runStore.library.pendingZip，
   * 跳过上传直接对宿主 exports 目录的 zipPath 分析（analyze 零写入）。
   * 一次性瞬态：消费后立即清空，刷新/重挂载不会重放；与 onPickFile 共用
   * pickGeneration 竞态守卫（用户取消选择后晚到的分析结果丢弃）。
   *
   * issue #55：宿主侧路径**没有上传那一步的形态探测**，所以「整包加密」的备份此前直接被
   * 当 ZIP 分析 → 用户看到「不是合法的 ZIP 文件（缺少中央目录结束记录）」。现在快照面板
   * 把列表接口的 containerType 带进来，这里与 onPickFile 的加密分支**逐字同源**：
   * 先进入解密阶段（decrypt-archive），解锁成功后再走同一个 selectZip。
   */
  useEffect(() => {
    const req = runStore.getSnapshot().library.pendingZip
    if (req === null) return
    runStore.patch({ library: { pendingZip: null } })
    // **先完整重置向导**：此前这里只清了 encrypt/decrypt 那几个字段，
    // 于是上一次导入的 step / analysis / plan / result / progress 全部残留 ——
    // 从「上次已执行到某一步」的状态进来时，向导仍停在那一步，
    // **加密备份的密码输入框根本不出现**（真机反馈）。
    // resetWizard 是既有的完整重置（回到 preview + 清 run/plan/result/…），这里复用它，
    // 不再维护第二份"部分重置"清单（那种清单必然漏字段）。
    pickGeneration.current += 1
    const generation = pickGeneration.current
    wizard.reset()
    runStore.patch({
      import: {
        phase: 'preview',
        uploading: true,
        running: false,
        progress: null,
        runId: null,
        error: null,
        selectedFileName: req.name,
        conflictCollector: null,
        conflictStrategy: 'merge',
        conflictResolutions: {},
        pathMappings: [],
        importSelection: null,
        sessionFormatDisposition: DEFAULT_SESSION_FORMAT_DISPOSITION,
        secretInputs: {},
        // 换文件：清空上一份备份的仅内存解密状态（与 onPickFile 一致）
        decryptPassword: '',
        decryptRefs: [],
        archiveUnlocked: false,
        containerEncrypted: false,
        skipRequested: false,
      },
    })
    const encrypted = req.containerType === 'encrypted'
    /** 解密阶段：告知向导（容器路径不会被 syncWizard 覆盖回 null）+ 让流程停在解锁页 */
    const enterDecryptStage = (): void => {
      wizard.setArchiveEncrypted(true, req.zipPath)
      runStore.patch({
        import: { containerEncrypted: true, archiveUnlocked: false, zipPath: req.zipPath, phase: 'decrypt-archive' },
      })
      runStore.syncWizard()
      runStore.patch({ import: { uploading: false } })
    }
    if (encrypted) {
      enterDecryptStage()
      return
    }
    wizard.selectZip(req.zipPath)
      .then(() => {
        if (generation !== pickGeneration.current) return
        runStore.syncWizard()
      })
      .catch((err) => {
        if (generation !== pickGeneration.current) return
        // 旧宿主（列表接口不回 containerType）或别处直传宿主路径：宿主 /analyze 的
        // 容器闸门会回 code=encrypted-container —— 据此进入解锁阶段，而不是把
        // 「这是加密备份，需先解锁」当成未知故障弹红条（issue #55 的降级路径）。
        if (err instanceof ConfigManagerApiError && err.code === ENCRYPTED_CONTAINER_CODE) {
          enterDecryptStage()
          return
        }
        runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
        runStore.syncWizard()
      })
      .finally(() => {
        if (generation === pickGeneration.current) {
          runStore.patch({ import: { uploading: false } })
        }
      })
  }, [api])

  /** Phase 7 迁移前咨询：预览步对当前 ZIP 生成咨询报告（只读，零写入）。
   *  zipPath 变化 / 进入 preview 步时重新获取。失败**不再静默**（审计 P9-7）：
   *  「宿主不支持」= 404，仍按 info 横幅说明；其它失败写 import.error 走 ErrorBanner，
   *  用户看到的是「咨询失败」而不是「没有结论」。咨询本身是建议性的，不阻断导入。 */
  useEffect(() => {
    if (step !== 'preview' || imp.zipPath === null) return
    let cancelled = false
    setConsultLoading(true)
    api.consult({ type: 'export-zip', id: imp.zipPath })
      .then((report) => { if (!cancelled) setConsultReport(report) })
      .catch((err: unknown) => {
        if (cancelled) return
        setConsultReport(null)
        const message = consultFailureError(err)
        if (message !== null) {
          runStore.patch({ import: { error: message } })
          runStore.syncWizard()
        }
      })
      .finally(() => { if (!cancelled) setConsultLoading(false) })
    return () => { cancelled = true }
  }, [step, imp.zipPath, api])

  /** 换了一份备份（或重新开始）→ 回到「迁移前咨询」这一页，而不是直接落到内容选择 */
  useEffect(() => {
    setPreviewStage((current) => importPreviewStageAfter('new-zip', current))
  }, [imp.zipPath])

  /**
   * Compatibility → Preview（Dry Run 计划）。
   *
   * T1：`abort` 处置下宿主会以 409 + code=sessionFormatUnsupported 拒绝 —— 那不是「出错」，
   * 而是**必须由用户决策**的流程状态，因此转成阻断态（渲染三选一 + 指引），不弹错误横幅。
   * 用户改选 skip/guide 后再点同一按钮重试即可。
   */
  const goPreview = async (): Promise<void> => {
    runStore.patch({ import: { error: null } })
    try {
      const plan = await wizard.confirmCompatibility()
      setSessionFormatBlocked(false)
      // skip 处置：这些会话单元**默认不勾选**（复用既有的 Selection/includeItems 机制，
      // 不新增第二套服务端过滤）。只在用户还没为这份备份做过选择时施加初值 ——
      // 用户一旦自己勾过（importSelection 已绑定同一 zipPath），界面就是权威。
      if (sessionFormatDisposition === 'skip' && imp.zipPath !== null) {
        const units = sessionFormatSkipUnits(sessionFormatFacts, 'skip')
        const current = imp.importSelection
        const fresh = current === null || current.zipPath !== imp.zipPath
        if (fresh && units.length > 0) {
          const base = defaultSelectionFromPlan(plan)
          runStore.patch({
            import: {
              importSelection: { zipPath: imp.zipPath, selection: { sections: base.sections, excluded: [...units] } },
            },
          })
        }
      }
      runStore.syncWizard()
    } catch (err) {
      if (err instanceof ConfigManagerApiError && err.code === 'sessionFormatUnsupported') {
        setSessionFormatBlocked(true)
        runStore.patch({ import: { error: null } })
        runStore.syncWizard()
        return
      }
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    }
  }

  /** 进入 conflicts 阶段（先创建 collector） */
  const enterConflicts = (): void => {
    // Phase 2：基于**裁剪后**的计划 —— 用户没勾的项不该把他拖进冲突解决
    const plan = selectedPlan
    if (plan !== null && imp.conflictCollector === null) {
      runStore.patch({ import: { conflictCollector: new ConflictCollector(plan) } })
    }
    setPhase('conflicts')
  }

  /** Conflicts 完成：写入决策 → 下一阶段（决策同时持久化，切 tab/刷新可恢复） */
  const finishConflicts = (): void => {
    if (imp.conflictCollector !== null) {
      const resolutions = imp.conflictCollector.toResolutions()
      wizard.setResolutions(resolutions)
      runStore.patch({ import: { conflictResolutions: resolutions } })
    }
    setPhase(nextPhase('conflicts'))
  }

  /** Path Mapping 完成：写入映射 → 下一阶段 */
  const finishPathMapping = (): void => {
    wizard.setPathMappings(pathMappings)
    setPhase(nextPhase('path-mapping'))
  }

  /** Secrets 完成：写入补录值（仅内存）→ Confirm */
  const finishSecrets = (): void => {
    wizard.setSecretInputs(secretInputs)
    setPhase('confirm')
  }

  /** 解锁整体加密备份容器（只读，零写入）：解密 → 明文 ZIP → selectZip 继续分析。
   * 导出时容器密码与备份内 secrets.enc 密码同源（同一 password 派生两层加密）：
   * 解锁请求在 Host 端顺带解出内部凭据覆盖清单（refs）一并返回，此密码直接作为
   * 解密密码交给向导——整个导入只输入这一次密码，没有第二个密码校验页面。 */
  const onUnlockArchive = async (): Promise<void> => {
    if (imp.zipPath === null) return
    // 竞态守卫：解锁/继续分析期间用户可能点「重新选择」（resetWizard 递增 pickGeneration），
    // 此时丢弃在途结果，防止晚到的 selectZip 把已重置的向导推进到 compatibility。
    const generation = pickGeneration.current
    const encryptedPath = imp.zipPath
    setUnlocking(true)
    setArchiveUnlockError(null)
    try {
      const outcome = await unlockArchiveThenAnalyze({
        unlock: () => wizard.unlockArchive(encryptedPath, archivePassword),
        commitUnlocked: (refs) => {
          // 容器密码即内部凭据解密密码：交给向导（execute 时解密 secrets.enc 用）
          wizard.setDecryptPassword(archivePassword)
          // refs 为解锁时顺带解出的凭据覆盖清单（非值）：secrets 阶段据此剔除已恢复项
          runStore.patch({
            import: {
              archiveUnlocked: true,
              decryptPassword: archivePassword,
              decryptRefs: [...refs],
            },
          })
          runStore.syncWizard()
        },
        analyze: () => wizard.selectZip(encryptedPath),
        rollbackUnlocked: () => {
          // 两份状态必须同时回到「未解锁」：wizard 内部标志决定后续请求的真实行为，
          // store 决定界面判定；只回滚一边 = 两边继续互相矛盾（审计 P9-8）。
          wizard.setDecryptPassword('')
          wizard.setArchiveEncrypted(true, encryptedPath)
          runStore.patch({
            import: {
              archiveUnlocked: false,
              decryptPassword: '',
              decryptRefs: [],
              phase: 'decrypt-archive',
            },
          })
          runStore.syncWizard()
        },
        cancelled: () => generation !== pickGeneration.current,
      })
      if (outcome.status === 'cancelled') return
      if (outcome.status === 'failed') {
        setArchiveUnlockError(outcome.message)
        runStore.patch({ import: { error: outcome.message } })
        runStore.syncWizard()
        return
      }
      runStore.syncWizard()
      // 解锁后 phase 不再停留在 decrypt-archive，否则 preview 页会被解锁页劫持。
      // 用最新 store 快照计算下一阶段：decrypt-archive 已解锁（archiveUnlocked=true）
      // 不再适用，nextFlowPhase 取第一项——conflicts、path-mapping、secrets 或 confirm。
      runStore.patch({ import: { phase: 'preview' } })
    } finally {
      setUnlocking(false)
    }
  }

  /** Confirm 执行：confirm=true（安全阀）+ 用户回滚策略 */
  const execute = async (opts?: { retry?: boolean }): Promise<void> => {
    runStore.patch({ import: { error: null, running: true, skipRequested: false } })
    // m3：请求进行期间经 /runs 发现 runId 并轮询 /progress（500ms）显示真实进度
    runStore.watchRunning('import', 500)
    try {
      // 重试 = 只重跑「失败 + 用户跳过」的子集（结果页「重试」按钮）
      const promise = opts?.retry === true
        ? wizard.executeRetry({ rollbackOnError })
        : wizard.execute({
            confirm: true,
            rollbackOnError,
            // Phase 2：Dry Run 与真实执行用**同一套**裁剪逻辑（唯一定义处 = ui/selection-model）
            planFilter: (plan) => {
              const sel = effectiveImportSelection(plan, imp.zipPath, imp.importSelection)
              return sel === null ? plan : buildSelectedPlan(plan, sel)
            },
          })
      // execute() 已同步置 step='importing'：立即镜像，保证执行期间刷新时持久化的是 importing
      runStore.syncWizard()
      const result = await promise
      // 响应含 runId（/progress 查询与刷新恢复用）；控制器类型不含，运行时对象有
      const runId = (result as { runId?: unknown }).runId
      runStore.patch({ import: { runId: typeof runId === 'string' ? runId : null, skipRequested: false } })
      runStore.syncWizard()
    } catch (err) {
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
    } finally {
      runStore.stopRunWatch('import')
      runStore.patch({ import: { running: false } })
    }
  }

  /**
   * 跳过当前正在安装的插件（导入中）：通知宿主 abort 当前项子进程 →
   * kill + 清理半装状态 → 该项标记 user-skipped → 导入继续其余项。
   */
  const skipCurrent = async (): Promise<void> => {
    const runId = imp.runId
    if (runId === null || imp.skipRequested) return
    runStore.patch({ import: { skipRequested: true } })
    try {
      await api.skipExecute(runId)
    } catch {
      // 跳过请求失败（run 已结束等）：复位标记，下次轮询由 UI 状态自然处理
      runStore.patch({ import: { skipRequested: false } })
    }
  }

  /** 重置向导（重新导入） */
  const resetWizard = (): void => {
    pickGeneration.current += 1
    wizard.reset()
    runStore.syncWizard()
    runStore.patch({
      import: {
        phase: 'preview',
        uploading: false,
        running: false,
        progress: null,
        error: null,
        runId: null,
        selectedFileName: null,
        conflictCollector: null,
        conflictStrategy: 'merge',
        conflictResolutions: {},
        pathMappings: [],
        importSelection: null,
        // 重置向导 = 回到最安全的缺省（中止），不沿用上一份备份的处置选择
        sessionFormatDisposition: DEFAULT_SESSION_FORMAT_DISPOSITION,
        secretInputs: {},
        decryptPassword: '',
        decryptRefs: [],
        containerEncrypted: false,
        archiveUnlocked: false,
        skipRequested: false,
      },
    })
    setSessionFormatBlocked(false)
  }

  return {
    state,
    imp,
    wizard,
    step,
    phase,
    progress,
    error,
    uploading,
    running,
    rollbackOnError,
    conflictCollector,
    pathMappings,
    secretInputs,
    decryptRefs,
    isEncrypted,
    effectiveSelection,
    selectedPlan,
    selectionNodes,
    selectionValue,
    excludedCount,
    nothingSelected,
    applyImportSelection,
    containerEncrypted,
    archiveUnlocked,
    fileInput,
    pickGeneration,
    setPhase,
    nextPhase,
    onPickFile,
    cancelPick,
    goPreview,
    enterConflicts,
    finishConflicts,
    finishPathMapping,
    finishSecrets,
    onUnlockArchive,
    execute,
    skipCurrent,
    resetWizard,
    unlocking,
    setUnlocking,
    archiveUnlockError,
    setArchiveUnlockError,
    archivePassword,
    setArchivePassword,
    consultReport,
    setConsultReport,
    consultLoading,
    setConsultLoading,
    previewStage,
    setPreviewStage,
    /** T1：会话格式处置（当前值 / setter / 事实 / 阻断态） */
    sessionFormatDisposition,
    setSessionFormatDisposition,
    sessionFormatFacts,
    sessionFormatBlocked,
    hasConflicts,
    hasPathIssues,
    hasSecrets,
    /** 路径映射阶段的数据源 = 与本次选择相关的路径问题（见上方 applicableIssues 的推导） */
    applicableIssues,
  }
}
