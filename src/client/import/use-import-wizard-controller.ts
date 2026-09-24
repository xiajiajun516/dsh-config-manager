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
import { importFlowFlags, importPreviewStageAfter, nextImportPhase, type ImportFlowInputs } from '../../ui/import-wizard.ts'
import type { ConsultReport } from '../../core/migration-consult.ts'
import type { ConfigManagerApi, UploadResponse } from '../api.ts'
import type { TranslateNS } from '../client-types.ts'
import { runStore } from '../run-store.ts'
import {
  buildSelectedPlan, effectiveImportPlan, effectiveImportSelection, excludedPlanItems,
  sectionsFromPlan, selectionHasItems, type Selection,
} from '../../ui/selection-model.ts'
import { applyPickedFile, cancelSelection, fileSelectModel } from './import-file-select.ts'

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

  const setPhase = (next: FlowPhase): void => {
    runStore.patch({ import: { phase: next } })
  }

  /* ---------- 阶段判定（纯逻辑在 src/ui/import-wizard.ts，node 可测） ---------- */

  // 加密备份：解密已覆盖的凭据（decryptRefs）不需用户补录，仅剩余项进入 secrets 阶段
  const { hasConflicts, hasPathIssues, hasSecrets } = importFlowFlags({
    plan: imp.plan, analysis: imp.analysis, decryptRefs,
  })

  /**
   * 适用阶段的有序列表（仅含需要用户处理 + 确认页）。
   * hasConflicts/hasPathIssues/hasSecrets 基于原始 analysis/plan（Dry Run 产物），
   * 在流程中不会因已解决而重算——所以导航必须只前进（见 nextFlowPhase），
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
   * 一键导入（快照面板「备份文件 → 导入」）：消费 runStore.snapshots.importBackup，
   * 跳过上传直接对宿主 exports 目录的 zipPath 执行 selectZip（analyze 零写入）。
   * 一次性瞬态：消费后立即清空，刷新/重挂载不会重放；与 onPickFile 共用
   * pickGeneration 竞态守卫（用户取消选择后晚到的分析结果丢弃）。
   */
  useEffect(() => {
    const req = runStore.getSnapshot().snapshots.importBackup
    if (req === null) return
    runStore.patch({ snapshots: { importBackup: null } })
    const generation = pickGeneration.current
    runStore.patch({
      import: {
        selectedFileName: req.name,
        uploading: true,
        error: null,
        // 换文件：清空上一份备份的仅内存解密状态（与 onPickFile 一致）
        decryptPassword: '',
        decryptRefs: [],
        archiveUnlocked: false,
        containerEncrypted: false,
      },
    })
    wizard.selectZip(req.zipPath)
      .then(() => {
        if (generation !== pickGeneration.current) return
        runStore.syncWizard()
      })
      .catch((err) => {
        if (generation !== pickGeneration.current) return
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
   *  zipPath 变化 / 进入 preview 步时重新获取；失败静默（咨询是建议性，不阻断导入）。 */
  useEffect(() => {
    if (step !== 'preview' || imp.zipPath === null) return
    let cancelled = false
    setConsultLoading(true)
    api.consult({ type: 'export-zip', id: imp.zipPath })
      .then((report) => { if (!cancelled) setConsultReport(report) })
      .catch(() => { if (!cancelled) setConsultReport(null) })
      .finally(() => { if (!cancelled) setConsultLoading(false) })
    return () => { cancelled = true }
  }, [step, imp.zipPath, api])

  /** 换了一份备份（或重新开始）→ 回到「迁移前咨询」这一页，而不是直接落到内容选择 */
  useEffect(() => {
    setPreviewStage((current) => importPreviewStageAfter('new-zip', current))
  }, [imp.zipPath])

  /** Compatibility → Preview */
  const goPreview = async (): Promise<void> => {
    runStore.patch({ import: { error: null } })
    try {
      await wizard.confirmCompatibility()
      runStore.syncWizard()
    } catch (err) {
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
    setUnlocking(true)
    setArchiveUnlockError(null)
    try {
      const { refs } = await wizard.unlockArchive(imp.zipPath, archivePassword)
      if (generation !== pickGeneration.current) return
      // 容器密码即内部凭据解密密码：交给向导（execute 时解密 secrets.enc 用）
      wizard.setDecryptPassword(archivePassword)
      // refs 为解锁时顺带解出的凭据覆盖清单（非值）：secrets 阶段据此剔除已恢复项
      runStore.patch({
        import: {
          archiveUnlocked: true,
          decryptPassword: archivePassword,
          decryptRefs: refs,
        },
      })
      runStore.syncWizard()
      // 解锁成功：继续「选 ZIP → 分析 → 兼容性」流程（selectZip 内部步进到 compatibility）
      const analysis = await wizard.selectZip(imp.zipPath!)
      void analysis
      if (generation !== pickGeneration.current) return
      runStore.syncWizard()
      // 解锁后 phase 不再停留在 decrypt-archive，否则 preview 页会被解锁页劫持。
      // 用最新 store 快照计算下一阶段：decrypt-archive 已解锁（archiveUnlocked=true）
      // 不再适用，nextFlowPhase 取第一项——conflicts、path-mapping、secrets 或 confirm。
      runStore.patch({ import: { phase: 'preview' } })
    } catch (err) {
      if (generation !== pickGeneration.current) return
      setArchiveUnlockError(err instanceof Error ? err.message : String(err))
      runStore.patch({ import: { error: err instanceof Error ? err.message : String(err) } })
      runStore.syncWizard()
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
        secretInputs: {},
        decryptPassword: '',
        decryptRefs: [],
        containerEncrypted: false,
        archiveUnlocked: false,
        skipRequested: false,
      },
    })
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
    hasConflicts,
    hasPathIssues,
    hasSecrets,
  }
}
